import { usageFetch } from './usage-fetch';
import { AppError } from './auth';
import { readServerEnv } from './server-env';

const DEFAULT_GEMINI_CHAT_URL = 'https://yunwu.ai/v1beta/models/gemini-3-flash-preview:streamGenerateContent?alt=sse';
const DEFAULT_OPENAI_COMPATIBLE_GEMINI_MODEL = 'gemini-3.5-flash';

export type GeminiChatMessage = {
    role: 'user' | 'assistant';
    content: string | GeminiChatPart[];
};

export type GeminiChatPart =
    | { text: string }
    | { inlineData: { mimeType: string; data: string } };

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
    let url = (rawUrl || DEFAULT_GEMINI_CHAT_URL).trim();
    url = url.replace(':generateContent', ':streamGenerateContent');
    if (!/[?&]alt=sse(?:&|$)/.test(url)) {
        url += url.includes('?') ? '&alt=sse' : '?alt=sse';
    }
    return url;
}

function normalizeRequestUrl(rawUrl?: string): string {
    let url = (rawUrl || DEFAULT_GEMINI_CHAT_URL).trim();
    url = url.replace(':streamGenerateContent', ':generateContent');
    url = url.replace(/[?&]alt=sse(?:&|$)/, (match) => (match.startsWith('?') ? '?' : ''));
    url = url.replace(/\?&/, '?');
    url = url.replace(/[?&]$/, '');
    return url;
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

function getGeminiChatConfig(): { apiKey: string; apiUrl: string; model: string } {
    const apiKey = readServerEnv('GEMINI_CHAT_API_KEY') || readServerEnv('YUNWU_CHAT_API_KEY') || readServerEnv('AI_API_KEY');
    if (!apiKey) {
        throw new AppError('Missing chat API key configuration', 500);
    }

    return {
        apiKey,
        apiUrl: (readServerEnv('GEMINI_CHAT_API_URL') || readServerEnv('YUNWU_CHAT_API_URL') || readServerEnv('AI_API_URL') || DEFAULT_GEMINI_CHAT_URL).trim(),
        model: (
            readServerEnv('GEMINI_CHAT_MODEL')
            || readServerEnv('YUNWU_CHAT_MODEL')
            || readServerEnv('AI_CHAT_MODEL')
            || readServerEnv('AI_API_CHAT_MODEL')
            || DEFAULT_OPENAI_COMPATIBLE_GEMINI_MODEL
        ).trim(),
    };
}

function isOpenAICompatibleChatUrl(apiUrl: string): boolean {
    return /\/chat\/completions(?:\?|$)/.test(apiUrl);
}

function buildOpenAICompatibleMessages(systemPrompt: string, messages: GeminiChatMessage[]) {
    return [
        { role: 'system', content: systemPrompt.trim() },
        ...messages
            .map((message) => ({
                role: message.role === 'assistant' ? 'assistant' : 'user',
                content: buildOpenAICompatibleContent(message.content),
            }))
            .filter((message) => {
                if (typeof message.content === 'string') {
                    return message.content.trim().length > 0;
                }

                return message.content.length > 0;
            }),
    ];
}

function buildOpenAICompatibleContent(content: GeminiChatMessage['content']) {
    if (typeof content === 'string') {
        return content.trim();
    }

    const parts = content
        .map((part) => {
            if ('text' in part) {
                return part.text.trim() ? { type: 'text', text: part.text.trim() } : null;
            }

            const mimeType = part.inlineData?.mimeType;
            const data = part.inlineData?.data;
            if (!mimeType || !data) {
                return null;
            }

            return {
                type: 'image_url',
                image_url: { url: `data:${mimeType};base64,${data}` },
            };
        })
        .filter((part): part is { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } } => Boolean(part));

    if (parts.length === 1 && parts[0].type === 'text') {
        return parts[0].text;
    }

    return parts;
}

function extractOpenAICompatibleTexts(content: unknown): string[] {
    if (typeof content === 'string') {
        return content ? [content] : [];
    }

    if (!Array.isArray(content)) {
        return [];
    }

    const texts: string[] = [];
    for (const item of content) {
        if (typeof item === 'string') {
            if (item) texts.push(item);
            continue;
        }

        if (typeof item === 'object' && item !== null && typeof (item as { text?: unknown }).text === 'string') {
            texts.push((item as { text: string }).text);
        }
    }

    return texts;
}

function extractOpenAICompatibleStreamTexts(payload: string): string[] {
    if (!payload || payload === '[DONE]') {
        return [];
    }

    try {
        const data = JSON.parse(payload) as {
            choices?: Array<{
                delta?: { content?: unknown };
                message?: { content?: unknown };
            }>;
        };

        const texts: string[] = [];
        for (const choice of data.choices || []) {
            texts.push(...extractOpenAICompatibleTexts(choice.delta?.content));
            if (texts.length === 0) {
                texts.push(...extractOpenAICompatibleTexts(choice.message?.content));
            }
        }
        return texts;
    } catch {
        return [];
    }
}

async function streamOpenAICompatibleGeminiChat(params: {
    apiKey: string;
    apiUrl: string;
    model: string;
    systemPrompt: string;
    messages: GeminiChatMessage[];
    onText: (text: string) => void;
    temperature: number;
    maxOutputTokens: number;
}): Promise<void> {
    const upstream = await usageFetch(params.apiUrl, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${params.apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: params.model,
            stream: true,
            temperature: params.temperature,
            max_tokens: params.maxOutputTokens,
            messages: buildOpenAICompatibleMessages(params.systemPrompt, params.messages),
        }),
    });

    if (!upstream.ok || !upstream.body) {
        const errorText = await upstream.text().catch(() => upstream.statusText);
        throw new AppError(`Upstream chat request failed: ${errorText || upstream.statusText}`, upstream.status);
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
            for (const text of extractOpenAICompatibleStreamTexts(payload)) {
                params.onText(text);
            }
        }

        if (done) {
            break;
        }
    }

    const trailing = pending.trim();
    if (trailing.startsWith('data:')) {
        const payload = trailing.slice(5).trim();
        for (const text of extractOpenAICompatibleStreamTexts(payload)) {
            params.onText(text);
        }
    }
}

async function requestOpenAICompatibleGeminiChat(params: {
    apiKey: string;
    apiUrl: string;
    model: string;
    systemPrompt: string;
    messages: GeminiChatMessage[];
    temperature: number;
    maxOutputTokens: number;
}): Promise<string> {
    const upstream = await usageFetch(params.apiUrl, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${params.apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: params.model,
            stream: false,
            temperature: params.temperature,
            max_tokens: params.maxOutputTokens,
            messages: buildOpenAICompatibleMessages(params.systemPrompt, params.messages),
        }),
    });

    if (!upstream.ok) {
        const errorText = await upstream.text().catch(() => upstream.statusText);
        throw new AppError(`Upstream chat request failed: ${errorText || upstream.statusText}`, upstream.status);
    }

    const data = await upstream.json().catch(() => null) as {
        choices?: Array<{ message?: { content?: unknown } }>;
    } | null;

    return extractOpenAICompatibleTexts(data?.choices?.[0]?.message?.content).join('').trim();
}

export async function streamYunwuGeminiChat({
    systemPrompt,
    messages,
    onText,
    temperature = 0.8,
    topP = 0.95,
    maxOutputTokens = 8192,
}: StreamOptions): Promise<void> {
    const { apiKey, apiUrl: rawApiUrl, model } = getGeminiChatConfig();

    if (isOpenAICompatibleChatUrl(rawApiUrl)) {
        await streamOpenAICompatibleGeminiChat({
            apiKey,
            apiUrl: rawApiUrl,
            model,
            systemPrompt,
            messages,
            onText,
            temperature,
            maxOutputTokens,
        });
        return;
    }

    const apiUrl = normalizeStreamUrl(rawApiUrl);
    const contents = buildGeminiContents(messages);

    const upstream = await usageFetch(apiUrl, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
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
        throw new AppError(`Upstream chat request failed: ${errorText || upstream.statusText}`, upstream.status);
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
                const data = JSON.parse(payload) as {
                    candidates?: Array<{
                        content?: {
                            parts?: Array<{ text?: string; thought?: boolean }>;
                        };
                    }>;
                };

                const parts = data?.candidates?.[0]?.content?.parts;
                if (!Array.isArray(parts)) {
                    continue;
                }

                for (const part of parts) {
                    if (part?.text && !part?.thought) {
                        onText(part.text);
                    }
                }
            } catch {
                continue;
            }
        }

        if (done) {
            break;
        }
    }

    const trailing = pending.trim();
    if (trailing.startsWith('data:')) {
        const payload = trailing.slice(5).trim();
        try {
            const data = JSON.parse(payload) as {
                candidates?: Array<{
                    content?: {
                        parts?: Array<{ text?: string; thought?: boolean }>;
                    };
                }>;
            };
            const parts = data?.candidates?.[0]?.content?.parts;
            if (Array.isArray(parts)) {
                for (const part of parts) {
                    if (part?.text && !part?.thought) {
                        onText(part.text);
                    }
                }
            }
        } catch {
            // Ignore trailing partial chunk.
        }
    }
}

export async function requestYunwuGeminiChat({
    systemPrompt,
    messages,
    temperature = 0.2,
    topP = 0.8,
    maxOutputTokens = 512,
}: RequestOptions): Promise<string> {
    const { apiKey, apiUrl: rawApiUrl, model } = getGeminiChatConfig();

    if (isOpenAICompatibleChatUrl(rawApiUrl)) {
        return requestOpenAICompatibleGeminiChat({
            apiKey,
            apiUrl: rawApiUrl,
            model,
            systemPrompt,
            messages,
            temperature,
            maxOutputTokens,
        });
    }

    const apiUrl = normalizeRequestUrl(rawApiUrl);
    const contents = buildGeminiContents(messages);

    const upstream = await usageFetch(apiUrl, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
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
        throw new AppError(`Upstream chat request failed: ${errorText || upstream.statusText}`, upstream.status);
    }

    const data = await upstream.json().catch(() => null) as {
        candidates?: Array<{
            content?: {
                parts?: Array<{ text?: string; thought?: boolean }>;
            };
        }>;
    } | null;

    const parts = data?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) {
        return '';
    }

    return parts
        .filter((part) => part?.text && !part?.thought)
        .map((part) => part.text?.trim() || '')
        .filter(Boolean)
        .join('\n')
        .trim();
}
