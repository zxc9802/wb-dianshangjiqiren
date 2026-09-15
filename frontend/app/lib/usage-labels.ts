const toolNames: Record<string, string> = {
    chanpinsheji: '产品设计', sabc: 'SABC', xiaoshou: '销售助手', baokuangaixie: '爆款改写',
    'kb-chat': '起芽知识库机器人', qyzsk: '起芽知识库机器人',
};

export function usageChannelLabel(source: string): string {
    if (source === 'main') return '主站';
    const tool = source.replace(/^sso:/, '');
    return `SSO · ${toolNames[tool] || tool}`;
}

export function usageSourceLabel(event: { source: string; botName?: string | null }): string {
    return event.botName?.trim() || `${usageChannelLabel(event.source)} · 未记录智能体`;
}
