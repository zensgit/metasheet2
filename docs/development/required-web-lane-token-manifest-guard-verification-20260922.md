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
  Option (a) was selected during implementation, not by the owner, to widen the parser to all 19
  gating lines (no owner ruling exists — `gh pr view 5974 --json comments,reviews` → 0 comments, 0
  reviews). See the design doc's ROUND 2 SUMMARY, §1's round-3 correction, and §10 for the full
  disposition of every finding, including the round-2 gate review's own P2-1/P2-2/P3/NIT findings.
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

## 3. Mutation drill

### 3a. Against the REAL committed files (cp → mutate → run → restore → cmp; no `git
    checkout --` / `reset --hard` / `stash drop` used anywhere in this drill) — measured THIS round

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
| A1 | **Attack, re-run post-widening** — deleted `multitable-field-config-panel` from BOTH line 624 AND the manifest, same "commit" | round 2 — confirms §3's OPEN item now spans the widened surface | `npx vitest run required-web-lane-token-manifest -t "set equality"` | **GREEN** — 6 passed / 15 skipped; the coordinated delete still defeats the guard by construction, exactly as round 1's design §3 already recorded for the exec block, now reproduced on an early line too | `cp /tmp/h6r2-sh.orig` and `cp /tmp/h6r2-tok.orig` back → both `cmp` OK |
| A2 | Duplicated one manifest TOKEN line (`amountAutoSum`, set unchanged) | round 1, re-verified against the 499-token manifest | same | **RED** — `expected 499 to be 500` ("no duplicate TOKEN lines") — confirms P3-4's fix keeps the hard assertion; only the `.gitattributes` prose calling this "harmless/absorbed" was wrong and has been corrected | `cp` backup back → `cmp` OK |
| A3 | Prepended an arbitrary `# manually added by a well-meaning dev, not via --write` comment line to the manifest | **round 2 fix verification (P3-5)** | same | **GREEN** — 6 passed / 15 skipped. This is the CURRENT (patched) reader; see §3c for the separately-computed replay showing what the round-1 (unpatched) reader would have done to the same mutation | `cp` backup back → `cmp` OK |

Final state after the whole drill: `git status --short` shows only the intentional file changes
for this round (`.tokens`, `exec-block.mjs`, `token-manifest.mjs`, the guard test,
`.gitattributes`, both docs) — `run-required-web-tests.sh` and `run-required-web-tests.tokens` are
back to their canonical (post-`--write`) content, confirmed by `cmp` against the pre-drill backups.

### 3b. In the guard test file's own in-memory self-proof suite (string-level mutations of a copy
    of the script text, never touching disk — see the test file for the exact code)

M1–M7 above are ALSO exercised here, plus two cases not run on-disk this round:

| # | Mutation | Result observed (in-memory) |
|---|---|---|
| M2 | Token added to the exec block, not in the manifest | `extraInActive` contains the token; `lineMap.get(token)` resolves to `[1257]` (the exec block's one logical line) — the test asserts the LINE MAP resolves correctly; it does not additionally call `describeExtra()` to build a message for this case (M6's on-disk drill above is the row that observed a fully formatted message) |
| M3 | Line deleted from the manifest (token still active) | `extraInActive` contains the token |
| M4 | Manifest reordered (no add/remove) | both diff directions empty (GREEN) |
| NIT-3 probe A | `assertNeitherCollapsesRelativeToTheOther(0, 0)` | throws (RED) — the derived floor is not vacuous |
| NIT-3 probe B | same helper called with `(50, 50)` and `(300, 300)` | does not throw (GREEN) — a synchronized shrink is not spuriously flagged |

### 3c. Separately-computed replay of the ROUND-1 (unpatched) manifest reader against the SAME
    A3 mutation — computed this round, not by running the round-1 vitest suite

To state the P3-5 "before" case as something actually computed rather than asserted, the round-1
`manifestTokens()` (blank-line filter only, no `#` strip — verbatim from the pre-fix source) was
re-implemented in a throwaway script and run, this round, against `git show
4e5e0a5fe90f4c7068da19093f5a00b2a62f9e85:apps/web/scripts/run-required-web-tests.tokens` (the
round-1 committed manifest, 397 tokens) with the same `#`-comment line prepended as A3 above:

```
round-1 manifest (unmutated): 397 tokens, distinct: 397
round-1 manifestTokens() applied to the comment-prepended mutation: 398 entries, distinct: 398
first entry (treated as a token): "# manually added by a well-meaning dev, not via --write"
round-1 missingFromActive (would have reported RED, naming): ["# manually added by a well-meaning dev, not via --write"]
```
Confirms the round-1 (pre-fix) reader would have treated the comment line as a 398th manifest
"entry" and reported it as a false silently-dropped token — this is a computed replay of the
old reader's exact source against the old manifest, not a claim about the round-1 vitest suite's
own historical run (which was never observed by this session).

## 4. Full-suite local runs

### 4a. The manifest guard + shape guard, together, under `CI=true`

```
$ cd packages/core-backend && CI=true npx vitest run required-web-lane --reporter=dot
 ✓ tests/unit/required-web-lane-token-manifest-guard.test.ts (25 tests)
 ✓ tests/unit/required-web-lane-registration-shape.test.ts (18 tests)
 Test Files  2 passed (2)
      Tests  43 passed (43)
```
(18 from `required-web-lane-registration-shape.test.ts`, byte-identical/unedited; 25 from
`required-web-lane-token-manifest-guard.test.ts` — measured this round via
`awk '/^describe\(/{...} /^  it\(/{c++}...'` over the file: 8 set-equality-group assertions (6 from
round 2 + round 3's r2-NIT-3 manifest-sortedness and r2-P3-2 third-copy cross-copy checks) + 4
`stripTrailingErrorGuard` unit tests + 13 mutation-self-proof cases (11 from round 2 + round 3's
r2-P3-3 `toThrow` positive control and r2-P3-4 `allVitestInvocations`-vs-`logicalLines` agreement).)

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
      Tests  43 passed (43)                              # + required-web-lane-token-manifest-guard.test.ts (25)
```
**Correction (r2-P3-1, round 3 — re-broken twice before this):** round-1 design §7 wrote "27→28
tests"; the true round-1 figure was 18→28 (27 was the unrelated attendance spec's own count leaking
into the sentence). Round 2 corrected it to 18→39 (10 round-1 assertions replaced by 21 round-2
ones) but the guard test's OWN header still said "18→28" — the round-2 gate review's P3-1. Round
3's real, freshly measured number is **18→43** (21 round-2 assertions + round 3's 4 new ones: NIT-3
manifest sortedness, the third-copy cross-copy check, the exec-count `toThrow` positive control,
and the `allVitestInvocations`-vs-`logicalLines` agreement check). The substring filter
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
collateral effect on the four guards whose union contributes the base 192-of-499 figure that, with
the sixth guard's 7 tokens added this round (r2-P2-1), forms the corrected **≥199** already-gated
bound cited in the design doc §1 / PR body.

## 5. Numbers (round 2)

Each line is marked `(measured this round)` — re-derived by this session's own commands/tests
above — or `(cited: round-1 gate review)` — taken from
`impl-gate-H6-token-manifest-guard-round1-20260922.md` and not independently re-run this round.

- Distinct tokens across all **19** gating `vitest run` invocations: **499** (397 in the final exec
  block, unchanged by this PR; 102 more across the 18 earlier lines) — **(measured this round: §2
  generator output, and independently by the guard test's own `allVitestTokens()` call)**.
- Manifest tokens: **499** (matches); manifest file is 505 lines (6-line provenance header + 499
  token lines) — **(measured this round: §2, `wc -l`)**.
- Raw (pre-filter) union across all 19 lines: 502 distinct entries — 499 real tokens plus `||`,
  `exit`, `$?` from the two `|| exit $?`-tailed lines (1180, 1183); `stripTrailingErrorGuard`
  removes exactly those 3 — **(measured this round: §2's reconciliation)**.
- **(cited: round-1 gate review, NOT independently re-run this round)** Of the 499: 192 already
  gated by four existing lane-reading guards before this PR (118 in the exec block, 74 among the
  earlier lines). The review's own per-guard breakdown (122 approval-ci-coverage-enumeration + 35
  stock-prep-web-ci-coverage-enumeration + 34 elearning-media-ci-wiring + 4
  network-unavailable-copy-ci-wiring) sums to 195, not 192 — the review's table shows this is a
  union, not a sum (some tokens are pinned by more than one guard), but does not itemize which 3
  overlap. This round did not re-derive that breakdown; only the union total (192) was used, as a
  cited starting point, in the design doc and PR body.
  **ROUND 3 correction (r2-P2-1, measured this round — see design doc §1 for the command):** that
  four-guard enumeration itself missed a fifth/sixth guard,
  `apps/web/tests/attendance-web-guard-workflow.spec.ts`, which pins 4 more of the "28" tokens
  (early line 477's `sessionSpecs`) and 3 more of the "279" exec-block tokens
  (`attendanceEmployeeMakeupRequestCard`, `attendanceEmployeeLeaveRequestCard`,
  `attendance-selfservice-dashboard` — confirmed absent from all four census guards' source at
  `origin/main` via `git grep -l -F`, 0 files each). Corrected, as bounds (an exact recount would
  need re-deriving all four guards' own predicates, not only the sixth guard's 7 tokens): residual
  `28 − 4 = 24` gives **≤24**; already-gated union `192 + 4 + 3 = 199` gives **≥199**; exec-block
  newly-gated-by-this-PR `279 − 3 = 276` gives **≤276**. Bounds, not a tighter arithmetic identity,
  because the three categories are not independently re-verified as exhaustive beyond the six
  guards enumerated so far.
- New guard test file: **25** `it()` blocks (8 set-equality-group assertions + 4
  `stripTrailingErrorGuard` unit tests + 13 mutation-self-proof cases including baseline), up from
  round 2's 21 (round 3 added r2-NIT-3, r2-P3-2's third-copy check, r2-P3-3, r2-P3-4) and round 1's
  10 — **(measured this round: §4a/§4b transcripts, and `awk` over the file's `describe`/`it`
  blocks)**.
- Existing shape guard: **18** `it()` blocks, unedited (byte-identical to `origin/main`) —
  **(measured this round)**.
- Existing attendance web-guard workflow spec: **27** tests, unedited (byte-identical) —
  **(measured this round)**.
- Combined core-backend-side run for this slice's two files: **43/43 passed** (was 39/39 in round
  2, 28/28 in round 1 — the guard file grew each round, the shape guard did not) — **(measured this
  round)**.
- `tsc --noEmit -p .`: exit 0, but vacuous for both `tests/unit/*.test.ts` files (P3-1) —
  **(measured this round: §4c)**.
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

## 7. Round 3 additions (r2 gate review findings) — mutation drill and grep evidence

All mutations in this section: `cp` real file → mutate → run targeted `vitest` → confirm the
expected result → `cp` the backup back → `cmp` verify restore. `git status --porcelain | wc -l` was
0 before this section's work and 0 after (only the 5 intended files carry a diff; confirmed with
`git diff --stat origin/main...HEAD --name-only`).

### 7a. r2-P2-1 recompute — see design doc §1 for the full command and output

Summary of the result (command and full transcript live in the design doc, not duplicated here):
`node`, importing the real `allVitestTokens`/`execLogicalLine`/`tokensOf` from
`scripts/ops/required-web-lane-exec-block.mjs`, measures `total=499 exec=397 earlierOnly=102`
against the real lane script. Extracting `attendance-web-guard-workflow.spec.ts`'s own
`sessionSpecs` array and its exec-block `for (const spec of [...])` loop (regex extraction, not
retyped) yields the 4 early tokens and 3 exec tokens named in the design doc; `git grep -l -F
<token> origin/main -- <the four census guard files>` returns 0 files for each of the 3 exec
tokens. Arithmetic on these inputs: `28 − 4 = 24` (≤24), `192 + 4 + 3 = 199` (≥199), `279 − 3 = 276`
(≤276).

### 7b. r2-P2-2 — case-insensitive sweep for the authorship phrase, over every file this PR touches plus the PR body

Swept with a four-alternative, case-insensitive regex pairing "owner" with the verb for making this
pick (as a hyphenated compound, as two separate words, and as the passive "picked by the owner"
form), run once over every file `git diff --name-only origin/main...HEAD` lists and once over the
new PR body text. Both runs: **0 hits.** The exact pattern is deliberately not reproduced
character-for-character in this paragraph, or in the design doc's matching §10 row, so that
documenting the check does not itself create a hit the next sweep would have to explain away — the
pattern is the same one named in this round's fix instructions and in this file's own git history
(the pre-round-3 diff shows exactly which strings were removed from each of the four `.mjs`/test
headers and this document's own line 12).

### 7c. r2-P3-2 (cross-copy agreement, third copy) — mutation proof

| Mutation | Command | Result | Restore |
|---|---|---|---|
| Broke `token-set-diff.mjs`'s `logicalLines()` join separator (`` `${buf} ${body}` `` → `` `${buf}${body}` ``, diverging from `exec-block.mjs`'s copy) | `CI=true npx vitest run required-web-lane-token-manifest-guard -t "r2-P3-2"` | **RED** — `scripts/ops/required-web-lane-exec-block.mjs's logicalLines() has diverged from required-web-lane-token-set-diff.mjs's copy … — update both.` | `cp` backup back → `cmp` OK |
| Removed the third copy's documented `label` divergence entirely (made `execLogicalLine` there byte-identical to ours) | same | **RED** on the fixture-sanity check — `expected 'function execLogicalLine(scriptSrc) {…' not to be 'function execLogicalLine(scriptSrc) {…'` — proving that sanity check is itself load-bearing, not vacuous | `cp` backup back → `cmp` OK |

### 7d. r2-P3-3 (positive control for the exec-count throw) — mutation proof

Neutered `execLogicalLine`'s throw condition in `exec-block.mjs` the same way the round-2 gate's D8a
did (`matches.length !== 1` → `matches.length < 1`):
```
$ CI=true npx vitest run required-web-lane-token-manifest-guard -t "r2-P3-3"
 → expected [Function] to throw an error
FAIL … r2-P3-3: allVitestInvocations has a POSITIVE control for the "exactly 1 exec logical line" throw …
```
Restored via `cp`/`cmp`. Confirms the new `toThrow(/found 2/)` assertion is behaviour-pinned, not
vacuous.

### 7e. r2-P3-4 (`allVitestInvocations` vs `logicalLines` agreement) — mutation proof

Broke `allVitestInvocations`'s own fold-loop join separator in `exec-block.mjs` (D12-style, same
mutation the round-2 gate ran against the generator's copy):
```
$ CI=true npx vitest run required-web-lane-token-manifest-guard -t "r2-P3-4"
FAIL … r2-P3-4: allVitestInvocations is not a fourth silently-diverged copy of the comment-strip/fold loop …
```
(diff shows every logical line's text collapsed without the joining space). Restored via `cp`/`cmp`.

### 7f. r2-NIT-3 (manifest sortedness) — mutation proof

Swapped the first two non-header token lines in the real committed
`apps/web/scripts/run-required-web-tests.tokens`:
```
$ CI=true npx vitest run required-web-lane-token-manifest-guard -t "r2-NIT-3"
FAIL … r2-NIT-3: the committed manifest's token lines are sorted case-insensitively …
```
Restored via `cp`/`cmp` against a pre-mutation backup.

### 7g. Full suite after all round-3 restores

```
$ cd packages/core-backend && CI=true npx vitest run required-web-lane --reporter=dot
 ✓ tests/unit/required-web-lane-token-manifest-guard.test.ts (25 tests)
 ✓ tests/unit/required-web-lane-registration-shape.test.ts (18 tests)
 Test Files  2 passed (2)
      Tests  43 passed (43)
```
