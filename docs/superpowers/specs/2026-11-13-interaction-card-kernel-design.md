# 交互卡片内核：L1 数据 / L2 编排 / L3 表现

- **日期**：2026-11-13
- **状态**：待评审
- **类型**：框架性重构（非纯 UX）
- **范围**：`packages/db`、`packages/contracts`、`packages/core`、`packages/adapters`、`apps/api`、`apps/web`、`apps/mobile`

---

## 1. 问题陈述

### 1.1 现场证据

2026-11-11 真实对话（`simulang.e2e.20261111@gmail.com`，run `cmwddjwjx000f07oadzf96mun`）：

| 时间 (UTC) | 事件 |
|---|---|
| 09:59:36 | `present_interaction` 推出卡 A「11/23 周 · 拉斯维加斯行程（8 条事件）」 |
| 10:00:02 | `present_interaction` 又推卡 B「11/23 周 · 拉斯维加斯行程」 |
| 10:00:27 | 模型绕过卡片，`COMPOSIO_MULTI_EXECUTE_TOOL` → `GOOGLECALENDAR_CREATE_EVENT` |
| 10:00:54 / 10:00:57 | 模型对两张卡各调一次 `cancel_interaction` |

用户看到的结果：两张卡、一次绕过写入、两次自我取消。

### 1.2 根因：三层同时缺位

**L1 数据层没有卡片身份。** `Interaction` 表三个索引全是普通索引，没有一个 `@@unique`：

```1041:1070:packages/db/prisma/schema.prisma
model Interaction {
  id               String               @id @default(cuid())
  ...
  intent           String
  status           String
  draftVersion     Int                  @default(1)
  ...
  @@index([threadId, updatedAt])
  @@index([spaceId, threadId])
  @@index([runId])
}
```

schema 从设计上允许「同线程、同意图、任意多张开放卡」。卡 A/B 并存不是 bug，是这张表的合法状态。

`status` 是自由 `String`，代码里实际有 12 个取值，拼错不报错。没有 `expiresAt`、没有 `origin`、没有事件表。

**L2 编排层出卡靠模型自觉。** `present_interaction` 由模型自行决定调用时机，服务端只能事后补救：

```typescript
const replacing = await openDraftId(ctx, plan.intent);
...
...(replacing ? { amendsInteractionId: replacing } : {}),
```

应用层先读后写。两个 run 并发时都读到 `undefined`，各自 `createInteraction`，照样两张卡。

`interaction-capability.ts` 已是能力注册表，但它只回答「有没有 surface / 要不要连接 / 跑什么 effect」，**不回答「这张卡现在什么状态、能不能再出一张、谁能让它结束」**。因此 `present / edit / cancel / dispatch` 四个入口各自拼状态、各自查库。

`calendar.create` / `calendar.compose` / `email.compose` / `email.send` 散落在 **24 个文件、46 处**，无一处是唯一真相——这是「修了日历、邮件冒出同类问题」的结构原因。

**L3 表现层各端各写，且可交互性不由服务端状态决定。**

```174:185:packages/core/src/page-links.ts
export function surfaceCardIsLive(
  cards: readonly { interactionId: string; amendsInteractionId?: string | undefined }[],
): (interactionId: string) => boolean {
  const amended = new Set<string>();
  for (const card of cards) {
    if (card.amendsInteractionId) amended.add(card.amendsInteractionId);
  }
  return (interactionId: string) => !amended.has(interactionId);
}
```

两个后果：模型自行 `cancel_interaction` 的卡若无 `amendsInteractionId` 指向它，前端仍判为可交互；任何新增的终态（`superseded`/`expired`）前端完全看不见。

状态文案在两个客户端各硬编码一份：

| 文案 | Web | Mobile |
|---|---|---|
| `Needs approval` | `EmailComposeEditor.tsx:530` | `a2ui-native-surface.tsx:224` |
| `Sending email` | `EmailComposeEditor.tsx:477` | `a2ui-native-surface.tsx:207` |
| `Discarded` | `EmailComposeEditor.tsx:222` | `a2ui-native-surface.tsx:200` |

邮件有共享阶段函数 `emailSurfacePhase`（注释写明「One rule shared with the web card」），**日历没有等价物**，日历卡的状态、锁定、终态全靠客户端猜。

### 1.3 已有的修复都落在 L3

| 修复 | 层 | 性质 |
|---|---|---|
| `openDraftId` 顶替旧卡 | L1 的影子 | 应用层去重，DB 无保证 |
| `requiredFieldsSatisfied` 认批量 | L2 | 判定补丁 |
| 卡片渲染 `event-list` | L3 | 正确且独立 |
| 日历/邮件专属提示语 | L3 | 正确且独立 |
| `refuseDirectCalendarCreate` | L2 出口 | 堵漏，下一个出口仍会暴露 |

**结论：L3 反复打磨，L1 从未动过。** 这是「反复修不好」的机械原因。

---

## 2. 产品对标：Grok Bot 的行为规则

参考两张真实对话截图与 `grok-bot-matebot-design-reference-Grok 产品研究.md`。

### 2.1 从截图提取的规则

**连接类卡（截图 1）**

| 观察 | 规则 |
|---|---|
| 全程只有一张卡 | 一卡一事 |
| 卡下一行小字「Grok Bot 在做出更改前总会先征求你的同意。你可以随时断开连接」 | 常驻信任说明用一行小字，不做成菜单 |
| 按钮只有一个「连接」 | 按钮动词 = 此动作的真实动词 |
| 副标题「让 Grok Bot 使用 Google Calendar」 | 副标题说人话 |
| 卡后紧跟「连接日历后，我会按北京时间为你安排下周（11月16日至22日）的日程」 | **停机态卡预先把「接下来做什么」讲清楚** |

**提问类卡（截图 2）**

| 观察 | 规则 |
|---|---|
| 卡标题「要添加 Firecrawl 吗？」 | 动作型卡标题是**问句** |
| 按钮「添加 Firecrawl」 | 按钮 = 动词 + 具体对象 |
| 卡前一句澄清「目录里的版本提供网页抓取功能，不是独立的账号连接」 | 前提不符时先解释**一句** |
| 「我来添加 Firecrawl。」→「Firecrawl 已添加。」 | 进度与结果是普通文字行，各一句，**不新推卡** |
| 提问卡仍在原位 | 卡不重新发布，原地更新 |

### 2.2 与 Grok 的对齐与有意偏离

| 维度 | Grok Bot | 本规格 |
|---|---|---|
| 卡片数量 | 同一动作一张，串行 | 对齐 |
| 新消息关闭旧卡 | 是 | 对齐（见 D2 偏离） |
| 动作动词 | 按动作换词 | 对齐 |
| 内容直出 | 是 | 对齐 |
| 执行旁路 | 待审阅时禁止直连 | 对齐 |
| 卡片过期 | 对话起源不计时；后台起源 30 分钟 | **本轮不做**（无后台出卡路径） |
| 卡协议字段 | 建议 envelope | 只取被现有代码证明需要的部分 |

**有意偏离清单（必须显式记录）**

- **D1**：`needs_connection` 豁免于「新消息即失效」。理由：等待连接是停机态而非待确认动作；结算会导致授权返回后续跑找不到卡，只能重起模型回合并可能推出**不同的卡**。
- **D2**：`unknown`（邮件结果存疑）既不参与结算也不参与过期。理由：它可能已经发出去了，任何自动结算都会对用户撒谎。
- **D3**：不实现 `origin` / `expiresAt` / `actorUserId`。理由：当前无任何代码产出或消费（`apps/worker` 对 `interaction` 零引用），做了就是无人调用的代码 + 一个可能误伤的定时器。
- **D4**：新消息结算用 **两段式**（写 `staleAt` 软标记 → 回合结束 `superseded` 硬结算），不是 Grok 文档描述的「新消息立即关闭旧卡」。理由：Matebot 的 `edit_interaction` 支持用自然语言改现有草稿，一步关闭会让每次编辑都换新卡，与本次目标相反。软标记用 `Interaction.staleAt` 列而非新增 `status` 值——后者会让 `collecting` 卡误变为可确认、并让唯一索引失效。见 §5.4。
- **D5**：无关新消息也会结算掉草稿（E6）。刻意对齐 Grok；代价是「随口问一句」会关掉草稿，缓解手段是内容保留在历史投影里可恢复。

---

## 3. 目标与非目标

### 3.1 目标

- **G1** 同线程同意图的**动作型卡**物理上不可能同时存在两张。
- **G2** 一张卡的每个状态变化只有一条写入路径，状态值编译期受约束。
- **G3** 旧卡由**新用户消息**关闭，不靠模型记得调 `cancel_interaction`。
- **G4** `intent` 判断从 46 处收敛到注册表一处读取。
- **G5** 卡片可交互性由**服务端状态**决定，前端不再从 `amendsInteractionId` 反推。
- **G6** 邮件与日历共用同一套阶段/锁定/终态推导，各端只负责画。
- **G7** 连接完成后**按存下的计划续跑**，不重新询问模型。
- **G8** 按钮文案能表达「动词 + 对象」，且对象受控、动词白名单化。
- **G9** 卡片批准菜单达到四项能力（允许收件人 / 需要批准 / 为此 Bot 关闭草稿 / 管理规则）。
- **G10** 卡片历史投影含关键槽位，用户下一轮说「再发一封给同一个人」时模型能正确回应。

### 3.2 非目标

- 不改发信、确认、执行的协议与授权模型。
- 不重做 A2UI 协议或渲染技术栈。
- 不引入 Grok 的 11 类卡片分类法。
- 不做 Firecracker / 云电脑 / Vault 相关。
- 不引入 LLM judge 或第二次模型调用。
- 不新增团队协作、采购、会议卡种。
- 不修本文 §12 列出的既有缺陷。

---

## 4. L1 数据层设计

### 4.1 卡片身份

新增列 `cardKey`，值为稳定哈希：

```
cardKey = sha256(threadId + "\u0000" + intent)
```

**故意不含** title / summary / slots / target。理由：卡 A/B 的标题只差「（8 条事件）」几个字，任何含标题的 key 都挡不住这次重复。「同线程同意图只允许一张开放卡」是**产品意图**约束，不是内容去重——内容变了应原地更新那张卡（`draftVersion++`）。

**已接受的代价**：同线程并发准备两封不同邮件会被合并成一张。与 Grok 的串行行为一致，用户可用两个线程规避。

### 4.2 开放态唯一约束

Prisma schema 语言不能声明部分索引，必须手写 SQL migration：

```sql
CREATE UNIQUE INDEX interactions_one_open_card_per_intent
  ON interactions (card_key)
  WHERE status IN ('collecting','ready_for_review','awaiting_approval');
```

**`needs_connection` 不在约束内**——用户可能同时连着 Gmail 和日历，且它不是确认请求，不该被串行化。

**内容型卡天然不受此约束**：结果卡以 `status: "succeeded"` **终态入场**（`interaction-result-publish.ts` 明确写「A result is terminal on arrival: it has nothing to confirm」），从不落入三个开放态，因此部分索引自动不适用。这也是为什么同线程问两次「下周有什么」能并排两张结果卡。

这是本规格唯一偏离 Prisma 声明式建模之处。必须有索引存在性测试（查 `pg_indexes`）防止后续 `prisma migrate` 悄悄抹掉。

### 4.3 状态机

DB `status` 固定为 13 值枚举：

| 状态 | 性质 | 可确认 | 被新消息结算 | 自动过期 |
|---|---|---|---|---|
| `collecting` | 开放 | 否（缺字段） | 是 | — |
| `ready_for_review` | 开放 | 是 | 是 | — |
| `awaiting_approval` | 开放 | 是 | 是 | — |
| `needs_connection` | 停机 | 否 | **否**（D1） | — |
| `unknown` | 存疑 | 否 | **否**（D2） | **否**（D2） |
| `sent` | 成功终态 | 否 | 否 | — |
| `executed` | 成功终态 | 否 | 否 | — |
| `succeeded` | 成功终态（邮件） | 否 | 否 | — |
| `confirmed` | 终态 | 否 | 否 | — |
| `superseded` | 新增终态 | 否 | — | — |
| `expired` | 终态 | 否 | 否 | — |
| `failed` | 失败终态 | 否 | 否 | — |
| `cancelled` | 终态 | 否 | 否 | — |

**「有没有更新」不是状态，是列。** 新增 `Interaction.staleAt DateTime?`，不占用 `status` 取值。

初版曾打算加一个 `stale` 状态值，评审时否决，理由是它把**工作流阶段**和**新鲜度**两个正交维度压进一个字段，会引入真实 bug：

| 用 `stale` 当状态会坏什么 | 后果 |
|---|---|
| 丢失原阶段（`collecting` 变 `stale`） | `collecting` 本不可确认（字段没填完），变 `stale` 后按 §6.1 变成可确认 → **用户能确认一张残缺的卡** |
| 卡离开开放态集合 | §4.2 部分唯一索引失效 → 推替代卡时走「创建」而非「更新」→ **两张活卡并存** |
| 丢失 `awaiting_approval` | 审批语义与审计事件跟着丢 |

用 `staleAt` 列则：状态机不动、索引不动、affordance 不动，`publishOrAmend` 照常原地更新并清空 `staleAt`。

**`unknown` 单独成行是本设计的重点**：`interaction-email-reconcile.ts` 用它表示「不确定邮件是否已发出」，此时禁止重发、转轮询。任何批量结算把它推成 `expired`，用户会看到「已过期」而邮件其实已发出。

### 4.4 三套状态词表的关系

现状有三套并存的状态词，必须明确定义关系，否则改一处静默坏三处：

| 层 | 取值 | 位置 | 本规格处理 |
|---|---|---|---|
| DB `status` | 13 值 | `schema.prisma` | **唯一真相**，枚举化 |
| Block `lifecycle` | `draft`/`submitting`/`executing`/`succeeded`/`failed`/`unknown` | `contracts/interaction.ts:83` | 保留为**发布时快照**，由 `status` 派生 |
| 读侧 `SurfaceStatus` | `draft`/`approved`/`executed` | `core/surface-revision.ts:12` | 保留为**读侧视图**，由内核单向映射 |

**当前最危险的静默 bug 点**在 `apps/api/src/routes/threads.ts`：手工映射 `succeeded → executed`、`awaiting_approval → approved`、其余 `→ draft`。`superseded` 会落到 `draft`，变成一张可点的卡。此映射必须删除，换内核函数。

### 4.5 事件表

新增 `interaction_events`（追加-only）：

| 列 | 说明 |
|---|---|
| `id` | cuid |
| `interactionId` | 索引 |
| `at` | 时间戳 |
| `kind` | `published` / `amended` / `settled` / `dispatch_requested` / `dispatch_rejected` |
| `fromStatus` / `toStatus` | 状态迁移 |
| `reason` | 结算原因（`user_message` / `duplicate_present` / `manual_cancel` …） |
| `runId` | 可选 |

排查「这张卡为什么变成这样」不再翻 `messages` 表反推时序。

### 4.6 存量迁移

1. 先跑 `SELECT DISTINCT status` 全量盘点；未知值归一并告警。**不允许直接 `migrate dev` 撞报错。**
2. 回填 `cardKey`。
3. 按 `cardKey` 分组，开放态保留 `updatedAt` 最新一行，其余转 `superseded`。
4. 每张被结算的卡在时间线追加一行「已由更新的草稿替代」。
5. 建部分唯一索引。

---

## 5. L2 编排层设计

### 5.1 内核模块

新增 `packages/core/src/interaction-kernel.ts`（纯函数，无 IO）：

```typescript
cardKeyFor(threadId, intent): string
isOpenStatus(s): boolean
isConfirmableStatus(s): boolean
isTerminalStatus(s): boolean
isAutoSettleable(s): boolean        // unknown / needs_connection → false
surfaceAffordanceFor(status): SurfaceAffordance
toReadSideStatus(status): SurfaceStatus
```

新增 `packages/adapters/src/interaction-kernel-store.ts`（带 tx 的写侧）：

```typescript
resolveOpenCard(tx, threadId, intent)
publishOrAmend(tx, input)                    // P2002 → 重试一次走更新
settleInteraction(tx, { interactionId, status, reason })   // 唯一终态写入
supersedeOpenCards(tx, threadId, { exempt })
```

### 5.2 publish-or-amend

`publishInteractionSurface` 从 `create` 改为：

1. 算 `cardKey`。
2. `resolveOpenCard` 查开放卡。
3. 命中 → 更新该行（`plan`、`slots`、`draftVersion++`），**更新原 message 的 block**，不新建 message 行。
4. 未命中 → 创建。
5. 撞唯一约束（`P2002`）→ 重试一次走步骤 3。

`openDraftId` 的手工查找**降级为快路径**，正确性由 §4.2 的索引保证。

**与 `staleAt` 的配合**：`staleAt` 是列不是状态，所以 `resolveOpenCard` 照常命中「有更新未处理」的卡，`publishOrAmend` **原地更新并清空 `staleAt`**（同一事务）。不需要额外的结算步骤，也不会出现两张活卡。

### 5.3 四个入口统一

`present_interaction` / `edit_interaction` / `cancel_interaction` / dispatch 全部改走内核：

- 不再自己拼 `status`
- 不再自己 `findMany` / `findFirst` 找开放卡
- 不再自己算 `amendsInteractionId`

**编辑目标集合不受 `staleAt` 影响**：`edit_interaction` 可编辑的是状态为 `collecting` / `ready_for_review` / `awaiting_approval` 的卡，**是否带 `staleAt` 都可编辑**。`threads.ts` 当前用 `status notIn ["cancelled","failed","unknown"]` 的宽查询；改窄时不要按 `staleAt` 过滤，否则编辑会在用户刚好发了新消息时失效（AC-8b）。

### 5.4 新消息结算（两段式，保护 `edit_interaction`）

**为什么不能一步到位**：如果用户新消息一到就把开放卡转 `superseded`，那么「把主题改成 XX」这类自然语言编辑会先失去目标卡——内核找不到开放卡，只能新建一张。**每次编辑都换一张卡**，正是本规格要消灭的现象。`threads.ts` 当前用 `status notIn ["cancelled","failed","unknown"]` 查编辑目标，实施时若顺手把 `superseded` 加进去，编辑路径会彻底断掉。

**两段式**：

| 阶段 | 触发 | 动作 |
|---|---|---|
| 第一段：软标记 | 用户新消息进入线程 | 本线程开放卡写 `staleAt = now()`，`status` 不变，时间线不追加行 |
| 第二段：硬结算 | 回合结束时，本回合快照内仍带同一 `staleAt` 的卡 | 转 `superseded`，时间线追加「已由更新的草稿替代」 |

**`staleAt` 期间卡仍可编辑、仍可确认**——只显示一条轻提示「可能有更新」。三种操作会清空 `staleAt`（视作用户仍在用这张卡）：`edit_interaction` 命中、卡内字段修改、卡片确认。被清空的卡在第二段自然不匹配，不产生 `superseded`。

**边界规则（评审补充，实现必须逐条满足）**：

| # | 情形 | 正确处理 |
|---|---|---|
| E1 | 用户在回合运行中点「发送」 | 结算用 CAS：`WHERE status IN (开放态) AND staleAt = :snapshot`。卡已 `sent` → 不匹配 → **不会把已发的卡改成 `superseded`** |
| E2 | 回合 A 很慢，期间用户发了消息并跑完回合 B | 第二段**只结算回合开始时快照里的 ID**，不是「此刻所有开放卡」，否则慢回合会误杀回合 B 新建的卡 |
| E3 | 进程崩溃，`staleAt` 残留 | 下回合开始时先做 GC：`staleAt < 本回合开始时间` 的开放卡直接结算为 `superseded` |
| E4 | 多张卡同时 stale（邮件 + 日历），模型只改了邮件 | 邮件清空 `staleAt`；日历回合结束结算为 `superseded`。内容不丢，历史投影含槽位（§6.7.1），用户说「恢复刚才那个日程」模型能重建 |
| E5 | 同线程多张 stale 卡，模型调 `edit_interaction` 未指定 id | 沿用现有 `open.length === 1` 判定 → 多卡时要求显式 id，**不能靠猜** |
| E6 | 用户问一句无关的话（「今天天气怎样」） | 草稿照样被结算为 `superseded`。这是**刻意对齐 Grok**（D4），不是 bug；内容保留在历史投影里可恢复 |
| E7 | `needs_connection` / `unknown` | 不写 `staleAt`（D1/D2） |

**豁免项**（不写 `staleAt`）：

- `needs_connection`（D1）——等待连接是停机态
- `unknown`（D2）——可能已发出，禁止自动结算

**已核实的安全项（必须写成不变量）**：卡片上的批准规则操作（允许收件人 / 管理规则 / 关闭草稿）走 `apps/api/src/routes/account.ts:272` 的账户设置 RPC，**不产生线程消息**，因此不进入本结算路径。任何将来把它改成走消息通道的改动都会让卡片在点击后消失——**禁止**。

### 5.4.1 Bot 级关闭草稿（新能力）

截图菜单里的「为此 Bot 关闭草稿」在 Matebot **没有底层开关**：`Bot` 表无相关字段，`ActionAutoReviewPreference.skipApprovals` 是「用户+空间」级而非 Bot 级。

需要新增：

- `Bot.draftsDisabled Boolean @default(false)`
- `publishOrAmend` 前检查：若为 true 且 intent 是动作型，**跳过草稿卡**，走既有审批规则后直接执行
- 卡片菜单提供「恢复草稿」反向操作

**安全约束**：

- 关闭草稿**不放宽批准规则**——仍需通过 `ActionApprovalRule` 判定
- 只影响该 Bot，不影响同空间其他 Bot
- `draftsDisabled` 变更写审计（沿用 `approval.policy.changed` 同类事件）

这是四项补充里**唯一需要新数据列与执行路径变更**的，风险最高，建议最后一批做。

### 5.5 连接卡续跑（缺口 1 修复）

**现状问题**：`interaction-resume.ts` 在连接完成后重新起回合，让模型再推一次卡：

```
The user just connected ${provider}, so continue what they asked for.
Call present_interaction once for the ${subject} ...
```

这会使连接前后两张卡不一致——与卡 A/B 同一种形态。

**修复**：发布 `needs_connection` 卡时把续跑计划存到卡上（`plan.nextStepPayload` 或独立列 `resumePlan`）。连接完成后按存下的计划原地恢复该卡，**不再询问模型**。

模型「重新推卡」的路径降级为兜底：仅当卡上没有存计划时才走。

### 5.6 注册表扩展：动作型 / 内容型

`interaction-capability.ts` 增加 `cardKind` 字段：

| 类型 | 例子 | 唯一约束 | 标题形态 | 谁出卡 |
|---|---|---|---|---|
| `action` | `email.compose`、`calendar.create` | 适用 | 问句 | 内核 |
| `result` | `interaction.result` | 不适用（终态入场） | 名词短语 | 模型可主动出 |

**注意**：`calendar.query` 目前在注册表里但**没有任何发布路径**（生产代码零引用），是死条目。AC-11 的参照物因此改用 `interaction.result`。是否删除 `calendar.query` 留到实施时决定。

这是把「服务端负责出卡」落到最小可执行形态，**不做全量状态机重写**。

### 5.7 intent 判断收敛

46 处 intent 字符串判断，凡「判断这是不是日历/邮件」的改为查注册表。验收：**新增一种卡种改动 ≤3 个文件**。

---

## 6. L3 表现层设计

### 6.1 可交互性由状态决定

```typescript
surfaceAffordanceFor(status): {
  interactive: boolean
  editable: boolean
  submitLabelKey: string
  terminal: boolean
  reasonKey?: string
}
```

**`staleAt` 不进这个函数**。它只影响两处：卡头和状态行加一条轻提示「可能有更新」（`surfaceStaleHint`），以及时间的显示。可交互性、可编辑性、按钮文案**完全不变**——`collecting` 卡带着 `staleAt` 仍然不可确认（这正是把新鲜度做成列而不是状态的原因，见 §4.3）。

| 状态 | interactive | 展示 |
|---|---|---|
| `collecting` / `ready_for_review` / `awaiting_approval` | 是 | 正常卡 |
| `needs_connection` | 仅连接动作 | 连接卡 |
| `unknown` | 否 | 「结果不确定，正在确认」 |
| `sent` / `executed` / `succeeded` / `confirmed` | 否 | 结果态 |
| `superseded` | 否 | 折叠灰显 |
| `expired` / `failed` / `cancelled` | 否 | 折叠灰显，带原因 |

`surfaceCardIsLive` **保留函数名**，内部转发到新判定，观察一轮后删除。

### 6.2 阶段推导统一（缺口：日历补齐）

`emailSurfacePhase` 泛化为 `surfacePhase(intent, block, busy)`：

- 邮件沿用现有 `EmailSurfaceTemplate`
- 日历补 `calendar-draft-card` / `calendar-submitting-card` / `calendar-result-success` / `calendar-result-failed` / `calendar-superseded-card` / `calendar-expired-card`
- `locked` / `settled` 统一产出，各端不再自己判断

### 6.3 状态文案单一来源

```typescript
surfaceStatusCopy(status, intent): { titleKey, bodyKey?, actionKey? }
```

各端只做本端 i18n 取值（Lingui / mobile locale），不重复定义语义。

新增文案：

- `superseded`：「这张草稿已由更新的版本替代」
- `expired`：「已过期，Bot 没有执行」
- `unknown`：「正在确认是否已经发出，请不要重发」
- `staleAt` 提示（非状态）：「可能有更新」

### 6.4 动作动词与按钮标签（缺口 2、3 修复）

**按钮标签**：现在固定取 `schema.action.label`（`compile-surface.ts:295`），永远是 `Send`/`Create`。

改为**受控的两段式**：

| 部分 | 来源 | 约束 |
|---|---|---|
| 动词 | 注册表按 `effectKind` 给出白名单（连接/添加/创建/发送/删除…） | 必须是白名单内，模型不可自由写 |
| 对象 | 卡标题里的受控字段 | 长度上限、过滤控制字符 |

**安全约束（必须写进实现）**：绝不允许模型直接提供按钮文案。审批按钮上的文字是钓鱼面——一个能写「点击领取」的按钮就是漏洞。对象只能取自已校验的标题字段。

**标题形态：按「有没有内容要审阅」分，不是按 action/result 分。**

这是对初版规则的修正。对比三张截图的真实形态：

| 卡的形态 | 判定依据 | 标题 | 例子 | 按钮 |
|---|---|---|---|---|
| **审阅型** | 卡片承载具体内容供人判断 | 类别小标签 + 内容标题 | 邮件 / 产品发布；日历 / 11-23 周行程 | 动作动词（发送、创建） |
| **决策型** | 卡片问「要不要做一个系统变更」 | 问句 | 要添加 Firecrawl 吗？ | 动词 + 对象（添加 Firecrawl） |

初版写成「动作型 → 问句」，与截图不符：邮件卡是动作型却不是问句。正确判据是**卡上有没有可审阅内容**——有就是审阅型（名词短语），没有就是决策型（问句）。

由注册表 `presentation` 派生，不由模型自由填。

**类别小标签（截图里的「邮件」）**：卡片左上角显示意图的中文类别名（邮件 / 日历 / 任务结果），取自注册表 `label` 字段。当前 `InteractionCapability.label` 已有该字段（`"Email"` / `"Calendar"`），只是没渲染到卡上。

### 6.5 内容直出

卡片必须展示人要判断的东西，不是内部 JSON 槽位：

- 日历批量：`event-list`（已实现，保留）
- 邮件：收件人、主题、正文、附件列表
- 真实发件人邮箱：`senderAddress`（已实现，保留）

### 6.6 卡片批准菜单（对标截图 3）

现状只有两项，且「需要批准」是 disabled：

```527:541:apps/web/src/components/a2ui/EmailComposeEditor.tsx
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuItem disabled data-testid="a2ui-email-approval-require">
          {t`Needs approval`}
        </DropdownMenuItem>
        {onManageRules ? (
          <DropdownMenuItem data-testid="a2ui-email-manage-rules" onClick={onManageRules}>
            {t`Manage rules`}
```

目标形态（四项，含当前项勾选）：

| 菜单项 | 行为 | 底层 |
|---|---|---|
| 允许收件人 | 下次给该收件人免批 | `approvalRules.set`（已存在） |
| 需要批准 ✓ | 当前态，disabled | — |
| 为此 Bot 关闭草稿 | 该 Bot 以后直接发 | 新增 `Bot.draftsDisabled`（§5.4.1） |
| 管理规则 | 打开设置页 Approvals | 已有 `onManageRules` |

**约束**：

- 菜单项是**账户设置操作**，不产生线程消息，不进入 §5.4 结算（已核实走 `account.ts:272` RPC）
- 「允许收件人」只对**后续**的发信生效，**不跳过本张卡**——本卡仍需点发送
- 手机端同一套四项，文案走本端 locale

### 6.7 终态卡展示

- 保留在时间线，灰显、无按钮
- 折叠为一行：「[草稿已失效] 11/23 周 · 拉斯维加斯行程」
- 服务端历史投影 `blocksToAgentHistoryText` 补终态，让模型知道旧卡已失效

### 6.7.1 历史投影必须带关键槽位

现状投影行只有标题，模型看不见卡里的关键信息：

```204:207:packages/core/src/attachments.ts
      if (block.kind === "a2ui_surface") {
        const intent = block.intent?.trim() || "a2ui_surface";
        const state = block.lifecycle ?? "draft";
        const hint = (block.summary ?? block.title)?.trim();
        return hint ? `[card: ${intent} → ${state} (${hint})]` : `[card: ${intent} → ${state}]`;
```

实际进模型历史的是 `[card: email.compose → succeeded (产品发布)]`——**没有收件人 `418452732@qq.com`**。所以下一轮说「再发一封给同一个人」，模型只能猜。

**修复**：动作型卡的投影行追加关键槽位摘要（来自 `slots`，脱敏、长度受控）：

| 意图 | 必须出现的槽位 |
|---|---|
| `email.compose` | 收件人、主题 |
| `calendar.create` | 事件数、时间范围 |
| 其他动作型 | 注册表声明 `historyDigestFields` |

格式示例：`[card: email.compose → succeeded (收件人 418452732@qq.com · 主题 产品发布)]`

这是把 D1 的修复补完整：**有摘要不够，摘要必须含模型下一轮真正需要的东西**。

### 6.8 进度与结果是文字行，不是新卡

截图 2 的「我来添加 Firecrawl。」→「Firecrawl 已添加。」对应 Matebot 的 `message_user` 短意图 + 最终回复。

**已满足，不要回退**：`interaction-email-outcome.ts` 用 `tx.interaction.updateMany` 原地更新卡状态，不新推结果卡。动作型卡执行后**只更新原卡 + 追加一句结果行**。

### 6.9 三端一致

| 端 | 改动 |
|---|---|
| Web / 桌面 | 调用 core 的 affordance + phase + copy，删本地判定 |
| Mobile | 同上，补 `event-list` 与日历阶段渲染 |
| 服务端投影 | `blocksToAgentHistoryText` 补 `superseded`/`expired`/`unknown` |

---

## 7. 对其他功能的影响（已核实）

### 7.1 不受影响

| 功能 | 依据 |
|---|---|
| Slack / Telegram / WhatsApp / Discord 等渠道 | 对 `a2ui_surface` / `present_interaction` **零引用**，不走卡片体系 |
| 定时任务 / 例行 / worker | `apps/worker` 对 `interaction` **零引用**，无定时出卡路径 |
| Bot 记忆、文件、Pages、语音、通话 | 不在 `interaction` 表路径上 |
| A2UI 协议 | 不改 `protocolFamily` 与 `document` 结构 |
| 客户端渲染契约 | 客户端不读 DB `status`，只读 `block.lifecycle` |

### 7.2 三处真实冲突及处理

| 冲突 | 处理 |
|---|---|
| 断线重连续跑会被「新消息结算」打断 | §5.4 豁免 `needs_connection`（D1） |
| `unknown` 被当开放态自动结算 | §4.3 硬拒（D2），`isAutoSettleable` 返回 false |
| 三套状态词表 + `threads.ts` 手工映射 | §4.4 与 §6.1 收敛，删除手工映射 |

### 7.3 两处需留意

- **多卡 chooser**（`threads.ts editInteraction`）：`open.length === 1` 才自动选中。唯一约束后多数情况为 1，但**必须按 intent 过滤**——动作型卡与 `interaction.result` 混在同一线程时 `open.length` 会 >1。
- **结果卡刷新**（`run-tools-result-refresh.ts`）：用 `status notIn ["cancelled","failed"]` 定义「开放」，语义比「可确认」宽。不能直接换 `isOpenStatus`，否则已执行结果卡从刷新列表消失。需区分**「可刷新」与「可确认」**两种判定。

### 7.4 回归成本

94 个测试文件引用 `interaction`（core 22、adapters 33，其余在 api/web/mobile）。必须分批推进，每批全量测试。

---

## 8. 分批实施

| 批 | 内容 | 目标 |
|---|---|---|
| **A 止血** | `cardKey` + 部分唯一索引 + 状态枚举 + `staleAt` 列 + 内核 + `publishOrAmend` + 四入口统一 | 重复推卡闭环 |
| **B 兑现** | `surfaceAffordanceFor` + `surfacePhase` + 文案/词表收敛 + 终态展示 + 按钮标签 + 类别小标签 + 标题形态 | 用户真看到一张卡 |
| **C 加固** | 两段式新消息结算 + 连接卡续跑 + 事件表 + 历史投影（含关键槽位） | 结算、编辑、记忆、可追溯 |
| **D 收敛** | 注册表 `cardKind` + 46 处 intent 判断收敛 + 批准菜单四项 + `Bot.draftsDisabled` | 加一种卡 ≤3 文件；对标 Grok 菜单 |

每批独立可验证、可上线、可回滚。

**批内顺序建议**：C 批的「两段式结算」必须早于任何依赖 `superseded` 的功能上线，否则会先制造出「每次编辑换卡」的症状。D 批的 `Bot.draftsDisabled` 风险最高，单独做、最后做。

---

## 9. 验收标准

| 编号 | 层 | 准则 | 验证方式 |
|---|---|---|---|
| AC-1 | L1 | 同线程同意图并发两次 publish，开放行数 = 1 | 并发测试 |
| AC-2 | L1 | 部分唯一索引在后续迁移后仍存在 | 查 `pg_indexes` |
| AC-3 | L1 | 存量双开放行迁移后每 `cardKey` 只剩一行 | migration 测试 |
| AC-4 | L1 | 枚举外状态写入被拒 | 类型检查 + DB 约束测试 |
| AC-5 | L1 | `needs_connection` / `unknown` 不被批量结算 | 表驱动测试 |
| AC-6 | L2 | 不存在绕过 `settleInteraction` 的 status 写入 | 源码扫描测试 |
| AC-7 | L2 | 连点两次确认，外部效果只有一次 | 幂等测试 |
| AC-8 | L2 | 新消息后旧卡带 `staleAt`，回合结束才 `superseded` | 集成测试 |
| AC-8b | L2 | 「把主题改成 XX」后原卡被原地更新，**不产生新卡** | 集成测试（本轮最关键） |
| AC-8c | L2 | 回合运行中确认已 stale 的卡，结算不把它改成 `superseded` | CAS 竞态测试 |
| AC-8d | L2 | 慢回合不误杀后续回合新建的卡 | 快照 ID 测试 |
| AC-8e | L2 | 残留 `staleAt` 在下一回合被 GC | 崩溃恢复测试 |
| AC-9 | L2 | 连接完成后按存下的计划续跑，不重问模型 | 集成测试 |
| AC-10 | L2 | 同线程两张结果卡并存（因结果卡终态入场，不受部分索引约束） | 回归测试 |
| AC-11 | L2 | 新增一种卡种改动 ≤3 文件 | 以 `interaction.result` 为参照的清单检查 |
| AC-12 | L3 | `superseded`/`expired` 三端均不可交互 | 三端快照测试 |
| AC-13 | L3 | 日历与邮件走同一 `surfacePhase` | 表驱动测试 |
| AC-14 | L3 | 状态文案只从 `surfaceStatusCopy` 取值 | 源码扫描 |
| AC-15 | L3 | 按钮对象不可由模型自由提供 | 恶意输入测试 |
| AC-16 | L3 | 历史投影含终态 | 单测 |
| AC-16b | L3 | 历史投影含收件人/主题等关键槽位 | 单测：断言 `418452732@qq.com` 出现在投影文本 |
| AC-17 | L3 | 批准菜单四项齐全，且「允许收件人」不跳过本卡发送 | DOM 测试 |
| AC-18 | L3 | 审阅型卡用「类别 + 内容」标题，决策型卡用问句 | 快照测试 |
| AC-19 | 全 | 全量测试通过 | CI |

---

## 10. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 手写部分索引被后续 migration 抹掉 | 重复卡复发且无声 | AC-2 进 CI |
| 状态枚举化撞未知值 | 迁移失败 | 迁移前全量盘点 |
| `cardKey` 过粗合并合法双卡 | 体验倒退 | 只对动作型卡启用；内容型豁免（AC-10） |
| 存量卡被结算引起困惑 | 老对话卡消失 | 保留最新一张 + 时间线说明行 |
| `surfaceCardIsLive` 被外部依赖 | 行为变化 | 转发实现，观察一轮再删 |
| 按钮文案被滥用 | 钓鱼面 | 动词白名单 + 对象受控（AC-15） |
| 三端渲染能力不一致 | 手机端显示缺失 | AC-12 三端快照 |
| 两段式结算实现不完整，退化成「每次编辑换卡」 | 回到当前症状 | AC-8b 作为硬闸门 |
| `Bot.draftsDisabled` 让 Bot 绕过草稿 | 误发风险 | 仍受批准规则约束；审计事件；只影响本 Bot |

---

## 11. 与既有文档的关系

- `docs/superpowers/specs/2026-11-12-tooling-defects-a2ui-presentation-design.md`：呈现层，**正交不废止**。
- `docs/plans/2026-11-12-001-feat-review-card-activity-ux-plan.md`：呈现层计划，**正交不废止**；其中已落地的文案与渲染在本规格 §6 被收编为单一来源。

本规格落地后，`openDraftId` 与 `refuseDirectCalendarCreate` 从**正确性手段**降级为**防御性冗余**——保留，但不再是主力。

---

## 12. 已确认的既有缺陷（不在本规格范围）

1. `packages/adapters/src/pipedream-connector.test.ts:162` 类型错误（`ConnectorRoute.toolName` 可选性）。
2. `packages/adapters/src/mcp-package-installer.test.ts` 依赖本机 `npm`，当前环境无系统 `npm`。
3. `packages/adapters/src/workspace-save-policy.test.ts` 的 1 万目录用例 60 秒超时。已单独探明：排除正则本身仅 0.40 秒，瓶颈在收集 `CACHEDIR.TAG` 的管道（每目录一次 `awk` + `head -n 1000` 后拼 1000 个 `-o -path`）。

---

## 13. 待实施时确认的细节

- `resumePlan` 存为 `plan` 内嵌套字段还是独立列（取决于是否需要在卡列表查询里带出）。
- 部分唯一索引的 migration 是否需要在 `prisma migrate` 之后追加一步校验脚本（当前倾向：CI 里跑索引存在性测试，不改迁移流程）。
- 按钮对象字段的长度与字符过滤规则具体取值。
- `interaction_events` 的保留期与审计导出的关系（当前倾向：先不设保留期，与 `audit_events` 分开）。
