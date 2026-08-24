import { AppError } from './auth';
import { canAccessOfficialBot, type BotAccessSummary } from './bot-access';
import { isOfficialBotKey } from './bot-access-catalog';
import { prisma } from './prisma';

type BotAccessPolicyClient = {
    userBotAccessPolicy: {
        upsert: (args: {
            where: { userId: string };
            update: Record<string, never>;
            create: { userId: string };
        }) => Promise<unknown>;
    };
};

export async function ensureEmptyBotAccessPolicy(client: BotAccessPolicyClient, userId: string): Promise<void> {
    await client.userBotAccessPolicy.upsert({
        where: { userId },
        update: {},
        create: { userId },
    });
}

export async function getUserBotAccessSummary(userId: string, role?: string): Promise<BotAccessSummary> {
    if (role === 'admin') return { mode: 'all', botKeys: [] };

    const resolvedRole = role || (await prisma.user.findUnique({
        where: { id: userId },
        select: { role: true },
    }))?.role;
    if (resolvedRole === 'admin') return { mode: 'all', botKeys: [] };

    const policy = await prisma.userBotAccessPolicy.findUnique({
        where: { userId },
        select: { permissions: { select: { botKey: true }, orderBy: { createdAt: 'asc' } } },
    });
    if (!policy) return { mode: 'all', botKeys: [] };
    return { mode: 'selected', botKeys: policy.permissions.map((item) => item.botKey) };
}

export async function assertUserCanAccessOfficialBot(userId: string, botKey: string, role?: string): Promise<void> {
    if (!isOfficialBotKey(botKey)) {
        throw new AppError('Unknown official bot.', 400, 'INVALID_BOT_KEY');
    }
    const summary = await getUserBotAccessSummary(userId, role);
    if (!canAccessOfficialBot(summary, botKey)) {
        throw new AppError('管理员未向该账号开放此智能体。', 403, 'BOT_ACCESS_DENIED');
    }
}

export async function assertConversationBotAccess(
    userId: string,
    bot: { kind: 'builtin' | 'custom'; routeId: string },
): Promise<void> {
    if (bot.kind === 'custom') return;
    await assertUserCanAccessOfficialBot(userId, bot.routeId);
}
