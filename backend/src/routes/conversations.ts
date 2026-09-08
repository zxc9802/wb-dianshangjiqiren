import { usageFetch } from '../services/usage-fetch';
import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { AppError } from '../middleware/error';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { getSystemPromptBySortOrder, isPlaceholderPrompt } from '../utils/systemPrompts';

const router = Router();
router.use(authMiddleware);

function normalizeStreamUrl(rawUrl?: string): string {
    let url = (rawUrl || 'https://yunwu.ai/v1beta/models/gemini-3-flash-preview:streamGenerateContent').trim();
    url = url.replace(':generateContent', ':streamGenerateContent');
    if (!/[?&]alt=sse(?:&|$)/.test(url)) {
        url += url.includes('?') ? '&alt=sse' : '?alt=sse';
    }
    return url;
}

router.post('/', async (req: AuthRequest, res: Response) => {
    const { botId } = z.object({ botId: z.string().uuid() }).parse(req.body);

    const bot = await prisma.bot.findUnique({ where: { id: botId } });
    if (!bot) throw new AppError('Bot not found', 404);

    const conversation = await prisma.conversation.create({
        data: { userId: req.userId!, botId, title: `与${bot.name}的对话` },
        include: { bot: { select: { name: true, icon: true, category: true } } },
    });

    res.status(201).json({ success: true, data: conversation });
});

router.get('/', async (req: AuthRequest, res: Response) => {
    const { botId, favorited, page = '1', limit = '20' } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const where: { userId: string; botId?: string; isFavorited?: boolean } = { userId: req.userId! };
    if (typeof botId === 'string') where.botId = botId;
    if (favorited === 'true') where.isFavorited = true;

    const [conversations, total] = await Promise.all([
        prisma.conversation.findMany({
            where,
            include: {
                bot: { select: { name: true, icon: true, category: true } },
                messages: { take: 1, orderBy: { createdAt: 'desc' }, select: { content: true, createdAt: true } },
            },
            orderBy: { updatedAt: 'desc' },
            skip,
            take: Number(limit),
        }),
        prisma.conversation.count({ where }),
    ]);

    res.json({ success: true, data: { conversations, total, page: Number(page), limit: Number(limit) } });
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
    const id = String(req.params.id);
    const conversation = await prisma.conversation.findFirst({
        where: { id, userId: req.userId },
        include: {
            bot: { select: { id: true, name: true, icon: true, category: true, pointsPerUse: true } },
            messages: { orderBy: { createdAt: 'asc' }, include: { attachments: true } },
        },
    });

    if (!conversation) throw new AppError('Conversation not found', 404);
    res.json({ success: true, data: conversation });
});

router.post('/:id/messages', async (req: AuthRequest, res: Response) => {
    const conversationId = String(req.params.id);
    const { content, inputType } = z.object({
        content: z.string().min(1),
        inputType: z.enum(['text', 'voice', 'file']).default('text'),
    }).parse(req.body);

    const conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, userId: req.userId },
        include: { bot: true, messages: { orderBy: { createdAt: 'asc' } } },
    });

    if (!conversation) throw new AppError('Conversation not found', 404);
    if (!conversation.bot) throw new AppError('Bot not found', 404);

    await prisma.message.create({
        data: { conversationId, role: 'user', content, inputType },
    });

    const apiMessages = conversation.messages.map((message) => ({
        role: message.role,
        parts: [{ text: message.content }],
    }));
    apiMessages.push({ role: 'user', parts: [{ text: content }] });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    let fullResponse = '';

    try {
        const apiUrl = normalizeStreamUrl(process.env.AI_API_URL);
        const fallbackPrompt = `You are ${conversation.bot.name}. Provide structured, practical guidance.`;
        const systemPrompt = isPlaceholderPrompt(conversation.bot.systemPrompt)
            ? getSystemPromptBySortOrder(conversation.bot.sortOrder, fallbackPrompt)
            : conversation.bot.systemPrompt;

        const upstream = await usageFetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${process.env.AI_API_KEY}`,
            },
            body: JSON.stringify({
                contents: apiMessages,
                systemInstruction: { parts: [{ text: systemPrompt }] },
                generationConfig: { temperature: 0.8, topP: 0.95, maxOutputTokens: 8192 },
            }),
        });

        if (!upstream.ok || !upstream.body) {
            throw new Error(`AI API error: ${upstream.status}`);
        }

        const reader = (upstream.body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            for (const line of chunk.split('\n')) {
                if (!line.startsWith('data: ')) continue;
                const payload = line.slice(6).trim();
                if (!payload || payload === '[DONE]') continue;

                try {
                    const data = JSON.parse(payload) as {
                        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
                    };
                    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (!text) continue;
                    fullResponse += text;
                    res.write(`data: ${JSON.stringify({ type: 'text', content: text })}\n\n`);
                } catch {
                    continue;
                }
            }
        }

        let suggestions: string | null = null;
        const match = fullResponse.match(/```json\s*(\{"suggestions":\s*\[.*?\]\})\s*```/s);
        if (match) {
            suggestions = match[1];
            fullResponse = fullResponse.replace(match[0], '').trim();
        }

        await prisma.message.create({
            data: { conversationId, role: 'assistant', content: fullResponse, suggestions },
        });

        await prisma.conversation.update({
            where: { id: conversationId },
            data: { updatedAt: new Date() },
        });

        res.write(`data: ${JSON.stringify({ type: 'suggestions', content: suggestions })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        res.write(`data: ${JSON.stringify({ type: 'error', content: message })}\n\n`);
        res.end();
    }
});

router.patch('/:id/favorite', async (req: AuthRequest, res: Response) => {
    const id = String(req.params.id);
    const conversation = await prisma.conversation.findFirst({ where: { id, userId: req.userId } });
    if (!conversation) throw new AppError('Conversation not found', 404);

    const updated = await prisma.conversation.update({
        where: { id: conversation.id },
        data: { isFavorited: !conversation.isFavorited },
    });
    res.json({ success: true, data: { isFavorited: updated.isFavorited } });
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
    const id = String(req.params.id);
    const conversation = await prisma.conversation.findFirst({ where: { id, userId: req.userId } });
    if (!conversation) throw new AppError('Conversation not found', 404);

    await prisma.conversation.delete({ where: { id: conversation.id } });
    res.json({ success: true, message: 'Conversation deleted' });
});

export default router;
