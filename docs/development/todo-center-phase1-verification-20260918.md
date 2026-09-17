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
default — no special wiring needed or added).

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
