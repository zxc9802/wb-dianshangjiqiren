import type { NextRequest } from 'next/server';
import { AppError, errorResponse, getUserId } from '@/app/lib/auth';
import { createChatShare } from '@/app/lib/chat-sharing';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const userId = await getUserId(req);
        const { id } = await params;
        const text = await req.text();
        if (text.length > 32768) throw new AppError('所选消息过多。', 413);
        let input: unknown;
        try { input = JSON.parse(text); } catch { throw new AppError('请求格式无效。', 400); }
        const path = await createChatShare(userId, id, input);
        return Response.json({ success: true, data: { path } }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) { return errorResponse(error); }
}
