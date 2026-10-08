// Minimal client for PushBird (https://pushbird.app/docs): a POST with a
// JSON body to a personal webhook URL sends a push notification.

export type PushBirdNotification = {
    title: string;
    message: string;
    subtitle?: string;
    /** URL opened when the notification is tapped. */
    openUrl?: string;
    /** Image attached to the notification. */
    imageUrl?: string;
    /** Defaults to 'active' on PushBird's side. */
    interruptionLevel?: 'passive' | 'active' | 'time-sensitive';
};

const REQUEST_TIMEOUT_MS = 10_000;

// The webhook URL embeds the secret (https://pushbird.app/pb_...) and is the
// only credential, so it must never end up in an error message or a log.
export async function sendPushBirdNotification(
    notification: PushBirdNotification,
    webhookUrl = process.env.PUSHBIRD_WEBHOOK_URL,
): Promise<void> {
    if (!webhookUrl) throw new Error('PUSHBIRD_WEBHOOK_URL is not set');

    const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            title: notification.title,
            message: notification.message,
            subtitle: notification.subtitle,
            open_url: notification.openUrl,
            image_url: notification.imageUrl,
            'interruption-level': notification.interruptionLevel,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
        // Errors come back as {"error": "..."}.
        const detail = await response
            .json()
            .then((body: { error?: string }) => body.error)
            .catch(() => undefined);
        throw new Error(`PushBird request failed (${response.status})${detail ? `: ${detail}` : ''}`);
    }
}
