'use client';

import { useEffect, useRef, useState } from 'react';
import { Share2, Loader2, Copy, X } from 'lucide-react';
import { api } from '../lib/api';
import styles from './ChatShareControls.module.css';

interface Props {
    conversationId: string | null;
    messageIds: string[];
    selection: Set<string> | null;
    disabled: boolean;
    onStart: () => Promise<void>;
    onSelectionChange: (selection: Set<string> | null) => void;
}

export default function ChatShareControls({ conversationId, messageIds, selection, disabled, onStart, onSelectionChange }: Props) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [url, setUrl] = useState('');
    const [copied, setCopied] = useState(false);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);

    async function start() {
        setBusy(true); setError(''); setUrl(''); setCopied(false);
        try { await onStart(); }
        catch (err) { setError(err instanceof Error ? err.message : '读取聊天记录失败，请重试。'); }
        finally { setBusy(false); }
    }

    async function create() {
        if (!conversationId || !selection?.size) return;
        setBusy(true); setError('');
        try {
            const result = await api.createChatShare(conversationId, Array.from(selection));
            if (!mounted.current) return;
            setUrl(new URL(result.data.path, window.location.origin).href);
            onSelectionChange(null);
        } catch (err) { setError(err instanceof Error ? err.message : '生成分享链接失败，请重试。'); }
        finally { setBusy(false); }
    }

    async function copy() {
        try { await navigator.clipboard.writeText(url); setCopied(true); }
        catch { setError('自动复制失败，请选中下方链接手动复制。'); }
    }

    function close() { onSelectionChange(null); setUrl(''); setError(''); setCopied(false); }

    return <>
        <button className={styles.trigger} onClick={() => void start()} disabled={disabled || busy || !conversationId || selection !== null}>
            {busy && !selection ? <Loader2 size={14} className={styles.spin} /> : <Share2 size={14} />} 分享聊天
        </button>
        {(selection !== null || error || url) && <section className={styles.bar} aria-label="分享聊天记录">
            <div className={styles.row}>
                <strong>{url ? '分享链接已生成' : `已选 ${selection?.size ?? 0} 条消息`}</strong>
                <button aria-label="关闭分享" onClick={close} disabled={busy}><X size={16} /></button>
            </div>
            <p>获得链接的人无需登录即可查看所选内容。</p>
            {error && <p className={styles.error} role="alert">{error}</p>}
            {url ? <>
                <input aria-label="聊天分享链接" readOnly value={url} onFocus={e => e.target.select()} />
                <div className={styles.row}>
                    <a href={url} target="_blank" rel="noreferrer">查看分享</a>
                    <button className={styles.primary} onClick={() => void copy()}><Copy size={14} />{copied ? '已复制' : '复制链接'}</button>
                </div>
                {copied && <span role="status">链接已复制，可以转发给其他人。</span>}
            </> : selection !== null && <div className={styles.row}>
                <button disabled={busy} onClick={() => onSelectionChange(selection.size === messageIds.length ? new Set() : new Set(messageIds))}>
                    {selection.size === messageIds.length && messageIds.length ? '取消全选' : '全选'}
                </button>
                <button className={styles.primary} disabled={busy || selection.size === 0 || selection.size > 200 || disabled} onClick={() => void create()}>
                    {busy ? '生成中…' : selection.size > 200 ? '最多选择 200 条' : '生成分享链接'}
                </button>
            </div>}
        </section>}
    </>;
}
