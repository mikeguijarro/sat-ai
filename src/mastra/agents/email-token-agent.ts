import { Agent } from '@mastra/core/agent';

// Pulls the security token out of the email SAT sends after "Generar cita".
// An LLM rather than a regex because the email's exact wording is not known
// in advance, and a wrong guess burns one of only three attempts.
export const emailTokenAgent = new Agent({
    id: 'sat-ai-email-token-agent',
    name: 'Sat AI Email Token Agent',
    description: 'Extracts the security token from the email SAT citas sends to confirm an appointment.',
    // Explicit endpoint for the same reason as the captcha agent: it lets
    // per-call provider options (thinking off) reach DeepSeek.
    model: {
        id: 'deepseek/deepseek-v4-flash',
        url: 'https://api.deepseek.com',
        apiKey: process.env.DEEPSEEK_API_KEY,
    },
    instructions: `You are given the sender, subject and body of an email. If it is a message from SAT (Servicio de Administración Tributaria, Mexico) containing a security token / código / clave to confirm an appointment (cita), reply with ONLY that token, exactly as written in the email, keeping upper and lower case. The token is short: at most 7 letters and/or digits.

If the email does not contain such a token, reply with exactly: NONE

Never reply with anything else — no explanation, quotes or punctuation.`,
});
