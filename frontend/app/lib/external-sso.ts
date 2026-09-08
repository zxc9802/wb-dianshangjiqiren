import crypto from 'node:crypto';
import { AppError, assertMemberAccountEnabled } from './auth';
import { assertUserCanAccessOfficialBot } from './server-bot-access';
import { prisma } from './prisma';
import { readRequiredServerEnv } from './server-env';
import { ensureVideoSsoTicketTable } from './video-sso';

const EXTERNAL_SSO_TICKET_TTL_MS = 60_000;
const EXTERNAL_SSO_CLIENT_SECRET_HEADER = 'x-qycm-sso-client-secret';

const EXTERNAL_SSO_PRODUCTS = {
    chanpinsheji: { clientSecretEnv: 'SSO_CHANPINSHEJI_CLIENT_SECRET', appUrlEnv: 'SSO_CHANPINSHEJI_APP_URL' },
    sabc: { clientSecretEnv: 'SSO_SABC_CLIENT_SECRET', appUrlEnv: 'SSO_SABC_APP_URL' },
    xiaoshou: { clientSecretEnv: 'SSO_XIAOSHOU_CLIENT_SECRET', appUrlEnv: 'SSO_XIAOSHOU_APP_URL' },
    baokuangaixie: { clientSecretEnv: 'SSO_BAOKUANGAIXIE_CLIENT_SECRET', appUrlEnv: 'SSO_BAOKUANGAIXIE_APP_URL' },
} as const;

export type ExternalSsoProduct = keyof typeof EXTERNAL_SSO_PRODUCTS;

function buildInvalidTicketError(code: string) {
    return new AppError('SSO ticket is invalid.', 401, code);
}

function buildExpiredTicketError(code: string) {
    return new AppError('SSO ticket has expired.', 410, code);
}

function buildUsedTicketError(code: string) {
    return new AppError('SSO ticket has already been used.', 410, code);
}

function buildInvalidatedTicketError(code: string) {
    return new AppError('SSO ticket is no longer valid.', 410, code);
}

function asComparableBuffer(value: string): Buffer {
    return Buffer.from(value, 'utf8');
}

export function parseExternalSsoProduct(value: string): ExternalSsoProduct {
    if (Object.hasOwn(EXTERNAL_SSO_PRODUCTS, value)) {
        return value as ExternalSsoProduct;
    }

    throw new AppError('Unknown SSO product.', 404, 'EXTERNAL_SSO_PRODUCT_INVALID');
}

export function parseExternalSsoRedirectPath(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    const redirectPath = value.trim();
    if (!redirectPath || !redirectPath.startsWith('/') || redirectPath.startsWith('//') || /[\\\x00-\x20]/.test(redirectPath)) {
        return null;
    }

    return redirectPath;
}

export function getExternalSsoClientSecretHeaderName(): string {
    return EXTERNAL_SSO_CLIENT_SECRET_HEADER;
}

export function buildExternalSsoCallbackUrl(product: ExternalSsoProduct, ticketId: string): string {
    const url = new URL('/api/sso/callback', readRequiredServerEnv(EXTERNAL_SSO_PRODUCTS[product].appUrlEnv));
    url.searchParams.set('ticket', ticketId);
    return url.toString();
}

export function isValidExternalSsoClientSecret(
    product: ExternalSsoProduct,
    candidate: string | null,
): boolean {
    const expected = readRequiredServerEnv(EXTERNAL_SSO_PRODUCTS[product].clientSecretEnv).trim();
    const received = candidate?.trim() || '';
    if (!received) {
        return false;
    }

    const expectedBuffer = asComparableBuffer(expected);
    const receivedBuffer = asComparableBuffer(received);
    if (expectedBuffer.length !== receivedBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

export async function createExternalSsoTicket(
    product: ExternalSsoProduct,
    userId: string,
    redirectPath: string | null,
) {
    await ensureVideoSsoTicketTable();

    return prisma.videoSsoTicket.create({
        data: {
            id: crypto.randomUUID(),
            product,
            userId,
            redirectPath,
            expiresAt: new Date(Date.now() + EXTERNAL_SSO_TICKET_TTL_MS),
        },
        select: {
            id: true,
            expiresAt: true,
        },
    });
}

export async function consumeExternalSsoTicket(product: ExternalSsoProduct, ticketId: string) {
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

        if (!ticket || ticket.product !== product) {
            throw buildInvalidTicketError('EXTERNAL_SSO_TICKET_INVALID');
        }

        if (ticket.usedAt) {
            throw buildUsedTicketError('EXTERNAL_SSO_TICKET_USED');
        }

        if (ticket.expiresAt.getTime() <= Date.now()) {
            throw buildExpiredTicketError('EXTERNAL_SSO_TICKET_EXPIRED');
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
                authTokenVersion: true,
                isActive: true,
            },
        });

        if (!user) {
            throw new AppError('Account not found.', 404);
        }

        assertMemberAccountEnabled(user);
        await assertUserCanAccessOfficialBot(user.id, product, user.role);

        if (user.role !== 'admin' && !user.accessGrantedAt) {
            throw new AppError('Invite code required.', 403, 'INVITE_REQUIRED');
        }

        const updated = await tx.videoSsoTicket.updateMany({
            where: {
                id: ticket.id,
                product,
                usedAt: null,
                expiresAt: { gt: new Date() },
            },
            data: { usedAt: new Date() },
        });

        if (updated.count !== 1) {
            throw buildInvalidatedTicketError('EXTERNAL_SSO_TICKET_INVALIDATED');
        }

        return {
            redirectPath: parseExternalSsoRedirectPath(ticket.redirectPath) || '/',
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

export { EXTERNAL_SSO_TICKET_TTL_MS };
