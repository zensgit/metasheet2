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
more distinct tokens, of which **28** were pinned by NOTHING else in the repo (P1-1); the review
also measured that **192 of the lane's 499 total tokens are already gated today** by four existing
census/shape guards, so "currently has no automated gate" (P2-1) was true for the exec block's
majority but not universally.

**Owner-selected fix: P1-1 option (a) — widen the parser to all 19 invocations, not option (b)
(rename/rescope to "exec block only" and record the residual as OPEN)**, on the reviewer's own
framing that only (a) closes the 28 ungated tokens. This round:

1. Adds `allVitestInvocations` / `allVitestTokenLines` / `allVitestTokens` /
   `stripTrailingErrorGuard` to `scripts/ops/required-web-lane-exec-block.mjs`, unioning the token
   sets of all 19 gating lines — while KEEPING `execLogicalLine`'s "exactly one exec logical line"
   throw (fail-closed, retained, not replaced) and keeping `logicalLines`/`execLogicalLine`/
   `tokensOf` byte-identical to the other two copies of them elsewhere in the repo (a new guard
   test asserts this — P3-6).
2. Regenerates the manifest at **499** tokens (was 397).
3. Restates the "no automated gate" premise with the measured numbers (P2-1, this section and §1).
4. Adds a merge-sequencing section (§9, P2-2) — WIDENED relative to round 1's exec-block-only
   framing: any of the 18 additional free-form lines, not only the exec block, is now
   manifest-bearing.
5. Fixes P3-1…P3-7 and NIT-1…NIT-3 (see §10).

**Cost, stated plainly (per the review's own framing of option (a), not softened here):** this is
not a five-line change in effect. It makes 18 additional invocation sites manifest-bearing, and
unlike the exec block none of them is one-token-per-line, sorted, or covered by the shape guard's
structural assertions — so an edit to any of those free-form command lines now needs a
`node scripts/ops/required-web-lane-token-manifest.mjs --write`, and each one becomes a new way to
red `main` under the §9 mechanism.

## 1. Problem, restated precisely

`apps/web/scripts/run-required-web-tests.sh` has **19** logical lines matching `\bvitest\s+run\b`
after `set -euo pipefail` (line 473): 18 earlier `npx vitest run …` lines (lines 477, 501, 539,
555, 556, 557, 566, 600, 612, 624, 662, 690, 704, 730, 752, 785, 1180, 1183) plus the final
`exec npx vitest run \` logical line (line 1257) — a positional filter of **397 tokens**, one per
physical line, backslash-continued, sorted case-insensitively (Q8/C4 P1, 2026-09-21,
`docs/development/web-required-lane-multiline-registration-design-20260921.md`). All 19 lines are
run by `web-tests.yml`'s `web-tests` job — every token on every one of them is a *required* gate,
not only the final line's.

**Measured token census (round-1 gate review, independently re-derived and confirmed here):**

| scope | distinct tokens |
|---|---|
| final `exec` block (line 1257) | 397 |
| the 18 earlier `npx vitest run` lines | 102 |
| **total distinct required-lane tokens (19 lines, zero overlap)** | **499** |

Two guards already exist, both **shape**-only and both scoped to the exec block specifically:

- `packages/core-backend/tests/unit/required-web-lane-registration-shape.test.ts` — bash parses,
  exactly one exec logical line, one token per physical line, no duplicates, case-insensitive
  sort, trailing `--reporter=dot`, `.gitattributes` pin present, second registration point alive.
- `apps/web/tests/attendance-web-guard-workflow.spec.ts` — parses the *attendance* web guard
  workflow's own targeted step the same way (a sibling concern, not this block).

Neither asserts anything about **which tokens are in the set**, and neither reads the 18 earlier
lines at all. Delete one token from the middle of an otherwise well-formed, sorted, duplicate-free
exec block — every shape assertion above still passes; the file is exactly as shaped, one filter
shorter. This is not hypothetical: the independent adversarial verification
(`/Users/chouhua/.claude/projects/-Users-chouhua-Downloads-Github-metasheet2/reviews/verify-exec-block-incident-fixes-20260921.md`,
§3, P2-2) measured it directly — 357 test cases across the three census/shape guards that read
this file, run three ways (baseline / a main token deleted / a lane token deleted): **357 passed
in every one of the three runs**.

**Restated with the round-1 gate review's measured numbers (P2-1 correction — round 1 overclaimed
"no automated gate" universally):** four existing lane-reading guards
(`approval-ci-coverage-enumeration.test.ts`, `stock-prep-web-ci-coverage-enumeration.test.ts`,
`elearning-media-ci-wiring.test.mjs`, `network-unavailable-copy-ci-wiring.test.ts`) already gate,
between them, **192 of the lane's 499 tokens today** (118 in the exec block, 74 among the 18
earlier lines) — by asserting things like "every non-allowlisted `approval*.spec.ts` file has a
matching lane token", not by reading this script directly. Of the remaining 307 tokens (499 − 192),
**279** are in the exec block (genuinely ungated before this PR) and **28** are among the 18
earlier lines and were pinned by NOTHING at all, before or after round 1:

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

A token silently dropped from one of these 28 — by a bad rebase, a manual edit, or a "cleanup"
that removes the wrong line — had, and (before this PR's widening) still has, **no automated gate
at all**. That is the precise, measured version of the premise; "no automated gate" is true for
this 28-token residual and for the 279-token exec-block majority, not for all 499 tokens uniformly.

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
  but is not itself a required context, see NIT-3/P3-3 below) is bare `uses: actions/checkout@v4`
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
guard to keep the resulting diff well-formed the way the exec block's is. See §9 for the
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
`tokensOf` themselves. Those three stay byte-identical to the other two copies on purpose: a new
guard test (`required-web-lane-token-manifest-guard.test.ts`, "cross-copy agreement", P3-6 below)
extracts the shape guard's own copy from its source text, normalizes away the only documented
differences (the `export` keyword, TypeScript type annotations, and comments), and asserts textual
equality against this module's copies — a check that is strictly *stronger* than a behavioural
one, since it holds for every input, not only the ones both guards happen to exercise today.
`allVitestInvocations` still calls `execLogicalLine` first and lets its "exactly one exec logical
line" throw propagate — the fail-closed property from round 1 is retained, not relaxed.

The `|| exit $?` tail on lines 1180/1183 (a belt-and-suspenders error-propagation idiom;
`set -euo pipefail` already covers it) would otherwise tokenize as three bogus "tokens" — `||`,
`exit`, `$?` — under the unmodified `tokensOf`. `stripTrailingErrorGuard` strips exactly that
trailing idiom (anchored at end-of-string) before tokenizing; it is applied only at the
`allVitestInvocations`-family call sites, never inside `tokensOf` itself, precisely so `tokensOf`
stays byte-identical to the other two copies. Verified: without the strip, the raw union has 502
distinct entries (499 real tokens + `||`/`exit`/`$?`); with it, exactly 499 — matching the round-1
gate review's independently-derived count.

## 5. What the guard actually asserts

`required-web-lane-token-manifest-guard.test.ts` (round 2 numbering — see §10 for the P3/NIT
disposition of each round-1 finding):

1. **Sanity** — the active token collection (union of all 19 gating invocations) and the manifest
   are each greater than HALF the other's size (round 2, NIT-3: a floor DERIVED from the other
   side's measured count, not a hardcoded `> 300` — a legitimate synchronized shrink of the lane
   does not spuriously red this, but the degenerate "both collapse to empty" case still does;
   proven by a dedicated probe test, not merely asserted).
2. **Manifest hygiene** — no duplicate TOKEN lines (header/comment lines are excluded from the
   count first — round 2, P3-5; a duplicate is not a safety gap by itself — set semantics absorb
   it — but is dead weight worth flagging, and it DOES hard-fail this specific assertion, corrected
   language per P3-4 / §10).
3. **`missingFromActive` (manifest ⊅ active) is empty** — a token recorded in the manifest that is
   produced by NO gating invocation: **silently dropped from the required web lane.** The failure
   message names the SCANNED line numbers, not the token's former line — round 2 acknowledges this
   is the honest limit of what a script-and-manifest-only guard can localize for a deletion (see
   §9's mutation table, M5).
4. **`extraInActive` (active ⊅ manifest) is empty** — a token produced by a gating invocation but
   not yet recorded in the manifest: **added without updating the record.** The failure message DOES
   name the exact source line(s), since that information is available for a token that still
   exists in the active text (§9's M6 proves this).
5. **`.gitattributes` pins the manifest** the same way it pins the script (`text eol=lf
   merge=union`).
6. **Cross-copy agreement (round 2, P3-6)** — `logicalLines`/`execLogicalLine`/`tokensOf`'s
   normalized source text (stripping `export`/TS types/comments) is asserted equal, character for
   character, to the shape guard's own copy of the same three functions, extracted from its file
   text without executing it (importing that file would re-register its 18 `describe()`-registered
   tests — see §4).

Both direction assertions (3, 4) are separate `it()` blocks specifically so a mutation of one
direction cannot hide behind, or be conflated with, the other — see §9.

This is a **set** assertion (`Set` membership checks over parsed token arrays), not a text/regex
match — the class of guard the standing "source-text assertions are not behaviour" and "count
guards conflate sources" feedback both warn against building instead.

## 6. Reserved (see §9 for the mutation plan, moved and expanded)

## 7. CI wiring — how this actually lands in the required lane

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
  this file and `required-web-lane-registration-shape.test.ts` from the same default-config glob,
  **18→39 tests** before/after this file existed (18 unedited shape-guard tests; round 1 added 10,
  round 2 replaced them with 21 — see the verification document for the transcript; round-1 design
  §7 said "27→28", which was wrong on both numbers — P3-2, corrected here). This is the proof the
  task asked for in place of trusting "no wiring needed, same as the shape test."
- `web-tests.yml` (the job that actually **executes** the pinned tokens against vitest) is a
  separate, always-on job (`web-tests`, no path filter) — this guard does not run there and does
  not need to; it runs in the job that gates the manifest file's correctness, not the job that
  consumes it.
- The `test` job's `pull_request` trigger has no path filter (confirmed above), so this guard runs
  on every PR regardless of which files it touches.

## 8. Explicitly not done in this PR

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
  not only the exec block) and, separately, of §9's merge sequencing relative to the four in-flight
  PRs noted in the PR body (A-2/A-4/A-5/B-2).

## 9. Mutation plan (round 2: re-run and expanded) and merge sequencing (P2-2)

### 9a. Mutation plan

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

### 9b. Merge sequencing (P2-2, WIDENED beyond round 1's exec-block-only framing)

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

**Chosen sequencing (owner call, stated here so it is not left to be inferred from a Coordination
paragraph):** merge this PR only in one of two ways:

1. **After** A-2 / A-4 / A-5 / B-2 have all landed on `main` — at that point this PR should be
   rebased, the manifest regenerated once more (`--write`), and only then merged; or
2. **Before** them, provided each of the four is re-run through `test (20.x)` (a fresh push, or a
   maintainer-triggered re-run against a ref no older than this PR's merge) before it lands, so
   none of them can merge carrying an ungoverned token drift into `main`.

Whichever is chosen, note the guard's own failure message already prints the exact remediation
command (`node scripts/ops/required-web-lane-token-manifest.mjs --write`), which keeps the recovery
cheap once someone notices — the risk this section addresses is the blast radius and the fact that
`strict: false` means nobody is forced to notice before merging.

## 10. Disposition of round-1 gate review findings (P3/NIT), all addressed in round 2

| Finding | Fix |
|---|---|
| P3-1 (tsc vacuous for the new file) | Verification §4c wording corrected — exit 0 is confirmed NOT to type-check the new file (`--listFiles` still shows 0 hits); no gate exists for this file's TS today, stated plainly rather than implied as coverage. |
| P3-2 ("27→28", should be 18→28) | §7 above corrected to the actual 18→39 (round 2 added more assertions than round 1's 10). |
| P3-3 (`test (18.x)` treated as required) | §7 above, this doc's other mentions, and the guard test header all corrected to "only `test (20.x)` is required". |
| P3-4 (`.gitattributes` "harmless/absorbed" contradicts the hard assertion) | `.gitattributes` prose corrected; the hard `no duplicate lines` assertion is UNCHANGED (kept, per the review's own "fix the prose … not both"). |
| P3-5 (manifest has no `#` support / provenance) | Both readers (generator, guard test) strip `#`-prefixed lines; `--write` now emits a provenance header. |
| P3-6 (no cross-copy agreement assertion) | New "cross-copy agreement" test, §5 item 6 above. |
| P3-7 (no status marker on either doc) | `Status: PROPOSED (candidate — awaiting owner disposition)` added to this doc's header and the verification doc's header. |
| NIT-1 ("7 checkout steps", actually 6) | §2 corrected. |
| NIT-2 (`manifist` typo) | Guard test header corrected to `manifest`. |
| NIT-3 (hardcoded `> 300` floor) | Replaced with a floor derived from the other collection's size (§5 item 1), with a dedicated probe proving it still reds on the degenerate case. |
