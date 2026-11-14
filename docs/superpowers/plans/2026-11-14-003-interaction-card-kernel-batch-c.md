# 交互卡内核（C 批：加固）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Do **not** use subagent-driven-development or any other-model Task/review/fallback: parent instruction t316 requires Grok 4.6 only. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新消息不再立刻毁掉正在编辑的卡；连接完成后按存下的计划原地续跑；卡的每一次状态变化可追溯；模型下一轮能从历史里读到终态和关键槽位。

**Architecture:** Spec §8 C is four deliverables on the A/B kernel: (1) two-stage settle writes `staleAt` on a user message and only CAS-settles to `superseded` at run end; (2) `needs_connection` stores a `resumePlan` with account identity and resumes in place without asking the model; (3) append-only `interaction_events`; (4) `blocksToAgentHistoryText` reads 13-value `status` and key slots. Auto-expiry (AC-19) is included as a C sub-stage because §4.3.1 is L1, A/B plans deferred the worker here, and t316 asked to complete the real expiry path if C can — it does **not** stand in for B's iOS or real-send leftovers.

**Tech Stack:** TypeScript, Prisma 7.10.1 (PostgreSQL), Vitest, Lingui (web), locale tables (mobile), pnpm workspace

---

## B 批遗留验收清单（t316：记录缺项，开始 C；缺项不是通过）

t316 (2026-11-14 06:20 Asia/Shanghai) overrides the old “C only after B fully accepted” gate **only** to let C start with leftovers recorded. Leftovers stay **not passing**.

### 代码完成、现场未验

| 项 | 状态 | 证据边界 | 不得用什么代替 |
|---|---|---|---|
| B Tasks 1–10 代码（派生链、终态折叠、Retry CAS、日历 stamp、Web/Mobile 宿主） | 代码在 `fix/tooling-defects-a2ui-presentation` | 实现提交至 `2ce8e3f135e2bb20a8a0491dc3a7921ff8a7ad47` | — |
| 整组回归 16920 pass / 0 fail / 445 skip | **仅** head `b6cba1bbd` | 不可把该数字冒称为更新 head 已重跑 | 新 C head 必须自己重跑 |
| 隔离 PG 45/45（retry/revive 等） | **仅** head `b6cba1bbd` | 同上 | 新 C head 必须自己重跑 |
| 隔离 Chromium → 生产 `retryInteraction` → PG 同 cardKey/message/surface 恢复及重载 | **仅** head `2ce8e3f13`，**1** 条 live 测试 | expired 来自标注种子（`settleInteraction` + `surfaceStampFor`），**不是**自动过期 | C 的 AC-19 浏览器路径补自动过期；**不**替代本项作为 B 通过 |
| iOS 模拟器/真机终态卡（无 Send；failed 仅 Retry） | **未验** | 本环境无 iOS | Web/mobile 单测与 stub **不得**冒充 |
| 真实连点两次发送后刷新 / 单次外部执行 | **未验**（真实发信暂停） | — | 隔离 PG 幂等测试不是现场发信 |
| 真实模型/provider 回合 | **暂停** | t316 维持 | C 不得恢复 |
| 外部业务写 | **暂停** | t316 维持 | C 不得恢复 |

### 本批仍不得宣称 B 通过的项

- iOS 模拟器/真机终态。
- 真实连点两次发送后刷新、单次外部执行。
- 真实模型/provider 回合与外部写（仍暂停）。

C 完成后停等父端核验。不启动 D。

---

## 范围：以权威规格为准

规格 `docs/superpowers/specs/2026-11-13-interaction-card-kernel-design.md` §8 C 行原文：

> **C 加固** | 两段式新消息结算 + 连接卡续跑 + 事件表 + 历史投影（含关键槽位）

对应 AC：AC-8 / 8b / 8c / 8d / 8e（§5.4）、AC-9（§5.5）、§4.5 事件表、AC-16 / AC-16b（§6.7.1）。`resumePlan` 必须含账号身份（§5.5 → §6.13）；本批做续跑身份，**不做** AC-23「两账号两张指名卡」（属连接统一，E/后续）。

A 计划 C 行还写了「过期扫描」。规格 §8 C 格未点名 AC-19，但 §4.3.1 是 L1，B 计划把扫描留给 C，t316 允许 C 顺带补齐自动过期真实链路与浏览器验收。**纳入本批 C5。** 它补的是 B 标注种子不是扫描器这一缺口，**不得**替代 iOS/真实发信。

### 候选范围：明确不做

| 候选 | 为何不做 |
|---|---|
| `surfaceCardIsLive` 删除 | 规格是「观察一轮后删除」；B 刚落地；§8 C 未列 |
| AC-21 §6.10 同信息去重 | §8 C 未列；B 计划误列入 C |
| AC-23 多账号各出一张卡 | §8 C 是续跑；出卡统一是 AC-26/E |
| §6.11 等待文案 | 确认路径仍不写 `expiresAt`（A/B 空洞，需发信崩溃方案） |
| AC-4 `executing`、确认路径 `expiresAt`、真实发信 | 暂停；不扩展付费机制 |
| D：`cardKind`、46 intent、批准菜单四项、`Bot.draftsDisabled` | §8 D |

**批内顺序（规格）：** 两段式结算必须早于任何依赖 `superseded` 的功能，否则会先变成「每次 NL 编辑换卡」。

---

## Global Constraints

- Node 22+ 与 pnpm 9 在 PATH 上。
- 测试从仓库根跑，**必须** `--maxWorkers=1`：
  ```bash
  pnpm vitest run --maxWorkers=1 packages/core/src/<file>.test.ts
  ```
- 类型检查：`pnpm --filter @matebot/{core,adapters,db,api,web,mobile} check`。
- 真库：`VERIFY_DATABASE=1 COPY_TEST_DATABASE=1`，owner + `matebot_app` RLS。只许隔离测试库与测试身份。禁止 `.5` / 用户业务数据。
- 13 值词表与开放态 3 值、结算豁免 2 值不动。不新增 `stale` 状态。
- `staleAt` 是列不是状态：带标记的 `collecting` 仍不可确认。
- 结算到 `superseded` / `expired` **必须** `surfaceStampFor` 重盖消息块。只改行、不盖块，宿主仍画 Send（B 已证实）。
- `needs_connection` / `unknown` 不写 `staleAt`、不被批量结算（E7 / AC-5）。
- 新表可加；删除列必须 `-- deferred`。本批只加表/列。
- 过期任务按**单张卡**认领（`interaction.expire` + `replaceKey`），禁止全局槽位串行所有 Space。丢失的 job 由 reconciler 补扫到期行。
- 宿主文案：web Lingui 函数内求值；mobile `lib/locales`。已有 `hint.stale` → “There may be a newer version”。
- 提交英文，前缀 `feat:` / `fix:` / `test:` / `chore:`。每 Task 结束 commit。不改 `CHANGELOG.md`。
- 不恢复真实发信、外部写、真实模型。不改 main、不合并、不关 PR、不删分支、不发布、不部署。

---

## 文件结构

**新建**

| 文件 | 职责 |
|---|---|
| `packages/adapters/src/interaction-stale.ts` | `markOpenCardsStale` / `settleStaleCards` / `gcStaleCards` |
| `packages/adapters/src/interaction-stale.test.ts` | AC-8 族单测（假 Prisma） |
| `packages/adapters/src/interaction-stale.postgres.test.ts` | 隔离 PG：软标记、CAS、NL 编辑不换卡、GC |
| `packages/adapters/src/interaction-expire.ts` | 到期认领 → `settleInteraction(expired)` + 盖块 |
| `packages/adapters/src/interaction-expire.test.ts` | AC-19 时间推进 |
| `packages/adapters/src/interaction-events.ts` | 追加 `interaction_events` |
| `packages/core/src/interaction-history.ts` | 槽位摘要（email to/subject，calendar 时间范围） |
| `packages/db/prisma/migrations/20261127120000_interaction_events/migration.sql` | 事件表 + RLS |
| `apps/api/src/e2e-expire-due-interactions.ts` | live e2e 专用：跑生产过期函数（非标注 `expired` 种子） |

**修改（要点）**

| 文件 | 改动 |
|---|---|
| `packages/core/src/attachments.ts` | 历史读 `status`，拼关键槽位 |
| `packages/core/src/interaction-capability.ts` | `historyDigestFields` |
| `packages/contracts/src/interaction.ts` | block 可选 `stale`、`historySlots` |
| `packages/adapters/src/interaction-kernel-store.ts` | settle 成功后盖块；可选写事件 |
| `packages/adapters/src/interaction-publish.ts` | `needs_connection` 写入 `resumePlan`；已有清空 `staleAt` |
| `packages/adapters/src/interaction-field-writer.ts` | 字段编辑 `staleAt: null` 并去掉 block `stale` |
| `apps/api/src/interaction-service.ts` | 确认清空 `staleAt`；连接卡写入账号身份 |
| `apps/api/src/interaction-resume.ts` | 按 `resumePlan` 原地恢复，不排队模型回合 |
| `apps/api/src/thread-target.ts`、`routes/threads.ts` | 用户消息后 `markOpenCardsStale` |
| `packages/adapters/src/run-turn.ts` | 回合开始 GC；`finalizeRun` 后 `settleStaleCards` |
| `packages/adapter-kit` jobs | `interaction.expire` |
| `packages/adapters/src/job-reconciler.ts` | 补扫到期 `expiresAt` |
| Web/Mobile 宿主 | `block.stale` 时显示 `surfaceStaleHint` |
| `apps/web/e2e/a2ui-live.spec.ts` | 自动过期 → 折叠 Retry（不替代 B 的标注 Retry 用例） |

---

## Task 1：历史投影读 status + 关键槽位（AC-16 / AC-16b）

独立纯函数，不依赖结算写入。

- [ ] **Step 1: 写失败测试** `packages/core/src/attachments.test.ts`

```ts
it("projects superseded from status, not lifecycle", () => {
  expect(
    blocksToAgentHistoryText([
      {
        kind: "a2ui_surface",
        interactionId: "ix-1",
        surfaceId: "s-1",
        protocolFamily: "v0_9",
        draftVersion: 1,
        intent: "email.compose",
        status: "superseded",
        lifecycle: "draft",
        historySlots: { to: "example@example.test", subject: "产品发布" },
      },
    ]),
  ).toBe(
    "[card: email.compose → superseded (To example@example.test · Subject 产品发布)]",
  );
});
```

另测：`expired` / `unknown`；无 `status` 时回退 `lifecycle`；无槽位时保持旧 `summary` 形态。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm vitest run --maxWorkers=1 packages/core/src/attachments.test.ts
```

- [ ] **Step 3: 最小实现** `blocksToAgentHistoryText` 对 `a2ui_surface`：`state = block.status ?? block.lifecycle ?? "draft"`；槽位来自 `historySlots`（按 capability `historyDigestFields` 的标签拼接）。email：`to`/`subject`；calendar.create：事件数 + 时间范围（`name`/`start`/`end`）。

- [ ] **Step 4: 跑测试通过并 commit**

```bash
pnpm vitest run --maxWorkers=1 packages/core/src/attachments.test.ts packages/core/src/interaction-capability.test.ts
git add packages/core packages/contracts
git commit -m "feat(core): project card status and key slots into agent history"
```

---

## Task 2：两段式结算核心（AC-8 / 8c / 8d / 8e）

规格 §5.4。必须先于任何「新消息 → superseded」产品行为。

- [ ] **Step 1: 写失败测试** `packages/adapters/src/interaction-stale.test.ts`

覆盖：

1. `markOpenCardsStale`：开放态写同一 `staleAt`，**不**改 `status`；`needs_connection`/`unknown` 不写。
2. `settleStaleCards`：`settleInteraction(..., { staleAtSnapshot })` → `superseded`；调用方随后盖块（或 settle 自己盖块）。
3. AC-8c：结算前卡已 `sent` 或 `staleAt` 已清空 → `concurrent` / 跳过，行仍是 `sent`。
4. AC-8d：快照是旧 `staleAt`，行上是新 `staleAt` → 不杀。
5. AC-8e：`gcStaleCards({ before: runStart })` 把 `staleAt < runStart` 的开放卡结算为 `superseded`。

- [ ] **Step 2: 跑失败** `pnpm vitest run --maxWorkers=1 packages/adapters/src/interaction-stale.test.ts`

- [ ] **Step 3: 实现** `interaction-stale.ts` + 扩展 `settleInteraction`：成功后用 `surfaceStampFor` 重盖该卡 `message.blocks` 里匹配的 `a2ui_surface`（`stale` 去掉）。`markOpenCardsStale` 给块打 `stale: true`，时间线**不**追加消息行，可发 `thread.surface.updated`。

- [ ] **Step 4: 通过并 commit** `feat(adapters): two-stage staleAt settle for open cards`

---

## Task 3：AC-8b 原地编辑不清结算 + 清空 staleAt

三种清空：`edit_interaction`、卡内字段、确认。`publishOrAmend` 已 `staleAt: null`。

- [ ] **Step 1: 失败测试**
  - field-writer：`data` 含 `staleAt: null`，块无 `stale`。
  - 确认路径同样。
  - postgres：先 `markOpenCardsStale`，再 `publishOrAmend` 改 subject → 仍 1 行、同一 `id`/`cardKey`、`staleAt` null、status 仍开放；随后 `settleStaleCards` 不改它。

- [ ] **Step 2–4: 实现、跑、commit** `fix(adapters): clear staleAt when the person still uses the card`

---

## Task 4：接入用户消息 / 回合开始 / 回合结束

- [ ] **Step 1: 失败测试**（mock 调用点或抽函数测）
  - 用户消息 persist 后调用 `markOpenCardsStale({ threadId, at })`。
  - 回合开始：`gcStaleCards({ threadId, before: runStartedAt })`。
  - `finalizeRun` 成功后：`settleStaleCards({ threadId, staleAtSnapshot })`。快照必须是**本回合开始时读到的** `staleAt`，不是结束时的 `now()`。

实现要点：在创建 run / 处理用户消息时记下本线程开放卡的 `staleAt` 集合（通常同一时刻），run 结束用该快照 CAS。E1：运行中确认把 `staleAt` 清掉 → 不匹配。E2：运行中 `sent` → status 不在开放态 → 不匹配。

Hook 点：`apps/api/src/thread-target.ts` 主发送、`apps/api/src/routes/threads.ts` follow-up；`packages/adapters/src/run-turn.ts`（或 executor continueRun）开始与 finalize 之后。不要改 `createThreadMessageInTransaction` 本身（`@matebot/db` 不能依赖 adapters）。

- [ ] **Step 2–4: 实现、跑、commit** `feat(api): mark cards stale on user messages and settle at run end`

---

## Task 5：宿主「可能有更新」提示

`surfaceStaleHint` 与 `hint.stale` 文案已在。Web/Mobile 在非终态且 `block.stale` 时显示一行。可交互性不变。

- [ ] **Step 1: 宿主测试** `data-testid="a2ui-surface-stale-hint"` 仅当 `block.stale === true`。
- [ ] **Step 2–4: 实现、intl extract（web）、commit** `feat(ui): show a stale hint without changing affordance`

---

## Task 6：连接卡 resumePlan（AC-9）

规格 §5.5：发布 `needs_connection` 时存 `{ provider, accountId, displayEmail, intent, slots }`。连接完成后按计划原地恢复，**不再询问模型**。

现状：`resumeInteractionAfterConnection` 已把等待卡翻成 `collecting` 且无模型回合；缺口是没有存/用账号身份与 slots，断线重连可能连错账号。无等待卡时仍可排队隐藏 prompt（创建日历、回合在出卡前结束）——那不是 AC-9 的「已有连接卡」路径。

- [ ] **Step 1: 失败测试**
  - 发布 `needs_connection` 后 `plan.resumePlan`（或行上等价字段）含 `accountId` + `displayEmail` + `slots`。
  - 连接完成：status `collecting`，slots 恢复，**不** `enqueue run.continue`。
  - 两张等待卡不同 `accountId` 时，只恢复匹配本次连接的那张。

账号来源：`Connection.id` + 已知发送地址，否则 `displayName`。UI 不写供应商名当账号。

- [ ] **Step 2–4: 实现、跑、commit** `feat(api): resume a connection card from its stored plan`

---

## Task 7：`interaction_events` 表

规格 §4.5。追加-only。

```prisma
model InteractionEvent {
  id             String   @id @default(cuid())
  interactionId  String
  interaction    Interaction @relation(...)
  at             DateTime @default(now())
  kind           String   // published | amended | settled | dispatch_requested | dispatch_rejected | revived
  fromStatus     String?
  toStatus       String?
  reason         String?
  runId          String?
  @@index([interactionId, at])
  @@map("interaction_events")
}
```

Migration：建表、FK、RLS（经 parent `spaceId`，同 `interaction_surfaces`）、索引。默认 privileges 已 GRANT 新表给 runtime。

- [ ] **Step 1: 失败测试** settle/publish/revive 各追加一行；无 UPDATE 路径（源码扫描 `interactionEvent.update` 为零）。
- [ ] **Step 2–4: 实现、commit** `feat(db): append-only interaction events`

---

## Task 8：过期扫描（AC-19）+ 隔离 PG + live 浏览器

规格 §4.3.1：`expiresAt < now()` 且仍开放 → `settleInteraction(expired)` **并盖块**。`unknown`/`needs_connection` 不过期。

实现：发布 `awaiting_approval` 且写入 `expiresAt` 时 enqueue `interaction.expire` `{ interactionId }`，`availableAt = expiresAt`，`replaceKey = interaction.expire:<id>`。handler 只认领该行。reconciler 补扫丢失 job。禁止「全库一个槽位」的扫描循环。

- [ ] **Step 1: 单元 + postgres**
  - `expiresAt` 已过的 `awaiting_approval` → `expired`，块 `status: "expired"`，模板 `action-expired-card`。
  - `ready_for_review` 无 `expiresAt` → 不动。
  - `unknown` 即使被误写 `expiresAt` 也不过期。

- [ ] **Step 2: live e2e**（隔离 clone DB，非 `.5`）
  1. `present_interaction` 出卡。
  2. 测试专用路由把该卡写成 `awaiting_approval` + 过去的 `expiresAt`（**不是**直接写 `expired`）。
  3. 调用生产 `expireDueInteractions`。
  4. reload：折叠「Expired, nothing was sent」+ Retry。
  5. 截图 `/opt/cursor/artifacts/a2ui-live-auto-expired.png`。

本路径证明扫描器，**不**替代 B 的 iOS/真实发信，也**不**替代 `2ce8e3f13` 的标注 Retry 用例。

- [ ] **Step 3: commit** `feat(adapters): expire awaiting_approval cards when their window ends`

---

## 收尾：C 批验收

- [ ] 受影响包 + 相关回归（**本 head**，不得引用 `b6cba1bbd` 的 16920 当作本 head 结果）：

```bash
pnpm vitest run --maxWorkers=1 \
  packages/core/src/attachments.test.ts \
  packages/core/src/interaction-capability.test.ts \
  packages/core/src/surface-stamp.test.ts \
  packages/adapters/src/interaction-stale.test.ts \
  packages/adapters/src/interaction-expire.test.ts \
  packages/adapters/src/interaction-kernel-store.test.ts \
  packages/adapters/src/interaction-publish-amend.test.ts \
  apps/api/src/interaction-resume.test.ts \
  apps/api/src/interaction-retry.test.ts \
  apps/web/src/components/a2ui \
  apps/mobile/lib
pnpm --filter @matebot/core check && pnpm --filter @matebot/adapters check \
  && pnpm --filter @matebot/db check && pnpm --filter @matebot/api check \
  && pnpm --filter @matebot/web check && pnpm --filter @matebot/mobile check
pnpm lint
```

- [ ] 隔离 PG：`VERIFY_DATABASE=1 COPY_TEST_DATABASE=1` 跑 stale / expire / retry postgres 测试。
- [ ] 隔离 live Chromium：自动过期路径 + 保留 B Retry 路径。
- [ ] AC 矩阵写入 PR `## Tested`。B 遗留三项保持未验。
- [ ] 停等父端。不启动 D。

### AC 矩阵（本批负责）

| AC | Task | 完成含义 |
|---|---|---|
| AC-8 | 2, 4 | 新消息打 `staleAt`，回合结束才 `superseded` 且块已盖 |
| AC-8b | 3 | NL/字段编辑原地更新，不换卡 |
| AC-8c | 2 | 运行中确认/发送，CAS 不改成 superseded |
| AC-8d | 2 | 旧快照不杀新 `staleAt` |
| AC-8e | 2, 4 | 残留 `staleAt` 在下一回合 GC |
| AC-9 | 6 | 连接完成按 resumePlan 原地续跑，无模型回合 |
| AC-16 | 1 | 历史含 superseded/expired/unknown |
| AC-16b | 1 | 投影含 `example@example.test` |
| AC-19 | 8 | worker/认领把到期审批卡变为 expired 并盖块 |
| §4.5 | 7 | 追加-only 事件行 |

§6.13 账号身份随 AC-9 写入 `resumePlan`。AC-23 整卡分裂不在本批。

---

## 实施偏差（预声明）

- 过期用**按卡 delayed job + reconciler 补扫**，不用全站单槽扫描循环。语义仍是 §4.3.1 的 `expiresAt < now()` → `expired`。
- `resumePlan` 嵌在已存 `plan` JSON（规格允许的二选一），不加列，避免卡列表查询负担。
- 块增加可选 `stale` 与 `historySlots`：客户端仍不读 DB 列（G5）。
- 确认路径仍不写 `expiresAt`（A/B 空洞）。C5 只过期 `publishOrAmend` 已写入 `expiresAt` 的 `awaiting_approval` 卡。
- `surfaceCardIsLive` 保留为无 `status` 旧块回退。
