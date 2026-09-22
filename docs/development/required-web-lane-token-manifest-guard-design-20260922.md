# H-6 — required web lane token-loss guard: design

- Date: 2026-09-22 (UTC+8), round 2 (scope widened) same day
- Status: PROPOSED (candidate — awaiting owner disposition)
- Slice: H-6 (CI 守卫), branch `ci/required-web-lane-token-manifest-guard`
- Base: `origin/main` @ `cd42eaf7455f03dd99021a02c47c42f1f3db6484`
- Values-free: this document and every file it describes read/write only repo-tracked script and
  test text and token names — no host, IP, or credential.

## ROUND 2 SUMMARY (2026-09-22) — P1-1 option (a), scope widened to all 19 gating lines

An independent gate review of round 1
(`/Users/chouhua/.claude/projects/-Users-chouhua-Downloads-Github-metasheet2/reviews/impl-gate-H6-token-manifest-guard-round1-20260922.md`)
returned CHANGES-REQUESTED (1 P1, 2 P2, 7 P3, 3 NIT). Round 1's guard covered only the script's
FINAL `exec npx vitest run …` line (397 tokens) — one of the required web lane's **19** logical
lines that invoke `vitest run` after `set -euo pipefail` (line 473). The other 18 carry **102**
more distinct tokens, of which round 1's census counted **28** pinned by NOTHING else in the repo
(P1-1); the review also measured that **192 of the lane's 499 total tokens are already gated
today** by four existing census/shape guards, so "currently has no automated gate" (P2-1) was true
for the exec block's majority but not universally.

**ROUND 3 correction (2026-09-22, round-2 gate review, P2-1):** the round-1/round-2 census of
"already-gated" tokens enumerated four lane-reading guards and missed a **fifth and sixth**
already-existing guard, `apps/web/tests/attendance-web-guard-workflow.spec.ts`, which reads
`run-required-web-tests.sh` directly at three sites and pins 4 of the 28 "ungated" tokens (an early
line's `sessionSpecs`) plus 3 exec-block tokens. Recomputed this round, mechanically (command and
output in §1): the residual is **≤24**, not 28; the already-gated union is **≥199**, not 192; the
exec-block total newly gated by this PR is **≤276**, not 279. These are stated as bounds, not exact
figures — see §1 for why an exact recount would require re-deriving all six guards' pin
predicates, not only the sixth's.

**Selected during implementation, not by the owner: P1-1 option (a) — widen the parser to all 19
invocations, not option (b) (rename/rescope to "exec block only" and record the residual as
OPEN)**, on the round-1 reviewer's own framing that only (a) closes the residual. No owner ruling
exists on this choice (`gh pr view 5974 --json comments,reviews` → 0 comments, 0 reviews, checked
by the round-2 gate review and re-checked this round); owner disposition is pending and option (b)
remains a fallback if the owner rules otherwise. This round:

1. Adds `allVitestInvocations` / `allVitestTokenLines` / `allVitestTokens` /
   `stripTrailingErrorGuard` to `scripts/ops/required-web-lane-exec-block.mjs`, unioning the token
   sets of all 19 gating lines — while KEEPING `execLogicalLine`'s "exactly one exec logical line"
   throw (fail-closed, retained, not replaced) and keeping `logicalLines`/`execLogicalLine`/
   `tokensOf` byte-identical to the shape guard's copy of them elsewhere in the repo (a new guard
   test asserts this — P3-6; round 3 extends it to a third copy, see §5 item 6 and §10 r2-P3-2).
2. Regenerates the manifest at **499** tokens (was 397).
3. Restates the "no automated gate" premise with the measured numbers (P2-1, this section and §1).
4. Adds a merge-sequencing section (§8, P2-2) — WIDENED relative to round 1's exec-block-only
   framing: any of the 18 additional free-form lines, not only the exec block, is now
   manifest-bearing.
5. Fixes P3-1…P3-7 and NIT-1…NIT-3 (see §9), and round 2's gate findings r2-P2-1/r2-P2-2/
   r2-P3-1…r2-P3-4/r2-NIT-1…r2-NIT-3 (see §10).

**Cost, stated plainly (per the review's own framing of option (a), not softened here):** this is
not a five-line change in effect. It makes 18 additional invocation sites manifest-bearing, and
unlike the exec block none of them is one-token-per-line, sorted, or covered by the shape guard's
structural assertions — so an edit to any of those free-form command lines now needs a
`node scripts/ops/required-web-lane-token-manifest.mjs --write`, and each one becomes a new way to
red `main` under the §8 mechanism.

## 1. Problem, restated precisely

`apps/web/scripts/run-required-web-tests.sh` has **19** logical lines matching `\bvitest\s+run\b`
after `set -euo pipefail` (line 473): 18 earlier `npx vitest run …` lines (lines 477, 501, 539,
555, 556, 557, 566, 600, 612, 624, 662, 690, 704, 730, 752, 785, 1180, 1183) plus the final
`exec npx vitest run \` logical line (line 1257) — a positional filter of **397 tokens**, one per
physical line, backslash-continued, sorted case-insensitively (Q8/C4 P1, 2026-09-21,
`docs/development/web-required-lane-multiline-registration-design-20260921.md`). All 19 lines are
run by `web-tests.yml`'s `web-tests` job — every token on every one of them is a *required* gate,
not only the final line's.

**Measured token census (round-1 gate review; the 499/397/102 split re-derived fresh in round 3 by
importing `allVitestTokens`/`execLogicalLine`/`tokensOf` from the real
`scripts/ops/required-web-lane-exec-block.mjs` module against the real lane script — see the
recompute command after the 28-token list below):**

| scope | distinct tokens |
|---|---|
| final `exec` block (line 1257) | 397 |
| the 18 earlier `npx vitest run` lines | 102 |
| **total distinct required-lane tokens (19 lines, zero overlap)** | **499** |

Two guards already exist that read this exec block for **shape**:

- `packages/core-backend/tests/unit/required-web-lane-registration-shape.test.ts` — bash parses,
  exactly one exec logical line, one token per physical line, no duplicates, case-insensitive
  sort, trailing `--reporter=dot`, `.gitattributes` pin present, second registration point alive.
- `apps/web/tests/attendance-web-guard-workflow.spec.ts` — parses the *attendance* web guard
  workflow's own targeted step the same way for shape. **ROUND 3 correction (r2-P2-1): this file
  is not only a shape guard on a sibling concern.** It ALSO reads `run-required-web-tests.sh`
  directly at three sites: `:92-97` asserts the exec logical line carries `> 300` tokens, `:103-108`
  pins three exec-block tokens by name (`attendanceEmployeeMakeupRequestCard`,
  `attendanceEmployeeLeaveRequestCard`, `attendance-selfservice-dashboard`), and `:173-176` pins
  four early-line tokens by name (`tests/useAuth.spec.ts`, `tests/useSessionOrg.spec.ts`,
  `tests/AttendanceSessionOrgSwitcher.spec.ts`, `tests/useAttendanceSessionGuard.spec.ts`, all four
  on line 477 via the `sessionSpecs` array). Round 1's and round 2's own census missed these three
  read sites and mischaracterised the file as a "sibling concern, not this block" — see §1's
  corrected census below.

Neither asserts anything about **which tokens are in the set**, and neither reads the 18 earlier
lines at all. Delete one token from the middle of an otherwise well-formed, sorted, duplicate-free
exec block — every shape assertion above still passes; the file is exactly as shaped, one filter
shorter. This is not hypothetical: the independent adversarial verification
(`/Users/chouhua/.claude/projects/-Users-chouhua-Downloads-Github-metasheet2/reviews/verify-exec-block-incident-fixes-20260921.md`,
§3, P2-2) measured it directly — 357 test cases across the three census/shape guards that read
this file, run three ways (baseline / a main token deleted / a lane token deleted): **357 passed
in every one of the three runs**.

**Restated with the round-1 gate review's measured numbers (P2-1 correction — round 1 overclaimed
"no automated gate" universally, ROUND 3 note: this four-guard enumeration was itself incomplete,
see below):** four existing lane-reading guards (`approval-ci-coverage-enumeration.test.ts`,
`stock-prep-web-ci-coverage-enumeration.test.ts`, `elearning-media-ci-wiring.test.mjs`,
`network-unavailable-copy-ci-wiring.test.ts`) already gate, between them, **192 of the lane's 499
tokens today** (118 in the exec block, 74 among the 18 earlier lines) — by asserting things like
"every non-allowlisted `approval*.spec.ts` file has a matching lane token", not by reading this
script directly. Of the remaining 307 tokens (499 − 192), **279** are in the exec block (before
this PR's widening) and **28** are among the 18 earlier lines, both counted (round 1/round 2) as
pinned by NOTHING at all:

```
accountIdentityDisplay  attendance-admin-regressions  attendance-date-only-format
attendance-experience-entrypoints  attendance-import-preview-regression.spec.ts
attendance-records-route-redirect  featureFlags.plm.spec.ts  fwb-rule-authoring
fwb-rule-authoring-helpers  middleEllipsis  multitable-field-config-panel
multitable-recovery-archive-client  multitable-recovery-archive-modal
my-apps-landing-view  permission-match-parity  platform-app-entry-mismatch-inventory
platform-app-launcher  platform-app-shell  searchApprovalDirectoryDepartments
tests/AttendanceReportFieldsSection.spec.ts  tests/AttendanceSessionOrgSwitcher.spec.ts
tests/attendance-rules-me-contract-sync.spec.ts  tests/delete-fallback.spec.ts
tests/useAttendanceSessionGuard.spec.ts  tests/useAuth.spec.ts  tests/useSessionOrg.spec.ts
useAttendanceAdminImportWorkflow.spec.ts  useAttendanceAdminRailNavigation
```

**ROUND 3 correction (r2-P2-1) — this enumeration missed a fifth/sixth guard.**
`apps/web/tests/attendance-web-guard-workflow.spec.ts` (see the corrected bullet above) also pins 4
of the 28 tokens above (`tests/useAuth.spec.ts`, `tests/useSessionOrg.spec.ts`,
`tests/AttendanceSessionOrgSwitcher.spec.ts`, `tests/useAttendanceSessionGuard.spec.ts`, all
confirmed on early line 477) and 3 of the 279 exec-block tokens
(`attendanceEmployeeMakeupRequestCard`, `attendanceEmployeeLeaveRequestCard`,
`attendance-selfservice-dashboard`) — none of the 7 is named or scoped by any of the four census
guards above (`git grep -l -F <token> origin/main -- <the four census guard files>` → 0 files for
each of the 3 exec tokens; the 4 early tokens are the literal `sessionSpecs` array entries).
Recomputed mechanically, this round, by importing the real parser and extracting the two guards'
own source rather than retyping any count:

```
$ env -u FORCE_COLOR NO_COLOR=1 node -e '
  import("./scripts/ops/required-web-lane-exec-block.mjs").then(async (m) => {
    const fs = await import("node:fs")
    const laneSrc = fs.readFileSync("apps/web/scripts/run-required-web-tests.sh", "utf8")
    const total = m.allVitestTokens(laneSrc)
    const execSet = new Set(m.tokensOf(m.execLogicalLine(laneSrc)))
    console.log("total", total.size, "exec", execSet.size, "earlierOnly", total.size - execSet.size)
  })'
total 499 exec 397 earlierOnly 102

$ env -u FORCE_COLOR NO_COLOR=1 node -e '
  const fs = require("node:fs")
  const sixth = fs.readFileSync("apps/web/tests/attendance-web-guard-workflow.spec.ts", "utf8")
  const early = [...sixth.match(/const sessionSpecs = \[([^\]]*)\]/)[1].matchAll(/'"'"'([^'"'"']+)'"'"'/g)].map(x => `tests/${x[1]}.spec.ts`)
  const exec = [...sixth.match(/for \(const spec of \[([^\]]*)\]\) \{\n\s*expect\(requiredCommand/)[1].matchAll(/'"'"'([^'"'"']+)'"'"'/g)].map(x => x[1])
  console.log("early", JSON.stringify(early)); console.log("exec", JSON.stringify(exec))'
early ["tests/useAuth.spec.ts","tests/useSessionOrg.spec.ts","tests/AttendanceSessionOrgSwitcher.spec.ts","tests/useAttendanceSessionGuard.spec.ts"]
exec ["attendanceEmployeeMakeupRequestCard","attendanceEmployeeLeaveRequestCard","attendance-selfservice-dashboard"]

$ for tok in attendanceEmployeeMakeupRequestCard attendanceEmployeeLeaveRequestCard attendance-selfservice-dashboard; do
    git grep -l -F "$tok" origin/main -- packages/core-backend/tests/unit/approval-ci-coverage-enumeration.test.ts packages/core-backend/tests/unit/stock-prep-web-ci-coverage-enumeration.test.ts scripts/ops/elearning-media-ci-wiring.test.mjs packages/core-backend/tests/unit/network-unavailable-copy-ci-wiring.test.ts || echo "$tok: 0 files"
  done
attendanceEmployeeMakeupRequestCard: 0 files
attendanceEmployeeLeaveRequestCard: 0 files
attendance-selfservice-dashboard: 0 files
```

Arithmetic on these measured/extracted inputs (not a fresh hand-typed guess): residual `28 − 4 =
**24**`; already-gated union `192 + 4 + 3 = **199**`; exec-block newly-gated-by-this-PR
`279 − 3 = **276**`. **Stated as bounds — `≤24` / `≥199` / `≤276` — not exact figures**, because the
192/279/28 inputs are themselves a four-guard enumeration that this round did not re-derive from
scratch (that would require re-running all four guards' own file-population predicates, not only
confirming the sixth guard's 7 tokens); a seventh guard could exist that this round also did not
look for. A token silently dropped from one of the ≤24 that remain — by a bad rebase, a manual
edit, or a "cleanup" that removes the wrong line — had, and (before this PR's widening) still has,
**no automated gate at all** among the six lane-reading guards enumerated so far. That is the
precise, measured version of the premise; "no automated gate" is true for this ≤24-token residual
and for the ≤276-token exec-block remainder, not for all 499 tokens uniformly.

`scripts/ops/required-web-lane-token-set-diff.mjs` already computes exactly the SET comparison
needed to catch this, but only as a script a human (or a merge-conflict-resolution agent) is
expected to remember to run against `origin/main` — it is not wired into any workflow.

## 2. Two options

### Option B — CI step diffing against `origin/main`/merge-base

Run `required-web-lane-token-set-diff.mjs` in CI, comparing the PR head against `origin/main` or
the merge-base.

**Rejected — verified against this repo's actual CI wiring, not assumed:**

- Every `checkout` step in `.github/workflows/plugin-tests.yml` (the workflow that produces the
  `test` job, whose `test (20.x)` leg is the required check — `test (18.x)` runs the identical step
  but is not itself a required context, see P3-3 below) is bare `uses: actions/checkout@v4`
  with **no** `fetch-depth:` override (checked: `grep -c "actions/checkout@v4"
  .github/workflows/plugin-tests.yml` = **6** — round-1 gate review's NIT-1 correction: round 1
  said 7, counting a prose line (815) that merely mentions the string, not an actual checkout
  step; `grep -n fetch-depth .github/workflows/plugin-tests.yml` is still zero hits across all 6
  real checkout steps, including the `test` job's). `actions/checkout@v4`'s default is
  `fetch-depth: 1` — a single commit, no `origin/main` ref materialised in the runner's `.git` at
  all.
- `plugin-tests.yml`'s `pull_request` trigger has **no `paths:` filter** (only its `push` trigger
  does) — so it always runs on a PR event, where GitHub Actions *does* set `github.base_ref`/
  `github.event.pull_request.base.sha`. But `web-tests.yml` (the workflow that actually EXECUTES
  the pinned token filter) is triggered on `push` too, and a `push` event carries **no base ref at
  all** — there is nothing to diff against. A guard that only fires on `pull_request` would leave
  every direct-to-`main` push (merge-queue merges, admin merges, `merge_group`) unguarded — exactly
  the events most likely to be a rebase/merge artifact.
- This is the same lesson the 2026-09-21 design doc already recorded for a related concern
  (§2.2's `.gitattributes` `merge=union` note: "GitHub 服务端合并是否读取仓库 merge driver
  **未经证实**") — anything depending on git history or a specific event shape in this workflow
  file is standing on ground this repo has not measured, and here it's actively contradicted by
  the checkout `fetch-depth` census above.
- Fixable in principle (`fetch-depth: 0` on that one checkout, `git fetch origin main` as a step),
  but that couples the guard's correctness to a workflow-YAML detail three other people are also
  editing, and open-codes a footgun: a future edit that adds a *different* checkout step to the
  same job (there already are two `actions/checkout@v4` calls total across the two jobs that touch
  this file) can silently regress the fetch depth with no test noticing until the guard goes dark
  on a `push` event.

### Option A — a committed token-SET manifest (chosen), scope WIDENED in round 2 (P1-1 option (a))

Commit `apps/web/scripts/run-required-web-tests.tokens`: one token per line (plus a `#`-prefixed
provenance header — round 2, P3-5), sorted, generated by
`node scripts/ops/required-web-lane-token-manifest.mjs --write`. A guard test
(`packages/core-backend/tests/unit/required-web-lane-token-manifest-guard.test.ts`, same directory
as the shape guard, same always-on required lane) asserts **set equality** between the manifest and
the **union of all 19 gating invocations'** token sets (round 1 covered only the final exec line —
see the ROUND 2 SUMMARY and §1's census above), reporting the missing/extra difference on failure.
No git history, no merge-base, no event-shape dependency — it compares two texts that are both
present in every checkout, shallow or not, `push` or `pull_request`.

**Cost, stated plainly (this is the real trade, not a footnote — WIDENED in round 2, not softened):**
every PR that adds a token to ANY of the 19 gating lines must, in the **same PR**, run `--write`
and commit the updated manifest — otherwise this guard reds that PR (by design: an active-only
token is exactly the "extra" case). For the exec block specifically, this is a **second file to
keep in sync with the same rebase conflict** the Q8 multi-line rewrite already tries to make rare;
it does not make that conflict worse in kind, since the exec block is itself one-token-per-line and
`merge=union`-tagged. For the **18 earlier lines**, the trade is materially different and worse:
none of them is one-token-per-line, none is sorted, and none is covered by the shape guard's
structural assertions — they are free-form `npx vitest run a b c --reporter=dot`-shaped commands.
An edit to any positional argument on any of those 18 lines is now manifest-bearing, with no shape
guard to keep the resulting diff well-formed the way the exec block's is. See §8 for the
consequence this has for the four in-flight PRs already touching this file.

## 3. How the guard is attacked (adversarial self-check)

Per the standing instruction to attack a "nothing was silently dropped"-shaped judgment: **can the
manifest itself be deleted alongside the token it should have caught, in the same PR, defeating the
guard by construction rather than by oversight?**

Yes. If a PR removes a token from any of the 19 gating lines (round 2: not only the exec block —
reproduced again post-widening on an EARLY line, see mutation A1 in the verification doc) **and**
removes the matching line from `run-required-web-tests.tokens` in the same commit, the two sets
stay equal and this guard stays green — it would have to, since by the mutation self-proof below
(M1/M5) the guard's only lever is set inequality, and a coordinated edit keeps the sets equal by
construction. **This is recorded here as an OPEN item, not closed by this PR.** The guard's actual
safety property is narrower than "a token cannot be silently dropped" — it is **"a token cannot be
dropped from any of the 19 gating lines without also touching a second, named file in the same PR,
and that second file's diff is then visible to whoever reviews the PR."** That converts a silent,
invisible drop into a reviewable one; it does
not convert an inattentive reviewer into an effective one. The mechanism that would close this
(e.g., an independent, out-of-repo record of the token set — a CI-computed hash pinned as a
required status outside the PR author's own commits, or an owner-only branch-protection rule
requiring a second approval specifically on this file) is out of scope for a CI-guard slice and is
left for owner disposition. Recording this in the design doc rather than silently treating "review
would catch it" as a mechanism follows the standing rule that a judgment's own criterion must be
attacked before it is trusted.

## 4. Reuse decision for the parsing logic

The task asks for the generator to "read the SAME logical-line parsing as the shape test — do not
write a third copy; if a copy is unavoidable, say why." Two existing copies of this parser were
checked for direct reuse and both are infeasible to import from:

- `scripts/ops/required-web-lane-token-set-diff.mjs` — plain ESM, but its `logicalLines`/
  `execLogicalLine`/`tokensOf` are **not exported**, and the module's top level ends in
  `process.exit(main(process.argv.slice(2)))`. Importing this module from anywhere — the
  generator, a vitest worker — runs `main()` and calls `process.exit` as a side effect of the
  `import` statement itself; for a vitest worker process that kills the worker outright. Not
  importable as-is without editing the file to remove its CLI's top-level side effect, which this
  task's constraints (leave existing guards' bytes alone; do not prove an edit to an existing guard
  didn't regress it) argue against doing as a drive-by inside this slice.
- `packages/core-backend/tests/unit/required-web-lane-registration-shape.test.ts` — exports
  `logicalLines` and `execLogicalLine` (not `tokensOf`), but the module's top level also calls
  `describe(...)` four times, registering that file's 18 tests. A second `import` of this module
  from another vitest test file re-registers those 18 tests under vitest's collection a second
  time — silently doubling a suite whose sibling guards elsewhere in this repo byte-pin subtest
  counts (see `plugin-tests.yml`'s `MIN_CONTRACT_TESTS` floor pattern) specifically because an
  import-time side effect collapsing or duplicating a test count has bitten this repo before.

So: `scripts/ops/required-web-lane-exec-block.mjs` is a **new, third, minimal** text of the three
functions (no CLI, no top-level side effects, nothing else) — and it is the last one. Both existing
copies are left byte-identical. The generator (`required-web-lane-token-manifest.mjs`, plain
`node`, no TypeScript toolchain) imports it directly; the new guard test (`.ts`, run under
vitest/esbuild) also imports it directly. Every future consumer of this parser should import from
this module rather than adding a fourth copy.

**Round 2 addendum — widening without touching the three copies.** The scope widening needed here
(reading 18 more lines, and not choking on the `|| exit $?` tail two of them carry) is added as
NEW exports in the same module — `stripTrailingErrorGuard`, `allVitestInvocations`,
`allVitestTokenLines`, `allVitestTokens` — rather than by editing `logicalLines`/`execLogicalLine`/
`tokensOf` themselves. Those three stay byte-identical to **the shape guard's copy** on purpose: a
guard test (`required-web-lane-token-manifest-guard.test.ts`, "cross-copy agreement", P3-6 below)
extracts the shape guard's own copy from its source text, normalizes away the only documented
differences (the `export` keyword, TypeScript type annotations, and comments), and asserts textual
equality against this module's copies — a check that is strictly *stronger* than a behavioural
one, since it holds for every input, not only the ones both guards happen to exercise today.
**ROUND 3 correction (r2-P3-2): a THIRD copy of this parser exists**
(`scripts/ops/required-web-lane-token-set-diff.mjs`) and was not previously checked by this
cross-copy test. `logicalLines`/`tokensOf` there are byte-identical to this module's copies too;
`execLogicalLine` there is NOT — it takes an extra `label` parameter and prefixes its throw message
with `${label}: `, a documented, deliberate divergence (that script must report which revision
failed to parse). §5 item 6 below extends the cross-copy test to cover this third copy: full
identity for `logicalLines`/`tokensOf`, and an explicit assertion that `execLogicalLine`'s only
divergence from the third copy is that parameter and prefix (so an UNDOCUMENTED further divergence
still reds). `allVitestInvocations` still calls `execLogicalLine` first and lets its "exactly one
exec logical line" throw propagate — the fail-closed property from round 1 is retained, not
relaxed.

The `|| exit $?` tail on lines 1180/1183 (a belt-and-suspenders error-propagation idiom;
`set -euo pipefail` already covers it) would otherwise tokenize as three bogus "tokens" — `||`,
`exit`, `$?` — under the unmodified `tokensOf`. `stripTrailingErrorGuard` strips exactly that
trailing idiom (anchored at end-of-string) before tokenizing; it is applied only at the
`allVitestInvocations`-family call sites, never inside `tokensOf` itself, precisely so `tokensOf`
stays byte-identical to the other two copies (all three, per the round-3 correction above — this
one has no divergence in `tokensOf`). Verified: without the strip, the raw union has 502
distinct entries (499 real tokens + `||`/`exit`/`$?`); with it, exactly 499 — matching the round-1
gate review's independently-derived count.

## 5. What the guard actually asserts

`required-web-lane-token-manifest-guard.test.ts` (round 2 numbering — see §9 for the P3/NIT
disposition of each round-1 finding):

1. **Sanity** — the active token collection (union of all 19 gating invocations) and the manifest
   are each greater than HALF the other's size (round 2, NIT-3: a floor DERIVED from the other
   side's measured count, not a hardcoded `> 300` — a legitimate synchronized shrink of the lane
   does not spuriously red this, but the degenerate "both collapse to empty" case still does;
   proven by a dedicated probe test, not merely asserted).
2. **Manifest hygiene** — no duplicate TOKEN lines (header/comment lines are excluded from the
   count first — round 2, P3-5; a duplicate is not a safety gap by itself — set semantics absorb
   it — but is dead weight worth flagging, and it DOES hard-fail this specific assertion, corrected
   language per P3-4 / §9).
3. **`missingFromActive` (manifest ⊅ active) is empty** — a token recorded in the manifest that is
   produced by NO gating invocation: **silently dropped from the required web lane.** The failure
   message names the SCANNED line numbers, not the token's former line — round 2 acknowledges this
   is the honest limit of what a script-and-manifest-only guard can localize for a deletion (see
   §8's mutation table, M5).
4. **`extraInActive` (active ⊅ manifest) is empty** — a token produced by a gating invocation but
   not yet recorded in the manifest: **added without updating the record.** The failure message DOES
   name the exact source line(s), since that information is available for a token that still
   exists in the active text (§8's M6 proves this).
5. **`.gitattributes` pins the manifest** the same way it pins the script (`text eol=lf
   merge=union`).
6. **Cross-copy agreement (round 2, P3-6; extended round 3, r2-P3-2)** —
   `logicalLines`/`execLogicalLine`/`tokensOf`'s normalized source text (stripping `export`/TS
   types/comments) is asserted equal, character for character, to the shape guard's own copy of the
   same three functions, extracted from its file text without executing it (importing that file
   would re-register its 18 `describe()`-registered tests — see §4). Round 3 adds a second
   comparison against `required-web-lane-token-set-diff.mjs`'s copy (also extracted from source
   text, not imported — importing it runs its top-level `process.exit`, see §4): `logicalLines` and
   `tokensOf` are asserted fully identical; `execLogicalLine` is asserted identical ONLY after
   removing that copy's documented `label` parameter and its `${label}: ` message prefix, so an
   undocumented further divergence still reds.

Both direction assertions (3, 4) are separate `it()` blocks specifically so a mutation of one
direction cannot hide behind, or be conflated with, the other — see §8.

This is a **set** assertion (`Set` membership checks over parsed token arrays), not a text/regex
match — the class of guard the standing "source-text assertions are not behaviour" and "count
guards conflate sources" feedback both warn against building instead.

## 6. CI wiring — how this actually lands in the required lane

- `required-web-lane-token-manifest-guard.test.ts` is placed in
  `packages/core-backend/tests/unit/`, the exact directory the shape guard was added to one day
  earlier, and is picked up by the identical mechanism: `plugin-tests.yml`'s `test` job (matrix
  `[18.x, 20.x]`, so it runs as both `test (18.x)` and `test (20.x)`) has a step named
  **"Run core-backend tests"** (`pnpm --filter @metasheet/core-backend test`, `packages/core-
  backend/package.json`'s `"test": "vitest"`), which collects every `*.test.ts` under
  `packages/core-backend/vitest.config.ts`'s **default include glob** (that config defines only an
  `exclude:` array; it overrides no `include:` — checked by reading the file) minus the explicit
  exclusion list. This file's name is not in that list. **Correction (round 2, P3-3): only
  `test (20.x)` is a required branch-protection context** (`gh api
  repos/zensgit/metasheet2/branches/main/protection`'s `required_status_checks.contexts` does not
  list `test (18.x)`) — the job runs on both legs identically, but only the 20.x leg gates.
  `test (18.x)` going green is still useful non-required real-CI evidence (it proves collection
  under the real config on a second Node major), it is just not itself the required gate.
- **Independently confirmed, not just inferred from precedent**: `npx vitest run
  required-web-lane --reporter=verbose` (run from `packages/core-backend`) is a *substring* filter
  that vitest applies to the file list it has already globbed under the real config — not a literal
  path handed straight to a loader (that would only prove a targeted run passes, not that anything
  collects the file, per the standing "triggered ≠ verified" rule). That command collects **both**
  this file and `required-web-lane-registration-shape.test.ts` from the same default-config glob. This is
  the proof the task asked for in place of trusting "no wiring needed, same as the shape test."
  **ROUND 5 (r4-P2-2)**: the before/after test COUNT that stood here is deleted rather than
  re-measured. It went stale in three consecutive rounds — round 1 wrote "27→28", round 2 "18→39",
  rounds 3/4 "18→43", each figure carried forward by the round that invalidated it — and round 4
  shipped a companion clause in the guard file asserting the figure came straight from the
  command's own output while in fact carrying it over by hand. The collection claim above is the
  part the wiring argument rests on, it is re-checkable by running the printed command, and it does
  not decay when a later round adds assertions. The measured counts stay in the verification
  document's dated transcript sections (§4b, §8b, §r5), where they are historical by construction.
- `web-tests.yml` (the job that actually **executes** the pinned tokens against vitest) is a
  separate, always-on job (`web-tests`, no path filter) — this guard does not run there and does
  not need to; it runs in the job that gates the manifest file's correctness, not the job that
  consumes it.
- The `test` job's `pull_request` trigger has no path filter (confirmed above), so this guard runs
  on every PR regardless of which files it touches.

## 7. Explicitly not done in this PR

- No change to any of the 19 gating lines' token SET (`node
  scripts/ops/required-web-lane-token-set-diff.mjs origin/main` against this branch — this script
  reads only the exec block, unchanged since round 1: `SET IDENTICAL`, 397/397 both sides. The 18
  earlier lines are likewise untouched — confirmed by re-diffing the whole `.sh` file against
  `origin/main`, byte-identical).
- No edit to `required-web-lane-registration-shape.test.ts`,
  `required-web-lane-token-set-diff.mjs`, or `attendance-web-guard-workflow.spec.ts` — all three
  are left byte-identical to `origin/main` (checked by re-running each after this branch's changes
  and diffing against the fetched `origin/main` blobs; re-confirmed after the round-2 changes).
- No branch-protection / required-context change, no DDL, no merge, no undraft. This is a
  candidate PR awaiting owner disposition of §3's OPEN item (round 2: now spanning all 19 lines,
  not only the exec block) and, separately, of §8's merge sequencing relative to the four in-flight
  PRs noted in the PR body (A-2/A-4/A-5/B-2).

## 8. Mutation plan (round 2: re-run and expanded) and merge sequencing (P2-2)

### 8a. Mutation plan (NIT-1: renumbered from round 2's "9a" — this subsection is under §8, not §9)

Executed against the real files with cp/restore/cmp — see the companion verification document for
the actual transcripts (all restores `cmp`-verified):

| # | Mutation | Scope | Expected | Assertion that fires |
|---|---|---|---|---|
| M1 | Delete one token's physical line from the **exec block** | round 1, unchanged | RED, listing the token as missing | "every manifest token is still produced by at least one gating invocation" |
| M2 | Add one token line to the **exec block**, not present in the manifest | round 1, unchanged | RED, listing the token as extra, attributed to line 1257 (the exec block's single logical-line start) | "extra in active" |
| M3 | Delete one line from the **manifest** (token still active) | round 1, unchanged | RED, listing the token as extra | same assertion as M2 |
| M4 | Reorder the **manifest file** (no add/remove) | round 1, unchanged | GREEN — unchanged | none (proves set, not sequence, semantics) |
| **M5** | Delete an ENTIRE EARLY LINE (`multitable-field-config-panel`, physical line 624) | **round 2 — the P1-1 option (a) discriminating case** | **RED**, naming the token; message lists the 18 remaining scanned line numbers, honestly NOT claiming to know the token's former line (624 no longer exists post-mutation) | "missing from active" — invisible under option (b), since that token would never have been in the exec-block-only manifest to notice |
| **M6** | Append a new token to an EARLY line (line 690, `permission-match-parity platform-app-shell platform-app-launcher` → `+ zzz…probe`) | **round 2 — line-attribution case** | **RED**, message names the token AND `@line(s) 690` exactly | "extra in active" |
| **M7** | Reorder the two tokens WITHIN one early line (555) | **round 2** | GREEN — unchanged; line attribution for both tokens still resolves to 555 | none (proves set/line-membership, not sequence) |
| A1 | Coordinated delete: same token removed from BOTH an early line (624) AND the manifest, same commit | round 1's §3 attack, **re-run post-widening** | GREEN (bypass reproduces on the widened surface too — §3's OPEN item is not closed by this PR, and now spans all 19 lines) | none fires — this is the point |
| A2 | Duplicate one manifest TOKEN line (set unchanged) | round 1, unchanged | RED, `expected 499 to be 500` | "no duplicate TOKEN lines" (P3-4: prose fixed, assertion intentionally still hard-fails) |
| A3 | Prepend an arbitrary `#` comment line to the manifest | **round 2 fix verification (P3-5)** | **GREEN** — no longer misread as a dropped-token message (round 1 reproduced this as a false-positive RED; round 2's `#`-strip in both readers fixes it) | none — the fix is that nothing fires |

The guard test file also carries its own **in-memory** (string-level) mutation self-proof section
covering M1–M7 plus two NIT-3 probes (the derived floor actually reds on the degenerate
both-empty case, and does NOT spuriously red on a legitimate synchronized shrink), so a regression
in the diff or floor logic itself reds independently of whether anyone re-runs the on-disk drill.

### 8b. Merge sequencing (P2-2, WIDENED beyond round 1's exec-block-only framing; NIT-1: renumbered from "9b")

`gh api repos/zensgit/metasheet2/branches/main/protection` reports
`required_status_checks.strict: false` — a PR is **not** required to be up to date with `main`
before merging, and `plugin-tests.yml`'s `pull_request` trigger has no path filter (it always runs
the `test` job) but against `refs/pull/N/merge` as of that PR's LAST workflow run, not necessarily
current.

**Consequence, stated plainly:** if any in-flight PR (task's short codes A-2 / A-4 / A-5 / B-2, all
touching this same script per the 2026-09-21 verification cited in the PR body) merges after this
PR without re-running `test (20.x)`, and that PR's last-run check ref predates this PR's manifest,
`main` acquires a token set the manifest does not cover — and **`test (20.x)` on `main` goes RED
for everyone**, not merely for that one PR, until someone runs `--write` and pushes a follow-up.
Round 2 widens this blast radius relative to round 1: under round 1's exec-block-only guard, only a
PR touching the FINAL exec line could trigger this. Under round 2 (option (a)), a PR touching ANY
of the 18 earlier lines — free-form command lines with no shape guard of their own — can trigger it
too. `strict: false` means no PR check has to be individually red for the break to land on `main`.

**Sequencing options — owner call, neither chosen here (NIT-2: previously headed "Chosen
sequencing" while presenting two un-chosen alternatives; stated here so it is not left to be
inferred from a Coordination paragraph):** merge this PR in one of two ways:

1. **After** A-2 / A-4 / A-5 / B-2 have all landed on `main` — at that point this PR should be
   rebased, the manifest regenerated once more (`--write`), and only then merged; or
2. **Before** them, provided each of the four is re-run through `test (20.x)` (a fresh push, or a
   maintainer-triggered re-run against a ref no older than this PR's merge) before it lands, so
   none of them can merge carrying an ungoverned token drift into `main`.

Whichever is chosen, note the guard's own failure message already prints the exact remediation
command (`node scripts/ops/required-web-lane-token-manifest.mjs --write`), which keeps the recovery
cheap once someone notices — the risk this section addresses is the blast radius and the fact that
`strict: false` means nobody is forced to notice before merging.

## 9. Disposition of round-1 gate review findings (P3/NIT), all addressed in round 2

| Finding | Fix |
|---|---|
| P3-1 (tsc vacuous for the new file) | Verification §4c wording corrected — exit 0 is confirmed NOT to type-check the new file (`--listFiles` still shows 0 hits); no gate exists for this file's TS today, stated plainly rather than implied as coverage. |
| P3-2 ("27→28", should be 18→28) | §6 above corrected to the actual 18→39 at the time (round 2 added more assertions than round 1's 10) — superseded again by round 3's 18→43, see §10 r2-P3-1. |
| P3-3 (`test (18.x)` treated as required) | §6 above, this doc's other mentions, and the guard test header all corrected to "only `test (20.x)` is required". |
| P3-4 (`.gitattributes` "harmless/absorbed" contradicts the hard assertion) | `.gitattributes` prose corrected; the hard `no duplicate lines` assertion is UNCHANGED (kept, per the review's own "fix the prose … not both"). |
| P3-5 (manifest has no `#` support / provenance) | Both readers (generator, guard test) strip `#`-prefixed lines; `--write` now emits a provenance header. |
| P3-6 (no cross-copy agreement assertion) | New "cross-copy agreement" test, §5 item 6 above. |
| P3-7 (no status marker on either doc) | `Status: PROPOSED (candidate — awaiting owner disposition)` added to this doc's header and the verification doc's header. |
| NIT-1 ("7 checkout steps", actually 6) | §2 corrected. |
| NIT-2 (`manifist` typo) | Guard test header corrected to `manifest`. |
| NIT-3 (hardcoded `> 300` floor) | Replaced with a floor derived from the other collection's size (§5 item 1), with a dedicated probe proving it still reds on the degenerate case. |

## 10. Disposition of round-2 gate review findings (`r2-` prefix; this round's own numbering, distinct from round-1's P3-n/NIT-n above, which round 2 already closed)

Independent gate review of round 2:
`/Users/chouhua/.claude/projects/-Users-chouhua-Downloads-Github-metasheet2/reviews/impl-gate-H6-token-manifest-guard-round2-20260922.md`
(VERDICT: APPROVE-with-hardening, 0 P1, 2 P2, 4 P3, 3 NIT).

| Finding | Fix |
|---|---|
| r2-P2-1 (sixth lane-reading guard missed; 28/192/279 wrong in 5 sites + PR body) | §1 above corrected with the recompute command/output; the "Two guards already exist" bullet rewritten to name the three read sites instead of "a sibling concern, not this block"; numbers restated as bounds `≤24`/`≥199`/`≤276` in this doc, the verification doc, the guard test header, both `.mjs` headers, and the PR body. |
| r2-P2-2 (an authorship phrase pairing "owner" with the verb for making this pick was asserted with no citable source, contradicting the PR body's own line 1) | Every site using that phrase (this doc, the verification doc, both `.mjs` headers, the guard test header, PR body line 8) reworded to state plainly that option (a) was picked during implementation, not by the owner, and to cite the actual check (`gh pr view 5974 --json comments,reviews` → 0 comments, 0 reviews) rather than asserting a ruling. A case-insensitive sweep for that phrase and its close variants, run over every file this PR touches plus the new PR body, returns 0 hits (see PR body / verification doc §7 for the exact command and output — deliberately not quoted verbatim in this row, so this row itself does not reintroduce a hit). |
| r2-P3-1 (guard test header's own "18 -> 28 tests" stale, re-broken from round 1's already-fixed P3-2) | Header corrected to cite the exact `npx vitest run required-web-lane --reporter=verbose` count measured AFTER this round's own new assertions were added (see verification doc §4b for the exact transcript and number — measured last, not before the round's edits). |
| r2-P3-2 (cross-copy agreement covered only 1 of 2 sibling copies; `execLogicalLine` genuinely diverges from the third copy) | Extended to also read `required-web-lane-token-set-diff.mjs`: `logicalLines`/`tokensOf` asserted fully identical across all three copies; `execLogicalLine` asserted identical to the third copy only after stripping its documented `label` parameter and message prefix (§5 item 6, §4 round-3 addendum). The three "byte-identical to the other two copies" summary sentences (test header, `exec-block.mjs`, this doc) now say "the shape guard's copy" and name the third copy's documented divergence. |
| r2-P3-3 (no positive control for the "exactly 1 exec logical line" throw) | New test: `expect(() => allVitestInvocations(twoExecSrc)).toThrow(/found 2/)` against an in-memory copy with a second `exec npx vitest run …` line appended — see the guard test's mutation self-proof section. |
| r2-P3-4 (`allVitestInvocations`'s fourth copy of the comment-strip/fold loop has no agreement assertion, an unenforced promise) | New test asserts `allVitestInvocations(src).map(l => l.text)` equals `logicalLines(src).filter(l => /\bvitest\s+run\b/.test(l))` on the real lane script, so a future divergence between the two loops reds instead of relying on the header's prose promise. |
| r2-NIT-1 (design doc §8 contained `### 9a`/`### 9b`, numbering collided with the separate `## 9`; `:126` cross-referenced "NIT-3/P3-3" where only P3-3 was meant) | Renumbered to `### 8a`/`### 8b`; the stray "NIT-3/" cross-reference removed. |
| r2-NIT-2 (§8b headed "Chosen sequencing" while presenting two un-chosen alternatives) | Heading reworded to "Sequencing options — owner call, neither chosen here". |
| r2-NIT-3 (manifest sortedness not asserted, unlike the exec block's sibling assertion) | New test asserts the committed manifest's token lines are case-insensitively sorted, matching the shape guard's equivalent assertion on the exec block. |

Real CI at the round-2-reviewed head (`905aac7e7e7535fb1ffb0e0fbdc885dc2e7015aa`) was NOT run by that
review; `test (20.x)` must be re-checked at the round-3 head before any merge decision (round-2
gate review §4, merge condition 4 — unchanged by this round).

## 11. Round 4 (2026-09-22) — G1/G2 from the merge-train dry-run v3 gate

Source: `/Users/chouhua/.claude/projects/-Users-chouhua-Downloads-Github-metasheet2/reviews/merge-train-dry-run-v3-20260922.md`
§2 gate 2 (no-DB lane) and §4 (findings table). The dry-run merged this PR's round-3 head
(`4d196c3d3`) together with 17 other lanes, including the still-OPEN, unmerged
`test/web-required-script-shape-guard` (#5898, head `22922402d`), onto merge point `a93bea106`
(kept at `refs/dryrun/mtv3-final`) and ran this guard there under the required lane's real
`vitest` invocation. Two of its own assertions — and only its own — turned red, on NEITHER lane
alone: `#5898` alone is green (it does not touch this file's exec-block copy at all — the file
did not exist on `main` when #5898 was authored); this PR alone is green (verified every round).

### G1 — root cause

`required-web-lane-token-manifest-guard.test.ts`'s "cross-copy agreement" test (P3-6/r2-P3-2)
diffed `logicalLines`/`execLogicalLine`/`tokensOf`'s NORMALIZED SOURCE TEXT against
`required-web-lane-registration-shape.test.ts`'s own copy — a check round 1 justified as
"strictly STRONGER than a behavioural one" (§4 round-1 note, superseded by this section). #5898
refactors that sibling file's `logicalLines()` into a one-line wrapper —
`return logicalLinesWithLineNumbers(scriptSrc).map(e => e.line)` — around a NEW
`logicalLinesWithLineNumbers()` helper, itself also fixing an unrelated bash-comment-folding-order
bug (#5898's own P2-2 note) that this PR's copy does not have and is not fixing here (see the
excluded fixture below). Same folded OUTPUT on every practical input; zero bytes of source in
common with the pre-refactor inline body this guard was pinned to. The strictly-stronger framing
was correct in isolation but bought that strength at the cost of alarming on a same-behaviour
refactor with zero actual drift — exactly the false-conflict shape the merge-train dry-run exists
to surface (see the dry-run's own §4 G1 row).

**Fix**: the three functions' equivalence is now checked by MATERIALIZING each copy's extracted
source into a real, callable function (`materializeAll()`, `required-web-lane-token-manifest-guard.test.ts`)
and comparing OUTPUT across a named battery of >=6 fixtures (a bare single line, a backslash
continuation, a comment before the block, a comment between two already-terminated lines, a dead
block after `exec`, a blank line before the block) — not source text. `required-web-lane-exec-block.mjs`
gained its own `logicalLinesWithLineNumbers()` export in the same round (an ADAPTER matching the
sibling's post-refactor shape, per this PR's own "write an adapter, not a fourth copy" convention
— §4 item 1 above — not a behaviour change: its own `logicalLines()` output is proved unchanged by
construction, same filter-then-fold steps in the same order) so the line-number-mapping half of
the comparison has a same-shaped counterpart once a sibling exports one; on THIS branch alone
(`required-web-lane-registration-shape.test.ts` not yet carrying #5898) that half is
feature-detected and skipped, not silently vacuous (the test asserts the detection itself).

> **SUPERSEDED IN ROUND 5 — this sentence, not the section.** The round-4 gate (r4-P3-1) measured
> what "feature-detected and skipped" costs: on this branch the skipped body made the test a
> tautology (`expect(false).toBe(false)`), so a sibling mutation reddened 2 tests on the dry-run
> tree and 1 here. Round 5 rewrote that test to be self-contained — see §12 (r4-P3-1). The rest of
> the G1 paragraph above (the materialize-and-compare fix, the fixture battery, the deliberate
> in-continuation-`#` exclusion) is unchanged and still OPERATIVE.

One shape is DELIBERATELY EXCLUDED from the "must agree" fixture set: a `#` comment landing INSIDE
an active backslash continuation. Measured (not assumed): the two documented fold orders disagree
there — this PR's algorithm (strip all `#` lines, then fold) glues both sides of the comment into
one logical line, while #5898's bash-order fix flushes the buffer and starts fresh at the comment,
per real bash semantics. A separate test proves this divergence is real, so the exclusion reads as
a measured boundary, not an unexplained carve-out.

### G2 — root cause

The M2 mutation-self-proof case hardcoded the exec block's physical start line: `expect(lineMap.get(...)).toEqual([1257])` — `1257` being `main`'s line number for `exec npx vitest run \` at the time round 1 wrote the test. A-2, an unrelated lane in the same dry-run (card 9), inserts 102 comment lines above the exec block, moving that same line to `1359`. The hardcoded literal has no way to track that; the assertion reds even though nothing about the exec block's OWN shape or tokens changed.

**Fix**: the expected line is now PARSED from the real (unmutated) `run-required-web-tests.sh` via
`allVitestInvocations()` — the same function the rest of this guard already trusts to answer "where
does the exec block start" — rather than hand-typed. A new discriminating test inserts N (37,
chosen arbitrarily — independent of any one lane's actual insertion count) comment-only physical
lines above the exec header and asserts the detected start line moves by exactly N, so a future
regression back to a hardcoded literal would itself be caught (that test would still pass against
a hand-typed constant only if N happened to be 0, which it deliberately is not).

> **SCOPE CORRECTION, ROUND 5 — this claim, not the section.** As written it is true of the exec-block
> site it describes and of nothing else: the round-4 gate (r4-P2-1) found four more hardcoded
> physical-line expectations of the identical shape surviving in the same file, and a widened
> round-5 census found two more the gate's enumeration had not reached. The discriminating test
> above guards the M2 site; it has no reach into the others. Round 5 derives them — see §12
> (r4-P2-1), including the measured before/after for a 40-line insert.

### Verification

See the verification doc's own §8 (round 4) for the exact commands and measured before/after
numbers on both the standalone branch and the `refs/dryrun/mtv3-final` overlay.

---

## 12. Round 5 (2026-09-22) — round-4 gate findings (`r4-` prefix)

Source: `impl-gate-H6-token-manifest-guard-round4-20260922.md`, verdict APPROVE-with-hardening,
0 P1 / 2 P2 / 3 P3 / 2 NIT, head-scoped to `1e23dca923a8ccb98477d3fdb5fcf4d0a5d117c5`. Nothing in
that report blocked; this round lands the hardening it attached. Commands and verbatim outputs for
each item are in the verification document's §r5.

### r4-P2-1 — the residual hardcoded line numbers, derived from the script under test

Round 4 fixed the M2 site (`toEqual([1257])` → parsed start line) and left the same shape standing
elsewhere in the same file. The gate enumerated 5 sites / 4 values. A widened census this round —
`grep -nE '[0-9]{3,}'` over the whole file, then classifying each hit as derived / prose / live —
found **two more load-bearing sites the gate's enumeration had not reached**, both in M5:

| site | round-4 expectation | round-5 derivation | failure mode it had |
|---|---|---|---|
| `stripTrailingErrorGuard` real-line test | `invocations.find((l) => l.startLine === 1180)` / `=== 1183` | `invocations.filter((inv) => stripTrailingErrorGuard(inv.text) !== inv.text)` — selected by the property under test | red on its own fixture sanity |
| M5 message, scanned lines | `toContain('477')` | `toContain(String(scannedLines[0]))` | red |
| M5 message, deleted line (**gate census missed this one**) | `.not.toMatch(/\b624\b/)` | `.not.toMatch(new RegExp(\`\\b${idx + 1}\\b\`))` | **VACUOUSLY GREEN** — once the lane shifts, 624 names nothing and the negative assertion stops testing the deleted line |
| M5 invocation count (**gate census missed this one**) | `.toBe(18)`, message `19 -> 18` | `.toBe(allVitestInvocations(scriptSrc).length - 1)` | red whenever the lane gains or loses a gating line |
| M6 attribution | `.toEqual([690])` + `@line(s) 690` | `idx + 1`, from the index the test already computes | red |
| M7 attribution | `.toEqual([555])` ×2 | `idx + 1`, same | red |

The silent-green row is why the widened census mattered: a loud red is a nuisance, an assertion
that quietly stops checking its subject is the failure this guard exists to prevent elsewhere.
Deriving that row's number is necessary but not sufficient: `describeMissing` prints the
post-mutation scanned lines, and the deleted line's number is absent from that list for nearly any
value, so the negative match would survive a drifted expectation just as quietly. The round-5 test
therefore also asserts that the derived number still indexes the physical line the mutation removed
— that is the assertion with discriminating power, and verification §r5.3's PC-D mutates the
derivation to show it reds.

Line numbers were also deleted from the `it()` titles and fixture-sanity messages that carried them
(`(1180, 1183)`, `line 624`, `(690: …)`, `(555)`). Deleted, not re-derived: they were prose, they
would rot the same way, and a round whose subject is derived-not-hardcoded expectations should not
leave hand-typed line numbers in its own test names.

**Measured** (verification §r5): with 40 comment-only lines inserted after the lane script's
shebang — a change that alters zero tokens and zero logical lines — the round-4 file gives
`4 failed | 24 passed (28)` (reproducing the gate's §3.5 exactly, on the branch tree) and the
round-5 file gives `29 passed (29)`.

### r4-P2-2 — the stale count is deleted, not re-measured

Guard file `:116` and design `:402` both printed a before/after test count, both stale, and the
guard's own sentence claimed the figure was taken from the command's output when it had been
carried over by hand. The count is **deleted from both live sites** and the qualitative claim it
was decorating — that one `--reporter=verbose` run collects both files from the same default-config
glob — is kept with its command. This deviates from the gate's literal prescription ("re-measure
and paste 18 → 46 / total of 28"): a pasted figure is correct for exactly as long as it takes the
next round to add an assertion, and this one has gone stale in three consecutive rounds. The dated
transcripts in the verification document keep the measured figures where they cannot rot.

### r4-P3-1 — the line-number-mapping test is self-contained

Round 4's mapping test skipped its body unless the sibling exported `logicalLinesWithLineNumbers`,
which on this branch it does not, making the test `expect(false).toBe(false)`. Rewritten to run the
FIXTURES battery unconditionally against three things: (a) the fold half, compared to this file's
own `logicalLines()` and to both sibling copies' — so the wrapper is checked against three parsers
regardless of sibling state; (b) the line-number half, anchored on the **fixture's own text** —
each fixture carries exactly one `exec npx vitest run` logical line, so the physical index of its
header is found by a raw scan that no fold implementation participates in; (c) the full
`{line, lineNumber}` comparison from round 4, which now widens in automatically when the sibling
grows the export.

**Positive control** (verification §r5): mutating `startLine = lineNo` → `lineNo + 1` inside
`logicalLinesWithLineNumbers()` reds exactly this test under round 5 and is **entirely green**
under the round-4 file — the difference is the vacuity the gate identified.

### r4-P3-2 — indented-`#` fixtures

Two added: `indentedCommentBeforeBlock` (space-indented, before the block) and
`indentedCommentInsideBlockOutsideContinuation` (tab-indented, between two already-terminated
logical lines). MUT-E — narrowing a copy's comment predicate from `^\s*#` to `^#` — was measured
green by the round-4 gate across the whole battery; it now reds on both new fixtures. The lane
script still has no indented `#` among its gating lines, so this class stays latent in production
and live in the battery.

### r4-P3-3 — the rotted exemption comment, plus the coverage it was hiding

`allVitestInvocations`'s header justified its duplicate fold loop by saying `logicalLines()` had to
stay byte-identical to its siblings and therefore could not track line numbers. Round 4 falsified
both halves. The comment now states the actual round-4 reason (output-shape stability, scoped), and
the residual it names — the fourth copy compared on a single input — is narrowed, not closed, from
the test side: `r2-P3-4` gained a widened case running the same `allVitestInvocations` ↔
`logicalLines` comparison across the shared FIXTURES battery, but that comparison is filtered
through a `vitest run` predicate, which absorbs the divergence the two indented-`#` fixtures were
added to catch — existing, unresolved (round-5 gate P3-1).

### r4-NIT-1 / r4-NIT-2

NIT-1: the `git cherry` transcript's `+ <round-4 commit>` placeholder is replaced with the measured
SHA. The round-5 commit is deliberately **not** added to that block — a transcript cannot list the
commit that creates it, and back-filling self-referential snapshots is how three of the last four
rounds introduced a fresh false number.

NIT-2: §8b's "+3 net" sentence, which enumerated five items against a net-of-three delta, is split
into its two kinds (new vs. rewritten-in-place) with the arithmetic removed.

### Still open after this round

r3-P3-1 (census incomplete: a 7th/8th lane-reading guard findable by one `git grep`), r3-P3-2
("pinned by NOTHING" is text-literal), r3-NIT-1 (bounds live in prose, not an assertion) — carried
forward unchanged, out of this round's scope, as they were out of round 4's. Round 2's two
owner-disposition items (P1-1 option (a) vs. (b); merge sequencing) remain **unresolved by any
owner ruling** — no comment or review exists on #5974.

### Round-5 gate, record-level disposition (2026-09-22)

The round-5 gate (`impl-gate-H6-token-manifest-guard-round5-20260922.md`) found the three
"closed"/"covered" sentences above (this section, and the matching comments in the guard test and
`exec-block.mjs`) overclaiming: the fourth-copy comparison is filtered through a `vitest run`
predicate that absorbs the divergence the two indented-`#` fixtures were added to catch. This
record-only pass narrowed those three sentences (a comment edit in the guard test file counts among
them) to what the assertion actually covers; it does not add the fixture the gate's fix (a) would
need to close the gap. **P3-1 (fourth-copy coverage hole) and NIT-1 (fixture-count floor still
reads 6 against an actual battery of 8) are existing, unresolved** — no assertion changed in this
pass.
