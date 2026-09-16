import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app');

test('PostgreSQL and real JWT auth: owner-only creation, anonymous immutable selected snapshot', { skip: !process.env.CHAT_SHARING_TEST_DATABASE_URL }, async () => {
    const url = new URL(process.env.CHAT_SHARING_TEST_DATABASE_URL);
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname === '/chat_sharing_test', 'Only an isolated local chat_sharing_test database is allowed');
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.href }) });
    const prefix = crypto.randomUUID();
    const alice = `${prefix}-alice`, bob = `${prefix}-bob`, cid = `${prefix}-conversation`;
    const secret = crypto.randomBytes(32).toString('hex');
    const auth = await loadTsModule(path.join(app, 'lib/auth.ts'), {
        bcryptjs: bcrypt, jsonwebtoken: jwt, './prisma': { prisma },
        './server-env': { readServerEnv: key => key === 'JWT_SECRET' ? secret : undefined, readRequiredServerEnv: () => secret },
    });
    const codec = await loadTsModule(path.join(app, 'lib/conversation-message-codec.ts'));
    const attachments = await loadTsModule(path.join(app, 'lib/chat-attachments.ts'));
    const format = await loadTsModule(path.join(app, 'lib/formatMessage.ts'));
    const sharing = await loadTsModule(path.join(app, 'lib/chat-sharing.ts'), {
        'node:crypto': crypto, zod: { z }, './auth': auth, './prisma': { prisma },
        './conversation-message-codec': codec, './chat-attachments': attachments, './formatMessage': format,
        './server-conversations': { getConversationBotPayload: c => ({ name: c.botNameSnapshot }) },
    });
    const routes = { '@/app/lib/auth': auth, '@/app/lib/chat-sharing': sharing };
    const createRoute = await loadTsModule(path.join(app, 'api/conversations/[id]/shares/route.ts'), routes);
    const publicRoute = await loadTsModule(path.join(app, 'api/shares/[token]/route.ts'), routes);
    const request = (ids, token) => createRoute.POST(new Request('https://test.invalid/api/conversations/' + cid + '/shares', {
        method: 'POST', headers: token ? { authorization: 'Bearer ' + token } : {}, body: JSON.stringify({ messageIds: ids }),
    }), { params: Promise.resolve({ id: cid }) });
    try {
        for (const id of [alice, bob]) await prisma.user.create({ data: { id, email: id + '@test.invalid', nickname: id, passwordHash: 'unused', role: 'admin' } });
        await prisma.conversation.create({ data: {
            id: cid, userId: alice, title: 'UNSELECTED PRIVATE TITLE', botNameSnapshot: '测试智能体',
            messages: { create: ['first', 'hidden', 'last'].map((value, i) => ({ id: `${prefix}-${value}`, role: i === 0 ? 'user' : 'assistant', content: value, createdAt: new Date(1000 + i * 1000) })) },
        } });
        const ids = [`${prefix}-last`, `${prefix}-first`];
        assert.equal((await request(ids)).status, 401);
        assert.equal((await request(ids, 'invalid-jwt')).status, 401);
        assert.equal((await request(ids, auth.signToken(bob))).status, 404);
        assert.equal((await request([...ids, 'foreign'], auth.signToken(alice))).status, 400);
        const response = await request(ids, auth.signToken(alice));
        assert.equal(response.status, 200);
        const token = (await response.json()).data.path.split('/').at(-1);
        const snapshot = await sharing.getChatShare(token);
        assert.deepEqual(snapshot.messages.map(m => m.content), ['first', 'last']);
        assert.equal(snapshot.title, '测试智能体的聊天记录');
        await prisma.message.update({ where: { id: `${prefix}-first` }, data: { content: 'later edit' } });
        await prisma.conversation.delete({ where: { id: cid } });
        const anonymous = await publicRoute.GET(new Request('https://test.invalid/api/shares/' + token), { params: Promise.resolve({ token }) });
        assert.equal(anonymous.status, 200);
        assert.deepEqual((await anonymous.json()).data, snapshot);
        const stored = await prisma.$queryRaw`SELECT snapshot FROM chat_shares WHERE token = ${token}`;
        assert.deepEqual(stored[0].snapshot, snapshot);
    } finally {
        await prisma.$executeRaw`DELETE FROM chat_shares WHERE owner_id IN (${alice}, ${bob})`;
        await prisma.conversation.deleteMany({ where: { userId: { in: [alice, bob] } } });
        await prisma.user.deleteMany({ where: { id: { in: [alice, bob] } } });
        await prisma.$disconnect();
    }
});
