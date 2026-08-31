import { NextRequest } from 'next/server';
import { z } from 'zod';
import { errorResponse, getAuthUser } from '../../../../../lib/auth';
import {
    replaceMemberModelAccess,
    resetMemberModelAccess,
} from '../../../../../lib/server-admin-directory';

const replaceModelAccessSchema = z.object({
    sites: z.array(z.object({
        siteKey: z.string(),
        mode: z.literal('selected'),
        modelKeys: z.array(z.string()).max(20),
    })).max(10),
});

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        await getAuthUser(req, { requireAdmin: true });
        const { id } = await params;
        const { sites } = replaceModelAccessSchema.parse(await req.json());
        return Response.json({ success: true, data: await replaceMemberModelAccess(id, sites) });
    } catch (error) {
        return errorResponse(error);
    }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        await getAuthUser(req, { requireAdmin: true });
        const { id } = await params;
        return Response.json({ success: true, data: await resetMemberModelAccess(id) });
    } catch (error) {
        return errorResponse(error);
    }
}
