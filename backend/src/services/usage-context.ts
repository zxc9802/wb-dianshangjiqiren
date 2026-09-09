import { AsyncLocalStorage } from 'node:async_hooks';

export const usageContext = new AsyncLocalStorage<{ userId: string; source: string }>();
