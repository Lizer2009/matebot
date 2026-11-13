# 交互卡内核（B 批：兑现）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户真正看到「一张卡」：卡的可交互性、文案、标题、按钮全部由服务端状态派生，终态卡不再长出发送按钮，过期/失败的卡只有唯一的重试入口，且 Web 与 Mobile 行为一致。

**Architecture:** A 批把「同线程 + 同意图只有一张活卡」做成物理约束，并把状态写入收敛到内核。B 批把这份状态**送到界面上**，形成唯一一条单向派生链：

```
Interaction.status（13 值，内核真相）
      ↓ surfaceStampFor        —— 唯一映射处（本批新建）
a2ui_surface block { status, lifecycle, template }
      ↓ surfaceAffordanceFor   —— 唯一判定处（本批新建）
{ interactive, editable, action, terminal, reasonKey }
      ↓ surfaceStatusCopy / surfaceActionLabel / surfaceCardTitle
各端文案表与控件
```

两个宿主只负责按派生结果画，不再各自反推阶段、各自决定哪个按钮能点。

**Tech Stack:** TypeScript、Prisma 7.10.1（PostgreSQL）、Vitest、Lingui（web）、自建 locale 表（mobile）、pnpm workspace

## 前置条件

A 批已合入（`docs/superpowers/plans/2026-11-13-001-interaction-card-kernel-batch-a.md`），可直接使用：

- `packages/core/src/interaction-status.ts`：13 值词表 + `isOpenStatus` / `isEditableStatus` / `isTerminalStatus` / `surfaceStatusFor`。
- `packages/core/src/interaction-kernel.ts`：`decideSettle`（**只**允许结算到终态）、`expiresAtFor`。
- `packages/core/src/interaction-runtime.ts`：`deriveCollectingStatus(plan, slots, current)`。
- `packages/adapters/src/interaction-kernel-store.ts`：`findOpenCard`、`settleInteraction`。
- `packages/adapters/src/interaction-publish.ts`：`publishOrAmend`（锁行 + 版本递增 + 原地改写 block）。
- `Interaction.cardKey` / `staleAt` / `expiresAt` 三列与部分唯一索引。

**A 批留下、B 批不补但要绕开的两个空洞**：

- 发信路径仍写词表外的 `executing`，`status` 列没有 CHECK（AC-4 DEFERRED）。
- `staleAt` 恒为 `NULL`；`expiresAt` 只在 `publishOrAmend` 的 `awaiting_approval` 分支写入，**确认路径不写**。所以本批不实现「剩余 N 分钟」倒计时（没有数据源），见「本批不做」。

---

## 范围说明

规格 §8 把 B 批定义为：

> **B 兑现**：`surfaceAffordanceFor` + `surfacePhase` + 文案/词表收敛 + 终态展示 + 按钮标签 + 类别小标签 + 标题形态 →「用户真看到一张卡」

对应 §6.1（可交互性）、§6.2（阶段推导）、§6.3（状态文案）、§6.4（动词与标题形态）、§6.7（终态展示与 `expired` 重试入口）。

**本批必须能单独上线**：外观与行为可变，数据库无表结构变更（block 内新增一个可选字段，`document` 结构不动），不改协议族，不改发信/授权/审计。

### 现状实测（本计划据此设计，均有代码依据）

| 事实 | 证据 |
|---|---|
| `superseded` / `expired` / `cancelled` / `sent` / `executed` / `confirmed` 全部被压成 `lifecycle: "draft"` + `email-draft-card` | 对 13 状态逐一求值 `emailSurfaceBlockFields`，只有 `succeeded`/`failed`/`unknown` 有专属值 |
| 日历卡不带任何 stamp | 各写入点都是 `isEmailPlan(plan) ? emailSurfaceBlockFields(...) : {}` |
| 日历卡回落到**邮件**模板 | `resolveEmailSurfaceTemplate` 对非邮件 intent 直接返回 `email-draft-card` |
| 移动端没有「被替代」概念 | `A2uiNativeSurface` 无 `superseded` 入参；`lifecycle: draft` 的旧卡照样画 `Send` |
| Web 的「被替代」是客户端链条推断 | `surfaceCardIsLive(cards)` 依据 `amendsInteractionId` 链，不读服务端状态（违反 G5） |
| 客户端拿不到 `Interaction.status` | `getA2uiSurface` 只回 `document`/`draftVersion`；block 只有 6 值 `lifecycle` |
| 读侧 3 值视图分不清终态 | `surfaceStatusFor("superseded") === surfaceStatusFor("succeeded") === "executed"` |
| 按钮文案已由注册表决定，模型写不进去 | `compile-surface.ts` 取 `schema.action.label`，schema 来自 `interaction-capability.ts`；「动词 + 对象」尚不存在 |
| 批准菜单只有两项、第三项 disabled | 四项与 `Bot.draftsDisabled` 属 D 批（§8） |

### 已确认的决策（落地按此执行）

1. **block 增加可选 `status` 快照字段（不是数据库列）。** §6.1 的 `surfaceAffordanceFor(status)` 需要 13 值才能区分「被替代」「已过期」「已发出」；6 值 `lifecycle` 与 3 值 `surfaceStatusFor` 都表达不了，而 §4.4 要求 `lifecycle` 保持 6 值。旧 block 没有该字段 → 宿主回退到 `lifecycle + capability`，滚动发布期间两端都能工作。
2. **`lifecycle` 不加值。** `superseded` / `expired` / `cancelled` 的 `lifecycle` 仍是 `draft`——这是事实：它们确实没进入提交/执行阶段。真相改由 `status` 承载，而写侧由一条源码闸门保证**每个** block 都带 `status`。历史投影（C 批）必须改读 `status`；本批的「实施偏差」记录这一后果。
3. **`executing` 不进词表，也不伪造状态。** 它来自 A 批的 AC-4 空洞。`surfaceStampFor` 遇到它时**不写 `status`**，只给 `template: action-progress-card` 与 `lifecycle: executing|submitting`，让宿主走旧回退（`action: "none"`、锁定）。等 AC-4 收敛后此分支自然消失。
4. **终态模板不按 intent 分裂。** §6.2 列的 `calendar-superseded-card` / `calendar-expired-card` 不实现：终态由共享折叠行渲染，两份实现正是本轮要消除的重复。日历只补「卡体确实不同」的阶段（草稿、提交中、结果成功/失败）。
5. **`reasonKey` 只发有真实数据源的键。** 现有证据是 `ActionApprovalResolved.source`（`require_approval` / `allow` / `default`）加规则归属（`ActionApprovalRule.createdByUserId` 是否为当前用户）。`effect.amount` 目前没有任何金额阈值信号 → 保留键、永不发出。
6. **重试不复用 `decideSettle`。** `decideSettle` 明确拒绝「终态 → 开放态」（AC-5 守卫）。重试是**被请求的例外**，因此是独立的 `reviveCard`，自带白名单（仅 `expired` / `failed`）与 CAS。

---

## Global Constraints

- Node 22+ 与 pnpm 9 已在 PATH 上。
- 测试统一用 vitest，从仓库根运行；**必须**加 `--maxWorkers=1`（本机内存有限，多 worker 会 OOM）：
  ```bash
  pnpm vitest run --maxWorkers=1 packages/core/src/<file>.test.ts
  ```
- 类型检查：`pnpm --filter @matebot/{core,adapters,api,web,mobile} check`。
- 真库用例（`*.postgres.test.ts`）需要两个登录：迁移用 owner，运行期用 `matebot_app`（生产即如此，RLS 才生效）。本机一次性准备：
  ```bash
  export DATABASE_URL=postgres://matebot_app:<pwd>@127.0.0.1:5433/matebot
  export DATABASE_MIGRATION_URL=postgres://matebot:<pwd>@127.0.0.1:5433/matebot
  export REALTIME_DATABASE_URL="$DATABASE_URL"
  pnpm db:migrate                       # 建运行期角色与 grants
  export VERIFY_DATABASE=1 COPY_TEST_DATABASE=1
  pnpm vitest run --maxWorkers=1 <file>.postgres.test.ts
  ```
  不设 `VERIFY_DATABASE` 时整套 `describe` 会 skip。
- **状态词表固定 13 值**，逐字照抄：`collecting`、`ready_for_review`、`awaiting_approval`、`needs_connection`、`unknown`、`sent`、`executed`、`succeeded`、`confirmed`、`superseded`、`expired`、`failed`、`cancelled`。不新增任何状态值。
- **依赖方向**：`@matebot/core` 依赖 `@matebot/contracts`，**反向不允许**。contracts 里的 zod 枚举必须逐字复制 13 值，并由 core 侧一条测试断言两边集合相等——不要在 contracts 里 import core。
- `A2uiSurfaceBlockSchema` 只允许**追加可空字段**；`protocolFamily`、`document` 结构、`amendsInteractionId` 语义不动。
- Web 文案走 Lingui，且**不得在模块作用域求值**（`t` 宏在 import 时求值会固定成源语言）；用函数内 `i18n._({ id, message })` 或组件内 `useLingui()`，改完跑 `pnpm --filter @matebot/web intl:extract --clean --workers 1` 并提交 catalog。移动端文案写进 `apps/mobile/lib/locales/<locale>.ts`。
- 不硬编码产品色；不加解释性段落（AGENTS.md「Treat every visible word as UI」）。
- 提交信息用英文，前缀 `feat:` / `fix:` / `refactor:` / `test:` / `chore:`。每 Task 结束单独 commit。

---

## 文件结构

**新建**

| 文件 | 职责 |
|---|---|
| `packages/core/src/surface-stamp.ts` | `surfaceStampFor`：状态 → `{ status?, lifecycle, template }`，**唯一**映射处 |
| `packages/core/src/surface-affordance.ts` | `surfaceAffordanceFor`：状态 → 可交互/可编辑/唯一动作/终态/`reasonKey`（纯函数） |
| `packages/core/src/surface-status-copy.ts` | `surfaceStatusCopy`：状态 → 文案**键**（不含句子） |
| `packages/core/src/surface-phase.ts` | `surfacePhase`：邮件与日历共用一套阶段推导 |
| `packages/core/src/surface-action-label.ts` | `surfaceActionLabel`：注册表动词白名单 + 受控对象 |
| `packages/core/src/surface-card-title.ts` | `surfaceCardTitle`：审阅型「类别 + 内容」／决策型问句 |
| `apps/web/src/components/a2ui/surface-copy.ts` | Web 文案键 → 本地字符串（**函数**，非模块级表） |
| `apps/mobile/lib/surface-copy.ts` | Mobile 同上 |

**修改**

| 文件 | 改动 |
|---|---|
| `packages/contracts/src/interaction.ts` | `A2uiSurfaceBlockSchema` 加可选 `status`；`EmailSurfaceTemplate` 增补 4 个通用阶段 id |
| `packages/core/src/interaction-template.ts` | `emailSurfaceBlockFields` / `emailSurfacePhase` 改为委托新模块 |
| `packages/core/src/interaction-capability.ts` | 每个能力加 `cardShape` 与 `actionVerb` |
| `packages/adapters/src/interaction-kernel-store.ts` | 新增 `reviveCard` |
| `packages/adapters/src/interaction-publish.ts` | 所有 block 写入带 stamp |
| `packages/adapters/src/interaction-field-writer.ts` | 同上（字段写入、取消两处） |
| `packages/adapters/src/interaction-email-outcome.ts` | 同上 |
| `packages/adapters/src/interaction-result-publish.ts` | 同上 |
| `packages/adapters/src/interaction-kernel-guard.test.ts` | 新增「每个 block 都带 status」闸门 |
| `apps/api/src/interaction-retry.ts` | 新服务层：加载 → `reviveCard` → 重写 block + 事件 |
| `apps/api/src/routes/threads.ts` | 新增 `retryInteraction` 路由 |
| `apps/web/src/components/a2ui/A2uiSurfaceCard.tsx` | 由 affordance 驱动：终态折叠、重试、类别小标签、标题 |
| `apps/web/src/components/a2ui/EmailComposeEditor.tsx` | 按 `affordance.action` 单一来源决定控件 |
| `apps/web/src/pages/shell/transcript.tsx` | 传 block `status`；`surfaceCardIsLive` 降为旧 block 回退 |
| `apps/mobile/components/thread/a2ui-native-surface.tsx` | 补终态折叠与重试（当前完全没有） |
| `apps/mobile/components/thread/message-bubble.tsx` | 接 `onRetry` |

**测试**

| 文件 | 覆盖 |
|---|---|
| `packages/core/src/surface-stamp.test.ts` | 13 状态 × 邮件/日历 stamp 表；`executing` 不伪造状态；AC-12 数据面 |
| `packages/core/src/surface-contract-parity.test.ts` | contracts 的 zod 枚举与 core 词表逐字相等 |
| `packages/core/src/surface-affordance.test.ts` | 13 状态表（AC-12）、旧 block 回退、`reasonKey` 白名单（AC-24） |
| `packages/core/src/surface-status-copy.test.ts` | 每状态有键、终态键互不相同（AC-14） |
| `packages/core/src/surface-phase.test.ts` | 邮件与日历共用同一函数（AC-13） |
| `packages/core/src/surface-action-label.test.ts` | 动词白名单 + 对象受控（AC-15） |
| `packages/core/src/surface-card-title.test.ts` | 审阅型/决策型（AC-18） |
| `packages/adapters/src/interaction-revive.test.ts` | 只允许 `expired`/`failed`；CAS；其他终态拒绝 |
| `packages/adapters/src/interaction-revive.postgres.test.ts` | 重试复用同一行、不产生第二张卡（AC-20） |
| `apps/web/src/components/a2ui/A2uiSurfaceCard.test.tsx` | 终态无按钮、`expired`/`failed` 仅有重试、类别小标签 |
| `apps/mobile/lib/a2ui-terminal-card.test.tsx` | 移动端终态不再出现 `Send`（AC-12 三端） |

---

## Task 1: stamp 单一来源

**Files:**
- Create: `packages/core/src/surface-stamp.ts`
- Create: `packages/core/src/surface-stamp.test.ts`
- Create: `packages/core/src/surface-contract-parity.test.ts`
- Modify: `packages/contracts/src/interaction.ts`
- Modify: `packages/core/src/interaction-template.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `InteractionStatus`（A 批）
- Produces:
  - `SURFACE_TEMPLATES` / `type SurfaceTemplate`
  - `function surfaceStampFor(input: { status: string; intent?: string }): { status?: InteractionStatus; lifecycle: EmailSurfaceLifecycle; template: SurfaceTemplate }`

- [ ] **Step 1: 写失败测试**

创建 `packages/core/src/surface-stamp.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { INTERACTION_STATUSES } from "./interaction-status.js";
import { surfaceStampFor } from "./surface-stamp.js";

describe("surfaceStampFor", () => {
  // The defect B exists to close: a replaced card was stamped the *draft* template, so both
  // hosts drew an editable form with a working Send button for a card already replaced.
  it("never gives a closed card a draft template", () => {
    for (const intent of ["email.compose", "email.send", "calendar.create"]) {
      for (const status of ["superseded", "expired", "cancelled", "succeeded", "failed"] as const) {
        expect(surfaceStampFor({ status, intent }).template, `${intent}/${status}`).not.toMatch(
          /-draft-card$/,
        );
      }
    }
  });

  it("gives each terminal status its own template", () => {
    const templates = (["superseded", "expired", "cancelled"] as const).map(
      (status) => surfaceStampFor({ status, intent: "email.compose" }).template,
    );
    expect(new Set(templates).size).toBe(3);
  });

  it("carries the kernel status so hosts do not have to infer it", () => {
    for (const status of INTERACTION_STATUSES) {
      expect(surfaceStampFor({ status, intent: "email.compose" }).status).toBe(status);
    }
  });

  // `lifecycle` keeps its six values (§4.4): these three never entered submission, and saying so
  // is honest. The truth a host must act on is `status`; the guard test in Task 7 keeps every
  // writer stamping it, so no consumer is left reading `lifecycle` alone.
  it("keeps lifecycle at six values, so a closed card still reads draft there", () => {
    for (const status of ["superseded", "expired", "cancelled"]) {
      expect(surfaceStampFor({ status, intent: "email.compose" }).lifecycle).toBe("draft");
    }
  });

  it("keeps the email templates email owns", () => {
    expect(surfaceStampFor({ status: "ready_for_review", intent: "email.compose" }).template).toBe(
      "email-draft-card",
    );
    expect(surfaceStampFor({ status: "succeeded", intent: "email.compose" }).template).toBe(
      "action-result-success",
    );
  });

  // A calendar card was stamped nothing, and the fallback returned an *email* template, so a
  // cancelled calendar draft rendered as a live email form.
  it("never hands a calendar card an email template", () => {
    for (const status of INTERACTION_STATUSES) {
      const stamp = surfaceStampFor({ status, intent: "calendar.create" });
      expect(stamp.template.startsWith("email-"), `${status}`).toBe(false);
    }
    expect(surfaceStampFor({ status: "ready_for_review", intent: "calendar.create" }).template).toBe(
      "action-draft-card",
    );
  });

  // A 批的已知洞：发信路径写词表外的 `executing`。本批不把它塞进 13 值，也不伪造一个状态。
  it("stamps a progress template for executing without inventing a kernel status", () => {
    const stamp = surfaceStampFor({ status: "executing", intent: "email.compose" });
    expect(stamp.status).toBeUndefined();
    expect(stamp.template).toBe("action-progress-card");
    expect(stamp.lifecycle).toBe("executing");
  });

  it("treats submitting as in flight, not as a draft", () => {
    const stamp = surfaceStampFor({ status: "submitting", intent: "email.compose" });
    expect(stamp.status).toBeUndefined();
    expect(stamp.template).toBe("action-submitting-card");
  });
});
```

`packages/core/src/surface-contract-parity.test.ts`：

```ts
import { EmailSurfaceTemplate, InteractionStatus as ContractStatus } from "@matebot/contracts";
import { describe, expect, it } from "vitest";
import { INTERACTION_STATUSES } from "./interaction-status.js";
import { SURFACE_TEMPLATES } from "./surface-stamp.js";

// contracts must not import core (the dependency points the other way), so the thirteen values
// exist twice. These assertions are what keep the copies from drifting.
describe("status vocabulary parity", () => {
  it("matches the contracts enum exactly", () => {
    expect([...ContractStatus.options].sort()).toEqual([...INTERACTION_STATUSES].sort());
  });

  it("keeps every template a stamp can produce inside the contracts enum", () => {
    for (const template of SURFACE_TEMPLATES) {
      expect(EmailSurfaceTemplate.options, template).toContain(template);
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm vitest run --maxWorkers=1 packages/core/src/surface-stamp.test.ts packages/core/src/surface-contract-parity.test.ts
```

Expected: FAIL，`Failed to resolve import "./surface-stamp.js"`。

- [ ] **Step 3: contracts 侧加枚举**

在 `packages/contracts/src/interaction.ts`：

1. 在 `A2uiProtocolFamily` 附近新增（**逐字 13 值**，不从 core 引）：

```ts
export const InteractionStatus = z.enum([
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
]);
export type InteractionStatus = z.infer<typeof InteractionStatus>;
```

2. `EmailSurfaceTemplate` 枚举追加四个通用阶段 id（追加，不删不改既有值）：

```ts
  "action-draft-card",
  "action-superseded-card",
  "action-expired-card",
  "action-cancelled-card",
```

3. `A2uiSurfaceBlockSchema` 在 `lifecycle` 之后插入：

```ts
  /**
   * The interaction's own status, copied at write time.
   *
   * `lifecycle` keeps six values and cannot tell a superseded card from a live draft; a host
   * needs the real status to decide what the card may still do. Optional so blocks written
   * before this field existed keep parsing: a host that finds it missing falls back to
   * `lifecycle` + `capability`.
   */
  status: InteractionStatus.optional(),
```

- [ ] **Step 4: 写 `surface-stamp.ts`**

```ts
import type { EmailSurfaceLifecycle } from "./interaction-template.js";
import type { InteractionStatus } from "./interaction-status.js";
import { INTERACTION_STATUSES } from "./interaction-status.js";

/**
 * The template ids a card may carry.
 *
 * `email-*` are the states the mail editor draws differently. `action-*` are intent-independent,
 * which is what lets a calendar card be a card without borrowing an email template — before
 * this, a calendar draft was stamped nothing and fell back to `email-draft-card`. A closed card
 * has one shared template per terminal kind on purpose: folding a finished card is one design,
 * and two implementations of it is how the two hosts drifted apart.
 */
export const SURFACE_TEMPLATES = [
  "email-connection-card",
  "email-reauth-card",
  "email-draft-card",
  "action-draft-card",
  "action-submitting-card",
  "action-progress-card",
  "action-result-success",
  "action-result-failed",
  "action-reconcile-card",
  "action-superseded-card",
  "action-expired-card",
  "action-cancelled-card",
] as const;

export type SurfaceTemplate = (typeof SURFACE_TEMPLATES)[number];

const TEMPLATES: ReadonlySet<string> = new Set(SURFACE_TEMPLATES);

/** Whether a string is a template this build knows how to draw. */
export function isSurfaceTemplate(value: string): value is SurfaceTemplate {
  return TEMPLATES.has(value);
}

const KERNEL_STATUSES: ReadonlySet<string> = new Set(INTERACTION_STATUSES);

function isEmailIntent(intent: string | undefined): boolean {
  return intent === "email.compose" || intent === "email.send";
}

/**
 * The interaction's status onto the two fields a rendered block carries.
 *
 * This is the only place that decides what a card *is* for the hosts. Before it existed the
 * mapping lived in `emailSurfaceBlockFields`, which knew only six email lifecycles and returned
 * `draft` for every status it had no branch for — so `superseded`, `expired` and `cancelled`
 * all reached the client looking editable.
 *
 * Two inputs are not kernel statuses. `executing` and `submitting` come from the runtime
 * lifecycle, which the kernel vocabulary deliberately does not contain (AC-4 is still open in
 * A 批). They get a template and a lifecycle but **no** `status`, so a host falls back to the
 * lifecycle and draws a locked card rather than a fabricated status.
 */
export function surfaceStampFor(input: { status: string; intent?: string }): {
  status?: InteractionStatus;
  lifecycle: EmailSurfaceLifecycle;
  template: SurfaceTemplate;
} {
  const { status } = input;
  const email = isEmailIntent(input.intent);

  if (status === "submitting" || status === "executing") {
    return {
      lifecycle: status === "submitting" ? "submitting" : "executing",
      template: status === "submitting" ? "action-submitting-card" : "action-progress-card",
    };
  }
  if (!KERNEL_STATUSES.has(status)) {
    // An unknown value is not evidence of a draft. Draw nothing actionable.
    return { lifecycle: "unknown", template: "action-reconcile-card" };
  }

  const kernel = status as InteractionStatus;
  const draftTemplate: SurfaceTemplate = email ? "email-draft-card" : "action-draft-card";

  switch (kernel) {
    case "collecting":
    case "ready_for_review":
    case "awaiting_approval":
      return { status: kernel, lifecycle: "draft", template: draftTemplate };
    case "needs_connection":
      return {
        status: kernel,
        lifecycle: "draft",
        template: email ? "email-connection-card" : "action-draft-card",
      };
    case "unknown":
      return { status: kernel, lifecycle: "unknown", template: "action-reconcile-card" };
    case "sent":
    case "executed":
    case "succeeded":
    case "confirmed":
      return { status: kernel, lifecycle: "succeeded", template: "action-result-success" };
    case "failed":
      return { status: kernel, lifecycle: "failed", template: "action-result-failed" };
    case "superseded":
      return { status: kernel, lifecycle: "draft", template: "action-superseded-card" };
    case "expired":
      return { status: kernel, lifecycle: "draft", template: "action-expired-card" };
    case "cancelled":
      return { status: kernel, lifecycle: "draft", template: "action-cancelled-card" };
  }
}
```

- [ ] **Step 5: `emailSurfaceBlockFields` 委托**

在 `packages/core/src/interaction-template.ts`：

- `resolveEmailSurfaceTemplate` / `resolveEmailSurfaceLifecycle` 保留（`emailSurfaceTemplateFromBlock` 的反向推导还在用），但 `emailSurfaceBlockFields` 改为：

```ts
export function emailSurfaceBlockFields(
  input: EmailSurfaceTemplateInput & { providerMessageId?: string | null; error?: string | null },
): {
  status?: InteractionStatus;
  template: SurfaceTemplate;
  lifecycle: EmailSurfaceLifecycle;
  capability?: EmailSurfaceCapability;
  providerMessageId?: string;
  error?: string;
} {
  // The lifecycle is the runtime's own (submitting/executing carry effect progress the kernel
  // status cannot express yet); everything else is decided by the kernel status alone.
  const inFlight = resolveEmailSurfaceLifecycle(input);
  const status =
    inFlight === "submitting" || inFlight === "executing" ? inFlight : input.interactionStatus;
  const stamp = surfaceStampFor({ status, intent: input.intent });
  const providerMessageId = input.providerMessageId?.trim();
  const error = input.error?.trim();
  return {
    ...stamp,
    ...(input.capability ? { capability: input.capability } : {}),
    ...(providerMessageId ? { providerMessageId } : {}),
    ...(error ? { error } : {}),
  };
}
```

- [ ] **Step 6: 跑测试与既有用例**

```bash
pnpm vitest run --maxWorkers=1 \
  packages/core/src/surface-stamp.test.ts \
  packages/core/src/surface-contract-parity.test.ts \
  packages/core/src/interaction-template.test.ts \
  packages/core/src/interaction-surface-phase.test.ts
pnpm --filter @matebot/core check && pnpm --filter @matebot/contracts check
```

Expected: 新增全绿；既有邮件模板用例仍需通过。若某条既有断言写死了「`superseded` → `email-draft-card`」，说明它记录的正是本轮要改的行为，改为断言终态模板并注明原因——**不要**放宽断言。

- [ ] **Step 7: 导出并提交**

`packages/core/src/index.ts` 加：

```ts
export * from "./surface-stamp.js";
```

```bash
git add -A packages/core packages/contracts
git commit -m "feat(core): derive a card's stamps from the kernel status, for every intent"
```

---

## Task 2: `surfaceAffordanceFor`（AC-12 / AC-24）

**Files:**
- Create: `packages/core/src/surface-affordance.ts`
- Create: `packages/core/src/surface-affordance.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces:
  - `type SurfaceActionKind = "connect" | "submit" | "retry" | "check_status" | "none"`
  - `SURFACE_REASON_KEYS` / `type SurfaceReasonKey`
  - `type SurfaceAffordance`
  - `function surfaceAffordanceFor(input: { status?: string; lifecycle?: string; capability?: string; reasonKey?: string }): SurfaceAffordance`
  - `function canRetryStatus(status: string): boolean`

- [ ] **Step 1: 写失败测试**

创建 `packages/core/src/surface-affordance.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { INTERACTION_STATUSES } from "./interaction-status.js";
import { canRetryStatus, surfaceAffordanceFor } from "./surface-affordance.js";

describe("surfaceAffordanceFor", () => {
  it("offers exactly one action while the card is open", () => {
    for (const status of ["collecting", "ready_for_review", "awaiting_approval"]) {
      expect(surfaceAffordanceFor({ status }), status).toMatchObject({
        interactive: true,
        editable: true,
        action: "submit",
        terminal: false,
      });
    }
    expect(surfaceAffordanceFor({ status: "needs_connection" })).toMatchObject({
      action: "connect",
      editable: false,
      terminal: false,
    });
    expect(surfaceAffordanceFor({ status: "unknown" })).toMatchObject({
      action: "check_status",
      editable: false,
      terminal: false,
    });
  });

  // AC-12: a replaced or cancelled card offers nothing; expired/failed offer only a retry.
  it("gives a replaced, cancelled or finished card nothing to press", () => {
    for (const status of [
      "superseded",
      "cancelled",
      "succeeded",
      "sent",
      "executed",
      "confirmed",
    ]) {
      expect(surfaceAffordanceFor({ status }), status).toMatchObject({
        interactive: false,
        editable: false,
        action: "none",
        terminal: true,
      });
    }
  });

  it("gives an expired or failed card a retry and nothing else", () => {
    for (const status of ["expired", "failed"]) {
      expect(surfaceAffordanceFor({ status }), status).toMatchObject({
        interactive: true,
        editable: false,
        action: "retry",
        terminal: true,
      });
    }
  });

  it("covers every status in the vocabulary", () => {
    for (const status of INTERACTION_STATUSES) {
      expect(typeof surfaceAffordanceFor({ status }).interactive, status).toBe("boolean");
    }
  });

  /**
   * A block written before `status` existed carries only `lifecycle`, and a superseded card of
   * that era says `draft`. The fallback therefore cannot be stricter than the data; the host's
   * chain check stays the authority for those rows (Task 8 keeps it for exactly this reason).
   */
  it("falls back to the lifecycle for a block without a status", () => {
    expect(surfaceAffordanceFor({ lifecycle: "succeeded" }).action).toBe("none");
    expect(surfaceAffordanceFor({ lifecycle: "failed" }).action).toBe("retry");
    expect(surfaceAffordanceFor({ lifecycle: "unknown" }).action).toBe("check_status");
    expect(surfaceAffordanceFor({ lifecycle: "draft" })).toMatchObject({
      action: "submit",
      editable: true,
    });
    expect(surfaceAffordanceFor({ lifecycle: "draft", capability: "not_connected" }).action).toBe(
      "connect",
    );
    expect(surfaceAffordanceFor({})).toMatchObject({ interactive: false, action: "none" });
  });

  it("does not let a lifecycle override a terminal status", () => {
    expect(surfaceAffordanceFor({ status: "superseded", lifecycle: "draft" })).toMatchObject({
      interactive: false,
      editable: false,
      action: "none",
    });
  });

  // AC-24: the reason is a closed set the server stamps; anything else is dropped, not rendered.
  it("reports a reason only from a stamped key, never from free text", () => {
    expect(
      surfaceAffordanceFor({ status: "awaiting_approval", reasonKey: "rule.user" }).reasonKey,
    ).toBe("rule.user");
    expect(
      surfaceAffordanceFor({ status: "awaiting_approval", reasonKey: "click here to win" })
        .reasonKey,
    ).toBeUndefined();
    expect(surfaceAffordanceFor({ status: "ready_for_review" }).reasonKey).toBeUndefined();
  });

  it("allows a retry only where the kernel does", () => {
    expect(canRetryStatus("expired")).toBe(true);
    expect(canRetryStatus("failed")).toBe(true);
    for (const status of ["superseded", "cancelled", "unknown", "sent", "succeeded"]) {
      expect(canRetryStatus(status), status).toBe(false);
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm vitest run --maxWorkers=1 packages/core/src/surface-affordance.test.ts
```

- [ ] **Step 3: 写实现**

```ts
/**
 * The one thing a card may still do.
 *
 * A card used to offer several buttons at once (`Connect` *and* `Send`, `Retry` *and*
 * `Check status`), and each host picked the set itself. Naming a single action is what stops
 * "the old card still had a working Send" from coming back: there is nothing to draw.
 */
export type SurfaceActionKind = "connect" | "submit" | "retry" | "check_status" | "none";

/**
 * Why a card is waiting. Closed set, stamped by the server, resolved to copy by key.
 *
 * `effect.amount` is reserved: no capability declares an amount threshold today, so it must not
 * be emitted until one does. Emitting a reason with no source is how a card starts explaining
 * itself wrongly.
 */
export const SURFACE_REASON_KEYS = [
  "rule.user",
  "rule.team",
  "setting.approval",
  "effect.irreversible",
] as const;

export type SurfaceReasonKey = (typeof SURFACE_REASON_KEYS)[number];

const REASONS: ReadonlySet<string> = new Set(SURFACE_REASON_KEYS);

export type SurfaceAffordance = {
  interactive: boolean;
  editable: boolean;
  action: SurfaceActionKind;
  terminal: boolean;
  reasonKey?: SurfaceReasonKey;
};

function fromStatus(status: string): SurfaceAffordance | undefined {
  switch (status) {
    case "collecting":
    case "ready_for_review":
    case "awaiting_approval":
      return { interactive: true, editable: true, action: "submit", terminal: false };
    case "needs_connection":
      return { interactive: true, editable: false, action: "connect", terminal: false };
    case "unknown":
      return { interactive: true, editable: false, action: "check_status", terminal: false };
    case "expired":
    case "failed":
      return { interactive: true, editable: false, action: "retry", terminal: true };
    case "superseded":
    case "cancelled":
    case "sent":
    case "executed":
    case "succeeded":
    case "confirmed":
      return { interactive: false, editable: false, action: "none", terminal: true };
    default:
      return undefined;
  }
}

/** What a block written before `status` existed can still say, from its lifecycle. */
function fromLifecycle(
  lifecycle: string | undefined,
  capability: string | undefined,
): SurfaceAffordance {
  if (capability === "not_connected" || capability === "requires_reauth") {
    return { interactive: true, editable: false, action: "connect", terminal: false };
  }
  switch (lifecycle) {
    case "succeeded":
      return { interactive: false, editable: false, action: "none", terminal: true };
    case "failed":
      return { interactive: true, editable: false, action: "retry", terminal: true };
    case "unknown":
      return { interactive: true, editable: false, action: "check_status", terminal: false };
    case "submitting":
    case "executing":
      return { interactive: false, editable: false, action: "none", terminal: false };
    case "draft":
      return { interactive: true, editable: true, action: "submit", terminal: false };
    default:
      // No status and no lifecycle: promise nothing rather than draw a control.
      return { interactive: false, editable: false, action: "none", terminal: false };
  }
}

/**
 * What this card may do, decided once for every host.
 *
 * A status wins over the lifecycle when present; a terminal affordance is never editable and
 * never `submit` — that pair is exactly the bug where a superseded draft kept a live Send.
 */
export function surfaceAffordanceFor(input: {
  status?: string;
  lifecycle?: string;
  capability?: string;
  reasonKey?: string;
}): SurfaceAffordance {
  const base =
    (input.status ? fromStatus(input.status) : undefined) ??
    fromLifecycle(input.lifecycle, input.capability);
  const safe = base.terminal ? { ...base, editable: false } : base;
  const reasonKey =
    input.reasonKey && REASONS.has(input.reasonKey)
      ? (input.reasonKey as SurfaceReasonKey)
      : undefined;
  return reasonKey ? { ...safe, reasonKey } : safe;
}

/** Whether the retry path may revive this status. Mirrors `reviveCard`'s whitelist. */
export function canRetryStatus(status: string): boolean {
  return status === "expired" || status === "failed";
}
```

- [ ] **Step 4: 跑测试、导出、提交**

```bash
pnpm vitest run --maxWorkers=1 packages/core/src/surface-affordance.test.ts
echo 'export * from "./surface-affordance.js";' >> packages/core/src/index.ts   # 保持字母序插入更好
pnpm --filter @matebot/core check
git add packages/core/src/surface-affordance*.ts packages/core/src/index.ts
git commit -m "feat(core): decide what a card may still do, from its status"
```

---

## Task 3: 状态文案单一来源（AC-14）

**Files:**
- Create: `packages/core/src/surface-status-copy.ts`
- Create: `packages/core/src/surface-status-copy.test.ts`
- Create: `apps/web/src/components/a2ui/surface-copy.ts`
- Create: `apps/mobile/lib/surface-copy.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces:
  - `SURFACE_COPY_KEYS` / `type SurfaceCopyKey`
  - `function surfaceStatusCopy(input: { status: string }): { titleKey: SurfaceCopyKey; actionKey?: SurfaceCopyKey }`
  - `function surfaceReasonCopy(reason: SurfaceReasonKey): SurfaceCopyKey`
  - `function surfaceStaleHint(): SurfaceCopyKey`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { INTERACTION_STATUSES } from "./interaction-status.js";
import { SURFACE_COPY_KEYS, surfaceReasonCopy, surfaceStatusCopy } from "./surface-status-copy.js";

describe("surfaceStatusCopy", () => {
  it("names a copy key for every status", () => {
    for (const status of INTERACTION_STATUSES) {
      expect(SURFACE_COPY_KEYS, status).toContain(surfaceStatusCopy({ status }).titleKey);
    }
  });

  it("tells a replaced card apart from an expired one", () => {
    expect(surfaceStatusCopy({ status: "superseded" }).titleKey).not.toBe(
      surfaceStatusCopy({ status: "expired" }).titleKey,
    );
  });

  it("gives a retry label exactly to the two retryable statuses", () => {
    expect(surfaceStatusCopy({ status: "expired" }).actionKey).toBe("action.retry");
    expect(surfaceStatusCopy({ status: "failed" }).actionKey).toBe("action.retry");
    expect(surfaceStatusCopy({ status: "superseded" }).actionKey).toBeUndefined();
    expect(surfaceStatusCopy({ status: "succeeded" }).actionKey).toBeUndefined();
  });

  // An in-doubt email must ask a question, never claim an outcome.
  it("asks about an in-doubt send", () => {
    expect(surfaceStatusCopy({ status: "unknown" })).toMatchObject({
      titleKey: "status.unknown",
      actionKey: "action.check_status",
    });
  });

  it("has a reason line for every reason key", () => {
    for (const reason of [
      "rule.user",
      "rule.team",
      "setting.approval",
      "effect.irreversible",
    ] as const) {
      expect(SURFACE_COPY_KEYS, reason).toContain(surfaceReasonCopy(reason));
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**，然后写实现：

```ts
/**
 * The keys a card's copy can come from.
 *
 * Keys, not sentences: the server does not know the reader's locale, and returning English prose
 * would make the status line the one untranslated thing on screen. Each host resolves these
 * through its own function, typed `Record<SurfaceCopyKey, string>`, so a new key fails to compile
 * until every host has a line for it — that is how AC-14 is enforced instead of scanned for.
 */
export const SURFACE_COPY_KEYS = [
  "status.draft",
  "status.replaced",
  "status.expired",
  "status.failed",
  "status.cancelled",
  "status.unknown",
  "status.succeeded",
  "reason.rule_user",
  "reason.rule_team",
  "reason.setting_approval",
  "reason.effect_irreversible",
  "action.retry",
  "action.check_status",
  "hint.stale",
] as const;

export type SurfaceCopyKey = (typeof SURFACE_COPY_KEYS)[number];

export function surfaceStatusCopy(input: { status: string }): {
  titleKey: SurfaceCopyKey;
  actionKey?: SurfaceCopyKey;
} {
  switch (input.status) {
    case "superseded":
      return { titleKey: "status.replaced" };
    case "expired":
      return { titleKey: "status.expired", actionKey: "action.retry" };
    case "failed":
      return { titleKey: "status.failed", actionKey: "action.retry" };
    case "cancelled":
      return { titleKey: "status.cancelled" };
    case "unknown":
      return { titleKey: "status.unknown", actionKey: "action.check_status" };
    case "sent":
    case "executed":
    case "succeeded":
    case "confirmed":
      return { titleKey: "status.succeeded" };
    default:
      return { titleKey: "status.draft" };
  }
}

const REASON_COPY: Record<SurfaceReasonKey, SurfaceCopyKey> = {
  "rule.user": "reason.rule_user",
  "rule.team": "reason.rule_team",
  "setting.approval": "reason.setting_approval",
  "effect.irreversible": "reason.effect_irreversible",
};

export function surfaceReasonCopy(reason: SurfaceReasonKey): SurfaceCopyKey {
  return REASON_COPY[reason];
}

/** The staleness hint. Not a status: a card can be current and marked at once (§4.3). */
export function surfaceStaleHint(): SurfaceCopyKey {
  return "hint.stale";
}
```

- [ ] **Step 3: Web 端文案函数（注意：不能是模块级表）**

`apps/web/src/components/a2ui/surface-copy.ts`：

```ts
import { i18n } from "@lingui/core";
import type { SurfaceCopyKey } from "@matebot/core";

/**
 * The web words for a card's status.
 *
 * Resolved at call time, not at import: Lingui's `t` macro evaluates where it appears, so a
 * module-level table would freeze whatever locale was active during the first import and never
 * follow a language switch. The `switch` also keeps every string statically extractable.
 */
export function surfaceCopy(key: SurfaceCopyKey): string {
  switch (key) {
    case "status.draft":
      return i18n._({ id: "Draft", message: "Draft" });
    case "status.replaced":
      return i18n._({ id: "Replaced by a newer draft", message: "Replaced by a newer draft" });
    case "status.expired":
      return i18n._({ id: "Expired, nothing was sent", message: "Expired, nothing was sent" });
    case "status.failed":
      return i18n._({ id: "Failed", message: "Failed" });
    case "status.cancelled":
      return i18n._({ id: "Discarded", message: "Discarded" });
    case "status.unknown":
      return i18n._({
        id: "Checking whether this was sent",
        message: "Checking whether this was sent",
      });
    case "status.succeeded":
      return i18n._({ id: "Done", message: "Done" });
    case "reason.rule_user":
      return i18n._({ id: "Your rule asks first", message: "Your rule asks first" });
    case "reason.rule_team":
      return i18n._({ id: "This space's rules ask first", message: "This space's rules ask first" });
    case "reason.setting_approval":
      return i18n._({ id: "Your settings ask first", message: "Your settings ask first" });
    case "reason.effect_irreversible":
      return i18n._({ id: "This step cannot be undone", message: "This step cannot be undone" });
    case "action.retry":
      return i18n._({ id: "Retry", message: "Retry" });
    case "action.check_status":
      return i18n._({ id: "Check status", message: "Check status" });
    case "hint.stale":
      return i18n._({ id: "There may be a newer version", message: "There may be a newer version" });
  }
}
```

`apps/mobile/lib/surface-copy.ts` 结构相同，但接收 `t`（移动端 `useI18n` 的翻译函数）作为参数，键为英文原句，供 `apps/mobile/lib/locales/*.ts` 使用：

```ts
export function surfaceCopy(t: (message: string) => string, key: SurfaceCopyKey): string
```

- [ ] **Step 4: 跑测试、抽 catalog、提交**

```bash
pnpm vitest run --maxWorkers=1 packages/core/src/surface-status-copy.test.ts
pnpm --filter @matebot/web check && pnpm --filter @matebot/mobile check
pnpm --filter @matebot/web intl:extract --clean --workers 1
git add -A packages/core apps/web/src apps/web/src/locales apps/mobile/lib
git commit -m "feat(core): one copy key per card status, resolved by each host"
```

---

## Task 4: `surfacePhase` 泛化（AC-13）

**Files:**
- Create: `packages/core/src/surface-phase.ts`
- Create: `packages/core/src/surface-phase.test.ts`
- Modify: `packages/core/src/interaction-template.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces:
  - `function surfacePhase(input: { intent?: string; status?: string; template?: string; lifecycle?: string; capability?: string; busy?: boolean }): { template: SurfaceTemplate; phase: SurfaceTemplate; locked: boolean; settled: boolean; affordance: SurfaceAffordance }`
  - `emailSurfacePhase` 保留原签名，内部委托

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { surfacePhase } from "./surface-phase.js";

describe("surfacePhase", () => {
  // AC-13: mail and calendar answer the same questions the same way.
  it("locks an in-flight card on both intents", () => {
    for (const intent of ["email.compose", "calendar.create"]) {
      expect(surfacePhase({ intent, status: "executing" })).toMatchObject({
        phase: "action-progress-card",
        locked: true,
      });
    }
  });

  it("folds a replaced card on both intents, with nothing to press", () => {
    for (const intent of ["email.compose", "calendar.create"]) {
      const phase = surfacePhase({ intent, status: "superseded" });
      expect(phase).toMatchObject({ phase: "action-superseded-card", settled: true, locked: true });
      expect(phase.affordance).toMatchObject({ action: "none", editable: false });
    }
  });

  it("keeps a waiting mailbox on its connection card", () => {
    expect(surfacePhase({ intent: "email.compose", status: "needs_connection" }).phase).toBe(
      "email-connection-card",
    );
    // A calendar card has no mailbox card to show; it stays an ordinary draft.
    expect(surfacePhase({ intent: "calendar.create", status: "needs_connection" }).phase).toBe(
      "action-draft-card",
    );
  });

  it("keeps a draft editable", () => {
    const phase = surfacePhase({ intent: "calendar.create", status: "ready_for_review" });
    expect(phase).toMatchObject({ locked: false, settled: false });
    expect(phase.affordance).toMatchObject({ editable: true, action: "submit" });
  });

  it("ignores a template string this build does not know", () => {
    expect(surfacePhase({ template: "not-a-template", status: "ready_for_review" }).phase).toBe(
      "action-draft-card",
    );
  });
});
```

- [ ] **Step 2: 实现**

```ts
import type { SurfaceAffordance } from "./surface-affordance.js";
import { surfaceAffordanceFor } from "./surface-affordance.js";
import type { SurfaceTemplate } from "./surface-stamp.js";
import { isSurfaceTemplate, surfaceStampFor } from "./surface-stamp.js";

/**
 * The phase a card is drawn in, and whether its controls are locked.
 *
 * Both hosts used to derive this from the email template alone, which is why a calendar card had
 * no phases at all and a finished calendar card still looked like a form. One function answers
 * for every intent; a host only decides how to draw the answer.
 */
export function surfacePhase(input: {
  intent?: string;
  status?: string;
  template?: string;
  lifecycle?: string;
  capability?: string;
  busy?: boolean;
}): {
  template: SurfaceTemplate;
  phase: SurfaceTemplate;
  locked: boolean;
  settled: boolean;
  affordance: SurfaceAffordance;
} {
  const stamped = input.status ? surfaceStampFor({ status: input.status, intent: input.intent }) : undefined;
  const template =
    (input.template && isSurfaceTemplate(input.template) ? input.template : undefined) ??
    stamped?.template ??
    "action-draft-card";
  const affordance = surfaceAffordanceFor({
    ...(input.status ? { status: input.status } : {}),
    ...(input.lifecycle ? { lifecycle: input.lifecycle } : {}),
    ...(input.capability ? { capability: input.capability } : {}),
  });
  // A submit in flight from this client outranks a stamp that has not arrived yet.
  const phase: SurfaceTemplate =
    input.busy && affordance.action === "submit" ? "action-progress-card" : template;
  const inFlight = phase === "action-progress-card" || phase === "action-submitting-card";
  return {
    template,
    phase,
    locked: inFlight || !affordance.editable,
    settled: affordance.terminal,
    affordance,
  };
}
```

`interaction-template.ts` 的 `emailSurfacePhase` 改为：

```ts
export function emailSurfacePhase(input: {
  template?: EmailSurfaceTemplate;
  lifecycle?: EmailSurfaceLifecycle;
  capability?: EmailSurfaceCapability;
  intent?: string;
  error?: string | null;
  busy?: boolean;
}): ReturnType<typeof surfacePhase> {
  return surfacePhase(input);
}
```

**保留** `EmailSurfaceTemplate` 名（contracts 的既有导出），本批不做跨包重命名——那是 D 批的收敛工作。

- [ ] **Step 3: 跑测试与两端既有用例**

```bash
pnpm vitest run --maxWorkers=1 \
  packages/core/src/surface-phase.test.ts \
  packages/core/src/interaction-surface-phase.test.ts \
  apps/web/src/components/a2ui apps/mobile/lib
pnpm --filter @matebot/core check
git commit -am "feat(core): one phase function for mail and calendar"
```

Expected: 新增全绿。既有 `emailSurfacePhase` 用例若因返回结构变化失败，按新结构改断言并保留原意，不要放宽。

---

## Task 5: 动词与标题形态（AC-15 / AC-18）

**Files:**
- Create: `packages/core/src/surface-action-label.ts`
- Create: `packages/core/src/surface-card-title.ts`
- Create: `packages/core/src/surface-action-label.test.ts`
- Create: `packages/core/src/surface-card-title.test.ts`
- Modify: `packages/core/src/interaction-capability.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces:
  - `type SurfaceCardShape = "review" | "decision"`（在 `interaction-capability.ts` 定义，本批从这里引用）
  - `function surfaceActionLabel(input: { capability: InteractionCapability; title?: string }): string | undefined`
  - `function surfaceCardTitle(input: { capability: InteractionCapability; title?: string }): { category?: string; title: string; shape: SurfaceCardShape }`

- [ ] **Step 1: 注册表加两个字段**

`InteractionCapability` 增：

```ts
  /** Which heading shape a card of this capability uses (§6.4). */
  cardShape: SurfaceCardShape;
  /** The one verb its button may use. Never taken from the model's plan. */
  actionVerb?: SurfaceActionVerb;
```

四条能力分别：`email.compose` → `{ cardShape: "review", actionVerb: "send" }`；`calendar.create` → `{ cardShape: "review", actionVerb: "create" }`；`calendar.query`、`interaction.result` → `{ cardShape: "review" }`（无 action）。

- [ ] **Step 2: 写失败测试**

```ts
describe("surfaceActionLabel", () => {
  it("builds the button from a whitelisted verb and the card's own title", () => {
    const email = interactionCapabilityForIntent("email.compose")!;
    expect(surfaceActionLabel({ capability: email, title: "产品发布" })).toBe("Send 产品发布");
    expect(
      surfaceActionLabel({ capability: interactionCapabilityForIntent("calendar.create")!, title: "11-23 周行程" }),
    ).toBe("Create 11-23 周行程");
  });

  // AC-15: model output is values, never button words. No declared verb means no label.
  it("produces no label without a declared verb", () => {
    const noVerb = { ...interactionCapabilityForIntent("email.compose")!, actionVerb: undefined };
    expect(surfaceActionLabel({ capability: noVerb, title: "x" })).toBeUndefined();
  });

  it("bounds and filters the object", () => {
    const email = interactionCapabilityForIntent("email.compose")!;
    const long = surfaceActionLabel({ capability: email, title: "a".repeat(400) })!;
    expect(long.length).toBeLessThanOrEqual(64);
    // A control character cannot break the label into a second line of instructions.
    expect(surfaceActionLabel({ capability: email, title: "点此领取\u0007\n再说" })).toBe(
      "Send 点此领取 再说",
    );
    // No title: the label falls back to the verb alone rather than inventing an object.
    expect(surfaceActionLabel({ capability: email })).toBe("Send");
  });
});

describe("surfaceCardTitle", () => {
  it("uses a category plus the card's content for a review card", () => {
    expect(
      surfaceCardTitle({
        capability: interactionCapabilityForIntent("email.compose")!,
        title: "产品发布",
      }),
    ).toEqual({ category: "Email", title: "产品发布", shape: "review" });
  });

  it("asks a question for a decision card", () => {
    const email = interactionCapabilityForIntent("email.compose")!;
    const decision = { ...email, cardShape: "decision" as const };
    expect(surfaceCardTitle({ capability: decision, title: "添加 Firecrawl" }).title).toBe(
      "Add Firecrawl?",
    );
  });

  it("falls back to the capability label when no title was given", () => {
    expect(
      surfaceCardTitle({ capability: interactionCapabilityForIntent("calendar.create")! }).title,
    ).toBe("Calendar");
  });
});
```

- [ ] **Step 3: 实现要点**

- `surfaceActionLabel` 只读注册表的 `actionVerb` 与调用方给的 `title`；**不读** plan 的 `action`/`label`/`summary`。
- 对象清洗：`/[\u0000-\u001f\u007f]/g` → 空格、折叠连续空白、trim、上限 48 字符后加 `…`；动词首字母大写。
- `surfaceCardTitle`：`review` 用 `capability.label` 作类别 + 原标题；`decision` 用动词构造问句。
- 两者都是纯函数、无 IO、无 i18n（返回的是「动词 + 对象」的可见文本；动词来自闭合白名单，是产品词而非模型词）。

- [ ] **Step 4: 跑测试与类型检查后提交**

```bash
pnpm vitest run --maxWorkers=1 packages/core/src/surface-action-label.test.ts packages/core/src/surface-card-title.test.ts
pnpm --filter @matebot/core check
git commit -am "feat(core): bound a card's button verb and heading shape"
```

---

## Task 6: `reviveCard`（AC-20）

**Files:**
- Modify: `packages/adapters/src/interaction-kernel-store.ts`
- Create: `packages/adapters/src/interaction-revive.test.ts`
- Create: `packages/adapters/src/interaction-revive.postgres.test.ts`

**Interfaces:**
- Consumes: `canRetryStatus`（Task 2）、`deriveCollectingStatus`（A 批 `interaction-runtime.ts`）
- Produces:
  - `type ReviveResult = { revived: true; status: "collecting" | "ready_for_review"; draftVersion: number } | { revived: false; reason: "not_found" | "not_revivable" | "concurrent" }`
  - `function reviveCard(prisma, input: { interactionId: string }): Promise<ReviveResult>`

- [ ] **Step 1: 写失败测试**

```ts
describe("reviveCard", () => {
  it("revives an expired card with a compare-and-set on the row it read", async () => {
    const { prisma, updateMany } = fake({ status: "expired", draftVersion: 3 });
    await expect(reviveCard(prisma, { interactionId: "i1" })).resolves.toMatchObject({
      revived: true,
      draftVersion: 4,
    });
    expect(updateMany.mock.calls[0]![0].where).toEqual({
      id: "i1",
      status: "expired",
      draftVersion: 3,
    });
  });

  it("refuses every status the kernel does not allow back", async () => {
    for (const status of ["superseded", "cancelled", "sent", "succeeded", "executed", "confirmed", "unknown"]) {
      const { prisma, updateMany } = fake({ status, draftVersion: 1 });
      await expect(reviveCard(prisma, { interactionId: "i1" }), status).resolves.toEqual({
        revived: false,
        reason: "not_revivable",
      });
      expect(updateMany, status).not.toHaveBeenCalled();
    }
  });

  it("reports a lost race instead of overwriting", async () => {
    const { prisma, updateMany } = fake({ status: "failed", draftVersion: 2 });
    updateMany.mockResolvedValue({ count: 0 });
    await expect(reviveCard(prisma, { interactionId: "i1" })).resolves.toEqual({
      revived: false,
      reason: "concurrent",
    });
  });

  it("reports a vanished row", async () => {
    const { prisma } = fake(null);
    await expect(reviveCard(prisma, { interactionId: "gone" })).resolves.toEqual({
      revived: false,
      reason: "not_found",
    });
  });
});
```

- [ ] **Step 2: 实现**

```ts
export type ReviveResult =
  | { revived: true; status: "collecting" | "ready_for_review"; draftVersion: number }
  | { revived: false; reason: "not_found" | "not_revivable" | "concurrent" };

/**
 * Put a card back in the person's hands.
 *
 * `decideSettle` refuses every terminal→open move on purpose: a settled card must not come back
 * to life behind the user's back. A retry is the one case where coming back is the *requested*
 * outcome, so this is its own path with its own whitelist rather than an exception inside the
 * settle rule. `superseded` is out because another card already carries its content,
 * `cancelled` because the person ended it, and `unknown` because the send may already be out.
 */
export async function reviveCard(
  prisma: PrismaClient,
  input: { interactionId: string },
): Promise<ReviveResult> {
  const current = await prisma.interaction.findUnique({
    where: { id: input.interactionId },
    select: { id: true, status: true, draftVersion: true, plan: true, slots: true },
  });
  if (!current) return { revived: false, reason: "not_found" };
  if (!canRetryStatus(current.status)) return { revived: false, reason: "not_revivable" };

  const slots = (current.slots ?? {}) as Record<string, unknown>;
  const status = deriveCollectingStatus(current.plan as InteractionPlan, slots, "collecting");
  const draftVersion = current.draftVersion + 1;
  const written = await prisma.interaction.updateMany({
    where: { id: current.id, status: current.status, draftVersion: current.draftVersion },
    data: { status, draftVersion, confirmedVersion: null, expiresAt: null, staleAt: null },
  });
  if (written.count !== 1) return { revived: false, reason: "concurrent" };
  getLogger().info("interaction.revived", {
    "interaction.id": current.id,
    "interaction.from": current.status,
    "interaction.to": status,
  });
  return { revived: true, status, draftVersion };
}
```

`deriveCollectingStatus` 返回 `InteractionLifecycleStatus`，实现里收窄：结果只可能是 `collecting` 或 `ready_for_review`（传入 `"collecting"`，且该函数在该分支只会返回这两者之一）；用显式判断而不是 `as`：

```ts
const derived = deriveCollectingStatus(current.plan as InteractionPlan, slots, "collecting");
const status = derived === "ready_for_review" ? "ready_for_review" : "collecting";
```

- [ ] **Step 3: 真库用例证明「复活而不是繁殖」**

`interaction-revive.postgres.test.ts`（真库、`describePostgres` 模式与 A 批一致）：

1. `publishOrAmend` 一张邮件卡 → 记 `cardKey`。
2. `settleInteraction` 转 `expired`。
3. `reviveCard` → 断言 `revived: true`、`status` 回到开放态、`draftVersion` 递增。
4. `publishOrAmend` 再发一次 → 断言 `interaction.count({ where: { threadId, cardKey } }) === 1`、消息仍只有一条（AC-20）。
5. 另测 `failed` 卡同样可复活一次，`superseded` 卡被拒。

```bash
DATABASE_URL=... VERIFY_DATABASE=1 pnpm vitest run --maxWorkers=1 packages/adapters/src/interaction-revive.postgres.test.ts
pnpm --filter @matebot/adapters check
git commit -am "feat(adapters): revive an expired or failed card in place"
```

---

## Task 7: 写入路径统一带 stamp（AC-12 数据面）

**Files:**
- Modify: `packages/adapters/src/interaction-publish.ts`（发布、amend 两处 block）
- Modify: `packages/adapters/src/interaction-field-writer.ts`（字段写入、取消两处）
- Modify: `packages/adapters/src/interaction-email-outcome.ts`
- Modify: `packages/adapters/src/interaction-result-publish.ts`
- Modify: `packages/adapters/src/interaction-kernel-guard.test.ts`

- [ ] **Step 1: 先加源码闸门（会失败）**

在 `interaction-kernel-guard.test.ts` 追加：每个 `kind: "a2ui_surface"` 字面量之后，`status` 或展开 stamp 的写法必须出现。

```ts
/**
 * A block written without a status is a card the hosts cannot judge: they fall back to
 * `lifecycle`, which still says `draft` for superseded, expired and cancelled (§4.4 keeps six
 * values there). Every writer must stamp it, so the truth travels with the block.
 */
it("stamps a status on every a2ui_surface block it writes", () => {
  const writers = [
    "packages/adapters/src/interaction-publish.ts",
    "packages/adapters/src/interaction-field-writer.ts",
    "packages/adapters/src/interaction-email-outcome.ts",
    "packages/adapters/src/interaction-result-publish.ts",
  ];
  for (const file of writers) {
    const source = readFileSync(join(ROOT, file), "utf8");
    const blocks = source.split('kind: "a2ui_surface"').slice(1);
    expect(blocks.length, `${file} should build at least one card block`).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block.slice(0, 1600), `${file}: a card block carries no status`).toMatch(
        /\.\.\.(stamp|stamps)|\bstatus:/,
      );
    }
  }
});
```

```bash
pnpm vitest run --maxWorkers=1 packages/adapters/src/interaction-kernel-guard.test.ts
```

Expected: FAIL，指出至少一个写入点。

- [ ] **Step 2: 逐处改造**

统一写法（发布、amend、字段写入、取消、邮件结果、结果卡各一处）：

```ts
// 邮件写入点：stamps 已含 status/lifecycle/template（Task 1 起对所有 intent 都返回）
const stamps = emailSurfaceBlockFields({
  intent: plan.intent,
  capability,
  interactionStatus: interaction.status,
  ...(effectStatus ? { effectStatus } : {}),
});
const block: MessageBlock = {
  kind: "a2ui_surface",
  ...
  ...stamps,
};
```

- **删除**所有 `isEmailPlan(plan) ? emailSurfaceBlockFields(...) : {}` 的判空：Task 1 起它对日历也返回 `action-*` 模板。邮件专属字段（`capability` / `providerMessageId` / `error`）由该函数自己按 intent 决定是否带上。
- 取消路径的 `cancelledBlock` 改用 `interactionStatus: "cancelled"`，得到的模板是 `action-cancelled-card`。
- 结果卡（`interaction-result-publish.ts`）已是 `status: "succeeded"` 终态入场：改用同一函数，删掉手写的 `template: "action-result-success"` / `lifecycle: "succeeded"`，避免第二处真相。

- [ ] **Step 3: 跑全量与真库用例**

```bash
pnpm vitest run --maxWorkers=1 packages/adapters/src/interaction
DATABASE_URL=... VERIFY_DATABASE=1 pnpm vitest run --maxWorkers=1 \
  packages/adapters/src/interaction-lifecycle.postgres.test.ts \
  apps/api/src/interaction-connection-recovery.postgres.test.ts \
  apps/api/src/interaction-discard.postgres.test.ts
pnpm --filter @matebot/adapters check
git commit -am "feat(adapters): stamp the kernel status on every card block"
```

---

## Task 8: Web 卡按 affordance 渲染（AC-12）

**Files:**
- Modify: `apps/web/src/components/a2ui/A2uiSurfaceCard.tsx`
- Modify: `apps/web/src/components/a2ui/EmailComposeEditor.tsx`
- Modify: `apps/web/src/pages/shell/transcript.tsx`
- Modify: `apps/web/src/pages/shell/message-view.tsx`
- Modify: `apps/web/src/components/a2ui/A2uiSurfaceCard.test.tsx`

**Interfaces:**
- Consumes: `surfaceAffordanceFor`、`surfaceStatusCopy`、`surfacePhase`、`surfaceCardTitle`、`surfaceCopy`
- Produces: `A2uiSurfaceCard` 新增 `onRetry?: () => Promise<void>`

- [ ] **Step 1: 写失败测试**

```tsx
it("offers nothing on a replaced card, even when its document holds a button", () => {
  renderCard(fixtureA2uiSurfaceBlock({ status: "superseded", lifecycle: "draft" }));
  expect(container.querySelector('[data-testid="a2ui-email-send"]')).toBeNull();
  expect(container.querySelector('[data-testid="a2ui-surface-host"]')).toBeNull();
  expect(container.textContent).toContain("Replaced by a newer draft");
});

it("offers only Retry on an expired card", () => {
  renderCard(fixtureA2uiSurfaceBlock({ status: "expired", lifecycle: "draft" }), undefined, {
    onRetry: async () => {},
  });
  expect(container.querySelector('[data-testid="a2ui-surface-retry"]')).toBeTruthy();
  expect(container.querySelector('[data-testid="a2ui-email-send"]')).toBeNull();
});

it("shows the category above the card's own title", () => {
  renderCard(fixtureA2uiSurfaceBlock({ title: "产品发布", intent: "email.compose" }));
  const header = container.querySelector('[data-testid="a2ui-surface-header"]')!;
  expect(header.textContent).toContain("Email");
  expect(header.textContent).toContain("产品发布");
});

it("treats a legacy block with no status as the draft it claims to be", () => {
  const { status: _omitted, ...legacy } = fixtureA2uiSurfaceBlock({ lifecycle: "draft" });
  renderCard(legacy as never);
  expect(container.querySelector('[data-testid="a2ui-surface-placeholder"]')).toBeTruthy();
});
```

- [ ] **Step 2: 改造 `A2uiSurfaceCard`**

- 计算 `const affordance = surfaceAffordanceFor({ status: block.status, lifecycle: block.lifecycle, capability: block.capability, reasonKey: block.reasonKey })`。
- `affordance.terminal` → 渲染折叠行：左「`surfaceCopy(surfaceStatusCopy(...).titleKey)`」+ 标题，右仅当 `action === "retry"` 给 `Retry`（`data-testid="a2ui-surface-retry"`，调 `onRetry`，失败时保留原地并可再看一次）；**不渲染** `A2uiSurfaceHost` / `EmailComposeEditor`。
- 非终态：头部改为「类别小标签 + 标题」（`surfaceCardTitle`），`data-testid="a2ui-surface-header"`。
- 现有 `superseded?: boolean` prop 保留一期：`block.status` 缺失时用它（来自 `transcript.tsx` 的链条推断），注释写明「C 批删除」。`transcript.tsx` 改为优先传 `block.status`；`surfaceCardIsLive` 仅在 `status` 缺失时参与。
- `EmailComposeEditor`：删掉按 `phase` 各自猜动作的分支（`phase === "action-result-failed" ? Retry`、`phase === "action-reconcile-card" ? CheckStatus` 等），改为由传入的 `affordance.action` 决定唯一控件。

- [ ] **Step 3: 跑测试、构建、抽 catalog**

```bash
pnpm vitest run --maxWorkers=1 apps/web/src/components/a2ui apps/web/src/pages/shell
pnpm --filter @matebot/web check && pnpm --filter @matebot/web build
pnpm --filter @matebot/web intl:extract --clean --workers 1
git commit -am "feat(web): draw a card from its affordance, and fold it once it is over"
```

---

## Task 9: Mobile 同源（AC-12 三端）

**Files:**
- Modify: `apps/mobile/components/thread/a2ui-native-surface.tsx`
- Modify: `apps/mobile/components/thread/message-bubble.tsx`
- Create: `apps/mobile/lib/a2ui-terminal-card.test.tsx`

**Interfaces:**
- Produces: `A2uiNativeSurface` 新增 `onRetry?: () => Promise<void>`

- [ ] **Step 1: 写失败测试**（沿用 `a2ui-native-surface.test.tsx` 的 react-native stub）

```tsx
// Mobile had no notion of a replaced card: a superseded block still said `lifecycle: draft`,
// so the sheet drew a working Send for a card the server had already replaced.
it("never draws Send on a replaced card", () => {
  render(<A2uiNativeSurface block={{ ...block, status: "superseded" }} />);
  expect(container.querySelector('[data-testid="a2ui-email-send"]')).toBeNull();
  expect(container.textContent).toContain("Replaced by a newer draft");
});

it("offers Retry on an expired card and nothing else", () => {
  const onRetry = vi.fn();
  render(<A2uiNativeSurface block={{ ...block, status: "expired" }} onRetry={onRetry} />);
  const retry = container.querySelector('[data-testid="a2ui-surface-retry"]');
  expect(retry).toBeTruthy();
  fireEvent.click(retry!);
  expect(onRetry).toHaveBeenCalled();
});
```

- [ ] **Step 2: 实现**

- 与 Web 共用 `surfaceAffordanceFor` / `surfaceStatusCopy` / `surfacePhase`；文案经 `apps/mobile/lib/surface-copy.ts`。
- 终态渲染为一行 `<Text>`（状态文案 + 标题），`action === "retry"` 时给一个 `A2uiButton`（`testID="a2ui-surface-retry"`）。
- 删除移动端内部的阶段判断（`phase === "action-result-failed" ? Retry` 等），改读 `surfacePhase(...)` 的 `affordance`。
- `message-bubble.tsx` 接上 `onRetry`（调 `threads/retryInteraction`），与 `onCheckStatus` 同一处接线。

- [ ] **Step 3: 跑测试与类型检查**

```bash
pnpm vitest run --maxWorkers=1 apps/mobile/lib
pnpm --filter @matebot/mobile check
git commit -am "feat(mobile): fold a finished card instead of offering to send it again"
```

---

## Task 10: 重试路由

**Files:**
- Create: `apps/api/src/interaction-retry.ts`
- Create: `apps/api/src/interaction-retry.test.ts`
- Modify: `apps/api/src/routes/threads.ts` + 该路由的 contract 定义（与既有 `confirmInteraction` 同风格）

**Interfaces:**
- Consumes: `reviveCard`（Task 6）、`surfaceStampFor`（Task 1）
- Produces: `retryInteractionService(prisma, { spaceId, threadId, botId, interactionId })` → `{ interactionId, surfaceId, draftVersion, status }`

- [ ] **Step 1: 写失败测试**

```ts
it("revives the row and rewrites the same surface in place", async () => {
  // 断言：一行、一条 message、block 的 status 回到开放态、draftVersion 递增
});
it("answers a conflict when the card moved meanwhile", async () => {
  // reviveCard → { revived: false, reason: "concurrent" } → ORPCError CONFLICT
});
it("refuses a card that may not come back", async () => {
  // superseded → CONFLICT，且不写任何行、不追加事件
});
```

- [ ] **Step 2: 实现**

顺序：`getInteraction` → 校验 `threadId`/`spaceId` → `reviveCard` → 用 `surfaceStampFor({ status: revived.status, intent })` 重建 block → 读现存 blocks 原地替换 → 写回 message → 追加 `thread.message.updated` 与 `thread.surface.updated` 事件（结构照抄 `interaction-field-writer.ts` 的取消路径，不要新造一套）。错误映射：`not_revivable` / `concurrent` → `CONFLICT`，`not_found` → `NOT_FOUND`。

- [ ] **Step 3: 跑测试**

```bash
pnpm vitest run --maxWorkers=1 apps/api/src/interaction-retry.test.ts apps/api/src/interaction-run-action.test.ts
pnpm --filter @matebot/api check
git commit -am "feat(api): let a person retry an expired or failed card"
```

---

## 收尾：B 批验收

- [ ] **Step 1: 跑全量受影响包**

```bash
pnpm vitest run --maxWorkers=1 \
  packages/core/src packages/adapters/src apps/api/src \
  apps/web/src/components/a2ui apps/web/src/pages/shell apps/mobile/lib
pnpm --filter @matebot/core check && pnpm --filter @matebot/adapters check \
  && pnpm --filter @matebot/api check && pnpm --filter @matebot/web check \
  && pnpm --filter @matebot/mobile check
pnpm lint
```

- [ ] **Step 2: 逐条对照验收标准**

| 编号 | 准则 | 由哪个 Task 保证 |
|---|---|---|
| AC-12 | `superseded` 三端不可交互；`expired`/`failed` 有且仅有重试入口 | Task 2（判定）+ Task 7（数据）+ Task 8（Web）+ Task 9（Mobile） |
| AC-13 | 日历与邮件走同一 `surfacePhase` | Task 4 |
| AC-14 | 状态文案只从 `surfaceStatusCopy` 取值 | Task 3（键联合 + 两端函数按同一联合收窄） |
| AC-15 | 按钮对象不可由模型自由提供 | Task 5 |
| AC-18 | 审阅型「类别 + 内容」、决策型问句 | Task 5 + Task 8 |
| AC-20 | `expired` 卡重试复用原 `cardKey`，不产生第二张卡 | Task 6 + Task 10 |
| AC-24 | `reasonKey` 由内核算定，前端与模型均不可覆盖 | Task 2（闭合集合，非白名单丢弃） |
| AC-16 / AC-16b | 历史投影含终态与关键槽位 | **不在本批**（C 批） |

- [ ] **Step 3: 手工验证（三端）**

1. Web：同一线程连点两次「发送」后刷新 → 旧卡折叠为一行、无按钮。
2. Web：真库把某行置为 `expired` → 刷新后卡上只有 `Retry`；点击后**同一张卡**回到草稿态、`draftVersion` 递增、时间线没有第二张卡。
3. Web：真库把某行置为 `cancelled` → 折叠行文案是「Discarded」，不是「Replaced」。
4. Mobile（iOS 模拟器）：同一线程的 `superseded` 卡不再出现 `Send`；`failed` 卡只有 `Retry`。
5. 截图：Web 终态卡、Web 重试后回草稿、Mobile 终态卡各一张，附进 PR。

- [ ] **Step 4: 提交验收记录**

```bash
git commit --allow-empty -m "chore: batch B (card affordance and copy) verified"
```

---

## 实施偏差（落地时确认的决定）

- **block 追加 `status` 快照。** 规格 §4.4 的表把 block `lifecycle` 定为 6 值快照，但 §6.1 的 `surfaceAffordanceFor(status)` 需要 13 值才能区分「被替代」「已过期」「已发出」。因此 block 追加可选 `status`，`lifecycle` 保持 6 值。规格 §4.4 需补一行。
- **`lifecycle` 不加值，因此 `superseded` / `expired` / `cancelled` 的 `lifecycle` 仍是 `draft`。** 这是事实而非遗漏：它们确实没进入提交/执行。真相由 `status` 承载，并由 Task 7 的源码闸门保证每个 block 都带它。**代价**：`blocksToAgentHistoryText` 仍读 `lifecycle`，这三类卡在模型历史里会显示 `→ draft`；修复属 C 批的历史投影（AC-16），本批只记录。
- **`executing` / `submitting` 不写 `status`。** 它们来自运行时生命周期，不在 13 值内（A 批 AC-4 仍开放）。stamp 给进度模板但不伪造内核状态，宿主走旧回退（锁定、无动作）。
- **终态模板不按 intent 分裂。** §6.2 的 `calendar-superseded-card` / `calendar-expired-card` 不实现；终态统一三张（`action-superseded-card` / `action-expired-card` / `action-cancelled-card`）。
- **`reasonKey` 只发有数据源的键。** `effect.amount` 保留、永不发出；团队/用户之分由 `ActionApprovalRule.createdByUserId` 判定，不改规则表。
- **`EmailSurfaceTemplate` 保留原名。** contracts 既有导出名不动；核心内部用 `SurfaceTemplate`。跨包重命名属 D 批。
- **Web 文案用函数而非模块级表。** Lingui 的 `t` 宏在出现位置求值，模块级表会在首次 import 时固定语言。

## 本批不做（明确留给后续批次）

- **C 批**：两段式新消息结算（`staleAt` 真正写入，AC-8b/8c/8d/8e）、过期扫描（AC-19）、`interaction_events` 表、历史投影含终态与关键槽位（AC-16/AC-16b）、连接卡续跑与多账号指名（AC-9/AC-23）、§6.10 同信息去重（AC-21）、`surfaceCardIsLive` 链条的最后删除。
- **D 批**：`cardKind` 注册表扩展、46 处 intent 判断收敛、批准菜单四项、`Bot.draftsDisabled`（AC-17/AC-11）。
- **§6.11 等待阶段文案**（10 分钟「还在登录吗」/ 剩余 5 分钟 / 30 秒「仍在处理」）：需要两个宿主各起计时器，而 `awaiting_approval` 的 `expiresAt` 目前**不被确认路径写入**，倒计时没有数据源。等 C 批补齐 `expiresAt` 后单独做。
- **§6.12 卡加载失败降级为纯文本**（AC-22）：现有渲染已是「说明 + 重试」而非空壳，改造属呈现层重构，不在 B 的语言范围。
- **`expiresAt` 的确认路径写入与 AC-4 词表收敛**：与 A 批一致，需一个能安全处理发信中途崩溃的方案。
