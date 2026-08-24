import type { Prisma } from '@prisma/client';
import { AppError } from './auth';
import { prisma } from './prisma';

type RegistrationOptionClient = Pick<Prisma.TransactionClient, 'registrationOption'>;

export async function listActiveRegistrationOptions(client: RegistrationOptionClient = prisma) {
    const options = await client.registrationOption.findMany({
        where: { isActive: true },
        select: { kind: true, label: true },
        orderBy: [{ kind: 'asc' }, { label: 'asc' }],
    });
    return {
        names: options.filter((item) => item.kind === 'name').map((item) => item.label),
        groups: options.filter((item) => item.kind === 'group').map((item) => item.label),
    };
}

export async function assertActiveGroupOption(
    client: RegistrationOptionClient,
    groupName: string,
): Promise<void> {
    const normalized = groupName.trim();
    if (!normalized) {
        return;
    }

    const match = await client.registrationOption.findFirst({
        where: {
            isActive: true,
            kind: 'group',
            label: normalized,
        },
        select: { id: true },
    });
    if (!match) {
        throw new AppError('组别选项已失效，请重新选择。', 400, 'REGISTRATION_OPTION_INVALID');
    }
}
