import { z } from 'zod';
import { AppError } from './auth';
import { prisma } from './prisma';
import { ensureUsageLedger, priceUsage } from './usage-ledger';
import { emptyUsage } from './usage-values';
import { randomUUID } from 'node:crypto';

const count = z.number().int().min(0).max(200_000_000);
export const toolRequestSchema = z.object({
    action: z.enum(['reserve', 'settle', 'release']),
    product: z.string().min(1).max(50), userId: z.string().min(1).max(191),
    requestId: z.string().uuid(), operation: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/),
    model: z.string().max(191).optional(), providerId: z.string().max(100).optional(),
    estimatedInputTokens: count.optional(), maxOutputTokens: count.optional(),
    mediaProduct: z.enum(['nanobanana2', 'seedance2', 'seedance2-fast']).optional(),
    billableUnits: z.number().positive().max(10000).optional(),
    usage: z.object({ inputTokens: count, outputTokens: count, totalTokens: count,
        cachedInputTokens: count.default(0), reasoningTokens: count.default(0),
    }).refine(u => u.cachedInputTokens <= u.inputTokens && u.reasoningTokens <= u.outputTokens && u.totalTokens >= u.inputTokens + u.outputTokens).optional(),
}).superRefine((v, ctx) => {
    if (v.action === 'release') return;
    if (!v.model || (v.mediaProduct && !v.billableUnits) ||
        (!v.mediaProduct && v.action === 'settle' && !v.usage)) {
        ctx.addIssue({ code: 'custom', message: 'Model and media units or settled token usage are required.' });
    }
});
export type ToolRequest = z.infer<typeof toolRequestSchema>;
type Stored = { input: ToolRequest; status: 'pending' | 'completed' | 'failed' };

export function transitionRequest(previous: Stored | undefined, input: ToolRequest): Stored {
    if (!previous) {
        if (input.action !== 'reserve') throw new AppError('Request was not reserved.', 409);
        return { input, status: 'pending' };
    }
    for (const key of ['userId', 'product', 'operation', 'model', 'providerId', 'mediaProduct', 'billableUnits'] as const) {
        if (previous.input[key] !== input[key]) throw new AppError('Request identity or model mismatch.', 409);
    }
    if (previous.status !== 'pending') {
        // Late failure callbacks must not undo a successful settlement.
        if (input.action === 'reserve' || (previous.status === 'failed' && input.action === 'settle')) {
            throw new AppError('Request is already closed.', 409);
        }
        return previous;
    }
    return { input, status: input.action === 'settle' ? 'completed' : input.action === 'release' ? 'failed' : 'pending' };
}
let setup: Promise<unknown> | undefined;
async function ensureTables() {
    if (!setup) setup = (async () => {
        await ensureUsageLedger();
        await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS sso_tool_requests (
            product text NOT NULL, request_id text NOT NULL, data jsonb NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (product, request_id))`);
    })().catch(e => { setup = undefined; throw e; });
    await setup;
}

/** wb employees are not charged points. Track the authenticated request lifecycle and supplier usage. */
export async function recordToolRequest(input: ToolRequest) {
    await ensureTables();
    const event = input.action === 'reserve' ? null : await priceUsage({
        ...emptyUsage(), ...(input.usage || {}), userId: input.userId, source: input.product,
        requestId: input.requestId, provider: input.providerId || 'unknown', model: input.model || 'unknown',
        status: input.action === 'settle' ? 'completed' : 'failed',
        tokenBasis: input.usage ? 'reported' : 'missing',
    });
    return prisma.$transaction(async tx => {
        // Serializes even the first concurrent reservation, before a row exists.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.product + ':' + input.requestId}, 0))::text`;
        const rows = await tx.$queryRaw<{ data: Stored }[]>`SELECT data FROM sso_tool_requests
            WHERE product = ${input.product} AND request_id = ${input.requestId} FOR UPDATE`;
        const previous = rows[0]?.data;
        const next = transitionRequest(previous, input);
        if (previous?.status === 'pending' || !previous) {
            await tx.$executeRaw`INSERT INTO sso_tool_requests (product, request_id, data)
                VALUES (${input.product}, ${input.requestId}, ${JSON.stringify(next)}::jsonb)
                ON CONFLICT (product, request_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`;
            if (event) {
                await tx.$executeRaw`INSERT INTO ai_usage_events (id, user_id, source, request_id, data)
                    VALUES (${randomUUID()}, ${input.userId}, ${input.product}, ${input.requestId}, ${JSON.stringify(event)}::jsonb)
                    ON CONFLICT (source, request_id) DO NOTHING`;
            }
        }
        return { requestId: input.requestId, status: next.status, chargeRequired: false, reservedCredits: 0, chargedCredits: 0 };
    });
}
