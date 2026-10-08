import { createWorkflow } from '@mastra/core/workflows';
import { availabilityCheckInputSchema, finalResultSchema } from './cita-sat/schemas';
import { bookAppointment } from './cita-sat/steps/book-appointment.step';
import { fillForm } from './cita-sat/steps/fill-form.step';
import { notifyAvailability } from './cita-sat/steps/notify-availability.step';
import { notifyBooking } from './cita-sat/steps/notify-booking.step';
import { selectService } from './cita-sat/steps/select-service.step';
import { solveCaptcha } from './cita-sat/steps/solve-captcha.step';

// Hourly check around the clock (24 runs a day). The cron itself fires on
// the hour; the randomness comes from `maxDelayMinutes`, which makes
// each run wait a random 0-20 minutes first, so checks land anywhere in the
// first third of the hour and the gap between two checks varies from about
// 40 to 80 minutes instead of being exactly 60.
const SCHEDULE_CRON = '0 * * * *';
const SCHEDULE_TIMEZONE = 'America/Mexico_City';
const SCHEDULE_MAX_DELAY_MINUTES = 20;

// The schedule needs the profile data up front, so it only exists when .env
// has it — otherwise every hourly fire would just fail input validation.
const { RFC, CURP, EMAIL, SERVICE_1, PREFERRED_MODULE } = process.env;
const schedule =
    RFC && EMAIL
        ? {
              cron: SCHEDULE_CRON,
              timezone: SCHEDULE_TIMEZONE,
              inputData: {
                  rfc: RFC,
                  curp: CURP || undefined,
                  email: EMAIL,
                  service: SERVICE_1 || 'Correccion o cambio de nombre',
                  entity: PREFERRED_MODULE || 'Oficina Virtual',
                  module: PREFERRED_MODULE || 'Oficina Virtual',
                  // Scheduled runs happen while nobody is watching, so they book.
                  autoBook: true,
                  maxDelayMinutes: SCHEDULE_MAX_DELAY_MINUTES,
              },
          }
        : undefined;

// When availability is 'available' the browser is left open on the calendar
// (the site's ~5 minute timer is already running) so a person — or a
// follow-up step via getSatSession(runId) — can finish the booking; whoever
// finishes the flow must closeSatSession.
export const checkAvailabilityWorkflow = createWorkflow({
    id: 'sat-check-availability-workflow',
    description:
        'Checks SAT citas appointment availability: logs in (form + CAPTCHA via the captcha agent), selects the service and module, notifies when there is availability and, with autoBook, books the earliest slot using the token SAT emails.',
    inputSchema: availabilityCheckInputSchema,
    outputSchema: finalResultSchema,
    schedule,
})
    // Real randomness from Node, not a fixed offset. Manual runs default to
    // maxDelayMinutes 0 and start right away.
    .sleep(async ({ inputData }) => Math.round(Math.random() * (inputData.maxDelayMinutes ?? 0) * 60_000))
    .then(fillForm)
    .then(solveCaptcha)
    .then(selectService)
    .then(notifyAvailability)
    .then(bookAppointment)
    .then(notifyBooking)
    .commit();
