import { NextRequest } from 'next/server';
import { getAuthUser, errorResponse } from '@/app/lib/auth';
import { assertUserCanAccessOfficialBot } from '@/app/lib/server-bot-access';
import {
    buildDetailImageAgentSsoUrl,
    createDetailImageAgentSsoTicket,
    parseDetailImageAgentRedirectPath,
} from '@/app/lib/detail-image-agent-sso';

async function readRequestBody(req: NextRequest): Promise<unknown> {
    try {
        return await req.json();
    } catch {
        return {};
    }
}

export async function POST(req: NextRequest) {
    try {
        const user = await getAuthUser(req);
        await assertUserCanAccessOfficialBot(user.id, 'detail-image-agent', user.role);
        const body = await readRequestBody(req) as { redirectPath?: unknown };
        const ticket = await createDetailImageAgentSsoTicket(
            user.id,
            parseDetailImageAgentRedirectPath(body.redirectPath),
        );
        const mainAppUrl = req.nextUrl.origin;

        return Response.json({
            url: buildDetailImageAgentSsoUrl(ticket.id, { mainAppUrl }),
            expiresAt: ticket.expiresAt,
        });
    } catch (error) {
        return errorResponse(error);
    }
}
