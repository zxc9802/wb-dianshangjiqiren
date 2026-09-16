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
    const catalog = await loadTsModule(path.join(app, 'lib/usage-rate-catalog.ts'));
    const pricing = await loadTsModule(path.join(app, 'lib/usage-pricing.ts'), { './usage-rate-catalog': catalog });
    const reportPricing = await loadTsModule(path.join(app, 'lib/usage-report-pricing.ts'), { '@prisma/client': { Prisma } });
    const ledger = await loadTsModule(path.join(app, 'lib/usage-ledger.ts'), { 'node:crypto': crypto, './prisma': { prisma: db }, './usage-values': values, './usage-pricing': pricing });
    const admin = await loadTsModule(path.join(app, 'api/admin/usage/route.ts'), {
        '@prisma/client': { Prisma }, zod: { z }, '@/app/lib/auth': auth,
        '@/app/lib/prisma': { prisma: db }, '@/app/lib/usage-ledger': ledger,
        '@/app/lib/usage-pricing': pricing, '@/app/lib/usage-report-pricing': reportPricing,
    });
    const sso = await loadTsModule(path.join(app, 'api/sso/usage/route.ts'), {
        'node:crypto': crypto, zod: { z }, '@/app/lib/auth': auth, '@/app/lib/prisma': { prisma: db }, '@/app/lib/usage-ledger': ledger,
        '@/app/lib/server-env': { readServerEnv: () => JSON.stringify({ test: secret }) },
    });
    const send = (body, supplied = secret) => sso.POST(new Request('https://main.test/api/sso/usage', { method: 'POST', headers: { 'x-usage-tool': 'test', 'x-usage-secret': supplied }, body: JSON.stringify(body) }));
    const read = (authorization = 'admin-test', extra = '') => {
        const endpoint = new URL(`https://main.test/api/admin/usage?userId=${userId}${extra}`);
        // Inserts can finish in the same millisecond as the exclusive default end.
        if (!endpoint.searchParams.has('end')) endpoint.searchParams.set('end', new Date(Date.now() + 60_000).toISOString());
        const req = new Request(endpoint, { headers: { authorization } });
        req.nextUrl = endpoint;
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
        const bots = [
            { botId: 'bot-a', botName: '同名顾问' },
            { botId: 'bot-b', botName: '同名顾问' },
            { botId: 'bot-a', botName: '已更名顾问' },
        ];
        for (const [index, bot] of bots.entries()) {
            assert.equal((await send({ ...event, ...bot, requestId: `${prefix}-bot-${index}` })).status, 200);
        }
        const attributed = await read().then(r => r.json());
        const botGroups = attributed.groups.filter(g => g.botId);
        assert.equal(botGroups.length, 3, 'same model and same name must not merge different bot identities or name snapshots');
        for (const bot of bots) {
            const group = botGroups.find(g => g.botId === bot.botId && g.botName === bot.botName);
            assert.ok(group);
            assert.equal(group.model, event.model);
            assert.equal(group.calls, 1);
            assert.equal(group.totalTokens, 150);
            assert.equal(group.amount, .002);
        }
        assert.equal(attributed.rows.filter(row => row.data.botId).length, 3);

        const historical = { ...values.emptyUsage(), userId, source: 'sso:kb-chat', provider: 'api.openlux.ai', model: 'gpt-6-astra', status: 'completed', tokenBasis: 'reported', inputTokens: 1000, outputTokens: 100, totalTokens: 1100, cachedInputTokens: 200, cacheWriteTokens: 100, amount: null, costBasis: 'missing' };
        const cases = [
            { data: historical, expected: .00049451 },
            { data: { ...historical, provider: 'openlux' }, expected: .00049451 },
            { data: { ...historical, provider: 'yunwu.ai' }, expected: null },
            { data: { ...historical, amount: .75, currency: 'USD', costBasis: 'actual' }, expected: .75 },
            { data: { ...historical, amount: .65, currency: 'CNY', costBasis: 'estimated' }, expected: .65 },
            { data: { ...historical, status: 'failed' }, expected: null },
            { data: { ...historical, status: 'pending' }, expected: null },
            { data: { ...historical, model: 'claude-opus-4-6' }, expected: null },
            { data: { ...historical, model: 'gpt-image-2', cachedInputTokens: 0, cacheWriteTokens: 0, imageInputTokens: 800 }, expected: .00061182 },
            { data: { ...historical, model: 'gpt-image-2', cachedInputTokens: 0, cacheWriteTokens: 0 }, expected: null },
            { data: { ...historical, model: 'gpt-image-2-c', ...values.emptyUsage(), tokenBasis: 'missing' }, expected: .00882 },
            { data: { ...historical, model: 'unknown-model' }, expected: null },
            { data: { ...historical, ...values.emptyUsage(), tokenBasis: 'missing' }, expected: null },
            { data: { ...historical, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 }, expected: 0 },
        ];
        for (const [index, scenario] of cases.entries()) {
            const data = { ...scenario.data, requestId: `${prefix}-history-${index}` };
            await db.$executeRaw`INSERT INTO ai_usage_events (id, user_id, source, request_id, data) VALUES (${crypto.randomUUID()}, ${userId}, ${data.source}, ${data.requestId}, ${JSON.stringify(data)}::jsonb)`;
        }
        const history = await read('admin-test', '&source=sso:kb-chat').then(r => r.json());
        assert.equal(history.total, cases.length);
        for (const [index, scenario] of cases.entries()) {
            const shown = history.rows.find(row => row.data.requestId === `${prefix}-history-${index}`).data;
            if (scenario.expected === null) assert.equal(shown.amount, null);
            else assert.ok(Math.abs(shown.amount - scenario.expected) < 1e-12, `history ${index}: ${shown.amount}`);
            const priced = await ledger.priceUsage({ ...scenario.data, requestId: 'unit' });
            if (priced.amount == null) assert.equal(shown.amount, null);
            else assert.ok(Math.abs(shown.amount - priced.amount) < 1e-12, `SQL and ingestion pricing must agree for case ${index}`);
            if (scenario.expected != null && scenario.data.amount == null) assert.equal(shown.historicalEstimate, true);
        }
        const stored = await db.$queryRaw`SELECT data FROM ai_usage_events WHERE request_id = ${`${prefix}-history-0`}`;
        assert.equal(stored[0].data.amount, null, 'reading estimates does not rewrite historical rows');
        assert.ok(history.groups.some(group => group.currency === 'CNY' && group.amount === .65));
        const override = { ...catalog.DEFAULT_USAGE_RATES[0], inputPerMillion: 1 };
        assert.equal((await admin.PUT(new Request('https://main.test/api/admin/usage', { method: 'PUT', headers: { authorization: 'admin-test' }, body: JSON.stringify([rate, override]) }))).status, 200);
        const repriced = await read('admin-test', '&source=sso:kb-chat').then(r => r.json());
        const first = repriced.rows.find(row => row.data.requestId === `${prefix}-history-0`).data;
        assert.ok(Math.abs(first.amount - .00093712) < 1e-12);
        assert.equal(repriced.rows.find(row => row.data.requestId === `${prefix}-history-3`).data.amount, .75);
        const unknownImageRate = { ...catalog.DEFAULT_USAGE_RATES.find(r => r.model === 'gpt-image-2'), imageInputPerMillion: null };
        assert.equal((await admin.PUT(new Request('https://main.test/api/admin/usage', { method: 'PUT', headers: { authorization: 'admin-test' }, body: JSON.stringify([rate, unknownImageRate]) }))).status, 200);
        const imageUnknown = await read('admin-test', '&source=sso:kb-chat').then(r => r.json());
        assert.equal(imageUnknown.rows.find(row => row.data.requestId === `${prefix}-history-8`).data.amount, null);
        assert.equal((await ledger.priceUsage({ ...cases[8].data, requestId: 'unit' })).amount, null);
    } finally {
        await db.$executeRaw`DELETE FROM ai_usage_events WHERE user_id = ${userId}`;
        await db.user.deleteMany({ where: { id: userId } });
        if (previousRate) await db.systemSetting.update({ where: { key: 'ai_usage_rates' }, data: { value: previousRate.value } });
        else await db.systemSetting.deleteMany({ where: { key: 'ai_usage_rates' } });
        await db.$disconnect();
    }
});
