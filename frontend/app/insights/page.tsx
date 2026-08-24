'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ExternalLink, FileText, Globe, Loader2 } from 'lucide-react';
import styles from './insights.module.css';
import { api, type PageInsightInfo } from '../lib/api';
import { formatMessage } from '../lib/formatMessage';
import { useAuthStore } from '../stores/auth';

function formatTime(value: string): string {
    const date = new Date(value);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function getInsightPreview(insight: PageInsightInfo): string {
    return insight.summary
        || insight.chatTranscript.find((item) => item.role === 'assistant')?.content
        || '暂无摘要内容。';
}

function getInsightCardPreview(insight: PageInsightInfo): string {
    const fallbackPreview = getInsightPreview(insight);

    if (insight.summary) {
        return insight.summary;
    }

    const assistantMessage = insight.chatTranscript.find((item) => item.role === 'assistant');
    if (!assistantMessage) {
        return fallbackPreview;
    }

    if (assistantMessage.kind === 'image') {
        return assistantMessage.imagePrompt
            ? `绘图提示词：${assistantMessage.imagePrompt}`
            : assistantMessage.content || fallbackPreview;
    }

    return assistantMessage.content || fallbackPreview;
}

export default function InsightsPage() {
    const router = useRouter();
    const { user, isAuthenticated, isLoading, loadUser } = useAuthStore();
    const [insights, setInsights] = useState<PageInsightInfo[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    useEffect(() => {
        loadUser();
    }, [loadUser]);

    useEffect(() => {
        if (isLoading) return;
        if (!isAuthenticated) {
            router.push('/login');
            return;
        }

        let cancelled = false;

        api.getInsights({ limit: 50 })
            .then((response) => {
                if (!cancelled) {
                    setInsights(response.data);
                    setError('');
                }
            })
            .catch((err) => {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : '加载失败');
                }
            })
            .finally(() => {
                if (!cancelled) {
                    setLoading(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [isAuthenticated, isLoading, router]);

    if (isLoading || loading) {
        return (
            <div className={styles.loadingState}>
                <Loader2 className={styles.spinner} size={20} />
                <span>加载网页洞察中...</span>
            </div>
        );
    }

    return (
        <main className={styles.page}>
            <header className={styles.header}>
                <div>
                    <Link href="/" className={styles.backLink}>
                        <ArrowLeft size={16} />
                        返回首页
                    </Link>
                    <h1 className={styles.title}>网页洞察</h1>
                    <p className={styles.subtitle}>
                        {user?.account || '当前用户'} 在插件里保存的网页总结和对话记录。
                    </p>
                </div>
            </header>

            {error ? <div className={styles.errorBox}>{error}</div> : null}

            {!error && insights.length === 0 ? (
                <section className={styles.emptyState}>
                    <FileText size={28} />
                    <h2>还没有保存的网页洞察</h2>
                    <p>先在浏览器插件里总结页面或围绕网页提问，再点击“保存到主站”。</p>
                </section>
            ) : null}

            <section className={styles.list}>
                {insights.map((insight) => (
                    <article key={insight.id} className={styles.card}>
                        <div className={styles.cardHeader}>
                            <div>
                                <div className={styles.cardMeta}>
                                    <span>{insight.botName}</span>
                                    <span>{formatTime(insight.updatedAt)}</span>
                                </div>
                                <h2 className={styles.cardTitle}>
                                    <Link href={`/insights/${insight.id}`} className={styles.cardLink}>
                                        {insight.sourceTitle || insight.pageContext.title || insight.sourceUrl}
                                    </Link>
                                </h2>
                            </div>
                            <a
                                href={insight.sourceUrl}
                                target="_blank"
                                rel="noreferrer"
                                className={styles.sourceLink}
                                title="打开原网页"
                            >
                                <ExternalLink size={16} />
                            </a>
                        </div>

                        <div className={styles.sourceRow}>
                            <Globe size={14} />
                            <span>{insight.sourceDomain || '未知域名'}</span>
                            <span className={styles.sourceUrl}>{insight.sourceUrl}</span>
                        </div>

                        <div
                            className={styles.summary}
                            dangerouslySetInnerHTML={{ __html: formatMessage(getInsightCardPreview(insight)) }}
                        />

                        <div className={styles.footer}>
                            <div className={styles.footerMeta}>
                                <span>{insight.pageContext.hasVideo ? '视频页面' : '普通网页'}</span>
                                <span>{insight.chatTranscript.length} 条消息</span>
                            </div>
                            <Link href={`/insights/${insight.id}`} className={styles.detailButton}>
                                进入详情
                            </Link>
                        </div>
                    </article>
                ))}
            </section>
        </main>
    );
}
