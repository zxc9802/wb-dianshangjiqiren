import { usageFetch } from './usage-fetch';
import { prisma } from './prisma';
import { readServerEnv } from './server-env';

interface CanvasNode {
    id: string;
    type: string;
    position: { x: number; y: number };
    data: Record<string, unknown>;
}

interface CanvasEdge {
    source: string;
    target: string;
    sourceHandle?: string;
}

interface StepLog {
    nodeId: string;
    nodeName: string;
    nodeType: string;
    status: 'running' | 'completed' | 'failed' | 'skipped';
    output: string;
    duration: number;
    startedAt: string;
}

function topoSort(nodes: CanvasNode[], edges: CanvasEdge[]): string[] {
    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>();

    for (const node of nodes) {
        inDegree.set(node.id, 0);
        adj.set(node.id, []);
    }
    for (const edge of edges) {
        adj.get(edge.source)?.push(edge.target);
        inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree) {
        if (deg === 0) queue.push(id);
    }

    const order: string[] = [];
    while (queue.length > 0) {
        const current = queue.shift()!;
        order.push(current);
        for (const next of adj.get(current) || []) {
            const newDeg = (inDegree.get(next) || 1) - 1;
            inDegree.set(next, newDeg);
            if (newDeg === 0) queue.push(next);
        }
    }
    return order;
}

async function callAI(
    systemPrompt: string,
    conversationHistory: Array<{ role: string; text: string }>,
): Promise<string> {
    const apiUrl = readServerEnv('AI_API_URL');
    const apiKey = readServerEnv('AI_API_KEY');
    if (!apiUrl || !apiKey) return '[AI API 未配置]';

    const contents = [
        { role: 'user', parts: [{ text: systemPrompt }] },
        { role: 'model', parts: [{ text: '好的，我理解了。请提供信息，我来分析。' }] },
        ...conversationHistory.map(msg => ({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.text }],
        })),
    ];

    const fullUrl = apiUrl.includes('?') ? `${apiUrl}&key=${apiKey}` : `${apiUrl}?key=${apiKey}`;

    const res = await usageFetch(fullUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents,
            generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
        }),
    });

    if (!res.ok) throw new Error(`AI API error: ${res.status}`);

    const text = await res.text();
    let fullOutput = '';
    for (const line of text.split('\n')) {
        try {
            const json = JSON.parse(line);
            const parts = json?.candidates?.[0]?.content?.parts;
            if (parts) for (const part of parts) if (part.text) fullOutput += part.text;
        } catch { /* skip */ }
    }
    return fullOutput || '[AI 无回复]';
}

async function executeNode(
    node: CanvasNode,
    inputText: string,
    conversationChain: Array<{ role: string; text: string; agentName: string }>,
): Promise<string> {
    switch (node.type) {
        case 'ai_agent': {
            const botPrompt = (node.data.prompt as string) || '你是一个AI助手，请根据上下文信息来分析和回答。';
            const botName = (node.data.botName as string) || 'AI';
            const systemPrompt = `你是「${botName}」。\n${botPrompt}\n\n你将收到一段对话历史。请在此基础上继续深入分析和回答。`;

            const history = [
                ...conversationChain.map(msg => ({
                    role: msg.role,
                    text: msg.agentName ? `[${msg.agentName}的分析]:\n${msg.text}` : msg.text,
                })),
                { role: 'user', text: inputText || '请开始分析。' },
            ];
            return await callAI(systemPrompt, history);
        }
        case 'input':
            return inputText || (node.data.defaultValue as string) || '';
        case 'output':
            return inputText;
        case 'condition': {
            const keyword = (node.data.keyword as string) || '';
            return keyword && inputText.includes(keyword)
                ? `[条件成立] ${inputText}`
                : `[条件不成立] ${inputText}`;
        }
        default:
            return inputText;
    }
}

export async function executeWorkflow(
    workflow: { id: string; canvasData: string },
    executionId: string,
    _userId: string,
): Promise<void> {
    const stepLogs: StepLog[] = [];

    try {
        const canvas = JSON.parse(workflow.canvasData) as { nodes: CanvasNode[]; edges: CanvasEdge[] };
        const { nodes, edges } = canvas;

        if (nodes.length === 0) {
            await prisma.workflowExecution.update({
                where: { id: executionId },
                data: { status: 'completed', output: '工作流为空', finishedAt: new Date() },
            });
            return;
        }

        const order = topoSort(nodes, edges);
        const nodeMap = new Map(nodes.map(n => [n.id, n]));
        const outputs = new Map<string, string>();
        const conversationChain: Array<{ role: string; text: string; agentName: string }> = [];

        const exec = await prisma.workflowExecution.findUnique({ where: { id: executionId } });
        const initialInput = exec?.input ? JSON.parse(exec.input) : '';
        let lastOutput = typeof initialInput === 'string' ? initialInput : JSON.stringify(initialInput);

        for (const nodeId of order) {
            const node = nodeMap.get(nodeId);
            if (!node) continue;

            const startTime = Date.now();
            const parentEdges = edges.filter(e => e.target === nodeId);
            let nodeInput = lastOutput;
            if (parentEdges.length > 0) {
                const parentOutputs = parentEdges.map(e => outputs.get(e.source)).filter(Boolean);
                if (parentOutputs.length > 0) nodeInput = parentOutputs.join('\n\n---\n\n');
            }

            const log: StepLog = {
                nodeId,
                nodeName: (node.data.label as string) || (node.data.botName as string) || node.type,
                nodeType: node.type,
                status: 'running',
                output: '',
                duration: 0,
                startedAt: new Date().toISOString(),
            };

            try {
                stepLogs.push(log);
                await prisma.workflowExecution.update({
                    where: { id: executionId },
                    data: { stepLogs: JSON.stringify(stepLogs) },
                });

                const output = await executeNode(node, nodeInput, conversationChain);
                outputs.set(nodeId, output);
                lastOutput = output;

                if (node.type === 'input') {
                    conversationChain.push({ role: 'user', text: output, agentName: '' });
                } else if (node.type === 'ai_agent') {
                    conversationChain.push({ role: 'assistant', text: output, agentName: (node.data.botName as string) || 'AI' });
                }

                log.status = 'completed';
                log.output = output.slice(0, 2000);
                log.duration = Date.now() - startTime;
            } catch (err) {
                log.status = 'failed';
                log.output = err instanceof Error ? err.message : '执行失败';
                log.duration = Date.now() - startTime;
                await prisma.workflowExecution.update({
                    where: { id: executionId },
                    data: { status: 'failed', stepLogs: JSON.stringify(stepLogs), finishedAt: new Date() },
                });
                return;
            }
        }

        await prisma.workflowExecution.update({
            where: { id: executionId },
            data: { status: 'completed', output: lastOutput.slice(0, 10000), stepLogs: JSON.stringify(stepLogs), finishedAt: new Date() },
        });
    } catch (err) {
        await prisma.workflowExecution.update({
            where: { id: executionId },
            data: { status: 'failed', stepLogs: JSON.stringify(stepLogs), output: err instanceof Error ? err.message : '执行失败', finishedAt: new Date() },
        });
    }
}
