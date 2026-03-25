# PLM Workbench Sparse Column Route Ownership Design

## 背景

`documents / approvals` 团队视角的 `columns` 状态允许以 sparse map 形式存储：

- `documents`: 例如 `{ mime: true }`
- `approvals`: 例如 `{ status: true, product: false }`

客户端会保留这种 sparse 结构，但 `PlmProductView.vue` 在 `applyViewState` 时会把它们展开到默认列配置上。

## 问题

上一轮 panel route-takeover watcher 直接拿：

- 团队视角里保存的 sparse `columns`
- 本地已经展开过默认列的 `columns`

做严格结构比较。

结果是：

- 即使用户没有手动改动任何列
- route owner 也会被 watcher 误判为 drift 并清掉

这会影响 `documentTeamView` 和 `approvalsTeamView` 的显式 ownership，在 apply/share/default 后都可能自发失效。

## 设计

不改 `applyViewState` 运行时语义，只修正比较时的等价关系：

1. 新增 `mergePlmTeamViewBooleanMapDefaults(defaults, value)`
   - 把 sparse boolean map 按默认列配置展开
2. `documents` watcher 比较前：
   - 对 `activeView.state.columns` 先按 `defaultDocumentColumns` 展开
   - 对本地 `documentColumns` 也按同样默认值展开
3. `approvals` watcher 比较前：
   - 对 `activeView.state.columns` 先按 `defaultApprovalColumns` 展开
   - 对本地 `approvalColumns` 也按同样默认值展开

## 结果

- sparse `columns` 和默认展开后的本地状态会被视为等价
- 真正的手动列变更仍然会触发 route-owner cleanup
- `documentTeamView` / `approvalsTeamView` 不会在 no-op apply/share/default 后被误清
