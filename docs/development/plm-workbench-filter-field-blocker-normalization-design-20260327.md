# PLM Workbench Filter Field Blocker Normalization Design

## Background

`BOM / Where-Used` 默认团队预设会根据当前 route query 判断是否存在显式 blocker。

当前 blocker helper 把“只有 `filterField`、没有 `filter`”也当成显式状态，但这类 query 实际上不会产生过滤结果，只是一个 no-op UI 选择。

## Problem

- `bomFilterField=path` 且 `bomFilter` 为空时，默认团队预设被错误阻断。
- `whereUsedFilterField=parent` 且 `whereUsedFilter` 为空时，问题同样存在。
- 这种误阻断会在 refresh、deep-link 打开和 deferred hydration 时稳定出现。

## Decision

- 收紧 `hasExplicitPlmFilterPresetAutoApplyQueryState(...)`。
- 只有 `filter` 非空时，非默认 `filterField` 才算显式 blocker。
- `teamPresetKey`、`filterPresetKey` 和非空 `filter` 本身继续保持原语义。

## Expected Result

- field-only no-op query 不再误挡默认团队预设 auto-apply。
- 真正的过滤状态和 preset identity 仍然会阻断默认 takeover。
