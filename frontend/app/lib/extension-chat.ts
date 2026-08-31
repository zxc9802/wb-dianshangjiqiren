import { prisma } from './prisma';
import { AppError } from './auth';
import { BUILTIN_BOT_MAP } from './builtin-bots';
import { buildPromptWithBuiltinKnowledge } from './builtin-knowledge';
import {
    DEFAULT_RESPONSE_MODEL,
    DEFAULT_WEB_SEARCH_MODE,
    getOpenAIUpstreamModel,
    type ResponseModel,
    type WebSearchMode,
} from './chat-models';
import { streamGeminiDeepThinkingChat } from './gemini-deep-chat';
import { getSystemPromptByBotId } from './server-bot-prompts';
import { streamYunwuGeminiChat } from './yunwu-gemini-chat';
import { streamYunwuClaudeChat } from './yunwu-claude-chat';
import { streamYunwuOpenAIChat, type OpenAIChatMessage } from './yunwu-openai-chat';
import { enrichSystemPromptWithWebSearch } from './web-search';
import type {
    ExtensionBot,
    ExtensionChatMessage,
    ExtensionChatMode,
    PageContext,
} from './extension-types';

const EXTENSION_CHAT_RULES = `
你正在浏览器插件里为用户服务。
- 回答必须使用中文。
- 优先基于当前网页上下文作答，必要时明确说明哪些信息来自网页上下文，哪些是你的推断。
- 输出直接、结构清晰、可执行，不要附加 JSON 建议按钮。
- 如果网页上下文不足以支持结论，要明确指出不足，而不是假装看到了不存在的信息。
`.trim();

function trimText(text: string, max: number): string {
    return text.trim().slice(0, max);
}

export function buildPageContextBlock(pageContext: PageContext): string {
    const sections: string[] = [
        `页面标题：${pageContext.title || '未识别'}`,
        `页面链接：${pageContext.url || '未识别'}`,
        `页面域名：${pageContext.domain || '未识别'}`,
    ];

    if (pageContext.selectedText) {
        sections.push(`用户当前选中文本：\n${trimText(pageContext.selectedText, 1200)}`);
    }

    if (pageContext.metaDescription) {
        sections.push(`页面简介：\n${trimText(pageContext.metaDescription, 1000)}`);
    }

    if (pageContext.hasVideo) {
        sections.push('页面包含视频：是');
        if (pageContext.videoTitle) {
            sections.push(`视频标题：${trimText(pageContext.videoTitle, 500)}`);
        }
        if (pageContext.videoDescription) {
            sections.push(`视频说明：\n${trimText(pageContext.videoDescription, 1600)}`);
        }
        if (pageContext.captionsText) {
            sections.push(
                `视频字幕（来源：${pageContext.transcriptSource}）：\n${trimText(pageContext.captionsText, 3500)}`,
            );
        }
    }

    if (pageContext.mainText) {
        sections.push(`页面正文：\n${trimText(pageContext.mainText, 5000)}`);
    }

    return sections.join('\n\n');
}

export async function resolveExtensionBot(
    userId: string,
    botId: string,
    messages: ExtensionChatMessage[] = [],
): Promise<{
    bot: ExtensionBot;
    systemPrompt: string;
}> {
    if (botId.startsWith('custom-')) {
        const customBotId = botId.slice('custom-'.length);
        const customBot = await prisma.customBot.findFirst({
            where: {
                id: customBotId,
                userId,
                isActive: true,
            },
            include: {
                documents: {
                    select: {
                        fileName: true,
                        parsedText: true,
                    },
                },
            },
        });

        if (!customBot) {
            throw new AppError('智能体不存在或已删除', 404);
        }

        let systemPrompt = customBot.systemPrompt.trim();

        if (customBot.documents.length > 0) {
            const knowledgeBlock = customBot.documents
                .map((doc) => `### 文档：${doc.fileName}\n${trimText(doc.parsedText, 6000)}`)
                .join('\n\n---\n\n');
            systemPrompt += `\n\n# 参考资料\n以下内容来自用户上传文档，请优先基于这些资料回答：\n\n${knowledgeBlock}`;
        }

        return {
            bot: {
                botId,
                kind: 'custom',
                name: customBot.name,
                description: customBot.description,
                icon: customBot.avatar || customBot.icon || 'bot',
                category: '我的智能体',
                pointsPerUse: customBot.pointsPerUse,
            },
            systemPrompt: `${systemPrompt}\n\n${EXTENSION_CHAT_RULES}`.trim(),
        };
    }

    const builtin = BUILTIN_BOT_MAP[botId];
    if (!builtin) {
        throw new AppError('预设机器人不存在', 404);
    }

    const basePrompt = getSystemPromptByBotId(
        botId,
        builtin.systemPromptFallback || `你是${builtin.name}，请给出专业、结构化、可执行的建议。`,
    );
    const prompt = buildPromptWithBuiltinKnowledge(botId, basePrompt, messages);

    return {
        bot: {
            botId,
            kind: 'builtin',
            name: builtin.name,
            description: builtin.description,
            icon: builtin.icon,
            category: builtin.category,
            pointsPerUse: builtin.pointsPerUse,
        },
        systemPrompt: `${prompt}\n\n${EXTENSION_CHAT_RULES}`.trim(),
    };
}

export function buildExtensionContents(
    mode: ExtensionChatMode,
    messages: ExtensionChatMessage[],
    pageContext?: PageContext,
): OpenAIChatMessage[] {
    if (mode === 'summary') {
        if (!pageContext) {
            throw new AppError('summary 模式缺少 pageContext');
        }

        const contextBlock = buildPageContextBlock(pageContext);
        return [{
            role: 'user',
            content: `请总结当前页面内容。\n\n要求：\n1. 先用一句话说明页面主题。\n2. 再输出 3-5 条要点。\n3. 如果页面包含视频，要单独说明视频讲了什么，以及字幕是否充分。\n4. 如果信息不足，要明确指出。\n\n网页上下文：\n${contextBlock}`,
        }];
    }

    const sanitizedMessages: OpenAIChatMessage[] = messages
        .filter((message) => message.content.trim().length > 0)
        .map((message) => ({
            role: message.role === 'assistant' ? 'assistant' : 'user',
            content: message.content.trim(),
        }));

    if (sanitizedMessages.length === 0) {
        throw new AppError('messages 不能为空');
    }

    if (!pageContext) {
        return sanitizedMessages;
    }

    const contextBlock = buildPageContextBlock(pageContext);
    const firstUserIndex = sanitizedMessages.findIndex((message) => message.role === 'user');

    if (firstUserIndex === -1) {
        return [{
            role: 'user',
            content: `以下是当前网页上下文：\n${contextBlock}`,
        }, ...sanitizedMessages];
    }

    const nextMessages = [...sanitizedMessages];
    const firstUser = nextMessages[firstUserIndex];
    nextMessages[firstUserIndex] = {
        ...firstUser,
        content: `以下是当前网页上下文，请基于这些内容回答后续问题：\n${contextBlock}\n\n用户问题：\n${typeof firstUser.content === 'string' ? firstUser.content : ''}`,
    };
    return nextMessages;
}

export async function streamExtensionCompletion(
    systemPrompt: string,
    contents: OpenAIChatMessage[],
    onText: (text: string) => void,
    responseModel: ResponseModel = DEFAULT_RESPONSE_MODEL,
    webSearchMode: WebSearchMode = DEFAULT_WEB_SEARCH_MODE,
): Promise<void> {
    const enriched = await enrichSystemPromptWithWebSearch({
        systemPrompt,
        messages: contents,
        webSearchMode,
    });
    const systemPromptWithWebSearch = enriched.systemPrompt;

    const openAIUpstreamModel = getOpenAIUpstreamModel(responseModel);
    if (openAIUpstreamModel) {
        await streamYunwuOpenAIChat({
            systemPrompt: systemPromptWithWebSearch,
            messages: contents,
            temperature: 0.8,
            model: openAIUpstreamModel,
            onText,
        });
        return;
    }

    if (responseModel === 'claude-opus-4.6') {
        await streamYunwuClaudeChat({
            systemPrompt: systemPromptWithWebSearch,
            messages: contents,
            webSearchMode: 'off',
            temperature: 0.8,
            onText,
        });
        return;
    }

    if (responseModel === 'gemini-deep-thinking') {
        await streamGeminiDeepThinkingChat({
            systemPrompt: systemPromptWithWebSearch,
            messages: contents.map((message) => ({
                role: message.role,
                content: typeof message.content === 'string' ? message.content : '',
            })),
            temperature: 0.8,
            topP: 0.95,
            onText,
        });
        return;
    }

    await streamYunwuGeminiChat({
        systemPrompt: systemPromptWithWebSearch,
        messages: contents.map((message) => ({
            role: message.role,
            content: typeof message.content === 'string' ? message.content : '',
        })),
        temperature: 0.8,
        topP: 0.95,
        onText,
    });
}
