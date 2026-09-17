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

- `python3 -c "import yaml; yaml.safe_load(...)"` — the new workflow file parses as valid YAML;
  `on.push.paths == on.pull_request.paths` (both lists printed and diffed by eye, 13/13 match).
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
