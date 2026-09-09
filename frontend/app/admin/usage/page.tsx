'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '../../stores/auth';
import type { UsageEvent } from '../../lib/usage-ledger';
import type { UsageRate } from '../../lib/usage-values';
import styles from './usage.module.css';

type Group = {
    userId: string; nickname: string; email: string; groupName: string; source: string; model: string; provider: string;
    calls: number; pending: number; failed: number; inputTokens: number | null; outputTokens: number | null;
    cachedInputTokens: number | null; totalTokens: number | null; amount: number | null;
    currency: string | null; costBasis: string | null; tokenBasis: string;
};
type Data = {
    groups: Group[]; rows: { id: string; createdAt: string; nickname: string; email: string; data: UsageEvent }[];
    users: { id: string; nickname: string; email: string }[]; sources: { source: string }[];
    total: number; rates: UsageRate[];
};
const number = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
const money = (value: number | null | undefined, currency?: string | null) => value == null ? '待核算' : `${currency ?? ''} ${value.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')}`;
const basis = (value?: string | null) => value === 'actual' ? '实际扣费' : value === 'estimated' ? '估算' : '待核算';
const toolNames: Record<string, string> = { chanpinsheji: '产品设计', sabc: 'SABC', xiaoshou: '销售助手', baokuangaixie: '爆款改写' };
const sourceLabel = (source: string) => source === 'main' ? '主站' : `SSO · ${toolNames[source.replace(/^sso:/, '')] || source.replace(/^sso:/, '')}`;
const statuses: Record<string, string> = { pending: '待完成 / 待核对', completed: '已完成', failed: '失败', interrupted: '中断' };
const dateInput = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export default function UsagePage() {
    const { user, token, isLoading, loadUser } = useAuthStore();
    const router = useRouter();
    const [start, setStart] = useState(() => dateInput(new Date(Date.now() - 29 * 86400000)));
    const [end, setEnd] = useState(() => dateInput(new Date()));
    const [employee, setEmployee] = useState('');
    const [source, setSource] = useState('');
    const [model, setModel] = useState('');
    const [page, setPage] = useState(1);
    const [data, setData] = useState<Data | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [rates, setRates] = useState<UsageRate[]>([]);
    const [editingRates, setEditingRates] = useState(false);
    const [saved, setSaved] = useState('');
    useEffect(() => { void loadUser(); }, [loadUser]);
    useEffect(() => {
        if (!isLoading && user?.role !== 'admin') router.replace(user ? '/' : '/login');
    }, [isLoading, user, router]);
    const refresh = useCallback(async (signal?: AbortSignal) => {
        if (!token || user?.role !== 'admin') return;
        setBusy(true); setError('');
        try {
            const until = new Date(`${end}T00:00:00`); until.setDate(until.getDate() + 1);
            const query = new URLSearchParams({ start: new Date(`${start}T00:00:00`).toISOString(), end: until.toISOString(), userId: employee, source, model, page: String(page) });
            const response = await fetch(`/api/admin/usage?${query}`, { headers: { Authorization: `Bearer ${token}` }, signal });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || '加载失败');
            setData(result);
        } catch (err) {
            if (!signal?.aborted) { setData(null); setError(err instanceof Error ? err.message : '加载失败'); }
        } finally { if (!signal?.aborted) setBusy(false); }
    }, [token, user?.role, start, end, employee, source, model, page]);
    useEffect(() => {
        const controller = new AbortController();
        void refresh(controller.signal);
        return () => controller.abort();
    }, [refresh]);
    async function saveRates() {
        setBusy(true); setError(''); setSaved('');
        try {
            const response = await fetch('/api/admin/usage', { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(rates) });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || '保存失败');
            setEditingRates(false); setSaved('费率已保存，仅用于后续请求的费用估算。');
            await refresh();
        } catch (err) { setError(err instanceof Error ? err.message : '保存失败'); }
        finally { setBusy(false); }
    }
    if (isLoading || user?.role !== 'admin') return <main className={styles.page}>正在验证管理员权限…</main>;
    const groups = data?.groups ?? [];
    const reported = groups.filter(g => g.tokenBasis === 'reported').reduce((n, g) => n + (g.totalTokens ?? 0), 0);
    const missing = groups.filter(g => g.tokenBasis === 'missing').reduce((n, g) => n + g.calls, 0);
    const amounts = new Map<string, number>();
    groups.forEach(g => { if (g.amount !== null) { const key = `${g.currency} · ${basis(g.costBasis)}`; amounts.set(key, (amounts.get(key) ?? 0) + g.amount); } });
    return <main className={styles.page}>
        <header className={styles.header}><div><Link href="/admin">← 管理员后台</Link><h1>员工用量监控</h1><p>主站与 SSO 工具的 Token、模型调用和金额消耗</p></div><button disabled={busy} onClick={() => void refresh()}>{busy ? '加载中…' : '刷新数据'}</button></header>
        <p className={styles.notice}>金额按币种分别汇总，实际扣费与估算分开显示。未返回的 Token 和未定价请求显示“— / 待核算”，不视为零消耗。历史未采集用量无法自动还原；SSO 工具需从服务端接入用量接口。</p>
        <section className={styles.filters} aria-label="筛选用量">
            <label>开始日期<input type="date" value={start} onChange={e => { setStart(e.target.value); setPage(1); }} /></label>
            <label>结束日期<input type="date" value={end} onChange={e => { setEnd(e.target.value); setPage(1); }} /></label>
            <label>员工<select value={employee} onChange={e => { setEmployee(e.target.value); setPage(1); }}><option value="">全部员工</option>{data?.users.map(u => <option key={u.id} value={u.id}>{u.nickname || u.email}</option>)}</select></label>
            <label>来源<select value={source} onChange={e => { setSource(e.target.value); setPage(1); }}><option value="">全部来源</option>{data?.sources.map(s => <option key={s.source} value={s.source}>{sourceLabel(s.source)}</option>)}</select></label>
            <label>模型（完整名称）<input value={model} onChange={e => { setModel(e.target.value); setPage(1); }} placeholder="全部模型" /></label>
        </section>
        {error && <p role="alert" className={styles.error}>{error}</p>}{saved && <p role="status">{saved}</p>}
        {data && <>
            <section className={styles.cards} aria-label="消耗概览">
                <article><span>调用次数</span><strong>{number(data.total)}</strong></article>
                <article><span>已报告 Token</span><strong>{number(reported)}</strong><small>{number(missing)} 次未返回用量；估算 Token 见下表</small></article>
                <article><span>金额消耗</span>{amounts.size ? Array.from(amounts).map(([key, value]) => <div key={key}><strong>{money(value)}</strong><small>{key}</small></div>) : <strong>待核算</strong>}<small>{number(groups.filter(g => g.amount === null).reduce((n, g) => n + g.calls, 0))} 次金额待核算</small></article>
            </section>
            <h2>按员工、来源和模型汇总</h2>
            <div className={styles.table}><table><thead><tr>{['员工 / 组别', '来源 / 模型', '调用 / 异常 / 待完成', '输入 Token', '输出 Token', '缓存命中', '总 Token', '金额'].map(s => <th key={s}>{s}</th>)}</tr></thead><tbody>
                {groups.map((g, i) => <tr key={i}><td>{g.nickname || g.email || g.userId}<small>{g.groupName || '未分组'}</small></td><td>{sourceLabel(g.source)}<small>{g.model}</small><small>供应商：{g.provider}</small></td><td>{g.calls} / {g.failed} / {g.pending}</td><td>{number(g.inputTokens)}</td><td>{number(g.outputTokens)}</td><td>{number(g.cachedInputTokens)}</td><td>{number(g.totalTokens)}<small>{g.tokenBasis === 'estimated' ? '估算 Token' : g.tokenBasis === 'missing' ? '未返回' : '接口报告'}</small></td><td>{money(g.amount, g.currency)}<small>{basis(g.costBasis)}</small></td></tr>)}
                {!groups.length && <tr><td colSpan={8}>所选范围暂无用量记录。</td></tr>}
            </tbody></table></div>
            <h2>调用明细</h2><div className={styles.table}><table><thead><tr>{['时间', '员工', '来源 / 模型', '状态', 'Token', '金额', '请求编号'].map(s => <th key={s}>{s}</th>)}</tr></thead><tbody>
                {data.rows.map(row => <tr key={row.id}><td>{new Date(row.createdAt).toLocaleString('zh-CN')}</td><td>{row.nickname || row.email || row.data.userId}</td><td>{sourceLabel(row.data.source)}<small>{row.data.model}</small></td><td>{statuses[row.data.status]}</td><td>{number(row.data.totalTokens)}<small>{row.data.tokenBasis === 'estimated' ? '估算' : row.data.tokenBasis === 'reported' ? '接口报告' : '未返回'}</small></td><td>{money(row.data.amount, row.data.currency)}<small>{basis(row.data.costBasis)}</small></td><td><small>{row.data.requestId}</small>{row.data.upstreamRequestId && <small>上游：{row.data.upstreamRequestId}</small>}</td></tr>)}
            </tbody></table></div>
            <div className={styles.pager}><button disabled={page === 1 || busy} onClick={() => setPage(page - 1)}>上一页</button><span>{page} / {Math.max(1, Math.ceil(data.total / 50))}</span><button disabled={page * 50 >= data.total || busy} onClick={() => setPage(page + 1)}>下一页</button></div>
            <section><h2>模型估算费率</h2><p>按实际供应商和令牌分组填写。每百万 Token 单价；图片按次计价可填写“每次”。这里的费率不会改变员工积分余额，也不等于供应商账单。</p>
                {!editingRates ? <button onClick={() => { setRates(data.rates); setEditingRates(true); }}>配置费率（{data.rates.length} 个模型）</button> : <>
                    <div className={styles.table}><table><thead><tr>{['供应商标识（与记录一致）', '模型', '币种', '输入 / 百万', '输出 / 百万', '缓存命中 / 百万', '缓存写入 / 百万', '每次（可空）', '操作'].map(v => <th key={v}>{v}</th>)}</tr></thead><tbody>{rates.map((rate, i) => <tr key={i}>
                        {(['provider', 'model'] as const).map(key => <td key={key}><input aria-label={`${i + 1} ${key}`} value={rate[key]} onChange={e => setRates(rates.map((r, j) => i === j ? { ...r, [key]: e.target.value } : r))} /></td>)}
                        <td><select aria-label="币种" value={rate.currency} onChange={e => setRates(rates.map((r, j) => i === j ? { ...r, currency: e.target.value as 'USD' | 'CNY' } : r))}><option>USD</option><option>CNY</option></select></td>
                        {(['inputPerMillion', 'outputPerMillion', 'cachedPerMillion', 'cacheWritePerMillion', 'perCall'] as const).map(key => <td key={key}><input type="number" min="0" step="any" aria-label={`${i + 1} ${key}`} value={rate[key] ?? ''} onChange={e => setRates(rates.map((r, j) => i === j ? { ...r, [key]: e.target.value === '' && key === 'perCall' ? undefined : Number(e.target.value) } : r))} /></td>)}
                        <td><button onClick={() => setRates(rates.filter((_, j) => i !== j))}>移除</button></td>
                    </tr>)}</tbody></table></div>
                    <div className={styles.pager}><button onClick={() => setRates([...rates, { provider: 'api.openlux.ai', model: '', currency: 'USD', inputPerMillion: 0, outputPerMillion: 0, cachedPerMillion: 0, cacheWritePerMillion: 0 }])}>添加模型</button><button disabled={busy} onClick={() => void saveRates()}>保存费率</button><button onClick={() => setEditingRates(false)}>取消</button></div>
                </>}
            </section>
        </>}
    </main>;
}
