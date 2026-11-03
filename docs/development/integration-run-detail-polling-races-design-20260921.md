# 运行详情轮询：两处请求竞争的修复设计（#5950 复审 N1/N2）

日期：2026-09-21 · 前序：`integration-run-detail-polling-design-20260921.md`（#5950）

## 问题

owner 增量复审在 #5950（c919db1c4）上用可控延迟响应复现了两处竞争：

- **N1 卸载后迟到响应重启轮询**。`onBeforeUnmount` 只调 `stopRunDetailPolling()` 清当下的 timer，
  没有让在途请求失效。初次 GET 挂起时卸载视图，GET 随后返回 running，`openRunDetail` 仍按
  `requestId === runDetailRequestId` 判定为最新并调用 `scheduleRunDetailPollingIfNeeded()`，
  重新 `setInterval`——卸载后再推进 5 秒，GET 次数从 1 变 2。同类的迟到分支还有两个：后台 tick
  的 `refreshRunDetail`，以及它在溯源区展开时链上的 `refreshRunProvenanceQuietly` 静默重拉
  （原代码在重拉 await 之前做了 token 检查，之后直接 schedule）。
- **N2 手动刷新与后台 tick 重叠卡 loading**。手动刷新置 `runDetailLoading=true`；5 秒后后台 tick
  递增共用的 `runDetailRequestId`，手动响应因此过期，它的 `finally` 只在 “自己仍是最新” 时才清
  loading；后台 tick `showLoading=false` 也不清。所有请求都结束后刷新按钮仍 `disabled`。

## 修法

### N1：卸载即失效

- 新增 `runDetailDisposed`（普通 `let`），`onBeforeUnmount` 置 true，并改为调用
  `closeRunDetail()`：它清 `runDetailId`、递增 `runDetailRequestId`、`resetRunProvenance()`
  （递增 `runProvenanceRequestId`）、停表。于是 `openRunDetail` / `refreshRunDetail` 的迟到响应在
  token 检查处直接返回。
- `refreshRunDetail` 在溯源静默重拉 await 之后**再查一次** token，关闭/卸载发生在重拉期间也会返回。
- `scheduleRunDetailPollingIfNeeded()` 在 `runDetailDisposed` 时拒绝 arm。它与 token 检查是两道
  独立的闸：任何将来新增的迟到分支只要走这个唯一的 arm 入口，卸载后都 arm 不上。

### N2：loading 所有权按请求记账

选的是 “loading 所有权独立于哪个响应最新”，不是串行化：

- `runDetailLoadingOwners: Set<number>` 记录显示 loading 的在途请求（`openRunDetail`、手动刷新）
  各自的 requestId；各请求在自己的 `finally` 里**无条件**移除自己的 id，`runDetailLoading` 等于
  “集合非空”。`closeRunDetail` 与 `openRunDetail`（换一条运行）清空集合。
- 过期应答围栏保持不变：后台 tick 比手动请求新时，仍是 tick 的数据落地、手动的数据被丢弃。本次
  **没有**通过取消或放宽旧响应保护来修。

不选串行化（手动刷新期间暂停后台 tick / tick 遇在途请求跳过）的理由：

1. 串行化要同时改 “谁能发请求” 和 “谁能清 loading” 两件事，引入暂停/恢复定时器的额外状态，
   而 N2 的缺陷只在后者——loading 由一个与之无关的 “最新 token” 决定。
2. 按请求记账后，loading 的释放不依赖请求的完成顺序，任意交错（tick 先回、手动先回、打开新运行
   打断旧的手动刷新）下，最后一个显示 loading 的请求结束时按钮必然可用。
3. 保留 tick 的并发发出，操作者手动刷新挂起（慢网络）时后台仍按 5 秒节拍取新状态，与 #5950
   原设计 “只有最新请求的结果落地” 一致。

代价：手动请求挂起期间若 tick 已回来，界面已显示新数据但 loading 提示仍在，直到手动请求结束。
这是 “手动请求仍在途” 的如实反映，不是卡死。

## 范围

只改 `apps/web/src/views/IntegrationWorkbenchView.vue` 的运行详情状态机与
`apps/web/tests/IntegrationRunDetail.spec.ts`。未改 service、后端、openapi、组件模板。
`openRunDetail` 打开另一条运行时不主动停旧 timer（旧 timer 的 tick 读的是新的 `runDetailId`），
本次未动；按请求记账后它不再能卡 loading。
