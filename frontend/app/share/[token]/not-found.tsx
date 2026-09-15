import styles from './share.module.css';

export default function ShareNotFound() {
    return <main className={styles.page}><h1>分享链接不存在或已失效</h1><p>请联系分享者确认链接是否完整，或重新生成分享链接。</p></main>;
}
