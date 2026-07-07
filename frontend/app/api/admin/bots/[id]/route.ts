import { NextRequest } from 'next/server';
import { prisma } from '../../../../lib/prisma';
import { AppError, errorResponse, getAuthUser } from '../../../../lib/auth';
import { isQiyaEnterpriseManagementRouteId } from '../../../../lib/qiya-knowledge-visibility';

async function findPresetBot(idOrRouteId: string) {
    // Try UUID lookup first
    let bot = await prisma.bot.findUnique({ where: { id: idOrRouteId } });
    if (bot) return bot;
    // Try slug lookup
    bot = await prisma.bot.findUnique({ where: { slug: idOrRouteId } });
    if (bot) return bot;
    // Try sortOrder lookup (routeId from the chat page URL is String(sortOrder))
    const sortOrder = Number(idOrRouteId);
    if (!isNaN(sortOrder)) {
        bot = await prisma.bot.findFirst({ where: { sortOrder } });
    }
    return bot;
}

async function getPresetBotUploadedDocs(botId: string) {
    return prisma.presetBotDocument.findMany({
        where: { botId },
        select: { id: true, fileName: true, fileType: true, fileSize: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
    });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        await getAuthUser(req, { requireAdmin: true });
        const { id } = await params;

        const { searchParams } = new URL(req.url);
        const kind = searchParams.get('kind') || 'builtin';

        if (kind === 'custom') {
            const realId = id.startsWith('custom-') ? id.slice(7) : id;
            const bot = await prisma.customBot.findUnique({
                where: { id: realId },
                include: {
                    documents: {
                        select: { id: true, fileName: true, fileType: true, fileSize: true, createdAt: true },
                        orderBy: { createdAt: 'desc' },
                    },
                },
            });
            if (!bot) throw new AppError('智能体不存在', 404);
            return Response.json({
                success: true,
                data: {
                    id: bot.id,
                    name: bot.name,
                    kind: 'custom',
                    systemPrompt: bot.systemPrompt,
                    description: bot.description,
                    icon: bot.icon,
                    documents: bot.documents,
                },
            });
        }

        const bot = await findPresetBot(id);
        if (!bot) throw new AppError('智能体不存在', 404);

        const documents = isQiyaEnterpriseManagementRouteId(String(bot.sortOrder))
            ? []
            : await getPresetBotUploadedDocs(bot.id);

        return Response.json({
            success: true,
            data: {
                id: bot.id,
                name: bot.name,
                kind: 'builtin',
                systemPrompt: bot.systemPrompt,
                description: bot.description,
                icon: bot.icon,
                category: bot.category,
                documents,
            },
        });
    } catch (error) {
        return errorResponse(error);
    }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        await getAuthUser(req, { requireAdmin: true });
        const { id } = await params;
        const body = await req.json();

        const { searchParams } = new URL(req.url);
        const kind = searchParams.get('kind') || 'builtin';

        if (kind === 'custom') {
            const realId = id.startsWith('custom-') ? id.slice(7) : id;
            const bot = await prisma.customBot.findUnique({ where: { id: realId } });
            if (!bot) throw new AppError('智能体不存在', 404);

            const updated = await prisma.customBot.update({
                where: { id: realId },
                data: {
                    ...(typeof body.systemPrompt === 'string' ? { systemPrompt: body.systemPrompt } : {}),
                    ...(typeof body.description === 'string' ? { description: body.description } : {}),
                    ...(typeof body.name === 'string' ? { name: body.name } : {}),
                },
            });

            return Response.json({ success: true, data: { id: updated.id } });
        }

        const bot = await findPresetBot(id);
        if (!bot) throw new AppError('智能体不存在', 404);

        const updated = await prisma.bot.update({
            where: { id: bot.id },
            data: {
                ...(typeof body.systemPrompt === 'string' ? { systemPrompt: body.systemPrompt } : {}),
                ...(typeof body.description === 'string' ? { description: body.description } : {}),
                ...(typeof body.name === 'string' ? { name: body.name } : {}),
            },
        });

        return Response.json({ success: true, data: { id: updated.id } });
    } catch (error) {
        return errorResponse(error);
    }
}
