import { AppError, errorResponse } from '@/app/lib/auth';
import { getChatShare } from '@/app/lib/chat-sharing';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
    try {
        const { token } = await params;
        const snapshot = await getChatShare(token);
        if (!snapshot) throw new AppError('分享链接不存在或已失效。', 404);
        return Response.json({ success: true, data: snapshot }, { headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } });
    } catch (error) { return errorResponse(error); }
}
