# K3 WISE ERP Feedback Evidence Refresh Development - 2026-05-13

## Context

PR #1338 was opened from an older K3 WISE PoC branch to require ERP feedback
writeback evidence before a live PoC evidence packet can return `PASS`.
Current `main` has since absorbed later K3 validation work, including the SQL
mock channel contract refresh from #1508. This refresh ports only the still
useful ERP feedback evidence gate onto current `main`.

Before this change, the evidence compiler proved that K3 WISE accepted the
Save-only material write, but it did not prove that MetaSheet wrote the ERP
result back to staging rows for operator traceability.

## Design

`scripts/ops/integration-k3wise-live-poc-evidence.mjs` now adds required
`erpFeedback` evidence immediately after the `materialSaveOnly` phase.

Missing `erpFeedback` leaves the report at `PARTIAL`. A passed `erpFeedback`
phase must prove:

- at least one staging row or item was updated
- field coverage includes `erpSyncStatus`
- field coverage includes `erpResponseCode`
- field coverage includes `erpResponseMessage`
- field coverage includes `lastSyncedAt`
- field coverage includes at least one external reference, either
  `erpExternalId` or `erpBillNo`

The validator accepts row-shaped proof through `updatedRows`, `updatedItems`,
`items`, or `records`. It also accepts compact proof through `rowsUpdated` plus
`fieldsUpdated` or `updatedFields`. This keeps the customer evidence packet
flexible while preserving the required PASS contract.

## Fixture Updates

Updated evidence fixtures:

- `scripts/ops/fixtures/integration-k3wise/evidence-sample.json`
- `scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs`

The mock PoC demo synthesizes feedback rows from the K3 Save-only upsert result.
It preserves the current SQL channel probes from #1508:

- `sqlChannel.read()` proves the read-only SQL route
- `sqlChannel.upsert()` proves the middle-table write route
- direct `mockSql.exec()` into a core table remains rejected by the safety guard

## Compatibility

This change touches only K3 WISE PoC evidence tooling, fixtures, tests, and
development documentation. It does not alter runtime adapters, production
routes, database schema, or deployment configuration.

## Superseded Work

This refresh supersedes PR #1338. The old branch carried the right evidence
idea, but it was behind later K3 validation work and had stale verification
artifacts.
