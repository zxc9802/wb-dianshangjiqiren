import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app');
const values = await loadTsModule(path.join(app, 'lib/usage-values.ts'));
const auth = {
    getAuthUser: async req => ({ id: req.headers.get('employee') || 'alice', role: 'admin' }),
    errorResponse: error => Response.json({ error: error.message }, { status: error.status || 400 }),
    AppError: class extends Error { constructor(message, status = 400) { super(message); this.status = status; } },
};

for (const service of ['frontend', 'backend']) {
    test(`${service}: concurrent requests keep their resolved bot on every provider event`, async () => {
        const lib = service === 'frontend' ? path.join(app, 'lib') : path.join(app, '../../backend/src/services');
        const context = await loadTsModule(path.join(lib, 'usage-context.ts'), {
            'node:async_hooks': { AsyncLocalStorage }, './auth': auth,
        });
        assert.equal(typeof context.setUsageBot, 'function');
        const records = [];
        const { usageFetch } = await loadTsModule(path.join(lib, 'usage-fetch.ts'), {
            'node:crypto': crypto, './usage-values': values, './usage-context': context,
            './usage-ledger': { recordUsage: async event => { records.push(structuredClone(event)); } },
        });
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () => Response.json({ usage: { input_tokens: 2, output_tokens: 3 } });
        try {
            await Promise.all(['KPI教练', '自定义顾问'].map((botName, i) => context.usageContext.run({ userId: 'alice', source: 'main' }, async () => {
                await new Promise(resolve => setTimeout(resolve, i ? 1 : 5));
                context.setUsageBot(`bot-${i}`, botName);
                await new Promise(resolve => setTimeout(resolve, i ? 5 : 1));
                await usageFetch('https://provider.test/v1/responses', { body: JSON.stringify({ model: 'actual-model' }) });
            })));
            assert.equal(records.length, 4);
            for (const event of records) {
                assert.equal(event.source, 'main');
                assert.equal(event.userId, 'alice');
                assert.equal(event.model, 'actual-model');
                assert.equal(event.botName, event.botId === 'bot-0' ? 'KPI教练' : '自定义顾问');
            }
            assert.equal(context.usageContext.getStore(), undefined);
        } finally { globalThis.fetch = originalFetch; }
    });
}

test('source labels use recorded names and identify missing historical attribution', async () => {
    const { usageSourceLabel, usageChannelLabel } = await loadTsModule(path.join(app, 'lib/usage-labels.ts'));
    assert.equal(usageSourceLabel({ source: 'main', botName: '我的客服', model: 'gpt-5.4' }), '我的客服');
    assert.equal(usageSourceLabel({ source: 'main', botId: '36' }), '主站 · 未记录智能体');
    assert.equal(usageSourceLabel({ source: 'main', botName: '  ' }), '主站 · 未记录智能体');
    assert.equal(usageChannelLabel('sso:kb-chat'), 'SSO · 起芽知识库机器人');
    assert.equal(usageChannelLabel('sso:qyzsk'), 'SSO · 起芽知识库机器人');
    assert.equal(usageSourceLabel({ source: 'sso:kb-chat', botName: '采购知识顾问' }), '采购知识顾问');
    assert.equal(usageSourceLabel({ source: 'sso:kb-chat' }), 'SSO · 起芽知识库机器人 · 未记录智能体');
    assert.equal(usageSourceLabel({ source: 'sso:unknown' }), 'SSO · unknown · 未记录智能体');
});

test('admin SQL returns and groups bot identity separately from the model', async () => {
    const queries = [];
    const prisma = {
        $queryRaw: async query => {
            queries.push(query);
            return query.sql?.includes('AS total') ? [{ total: 0 }] : [];
        },
        user: { findMany: async () => [] },
    };
    const { GET } = await loadTsModule(path.join(app, 'api/admin/usage/route.ts'), {
        '@prisma/client': { Prisma }, zod: { z }, '@/app/lib/auth': auth,
        '@/app/lib/prisma': { prisma }, '@/app/lib/usage-ledger': { ensureUsageLedger: async () => {}, getUsageRates: async () => [] },
        '@/app/lib/usage-pricing': { normalizeUsageProvider: value => value },
        '@/app/lib/usage-report-pricing': await loadTsModule(path.join(app, 'lib/usage-report-pricing.ts'), { '@prisma/client': { Prisma } }),
    });
    const response = await GET({ nextUrl: new URL('https://main.test/api/admin/usage'), headers: new Headers() });
    assert.equal(response.status, 200);
    const summary = queries.find(query => query.sql?.includes('GROUP BY')).sql;
    assert.match(summary, /e\.data->>'botId' AS "botId"/);
    assert.match(summary, /e\.data->>'botName' AS "botName"/);
    const grouping = summary.slice(summary.indexOf('GROUP BY'), summary.indexOf('ORDER BY'));
    assert.ok(grouping.includes("e.data->>'botId'"));
    assert.ok(grouping.includes("e.data->>'botName'"));
    assert.ok(grouping.includes("e.data->>'model'"));
});

test('authenticated SSO accepts validated optional bot identity without changing source', async () => {
    const records = [];
    const secret = 'test-only-secret-never-use-in-production';
    const { POST } = await loadTsModule(path.join(app, 'api/sso/usage/route.ts'), {
        'node:crypto': crypto, zod: { z }, '@/app/lib/auth': auth,
        '@/app/lib/prisma': { prisma: { user: { findUnique: async () => ({ id: 'alice' }) } } },
        '@/app/lib/server-env': { readServerEnv: () => JSON.stringify({ 'kb-chat': secret }) },
        '@/app/lib/usage-ledger': { recordUsage: async event => { records.push(event); return true; } },
    });
    const event = { ...values.emptyUsage(), userId: 'alice', requestId: 'request', model: 'actual-model', provider: 'provider.test', status: 'completed', tokenBasis: 'missing' };
    const send = body => POST(new Request('https://main.test/api/sso/usage', {
        method: 'POST', headers: { 'x-usage-tool': 'kb-chat', 'x-usage-secret': secret }, body: JSON.stringify(body),
    }));
    assert.equal((await send({ ...event, botId: ' purchasing ', botName: ' 采购顾问 ' })).status, 200);
    assert.equal(records[0].source, 'sso:kb-chat');
    assert.equal(records[0].botId, 'purchasing');
    assert.equal(records[0].botName, '采购顾问');
    assert.equal((await send(event)).status, 200);
    assert.equal((await send({ ...event, botName: ' ' })).status, 400);
    assert.equal((await send({ ...event, botId: 'x'.repeat(201) })).status, 400);
    assert.equal((await send({ ...event, botName: 'x'.repeat(201) })).status, 400);
    assert.equal((await send({ ...event, source: 'main' })).status, 400);
});

async function routeStubs(routePath) {
    const source = ts.createSourceFile(routePath, await readFile(routePath, 'utf8'), ts.ScriptTarget.Latest);
    return Object.fromEntries(source.statements.filter(ts.isImportDeclaration).map(declaration => [
        declaration.moduleSpecifier.text,
        new Proxy({}, { get: (_, key) => key === '__esModule' ? true : () => { throw new Error(`Unexpected call: ${declaration.moduleSpecifier.text}.${String(key)}`); } }),
    ]));
}

test('direct chat attributes database and builtin bot names and ignores client-supplied names', async () => {
    const routePath = path.join(app, 'api/chat/route.ts');
    const context = await loadTsModule(path.join(app, 'lib/usage-context.ts'), { 'node:async_hooks': { AsyncLocalStorage }, './auth': auth });
    const models = await loadTsModule(path.join(app, 'lib/chat-models.ts'));
    const builtin = await loadTsModule(path.join(app, 'lib/builtin-bots.ts'));
    for (const scenario of [
        { requestedId: '1', bot: { id: 'db-1', sortOrder: 1, name: '已更名KPI教练' }, id: '1', name: '已更名KPI教练' },
        { requestedId: '', bot: null, id: '36', name: '通用聊天' },
        { requestedId: 'custom-my-id', bot: { id: 'my-id', name: '我的顾问' }, id: 'custom-my-id', name: '我的顾问' },
    ]) {
        const seen = [];
        const lookups = [];
        const stubs = await routeStubs(routePath);
        Object.assign(stubs, {
            '@/app/lib/usage-context': context, '../../lib/auth': auth, '../../lib/builtin-bots': builtin,
            '../../lib/chat-models': models,
            '../../lib/model-access': { getModelAccessSiteKeyForBot: () => 'main-general' },
            '../../lib/server-bot-access': { assertUserCanAccessOfficialBot: async () => {} },
            '../../lib/server-model-access': { assertUserCanUseModel: async () => {} },
            '../../lib/server-bot-prompts': { getSystemPromptByBotId: () => 'System prompt' },
            '../../lib/builtin-knowledge': { buildPromptWithBuiltinKnowledge: (_id, prompt) => prompt },
            '../../lib/web-search': { enrichSystemPromptWithWebSearch: async input => input },
            '../../lib/yunwu-openai-chat': { streamYunwuOpenAIChat: async () => { seen.push({ ...context.usageContext.getStore() }); } },
            '../../lib/server-env': { readBackendUrl: () => 'https://backend.test' },
            '../../lib/prisma': { prisma: {
                bot: { findFirst: async query => { lookups.push(query); return scenario.bot; } },
                customBot: { findFirst: async query => { lookups.push(query); return scenario.bot; } },
            } },
        });
        const { POST } = await loadTsModule(routePath, stubs);
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () => Response.json({ data: { systemPrompt: 'Custom prompt' } });
        try {
            const response = await POST(new Request('https://main.test/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ botId: scenario.requestedId, botName: 'FORGED NAME', message: 'hello', responseModel: 'gpt-5.4' }) }));
            assert.equal(response.status, 200);
            await response.text();
            assert.deepEqual(seen, [{ userId: 'alice', source: 'main', botId: scenario.id, botName: scenario.name }]);
            if (scenario.requestedId.startsWith('custom-')) assert.equal(lookups[0].where.userId, 'alice');
        } finally { globalThis.fetch = originalFetch; }
    }
});

test('conversation attribution uses the server-resolved bot after its access check', async () => {
    const routePath = path.join(app, 'api/conversations/[id]/messages/route.ts');
    const context = await loadTsModule(path.join(app, 'lib/usage-context.ts'), { 'node:async_hooks': { AsyncLocalStorage }, './auth': auth });
    const models = await loadTsModule(path.join(app, 'lib/chat-models.ts'));
    for (const permitted of [true, false]) {
        let checked;
        const stubs = await routeStubs(routePath);
        for (const specifier of Object.keys(stubs)) {
            if (specifier.endsWith('/usage-context')) stubs[specifier] = context;
            if (specifier === 'zod') stubs[specifier] = { z };
            if (specifier.endsWith('/auth')) stubs[specifier] = { ...auth, getUserId: async () => 'alice' };
            if (specifier.endsWith('/prisma')) stubs[specifier] = { prisma: { conversation: { findFirst: async () => ({ id: 'conversation' }) } } };
            if (specifier.endsWith('/chat-models')) stubs[specifier] = models;
            if (specifier.endsWith('/server-conversations')) stubs[specifier] = { getConversationBotPayload: () => ({ routeId: 'custom-real-id', name: '公司顾问', kind: 'custom' }) };
            if (specifier.endsWith('/server-bot-access')) stubs[specifier] = { assertConversationBotAccess: async () => {
                assert.equal(context.usageContext.getStore().botName, undefined);
                if (!permitted) throw new auth.AppError('denied', 403);
            } };
            if (specifier.endsWith('/model-access')) stubs[specifier] = { getModelAccessSiteKeyForBot: () => 'main-general' };
            if (specifier.endsWith('/server-model-access')) stubs[specifier] = { assertUserCanUseModel: async () => {
                checked = { ...context.usageContext.getStore() };
                throw new auth.AppError('stop before generation', 409);
            } };
        }
        const { POST } = await loadTsModule(routePath, stubs);
        const response = await POST(new Request('https://main.test/api/conversations/conversation/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'hello', botName: 'FORGED NAME' }) }), { params: Promise.resolve({ id: 'conversation' }) });
        assert.equal(response.status, permitted ? 409 : 403);
        assert.deepEqual(checked, permitted ? { userId: 'alice', source: 'main', botId: 'custom-real-id', botName: '公司顾问' } : undefined);
    }
});
