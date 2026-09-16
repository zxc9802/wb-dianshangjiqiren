import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getChatShare } from '@/app/lib/chat-sharing';
import { formatMessage } from '@/app/lib/formatMessage';
import { resolveImageAssetUrl } from '@/app/lib/api';
import styles from './share.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
    title: '聊天记录分享', robots: { index: false, follow: false }, referrer: 'no-referrer',
};

export default async function SharedChatPage({ params }: { params: Promise<{ token: string }> }) {
    const { token } = await params;
    const snapshot = await getChatShare(token);
    if (!snapshot) notFound();
    return <main className={styles.page}>
        <header className={styles.header}>
            <span className={styles.badge}>聊天记录分享</span>
            <h1>{snapshot.title}</h1>
            <p>{snapshot.botName} · {snapshot.messages.length} 条消息</p>
        </header>
        <div className={styles.messages}>
            {snapshot.messages.map((message, index) => <article key={index} className={`${styles.message} ${message.role === 'user' ? styles.user : ''}`}>
                <div className={styles.byline}><strong>{message.role === 'user' ? '用户' : snapshot.botName}</strong><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</time></div>
                <div className={styles.content} dangerouslySetInnerHTML={{ __html: formatMessage(message.content) }} />
                {message.attachments.map((attachment, i) => <div className={styles.attachment} key={i}>
                    <span>{attachment.kind === 'video' ? '视频' : attachment.kind === 'image' ? '图片' : '文件'}：{attachment.fileName}</span>
                    {[attachment.previewUrl, ...attachment.frames].filter((url): url is string => Boolean(url)).map((url, j) => (
                        // eslint-disable-next-line @next/next/no-img-element -- shared attachment URLs may be local or remote.
                        <img key={j} src={resolveImageAssetUrl(url)} alt={attachment.fileName} loading="lazy" referrerPolicy="no-referrer" />
                    ))}
                </div>)}
                {message.imageUrls.map((url, i) => <a key={i} href={resolveImageAssetUrl(url)} target="_blank" rel="noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element -- generated images use the existing asset proxy. */}
                    <img className={styles.image} src={resolveImageAssetUrl(url)} alt={`分享图片 ${i + 1}`} loading="lazy" referrerPolicy="no-referrer" />
                </a>)}
            </article>)}
        </div>
        <footer>以上为分享者选中的聊天记录，AI 生成的内容仅供参考。</footer>
    </main>;
}
