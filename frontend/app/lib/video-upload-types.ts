import type { ChatAttachmentPayload } from './api';

export type VideoUploadJobStatus = 'uploading' | 'queued' | 'running' | 'succeeded' | 'failed';
export type VideoUploadStage = 'uploading' | 'merging' | 'compressing' | 'analyzing' | 'complete';

export interface VideoUploadJobSnapshot {
    id: string;
    status: VideoUploadJobStatus;
    stage: VideoUploadStage;
    message: string;
    chunkSize: number;
    totalChunks: number;
    uploadedChunks: number;
    uploadPercent: number;
    result?: ChatAttachmentPayload;
    error?: string;
}

export interface CreateVideoUploadInput {
    fileName: string;
    fileSize: number;
    mimeType: string;
    responseModel: string;
    analysisPrompt: string;
}
