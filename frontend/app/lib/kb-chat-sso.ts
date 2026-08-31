import crypto from 'node:crypto';
import { AppError, assertMemberAccountEnabled } from './auth';
import { prisma } from './prisma';
import { readServerEnv } from './server-env';
import { KB_CHAT_SITE_METADATA } from './kb-chat-site';
import { ensureModelAccessTables } from './server-model-access';
import {
    ensureVideoSsoTicketTable,
    getMainAppUrl,
    parseVideoRedirectPath,
} from './video-sso';

const KB_CHAT_PRODUCT = 'kb-chat';
const KB_CHAT_SSO_TICKET_TTL_MS = 60_000;

function normalizeUrl(value: string | undefined, fallback: string): string {
    return (value?.trim() || fallback).replace(/\/+$/, '');
}

function isLocalOnlyUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return ['localhost', '127.0.0.1', '0.0.0.0'].includes(url.hostname);
    } catch {
        return false;
    }
}

function resolvePublicUrl(value: string | undefined, fallback: string): string {
    const normalized = normalizeUrl(value, fallback);
    if (process.env.NODE_ENV === 'production' && isLocalOnlyUrl(normalized)) {
        return fallback;
    }

    return normalized;
}

function buildKbChatTicketInvalidError(code: string) {
    return new AppError('SSO ticket is invalid.', 401, code);
}

function buildKbChatTicketExpiredError(code: string) {
    return new AppError('SSO ticket has expired.', 410, code);
}

function buildKbChatTicketUsedError(code: string) {
    return new AppError('SSO ticket has already been used.', 410, code);
}

function buildKbChatTicketInvalidatedError(code: string) {
    return new AppError('SSO ticket is no longer valid.', 410, code);
}

function getKbChatAppEnvValue(): string | undefined {
    return readServerEnv('KB_CHAT_APP_URL') || readServerEnv('QYZSK_APP_URL');
}

export function getKbChatAppUrl(): string {
    return resolvePublicUrl(getKbChatAppEnvValue(), KB_CHAT_SITE_METADATA.defaultAppUrl);
}

export function getMainAppKbChatEntryUrl(): string {
    return `${getMainAppUrl()}${KB_CHAT_SITE_METADATA.entryPath}`;
}

export function buildKbChatSsoUrl(ticketId: string, options?: { mainAppUrl?: string }): string {
    const url = new URL('/', getKbChatAppUrl());
    url.searchParams.set('ticket', ticketId);
    url.searchParams.set('mainApp', options?.mainAppUrl || getMainAppUrl());
    return url.toString();
}

export async function createKbChatSsoTicket(userId: string, redirectPath: string | null) {
    await ensureVideoSsoTicketTable();

    return prisma.videoSsoTicket.create({
        data: {
            id: crypto.randomUUID(),
            product: KB_CHAT_PRODUCT,
            userId,
            redirectPath,
            expiresAt: new Date(Date.now() + KB_CHAT_SSO_TICKET_TTL_MS),
        },
        select: {
            id: true,
            redirectPath: true,
            expiresAt: true,
        },
    });
}

export async function consumeKbChatSsoTicket(ticketId: string) {
    await ensureVideoSsoTicketTable();
    await ensureModelAccessTables();

    return prisma.$transaction(async (tx) => {
        const ticket = await tx.videoSsoTicket.findUnique({
            where: { id: ticketId },
            select: {
                id: true,
                product: true,
                userId: true,
                redirectPath: true,
                expiresAt: true,
                usedAt: true,
            },
        });

        if (!ticket || ticket.product !== KB_CHAT_PRODUCT) {
            throw buildKbChatTicketInvalidError('KB_CHAT_SSO_TICKET_INVALID');
        }

        if (ticket.usedAt) {
            throw buildKbChatTicketUsedError('KB_CHAT_SSO_TICKET_USED');
        }

        if (ticket.expiresAt.getTime() <= Date.now()) {
            throw buildKbChatTicketExpiredError('KB_CHAT_SSO_TICKET_EXPIRED');
        }

        const user = await tx.user.findUnique({
            where: { id: ticket.userId },
            select: {
                id: true,
                email: true,
                nickname: true,
                groupName: true,
                role: true,
                accessGrantedAt: true,
                isActive: true,
                authTokenVersion: true,
                kbChatRolePolicy: {
                    select: {
                        permissions: {
                            select: { roleKey: true },
                            orderBy: { createdAt: 'asc' },
                        },
                    },
                },
                modelAccessPolicies: {
                    where: { siteKey: 'kb-chat' },
                    select: {
                        siteKey: true,
                        permissions: {
                            select: { modelKey: true },
                            orderBy: { createdAt: 'asc' },
                        },
                    },
                },
            },
        });

        if (!user) {
            throw new AppError('Account not found.', 404);
        }

        assertMemberAccountEnabled(user);
        const hasAccess = user.role === 'admin' || Boolean(user.accessGrantedAt);
        if (!hasAccess) {
            throw new AppError('Invite code required.', 403, 'INVITE_REQUIRED');
        }

        const updateResult = await tx.videoSsoTicket.updateMany({
            where: {
                id: ticket.id,
                usedAt: null,
                expiresAt: { gt: new Date() },
            },
            data: {
                usedAt: new Date(),
            },
        });

        if (updateResult.count !== 1) {
            throw buildKbChatTicketInvalidatedError('KB_CHAT_SSO_TICKET_INVALIDATED');
        }

        return {
            redirectPath: ticket.redirectPath || '/',
            user: {
                id: user.id,
                account: user.email,
                nickname: user.nickname,
                groupName: user.groupName,
                role: user.role,
                authTokenVersion: user.authTokenVersion,
                kbChatRoles: user.role === 'admin' || !user.kbChatRolePolicy
                    ? { mode: 'all' as const, roleKeys: [] as string[] }
                    : {
                        mode: 'selected' as const,
                        roleKeys: user.kbChatRolePolicy.permissions.map((item) => item.roleKey),
                    },
                modelAccess: {
                    sites: user.role === 'admin'
                        ? []
                        : user.modelAccessPolicies.map((policy) => ({
                            siteKey: 'kb-chat' as const,
                            mode: 'selected' as const,
                            modelKeys: policy.permissions.map((item) => item.modelKey),
                        })),
                },
            },
        };
    });
}

export { parseVideoRedirectPath as parseKbChatRedirectPath };
