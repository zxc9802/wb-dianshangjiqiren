import { createReadStream, createWriteStream } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { readServerEnv } from './server-env';

const DEFAULT_VIDEO_UPLOAD_ROOT = path.join(process.cwd(), 'storage', 'video-upload-jobs');
const SAFE_JOB_ID = /^[0-9a-f-]+$/i;
const SAFE_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.m4v']);

function getUploadRoot(): string {
    return readServerEnv('VIDEO_UPLOAD_TEMP_ROOT')?.trim() || DEFAULT_VIDEO_UPLOAD_ROOT;
}

function validateJobId(jobId: string): string {
    if (!SAFE_JOB_ID.test(jobId)) {
        throw new Error('Invalid video upload job id.');
    }
    return jobId;
}

function validateIndex(index: number): number {
    if (!Number.isInteger(index) || index < 0) {
        throw new Error('Invalid video chunk index.');
    }
    return index;
}

function getJobDirectory(jobId: string): string {
    return path.join(getUploadRoot(), validateJobId(jobId));
}

function getChunkPath(jobId: string, index: number): string {
    return path.join(getJobDirectory(jobId), 'chunks', `${validateIndex(index)}.part`);
}

export async function writeVideoChunk(params: {
    jobId: string;
    index: number;
    bytes: Buffer;
}): Promise<{ created: boolean; byteSize: number }> {
    const chunkPath = getChunkPath(params.jobId, params.index);
    await fs.mkdir(path.dirname(chunkPath), { recursive: true });

    let handle: FileHandle | undefined;
    try {
        handle = await fs.open(chunkPath, 'wx');
        await handle.writeFile(params.bytes);
        return { created: true, byteSize: params.bytes.length };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error;
        }
        const stat = await fs.stat(chunkPath);
        if (stat.size !== params.bytes.length) {
            throw new Error('Video chunk already exists with a different size.');
        }
        return { created: false, byteSize: stat.size };
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

export async function hasVideoChunk(params: {
    jobId: string;
    index: number;
    expectedBytes: number;
}): Promise<boolean> {
    try {
        const stat = await fs.stat(getChunkPath(params.jobId, params.index));
        return stat.isFile() && stat.size === params.expectedBytes;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

export async function mergeVideoChunks(params: {
    jobId: string;
    totalChunks: number;
    extension: string;
}): Promise<string> {
    if (!Number.isInteger(params.totalChunks) || params.totalChunks <= 0) {
        throw new Error('Invalid total video chunks.');
    }
    const extension = params.extension.toLowerCase();
    if (!SAFE_VIDEO_EXTENSIONS.has(extension)) {
        throw new Error('Invalid video extension.');
    }

    const jobDirectory = getJobDirectory(params.jobId);
    await fs.mkdir(jobDirectory, { recursive: true });
    const outputPath = path.join(jobDirectory, `source${extension}`);
    const output = createWriteStream(outputPath, { flags: 'w' });

    try {
        for (let index = 0; index < params.totalChunks; index += 1) {
            const input = createReadStream(getChunkPath(params.jobId, index));
            for await (const chunk of input) {
                if (!output.write(chunk)) {
                    await once(output, 'drain');
                }
            }
        }
        output.end();
        await once(output, 'finish');
        return outputPath;
    } catch (error) {
        output.destroy();
        await fs.rm(outputPath, { force: true }).catch(() => undefined);
        throw error;
    }
}

export async function cleanupVideoUploadDirectory(jobId: string): Promise<void> {
    await fs.rm(getJobDirectory(jobId), { recursive: true, force: true }).catch(() => undefined);
}

export async function cleanupStaleVideoUploadDirectories(ttlMs: number): Promise<void> {
    const root = getUploadRoot();
    let entries: Array<import('node:fs').Dirent>;
    try {
        entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
    }

    const cutoff = Date.now() - ttlMs;
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
        const directory = path.join(root, entry.name);
        const stat = await fs.stat(directory).catch(() => null);
        if (stat && stat.mtimeMs < cutoff) {
            await fs.rm(directory, { recursive: true, force: true });
        }
    }));
}
