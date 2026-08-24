import { NextRequest } from 'next/server';
import { z } from 'zod';
import { AppError, errorResponse, getAuthUser } from '../../../../lib/auth';
import { deleteMemberAccount, setMemberActive, setMemberGroup } from '../../../../lib/server-admin-directory';

const updateMemberSchema = z.object({
    isActive: z.boolean().optional(),
    groupName: z.string().trim().max(50).optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        await getAuthUser(req, { requireAdmin: true });
        const { id } = await params;
        const data = updateMemberSchema.parse(await req.json());
        if (data.isActive === undefined && data.groupName === undefined) {
            throw new AppError('No member fields to update.', 400);
        }

        const result: { isActive?: boolean; groupName?: string } = {};
        if (data.isActive !== undefined) {
            Object.assign(result, await setMemberActive(id, data.isActive));
        }
        if (data.groupName !== undefined) {
            Object.assign(result, await setMemberGroup(id, data.groupName));
        }
        return Response.json({ success: true, data: result });
    } catch (error) {
        return errorResponse(error);
    }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        await getAuthUser(req, { requireAdmin: true });
        const { id } = await params;
        await deleteMemberAccount(id);
        return Response.json({ success: true });
    } catch (error) {
        return errorResponse(error);
    }
}
