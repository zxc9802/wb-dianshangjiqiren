import { NextRequest } from 'next/server';
import { prisma } from '../../../../../lib/prisma';
import { AppError, errorResponse, getAuthUser } from '../../../../../lib/auth';
import { deleteMemberAccount } from '../../../../../lib/server-admin-directory';

export async function POST(
    req: NextRequest,
    context: { params: Promise<{ id: string }> },
) {
    try {
        await getAuthUser(req, { requireAdmin: true });
        const { id } = await context.params;

        const inviteCode = await prisma.inviteCode.findUnique({
            where: { id },
            select: {
                id: true,
                usedByUserId: true,
            },
        });

        if (!inviteCode) {
            throw new AppError('Invite code not found.', 404);
        }

        if (!inviteCode.usedByUserId) {
            throw new AppError('This invite code is not in use.', 400);
        }

        await deleteMemberAccount(inviteCode.usedByUserId, {
            releaseInviteCodeId: inviteCode.id,
        });

        return Response.json({ success: true });
    } catch (error) {
        return errorResponse(error);
    }
}
