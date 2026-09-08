import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as crypto from 'node:crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { z } from 'zod';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app');

test('PostgreSQL: idempotent SSO ingestion, admin authorization, dates and currency separation', { skip: !process.env.USAGE_TEST_DATABASE_URL }, async () => {
    const url = new URL(process.env.USAGE_TEST_DATABASE_URL);
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname === '/usage_test', 'Only an isolated local usage_test database is allowed');
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.href }) });
    const userId = crypto.randomUUID();
    const prefix = crypto.randomUUID();
    const secret = 'test-only-secret-never-use-in-production';
    const previousRate = await db.systemSetting.findUnique({ where: { key: 'ai_usage_rates' } });
    class AppError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
    const auth = {
        AppError,
        errorResponse: error => Response.json({ error: error.message }, { status: error.status ?? 400 }),
        getAuthUser: async (req, options) => {
            if (!options.requireAdmin || req.headers.get('authorization') !== 'admin-test') throw new AppError('Forbidden', 403);
            return { id: userId, role: 'admin' };
        },
    };
    const values = await loadTsModule(path.join(app, 'lib/usage-values.ts'));
    const ledger = await loadTsModule(path.join(app, 'lib/usage-ledger.ts'), { 'node:crypto': crypto, './prisma': { prisma: db }, './usage-values': values });
    const admin = await loadTsModule(path.join(app, 'api/admin/usage/route.ts'), {
        '@prisma/client': { Prisma }, zod: { z }, '@/app/lib/auth': auth,
        '@/app/lib/prisma': { prisma: db }, '@/app/lib/usage-ledger': ledger,
    });
    const sso = await loadTsModule(path.join(app, 'api/sso/usage/route.ts'), {
        'node:crypto': crypto, zod: { z }, '@/app/lib/auth': auth, '@/app/lib/prisma': { prisma: db }, '@/app/lib/usage-ledger': ledger,
        '@/app/lib/server-env': { readServerEnv: () => JSON.stringify({ test: secret }) },
    });
    const send = (body, supplied = secret) => sso.POST(new Request('https://main.test/api/sso/usage', { method: 'POST', headers: { 'x-usage-tool': 'test', 'x-usage-secret': supplied }, body: JSON.stringify(body) }));
    const read = (authorization = 'admin-test', extra = '') => {
        const req = new Request(`https://main.test/api/admin/usage?userId=${userId}${extra}`, { headers: { authorization } });
        req.nextUrl = new URL(req.url);
        return admin.GET(req);
    };
    try {
        await db.user.create({ data: { id: userId, email: `${prefix}@test.invalid`, passwordHash: 'unused', nickname: '测试员工' } });
        const event = { ...values.emptyUsage(), userId, requestId: prefix, provider: 'provider.test', model: 'model', status: 'completed', tokenBasis: 'reported', inputTokens: 100, outputTokens: 50, totalTokens: 150, amount: .002, currency: 'USD', costBasis: 'actual' };
        assert.equal((await send(event, 'invalid')).status, 401);
        assert.equal((await send({ ...event, totalTokens: 999 })).status, 400);
        assert.equal((await send({ ...event, amount: .1, currency: null })).status, 400);
        const accepted = await Promise.all(Array.from({ length: 8 }, () => send(event).then(r => r.json())));
        assert.equal(accepted.filter(r => r.accepted).length, 1);
        assert.equal((await send({ ...event, amount: 999 }).then(r => r.json())).accepted, false);
        await send({ ...event, requestId: `${prefix}-cny`, amount: .2, currency: 'CNY', costBasis: 'estimated' });
        await send({ ...event, requestId: `${prefix}-missing`, ...values.emptyUsage(), tokenBasis: 'missing', amount: null, currency: null, costBasis: 'missing' });
        assert.equal((await read('member-test')).status, 403);
        const response = await read();
        assert.equal(response.status, 200);
        const data = await response.json();
        assert.equal(data.total, 3);
        assert.equal(data.groups.find(g => g.currency === 'USD').amount, .002);
        assert.equal(data.groups.find(g => g.currency === 'CNY').amount, .2);
        assert.equal(data.groups.find(g => g.tokenBasis === 'missing').totalTokens, null);
        assert.equal((await read('admin-test', '&source=main').then(r => r.json())).total, 0);
        assert.equal((await read('admin-test', '&start=2020-01-01&end=2020-01-02').then(r => r.json())).total, 0);
        await ledger.recordUsage({ ...event, source: 'main', requestId: `${prefix}-pending`, status: 'pending' });
        await ledger.recordUsage({ ...event, source: 'main', requestId: `${prefix}-pending` });
        await ledger.recordUsage({ ...event, source: 'main', requestId: `${prefix}-pending`, amount: 888 });
        const completed = await db.$queryRaw`SELECT data FROM ai_usage_events WHERE request_id = ${`${prefix}-pending`}`;
        assert.equal(completed[0].data.amount, .002);
        const rate = { provider: 'provider.test', model: 'model', currency: 'USD', inputPerMillion: 2, outputPerMillion: 8, cachedPerMillion: .2, cacheWritePerMillion: 2 };
        const saved = await admin.PUT(new Request('https://main.test/api/admin/usage', { method: 'PUT', headers: { authorization: 'admin-test' }, body: JSON.stringify([rate]) }));
        assert.equal(saved.status, 200);
        await send({ ...event, requestId: `${prefix}-priced`, amount: undefined, currency: undefined, costBasis: undefined });
        const priced = await db.$queryRaw`SELECT data FROM ai_usage_events WHERE request_id = ${`${prefix}-priced`}`;
        assert.equal(priced[0].data.amount, .0006);
        assert.equal(priced[0].data.costBasis, 'estimated');
        assert.deepEqual(priced[0].data.rate, rate);
    } finally {
        await db.$executeRaw`DELETE FROM ai_usage_events WHERE user_id = ${userId}`;
        await db.user.deleteMany({ where: { id: userId } });
        if (previousRate) await db.systemSetting.update({ where: { key: 'ai_usage_rates' }, data: { value: previousRate.value } });
        else await db.systemSetting.deleteMany({ where: { key: 'ai_usage_rates' } });
        await db.$disconnect();
    }
});
