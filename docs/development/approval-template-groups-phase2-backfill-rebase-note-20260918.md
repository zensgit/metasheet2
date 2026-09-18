# approval-template-groups-phase2-backfill: rebase-onto-phase1 note (2026-09-18)

Worktree: `/private/tmp/claude-501/-Users-chouhua-Downloads-Github-metasheet2/6f6639a7-0412-43de-bd8b-0b416d18ae6b/scratchpad/wt-groups-p2`
Branch: `feat/approval-template-groups-phase2-backfill`
Operation: `git rebase origin/feat/approval-template-groups-phase1`

No verification MD existed yet for this branch (phase1's own
`approval-template-groups-phase1-verification-20260918.md` covers a different branch), so this
rebase's evidence is recorded here per instruction.

## 1. Pre-flight

- `git fetch origin feat/approval-template-groups-phase1 feat/approval-template-groups-phase2-backfill`
  confirmed `origin/feat/approval-template-groups-phase1` = `03ee9f4bb6c7eb67349da5cda332cf4e4d6ceaac`
  (expected, matches task text) and the branch under rebase was up to date with its own origin at
  `13c802cecc21a372817063fd5bc232a5c84c9860` (26 commits) before the rebase started, working tree
  clean.
- Merge base of the two branches: `0144932ac67e80a81f204dd6c6e502d000112276`. `feat/approval-template
  -groups-phase1` contributed exactly one commit past that base: `03ee9f4bb` ("fix(approval): map
  CJK-name CHECK violation to 400, correct guard/manager overclaim"), touching
  `packages/core-backend/src/routes/approvals.ts`,
  `packages/core-backend/src/services/ApprovalTemplateGroupService.ts`,
  `packages/core-backend/tests/integration/approval-template-groups-lifecycle.db.test.ts`, and its
  own verification MD (441 insertions / 24 deletions across 4 files, `git show --stat`).

## 2. Rebase and conflict resolution

`git rebase origin/feat/approval-template-groups-phase1` replayed all 26 commits of
`feat/approval-template-groups-phase2-backfill`. Exactly ONE conflict occurred, on the 2nd replayed
commit (`68aead6db`, "refactor(approval): split ApprovalTemplateGroupService into WithClient
primitives") — in the module's header JSDoc comment only, not in any executable statement. HEAD's
side (from phase1's `03ee9f4bb`) had appended a paragraph documenting `GROUP_NAME_UNSUPPORTED`
(400 mapping for 23514 CJK-name CHECK violations); the incoming commit appended a different
paragraph documenting the `...WithClient` primitive split (23505/deadlock-avoidance rationale) at
the same insertion point. Per the conflict recipe (both sides kept, union), resolution kept BOTH
paragraphs — HEAD's `GROUP_NAME_UNSUPPORTED` paragraph first (already-landed phase1 content),
followed by the incoming `...WithClient` split paragraph — separated by a blank comment line, with
no other text added, removed, or reordered. Confirmed by diffing the resolved file against the
pre-resolution conflicted version: the only lines that differ are the three marker lines
(`<<<<<<< HEAD` / `=======` / `>>>>>>> 68aead6db …`), which were deleted, plus one blank `` * ``
separator line inserted in their place — zero content lines changed.

`git add` + `git rebase --continue` completed the remaining 24 commits with no further conflicts:
`Successfully rebased and updated refs/heads/feat/approval-template-groups-phase2-backfill.`

**Conflict-marker grep (files touched by this rebase only), count:**
```
$ git diff --name-only 13c802cecc21a372817063fd5bc232a5c84c9860..HEAD | xargs grep -nE '^(<<<<<<<|=======$|>>>>>>>) ?'
(no output)
$ git diff --name-only 13c802cecc21a372817063fd5bc232a5c84c9860..HEAD | xargs grep -nE '^(<<<<<<<|=======$|>>>>>>>) ?' | wc -l
       0
```
A repo-wide grep for the same exact markers (`^(<<<<<<<|>>>>>>>) `) does hit 6 lines, all in
pre-existing historical documentation (`claudedocs/PHASE2_PREPARATION_GUIDE.md`,
`claudedocs/PR215_MERGE_REPORT_20251103.md`, `claudedocs/PR331_MERGE_REPORT_20251102.md`,
`claudedocs/PR337_MANUAL_REBASE_GUIDE.md`, `docs/merge-reports-2025-10/PR151_MERGE_RESOLUTION_
REPORT_20251027.md`, `packages/claudedocs/BATCH2_MERGE_SUMMARY.md`) — illustrative merge-report
prose from unrelated past PRs, none of which appear in this rebase's touched-file list (confirmed
by the file-scoped grep above returning zero), so they are pre-existing and out of scope, not a
missed resolution.

## 3. Union / recompute items — none were needed

The recipe called for taking the union on `plugin-tests.yml`, the test-file manifest, the
ci-wiring population, and `ci-realdb-step-contract.mjs`'s closed world, plus mechanically
recomputing the s6a pin after rebase. None of these files conflicted during the rebase (the only
conflict was the doc-comment paragraph above), and a direct comparison confirms why: phase1's sole
commit never touched any of them.

```
$ git diff 13c802cecc21a372817063fd5bc232a5c84c9860..HEAD -- .github/workflows/plugin-tests.yml \
    packages/core-backend/vitest.config.ts scripts/run-required-web-tests.sh
(no output — byte-identical before and after the rebase)
```

Because `.github/workflows/plugin-tests.yml` is byte-identical pre- and post-rebase, the s6a
`pluginTestsWorkflow` pin does not need recomputation — mechanically re-derived and checked against
the recorded pin anyway, for the record:

```
$ shasum -a 256 .github/workflows/plugin-tests.yml
099904601c47c078fa5c81bf4387a26cc0678174de5a24f54b5edc86ae5bece1  .github/workflows/plugin-tests.yml
$ grep -n pluginTestsWorkflow plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json
90:    "pluginTestsWorkflow": "099904601c47c078fa5c81bf4387a26cc0678174de5a24f54b5edc86ae5bece1"
```
Match, byte-for-byte — no rewrite made. Independently confirmed executable (not just a value
comparison) via the repo's own provenance test:
```
$ node --test plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs
sealed-export-package-provenance.test.cjs OK
ℹ tests 1 / pass 1 / fail 0
```

The full post-rebase diff against the pre-rebase tip touches exactly the 4 files phase1's own
commit touched, with the exact same insertion/deletion counts — proof the rebase replay introduced
no incidental drift beyond the one intended conflict resolution above:

```
$ git diff --stat 13c802cecc21a372817063fd5bc232a5c84c9860..HEAD
 ...template-groups-phase1-verification-20260918.md | 246 +++++++++++++++++++++
 packages/core-backend/src/routes/approvals.ts      |  43 +++-
 .../src/services/ApprovalTemplateGroupService.ts   |  57 ++++-
 .../approval-template-groups-lifecycle.db.test.ts  | 119 +++++++++-
 4 files changed, 441 insertions(+), 24 deletions(-)
```
Identical file list and identical totals (441/24 across the same 4 files) to phase1's own commit
diff shown in §1 — the rebase replay landed exactly phase1's change on top of this lane's tip, with
no incidental drift.

## 4. Private DB verification — `metasheet2_lock_a3_rb`

```
$ dropdb --if-exists metasheet2_lock_a3_rb && createdb metasheet2_lock_a3_rb
$ DATABASE_URL="postgres://localhost/metasheet2_lock_a3_rb" pnpm exec tsx src/db/migrate.ts
```
All migrations applied cleanly, ending at
`zzzz20260919090000_create_approval_template_group_backfill_batches` (the phase-2 batch-table DDL).
A second `migrate.ts` run against the same DB produced zero further output — 0 pending.

### tsc

```
$ pnpm run type-check   # tsc --noEmit && tsc -p scripts/tsconfig.recovery-archive-acceptance.json
(clean, zero output, exit 0)
```

`metasheet2_lock_a3_rb` was dropped after the DB-backed commands in this section 4 and section 5
finished (an unintended stray `dropdb` in a later shell command, not a deliberate teardown step) —
harmless, since it is this operation's own private throwaway database and every DB-backed result
above and in section 5 was already captured before the drop. Anyone re-running section 4 or 5's
commands needs to `createdb metasheet2_lock_a3_rb` and re-run `src/db/migrate.ts` first.

### This lane's real-DB files + A-1's two files (union is 7 files — `serialization.db.test.ts` is
### in both sets)

`approval-template-groups-lifecycle.db.test.ts` and `approval-template-groups-serialization.db
.test.ts` are the two files A-1 (phase1) authored/owns; this lane's own new real-DB files are the
five `approval-template-groups-backfill-{schema,preview,execute,rollback,batches-list}.db.test.ts`
files (confirmed the lane also substantially modified `serialization.db.test.ts` itself — 349
insertions / 7 deletions between the merge-base and the pre-rebase tip — so it is a lane file too,
not only an A-1 file).

```
$ DATABASE_URL="postgres://localhost/metasheet2_lock_a3_rb" EXPECT_DB=1 pnpm exec vitest \
    --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-lifecycle.db.test.ts \
    tests/integration/approval-template-groups-serialization.db.test.ts \
    tests/integration/approval-template-groups-backfill-schema.db.test.ts \
    tests/integration/approval-template-groups-backfill-preview.db.test.ts \
    tests/integration/approval-template-groups-backfill-execute.db.test.ts \
    tests/integration/approval-template-groups-backfill-rollback.db.test.ts \
    tests/integration/approval-template-groups-backfill-batches-list.db.test.ts

 Test Files  7 passed (7)
      Tests  85 passed (85)
```

### Guards

Five per-suite ci-wiring guards for this lane's new files, `node --test`, all green (3
assertions each, 15/15 total):
`approval-template-groups-backfill-{batches-list,execute,preview,rollback,schema}-ci-wiring
.test.mjs` — each confirms (a) `vitest.config.ts` excludes the suite from the no-DB job, (b)
`plugin-tests.yml` runs it as a whole-file arg inside the `approval-real-db-integration` step
(the owner-ruled `ci-realdb-step-contract.mjs` id/if/env/config/whole-file four-pin contract, not
title-prefix or membership text-matching), and (c) the file exists on disk.

The closed-world census/population guard for the whole approval line,
`packages/core-backend/tests/unit/approval-ci-coverage-enumeration.test.ts` (drives off
`ci-realdb-step-contract.mjs`'s `REAL_DB_STEP_IDS` / `requireExecutableRealDbStep` and the W7
workflow-population scan):

```
$ pnpm exec vitest run tests/unit/approval-ci-coverage-enumeration.test.ts
 Test Files  1 passed (1)
      Tests  349 passed (349)
```
No new approval spec/test file is unwired or missing from the allowlist as of this HEAD.

## 5. Required test (20.x) — reproduced with only the DB endpoint substituted

Extracted the `approval-real-db-integration` step's run body byte-for-byte from
`.github/workflows/plugin-tests.yml` (lines 1614–1699, the exact `pnpm --filter @metasheet/core-
backend exec vitest --config vitest.integration.config.ts run …84 whole-file args… --reporter=dot`
invocation), changing only the `DATABASE_URL` value (this repo's shared/prod DB must never be
touched by a private lane run) to point at `metasheet2_lock_a3_rb`. This list now carries 84 files
(phase1's verification MD recorded 79 for its own tip; this lane's rebase adds the 5 new
`approval-template-groups-backfill-*.db.test.ts` files, 79 + 5 = 84, confirmed by
`grep -c "tests/integration" <extracted body>` = 84 before running).

```
$ DATABASE_URL="postgres://localhost/metasheet2_lock_a3_rb" \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-directory-endpoints.api.test.ts \
    tests/integration/approval-participant-directory.api.test.ts \
    … (84 whole-file args, verbatim from plugin-tests.yml:1615-1698) …
    tests/integration/approval-template-groups-backfill-batches-list.db.test.ts \
    --reporter=dot

 Test Files  84 passed (84)
      Tests  932 passed | 10 skipped (942)
 Duration    139.88s
```
Exit code 0. All 84 files in the required `test (20.x)` approval real-DB step's whole-file argument
list ran and passed, including the 7 approval-template-groups files individually re-verified in
§4 above.

### The other half of the same required check: the no-DB "Run core-backend tests" step

The `test (20.x)` (and `test (18.x)`) required check is a job with multiple steps, not only the
real-DB step above — `.github/workflows/plugin-tests.yml:877-879`'s "Run core-backend tests" step
(`pnpm --filter @metasheet/core-backend test`, no `if:` guard, so it runs on both matrix legs) is
the no-DB vitest lane, and phase1's own precedent verification ran both halves, not just the
real-DB one. `packages/core-backend/package.json`'s `"test"` script is exactly `"vitest"` (already
pinned by `approval-ci-coverage-enumeration.test.ts`'s self-exemption assertion in §4), so the
command below runs that exact script (`pnpm --filter @metasheet/core-backend test`), with two env
values that differ from the bare CI step line because GitHub Actions supplies them ambiently rather
than the step setting them itself: `DATABASE_URL` explicitly unset (so every `describeIfDatabase`
suite takes the same skip branch it does in CI's no-DB job) and `CI=true` set to match the runner's
environment (vitest's watch-vs-run-once behaviour is CI-env sensitive). Both are disclosed here,
not silent substitutions:

```
$ env -u DATABASE_URL CI=true pnpm --filter @metasheet/core-backend test

 Test Files  931 passed | 175 skipped (1106)
      Tests  14718 passed | 1604 skipped (16322)
 Duration    59.53s
```
Exit code 0. 931 passed test files matches phase1's own precedent count exactly ("the no-DB vitest
lane (931 files) green", phase1 verification MD §23). `tests/unit/approval-template-routes.test.ts`
(the unit-lane file that exercises `routes/approvals.ts`, the file phase1's rebased-in commit
changed by 43 lines) ran and passed on the merged tree:
```
$ grep -c "tests/unit/approval-template-routes.test.ts" /tmp/no-db-lane-run.log
30
```
That count establishes the file actually ran (not silently zero-matched). A weaker cross-check —
`grep -cE "^\s*✗|FAIL " /tmp/no-db-lane-run.log` — hits only 4 lines, and every one of them is a
green `✓` test whose own name documents fail-closed behaviour under test (e.g. "both validator
loaders FAIL CLOSED when express-validator cannot be resolved"), not an actual failure; this is a
weak sanity check, not proof of zero failures on its own. The authoritative zero-failure evidence
is the summary line itself — `931 passed | 175 skipped (1106)` accounts for the full file count
with no separate `failed` segment (vitest prints one only when nonzero) — together with exit code
0.

## 6. Scope not touched by this rebase

No DDL was added, removed, or altered by this operation — the one migration file
(`zzzz20260919090000_create_approval_template_group_backfill_batches.ts`) already existed on the
pre-rebase `feat/approval-template-groups-phase2-backfill` tip and is untouched by phase1's commit.
No lock text was read or changed. No PR was opened, merged, or had its status changed. No shared,
staging, or production database was touched — only the private `metasheet2_lock_a3_rb` database
created for this operation.

## 7. Push

`git push --force-with-lease origin feat/approval-template-groups-phase2-backfill` (rebase of this
lane's own branch — permitted exception to the no-force rule) after all of the above went green.
Resulting remote HEAD recorded in the PR/task StructuredOutput.

---

## 8. Second rebase (2026-09-18, gate fix-round 1, `impl-gate-A3-round1-20260918.md` §5 P2)

The gate that reviewed this branch's post-§1–7 tip (`9bda1dbccd8ce7145e2ed88a789f43128ad2de75`)
found that `origin/feat/approval-template-groups-phase1` had advanced 9 more commits past the
`03ee9f4bb` tip this file's §1–7 rebased onto — 4 of those touch `packages/core-backend` or
`scripts` — and that the design-gate Q6(a) condition ("A-1 rebase, not cherry-pick, on any further
A-1 fix round") therefore no longer held on this head. Full detail in the gate report and in
`approval-template-groups-phase2-backfill-verification-20260918.md` §7; this section records only
the git-mechanics half.

- **Pre-rebase HEAD**: `9bda1dbccd8ce7145e2ed88a789f43128ad2de75` (the gate-reviewed SHA).
- **New phase1 tip**: `a789422b516f9e9ab6949c2cc0762a5daabc6be7` (fetched fresh from
  `origin/feat/approval-template-groups-phase1`).
- **Operation**: `git rebase origin/feat/approval-template-groups-phase1`, replaying all 26 commits
  of this lane. **Zero conflicts** — the gate's own prediction (its earliest lane hunk starts at
  `@@ -437,6 +447,338 @@`, outside phase1's `@@ -395,28 +395,42 @@` comment-only hunk) held exactly.
- **Post-rebase HEAD (before this round's two doc corrections)**:
  `ff1e40686659a4ec3c66d3a717643b16e1af50fa`. The final HEAD after this round's doc-only commit(s)
  is the one recorded in git log / the task's StructuredOutput; it is NOT this SHA.
- **Ancestor check**: `git merge-base --is-ancestor origin/feat/approval-template-groups-phase1
  HEAD` → `YES`; `git rev-list --count origin/feat/approval-template-groups-phase1 ^HEAD` → `0`.
- **SHA-drift disclosure**: this second rebase rewrote all 26 of this lane's own commit SHAs a
  second time. Every lane-commit SHA cited anywhere in §1–7 above, in the design MD, or in the
  verification MD from before this round now refers to the PRE-second-rebase lineage — those
  commits are no longer reachable from this branch's `git log` (though individually `git show
  <sha>`-able until a `git gc`). Nothing in §1–7 above was rewritten to chase this; only the
  judgment-bearing anchors (head SHA, phase1-ancestor relationship, the E1–E5 evidence) were
  recomputed fresh, in `…verification-20260918.md` §7.2.
- **Evidence rerun**: E1 (7 real-DB suites, private DB `metasheet2_lock_a3`), E2/E2′/E2″ (full
  no-DB core-backend lane + its 6 census guards + zero-collection check on the 5 new
  `.db.test.ts` files), E3 (both `tsc` invocations), E4 (5 ci-wiring guards + s6a provenance +
  349-test census enumeration), and E5 (s6a sha256 pin vs `pins.json`) were all rerun fresh on the
  rebased tree — see `…verification-20260918.md` §7.2 for the full command/result table. No new
  migration was required (`db:migrate --list` on `metasheet2_lock_a3` reported `Applied: 408,
  Pending: 0` both before and after — phase1's 9 new commits carry zero DDL).
- **Push**: `git push --force-with-lease origin feat/approval-template-groups-phase2-backfill`
  (same permitted exception as §7, applied a second time to this lane's own branch) after this
  round's doc commit(s) and the full evidence rerun above went green.
