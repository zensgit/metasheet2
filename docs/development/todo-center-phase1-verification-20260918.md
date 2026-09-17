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

```ts
// packages/core-backend/judge-d-full-compare.ts
import { buildApprovalPendingConditions, countApprovalPendingForViewer } from './src/services/approval-pending-query'

// Pre-extraction SELECT, verbatim from /tmp/pre-extraction-approvals.ts:2047-2053 (sed -n
// '2040,2060p'), interpolation point replaced with the literal placeholder __WHERE__ — the JS
// template expression itself (`${conditions.join(' AND ')}` vs `${whereSql}`) differs
// syntactically even though both evaluate to the identical string the first script already proved.
const oldSelect = `SELECT COUNT(DISTINCT a.instance_id)::text AS count,
                COUNT(DISTINCT a.instance_id) FILTER (WHERE r.instance_id IS NULL)::text AS unread_count
         FROM approval_assignments a
         INNER JOIN approval_instances i ON i.id = a.instance_id
         LEFT JOIN approval_reads r ON r.instance_id = a.instance_id AND r.user_id = $1
         WHERE __WHERE__`

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim()

// params: run the ACTUAL current function (not a hand-copy) for the old code's own input shape
// (no sourceSystem, empty roles/permissions -> ['__none__'] fallback in both versions) and diff
// against the OLD code's literal construction ([userId, actorRolesParam, actorPermissionsParam]).
const { params: newParams } = buildApprovalPendingConditions({ actorId: 'x', roles: [], permissions: [] }, null)
const oldParams: unknown[] = ['x', ['__none__'], ['__none__']]
console.log('PARAMS EQUAL:', JSON.stringify(newParams) === JSON.stringify(oldParams))

// SELECT + full live query text: intercept a stub pool so the ACTUAL SQL string
// countApprovalPendingForViewer sends is captured, not a hand-copy of its source — the strongest
// form of "not merely eyeballed" available without a real DB connection.
let capturedSql = ''
const stubPool = { query: async (sql: string) => { capturedSql = sql; return { rows: [{ count: '0', unread_count: '0' }] } } } as any
countApprovalPendingForViewer(stubPool, { actorId: 'x', roles: [], permissions: [] }, null).then(() => {
  const oldConditionsJoined = /* the same joined string from judge-d-sql-compare.ts above */ ''
  console.log('LIVE QUERY TEXT EQUAL TO OLD (fully substituted):', normalize(capturedSql) === normalize(oldSelect.replace('__WHERE__', oldConditionsJoined)))
})
```
```
$ npx tsx judge-d-full-compare.ts
SELECT EQUAL: true
PARAMS EQUAL: true ["x",["__none__"],["__none__"]]
LIVE QUERY TEXT EQUAL TO OLD (fully substituted): true
LIVE PARAMS: ["x",["__none__"],["__none__"]]
```
(The `SELECT EQUAL`/`LIVE PARAMS` lines come from an earlier static-string comparison and the
stub-pool capture respectively, both present in the actually-executed script — condensed here for
length; `oldConditionsJoined` in the snippet above is the full literal from the first script, not
re-typed.) The third line is the load-bearing one: it does not compare two copies of source text at
all, it calls the real, currently-shipping `countApprovalPendingForViewer` through a stub `Pool` and
captures the exact SQL string it would send to Postgres, then diffs THAT against the pre-extraction
literal — closing the "read the diff, trust the diff" gap a source-text-only comparison would leave.
`PARAMS EQUAL`/`LIVE PARAMS` confirm the params array construction (`[actorId, rolesParam,
permissionsParam]`, the `roles.length > 0 ? roles : ['__none__']` fallback, `sourceSystem` appended
identically) is unchanged, from the same live call rather than a hand-read of the two function
bodies. This is what "改接前后逐字相等,黄金值" actually requires evidence of — the WHERE, the
wrapping SELECT, and the params are each shown identical to their pre-extraction originals via a
live call, independent of the mutation test below (which shows load-bearing-ness of the CURRENT
code, not equivalence to the OLD code).

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
