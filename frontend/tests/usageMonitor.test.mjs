import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as crypto from 'node:crypto';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app/lib');
const values = await loadTsModule(path.join(root, 'usage-values.ts'));

test('OpenAI cached and reasoning tokens are included once, including explicit zero', () => {
    const u = values.parseTokenUsage({ usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 20 } } });
    assert.equal(u.totalTokens, 140);
    assert.equal(u.reasoningTokens, 20);
    const rate = { inputPerMillion: 2, outputPerMillion: 8, cachedPerMillion: .2, cacheWritePerMillion: 2 };
    assert.equal(values.estimateUsageCost(u, rate), (40 * 2 + 60 * .2 + 40 * 8) / 1e6);
    assert.equal(values.parseTokenUsage({ usage: { input_tokens: 0, output_tokens: 0 } }).totalTokens, 0);
    assert.equal(values.estimateUsageCost(values.emptyUsage(), rate), null);
});

test('Gemini thoughts count as output and Anthropic cache buckets count as input', () => {
    const g = values.parseTokenUsage({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30, totalTokenCount: 150 } });
    assert.equal(g.outputTokens, 50);
    assert.equal(g.totalTokens, 150);
    const start = values.parseTokenUsage({ message: { usage: { input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 10, output_tokens: 0 } } });
    const end = values.mergeUsage(start, values.parseTokenUsage({ usage: { output_tokens: 30 } }));
    assert.equal(end.inputTokens, 100);
    assert.equal(end.totalTokens, 130);
});

async function observer(fetchImpl) {
    const records = [];
    const context = new AsyncLocalStorage();
    const mod = await loadTsModule(path.join(root, 'usage-fetch.ts'), {
        'node:crypto': crypto, './usage-values': values, './usage-context': { usageContext: context },
        './usage-ledger': { recordUsage: async record => { records.push(structuredClone(record)); return true; } },
    });
    const oldFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    return { ...mod, context, records, restore: () => { globalThis.fetch = oldFetch; } };
}

test('streamed usage survives split packets and output is unchanged', async () => {
    const packet = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: {"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}\n\ndata: [DONE]\n\n';
    let sent;
    const obs = await observer(async (_url, init) => {
        sent = JSON.parse(init.body);
        const bytes = new TextEncoder().encode(packet);
        return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
    });
    try {
        const response = await obs.context.run({ userId: 'alice', source: 'main' }, () => obs.usageFetch('https://provider.test/v1/chat/completions', { body: JSON.stringify({ model: 'test', stream: true }) }));
        assert.equal(await response.text(), packet);
        assert.equal(sent.stream_options.include_usage, true);
        const final = obs.records.at(-1);
        assert.equal(final.userId, 'alice'); assert.equal(final.totalTokens, 30); assert.equal(final.status, 'completed');
        assert.ok(!JSON.stringify(obs.records).includes('你好'));
    } finally { obs.restore(); }
});

test('concurrent employees retain server identity and missing usage remains null', async () => {
    const obs = await observer(async () => new Response(JSON.stringify({ choices: [] })));
    try {
        await Promise.all(['alice', 'bob'].map(userId => obs.context.run({ userId, source: 'main' }, async () => {
            await new Promise(resolve => setTimeout(resolve, userId === 'alice' ? 10 : 1));
            const res = await obs.usageFetch('https://provider.test/v1/responses', { body: JSON.stringify({ model: userId }) });
            await res.text();
        })));
        const completed = obs.records.filter(r => r.status === 'completed');
        assert.equal(completed.length, 2);
        completed.forEach(r => { assert.equal(r.userId, r.model); assert.equal(r.totalTokens, null); assert.equal(r.tokenBasis, 'missing'); });
    } finally { obs.restore(); }
});

test('network failures and stream cancellation are visible', async () => {
    const obs = await observer(async () => { throw new Error('connection reset'); });
    try {
        await assert.rejects(obs.context.run({ userId: 'a', source: 'main' }, () => obs.usageFetch('https://provider.test/v1/responses')), /connection reset/);
        assert.equal(obs.records.at(-1).status, 'failed');
        globalThis.fetch = async () => new Response(new ReadableStream({ pull(c) { c.enqueue(new TextEncoder().encode('data: {}\n\n')); } }), { headers: { 'content-type': 'text/event-stream' } });
        const res = await obs.context.run({ userId: 'b', source: 'main' }, () => obs.usageFetch('https://provider.test/v1/chat/completions'));
        await res.body.cancel();
        assert.equal(obs.records.at(-1).status, 'interrupted');
    } finally { obs.restore(); }
});

test('request wrapper denies unauthenticated work before the provider runs', async () => {
    let called = false;
    const mod = await loadTsModule(path.join(root, 'usage-context.ts'), {
        'node:async_hooks': { AsyncLocalStorage },
        './auth': { getAuthUser: async () => { throw new Error('Unauthorized'); }, errorResponse: () => new Response(null, { status: 401 }) },
    });
    const result = await mod.withUsage(async () => { called = true; return new Response('bad'); })(new Request('https://test/'));
    assert.equal(result.status, 401); assert.equal(called, false);
});

test('Responses failure inside HTTP 200 is not recorded as a successful generation', async () => {
    const obs = await observer(async () => new Response('data: {"type":"response.failed","response":{"usage":{"input_tokens":2,"output_tokens":0}}}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    try {
        const response = await obs.context.run({ userId: 'alice', source: 'main' }, () => obs.usageFetch('https://provider.test/v1/responses'));
        await response.text();
        assert.equal(obs.records.at(-1).status, 'failed');
        assert.equal(obs.records.at(-1).inputTokens, 2);
    } finally { obs.restore(); }
});

test('independently deployed backend uses the same metering implementation', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const file of ['usage-values.ts', 'usage-fetch.ts', 'usage-ledger.ts']) {
        const frontend = await readFile(path.join(root, file), 'utf8');
        const backend = await readFile(path.join(root, '../../../backend/src/services', file), 'utf8');
        assert.equal(backend.replace("from '../utils/prisma'", "from './prisma'"), frontend);
    }
});
