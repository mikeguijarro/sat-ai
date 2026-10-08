import { createStep } from '@mastra/core/workflows';
import { captchaVisibleSchema, loginResultSchema } from '../schemas';
import { capturePage, closeSatSession, failStep, getSatSession, randomBetween } from '../session';

const CAPTCHA_LENGTH = 5;
// Each retry needs a fresh image, and the site sends you back to the start
// page on the 5th "Actualizar Captcha" click — 4 attempts means 3 refreshes.
const MAX_CAPTCHA_ATTEMPTS = 4;

const AGENT_TIMEOUT_MS = 30_000;

// The agent is told to reply with only the 5 characters, but models
// sometimes wrap the answer in prose ("...the answer is **3gors**"). Accept
// a bare answer, or one that is unambiguously marked; otherwise give up
// rather than guess a word out of a sentence.
function extractCaptcha(text: string): string | null {
    const bare = text.trim().replace(/^["'`*\s]+|["'`*.\s]+$/g, '');
    if (new RegExp(`^[a-z0-9]{${CAPTCHA_LENGTH}}$`, 'i').test(bare)) return bare.toLowerCase();

    const marked = [...text.matchAll(new RegExp(`(?:\\*\\*|["'\`])([a-z0-9]{${CAPTCHA_LENGTH}})(?:\\*\\*|["'\`])`, 'gi'))];
    return marked.length ? marked[marked.length - 1][1].toLowerCase() : null;
}

export const solveCaptcha = createStep({
    id: 'solve-captcha',
    description: 'Sends the CAPTCHA image to the captcha agent, types its answer and submits the form.',
    inputSchema: captchaVisibleSchema,
    outputSchema: loginResultSchema,
    execute: async ({ runId, mastra }) => {
        const { page } = getSatSession(runId);
        const agent = mastra.getAgent('captchaAgent');

        const form = page.locator('jhi-contribuyentes-inscritos form');
        const captchaImage = form.locator('img[src^="data:image"]');
        const captchaInput = form.locator('input[formcontrolname="ConfirmarCaptcha"]');
        const refreshCaptcha = form.locator('button[mattooltip="Actualizar Captcha"]');
        const next = form.getByRole('button', { name: 'Siguiente' });
        const captchaError = form.getByText('Captcha incorrecto');

        let lastError: unknown;

        try {
            for (let attempt = 1; attempt <= MAX_CAPTCHA_ATTEMPTS; attempt++) {
                // The image is an inline data URI, so read it straight from
                // the DOM instead of screenshotting the page.
                const src = (await captchaImage.getAttribute('src')) ?? '';
                const base64 = src.slice(src.indexOf(',') + 1).trim();

                // A slow or failed model call must not sink the run: the SAT
                // session only lasts ~5 minutes, so give the agent a short
                // deadline and treat a timeout or network error as a miss.
                let answer: string | null = null;
                try {
                    const response = await agent.generate(
                        [
                            {
                                role: 'user',
                                content: [
                                    { type: 'image', image: base64, mimeType: 'image/png' },
                                    { type: 'text', text: 'Transcribe the CAPTCHA.' },
                                ],
                            },
                        ],
                        {
                            // On timeout this resolves with empty text rather than throwing.
                            abortSignal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
                            modelSettings: { maxRetries: 0, maxOutputTokens: 50 },
                            // Without this the model "thinks" for 1,000+ tokens
                            // per image, answers in prose, and sometimes stalls
                            // until the HTTP body times out minutes later.
                            providerOptions: { deepseek: { thinking: { type: 'disabled' } } },
                        },
                    );
                    answer = extractCaptcha(response.text);
                    lastError = undefined;
                } catch (error) {
                    lastError = error;
                }

                // The site checks the answer in the browser as it is typed:
                // a wrong one shows "Captcha incorrecto, confirma de nuevo",
                // leaves "Siguiente" disabled and keeps the SAME image. So
                // nothing is submitted on a miss — just ask for a new image.
                let accepted = false;
                if (answer) {
                    await captchaInput.fill('');
                    await captchaInput.pressSequentially(answer, { delay: randomBetween(60, 120) });
                    await page.waitForTimeout(500);
                    accepted = (await next.isEnabled()) && !(await captchaError.isVisible());
                }

                if (!accepted) {
                    if (attempt === MAX_CAPTCHA_ATTEMPTS) break;
                    await page.waitForTimeout(randomBetween(2000, 5000));
                    // Only spend a refresh when the image itself was the
                    // problem; after a timeout or network error, retry the
                    // same image (the site resets on the 5th refresh).
                    if (answer) {
                        await refreshCaptcha.click();
                        // Wait for the new image so the next attempt doesn't
                        // re-read the one that was just rejected.
                        await page.waitForFunction(
                            previous => document.querySelector('jhi-contribuyentes-inscritos form img')?.getAttribute('src') !== previous,
                            src,
                        );
                    }
                    continue;
                }

                await next.click();

                // From here the captcha is settled; the site validates the
                // email and RFC server-side and then routes to /creaCita. A
                // failure now is about the data, so don't loop on it.
                try {
                    await page.waitForURL('**/creaCita', { timeout: 45_000 });
                } catch {
                    const message = await page
                        .locator('jhi-contribuyentes-inscritos mat-error, .toast-message, mat-dialog-container')
                        .allInnerTexts()
                        .then(texts => texts.map(text => text.trim()).filter(Boolean).join(' | '))
                        .catch(() => '');
                    throw new Error(`CAPTCHA was accepted but SAT did not continue to the appointment page. ${message}`.trim());
                }

                return { loggedIn: true, attempts: attempt };
            }

            // Every attempt died on the model call (network down, API outage):
            // that is a real failure, not a hard-to-read CAPTCHA.
            if (lastError) throw lastError;

            // Out of attempts: not an exception, but worth a look at the page.
            await capturePage(runId, 'solve-captcha_exhausted');
            await closeSatSession(runId);
            return { loggedIn: false, attempts: MAX_CAPTCHA_ATTEMPTS };
        } catch (error) {
            return failStep(runId, 'solve-captcha', error);
        }
    },
});
