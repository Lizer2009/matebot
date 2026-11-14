# 交互卡内核（t321 交叉发现修复）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Grok 4.6 only — no other-model Task/review/fallback. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 按权威规格修交叉验证确认的全部 A–E 问题（finding 编号 F-01…F-15，外加 t321 纳入的未分派 AC-21/AC-22）。不改旧规格、不改审查记录、不启动 F 批。F-16 已驳回，不改。

**Architecture:** DB `status` 保持规格 13 值。发送在途用**行仍停在开放态**占用部分唯一索引，块 `lifecycle` 仍可 `executing`；禁止 amend 在途 payload。连接查找改为按 app/账号匹配的多行扫描。settle 三写进同一事务。终态不得写回 `needs_connection`。L0-A 投影与 `connections.complete` 结算 connect 卡。t321 把 AC-21/AC-22 分派为本轮修复，不追认 E 已完成。

**Tech Stack:** TypeScript, Prisma, Vitest, Playwright live launcher, FakeComposio, isolated PG `matebot_b_accept`.

---

## t321 分派（未追认 E 已完成）

| 项 | 原归属 | 本轮 |
|---|---|---|
| AC-21 同信息去重 | §8 无批主；E 明确不做 | **t321 纳入**，按 §6.10：同回合卡已承载则不得再输出同义散文；**不是**全线程单卡 |
| AC-22 / F-09 安全降级 | E 明确不做 | **t321 纳入**，固定句 + 关键槽位，禁止 `cause.message` |
| F-14 Slack 动作渲染 | E 收尾 formatter-only | 受控 messaging surface 带出 Skip/deny；**禁止真实投递** |

真正 F 批继续排除：catalog 五组件、catalogId/guard、v0_9 收敛、AC-28–31、mobile 新 catalog 映射。

---

## 设计决定（F-01，与规格冲突则停）

**不把 `executing`/`submitting` 加进 13 值。** 规格 §4.3/§4.4 与 B 决策 3 一致：它们是 block lifecycle。

生产发送兼容：

1. **行**保持发送前的内核开放态（`ready_for_review` / `awaiting_approval`），这样部分唯一索引占用同意图槽。
2. **块**继续 `surfaceStampFor({ status: "executing" })` 的 lifecycle/template（读侧，不写 DB status）。
3. `publishOrAmend` 若该卡的 `approvalEffectId` 指向未终态 ExternalEffect，**拒绝改 payload**（返回现卡，不 create）。
4. 迁移：`executing`/`submitting` → `ready_for_review`（永不 `succeeded`）；其余非法值 → `unknown`；再按 cardKey 对开放态去重（留最新，其余 `superseded`）。然后 `CHECK (status IN <13>)`。
5. 应用层 `createInteraction` / 内核 writer 拒绝 13 值外。
6. 禁止删行、禁止伪造发送成功。

---

## 逐项矩阵（基线 c61825499）

| ID | 规格 | 做法 | 红灯反例 | 不改 |
|---|---|---|---|---|
| F-01 | §4.2–4.4 AC-4 G1 | 上节；PG 并发/在途重入/非法拒绝/同 key/迁移 | 现 PG executing+collecting 并存 | 不加 13 值 |
| F-02 | AC-26 | findMany + 按 app/账号挑；跨 app 不互吞 | 旧 gmail+新日历叠卡 | 不同 intent 的 needs_connection 仍可并存 |
| F-03 | §6.2 | 补 calendar-draft/submitting/result-*；终态仍共享 | SURFACE_TEMPLATES 无 calendar-draft | 不做 F catalog |
| F-04 | §6.4 | compile-surface + web/mobile 用 `surfaceActionLabel` | 无生产 caller | 模型仍不能写按钮 |
| F-05 | G2 | settle 三写同一事务；已在 tx 则复用 | settle-repro 行已结块未结 | |
| F-06 | AC-6 | `canLeaveForConnection` = 非终态且非 unknown；走生产 `projectCapabilityGate`；收口 writer，**不扩** allowlist | superseded→needs_connection | |
| F-07 | §6.7 | L0-A 投影 kind+cardStatus+provider/account，无密钥 | hist-repro `""` | |
| F-08 | AC-25 | `connections.complete` settle 匹配的 connect.*；幂等；D1 免扫保留 | 丢 RPC 后卡永占位 | 不扫 needs_connection |
| F-09/AC-22 | §6.12 | 固定降级句 + historySlots/title | Host 打印 cause.message | |
| F-10 | AC-23 | 生产 reconnect 传 accountId | 两账号合成 connect.gmail | |
| F-11 | AC-8c | PG：确认清 staleAt → 旧快照 sweep 拒绝 | 缺字面测试 | |
| F-12 | AC-18 | mobile `surfaceCardTitle` | 无 category | |
| F-13 | AC-24 | publish 时内核写 reasonKey | 无 writer | 不发 effect.amount |
| F-14 | §14 #11 | extractText/ask 动作 + MessagingSendRequest.actions；fake Slack 断言 Skip；skipMessage 路径仍不真发 | 无动作字段 | 真实投递未验 |
| F-15 | §5.6 | live 断言 `result_intent` | live 只无卡 | 不实现 calendar.query |
| F-16 | — | **不改** | | 规格允许 |
| AC-3 | A | 非空/重复/终态夹具跑回填 CTE | 无测试 | |
| AC-11 | D | 源码扫描实际文件数并钉清单；不造 ≤3 | 无测量 | 历史若 >3 如实记录 |
| AC-21 | §6.10 | 卡已出则回复只能是 nudge，禁止复述字段；测试同回合 | 无去重 | 不是全线程单卡 |

环境未验（继续）：B iOS 原生、真实双击发信、真实模型/provider、真实 Slack 投递、真实 OAuth。C 30min：仅当隔离环境能真实等到点才补；禁止缩 TTL / 回拨 expiresAt / 直调 closer 冒充。

---

## Global Constraints

- Grok 4.6 only. Isolated PG + test identities. No `.5`, real send, Slack delivery, OAuth, business LLM.
- Do not merge, rewrite main, close PR, delete branch, release, deploy.
- Do not expand paid mechanisms or F catalog.
- Do not skip/delete/weaken assertions. Multi-row mocks, not single-row stubs that hide F-02.
- Do not write fork/upstream constraints into repo docs, comments, commits, or PR.
- Commits in English. Do not edit `CHANGELOG.md`.
- TDD: failing counterexample first.

---

## Files（按任务改，不预先大拆）

- `packages/core/src/interaction-status.ts` — `assertKernelStatus` / `canProjectNeedsConnection`
- `packages/core/src/interaction-connection.ts` — 多行 connect 匹配
- `packages/core/src/surface-stamp.ts` + `packages/contracts/src/interaction.ts` — calendar 非终态模板
- `packages/core/src/attachments.ts` — L0-A 投影
- `packages/core/src/surface-reason.ts`（或现有 affordance）— reasonKey 从审批源算定
- `packages/db/prisma/migrations/<new>_interaction_status_check/` — 归一 + CHECK
- `packages/db/src/interactions.ts` — create 拒非法 status
- `packages/adapters/src/interaction-kernel-store.ts` — 事务 settle；在途占用
- `packages/adapters/src/interaction-publish.ts` — 在途拒绝 amend
- `packages/adapters/src/run-tools-interaction.ts` / `connect-app.ts` — AC-26 多行
- `packages/adapters/src/interaction-l0a-publish.ts` — 指名 accountId
- `packages/a2ui-adapter/src/compile-surface.ts` — surfaceActionLabel
- `apps/api/src/interaction-service.ts` — 停止写行 executing；生产 projectCapabilityGate 守卫
- `apps/api/src/interaction-resume.ts` / `routes/connections.ts` — settle connect 卡
- `apps/web/.../A2uiSurfaceHost.tsx` — AC-22
- `apps/web/.../A2uiSurfaceCard.tsx` + present 回复 — AC-21
- `apps/mobile/components/thread/a2ui-native-surface.tsx` — F-12/F-04
- `packages/adapters/src/messaging-delivery.ts` + `adapter-kit` MessagingSendRequest — F-14
- tests as named per task

---

## Task 1: F-01 词表、占用、CHECK、迁移

- [x] **Step 1: 失败测试** PG：生产路径 `updateMany executing` 后再 create collecting 必须失败；`totally_bogus` 必须失败；在途 present 不得第二张卡；迁移夹具 executing+collecting 同 key → 一行开放。
- [x] **Step 2: 跑红**
- [x] **Step 3: 实现** 上节设计 + migration
- [x] **Step 4: 绿**
- [x] **Step 5: Commit** `fix(a2ui): keep in-flight cards on the kernel status`

## Task 2: F-02 AC-26 多行

- [x] **Step 1: 失败测试** 旧 connect.gmail + 新 connect.googlecalendar；email.compose 不得叠卡；正向 connect_app(gmail) 不得被较新 calendar 挡住；ca_1 在较新日历后仍命中；跨 app 不互吞。生产 handler + 隔离 PG，禁止单行 stub。
- [x] **Step 2–5:** 红 → findMany 匹配 → 绿 → commit `fix(a2ui): match connection cards by app not newest row`

## Task 3: F-05 / F-06

- [x] settle 事务测试（块写失败则行回滚）
- [x] 调用**导出的** `projectCapabilityGate`：superseded 卡缺邮箱不得变 needs_connection
- [x] 收口 status writer：能走 settle/decide 的不再直写；allowlist 只缩不扩
- [x] Commit `fix(a2ui): settle atomically and keep terminals settled`

## Task 4: F-07 / F-08 / F-10 / F-12

- [x] hist-repro 类单测：choice/app_connect/mcp_approval 投影含状态
- [x] PG：complete 连接后 connect.* 为 succeeded；再 complete 幂等；无客户端 RPC
- [x] 两账号断开出 `connect.gmail.{id}` 两张
- [x] mobile 标题测 category
- [x] Commit `fix(a2ui): project L0-A history and settle connect cards on complete`

## Task 5: F-03 / F-04 / F-11 / F-13 / F-15 / AC-3 / AC-11

- [x] calendar 非终态模板表驱动；终态仍 action-superseded 等
- [x] compile-surface 用 surfaceActionLabel；恶意标题消毒
- [x] AC-8c PG
- [x] reasonKey writer 闭集测试
- [x] live 断言 result_intent
- [x] AC-3 CTE 夹具；AC-11 扫描测量
- [x] Commit `fix(a2ui): wire calendar phases, labels, and leftover ACs`

## Task 6: AC-21 / AC-22 / F-14

- [x] 同回合：有卡则回复 = nudge，不含收件人复述
- [x] Host 错误固定句 + 槽位，无 cause.message / surfaceId 句
- [x] messaging 请求带 actions；受控 Slack 表面 Skip 与 deny id；不真发
- [x] Commit `fix(a2ui): dedupe copy, degrade safely, format Slack Skip actions`

## Task 7: 验证与审查

```bash
# B-wide（必须 unset 以免继承污染）
env -u VERIFY_DATABASE -u COPY_TEST_DATABASE pnpm vitest run --maxWorkers=1 \
  packages/core/src packages/adapters/src apps/api/src \
  apps/web/src/components/a2ui apps/web/src/pages/shell apps/mobile/lib
VERIFY_DATABASE=1 COPY_TEST_DATABASE=1 pnpm vitest run --maxWorkers=1 \
  packages/db/src/interaction-card-key.postgres.test.ts \
  packages/adapters/src/interaction-lifecycle.postgres.test.ts \
  packages/adapters/src/interaction-stale.postgres.test.ts \
  packages/adapters/src/interaction-expire.postgres.test.ts \
  packages/adapters/src/interaction-revive.postgres.test.ts \
  apps/api/src/interaction-connection-recovery.postgres.test.ts \
  # plus new PG files this plan adds
pnpm exec tsx apps/api/e2e-a2ui.mjs   # full a2ui-live.spec.ts
pnpm --filter @matebot/{core,adapters,db,contracts,api,web,mobile} check
pnpm lint
```

Grok 4.6 独立审查全部修复。截图：多卡连接、原卡恢复、mobile 标题、安全降级。Push PR50。停等父端。不进 F、不合并。
