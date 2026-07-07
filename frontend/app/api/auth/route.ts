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

const accountSchema = z.string().trim().min(3, 'Account must be at least 3 characters.').max(64, 'Account is too long.');
const passwordSchema = z.string().min(6, 'Password must be at least 6 characters.');
const inviteCodeSchema = z.string().trim().min(6, 'Invite code is required.').max(32, 'Invite code is invalid.');
const nicknameSchema = z.string().trim().min(1, 'Name is required.').max(20, 'Name is too long.');
const optionalNicknameSchema = z.string().trim().max(20, 'Name is too long.').optional();
const groupNameSchema = z.string().trim().min(1, 'Group is required.').max(50, 'Group is too long.');
const optionalGroupNameSchema = z.string().trim().max(50, 'Group is too long.').optional();

const registerSchema = z.object({
    account: accountSchema,
    password: passwordSchema,
    nickname: nicknameSchema,
    groupName: groupNameSchema,
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
    nickname: optionalNicknameSchema,
    groupName: optionalGroupNameSchema,
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

function normalizeProfileValue(value: string | undefined): string {
    return value?.trim() || '';
}

function parseRequestBody<T>(schema: z.ZodSchema<T>, body: unknown): T {
    const result = schema.safeParse(body);
    if (!result.success) {
        throw new AppError(result.error.issues[0]?.message || 'Invalid request.', 400);
    }

    return result.data;
}

function toUserPayload(user: {
    id: string;
    email: string;
    nickname: string;
    groupName: string;
    avatar: string;
    role: string;
    createdAt?: Date;
}) {
    return {
        id: user.id,
        account: user.email,
        nickname: user.nickname,
        groupName: user.groupName,
        avatar: user.avatar,
        role: user.role,
        ...(user.createdAt ? { createdAt: user.createdAt } : {}),
    };
}

function issueAuthResponse(user: {
    id: string;
    email: string;
    nickname: string;
    groupName: string;
    avatar: string;
    role: string;
    authTokenVersion: number;
    createdAt?: Date;
}, status = 200) {
    return Response.json({
        success: true,
        data: {
            token: signToken(user.id, user.authTokenVersion),
            user: toUserPayload(user),
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
    const nextNickname = normalizeProfileValue(data.nickname);
    const nextGroupName = normalizeProfileValue(data.groupName);

    const user = await prisma.$transaction(async (tx) => {
        const existing = await tx.user.findUnique({
            where: { email: account },
            select: {
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
            },
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
                        nickname: nextNickname,
                        groupName: nextGroupName,
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
                nickname: nextNickname,
                groupName: nextGroupName,
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

    const user = await prisma.user.findUnique({
        where: { email: account },
        select: {
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
        },
    });

    if (!user) {
        throw new AppError('Account not found.', 404);
    }

    const valid = await bcrypt.compare(data.password, user.passwordHash);
    if (!valid) {
        throw new AppError('Incorrect password.', 400);
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
        const existing = await tx.user.findUnique({
            where: { email: account },
            select: {
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
            },
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

        if (existing.accessGrantedAt) {
            return existing;
        }

        const nextNickname = normalizeProfileValue(data.nickname) || existing.nickname.trim();
        const nextGroupName = normalizeProfileValue(data.groupName) || existing.groupName.trim();

        if (!nextNickname) {
            throw new AppError('Name is required for activation.', 400, 'PROFILE_NAME_REQUIRED');
        }

        if (!nextGroupName) {
            throw new AppError('Group is required for activation.', 400, 'PROFILE_GROUP_REQUIRED');
        }

        await consumeInviteCode(tx, inviteCode, existing.id);

        return tx.user.update({
            where: { id: existing.id },
            data: {
                accessGrantedAt: new Date(),
                isVerified: true,
                nickname: nextNickname,
                groupName: nextGroupName,
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
