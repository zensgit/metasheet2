# Multitable M2 slice 3 — PATCH record-service extraction verification

Date: 2026-04-23
Branch: `codex/multitable-m2-record-patch-extraction-20260423`
Worktree: `/Users/chouhua/Downloads/Github/metasheet2/.worktrees/m2-record-patch`
Base: `origin/main@059ea44fc` (after fast-forward from `61f32f318`)
Paired with: `docs/development/multitable-m2-record-patch-extraction-development-20260423.md`

## Scope recap

- Merged slice commit `059ea44fc` shipped the `RecordService.patchRecord()`
  extraction and its unit coverage.
- This branch adds a new integration test
  (`tests/integration/multitable-record-patch.api.test.ts`) that locks the
  extracted PATCH handler's HTTP contract and SQL/tx ordering against the
  mock pool.
- No source files were modified on top of `059ea44fc`.

## Commands & results

All commands were run from the worktree root
`/Users/chouhua/Downloads/Github/metasheet2/.worktrees/m2-record-patch`.

### 1. TypeScript

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
```

Result: clean, no output. No type errors introduced by the new
integration test file.

### 2. Focused unit coverage for the service

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/record-service.test.ts \
  tests/unit/multitable-attachment-service.test.ts \
  --reporter=dot
```

Result:
```
 ✓ tests/unit/multitable-attachment-service.test.ts  (24 tests) 5ms
 ✓ tests/unit/record-service.test.ts  (11 tests) 5ms

 Test Files  2 passed (2)
      Tests  35 passed (35)
```

`record-service.test.ts` here is the merged slice's own test file (11
tests covering `createRecord`, `deleteRecord`, `patchRecord`, and the
error classes). All pass on the current working tree.

### 3. New integration test + adjacent integration suites

```bash
DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' PGHOST=127.0.0.1 \
PGPORT=5432 PGDATABASE=postgres PGUSER=chouhua \
  pnpm --filter @metasheet/core-backend exec \
    vitest --config vitest.integration.config.ts run \
      tests/integration/multitable-record-patch.api.test.ts \
      tests/integration/multitable-attachments.api.test.ts \
      tests/integration/multitable-sheet-realtime.api.test.ts \
      --reporter=dot
```

Result:
```
 ✓ tests/integration/multitable-sheet-realtime.api.test.ts  (3 tests) 364ms
 ✓ tests/integration/multitable-record-patch.api.test.ts    (6 tests) 387ms
 ✓ tests/integration/multitable-attachments.api.test.ts     (10 tests) 463ms

 Test Files  3 passed (3)
      Tests  19 passed (19)
```

Test counts:

- `multitable-record-patch.api.test.ts` — 6 tests (new in this branch).
- `multitable-attachments.api.test.ts` — 10 tests (unchanged by this branch).
- `multitable-sheet-realtime.api.test.ts` — 3 tests (unchanged by this branch).

The console noise under `multitable-attachments.api.test.ts` ("Failed
to delete file: storage_att_…") is pre-existing expected test
behavior: the DB row has a fabricated `storage_file_id` and the
`LocalStorageProvider.delete` throws `File not found`. The route's
best-effort cleanup swallows the error so the 200 response is
preserved. This log noise is captured in
`multitable-m2-attachment-service-development-20260423.md` §3.5.

### 4. Full unit regression

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit --reporter=dot
```

Result:
```
 Test Files  133 passed (133)
      Tests  1684 passed (1684)
```

Baseline at `61f32f318` (the brief's stated base) had 127 files /
1643 tests for this suite per the M2 slice 1 verification doc. The
merged slice `059ea44fc` brings the count to 133 files / 1684 tests —
the delta matches the merged `record-service.test.ts` rewrites
introduced by `059ea44fc` plus the already-extracted
`multitable-attachment-service.test.ts`.

No test regressions attributable to this branch.

## Baseline failures confirmed

No pre-existing failures on `origin/main@059ea44fc` in the commands
above. The attachment test console-error noise is expected test
plumbing, not a failure (both tests report `passed`).

Prior M2 slice 1 verification doc flagged three pre-existing failures
in `tests/integration/multitable-sheet-realtime.api.test.ts` at the
`d1f35edf6` baseline. As of `059ea44fc` those tests pass (3/3) — the
failures were resolved by intervening commits on `main`.

## Acceptance checklist

| Check | Result |
|---|---|
| `tsc --noEmit --pretty false` clean | pass |
| New integration test `multitable-record-patch.api.test.ts` passes | 6/6 |
| Existing unit suite green | 133 files / 1684 tests pass |
| Adjacent integration suites green | 19/19 pass |
| Merged slice unit tests still green | 11/11 pass |
| No source files modified beyond merged slice | verified via `git status` (source tree = `059ea44fc`) |

## Not committed

Per the brief's "STOP and report — do not commit half-baked" escape
clause, this branch did NOT land a duplicate of the extraction the
sibling agent already merged as `059ea44fc`. The only outstanding
additions on this branch are:

- `packages/core-backend/tests/integration/multitable-record-patch.api.test.ts`
- `docs/development/multitable-m2-record-patch-extraction-development-20260423.md`
- `docs/development/multitable-m2-record-patch-extraction-verification-20260423.md`

The reviewer can decide whether to merge these three files as a
follow-up patch. They are additive — no conflict with `059ea44fc` is
possible.

## Codex Rebase Verification - 2026-04-23

Branch was checked after `origin/main@059ea44fc` became the shared base.

```bash
git fetch origin main
git rebase --autostash origin/main
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/integration/multitable-record-patch.api.test.ts \
  --reporter=dot
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Result:

- Rebase: already up to date on `origin/main@059ea44fc`.
- `multitable-record-patch.api.test.ts`: `6/6` passed.
- Backend `tsc --noEmit`: exit `0`.

Review note:

- This branch remains pure additive coverage + docs. No source file is changed.
