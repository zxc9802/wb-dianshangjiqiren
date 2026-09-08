import { usageFetch } from './usage-fetch';
import { AppError } from './auth';
import { readServerEnv } from './server-env';
import type { GeminiChatMessage } from './yunwu-gemini-chat';

const DEFAULT_GEMINI_DEEP_CHAT_URL = 'http://47.77.198.47:3001/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse';

type StreamOptions = {
    systemPrompt: string;
    messages: GeminiChatMessage[];
    onText: (text: string) => void;
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
};

type RequestOptions = {
    systemPrompt: string;
    messages: GeminiChatMessage[];
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
};

function normalizeStreamUrl(rawUrl?: string): string {
    let url = (rawUrl || DEFAULT_GEMINI_DEEP_CHAT_URL).trim();
    url = url.replace(':generateContent', ':streamGenerateContent');
    if (!/[?&]alt=sse(?:&|$)/.test(url)) {
        url += url.includes('?') ? '&alt=sse' : '?alt=sse';
    }
    return url;
}

function normalizeRequestUrl(rawUrl?: string): string {
    let url = (rawUrl || DEFAULT_GEMINI_DEEP_CHAT_URL).trim();
    url = url.replace(':streamGenerateContent', ':generateContent');
    url = url.replace(/[?&]alt=sse(?:&|$)/, (match) => (match.startsWith('?') ? '?' : ''));
    url = url.replace(/\?&/, '?');
    url = url.replace(/[?&]$/, '');
    return url;
}

function attachApiKeyToUrl(rawUrl: string, apiKey: string): string {
    const url = new URL(rawUrl);
    if (!url.searchParams.has('key')) {
        url.searchParams.set('key', apiKey);
    }
    return url.toString();
}

function buildGeminiContents(messages: GeminiChatMessage[]) {
    return messages
        .map((message) => {
            const parts = typeof message.content === 'string'
                ? (message.content.trim() ? [{ text: message.content.trim() }] : [])
                : message.content.filter((part) => ('text' in part ? part.text.trim().length > 0 : Boolean(part.inlineData?.data)));

            return {
                role: message.role === 'assistant' ? 'model' : 'user',
                parts,
            };
        })
        .filter((message) => message.parts.length > 0);
}

function extractResponseText(
    data: {
        candidates?: Array<{
            content?: {
                parts?: Array<{ text?: string; thought?: boolean }>;
            };
        }>;
    } | null | undefined,
    onText: (text: string) => void,
) {
    const parts = data?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) {
        return;
    }

    for (const part of parts) {
        if (part?.text && !part?.thought) {
            onText(part.text);
        }
    }
}

export async function streamGeminiDeepThinkingChat({
    systemPrompt,
    messages,
    onText,
    temperature = 0.8,
    topP = 0.95,
    maxOutputTokens = 8192,
}: StreamOptions): Promise<void> {
    const apiKey = readServerEnv('GEMINI_DEEP_CHAT_API_KEY')?.trim();
    if (!apiKey) {
        throw new AppError('Missing Gemini deep thinking API key configuration', 500);
    }

    const apiUrl = attachApiKeyToUrl(normalizeStreamUrl(readServerEnv('GEMINI_DEEP_CHAT_API_URL')), apiKey);
    const contents = buildGeminiContents(messages);

    const upstream = await usageFetch(apiUrl, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'x-goog-api-key': apiKey,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            contents,
            systemInstruction: { parts: [{ text: systemPrompt }] },
            generationConfig: {
                temperature,
                topP,
                maxOutputTokens,
            },
        }),
    });

    if (!upstream.ok || !upstream.body) {
        const errorText = await upstream.text().catch(() => upstream.statusText);
        throw new AppError(`Upstream deep thinking request failed: ${errorText || upstream.statusText}`, upstream.status);
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';

    while (true) {
        const { done, value } = await reader.read();
        pending += decoder.decode(value || new Uint8Array(), { stream: !done });

        const lines = pending.split('\n');
        pending = lines.pop() || '';

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line.startsWith('data:')) {
                continue;
            }

            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') {
                continue;
            }

            try {
                extractResponseText(JSON.parse(payload), onText);
            } catch {
                continue;
            }
        }

        if (done) {
            break;
        }
    }

    const trailing = pending.trim();
    if (!trailing.startsWith('data:')) {
        return;
    }

    try {
        extractResponseText(JSON.parse(trailing.slice(5).trim()), onText);
    } catch {
        // Ignore trailing partial chunk.
    }
}

export async function requestGeminiDeepThinkingChat({
    systemPrompt,
    messages,
    temperature = 0.2,
    topP = 0.8,
    maxOutputTokens = 512,
}: RequestOptions): Promise<string> {
    const apiKey = readServerEnv('GEMINI_DEEP_CHAT_API_KEY')?.trim();
    if (!apiKey) {
        throw new AppError('Missing Gemini deep thinking API key configuration', 500);
    }

    const apiUrl = attachApiKeyToUrl(normalizeRequestUrl(readServerEnv('GEMINI_DEEP_CHAT_API_URL')), apiKey);
    const contents = buildGeminiContents(messages);

    const upstream = await usageFetch(apiUrl, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'x-goog-api-key': apiKey,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            contents,
            systemInstruction: { parts: [{ text: systemPrompt }] },
            generationConfig: {
                temperature,
                topP,
                maxOutputTokens,
            },
        }),
    });

    if (!upstream.ok) {
        const errorText = await upstream.text().catch(() => upstream.statusText);
        throw new AppError(`Upstream deep thinking request failed: ${errorText || upstream.statusText}`, upstream.status);
    }

    let combined = '';
    const data = await upstream.json().catch(() => null) as {
        candidates?: Array<{
            content?: {
                parts?: Array<{ text?: string; thought?: boolean }>;
            };
        }>;
    } | null;

    extractResponseText(data, (text) => {
        combined += text;
    });

    return combined.trim();
}
