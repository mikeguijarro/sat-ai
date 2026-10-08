import { createStep } from '@mastra/core/workflows';
import { availabilitySchema, availabilityCheckInputSchema, loginResultSchema } from '../schemas';
import { chooseOption, dismissDialog, waitForSpinner } from '../page';
import { closeSatSession, failStep, getSatSession } from '../session';

export const selectService = createStep({
    id: 'select-service',
    description: 'On the appointment page, picks the service, entidad federativa and módulo, and reports availability.',
    inputSchema: loginResultSchema,
    outputSchema: availabilitySchema,
    execute: async ({ inputData, runId, getInitData }) => {
        // solve-captcha already closed the browser when login failed.
        if (!inputData.loggedIn) return { loggedIn: false, availability: 'not-checked' as const };

        // Re-parse so the schema defaults apply even if the raw input omitted them.
        const { service, entity, module } = availabilityCheckInputSchema.parse(getInitData());
        const { page } = getSatSession(runId);

        try {
            await waitForSpinner(page);

            const selectedService = await chooseOption(page, page.locator('jhi-servicios mat-select'), service);
            // Some services pop an "Aviso importante" with alternatives
            // (e.g. "this can be done online"); keep its text for the caller.
            const notice = await dismissDialog(page, 2_000);
            await waitForSpinner(page);

            const localidades = page.locator('jhi-localidades mat-select');
            await chooseOption(page, localidades.nth(0), entity);
            const selectedModule = await chooseOption(page, localidades.nth(1), module);
            await waitForSpinner(page);

            // No slots → "Aviso Importante: No se cuenta con disponibilidad
            // para el servicio y módulo seleccionado." with an Aceptar button.
            const unavailable = await dismissDialog(page, 4_000);
            if (unavailable) {
                await closeSatSession(runId);
                return {
                    loggedIn: true,
                    availability: 'unavailable' as const,
                    service: selectedService,
                    module: selectedModule,
                    notice: unavailable,
                };
            }

            return {
                loggedIn: true,
                availability: 'available' as const,
                service: selectedService,
                module: selectedModule,
                notice: notice ?? undefined,
            };
        } catch (error) {
            return failStep(runId, 'select-service', error);
        }
    },
});
