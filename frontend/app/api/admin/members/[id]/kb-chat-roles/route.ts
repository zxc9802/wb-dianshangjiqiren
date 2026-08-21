import { NextRequest } from 'next/server';
import { z } from 'zod';
import { errorResponse, getAuthUser } from '../../../../../lib/auth';
import { replaceMemberKbChatRoles, resetMemberKbChatRoles } from '../../../../../lib/server-admin-directory';

const replaceRolesSchema = z.object({ roleKeys: z.array(z.string()).max(20) });

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        await getAuthUser(req, { requireAdmin: true });
        const { id } = await params;
        const { roleKeys } = replaceRolesSchema.parse(await req.json());
        return Response.json({ success: true, data: await replaceMemberKbChatRoles(id, roleKeys) });
    } catch (error) {
        return errorResponse(error);
    }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        await getAuthUser(req, { requireAdmin: true });
        const { id } = await params;
        return Response.json({ success: true, data: await resetMemberKbChatRoles(id) });
    } catch (error) {
        return errorResponse(error);
    }
}
