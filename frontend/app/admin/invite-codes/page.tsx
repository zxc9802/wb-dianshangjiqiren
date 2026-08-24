'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Copy, KeyRound, RefreshCw, Search, UserX } from 'lucide-react';
import { api, InviteCodeBatchInfo, InviteCodeInfo, InviteCodeUsageInfo } from '../../lib/api';
import { useAuthStore } from '../../stores/auth';
import styles from './invite-codes.module.css';

type PanelTab = 'details' | 'search';

export default function InviteCodesPage() {
    const router = useRouter();
    const { user, isAuthenticated, isLoading, loadUser } = useAuthStore();

    const [count, setCount] = useState(20);
    const [batches, setBatches] = useState<InviteCodeBatchInfo[]>([]);
    const [selectedBatchId, setSelectedBatchId] = useState('');
    const [codes, setCodes] = useState<InviteCodeInfo[]>([]);
    const [latestGenerated, setLatestGenerated] = useState<InviteCodeInfo[]>([]);
    const [loadingBatches, setLoadingBatches] = useState(false);
    const [loadingCodes, setLoadingCodes] = useState(false);
    const [generating, setGenerating] = useState(false);
    const [revokingId, setRevokingId] = useState('');
    const [copyMessage, setCopyMessage] = useState('');
    const [error, setError] = useState('');

    const [activeTab, setActiveTab] = useState<PanelTab>('details');
    const [remarkDraft, setRemarkDraft] = useState('');
    const [editingRemark, setEditingRemark] = useState(false);
    const [savingRemark, setSavingRemark] = useState(false);
    const [searchInput, setSearchInput] = useState('');
    const [searchKeyword, setSearchKeyword] = useState('');
    const [searchResults, setSearchResults] = useState<InviteCodeUsageInfo[]>([]);
    const [loadingSearch, setLoadingSearch] = useState(false);

    useEffect(() => {
        void loadUser();
    }, [loadUser]);

    useEffect(() => {
        if (isLoading) return;
        if (!isAuthenticated) {
            router.replace('/login');
            return;
        }
        if (user && user.role !== 'admin') {
            router.replace('/');
        }
    }, [isAuthenticated, isLoading, router, user]);

    const refreshBatches = useCallback(async (preferredBatchId?: string) => {
        setLoadingBatches(true);
        setError('');

        try {
            const response = await api.getInviteCodeBatches();
            const nextBatches = response.data;
            setBatches(nextBatches);
            setSelectedBatchId((currentSelectedBatchId) => (
                preferredBatchId
                || currentSelectedBatchId
                || nextBatches[0]?.id
                || ''
            ));
        } catch (err) {
            setError(err instanceof Error ? err.message : '加载邀请码批次失败。');
        } finally {
            setLoadingBatches(false);
        }
    }, []);

    const loadCodesForBatch = useCallback(async (batchId: string) => {
        setLoadingCodes(true);
        setError('');

        try {
            const response = await api.getInviteCodes(batchId);
            setCodes(response.data);
        } catch (err) {
            setError(err instanceof Error ? err.message : '加载邀请码详情失败。');
        } finally {
            setLoadingCodes(false);
        }
    }, []);

    const runUsageSearch = useCallback(async (keyword: string) => {
        const response = await api.searchInviteCodeUsage(keyword);
        return response.data;
    }, []);

    useEffect(() => {
        if (!isAuthenticated || user?.role !== 'admin') return;
        void refreshBatches();
    }, [isAuthenticated, refreshBatches, user?.role]);

    const latestBatchId = latestGenerated[0]?.batchId || '';
    const showingLatestGenerated = Boolean(latestGenerated.length > 0 && selectedBatchId === latestBatchId);

    useEffect(() => {
        if (!selectedBatchId || !isAuthenticated || user?.role !== 'admin') return;
        if (showingLatestGenerated) return;
        void loadCodesForBatch(selectedBatchId);
    }, [isAuthenticated, loadCodesForBatch, selectedBatchId, showingLatestGenerated, user?.role]);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            setSearchKeyword(searchInput.trim());
        }, 250);

        return () => window.clearTimeout(timer);
    }, [searchInput]);

    useEffect(() => {
        if (!searchKeyword) {
            setSearchResults([]);
            setLoadingSearch(false);
            return;
        }

        let cancelled = false;
        setLoadingSearch(true);
        setError('');

        void runUsageSearch(searchKeyword)
            .then((results) => {
                if (!cancelled) {
                    setSearchResults(results);
                }
            })
            .catch((err) => {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : '搜索历史使用记录失败。');
                    setSearchResults([]);
                }
            })
            .finally(() => {
                if (!cancelled) {
                    setLoadingSearch(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [runUsageSearch, searchKeyword]);

    async function handleGenerate() {
        setGenerating(true);
        setError('');
        setCopyMessage('');
        setActiveTab('details');

        try {
            const response = await api.createInviteCodeBatch({ count });
            setLatestGenerated(response.data.codes);
            setCodes(response.data.codes);
            setSelectedBatchId(response.data.batch.id);
            await refreshBatches(response.data.batch.id);
        } catch (err) {
            setError(err instanceof Error ? err.message : '生成邀请码失败。');
        } finally {
            setGenerating(false);
        }
    }

    const selectedBatch = useMemo(
        () => batches.find((batch) => batch.id === selectedBatchId) || null,
        [batches, selectedBatchId],
    );

    useEffect(() => {
        setEditingRemark(false);
        setRemarkDraft(selectedBatch?.remark || '');
    }, [selectedBatch?.id, selectedBatch?.remark]);

    const detailCodes = showingLatestGenerated ? latestGenerated : codes;
    const unusedCodes = detailCodes.filter((item) => !item.usedAt);
    const batchPreviewCodes = detailCodes.slice(0, 6);

    async function copyText(text: string, successMessage: string) {
        try {
            await navigator.clipboard.writeText(text);
            setCopyMessage(successMessage);
        } catch {
            setCopyMessage('复制失败，请检查浏览器剪贴板权限。');
        }
    }

    async function handleCopyCurrentBatch() {
        const text = unusedCodes.map((item) => item.code).join('\n');
        if (!text) {
            setCopyMessage('当前批次没有可复制的未使用邀请码。');
            return;
        }

        await copyText(text, `已复制 ${unusedCodes.length} 个未使用邀请码。`);
    }

    async function handleCopySingleCode(code: string) {
        await copyText(code, `邀请码 ${code} 已复制。`);
    }

    async function handleSaveRemark() {
        if (!selectedBatch || savingRemark) {
            return;
        }

        setSavingRemark(true);
        setError('');
        setCopyMessage('');

        try {
            const response = await api.updateInviteCodeBatch(selectedBatch.id, { remark: remarkDraft.trim() });
            const updatedBatch = response.data;
            setBatches((currentBatches) => currentBatches.map((batch) => (
                batch.id === updatedBatch.id ? updatedBatch : batch
            )));
            setEditingRemark(false);
            setRemarkDraft(updatedBatch.remark);
            setCopyMessage('批次备注已保存。');
        } catch (err) {
            setError(err instanceof Error ? err.message : '保存批次备注失败。');
        } finally {
            setSavingRemark(false);
        }
    }

    async function handleRevokeUsage(params: {
        inviteCodeId: string;
        batchId: string;
        usedByLabel: string;
        code: string;
    }) {
        const confirmed = window.confirm(`确认取消 ${params.usedByLabel} 的使用权限，并释放邀请码 ${params.code} 吗？`);
        if (!confirmed) {
            return;
        }

        setRevokingId(params.inviteCodeId);
        setError('');
        setCopyMessage('');

        try {
            await api.revokeInviteCodeUsage(params.inviteCodeId);
            await refreshBatches(selectedBatchId || params.batchId);

            if (selectedBatchId === params.batchId) {
                setLatestGenerated([]);
                await loadCodesForBatch(params.batchId);
            }

            if (searchKeyword) {
                const nextResults = await runUsageSearch(searchKeyword);
                setSearchResults(nextResults);
            }

            setCopyMessage(`已撤销 ${params.usedByLabel} 的使用权限。`);
        } catch (err) {
            setError(err instanceof Error ? err.message : '撤销使用权限失败。');
        } finally {
            setRevokingId('');
        }
    }

    function handleLocateBatch(batchId: string) {
        setLatestGenerated([]);
        setSelectedBatchId(batchId);
        setActiveTab('details');
    }

    if (isLoading || !user) {
        return <div className={styles.loading}>加载中...</div>;
    }

    if (user.role !== 'admin') {
        return null;
    }

    return (
        <div className={styles.page}>
            <div className={styles.header}>
                <div>
                    <button type="button" className={styles.backLink} onClick={() => router.push('/')}>
                        <ArrowLeft size={16} />
                        返回首页
                    </button>
                    <h1 className={styles.title}>邀请码管理</h1>
                    <p className={styles.subtitle}>管理邀请码批次、内部备注和历史成员使用记录。</p>
                </div>
                <button type="button" className={styles.refreshBtn} onClick={() => void refreshBatches()} disabled={loadingBatches}>
                    <RefreshCw size={16} className={loadingBatches ? styles.spinning : ''} />
                    刷新数据
                </button>
            </div>

            <div className={styles.grid}>
                <section className={styles.card}>
                    <div className={styles.cardHeader}>
                        <div>
                            <h2>批量生成</h2>
                            <p>每次可生成 1 到 500 个一次性邀请码。</p>
                        </div>
                        <KeyRound size={20} />
                    </div>

                    <label className={styles.field}>
                        <span>生成数量</span>
                        <input
                            type="number"
                            min={1}
                            max={500}
                            value={count}
                            onChange={(event) => setCount(Math.max(1, Math.min(500, Number(event.target.value) || 1)))}
                        />
                    </label>

                    <div className={styles.actions}>
                        <button type="button" className={styles.primaryBtn} onClick={() => void handleGenerate()} disabled={generating}>
                            {generating ? '生成中...' : '生成邀请码'}
                        </button>
                        <button type="button" className={styles.secondaryBtn} onClick={() => void handleCopyCurrentBatch()}>
                            <Copy size={16} />
                            复制当前批次
                        </button>
                    </div>

                    {copyMessage ? <p className={styles.copyMessage}>{copyMessage}</p> : null}
                    {error ? <p className={styles.error}>{error}</p> : null}

                    {detailCodes.length > 0 && selectedBatch ? (
                        <div className={styles.generatedBlock}>
                            <div className={styles.generatedHead}>
                                <strong>{showingLatestGenerated ? '最新生成批次' : '当前批次预览'}</strong>
                                <span>{detailCodes.length} 个邀请码</span>
                            </div>
                            <div className={styles.codeCloud}>
                                {batchPreviewCodes.map((item) => (
                                    <button
                                        key={item.id}
                                        type="button"
                                        className={styles.codeChipButton}
                                        onClick={() => void handleCopySingleCode(item.code)}
                                        title="复制这个邀请码"
                                    >
                                        <code className={styles.codeChip}>{item.code}</code>
                                    </button>
                                ))}
                                {detailCodes.length > batchPreviewCodes.length ? (
                                    <span className={styles.moreChip}>+{detailCodes.length - batchPreviewCodes.length}</span>
                                ) : null}
                            </div>
                        </div>
                    ) : null}
                </section>

                <section className={styles.card}>
                    <div className={styles.cardHeader}>
                        <div>
                            <h2>历史批次</h2>
                            <p>点击批次即可查看这一批的邀请码明细和备注。</p>
                        </div>
                    </div>

                    <div className={styles.batchList}>
                        {loadingBatches ? (
                            <div className={styles.emptyState}>正在加载批次...</div>
                        ) : batches.length === 0 ? (
                            <div className={styles.emptyState}>还没有生成过邀请码批次。</div>
                        ) : batches.map((batch) => (
                            <button
                                key={batch.id}
                                type="button"
                                className={`${styles.batchItem} ${batch.id === selectedBatchId ? styles.batchItemActive : ''}`}
                                onClick={() => {
                                    setLatestGenerated([]);
                                    setSelectedBatchId(batch.id);
                                    setActiveTab('details');
                                }}
                            >
                                <div className={styles.batchTop}>
                                    <strong>{new Date(batch.createdAt).toLocaleString('zh-CN')}</strong>
                                    <span>{batch.count} 个</span>
                                </div>
                                <p className={styles.batchRemark}>{batch.remark || '未备注'}</p>
                                <div className={styles.batchMeta}>
                                    <span>已用 {batch.usedCount}</span>
                                    <span>未用 {batch.unusedCount}</span>
                                    <span>创建人 {batch.createdBy.account}</span>
                                </div>
                            </button>
                        ))}
                    </div>
                </section>
            </div>

            <section className={styles.tableCard}>
                <div className={styles.panelTop}>
                    <div className={styles.tabBar}>
                        <button
                            type="button"
                            className={`${styles.tabBtn} ${activeTab === 'details' ? styles.tabBtnActive : ''}`}
                            onClick={() => setActiveTab('details')}
                        >
                            批次明细
                        </button>
                        <button
                            type="button"
                            className={`${styles.tabBtn} ${activeTab === 'search' ? styles.tabBtnActive : ''}`}
                            onClick={() => setActiveTab('search')}
                        >
                            历史搜索
                        </button>
                    </div>

                    <label className={styles.searchBox}>
                        <Search size={16} />
                        <input
                            type="text"
                            value={searchInput}
                            onChange={(event) => {
                                const nextValue = event.target.value;
                                setSearchInput(nextValue);
                                if (nextValue.trim()) {
                                    setActiveTab('search');
                                }
                            }}
                            placeholder="搜索姓名、组别或账号"
                        />
                    </label>
                </div>

                {activeTab === 'details' ? (
                    <>
                        <div className={styles.tableHeader}>
                            <div>
                                <h2>批次明细</h2>
                                <p>
                                    {selectedBatch
                                        ? `当前查看 ${new Date(selectedBatch.createdAt).toLocaleString('zh-CN')} 创建的批次`
                                        : '请选择一个批次查看邀请码详情'}
                                </p>
                            </div>
                            <button type="button" className={styles.secondaryBtn} onClick={() => void handleCopyCurrentBatch()}>
                                <Copy size={16} />
                                复制未使用邀请码
                            </button>
                        </div>

                        {selectedBatch ? (
                            <div className={styles.remarkPanel}>
                                <div className={styles.remarkPanelHeader}>
                                    <div>
                                        <h3 className={styles.remarkTitle}>批次备注</h3>
                                        <p className={styles.remarkHint}>备注只对管理员可见，便于区分用途和发放对象。</p>
                                    </div>
                                    {editingRemark ? (
                                        <div className={styles.inlineActions}>
                                            <button
                                                type="button"
                                                className={styles.secondaryBtn}
                                                onClick={() => {
                                                    setEditingRemark(false);
                                                    setRemarkDraft(selectedBatch.remark || '');
                                                }}
                                                disabled={savingRemark}
                                            >
                                                取消
                                            </button>
                                            <button
                                                type="button"
                                                className={styles.primaryBtn}
                                                onClick={() => void handleSaveRemark()}
                                                disabled={savingRemark}
                                            >
                                                {savingRemark ? '保存中...' : '保存备注'}
                                            </button>
                                        </div>
                                    ) : (
                                        <button type="button" className={styles.secondaryBtn} onClick={() => setEditingRemark(true)}>
                                            编辑备注
                                        </button>
                                    )}
                                </div>

                                {editingRemark ? (
                                    <input
                                        type="text"
                                        value={remarkDraft}
                                        onChange={(event) => setRemarkDraft(event.target.value)}
                                        maxLength={100}
                                        className={styles.remarkInput}
                                        placeholder="例如：3 月渠道合作批次 / 设计组专用 / 招聘团队试用"
                                    />
                                ) : (
                                    <p className={styles.remarkValue}>{selectedBatch.remark || '未备注'}</p>
                                )}
                            </div>
                        ) : null}

                        {loadingCodes && !showingLatestGenerated ? (
                            <div className={styles.emptyState}>正在加载邀请码详情...</div>
                        ) : detailCodes.length === 0 ? (
                            <div className={styles.emptyState}>当前批次还没有邀请码。</div>
                        ) : (
                            <div className={styles.tableWrap}>
                                <table className={styles.table}>
                                    <thead>
                                        <tr>
                                            <th>邀请码</th>
                                            <th>状态</th>
                                            <th>账号</th>
                                            <th>姓名</th>
                                            <th>组别</th>
                                            <th>使用时间</th>
                                            <th>操作</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {detailCodes.map((item) => (
                                            <tr key={item.id}>
                                                <td>
                                                    <div className={styles.tableCodeRow}>
                                                        <code className={styles.tableCode}>{item.code}</code>
                                                        <button
                                                            type="button"
                                                            className={styles.iconBtn}
                                                            onClick={() => void handleCopySingleCode(item.code)}
                                                            title="复制邀请码"
                                                        >
                                                            <Copy size={14} />
                                                        </button>
                                                    </div>
                                                </td>
                                                <td>
                                                    <span className={`${styles.status} ${item.usedAt ? styles.statusUsed : styles.statusUnused}`}>
                                                        {item.usedAt ? '已使用' : '未使用'}
                                                    </span>
                                                </td>
                                                <td>{item.usedBy?.account || '-'}</td>
                                                <td>{item.usedBy?.account || '-'}</td>
                                                <td>{item.usedBy?.groupName || '-'}</td>
                                                <td>{item.usedAt ? new Date(item.usedAt).toLocaleString('zh-CN') : '-'}</td>
                                                <td>
                                                    {item.canRevoke && item.usedBy ? (
                                                        <button
                                                            type="button"
                                                            className={styles.dangerBtn}
                                                            onClick={() => void handleRevokeUsage({
                                                                inviteCodeId: item.id,
                                                                batchId: item.batchId,
                                                                usedByLabel: item.usedBy ? item.usedBy.account : '',
                                                                code: item.code,
                                                            })}
                                                            disabled={revokingId === item.id}
                                                        >
                                                            <UserX size={14} />
                                                            {revokingId === item.id ? '撤销中...' : '取消使用权限'}
                                                        </button>
                                                    ) : (
                                                        <span className={styles.mutedText}>-</span>
                                                    )}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </>
                ) : (
                    <>
                        <div className={styles.tableHeader}>
                            <div>
                                <h2>历史搜索</h2>
                                <p>支持跨全部历史批次搜索成员姓名、组别或账号。</p>
                            </div>
                        </div>

                        {!searchKeyword ? (
                            <div className={styles.emptyState}>输入姓名、组别或账号后，即可搜索全部历史批次中的使用记录。</div>
                        ) : loadingSearch ? (
                            <div className={styles.emptyState}>正在搜索历史使用记录...</div>
                        ) : searchResults.length === 0 ? (
                            <div className={styles.emptyState}>没有找到匹配的历史使用记录。</div>
                        ) : (
                            <div className={styles.tableWrap}>
                                <table className={styles.table}>
                                    <thead>
                                        <tr>
                                            <th>邀请码</th>
                                            <th>批次时间</th>
                                            <th>批次备注</th>
                                            <th>账号</th>
                                            <th>姓名</th>
                                            <th>组别</th>
                                            <th>使用时间</th>
                                            <th>操作</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {searchResults.map((item) => (
                                            <tr key={item.inviteCodeId}>
                                                <td><code className={styles.tableCode}>{item.code}</code></td>
                                                <td>{new Date(item.batchCreatedAt).toLocaleString('zh-CN')}</td>
                                                <td className={styles.remarkCell}>{item.batchRemark || '未备注'}</td>
                                                <td>{item.usedBy?.account || '-'}</td>
                                                <td>{item.usedBy?.account || '-'}</td>
                                                <td>{item.usedBy?.groupName || '-'}</td>
                                                <td>{item.usedAt ? new Date(item.usedAt).toLocaleString('zh-CN') : '-'}</td>
                                                <td>
                                                    <div className={styles.rowActions}>
                                                        <button
                                                            type="button"
                                                            className={styles.secondaryBtn}
                                                            onClick={() => handleLocateBatch(item.batchId)}
                                                        >
                                                            定位批次
                                                        </button>
                                                        {item.canRevoke && item.usedBy ? (
                                                            <button
                                                                type="button"
                                                                className={styles.dangerBtn}
                                                                onClick={() => void handleRevokeUsage({
                                                                    inviteCodeId: item.inviteCodeId,
                                                                    batchId: item.batchId,
                                                                    usedByLabel: item.usedBy ? item.usedBy.account : '',
                                                                    code: item.code,
                                                                })}
                                                                disabled={revokingId === item.inviteCodeId}
                                                            >
                                                                <UserX size={14} />
                                                                {revokingId === item.inviteCodeId ? '撤销中...' : '取消使用权限'}
                                                            </button>
                                                        ) : null}
                                                    </div>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </>
                )}
            </section>
        </div>
    );
}
