import {
    GENERIC_CHAT_BOT_ID,
    QIYA_ENTERPRISE_MANAGEMENT_BOT_ID,
    VIDEO_BREAKDOWN_BOT_ID,
} from './builtin-bots';
import { RESPONSE_MODEL_OPTIONS } from './chat-models';

export const MODEL_ACCESS_SITE_KEYS = [
    'main-general',
    'growth-assistant',
    'video-breakdown',
    'kb-chat',
] as const;

export type ModelAccessSiteKey = typeof MODEL_ACCESS_SITE_KEYS[number];

export interface ModelAccessModelDefinition {
    modelKey: string;
    label: string;
}

export interface ModelAccessSiteDefinition {
    siteKey: ModelAccessSiteKey;
    name: string;
    description: string;
    models: readonly ModelAccessModelDefinition[];
}

export interface ModelAccessSiteSummary {
    siteKey: ModelAccessSiteKey;
    mode: 'selected';
    modelKeys: string[];
}

export interface ModelAccessSummary {
    sites: ModelAccessSiteSummary[];
}

const MAIN_CHAT_MODELS: readonly ModelAccessModelDefinition[] = RESPONSE_MODEL_OPTIONS.map((model) => ({
    modelKey: model.value,
    label: model.label,
}));

const KB_CHAT_MODELS: readonly ModelAccessModelDefinition[] = [
    { modelKey: 'gemini-3.1-pro-preview', label: 'Claude Opus 4.6' },
    { modelKey: 'yunwu-gemini-3-flash-preview', label: 'Gemini 快速' },
    { modelKey: 'yunwu-gpt-5.4', label: 'GPT-5.5' },
    { modelKey: 'yunwu-gpt-5.6', label: 'GPT-5.6' },
];

export const MODEL_ACCESS_SITES: readonly ModelAccessSiteDefinition[] = [
    {
        siteKey: 'main-general',
        name: '主站通用输入框',
        description: '首页通用聊天输入框与通用聊天会话。',
        models: MAIN_CHAT_MODELS,
    },
    {
        siteKey: 'growth-assistant',
        name: '起芽成长特助',
        description: '起芽成长特助的聊天会话。',
        models: MAIN_CHAT_MODELS,
    },
    {
        siteKey: 'video-breakdown',
        name: '视频拆解导演',
        description: '视频拆解导演的聊天会话。',
        models: MAIN_CHAT_MODELS,
    },
    {
        siteKey: 'kb-chat',
        name: '起芽知识库机器人',
        description: '独立知识库网站的回答模型。',
        models: KB_CHAT_MODELS,
    },
];

export const DEFAULT_MODEL_ACCESS: ModelAccessSummary = { sites: [] };

const MODEL_ACCESS_SITE_KEY_SET = new Set<string>(MODEL_ACCESS_SITE_KEYS);

export function isModelAccessSiteKey(value: unknown): value is ModelAccessSiteKey {
    return typeof value === 'string' && MODEL_ACCESS_SITE_KEY_SET.has(value);
}

export function getModelAccessSite(siteKey: ModelAccessSiteKey): ModelAccessSiteDefinition {
    return MODEL_ACCESS_SITES.find((site) => site.siteKey === siteKey) as ModelAccessSiteDefinition;
}

export function getModelAccessSiteKeyForBot(botKey: string): ModelAccessSiteKey | null {
    if (botKey === GENERIC_CHAT_BOT_ID) return 'main-general';
    if (botKey === QIYA_ENTERPRISE_MANAGEMENT_BOT_ID) return 'growth-assistant';
    if (botKey === VIDEO_BREAKDOWN_BOT_ID) return 'video-breakdown';
    return null;
}

export function isModelKeyForSite(siteKey: ModelAccessSiteKey, modelKey: string): boolean {
    return getModelAccessSite(siteKey).models.some((model) => model.modelKey === modelKey);
}

export function parseModelAccessSummary(value: unknown): ModelAccessSummary {
    if (!value || typeof value !== 'object' || !Array.isArray((value as { sites?: unknown }).sites)) {
        return DEFAULT_MODEL_ACCESS;
    }

    const sites: ModelAccessSiteSummary[] = [];
    for (const candidate of (value as { sites: unknown[] }).sites) {
        if (!candidate || typeof candidate !== 'object') continue;
        const siteKey = (candidate as { siteKey?: unknown }).siteKey;
        const mode = (candidate as { mode?: unknown }).mode;
        const modelKeys = (candidate as { modelKeys?: unknown }).modelKeys;
        if (!isModelAccessSiteKey(siteKey) || mode !== 'selected' || !Array.isArray(modelKeys)) continue;

        sites.push({
            siteKey,
            mode: 'selected',
            modelKeys: [...new Set(modelKeys.filter((modelKey): modelKey is string => (
                typeof modelKey === 'string' && isModelKeyForSite(siteKey, modelKey)
            )))],
        });
    }

    return { sites };
}

export function getModelAccessSiteSummary(
    summary: ModelAccessSummary | undefined,
    siteKey: ModelAccessSiteKey,
): ModelAccessSiteSummary | null {
    return summary?.sites.find((site) => site.siteKey === siteKey) || null;
}

export function canUseModel(
    summary: ModelAccessSummary | undefined,
    siteKey: ModelAccessSiteKey,
    modelKey: string,
): boolean {
    const site = getModelAccessSiteSummary(summary, siteKey);
    return !site || site.modelKeys.includes(modelKey);
}

export function listAllowedModelKeys(
    summary: ModelAccessSummary | undefined,
    siteKey: ModelAccessSiteKey,
): string[] {
    const site = getModelAccessSite(siteKey);
    return site.models
        .filter((model) => canUseModel(summary, siteKey, model.modelKey))
        .map((model) => model.modelKey);
}
