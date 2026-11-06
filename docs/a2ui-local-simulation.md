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

输出是四张表，每行一次「输入状态 → 卡片」的推演：

| 场景 | 覆盖 |
| --- | --- |
| `connection-states` | 未连接 / 需重新授权 / 就绪 / 本地行仍 connected 但 provider 已失效 |
| `send-outcomes` | 成功 / 普通 provider 失败 / 超时（UNKNOWN）/ 授权失效 |
| `unknown-reconcile` | UNKNOWN 只提供「检查状态」，不再给发送 |
| `calendar-resume` | 授权完成后是否继续（日历、邮箱、错误应用、非等待态） |

任何一行与该 PR 的不变量冲突时，进程以 `1` 退出，可直接当作 CI 门禁。

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

相关文档：[`matebot-a2ui-orchestration-addendum.md`](../docs/architecture/matebot-a2ui-orchestration-addendum.md)、
[`matebot-a2ui-integration-design.md`](../docs/architecture/matebot-a2ui-integration-design.md)。
