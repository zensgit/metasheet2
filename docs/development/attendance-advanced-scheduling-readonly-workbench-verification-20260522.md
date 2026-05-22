# Attendance Advanced Scheduling Read-Only Workbench Verification

Date: 2026-05-22
Branch: `codex/attendance-advanced-scheduling-readonly-workbench-20260522`

## Scope Verification

| Area | Result |
| --- | --- |
| Runtime domain | Attendance only |
| Data Factory / Bridge Agent | Not touched |
| New migration | None |
| Schedule write path | None added |
| Direct `meta_*` writes | None |
| Multitable writes | None |
| Secrets / tokens | None |

## Boundary Evidence

| Boundary | Evidence |
| --- | --- |
| Workbench is read-only | Backend adds only `GET /api/attendance/advanced-scheduling/workbench`; tests assert no sibling `POST` / `PUT` / `DELETE` route. |
| Admin-only | Backend route is wired through `withPermission('attendance:admin', ...)`; tests assert the route guard. |
| Existing write guards untouched | Existing shift/rotation/assignment write routes and conflict guards are not changed. |
| Scheduling group foundation consumed, not redefined | The workbench reads PR1 schedule group/member/scheduler-scope tables and does not add new schema. |
| Frontend has no write controls | Regression test asserts the workbench section contains Reload but no Create/Edit/Delete controls. |
| Existing admin navigation preserved | Anchor-nav tests verify the new section joins the existing Scheduling rail and quick jump. |

## Test Commands

```bash
node --check plugins/plugin-attendance/index.cjs

pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-advanced-scheduling-workbench.test.ts \
  tests/unit/attendance-advanced-scheduling-scope.test.ts \
  tests/unit/attendance-scheduling-assignment-conflict.test.ts \
  --reporter=dot

NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run \
  tests/attendance-admin-anchor-nav.spec.ts \
  tests/attendance-admin-regressions.spec.ts \
  --watch=false

pnpm --filter @metasheet/web type-check

pnpm --filter @metasheet/core-backend build

git diff --check
```

## Results

| Check | Result |
| --- | --- |
| Plugin syntax | PASS |
| Backend advanced scheduling tests | PASS, 13 tests |
| Frontend admin nav + regression tests | PASS, 34 tests |
| Web type-check | PASS |
| Core backend build | PASS |
| `git diff --check` | PASS |

## Merge Closeout - 2026-05-22

| Check | Result |
| --- | --- |
| Independent review | PASS; reviewer verified GET-only backend, no write controls, bounded diagnostics, and admin rail regression coverage. |
| GitHub checks | PASS; non-strict checks succeeded and Strict E2E was skipped by repository rule. |
| Merge status | `#1755` merged as `f560b0c62a2625e21395494bf089f7d6c29ad437`. |
| Product boundary | Closed as a read-only scheduling data-quality dashboard. It does not authorize grid edit, copy/paste, Excel import, temporary shift, scheduler write-scope, or dispatch PRs. |

## Notes

- The isolated worktree needed `pnpm install --ignore-scripts` before package
  tests. That produced unrelated tracked `node_modules` symlink noise under
  plugin/tool directories. Commit staging must explicitly list only this slice's
  files and must not use `git add -A`.
- The frontend Vitest run printed `WebSocket server error: Port is already in
  use`, but both targeted spec files completed successfully. This is recorded
  as a test-environment warning, not a product regression.
- No live staging/prod operation was run for this slice. The route is read-only,
  and live evidence can be added later once staging has schedule groups,
  assignments, and scheduler scopes seeded.
