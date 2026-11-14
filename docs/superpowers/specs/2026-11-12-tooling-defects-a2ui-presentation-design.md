# 工具缺陷与 A2UI 表现契约

日期：2026-11-12  
基线：`matebot-src` main `027c9e81`  
来源：`MATEBOT-TOOLING-ARCHITECTURE-REPORT.md` 缺陷 D1–D9，以及同日 brainstorming 定稿。

本文是设计规格，不是实现计划。实现前须再写 plan。B 轨（表现契约）合入前必须单独审批。

## 1. 问题与目标

目录、闸门、身体能力、A2UI 呈现四层已经存在，但有几处分类漂移和契约缺口：连接器缺 `readOnly`、内建第二数组逃出闸门集合、`find_tool` 索引无预算、连接撤销后工具静默消失、电脑能力按 kind 字符串硬编码、A2UI 卡片不进模型历史、`effectKind` 写死为邮件/日历两值。

目标：一次补齐**共用契约**，使以后加产品 intent 只注册一行，不再重做表现层；同时修掉闸门/目录上已核实的缺陷。

成功标准见第 7 节。不把每个底层工具做成一张 A2UI 卡，也不在本轮加第五个面向用户的 intent。

## 2. 已锁定的产品决策

| 决策 | 选择 |
|---|---|
| 规格包装 | 一份规格、两轨实现；B 轨可整段剪掉 |
| 能力表「全量扩」 | 一次做完表现**契约**；产品 intent 仍为现有 4 条 |
| 通用性证明 | 测试模块内的假能力（第三域），生产不注册 |
| 未安装应用发现 | 本轮不做（不把市场技能正文注入提示词） |
| 做法 | 方案 2：A 轨契约不变的修补 + B 轨表现契约 |

「A 轨本地」指**改动不改变对外契约**，代码在 API / adapters / core，不是客户端离线修复。两端都以服务端为主。Web/Mobile 不新造 `MessageBlock.kind`。

## 3. 非目标

- 不新增产品 intent（无 `calendar.delete` / `calendar.update` / 按应用一张卡）。
- 不从连接器 `inputSchema` 自动生成 A2UI 表单。
- 不让 A2UI 点击暂停 run；不把 `present_*` 移出审批豁免（避免写信双重确认）。
- 不改已有工具名（D7 是契约，不是 bug）。
- 不落地 `docs/architecture/tool-tiers.md` 全文。
- 不放宽「插件不在控制面执行仓库代码」（D9）。
- 不给模型未安装插件的技能正文，不新增「搜市场」工具。
- 本轮不接 SimuLang。

## 4. 架构

模型每条 `tool_call` 只走一种已登记形状，由该工具的 JSON schema 约束：

- 普通工具：`{ name, arguments }`（如 `connect_app({ app: "gmail" })`）。
- `present_interaction`：arguments 为 `{ intent, fields }`。这不是第二条协议，只是这个工具的入参。

一轮可以有多条 `tool_call`，但每一条都是确定的工具名 + schema。不能做成「整轮只能二选一」，因为同一句话里经常要先 `skill_read` 再 `present_interaction`。

中间仍是唯一闸门 `gateToolCall`，键是 `route` 不是展示名。

时间线上继续两种职责不同的卡（理解正确：就是 A2UI 卡和 ask 卡）：

| | ask | `a2ui_surface` |
|---|---|---|
| 谁发出 | 闸门认为要人点头 | 模型调用 `present_interaction`，服务端编译 |
| 点击之后 | 唤醒 run 继续 | 创建并执行 `ExternalEffect`，**不**唤醒模型 |
| 人能否改载荷 | 否 | 能（闭集字段） |
| 用途 | 确认/拒绝写操作 | 填表后再执行 |

连接卡 `app_connect` 保持现有块，本规格不改它的协议。技能（SKILL.md）仍是安装后的知识层，不进入能力表。

```
tool_call
    → ToolRequest
    → gateToolCall
          ├─ 免审且非 present_*     → handler / connector.execute
          ├─ 需确认                 → ask，run = waiting_input
          └─ present_interaction    → 能力表 → 编译 surface（run 不暂停）
```

分流不让模型再选「出哪张卡」：

- 工具名是 `present_interaction`（及 `edit_interaction` / `cancel_interaction` / `present_result` / `refresh_result`）→ A2UI。intent 必须在生产 `INTERACTION_CAPABILITIES`。不在表里：工具返回错误字符串，不渲染空卡，也不改走 ask。
- 闸门判定需确认 → ask。batch 按内层动作裁决；卡片按条或一条卡内逐项，结算后 `pending` 必须消失。
- 其余 → 直接执行。

呈现声明本轮只存在于 `InteractionCapability.presentation`（已有 `form` / `result` / `progress`）。不给 `ConnectorTool` 新增 `presentation` 字段：未进能力表的写工具一律走闸门 ask，只读直接执行。邮件/日历继续由模型调 `present_interaction`。

## 5. A 轨：契约不变的修补

不改工具名、不改 A2UI 协议、不改点击是否唤醒 run。

### D3 — 内建分类单一来源

`BUILTIN_AGENT_TOOL_NAMES` 必须等于主数组 ∪ `agentConnectionTools`（或合成一个导出，executor 不再二次拼接）。

- `connect_agent`、`message_agent` 列入 `APPROVAL_REQUIRED_BUILTIN_TOOLS`。只改集合、不改审批名单，会把跨人连接变成自动放行。
- `respond_agent_connection` 保持 explicit。
- 三个连接工具**不进** `CORE_BUILTIN_TOOL_NAMES`，走 `find_tool`。
- 测试：每个导出的内建名都在 `BUILTIN_AGENT_TOOL_NAMES` 中。

### D4 — `find_tool` 索引预算

`bridgeTools` 调用已有 `fitsNameIndexBudget`（200 名 / 2048 字节）。超限时降级为与惰性目录相同的分组摘要，而不是内联全名。

### D2 — 连接器 `readOnly`

Composio `mapOneTool`（及同类映射）有元数据则写出 `readOnly`。闸门：有声明认声明；无声明才用名字启发式。行为对无元数据的工具与今天兼容。

### D8 — 撤销后占位

占位条件与 MCP 一致：**已分配/已有连接记录，但本轮列不出工具**（撤销、session 失败、单应用 discovery 失败）。用户从未连接、目录本来就是空的，继续 `return []`，不插入占位（避免每个新用户都看见 `composio__unavailable`）。

占位工具只读，名字照抄 MCP 形态（`composio__unavailable` 或 `pipedream__<app>__unavailable`）。调用只返回同一句：已断开，请 reconnect，不要用 `shell` 手写客户端。Pipedream 单应用失败仍不得挡住其他已连应用。

### D6 — 身体能力查询

删除 kind 字符串白名单，改读 `provider.describe().capabilities`：

- 终端 → 已有 `pty`
- 快照入口 → 已有 `snapshots`
- 原地升级 → 新增布尔字段 `inPlaceUpdate`（desktop / wuying / none 为 false，其余默认 true）。这是为了删白名单所必需的一列，不是无障碍/视觉能力。

`snapshot()` 在 `snapshots === false` 仍被调用时 `throw`，当作断言而不是静默 no-op。不增加 `accessibilityTree` / `visionGrounding` / `recipeRuntime`。

### D7

无代码变更。规格将其定为不变式：已有工具名不改；新目录前缀继续经 `catalogToolPrefix` 避开 `mcp_`。

## 6. B 轨：表现契约（框架变动，须审批）

### D1 — 历史回边

`blocksToAgentHistoryText` 增加 `a2ui_surface` 分支。优先 `intent` + `lifecycle` + `title`/`summary` 压成一行，例如：

```
[card: email.compose → sent (to: a@b.com)]
```

旧事件缺字段时降级为 `[card: a2ui_surface]` 一类短行，**禁止**落到空串再被 `filter(Boolean)` 丢掉。不把完整正文/字段表塞进历史。引用路径已读 `title||summary`，本轨不改 quote 行为，除非历史格式需要与 quote 对齐时只加测试。

### 能力表与 `effectKind`

`InteractionCapability.effectKind` 从 `"email.send" | "calendar.create" | null` 改为 `string | null`（空表示只读、无效果）。产品注册表仍是：

- `email.compose`
- `calendar.create`
- `calendar.query`
- `interaction.result`

注释「Extend-first: no new table」保持。本轮**不加**产品行。以后加 intent 不是运维热配，必须按第 6.1 节清单改代码。

### 通用性证明

测试专用假能力（例如 `test.form`）：第三域、`presentation: "form"`、字段只用现有 7 种控件、能经 `compile-surface` 编译、历史分支能投影。不得走邮件专用模板/邮箱预检分支。此能力**不**加入生产 `interactionIntents()` 提供给模型的列表。B 轨假能力只证明编译 + 历史，不证明第三域已能执行。下一条真实 form intent 必须做完第 6.1 节第 3–4 步，否则用户点主按钮但 `executed: false`。

### 6.1 以后加产品 intent（代码清单，非本轮范围）

加 intent 是工程改代码，不能只改 JSON/环境变量，也不能从 Composio `inputSchema` 或 SKILL.md 自动登记。先判断该不该做成 intent：

| 需求 | 做法 |
|---|---|
| 用户要改字段再执行 | 新 A2UI form intent，走下列 8 步 |
| 只需确认/拒绝 | 现有 `ask`，不要新 intent（`calendar.delete` 属于这类） |
| 只读结果 | `presentation: "result"`，`effectKind: null`，做到第 2 步即可 |
| 还没连接 | 现有 `connect_app`，不要 `*.connect` intent |

**8 步（form intent）：**

1. **准入。** 有可编辑闭集字段、恰好一个主按钮、明确副作用、需要的连接类型。字段只能用现有 7 种控件（`text` / `longText` / `number` / `email` / `dateTime` / `boolean` / `choice`）。
2. **登记一行。** 在 `INTERACTION_CAPABILITIES` 增加 `{ intent, label, schema, requiresConnection, effectKind, readOnly, implemented: true }`。不加新表、不加新 `MessageBlock.kind`。`interactionIntents()` 会自动带上新名。
3. **用注册表的 `effectKind` 写 ExternalEffect。** 不要再写 `if (intent === "email.compose")`。今天 `interactionEffectKind()` 把非邮件收成 `"interaction.confirm"`；本轮 B 轨把类型放宽后，下一条产品 intent 必须改为读 `findInteractionCapability(intent)?.effectKind`。
4. **执行适配。** 在 `executeConfirmedInteractionService`（或抽出的按 kind 分发）实现该 `effectKind`：认连接、claim effect、调 connector、写回 lifecycle。今天非 `email.send` / `calendar.create` 会 `executed: false` 直接返回。抄邮件/日历的幂等，不要新审批表。
5. **连接。** `requiresConnection` 非空时接到现有 `resolveCapabilityConnection`；没有连接走 `connect_app`，不新卡种。
6. **域专用逻辑（可选）。** 时区、邮箱预检、禁止误邀等放该域模块（如 `calendar-event.ts`），不写进编译器。
7. **提示词。** 必要时给 `present_interaction` 的 description 补一句何时用新 intent。
8. **测试。** 编译、历史投影、确认/执行/幂等、未知 intent 仍失败。客户端继续通用 catalog 渲染，除非该域要专用编辑器。

插件继续是：安装 MCP + 技能 → 连接器工具；确认走 ask；只有「填表再执行」才走这 8 步。

### D5 体验（ask，不是新 intent）

`calendar.delete` 一类确认操作继续走 ask，不进 A2UI。`approval-ask`：batch 按内层动作展示；effect 结算后该 ask 的 `status` 不得停留在 `pending`。文案尽量用内层工具/业务名，避免只显示 `Review before COMPOSIO_MULTI_EXECUTE_TOOL`。

### 兼容

- 字段种类闭集不变（`text` / `longText` / `number` / `email` / `dateTime` / `boolean` / `choice`）。
- 客户端继续渲染现有 `ask` 与 `a2ui_surface`。
- 邮件/日历现有编译、预检、版本、点击校验必须保持。
- `present_*` 仍在 `APPROVAL_EXEMPT_TOOLS`。

## 7. 验收

### A 轨

- 每个导出内建名 ∈ `BUILTIN_AGENT_TOOL_NAMES`；跨人三工具必审且延迟；CORE 不含它们。
- `find_tool` 超预算时 description 不含全量名单，含降级摘要。
- 有 `readOnly: true` 的连接器工具走只读路径；`readOnly: false` 必审。
- 已有连接记录但本轮发现失败/撤销：模型能看见占位工具；从未连接仍是空目录。占位调用返回 reconnect 说明。
- Wuying：`pty === false` 且 `inPlaceUpdate === false` 时不提供终端、不出现原地升级。

### B 轨

- 已发送或用户改过字段的 surface，下一轮历史非空，含 intent 与可见状态。
- 生产 `interactionIntents()` 仍恰好 4 个产品 intent。
- 假能力测试通过编译与历史投影；生产 intent 列表不含它。
- 未知 intent：工具错误，时间线无空 `a2ui_surface`。
- batch 写：闸门按条问；结算后无悬挂 pending ask。

回归：邮件/日历 A2UI、`connect_app` 卡、审批豁免名单、现有 computer 生命周期测试。

## 8. 测试落点

单测加在现有文件，不新开 E2E 框架。

| 覆盖 | 文件（现有） |
|---|---|
| 内建名集合 | `packages/adapters/src/index.test.ts` |
| find_tool 预算 | `packages/adapters/src/builtin-tool-bridge.test.ts` |
| 审批 / readOnly | `packages/core/src/action-approval` 测试 |
| 占位工具 | composio / pipedream connector 测试 |
| capabilities 查询 | `packages/adapters/src/computer-lifecycle.test.ts` |
| 历史投影 | `packages/core` 中 `blocksToAgentHistoryText` 测试 |
| 假能力 | `packages/core/src/interaction-capability.test.ts`（及编译测试） |
| ask 结算 | `packages/adapters/src/approval-ask` 相关测试 |

假能力只存在测试模块或测试专用注册函数，不进生产导出给模型的 intent 列表。

## 9. 错误处理

- 未知 intent / 未实现能力：`present_interaction` 返回错误字符串，不抛未捕获异常，不写空卡。
- 占位工具：任何调用返回同一说明，`readOnly: true`。
- catalog 无匹配：`connect_app` 保持现有 `No such app is available in the connector catalog.`
- `snapshot()` 在能力为 false 仍被调用时 throw。
- 审批名单漏改导致 D3 权限回退：由「内建名必须在闸门集合」和「跨人工具必审」两条测试拦住。

## 10. 风险与审批门

| 风险 | 处理 |
|---|---|
| 只把三工具加进 `BUILTIN_AGENT_TOOL_NAMES` 而不列入必审 | 规格强制与测试绑定，禁止拆开合入 |
| 历史行过长污染上下文 | 只投影 intent/lifecycle/短 summary，上限跟现有 ask 历史风格一致 |
| `effectKind` 放宽后邮件专用代码仍绑死 | 假能力测试禁止走 email 模板 |
| B 轨比 A 轨争议大 | A 可单独合；B 合入前必须审批 |

## 11. 模块清单（实现时对照）

A 轨：`run-tool-selection.ts`、`builtin-tools.ts`、`builtin-tool-bridge.ts`、`action-approval.ts`、`composio-connector.ts`、`pipedream-connector.ts`、`computer-lifecycle.ts`。

B 轨：`interaction-capability.ts`、`attachments.ts`、`compile-surface.ts`（仅确认假能力可走通用路径，不为假能力加生产分支）、`approval-ask.ts`。

不改：`catalogToolPrefix` 的 `mcp_` 避让、插件「不执行仓库代码」、`app_connect` 块契约、字段控件枚举。
