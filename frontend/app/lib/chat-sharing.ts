import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './auth';
import { prisma } from './prisma';
import { normalizeAttachmentRecord, stripAttachmentDisplayLabels } from './chat-attachments';
import { decodeConversationMessage } from './conversation-message-codec';
import { stripSuggestionBlock } from './formatMessage';
import { getConversationBotPayload } from './server-conversations';

export interface SharedChatMessage {
    role: 'user' | 'assistant';
    content: string;
    createdAt: string;
    imageUrls: string[];
    attachments: { fileName: string; kind: string; previewUrl?: string; frames: string[] }[];
}

export interface ChatShareSnapshot {
    title: string;
    botName: string;
    createdAt: string;
    messages: SharedChatMessage[];
}

type StoredMessage = {
    role: string; content: string; inputType: string; createdAt: Date;
    attachments: { fileName: string; fileSize: number; fileType: string; fileUrl: string; parsedText: string | null }[];
};

const selectionSchema = z.object({
    messageIds: z.array(z.string().min(1).max(100)).min(1).max(200)
        .refine(ids => new Set(ids).size === ids.length, '不能重复选择消息。'),
}).strict();

let setup: Promise<unknown> | undefined;
async function ensureChatShares() {
    if (!setup) setup = (async () => {
        await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS chat_shares (
            token text PRIMARY KEY, owner_id text NOT NULL, conversation_id text NOT NULL,
            snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
        )`);
        await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS chat_shares_owner_id_idx ON chat_shares(owner_id)');
    })().catch(error => { setup = undefined; throw error; });
    await setup;
}

function displayUrl(value?: string): string | undefined {
    if (!value || /[\\\s\u0000-\u001f]/.test(value)) return undefined;
    if (value.startsWith('/') && !value.startsWith('//')) return value;
    try {
        const url = new URL(value);
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href;
    } catch { /* Temporary and invalid media URLs cannot be shared. */ }
    return undefined;
}

export function buildChatShareSnapshot(botName: string, messages: StoredMessage[]): ChatShareSnapshot {
    return {
        title: `${botName}的聊天记录`, botName, createdAt: new Date().toISOString(),
        messages: messages.map(message => {
            const decoded = decodeConversationMessage(message);
            const attachments = message.attachments.map(normalizeAttachmentRecord);
            return {
                role: message.role as SharedChatMessage['role'],
                content: stripSuggestionBlock(stripAttachmentDisplayLabels(decoded.content, attachments)),
                createdAt: message.createdAt.toISOString(),
                imageUrls: (decoded.imageUrls || []).map(displayUrl).filter((url): url is string => Boolean(url)),
                attachments: attachments.map(attachment => ({
                    fileName: attachment.fileName, kind: attachment.kind,
                    previewUrl: attachment.kind === 'image' ? displayUrl(attachment.previewUrl) : undefined,
                    frames: (attachment.frames || []).map(frame => displayUrl(frame.url)).filter((url): url is string => Boolean(url)),
                })),
            };
        }),
    };
}

export async function createChatShare(userId: string, conversationId: string, input: unknown): Promise<string> {
    const { messageIds } = selectionSchema.parse(input);
    const conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, userId },
        include: {
            bot: true, customBot: true,
            messages: {
                where: { id: { in: messageIds }, role: { in: ['user', 'assistant'] } },
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], include: { attachments: true },
            },
        },
    });
    if (!conversation) throw new AppError('会话不存在。', 404);
    if (conversation.messages.length !== messageIds.length) throw new AppError('所选消息不存在或不属于该会话，请重新选择。', 400);
    const snapshot = buildChatShareSnapshot(getConversationBotPayload(conversation).name, conversation.messages);
    const serialized = JSON.stringify(snapshot);
    if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) throw new AppError('所选聊天内容过多，请减少消息数量。', 413);
    const token = randomBytes(32).toString('base64url');
    await ensureChatShares();
    await prisma.$executeRaw`INSERT INTO chat_shares (token, owner_id, conversation_id, snapshot)
        VALUES (${token}, ${userId}, ${conversationId}, ${serialized}::jsonb)`;
    return `/share/${token}`;
}

export async function getChatShare(token: string): Promise<ChatShareSnapshot | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    await ensureChatShares();
    const rows = await prisma.$queryRaw<{ snapshot: ChatShareSnapshot }[]>`SELECT snapshot FROM chat_shares WHERE token = ${token}`;
    return rows[0]?.snapshot ?? null;
}
