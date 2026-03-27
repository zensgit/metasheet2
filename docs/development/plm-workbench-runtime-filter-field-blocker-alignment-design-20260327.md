# PLM Workbench Runtime Filter Field Blocker Alignment Design

## Background

`5bf5af1fe` 已经把 `BOM / Where-Used` 默认团队预设的 query blocker helper 收紧为：

- 只有 `filter` 非空时
- 非默认 `filterField`

才算显式 blocker。

但页面运行时传给 `usePlmTeamFilterPresets()` 的 `shouldAutoApplyDefault` 仍额外要求 `filterField === 'all'`，导致 helper 合同和真实运行时条件分叉。

## Problem

- 用户只改了 field selector、但过滤值仍为空时，helper 判断这是 no-op。
- 页面 closure 却继续阻断默认 team preset auto-apply。
- refresh / hydration / auth-driven refresh 的运行时表现仍与测试合同不一致。

## Decision

- `PlmProductView.vue` 中 BOM / Where-Used 两条 `shouldAutoApplyDefault` closure 去掉 `field === 'all'` 约束。
- 统一改成：
  - `!hasExplicit...AutoApplyQueryState(...)`
  - `&& !filter.value.trim()`

## Expected Result

- field-only no-op 状态不会再挡住默认团队预设接管。
- 页面运行时和 blocker helper、state tests 的合同重新一致。
