import { usageFetch } from './usage-fetch';
import { prisma } from './prisma';
import { readServerEnv } from './server-env';
import { requestYunwuOpenAIChat } from './yunwu-openai-chat';
import {
    buildMemoryContextBlock,
    parseExtractedMemories,
    resolveMemoryBotRouteId,
    type ExtractedMemory,
} from './server-memory-text';

const DEFAULT_EMBEDDING_URL = 'https://yunwu.ai/v1/embeddings';
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
const DEFAULT_MEMORY_MAX_RESULTS = 5;

type MemorySearchResult = {
    id: string;
    content: string;
    memory_type: string;
    importance: number;
    distance: number;
};

function isTruthyEnv(value: string | undefined): boolean {
    return ['1', 'true', 'yes', 'on'].includes((value || '').trim().toLowerCase());
}

export function isLongTermMemoryEnabled(): boolean {
    return isTruthyEnv(readServerEnv('MEMORY_ENABLED'));
}

function isMemoryWriteEnabled(): boolean {
    const value = readServerEnv('MEMORY_WRITE_ENABLED');
    return typeof value === 'undefined' ? isLongTermMemoryEnabled() : isTruthyEnv(value);
}

function readMemoryMaxResults(): number {
    const value = Number(readServerEnv('MEMORY_MAX_RESULTS'));
    if (!Number.isFinite(value)) {
        return DEFAULT_MEMORY_MAX_RESULTS;
    }
    return Math.max(1, Math.min(10, Math.round(value)));
}

function readEmbeddingConfig(): { apiKey: string; apiUrl: string; model: string } | null {
    const apiKey = readServerEnv('MEMORY_EMBEDDING_API_KEY')
        || readServerEnv('YUNWU_OPENAI_API_KEY')
        || readServerEnv('YUNWU_CHAT_API_KEY')
        || readServerEnv('AI_API_KEY');
    if (!apiKey?.trim()) {
        return null;
    }

    return {
        apiKey: apiKey.trim(),
        apiUrl: (readServerEnv('MEMORY_EMBEDDING_API_URL') || DEFAULT_EMBEDDING_URL).trim(),
        model: (readServerEnv('MEMORY_EMBEDDING_MODEL') || DEFAULT_EMBEDDING_MODEL).trim(),
    };
}

function toVectorLiteral(embedding: number[]): string {
    return `[${embedding.map((value) => Number(value).toFixed(8)).join(',')}]`;
}

async function embedText(text: string): Promise<number[] | null> {
    const config = readEmbeddingConfig();
    if (!config || !text.trim()) {
        return null;
    }

    const response = await usageFetch(config.apiUrl, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: config.model,
            input: text.trim().slice(0, 4000),
        }),
    });

    if (!response.ok) {
        throw new Error(`Embedding request failed: ${response.status}`);
    }

    const payload = await response.json() as {
        data?: Array<{ embedding?: unknown }>;
    };
    const embedding = payload.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) {
        return null;
    }

    const values = embedding.map((value) => Number(value)).filter((value) => Number.isFinite(value));
    return values.length > 0 ? values : null;
}

async function searchUserMemories(params: {
    userId: string;
    botRouteId: string;
    query: string;
    limit?: number;
}): Promise<MemorySearchResult[]> {
    const embedding = await embedText(params.query);
    if (!embedding) {
        return [];
    }

    return prisma.$queryRawUnsafe<MemorySearchResult[]>(
        `SELECT id, content, memory_type, importance, embedding <=> $2::vector AS distance
         FROM user_memories
         WHERE user_id = $1
           AND embedding IS NOT NULL
         ORDER BY embedding <=> $2::vector
         LIMIT $3`,
        params.userId,
        toVectorLiteral(embedding),
        params.limit || readMemoryMaxResults(),
    );
}

async function saveExtractedMemory(params: {
    userId: string;
    botRouteId: string;
    conversationId: string;
    memory: ExtractedMemory;
}): Promise<void> {
    const embedding = await embedText(params.memory.content);
    if (!embedding) {
        return;
    }

    await prisma.$executeRawUnsafe(
        `INSERT INTO user_memories (user_id, bot_route_id, content, memory_type, importance, metadata, embedding)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::vector)`,
        params.userId,
        resolveMemoryBotRouteId(params.memory, params.botRouteId),
        params.memory.content,
        params.memory.memoryType,
        params.memory.importance,
        JSON.stringify({ conversationId: params.conversationId }),
        toVectorLiteral(embedding),
    );
}

async function extractMemoriesFromTurn(userMessage: string, assistantMessage: string): Promise<ExtractedMemory[]> {
    const rawText = await requestYunwuOpenAIChat({
        systemPrompt: [
            '你是长期记忆提取器。只提取未来对话中有用、非敏感、长期稳定的信息。',
            '不要保存手机号、密码、token、客户名单、订单号、身份证、银行卡、私密账号或一次性短期任务。',
            '只返回 JSON，不要解释。格式：{"memories":[{"content":"...","type":"preference|profile|business_context","importance":1-5}]}',
        ].join('\n'),
        messages: [{
            role: 'user',
            content: [
                '请从以下本轮对话中提取最多 3 条长期记忆。',
                '',
                `用户：${userMessage.slice(0, 3000)}`,
                '',
                `助手：${assistantMessage.slice(0, 3000)}`,
            ].join('\n'),
        }],
        temperature: 0,
        maxTokens: 800,
    });

    return parseExtractedMemories(rawText);
}

export async function buildLongTermMemoryPrompt(params: {
    userId: string;
    botRouteId: string;
    query: string;
}): Promise<string> {
    if (!isLongTermMemoryEnabled()) {
        return '';
    }

    try {
        const memories = await searchUserMemories({
            userId: params.userId,
            botRouteId: params.botRouteId,
            query: params.query,
        });
        return buildMemoryContextBlock(memories, readMemoryMaxResults());
    } catch (error) {
        console.error('[LongTermMemory] Failed to search memories', error);
        return '';
    }
}

export async function rememberConversationTurn(params: {
    userId: string;
    botRouteId: string;
    conversationId: string;
    userMessage: string;
    assistantMessage: string;
}): Promise<void> {
    if (!isMemoryWriteEnabled()) {
        return;
    }

    try {
        const memories = await extractMemoriesFromTurn(params.userMessage, params.assistantMessage);
        for (const memory of memories) {
            await saveExtractedMemory({
                userId: params.userId,
                botRouteId: params.botRouteId,
                conversationId: params.conversationId,
                memory,
            });
        }
    } catch (error) {
        console.error('[LongTermMemory] Failed to remember conversation turn', error);
    }
}
