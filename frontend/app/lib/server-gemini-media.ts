import { AppError } from './auth';
import { readServerEnv } from './server-env';

const DEFAULT_GEMINI_MEDIA_URL = 'https://yunwu.ai/v1beta/models/gemini-3-flash-preview:streamGenerateContent?alt=sse';
const DEFAULT_OPENAI_COMPATIBLE_GEMINI_MODEL = 'gemini-3.5-flash';

function isOpenAICompatibleChatUrl(apiUrl: string): boolean {
    return /\/chat\/completions(?:\?|$)/.test(apiUrl);
}

function getOpenAICompatibleGeminiMediaModel(): string {
    return (
        readServerEnv('GEMINI_CHAT_MODEL')
        || readServerEnv('YUNWU_CHAT_MODEL')
        || readServerEnv('AI_CHAT_MODEL')
        || readServerEnv('AI_API_CHAT_MODEL')
        || DEFAULT_OPENAI_COMPATIBLE_GEMINI_MODEL
    ).trim();
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

function parseOpenAICompatibleChatText(payload: unknown): string {
    const data = payload as {
        choices?: Array<{
            message?: { content?: unknown };
            delta?: { content?: unknown };
        }>;
    } | null;

    const texts: string[] = [];
    for (const choice of data?.choices || []) {
        texts.push(...extractOpenAICompatibleTexts(choice.message?.content));
        if (texts.length === 0) {
            texts.push(...extractOpenAICompatibleTexts(choice.delta?.content));
        }
    }

    return texts.join('').trim();
}

export function normalizeGeminiMediaUrl(rawUrl?: string): string {
    let url = (rawUrl || DEFAULT_GEMINI_MEDIA_URL).trim();
    url = url.replace(':generateContent', ':streamGenerateContent');

    if (!/[?&]alt=sse(?:&|$)/.test(url)) {
        url += url.includes('?') ? '&alt=sse' : '?alt=sse';
    }

    return url;
}

export function parseGeminiSseText(sseBody: string): string {
    let result = '';

    for (const line of sseBody.split('\n')) {
        if (!line.startsWith('data: ')) {
            continue;
        }

        const jsonStr = line.slice(6).trim();
        if (!jsonStr || jsonStr === '[DONE]') {
            continue;
        }

        try {
            const data = JSON.parse(jsonStr) as {
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
                    result += part.text;
                }
            }
        } catch {
            continue;
        }
    }

    return result;
}

export async function describeImageWithGemini(
    base64Data: string,
    mimeType: string,
    prompt = '请详细描述这张图片的内容，包括文字、主体、场景、布局、颜色和任何可见信息。',
): Promise<string> {
    return analyzeInlineMediaWithGemini(base64Data, mimeType, prompt);
}

export async function analyzeVideoSegmentWithGemini(
    base64Data: string,
    mimeType: string,
    prompt: string,
): Promise<string> {
    return analyzeInlineMediaWithGemini(base64Data, mimeType, prompt);
}

async function analyzeInlineMediaWithGemini(
    base64Data: string,
    mimeType: string,
    prompt: string,
): Promise<string> {
    const apiKey = readServerEnv('YUNWU_UPLOAD_API_KEY') || readServerEnv('GEMINI_CHAT_API_KEY') || readServerEnv('AI_API_KEY') || readServerEnv('YUNWU_CHAT_API_KEY');
    if (!apiKey) {
        throw new AppError('Missing Gemini media API key configuration', 500);
    }

    const rawApiUrl = (readServerEnv('YUNWU_UPLOAD_API_URL') || readServerEnv('GEMINI_CHAT_API_URL') || readServerEnv('AI_API_URL') || '').trim();
    const apiUrl = isOpenAICompatibleChatUrl(rawApiUrl)
        ? rawApiUrl
        : normalizeGeminiMediaUrl(rawApiUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    try {
        if (isOpenAICompatibleChatUrl(apiUrl)) {
            const upstream = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                signal: controller.signal,
                body: JSON.stringify({
                    model: getOpenAICompatibleGeminiMediaModel(),
                    stream: false,
                    messages: [{
                        role: 'user',
                        content: [
                            { type: 'text', text: prompt },
                            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Data}` } },
                        ],
                    }],
                }),
            });

            if (!upstream.ok) {
                const errorText = await upstream.text().catch(() => upstream.statusText);
                throw new AppError(`Gemini media request failed: ${errorText || upstream.statusText}`, upstream.status);
            }

            const data = await upstream.json().catch(() => null);
            const extractedText = parseOpenAICompatibleChatText(data);
            if (!extractedText) {
                throw new AppError('Gemini media response was empty.', 502);
            }

            return extractedText;
        }

        const upstream = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            signal: controller.signal,
            body: JSON.stringify({
                contents: [{
                    role: 'user',
                    parts: [
                        {
                            inlineData: { mimeType, data: base64Data },
                        },
                        { text: prompt },
                    ],
                }],
                generationConfig: {
                    temperature: 0.1,
                    topP: 1,
                },
            }),
        });

        if (!upstream.ok) {
            const errorText = await upstream.text().catch(() => upstream.statusText);
            throw new AppError(`Gemini media request failed: ${errorText || upstream.statusText}`, upstream.status);
        }

        const sseBody = await upstream.text();
        const extractedText = parseGeminiSseText(sseBody).trim();
        if (!extractedText) {
            throw new AppError('Gemini media response was empty.', 502);
        }

        return extractedText;
    } finally {
        clearTimeout(timeout);
    }
}
