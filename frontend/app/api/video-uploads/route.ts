import { NextRequest } from 'next/server';
import { AppError, errorResponse, getUserId } from '../../lib/auth';
import { createVideoUploadJob } from '../../lib/server-video-upload-jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
    try {
        const userId = await getUserId(req);
        const body = await req.json() as Record<string, unknown>;
        const fileName = typeof body.fileName === 'string' ? body.fileName.trim() : '';
        const fileSize = typeof body.fileSize === 'number' ? body.fileSize : Number.NaN;
        const mimeType = typeof body.mimeType === 'string' ? body.mimeType.trim() : '';
        const responseModel = typeof body.responseModel === 'string' ? body.responseModel.trim() : '';
        const analysisPrompt = typeof body.analysisPrompt === 'string' ? body.analysisPrompt.trim().slice(0, 4000) : '';
        if (!fileName || !Number.isInteger(fileSize) || fileSize <= 0 || !responseModel) {
            throw new AppError('视频上传参数不完整。', 400);
        }

        const job = await createVideoUploadJob({ userId, fileName, fileSize, mimeType, responseModel, analysisPrompt });
        return Response.json({ success: true, data: job }, { status: 201 });
    } catch (error) {
        return errorResponse(error);
    }
}
