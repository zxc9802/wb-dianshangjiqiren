import { AppError } from './auth';
import type { BotAccessSummary } from './bot-access';
import { isOfficialBotKey } from './bot-access-catalog';
import { isKbChatRoleKey, type KbChatRoleAccessSummary } from './kb-chat-roles';
import { prisma } from './prisma';

export interface AdminMemberInfo {
    id: string;
    account: string;
    nickname: string;
    groupName: string;
    botAccess: BotAccessSummary;
    kbChatRoles: KbChatRoleAccessSummary;
}

export async function listAdminMembers(): Promise<AdminMemberInfo[]> {
    const members = await prisma.user.findMany({
        where: { role: { not: 'admin' } },
        select: {
            id: true,
            email: true,
            nickname: true,
            groupName: true,
            botAccessPolicy: {
                select: {
                    permissions: {
                        select: { botKey: true },
                        orderBy: { createdAt: 'asc' },
                    },
                },
            },
            kbChatRolePolicy: {
                select: {
                    permissions: {
                        select: { roleKey: true },
                        orderBy: { createdAt: 'asc' },
                    },
                },
            },
        },
        orderBy: [{ createdAt: 'asc' }, { email: 'asc' }],
    });

    return members.map((member) => ({
        id: member.id,
        account: member.email,
        nickname: member.nickname,
        groupName: member.groupName,
        botAccess: member.botAccessPolicy
            ? { mode: 'selected' as const, botKeys: member.botAccessPolicy.permissions.map((item) => item.botKey) }
            : { mode: 'all' as const, botKeys: [] },
        kbChatRoles: member.kbChatRolePolicy
            ? { mode: 'selected' as const, roleKeys: member.kbChatRolePolicy.permissions.map((item) => item.roleKey) }
            : { mode: 'all' as const, roleKeys: [] },
    }));
}

export async function replaceMemberBotAccess(userId: string, botKeys: string[]): Promise<BotAccessSummary> {
    const normalizedBotKeys = [...new Set(botKeys)];
    if (normalizedBotKeys.some((botKey) => !isOfficialBotKey(botKey))) {
        throw new AppError('Unknown official bot.', 400, 'INVALID_BOT_KEY');
    }

    await prisma.$transaction(async (tx) => {
        const user = await tx.user.findUnique({
            where: { id: userId },
            select: { role: true },
        });
        if (!user) {
            throw new AppError('Member not found.', 404, 'MEMBER_NOT_FOUND');
        }
        if (user.role === 'admin') {
            throw new AppError('Administrator access cannot be restricted.', 400, 'ADMIN_ACCESS_IMMUTABLE');
        }

        const policy = await tx.userBotAccessPolicy.upsert({
            where: { userId },
            update: {},
            create: { userId },
            select: { id: true },
        });
        await tx.userBotPermission.deleteMany({ where: { policyId: policy.id } });
        if (normalizedBotKeys.length > 0) {
            await tx.userBotPermission.createMany({
                data: normalizedBotKeys.map((botKey) => ({ policyId: policy.id, botKey })),
            });
        }
    });

    return { mode: 'selected', botKeys: normalizedBotKeys };
}

export async function resetMemberBotAccess(userId: string): Promise<BotAccessSummary> {
    await prisma.$transaction(async (tx) => {
        const user = await tx.user.findUnique({
            where: { id: userId },
            select: { role: true },
        });
        if (!user) {
            throw new AppError('Member not found.', 404, 'MEMBER_NOT_FOUND');
        }
        if (user.role === 'admin') {
            throw new AppError('Administrator access cannot be restricted.', 400, 'ADMIN_ACCESS_IMMUTABLE');
        }
        await tx.userBotAccessPolicy.deleteMany({ where: { userId } });
    });

    return { mode: 'all', botKeys: [] };
}

export async function replaceMemberKbChatRoles(userId: string, roleKeys: string[]): Promise<KbChatRoleAccessSummary> {
    const normalizedRoleKeys = [...new Set(roleKeys)];
    if (normalizedRoleKeys.some((roleKey) => !isKbChatRoleKey(roleKey))) {
        throw new AppError('Unknown knowledge-base role.', 400, 'INVALID_KB_CHAT_ROLE');
    }

    await prisma.$transaction(async (tx) => {
        const user = await tx.user.findUnique({
            where: { id: userId },
            select: { role: true },
        });
        if (!user) {
            throw new AppError('Member not found.', 404, 'MEMBER_NOT_FOUND');
        }
        if (user.role === 'admin') {
            throw new AppError('Administrator access cannot be restricted.', 400, 'ADMIN_ACCESS_IMMUTABLE');
        }

        const policy = await tx.userKbChatRolePolicy.upsert({
            where: { userId },
            update: {},
            create: { userId },
            select: { id: true },
        });
        await tx.userKbChatRole.deleteMany({ where: { policyId: policy.id } });
        if (normalizedRoleKeys.length > 0) {
            await tx.userKbChatRole.createMany({
                data: normalizedRoleKeys.map((roleKey) => ({ policyId: policy.id, roleKey })),
            });
        }
    });

    return { mode: 'selected', roleKeys: normalizedRoleKeys };
}

export async function resetMemberKbChatRoles(userId: string): Promise<KbChatRoleAccessSummary> {
    await prisma.$transaction(async (tx) => {
        const user = await tx.user.findUnique({
            where: { id: userId },
            select: { role: true },
        });
        if (!user) {
            throw new AppError('Member not found.', 404, 'MEMBER_NOT_FOUND');
        }
        if (user.role === 'admin') {
            throw new AppError('Administrator access cannot be restricted.', 400, 'ADMIN_ACCESS_IMMUTABLE');
        }
        await tx.userKbChatRolePolicy.deleteMany({ where: { userId } });
    });

    return { mode: 'all', roleKeys: [] };
}
