import { NextRequest } from 'next/server';
import { getAuthUser, errorResponse } from '@/app/lib/auth';
import { assertUserCanAccessOfficialBot } from '@/app/lib/server-bot-access';
import {
    buildKbChatSsoUrl,
    createKbChatSsoTicket,
    parseKbChatRedirectPath,
} from '@/app/lib/kb-chat-sso';

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
        await assertUserCanAccessOfficialBot(user.id, 'kb-chat', user.role);
        const body = await readRequestBody(req) as { redirectPath?: unknown };
        const ticket = await createKbChatSsoTicket(user.id, parseKbChatRedirectPath(body.redirectPath));
        const mainAppUrl = req.nextUrl.origin;

        return Response.json({
            url: buildKbChatSsoUrl(ticket.id, { mainAppUrl }),
            expiresAt: ticket.expiresAt,
        });
    } catch (error) {
        return errorResponse(error);
    }
}
