# H-6 — required web lane token-loss guard: verification

- Date: 2026-09-22 (UTC+8)
- Branch: `ci/required-web-lane-token-manifest-guard`
- Base: `origin/main` @ `cd42eaf7455f03dd99021a02c47c42f1f3db6484`
- Verified head (this branch, before push): see the PR-open report for the exact commit SHA — this
  document was authored on the worktree just before that commit.
- Local worktree: git worktree of the canonical `metasheet2` clone under
  `/private/tmp/claude-501/…/scratchpad/h6-token-manifest-guard`, `node_modules` symlinked from the
  canonical checkout (root, `apps/web`, `packages/core-backend`, `plugins/*`).
- Node `v25.9.0`, `vitest/1.6.1`, `pnpm` via the repo's own toolchain (no reinstall needed —
  symlinked `node_modules`).
- **NOT RUN**: real GitHub Actions CI. Everything below is a local reproduction of what the
  required `test (18.x)`/`test (20.x)` jobs would run (same `pnpm --filter @metasheet/core-backend
  test` invocation, same `vitest.config.ts`, `CI=true` set to match the retry semantics that
  config reads — see `packages/core-backend/vitest.config.ts`'s `retry: process.env.CI ? 2 : 0`).
  Real CI status is only known once this branch is pushed and the draft PR's checks report.

## 1. Baseline: this branch does not change the active token SET

```
$ node scripts/ops/required-web-lane-token-set-diff.mjs origin/main
before (origin/main):        397 tokens, 397 distinct
after  (<working tree>): 397 tokens, 397 distinct
SET IDENTICAL — every filter the old invocation handed vitest is still handed to it.
```
Exit 0. `apps/web/scripts/run-required-web-tests.sh` is untouched by this PR (confirmed separately
by `cmp` against a pre-change backup after every mutation drill below — see §3).

## 2. Generator round-trip

```
$ node scripts/ops/required-web-lane-token-manifest.mjs        # before the manifest existed
active exec block:  397 tokens, 397 distinct
committed manifest: 0 tokens, 0 distinct
EXTRA IN ACTIVE (397) — …
exit=1

$ node scripts/ops/required-web-lane-token-manifest.mjs --write
wrote 397 tokens to apps/web/scripts/run-required-web-tests.tokens (from 397 in the active exec
block, 397 distinct).
exit=0

$ node scripts/ops/required-web-lane-token-manifest.mjs        # after --write
active exec block:  397 tokens, 397 distinct
committed manifest: 397 tokens, 397 distinct
MANIFEST MATCHES — the committed token set equals the active exec block's token set.
exit=0
```
`apps/web/scripts/run-required-web-tests.tokens`: 397 lines, sorted case-insensitively (same order
convention as the exec block it mirrors — not load-bearing for the guard, which is set-based, but
keeps the file's own diffs small).

## 3. Mutation drill — against the REAL files (cp → mutate → run → restore → cmp; no `git
   checkout --` / `reset --hard` / `stash drop` used anywhere in this drill)

Backups taken once at the top: `cp apps/web/scripts/run-required-web-tests.sh /tmp/h6-sh.orig`,
`cp apps/web/scripts/run-required-web-tests.tokens /tmp/h6-tok.orig`.

| # | Mutation | Command run | Result | Restore verified |
|---|---|---|---|---|
| M1 | Deleted the `amountAutoSum` token line from the active exec block | `npx vitest run required-web-lane-token-manifest -t "set equality"` | **RED** — `AssertionError: 1 token(s) recorded in apps/web/scripts/run-required-web-tests.tokens are no longer in the active exec block — they silently stopped running in the required web lane: amountAutoSum` (1 failed, 3 passed, 5 skipped by the `-t` filter) | `cp /tmp/h6-sh.orig` back → `cmp` OK → re-run: 4 passed / 5 skipped |
| M2 | Added a token `zzzH6MutationExtraToken` to the active exec block, absent from the manifest | same | **RED** — `AssertionError: 1 token(s) in the active exec block are not in apps/web/scripts/run-required-web-tests.tokens — run \`node scripts/ops/required-web-lane-token-manifest.mjs --write\` and commit the result in the SAME PR that added them: zzzH6MutationExtraToken` | `cp /tmp/h6-sh.orig` back → `cmp` OK |
| M3 | Deleted the `amountAutoSum` line from the **manifest** (token still active) | same | **RED** — same "extra in active" assertion, naming `amountAutoSum` (the manifest no longer vouches for a token the lane still runs) | `cp /tmp/h6-tok.orig` back → `cmp` OK |
| M4 | Reversed the manifest file's line order (`tail -r`); no token added/removed | `npx vitest run required-web-lane-token-manifest` (full file, no `-t` filter) | **GREEN** — 9/9 passed (confirms set, not sequence, semantics) | `cp /tmp/h6-tok.orig` back → `cmp` OK; generator `--write` regenerates a byte-identical file (`cmp` OK) |

Final state after the drill: `git status --short` shows only the four intended new/untracked
files plus the `.gitattributes` addition — `run-required-web-tests.sh` and (after the final
`--write`) `run-required-web-tests.tokens` are back to their canonical content, confirmed by `cmp`
against the pre-drill backups and by re-running the full guard file clean (see §4).

## 4. Full-suite local runs

### 4a. The three named guards, together, under `CI=true`

```
$ cd packages/core-backend && CI=true npx vitest run required-web-lane --reporter=verbose
… (28 tests, both files)
 Test Files  2 passed (2)
      Tests  28 passed (28)
```
(18 from `required-web-lane-registration-shape.test.ts`, unedited; 10 from the new
`required-web-lane-token-manifest-guard.test.ts`.)

```
$ cd apps/web && CI=true npx vitest run attendance-web-guard-workflow --reporter=dot
 Test Files  1 passed (1)
      Tests  27 passed (27)
```
(unedited — this guard is unrelated to the exec-block token set and is run here only because the
task named it as one of the "两个既有守卫".)

### 4b. Collection proof (not a targeted-run proof — see design doc §7)

```
$ npx vitest run required-web-lane --reporter=verbose   # BEFORE adding the new guard file
 Test Files  1 passed (1)
      Tests  18 passed (18)                              # required-web-lane-registration-shape.test.ts only

$ npx vitest run required-web-lane --reporter=verbose   # AFTER adding the new guard file
 Test Files  2 passed (2)
      Tests  28 passed (28)                              # + required-web-lane-token-manifest-guard.test.ts
```
The substring filter `required-web-lane` is applied by vitest to the file list already globbed
under `packages/core-backend/vitest.config.ts`'s real (default-include, explicit-exclude) config —
it is not a literal path handed to a loader. The file count going 1→2 under an unchanged filter
string, purely as a result of the new file existing on disk, is the mechanical evidence that the
package's default `vitest` collection (exactly what `pnpm --filter @metasheet/core-backend test`
invokes, which is exactly what the required `test (18.x)`/`test (20.x)` jobs' "Run core-backend
tests" step invokes) picks up the new guard — not merely that the guard passes when named directly.

### 4c. Type-check

```
$ cd packages/core-backend && npx tsc --noEmit -p .
(no output)
$ echo $?
0
```

## 5. Numbers

- Active exec-block tokens: **397** (unchanged by this PR).
- Manifest tokens: **397** (matches).
- New guard test file: **10** `it()` blocks (5 assertions + 5 mutation self-proof cases, including
  baseline).
- Existing shape guard: **18** `it()` blocks, unedited.
- Existing attendance web-guard workflow spec: **27** tests, unedited.
- Combined core-backend-side run for this slice's two files: **28/28 passed**.
- Files changed by this PR: 4 new (`scripts/ops/required-web-lane-exec-block.mjs`,
  `scripts/ops/required-web-lane-token-manifest.mjs`,
  `apps/web/scripts/run-required-web-tests.tokens`,
  `packages/core-backend/tests/unit/required-web-lane-token-manifest-guard.test.ts`) + 2 docs (this
  file and the design doc) + 1 modified (`.gitattributes`, +10 lines). Zero bytes changed in
  `apps/web/scripts/run-required-web-tests.sh`,
  `packages/core-backend/tests/unit/required-web-lane-registration-shape.test.ts`,
  `scripts/ops/required-web-lane-token-set-diff.mjs`, or
  `apps/web/tests/attendance-web-guard-workflow.spec.ts`.

## 6. Open items (owner disposition, not resolved by this PR)

1. §3 of the design doc's adversarial self-check: a PR that removes a token from the exec block
   *and* the matching manifest line in the same commit defeats this guard by construction. The
   mitigation this PR provides is **reviewability** (a second, named file changes in the diff), not
   **prevention**. Recorded, not closed.
2. Four in-flight PRs referenced in the task (short codes A-2/A-4/A-5/B-2) are, per the 2026-09-21
   independent verification, currently touching the same exec block. None of them carry this
   manifest yet. Whoever merges them will need to run `node
   scripts/ops/required-web-lane-token-manifest.mjs --write` and commit the result, in the same PR
   or as an immediate follow-up, or this guard will red on `main` the moment their tokens land
   without a matching manifest update.
3. No DDL, no branch-protection change, no merge, no undraft performed or requested by this PR.
