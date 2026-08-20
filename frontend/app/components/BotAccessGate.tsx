'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ShieldX } from 'lucide-react';
import { canAccessOfficialBot } from '../lib/bot-access';
import { useAuthStore } from '../stores/auth';
import styles from './BotAccessGate.module.css';

export default function BotAccessGate({ botKey, children }: { botKey: string; children: ReactNode }) {
    const router = useRouter();
    const pathname = usePathname();
    const { user, isAuthenticated, loadUser } = useAuthStore();
    const [authReady, setAuthReady] = useState(false);

    useEffect(() => {
        let active = true;
        void loadUser().finally(() => {
            if (active) setAuthReady(true);
        });
        return () => {
            active = false;
        };
    }, [loadUser]);

    useEffect(() => {
        if (authReady && !isAuthenticated) {
            router.replace(`/login?redirect=${encodeURIComponent(pathname)}`);
        }
    }, [authReady, isAuthenticated, pathname, router]);

    if (!authReady || !isAuthenticated || !user) {
        return <main className={styles.denied}><div className={styles.loading}>正在检查账号权限...</div></main>;
    }

    if (!canAccessOfficialBot(user.botAccess, botKey)) {
        return (
            <main className={styles.denied}>
                <div className={styles.card}>
                    <ShieldX size={36} />
                    <h1>此智能体暂未开放</h1>
                    <p>管理员未向当前账号开放此智能体。</p>
                    <button type="button" onClick={() => router.push('/')}>返回首页</button>
                </div>
            </main>
        );
    }

    return children;
}
