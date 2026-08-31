import { NextRequest } from 'next/server';
import { errorResponse, getAuthUser } from '../../lib/auth';
import { BUILTIN_BOT_MAP, GENERIC_CHAT_BOT_ID } from '../../lib/builtin-bots';
import { buildPromptWithBuiltinKnowledge } from '../../lib/builtin-knowledge';
import {
    DEFAULT_RESPONSE_MODEL,
    DEFAULT_WEB_SEARCH_MODE,
    getOpenAIUpstreamModel,
    isResponseModel,
    isWebSearchMode,
    type ResponseModel,
    type WebSearchMode,
} from '../../lib/chat-models';
import { streamGeminiDeepThinkingChat } from '../../lib/gemini-deep-chat';
import { getSystemPromptByBotId } from '../../lib/server-bot-prompts';
import { readBackendUrl } from '../../lib/server-env';
import { streamYunwuGeminiChat } from '../../lib/yunwu-gemini-chat';
import { streamYunwuClaudeChat } from '../../lib/yunwu-claude-chat';
import { streamYunwuOpenAIChat, type OpenAIChatMessage } from '../../lib/yunwu-openai-chat';
import { enrichSystemPromptWithWebSearch } from '../../lib/web-search';
import { assertUserCanAccessOfficialBot } from '../../lib/server-bot-access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GLOBAL_RULES = `
# 全局规则
- 默认使用中文回答。
- 回答要直接、结构化、可执行。
- 不要编造不存在的事实或上下文。
`.trim();

const XHS_GLOBAL_RULES = `${GLOBAL_RULES}
- 小红书相关内容可以少量使用 emoji，但不要过度。`;

type ChatRequestMessage = {
    role: string;
    content: string;
};

function normalizeMessages(
    messages: unknown,
    conversationHistory: unknown,
    message: unknown,
): ChatRequestMessage[] {
    const rawMessages = Array.isArray(messages)
        ? messages
        : [
            ...(Array.isArray(conversationHistory) ? conversationHistory as ChatRequestMessage[] : []),
            ...(typeof message === 'string' && message.trim()
                ? [{ role: 'user', content: message }]
                : []),
        ];

    return rawMessages
        .filter((item): item is { role?: string; content?: string } => typeof item === 'object' && item !== null)
        .map((item) => ({
            role: item.role === 'assistant' ? 'assistant' : 'user',
            content: typeof item.content === 'string' ? item.content : '',
        }));
}

async function buildCustomBotPrompt(req: NextRequest, botId: string, fallbackPrompt: string): Promise<string> {
    const customId = botId.replace('custom-', '');
    const token = req.headers.get('x-auth-token') || '';

    try {
        const backendUrl = readBackendUrl();
        const botRes = await fetch(`${backendUrl}/api/custom-bots/${customId}`, {
            headers: { Authorization: `Bearer ${token}` },
        });

        if (!botRes.ok) {
            return `${fallbackPrompt}\n\n${GLOBAL_RULES}`.trim();
        }

        const botData = await botRes.json() as {
            data?: {
                systemPrompt?: string;
                documents?: Array<{ fileName: string; parsedText: string }>;
            };
        };
        const bot = botData.data;
        let prompt = bot?.systemPrompt || fallbackPrompt;

        if (Array.isArray(bot?.documents) && bot.documents.length > 0) {
            const knowledgeTexts = bot.documents
                .map((doc) => `### 文档：${doc.fileName}\n${doc.parsedText}`)
                .join('\n\n---\n\n');
            prompt += `\n\n# 知识参考\n以下内容来自用户上传文档，回答时优先参考：\n\n${knowledgeTexts}`;
        }

        return `${prompt}\n\n${GLOBAL_RULES}`.trim();
    } catch {
        return `${fallbackPrompt}\n\n${GLOBAL_RULES}`.trim();
    }
}

async function streamByResponseModel(
    responseModel: ResponseModel,
    webSearchMode: WebSearchMode,
    systemPrompt: string,
    messages: ChatRequestMessage[],
    onText: (text: string) => void,
): Promise<void> {
    const openAIMessages: OpenAIChatMessage[] = messages.map((item) => ({
        role: item.role === 'assistant' ? 'assistant' : 'user',
        content: item.content,
    }));
    const enriched = await enrichSystemPromptWithWebSearch({
        systemPrompt,
        messages: openAIMessages,
        webSearchMode,
    });
    const systemPromptWithWebSearch = enriched.systemPrompt;

    const openAIUpstreamModel = getOpenAIUpstreamModel(responseModel);
    if (openAIUpstreamModel) {
        await streamYunwuOpenAIChat({
            systemPrompt: systemPromptWithWebSearch,
            messages: openAIMessages,
            temperature: 1,
            model: openAIUpstreamModel,
            onText,
        });
        return;
    }

    if (responseModel === 'claude-opus-4.6') {
        await streamYunwuClaudeChat({
            systemPrompt: systemPromptWithWebSearch,
            messages: openAIMessages,
            webSearchMode: 'off',
            temperature: 1,
            onText,
        });
        return;
    }

    if (responseModel === 'gemini-deep-thinking') {
        await streamGeminiDeepThinkingChat({
            systemPrompt: systemPromptWithWebSearch,
            messages: openAIMessages.map((item) => ({
                role: item.role,
                content: typeof item.content === 'string' ? item.content : '',
            })),
            temperature: 1,
            topP: 1,
            onText,
        });
        return;
    }

    await streamYunwuGeminiChat({
        systemPrompt: systemPromptWithWebSearch,
        messages: openAIMessages.map((item) => ({
            role: item.role,
            content: typeof item.content === 'string' ? item.content : '',
        })),
        temperature: 1,
        topP: 1,
        onText,
    });
}

export async function POST(req: NextRequest) {
    try {
        const user = await getAuthUser(req);
        const body = await req.json() as {
            botId?: unknown;
            systemPrompt?: unknown;
            messages?: unknown;
            message?: unknown;
            conversationHistory?: unknown;
            wfContext?: unknown;
            responseModel?: unknown;
            webSearchMode?: unknown;
        };

        const botIdString = String(body.botId ?? '').trim();
        if (!botIdString.startsWith('custom-')) {
            const accessBotKey = botIdString || GENERIC_CHAT_BOT_ID;
            await assertUserCanAccessOfficialBot(user.id, accessBotKey, user.role);
        }
        const responseModel = isResponseModel(body.responseModel) ? body.responseModel : DEFAULT_RESPONSE_MODEL;
        const webSearchMode = isWebSearchMode(body.webSearchMode) ? body.webSearchMode : DEFAULT_WEB_SEARCH_MODE;
        const normalizedMessages = normalizeMessages(body.messages, body.conversationHistory, body.message);
        const builtinFallbackPrompt = BUILTIN_BOT_MAP[botIdString]?.systemPromptFallback;
        const fallbackPrompt = typeof body.systemPrompt === 'string' && body.systemPrompt.trim()
            ? body.systemPrompt.trim()
            : builtinFallbackPrompt || '你是一个专业的 AI 助手。';

        let fullSystemPrompt = '';

        if (botIdString.startsWith('custom-')) {
            fullSystemPrompt = await buildCustomBotPrompt(req, botIdString, fallbackPrompt);
        } else {
            const id = Number(botIdString);
            const isXhs = Number.isFinite(id) && id >= 15 && id <= 22;
            const basePrompt = getSystemPromptByBotId(botIdString, fallbackPrompt);
            const knowledgePrompt = buildPromptWithBuiltinKnowledge(botIdString, basePrompt, normalizedMessages);
            fullSystemPrompt = `${knowledgePrompt}\n\n${isXhs ? XHS_GLOBAL_RULES : GLOBAL_RULES}`.trim();
        }

        if (typeof body.wfContext === 'string' && body.wfContext.trim()) {
            fullSystemPrompt += `\n\n# 工作流上下文\n以下内容来自上一位机器人或上一步工作流输出，请作为补充背景参考：\n\n${body.wfContext.trim()}`;
        }

        const filteredMessages = normalizedMessages.filter((msg) => msg.content.trim().length > 0);
        if (filteredMessages.length === 0) {
            return new Response(JSON.stringify({ error: 'messages is required' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            async start(controller) {
                try {
                    await streamByResponseModel(responseModel, webSearchMode, fullSystemPrompt, filteredMessages, (text) => {
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'text', content: text })}\n\n`));
                    });

                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done' })}\n\n`));
                } catch (error) {
                    const messageText = error instanceof Error ? error.message : 'Stream error';
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', content: messageText })}\n\n`));
                } finally {
                    controller.close();
                }
            },
        });

        return new Response(stream, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                Connection: 'keep-alive',
                'Content-Encoding': 'none',
                'X-Accel-Buffering': 'no',
            },
        });
    } catch (error) {
        return errorResponse(error);
    }
}
