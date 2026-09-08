import { usageContext } from '../services/usage-context';
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AppError } from './error';
import { prisma } from '../utils/prisma';

export interface AuthRequest extends Request {
    userId?: string;
    userRole?: string;
}

export async function authMiddleware(req: AuthRequest, _res: Response, next: NextFunction) {
    try {
        const jwtSecret = process.env.JWT_SECRET?.trim();
        if (!jwtSecret) {
            throw new AppError('JWT_SECRET is not configured.', 500);
        }

        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            throw new AppError('Please log in first.', 401);
        }

        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, jwtSecret) as { userId: string };

        const user = await prisma.user.findUnique({
            where: { id: decoded.userId },
            select: { id: true, role: true, accessGrantedAt: true },
        });

        if (!user) {
            throw new AppError('Account not found.', 401);
        }

        const hasAccess = user.role === 'admin' || Boolean(user.accessGrantedAt);
        if (!hasAccess) {
            throw new AppError('Invite code required.', 403);
        }

        req.userId = user.id;
        req.userRole = user.role;
        usageContext.run({ userId: user.id, source: 'main' }, () => next());
    } catch (error) {
        if (error instanceof AppError) {
            next(error);
            return;
        }
        next(new AppError('Login expired. Please sign in again.', 401));
    }
}

