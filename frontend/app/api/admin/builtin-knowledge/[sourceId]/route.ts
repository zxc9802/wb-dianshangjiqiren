import { NextRequest } from 'next/server';
import { AppError, errorResponse, getAuthUser } from '../../../../lib/auth';

function assertBuiltinKnowledgeHidden(): never {
    throw new AppError('知识源不存在', 404);
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ sourceId: string }> }) {
    try {
        await getAuthUser(req, { requireAdmin: true });
        await params;
        assertBuiltinKnowledgeHidden();
    } catch (err) {
        return errorResponse(err);
    }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ sourceId: string }> }) {
    try {
        await getAuthUser(req, { requireAdmin: true });
        await params;
        assertBuiltinKnowledgeHidden();
    } catch (err) {
        return errorResponse(err);
    }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ sourceId: string }> }) {
    try {
        await getAuthUser(req, { requireAdmin: true });
        await params;
        assertBuiltinKnowledgeHidden();
    } catch (err) {
        return errorResponse(err);
    }
}
