import { NextRequest } from 'next/server';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import {
    signToken,
    AppError,
    errorResponse,
    ensureAccessControlBootstrap,
    revokeAuthSession,
} from '../../lib/auth';
import { findUserByLoginAccount } from '../../lib/server-account-lookup';
import { getUserBotAccessSummary } from '../../lib/server-bot-access';

const accountSchema = z.string().trim().min(1, 'Account is required.');
const passwordSchema = z.string().min(6, 'Password must be at least 6 characters.');
const inviteCodeSchema = z.string().trim().min(6, 'Invite code is required.').max(32, 'Invite code is invalid.');

const registerSchema = z.object({
    account: accountSchema,
    password: passwordSchema,
    inviteCode: inviteCodeSchema,
});

const loginSchema = z.object({
    account: accountSchema,
    password: z.string(),
});

const activateSchema = z.object({
    account: accountSchema,
    password: z.string(),
    inviteCode: inviteCodeSchema,
});

const AUTH_TRANSACTION_OPTIONS = {
    maxWait: 10_000,
    timeout: 20_000,
} as const;

export async function POST(req: NextRequest) {
    try {
        await ensureAccessControlBootstrap();

        const url = new URL(req.url);
        const action = url.searchParams.get('action');
        const body = await req.json();

        switch (action) {
            case 'register':
                return await handleRegister(body);
            case 'login':
                return await handleLogin(body);
            case 'activate':
                return await handleActivate(body);
            case 'logout':
                return await handleLogout(req);
            default:
                throw new AppError('Invalid auth action.', 400);
        }
    } catch (err) {
        return errorResponse(err);
    }
}

function normalizeAccount(account: string): string {
    return account.trim();
}

function normalizeInviteCode(code: string): string {
    return code.trim().toUpperCase();
}

function parseRequestBody<T>(schema: z.ZodSchema<T>, body: unknown): T {
    const result = schema.safeParse(body);
    if (!result.success) {
        throw new AppError(result.error.issues[0]?.message || 'Invalid request.', 400);
    }

    return result.data;
}

type AuthPayloadUser = {
    id: string;
    email: string;
    nickname: string;
    groupName: string;
    avatar: string;
    role: string;
    createdAt?: Date;
};

type AuthTokenUser = AuthPayloadUser & { authTokenVersion: number };

async function toUserPayload(user: AuthPayloadUser) {
    return {
        id: user.id,
        account: user.email,
        nickname: user.nickname,
        groupName: user.groupName,
        avatar: user.avatar,
        role: user.role,
        botAccess: await getUserBotAccessSummary(user.id, user.role),
        ...(user.createdAt ? { createdAt: user.createdAt } : {}),
    };
}

async function issueAuthResponse(user: AuthTokenUser, status = 200) {
    return Response.json({
        success: true,
        data: {
            token: signToken(user.id, user.authTokenVersion),
            user: await toUserPayload(user),
        },
    }, { status });
}

async function consumeInviteCode(tx: Prisma.TransactionClient, inviteCode: string, userId: string) {
    const invite = await tx.inviteCode.findUnique({
        where: { code: inviteCode },
        select: { id: true, usedByUserId: true },
    });

    if (!invite || invite.usedByUserId) {
        throw new AppError('Invite code is invalid.', 400, 'INVITE_CODE_INVALID');
    }

    const consumeResult = await tx.inviteCode.updateMany({
        where: { id: invite.id, usedByUserId: null },
        data: {
            usedByUserId: userId,
            usedAt: new Date(),
        },
    });

    if (consumeResult.count !== 1) {
        throw new AppError('Invite code is invalid.', 400, 'INVITE_CODE_INVALID');
    }
}

async function handleRegister(body: unknown) {
    const data = parseRequestBody(registerSchema, body);
    const account = normalizeAccount(data.account);
    const inviteCode = normalizeInviteCode(data.inviteCode);

    const user = await prisma.$transaction(async (tx) => {
        const existing = await findUserByLoginAccount(tx, account, {
                id: true,
                email: true,
                passwordHash: true,
                nickname: true,
                groupName: true,
                avatar: true,
                role: true,
                accessGrantedAt: true,
                authTokenVersion: true,
                createdAt: true,
            });

        if (existing) {
            if (existing.role !== 'admin' && !existing.accessGrantedAt) {
                const valid = await bcrypt.compare(data.password, existing.passwordHash);
                if (!valid) {
                    throw new AppError('Incorrect password.', 400);
                }

                await consumeInviteCode(tx, inviteCode, existing.id);

                return tx.user.update({
                    where: { id: existing.id },
                    data: {
                        accessGrantedAt: new Date(),
                        isVerified: true,
                    },
                    select: {
                        id: true,
                        email: true,
                        nickname: true,
                        groupName: true,
                        avatar: true,
                        role: true,
                        authTokenVersion: true,
                        createdAt: true,
                    },
                });
            }
            throw new AppError('Account already exists.', 409);
        }

        const passwordHash = await bcrypt.hash(data.password, 10);
        const createdUser = await tx.user.create({
            data: {
                email: account,
                passwordHash,
                isVerified: true,
                role: 'member',
                accessGrantedAt: new Date(),
                nickname: account,
                groupName: '',
            },
            select: {
                id: true,
                email: true,
                nickname: true,
                groupName: true,
                avatar: true,
                role: true,
                authTokenVersion: true,
                createdAt: true,
            },
        });

        await consumeInviteCode(tx, inviteCode, createdUser.id);

        return createdUser;
    }, AUTH_TRANSACTION_OPTIONS);

    return issueAuthResponse(user, 201);
}

async function handleLogin(body: unknown) {
    const data = parseRequestBody(loginSchema, body);
    const account = normalizeAccount(data.account);

    const user = await findUserByLoginAccount(prisma, account, {
            id: true,
            email: true,
            passwordHash: true,
            nickname: true,
            groupName: true,
            avatar: true,
            role: true,
            accessGrantedAt: true,
            isActive: true,
            authTokenVersion: true,
            createdAt: true,
        });

    if (!user) {
        throw new AppError('Account not found.', 404);
    }

    const valid = await bcrypt.compare(data.password, user.passwordHash);
    if (!valid) {
        throw new AppError('Incorrect password.', 400);
    }

    if (user.role !== 'admin' && user.isActive === false) {
        throw new AppError('该账号已停用。', 403, 'ACCOUNT_DISABLED');
    }

    if (user.role !== 'admin' && !user.accessGrantedAt) {
        throw new AppError('Invite code required.', 403, 'INVITE_REQUIRED');
    }

    return issueAuthResponse(user);
}

async function handleActivate(body: unknown) {
    const data = parseRequestBody(activateSchema, body);
    const account = normalizeAccount(data.account);
    const inviteCode = normalizeInviteCode(data.inviteCode);

    const user = await prisma.$transaction(async (tx) => {
        const existing = await findUserByLoginAccount(tx, account, {
                id: true,
                email: true,
                passwordHash: true,
                nickname: true,
                groupName: true,
                avatar: true,
                role: true,
                accessGrantedAt: true,
                isActive: true,
                authTokenVersion: true,
                createdAt: true,
            });

        if (!existing) {
            throw new AppError('Account not found.', 404);
        }

        const valid = await bcrypt.compare(data.password, existing.passwordHash);
        if (!valid) {
            throw new AppError('Incorrect password.', 400);
        }

        if (existing.role === 'admin') {
            return existing;
        }

        if (existing.isActive === false) {
            throw new AppError('该账号已停用。', 403, 'ACCOUNT_DISABLED');
        }

        if (existing.accessGrantedAt) {
            return existing;
        }

        await consumeInviteCode(tx, inviteCode, existing.id);

        return tx.user.update({
            where: { id: existing.id },
            data: {
                accessGrantedAt: new Date(),
                isVerified: true,
            },
            select: {
                id: true,
                email: true,
                nickname: true,
                groupName: true,
                avatar: true,
                role: true,
                authTokenVersion: true,
                createdAt: true,
            },
        });
    }, AUTH_TRANSACTION_OPTIONS);

    return issueAuthResponse(user);
}

async function handleLogout(req: NextRequest) {
    await revokeAuthSession(req);
    return Response.json({ success: true });
}
