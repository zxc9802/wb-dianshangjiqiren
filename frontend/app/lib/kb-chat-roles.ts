export interface KbChatRoleDefinition {
    roleKey: string;
    name: string;
    description: string;
}

export interface KbChatRoleAccessSummary {
    mode: 'all' | 'selected';
    roleKeys: string[];
}

export const DEFAULT_KB_CHAT_ROLE_ACCESS: KbChatRoleAccessSummary = {
    mode: 'all',
    roleKeys: [],
};

export const KB_CHAT_ROLES: KbChatRoleDefinition[] = [
    { roleKey: 'product', name: '产品岗', description: '选品、定价、机会判断' },
    { roleKey: 'video', name: '视频岗', description: '脚本、拍摄、内容策划' },
    { roleKey: 'operation', name: '运营岗', description: '店铺、流量、转化分析' },
    { roleKey: 'bd', name: 'BD/达人岗', description: '达人建联、合作策略' },
    { roleKey: 'live', name: '直播岗', description: '人货场、话术、节奏' },
    { roleKey: 'management', name: '管理层', description: '战略、资源、组织决策' },
    { roleKey: 'tech', name: '技术岗', description: '系统、工具、效率提升' },
    { roleKey: 'new', name: '新员工', description: '快速上手公司方法论' },
];

const KB_CHAT_ROLE_KEY_SET = new Set(KB_CHAT_ROLES.map((role) => role.roleKey));

export function isKbChatRoleKey(roleKey: string): boolean {
    return KB_CHAT_ROLE_KEY_SET.has(roleKey);
}

export function canAccessKbChatRole(summary: KbChatRoleAccessSummary | undefined, roleKey: string): boolean {
    if (!summary || summary.mode === 'all') return true;
    return summary.roleKeys.includes(roleKey);
}

export function listAllowedKbChatRoles(summary: KbChatRoleAccessSummary | undefined): KbChatRoleDefinition[] {
    if (!summary || summary.mode === 'all') return KB_CHAT_ROLES;
    return KB_CHAT_ROLES.filter((role) => summary.roleKeys.includes(role.roleKey));
}
