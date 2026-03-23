# PLM Audit Scene Route Shared-Entry Query Design

## Background

上一轮已经让 scene route takeovers 在本地状态上清掉：

- stale saved-view followup / focus
- collaboration draft / followup
- shared-entry owner

对应路径是 scene banner / scene token 的：

- `Clear context`
- `Show owner activity`
- `Restore scene filter`

## Problem

本地 owner 清掉以后，URL 上的 transient `auditEntry=share` marker 仍可能残留。

当目标 scene route 的稳定 `PlmAuditRouteState` 没有变化时，`syncRouteState(...)` 会因为 `routeChanged === false` 直接跳过同步。这样会出现：

1. 本地 `shared-entry` notice 已经被 scene takeover 清掉
2. 但 URL 里仍然保留 `?auditEntry=share`
3. 用户刷新页面或重新进入时，旧 shared-entry notice 会被 marker 重新激活

这是一条真实的 route-sync 漏口。

## Decision

scene route takeover helper 不只返回“新的 transient state”，还要显式返回：

- `consumeSharedEntry: true | false`

语义是：

- 如果这次 takeover 清掉了 shared-entry owner，就必须同步消费 URL marker
- 如果没有 active shared-entry owner，则不做额外 query sync

## Implementation

Files:

- `apps/web/src/views/plmAuditSceneContextTakeover.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditSceneContextTakeover.spec.ts`

Key changes:

- `buildPlmAuditSceneContextTakeoverState(...)` 新增 `consumeSharedEntry`
- scene banner 的三个 route actions 把这个标记透传给 `syncRouteState(..., { consumeSharedEntry })`
- 纯函数回归锁住两条合同：
  - active shared-entry owner 会触发 `consumeSharedEntry: true`
  - 非 shared-entry 场景不会误触发 query consumption

## Expected Behavior

- scene route takeovers 清掉 shared-entry owner 时，会一起移除 URL 上的 `auditEntry=share`
- 如果 scene route 本身没有稳定字段变化，也不会留下 stale share marker
- 刷新页面后不会再由旧 marker 复活 shared-entry notice
