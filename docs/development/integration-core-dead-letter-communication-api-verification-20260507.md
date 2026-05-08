# Integration Core Dead-Letter Communication API Verification - 2026-05-07

## Local Verification

Worktree:

`/private/tmp/ms2-deadletter-comm-api`

Branch:

`codex/integration-deadletter-comm-api-20260507`

Baseline:

`origin/main` at `d921c93e7f5500f0ad83edc92b153b0da97d93f4`

Commands:

```bash
node plugins/plugin-integration-core/__tests__/plugin-runtime-smoke.test.cjs
pnpm install --frozen-lockfile
pnpm -F plugin-integration-core test
pnpm validate:plugins
git diff --check
```

Results:

- `plugin-runtime-smoke`: passed.
- `pnpm install --frozen-lockfile`: passed; lockfile unchanged.
- `pnpm -F plugin-integration-core test`: passed.
- `pnpm validate:plugins`: 13/13 valid, 0 errors.
- `git diff --check`: passed.

## Regression Coverage

Updated `plugin-runtime-smoke.test.cjs` to verify:

- communication `getStatus()` reports dead-letter store readiness.
- communication `getStatus()` reports dead-letter replay readiness.
- communication API exposes `listDeadLetters`.
- communication API exposes `getDeadLetter`.
- communication API exposes `replayDeadLetter`.
- `listDeadLetters()` returns dead-letter metadata.
- `listDeadLetters()` omits `sourcePayload` and `transformedPayload`.
- `getDeadLetter()` returns a single redacted dead-letter record.
- returned dead-letter records include `payloadRedacted: true`.

## Environment Note

The first full plugin test attempt stopped before business assertions because
the temporary worktree did not yet have local `node_modules`, so `node --import
tsx` could not resolve `tsx`. After `pnpm install --frozen-lockfile`, the same
test command completed successfully.
