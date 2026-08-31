import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../../lib/prisma';
import { AppError, getAuthUser, errorResponse } from '../../../lib/auth';
import { assertLoginAccountAvailable } from '../../../lib/server-account-lookup';
import { getUserBotAccessSummary } from '../../../lib/server-bot-access';
import { getUserModelAccessSummary } from '../../../lib/server-model-access';

const updateProfileSchema = z.object({
    account: z.string().trim().min(1, '请填写账号。'),
});

function serializeUser(user: {
    id: string;
    email: string;
    nickname: string;
    groupName: string;
    avatar: string;
    role: string;
    createdAt: Date;
}) {
    return {
        id: user.id,
        account: user.email,
        nickname: user.nickname,
        groupName: user.groupName,
        avatar: user.avatar,
        role: user.role,
        createdAt: user.createdAt,
    };
}

export async function GET(req: NextRequest) {
    try {
        const user = await getAuthUser(req);
        const [botAccess, modelAccess] = await Promise.all([
            getUserBotAccessSummary(user.id, user.role),
            getUserModelAccessSummary(user.id, user.role),
        ]);
        return Response.json({
            success: true,
            data: { ...serializeUser(user), botAccess, modelAccess },
        });
    } catch (err) {
        return errorResponse(err);
    }
}

export async function PATCH(req: NextRequest) {
    try {
        const user = await getAuthUser(req);
        const data = updateProfileSchema.parse(await req.json());
        const nextAccount = data.account.trim();
        await assertLoginAccountAvailable(prisma, nextAccount, user.id);

        const updated = await prisma.user.update({
            where: { id: user.id },
            data: {
                email: nextAccount,
                nickname: nextAccount,
            },
            select: {
                id: true,
                email: true,
                nickname: true,
                groupName: true,
                avatar: true,
                role: true,
                createdAt: true,
            },
        });

        if (!updated) {
            throw new AppError('Account not found.', 404);
        }

        const [botAccess, modelAccess] = await Promise.all([
            getUserBotAccessSummary(updated.id, updated.role),
            getUserModelAccessSummary(updated.id, updated.role),
        ]);

        return Response.json({
            success: true,
            data: { ...serializeUser(updated), botAccess, modelAccess },
        });
    } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            return errorResponse(new AppError('该账号已被使用。', 409, 'ACCOUNT_EXISTS'));
        }
        return errorResponse(err);
    }
}
