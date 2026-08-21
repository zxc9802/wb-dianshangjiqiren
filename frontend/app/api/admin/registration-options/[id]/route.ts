import { NextRequest } from 'next/server';
import { z } from 'zod';
import { AppError, errorResponse, getAuthUser } from '../../../../lib/auth';
import { prisma } from '../../../../lib/prisma';

const updateOptionSchema = z.object({ isActive: z.boolean() });

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        await getAuthUser(req, { requireAdmin: true });
        const { id } = await params;
        const data = updateOptionSchema.parse(await req.json());
        const result = await prisma.registrationOption.updateMany({
            where: { id },
            data,
        });
        if (result.count === 0) {
            throw new AppError('Registration option not found.', 404, 'REGISTRATION_OPTION_NOT_FOUND');
        }
        const option = await prisma.registrationOption.findUnique({ where: { id } });
        if (!option) {
            throw new AppError('Registration option not found.', 404, 'REGISTRATION_OPTION_NOT_FOUND');
        }
        return Response.json({ success: true, data: option });
    } catch (error) {
        return errorResponse(error);
    }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        await getAuthUser(req, { requireAdmin: true });
        const { id } = await params;
        const result = await prisma.registrationOption.deleteMany({
            where: { id },
        });
        if (result.count === 0) {
            throw new AppError('Registration option not found.', 404, 'REGISTRATION_OPTION_NOT_FOUND');
        }
        return Response.json({ success: true });
    } catch (error) {
        return errorResponse(error);
    }
}
