import { randomUUID } from 'node:crypto';
import { prisma } from '../utils/prisma';
import { recordUsage, ensureUsageLedger, type UsageEvent } from '../services/usage-ledger';
import { emptyUsage, mergeUsage, parseTokenUsage } from '../services/usage-values';
import { Router, Response } from 'express';
import multer, { MulterError } from 'multer';
import { AppError } from '../middleware/error';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authMiddleware);

const YUNWU_BASE_URL = 'https://yunwu.ai';
const MAX_REFERENCE_SIZE = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_REFERENCE_SIZE },
    fileFilter: (_req, file, cb) => {
        if (ALLOWED_MIME.has(file.mimetype)) {
            cb(null, true);
            return;
        }
        cb(new AppError('Only jpg/jpeg/png/webp reference images are allowed', 400));
    },
});

const uploadSingleReference = (req: AuthRequest, res: Response) => new Promise<void>((resolve, reject) => {
    upload.single('referenceImage')(req, res, (err) => {
        if (err) reject(err);
        else resolve();
    });
});

function getVideoApiKey(): string {
    const apiKey = process.env.YUNWU_VIDEO_API_KEY?.trim() || process.env.AI_API_KEY?.trim();
    if (!apiKey) {
        throw new AppError('YUNWU_VIDEO_API_KEY or AI_API_KEY is not configured', 500);
    }
    return apiKey;
}

function requiredString(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new AppError(`${label} is required`, 400);
    }
    return value.trim();
}

function optionalString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        if (value === 'true') return true;
        if (value === 'false') return false;
    }
    return undefined;
}

function normalizeSize(value: unknown): string {
    const raw = optionalString(value);
    if (!raw) return '16x9';
    return raw.replace(':', 'x');
}

async function fetchRemoteAsset(sourceUrl: string): Promise<{ blob: Blob; fileName: string }> {
    const upstream = await fetch(sourceUrl);
    if (!upstream.ok) {
        throw new AppError(`Failed to fetch reference image: ${upstream.status}`, 502);
    }

    const arrayBuffer = await upstream.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_REFERENCE_SIZE) {
        throw new AppError('Reference image must be <= 10MB', 400);
    }

    const mimeType = upstream.headers.get('content-type') || 'image/png';
    const extension = mimeType.includes('jpeg') ? 'jpg' : mimeType.includes('webp') ? 'webp' : 'png';

    return {
        blob: new Blob([arrayBuffer], { type: mimeType }),
        fileName: `reference.${extension}`,
    };
}

function extractVideoUrl(payload: unknown): string | null {
    if (!payload || typeof payload !== 'object') return null;
    const record = payload as Record<string, unknown>;

    if (typeof record.url === 'string' && record.url) return record.url;
    if (typeof record.video_url === 'string' && record.video_url) return record.video_url;

    const output = record.output;
    if (output && typeof output === 'object') {
        const nested = output as Record<string, unknown>;
        if (typeof nested.url === 'string' && nested.url) return nested.url;
        if (typeof nested.video_url === 'string' && nested.video_url) return nested.video_url;
    }

    return null;
}

function extractUpstreamMessage(payload: unknown, fallback: string): string {
    if (!payload || typeof payload !== 'object') return fallback;
    const record = payload as Record<string, unknown>;

    if (typeof record.message_zh === 'string' && record.message_zh.trim()) {
        return record.message_zh.trim();
    }

    if (typeof record.message === 'string' && record.message.trim()) {
        return record.message.trim();
    }

    const error = record.error;
    if (error && typeof error === 'object') {
        const nested = error as Record<string, unknown>;
        if (typeof nested.message_zh === 'string' && nested.message_zh.trim()) {
            return nested.message_zh.trim();
        }
        if (typeof nested.message === 'string' && nested.message.trim()) {
            return nested.message.trim();
        }
    }

    return fallback;
}

router.post('/generate', async (req: AuthRequest, res: Response) => {
    if (!req.userId) throw new AppError('Unauthorized', 401);

    try {
        await uploadSingleReference(req, res);
    } catch (error) {
        if (error instanceof MulterError && error.code === 'LIMIT_FILE_SIZE') {
            throw new AppError('Reference image must be <= 10MB', 400);
        }
        if (error instanceof AppError) throw error;
        throw new AppError('Invalid upload payload', 400);
    }

    const model = requiredString(req.body.model, 'model');
    const prompt = requiredString(req.body.prompt, 'prompt');
    const seconds = String(optionalString(req.body.seconds) || '5');
    const size = normalizeSize(req.body.size ?? req.body.aspectRatio);
    const watermark = optionalBoolean(req.body.watermark);
    const referenceImageUrl = optionalString(req.body.referenceImageUrl);

    const formData = new FormData();
    formData.set('model', model);
    formData.set('prompt', prompt);
    formData.set('seconds', seconds);
    formData.set('size', size);
    if (watermark !== undefined) {
        formData.set('watermark', String(watermark));
    }

    if (req.file) {
        const referenceBytes = new Uint8Array(req.file.buffer);
        formData.set(
            'input_reference',
            new Blob([referenceBytes], { type: req.file.mimetype }),
            req.file.originalname || 'reference.png',
        );
    } else if (referenceImageUrl && /^https?:\/\//i.test(referenceImageUrl)) {
        const asset = await fetchRemoteAsset(referenceImageUrl);
        formData.set('input_reference', asset.blob, asset.fileName);
    }

    const usage: UsageEvent = { ...emptyUsage(), userId: req.userId, source: 'main', requestId: randomUUID(), provider: new URL(YUNWU_BASE_URL).hostname, model, status: 'pending', tokenBasis: 'missing' };
    await recordUsage(usage);
    const upstream = await fetch(`${YUNWU_BASE_URL}/v1/videos`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${getVideoApiKey()}`,
            Accept: 'application/json',
        },
        body: formData,
    }).catch(async error => { await recordUsage({ ...usage, status: 'failed' }); throw error; });

    const contentType = upstream.headers.get('content-type') || '';
    const payload = contentType.includes('application/json')
        ? await upstream.json() as Record<string, unknown>
        : { message: await upstream.text() };

    if (!upstream.ok) {
        await recordUsage({ ...usage, status: 'failed' });
        return res.status(upstream.status).json({
            success: false,
            message: extractUpstreamMessage(payload, 'Video generation request failed'),
            data: payload,
        });
    }

    const taskId = typeof payload.id === 'string' ? payload.id : null;
    Object.assign(usage, mergeUsage(usage, parseTokenUsage(payload)));
    await recordUsage({ ...usage, upstreamRequestId: taskId, tokenBasis: usage.totalTokens === null ? 'missing' : 'reported', status: taskId ? 'pending' : 'failed' });
    if (!taskId) {
        return res.status(502).json({
            success: false,
            message: 'Upstream accepted the request but returned no task id',
            data: payload,
        });
    }

    res.json({
        success: true,
        data: {
            taskId,
            raw: payload,
        },
    });
});

router.get('/status', async (req: AuthRequest, res: Response) => {
    if (!req.userId) throw new AppError('Unauthorized', 401);

    const taskId = requiredString(req.query.taskId, 'taskId');
    await ensureUsageLedger();
    const entries = await prisma.$queryRaw<{ data: UsageEvent }[]>`SELECT data FROM ai_usage_events WHERE user_id = ${req.userId} AND source = 'main' AND data->>'upstreamRequestId' = ${taskId} AND data->>'provider' = ${new URL(YUNWU_BASE_URL).hostname} LIMIT 1`;
    const usage = entries[0]?.data;
    const upstream = await fetch(`${YUNWU_BASE_URL}/v1/videos/${encodeURIComponent(taskId)}`, {
        headers: {
            Authorization: `Bearer ${getVideoApiKey()}`,
            Accept: 'application/json',
        },
    });

    const contentType = upstream.headers.get('content-type') || '';
    const payload = contentType.includes('application/json')
        ? await upstream.json() as Record<string, unknown>
        : { message: await upstream.text() };

    if (!upstream.ok) {
        return res.status(upstream.status).json({
            success: false,
            message: extractUpstreamMessage(payload, 'Video status request failed'),
            data: payload,
        });
    }

    if (usage && ['completed', 'succeeded', 'failed', 'cancelled'].includes(String(payload.status))) {
        const tokens = mergeUsage(usage, parseTokenUsage(payload));
        const completed = ['completed', 'succeeded'].includes(String(payload.status));
        await recordUsage({ ...usage, ...tokens, status: completed ? 'completed' : 'failed', tokenBasis: tokens.totalTokens === null ? 'missing' : 'reported' });
    }

    res.json({
        success: true,
        data: {
            taskId,
            status: typeof payload.status === 'string' ? payload.status : null,
            videoUrl: extractVideoUrl(payload),
            raw: payload,
        },
    });
});

export default router;
