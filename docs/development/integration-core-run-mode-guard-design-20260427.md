# Integration-Core Run Mode Guard Design - 2026-04-27

## Context

The REST API accepts `mode` on pipeline run and dry-run requests. Internally, the runner also uses `mode = replay` when `replayDeadLetter()` executes a dead-letter replay.

Before this change, public callers could send arbitrary mode strings, including the internal-only `replay` mode. That blurs the boundary between user-triggered execution and dead-letter replay, and can make run logs look like an official replay even though no dead-letter lifecycle checks happened.

## Goal

Only allow user-facing run modes at the REST boundary:

- `manual`
- `incremental`
- `scheduled`

The internal `replay` mode remains available only through `replayDeadLetter()`.

## Design

`publicRunInput()` validates `body.mode` before building the runner input:

```javascript
const VALID_USER_RUN_MODES = new Set(['manual', 'incremental', 'scheduled'])

if (body.mode !== undefined && body.mode !== null && body.mode !== '') {
  if (!VALID_USER_RUN_MODES.has(body.mode)) {
    throw new HttpRouteError(400, 'INVALID_RUN_MODE', ...)
  }
}
```

Empty string is treated as absent to preserve existing form-submission behavior.

## Merge Interaction

This branch was merged with current `origin/main` and keeps the list-limit guard from PR #1192:

- `MAX_LIST_LIMIT`
- `asListLimit()`
- capped list endpoint call sites

The run-mode validation is independent and applies to both `/run` and `/dry-run`.

## Files

- `plugins/plugin-integration-core/lib/http-routes.cjs`
- `plugins/plugin-integration-core/__tests__/http-routes.test.cjs`

## Non-Goals

- This does not change internal pipeline-runner modes.
- This does not lowercase user input; `MANUAL` remains invalid so operators catch bad payloads early.
- This does not add new modes.
