# PLM Workbench Autoload Identity Parity Design

## Background

`autoload` 在 `PLM Workbench` 里承担的是 deep-link 打开后的自动加载触发器，不是团队视角本身的业务状态。

当前代码里有一条语义分叉：

- `hasExplicitPlmWorkbenchAutoApplyQueryState(...)` 已经把 `autoload` 当作 no-op，不再把它算成默认 auto-apply blocker。
- 但 `matchPlmWorkbenchQuerySnapshot(...)` 仍会把 `autoload` 算进 collaborative-state 匹配。

结果是：

- route 上只要多了 `autoload=true`
- 当前已应用的 `workbenchTeamView` 就可能被误判成 stale owner
- 页面会把 `workbenchTeamView` route owner 清掉，落成假的 drift

## Design

这轮只修 identity parity，不动 deep-link transport：

1. 保留 `autoload` 在 route/share/return-path 里的 transport 语义。
2. 仅在 `matchPlmWorkbenchQuerySnapshot(...)` 的 collaborative identity 比较里，把 `autoload` 剥掉。

这样可以保证：

- share URL / returnToPlmPath 仍能保留自动加载行为
- route owner / stale owner 判定不再被 `autoload` 噪音误伤

## Expected Result

- `autoload`-only 差异不会再清掉当前 `workbenchTeamView` owner
- 默认 blocker 语义和 collaborative identity 语义重新对齐
- deep-link 自动加载行为保持不变
