import { usageFetch } from '../services/usage-fetch';
import { Router, Response } from 'express';
import { prisma } from '../utils/prisma';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authMiddleware);

const BOT_LIST = [
    { id: '36', name: '通用聊天' },
    { id: '35', name: '起芽成长特助' },
    { id: '1', name: 'KPI教练' }, { id: '2', name: 'SOP梳理AI教练' }, { id: '3', name: 'OKR教练' },
    { id: '4', name: '电商商业顾问' }, { id: '5', name: '招聘教练' }, { id: '6', name: 'AI通用助手' },
    { id: '7', name: '一键出10图提示词' }, { id: '8', name: '天猫爆款趋势拆解' }, { id: '9', name: '卖点教练' },
    { id: '10', name: '天猫主图策划教练' }, { id: '11', name: '爆款裂变分析AI教练' }, { id: '12', name: '天猫评价教练' },
    { id: '13', name: '天猫竞争策略教练' }, { id: '14', name: '天猫客单价提升教练' },
    { id: '15', name: '小红书爆文封面拆解' }, { id: '16', name: '小红书私域搭建SOP' },
    { id: '17', name: '小红书爆文拆解复制' }, { id: '18', name: '小红书爆款标题' },
    { id: '19', name: '小红书起号话题' }, { id: '20', name: '小红书达人SOP流程' },
    { id: '21', name: '小红书正文拆解SOP' }, { id: '22', name: '小红书笔记评论生成' },
    { id: '23', name: '毛泽东战略智能体' }, { id: '24', name: '乔布斯产品教练' },
    { id: '25', name: '张一鸣商业教练' }, { id: '26', name: '降税模型测算' },
    { id: '27', name: '股权架构设计' }, { id: '28', name: '电商平台专项合规' },
    { id: '29', name: '薪酬与个税规划' }, { id: '30', name: '预警诊断&稽查' },
    { id: '31', name: 'AI工作流开发需求细化' }, { id: '32', name: '调研访谈—高价值场景' },
    { id: '33', name: '火火提示词调试' }, { id: '34', name: 'AI工作流访谈教练' },
];

const SYSTEM_PROMPT = `你是一个电商AI工作流设计师。用户会描述他想自动化的任务，你需要：

1. 用现有智能体设计一个工作流（节点+连线）
2. 如果现有智能体无法完美覆盖需求，推荐创建1-2个自定义智能体来补强工作流

现有智能体列表：
${BOT_LIST.map(b => `ID=${b.id} 名称=${b.name}`).join('\n')}

你必须输出严格的JSON格式（不要Markdown代码块），结构如下：
{
  "name": "工作流名称（简洁）",
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
  "recommendations": [
    {
      "name": "建议创建的智能体名称",
      "description": "为什么需要这个智能体",
      "suggestedPrompt": "建议的系统提示词",
      "insertAfterNode": "node_2"
    }
  ]
}

规则：
- type只能是: input, ai_agent, output, condition
- 必须有且仅有1个input节点和1个output节点
- 节点间y坐标间隔150
- 如果现有智能体已经足够，recommendations留空数组
- recommendations最多2个`;

router.post('/generate', async (req: AuthRequest, res: Response) => {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ success: false, message: '请描述你的需求' });

    const apiUrl = process.env.AI_API_URL;
    const apiKey = process.env.AI_API_KEY;
    if (!apiUrl || !apiKey) {
        return res.status(500).json({ success: false, message: 'AI API 未配置' });
    }

    try {
        const requestBody = {
            contents: [
                { role: 'user', parts: [{ text: `${SYSTEM_PROMPT}\n\n用户需求: ${prompt}` }] },
            ],
            generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
        };

        const fullUrl = apiUrl.includes('?') ? `${apiUrl}&key=${apiKey}` : `${apiUrl}?key=${apiKey}`;
        const aiRes = await usageFetch(fullUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
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

        // Extract JSON from response (may be wrapped in ```json blocks)
        let jsonStr = fullOutput.trim();
        const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) jsonStr = jsonMatch[1].trim();

        const result = JSON.parse(jsonStr);

        // Transform into canvas format
        const canvasData = {
            nodes: result.nodes.map((n: { id: string; type: string; label: string; x: number; y: number; botId?: string; botName?: string; prompt?: string }) => ({
                id: n.id,
                type: n.type,
                position: { x: n.x, y: n.y },
                data: {
                    label: n.label,
                    botId: n.botId || '',
                    botName: n.botName || '',
                    prompt: n.prompt || '',
                    description: '',
                },
            })),
            edges: result.edges.map((e: { source: string; target: string }) => ({
                id: `edge_${e.source}_${e.target}`,
                source: e.source,
                target: e.target,
                animated: true,
            })),
        };

        // Create workflow in DB
        const wf = await prisma.workflow.create({
            data: {
                userId: req.userId!,
                name: result.name || '自动生成的工作流',
                description: result.description || '',
                canvasData: JSON.stringify(canvasData),
            },
        });

        res.json({
            success: true,
            data: {
                workflow: wf,
                recommendations: result.recommendations || [],
            },
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'AI生成失败';
        res.status(500).json({ success: false, message: msg });
    }
});

export default router;
