import { NextRequest } from 'next/server';
import { errorResponse, getAuthUser } from '../../../lib/auth';
import { OFFICIAL_BOT_CATALOG } from '../../../lib/bot-access-catalog';

export async function GET(req: NextRequest) {
    try {
        await getAuthUser(req, { requireAdmin: true });
        return Response.json({ success: true, data: OFFICIAL_BOT_CATALOG });
    } catch (error) {
        return errorResponse(error);
    }
}
