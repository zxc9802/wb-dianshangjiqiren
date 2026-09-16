import { DEFAULT_USAGE_RATES } from './usage-rate-catalog';
import type { UsageRate } from './usage-values';

export function normalizeUsageProvider(provider: string): string {
    const normalized = provider.trim().toLowerCase();
    return normalized === 'openlux' ? 'api.openlux.ai' : normalized;
}

const key = (rate: Pick<UsageRate, 'provider' | 'model'>) => JSON.stringify([normalizeUsageProvider(rate.provider), rate.model]);

/** Administrator overrides win; screenshot prices only match the OpenLux provider. */
export function mergeUsageRates(overrides: UsageRate[]): UsageRate[] {
    const rates = new Map(DEFAULT_USAGE_RATES.map(rate => [key(rate), { ...rate }]));
    for (const rate of overrides) rates.set(key(rate), { ...rate, provider: normalizeUsageProvider(rate.provider) });
    return [...rates.values()];
}

export function findUsageRate(event: { provider: string; model: string }, rates: readonly UsageRate[]): UsageRate | undefined {
    return rates.find(rate => key(rate) === key(event));
}
