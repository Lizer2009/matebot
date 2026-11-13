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
| 卡片过期 | 对话起源不计时；后台起源 30 分钟 | **对齐**（审批卡 30 分钟，见 §4.3.1） |
| 过期卡可重试 | 是（`Check price again`） | 对齐（见 §6.7） |
| 同信息不重复呈现 | 卡已显示则隐藏横幅 | 对齐（见 §6.10） |
| 连接卡指名账号 | 是（多 Gmail 分别命名） | 对齐（见 §5.5） |
| 卡协议字段 | 建议 envelope | 只取被现有代码证明需要的部分 |

**有意偏离清单（必须显式记录）**

- **D1**：`needs_connection` 豁免于「新消息即失效」。理由：等待连接是停机态而非待确认动作；结算会导致授权返回后续跑找不到卡，只能重起模型回合并可能推出**不同的卡**。
- **D2**：`unknown`（邮件结果存疑）既不参与结算也不参与过期。理由：它可能已经发出去了，任何自动结算都会对用户撒谎。
- **D3**（**已修订**）：最初打算连 `expiresAt` 一起裁掉，理由是「无生产者、无消费者」。**该判断被官方更新日志推翻**——Grok 把审批卡有效期做成产品级参数（`Auto-review approval cards stay open for 30 minutes instead of 10`），说明这是真实产品行为而非可省略的字段。现只裁 `origin` / `actorUserId`（这两项确实零生产者零消费者），**保留并启用 `expiresAt`**，见 §4.3.1。
- **D4**：新消息结算用 **两段式**（写 `staleAt` 软标记 → 回合结束 `superseded` 硬结算），不是 Grok 文档描述的「新消息立即关闭旧卡」。理由：Matebot 的 `edit_interaction` 支持用自然语言改现有草稿，一步关闭会让每次编辑都换新卡，与本次目标相反。软标记用 `Interaction.staleAt` 列而非新增 `status` 值——后者会让 `collecting` 卡误变为可确认、并让唯一索引失效。见 §5.4。
- **D5**：无关新消息也会结算掉草稿（E6）。刻意对齐 Grok；代价是「随口问一句」会关掉草稿，缓解手段是内容保留在历史投影里可恢复。
- **D6**：卡片过期**必须由 worker 定时任务驱动**，用 `expiresAt` 列 + 扫描实现，不用内存定时器。理由：进程重启会丢内存定时器，而卡状态是持久的，两者不可混用。
- **D7**：过期卡**仍可重试**，不视为「完全终态」。Grok 用 `Check price again` 的做法证明：过期只表示「内容可能陈旧」，不表示「这个需求作废」。这与 `superseded`（被替代，不再重试）必须区分。
- **D8**：协议族收敛到 `v0_9`，删除 `v1_0` 分支。理由：双轨无功能收益，只增加维护与分叉风险；`web_core@0.15.0` 的 v0.9 线完整可用。收敛时钉死 patch 版本，防 `v0.9.1` 悄悄进入。见 §15.6。
- **D9**：**不替换 A2UI**。Grok 的体验优势九成在生命周期与数据层，A2UI 不负责那部分；其 schema 校验与组件白名单是安全资产。只做定向增强（自定义 catalog），见 §15.2、§15.4。

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
- **G11** 所有**带确认/执行生命周期**的卡片共用同一个内核，不再按渲染技术分家。
- **G12** 同一场景只有**一条**出卡路径（连接、审批、问答各自唯一）。
- **G13** 审批卡有明确有效期，过期后可重试而非报废。
- **G14** 同一信息不会同时以文字和卡片出现两次。
- **G15** 卡片拿不到数据时降级为纯文本，不显示坏卡。
- **G16** 多账号场景下，连接卡指名具体账号。
- **G17** A2UI 自定义 catalog 可用，领域卡片声明化，不再每张卡三端手写（F 批，见 §15）。
- **G18** 协议族收敛为单一版本，消除双轨维护成本（D8）。

### 3.2 非目标

- 不改发信、确认、执行的协议与授权模型。
- 不重做 A2UI 协议或渲染技术栈——但**非 A2UI 卡片的状态判定要接入本内核**（见 §3.3），且**新增自定义 catalog 属于 F 批范围**（见 §15.4）。
- 不引入 Grok 的采购/会议/Vault 等**业务卡种**（这些需要 Matebot 没有的商业能力）。
- 不做 Firecracker / 云电脑 / Vault 相关。
- 不引入 LLM judge 或第二次模型调用。
- 不新增团队协作、采购、会议卡种。
- 不修本文 §12 列出的既有缺陷。

### 3.3 L0 卡片分类学（覆盖范围）

初版规格只治理 A2UI 的 4 种交互卡，而 Matebot 实际渲染 **25 种消息块**。只治理 4 种等于承认另外 21 种各自为政——而**恰恰是这 21 种里带生命周期的那些，构成了重复推卡的另一半战场**（Grok 更新日志里 `one reconnect card instead of several` 就是同一个病）。

本节定义**哪些卡归内核管、哪些不归**。

**分类依据**：不是渲染技术（A2UI / RN / Web），而是**有没有「等用户决定 → 执行 → 落终态」的生命周期**。

| 分组 | 含义 | 归内核管 | 块类型 |
|---|---|---|---|
| **L0-A 交互型** | 有确认/执行生命周期，状态会变，需要结算 | **是** | `a2ui_surface`（4 intent）、`choice`、`ask`（含 `approvalEffectId`）、`app_connect`、`connect`、`mcp_approval` |
| **L0-B 过程型** | 只表达进行中，无用户决定 | 否（只读展示） | `progress`、`steps`、`subagent`、`child_bot`、`cloud_agent`、`handoff`、`skill_draft`、`import_setup` |
| **L0-C 内容型** | 只承载内容，无状态机 | 否 | `text`、`card`、`image`、`file`、`page`、`chart`、`meta`、`channel_message`、`bot_message_sent`、`bot_message_received` |
| **L0-D 设备/通话型** | 有状态但由设备侧驱动 | **部分**（见 §3.3.2） | `computer`、`voice_call`、`call_request` |

#### 3.3.1 归内核管意味着什么

L0-A 的每种块都必须满足四条，否则不算接入：

1. **有 `cardKey`**：同线程同场景只能有一张活的（复用 §4.1 的 `sha256(threadId + "\0" + intent)`，`intent` 取块的语义名如 `connect.gmail`、`approval.effect`、`question.clarify`）。
2. **状态落在 §4.3 的 13 值枚举**：不得自造 `pending` / `connected` 之类的私有状态词。
3. **终态经 `settleInteraction`**：不得直接改块的 `status` 字段。
4. **可交互性由 `surfaceAffordanceFor` 决定**：不得由各端自己判断。

#### 3.3.2 现状：三套机制重复覆盖同一场景（必须收口）

这是本次扩围要解决的核心缺陷。三个场景各有 2–3 套并行机制：

| 场景 | 机制 A | 机制 B | 机制 C | 收口方向 |
|---|---|---|---|---|
| 需要连接账号 | `connect` 块<br>`status: pending \| connected` | `app_connect` 块<br>`status: connected \| pending` | A2UI 卡 `needs_connection` | **统一为 `needs_connection` 状态**，两类连接块降级为「该状态的渲染形态」 |
| 需要批准 | `ask` 块 + `approvalEffectId` | `mcp_approval` 块 | A2UI 卡 `awaiting_approval` | **统一为 `awaiting_approval` 状态**，块只提供渲染差异 |
| 需要回答 | `ask` 块（自由文本） | `choice` 块（选项） | — | 两者合并为 `question` 语义，由 `choice.options` 是否存在决定形态 |

**收口方式（重要）**：不是把三种块删掉重写，而是**让它们成为同一内核状态的三种视图**。即：

```
内核 Interaction 行（唯一真相：status / cardKey / expiresAt）
        ↓ 派生
渲染块（connect / app_connect / ask / choice / mcp_approval / a2ui_surface）
```

块的 `status` 字段改为**由内核状态派生的只读快照**（与 §4.4 对 block `lifecycle` 的处理一致），不再独立可变。

#### 3.3.3 明确不做的部分

- L0-B/C 不接入内核：它们没有「等用户决定」的语义，硬套状态机是过度设计。
- `computer` / `voice_call` / `call_request` 只接入**终态投影**（通话结束、机器休眠），不接入确认生命周期——它们的「进行中」由设备通道驱动，不是卡状态。
- L0-A 接入**不新增业务卡种**：Grok 的采购、订单、会议卡需要 Matebot 没有的商业能力，不在讨论范围。

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

### 4.3.1 有效期（`expiresAt`）

Grok 的更新日志把审批卡有效期当产品参数调（`stay open for 30 minutes instead of 10`），说明「卡会过期」是真实需求。新增 `Interaction.expiresAt DateTime?`：

| 状态 | 默认有效期 | 依据 |
|---|---|---|
| `awaiting_approval` | **30 分钟** | 对齐 Grok 当前值；短于此用户来不及处理，长于此批准失去时效意义 |
| `ready_for_review` | 无 | 用户在编辑自己的草稿，不该被夺走 |
| `collecting` | 无 | 同上 |
| `needs_connection` | 无（用 `Still signing in?` 文案替代，见 §6.11） | 登录耗时不可控，强制过期会打断授权 |
| `unknown` | 无（D2） | 可能已发出 |

**过期由 worker 定时扫描驱动**（D6）：`expiresAt < now()` 且仍在开放态 → `settleInteraction` 转 `expired`。不用内存定时器。

**过期 ≠ 作废**（D7）：`expired` 卡展示**重试入口**，点击重新发起同一意图（复用 `cardKey`，原地复活或新建一张），见 §6.7。

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

**`resumePlan` 必须含账号身份**（§6.13）：`{ provider, accountId, displayEmail, intent, slots }`。多 Gmail 场景下只存 `provider` 会导致续跑连错账号——这是比多出一张卡更严重的问题。

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
| `expired` | **仅重试动作**（D7） | 折叠灰显 + 「重新发起」 |
| `failed` | **仅重试动作** | 折叠灰显 + 「重试」 |
| `cancelled` | 否 | 折叠灰显，带原因 |

**`reasonKey` 不是占位符——必须有明确分类。** Grok 的规则是 `Auto-review cards say what paused an action: your Ask first rule, your team's Ask first rule, or your Needs approval setting`。用户必须知道**是谁**让这张卡停在这里，否则无法判断该改什么。

| `reasonKey` | 触发来源 | 展示文案 |
|---|---|---|
| `rule.user` | 用户自己的 Ask first 规则 | 「你的规则要求先确认」 |
| `rule.team` | 团队空间的强制规则 | 「团队的规则要求先确认」 |
| `setting.approval` | 用户设置里的「需要批准」 | 「你的设置要求先确认」 |
| `effect.irreversible` | 不可撤销动作的硬性要求 | 「这一步不能撤销，需要你确认」 |
| `effect.amount` | 涉及金额/额度阈值 | 「涉及金额，需要你确认」 |

`reasonKey` 由内核在发布时算定并随卡存储，**不由前端猜、不由模型填**。文案走本端 locale。

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

**`expired` 例外——必须给重试入口**（D7，对标 Grok 的 `Check price again`）：

| 状态 | 按钮 | 点击行为 |
|---|---|---|
| `superseded` | 无 | 内容已被替代，重试只会制造重复卡 |
| `expired` | **重新发起**（动词受控，见 §6.4） | 复用原 `cardKey`，以原 `plan` + `slots` 重新发起，不询问模型 |
| `failed` | **重试** | 重跑同一计划 |
| `cancelled` | 无 | 用户主动放弃 |

`expired` 的重试**不新建卡**：原卡原地从 `expired` 回到开放态（`expiresAt` 重置）。这是 `cardKey` 设计的直接收益——**同一个 key 让它能「复活」而不是「繁殖」**。

### 6.7.1 历史投影必须带关键槽位

现状投影行只有标题，模型看不见卡里的关键信息：

```204:207:packages/core/src/attachments.ts
      if (block.kind === "a2ui_surface") {
        const intent = block.intent?.trim() || "a2ui_surface";
        const state = block.lifecycle ?? "draft";
        const hint = (block.summary ?? block.title)?.trim();
        return hint ? `[card: ${intent} → ${state} (${hint})]` : `[card: ${intent} → ${state}]`;
```

实际进模型历史的是 `[card: email.compose → succeeded (产品发布)]`——**没有收件人 `example@example.test`**。所以下一轮说「再发一封给同一个人」，模型只能猜。

**修复**：动作型卡的投影行追加关键槽位摘要（来自 `slots`，脱敏、长度受控）：

| 意图 | 必须出现的槽位 |
|---|---|
| `email.compose` | 收件人、主题 |
| `calendar.create` | 事件数、时间范围 |
| 其他动作型 | 注册表声明 `historyDigestFields` |

格式示例：`[card: email.compose → succeeded (收件人 example@example.test · 主题 产品发布)]`

这是把 D1 的修复补完整：**有摘要不够，摘要必须含模型下一轮真正需要的东西**。

### 6.8 进度与结果是文字行，不是新卡

截图 2 的「我来添加 Firecrawl。」→「Firecrawl 已添加。」对应 Matebot 的 `message_user` 短意图 + 最终回复。

**已满足，不要回退**：`interaction-email-outcome.ts` 用 `tx.interaction.updateMany` 原地更新卡状态，不新推结果卡。动作型卡执行后**只更新原卡 + 追加一句结果行**。

### 6.10 同一信息不得重复呈现

Grok 的规则：`The usage warning banner hides when the open chat already shows a usage-limit card`。

推广为通用规则：**同一条信息只允许一种主要呈现形态。**

| 场景 | 错误做法 | 正确做法 |
|---|---|---|
| 有卡在手 | 卡 + 额外横幅/提示条 | 只留卡 |
| 卡已终态 | 终态卡 + 「已完成」气泡 | 终态卡折叠成一行，不再追加气泡 |
| 待确认 | 卡 + 「请点击发送」独立消息 | 卡内页脚一句（`surfaceNudgeText`） |
| 用量超限 | 横幅 + 用量卡 | 只留卡 |

**判定**：同一次回合内，若某信息已由卡片承载，则 `message_user` 不得再输出同义文本。§6.8 是这条规则在「结果」上的特例（结果是文字行而非新卡），本规则是它的**反向约束**（已有卡时不要再补文字）。

### 6.11 卡片等待中的文案阶段

Grok 用文案而非新卡表达等待：`After 10 minutes, a connect card asks Still signing in?`

| 卡种 | 等待阶段文案 | 依据 |
|---|---|---|
| 连接卡 | < 10 分钟：正常等待<br>≥ 10 分钟：「还在登录吗？」+ 重新登录入口 | 对齐 Grok 的 10 分钟阈值 |
| 审批卡 | 剩余时间 > 5 分钟：正常<br>≤ 5 分钟：「还剩 N 分钟」 | 与 30 分钟有效期配套（§4.3.1） |
| 执行中卡 | 超过 30 秒：「仍在处理」 | 防止用户以为卡死 |

**全部是卡内文案变化，不推新卡**——与 §6.10 的去重规则同源。

### 6.12 卡加载失败降级为纯文本

Grok：`A pull request chip whose status can't load stays plain in the sentence, and its hover card offers Try again`。

规则：

- 卡的数据请求失败 → **不渲染残缺卡**，降级为一句纯文本
- 文本必须仍然可读、不丢关键槽位（与 §6.7.1 同源）
- 提供轻量重试入口（悬浮「重试」而非重新拉整张卡）
- **不允许**渲染空壳卡、骨架屏无限转圈、或显示内部错误码

### 6.13 多账号必须指名

Grok：`When one of your Gmail accounts signs out, the Bot names that account`。

| 要求 | 说明 |
|---|---|
| 连接卡标题含账号邮箱 | 「重新连接 searcheasyhub@gmail.com」而非「重新连接 Gmail」 |
| 卡片槽位存 `accountId` + `displayEmail` | 续跑时按账号恢复，不能笼统恢复 |
| 两个同名 provider 同时断开 | 出两张卡各指名一个账号，**不得合并成一张**「重新连接 Gmail」 |

这条同时修正 §5.5 的续跑计划：`resumePlan` 必须含账号身份，见下。

### 6.14 三端一致

| 端 | 改动 |
|---|---|
| Web / 桌面 | 调用 core 的 affordance + phase + copy，删本地判定 |
| Mobile | 同上，补 `event-list` 与日历阶段渲染 |
| 服务端投影 | `blocksToAgentHistoryText` 补 `superseded`/`expired`/`unknown` |
| Web / Mobile 共同 | 卡加载失败降级纯文本（§6.12）；同信息去重（§6.10）；`expired` 重试入口（§6.7） |

---

## 7. 对其他功能的影响（已核实）

### 7.1 不受影响

| 功能 | 依据 |
|---|---|
| Slack / Telegram / WhatsApp / Discord 等渠道 | 对 `a2ui_surface` / `present_interaction` **零引用**，不走卡片体系 |
| 定时任务 / 例行 / worker | 现状对 `interaction` **零引用**；本规格**新增**一个只扫 `expiresAt` 的过期任务（§4.3.1），不触及例行/记忆/文件逻辑 |
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
| **A 止血** | `cardKey` + 部分唯一索引 + 状态枚举 + `staleAt` 列 + `expiresAt` 列 + 内核 + `publishOrAmend` + 四入口统一 | 重复推卡闭环 |
| **B 兑现** | `surfaceAffordanceFor` + `surfacePhase` + 文案/词表收敛 + 终态展示 + 按钮标签 + 类别小标签 + 标题形态 | 用户真看到一张卡 |
| **C 加固** | 两段式新消息结算 + 连接卡续跑 + 事件表 + 历史投影（含关键槽位） | 结算、编辑、记忆、可追溯 |
| **D 收敛** | 注册表 `cardKind` + 46 处 intent 判断收敛 + 批准菜单四项 + `Bot.draftsDisabled` | 加一种卡 ≤3 文件；对标 Grok 菜单 |
| **E 全场景** | L0-A 收口：`choice` / `ask` / `app_connect` / `connect` / `mcp_approval` 接入内核；三套连接机制合一（§3.3.2） | 25 种块一套规则 |
| **F 渲染表达力**（可选，最后） | 自定义 Matebot catalog（`EventList`/`AttachmentList`/`StatusChip`/`DecisionMenu`/`NudgeFooter`）+ 协议族收敛到 `v0_9` | 领域卡声明化，三端同源（§15） |

每批独立可验证、可上线、可回滚。

**批内顺序建议**：C 批的「两段式结算」必须早于任何依赖 `superseded` 的功能上线，否则会先制造出「每次编辑换卡」的症状。D 批的 `Bot.draftsDisabled` 风险最高，单独做、最后做。**F 批必须在 A~E 之后**——先修生命周期再修渲染表达力，顺序反了会白干（好看的卡照样重复推）。

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
| AC-12 | L3 | `superseded` 三端不可交互；`expired`/`failed` 有且仅有重试入口 | 三端快照测试 |
| AC-13 | L3 | 日历与邮件走同一 `surfacePhase` | 表驱动测试 |
| AC-14 | L3 | 状态文案只从 `surfaceStatusCopy` 取值 | 源码扫描 |
| AC-15 | L3 | 按钮对象不可由模型自由提供 | 恶意输入测试 |
| AC-16 | L3 | 历史投影含终态 | 单测 |
| AC-16b | L3 | 历史投影含收件人/主题等关键槽位 | 单测：断言 `example@example.test` 出现在投影文本 |
| AC-17 | L3 | 批准菜单四项齐全，且「允许收件人」不跳过本卡发送 | DOM 测试 |
| AC-18 | L3 | 审阅型卡用「类别 + 内容」标题，决策型卡用问句 | 快照测试 |
| AC-19 | L1 | 审批卡 30 分钟后被 worker 扫描为 `expired` | 时间推进测试 |
| AC-20 | L3 | `expired` 卡重试复用原 `cardKey`，不产生第二张卡 | 集成测试 |
| AC-21 | L3 | 同信息不同时以文字与卡呈现 | 回合级断言测试 |
| AC-22 | L3 | 卡数据加载失败降级为纯文本，不含内部错误码 | 故障注入测试 |
| AC-23 | L3 | 多账号断开时各出一张指名账号的卡，不合并 | 快照测试 |
| AC-24 | L2 | `reasonKey` 由内核算定，前端与模型均不可覆盖 | 源码扫描 + 恶意输入测试 |
| AC-25 | L0 | L0-A 的 6 种块全部经 `settleInteraction` 落终态 | 源码扫描（按块类型枚举） |
| AC-26 | L0 | 连接场景只有一条出卡路径（`needs_connection`） | 集成测试：同一需求只产生一张连接卡 |
| AC-27 | 全 | 全量测试通过 | CI |
| AC-28 | F | 自定义 catalog 组件经 schema 校验后渲染，未知组件仍被拒 | 恶意 payload 测试 |
| AC-29 | F | 新增 catalog 组件三端实现同日上线，缺一不进白名单 | 白名单交叉检查 |
| AC-30 | F | 领域卡（行程/附件/状态标签）不再出现「一堵 Text 墙」 | 快照对比 |
| AC-31 | F | 代码只保留单一协议族，`v1_0` 分支删除且无存量数据 | 源码扫描 + `protocolFamily` 分布查询 |

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
| L0-A 收口触碰 25 种块中的 6 种 | 影响面大、回归广 | E 批单独立项；每块先加「派生式 status」再切读路径 |
| 审批卡过期误伤正在处理的用户 | 用户操作中断 | 30 分钟对齐 Grok；卡内倒计时提示（§6.11）；过期可重试（D7） |
| worker 定时扫描把所有开放卡误结算 | 大面积失效 | 只扫 `expiresAt IS NOT NULL`；`unknown`/`needs_connection` 恒为 NULL |
| 降级为纯文本后信息丢失 | 用户看不到内容 | 降级文本必须含关键槽位（AC-22） |
| F 批白名单扩大，攻击面随之扩大 | 模型可构造新组件 payload | 新组件只接受 props；逐组件 review；AC-28 恶意 payload 测试 |
| F 批被误当作「修重复推卡」的手段 | 顺序错乱，白干 | §15.7 顺序约束：F 批必须在 A~E 之后 |

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

---

## 14. 对标来源与逐条处置（`x.ai/changelog/bot`）

本规格第二轮评审逐条核对了 Grok Bot 官方更新日志，共发现 11 条与卡片表现层相关、初版规格未覆盖的行为。处置如下，便于后续核对不再遗漏：

| # | 更新日志行为 | 初版规格 | 处置 | 落点 |
|---|---|---|---|---|
| 1 | 审批卡 30 分钟有效期 | 裁掉 `expiresAt`（D3） | **推翻裁剪**，恢复并启用 | §4.3.1 |
| 2 | 过期卡给 `Check price again` | 定性为完全终态、不可交互 | **改为可重试** | §6.7、D7 |
| 3 | `one reconnect card instead of several` | 未覆盖连接卡 | 收口三套连接机制 | §3.3.2、AC-26 |
| 4 | 横幅在卡已显示时隐藏 | 未覆盖 | 新增去重规则 | §6.10、AC-21 |
| 5 | 卡说明**为何**暂停（你的规则/团队规则/设置） | 只有裸 `reasonKey` | 补齐原因分类表 | §6.1、AC-24 |
| 6 | 连接卡指名账号 | `resumePlan` 无账号 | 补账号身份 | §6.13、§5.5 |
| 7 | `Still signing in?`（10 分钟） | 未覆盖 | 新增等待阶段文案 | §6.11 |
| 8 | `Something else` / 多问步进 | 未覆盖 | `choice` + `ask` 合并为 question 语义 | §3.3.2 |
| 9 | 卡加载失败降级为纯文本 | 未覆盖 | 新增降级规则 | §6.12、AC-22 |
| 10 | 草稿卡列出附件 | 只提正文 | 附件进卡片内容清单 | §6.5 |
| 11 | Slack 审批卡 `Allow once` / `Skip` | 只有三端一致一句 | 归入 E 批渲染差异 | §8 E 批 |

**未采纳的 3 类**（需要 Matebot 没有的商业能力，明确排除）：购物/订单卡、Vault 支付卡、会议卡。它们的**表现层规则**（照片、价格、徽章、支付确认）对本规格无借鉴价值，但它们的**生命周期模式**（提交中 → 完成 / 过期可重试）已被吸收进 §4.3.1 与 §6.7。

---

## 15. A2UI 架构评估（F 批）

本节回答一个问题：**现有基于 Google A2UI 的前端架构，能否承载 Grok Bot 级别的表现层体验？需要替换吗？**

### 15.1 现状事实（已核实）

| 项 | 实际 |
|---|---|
| 依赖 | `@a2ui/web_core@0.15.0`、`@a2ui/react@0.15.0`（官方包，非同名自研） |
| 协议族 | `v0_9` / `v1_0` 双轨并存 |
| Catalog | **只用 basic catalog**，`compile.ts` 硬编码 `basicCatalogId(protocolFamily)` |
| 组件白名单 | `catalog-guard.ts` 钉死 18 个 basic 组件，未知组件挂载前拒绝 |
| Web 渲染 | `A2uiSurfaceHost` 走 `@a2ui/react`；email intent 改走手写 `EmailComposeEditor` |
| Mobile 渲染 | **完全手写 RN 渲染器**（`a2ui-native-surface.tsx` 518 行 + `a2ui-catalog.ts` 277 行），不用 `@a2ui/react` |

**basic catalog 表达力不足的实证**：日历批量在编译时被压成一个 `Text`——

```274:274:packages/a2ui-adapter/src/compile.ts
    components.push({ id: "event-list", component: "Text", text: batch });
```

源码自述：`the basic catalog has no Table or`。同理没有 Dropdown / Badge / AttachmentList，所以批准菜单只能手写 Radix 组件。

### 15.2 结论：优化，不重写

把 Grok 的体验优势按层拆开：

| 优势 | 层 | 换渲染框架有效吗 |
|---|---|---|
| 同动作一张卡、串行、新消息关闭、过期可重试 | 生命周期 | 否 |
| 动词+对象、暂停原因、账号身份、槽位摘要 | 数据 | 否 |
| 同信息不重复呈现 | 编排 | 否 |
| 加载失败降级纯文本 | 渲染容错 | 部分 |
| 类别小标签、间距、页脚、表格化行程 | **渲染** | 是 |

**九成以上在生命周期与数据层，A2UI 不负责那部分。** 本规格 G1–G16 全部落在生命周期/数据层，因此**与渲染器无关**——保留或替换 A2UI 都不影响其有效性；反之，只换 A2UI 而不动规格，用户体验不会有任何变化。

A2UI 提供的是**声明式渲染 + schema 校验 + 组件白名单**（模型无法输出任意 JSX）。这是安全资产，替换等于自建一遍且更易出漏洞。

### 15.3 已核实：0.15.0 官方支持自定义 catalog

这是 F 批成立的技术前提，已从 npm 包类型定义直接确认（非推测）：

**`@a2ui/react@0.15.0` 导出自定义组件工厂**

```typescript
// @a2ui/react 0.15.0 index.d.ts
declare function createComponentImplementation<Api extends ComponentApi>(
  api: Api,
  RenderComponent: react__default.FC<ReactA2uiComponentProps<ResolveA2uiProps<InferredComponentApiSchemaType<Api>>>>,
): ReactComponentImplementation;

declare function createBinderlessComponentImplementation(
  api: ComponentApi,
  RenderComponent: react__default.FC<ReactRenderProps>,
): ReactComponentImplementation;
```

**`@a2ui/web_core@0.15.0` 的 surface 支持多 catalog**

```typescript
// src/state/surface-model.d.ts
readonly availableCatalogs: ReadonlyMap<string, Catalog<T, F>>;
constructor(
  id: string,
  defaultCatalog: Catalog<T, F> | undefined,
  availableCatalogs?: ReadonlyMap<string, Catalog<T, F>> | null,
  ...
);
```

**catalog 可按 id 解析，且可在代码中定义**

- `resolveSurfaceCatalog(surface, catalogId, subject)` 按条目自带的 `catalogId` 选 catalog
- `Catalog.fromJson` / `toJson`；文档明示「A catalog defined in code may leave them all out」

**结论：自定义 catalog 是官方支持的扩展点，不是 hack。** 当前代码没用它（`compile.ts:84` 硬编码 basic），这是**未使用的能力**，不是架构限制。

### 15.4 F 批范围：增加 Matebot 领域 catalog

目标不是「更好看」，而是**把「每张卡手写三遍」变成「声明一次、三端映射」**。

| 新增 catalog 组件 | 替代现在的 | 解决的问题 |
|---|---|---|
| `EventList` / `EventRow` | 日历批量压成一个 `Text` | 行程可扫读；免手写 |
| `AttachmentList` | 无 | 附件进卡（§14 第 10 条） |
| `StatusChip` | 手写 | 类别小标签、状态标签统一（§6.4） |
| `DecisionMenu` | 手写 Radix 菜单 | 四项批准菜单声明化、三端同源（§6.6） |
| `NudgeFooter` | 手写 | 「点击发送即可发出」统一（§6.10） |

**必须保留手写**：`EmailComposeEditor`（真实文本编辑、光标、IME）。强行塞进 catalog 是过度设计，会牺牲体验换「纯粹」。

**配套改动**：

1. `compile.ts` 的 `catalogId` 从 `basicCatalogId()` 改为按 intent 选择 catalog（basic / matebot）
2. `catalog-guard.ts` 白名单扩展为「basic ∪ matebot」，且**每个新组件必须是无副作用纯展示组件**——安全面随白名单扩大
3. Mobile 的 `a2ui-catalog.ts` 增加新组件映射（工作量主要在这里）
4. 新增组件必须同时有 Zod schema（服务端校验）与三端实现，缺一不得进白名单

### 15.5 明确不做

- **不替换 A2UI**：九成问题不在它；替换成本极高且收益不对应。
- **不用 A2UI 表达所有卡**：L0-B/C（进度、图片、文件）无需声明化。
- **不为了「统一」而牺牲复杂卡体验**：`EmailComposeEditor` 继续手写。
- **不新增业务卡种**（购物、订单、支付）——无对应能力。

### 15.6 协议族收敛到 `v0_9`（D8）

当前 `v0_9` / `v1_0` 双轨并存，两套 schema 模块（`WebCoreV09Module` / `WebCoreV10Module`）都要维护。

**决定：收敛到 `v0_9`，删除 `v1_0` 分支。**

依据：

- 双轨没有功能收益，只是维护成本与分叉风险
- `@a2ui/web_core@0.15.0` 导出 `./v0_9/basic_catalog`，v0.9 线完整可用
- `SpecVersion` 枚举含 `v0.8` / `v0.9` / `v0.9.1` / `1.0`——**收敛时要把 patch 版本也钉死**，避免 `v0.9.1` 悄悄进入

保留 `A2uiProtocolFamily` 类型本身（未来升级时改一处），删除 `v1_0` 的编译分支与测试。

### 15.7 F 批风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 白名单扩大 | 模型可通过新组件扩大攻击面 | 新组件只接受 props，不接受 action 之外的副作用；review 逐组件过 |
| Mobile 映射工作量被低估 | F 批拖期 | F 批单独立项、独立验收，不阻塞 A~E |
| 自定义 catalog 与 basic 混用导致渲染分叉 | 同一卡在不同端长相不同 | 每个新组件必须三端同日上线，否则不进白名单 |
| 协议收敛删 `v1_0` 时漏改存量数据 | 老 surface 渲染失败 | 先查存量 `protocolFamily` 分布，为零才删分支 |

**顺序约束**：F 批必须在 A~E 跑通之后。**先修生命周期，再修渲染表达力**——顺序反了会白干（好看的卡照样重复推）。
