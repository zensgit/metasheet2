# H-6 — required web lane token-loss guard: design

- Date: 2026-09-22 (UTC+8)
- Slice: H-6 (CI 守卫), branch `ci/required-web-lane-token-manifest-guard`
- Base: `origin/main` @ `cd42eaf7455f03dd99021a02c47c42f1f3db6484`
- Values-free: this document and every file it describes read/write only repo-tracked script and
  test text and token names — no host, IP, or credential.

## 1. Problem, restated precisely

`apps/web/scripts/run-required-web-tests.sh` ends in one `exec npx vitest run \` logical line — a
positional filter of (currently) **397 tokens**, one per physical line, backslash-continued,
sorted case-insensitively (Q8/C4 P1, 2026-09-21,
`docs/development/web-required-lane-multiline-registration-design-20260921.md`). That line is what
the `web-tests` job (`.github/workflows/web-tests.yml`) actually runs; it is what makes each token
a *required* gate.

Two guards already exist for this block, both **shape**-only:

- `packages/core-backend/tests/unit/required-web-lane-registration-shape.test.ts` — bash parses,
  exactly one exec logical line, one token per physical line, no duplicates, case-insensitive
  sort, trailing `--reporter=dot`, `.gitattributes` pin present, second registration point alive.
- `apps/web/tests/attendance-web-guard-workflow.spec.ts` — parses the *attendance* web guard
  workflow's own targeted step the same way (a sibling concern, not this block).

Neither asserts anything about **which tokens are in the set**. Delete one token from the middle
of an otherwise well-formed, sorted, duplicate-free block — every shape assertion above still
passes; the file is exactly as shaped, one filter shorter. This is not hypothetical: the
independent adversarial verification
(`/Users/chouhua/.claude/projects/-Users-chouhua-Downloads-Github-metasheet2/reviews/verify-exec-block-incident-fixes-20260921.md`,
§3, P2-2) measured it directly — 357 test cases across the three census/shape guards that read
this file, run three ways (baseline / a main token deleted / a lane token deleted): **357 passed
in every one of the three runs**. Zero of those 357 assertions is sensitive to a deleted token. A
token silently dropped from the required web lane — by a bad rebase, a manual edit, or a
"cleanup" that removes the wrong line — currently has **no automated gate** in this repo.

`scripts/ops/required-web-lane-token-set-diff.mjs` already computes exactly the SET comparison
needed to catch this, but only as a script a human (or a merge-conflict-resolution agent) is
expected to remember to run against `origin/main` — it is not wired into any workflow.

## 2. Two options

### Option B — CI step diffing against `origin/main`/merge-base

Run `required-web-lane-token-set-diff.mjs` in CI, comparing the PR head against `origin/main` or
the merge-base.

**Rejected — verified against this repo's actual CI wiring, not assumed:**

- Every `checkout` step in `.github/workflows/plugin-tests.yml` (the workflow that produces the
  required `test (18.x)`/`test (20.x)` checks) is bare `uses: actions/checkout@v4` with **no**
  `fetch-depth:` override (checked: `grep -n fetch-depth .github/workflows/plugin-tests.yml` — zero
  hits across all 7 checkout steps in that file, including the `test` job's, at what is line 183 on
  `origin/main`). `actions/checkout@v4`'s default is `fetch-depth: 1` — a single commit, no
  `origin/main` ref materialised in the runner's `.git` at all.
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

### Option A — a committed token-SET manifest (chosen)

Commit `apps/web/scripts/run-required-web-tests.tokens`: one token per line, sorted, generated by
`node scripts/ops/required-web-lane-token-manifest.mjs --write`. A guard test
(`packages/core-backend/tests/unit/required-web-lane-token-manifest-guard.test.ts`, same directory
as the shape guard, same always-on required lane) asserts **set equality** between the manifest and
the live exec block's token set, reporting the missing/extra difference on failure. No git history,
no merge-base, no event-shape dependency — it compares two texts that are both present in every
checkout, shallow or not, `push` or `pull_request`.

**Cost, stated plainly (this is the real trade, not a footnote):** every PR that adds a token to
the exec block must, in the **same PR**, run `--write` and commit the updated manifest — otherwise
this guard reds that PR (by design: an active-only token is exactly the "extra" case). For a
stacked/rebasing PR that also edits the exec block, this is a **second file to keep in sync with
the same rebase conflict** the Q8 multi-line rewrite already tries to make rare. It does not make
that conflict worse in kind — the manifest is itself one-token-per-line and `merge=union`-tagged
for the same local-rebase fallback reasoning as the script (see `.gitattributes`) — but it is
strictly one more file a spec-adding branch must touch, and the guard is what makes forgetting it
visible rather than silent.

## 3. How the guard is attacked (adversarial self-check)

Per the standing instruction to attack a "nothing was silently dropped"-shaped judgment: **can the
manifest itself be deleted alongside the token it should have caught, in the same PR, defeating the
guard by construction rather than by oversight?**

Yes. If a PR removes a token from the active exec block **and** removes the matching line from
`run-required-web-tests.tokens` in the same commit, the two sets stay equal and this guard stays
green — it would have to, since by the mutation self-proof below (M1) the guard's only lever is set
inequality, and a coordinated edit keeps the sets equal by construction. **This is recorded here as
an OPEN item, not closed by this PR.** The guard's actual safety property is narrower than "a token
cannot be silently dropped" — it is **"a token cannot be dropped from the exec block without also
touching a second, named file in the same PR, and that second file's diff is then visible to
whoever reviews the PR."** That converts a silent, invisible drop into a reviewable one; it does
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

## 5. What the guard actually asserts

`required-web-lane-token-manifest-guard.test.ts`:

1. **Sanity** — both the active block and the manifest have `> 300` tokens (a scan negative
   control: an empty file on either side would make every later assertion vacuously pass).
2. **Manifest hygiene** — no duplicate lines (a duplicate is not a safety gap by itself — set
   semantics absorb it — but is dead weight worth flagging).
3. **`missingFromActive` (manifest ⊅ active) is empty** — a token recorded in the manifest that is
   no longer in the live exec block: **silently dropped from the required web lane.**
4. **`extraInActive` (active ⊅ manifest) is empty** — a token in the live exec block not yet
   recorded in the manifest: **added without updating the record.**
5. **`.gitattributes` pins the manifest** the same way it pins the script (`text eol=lf
   merge=union`).

Both direction assertions (3, 4) are separate `it()` blocks specifically so a mutation of one
direction cannot hide behind, or be conflated with, the other — see §6.

This is a **set** assertion (`Set` membership checks over parsed token arrays), not a text/regex
match — the class of guard the standing "source-text assertions are not behaviour" and "count
guards conflate sources" feedback both warn against building instead.

## 6. Mutation plan (executed against the real files with cp/restore/cmp — see the companion
   verification document for the actual transcripts)

| # | Mutation | Expected | Assertion that fires |
|---|---|---|---|
| M1 | Delete one token line from the **active** exec block | RED, listing the token as missing | "every manifest token is still present in the active exec block" |
| M2 | Add one token line to the **active** exec block, not present in the manifest | RED, listing the token as extra | "every active exec-block token is recorded in the manifest" |
| M3 | Delete one line from the **manifest** (token still active) | RED, listing the token as extra (manifest no longer vouches for a token the lane still runs) | same assertion as M2 |
| M4 | Reorder either file (no add/remove) | GREEN — unchanged | none (proves set, not sequence, semantics) |

The guard test file also carries its own **in-memory** mutation self-proof section (same
discipline as the shape guard's own M1–M5 block) that exercises the same four cases against
in-memory copies of the real token sets, so a regression in the diff logic itself reds
independently of whether anyone runs the on-disk mutation drill again.

## 7. CI wiring — how this actually lands in the required lane

- `required-web-lane-token-manifest-guard.test.ts` is placed in
  `packages/core-backend/tests/unit/`, the exact directory the shape guard was added to one day
  earlier, and is picked up by the identical mechanism: `plugin-tests.yml`'s `test` job (matrix
  `[18.x, 20.x]`, so it runs as both `test (18.x)` and `test (20.x)`) has a step named
  **"Run core-backend tests"** (`pnpm --filter @metasheet/core-backend test`, `packages/core-
  backend/package.json`'s `"test": "vitest"`), which collects every `*.test.ts` under
  `packages/core-backend/vitest.config.ts`'s **default include glob** (that config defines only an
  `exclude:` array; it overrides no `include:` — checked by reading the file) minus the explicit
  exclusion list. This file's name is not in that list.
- **Independently confirmed, not just inferred from precedent**: `npx vitest run
  required-web-lane --reporter=verbose` (run from `packages/core-backend`) is a *substring* filter
  that vitest applies to the file list it has already globbed under the real config — not a literal
  path handed straight to a loader (that would only prove a targeted run passes, not that anything
  collects the file, per the standing "triggered ≠ verified" rule). That command collects **both**
  this file and `required-web-lane-registration-shape.test.ts` from the same default-config glob,
  27→28 tests before/after this PR (see the verification document for the transcript). This is the
  proof the task asked for in place of trusting "no wiring needed, same as the shape test."
- `web-tests.yml` (the job that actually **executes** the pinned tokens against vitest) is a
  separate, always-on job (`web-tests`, no path filter) — this guard does not run there and does
  not need to; it runs in the job that gates the manifest file's correctness, not the job that
  consumes it.
- The `test` job's `pull_request` trigger has no path filter (confirmed above), so this guard runs
  on every PR regardless of which files it touches.

## 8. Explicitly not done in this PR

- No change to the active exec block's token SET (`node
  scripts/ops/required-web-lane-token-set-diff.mjs origin/main` against this branch: `SET
  IDENTICAL`, 397/397 both sides).
- No edit to `required-web-lane-registration-shape.test.ts`,
  `required-web-lane-token-set-diff.mjs`, or `attendance-web-guard-workflow.spec.ts` — all three
  are left byte-identical to `origin/main` (checked by re-running each after this branch's changes
  and diffing against the fetched `origin/main` blobs).
- No branch-protection / required-context change, no DDL, no merge, no undraft. This is a
  candidate PR awaiting owner disposition of §3's OPEN item and, separately, of whether the four
  in-flight PRs noted in the PR body (A-2/A-4/A-5/B-2, all currently touching the same exec block)
  should rebase onto this manifest before or after it lands.
