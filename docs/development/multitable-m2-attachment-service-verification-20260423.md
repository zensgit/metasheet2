# Multitable M2 Attachment Service — Verification (2026-04-23)

> Document type: verification / evidence
> Date: 2026-04-23
> Branch: `codex/multitable-m2-attachment-service-20260423`
> Worktree: `/Users/chouhua/Downloads/Github/metasheet2/.worktrees/m2-attachment`
> Baseline: `origin/main@8d2d3e1b0` after final rebase
> Paired with: `docs/development/multitable-m2-attachment-service-development-20260423.md`

## Commands run

All commands executed from the worktree.

### 1. Typecheck

```
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
```

Exit 0, no diagnostics.

### 2. New unit tests

```
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/multitable-attachment-service.test.ts --reporter=dot
```

Result:

```
Test Files  1 passed (1)
     Tests  24 passed (24)
  Duration  272ms
```

### 3. Full core-backend unit suite

```
pnpm --filter @metasheet/core-backend exec vitest run tests/unit --reporter=dot
```

Result:

```
Test Files  127 passed (127)
     Tests  1643 passed (1643)
  Duration  5.58s
```

Baseline comparison (same command on `origin/main@d1f35edf6`):

```
Test Files  126 passed (126)
     Tests  1619 passed (1619)
```

Delta: `+1 file / +24 tests`, matching the new
`tests/unit/multitable-attachment-service.test.ts`. No existing unit test regressed.

### 4. Attachment integration suite

```
DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' \
PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=postgres PGUSER=chouhua \
  pnpm --filter @metasheet/core-backend exec vitest \
    --config vitest.integration.config.ts run \
    tests/integration/multitable-attachments.api.test.ts \
    tests/integration/after-sales-installer-provisioning.api.test.ts --reporter=dot
```

Result:

```
Test Files  2 passed (2)
     Tests  13 passed (13)
  Duration  689ms
```

- `multitable-attachments.api.test.ts`: 10 tests pass — covers upload/download/delete/list
  all the way through storage + DB. Two scenarios intentionally provoke a
  "File not found" log from `StorageService.delete` (the DB row has a fabricated
  `storage_file_id`); the route still returns 200 because `deleteAttachmentBinary` swallows
  the error, which matches pre-extraction semantics.
- `after-sales-installer-provisioning.api.test.ts`: 3 tests pass — confirms M1 work still
  functions end-to-end now that the route delegates attachment operations.

### 5. Other multitable integration suites touched by the route layer

```
tests/integration/multitable-context.api.test.ts         — passes
tests/integration/multitable-record-form.api.test.ts     — passes
tests/integration/multitable-sheet-permissions.api.test.ts — passes
tests/integration/multitable-view-config.api.test.ts     — passes
tests/integration/multitable-sheet-realtime.api.test.ts  — 3 failures, pre-existing at baseline (see §6 below)
```

## 6. Pre-existing baseline failures

`tests/integration/multitable-sheet-realtime.api.test.ts` fails 3 tests with
`Error: expected 200 "OK", got 500 "Internal Server Error"` on the baseline commit
`origin/main@d1f35edf6` before any of this branch's edits are applied. Verified by running
`git stash && pnpm ... vitest run tests/integration/multitable-sheet-realtime.api.test.ts`
and observing the same 3 failures. Unrelated to this extraction.

## 7. Deliverables

| Path | Status |
|---|---|
| `packages/core-backend/src/multitable/attachment-service.ts` | created (559 LoC) |
| `packages/core-backend/tests/unit/multitable-attachment-service.test.ts` | created (24 tests) |
| `packages/core-backend/src/routes/univer-meta.ts` | modified (`-215 / +61` LoC) |
| `docs/development/multitable-m2-attachment-service-development-20260423.md` | created |
| `docs/development/multitable-m2-attachment-service-verification-20260423.md` | created |

No other files changed.

## 8. Commit

Single commit on branch `codex/multitable-m2-attachment-service-20260423`.

- Subject: `refactor(multitable): extract attachment-service from univer-meta (M2 slice 1)`
- Not pushed.

## 9. Roadmap anchor

- Section 5.3 (M2): first slice ✅ attachment-service
- Section 5.3 (M2): second slice — `record-service.ts` remains deferred
- Section 10 rule #2 — `univer-meta.ts` no longer carries inline attachment SQL ✅
- Section 10 rule #4 — unit tests added for the extracted module ✅

## 10. Rebase Verification - 2026-04-23

- Rebased `codex/multitable-m2-attachment-service-20260423` onto `origin/main@76ddfeacd`.
- Rebased HEAD: `5df3e1492`.
- No conflicts.
- `pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false`: pass.
- `tests/unit/multitable-attachment-service.test.ts`: 24/24 pass.
- Attachment + after-sales installer integration: 13/13 pass.
- Full `core-backend` unit suite: 127 files / 1647 tests passed.
- The two expected `StorageService.delete` "File not found" logs still occur only in the fabricated-storage-id delete scenarios and remain consistent with the preserved best-effort binary-delete semantics.

## 11. Final Rebase - 2026-04-23

- Rebased again onto `origin/main@8d2d3e1b0` after DingTalk P4 env/product-gate follow-ups merged.
- Final HEAD: `24a421b77`.
- No conflicts and no touched-file overlap with the new DingTalk P4 commits.
- Final quick recheck: `git diff --check` passed; `tests/unit/multitable-attachment-service.test.ts` passed again, 24/24.
