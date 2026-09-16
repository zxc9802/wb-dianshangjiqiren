# 员工 Token 与金额监控

入口：管理员后台 → 员工用量监控（`/admin/usage`）。普通员工不能读取汇总、明细或修改费率。

## 计量口径

- 输入 Token 包含缓存读取和缓存写入；输出 Token 包含推理 Token，不重复相加。支持 OpenAI Chat Completions、Responses、Gemini、Anthropic JSON 与 SSE。
- 上游没有返回用量时存 `null`，前端显示“未返回”。不能用字符串长度冒充实际 Token。
- 金额分为供应商实际扣费、估算、待核算。USD 和 CNY 分开统计，不自动换算，不修改员工钱包或积分。
- 内置用户在 2026-09-16 提供的 5 张 OpenLux 截图中完整显示的 56 个模型价格（46 个 Token 计费、10 个按次计费）。仅匹配供应商 `api.openlux.ai` 或 `openlux`，不把截图价格套到 `yunwu.ai` 或其它上游。同名模型的管理员自定义费率优先，其他已有自定义配置保留。
- 截图美元单价不额外乘分组或阶梯倍率，界面统一标为估算；只有工具服务端拿到供应商明确账单时，才能上报 `costBasis: actual`。这不是供应商账单，也不会扣员工积分。
- 估算公式：`[(输入-缓存命中-缓存写入)×输入单价 + 缓存命中×缓存单价 + 缓存写入×写入单价 + 输出×输出单价] / 1,000,000`。有 `perCall` 则使用按次单价。当前配置为每供应商域名、模型一组固定费率；阶梯或多个令牌分组的费用需以供应商账单为准。
- 费率随新完成记录保存快照；已有实际扣费、已有估算金额及币种保持不变。历史已完成且金额为空的记录，在管理员查询时按当前费率补算并标为“按当前费率补算”，不改写原始账目。没有历史用量的调用无法还原。
- 缺失单价为 `null`，有对应消耗时显示待核算，不当作免费。`gpt-image-2` 和 `gpt-image-2.5-sunburst` 有不同的图片输入价，需要 `imageInputTokens`（上游 `input_tokens_details.image_tokens`）；没有输入分项时不猜测混合输入的价格。按次模型没有 Token 也可按一次成功调用估算，失败/中断/待完成状态不套用按次价。
- 面板展示累计金额、员工/来源/模型汇总，以及每次调用的“计费依据”；费率编辑器可覆盖默认单价或恢复截图价。输入总量包含缓存和图片，普通输入计费时扣除这些分项，避免重复计价。
- 每个上游请求（包含重试）各记一次。流式取消/网络失败保留状态。进程异常退出留下 `pending`，显示“待完成 / 待核对”，不冒充零消耗或成功。
- 汇总表与调用明细将“来源”“模型”分列。聊天请求从服务端已验证的智能体取得 `botId`、`botName`，来源显示调用时的智能体名称，模型显示实际请求的上游模型。汇总同时按智能体 ID 和名称快照分组，避免同一模型下的不同智能体合并。历史没有记录智能体的行显示“未记录智能体”，不猜测或回填。

## 本仓库自动采集范围

Next 主站：直接聊天、会话聊天、扩展聊天、工作流设计/执行、报告、欢迎语、管理员提示词助手、Gemini 图片/视频理解、记忆嵌入、模型联网检索。

Express 独立后端：聊天、工作流设计/执行、图片生成，以及视频提交和状态查询。视频提交后保持待完成；查询到终态才结算。未再查询或服务异常中止的任务保持待核对。

语音转写使用另一个 WebSocket 服务，目前没有 Token 或金额返回，未接入本计量器。外部 SSO 工具不是主站进程内的调用，需要接入下方协议。仅登录 SSO 无法获知工具随后消耗的 Token。历史未采集数据不会自动出现。

两服务必须连接同一个 PostgreSQL 数据库才能统一汇总。`ai_usage_events` 是新增表，两个 Prisma schema 均已声明；运行时在第一次采集/查询时创建表和索引，不删除原有表、不改钱包。生产数据库账号需有建表权限，或由运维预先按 schema 建表。

两服务独立打包，`usage-values.ts`、`usage-fetch.ts`、`usage-ledger.ts` 保持同一实现，测试会检查一致性。

## SSO 工具上报协议

此提交只修改本仓库，不会自动修改、部署其他工具。主站提供 `POST /api/sso/usage`；它与钱包扣费接口相互独立，不能用它代替 reserve / settle。

主站环境变量：

```text
SSO_USAGE_SECRETS={"chanpinsheji":"各工具独立的至少32字符随机密钥","sabc":"另一个独立随机密钥"}
```

各工具仅在服务端保存自己的密钥；不得放到 `NEXT_PUBLIC_*` 或前端 JS 中。可使用 `xiaoshou`、`baokuangaixie`、`seedance` 等其他工具名，必须与主站配置的键完全一致。

服务端请求示例（以下数值仅演示协议）：

```http
POST /api/sso/usage
Content-Type: application/json
x-usage-tool: sabc
x-usage-secret: <该工具的服务端密钥>
```

```json
{
  "userId": "SSO交换得到的主站员工ID",
  "requestId": "工具服务端持久化的每次上游请求唯一编号",
  "provider": "api.openlux.ai",
  "model": "gpt-5.6-luna",
  "status": "completed",
  "tokenBasis": "reported",
  "inputTokens": 1000,
  "outputTokens": 300,
  "cachedInputTokens": 200,
  "cacheWriteTokens": 0,
  "reasoningTokens": 0,
  "totalTokens": 1300
}
```

可以附带 `amount`、`currency`（USD/CNY）、`costBasis`（actual/estimated）及 `upstreamRequestId`。不传金额时主站按已配置费率估算。图片按次计价且无 Token 时，各 Token 字段应为 `null`、`tokenBasis` 为 `missing`。

还可附带工具服务端确认的 `botId`、`botName`（各为 1–200 字符，前后空白会去除），用于区分子站内的智能体。旧版上报仍兼容，但没有名称的记录会标为“未记录智能体”。来源标识仍由鉴权工具决定，固定为 `sso:<工具名>`，不能由请求正文覆盖；`kb-chat` 与 `qyzsk` 显示为“起芽知识库机器人”。

如上游提供图片输入分项，可附带非负整数 `imageInputTokens`，不得超过输入总量。供应商字段应填写实际请求的 hostname；不要把云雾调用标为 OpenLux。

### 起芽知识库 OpenLux 接入

知识库新版的 OpenLux 调用默认上报到主站 `/api/sso/usage`，旧的 `/api/internal/usage-events` 配置会自动切换路径。主站 `SSO_USAGE_SECRETS` 需加入 `"kb-chat":"至少32字符的共享密钥"` 并保留已有工具键；值必须等于知识库服务端的 `USAGE_MONITOR_INTERNAL_SECRET`。知识库还需配置已有的 `MAIN_APP_URL`。此密钥用于用量上报，和 `OPENLUX_API_KEY` 无关。

其它 SSO 工具已经通过 `/api/sso/usage` 或主站工具结算接口上报的 OpenLux 用量同样使用默认价格。尚未接入上报的工具不会仅因 SSO 登录而自动产生用量记录。

工具必须从已验证的 SSO 会话取得 userId，不接受浏览器随意指定员工。使用数据库 outbox 保存待上报事件，收到 `success:true` 后确认，网络/5xx 失败保留并重试；使用同一个 requestId。首次终态记录不可被重放覆盖。同一工具不同真实上游重试必须使用不同 requestId。上报不发送提示词、回复正文或 API Key。统计日期为主站接收时间，延迟补报不会倒填历史日期。

## 验证

```sh
cd frontend
node --test tests/usageMonitor.test.mjs
node --test tests/usageAttribution.test.mjs
node --test tests/usagePricing.test.mjs tests/usageRateCatalog.test.mjs
# 使用隔离的本机 usage_test 数据库，先应用 frontend Prisma schema：
USAGE_TEST_DATABASE_URL=postgresql://...@127.0.0.1:15483/usage_test node --test tests/usageMonitor.integration.test.mjs
npm run build
cd ../backend
npm run build
```

集成测试验证真实 PostgreSQL 上的并发重复上报、不可覆盖终态、金额/币种分离、员工/日期筛选、无用量空值和管理员鉴权。
