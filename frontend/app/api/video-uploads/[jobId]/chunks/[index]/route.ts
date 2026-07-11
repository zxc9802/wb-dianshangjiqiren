import { NextRequest } from 'next/server';
import { AppError, errorResponse, getUserId } from '../../../../../lib/auth';
import { recordVideoUploadChunk } from '../../../../../lib/server-video-upload-jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(req: NextRequest, { params }: { params: Promise<{ jobId: string; index: string }> }) {
    try {
        const userId = await getUserId(req);
        const { jobId, index: rawIndex } = await params;
        const index = Number(rawIndex);
        if (!Number.isInteger(index) || index < 0) {
            throw new AppError('无效的视频分片编号。', 400);
        }
        const bytes = Buffer.from(await req.arrayBuffer());
        const job = await recordVideoUploadChunk({ jobId, userId, index, bytes });
        if (!job) {
            throw new AppError('视频上传任务不存在。', 404);
        }
        return Response.json({ success: true, data: job });
    } catch (error) {
        return errorResponse(error);
    }
}
