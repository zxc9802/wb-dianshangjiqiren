import { NextRequest } from 'next/server';
import { z } from 'zod';
import { errorResponse, getAuthUser } from '../../../../../lib/auth';
import { replaceMemberBotAccess, resetMemberBotAccess } from '../../../../../lib/server-admin-directory';

const replaceAccessSchema = z.object({ botKeys: z.array(z.string()).max(100) });

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        await getAuthUser(req, { requireAdmin: true });
        const { id } = await params;
        const { botKeys } = replaceAccessSchema.parse(await req.json());
        return Response.json({ success: true, data: await replaceMemberBotAccess(id, botKeys) });
    } catch (error) {
        return errorResponse(error);
    }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        await getAuthUser(req, { requireAdmin: true });
        const { id } = await params;
        return Response.json({ success: true, data: await resetMemberBotAccess(id) });
    } catch (error) {
        return errorResponse(error);
    }
}
