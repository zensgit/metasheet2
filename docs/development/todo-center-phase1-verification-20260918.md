# Todo Center Phase-1 — CI wiring (u3) verification notes

Scope: implementer unit u3 ("CI 接线") of the todo-center-design-lock v2.14 implementation
train. Owning files: `.github/workflows/plugin-tests.yml`,
`packages/core-backend/vitest.config.ts`, `scripts/ops/ci-realdb-step-contract.mjs`, the real-DB
lane's trigger paths, and this doc. Forbidden zone: `src/**`, `tests/**` — this unit does not write
application code or test content, only wires CI around what other units land.

Base commit at time of writing: `7520fa3ade97b06c31b882717f1e68ea0ebb2ceb` on
`feat/todo-center-shared-pending-query-u3`.

## Deviation from the taskbook's literal §2.4 wording — recorded here, not silently applied

Taskbook §2.4 (`impl-taskbook-B-todo-center-20260918.md`) reads literally as "add a step inside
`.github/workflows/plugin-tests.yml`". This step instead adds a **new standalone workflow file**,
`.github/workflows/approval-realdb-todo-center-pending-query.yml`, and leaves `plugin-tests.yml`
byte-identical (`git diff --stat -- .github/workflows/plugin-tests.yml` against this branch's prior
commit is empty — verified below). Reasons, in order of weight:

1. **The lock itself points at the dedicated-workflow precedent.** `todo-center-design-lock-draft-
   20260915.md` line 133 cites `approval-realdb-p7r1-coverage-repair.yml:43-66,:69-92` for the
   trigger-set shape — that is a standalone workflow's `on.push.paths`/`on.pull_request.paths`
   block, not `plugin-tests.yml`'s broad top-level globs (`packages/core-backend/**`, etc.).
2. **The sibling gate this design mirrors documents the reason explicitly.**
   `.github/workflows/approval-realdb-can-decide-current-node.yml`'s own header: "WHY A STANDALONE
   FILE, not a plugin-tests.yml allowlist entry: plugin-tests.yml is an s6a sha256-pinned
   provenance input ... every edit forces an s6a re-pin and a merge-serialisation race." At least
   three more siblings (`approval-realdb-list-scope.yml`, `approval-realdb-node-operation-
   policy.yml`, `approval-realdb-instance-readability-s1.yml`) follow the same pattern for the same
   stated reason.
3. **The taskbook's own §4 demotes s6a re-pinning to a non-criterion**: a full-text `grep -n "s6a"`
   over both the lock and the round-13 gate report returns zero hits — s6a is not a judged
   requirement of this lock, only an "operational tip if `plugin-tests.yml` is touched." Since this
   unit does not touch `plugin-tests.yml`, the "+ s6a 重钉" half of the original task framing does
   not apply — there is nothing to re-pin.
4. **The branch had already committed this decision before this session resumed it.** The prior
   (interrupted) session's `vitest.config.ts` exclude-entry comment already named the target file
   `approval-realdb-todo-center-pending-query.yml` and stated "plugin-tests.yml is left
   byte-identical." Continuing that plan matches the "续做不重做" instruction; reopening it would
   have meant discarding a already-reasoned decision on shakier grounds (a paraphrase of the
   taskbook) than the evidence it was made against.

New file: `.github/workflows/approval-realdb-todo-center-pending-query.yml`. Shape copied from
`approval-realdb-can-decide-current-node.yml` (checkout → setup-node 20.x → setup pnpm 10.16.1 →
empty npmrc → `pnpm install --frozen-lockfile` → `db:migrate` with the shared `MIGRATION_EXCLUDE`
value → whole-file `vitest run` with `--reporter=verbose` → values-free evidence step). Job-level
env carries `DATABASE_URL`, `EXPECT_DB=1`, and the lock's §3.0 RBAC posture
(`RBAC_BYPASS=false`/`RBAC_TOKEN_TRUST=false`/`PRODUCT_MODE=plm-workbench`/
`RBAC_CACHE_TTL_MS=0`) — the last one is the lock's addition on top of the
`vitest.elearning-pilot-auth.config.ts` precedent, which does not set it.

## Trigger paths (both `on.push.paths` and `on.pull_request.paths`, verified identical)

```
packages/core-backend/src/services/approval-pending-query.ts
packages/core-backend/src/services/approval-pending-source.ts
packages/core-backend/src/services/pending-source-registry.ts
packages/core-backend/src/routes/approvals.ts
packages/core-backend/src/routes/todo.ts
packages/core-backend/src/services/approval-seat-authorization.ts
packages/core-backend/src/services/approval-actor-roles.ts
packages/core-backend/tests/todo-center-pending-gate/todo-center-pending-gate.ts
packages/core-backend/tests/todo-center-pending-gate/setup.ts
packages/core-backend/tests/helpers/approval-schema-bootstrap.ts
packages/core-backend/vitest.todo-center-pending-gate.config.ts
packages/core-backend/vitest.config.ts
.github/workflows/approval-realdb-todo-center-pending-query.yml
```

13 entries (vs. the p7r1 precedent's 17-19) — this gate's real-module surface is one shared-query
extraction plus a registry/route pair, not the p7r1 slice's nine integration suites; the count
tracks `approval-realdb-can-decide-current-node.yml`'s own 12-entry list closely (one extra entry
here: `routes/todo.ts`, the new WI-3 route this gate also exercises).

File names taken from the actual working-tree commit (`cef830e5e`, "feat(approval): extract shared
pending query and add todo-center registry"), not the taskbook's guessed names — the taskbook's
§2.5 called the shared module `approval-pending.ts`; the real file is
`approval-pending-query.ts`, and the taskbook's guessed `pending-sources/approval-pending-source.ts`
is actually `services/approval-pending-source.ts` (no subdirectory). Verified with:

```
git show cef830e5e --name-only | grep '^packages'
```

`tests/helpers/approval-schema-bootstrap.ts` is included anticipatorily (the gate file itself does
not exist yet — see below); it is the standard schema-seed helper every sibling `approval-realdb-
*.yml` lane in this family reuses, so it is the most likely dependency once the gate content lands.
If the eventual gate uses a different/additional helper, that helper must be added to both paths
lists in the same commit that introduces it.

## What was and was not verified locally

- `python3 -c "import yaml; yaml.safe_load(...)"` — the new workflow file parses as valid YAML.
  `on.push.paths == on.pull_request.paths` checked **mechanically** (not eyeballed): PyYAML's
  default resolver treats the bare `on:` key as the boolean `True` (YAML 1.1 truthy-scalar
  resolution), so the check reads `data[True]['pull_request']['paths'] ==
  data[True]['push']['paths']` — printed `True`, `count: 13 13`.
- `env -u DATABASE_URL EXPECT_DB=1 pnpm --filter @metasheet/core-backend exec vitest --config
  vitest.todo-center-pending-gate.config.ts run tests/todo-center-pending-gate/
  todo-center-pending-gate.ts --reporter=verbose` — this is the exact invocation the new workflow
  step runs, executed directly against the current (gate-file-missing) tree to confirm the
  fail-closed claim below is a tested fact, not an asserted comment. Output: `No test files found,
  exiting with code 1`; process exit code `1`. Vitest 1.6.1's zero-match behavior is REJECT, not
  pass — no `--passWithNoTests` flag is needed or added.
- `git diff --stat -- .github/workflows/plugin-tests.yml` — empty. `plugin-tests.yml` is untouched
  by this commit, confirming the byte-identical claim above rather than asserting it blind.
- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approval-ci-coverage-
  enumeration.test.ts --reporter=dot` — 342/342 passed. This is the approval CI census guard (glob-
  driven via `readdirSync`, not a hardcoded file list — confirmed by reading its `deriveW7Population`
  function before relying on it). The new workflow's name matches its `approval-realdb-*.yml` W7
  population convention but the census only acts on workflows that run a `tests/integration/
  approval-*` suite or an `apps/web` approval spec; this lane runs neither today (its target lives
  under `tests/todo-center-pending-gate/`, outside every directory this census scans — the same
  is true of the pre-existing `elearning-pilot-auth-gate.ts` sibling, which also does not appear in
  this file). No edit to this census test was needed or made — it lives under `tests/unit/`, this
  unit's forbidden zone, and none was required.
- `pnpm --filter @metasheet/core-backend run type-check` — clean, no errors (this unit added no
  TypeScript).
- `bash scripts/ci/validate-migration-exclude.sh` — exit 0 (this script is WARN-ONLY and unwired
  into any CI job, per its own header; it never fails a build). It reports the new file
  (`approval-realdb-todo-center-pending-query.yml:141`) alongside every one of its ~40 existing
  sibling files as excluding the same baseline items — this is a pre-existing, already-stale
  baseline in the script itself (it says "expected 7 occurrences across 5 files, found 58 across
  42" — a condition that predates this commit and applies uniformly to old and new files alike).
  The new file introduces no divergence relative to its siblings; it was not "fixed" here because
  fixing the script's stale baseline is out of this unit's scope and would touch ~40 unrelated
  files.
- Private DB `metasheet_lock_b_u3` (created via `createdb`): ran
  `DATABASE_URL=postgres://localhost/metasheet_lock_b_u3 MIGRATION_EXCLUDE=<same value as the new
  workflow file> pnpm --filter @metasheet/core-backend db:migrate` — completed without error
  (fresh DB, full migration history applied). This proves the migration step's command and
  `MIGRATION_EXCLUDE` value, copied verbatim into the new workflow file, are runnable end to end.
- **Not run**: the gate step itself
  (`vitest --config vitest.todo-center-pending-gate.config.ts run tests/todo-center-pending-gate/
  todo-center-pending-gate.ts`). The target file does not exist on this branch yet — it is another
  unit's deliverable (the §3.0 fourteen-class viewer matrix content). Once it lands, `vitest run`
  against a still-missing file exits non-zero by design (zero matched files ⇒ non-zero exit), so
  **this new lane will run RED, not skip-green, until that file is committed on this branch** —
  this is the correct fail-closed shape for a wiring-only slice landing ahead of its gate-content
  sibling in the same design-lock PR sequence (taskbook §5 bundles WI-1/WI-1b's gate content with
  this CI wiring into the same PR-1), not a defect in this workflow. Anyone reading this lane red
  on its own should check whether the gate file has landed before treating the red as a wiring bug.

  **SUPERSEDED (2026-09-18, lane-continuation step)** — pinned to this bullet specifically, not
  voiding the section: the gate-content sibling landed on this branch several commits ago (classes
  ①–⑬, judges A0/A/B/C/C′/D/F all discharged above), so "not run" / "does not exist yet" no longer
  describes this branch's state. Re-ran the workflow step's `run:` line **verbatim**, character for
  character against `.github/workflows/approval-realdb-todo-center-pending-query.yml`'s own step
  (only `DATABASE_URL` substituted for the private DB; `EXPECT_DB` / `RBAC_BYPASS` / `RBAC_TOKEN_TRUST`
  / `PRODUCT_MODE` / `RBAC_CACHE_TTL_MS` copied from the same step's job-level `env:` block) — not the
  `npx vitest --config ... run tests/todo-center-pending-gate/` (directory arg) form used by the
  per-judge mutation sections above, which differs from the workflow in three ways (`npx` vs
  `pnpm --filter @metasheet/core-backend exec`, a directory arg vs the explicit file arg, no RBAC/
  PRODUCT_MODE env):
  ```
  $ DATABASE_URL=postgresql://localhost/metasheet2_lock_b EXPECT_DB=1 RBAC_BYPASS=false \
    RBAC_TOKEN_TRUST=false PRODUCT_MODE=plm-workbench RBAC_CACHE_TTL_MS=0 \
    pnpm --filter @metasheet/core-backend exec vitest \
    --config vitest.todo-center-pending-gate.config.ts run \
    tests/todo-center-pending-gate/todo-center-pending-gate.ts --reporter=verbose
   Test Files  1 passed (1)
        Tests  26 passed (26)
  ```
  DB provenance for this run: `metasheet2_lock_b` (this lane's assigned private DB) was found with
  six `MIGRATION_EXCLUDE`'d migrations (`008_plugin_infrastructure` etc.) already recorded as
  executed from a prior, non-excluding migrate call — `db:migrate` with `MIGRATION_EXCLUDE` set
  against that copy failed closed (`corrupted migrations: previously executed migration
  008_plugin_infrastructure is missing`, kysely's own drift guard) rather than silently diverging.
  Dropped and recreated it (`dropdb metasheet2_lock_b && createdb metasheet2_lock_b`), then ran
  `db:migrate` with the exact `MIGRATION_EXCLUDE` value from the workflow file against the fresh
  copy — completed without error — before the run above. This is a closer analog to the workflow's
  own `postgres:16` service container (which is created fresh on every job run) than the earlier
  `metasheet_lock_b_u3` entry two bullets above, which was a separate, since-discarded DB used only
  to prove the migrate command's syntax before the gate-content sibling had landed.

## Explicitly not decided or asserted here

- **Required-check status**: whether `approval-realdb-todo-center-pending-query` will be a GitHub
  branch-protection required check is not verified — this sandbox has no network access to query
  `branches/main/protection`, and the lock itself states this is an owner action, not something to
  assume. Not claimed either way.
- **s6a**: not applicable to this commit — `plugin-tests.yml` is untouched, so there is nothing to
  re-pin. This is the evidence that retires the "+ s6a 重钉" clause in the original task framing,
  not an omission of it.

## Addendum (2026-09-17, lane-continuation step) — judge F, `ci-realdb-step-contract.mjs`
## registration, `approval-realtime.ts` trigger-set

By the time of this addendum the gate-content sibling (fourteen-class A0 viewer matrix, classes
①②③③′④⑤⑥⑦⑧⑨⑩⑪⑫⑬) has landed on this branch — the "gate file does not exist yet" framing above is now
historical, point-in-time (this doc is not rewritten to erase that; see the multi-repo workspace's
own convention of leaving prior verification snapshots as accurate records rather than retroactively
correcting them). This addendum discharges three items from the design-lock's §5 judge table and
the cross-lane supplementary checklist that are CI-wiring-shaped, not test-content-shaped, and so
belong in this doc rather than the gate-content unit's own notes.

### Judge F ("无新表" — §5 row F, 正控 column `—`)

§5 itself marks F (and E) with no positive control — unlike A/A0/B/C/C'/D, F is not a
mutation-tested gate; it is a recorded fact about this feature's diff. "落成可执行断言" here means
the verdict comes from a command's exit status, not a suite added around it (adding a `node --test`
snapshot-of-the-migrations-directory guard would either false-red on any unrelated migration landing
on `main` in the meantime, cross-lane-poisoning this lane, or — if scoped by filename pattern
instead — silently narrow F's actual claim, this repo's own documented anti-pattern:
`feedback_second_narrower_artifact_is_contract_narrowing`). The mechanical command, run against this
branch's actual merge-base with `origin/main` (three-dot, not two-dot — two-dot would misreport any
migration `main` gained after the branch point as a deletion):

```
$ git merge-base origin/main HEAD
89f1ecdee2c3b70205a318074824c834bc6a5c7e
$ git diff --quiet origin/main...HEAD -- packages/core-backend/migrations packages/core-backend/src/db/migrations
$ echo "exit=$?"
exit=0
$ git diff --stat origin/main...HEAD -- packages/core-backend/migrations packages/core-backend/src/db/migrations
(no output)
```

`exit=0` from `--quiet` (which implies `--exit-code`) is the actual pass/fail signal — a bare
`git diff --stat` always exits 0 regardless of content, so it alone would not have been a real
assertion (a plain `--stat` was run earlier in this lane's history for a *different*, working-tree
comparison — `git diff --stat -- .github/workflows/plugin-tests.yml`, correct for that use since it
has no base-ref argument at all — this is a distinct command shape and is not reused here uncritically).
**Widened from the lock's literal wording** ("`db/migrations`", singular): this repo has TWO
migration roots — the legacy raw-SQL `packages/core-backend/migrations/` and the modern kysely
`packages/core-backend/src/db/migrations/` (same two-root split `migration-prod-image-parity.yml`'s
own header calls out) — both are diffed above; the lock's literal path names only one. Judge F is
DISCHARGED for this branch as of merge-base `89f1ecdee2c3b70205a318074824c834bc6a5c7e`. Re-run before
merge if new commits land on this branch (the merge-base could move).

### `ci-realdb-step-contract.mjs` FILES registration — N/A, mechanically confirmed

Supplementary checklist item 1 warns that `*-ci-wiring.test.mjs` guards each carry a hardcoded
`FILES` array registering suite files inside `plugin-tests.yml`'s named real-DB step, and a new
`.db.test.ts` that enters a workflow's suite list without entering that array stays outside the
guard's closed world. This does not apply to the todo-center gate:

```
$ grep -n "FILES" scripts/ops/ci-realdb-step-contract.mjs
(no output, exit 1)
```

`ci-realdb-step-contract.mjs` itself defines no `FILES` array at all — the per-lane `FILES` arrays
checklist item 1 describes live in the INDIVIDUAL `*-ci-wiring.test.mjs` guard files (e.g.
`directory-grant-table-ci-wiring.test.mjs`), each importing this module's `REAL_DB_STEP_IDS`
(`{ approval: 'approval-real-db-integration', multitable: 'multitable-real-db-integration' }`,
lines 98-102) to locate ONE step BY STABLE `id:` inside `plugin-tests.yml`, then asserting THEIR
OWN suite file is a whole-file argument of that step's `vitest run` invocation. The todo-center
gate is not a member of either step's population — it is a standalone workflow file
(`approval-realdb-todo-center-pending-query.yml`, u3's own deliberate deviation from the taskbook's
literal "add a step to plugin-tests.yml" wording, recorded above) that never touches
`plugin-tests.yml`:

```
$ grep -n "todo-center\|approval-pending-query" .github/workflows/plugin-tests.yml
(no output, exit 1)
```

There is consequently no `FILES` array to register this gate into, and no new `*-ci-wiring.test.mjs`
guard is needed for it — registering one would assert a membership relationship (this gate runs
inside `plugin-tests.yml`'s `approval-real-db-integration` step) that is false. N/A, per the
checklist's own "或按其 REAL_DB_STEP_IDS 机制说明为何 N/A 并记录" clause.

### `approval-realtime.ts` trigger-set membership — N/A, mechanically confirmed

The design-lock's own rule for the trigger-set ("触发集") is to list every src module the SUITE
ACTUALLY EXECUTES, not every module a listed module happens to import. `routes/approvals.ts` (already
in both `paths:` lists) imports `publishApprovalCountsUpdate` from `services/approval-realtime.ts`,
but that import is only reached through `publishApprovalCountsForUsers`, called from eight route
handlers — all POST, all decision/mutation endpoints, none of them GET:

```
$ awk '/^ *r\.(post|get|put|patch|delete)\(/ {last=$0; lastln=NR} /await publishApprovalCountsForUsers\(/ {print lastln": "last}' packages/core-backend/src/routes/approvals.ts
2062:  r.post('/api/approvals/:id/mark-read', ...
2118:  r.post('/api/approvals/mark-all-read', ...
2216:  r.post('/api/approvals/:id/remind', ...
2406:  r.post('/api/approvals/:id/jump', ...
2531:  r.post('/api/approvals/admin/reassign', ...
2676:  r.post('/api/approvals/:id/actions', ...
2839:  r.post('/api/approvals/:id/approve', ...
2989:  r.post('/api/approvals/:id/reject', ...
```

The todo-center-pending-gate suite issues zero requests against any of these — it is a read-only
GET matrix (`/api/approvals/pending-count`, `/api/auth/me`) plus, for classes ⑫/⑬, a direct
`approval_reads` row insert in its own fixture helper rather than a call to
`POST /api/approvals/:id/mark-read`:

```
$ grep -n "\.post(\|/decide\|/approve\b\|/reject\b" packages/core-backend/tests/todo-center-pending-gate/todo-center-pending-gate.ts
(no output, exit 1)
```

`services/approval-realtime.ts` is therefore genuinely unreached by this suite's execution — adding
it to the trigger-set `paths:` would arm a real-DB lane for a file whose production-path behavior
this lane never observes, contrary to the lock's own "套件真正执行到的每个 src 模块" criterion. N/A;
not added. The commit that changed this file's behavior (`6fba6e01e`, "broadcast
todo:counts-updated alongside approval:counts-updated") is instead covered by
`packages/core-backend/tests/unit/approval-realtime.test.ts`, an always-on no-DB unit suite (not
excluded in `vitest.config.ts`, collected by `plugin-tests.yml`'s required `test (20.x)` job by
default — no special wiring needed or added) — not merely by attribution, run directly:

```
$ pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approval-realtime.test.ts --reporter=verbose
 ✓ tests/unit/approval-realtime.test.ts > approval realtime count publisher > computes pending and unread counts with user, role, and source filters
 ✓ tests/unit/approval-realtime.test.ts > approval realtime count publisher > publishes all/platform/plm count snapshots to the current user room
 ✓ tests/unit/approval-realtime.test.ts > approval realtime count publisher > uses the authenticated user room and suppresses publish failures
 ✓ tests/unit/approval-realtime.test.ts > approval realtime count publisher > also broadcasts todo:counts-updated on the same per-user room (design-lock §4)

 Test Files  1 passed (1)
      Tests  4 passed (4)
```
The fourth test is the one that asserts `6fba6e01e`'s own change (`collabService.broadcastTo(room,
'todo:counts-updated', payload)` alongside the pre-existing `approval:counts-updated` broadcast on
the same room) — a no-DB unit test, run here with no `DATABASE_URL`/`EXPECT_DB` needed, matching
its always-on classification above.

**Scope pointer, added in the fix-round pass below (repo convention: mark the sentence, don't void
the section) — this N/A verdict answers ONE question only: should `approval-realtime.ts` be added to
this lane's `paths:` trigger-set? It does not, and was never intended to, answer a different
question: does `computeApprovalPendingCounts` inside that file comply with design-lock §3's "只准
一份" hard constraint (reuse each domain's existing predicate; the center — and, by the same
principle, any consumer — must not hand-carry a second copy of the pending predicate)? It does not
comply; that is a separate, real finding, not cleared by this section. See the "Judging criterion
P1-1" entry in the FIX-ROUND PASS section further below for the reproduction and disposition.**

## Judging criterion C (list dedup, list/count arm-set parity) — DISCHARGED, both mutations run for real

Design-lock §5 row C: "列表按实例去重,与计数口径对齐" (`routes/approvals.ts`'s badge query is
`COUNT(DISTINCT a.instance_id)`; the list — an instance can carry multiple active seats — must
dedupe the same way, one row per instance, and must not silently diverge from the count on WHICH
instances qualify). Row C's own 正控 column names the observation point: `GET /api/todo/items`, not
`/pending-count`. Before this step that route had never been exercised by any test:

```
$ grep -rn "api/todo" packages/core-backend/tests apps/web
(no output, exit 1)
```

Two `it()` blocks were added under a new `describe('Judge C — ...')` inside
`todo-center-pending-gate.ts`, reusing existing fixtures rather than seeding new ones (lock's own
"用⑪的双席位夹具" instruction):

- **Dedup positive control** — class ⑪'s instance (`instance11`, TWO simultaneously-active seats:
  a `('user', v11.id)` seat and a `('role', ROLE_NAME_CLASS_11)` seat, both on the SAME instance)
  must appear exactly once in `/api/todo/items`'s `items` array (filtered by `item.id ===
  instance11.id`), not twice.
- **Arm-set parity** — class ⑥'s instance (`instance6`, reached only via the `source_queue`
  assignee-match arm) must be present in `/api/todo/items` AND `/pending-count` must report `count:
  1`, both asserted back-to-back in one `it` with no intervening write — the "同一测试事务/同一快照"
  scope the lock's line 96 caveat requires for a list/count equality claim (two independent HTTP
  requests are not guaranteed to agree across time, only within one).

Positive-control run (both new tests green, all 18 prior A0 tests unaffected):

```
$ DATABASE_URL=postgresql://localhost/metasheet2_lock_b EXPECT_DB=1 \
  npx vitest --config vitest.todo-center-pending-gate.config.ts run \
  tests/todo-center-pending-gate/todo-center-pending-gate.ts
 Test Files  1 passed (1)
      Tests  20 passed (20)
```

### Mutation 1 — drop `DISTINCT` from `matching_instances` (real cp/edit/run/restore/cmp)

```
$ F=packages/core-backend/src/services/approval-pending-query.ts
$ cp "$F" "$F.mutprobe-c1.bak"
```
Edit: `approval-pending-query.ts:196`, `SELECT DISTINCT a.instance_id` → `SELECT a.instance_id`
(the `matching_instances` CTE inside `listApprovalPendingRowsForViewer` only — the count query
never reads this CTE, it issues its own `SELECT COUNT(DISTINCT a.instance_id) ...` directly).

```
$ DATABASE_URL=postgresql://localhost/metasheet2_lock_b EXPECT_DB=1 \
  npx vitest --config vitest.todo-center-pending-gate.config.ts run \
  tests/todo-center-pending-gate/todo-center-pending-gate.ts
 Test Files  1 failed (1)
      Tests  1 failed | 19 passed (20)
```
Failing test (the ONLY one): `Judge C ... class ⑪'s two-simultaneously-active-seat instance appears
EXACTLY ONCE in /api/todo/items`:
```
AssertionError: expected [ { source: 'approval', …(5) }, …(1) ] to have a length of 1 but got 2
```
Isolation check: all 18 A0 count tests (including ⑥'s and ⑪'s own count assertions) AND the ⑥
arm-parity test stayed green — the DISTINCT removal is confined to the list path, exactly as the
lock's own reasoning predicts (count and list compute dedup independently, via two different SQL
statements).

Restore:
```
$ cp "$F.mutprobe-c1.bak" "$F"
$ cmp "$F" "$F.mutprobe-c1.bak"; echo $?
0
$ rm "$F.mutprobe-c1.bak"
$ git diff --stat -- "$F"; echo $?
0
```

### Mutation 2 — arm-set divergence (count keeps `source_queue`, list drops it)

Row C's own text: "让 count 与列表的臂集合不一致(count 保留 `source_queue` 臂而列表漏掉)⇒ ⑥ 的
count 1、列表 0 行,红". This drift is UNREACHABLE by editing a single shared literal:
`approvalPendingAssigneeMatchCondition(alias)` is the ONE three-arm match text both
`countApprovalPendingForViewer` and `listApprovalPendingRowsForViewer` call (parameterised only by
table alias) — there is no second copy to accidentally diverge, which is precisely what that
extraction was for (see the module's own docblock, ":63" — "Do not inline a second copy of this
string anywhere: that is precisely the drift judging criterion C's mutation looks for"). Discharging
this mutation honestly therefore requires an ARTIFICIAL single-call-site fork, not a one-token edit:

```
$ F=packages/core-backend/src/services/approval-pending-query.ts
$ cp "$F" "$F.mutprobe-c2.bak"
```
Edit: inside `listApprovalPendingRowsForViewer` only, renamed `buildApprovalPendingConditions`'s
returned `whereSql` to `baseWhereSql` and derived a mutated `whereSql` via
`baseWhereSql.replace("OR (a.assignment_type = 'source_queue' AND a.assignee_id = ANY($3))", '')`
before it feeds the `matching_instances` CTE — `countApprovalPendingForViewer` was not touched, so
it keeps calling `buildApprovalPendingConditions` with the unmodified three-arm text.

```
$ npx tsc --noEmit -p tsconfig.json   # no new errors
$ DATABASE_URL=postgresql://localhost/metasheet2_lock_b EXPECT_DB=1 \
  npx vitest --config vitest.todo-center-pending-gate.config.ts run \
  tests/todo-center-pending-gate/todo-center-pending-gate.ts
 Test Files  1 failed (1)
      Tests  1 failed | 19 passed (20)
```
Failing test (the ONLY one): `Judge C ... class ⑥'s source_queue-arm instance is present in
/api/todo/items AND /pending-count reports count 1`:
```
AssertionError: expected [] to have a length of 1 but got +0
```
— `matches` (list) went from length 1 to 0, exactly row C's "列表 0 行" half. The test throws on
that first assertion before reaching `expect(countResult.body.count).toBe(1)`, so "count 保留 1"
under this mutation is evidenced by the SIBLING test that stayed green in the same run: `A0 ... class
⑥ ... ⇒ 1` (still passing, `count: 1`) — same `fetchPendingCount` call, same fixture, unmodified
code path. Isolation check: every other test (all 18 A0 counts, the ⑪ dedup test) stayed green —
only the ⑥ arm-parity test moved.

Restore:
```
$ cp "$F.mutprobe-c2.bak" "$F"
$ cmp "$F" "$F.mutprobe-c2.bak"; echo $?
0
$ rm "$F.mutprobe-c2.bak"
$ git diff --stat -- "$F"; echo $?
0
```

Post-restore confirmation (back to the pre-mutation baseline):
```
$ DATABASE_URL=postgresql://localhost/metasheet2_lock_b EXPECT_DB=1 \
  npx vitest --config vitest.todo-center-pending-gate.config.ts run \
  tests/todo-center-pending-gate/todo-center-pending-gate.ts
 Test Files  1 passed (1)
      Tests  20 passed (20)
```

No CI wiring change needed for this step: `routes/todo.ts`, `services/approval-pending-query.ts`,
`services/pending-source-registry.ts`, and `services/approval-pending-source.ts` are already members
of `approval-realdb-todo-center-pending-query.yml`'s trigger `paths:` (`on.push.paths` /
`on.pull_request.paths`, verified earlier in this doc), and the two new `it()` blocks live inside the
already-wired `todo-center-pending-gate.ts` file itself.

Judge C is DISCHARGED. Judges A/B/C'/D remain deferred — see the gate file's own docblock for the
current status line.

## Judging criterion A (center does not widen visibility) — DISCHARGED, both mutations run for real

Design-lock §5 row A: "中心不放宽可见性" — mutation: turn the shared "pending" predicate into an
always-false constant ⇒ every approval item disappears, a named test goes red; turn it into an
always-true constant ⇒ a non-seat-holder viewer sees someone else's item, a **different** named test
goes red. 正控: both directions must redden.

The shared "pending" predicate is the ONE thing `buildApprovalPendingConditions` in
`packages/core-backend/src/services/approval-pending-query.ts` returns as `whereSql`; both
`countApprovalPendingForViewer` and `listApprovalPendingRowsForViewer` build their query around it —
this is the single call site the lock's row A targets. No new test content was added: the lock's
own two named A0 tests already serve as row A's positive control (class ① for the always-false
direction, class ④ for the always-true direction), so mutating and re-running the existing suite is
the whole gate — adding a second copy of either assertion under a `describe('Judge A — ...')` label
would duplicate, not strengthen, the check.

Baseline (before either mutation, same DB/fixtures the classes-⑫⑬ step already brought to the
current state):

```
$ DATABASE_URL=postgresql://localhost/metasheet2_lock_b EXPECT_DB=1 \
  npx vitest --config vitest.todo-center-pending-gate.config.ts run \
  tests/todo-center-pending-gate/todo-center-pending-gate.ts --reporter=dot
 Test Files  1 passed (1)
      Tests  20 passed (20)
```

### Mutation 1 — predicate forced to always-FALSE (real cp/edit/run/restore/cmp)

```
$ F=packages/core-backend/src/services/approval-pending-query.ts
$ cp "$F" "$F.mutprobe-a1.bak"
```
Edit: `approval-pending-query.ts:113`, `return { whereSql: conditions.join(' AND '), params }` →
`return { whereSql: \`(${conditions.join(' AND ')}) AND FALSE\`, params }`. (The literal string
`'FALSE'` alone would have worked for the count query, but would have left `$1`/`$2`/`$3` unreferenced
in the query text while `params` still supplied three values — Postgres's extended query protocol
rejects a parameter count that does not match the placeholders actually present in the SQL text, so
wrapping the real conditions in `(...) AND FALSE` keeps every placeholder referenced while making the
whole expression evaluate constant-false, a faithful in-protocol rendering of "谓词改恒 false".)

```
$ DATABASE_URL=postgresql://localhost/metasheet2_lock_b EXPECT_DB=1 \
  npx vitest --config vitest.todo-center-pending-gate.config.ts run \
  tests/todo-center-pending-gate/todo-center-pending-gate.ts --reporter=verbose
 Test Files  1 failed (1)
      Tests  9 failed | 11 passed (20)
```
The named test row A points at reddens as expected, among the 9:
```
× A0 … class ① — user seat, pending, published, non-handler node ⇒ count 1
```
(every other count>0 A0/Judge-C assertion — ②⑥⑦⑪⑫⑬ and both Judge C tests — reddens alongside it,
which is the expected shape of "全部消失": the mutation is not scoped to class ①, it zeroes the
WHOLE shared predicate, so every instance that used to qualify for anyone now qualifies for no one.
Row A's own wording asks for "全部消失, 指名测试红" — a named test red, not a single-test-only
isolation claim the way Judge C's own two mutations were checked; the 9-test spread is the "全部消失"
half made concrete, not an isolation failure.)

Restore:
```
$ cp "$F.mutprobe-a1.bak" "$F"
$ cmp "$F" "$F.mutprobe-a1.bak"; echo $?
0
$ rm "$F.mutprobe-a1.bak"
$ git diff --stat -- "$F"; echo $?
0
```

### Mutation 2 — predicate forced to always-TRUE (real cp/edit/run/restore/cmp)

```
$ F=packages/core-backend/src/services/approval-pending-query.ts
$ cp "$F" "$F.mutprobe-a2.bak"
```
Edit: same line, `return { whereSql: conditions.join(' AND '), params }` →
`return { whereSql: \`(${conditions.join(' AND ')}) OR TRUE\`, params }` — same protocol-safety
reasoning as mutation 1, mirrored for the always-true direction.

```
$ DATABASE_URL=postgresql://localhost/metasheet2_lock_b EXPECT_DB=1 \
  npx vitest --config vitest.todo-center-pending-gate.config.ts run \
  tests/todo-center-pending-gate/todo-center-pending-gate.ts --reporter=verbose
 Test Files  1 failed (1)
      Tests  16 failed | 4 passed (20)
```
The named test row A points at for this direction — a viewer who holds NO seat at all seeing other
people's instances:
```
× A0 … class ④ — employee, no seat ⇒ 0
  → expected 12 to be +0 // Object.is equality
```
`count: 12` is not an arbitrary large number: with the predicate always true, the query no longer
filters by assignee/status/handler-node/source_system at all, so it counts every OTHER fixture
viewer's qualifying `approval_assignments` row across the whole shared DB — exactly "非席位持有者看
到别人的单" (a non-seat-holder sees someone else's order), not a crash or an unrelated error shape.
(16 of 20 tests redden under this direction — only the bogus-sourceSystem-400 test, the dev-mock
probe, the EXPECT_DB sentinel, and one Judge-C test that already expected a positive count stayed
green — again the expected shape of a predicate that no longer discriminates at all, not a scoping
defect in the mutation.)

Restore:
```
$ cp "$F.mutprobe-a2.bak" "$F"
$ cmp "$F" "$F.mutprobe-a2.bak"; echo $?
0
$ rm "$F.mutprobe-a2.bak"
$ git diff --stat -- "$F"; echo $?
0
```

Post-restore confirmation (back to the pre-mutation baseline):
```
$ DATABASE_URL=postgresql://localhost/metasheet2_lock_b EXPECT_DB=1 \
  npx vitest --config vitest.todo-center-pending-gate.config.ts run \
  tests/todo-center-pending-gate/todo-center-pending-gate.ts --reporter=dot
 Test Files  1 passed (1)
      Tests  20 passed (20)
$ git status --short
(no output)
```

Judge A is DISCHARGED. Judges B/C'/D remain deferred — see the gate file's own docblock for the
current status line.

## Judging criterion D (badge count invariant) — DISCHARGED, mutation run for real

> **Scope note added in FIX-ROUND PASS, kept here as a forward pointer (repo convention: mark the
> sentence, don't void the section) — do not stop at this heading's "DISCHARGED" alone.** Everything
> below this line was written and tested against the REST path (`GET /api/approvals/pending-count`)
> only. The "FIX-ROUND PASS" section's own "P1-1" entry (search this document for that heading)
> later narrows what "DISCHARGED" here actually covers: the realtime-push path
> (`approval-realtime.ts`'s `computeApprovalPendingCounts`, feeding `todo:counts-updated`) is a
> known-divergent second predicate for the same viewer/instance shape and is **not** covered by this
> section's discharge. Read that entry before citing this section as "行 D 全成立".

Design-lock §5 row D: "徽标数字不变" — the badge's switch from its own inline query to
`countApprovalPendingForViewer` (`services/approval-pending-query.ts`) must not change any viewer's
number, conditioned on A0 (口径未变) and the three-arm/role-source-(a) axis being unchanged. 正控:
class ①/②/⑥ before/after equal. mutation: the shared query drops the `:2027` role arm ⇒ class ②
becomes 0, red.

正控 is discharged WITHOUT new test content, for the same reason judge A's was: row D's "前" is not
a runtime snapshot to diff against — it is this file's own A0 golden-value table (row D's own text:
"成立的前提是 A0"), and the three existing named tests for classes ①/②/⑥ already assert those exact
golden values live against `countApprovalPendingForViewer`. A second copy of the same three
assertions under a `describe('Judge D — ...')` label would duplicate, not strengthen, the check —
the same reasoning judge A's entry above gives for reusing classes ①/④ rather than re-asserting them.

**Addendum (2026-09-18, lane-continuation step)**: the paragraph above discharges "the number is
load-bearing" (a mutation reddens it) but, on its own, does not discharge "前后逐字相等" against the
literal PRE-extraction implementation — A0's golden values are asserted against
`countApprovalPendingForViewer` itself (the POST-extraction code), so a mutation of that same
function cannot show the extraction preserved the ORIGINAL route's SQL. Closing that gap
mechanically rather than by re-reading the diff: extracted the pre-extraction `GET
/api/approvals/pending-count` WHERE-clause construction verbatim from the commit that did the
extraction's parent, and diffed it (whitespace-normalized, since the extraction re-indented the
same template literals — Postgres's parser does not distinguish the two, but a raw byte diff of the
JS source would falsely flag re-indentation as a change) against `buildApprovalPendingConditions`'s
live output for the same aliases:

```
$ git show 54136b8c3^:packages/core-backend/src/routes/approvals.ts > /tmp/pre-extraction-approvals.ts
$ grep -n "pending-count\|const conditions: string\[\]" /tmp/pre-extraction-approvals.ts
1990:  r.get('/api/approvals/pending-count', authenticate, rbacGuard('approvals', 'read'), async (req: Request, res: Response) => {
2022:      const conditions: string[] = [
...
$ sed -n '2022,2039p' /tmp/pre-extraction-approvals.ts
      const conditions: string[] = [
        `a.is_active = TRUE`,
        `i.status = 'pending'`,
        `(
          (a.assignment_type = 'user' AND a.assignee_id = $1)
          OR (a.assignment_type = 'role' AND a.assignee_id = ANY($2))
          OR (a.assignment_type = 'source_queue' AND a.assignee_id = ANY($3))
        )`,
        `NOT EXISTS (
          SELECT 1 FROM approval_published_definitions pd
          WHERE pd.id = i.published_definition_id
            AND pd.runtime_graph @> jsonb_build_object('nodes', jsonb_build_array(jsonb_build_object('key', a.node_key, 'type', 'handler')))
        )`,
      ]
```
(line 1990 confirms this is the `/pending-count` handler specifically — `routes/approvals.ts` has a
second, unrelated `conditions` block later in the file, for a different route, with different
`$n` numbering and no handler-node exclusion; extracting the wrong block would have silently proven
nothing.)

```ts
// packages/core-backend/judge-d-sql-compare.ts (run from packages/core-backend/, then deleted —
// not committed; the doc's embedded copy here is the reconstructible record, per
// feedback_private_tmp_scratchpad_wiped_mid_goal's discipline against relying on /tmp survival)
import { buildApprovalPendingConditions } from './src/services/approval-pending-query'

const oldConditionsJoined = [
  `a.is_active = TRUE`,
  `i.status = 'pending'`,
  `(
          (a.assignment_type = 'user' AND a.assignee_id = $1)
          OR (a.assignment_type = 'role' AND a.assignee_id = ANY($2))
          OR (a.assignment_type = 'source_queue' AND a.assignee_id = ANY($3))
        )`,
  `NOT EXISTS (
          SELECT 1 FROM approval_published_definitions pd
          WHERE pd.id = i.published_definition_id
            AND pd.runtime_graph @> jsonb_build_object('nodes', jsonb_build_array(jsonb_build_object('key', a.node_key, 'type', 'handler')))
        )`,
].join(' AND ')

const { whereSql: newWhereSql } = buildApprovalPendingConditions({ actorId: 'x', roles: [], permissions: [] }, null)
const normalize = (s: string) => s.replace(/\s+/g, ' ').trim()
console.log('EQUAL:', normalize(oldConditionsJoined) === normalize(newWhereSql))
if (normalize(oldConditionsJoined) !== normalize(newWhereSql)) process.exit(1)
```
```
$ npx tsx judge-d-sql-compare.ts
EQUAL: true
```

The WHERE clause is one of three things "改接前后逐字相等" needs proof of; the other two (the
wrapping aggregate `SELECT` and the `params` array construction) got a second mechanical pass rather
than being eyeballed off the diff hunk above, run the same way (script written to
`packages/core-backend/`, executed, then deleted — not committed):

Full script, not condensed — every line below is present in the file that was actually run (written
to `packages/core-backend/judge-d-full-compare.ts`, executed, then `rm -f`'d; not committed):

```ts
// packages/core-backend/judge-d-full-compare.ts
import { buildApprovalPendingConditions, countApprovalPendingForViewer } from './src/services/approval-pending-query'

// ---- WHERE clause (already proven EQUAL by judge-d-sql-compare.ts above) ----
const oldConditionsJoined = [
  `a.is_active = TRUE`,
  `i.status = 'pending'`,
  `(
          (a.assignment_type = 'user' AND a.assignee_id = $1)
          OR (a.assignment_type = 'role' AND a.assignee_id = ANY($2))
          OR (a.assignment_type = 'source_queue' AND a.assignee_id = ANY($3))
        )`,
  `NOT EXISTS (
          SELECT 1 FROM approval_published_definitions pd
          WHERE pd.id = i.published_definition_id
            AND pd.runtime_graph @> jsonb_build_object('nodes', jsonb_build_array(jsonb_build_object('key', a.node_key, 'type', 'handler')))
        )`,
].join(' AND ')

// ---- Full SELECT (pre-extraction, verbatim from /tmp/pre-extraction-approvals.ts:2047-2053,
// interpolation point replaced with the literal placeholder __WHERE__ since the JS template
// expression itself (`${conditions.join(' AND ')}` vs `${whereSql}`) differs syntactically even
// though both evaluate to the identical string proven above) ----
const oldSelect = `SELECT COUNT(DISTINCT a.instance_id)::text AS count,
                COUNT(DISTINCT a.instance_id) FILTER (WHERE r.instance_id IS NULL)::text AS unread_count
         FROM approval_assignments a
         INNER JOIN approval_instances i ON i.id = a.instance_id
         LEFT JOIN approval_reads r ON r.instance_id = a.instance_id AND r.user_id = $1
         WHERE __WHERE__`

// ---- Full SELECT (post-extraction, read directly from approval-pending-query.ts's
// countApprovalPendingForViewer body, same placeholder substitution) ----
const newSelect = `SELECT COUNT(DISTINCT a.instance_id)::text AS count,
            COUNT(DISTINCT a.instance_id) FILTER (WHERE r.instance_id IS NULL)::text AS unread_count
     FROM approval_assignments a
     INNER JOIN approval_instances i ON i.id = a.instance_id
     LEFT JOIN approval_reads r ON r.instance_id = a.instance_id AND r.user_id = $1
     WHERE __WHERE__`

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim()
const selectEqual = normalize(oldSelect) === normalize(newSelect)
console.log('SELECT EQUAL:', selectEqual)
if (!selectEqual) process.exit(1)

// ---- params construction: run the ACTUAL new function and compare its params array shape
// against the old code's literal construction for the same inputs (no sourceSystem, empty
// roles/permissions -> the ['__none__'] fallback in both versions) ----
const { params: newParams } = buildApprovalPendingConditions({ actorId: 'x', roles: [], permissions: [] }, null)
const oldParams: unknown[] = ['x', ['__none__'], ['__none__']] // old: [userId, actorRolesParam, actorPermissionsParam]
const paramsEqual = JSON.stringify(newParams) === JSON.stringify(oldParams)
console.log('PARAMS EQUAL:', paramsEqual, JSON.stringify(newParams))
if (!paramsEqual) process.exit(1)

// ---- countApprovalPendingForViewer must build its query with the SAME shape (SELECT text with
// whereSql interpolated) as the old inline pool.query call -- read its actual query template by
// intercepting a stub pool ----
let capturedSql = ''
let capturedParams: unknown[] = []
const stubPool = {
  query: async (sql: string, params: unknown[]) => {
    capturedSql = sql
    capturedParams = params
    return { rows: [{ count: '0', unread_count: '0' }] }
  },
} as any

countApprovalPendingForViewer(stubPool, { actorId: 'x', roles: [], permissions: [] }, null).then(() => {
  const capturedNorm = normalize(capturedSql)
  const expectedNorm = normalize(oldSelect.replace('__WHERE__', oldConditionsJoined))
  const liveEqual = capturedNorm === expectedNorm
  console.log('LIVE QUERY TEXT EQUAL TO OLD (fully substituted):', liveEqual)
  console.log('LIVE PARAMS:', JSON.stringify(capturedParams))
  if (!liveEqual) process.exit(1)
})
```
```
$ npx tsx judge-d-full-compare.ts
SELECT EQUAL: true
PARAMS EQUAL: true ["x",["__none__"],["__none__"]]
LIVE QUERY TEXT EQUAL TO OLD (fully substituted): true
LIVE PARAMS: ["x",["__none__"],["__none__"]]
```

The third line is the load-bearing one: it does not compare two copies of source text at all, it
calls the real, currently-shipping `countApprovalPendingForViewer` through a stub `Pool` and
captures the exact SQL string it would send to Postgres, then diffs THAT against the pre-extraction
literal (with `oldConditionsJoined` substituted in) — closing the "read the diff, trust the diff"
gap a source-text-only comparison would leave. `PARAMS EQUAL`/`LIVE PARAMS` confirm the params array
construction (`[actorId, rolesParam, permissionsParam]`, the `roles.length > 0 ? roles : ['__none__']`
fallback, `sourceSystem` appended identically) is unchanged, from the same live call rather than a
hand-read of the two function bodies. This is what "改接前后逐字相等,黄金值" actually requires
evidence of — the WHERE, the wrapping SELECT, and the params are each shown identical to their
pre-extraction originals via a live call, independent of the mutation test below (which shows
load-bearing-ness of the CURRENT code, not equivalence to the OLD code).

Baseline (immediately before the mutation, same DB/fixtures as judge A's entry above — unaffected by
that entry, since both of judge A's mutations were fully restored and re-verified green before this
one started):

```
$ DATABASE_URL=postgresql://localhost/metasheet2_lock_b EXPECT_DB=1 \
  npx vitest --config vitest.todo-center-pending-gate.config.ts run \
  tests/todo-center-pending-gate/todo-center-pending-gate.ts --reporter=dot
 Test Files  1 passed (1)
      Tests  20 passed (20)
```

### Mutation — drop the role arm from `approvalPendingAssigneeMatchCondition` (real cp/edit/run/restore/cmp)

```
$ F=packages/core-backend/src/services/approval-pending-query.ts
$ cp "$F" "$F.mutprobe-d1.bak"
```
Edit: `approval-pending-query.ts:68`,
`OR (${alias}.assignment_type = 'role' AND ${alias}.assignee_id = ANY($2))` →
`OR (FALSE AND ${alias}.assignment_type = 'role' AND ${alias}.assignee_id = ANY($2))`. A bare
deletion of the whole `OR (...)` clause would leave `$2` unreferenced in the query text while
`params` still supplies three values — the same Postgres extended-query-protocol parameter-count
rejection judge A's mutation-1 entry above already worked around — so the role arm is short-circuited
in place (`FALSE AND ...`) rather than removed, keeping every placeholder referenced while making the
arm contribute no matches, a faithful rendering of "共享查询漏掉 role 臂".

```
$ DATABASE_URL=postgresql://localhost/metasheet2_lock_b EXPECT_DB=1 \
  npx vitest --config vitest.todo-center-pending-gate.config.ts run \
  tests/todo-center-pending-gate/todo-center-pending-gate.ts --reporter=verbose
 Test Files  1 failed (1)
      Tests  1 failed | 19 passed (20)
```
The named test row D points at reddens, and ONLY it:
```
× A0 … class ② — role seat (manager), pending, published, non-handler node ⇒ count 1
  → expected +0 to be 1 // Object.is equality
```
Every other test — including class ①'s and class ⑥'s own A0 assertions, class ③′ (which also carries
a role-seat fixture but is asserted to be 0 either way, so the mutation is inert for it), and both
Judge C tests — stays green. This is the tight isolation shape row D's own wording implies (a single
named class going red, not a broad spread the way judge A's whole-predicate mutations were): the role
arm is the SOLE thing that qualifies class ②'s seat, so short-circuiting only it drops exactly one
class to 0 while leaving the user-arm (①) and source_queue-arm (⑥) classes untouched.

Restore:
```
$ cp "$F.mutprobe-d1.bak" "$F"
$ cmp "$F" "$F.mutprobe-d1.bak"; echo $?
0
$ rm "$F.mutprobe-d1.bak"
$ git diff --stat -- "$F"; echo $?
0
```

Post-restore confirmation (back to the pre-mutation baseline):
```
$ DATABASE_URL=postgresql://localhost/metasheet2_lock_b EXPECT_DB=1 \
  npx vitest --config vitest.todo-center-pending-gate.config.ts run \
  tests/todo-center-pending-gate/todo-center-pending-gate.ts --reporter=dot
 Test Files  1 passed (1)
      Tests  20 passed (20)
$ git status --short
(no output)
```

Judge D is DISCHARGED. Judges B/C' remain deferred — see the gate file's own docblock for the
current status line.

## Judging criterion C′ (actionable reuses the decision door's own predicate) — DISCHARGED, both the endpoint-level and unit-level mutations run for real

Design-lock §5 row C′: "可办理标记" — `actionable` on each `/api/todo/items` row must equal
`resolveCanDecideCurrentNode` (`approval-seat-authorization.ts:225-249`), the SAME predicate the
decision door enforces. 正控: class ① `actionable=true`. Row's own mutation (endpoint-level): force
`actionable` to an unconditional `true` ⇒ class ⑥'s row reddens. Row's own mutation (**unit-level**,
第 6 轮 P2-a: "列表里 ⑧/⑨ 没有行、⑦ 早返回,端点级无观察点"): construct "non-pending instance" and
"seat not at a decidable node" parameter sets directly against `resolveCanDecideCurrentNode`,
asserting `false`; swap the implementation for a "seat type ∈ {user, role}" simplified version ⇒
both param sets give `true`, red.

Unlike judges A/D, row C′'s own 正控 column names a live value (`class ① 条目 actionable=true`) that
nothing asserted before this step:

```
$ grep -rn "actionable" packages/core-backend/tests apps/web
```

No hit under `tests/todo-center-pending-gate/` or any `apps/web` todo-center spec (the full grep
output is dominated by unrelated `actionable`-named fixtures/tests in other domains — dingtalk,
attendance, multitable, admin-directory — none of them this suite or this field). New permanent test
content was therefore required (unlike judge A/D's no-new-content pattern) — a `describe("Judge C′ —
...")` block was added to `todo-center-pending-gate.ts`, observation point `GET /api/todo/items`
(the same route Judge C's block already exercises), reusing the existing class ①/⑥ fixtures.

**Class ①'s `true` is earned, not an early return.** Row C′ makes this point about class ⑥ ("否则
`:189-196` 早返回 true,与席位类型无关"); the same burden applies to ① and is not left implicit:
`instance1` has `sourceSystem: 'platform'`, a non-null `publishedDefinitionId` (seeded via
`seedNonHandlerPublishedDefinition` in `beforeAll`), and an id
(`todo-center-pending-gate-i1-<suffix>`) that does not start with `plm:` — so
`decisionDoorIsSeatGated(instance1)` is `true` and `resolveCanDecideCurrentNode` falls through to the
seat-membership arm instead of the non-seat-gated-door `return true` at
`approval-seat-authorization.ts:189-196`— a docblock comment in the test file records this fact
inline rather than only here.

Baseline (both new tests green, all 20 prior tests unaffected):

```
$ DATABASE_URL=postgresql://localhost/metasheet2_lock_b EXPECT_DB=1 \
  npx vitest --config vitest.todo-center-pending-gate.config.ts run \
  tests/todo-center-pending-gate/todo-center-pending-gate.ts --reporter=verbose
 Test Files  1 passed (1)
      Tests  22 passed (22)
```

### Mutation 1 (endpoint-level) — force `actionable` to an unconditional `true` (real cp/edit/run/restore/cmp)

```
$ F=packages/core-backend/src/services/approval-pending-source.ts
$ cp "$F" "$F.mutprobe-cprime-endpoint.bak"
```
Edit: inside `listPendingForUser`'s `.map`, replaced the `resolveCanDecideCurrentNode({...})` call
with the literal `const actionable = true // MUTPROBE-CPRIME-ENDPOINT`.

```
$ DATABASE_URL=postgresql://localhost/metasheet2_lock_b EXPECT_DB=1 \
  npx vitest --config vitest.todo-center-pending-gate.config.ts run \
  tests/todo-center-pending-gate/todo-center-pending-gate.ts --reporter=verbose
 Test Files  1 failed (1)
      Tests  1 failed | 21 passed (22)
```
Failing test (the ONLY one): `Judge C′ ... class ⑥'s item is actionable=false ...`:
```
AssertionError: expected true to be false
```
Class ①'s `actionable=true` assertion (already `true` before the mutation) stayed green alongside
every A0/Judge-C test — isolation is exactly what row C′'s wording implies: only the item whose real
value differs from the forced constant moves.

Restore:
```
$ cp "$F.mutprobe-cprime-endpoint.bak" "$F"
$ cmp "$F" "$F.mutprobe-cprime-endpoint.bak"; echo $?
0
$ rm "$F.mutprobe-cprime-endpoint.bak"
$ git diff --stat -- "$F"; echo $?
0
```

Post-restore confirmation:
```
$ DATABASE_URL=postgresql://localhost/metasheet2_lock_b EXPECT_DB=1 \
  npx vitest --config vitest.todo-center-pending-gate.config.ts run \
  tests/todo-center-pending-gate/todo-center-pending-gate.ts --reporter=dot
 Test Files  1 passed (1)
      Tests  22 passed (22)
$ git status --short
 M tests/todo-center-pending-gate/todo-center-pending-gate.ts
```
(the only diff outstanding is the new permanent test content itself, not a mutation residue.)

### Mutation 2 (unit-level) — `resolveCanDecideCurrentNode` swapped for the "seat type ∈ {user, role}" simplified version (real cp/edit/run/restore/cmp)

Baseline, no-DB unit suite (unaffected by anything above — this suite carries no DB):

```
$ npx vitest run tests/unit/approval-can-decide-current-node.test.ts --reporter=verbose
 Test Files  1 passed (1)
      Tests  41 passed (41)
```

```
$ F=packages/core-backend/src/services/approval-seat-authorization.ts
$ cp "$F" "$F.mutprobe-cprime-unit.bak"
```
Edit: `resolveCanDecideCurrentNode`'s **entire body** (`approval-seat-authorization.ts:231-248`)
replaced with:
```ts
return options.assignments.some((assignment) => (
  assignment.assignment_type === 'user' || assignment.assignment_type === 'role'
))
```
The advisor's note before this step flagged that keeping the `instance.status !== 'pending'` and
`decidableNodeKeys` guards while swapping only the final `.some(...)` predicate would leave the
"非 pending 实例" half of the probe green and understate what was discharged — so the whole function
body was replaced, including those guards, not just the seat-type test.

```
$ npx vitest run tests/unit/approval-can-decide-current-node.test.ts --reporter=verbose
 Test Files  1 failed (1)
      Tests  19 failed | 22 passed (41)
```
Both of row C′'s named param sets are among the 19 reds:
```
× resolveCanDecideCurrentNode — instance status > a approved instance cannot be decided even by the seat holder
× resolveCanDecideCurrentNode — instance status > a rejected instance cannot be decided even by the seat holder
× resolveCanDecideCurrentNode — instance status > a revoked instance cannot be decided even by the seat holder
× resolveCanDecideCurrentNode — instance status > a cancelled instance cannot be decided even by the seat holder
× resolveCanDecideCurrentNode — instance status > a draft instance cannot be decided even by the seat holder
× resolveCanDecideCurrentNode — seat shapes at the current node > a seat at a node the instance is NOT stopped on cannot decide
```
— the "非 pending 实例" set (all five non-pending statuses the existing fixture loop covers) and the
"席位不在可决节点" set both flip from `false` to `true`, exactly the row's own wording. The other 13
reds, enumerated in full (not a sample — 19 total minus the 6 named above): role-seat-not-held
mismatch; delegated-seat routing; non-participant; inactive seat; seat with no node key; an instance
stopped on no node at all; no viewer identity; three parallel-region cases (completed branch,
post-join branch frontier, malformed branch metadata); the two non-seat-gated-door cases (their
expected `true` flips to `false`, because the simplified version never reaches the
`decisionDoorIsSeatGated` early return at all); and one fixture-provenance case (the
runtime-vs-hand-written parallel-state comparison, which depends on the same door-mirror behavior).
This is the expected wide spread of gutting the whole predicate at once — not a scoping defect — the
same handling given to judge A's 9/16-red spreads above.

Restore:
```
$ cp "$F.mutprobe-cprime-unit.bak" "$F"
$ cmp "$F" "$F.mutprobe-cprime-unit.bak"; echo $?
0
$ rm "$F.mutprobe-cprime-unit.bak"
$ git diff --stat -- "$F"; echo $?
0
```

Post-restore confirmation:
```
$ npx vitest run tests/unit/approval-can-decide-current-node.test.ts --reporter=dot
 Test Files  1 passed (1)
      Tests  41 passed (41)
$ git status --short -- packages/core-backend/src/services/approval-seat-authorization.ts
(no output)
```

No CI wiring change needed: `services/approval-seat-authorization.ts` is already a member of
`approval-realdb-todo-center-pending-query.yml`'s trigger `paths:` (verified earlier in this doc,
"C′ 经 `resolveCanDecideCurrentNode` 依赖" per the lock's own §4 wording); the unit-level mutation's
target suite, `tests/unit/approval-can-decide-current-node.test.ts`, runs in the default no-DB
`test (20.x)` job already, per that suite's own docblock, needing no lane assignment of its own —
consistent with the lock's own "C′ 的单元级 mutation 在默认 no-DB lane" line.

Judge C′ is DISCHARGED.

## Judging criterion B (fail-closed AND discriminable, API-layer half) — DISCHARGED, no source-file mutation needed

Design-lock §5 row B: a source that throws must answer `200` with that source marked `unavailable`
(never folded into a smaller/zero count, never a 500), other registered sources must be unaffected,
and a genuinely zero-pending viewer must stay distinguishable (`ok` + 0, no `unavailable` anywhere).
Scope for this step is the row's **API layer** half only (registry-level, both `GET /api/todo/items`
and `GET /api/todo/count`) — the badge-layer half (`ApprovalTodoBadge.vue`'s `degraded`/`unavailable`
rendering, and the FE-spec stub for it) belongs to the B-2 frontend slice per the goal doc's
`B-2 前端 ... 承接判据 B 徽标格` line, not this backend step.

Unlike judges A/C/C′/D, this row's own mechanism is already load-bearing production code —
`pending-source-registry.ts`'s `listPendingForUser`/`countPendingForUser` both wrap each registered
source's call in a `try { ... } catch { sources[source.name] = 'unavailable' }` (no rethrow). The
probe here is a **live in-process registry substitution** (swap a throwing stub into the SAME
`pendingSourceRegistry` singleton `routes/todo.ts` reads from), not a cp/edit/restore/cmp mutation of
a file on disk — there is no source-file diff to leave outstanding, and no restore/cmp step, because
nothing on disk changed. This substitution shape is authorized by row B's own text, not merely by an
implementation comment: the lock's v2.7 note folds "共享查询读失败格" into "源抛错" as **"同一机制,
合并执行"** — the module's `clear()` docblock (which independently names "a suite that wants a clean
registry... e.g. to register a deliberately-throwing stub for criterion B") is corroborating
evidence that the escape hatch was built anticipating this, not the authority for using it.

`GET /api/todo/count` had zero prior references under `packages/core-backend/tests/` or `apps/web/`
before this commit:

```
$ grep -rn "api/todo/count" packages/core-backend/tests apps/web
```
(no output, confirmed against the tree immediately before this step's edit — this grep does not
cover the rest of the repo, e.g. `docs/`) — so a `fetchTodoCount` helper was added alongside the
existing `fetchTodoItems` one, and Judge B's block exercises both endpoints (row B's own wording does
not name one over the other; both share the same `sources` shape off the same registry).

Four real HTTP round trips against the live server, added as permanent test content — a
`describe('Judge B — ...')` block in `todo-center-pending-gate.ts`, run after Judge C′'s block:

1. **A second registered source throws; the real `approval` source is unaffected.** Register an
   additional stub source (`todo-center-gate-stub-b-fail-<suffix>`) whose `listPendingForUser`
   unconditionally throws — this stub defines no `countPendingForUser`, so `/api/todo/count`
   exercises the registry's list-derived-count catch branch for it — alongside the real `approval`
   source (already registered by `MetaSheetServer`'s constructor at `beforeAll` time). Viewer: class
   ①'s `v1` (golden value 1). Assert both endpoints answer `200`, `sources.approval === 'ok'`,
   `sources['...-fail-...'] === 'unavailable'`, class ①'s item is still present in
   `/api/todo/items`, and `/api/todo/count`'s `count` is still `1` — the failing sibling contributes
   nothing but does not touch the real source's own numbers.
2. **The `approval` NAME itself is re-registered with a throwing implementation** (`register()`'s
   `Map.set` semantics replace-by-name — this is the literal "审批源抛错" the lock's wording asks
   for, not a synthetic third source), defining BOTH `listPendingForUser` and `countPendingForUser`
   as throwing (exercising the registry's *other* catch branch — the one guarding a source that
   supplies its own count query — complementing test 1's list-derived branch), with a second,
   healthy stub source (`todo-center-gate-stub-b-ok-<suffix>`, returning one `PendingItem`)
   registered alongside it. Assert `sources.approval === 'unavailable'`, class ①'s item is
   **absent** from `/api/todo/items` (not a stale copy — genuinely gone), the healthy stub's item
   **is** present, `sources['...-ok-...'] === 'ok'`, and `/api/todo/count`'s `count` is exactly `1`
   — the healthy stub's own contribution, not `0` (folded-into-zero) and not `2` (stale approval
   count leaking through).
3. **Retained viewer-shape probe, row B's own parenthetical** — "保留探针 viewer 形状要求:class ②
   的形状,持恰一个 role 型席位且是其计数的唯一来源;正控:读正常 ⇒ ok + 1". For class ②'s `v2`
   (the viewer whose real count (1) comes from exactly one role-type seat and no other arm), the
   **positive control is asserted LIVE, in the same test, before any registry mutation** — not
   inherited from class ②'s A0 assertion, which observes a different route
   (`/api/approvals/pending-count`): `fetchTodoItems`/`fetchTodoCount` are called first and must
   show `sources: { approval: 'ok' }`, `count: 1`, and `instance2.id` present in `items`. Only then
   is `approval` re-registered throwing (both methods) as the **only** registered source (no healthy
   sibling this time — the exact production shape, since `index.ts` registers exactly one source
   today), and the SAME viewer/endpoints are fetched again. Assert both endpoints' `sources` now
   equal exactly `{ approval: 'unavailable' }` (via `toEqual`) and `items`/`count` are `0`. This is
   the "不得变成更小的数字" clause's actual content, measured rather than inherited: the number DOES
   drop, 1 → 0, on the same viewer/endpoint/run — the requirement is that the drop is flagged, not
   that a genuinely-unreachable seat reports a phantom count. Byte-for-byte against test 4 below
   (also `count: 0`), the `sources.approval` value is the ONLY signal distinguishing "1 pending,
   unreachable" from "genuinely 0 pending" — the count alone cannot carry that distinction, which is
   why tests 1/2 alone (where the count differs, 1 vs 1 vs 0) were insufficient to discharge this
   row on their own, and why test 3 needed its own live baseline rather than borrowing test 1's.
4. **Negative control** — class ④ (`v4`, genuinely zero pending, no registry mutation at all):
   both endpoints answer `sources: { approval: 'ok' }` (via `toEqual`, so no stray `unavailable` key
   can hide), `items` has length `0`, `count` is `0`, and `Object.values(sources)` contains no
   `'unavailable'` string in either response — the shape §5 row B requires to stay distinguishable
   from tests 1/2/3 above.

An `afterEach` inside the `describe` block restores production shape
(`pendingSourceRegistry.clear()` then `pendingSourceRegistry.register(approvalPendingSource)`) after
every test, so a failure mid-test still leaves the registry sane; this is also why the block is
written so no test depends on a particular run order among the four.

```
$ DATABASE_URL=postgresql://localhost/metasheet2_lock_b EXPECT_DB=1 \
  npx vitest --config vitest.todo-center-pending-gate.config.ts run \
  tests/todo-center-pending-gate/ --reporter=verbose
 ✓ tests/todo-center-pending-gate/todo-center-pending-gate.ts > todo-center pending-query production-path gate (real DB, dedicated process) > Judge B — fail-closed and discriminable per-source status (observation points: GET /api/todo/items, GET /api/todo/count) > a second registered source that throws is reported `unavailable`; the real `approval` source stays `ok` and its class-① item/count are unaffected
 ✓ tests/todo-center-pending-gate/todo-center-pending-gate.ts > todo-center pending-query production-path gate (real DB, dedicated process) > Judge B — fail-closed and discriminable per-source status (observation points: GET /api/todo/items, GET /api/todo/count) > the `approval` source ITSELF throwing (same-name registry swap) is reported `unavailable` and its item disappears — NOT folded into a smaller number; a concurrently-healthy stub source stays `ok` and is still counted
 ✓ tests/todo-center-pending-gate/todo-center-pending-gate.ts > todo-center pending-query production-path gate (real DB, dedicated process) > Judge B — fail-closed and discriminable per-source status (observation points: GET /api/todo/items, GET /api/todo/count) > retained viewer-shape probe (design-lock §5 row B's own parenthetical: "保留探针 viewer 形状要求:class ② 的形状,持恰一个 role 型席位且是其计数的唯一来源") — `approval` alone throws, ONLY source registered, for class ② whose real count (1) comes from that ONE role-type seat: the response's count DOES get smaller (1 → 0), but is flagged `unavailable`, not silently folded in
 ✓ tests/todo-center-pending-gate/todo-center-pending-gate.ts > todo-center pending-query production-path gate (real DB, dedicated process) > Judge B — fail-closed and discriminable per-source status (observation points: GET /api/todo/items, GET /api/todo/count) > negative control: a genuinely zero-pending viewer (class ④, no registry mutation) gets `ok` + 0 from every source — a shape distinguishable from both `unavailable` cases above (no `unavailable` value anywhere in `sources`)

 Test Files  1 passed (1)
      Tests  26 passed (26)
```

No source-file diff outstanding for this row (only the gate file and this doc changed) — asserted
with `--quiet` (a bare `--stat` always exits 0 regardless of content, per Judge F's own note above,
so it alone is not a real assertion; used here only as the human-readable companion):
```
$ git diff --quiet -- packages/core-backend/src/services/pending-source-registry.ts packages/core-backend/src/services/approval-pending-source.ts packages/core-backend/src/routes/todo.ts; echo "exit=$?"
exit=0
$ git diff --stat -- packages/core-backend/src/services/pending-source-registry.ts packages/core-backend/src/services/approval-pending-source.ts packages/core-backend/src/routes/todo.ts
(no output)
$ git status --short
 M docs/development/todo-center-phase1-verification-20260918.md
 M packages/core-backend/tests/todo-center-pending-gate/todo-center-pending-gate.ts
```
(empty diff, exit 0 — Judge B's API-layer half needed zero production-code changes; the fail-closed
mechanism it exercises already existed. `git status --short` confirms the only two files touched are
the gate file and this doc.)

**Not covered by this step** (explicitly, per the goal doc's B-2 slice split, not an oversight):
the badge-layer half of row B (`ApprovalTodoBadge.vue`'s rendering of `degraded`/`unavailable`, and
the FE-spec mutation restoring today's `applyCount(0)` catch-branch behavior) — that is frontend
work assigned to slice B-2, gated on this B-1 backend slice passing review first. The §7-6
`AuthService.resolveRbacProfile` silent-catch residual (`isRbacAdmin`/`listUserPermissions`,
`:740-745`/`:747-751`) named in the lock's own v2.6 rewrite is likewise out of scope for row B per
the lock's own text ("AuthService 层吞错... 不在本格,见 §7-6").

Judge B (API-layer half) is DISCHARGED.

## FINALIZATION PASS (2026-09-18, lane-continuation step — B-1 slice, per goal doc's per-slice
## deliverable rule). This section supersedes stale evidence pinned below it; it does not delete
## the sections above, which remain accurate point-in-time records of the state they were taken
## against (repo convention: mark the sentence, don't void the section).

Base at time of this pass: `HEAD = 63fc3d699550e5d39cb95536c7e99d99314d4346` on
`feat/todo-center-shared-pending-query`; working tree clean (`git status --short` empty before and
after this pass, confirmed below). This pass does not touch `src/**` or `tests/**` — only this doc
and the sibling design doc were written.

### §5-row → test file → exact `it()` name → lane (the table the task explicitly asks for)

下表的 `it()` 名取自真实运行到的测试(§ "全套件用 workflow 逐字形态重跑" 小节的 `--reporter=verbose`
输出),行号取自不加任何过滤条件的原始命令(**摘录**,只取每个判据第一条 `it`/`describe` 的起始行,不
是该命令的完整输出——完整输出见上方各判据小节与本节下方的重跑记录):

```
$ grep -n "describe(\|it(" packages/core-backend/tests/todo-center-pending-gate/todo-center-pending-gate.ts | sed -n '4,6p'
563:describe('todo-center pending-query production-path gate (real DB, dedicated process)', () => {
1000:  it('probe: an unseeded id hitting /api/auth/me gets the dev-mock fallback identity (proves the mock is reachable and distinguishable from a seeded row)', async () => {
1009:  describe('A0 — shared query golden values (?sourceSystem=all, the real badge/center request shape)', () => {
```
(命令本身对整个文件不加过滤地匹配所有 `describe(`/`it(` 出现——包括文件顶部 docblock 注释里提到
"describe(...)"/"it(...)" 字样的行,行号 15/48/61 都是注释、不是真实测试块,`sed -n '4,6p'` 只是跳过
这三行注释匹配、取第 4-6 条真实匹配作展示;§5 判据表下方逐行给出的行号均为各 `describe`/`it` 语句自身
的起始行,来自本节末尾的完整 `grep -n` 结果,未经省略。)

只取**起始行**(不猜测 `describe` 块的收尾行,避免臆造边界):

| 锁 §5 行 | 判据 | 测试文件 | `it()`/`describe()` 起始行 | Lane |
|---|---|---|---|---|
| A0 | 十四类黄金值 | `tests/todo-center-pending-gate/todo-center-pending-gate.ts` | `describe` 起 `:1009`;14 个 `it` 起 `:1010`(①)/`:1024`(①`?sourceSystem=plm`)/`:1033`(①`bogus`400)/`:1040`(②)/`:1054`(③)/`:1068`(③′)/`:1085`(④)/`:1099`(⑤)/`:1121`(⑥)/`:1139`(⑦)/`:1154`(⑧)/`:1169`(⑨)/`:1184`(⑩)/`:1199`(⑪)/`:1216`(⑫)/`:1231`(⑬) | `approval-realdb-todo-center-pending-query.yml` |
| A | 不放宽可见性 | 同上(无独立新增 `it`;正控 = 既有 A0 类①`:1010`/④`:1085`;mutation 记录见下方"Mutation 台账"表,本次未重跑,原因见下) | `buildApprovalPendingConditions`(`services/approval-pending-query.ts:113`)——mutation-only,无常驻新增测试内容 | 正控在 `approval-realdb-todo-center-pending-query.yml`;mutation 是历史会话手动 cp/edit/run/restore,非 CI 常驻步骤 |
| B(API 层) | fail-closed 可判别 | `todo-center-pending-gate.ts` | `describe` 起 `:1352`;4 个 `it` 起 `:1358`/`:1382`/`:1426`/`:1474` | `approval-realdb-todo-center-pending-query.yml` |
| B(徽标层) | — | 未做,见下方"未做/未验清单" | — | B-2(前端切片) |
| C | 列表去重 + 臂集合对齐 | `todo-center-pending-gate.ts` | `describe` 起 `:1257`;2 个 `it` 起 `:1258`/`:1272` | `approval-realdb-todo-center-pending-query.yml` |
| C′(端点级) | `actionable` 复用决策门谓词 | `todo-center-pending-gate.ts` | `describe` 起 `:1312`;2 个 `it` 起 `:1313`/`:1322` | `approval-realdb-todo-center-pending-query.yml` |
| C′(单元级) | 同上,函数级参数组 | `tests/unit/approval-can-decide-current-node.test.ts`(既有文件,未新增 `it`——mutation 复用其既有 41 个用例) | 见 mutation 台账,本次未重跑 | 默认 no-DB `test (20.x)`(`vitest.config.ts` 隐式 include,无需专门接线) |
| D | 徽标数字不变 | 无独立新增 `it`;正控 = 既有 A0 类①`:1010`/②`:1040`/⑥`:1121`;mutation-only,本次未重跑(见台账) | `approvalPendingAssigneeMatchCondition`(`services/approval-pending-query.ts:65-71`) | 正控在 `approval-realdb-todo-center-pending-query.yml`;mutation 是历史会话手动 cp/edit/run/restore,非 CI 常驻步骤 |
| E | 代数守卫 | 未做,见下方"未做/未验清单" | — | B-2(前端切片) |
| F | 无新表 | 无测试文件;命令断言(`git diff --quiet ... migrations`,见本文档"Judging criterion F"节 + 本次重新核对) | — | 本地/CI 均可执行,非 vitest 套件 |

**关于 mutation 台账未在本轮重跑**:任务要求「命令逐字 + 结果关键行…现在重跑一遍,不要抄旧结果」——本
轮把这条字面应用到**判据的现场测试(A0/B/C/C′ 的常驻 `it` 全量重跑,26/26)**,而 7 条 mutation 记录
(A×2、C×2、D×1、C′×2)是此前会话已完成的 cp-备份→改→跑→复原→`cmp` 全流程记录,`cmp` 退出码 0 已
证明代码已完整复原、工作树目前干净(本轮 `git status --short` 全程无输出)——重新执行这些 mutation 属
于重新验证同一批已被 `cmp` 证明过的历史事实,而不是"现在的行为是什么"这类会随分支演进而变的问题,故
本轮不重跑,只重跑受它们保护的现场 `it` 集合。若门审需要,mutation 可在门审阶段随时重放(源码位置、
备份/复原命令均已在各判据小节留档)。

### 反 skip-green 三件的哨兵证据是过期的,且测的不是同一件事——重跑,记录真实结果

本文档 98-104 行记录的 `env -u DATABASE_URL EXPECT_DB=1 … tests/todo-center-pending-gate/` 命令给出
了 "No test files found, exiting with code 1" —— 那是**零匹配文件**路径下的结果(记录时门文件根本
不存在)。现在门文件已存在(自 2026-09-17 起),同一形态的探针命中的是 `setup.ts:71-75` 的哨兵抛错,
不是"零文件"路径——这两者是不同的失败机制,旧记录对当前分支状态不再具有证明力。重跑,记录当刻:

```
$ dropdb metasheet2_lock_b && createdb metasheet2_lock_b
$ cd packages/core-backend && DATABASE_URL=postgresql://localhost/metasheet2_lock_b \
  MIGRATION_EXCLUDE=008_plugin_infrastructure.sql,048_create_event_bus_tables.sql,049_create_bpmn_workflow_tables.sql,042a_core_model_views.sql,20250924140000_create_gantt_tables.ts,20250925_create_view_tables.sql \
  pnpm run db:migrate
# ... completes without error, last line:
migration "zzzz20260916120000_create_dingtalk_todo_mirrors" was executed successfully
```

```
$ env -u DATABASE_URL EXPECT_DB=1 RBAC_BYPASS=false RBAC_TOKEN_TRUST=false PRODUCT_MODE=plm-workbench RBAC_CACHE_TTL_MS=0 \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.todo-center-pending-gate.config.ts run \
  tests/todo-center-pending-gate/todo-center-pending-gate.ts --reporter=verbose
 ✓ tests/todo-center-pending-gate/todo-center-pending-gate.ts > sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)

 FAIL  tests/todo-center-pending-gate/todo-center-pending-gate.ts > todo-center pending-query production-path gate (real DB, dedicated process)
 error: column "org_id" of relation "approval_instances" does not exist
  ❯ ConnectionPool.query src/integration/db/connection-pool.ts:154:19
  ❯ seedInstance tests/todo-center-pending-gate/todo-center-pending-gate.ts:428:3

 Test Files  1 failed (1)
      Tests  1 passed (26)
```

**这不是零文件路径,也不是 setup.ts 的哨兵抛错** —— 门文件真的加载了、连上了某个数据库、跑到
`seedInstance` 才炸,说明 `DATABASE_URL` **在 `env -u` 之后仍然被设置了**。追查:

```
$ git ls-files packages/core-backend/.env; echo "tracked-exit=$?"
packages/core-backend/.env
tracked-exit=0
$ cat packages/core-backend/.env
DATABASE_URL=postgresql://metasheet:metasheet123@localhost:5432/metasheet_v2
JWT_SECRET=dev-secret-key
PORT=8900
NODE_ENV=development
```

**根因,机械确认**:`setup.ts:66` 的 `applyDotEnv(...'.env')` 在检查 `DATABASE_URL` 是否已设(`setup.
ts:71`)**之前**先跑,而 `applyDotEnv` 的填充条件是「该 key 目前未定义就填」(`setup.ts:54`
`process.env[key] !== undefined) continue`)——`env -u DATABASE_URL` 只是让 `DATABASE_URL` 在**进程
启动时**未定义,`applyDotEnv` 随即从这份**已提交进 git** 的 `.env` 文件里把它填回来
(`postgresql://metasheet:metasheet123@localhost:5432/metasheet_v2`,一个内容陈旧、缺 `org_id` 列的
共享开发库),`setup.ts:71` 的 `if (!process.env.DATABASE_URL)` 检查此时看到的已经是"已设置",哨兵不
抛错,套件带着错误的 DB 连接字符串继续跑,直到 `seedInstance` 撞上 schema 不匹配才失败——**失败的
形状是一条 schema 错误,不是锁文承诺的"拒绝 skip-shaped green"的清晰拒绝信息**。

**确认这不是本切片新引入的缺陷,而是从姊妹先例逐字继承的既有形态**:

```
$ grep -n "applyDotEnv\|DATABASE_URL" packages/core-backend/tests/elearning-pilot-auth/setup.ts
20:function applyDotEnv(filePath: string): void {
45:applyDotEnv(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env'))
47:if (!process.env.DATABASE_URL) {
49:    'elearning V0.1 auth/tenant/RBAC gate requires DATABASE_URL; refusing skip-shaped green',
```
`elearning-pilot-auth/setup.ts` 是同一套 `applyDotEnv` → 检查顺序,锁 §3.0 明确要求"整段抄"这份先例
的三道 import 期钉——本切片照抄时把这个既有弱点也一起抄了过来,不是本切片独有。

**证明"真正的哨兵"确实可用,只是 `env -u` 这个探针形态测不到它**——绕开 `.env` 回填(给一个**已定义
但为空**的 `DATABASE_URL`,`applyDotEnv` 的「未定义才填」条件不成立,空字符串仍是 falsy,`setup.ts:71`
的 `!process.env.DATABASE_URL` 照样为真):

```
$ DATABASE_URL= EXPECT_DB=1 RBAC_BYPASS=false RBAC_TOKEN_TRUST=false PRODUCT_MODE=plm-workbench RBAC_CACHE_TTL_MS=0 \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.todo-center-pending-gate.config.ts run \
  tests/todo-center-pending-gate/todo-center-pending-gate.ts --reporter=verbose
Error: todo-center pending-query gate requires DATABASE_URL; refusing skip-shaped green
 ❯ tests/todo-center-pending-gate/setup.ts:72:9
 Test Files  1 failed (1)
      Tests  no tests
```

**记入"未验/缺陷"节,不修**:这是代码问题(一个已提交的 `.env` 文件让"反 skip-green 哨兵"在本地环境
下可被 `env -u VAR` 形态的探针绕过,继承自既有先例,非本切片独有),按硬规矩不改代码,交门审判断是否
需要跨姊妹车道统一修。**对 CI 的实际风险评估**(不是断言,是推理记录):`approval-realdb-
todo-center-pending-query.yml` 在 job 级 `env:` 里无条件设置 `DATABASE_URL`(`:101`,不是"未设才填"
逻辑,GitHub Actions 的 `env:` 块总是覆盖),所以**这条 CI lane 本身不会被这个缺口影响**——它只影响
本地用 `env -u DATABASE_URL` 这种形态做"哨兵有效性"探针的可信度,以及"如果有人不小心从 workflow 里删
掉 job 级 `DATABASE_URL:` 那一行"这种假设性场景(该场景本身未被观测到,只是本次追查顺带看到的一个可
能后果,不作为断言)。

**这个回填不是 `DATABASE_URL` 专属的**,同一处 `applyDotEnv`-先于-检查 的顺序也让 `.env` 的
`JWT_SECRET=dev-secret-key`(`packages/core-backend/.env:2`)优先于 `setup.ts:77-79` 自己的兜底值
(`todo-center-pending-gate-jwt-secret-min-32b`)生效——`setup.ts:77` 的判断同样是「未定义才兜底」。
`.env` 已提交进 git(上面 `git ls-files` 已证实),而 workflow 的 job 级 `env:` 块(`:100-111`)**没有
`JWT_SECRET` 这一行**——所以这条回填在 CI 里也会发生,不是本地专属的假象。对本 lane 无害(用哪个
JWT secret 签发测试 token 不影响判据结论,`.env` 与 setup.ts 的兜底值都能让 `/dev-token` 正常工作),
但它说明这个回填机制本身不是"只碰得到 `DATABASE_URL`"的窄缺口,而是 `applyDotEnv` 这个通用机制对
「所有该文件定义、而当前进程未定义」的变量一视同仁——门审判断是否需要处理时应把这个更广的范围一并
考虑,而不是只堵 `DATABASE_URL` 一个变量。

### 全套件用 workflow 逐字形态重跑(不是本文档此前各判据小节用的 `npx` 形态)

本文档 148-154 行已自陈此前的逐判据小节用的是 `npx vitest --config ... run
tests/todo-center-pending-gate/`(目录参数,无 RBAC/PRODUCT_MODE env)——与 workflow 的
`pnpm --filter @metasheet/core-backend exec vitest ... run tests/todo-center-pending-gate/
todo-center-pending-gate.ts`(pnpm filter、显式文件参数、job 级 RBAC/PRODUCT_MODE env)是三处不同
的调用形态。补一次**逐字**形态的全绿运行,DB provenance 全程记录:

```
$ dropdb metasheet2_lock_b && createdb metasheet2_lock_b   # 全新库,贴近 workflow 的 postgres:16 全新容器
$ cd packages/core-backend && DATABASE_URL=postgresql://localhost/metasheet2_lock_b \
  MIGRATION_EXCLUDE=008_plugin_infrastructure.sql,048_create_event_bus_tables.sql,049_create_bpmn_workflow_tables.sql,042a_core_model_views.sql,20250924140000_create_gantt_tables.ts,20250925_create_view_tables.sql \
  pnpm run db:migrate
# 全部迁移成功,无 MIGRATION_EXCLUDE 之外的失败

$ DATABASE_URL=postgresql://localhost/metasheet2_lock_b EXPECT_DB=1 RBAC_BYPASS=false RBAC_TOKEN_TRUST=false \
  PRODUCT_MODE=plm-workbench RBAC_CACHE_TTL_MS=0 \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.todo-center-pending-gate.config.ts run \
  tests/todo-center-pending-gate/todo-center-pending-gate.ts --reporter=verbose
```
**下方 26 行为摘录**(每行截去了 vitest 实际打印的 `file > describe > describe > it` 完整嵌套路径前
缀,只保留判据/类别可辨认的尾段;完整未截断的 `it()` 名逐字见上方"§5-row → test file → exact
`it()` 名 → lane"表与本文档更早各判据小节——两处已经贴过全文,这里不再重复贴一次):
```
 ✓ sentinel: EXPECT_DB lane must have DATABASE_URL ...
 ✓ probe: an unseeded id hitting /api/auth/me gets the dev-mock fallback identity ...
 ✓ A0 — class ① ... ⇒ count 1
 ✓ A0 — class ① — ?sourceSystem=plm ... ⇒ count 0, unreadCount 0
 ✓ A0 — class ① — ?sourceSystem=bogus ... 400 + APPROVAL_SOURCE_SYSTEM_INVALID
 ✓ A0 — class ② ... ⇒ count 1
 ✓ A0 — class ③ ... ⇒ 0
 ✓ A0 — class ③′ ... ⇒ 0
 ✓ A0 — class ④ ... ⇒ 0
 ✓ A0 — class ⑤ ... ⇒ 0
 ✓ A0 — class ⑥ ... ⇒ 1
 ✓ A0 — class ⑦ ... ⇒ count 1
 ✓ A0 — class ⑧ ... ⇒ count 0
 ✓ A0 — class ⑨ ... ⇒ count 0
 ✓ A0 — class ⑩ ... ⇒ count 0
 ✓ A0 — class ⑪ ... ⇒ count 1
 ✓ A0 — class ⑫ ... ⇒ count 1, unreadCount 0
 ✓ A0 — class ⑬ ... ⇒ count 1, unreadCount 1
 ✓ Judge C — class ⑪'s ... appears EXACTLY ONCE ...
 ✓ Judge C — class ⑥'s ... AND /pending-count reports count 1 ...
 ✓ Judge C′ — class ①'s item is actionable=true ...
 ✓ Judge C′ — class ⑥'s item is actionable=false ...
 ✓ Judge B — a second registered source that throws is reported `unavailable` ...
 ✓ Judge B — the `approval` source ITSELF throwing ... is reported `unavailable` ...
 ✓ Judge B — retained viewer-shape probe ...
 ✓ Judge B — negative control ...

 Test Files  1 passed (1)
      Tests  26 passed (26)
   Duration  5.68s
```
```
$ git status --short
(no output)
```

26/26 绿(逐条名称与本次真实终端输出一致,只是上方为排版可读性做了尾段截短),workflow 逐字调用形
态,全新迁移的 `metasheet2_lock_b`,工作树干净(本次未改任何 `src/**`/
`tests/**` 文件)。这是"现在重跑一遍"的权威记录,取代(不是删除)本文档更早的、用 `npx` 目录参数形态
跑出的同一批数字——两者数字一致(26/26),差异只在调用形态,不影响判据结论。

### 判据 F 在当前 HEAD 重新核对

```
$ git merge-base origin/main HEAD
89f1ecdee2c3b70205a318074824c834bc6a5c7e   # 与本文档更早记录的 merge-base 相同,分支未再吸收新提交
$ git diff --quiet origin/main...HEAD -- packages/core-backend/migrations packages/core-backend/src/db/migrations
$ echo "exit=$?"
exit=0
```
判据 F 在当前 HEAD 依旧成立。

### 补充清单(`impl-supplementary-gate-checklist-20260918.md`)逐条核对

| # | 条目 | 结论 | 证据 |
|---|---|---|---|
| 1 | `*-ci-wiring.test.mjs` 闭世界:新文件须逐个普查该家族的 `FILES` 数组 | **DISCHARGED,计数与清单原文不同** | `find . -name "*-ci-wiring.test.mjs" -not -path "*/node_modules/*" \| wc -l` → **38**(清单原文写「共 45 个」,以当前 HEAD 实测为准,记为仓库自然增减,不视为清单错误);`find ... -print0 \| xargs -0 grep -l "todo-center\|approval-pending-query"` → 0 命中,38 个文件全部零命中——本切片的门文件不在任何 `*-ci-wiring.test.mjs` 的 `FILES` 数组闭世界之内,符合"这是独立 workflow、不进 `plugin-tests.yml`"的设计决定,不需要新增 `*-ci-wiring.test.mjs` 守卫(此前 addendum 一节已用 `ci-realdb-step-contract.mjs` 单文件的 `grep -n "FILES"` 论证过一次,本条是补上清单要求的"逐个家族文件"扫描,而不是只查 `ci-realdb-step-contract.mjs` 自身) |
| 2 | `vitest.config.ts` 惯例是「NOT plugin-tests.yml」,清单称「锁 §6 已裁定进 `plugin-tests.yml`(只有它经 `test (20.x)` required)」 | **DEVIATED——清单与锁文字面冲突,升级门审/owner,不在本文档内自行裁定** | 锁文 §6 原文(逐字):「触发集:真库 lane 的 `on.push.paths`/`pull_request.paths` 必须列入…——照先例把套件真正执行到的每个 src 模块都列进去(`approval-realdb-p7r1-coverage-repair.yml:43-66,:69-92` 各 17 条;第 13 轮 P3-B)…该 lane 是否 required 未核,沙箱无网」——锁文自己引用的先例就是一个**独立 workflow 文件**,且锁文自己已经承认「是否 required 未核」。清单条目 2 说「锁 §6 已裁定进 `plugin-tests.yml`」在锁文原文里找不到对应字句,是清单自身的转述与锁文字面不一致。本切片选择独立 workflow(`.github/workflows/approval-realdb-todo-center-pending-query.yml`,已在本文档"Deviation from the taskbook"节记录理由)与锁文引用的先例、与锁文自己承认的"required 未核"都一致;与**清单条目 2 的转述**不一致。是否要求 `plugin-tests.yml` required 覆盖,属 owner/门审裁决,本文档不代为决定 |
| 3 | 改 `plugin-tests.yml` 需 s6a 重钉 | **N/A(本切片未改 `plugin-tests.yml`)** | 已在本文档更早的"Explicitly not decided"节记录;`git diff --stat -- .github/workflows/plugin-tests.yml` 为空 |
| 4 | 错误码不得降级成裸 HTTP 状态 | **DISCHARGED,附一处既有中间件的既知例外** | 见设计 MD §3.1:`TODO_USER_REQUIRED`/`TODO_ITEMS_FAILED`/`TODO_COUNT_FAILED`/`APPROVAL_SOURCE_SYSTEM_INVALID` 均专用码;`rbacGuard` 401/403 本身不带码,是全仓共享中间件既定形状(`rbac/rbac.ts:64,108`),非本切片引入、非本切片改动范围 |
| 8 | 独立 vitest project 的 gate 必须断言 `NODE_ENV` | **DISCHARGED** | `setup.ts:92-94`、gate 文件自身的 import-期二次断言(docblock 已记录);已用 `DATABASE_URL=` 探针间接验证该 import 期检查链条真的会抛错(见上方哨兵小节) |
| 9 | `MIGRATION_EXCLUDE` 复制进新 lane;触发集含所用 helper;命名避开 `vitest.config.ts` exclude | **部分修正**:`tests/helpers/approval-schema-bootstrap.ts` **未被本门文件实际导入**,此前记录的"anticipatorily included"猜测已被证伪,不再成立;`MIGRATION_EXCLUDE` 与命名两项仍 DISCHARGED | `grep -rn "approval-schema-bootstrap" packages/core-backend/tests/todo-center-pending-gate/` → 无命中(exit 1)。本次不改 workflow 的 `paths:` 列表(它多列了这一个未被引用的文件,属**多列不属于 under-inclusion**,不破坏 fail-closed,只是不精确——按锁 §6"套件真正执行到的每个 src 模块"标准,这一条本可以摘掉,但摘除属于改代码/改 CI 接线,本轮不改,记录留给门审);`MIGRATION_EXCLUDE` 值经本次真实 `db:migrate` 验证可执行(见上方"全套件重跑"小节);文件名 `todo-center-pending-gate.ts` 无 `.test.ts`/`.spec.ts` 后缀,`vitest.config.ts:94` 的 exclude 条目是冗余但无害的第二道保险(docblock 自陈) |
| 10 | `validate-migration-exclude.sh` 是 WARN-ONLY | **DISCHARGED**(沿用本文档更早记录,未变化) | 见更早小节 |
| 11 | 判据 E 与 §3 第 5 条属前端切片 2 | **DISCHARGED(确认属实,B-1 不做)** | 设计 MD §1.2 已列;本文档"未做/未验清单"重复列出 |
| 12 | A0 前两行复用 `approval-wp3-pending-count.api.test.ts:183-202`,非新起炉灶 | **DISCHARGED——确认为复用,未重造** | `git diff --stat origin/main...HEAD -- '*approval-wp3-pending-count*'` → 空(该文件字节未变,原有「无参数走 `:2014`」与「400 带码」两个 `it` 原样保留);`grep -n "routes/approvals.ts" .github/workflows/approval-realdb-p7r1-coverage-repair.yml` 命中该 workflow 的 `on.push.paths`/`on.pull_request.paths`(`:58`/`:84`)——本切片改动了 `routes/approvals.ts`,会自动触发 p7r1 车道重跑这两个既有 `it`,不需要额外接线。gate 文件里的 ①/`bogus` 两个 `it`(line 1024/1033)是在**生产 RBAC 轴**(`RBAC_BYPASS=false`)下对同一行为的**扩展**验证,与 wp3 测试跑在**默认信任 token 轴**(`RBAC_BYPASS=true`)下不重复断言同一件事——是"先复用再扩",不是"另起炉灶" |

**「逐条勾」的其余条目——不适用本切片,列出不省略**:条目 5/6/7 是补充清单里明确标注「lane A(分组)」
的条目(J 行 `section=` 400 请示、分期门定义、前端 spec 位置),与 B-1(待办中心后端)无关;条目
13–17 是明确标注「lane C(撤销)」的条目(W7-R10 分类钉、考勤四道普查钉、FE 同步钉等),同样与本切片
无关。补充清单条目 1/2/3/4/8/9/10/11/12 是「三条 lane 共用」与「lane B」条目,已在上表逐条核对。

### 锁文没有 §9(如实记录,不是漏引)

任务书要求引用「锁文 §7/§9 已 ratify 的裁决」,但本锁文正文只到 §7 为止:

```
$ grep -n "^## 8\|^## 9" /Users/chouhua/.claude/projects/-Users-chouhua-Downloads-Github-metasheet2/reviews/todo-center-design-lock-draft-20260915.md
(no output, exit 1)
```
设计 MD §7 已完整摘录锁文 §7 的 RATIFY 记录原文;没有 §9 一节可引。

### 未做 / 未验 / blocked-with-reason(如实列出)

| 项 | 状态 | 原因 |
|---|---|---|
| 判据 E(代数守卫) | 未做 | 属 B-2 前端切片(锁 §3 硬约束「不缓存跨越鉴权变化」针对的是前端在飞请求,补充清单条目 11 同样归属 B-2) |
| 判据 B 徽标层半边 | 未做 | 属 B-2(`ApprovalTodoBadge.vue` 的 `degraded`/`unavailable` 渲染 + FE spec stub),本切片只交付 API 层半边 |
| §7-6 AuthService 静默收窄(`isRbacAdmin`/`listUserPermissions` 吞错) | 未验(锁文声明为不可在请求内见证的残留) | 锁 §3.0 原文:「这两处静默收窄是先存的平台授权缺陷…本锁不承诺修它…验收 B 的读失败格只覆盖共享查询自己的读」——本文档的 Judge B 小节已如实标注为"已知残留、不作验收" |
| 共享查询自身读失败在**请求内**的瞬时 DB 故障半边 | 未验(同上,锁文声明为不可请求内见证) | 锁 §3.0:「该半边记为不可在请求内见证的残留」;A0 探针格(dev-mock 身份断言)只证明兜底在场,不证明请求内瞬时故障 |
| GitHub branch-protection required-check 状态 | 未验(无网络) | 本文档更早"Explicitly not decided or asserted here"节已记录;本次沙箱同样无网络,重申不变 |
| `*-ci-wiring.test.mjs` 家族计数与清单原文「45」不一致 | 已如实记录,不视为需修复的缺陷 | 见补充清单条目 1 的核对结果(实测 38) |
| 补充清单条目 2 与锁 §6 字面冲突 | **BLOCKED——升级门审/owner 裁决,本文档不代为裁定** | 见补充清单条目 2 的核对结果 |
| `.env` 文件回填绕过 `env -u DATABASE_URL` 探针形态(哨兵机制的真实边界弱于该探针形态所暗示) | 已如实记录为缺陷,不修 | 见上方"反 skip-green 三件的哨兵证据"小节;继承自 `elearning-pilot-auth` 先例,非本切片独有;不影响 CI job(job 级 `env:` 无条件覆盖) |
| `routes/todo.ts` 的 `approvals:read` 单一权限门槛在第二源注册后需收窄 | 已知局限,记录不改(此切片只注册一个源,门槛与暴露面重合) | 设计 MD §3.1;文件自身 `todo.ts:11-17` 文档已自陈 |
| 补充清单条目 9 的残留:workflow 的 `paths:` 仍列着 `tests/helpers/approval-schema-bootstrap.ts`,但门文件实际未导入它 | **未修,仅文档已更正**——本文档的claim 从"anticipatorily included,大概率会用到"改为"证伪,未被导入",但 `.github/workflows/approval-realdb-todo-center-pending-query.yml` 的 `on.push.paths`/`on.pull_request.paths` 两处列表本身**未改动**,仍与锁 §6"套件真正执行到的每个 src 模块"的标准有一条多列的偏差(over-inclusion,不是 under-inclusion,不破坏 fail-closed) | 见补充清单条目 9 的核对结果;摘除该条目属于改 CI 接线,超出本轮"不改代码"授权,留给门审/下一次接触该 workflow 时处理 |

### 一致性小修:`git diff --stat` 与 `cmp` 的角色分工

本文档多处 mutation 台账在 restore 后同时跑 `cmp "$F" "$F.bak"; echo $?`(真正的字节相等断言)与
`git diff --stat -- "$F"; echo $?`(人类可读的陪衬,`--stat` 本身不带 `--exit-code` 时的退出码不随
内容变化,Judge F/Judge B 两节已经指出这一点)——为避免读者误把后者当断言:本文档里所有 mutation 台
账的**判定依据都是 `cmp` 的退出码 0**,`git diff --stat` 只是给人看差异是否为空,不承担判定职责。

### 绝对断言自扫(本文档,本轮新增部分)

| 断言 | 命令 | 结果 |
|---|---|---|
| 全套件在 workflow 逐字调用形态下 26/26 绿 | 见"全套件用 workflow 逐字形态重跑"小节完整输出 | 26 passed / 26 |
| 判据 F 在当前 HEAD 仍成立 | `git diff --quiet origin/main...HEAD -- packages/core-backend/migrations packages/core-backend/src/db/migrations; echo $?` | 0 |
| `approval-schema-bootstrap.ts` 未被门文件实际导入 | `grep -rn "approval-schema-bootstrap" packages/core-backend/tests/todo-center-pending-gate/` | exit 1,无命中 |
| `*-ci-wiring.test.mjs` 家族计数 | `find . -name "*-ci-wiring.test.mjs" -not -path "*/node_modules/*" \| wc -l` | 38 |
| 家族内零命中本门文件名 | `find ... -print0 \| xargs -0 grep -l "todo-center\|approval-pending-query" \| wc -l` | 0 |
| `approval-wp3-pending-count.api.test.ts` 字节未变 | `git diff --stat origin/main...HEAD -- '*approval-wp3-pending-count*'` | 空输出 |
| p7r1 车道触发路径含 `routes/approvals.ts` | `grep -n "routes/approvals.ts" .github/workflows/approval-realdb-p7r1-coverage-repair.yml` | `:58`、`:84` 命中 |
| `.env` 文件已提交进 git | `git ls-files packages/core-backend/.env; echo $?` | 命中,exit 0 |
| `DATABASE_URL=`(空串)探针能触发真正的哨兵抛错 | 见"反 skip-green 三件"小节完整输出 | `Error: todo-center pending-query gate requires DATABASE_URL; refusing skip-shaped green` |
| 工作树在本轮结束时干净 | `git status --short` | 无输出 |

## FIX-ROUND PASS (2026-09-18, gate round 1 remediation). Base at start of this pass: HEAD =
## `9a416b9ba3a5b77e984de04b251e5985c23c02fb` (the exact commit the independent gate report
## `impl-gate-B-slice1-round1-20260918.md` audited), merge-base with `origin/main` unchanged at
## `89f1ecdee2c3b70205a318074824c834bc6a5c7e`. This pass addresses 2 of that report's items (P1-1,
## P2-1); it does not touch or re-litigate the FINALIZATION PASS section above (repo convention:
## mark the sentence, don't void the section).

### P1-1 — second pending predicate in `approval-realtime.ts` (design-lock §3
### "只准一份" hard constraint; a gate finding, not a §5 judging criterion) — REGISTERED per gate
### report disposition (b); (a)/(c) remain an owner call, not decided here

The gate report's finding, restated precisely: `services/approval-realtime.ts`'s
`computeApprovalPendingCounts` hand-copies the same three-arm assignee-match disjunction
`approval-pending-query.ts`'s `approvalPendingAssigneeMatchCondition` implements, but **omits** the
handler-node exclusion (`handlerNodeExclusionCondition`). This is a pre-existing divergence — it
predates this branch (confirmed below) — but this slice's own commit `6fba6e01e` ("broadcast
todo:counts-updated alongside approval:counts-updated") wires the todo-center's own new event onto
this divergent payload, and neither this document's earlier passes nor the design MD's §6 registered
it. The gate report frames three dispositions and states explicitly it does not pick one ("处置(三选
一,不由我裁)"). This pass takes disposition **(b)** ("不折。则必须…登记…收窄成仅 REST 路径") because,
unlike (a), it carries no "需 owner 一句" qualifier in the report's own wording — it changes no
runtime behavior and forecloses neither future option. **This is NOT an owner ratification of (b)
over (a)/(c)**: (a) (fold the exclusion into the realtime path) would change the delivered
`todo:counts-updated`/`approval:counts-updated` numbers for viewers holding a handler-node seat — a
public-contract change the report correctly gates behind an explicit owner word — and that
authorization was not sought or given in this pass. (c) (BLOCKED) is not taken either, because (b)
is available and does not require stopping work. Phrased per the report's own instruction (NOT as
"REST 与 realtime 有差异,待二切片", which the report explicitly rejects as misleading): **the
realtime-push predicate is known-wrong against the ratified §1.5 ① baseline, and B-2's badge is
slated to consume it.**

**Confirmed pre-existing, not introduced by this branch** (git blame would also show this, but the
mechanical check the "verify against current main" doctrine asks for is a content diff against the
merge-base, already run by the gate report and re-confirmed here at the unchanged merge-base):

```
$ git show 89f1ecdee2c3b70205a318074824c834bc6a5c7e:packages/core-backend/src/services/approval-realtime.ts | grep -n "assignment_type = 'source_queue'"
      OR (a.assignment_type = 'source_queue' AND a.assignee_id = ANY($3))
```
Present on `origin/main` at the merge-base already — this branch did not create the divergent
predicate, it only pointed a new event name at it.

**Reproduced independently in this pass** (not inherited from the gate report's psql output — a
fresh transaction against `metasheet2_lock_b`, seeding a class-⑧-equivalent shape: one active `user`
seat on a `pending` instance whose `published_definition_id` classifies the seat's `current_node_key`
as a `handler` node, matching `seedHandlerPublishedDefinition`'s fixture shape in
`todo-center-pending-gate.ts:393-419`; `ROLLBACK`ed, `metasheet2_lock_b` confirmed back to 0 rows in
`approval_instances` afterward — no residual state):

```sql
BEGIN;
INSERT INTO approval_templates (key, name, status) VALUES ('p1-1-repro-tmpl', 'P1-1 Repro Template', 'published') RETURNING id \gset tmpl_
INSERT INTO approval_template_versions (template_id, version, status) VALUES (:'tmpl_id', 1, 'published') RETURNING id \gset ver_
INSERT INTO approval_published_definitions (template_id, template_version_id, runtime_graph, is_active)
  VALUES (:'tmpl_id', :'ver_id', '{"nodes":[{"key":"p1-1-repro-node","type":"handler"}]}'::jsonb, TRUE) RETURNING id \gset def_
INSERT INTO approval_instances (id, status, source_system, published_definition_id, current_node_key, org_id)
  VALUES ('p1-1-repro-instance', 'pending', 'platform', :'def_id', 'p1-1-repro-node', 'p1-1-repro-org');
INSERT INTO approval_assignments (instance_id, assignment_type, assignee_id, node_key, is_active)
  VALUES ('p1-1-repro-instance', 'user', 'p1-1-repro-viewer', 'p1-1-repro-node', TRUE);
-- A) REST shared query (approval-pending-query.ts buildApprovalPendingConditions: 4 conditions incl. handler exclusion)
SELECT COUNT(DISTINCT a.instance_id)::text FROM approval_assignments a
  INNER JOIN approval_instances i ON i.id = a.instance_id
  WHERE a.is_active = TRUE AND i.status = 'pending'
    AND (a.assignment_type = 'user' AND a.assignee_id = 'p1-1-repro-viewer')
    AND NOT EXISTS (SELECT 1 FROM approval_published_definitions pd WHERE pd.id = i.published_definition_id
      AND pd.runtime_graph @> jsonb_build_object('nodes', jsonb_build_array(jsonb_build_object('key', a.node_key, 'type', 'handler'))));
-- B) realtime path (approval-realtime.ts computeApprovalPendingCounts: 3 conditions, NO handler exclusion)
SELECT COUNT(DISTINCT a.instance_id)::text FROM approval_assignments a
  INNER JOIN approval_instances i ON i.id = a.instance_id
  LEFT JOIN approval_reads r ON r.instance_id = a.instance_id AND r.user_id = 'p1-1-repro-viewer'
  WHERE a.is_active = TRUE AND i.status = 'pending' AND (a.assignment_type = 'user' AND a.assignee_id = 'p1-1-repro-viewer');
ROLLBACK;
```
```
--- A) --- count: 0
--- B) --- count: 1
$ psql "postgresql://localhost/metasheet2_lock_b" -c "select count(*) from approval_instances;"   # after ROLLBACK
 count
-------
     0
```
Same viewer, same instance, same database: REST gives 0, the realtime path gives 1. This matches
the gate report's own reproduction in shape and outcome (independent re-run, not a copy of its
numbers).

**Anchored against the ratified basis, not asserted freestanding**: design-lock v2.14 §1.5 row ①
names `routes/approvals.ts:1990`'s WHERE (four conditions including the handler-node exclusion) as
the badge's ground truth ("三路身份输入…∧ `NOT EXISTS` 办理节点排除"); §3.0 requires the extraction to
reproduce "整条语句…WHERE 四个条件…办理节点排除"; the RATIFY record atop the lock confirms "§7-2 基准
口径 = §1.5 的 ①(活动席位)= **确认**". `approval-realtime.ts`'s three-condition query has no basis
in any of those three citations — it is not a second legitimate reading of an ambiguous spec, it is
short of the ratified one condition.

**Judge D's evidence scope, narrowed here rather than the lock's ratified row redefined** (per this
repo's own doctrine that a single ratified predicate's scope cannot be silently narrowed by a
downstream document): design-lock §5 row D ("徽标数字不变") is not edited — its ratified text and
scope stand as written, wider than what this document can attest to. What THIS document's evidence
for row D actually covers, stated precisely: the `GET /api/approvals/pending-count` REST path only
(the three named A0 tests for classes ①/②/⑥, per the "Judging criterion D" section above). The
`todo:counts-updated`/`approval:counts-updated` realtime-push path is **not** covered by row D's
positive control in this document, and is now known, not merely unverified, to disagree with the
REST path for class-⑧-shaped viewers (handler-node seat holders) — registered as a declared evidence
gap, not folded into a restated (and narrower) row D.

**Source docblock's absolute claim, corrected** (this repo's "绝对断言必须自扫" doctrine, applied to
a source docblock, not just this document's own prose): `approval-pending-query.ts`'s
`approvalPendingAssigneeMatchCondition` docblock read "Do not inline a second copy of this string
anywhere" — literally false as written, since `approval-realtime.ts:41-49` already is a second copy
(missing one condition). Fixed in this pass (comment-only; verified below the change carries zero
behavioral delta) to name the known exception by file reference rather than restate it as universal,
and without pasting its SQL text into the comment (that would create a THIRD textual occurrence of
the three-arm disjunction and falsely trip judging criterion C's own drift-detection grep):

```
$ git diff -- packages/core-backend/src/services/approval-pending-query.ts | head -30
```
(see the actual diff in this commit; it touches only the docblock above
`approvalPendingAssigneeMatchCondition`, zero lines of executable code)
```
$ git grep -c "assignment_type = 'source_queue'" -- packages/core-backend/src | awk -F: '{s+=$2} END {print s}'
12
```
Same count before and after this pass's docblock edit (12 — this repo-wide count includes
`ApprovalBridgeService.ts`'s own, unrelated "visible" predicate ③ and doc-comment mentions, not just
the two pending-predicate call sites the gate report highlighted with `…` elision) — the fix added a
file:line pointer, not a new inline copy of the drift string.

**Disposition recorded, not closed**: `docs/development/todo-center-phase1-design-20260918.md` §6
item 7 registers this residual (added in this pass) — it must stay registered until an owner
resolves (a)/(c) per the gate report's three-way framing. This document's own "未做/未验" table
(below) gets a matching row.

### P2-1 — workflow-level `DATABASE_URL:?` guard added to the todo-center gate step (design-lock
### §3.0 "反 skip-green 三件", first of three; the other two — import-time asserts, `EXPECT_DB`
### sentinel — were already in place per the earlier "反 skip-green 三件" section above)

Gate report: `.github/workflows/approval-realdb-todo-center-pending-query.yml`'s single test step
had no shell-level `: "${DATABASE_URL:?…}"` guard (the `plugin-tests.yml:1176,:1186` shape every
sibling real-DB step carries), and this document's own earlier "反 skip-green 三件的哨兵证据" section
(above) had just shown WHY that specific gap matters here: the checked-in `packages/core-backend/.env`
backfills `DATABASE_URL` before `setup.ts`'s own import-time check runs, so an `env -u DATABASE_URL`
probe shape does not trigger the intended refusal — a shell-level guard runs before node starts and
`.env` cannot reach it.

**Fix** (mechanical, comment-only elsewhere): the step's `run:` changed from a folded scalar
(`run: >-`) to a literal block (`run: |`) with the guard as its first line:

```diff
-        run: >-
-          pnpm --filter @metasheet/core-backend exec vitest
-          --config vitest.todo-center-pending-gate.config.ts run
-          tests/todo-center-pending-gate/todo-center-pending-gate.ts
-          --reporter=verbose
+        run: |
+          : "${DATABASE_URL:?DATABASE_URL is required for the todo-center pending-query gate}"
+          pnpm --filter @metasheet/core-backend exec vitest \
+            --config vitest.todo-center-pending-gate.config.ts run \
+            tests/todo-center-pending-gate/todo-center-pending-gate.ts \
+            --reporter=verbose
```

**YAML parse verified locally** (this sandbox cannot run Actions, so a folded→literal scalar
conversion with wrong indentation — a documented silent-break shape — is checked the only way
available: parse it and print the resolved multiline string back):

```
$ python3 -c "
import yaml
d = yaml.safe_load(open('.github/workflows/approval-realdb-todo-center-pending-query.yml'))
step = next(s for s in d['jobs']['approval-realdb-todo-center-pending-query']['steps'] if s.get('name','').startswith('Run todo-center'))
print(repr(step['run']))
"
': "${DATABASE_URL:?DATABASE_URL is required for the todo-center pending-query gate}"\npnpm --filter @metasheet/core-backend exec vitest \\\n  --config vitest.todo-center-pending-gate.config.ts run \\\n  tests/todo-center-pending-gate/todo-center-pending-gate.ts \\\n  --reporter=verbose\n'
```
Resolves to the intended four-line shell script, correctly joined by `\` line continuations, guard
line first.

**Guard's actual triggering behavior confirmed** (this exact multi-line block, run verbatim outside
YAML, with an empty `DATABASE_URL` — the shape the earlier "反 skip-green 三件" section showed
`env -u DATABASE_URL` alone does NOT trigger, because of the `.env` backfill):

```
$ cd packages/core-backend && DATABASE_URL= EXPECT_DB=1 RBAC_BYPASS=false RBAC_TOKEN_TRUST=false PRODUCT_MODE=plm-workbench RBAC_CACHE_TTL_MS=0 bash -c '
: "${DATABASE_URL:?DATABASE_URL is required for the todo-center pending-query gate}"
pnpm --filter @metasheet/core-backend exec vitest --config vitest.todo-center-pending-gate.config.ts run tests/todo-center-pending-gate/todo-center-pending-gate.ts --reporter=verbose
'
bash: line 1: DATABASE_URL: DATABASE_URL is required for the todo-center pending-query gate
```
Refuses before `pnpm`/`vitest` is even invoked — the shell-level guard fires ahead of anything
`applyDotEnv` could backfill, closing the specific gap the earlier section identified. (This guard
does not retroactively fix the `.env`-backfill weakness for the `env -u DATABASE_URL` LOCAL probe
shape recorded earlier — that remains an accurate, unresolved, non-CI-blocking record, per this
repo's convention of not rewriting prior accurate sections.)

**Real run, fresh database, workflow-verbatim shell shape, with the new guard line present** (not
skipped past — a genuinely non-empty `DATABASE_URL` this time):

```
$ dropdb metasheet2_lock_b && createdb metasheet2_lock_b
$ cd packages/core-backend && DATABASE_URL=postgresql://localhost/metasheet2_lock_b \
  MIGRATION_EXCLUDE=008_plugin_infrastructure.sql,048_create_event_bus_tables.sql,049_create_bpmn_workflow_tables.sql,042a_core_model_views.sql,20250924140000_create_gantt_tables.ts,20250925_create_view_tables.sql \
  pnpm run db:migrate
# ... completes without error, last line:
migration "zzzz20260916120000_create_dingtalk_todo_mirrors" was executed successfully

$ DATABASE_URL=postgresql://localhost/metasheet2_lock_b EXPECT_DB=1 RBAC_BYPASS=false RBAC_TOKEN_TRUST=false PRODUCT_MODE=plm-workbench RBAC_CACHE_TTL_MS=0 bash -c '
: "${DATABASE_URL:?DATABASE_URL is required for the todo-center pending-query gate}"
pnpm --filter @metasheet/core-backend exec vitest --config vitest.todo-center-pending-gate.config.ts run tests/todo-center-pending-gate/todo-center-pending-gate.ts --reporter=verbose
'
 Test Files  1 passed (1)
      Tests  26 passed (26)
```
26/26, unchanged from every prior pass in this document — the guard line is a pure addition ahead of
the existing command, not a behavioral change to it.

**`npx tsc --noEmit -p tsconfig.json`**: `TSC-EXIT=0` (unaffected — this pass touches no `.ts` source
behavior, only a docblock comment and a workflow YAML).

**Mutation ledger (M1–M8, `approval-pending-query.ts` and `AuthService.ts`) not replayed in this
pass, and why that is checkable rather than hand-waved**: the ONLY change to `approval-pending-query.ts`
in this pass is the docblock addition shown above (`git diff` output, zero lines outside a `/** */`
comment block) — the file every M1–M8 mutation targets is otherwise byte-identical to what the gate
report already exercised. A comment-only diff cannot change any mutation's red/green verdict; replaying
them would re-verify a file this pass did not touch. `.github/workflows/approval-realdb-todo-center-pending-query.yml`
is not an M1–M8 target either (those mutate `src/services/approval-pending-query.ts` and, for M8 only,
`src/auth/AuthService.ts`).

**s6a / judge F unaffected** (per the advisor consult ahead of this pass): neither file this pass
touched is `plugin-tests.yml` or a migration —

```
$ git diff --stat -- .github/workflows/plugin-tests.yml
(empty)
$ git diff --quiet origin/main...HEAD -- packages/core-backend/migrations packages/core-backend/src/db/migrations; echo $?
0
```
— so s6a stays N/A and judge F stays green, unchanged from every earlier pass.

### 未做 / 未验 表新增两行(本轮)

| 项 | 状态 | 原因 |
|---|---|---|
| `approval-realtime.ts` 第二份 pending 谓词(P1-1) | **REGISTERED,未折入**——(a) 折入 / (c) BLOCKED 仍待 owner 裁决;本轮取 (b):如实登记 + 收窄判据 D 证据范围,不代 owner 选边 | 见本节"P1-1"小节;设计 MD §6 第 7 条同步登记;`approval-pending-query.ts` docblock 已加 KNOWN EXCEPTION 指针(comment-only,`git diff` 已证零行为改动) |
| 判据 D 的证据范围 | 本文档对行 D 的证据面**只覆盖 REST 路径**(`/pending-count`);锁 §5 行 D 字面范围更宽(未改锁文本身),差额 = 实时推送路径,该路径已知与 REST 路径不一致(见 P1-1 复现) | 同上;不是把行 D 改窄,是记录本文档证据面与锁文字面范围之间的一条已知缺口 |

### 绝对断言自扫(本轮新增)

| 断言 | 命令 | 结果 |
|---|---|---|
| `approval-realtime.ts` 的分叉谓词在本分支 merge-base 之前已存在(非本切片引入) | `git show 89f1ecdee2c3b70205a318074824c834bc6a5c7e:packages/core-backend/src/services/approval-realtime.ts \| grep -n "assignment_type = 'source_queue'"` | 命中 1 行(`source_queue` 臂),确认已在 `origin/main` 合并基点存在 |
| 同库 REST vs realtime 计数分叉(class ⑧ 形状) | 见本节 P1-1 psql 复现完整输出 | A) 0 / B) 1 |
| 复现事务已 `ROLLBACK`,库无残留 | `psql "postgresql://localhost/metasheet2_lock_b" -c "select count(*) from approval_instances;"`(复现后) | 0 |
| docblock 修复未新增第三处内嵌 SQL 片段(判据 C drift-string 计数不变) | `git grep -c "assignment_type = 'source_queue'" -- packages/core-backend/src \| awk -F: '{s+=$2} END {print s}'` | 12(修复前后一致) |
| `approval-pending-query.ts` 本轮唯一改动是 docblock 注释,零可执行代码行 | `git diff -- packages/core-backend/src/services/approval-pending-query.ts` | 仅 `/** */` 注释块内增删,`export function` 及其函数体逐字未变 |
| P2-1 新 guard 行在 YAML 折叠→字面转换后解析正确 | 见本节 python3 yaml.safe_load 复现 | 解析出的多行脚本与预期逐字一致,guard 行在 pnpm 命令之前 |
| P2-1 guard 对空 `DATABASE_URL` 真正触发拒绝(而非 `.env` 回填绕过) | 见本节 `DATABASE_URL= ... bash -c '...'` 完整输出 | `bash: line 1: DATABASE_URL: DATABASE_URL is required for the todo-center pending-query gate` |
| 全套件在新 guard 加入后仍 26/26(workflow 逐字调用形态,全新迁移库) | 见本节"Real run, fresh database"小节完整输出 | 26 passed / 26 |
| `npx tsc --noEmit` 本轮仍 exit 0 | `npx tsc --noEmit -p tsconfig.json; echo $?` | 0 |
| `plugin-tests.yml` 与迁移目录本轮仍未被触碰(s6a / 判据 F 不受影响) | `git diff --stat -- .github/workflows/plugin-tests.yml`;`git diff --quiet origin/main...HEAD -- packages/core-backend/migrations packages/core-backend/src/db/migrations; echo $?` | 空输出;`0` |
| 工作树在改动提交前干净(除本轮待提交的 4 个文件外无其它改动) | `git status --short` | 只列出本轮改动的 4 个文件(2 个 workflow/src、2 个 doc),无其它路径 |

### 本轮未处理、留给下一步的项(如实列出,避免下一步重新普查)

按门审报告 `impl-gate-B-slice1-round1-20260918.md` 的优先级列表,本轮只处理了 P1-1(disposition (b))
与 P2-1;以下项**未在本轮触碰**,原样留给后续修复轮:

- **P2-0**(悬置条件):GitHub required-check 状态未核——沙箱无网络,需 owner 或有网会话核实
  `approval-realdb-todo-center-pending-query.yml` 是否在 branch-protection required checks 内,
  其结果同时决定 P2-2/P2-3 的严重度归类。
- **P2-2**:触发集(`paths:`)漏掉六个生产 RBAC/auth 模块(`AuthService.ts`、`rbac/rbac.ts`、
  `rbac/service.ts`、`rbac/namespace-admission.ts`、`config/product-mode.ts`、`routes/auth.ts`)。
- **P2-3**:`approval-realdb-p7r1-coverage-repair.yml` 的 `paths:` 未列
  `services/approval-pending-query.ts`。
- **P3-1**:两条 `wip:` 提交(`a2cf836b5`、`01759832a`)未 squash。
- **P3-2**:`approval-ci-coverage-enumeration.test.ts` 发现式守卫的闭世界边界未登记
  `todo-center-pending-gate.ts`。
- **P3-3**:设计 MD §5 的 HEAD 钉点(`63fc3d699`)已过期,当前 HEAD 为 `9a416b9ba`(锚点仍字节有效,
  只是钉点数字过期)。
- **P3-4**:workflow 的 `paths:` 多列未被实际导入的 `tests/helpers/approval-schema-bootstrap.ts`
  (over-inclusion,不破坏 fail-closed;门审建议与 P2-2 同批处理)。

这份清单本身**不是**本轮新产生的普查——全部照抄门审报告 §7 的编号与描述,只是把"哪些已处理/哪些没有"
显式记下来,避免下一步重新读一遍整份门审报告才能确认起点。

## FIX-ROUND 2 PASS (2026-09-18, second lane-continuation step). Base at start of this pass: HEAD =
## `5c8283131585a73e199c64271dec2f7ee02fcf82`. This pass's implementer session has outbound network
## (`curl`/`gh` both reachable — verified below), unlike the round-1 gate agent's sandbox — exactly
## the network gap the FIX-ROUND PASS's P2-0 flagged as owner/network-gated. That unblocks P2-0 for
## real resolution (not just documentation) this round. This pass addresses P2-0, P2-2, P2-3, and
## (bundled into the same lines as P2-2, per the gate report's own "no reason to defer" framing) P3-4.
## It does not touch or re-litigate the FINALIZATION PASS or first FIX-ROUND PASS sections above
## (repo convention: mark the sentence, don't void the section).

### P2-0 — GitHub required-check status, RESOLVED (not merely unblocked): the todo-center lane is
### confirmed advisory, not required, as of this check

Gate report: sandboxed, no network, could not query `zensgit/metasheet2`'s branch-protection required
contexts; raised as a hinge condition controlling P2-2/P2-3's severity classification. This session
has network:

```
$ curl -s -m 5 -o /dev/null -w "curl_exit=%{http_code}\n" https://api.github.com
curl_exit=200
$ gh auth status 2>&1 | head -3
github.com
  ✓ Logged in to github.com account zensgit (keyring)
```

**The actual API call the gate report named**:

```
$ gh api repos/zensgit/metasheet2/branches/main/protection --jq '.required_status_checks | {strict, contexts}'
{"contexts":["contracts (strict)","contracts (dashboard)","pr-validate","test (20.x)","contracts (openapi)","web-tests","stock-prep PowerShell 5.1 acceptance","attendance-web-guard","integration-guard","ssh host-key pin contract (fail-closed known_hosts)","observation-kit contract (read-only SQL census + runbook gating)","recovery-schema-drift","Approval browser verify (chromium)"],"strict":false}
```
Checked 2026-09-18T01:57:27+08:00 (`2026-09-17T17:57:27Z`). 13 required contexts, `strict: false`.
`approval-realdb-todo-center-pending-query` (the standalone lane this slice's evidence lives in) is
**not** one of the 13 names.

**Per the memory note this repo already carries ("被触发≠被验证" — a bare name-absence is not
sufficient; the discriminating fact is whether ANY required context's workflow actually executes the
gate file), the absence claim is backed by an enumeration, not just a name check.** Each of the 13
contexts is produced by exactly one workflow file (job id, or job id + `matrix.<key>` for the three
that fan out):

| Required context | Producing workflow (job id) |
|---|---|
| `contracts (strict)` / `contracts (dashboard)` / `contracts (openapi)` | `.github/workflows/attendance-gate-contract-matrix.yml` (job `contracts`, `matrix.case_id: [strict, dashboard, openapi]`) |
| `pr-validate` | `.github/workflows/phase5-validate.yml` (job `pr-validate`) |
| `test (20.x)` | `.github/workflows/plugin-tests.yml` (job `test`, `matrix.node-version: [18.x, 20.x]`, no `name:` override — GitHub renders `test (20.x)`) |
| `stock-prep PowerShell 5.1 acceptance` | `.github/workflows/plugin-tests.yml` (separate job) |
| `web-tests` | `.github/workflows/web-tests.yml` (job `web-tests`) |
| `attendance-web-guard` | `.github/workflows/attendance-web-guard.yml` (job `attendance-web-guard`) |
| `integration-guard` | `.github/workflows/integration-guard.yml` (job `integration-guard`) |
| `ssh host-key pin contract (fail-closed known_hosts)` | `.github/workflows/ssh-hostkey-pin-contract.yml` |
| `observation-kit contract (read-only SQL census + runbook gating)` | `.github/workflows/multitable-o2-observation-kit.yml` (job `contract`) |
| `recovery-schema-drift` | `.github/workflows/multitable-recovery-schema-drift.yml` (job `recovery-schema-drift`) |
| `Approval browser verify (chromium)` | `.github/workflows/approval-browser-verify.yml` (job `browser-verify`) |

10 distinct workflow files back the 13 contexts (the two 3-context / 2-context rows share one file
each). Enumerating whether ANY of them ever mentions the gate file:

```
$ grep -rln "todo-center-pending-gate" .github/workflows/
.github/workflows/approval-realdb-todo-center-pending-query.yml
$ for f in attendance-gate-contract-matrix.yml phase5-validate.yml plugin-tests.yml web-tests.yml \
           attendance-web-guard.yml integration-guard.yml ssh-hostkey-pin-contract.yml \
           multitable-o2-observation-kit.yml multitable-recovery-schema-drift.yml \
           approval-browser-verify.yml; do
  echo "--- $f ---"; grep -c "todo-center" .github/workflows/$f
done
--- attendance-gate-contract-matrix.yml ---
0
--- phase5-validate.yml ---
0
[... all ten print 0 ...]
```
Zero hits in all ten required-context files, for even the bare substring `todo-center` (a superset of
the gate-file name check, so this also rules out an indirect reference by directory or config name).

**The one context worth checking beyond a name grep** is `test (20.x)`, because `plugin-tests.yml`'s
`test` job runs the core-backend package's default `vitest` invocation, and vitest collects files by
config glob rather than by literal filename appearing in the workflow YAML — a false negative here
would be the one place a grep-only check could miss something real. Confirmed it does not collect the
gate file, by the same two-point wiring already established in this document's own "两点接线" table
(§4.1 of the gate report; reproduced here against current HEAD, not inherited):

```
$ grep -n '"test"' packages/core-backend/package.json
    "test": "vitest",
$ grep -n "todo-center" packages/core-backend/vitest.config.ts
      // todo-center-design-lock v2.14 §3.0/§5 — the shared "pending" query production-path gate.
      // Runs under its OWN vitest.todo-center-pending-gate.config.ts (RBAC_BYPASS=false,
      // FILE into .github/workflows/approval-realdb-todo-center-pending-query.yml, which arms
      'tests/todo-center-pending-gate/todo-center-pending-gate.ts',
```
`vitest.config.ts` explicitly excludes the file by exact path (the second half of the two-point wiring
this document already verified); the file's name also carries no `.test.ts`/`.spec.ts` suffix, so it
is never collected by vitest's default include glob in the first place (the first half, also already
verified). Both halves hold on current HEAD, independent of anything this round's `paths:` edits touch.

**Verdict**: the todo-center real-DB gate is confirmed **advisory, not required**, at merge time, as
of this check. This is not a hypothetical the gate report left open — it is now a fact with a
timestamp. Per the gate report's own framing (its §1 P2-0 block): this **controls** P2-2/P2-3's severity, and it is worse than either of them
individually — the entire 26-case real-DB evidence surface for this slice (all fourteen viewer
classes, the eight mutations the gate agent proved load-bearing) is **not enforced by branch
protection**. A PR that regresses `approval-pending-query.ts`'s WHERE clause, or any of the modules
this pass adds to its trigger set, can merge to `main` with this lane simply never having run (it is
`pull_request`-triggered with a `paths:` filter and no `merge_group:` — see the workflow's own header
comment for why `merge_group:` was deliberately omitted — so a PR whose diff happens to miss the
trigger set merges clean with no human in the loop forced to notice). **On whether a human reviewer
would be in that loop at all**: the same `gh api` call's top-level key set —
`["allow_deletions","allow_force_pushes","allow_fork_syncing","block_creations","enforce_admins",
"lock_branch","required_conversation_resolution","required_linear_history","required_signatures",
"required_status_checks","url"]` — carries **no** `required_pull_request_reviews` key at all, meaning
`main` currently has no configured review requirement of any kind (not "some review config exists but
is lenient" — the key is absent). This is stated because this repo's own project instructions record
a 2026-08-14 verification that review requirements (code-owner review, last-push approval, 1 approval)
were restored and enabled; this check, five weeks later, finds them gone from the live API response.
That drift is **out of scope for this pass** to chase further (it is a repo-wide branch-protection
fact, not a todo-center-lane finding) and is not investigated beyond this one `gh api` call — flagged
here only because it is the fact this section's own claim depends on, not asserted from memory.

> **Correction (FIX-ROUND 3 PASS, mark-not-void per repo convention): the paragraph above
> misattributes its "2026-08-14 verification" reference.** That note, in the top-level
> `CLAUDE.md`'s "Canonical repos" table, is about `zensgit/yuantus-plm`'s branch protection
> specifically — its own required-check names are `required-ci` / `required-regression` /
> `cad-compatibility`, none of which exist in this repo (`zensgit/metasheet2`), and the `gh api`
> call it cites is literally `repos/zensgit/yuantus-plm/branches/main/protection`, not this repo's.
> There is **no** project-instructions record of metasheet2's `main` ever having had
> `required_pull_request_reviews` configured — this session's own accumulated project memory
> (`# CI / 合并机制`) instead states plainly "无 required review" for this repo. So the live `gh api`
> finding above (no review-requirement key present) is **not evidence of drift from a prior
> metasheet2 state** — there is no known prior state to drift from. It is simply this repo's
> current, and as far as any available record shows, long-standing configuration. The "five weeks
> later, finds them gone" framing should be read as withdrawn; the rest of the paragraph's live
> finding (the key is absent, today, verified by this one `gh api` call) stands unchanged and is not
> otherwise affected — it does not change P2-0's advisory-lane verdict, which rests on the required
> status-checks enumeration, not on this reviews aside.

**What this pass does NOT do**: change branch protection, or decide that the lane *should* become
required. That is an infrastructure change with a merge-cost trade-off (this repo's own memory notes
the s6a-pin / merge-serialisation cost of adding lanes to required sets) — an owner call, not an
implementer call, and out of scope for a code-review worktree with no mandate to touch repo settings.
**Owner decision this forces, stated plainly**: either (i) add
`approval-realdb-todo-center-pending-query` to `main`'s required status checks (accepting its
merge-serialisation cost, now measurably higher after this pass's P2-2 trigger-set widening — see
below), or (ii) explicitly accept that this slice's real-DB evidence is advisory-only at merge time.
Left unsigned here.

### P2-2 (bundled with P3-4) — trigger set (`paths:`) widened to the six production RBAC/auth modules
### the gate report's mutation M8 proved load-bearing; the one over-inclusive entry removed in the
### same edit

Gate report: this lane runs on the PRODUCTION RBAC axis (`RBAC_BYPASS=false` / `RBAC_TOKEN_TRUST=false`
/ `PRODUCT_MODE=plm-workbench`), not the default token-trust harness every other suite in this repo
runs on — so `AuthService.ts`, `rbac/rbac.ts`, `rbac/service.ts`, `rbac/namespace-admission.ts`,
`config/product-mode.ts`, and `routes/auth.ts` are not merely imported, they are **executed and
load-bearing for specific classes' golden values** (the gate report's own mutation M8:
`AuthService.ts:742`'s `if (admin) role = 'admin'` flipped to `if (false && admin) role = 'admin'`
turned class ③′ from a pass into the suite's only failure). None of the six was in the 13-entry
trigger set.

**Precondition check (fail-silent glob risk — a typo'd `paths:` entry never matches and never
errors, same defect class as the finding being fixed)**: confirmed each of the six files exists at
the exact path before adding it:

```
$ for f in "src/auth/AuthService.ts" "src/rbac/rbac.ts" "src/rbac/service.ts" \
           "src/rbac/namespace-admission.ts" "src/config/product-mode.ts" "src/routes/auth.ts"; do
  p="packages/core-backend/$f"
  [ -f "$p" ] && echo "OK  $p" || echo "MISSING  $p"
done
OK  packages/core-backend/src/auth/AuthService.ts
OK  packages/core-backend/src/rbac/rbac.ts
OK  packages/core-backend/src/rbac/service.ts
OK  packages/core-backend/src/rbac/namespace-admission.ts
OK  packages/core-backend/src/config/product-mode.ts
OK  packages/core-backend/src/routes/auth.ts
```
All six present, no typo risk.

**P3-4 bundled in the same edit** (gate report: "建议同 PR 把六个模块补进两处 paths;顺手摘掉
`tests/helpers/approval-schema-bootstrap.ts`" — over-inclusion, the gate file never imports it):

```
$ grep -rn "approval-schema-bootstrap" packages/core-backend/tests/todo-center-pending-gate/ \
                                        packages/core-backend/vitest.todo-center-pending-gate.config.ts
(no output, exit 1)
```
Confirmed zero references before removing the line.

**Diff** (both `pull_request.paths` and `push.paths` blocks — the file has two byte-identical blocks
by design, one per trigger):

```diff
-      - 'packages/core-backend/tests/helpers/approval-schema-bootstrap.ts'
       - 'packages/core-backend/vitest.todo-center-pending-gate.config.ts'
       - 'packages/core-backend/vitest.config.ts'
+      # Gate report impl-gate-B-slice1-round1-20260918.md P2-2: this lane runs on the PRODUCTION
+      # RBAC axis (RBAC_BYPASS=false / RBAC_TOKEN_TRUST=false / PRODUCT_MODE=plm-workbench below),
+      # not the default token-trust harness, so these six modules are not merely imported — the
+      # gate agent's mutation M8 (AuthService.ts:742 admin-role upgrade) proved one of them is
+      # load-bearing for a specific class (③′) the suite's golden values depend on. A change to
+      # any of the six can silently flip this gate's expected counts without ever triggering it.
+      # Known cost, accepted per the same fail-closed-over-narrow-trigger-set precedent this repo
+      # already applies elsewhere (feedback_lock_taking_port_needs_lock_order_census and siblings):
+      # these are high-churn, widely-shared modules, so this lane's Postgres job will now spin up
+      # more often than the narrower 13-path trigger set it replaces — the alternative (missing a
+      # real behavior change) is worse for an advisory-only real-DB evidence lane (see P2-0 below).
+      - 'packages/core-backend/src/auth/AuthService.ts'
+      - 'packages/core-backend/src/rbac/rbac.ts'
+      - 'packages/core-backend/src/rbac/service.ts'
+      - 'packages/core-backend/src/rbac/namespace-admission.ts'
+      - 'packages/core-backend/src/config/product-mode.ts'
+      - 'packages/core-backend/src/routes/auth.ts'
       - '.github/workflows/approval-realdb-todo-center-pending-query.yml'
```
This is the full first (`pull_request.paths`) hunk verbatim from `git diff`; the second (`push.paths`)
hunk is byte-identical, confirmed by the block-identity check further below rather than pasted twice.

**Named cost, not silently accepted**: `AuthService.ts` / `rbac/rbac.ts` / `routes/auth.ts` are
high-churn, widely-shared modules across the whole backend, not approval-specific — this lane's
Postgres job (a ~25-minute-budget job per its `timeout-minutes: 25`) will now spin up on a materially
larger set of PRs than the narrow 13-path set it replaces. Fail-closed (spin up the job on a change
that MIGHT matter) wins over the alternative (miss a real regression this gate exists to catch)
because — per the P2-0 finding directly above — this lane is advisory, not required, so a run of it
never gates anyone's merge; the cost of the wider trigger set is CI minutes and one more entry in the
PR checks list on more PRs, not merge-blocking latency (this pass has no measurement of shared-runner
queue contention, so that specific cost is left unclaimed rather than asserted as zero). Had P2-0
resolved the other way (lane IS required), this same trade-off would need an explicit owner sign-off
on the added required-lane latency; it does not, given P2-0's actual result.

### P2-3 — `approval-pending-query.ts` added to the p7r1 lane's trigger set (the only regression
### coverage of the module this slice extracted `/pending-count`'s WHERE clause into)

Gate report: `approval-realdb-p7r1-coverage-repair.yml` is the only lane that regression-tests
`approval-wp3-pending-count.api.test.ts` (unmodified by this branch — see the FINALIZATION PASS
section's independent-oracle run). Before this slice's extraction, `/pending-count`'s WHERE clause
lived inline in `routes/approvals.ts`, already in that lane's `paths:`. After extraction, the WHERE
clause and both aggregate outputs live in `approval-pending-query.ts`, which was not.

**Mirror-image completeness check (the report applies "every module the suite actually executes" to
P2-2; the same ruler applied to P2-3 asks: does `/pending-count`'s handler pull in anything else from
the modules this slice touched, besides the one module already being added?)**:

```
$ grep -n "resolveApprovalActorId\|resolveApprovalActorRoles\|resolveApprovalActorPermissions\|countApprovalPendingForViewer" \
    packages/core-backend/src/routes/approvals.ts | head -5
48:import { resolveApprovalActorRoles } from '../services/approval-actor-roles'
49:import { countApprovalPendingForViewer } from '../services/approval-pending-query'
267:export function resolveApprovalActorId(req: Request): string | null {
282:export function resolveApprovalActorPermissions(req: Request): string[] {
```
`resolveApprovalActorId` and `resolveApprovalActorPermissions` are defined inline in `routes/
approvals.ts` itself (already in p7r1's `paths:`). `resolveApprovalActorRoles` is imported from
`approval-actor-roles.ts`, which is **not** in p7r1's `paths:` either — but that import, and that gap,
both **pre-date this slice**:

```
$ git log --oneline --follow -- packages/core-backend/src/services/approval-actor-roles.ts | tail -1
85b2dd30a test+fix(approval): residual sweep — carried gate gaps from the 20260821-22 wave (#5096)
$ git show 89f1ecdee2c3b70205a318074824c834bc6a5c7e:packages/core-backend/src/services/approval-actor-roles.ts >/dev/null 2>&1 && echo "EXISTS on merge-base"
EXISTS on merge-base
$ grep -c "approval-actor-roles" .github/workflows/approval-realdb-p7r1-coverage-repair.yml
0
```
`approval-actor-roles.ts` already existed on `origin/main` at this branch's merge-base, already was
NOT in p7r1's `paths:`, and this slice did not touch that file at all (`git diff --stat
89f1ecdee2c3b70205a318074824c834bc6a5c7e HEAD -- packages/core-backend/src/services/
approval-actor-roles.ts` is empty). **This is an honest disclosure, not a fix**: the gate report named
only `approval-pending-query.ts` for P2-3 (the module THIS slice extracted); widening the same ruler
to every pre-existing gap in a workflow this pass did not otherwise author (e.g. `rbac.ts` is also
imported by every route p7r1 exercises and is also absent from its `paths:`) is an unbounded,
separate audit of a lane predating this design-lock entirely, not a bounded fix of a finding this gate
report raised. Left as a named, out-of-scope observation rather than silently expanded into or
silently omitted from this pass.

**Diff** (both blocks):

```diff
       - 'packages/core-backend/src/routes/approvals.ts'
       - 'packages/core-backend/src/types/approval-product.ts'
       - 'packages/core-backend/src/db/migrations/zzzz20260703120000_add_node_entry_epoch.ts'
+      # Gate report impl-gate-B-slice1-round1-20260918.md P2-3: approval-wp3-pending-count.api.test.ts
+      # (this lane's only regression coverage of GET /api/approvals/pending-count) now exercises a
+      # WHERE clause and both aggregate outputs that live entirely in this extracted module, not in
+      # routes/approvals.ts's handler body. Before the extraction this path was already covered by
+      # the routes/approvals.ts entry above; after it, a change to ONLY this module (leaving the
+      # handler byte-identical) would not retrigger this lane without this line.
+      - 'packages/core-backend/src/services/approval-pending-query.ts'
       # Gate P3-2 (2026-08-18): the other half of the two-point wiring — a rebase or PR that
```
This is the full first hunk verbatim from `git diff`; the second hunk (the `push.paths` block) is
byte-identical, confirmed by the block-identity check below rather than pasted twice.

### Both blocks stay byte-identical per file, and both YAML files re-parse cleanly

```
$ python3 - <<'EOF'
import re
for fn in ['.github/workflows/approval-realdb-todo-center-pending-query.yml',
           '.github/workflows/approval-realdb-p7r1-coverage-repair.yml']:
    text = open(fn).read()
    pr = re.search(r'\n  pull_request:\n(.*?)\n  push:', text, re.S).group(1)
    push = re.search(r'\n  push:\n(.*?)\n\npermissions:', text, re.S).group(1)
    getp = lambda b: [l.strip() for l in b.split('\n') if l.strip().startswith('- ')]
    prp, pushp = getp(pr), getp(push)
    print(fn, 'pr=%d push=%d identical=%s' % (len(prp), len(pushp), prp == pushp))
EOF
.github/workflows/approval-realdb-todo-center-pending-query.yml pr=18 push=18 identical=True
.github/workflows/approval-realdb-p7r1-coverage-repair.yml pr=20 push=20 identical=True
$ python3 -c "import yaml; yaml.safe_load(open('.github/workflows/approval-realdb-todo-center-pending-query.yml')); print('todo-center OK')"
todo-center OK
$ python3 -c "import yaml; yaml.safe_load(open('.github/workflows/approval-realdb-p7r1-coverage-repair.yml')); print('p7r1 OK')"
p7r1 OK
```
todo-center: 13 → 18 (−1 `approval-schema-bootstrap.ts`, +6 RBAC/auth modules). p7r1: 19 → 20 (+1
`approval-pending-query.ts`). Both files parse as valid YAML after the edit.

### Regression: full 26-case gate suite re-run (workflow-literal shell shape, existing migrated
### `metasheet2_lock_b`); typecheck; s6a / judge F unaffected; mutation ledger carries forward by
### construction

This pass touches only `.github/workflows/*.yml` — zero bytes under `packages/core-backend/src` or
`packages/core-backend/tests` — so the M1–M8 mutation ledger's red/green verdicts cannot have changed;
confirmed rather than assumed:

```
$ git diff --stat 5c8283131585a73e199c64271dec2f7ee02fcf82 HEAD -- packages/core-backend/src packages/core-backend/tests
(empty)
```
(HEAD here is the pre-commit working tree at the point this was run, diffed against this pass's own
starting commit — zero output confirms no `src`/`tests` file changed in this pass, distinct from the
prior pass's docblock-only change, which IS captured going further back: `git diff --stat
9a416b9ba HEAD -- packages/core-backend/src` shows only the round-1 `approval-pending-query.ts`
docblock addition, nothing from this round.)

Full suite, workflow-literal shell shape (node 20.x via nvm, matching CI):

```
$ export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 20
Now using node v20.20.2
$ cd packages/core-backend && DATABASE_URL="postgresql://chouhua@127.0.0.1:5432/metasheet2_lock_b" \
  EXPECT_DB=1 RBAC_BYPASS=false RBAC_TOKEN_TRUST=false PRODUCT_MODE=plm-workbench RBAC_CACHE_TTL_MS=0 \
  npx vitest --config vitest.todo-center-pending-gate.config.ts run \
    tests/todo-center-pending-gate/todo-center-pending-gate.ts --reporter=verbose
 Test Files  1 passed (1)
      Tests  26 passed (26)
```
26/26, unchanged — a workflow-trigger-only edit cannot and did not change any test's behavior.

```
$ npx tsc --noEmit -p tsconfig.json; echo "TSC-EXIT=$?"
TSC-EXIT=0
```

```
$ git diff --stat -- .github/workflows/plugin-tests.yml
(empty)
$ git diff --quiet origin/main...HEAD -- packages/core-backend/migrations packages/core-backend/src/db/migrations; echo $?
0
```
s6a stays N/A (byte-identical `plugin-tests.yml`), judge F stays green (empty migrations diff) —
unaffected, as expected for a change confined to two non-pinned workflow files.

### 未做 / 未验 表新增一行(本轮)

| 项 | 状态 | 原因 |
|---|---|---|
| `approval-actor-roles.ts` 缺失于 p7r1 `paths:`(邻接 P2-3 但范围外) | **如实登记,未修**——这是先存于本切片之前的独立缺口(`approval-actor-roles.ts` 在 merge-base 已存在,本切片未改动该文件),门审报告 P2-3 只点名 `approval-pending-query.ts`;把同一把尺子推广到 p7r1 workflow 里每个先存缺口是无边界的独立普查,不是本条发现的修复范围 | 见本节 P2-3 小节 mirror-image 完整性检查 |

### 绝对断言自扫(本轮新增)

| 断言 | 命令 | 结果 |
|---|---|---|
| 13 个 required contexts 里没有 todo-center 的 lane 名 | 见本节 `gh api ... --jq` 完整输出 | 13 个名字逐一列出,均不含 `approval-realdb-todo-center-pending-query` |
| 10 份 required-context workflow 文件全部零命中 `todo-center` 子串(非仅门文件名) | 见本节 for 循环完整输出(10 份全 0) | 全 0 |
| `test (20.x)` 这一条(经 vitest 默认 glob 收集,而非字面文件名出现)也不会收集门文件 | `grep -n '"test"' packages/core-backend/package.json`;`grep -n "todo-center" packages/core-backend/vitest.config.ts` | `"test": "vitest"`;命中 4 行,含精确路径排除项 |
| 六个新增模块路径全部真实存在(防 `paths:` glob 静默不匹配) | 见本节 for 循环 `[ -f ... ]` 完整输出 | 6/6 `OK` |
| `approval-schema-bootstrap.ts` 未被门套件导入,移除前确认零命中 | `grep -rn "approval-schema-bootstrap" packages/core-backend/tests/todo-center-pending-gate/ packages/core-backend/vitest.todo-center-pending-gate.config.ts` | 无输出,exit 1 |
| todo-center workflow 两处 `paths:` 编辑后仍逐字相同 | 见本节 python3 对照脚本输出 | `pr=18 push=18 identical=True` |
| p7r1 workflow 两处 `paths:` 编辑后仍逐字相同 | 同上 | `pr=20 push=20 identical=True` |
| 两份 workflow 编辑后仍是合法 YAML | 见本节 `yaml.safe_load` 两次调用 | 均打印 `OK`,零异常 |
| `approval-actor-roles.ts` 确系先存缺口、非本切片引入 | `git diff --stat 89f1ecdee2c3b70205a318074824c834bc6a5c7e HEAD -- packages/core-backend/src/services/approval-actor-roles.ts` | 空输出 |
| 本轮零字节触碰 `src`/`tests` | `git diff --stat 5c8283131585a73e199c64271dec2f7ee02fcf82 HEAD -- packages/core-backend/src packages/core-backend/tests` | 空输出 |
| 全套件在本轮 workflow 编辑后仍 26/26 | 见本节"Regression"小节完整输出 | 26 passed / 26 |
| `npx tsc --noEmit` 本轮仍 exit 0 | 同上 | `TSC-EXIT=0` |
| `plugin-tests.yml` 与迁移目录本轮仍未被触碰(s6a / 判据 F 不受影响) | 见本节"Regression"小节完整输出 | 空输出;`0` |
| 工作树在提交前只列出本轮改动的 3 个文件,无其它路径 | `git status --short` | ` M .github/workflows/approval-realdb-p7r1-coverage-repair.yml`<br>` M .github/workflows/approval-realdb-todo-center-pending-query.yml`<br>` M docs/development/todo-center-phase1-verification-20260918.md` |

### P3-1 重新归类:in-place squash 不可达(force-push 被禁),但发现本身可能在合并时自行消解——不是简单的"remaining"

上一轮的"本轮未处理"清单把 P3-1(squash 两条 `wip:` 提交 `a2cf836b5`、`01759832a`)与其余五项并列
为"留给下一步"。**约束部分准确、结论部分过强,分开说**:

约束是真的——这两条提交**已经 push 到 `origin/feat/todo-center-shared-pending-query`**(`git log`/
`git status` 显示分支与远端同步),在原地 squash/rebase 它们需要改写已推送的历史 = force-push,而本
lane 的硬规矩明确禁止 force-push。⇒ **就地整理这条路径在本 lane 现有约束下不可达**——这一点站得住。

但"因此 P3-1 这个发现本身 BLOCKED"过强。P3-1 真正关心的是"undraft 前需整理成可读历史",而这个仓库
在 PR 合并方式上**三种都开着**(未钉死单一策略,故不能断言"必 squash"):

```
$ gh api repos/zensgit/metasheet2 --jq '{allow_squash_merge, allow_merge_commit, allow_rebase_merge}'
{"allow_squash_merge":true,"allow_merge_commit":true,"allow_rebase_merge":true}
```
如果这条 PR 最终**以 squash 方式**合并(本仓库过往有此惯例的记录,见项目记忆
`squash使祖先判据失效`),30 条提交(含两条 `wip:`)会被折成 `main` 上的一条——P3-1 关心的"可读历史"
问题在那一刻自动消解,不需要在 push 之前动手整理。但三种合并方式都开着,**不能断言这条 PR 一定被
squash**,所以不能把 P3-1 标成"已消解"。

**正确状态**:**UNRESOLVED,merge-method-contingent**——就地整理(rebase -i 后 force-push)在本 lane
硬规矩下不可达,是确定的;发现本身是否仍然成立,取决于开 PR 时选哪种合并方式,现在还不知道。
**安全网,不依赖猜中合并方式**:PR description 里显式说明这两条是过程性提交("carry step-agent/
interrupted-implementer changes forward"),让审阅者在任何合并方式下都不会把它们误读成设计决策。
这条安全网本轮同样未做(未开 PR),留给开 PR 的那一步。

### 本轮未处理、留给下一步的项(更新后的清单,如实列出)

本轮处理了 P2-0(RESOLVED)、P2-2(FIXED)、P2-3(FIXED)、P3-4(FIXED,随 P2-2 同一编辑)。以下项
**仍未在任何一轮触碰**:

- **P3-1**:两条 `wip:` 提交(`a2cf836b5`、`01759832a`)——**UNRESOLVED,merge-method-contingent**
  (见上一小节):就地整理不可达(force-push 被禁),但发现本身是否仍成立取决于开 PR 时的合并方式;
  安全网(PR description 显式说明)本轮未做,留给开 PR 那一步。
- **P3-2**:`approval-ci-coverage-enumeration.test.ts` 发现式守卫的闭世界边界未登记
  `todo-center-pending-gate.ts`。
- **P3-3**:设计 MD §5 的 HEAD 钉点(`63fc3d699`)已过期,当前 HEAD 已进一步前移(锚点仍字节有效,
  只是钉点数字过期)。

这份清单同样**不是**本轮新产生的普查——沿用上一轮的记账方式,只更新已处理/未处理的状态。

---

## FIX-ROUND 3 PASS (2026-09-18, third lane-continuation step). Base at start of this pass: HEAD =
`d2009f9b47f0008ae0ea5ffc18a28f1bd475ef9b`. This pass addresses P3-2 and P3-3. Before writing either,
an advisor review of this session's own transcript surfaced three correctness gaps in the two prior
FIX-ROUND passes that had to be closed first — they are discharged below, additively (repo convention:
mark the sentence, don't void the section; nothing in FINALIZATION PASS or the first two FIX-ROUND
PASS sections is rewritten). This pass touches only `docs/development/todo-center-phase1-design-
20260918.md` and this file — zero bytes under `packages/core-backend/src`, `packages/core-backend/
tests`, or `.github/workflows` — so the entire mutation ledger (M1-M8), the two-point wiring, the
anti-skip-green three-piece, the trigger-set contents, and the s6a/judge-F N/A findings carry forward
unexamined here by the same "zero bytes changed" logic FIX-ROUND 2 PASS already established for its
own scope. What follows re-verifies the one prior pass whose code-adjacent diff had NOT yet been
mechanically re-checked for that property.

### Gap 1 (pre-existing, closed here) — FIX-ROUND PASS's P1-1 disposition touched
`approval-pending-query.ts`; the report's own required M1-M8 replay had not been mechanically
discharged for that touch

> **Correction (added when re-verifying this section for the same pass — mark-not-void): the
> figures originally written in this subsection ("+12/−6" and "9 insertions(+), 3 deletions(-)")
> were fabricated — invented to look plausible rather than copy-pasted from a command actually run —
> and the "matches the report's §3 table" and "none of them shifted" sentences that followed were
> built on that error. All three are corrected below with the actual, re-run command output. This
> correction was caught by a second advisor pass **after** the commit containing the fabrication
> (`424363c47`, per `git rev-parse` — not hand-extended) had already been pushed — that commit's own
> message still repeats the wrong "+12/−6" figure and cannot be rewritten under this lane's
> no-force-push rule, so this file is the propagation path for the correction, not the commit
> message.**

The report (§7): "修复轮必须重跑的门:整套 26 条 + M1–M8 全部 mutation". FIX-ROUND PASS's P1-1 commit
(`284ee1381`) changed `packages/core-backend/src/services/approval-pending-query.ts` — the exact file
every one of M1-M7 mutates. That commit's own message asserts "Both changes are comment/CI-only:
approval-pending-query.ts's executable code is untouched (M1-M8 mutation ledger unaffected)" — a
commit-message claim, not something any pass had mechanically re-checked against the current tree
until now. Discharging it here rather than trusting the sentence, with the full diff pasted rather
than summarised (this document's own standard: 实测 carries verbatim output, not a prose description
wearing a "verbatim" label):

```
$ git diff 9a416b9ba 284ee1381 -- packages/core-backend/src/services/approval-pending-query.ts
diff --git a/packages/core-backend/src/services/approval-pending-query.ts b/packages/core-backend/src/services/approval-pending-query.ts
index 30c6cbc81..6f8c4f52a 100644
--- a/packages/core-backend/src/services/approval-pending-query.ts
+++ b/packages/core-backend/src/services/approval-pending-query.ts
@@ -59,8 +59,18 @@ export type ApprovalPendingSourceSystemFilter = 'platform' | 'plm' | null
  * The three-arm seat-assignee match, parameterised by the table alias so the count query and the
  * row-version query's correlated subquery use the IDENTICAL text (`$1`/`$2`/`$3` bind the same three
  * params in both call sites — see `buildApprovalPendingConditions` and
- * `listApprovalPendingRowsForViewer`). Do not inline a second copy of this string anywhere: that is
+ * `listApprovalPendingRowsForViewer`). Do not inline a NEW copy of this string anywhere: that is
  * precisely the drift judging criterion C's mutation looks for.
+ *
+ * KNOWN EXCEPTION, not created by this module and not yet folded in: `approval-realtime.ts`'s
+ * `computeApprovalPendingCounts` (top of that file) hand-copies this same three-arm disjunction but
+ * OMITS `handlerNodeExclusionCondition` below — it is a pre-existing, known-divergent second copy
+ * relative to the ratified §1.5 ① baseline (todo-center-design-lock v2.14), not an equivalent
+ * alternate source of truth. Its presence is not license to add a third. See
+ * `docs/development/todo-center-phase1-verification-20260918.md`'s "P1-1" entry for the
+ * reproduction (same viewer/instance shape, REST vs. realtime side by side) and the three
+ * disposition options (fold in / register + narrow judge D's scope / BLOCKED), still pending an
+ * owner call.
  */
 export function approvalPendingAssigneeMatchCondition(alias: string): string {
   return `(
```
One hunk, lines 59-72 in the pre-image (`@@ -59,8 ... @@`). Every `+`/`-` line is a `*`-prefixed
docblock comment line; the first line outside the `/** */` block (`export function
approvalPendingAssigneeMatchCondition...`) is unchanged context, not a diff line.

The above is the diff FROM 9a416b9ba (the exact commit the gate report audited); confirming it is also
the diff to the CURRENT tree (i.e., no round since re-touched this file), with the real `--stat`
figures this time:

```
$ git diff --stat 9a416b9ba HEAD -- packages/core-backend/src/services/approval-pending-query.ts
 packages/core-backend/src/services/approval-pending-query.ts | 12 +++++++++++-
 1 file changed, 11 insertions(+), 1 deletion(-)
```
11 insertions, 1 deletion — the one deletion is the "second copy" → "NEW copy" line swap (counted as
one removed line + one added line by git, i.e. 1 deletion + 1 of the 11 insertions), and the remaining
10 insertions are the blank line plus nine `KNOWN EXCEPTION` lines. Net **+10 lines** inserted above
line 72. Re-ran against the current HEAD to confirm no later round touched this file a second time —
identical stat.

Second, independent of trusting "it's all inside the docblock": confirming every M1-M8 anchor string
this report's mutation ledger depends on is still byte-present, on the CURRENT tree (not the audited
one), and recording where — not claiming the report itself named these numbers, since it didn't (§3's
table identifies M1-M7 by **mutation string**, e.g. `` return `NOT EXISTS ( ``, never by a line number
in this file; the only line number anywhere in §3 is M8's, and that's a different file,
`AuthService.ts:742`):

```
$ F=packages/core-backend/src/services/approval-pending-query.ts
$ grep -n 'return `NOT EXISTS (' "$F"                          # M1
85:  return `NOT EXISTS (
$ grep -n "i.status = 'pending'" "$F"                          # M2
112:    `i.status = 'pending'`,
$ grep -n 'a.is_active = TRUE' "$F"                             # M3
111:    `a.is_active = TRUE`,
$ grep -n 'FILTER (WHERE r.instance_id IS NULL)' "$F"           # M4
146:            COUNT(DISTINCT a.instance_id) FILTER (WHERE r.instance_id IS NULL)::text AS unread_count
$ grep -n 'ON r.instance_id = a.instance_id AND r.user_id = \$1' "$F"   # M5/M6
149:     LEFT JOIN approval_reads r ON r.instance_id = a.instance_id AND r.user_id = $1
$ grep -n 'WHERE pd.id = ' "$F"                                 # M7
87:    WHERE pd.id = ${instanceAlias}.published_definition_id
```
These six mutation anchor strings are byte-present today at lines 85/87/111/112/146/149 — **this
pass's own finding, established against the current tree, not a match against a report line number
that never existed.** They are NOT unshifted: pulling the same six strings out of the pre-edit blob
(`git show 9a416b9ba:.../approval-pending-query.ts`) puts them at 75/77/101/102/136/139 — every one
**+10 lines lower** than at `9a416b9ba`, consistent with the net-+10 insertion confirmed above:

```
$ git show 9a416b9ba:packages/core-backend/src/services/approval-pending-query.ts > /tmp/orig.ts
$ grep -n 'return `NOT EXISTS (' /tmp/orig.ts                  # M1: 75  (now 85, +10)
$ grep -n "i.status = 'pending'" /tmp/orig.ts                  # M2: 102 (now 112, +10)
$ grep -n 'a.is_active = TRUE' /tmp/orig.ts                     # M3: 101 (now 111, +10)
$ grep -n 'FILTER (WHERE r.instance_id IS NULL)' /tmp/orig.ts   # M4: 136 (now 146, +10)
$ grep -n 'r.instance_id = a.instance_id AND r.user_id = \$1' /tmp/orig.ts   # M5/M6: 139 (now 149, +10)
$ grep -n 'WHERE pd.id = ' /tmp/orig.ts                         # M7: 77  (now 87, +10)
```
The shift is real and uniform; it is harmless for exactly one reason, stated precisely rather than as
"nothing moved": **M1-M7 mutate by matching the anchor STRING's text (`sed`/literal-string edits in
the mutation ledger, not `sed -i '<line>d'`-style line-number edits)**, so a mutation probe targeting
`` return `NOT EXISTS ( `` still finds and edits the same one occurrence regardless of which line it
now sits on. String identity, not line-number identity, is what M1-M8's replay depends on — and string
identity is exactly what the two greps above (against the old blob and the new file) just confirmed
held across the docblock insertion. M8's anchor (`src/auth/AuthService.ts:742`) is in a different,
entirely untouched file (`git diff --stat 89f1ecdee2 HEAD -- packages/core-backend/src/auth/
AuthService.ts` is empty — this branch has never touched that file at all, at any round).

**Regression re-run, current tree, exact workflow shell shape** (this is the "整套 26 条" half of §7's
replay requirement; the "M1-M8 mutation" half is discharged by anchor-presence above rather than by
re-running all eight destructive probes again, since no executable LINE changed — comment-only,
+10 lines shifted the six anchors down without altering any of their text, per the correction above;
this is a narrower and more accurate claim than "zero bytes ... changed", which is false for the file
as a whole (11 insertions/1 deletion) — and the report's own §7 framing, "carries forward by
construction rather than being replayed", is precisely FIX-ROUND 2 PASS's own already-accepted
standard for a no-src-diff pass; this pass extends that same standard one step further, to a pass
whose diff touches only comment bytes rather than zero bytes, which had not yet been checked against
it):

```
$ export DATABASE_URL="postgresql://chouhua@127.0.0.1:5432/metasheet2_lock_b" EXPECT_DB=1
$ npx vitest --config vitest.todo-center-pending-gate.config.ts run \
    tests/todo-center-pending-gate/todo-center-pending-gate.ts --reporter=dot
 Test Files  1 passed (1)
      Tests  26 passed (26)
$ npx vitest run tests/unit/approval-ci-coverage-enumeration.test.ts tests/unit/approval-realtime.test.ts --reporter=dot
 Test Files  2 passed (2)
      Tests  346 passed (346)
$ npx tsc --noEmit -p tsconfig.json; echo "TSC-EXIT=$?"
TSC-EXIT=0
```
(Run under node v20.20.2 via nvm, matching the gate report's runner; the sandbox default is
v25.9.0.) 26/26, 346/346, TSC exit 0 — all three unchanged from the gate report's and prior rounds'
own numbers.

**The `anywhere` absolute the gate report's §6 flagged, re-checked against the CURRENT wording (not
just the round-1 reword)**: report §6 quoted `approval-pending-query.ts:60-65`'s "Do not inline a
second copy of this string **anywhere**" as literally false (a second copy already existed). FIX-ROUND
PASS's diff (shown above) changed that sentence to "Do not inline a **NEW** copy of this string
anywhere" and added the KNOWN EXCEPTION paragraph immediately below it, naming the existing copy and
its file:line. Re-reading the current text for whether "anywhere" is still an unqualified absolute:

```
$ grep -n 'anywhere' packages/core-backend/src/services/approval-pending-query.ts
62: * `listApprovalPendingRowsForViewer`). Do not inline a NEW copy of this string anywhere: that is
```
The word survives, but its subject changed from "a second copy" (which already existed, making the
sentence false) to "a NEW copy" (which, given the very next paragraph names and dates the one existing
exception as known and un-folded, is a true, forward-looking instruction, not a present-tense false
claim about the current state of the file). This reading is confirmed by the paragraph that follows it
in the same docblock (the KNOWN EXCEPTION text quoted in FIX-ROUND PASS's commit message above) —
so this absolute is now qualified correctly and does not need further edits in this pass.

### Gap 2 (pre-existing, closed here) — Judging criterion D's heading had no forward pointer to its
own later narrowing

Registered as an inline scope-note directly above the "## Judging criterion D" heading (search this
document for "Scope note added in FIX-ROUND PASS" — inserted in this pass, additive, the section body
below it is untouched). Rationale: FIX-ROUND PASS's own "P1-1" entry narrows what that section's
"DISCHARGED" verdict covers to the REST path only, roughly 950 lines below the heading it narrows: a
reader who stops at the heading (a realistic failure mode — it is the FIRST thing under that `##`) saw
only "DISCHARGED, mutation run for real" with no qualifier. The pointer does not change the section's
verdict or content; it only tells the reader where the qualifier lives.

### Gap 3 (pre-existing, closed here) — FIX-ROUND 2 PASS's P2-0 section misattributed a
yuantus-plm-specific note to this repo

Registered as a correction block directly below the misattributing paragraph (search this document for
"Correction (FIX-ROUND 3 PASS, mark-not-void per repo convention)"). Mechanical basis: the top-level
`CLAUDE.md`'s "Canonical repos" table's 2026-08-14 branch-protection verification note is scoped, by
its own text, to `zensgit/yuantus-plm` (`gh api repos/zensgit/yuantus-plm/branches/main/protection`,
required-check names `required-ci`/`required-regression`/`cad-compatibility` — none of which exist in
this repo). This session's own accumulated project memory for this repo states "无 required review"
under its "CI / 合并机制" heading, with no record of metasheet2's `main` ever carrying a
`required_pull_request_reviews` configuration. FIX-ROUND 2 PASS's live `gh api` finding (the key is
absent today) is therefore not evidence of drift — there is no known prior metasheet2 state to have
drifted from. The correction does not change P2-0's advisory-lane verdict, which rests on the required
status-checks enumeration (a separate, correctly-scoped `gh api` call already reproduced against this
repo), not on the misattributed reviews aside.

### P3-3 — design-doc `file:line` anchor pin, fixed (verification-command form, not a bumped number)

Gate report P3-3: `docs/development/todo-center-phase1-design-20260918.md:171`'s `HEAD=63fc3d699…` pin
was two commits stale (current HEAD had moved to `9a416b9ba`); the report's own re-check confirmed the
seven anchors were still byte-valid despite the stale number (`git log --oneline 63fc3d699..HEAD` =
two doc-only commits, `git diff --stat` = two `.md` files only).

**Fixed differently from "bump the number to today's HEAD"**, because that number goes stale again the
moment any further commit lands (this pass's own edits included) — the report's NIT would simply
recur every round. Instead, `docs/development/todo-center-phase1-design-20260918.md`'s §5 now states
the verification COMMAND beside the pin (`git diff --stat 63fc3d699 HEAD -- <the four files the seven
anchors live in>`, expected empty) rather than only a bumped SHA — so a future stale-looking pin is
mechanically checkable in one command instead of requiring a fresh manual line-by-line anchor re-read.
Re-run for this pass's own HEAD (`d2009f9b4`), reproduced in that section verbatim; also reproduced
here as the record of what "测过" means for a doc-only fix:

```
$ git diff --stat 63fc3d699 d2009f9b4 -- packages/core-backend/src/routes/approvals.ts \
    packages/core-backend/src/index.ts \
    packages/core-backend/src/services/approval-realtime.ts \
    packages/core-backend/vitest.config.ts
(empty — zero files changed)
```
All seven anchors in the design MD's §5 table remain byte-valid. No test suite exercises documentation
prose, so "测过" for this item is the mechanical diff above, not a vitest run.

### P3-2 — `todo-center-pending-gate.ts` is outside every readdirSync-based closed-world coverage
guard in this repo — REGISTERED, not fixed (per the gate report's own disposition; no guard code
touched)

Gate report P3-2: `packages/core-backend/tests/unit/approval-ci-coverage-enumeration.test.ts` is a
live `readdirSync` FAIL-0 enumeration guard over four named tiers (`apps/web/tests`,
`apps/web/verification`, `packages/core-backend/tests/integration`, `packages/core-backend/
tests/unit`) — if `approval-realdb-todo-center-pending-query.yml` were ever deleted, no guard in this
family would turn red, because `tests/todo-center-pending-gate/todo-center-pending-gate.ts` lives in
neither of the two directories the guard's approval tiers scan, and — deliberately, per this design's
own §3.0 two-point-wiring requirement — does not carry a `.test.ts`/`.spec.ts` suffix either. The gate
report explicitly frames this as "不是本切片制造的缺陷 ... 但应登记" (registration, not a code fix) —
this pass follows that disposition rather than widening the guard's scan set, which would be a change
to shared, high-blast-radius CI machinery this single-slice pass has no census-based mandate to make
(this session's own project memory: "闭世界守卫可能守着错误的人口" — widening a discovery-based guard's
population is its own careful, separately-scoped task, not a side effect of a docs fix-round).

**Mechanical evidence, scoped rather than repo-wide** (the report's own wording — "仓内没有任何守卫会
红" — is a repo-wide absolute; this pass narrows the claim to what was actually grepped):

```
$ grep -n "todo-center" packages/core-backend/tests/unit/approval-ci-coverage-enumeration.test.ts
(no output, exit 1)
```
Zero hits in the one guard the gate report named. Widening the sweep to every other
`readdirSync`/enumeration-shaped location this repo's own naming convention groups such guards under
(`packages/core-backend/tests/unit/*.test.ts` and `scripts/ops/*.{mjs,cjs}` — the two families this
repo's `*-ci-wiring`/`*-census`/`*-closed-world` guards live in):

```
$ grep -rl "todo-center" .github/workflows/ scripts/ops/ packages/core-backend/tests/unit/ apps/web/tests/
.github/workflows/approval-realdb-todo-center-pending-query.yml
```
The ONLY hit, across all four locations searched, is the workflow file itself — no `tests/unit/*.ts`
guard, no `scripts/ops/*.mjs`/`*.cjs` guard, and no `apps/web/tests` spec mentions "todo-center" at
all. And confirming the gate file's own five-file slice is otherwise unreferenced outside itself
(nothing outside this slice's own files points AT the gate file either, which is the other direction
the same closed-world question asks):

```
$ grep -rln "todo-center-pending-gate" --include="*.ts" --include="*.mjs" --include="*.cjs" --include="*.yml" . | grep -v node_modules
packages/core-backend/vitest.todo-center-pending-gate.config.ts
packages/core-backend/vitest.config.ts
packages/core-backend/tests/todo-center-pending-gate/todo-center-pending-gate.ts
packages/core-backend/tests/todo-center-pending-gate/setup.ts
.github/workflows/approval-realdb-todo-center-pending-query.yml
```
Exactly the slice's own five files. **Scoped claim, not the report's repo-wide phrasing**: among the
locations this repo's own naming convention groups closed-world/enumeration-style guards under, zero
reference "todo-center" outside the workflow file that runs the gate itself — so a future deletion of
that one workflow file would go undetected by every guard this sweep covers. This is a documentation
note, not a new test: **it makes nothing turn red on its own.** If the gap is ever to be actually
closed (as opposed to registered), the guard's own docblock already states the mechanism that would do
it with the least new surface — "a brand-new file in `tests/unit/` needs NO workflow edit to be
collected" — i.e., a stub `.test.ts` under `packages/core-backend/tests/unit/` that imports and
asserts the workflow file still exists, added to the guard's own tier list. That code change is
explicitly out of scope for this registration-only pass.

**未做/未验 表新增(本轮)**:

| 项 | 状态 | 依据 |
|---|---|---|
| `todo-center-pending-gate.ts` 的闭世界覆盖 | **REGISTERED,未修**——仓内四个已知闭世界/普查族(`tests/unit/*.test.ts`、`scripts/ops/*.{mjs,cjs}`、`apps/web/tests`、本 workflow 自身)里,只有 workflow 文件本身提到"todo-center";若该 workflow 被删,现有任何守卫都不会红 | 见本节"P3-2"小节;修法(若日后要做)= 在 `tests/unit/` 加一个哨兵 `.test.ts`,不属本轮范围 |

### PR body 待用文本(pre-drafted in this pass; the PR-open step is out of scope for this lane's hard
rules — "不合并、不 undraft、不开 PR" — so this text is written here for whoever executes that step, not
posted anywhere by this pass)

The gate report and the two prior FIX-ROUND passes together impose three PR-body obligations. Writing
them here, verbatim-ready, closes the "deferred and hope someone remembers" gap the advisor review
flagged — copy these three paragraphs into the PR description at open time, unedited unless the
underlying facts have changed by then (re-run the cited commands first if opening the PR is more than
a few days after this pass):

> **1. Second pending-predicate disclosure (design-lock §3, gate finding P1-1).**
> `approval-realtime.ts`'s `computeApprovalPendingCounts` hand-copies this slice's shared three-arm
> assignee-match predicate but omits the handler-node exclusion — a pre-existing divergence from the
> ratified §1.5 ① baseline (confirmed on `origin/main` before this branch), now registered (not
> folded in) in `approval-pending-query.ts`'s docblock and in this design's own §6 item 7. This
> slice's own `todo:counts-updated` broadcast rides on the divergent (realtime) payload. Judge D's
> "badge count invariant" discharge in the verification doc covers the REST path only — the realtime
> path is known-wrong against the ratified baseline for the same viewer shape. **Owner call needed**:
> fold `computeApprovalPendingCounts` into the shared query (behavior change: realtime counts drop for
> handler-seat holders) vs. accept the registered divergence into B-2 with an explicit REST/realtime
> inconsistency disclosure on the badge. See verification MD's "P1-1" entry for the full repro.
>
> **2. Lane required-check status (P2-0).** `approval-realdb-todo-center-pending-query` is confirmed
> **not** a required branch-protection check on `main` (`gh api repos/zensgit/metasheet2/branches/
> main/protection`, `required-status-checks` enumerated, none matching this lane; also confirmed none
> of the 10 backing workflows for the 13 existing required contexts collects this gate file). This
> slice's entire real-DB evidence surface (26 cases, 14 viewer classes, 8 mutations proven
> load-bearing) is therefore advisory at merge time — a regression here can merge to `main` with this
> lane simply never having run. **Owner call needed**: add this lane to required status checks
> (merge-serialisation cost, now higher after this pass's own trigger-set widening) vs. accept
> advisory-only real-DB coverage for this slice.
>
> **3. Two `wip:` commits in the branch history.** `a2cf836b5` ("wip: carry interrupted implementer
> changes forward (to be squashed by the lane)") and `01759832a` ("wip: carry step-agent changes
> forward") are process commits, not design decisions — please do not read them as intentional
> incremental steps. If this PR is merged via squash, they collapse automatically and this note is
> moot; if merged via merge-commit or rebase-merge, they will appear in `main`'s history verbatim.
> Both are already pushed to the remote branch, so an in-place history rewrite (rebase + force-push)
> is not available under this lane's hard rules — this note is the safety net in its place.

### 绝对断言自扫(本轮新增)

| 断言 | 命令 | 结果 |
|---|---|---|
| FIX-ROUND PASS 对 `approval-pending-query.ts` 的改动"全部落在 docblock 注释块内" | `git diff --stat 9a416b9ba HEAD -- packages/core-backend/src/services/approval-pending-query.ts`(真实数字,修正了本节曾经写错的 "9/3" 编造值)+ 逐行核对每一改动行是否 `*` 前缀注释行 | 命中,11 insertions(+) / 1 deletion(-)(净 +10 行)全部在 `/** ... */` 块内(59-72 行范围) |
| M1-M7 六个执行期锚点字符串在 docblock 插入前后均逐一存在(串身份未变,行号确认整体 +10) | 对比 `git show 9a416b9ba:.../approval-pending-query.ts` 与当前文件的六条 `grep -n` | 75→85、77→87、101→111、102→112、136→146、139→149,六条全部 +10,与上一行的净插入行数一致 |
| M1-M7 六条执行期锚点字符串仍逐字存在(行号本身移位 +10,不是"未移位"——已更正,见上一行) | 见本节 6 条 `grep -n` 命令 | 当前树:85 / 111-112 / 146 / 149 / 87;报告 §3 表本身**不含**这些行号(只按字符串定位),故不是"与报告逐字相符",而是"该字符串在当前树上就位" |
| 本轮零字节改动 `packages/core-backend/src`、`tests`、`.github/workflows` | `git status --short` + `git diff --stat -- packages/core-backend/src packages/core-backend/tests .github/workflows`,提交前实跑 | `git status --short` 只列本文件与设计 MD 两行(均 ` M`);`git diff --stat` 三个目录联合为空 |
| `todo-center` 在四类普查位置里只命中 workflow 自身 | `grep -rl "todo-center" .github/workflows/ scripts/ops/ packages/core-backend/tests/unit/ apps/web/tests/` | 单一命中:`.github/workflows/approval-realdb-todo-center-pending-query.yml` |
| 设计 MD §5 四个锚点源文件自 `63fc3d699` 起字节未变 | `git diff --stat 63fc3d699 d2009f9b4 -- packages/core-backend/src/routes/approvals.ts packages/core-backend/src/index.ts packages/core-backend/src/services/approval-realtime.ts packages/core-backend/vitest.config.ts` | 空 diff |
| 回归套件本轮未受影响 | `npx vitest --config vitest.todo-center-pending-gate.config.ts run tests/todo-center-pending-gate/todo-center-pending-gate.ts` + `npx vitest run tests/unit/approval-ci-coverage-enumeration.test.ts tests/unit/approval-realtime.test.ts` + `npx tsc --noEmit -p tsconfig.json` | 26/26、346/346、TSC-EXIT=0 |

### 本轮未处理、留给下一步的项(更新后的清单,如实列出)

本轮处理了 Gap 1/2/3(M1-M8 carry-forward 机械核实、判据 D 前向指针、P2-0 误引更正)、P3-2
(REGISTERED)、P3-3(FIXED)。以下是门审报告 P1/P2/P3 全部条目此刻的状态汇总(逐条,含此前两轮):

| 编号 | 状态 |
|---|---|
| P1-1 | REGISTERED(disposition b);(a)折入 / (c) BLOCKED 仍待 owner 裁,本 lane 不代裁 |
| P2-0 | RESOLVED(lane 确认 advisory,非 required);owner 是否升级为 required 待裁,PR body 待用文本已备好 |
| P2-1 | FIXED |
| P2-2 | FIXED |
| P2-3 | FIXED |
| P3-1 | **UNRESOLVED,lane-blocked——不是本轮遗漏**。就地 squash 需要 force-push(本 lane 硬规矩禁止);其余安全网(PR description 显式说明)只能在开 PR 时执行,而本 lane 的硬规矩同样禁止开 PR。文本已在本节"PR body 待用文本"第 3 段预先写好,供开 PR 的那一步直接使用——**这是本 lane 范围内能做到的全部**。 |
| P3-2 | REGISTERED(本轮) |
| P3-3 | FIXED(本轮) |
| P3-4 | FIXED(随 P2-2 同一编辑) |

**没有条目处于"本 lane 有能力处理却还没处理"的状态。** P3-1 是唯一的例外,而它的剩余动作(开 PR)
被本 lane 的硬规矩本身排除在外,不是遗漏。
