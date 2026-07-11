import type { ChatAttachmentPayload } from './api';
import type { VideoUploadJobSnapshot } from './video-upload-types';

export const VIDEO_CHUNK_UPLOAD_THRESHOLD_BYTES = 20 * 1024 * 1024;
const MAX_CONCURRENT_CHUNKS = 3;
const RETRY_DELAYS_MS = [500, 1000, 2000];
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_MS = 60 * 60 * 1000;

type ApiEnvelope<T> = {
    success?: boolean;
    data?: T;
    error?: string;
    message?: string;
};

function getAuthorizationHeaders(contentType?: string): Record<string, string> {
    const headers: Record<string, string> = {};
    if (contentType) headers['Content-Type'] = contentType;
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('token') : null;
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
}

export async function readJsonResponse<T>(response: Response, fallbackMessage: string): Promise<T> {
    const contentType = response.headers.get('content-type') || '';
    const rawText = await response.text().catch(() => '');
    let payload: ApiEnvelope<unknown> | null = null;
    if (contentType.includes('application/json') && rawText) {
        try {
            payload = JSON.parse(rawText) as ApiEnvelope<unknown>;
        } catch {
            payload = null;
        }
    }

    if (!response.ok) {
        if (response.status === 504 || /gateway timeout|error code 524/i.test(rawText)) {
            throw new Error('视频上传超时，请检查网络后重试。');
        }
        if (response.status === 502 || response.status === 503 || contentType.includes('text/html')) {
            throw new Error('视频上传服务暂时不可用，请稍后重试。');
        }
        throw new Error(payload?.error || payload?.message || fallbackMessage);
    }

    if (!payload) {
        throw new Error(fallbackMessage);
    }
    return payload as T;
}

async function fetchJobEnvelope(
    fetchImpl: typeof fetch,
    url: string,
    init: RequestInit,
    fallbackMessage: string,
): Promise<VideoUploadJobSnapshot> {
    const envelope = await readJsonResponse<ApiEnvelope<VideoUploadJobSnapshot>>(
        await fetchImpl(url, init),
        fallbackMessage,
    );
    if (!envelope.data) {
        throw new Error(fallbackMessage);
    }
    return envelope.data;
}

export async function uploadVideoInChunks(options: {
    file: File;
    responseModel: string;
    onProgress?: (snapshot: VideoUploadJobSnapshot) => void;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
}): Promise<ChatAttachmentPayload> {
    const fetchImpl = options.fetchImpl || fetch;
    const sleep = options.sleep || ((ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms)));
    const created = await fetchJobEnvelope(fetchImpl, '/api/video-uploads', {
        method: 'POST',
        headers: getAuthorizationHeaders('application/json'),
        body: JSON.stringify({
            fileName: options.file.name,
            fileSize: options.file.size,
            mimeType: options.file.type,
            responseModel: options.responseModel,
        }),
    }, '无法创建视频上传任务。');
    options.onProgress?.(created);

    let completedChunks = 0;
    let nextChunkIndex = 0;
    const uploadOneChunk = async (index: number): Promise<void> => {
        const start = index * created.chunkSize;
        const end = Math.min(options.file.size, start + created.chunkSize);
        const chunk = options.file.slice(start, end);
        let lastError: unknown;
        for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
            try {
                await fetchJobEnvelope(fetchImpl, `/api/video-uploads/${created.id}/chunks/${index}`, {
                    method: 'PUT',
                    headers: getAuthorizationHeaders('application/octet-stream'),
                    body: chunk,
                }, `第 ${index + 1} 个视频分片上传失败。`);
                completedChunks += 1;
                options.onProgress?.({
                    ...created,
                    uploadedChunks: completedChunks,
                    uploadPercent: Math.round((completedChunks / created.totalChunks) * 100),
                    message: `正在上传视频 ${Math.round((completedChunks / created.totalChunks) * 100)}%。`,
                });
                return;
            } catch (error) {
                lastError = error;
                if (attempt >= RETRY_DELAYS_MS.length) break;
                await sleep(RETRY_DELAYS_MS[attempt]);
            }
        }
        throw lastError instanceof Error ? lastError : new Error(`第 ${index + 1} 个视频分片上传失败。`);
    };

    const worker = async () => {
        while (true) {
            const index = nextChunkIndex;
            nextChunkIndex += 1;
            if (index >= created.totalChunks) return;
            await uploadOneChunk(index);
        }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_CHUNKS, created.totalChunks) }, () => worker()));

    const queued = await fetchJobEnvelope(fetchImpl, `/api/video-uploads/${created.id}/complete`, {
        method: 'POST',
        headers: getAuthorizationHeaders('application/json'),
    }, '无法开始视频处理。');
    options.onProgress?.(queued);

    const startedAt = Date.now();
    while (Date.now() - startedAt < MAX_POLL_MS) {
        const job = await fetchJobEnvelope(fetchImpl, `/api/video-uploads/${created.id}`, {
            method: 'GET',
            headers: getAuthorizationHeaders(),
        }, '无法查询视频处理进度。');
        options.onProgress?.(job);
        if (job.status === 'succeeded') {
            if (!job.result?.tempVideoToken) {
                throw new Error('视频处理结果不完整，请重新上传。');
            }
            return job.result;
        }
        if (job.status === 'failed') {
            throw new Error(job.error || job.message || '视频处理失败。');
        }
        await sleep(POLL_INTERVAL_MS);
    }
    throw new Error('视频处理等待超时，请稍后重试。');
}
