import { createStep } from '@mastra/core/workflows';
import { sendPushBirdNotification } from '../../../utils/pushbird';
import { bookingResultSchema, finalResultSchema } from '../schemas';

export const notifyBooking = createStep({
    id: 'notify-booking',
    description: 'Sends a PushBird push notification with the result of the automatic booking.',
    inputSchema: bookingResultSchema,
    outputSchema: finalResultSchema,
    execute: async ({ inputData }) => {
        if (inputData.booking === 'skipped') return { ...inputData, bookingNotified: false };

        const when = [inputData.appointmentDate, inputData.appointmentTime].filter(Boolean).join(', ');
        const notification =
            inputData.booking === 'booked'
                ? {
                      title: 'Cita SAT agendada',
                      subtitle: when,
                      message: `Se agendó "${inputData.service}" en ${inputData.module}. Revisa tu correo para el acuse de la cita.`,
                  }
                : {
                      title: 'No se pudo agendar la cita SAT',
                      subtitle: when || inputData.module,
                      // The capture path is for the logs, not for a phone screen.
                      message: `${(inputData.bookingError ?? 'Error desconocido').replace(/\s*\(capture: .*\)$/, '')}. La ventana del navegador sigue abierta por si puedes terminarla a mano.`,
                  };

        // The booking result is already decided; a failed push must not turn
        // a booked appointment into a failed run.
        const bookingNotified = await sendPushBirdNotification({ ...notification, interruptionLevel: 'time-sensitive' })
            .then(() => true)
            .catch(() => false);

        return { ...inputData, bookingNotified };
    },
});
