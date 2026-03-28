# PLM Workbench Team View Route Removal Design

## Problem

`workbench / documents / cad / approvals` 的 team view external hydration 已经覆盖了 `A -> B` owner takeover，但还漏掉了 `A -> none`。

当前 `applyQueryState()` 只在 route query 仍然带着 `workbenchTeamView / documentTeamView / cadTeamView / approvalsTeamView` 时才执行 hydrated owner cleanup。若外部 deep-link、浏览器回退或 reset patch 把这些 key 直接删掉：

- 内存里的 `...TeamViewQuery` 仍保留旧 collaborative owner
- 默认 auto-apply blocker 还会把它当成显式 owner
- 下一轮 query sync 仍可能把旧 owner 写回 URL

## Design

- 新增 `resolvePlmHydratedRemovedTeamViewOwner(...)`，对“旧 route owner 被移除”的场景做专门 cleanup。
- 在 `applyQueryState()` 里为 4 个 team view owner query key 增加对称 `else if (...TeamViewQuery.value)` removal 分支。
- cleanup 语义与 team preset/local preset 已有合同一致：
  - 若本地 selector 仍指向被移除的 owner，则清空 selector / name / owner draft，并清掉 selection
  - 若用户已经切到另一个 pending selector，则只消费旧 route owner，不误清 pending 管理态

## Expected Outcome

外部 route 把 team view owner 去掉时，页面会 authoritative 地消费旧 collaborative owner，不再出现“URL 已无 owner，但页面仍把旧 owner 当成显式状态”的复活行为。
