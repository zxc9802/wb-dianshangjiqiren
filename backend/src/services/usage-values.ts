export type TokenUsage = {
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
    cacheWriteTokens: number | null;
    reasoningTokens: number | null;
    totalTokens: number | null;
    imageInputTokens?: number | null;
};

export const emptyUsage = (): TokenUsage => ({
    inputTokens: null, outputTokens: null, cachedInputTokens: null,
    cacheWriteTokens: null, reasoningTokens: null, totalTokens: null, imageInputTokens: null,
});

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => value && typeof value === 'object' ? value as Obj : {};
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Counts include cached input and reasoning output; do not add them to totals twice. */
export function parseTokenUsage(value: unknown): TokenUsage {
    const root = obj(value);
    const response = obj(root.response);
    const message = obj(root.message);
    const gemini = obj(root.usageMetadata);
    const u = obj(root.usage ?? response.usage ?? message.usage);
    const inputDetails = obj(u.prompt_tokens_details ?? u.input_tokens_details);
    const outputDetails = obj(u.completion_tokens_details ?? u.output_tokens_details);
    const result = emptyUsage();
    if (Object.keys(gemini).length) {
        result.inputTokens = count(gemini.promptTokenCount);
        result.cachedInputTokens = count(gemini.cachedContentTokenCount) ?? 0;
        result.reasoningTokens = count(gemini.thoughtsTokenCount) ?? 0;
        const candidates = count(gemini.candidatesTokenCount);
        result.outputTokens = candidates === null ? null : candidates + result.reasoningTokens;
        result.totalTokens = count(gemini.totalTokenCount);
    } else {
        result.inputTokens = count(u.prompt_tokens ?? u.input_tokens);
        result.outputTokens = count(u.completion_tokens ?? u.output_tokens);
        result.cachedInputTokens = count(inputDetails.cached_tokens ?? u.cache_read_input_tokens);
        result.cacheWriteTokens = count(u.cache_creation_input_tokens);
        result.reasoningTokens = count(outputDetails.reasoning_tokens);
        result.imageInputTokens = count(inputDetails.image_tokens);
        // Anthropic's input_tokens excludes both cache buckets.
        if (result.inputTokens !== null && ('cache_read_input_tokens' in u || 'cache_creation_input_tokens' in u)) {
            result.inputTokens += (result.cachedInputTokens ?? 0) + (result.cacheWriteTokens ?? 0);
        }
        result.totalTokens = count(u.total_tokens);
    }
    if (result.totalTokens === null && result.inputTokens !== null && result.outputTokens !== null) {
        result.totalTokens = result.inputTokens + result.outputTokens;
    }
    return result;
}

export function mergeUsage(previous: TokenUsage, next: TokenUsage): TokenUsage {
    const result = { ...previous };
    for (const key of Object.keys(emptyUsage()) as (keyof TokenUsage)[]) {
        if (next[key] != null) result[key] = next[key];
    }
    if (next.totalTokens === null && result.inputTokens !== null && result.outputTokens !== null) result.totalTokens = result.inputTokens + result.outputTokens;
    return result;
}

export type UsageRate = {
    provider: string; model: string; currency: 'USD' | 'CNY';
    inputPerMillion: number | null; outputPerMillion: number | null;
    cachedPerMillion: number | null; cacheWritePerMillion: number | null;
    imageInputPerMillion?: number | null;
    perCall?: number;
};

export function estimateUsageCost(usage: TokenUsage, rate: UsageRate): number | null {
    if (rate.perCall !== undefined) return rate.perCall;
    if (usage.inputTokens === null || usage.outputTokens === null) return null;
    const cached = usage.cachedInputTokens ?? 0;
    const written = usage.cacheWriteTokens ?? 0;
    const separateImages = 'imageInputPerMillion' in rate;
    if (separateImages && usage.inputTokens > 0 && usage.imageInputTokens == null) return null;
    const images = separateImages ? (usage.imageInputTokens ?? 0) : 0;
    if (cached + written + images > usage.inputTokens) return null;
    const buckets: [number, number | null | undefined][] = [
        [usage.inputTokens - cached - written - images, rate.inputPerMillion],
        [cached, rate.cachedPerMillion], [written, rate.cacheWritePerMillion],
        [images, rate.imageInputPerMillion], [usage.outputTokens, rate.outputPerMillion],
    ];
    if (buckets.some(([tokens, price]) => tokens > 0 && price == null)) return null;
    return buckets.reduce((sum, [tokens, price]) => sum + tokens * (price ?? 0), 0) / 1_000_000;
}
