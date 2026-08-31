import { AppError } from './auth';
import { readServerEnv } from './server-env';
import {
    looksLikeHtmlPayload,
    looksLikeTimeoutPayload,
    normalizeUpstreamErrorMessage,
    truncateForLog,
} from './upstream-error';

const DEFAULT_OPENAI_CHAT_URL = 'https://api.openlux.ai/v1/responses';
export const GPT_5_4_MODEL = 'gpt-5.4';
const DEFAULT_OPENAI_CHAT_MODEL = 'gpt-5.5';

export type OpenAIContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } };

export type OpenAIChatMessage = {
    role: 'user' | 'assistant';
    content: string | OpenAIContentPart[];
};

type OpenAIRequestMessage = {
    role: 'system' | 'user' | 'assistant';
    content: string | OpenAIContentPart[];
};

type OpenAIChatOptions = {
    systemPrompt: string;
    messages: OpenAIChatMessage[];
    temperature?: number;
    maxTokens?: number;
    model?: string;
};

type StreamOptions = OpenAIChatOptions & {
    onText: (text: string) => void;
};

type OpenAIResponsePayload = {
    choices?: Array<{
        delta?: { content?: unknown };
        message?: { content?: unknown };
    }>;
};

type OpenAIResponsesPayload = {
    output_text?: string;
    output?: Array<{
        content?: Array<{
            text?: string;
        }>;
    }>;
};

function logUnexpectedUpstreamResponse(context: string, status: number, contentType: string, body: string) {
    console.error(`[OpenAIChat] ${context}`, {
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

export function getYunwuOpenAIChatConfig(): {
    apiKey: string;
    apiUrl: string;
    model: string;
} {
    const apiKey = (
        readServerEnv('OPENLUX_API_KEY')
        || readServerEnv('YUNWU_OPENAI_CHAT_API_KEY')
        || readServerEnv('YUNWU_OPENAI_API_KEY')
        || readServerEnv('YUNWU_CHAT_API_KEY')
        || readServerEnv('AI_API_KEY')
    );
    if (!apiKey) {
        throw new AppError('Missing chat API key configuration', 500);
    }

    const openLuxBaseUrl = (readServerEnv('OPENLUX_API_BASE_URL') || '').trim().replace(/\/+$/, '');
    const apiUrl = (
        readServerEnv('YUNWU_OPENAI_CHAT_URL')
        || readServerEnv('YUNWU_OPENAI_API_URL')
        || (openLuxBaseUrl
            ? `${openLuxBaseUrl.endsWith('/v1') ? openLuxBaseUrl : `${openLuxBaseUrl}/v1`}/responses`
            : '')
        || DEFAULT_OPENAI_CHAT_URL
    ).trim();
    const model = (
        readServerEnv('YUNWU_OPENAI_CHAT_MODEL')
        || readServerEnv('YUNWU_CHAT_MODEL')
        || readServerEnv('AI_CHAT_MODEL')
        || DEFAULT_OPENAI_CHAT_MODEL
    ).trim();

    return { apiKey, apiUrl, model };
}

function normalizeMessages(systemPrompt: string, messages: OpenAIChatMessage[]): OpenAIRequestMessage[] {
    const normalizedMessages = messages
        .filter((message) => {
            if (typeof message.content === 'string') {
                return message.content.trim().length > 0;
            }

            return Array.isArray(message.content) && message.content.length > 0;
        })
        .map((message) => ({
            role: message.role,
            content: typeof message.content === 'string' ? message.content.trim() : message.content,
        }));

    return [
        { role: 'system', content: systemPrompt.trim() },
        ...normalizedMessages,
    ];
}

function buildRequestBody(
    model: string,
    systemPrompt: string,
    messages: OpenAIChatMessage[],
    temperature: number,
    maxTokens: number,
    stream: boolean,
) {
    return {
        model,
        stream,
        temperature,
        max_tokens: maxTokens,
        messages: normalizeMessages(systemPrompt, messages),
    };
}

function isResponsesApiUrl(apiUrl: string): boolean {
    try {
        return new URL(apiUrl).pathname.replace(/\/+$/, '').endsWith('/responses');
    } catch {
        return apiUrl.replace(/\/+$/, '').endsWith('/responses');
    }
}

function buildResponsesInput(messages: OpenAIChatMessage[]) {
    return messages
        .filter((message) => typeof message.content === 'string'
            ? message.content.trim().length > 0
            : message.content.length > 0)
        .map((message) => ({
            role: message.role,
            content: typeof message.content === 'string'
                ? message.content.trim()
                : message.content.map((part) => part.type === 'text'
                    ? {
                        type: message.role === 'assistant' ? 'output_text' : 'input_text',
                        text: part.text,
                    }
                    : {
                        type: 'input_image',
                        image_url: part.image_url.url,
                    }),
        }));
}

function buildResponsesRequestBody(
    model: string,
    systemPrompt: string,
    messages: OpenAIChatMessage[],
    maxTokens: number,
) {
    return {
        model,
        instructions: systemPrompt.trim(),
        input: buildResponsesInput(messages),
        max_output_tokens: maxTokens,
    };
}

function extractTextsFromContent(content: unknown): string[] {
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

        if (typeof (item as { text?: unknown }).text === 'string') {
            texts.push((item as { text: string }).text);
            continue;
        }

        if (typeof (item as { content?: unknown }).content === 'string') {
            texts.push((item as { content: string }).content);
        }
    }

    return texts;
}

export function extractOpenAIResponsesText(payload: OpenAIResponsesPayload): string {
    if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
        return payload.output_text.trim();
    }

    return (payload.output || [])
        .flatMap((item) => item.content || [])
        .map((item) => typeof item.text === 'string' ? item.text : '')
        .join('')
        .trim();
}

async function requestOpenAIResponses(params: {
    apiKey: string;
    apiUrl: string;
    requestModel: string;
    systemPrompt: string;
    messages: OpenAIChatMessage[];
    maxTokens: number;
}): Promise<string> {
    const upstream = await fetch(params.apiUrl, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${params.apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildResponsesRequestBody(
            params.requestModel,
            params.systemPrompt,
            params.messages,
            params.maxTokens,
        )),
    });

    const contentType = upstream.headers.get('content-type') || '';
    const rawResponse = await upstream.text().catch(() => upstream.statusText);
    if (!upstream.ok || shouldTreatAsHtmlError(contentType, rawResponse)) {
        throw buildUpstreamAppError({
            context: upstream.ok ? 'unexpected HTML Responses response' : 'non-ok Responses response',
            status: upstream.status,
            contentType,
            body: rawResponse || upstream.statusText,
        });
    }

    let data: OpenAIResponsesPayload;
    try {
        data = JSON.parse(rawResponse) as OpenAIResponsesPayload;
    } catch {
        throw buildUpstreamAppError({
            context: 'invalid Responses JSON payload',
            status: upstream.status,
            contentType,
            body: rawResponse || 'Invalid JSON response',
            fallbackStatus: 502,
        });
    }

    const text = extractOpenAIResponsesText(data);
    if (!text) {
        throw new AppError('Upstream Responses payload missing output text', 502);
    }

    return text;
}

export function extractOpenAIStreamTexts(payload: string): string[] {
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
            texts.push(...extractTextsFromContent(choice.delta?.content));
            if (texts.length === 0) {
                texts.push(...extractTextsFromContent(choice.message?.content));
            }
        }
        return texts;
    } catch {
        return [];
    }
}

export async function requestYunwuOpenAIChat({
    systemPrompt,
    messages,
    temperature = 0.8,
    maxTokens = 8192,
    model: modelOverride,
}: OpenAIChatOptions): Promise<string> {
    const { apiKey, apiUrl, model } = getYunwuOpenAIChatConfig();
    const requestModel = modelOverride?.trim() || model;

    if (isResponsesApiUrl(apiUrl)) {
        return requestOpenAIResponses({
            apiKey,
            apiUrl,
            requestModel,
            systemPrompt,
            messages,
            maxTokens,
        });
    }

    const upstream = await fetch(apiUrl, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(
            buildRequestBody(requestModel, systemPrompt, messages, temperature, maxTokens, false),
        ),
    });

    const contentType = upstream.headers.get('content-type') || '';
    const rawResponse = await upstream.text().catch(() => upstream.statusText);
    if (!upstream.ok) {
        throw buildUpstreamAppError({
            context: 'non-ok completion response',
            status: upstream.status,
            contentType,
            body: rawResponse || upstream.statusText,
        });
    }

    if (shouldTreatAsHtmlError(contentType, rawResponse)) {
        throw buildUpstreamAppError({
            context: 'unexpected HTML completion response',
            status: upstream.status,
            contentType,
            body: rawResponse,
        });
    }

    let data: OpenAIResponsePayload;
    try {
        data = JSON.parse(rawResponse) as OpenAIResponsePayload;
    } catch {
        throw buildUpstreamAppError({
            context: 'invalid completion JSON payload',
            status: upstream.status,
            contentType,
            body: rawResponse || 'Invalid JSON response',
            fallbackStatus: 502,
        });
    }

    if (!data.choices?.length) {
        throw new AppError('Upstream chat response missing choices', 502);
    }

    const content = data.choices[0]?.message?.content;
    if (typeof content === 'undefined' || content === null) {
        throw new AppError('Upstream chat response missing message content', 502);
    }

    return extractTextsFromContent(content).join('');
}

export async function streamYunwuOpenAIChat({
    systemPrompt,
    messages,
    onText,
    temperature = 0.8,
    maxTokens = 8192,
    model: modelOverride,
}: StreamOptions): Promise<void> {
    const { apiKey, apiUrl, model } = getYunwuOpenAIChatConfig();
    const requestModel = modelOverride?.trim() || model;

    if (isResponsesApiUrl(apiUrl)) {
        const text = await requestOpenAIResponses({
            apiKey,
            apiUrl,
            requestModel,
            systemPrompt,
            messages,
            maxTokens,
        });
        onText(text);
        return;
    }

    const upstream = await fetch(apiUrl, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(
            buildRequestBody(requestModel, systemPrompt, messages, temperature, maxTokens, true),
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
            for (const text of extractOpenAIStreamTexts(payload)) {
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
        for (const text of extractOpenAIStreamTexts(payload)) {
            onText(text);
        }
    }
}
