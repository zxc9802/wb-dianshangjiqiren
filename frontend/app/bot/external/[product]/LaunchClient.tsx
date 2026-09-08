"use client";
import { useEffect, useRef, useState } from 'react';
export default function LaunchClient({ product }: { product: string }) {
    const started = useRef(false);
    const [error, setError] = useState('');
    useEffect(() => {
        if (started.current) return;
        started.current = true;
        const token = localStorage.getItem('token');
        if (!token) {
            window.location.replace('/login?redirect=' + encodeURIComponent('/bot/external/' + product));
            return;
        }
        fetch('/api/external-sso/' + product + '/start', {
            method: 'POST', headers: { Authorization: 'Bearer ' + token },
        }).then(async response => {
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || '暂时无法进入工具');
            window.location.replace(result.url);
        }).catch(error => setError(error.message));
    }, [product]);
    return <main style={{ padding: 32 }}><p>{error || '正在进入工具…'}</p>
        {error && <button onClick={() => window.location.reload()}>重试</button>}
        <p><a href="/">返回主站</a></p></main>;
}
