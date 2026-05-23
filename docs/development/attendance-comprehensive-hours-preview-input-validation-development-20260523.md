# Attendance Comprehensive Hours Preview Input Validation Development

Date: 2026-05-23
Branch: `codex/attendance-comprehensive-hours-preview-postmerge-review-20260523`

## Context

PR #1774 added the read-only backend preview route:

```text
POST /api/attendance/comprehensive-hours/preview
```

The post-merge review confirmed the route is admin-gated and does not add write
paths, but found one input-contract gap: invalid `metric` or `enforcement`
values silently fell back to `planned` / `warn`. That is acceptable for low-level
comparison helpers, but it is too ambiguous for the HTTP preview boundary because
planned and actual comprehensive-hours metrics intentionally use different data
producers.

## Change

This slice adds explicit route-input normalization for the two enum fields:

| Field | Default when omitted | Accepted values | Invalid result |
| --- | --- | --- | --- |
| `metric` | `planned` | `planned`, `actual` | `INVALID_METRIC` |
| `enforcement` | `warn` | `warn`, `block` | `INVALID_ENFORCEMENT` |

Implementation details:

- `normalizeAttendanceComprehensiveHoursMetricInput()` validates a supplied
  metric and trims surrounding whitespace.
- `normalizeAttendanceComprehensiveHoursEnforcementInput()` validates a supplied
  enforcement mode and trims surrounding whitespace.
- `normalizeAttendanceComprehensiveHoursPreviewInput()` now returns a validation
  error before any DB reads when either supplied enum is invalid.
- Existing internal helpers such as `buildAttendanceComprehensiveHoursComparison()`
  keep their defensive fallback behavior, so this is scoped to the route-facing
  preview contract.

## Boundary

| Area | Result |
| --- | --- |
| HTTP route surface | Unchanged: still only `POST /api/attendance/comprehensive-hours/preview`. |
| Permission | Unchanged: still `attendance:admin`. |
| DB writes | None added. |
| Schedule save warning/block | None added. |
| Policy persistence | None added. |
| Frontend UI | None added. |
| Data Factory / Bridge Agent / K3 | Not touched. |

## Why This Matters

`metric='actuals'` previously meant "use planned minutes" because the helper
fell back to `planned`. That can make a preview look valid while using the wrong
producer. The new behavior keeps operator mistakes visible and preserves the RFC
rule that planned and actual producers must not be conflated.
