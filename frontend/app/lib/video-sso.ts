import crypto from 'node:crypto';
import { AppError, assertMemberAccountEnabled, ensureAccessControlBootstrap } from './auth';
import { prisma } from './prisma';
import { readServerEnv } from './server-env';
import { VIDEO_SITE_KEYS, VIDEO_SITE_METADATA, type VideoSiteKey } from './video-sites';

const DEFAULT_MAIN_APP_URL = 'https://www.qycm.top';
const VIDEO_SSO_SECRET_HEADER = 'x-video-sso-secret';
const VIDEO_PRODUCT = 'video';
const VIDEO_SSO_TICKET_TTL_MS = 60_000;

let ensureVideoSsoTicketTablePromise: Promise<void> | null = null;

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

function safeTrim(value: string | undefined): string {
    return value?.trim() || '';
}

function toComparableBuffer(value: string): Buffer {
    return Buffer.from(value, 'utf8');
}

async function runEnsureVideoSsoTicketTable(): Promise<void> {
    await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS video_sso_tickets (
            id TEXT PRIMARY KEY,
            product TEXT NOT NULL,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            redirect_path TEXT,
            expires_at TIMESTAMPTZ NOT NULL,
            used_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS video_sso_tickets_product_expires_at_idx
        ON video_sso_tickets (product, expires_at)
    `);
    await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS video_sso_tickets_user_id_created_at_idx
        ON video_sso_tickets (user_id, created_at DESC)
    `);
}

export async function ensureVideoSsoTicketTable(): Promise<void> {
    await ensureAccessControlBootstrap();
    if (!ensureVideoSsoTicketTablePromise) {
        ensureVideoSsoTicketTablePromise = runEnsureVideoSsoTicketTable().catch((error) => {
            ensureVideoSsoTicketTablePromise = null;
            throw error;
        });
    }

    await ensureVideoSsoTicketTablePromise;
}

export function getMainAppUrl(): string {
    return resolvePublicUrl(readServerEnv('MAIN_APP_URL'), DEFAULT_MAIN_APP_URL);
}

function getVideoAppEnvValue(site: VideoSiteKey): string | undefined {
    if (site === 'tiktok') {
        return readServerEnv('VIDEO_APP_URL_TIKTOK');
    }

    return readServerEnv('VIDEO_APP_URL_SEEDANCE') || readServerEnv('VIDEO_APP_URL');
}

export function getVideoAppUrl(site: VideoSiteKey = 'seedance'): string {
    const meta = VIDEO_SITE_METADATA[site];
    return resolvePublicUrl(getVideoAppEnvValue(site), meta.defaultAppUrl);
}

export function getAllVideoAppUrls(): string[] {
    return [...new Set(VIDEO_SITE_KEYS.map((site) => getVideoAppUrl(site)))];
}

export function getMainAppVideoEntryUrl(site: VideoSiteKey = 'seedance'): string {
    return `${getMainAppUrl()}${VIDEO_SITE_METADATA[site].entryPath}`;
}

export function getVideoSsoSecretHeaderName(): string {
    return VIDEO_SSO_SECRET_HEADER;
}

export function getVideoSsoInternalSecret(): string {
    const secret = safeTrim(readServerEnv('VIDEO_SSO_INTERNAL_SECRET'));
    if (!secret) {
        throw new Error('VIDEO_SSO_INTERNAL_SECRET is not configured.');
    }
    return secret;
}

export function isValidVideoSsoInternalSecret(candidate: string | null): boolean {
    const expected = getVideoSsoInternalSecret();
    const received = safeTrim(candidate || undefined);
    if (!received) {
        return false;
    }

    const expectedBuffer = toComparableBuffer(expected);
    const receivedBuffer = toComparableBuffer(received);
    if (expectedBuffer.length !== receivedBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

export function parseVideoRedirectPath(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    const redirectPath = value.trim();
    if (!redirectPath || !redirectPath.startsWith('/') || redirectPath.startsWith('//')) {
        return null;
    }

    return redirectPath;
}

export function buildVideoSsoUrl(ticketId: string, options?: { mainAppUrl?: string; site?: VideoSiteKey }): string {
    const site = options?.site || 'seedance';
    const url = new URL('/', getVideoAppUrl(site));
    url.searchParams.set('ticket', ticketId);
    url.searchParams.set('mainApp', options?.mainAppUrl || getMainAppUrl());
    return url.toString();
}

export async function createVideoSsoTicket(userId: string, redirectPath: string | null) {
    await ensureVideoSsoTicketTable();

    return prisma.videoSsoTicket.create({
        data: {
            id: crypto.randomUUID(),
            product: VIDEO_PRODUCT,
            userId,
            redirectPath,
            expiresAt: new Date(Date.now() + VIDEO_SSO_TICKET_TTL_MS),
        },
        select: {
            id: true,
            redirectPath: true,
            expiresAt: true,
        },
    });
}

export async function consumeVideoSsoTicket(ticketId: string) {
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

        if (!ticket || ticket.product !== VIDEO_PRODUCT) {
            throw new AppError('SSO ticket is invalid.', 401, 'VIDEO_SSO_TICKET_INVALID');
        }

        if (ticket.usedAt) {
            throw new AppError('SSO ticket has already been used.', 410, 'VIDEO_SSO_TICKET_USED');
        }

        if (ticket.expiresAt.getTime() <= Date.now()) {
            throw new AppError('SSO ticket has expired.', 410, 'VIDEO_SSO_TICKET_EXPIRED');
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
            throw new AppError('SSO ticket is no longer valid.', 410, 'VIDEO_SSO_TICKET_INVALIDATED');
        }

        return {
            redirectPath: ticket.redirectPath,
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
