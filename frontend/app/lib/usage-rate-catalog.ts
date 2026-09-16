import type { UsageRate } from './usage-values';

export const USAGE_RATE_CATALOG_LABEL = 'OpenLux 截图报价（2026-09-16）';

// Only prices visible in the supplied screenshots are recorded; missing prices remain unknown.
// Token prices are USD per million tokens. Per-call prices are USD per request.
export const DEFAULT_USAGE_RATES: readonly UsageRate[] = [
    // OpenAI
    {
        provider: 'api.openlux.ai', model: 'gpt-6-astra', currency: 'USD',
        inputPerMillion: 0.3677, outputPerMillion: 1.8380,
        cachedPerMillion: 0.0368, cacheWritePerMillion: 0.4596,
    },
    {
        provider: 'api.openlux.ai', model: 'gpt-5.6-sol', currency: 'USD',
        inputPerMillion: 0.1838, outputPerMillion: 1.1030,
        cachedPerMillion: 0.0184, cacheWritePerMillion: 0.2298,
    },
    {
        provider: 'api.openlux.ai', model: 'gpt-5.5', currency: 'USD',
        inputPerMillion: 0.1838, outputPerMillion: 1.1030,
        cachedPerMillion: 0.0184, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'gpt-5.6-terra', currency: 'USD',
        inputPerMillion: 0.0735, outputPerMillion: 0.4412,
        cachedPerMillion: 0.0073, cacheWritePerMillion: 0.0919,
    },
    {
        provider: 'api.openlux.ai', model: 'gpt-image-2', currency: 'USD',
        inputPerMillion: 0.2942, outputPerMillion: 1.7650,
        cachedPerMillion: null, cacheWritePerMillion: null,
        imageInputPerMillion: 0.4706,
    },
    {
        provider: 'api.openlux.ai', model: 'gpt-5.6-luna', currency: 'USD',
        inputPerMillion: 0.0206, outputPerMillion: 0.1235,
        cachedPerMillion: 0.0021, cacheWritePerMillion: 0.0257,
    },
    {
        provider: 'api.openlux.ai', model: 'gpt-5.4', currency: 'USD',
        inputPerMillion: 0.2574, outputPerMillion: 1.5440,
        cachedPerMillion: 0.0257, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'gpt-image-2.5-sunburst', currency: 'USD',
        inputPerMillion: 2.2060, outputPerMillion: 13.2350,
        cachedPerMillion: null, cacheWritePerMillion: null,
        imageInputPerMillion: 3.5290,
    },
    {
        provider: 'api.openlux.ai', model: 'gpt-4o', currency: 'USD',
        inputPerMillion: 0.1103, outputPerMillion: 0.4412,
        cachedPerMillion: 0.0551, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'gpt-4o-mini', currency: 'USD',
        inputPerMillion: 0.0066, outputPerMillion: 0.0265,
        cachedPerMillion: 0.0033, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'gpt-5-mini', currency: 'USD',
        inputPerMillion: 0.0110, outputPerMillion: 0.0882,
        cachedPerMillion: 0.0011, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'gpt-5.4-mini', currency: 'USD',
        inputPerMillion: 0.0331, outputPerMillion: 0.1985,
        cachedPerMillion: 0.0033, cacheWritePerMillion: null,
    },
    // Google
    {
        provider: 'api.openlux.ai', model: 'gemini-3.8-flash', currency: 'USD',
        inputPerMillion: 0.0551, outputPerMillion: 0.2757,
        cachedPerMillion: 0.0055, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'gemini-3.5-flash', currency: 'USD',
        inputPerMillion: 0.1103, outputPerMillion: 0.6618,
        cachedPerMillion: 0.0110, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'gemini-3.1-flash-image-preview', currency: 'USD',
        inputPerMillion: null, outputPerMillion: null,
        cachedPerMillion: null, cacheWritePerMillion: null,
        perCall: 0.0122,
    },
    {
        provider: 'api.openlux.ai', model: 'gemini-3-pro-image-preview', currency: 'USD',
        inputPerMillion: null, outputPerMillion: null,
        cachedPerMillion: null, cacheWritePerMillion: null,
        perCall: 0.0243,
    },
    {
        provider: 'api.openlux.ai', model: 'gemini-3-flash-preview', currency: 'USD',
        inputPerMillion: 0.0368, outputPerMillion: 0.2206,
        cachedPerMillion: 0.0037, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'gemini-3.7-flash', currency: 'USD',
        inputPerMillion: 0.0551, outputPerMillion: 0.2757,
        cachedPerMillion: 0.0055, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'gemini-3.1-pro-preview', currency: 'USD',
        inputPerMillion: 0.1471, outputPerMillion: 0.8824,
        cachedPerMillion: 0.0147, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'gemini-3.1-flash-lite', currency: 'USD',
        inputPerMillion: 0.0184, outputPerMillion: 0.1103,
        cachedPerMillion: 0.0018, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'gemini-2.5-pro', currency: 'USD',
        inputPerMillion: 0.0919, outputPerMillion: 0.7353,
        cachedPerMillion: 0.0092, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'gemini-3.1-flash-image', currency: 'USD',
        inputPerMillion: null, outputPerMillion: null,
        cachedPerMillion: null, cacheWritePerMillion: null,
        perCall: 0.0122,
    },
    {
        provider: 'api.openlux.ai', model: 'gemini-3.5-flash-lite', currency: 'USD',
        inputPerMillion: 0.0221, outputPerMillion: 0.1838,
        cachedPerMillion: 0.0022, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'gemini-3.6-flash', currency: 'USD',
        inputPerMillion: 0.0551, outputPerMillion: 0.2757,
        cachedPerMillion: 0.0055, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'gemini-3-pro-image', currency: 'USD',
        inputPerMillion: null, outputPerMillion: null,
        cachedPerMillion: null, cacheWritePerMillion: null,
        perCall: 0.0582,
    },
    {
        provider: 'api.openlux.ai', model: 'gemini-3.1-flash-lite-image', currency: 'USD',
        inputPerMillion: null, outputPerMillion: null,
        cachedPerMillion: null, cacheWritePerMillion: null,
        perCall: 0.0228,
    },
    {
        provider: 'api.openlux.ai', model: 'gemini-2.5-flash', currency: 'USD',
        inputPerMillion: 0.0221, outputPerMillion: 0.1840,
        cachedPerMillion: 0.0022, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'gemini-2.5-flash-image', currency: 'USD',
        inputPerMillion: null, outputPerMillion: null,
        cachedPerMillion: null, cacheWritePerMillion: null,
        perCall: 0.0110,
    },
    {
        provider: 'api.openlux.ai', model: 'gemini-3-pro-preview', currency: 'USD',
        inputPerMillion: 0.1471, outputPerMillion: 0.8824,
        cachedPerMillion: 0.0147, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'gemini-2.5-flash-lite', currency: 'USD',
        inputPerMillion: 0.0073, outputPerMillion: 0.0294,
        cachedPerMillion: 0.0007, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'veo_3_1-fast', currency: 'USD',
        inputPerMillion: null, outputPerMillion: null,
        cachedPerMillion: null, cacheWritePerMillion: null,
        perCall: 0.0424,
    },
    {
        provider: 'api.openlux.ai', model: 'gemini-2.5-flash-preview-tts', currency: 'USD',
        inputPerMillion: 0.2206, outputPerMillion: 4.4120,
        cachedPerMillion: null, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'gemini-3.1-flash-tts-preview', currency: 'USD',
        inputPerMillion: 0.2647, outputPerMillion: 5.2940,
        cachedPerMillion: null, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'veo_3_1', currency: 'USD',
        inputPerMillion: null, outputPerMillion: null,
        cachedPerMillion: null, cacheWritePerMillion: null,
        perCall: 0.0565,
    },
    {
        provider: 'api.openlux.ai', model: 'gemini-3.1-flash-lite-preview', currency: 'USD',
        inputPerMillion: 0.0184, outputPerMillion: 0.1103,
        cachedPerMillion: 0.0018, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'veo_3_1-components', currency: 'USD',
        inputPerMillion: null, outputPerMillion: null,
        cachedPerMillion: null, cacheWritePerMillion: null,
        perCall: 0.0565,
    },
    // OpenAI Plus
    {
        provider: 'api.openlux.ai', model: 'gpt-image-2-c', currency: 'USD',
        inputPerMillion: null, outputPerMillion: null,
        cachedPerMillion: null, cacheWritePerMillion: null,
        perCall: 0.00882,
    },
    {
        provider: 'api.openlux.ai', model: 'gpt-5.3-codex', currency: 'USD',
        inputPerMillion: 0.1802, outputPerMillion: 1.4410,
        cachedPerMillion: 0.0180, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'gpt-5.3-codex-spark', currency: 'USD',
        inputPerMillion: 0.0643, outputPerMillion: 0.5148,
        cachedPerMillion: null, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'gpt-5.2-codex', currency: 'USD',
        inputPerMillion: 0.1802, outputPerMillion: 1.4410,
        cachedPerMillion: 0.0180, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'gpt-5.1-codex', currency: 'USD',
        inputPerMillion: 0.2757, outputPerMillion: 2.2060,
        cachedPerMillion: 0.0276, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'gpt-5.1-codex-mini', currency: 'USD',
        inputPerMillion: 0.0257, outputPerMillion: 0.2059,
        cachedPerMillion: 0.0026, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'gpt-5.1-codex-max', currency: 'USD',
        inputPerMillion: 0.1287, outputPerMillion: 1.0300,
        cachedPerMillion: 0.0129, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'gpt-4o-search-preview-2025-03-11', currency: 'USD',
        inputPerMillion: 1.4710, outputPerMillion: 5.8820,
        cachedPerMillion: null, cacheWritePerMillion: null,
    },
    // Anthropic
    {
        provider: 'api.openlux.ai', model: 'claude-fable-5-1', currency: 'USD',
        inputPerMillion: 1.7650, outputPerMillion: 8.8230,
        cachedPerMillion: 0.0441, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'claude-opus-5', currency: 'USD',
        inputPerMillion: 0.4412, outputPerMillion: 2.2060,
        cachedPerMillion: 0.0441, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'claude-opus-4-8', currency: 'USD',
        inputPerMillion: 0.4412, outputPerMillion: 2.2060,
        cachedPerMillion: 0.0441, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'claude-fable-5', currency: 'USD',
        inputPerMillion: 1.7650, outputPerMillion: 8.8230,
        cachedPerMillion: 0.1765, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'claude-sonnet-5', currency: 'USD',
        inputPerMillion: 0.1765, outputPerMillion: 0.8824,
        cachedPerMillion: 0.0176, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'claude-opus-4-6', currency: 'USD',
        inputPerMillion: 0.4412, outputPerMillion: 2.2060,
        cachedPerMillion: 0.0441, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'claude-sonnet-4-6', currency: 'USD',
        inputPerMillion: 0.2647, outputPerMillion: 1.3240,
        cachedPerMillion: 0.0265, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'claude-opus-4-7', currency: 'USD',
        inputPerMillion: 0.4412, outputPerMillion: 2.2060,
        cachedPerMillion: 0.0441, cacheWritePerMillion: 0.5515,
    },
    {
        provider: 'api.openlux.ai', model: 'claude-haiku-4-5-20251001', currency: 'USD',
        inputPerMillion: 0.0882, outputPerMillion: 0.4412,
        cachedPerMillion: 0.0088, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'claude-sonnet-4-5-20250929', currency: 'USD',
        inputPerMillion: 0.2647, outputPerMillion: 1.3240,
        cachedPerMillion: 0.0265, cacheWritePerMillion: 0.3309,
    },
    {
        provider: 'api.openlux.ai', model: 'claude-opus-4-5-20251101', currency: 'USD',
        inputPerMillion: 0.4412, outputPerMillion: 2.2060,
        cachedPerMillion: 0.0441, cacheWritePerMillion: null,
    },
    {
        provider: 'api.openlux.ai', model: 'claude-opus-4-1-20250805', currency: 'USD',
        inputPerMillion: 6.6180, outputPerMillion: 33.0890,
        cachedPerMillion: 0.6618, cacheWritePerMillion: 8.2720,
    },
];
