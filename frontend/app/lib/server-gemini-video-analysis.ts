import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { analyzeVideoSegmentWithGemini } from './server-gemini-media';
import {
    deleteTempVideo,
    getTempVideoFileInfo,
    loadTempVideo,
    splitVideoFileByTime,
    storeUploadedVideoFileForModelUpload,
    type VideoProcessingStageUpdate,
} from './server-chat-video';
import { readServerEnv } from './server-env';
import { requestYunwuGeminiChat } from './yunwu-gemini-chat';
import type { ChatAttachmentPayload } from './api';

export const DEFAULT_GEMINI_VIDEO_MAX_BYTES = 18 * 1024 * 1024;
export const DEFAULT_GEMINI_SEGMENT_TARGET_BYTES = 15 * 1024 * 1024;
export const DEFAULT_GEMINI_SEGMENT_MAX_SECONDS = 90;

export function shouldSegmentGeminiVideo(fileSize: number, maxBytes: number): boolean {
    return fileSize > maxBytes;
}

export function planGeminiVideoSegments(params: {
    fileSize: number;
    durationMs: number;
    targetBytes: number;
    maxSegmentSeconds: number;
}): { segmentSeconds: number; totalSegments: number } {
    if (params.fileSize <= 0 || params.durationMs <= 0 || params.targetBytes <= 0 || params.maxSegmentSeconds <= 0) {
        throw new Error('Invalid Gemini video segment planning input.');
    }
    const durationSeconds = params.durationMs / 1000;
    const sizeBasedSeconds = Math.floor((durationSeconds * params.targetBytes) / params.fileSize);
    const segmentSeconds = Math.min(params.maxSegmentSeconds, Math.max(10, sizeBasedSeconds));
    return {
        segmentSeconds,
        totalSegments: Math.ceil(durationSeconds / segmentSeconds),
    };
}

type PreparedSegment = {
    token: string;
    startMs: number;
    endMs: number;
};

function readPositiveInt(key: string, fallback: number): number {
    const parsed = Number.parseInt(readServerEnv(key) || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatTimestamp(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

async function prepareSegmentUnderLimit(params: {
    absolutePath: string;
    fileSize: number;
    durationMs: number;
    startMs: number;
    maxBytes: number;
    workRoot: string;
    tokensToCleanup: Set<string>;
    depth?: number;
}): Promise<PreparedSegment[]> {
    const depth = params.depth || 0;
    const fileName = path.basename(params.absolutePath);
    const staged = await storeUploadedVideoFileForModelUpload({
        absolutePath: params.absolutePath,
        fileName,
        mimeType: 'video/mp4',
        fileSize: params.fileSize,
    });
    params.tokensToCleanup.add(staged.tempVideoToken);
    const info = await getTempVideoFileInfo(staged.tempVideoToken);
    if (!shouldSegmentGeminiVideo(info.fileSize, params.maxBytes)) {
        return [{ token: staged.tempVideoToken, startMs: params.startMs, endMs: params.startMs + params.durationMs }];
    }

    if (params.durationMs <= 10_000 || depth >= 6) {
        await deleteTempVideo(staged.tempVideoToken);
        params.tokensToCleanup.delete(staged.tempVideoToken);
        throw new Error(`视频片段 ${formatTimestamp(params.startMs)}-${formatTimestamp(params.startMs + params.durationMs)} 压缩后仍超过18MB。`);
    }

    const childDirectory = path.join(params.workRoot, `split-${depth}-${randomUUID()}`);
    const children = await splitVideoFileByTime({
        absolutePath: info.absolutePath,
        outputDirectory: childDirectory,
        segmentSeconds: Math.max(10, Math.floor(params.durationMs / 2000)),
    });
    await deleteTempVideo(staged.tempVideoToken);
    params.tokensToCleanup.delete(staged.tempVideoToken);

    const prepared: PreparedSegment[] = [];
    let childStartMs = params.startMs;
    for (const child of children) {
        prepared.push(...await prepareSegmentUnderLimit({
            absolutePath: child.absolutePath,
            fileSize: child.fileSize,
            durationMs: child.durationMs,
            startMs: childStartMs,
            maxBytes: params.maxBytes,
            workRoot: params.workRoot,
            tokensToCleanup: params.tokensToCleanup,
            depth: depth + 1,
        }));
        childStartMs += child.durationMs;
    }
    return prepared;
}

async function analyzeWithRetry(params: {
    segment: PreparedSegment;
    index: number;
    total: number;
    analysisPrompt: string;
    tokensToCleanup: Set<string>;
    onStage?: (update: VideoProcessingStageUpdate) => void | Promise<void>;
}): Promise<string> {
    await params.onStage?.({
        stage: 'analyzing',
        message: `正在分析第 ${params.index + 1}/${params.total} 段。`,
    });
    const temp = await loadTempVideo(params.segment.token);
    const timeRange = `${formatTimestamp(params.segment.startMs)}-${formatTimestamp(params.segment.endMs)}`;
    const prompt = [
        `视频片段时间范围：${timeRange}`,
        `用户分析问题：${params.analysisPrompt}`,
        '请只根据本片段实际内容，按以下字段输出结构化分析：',
        '1. 画面内容',
        '2. 人物动作',
        '3. 台词与语气',
        '4. 镜头运动',
        '5. 节奏变化',
        '6. 情绪变化',
        '7. 转化设计',
        '不得推测片段中不存在的内容。',
    ].join('\n');

    try {
        let lastError: unknown;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                return await analyzeVideoSegmentWithGemini(temp.buffer.toString('base64'), temp.mimeType, prompt);
            } catch (error) {
                lastError = error;
                if (attempt < 2) {
                    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
                }
            }
        }
        throw lastError instanceof Error ? lastError : new Error(`第 ${params.index + 1} 段分析失败。`);
    } finally {
        await deleteTempVideo(params.segment.token);
        params.tokensToCleanup.delete(params.segment.token);
    }
}

async function analyzeSegmentsWithConcurrency(params: {
    segments: PreparedSegment[];
    analysisPrompt: string;
    tokensToCleanup: Set<string>;
    onStage?: (update: VideoProcessingStageUpdate) => void | Promise<void>;
}): Promise<string[]> {
    const results = new Array<string>(params.segments.length);
    let cursor = 0;
    const worker = async () => {
        while (true) {
            const index = cursor;
            cursor += 1;
            if (index >= params.segments.length) return;
            results[index] = await analyzeWithRetry({
                segment: params.segments[index],
                index,
                total: params.segments.length,
                analysisPrompt: params.analysisPrompt,
                tokensToCleanup: params.tokensToCleanup,
                onStage: params.onStage,
            });
        }
    };
    await Promise.all(Array.from({ length: Math.min(2, params.segments.length) }, () => worker()));
    return results;
}

export async function analyzeUploadedVideoForGemini(params: {
    absolutePath: string;
    fileName: string;
    mimeType: string;
    fileSize: number;
    analysisPrompt: string;
    onStage?: (update: VideoProcessingStageUpdate) => void | Promise<void>;
}): Promise<ChatAttachmentPayload> {
    const maxBytes = readPositiveInt('GEMINI_VIDEO_MAX_BYTES', DEFAULT_GEMINI_VIDEO_MAX_BYTES);
    const targetBytes = readPositiveInt('GEMINI_VIDEO_SEGMENT_TARGET_BYTES', DEFAULT_GEMINI_SEGMENT_TARGET_BYTES);
    const maxSegmentSeconds = readPositiveInt('GEMINI_VIDEO_SEGMENT_MAX_SECONDS', DEFAULT_GEMINI_SEGMENT_MAX_SECONDS);
    const analysisPrompt = params.analysisPrompt.trim() || '请完整拆解视频的画面、人物、台词、镜头、节奏、情绪和转化设计。';
    const full = await storeUploadedVideoFileForModelUpload({
        absolutePath: params.absolutePath,
        fileName: params.fileName,
        mimeType: params.mimeType,
        fileSize: params.fileSize,
        onStage: params.onStage,
    });
    const fullInfo = await getTempVideoFileInfo(full.tempVideoToken);
    if (!shouldSegmentGeminiVideo(fullInfo.fileSize, maxBytes)) {
        return {
            kind: 'video',
            fileName: params.fileName,
            fileSize: full.fileSize,
            mimeType: full.mimeType,
            extractedText: '',
            transcript: '',
            frames: [],
            tempVideoToken: full.tempVideoToken,
        };
    }

    if (!fullInfo.durationMs) {
        await deleteTempVideo(full.tempVideoToken);
        throw new Error('无法读取视频时长，不能安全切分给Gemini。');
    }

    const workRoot = path.join(process.cwd(), 'storage', 'gemini-video-segments', randomUUID());
    await fs.mkdir(workRoot, { recursive: true });
    let fullToken: string | undefined = full.tempVideoToken;
    const segmentTokensToCleanup = new Set<string>();
    try {
        await params.onStage?.({ stage: 'analyzing', message: '正在切分视频。' });
        const plan = planGeminiVideoSegments({
            fileSize: fullInfo.fileSize,
            durationMs: fullInfo.durationMs,
            targetBytes,
            maxSegmentSeconds,
        });
        const rawSegments = await splitVideoFileByTime({
            absolutePath: fullInfo.absolutePath,
            outputDirectory: workRoot,
            segmentSeconds: plan.segmentSeconds,
        });
        await deleteTempVideo(fullToken);
        fullToken = undefined;

        const segments: PreparedSegment[] = [];
        let startMs = 0;
        for (const segment of rawSegments) {
            segments.push(...await prepareSegmentUnderLimit({
                absolutePath: segment.absolutePath,
                fileSize: segment.fileSize,
                durationMs: segment.durationMs,
                startMs,
                maxBytes,
                workRoot,
                tokensToCleanup: segmentTokensToCleanup,
            }));
            startMs += segment.durationMs;
        }

        const segmentResults = await analyzeSegmentsWithConcurrency({
            segments,
            analysisPrompt,
            tokensToCleanup: segmentTokensToCleanup,
            onStage: params.onStage,
        });
        await params.onStage?.({ stage: 'analyzing', message: '正在综合全部片段。' });
        const evidence = segmentResults.map((result, index) => {
            const segment = segments[index];
            return `## 片段 ${index + 1}（${formatTimestamp(segment.startMs)}-${formatTimestamp(segment.endMs)}）\n${result}`;
        }).join('\n\n');
        const synthesis = await requestYunwuGeminiChat({
            systemPrompt: '你是专业的视频分析师。必须基于分段证据综合，不得编造，保留关键时间点，并直接回答用户问题。',
            messages: [{ role: 'user', content: `用户问题：${analysisPrompt}\n\n分段证据：\n${evidence}` }],
            temperature: 0.2,
            topP: 0.8,
            maxOutputTokens: 8192,
        });
        if (!synthesis.trim()) {
            throw new Error('Gemini综合分析结果为空。');
        }
        return {
            kind: 'video',
            fileName: params.fileName,
            fileSize: params.fileSize,
            mimeType: params.mimeType,
            extractedText: `# 综合结论\n${synthesis.trim()}\n\n# 分段依据\n${evidence}`,
            transcript: '',
            frames: [],
        };
    } finally {
        if (fullToken) await deleteTempVideo(fullToken).catch(() => undefined);
        await Promise.all(Array.from(segmentTokensToCleanup, (token) => deleteTempVideo(token)));
        await fs.rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
    }
}
