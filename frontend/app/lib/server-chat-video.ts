import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { AppError } from './auth';
import { ChatAttachmentFrame, formatDuration, type RemoteVideoDownloadMethod, type RemoteVideoPlatform } from './chat-attachments';
import { describeImageWithGemini } from './server-gemini-media';
import { readServerEnv } from './server-env';
import { transcribeWaveBuffer } from './server-voice-transcription';

const execFileAsync = promisify(execFile);
const TEMP_VIDEO_ROOT = path.join(process.cwd(), 'storage', 'chat-video-temp');
const PERSISTED_FRAME_ROOT = path.join(process.cwd(), 'public', 'chat-video-frames');
const TEMP_VIDEO_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_KEYFRAMES = 3;
const DEFAULT_MAX_REMOTE_VIDEO_SIZE = 20 * 1024 * 1024;
const DEFAULT_VIDEO_COMPRESS_TARGET_SIZE = 18 * 1024 * 1024;
const DEFAULT_VIDEO_COMPRESS_MAX_WIDTH = 720;
const DEFAULT_VIDEO_COMPRESS_AUDIO_KBPS = 96;
const DEFAULT_VIDEO_COMPRESS_MIN_VIDEO_KBPS = 1200;
const DEFAULT_VIDEO_COMPRESS_FALLBACK_VIDEO_KBPS = 1200;
const DEFAULT_TIKTOK_PLAYWRIGHT_TIMEOUT_MS = 20_000;
const RUNTIME_BIN_ROOT = path.join(process.cwd(), 'bin');
const FFMPEG_COMMAND = resolveMediaBinaryPath(
    'FFMPEG_PATH',
    [
        path.join(RUNTIME_BIN_ROOT, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
        typeof ffmpegStatic === 'string' ? ffmpegStatic : null,
    ],
    'ffmpeg',
);
const FFPROBE_COMMAND = resolveMediaBinaryPath(
    'FFPROBE_PATH',
    [
        path.join(RUNTIME_BIN_ROOT, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'),
        ffprobeStatic.path,
    ],
    'ffprobe',
);
const REMOTE_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.m4v']);
const REMOTE_VIDEO_MIME_MAP: Record<string, string> = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/x-m4v' };
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const DOUYIN_MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1';
const isTikTokPlaceholderAssetUrl = (remoteUrl: string): boolean => {
    const normalized = remoteUrl.toLowerCase();
    return normalized.includes('website-login-static')
        || normalized.includes('/playback1.mp4')
        || normalized.includes('webapp-desktop/playback');
};

interface TempVideoMeta { token: string; fileName: string; mimeType: string; createdAt: string; sourceFileName: string }
interface ExtractedFrameFile extends ChatAttachmentFrame { absolutePath: string }
export interface ProcessedVideoUpload { extractedText: string; transcript: string; durationMs?: number; previewUrl?: string; frames: ChatAttachmentFrame[]; tempVideoToken?: string }
export interface VideoProcessingStageUpdate { stage: 'compressing' | 'analyzing'; message: string }
export interface ProcessUploadedVideoOptions {
    includeFrameDescriptions?: boolean;
    includeTranscript?: boolean;
    requireFrames?: boolean;
    requireFrameDescriptions?: boolean;
    requireTranscript?: boolean;
    onStage?: (update: VideoProcessingStageUpdate) => void | Promise<void>;
}
export interface TempVideoData { buffer: Buffer; fileName: string; mimeType: string; absolutePath: string }
export interface DownloadedRemoteVideo extends ProcessedVideoUpload { buffer: Buffer; fileName: string; mimeType: string; fileSize: number; remotePlatform: RemoteVideoPlatform; downloadMethod: RemoteVideoDownloadMethod }
export interface DownloadRemoteVideoOptions extends ProcessUploadedVideoOptions { preprocess?: boolean }
interface YtDlpInvocation { command: string; prefixArgs: string[] }
interface RemoteVideoBinary { buffer: Buffer; fileName: string; mimeType: string; remotePlatform: RemoteVideoPlatform; downloadMethod: RemoteVideoDownloadMethod }
interface RemoteVideoDownloadContext { maxSize: number; normalizedUrl: string; platform: RemoteVideoPlatform }
export interface VideoCompressionSettings { maxWidth: number; videoBitrateKbps: number; audioBitrateKbps: number }
type TikTokPlaywrightModule = typeof import('playwright');
type TikTokBrowser = import('playwright').Browser;
type TikTokPage = import('playwright').Page;

let cachedYtDlpImpersonateTargetsPromise: Promise<Set<string>> | null = null;
let cachedPlaywrightModulePromise: Promise<TikTokPlaywrightModule> | null = null;
let cachedTikTokBrowserPromise: Promise<TikTokBrowser> | null = null;

export async function storeUploadedVideo(params: { buffer: Buffer; fileName: string; mimeType: string }): Promise<{ tempVideoToken: string }> {
    await cleanupStaleTempVideos();
    const temp = await createTempVideo(params.buffer, params.fileName, params.mimeType);
    return { tempVideoToken: temp.token };
}

export async function storeUploadedVideoForModelUpload(params: { buffer: Buffer; fileName: string; mimeType: string }): Promise<{ tempVideoToken: string; fileSize: number; mimeType: string }> {
    await cleanupStaleTempVideos();
    const temp = await createTempVideo(params.buffer, params.fileName, params.mimeType);
    return stageTempVideoForModelUpload({
        temp,
        inputSizeBytes: params.buffer.length,
        fileName: params.fileName,
        mimeType: params.mimeType,
    });
}

export async function storeUploadedVideoFileForModelUpload(params: {
    absolutePath: string;
    fileName: string;
    mimeType: string;
    fileSize: number;
    onStage?: (update: VideoProcessingStageUpdate) => void | Promise<void>;
}): Promise<{ tempVideoToken: string; fileSize: number; mimeType: string }> {
    await cleanupStaleTempVideos();
    const temp = await createTempVideoFromFile(params.absolutePath, params.fileName, params.mimeType);
    return stageTempVideoForModelUpload({
        temp,
        inputSizeBytes: params.fileSize,
        fileName: params.fileName,
        mimeType: params.mimeType,
        onStage: params.onStage,
    });
}

async function stageTempVideoForModelUpload(params: {
    temp: { token: string; absolutePath: string };
    inputSizeBytes: number;
    fileName: string;
    mimeType: string;
    onStage?: (update: VideoProcessingStageUpdate) => void | Promise<void>;
}): Promise<{ tempVideoToken: string; fileSize: number; mimeType: string }> {
    const { temp } = params;
    let durationMs: number | undefined;
    try {
        durationMs = await probeVideoDurationMs(temp.absolutePath);
    } catch (error) {
        console.error('[VideoProcessing] Failed to probe duration before model upload staging', {
            fileName: params.fileName,
            error: getProcessingErrorMessage(error),
        });
    }

    let stagedPath = temp.absolutePath;
    let stagedMimeType = params.mimeType;
    try {
        await params.onStage?.({ stage: 'compressing', message: '正在压缩视频。' });
        const compressed = await compressTempVideoIfNeeded({
            temp,
            inputSizeBytes: params.inputSizeBytes,
            durationMs,
            fileName: params.fileName,
        });
        if (compressed) {
            stagedPath = compressed.absolutePath;
            stagedMimeType = 'video/mp4';
        }
    } catch (error) {
        console.error('[VideoProcessing] Failed to compress video for model upload; keeping original', {
            fileName: params.fileName,
            error: getProcessingErrorMessage(error),
        });
    }

    const stat = await fs.stat(stagedPath);
    return { tempVideoToken: temp.token, fileSize: stat.size, mimeType: stagedMimeType };
}

function getProcessingErrorMessage(error: unknown): string {
    if (error && typeof error === 'object') {
        const stderr = typeof (error as { stderr?: unknown }).stderr === 'string'
            ? (error as { stderr: string }).stderr.trim()
            : '';
        if (stderr) {
            return stderr;
        }

        const stdout = typeof (error as { stdout?: unknown }).stdout === 'string'
            ? (error as { stdout: string }).stdout.trim()
            : '';
        if (stdout) {
            return stdout;
        }
    }

    if (error instanceof Error && error.message.trim()) {
        return error.message.trim();
    }

    if (typeof error === 'string' && error.trim()) {
        return error.trim();
    }

    return 'Unknown error';
}

function resolveMediaBinaryPath(envKey: string, candidatePaths: Array<string | null | undefined>, fallbackCommand: string): string {
    const envValue = readServerEnv(envKey)?.trim();
    if (envValue) {
        return envValue;
    }

    for (const candidatePath of candidatePaths) {
        if (candidatePath?.trim() && existsSync(candidatePath)) {
            return candidatePath;
        }
    }

    return fallbackCommand;
}

export function resolveVideoCompressionSettings(params: {
    inputSizeBytes: number;
    durationMs?: number;
    targetSizeBytes?: number;
    maxWidth?: number;
    audioBitrateKbps?: number;
    minVideoBitrateKbps?: number;
}): VideoCompressionSettings | null {
    const targetSizeBytes = params.targetSizeBytes || DEFAULT_VIDEO_COMPRESS_TARGET_SIZE;
    if (params.inputSizeBytes <= targetSizeBytes) {
        return null;
    }

    const maxWidth = params.maxWidth || DEFAULT_VIDEO_COMPRESS_MAX_WIDTH;
    const audioBitrateKbps = params.audioBitrateKbps || DEFAULT_VIDEO_COMPRESS_AUDIO_KBPS;
    const minVideoBitrateKbps = params.minVideoBitrateKbps || DEFAULT_VIDEO_COMPRESS_MIN_VIDEO_KBPS;
    const durationSeconds = typeof params.durationMs === 'number' && params.durationMs > 0
        ? params.durationMs / 1000
        : 0;
    if (durationSeconds <= 0) {
        return {
            maxWidth,
            videoBitrateKbps: Math.max(DEFAULT_VIDEO_COMPRESS_FALLBACK_VIDEO_KBPS, minVideoBitrateKbps),
            audioBitrateKbps,
        };
    }

    const totalKbps = Math.floor((targetSizeBytes * 8) / durationSeconds / 1024);
    const rawVideoKbps = Math.max(minVideoBitrateKbps, totalKbps - audioBitrateKbps);
    const videoBitrateKbps = Math.max(minVideoBitrateKbps, Math.floor(rawVideoKbps / 16) * 16);
    return { maxWidth, videoBitrateKbps, audioBitrateKbps };
}

function createProcessingStageError(fileName: string, stage: string, error: unknown): AppError {
    return new AppError(
        `视频预处理失败：${fileName} 在${stage}时出错。${getProcessingErrorMessage(error)}`,
        500,
    );
    return new AppError(
        `视频预处理失败：${fileName} 在${stage}时出错。${getProcessingErrorMessage(error)}`,
        500,
    );
}

function createMissingKeyframesError(fileName: string): AppError {
    return new AppError(
        `视频预处理失败：${fileName} 未抽取到关键帧。请检查部署环境中的 ffmpeg 是否可用。`,
        500,
    );
    return new AppError(
        `视频预处理失败：${fileName} 未抽取到关键帧。请检查部署环境中的 ffmpeg 是否可用。`,
        500,
    );
}

function buildProcessingStageError(fileName: string, stage: string, error: unknown): AppError {
    return createProcessingStageError(fileName, stage, error);
    return new AppError(
        `视频预处理失败：${fileName} 在${stage}时出错。${getProcessingErrorMessage(error)}`,
        500,
    );
}

export async function processUploadedVideo(params: { buffer: Buffer; fileName: string; mimeType: string }, options: ProcessUploadedVideoOptions = {}): Promise<ProcessedVideoUpload> {
    await cleanupStaleTempVideos();
    const temp = await createTempVideo(params.buffer, params.fileName, params.mimeType);
    return processTempVideo(temp, {
        fileName: params.fileName,
        inputSizeBytes: params.buffer.length,
    }, options);
}

export async function processUploadedVideoFile(params: {
    absolutePath: string;
    fileName: string;
    mimeType: string;
    fileSize: number;
}, options: ProcessUploadedVideoOptions = {}): Promise<ProcessedVideoUpload> {
    await cleanupStaleTempVideos();
    const temp = await createTempVideoFromFile(params.absolutePath, params.fileName, params.mimeType);
    return processTempVideo(temp, {
        fileName: params.fileName,
        inputSizeBytes: params.fileSize,
    }, options);
}

async function processTempVideo(
    temp: { token: string; absolutePath: string },
    params: { fileName: string; inputSizeBytes: number },
    options: ProcessUploadedVideoOptions,
): Promise<ProcessedVideoUpload> {
    const {
        includeFrameDescriptions = true,
        includeTranscript = true,
        requireFrames = false,
        requireFrameDescriptions = false,
        requireTranscript = false,
        onStage,
    } = options;
    let durationMs: number | undefined;
    let frames: ExtractedFrameFile[] = [];
    let transcript = '';
    let frameDescriptions: string[] = [];
    try {
        try {
            durationMs = await probeVideoDurationMs(temp.absolutePath);
        } catch (error) {
            console.error('[VideoProcessing] Failed to probe duration', {
                fileName: params.fileName,
                error: getProcessingErrorMessage(error),
            });
        }

        if (includeFrameDescriptions || includeTranscript) {
            await onStage?.({ stage: 'analyzing', message: '正在抽帧和分析视频。' });
        }

        if (includeFrameDescriptions) {
            try {
                frames = await extractKeyframes(temp.absolutePath, durationMs);
            } catch (error) {
                console.error('[VideoProcessing] Failed to extract keyframes', {
                    fileName: params.fileName,
                    error: getProcessingErrorMessage(error),
                });
                if (requireFrames || requireFrameDescriptions) {
                    throw createProcessingStageError(params.fileName, '提取关键帧', error);
                    throw buildProcessingStageError(params.fileName, '抽取关键帧', error);
                }
            }

            if (frames.length === 0 && (requireFrames || requireFrameDescriptions)) {
                throw createMissingKeyframesError(params.fileName);
                throw new AppError(
                    `视频预处理失败：${params.fileName} 未抽取到关键帧。请检查部署环境中的 ffmpeg 是否可用。`,
                    500,
                );
            }

            if (frames.length > 0) {
                try {
                    frameDescriptions = await describeFrames(frames);
                } catch (error) {
                    console.error('[VideoProcessing] Failed to describe keyframes', {
                        fileName: params.fileName,
                        error: getProcessingErrorMessage(error),
                    });
                    if (requireFrameDescriptions) {
                        throw createProcessingStageError(params.fileName, '生成关键帧描述', error);
                        throw buildProcessingStageError(params.fileName, '生成关键帧描述', error);
                    }
                }
            }
        }

        if (includeTranscript) {
            try {
                transcript = await extractTranscript(temp.absolutePath);
            } catch (error) {
                console.error('[VideoProcessing] Failed to extract transcript', {
                    fileName: params.fileName,
                    error: getProcessingErrorMessage(error),
                });
                if (requireTranscript) {
                    throw createProcessingStageError(params.fileName, '语音转写', error);
                    throw buildProcessingStageError(params.fileName, '语音转写', error);
                }
            }
        }

        try {
            await onStage?.({ stage: 'compressing', message: '正在压缩视频。' });
            await compressTempVideoIfNeeded({
                temp,
                inputSizeBytes: params.inputSizeBytes,
                durationMs,
                fileName: params.fileName,
            });
        } catch (error) {
            console.error('[VideoProcessing] Failed to compress video; continuing with original', {
                fileName: params.fileName,
                error: getProcessingErrorMessage(error),
            });
        }

        return {
            extractedText: buildVideoExtractedText({ fileName: params.fileName, durationMs, transcript: includeTranscript ? transcript : '', transcriptAttempted: includeTranscript, frameDescriptions }),
            transcript: includeTranscript ? transcript : '',
            durationMs,
            previewUrl: frames[0]?.url,
            frames: frames.map((frame) => ({ url: frame.url, timestampMs: frame.timestampMs })),
            tempVideoToken: temp.token,
        };
    } catch (error) {
        await deleteTempVideo(temp.token);
        throw error;
    }
}

export async function loadTempVideo(token: string): Promise<TempVideoData> {
    const safeToken = sanitizeToken(token);
    const metaPath = path.join(TEMP_VIDEO_ROOT, safeToken, 'meta.json');
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as TempVideoMeta;
    const absolutePath = path.join(TEMP_VIDEO_ROOT, safeToken, meta.sourceFileName);
    const buffer = await fs.readFile(absolutePath);
    return { buffer, fileName: meta.fileName, mimeType: meta.mimeType, absolutePath };
}

export async function getTempVideoFileInfo(token: string): Promise<{
    absolutePath: string;
    fileName: string;
    mimeType: string;
    fileSize: number;
    durationMs?: number;
}> {
    const safeToken = sanitizeToken(token);
    const metaPath = path.join(TEMP_VIDEO_ROOT, safeToken, 'meta.json');
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as TempVideoMeta;
    const absolutePath = path.join(TEMP_VIDEO_ROOT, safeToken, meta.sourceFileName);
    const stat = await fs.stat(absolutePath);
    const durationMs = await probeVideoDurationMs(absolutePath).catch(() => undefined);
    return { absolutePath, fileName: meta.fileName, mimeType: meta.mimeType, fileSize: stat.size, durationMs };
}

export async function splitVideoFileByTime(params: {
    absolutePath: string;
    outputDirectory: string;
    segmentSeconds: number;
}): Promise<Array<{ absolutePath: string; durationMs: number; fileSize: number }>> {
    if (!Number.isFinite(params.segmentSeconds) || params.segmentSeconds <= 0) {
        throw new Error('Invalid video segment duration.');
    }
    await fs.mkdir(params.outputDirectory, { recursive: true });
    const outputPattern = path.join(params.outputDirectory, 'segment-%03d.mp4');
    await execFileAsync(FFMPEG_COMMAND, [
        '-y',
        '-i',
        params.absolutePath,
        '-map',
        '0:v:0',
        '-map',
        '0:a?',
        '-c',
        'copy',
        '-f',
        'segment',
        '-segment_time',
        String(params.segmentSeconds),
        '-reset_timestamps',
        '1',
        outputPattern,
    ]);

    const names = (await fs.readdir(params.outputDirectory))
        .filter((name) => /^segment-\d+\.mp4$/.test(name))
        .sort();
    if (names.length === 0) {
        throw new Error('FFmpeg did not create video segments.');
    }
    return Promise.all(names.map(async (name) => {
        const absolutePath = path.join(params.outputDirectory, name);
        const [durationMs, stat] = await Promise.all([probeVideoDurationMs(absolutePath), fs.stat(absolutePath)]);
        return { absolutePath, durationMs, fileSize: stat.size };
    }));
}

export async function deleteTempVideo(token: string): Promise<void> {
    await fs.rm(path.join(TEMP_VIDEO_ROOT, sanitizeToken(token)), { recursive: true, force: true }).catch(() => undefined);
}

export async function cleanupStaleTempVideos(ttlMs = TEMP_VIDEO_TTL_MS): Promise<void> {
    const now = Date.now();
    await fs.mkdir(TEMP_VIDEO_ROOT, { recursive: true });
    const entries = await fs.readdir(TEMP_VIDEO_ROOT, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.map(async (entry) => {
        if (!entry.isDirectory()) return;
        const absolute = path.join(TEMP_VIDEO_ROOT, entry.name);
        try {
            const stat = await fs.stat(absolute);
            if (now - stat.mtimeMs > ttlMs) await fs.rm(absolute, { recursive: true, force: true });
        } catch {}
    }));
}

export async function downloadRemoteVideo(remoteUrl: string, options: DownloadRemoteVideoOptions = {}): Promise<DownloadedRemoteVideo> {
    const {
        preprocess = true,
        includeFrameDescriptions = true,
        includeTranscript = true,
    } = options;
    const maxSize = Number.parseInt(readServerEnv('MAX_FILE_SIZE') || '', 10) || DEFAULT_MAX_REMOTE_VIDEO_SIZE;
    const normalizedUrl = normalizeRemoteVideoUrl(remoteUrl);
    await assertSafeRemoteVideoUrl(normalizedUrl);
    const context: RemoteVideoDownloadContext = { maxSize, normalizedUrl, platform: detectRemoteVideoPlatform(normalizedUrl) };
    console.info('[RemoteVideo] start', { platform: context.platform, url: summarizeRemoteVideoUrl(normalizedUrl) });
    let directError: unknown;
    let providerError: unknown;
    let downloaded: RemoteVideoBinary | null = null;
    try {
        downloaded = await downloadDirectRemoteVideo(context);
        console.info('[RemoteVideo] direct success', { platform: downloaded.remotePlatform, method: downloaded.downloadMethod, bytes: downloaded.buffer.length });
    } catch (error) {
        directError = error;
        console.warn('[RemoteVideo] direct failed', { platform: context.platform, reason: formatRemoteVideoError(error) });
    }
    if (!downloaded) {
        try {
            downloaded = await downloadRemoteVideoViaProvider(context);
            if (downloaded) console.info('[RemoteVideo] provider success', { platform: downloaded.remotePlatform, method: downloaded.downloadMethod, bytes: downloaded.buffer.length });
        } catch (error) {
            providerError = error;
            console.warn('[RemoteVideo] provider failed', { platform: context.platform, reason: formatRemoteVideoError(error) });
        }
    }
    if (!downloaded) {
        try {
            downloaded = await downloadRemoteVideoWithYtDlp(context);
            console.info('[RemoteVideo] yt-dlp success', { platform: downloaded.remotePlatform, method: downloaded.downloadMethod, bytes: downloaded.buffer.length });
        } catch (fallbackError) {
            if (fallbackError instanceof AppError) throw fallbackError;
            throw new AppError(
                `Could not fetch a video from this link. Direct download failed: ${formatRemoteVideoError(directError) || 'unknown error'}.`
                + ` Provider download failed: ${formatRemoteVideoError(providerError) || 'not attempted'}.`
                + ` yt-dlp fallback failed: ${formatRemoteVideoError(fallbackError) || 'unknown error'}.`,
                400,
            );
        }
    }
    if (!downloaded) throw new AppError('Could not fetch a video from this link.', 400);
    if (!preprocess) {
        return {
            extractedText: '',
            transcript: '',
            durationMs: undefined,
            previewUrl: undefined,
            frames: [],
            tempVideoToken: undefined,
            buffer: downloaded.buffer,
            fileName: downloaded.fileName,
            mimeType: downloaded.mimeType,
            fileSize: downloaded.buffer.length,
            remotePlatform: downloaded.remotePlatform,
            downloadMethod: downloaded.downloadMethod,
        };
    }
    const processed = await processUploadedVideo(
        { buffer: downloaded.buffer, fileName: downloaded.fileName, mimeType: downloaded.mimeType },
        { includeFrameDescriptions, includeTranscript },
    );
    await deleteTempVideo(processed.tempVideoToken as string);
    return { ...processed, buffer: downloaded.buffer, fileName: downloaded.fileName, mimeType: downloaded.mimeType, fileSize: downloaded.buffer.length, remotePlatform: downloaded.remotePlatform, downloadMethod: downloaded.downloadMethod };
}

async function createTempVideo(buffer: Buffer, fileName: string, mimeType: string): Promise<{ token: string; absolutePath: string }> {
    const token = `${Date.now()}-${randomUUID()}`;
    const extension = path.extname(fileName) || '.mp4';
    const directory = path.join(TEMP_VIDEO_ROOT, token);
    const sourceFileName = `source${extension.toLowerCase()}`;
    const absolutePath = path.join(directory, sourceFileName);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(absolutePath, buffer);
    const meta: TempVideoMeta = { token, fileName, mimeType, createdAt: new Date().toISOString(), sourceFileName };
    await fs.writeFile(path.join(directory, 'meta.json'), JSON.stringify(meta), 'utf8');
    return { token, absolutePath };
}

async function createTempVideoFromFile(sourcePath: string, fileName: string, mimeType: string): Promise<{ token: string; absolutePath: string }> {
    const token = `${Date.now()}-${randomUUID()}`;
    const extension = path.extname(fileName) || '.mp4';
    const directory = path.join(TEMP_VIDEO_ROOT, token);
    const sourceFileName = `source${extension.toLowerCase()}`;
    const absolutePath = path.join(directory, sourceFileName);
    await fs.mkdir(directory, { recursive: true });

    try {
        await fs.rename(sourcePath, absolutePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
            await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
            throw error;
        }
        await fs.copyFile(sourcePath, absolutePath);
        await fs.rm(sourcePath, { force: true });
    }

    const meta: TempVideoMeta = { token, fileName, mimeType, createdAt: new Date().toISOString(), sourceFileName };
    await fs.writeFile(path.join(directory, 'meta.json'), JSON.stringify(meta), 'utf8');
    return { token, absolutePath };
}

async function compressTempVideoIfNeeded(params: {
    temp: { token: string; absolutePath: string };
    inputSizeBytes: number;
    durationMs?: number;
    fileName: string;
}): Promise<{ absolutePath: string } | null> {
    const targetSizeBytes = readIntServerEnv('VIDEO_COMPRESS_TARGET_SIZE', DEFAULT_VIDEO_COMPRESS_TARGET_SIZE);
    const maxWidth = readIntServerEnv('VIDEO_COMPRESS_MAX_WIDTH', DEFAULT_VIDEO_COMPRESS_MAX_WIDTH);
    const audioBitrateKbps = readIntServerEnv('VIDEO_COMPRESS_AUDIO_KBPS', DEFAULT_VIDEO_COMPRESS_AUDIO_KBPS);
    const minVideoBitrateKbps = readIntServerEnv('VIDEO_COMPRESS_MIN_VIDEO_KBPS', DEFAULT_VIDEO_COMPRESS_MIN_VIDEO_KBPS);
    const settings = resolveVideoCompressionSettings({
        inputSizeBytes: params.inputSizeBytes,
        durationMs: params.durationMs,
        targetSizeBytes,
        maxWidth,
        audioBitrateKbps,
        minVideoBitrateKbps,
    });
    if (!settings) {
        return null;
    }

    const directory = path.dirname(params.temp.absolutePath);
    const compressedFileName = 'compressed.mp4';
    const compressedPath = path.join(directory, compressedFileName);
    await execFileAsync(FFMPEG_COMMAND, [
        '-y',
        '-i',
        params.temp.absolutePath,
        '-vf',
        `scale='min(${settings.maxWidth},iw)':-2`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-b:v',
        `${settings.videoBitrateKbps}k`,
        '-maxrate',
        `${settings.videoBitrateKbps}k`,
        '-bufsize',
        `${settings.videoBitrateKbps * 2}k`,
        '-c:a',
        'aac',
        '-b:a',
        `${settings.audioBitrateKbps}k`,
        '-movflags',
        '+faststart',
        compressedPath,
    ]);

    const compressedStat = await fs.stat(compressedPath);
    if (compressedStat.size >= params.inputSizeBytes) {
        await fs.rm(compressedPath, { force: true }).catch(() => undefined);
        return null;
    }

    const metaPath = path.join(directory, 'meta.json');
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as TempVideoMeta;
    const updatedMeta: TempVideoMeta = {
        ...meta,
        mimeType: 'video/mp4',
        sourceFileName: compressedFileName,
    };
    await fs.writeFile(metaPath, JSON.stringify(updatedMeta), 'utf8');
    await fs.rm(params.temp.absolutePath, { force: true }).catch(() => undefined);
    console.info('[VideoProcessing] compressed uploaded video', {
        fileName: params.fileName,
        originalBytes: params.inputSizeBytes,
        compressedBytes: compressedStat.size,
        targetBytes: targetSizeBytes,
        videoBitrateKbps: settings.videoBitrateKbps,
    });
    return { absolutePath: compressedPath };
}

async function probeVideoDurationMs(absolutePath: string): Promise<number> {
    const { stdout } = await execFileAsync(FFPROBE_COMMAND, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', absolutePath]);
    const seconds = Number.parseFloat(stdout.trim());
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Unable to determine video duration.');
    return Math.round(seconds * 1000);
}

async function extractKeyframes(absolutePath: string, durationMs?: number): Promise<ExtractedFrameFile[]> {
    await fs.mkdir(PERSISTED_FRAME_ROOT, { recursive: true });
    const timestamps = buildFrameTimestamps(durationMs);
    const token = `${Date.now()}-${randomUUID()}`;
    const results: ExtractedFrameFile[] = [];
    const failures: string[] = [];
    for (let index = 0; index < timestamps.length; index += 1) {
        const timestampMs = timestamps[index];
        const fileName = `${token}-${index + 1}.jpg`;
        const absoluteFramePath = path.join(PERSISTED_FRAME_ROOT, fileName);
        try {
            await execFileAsync(FFMPEG_COMMAND, ['-y', '-ss', String(Math.max(0, timestampMs / 1000)), '-i', absolutePath, '-frames:v', '1', '-vf', "scale='min(768,iw)':-2", '-q:v', '4', absoluteFramePath]);
            results.push({ url: `/chat-video-frames/${fileName}`, timestampMs, absolutePath: absoluteFramePath });
        } catch (error) {
            failures.push(`${formatDuration(timestampMs)}: ${getProcessingErrorMessage(error)}`);
        }
    }

    if (results.length === 0 && failures.length > 0) {
        throw new Error(failures.join(' | '));
    }

    return results;
}

function buildFrameTimestamps(durationMs?: number): number[] {
    if (!durationMs || durationMs <= 0) return [0, 1500, 3000];
    if (durationMs / 1000 <= 6) return [0, durationMs / 2, Math.max(durationMs - 500, 0)].map((value) => Math.round(value));
    return [0.15, 0.5, 0.85].slice(0, MAX_KEYFRAMES).map((point) => Math.round(durationMs * point)).filter((value, index, list) => list.indexOf(value) === index);
}

async function describeFrames(frames: ExtractedFrameFile[]): Promise<string[]> {
    const descriptions: string[] = [];
    for (const frame of frames) {
        const buffer = await fs.readFile(frame.absolutePath);
        const base64 = buffer.toString('base64');
        const description = await describeImageWithGemini(base64, 'image/jpeg', `Describe the main visuals and any readable text in this key video frame. Frame timestamp: ${formatDuration(frame.timestampMs)}.`);
        descriptions.push(`${formatDuration(frame.timestampMs)}: ${description.trim()}`);
    }
    return descriptions;
}

async function extractTranscript(absolutePath: string): Promise<string> {
    const tempAudioPath = path.join(TEMP_VIDEO_ROOT, `${Date.now()}-${randomUUID()}.wav`);
    try {
        await execFileAsync(FFMPEG_COMMAND, ['-y', '-i', absolutePath, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', tempAudioPath]);
        const audioBuffer = await fs.readFile(tempAudioPath);
        const { text } = await transcribeWaveBuffer(audioBuffer, path.basename(tempAudioPath));
        return text.trim();
    } finally {
        await fs.rm(tempAudioPath, { force: true }).catch(() => undefined);
    }
}

function buildVideoExtractedText(params: { fileName: string; durationMs?: number; transcript: string; transcriptAttempted: boolean; frameDescriptions: string[] }): string {
    const sections = [`Video file: ${params.fileName}`];
    if (typeof params.durationMs === 'number' && params.durationMs > 0) sections.push(`Video duration: ${formatDuration(params.durationMs)}`);
    if (params.transcriptAttempted) sections.push(params.transcript.trim() ? `Transcript:\n${params.transcript.trim()}` : 'Transcript: no usable speech was detected, or the video has no clear dialogue.');
    if (params.frameDescriptions.length > 0) sections.push(`Key video frames:\n${params.frameDescriptions.map((item, index) => `${index + 1}. ${item}`).join('\n')}`);
    return sections.join('\n\n');
}

function sanitizeToken(token: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(token)) throw new Error('Invalid temp video token.');
    return token;
}

function isPrivateIpv4Address(value: string): boolean {
    const parts = value.split('.').map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) return false;
    return parts[0] === 10 || parts[0] === 127 || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
}

function isPrivateIpv6Address(value: string): boolean {
    const normalized = value.toLowerCase();
    return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
}

function isInternalNetworkHost(hostname: string): boolean {
    const normalized = hostname.trim().toLowerCase();
    if (!normalized) return false;
    if (normalized === 'localhost' || normalized.endsWith('.internal') || normalized.endsWith('.local')) return true;
    const ipVersion = net.isIP(normalized);
    return ipVersion === 4 ? isPrivateIpv4Address(normalized) : ipVersion === 6 ? isPrivateIpv6Address(normalized) : false;
}

async function assertSafeRemoteVideoUrl(remoteUrl: string): Promise<void> {
    const url = new URL(remoteUrl);
    if (isInternalNetworkHost(url.hostname)) throw new AppError('Localhost, internal network, and local video URLs are not allowed.', 400);
    const resolvedHosts = await lookup(url.hostname, { all: true, verbatim: true }).catch(() => []);
    if (resolvedHosts.some((record) => isInternalNetworkHost(record.address))) throw new AppError('Remote video URLs that resolve to internal networks are not allowed.', 400);
}

function normalizeRemoteVideoUrl(input: string): string {
    const extractedUrl = extractFirstUrlCandidate(input);
    let url: URL;
    try { url = new URL(extractedUrl); } catch { throw new AppError('Video URL is invalid.', 400); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new AppError('Only http or https video URLs are supported.', 400);
    return url.toString();
}

function extractFirstUrlCandidate(input: string): string {
    const trimmed = input.trim();
    const match = trimmed.match(/https?:\/\/[^\s<>"']+/i);
    return match ? match[0].replace(/[)\]}>,.;!?]+$/u, '') : trimmed;
}

function detectRemoteVideoPlatform(remoteUrl: string): RemoteVideoPlatform {
    const hostname = new URL(remoteUrl).hostname.toLowerCase();
    if (hostname === 'youtu.be' || hostname === 'youtube.com' || hostname.endsWith('.youtube.com')) return 'youtube';
    if (hostname === 'douyin.com' || hostname.endsWith('.douyin.com') || hostname === 'iesdouyin.com' || hostname.endsWith('.iesdouyin.com')) return 'douyin';
    if (hostname === 'tiktok.com' || hostname.endsWith('.tiktok.com')) return 'tiktok';
    return 'generic';
}

function summarizeRemoteVideoUrl(remoteUrl: string): string {
    const url = new URL(remoteUrl);
    const summary = `${url.origin}${url.pathname}`;
    return summary.length > 160 ? `${summary.slice(0, 157)}...` : summary;
}

function formatRemoteVideoError(error: unknown): string {
    if (error instanceof AppError || error instanceof Error) return error.message;
    return typeof error === 'string' ? error : error ? String(error) : '';
}

async function downloadRemoteVideoViaProvider(context: RemoteVideoDownloadContext): Promise<RemoteVideoBinary | null> {
    if (context.platform === 'douyin') return downloadDouyinRemoteVideo(context);
    if (context.platform === 'tiktok' && isTikTokPlaywrightEnabled()) return downloadTikTokRemoteVideoWithPlaywright(context);
    return null;
}

async function downloadDirectRemoteVideo(context: RemoteVideoDownloadContext): Promise<RemoteVideoBinary> {
    return downloadRemoteBinaryFromUrl({ url: context.normalizedUrl, maxSize: context.maxSize, fileName: inferRemoteVideoFileName(context.normalizedUrl), remotePlatform: context.platform, downloadMethod: 'direct', requireVideoContent: true, headers: { 'User-Agent': 'Mozilla/5.0 CodexVideoFetcher/1.0' } });
}

async function downloadDouyinRemoteVideo(context: RemoteVideoDownloadContext): Promise<RemoteVideoBinary> {
    const initialPage = await fetchRemoteVideoText(context.normalizedUrl, { referer: 'https://www.douyin.com/', userAgent: DOUYIN_MOBILE_UA });
    const resolvedPageUrl = initialPage.response.url || context.normalizedUrl;
    await assertSafeRemoteVideoUrl(resolvedPageUrl);
    const videoId = extractDouyinVideoId(resolvedPageUrl) || extractDouyinVideoId(context.normalizedUrl) || extractDouyinVideoId(initialPage.text);
    const candidateUrls = new Set<string>(extractDouyinVideoUrls(initialPage.text));
    if (videoId) for (const url of await fetchDouyinApiVideoUrls(videoId)) candidateUrls.add(url);
    for (const extraPage of await Promise.all([
        fetchRemoteVideoText(resolvedPageUrl, { referer: 'https://www.douyin.com/', userAgent: DESKTOP_UA }).catch(() => null),
        fetchRemoteVideoText(resolvedPageUrl, { referer: 'https://www.douyin.com/', userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }).catch(() => null),
    ])) {
        if (!extraPage) continue;
        for (const url of extractDouyinVideoUrls(extraPage.text)) candidateUrls.add(url);
    }
    for (const candidateUrl of candidateUrls) {
        try {
            return await downloadRemoteBinaryFromUrl({ url: candidateUrl, maxSize: context.maxSize, remotePlatform: 'douyin', downloadMethod: 'douyin-parser', fileName: videoId ? `${videoId}.mp4` : inferRemoteVideoFileName(candidateUrl), requireVideoContent: true, headers: { Referer: 'https://www.douyin.com/', 'User-Agent': DOUYIN_MOBILE_UA } });
        } catch (error) {
            console.warn('[RemoteVideo] douyin candidate failed', { candidate: summarizeRemoteVideoUrl(candidateUrl), reason: formatRemoteVideoError(error) });
        }
    }
    throw new AppError('Could not resolve a playable Douyin video URL from this page.', 400);
}

async function fetchDouyinApiVideoUrls(videoId: string): Promise<string[]> {
    const apiUrl = new URL('https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/');
    apiUrl.searchParams.set('item_ids', videoId);
    const response = await fetch(apiUrl, { headers: { Referer: 'https://www.douyin.com/', 'User-Agent': DESKTOP_UA }, redirect: 'follow' });
    if (!response.ok) return [];
    const payload = await response.json().catch(() => null) as { item_list?: Array<{ video?: { play_addr?: { url_list?: string[] }; download_addr?: { url_list?: string[] } } }>; aweme_details?: Array<{ video?: { play_addr?: { url_list?: string[] }; download_addr?: { url_list?: string[] } } }> } | null;
    if (!payload) return [];
    const video = (payload.item_list || payload.aweme_details || [])[0]?.video;
    return dedupeStrings([...(video?.play_addr?.url_list || []), ...(video?.download_addr?.url_list || [])].map((item) => normalizePossibleEscapedUrl(item)).filter(Boolean) as string[]);
}

async function downloadTikTokRemoteVideoWithPlaywright(context: RemoteVideoDownloadContext): Promise<RemoteVideoBinary> {
    const browser = await getTikTokPlaywrightBrowser();
    const browserContext = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 }, userAgent: DESKTOP_UA });
    try {
        await browserContext.route('**/*', async (route) => {
            const type = route.request().resourceType();
            if (type === 'image' || type === 'font' || type === 'stylesheet') { await route.abort(); return; }
            await route.continue();
        });
        const page = await browserContext.newPage();
        const candidateUrls = new Set<string>();
        page.on('response', (response) => {
            const responseUrl = response.url();
            const contentType = response.headers()['content-type'] || '';
            if (contentType.startsWith('video/') || /\.mp4(?:$|\?)/i.test(responseUrl) || /video\/tos/i.test(responseUrl)) candidateUrls.add(responseUrl);
        });
        const timeoutMs = readIntServerEnv('TIKTOK_PLAYWRIGHT_TIMEOUT_MS', DEFAULT_TIKTOK_PLAYWRIGHT_TIMEOUT_MS);
        await page.goto(context.normalizedUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        await page.waitForTimeout(1500);
        for (const url of await extractTikTokVideoUrlsFromPage(page)) candidateUrls.add(url);
        if (candidateUrls.size === 0) {
            const playButton = page.locator('button[aria-label*="Play"], button[data-e2e*="play"]').first();
            if (await playButton.isVisible().catch(() => false)) { await playButton.click({ timeout: 2000 }).catch(() => undefined); await page.waitForTimeout(1200); }
        }
        const ordered = dedupeStrings([...candidateUrls, ...(await extractTikTokVideoUrlsFromPage(page))])
            .sort((left, right) => scoreTikTokVideoCandidate(right) - scoreTikTokVideoCandidate(left));
        if (ordered.length === 0) throw new AppError('Playwright could not locate a downloadable TikTok video URL from the page.', 400);
        let bestCandidate: RemoteVideoBinary | null = null;
        let bestScore = Number.NEGATIVE_INFINITY;
        for (const candidateUrl of ordered) {
            try {
                if (isTikTokPlaceholderAssetUrl(candidateUrl)) continue;
                const response = await page.request.get(candidateUrl, { headers: { Referer: context.normalizedUrl, 'User-Agent': DESKTOP_UA }, failOnStatusCode: false, timeout: timeoutMs });
                if (!response.ok()) continue;
                const resolvedUrl = response.url() || candidateUrl;
                await assertSafeRemoteVideoUrl(resolvedUrl);
                if (isTikTokPlaceholderAssetUrl(resolvedUrl)) continue;
                const contentType = response.headers()['content-type'] || '';
                const extension = path.extname(new URL(resolvedUrl).pathname).toLowerCase();
                if (!(contentType.startsWith('video/') || REMOTE_VIDEO_EXTENSIONS.has(extension))) continue;
                const buffer = Buffer.from(await response.body());
                if (isLikelySubtitlePayload(buffer)) continue;
                if (buffer.length > context.maxSize) throw new AppError(`Video size exceeds ${Math.round(context.maxSize / (1024 * 1024))}MB. Please use a shorter video link.`, 400);
                const candidateScore = scoreTikTokVideoCandidate(resolvedUrl) + Math.min(buffer.length / 250_000, 60);
                if (candidateScore > bestScore) {
                    bestScore = candidateScore;
                    bestCandidate = { buffer, fileName: inferRemoteVideoFileName(resolvedUrl), mimeType: contentType.split(';')[0].trim() || REMOTE_VIDEO_MIME_MAP[extension] || 'video/mp4', remotePlatform: 'tiktok', downloadMethod: 'tiktok-playwright' };
                }
            } catch (error) {
                console.warn('[RemoteVideo] tiktok candidate failed', { candidate: summarizeRemoteVideoUrl(candidateUrl), reason: formatRemoteVideoError(error) });
            }
        }
        if (bestCandidate) return bestCandidate;
        throw new AppError('TikTok only exposed placeholder assets or subtitle files to the current server environment, not the real video stream.', 400);
    } finally {
        await browserContext.close().catch(() => undefined);
    }
}

async function extractTikTokVideoUrlsFromPage(page: TikTokPage): Promise<string[]> {
    return page.evaluate(() => {
        const candidates = new Set<string>();
        const normalize = (value: string): string | null => {
            const trimmed = value.trim();
            if (!trimmed || trimmed.startsWith('blob:')) return null;
            return trimmed.replace(/\\u002F/gi, '/').replace(/\\u0026/gi, '&').replace(/\\\//g, '/');
        };
        for (const element of Array.from(document.querySelectorAll('video, source'))) {
            const src = element.getAttribute('src');
            const normalized = src ? normalize(src) : null;
            if (normalized) candidates.add(normalized);
        }
        const html = document.documentElement.innerHTML;
        for (const regex of [/"playAddr":"([^"]+)"/g, /"downloadAddr":"([^"]+)"/g, /"src":"([^"]+)"/g, /"url":"(https?:[^"]+)"/g]) {
            for (const match of html.matchAll(regex)) {
                const normalized = normalize(match[1]);
                if (normalized) candidates.add(normalized);
            }
        }
        return [...candidates];
    });
}

async function loadPlaywrightModule(): Promise<TikTokPlaywrightModule> {
    if (!cachedPlaywrightModulePromise) cachedPlaywrightModulePromise = import('playwright');
    return cachedPlaywrightModulePromise;
}

async function getTikTokPlaywrightBrowser(): Promise<TikTokBrowser> {
    if (!cachedTikTokBrowserPromise) {
        cachedTikTokBrowserPromise = (async () => {
            const playwright = await loadPlaywrightModule();
            return playwright.chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-setuid-sandbox'] });
        })().catch((error) => { cachedTikTokBrowserPromise = null; throw error; });
    }
    return cachedTikTokBrowserPromise;
}

function isTikTokPlaywrightEnabled(): boolean {
    const value = readTrimmedServerEnv('TIKTOK_PLAYWRIGHT_ENABLED');
    return value ? ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()) : true;
}

function readIntServerEnv(key: string, fallbackValue: number): number {
    const raw = readTrimmedServerEnv(key);
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackValue;
}

async function fetchRemoteVideoText(remoteUrl: string, options: { userAgent: string; referer?: string }): Promise<{ response: Response; text: string }> {
    const response = await fetch(remoteUrl, { headers: { 'User-Agent': options.userAgent, ...(options.referer ? { Referer: options.referer } : {}) }, redirect: 'follow' });
    if (!response.ok) throw new AppError(`Failed to fetch remote page: ${response.status} ${response.statusText}`, 400);
    const resolvedUrl = response.url || remoteUrl;
    await assertSafeRemoteVideoUrl(resolvedUrl);
    return { response, text: await response.text() };
}

function extractDouyinVideoId(value: string): string | null {
    for (const pattern of [/\/video\/(\d{8,})/i, /modal_id=(\d{8,})/i, /item_ids=(\d{8,})/i, /"aweme_id":"(\d{8,})"/i, /"itemId":"(\d{8,})"/i]) {
        const match = value.match(pattern);
        if (match) return match[1];
    }
    return null;
}

function extractDouyinVideoUrls(html: string): string[] {
    const candidates = new Set<string>();
    for (const match of html.matchAll(/<script[^>]*id="RENDER_DATA"[^>]*>([\s\S]*?)<\/script>/gi)) for (const url of searchDouyinVideoUrls(match[1])) candidates.add(url);
    for (const url of searchDouyinVideoUrls(html)) candidates.add(url);
    return dedupeStrings([...candidates]);
}

function searchDouyinVideoUrls(value: string): string[] {
    const candidates = new Set<string>();
    const normalizedInputs = dedupeStrings([value, decodeURIComponentSafe(value), decodeHtmlEntities(value)]);
    const patterns = [/"playAddr":"([^"]+)"/g, /"downloadAddr":"([^"]+)"/g, /"playApi":"([^"]+)"/g, /"src":"(https?:[^"]+)"/g, /https?:\\\/\\\/[^"'\\<>\s]+/g, /https?:\/\/[^"'<>\\s]+/g];
    for (const input of normalizedInputs) {
        for (const pattern of patterns) {
            for (const match of input.matchAll(pattern)) {
                const normalized = normalizePossibleEscapedUrl(match[1] || match[0]);
                if (!normalized || !/^https?:\/\//i.test(normalized) || !/douyin|byte|bytedance|toutiao|tos-cn/i.test(normalized)) continue;
                candidates.add(normalizeDouyinVideoUrl(normalized));
            }
        }
    }
    return [...candidates];
}

function normalizePossibleEscapedUrl(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const decoded = decodeHtmlEntities(decodeURIComponentSafe(trimmed)).replace(/\\u002F/gi, '/').replace(/\\u0026/gi, '&').replace(/\\\//g, '/').replace(/&amp;/gi, '&');
    return decoded.startsWith('//') ? `https:${decoded}` : decoded;
}

function normalizeDouyinVideoUrl(remoteUrl: string): string {
    const url = new URL(remoteUrl);
    if (url.pathname.includes('/playwm/')) url.pathname = url.pathname.replace('/playwm/', '/play/');
    url.searchParams.delete('watermark');
    return url.toString();
}

function decodeURIComponentSafe(value: string): string {
    try { return decodeURIComponent(value); } catch { return value; }
}

function decodeHtmlEntities(value: string): string {
    return value.replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&#x2F;/gi, '/').replace(/&#47;/g, '/').replace(/&amp;/g, '&');
}

function dedupeStrings(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))];
}

function scoreTikTokVideoCandidate(remoteUrl: string): number {
    const normalized = remoteUrl.toLowerCase();
    let score = 0;
    if (/video\/tos|aweme\/v\d+\/play|playaddr|downloadaddr/.test(normalized)) score += 80;
    if (/play|video/.test(normalized)) score += 15;
    if (/playback1|website-login-static|webapp-desktop/.test(normalized)) score -= 300;
    if (/logo|loading|splash|placeholder|cover|poster|avatar|icon|thumb|thumbnail/.test(normalized)) score -= 120;
    if (/\.mp4(?:$|\?)/.test(normalized)) score += 5;
    return score;
}

function isLikelySubtitlePayload(buffer: Buffer): boolean {
    const head = buffer.subarray(0, 64).toString('utf8').trimStart();
    return head.startsWith('WEBVTT');
}

async function downloadRemoteBinaryFromUrl(params: { url: string; maxSize: number; remotePlatform: RemoteVideoPlatform; downloadMethod: RemoteVideoDownloadMethod; fileName?: string; mimeType?: string; requireVideoContent: boolean; headers?: Record<string, string> }): Promise<RemoteVideoBinary> {
    const response = await fetch(params.url, { headers: params.headers, redirect: 'follow' });
    if (!response.ok) throw new AppError(`Failed to download remote video: ${response.status} ${response.statusText}`, 400);
    const resolvedUrl = response.url || params.url;
    await assertSafeRemoteVideoUrl(resolvedUrl);
    const contentType = response.headers.get('content-type') || '';
    const extension = path.extname(new URL(resolvedUrl).pathname).toLowerCase();
    if (params.requireVideoContent && !(contentType.startsWith('video/') || REMOTE_VIDEO_EXTENSIONS.has(extension))) throw new Error('Resolved remote URL did not expose a direct video file.');
    const contentLength = Number.parseInt(response.headers.get('content-length') || '', 10);
    if (Number.isFinite(contentLength) && contentLength > params.maxSize) throw new AppError(`Video size exceeds ${Math.round(params.maxSize / (1024 * 1024))}MB. Please use a shorter video link.`, 400);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > params.maxSize) throw new AppError(`Video size exceeds ${Math.round(params.maxSize / (1024 * 1024))}MB. Please use a shorter video link.`, 400);
    return { buffer, fileName: params.fileName || inferRemoteVideoFileName(resolvedUrl), mimeType: params.mimeType || contentType.split(';')[0].trim() || REMOTE_VIDEO_MIME_MAP[extension] || 'video/mp4', remotePlatform: params.remotePlatform, downloadMethod: params.downloadMethod };
}

async function downloadRemoteVideoWithYtDlp(context: RemoteVideoDownloadContext): Promise<RemoteVideoBinary> {
    const invocation = await findYtDlpCommand();
    if (!invocation) throw new AppError('The current environment cannot resolve this kind of video page link. Please use a direct mp4/webm URL or upload a local video.', 400);
    const directory = path.join(TEMP_VIDEO_ROOT, `remote-${Date.now()}-${randomUUID()}`);
    const outputTemplate = path.join(directory, 'source.%(ext)s');
    await fs.mkdir(directory, { recursive: true });
    try {
        try {
            const ytDlpArgs = await buildYtDlpDownloadArgs(invocation, context, outputTemplate, directory);
            await execFileAsync(invocation.command, [...invocation.prefixArgs, ...ytDlpArgs]);
        } catch (error) {
            const stderr = typeof (error as { stderr?: unknown })?.stderr === 'string' ? (error as { stderr: string }).stderr.trim() : '';
            const stdout = typeof (error as { stdout?: unknown })?.stdout === 'string' ? (error as { stdout: string }).stdout.trim() : '';
            const detail = stderr || stdout || (error instanceof Error ? error.message : String(error || ''));
            throw new AppError(buildYtDlpFailureMessage(context, detail), 400);
        }
        const entries = await fs.readdir(directory);
        const fileName = entries.find((entry) => REMOTE_VIDEO_EXTENSIONS.has(path.extname(entry).toLowerCase()));
        if (!fileName) {
            if (entries.find((entry) => /\.(mp3|m4a|aac|wav|ogg|opus)$/i.test(entry))) throw new AppError('This link only exposed audio and no downloadable video track. TikTok-style pages may require browser cookies, browser automation, or a different server IP.', 400);
            throw new AppError('Could not download a usable video from this link. Try another URL.', 400);
        }
        const buffer = await fs.readFile(path.join(directory, fileName));
        if (buffer.length > context.maxSize) throw new AppError(`Video size exceeds ${Math.round(context.maxSize / (1024 * 1024))}MB. Please use a shorter video link.`, 400);
        return { buffer, fileName, mimeType: REMOTE_VIDEO_MIME_MAP[path.extname(fileName).toLowerCase()] || 'video/mp4', remotePlatform: context.platform, downloadMethod: 'yt-dlp' };
    } finally {
        await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
}

async function findYtDlpCommand(): Promise<YtDlpInvocation | null> {
    for (const candidate of [{ command: 'yt-dlp', prefixArgs: [] }, { command: 'yt-dlp.exe', prefixArgs: [] }, { command: 'python', prefixArgs: ['-m', 'yt_dlp'] }, { command: 'python3', prefixArgs: ['-m', 'yt_dlp'] }, { command: 'py', prefixArgs: ['-m', 'yt_dlp'] }] satisfies YtDlpInvocation[]) {
        try { await execFileAsync(candidate.command, [...candidate.prefixArgs, '--version']); return candidate; } catch {}
    }
    return null;
}

async function buildYtDlpDownloadArgs(invocation: YtDlpInvocation, context: RemoteVideoDownloadContext, outputTemplate: string, scratchDirectory: string): Promise<string[]> {
    const args = ['--no-update', '--no-playlist', '--merge-output-format', 'mp4', '-f', 'bv*+ba/bestvideo*+bestaudio/best'];
    args.push(...(await buildYtDlpCookiesArgs(scratchDirectory)));
    const proxy = readTrimmedServerEnv('YT_DLP_PROXY');
    if (proxy) args.push('--proxy', proxy);
    if (readBooleanServerEnv('YT_DLP_FORCE_IPV4')) args.push('--force-ipv4');
    if (context.platform === 'youtube') {
        args.push('--js-runtimes', 'node');
        args.push('--remote-components', 'ejs:github');
        args.push('--extractor-args', readTrimmedServerEnv('YT_DLP_YOUTUBE_EXTRACTOR_ARGS') || 'youtube:player_client=tv,android,mweb;formats=incomplete');
    }
    const extractorArgs = readTrimmedServerEnv('YT_DLP_EXTRACTOR_ARGS');
    if (extractorArgs) args.push('--extractor-args', extractorArgs);
    const impersonateTarget = await resolveYtDlpImpersonateTarget(invocation, context.normalizedUrl);
    if (impersonateTarget) args.push('--impersonate', impersonateTarget);
    for (const header of buildYtDlpHeaders(context.normalizedUrl)) args.push('--add-headers', header);
    args.push('-o', outputTemplate, context.normalizedUrl);
    return args;
}

async function buildYtDlpCookiesArgs(scratchDirectory: string): Promise<string[]> {
    const cookiesFile = readTrimmedServerEnv('YT_DLP_COOKIES_FILE');
    if (cookiesFile) return ['--cookies', cookiesFile];
    const cookiesBase64 = readTrimmedServerEnv('YT_DLP_COOKIES_BASE64');
    if (cookiesBase64) {
        const decoded = Buffer.from(cookiesBase64, 'base64').toString('utf8').trim();
        if (!decoded) throw new AppError('YT_DLP_COOKIES_BASE64 is configured but empty after decoding.', 500);
        const generatedCookiesPath = path.join(scratchDirectory, 'cookies.txt');
        await fs.writeFile(generatedCookiesPath, decoded, 'utf8');
        return ['--cookies', generatedCookiesPath];
    }
    const cookiesFromBrowser = readTrimmedServerEnv('YT_DLP_COOKIES_FROM_BROWSER');
    return cookiesFromBrowser ? ['--cookies-from-browser', cookiesFromBrowser] : [];
}

function buildYtDlpHeaders(remoteUrl: string): string[] {
    const headers = new Set<string>();
    const referer = readTrimmedServerEnv('YT_DLP_REFERER') || inferRemoteVideoReferer(remoteUrl);
    if (referer) headers.add(`Referer: ${referer}`);
    const userAgent = readTrimmedServerEnv('YT_DLP_USER_AGENT');
    if (userAgent) headers.add(`User-Agent: ${userAgent}`);
    for (const header of parseYtDlpExtraHeaders(readServerEnv('YT_DLP_EXTRA_HEADERS'))) headers.add(header);
    return [...headers];
}

function parseYtDlpExtraHeaders(value: string | undefined): string[] {
    return value ? value.split(/\r?\n/).map((header) => header.trim()).filter((header) => header.includes(':')) : [];
}

function inferRemoteVideoReferer(remoteUrl: string): string {
    const url = new URL(remoteUrl);
    return `${url.protocol}//${url.host}/`;
}

async function resolveYtDlpImpersonateTarget(invocation: YtDlpInvocation, remoteUrl: string): Promise<string | null> {
    const explicit = readTrimmedServerEnv('YT_DLP_IMPERSONATE');
    if (explicit) return explicit;
    if (!shouldPreferYtDlpImpersonation(remoteUrl)) return null;
    const availableTargets = await listAvailableYtDlpImpersonateTargets(invocation);
    for (const target of ['chrome', 'edge', 'firefox', 'safari']) {
        const matchedTarget = [...availableTargets].find((available) => available === target || available.startsWith(`${target}-`));
        if (matchedTarget) return matchedTarget;
    }
    return null;
}

function shouldPreferYtDlpImpersonation(remoteUrl: string): boolean {
    const hostname = new URL(remoteUrl).hostname.toLowerCase();
    return ['tiktok.com', 'douyin.com', 'xiaohongshu.com', 'instagram.com'].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

async function listAvailableYtDlpImpersonateTargets(invocation: YtDlpInvocation): Promise<Set<string>> {
    if (!cachedYtDlpImpersonateTargetsPromise) {
        cachedYtDlpImpersonateTargetsPromise = execFileAsync(invocation.command, [...invocation.prefixArgs, '--list-impersonate-targets']).then(({ stdout }) => parseYtDlpImpersonateTargets(stdout)).catch(() => new Set<string>());
    }
    return cachedYtDlpImpersonateTargetsPromise;
}

function parseYtDlpImpersonateTargets(output: string): Set<string> {
    const targets = new Set<string>();
    for (const rawLine of output.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('[') || line.startsWith('Client') || line.startsWith('-') || line.startsWith('WARNING:') || line.includes('(unavailable)')) continue;
        const match = line.match(/^([A-Za-z0-9_-]+)/);
        if (match) targets.add(match[1].toLowerCase());
    }
    return targets;
}

function readTrimmedServerEnv(key: string): string | null {
    const value = readServerEnv(key)?.trim();
    return value ? value : null;
}

function readBooleanServerEnv(key: string): boolean {
    const value = readTrimmedServerEnv(key)?.toLowerCase();
    return value === '1' || value === 'true' || value === 'yes';
}

function buildYtDlpFailureMessage(context: RemoteVideoDownloadContext, detail: string): string {
    const normalizedDetail = detail.trim();
    if (context.platform === 'youtube') {
        if (/no supported javascript runtime/i.test(normalizedDetail)) return 'yt-dlp could not extract this YouTube video because no supported JavaScript runtime was available. Install Node.js in the runtime and keep yt-dlp remote components enabled.';
        if (/403|forbidden/i.test(normalizedDetail)) return 'yt-dlp hit a 403 while downloading this YouTube video. This usually means the server IP, cookies, or YouTube client profile is blocked. Configure cookies or a proxy, or retry from a different egress IP.';
        if (/sabr|po token|missing a url|unable to download video data/i.test(normalizedDetail)) return `yt-dlp could not resolve a usable YouTube stream. ${normalizedDetail} Try refreshing yt-dlp remote components, setting YT_DLP_YOUTUBE_EXTRACTOR_ARGS, or using cookies/proxy.`;
        return `yt-dlp could not extract this YouTube video. ${normalizedDetail}`.trim();
    }
    if (!shouldPreferYtDlpImpersonation(context.normalizedUrl)) return `yt-dlp could not extract a video from this link. ${normalizedDetail}`.trim();
    if (/connection was reset|timed out|403|captcha|login|required|unable to download webpage/i.test(normalizedDetail)) return `yt-dlp could not extract a TikTok-style page video. ${normalizedDetail} Configure YT_DLP_COOKIES_FILE or YT_DLP_COOKIES_BASE64, and add YT_DLP_PROXY if the server IP is blocked.`;
    return `yt-dlp could not extract a TikTok-style page video. ${normalizedDetail}`.trim();
}

function inferRemoteVideoFileName(remoteUrl: string): string {
    const url = new URL(remoteUrl);
    const baseName = path.basename(url.pathname) || 'remote-video';
    return REMOTE_VIDEO_EXTENSIONS.has(path.extname(baseName).toLowerCase()) ? baseName : `${baseName || 'remote-video'}.mp4`;
}
