import { usageFetch } from '@/app/lib/usage-fetch';
import { withUsage } from '@/app/lib/usage-context';
import { NextRequest, NextResponse } from 'next/server';
import { extractSuggestions, stripSuggestionBlock } from '../../lib/formatMessage';
import { readServerEnv } from '../../lib/server-env';

const DEFAULT_API_URL = 'https://yunwu.ai/v1beta/models/gemini-3-flash-preview:generateContent';
const API_KEY = readServerEnv('YUNWU_WELCOME_API_KEY') || readServerEnv('AI_API_KEY') || '';

function normalizeGenerateUrl(rawUrl?: string): string {
    let url = (rawUrl || DEFAULT_API_URL).trim();
    url = url.replace(':streamGenerateContent', ':generateContent');

    try {
        const parsed = new URL(url);
        parsed.searchParams.delete('alt');
        return parsed.toString();
    } catch {
        return url.replace('?alt=sse', '').replace('&alt=sse', '');
    }
}

async function handlePost(req: NextRequest) {
    try {
        if (!API_KEY) {
            return NextResponse.json({ error: 'Missing welcome API key configuration' }, { status: 500 });
        }

        const { systemPrompt, userMessage } = await req.json();

        const apiUrl = normalizeGenerateUrl(readServerEnv('YUNWU_WELCOME_API_URL') || readServerEnv('AI_API_URL'));
        const upstream = await usageFetch(apiUrl, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                systemInstruction: {
                    parts: [{ text: systemPrompt }],
                },
                contents: [
                    {
                        role: 'user',
                        parts: [{ text: userMessage }],
                    },
                ],
                generationConfig: {
                    temperature: 1,
                    topP: 1,
                },
            }),
        });

        if (!upstream.ok) {
            const errText = await upstream.text();
            return NextResponse.json({ error: errText }, { status: upstream.status });
        }

        const data = await upstream.json();
        const text = data?.candidates?.[0]?.content?.parts
            ?.filter((p: { text?: string; thought?: boolean }) => !p.thought)
            ?.map((p: { text?: string }) => p.text || '')
            ?.join('') || '你好，请告诉我你的需求。';

        const content = stripSuggestionBlock(text).trim();
        const suggestions = extractSuggestions(text);

        return NextResponse.json({ content, suggestions });
    } catch (err) {
        const msg = err instanceof Error ? err.message : '未知错误';
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}

export const POST = withUsage(handlePost);
