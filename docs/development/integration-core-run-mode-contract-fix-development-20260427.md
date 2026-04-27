# Integration-Core Run Mode Contract Fix Development - 2026-04-27

## Context

Post-merge review of `origin/main@f372b9180` found a contract mismatch in the integration pipeline run route:

- REST `publicRunInput()` accepted `scheduled` as a public `mode`.
- The run ledger `normalizeCreateRunInput()` accepts `manual`, `incremental`, `full`, and internal `replay`.
- `replay` must remain internal-only.

That meant `mode = scheduled` passed the HTTP boundary and then failed later when creating the run. It also meant public `mode = full`, which the run ledger supports, was incorrectly rejected by the HTTP guard.

## Change

The public REST mode allowlist now matches the run-ledger public modes:

- `manual`
- `incremental`
- `full`

The route still rejects:

- `replay` because it is internal-only for dead-letter replay.
- `scheduled` because scheduling is a trigger/source concern, not a run execution mode.
- unknown or incorrectly cased values.

## Files

- `plugins/plugin-integration-core/lib/http-routes.cjs`
- `plugins/plugin-integration-core/__tests__/http-routes.test.cjs`

## Notes

No pipeline-runner or DB schema change was needed. This is a REST boundary correction so requests cannot pass a mode that the authoritative run ledger rejects.
