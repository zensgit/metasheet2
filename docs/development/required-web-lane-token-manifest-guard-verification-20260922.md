# H-6 — required web lane token-loss guard: verification

- Date: 2026-09-22 (UTC+8), round 2 (scope widened) same day
- Status: PROPOSED (candidate — awaiting owner disposition)
- Branch: `ci/required-web-lane-token-manifest-guard`
- Base: `origin/main` @ `cd42eaf7455f03dd99021a02c47c42f1f3db6484`
- Verified head (round 2, before push): see the PR-open/edit report for the exact commit SHA — this
  document was authored on the worktree just before that commit.
- Round-1 head (superseded by this round's commit): `4e5e0a5fe90f4c7068da19093f5a00b2a62f9e85`.
- Independent gate review of round 1 (CHANGES-REQUESTED, 1 P1, 2 P2, 7 P3, 3 NIT):
  `/Users/chouhua/.claude/projects/-Users-chouhua-Downloads-Github-metasheet2/reviews/impl-gate-H6-token-manifest-guard-round1-20260922.md`.
  Owner-selected fix for the P1: option (a), widen the parser to all 19 gating lines. See the
  design doc's ROUND 2 SUMMARY and §10 for the full disposition of every finding.
- Local worktree: git worktree of the canonical `metasheet2` clone under
  `/private/tmp/claude-501/…/scratchpad/d2-h6-token-manifest`, `node_modules` symlinked from the
  canonical checkout (root, `apps/web`, `packages/core-backend`, `plugins/*`).
- Node `v25.9.0`, `vitest/1.6.1`, `pnpm` via the repo's own toolchain (no reinstall needed —
  symlinked `node_modules`).
- **NOT RUN**: real GitHub Actions CI. Everything below is a local reproduction of what the `test`
  job would run (same `pnpm --filter @metasheet/core-backend test` invocation, same
  `vitest.config.ts`, `CI=true` set to match the retry semantics that config reads — see
  `packages/core-backend/vitest.config.ts`'s `retry: process.env.CI ? 2 : 0`). Only `test (20.x)`
  is a required branch-protection context (`test (18.x)` runs the identical step but is not itself
  required — P3-3, corrected from round 1). Real CI status is only known once this branch is
  pushed and the PR's checks report — **re-check `gh pr checks 5974` before any merge decision.**

## 1. Baseline: this branch does not change any of the 19 gating lines' token SET

```
$ node scripts/ops/required-web-lane-token-set-diff.mjs origin/main
before (origin/main):        397 tokens, 397 distinct
after  (<working tree>): 397 tokens, 397 distinct
SET IDENTICAL — every filter the old invocation handed vitest is still handed to it.
```
Exit 0. This script only reads the exec block (unedited since round 1; its own copy of the parser
is untouched — see design doc §4). `apps/web/scripts/run-required-web-tests.sh` is untouched by
this PR in its entirety, confirmed by `git diff --stat origin/main -- apps/web/scripts/run-
required-web-tests.sh` returning no output (byte-identical), and separately by `cmp` against a
pre-change backup after every mutation drill below (§3).

## 2. Generator round-trip (round 2: widened to the union of 19 gating invocations)

```
$ node scripts/ops/required-web-lane-token-manifest.mjs        # against the round-1 397-token manifest
active (19 gating invocations): 499 distinct tokens
committed manifest: 397 tokens, 397 distinct
EXTRA IN ACTIVE (102) — produced by a gating invocation but not yet recorded in the manifest, run
with --write and commit the result: accountIdentityDisplay approval-authoring-history … (102 total,
matching the round-1 gate review's P1-1 census exactly)
exit=1

$ node scripts/ops/required-web-lane-token-manifest.mjs --write
wrote 499 tokens to apps/web/scripts/run-required-web-tests.tokens (union of 19 gating `vitest run`
invocations in apps/web/scripts/run-required-web-tests.sh, 499 distinct).
exit=0

$ node scripts/ops/required-web-lane-token-manifest.mjs        # after --write
active (19 gating invocations): 499 distinct tokens
committed manifest: 499 tokens, 499 distinct
MANIFEST MATCHES — the committed token set equals the active token set.
exit=0
```
`apps/web/scripts/run-required-web-tests.tokens`: 505 lines total (6-line `#`-prefixed provenance
header — round 2, P3-5 — + 499 tokens), sorted case-insensitively (same order convention as the
exec block it partly mirrors — not load-bearing for the guard, which is set-based, but keeps the
file's own diffs small).

**Reconciling the `||`/`exit`/`$?` artifacts (round 2, addressing an under-description in the
round-1 review's own P1-1 fix note, which named only `$?`):** the raw union of `tokensOf()` over
all 19 lines, WITHOUT `stripTrailingErrorGuard`, has **502** distinct entries — 3 more than 499.
The 3 extra are `||`, `exit`, and `$?`, all produced by the `|| exit $?` tail on lines 1180 and
1183. All three are filtered by `stripTrailingErrorGuard` (not only `$?`); 502 − 3 = 499, which is
exactly the round-1 gate review's independently-derived total — confirming their parser handled
all three artifacts even though their prose named only one.

## 3. Mutation drill — against the REAL files (cp → mutate → run → restore → cmp; no `git
   checkout --` / `reset --hard` / `stash drop` used anywhere in this drill)

Backups taken once at the top: `cp apps/web/scripts/run-required-web-tests.sh /tmp/h6r2-sh.orig`,
`cp apps/web/scripts/run-required-web-tests.tokens /tmp/h6r2-tok.orig`. Every restore below is
`cmp`-verified against these backups; `git status --short` was empty (module-code changes only —
no `.sh`/`.tokens` diff) before and after the whole drill.

| # | Mutation | Scope | Command run | Result | Restore verified |
|---|---|---|---|---|---|
| M1 | Deleted the `amountAutoSum` physical line from the exec block | round 1, re-run unchanged | `npx vitest run required-web-lane-token-manifest -t "set equality"` | **RED** — `1 token(s) recorded in apps/web/scripts/run-required-web-tests.tokens are produced by NONE of the 19 gating \`vitest run\` invocations … (lines: 477, 501, …, 1257) … amountAutoSum` (1 failed / 5 passed / 15 skipped by the `-t` filter) | `cp /tmp/h6r2-sh.orig` back → `cmp` OK |
| **M5** | Deleted the ENTIRE physical line `npx vitest run multitable-field-config-panel --reporter=dot` (line 624, an EARLY, non-exec-block line) | **round 2 — P1-1 option (a) discriminating case** | same | **RED** — `1 token(s) … are produced by NONE of the 18 gating \`vitest run\` invocations … (lines: 477, 501, 539, 555, 556, 557, 566, 600, 612, 661, 689, 703, 729, 751, 784, 1179, 1182, 1256) … multitable-field-config-panel` — note the invocation count dropped 19→18 and every downstream line number shifted by −1 since a whole physical line was removed; the message correctly re-scans and reports the NEW line numbers, and (per design) does not claim to know 624 was the token's former line | `cp /tmp/h6r2-sh.orig` back → `cmp` OK |
| **M6** | Appended `zzzH6Round2RealDiskAddProbe` to the end of line 690's positional list (`permission-match-parity platform-app-shell platform-app-launcher` → `+ zzz…`) | **round 2 — line-attribution case** | same | **RED** — `1 token(s) are produced by a gating \`vitest run\` invocation … but are not recorded in … : zzzH6Round2RealDiskAddProbe@line(s) 690` — exact line named | `cp /tmp/h6r2-sh.orig` back → `cmp` OK |
| **M7** | Swapped the order of `approval-fwb-mapping-config`/`approval-fwb-mapping-editor` on line 555 (EARLY line, no add/remove) | **round 2** | same | **GREEN** — 6 passed / 15 skipped (all "set equality" assertions clean) | `cp /tmp/h6r2-sh.orig` back → `cmp` OK |
| M2 | Added a token to the exec block, absent from the manifest | round 1, re-verified via in-memory self-proof (see the test file; on-disk M2 is the same shape as M6 with a different anchor line) | `CI=true npx vitest run required-web-lane-token-manifest-guard --reporter=verbose` | **RED** — extra-in-active, names the token and `@line(s) 1257` | in-memory only, no disk mutation needed for this case (see the guard test file's own M2) |
| M3 | Deleted the `amountAutoSum` line from the **manifest** (token still active) | round 1, unchanged | `npx vitest run required-web-lane-token-manifest -t "set equality"` (in-memory in the guard's own self-proof suite; also reproduced on-disk in round 1) | **RED** — "extra in active", naming `amountAutoSum` | n/a (in-memory) |
| M4 | Reversed the manifest file's line order (`tail -r`) | round 1, unchanged | same | **GREEN** | n/a (in-memory; see guard file's own M4) |
| A1 | **Attack, re-run post-widening** — deleted `multitable-field-config-panel` from BOTH line 624 AND the manifest, same "commit" | round 2 — confirms §3's OPEN item now spans the widened surface | `npx vitest run required-web-lane-token-manifest -t "set equality"` | **GREEN** — 6 passed / 15 skipped; the coordinated delete still defeats the guard by construction, exactly as round 1's design §3 already recorded for the exec block, now reproduced on an early line too | `cp /tmp/h6r2-sh.orig` and `cp /tmp/h6r2-tok.orig` back → both `cmp` OK |
| A2 | Duplicated one manifest TOKEN line (`amountAutoSum`, set unchanged) | round 1, re-verified against the 499-token manifest | same | **RED** — `expected 499 to be 500` ("no duplicate TOKEN lines") — confirms P3-4's fix keeps the hard assertion; only the `.gitattributes` prose calling this "harmless/absorbed" was wrong and has been corrected | `cp` backup back → `cmp` OK |
| **A3** | Prepended an arbitrary `# manually added by a well-meaning dev, not via --write` comment line to the manifest | **round 2 fix verification (P3-5)** | same | **GREEN** — 6 passed / 15 skipped. Round 1 (unpatched) would have mis-parsed this as a 397th "token" and reported a FALSE missing-token drop naming the whole comment string — reproduced as the pre-fix behaviour during development of this round, not re-demonstrated on the committed code since the fix is now unconditional | `cp` backup back → `cmp` OK |

Final state after the whole drill: `git status --short` shows only the intentional file changes
for this round (`.tokens`, `exec-block.mjs`, `token-manifest.mjs`, the guard test,
`.gitattributes`, both docs) — `run-required-web-tests.sh` and `run-required-web-tests.tokens` are
back to their canonical (post-`--write`) content, confirmed by `cmp` against the pre-drill backups.

## 4. Full-suite local runs

### 4a. The manifest guard + shape guard, together, under `CI=true`

```
$ cd packages/core-backend && CI=true npx vitest run required-web-lane --reporter=dot
 ✓ tests/unit/required-web-lane-token-manifest-guard.test.ts (21 tests)
 ✓ tests/unit/required-web-lane-registration-shape.test.ts (18 tests)
 Test Files  2 passed (2)
      Tests  39 passed (39)
```
(18 from `required-web-lane-registration-shape.test.ts`, byte-identical/unedited; 21 from the
round-2 `required-web-lane-token-manifest-guard.test.ts` — 6 set-equality assertions + 4
`stripTrailingErrorGuard` unit tests + 11 mutation-self-proof cases, up from round 1's 10.)

```
$ cd apps/web && CI=true npx vitest run attendance-web-guard-workflow --reporter=dot
 Test Files  1 passed (1)
      Tests  27 passed (27)
```
(unedited — this guard is unrelated to the exec-block token set and is run here only because the
task named it as one of the "两个既有守卫".)

### 4b. Collection proof (not a targeted-run proof — see design doc §7)

```
$ npx vitest run required-web-lane --reporter=verbose   # guard file moved aside (pre-PR-equivalent)
 Test Files  1 passed (1)
      Tests  18 passed (18)                              # required-web-lane-registration-shape.test.ts only

$ npx vitest run required-web-lane --reporter=verbose   # guard file restored
 Test Files  2 passed (2)
      Tests  39 passed (39)                              # + required-web-lane-token-manifest-guard.test.ts (21)
```
**Correction (P3-2):** round-1 design §7 wrote "27→28 tests"; the true round-1 figure was 18→28 (27
was the unrelated attendance spec's own count leaking into the sentence). Round 2's real number is
**18→39** (10 round-1 assertions replaced by 21 round-2 ones). The substring filter
`required-web-lane` is applied by vitest to the file list already globbed under `packages/core-
backend/vitest.config.ts`'s real (default-include, explicit-exclude) config — not a literal path
handed to a loader — so the file count going 1→2 under an unchanged filter string is mechanical
evidence of collection under the real config, not merely that the guard passes when named directly.

### 4c. Type-check

```
$ cd packages/core-backend && npx tsc --noEmit -p .
(no output)
$ echo $?
0
$ npx tsc --noEmit -p . --listFiles | grep -c "required-web-lane"
0
```
**Correction (P3-1):** exit 0 does NOT mean this file (or its shape-guard neighbour) is
type-checked — `--listFiles` shows the program never opens either file (`tsconfig.json` excludes
`**/*.test.ts`). This is a pre-existing, repo-wide property of `tests/**`, not something this PR
changes; stated plainly here instead of presented as type-check coverage.

### 4d. Neighbour-suite health (proves the local environment is not trivially green)

```
$ CI=true npx vitest run approval-ci-coverage-enumeration stock-prep-web-ci-coverage-enumeration \
    network-unavailable-copy-ci-wiring required-web-lane-registration-shape --reporter=dot
 Test Files  4 passed (4)
      Tests  372 passed (372)
```
Unedited, unaffected by this PR's changes — re-run after the round-2 widening to confirm no
collateral effect on the four guards whose union contributes the "192 of 499 already gated" figure
cited in the design doc §1 / PR body.

## 5. Numbers (round 2)

- Distinct tokens across all **19** gating `vitest run` invocations: **499** (397 in the final exec
  block, unchanged by this PR; 102 more across the 18 earlier lines).
- Manifest tokens: **499** (matches); manifest file is 505 lines (6-line provenance header + 499
  token lines).
- Raw (pre-filter) union across all 19 lines: 502 distinct entries — 499 real tokens plus `||`,
  `exit`, `$?` from the two `|| exit $?`-tailed lines (1180, 1183); `stripTrailingErrorGuard`
  removes exactly those 3.
- Of the 499: **192** already gated by four existing lane-reading guards before this PR (118 in the
  exec block, 74 among the earlier lines: 122 approval-ci-coverage + 35 stock-prep-web + 34
  elearning-media + 4 network-unavailable, minus double-counting where noted in the design doc);
  **279** exec-block tokens newly gated by this PR; **28** earlier-line tokens newly gated by this
  PR that had NO gate at all before (P1-1's discriminating set).
- New guard test file: **21** `it()` blocks (6 set-equality assertions + 4 `stripTrailingErrorGuard`
  unit tests + 11 mutation-self-proof cases including baseline), up from round 1's 10.
- Existing shape guard: **18** `it()` blocks, unedited (byte-identical to `origin/main`).
- Existing attendance web-guard workflow spec: **27** tests, unedited (byte-identical).
- Combined core-backend-side run for this slice's two files: **39/39 passed** (was 28/28 in round
  1 — the guard file grew, the shape guard did not).
- `tsc --noEmit -p .`: exit 0, but vacuous for both `tests/unit/*.test.ts` files (P3-1).
- Files changed by this PR (round 2, cumulative over round 1): 4 modified/new code files
  (`scripts/ops/required-web-lane-exec-block.mjs`, `scripts/ops/required-web-lane-token-
  manifest.mjs`, `apps/web/scripts/run-required-web-tests.tokens`, `packages/core-backend/tests/
  unit/required-web-lane-token-manifest-guard.test.ts`) + 2 docs (this file and the design doc) + 1
  modified (`.gitattributes`, prose-only diff this round). Zero bytes changed in
  `apps/web/scripts/run-required-web-tests.sh`,
  `packages/core-backend/tests/unit/required-web-lane-registration-shape.test.ts`,
  `scripts/ops/required-web-lane-token-set-diff.mjs`, or
  `apps/web/tests/attendance-web-guard-workflow.spec.ts` — confirmed via `git diff --stat
  origin/main -- <path>` returning empty for all four, re-checked after the round-2 changes.

## 6. Open items (owner disposition, not resolved by this PR)

1. Design doc §3's adversarial self-check (re-verified in §3 above as mutation A1, now spanning all
   19 lines, not only the exec block): a PR that removes a token from any gating line *and* the
   matching manifest line in the same commit defeats this guard by construction. The mitigation
   this PR provides is **reviewability** (a second, named file changes in the diff), not
   **prevention**. Recorded, not closed.
2. Design doc §9's merge sequencing (P2-2, widened): four in-flight PRs (task's short codes
   A-2/A-4/A-5/B-2) are, per the 2026-09-21 independent verification, currently touching this same
   script. `strict: false` means none of their checks has to be individually red for a stale merge
   to red `test (20.x)` on `main` for everyone. Owner picks: merge this PR after those four land
   (rebase + regenerate once more), or before them provided each is re-run through `test (20.x)`
   first. Neither has been done by this PR.
3. No DDL, no branch-protection change, no merge, no undraft performed or requested by this PR.
4. Real CI at this head is NOT RUN as of this document — `gh pr checks 5974` must be re-checked,
   specifically for `test (20.x)`, before any merge decision.
