# Yjs Internal Rollout Signoff Template

Date: 2026-04-16

Use this after the first limited internal rollout run.

## Rollout Context

- Environment:
- Rollout owner:
- Review approver:
- Rollout window:
- Enabled by:
- `ENABLE_YJS_COLLAB` value:

## Target Scope

- Pilot sheets:
- Pilot users:
- Expected concurrent editors:
- Excluded critical sheets:

## Evidence

- Runtime status report path:
- Retention health report path:
- Combined rollout report path:
- Packet export path:

## Runtime Snapshot

- `enabled`:
- `initialized`:
- `activeDocCount`:
- `pendingWriteCount`:
- `flushFailureCount`:
- `activeSocketCount`:

## Retention Snapshot

- `statesCount`:
- `updatesCount`:
- `orphanStatesCount`:
- `orphanUpdatesCount`:
- Hottest record observed:

## User Validation

- Text field collaborative editing verified:
- Reconnect / resume verified:
- Presence / awareness verified:
- Unexpected write failures:
- Unexpected flush failures:

## Decision

- [ ] GO: keep pilot enabled
- [ ] HOLD: keep enabled but do not expand
- [ ] NO-GO: disable `ENABLE_YJS_COLLAB`

## Notes

- Follow-up actions:
- Known limitations accepted:
- Rollback required:
