# 运行详情面板轮询刷新（Q4b）— 设计（简版）

日期：2026-09-21（UTC）
基线：#5895（详情面板 read-only dialog）+ #5925（溯源子路由与面板区）
分支：`feat/integration-run-detail-polling`

## 背景

`IntegrationWorkbenchView.vue` 的“运行详情”面板（`role="dialog"`, `data-testid="run-detail-dialog"`）
只在点击「详情」时读一次 `GET /api/integration/runs/:runId`；对仍在 `pending`/`running` 的运行，
操作者要看到最新状态只能关闭再重新点开。本变更给面板加上非终态时的定时重拉，纯前端，不新增
后端路由、不新增字段、不改 openapi。

## 状态词表（唯一权威来源）

亲读 `plugins/plugin-integration-core/lib/pipelines.cjs:27-29`：

```js
const VALID_RUN_STATUSES = new Set(['pending', 'running', 'succeeded', 'partial', 'failed', 'cancelled'])
const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'partial', 'failed', 'cancelled'])
```

前端 `isTerminalRunStatus()` 逐字镜像 `TERMINAL_RUN_STATUSES`（`apps/web/src/views/IntegrationWorkbenchView.vue`
里加了一条注释指明来源，防止两边悄悄漂移）。非终态 = `pending` / `running`。

## 实现

全部改动在 `apps/web/src/views/IntegrationWorkbenchView.vue`（状态与逻辑）与
`apps/web/src/components/integration/IntegrationMonitoringSection.vue`（模板/props）。

- `RUN_DETAIL_POLL_MS = 5000`、`runDetailPolling`（ref，驱动“自动刷新中/已停止”标签）、
  `runDetailPollTimer`（普通变量，不放进响应式系统，做法与既有 `workbenchSectionObserver` 一致）。
- `scheduleRunDetailPollingIfNeeded()`：幂等；面板关闭或运行已终态则清定时器；否则若定时器未启动
  才 `setInterval`。`openRunDetail` 首次读成功后调用一次；每次刷新成功后再调用一次（这样运行从
  非终态变终态的那一刻，下一次 tick 就会把自己关掉，而不是先等一轮空转）。
- `refreshRunDetail(showLoading)`：手动刷新按钮与定时器 tick 共用的唯一重拉入口。
  `showLoading=true`（手动点击）会显示 loading、把错误展示给用户、并在失败时停表；
  `showLoading=false`（后台 tick）失败时保留上一次已知良好状态、定时器继续尝试，只有
  `RUN_NOT_FOUND`（运行已不可见/被清理，永远不会再成功）才立即停表。刷新成功后若溯源区
  已展开，顺带用 `refreshRunProvenanceQuietly()` 静默重拉一次溯源列表。
- `closeRunDetail()` 与组件的 `onBeforeUnmount` 都调用 `stopRunDetailPolling()`，保证面板关闭
  或整个视图卸载后，定时器不会继续在背景里发请求。
- 沿用既有的 monotonic request token（`runDetailRequestId` / `runProvenanceRequestId`）做过期应答
  围栏——手动刷新、定时 tick、打开新一条运行详情三者互相竞态时，只有最新一次请求的结果会落地。

## UI

面板头部新增：
- `data-testid="run-detail-poll-status"`：定时器已启动显示「自动刷新中 / Auto-refreshing」，
  已停止（含面板刚打开就是终态运行的情况）显示「自动刷新已停止 / Auto-refresh stopped」。
- `data-testid="refresh-run-detail"`：手动刷新按钮，`runDetailLoading` 时禁用。

两者都是纯展示态，不引入任何重放/重试/写入能力——面板仍然是只读的。

## 未做的事

- 没有改动 `getIntegrationRun` / `getIntegrationRunProvenance` 的 URL 或参数形状。
- 没有改动后端路由或 openapi schema（`status` 字段本就是自由字符串，未定义 enum）。
- 没有给「行级结果」「dead letter」等其它面板加轮询——范围严格限定在这一个 dialog。
