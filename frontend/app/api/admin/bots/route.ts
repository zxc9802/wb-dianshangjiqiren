import { NextRequest } from 'next/server';
import { prisma } from '../../../lib/prisma';
import { errorResponse, getAuthUser } from '../../../lib/auth';

export async function GET(req: NextRequest) {
    try {
        await getAuthUser(req, { requireAdmin: true });

        const { searchParams } = new URL(req.url);
        const type = searchParams.get('type'); // 'preset' | 'custom' | null (all)

        const results: Array<{
            id: string;
            name: string;
            kind: 'builtin' | 'custom';
            category: string;
            icon: string;
            description: string;
            documentCount: number;
        }> = [];

        if (type !== 'custom') {
            const presetBots = await prisma.bot.findMany({
                orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
                select: {
                    id: true,
                    name: true,
                    category: true,
                    icon: true,
                    description: true,
                    _count: { select: { documents: true } },
                },
            });

            for (const bot of presetBots) {
                results.push({
                    id: bot.id,
                    name: bot.name,
                    kind: 'builtin',
                    category: bot.category,
                    icon: bot.icon,
                    description: bot.description,
                    documentCount: bot._count.documents,
                });
            }
        }

        if (type !== 'preset') {
            const customBots = await prisma.customBot.findMany({
                orderBy: [{ createdAt: 'desc' }],
                select: {
                    id: true,
                    name: true,
                    icon: true,
                    description: true,
                    _count: { select: { documents: true } },
                    user: { select: { nickname: true, email: true } },
                },
            });

            for (const bot of customBots) {
                results.push({
                    id: bot.id,
                    name: `${bot.name} (${bot.user.email})`,
                    kind: 'custom',
                    category: '自建',
                    icon: bot.icon,
                    description: bot.description,
                    documentCount: bot._count.documents,
                });
            }
        }

        return Response.json({ success: true, data: results });
    } catch (error) {
        return errorResponse(error);
    }
}
