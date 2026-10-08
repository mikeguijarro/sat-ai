import { z } from 'zod';

export const availabilityCheckInputSchema = z.object({
    rfc: z.string().min(12).max(13),
    curp: z.string().length(18).optional(),
    email: z.email(),
    service: z.string().describe('Label in the "Servicios" dropdown, e.g. "Corrección o cambio de nombre".'),
    entity: z.string().default('Oficina Virtual').describe('Label in the "Entidad Federativa" dropdown.'),
    module: z.string().default('Oficina Virtual').describe('Label in the "Módulo" dropdown.'),
    autoBook: z
        .boolean()
        .default(false)
        .describe('When there is availability, book the earliest date and time automatically (reads the SAT token from Gmail).'),
    maxDelayMinutes: z
        .number()
        .min(0)
        .max(55)
        .default(0)
        .describe('Wait a random time between 0 and this many minutes before starting. 0 starts immediately.'),
});

export const captchaVisibleSchema = z.object({
    captchaVisible: z.boolean(),
});

export const loginResultSchema = z.object({
    loggedIn: z.boolean(),
    attempts: z.number(),
});

export const availabilitySchema = z.object({
    loggedIn: z.boolean(),
    availability: z.enum(['available', 'unavailable', 'not-checked']),
    service: z.string().optional(),
    module: z.string().optional(),
    notice: z.string().optional(),
});

export const notificationResultSchema = availabilitySchema.extend({
    notified: z.boolean(),
});

export const bookingResultSchema = notificationResultSchema.extend({
    booking: z.enum(['booked', 'failed', 'skipped']),
    appointmentDate: z.string().optional(),
    appointmentTime: z.string().optional(),
    bookingError: z.string().optional(),
});

export const finalResultSchema = bookingResultSchema.extend({
    bookingNotified: z.boolean(),
});
