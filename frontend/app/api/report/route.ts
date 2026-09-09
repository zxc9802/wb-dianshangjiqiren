import { withUsage } from '@/app/lib/usage-context';
import { NextRequest, NextResponse } from 'next/server';
import { GPT_5_4_MODEL, requestYunwuOpenAIChat, type OpenAIChatMessage } from '../../lib/yunwu-openai-chat';

const REPORT_PROMPT = `你是一位专业的商业分析报告撰写专家。基于以下对话记录，生成一份结构化的分析报告。

请严格按照以下 JSON 格式输出（不要输出任何其他内容，只输出纯 JSON）：

{
  "title": "报告标题（根据对话主题生成，如"KPI考核体系设计分析报告"）",
  "summary": "一段话概括整个对话的核心结论（100字以内）",
  "insights": [
    { "title": "洞察标题", "content": "具体说明", "priority": "high/medium/low" }
  ],
  "actions": [
    { "title": "行动标题", "content": "具体步骤说明", "timeline": "短期/中期/长期", "impact": "预期效果" }
  ],
  "planSummary": "从对话中提炼的核心方案内容（保留关键数据和表格，去除寒暄。用 markdown 格式输出，保留原有的表格格式）",
  "tags": ["标签1", "标签2", "标签3"]
}

注意事项：
- insights 数量 3-5 条，按重要性排列
- actions 数量 3-6 条，按优先级排列
- planSummary 要保留对话中的所有表格和关键数据
- 所有内容用中文
- 只输出 JSON，不要任何额外文字`;

async function handlePost(req: NextRequest) {
    try {
        const { botId, botName, messages } = await req.json();

        if (!Array.isArray(messages) || messages.length < 2) {
            return NextResponse.json({ error: '对话记录太少，至少需要一轮对话' }, { status: 400 });
        }

        // Build conversation text for analysis
        const conversationText = messages
            .filter((m: { role: string; content: string }) => m.content && m.content.trim())
            .map((m: { role: string; content: string }) => `${m.role === 'user' ? '用户' : 'AI'}：${m.content}`)
            .join('\n\n');

        const reportMessages: OpenAIChatMessage[] = [{
            role: 'user',
            content: `智能体名称：${botName || 'AI助手'}（编号：${botId}）\n\n以下是对话记录：\n\n${conversationText}`,
        }];

        const text = await requestYunwuOpenAIChat({
            systemPrompt: REPORT_PROMPT,
            messages: reportMessages,
            temperature: 0.7,
            model: GPT_5_4_MODEL,
        });
        if (!text) {
            return NextResponse.json({ error: 'AI 返回为空' }, { status: 500 });
        }

        // Parse the JSON response
        let report;
        try {
            report = JSON.parse(text);
        } catch {
            // Try to extract JSON from mixed content
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                report = JSON.parse(jsonMatch[0]);
            } else {
                return NextResponse.json({ error: '报告解析失败' }, { status: 500 });
            }
        }

        return NextResponse.json({
            ...report,
            botId,
            botName: botName || 'AI助手',
            generatedAt: new Date().toISOString(),
            messageCount: messages.length,
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : '未知错误';
        console.error('[Report] Error:', msg);
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}

export const POST = withUsage(handlePost);
