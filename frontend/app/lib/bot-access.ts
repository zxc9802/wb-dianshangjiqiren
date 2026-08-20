export interface BotAccessSummary {
    mode: 'all' | 'selected';
    botKeys: string[];
}

export const DEFAULT_BOT_ACCESS: BotAccessSummary = { mode: 'all', botKeys: [] };

export function canAccessOfficialBot(summary: BotAccessSummary | undefined, botKey: string): boolean {
    if (!summary || summary.mode === 'all') return true;
    return summary.botKeys.includes(botKey);
}

export function findDeniedBotKeys(summary: BotAccessSummary | undefined, botKeys: string[]): string[] {
    return [...new Set(botKeys)].filter((botKey) => !canAccessOfficialBot(summary, botKey));
}
