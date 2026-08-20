import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AppError, errorResponse, getAuthUser } from '../../../lib/auth';
import { prisma } from '../../../lib/prisma';

const createOptionSchema = z.object({
    kind: z.enum(['name', 'group']),
    label: z.string().trim().min(1).max(50),
});

const optionSelect = {
    id: true,
    kind: true,
    label: true,
    isActive: true,
    createdAt: true,
    updatedAt: true,
} as const;

export async function GET(req: NextRequest) {
    try {
        await getAuthUser(req, { requireAdmin: true });
        const options = await prisma.registrationOption.findMany({
            select: optionSelect,
            orderBy: [{ kind: 'asc' }, { label: 'asc' }],
        });
        return Response.json({ success: true, data: options });
    } catch (error) {
        return errorResponse(error);
    }
}

export async function POST(req: NextRequest) {
    try {
        await getAuthUser(req, { requireAdmin: true });
        const data = createOptionSchema.parse(await req.json());
        const option = await prisma.registrationOption.create({
            data,
            select: optionSelect,
        });
        return Response.json({ success: true, data: option }, { status: 201 });
    } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            return errorResponse(new AppError('Registration option already exists.', 409, 'REGISTRATION_OPTION_EXISTS'));
        }
        return errorResponse(error);
    }
}
