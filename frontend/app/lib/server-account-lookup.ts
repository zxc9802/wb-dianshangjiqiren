import { AppError } from './auth';

type AccountLookupClient = {
    user: {
        findUnique: (args: { where: { email: string }; select: Record<string, unknown> }) => Promise<any>;
        findMany: (args: { where: { nickname: string }; select: Record<string, unknown>; take: number }) => Promise<any[]>;
        findFirst: (args: { where: Record<string, unknown>; select: { id: true } }) => Promise<{ id: string } | null>;
    };
};

export async function findUserByLoginAccount<T extends Record<string, unknown>>(
    client: AccountLookupClient,
    account: string,
    select: T,
) {
    const normalized = account.trim();
    if (!normalized) {
        return null;
    }

    const byEmail = await client.user.findUnique({
        where: { email: normalized },
        select,
    });
    if (byEmail) {
        return byEmail;
    }

    const matches = await client.user.findMany({
        where: { nickname: normalized },
        select,
        take: 2,
    });
    return matches.length === 1 ? matches[0] : null;
}

export async function assertLoginAccountAvailable(
    client: AccountLookupClient,
    account: string,
    exceptUserId?: string,
): Promise<void> {
    const normalized = account.trim();
    if (!normalized) {
        throw new AppError('请填写账号名称。', 400);
    }

    const existing = await client.user.findFirst({
        where: {
            ...(exceptUserId ? { id: { not: exceptUserId } } : {}),
            OR: [
                { email: normalized },
                { nickname: normalized },
            ],
        },
        select: { id: true },
    });

    if (existing) {
        throw new AppError('该账号名称已被使用。', 409, 'ACCOUNT_EXISTS');
    }
}
