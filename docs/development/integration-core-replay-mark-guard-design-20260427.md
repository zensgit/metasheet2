# Integration-Core Replay Mark Guard Design - 2026-04-27

## Context

`replayDeadLetter()` replays an `open` dead letter by running the pipeline with the original source payload. When the replay succeeds, the runner marks the dead letter as `replayed`.

Before this change, a failure in `deadLetterStore.markReplayed()` after a successful ERP write would throw to the caller. That is dangerous: the operator sees a failed replay and may retry, even though the ERP write already happened.

## Goal

Do not turn successful ERP writeback into a retriable failure because the bookkeeping update failed.

## Design

After a successful replay run, marking the dead letter as replayed becomes best-effort:

```javascript
let replayed = deadLetter
let markReplayedWarning = null
try {
  replayed = await deadLetterStore.markReplayed(...)
} catch (markError) {
  markReplayedWarning = {
    code: 'MARK_REPLAYED_FAILED',
    message: markError.message || String(markError),
  }
}
```

The function still returns the successful replay result and includes a structured `warning` when the mark step fails.

## Behavior

| Case | Result |
| --- | --- |
| replay writes rows and `markReplayed()` succeeds | returns replayed dead-letter row |
| replay writes rows and `markReplayed()` fails | returns original dead-letter row plus `warning.code = MARK_REPLAYED_FAILED` |
| replay has failed rows | unchanged: returns without marking replayed |
| dead letter is not `open` | rejected by PR #1191 before replay |

## Why Not Throw

The ERP write is the side effect with the larger business impact. Throwing after that side effect encourages duplicate replay attempts. Returning a warning preserves operator visibility while avoiding a false retriable failure.

## Files

- `plugins/plugin-integration-core/lib/pipeline-runner.cjs`
- `plugins/plugin-integration-core/__tests__/pipeline-runner.test.cjs`

## Merge Interaction

This branch was merged with current `origin/main` and keeps PR #1191's dead-letter status guard. The new mark-replay warning path runs only after an `open` dead letter has been replayed successfully.
