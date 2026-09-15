import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextRequest } from 'next/server';
import { errorResponse, getAuthUser } from './auth';

export const usageContext = new AsyncLocalStorage<{ userId: string; source: string; botId?: string; botName?: string }>();

export function setUsageBot(botId: string, botName: string) {
    const context = usageContext.getStore();
    if (context) Object.assign(context, { botId, botName });
}

export function withUsage<T extends unknown[]>(handler: (req: NextRequest, ...args: T) => Promise<Response>) {
    return async (req: NextRequest, ...args: T): Promise<Response> => {
        try {
            const user = await getAuthUser(req);
            return await usageContext.run({ userId: user.id, source: 'main' }, () => handler(req, ...args));
        } catch (error) {
            return errorResponse(error);
        }
    };
}
