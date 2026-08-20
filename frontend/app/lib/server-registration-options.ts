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

export async function assertActiveRegistrationOptions(
    client: RegistrationOptionClient,
    nickname: string,
    groupName: string,
): Promise<void> {
    const matches = await client.registrationOption.findMany({
        where: {
            isActive: true,
            OR: [
                { kind: 'name', label: nickname },
                { kind: 'group', label: groupName },
            ],
        },
        select: { kind: true, label: true },
    });
    const hasName = matches.some((item) => item.kind === 'name' && item.label === nickname);
    const hasGroup = matches.some((item) => item.kind === 'group' && item.label === groupName);
    if (!hasName || !hasGroup) {
        throw new AppError('姓名或组别选项已失效，请重新选择。', 400, 'REGISTRATION_OPTION_INVALID');
    }
}
