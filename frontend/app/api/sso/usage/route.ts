import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError, errorResponse } from '@/app/lib/auth';
import { prisma } from '@/app/lib/prisma';
import { readServerEnv } from '@/app/lib/server-env';
import { recordUsage } from '@/app/lib/usage-ledger';

const tokens = z.number().int().min(0).max(1_000_000_000).nullable();
const schema = z.object({
    userId: z.string().min(1).max(100), requestId: z.string().min(1).max(200),
    provider: z.string().min(1).max(100), model: z.string().min(1).max(200),
    status: z.enum(['completed', 'failed', 'interrupted']),
    inputTokens: tokens, outputTokens: tokens, totalTokens: tokens,
    cachedInputTokens: tokens.default(null), cacheWriteTokens: tokens.default(null), reasoningTokens: tokens.default(null),
    tokenBasis: z.enum(['reported', 'estimated', 'missing']),
    amount: z.number().finite().min(0).max(1_000_000).nullable().optional(),
    currency: z.enum(['USD', 'CNY']).nullable().optional(),
    costBasis: z.enum(['actual', 'estimated', 'missing']).optional(),
    upstreamRequestId: z.string().max(200).nullable().optional(),
}).strict().superRefine((v, ctx) => {
    if (v.amount != null && (!v.currency || !v.costBasis || v.costBasis === 'missing')) ctx.addIssue({ code: 'custom', message: '金额必须附带币种和计价依据。' });
    if (v.amount == null && v.costBasis && v.costBasis !== 'missing') ctx.addIssue({ code: 'custom', message: '缺少金额。' });
    if (v.inputTokens !== null && (v.cachedInputTokens ?? 0) + (v.cacheWriteTokens ?? 0) > v.inputTokens) ctx.addIssue({ code: 'custom', message: '缓存 Token 超过输入 Token。' });
    if (v.inputTokens !== null && v.outputTokens !== null && v.totalTokens !== v.inputTokens + v.outputTokens) ctx.addIssue({ code: 'custom', message: 'Token 总量不一致。' });
    if (v.tokenBasis === 'missing' && [v.inputTokens, v.outputTokens, v.totalTokens].some(n => n !== null)) ctx.addIssue({ code: 'custom', message: '缺失用量必须为 null。' });
});

export async function POST(req: Request) {
    try {
        // Dedicated server credentials, never a browser token or a shared client-supplied source field.
        const tool = req.headers.get('x-usage-tool') ?? '';
        const configured = JSON.parse(readServerEnv('SSO_USAGE_SECRETS') || '{}') as Record<string, string>;
        const expected = Object.hasOwn(configured, tool) ? configured[tool] : undefined;
        const supplied = req.headers.get('x-usage-secret') ?? '';
        if (!/^[a-z0-9-]{1,60}$/.test(tool) || typeof expected !== 'string' || expected.length < 32
            || Buffer.byteLength(expected) !== Buffer.byteLength(supplied)
            || !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) throw new AppError('工具鉴权失败。', 401);
        const text = await req.text();
        if (text.length > 16384) throw new AppError('用量记录过大。', 413);
        let json: unknown;
        try { json = JSON.parse(text); } catch { throw new AppError('JSON 格式无效。'); }
        const event = schema.parse(json);
        const user = await prisma.user.findUnique({ where: { id: event.userId }, select: { id: true } });
        if (!user) throw new AppError('员工账号不存在。', 404);
        const accepted = await recordUsage({ ...event, source: `sso:${tool}` });
        return Response.json({ success: true, accepted });
    } catch (error) { return errorResponse(error); }
}
