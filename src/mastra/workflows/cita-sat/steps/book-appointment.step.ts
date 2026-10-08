import type { Mastra } from '@mastra/core/mastra';
import { createStep } from '@mastra/core/workflows';
import type { Page } from 'playwright';
import { fetchEmails } from '../../../utils/composio-gmail';
import { waitForSpinner } from '../page';
import { availabilityCheckInputSchema, bookingResultSchema, notificationResultSchema } from '../schemas';
import { capturePage, closeSatSession, getSatSession, randomBetween } from '../session';

// The token must arrive, be read and be confirmed inside what is left of
// the site's ~5 minute session.
const TOKEN_WAIT_MS = 150_000;
const TOKEN_POLL_MS = 5_000;
// The site allows 3 tries per token dialog before it closes it.
const MAX_TOKEN_TRIES = 3;
const MAX_MONTHS_AHEAD = 6;

// Days with slots are the calendar cells the site marks "special-date"
// (painted green). The calendar opens on the current month, so walk forward
// until one shows up, then take the first day that still has a time left.
async function pickEarliestSlot(page: Page): Promise<{ date: string; time: string }> {
    const calendar = page.locator('jhi-calendario mat-calendar');
    const horario = page.locator('jhi-calendario mat-select');
    const options = page.locator('.cdk-overlay-container mat-option');

    for (let month = 0; month < MAX_MONTHS_AHEAD; month++) {
        const days = calendar.locator('.mat-calendar-body-cell.special-date:not(.mat-calendar-body-disabled)');
        const count = await days.count();

        for (let index = 0; index < count; index++) {
            const day = days.nth(index);
            const date = (await day.getAttribute('aria-label')) ?? (await day.innerText()).trim();
            await day.click();
            await waitForSpinner(page);

            await horario.click();
            const hasTimes = await options
                .first()
                .waitFor({ timeout: 5_000 })
                .then(() => true)
                .catch(() => false);
            if (!hasTimes) {
                // Someone else took this day's last slot; try the next day.
                await page.keyboard.press('Escape');
                continue;
            }

            const time = (await options.first().innerText()).trim();
            await options.first().click();
            await options.first().waitFor({ state: 'hidden' });
            return { date, time };
        }

        const next = calendar.locator('.mat-calendar-next-button');
        if (await next.isDisabled()) break;
        await next.click();
        await page.waitForTimeout(500);
    }

    throw new Error('No selectable date with a free time was found on the calendar');
}

const snackBarText = (page: Page) =>
    page
        .locator('snack-bar-container, .mat-snack-bar-container')
        .allInnerTexts()
        .then(texts => texts.join(' ').replace(/\bcerrar\b/gi, '').trim())
        .catch(() => '');

// Looks in Gmail for the token email that arrived after `since` and returns
// a token not tried yet, or null if there is none so far.
async function findToken(mastra: Mastra, since: number, tried: Set<string>): Promise<string | null> {
    // Spam included on purpose: an automated government email can land there.
    const emails = await fetchEmails({ query: 'newer_than:1d', maxResults: 10, includeSpamTrash: true });
    const candidates = emails
        // 60s of slack for clock differences between this machine and Gmail.
        .filter(email => email.receivedAt >= since - 60_000)
        .filter(email => /sat\.gob\.mx/i.test(email.sender) || /token/i.test(`${email.subject} ${email.text}`))
        .sort((a, b) => b.receivedAt - a.receivedAt);

    const agent = mastra.getAgent('emailTokenAgent');
    for (const email of candidates) {
        const response = await agent.generate(`From: ${email.sender}\nSubject: ${email.subject}\n\n${email.text.slice(0, 4000)}`, {
            abortSignal: AbortSignal.timeout(30_000),
            modelSettings: { maxRetries: 1, maxOutputTokens: 20 },
            providerOptions: { deepseek: { thinking: { type: 'disabled' } } },
        });
        const token = response.text.trim();
        if (token === 'NONE') continue;
        // Only accept something that is token-shaped AND literally present
        // in the email, so a hallucinated value is never typed in.
        if (/^[A-Za-z0-9]{3,7}$/.test(token) && `${email.subject} ${email.text}`.includes(token) && !tried.has(token)) return token;
    }
    return null;
}

type Outcome = 'booked' | 'dialog-closed' | `snack:${string}`;

export const bookAppointment = createStep({
    id: 'book-appointment',
    description:
        'When there is availability and autoBook is on: picks the earliest date and time, clicks "Generar cita", reads the emailed token from Gmail and confirms the appointment.',
    inputSchema: notificationResultSchema,
    outputSchema: bookingResultSchema,
    execute: async ({ inputData, runId, mastra, getInitData }) => {
        const { autoBook } = availabilityCheckInputSchema.parse(getInitData());
        if (inputData.availability !== 'available' || !autoBook) return { ...inputData, booking: 'skipped' as const };

        const { page } = getSatSession(runId);
        let slot: { date: string; time: string } | undefined;

        // This step never throws: whatever happens, the next step must still
        // run to tell the person whether they have an appointment or not.
        try {
            // Prove Gmail is readable before anything is reserved: a bad
            // Composio key or a disconnected account must fail here, not
            // after "Generar cita" has started the token countdown.
            await fetchEmails({ query: 'newer_than:1d', maxResults: 1 }).catch(error => {
                throw new Error(`Gmail is not readable through Composio: ${error instanceof Error ? error.message : String(error)}`);
            });

            slot = await pickEarliestSlot(page);
            await capturePage(runId, 'book_1-slot-selected');

            // Clicking this reserves the slot and makes the site email a
            // security token; the appointment only exists once it is confirmed.
            const requestedAt = Date.now();
            await page.getByRole('button', { name: 'Generar cita' }).click();

            const tokenInput = page.locator('mat-dialog-container input[formcontrolname="token"]');
            const dialogShown = await tokenInput
                .waitFor({ timeout: 45_000 })
                .then(() => true)
                .catch(() => false);
            if (!dialogShown) throw new Error(`The token dialog did not open. ${await snackBarText(page)}`.trim());
            await capturePage(runId, 'book_2-token-dialog');

            const tried = new Set<string>();
            // A failed lookup is retried like an email that has not arrived
            // yet, but remembered so the final error says what really happened.
            let lookupError: string | undefined;
            while (Date.now() < requestedAt + TOKEN_WAIT_MS && tried.size < MAX_TOKEN_TRIES) {
                const token = await findToken(mastra, requestedAt, tried).then(
                    found => {
                        lookupError = undefined;
                        return found;
                    },
                    error => {
                        lookupError = error instanceof Error ? error.message.split('\n')[0] : String(error);
                        return null;
                    },
                );
                if (!token) {
                    await page.waitForTimeout(TOKEN_POLL_MS);
                    continue;
                }
                tried.add(token);

                await tokenInput.fill('');
                await tokenInput.pressSequentially(token, { delay: randomBetween(60, 120) });
                await page.locator('mat-dialog-container').getByRole('button', { name: 'Confirmar' }).click();

                // Success is the "Confirmación — Cita generada exitosamente"
                // dialog; every failure surfaces as a snack-bar message.
                const outcome = (await page
                    .waitForFunction(
                        () => {
                            if (document.querySelector('jhi-dialogo-confirmacion-cita')) return 'booked';
                            const snack = document.querySelector('snack-bar-container, .mat-snack-bar-container');
                            if (snack?.textContent?.trim()) return `snack:${snack.textContent.trim()}`;
                            return false;
                        },
                        undefined,
                        { timeout: 60_000 },
                    )
                    .then(handle => handle.jsonValue())
                    .catch(() => 'dialog-closed')) as Outcome;

                if (outcome === 'booked') {
                    // The site leaves this page 3 seconds later — capture first.
                    await capturePage(runId, 'book_3-confirmed');
                    await closeSatSession(runId);
                    return { ...inputData, booking: 'booked' as const, appointmentDate: slot.date, appointmentTime: slot.time };
                }

                // A wrong token keeps the dialog open for another try; any
                // other message (expired, slot taken, already have a cita…)
                // ends the attempt.
                if (outcome.startsWith('snack:') && /token inv[aá]lido/i.test(outcome)) {
                    await page.waitForTimeout(6_000);
                    continue;
                }
                throw new Error(
                    outcome.startsWith('snack:')
                        ? outcome.slice(6).replace(/\bcerrar\b/gi, '').trim()
                        : 'No confirmation appeared after the token was submitted',
                );
            }

            throw new Error(
                tried.size
                    ? `SAT rejected the token${tried.size > 1 ? 's' : ''} read from Gmail`
                    : lookupError
                      ? `The token could not be read from Gmail: ${lookupError}`
                      : 'The token email did not arrive in time',
            );
        } catch (error) {
            // Browser stays open: if the session is still alive the person
            // can finish by hand from where this stopped.
            const capture = await capturePage(runId, 'book_failed');
            const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
            return {
                ...inputData,
                booking: 'failed' as const,
                appointmentDate: slot?.date,
                appointmentTime: slot?.time,
                bookingError: capture ? `${message} (capture: ${capture})` : message,
            };
        }
    },
});
