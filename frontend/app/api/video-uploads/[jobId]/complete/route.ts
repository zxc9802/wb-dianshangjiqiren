import { NextRequest } from 'next/server';
import { AppError, errorResponse, getUserId } from '../../../../lib/auth';
import { completeVideoUpload } from '../../../../lib/server-video-upload-jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
    try {
        const userId = await getUserId(req);
        const { jobId } = await params;
        const job = await completeVideoUpload({ jobId, userId });
        if (!job) {
            throw new AppError('视频上传任务不存在。', 404);
        }
        return Response.json({ success: true, data: job });
    } catch (error) {
        return errorResponse(error);
    }
}
