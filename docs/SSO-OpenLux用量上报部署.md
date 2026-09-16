# SSO OpenLux 用量上报部署

本次覆盖起芽知识库、买家秀、店铺图、文案、视频工作台、产品设计、SABC、销售助手、爆款改写。按用户要求排除 TikTok Studio；只根据实际请求域名 `api.openlux.ai` 统计 OpenLux，不改变工具原有模型和上游地址。

## 1. 先更新主站

更新 `wb-dianshangjiqiren` 后，`POST /api/sso/usage` 支持 `pending` → `completed` / `failed` / `interrupted`。同一工具、同一 `requestId` 只保存一次最终状态，重复补报不会重复计费。

保留主站现有 `SSO_USAGE_SECRETS` JSON 中的所有配置，确保存在下列对应键：

| 工具仓库 | JSON 键 / x-usage-tool |
| --- | --- |
| qyzsk | `kb-chat`（保留原 `qyzsk` 键，另加 `kb-chat`） |
| maijiaxiu | `maijiaxiu` |
| dianputu | `dianputu` |
| wenan | `wenan` |
| seedance | `seedance` |
| chanpinsheji | `chanpinsheji` |
| sabc | `sabc` |
| xiaoshou | `xiaoshou` |
| baokuangaixie | `baokuangaixie` |

每个键的值至少 32 个字符，与该工具的 `USAGE_MONITOR_INTERNAL_SECRET` 完全相同。不要把 OpenLux API Key 填到这些位置；不要把密钥放入源码或 `NEXT_PUBLIC_*`。

## 2. 再更新各工具

每个工具的服务端配置：

```dotenv
MAIN_APP_URL=https://你的主站域名
USAGE_MONITOR_INTERNAL_SECRET=主站JSON中这个工具对应的密钥
```

已有这两个变量且值正确时无需重复添加。新代码复用原来的模型 API Key，无需新增供应商 Key。

为失败补报配置持久存储：

- 知识库：优先复用 `DATABASE_URL`，自动创建 outbox 表；无数据库时设置 `USAGE_MONITOR_OUTBOX_DIR=/持久卷/kb-usage`。
- 产品设计：Cloudflare Workers 绑定 `DB`（D1）；Node 部署设置 `USAGE_MONITOR_OUTBOX_DIR=/持久卷/chanpinsheji-usage`。
- 其它工具：按各仓库 `README.md`、`docs/openlux-usage-reporting.md`（文案和视频工作台为 `docs/openlux-usage.md`）挂载其队列目录，可通过 `USAGE_MONITOR_OUTBOX_DIR` 指定。队列不能放在临时盘、公共文件目录或构建输出目录。

各工具在后续调用中尝试补报，并提供手动补报命令；详见各仓库说明。没有新增常驻调度服务。无后续访问时，可将补报命令加入现有部署调度器。

产品设计、SABC、销售助手、爆款改写仍执行原 reserve / settle / release 业务流程。新工具携带 `usageReportedSeparately: true` 时，主站只关闭旧流程产生的重复用量行，保留业务请求记录。此标记在一次请求生命周期中不能改变，因此必须先部署主站再部署这些工具。

## 3. 面板计算口径

- 按截图报价匹配实际模型 ID。Token 模型分别计算普通输入、缓存命中、缓存写入、图片输入和输出；推理 Token 已包含在输出中。
- 图片或视频的按次报价按实际请求计一次。下载图片、轮询视频状态不新增模型调用；每次真实重试是另一条上游调用。
- 已完成的按次模型即使没返回 Token，也可计价。失败或未完成不猜测费用；模型或消耗分项缺少单价时显示“待核算”。
- 无 Token 返回时记录 `null`，不使用文字字数冒充接口用量。缓存与推理不会重复加入总 Token。
- `gemini-embedding-2-preview` 的单价未在截图中完整出现；如果实际经 OpenLux 调用 `text-embedding-3-small` / `text-embedding-3-large`，也需要补充报价。其它未匹配模型同样保留用量等待补价，不按相似名称套价格。
- 金额是按所给报价计算的估算；不保证包含供应商折扣、长上下文阶梯或未提供的附加计费项。

旧版本未留下上游用量、员工归属或模型身份的历史请求无法自动补齐；持久队列补报从新版启用后开始。更新代码不等于线上已部署。

## 验证

主站本地隔离 PostgreSQL 联调覆盖鉴权、并发重复上报、视频 pending → completed、迟到失败/重复 pending、按次图片/视频金额、历史估算及新旧上报去重。各工具使用模拟上游验证实际请求接线、员工归属、Token 解析及队列重试，不调用付费模型或生产数据库。

## 代码交付（2026-09-16）

下表列出用户明确指定的部署分支，代码已推送到这些分支。各工具以对应分支原有代码为基础迁入 OpenLux 上报，保留该分支的 SSO、上传、后台任务和积分流程。此前指向错误分支的合并已回退，不要使用旧 PR 的目标分支部署。Git 推送本身不代表线上已启用，仍需按上述顺序部署。

| 项目 | 代码入口 | 验证结果 |
| --- | --- | --- |
| 主站 | [main：79b4d0b](https://github.com/zxc9802/wb-dianshangjiqiren/commit/79b4d0b0d09cf26677794a09d50f9dc165ec0fd7) | 28 项相关测试及生产构建通过，含隔离 PostgreSQL 联调 |
| 起芽知识库 | [master：d31dd51](https://github.com/zxc9802/qyzsk/commit/d31dd51ddf133561335490f1ec3127fa0e32a9e6) | 103 项通过，1 项原有可选数据库测试跳过；生产构建和修改文件 lint 通过 |
| 买家秀 | [master](https://github.com/zxc9802/maijiaxiu/tree/master) | 28 项测试、生产构建、类型及 lint 通过；保留 base64 上传和可空商品信息 |
| 店铺图 | [main](https://github.com/zxc9802/dianputu/tree/main) | 8 项上报测试、Python 编译检查、前端测试及生产构建通过；覆盖 3 个新增风格后台入口的员工身份 |
| 文案 | [wb](https://github.com/zxc9802/wenan/tree/wb) | 52 项测试、ESLint 及生产构建通过；补报 CLI 在模拟 Docker 运行目录内实际投递通过 |
| 视频工作台 | [master](https://github.com/zxc9802/seedance/tree/master) | 123 项通过，5 项可选 PostgreSQL 集成跳过；其中上报 20 项通过，生产构建及语法检查通过 |
| 产品设计 | [wb](https://github.com/zxc9802/chanpinsheji/tree/wb) | 42 项测试及生产构建通过；修改文件 lint 无错误，配置域名的 SSO 回跳已验证 |
| SABC | [wb](https://github.com/zxc9802/sabc/tree/wb) | 208 项测试、7 项队列测试及生产构建通过；修改文件 lint 无错误 |
| 销售助手 | [wb](https://github.com/zxc9802/xiaoshou/tree/wb) | 119 项全量测试、8 项上报测试、前端及 API 构建通过；会话过期跳配置主站的流程已验证 |
| 爆款改写 | [wb](https://github.com/zxc9802/baokuangaixie/tree/wb) | 8 项上报测试、4 项 SSO/业务计费测试、生产构建及修改文件 lint 通过 |

已知基线问题：店铺图 `main` 原始基线 166 项测试中有 14 项失败，迁移后 174 项中的失败项完全相同；产品设计完整 lint 仍有 3 个既有错误，对应文件与 `wb` 基线相同。主站此前完整测试有 2 项原有文本断言失败；本轮只迁移工具分支，主站和知识库沿用此前已完成的功能验证结果。Seedance 的积分与数据库模块与目标 `master` 一致，未配置测试数据库时 5 项可选集成测试跳过。文案已验证 Docker 运行阶段复制的脚本依赖，但本机无 Docker，未执行实际镜像构建。以上结果不包含付费上游实测或生产环境验收。
