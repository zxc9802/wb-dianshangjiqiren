import { AppError } from './auth';
import {
    DEFAULT_MODEL_ACCESS,
    canUseModel,
    isModelAccessSiteKey,
    isModelKeyForSite,
    type ModelAccessSiteSummary,
    type ModelAccessSummary,
    type ModelAccessSiteKey,
} from './model-access';
import { prisma } from './prisma';

let ensureModelAccessTablesPromise: Promise<void> | null = null;

async function runEnsureModelAccessTables(): Promise<void> {
    await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS user_model_access_policies (
            id text PRIMARY KEY,
            user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            site_key text NOT NULL,
            created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await prisma.$executeRawUnsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS user_model_access_policies_user_id_site_key_key
        ON user_model_access_policies(user_id, site_key)
    `);
    await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS user_model_access_policies_site_key_idx
        ON user_model_access_policies(site_key)
    `);
    await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS user_model_permissions (
            id text PRIMARY KEY,
            policy_id text NOT NULL REFERENCES user_model_access_policies(id) ON DELETE CASCADE,
            model_key text NOT NULL,
            created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await prisma.$executeRawUnsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS user_model_permissions_policy_id_model_key_key
        ON user_model_permissions(policy_id, model_key)
    `);
    await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS user_model_permissions_model_key_idx
        ON user_model_permissions(model_key)
    `);
}

export async function ensureModelAccessTables(): Promise<void> {
    if (!ensureModelAccessTablesPromise) {
        ensureModelAccessTablesPromise = runEnsureModelAccessTables().catch((error) => {
            ensureModelAccessTablesPromise = null;
            throw error;
        });
    }
    await ensureModelAccessTablesPromise;
}

export function normalizeSelectedModelAccessSites(value: unknown): ModelAccessSiteSummary[] {
    if (!Array.isArray(value)) {
        throw new AppError('Model access sites must be an array.', 400, 'INVALID_MODEL_ACCESS');
    }

    const sites: ModelAccessSiteSummary[] = [];
    const seenSites = new Set<string>();
    for (const candidate of value) {
        if (!candidate || typeof candidate !== 'object') {
            throw new AppError('Invalid model access site.', 400, 'INVALID_MODEL_ACCESS');
        }

        const siteKey = (candidate as { siteKey?: unknown }).siteKey;
        const mode = (candidate as { mode?: unknown }).mode;
        const modelKeys = (candidate as { modelKeys?: unknown }).modelKeys;
        if (!isModelAccessSiteKey(siteKey) || mode !== 'selected' || !Array.isArray(modelKeys)) {
            throw new AppError('Invalid model access site.', 400, 'INVALID_MODEL_ACCESS');
        }
        if (seenSites.has(siteKey)) {
            throw new AppError('Duplicate model access site.', 400, 'INVALID_MODEL_ACCESS');
        }

        const normalizedModelKeys = [...new Set(modelKeys)];
        if (normalizedModelKeys.some((modelKey) => (
            typeof modelKey !== 'string' || !isModelKeyForSite(siteKey, modelKey)
        ))) {
            throw new AppError('Unknown model for site.', 400, 'INVALID_MODEL_ACCESS_MODEL');
        }

        seenSites.add(siteKey);
        sites.push({ siteKey, mode: 'selected', modelKeys: normalizedModelKeys as string[] });
    }

    return sites;
}

export async function getUserModelAccessSummary(userId: string, role?: string): Promise<ModelAccessSummary> {
    if (role === 'admin') return DEFAULT_MODEL_ACCESS;

    await ensureModelAccessTables();
    const resolvedRole = role || (await prisma.user.findUnique({
        where: { id: userId },
        select: { role: true },
    }))?.role;
    if (resolvedRole === 'admin') return DEFAULT_MODEL_ACCESS;

    const policies = await prisma.userModelAccessPolicy.findMany({
        where: { userId },
        select: {
            siteKey: true,
            permissions: {
                select: { modelKey: true },
                orderBy: { createdAt: 'asc' },
            },
        },
        orderBy: { createdAt: 'asc' },
    });

    return {
        sites: policies
            .filter((policy): policy is typeof policy & { siteKey: ModelAccessSiteKey } => (
                isModelAccessSiteKey(policy.siteKey)
            ))
            .map((policy) => ({
                siteKey: policy.siteKey,
                mode: 'selected' as const,
                modelKeys: policy.permissions
                    .map((permission) => permission.modelKey)
                    .filter((modelKey) => isModelKeyForSite(policy.siteKey, modelKey)),
            })),
    };
}

export async function assertUserCanUseModel(
    userId: string,
    siteKey: ModelAccessSiteKey,
    modelKey: string,
    role?: string,
): Promise<void> {
    if (!isModelKeyForSite(siteKey, modelKey)) {
        throw new AppError('Unknown model for site.', 400, 'INVALID_MODEL_ACCESS_MODEL');
    }

    const summary = await getUserModelAccessSummary(userId, role);
    if (!canUseModel(summary, siteKey, modelKey)) {
        throw new AppError('管理员未向该账号开放此模型。', 403, 'MODEL_ACCESS_DENIED');
    }
}
