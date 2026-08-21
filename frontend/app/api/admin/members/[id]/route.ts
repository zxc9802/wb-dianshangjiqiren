import { NextRequest } from 'next/server';
import { z } from 'zod';
import { errorResponse, getAuthUser } from '../../../../lib/auth';
import { deleteMemberAccount, setMemberActive } from '../../../../lib/server-admin-directory';

const updateMemberSchema = z.object({ isActive: z.boolean() });

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        await getAuthUser(req, { requireAdmin: true });
        const { id } = await params;
        const { isActive } = updateMemberSchema.parse(await req.json());
        return Response.json({ success: true, data: await setMemberActive(id, isActive) });
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
