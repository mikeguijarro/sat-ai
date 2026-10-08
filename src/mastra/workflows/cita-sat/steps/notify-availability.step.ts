import { createStep } from '@mastra/core/workflows';
import { sendPushBirdNotification } from '../../../utils/pushbird';
import { availabilityCheckInputSchema, availabilitySchema, notificationResultSchema } from '../schemas';
import { CORE_URL } from '../session';

export const notifyAvailability = createStep({
    id: 'notify-availability',
    description: 'Sends a PushBird push notification when the selected service and module have availability.',
    inputSchema: availabilitySchema,
    outputSchema: notificationResultSchema,
    execute: async ({ inputData, getInitData }) => {
        // Only when the "no disponibilidad" aviso did not show.
        if (inputData.availability !== 'available') return { ...inputData, notified: false };

        // The browser is deliberately left open here even if the request
        // fails: the slot is on screen and the timer is running, so closing
        // it would throw away the one thing worth keeping.
        const { autoBook } = availabilityCheckInputSchema.parse(getInitData());

        await sendPushBirdNotification({
            title: 'Cita SAT disponible',
            subtitle: inputData.module,
            message: autoBook
                ? `Hay disponibilidad para "${inputData.service}". Intentando agendar automáticamente; te aviso con el resultado.`
                : `Hay disponibilidad para "${inputData.service}". La sesión está abierta en el calendario y expira en unos 5 minutos.`,
            openUrl: CORE_URL,
            interruptionLevel: 'time-sensitive',
        });

        return { ...inputData, notified: true };
    },
});
