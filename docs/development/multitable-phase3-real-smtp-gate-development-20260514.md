# Multitable Phase 3 Real SMTP Gate - Development

Date: 2026-05-14

## Scope

This slice implements PR R3 / Lane D1 from the Phase 3 plan by wiring
the existing guarded email real-send smoke into the Phase 3 release
gate aggregator.

The implementation deliberately reuses
`pnpm verify:multitable-email:real-send` instead of duplicating SMTP
send logic. The delegated smoke remains the authority for SMTP
readiness, explicit send confirmation, recipient configuration, and
actual transport execution.

## Changes

- Added `email:real-send` as the first Phase 3 sub-gate.
- Delegated `email:real-send` to
  `pnpm verify:multitable-email:real-send`.
- Wrote the child email report under the Phase 3 gate output
  directory:
  `children/email-real-send/real-send-smoke/report.{json,md}`.
- Preserved the release-gate exit-code contract:
  `0=PASS`, `1=FAIL`, `2=BLOCKED`.
- Kept `release:phase3` as BLOCKED when any child is BLOCKED.
- Extended Markdown report rendering to show delegated command and
  child report path.
- Extended tests so the aggregate gate now expects four children:
  `email:real-send`, `perf:large-table`, `permissions:matrix`, and
  `automation:soak`.
- Updated the Phase 3 TODO with the already-merged Phase 0 / D0 facts
  and the D1 aggregation status.

## Guard Semantics

The real-send child gate remains BLOCKED unless all of these are true:

- `MULTITABLE_EMAIL_TRANSPORT=smtp`
- `MULTITABLE_EMAIL_REAL_SEND_SMOKE=1`
- `CONFIRM_SEND_EMAIL=1`
- `MULTITABLE_EMAIL_SMOKE_TO` is a dedicated test recipient

The Phase 3 wrapper does not weaken those guards. In a clean
environment it delegates to the child smoke, records child status, and
returns BLOCKED with exit code `2`.

## Non-Goals

- No new SMTP provider or SMTP config surface.
- No real email send during tests or default local runs.
- No schema, migration, route, or production runtime change.
- No K3 PoC path touched.
- No claim that this transport-level D1 slice validates automation
  execution-log persistence with real SMTP. The existing RC automation
  smoke covers execution-log behavior with the default mock channel;
  repeat-fire automation-log soak remains Lane D4.

## Files

| Path | Purpose |
| --- | --- |
| `scripts/ops/multitable-phase3-release-gate.mjs` | Adds `email:real-send` routing and delegate execution. |
| `scripts/ops/multitable-phase3-release-gate-report.mjs` | Renders delegated command and child report paths. |
| `scripts/ops/multitable-phase3-release-gate.test.mjs` | Covers delegate BLOCKED behavior, aggregate child count, and SMTP redaction. |
| `docs/development/multitable-feishu-phase3-ai-hardening-todo-20260514.md` | Updates Phase 0 / D0 status and D1 aggregation notes. |
| `docs/development/multitable-phase3-real-smtp-gate-development-20260514.md` | This design and implementation record. |
| `docs/development/multitable-phase3-real-smtp-gate-verification-20260514.md` | Verification evidence. |

## Stage-1 Lock Compliance

- No changes under `plugins/plugin-integration-core/*`.
- No changes under K3 adapter paths.
- No new AI or industry-template product surface.
- No staging or live SMTP credentials recorded.
- Real-send remains opt-in through explicit env confirmation.
