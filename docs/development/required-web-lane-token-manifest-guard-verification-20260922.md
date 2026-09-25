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
- **Round 4** (2026-09-22, same day): merge-train dry-run v3 gate findings G1/G2 — see §8 below and
  design doc §11 for root cause/fix. Round-3 head (superseded by this round's commit):
  `4d196c3d3ddc9bbcc723d7689cc134513d8dcf30`.
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

## 8. Round 4 (2026-09-22) — G1/G2 repro + fix, on both the standalone branch and the merge-train dry-run overlay

Design doc §11 has the root-cause narrative; this section is measured numbers and commands only.

### 8a. Repro — `refs/dryrun/mtv3-final` (main + 17 lanes incl. #5898, unmodified), one-off worktree

```
$ git -C /Users/chouhua/Downloads/Github/metasheet2 worktree add <scratch>/h6-r4-dryrun refs/dryrun/mtv3-final --detach
HEAD is now at a93bea106 Merge commit '2a16ae841338af4c7dfc630d3be984f826494c47' into HEAD
$ cd <scratch>/h6-r4-dryrun/packages/core-backend
$ CI=true npx vitest run tests/unit/required-web-lane-token-manifest-guard.test.ts \
    --pool=forks --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3
```
Two reds, both quoted verbatim from the run:
```
✗ cross-copy agreement: logicalLines/execLogicalLine/tokensOf are textually identical … (P3-6)
  AssertionError: … has diverged from required-web-lane-registration-shape.test.ts's copy …
  expected 'function logicalLines(scriptSrc) { co…' to be 'function logicalLines(scriptSrc) { re…'

✗ M2 a token added to the FINAL EXEC BLOCK …
  AssertionError: expected [ 1359 ] to deeply equal [ 1257 ]

 Test Files  1 failed (1)
      Tests  2 failed | 23 passed (25)
```
Matches the dry-run report's §2 gate-2 row and §4 G1/G2 exactly (2 failed / 23 passed of 25).

### 8b. Fix applied on the PR branch (round-4 head), standalone

```
$ cd <scratch>/h6-r4-pr/packages/core-backend
$ CI=true npx vitest run tests/unit/required-web-lane-token-manifest-guard.test.ts \
    --pool=forks --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3
 Test Files  1 passed (1)
      Tests  28 passed (28)
```
Round 4's change to that figure, by kind (r4-NIT-2 — the arithmetic prose that stood here
enumerated five items against a net-of-three delta, which read as a contradiction):

- **new**: `r4-G1` (line-number-mapping), `r4-G1 fixture sanity` (in-continuation-`#` divergence
  proof), `r4-G2` (insert-N-comments).
- **rewritten in place**: `r4-G1` (behavioural cross-copy, replacing the old P3-6 text form),
  `r2-P3-2` (behavioural, replacing its own old text form).

Full suite:
```
$ CI=true npx vitest run required-web-lane --reporter=dot
 ✓ tests/unit/required-web-lane-token-manifest-guard.test.ts (28 tests)
 ✓ tests/unit/required-web-lane-registration-shape.test.ts (18 tests)
 Test Files  2 passed (2)
      Tests  46 passed (46)
```
(was 43 in §7g; +3, matching the manifest guard's own +3 above — the shape guard's own 18 are
untouched by this round).

### 8c. Fix overlaid onto `refs/dryrun/mtv3-final`, cp-only, one-off worktree, never committed there

```
$ cp <scratch>/h6-r4-pr/packages/core-backend/tests/unit/required-web-lane-token-manifest-guard.test.ts \
     <scratch>/h6-r4-dryrun/packages/core-backend/tests/unit/required-web-lane-token-manifest-guard.test.ts
$ cp <scratch>/h6-r4-pr/scripts/ops/required-web-lane-exec-block.mjs \
     <scratch>/h6-r4-dryrun/scripts/ops/required-web-lane-exec-block.mjs
$ cd <scratch>/h6-r4-dryrun/packages/core-backend
$ CI=true npx vitest run tests/unit/required-web-lane-token-manifest-guard.test.ts \
    --pool=forks --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3
 Test Files  1 passed (1)
      Tests  28 passed (28)
```
Both G1 (now comparing #5898's ACTUAL `logicalLinesWithLineNumbers()`-backed `logicalLines()`
wrapper by behaviour, including the line-number-mapping half — the sibling exports it on this
tree, so that test's feature-detection branch is live, not skipped, here) and G2 red assertions are
green on the tree they were measured red on. The `<scratch>/h6-r4-dryrun` worktree was `git
worktree remove`d afterward without committing or pushing anything from it; `refs/dryrun/mtv3-final`
itself was never written to.

### 8d. Type-check and duplicate-commit sweep

```
$ cd <scratch>/h6-r4-pr/packages/core-backend && npx tsc --noEmit
(no output, exit 0)
```
(the package's own `tsconfig.json` excludes `**/*.test.ts`, so this is the same scope CI's `pnpm
type-check` step actually covers — it was 0 before this round too). The new test-file code itself
was additionally checked standalone with the project's own `strict: false`/ES2022/node+vitest-globals
settings (module widened to ESNext only because this file's `import.meta.url` usage requires it —
unrelated to the round-4 diff): 0 errors.
```
$ git cherry origin/main
+ 4e5e0a5fe90f4c7068da19093f5a00b2a62f9e85
+ d8e25a044b0530df148abf11c4e20ee1f5390957
+ 905aac7e7e7535fb1ffb0e0fbdc885dc2e7015aa
+ 4d196c3d3ddc9bbcc723d7689cc134513d8dcf30
+ 1e23dca923a8ccb98477d3fdb5fcf4d0a5d117c5
```
All `+` (no `-`), before and after the round-4 commit — no duplicate-of-main commits introduced.
(r4-NIT-1: the fifth entry was a literal `<round-4 commit>` placeholder inside a block presented as
command output; it is the measured SHA above. The round-5 commit is deliberately absent from this
block rather than back-filled — a transcript cannot list the commit that creates it. §r5 below
carries its own `git cherry` run.)

---

## §r5. Round 5 (2026-09-22) — round-4 gate hardening

Base: `origin/main` @ `cd42eaf7455f03dd99021a02c47c42f1f3db6484`. Round-4 head (the reviewed one):
`1e23dca923a8ccb98477d3fdb5fcf4d0a5d117c5`. Two detached worktrees under the session scratchpad,
`node_modules` symlinked from the canonical checkout at root / `apps/web` / `packages/core-backend`.
Zero databases created or reused. Command throughout (`minForks=1` for the same vitest 1.6.1
`RangeError` the earlier rounds recorded):

```
CI=true npx vitest run <file(s)> --pool=forks --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3
```

Each on-disk mutation below is `cp` backup → mutate → run → `cp` restore → `cmp`; no
`git checkout --`, `reset --hard`, or `stash` was used anywhere, and both trees ended at
`git status --porcelain` = 0 lines.

### r5.1 The fix, on the branch tree

```
$ cd <scratch>/h6r5-br/packages/core-backend
$ CI=true npx vitest run tests/unit/required-web-lane-token-manifest-guard.test.ts …
 Test Files  1 passed (1)
      Tests  29 passed (29)

$ CI=true npx vitest run tests/unit/required-web-lane-token-manifest-guard.test.ts \
    tests/unit/required-web-lane-registration-shape.test.ts …
 Test Files  2 passed (2)
      Tests  47 passed (47)

$ CI=true npx vitest run tests/unit/approval-ci-coverage-enumeration.test.ts \
    tests/unit/approval-field-access-enum-mirror.test.ts …          # environment-health control
 Test Files  2 passed (2)
      Tests  392 passed (392)
```

`apps/web/tests/run-required-web-tests-shape.spec.ts` (the third lane-shape guard the dry-run
lists) still does not exist at this head — it is #5898's file and #5898 is unmerged — so "the two
existing guards" resolves to one on this branch, the core-backend shape guard, inside the combined
run above. Recorded rather than silently counted, same as round 4.

The two CLI consumers of the edited `.mjs` were smoke-run because that file's header changed:

```
$ node scripts/ops/required-web-lane-token-manifest.mjs
active (19 gating invocations): 499 distinct tokens
committed manifest: 499 tokens, 499 distinct
MANIFEST MATCHES — the committed token set equals the active token set.

$ node scripts/ops/required-web-lane-token-set-diff.mjs origin/main HEAD
SET IDENTICAL — every filter the old invocation handed vitest is still handed to it.
```

### r5.2 r4-P2-1's own probe, run as a differential (the round-4 file vs. the round-5 file)

40 comment-only physical lines inserted after the lane script's shebang — zero tokens and zero
logical lines changed. The round-4 file was put in place with
`git show HEAD:packages/core-backend/tests/unit/required-web-lane-token-manifest-guard.test.ts`,
not by hand-editing, so the two legs differ by exactly the committed round-5 diff:

```
(A) round-5 file  ->  Test Files  1 passed (1)
                           Tests  29 passed (29)

(B) round-4 file  ->  Tests  4 failed | 24 passed (28)
    AssertionError: fixture sanity: line 1180 must still be one of the 19 gating invocations: expected undefined to be truthy
    AssertionError: the message must name the lines it scanned: expected '1 token(s) recorded in apps/web/scrip…' to contain '477'
    AssertionError: the injected token must be attributed to exactly line 690, unlike the M5 drop direction: expected [ 730 ] to deeply equal [ 690 ]
    AssertionError: line attribution must survive the reorder: expected [ 595 ] to deeply equal [ 555 ]
```

Leg (B) reproduces the round-4 gate's §3.5 measurement byte-for-byte, here on the branch tree
rather than the dry-run overlay.

**A negative assertion over line numbers carries almost no power on its own, so the derived value
is anchored instead.** `describeMissing` prints the post-mutation SCANNED lines; the deleted line's
number is absent from that list for nearly any value it could take, so `.not.toMatch(/\b<n>\b/)`
would survive a drifted `<n>` without complaint — which is how round 4's `/\b624\b/` went quietly
green. Measured: after the deletion the nearest scanned lines above it are 661 and 689, so a
collision would need the next gating invocation at exactly `deleted + 1`. The round-5 test
therefore asserts that the derived number still indexes the physical line the mutation removed
(`expect(lines[deletedPhysicalLine - 1]).toBe(victimLine)`); that is the assertion with
discriminating power, and PC-D below mutates the derivation to prove it.

**The fifth failure that is not in that list is the finding the gate's census had not reached.**
`.not.toMatch(/\b624\b/)` does not appear among leg (B)'s four reds: after the shift the deleted
line is no longer numbered 624, so the negative assertion passes without testing anything about
the line it names. A loud red is a nuisance; an assertion that quietly stops checking its subject
is the failure mode this guard exists to prevent. Round 5 derives it from the index the same test
already computes.

### r5.3 Positive controls — each derived expectation, mutated, must red

Each mutation asserts its anchor count is exactly 1 before running (an ineffective mutation looks
identical to a useless test), and each is restored and `cmp`-verified afterwards.

| # | mutation | target | result |
|---|---|---|---|
| PC-A | `stripTrailingErrorGuard(inv.text) !== inv.text` → `===` (selector picks the untailed lines) | guard test | `1 failed \| 28 passed (29)` |
| PC-B | `toBe(gatingInvocationsBefore - 1)` → `toBe(gatingInvocationsBefore)` | guard test | `1 failed \| 28 passed (29)` |
| PC-C | `toContain(String(firstScannedLine))` → `firstScannedLine + 1` | guard test | `1 failed \| 28 passed (29)` |
| PC-D | `const deletedPhysicalLine = idx + 1` → `idx + 2` | guard test | `1 failed \| 28 passed (29)`, on the anchor assertion: `the derived line number must index the exact physical line this test deletes: expected '' to be 'npx vitest run multitable-field-confi…'` |
| PC-E | M6 `idx + 1` → `idx + 2` | guard test | `1 failed \| 28 passed (29)` |
| PC-F | M7 `idx + 1` → `idx + 2` | guard test | `1 failed \| 28 passed (29)` |
| PC-G | widened `r2-P3-4` loses its `vitest run` filter | guard test | `1 failed \| 28 passed (29)` |
| MUT-1 | `startLine = lineNo` → `lineNo + 1` inside `logicalLinesWithLineNumbers()` | `required-web-lane-exec-block.mjs` | `1 failed \| 28 passed (29)`, message `[singleLineNoContinuation] the exec logical line's recorded start line disagrees with the physical index …: expected 2 to be 1` |
| MUT-E | `/^\s*#/` → `/^#/` | `required-web-lane-token-set-diff.mjs` | `2 failed \| 27 passed (29)`, both naming `[indentedCommentBeforeBlock]` — the round-4 gate measured this mutation **green** (its §3.2 MUT-E row) |

**MUT-1 against the round-4 file: `Test Files 1 passed (1)`.** The same mutation is entirely green
under round 4 and reds under round 5 — that difference is the vacuity r4-P3-1 identified, measured
rather than argued.

### r5.4 `refs/dryrun/mtv3-final` overlay (the ref itself is not written)

```
$ git rev-parse refs/dryrun/mtv3-final        # before
a93bea106f06f26e4a5e68216bc119eb2c08a599

(1) dry-run tree, its own round-3-era guard, untouched:
      Tests  2 failed | 23 passed (25)        # matches the round-4 gate's §3.1(a)

(2) the two round-5 code files cp-overlaid onto the same tree:
      Tests  29 passed (29)

(3) same overlay + MUT-C on the dry-run SIBLING (`bufStart = i + 1` → `i + 2`):
      1 red, [singleLineNoContinuation] logicalLinesWithLineNumbers() (folded result +
      line-number mapping) diverged from the shape guard's copy
      -> branch (c) of the rewritten test is LIVE on a tree where the sibling exports the wrapper:
         round 4's cross-copy coverage is widened, not traded away

(4) same overlay + the 40-line post-shebang insert:
      Tests  29 passed (29)

$ git rev-parse refs/dryrun/mtv3-final        # after the whole round
a93bea106f06f26e4a5e68216bc119eb2c08a599
```

Both overlaid files restored and `cmp`-verified; dry-run tree `git status --porcelain` = 0 lines.

### r5.5 Type-check, hardcoded-number census, commit hygiene

```
$ cd <scratch>/h6r5-br/packages/core-backend && npx tsc --noEmit -p tsconfig.json | grep -c "error TS"
0
```
Same scope caveat as round 4, unchanged and still disclosed: the package `tsconfig.json` excludes
`**/*.test.ts`, so neither CI's `pnpm type-check` nor this run type-checks the guard file itself.

Census (widened past the round-4 gate's enumeration — `grep -nE '[0-9]{3,}'` over the whole guard
file, then classifying each hit, rather than the narrow assertion-shaped grep):

| class | disposition |
|---|---|
| load-bearing physical-line expectations | the round-4 gate's prescribed grep, `grep -nE "toEqual\(\[[0-9]+\]\)\|toBe\([0-9]{3,}\)"`, returns **0 hits**; the per-site listing is design §12's table |
| line numbers in `it()` titles and fixture-sanity messages | deleted |
| each 3+-digit hit remaining in the code region (`grep -nE '[0-9]{3,}'`, lines past the class header) | each sits inside a `//` comment recording what was removed and why, except NIT-3's synthetic probe input; **zero in an assertion position** |
| `19` / `499` / `397` / `102` / `28` in class-header prose and in `.mjs` headers | census figures with their recompute commands, dated to the round that measured them; out of this round's scope and untouched |
| `37` (r4-G2's insert count), `50` / `300` (NIT-3 probe inputs) | test inputs, not expectations about the file |

`git cherry origin/main <branch head>` and the identity census over
`origin/main..<branch head>` are run AFTER the round-5 commit exists and are reported on the PR
rather than pasted here: a transcript committed inside that commit cannot list it, and back-filling
self-referential snapshots is how three of the last four rounds introduced a fresh false number
(the same reason §8d's placeholder is not being extended). Identity is set per-command with
`git -c user.name=… -c user.email=…`; no `git config` was executed in any scope this round.

### r5.6 NOT RUN (with reasons)

| item | reason |
|---|---|
| `test (20.x)` / `test (18.x)` on #5974 | not queried this round; a pending or unqueried required check is NOT RUN, not green |
| any real-DB suite | zero databases created or reused, per this round's execution discipline |
| full no-DB core-backend lane | out of scope for a hardening round; the neighbour files (392 passed) stand in as the environment-health control |
| `bash -e apps/web/scripts/run-required-web-tests.sh` | the dry-run measured it red on both the train and the pristine `origin/main` control, a main-existing red with zero H-6 content |
| `pnpm -r test` | prohibited by the execution discipline |
