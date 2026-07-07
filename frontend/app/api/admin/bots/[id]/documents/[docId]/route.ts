import { NextRequest } from 'next/server';
import { prisma } from '../../../../../../lib/prisma';
import { AppError, errorResponse, getAuthUser } from '../../../../../../lib/auth';
import { isQiyaEnterpriseManagementRouteId } from '../../../../../../lib/qiya-knowledge-visibility';

async function resolvePresetBot(idOrRouteId: string) {
    let bot = await prisma.bot.findUnique({ where: { id: idOrRouteId } });
    if (bot) return bot;
    bot = await prisma.bot.findUnique({ where: { slug: idOrRouteId } });
    if (bot) return bot;
    const sortOrder = Number(idOrRouteId);
    if (!Number.isNaN(sortOrder)) {
        bot = await prisma.bot.findFirst({ where: { sortOrder } });
    }
    return bot;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; docId: string }> }) {
    try {
        await getAuthUser(req, { requireAdmin: true });
        const { id, docId } = await params;

        const { searchParams } = new URL(req.url);
        const kind = searchParams.get('kind') || 'builtin';

        let doc: { id: string; fileName: string; fileType: string; fileSize: number; parsedText: string; createdAt: Date } | null = null;

        if (kind === 'custom') {
            const botId = id.startsWith('custom-') ? id.slice(7) : id;
            doc = await prisma.botDocument.findFirst({
                where: { id: docId, customBotId: botId },
                select: { id: true, fileName: true, fileType: true, fileSize: true, parsedText: true, createdAt: true },
            });
        } else {
            const bot = await resolvePresetBot(id);
            if (!bot) throw new AppError('智能体不存在', 404);
            if (isQiyaEnterpriseManagementRouteId(String(bot.sortOrder))) {
                throw new AppError('文档不存在', 404);
            }

            doc = await prisma.presetBotDocument.findFirst({
                where: { id: docId, botId: bot.id },
                select: { id: true, fileName: true, fileType: true, fileSize: true, parsedText: true, createdAt: true },
            });
        }

        if (!doc) throw new AppError('文档不存在', 404);
        return Response.json({ success: true, data: doc });
    } catch (error) {
        return errorResponse(error);
    }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string; docId: string }> }) {
    try {
        await getAuthUser(req, { requireAdmin: true });
        const { id, docId } = await params;
        const body = await req.json();

        const { searchParams } = new URL(req.url);
        const kind = searchParams.get('kind') || 'builtin';

        const updateData: Record<string, string | number> = {};
        if (typeof body.parsedText === 'string') updateData.parsedText = body.parsedText;
        if (typeof body.fileName === 'string') updateData.fileName = body.fileName;

        if (Object.keys(updateData).length === 0) {
            throw new AppError('No fields to update', 400);
        }

        let updated: { id: string; fileName: string; fileType: string; fileSize: number; createdAt: Date } | null = null;

        if (kind === 'custom') {
            const botId = id.startsWith('custom-') ? id.slice(7) : id;
            const doc = await prisma.botDocument.findFirst({ where: { id: docId, customBotId: botId } });
            if (!doc) throw new AppError('文档不存在', 404);
            updated = await prisma.botDocument.update({ where: { id: docId }, data: updateData });
        } else {
            const bot = await resolvePresetBot(id);
            if (!bot) throw new AppError('智能体不存在', 404);
            if (isQiyaEnterpriseManagementRouteId(String(bot.sortOrder))) {
                throw new AppError('文档不存在', 404);
            }

            const doc = await prisma.presetBotDocument.findFirst({ where: { id: docId, botId: bot.id } });
            if (!doc) throw new AppError('文档不存在', 404);
            updated = await prisma.presetBotDocument.update({ where: { id: docId }, data: updateData });
        }

        return Response.json({
            success: true,
            data: { id: updated.id, fileName: updated.fileName, fileType: updated.fileType, fileSize: updated.fileSize, createdAt: updated.createdAt },
        });
    } catch (error) {
        return errorResponse(error);
    }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string; docId: string }> }) {
    try {
        await getAuthUser(req, { requireAdmin: true });
        const { id, docId } = await params;

        const { searchParams } = new URL(req.url);
        const kind = searchParams.get('kind') || 'builtin';

        if (kind === 'custom') {
            const botId = id.startsWith('custom-') ? id.slice(7) : id;
            const doc = await prisma.botDocument.findFirst({
                where: { id: docId, customBotId: botId },
            });
            if (!doc) throw new AppError('文档不存在', 404);
            await prisma.botDocument.delete({ where: { id: docId } });
        } else {
            const bot = await resolvePresetBot(id);
            if (!bot) throw new AppError('智能体不存在', 404);
            if (isQiyaEnterpriseManagementRouteId(String(bot.sortOrder))) {
                throw new AppError('文档不存在', 404);
            }

            const doc = await prisma.presetBotDocument.findFirst({
                where: { id: docId, botId: bot.id },
            });
            if (!doc) throw new AppError('文档不存在', 404);
            await prisma.presetBotDocument.delete({ where: { id: docId } });
        }

        return Response.json({ success: true });
    } catch (error) {
        return errorResponse(error);
    }
}
