# 员工 Token 与金额监控

入口：管理员后台 → 员工用量监控（`/admin/usage`）。普通员工不能读取汇总、明细或修改费率。

## 计量口径

- 输入 Token 包含缓存读取和缓存写入；输出 Token 包含推理 Token，不重复相加。支持 OpenAI Chat Completions、Responses、Gemini、Anthropic JSON 与 SSE。
- 上游没有返回用量时存 `null`，前端显示“未返回”。不能用字符串长度冒充实际 Token。
- 金额分为供应商实际扣费、估算、待核算。USD 和 CNY 分开统计，不自动换算，不修改员工钱包或积分。
- 主站目前按管理员费率估算；只有工具服务端拿到供应商明确账单时，才能上报 `costBasis: actual`。OpenLux 广场的分组、缓存、阶梯价格不等于每个 API Key 的实际扣费，故没有默认写入最低报价。
- 估算公式：`[(输入-缓存命中-缓存写入)×输入单价 + 缓存命中×缓存单价 + 缓存写入×写入单价 + 输出×输出单价] / 1,000,000`。有 `perCall` 则使用按次单价。当前配置为每供应商域名、模型一组固定费率；阶梯或多个令牌分组的费用需以供应商账单为准。
- 费率随完成记录保存快照，修改只影响后续结算的估算；历史账目不重算。
- 每个上游请求（包含重试）各记一次。流式取消/网络失败保留状态。进程异常退出留下 `pending`，显示“待完成 / 待核对”，不冒充零消耗或成功。

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

工具必须从已验证的 SSO 会话取得 userId，不接受浏览器随意指定员工。使用数据库 outbox 保存待上报事件，收到 `success:true` 后确认，网络/5xx 失败保留并重试；使用同一个 requestId。首次终态记录不可被重放覆盖。同一工具不同真实上游重试必须使用不同 requestId。上报不发送提示词、回复正文或 API Key。统计日期为主站接收时间，延迟补报不会倒填历史日期。

## 验证

```sh
cd frontend
node --test tests/usageMonitor.test.mjs
# 使用隔离的本机 usage_test 数据库，先应用 frontend Prisma schema：
USAGE_TEST_DATABASE_URL=postgresql://...@127.0.0.1:15483/usage_test node --test tests/usageMonitor.integration.test.mjs
npm run build
cd ../backend
npm run build
```

集成测试验证真实 PostgreSQL 上的并发重复上报、不可覆盖终态、金额/币种分离、员工/日期筛选、无用量空值和管理员鉴权。
