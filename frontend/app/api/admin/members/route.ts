import { NextRequest } from 'next/server';
import { errorResponse, getAuthUser } from '../../../lib/auth';
import { listAdminMembers } from '../../../lib/server-admin-directory';

export async function GET(req: NextRequest) {
    try {
        await getAuthUser(req, { requireAdmin: true });
        return Response.json({ success: true, data: await listAdminMembers() });
    } catch (error) {
        return errorResponse(error);
    }
}
