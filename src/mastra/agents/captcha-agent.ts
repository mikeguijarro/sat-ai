import { Agent } from '@mastra/core/agent';

// Deliberately tiny: no tools, no memory, no browser. The check-availability workflow
// hands it one CAPTCHA image and expects the characters back, so anything
// extra just adds latency inside the site's ~5 minute session timer.
export const captchaAgent = new Agent({
    id: 'sat-ai-captcha-agent',
    name: 'Sat AI Captcha Agent',
    description: 'Transcribes the 5-character CAPTCHA image shown on the SAT citas login form.',
    // Must go through the explicit endpoint, not the plain
    // 'deepseek/...' string: Mastra's built-in DeepSeek provider keeps only
    // the text parts of a user message and silently drops the image, so the
    // model answers "I can't see the image". With `url` set, the request is
    // sent OpenAI-compatible style and the image arrives.
    model: {
        id: 'deepseek/deepseek-v4-flash-vision-exp',
        url: 'https://api.deepseek.com',
        apiKey: process.env.DEEPSEEK_API_KEY,
    },
    instructions: `You transcribe CAPTCHA images from citas.sat.gob.mx.

The image contains exactly 5 characters (lowercase letters a-z and digits 0-9) drawn in different colors, with thin decorative circles and lines overlapping them. Ignore the circles and lines — they are noise, not characters.

Reply with ONLY the 5 characters, left to right, lowercase, with no spaces, quotes, punctuation, or explanation.`,
});
