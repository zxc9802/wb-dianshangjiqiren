import { NextRequest } from 'next/server';
import { AppError, assertMemberAccountEnabled, ensureAccessControlBootstrap, errorResponse } from '@/app/lib/auth';
import { parseExternalSsoProduct, isValidExternalSsoClientSecret, getExternalSsoClientSecretHeaderName } from '@/app/lib/external-sso';
import { assertUserCanAccessOfficialBot } from '@/app/lib/server-bot-access';
import { prisma } from '@/app/lib/prisma';
import { recordToolRequest, toolRequestSchema } from '@/app/lib/sso-tool-requests';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(req: NextRequest) {
    try {
        const input = toolRequestSchema.parse(await req.json());
        const product = parseExternalSsoProduct(input.product);
        if (!isValidExternalSsoClientSecret(product, req.headers.get(getExternalSsoClientSecretHeaderName()))) {
            throw new AppError('Unauthorized SSO client.', 401);
        }
        await ensureAccessControlBootstrap();
        const user = await prisma.user.findUnique({ where: { id: input.userId },
            select: { id: true, role: true, isActive: true, accessGrantedAt: true } });
        if (!user) throw new AppError('Account not found.', 404);
        // In-flight work may still close and record its usage after access is revoked.
        if (input.action === 'reserve') {
            assertMemberAccountEnabled(user);
            if (user.role !== 'admin' && !user.accessGrantedAt) throw new AppError('Invite code required.', 403);
            await assertUserCanAccessOfficialBot(user.id, product, user.role);
        }
        return Response.json({ success: true, data: await recordToolRequest(input) });
    } catch (error) { return errorResponse(error); }
}
