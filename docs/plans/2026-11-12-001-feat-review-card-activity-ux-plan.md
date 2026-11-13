---
title: feat: Review card and activity UX
type: feat
status: active
date: 2026-11-12
---

# feat: Review card and activity UX

## Summary

把任意对话的等待态和收尾改成「人能看懂」：邮件卡去掉「未提供」和 Gmail id；所有工具的 live 行都是短意图（不出现 Python/PowerShell/工具 slug）；完成后 Bot 只留一句结果和必要的下一步（审阅卡、点发送），不要复盘过程。本轮只改展示、活动文案和回复指引，不改发信协议、不自动发信、不做 UAC 产品界面。

---

## Problem Frame

对照 Grok Bot 与 simulang 在 `matebottest` 里的真实对话：登录账号可以和发件邮箱不是同一人（设计相同），但卡片写死 “Email address not provided”，发送成功摊出 `providerMessageId`，电脑任务的 live 行是截断命令。批准规则已在设置「Approvals」里，没有长在卡片上。「请点 UAC」只是模型的 `message_user` 句子，不是 Matebot UI。

---

## Assumptions

*本计划未经单独的 scope 确认回合。下列是从对话推断的执行约定，审批时请一并核对。*

- 桌面端托管 Web UI，改 `apps/web` 即覆盖 Windows 桌面；手机端必须同步同一套文案与状态。
- 发件人显示的是 **Composio 已连接邮箱**，不是 Matebot 登录邮箱。
- 本轮 **不跳过审阅卡、不自动发送**。「允许收件人」若无法按收件人匹配，就做成工具级 `always_allow`，文案必须诚实，不能假装已按收件人生效。
- 不新增 UAC 卡片。电脑等待态用意图句；真要人点系统对话框时，主提示仍是意图句，不是命令。
- 活动行今天就是英文（`describeToolActivity`）；本轮把内容改成人话，不另做活动行中文化。邮件卡片文案走 Lingui（含中文）。
- 新文案不写供应商名（AGENTS.md）。连接自己的 `displayName` 可以继续显示。
- 「正在做 / 接下来做什么」拆成两层：等待中只报当前意图（Grok 的「正在发送邮件」）；完成后那句才说结果 + 用户要做的下一步。不在 live 行预告后续工具队列。
- 收尾变短靠系统回复指引，不能 100% 禁止模型偶发写长；本轮改 prompt + 测试指引文案，不加 LLM judge。

---

## Requirements

- R1. 已连接时，From 不再出现 “Email address not provided”。有真实邮箱就显示邮箱；没有就只显示连接名或 “Connected account”。
- R2. 发件人只读，不是表单字段；不用登录邮箱冒充 From。
- R3. 发送中主文案为「正在发送邮件」一类意图句；发送中锁定编辑和发送。
- R4. 发送成功只显示「已发送」；Gmail `providerMessageId` 不出现在卡片主界面（可留在数据里）。
- R5. 任意对话类型的 live 活动行都不展示命令、脚本、Python/PowerShell 正文或连接器内部工具名（如 `COMPOSIO_MULTI_EXECUTE_TOOL`、`GMAIL_SEND_EMAIL`）。默认短意图。连续相同意图叠成 `×N`。
- R6. 「Show tool activity」仍可看到步骤卡，标签同样是意图句，不是截断命令。
- R7. 邮件卡上「需要批准」变成可操作菜单：至少「需要批准」（当前）和「管理规则」（打开已有 Approvals 设置）。若接「允许发送」，必须走现有 `approvalRules.set`，且不跳过本张卡的发送。
- R8. 草稿 Bot 旁白说清楚「尚未发送」；空草稿说明还缺收件人/主题，不假装已经拟好。
- R9. CC 不再用 `name@example.com` 这种假地址占位。
- R10. Web / 桌面 / 手机同一套行为。
- R11. 等待行只描述「正在做什么」；不在 live 行预告整条工具队列。
- R12. 任务结束后的普通回复应短：已完成的事实 + 若需要用户动手则一句下一步。不复述步骤、不贴代码、不写过程汇报。用户明确要看数据/报告时除外（例如「把表格内容汇总给我」应给结果，不是空话）。
- R13. `message_user` 中途更新同样禁止贴命令/代码。

**对话来源：** Grok Bot 对比中的 P0–P2，以及「UAC 不是产品 UI」的澄清。

---

## Scope Boundaries

- 不改发信 / confirm / execute 协议，不改 Composio 授权模型。
- 不把 Matebot 登录邮箱当作 From。
- 不新增收件人维度的 `matchKind`，不自动跳过以后的审阅卡。
- 不做 UAC / 系统提权的产品界面。
- 不把原始命令做成新的持久化 `detail` 字段（避免合同膨胀）；本轮接受「详情里也是意图句」。
- 不改电脑工具的实际执行（bat / Temp / 提权脚本照旧）。
- 不中文化 `describeToolActivity` 的英文活动行。
- 不落地 `docs/architecture/tool-tiers.md`，不打包/部署（除非另嘱）。

### Deferred to Follow-Up Work

- 按收件人「下次免批、不再出卡」（需要新匹配规则 + 跳过 `present_interaction`）。
- 「为此 Bot 关闭草稿」偏好（没有现成设置项）。
- 活动行按用户语言本地化。
- 从 Composio 拉真实邮箱若当前 list 载荷里没有 email 字段：本轮不新增远程探测；只在**已经返回的字段**里取。取不到就显示连接名，仍然去掉「未提供」。
- 电脑步骤按「读表 / 复制 / 汇总」语义合并成 2–3 步（需要解析命令，超出本轮）。
- 用 LLM judge 强制收尾长度（本轮只改指引）。
- 历史消息里已经写下的 PowerShell 行不会被回溯改写。

---

## Context & Research

### Relevant Code and Patterns

- 邮件卡：`apps/web/src/components/a2ui/EmailComposeEditor.tsx`（From 注记、CC 占位、`Sending`、成功态摊 `providerMessageId`、静态 `Needs approval`）。测试在 `apps/web/src/components/a2ui/A2uiSurfaceCard.test.tsx`。
- 手机卡：`apps/mobile/components/thread/a2ui-native-surface.tsx` 与 `apps/mobile/lib/a2ui-native-surface.test.tsx`。
- 发件人戳：`packages/adapters/src/run-tools-interaction.ts` `interactionPublishCapability` 只写 `sender.label = connection.displayName`。`DraftSender.address` 已存在但未戳上卡片。`senderLabel` 合同注释明确「不是地址」。
- 草稿旁白：`packages/core/src/interaction-nudge.ts` `A2UI_SURFACE_NUDGE`（有意做成一句，字段在卡片上）。
- Live 等待行：`describeToolActivity` → `progress.activity` → `liveActivityLine` → `apps/web/src/pages/shell/transcript.tsx` 的 `workingLabel`（手机 `thread-screen.tsx` 同样）。用户看到的 PowerShell 就是这里。日历/邮件连接器未单独映射时会落到 `Using COMPOSIO_MULTI_EXECUTE_TOOL` / `Using GMAIL_…`。
- 收尾长度：`packages/adapters/src/run-replies.ts` `longWorkProgressGuidance` 目前要求 “complete final answer”，等于鼓励写长。`executor.test.ts` 钉死了这句。
- 步骤折叠：`packages/core/src/events.ts` 相同 `label` 会 `count + 1`。
- 批准规则：`apps/web/src/components/ApprovalRulesSettings.tsx` + `rpc.approvalRules.set`；设置分区 `confirmations`。`present_interaction` 在批准豁免名单里——**卡片本身就是发信审阅**，规则管的是工具，不是这张卡的 Send。
- 设置入口：`apps/web/src/pages/Shell.tsx` `openSettings(section)`；`SettingsSection` 含 `"confirmations"`。
- 文案纪律：根目录 `AGENTS.md`（能删则删；新文案要在 PR 里引用；UI 不写供应商名）。

### Institutional Learnings

- 本仓库 `docs/solutions/` 无直接相关条目。先前对话已核实：simulang 连接的是 `lizer2009@gmail.com`，卡片却写未提供；`1a1ce98a8aee8064` 是 `providerMessageId`；UAC 句来自 `external_effects.message_user`。

---

## Key Technical Decisions

- **From 显示优先级：** `senderAddress`（仅当服务端从供应商账户记录读到邮箱）→ 否则 `senderLabel` → 否则 “Connected account”。删除常驻「未提供」注记。
- **地址字段：** 在 `a2ui_surface` 上增加可选 `senderAddress`（additive）。禁止把 `displayName` 或「看起来像邮箱的 label」当成地址（现有 `interaction-readback` 测试必须继续成立）。
- **等待态单一来源：** 改 `describeToolActivity`，覆盖所有工具族，不只是 shell。`user_computer_shell` / `shell` 固定意图句、不附带 `command`。`COMPOSIO_MULTI_EXECUTE_TOOL` 展开内部 `tool_slug` 映射到意图（发信/读日历/查邮件），绝不显示包装工具名。未知工具用 “Working…” 一类兜底，不用 slug。相同标签叠 `×N`。
- **发送中文案：** 卡片 StatusLine 的 Lingui `Sending` 改为「正在发送邮件」语义；线程 live 行若工具是发信/出卡，同样用意图句（`present_interaction` 已是 “Preparing an editable draft”；补上 execute 路径若会冒命令）。
- **批准菜单不改变本张卡：** Send 仍要人点。菜单项「管理规则」只打开 `openSettings("confirmations")`。「允许发送」若做，只写 `email.send`（或现有 email 类工具名）的 `always_allow`，并在菜单里写明：这不管本张卡，也不按收件人。
- **旁白仍是一句：** 不把 To/Subject/Body 复述进聊天。空草稿 vs 已填草稿用两句不同 nudge，都点明尚未发送。
- **收尾指引：** 改 `longWorkProgressGuidance`：完成后 1–3 句；有结果给结果；要用户动手时只说下一步；不要逐步复盘、不要贴命令。与 “complete final answer” 对着改，并更新钉死旧句的测试。
- **CC：** 去掉假邮箱 placeholder；空着或「添加抄送」即可。

---

## Open Questions

### Resolved During Planning

- 发件人是否应等于登录账号：否，与 Grok 相同，等于已连接邮箱。
- 「请点 UAC」是否产品 UI：否，是模型 `message_user`；本轮不做 UAC 界面。
- 是否本轮只做 UX：是。不改发送/授权协议。

### Deferred to Implementation

- Composio `connectedAccounts.list` 当前载荷是否已含 email：执行时读现有适配器映射；有则戳 `senderAddress`，无则不加新请求。
- 「允许发送」菜单项对应的精确 `matchValue`（`email.send` vs 连接器 slug）：执行时对照 `action-approval` 里邮件发送实际使用的工具名，避免写一条永远匹配不上的规则。

---

## High-Level Technical Design

> *方向说明，不是实现规格。*

```text
[Live wait]
  tool_execution_start
    → describeToolActivity(name, args)   // intent only, no argv
    → progress { activity: true, text }
    → liveActivityLine → transcript/mobile working label

[Email card]
  capability ready
    → From: senderAddress ?? senderLabel ?? "Connected account"
    → no "not provided" note
  submitting/executing
    → StatusLine "Sending email…"; fields + Send locked
  succeeded
    → "Sent" only; providerMessageId not rendered
  draft
    → Approval menu: Needs approval | (optional Always allow send) | Manage rules
    → Manage rules → settings?section=confirmations

[Nudge]
  presented + missing to/subject/body → incomplete line
  presented + complete → "review the card, not sent yet"
```

---

## Implementation Units

- U1. **发件人行：去掉「未提供」，有地址才显示地址**

**Goal:** From 不再像没授权。登录邮箱绝不出现在这里。

**Requirements:** R1, R2, R10

**Dependencies:** None

**Files:**
- Modify: `packages/contracts/src/interaction.ts`（可选 `senderAddress`）
- Modify: `packages/adapters/src/interaction-publish.ts`、`run-tools-interaction.ts`、`run-tools-interaction-edit.ts`（传递 stamp）
- Modify: `apps/web/src/components/a2ui/EmailComposeEditor.tsx`
- Modify: `apps/mobile/components/thread/a2ui-native-surface.tsx`
- Test: `apps/web/src/components/a2ui/A2uiSurfaceCard.test.tsx`
- Test: `apps/mobile/lib/a2ui-native-surface.test.tsx`
- Test: `packages/adapters/src/interaction-readback.test.ts`、`interaction-email-projection.test.ts`（label 仍不能冒充地址）

**Approach:**
- 卡片主行：`senderAddress ?? senderLabel ?? Connected account`。删除 `a2ui-email-sender-note`。
- 仅当供应商账户记录里已有邮箱时写入 `senderAddress`。禁止用登录用户 email、禁止用 `displayName`。
- 连接卡 / 重新授权卡仍然不显示 From（现有行为）。

**Patterns to follow:** `DraftSender` 的 address vs label 分工；`senderLabelFromBlock` 的生命周期拷贝方式同样拷贝 `senderAddress`。

**Test scenarios:**
- Happy path: `senderAddress=lizer@example.test` → From 显示该地址，无「未提供」注记。
- Happy path: 只有 `senderLabel=Email` → From 显示 `Email`，无注记。
- Edge: 无 label 无地址 → “Connected account”。
- Edge: label 形如邮箱但无 `senderAddress` → 仍当 label，不当地址（与 readback 测试一致）。
- Integration: 重写卡片（confirm/execute）后 `senderAddress` 不丢。

**Verification:** 上述测试通过；Web/手机卡片 ready 态看不到 “Email address not provided”。

---

- U2. **发送中与发送成功的卡片状态**

**Goal:** 等待时像在发信；成功后不像系统报错。

**Requirements:** R3, R4, R10

**Dependencies:** None（可与 U1 并行）

**Files:**
- Modify: `apps/web/src/components/a2ui/EmailComposeEditor.tsx`（StatusLine）
- Modify: `apps/mobile/components/thread/a2ui-native-surface.tsx`
- Modify: 对应 Lingui / `apps/mobile/lib/locales/zh.ts`（及现有其它 locale 文件中的同一 key）
- Test: `A2uiSurfaceCard.test.tsx`、`a2ui-native-surface.test.tsx`

**Approach:**
- Progress：Spinner + 「正在发送邮件」（英文源文 `Sending email`）。
- Success：只保留 Sent / 已发送；去掉 `a2ui-email-provider-id` 的可见渲染。`providerMessageId` 仍可留在 block 上供排障。
- submitting/executing 已有 `locked` 的，确认 Send/Discard/字段都不可用。

**Test scenarios:**
- Happy path: progress 卡可见 “Sending email”，无 provider id。
- Happy path: success 卡可见 Sent，查询不到 `a2ui-email-provider-id`。
- Edge: failed 仍显示错误，不显示 id。

**Verification:** 新文案出现在 PR 描述里（AGENTS.md）；中文 locale 有对应翻译。

---

- U3. **任意对话的工具等待行改为短意图**

**Goal:** 邮件、日历、电脑、网页、连接器等任意对话，等待时都只看到「正在做什么」，看不到 Python/PowerShell/内部工具名。

**Requirements:** R5, R6, R11

**Dependencies:** None

**Files:**
- Modify: `packages/adapters/src/pi-runtime-tools.ts` `describeToolActivity`
- Test: `packages/adapters/src/pi-runtime.test.ts`
- Test: `packages/adapters/src/builtin-tool-bridge.test.ts`（若断言了旧句子）

**Approach:**
- 这是所有对话类型的单一入口：`tool_execution_start` 都走 `describeToolActivity`。改这里即覆盖任意对话，不必按会话类型分支。
- `user_computer_shell` → “Working on your computer”（不拼接 command）。
- `shell` → “Running a command”（不拼接 command）。
- `COMPOSIO_MULTI_EXECUTE_TOOL`：读 `tools[].tool_slug`，映射到意图（例如 send/fetch mail → “Sending email” / “Checking email”；calendar find/list → “Checking the calendar”；未知 slug → “Working…”）。禁止显示包装名或 slug。
- MCP `mcp__x__y`：不要暴露函数名；用 “Working…” 或已有人类标签，不写 `Using brex: list_expenses`。
- 兜底从 `Using ${toolName}` 改为 “Working…”（工具名含 `_` 或全大写时尤其不要原文展示）。
- 已是意图句的（web_search、browser_*、present_interaction）保持。
- 不解析 PowerShell 做「读表/复制」细分；相同意图靠 collapse 变成 `×N`。
- 不新增 steps.detail。Live 行不预告下一步工具。

**Test scenarios:**
- Happy path: `user_computer_shell` + 很长 powershell/python → 整句 “Working on your computer”，不含 `WriteAllBytes` / `python` / `.py`。
- Happy path: `shell` 同样不含 command。
- Happy path: `COMPOSIO_MULTI_EXECUTE_TOOL` + `GOOGLECALENDAR_FIND_EVENT` → 日历意图句，不含 `COMPOSIO_` / `GOOGLECALENDAR_`。
- Happy path: `COMPOSIO_MULTI_EXECUTE_TOOL` + Gmail send slug → “Sending email” 一类，不含 slug。
- Happy path: 未知 `mcp__foo__bar` → 不含 `foo`/`bar` 函数名。
- Edge: 未知工具名 `destination_write` → “Working…”，不含原名。
- Edge: `present_interaction` 仍为 “Preparing an editable draft”。
- Edge: web_fetch 仍脱敏 URL。

**Verification:** 邮件/日历/电脑三类对话的 live `workingLabel` 都没有代码或内部工具名。

---

- U4. **卡片上的批准菜单（接到现有规则页）**

**Goal:** 「需要批准」可点，能进已有 Approvals；不假装已经按收件人免批。

**Requirements:** R7, R10

**Dependencies:** None（菜单展示不依赖 U1）

**Files:**
- Modify: `apps/web/src/components/a2ui/EmailComposeEditor.tsx`
- Modify: 把 `onManageRules` 从卡片传到 `A2uiSurfaceCard` / message-view / Shell（打开 `confirmations`）
- Modify: `apps/mobile/components/thread/a2ui-native-surface.tsx`（同等菜单；管理规则走到现有设置页）
- Test: `A2uiSurfaceCard.test.tsx`、手机 surface 测试；需要时给 ApprovalRules 调用加组件测试

**Approach:**
- 默认选中「需要批准」：本张卡仍要点发送。
- 「管理规则」：`openSettings("confirmations")`，不新造规则编辑器。
- 「允许发送」仅在能对上真实工具名时启用：调用现有 `approvalRules.set({ effect: "always_allow", matchKind: "tool", matchValue })`。文案必须说明这是工具批准，不是「这个收件人以后免卡」。
- 不做「关闭此 Bot 草稿」。
- 发送中/已发送不显示该菜单。

**Test scenarios:**
- Happy path: 草稿卡有菜单；默认 Needs approval。
- Happy path: 选 Manage rules → 调用传入的 openSettings/confirmations。
- Happy path（若做允许发送）: 调用 `approvalRules.set`，本张卡 Send 仍在。
- Edge: 无 onManageRules 时菜单项不崩溃（隐藏或 noop 有测试）。
- Error: set 失败时卡片显示已有 error 行，不假装已保存。

**Verification:** 设置页规则列表能看到新规则（若选了允许发送）；本张卡不会自动发出。

---

- U5. **草稿旁白、空卡、CC 占位**

**Goal:** 空卡不像已经拟好；CC 不像真有抄送。

**Requirements:** R8, R9, R10

**Dependencies:** U1 有助于旁白提到发件箱，但不是硬依赖；旁白仍不复述字段。

**Files:**
- Modify: `packages/core/src/interaction-nudge.ts`
- Test: `packages/core/src/interaction-simulation.test.ts`、`a2ui-orchestration-regression.test.ts` 以及所有钉死旧 nudge 的测试
- Modify: `EmailComposeEditor.tsx` 去掉 CC `placeholder="name@example.com"`；手机 CC 字段同样处理

**Approach:**
- `presented` 拆成完整草稿 / 缺必填两种 nudge（仍各一句）。完整：点明尚未发送。缺必填：点明还缺收件人或主题。
- 不把 From/To 写进聊天（卡片已有）。
- CC：无占位假地址。

**Test scenarios:**
- Happy path: to/subject/body 都缺 → incomplete nudge。
- Happy path: 字段齐全 → 「确认后发送 / 尚未发送」语义。
- Integration: 旧字符串 “请在卡片上确认或编辑。” 的断言全部改到新文案。

**Verification:** 「帮我发一封邮件」先出空卡时，旁边那句不再像已经写好待发。

---

- U6. **完成后的短总结**

**Goal:** 操作结束后像 Grok 那样一句说完：做了什么、若需要人动手则下一步是什么。不要复盘、不要贴代码。

**Requirements:** R8, R12, R13

**Dependencies:** U5 的 nudge 已覆盖「尚未发送」；本单元管普通回复指引，覆盖任意对话。

**Files:**
- Modify: `packages/adapters/src/run-replies.ts` `longWorkProgressGuidance` 以及 `replyGuidanceForOfferedTools` 的短替代句
- Modify: `packages/adapters/src/builtin-tools.ts` 里 `message_user` 工具说明（禁止贴命令/代码）
- Test: `packages/adapters/src/executor.test.ts`、`packages/adapters/src/user-progress.test.ts`、`packages/adapters/src/run-replies.ts` 若已有测试则一并改

**Approach:**
- 把 “Always put the complete final answer in your normal reply” 改成短收尾规则，例如：结束后用 1–3 句写结果；用户要数据就给数据；需要用户操作时只写下一步（审阅卡片、点发送、在电脑上确认对话框）；不要逐步复盘、不要粘贴命令/脚本/工具日志。
- `message_user`：同样禁止代码/命令；中途更新只说当前意图。
- 不截断已生成的长回复、不加 judge。模型仍可能偶发写长，本轮只改系统指引。
- 用户明确要汇总表（如固定资产那轮「将内容数据汇总给我」）时，短收尾仍应包含汇总结果，而不是只说「已完成」。

**Test scenarios:**
- Happy path: `longWorkProgressGuidance()` 含短收尾规则，不含 “complete final answer” 这种鼓励写长的句子。
- Happy path: 禁用 `message_user` 时的替代指引同样要求短收尾。
- Happy path: `message_user` 工具描述禁止 dump logs/commands。
- Integration: `executor.test.ts` 里钉死旧 replyGuidance 的断言改到新文案。

**Verification:** 指引与测试对齐；邮件草稿收尾由 U5 nudge 保证短；电脑任务收尾不再被系统鼓励写成过程报告。

---

## System-Wide Impact

- **Interaction graph:** 邮件卡新增 `onManageRules` 回调，Shell 设置 overlay 是唯一规则 UI。手机必须有对等入口，不能只改 Web。
- **Error propagation:** `approvalRules.set` 失败留在卡片 error 行；发信失败路径不因隐藏 provider id 而丢失。
- **State lifecycle:** `senderAddress` 必须像 `senderLabel` 一样在 confirm/execute/amend 重写时拷贝，否则发送中 From 会空白。
- **API surface parity:** additive optional 字段；旧客户端忽略未知字段应仍能渲染（手机与 Web 同步发）。
- **Unchanged invariants:** confirm-then-execute、连接按当前 Matebot 用户选择、批准豁免 `present_interaction`、电脑命令实际执行内容。
- **Activity coverage:** 任意对话的 live 行都经 `describeToolActivity`；U3 一处改全覆盖。模型在普通气泡里贴代码不在此函数内，靠 U6 指引约束。

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| 用户以为「允许发送」= 这个收件人以后不再出卡 | 文案写明工具批准；按收件人免卡列入 Deferred |
| 没有 `senderAddress` 时 From 仍是 “Email” | 仍比「未提供」好；不编造登录邮箱 |
| 活动行改固定句后排障变难 | 接受本轮取舍；原始命令仍在 `external_effects.request` |
| 连接器 slug 映射不全 | 未知 slug 一律 “Working…”；禁止回退到 slug 原文 |
| 模型仍可能写长总结 | 只改系统指引；不加 judge、不截断 |
| nudge 测试面广 | 集中改 `A2UI_SURFACE_NUDGE` 一处，按失败测试补全 |
| 手机漏改 | 每个含 UI 的 U 的 Files/测试都含 mobile |

---

## Documentation / Operational Notes

- PR 描述按 AGENTS.md 引用全部新增用户可见文案（中英）。
- 不改 docs 产品页，除非有人写到邮件卡「未提供」的说明（执行时搜一下，有则改）。
- 不部署、不打包；审批执行后留在当前 A2UI 分支或新建 `ux/review-card-activity` 分支，不默认 merge。

---

## Sources & References

- 对话中的 Grok Bot 对比与三条 DB 核实结论
- `apps/web/src/components/a2ui/EmailComposeEditor.tsx`
- `packages/adapters/src/pi-runtime-tools.ts` `describeToolActivity`
- `packages/core/src/interaction-nudge.ts`
- `apps/web/src/components/ApprovalRulesSettings.tsx`
- `AGENTS.md` UI/copy 纪律
)
