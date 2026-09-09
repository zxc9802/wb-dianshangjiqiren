import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AppError, errorResponse, getAuthUser } from '@/app/lib/auth';
import { prisma } from '@/app/lib/prisma';
import { ensureUsageLedger, getUsageRates } from '@/app/lib/usage-ledger';

export async function GET(req: NextRequest) {
    try {
        await getAuthUser(req, { requireAdmin: true });
        const q = req.nextUrl.searchParams;
        const end = new Date(q.get('end') || Date.now());
        const start = new Date(q.get('start') || Date.now() - 30 * 86400000);
        const page = Number(q.get('page') || 1);
        if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end
            || end.getTime() - start.getTime() > 366 * 86400000 || !Number.isSafeInteger(page) || page < 1 || page > 100000) throw new AppError('请选择一年以内的有效时间范围。');
        await ensureUsageLedger();
        const filters = Prisma.sql`e.created_at >= ${start} AND e.created_at < ${end}
            ${q.get('userId') ? Prisma.sql`AND e.user_id = ${q.get('userId')}` : Prisma.empty}
            ${q.get('source') ? Prisma.sql`AND e.source = ${q.get('source')}` : Prisma.empty}
            ${q.get('model') ? Prisma.sql`AND e.data->>'model' = ${q.get('model')}` : Prisma.empty}`;
        const [groups, rows, counts, users, rates, sources] = await Promise.all([
            prisma.$queryRaw(Prisma.sql`SELECT e.user_id AS "userId", u.nickname, u.email, u.group_name AS "groupName",
                e.source, e.data->>'model' AS model, e.data->>'provider' AS provider,
                e.data->>'currency' AS currency, e.data->>'costBasis' AS "costBasis", e.data->>'tokenBasis' AS "tokenBasis",
                COUNT(*)::int AS calls,
                COUNT(*) FILTER (WHERE e.data->>'status' = 'pending')::int AS pending,
                COUNT(*) FILTER (WHERE e.data->>'status' IN ('failed','interrupted'))::int AS failed,
                SUM((e.data->>'inputTokens')::numeric)::float8 AS "inputTokens",
                SUM((e.data->>'outputTokens')::numeric)::float8 AS "outputTokens",
                SUM((e.data->>'cachedInputTokens')::numeric)::float8 AS "cachedInputTokens",
                SUM((e.data->>'totalTokens')::numeric)::float8 AS "totalTokens",
                SUM((e.data->>'amount')::numeric)::float8 AS amount
                FROM ai_usage_events e LEFT JOIN users u ON u.id = e.user_id WHERE ${filters}
                GROUP BY e.user_id, u.nickname, u.email, u.group_name, e.source, e.data->>'model', e.data->>'provider',
                    e.data->>'currency', e.data->>'costBasis', e.data->>'tokenBasis'
                ORDER BY "totalTokens" DESC NULLS LAST, e.user_id`),
            prisma.$queryRaw(Prisma.sql`SELECT e.id, e.created_at AS "createdAt", e.data, u.nickname, u.email
                FROM ai_usage_events e LEFT JOIN users u ON u.id=e.user_id WHERE ${filters}
                ORDER BY e.created_at DESC, e.id DESC LIMIT 50 OFFSET ${(page - 1) * 50}`),
            prisma.$queryRaw<{ total: number }[]>(Prisma.sql`SELECT COUNT(*)::int AS total FROM ai_usage_events e WHERE ${filters}`),
            prisma.user.findMany({ select: { id: true, nickname: true, email: true, groupName: true }, orderBy: { email: 'asc' } }),
            getUsageRates(),
            prisma.$queryRaw`SELECT DISTINCT source FROM ai_usage_events ORDER BY source`,
        ]);
        return Response.json({ groups, rows, total: counts[0].total, users, rates, sources, page });
    } catch (error) { return errorResponse(error); }
}

const rateNumber = z.number().finite().min(0).max(1_000_000);
const rateSchema = z.array(z.object({
    provider: z.string().trim().min(1).max(100), model: z.string().trim().min(1).max(200),
    currency: z.enum(['USD', 'CNY']), inputPerMillion: rateNumber, outputPerMillion: rateNumber,
    cachedPerMillion: rateNumber, cacheWritePerMillion: rateNumber, perCall: rateNumber.optional(),
}).strict()).max(500).refine(rows => new Set(rows.map(row => `${row.provider}/${row.model}`)).size === rows.length, '模型费率不能重复。');

export async function PUT(req: NextRequest) {
    try {
        await getAuthUser(req, { requireAdmin: true });
        const rates = rateSchema.parse(await req.json());
        await prisma.systemSetting.upsert({ where: { key: 'ai_usage_rates' }, create: { key: 'ai_usage_rates', value: JSON.stringify(rates) }, update: { value: JSON.stringify(rates) } });
        return Response.json({ success: true });
    } catch (error) { return errorResponse(error); }
}
