import { readServerEnv } from './server-env';
import {
    DEFAULT_WEB_SEARCH_MODE,
    type WebSearchMode,
} from './chat-models';
import type { OpenAIChatMessage } from './yunwu-openai-chat';

const DEFAULT_YUNWU_SEARCH_API_URL = 'https://yunwu.ai/v1/chat/completions';
const YUNWU_SEARCH_MODEL = 'gpt-4o-search-preview';
const MAX_QUERY_CHARS = 500;

type YunwuSearchPayload = {
    choices?: Array<{
        message?: {
            content?: unknown;
        };
    }>;
};

export type WebSearchEnrichmentResult = {
    systemPrompt: string;
    usedWebSearch: boolean;
};

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

export function getLatestUserQuery(messages: OpenAIChatMessage[]): string {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.role !== 'user') {
            continue;
        }

        const text = stringifyContent(message.content).trim();
        if (text) {
            return text.slice(0, MAX_QUERY_CHARS);
        }
    }

    return '';
}

export function shouldAutoUseWebSearch(query: string): boolean {
    const normalized = query.toLowerCase();
    return [
        '最新',
        '今天',
        '现在',
        '当前',
        '新闻',
        '近期',
        '最近',
        '实时',
        '价格',
        '股价',
        '汇率',
        '天气',
        'today',
        'latest',
        'recent',
        'current',
        'news',
        'price',
        'stock',
        'weather',
    ].some((keyword) => normalized.includes(keyword));
}

function shouldUseWebSearch(mode: WebSearchMode, query: string): boolean {
    if (mode === 'off') {
        return false;
    }

    if (mode === 'on') {
        return Boolean(query.trim());
    }

    return shouldAutoUseWebSearch(query);
}

async function searchYunwu(query: string): Promise<string> {
    const apiKey = readServerEnv('YUNWU_SEARCH_API_KEY')?.trim();
    if (!apiKey) {
        throw new Error('YUNWU_SEARCH_API_KEY is not configured.');
    }

    const apiUrl = readServerEnv('YUNWU_SEARCH_API_URL')?.trim() || DEFAULT_YUNWU_SEARCH_API_URL;
    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: YUNWU_SEARCH_MODEL,
            web_search_options: {},
            messages: [{ role: 'user', content: query }],
        }),
    });

    const rawText = await response.text().catch(() => '');
    if (!response.ok) {
        throw new Error(`Yunwu web search request failed with status ${response.status}: ${rawText || response.statusText}`);
    }

    let payload: YunwuSearchPayload;
    try {
        payload = JSON.parse(rawText) as YunwuSearchPayload;
    } catch {
        throw new Error('Yunwu web search returned invalid JSON.');
    }

    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
        throw new Error('Yunwu web search returned no usable content.');
    }

    return content.trim();
}

export function buildWebSearchContextBlock(content: string): string {
    if (!content.trim()) {
        return '';
    }

    return [
        '# 联网搜索参考',
        '以下内容来自实时联网搜索。回答涉及事实、时间、价格、新闻或外部资料时，优先参考这些结果；如果结果不足以支撑结论，请明确说明不确定。',
        '',
        content.trim(),
    ].join('\n\n');
}

export async function enrichSystemPromptWithWebSearch({
    systemPrompt,
    messages,
    webSearchMode = DEFAULT_WEB_SEARCH_MODE,
}: {
    systemPrompt: string;
    messages: OpenAIChatMessage[];
    webSearchMode?: WebSearchMode;
}): Promise<WebSearchEnrichmentResult> {
    const query = getLatestUserQuery(messages);
    if (!shouldUseWebSearch(webSearchMode, query)) {
        return { systemPrompt, usedWebSearch: false };
    }

    const searchContent = await searchYunwu(query);
    const contextBlock = buildWebSearchContextBlock(searchContent);
    if (!contextBlock) {
        return { systemPrompt, usedWebSearch: true };
    }

    return {
        systemPrompt: `${systemPrompt.trim()}\n\n${contextBlock}`.trim(),
        usedWebSearch: true,
    };
}
