'use client';

import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useConversationsStore, type Conversation } from '../../stores/conversations';
import { startPcm16kMonoRecorder, type Pcm16Recorder } from '../../lib/pcmRecorder';
import { api, type AttachmentInfo, type ChatAttachmentPayload } from '../../lib/api';
import { useAuthStore } from '../../stores/auth';
import AdminBotPanel from '../../components/AdminBotPanel';
import { BUILTIN_BOT_MAP, BUILTIN_BOT_NAME_MAP, GENERIC_CHAT_BOT_ID, VIDEO_BREAKDOWN_BOT_ID } from '../../lib/builtin-bots';
import { normalizeUpstreamErrorMessage } from '../../lib/upstream-error';
import {
    buildMessageDisplayContent,
    ChatAttachmentFrame,
    ChatAttachmentKind,
    formatDuration,
    stripAttachmentDisplayLabels,
} from '../../lib/chat-attachments';
import {
    DEFAULT_RESPONSE_MODEL,
    DEFAULT_WEB_SEARCH_MODE,
    getResponseModelLabel,
    getWebSearchModeLabel,
    RESPONSE_MODEL_OPTIONS,
    RESPONSE_MODEL_STORAGE_PREFIX,
    WEB_SEARCH_MODE_OPTIONS,
    WEB_SEARCH_MODE_STORAGE_PREFIX,
    isSelectableResponseModel,
    isWebSearchMode,
    type ResponseModel,
    type WebSearchMode,
} from '../../lib/chat-models';
import {
    getLocalConversationVideo,
    listLocalConversationVideos,
    migrateConversationVideoScope,
    putLocalConversationVideo,
} from '../../lib/local-conversation-videos';
import { consumeLaunchChatDraft } from '../../lib/launch-chat-drafts';
import {
    formatMessage as formatRichMessage,
    stripSuggestionBlock as stripRichSuggestionBlock,
} from '../../lib/formatMessage';
import { splitStreamingMarkdownBlocks } from '../../lib/streaming-markdown';
import {
    readJsonResponse,
    uploadVideoInChunks,
    VIDEO_CHUNK_UPLOAD_THRESHOLD_BYTES,
} from '../../lib/chunked-video-upload';
import {
    normalizeChatStreamEvent,
    parseChatStreamSseLine,
    type ChatStreamProjection,
} from '../../lib/chat-stream-events';
import styles from './chat.module.css';
import {
    MessageSquare, BarChart3, Trash2, Sparkles, FileText,
    ClipboardList, Paperclip, Mic, Loader2, Send, ArrowLeft,
    Plus, ChevronDown, Star, Pin, CheckSquare, Square, ArrowRight, Undo2, ImageIcon, Video, Settings,
} from 'lucide-react';

const URL_MATCH_REGEX = /https?:\/\/[^\s<>"'`]+/gi;
const REMOTE_VIDEO_PATH_REGEX = /\.(mp4|mov|webm|m4v)(?:$|[?#])/i;
const KNOWN_VIDEO_HOST_PATTERNS = [
    /(^|\.)youtube\.com$/i,
    /(^|\.)youtu\.be$/i,
    /(^|\.)bilibili\.com$/i,
    /(^|\.)b23\.tv$/i,
    /(^|\.)tiktok\.com$/i,
    /(^|\.)douyin\.com$/i,
    /(^|\.)iesdouyin\.com$/i,
    /(^|\.)xiaohongshu\.com$/i,
    /(^|\.)xhslink\.com$/i,
    /(^|\.)rednote\.com$/i,
    /(^|\.)kuaishou\.com$/i,
    /(^|\.)weishi\.qq\.com$/i,
];

interface MessageAttachment extends Omit<AttachmentInfo, 'id' | 'fileType' | 'fileUrl' | 'kind'> {
    id?: string;
    fileType?: string;
    fileUrl?: string;
    kind: ChatAttachmentKind;
}

interface MessageItem {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
    kind?: 'text' | 'image';
    imageUrls?: string[];
    imagePrompt?: string;
    aspectRatio?: string;
    attachments?: MessageAttachment[];
}

interface RenderedMessageItem extends MessageItem {
    textContent: string;
    html: string;
}

interface RenderedMessageCacheEntry {
    message: MessageItem;
    rendered: RenderedMessageItem;
}

interface AttachedFile {
    file: File;
    name: string;
    fileSize?: number;
    extractedText?: string;
    previewUrl: string | null;
    isImage: boolean;
    isVideo: boolean;
    kind: ChatAttachmentKind;
    mimeType?: string;
    durationMs?: number;
    transcript?: string;
    frames?: ChatAttachmentFrame[];
    tempVideoToken?: string;
    clientVideoId?: string;
    videoLabel?: string;
    source?: 'current' | 'history';
    orderIndex?: number;
    remoteVideoUrl?: string;
}

const MAX_ATTACHMENTS = 10;
const MAX_AUTO_REFERENCED_HISTORY_VIDEOS = 2;
const DRAFT_CONVERSATION_SCOPE_PREFIX = 'draft-video-scope';
const IMAGE_MODE_ASPECT_RATIO = '1:1';
const TABLE_COPY_LABEL = '复制表格';
const TABLE_COPIED_LABEL = '已复制表格';
const STREAMING_RENDER_INTERVAL_MS = 140;
const IMAGE_JOB_POLL_INTERVAL_MS = 2000;
const IMAGE_JOB_POLL_TIMEOUT_MS = 5 * 60 * 1000;
const ACCEPTED_ATTACHMENT_EXTENSIONS = new Set([
    'pdf',
    'docx',
    'txt',
    'md',
    'csv',
    'pptx',
    'jpg',
    'jpeg',
    'png',
    'gif',
    'webp',
    'mp4',
    'mov',
    'webm',
    'm4v',
]);
const CLIPBOARD_MIME_EXTENSION_MAP: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'video/x-m4v': 'm4v',
};

interface ConversationVideoCatalogItem {
    clientVideoId: string;
    videoLabel: string;
    fileName: string;
    fileSize: number;
    mimeType?: string;
    previewUrl?: string;
    extractedText: string;
    durationMs?: number;
    transcript?: string;
    frames?: ChatAttachmentFrame[];
    createdAt: number;
    orderIndex: number;
    attachmentId?: string;
    messageId?: string;
    isAvailableLocally: boolean;
    remoteVideoUrl?: string;
}

interface VideoResolutionNotice {
    type: 'ambiguous' | 'missing';
    message: string;
    allowTextFallback: boolean;
}

interface WfState {
    workflowId: string;
    workflowName: string;
    steps: Array<{ botId: string; botName: string }>;
    currentStep: number;
    stepOutputs: string[];
    selectedMessages: Record<number, string[]>;
}

interface MessageListProps {
    renderedMessages: RenderedMessageItem[];
    wfState: WfState | null;
    selectedMsgIds: Set<string>;
    onMessageContentClick: (event: ReactMouseEvent<HTMLDivElement>) => void;
    onTogglePinMessage: (id: string) => void;
}

interface LoadingMessageProps {
    show: boolean;
}

interface StreamingMessageProps {
    show: boolean;
    streamingText: string;
    imageModeEnabled: boolean;
    imageStatusText: string;
    onMessageContentClick: (event: ReactMouseEvent<HTMLDivElement>) => void;
}

interface StreamingMarkdownMessageProps {
    text: string;
    onMessageContentClick: (event: ReactMouseEvent<HTMLDivElement>) => void;
}

interface StreamingMarkdownBlockProps {
    html: string;
    onMessageContentClick: (event: ReactMouseEvent<HTMLDivElement>) => void;
}

interface RenderedStreamingMarkdownBlock {
    key: string;
    html: string;
}

const BOT_NAMES = BUILTIN_BOT_NAME_MAP;
const STREAMING_MARKDOWN_BLOCK_CACHE_LIMIT = 400;
const streamingMarkdownBlockHtmlCache = new Map<string, string>();

type ConversationMessageResponsePayload = {
    data?: {
        kind?: 'text' | 'image';
        content?: string;
        suggestions?: string[];
    };
    error?: string;
    message?: string;
};

function getFriendlyChatErrorMessage(input: unknown): string {
    return normalizeUpstreamErrorMessage(input, {
        timeoutMessage: '服务超时，请稍后重试或切换 Gemini。',
        genericMessage: '服务暂时不可用，请稍后重试。',
    });
}

function sanitizeAssistantMessageContent(text: string): string {
    const looksLikeRenderedErrorPage = text.includes('<!DOCTYPE html')
        || text.includes('<html')
        || text.includes('Error code 524')
        || text.includes('A timeout occurred');

    if (!looksLikeRenderedErrorPage) {
        return text;
    }

    const normalized = getFriendlyChatErrorMessage(text);
    if (normalized === text) {
        return text;
    }

    return text.includes('出错') ? `出错了：${normalized}` : normalized;
}

function normalizeMessageAttachments(attachments?: AttachmentInfo[]): MessageAttachment[] | undefined {
    if (!attachments?.length) {
        return undefined;
    }

    return attachments.map((attachment) => ({
        ...attachment,
        kind: attachment.kind || (attachment.fileType?.startsWith('video/') ? 'video' : attachment.fileType?.startsWith('image/') ? 'image' : 'document'),
    }));
}

function buildRoute(botId: string, params: { cid?: string | null; wf?: string | null; name?: string | null }) {
    const query = new URLSearchParams();
    if (params.cid) query.set('cid', params.cid);
    if (params.wf) query.set('wf', params.wf);
    if (params.name) query.set('name', params.name);
    const search = query.toString();
    return `/chat/${botId}${search ? `?${search}` : ''}`;
}

function toMessages(conversation: Conversation, fallback: string): MessageItem[] {
    const history = conversation.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
        kind: message.kind,
        imageUrls: message.imageUrls,
        imagePrompt: message.imagePrompt,
        aspectRatio: message.aspectRatio,
        attachments: normalizeMessageAttachments(message.attachments),
    }));

    if (history.some((message) => message.id === 'welcome')) {
        return history;
    }

    return [{ id: 'welcome', role: 'assistant', content: fallback, timestamp: Date.now() }, ...history];
}

function stripSuggestionBlock(text: string): string {
    return stripRichSuggestionBlock(text);
}

function getCachedStreamingMarkdownHtml(block: string): string {
    const cached = streamingMarkdownBlockHtmlCache.get(block);
    if (cached !== undefined) {
        return cached;
    }

    const html = formatMessage(block, false);
    streamingMarkdownBlockHtmlCache.set(block, html);
    if (streamingMarkdownBlockHtmlCache.size > STREAMING_MARKDOWN_BLOCK_CACHE_LIMIT) {
        const firstKey = streamingMarkdownBlockHtmlCache.keys().next().value;
        if (firstKey !== undefined) {
            streamingMarkdownBlockHtmlCache.delete(firstKey);
        }
    }
    return html;
}

const MemoizedMessageList = memo(function MessageList({
    renderedMessages,
    wfState,
    selectedMsgIds,
    onMessageContentClick,
    onTogglePinMessage,
}: MessageListProps) {
    return (
        <>
                {wfState && wfState.currentStep > 0 && wfState.stepOutputs[wfState.currentStep - 1] && (
                    <div className={styles.wfContextCard}>
                        <div className={styles.wfContextLabel}>
                            上一步（{wfState.steps[wfState.currentStep - 1]?.botName}）的成果：
                        </div>
                        <div className={styles.wfContextContent}>
                            {wfState.stepOutputs[wfState.currentStep - 1].slice(0, 300)}
                            {wfState.stepOutputs[wfState.currentStep - 1].length > 300 ? '...' : ''}
                        </div>
                    </div>
                )}
                {renderedMessages.map((message) => (
                    <div
                        key={message.id}
                        className={`${styles.message} ${message.role === 'user' ? styles.userMsg : styles.assistantMsg} ${wfState && selectedMsgIds.has(message.id) ? styles.msgPinned : ''}`}
                    >
                        <div className={styles.msgBubble}>
                            {message.kind === 'image' && message.imageUrls?.length ? (
                                <div className={styles.imageMessage}>
                                    {message.content ? (
                                        <div className={styles.msgContent} onClick={onMessageContentClick} dangerouslySetInnerHTML={{ __html: message.html }} />
                                    ) : null}
                                    <div className={styles.imageGrid}>
                                        {message.imageUrls.map((imageUrl, imageIndex) => (
                                            <a
                                                key={`${imageUrl}-${imageIndex}`}
                                                href={imageUrl}
                                                target="_blank"
                                                rel="noreferrer"
                                                className={styles.imageLink}
                                            >
                                                {/* eslint-disable-next-line @next/next/no-img-element -- generated chat images are data URIs or remote assets returned at runtime */}
                                                <img
                                                    src={imageUrl}
                                                    alt={`generated-${imageIndex + 1}`}
                                                    className={styles.imageThumb}
                                                    loading="lazy"
                                                />
                                            </a>
                                        ))}
                                    </div>
                                </div>
                            ) : (
                                <div className={styles.attachmentMessage}>
                                    {message.attachments?.length ? (
                                        <div className={styles.messageAttachmentGroup}>
                                            {message.attachments.map((attachment, attachmentIndex) => (
                                                <div
                                                    key={`${attachment.fileName}-${attachmentIndex}`}
                                                    className={`${styles.messageAttachmentCard} ${attachment.kind === 'video' ? styles.messageAttachmentVideo : ''}`}
                                                >
                                                    <div className={styles.messageAttachmentHead}>
                                                        <span className={styles.messageAttachmentBadge}>
                                                            {attachment.kind === 'video' ? (
                                                                <><Video size={14} /> 视频</>
                                                            ) : attachment.kind === 'image' ? (
                                                                <><ImageIcon size={14} /> 图片</>
                                                            ) : (
                                                                <><FileText size={14} /> 文件</>
                                                            )}
                                                        </span>
                                                        {attachment.kind === 'video' && attachment.durationMs ? (
                                                            <span className={styles.messageAttachmentMeta}>
                                                                时长 {formatDuration(attachment.durationMs)}
                                                            </span>
                                                        ) : null}
                                                    </div>
                                                    <div className={styles.messageAttachmentName}>{attachment.fileName}</div>
                                                    {attachment.kind === 'video' && attachment.frames?.length ? (
                                                        <div className={styles.videoFrameGrid}>
                                                            {attachment.frames.map((frame, frameIndex) => (
                                                                <div key={`${frame.url}-${frameIndex}`} className={styles.videoFrameItem}>
                                                                    {/* eslint-disable-next-line @next/next/no-img-element -- persisted video keyframes are served from local static files */}
                                                                    <img
                                                                        src={frame.url}
                                                                        alt={`${attachment.fileName}-frame-${frameIndex + 1}`}
                                                                        className={styles.videoFrameThumb}
                                                                        loading="lazy"
                                                                    />
                                                                    <span className={styles.videoFrameTime}>{formatDuration(frame.timestampMs)}</span>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    ) : attachment.kind === 'image' && attachment.previewUrl ? (
                                                        /* eslint-disable-next-line @next/next/no-img-element -- image attachment previews may come from object URLs or persisted paths */
                                                        <img
                                                            src={attachment.previewUrl}
                                                            alt={attachment.fileName}
                                                            className={styles.messageAttachmentPreview}
                                                            loading="lazy"
                                                        />
                                                    ) : null}
                                                </div>
                                            ))}
                                        </div>
                                    ) : null}
                                    {message.textContent ? (
                                        <div className={styles.msgContent} onClick={onMessageContentClick} dangerouslySetInnerHTML={{ __html: message.html }} />
                                    ) : null}
                                </div>
                            )}
                            {wfState && message.role === 'assistant' && message.id !== 'welcome' && message.kind !== 'image' && (
                                <button
                                    className={`${styles.pinBtn} ${selectedMsgIds.has(message.id) ? styles.pinBtnActive : ''}`}
                                    onClick={() => onTogglePinMessage(message.id)}
                                >
                                    <Pin size={14} />
                                    {selectedMsgIds.has(message.id) ? '已选' : '选择'}
                                </button>
                            )}
                        </div>
                    </div>
                ))}
        </>
    );
});

const LoadingMessage = memo(function LoadingMessage({ show }: LoadingMessageProps) {
    if (!show) {
        return null;
    }

    return (
        <div className={`${styles.message} ${styles.assistantMsg}`}>
            <div className={styles.msgBubble}>
                <div className={styles.thinking}>
                    <span />
                    <span />
                    <span />
                </div>
            </div>
        </div>
    );
});

const StreamingMarkdownBlock = memo(function StreamingMarkdownBlock({
    html,
    onMessageContentClick,
}: StreamingMarkdownBlockProps) {
    if (!html) {
        return null;
    }

    return (
        <div
            className={styles.streamingMarkdownBlock}
            onClick={onMessageContentClick}
            dangerouslySetInnerHTML={{ __html: html }}
        />
    );
});

const StreamingMarkdownMessage = memo(function StreamingMarkdownMessage({
    text,
    onMessageContentClick,
}: StreamingMarkdownMessageProps) {
    const cleanText = text;
    const { stableBlocks, activeBlock } = useMemo(
        () => splitStreamingMarkdownBlocks(cleanText),
        [cleanText],
    );
    const renderedStableBlocks = useMemo(() => {
        return stableBlocks.map((block, index): RenderedStreamingMarkdownBlock => (
            {
                key: `${index}:${block}`,
                html: getCachedStreamingMarkdownHtml(block),
            }
        ));
    }, [stableBlocks]);
    const activeHtml = useMemo(
        () => (activeBlock ? formatMessage(activeBlock, false) : ''),
        [activeBlock],
    );

    if (!cleanText.trim()) {
        return null;
    }

    return (
        <div className={`${styles.msgContent} ${styles.streamingMsgContent}`}>
            {renderedStableBlocks.map((block) => (
                <StreamingMarkdownBlock
                    key={block.key}
                    html={block.html}
                    onMessageContentClick={onMessageContentClick}
                />
            ))}
            {activeHtml ? (
                <StreamingMarkdownBlock
                    key="active"
                    html={activeHtml}
                    onMessageContentClick={onMessageContentClick}
                />
            ) : null}
        </div>
    );
});

const StreamingMessage = memo(function StreamingMessage({
    show,
    streamingText,
    imageModeEnabled,
    imageStatusText,
    onMessageContentClick,
}: StreamingMessageProps) {
    if (!show) {
        return null;
    }

    return (
        <div className={`${styles.message} ${styles.assistantMsg} ${styles.streamingMessage}`}>
            <div className={styles.msgBubble}>
                {streamingText ? (
                    <StreamingMarkdownMessage
                        text={streamingText}
                        onMessageContentClick={onMessageContentClick}
                    />
                ) : imageModeEnabled ? (
                    <div className={styles.imagePending}>
                        <div className={styles.thinking}>
                            <span />
                            <span />
                            <span />
                        </div>
                        <div className={styles.imagePendingText}>
                            {imageStatusText || '正在生成图片，通常需要 10 到 40 秒。'}
                        </div>
                    </div>
                ) : (
                    <div className={styles.thinking}>
                        <span />
                        <span />
                        <span />
                    </div>
                )}
            </div>
        </div>
    );
});

function createClientVideoId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `video-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createDraftConversationScope(botId: string): string {
    return `${DRAFT_CONVERSATION_SCOPE_PREFIX}:${botId}:${createClientVideoId()}`;
}

function normalizeSearchText(text: string): string {
    return text.toLowerCase().trim().replace(/\s+/g, ' ');
}

function getFileNameAliases(fileName: string): string[] {
    const lowered = normalizeSearchText(fileName);
    const base = lowered.replace(/\.[^.]+$/, '');
    return [lowered, base].filter(Boolean);
}

function parseChineseOrdinalToken(token: string): number | null {
    if (!token) {
        return null;
    }

    if (/^\d+$/.test(token)) {
        return Number.parseInt(token, 10);
    }

    const digits = new Map<string, number>([
        ['一', 1],
        ['二', 2],
        ['三', 3],
        ['四', 4],
        ['五', 5],
        ['六', 6],
        ['七', 7],
        ['八', 8],
        ['九', 9],
        ['十', 10],
    ]);

    if (digits.has(token)) {
        return digits.get(token) || null;
    }

    if (token.startsWith('十')) {
        return 10 + (digits.get(token.slice(1)) || 0);
    }

    if (token.endsWith('十')) {
        return (digits.get(token[0]) || 0) * 10;
    }

    if (token.includes('十')) {
        const [tens, ones] = token.split('十');
        return ((digits.get(tens) || 0) * 10) + (digits.get(ones) || 0);
    }

    return null;
}

function collectExplicitVideoOrders(text: string): number[] {
    const matches = new Set<number>();
    const regexes = [
        /视频\s*(\d+)/g,
        /第([一二三四五六七八九十\d]+)(?:个|条)?视频/g,
    ];

    for (const regex of regexes) {
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
            const value = parseChineseOrdinalToken(match[1]);
            if (value && value > 0) {
                matches.add(value);
            }
        }
    }

    return [...matches];
}

function isComparisonPrompt(text: string): boolean {
    return /(比较|对比|参考|参照|按.+优化|按照.+优化|基于.+优化|和.+比|跟.+比)/.test(text);
}

function hasCurrentVideoReference(text: string): boolean {
    return /(这个视频|当前视频|刚发的|刚上传的|现在这个)/.test(text);
}

function hasPreviousVideoReference(text: string): boolean {
    return /(上一个视频|前一个视频|上条视频|上一条视频|前一条视频|刚才那个视频|之前那个视频)/.test(text);
}

function hasVideoAnalysisIntent(text: string): boolean {
    return /(视频|片子|镜头|画面|开头|开场|结尾|转场|字幕|配音|口播|bgm|BGM|配乐|节奏|卡点|分镜|封面|时长|逐帧|重看|复看|再看一遍|重新看|分析这个|拆解这个|优化这个视频)/.test(text);
}

function isLikelyRemoteVideoUrl(value: string): boolean {
    try {
        const url = new URL(value);
        const hostname = url.hostname.trim().toLowerCase();
        if (!hostname) {
            return false;
        }

        if (REMOTE_VIDEO_PATH_REGEX.test(url.pathname)) {
            return true;
        }

        return KNOWN_VIDEO_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
    } catch {
        return false;
    }
}

function extractRemoteVideoUrls(text: string): string[] {
    const matches = text.match(URL_MATCH_REGEX) || [];
    const uniqueUrls = new Set<string>();

    for (const match of matches) {
        const normalized = match
            .trim()
            .replace(/[),.;!?]+$/, '')
            .replace(/[\u3002\uff0c\uff1f\uff01\uff1b\uff1a\uff09\u3011\u300b]+$/u, '')
            .replace(/[\p{Script=Han}]+$/gu, '');
        if (!normalized || !isLikelyRemoteVideoUrl(normalized)) {
            continue;
        }

        uniqueUrls.add(normalized);
    }

    return [...uniqueUrls];
}

function stripRemoteVideoUrls(text: string, remoteVideoUrls: string[]): string {
    if (remoteVideoUrls.length === 0) {
        return text.trim();
    }

    let nextText = text;
    for (const remoteVideoUrl of remoteVideoUrls) {
        nextText = nextText.replace(remoteVideoUrl, ' ');
    }

    return nextText
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

function inferRemoteVideoFileName(remoteVideoUrl: string, fallbackIndex: number): string {
    try {
        const url = new URL(remoteVideoUrl);
        const pathname = url.pathname || '';
        const rawSegment = pathname.split('/').filter(Boolean).at(-1) || `remote-video-${fallbackIndex}`;
        const decodedSegment = decodeURIComponent(rawSegment);
        return /\.[a-z0-9]{2,5}$/i.test(decodedSegment)
            ? decodedSegment
            : `${decodedSegment}.mp4`;
    } catch {
        return `remote-video-${fallbackIndex}.mp4`;
    }
}

function inferRemoteVideoMimeType(remoteVideoUrl: string): string {
    if (/\.mov(?:$|[?#])/i.test(remoteVideoUrl)) {
        return 'video/quicktime';
    }
    if (/\.webm(?:$|[?#])/i.test(remoteVideoUrl)) {
        return 'video/webm';
    }
    if (/\.m4v(?:$|[?#])/i.test(remoteVideoUrl)) {
        return 'video/x-m4v';
    }
    return 'video/mp4';
}

function getAttachmentExtension(file: File): string {
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    if (ext && ext !== file.name.toLowerCase()) {
        return ext;
    }

    return CLIPBOARD_MIME_EXTENSION_MAP[file.type] || '';
}

function isAcceptedAttachmentFile(file: File): boolean {
    const ext = getAttachmentExtension(file);
    return ACCEPTED_ATTACHMENT_EXTENSIONS.has(ext);
}

function normalizeDroppedOrPastedFile(file: File, index: number): File {
    if (file.name.trim()) {
        return file;
    }

    const ext = getAttachmentExtension(file) || 'bin';
    const prefix = file.type.startsWith('video/') ? 'pasted-video' : file.type.startsWith('image/') ? 'pasted-image' : 'pasted-file';
    return new File([file], `${prefix}-${Date.now()}-${index + 1}.${ext}`, {
        type: file.type,
        lastModified: file.lastModified,
    });
}

function createAttachedFileFromLocalFile(file: File): AttachedFile {
    const ext = getAttachmentExtension(file);
    const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext);
    const isVideo = ['mp4', 'mov', 'webm', 'm4v'].includes(ext);

    return {
        file,
        name: file.name,
        previewUrl: isImage ? URL.createObjectURL(file) : null,
        isImage,
        isVideo,
        kind: isVideo ? 'video' : isImage ? 'image' : 'document',
    };
}

function dedupeConversationVideos(videos: ConversationVideoCatalogItem[]): ConversationVideoCatalogItem[] {
    const seen = new Set<string>();
    return videos.filter((video) => {
        if (seen.has(video.clientVideoId)) {
            return false;
        }
        seen.add(video.clientVideoId);
        return true;
    });
}

function canReuseConversationVideo(video: ConversationVideoCatalogItem): boolean {
    return video.isAvailableLocally || Boolean(video.remoteVideoUrl);
}

function getConversationVideoStateLabel(video: ConversationVideoCatalogItem): string {
    if (video.isAvailableLocally) {
        return '本机可用';
    }

    if (video.remoteVideoUrl) {
        return '链接可重取';
    }

        return '需重传';
}

function chooseReferencedConversationVideos(params: {
    text: string;
    manualSelectedIds: string[];
    conversationVideos: ConversationVideoCatalogItem[];
    hasCurrentUploads: boolean;
    skipHistoryVideoReuse?: boolean;
}): {
    historyVideos: ConversationVideoCatalogItem[];
    notice?: VideoResolutionNotice;
} {
    const createMissingVideoNotice = (
        message: string,
        options?: { videoLabel?: string },
    ): {
        historyVideos: ConversationVideoCatalogItem[];
        notice: VideoResolutionNotice;
    } => ({
        historyVideos: [],
        notice: {
            type: 'missing',
            message: options?.videoLabel
                ? `${options.videoLabel} 当前设备已找不到原视频，${message}`
                : message,
            allowTextFallback: true,
        },
    });

    if (params.skipHistoryVideoReuse) {
        return { historyVideos: [] };
    }

    const allVideos = [...params.conversationVideos]
        .sort((left, right) => left.orderIndex - right.orderIndex || left.createdAt - right.createdAt);
    const manualSelections = dedupeConversationVideos(
        params.manualSelectedIds
            .map((id) => allVideos.find((video) => video.clientVideoId === id))
            .filter((video): video is ConversationVideoCatalogItem => Boolean(video)),
    ).slice(0, MAX_AUTO_REFERENCED_HISTORY_VIDEOS);

    if (manualSelections.length > 0) {
        const missingSelections = manualSelections.filter((video) => !canReuseConversationVideo(video));
        if (missingSelections.length > 0) {
            return {
                historyVideos: [],
                notice: {
                    type: 'missing',
                    message: `已选历史视频在当前设备不可用：${missingSelections.map((video) => video.videoLabel).join('、')}。请重新上传，或仅按历史文字继续。`,
                    allowTextFallback: true,
                },
            };
        }

        return { historyVideos: manualSelections };
    }

    const trimmedText = params.text.trim();
    if (!trimmedText) {
        return { historyVideos: [] };
    }

    const explicitOrders = collectExplicitVideoOrders(trimmedText);
    const explicitMatches = dedupeConversationVideos(explicitOrders
        .map((order) => allVideos.find((video) => video.videoLabel === `视频${order}`))
        .filter((video): video is ConversationVideoCatalogItem => Boolean(video)));

    if (explicitMatches.length > 0) {
        const missingMatches = explicitMatches.filter((video) => !canReuseConversationVideo(video));
        if (missingMatches.length > 0) {
            return {
                historyVideos: [],
                notice: {
                    type: 'missing',
                    message: `引用的历史视频在当前设备不可用：${missingMatches.map((video) => video.videoLabel).join('、')}。请重新上传，或仅按历史文字继续。`,
                    allowTextFallback: true,
                },
            };
        }

        return { historyVideos: explicitMatches.slice(0, MAX_AUTO_REFERENCED_HISTORY_VIDEOS) };
    }

    const normalizedText = normalizeSearchText(trimmedText);
    const aliasMatches = dedupeConversationVideos(allVideos.filter((video) => {
        const aliases = [
            video.videoLabel.toLowerCase(),
            ...getFileNameAliases(video.fileName),
        ];
        return aliases.some((alias) => alias && normalizedText.includes(alias));
    }));

    if (aliasMatches.length > 0) {
        if (aliasMatches.length > MAX_AUTO_REFERENCED_HISTORY_VIDEOS && isComparisonPrompt(trimmedText)) {
            return {
                historyVideos: [],
                notice: {
                    type: 'ambiguous',
                    message: '检测到多个可能命中的历史视频。请先在“本会话视频”里点选后再发送。',
                    allowTextFallback: false,
                },
            };
        }

        const missingMatches = aliasMatches.filter((video) => !canReuseConversationVideo(video));
        if (missingMatches.length > 0) {
            return {
                historyVideos: [],
                notice: {
                    type: 'missing',
                    message: `命中的历史视频在当前设备不可用：${missingMatches.map((video) => video.videoLabel).join('、')}。请重新上传，或仅按历史文字继续。`,
                    allowTextFallback: true,
                },
            };
        }

        return { historyVideos: aliasMatches.slice(0, MAX_AUTO_REFERENCED_HISTORY_VIDEOS) };
    }

    const keywordMatches = dedupeConversationVideos(allVideos.filter((video) => {
        if (!video.extractedText && !video.transcript) {
            return false;
        }
        const haystack = normalizeSearchText([video.extractedText, video.transcript, video.fileName].filter(Boolean).join(' '));
        return normalizedText.length >= 2 && haystack.includes(normalizedText);
    }));

    if (keywordMatches.length > 0) {
        if (keywordMatches.length > MAX_AUTO_REFERENCED_HISTORY_VIDEOS) {
            return {
                historyVideos: [],
                notice: {
                    type: 'ambiguous',
                    message: '检测到多个历史视频都可能符合当前描述。请先在“本会话视频”里明确选择。',
                    allowTextFallback: false,
                },
            };
        }

        const missingMatches = keywordMatches.filter((video) => !canReuseConversationVideo(video));
        if (missingMatches.length > 0) {
            return {
                historyVideos: [],
                notice: {
                    type: 'missing',
                    message: `命中的历史视频在当前设备不可用：${missingMatches.map((video) => video.videoLabel).join('、')}。请重新上传，或仅按历史文字继续。`,
                    allowTextFallback: true,
                },
            };
        }

        return { historyVideos: keywordMatches };
    }

    const availableVideos = allVideos.filter(canReuseConversationVideo);
    const latestVideo = allVideos[allVideos.length - 1];
    const previousVideo = allVideos[allVideos.length - 2] || latestVideo;

    if (hasPreviousVideoReference(trimmedText)) {
        if (!previousVideo) {
            return createMissingVideoNotice('请重新上传目标视频，或仅按历史文字继续。');
        }
        if (!canReuseConversationVideo(previousVideo)) {
            return createMissingVideoNotice('请重新上传，或仅按历史文字继续。', {
                videoLabel: previousVideo.videoLabel,
            });
        }
        return { historyVideos: [previousVideo] };
    }

    if (!params.hasCurrentUploads && hasCurrentVideoReference(trimmedText) && latestVideo) {
        if (!canReuseConversationVideo(latestVideo)) {
            return createMissingVideoNotice('请重新上传，或仅按历史文字继续。', {
                videoLabel: latestVideo.videoLabel,
            });
        }
        return { historyVideos: [latestVideo] };
    }

    if (isComparisonPrompt(trimmedText)) {
        if (params.hasCurrentUploads && latestVideo) {
            if (!canReuseConversationVideo(latestVideo)) {
                return createMissingVideoNotice('请重新上传后再比较，或仅按历史文字继续。', {
                    videoLabel: latestVideo.videoLabel,
                });
            }
            return { historyVideos: [latestVideo] };
        }

        if (availableVideos.length === 2) {
            return { historyVideos: availableVideos };
        }

        if (availableVideos.length > 2) {
            return {
                historyVideos: [],
                notice: {
                    type: 'ambiguous',
                    message: '当前会话里有多个历史视频。请先点选要比较的视频后再发送。',
                    allowTextFallback: false,
                },
            };
        }
    }

    if (!params.hasCurrentUploads && latestVideo && hasVideoAnalysisIntent(trimmedText)) {
        if (!canReuseConversationVideo(latestVideo)) {
            return createMissingVideoNotice('请重新上传，或仅按历史文字继续。', {
                videoLabel: latestVideo.videoLabel,
            });
        }
        return { historyVideos: [latestVideo] };
    }

    return { historyVideos: [] };
}

export default function ChatPage() {
    const params = useParams();
    const router = useRouter();
    const searchParams = useSearchParams();
    const botId = params.id as string;
    const conversationId = searchParams.get('cid');
    const workflowFlag = searchParams.get('wf');
    const urlName = searchParams.get('name');
    const launcherDraft = searchParams.get('draft')?.trim() || '';
    const launchDraftId = searchParams.get('ld')?.trim() || '';
    const rawRequestedResponseModel = searchParams.get('rm');
    const requestedResponseModel = isSelectableResponseModel(rawRequestedResponseModel)
        ? rawRequestedResponseModel
        : null;
    const rawRequestedWebSearchMode = searchParams.get('ws');
    const requestedWebSearchMode = isWebSearchMode(rawRequestedWebSearchMode)
        ? rawRequestedWebSearchMode
        : null;
    const builtinBot = BUILTIN_BOT_MAP[botId];
    const fallbackBotName = BOT_NAMES[botId] || urlName || 'AI助手';
    const fallbackWelcome = builtinBot?.welcome
        || (botId === GENERIC_CHAT_BOT_ID
            ? '先告诉我你想解决什么。我会先把关键要求问清，再给你方案。'
            : `你好，我是${fallbackBotName}，说说你的需求。`);

    const {
        conversations,
        favorites,
        createConversation,
        fetchConversation,
        getConversation,
        loadConversations,
        deleteConversation,
        toggleFavorite,
        removeFavorite,
    } = useConversationsStore();

    const currentConversation = conversationId ? getConversation(conversationId) : undefined;
    const botName = currentConversation?.botName || fallbackBotName;
    const isVideoBreakdownBot = botId === VIDEO_BREAKDOWN_BOT_ID;

    const [messages, setMessages] = useState<MessageItem[]>([{ id: 'welcome', role: 'assistant', content: fallbackWelcome, timestamp: Date.now() }]);
    const [inputText, setInputText] = useState('');
    const [imageModeEnabled, setImageModeEnabled] = useState(false);
    const [responseModel, setResponseModel] = useState<ResponseModel>(DEFAULT_RESPONSE_MODEL);
    const [webSearchMode, setWebSearchMode] = useState<WebSearchMode>(DEFAULT_WEB_SEARCH_MODE);
    const [isStreaming, setIsStreaming] = useState(false);
    const [isHydratingLaunchDraft, setIsHydratingLaunchDraft] = useState(Boolean(launchDraftId));
    const [streamingText, setStreamingText] = useState('');
    const [imageStatusText, setImageStatusText] = useState('');
    const [suggestions, setSuggestions] = useState<string[]>([]);
    const [isLoadingConversation, setIsLoadingConversation] = useState(false);
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const skipHydrationConversationIdRef = useRef<string | null>(null);
    const launcherDraftKeyRef = useRef<string | null>(null);
    const hydratedLaunchDraftIdRef = useRef<string | null>(null);
    const draftConversationScopeRef = useRef<string | null>(null);
    const conversationVideoPickerRef = useRef<HTMLDivElement>(null);
    const streamingFlushTimerRef = useRef<number | null>(null);
    const streamingScrollFrameRef = useRef<number | null>(null);
    const pendingStreamingTextRef = useRef('');
    const renderedMessageCacheRef = useRef<Map<string, RenderedMessageCacheEntry>>(new Map());
    const tableCopyResetTimerRef = useRef<number | null>(null);
    const copiedTableButtonRef = useRef<HTMLButtonElement | null>(null);

    const [wfState, setWfState] = useState<WfState | null>(null);
    const [selectedMsgIds, setSelectedMsgIds] = useState<Set<string>>(new Set());
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [botSwitcherOpen, setBotSwitcherOpen] = useState(false);
    const [sidebarTab, setSidebarTab] = useState<'history' | 'favorites'>('history');

    const fileInputRef = useRef<HTMLInputElement>(null);
    const [isUploading, setIsUploading] = useState(false);
    const [videoUploadStatusText, setVideoUploadStatusText] = useState('');
    const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
    const [conversationVideos, setConversationVideos] = useState<ConversationVideoCatalogItem[]>([]);
    const [selectedConversationVideoIds, setSelectedConversationVideoIds] = useState<string[]>([]);
    const [conversationVideoPickerOpen, setConversationVideoPickerOpen] = useState(false);
    const [videoResolutionNotice, setVideoResolutionNotice] = useState<VideoResolutionNotice | null>(null);
    const [isAttachmentDragActive, setIsAttachmentDragActive] = useState(false);

    const [isRecording, setIsRecording] = useState(false);
    const [isTranscribing, setIsTranscribing] = useState(false);
    const recorderRef = useRef<Pcm16Recorder | null>(null);
    const [isGeneratingReport, setIsGeneratingReport] = useState(false);
    const [adminPanelOpen, setAdminPanelOpen] = useState(false);
    const { user } = useAuthStore();
    const isAdmin = user?.role === 'admin';
    const adminBotKind: 'builtin' | 'custom' = botId.startsWith('custom-') ? 'custom' : 'builtin';
    const canUseVideoBreakdownAttachments = isVideoBreakdownBot && !imageModeEnabled;

    const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
        const container = messagesContainerRef.current;
        if (container) {
            if (behavior === 'smooth' && typeof container.scrollTo === 'function') {
                container.scrollTo({ top: container.scrollHeight, behavior });
                return;
            }

            container.scrollTop = container.scrollHeight;
            return;
        }

        messagesEndRef.current?.scrollIntoView({ behavior });
    }, []);

    const scheduleScrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
        if (typeof window === 'undefined') {
            scrollToBottom(behavior);
            return;
        }

        if (streamingScrollFrameRef.current !== null) {
            return;
        }

        streamingScrollFrameRef.current = window.requestAnimationFrame(() => {
            streamingScrollFrameRef.current = null;
            scrollToBottom(behavior);
        });
    }, [scrollToBottom]);

    useEffect(() => () => {
        if (streamingFlushTimerRef.current !== null) {
            window.clearTimeout(streamingFlushTimerRef.current);
        }
        if (streamingScrollFrameRef.current !== null) {
            window.cancelAnimationFrame(streamingScrollFrameRef.current);
        }
        if (tableCopyResetTimerRef.current !== null) {
            window.clearTimeout(tableCopyResetTimerRef.current);
        }
        if (copiedTableButtonRef.current) {
            copiedTableButtonRef.current.textContent = TABLE_COPY_LABEL;
            copiedTableButtonRef.current.classList.remove(styles.copyTableBtnActive);
            copiedTableButtonRef.current = null;
        }
    }, []);

    useEffect(() => {
        scheduleScrollToBottom('smooth');
    }, [messages, scheduleScrollToBottom]);

    useEffect(() => {
        if (!streamingText) {
            return;
        }

        scheduleScrollToBottom('auto');
    }, [streamingText, scheduleScrollToBottom]);

    useEffect(() => {
        void loadConversations().catch((error) => console.error('[Chat] load conversations failed', error));
    }, [loadConversations]);

    useEffect(() => {
        if (!workflowFlag || typeof window === 'undefined') return;
        const raw = sessionStorage.getItem('wf_state');
        if (!raw) return;
        try {
            setWfState(JSON.parse(raw) as WfState);
        } catch {
            setWfState(null);
        }
    }, [workflowFlag]);

    useEffect(() => {
        setSelectedMsgIds(new Set());
        setSelectedConversationVideoIds([]);
        setConversationVideoPickerOpen(false);
        setVideoResolutionNotice(null);
    }, [botId, conversationId]);

    useEffect(() => {
        if (conversationId) {
            draftConversationScopeRef.current = conversationId;
        } else if (!draftConversationScopeRef.current) {
            draftConversationScopeRef.current = null;
        }
    }, [conversationId]);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        if (requestedResponseModel) {
            setResponseModel(requestedResponseModel);
            return;
        }
        const saved = window.localStorage.getItem(`${RESPONSE_MODEL_STORAGE_PREFIX}${botId}`);
        if (isSelectableResponseModel(saved)) {
            setResponseModel(saved);
            return;
        }
        setResponseModel(DEFAULT_RESPONSE_MODEL);
    }, [botId, requestedResponseModel]);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        window.localStorage.setItem(`${RESPONSE_MODEL_STORAGE_PREFIX}${botId}`, responseModel);
    }, [botId, responseModel]);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        if (requestedWebSearchMode) {
            setWebSearchMode(requestedWebSearchMode);
            return;
        }
        const saved = window.localStorage.getItem(`${WEB_SEARCH_MODE_STORAGE_PREFIX}${botId}`);
        if (isWebSearchMode(saved)) {
            setWebSearchMode(saved);
            return;
        }
        setWebSearchMode(DEFAULT_WEB_SEARCH_MODE);
    }, [botId, requestedWebSearchMode]);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        window.localStorage.setItem(`${WEB_SEARCH_MODE_STORAGE_PREFIX}${botId}`, webSearchMode);
    }, [botId, webSearchMode]);

    useEffect(() => {
        if (!launchDraftId) {
            hydratedLaunchDraftIdRef.current = null;
            setIsHydratingLaunchDraft(false);
            return;
        }

        if (hydratedLaunchDraftIdRef.current === launchDraftId) {
            return;
        }

        let cancelled = false;
        setIsHydratingLaunchDraft(true);

        void consumeLaunchChatDraft(launchDraftId)
            .then((draft) => {
                if (cancelled || !draft?.files?.length) {
                    return;
                }

                setAttachedFiles((current) => {
                    const availableSlots = Math.max(0, MAX_ATTACHMENTS - current.length);
                    const nextFiles = draft.files.slice(0, availableSlots).map(createAttachedFileFromLocalFile);

                    if (draft.files.length > availableSlots && typeof window !== 'undefined') {
                        window.alert(`一次最多上传 ${MAX_ATTACHMENTS} 个文件，其余文件已忽略`);
                    }

                    return [...current, ...nextFiles];
                });
            })
            .catch((error) => {
                console.error('[Chat] Failed to restore launch draft attachments', error);
            })
            .finally(() => {
                if (cancelled) {
                    return;
                }

                hydratedLaunchDraftIdRef.current = launchDraftId;
                setIsHydratingLaunchDraft(false);
            });

        return () => {
            cancelled = true;
        };
    }, [launchDraftId]);

    useEffect(() => {
        if (!conversationId) {
            skipHydrationConversationIdRef.current = null;
            setMessages([{ id: 'welcome', role: 'assistant', content: fallbackWelcome, timestamp: Date.now() }]);
            setStreamingText('');
            setSuggestions([]);
            setIsStreaming(false);
            return;
        }

        if (skipHydrationConversationIdRef.current === conversationId) {
            skipHydrationConversationIdRef.current = null;
            setIsLoadingConversation(false);
            return;
        }

        let cancelled = false;
        setIsLoadingConversation(true);
        fetchConversation(conversationId)
            .then((conversation) => {
                if (cancelled) return;
                setMessages(toMessages(conversation, fallbackWelcome));
            })
            .catch((error) => {
                if (cancelled) return;
                console.error('[Chat] fetch conversation failed', error);
                setMessages([{ id: 'welcome', role: 'assistant', content: fallbackWelcome, timestamp: Date.now() }]);
            })
            .finally(() => {
                if (!cancelled) setIsLoadingConversation(false);
            });

        return () => {
            cancelled = true;
        };
    }, [conversationId, fallbackWelcome, fetchConversation]);

    const refreshConversation = useCallback(async (id: string, options?: { syncMessages?: boolean }) => {
        const conversation = await fetchConversation(id);
        if (options?.syncMessages !== false) {
            setMessages(toMessages(conversation, fallbackWelcome));
        }
        return conversation;
    }, [fallbackWelcome, fetchConversation]);

    const pollConversationImageJob = useCallback(async (activeConversationId: string, jobId: string) => {
        const startedAt = Date.now();

        while (true) {
            const response = await api.getConversationImageJob(activeConversationId, jobId);
            const job = response.data;
            if (job.message) {
                setImageStatusText(job.message);
            }

            if (job.status === 'succeeded') {
                const result = job.result;
                if (!result?.imageUrls?.length) {
                    throw new Error('图片生成结果为空');
                }

                const assistantImageTimestamp = Date.now();
                setMessages((current) => [
                    ...current,
                    {
                        id: `assistant-image-${assistantImageTimestamp}`,
                        role: 'assistant',
                        timestamp: assistantImageTimestamp,
                        content: result.content || '已生成图片。',
                        kind: 'image',
                        imageUrls: result.imageUrls,
                        imagePrompt: result.imagePrompt,
                        aspectRatio: result.aspectRatio,
                    },
                ]);
                setImageStatusText('');
                return;
            }

            if (job.status === 'failed') {
                throw new Error(job.error || job.message || '图片生成失败');
            }

            if (Date.now() - startedAt > IMAGE_JOB_POLL_TIMEOUT_MS) {
                throw new Error('图片生成等待超时，请稍后查看历史记录或重试。');
            }

            await new Promise((resolve) => window.setTimeout(resolve, IMAGE_JOB_POLL_INTERVAL_MS));
        }
    }, []);

    const ensureConversationScope = useCallback(() => {
        if (conversationId) {
            draftConversationScopeRef.current = conversationId;
            return conversationId;
        }

        if (!draftConversationScopeRef.current || !draftConversationScopeRef.current.startsWith(DRAFT_CONVERSATION_SCOPE_PREFIX)) {
            draftConversationScopeRef.current = createDraftConversationScope(botId);
        }

        return draftConversationScopeRef.current;
    }, [botId, conversationId]);

    const refreshConversationVideos = useCallback(async () => {
        const scope = conversationId || draftConversationScopeRef.current;
        if (!scope) {
            setConversationVideos([]);
            return;
        }

        try {
            const localVideos = await listLocalConversationVideos(scope);
            const localVideoMap = new Map(localVideos.map((video) => [video.clientVideoId, video]));
            const seen = new Set<string>();
            let fallbackOrder = 1;
            const nextCatalog: ConversationVideoCatalogItem[] = [];

            for (const message of messages) {
                for (const attachment of message.attachments || []) {
                    if (attachment.kind !== 'video' || !attachment.clientVideoId || seen.has(attachment.clientVideoId)) {
                        continue;
                    }

                    seen.add(attachment.clientVideoId);
                    const localVideo = localVideoMap.get(attachment.clientVideoId);
                    const parsedOrder = attachment.videoLabel
                        ? Number.parseInt(attachment.videoLabel.replace(/\D/g, ''), 10)
                        : Number.NaN;
                    const orderIndex = Number.isFinite(parsedOrder) && parsedOrder > 0
                        ? parsedOrder
                        : localVideo?.orderIndex || fallbackOrder;
                    const videoLabel = attachment.videoLabel || `视频${orderIndex}`;
                    fallbackOrder = Math.max(fallbackOrder, orderIndex + 1);

                    nextCatalog.push({
                        clientVideoId: attachment.clientVideoId,
                        videoLabel,
                        fileName: attachment.fileName,
                        fileSize: attachment.fileSize,
                        mimeType: attachment.mimeType,
                        previewUrl: attachment.previewUrl,
                        extractedText: attachment.extractedText || localVideo?.extractedText || '',
                        durationMs: attachment.durationMs,
                        transcript: attachment.transcript || localVideo?.transcript || '',
                        frames: attachment.frames,
                        createdAt: message.timestamp,
                        orderIndex,
                        attachmentId: attachment.id,
                        messageId: message.id,
                        isAvailableLocally: Boolean(localVideo || attachment.remoteVideoUrl),
                        remoteVideoUrl: attachment.remoteVideoUrl,
                    });
                }
            }

            // Keep locally cached videos visible even if the latest conversation
            // payload temporarily misses attachment metadata.
            for (const localVideo of localVideos) {
                if (seen.has(localVideo.clientVideoId)) {
                    continue;
                }

                const orderIndex = localVideo.orderIndex || fallbackOrder;
                const videoLabel = `视频${orderIndex}`;
                fallbackOrder = Math.max(fallbackOrder, orderIndex + 1);

                nextCatalog.push({
                    clientVideoId: localVideo.clientVideoId,
                    videoLabel,
                    fileName: localVideo.fileName,
                    fileSize: localVideo.fileSize,
                    mimeType: localVideo.mimeType,
                    previewUrl: undefined,
                    extractedText: localVideo.extractedText || '',
                    durationMs: undefined,
                    transcript: localVideo.transcript || '',
                    frames: [],
                    createdAt: localVideo.createdAt,
                    orderIndex,
                    isAvailableLocally: true,
                });
            }

            setConversationVideos(nextCatalog.sort((left, right) => left.orderIndex - right.orderIndex || left.createdAt - right.createdAt));
        } catch (error) {
            console.error('[Chat] refresh conversation videos failed', error);
        }
    }, [conversationId, messages]);

    useEffect(() => {
        void refreshConversationVideos();
    }, [refreshConversationVideos]);

    useEffect(() => {
        setSelectedConversationVideoIds((current) => current.filter((id) => conversationVideos.some((video) => video.clientVideoId === id)));
    }, [conversationVideos]);

    useEffect(() => {
        if (!canUseVideoBreakdownAttachments) {
            setSelectedConversationVideoIds([]);
            setConversationVideoPickerOpen(false);
            setVideoResolutionNotice(null);
        }
    }, [canUseVideoBreakdownAttachments]);

    useEffect(() => {
        if (!canUseVideoBreakdownAttachments) {
            setConversationVideoPickerOpen(false);
        }
    }, [canUseVideoBreakdownAttachments]);

    useEffect(() => {
        if (!conversationVideoPickerOpen || typeof window === 'undefined') {
            return;
        }

        const handlePointerDown = (event: MouseEvent | TouchEvent) => {
            const target = event.target as Node | null;
            if (!conversationVideoPickerRef.current?.contains(target)) {
                setConversationVideoPickerOpen(false);
            }
        };

        window.addEventListener('mousedown', handlePointerDown);
        window.addEventListener('touchstart', handlePointerDown);
        return () => {
            window.removeEventListener('mousedown', handlePointerDown);
            window.removeEventListener('touchstart', handlePointerDown);
        };
    }, [conversationVideoPickerOpen]);

    const botConversations = useMemo(
        () => conversations.filter((conversation) => conversation.botId === botId).sort((a, b) => b.updatedAt - a.updatedAt),
        [botId, conversations],
    );
    const reportConversationIds = useMemo(() => {
        if (typeof window === 'undefined') {
            return new Set<string>();
        }

        const nextIds = new Set<string>();
        for (const conversation of botConversations) {
            if (window.localStorage.getItem(`report-${conversation.id}`)) {
                nextIds.add(conversation.id);
            }
        }
        return nextIds;
    }, [botConversations]);
    const botFavorites = useMemo(
        () => favorites.filter((conversation) => conversation.botId === botId).sort((a, b) => b.updatedAt - a.updatedAt),
        [botId, favorites],
    );
    const allBots = useMemo(() => {
        const base = Object.entries(BOT_NAMES).map(([id, name]) => ({ id, name }));
        if (botId.startsWith('custom-') && !base.some((bot) => bot.id === botId)) {
            return [{ id: botId, name: botName }, ...base];
        }
        return base;
    }, [botId, botName]);
    const renderedMessages = useMemo<RenderedMessageItem[]>(
        () => {
            const previousCache = renderedMessageCacheRef.current;
            const nextCache = new Map<string, RenderedMessageCacheEntry>();
            const nextMessages = messages.map((message) => {
                const cached = previousCache.get(message.id);
                if (cached?.message === message) {
                    nextCache.set(message.id, cached);
                    return cached.rendered;
                }

                const rawTextContent = message.attachments?.length
                    ? stripAttachmentDisplayLabels(message.content, message.attachments)
                    : message.content;
                const textContent = message.role === 'assistant'
                    ? sanitizeAssistantMessageContent(rawTextContent)
                    : rawTextContent;
                const rendered = {
                    ...message,
                    textContent,
                    html: formatMessage(stripSuggestionBlock(textContent), message.role === 'assistant'),
                };

                nextCache.set(message.id, { message, rendered });
                return rendered;
            });

            renderedMessageCacheRef.current = nextCache;
            return nextMessages;
        },
        [messages],
    );
    const flushStreamingText = useCallback(() => {
        if (typeof window !== 'undefined' && streamingFlushTimerRef.current !== null) {
            window.clearTimeout(streamingFlushTimerRef.current);
        }

        streamingFlushTimerRef.current = null;
        const nextStreamingText = pendingStreamingTextRef.current;
        startTransition(() => {
            setStreamingText(nextStreamingText);
        });
    }, []);

    const scheduleStreamingTextFlush = useCallback(() => {
        if (typeof window === 'undefined') {
            flushStreamingText();
            return;
        }

        if (streamingFlushTimerRef.current !== null) {
            return;
        }

        streamingFlushTimerRef.current = window.setTimeout(() => {
            flushStreamingText();
        }, STREAMING_RENDER_INTERVAL_MS);
    }, [flushStreamingText]);

    const clearAttachments = useCallback(() => {
        attachedFiles.forEach((file) => {
            if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
        });
        setAttachedFiles([]);
    }, [attachedFiles]);

    const resetCopiedTableButton = useCallback((button: HTMLButtonElement | null) => {
        if (!button) {
            return;
        }

        button.textContent = TABLE_COPY_LABEL;
        button.classList.remove(styles.copyTableBtnActive);
    }, []);

    const serializeTableToPlainText = useCallback((table: HTMLTableElement) => {
        return Array.from(table.rows)
            .map((row) => Array.from(row.cells)
                .map((cell) => cell.innerText.replace(/\r?\n+/g, ' ').trim())
                .join('\t'))
            .filter(Boolean)
            .join('\n');
    }, []);

    const copyRenderedTable = useCallback(async (button: HTMLButtonElement) => {
        const wrapper = button.closest('[data-copy-table-wrapper="true"]');
        const table = wrapper?.querySelector('table');
        if (!(table instanceof HTMLTableElement)) {
            return;
        }

        const plainText = serializeTableToPlainText(table);
        if (!plainText) {
            return;
        }

        try {
            if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
                await navigator.clipboard.write([
                    new ClipboardItem({
                        'text/html': new Blob([table.outerHTML], { type: 'text/html' }),
                        'text/plain': new Blob([plainText], { type: 'text/plain' }),
                    }),
                ]);
            } else {
                await navigator.clipboard.writeText(plainText);
            }

            if (copiedTableButtonRef.current && copiedTableButtonRef.current !== button) {
                resetCopiedTableButton(copiedTableButtonRef.current);
            }

            button.textContent = TABLE_COPIED_LABEL;
            button.classList.add(styles.copyTableBtnActive);
            copiedTableButtonRef.current = button;

            if (tableCopyResetTimerRef.current !== null) {
                window.clearTimeout(tableCopyResetTimerRef.current);
            }

            tableCopyResetTimerRef.current = window.setTimeout(() => {
                resetCopiedTableButton(button);
                if (copiedTableButtonRef.current === button) {
                    copiedTableButtonRef.current = null;
                }
                tableCopyResetTimerRef.current = null;
            }, 1800);
        } catch (error) {
            console.error('[Chat] copy table failed', error);
        }
    }, [resetCopiedTableButton, serializeTableToPlainText]);

    const handleMessageContentClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
        const target = event.target as HTMLElement | null;
        const button = target?.closest('[data-copy-table-button="true"]');
        if (!(button instanceof HTMLButtonElement)) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        void copyRenderedTable(button);
    }, [copyRenderedTable]);

    const toggleImageMode = () => {
        if (!imageModeEnabled && attachedFiles.length > 0) {
            clearAttachments();
        }
        setImageModeEnabled((current) => !current);
    };

    const removeAttachment = (index: number) => {
        setAttachedFiles((current) => current.filter((file, itemIndex) => {
            if (itemIndex === index && file.previewUrl) {
                URL.revokeObjectURL(file.previewUrl);
            }
            return itemIndex !== index;
        }));
    };

    const toggleConversationVideoSelection = useCallback((video: ConversationVideoCatalogItem) => {
        if (!canReuseConversationVideo(video)) {
            setVideoResolutionNotice({
                type: 'missing',
                message: `${video.videoLabel} 当前设备已找不到原视频，请重新上传，或仅按历史文字继续。`,
                allowTextFallback: true,
            });
            return;
        }

        setVideoResolutionNotice(null);
        setSelectedConversationVideoIds((current) => {
            if (current.includes(video.clientVideoId)) {
                return current.filter((id) => id !== video.clientVideoId);
            }

            const next = [...current, video.clientVideoId];
            return next.slice(-MAX_AUTO_REFERENCED_HISTORY_VIDEOS);
        });
    }, []);

    const parseAttachedFile = async (file: File, model: ResponseModel) => {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('responseModel', model);

        const response = await fetch('/api/upload', { method: 'POST', body: formData });
        const data = await readJsonResponse<Record<string, unknown>>(response, '文件上传失败，请稍后重试。');
        if (typeof data.error === 'string' && data.error) throw new Error(data.error);

        return {
            kind: (data.kind || 'document') as ChatAttachmentKind,
            fileName: data.fileName as string,
            fileSize: Number(data.fileSize || file.size),
            mimeType: typeof data.mimeType === 'string' ? data.mimeType : file.type || undefined,
            previewUrl: typeof data.previewUrl === 'string' ? data.previewUrl : undefined,
            extractedText: typeof data.content === 'string' ? data.content : '',
            durationMs: typeof data.durationMs === 'number' ? data.durationMs : undefined,
            transcript: typeof data.transcript === 'string' ? data.transcript : undefined,
            tempVideoToken: typeof data.tempVideoToken === 'string' ? data.tempVideoToken : undefined,
            frames: Array.isArray(data.frames)
                ? data.frames
                    .filter((frame: unknown): frame is { url: string; timestampMs: number } => (
                        typeof frame === 'object'
                        && frame !== null
                        && typeof (frame as { url?: unknown }).url === 'string'
                        && typeof (frame as { timestampMs?: unknown }).timestampMs === 'number'
                    ))
                    .map((frame: { url: string; timestampMs: number }) => ({ url: frame.url, timestampMs: frame.timestampMs }))
                : [],
        } satisfies ChatAttachmentPayload;
    };

    const sendMessage = useCallback(async (rawText: string, options?: { allowTextFallback?: boolean }) => {
        const isImageRequest = imageModeEnabled;
        const hasFiles = !isImageRequest && attachedFiles.length > 0;
        const hasManualHistoryVideos = !isImageRequest
            && isVideoBreakdownBot
            && selectedConversationVideoIds.length > 0;
        if ((!rawText.trim() && !hasFiles && !hasManualHistoryVideos) || isStreaming || isUploading) return;

        setVideoResolutionNotice(null);

        let parsedAttachments = attachedFiles;
        if (!isImageRequest && attachedFiles.length > 0) {
            setIsUploading(true);
            try {
                parsedAttachments = await Promise.all(attachedFiles.map(async (attachment) => {
                    const parsed = attachment.isVideo && attachment.file.size > VIDEO_CHUNK_UPLOAD_THRESHOLD_BYTES
                        ? await uploadVideoInChunks({
                            file: attachment.file,
                            responseModel,
                            analysisPrompt: rawText,
                            onProgress: (snapshot) => setVideoUploadStatusText(snapshot.message),
                        })
                        : await parseAttachedFile(attachment.file, responseModel);
                    return {
                        ...attachment,
                        name: parsed.fileName,
                        kind: parsed.kind,
                        mimeType: parsed.mimeType,
                        extractedText: parsed.extractedText,
                        durationMs: parsed.durationMs,
                        transcript: parsed.transcript,
                        tempVideoToken: parsed.tempVideoToken,
                        frames: parsed.frames,
                        previewUrl: attachment.isImage ? attachment.previewUrl : (parsed.previewUrl || attachment.previewUrl),
                    };
                }));
            } catch (error) {
                alert(error instanceof Error ? error.message : '文件上传失败');
                return;
            } finally {
                setIsUploading(false);
                setVideoUploadStatusText('');
            }
        }

        const detectedRemoteVideoUrls = !isImageRequest && isVideoBreakdownBot
            ? extractRemoteVideoUrls(rawText).slice(0, Math.max(0, MAX_ATTACHMENTS - parsedAttachments.length))
            : [];
        const messageText = stripRemoteVideoUrls(rawText, detectedRemoteVideoUrls);
        const conversationScope = ensureConversationScope();
        const currentVideoCount = conversationVideos.length;
        let nextOrderIndex = currentVideoCount + 1;
        const remoteVideoAttachments: AttachedFile[] = detectedRemoteVideoUrls.map((remoteVideoUrl, index) => ({
            file: new File([], inferRemoteVideoFileName(remoteVideoUrl, currentVideoCount + index + 1), {
                type: inferRemoteVideoMimeType(remoteVideoUrl),
            }),
            name: inferRemoteVideoFileName(remoteVideoUrl, currentVideoCount + index + 1),
            fileSize: 0,
            previewUrl: null,
            isImage: false,
            isVideo: true,
            kind: 'video',
            mimeType: inferRemoteVideoMimeType(remoteVideoUrl),
            extractedText: '',
            remoteVideoUrl,
            source: 'current',
        }));
        const pendingAttachments = [...parsedAttachments, ...remoteVideoAttachments];
        const preparedAttachments = pendingAttachments.map((attachment) => {
            if (attachment.kind !== 'video') {
                return attachment;
            }

            const orderIndex = attachment.orderIndex || nextOrderIndex;
            nextOrderIndex += 1;

            return {
                ...attachment,
                clientVideoId: attachment.clientVideoId || createClientVideoId(),
                videoLabel: attachment.videoLabel || `视频${orderIndex}`,
                source: 'current' as const,
                orderIndex,
            };
        });
        const preparedCurrentVideos = preparedAttachments.filter((attachment) => attachment.kind === 'video');
        const now = Date.now();
        if (preparedCurrentVideos.length > 0) {
            await Promise.all(preparedCurrentVideos
                .filter((attachment) => !attachment.remoteVideoUrl && attachment.file.size > 0)
                .map((attachment) => putLocalConversationVideo({
                    conversationScope,
                    clientVideoId: attachment.clientVideoId as string,
                    fileName: attachment.name,
                    mimeType: attachment.mimeType || attachment.file.type || 'video/mp4',
                    fileSize: attachment.file.size,
                    createdAt: now,
                    lastAccessedAt: now,
                    orderIndex: attachment.orderIndex || currentVideoCount + 1,
                    extractedText: attachment.extractedText || '',
                    transcript: attachment.transcript || '',
                    blob: attachment.file,
                })));
        }

        const referencedHistoryAttachments: AttachedFile[] = [];
        if (!isImageRequest && isVideoBreakdownBot) {
            const resolution = chooseReferencedConversationVideos({
                text: messageText,
                manualSelectedIds: selectedConversationVideoIds,
                conversationVideos,
                hasCurrentUploads: preparedCurrentVideos.length > 0,
                skipHistoryVideoReuse: options?.allowTextFallback,
            });

            if (resolution.notice) {
                setVideoResolutionNotice(resolution.notice);
                return;
            }

            const resolvedHistoryVideos = resolution.historyVideos;

            for (const video of resolvedHistoryVideos) {
                const localVideo = await getLocalConversationVideo(conversationScope, video.clientVideoId);
                if (!localVideo && !video.remoteVideoUrl) {
                    if (!options?.allowTextFallback) {
                        setVideoResolutionNotice({
                            type: 'missing',
                            message: `${video.videoLabel} 在当前设备已不可用，请重新上传，或仅按历史文字继续。`,
                            allowTextFallback: true,
                        });
                        return;
                    }
                    continue;
                }

                referencedHistoryAttachments.push({
                    file: localVideo
                        ? new File([localVideo.blob], video.fileName, {
                            type: video.mimeType || localVideo.mimeType || 'video/mp4',
                            lastModified: localVideo.createdAt,
                        })
                        : new File([], video.fileName, {
                            type: video.mimeType || inferRemoteVideoMimeType(video.remoteVideoUrl || ''),
                        }),
                    name: video.fileName,
                    fileSize: localVideo?.fileSize || video.fileSize,
                    previewUrl: video.previewUrl || null,
                    isImage: false,
                    isVideo: true,
                    kind: 'video',
                    mimeType: video.mimeType || localVideo?.mimeType || inferRemoteVideoMimeType(video.remoteVideoUrl || ''),
                    extractedText: video.extractedText || localVideo?.extractedText,
                    durationMs: video.durationMs,
                    transcript: video.transcript || localVideo?.transcript,
                    frames: video.frames,
                    clientVideoId: video.clientVideoId,
                    videoLabel: video.videoLabel,
                    source: 'history',
                    orderIndex: video.orderIndex,
                    remoteVideoUrl: video.remoteVideoUrl,
                });
            }
        }

        const finalAttachments = [...preparedAttachments, ...referencedHistoryAttachments];
        const requestAttachments: ChatAttachmentPayload[] = finalAttachments.map((attachment) => ({
            kind: attachment.kind,
            fileName: attachment.name,
            fileSize: attachment.fileSize ?? attachment.file.size,
            mimeType: attachment.mimeType || attachment.file.type || undefined,
            previewUrl: attachment.kind === 'video' ? attachment.previewUrl || undefined : undefined,
            extractedText: attachment.extractedText || '',
            durationMs: attachment.durationMs,
            transcript: attachment.transcript,
            tempVideoToken: attachment.tempVideoToken,
            clientVideoId: attachment.clientVideoId,
            videoLabel: attachment.videoLabel,
            source: attachment.source,
            remoteVideoUrl: attachment.remoteVideoUrl,
            frames: attachment.frames,
        }));
        const shouldSendGeminiVideoDirect = responseModel === 'gemini'
            && requestAttachments.some((attachment) => attachment.kind === 'video' && !attachment.tempVideoToken && !attachment.remoteVideoUrl);
        const optimisticAttachments: MessageAttachment[] = finalAttachments.map((attachment) => ({
            kind: attachment.kind,
            fileName: attachment.name,
            fileSize: attachment.fileSize ?? attachment.file.size,
            mimeType: attachment.mimeType || attachment.file.type || undefined,
            previewUrl: attachment.previewUrl || undefined,
            extractedText: attachment.extractedText || '',
            durationMs: attachment.durationMs,
            transcript: attachment.transcript,
            clientVideoId: attachment.clientVideoId,
            videoLabel: attachment.videoLabel,
            remoteVideoUrl: attachment.remoteVideoUrl,
            frames: attachment.frames,
        }));

        const displayText = requestAttachments.length > 0
            ? buildMessageDisplayContent(messageText, requestAttachments)
            : messageText;

        let content = messageText;
        if (wfState && wfState.currentStep > 0 && wfState.stepOutputs[wfState.currentStep - 1]) {
            content = `上一步输出：\n${wfState.stepOutputs[wfState.currentStep - 1]}\n\n当前用户消息：\n${content}`;
        }

        if (parsedAttachments.length > 0) {
            clearAttachments();
        }

        const createConversationPromise = !conversationId ? createConversation(botId) : null;
        const optimisticTimestamp = Date.now();

        setMessages((current) => [
            ...current,
            {
                id: `user-${optimisticTimestamp}`,
                role: 'user',
                content: displayText,
                timestamp: optimisticTimestamp,
                kind: isImageRequest ? 'image' : 'text',
                imagePrompt: isImageRequest ? displayText : undefined,
                aspectRatio: isImageRequest ? IMAGE_MODE_ASPECT_RATIO : undefined,
                attachments: optimisticAttachments,
            },
        ]);
        setInputText('');
        setSuggestions([]);
        setSelectedConversationVideoIds([]);
        setConversationVideoPickerOpen(false);
        setIsStreaming(true);
        setStreamingText('');
        setImageStatusText(isImageRequest ? '正在提交图片生成请求...' : '');

        await new Promise<void>((resolve) => {
            if (typeof window === 'undefined') {
                resolve();
                return;
            }
            window.requestAnimationFrame(() => resolve());
        });

        let activeConversationId = conversationId;
        let shouldRefreshConversation = false;

        try {
            if (!activeConversationId) {
                const created = createConversationPromise ? await createConversationPromise : await createConversation(botId);
                activeConversationId = created.id;
                draftConversationScopeRef.current = created.id;
                await migrateConversationVideoScope(conversationScope, created.id);
                skipHydrationConversationIdRef.current = created.id;
                router.replace(buildRoute(created.botId, { cid: created.id, wf: workflowFlag, name: created.botName }));
            }

            if (!activeConversationId) {
                throw new Error('创建会话失败');
            }

            const messageInputType: 'text' | 'voice' | 'file' | 'image' | 'video' = isImageRequest
                ? 'image'
                : requestAttachments.some((attachment) => attachment.kind === 'video')
                    ? 'video'
                    : hasFiles
                        ? 'file'
                        : 'text';
            const messagePayload = {
                content,
                displayContent: displayText,
                inputType: messageInputType,
                aspectRatio: isImageRequest ? IMAGE_MODE_ASPECT_RATIO : undefined,
                responseModel,
                webSearchMode,
                attachments: requestAttachments,
            };
            const requestBody = shouldSendGeminiVideoDirect
                ? (() => {
                    const formData = new FormData();
                    formData.append('payload', JSON.stringify(messagePayload));
                    finalAttachments
                        .filter((attachment) => attachment.kind === 'video' && !attachment.remoteVideoUrl && !attachment.tempVideoToken)
                        .forEach((attachment) => {
                            formData.append('videoFiles', attachment.file, attachment.name);
                        });
                    return formData;
                })()
                : messagePayload;
            const response = await api.sendConversationMessage(activeConversationId, requestBody);
            const responseContentType = response.headers.get('content-type') || '';

            if (!response.ok) {
                const payload = response.headers.get('content-type')?.includes('application/json')
                    ? await response.json()
                    : await response.text();
                const message = typeof payload === 'string'
                    ? payload
                    : payload?.message || payload?.error || '发送失败';
                throw new Error(message);
            }

            if (responseContentType.includes('application/json')) {
                const payload = await response.json() as ConversationMessageResponsePayload;
                const payloadSuggestions = Array.isArray(payload.data?.suggestions)
                    ? payload.data.suggestions.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
                    : [];
                const finalText = typeof payload.data?.content === 'string'
                    ? stripSuggestionBlock(payload.data.content).trim()
                    : '';

                if (payloadSuggestions.length > 0) {
                    setSuggestions(payloadSuggestions);
                }

                if (finalText) {
                    const assistantTimestamp = Date.now();
                    setMessages((current) => [
                        ...current,
                        { id: `assistant-${assistantTimestamp}`, role: 'assistant', content: finalText, timestamp: assistantTimestamp },
                    ]);
                }

                shouldRefreshConversation = true;
                return;
            }

            if (responseContentType.includes('text/html')) {
                throw new Error(await response.text());
            }

            const reader = response.body?.getReader();
            if (!reader) throw new Error('响应流不可用');

            const decoder = new TextDecoder();
            let fullText = '';
            let imageJobId: string | null = null;
            pendingStreamingTextRef.current = '';
            let pending = '';

            const appendAssistantImageMessage = (image: unknown) => {
                if (typeof image !== 'object' || image === null) {
                    return;
                }

                const imagePayload = image as {
                    content?: unknown;
                    imageUrls?: unknown;
                    imagePrompt?: unknown;
                    aspectRatio?: unknown;
                };
                const assistantImageTimestamp = Date.now();
                setMessages((current) => [
                    ...current,
                    {
                        id: `assistant-image-${assistantImageTimestamp}`,
                        role: 'assistant',
                        timestamp: assistantImageTimestamp,
                        content: typeof imagePayload.content === 'string' ? imagePayload.content : '已生成图片。',
                        kind: 'image',
                        imageUrls: Array.isArray(imagePayload.imageUrls) ? imagePayload.imageUrls.filter((item): item is string => typeof item === 'string') : [],
                        imagePrompt: typeof imagePayload.imagePrompt === 'string' ? imagePayload.imagePrompt : undefined,
                        aspectRatio: typeof imagePayload.aspectRatio === 'string' ? imagePayload.aspectRatio : undefined,
                    },
                ]);
                setImageStatusText('');
            };

            const applyChatStreamProjection = (projection: ChatStreamProjection | null) => {
                if (!projection) {
                    return;
                }

                if (projection.channel === 'messages') {
                    if (projection.kind !== 'delta' || !projection.content) {
                        return;
                    }

                    fullText += projection.content;
                    pendingStreamingTextRef.current += projection.content;
                    if (typeof window === 'undefined') {
                        flushStreamingText();
                    } else {
                        scheduleStreamingTextFlush();
                    }
                    return;
                }

                if (projection.channel === 'suggestions') {
                    setSuggestions(projection.suggestions);
                    return;
                }

                if (projection.channel === 'status') {
                    setImageStatusText(projection.status);
                    return;
                }

                if (projection.channel === 'image_job') {
                    imageJobId = projection.jobId;
                    if (projection.message) {
                        setImageStatusText(projection.message);
                    }
                    return;
                }

                if (projection.channel === 'image') {
                    appendAssistantImageMessage(projection.image);
                    return;
                }

                if (projection.channel === 'error') {
                    throw new Error(projection.error);
                }
            };

            while (true) {
                const { done, value } = await reader.read();
                pending += decoder.decode(value || new Uint8Array(), { stream: !done });

                const lines = pending.split('\n');
                pending = lines.pop() || '';

                for (const line of lines) {
                    try {
                        const parsedEvent = parseChatStreamSseLine(line);
                        applyChatStreamProjection(normalizeChatStreamEvent(parsedEvent));
                    } catch (error) {
                        if (error instanceof SyntaxError) continue;
                        throw error;
                    }
                }

                if (done) break;
            }

            try {
                const parsedEvent = parseChatStreamSseLine(pending);
                applyChatStreamProjection(normalizeChatStreamEvent(parsedEvent));
            } catch (error) {
                if (!(error instanceof SyntaxError)) {
                    throw error;
                }
            }

            const finalText = stripSuggestionBlock(fullText).trim();
            if (finalText) {
                pendingStreamingTextRef.current = finalText;
                const assistantTimestamp = Date.now();
                setMessages((current) => [
                    ...current,
                    { id: `assistant-${assistantTimestamp}`, role: 'assistant', content: finalText, timestamp: assistantTimestamp },
                ]);
            }

            if (imageJobId) {
                await pollConversationImageJob(activeConversationId, imageJobId);
            }

            shouldRefreshConversation = true;
        } catch (error) {
            const message = error instanceof Error ? error.message : '发送失败';
            setMessages((current) => [
                ...current,
                { id: `err-${Date.now()}`, role: 'assistant', content: `出错了：${message}`, timestamp: Date.now() },
            ]);
        } finally {
            if (typeof window !== 'undefined' && streamingFlushTimerRef.current !== null) {
                window.clearTimeout(streamingFlushTimerRef.current);
            }
            streamingFlushTimerRef.current = null;
            pendingStreamingTextRef.current = '';
            setIsStreaming(false);
            setStreamingText('');
            setImageStatusText('');

            if (shouldRefreshConversation && activeConversationId) {
                void refreshConversation(activeConversationId, { syncMessages: false })
                    .then(() => refreshConversationVideos())
                    .catch((error) => {
                        console.error('[Chat] refresh conversation failed', error);
                    });
            } else {
                void refreshConversationVideos();
            }
        }
    }, [
        attachedFiles,
        botId,
        clearAttachments,
        conversationId,
        conversationVideos,
        createConversation,
        ensureConversationScope,
        flushStreamingText,
        imageModeEnabled,
        isStreaming,
        isUploading,
        isVideoBreakdownBot,
        pollConversationImageJob,
        refreshConversation,
        refreshConversationVideos,
        responseModel,
        router,
        scheduleStreamingTextFlush,
        selectedConversationVideoIds,
        webSearchMode,
        wfState,
        workflowFlag,
    ]);

    useEffect(() => {
        if (!launcherDraft && !launchDraftId) {
            launcherDraftKeyRef.current = null;
            return;
        }
        if (conversationId || isLoadingConversation || isStreaming) return;
        if (isHydratingLaunchDraft) return;
        if (requestedResponseModel && responseModel !== requestedResponseModel) return;
        if (requestedWebSearchMode && webSearchMode !== requestedWebSearchMode) return;

        const draftKey = `${botId}:${responseModel}:${webSearchMode}:${launchDraftId}:${launcherDraft}`;
        if (launcherDraftKeyRef.current === draftKey) return;

        launcherDraftKeyRef.current = draftKey;
        void sendMessage(launcherDraft);
    }, [
        launchDraftId,
        botId,
        conversationId,
        isHydratingLaunchDraft,
        isLoadingConversation,
        isStreaming,
        launcherDraft,
        requestedResponseModel,
        requestedWebSearchMode,
        responseModel,
        sendMessage,
        webSearchMode,
    ]);

    const startNewConversation = () => {
        launcherDraftKeyRef.current = null;
        draftConversationScopeRef.current = null;
        clearAttachments();
        setMessages([{ id: 'welcome', role: 'assistant', content: fallbackWelcome, timestamp: Date.now() }]);
        setInputText('');
        setSuggestions([]);
        setConversationVideos([]);
        setSelectedConversationVideoIds([]);
        setConversationVideoPickerOpen(false);
        setVideoResolutionNotice(null);
        setStreamingText('');
        setIsStreaming(false);
        setSidebarOpen(false);
        router.push(buildRoute(botId, { wf: workflowFlag, name: urlName }));
    };

    const formatHistoryTime = (timestamp: number) => {
        const date = new Date(timestamp);
        const now = new Date();
        if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        return `${date.getMonth() + 1}/${date.getDate()} ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
    };

    const addLocalFiles = useCallback((incomingFiles: File[], sourceLabel: string) => {
        if (!incomingFiles.length) return;

        if (imageModeEnabled) {
            alert('绘图模式下暂不支持上传文件，请先关闭绘图模式。');
            return;
        }

        setVideoResolutionNotice(null);

        try {
            if (attachedFiles.length >= MAX_ATTACHMENTS) {
                throw new Error(`一次最多上传 ${MAX_ATTACHMENTS} 个文件`);
            }

            const normalizedFiles = incomingFiles
                .map(normalizeDroppedOrPastedFile)
                .filter(isAcceptedAttachmentFile);

            if (normalizedFiles.length === 0) {
                throw new Error('不支持的文件格式，请上传 PDF、Word、TXT、Markdown、CSV、图片或视频文件。');
            }

            const availableSlots = MAX_ATTACHMENTS - attachedFiles.length;
            const nextFiles: AttachedFile[] = normalizedFiles
                .slice(0, availableSlots)
                .map(createAttachedFileFromLocalFile);

            setAttachedFiles((current) => [...current, ...nextFiles]);

            if (normalizedFiles.length > availableSlots) {
                alert(`一次最多上传 ${MAX_ATTACHMENTS} 个文件，其余文件已忽略`);
            } else if (normalizedFiles.length < incomingFiles.length) {
                alert(`${sourceLabel}中有不支持的文件格式，已自动忽略。`);
            }
        } catch (error) {
            alert(error instanceof Error ? error.message : '文件上传失败');
        }
    }, [attachedFiles.length, imageModeEnabled]);

    const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.target.files || []);
        if (!files.length) return;
        event.target.value = '';
        addLocalFiles(files, '选择的文件');
    };

    const handleAttachmentPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
        const files = Array.from(event.clipboardData.files || []);
        if (!files.length) return;

        event.preventDefault();
        addLocalFiles(files, '剪贴板');
    };

    const handleAttachmentDragOver = (event: React.DragEvent<HTMLDivElement>) => {
        if (!event.dataTransfer.types.includes('Files')) return;

        event.preventDefault();
        event.dataTransfer.dropEffect = imageModeEnabled ? 'none' : 'copy';
        setIsAttachmentDragActive(!imageModeEnabled);
    };

    const handleAttachmentDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
        const nextTarget = event.relatedTarget as Node | null;
        if (nextTarget && event.currentTarget.contains(nextTarget)) {
            return;
        }

        setIsAttachmentDragActive(false);
    };

    const handleAttachmentDrop = (event: React.DragEvent<HTMLDivElement>) => {
        if (!event.dataTransfer.types.includes('Files')) return;

        event.preventDefault();
        setIsAttachmentDragActive(false);
        addLocalFiles(Array.from(event.dataTransfer.files || []), '拖拽的文件');
    };

    const toggleVoice = async () => {
        if (isRecording) {
            setIsRecording(false);
            const recorder = recorderRef.current;
            recorderRef.current = null;
            if (!recorder) return;
            try {
                const audioBlob = await recorder.stop();
                if (audioBlob.size < 1000) throw new Error('录音时间太短，请重试');
                setIsTranscribing(true);
                const formData = new FormData();
                formData.append('audio', audioBlob, 'recording.wav');
                const response = await fetch('/api/voice', { method: 'POST', body: formData });
                const data = await response.json();
                if (data.text) setInputText((current) => current + data.text);
                else throw new Error(data.error || '语音识别失败');
            } catch (error) {
                alert(error instanceof Error ? error.message : '语音识别失败');
            } finally {
                setIsTranscribing(false);
            }
            return;
        }

        try {
            recorderRef.current = await startPcm16kMonoRecorder();
            setIsRecording(true);
        } catch (error) {
            alert(error instanceof Error ? error.message : '无法访问麦克风');
        }
    };

    const generateReport = async () => {
        if (messages.length < 3) {
            alert('对话记录太少，至少需要一轮完整对话才能生成报告');
            return;
        }

        setIsGeneratingReport(true);
        try {
            const response = await fetch('/api/report', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ botId, botName, messages }),
            });
            const data = await response.json();
            if (data.error) throw new Error(data.error);
            const payload = { ...data, chatHistory: messages };
            localStorage.setItem('__report_data__', JSON.stringify(payload));
            if (conversationId) localStorage.setItem(`report-${conversationId}`, JSON.stringify(payload));
            window.open('/report', '_blank');
        } catch (error) {
            alert(error instanceof Error ? error.message : '报告生成失败');
        } finally {
            setIsGeneratingReport(false);
        }
    };

    const assistantMessages = useMemo(
        () => messages.filter((message) => message.role === 'assistant' && message.id !== 'welcome' && message.kind !== 'image'),
        [messages],
    );
    const showLoadingBubble = isLoadingConversation && !isStreaming && messages.length <= 1;
    const showStreamingBubble = isStreaming;
    const showConversationVideoLibrary = canUseVideoBreakdownAttachments;

    const togglePinMsg = useCallback((id: string) => setSelectedMsgIds((current) => {
        const next = new Set(current);
        if (next.has(id)) {
            next.delete(id);
        } else {
            next.add(id);
        }
        return next;
    }), []);

    const handleNextStep = () => {
        if (!wfState) return;
        const output = messages
            .filter((message) => selectedMsgIds.has(message.id))
            .map((message) => message.content)
            .join('\n\n---\n\n');
        const stepOutputs = [...wfState.stepOutputs];
        stepOutputs[wfState.currentStep] = output;
        const nextStep = wfState.currentStep + 1;
        sessionStorage.setItem('wf_state', JSON.stringify({ ...wfState, stepOutputs, currentStep: nextStep }));
        setSelectedMsgIds(new Set());
        if (nextStep >= wfState.steps.length) {
            alert('工作流已完成');
            router.push('/');
            return;
        }
        router.push(`/chat/${wfState.steps[nextStep].botId}?wf=1`);
    };

    const handleBackStep = () => {
        if (!wfState || wfState.currentStep <= 0) return;
        const prevStep = wfState.currentStep - 1;
        sessionStorage.setItem('wf_state', JSON.stringify({ ...wfState, currentStep: prevStep }));
        setSelectedMsgIds(new Set());
        router.push(`/chat/${wfState.steps[prevStep].botId}?wf=1`);
    };

    const openConversation = (conversation: Conversation) => {
        setSidebarOpen(false);
        router.push(buildRoute(conversation.botId, { cid: conversation.id, wf: workflowFlag, name: conversation.botName }));
    };
    return (
        <div className={styles.layout}>
            <aside className={`${styles.chatSidebar} ${sidebarOpen ? styles.chatSidebarOpen : ''}`}>
                <div className={styles.chatSidebarHeader}>
                    <div style={{ display: 'flex', width: '100%' }}>
                        <button
                            onClick={() => setSidebarTab('history')}
                            style={{
                                flex: 1,
                                padding: '8px 0',
                                border: 'none',
                                cursor: 'pointer',
                                fontSize: 13,
                                fontWeight: 600,
                                background: sidebarTab === 'history' ? 'var(--bg-surface, #fff)' : 'transparent',
                                color: sidebarTab === 'history' ? 'var(--text-primary, #0f172a)' : 'var(--text-tertiary, #94a3b8)',
                                borderBottom: sidebarTab === 'history' ? '2px solid #2563eb' : '2px solid transparent',
                            }}
                        >
                            <MessageSquare size={14} style={{ verticalAlign: -2, marginRight: 4 }} />
                            聊天记录
                        </button>
                        <button
                            onClick={() => setSidebarTab('favorites')}
                            style={{
                                flex: 1,
                                padding: '8px 0',
                                border: 'none',
                                cursor: 'pointer',
                                fontSize: 13,
                                fontWeight: 600,
                                background: sidebarTab === 'favorites' ? 'var(--bg-surface, #fff)' : 'transparent',
                                color: sidebarTab === 'favorites' ? '#eab308' : 'var(--text-tertiary, #94a3b8)',
                                borderBottom: sidebarTab === 'favorites' ? '2px solid #eab308' : '2px solid transparent',
                            }}
                        >
                            <Star size={14} style={{ verticalAlign: -2, marginRight: 4 }} />
                            收藏
                        </button>
                    </div>
                </div>
                <div className={styles.chatSidebarList}>
                    {(sidebarTab === 'history' ? botConversations : botFavorites).length === 0 ? (
                        <div className={styles.chatSidebarEmpty}>
                            {sidebarTab === 'history' ? '暂无对话记录' : '暂无收藏'}
                        </div>
                    ) : (
                        (sidebarTab === 'history' ? botConversations : botFavorites).map((conversation) => (
                            <div
                                key={conversation.id}
                                className={`${styles.chatSidebarItem} ${conversation.id === conversationId ? styles.chatSidebarItemActive : ''}`}
                                onClick={() => openConversation(conversation)}
                            >
                                <p className={styles.chatSidebarPreview}>
                                    {conversation.messages[conversation.messages.length - 1]?.content.slice(0, 30) || conversation.title || '新对话'}
                                </p>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
                                    <span className={styles.chatSidebarTime}>{formatHistoryTime(conversation.updatedAt)}</span>
                                    <div style={{ display: 'flex', gap: 6 }}>
                                        {sidebarTab === 'history' && (
                                            <button
                                                className={styles.chatSidebarAction}
                                                style={{ color: conversation.isFavorite ? '#eab308' : undefined }}
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    void toggleFavorite(conversation.id);
                                                }}
                                            >
                                                <Star size={14} fill={conversation.isFavorite ? '#eab308' : 'none'} />
                                            </button>
                                        )}
                                        {sidebarTab === 'history' && reportConversationIds.has(conversation.id) && (
                                            <button
                                                className={styles.chatSidebarAction}
                                                style={{ color: '#3b82f6' }}
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    const saved = localStorage.getItem(`report-${conversation.id}`);
                                                    if (saved) {
                                                        localStorage.setItem('__report_data__', saved);
                                                        window.open('/report', '_blank');
                                                    }
                                                }}
                                            >
                                                <BarChart3 size={14} />
                                            </button>
                                        )}
                                        <button
                                            className={styles.chatSidebarAction}
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                if (sidebarTab === 'favorites') {
                                                    void removeFavorite(conversation.id);
                                                    return;
                                                }

                                                void deleteConversation(conversation.id);
                                                if (conversation.id === conversationId) {
                                                    startNewConversation();
                                                }
                                            }}
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </aside>

            <header className={styles.header}>
                <div className={styles.headerLeft}>
                    <button onClick={() => router.push('/')} className={styles.backBtn}>
                        <ArrowLeft size={16} />
                        返回
                    </button>
                    <button onClick={startNewConversation} className={styles.newChatBtn}>
                        <Plus size={16} />
                        新对话
                    </button>
                </div>
                <div className={styles.headerRight}>
                    {isAdmin && (
                        <button onClick={() => setAdminPanelOpen(true)} className={styles.historyBtn} title="管理员设置">
                            <Settings size={14} />
                            管理
                        </button>
                    )}
                    <button onClick={generateReport} className={styles.historyBtn} disabled={isGeneratingReport || isStreaming}>
                        {isGeneratingReport ? (
                            <>
                                <Sparkles size={14} />
                                生成中...
                            </>
                        ) : (
                            <>
                                <FileText size={14} />
                                生成报告
                            </>
                        )}
                    </button>
                    <button onClick={() => setSidebarOpen(!sidebarOpen)} className={styles.historyBtn}>
                        <ClipboardList size={14} />
                        历史记录
                    </button>
                    <div className={styles.botSwitcher}>
                        <h2 className={styles.botName} onClick={() => setBotSwitcherOpen(!botSwitcherOpen)}>
                            {botName} <span className={styles.switchArrow}><ChevronDown size={14} /></span>
                        </h2>
                        {botSwitcherOpen && (
                            <div className={styles.switcherDropdown}>
                                <div className={styles.switcherList}>
                                    {allBots.map((bot) => (
                                        <button
                                            key={bot.id}
                                            className={`${styles.switcherItem} ${bot.id === botId ? styles.switcherItemActive : ''}`}
                                            onClick={() => {
                                                setBotSwitcherOpen(false);
                                                router.push(buildRoute(bot.id, { name: bot.name }));
                                            }}
                                        >
                                            {bot.name}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </header>

            {wfState && (
                <div className={styles.wfProgressBar}>
                    <span className={styles.wfProgressTitle}>工作流：{wfState.workflowName}</span>
                    <div className={styles.wfSteps}>
                        {wfState.steps.map((step, index) => (
                            <span
                                key={`${step.botId}-${index}`}
                                className={`${styles.wfStepDot} ${index === wfState.currentStep ? styles.wfStepCurrent : index < wfState.currentStep ? styles.wfStepDone : ''}`}
                            >
                                <span className={styles.wfStepNum}>{index + 1}</span>
                                <span className={styles.wfStepName}>{step.botName}</span>
                                {index < wfState.steps.length - 1 && <span className={styles.wfStepLine}>→</span>}
                            </span>
                        ))}
                    </div>
                </div>
            )}

            <div ref={messagesContainerRef} className={styles.messagesContainer}>
                <div className={styles.messages}>
                    <MemoizedMessageList
                        renderedMessages={renderedMessages}
                        wfState={wfState}
                        selectedMsgIds={selectedMsgIds}
                        onMessageContentClick={handleMessageContentClick}
                        onTogglePinMessage={togglePinMsg}
                    />
                    <LoadingMessage show={showLoadingBubble} />
                    <StreamingMessage
                        show={showStreamingBubble}
                        streamingText={streamingText}
                        imageModeEnabled={imageModeEnabled}
                        imageStatusText={imageStatusText}
                        onMessageContentClick={handleMessageContentClick}
                    />
                    <div ref={messagesEndRef} className={styles.scrollAnchor} />
                </div>
            </div>

            {suggestions.length > 0 && !isStreaming && !imageModeEnabled && (
                <div className={styles.suggestions}>
                    {suggestions.map((suggestion, index) => (
                        <button
                            key={`${suggestion}-${index}`}
                            className={styles.suggestionBtn}
                            onClick={() => void sendMessage(suggestion)}
                        >
                            {suggestion}
                        </button>
                    ))}
                </div>
            )}

            {wfState && (
                <div className={styles.wfActionBar}>
                    <div className={styles.wfActionLeft}>
                        <button
                            onClick={() => setSelectedMsgIds(
                                selectedMsgIds.size === assistantMessages.length
                                    ? new Set()
                                    : new Set(assistantMessages.map((message) => message.id)),
                            )}
                            className={styles.wfSelectBtn}
                        >
                            {selectedMsgIds.size === assistantMessages.length && assistantMessages.length > 0 ? (
                                <>
                                    <CheckSquare size={14} />
                                    取消全选
                                </>
                            ) : (
                                <>
                                    <Square size={14} />
                                    全选
                                </>
                            )}
                        </button>
                        <span className={styles.wfSelectedCount}>已选 {selectedMsgIds.size} 条</span>
                    </div>
                    <div className={styles.wfActionRight}>
                        {wfState.currentStep > 0 && (
                            <button onClick={handleBackStep} className={styles.wfBackBtn}>
                                <Undo2 size={14} />
                                回退上一步
                            </button>
                        )}
                        <button onClick={handleNextStep} disabled={isStreaming || selectedMsgIds.size === 0} className={styles.wfForwardBtn}>
                            {wfState.currentStep + 1 >= wfState.steps.length ? (
                                <>完成工作流</>
                            ) : (
                                <>
                                    传递到下一步
                                    <ArrowRight size={14} />
                                </>
                            )}
                        </button>
                    </div>
                </div>
            )}

            <div
                className={`${styles.inputBar} ${isAttachmentDragActive ? styles.inputBarDragActive : ''}`}
                onDragOver={handleAttachmentDragOver}
                onDragLeave={handleAttachmentDragLeave}
                onDrop={handleAttachmentDrop}
            >
                {isAttachmentDragActive && (
                    <div className={styles.dropOverlay}>
                        <Paperclip size={22} />
                        <span>松开即可添加图片、视频或文件</span>
                    </div>
                )}
                {attachedFiles.length > 0 && (
                    <div className={styles.attachmentList}>
                        {attachedFiles.map((file, index) => (
                            <div key={`${file.name}-${index}`} className={styles.attachmentBar}>
                                {file.isImage && file.previewUrl ? (
                                    /* eslint-disable-next-line @next/next/no-img-element -- local attachment previews rely on temporary object URLs */
                                    <img src={file.previewUrl} alt={file.name} className={styles.attachThumb} />
                                ) : (
                                    <span className={styles.attachIcon}>
                                        {file.isVideo ? <Video size={18} /> : <FileText size={18} />}
                                    </span>
                                )}
                                <span className={styles.attachName}>{file.name}</span>
                                <button className={styles.attachRemove} onClick={() => removeAttachment(index)}>✕</button>
                            </div>
                        ))}
                    </div>
                )}
                {videoResolutionNotice && (
                    <div className={styles.videoResolutionNotice}>
                        <div>
                            <strong>{videoResolutionNotice.type === 'ambiguous' ? '请先确认目标视频' : '历史视频不可用'}</strong>
                            <p>{videoResolutionNotice.message}</p>
                        </div>
                        {videoResolutionNotice.allowTextFallback && (
                            <button
                                type="button"
                                className={styles.videoResolutionAction}
                                onClick={() => void sendMessage(inputText, { allowTextFallback: true })}
                                disabled={isStreaming || isUploading}
                            >
                                仅按文字继续
                            </button>
                        )}
                    </div>
                )}
                <div className={styles.inputMeta}>
                    <div className={styles.metaControls}>
                        <button
                            type="button"
                            className={`${styles.modeToggle} ${imageModeEnabled ? styles.modeToggleActive : ''}`}
                            onClick={toggleImageMode}
                            disabled={isStreaming || isUploading || isTranscribing}
                        >
                            <ImageIcon size={16} />
                            {imageModeEnabled ? '绘图已开' : '绘图已关'}
                        </button>
                        <div className={styles.modelSwitcher}>
                            <select
                                aria-label="回答模型"
                                className={styles.modelSelect}
                                value={responseModel}
                                onChange={(event) => {
                                    if (isSelectableResponseModel(event.target.value)) {
                                        setResponseModel(event.target.value);
                                    }
                                }}
                                disabled={isStreaming || isUploading || isTranscribing}
                            >
                                {RESPONSE_MODEL_OPTIONS.map((option) => (
                                    <option key={option.value} value={option.value}>
                                        {option.label}
                                    </option>
                                ))}
                            </select>
                            <ChevronDown size={16} className={styles.modelSelectChevron} />
                        </div>
                        <div className={styles.modelSwitcher}>
                            <select
                                aria-label="联网搜索模式"
                                className={styles.modelSelect}
                                value={webSearchMode}
                                onChange={(event) => {
                                    if (isWebSearchMode(event.target.value)) {
                                        setWebSearchMode(event.target.value);
                                    }
                                }}
                                disabled={isStreaming || isUploading || isTranscribing}
                            >
                                {WEB_SEARCH_MODE_OPTIONS.map((option) => (
                                    <option key={option.value} value={option.value}>
                                        {option.label}
                                    </option>
                                ))}
                            </select>
                            <ChevronDown size={16} className={styles.modelSelectChevron} />
                        </div>
                        {showConversationVideoLibrary && (
                            <div ref={conversationVideoPickerRef} className={styles.conversationVideoPicker}>
                                <button
                                    type="button"
                                    className={`${styles.modeToggle} ${conversationVideoPickerOpen ? styles.modeToggleActive : ''}`}
                                    onClick={() => setConversationVideoPickerOpen((current) => !current)}
                                    aria-expanded={conversationVideoPickerOpen}
                                    aria-haspopup="dialog"
                                >
                                    <Video size={16} />
                                    会话视频
                                    {selectedConversationVideoIds.length > 0 && (
                                        <span className={styles.conversationVideoToggleCount}>
                                            {selectedConversationVideoIds.length}
                                        </span>
                                    )}
                                    <ChevronDown size={14} className={styles.conversationVideoToggleChevron} />
                                </button>
                                {conversationVideoPickerOpen && (
                                    <div className={styles.conversationVideoPopover}>
                                        <div className={styles.conversationVideoShelf}>
                                            <div className={styles.conversationVideoShelfHeader}>
                                                <div>
                                                    <strong>本会话视频</strong>
                                                    <span>点击选择历史视频参与本轮分析</span>
                                                </div>
                                                <span className={styles.conversationVideoShelfMeta}>
                                                    {selectedConversationVideoIds.length > 0
                                                        ? `已选 ${selectedConversationVideoIds.length}/${MAX_AUTO_REFERENCED_HISTORY_VIDEOS}`
                                                        : '最多可选 2 个历史视频'}
                                                </span>
                                            </div>
                                            {conversationVideos.length > 0 ? (
                                                <div className={styles.conversationVideoGrid}>
                                                    {conversationVideos.map((video) => {
                                                        const selected = selectedConversationVideoIds.includes(video.clientVideoId);
                                                        const summaryText = (video.transcript || video.extractedText || '').trim();
                                                        const reusable = canReuseConversationVideo(video);
                                                        return (
                                                            <button
                                                                key={video.clientVideoId}
                                                                type="button"
                                                                className={`${styles.conversationVideoCard} ${selected ? styles.conversationVideoCardSelected : ''} ${!reusable ? styles.conversationVideoCardUnavailable : ''}`}
                                                                onClick={() => toggleConversationVideoSelection(video)}
                                                                aria-pressed={selected}
                                                                title={getConversationVideoStateLabel(video)}
                                                            >
                                                                <div className={styles.conversationVideoCardTop}>
                                                                    <span className={styles.conversationVideoBadge}>{video.videoLabel}</span>
                                                                    <span className={styles.conversationVideoState}>
                                                                        {video.isAvailableLocally ? '本机可用' : '需重传'}
                                                                    </span>
                                                                </div>
                                                                <div className={styles.conversationVideoName}>{video.fileName}</div>
                                                                <div className={styles.conversationVideoSummary}>
                                                                    {summaryText || '可作为历史视频参与本轮分析。'}
                                                                </div>
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                            ) : (
                                                <div className={styles.conversationVideoEmpty}>
                                                    <strong>当前会话还没有可复用视频</strong>
                                                    <span>先上传一个视频并完成一次分析，之后这里会一直保留会话视频选择入口。</span>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                    <span className={styles.inputHint}>
                        {isUploading && videoUploadStatusText
                            ? videoUploadStatusText
                            : isStreaming && imageModeEnabled
                            ? (imageStatusText || '正在生成图片，通常需要 10 到 40 秒。')
                            : imageModeEnabled
                            ? '当前输入会直接调用绘图能力，回答模型切换不会影响绘图结果。'
                            : `当前回答模型：${getResponseModelLabel(responseModel)}；${getWebSearchModeLabel(webSearchMode)}。`}
                    </span>
                </div>
                <div className={styles.inputWrapper}>
                    <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        accept=".pdf,.docx,.txt,.md,.csv,.pptx,.jpg,.jpeg,.png,.gif,.webp,.mp4,.mov,.webm,.m4v"
                        onChange={handleFileUpload}
                        style={{ display: 'none' }}
                    />
                    <button
                        className={styles.toolBtn}
                        onClick={() => fileInputRef.current?.click()}
                        disabled={isStreaming || isUploading || imageModeEnabled}
                        title={imageModeEnabled ? '绘图模式下暂不支持上传文件' : '上传文件'}
                    >
                        {isUploading ? '...' : <Paperclip size={18} />}
                    </button>
                    <button
                        className={`${styles.toolBtn} ${isRecording ? styles.recording : ''} ${isTranscribing ? styles.recording : ''}`}
                        onClick={toggleVoice}
                        disabled={isStreaming || isTranscribing || isUploading}
                        title={isTranscribing ? '转录中...' : isRecording ? '停止录音' : '语音输入'}
                    >
                        {isTranscribing ? <Loader2 size={18} className="animate-spin" /> : <Mic size={18} />}
                    </button>
                    <textarea
                        value={inputText}
                        onPaste={handleAttachmentPaste}
                        onChange={(event) => {
                            setInputText(event.target.value);
                            setVideoResolutionNotice(null);
                        }}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter' && !event.shiftKey) {
                                event.preventDefault();
                                void sendMessage(inputText);
                            }
                        }}
                        placeholder={isTranscribing
                            ? '语音转录中，请稍候...'
                            : imageModeEnabled
                                ? '输入想生成的图片描述...'
                                : '输入消息...'}
                        className={styles.textInput}
                        rows={1}
                        disabled={isStreaming || isUploading}
                    />
                    <button
                        onClick={() => void sendMessage(inputText)}
                        className={styles.sendBtn}
                        disabled={(!inputText.trim() && attachedFiles.length === 0 && !(isVideoBreakdownBot && selectedConversationVideoIds.length > 0)) || isStreaming || isTranscribing || isUploading}
                    >
                        {imageModeEnabled ? <ImageIcon size={18} /> : <Send size={18} />}
                    </button>
                </div>
            </div>
            {isAdmin && (
                <AdminBotPanel
                    botId={botId}
                    botKind={adminBotKind}
                    isOpen={adminPanelOpen}
                    onClose={() => setAdminPanelOpen(false)}
                />
            )}
        </div>
    );
}

function formatMessage(text: string, enableTableCopyButton = false): string {
    return formatRichMessage(text, enableTableCopyButton ? {
        enableTableCopyButton: true,
        tableWrapperClassName: styles.copyTableWrap,
        tableCopyButtonClassName: styles.copyTableBtn,
        tableCopyButtonLabel: TABLE_COPY_LABEL,
    } : undefined);
}
