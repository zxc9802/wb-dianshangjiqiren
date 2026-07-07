import { NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '../../../lib/prisma';
import { AppError, getAuthUser, errorResponse } from '../../../lib/auth';

const updateProfileSchema = z.object({
    nickname: z.string().trim().min(1, 'Nickname is required.').max(20, 'Nickname is too long.'),
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
        return Response.json({
            success: true,
            data: serializeUser(user),
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

        return Response.json({
            success: true,
            data: serializeUser(updated),
        });
    } catch (err) {
        return errorResponse(err);
    }
}
