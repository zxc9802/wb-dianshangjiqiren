import { AsyncLocalStorage } from 'node:async_hooks';

export const usageContext = new AsyncLocalStorage<{ userId: string; source: string; botId?: string; botName?: string }>();

export function setUsageBot(botId: string, botName: string) {
    const context = usageContext.getStore();
    if (context) Object.assign(context, { botId, botName });
}
