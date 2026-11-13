# 交互卡内核（D 批：收敛）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Do **not** use subagent-driven-development or any other-model Task/review/fallback: parent instruction t317 requires Grok 4.6 only. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 动作卡与结果卡在注册表里分型；邮件/日历 intent 判断只读注册表；卡片批准菜单对标 Grok 四项；Bot 可关闭草稿且仍受批准规则约束。

**Architecture:** Spec §8 D is four deliverables on the A/B/C kernel: (1) `cardKind` `action` vs `result` on the capability registry; (2) converge scattered intent-string checks onto that registry plus aliases (`email.send` → `email.compose`, `calendar.compose` → `calendar.create`); (3) four-item card approval menu (Allow this recipient / Needs approval ✓ / Turn off drafts for this bot / Manage rules) on web and mobile, via account RPCs, never thread messages; (4) `Bot.draftsDisabled` last — skip the **draft** card for action intents, still run `ActionApprovalRule`, bot-scoped, audited. Presentation stays the production A2UI surface, not a detached demo.

**Tech Stack:** TypeScript, Prisma 7.10.1 (PostgreSQL), Vitest, Lingui (web), locale tables (mobile), pnpm workspace

---

## C 批遗留验收清单（t317：记下 C 缺项，开始 D；缺项不是通过）

t317 (2026-11-14 07:07 Asia/Shanghai) overrides the old “D only after C fully accepted” gate **only** to let D start with leftovers recorded. Leftovers stay **not passing**.

### 代码完成、现场未验

| 项 | 状态 | 证据边界 | 不得用什么代替 |
|---|---|---|---|
| C Tasks（两段式结算、连接续跑、事件表、历史槽位、AC-19 closer） | 代码在 `fix/tooling-defects-a2ui-presentation` | 实现提交至 `af85e22573e59f13291053c2b5c0870f9c976cb4` | — |
| 整组相关回归 | **未**在 head `af85e2257` 重跑此前完整相关整组 | C 过程中跑过子集；glob 曾误打到非隔离 `*.postgres.test.ts` | 新 D head 必须自己重跑完整相关整组 |
| 隔离 PG（retry/revive/stale/expire 等） | C 对 `matebot_b_accept` 跑过 50/50 | **仅**当时 head | 新 D head 必须自己重跑 |
| C 浏览器自动过期 | Chromium → 人工把 `expiresAt` 设到过去 → 调用生产 `expireDueInteractions` closer → 卡折叠 Retry | **不是** delayed job 到点触发，**不是** 30 分钟墙钟 | 不得标 AC-19 现场通过 |
| 真实 30 分钟墙钟 + `interaction.expire` 队列到点触发 | **未验** | — | closer 直调 ≠ 队列到点 |
| iOS 模拟器/真机终态卡 | **未验**（B 遗留） | 本环境无 iOS | Web/mobile 单测与 stub **不得**冒充 |
| 真实连点两次发送后刷新 / 单次外部执行 | **未验**（真实发信暂停） | — | 隔离 PG 幂等测试不是现场发信 |
| 真实模型/provider 回合 | **暂停** | t317 维持 | D 不得恢复 |
| 外部业务写 | **暂停** | t317 维持 | D 不得恢复；不得访问 `.5` / 用户业务库 |

### 本批仍不得宣称 C / B 通过的项

- 真实 30 分钟墙钟；delayed job 到点触发（C）。
- head `af85e2257` 完整相关整组回归（C）。
- iOS 模拟器/真机终态（B）。
- 真实连点两次发送后刷新、单次外部执行（B）。
- 真实模型/provider 回合与外部写（仍暂停）。

t317 允许带这些缺项推进 D。D 验证阶段**可以**在隔离库补跑完整相关整组，以及隔离环境下的 `interaction.expire` **job handler** 路径（不是墙钟、不是真实业务写）。不得借此把前批标成通过。

D 完成后停等父端核验。**不启动 E。**

---

## 范围：以权威规格为准

规格 `docs/superpowers/specs/2026-11-13-interaction-card-kernel-design.md` §8 D 行原文：

> **D 收敛** | 注册表 `cardKind` + 46 处 intent 判断收敛 + 批准菜单四项 + `Bot.draftsDisabled`

对应 AC / 目标：

| 编号 | 出处 | 本批如何验收 |
|---|---|---|
| AC-11 | §9 / §5.6 / §5.7 | 新增一种卡种改动 ≤3 文件；以 `interaction.result` 为参照的清单检查（**不**用死条目 `calendar.query` 当参照） |
| AC-17 | §9 / §6.6 | 批准菜单四项齐全；「允许收件人」不跳过本卡发送 |
| G4 | §3.1 | intent 判断从散落字符串收敛到注册表一处读取 |
| G9 | §3.1 | 四项能力：允许收件人 / 需要批准 / 为此 Bot 关闭草稿 / 管理规则 |
| §5.6 | L2 | `cardKind`: `action`（`email.compose`、`calendar.create`，唯一约束适用）vs `result`（`interaction.result`，终态入场，唯一约束不适用） |
| §5.7 | L2 | 凡「判断这是不是日历/邮件」的改为查注册表 |
| §5.4.1 | L2 | `Bot.draftsDisabled` 最后做；跳过**草稿卡**；仍走 `ActionApprovalRule`；只影响该 Bot；变更写 `approval.policy.changed` |
| §6.6 | L3 | 菜单是账户 RPC，不产生线程消息、不进入 §5.4 结算；手机端同一套四项 |

别名（实施时在注册表模块一处）：`email.send` → `email.compose`，`calendar.compose` → `calendar.create`。

`calendar.query`：**保留**为 `result`。规格写明它目前无发布路径、AC-11 参照物是 `interaction.result`；本批不删死条目（删条目会扩大无关回归）。

### 候选范围：明确不做

| 候选 | 为何不做 |
|---|---|
| E：`choice` / `ask` / `connect` 接入内核；Slack Allow once/Skip | §8 E |
| F catalog / 协议族收敛 | §8 F |
| AC-21 同信息去重 | §8 D 未列 |
| AC-4 `executing`、确认路径 `expiresAt`、真实发信 | 暂停 |
| 付费机制重构 | t317 排除 |
| 删除 `calendar.query` | 规格留给实施决定；本批保留以免扩大范围 |
| 跨包重命名 `EmailSurfaceTemplate` | B 计划曾点名 D；§8 D 未列，不做 |

**批内顺序（规格 §8）：** `cardKind` + intent 收敛必须先于菜单（菜单要知道这是动作卡）；`Bot.draftsDisabled` **最后**，单独做。

---

## Global Constraints

- Node 22+ 与 pnpm 9 在 PATH 上。
- 测试从仓库根跑，**必须** `--maxWorkers=1`：
  ```bash
  pnpm vitest run --maxWorkers=1 packages/core/src/<file>.test.ts
  ```
- 类型检查：`pnpm --filter @matebot/{core,adapters,db,contracts,api,web,mobile} check`。
- 真库：`VERIFY_DATABASE=1 COPY_TEST_DATABASE=1`，owner + `matebot_app` RLS。只许隔离测试库与测试身份。禁止 `.5` / 用户业务数据。
- 13 值词表与开放态 3 值、结算豁免 2 值不动。
- 唯一约束已覆盖 OPEN_STATUSES；`result` 卡终态入场所以不撞索引。`cardKind` 文档化该政策，不改索引。
- 新列可加；删除列必须 `-- deferred`。本批只加 `bots.draftsDisabled`。
- 菜单 RPC 必须是 `approvalRules.set` / `bots.update`，禁止 `threads.send` / 新用户消息（会触发两段式结算）。
- 「允许收件人」只对**后续**发信生效；本卡 Send 仍在。
- `draftsDisabled` 不放宽批准：`deny` 仍拒绝；`require_approval` 仍出确认卡；仅 `allow`（含收件人 always_allow / skipApprovals / 无规则默认 allow）才跳过草稿并走既有执行器。
- `needs_connection` 不是草稿卡：关闭草稿仍出连接卡。
- 宿主文案：web Lingui 函数内求值；mobile `lib/locales`。本批新增英文原文必须出现在 PR `## What`：
  - `Allow this recipient`
  - `Turn off drafts for this bot`
  - `Restore drafts`
  - 已有 `Needs approval` / `Manage rules` 不改
- 真实发信、外部业务写、真实模型测试保持暂停。执行路径只用隔离库、测试身份、受控 provider 替身。
- 提交英文，前缀 `feat:` / `fix:` / `test:` / `chore:`。每 Task 结束 commit。不改 `CHANGELOG.md`。
- 不改 main、不合并、不关 PR、不删分支、不发布、不部署。
- Review / 子任务 / fallback **仅 Grok 4.6**；不可用即停报。

---

## 文件结构

**新建**

| 文件 | 职责 |
|---|---|
| `packages/db/prisma/migrations/20261128120000_bot_drafts_disabled/migration.sql` | `bots.draftsDisabled BOOLEAN NOT NULL DEFAULT false` |
| `apps/web/src/components/a2ui/CardApprovalMenu.tsx` | 四项批准菜单（web） |
| `packages/adapters/src/interaction-draft-policy.ts` | `shouldSkipDraftCard`：draftsDisabled × cardKind × 批准判定 |
| `packages/adapters/src/interaction-draft-policy.test.ts` | 跳过草稿 / 不放宽批准 / 不影响其他 Bot |

**修改（要点）**

| 文件 | 改动 |
|---|---|
| `packages/core/src/interaction-capability.ts` | `cardKind`；别名；`canonicalIntent` / `cardKindForIntent` / `isActionIntent` / `isEmailComposeIntent` / `isCalendarCreateIntent` |
| `packages/core/src/interaction-connection.ts` | `interactionRequiredApp` 读注册表 |
| `packages/core/src/interaction-template.ts` | `isEmailSurfaceIntent` 改走 `isEmailComposeIntent` |
| `packages/core/src/surface-stamp.ts` | 去掉本地 `isEmailIntent` 字符串对 |
| `packages/core/src/surface-affordances.ts` | `FORM_INTENTS` 改为 `isActionIntent` |
| `packages/core/src/action-approval.ts` | `matchKind: "recipient"` |
| `packages/contracts/src/domain.ts` | `Bot.draftsDisabled`；`UpdateBotInput.draftsDisabled`；`ActionApprovalRuleSchema.matchKind` 加 `recipient` |
| `packages/contracts/src/rpc.ts` | `approvalRules.set.matchKind` 加 `recipient` |
| `packages/db/prisma/schema.prisma` | `Bot.draftsDisabled` |
| `packages/db/src/repos.ts` | DTO 映射 |
| `apps/api/src/routes/bots.ts` | `bots.update` 写列；`draftsDisabled` 变更记 `approval.policy.changed` |
| `apps/api/src/routes/account.ts` | 已有 set 处理器；靠 schema 放行 `recipient` |
| `packages/adapters/src/interaction-publish.ts` | 动作型且 skip-draft 时不建开放卡 |
| `packages/adapters/src/run-tools-interaction.ts` | 关闭草稿且批准 allow 时走既有执行器（替身，不发真信） |
| `apps/web/src/components/a2ui/EmailComposeEditor.tsx` | 使用共享菜单 |
| `apps/web/src/components/a2ui/A2uiSurfaceCard.tsx` | 日历动作卡同样挂菜单（无收件人项） |
| `apps/web/src/pages/shell/message-view.tsx` | `onAllowRecipient` / `onDisableDrafts` 走 RPC |
| `apps/mobile/components/thread/a2ui-native-surface.tsx` | 四项 |
| `apps/mobile/lib/locales/{zh,zh-TW,de,nl,ja,es,ru}.ts` | 新文案 |

---

## Task 1：注册表 `cardKind` + 别名（§5.6，AC-11 前置）

生产接线：`INTERACTION_CAPABILITIES` 是 intent 的唯一权威。`publishOrAmend` / 宿主 / 连接判断之后都读这里。

- [ ] **Step 1: 写失败测试** `packages/core/src/interaction-capability.test.ts`

```ts
it("classifies action vs result card kinds", () => {
  expect(cardKindForIntent("email.compose")).toBe("action");
  expect(cardKindForIntent("email.send")).toBe("action");
  expect(cardKindForIntent("calendar.create")).toBe("action");
  expect(cardKindForIntent("calendar.compose")).toBe("action");
  expect(cardKindForIntent("interaction.result")).toBe("result");
  expect(cardKindForIntent("calendar.query")).toBe("result");
  expect(cardKindForIntent("github.clone")).toBeUndefined();
});

it("canonicalizes aliases onto registered intents", () => {
  expect(canonicalIntent("email.send")).toBe("email.compose");
  expect(canonicalIntent("calendar.compose")).toBe("calendar.create");
  expect(findInteractionCapability(canonicalIntent("email.send"))?.intent).toBe("email.compose");
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm vitest run --maxWorkers=1 packages/core/src/interaction-capability.test.ts
```

Expected: FAIL — `cardKindForIntent` / `canonicalIntent` 未导出。

- [ ] **Step 3: 最小实现**

在 `InteractionCapability` 上加 `cardKind: "action" | "result"`。

- `email.compose`、`calendar.create` → `action`
- `interaction.result`、`calendar.query` → `result`

```ts
export const INTENT_ALIASES: Readonly<Record<string, string>> = {
  "email.send": "email.compose",
  "calendar.compose": "calendar.create",
};

export function canonicalIntent(intent: string): string {
  return INTENT_ALIASES[intent] ?? intent;
}

export function cardKindForIntent(intent: string): CardKind | undefined {
  return findInteractionCapability(canonicalIntent(intent))?.cardKind;
}

export function isActionIntent(intent: string | undefined): boolean {
  return Boolean(intent) && cardKindForIntent(intent) === "action";
}

export function isEmailComposeIntent(intent: string | undefined): boolean {
  return Boolean(intent) && canonicalIntent(intent) === "email.compose";
}

export function isCalendarCreateIntent(intent: string | undefined): boolean {
  return Boolean(intent) && canonicalIntent(intent) === "calendar.create";
}
```

`findInteractionCapability` 继续按**注册名**查找（不自动解别名），避免把别名当成第二种卡。调用方先 `canonicalIntent`。`interactionRequiredApp` 改为读 `capability.requiresConnection`（经 canonical）。

保持内部一致：`cardKind === "action"` 当且仅当 `schema.presentation === "form"` 且有 `action`；`result` 当且仅当 `presentation === "result"` 且 `action === null`。

- [ ] **Step 4: 跑测试通过并 commit**

```bash
pnpm vitest run --maxWorkers=1 packages/core/src/interaction-capability.test.ts packages/core/src/interaction-connection.test.ts
git add packages/core/src/interaction-capability.ts packages/core/src/interaction-capability.test.ts packages/core/src/interaction-connection.ts packages/core/src/interaction-connection.test.ts
git commit -m "$(cat <<'EOF'
feat(core): classify interaction card kinds and canonicalize intent aliases

Action vs result lives on the capability registry so unique-index policy
and hosts stop guessing from intent string literals.
EOF
)"
```

---

## Task 2：收敛 intent 字符串判断（G4 / §5.7 / AC-11）

生产接线：邮件/日历/表单判断全部经 Task 1 助手。新增一种 `action` 卡种：注册表一项 + 至多两个伴随文件（schema/effect 或测试），由扫描测试锁住。

- [ ] **Step 1: 写失败测试**

1. `packages/core/src/interaction-template.test.ts`：`isEmailSurfaceIntent("email.send")` 仍真，但实现不得再写 `=== "email.send"`（改走 `isEmailComposeIntent`）。
2. `packages/core/src/surface-affordances.test.ts`：`needsRecovery` 对 `calendar.compose` 仍当表单；对 `interaction.result` 仍不当。
3. `packages/core/src/interaction-capability.test.ts` **AC-11 清单**：

```ts
it("does not special-case product intents outside the registry module", () => {
  // Scan packages/core, packages/adapters, apps/api, apps/web/src, apps/mobile
  // for /"(email\.compose|email\.send|calendar\.create|calendar\.compose|calendar\.query|interaction\.result)"/
  // Allowlist: interaction-capability.ts (definitions + aliases) and tests.
  // Fail if a production file keeps its own intent-literal set.
});
```

允许名单必须短：注册表、编译器 schema 对照、以及**测试**。生产路径里的 `normalizeEmailComposePlan` 等改为 `isEmailComposeIntent`。

Web `email-fields.ts` / mobile `a2ui-catalog.ts` 的 `isEmailComposeIntent` **删除本地副本**，改从 `@matebot/core` 导入（两端一致性）。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm vitest run --maxWorkers=1 packages/core/src/interaction-capability.test.ts packages/core/src/surface-affordances.test.ts
```

Expected: FAIL — 扫描仍看到多处字面量集合（`FORM_INTENTS`、`isEmailSurfaceIntent` 内联对、`interactionRequiredApp` 内联对、`surface-stamp` `isEmailIntent`、web/mobile 本地 `isEmailComposeIntent`）。

- [ ] **Step 3: 最小实现**

替换这些生产判断（不得留下第二份 intent 集合）：

| 位置 | 改为 |
|---|---|
| `interaction-template.ts` `isEmailSurfaceIntent` | `isEmailComposeIntent` |
| `surface-stamp.ts` `isEmailIntent` | `isEmailComposeIntent` |
| `surface-affordances.ts` `FORM_INTENTS` | `isActionIntent` |
| `interaction-connection.ts` | 已在 Task 1 |
| `run-tools-interaction.ts` `normalizeEmailComposePlan` | `isEmailComposeIntent` |
| `apps/web/.../email-fields.ts` | 删除本地函数，re-export 或改 import |
| `apps/mobile/lib/a2ui-catalog.ts` | 同上 |
| `EmailComposeEditor` / `A2uiSurfaceCard` 若仍比字面量 | `isEmailComposeIntent` |

不要为收敛而重命名 contracts 导出。

- [ ] **Step 4: 跑测试通过并 commit**

```bash
pnpm vitest run --maxWorkers=1 \
  packages/core/src/interaction-capability.test.ts \
  packages/core/src/interaction-template.test.ts \
  packages/core/src/surface-affordances.test.ts \
  packages/core/src/surface-stamp.test.ts \
  packages/core/src/interaction-connection.test.ts \
  apps/web/src/components/a2ui/A2uiSurfaceCard.test.tsx \
  apps/mobile/lib/a2ui-native-surface.test.tsx \
  apps/mobile/lib/a2ui-catalog.test.ts
git add packages/core packages/adapters apps/web/src/components/a2ui apps/mobile
git commit -m "$(cat <<'EOF'
feat(core): read email and calendar intents from the capability registry

Hosts and publishers stop keeping their own intent-literal sets so a new
action card kind is a registry change, not a 46-site hunt.
EOF
)"
```

---

## Task 3：批准菜单四项 + 收件人规则（AC-17 / G9 / §6.6）

生产接线：

- Web：`CardApprovalMenu` ← `EmailComposeEditor` StatusLine；日历动作卡从 `A2uiSurfaceCard` 挂同一菜单（无收件人项）。
- Shell：`onAllowRecipient` → `rpc.account.approvalRules.set({ effect: "always_allow", matchKind: "recipient", matchValue })`；`onManageRules` 仍 `openSettings("confirmations")`。
- Mobile：`a2ui-native-surface` 同样四项，文案走 locale。
- **禁止**往线程发消息。

文案（web Lingui / mobile 英文 key）：

| 项 | 英文 | 行为 |
|---|---|---|
| 允许收件人 | `Allow this recipient` | 仅当 `to` 非空；RPC set；**不**调用 confirm/send |
| 需要批准 ✓ | `Needs approval` | disabled，当前态 |
| 关闭草稿 | `Turn off drafts for this bot` | Task 4 才接 `bots.update`；本 Task 先挂回调，测试断言点击不发信 |
| 管理规则 | `Manage rules` | 已有 |

`draftsDisabled === true` 时第三项换成 `Restore drafts`。本 Task 菜单可以先渲染该项；持久化在 Task 4。

- [ ] **Step 1: 写失败测试**

`packages/core/src/action-approval.test.ts`：

```ts
it("always-allow recipient matches that mailbox only", () => {
  const rules = [{ effect: "always_allow" as const, matchKind: "recipient" as const, matchValue: "alex@example.test" }];
  expect(resolveActionApprovalDetail({
    toolName: "gmail_send_email",
    recipient: "Alex@example.test",
    rules,
  }).decision).toBe("allow");
  expect(resolveActionApprovalDetail({
    toolName: "gmail_send_email",
    recipient: "other@example.test",
    rules,
  }).source).not.toBe("always_allow");
});
```

`apps/web/src/components/a2ui/A2uiSurfaceCard.test.tsx`：

```ts
it("shows four approval items and Allow this recipient does not send", async () => {
  const onAllowRecipient = vi.fn(async () => undefined);
  const onSend = vi.fn(async () => undefined);
  const onDisableDrafts = vi.fn(async () => undefined);
  // render ready email card with to=alex@example.test
  // open [data-testid="a2ui-email-status"]
  expect(document.querySelector('[data-testid="a2ui-email-allow-recipient"]')?.textContent).toMatch(/Allow this recipient/);
  expect(document.querySelector('[data-testid="a2ui-email-approval-require"]')).toBeTruthy();
  expect(document.querySelector('[data-testid="a2ui-email-disable-drafts"]')?.textContent).toMatch(/Turn off drafts for this bot/);
  expect(document.querySelector('[data-testid="a2ui-email-manage-rules"]')).toBeTruthy();
  await click allow-recipient;
  expect(onAllowRecipient).toHaveBeenCalledWith("alex@example.test");
  expect(onSend).not.toHaveBeenCalled();
  expect(container.querySelector('[data-testid="a2ui-email-send"]')).toBeTruthy();
});
```

`apps/mobile/lib/a2ui-native-surface.test.tsx`：同样四项；Allow 不触发 send。

Contracts：`ActionApprovalRuleSchema` / RPC `matchKind` 接受 `"recipient"`。`packages/db/src/approval-settings.test.ts`（若有 postgres 变体则隔离 PG）：set recipient 规则可持久化。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm vitest run --maxWorkers=1 \
  packages/core/src/action-approval.test.ts \
  apps/web/src/components/a2ui/A2uiSurfaceCard.test.tsx \
  apps/mobile/lib/a2ui-native-surface.test.tsx
```

Expected: FAIL — 菜单仍两项；`recipient` 不匹配。

- [ ] **Step 3: 最小实现**

1. `ActionApprovalRuleSchema.matchKind` 与 RPC enum 加 `"recipient"`（contracts 输出 schema 已有 `category`；RPC 输入仍不开放 `category`）。
2. `ruleMatches` / `ruleSpecificity`：`recipient` 特异性介于 `site` 与 `tool` 之间（5 或与 tool 同级 3 亦可，但必须按邮箱精确匹配）。给 `resolveActionApprovalDetail` 增加可选 `recipient?: string`。
3. 抽出 `CardApprovalMenu`。Email 卡四项；无 `to` 时隐藏 Allow。日历动作卡三项（无 Allow）。
4. Shell 接线 `approvalRules.set`。点击 Allow **只** set 规则。
5. Mobile 四项 + 七份 locale。`apps/mobile/lib/i18n.test.ts` 会扫到新 key，必须填齐。

- [ ] **Step 4: 跑测试通过并 commit**

```bash
pnpm vitest run --maxWorkers=1 \
  packages/core/src/action-approval.test.ts \
  packages/contracts/src/interaction.test.ts \
  apps/web/src/components/a2ui/A2uiSurfaceCard.test.tsx \
  apps/mobile/lib/a2ui-native-surface.test.tsx \
  apps/mobile/lib/i18n.test.ts
git add packages/core packages/contracts packages/db apps/api apps/web apps/mobile
git commit -m "$(cat <<'EOF'
feat(ui): add the four-item card approval menu and recipient allow rules

Allow this recipient persists via the account RPC and leaves this card's
Send in place. The menu never posts a thread message.
EOF
)"
```

---

## Task 4：`Bot.draftsDisabled`（§5.4.1，最后，风险最高）

生产接线：

1. 列默认 `false`。
2. `bots.update({ draftsDisabled })`；DTO 读出。
3. 仅当 `draftsDisabled` 实际变化时写 `approval.policy.changed`（不要把每次改名都记成批准策略）。
4. `present_interaction` → `shouldSkipDraftCard`：
   - 非动作 intent：不跳
   - `needs_connection`：不跳（仍出连接卡）
   - 批准 `deny`：不建草稿，返回拒绝
   - 批准 `ask` / `require_approval`：仍出确认卡（不放宽批准）
   - 批准 `allow`：不建开放草稿卡；走既有 `executeConfirmedInteractionService` / 适配器执行器，**connector 替身**，断言无真实 SMTP/外部写
5. 「Turn off drafts」→ `bots.update({ draftsDisabled: true })`；「Restore drafts」→ `false`。只影响该 `botId`。
6. 菜单回调不得调用 send。

- [ ] **Step 1: 写失败测试**

`packages/adapters/src/interaction-draft-policy.test.ts`：

```ts
it("skips an action draft when drafts are disabled and approval allows", () => {
  expect(shouldSkipDraftCard({
    draftsDisabled: true,
    intent: "email.compose",
    approval: "allow",
    status: "collecting",
  })).toBe(true);
});

it("does not skip when approval is required or denied", () => {
  expect(shouldSkipDraftCard({ draftsDisabled: true, intent: "email.compose", approval: "ask" })).toBe(false);
  expect(shouldSkipDraftCard({ draftsDisabled: true, intent: "email.compose", approval: "deny" })).toBe(false);
});

it("does not skip result cards or connection cards", () => {
  expect(shouldSkipDraftCard({ draftsDisabled: true, intent: "interaction.result", approval: "allow" })).toBe(false);
  expect(shouldSkipDraftCard({ draftsDisabled: true, intent: "email.compose", approval: "allow", status: "needs_connection" })).toBe(false);
});
```

`packages/adapters/src/interaction-publish-amend.test.ts`：`draftsDisabled: true` + allow 时 `createInteraction` 不被调用。

`apps/api/src/router.test.ts`：`bots/update` 接受 `draftsDisabled`。

隔离 PG（`VERIFY_DATABASE=1 COPY_TEST_DATABASE=1`，`matebot_b_accept`）：

- 打开 Bot A 的草稿开关后，A 的 `present` 不留开放动作卡；同空间 Bot B 仍出卡。
- `approvalRules.set` recipient 后本卡 Send 仍在（Task 3 的持久化在此用 API 再锁一次）。
- `draftsDisabled` 变更写入 `security_events` type `approval.policy.changed`。

Web DOM：点击 `a2ui-email-disable-drafts` 调用 `onDisableDrafts` 且 `onSend` 为 0。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm vitest run --maxWorkers=1 packages/adapters/src/interaction-draft-policy.test.ts
```

Expected: FAIL — 模块不存在。

- [ ] **Step 3: 最小实现**

迁移：

```sql
ALTER TABLE "bots" ADD COLUMN "draftsDisabled" BOOLEAN NOT NULL DEFAULT false;
```

Prisma `Bot.draftsDisabled`、contracts、repos DTO、`routes/bots.ts` `data.draftsDisabled`。

`shouldSkipDraftCard` 纯函数。`publishOrAmend` 增加可选 `draftsDisabled`；为 true 且 skip 时返回 `{ skipped: true, reason: "drafts_disabled" }` 且不 insert。

`run-tools-interaction`：skip 且 allow 时调用既有执行入口（看 `executeConfirmedInteractionService` 是否需要先行内部确认）。**禁止**新建 SMTP 发送器。无 connector 时仍走 `needs_connection`。deny 时工具结果为拒绝文案。

菜单：`draftsDisabled` 从 bot 记录传入卡（Shell 已有 bot）。Mobile 同样。

审计：在 `bots.update` 里当 `input.draftsDisabled !== undefined && input.draftsDisabled !== existing.draftsDisabled` 时 `recordSecurityEvent({ type: "approval.policy.changed", metadata: { procedure: "bots.update", kind: "drafts_disabled" } })`。不要把整个 `bots.update` 加进 `AUDITED_PROCEDURES`（会把改名也记成批准）。

- [ ] **Step 4: 跑测试通过并 commit**

```bash
pnpm vitest run --maxWorkers=1 \
  packages/adapters/src/interaction-draft-policy.test.ts \
  packages/adapters/src/interaction-publish-amend.test.ts \
  packages/adapters/src/run-tools-interaction.test.ts \
  apps/api/src/router.test.ts \
  apps/web/src/components/a2ui/A2uiSurfaceCard.test.tsx \
  apps/mobile/lib/a2ui-native-surface.test.tsx
git add packages/db packages/contracts packages/adapters packages/core apps/api apps/web apps/mobile
git commit -m "$(cat <<'EOF'
feat(bots): skip action drafts when draftsDisabled and approval still allows

The flag is bot-scoped, audited, and does not relax deny or require-approval
rules. Isolated tests execute through the existing emulator, not a live mailbox.
EOF
)"
```

---

## Task 5：同模型审查 + 两端一致性 + 隔离补齐 C 队列路径

不是新功能。Grok 4.6 亲自审 Task 1–4（不可委派其他模型）。核对：

- 菜单偏好持久化（recipient 规则、`draftsDisabled`）走 RPC，不走线程消息。
- 多轮同卡：Allow recipient 后同一 `cardKey` 仍开放、Send 仍在。
- Web 与 mobile 四项文案与 testID 对齐。
- `draftsDisabled` 不跳过 `needs_connection`、不放宽 deny/ask。
- AC-11 扫描仍绿。

**可选 C 补齐（隔离，不标 C 通过）：** 给 `createBackgroundJobHandlers` 的 `"interaction.expire"` 加隔离测试：插入到期行 → 调 handler（不是 `expireDueInteractions` closer）→ 行变 `expired` 且块盖 stamp。这证明 **job 函数**被 handler 调用；仍不是 30 分钟墙钟，也不是真实队列进程到点。

审查发现实现错误则修并 **整组相关测试重跑**（不只失败文件）。

- [ ] **Step 1: 审查清单**（写在本 Task 的 commit 说明或保持工作区干净：无审查文件则不 commit 空提交）
- [ ] **Step 2: 若有修复，整组重跑后再 commit**

```bash
pnpm vitest run --maxWorkers=1 packages/adapters/src/background-job-handlers.ts
# 若无现成测试，新增 packages/adapters/src/interaction-expire-job.test.ts（假 Prisma 即可）
```

---

## Task 6：最终 head 验证（整组、类型、lint、隔离 PG、真实 Web/API 浏览器）

在**最终 D head**上跑，修复后必须整组重跑，不只失败文件。

### 相关整组回归（必须）

```bash
pnpm vitest run --maxWorkers=1 \
  packages/core/src/interaction-capability.test.ts \
  packages/core/src/interaction-connection.test.ts \
  packages/core/src/interaction-template.test.ts \
  packages/core/src/surface-affordances.test.ts \
  packages/core/src/surface-stamp.test.ts \
  packages/core/src/surface-phase.test.ts \
  packages/core/src/surface-affordances.test.ts \
  packages/core/src/action-approval.test.ts \
  packages/core/src/attachments.test.ts \
  packages/core/src/a2ui-orchestration-regression.test.ts \
  packages/adapters/src/interaction-publish.test.ts \
  packages/adapters/src/interaction-publish-amend.test.ts \
  packages/adapters/src/interaction-draft-policy.test.ts \
  packages/adapters/src/interaction-stale.test.ts \
  packages/adapters/src/interaction-expire.test.ts \
  packages/adapters/src/run-tools-interaction.test.ts \
  packages/adapters/src/run-tools-interaction-amend.test.ts \
  packages/adapters/src/run-tools-interaction-edit.test.ts \
  packages/adapters/src/run-tools-interaction-cancel.test.ts \
  apps/api/src/interaction-service.test.ts \
  apps/api/src/interaction-retry.test.ts \
  apps/api/src/interaction-resume.test.ts \
  apps/web/src/components/a2ui/A2uiSurfaceCard.test.tsx \
  apps/mobile/lib/a2ui-native-surface.test.tsx \
  apps/mobile/lib/a2ui-terminal-card.test.tsx \
  apps/mobile/lib/a2ui-catalog.test.ts \
  apps/mobile/lib/i18n.test.ts
```

（实施时把本批实际新增的测试文件并入；不要漏。）

### 类型 / lint

```bash
pnpm --filter @matebot/core --filter @matebot/adapters --filter @matebot/db --filter @matebot/contracts --filter @matebot/api --filter @matebot/web --filter @matebot/mobile check
pnpm lint
```

### 隔离 PG

```bash
VERIFY_DATABASE=1 COPY_TEST_DATABASE=1 DATABASE_URL='postgresql://matebot_b_runtime@127.0.0.1:5432/matebot_b_accept' \
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
```

（若 Task 4 新增 `*.postgres.test.ts`，列入。环境以本机隔离库为准；不得指向用户业务库。）

### Live Web / API / PG 浏览器关键路径

`apps/api/e2e-a2ui.mjs` 与 `apps/web/e2e/a2ui-live.spec.ts`：至少

1. 打开草稿卡 → 打开批准菜单 → 四项可见。
2. Allow this recipient → 规则行出现 → **Send 仍在**（不点真实发送）。
3. 既有 retry / auto-expiry closer 路径仍绿（C 浏览器路径，不冒充队列到点）。

截图保存到 `/opt/cursor/artifacts/`（菜单四项、Allow 后 Send 仍在）。Mobile stub / web 截图 **不称原生 iOS**。

真实发信、真实模型回合：**skip**，在报告里写明命令与 skip 原因。

---

## Task / AC 矩阵

| Task | AC / 规格 | 生产接线 |
|---|---|---|
| 1 `cardKind` + 别名 | §5.6、AC-11 前置、G4 | `INTERACTION_CAPABILITIES` |
| 2 intent 收敛 | §5.7、AC-11、G4 | 宿主/发布/连接读助手 |
| 3 四项菜单 + recipient | AC-17、G9、§6.6 | `approvalRules.set` + 两端菜单 |
| 4 `draftsDisabled` | §5.4.1、G9、风险表 | `bots.update` + `publishOrAmend` + 既有执行器 |
| 5 审查 + 可选 expire handler | 多轮同卡、两端、权限持久化 | 无新 RPC |
| 6 最终验证 | 整组 / 类型 / lint / 隔离 PG / 浏览器 | — |

---

## 本批结束后

推送到 `fix/tooling-defects-a2ui-presentation` / PR 50。更新 PR 时保留 GitHub UI 上的人工编辑。报告：计划路径、Task/AC 矩阵、提交/head、原始命令结果与 skip、B/C/D 未验项、PR 状态。然后等待父端核验。**不进入 E。**
