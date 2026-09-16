import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTsModule } from './helpers/loadTsModule.mjs';

const lib = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app/lib');
const values = await loadTsModule(path.join(lib, 'usage-values.ts'));
const rate = { provider: 'api.openlux.ai', model: 'gpt-6-astra', currency: 'USD', inputPerMillion: .3677, outputPerMillion: 1.838, cachedPerMillion: .0368, cacheWritePerMillion: .4596 };

test('screenshot GPT-6 buckets count each input token once', () => {
    const usage = { ...values.emptyUsage(), inputTokens: 1000000, outputTokens: 100000, cachedInputTokens: 200000, cacheWriteTokens: 100000 };
    assert.equal(values.estimateUsageCost(usage, rate), (.7 * .3677) + (.2 * .0368) + (.1 * .4596) + (.1 * 1.838));
});

test('unknown component prices are not treated as free tokens', () => {
    const usage = { ...values.emptyUsage(), inputTokens: 100, outputTokens: 0, cacheWriteTokens: 10 };
    assert.equal(values.estimateUsageCost(usage, { ...rate, cacheWritePerMillion: null }), null);
    assert.equal(values.estimateUsageCost({ ...usage, cacheWriteTokens: 0 }, { ...rate, cacheWritePerMillion: null, outputPerMillion: null }), 100 * rate.inputPerMillion / 1e6);
    assert.equal(values.estimateUsageCost({ ...usage, cacheWriteTokens: 0, cachedInputTokens: 10 }, { ...rate, cachedPerMillion: null }), null);
});

test('GPT image usage separates image input and refuses missing mixed-input detail', () => {
    const imageRate = { ...rate, inputPerMillion: .2942, outputPerMillion: 1.765, imageInputPerMillion: .4706, cachedPerMillion: null, cacheWritePerMillion: null };
    const parsed = values.parseTokenUsage({ usage: { input_tokens: 1000, output_tokens: 200, input_tokens_details: { text_tokens: 200, image_tokens: 800 } } });
    assert.equal(parsed.imageInputTokens, 800);
    assert.equal(values.estimateUsageCost(parsed, imageRate), (200 * .2942 + 800 * .4706 + 200 * 1.765) / 1e6);
    assert.equal(values.estimateUsageCost({ ...parsed, imageInputTokens: null }, imageRate), null);
    assert.equal(values.estimateUsageCost({ ...parsed, imageInputTokens: 1100 }, imageRate), null);
    assert.equal(values.estimateUsageCost(parsed, { ...imageRate, imageInputPerMillion: null }), null);
    assert.equal(values.estimateUsageCost({ ...parsed, imageInputTokens: 0 }, { ...imageRate, imageInputPerMillion: null }), (1000 * .2942 + 200 * 1.765) / 1e6);
    assert.equal(values.estimateUsageCost(values.emptyUsage(), { ...imageRate, perCall: .00882 }), .00882);
});

test('default prices only apply to OpenLux and saved overrides take priority', async () => {
    const catalog = await loadTsModule(path.join(lib, 'usage-rate-catalog.ts'));
    const pricing = await loadTsModule(path.join(lib, 'usage-pricing.ts'), { './usage-rate-catalog': catalog });
    const rates = pricing.mergeUsageRates([{ ...rate, provider: 'openlux', outputPerMillion: 2 }]);
    assert.equal(pricing.findUsageRate({ provider: 'api.openlux.ai', model: rate.model }, rates).outputPerMillion, 2);
    assert.equal(pricing.findUsageRate({ provider: 'openlux', model: rate.model }, rates).outputPerMillion, 2);
    assert.equal(pricing.findUsageRate({ provider: 'yunwu.ai', model: rate.model }, rates), undefined);
    assert.equal(pricing.findUsageRate({ provider: 'other.test', model: rate.model }, rates), undefined);
    assert.equal(pricing.findUsageRate({ provider: 'api.openlux.ai', model: 'not-in-screenshots' }, rates), undefined);
    assert.equal(rates.length, catalog.DEFAULT_USAGE_RATES.length);
    assert.equal(catalog.DEFAULT_USAGE_RATES[0].outputPerMillion, 1.838);
});
