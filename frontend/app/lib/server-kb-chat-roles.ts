import { AppError } from './auth';
import {
    canAccessKbChatRole,
    DEFAULT_KB_CHAT_ROLE_ACCESS,
    isKbChatRoleKey,
    type KbChatRoleAccessSummary,
} from './kb-chat-roles';
import { prisma } from './prisma';

export async function getUserKbChatRoleSummary(userId: string, role?: string): Promise<KbChatRoleAccessSummary> {
    if (role === 'admin') return DEFAULT_KB_CHAT_ROLE_ACCESS;

    const resolvedRole = role || (await prisma.user.findUnique({
        where: { id: userId },
        select: { role: true },
    }))?.role;
    if (resolvedRole === 'admin') return DEFAULT_KB_CHAT_ROLE_ACCESS;

    const policy = await prisma.userKbChatRolePolicy.findUnique({
        where: { userId },
        select: { permissions: { select: { roleKey: true }, orderBy: { createdAt: 'asc' } } },
    });
    if (!policy) return DEFAULT_KB_CHAT_ROLE_ACCESS;
    return { mode: 'selected', roleKeys: policy.permissions.map((item) => item.roleKey) };
}

export async function assertUserCanAccessKbChatRole(userId: string, roleKey: string, role?: string): Promise<void> {
    if (!isKbChatRoleKey(roleKey)) {
        throw new AppError('Unknown knowledge-base role.', 400, 'INVALID_KB_CHAT_ROLE');
    }
    const summary = await getUserKbChatRoleSummary(userId, role);
    if (!canAccessKbChatRole(summary, roleKey)) {
        throw new AppError('管理员未向该账号开放此知识库岗位。', 403, 'KB_CHAT_ROLE_DENIED');
    }
}
