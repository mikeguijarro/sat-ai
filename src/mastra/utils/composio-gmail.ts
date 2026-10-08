import { Composio } from '@composio/core';

// Read-only Gmail access through Composio (https://composio.dev), using the
// Gmail account connected to the COMPOSIO_API_KEY project.

export type GmailMessage = {
    id: string;
    /** When Gmail received it, in epoch milliseconds. */
    receivedAt: number;
    sender: string;
    subject: string;
    /** Body as plain text (HTML tags stripped). */
    text: string;
};

type FetchEmailsResult = {
    messages?: Array<{
        messageId?: string;
        messageTimestamp?: string;
        sender?: string;
        subject?: string;
        messageText?: string;
        preview?: { body?: string };
    }>;
};

// Pinned so a new Gmail toolkit release cannot change the response shape
// under an unattended run. Bump it on purpose, after checking the fields
// read below still exist.
const GMAIL_TOOLKIT_VERSION = '20261008_00';

let client: Composio | undefined;
let userId: string | undefined;

function getClient(): Composio {
    const apiKey = process.env.COMPOSIO_API_KEY;
    if (!apiKey) throw new Error('COMPOSIO_API_KEY is not set');
    client ??= new Composio({ apiKey, toolkitVersions: { gmail: GMAIL_TOOLKIT_VERSION } });
    return client;
}

// Composio runs every tool on behalf of a "user id" — the id the Gmail
// account was connected under. Use COMPOSIO_USER_ID when set; otherwise look
// up the project's active Gmail connection once and reuse it.
async function getUserId(): Promise<string> {
    if (userId) return userId;
    if (process.env.COMPOSIO_USER_ID) {
        userId = process.env.COMPOSIO_USER_ID;
        return userId;
    }

    // Plain REST because the SDK's connectedAccounts.list() does not return
    // the user id.
    const apiKey = process.env.COMPOSIO_API_KEY;
    if (!apiKey) throw new Error('COMPOSIO_API_KEY is not set');
    const response = await fetch('https://backend.composio.dev/api/v3.1/connected_accounts?toolkit_slugs=gmail&statuses=ACTIVE', {
        headers: { 'x-api-key': apiKey },
        signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Composio connected-accounts lookup failed (${response.status})`);
    const body = (await response.json()) as { items?: Array<{ user_id?: string; toolkit?: { slug?: string }; status?: string }> };
    const account = body.items?.find(item => item.toolkit?.slug === 'gmail' && item.status === 'ACTIVE' && item.user_id);
    if (!account?.user_id) throw new Error('No active Gmail account is connected to this Composio project');
    userId = account.user_id;
    return userId;
}

const toPlainText = (html: string) =>
    html
        .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();

export async function fetchEmails(options: {
    /** Gmail search query, e.g. "newer_than:1h from:sat.gob.mx". */
    query: string;
    maxResults?: number;
    includeSpamTrash?: boolean;
}): Promise<GmailMessage[]> {
    const result = await getClient().tools.execute('GMAIL_FETCH_EMAILS', {
        userId: await getUserId(),
        arguments: {
            query: options.query,
            max_results: options.maxResults ?? 10,
            include_spam_trash: options.includeSpamTrash ?? false,
            include_payload: false,
            verbose: true,
        },
    });
    if (!result.successful) throw new Error(`Composio GMAIL_FETCH_EMAILS failed: ${result.error ?? 'unknown error'}`);

    const { messages = [] } = result.data as FetchEmailsResult;
    return messages.map(message => ({
        id: message.messageId ?? '',
        receivedAt: message.messageTimestamp ? Date.parse(message.messageTimestamp) : 0,
        sender: message.sender ?? '',
        subject: message.subject ?? '',
        text: toPlainText(message.messageText || message.preview?.body || ''),
    }));
}
