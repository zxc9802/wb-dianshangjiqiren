import { withUsage } from '@/app/lib/usage-context';
import { NextRequest } from 'next/server';
import { errorResponse, getAuthUser } from '../../../lib/auth';
import { streamYunwuGeminiChat } from '../../../lib/yunwu-gemini-chat';
import { prisma } from '../../../lib/prisma';

const CREATE_SYSTEM = `你是一个专业的 AI 提示词工程师。用户会告诉你他想创建什么样的 AI 机器人（角色、能力、风格等），你的任务是帮用户写出一份高质量、结构清晰的系统提示词（System Prompt）。

要求：
1. 直接输出提示词内容，不要加任何解释或前言
2. 使用 Markdown 格式组织结构（用 # 标题分段）
3. 提示词应包含：角色定义、核心能力、回答风格、约束规则等
4. 语言要精准、专业，避免模糊表述
5. 根据用户描述的场景，加入具体的行为指令
6. 如果用户描述简单，你要合理扩展和补充细节
7. 输出语言与用户输入语言保持一致
8. 参考下方提供的现有提示词示例，学习它们的结构、风格和细节程度，生成同等质量的提示词`;

const SUPPLEMENT_SYSTEM = `你是一个专业的 AI 提示词工程师。用户有一个现有的系统提示词，需要你根据用户的描述，写一段补充内容来扩展现有提示词的能力。

要求：
1. 只输出需要补充的那一段提示词内容，不要重写整个提示词
2. 不要加任何解释、前言或总结
3. 输出的内容应该可以直接追加到现有提示词末尾
4. 保持与现有提示词一致的风格和格式
5. 使用 Markdown 格式（# 标题 + 具体内容）
6. 语言要精准、专业
7. 输出语言与用户输入语言保持一致`;

async function getExistingPrompts(): Promise<string> {
    const [presetBots, customBots] = await Promise.all([
        prisma.bot.findMany({
            where: { systemPrompt: { not: '' } },
            select: { name: true, systemPrompt: true },
            take: 10,
        }),
        prisma.customBot.findMany({
            where: { systemPrompt: { not: '' } },
            select: { name: true, systemPrompt: true },
            take: 5,
        }),
    ]);

    const all = [...presetBots, ...customBots].filter((b) => b.systemPrompt.length > 50);
    if (all.length === 0) return '';

    const examples = all.map((b, i) => {
        const preview = b.systemPrompt.length > 2000 ? b.systemPrompt.slice(0, 2000) + '\n...(省略)' : b.systemPrompt;
        return `### 示例 ${i + 1}: ${b.name}\n\`\`\`\n${preview}\n\`\`\``;
    }).join('\n\n');

    return `\n\n以下是系统中现有机器人的提示词示例，请参考它们的结构和风格：\n\n${examples}`;
}

async function handlePost(req: NextRequest) {
    try {
        await getAuthUser(req, { requireAdmin: true });

        const { userInput, currentPrompt, mode = 'create' } = await req.json() as {
            userInput: string;
            currentPrompt?: string;
            mode?: 'create' | 'supplement';
        };
        if (!userInput?.trim()) {
            return Response.json({ error: '请输入你的想法' }, { status: 400 });
        }

        let systemPrompt: string;
        const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

        if (mode === 'supplement') {
            systemPrompt = SUPPLEMENT_SYSTEM;
            messages.push({
                role: 'user',
                content: `以下是当前机器人的系统提示词：\n\n---\n${currentPrompt || '（暂无提示词）'}\n---\n\n请根据以下描述，写一段补充提示词：${userInput}`,
            });
        } else {
            const existingExamples = await getExistingPrompts();
            systemPrompt = CREATE_SYSTEM + existingExamples;
            messages.push({
                role: 'user',
                content: `请帮我从零开始写一个完整的系统提示词。我的想法是：${userInput}`,
            });
        }

        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            async start(controller) {
                try {
                    await streamYunwuGeminiChat({
                        systemPrompt,
                        messages,
                        temperature: 0.7,
                        maxOutputTokens: 4096,
                        onText(text) {
                            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
                        },
                    });
                    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                    controller.close();
                } catch (err) {
                    const msg = err instanceof Error ? err.message : '生成失败';
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`));
                    controller.close();
                }
            },
        });

        return new Response(stream, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
            },
        });
    } catch (err) {
        return errorResponse(err);
    }
}

export const POST = withUsage(handlePost);
