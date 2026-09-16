import { Prisma } from '@prisma/client';
import type { UsageRate } from './usage-values';

/** Read-time estimates fill missing prices without rewriting stored bills or rate snapshots. */
export function pricedUsageCte(filters: Prisma.Sql, rates: readonly UsageRate[]): Prisma.Sql {
    return Prisma.sql`WITH priced_events AS (
        SELECT e.id, e.user_id, e.source, e.created_at,
            CASE WHEN estimate.amount IS NOT NULL THEN e.data || jsonb_build_object(
                'amount', estimate.amount, 'currency', r.rate->>'currency', 'costBasis', 'estimated',
                'rate', r.rate, 'historicalEstimate', true
            ) ELSE e.data END AS data
        FROM ai_usage_events e
        LEFT JOIN LATERAL (
            SELECT rate FROM jsonb_array_elements(${JSON.stringify(rates)}::jsonb) AS rate
            WHERE rate->>'provider' = CASE lower(btrim(e.data->>'provider'))
                WHEN 'openlux' THEN 'api.openlux.ai' ELSE lower(btrim(e.data->>'provider')) END
                AND rate->>'model' = e.data->>'model'
            LIMIT 1
        ) r ON e.data->>'status' = 'completed' AND e.data->>'amount' IS NULL
        CROSS JOIN LATERAL (SELECT
            (e.data->>'inputTokens')::numeric AS input,
            (e.data->>'outputTokens')::numeric AS output,
            COALESCE((e.data->>'cachedInputTokens')::numeric, 0) AS cached,
            COALESCE((e.data->>'cacheWriteTokens')::numeric, 0) AS written,
            CASE WHEN r.rate ? 'imageInputPerMillion'
                THEN COALESCE((e.data->>'imageInputTokens')::numeric, 0) ELSE 0 END AS images
        ) t
        CROSS JOIN LATERAL (SELECT CASE
            WHEN r.rate IS NULL THEN NULL
            WHEN r.rate->>'perCall' IS NOT NULL THEN (r.rate->>'perCall')::numeric
            WHEN t.input IS NULL OR t.output IS NULL OR t.cached + t.written + t.images > t.input THEN NULL
            WHEN t.input > 0 AND r.rate ? 'imageInputPerMillion' AND e.data->>'imageInputTokens' IS NULL THEN NULL
            WHEN t.input - t.cached - t.written - t.images > 0 AND r.rate->>'inputPerMillion' IS NULL THEN NULL
            WHEN t.cached > 0 AND r.rate->>'cachedPerMillion' IS NULL THEN NULL
            WHEN t.written > 0 AND r.rate->>'cacheWritePerMillion' IS NULL THEN NULL
            WHEN t.images > 0 AND r.rate->>'imageInputPerMillion' IS NULL THEN NULL
            WHEN t.output > 0 AND r.rate->>'outputPerMillion' IS NULL THEN NULL
            ELSE ((t.input - t.cached - t.written - t.images) * COALESCE((r.rate->>'inputPerMillion')::numeric, 0)
                + t.cached * COALESCE((r.rate->>'cachedPerMillion')::numeric, 0)
                + t.written * COALESCE((r.rate->>'cacheWritePerMillion')::numeric, 0)
                + t.images * COALESCE((r.rate->>'imageInputPerMillion')::numeric, 0)
                + t.output * COALESCE((r.rate->>'outputPerMillion')::numeric, 0)) / 1000000
        END AS amount) estimate
        WHERE ${filters}
    )`;
}
