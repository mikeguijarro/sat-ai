import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';

export const CORE_URL = process.env.CORE_URL ?? 'https://citas.sat.gob.mx/datosPersonales';

export const randomBetween = (min: number, max: number) => Math.round(min + Math.random() * (max - min));

// A Playwright page can't be serialized into step output, so the live
// browser is parked here keyed by workflow runId and later steps pick it
// back up. It only survives within this process — not across a restart.
type SatSession = { browser: Browser; page: Page };
const sessions = new Map<string, SatSession>();

export function openSatSession(runId: string, session: SatSession): void {
    sessions.set(runId, session);
}

export function getSatSession(runId: string): SatSession {
    const session = sessions.get(runId);
    if (!session) throw new Error(`No open SAT browser session for run ${runId}`);
    return session;
}

export async function closeSatSession(runId: string): Promise<void> {
    const session = sessions.get(runId);
    sessions.delete(runId);
    await session?.browser.close();
}

// Local debugging only: keep a full-page screenshot and the page HTML so a
// run can be inspected after the browser is gone — on every failure, and at
// each stage of a booking. Both show RFC/CURP/email in plain view — the
// folder is gitignored and nothing is written in production.
const CAPTURE_DIR = join(process.cwd(), 'debug-captures');
const capturesEnabled = process.env.NODE_ENV !== 'production';

export async function capturePage(runId: string, label: string): Promise<string | null> {
    const session = sessions.get(runId);
    if (!capturesEnabled || !session) return null;

    try {
        await mkdir(CAPTURE_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const base = join(CAPTURE_DIR, `${stamp}_${label}`);
        await session.page.screenshot({ path: `${base}.png`, fullPage: true });
        await writeFile(`${base}.html`, await session.page.content());
        return base;
    } catch {
        // Never let a failed capture hide the real error.
        return null;
    }
}

// Shared failure path for every step: capture, close the browser, rethrow
// with the capture location appended so it shows up in the run's error.
export async function failStep(runId: string, stepId: string, error: unknown): Promise<never> {
    const capture = await capturePage(runId, stepId);
    await closeSatSession(runId);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(capture ? `${message}\nCapture saved: ${capture}.png / .html` : message, { cause: error });
}
