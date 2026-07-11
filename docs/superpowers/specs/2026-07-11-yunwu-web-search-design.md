# Yunwu 联网搜索替换设计

## 目标

将主站现有的 AnySearch 联网搜索调用替换为 Yunwu 的 OpenAI 兼容聊天接口，同时保持前端现有的“关闭 / 自动 / 开启”联网模式和当前回答模型选择逻辑不变。

## 范围

- 修改 `frontend/app/lib/web-search.ts` 中的搜索供应商调用与响应解析。
- 更新 `frontend/tests/webSearch.test.mjs`，覆盖请求地址、鉴权、模型、联网选项、消息和响应解析。
- 更新 `frontend/.env.example` 中的联网搜索环境变量说明。
- 不修改聊天界面、自动触发关键词、回答模型路由或其他服务。
- 不在仓库中保存真实 API Key。

## 设计

联网模式为 `off` 时继续跳过搜索；模式为 `on` 时对非空问题搜索；模式为 `auto` 时继续使用现有时效性关键词判断。

需要搜索时，服务端向 `YUNWU_SEARCH_API_URL` 发起 POST 请求。该变量未配置时使用 `https://yunwu.ai/v1/chat/completions`。请求通过 `YUNWU_SEARCH_API_KEY` 鉴权，并发送：

- `model: "gpt-4o-search-preview"`
- `web_search_options: {}`
- 单条用户消息，内容为现有逻辑提取并截断后的最新用户问题

接口成功返回后，读取 `choices[0].message.content`。这段联网回答将作为“联网搜索参考”追加到系统提示词，再由用户当前选择的 GPT-5.4、Claude 或 Gemini 模型生成最终回复。这样不会改变现有回答模型，也不会让搜索模型直接接管最终回复。

## 错误处理

- 缺少 `YUNWU_SEARCH_API_KEY` 时返回明确的未配置错误。
- HTTP 非成功响应时保留状态码和响应文本，便于部署排查。
- 非法 JSON 或缺少可用的 `choices[0].message.content` 时返回明确错误。
- 不在错误信息或日志中输出 API Key。

## 验证

先将现有测试改为期望 Yunwu 请求和响应格式，并确认它在旧实现下失败；再实施最小代码修改使测试通过。最后运行联网搜索专项测试、前端完整测试和构建，确认没有破坏现有聊天流程。

## 部署要求

部署主站前端服务时新增：

- `YUNWU_SEARCH_API_KEY`：新的联网搜索专用密钥。
- `YUNWU_SEARCH_API_URL`：可选，默认已指向 Yunwu 聊天补全接口。

原 `ANYSEARCH_API_KEY` 和 `ANYSEARCH_API_URL` 在代码切换后不再使用，可从部署环境中移除。已经在聊天中公开过的密钥应在部署前轮换。
