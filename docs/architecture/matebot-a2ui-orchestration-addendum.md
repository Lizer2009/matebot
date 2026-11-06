# A2UI 编排不变量附录（对齐设计 v1.1）

本文列出从 [`MATEBOT_A2UI_ORCHESTRATION_SPEC.md`](./MATEBOT_A2UI_ORCHESTRATION_SPEC.md) **采纳**、且**不违反** [`matebot-a2ui-integration-design.md`](./matebot-a2ui-integration-design.md) v1.1 的条款。分类与否决理由见 [`matebot-a2ui-orchestration-gap-analysis.md`](./matebot-a2ui-orchestration-gap-analysis.md)。

文档 only。`FEATURE_A2UI` 默认关闭。不改 `RAKAZO_*`。

---

## 采纳（产品不变量）

1. **编排，而不是临时代码。** 已注册能力（邮件发送是第一个）由 Agent 调度，不由模型写 Python/Shell/Node 去打提供商。Pi 保留；改的是工具选择、提示词、以及沙箱对发信脚本的拒绝。
2. **副作用状态只有一个权威。** 「已发送 / 失败 / 执行中 / 未知」来自服务端 `ExternalEffect`（加 Interaction 生命周期）经现有 `threads.subscribe` SSE 投影。客户端在终态事件之前不得画成功文案。LLM 不得在 effect 未成功时宣称已发送。
3. **中低风险一颗主按钮。** 邮件审阅卡：所见即所审；主操作是「发送」。不在同一张卡上并列 Confirm 与发送。高风险走现有 `ask` + `ActionApprovalRule`，不是第二颗同级按钮。PR#26 已完成按钮层。
4. **模板由状态决定。** `Template = f(intent, preflight, interactionStatus, riskLevel, platform)`。编译在 `packages/a2ui-adapter`；状态在 `packages/core`。未连接不出 Send。
5. **预检是三态，不是布尔。** `NOT_CONNECTED` / `CONNECTED_BUT_EXPIRED` / `CONNECTED_AND_READY`，映射到现有 `Connection.status` 与连接器账户态（含 Composio `EXPIRED`）。`email.compose` 允许未绑定起草；`email.send` 要求 READY。
6. **超时是 UNKNOWN，不是悄悄重试。** 映射到 `ExternalEffect.status`（现有 `ambiguous` 或显式 `unknown`）。Graphile 只做对账，不把每次 Send 丢进队列。
7. **幂等键已经在 ExternalEffect 上。** 发送以 `idempotencyKey` 为唯一投递。不要第二套执行表来「再做一次幂等」。

---

## 映射（名称 → 仓库）

| 规格用语 | 仓库落点 |
| --- | --- |
| Interaction Orchestrator | `apps/api/src/interaction-service.ts` + `packages/core/src/interaction-runtime.ts` + `packages/adapters/src/interaction-publish.ts`，挂在 `Thread` / `Run` / `Event` 下 |
| Action Runtime | `ExternalEffect` + `executeConfirmedInteractionService` + 可选 Graphile reconcile job |
| Capability Registry | builtin tools + `ConnectorRegistry` + `InteractionPlan.intent` + 路由优先级（`run-tool-selection` / instructions） |
| ActionExecution | **不新建。** 用 `ExternalEffect` |
| `packages/interaction-*` / `action-runtime` / `a2ui-web` | **不新建。** 见设计 v1.1 §10 |
| `chat.text_chunk` vs `a2ui.surface_patch` | 同一条 oRPC SSE 上的不同 `ProductEvent` type；隔离在 executor，不新总线 |
| Native `email.send` | `ExternalEffect.kind = "email.send"`，经 `ConnectorProvider` 执行；不是模型可调用的 tool 名 |

---

## 明确不采纳

平行 Conversation/Run、新 Approval 产品表、新 `ActionExecution` 表（除非未来 PR 证明 `ExternalEffect` 无法表达并行多笔副作用）、把 A2UI 并进 page-kit、为 A2UI 建 WebSocket 聊天总线、默认打开 `a2ui` flag、重命名 `RAKAZO_*`。
