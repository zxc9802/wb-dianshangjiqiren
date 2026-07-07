import { QIYA_ENTERPRISE_MANAGEMENT_BOT_ID } from './builtin-bots';

export function isQiyaEnterpriseManagementRouteId(routeId: string | number | null | undefined): boolean {
    return String(routeId || '') === QIYA_ENTERPRISE_MANAGEMENT_BOT_ID;
}

export function shouldHideQiyaKnowledgeDocuments(botId: string, botKind: 'builtin' | 'custom'): boolean {
    return botKind === 'builtin' && isQiyaEnterpriseManagementRouteId(botId);
}
