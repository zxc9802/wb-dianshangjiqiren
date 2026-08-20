'use client';

import { useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { formatMessage } from '../lib/formatMessage';
import styles from './fullplan.module.css';
import {
    Search,
    Swords,
    Zap,
    Palette,
    FileText,
    Star,
    BookOpen,
    Coins,
    Target,
    Rocket,
    CheckCircle,
    Loader2,
    XCircle,
    ArrowLeft,
    Square,
} from 'lucide-react';

interface PlanStep {
    id: string;
    title: string;
    icon: ReactNode;
    description: string;
    prompt: string;
    status: 'waiting' | 'running' | 'done' | 'error';
    result: string;
}

const PLAN_STEPS: Omit<PlanStep, 'status' | 'result'>[] = [
    {
        id: 'market',
        title: '市场分析',
        icon: <Search size={18} />,
        description: '分析市场规模、目标人群和机会点。',
        prompt: '请根据以下产品信息输出一份市场分析，包含目标用户、核心需求、竞争机会和风险提示。\n\n产品信息：\n{input}',
    },
    {
        id: 'competitor',
        title: '竞品扫描',
        icon: <Swords size={18} />,
        description: '梳理主要竞品和差异化方向。',
        prompt: '请基于以下产品信息和前一步结论，整理竞品对比，输出竞品特征、价格带和可切入空白。\n\n产品信息：\n{input}\n\n前一步结果：\n{prev}',
    },
    {
        id: 'selling',
        title: '核心卖点',
        icon: <Zap size={18} />,
        description: '提炼最有说服力的卖点与传播话术。',
        prompt: '请基于以下信息提炼 3 个核心卖点，每个卖点都输出特征、优势、利益点和适用场景。\n\n产品信息：\n{input}\n\n参考信息：\n{prev}',
    },
    {
        id: 'mainimg',
        title: '主图方案',
        icon: <Palette size={18} />,
        description: '生成主图思路、标题和视觉重点。',
        prompt: '请基于以下产品信息和卖点，给出 5 张主图方案，每张包含主题、标题、视觉重点和拍摄建议。\n\n产品信息：\n{input}\n\n参考信息：\n{prev}',
    },
    {
        id: 'detail',
        title: '详情页结构',
        icon: <FileText size={18} />,
        description: '输出详情页模块顺序和每屏重点。',
        prompt: '请基于以下产品信息和已有分析，整理一份详情页结构方案，输出每个模块的目标、文案重点和视觉建议。\n\n产品信息：\n{input}\n\n参考信息：\n{prev}',
    },
    {
        id: 'review',
        title: '评价与种草',
        icon: <Star size={18} />,
        description: '生成评价方向、晒单建议和种草素材。',
        prompt: '请基于以下产品信息和已有分析，输出评价内容方向、晒单建议和用户种草素材。\n\n产品信息：\n{input}\n\n参考信息：\n{prev}',
    },
    {
        id: 'xiaohongshu',
        title: '内容分发',
        icon: <BookOpen size={18} />,
        description: '整理小红书等内容平台的传播方向。',
        prompt: '请基于以下产品信息和前面结论，输出适合内容平台传播的选题、标题和内容方向。\n\n产品信息：\n{input}\n\n参考信息：\n{prev}',
    },
    {
        id: 'pricing',
        title: '定价与促销',
        icon: <Coins size={18} />,
        description: '给出定价建议和短期促销策略。',
        prompt: '请基于以下产品信息和前面结论，给出定价建议、促销组合和上线前 30 天运营节奏。\n\n产品信息：\n{input}\n\n参考信息：\n{prev}',
    },
];

function renderStepResultHtml(text: string): string {
    return formatMessage(text);
}

export default function FullPlanPage() {
    const router = useRouter();
    const abortRef = useRef(false);
    const resultsRef = useRef<HTMLDivElement>(null);
    const [productInput, setProductInput] = useState('');
    const [isRunning, setIsRunning] = useState(false);
    const [steps, setSteps] = useState<PlanStep[]>([]);

    const runPlan = async () => {
        if (!productInput.trim() || isRunning) return;
        abortRef.current = false;

        const initialSteps: PlanStep[] = PLAN_STEPS.map((step) => ({
            ...step,
            status: 'waiting',
            result: '',
        }));

        setSteps(initialSteps);
        setIsRunning(true);

        let prevResult = '';

        for (let index = 0; index < initialSteps.length; index += 1) {
            if (abortRef.current) break;

            setSteps((current) => current.map((step, currentIndex) => (
                currentIndex === index ? { ...step, status: 'running' } : step
            )));

            setTimeout(() => {
                const element = document.getElementById(`step-${index}`);
                element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 200);

            try {
                const prompt = initialSteps[index].prompt
                    .replace('{input}', productInput)
                    .replace('{prev}', prevResult.slice(-2000));

                const response = await fetch('/api/chat', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${localStorage.getItem('token') || ''}`,
                    },
                    body: JSON.stringify({
                        message: prompt,
                        systemPrompt: '你是电商全案策划顾问，请直接输出结构化、可执行的结果。',
                        conversationHistory: [],
                    }),
                });

                if (!response.ok) {
                    throw new Error('接口请求失败');
                }

                const contentType = response.headers.get('content-type') || '';
                if (contentType.includes('application/json')) {
                    const payload = await response.json() as { data?: { content?: string } };
                    const fullText = typeof payload.data?.content === 'string' ? payload.data.content : '';
                    prevResult = fullText;
                    setSteps((current) => current.map((step, currentIndex) => (
                        currentIndex === index ? { ...step, status: 'done', result: fullText } : step
                    )));
                    continue;
                }

                const reader = response.body?.getReader();
                const decoder = new TextDecoder();
                let fullText = '';

                if (reader) {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;

                        const chunk = decoder.decode(value, { stream: true });
                        const lines = chunk.split('\n');
                        for (const line of lines) {
                            if (!line.startsWith('data: ')) continue;
                            const data = line.slice(6);
                            if (data === '[DONE]') continue;

                            try {
                                const parsed = JSON.parse(data);
                                const content = parsed.type === 'text'
                                    ? parsed.content
                                    : parsed.choices?.[0]?.delta?.content;
                                if (typeof content === 'string' && content.length > 0) {
                                    fullText += content;
                                    setSteps((current) => current.map((step, currentIndex) => (
                                        currentIndex === index ? { ...step, result: fullText } : step
                                    )));
                                }
                            } catch {
                                // ignore partial SSE chunks
                            }
                        }
                    }
                }

                prevResult = fullText;
                setSteps((current) => current.map((step, currentIndex) => (
                    currentIndex === index ? { ...step, status: 'done', result: fullText } : step
                )));
            } catch (error) {
                setSteps((current) => current.map((step, currentIndex) => (
                    currentIndex === index
                        ? { ...step, status: 'error', result: `错误：${error instanceof Error ? error.message : '未知错误'}` }
                        : step
                )));
            }
        }

        setIsRunning(false);
    };

    const stopPlan = () => {
        abortRef.current = true;
        setIsRunning(false);
    };

    const completedCount = steps.filter((step) => step.status === 'done').length;
    const progress = steps.length > 0 ? Math.round((completedCount / steps.length) * 100) : 0;

    return (
        <div className={styles.layout}>
            <header className={styles.header}>
                <button onClick={() => router.push('/')} className={styles.backBtn}>
                    <ArrowLeft size={16} /> 返回首页
                </button>
                <h1 className={styles.title}><Target size={20} /> AI 全案策划</h1>
                <span className={styles.badge}>结构化输出</span>
            </header>

            <main className={styles.main}>
                <div className={styles.inputSection}>
                    <h2 className={styles.inputTitle}>输入产品信息</h2>
                    <p className={styles.inputDesc}>输入产品卖点、客群、价格带或你已知的背景信息，系统会分步骤生成完整策划方案。</p>
                    <textarea
                        className={styles.inputArea}
                        value={productInput}
                        onChange={(event) => setProductInput(event.target.value)}
                        placeholder="例如：一款面向 25-35 岁女性的轻养生饮品，客单价 59 元，主打低糖和便携场景。"
                        rows={4}
                        disabled={isRunning}
                    />
                    <div className={styles.inputActions}>
                        {!isRunning ? (
                            <button className={styles.startBtn} onClick={runPlan} disabled={!productInput.trim()}>
                                <Rocket size={16} /> 开始生成方案
                            </button>
                        ) : (
                            <button className={styles.stopBtn} onClick={stopPlan}>
                                <Square size={14} /> 停止生成
                            </button>
                        )}
                        <span className={styles.costHint}>生成过程大约需要 1-3 分钟</span>
                    </div>
                </div>

                {steps.length > 0 && (
                    <div className={styles.progressSection}>
                        <div className={styles.progressBar}>
                            <div className={styles.progressFill} style={{ width: `${progress}%` }} />
                        </div>
                        <div className={styles.progressInfo}>
                            <span>{completedCount}/{steps.length} 个步骤已完成</span>
                            <span>{progress}%</span>
                        </div>
                        <div className={styles.stepsTimeline}>
                            {steps.map((step) => (
                                <div key={step.id} className={`${styles.timelineItem} ${styles[step.status]}`}>
                                    <span className={styles.timelineIcon}>
                                        {step.status === 'done' ? <CheckCircle size={14} /> : step.status === 'running' ? <Loader2 size={14} className="animate-spin" /> : step.status === 'error' ? <XCircle size={14} /> : '•'}
                                    </span>
                                    <span className={styles.timelineLabel}>{step.icon} {step.title}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                <div className={styles.results} ref={resultsRef}>
                    {steps.map((step, index) => (
                        <div key={step.id} id={`step-${index}`} className={`${styles.resultCard} ${styles[step.status]}`}>
                            <div className={styles.resultHeader}>
                                <span className={styles.resultIcon}>{step.icon}</span>
                                <h3 className={styles.resultTitle}>步骤 {index + 1}：{step.title}</h3>
                                <span className={styles.resultStatus}>
                                    {step.status === 'running' && <span className={styles.spinner2} />}
                                    {step.status === 'done' && <><CheckCircle size={14} /> 已完成</>}
                                    {step.status === 'error' && <><XCircle size={14} /> 失败</>}
                                    {step.status === 'waiting' && '等待中'}
                                </span>
                            </div>
                            <p className={styles.resultDesc}>{step.description}</p>
                            {step.result && (
                                <div className={styles.resultContent} dangerouslySetInnerHTML={{ __html: renderStepResultHtml(step.result) }} />
                            )}
                        </div>
                    ))}
                </div>
            </main>
        </div>
    );
}
