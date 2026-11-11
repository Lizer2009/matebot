# Matebot × A2UI Phase 0 源码审计

**审计基线：** `main` @ `968ad86d`（Windows 0.6.0 + Android APK 发布线）  
**范围：** 只读架构审计；不实现 Interaction Runtime / A2UI Renderer。  
**目标 fork：** 后续集成候选 `Lizer2009/a2ui`（上游 `a2ui-project/a2ui`）。  
**对照方案：** Matebot × Google A2UI 集成方案 v1.0（Phase 0 / 附录 A / C）。

本文档每一条结论都锚定到本仓库真实路径或符号；猜测性内容单独标为「缺口」。

---

## 1. 执行摘要（给方案作者）

1. **没有 `Conversation` 模型。** 会话权威实体是 `Thread`；消息是 `Message`；实时事实来源是 `Event`（带 `seq`）。方案里的 Interaction 应对齐 `Thread` / `Event` / `Run`，不要新建平行「对话」表。
2. **聊天时间线的消息判别式已存在：** `MessageBlock`（`kind` discriminated union）+ `ProductEventType`。A2UI Surface 应作为新的 `MessageBlock.kind`（或受控扩展），而不是旁路消息系统。
3. **实时通道是 oRPC `eventIterator` → SSE（`text/event-stream`），不是聊天 WebSocket。** 客户端用 cursor/`seq` 订阅；`RealtimeFanout` 只做跨进程 latch，不替代事件持久化。
4. **已有完整的副作用审批与幂等骨架：** `ExternalEffect` + `ActionApprovalRule` + ask 卡片（`kind: "ask"`）+ `threads.answer`。Action Runtime 应扩展这套，而不是另起 `Approval` / `ActionExecution` 表（除非审计证明缺口无法扩展）。
5. **Run 生命周期已是一等公民：** `Task` → `Run` → `Attempt` + lease/fence；Pi 流事件经 `AgentRuntimeEvent` 进入 executor，再写成 `Event`/`Message`。不要为 A2UI 再建第二套 Run。
6. **Graphile Worker 不在热路径上跑 agent：** 交互 run 由 API 进程直接 `RunStarter` 启动；Worker 负责 `run.continue`、例程、computer、messaging、cloud_agent 等后台/恢复任务。
7. **Electron 直接复用 `apps/web` 构建产物；** A2UI Web Renderer 做一次即可覆盖 Desktop。
8. **Expo Mobile 有独立原生时间线**（`apps/mobile/components/thread/*`），本地 `saved-chats` 缓存，SSE 订阅与 Web 同契约；**没有官方 `@a2ui` React Native renderer**——移动端必须自建 Catalog。
9. **`@matebot/page-kit` 已是另一条 Generative UI 路径**（受控 JSX Page → 沙箱运行时）。A2UI 必须明确边界：Page = 文档/仪表板工件；A2UI = 对话内交互 Surface。二者勿混为一谈，也勿互相替换。
10. **上游 A2UI 版本事实已变：** `specification/versions.json` 将 **v1.0 标为 `current`**，v0.9.1 为 `previous`。`@a2ui/web_core` 导出 `./v1_0`；`@a2ui/react`（0.15.0）目前仅显式导出 `./v0_8`/`./v0_9`。Phase 1 pin 需重新决策（见 §12）。

---

## 2. 聊天消息时间线与消息判别式

### 2.1 契约层（共享）

| 符号 | 路径 | 作用 |
| --- | --- | --- |
| `MessageBlock` | `packages/contracts/src/events.ts` | `z.discriminatedUnion("kind", …)`，所有气泡/卡片类型 |
| `ThreadMessageSchema` / `ThreadMessage` | 同上 | `id, threadId, seq, role, blocks[], botId?, runId?, …` |
| `MessageRole` | 同上 | `"user" \| "bot" \| "system"` |
| `ProductEventType` / `ProductEventSchema` | 同上 | 线程/run/工具等产品事件；SSE 负载契约 |
| `projectMessages` / `reduceLiveMessageBlocks` | `packages/core/src/events.ts` | 事件 → 时间线投影；live progress 归约 |

**已存在的 `MessageBlock.kind`（审计时 HEAD）：**  
`text`, `card`, `ask`, `choice`, `app_connect`, `connect`, `computer`, `voice_call`, `call_request`, `meta`, `progress`, `steps`, `subagent`, `child_bot`, `cloud_agent`, `skill_draft`, `chart`, `mcp_approval`, `import_setup`, `image`, `file`, `page`, `handoff`, `channel_message`, `bot_message_sent`, `bot_message_received`。

> 方案中的 `email-draft-card` / `approval-card` 等业务组件，在 Matebot 中应优先表现为新的 `MessageBlock.kind`（或嵌在现有 `ask`/`card`/`page` 语义内），经 contracts Zod 校验后进入时间线——而不是独立于 `blocks` 的旁路通道。

### 2.2 Web 渲染入口

| 层 | 路径 | 说明 |
| --- | --- | --- |
| 块级渲染 | `apps/web/src/pages/shell/message-view.tsx` → `MessageView` | 按 `block.kind` 分支；narration / tool / ask / page / mcp_approval 等 |
| 交互卡片 | `apps/web/src/pages/shell/message-cards.tsx` | `ChoiceCard`, `AppConnectCard`, `McpApprovalCard`, … |
| Ask/审批 UI | `apps/web/src/components/AskCard.tsx` | 回答/允许/拒绝；调用 `threads.answer` |
| 实时归约 | `apps/web/src/lib/thread-events.ts` → `reduceThreadSnapshot` | 应用 `ProductEvent` 到 `ThreadSnapshot` |
| 订阅 | `apps/web/src/pages/shell/use-thread-sync.ts` | `rpc.threads.subscribe({ botId\|groupId, cursor })` |
| Markdown | `@matebot/chat-ui`（`packages/chat-ui`） | 文本块渲染；**不是**消息判别式所在地 |

`packages/chat-ui` 只做 Markdown/Mermaid，**不拥有**时间线状态机；时间线权威在 contracts + core + web/mobile shell。

### 2.3 Mobile 渲染入口

| 层 | 路径 |
| --- | --- |
| 屏幕 | `apps/mobile/components/thread/thread-screen.tsx` |
| 列表 | `apps/mobile/components/thread/thread-message-list.tsx`, `thread-rows.tsx` |
| 气泡 | `apps/mobile/components/thread/message-bubble.tsx`, `special-message-card.tsx`, `ask-block.tsx` |
| 同步/SSE | `apps/mobile/lib/thread-sync.ts`, `thread-live.ts`, `api.ts`（`subscribeThread` / `accept: text/event-stream`） |
| 离线缓存 | `apps/mobile/lib/saved-chats.ts`（本地最近消息；非跨设备 Interaction 权威） |

Mobile 与 Web **共享同一套** `MessageBlock` / `ProductEvent` 契约，但 UI 是 Expo 原生实现，不复用 `apps/web` DOM。

---

## 3. Pi Agent 流 / 工具调用 / Run 生命周期

### 3.1 运行时边界

| 符号 | 路径 | 说明 |
| --- | --- | --- |
| `AgentRuntime` | `packages/adapter-kit/src/interfaces.ts` | `run()` → `AsyncIterable<AgentRuntimeEvent>`；`abort(runId)` |
| `AgentRuntimeEvent` | `packages/adapter-kit/src/types.ts` | `text \| thinking \| turn \| steered \| progress \| tool \| ask \| takeover \| usage \| checkpoint \| subagent \| done` |
| `PiAgentRuntime` | `packages/adapters/src/pi-runtime.ts` | 官方 Pi 适配；`describe().id === "pi"`；streaming+tools |
| `createRunExecutor` | `packages/adapters/src/executor.ts` | 消费 runtime 事件，写 DB/事件，处理审批续跑 |
| 审批卡片构造 | `packages/adapters/src/approval-ask.ts` → `buildApprovalAskBlock` | 产出 `MessageBlock` `kind: "ask"` |
| 审批效果/重放 | `packages/adapters/src/approval-effect.ts` | `ApprovedEffectReplayQueue`；幂等续跑 |

### 3.2 持久化生命周期（Prisma）

路径：`packages/db/prisma/schema.prisma`

```
Thread ── Message (seq)
       ── Event   (seq)     ← 实时权威日志
       ── Task ── Run ── Attempt
                      └── ExternalEffect (idempotencyKey unique)
```

| 模型 | 关键字段 | A2UI 相关含义 |
| --- | --- | --- |
| `Thread` | `nextEventSeq`, `nextMessageSeq`, history compaction | 会话容器（方案中的 Conversation） |
| `Message` | `seq`, `role`, `blocks` Json, `runId`, `clientNonce` | 时间线持久消息 |
| `Event` | `seq`, `type`, `payload`, `runId` | SSE/投影来源 |
| `Task` | `prompt`, `status` | 用户意图容器（轻量） |
| `Run` | `status`, `leaseOwner/Fence`, `checkpoint`, `clientNonce`, `wakeAt`, `retryOfRunId` | Agent 执行单元 |
| `Attempt` | `fence`, `status` | 单次执行尝试 |
| `ExternalEffect` | `kind`, `idempotencyKey`, `status`, `request/result`, `reviewDecision` | 副作用意图与审批结果 |
| `SteeringMessage` | 关联 message/run | 运行中用户插话 |

**Run 状态**（`packages/contracts/src/ids.ts` `RunStatus`）：  
`queued → leased → running → waiting_input | waiting_takeover → completed | failed | cancelled`  
转移规则：`packages/core/src/run-state.ts`。

**触发器**（`packages/contracts/src/runs.ts` `RUN_TRIGGERS`）：  
`user`, `routine`, `resume`, `follow_up`, `reaction`, `call_end`, `spawn`, `skill`, `bot_message`, `webhook`, `messaging`, `cloud_agent`, `purchase`, `created`, `tickets`。

### 3.3 调度事实（与方案「全走 Worker」的差异）

见 `docs/run-execution.md`：

- 用户消息提交后，**同一 API 进程**通过 `RunJobPublisher` / `RunStarter` **直接启动** run；HTTP 立即返回，客户端靠 SSE 跟进。
- Graphile 负责**计划/维护/恢复**类 job，不是每个 interactive turn 的必经队列跳。
- 多实例靠 Postgres lease/fence 保证单飞。

A2UI 的「执行中进度」应挂在现有 `Run` + `Event`（`thread.progress` / `agent.tool.*`）上，而不是假设「所有 Action 都先进 Graphile」。

---

## 4. Prisma：方案实体名 → 真实模型

方案假设名 | Matebot 真实模型 | 建议 |
| --- | --- | --- |
| Conversation | **`Thread`**（无 Conversation） | Extend `Thread`；Interaction 用 `threadId` FK |
| Message | **`Message`** + `blocks` Json | Extend `MessageBlock` union；必要时 Interaction 引用 `messageId` |
| Event / Stream | **`Event`**（已有 seq） | Reuse；A2UI 帧可作为 payload 或新 `ProductEventType` |
| Run / Attempt | **`Run`**, **`Attempt`** | Reuse；不要平行 AgentRun |
| Job | 无 Prisma `Job` 表；**Graphile Worker** + `BackgroundJobName` | Reuse job 名空间；见 §6 |
| Connector | **`Connection`** + `CapabilityInstall` + adapter `ConnectorRegistry` | Reuse；执行走 `ConnectorProvider` |
| Approval | **无独立 Approval 表**；用 **`ExternalEffect`** + **`ActionApprovalRule`** / `UserActionApprovalRule` + ask 消息块 | Prefer extend；仅当「草稿版本绑定的业务确认」无法表达时再 New |
| Interaction / Surface | **不存在** | **New**（最小表或先嵌入 Event/Message——Phase 1 再定） |
| ActionExecution | 接近 **`ExternalEffect`** | Prefer extend `ExternalEffect`；补草稿版本字段若需要 |
| Page（文档 UI） | **`Page` / `PageVersion`** + `@matebot/page-kit` | **并存，不复用为 A2UI Surface**（见 §10） |

相关审批/偏好模型：

- `ActionApprovalRule`, `ActionAutoReviewPreference`
- `UserActionApprovalRule`, `UserActionAutoReviewPreference`

产品说明：`docs/approvals.md`。

---

## 5. SSE / WebSocket / oRPC 流式现实

### 5.1 聊天实时

| 环节 | 路径 | 事实 |
| --- | --- | --- |
| 契约 | `packages/contracts/src/rpc.ts` → `threads.subscribe` | `.output(eventIterator(ProductEventSchema))`，输入含 `cursor` |
| API | `apps/api/src/routes/threads.ts` | async generator；心跳 `HEARTBEAT_MS`；会话再校验 `SESSION_RECHECK_MS` |
| 跟随 | `packages/db/src/events.ts` → `followThreadEvents` | DB poll + optional `RealtimeFanout` latch |
| 扇出接口 | `packages/adapter-kit/src/interfaces.ts` → `RealtimeFanout` | `publish/subscribe(topic)`；**不是**浏览器 WebSocket API |
| Web 客户端 | `use-thread-sync.ts` + oRPC client | cursor 订阅 |
| Mobile 客户端 | `apps/mobile/lib/api.ts` `subscribeRpcEvents` | `POST /rpc/...` + `Accept: text/event-stream` |

**结论：** 方案「优先 SSE + oRPC 收动作」与现状一致。  
**不要**为 A2UI 引入第二套 WebSocket 聊天协议。Computer/screen 代理里出现的 WebSocket（如 `apps/web/src/screen-proxy.ts`）属于沙箱画面通道，与聊天事件无关。

### 5.2 用户动作回传

已有：`threads.send`, `threads.answer`, `threads.followUp`, `threads.stop`, onboarding/mcp/connect 等 oRPC 过程。  
A2UI 字段变更/确认应新增 **同类 oRPC 过程**（或扩展 `threads.answer` 语义），由服务端校验后写 Event，再 SSE 推送 Surface 更新。

### 5.3 恢复语义

- 服务端权威：`Event.seq` / `threads.get` snapshot / `threads.messages` 分页。
- Web：cursor 比较与 snapshot 合并（`mergeThreadSnapshot`, `reconcileRefreshedThread`）。
- Mobile：同上 + **本地** `saved-chats-v2`（`SAVED_CHAT_MESSAGES = 100`）——**不能**当作跨设备 Interaction 真相源。

缺口：无 `Last-Event-ID` HTTP 头专用逻辑；恢复靠 **显式 cursor 参数** + snapshot。方案若要求 Last-Event-ID，需映射到现有 cursor，而非照搬浏览器 EventSource 语义。

---

## 6. Graphile Worker：任务、取消、重试、幂等

| 项 | 路径 |
| --- | --- |
| Job 名称与 payload schema | `packages/adapter-kit/src/background-jobs.ts` |
| 发布/取消接口 | `JobPublisher.enqueue` / `cancel(key)`（`adapter-kit` interfaces） |
| Worker 组装 | `apps/worker/src/index.ts`（`GraphileJobPublisher`, `RunJobPublisher`） |
| 幂等键示例 | `runJobKey`, `routineJobKey`, `replaceKey` on `BackgroundJob` |
| Run 副作用幂等 | `ExternalEffect.idempotencyKey` `@unique` |

**已登记后台任务名（节选）：**  
`run.continue`, `routine.wakeup`, `routine.retry`, `computer.update|sleep|control-expire`, `skill.teaching-expire`, `call.expire`, `history.compact`, `messaging.deliver|credential-cleanup`, `cloud_agent.poll`, `purchase.poll`, `push.receipt`。

**A2UI 含义：**

- 异步 Provider 动作（发信、对账）可 **新增** `action.execute` / `action.reconcile` 类 job，沿用 `replaceKey` + DB 唯一幂等。
- **不要**把每次 Surface 字段编辑丢进 Worker。
- Interactive agent turn **不要**改回「必须先入队 Graphile」——违反 `docs/run-execution.md` 与 AGENTS.md 热路径原则。

---

## 7. Electron 与 Web UI 边界

| 事实 | 路径 |
| --- | --- |
| Desktop 打包嵌入 Web | `apps/desktop/package.json` → `extraResources`: `../web/dist` → `web` |
| 版本线 | Desktop `version: "0.6.0"` |
| 窗口加载 | `apps/desktop/src/main.ts`（`BrowserWindow` + `loadAppUrl`） |
| 原生职责 | 本地栈、更新、OAuth 弹窗、host computer、权限——**不是**聊天 React 树 |

**结论：** A2UI Web Renderer 落在 `apps/web`（或共享 web 包）即可被 Electron 复用。Desktop 无需独立协议实现；需回归窗口生命周期、外链与文件权限（方案已提示）。

---

## 8. Expo Mobile：时间线与恢复缺口

**已具备：**

- 与 Web 同契约的消息块与 `threads.subscribe` SSE。
- 原生气泡/Ask/特殊卡片（`message-bubble.tsx` 等）。
- 前台刷新 + live 订阅（`useThreadSync`）。
- 设备本地聊天缓存（`saved-chats.ts`）。

**相对方案「跨设备可恢复 Interaction」的缺口：**

1. 无服务端 Interaction/Surface 实体 → 跨设备只能恢复 **消息/事件**，不能恢复「草稿版本 + 确认绑定」除非写入现有 Message/Event 或新表。
2. 本地 saved-chats 有条数/体积上限，且绑定设备文件系统。
3. 无 A2UI Native Catalog；官方树（`Lizer2009/a2ui`）含 Flutter / SwiftUI / Compose 路线，**无 React Native 包路径**。
4. Mobile 审批 UX 已存在（ask/approval settings），但业务草稿卡需原生重做。

---

## 9. Connector / Composio / MCP / OpenAPI 与授权门闩

| 层 | 路径 | 说明 |
| --- | --- | --- |
| 接口 | `ConnectorProvider`, `ManagedConnectorProvider`, `ConnectionAuthProvider`（`adapter-kit`） | discover/execute/auth |
| 注册表 | `packages/adapters/src/composio-connector.ts` → `ConnectorRegistry`, `createConnectorStack` | 聚合 Composio 等 |
| Composio | 同文件 `ComposioConnector` | 目录、OAuth、execute；错误脱敏 |
| Pipedream / MCP / 安装连接器 | `pipedream-connector.ts`, `mcp-connector.ts`, `installed-connectors.ts`, `remote-mcp.ts`, … | 适配器层 |
| DB 连接行 | `Connection`（`connectorId` 默认 `"composio"`） | 用户已授权账户 |
| 审批策略 | `packages/core/src/action-approval.ts` | `resolveActionApproval`, `toolRequiresExplicitApproval`, connector read 门闩 |
| 内置工具名 | `packages/contracts/src/builtin-tools.ts` `BUILTIN_TOOL_NAMES` | 含 `connect_app`, `ask_user`, `message_user`, … |
| MCP 审批块 | `MessageBlock` `kind: "mcp_approval"` + `McpApprovalCard` | 用户完成 OAuth/确认 |

**结论：** Action Registry 应 **映射到** 现有 `ConnectorCall` / builtin tools / `ExternalEffect.kind`，禁止 A2UI 组件直连 Provider。邮件发送等应走「compose（无副作用）/ send（ExternalEffect + 审批）」分离——与现有 approval-ask 模式一致。

---

## 10. 现有确认 / 审批 UX（可复用模式）

| UX | 块/入口 | 用户动作 API |
| --- | --- | --- |
| 工具/站点审批 | `ask` + `approvalEffectId`（`AskCard`） | `threads.answer`（allow/always/deny） |
| 密钥/登录卡 | `ask` + `input: "secret"` / login fields | `threads.answer`（fields/dismiss） |
| 选择卡 | `choice` | `onboarding.choose` |
| 应用连接 | `app_connect` | 连接流程 + 状态翻转 |
| MCP 接入 | `mcp_approval` | OAuth / dismiss |
| 技能草稿 | `skill_draft` | 保存/例程 |
| 设置项 | `docs/approvals.md` + Settings → Approvals | 模式 Ask/Auto/Never |

**已有能力：** 聊天内确认、Always allow 规则、Auto review、幂等 `ExternalEffect`、waiting_input 暂停 run。  
**方案新增「草稿版本绑定确认」：** 现有 ask 绑定的是 **effect/request**，不是「可编辑草稿的 version hash」。邮件草稿若允许编辑后使确认失效，需要 **扩展**（新字段或 Interaction 层），不能假装 `ExternalEffect` 已完整覆盖。

---

## 11. `@matebot/page-kit` 与 A2UI 共存（重点）

### 11.1 page-kit 是什么

| 项 | 路径 |
| --- | --- |
| 包 | `packages/page-kit`（`@matebot/page-kit`） |
| 组件白名单 | `packages/page-kit/src/components.ts` → `PAGE_KIT_COMPONENTS` |
| 校验/编译 | `validate.ts` / `compile.ts`（Sucrase JSX → CJS） |
| 运行时 | `runtime.tsx`（沙箱 mount；`MatebotPage.mount`；CSP 内联脚本工厂） |
| 持久化 | Prisma `Page` / `PageVersion`（`source` + 预编译 `code`） |
| 消息嵌入 | `MessageBlock` `kind: "page"`；Web `PageBlockCard` |

Page 是 **工件（artifact）**：机器人 `save_page` 后用户打开查看；可分享链接；**不是**对话内可编辑业务事务状态机。

### 11.2 与 A2UI 的边界（必须写进后续 PR）

| 维度 | page-kit | 建议的 A2UI Surface |
| --- | --- | --- |
| 作者 | 模型写受限 JSX | 服务端从 InteractionPlan **编译** 协议消息 |
| 执行 | 浏览器沙箱跑编译后的 JS | 客户端 Catalog **声明式**渲染；无任意脚本 |
| 状态权威 | PageVersion 文本 | Interaction/Event（服务端） |
| 时间线形态 | `kind: "page"` 卡片 + 查看器 | 新块或专用 Surface 宿主，内嵌于气泡流 |
| 安全故事 | 「校验非安全边界，沙箱才是」 | Catalog 白名单 + schema；禁止模型吐 JSX/HTML |

**禁止：** 用 page-kit 充当 A2UI；或让 A2UI 编译进 Page JSX。  
**允许：** 同一线程同时存在 page 卡片与 A2UI Surface（例如总结页 + 发信草稿卡）。

---

## 12. 上游 A2UI（`Lizer2009/a2ui`）核实

只读核实（未 vendor 进 Matebot）：

| 项 | 事实 |
| --- | --- |
| 包 | `@a2ui/web_core`, `@a2ui/react`, `@a2ui/lit`, `@a2ui/angular`, `@a2ui/markdown-it`；`@a2ui/agent` README 称尚未发布 |
| 包版本（fork HEAD package.json） | `web_core` / `react` **0.15.0**（npm 包版本 ≠ 协议版本） |
| 协议 `specification/versions.json` | **v1.0 = `current`**；v0.9.1 / v0.9 = `previous`；v0.8 = `deprecated` |
| `web_core` exports | 含 `./v0_8`, `./v0_9`, **`./v1_0`** |
| `@a2ui/react` exports | `.`, `./v0_8`, `./v0_9`, `./styles`——**无 `./v1_0` 子路径** |
| React Native | fork 树中 **无** `react-native` renderer 路径；有 Flutter / Swift / Kotlin |
| 示例 | 含 email-compose 蓝图（`catalogs/.../02_email-compose.json`） |

### Phase 1 pin 建议（修订方案原文）

1. **Adapter 同时具备 v0.9.x 与 v1.0 schema 能力**（`web_core` 已分版本导出）。
2. **Web PoC：** 先验证 `@a2ui/react@0.15.x` 默认导出实际绑定的协议 minor；若仍停在 v0.9 族，则 **渲染器 pin v0.9**，服务端编译器可先输出 v0.9，并预留 v1.0 适配。
3. **不要**仅因 versions.json 写 current 就在 Day 1 把业务锁死在 v1.0——以 **React renderer 实际支持面** 为准。
4. **Mobile：** 自建 `@matebot` Native Catalog（协议语义对齐 pin 版本）；社区 RN renderer 仅作可选评估，不作生产默认。
5. **Agent SDK：** 非必需；Matebot 自研 Plan→Surface 编译即可（与方案一致）。

---

## 13. Package 落位：扩展 vs 新建

现有 workspace 包：`@matebot/adapter-kit`, `adapters`, `auth`, `chat-ui`, `contracts`, `core`, `db`, `logging`, `memory`, `page-kit`, `testkit`, `ui-tokens`, `ui-web`。

| 方案模块 | 建议落位 | Reuse / Extend / New |
| --- | --- | --- |
| InteractionPlan / Events / Action contracts | `packages/contracts`（Zod + rpc 过程） | **Extend** |
| 领域状态机/策略纯函数 | `packages/core` | **Extend** |
| Prisma + Event 写入 | `packages/db` | **Extend** |
| Pi/工具/连接器执行 | `packages/adapters` + `adapter-kit` 接口 | **Extend** |
| A2UI 协议适配（校验/版本/编译） | **New** `packages/a2ui-adapter`（或先放 `adapters` 子目录，稳定后再拆） | **New**（薄） |
| Web Catalog 组件 | `apps/web` + 必要时 `packages/ui-web` | **Extend** |
| Native Catalog | `apps/mobile`（或未来 `packages/a2ui-native`） | **New** |
| Interaction Runtime 编排 | `apps/api` services + 少量 `core` | **Extend**（勿新建 apps） |
| 异步对账 job | `apps/worker` + `background-jobs.ts` | **Extend** |
| page-kit | 保持独立 | **Reuse as sibling，不合并** |

**反对方案 §14 一次性新建** `interaction-contracts` / `interaction-runtime` / `action-runtime` / `interaction-catalog` / `a2ui-web` / `a2ui-native` **六七个包**：会与 `contracts`/`core`/`adapters`/`page-kit` 重复。先 Extend，等边界清晰再拆包。

---

## 14. 方案差异、风险与过度设计

| 方案假设 | 审计结论 | 风险 |
| --- | --- | --- |
| 存在 Conversation | 实为 Thread | 命名/迁移误导 |
| 新建完整 Approval / ActionExecution | ExternalEffect + rules 已覆盖大半 | 重复状态、双写 |
| 实时重建或 WebSocket | 已有 oRPC SSE | 复杂度上升 |
| Interactive 执行进队列 | 违反现有热路径 | 延迟/回归 |
| 锁死 A2UI v0.9.1 为首发 | 上游 v1.0 已 current；React 可能仍偏 v0.9 | pin 策略过时 |
| Expo 可评估社区 RN renderer 即生产 | 官方无 RN | 安全/维护风险 |
| 大目录新建多 package | 与现包重叠 | 过度架构 |
| 忽略 page-kit | 已有 generative UI | 产品与安全故事冲突 |
| 草稿确认 = 现有 ask | ask 绑 effect，非草稿 version | Email 闭环缺口 |
| Mobile 已具备跨设备恢复 | 仅消息+本地缓存 | 高估恢复 |

---

## 15. 映射表：方案章节 → Matebot 路径 → 动作

| 方案章节 | Matebot 锚点 | Reuse \| Extend \| New |
| --- | --- | --- |
| §3 Interaction Runtime | `apps/api` + `packages/core` + 新持久化 | Extend + New(最小实体) |
| §4 A2UI Adapter | 新薄包；schema 来自上游 pin | New |
| §4 Web Renderer | `message-view.tsx` / message-cards | Extend |
| §4 Electron | `apps/desktop` embeds `web/dist` | Reuse |
| §4 Expo Native Catalog | `apps/mobile/components/thread` | New |
| §5 InteractionPlan | `packages/contracts` | Extend |
| §6 State / Events | `Event`, `ProductEventType`, run-state | Extend |
| §7 Action Registry | `action-approval.ts`, `ExternalEffect`, connectors | Extend |
| §8 Catalog | 新组件 + contracts MessageBlock；对照 page-kit 白名单思想 | New + Extend |
| §9 Email E2E | connectors + approval-ask + 新草稿版本语义 | Extend |
| §10 API/SSE | `threads.subscribe`, 新 interaction.* RPC | Reuse transport / Extend API |
| §11 DB | Thread/Message/Event/Run/ExternalEffect；Interaction* 待定 | Extend / New |
| §14 多 package 结构 | 见 §13 | 缩减为 Extend-first |
| 附录 C MATEBOT_* | `.env.example` / turbo `MATEBOT_*`；部署兼容 | **禁止改名** |

---

## 16. 真实调用链（用户消息 → 工具 → 回传）

```text
Client (web|electron|mobile)
  └─ oRPC threads.send
       └─ packages/db sendUserMessage → Message + Event + Task/Run
            └─ RunStarter (API 进程热路径)
                 └─ createRunExecutor
                      └─ PiAgentRuntime.run → AgentRuntimeEvent*
                           ├─ text/progress → Event(thread.progress) → SSE
                           ├─ tool → connector/builtin → ExternalEffect?
                           │     └─ need approval → ask MessageBlock → waiting_input
                           └─ done → finalizeRun → Message created → SSE
  Client threads.subscribe(cursor) ← ProductEvent (SSE)
  Client threads.answer → 恢复 Run / 记录审批 → 续跑或拒绝
```

A2UI 插入点（未来，本 PR 不实现）：

1. Agent/Planner 产出 InteractionPlan（contracts）  
2. API 校验 → 编译 A2UI → 写 Event/Message（新块或 surface 载荷）  
3. Client Catalog 渲染；字段变更经 oRPC  
4. 确认后走 ExternalEffect +（必要时）Worker 对账  

---

## 17. 后续分支策略（仍不实现 Runtime）

建议独立 PR 链（均从最新 `main` 切出，**不合并进本审计之外的运行时**）：

| 顺序 | 分支意图 | 内容 |
| --- | --- | --- |
| PR-0 | 本 PR | 仅文档 |
| PR-1 | `cursor/…-a2ui-contracts-…` | InteractionPlan / surface 事件 Zod；**不**接 renderer |
| PR-2 | adapter pin | 锁定上游版本；schema 测试；无 UI |
| PR-3 | web surface host | `MessageView` 增加宿主；静态/fixture Surface |
| PR-4 | persistence | 最小 Interaction/Surface 迁移或证明可嵌入 Event |
| 其后 | runtime / email / mobile | 按方案 PR-5… 但每步先对齐本审计 |

约束回顾：

- 不碰 `MATEBOT_*`、DB role、compose volume 改名。  
- 不把 A2UI 并进 `page-kit`。  
- 不引入并行 WebSocket 聊天总线。  
- 不把 interactive run 改回全局队列。

---

## 18. 审计方法与未覆盖项

**已覆盖：** contracts/events、web/mobile 时间线、Pi/executor、Prisma 相关模型、SSE/oRPC、Worker job 名、Electron 嵌入、connectors/approvals、page-kit、上游 a2ui 包与 versions.json。

**未做（有意）：** 运行时 PoC、依赖安装 `@a2ui/*`、对每个 connector 的完整授权矩阵穷尽测试、生产流量测量。

**文档状态：** 只读审计；无产品行为变更。
