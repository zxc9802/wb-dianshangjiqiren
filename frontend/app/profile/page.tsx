'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Settings, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { useAuthStore } from '../stores/auth';
import styles from './profile.module.css';

export default function ProfilePage() {
    const router = useRouter();
    const { user, logout } = useAuthStore();
    const [isEditing, setIsEditing] = useState(false);
    const [nickname, setNickname] = useState('');
    const [isSaving, setIsSaving] = useState(false);
    const [feedback, setFeedback] = useState<{ type: 'error' | 'success'; message: string } | null>(null);

    useEffect(() => {
        if (!user && typeof window !== 'undefined') {
            const stored = localStorage.getItem('user');
            if (!stored) {
                router.push('/login');
            }
        }
    }, [router, user]);

    const handleSaveNickname = async () => {
        const nextNickname = nickname.trim();
        if (!nextNickname || !user || isSaving) return;

        setIsSaving(true);
        setFeedback(null);

        try {
            const response = await api.updateProfile({ nickname: nextNickname });
            const nextUser = response.data;
            localStorage.setItem('user', JSON.stringify(nextUser));
            useAuthStore.setState({ user: nextUser });
            setNickname(nextUser.nickname);
            setIsEditing(false);
            setFeedback({ type: 'success', message: '姓名已保存。' });
        } catch (error) {
            setFeedback({ type: 'error', message: error instanceof Error ? error.message : '姓名保存失败。' });
        } finally {
            setIsSaving(false);
        }
    };

    if (!user) {
        return null;
    }

    return (
        <div className={styles.layout}>
            <aside className={styles.sidebar}>
                <button className={styles.backBtn} onClick={() => router.push('/')}>
                    <ArrowLeft size={16} />
                    返回首页
                </button>

                <div className={styles.avatarSection}>
                    <div className={styles.avatar}>
                        {(user.nickname || user.account).slice(0, 1).toUpperCase()}
                    </div>
                    <h3 className={styles.sidebarName}>{user.nickname || user.account}</h3>
                    <p className={styles.sidebarPhone}>{user.account}</p>
                </div>

                <nav className={styles.sidebarNav}>
                    <button className={`${styles.navItem} ${styles.navActive}`} type="button">
                        <Settings size={16} />
                        账号设置
                    </button>
                    {user.role === 'admin' && (
                        <button className={styles.navItem} type="button" onClick={() => router.push('/admin/invite-codes')}>
                            <ShieldCheck size={16} />
                            邀请码管理
                        </button>
                    )}
                </nav>

                <button className={styles.logoutBtn} onClick={logout}>退出登录</button>
            </aside>

            <main className={styles.content}>
                <h2 className={styles.pageTitle}>
                    <Settings size={20} />
                    账号设置
                </h2>

                {feedback && (
                    <div className={feedback.type === 'success' ? styles.successText : styles.errorText}>
                        {feedback.message}
                    </div>
                )}

                <div className={styles.settingsCard}>
                    <div className={styles.settingRow}>
                        <span className={styles.settingLabel}>姓名</span>
                        {isEditing ? (
                            <div className={styles.editRow}>
                                <input
                                    type="text"
                                    value={nickname}
                                    onChange={(event) => {
                                        setNickname(event.target.value);
                                        setFeedback(null);
                                    }}
                                    placeholder="请输入姓名"
                                    className={styles.editInput}
                                    disabled={isSaving}
                                />
                                <button className={styles.saveBtn} onClick={() => void handleSaveNickname()} disabled={isSaving || !nickname.trim()}>
                                    {isSaving ? '保存中...' : '保存'}
                                </button>
                                <button
                                    className={styles.cancelBtn}
                                    onClick={() => {
                                        setIsEditing(false);
                                        setNickname(user.nickname);
                                        setFeedback(null);
                                    }}
                                    disabled={isSaving}
                                >
                                    取消
                                </button>
                            </div>
                        ) : (
                            <div className={styles.settingValue}>
                                <span>{user.nickname || '-'}</span>
                                <button
                                    className={styles.editBtnSmall}
                                    onClick={() => {
                                        setNickname(user.nickname);
                                        setIsEditing(true);
                                        setFeedback(null);
                                    }}
                                >
                                    修改
                                </button>
                            </div>
                        )}
                    </div>

                    <div className={styles.settingRow}>
                        <span className={styles.settingLabel}>账号</span>
                        <span className={styles.settingValue}>{user.account}</span>
                    </div>

                    <div className={styles.settingRow}>
                        <span className={styles.settingLabel}>组别</span>
                        <span className={styles.settingValue}>{user.groupName || '-'}</span>
                    </div>

                    <div className={styles.settingRow}>
                        <span className={styles.settingLabel}>角色</span>
                        <span className={styles.settingValue}>{user.role === 'admin' ? '管理员' : '成员'}</span>
                    </div>
                </div>
            </main>
        </div>
    );
}
