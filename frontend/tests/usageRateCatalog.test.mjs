import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app/lib');
const { DEFAULT_USAGE_RATES: rates, USAGE_RATE_CATALOG_LABEL: label } = await loadTsModule(path.join(root, 'usage-rate-catalog.ts'));
const rate = model => rates.find(item => item.model === model);

test('the screenshot catalog contains 56 distinct OpenLux models and no other provider', () => {
    assert.equal(label, 'OpenLux 截图报价（2026-09-16）');
    assert.equal(rates.length, 56);
    assert.equal(new Set(rates.map(item => item.model)).size, 56);
    for (const item of rates) {
        assert.equal(item.provider, 'api.openlux.ai');
        assert.equal(item.currency, 'USD');
    }
    for (const cutOffModel of ['gpt-image-1.5', 'gpt-4.1', 'gemini-pro-latest', 'gemini-2.5-pro-preview-tts', 'claude-sonnet-4-20250514']) {
        assert.equal(rate(cutOffModel), undefined);
    }
});

test('per-call prices preserve screenshot precision without invented token rates', () => {
    const perCall = rates.filter(item => item.perCall !== undefined);
    assert.equal(perCall.length, 10);
    assert.equal(rate('gpt-image-2-c').perCall, 0.00882);
    assert.equal(rate('veo_3_1-fast').perCall, 0.0424);
    for (const item of perCall) {
        for (const field of ['inputPerMillion', 'outputPerMillion', 'cachedPerMillion', 'cacheWritePerMillion']) {
            assert.equal(item[field], null);
        }
    }
});

test('distinct image input prices and unavailable cache prices remain explicit', () => {
    assert.equal(rate('gpt-image-2').inputPerMillion, 0.2942);
    assert.equal(rate('gpt-image-2').imageInputPerMillion, 0.4706);
    assert.equal(rate('gpt-image-2.5-sunburst').imageInputPerMillion, 3.5290);
    assert.equal(rate('gpt-image-2').cachedPerMillion, null);
    assert.equal(rate('gpt-5.3-codex-spark').cachedPerMillion, null);
    assert.equal(rate('claude-fable-5-1').cachedPerMillion, 0.0441);
    assert.equal(rate('claude-fable-5-1').cacheWritePerMillion, null);
    assert.equal(rate('gemini-2.5-flash').outputPerMillion, 0.1840);
    assert.deepEqual(rate('gpt-6-astra'), {
        provider: 'api.openlux.ai', model: 'gpt-6-astra', currency: 'USD',
        inputPerMillion: 0.3677, outputPerMillion: 1.8380,
        cachedPerMillion: 0.0368, cacheWritePerMillion: 0.4596,
    });
});

test('frontend and backend use a byte-identical screenshot catalog', async () => {
    const frontend = await readFile(path.join(root, 'usage-rate-catalog.ts'));
    const backend = await readFile(path.join(root, '../../../backend/src/services/usage-rate-catalog.ts'));
    assert.deepEqual(frontend, backend);
});
