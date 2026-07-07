'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Bot } from 'lucide-react';
import { ApiError } from '../lib/api';
import { useAuthStore } from '../stores/auth';
import styles from './login.module.css';

type AuthMode = 'login' | 'register';

function getRegisterProfileError(nickname: string, groupName: string): string {
    if (!nickname && !groupName) {
        return '请填写姓名和组别。';
    }

    if (!nickname) {
        return '请填写姓名。';
    }

    if (!groupName) {
        return '请填写组别。';
    }

    return '';
}

function LoginPageContent() {
    const [mode, setMode] = useState<AuthMode>('login');
    const [account, setAccount] = useState('');
    const [password, setPassword] = useState('');
    const [nickname, setNickname] = useState('');
    const [groupName, setGroupName] = useState('');
    const [inviteCode, setInviteCode] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const router = useRouter();
    const searchParams = useSearchParams();
    const { login, register } = useAuthStore();
    const redirectTarget = searchParams.get('redirect') || '/';
    const isRegister = mode === 'register';

    const setModeAndResetError = (nextMode: AuthMode) => {
        setMode(nextMode);
        setError('');
    };

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        setError('');

        if (isRegister) {
            const profileError = getRegisterProfileError(nickname, groupName);
            if (profileError) {
                setError(profileError);
                return;
            }
        }

        setLoading(true);

        try {
            if (mode === 'login') {
                await login(account, password);
            } else {
                await register(account, password, inviteCode, nickname, groupName);
            }

            router.push(redirectTarget);
        } catch (err) {
            if (err instanceof ApiError) {
                if (err.code === 'INVITE_REQUIRED') {
                    setMode('register');
                    setError('该账号尚未完成成员开通，请填写邀请码、姓名和组别后继续注册。');
                } else if (err.code === 'ACCOUNT_EXISTS_USE_ACTIVATE') {
                    setMode('register');
                    setError('该账号已存在但尚未开通权限，请使用原账号和密码填写邀请码后继续注册。');
                } else if (err.code === 'INVITE_CODE_INVALID') {
                    setError('邀请码无效或已被使用。');
                } else if (err.code === 'PROFILE_NAME_REQUIRED') {
                    setMode('register');
                    setError('注册时必须填写姓名。');
                } else if (err.code === 'PROFILE_GROUP_REQUIRED') {
                    setMode('register');
                    setError('注册时必须填写组别。');
                } else {
                    setError(err.message);
                }
            } else {
                setError(err instanceof Error ? err.message : '操作失败，请稍后重试。');
            }
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className={styles.container}>
            <div className={styles.brandPanel}>
                <div className={styles.brandContent}>
                    <div className={styles.brandLogo}><Bot size={40} /></div>
                    <h1 className={styles.brandTitle}>电商 AI 智能平台</h1>
                    <p className={styles.brandSub}>企业内部使用，新成员通过邀请码完成注册并同步开通成员权限。</p>
                    <div className={styles.features}>
                        <span className={styles.featureTag}>35 个正式版机器人</span>
                        <span className={styles.featureTag}>支持自定义工作流</span>
                        <span className={styles.featureTag}>插件与主站账号同步</span>
                    </div>
                </div>
            </div>

            <div className={styles.formPanel}>
                <div className={styles.formContainer}>
                    <div className={styles.tabs}>
                        <button
                            type="button"
                            className={`${styles.tab} ${mode === 'login' ? styles.tabActive : ''}`}
                            onClick={() => setModeAndResetError('login')}
                        >
                            登录
                        </button>
                        <button
                            type="button"
                            className={`${styles.tab} ${mode === 'register' ? styles.tabActive : ''}`}
                            onClick={() => setModeAndResetError('register')}
                        >
                            注册
                        </button>
                    </div>

                    <form onSubmit={handleSubmit} className={styles.form}>
                        <div className={styles.field}>
                            <label className={styles.label}>账号</label>
                            <input
                                type="text"
                                value={account}
                                onChange={(event) => {
                                    setAccount(event.target.value);
                                    if (error) setError('');
                                }}
                                placeholder="请输入账号"
                                required
                                className={styles.input}
                            />
                        </div>

                        {isRegister ? (
                            <>
                                <div className={styles.field}>
                                    <label className={styles.label}>姓名</label>
                                    <input
                                        type="text"
                                        value={nickname}
                                        onChange={(event) => {
                                            setNickname(event.target.value);
                                            if (error) setError('');
                                        }}
                                        placeholder="请输入姓名"
                                        required
                                        className={styles.input}
                                    />
                                </div>

                                <div className={styles.field}>
                                    <label className={styles.label}>组别</label>
                                    <input
                                        type="text"
                                        value={groupName}
                                        onChange={(event) => {
                                            setGroupName(event.target.value);
                                            if (error) setError('');
                                        }}
                                        placeholder="请输入组别"
                                        required
                                        className={styles.input}
                                    />
                                </div>
                            </>
                        ) : null}

                        <div className={styles.field}>
                            <label className={styles.label}>密码</label>
                            <input
                                type="password"
                                value={password}
                                onChange={(event) => {
                                    setPassword(event.target.value);
                                    if (error) setError('');
                                }}
                                placeholder={mode === 'login' ? '请输入密码' : '请输入至少 6 位密码'}
                                required
                                className={styles.input}
                            />
                        </div>

                        {isRegister ? (
                            <div className={styles.field}>
                                <label className={styles.label}>邀请码</label>
                                <input
                                    type="text"
                                    value={inviteCode}
                                    onChange={(event) => {
                                        setInviteCode(event.target.value.toUpperCase());
                                        if (error) setError('');
                                    }}
                                    placeholder="请输入管理员发放的邀请码"
                                    required
                                    className={styles.input}
                                />
                            </div>
                        ) : null}

                        {isRegister ? (
                            <p className={styles.switchHint}>
                                邀请码为一次性凭证。注册时请填写邀请码、姓名与组别。
                            </p>
                        ) : null}

                        {error ? <p className={styles.error}>{error}</p> : null}

                        <button type="submit" className={styles.submitBtn} disabled={loading}>
                            {loading ? '提交中...' : mode === 'login' ? '登录' : '注册并进入'}
                        </button>

                        <p className={styles.switchHint}>
                            {mode === 'login' ? '还没有账号？' : '已经有账号？'}
                            <button
                                type="button"
                                className={styles.switchBtn}
                                onClick={() => setModeAndResetError(mode === 'login' ? 'register' : 'login')}
                            >
                                {mode === 'login' ? '去注册' : '返回登录'}
                            </button>
                        </p>
                    </form>
                </div>
            </div>
        </div>
    );
}

export default function LoginPage() {
    return (
        <Suspense>
            <LoginPageContent />
        </Suspense>
    );
}
