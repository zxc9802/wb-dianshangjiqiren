import { NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '../../../lib/prisma';
import { AppError, getAuthUser, errorResponse } from '../../../lib/auth';
import { getUserBotAccessSummary } from '../../../lib/server-bot-access';

const updateProfileSchema = z.object({
    nickname: z.string().trim().min(1, '请填写账号名称。').max(50, '账号名称过长。'),
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
        const botAccess = await getUserBotAccessSummary(user.id, user.role);
        return Response.json({
            success: true,
            data: { ...serializeUser(user), botAccess },
        });
    } catch (err) {
        return errorResponse(err);
    }
}

export async function PATCH(req: NextRequest) {
    try {
        const user = await getAuthUser(req);
        const data = updateProfileSchema.parse(await req.json());
        const nextNickname = data.nickname.trim();

        const updated = await prisma.user.update({
            where: { id: user.id },
            data: { nickname: nextNickname },
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

        const botAccess = await getUserBotAccessSummary(updated.id, updated.role);

        return Response.json({
            success: true,
            data: { ...serializeUser(updated), botAccess },
        });
    } catch (err) {
        return errorResponse(err);
    }
}
