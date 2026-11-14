# 交互卡内核（E 批：L0-A 全场景）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Do **not** use subagent-driven-development or any other-model Task/review/fallback: parent instruction t318 requires Grok 4.6 only. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** L0-A 六种交互块共用内核状态；连接/审批/问答各只剩一条出卡路径；块仍是视图，不删种、不改成脱离生产的演示卡。

**Architecture:** Spec §8 E + §3.3 / §3.3.1 / §3.3.2. Do not rewrite `choice` / `ask` / `app_connect` / `connect` / `mcp_approval` into A2UI. Each becomes a view of one `Interaction` row (`status` / `cardKey` / `expiresAt`). Block-local `pending` / `connected` / `answered` is a **derived snapshot** of the 13-value kernel status. Writers settle only through `settleInteraction`. Connect unification: one `needs_connection` card per demand (AC-26). Approval unification: `awaiting_approval`. Question unification: `choice` + non-approval `ask` share `question.clarify`. Slack `Allow once` / `Skip` is a **label** on the same deny action, not a new effect.

**Tech Stack:** TypeScript, Prisma 7.10.1 (PostgreSQL), Vitest, Lingui (web), locale tables (mobile), pnpm workspace

---

## B / C / D 遗留（t318：记下缺项继续 E；缺项不是通过）

| 项 | 批 | 证据边界 | 不得用什么代替 |
|---|---|---|---|
| iOS 模拟器/真机终态 | B | 本环境无 iOS | Web/mobile stub **不得**冒充原生 |
| 真实连点两次发送后刷新 / 单次外部执行 | B | 真实发信暂停 | 隔离幂等测试不是现场发信 |
| 真实模型/provider 回合与外部写 | B/C/D | t318 维持暂停 | E 不得恢复；不得访问 `.5` |
| 真实 30 分钟墙钟 + delayed job 到点 | C | — | closer 直调 ≠ 队列到点 |
| C 浏览器过期 | C | 人工过去 `expiresAt` + 生产 `expireDueInteractions` | 不得标 AC-19 现场通过 |
| D 完整 `a2ui-live.spec.ts` 19 条 | D | 关键 3 条在 `de89ccab5` 绿 | 不得把 3/19 写成 19 全绿 |
| Fake Composio 即时 begin 的 complete-resume | D | begin 无 auth URL 时 complete 不 `connectedNow` | 不标 C 续跑现场通过 |
| `pnpm lint` 3 error | D | native-monitoring / plugin-submissions / runs.test | 声称既有必须给 `origin/main` 基线 |
| 27 文件 452 | D 相关集 | 不是 B 广回归 | 不得当作 16920 已在新 head 重跑 |

t318 允许带这些缺项推进 E。E 验证**必须**重跑 B 广回归命令（`packages/core/src` `packages/adapters/src` `apps/api/src` `apps/web/src/components/a2ui` `apps/web/src/pages/shell` `apps/mobile/lib`）。范围内能安全修的遗留测试/静态错误才修，并标明来源；不能修的列阻塞。完成后停等。**不启动 F。**

---

## 范围：权威规格原文

规格 `docs/superpowers/specs/2026-11-13-interaction-card-kernel-design.md` §8 E 行：

> **E 全场景** | L0-A 收口：`choice` / `ask` / `app_connect` / `connect` / `mcp_approval` 接入内核；三套连接机制合一（§3.3.2） | 25 种块一套规则

§3.3.1 接入四条：`cardKey`；13 值枚举；终态经 `settleInteraction`；可交互性由 `surfaceAffordanceFor`。

§3.3.2 收口：**不是删块重写**，块是内核状态的视图。

| 场景 | 收口到 | 视图 |
|---|---|---|
| 连接 | `needs_connection` | `connect` / `app_connect` / A2UI `needs_connection` |
| 批准 | `awaiting_approval` | `ask`+`approvalEffectId` / `mcp_approval` / A2UI 批准卡 |
| 问答 | `question.clarify`（有 `choice.options` 则 choice 形态） | `ask`（自由文本）/ `choice` |

Slack `Allow once` / `Skip`：§14 #11，同一 deny 动作的渲染差异。

### 本批 AC

| 编号 | 本批如何验收 |
|---|---|
| AC-25 | L0-A 6 种块终态走 `settleInteraction`（源码扫描按块类型） |
| AC-26 | 同一连接需求只出一张连接卡（集成：compose `needs_connection` 与 `connect_app` 不叠第二张） |
| G11 / G12 | 带确认生命周期的卡共用内核；连接/审批/问答各一条路径 |
| §3.3.1 | 每种块：cardKey、13 值、settle、affordance |
| §14 #11 | Slack 审批卡 deny 文案为 **Skip**；web/mobile 仍 **Deny**；`id` 仍是 `deny` |
| AC-23 | 两账号断开各一张指名卡：intent `connect.{provider}.{accountId}`，不合并成一张「Reconnect Gmail」 |

### 明确不做

| 候选 | 为何不做 |
|---|---|
| F catalog / 协议族 / AC-28–31 | §8 F |
| AC-21 同信息去重、AC-22 加载失败降级、§6.11 等待文案 | §8 E 未列 |
| 删除 `choice`/`ask`/`app_connect`/`connect`/`mcp_approval` | §3.3.2 禁止 |
| 把它们编译成 A2UI 演示卡 | t318：对标生产接线 |
| L0-B/C、computer/voice 确认生命周期 | §3.3.3 |
| 付费重构、真实发信、真实模型 | t318 |
| 把 lint 三处无关文件当 E 去修 | 非 L0-A；先给 main 基线 |

**批内顺序：** 先派生 status 映射与 intent/cardKey（Task 1）→ 连接收口（Task 2–3，AC-26）→ 审批（Task 4）→ 问答（Task 5）→ Slack 文案（Task 6）→ 宿主 affordance（Task 7）→ AC-25 扫描（Task 8）→ 审查与验证（Task 9）。

---

## Global Constraints

- Node 22+ / pnpm 9；测试 `--maxWorkers=1`。
- 13 值词表与开放态 3 值、结算豁免 2 值不动。`needs_connection` 已在 `findOpenCard` 查找集、不在部分唯一索引。
- A2UI 注册表仍是那 4 个 product intent（`interaction-capability.test.ts`「exactly four」保持）。L0-A 用 **前缀 intent**，不塞进 `INTERACTION_CAPABILITIES` 表（避免假 form schema / AC-11 膨胀）。
- 菜单/问答 RPC 不得用 `threads.send` 冒充用户消息来结算。
- 真实发信、外部写、真实模型暂停。隔离库 + 测试身份 + FakeComposio。
- 提交英文前缀。不改 `CHANGELOG.md`。不改 main、不合并、不关 PR、不删分支。
- Review 仅 Grok 4.6。

---

## 文件结构

**新建**

| 文件 | 职责 |
|---|---|
| `packages/core/src/l0a-capability.ts` | intent 前缀、`l0aIntentForBlock`、派生 legacy status |
| `packages/core/src/l0a-capability.test.ts` | 映射表驱动 |
| `packages/adapters/src/interaction-l0a-publish.ts` | 非 A2UI 视图的 publish-or-amend（不 compile） |
| `packages/adapters/src/interaction-l0a-publish.test.ts` | 同 intent 改正不叠卡；settle 走内核 |
| `packages/core/src/approval-surface-copy.ts` | Slack Skip vs Deny |

**修改（要点）**

| 文件 | 改动 |
|---|---|
| `packages/core/src/interaction-capability.ts` | `isActionIntent` / `cardKindForIntent` 认 L0-A 前缀 |
| `packages/contracts/src/events.ts` | 五块可选 `interactionId` + `cardStatus`（13 值） |
| `packages/adapters/src/connect-app.ts` | 经 L0-A publish；已有同 app 的 `needs_connection` 则不新卡 |
| `packages/adapters/src/run-tools-interaction.ts` | 已有 `connect.{provider}` 活卡时 compose 不另开连接视图 |
| `packages/adapters/src/approval-ask.ts` | 构建块后由调用方 publish；deny 标签可注入 |
| `packages/adapters/src/mcp-server-tool.ts` | mcp_approval 经 L0-A publish |
| `packages/adapters/src/run-turn.ts` 等 ask 写入点 | 问答走 `question.clarify` |
| `apps/api/src/onboarding.ts` | choice 经内核 |
| `packages/adapters/src/interaction-kernel-guard.test.ts` | AC-25：L0-A 块终态写入点 |
| Web/mobile 卡宿主 | `cardStatus` 存在则 `surfaceAffordanceFor`；终态无按钮 |
| `packages/core/src/index.ts` | 导出 |

---

## Intent 规则（唯一写法）

```
connect.{provider}                  // 首次连接某 app
connect.{provider}.{accountId}      // AC-23 指名重连，不得与上一项合并
approval.effect.{effectId}
approval.mcp.{serverId}
question.clarify
```

`cardKey = sha256(threadId + "\0" + intent)` 不变。

派生：

| kernel | app_connect/connect | ask | mcp_approval | choice |
|---|---|---|---|---|
| `needs_connection` | `pending` | — | `pending` | — |
| `awaiting_approval` | — | `pending` | `pending` | — |
| `collecting` | — | `pending` | — | 无 `answerId` |
| `succeeded` / `executed` / `sent` / `confirmed` | `connected` | `answered` | `connected` | 保留 `answerId` |
| `cancelled` | `connected` 不出现；块终态无按钮 | `answered` 或 dismissed | `dismissed` | 保留已选 |
| `superseded` / `expired` / `failed` | 派生 `pending` 但 affordance 终态/retry | 同上 | 同上 | 同上 |

`kind: "connect"` 生产几乎无写入；仍实现映射，避免漏 AC-25。

---

## Task 1：L0-A intent 与派生 status（§3.3.1 前置）

生产接线：后续所有 L0-A publish 只调这些函数，禁止各文件拼 intent 字符串。

- [ ] **Step 1: 写失败测试** `packages/core/src/l0a-capability.test.ts`

```ts
it("names connect / approval / question intents from the live block kinds", () => {
  expect(l0aIntentForBlock({ kind: "app_connect", provider: "gmail", name: "Gmail", description: "", logo: null, status: "pending" })).toBe("connect.gmail");
  expect(l0aIntentForBlock({ kind: "app_connect", provider: "gmail", name: "Gmail", description: "", logo: null, status: "pending" }, { accountId: "ca_1" })).toBe("connect.gmail.ca_1");
  expect(l0aIntentForBlock({ kind: "mcp_approval", name: "S", serverId: "srv1", transport: { type: "sse" }, endpoint: null, needsOAuth: true, status: "pending" })).toBe("approval.mcp.srv1");
  expect(l0aIntentForBlock({ kind: "ask", text: "Allow?", approvalEffectId: "eff1", status: "pending", actions: [] })).toBe("approval.effect.eff1");
  expect(l0aIntentForBlock({ kind: "ask", text: "Which city?", status: "pending" })).toBe("question.clarify");
  expect(l0aIntentForBlock({ kind: "choice", question: "Pick", options: [] })).toBe("question.clarify");
});

it("treats L0-A prefix intents as action cards without registering A2UI forms", () => {
  expect(cardKindForIntent("connect.gmail")).toBe("action");
  expect(isActionIntent("question.clarify")).toBe(true);
  expect(isActionIntent("approval.mcp.srv1")).toBe(true);
  expect(findInteractionCapability("connect.gmail")).toBeUndefined();
});

it("derives legacy block status from the kernel", () => {
  expect(derivedL0aBlockStatus("app_connect", "needs_connection")).toBe("pending");
  expect(derivedL0aBlockStatus("app_connect", "succeeded")).toBe("connected");
  expect(derivedL0aBlockStatus("ask", "awaiting_approval")).toBe("pending");
  expect(derivedL0aBlockStatus("ask", "succeeded")).toBe("answered");
  expect(derivedL0aBlockStatus("mcp_approval", "cancelled")).toBe("dismissed");
});
```

- [ ] **Step 2: 跑测确认失败**

```bash
pnpm vitest run --maxWorkers=1 packages/core/src/l0a-capability.test.ts
```

Expected: FAIL — 模块不存在。

- [ ] **Step 3: 最小实现**

`l0a-capability.ts`：前缀 `connect.` / `approval.` / `question.`。`cardKindForIntent` / `isActionIntent` 在 registry miss 时问 `l0aCardKindForIntent`。

`derivedL0aBlockStatus(kind, kernelStatus)` 按上表。

- [ ] **Step 4: 跑测通过并 commit**

```bash
pnpm vitest run --maxWorkers=1 packages/core/src/l0a-capability.test.ts packages/core/src/interaction-capability.test.ts
pnpm --filter @matebot/core check
git add packages/core
git commit -m "$(cat <<'EOF'
feat(core): map L0-A blocks onto kernel intents and derived status

Connect, approval, and question cards share action-card identity without
adding A2UI form capabilities.
EOF
)"
```

---

## Task 2：L0-A publish-or-amend（非 A2UI）

生产接线：`createInteraction` + 原块 kind 的 message；**不**走 `compileInteractionPlan`。

- [ ] **Step 1: 失败测试** `packages/adapters/src/interaction-l0a-publish.test.ts`

第二次 `publishL0aView` 同 `connect.gmail`：`createInteraction` 一次，第二次改正既有 message 的块（`amended: true`），块带 `interactionId` 与 `cardStatus: "needs_connection"`，legacy `status: "pending"`。

- [ ] **Step 2: 实现** `publishL0aView(prisma, { spaceId, threadId, botId, runId?, lease?, intent, title, status, block, resumePlan? })`

1. `findOpenCard`（已含 `needs_connection`）。
2. 有则改正：更新 interaction、原地替换该 message 的 L0-A 块。
3. 无则 `createInteraction` + `createThreadMessageInTransaction`，回写 `messageId`。
4. `stampL0aBlock(block, { interactionId, cardStatus })` 写入 `interactionId`/`cardStatus` 并把 legacy status 派生出来。
5. 终态调用 `settleInteraction`，禁止 `prisma.interaction.update({ data: { status } })`。

Plan JSON：`{ intent, title, fields: [], nextStep: "request_approval", riskLevel: "low" }`。

- [ ] **Step 3: contracts** 给 `ask` / `choice` / `app_connect` / `connect` / `mcp_approval` 增加可选 `interactionId: Id`、`cardStatus: InteractionStatus`。

- [ ] **Step 4: 测试 + commit**

```bash
pnpm vitest run --maxWorkers=1 packages/adapters/src/interaction-l0a-publish.test.ts packages/contracts/src/interaction.test.ts
git commit -m "feat(adapters): publish L0-A views through the interaction kernel"
```

---

## Task 3：连接一条路径（AC-26、§3.3.2）

- [ ] **Step 1: 失败测试**（`connect-app.test.ts` + `run-tools-interaction.test.ts`）

1. 线程已有 `email.compose` + `needs_connection` 时 `connectApp(..., "gmail")` **不**再插入 `app_connect` 消息，返回已有卡等待授权。
2. 线程已有 pending `app_connect` gmail 时再 `connectApp` 仍只有一张（现有 nonce 行为保留，并断言 Interaction 行 = 1）。
3. 两个 `accountId` 的 `connect.gmail.ca_1` / `connect.gmail.ca_2` 可并存（AC-23）。

需要 `loadOwnerEmailConnections` / `interactionRequiredApp("email.compose") === "email"` 且 gmail 满足 email。

- [ ] **Step 2: `connectApp` 改走 `publishL0aView`**，intent `connect.{slug}`。先查同线程开放 `needs_connection` 且 `connectionSatisfiesApp(app, provider)` 的 interaction；命中则 return 不发新块。

- [ ] **Step 3: 测试 + commit**

```bash
pnpm vitest run --maxWorkers=1 packages/adapters/src/connect-app.test.ts packages/adapters/src/interaction-l0a-publish.test.ts
git commit -m "feat(adapters): one connection card per app demand"
```

---

## Task 4：审批接入 `awaiting_approval`

- [ ] **Step 1: 失败测试** `approval-ask` / `mcp-server-tool`：publish 后 interaction `awaiting_approval`，块 `cardStatus` 同值；Allow/Deny 经 `settleInteraction` → `succeeded` / `cancelled`。mcp dismissed → `cancelled`。

- [ ] **Step 2: 在现有 persist 点包一层 `publishL0aView`。** 不要把 ask 变成 A2UI。`expiresAtFor("awaiting_approval")` 照用。

找到现有「按 effect 答题」的路由，结算改 `settleInteraction` 再派生块 status。

- [ ] **Step 3: commit**

```bash
git commit -m "feat(adapters): settle approval and MCP cards through the kernel"
```

---

## Task 5：问答 `question.clarify`

- [ ] **Step 1: 失败测试** 同线程第二张 `choice` 或非审批 `ask` 改正同一 cardKey，不新增开放行。

- [ ] **Step 2: `run-turn.ts` 文本 ask、`onboarding.ts` choice 走 `publishL0aView` intent `question.clarify`，status `collecting`。回答 `settleInteraction` → `succeeded`。** 审批 ask 不得用这个 intent（有 `approvalEffectId` 走 Task 4）。

- [ ] **Step 3: commit**

```bash
git commit -m "feat(adapters): merge choice and ask onto one question card key"
```

---

## Task 6：Slack `Allow once` / `Skip`（§14 #11）

新文案 **Skip**（Slack 审批 deny 标签）。Web/mobile 保持 **Deny**。动作 `id` 仍为 `deny`，避免结算分叉。

```ts
export function approvalDenyLabel(surface: "thread" | "slack"): "Deny" | "Skip" {
  return surface === "slack" ? "Skip" : "Deny";
}
```

在 **Slack/messaging 投递** 审批 ask 时改 label；thread 宿主不改。若投递层今天原样转发块，加一个纯函数 `relabelApprovalActionsForSlack(block)`。

- [ ] **测试 + commit**

```bash
git commit -m "feat(core): Slack approval cards say Skip instead of Deny"
```

PR `## What` 必须引用 **Skip**。

---

## Task 7：宿主 affordance

Web `message-cards.tsx` / `AskCard` / `AppConnectCard`；mobile `ask-block.tsx` / `AppConnectCard` / `ChoiceCard` / `a2ui-native-surface` 旁的 mcp 卡：

若 `block.cardStatus` 存在：`surfaceAffordanceFor({ status: block.cardStatus })`。`terminal` → 不画 Authorize / Allow / 选项。`retry` 仅 `expired`/`failed`。

无 `cardStatus` 的存量块保持旧 pending 行为（迁移未回填）。

- [ ] **测试：终态 mcp/app_connect/ask 无按钮。commit**

```bash
git commit -m "feat(ui): L0-A hosts take interactivity from kernel status"
```

---

## Task 8：AC-25 扫描

在 `interaction-kernel-guard.test.ts` 增加：生产写入 `kind: "app_connect"|"ask"|"choice"|"connect"|"mcp_approval"` 且把块标终态（connected/answered/dismissed）的文件，必须同时出现 `settleInteraction` 或 `publishL0aView`。允许测试文件。

- [ ] **测试红 → 修漏网写入 → 绿 → commit**

```bash
git commit -m "test(adapters): require L0-A terminal writes to settle through the kernel"
```

---

## Task 9：同模型审查 + 最终验证

Grok 4.6 自审 Task 1–8。核对：未删块种；未把 L0-A 编成 A2UI；AC-26 不叠卡；Slack 只改 label。

然后在**最终 E head**上：

```bash
# 受影响 + B 广回归（原完整范围；失败后整组重跑）
pnpm vitest run --maxWorkers=1 \
  packages/core/src packages/adapters/src apps/api/src \
  apps/web/src/components/a2ui apps/web/src/pages/shell apps/mobile/lib

pnpm --filter @matebot/core --filter @matebot/adapters --filter @matebot/db \
  --filter @matebot/contracts --filter @matebot/api --filter @matebot/web \
  --filter @matebot/mobile check

pnpm lint
# 3 个既有 error：先 git show origin/main 对照同一行，再决定是否在范围内修

VERIFY_DATABASE=1 COPY_TEST_DATABASE=1  # matebot_b_accept @ 127.0.0.1:5433
pnpm vitest run --maxWorkers=1 \
  packages/adapters/src/interaction-stale.postgres.test.ts \
  packages/adapters/src/interaction-expire.postgres.test.ts \
  packages/adapters/src/interaction-lifecycle.postgres.test.ts \
  packages/adapters/src/interaction-revive.postgres.test.ts \
  apps/api/src/interaction-retry.postgres.test.ts \
  apps/api/src/interaction-discard.postgres.test.ts \
  apps/api/src/interaction-connection-recovery.postgres.test.ts \
  apps/api/src/interaction-recovery.postgres.test.ts \
  packages/db/src/interaction-card-key.postgres.test.ts

# Live：尽量完整 a2ui-live.spec.ts，不断言放宽。tsx launcher。
pnpm exec tsx apps/api/e2e-a2ui.mjs a2ui-live.spec.ts
```

截图到 `/opt/cursor/artifacts/`。Mobile stub 不称原生。

---

## Task / AC 矩阵

| Task | AC / 规格 | 生产接线 |
|---|---|---|
| 1 intent + 派生 | §3.3.1、G11 | `l0aIntentForBlock` |
| 2 L0-A publish | cardKey / 13 值 | `publishL0aView` |
| 3 连接合一 | AC-26、AC-23、G12 | `connectApp` + compose 互斥 |
| 4 审批 | awaiting_approval | ask + mcp |
| 5 问答 | question.clarify | choice + ask |
| 6 Slack Skip | §14 #11 | messaging 投递 |
| 7 宿主 | surfaceAffordanceFor | web/mobile |
| 8 扫描 | AC-25 | kernel-guard |
| 9 验证 | B 广回归 / live | — |

---

## 本批结束后

推 `fix/tooling-defects-a2ui-presentation` / PR 50。更新 PR 时保留 GitHub UI 人工编辑。报告计划路径、矩阵、head、原始命令与 skip/失败、截图、B/C/D/E 遗留、PR 状态。停等父端。**不进入 F。**
