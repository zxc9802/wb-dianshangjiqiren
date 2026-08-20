'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import ImageStudio from '../../components/ImageStudio';
import BotAccessGate from '../../components/BotAccessGate';
import { useAuthStore } from '../../stores/auth';
import styles from './page.module.css';

export default function ImageGeneratorBotPage() {
    const router = useRouter();
    const { isAuthenticated, loadUser } = useAuthStore();

    useEffect(() => {
        loadUser();
    }, [loadUser]);

    return (
        <BotAccessGate botKey="image-generator">
            <div className={styles.container}>
                <header className={styles.header}>
                    <button className={styles.backBtn} onClick={() => router.push('/')}>返回首页</button>
                    <div className={styles.headInfo}>
                        <h1>电商图片生成机器人</h1>
                        <p>独立工具页：上传参考图、设置参数、生成 2K 电商图片并自动保存历史。</p>
                    </div>
                    <button className={styles.historyBtn} onClick={() => router.push('/history/images')}>查看历史</button>
                </header>

                <ImageStudio isAuthenticated={isAuthenticated} onRequireLogin={() => router.push('/login')} />
            </div>
        </BotAccessGate>
    );
}
