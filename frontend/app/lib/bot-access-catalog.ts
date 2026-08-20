import { BUILTIN_BOTS } from './builtin-bots';

export type OfficialBotEntryKind = 'builtin' | 'tool';

export interface OfficialBotCatalogEntry {
    botKey: string;
    name: string;
    category: string;
    entryKind: OfficialBotEntryKind;
}

const INDEPENDENT_TOOLS: OfficialBotCatalogEntry[] = [
    { botKey: 'kb-chat', name: '起芽知识库机器人', category: '管理工具', entryKind: 'tool' },
    { botKey: 'copywriting-agent', name: '老黄 AI 文案总控', category: '电商工具', entryKind: 'tool' },
    { botKey: 'buyer-show', name: '买家秀智能体', category: '绘图机器人', entryKind: 'tool' },
    { botKey: 'detail-image-agent', name: '店铺图片工具', category: '绘图机器人', entryKind: 'tool' },
    { botKey: 'image-generator', name: '电商图片生成机器人', category: '绘图机器人', entryKind: 'tool' },
    { botKey: 'video-workbench', name: '视频工作台', category: '视频工作台', entryKind: 'tool' },
    { botKey: 'tiktok-studio', name: 'TikTok Studio', category: '视频工作台', entryKind: 'tool' },
];

export const OFFICIAL_BOT_CATALOG: OfficialBotCatalogEntry[] = [
    ...BUILTIN_BOTS.map((bot) => ({
        botKey: bot.routeId,
        name: bot.name,
        category: bot.category,
        entryKind: 'builtin' as const,
    })),
    ...INDEPENDENT_TOOLS,
];

const OFFICIAL_BOT_KEY_SET = new Set(OFFICIAL_BOT_CATALOG.map((bot) => bot.botKey));

export function isOfficialBotKey(botKey: string): boolean {
    return OFFICIAL_BOT_KEY_SET.has(botKey);
}

export function getOfficialBot(botKey: string): OfficialBotCatalogEntry | undefined {
    return OFFICIAL_BOT_CATALOG.find((bot) => bot.botKey === botKey);
}
