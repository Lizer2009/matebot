# Matebot A2UI 通用能力与 Surface 最佳实践规格 v1.1（已批准导出）

> **Handoff artifact only** — exported from canonical Page for CloudAgent; not a user-facing deliverable.
>
> | 字段 | 值 |
> |---|---|
> | Canonical Page URL | (private share link, omitted from the public repo) |
> | canvas_id | (omitted) |
> | Spec version on Page | v1.1（Page 标题仍标「待审核」；语义以本批准导出为准） |
> | Approval | 用户 t233 / 对话消息「规格OK 继续」（Asia/Shanghai 2026-11-07）批准 v1.1 并继续实现 |
> | Export | UTF-8 Markdown；语义与 Page 一致，未新增需求 |
> | Matebot tip | `ebca31d5bcfc8d09c7907dace0e3c81375116eb8` |
> | A2UI upstream HEAD | `7791823d06a5326f3dcea577c91adb39a4e72383` |
> | Matebot pin | `dee8167996b0a802b18b3ebe51f3515c55b757de` |
> | npm web_core/react | 0.15.0 |

**摘要（来自 Page）：** 在 v1.0 架构与安全契约之上，纳入多轮 UX、结构化交互决策、稳定 Surface 修订并发、任务示例语料与可测验收。供审核迭代后的实现交接；FEATURE_A2UI 默认关闭；不升级依赖、不合入 main、不部署、不改 memory（除非另有单独授权）。审计未做新的运行时验证；「现状」来自 tip ebca31d5 只读对照。性能目标为提案数值，非已测基线。

**证据等级：** 现状=已核实源码；提案=设计要求；未运行时验证=未新跑端到端。设计名（如 `FieldsEditor`、`InteractionDecision`、`capability registry`）是提案命名，不等于当前代码已有类型或表。

---

## 目录

0. 元数据与 v1.1 变更摘要
1. 一句话结论
2. 审计现状与缺口
3. 设计目标与非目标
4. 五层架构
5. 核心契约
6. 交互决策与多轮 UX
7. 任务族与示例语料
8. 分阶段交付
9. 验收标准
10. 迁移、遥测与测试分层
11. 架构决策与取舍
12. 审核范围
13. 源码与上游链接

---

## 0. 元数据与 v1.1 变更摘要

| 字段 | 值 |
|---|---|
| 版本 | v1.1 · 继承 v1.0 架构/安全/审计事实 |
| 协议 | 默认 v0_9；v1_0 仅保留，禁止静默升级 |
| pin→HEAD 差异 | 审计结论：仅文档差异 |

### v1.1 相对 v1.0 的增量

1. 澄清：可合理承接广泛自然语言任务 ≠ 任意可执行能力、≠ 意图 100% 准确；基础问答保持纯文本。
2. 新增：输入理解族 QUERY / ANALYZE / CREATE / UPDATE；仅在歧义实质影响结果（尤其副作用）时最小澄清。
3. 新增：结构化 InteractionDecision 契约（提案）与服务端权威。
4. 新增：多轮同一 Surface（自然语言改 + 直改字段）、乐观并发 revision、用户编辑保护、SSE 乱序丢弃。
5. 新增：在途动作、取消语义、加载/鉴权恢复/跨端、安全降级与强制出卡禁令。
6. 新增：12 条多轮示例语料 + UX 验收矩阵；性能目标与遥测隐私分列，不声称已跑。
7. 修订分期：UX/决策/稳定事件流并入 Phase 0 基础，不再作为末尾可选项。

---

## 1. 一句话结论

**核心判定：** 产品应在有限可信 catalog 上动态组合丰富界面，合理承接广泛任务；但可执行能力仍须登记，服务端拥有 schema 与动作。缺口仍是通用表单编译、动作回传、双端一致性与能力闸门——不是为每个提示词造模板。多轮 UX（同卡修订、防丢字段、防重复副作用）属于基础契约，必须在 Phase 0 落地。

任意提示词不会自动获得任意可执行卡片；基础事实问答默认纯文本。销售图有真实数据时可走 `render_plot` PNG 或后续结果 Surface；无数据则追问来源，禁止编造数字。

---

## 2. 审计现状与缺口

### 2.1 已核实：协议与 catalog

| 项 | 现状（已核实） | 含义 |
|---|---|---|
| basic catalog | 上游 18 组件；Matebot guard 已包含这 18 项 | 白名单有 ≠ 对话里能生成/可交互 |
| 组件清单 | Text Image Icon Video AudioPlayer Row Column List Card Tabs Modal Divider Button TextField CheckBox ChoicePicker Slider DateTimeInput | 不得伪造 basic 含 Table/DataGrid |
| 编译器 | `packages/a2ui-adapter/src/compile.ts` 约 L129–155：固定 Column + 3×Text | 无字段控件树 |
| intent | `contracts/src/interaction.ts` 约 L40：自由字符串 | 无严格运行时 Capability 注册闸门 |
| Web 宿主 | `A2uiSurfaceHost.tsx` 约 L47：MessageProcessor([basicCatalog])，无通用 actionHandler | 通用按钮事件未闭环 |
| Web 邮件 | `A2uiSurfaceCard` 对 email 走专用编辑器；其他 intent 只读通用宿主 | 非邮件回落只读 |
| 客户端回落 | 非邮件 publisher 不盖 email 模板；email-draft 是客户端回落；sim 曾错误强制盖戳 | 不得用强制 stamp 掩盖产品缺口 |
| 移动端 | `apps/mobile/lib/a2ui-catalog.ts` 约 L12：仅 5 类组件允许列表 | 勿臆造其名称；与 Web 不一致 |
| 图表扩展 | 上游独立目录 VegaChart：`catalogs/vegachart/v0_9/catalog.json` | 非 basic；npm `@a2ui/catalog-vegachart` 返回 404 |
| 现有图表路径 | `render_plot`（builtin-tools 约 L663）→ PNG；Web `message-view.tsx` 约 L570 可渲染；mobile 当前无图表渲染器 | 销售图可走真实数据+PNG，非 A2UI 交互图 |

### 2.2 已核实：邮件 / 日历 / 审批相邻能力

| 能力 | 现状 | 缺口 |
|---|---|---|
| email.compose | 代码级预检、单次 Send、UNKNOWN 生命周期思路存在 | 未做新的 live send 运行时验证 |
| calendar.create | 有 normalization + 授权后续跑（postconnect resume） | 缺草稿编辑器与提交端到端闭环 |
| 日历查询（如「下周日程」） | 应是读结果，不是创建 | 提案：不得与 create 混为同一草稿卡 |
| MCP 审批 | 已有 `mcp_approval`，在 A2UI 外 | 可统一展示风格，不得吞掉审批语义 |
| 采购/支付审批 | 已有独立审批路径 | 必须保留；A2UI 不得绕过 |
| 其他工具族 | files / shell / usercomputer / browser / search / schedules / tickets / purchase / cloudagents / memory / skills / fleet 等已有工具路径 | 多数非 A2UI；禁止宣称每个工具都必须出卡 |

避免把工具目录条目数当成一对一「待注册卡片数」。任务族按可复用 Surface 类覆盖，而不是按工具名爆炸。

### 2.3 缺口摘要（可执行）

1. 通用编译器不会把字段 schema 变成 TextField / DateTimeInput / ChoicePicker / Button
2. Web 无通用 action 回传桥；非邮件 Surface 只读
3. 移动端 catalog 收窄，双端契约未对齐
4. intent 自由字符串，缺少服务端能力登记与动作白名单绑定
5. 缺少结构化交互决策与多轮同一 Surface 的 revision/用户编辑保护（v1.1 新增要求）
6. 日历第二域缺少可编辑草稿与真实创建提交
7. 结果型 Surface（表/图）契约与数据溯源未定义；Vega 扩展未评估接入

---

## 3. 设计目标与非目标

### 目标

- 广泛任务可合理承接：有限可信 catalog 动态组合界面；基础问答保持文本
- 扩展现有 Thread / MessageBlock / oRPC SSE / ExternalEffect，而非新建 ActionExecution 表或包爆炸
- 共用生命周期壳 + 通用字段编辑 + 少量域编辑器；多轮同卡修订
- 模型只提议已允许组件与已登记能力数据；服务端校验、调度与 revision 权威
- FEATURE_A2UI 默认 off；公开仓库不动 main、不合入、不静默升级协议
- 日历作第二域样板；结果表/图在数据获取之后分阶段

### 非目标（本规格明确不做）

- 不为每个提示词、每个工具、每个 App 单独造一套模板矩阵
- 不保证任意意图分类 100% 准确；不把「能聊」当成「已登记可执行能力」
- 不把销售趋势伪装成「注册一个销售编辑器」就能出图；无数据不编造
- 不引入任意 HTML/JS/外链/未审计 Vega remote fetch
- 不在 A2UI 提案中重命名环境变量；不在未批准时升级依赖或部署
- 不把 sim 强制模板盖戳、也不把提案性能目标当成已测结果

---

## 4. 五层架构

提案分层（继承 v1.0）。层间只传已校验结构；可执行权限不随模型输出漂移。v1.1 在 L2 增加 InteractionDecision，在 L4/L5 明确 revision 与用户编辑保护。

### 层流（逻辑）

```
L1 业务能力登记（服务端拥有）
  → 允许的 intent/字段/结果类型
L2 决策+展示计划（Decision ≠ 权限）
  → 校验后的 plan（不可信输入）
L3 可信编译器/目录（basic 18 + 可选扩展）
  → A2UI 文档树
L4 Web/Mobile 宿主与事件桥（渲染+编辑+action）
  → 白名单 action + revision
L5 现有运行时/Effects（SSOT+revision）
  ⇠ 状态投影 SSE（虚线回传）
```

| 层 | 职责 | 明确禁止 |
|---|---|---|
| L1 Capability Registry | 登记 intent、所需 Connection、effect kind、字段/结果 schema、处理器 | 模型现场发明未登记能力 |
| L2 Decision + Presentation Plan | InteractionDecision + result/form/review/progress 计划 | 把展示计划当成授权令牌 |
| L3 Compiler + Catalog | 只输出可信 catalog 内组件；schemaVersion/能力版本协商 | 任意代码、HTML、未允许 URL |
| L4 Host + Event Bridge | 渲染、直改字段、NL 同卡更新、主按钮回传；双端降级 | 宿主直连第三方发送绕过服务端 |
| L5 Runtime / Effects | 预检、幂等、执行、UNKNOWN、resume；revision SSOT | 为 UI 另造可漂移 DB 状态机 |

**路径约定：** 已核实现有文件保持引用；新增文件仅作提案路径（无伪造行号）。例如现有 `packages/a2ui-adapter/src/compile.ts`、`apps/web/src/components/a2ui/A2uiSurfaceHost.tsx`、`apps/mobile/lib/a2ui-catalog.ts`、`packages/adapters/src/builtin-tools.ts`；提案可增 decision/fields-schema/action-bridge/CalendarComposeEditor 等，具体落点以实现 PR 为准。

---

## 5. 核心契约

### 5.1 展示类（最小区分）

| 类 | 用途 | 是否可编辑 | 主按钮 |
|---|---|---|---|
| progress / lifecycle | 未连接、重授权、提交中、成功、失败、UNKNOWN | 否（或仅次要操作） | 按域注入文案 |
| form / draft | 用户审字段后触发副作用 | 是 | 单次主操作（发送/创建） |
| review | 只读确认高风险摘要（可选） | 默认否 | 确认执行 |
| result | 列表/摘要/表/图 | 否；筛选/图型控件可选 | 无强制 Connect/Send |

共用生命周期壳：connection / reauth / submitting / progress / success / failed / reconcile。禁止按 App 复制平行生命周期模板。域草稿仅在复杂度证明必要时增加；默认 `FieldsEditor(schema)`。禁止无能力时强制出卡。

### 5.2 Capability 登记（提案）

1. 每项能力声明：intent、输入字段 schema、结果类型、所需 Connection（可空）、effect kind、风险级别、处理器入口。
2. Connection 取决于数据源/提供方：远程只读可需登录；本地文件分析可不需远程 Connection；变更类必须走原有审批与 Effects。
3. 未登记 intent：服务端拒绝可执行 Surface 动作；可降级为人类可读说明或纯文本，不得出现可执行危险按钮；禁止 secret shell 旁路。
4. 功能协商：per-surface `schemaVersion` + capability 版本；未知则人类可读回落。

### 5.3 安全与动作绑定（硬约束）

1. Plan / Decision 数据不可信：必须经服务端按登记 schema 校验。
2. 模型只能提议已允许组件与数据，不能输出任意代码/HTML/URL/endpoint/授权。
3. action 名称白名单；绑定 surfaceId + interactionId + userId + threadId + draftRevision。
4. 字段再次服务端校验；幂等键防止重复/过期提交；拒绝 stale revision。
5. 用户确认绑定精确草稿 revision：单次主点击；NL 改字段后须用当前 revision 提交，禁止「口头改完再静默重发」。
6. 改动已批准 payload → 确认失效，须重新确认当前 revision。
7. 授权 resume ≠ 自动发送/自动创建；UNKNOWN 仅 reconcile，禁止自动重试。
8. 禁止宿主直连发送路由绕过服务端 Effects。
9. 状态转换复用现有 status；UI 状态是投影。设计名不是现有 DB 枚举。

### 5.4 日历域专用契约（第二域样板）

1. 创建：可编辑 name / timeRange / 时区 / 是否全天 / attendees 范围（按能力声明）；默认时区 Asia/Shanghai，除非用户显式指定。
2. 批量：允许部分成功结果卡；不得在未请求时批量邀请或批量创建。
3. 查询「下周日程」= result Surface，不是 create draft；禁止把读当成写。
4. 成功/失败/进度复用共用生命周期；connection/reauth 复用共用壳，仅换文案与 provider。

### 5.5 通用 FieldsEditor 与邮件兼容

1. schema 类型与上限由服务端校验；专用域编辑器仅在复杂度证明后引入。
2. 邮件保留：旧快照可渲染；迁移兼容；email 专用编辑器可继续存在，但生命周期抽共用；支持直改字段 + NL 同卡更新 + 单次提交。
3. 未知 catalog / 畸形 payload：服务端禁止执行；客户端人类可读回落，无危险可执行按钮。

### 5.6 结果 / 表 / 图契约

1. 数据溯源必填：source、window、units、year、timezone、freshness；unknown/empty 与真实 0 必须可区分。
2. 聚合必须由确定性代码对真实数据计算；禁止模型编造 series。
3. 销售场景：不新造销售专用编辑器；切换季度须保留 source/unit；若无数据能力则询问数据源。Web 可继续用 `render_plot` PNG。
4. 仅筛选/图型等 view-only 变更可更新同一 result Surface；若触发远程再查询，仍强制后端权限。
5. A2UI VegaChart：独立扩展目录；禁止任意 JS、外链、remote Vega fetch；需许可证/构建/安全/体积评估；mobile 不得盲目引入 vega——降级 PNG/表 + 溯源，且不得丢安全关键主控。
6. basic 无 Table/DataGrid：简单表可用 Row/Column/List 组合；完整表格属扩展，不得假装已是 basic。

### 5.7 Catalog 支持矩阵（提案优先级）

| 组件组 | 目标 | 阶段优先级 | 降级 |
|---|---|---|---|
| 表单：TextField CheckBox ChoicePicker Slider DateTimeInput Button | 可编辑草稿 | P0（与事件桥同批） | 不支持则禁止声称可编辑 |
| 结构：Column Row Card Divider Text | 布局与文案 | P0 | 已部分可用 |
| List Tabs Modal Icon | 结果/组织 | P1 | 折叠为 Column/Text |
| 媒体：Image Video AudioPlayer | 结果附件 | P2 | 链接/占位说明 |
| 扩展 VegaChart / 未来 Table | 交互图/表 | P3 可选 | PNG / 文本表 + 溯源 |

长期目标：basic 18 在双端可达且行为一致；短期不承诺一次齐活。mobile 现仅 5 类允许——扩容必须显式、可测，并写清回落（含约 360px 窄屏）。

### 5.8 安全降级分类（提案）

| 情况 | 行为 |
|---|---|
| 已知不支持的 catalog/schema | 人类可读说明；无危险可执行按钮 |
| 不支持的数据/动作能力（含缺 GitHub→本机闭环） | 明确能力缺失与可选替代；禁止 secret shell 旁路 |
| 图表宿主不支持 | PNG/表降级 + 溯源；保留安全关键控件语义 |
| 基础事实问答 | 纯文本；强制不出卡 |

---

## 6. 交互决策与多轮 UX

### 6.1 任务承接边界

提案：系统应合理处理广泛自然语言任务请求——在有限可信 catalog 上动态组合界面——但这不等于任意可执行能力，也不保证意图分类永远正确。基础知识回答保持文本，不强制 Surface。

### 6.2 输入理解族

| 族 | 含义 | 出卡倾向 |
|---|---|---|
| QUERY | 只读查询（如下周日程、指标查询） | result；禁止当成 CREATE |
| ANALYZE | 分析/汇总（如销售趋势） | result（需真实数据）；无数据则追问 |
| CREATE | 创建副作用（邮件、会议） | form/draft + 单次提交 |
| UPDATE | 修改既有对象或未提交草稿 | 同卡修订或联动新草稿（见下） |

仅当歧义会实质影响结果——尤其副作用——时提出最小澄清问题。禁止默认把日历「读取」当成「创建」。代词/指代在多卡并存时含糊：必须澄清，不得猜错卡。

### 6.3 InteractionDecision（提案，非现有代码）

| 字段 | 用途 |
|---|---|
| taskIdentity | 稳定任务身份；决定同卡更新 vs 新卡 |
| intent/capabilityCandidates | 候选能力；最终由服务端裁定 |
| missingFields | 阻塞执行的缺失字段；驱动最小澄清 |
| permissions/sourceAvailability | 权限与数据源是否可用 |
| presentationChoice + reason | text / result / form / progress 等及理由 |
| version | 决策与 schema 版本，便于协商与回放 |

服务端对 capability、允许动作与 schema 拥有最终权威。模型输出的 Decision 只是提议，须校验后才能驱动 Surface 或 Effects。

### 6.4 同一任务 Surface：NL 与直改字段

1. 自然语言编辑与卡片内直接改字段更新同一任务 Surface；稳定 surface/task id。
2. 乐观并发：服务端 revision；提交必须携带精确当前 revision。
3. 保护用户已编辑字段，防止迟到的模型事件覆盖。
4. 过期或乱序 SSE 事件丢弃；不得回滚用户输入。
5. 仅「替代同一任务」的更新打到同一卡；真正的新任务开新卡。
6. 已确认/已执行记录不可变；修正须创建关联新草稿，并要求单独允许的 effect。
7. view-only 的筛选/图型变更可更新 result；远程再查询仍走后端权限。
8. 改动已批准 payload 使确认失效；主提交只接受当前精确 revision；禁止靠 NL 编辑触发静默重发。

### 6.5 在途动作、取消、加载与恢复

1. 动作进行中：禁用重复主点击；只读查询可继续，不得虚假「全局冻结」。
2. 取消：仅在运行时支持时请求 abort；effect 完成后不得声称可撤销。
3. 加载/鉴权恢复/刷新/跨端：保留草稿、状态与错误；禁止空白卡；立即给出真实 progress，禁止伪造百分比。
4. 鉴权 resume 后不自动执行；UNKNOWN 只走 reconcile。

---

## 7. 任务族与示例语料

### 7.1 任务族矩阵（实际 vs 目标 vs 阶段）

| 任务族 | 当前实际 | 目标可复用 Surface | 阶段 |
|---|---|---|---|
| 邮件撰写/发送 | 专用编辑器 + 生命周期思路 | 共用 lifecycle + email draft；多轮 NL+直改 | Phase 0 |
| 日历创建 | normalization + resume；无编辑提交闭环 | 共用 lifecycle + calendar draft / FieldsEditor | Phase 1 |
| 日历/日程查询 | 工具路径为主 | result 列表卡 | Phase 1 |
| 提醒/定时 | 已有工具 | 复用 DateTime 表单 | Phase 3+ 门控 |
| 销售分析/趋势 | 真实数据 + render_plot → Web PNG；无 A2UI 图 | data capability + result；无销售专用编辑器 | Phase 2（数据获取后） |
| 文件分析/搜索/网页结果 | 工具路径 | result 摘要/列表；需补参才用 form | Phase 2+ |
| 工单创建/修改 | 工具 + 功能开关 | 通用字段 form | 门控独立范围 |
| 采购/支付 | 独立审批 | 可复用 review；不得替代原审批 | 不纳入 A2UI 主链替代 |
| MCP 连接 | mcp_approval | 展示风格可统一，语义保留 | 并行，非本链阻塞 |
| GitHub→本机 | 可落到 shell；无受控闭环 | 缺能力则安全回落；禁止 secret shell 旁路 | 独立门控 |
| 长任务/云代理/子任务 | 工具路径 | progress + result + failed | Phase 2+ |
| 基础事实问答 | 对话文本 | 纯文本；强制不出卡 | 始终 |

### 7.2 初始语料：12 条多轮场景（提案门禁，未声称已跑）

| # | 场景 | 期望分类 | 期望 Surface 行为 |
|---|---|---|---|
| 1 | 本年度销售（有真实数据） | ANALYZE | metrics/趋势/明细 result；溯源完整 |
| 2 | 同上后改「看上季度」 | UPDATE view/window | 同卡更新；保留 source/unit；空≠0 |
| 3 | 无数据源时问销售 | ANALYZE 缺源 | 追问来源；禁止假数字 |
| 4 | 下周日程 | QUERY | 列表 result；禁止 create |
| 5 | 帮我约会议（缺时间） | CREATE 缺字段 | 最小澄清 → draft；可改时间 |
| 6 | 分析这个文件 | ANALYZE | 来源 + findings result |
| 7 | 写封邮件…再 NL 改收件人 | CREATE→UPDATE | 同卡；单次提交当前 revision |
| 8 | 简单事实问答 | 问答 | 纯文本；无卡 |
| 9 | GitHub 拉到本机（无能力） | 缺 capability | 安全回落说明；无 secret shell |
| 10 | 多卡并存「把它改一下」 | 指代歧义 | 澄清；不得改错卡 |
| 11 | 提交后鉴权中断再 resume | CREATE + reauth | 恢复草稿；不自动执行 |
| 12 | 在途发送时再点一次 + 另开只读查询 | 在途 | 禁用重复提交；查询可继续 |

**语料纪律：** 门禁要求：定义语料上场景通过率 100%、安全违规 0。不要求「全世界任意提示词 100%」。本表是初始语料定义，不是已测成绩。

---

## 8. 分阶段交付（UX 并入基础，非末尾可选项）

继承 v1.0：废止「每组件一套生命周期模板」。v1.1 修订：决策契约、通用管道、稳定版本/事件流与多轮同卡 UX 属于 Phase 0，契约测试通过前不得功能晋升。每阶段 FEATURE_A2UI 默认 off；无单独授权不升级依赖、不合入 main、不部署。

### Phase 0 — 基础：Decision + schema/编译器/事件桥 + 稳定 revision 流 + 邮件多轮迁移

InteractionDecision 校验；字段 schema→可信组件树；Web 通用 actionHandler；NL+直改同卡；用户编辑保护；SSE 乱序丢弃；邮件回归含多轮与 resume≠自动发送；旧快照兼容；禁止非邮件静默当 email-draft。契约测试先于功能开关晋升。

### Phase 1 — 日历第二域：create + read result + 多轮校验

calendar draft 或 FieldsEditor；真实 provider 创建；时区/全天/部分批量；查询走 result；跨端与 12 语料中日历相关行；扩展 a2ui-sim 且不得强制 stamp 掩盖缺口。

### Phase 2 — 结果列表/表/图（数据获取之后）

结果契约与溯源；列表/表优先；评估 pin VegaChart；保留 render_plot；mobile PNG/表降级；无数据能力则追问来源。

### Phase 3+ — 其他任务族门控接入

提醒、文件结果、工单、GitHub/本机等各自独立范围与开关；先登记 Capability，再决定是否需要专用编辑器。

### 分期约束 Checklist

- [ ] 扩展-first：Thread/MessageBlock/oRPC SSE/ExternalEffect（提案约束）
- [ ] 不新建 ActionExecution 表 / 包爆炸（提案约束）
- [ ] FEATURE_A2UI 默认 off；契约测试先于晋升（提案约束）
- [ ] 不在 A2UI 提案中重命名环境变量（提案约束）
- [ ] 公开仓 main 不合入；无单独授权不升级依赖/部署（流程约束）
- [ ] UX/多轮/revision 在 Phase 0，非末尾可选项（v1.1）

---

## 9. 验收标准

### 9.1 邮件回归（Phase 0 门禁）

| 场景 | 期望 | 证据类型 |
|---|---|---|
| 未连接 | connection 壳；无 Send 副作用 | 集成 / DOM |
| 需重授权 | reauth；resume 后不自动发送 | 集成 |
| 已连接但 provider 不活跃 | 可读失败/引导；无静默成功 | 集成 |
| 草稿直改 + NL 改 + 单次 Send | 同卡；revision 绑定；无字段丢失；重复点击幂等 | DOM + 服务端 |
| 成功 / 失败 / UNKNOWN | 状态投影正确；UNKNOWN 只 reconcile | 集成 |
| 旧快照刷新/跨端 | 保留草稿+状态+错误；无空白卡 | 集成 |

说明：邮件 compose 已有代码级生命周期，但本规格不将「未新跑的 live send」算作已验证通过。

### 9.2 通用表单、决策与动作桥

| 场景 | 期望 | 证据类型 |
|---|---|---|
| schema→控件 | 真实 DOM 出现 TextField/DateTime 等，而非仅 3 段 Text | DOM，禁止仅 sim |
| Decision 校验 | 服务端可拒绝非法候选/未知能力 | 单测 + 集成 |
| 按钮点击 | 白名单 action 回传并带 binding+revision | 集成 |
| 非法/过期 revision / 乱序 SSE | 拒绝或丢弃；无 Effects；不覆盖用户编辑 | 集成 |
| 未知 intent / catalog / 畸形 payload | 服务端禁止执行 | 单测 + 集成 |
| 未授权用户 | 无副作用 | 集成 |

### 9.3 UX 多轮验收（相对 12 语料）

| 检查项 | 期望事件/断言 |
|---|---|
| 同任务多轮 | 同一 surface 计数不增；revision 单调；用户字段不丢 |
| 新任务 | 新 surface；不覆盖旧卡 |
| 已执行修正 | 旧记录不可变；关联新草稿；单独 effect |
| 零未授权/重复副作用 | 语料内安全违规 = 0 |
| 指代歧义 | 澄清；零错卡写入 |
| 在途 | 主按钮禁用重复；只读查询仍可用 |
| 取消 | 仅支持时 abort；完成后不声称 undo |
| Web/mobile/≈360px | 可操作或显式降级；可访问标签与合理焦点变化 |
| reload/跨端 | 草稿+状态+错误恢复；无空白卡；progress 真实 |

### 9.4 日历（Phase 1）

| 场景 | 期望 |
|---|---|
| 创建草稿可编辑 | 字段可改；主按钮=创建 |
| 时区 | 默认 Asia/Shanghai；显式覆盖生效；起止/全天一致 |
| 部分批量 | 部分成功结果可区分 |
| 未请求邀请/批量 | 不发生 |
| 查询下周日程 | result 卡，不是 create draft |
| 真实 provider 执行 | 有集成或受控 live；与 sim 分层 |
| 跨端 | Web 可用；mobile 按允许列表或明确降级 |

### 9.5 连接、本地/远程、图表

| 场景 | 期望 |
|---|---|
| 本地只读分析 | 可不要求远程 Connection（按能力声明） |
| 远程只读 | 按提供方要求权限/登录 |
| 变更类 | 走原审批 + Effects |
| 图表溯源 | source/window/units/timezone/freshness；空≠0 |
| 禁止编造 series | 无真实数据则追问来源或失败，不出假图 |
| mobile 图表 | PNG/表降级；不盲引 vega；不丢安全关键控件 |

### 9.6 确定性语料门禁 vs 性能目标

| 类型 | 要求 | 备注 |
|---|---|---|
| 确定性门禁 | 定义语料（初始 12 条）场景通过 100%；安全违规 0 | 优先于模糊「全提示词正确率」 |
| 性能目标（提案） | 受控 harness 内、请求已到达后 first-feedback p95 ≤ 1s | 排除网络与模型提供方延迟；非已测基线 |
| 埋点（提案） | user-submit / first-feedback / plan-ready / surface-visible / action-confirmed / provider-result / reconciled | 模型与网络耗时分列上报 |
| 未运行时验证 | 本规格不声称任何性能或语料结果已跑过 | 上线验证另授权 |

### 9.7 CI / sim

1. 现有全量套件保持绿；`pnpm test:a2ui-sim` 扩展场景行——「写入规格」≠「测试已跑」。
2. sim fixtures ≠ 集成 ≠ provider live；禁止强制模板 stamp 掩盖产品缺口。
3. 用户可见中文短 nudge：出卡后简短提示，不替代卡片正文。

---

## 10. 迁移、遥测与测试分层

| 主题 | 要求 |
|---|---|
| 迁移 | 旧 email 快照继续可渲染；schemaVersion 协商；未知能力人类可读回落；多轮草稿跨端恢复 |
| 回滚 | 关闭 FEATURE_A2UI 回到原路径；不得抹掉已确认/进行中 Effects；不得把 UNKNOWN 降级成假成功 |
| 测试分层 | 单元（编译/Decision/校验）→ DOM/集成（事件桥/revision）→ 12 语料 → sim 对话行 → 受控 provider live（显式可跳过） |
| 遥测隐私 | 日志不得含密钥或业务原文；可记错误率/降级率/阶段耗时；生产验证另授权，本规格不声称已采集 |

---

## 11. 架构决策与取舍

| 决策 | 选择 | 取舍 |
|---|---|---|
| 任务承接 | 有限 catalog 动态组合 + 能力登记 | 广泛自然语言可处理，但可执行面仍有限 |
| 模板策略 | 共用 lifecycle + 域/通用草稿 | 避免 N×模板爆炸 |
| 多轮身份 | 稳定 task/surface + revision | 牺牲「每句新卡」换可编辑连续性 |
| 能力闸门 | 服务端 registry（现状尚无，属提案） | 牺牲任意 intent 自由出卡换安全可测 |
| 编译 vs 宿主编辑器 | 短期通用编译 + 必要宿主编辑器并存 | 对齐现网邮件；中期减少特例 |
| 图表 | 先 render_plot；Vega 可选扩展 | 避免未评估依赖与 mobile 体积；npm 404 |
| 状态真相 | 复用现有 status + Effects | UI 不另起可漂移状态机 |
| 双端 | 契约一致 + 显式降级（含 ≈360px） | 不假装 mobile 已支持全 18 |
| 质量度量 | 语料 100% + 安全 0 优先 | 不做不可能的「任意提示词全对」承诺 |
| 扩展方式 | 扩展现有管道 | 拒绝 ActionExecution 表/包爆炸 |

---

## 12. 审核范围

请确认 v1.1 是否可作为后续实现 PR 的唯一规格源：继承 v1.0 五层与安全硬约束；有限 catalog 动态组合承接广泛任务但非任意可执行能力；InteractionDecision + 多轮同卡 revision；UX 并入 Phase 0；12 语料确定性门禁；性能/遥测仅为提案目标。

审核确认项（历史记录；用户 t233 已批准继续实现）：

1. 是否同意「广泛任务合理承接」与「有限可执行能力登记」的边界表述？
2. 是否同意 InteractionDecision 与同卡 revision/用户编辑保护作为 Phase 0 必达？
3. 是否同意日历读≠写、基础问答不出卡、无数据不编造数字？
4. 是否同意初始 12 语料作为确定性门禁，而非宣称任意提示词全对？
5. 是否同意性能 p95 等仅为提案目标，须单独授权才测量/上线？
6. 是否同意无单独授权不得升级依赖、合入 main 或部署？

**批准备注：** 用户 t233（Asia/Shanghai 2026-11-07）回复「规格OK 继续」——批准 v1.1 并授权继续实现交接；本导出未新增需求。合入 main / 依赖升级 / 部署仍需单独授权（规格原文约束保留）。

---

## 13. 源码与上游链接

1. Matebot tip ebca31d5 — https://github.com/Lizer2009/matebot/tree/ebca31d5bcfc8d09c7907dace0e3c81375116eb8
2. compile.ts（Column+3×Text） — https://github.com/Lizer2009/matebot/blob/ebca31d5bcfc8d09c7907dace0e3c81375116eb8/packages/a2ui-adapter/src/compile.ts
3. interaction.ts（intent 自由字符串） — https://github.com/Lizer2009/matebot/blob/ebca31d5bcfc8d09c7907dace0e3c81375116eb8/packages/contracts/src/interaction.ts
4. A2uiSurfaceHost.tsx — https://github.com/Lizer2009/matebot/blob/ebca31d5bcfc8d09c7907dace0e3c81375116eb8/apps/web/src/components/a2ui/A2uiSurfaceHost.tsx
5. mobile a2ui-catalog.ts — https://github.com/Lizer2009/matebot/blob/ebca31d5bcfc8d09c7907dace0e3c81375116eb8/apps/mobile/lib/a2ui-catalog.ts
6. builtin-tools render_plot — https://github.com/Lizer2009/matebot/blob/ebca31d5bcfc8d09c7907dace0e3c81375116eb8/packages/adapters/src/builtin-tools.ts
7. A2UI upstream HEAD 7791823d — https://github.com/a2ui-project/a2ui/tree/7791823d06a5326f3dcea577c91adb39a4e72383
8. upstream basic catalog.json — https://github.com/a2ui-project/a2ui/blob/7791823d06a5326f3dcea577c91adb39a4e72383/specification/v0_9/catalogs/basic/catalog.json
9. upstream VegaChart catalog — https://github.com/a2ui-project/a2ui/blob/7791823d06a5326f3dcea577c91adb39a4e72383/catalogs/vegachart/v0_9/catalog.json
10. VegaChart samples README — https://github.com/a2ui-project/a2ui/blob/7791823d06a5326f3dcea577c91adb39a4e72383/samples/vegachart/README.md

标注提醒：本规格中的「提案」路径与类型名尚未落地；「现状」行号来自审计时 tip，后续提交可能漂移。未运行时验证项与性能目标不得被当作已上线或已测行为。
