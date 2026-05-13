# K3 WISE Setup Boolean Hydration Refresh Development - 2026-05-13

## Context

PR #1344 fixed a frontend-only K3 WISE setup issue, but it was stale behind the
current K3 validation queue. Current `main` still restored saved `autoSubmit`
and `autoAudit` values only when the stored value was the literal boolean
`true`.

Backend and script-side K3 WISE safety tooling accepts common boolean variants
from customer-edited packets and spreadsheet-like exports. The setup form should
not display saved K3 flags incorrectly just because older rows or hand-edited
JSON stored values such as `"true"`, `1`, or `是`.

## Design

`apps/web/src/services/integration/k3WiseSetup.ts` now normalizes saved
`autoSubmit` and `autoAudit` when applying an external system to the setup form.

Accepted true variants:

- `true`
- `1`
- `"true"`, `"1"`, `"yes"`, `"y"`, `"on"`, `"enable"`, `"enabled"`
- `"是"`, `"启用"`, `"开启"`

Accepted false variants:

- `false`
- `0`
- `"false"`, `"0"`, `"no"`, `"n"`, `"off"`, `"disable"`, `"disabled"`
- `"否"`, `"禁用"`, `"关闭"`

Unknown values hydrate to `false`. That keeps the UI safety-biased and prevents
a checked value from the previously selected system from leaking into the newly
loaded system.

## Test Hardening

The refreshed test suite keeps the original #1344 negative test and broadens the
positive matrix to cover boolean, numeric, English string, whitespace/case, and
Chinese variants. This keeps the development document aligned with actual test
coverage.

## Compatibility

This change is frontend-only. It does not change saved payload shape, backend
validation, K3 runtime execution, database schema, or deployment configuration.

## Superseded Work

This refresh supersedes PR #1344. The refreshed branch uses current `main`,
current dates, and current verification output.
