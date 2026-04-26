# Integration-Core Dead-Letter Status Guard · Design

> Date: 2026-04-26
> PR: #1191

## Problem

`replayDeadLetter` performs two checks before calling `runPipeline`:
1. Dead letter exists (404 guard)
2. Source payload is not truncated (PAYLOAD_TRUNCATED guard)

Missing: **check that `deadLetter.status === 'open'`**.

Two failure modes:

### Double-replay (status='replayed')

Operator replays DL-1 → succeeds → DL-1 is `status='replayed'`.
A second replay attempt (double-click, automated retry, script) calls
`replayDeadLetter` again with the same ID. The code fetches the dead
letter (status='replayed'), passes both existing guards, and calls
`runPipeline` with the same source payload.

Consequences:
- K3 WISE `login` + `Material Save` API calls fire again
- A new `integration_runs` row is created (run-log pollution)
- `markReplayed` is called on the already-replayed letter, updating `retryCount` and `lastReplayRunId` again
- Idempotency layer blocks the duplicate ERP write — but the full adapter round-trip has already happened

### Discarded-letter replay (status='discarded')

A `status='discarded'` letter was deliberately excluded from the sync
(operator decision: "this record should not go to ERP"). Nothing blocks
a subsequent `POST /dead-letters/:id/replay` from re-introducing it.

## Solution

One guard added immediately after `getDeadLetter` and before the
truncation check:

```javascript
if (deadLetter.status !== 'open') {
  throw new PipelineRunnerError('dead letter cannot be replayed: status is not open', {
    id: deadLetter.id,
    status: deadLetter.status,
  })
}
```

**Error code**: `PipelineRunnerError` → HTTP 422 via the existing `inferHttpStatus`
mapping (`/PipelineRunner/.test(name) → 422`). The operator sees the
current status in `error.details.status`.

**Why 422 and not 409**: 409 Conflict implies a concurrency conflict
(another request is in progress). 422 Unprocessable Entity is the correct
code for "request is well-formed but cannot be executed on this resource
in its current state".

**Why silent clamp is not appropriate**: Unlike the list-limit cap (where
clamping is harmless), silently ignoring a non-open replay would mask the
operator's misunderstanding of the dead-letter lifecycle.

## Files changed

| File | Change |
|---|---|
| `lib/pipeline-runner.cjs` | 7 lines: status guard before truncation check in `replayDeadLetter` |
| `__tests__/pipeline-runner.test.cjs` | 3 new scenarios (double-replay, unchanged target, discarded) |
| this design doc | — |
| matching verification doc | — |

## Dead-letter lifecycle reminder

```
open → replayed   (successful replay)
open → open       (failed replay: rowsFailed > 0 — stays open for retry)
open → discarded  (operator manually discards via future discard endpoint)
replayed → [end]  (no further state transitions)
discarded → [end] (no further state transitions)
```

The guard ensures only `open` letters can trigger a replay run. The
other two terminal-or-final states are explicitly rejected.

## Cross-references

- `lib/dead-letter.cjs` — `VALID_STATUSES`, `markReplayed`
- `lib/pipeline-runner.cjs` — `replayDeadLetter`, `isTruncatedReplayPayload`
- PR #1187 — concurrent-run guard (the new run from replay is also protected)
