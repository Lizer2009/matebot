# A2UI 方案缺口清单（相对集成方案 v1.0）

配套详述：[`matebot-a2ui-source-audit.md`](./matebot-a2ui-source-audit.md)。  
优先级：P0 阻塞 Phase 1 正确性；P1 阻塞 Email E2E；P2 可并行。

## P0 — 方案校准（先改设计，再写代码）

| # | 缺口 | 证据锚点 | 建议动作 |
| --- | --- | --- | --- |
| 1 | 方案使用 Conversation；仓库是 **Thread** | `packages/db/prisma/schema.prisma` `model Thread` | 全文替换命名；FK 用 `threadId` |
| 2 | 提议新建 Approval/ActionExecution，忽略 **ExternalEffect + ActionApprovalRule** | `ExternalEffect`, `packages/core/src/action-approval.ts`, `docs/approvals.md` | Action Runtime = 扩展现有模型；仅证明不够时再 New |
| 3 | A2UI pin **v0.9.1** 与上游 **v1.0 = current** 冲突；`@a2ui/react` 无 `./v1_0` export | `Lizer2009/a2ui` `specification/versions.json`；`@a2ui/web_core`/`@a2ui/react` package.json | Phase 1 以 renderer 实测为准，adapter 双轨 |
| 4 | 未定义与 **`@matebot/page-kit`** 的共存边界 | `packages/page-kit`, `MessageBlock` `page`, `Page`/`PageVersion` | 方案增补「Page vs A2UI」专节；禁止互相替代 |
| 5 | 「多包新建」与现有 `contracts`/`core`/`adapters` 重叠 | `packages/*` | Extend-first；最多先加薄 `a2ui-adapter` |
| 6 | 暗示 interactive 工作进队列 | `docs/run-execution.md` | 明确：Surface 更新走 Event/SSE；仅异步副作用可 Worker |

## P1 — Email / 交互闭环前置

| # | 缺口 | 证据锚点 | 建议动作 |
| --- | --- | --- | --- |
| 7 | 无 Interaction / Surface / 草稿 version 实体 | Prisma 无对应 model | 最小迁移或可证明的 Event 嵌入方案 |
| 8 | 现有 ask 确认不绑定「可编辑草稿版本」 | `AskCard`, `buildApprovalAskBlock`, `threads.answer` | 设计 confirmedVersion ↔ draftVersion 失效规则 |
| 9 | MessageBlock 无 A2UI/surface kind | `packages/contracts/src/events.ts` | 新增 discriminated 成员 + web/mobile 宿主 |
| 10 | Mobile 无跨设备 Interaction 恢复（仅消息 + 本地 saved-chats） | `apps/mobile/lib/saved-chats.ts` | 服务端 Snapshot API；勿依赖设备缓存 |
| 11 | 无官方 RN renderer | `Lizer2009/a2ui` 树无 react-native 包 | 自建 Native Catalog；社区包不作默认 |

## P2 — 加固与体验

| # | 缺口 | 建议动作 |
| --- | --- | --- |
| 12 | SSE 恢复是 cursor 而非 Last-Event-ID | 文档对齐现有 `threads.subscribe({ cursor })` |
| 13 | Graphile job 名空间尚无 action.* | 需要时在 `background-jobs.ts` 登记 + 幂等键 |
| 14 | Electron 外链/文件策略需 A2UI URL 审计 | Desktop 回归清单 |
| 15 | 连接器授权矩阵未按「email.send」逐工具枚举 | Phase 3 前做 connector kind 映射表 |
| 16 | `@a2ui/agent` 未发布 | 不依赖；自研 Plan 编译 |

## 方案原文可保留的正确判断

- 保留 Pi / 不重写 Agent Runtime  
- Web/Electron 共享渲染；Mobile Native Catalog  
- LLM → InteractionPlan → 服务端编译 A2UI（勿让模型直接吐任意 UI 代码）  
- 不引入并行 AG-UI/A2A/WebSocket 聊天总线  
- 保留 `MATEBOT_*` 部署兼容名  

## 建议的下一文档修订（仍属设计，非本仓库运行时）

> **已完成：** 审计对齐设计见 [`matebot-a2ui-integration-design.md`](./matebot-a2ui-integration-design.md)（v1.1）。

1. ~~更新集成方案 §0.2 / §4.1 版本策略（v1.0 current + renderer 现实）。~~  
2. ~~更新 §11 数据模型：Thread/Event/Run/ExternalEffect 优先。~~  
3. ~~更新 §14 包结构：Extend-first + page-kit 共存。~~  
4. ~~增加「草稿版本 × 现有审批」状态图。~~
