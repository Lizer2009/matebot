# A2UI 本地编排模拟（无需部署即可验证卡片行为）

这条路径让你在不安装桌面端、不连接真实 Composio、不重建 GHCR 镜像的前提下，检查 A2UI
邮件 / 日历卡片的编排结果。它跑的是**线上同一份** `packages/core` 纯函数，不是另写一套模型。

## 快速运行

```bash
pnpm test:a2ui-sim                      # 全矩阵，违反不变量时退出码为 1
node scripts/a2ui-sim.mjs --list         # 场景列表
node scripts/a2ui-sim.mjs --scenario send-outcomes
node scripts/a2ui-sim.mjs --json         # 机器可读，便于贴进 issue 或测试
```

输出是六张表，每行一次「输入状态 → 卡片」的推演：

| 场景 | 覆盖 |
| --- | --- |
| `connection-states` | 未连接 / 需重新授权 / 就绪 / 本地行仍 connected 但 provider 已失效 |
| `send-outcomes` | 成功 / 普通 provider 失败 / 超时（UNKNOWN）/ 授权失效 |
| `unknown-reconcile` | UNKNOWN 只提供「检查状态」，不再给发送 |
| `calendar-resume` | 授权完成后是否继续（日历、邮箱、错误应用、非等待态） |
| `dialogue-prompts` | 三段真实中文提示词，按实机状态逐步推演 |
| `capability-registry` | 哪些 intent 已登记/已实现，未登记请求的安全回落 |

任何一行与该 PR 的不变量冲突时，进程以 `1` 退出，可直接当作 CI 门禁。

## 用真实对话跑（`dialogue-prompts`）

```bash
node scripts/a2ui-sim.mjs --scenario dialogue-prompts
node scripts/a2ui-sim.mjs --scenario dialogue-prompts --json
```

三段提示词各占一到两行，列是 `prompt / step / template / action / canSend / resumed / nudge / expect / ok / gap`：

| 提示词 | 覆盖的步骤 |
| --- | --- |
| `帮我发邮件:给 example@example.test 主题: 秋后问候，内容: 自理` | 失效邮箱出稿 → 发信 → 重新授权卡；就绪邮箱发信成功 |
| `确定下周日程，主题和内容自理` | 未连接 → 连 `connect_app`；授权后是否续跑 |
| `登录 Github 做一次简单的代码拉取到本地电脑，项目你自选` | `out_of_scope`：无对应 intent |

`expect` 是该行**应当**命中的形态，`ok` 只表示它符合当前实现。第三段的 `out_of_scope`
是有意的：`expect = out_of_scope` 且 `template = none` 才算通过，这样报告里能直接看出
「这条请求不由 A2UI 编排覆盖」，而不是假装通过。

`gap` 列记录当前实现与产品预期的差距（例如日历已续跑但卡片上没有可编辑控件），
它是给人读的说明，不参与 `ok` 判定。

## 覆盖的连接状态

模拟器构造的是数据库里真实可能出现的行，外加 provider 自己的视角：

```ts
// packages/core/src/interaction-simulation.ts
simulatedConnection("stale_local_connected");
// { connections: [{ provider: "gmail", status: "connected", providerRef: "ca_simulated_revoked" }],
//   reconnectRefs: ["ca_simulated_revoked"],
//   providerReady: { gmail: false } }
```

这一格就是实机故障：本地行说 `connected`，Composio 已把账号标为失效，于是发信必然失败。
预检现在以 provider 的答复为准，卡片转为「重新授权」。

## 加一个场景

在 `scripts/a2ui-sim.mjs` 的 `scenarios` 里加一条，`rows` 从
`packages/core/src/interaction-simulation.ts` 的导出构造，`check` 写你要守的不变量。
需要新的状态或投递结果时，先加进
`SIMULATED_CONNECTION_STATES` / `SIMULATED_DELIVERIES`，再在
`packages/core/src/interaction-simulation.test.ts` 补断言 —— 两边共用同一份导出，不会漂移。

## 边界（这不是端到端测试）

- 不发起 OAuth，不调用 Composio，不写数据库；发送路径只推演到 `ExternalEffect` 的状态映射。
- 不验证渲染细节：Web/移动端卡片另有 `apps/web/src/components/a2ui/*.test.tsx` 与
  `apps/mobile/lib/a2ui-*.test.tsx`。
- 真实 provider 文案变化需要在 `packages/core/src/interaction-connection.ts` 的
  `RECONNECT_SIGNALS` 里补一条，并同时在模拟器里加一个投递结果。
- 日历行不再强制套用 email 模板：非 email intent 不打 stamp，所以那一行的
  `template` 是 `null`，`implemented` 为 false。这正是产品缺口，不应该被模拟器掩盖。
- `capability-registry` 行读的是真实注册表：`email.compose` 渲染，未登记 intent
  一律 `unregistered_intent` 且没有 action。若有人给未登记 intent 伪造出卡，这行会红。

相关文档：[`matebot-a2ui-orchestration-addendum.md`](../docs/architecture/matebot-a2ui-orchestration-addendum.md)、
[`matebot-a2ui-integration-design.md`](../docs/architecture/matebot-a2ui-integration-design.md)。
