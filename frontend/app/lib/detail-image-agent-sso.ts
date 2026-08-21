import crypto from 'node:crypto';
import { AppError, assertMemberAccountEnabled } from './auth';
import { prisma } from './prisma';
import { readServerEnv } from './server-env';
import { DETAIL_IMAGE_AGENT_SITE_METADATA } from './detail-image-agent-site';
import {
    ensureVideoSsoTicketTable,
    getMainAppUrl,
    parseVideoRedirectPath,
} from './video-sso';

const DETAIL_IMAGE_AGENT_PRODUCT = 'detail-image-agent';
const DETAIL_IMAGE_AGENT_SSO_TICKET_TTL_MS = 60_000;

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

function buildDetailImageAgentTicketInvalidError(code: string) {
    return new AppError('SSO ticket is invalid.', 401, code);
}

function buildDetailImageAgentTicketExpiredError(code: string) {
    return new AppError('SSO ticket has expired.', 410, code);
}

function buildDetailImageAgentTicketUsedError(code: string) {
    return new AppError('SSO ticket has already been used.', 410, code);
}

function buildDetailImageAgentTicketInvalidatedError(code: string) {
    return new AppError('SSO ticket is no longer valid.', 410, code);
}

function getDetailImageAgentAppEnvValue(): string | undefined {
    return readServerEnv('DETAIL_IMAGE_AGENT_APP_URL') || readServerEnv('DIANPUTU_APP_URL');
}

export function getDetailImageAgentAppUrl(): string {
    return resolvePublicUrl(getDetailImageAgentAppEnvValue(), DETAIL_IMAGE_AGENT_SITE_METADATA.defaultAppUrl);
}

export function getMainAppDetailImageAgentEntryUrl(): string {
    return `${getMainAppUrl()}${DETAIL_IMAGE_AGENT_SITE_METADATA.entryPath}`;
}

export function buildDetailImageAgentSsoUrl(ticketId: string, options?: { mainAppUrl?: string }): string {
    const url = new URL('/', getDetailImageAgentAppUrl());
    url.searchParams.set('ticket', ticketId);
    url.searchParams.set('mainApp', options?.mainAppUrl || getMainAppUrl());
    return url.toString();
}

export async function createDetailImageAgentSsoTicket(userId: string, redirectPath: string | null) {
    await ensureVideoSsoTicketTable();

    return prisma.videoSsoTicket.create({
        data: {
            id: crypto.randomUUID(),
            product: DETAIL_IMAGE_AGENT_PRODUCT,
            userId,
            redirectPath,
            expiresAt: new Date(Date.now() + DETAIL_IMAGE_AGENT_SSO_TICKET_TTL_MS),
        },
        select: {
            id: true,
            redirectPath: true,
            expiresAt: true,
        },
    });
}

export async function consumeDetailImageAgentSsoTicket(ticketId: string) {
    await ensureVideoSsoTicketTable();

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

        if (!ticket || ticket.product !== DETAIL_IMAGE_AGENT_PRODUCT) {
            throw buildDetailImageAgentTicketInvalidError('DETAIL_IMAGE_AGENT_SSO_TICKET_INVALID');
        }

        if (ticket.usedAt) {
            throw buildDetailImageAgentTicketUsedError('DETAIL_IMAGE_AGENT_SSO_TICKET_USED');
        }

        if (ticket.expiresAt.getTime() <= Date.now()) {
            throw buildDetailImageAgentTicketExpiredError('DETAIL_IMAGE_AGENT_SSO_TICKET_EXPIRED');
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
            throw buildDetailImageAgentTicketInvalidatedError('DETAIL_IMAGE_AGENT_SSO_TICKET_INVALIDATED');
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
            },
        };
    });
}

export { parseVideoRedirectPath as parseDetailImageAgentRedirectPath };
