# PLM Workbench Team View Share URL Guard Design

## Context

`team preset` share already validates the generated deep link before calling `copyShareUrl(...)`.
`team view` share did not. When `buildShareUrl(view)` returned an empty string, the handler still called the copy transport, which produced feedback that was downstream-specific instead of reporting the real failure point.

## Problem

- `team view` and `team preset` share flows had different failure boundaries.
- Empty or invalid `team view` share URLs could be passed into the clipboard step.
- The UI could report a copy failure even though the link generation step was what actually failed.

## Decision

Add the same guard to `team view` share:

1. Generate the URL once.
2. If the URL is empty, stop immediately.
3. Report `生成{label}团队视角分享链接失败。`
4. Only call `copyShareUrl(...)` when the URL is truthy.

## Expected Result

- `team view` share now matches `team preset` share semantics.
- Empty deep links are caught at the generation boundary.
- The user sees the precise failure reason instead of a misleading copy error.
