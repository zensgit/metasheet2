# K3 WISE Live PoC Evidence Secret Container Development

Date: 2026-05-06

## Context

The live PoC evidence compiler rejects customer evidence packets that contain
unredacted secret-like fields before it writes the JSON and Markdown report.

Before this change, the leak scanner only rejected direct string values under a
secret-like key, such as `sessionToken: "..."`. It did not reject secret-like
containers such as:

- `credentials: { value: "..." }`
- `authorization: ["Bearer ..."]`

That created a narrow but real safety gap for hand-edited customer evidence.

## Implementation

The leak scanner now recursively checks every string value beneath a secret-like
key. Safe placeholders remain allowed:

- empty string
- `<redacted>`
- `<set-at-runtime>`
- `redacted`
- `***`

Schema metadata keys such as `requiredCredentialKeys` are explicitly excluded
from value scanning, because those values are field names rather than secrets.

## SQL Optional Phase Decision

This slice also closes a live readiness false-positive found during parallel
inspection: when the preflight packet includes the K3 SQL Server channel,
`sqlConnection` is optional, but an explicit `fail` status must still fail the
report. Optional means it may be `skipped`; it does not mean a failed SQL channel
can produce an overall `PASS`.

`determineDecision()` now treats any phase with `status === "fail"` as a report
failure.

## Files Changed

- `scripts/ops/integration-k3wise-live-poc-evidence.mjs`
- `scripts/ops/integration-k3wise-live-poc-evidence.test.mjs`

## Stacking Note

This branch is stacked on PR #1320 because #1320 already owns the live PoC
evidence fixture contract work and touches the same evidence script.
