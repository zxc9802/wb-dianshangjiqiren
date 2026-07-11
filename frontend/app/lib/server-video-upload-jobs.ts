import path from 'node:path';
import type { Prisma } from '@prisma/client';
import { AppError } from './auth';
import { isResponseModel, type ResponseModel } from './chat-models';
import { prisma } from './prisma';
import { readServerEnv } from './server-env';
import {
    processUploadedVideoFile,
    storeUploadedVideoFileForModelUpload,
    type VideoProcessingStageUpdate,
} from './server-chat-video';
import {
    cleanupStaleVideoUploadDirectories,
    cleanupVideoUploadChunks,
    cleanupVideoUploadDirectory,
    hasVideoChunk,
    mergeVideoChunks,
    writeVideoChunk,
} from './server-video-upload-storage';
import type {
    CreateVideoUploadInput,
    VideoUploadJobSnapshot,
    VideoUploadStage,
    VideoUploadJobStatus,
} from './video-upload-types';
import type { ChatAttachmentPayload } from './api';

const CHUNK_UPLOAD_THRESHOLD_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 5 * 1024 * 1024;
const DEFAULT_JOB_TTL_MS = 2 * 60 * 60 * 1000;
const VIDEO_MIME_BY_EXTENSION: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.m4v': 'video/x-m4v',
};

type JobWithCount = {
    id: string;
    userId: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
    responseModel: string;
    chunkSize: number;
    totalChunks: number;
    status: string;
    stage: string;
    message: string;
    result: unknown;
    error: string | null;
    _count: { chunks: number };
};

type JobWithChunks = JobWithCount & {
    chunks: Array<{ index: number; byteSize: number }>;
};

const globalWithVideoJobs = globalThis as typeof globalThis & {
    __activeVideoUploadJobs?: Map<string, Promise<void>>;
};

export const activeVideoUploadJobs = globalWithVideoJobs.__activeVideoUploadJobs || new Map<string, Promise<void>>();
globalWithVideoJobs.__activeVideoUploadJobs = activeVideoUploadJobs;

function readPositiveInt(key: string, fallback: number): number {
    const parsed = Number.parseInt(readServerEnv(key) || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getJobTtlMs(): number {
    return readPositiveInt('VIDEO_UPLOAD_JOB_TTL_MS', DEFAULT_JOB_TTL_MS);
}

function toSnapshot(job: JobWithCount): VideoUploadJobSnapshot {
    const uploadedChunks = job._count.chunks;
    return {
        id: job.id,
        status: job.status as VideoUploadJobStatus,
        stage: job.stage as VideoUploadStage,
        message: job.message,
        chunkSize: job.chunkSize,
        totalChunks: job.totalChunks,
        uploadedChunks,
        uploadPercent: job.totalChunks > 0 ? Math.min(100, Math.round((uploadedChunks / job.totalChunks) * 100)) : 0,
        result: job.result && typeof job.result === 'object' ? job.result as ChatAttachmentPayload : undefined,
        error: job.error || undefined,
    };
}

async function findOwnedJob(jobId: string, userId: string): Promise<JobWithCount | null> {
    return prisma.videoUploadJob.findFirst({
        where: { id: jobId, userId },
        include: { _count: { select: { chunks: true } } },
    }) as unknown as Promise<JobWithCount | null>;
}

async function updateJob(jobId: string, data: Record<string, unknown>): Promise<JobWithCount> {
    return prisma.videoUploadJob.update({
        where: { id: jobId },
        data: data as Prisma.VideoUploadJobUpdateInput,
        include: { _count: { select: { chunks: true } } },
    }) as unknown as Promise<JobWithCount>;
}

async function cleanupExpiredJobs(): Promise<void> {
    const ttlMs = getJobTtlMs();
    const cutoff = new Date(Date.now() - ttlMs);
    const expired = await prisma.videoUploadJob.findMany({
        where: { updatedAt: { lt: cutoff } },
        select: { id: true },
    });
    await Promise.all(expired.map((job) => cleanupVideoUploadDirectory(job.id)));
    if (expired.length > 0) {
        await prisma.videoUploadJob.deleteMany({ where: { id: { in: expired.map((job) => job.id) } } });
    }
    await cleanupStaleVideoUploadDirectories(ttlMs);
}

function validateCreateInput(input: CreateVideoUploadInput): { extension: string; responseModel: ResponseModel } {
    if (!Number.isInteger(input.fileSize) || input.fileSize <= CHUNK_UPLOAD_THRESHOLD_BYTES) {
        throw new AppError('20MB及以下视频请使用普通上传。', 400);
    }
    const maxBytes = readPositiveInt('VIDEO_UPLOAD_MAX_BYTES', DEFAULT_MAX_VIDEO_BYTES);
    if (input.fileSize > maxBytes) {
        throw new AppError(`视频大小不能超过 ${Math.round(maxBytes / (1024 * 1024))}MB。`, 400);
    }
    const extension = path.extname(input.fileName).toLowerCase();
    if (!VIDEO_MIME_BY_EXTENSION[extension]) {
        throw new AppError('不支持的视频格式。', 400);
    }
    if (input.mimeType && input.mimeType !== VIDEO_MIME_BY_EXTENSION[extension]) {
        throw new AppError('视频格式与文件类型不匹配。', 400);
    }
    if (!isResponseModel(input.responseModel)) {
        throw new AppError('无效的回答模型。', 400);
    }
    return { extension, responseModel: input.responseModel };
}

export async function createVideoUploadJob(input: CreateVideoUploadInput & { userId: string }): Promise<VideoUploadJobSnapshot> {
    await cleanupExpiredJobs();
    const { responseModel } = validateCreateInput(input);
    const chunkSize = readPositiveInt('VIDEO_UPLOAD_CHUNK_BYTES', DEFAULT_CHUNK_BYTES);
    const totalChunks = Math.ceil(input.fileSize / chunkSize);
    const job = await prisma.videoUploadJob.create({
        data: {
            userId: input.userId,
            fileName: path.basename(input.fileName),
            fileSize: input.fileSize,
            mimeType: input.mimeType || VIDEO_MIME_BY_EXTENSION[path.extname(input.fileName).toLowerCase()],
            responseModel,
            chunkSize,
            totalChunks,
            status: 'uploading',
            stage: 'uploading',
            message: '正在上传视频。',
        },
        include: { _count: { select: { chunks: true } } },
    }) as unknown as JobWithCount;
    return toSnapshot(job);
}

function expectedChunkBytes(job: JobWithCount, index: number): number {
    if (!Number.isInteger(index) || index < 0 || index >= job.totalChunks) {
        throw new AppError('无效的视频分片编号。', 400);
    }
    if (index < job.totalChunks - 1) return job.chunkSize;
    return job.fileSize - (job.chunkSize * (job.totalChunks - 1));
}

export async function recordVideoUploadChunk(input: {
    jobId: string;
    userId: string;
    index: number;
    bytes: Buffer;
}): Promise<VideoUploadJobSnapshot | null> {
    const job = await findOwnedJob(input.jobId, input.userId);
    if (!job) return null;
    if (job.status !== 'uploading') {
        throw new AppError('该视频任务已停止接收分片。', 409);
    }
    const expectedBytes = expectedChunkBytes(job, input.index);
    if (input.bytes.length !== expectedBytes) {
        throw new AppError(`视频分片大小错误，应为 ${expectedBytes} 字节。`, 400);
    }

    const stored = await writeVideoChunk({ jobId: job.id, index: input.index, bytes: input.bytes });
    await prisma.videoUploadChunk.upsert({
        where: { jobId_index: { jobId: job.id, index: input.index } },
        create: { jobId: job.id, index: input.index, byteSize: stored.byteSize },
        update: { byteSize: stored.byteSize },
    });
    const updated = await findOwnedJob(job.id, input.userId);
    return updated ? toSnapshot(updated) : null;
}

async function assertAllChunksPresent(job: JobWithChunks): Promise<void> {
    const records = new Map(job.chunks.map((chunk) => [chunk.index, chunk.byteSize]));
    const missing: number[] = [];
    for (let index = 0; index < job.totalChunks; index += 1) {
        const expectedBytes = expectedChunkBytes(job, index);
        if (records.get(index) !== expectedBytes || !await hasVideoChunk({ jobId: job.id, index, expectedBytes })) {
            missing.push(index);
        }
    }
    if (missing.length > 0) {
        throw new AppError(`视频分片不完整，请重传：${missing.join(', ')}`, 409);
    }
}

async function updateProcessingStage(jobId: string, update: VideoProcessingStageUpdate): Promise<void> {
    await prisma.videoUploadJob.update({
        where: { id: jobId },
        data: { status: 'running', stage: update.stage, message: update.message },
    });
}

export async function runVideoUploadJob(job: JobWithChunks): Promise<void> {
    let mergedPath: string | undefined;
    try {
        await updateJob(job.id, { status: 'running', stage: 'merging', message: '正在合并视频分片。' });
        const extension = path.extname(job.fileName).toLowerCase();
        mergedPath = await mergeVideoChunks({ jobId: job.id, totalChunks: job.totalChunks, extension });

        await prisma.videoUploadChunk.deleteMany({ where: { jobId: job.id } });
        await cleanupVideoUploadChunks(job.id);

        let result: ChatAttachmentPayload;
        if (job.responseModel === 'gemini') {
            const staged = await storeUploadedVideoFileForModelUpload({
                absolutePath: mergedPath,
                fileName: job.fileName,
                mimeType: job.mimeType,
                fileSize: job.fileSize,
                onStage: (update) => updateProcessingStage(job.id, update),
            });
            mergedPath = undefined;
            result = {
                kind: 'video',
                fileName: job.fileName,
                fileSize: staged.fileSize,
                mimeType: staged.mimeType,
                extractedText: '',
                transcript: '',
                frames: [],
                tempVideoToken: staged.tempVideoToken,
            };
        } else {
            const processed = await processUploadedVideoFile({
                absolutePath: mergedPath,
                fileName: job.fileName,
                mimeType: job.mimeType,
                fileSize: job.fileSize,
            }, {
                includeTranscript: true,
                includeFrameDescriptions: true,
                requireFrames: true,
                requireFrameDescriptions: true,
                onStage: (update) => updateProcessingStage(job.id, update),
            });
            mergedPath = undefined;
            result = {
                kind: 'video',
                fileName: job.fileName,
                fileSize: job.fileSize,
                mimeType: job.mimeType,
                extractedText: processed.extractedText,
                transcript: processed.transcript,
                durationMs: processed.durationMs,
                previewUrl: processed.previewUrl,
                frames: processed.frames,
                tempVideoToken: processed.tempVideoToken,
            };
        }

        await updateJob(job.id, {
            status: 'succeeded',
            stage: 'complete',
            message: '视频处理完成。',
            result: result as unknown as Prisma.InputJsonValue,
            error: null,
            completedAt: new Date(),
        });
    } catch (error) {
        await prisma.videoUploadChunk.deleteMany({ where: { jobId: job.id } }).catch(() => undefined);
        await updateJob(job.id, {
            status: 'failed',
            stage: 'complete',
            message: '视频处理失败。',
            error: error instanceof Error ? error.message : '视频处理失败。',
            completedAt: new Date(),
        }).catch(() => undefined);
    } finally {
        await cleanupVideoUploadDirectory(job.id);
    }
}

export async function completeVideoUpload(input: { jobId: string; userId: string }): Promise<VideoUploadJobSnapshot | null> {
    const job = await prisma.videoUploadJob.findFirst({
        where: { id: input.jobId, userId: input.userId },
        include: {
            chunks: { orderBy: { index: 'asc' }, select: { index: true, byteSize: true } },
            _count: { select: { chunks: true } },
        },
    }) as unknown as JobWithChunks | null;
    if (!job) return null;
    if (job.status !== 'uploading') {
        return toSnapshot(job);
    }
    await assertAllChunksPresent(job);
    const queued = await updateJob(job.id, { status: 'queued', stage: 'merging', message: '视频已上传，等待合并。' });
    const promise = runVideoUploadJob(job).finally(() => {
        activeVideoUploadJobs.delete(job.id);
    });
    activeVideoUploadJobs.set(job.id, promise);
    void promise;
    return toSnapshot(queued);
}

export async function getVideoUploadJob(input: { jobId: string; userId: string }): Promise<VideoUploadJobSnapshot | null> {
    await cleanupExpiredJobs();
    let job = await findOwnedJob(input.jobId, input.userId);
    if (!job) return null;
    if ((job.status === 'queued' || job.status === 'running') && !activeVideoUploadJobs.has(job.id)) {
        job = await updateJob(job.id, {
            status: 'failed',
            stage: 'complete',
            message: '服务已重启，请重新上传视频。',
            error: '服务已重启，请重新上传视频。',
            completedAt: new Date(),
        });
        await prisma.videoUploadChunk.deleteMany({ where: { jobId: job.id } });
        await cleanupVideoUploadDirectory(job.id);
    }
    return toSnapshot(job);
}

export async function waitForActiveVideoUploadJob(jobId: string): Promise<void> {
    await activeVideoUploadJobs.get(jobId);
}
