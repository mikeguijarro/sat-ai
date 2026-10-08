import { createStep } from '@mastra/core/workflows';
import { chromium, type Locator, type Page } from 'playwright';
import { captchaVisibleSchema, availabilityCheckInputSchema } from '../schemas';
import { CORE_URL, failStep, openSatSession, randomBetween } from '../session';

// Typed key by key (not fill/paste): the confirm-email field blocks paste
// and Angular only validates on real input events.
async function typeInto(page: Page, formControlName: string, value: string) {
    const input = page.locator(`jhi-contribuyentes-inscritos input[formcontrolname="${formControlName}"]`);
    await input.click();
    await input.pressSequentially(value, { delay: randomBetween(40, 90) });
    await page.waitForTimeout(randomBetween(300, 800));
}

const PAGE_LOAD_ATTEMPTS = 3;
const PAGE_LOAD_TIMEOUT_MS = 30_000;

// The site normally boots in about 2 seconds, but now and then the page
// stalls on its loading spinner because one of its scripts never arrives, or
// the navigation itself times out. A fresh load fixes it, so retry before
// giving up on the whole run.
async function openStartPage(page: Page, ready: Locator) {
    for (let attempt = 1; ; attempt++) {
        try {
            await page.goto(CORE_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT_MS });
            await ready.waitFor({ timeout: PAGE_LOAD_TIMEOUT_MS });
            return;
        } catch (error) {
            if (attempt === PAGE_LOAD_ATTEMPTS) throw error;
            await page.waitForTimeout(randomBetween(3000, 8000));
        }
    }
}

export const fillForm = createStep({
    id: 'fill-form',
    description: 'Opens the SAT citas form and types RFC, CURP and email until the CAPTCHA is shown.',
    inputSchema: availabilityCheckInputSchema,
    outputSchema: captchaVisibleSchema,
    execute: async ({ inputData, runId }) => {
        const { rfc, curp, email } = inputData;

        const browser = await chromium.launch({ headless: false });
        const page = await browser.newPage();
        openSatSession(runId, { browser, page });

        try {
            const panel = page.locator('mat-expansion-panel-header', { hasText: 'Contribuyente que cuente con RFC' });
            await openStartPage(page, panel);

            // The panel starts collapsed on a fresh visit.
            if ((await panel.getAttribute('aria-expanded')) !== 'true') await panel.click();

            // Wait on the input, not the <form>: the form only holds floated
            // children, so it has zero height and never counts as visible.
            const form = page.locator('jhi-contribuyentes-inscritos form');
            await form.locator('input[formcontrolname="rfc"]').waitFor();

            await typeInto(page, 'rfc', rfc);

            // CURP is optional and only rendered once the RFC is valid.
            if (curp) {
                await form.locator('input[formcontrolname="curp"]').waitFor({ timeout: 5_000 });
                await typeInto(page, 'curp', curp);
            }

            await typeInto(page, 'correo', email);
            await typeInto(page, 'correoconfirmacion', email);

            // Leaving the confirm field with two matching emails opens a
            // one-time "Atención" notice ("Favor de revisar que el correo
            // ingresado sea válido…"). It's informational, but its backdrop
            // blocks every later click, so trigger it now and close it.
            await form.locator('input[formcontrolname="correoconfirmacion"]').blur();
            const notice = page.locator('mat-dialog-container');
            const noticeShown = await notice
                .waitFor({ timeout: 5_000 })
                .then(() => true)
                .catch(() => false);
            if (noticeShown) {
                await notice.getByRole('button', { name: 'Cerrar' }).click();
                await notice.waitFor({ state: 'hidden' });
            }

            // Terms checkbox appears once the fields validate. The real
            // input is a visually hidden 1px element and pointer clicks on
            // the Material wrapper don't toggle it, so click it directly.
            const terms = form.locator('mat-checkbox input[type="checkbox"]');
            await terms.waitFor({ state: 'attached' });
            if (!(await terms.isChecked())) await terms.dispatchEvent('click');
            if (!(await terms.isChecked())) throw new Error('Could not accept the terms and conditions checkbox');

            await form.locator('input[formcontrolname="ConfirmarCaptcha"]').waitFor();

            return { captchaVisible: true };
        } catch (error) {
            return failStep(runId, 'fill-form', error);
        }
    },
});
