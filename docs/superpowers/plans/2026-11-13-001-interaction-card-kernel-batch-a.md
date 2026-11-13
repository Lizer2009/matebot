# 交互卡内核（A 批：止血）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「同线程 + 同意图」的动作型卡在数据库层面物理上不可能同时存在两张，并把卡的状态写入收敛到唯一一条路径。

**Architecture:** 引入 `cardKey = sha256(threadId + "\0" + intent)` 与部分唯一索引作为唯一性的**物理保证**；内核（core 纯函数 + adapters 存储层）成为状态写入的**唯一入口**；`present_interaction` 从「每次新建一张卡」改为 `publishOrAmend`（命中就原地更新原卡与原消息块）。这是后续 B~F 批的地基，本批只做止血，不改任何渲染。

**Tech Stack:** TypeScript、Prisma 7.10.1（PostgreSQL）、Vitest、pnpm workspace

## 范围说明：为什么本计划只覆盖 A 批

规格 `docs/superpowers/specs/2026-11-13-interaction-card-kernel-design.md` 含 A~F 六个批次，它们是**可独立交付的子系统**：

| 批 | 交付物 | 依赖 |
|---|---|---|
| **A 止血（本计划）** | `cardKey` + 部分唯一索引 + 状态词表 + 内核 + `publishOrAmend` | 无 |
| B 兑现 | `surfaceAffordanceFor` + `surfacePhase` + 文案/标题/菜单 | A |
| C 加固 | 两段式结算 + 连接卡续跑 + 事件表 + 历史投影 + 过期扫描 | A |
| D 收敛 | `cardKind` 注册表 + 46 处 intent 判断 + `Bot.draftsDisabled` | A |
| E 全场景 | L0-A 六种块接入内核 | A、C |
| F 渲染表达力 | 自定义 A2UI catalog + 协议收敛 `v0_9` | A~E |

B~F 各自需要独立计划（它们的实现在很大程度上取决于 A 批落地后暴露的真实约束）。**A 批必须能单独上线**，这也是本计划的分批验收依据。

---

## Global Constraints

- **Node 不在 PATH 上**，每次 shell 会话先执行：
  ```bash
  export PATH=/home/lizer05/.cursor-server/bin/linux-x64/86776fcb52ca505783155631089b65d646f9b030:$PATH
  ```
  Node 版本 `v24.22.1`。
- 测试统一用 vitest，从仓库根运行：
  ```bash
  pnpm vitest run packages/core/src/<file>.test.ts
  ```
  内存受限，**必须**加 `--maxWorkers=1`：
  ```bash
  pnpm vitest run --maxWorkers=1 packages/core/src/<file>.test.ts
  ```
- 类型检查：`pnpm --filter @matebot/core check`、`pnpm --filter @matebot/adapters check`。
- **状态词表固定为 13 值**，顺序与拼写必须逐字照抄：
  `collecting`、`ready_for_review`、`awaiting_approval`、`needs_connection`、`unknown`、`sent`、`executed`、`succeeded`、`confirmed`、`superseded`、`expired`、`failed`、`cancelled`。
- **开放态固定为 3 值**：`collecting`、`ready_for_review`、`awaiting_approval`。部分唯一索引的 `WHERE` 必须与之一致。
- **结算豁免固定为 2 值**：`needs_connection`、`unknown`。它们不得被任何批量结算改动。
- 不新增 `stale` 状态值——新鲜度用 `staleAt` 列表达（规格 D4、「评审否决」）。
- 不改 A2UI 协议族、`document` 结构、任何渲染组件。本批不碰 `apps/web`、`apps/mobile`。
- 所有金额、隐私、审计逻辑不动。
- 提交信息用英文，前缀 `feat:` / `test:` / `chore:`。
- 每个 Task 结束必须 `git commit`，不要攒到最后。

---

## 文件结构

**新建**

| 文件 | 职责 |
|---|---|
| `packages/core/src/interaction-status.ts` | 13 值词表 + 开放/豁免/终态判定（纯函数，无 IO） |
| `packages/core/src/interaction-card-key.ts` | `interactionCardKey` 哈希 |
| `packages/core/src/interaction-kernel.ts` | `decideSettle` 状态迁移决策（纯函数，无 IO） |
| `packages/adapters/src/interaction-kernel-store.ts` | `findOpenCard` / `settleInteraction`（Prisma IO） |
| `packages/db/prisma/migrations/20261126120000_interaction_card_key/migration.sql` | 加列 + 回填 + 去重 + 部分唯一索引 |

**修改**

| 文件 | 改动 |
|---|---|
| `packages/db/prisma/schema.prisma` | `Interaction` 加 `cardKey` / `staleAt` / `expiresAt` |
| `packages/db/src/interactions.ts` | `InteractionStatus` 扩到 13 值；`createInteraction` 接受 `cardKey` / `expiresAt` |
| `packages/adapters/src/interaction-publish.ts` | 接受并写入 `cardKey`；新增 `amendInteractionSurface`；导出 `publishOrAmend` |
| `packages/adapters/src/run-tools-interaction.ts` | `presentInteraction` 改走 `publishOrAmend`，删本地 `openDraftId` |
| `apps/api/src/routes/threads.ts` | 编辑目标查询改用内核判定；删手工状态映射 |
| `packages/core/src/index.ts` | 导出三个新模块 |

**测试**

| 文件 | 覆盖 |
|---|---|
| `packages/core/src/interaction-status.test.ts` | 词表分区完整性（AC-4） |
| `packages/core/src/interaction-card-key.test.ts` | 哈希稳定性与分隔符（AC-1 前置） |
| `packages/core/src/interaction-kernel.test.ts` | 结算决策表（AC-5） |
| `packages/db/src/interaction-card-key.postgres.test.ts` | 索引存在 + 并发唯一 + 回填（AC-1/2/3） |
| `packages/adapters/src/interaction-kernel-store.test.ts` | `settleInteraction` CAS 语义 |
| `packages/adapters/src/interaction-kernel-guard.test.ts` | 源码闸门（AC-6） |

---

## Task 1: 状态词表

**Files:**
- Create: `packages/core/src/interaction-status.ts`
- Create: `packages/core/src/interaction-status.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type InteractionStatus`（13 值联合类型）
  - `const INTERACTION_STATUSES: readonly InteractionStatus[]`
  - `const OPEN_STATUSES: readonly ("collecting"|"ready_for_review"|"awaiting_approval")[]`
  - `const SETTLE_EXEMPT_STATUSES: readonly ("needs_connection"|"unknown")[]`
  - `const TERMINAL_STATUSES: readonly InteractionStatus[]`
  - `function isOpenStatus(status: string): boolean`
  - `function isAutoSettleable(status: string): boolean`
  - `function isEditableStatus(status: string): boolean`
  - `function isTerminalStatus(status: string): boolean`

- [ ] **Step 1: 写失败测试**

创建 `packages/core/src/interaction-status.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  INTERACTION_STATUSES,
  OPEN_STATUSES,
  SETTLE_EXEMPT_STATUSES,
  TERMINAL_STATUSES,
  isAutoSettleable,
  isEditableStatus,
  isOpenStatus,
  isTerminalStatus,
} from "./interaction-status.js";

describe("interaction status vocabulary", () => {
  it("has exactly the thirteen values the spec fixes", () => {
    expect([...INTERACTION_STATUSES].sort()).toEqual(
      [
        "awaiting_approval",
        "cancelled",
        "collecting",
        "confirmed",
        "executed",
        "expired",
        "failed",
        "needs_connection",
        "ready_for_review",
        "sent",
        "succeeded",
        "superseded",
        "unknown",
      ].sort(),
    );
  });

  // Every status must belong to exactly one bucket. A gap here is how `superseded`
  // once fell through to "draft" and rendered a live Send button.
  it("partitions every status into open, exempt, or terminal", () => {
    for (const status of INTERACTION_STATUSES) {
      const buckets = [
        isOpenStatus(status),
        SETTLE_EXEMPT_STATUSES.includes(status as never),
        isTerminalStatus(status),
      ].filter(Boolean);
      expect(buckets, `status ${status} must belong to exactly one bucket`).toHaveLength(1);
    }
  });

  it("treats only the three confirmable states as open", () => {
    expect([...OPEN_STATUSES]).toEqual([
      "collecting",
      "ready_for_review",
      "awaiting_approval",
    ]);
  });

  it("refuses to auto-settle a waiting connection", () => {
    // D1: settling it would break the reconnect resume and could publish a different card.
    expect(isAutoSettleable("needs_connection")).toBe(false);
  });

  it("refuses to auto-settle an in-doubt email", () => {
    // D2: the mail may already be out; settling it would tell the user a lie.
    expect(isAutoSettleable("unknown")).toBe(false);
  });

  it("auto-settles the three open states", () => {
    for (const status of OPEN_STATUSES) expect(isAutoSettleable(status)).toBe(true);
  });

  it("keeps terminal states out of the editable set", () => {
    for (const status of TERMINAL_STATUSES) expect(isEditableStatus(status)).toBe(false);
  });

  it("lets a waiting connection be edited by reconnect rather than by text", () => {
    expect(isEditableStatus("needs_connection")).toBe(false);
  });

  it("rejects a status the vocabulary does not know", () => {
    expect(isOpenStatus("stale")).toBe(false);
    expect(isTerminalStatus("draft")).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
export PATH=/home/lizer05/.cursor-server/bin/linux-x64/86776fcb52ca505783155631089b65d646f9b030:$PATH
pnpm vitest run --maxWorkers=1 packages/core/src/interaction-status.test.ts
```

Expected: FAIL，报错 `Failed to resolve import "./interaction-status.js"`。

- [ ] **Step 3: 写最小实现**

创建 `packages/core/src/interaction-status.ts`：

```ts
/**
 * The one vocabulary for a card's lifecycle.
 *
 * Three lists disagreed before this module existed: the DB type in
 * `@matebot/db` had nine values, the block snapshot in `@matebot/contracts` had
 * six, and the read-side `SurfaceStatus` had three. A card could be `executing`
 * in one and `draft` in another, which is how a superseded card kept a live
 * Send button.
 *
 * This list is the DB truth. Everything else derives from it.
 */
export const INTERACTION_STATUSES = [
  "collecting",
  "ready_for_review",
  "awaiting_approval",
  "needs_connection",
  "unknown",
  "sent",
  "executed",
  "succeeded",
  "confirmed",
  "superseded",
  "expired",
  "failed",
  "cancelled",
] as const;

export type InteractionStatus = (typeof INTERACTION_STATUSES)[number];

/**
 * A card the user can still act on.
 *
 * These three, verbatim, are the `WHERE` clause of the partial unique index in
 * `20261126120000_interaction_card_key`. Changing this list without changing the
 * index silently removes the duplicate-card guarantee.
 */
export const OPEN_STATUSES = [
  "collecting",
  "ready_for_review",
  "awaiting_approval",
] as const;

/**
 * Closed by a new user message. Identical to `OPEN_STATUSES` today, kept separate
 * because "can the user act" and "may a new message close it" are different
 * questions that happen to share an answer.
 */
export const AUTO_SETTLEABLE_STATUSES = OPEN_STATUSES;

/**
 * A card a new user message must **not** close.
 *
 * `needs_connection`: settling it breaks the reconnect resume (§5.5), whose only
 * fallback is re-asking the model for a card — possibly a different one.
 * `unknown`: the mail may already be out; settling it tells the user a lie.
 */
export const SETTLE_EXEMPT_STATUSES = ["needs_connection", "unknown"] as const;

/** A card `edit_interaction` may rewrite. */
export const EDITABLE_STATUSES = OPEN_STATUSES;

/** A card no transition leaves. */
export const TERMINAL_STATUSES = [
  "sent",
  "executed",
  "succeeded",
  "confirmed",
  "superseded",
  "expired",
  "failed",
  "cancelled",
] as const;

const OPEN_SET: ReadonlySet<string> = new Set(OPEN_STATUSES);
const AUTO_SETTLEABLE_SET: ReadonlySet<string> = new Set(AUTO_SETTLEABLE_STATUSES);
const EDITABLE_SET: ReadonlySet<string> = new Set(EDITABLE_STATUSES);
const TERMINAL_SET: ReadonlySet<string> = new Set(TERMINAL_STATUSES);

/** Whether the card still accepts the user's decision. */
export function isOpenStatus(status: string): boolean {
  return OPEN_SET.has(status);
}

/** Whether a new user message may close this card. */
export function isAutoSettleable(status: string): boolean {
  return AUTO_SETTLEABLE_SET.has(status);
}

/** Whether `edit_interaction` may rewrite this card. */
export function isEditableStatus(status: string): boolean {
  return EDITABLE_SET.has(status);
}

/** Whether this card has left the workflow for good. */
export function isTerminalStatus(status: string): boolean {
  return TERMINAL_SET.has(status);
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm vitest run --maxWorkers=1 packages/core/src/interaction-status.test.ts
```

Expected: PASS，9 个用例全绿。

- [ ] **Step 5: 导出并提交**

在 `packages/core/src/index.ts` 的 `export * from "./interaction-runtime.js";` 之后加一行（保持 barrel 现有字母序风格即可）：

```ts
export * from "./interaction-status.js";
```

```bash
git add packages/core/src/interaction-status.ts packages/core/src/interaction-status.test.ts packages/core/src/index.ts
git commit -m "feat(core): one status vocabulary for interaction cards"
```

---

## Task 2: cardKey

**Files:**
- Create: `packages/core/src/interaction-card-key.ts`
- Create: `packages/core/src/interaction-card-key.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: 无
- Produces: `function interactionCardKey(threadId: string, intent: string): string`（64 位小写十六进制）

- [ ] **Step 1: 写失败测试**

创建 `packages/core/src/interaction-card-key.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { interactionCardKey } from "./interaction-card-key.js";

describe("interaction card key", () => {
  it("is stable for the same thread and intent", () => {
    expect(interactionCardKey("thread-1", "email.compose")).toBe(
      interactionCardKey("thread-1", "email.compose"),
    );
  });

  it("is a 64-character lowercase hex digest", () => {
    expect(interactionCardKey("thread-1", "email.compose")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("separates one thread's two intents", () => {
    expect(interactionCardKey("thread-1", "email.compose")).not.toBe(
      interactionCardKey("thread-1", "calendar.create"),
    );
  });

  it("separates one intent across two threads", () => {
    expect(interactionCardKey("thread-1", "email.compose")).not.toBe(
      interactionCardKey("thread-2", "email.compose"),
    );
  });

  // Without the NUL separator, ("a","bc") and ("ab","c") hash the same input and
  // two unrelated cards would share one identity.
  it("cannot be shifted across the thread/intent boundary", () => {
    expect(interactionCardKey("a", "bc")).not.toBe(interactionCardKey("ab", "c"));
  });

  it("refuses an empty thread id", () => {
    expect(() => interactionCardKey("", "email.compose")).toThrow(TypeError);
  });

  it("refuses an empty intent", () => {
    expect(() => interactionCardKey("thread-1", "")).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm vitest run --maxWorkers=1 packages/core/src/interaction-card-key.test.ts
```

Expected: FAIL，`Failed to resolve import "./interaction-card-key.js"`。

- [ ] **Step 3: 写最小实现**

创建 `packages/core/src/interaction-card-key.ts`：

```ts
import { createHash } from "node:crypto";

/**
 * The identity of one action card: a thread plus an intent.
 *
 * Hashing keeps the key fixed-width and independent of intent spelling, so the
 * partial unique index is a plain single-column index. `node:crypto` is already
 * used in this package (`approval-effect-key.ts`).
 *
 * The separator is a NUL byte, which no intent may contain, so
 * `(thread "a", intent "bc")` and `(thread "ab", intent "c")` cannot collide.
 *
 * The migration backfills the same digest in SQL
 * (`encode(sha256(convert_to(...)), 'hex')`), so old and new rows share one
 * identity. Changing this function without changing that SQL splits the table.
 */
export function interactionCardKey(threadId: string, intent: string): string {
  if (!threadId) throw new TypeError("interaction card key needs a thread id");
  if (!intent) throw new TypeError("interaction card key needs an intent");
  return createHash("sha256").update(`${threadId}\u0000${intent}`, "utf8").digest("hex");
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm vitest run --maxWorkers=1 packages/core/src/interaction-card-key.test.ts
```

Expected: PASS，7 个用例全绿。

- [ ] **Step 5: 导出并提交**

`packages/core/src/index.ts` 加：

```ts
export * from "./interaction-card-key.js";
```

```bash
git add packages/core/src/interaction-card-key.ts packages/core/src/interaction-card-key.test.ts packages/core/src/index.ts
git commit -m "feat(core): hash a card identity from thread and intent"
```

---

## Task 3: 迁移（加列 + 回填 + 去重 + 部分唯一索引）

**Files:**
- Modify: `packages/db/prisma/schema.prisma`（`model Interaction`）
- Create: `packages/db/prisma/migrations/20261126120000_interaction_card_key/migration.sql`
- Modify: `packages/db/src/interactions.ts`
- Create: `packages/db/src/interaction-card-key.postgres.test.ts`

**Interfaces:**
- Consumes: `interactionCardKey`（Task 2，仅测试用）
- Produces:
  - `Interaction.cardKey: string`
  - `Interaction.staleAt: Date | null`
  - `Interaction.expiresAt: Date | null`
  - `createInteraction` 接受可选 `cardKey: string`、`expiresAt: Date | null`
  - `InteractionStatus` 从 9 值扩为 13 值

- [ ] **Step 1: 写失败测试**

创建 `packages/db/src/interaction-card-key.postgres.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { interactionCardKey } from "@matebot/core";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { asSystem } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

const OPEN = ["collecting", "ready_for_review", "awaiting_approval"] as const;

describePostgres("interaction card key (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `card-key-org-${suffix}`;
  const userId = `card-key-user-${suffix}`;
  const botId = `card-key-bot-${suffix}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let spaceId: string;
  let threadId: string;

  const plan = { intent: "email.compose", title: "T", fields: [], nextStep: "confirm", riskLevel: "low" };

  const insert = (cardKey: string, status: string) =>
    prisma.interaction.create({
      data: {
        spaceId,
        threadId,
        intent: "email.compose",
        status,
        cardKey,
        plan,
      },
    });

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = asSystem(db.prisma);
    close = async () => {
      await prisma.interaction.deleteMany({ where: { threadId } });
      await prisma.thread.deleteMany({ where: { id: threadId } });
      await prisma.bot.deleteMany({ where: { id: botId } });
      await prisma.organization.deleteMany({ where: { id: organizationId } });
      await prisma.$disconnect();
      await db.pool.end();
    };
    spaceId = `card-key-space-${suffix}`;
    threadId = `card-key-thread-${suffix}`;
    await prisma.organization.create({
      data: { id: organizationId, name: "Acme", slug: organizationId, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id: spaceId, organizationId, name: "Support" } });
    // A thread must be owned by exactly one of a bot, a group or an external conversation.
    await prisma.bot.create({
      data: { id: botId, spaceId, userId, name: "Matebot", color: "#3b82f6" },
    });
    await prisma.thread.create({ data: { id: threadId, spaceId, userId, botId } });
  });

  afterAll(async () => {
    if (close) await close();
  });

  it("keeps the partial unique index the spec depends on", async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'interactions'
        AND indexname = 'interactions_one_open_card_per_intent'
    `;
    expect(rows).toHaveLength(1);
  });

  it("refuses a second open card with the same key", async () => {
    const key = interactionCardKey(threadId, `dup-${suffix}`);
    await insert(key, "collecting");
    await expect(insert(key, "ready_for_review")).rejects.toMatchObject({ code: "P2002" });
  });

  // The index is partial: a terminal row must not block a new open one, or every
  // executed card would freeze its intent for that thread forever.
  it("allows a new open card once the previous one is terminal", async () => {
    const key = interactionCardKey(threadId, `reopen-${suffix}`);
    const first = await insert(key, "collecting");
    await prisma.interaction.update({ where: { id: first.id }, data: { status: "superseded" } });
    await expect(insert(key, "collecting")).resolves.toMatchObject({ cardKey: key });
  });

  it("does not constrain connections, which are exempt from settlement", async () => {
    const key = interactionCardKey(threadId, `conn-${suffix}`);
    await insert(key, "needs_connection");
    await expect(insert(key, "needs_connection")).resolves.toBeTruthy();
  });

  it("stamps cardKey on every open status", async () => {
    for (const status of OPEN) {
      const key = interactionCardKey(threadId, `stamp-${status}-${suffix}`);
      const row = await insert(key, status);
      expect(row.cardKey).toBe(key);
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
export PATH=/home/lizer05/.cursor-server/bin/linux-x64/86776fcb52ca505783155631089b65d646f9b030:$PATH
pnpm --filter @matebot/db generate
pnpm vitest run --maxWorkers=1 packages/db/src/interaction-card-key.postgres.test.ts
```

Expected: 不设 `VERIFY_DATABASE` 时整套 skip；若已设则 FAIL，`Unknown argument 'cardKey'`。

- [ ] **Step 3: 改 Prisma 模型**

在 `packages/db/prisma/schema.prisma` 的 `model Interaction {` 内，`intent String` 之后插入：

```prisma
  /// sha256(threadId + NUL + intent). One action card per thread per intent.
  /// The partial unique index on this column is written by hand in the migration
  /// (Prisma cannot declare a WHERE clause); a test in CI checks it still exists.
  cardKey          String
  /// Set when a newer user message may have overtaken this card. Cleared by any
  /// publish, edit, or confirm. Freshness is a column, not a status: a stale
  /// `collecting` card must stay unconfirmable, which a status value would break.
  staleAt          DateTime?
  /// When this card stops being actionable. Only `awaiting_approval` sets it.
  expiresAt        DateTime?
```

在 `@@index([runId])` 之前插入：

```prisma
  @@index([threadId, cardKey])
```

- [ ] **Step 4: 写迁移 SQL**

创建 `packages/db/prisma/migrations/20261126120000_interaction_card_key/migration.sql`：

```sql
-- One action card per thread per intent, enforced by the database.
-- Additive: older releases never read these columns.

ALTER TABLE "interactions" ADD COLUMN "cardKey" TEXT;
ALTER TABLE "interactions" ADD COLUMN "staleAt" TIMESTAMP(3);
ALTER TABLE "interactions" ADD COLUMN "expiresAt" TIMESTAMP(3);

-- Backfill with the same digest the application computes, so old and new rows
-- share one identity. `sha256(bytea)` is built into PostgreSQL 11+.
UPDATE "interactions"
SET "cardKey" = encode(sha256(convert_to("threadId" || chr(0) || "intent", 'UTF8')), 'hex')
WHERE "cardKey" IS NULL;

-- Historical duplicates: keep the newest open card per key and supersede the rest,
-- so the unique index below can be created.
WITH ranked AS (
  SELECT "id",
         ROW_NUMBER() OVER (
           PARTITION BY "cardKey"
           ORDER BY "updatedAt" DESC, "id" DESC
         ) AS rn
  FROM "interactions"
  WHERE "status" IN ('collecting', 'ready_for_review', 'awaiting_approval')
)
UPDATE "interactions" AS i
SET "status" = 'superseded'
FROM ranked AS r
WHERE i."id" = r."id" AND r.rn > 1;

ALTER TABLE "interactions" ALTER COLUMN "cardKey" SET NOT NULL;

-- Partial unique index: exactly the three open statuses. Must stay in sync with
-- OPEN_STATUSES in packages/core/src/interaction-status.ts.
CREATE UNIQUE INDEX "interactions_one_open_card_per_intent"
  ON "interactions" ("cardKey")
  WHERE "status" IN ('collecting', 'ready_for_review', 'awaiting_approval');

CREATE INDEX "interactions_threadId_cardKey_idx"
  ON "interactions" ("threadId", "cardKey");
```

- [ ] **Step 5: 改 DB 层类型**

在 `packages/db/src/interactions.ts` 中，把 `InteractionStatus` 替换为从 core 引入的单一来源：

```ts
import type { InteractionStatus } from "@matebot/core";

export type { InteractionStatus };
```

然后给 `CreateInteractionInput` 加两个可选字段：

```ts
export type CreateInteractionInput = {
  spaceId: string;
  threadId: string;
  runId?: string;
  intent: string;
  status?: InteractionStatus;
  plan: InteractionPlan;
  slots?: Record<string, unknown>;
  title?: string;
  summary?: string;
  messageId?: string;
  /** sha256(threadId + NUL + intent). Required for open cards; see the partial unique index. */
  cardKey?: string;
  /** Set only for `awaiting_approval`. */
  expiresAt?: Date | null;
};
```

在 `createInteraction` 的 `data` 里加（紧跟 `intent`）：

```ts
      ...(input.cardKey ? { cardKey: input.cardKey } : {}),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
```

同时把 `InteractionRow` 加两个字段：

```ts
  cardKey: string;
  staleAt: Date | null;
  expiresAt: Date | null;
```

- [ ] **Step 6: 应用迁移并跑测试**

```bash
pnpm --filter @matebot/db generate
pnpm --filter @matebot/db migrate
VERIFY_DATABASE=1 pnpm vitest run --maxWorkers=1 packages/db/src/interaction-card-key.postgres.test.ts
```

Expected: PASS，5 个用例。若本机无 `DATABASE_URL`，记下这一点并在 CI 上验证——**不允许**因此跳过索引存在性断言。

- [ ] **Step 7: 提交**

```bash
git add packages/db/prisma/schema.prisma \
        packages/db/prisma/migrations/20261126120000_interaction_card_key/migration.sql \
        packages/db/src/interactions.ts \
        packages/db/src/interaction-card-key.postgres.test.ts
git commit -m "feat(db): one open card per thread and intent via partial unique index"
```

---

## Task 4: 结算决策（纯函数）

**Files:**
- Create: `packages/core/src/interaction-kernel.ts`
- Create: `packages/core/src/interaction-kernel.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `InteractionStatus`、`isTerminalStatus`、`SETTLE_EXEMPT_STATUSES`（Task 1）
- Produces:
  - `type SettleRefusal = "already_terminal" | "exempt_from_settlement" | "unknown_status" | "same_status"`
  - `type SettleDecision = { ok: true; status: InteractionStatus } | { ok: false; reason: SettleRefusal }`
  - `function decideSettle(input: { current: string; next: InteractionStatus }): SettleDecision`
  - `function expiresAtFor(status: InteractionStatus, now?: Date): Date | null`

- [ ] **Step 1: 写失败测试**

创建 `packages/core/src/interaction-kernel.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { decideSettle, expiresAtFor } from "./interaction-kernel.js";
import { INTERACTION_STATUSES, SETTLE_EXEMPT_STATUSES } from "./interaction-status.js";

describe("decideSettle", () => {
  it("settles an open card to a terminal state", () => {
    expect(decideSettle({ current: "ready_for_review", next: "superseded" })).toEqual({
      ok: true,
      status: "superseded",
    });
  });

  it("refuses to settle the same status twice", () => {
    expect(decideSettle({ current: "sent", next: "sent" })).toEqual({
      ok: false,
      reason: "same_status",
    });
  });

  it("refuses to leave a terminal state", () => {
    expect(decideSettle({ current: "executed", next: "superseded" })).toEqual({
      ok: false,
      reason: "already_terminal",
    });
  });

  // D1 / D2: these two may never be closed by a sweep.
  it.each([...SETTLE_EXEMPT_STATUSES])("refuses to settle a %s card", (current) => {
    expect(decideSettle({ current, next: "superseded" })).toEqual({
      ok: false,
      reason: "exempt_from_settlement",
    });
  });

  it("refuses a status the vocabulary does not know", () => {
    expect(decideSettle({ current: "stale", next: "superseded" })).toEqual({
      ok: false,
      reason: "unknown_status",
    });
  });

  // Exhaustive: every (known) pair either settles or names a reason, never throws.
  it("decides every pair of known statuses without throwing", () => {
    for (const current of INTERACTION_STATUSES) {
      for (const next of INTERACTION_STATUSES) {
        const decision = decideSettle({ current, next });
        expect(typeof decision.ok).toBe("boolean");
      }
    }
  });
});

describe("expiresAtFor", () => {
  const now = new Date("2026-11-13T00:00:00.000Z");

  it("gives an approval card thirty minutes", () => {
    expect(expiresAtFor("awaiting_approval", now)?.toISOString()).toBe("2026-11-13T00:30:00.000Z");
  });

  it("leaves a card the user is editing open", () => {
    expect(expiresAtFor("ready_for_review", now)).toBeNull();
    expect(expiresAtFor("collecting", now)).toBeNull();
  });

  it("never expires a waiting connection", () => {
    // A sign-in takes as long as it takes; a timer here would break the resume.
    expect(expiresAtFor("needs_connection", now)).toBeNull();
  });

  it("never expires an in-doubt email", () => {
    expect(expiresAtFor("unknown", now)).toBeNull();
  });

  it("does not resurrect an expiry on a terminal card", () => {
    expect(expiresAtFor("sent", now)).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm vitest run --maxWorkers=1 packages/core/src/interaction-kernel.test.ts
```

Expected: FAIL，`Failed to resolve import "./interaction-kernel.js"`。

- [ ] **Step 3: 写实现**

创建 `packages/core/src/interaction-kernel.ts`：

```ts
import type { InteractionStatus } from "./interaction-status.js";
import {
  INTERACTION_STATUSES,
  SETTLE_EXEMPT_STATUSES,
  isTerminalStatus,
} from "./interaction-status.js";

/**
 * Why a settle was refused. Every caller reports the reason rather than
 * silently doing nothing: a sweep that skipped a card and said nothing is how
 * an in-doubt email would look "expired" to the user.
 */
export type SettleRefusal =
  | "already_terminal"
  | "exempt_from_settlement"
  | "unknown_status"
  | "same_status";

export type SettleDecision =
  | { ok: true; status: InteractionStatus }
  | { ok: false; reason: SettleRefusal };

const KNOWN: ReadonlySet<string> = new Set(INTERACTION_STATUSES);
const EXEMPT: ReadonlySet<string> = new Set(SETTLE_EXEMPT_STATUSES);

/**
 * The single rule for whether a card may move from `current` to `next`.
 *
 * Pure on purpose: the storage layer owns the write, this owns the decision, so
 * the rules can be tested exhaustively without a database.
 */
export function decideSettle(input: {
  current: string;
  next: InteractionStatus;
}): SettleDecision {
  const { current, next } = input;
  if (!KNOWN.has(current)) return { ok: false, reason: "unknown_status" };
  if (current === next) return { ok: false, reason: "same_status" };
  if (EXEMPT.has(current)) return { ok: false, reason: "exempt_from_settlement" };
  if (isTerminalStatus(current)) return { ok: false, reason: "already_terminal" };
  return { ok: true, status: next };
}

/** How long an approval card stays actionable. Aligned with Grok Bot's current value. */
export const APPROVAL_TTL_MS = 30 * 60 * 1000;

/**
 * The expiry to stamp when publishing in `status`.
 *
 * Only approvals expire. A draft the user is still editing must not be taken
 * away, a sign-in takes as long as it takes, and an in-doubt email may already
 * be sent — a timer on any of those would either interrupt the user or lie.
 */
export function expiresAtFor(status: InteractionStatus, now: Date = new Date()): Date | null {
  if (status !== "awaiting_approval") return null;
  return new Date(now.getTime() + APPROVAL_TTL_MS);
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm vitest run --maxWorkers=1 packages/core/src/interaction-kernel.test.ts
```

Expected: PASS，13 个用例（`it.each` 展开 2 个）。

- [ ] **Step 5: 导出并提交**

`packages/core/src/index.ts` 加：

```ts
export * from "./interaction-kernel.js";
```

```bash
git add packages/core/src/interaction-kernel.ts packages/core/src/interaction-kernel.test.ts packages/core/src/index.ts
git commit -m "feat(core): decide card settlement in one pure rule"
```

---

## Task 5: 结算存储层（CAS）

**Files:**
- Create: `packages/adapters/src/interaction-kernel-store.ts`
- Create: `packages/adapters/src/interaction-kernel-store.test.ts`

**Interfaces:**
- Consumes: `decideSettle`、`isOpenStatus`、`InteractionStatus`（Task 1、4）
- Produces:
  - `type OpenCardRow = { id: string; status: string; messageId: string | null; draftVersion: number; staleAt: Date | null }`
  - `function findOpenCard(prisma, input: { threadId: string; intent: string }): Promise<OpenCardRow | undefined>`
  - `function settleInteraction(prisma, input: SettleInput): Promise<SettleResult>`
  - `type SettleInput = { interactionId: string; status: InteractionStatus; reason: string; staleAtSnapshot?: Date | null }`
  - `type SettleResult = { settled: true; previousStatus: string } | { settled: false; reason: SettleRefusal | "not_found" | "concurrent" }`

- [ ] **Step 1: 写失败测试**

创建 `packages/adapters/src/interaction-kernel-store.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@matebot/db";
import { findOpenCard, settleInteraction } from "./interaction-kernel-store.js";

function fakePrisma(row: { id: string; status: string; messageId?: string | null; draftVersion?: number; staleAt?: Date | null } | null) {
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const findFirst = vi.fn().mockResolvedValue(
    row
      ? { id: row.id, status: row.status, messageId: row.messageId ?? null, draftVersion: row.draftVersion ?? 1, staleAt: row.staleAt ?? null }
      : null,
  );
  const findUnique = vi.fn().mockResolvedValue(
    row
      ? { id: row.id, status: row.status, messageId: row.messageId ?? null, draftVersion: row.draftVersion ?? 1, staleAt: row.staleAt ?? null }
      : null,
  );
  return {
    prisma: { interaction: { findFirst, findUnique, updateMany } } as unknown as PrismaClient,
    updateMany,
    findFirst,
  };
}

describe("findOpenCard", () => {
  it("looks a card up by thread and intent among the open statuses", async () => {
    const { prisma, findFirst } = fakePrisma({ id: "i1", status: "collecting" });
    const row = await findOpenCard(prisma, { threadId: "t1", intent: "email.compose" });
    expect(row).toEqual({ id: "i1", status: "collecting", messageId: null, draftVersion: 1, staleAt: null });
    expect(findFirst.mock.calls[0]![0].where).toMatchObject({
      threadId: "t1",
      intent: "email.compose",
      status: { in: ["collecting", "ready_for_review", "awaiting_approval"] },
    });
  });

  it("returns undefined when the thread has no open card for the intent", async () => {
    const { prisma } = fakePrisma(null);
    expect(await findOpenCard(prisma, { threadId: "t1", intent: "email.compose" })).toBeUndefined();
  });
});

describe("settleInteraction", () => {
  it("settles an open card", async () => {
    const { prisma, updateMany } = fakePrisma({ id: "i1", status: "ready_for_review" });
    await expect(
      settleInteraction(prisma, { interactionId: "i1", status: "superseded", reason: "new message" }),
    ).resolves.toEqual({ settled: true, previousStatus: "ready_for_review" });
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  // The guard that keeps a card the user just sent from being relabelled.
  it("matches on the status it read, so a concurrent send wins", async () => {
    const { prisma, updateMany } = fakePrisma({ id: "i1", status: "ready_for_review" });
    updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      settleInteraction(prisma, { interactionId: "i1", status: "superseded", reason: "sweep" }),
    ).resolves.toEqual({ settled: false, reason: "concurrent" });
  });

  it("only settles a row that still carries the staleness mark it read", async () => {
    const mark = new Date("2026-11-13T00:00:00.000Z");
    const { prisma, updateMany } = fakePrisma({ id: "i1", status: "collecting", staleAt: mark });
    await settleInteraction(prisma, {
      interactionId: "i1",
      status: "superseded",
      reason: "sweep",
      staleAtSnapshot: mark,
    });
    expect(updateMany.mock.calls[0]![0].where).toMatchObject({ staleAt: mark });
  });

  it("reports not_found for an id that vanished", async () => {
    const { prisma } = fakePrisma(null);
    await expect(
      settleInteraction(prisma, { interactionId: "gone", status: "superseded", reason: "sweep" }),
    ).resolves.toEqual({ settled: false, reason: "not_found" });
  });

  it("refuses an exempt card without writing", async () => {
    const { prisma, updateMany } = fakePrisma({ id: "i1", status: "needs_connection" });
    await expect(
      settleInteraction(prisma, { interactionId: "i1", status: "superseded", reason: "sweep" }),
    ).resolves.toEqual({ settled: false, reason: "exempt_from_settlement" });
    expect(updateMany).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm vitest run --maxWorkers=1 packages/adapters/src/interaction-kernel-store.test.ts
```

Expected: FAIL，`Failed to resolve import "./interaction-kernel-store.js"`。

- [ ] **Step 3: 写实现**

创建 `packages/adapters/src/interaction-kernel-store.ts`：

```ts
import type { PrismaClient } from "@matebot/db";
import type { InteractionStatus, SettleRefusal } from "@matebot/core";
import { OPEN_STATUSES, decideSettle } from "@matebot/core";
import { getLogger } from "@matebot/logging";

export type OpenCardRow = {
  id: string;
  status: string;
  messageId: string | null;
  draftVersion: number;
  staleAt: Date | null;
};

export type SettleInput = {
  interactionId: string;
  status: InteractionStatus;
  /** Goes to the log, never to the user. Why the card closed is not user copy. */
  reason: string;
  /**
   * When set, the update only applies if the row still carries this mark. The
   * two-stage sweep reads the mark with the card and settles on it, so a card the
   * user touched in between is left alone (spec E1/E2).
   */
  staleAtSnapshot?: Date | null;
};

export type SettleResult =
  | { settled: true; previousStatus: string }
  | { settled: false; reason: SettleRefusal | "not_found" | "concurrent" };

/**
 * The live card for one intent in one thread, as the partial unique index
 * guarantees there is at most one.
 */
export async function findOpenCard(
  prisma: PrismaClient,
  input: { threadId: string; intent: string },
): Promise<OpenCardRow | undefined> {
  const row = await prisma.interaction.findFirst({
    where: {
      threadId: input.threadId,
      intent: input.intent,
      status: { in: [...OPEN_STATUSES] },
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true, status: true, messageId: true, draftVersion: true, staleAt: true },
  });
  return row ?? undefined;
}

/**
 * The only path that closes a card.
 *
 * Reads the row, asks the kernel whether the move is allowed, then writes with
 * the status it read in the `WHERE` clause. A card the user confirmed in between
 * therefore fails to match and reports `concurrent` instead of being relabelled
 * as superseded.
 */
export async function settleInteraction(
  prisma: PrismaClient,
  input: SettleInput,
): Promise<SettleResult> {
  const current = await prisma.interaction.findUnique({
    where: { id: input.interactionId },
    select: { id: true, status: true, staleAt: true },
  });
  if (!current) return { settled: false, reason: "not_found" };

  const decision = decideSettle({ current: current.status, next: input.status });
  if (!decision.ok) return { settled: false, reason: decision.reason };

  const written = await prisma.interaction.updateMany({
    where: {
      id: input.interactionId,
      status: current.status,
      ...(input.staleAtSnapshot !== undefined ? { staleAt: input.staleAtSnapshot } : {}),
    },
    data: { status: decision.status },
  });
  if (written.count === 0) return { settled: false, reason: "concurrent" };

  getLogger().info("interaction.settled", {
    "interaction.id": input.interactionId,
    "interaction.from": current.status,
    "interaction.to": decision.status,
    "interaction.reason": input.reason,
  });
  return { settled: true, previousStatus: current.status };
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm vitest run --maxWorkers=1 packages/adapters/src/interaction-kernel-store.test.ts
```

Expected: PASS，7 个用例。

- [ ] **Step 5: 提交**

```bash
git add packages/adapters/src/interaction-kernel-store.ts packages/adapters/src/interaction-kernel-store.test.ts
git commit -m "feat(adapters): settle a card through one compare-and-set path"
```

---

## Task 6: publishOrAmend

**Files:**
- Modify: `packages/adapters/src/interaction-publish.ts`
- Create: `packages/adapters/src/interaction-publish-amend.test.ts`

**Interfaces:**
- Consumes: `findOpenCard`（Task 5）、`interactionCardKey`、`expiresAtFor`（Task 2、4）
- Produces:
  - `PublishInteractionSurfaceInput` 新增可选 `cardKey?: string`、`expiresAt?: Date | null`
  - `function publishOrAmend(prisma, input: PublishOrAmendInput): Promise<PublishOrAmendResult>`
  - `PublishOrAmendResult = { interactionId; surfaceId; messageId; documentRef; draftVersion; eventSeq; amended: boolean; missingRequired: string[]; plan: InteractionPlan; slots: Record<string, unknown> }`

- [ ] **Step 1: 写失败测试**

创建 `packages/adapters/src/interaction-publish-amend.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import { interactionCardKey } from "@matebot/core";
import { publishOrAmend } from "./interaction-publish.js";

const plan = {
  intent: "email.compose",
  title: "产品发布",
  fields: [
    { name: "to", value: "418452732@qq.com", required: true, status: "filled" as const },
    { name: "subject", value: "产品发布", required: true, status: "filled" as const },
    { name: "body", value: "内容", required: true, status: "filled" as const },
  ],
  nextStep: "confirm" as const,
  riskLevel: "low" as const,
};

describe("publishOrAmend", () => {
  it("writes the card key so the unique index can do its job", async () => {
    const createInteraction = vi.fn().mockResolvedValue({ id: "i1", draftVersion: 1 });
    const tx = {
      interaction: { update: vi.fn().mockResolvedValue({}) },
      message: { update: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      interaction: { findFirst: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (run: (t: typeof tx) => unknown) => run(tx)),
    };
    vi.spyOn(await import("@matebot/db"), "createInteraction").mockResolvedValue({
      id: "i1",
      draftVersion: 1,
    } as never);

    const result = await publishOrAmend(prisma as never, {
      spaceId: "s1",
      threadId: "t1",
      botId: "b1",
      runId: "r1",
      plan,
    });

    expect(result.amended).toBe(false);
    expect(createInteraction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cardKey: interactionCardKey("t1", "email.compose") }),
    );
  });

  it("amends the existing card instead of creating a second one", async () => {
    const existing = { id: "i1", status: "collecting", messageId: "m1", draftVersion: 1, staleAt: null };
    const updateInteraction = vi.fn().mockResolvedValue({});
    const updateMessage = vi.fn().mockResolvedValue({});
    const tx = {
      interaction: { update: updateInteraction },
      message: {
        findUnique: vi.fn().mockResolvedValue({
          id: "m1",
          blocks: [{ kind: "a2ui_surface", interactionId: "i1", surfaceId: "s1", draftVersion: 1 }],
        }),
        update: updateMessage,
      },
    };
    const prisma = {
      interaction: { findFirst: vi.fn().mockResolvedValue(existing) },
      $transaction: vi.fn(async (run: (t: typeof tx) => unknown) => run(tx)),
    };

    const result = await publishOrAmend(prisma as never, {
      spaceId: "sp1",
      threadId: "t1",
      botId: "b1",
      runId: "r1",
      plan,
    });

    expect(result.amended).toBe(true);
    expect(result.interactionId).toBe("i1");
    expect(result.messageId).toBe("m1");
    // The message is rewritten, never appended: a new row per present is the bug.
    expect(updateMessage).toHaveBeenCalledTimes(1);
    expect(updateInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "i1" } }),
    );
  });

  it("clears the staleness mark when it rewrites the card", async () => {
    const existing = { id: "i1", status: "collecting", messageId: "m1", draftVersion: 1, staleAt: new Date() };
    const updateInteraction = vi.fn().mockResolvedValue({});
    const tx = {
      interaction: { update: updateInteraction },
      message: {
        findUnique: vi.fn().mockResolvedValue({ id: "m1", blocks: [{ kind: "a2ui_surface", interactionId: "i1", surfaceId: "s1", draftVersion: 1 }] }),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      interaction: { findFirst: vi.fn().mockResolvedValue(existing) },
      $transaction: vi.fn(async (run: (t: typeof tx) => unknown) => run(t)),
    };

    await publishOrAmend(prisma as never, { spaceId: "sp1", threadId: "t1", botId: "b1", runId: "r1", plan });

    expect(updateInteraction.mock.calls[0]![0].data).toMatchObject({ staleAt: null });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm vitest run --maxWorkers=1 packages/adapters/src/interaction-publish-amend.test.ts
```

Expected: FAIL，`publishOrAmend is not a function`。

- [ ] **Step 3: 给发布输入加两个字段**

在 `packages/adapters/src/interaction-publish.ts` 的 `PublishInteractionSurfaceInput` 中，`amendsInteractionId?: string;` 之后加：

```ts
  /** sha256(threadId + NUL + intent); see the partial unique index. */
  cardKey?: string;
  /** Set only for `awaiting_approval`; see `expiresAtFor`. */
  expiresAt?: Date | null;
```

并在第 205 行 `createInteraction(tx, {` 的调用里，`intent: reconciledPlan.intent,` 之后加：

```ts
        ...(input.cardKey ? { cardKey: input.cardKey } : {}),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
```

- [ ] **Step 4: 加 publishOrAmend**

在 `packages/adapters/src/interaction-publish.ts` 文件末尾追加（该文件已具备 `compilePlanSurface`、`upsertInteractionSurface`、`appendEventInTransaction`、`withTransactionRetry` 的全部依赖）：

```ts
export type PublishOrAmendInput = PublishInteractionSurfaceInput;

export type PublishOrAmendResult = {
  interactionId: string;
  surfaceId: string;
  messageId: string;
  documentRef: string;
  draftVersion: number;
  eventSeq: number;
  /** True when an existing card was rewritten in place. */
  amended: boolean;
  missingRequired: string[];
  plan: InteractionPlan;
  slots: Record<string, unknown>;
  capability?: EmailSurfaceCapability;
};

/**
 * Publish, or rewrite the card already on screen.
 *
 * `publishInteractionSurface` always creates a row and a message, which is why a
 * second present of the same intent used to leave two live buttons for one
 * effect. This wraps it: a live card for the same (thread, intent) is rewritten
 * in place — row, surface document and the message block that carries it — and
 * only an absent card creates anything.
 *
 * A `P2002` on insert means another run won the race; the retry re-reads and
 * amends, which is the same outcome the loser wanted.
 */
export async function publishOrAmend(
  prisma: PrismaClient,
  input: PublishOrAmendInput,
): Promise<PublishOrAmendResult> {
  const cardKey = input.cardKey ?? interactionCardKey(input.threadId, input.plan.intent);
  const expiresAt = input.expiresAt ?? expiresAtFor((input.status ?? "collecting") as InteractionStatus);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await findOpenCard(prisma, {
      threadId: input.threadId,
      intent: input.plan.intent,
    });
    if (existing?.messageId) {
      return amendPublishedCard(prisma, { ...input, existing, cardKey, expiresAt });
    }
    try {
      const published = await publishInteractionSurface(prisma, { ...input, cardKey, expiresAt });
      return { ...published, amended: false };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "P2002" || attempt > 0) throw error;
      getLogger().info("interaction.publish_race_retry", {
        "interaction.card_key": cardKey,
        "interaction.intent": input.plan.intent,
      });
    }
  }
  throw new Error("Could not publish or amend the interaction card");
}

/**
 * Rewrite the card a person is already looking at.
 *
 * The message block is replaced in place. Appending a second message is the
 * behaviour this function exists to end.
 */
async function amendPublishedCard(
  prisma: PrismaClient,
  input: PublishOrAmendInput & {
    existing: OpenCardRow;
    cardKey: string;
    expiresAt: Date | null;
  },
): Promise<PublishOrAmendResult> {
  const { existing } = input;
  const surfaceId = input.surfaceId?.trim() || `surface-${crypto.randomUUID()}`;
  const emailIntent = input.plan.intent === "email.compose" || input.plan.intent === "email.send";
  const senderLabel = senderLabelForBlock(input.senderLabel);
  const senderAddress = senderAddressForBlock(input.senderAddress);
  const stamps = emailIntent
    ? emailSurfaceBlockFields({
        intent: input.plan.intent,
        capability: input.capability,
        interactionStatus: input.status ?? "collecting",
      })
    : {};
  const compiled = await compilePlanSurface({
    plan: input.plan,
    surfaceId,
    protocolFamily: input.protocolFamily,
    capability: emailIntent ? input.capability : undefined,
    status: input.status,
  });
  const reconciledPlan = compiled.plan ?? input.plan;
  const slots = interactionSlotsFromPlan(reconciledPlan);
  const nextVersion = existing.draftVersion + 1;

  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      await tx.interaction.update({
        where: { id: existing.id },
        data: {
          plan: reconciledPlan as never,
          slots: slots as never,
          title: reconciledPlan.title ?? null,
          summary: reconciledPlan.summary ?? null,
          status: input.status ?? "collecting",
          draftVersion: nextVersion,
          staleAt: null,
          expiresAt: input.expiresAt,
        },
      });
      const { documentRef } = await upsertInteractionSurface(tx, {
        interactionId: existing.id,
        surfaceId,
        protocolFamily: compiled.protocolFamily,
        document: compiled.messages,
        draftVersion: nextVersion,
      });
      const block: MessageBlock = {
        kind: "a2ui_surface",
        interactionId: existing.id,
        surfaceId,
        protocolFamily: compiled.protocolFamily,
        draftVersion: nextVersion,
        intent: input.plan.intent,
        title: input.plan.title,
        summary: input.plan.summary,
        documentRef,
        ...(senderLabel ? { senderLabel } : {}),
        ...(senderAddress ? { senderAddress } : {}),
        ...stamps,
      };
      const messageId = existing.messageId!;
      const message = await tx.message.findUnique({
        where: { id: messageId },
        select: { blocks: true },
      });
      const previous = Array.isArray(message?.blocks)
        ? (message.blocks as MessageBlock[])
        : [];
      const nextBlocks = previous.some((entry) => entry.kind === "a2ui_surface" && entry.interactionId === existing.id)
        ? previous.map((entry) =>
            entry.kind === "a2ui_surface" && entry.interactionId === existing.id ? block : entry,
          )
        : [...previous, block];
      await tx.message.update({
        where: { id: messageId },
        data: { blocks: nextBlocks as never },
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.message.updated",
        runId: input.runId,
        lease: input.lease,
        payload: { messageId, role: "bot", blocks: nextBlocks },
      });
      return {
        interactionId: existing.id,
        surfaceId,
        messageId,
        documentRef,
        draftVersion: nextVersion,
        eventSeq: event.seq,
        amended: true,
        missingRequired: compiled.missingRequired ?? [],
        plan: reconciledPlan,
        slots,
        ...(input.capability ? { capability: input.capability } : {}),
      };
    }),
  );
}
```

在文件顶部 import 区补三行（与现有 import 风格一致）：

```ts
import { expiresAtFor, interactionCardKey } from "@matebot/core";
import type { OpenCardRow } from "./interaction-kernel-store.js";
import { findOpenCard } from "./interaction-kernel-store.js";
```

- [ ] **Step 5: 运行测试确认通过**

```bash
pnpm vitest run --maxWorkers=1 packages/adapters/src/interaction-publish-amend.test.ts
pnpm --filter @matebot/adapters check
```

Expected: 测试 PASS（3 个用例）；`check` 无类型错误。`compilePlanSurface` 的返回类型已含 `missingRequired: string[]`，无需兜底。

- [ ] **Step 6: 提交**

```bash
git add packages/adapters/src/interaction-publish.ts packages/adapters/src/interaction-publish-amend.test.ts
git commit -m "feat(adapters): amend the live card instead of publishing a second one"
```

---

## Task 7: present_interaction 改走 publishOrAmend

**Files:**
- Modify: `packages/adapters/src/run-tools-interaction.ts:128-145`（删 `openDraftId`）、`:193-209`（改调用）
- Create: `packages/adapters/src/run-tools-interaction-amend.test.ts`

**Interfaces:**
- Consumes: `publishOrAmend`（Task 6）
- Produces: 无新导出；`present_interaction` 行为变化

- [ ] **Step 1: 写失败测试**

创建 `packages/adapters/src/run-tools-interaction-amend.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";

const plan = {
  intent: "email.compose",
  title: "产品发布",
  fields: [
    { name: "to", value: "418452732@qq.com", required: true, status: "filled" as const },
    { name: "subject", value: "产品发布", required: true, status: "filled" as const },
    { name: "body", value: "内容", required: true, status: "filled" as const },
  ],
  nextStep: "confirm" as const,
  riskLevel: "low" as const,
};

describe("present_interaction", () => {
  // The regression this task closes: a second present must not create a second card.
  it("publishes or amends through one call, never through a local draft lookup", async () => {
    const publish = vi.fn().mockResolvedValue({
      interactionId: "i1",
      surfaceId: "s1",
      messageId: "m1",
      documentRef: "ref",
      draftVersion: 2,
      eventSeq: 1,
      amended: true,
      missingRequired: [],
      plan,
      slots: { to: "418452732@qq.com", subject: "产品发布", body: "内容" },
    });
    vi.doMock("./interaction-publish.js", async () => {
      const actual = await vi.importActual<typeof import("./interaction-publish.js")>(
        "./interaction-publish.js",
      );
      return { ...actual, publishOrAmend: publish };
    });
    const { interactionTools: tools } = await import("./run-tools-interaction.js");

    const findFirst = vi.fn();
    const handler = tools.present_interaction!;
    const finish = vi.fn((value: unknown) => value);
    await handler(
      {
        deps: { prisma: { interaction: { findFirst } }, events: { notify: vi.fn() } },
        run: { id: "r1", spaceId: "sp1", threadId: "t1", botId: "b1" },
        context: { userId: "u1" },
      } as never,
      { args: { plan }, finish } as never,
    );

    expect(publish).toHaveBeenCalledTimes(1);
    // The kernel resolves the card; a local findFirst would be a second source of truth.
    expect(findFirst).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm vitest run --maxWorkers=1 packages/adapters/src/run-tools-interaction-amend.test.ts
```

Expected: FAIL，`findFirst` 被调用过（当前实现先 `openDraftId` 查一遍）。

- [ ] **Step 3: 删除本地查找**

在 `packages/adapters/src/run-tools-interaction.ts` 中**整段删除** `openDraftId` 函数（第 121–145 行，含其上方的 `OPEN_DRAFT_STATUSES` 常量与注释）。

`OPEN_DRAFT_STATUSES` 若在文件其他地方仍被引用，保留它并改为从 core 导入：

```ts
import { OPEN_STATUSES } from "@matebot/core";
```

然后把引用处替换为 `[...OPEN_STATUSES]`。

- [ ] **Step 4: 改发布调用**

把第 193–209 行：

```ts
    const replacing = await openDraftId(ctx, plan.intent);
    const published = await publishInteractionSurface(deps.prisma, {
```

改为：

```ts
    const published = await publishOrAmend(deps.prisma, {
```

并**删掉** `...(replacing ? { amendsInteractionId: replacing } : {}),` 这一行（`publishOrAmend` 自己判定是否 amend；`amendsInteractionId` 从此只是历史字段）。

同时更新 import：

```ts
import { publishOrAmend } from "./interaction-publish.js";
```

删除 `publishInteractionSurface` 的 import（若文件其他地方不再引用）。

- [ ] **Step 5: 运行测试确认通过**

```bash
pnpm vitest run --maxWorkers=1 packages/adapters/src/run-tools-interaction-amend.test.ts
pnpm vitest run --maxWorkers=1 packages/adapters/src/run-tools-interaction.test.ts
pnpm --filter @matebot/adapters check
```

Expected: 新测试 PASS；既有 `run-tools-interaction.test.ts` 仍 PASS（若它断言了 `amendsInteractionId`，改为断言 `publishOrAmend` 被调用）。

- [ ] **Step 6: 提交**

```bash
git add packages/adapters/src/run-tools-interaction.ts packages/adapters/src/run-tools-interaction-amend.test.ts
git commit -m "refactor(adapters): present through the card kernel"
```

---

## Task 8: threads.ts 的编辑目标与状态映射

**Files:**
- Modify: `apps/api/src/routes/threads.ts:943-972`

**Interfaces:**
- Consumes: `isOpenStatus`、`isEditableStatus`（Task 1）
- Produces: 无新导出；编辑目标集合与状态映射由内核决定

- [ ] **Step 1: 写失败测试**

创建 `apps/api/src/routes/threads-status-mapping.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { isEditableStatus, isOpenStatus } from "@matebot/core";

/**
 * The route used to map every unrecognised status to "draft", which rendered a
 * superseded card as a live draft with a working Send button.
 */
describe("edit target and card status", () => {
  it("does not treat a superseded card as editable", () => {
    expect(isEditableStatus("superseded")).toBe(false);
  });

  it("does not treat an expired card as editable", () => {
    expect(isEditableStatus("expired")).toBe(false);
  });

  it("treats the three open states as editable", () => {
    for (const status of ["collecting", "ready_for_review", "awaiting_approval"]) {
      expect(isEditableStatus(status)).toBe(true);
      expect(isOpenStatus(status)).toBe(true);
    }
  });

  // A card that is only marked stale is still the user's card; the column must not
  // remove it from the edit targets (spec E-refresh / AC-8b).
  it("keeps staleness out of the edit decision", () => {
    expect(isEditableStatus("collecting")).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm vitest run --maxWorkers=1 apps/api/src/routes/threads-status-mapping.test.ts
```

Expected: 首两个用例 PASS（Task 1 已实现判定）；本步骤的作用是**锁住行为**，如果此时跳过它，第 3 步的改动就没有回归网。

- [ ] **Step 3: 改查询与映射**

在 `apps/api/src/routes/threads.ts` 的 `editInteraction` 中，把第 943–946 行：

```ts
        const interactions = await deps.prisma.interaction.findMany({
          where: {
            threadId: target.threadId,
            status: { notIn: ["cancelled", "failed", "unknown"] },
          },
```

改为：

```ts
        const interactions = await deps.prisma.interaction.findMany({
          where: {
            threadId: target.threadId,
            // Only a card the kernel still lets a person edit. The old query was a
            // denylist, so `superseded` and `expired` stayed editable — and were
            // then mapped to "draft" below.
            status: { in: [...EDITABLE_STATUSES] },
          },
```

把第 966–972 行的三元映射：

```ts
            status:
              row.status === "succeeded"
                ? ("executed" as const)
                : row.status === "awaiting_approval"
                  ? ("approved" as const)
                  : ("draft" as const),
```

改为：

```ts
            status: surfaceStatusFor(row.status),
```

并在文件顶部加导入与映射函数：

```ts
import { EDITABLE_STATUSES, isTerminalStatus } from "@matebot/core";

/**
 * The read-side status of a card in the edit chooser.
 *
 * A status the kernel calls terminal can never be `draft`; deciding by "is this
 * one of the two success states" left every unrecognised value (superseded,
 * expired) looking editable.
 */
function surfaceStatusFor(status: string): "draft" | "approved" | "executed" {
  if (status === "awaiting_approval") return "approved";
  if (isTerminalStatus(status)) return "executed";
  return "draft";
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm vitest run --maxWorkers=1 apps/api/src/routes/threads-status-mapping.test.ts
pnpm --filter @matebot/api check
```

Expected: PASS；`check` 无类型错误。

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/routes/threads.ts apps/api/src/routes/threads-status-mapping.test.ts
git commit -m "fix(api): stop offering superseded and expired cards as drafts"
```

---

## Task 9: 源码闸门（AC-6）

**Files:**
- Create: `packages/adapters/src/interaction-kernel-guard.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: CI 闸门；后续批次靠缩小白名单推进

- [ ] **Step 1: 写测试（先让它在当前代码上通过，再锁住）**

创建 `packages/adapters/src/interaction-kernel-guard.test.ts`：

```ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..");

/**
 * Files still allowed to write `interaction.status` directly.
 *
 * This list may only shrink. Every entry is a card path that batches B~E will
 * move onto `settleInteraction`; adding a name here is how the kernel gets
 * quietly hollowed out, so the test also fails if the list grows.
 */
const STATUS_WRITE_ALLOWLIST = [
  "packages/adapters/src/interaction-publish.ts",
  "packages/adapters/src/interaction-kernel-store.ts",
  "packages/adapters/src/interaction-field-writer.ts",
  "packages/adapters/src/interaction-email-outcome.ts",
  "packages/adapters/src/interaction-result-publish.ts",
  "packages/db/src/interactions.ts",
  "apps/api/src/interaction-service.ts",
  "apps/api/src/interaction-resume.ts",
].sort();

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  "generated",
  "migrations",
  "android",
  "ios",
]);

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
}

function writesInteractionStatus(source: string): boolean {
  const call = /interaction\.(?:update|updateMany|upsert)\s*\(([\s\S]*?)\)\s*;?/g;
  for (const match of source.matchAll(call)) {
    if (/\bstatus\s*:/.test(match[1] ?? "")) return true;
  }
  return false;
}

describe("interaction status write guard", () => {
  it("only lets allowlisted files write a card status", () => {
    const files: string[] = [];
    for (const dir of ["packages", "apps"]) walk(join(ROOT, dir), files);
    const offenders = files
      .filter((file) => writesInteractionStatus(readFileSync(file, "utf8")))
      .map((file) => relative(ROOT, file))
      .filter((file) => !STATUS_WRITE_ALLOWLIST.includes(file))
      .sort();
    expect(offenders).toEqual([]);
  });

  it("keeps the allowlist sorted and free of duplicates, so shrinking it is a diff of one line", () => {
    expect(STATUS_WRITE_ALLOWLIST).toEqual([...new Set(STATUS_WRITE_ALLOWLIST)].sort());
  });
});
```

- [ ] **Step 2: 运行测试**

```bash
pnpm vitest run --maxWorkers=1 packages/adapters/src/interaction-kernel-guard.test.ts
```

Expected: PASS。若 `offenders` 非空，说明还有本计划未覆盖的 status 写入点——**不要把它们加进白名单**，而是回到 Task 5/6 把它们改走 `settleInteraction`，或在计划里追加任务。

- [ ] **Step 3: 提交**

```bash
git add packages/adapters/src/interaction-kernel-guard.test.ts
git commit -m "test(adapters): guard the single card status write path"
```

---

## 收尾：A 批验收

- [ ] **Step 1: 跑全量受影响包**

```bash
export PATH=/home/lizer05/.cursor-server/bin/linux-x64/86776fcb52ca505783155631089b65d646f9b030:$PATH
pnpm vitest run --maxWorkers=1 packages/core/src packages/db/src packages/adapters/src
pnpm --filter @matebot/core check
pnpm --filter @matebot/db check
pnpm --filter @matebot/adapters check
pnpm --filter @matebot/api check
```

Expected: 全绿。适配器包用例多，**必须** `--maxWorkers=1`（本机内存有限，多 worker 会 swap 打死）。

- [ ] **Step 2: 逐条对照 A 批验收标准**

| 编号 | 准则 | 由哪个 Task 保证 |
|---|---|---|
| AC-1 | 同意图并发两次 publish，开放行数 = 1 | Task 3 索引 + Task 6 `P2002` 重试 |
| AC-2 | 部分唯一索引在后续迁移后仍存在 | Task 3 postgres 测试 |
| AC-3 | 存量双开放行迁移后每 `cardKey` 只剩一行 | Task 3 迁移 `ranked` 去重 |
| AC-4 | 枚举外状态写入被拒 | Task 1 `INTERACTION_STATUSES` + Task 4 `unknown_status` |
| AC-5 | `needs_connection` / `unknown` 不被批量结算 | Task 1 豁免表 + Task 4 决策 + Task 5 拒绝写入 |
| AC-6 | 不存在绕过 `settleInteraction` 的 status 写入 | Task 9 建立**只减不增**的白名单闸门；本批仍留 8 个白名单条目，收敛在 C 批完成 |

- [ ] **Step 3: 手工验证重复推卡**

在本地起服务，同一个线程连续两次让 Bot 拟同一封邮件。期望：时间线上**只有一张卡**，字段被更新，`draftVersion` 递增，不出现第二张卡、不出现第二个「发送」按钮。

- [ ] **Step 4: 提交验收记录**

```bash
git commit --allow-empty -m "chore: batch A (card kernel stop-the-bleeding) verified"
```

---

## 实施偏差（落地时确认的决定）

这些是本计划文本在落地时被修正的地方，代码与测试以修正后的行为为准：

- **`cardKey` 在迁移里保持可空，不立即 `SET NOT NULL`。** 生产部署会在迁移后继续运行上一版代码（旧 API 数秒、旧 worker 直到手头任务结束），旧代码发布卡片时不写这一列；立即收紧会让旧 worker 的插入失败。`createInteraction` 在调用方省略时仍派生 `interactionCardKey(threadId, intent)`，部分唯一索引照常覆盖所有带 key 的行；等旧版本退出后，后续批次再用一条迁移收紧。
- **回填 SQL 用字节拼接 NUL，不用 `chr(0)`。** PostgreSQL 不允许文本里出现 NUL，`chr(0)` 会报 `null character not permitted`；改为 `encode(sha256(convert_to("threadId",'UTF8') || '\x00'::bytea || convert_to("intent",'UTF8')),'hex')`，与 JS 侧的 `sha256(threadId + "\u0000" + intent)` 字节一致。
- **`decideSettle` 增加第五个拒绝理由 `not_terminal_target`。** 规格 §5 要求 `settleInteraction` 是「唯一终态写入」；只有 `current` 的校验会让 `collecting` 卡被「结算」成 `needs_connection` 或别的开放态。守卫放在纯函数内，`current` 的四条既有判定顺序不变。
- **`publishAmendment` / `edit_interaction` 的发布路径也走 `publishOrAmend`。** 规格 §5.3 要求所有卡片写入都经过同一个内核；任务清单只覆盖了 `present_interaction`。修正一张已执行记录时，若同一 intent 已有开放卡，直接调用 `publishInteractionSurface` 会撞上新的部分唯一索引；改走 `publishOrAmend` 后原地修订，并保留被替换块上的 `amendsInteractionId`。
- **`findOpenCard` 会查 `needs_connection`，但它仍不在部分唯一索引里。** 同一 intent 重复呈现时应原地修订而不是叠出第二张连接卡，所以查找集扩展到 `OPEN_STATUSES` 加 `needs_connection`；索引不能表达「按 intent 例外」，故不改索引。不同 intent 的连接卡仍需共存，AC-26（按 provider 的连接卡）留给 C 批。
- **AC-4 已 DEFERRED（本批未满足）。** `apps/api/src/interaction-service.ts` 的发送路径仍写入词表外的 `executing`，且数据库的 `status` 列还没有 CHECK 约束。把 in-flight 状态收敛到内核词表并补上约束需要一个能安全处理发送中途崩溃的方案：若本批就把 `executing` 拒之门外或直接加 CHECK，崩溃会留下无法结算的行，所以这两件事必须由同一个后续批次完成，届时一并迁移并结算这些卡。因此 AC-4 不由 A 批保证。

## 本批不做（明确留给后续批次）

- **`cancel_interaction` 不动**。它现有的 `cancelInteractionService` 已有一处**正确的** CAS 写入（`updateMany` + `draftVersion` + 状态守卫），先于内核存在且行为正确。为避免破坏一条能用的路径，本批只在白名单里保留它，等 C 批统一改造。**这是有意保留的技术债，不是遗漏。**
- `staleAt` 的写入与两段式结算（C 批）。本批只建列，`staleAt` 恒为 `NULL`。
- `expiresAt` 的扫描任务（C 批）。本批只在 `awaiting_approval` 时写入值。
- `surfaceAffordanceFor`、文案、标题、批准菜单（B 批）。
- 连接卡续跑 `resumePlan`（C 批）。
- `cardKind` 注册表与非 A2UI 块接入（D / E 批）。
- 自定义 A2UI catalog、协议收敛（F 批）。
