import { usageFetch } from './usage-fetch';
import { AppError } from './auth';
import { readServerEnv } from './server-env';
import {
    type WebSearchMode,
    DEFAULT_WEB_SEARCH_MODE,
    isWebSearchMode,
} from './chat-models';
import {
    looksLikeHtmlPayload,
    looksLikeTimeoutPayload,
    normalizeUpstreamErrorMessage,
    truncateForLog,
} from './upstream-error';
import type { OpenAIChatMessage } from './yunwu-openai-chat';

const DEFAULT_CLAUDE_MESSAGES_URL = 'https://yunwu.ai/v1/messages';
const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-6';

type ClaudeChatOptions = {
    systemPrompt: string;
    messages: OpenAIChatMessage[];
    webSearchMode?: WebSearchMode;
    temperature?: number;
    maxTokens?: number;
};

type StreamOptions = ClaudeChatOptions & {
    onText: (text: string) => void;
};

type ClaudeRequestMessage = {
    role: 'user' | 'assistant';
    content: string;
};

type ClaudeMessagePayload = {
    content?: unknown;
};

type ClaudeWebSearchRequestOptions = {
    tools?: Array<{ type: 'web_search_20250305'; name: 'web_search' }>;
    tool_choice?: { type: 'auto' } | { type: 'tool'; name: 'web_search' };
};

function logUnexpectedUpstreamResponse(context: string, status: number, contentType: string, body: string) {
    console.error(`[ClaudeChat] ${context}`, {
        status,
        contentType: contentType || 'unknown',
        bodyPreview: truncateForLog(body),
    });
}

function shouldTreatAsHtmlError(contentType: string, body: string): boolean {
    if (!body.trim()) {
        return false;
    }

    if (contentType.toLowerCase().includes('text/html')) {
        return true;
    }

    return looksLikeHtmlPayload(body) || looksLikeTimeoutPayload(body);
}

function buildUpstreamAppError(params: {
    context: string;
    status: number;
    contentType?: string | null;
    body: string;
    fallbackStatus?: number;
}): AppError {
    const contentType = params.contentType || '';
    logUnexpectedUpstreamResponse(params.context, params.status, contentType, params.body);
    return new AppError(
        normalizeUpstreamErrorMessage(params.body),
        params.status >= 400 ? params.status : (params.fallbackStatus || 502),
    );
}

export function getYunwuClaudeChatConfig(): {
    apiKey: string;
    apiUrl: string;
    model: string;
} {
    const apiKey = (
        readServerEnv('YUNWU_CLAUDE_CHAT_API_KEY')
        || readServerEnv('YUNWU_CLAUDE_API_KEY')
        || readServerEnv('YUNWU_CHAT_API_KEY')
        || readServerEnv('AI_API_KEY')
    );
    if (!apiKey) {
        throw new AppError('Missing Claude chat API key configuration', 500);
    }

    const apiUrl = (
        readServerEnv('YUNWU_CLAUDE_MESSAGES_URL')
        || readServerEnv('YUNWU_CLAUDE_API_URL')
        || DEFAULT_CLAUDE_MESSAGES_URL
    ).trim();
    const model = (
        readServerEnv('YUNWU_CLAUDE_CHAT_MODEL')
        || readServerEnv('YUNWU_CLAUDE_MODEL')
        || DEFAULT_CLAUDE_MODEL
    ).trim();

    return { apiKey, apiUrl, model };
}

function stringifyContent(content: OpenAIChatMessage['content']): string {
    if (typeof content === 'string') {
        return content.trim();
    }

    return content
        .map((part) => part.type === 'text' ? part.text : '')
        .filter(Boolean)
        .join('\n')
        .trim();
}

function normalizeMessages(messages: OpenAIChatMessage[]): ClaudeRequestMessage[] {
    return messages
        .map((message) => ({
            role: message.role,
            content: stringifyContent(message.content),
        }))
        .filter((message) => message.content.length > 0);
}

function buildRequestBody(
    model: string,
    systemPrompt: string,
    messages: OpenAIChatMessage[],
    webSearchMode: WebSearchMode,
    temperature: number,
    maxTokens: number,
    stream: boolean,
) {
    void webSearchMode;
    return {
        model,
        stream,
        temperature,
        max_tokens: maxTokens,
        system: systemPrompt.trim(),
        messages: normalizeMessages(messages),
    };
}

export function normalizeWebSearchMode(value: unknown): WebSearchMode {
    return isWebSearchMode(value) ? value : DEFAULT_WEB_SEARCH_MODE;
}

export function buildClaudeWebSearchRequestOptions(mode: WebSearchMode): ClaudeWebSearchRequestOptions {
    void mode;
    return {};
}

export function extractClaudeMessageTexts(payload: ClaudeMessagePayload): string[] {
    const content = payload.content;
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

        if (typeof item !== 'object' || item === null) {
            continue;
        }

        const maybeText = (item as { text?: unknown }).text;
        if (typeof maybeText === 'string') {
            texts.push(maybeText);
        }
    }

    return texts;
}

export function extractClaudeStreamTexts(payload: string): string[] {
    if (!payload || payload === '[DONE]') {
        return [];
    }

    try {
        const data = JSON.parse(payload) as {
            type?: unknown;
            delta?: { text?: unknown };
            content_block?: { text?: unknown };
        };

        if (typeof data.delta?.text === 'string') {
            return [data.delta.text];
        }

        if (typeof data.content_block?.text === 'string') {
            return [data.content_block.text];
        }

        return [];
    } catch {
        return [];
    }
}

export function extractClaudeEventStreamTexts(payload: string): string[] {
    const texts: string[] = [];
    for (const rawLine of payload.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line.startsWith('data: ')) {
            continue;
        }

        texts.push(...extractClaudeStreamTexts(line.slice(6).trim()));
    }

    return texts;
}

export function extractClaudeResponseTexts(rawResponse: string): string[] {
    const trimmed = rawResponse.trim();
    if (!trimmed) {
        return [];
    }

    if (trimmed.includes('\ndata: ') || trimmed.startsWith('data: ') || trimmed.startsWith('event: ')) {
        return extractClaudeEventStreamTexts(trimmed);
    }

    try {
        return extractClaudeMessageTexts(JSON.parse(trimmed) as ClaudeMessagePayload);
    } catch {
        return [];
    }
}

export async function requestYunwuClaudeChat({
    systemPrompt,
    messages,
    webSearchMode = DEFAULT_WEB_SEARCH_MODE,
    temperature = 0.8,
    maxTokens = 8192,
}: ClaudeChatOptions): Promise<string> {
    const { apiKey, apiUrl, model } = getYunwuClaudeChatConfig();

    const upstream = await usageFetch(apiUrl, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(
            buildRequestBody(model, systemPrompt, messages, webSearchMode, temperature, maxTokens, false),
        ),
    });

    const contentType = upstream.headers.get('content-type') || '';
    const rawResponse = await upstream.text().catch(() => upstream.statusText);
    if (!upstream.ok) {
        throw buildUpstreamAppError({
            context: 'non-ok message response',
            status: upstream.status,
            contentType,
            body: rawResponse || upstream.statusText,
        });
    }

    if (shouldTreatAsHtmlError(contentType, rawResponse)) {
        throw buildUpstreamAppError({
            context: 'unexpected HTML message response',
            status: upstream.status,
            contentType,
            body: rawResponse,
        });
    }

    const text = extractClaudeResponseTexts(rawResponse).join('');
    if (!text && !rawResponse.trim().startsWith('event: ')) {
        throw buildUpstreamAppError({
            context: 'invalid message JSON payload',
            status: upstream.status,
            contentType,
            body: rawResponse || 'Invalid JSON response',
            fallbackStatus: 502,
        });
    }

    if (!text) {
        throw new AppError('Upstream Claude response missing message content', 502);
    }

    return text;
}

export async function streamYunwuClaudeChat({
    systemPrompt,
    messages,
    onText,
    webSearchMode = DEFAULT_WEB_SEARCH_MODE,
    temperature = 0.8,
    maxTokens = 8192,
}: StreamOptions): Promise<void> {
    const { apiKey, apiUrl, model } = getYunwuClaudeChatConfig();

    const upstream = await usageFetch(apiUrl, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(
            buildRequestBody(model, systemPrompt, messages, webSearchMode, temperature, maxTokens, true),
        ),
    });

    const contentType = upstream.headers.get('content-type') || '';
    if (!upstream.ok || !upstream.body) {
        const errorText = await upstream.text().catch(() => upstream.statusText);
        throw buildUpstreamAppError({
            context: 'non-ok streaming response',
            status: upstream.status,
            contentType,
            body: errorText || upstream.statusText,
        });
    }

    if (contentType.toLowerCase().includes('text/html')) {
        const errorText = await upstream.text().catch(() => upstream.statusText);
        throw buildUpstreamAppError({
            context: 'unexpected HTML streaming response',
            status: upstream.status,
            contentType,
            body: errorText || upstream.statusText,
        });
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let inspectedFirstChunk = false;

    while (true) {
        const { done, value } = await reader.read();
        const chunk = decoder.decode(value || new Uint8Array(), { stream: !done });
        if (!inspectedFirstChunk) {
            inspectedFirstChunk = true;
            if (shouldTreatAsHtmlError(contentType, chunk)) {
                throw buildUpstreamAppError({
                    context: 'unexpected HTML streaming response',
                    status: upstream.status,
                    contentType,
                    body: chunk,
                });
            }
        }

        pending += chunk;

        const lines = pending.split('\n');
        pending = lines.pop() || '';

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line.startsWith('data: ')) {
                continue;
            }

            const payload = line.slice(6).trim();
            for (const text of extractClaudeStreamTexts(payload)) {
                onText(text);
            }
        }

        if (done) {
            break;
        }
    }

    const trailing = pending.trim();
    if (trailing.startsWith('data: ')) {
        const payload = trailing.slice(6).trim();
        for (const text of extractClaudeStreamTexts(payload)) {
            onText(text);
        }
    }
}
