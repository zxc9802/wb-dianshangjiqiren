import { NextRequest } from 'next/server';
import { AppError, AuthError, errorResponse, getAuthUser } from '../../lib/auth';
import { readBackendUrl } from '../../lib/server-env';
import { assertUserCanAccessOfficialBot } from '../../lib/server-bot-access';

const BACKEND_IMAGE_API_PREFIX = '/api/image-assets/';
const LEGACY_FRONTEND_IMAGE_PREFIX = '/generated-images/';
const FRONTEND_LEGACY_IMAGE_PROXY_PREFIX = '/api/generated-images/';

function isPrivateIpv4Host(hostname: string): boolean {
    const parts = hostname.split('.').map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
        return false;
    }

    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    return false;
}

function isInternalAssetHost(hostname: string): boolean {
    const normalized = hostname.trim().toLowerCase();
    if (!normalized) return false;
    if (normalized === 'localhost' || normalized.endsWith('.internal') || normalized.endsWith('.local')) {
        return true;
    }
    return isPrivateIpv4Host(normalized);
}

function buildTargetUrl(req: NextRequest, pathSegments: string[] = []): string {
    const backendUrl = readBackendUrl();
    const suffix = pathSegments.length > 0 ? `/${pathSegments.join('/')}` : '';
    return `${backendUrl}/api/image-generations${suffix}${req.nextUrl.search}`;
}

function copyRequestHeaders(req: NextRequest, includeContentType: boolean): Headers {
    const headers = new Headers();
    const authorization = req.headers.get('authorization');
    const accept = req.headers.get('accept');
    const contentType = req.headers.get('content-type');

    if (authorization) headers.set('authorization', authorization);
    if (accept) headers.set('accept', accept);
    if (includeContentType && contentType) headers.set('content-type', contentType);

    return headers;
}

function toFrontendServedAssetUrl(value: string): string {
    if (!value) return value;

    if (value.startsWith(BACKEND_IMAGE_API_PREFIX)) {
        return value;
    }

    if (value.startsWith(LEGACY_FRONTEND_IMAGE_PREFIX)) {
        return `${FRONTEND_LEGACY_IMAGE_PROXY_PREFIX}${value.slice(LEGACY_FRONTEND_IMAGE_PREFIX.length)}`;
    }

    if (!/^https?:\/\//i.test(value)) {
        return value;
    }

    try {
        const url = new URL(value);
        if (url.pathname.startsWith(BACKEND_IMAGE_API_PREFIX)) {
            return value;
        }
        if (url.pathname.startsWith(LEGACY_FRONTEND_IMAGE_PREFIX)) {
            if (!isInternalAssetHost(url.hostname)) {
                return value;
            }
            return `${FRONTEND_LEGACY_IMAGE_PROXY_PREFIX}${url.pathname.slice(LEGACY_FRONTEND_IMAGE_PREFIX.length)}${url.search}`;
        }
        return value;
    } catch {
        return value;
    }
}

function normalizeImageGenerationRecord(record: unknown): unknown {
    if (!record || typeof record !== 'object') return record;

    const candidate = record as Record<string, unknown>;
    const next: Record<string, unknown> = { ...candidate };

    if (typeof candidate.referenceImagePath === 'string') {
        next.referenceImagePath = toFrontendServedAssetUrl(candidate.referenceImagePath);
    }

    if (Array.isArray(candidate.resultImagePaths)) {
        next.resultImagePaths = candidate.resultImagePaths.map((item) => (
            typeof item === 'string' ? toFrontendServedAssetUrl(item) : item
        ));
    }

    return next;
}

function normalizeImageGenerationPayload(payload: Record<string, unknown>): Record<string, unknown> {
    const nextPayload: Record<string, unknown> = { ...payload };
    const data = payload.data;

    if (Array.isArray((data as Record<string, unknown> | undefined)?.items)) {
        const record = data as Record<string, unknown>;
        nextPayload.data = {
            ...record,
            items: (record.items as unknown[]).map((item) => normalizeImageGenerationRecord(item)),
        };
        return nextPayload;
    }

    nextPayload.data = normalizeImageGenerationRecord(data);
    return nextPayload;
}

async function normalizeImageGenerationResponse(upstream: Response): Promise<Response> {
    const contentType = upstream.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
        const body = await upstream.arrayBuffer();
        return new Response(body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: upstream.headers,
        });
    }

    const payload = await upstream.json() as Record<string, unknown>;
    const nextPayload = normalizeImageGenerationPayload(payload);

    return Response.json(nextPayload, {
        status: upstream.status,
        statusText: upstream.statusText,
    });
}

export async function proxyImageGenerationRequest(req: NextRequest, pathSegments: string[] = []): Promise<Response> {
    const targetUrl = buildTargetUrl(req, pathSegments);
    const headers = copyRequestHeaders(req, true);
    const body = req.method === 'GET' || req.method === 'HEAD'
        ? undefined
        : await req.arrayBuffer();

    try {
        const upstream = await fetch(targetUrl, {
            method: req.method,
            headers,
            body: body && body.byteLength > 0 ? body : undefined,
            cache: 'no-store',
        });

        return normalizeImageGenerationResponse(upstream);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Image generation service unavailable';
        return Response.json({ success: false, message }, { status: 502 });
    }
}

function fileExtensionFromMimeType(mimeType: string): string {
    switch (mimeType.toLowerCase()) {
        case 'image/jpeg':
        case 'image/jpg':
            return 'jpg';
        case 'image/webp':
            return 'webp';
        case 'image/gif':
            return 'gif';
        default:
            return 'png';
    }
}

async function requestBackendImageGeneration(sourceHeaders: Headers, body: Record<string, unknown>) {
    const headers = new Headers();
    const authorization = sourceHeaders.get('authorization');
    const accept = sourceHeaders.get('accept');
    if (authorization) headers.set('authorization', authorization);
    if (accept) headers.set('accept', accept);

    const backendUrl = readBackendUrl();
    const targetUrl = `${backendUrl}/api/image-generations/generate`;
    const formData = new FormData();

    const scalarKeys = [
        'prompt',
        'negativePrompt',
        'aspectRatio',
        'stylePreset',
        'background',
        'lighting',
        'referenceStrength',
        'count',
    ] as const;

    for (const key of scalarKeys) {
        const value = body[key];
        if (value === undefined || value === null || value === '') continue;
        formData.set(key, String(value));
    }

    const referenceImage = body.referenceImage;
    const referenceImageMime = body.referenceImageMime;
    if (typeof referenceImage === 'string' && referenceImage && typeof referenceImageMime === 'string' && referenceImageMime) {
        const extension = fileExtensionFromMimeType(referenceImageMime);
        const blob = new Blob([Buffer.from(referenceImage, 'base64')], { type: referenceImageMime });
        formData.set('referenceImage', blob, `reference.${extension}`);
    }

    const upstream = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body: formData,
        cache: 'no-store',
    });

    const contentType = upstream.headers.get('content-type') || '';
    const payload = contentType.includes('application/json')
        ? await upstream.json() as Record<string, unknown>
        : { success: false, message: await upstream.text() };

    return {
        ok: upstream.ok,
        status: upstream.status,
        statusText: upstream.statusText,
        payload: normalizeImageGenerationPayload(payload),
    };
}

export async function generateImageViaBackend(sourceHeaders: Headers, body: Record<string, unknown>) {
    return requestBackendImageGeneration(sourceHeaders, body);
}

export async function proxyGenerateImageRequest(req: NextRequest): Promise<Response> {
    try {
        const user = await getAuthUser(req);
        await assertUserCanAccessOfficialBot(user.id, 'image-generator', user.role);
        const body = await req.json() as Record<string, unknown>;
        const upstream = await requestBackendImageGeneration(req.headers, body);
        return Response.json(upstream.payload, {
            status: upstream.status,
            statusText: upstream.statusText,
        });
    } catch (error) {
        if (error instanceof AuthError || error instanceof AppError) {
            return errorResponse(error);
        }
        const message = error instanceof Error ? error.message : 'Image generation request failed';
        return Response.json({ success: false, message }, { status: 502 });
    }
}
