import { NextRequest } from 'next/server';
import { prisma } from '../../../../../lib/prisma';
import { AppError, errorResponse, getAuthUser } from '../../../../../lib/auth';
import { isQiyaEnterpriseManagementRouteId } from '../../../../../lib/qiya-knowledge-visibility';

async function resolvePresetBot(idOrRouteId: string) {
    let bot = await prisma.bot.findUnique({ where: { id: idOrRouteId } });
    if (bot) return bot;
    bot = await prisma.bot.findUnique({ where: { slug: idOrRouteId } });
    if (bot) return bot;
    const sortOrder = Number(idOrRouteId);
    if (!isNaN(sortOrder)) {
        bot = await prisma.bot.findFirst({ where: { sortOrder } });
    }
    return bot;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        await getAuthUser(req, { requireAdmin: true });
        const { id } = await params;

        const { searchParams } = new URL(req.url);
        const kind = searchParams.get('kind') || 'builtin';

        let documents: Array<{ id: string; fileName: string; fileType: string; fileSize: number; createdAt: Date }> = [];

        if (kind === 'custom') {
            const botId = id.startsWith('custom-') ? id.slice(7) : id;
            documents = await prisma.botDocument.findMany({
                where: { customBotId: botId },
                select: { id: true, fileName: true, fileType: true, fileSize: true, createdAt: true },
                orderBy: { createdAt: 'desc' },
            });
        } else {
            const bot = await resolvePresetBot(id);
            if (!bot) throw new AppError('智能体不存在', 404);
            if (isQiyaEnterpriseManagementRouteId(String(bot.sortOrder))) {
                return Response.json({ success: true, data: [] });
            }

            documents = await prisma.presetBotDocument.findMany({
                where: { botId: bot.id },
                select: { id: true, fileName: true, fileType: true, fileSize: true, createdAt: true },
                orderBy: { createdAt: 'desc' },
            });
        }

        return Response.json({ success: true, data: documents });
    } catch (error) {
        return errorResponse(error);
    }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        await getAuthUser(req, { requireAdmin: true });
        const { id } = await params;
        const body = await req.json();

        const { searchParams } = new URL(req.url);
        const kind = searchParams.get('kind') || 'builtin';

        const fileName = body.fileName as string;
        const fileType = body.fileType as string;
        const fileSize = body.fileSize as number;
        const parsedText = body.parsedText as string;

        if (!fileName || !parsedText) {
            throw new AppError('fileName and parsedText are required', 400);
        }

        if (kind === 'custom') {
            const botId = id.startsWith('custom-') ? id.slice(7) : id;
            const doc = await prisma.botDocument.create({
                data: { customBotId: botId, fileName, fileType: fileType || 'txt', fileSize: fileSize || 0, parsedText },
            });
            return Response.json({ success: true, data: { id: doc.id, fileName: doc.fileName, fileType: doc.fileType, fileSize: doc.fileSize, createdAt: doc.createdAt } });
        }

        const bot = await resolvePresetBot(id);
        if (!bot) throw new AppError('智能体不存在', 404);
        if (isQiyaEnterpriseManagementRouteId(String(bot.sortOrder))) {
            throw new AppError('文档不存在', 404);
        }

        const doc = await prisma.presetBotDocument.create({
            data: {
                botId: bot.id,
                fileName,
                fileType: fileType || 'txt',
                fileSize: fileSize || parsedText.length,
                parsedText,
            },
        });

        return Response.json({
            success: true,
            data: {
                id: doc.id,
                fileName: doc.fileName,
                fileType: doc.fileType,
                fileSize: doc.fileSize,
                createdAt: doc.createdAt,
            },
        });
    } catch (error) {
        return errorResponse(error);
    }
}
