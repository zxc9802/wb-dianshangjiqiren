import { usageFetch } from '@/app/lib/usage-fetch';
import { withUsage } from '@/app/lib/usage-context';
import { NextRequest } from 'next/server';
import { prisma } from '../../lib/prisma';
import { BUILTIN_BOTS } from '../../lib/builtin-bots';
import { readServerEnv } from '../../lib/server-env';
import { getUserId, errorResponse } from '../../lib/auth';

const BOT_LIST = BUILTIN_BOTS.map((bot) => ({ id: bot.routeId, name: bot.name }));

const SYSTEM_PROMPT = `你是一个电商AI工作流设计师。用户会描述他想自动化的任务，你需要：

1. 用现有智能体设计一个工作流（节点+连线）
2. 如果现有智能体无法完美覆盖需求，推荐创建1-2个自定义智能体来补强工作流

现有智能体列表：
${BOT_LIST.map(b => `ID=${b.id} 名称=${b.name}`).join('\n')}

你必须输出严格的JSON格式（不要Markdown代码块），结构如下：
{
  "name": "工作流名称",
  "description": "一句话描述",
  "nodes": [
    { "id": "node_1", "type": "input", "label": "用户输入", "x": 300, "y": 50 },
    { "id": "node_2", "type": "ai_agent", "label": "卖点教练", "botId": "9", "botName": "卖点教练", "x": 300, "y": 200, "prompt": "" },
    { "id": "node_3", "type": "output", "label": "最终输出", "x": 300, "y": 500 }
  ],
  "edges": [
    { "source": "node_1", "target": "node_2" },
    { "source": "node_2", "target": "node_3" }
  ],
  "recommendations": []
}

规则：
- type只能是: input, ai_agent, output, condition
- 必须有且仅有1个input节点和1个output节点
- 节点间y坐标间隔150
- recommendations最多2个`;

async function handlePost(req: NextRequest) {
    try {
        const userId = await getUserId(req);
        const { prompt } = await req.json();
        if (!prompt) return Response.json({ success: false, message: '请描述你的需求' }, { status: 400 });

        const apiUrl = readServerEnv('AI_API_URL');
        const apiKey = readServerEnv('AI_API_KEY');
        if (!apiUrl || !apiKey) return Response.json({ success: false, message: 'AI API 未配置' }, { status: 500 });

        const fullUrl = apiUrl.includes('?') ? `${apiUrl}&key=${apiKey}` : `${apiUrl}?key=${apiKey}`;
        const aiRes = await usageFetch(fullUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: `${SYSTEM_PROMPT}\n\n用户需求: ${prompt}` }] }],
                generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
            }),
        });

        if (!aiRes.ok) throw new Error(`AI API error: ${aiRes.status}`);

        const text = await aiRes.text();
        let fullOutput = '';
        for (const line of text.split('\n')) {
            try {
                const json = JSON.parse(line);
                const parts = json?.candidates?.[0]?.content?.parts;
                if (parts) for (const p of parts) if (p.text) fullOutput += p.text;
            } catch { /* skip */ }
        }

        let jsonStr = fullOutput.trim();
        const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) jsonStr = jsonMatch[1].trim();

        const result = JSON.parse(jsonStr);

        const canvasData = {
            nodes: result.nodes.map((n: { id: string; type: string; label: string; x: number; y: number; botId?: string; botName?: string; prompt?: string }) => ({
                id: n.id, type: n.type,
                position: { x: n.x, y: n.y },
                data: { label: n.label, botId: n.botId || '', botName: n.botName || '', prompt: n.prompt || '', description: '' },
            })),
            edges: result.edges.map((e: { source: string; target: string }) => ({
                id: `edge_${e.source}_${e.target}`, source: e.source, target: e.target, animated: true,
            })),
        };

        const wf = await prisma.workflow.create({
            data: { userId, name: result.name || '自动生成的工作流', description: result.description || '', canvasData: JSON.stringify(canvasData) },
        });

        return Response.json({ success: true, data: { workflow: wf, recommendations: result.recommendations || [] } });
    } catch (err) {
        return errorResponse(err);
    }
}

export const POST = withUsage(handlePost);
