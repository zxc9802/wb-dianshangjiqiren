import { assertUserCanAccessOfficialBot } from '@/app/lib/server-bot-access';
import { NextRequest } from 'next/server';
import { errorResponse, getAuthUser } from '@/app/lib/auth';
import {
    buildExternalSsoCallbackUrl,
    createExternalSsoTicket,
    parseExternalSsoProduct,
    parseExternalSsoRedirectPath,
} from '@/app/lib/external-sso';

async function readRequestBody(req: NextRequest): Promise<unknown> {
    try {
        return await req.json();
    } catch {
        return {};
    }
}

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ product: string }> },
) {
    try {
        const product = parseExternalSsoProduct((await params).product);
        const user = await getAuthUser(req);
        await assertUserCanAccessOfficialBot(user.id, product, user.role);
        // Validate deployment configuration before issuing a ticket.
        buildExternalSsoCallbackUrl(product, "");
        const body = await readRequestBody(req) as { redirectPath?: unknown };
        const ticket = await createExternalSsoTicket(
            product,
            user.id,
            parseExternalSsoRedirectPath(body.redirectPath),
        );

        return Response.json({
            url: buildExternalSsoCallbackUrl(product, ticket.id),
            expiresAt: ticket.expiresAt,
        });
    } catch (error) {
        return errorResponse(error);
    }
}
