import { randomUUID } from 'node:crypto';
import { prisma } from '../utils/prisma';
import { estimateUsageCost, type TokenUsage, type UsageRate } from './usage-values';

export type UsageEvent = TokenUsage & {
    userId: string; source: string; requestId: string; provider: string; model: string;
    status: 'pending' | 'completed' | 'failed' | 'interrupted';
    tokenBasis: 'reported' | 'estimated' | 'missing';
    amount?: number | null; currency?: 'USD' | 'CNY' | null;
    costBasis?: 'actual' | 'estimated' | 'missing';
    upstreamRequestId?: string | null;
    rate?: UsageRate | null;
};

let setup: Promise<unknown> | undefined;
export async function ensureUsageLedger() {
    if (!setup) setup = (async () => {
        await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS ai_usage_events (
            id text PRIMARY KEY, user_id text NOT NULL, source text NOT NULL,
            request_id text NOT NULL, data jsonb NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE(source, request_id)
        )`);
        await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS ai_usage_events_user_date ON ai_usage_events(user_id, created_at)');
        await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS ai_usage_events_date ON ai_usage_events(created_at)');
    })().catch(error => { setup = undefined; throw error; });
    await setup;
}

export async function getUsageRates(): Promise<UsageRate[]> {
    const row = await prisma.systemSetting.findUnique({ where: { key: 'ai_usage_rates' } });
    return row ? JSON.parse(row.value) : [];
}

export async function priceUsage(event: UsageEvent): Promise<UsageEvent> {
    if (event.amount !== undefined && event.amount !== null && event.currency && event.costBasis) return event;
    const rate = (await getUsageRates()).find(item => item.provider === event.provider && item.model === event.model);
    const amount = rate && event.status === 'completed' ? estimateUsageCost(event, rate) : null;
    return { ...event, amount, currency: amount !== null ? rate!.currency : null, costBasis: amount !== null ? 'estimated' : 'missing', rate: rate ?? null };
}

/** First terminal report wins. Replays cannot change the employee, amount or timestamp. */
export async function recordUsage(event: UsageEvent): Promise<boolean> {
    await ensureUsageLedger();
    const data = event.status === 'pending' ? event : await priceUsage(event);
    const changed = await prisma.$executeRaw`
        INSERT INTO ai_usage_events (id, user_id, source, request_id, data)
        VALUES (${randomUUID()}, ${event.userId}, ${event.source}, ${event.requestId}, ${JSON.stringify(data)}::jsonb)
        ON CONFLICT (source, request_id) DO UPDATE SET data = EXCLUDED.data
        WHERE ai_usage_events.user_id = EXCLUDED.user_id AND ai_usage_events.data->>'status' = 'pending'
    `;
    return changed > 0;
}
