import { AppError } from './auth';
import type { BotAccessSummary } from './bot-access';
import { isOfficialBotKey } from './bot-access-catalog';
import { isKbChatRoleKey, type KbChatRoleAccessSummary } from './kb-chat-roles';
import { prisma } from './prisma';

const MEMBER_DELETE_TRANSACTION_OPTIONS = {
    maxWait: 10_000,
    timeout: 20_000,
} as const;

export interface AdminMemberInfo {
    id: string;
    account: string;
    nickname: string;
    groupName: string;
    isActive: boolean;
    botAccess: BotAccessSummary;
    kbChatRoles: KbChatRoleAccessSummary;
}

async function loadNonAdminMember(tx: any, userId: string) {
    const user = await tx.user.findUnique({
        where: { id: userId },
        select: { role: true, isActive: true },
    });
    if (!user) {
        throw new AppError('Member not found.', 404, 'MEMBER_NOT_FOUND');
    }
    if (user.role === 'admin') {
        throw new AppError('Administrator access cannot be restricted.', 400, 'ADMIN_ACCESS_IMMUTABLE');
    }
    return user;
}

async function requireConfigurableMember(tx: any, userId: string) {
    const user = await loadNonAdminMember(tx, userId);
    if (user.isActive === false) {
        throw new AppError('停用账号不能设置权限。', 400, 'MEMBER_ACCOUNT_INACTIVE');
    }
    return user;
}

export async function listAdminMembers(): Promise<AdminMemberInfo[]> {
    const members = await prisma.user.findMany({
        where: { role: { not: 'admin' } },
        select: {
            id: true,
            email: true,
            nickname: true,
            groupName: true,
            isActive: true,
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
        isActive: member.isActive !== false,
        botAccess: member.botAccessPolicy
            ? { mode: 'selected' as const, botKeys: member.botAccessPolicy.permissions.map((item) => item.botKey) }
            : { mode: 'all' as const, botKeys: [] },
        kbChatRoles: member.kbChatRolePolicy
            ? { mode: 'selected' as const, roleKeys: member.kbChatRolePolicy.permissions.map((item) => item.roleKey) }
            : { mode: 'all' as const, roleKeys: [] },
    }));
}

export async function setMemberActive(userId: string, isActive: boolean): Promise<{ isActive: boolean }> {
    await prisma.$transaction(async (tx) => {
        const user = await loadNonAdminMember(tx, userId);
        if (user.isActive === isActive) {
            return;
        }
        await tx.user.update({
            where: { id: userId },
            data: {
                isActive,
                authTokenVersion: { increment: 1 },
            },
        });
    });

    return { isActive };
}

export async function deleteMemberAccount(userId: string, options: { releaseInviteCodeId?: string } = {}): Promise<void> {
    await prisma.$transaction(async (tx) => {
        await loadNonAdminMember(tx, userId);

        if (options.releaseInviteCodeId) {
            await tx.inviteCode.update({
                where: { id: options.releaseInviteCodeId },
                data: {
                    usedByUserId: null,
                    usedAt: null,
                },
            });
        } else {
            await tx.inviteCode.updateMany({
                where: { usedByUserId: userId },
                data: {
                    usedByUserId: null,
                    usedAt: null,
                },
            });
        }

        await tx.invitation.deleteMany({
            where: {
                OR: [
                    { inviterId: userId },
                    { inviteeId: userId },
                ],
            },
        });
        await tx.pointsTransaction.deleteMany({ where: { userId } });
        await tx.conversation.deleteMany({ where: { userId } });
        await tx.workflowExecution.deleteMany({ where: { userId } });
        await tx.workflow.deleteMany({ where: { userId } });
        await tx.videoUsageLog.deleteMany({ where: { userId } });
        await tx.user.delete({ where: { id: userId } });
    }, MEMBER_DELETE_TRANSACTION_OPTIONS);
}

export async function replaceMemberBotAccess(userId: string, botKeys: string[]): Promise<BotAccessSummary> {
    const normalizedBotKeys = [...new Set(botKeys)];
    if (normalizedBotKeys.some((botKey) => !isOfficialBotKey(botKey))) {
        throw new AppError('Unknown official bot.', 400, 'INVALID_BOT_KEY');
    }

    await prisma.$transaction(async (tx) => {
        await requireConfigurableMember(tx, userId);

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
        await requireConfigurableMember(tx, userId);
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
        await requireConfigurableMember(tx, userId);

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
        await requireConfigurableMember(tx, userId);
        await tx.userKbChatRolePolicy.deleteMany({ where: { userId } });
    });

    return { mode: 'all', roleKeys: [] };
}
