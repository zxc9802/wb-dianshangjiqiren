'use client';

import { useEffect, useState, use } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Copy, FileText } from 'lucide-react';
import { formatMessage } from '../../../lib/formatMessage';
import styles from './run.module.css';

export interface WfState {
    workflowId: string;
    workflowName: string;
    steps: { botId: string; botName: string; instruction: string }[];
    currentStep: number;
    initialInput: string;
    stepOutputs: string[];
}

function stripTrailingSuggestionJson(text: string): string {
    return text
        .replace(/```json[\s\S]*?```/g, '')
        .replace(/\n?\{\s*"suggestions"\s*:\s*\[[\s\S]*$/g, '')
        .trim();
}

export default function WorkflowReportPage({ params }: { params: Promise<{ templateId: string }> }) {
    const { templateId } = use(params);
    const router = useRouter();
    const searchParams = useSearchParams();
    const phase = searchParams.get('phase');

    const [wfState, setWfState] = useState<WfState | null>(null);
    const [reportText, setReportText] = useState('');
    const [isGenerating, setIsGenerating] = useState(false);
    const [done, setDone] = useState(false);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const raw = sessionStorage.getItem('wf_state');
        if (raw) {
            try {
                const state = JSON.parse(raw) as WfState;
                setWfState(state);
                void generateReport(state);
            } catch {
                router.replace('/');
            }
        } else {
            router.replace('/');
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const generateReport = async (state: WfState) => {
        setIsGenerating(true);

        const stepsContent = state.steps
            .map((step, index) => `**步骤 ${index + 1}：${step.botName}**\n${state.stepOutputs[index] || '（未完成）'}`)
            .join('\n\n---\n\n');

        const prompt = `请根据以下工作流《${state.workflowName}》各步骤的分析结果，整合生成一份完整的工作报告。\n\n${stepsContent}\n\n---\n请输出结构清晰、可直接使用的完整报告，包含：执行摘要、各步骤核心成果、综合建议与行动方案。`;

        try {
            const res = await fetch('/api/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${localStorage.getItem('token') || ''}`,
                },
                body: JSON.stringify({
                    botId: '6',
                    systemPrompt: '你是专业的商业报告撰写专家，请把多步骤分析结果整合成结构清晰、可执行的工作报告。',
                    messages: [{ role: 'user', content: prompt }],
                }),
            });
            if (!res.ok) throw new Error('error');

            const contentType = res.headers.get('content-type') || '';
            if (contentType.includes('application/json')) {
                const payload = await res.json() as { data?: { content?: string } };
                setReportText(typeof payload.data?.content === 'string' ? stripTrailingSuggestionJson(payload.data.content) : '');
                setDone(true);
                setIsGenerating(false);
                return;
            }

            const reader = res.body?.getReader();
            if (!reader) {
                throw new Error('Streaming response is unavailable.');
            }

            const decoder = new TextDecoder();
            let full = '';
            while (true) {
                const { done: streamDone, value } = await reader.read();
                if (streamDone) break;
                const chunk = decoder.decode(value, { stream: true });
                for (const line of chunk.split('\n')) {
                    if (!line.startsWith('data: ')) continue;
                    try {
                        const event = JSON.parse(line.slice(6)) as { type?: string; content?: string };
                        if (event.type === 'text' && event.content) {
                            full += event.content;
                            setReportText(stripTrailingSuggestionJson(full));
                        }
                    } catch {
                        // ignore malformed event frames
                    }
                }
            }
        } catch {
            setReportText('报告生成失败，请重试。');
        }
        setIsGenerating(false);
        setDone(true);
    };

    const copyReport = () => navigator.clipboard.writeText(reportText);

    return (
        <div className={styles.container}>
            <div className={styles.reportPanel}>
                <div className={styles.reportHeader}>
                    <button className={styles.backBtn} onClick={() => router.push('/')}>
                        <ArrowLeft size={16} /> 返回首页
                    </button>
                    <span className={styles.reportTitle}>
                        <FileText size={16} /> {wfState?.workflowName || '工作流'} - 整体报告
                    </span>
                    {done && reportText && (
                        <button className={styles.copyBtn} onClick={copyReport}>
                            <Copy size={14} /> 复制
                        </button>
                    )}
                </div>

                <div className={styles.reportContent}>
                    {isGenerating && !reportText && (
                        <div className={styles.reportGenerating}>
                            <div className={styles.spinner} /> 正在整合各步骤结果，生成报告...
                        </div>
                    )}
                    {reportText && (
                        <div
                            className={styles.reportText}
                            dangerouslySetInnerHTML={{ __html: formatMessage(reportText) }}
                        />
                    )}
                </div>

                {done && (
                    <button
                        className={styles.restartBtn}
                        onClick={() => {
                            sessionStorage.removeItem('wf_state');
                            router.push(phase ? `/workflow?phase=${phase}&templateId=${templateId}` : '/');
                        }}
                    >
                        完成，返回首页
                    </button>
                )}
            </div>
        </div>
    );
}
