import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as crypto from 'node:crypto';
import { z } from 'zod';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app');
class AppError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const auth = {
    AppError,
    getUserId: async req => { if (!req.headers.get('authorization')) throw new AppError('请登录', 401); return req.headers.get('authorization'); },
    errorResponse: error => Response.json({ error: error.message }, { status: error.status ?? 400 }),
};
const messages = [
    { id: 'm1', role: 'user', content: '只分享这条问题', inputType: 'text', createdAt: new Date('2026-09-15T01:00:00Z'), attachments: [] },
    { id: 'm2', role: 'assistant', content: '不应公开的回复', inputType: 'text', createdAt: new Date('2026-09-15T01:00:01Z'), attachments: [] },
    { id: 'm3', role: 'assistant', content: '<script>alert(1)</script> **回答**', inputType: 'text', createdAt: new Date('2026-09-15T01:00:02Z'), attachments: [{ fileName: '资料.pdf', fileSize: 8, fileType: 'application/pdf', fileUrl: '', parsedText: '私有知识库内容' }] },
];
async function setup() {
    const saved = new Map();
    let conversation = { id: 'conv', userId: 'alice', title: '测试会话', botNameSnapshot: '起芽成长特助', messages };
    const db = {
        conversation: { findFirst: async ({ where, include }) => {
            if (!conversation || where.id !== conversation.id || where.userId !== conversation.userId) return null;
            return { ...conversation, messages: conversation.messages.filter(m => include.messages.where.id.in.includes(m.id) && m.role !== 'system') };
        } },
        $executeRawUnsafe: async () => 0,
        $executeRaw: async (strings, ...values) => { saved.set(values[0], JSON.parse(values[3])); return 1; },
        $queryRaw: async (strings, token) => saved.has(token) ? [{ snapshot: saved.get(token) }] : [],
    };
    const codec = await loadTsModule(path.join(app, 'lib/conversation-message-codec.ts'));
    const attachments = await loadTsModule(path.join(app, 'lib/chat-attachments.ts'));
    const format = await loadTsModule(path.join(app, 'lib/formatMessage.ts'));
    const share = await loadTsModule(path.join(app, 'lib/chat-sharing.ts'), {
        'node:crypto': crypto, zod: { z }, './auth': auth, './prisma': { prisma: db },
        './conversation-message-codec': codec, './chat-attachments': attachments,
        './formatMessage': format,
        './server-conversations': { getConversationBotPayload: c => ({ name: c.botNameSnapshot }) },
    });
    const route = await loadTsModule(path.join(app, 'api/conversations/[id]/shares/route.ts'), {
        '@/app/lib/auth': auth, '@/app/lib/chat-sharing': share,
    });
    const publicRoute = await loadTsModule(path.join(app, 'api/shares/[token]/route.ts'), {
        '@/app/lib/auth': auth, '@/app/lib/chat-sharing': share,
    });
    const post = (ids, owner = 'alice') => route.POST(new Request('https://main.test/api/conversations/conv/shares', {
        method: 'POST', headers: owner ? { authorization: owner } : {}, body: JSON.stringify({ messageIds: ids }),
    }), { params: Promise.resolve({ id: 'conv' }) });
    return { share, post, saved, format, codec, publicRoute, deleteConversation: () => { conversation = null; } };
}

test('sharing accepts only an authenticated owner and valid nonempty selections', async () => {
    const { post, saved } = await setup();
    assert.equal((await post(['m1'], '')).status, 401);
    assert.equal((await post(['m1'], 'bob')).status, 404);
    for (const ids of [[], ['m1', 'm1'], ['m1', 'foreign-message'], ['welcome'], Array(201).fill('m1')]) {
        assert.equal((await post(ids)).status, 400);
    }
    assert.equal(saved.size, 0);
});

test('snapshot contains only selected display data in original order and survives source deletion', async () => {
    const { post, share, saved, deleteConversation, publicRoute, format } = await setup();
    const response = await post(['m3', 'm1']);
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.match(data.path, /^\/share\/[A-Za-z0-9_-]{43}$/);
    const token = data.path.split('/').at(-1);
    const snapshot = await share.getChatShare(token);
    assert.deepEqual(snapshot.messages.map(m => m.role), ['user', 'assistant']);
    assert.equal(snapshot.botName, '起芽成长特助');
    assert.equal(snapshot.messages[1].attachments[0].fileName, '资料.pdf');
    const json = JSON.stringify(snapshot);
    for (const secret of ['测试会话', '不应公开的回复', '私有知识库内容', 'alice', 'parsedText', 'userId', 'conversationId']) assert.ok(!json.includes(secret));
    assert.ok(!format.formatMessage(snapshot.messages[1].content).includes('<script>'));
    deleteConversation();
    const anonymous = await publicRoute.GET(new Request('https://main.test/api/shares/' + token), { params: Promise.resolve({ token }) });
    assert.equal(anonymous.status, 200);
    assert.equal(anonymous.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await anonymous.json()).data, saved.get(token));
    assert.equal(await share.getChatShare('../bad'), null);
    assert.equal(await share.getChatShare('x'.repeat(43)), null);
});

test('public snapshot strips unsafe image URLs and internal suggestion blocks', async () => {
    const { share, codec } = await setup();
    const snapshot = share.buildChatShareSnapshot('测试智能体', [{
        ...messages[0], role: 'assistant', inputType: 'image',
        content: codec.encodeConversationImageMessage({ content: '图片\n```json\n{"suggestions":["不公开"]}\n```', imageUrls: ['javascript:alert(1)', '//evil.test/x', 'blob:private', '/api/generated-images/test.png', 'https://example.test/a.png'] }),
    }]);
    assert.deepEqual(snapshot.messages[0].imageUrls, ['/api/generated-images/test.png', 'https://example.test/a.png']);
    assert.ok(!snapshot.messages[0].content.includes('suggestions'));
});
