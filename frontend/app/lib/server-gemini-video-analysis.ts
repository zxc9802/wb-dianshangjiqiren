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
