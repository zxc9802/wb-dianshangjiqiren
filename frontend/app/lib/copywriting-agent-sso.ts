import crypto from 'node:crypto';
import { AppError, assertMemberAccountEnabled } from './auth';
import { prisma } from './prisma';
import { readServerEnv } from './server-env';
import { COPYWRITING_AGENT_SITE_METADATA } from './copywriting-agent-site';
import {
    ensureVideoSsoTicketTable,
    getMainAppUrl,
    parseVideoRedirectPath,
} from './video-sso';

const COPYWRITING_AGENT_PRODUCT = 'copywriting-agent';
const COPYWRITING_AGENT_SSO_TICKET_TTL_MS = 60_000;

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

function buildCopywritingAgentTicketInvalidError(code: string) {
    return new AppError('SSO ticket is invalid.', 401, code);
}

function buildCopywritingAgentTicketExpiredError(code: string) {
    return new AppError('SSO ticket has expired.', 410, code);
}

function buildCopywritingAgentTicketUsedError(code: string) {
    return new AppError('SSO ticket has already been used.', 410, code);
}

function buildCopywritingAgentTicketInvalidatedError(code: string) {
    return new AppError('SSO ticket is no longer valid.', 410, code);
}

export function getCopywritingAgentAppUrl(): string {
    return resolvePublicUrl(
        readServerEnv('COPYWRITING_AGENT_APP_URL'),
        COPYWRITING_AGENT_SITE_METADATA.defaultAppUrl,
    );
}

export function getMainAppCopywritingAgentEntryUrl(): string {
    return `${getMainAppUrl()}${COPYWRITING_AGENT_SITE_METADATA.entryPath}`;
}

export function buildCopywritingAgentSsoUrl(ticketId: string, options?: { mainAppUrl?: string }): string {
    const url = new URL('/', getCopywritingAgentAppUrl());
    url.searchParams.set('ticket', ticketId);
    url.searchParams.set('mainApp', options?.mainAppUrl || getMainAppUrl());
    return url.toString();
}

export async function createCopywritingAgentSsoTicket(userId: string, redirectPath: string | null) {
    await ensureVideoSsoTicketTable();

    return prisma.videoSsoTicket.create({
        data: {
            id: crypto.randomUUID(),
            product: COPYWRITING_AGENT_PRODUCT,
            userId,
            redirectPath,
            expiresAt: new Date(Date.now() + COPYWRITING_AGENT_SSO_TICKET_TTL_MS),
        },
        select: {
            id: true,
            redirectPath: true,
            expiresAt: true,
        },
    });
}

export async function consumeCopywritingAgentSsoTicket(ticketId: string) {
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

        if (!ticket || ticket.product !== COPYWRITING_AGENT_PRODUCT) {
            throw buildCopywritingAgentTicketInvalidError('COPYWRITING_AGENT_SSO_TICKET_INVALID');
        }

        if (ticket.usedAt) {
            throw buildCopywritingAgentTicketUsedError('COPYWRITING_AGENT_SSO_TICKET_USED');
        }

        if (ticket.expiresAt.getTime() <= Date.now()) {
            throw buildCopywritingAgentTicketExpiredError('COPYWRITING_AGENT_SSO_TICKET_EXPIRED');
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
            throw buildCopywritingAgentTicketInvalidatedError('COPYWRITING_AGENT_SSO_TICKET_INVALIDATED');
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

export { parseVideoRedirectPath as parseCopywritingAgentRedirectPath };
