import { withUsage } from '@/app/lib/usage-context';
import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_RESPONSE_MODEL, isResponseModel } from '../../lib/chat-models';
import { processUploadedVideo, storeUploadedVideoForModelUpload } from '../../lib/server-chat-video';
import { describeImageWithGemini } from '../../lib/server-gemini-media';
import { readServerEnv } from '../../lib/server-env';

const MIME_MAP: Record<string, string> = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc: 'application/msword',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    m4v: 'video/x-m4v',
};

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm', 'm4v']);
const TEXT_EXTS = new Set(['txt', 'md', 'csv']);
const DEFAULT_MAX_FILE_SIZE = 20 * 1024 * 1024;

async function parseDocumentLocally(buffer: Buffer, ext: string): Promise<string> {
    if (TEXT_EXTS.has(ext)) {
        const text = buffer.toString('utf8');
        if (!text.trim()) {
            throw new Error('文件内容为空');
        }
        return text;
    }

    if (ext === 'docx') {
        const mammoth = await import('mammoth');
        const result = await mammoth.extractRawText({ buffer });
        if (!result.value.trim()) {
            throw new Error('Word 文档内容为空');
        }
        return result.value;
    }

    if (ext === 'pdf') {
        const { PDFParse } = await import('pdf-parse');
        const parser = new PDFParse({ data: buffer });
        try {
            const result = await parser.getText();
            if (!result.text.trim()) {
                throw new Error('PDF 文档内容为空');
            }
            return result.text;
        } finally {
            await parser.destroy();
        }
    }

    if (ext === 'doc') {
        throw new Error('暂不支持 .doc，请先另存为 .docx 后上传。');
    }

    if (ext === 'pptx') {
        throw new Error('暂不支持 PPT 解析，请先导出为 PDF、Word 或文本再上传。');
    }

    throw new Error(`不支持的文件格式: .${ext}`);
}

async function handlePost(req: NextRequest) {
    try {
        const formData = await req.formData();
        const file = formData.get('file');
        const rawResponseModel = formData.get('responseModel');
        const responseModel = isResponseModel(rawResponseModel) ? rawResponseModel : DEFAULT_RESPONSE_MODEL;

        if (!(file instanceof File)) {
            return NextResponse.json({ error: '未选择文件' }, { status: 400 });
        }

        const ext = file.name.split('.').pop()?.toLowerCase() || '';
        const mimeType = MIME_MAP[ext];
        const maxSize = Number.parseInt(readServerEnv('MAX_FILE_SIZE') || '', 10) || DEFAULT_MAX_FILE_SIZE;
        if (!VIDEO_EXTS.has(ext) && file.size > maxSize) {
            return NextResponse.json({ error: `文件大小不能超过 ${Math.round(maxSize / (1024 * 1024))}MB` }, { status: 400 });
        }

        if (!mimeType) {
            return NextResponse.json(
                { error: '不支持的文件格式，请上传 PDF、Word、TXT、Markdown、CSV、图片或视频文件。' },
                { status: 400 },
            );
        }

        const buffer = Buffer.from(await file.arrayBuffer());

        if (VIDEO_EXTS.has(ext)) {
            if (responseModel === 'gemini') {
                const staged = await storeUploadedVideoForModelUpload({
                    buffer,
                    fileName: file.name,
                    mimeType,
                });

                return NextResponse.json({
                    kind: 'video',
                    fileName: file.name,
                    fileSize: staged.fileSize,
                    mimeType: staged.mimeType,
                    content: '',
                    durationMs: undefined,
                    transcript: '',
                    frames: [],
                    tempVideoToken: staged.tempVideoToken,
                });
            }

            const processed = await processUploadedVideo({
                buffer,
                fileName: file.name,
                mimeType,
            }, {
                includeTranscript: true,
                requireFrames: true,
                requireFrameDescriptions: true,
            });

            return NextResponse.json({
                kind: 'video',
                fileName: file.name,
                fileSize: file.size,
                mimeType,
                content: processed.extractedText,
                previewUrl: processed.previewUrl,
                frames: processed.frames,
                durationMs: processed.durationMs,
                transcript: processed.transcript,
                tempVideoToken: processed.tempVideoToken,
            });
        }

        if (IMAGE_EXTS.has(ext)) {
            const content = await describeImageWithGemini(buffer.toString('base64'), mimeType);
            return NextResponse.json({
                kind: 'image',
                fileName: file.name,
                fileSize: file.size,
                mimeType,
                content: content.trim(),
            });
        }

        const content = await parseDocumentLocally(buffer, ext);
        return NextResponse.json({
            kind: 'document',
            fileName: file.name,
            fileSize: file.size,
            mimeType,
            content: content.trim(),
        });
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            return NextResponse.json({ error: '媒体解析超时，请稍后重试。' }, { status: 504 });
        }

        const message = error instanceof Error ? error.message : '文件解析失败';
        console.error('[Upload] Error:', message);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

export const POST = withUsage(handlePost);
