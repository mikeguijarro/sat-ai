import type { Locator, Page } from 'playwright';

// Accents and case are ignored when matching dropdown labels, so
// "Correccion o cambio de nombre" finds "Corrección o cambio de nombre".
export const normalize = (text: string) =>
    text
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

// The site covers the page with a full-screen spinner while it loads the
// dropdown data; the lists are empty until it goes away.
export async function waitForSpinner(page: Page) {
    await page.waitForTimeout(400);
    await page.waitForFunction(() => document.querySelectorAll('.spinnercontainer').length === 0, undefined, {
        timeout: 30_000,
    });
}

// Closes a notice dialog if one shows up within `timeout` and returns its
// text, or null when nothing appeared.
export async function dismissDialog(page: Page, timeout: number): Promise<string | null> {
    const dialog = page.locator('mat-dialog-container');
    const shown = await dialog
        .waitFor({ timeout })
        .then(() => true)
        .catch(() => false);
    if (!shown) return null;

    const text = (await dialog.locator('mat-dialog-content').innerText()).trim();
    await dialog.getByRole('button').first().click();
    await dialog.waitFor({ state: 'hidden' });
    return text;
}

// Angular Material selects are not native <select>s: clicking one opens a
// floating panel of <mat-option>s attached to the page body.
export async function chooseOption(page: Page, select: Locator, label: string) {
    await select.and(page.locator('[aria-disabled="false"]')).waitFor({ timeout: 30_000 });
    await select.click();

    const options = page.locator('.cdk-overlay-container mat-option');
    await options.first().waitFor();
    const texts = (await options.allInnerTexts()).map(text => text.trim());
    const wanted = normalize(label);
    let index = texts.findIndex(text => normalize(text) === wanted);
    if (index === -1) index = texts.findIndex(text => normalize(text).includes(wanted));
    if (index === -1) {
        await page.keyboard.press('Escape');
        throw new Error(`Option "${label}" not found. Available options: ${texts.join(' | ')}`);
    }

    await options.nth(index).click();
    await options.first().waitFor({ state: 'hidden' });
    return texts[index];
}
