# A2UI 编排规格 vs 设计 v1.1 / tip PR#26 — 差距分析

**对照基线：** `cursor/a2ui-nl-email-compose-surface-263a` @ `7ff96890eaeaf894b14a3852ee50844adb4ec4bb`（设计路线图 PR-1…PR-10 + 邮件卡单手势 Send；GitHub PR #26 HEAD）。  
**编排规格：** [`MATEBOT_A2UI_ORCHESTRATION_SPEC.md`](./MATEBOT_A2UI_ORCHESTRATION_SPEC.md)（2.0-PROD-SPEC 清理稿）。  
**架构锁：** [`matebot-a2ui-integration-design.md`](./matebot-a2ui-integration-design.md) v1.1。  
**事实源：** [`matebot-a2ui-source-audit.md`](./matebot-a2ui-source-audit.md)、[`matebot-a2ui-gap-checklist.md`](./matebot-a2ui-gap-checklist.md)。  
**采纳清单：** [`matebot-a2ui-orchestration-addendum.md`](./matebot-a2ui-orchestration-addendum.md)。  
**范围：** 文档 only。Feature flag `FEATURE_A2UI` 默认关闭。不改 `MATEBOT_*`。不合并进 `main`。

冲突时：**审计 > 设计 v1.1 > 本文件/addendum > 编排规格原文**。编排规格里的包路径在对齐前是意向，不是仓库目录。

---

## 0. 结论（先读）

编排规格要解决的产品问题成立：相对 Grok Bot 的审阅卡 / 原生能力编排，tip 上的 NL 发信仍然**经常逃到 Python**（`python3 -c` + `smtplib` / `request_secret` 注入的 `MAIL_*`），而卡片上的 **Send → 已发送** 走的是**离线假邮箱**，不是用户已连接的发信账户。

规格给出的**四条不变量应当采纳**（编排、状态权威、单按钮、状态驱动模板）。规格给出的**落地形状多数不能照搬**：新建 `interaction-contracts` / `interaction-runtime` / `action-runtime` / `interaction-catalog` / `a2ui-web`、平行 Interaction Orchestrator、新 Prisma `ActionExecution`，都与 v1.1 Extend-first 锁冲突。现有 `ExternalEffect` **可以**表达规格要的执行生命周期（含 UNKNOWN 对账），没有证据必须新表。

**下一实现 PR（本文件之后）：PR-A′ — 堵住邮件的 Python/shell 逃逸。** 这是对 Grok Bot 差距里用户痛感最高的一条。假发送与预检三态紧随其后（PR-B′），否则锁路由之后 Send 仍会把「已发送」写在离线邮箱上。

---

## 1. Tip 上实际有什么（证据）

设计 v1.1 的 PR-1…PR-10 已在本分支落地。PR#26（`40765374b` + lint `7ff96890e`）把邮件卡从 Confirm+发送收成一次手势：Send 先 `confirmInteraction` 再 `executeInteraction`。桌面复用 `apps/web`。

| 能力 | 路径 | 状态 |
| --- | --- | --- |
| Feature flag 默认关 | `packages/adapters/src/a2ui-feature.ts`；`apps/web/src/lib/feature-flags.ts`；`apps/mobile/lib/a2ui-flag.ts` | 已做。`FEATURE_A2UI` / `VITE_FEATURE_A2UI` / `EXPO_PUBLIC_FEATURE_A2UI` 仅 `1\|true\|on` 打开 |
| `present_interaction` | `packages/adapters/src/builtin-tools.ts`；`run-tools-interaction.ts`；`run-tool-selection.ts` | 已做。flag 关则工具不进选择集 |
| `InteractionPlan` → Surface | `packages/contracts/src/interaction.ts`；`packages/a2ui-adapter/src/compile.ts`；`packages/adapters/src/interaction-publish.ts` | 已做 |
| `a2ui_surface` 时间线 | `packages/contracts/src/events.ts`；`apps/web/src/pages/shell/message-view.tsx`；`apps/mobile/components/thread/message-bubble.tsx` | 已做 |
| 邮件审阅卡 | `apps/web/src/components/a2ui/EmailComposeEditor.tsx` | 已做 Discard + Send；无独立 Confirm 按钮（测试断言 `a2ui-email-confirm` 为 null） |
| Interaction 持久化 | `packages/db/prisma/schema.prisma` `Interaction` / `InteractionSurface` | 已做。`draftVersion` / `confirmedVersion` |
| 生命周期纯函数 | `packages/core/src/interaction-runtime.ts` | 已做 collecting / ready_for_review / awaiting_approval / executing / succeeded / failed / needs_connection / cancelled |
| 确认 → ExternalEffect | `apps/api/src/interaction-service.ts` `confirmInteractionService` | 已做。`kind: email.send`，`idempotencyKey` unique，`status: intended` |
| 发送 | 同文件 `executeConfirmedInteractionService` → `packages/adapters/src/interaction-email.ts` | **部分。** 默认 `new FakeComposioClient()`，写入进程内邮箱，不是用户 `Connection` |
| SSE | `threads.subscribe` + `thread.interaction.*` / `thread.surface.*` | 已做。没有独立 Action SSE 总线 |
| 工作区包 | `packages/` 现有 14 个目录 | **没有** `agent-runtime`、`interaction-contracts`、`interaction-runtime`、`action-runtime`、`interaction-catalog`、`a2ui-web`。`packages/persistence` 也不存在（Prisma 在 `packages/db`） |

`needs_connection` 只出现在类型里（`packages/core/src/interaction-runtime.ts`、`packages/db/src/interactions.ts`），创建 Interaction 的路径没有写入该状态。

---

## 2. 分类图例

每个编排条款归入一类（可并记部分落地）：

| 代号 | 含义 |
| --- | --- |
| **(a) done** | tip / PR#26 已满足产品意图 |
| **(b) design-only** | 设计 v1.1 已锁，代码未做完 |
| **(c) conflict** | 与 v1.1 不变量冲突，不可按原文落地 |
| **(d) missing** | 设计与代码都没有（或只有名字、没有行为） |
| **(e) speculative-path** | 包/文件/模型名在本仓库不存在 |

---

## 3. 编排条款对照表

### 3.1 §1 缺陷快照

| 条款 | 分类 | 证据与说明 |
| --- | --- | --- |
| 双重 Confirm + 发送 | **(a)** | PR#26：`EmailComposeEditor` 只渲染 Discard / Send；Send 内部 confirm+execute。规格 ASCII 画的是更早的卡，不是 `7ff96890` |
| 已发送 vs Internal server error 分裂 | **(b)+(d)** | 客户端仍 `setSent(true)`（`EmailComposeEditor.tsx` 在 `await onSend` 成功后本地置位）。`executeInteraction` 把 `InteractionEmailDeliveryError` 映射为 oRPC `BAD_REQUEST`，其余 rethrow → HTTP 500（`apps/api/src/routes/threads.ts`）。LLM 文本通道没有在 executing 时被挡住 |
| Capability Preflight | **(d)** | 无 `NOT_CONNECTED` / `EXPIRED` / `READY` 检查。`Connection.status` 是 `connected` / `pending` / `error` / `revoked`（`packages/adapters/src/connection-context.ts`）。Composio 远程另有 `EXPIRED`（`composio-connector.ts` `RECONNECT_STATUSES`），未接入 Interaction |
| Python / SMTP 逃逸 | **(d)** | 见 §5.1。提示词甚至教 `python3 -c`，A2UI 句仍写 “Missing SMTP credentials still use request_secret” |
| 模板按状态而非按意图 | **(b)+(d)** | 设计 §7.4 有生命周期；渲染按 `isEmailComposeIntent(block.intent)` 硬切到 `EmailComposeEditor`（`A2uiSurfaceCard.tsx`），没有连接/失败/UNKNOWN 模板 |

### 3.2 §2 四条不变量

| 条款 | 分类 | 建议 |
| --- | --- | --- |
| Orchestrate, Don't Reinvent | **(b)** 意图；**(c)** 若建成独立 Orchestrator 服务 | **HYBRID：** 采纳禁止为已注册能力写脚本；编排代码留在 `apps/api` + `packages/core`，嵌在 Run 下 |
| SSOT：仅服务端执行状态驱动「已发送」 | **(b)** 设计 §7.4「客户端不能自行宣称 SUCCEEDED」；代码违反 | **ADOPT** 意图。落点：`ExternalEffect.status` + `thread.interaction.updated` SSE，不是新 `ActionExecution` |
| 单按钮 / 高风险二次确认 | **(a)** 常规模板；**(b)** 高风险模态 | **ADOPT。** 中低风险保持 PR#26 的 Send。高风险继续用现有 `ask` + `ActionApprovalRule`，不要在同一张卡上再放 Confirm |
| `Template = f(Intent, CapabilityState, InteractionState, RiskLevel, Platform)` | **(d)** 公式；**(b)** 部分因子已有 | **ADOPT** 公式。实现为 `packages/a2ui-adapter` 编译输入 + `packages/core` 纯函数，不是新 catalog 包 |

### 3.3 §3 拓扑

| 节点 | 分类 | 真实落点 |
| --- | --- | --- |
| Pi / Agent Runtime | **(a)** | `packages/adapters/src/pi-runtime.ts`。不存在 `packages/agent-runtime` **(e)** |
| Interaction Orchestrator | **(c)** 平行系统 | **KEEP v1.1。** 现有编排是 `publishInteractionSurface` + `apps/api/src/interaction-service.ts` |
| Capability Resolver | **(d)** | 应扩展 `connection-context.ts` + `action-approval.ts` |
| A2UI Surface Compiler | **(a)** | `packages/a2ui-adapter` |
| SSE Stream Server | **(a)** | `threads.subscribe` oRPC `eventIterator`。禁止新 WebSocket 聊天总线（设计 §8.1） |
| Action Runtime | **(c)** | **KEEP。** `ExternalEffect` + `executeConfirmedInteractionService` + 将来 Graphile 对账 job |
| Capability Registry | **(b)** 设计 §9.1「Extend action-approval / connectors / builtin tools」；**(e)** 新包 | **HYBRID：** 注册表 = 现有 builtin + `ConnectorRegistry` + InteractionPlan intent，加一层**路由优先级**，不加新包 |
| Python 沙箱仅作计算降级 | **(d)** 且与现状相反 | `shell` 在 `APPROVAL_EXEMPT_TOOLS` 里（`packages/core/src/action-approval.ts`）；`run-instructions.ts` 明确教 `python3 -c` |

### 3.4 §4.1 工具分档

| 条款 | 分类 | 说明 |
| --- | --- | --- |
| Tier 1 Native `email.compose` / `email.send` | **(b)** compose 有工具；send 不是 agent 可选工具 | `email.send` 是 `ExternalEffect.kind`（`packages/core/src/interaction-effect.ts`），不是模型可调 tool。这是对的：模型只应 `present_interaction`。缺的是**强制**走这条路 |
| Tier 2 Connector / MCP | **(a)** 基础设施 | `ConnectorRegistry` / Composio。A2UI 发送**没有**调用用户连接，而是 `FakeComposioClient` |
| Tier 3 Workflow | **(d)** 对邮件 MVP 不必做 | 不要为发信引入 DAG 引擎 |
| Tier 4 沙箱禁网禁副作用 | **(d)** | 无 `smtplib` / `socket` 拦截。`run-tools-computer.ts` 把 `command` 交给 `sandbox.execute` |
| `packages/interaction-contracts/src/capability.ts` | **(e)+(c)** | 合约进 `packages/contracts` |

### 3.5 §4.2 预检三态

| 条款 | 分类 | 说明 |
| --- | --- | --- |
| `NOT_CONNECTED` / `CONNECTED_BUT_EXPIRED` / `CONNECTED_AND_READY` | **(d)** | 禁止再做一个并行布尔 `isBound`。映射现有 `Connection.status` + Composio `EXPIRED` |
| 未绑定仍可起草 | **(b)** 设计 Context-first / NeedsConnection | 代码未做：未绑定也出 Send |
| 非 READY 则挡住 Send、改连接卡 | **(d)** | TC-01 在 tip 上失败 |
| `packages/interaction-runtime/.../preflight.ts` | **(e)** | 纯函数放 `packages/core`，读连接放 `packages/adapters`，RPC 放 `apps/api` |

### 3.6 §4.3 状态机 vs 现有 `InteractionLifecycleStatus`

| 规格状态 | 现有状态 | 分类 |
| --- | --- | --- |
| `CREATED` / `RESOLVING_CONTEXT` | 无单独值；创建即为 collecting/ready_for_review | **(a)** 可折叠进现有状态 |
| `NEEDS_CLARIFICATION` | `collecting` | **(a)** |
| `DRAFT_PREPARED` | `ready_for_review` | **(a)** |
| `NEEDS_CONNECTION` / `REAUTH` | `needs_connection`（类型在，写入路径无） | **(b)** |
| `READY_FOR_ACTION` | `ready_for_review` 或 `awaiting_approval` | **(a)** 语义略混：PR#26 把确认折进 Send |
| `VALIDATING_ACTION` / `ACTION_SUBMITTED` | 无 | **(d)** 可作瞬时，不必新持久化值 |
| `EXECUTING` | `executing` + effect `ambiguous` | **(a)** |
| `SUCCEEDED` / `FAILED` | `succeeded` / `failed`；effect `completed`/`reconciled`/`failed` | **(a)** |
| `UNKNOWN` | **无** Interaction 值。最近的是 effect `ambiguous`（发送中）和工具路径 `uncertain` | **(d)** 设计 §9.2 提到 Worker 对账，未规定 UNKNOWN 禁止重试 |

不要为规格状态机再做一张 Interaction 表。扩展现有 enum 字符串，加上 `unknown`（或复用 `ambiguous` 表示「已提交、结果未决」）。

### 3.7 §4.4 模板矩阵

| 模板 ID | 分类 | tip 行为 |
| --- | --- | --- |
| `email-draft-card` | **(a)** | `EmailComposeEditor`（按 intent，不按状态） |
| `email-connection-card` / `email-reauth-card` | **(d)** | 未绑定仍显示 Send |
| `action-submitting-card` / `action-progress-card` | **(d)** | 仅 `busy` 禁用按钮 |
| `action-result-success` | **(d)** 假成功 | 本地 `sent` + 文案 `Sent` / 中文「已发送」；假 `deliveryId` |
| `action-result-failed` / `action-reconcile-card` | **(d)** | 错误是卡片下的 `role="alert"` 文本，不是状态模板 |
| `packages/interaction-catalog` | **(e)+(c)** | 模板表放 `packages/a2ui-adapter` 或 `packages/core` |

### 3.8 §4.5 `ActionExecution` 与 SSOT

| 条款 | 分类 | 建议 |
| --- | --- | --- |
| 新 Prisma `ActionExecution` | **(c)** | **KEEP v1.1 / 审计 P0-2。** `ExternalEffect` 已有 `kind`、`idempotencyKey @unique`、`status`、`request`/`result`、`reviewDecision`。A2UI 路径已经 `intended → ambiguous → completed\|reconciled\|failed`。新表会与 effect **双写**（设计 §14 风险） |
| `providerMessageId` | **(b)** | 成功时写入 `result.deliveryId`。应升为稳定字段（仍在 `result` JSON 或可空列），不需要新模型 |
| 禁止乐观「已发送」 | **(d)** 相对代码 | **ADOPT。** 去掉 `setSent(true)`；等 `Interaction.status === succeeded` 或 SSE `progress: "succeeded"` |
| 执行中禁止 LLM 宣告成功 | **(d)** | **ADOPT。** executor 在 effect `ambiguous`/`executing` 时不把「已发送」写进模型可说的成功叙述；成功后注入 `providerMessageId` |
| 裸 500 → 受控 failed 事件 | **(b)** 部分 | 已知投递错误已是 `BAD_REQUEST`；未捕获错误仍 `throw error` |

**为何 ExternalEffect 够用（反例门槛）：** 只有在「同一 Interaction 上要并行多笔互不相关的副作用、且不能共用 `idempotencyKey`」时才考虑新实体。邮件 MVP 是 1 Interaction × 1 `email.send` effect。超时对账是同一行从 `ambiguous` → `completed`/`failed`，正是 `executeConfirmedInteractionService` 注释里「第二次调用收尾、不经 Worker」的缺口，用 Graphile job 补即可。

### 3.9 §5 UX

| 条款 | 分类 |
| --- | --- |
| 中低风险单按钮「发送」 | **(a)** PR#26。Grok Bot 对齐的「已绑账户 → 一键 Send」按钮层已完成；缺的是 Send **真正发到已绑账户** |
| 高风险二次确认，禁止 Confirm+发送并列 | **(a)** 原则；高风险模态 **(b)** |
| `draftVersion++` 使确认失效 | **(a)** `applyInteractionFieldChange` 清 `confirmedVersion` |

`onDiscard` 在 `MessageView` 是 `() => undefined`，Discard 只改本地 UI，服务端 Interaction 不会 `cancelled`。次要缺口，不进前八。

### 3.10 §6 时序

| 条款 | 分类 | 建议 |
| --- | --- | --- |
| 同步 RPC 返回 202 + Worker 发送 | **(c)** 相对热路径 | **HYBRID：** 交互 turn 留在 API（`docs/run-execution.md` / AGENTS.md）。发送可在 API 内执行；**超时/UNKNOWN 对账**才进 Graphile（设计 §9.2 已允许 `action.execute` / reconcile）。不要把每次 Send 先入队 |
| 创建 Interaction 前 Preflight | **(d)** | PR-B′ |
| SSE `action.succeeded` 带真实 Message-ID | **(b)** | 扩展现有 `thread.interaction.updated` payload，不要新事件总线 |

### 3.11 §7 原文 PR-A…E 文件范围

全部 **(e)**，且其中新包 **(c)**：

| 规格路径 | 仓库事实 |
| --- | --- |
| `packages/agent-runtime/src/pi/...` | Pi 在 `packages/adapters/src/pi-runtime.ts`、`run-instructions.ts`、`run-tool-selection.ts`、`run-tools-computer.ts` |
| `packages/interaction-runtime/` | `packages/core/src/interaction-runtime.ts` + `apps/api/src/interaction-service.ts` |
| `packages/interaction-contracts/` | `packages/contracts/src/interaction.ts` |
| `packages/action-runtime/` | `ExternalEffect` + `apps/api` execute + 将来 `background-jobs.ts` |
| `packages/interaction-catalog/` | `packages/a2ui-adapter` 编译 + `apps/web/src/components/a2ui` |
| `packages/a2ui-web/...EmailDraftCard.tsx` | `apps/web/src/components/a2ui/EmailComposeEditor.tsx` |
| `apps/api/src/routers/action.ts` | `apps/api/src/routes/threads.ts`（`confirmInteraction` / `executeInteraction`） |
| `packages/persistence/prisma/schema.prisma` | `packages/db/prisma/schema.prisma` |

---

## 4. 冲突决议（KEEP / ADOPT / HYBRID）

| 冲突 | 决议 | 映射到真实路径 |
| --- | --- | --- |
| 一次新建 interaction-contracts、interaction-runtime、action-runtime、interaction-catalog、a2ui-web | **KEEP v1.1** Extend-first；至多已有薄包 `packages/a2ui-adapter` | 合约 → `packages/contracts`；纯函数 → `packages/core`；Pi/连接器/假客户端 → `packages/adapters`；编排 → `apps/api`；Web 卡 → `apps/web/src/components/a2ui`；Mobile → `apps/mobile/components/thread` |
| 新 Prisma `ActionExecution` vs 扩展 `ExternalEffect` | **KEEP ExternalEffect** | `status` 字符串加/统一 `ambiguous`（UNKNOWN）与终态；`result.providerMessageId`；`idempotencyKey` 已 unique。新表门槛见 §3.8 |
| 平行 Interaction Orchestrator / Action Runtime | **KEEP** 嵌在 Thread/Run/Event/oRPC SSE | 文档里的 “Orchestrator” = `interaction-service.ts` + `interaction-runtime.ts`。不要新进程、新总线 |
| 每次 Send 进 Graphile | **HYBRID** | 热路径 API 执行；仅 UNKNOWN 对账 / 长等待 Provider 用 Worker。登记 `packages/adapter-kit/src/background-jobs.ts`（今天没有 `action.*` job） |
| Python 沙箱政策 vs 现有 Pi `shell` | **ADOPT** 规格意图（邮件不得逃进沙箱） | **KEEP** Pi 运行时不重写。改 `run-tool-selection.ts`、`run-instructions.ts`、`builtin-tools.ts` 描述、可选 `run-tools-computer.ts` 拦截。`FEATURE_A2UI` 默认仍关：flag 关时行为保持 0.6.0（含 shell）；flag 开时邮件意图不得选 shell 发信 |
| 供应商名进 contracts/UI | **KEEP AGENTS.md** | `GMAIL_SEND_EMAIL` 留在 `packages/adapters/src/interaction-email.ts`。预检对外用中立「邮箱连接」 |
| 规格 pin 死 A2UI v0.9.1 | **KEEP v1.1 §4** | 渲染 v0.9 族；服务端双轨；当前 pin 见 `packages/a2ui-adapter/README.md` |

---

## 5. 产品痛点（Grok Bot 对齐，按影响排序）

### 5.1 Python / shell 发信逃逸（最高）

**现象：** 即使用户看到审阅卡，模型仍常走 `shell` → `python3 -c` + `smtplib`，或先 `request_secret` 再把 `MAIL_*` 写进脚本。慢、易错、无幂等、无连接器审计。

**机制（不是「模型不听话」单一原因）：**

1. **没有能力注册表，也没有分档。** `selectRunTools` 只按 flag 过滤 `present_interaction`，同时留下 `shell` / `user_computer_shell`（`packages/adapters/src/run-tool-selection.ts`）。
2. **系统提示把两条路都说成合法。** `run-instructions.ts`：Docker 计算机「For ordinary file processing, use `python3 -c`」；A2UI 句「When the user asks to compose or send an email … present_interaction … **Missing SMTP credentials still use request_secret**.」`builtin-tools.ts` 里 `present_interaction` 的 description 重复 SMTP 句。
3. **`shell` 免审批。** `APPROVAL_EXEMPT_TOOLS` 含 `shell` 与 `request_secret`。
4. **原生发送不是真发。** `deliverInteractionEmail` 默认 `new FakeComposioClient()`，固定 `userId = "interaction-email"`，`session.execute("GMAIL_SEND_EMAIL")` 写入进程内 mailbox（`composio-fake.ts`）。测试名就叫 “offline mailbox”。所以卡片 Send 成功**不能**替代真实投递；模型仍有「帮用户真发出去」的动机。
5. **沙箱层不禁 SMTP。** 没有针对 `smtplib` / `socket` 的静态拒绝。

**PR-A′ 必须做的：** 当 `FEATURE_A2UI` 打开且意图是邮件时，唯一 compose 入口是 `present_interaction`；唯一 send 入口是用户在卡上的 Send → `ExternalEffect`。删掉 A2UI 提示里的 SMTP/`request_secret` 句子。对明显的发信脚本（`smtplib`、向 :25/:465/:587 连接）让 `shell` 失败并指回草稿卡。不要重写 Pi。

### 5.2 假发送 / 已发送不是投递 SSOT

`executeConfirmedInteractionService` 在假客户端 ok 后把 Interaction 标 `succeeded`、effect 标 `completed`，并把 `{ deliveryId }` 写入 `result`。Web 再 `setSent(true)`。用户看见「已发送」，提供商侧没有对应消息。这是规格 §1 缺陷 3 在 tip 上的形式：乐观或假成功，而不是 HTTP 500 与已发送同时画在一张卡上（PR#26 之后若 `onSend` throw，本地 `sent` 不会置位；分裂改在「卡片已发送 vs 真实邮箱」以及「LLM 文本已发送 vs effect 失败」）。

### 5.3 无预检三态

未连接、过期、就绪都画出同一张带 Send 的草稿卡。TC-01 要求未绑定主按钮为「连接邮箱」——tip 做不到。`needs_connection` 从未被赋值。

### 5.4 LLM 仍可宣告副作用成功

没有「effect 未终态则禁止成功叙述」的隔离。`chat.text` 与 surface 事件是同一条 `threads.subscribe` 流上的不同类型，不是规格里的双通道，但**可以**在 executor 里做到等价阻断，不必新总线。

### 5.5 模板不是状态驱动

Intent `email.compose` → 永远 `EmailComposeEditor`。连接、进度、失败、UNKNOWN 不会换模板。Grok Bot 式原地流转缺的就是这张表，不是新渲染器包。

### 5.6 无 UNKNOWN + Worker 对账

超时没有「禁止重试、挂起对账」。第二次 `executeInteraction` 会再调 `deliverInteractionEmail`（假客户端则再写一封进程内信）。`background-jobs.ts` 无 `action.reconcile`。

### 5.7 幂等有键、无并发验收

`idempotencyKey` unique + `updateMany` 按当前 status claim。没有 TC-03 的十路并发测试，也没有名为 `IDEMPOTENCY_CONFLICT` 的错误。重复成功返回 `duplicate: true`。

### 5.8 高风险路径与供应商泄漏风险

中低风险单按钮已齐。`interaction-email.ts` 硬编码 `GMAIL_SEND_EMAIL` 与 toolkit `"gmail"`——可接受，因为在 adapters 内。PR-B′ 换成真实 `ConnectorProvider` 时须保持 contracts/UI 中立，并用用户 `Connection`，而不是新的 `userId = "interaction-email"` 假账户。

---

## 6. 修订 PR 序列（PR-A′…，接在 #26 之后）

全部落在本 tip 谱系，**不要**指向 `main`。`FEATURE_A2UI` 默认关。每 PR 只做一件产品事。不引入被否决的包。

```text
[本 docs PR]
    │
    ▼
[PR-A′ 邮件不得逃进 Python/shell]     ← 先做
    │
    ▼
[PR-B′ 预检三态 + 真 Connection 发送]
    │
    ▼
[PR-C′ 状态驱动模板（连接/进度/失败/成功）]
    │
    ▼
[PR-D′ SSOT：去掉乐观已发送；执行中禁 LLM 宣告成功；受控错误]
    │
    ▼
[PR-E′ UNKNOWN + Graphile 对账]
```

### PR-A′ — 工具治理：邮件逃逸收拢

* **目标：** NL「发邮件」在 `FEATURE_A2UI=1` 时 100% 走 `present_interaction`；工具轨迹不得出现为投递而写的 Python/SMTP。
* **落点：** `packages/adapters/src/run-instructions.ts`、`builtin-tools.ts`、`run-tool-selection.ts`；可选 `run-tools-computer.ts` 拦截；`packages/core/src/action-approval.ts` 仅当必须把发信脚本移出免审列表。
* **不做：** 新包；不重写 Pi；不在本 PR 换掉 FakeComposio（否则范围变成两个功能）。
* **验收：** TC-01 的「无 Python」一半；flag 开时的邮件对话 fixture：无 `smtplib`、无 `python3 -c` 发信。flag 关 = 0.6.0。
* **已知残留：** Send 仍进离线邮箱，直到 PR-B′。A′ 只关危险路径，不宣称真投递。

### PR-B′ — 预检 + 真发送

* **目标：** 发送前三态；Send 只在 `CONNECTED_AND_READY` 时可点；投递走用户 `Connection` + `ConnectorRegistry`，假客户端仅测试。
* **落点：** `packages/adapters/src/interaction-email.ts`、`connection-context.ts`、`composio-connector.ts`；`packages/core` 预检纯函数；`apps/api/src/interaction-service.ts` 在 publish/execute 时写入 `needs_connection`；UI 在 PR-C′ 换主按钮，本 PR 至少**拒绝**未就绪的 execute。
* **验收：** TC-01 主按钮/无 Send（若 C′ 未合并，API 拒绝 execute 仍算 B′ 的服务端门闩）；TC-02 的提供商 id 来自真实连接（测试用注入的 `ConnectorProvider`，不是默认 Fake）。

### PR-C′ — 模板矩阵（无新 catalog 包）

* **落点：** `packages/a2ui-adapter` 编译输入增加 preflight + lifecycle；`EmailComposeEditor` / Native surface 按 status 选主按钮文案与禁用态；可复用现有 `app_connect` 块做连接，而不是新 `MessageBlock.kind`。
* **验收：** 矩阵八格的单元测试；未绑定无 Send。

### PR-D′ — 执行 SSOT 与错误隔离

* **落点：** 删除 `setSent(true)` 作为成功文案来源；`MessageView` 从 block/SSE 的 Interaction/effect 状态派生；`executeInteraction` 捕获未处理错误 → failed effect + 受控 oRPC 错误；executor 在非终态不鼓励成功叙述。
* **验收：** TC-04；注入 Provider 500 时无「已发送」。

### PR-E′ — UNKNOWN 对账

* **落点：** effect `ambiguous` 超时 → 保持 ambiguous/unknown，**禁止**自动重试 Send；`background-jobs.ts` 增加 reconcile job；第二次用户「检查发送结果」才查询提供商。
* **验收：** TC-06。Interactive Send 仍不强制先入 Graphile。

PR-C′/D′ 可按评审容量对调，但 **A′ 必须先于 B′**（先停逃逸），**B′ 必须先于把「已发送」当成产品保证**。

---

## 7. TC-01…TC-06 在 tip 上是否仍有效

| 用例 | 作为未来验收 | 在 `7ff96890` |
| --- | --- | --- |
| TC-01 未绑定 →「连接邮箱」、无 Send、无 Python | 有效 | **失败。** 出 Send；无预检；Python 逃逸未关 |
| TC-02 已绑定 → 单按钮 Send → SSE 真 Message-ID | 有效（按钮部分已满足） | **部分。** 单按钮 **(a)**；投递是假 mailbox；成功态是本地 `sent` |
| TC-03 十路并发仅一封 | 有效 | **未证明。** 有 unique key + claim；无十路测试；无 `IDEMPOTENCY_CONFLICT` 名 |
| TC-04 Provider 500 → 失败卡、无已发送、无未捕获 500 | 有效 | **失败。** 假客户端不 500；乐观 `setSent`；未捕获仍 throw |
| TC-05 编辑使确认失效 | 有效 | **通过。** `draftVersion++`，`confirmedVersion` 清空 |
| TC-06 超时 UNKNOWN + 对账、无模型乱总结 | 有效 | **失败。** 无 UNKNOWN；无 reconcile job |

不要因为 PR#26 修了双按钮就关闭 TC-02；它的提供商回执条款仍是缺口。

---

## 8. 规格里明确不采纳的东西

* 新 workspace 包或 `packages/persistence`。
* `ActionExecution` 表，除非 §3.8 的并行多副作用门槛被未来 PR **用代码证明**。
* 新聊天 WebSocket / 独立 Action SSE。
* 把 interactive Send 改成「必须先入 Graphile」。
* 重写 Pi。
* 把 A2UI 并进 `page-kit`。
* 改 `MATEBOT_*`、DB role、compose volume。
* 默认打开 `FEATURE_A2UI`。
* 在 contracts 或用户文案里写死 Gmail/Outlook 品牌（adapters 内部 tool slug 除外）。

---

## 9. 文档关系（本 PR 之后）

```text
matebot-a2ui-source-audit.md              事实源
matebot-a2ui-gap-checklist.md             相对 v1.0 的 P0/P1
matebot-a2ui-integration-design.md        架构锁 v1.1
MATEBOT_A2UI_ORCHESTRATION_SPEC.md        编排意向（包路径未对齐）
matebot-a2ui-orchestration-gap-analysis.md 本文件
matebot-a2ui-orchestration-addendum.md    可采纳的不变量（不破坏 v1.1）
matebot-a2ui-staging-flag.md              FEATURE_A2UI 默认关；staging 打开方式
```
