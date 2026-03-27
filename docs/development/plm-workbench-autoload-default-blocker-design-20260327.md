# PLM Workbench `autoload` Default Blocker Design

## Background

`workbench` 默认团队视角是否允许自动接管，统一由
`hasExplicitPlmWorkbenchAutoApplyQueryState(...)`
判定。这个判定应该只关心“会改变面板状态的显式 query”，不该把纯行为型
query 当成 blocker。

## Problem

`autoload` 目前仍属于 `PLM_WORKBENCH_QUERY_KEYS`，而
`hasExplicitPlmWorkbenchAutoApplyQueryState(...)` 没有把它剥掉。

结果是：

- `/plm?autoload=true`
- `/plm?autoload=false`

这两类 query 即使不携带任何真实 workbench 状态，也会被误判成
“存在显式 query state”，从而阻断默认 `workbenchTeamView` auto-apply。

这和当前产品语义不一致：

- `autoload` 只控制首屏是否自动触发数据加载
- 它不会改变 search / document / bom / compare / approvals 的视图状态
- route builder 允许显式保留它，因此默认 blocker 必须把它视为 no-op

## Decision

在 `hasExplicitPlmWorkbenchAutoApplyQueryState(...)` 里显式删除 `autoload`，
让它和已经本地化的 `approvalComment` 一样，不参与 default blocker 判定。

## Why This Fix

- 变更面最小，只收口 blocker 语义
- 不改变现有 deep-link / return path 对 `autoload` 的保留
- 不影响真正的 collaborative state round-trip
- 和“默认视角只被真实面板状态阻断”的既有合同一致

## Files

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmWorkbenchViewState.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmWorkbenchViewState.spec.ts`
