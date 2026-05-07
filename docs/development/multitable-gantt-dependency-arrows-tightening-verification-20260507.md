# Multitable Gantt Dependency Arrows — Tightening to Link Fields · Verification

> Date: 2026-05-07
> Companion to: `multitable-gantt-dependency-arrows-tightening-development-20260507.md`

## Targeted vitest

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-gantt-view.spec.ts --reporter=dot
```

Result:

```
 RUN  v1.6.1 /private/tmp/ms2-gantt-deps-20260507/apps/web

 ✓ tests/multitable-gantt-view.spec.ts  (12 tests) 52ms

 Test Files  1 passed (1)
      Tests  12 passed (12)
   Start at  06:05:11
   Duration  514ms (transform 83ms, setup 0ms, collect 103ms, tests 52ms, environment 236ms, prepare 36ms)
```

Pre-existing tests covered: defaults, dependency field config, grouped task bars, dependency arrow rendering, resize handle emit, read-only resize hiding, toolbar config emit. (7 tests)

New tests added by this PR:

1. `rejects non-link fields configured as dependencyFieldId` — verifies link is accepted; multiSelect / string / select all resolve to `null`.
2. `only lists link fields in the dependency dropdown` — DOM check on the toolbar select element shows only link field labels.
3. `filters self-dependencies and skips dependencies whose record is missing` — task lists itself + nonexistent record; zero arrows rendered.
4. `renders one arrow per predecessor when a task has multiple dependencies` — two predecessors → two arrows, both titles correct.
5. `renders both arrows for a cycle (A->B->A) without crashing or recursing` — bidirectional dependency → two arrows total, exactly one carries the `--backward` modifier class.

(5 new tests, total 12)

## Frontend type check

```bash
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
```

Result: passed (no output).

## Diff hygiene

```bash
git diff --check
```

Result: passed (no whitespace errors).

## Scoped diff summary

```
apps/web/src/multitable/components/MetaGanttView.vue       |   2 +-
apps/web/src/multitable/utils/view-config.ts               |   2 +-
apps/web/tests/multitable-gantt-view.spec.ts               | 203 +++++++++++++++++++++
```

`pnpm install --frozen-lockfile` in the worktree caused incidental symlink rewrites under `plugins/*/node_modules/.bin/*` and `tools/cli/node_modules/.bin/*`; these are install artifacts and are not staged in this commit (only the four scoped files are added explicitly).

## OpenAPI parity

Not affected. View config types are not part of OpenAPI schemas (`MultitableViewType` enum lists `gantt`, but `MetaGanttViewConfig` is a frontend-resolved shape). No `openapi:check` or `verify:multitable-openapi:parity` regeneration required.

## Backend impact

None. Backend persists view config as JSONB blob without schema-level validation; `resolveGanttViewConfig` on the frontend is the canonical normalization layer and gracefully scrubs stale fields.

## Migration impact

None. Schema unchanged. Existing user data with non-link dependency fields will see the dropdown reset to "none" on next view load; their persisted `dependencyFieldId` value remains in storage but is normalized to `null` at read time by `resolveGanttViewConfig`.

## Pre-deployment checks

- [x] PR #1406 autoNumber hardening status verified before rebase: still OPEN at time of this verification doc; this branch will need to rebase to `main` after #1406 merges.
- [x] No DingTalk, public-form, or `plugins/plugin-integration-core/*` files modified.
- [x] No autoNumber-related files modified (verified via `git diff --name-only origin/main`).
- [x] K3 PoC Stage 1 Lock applicability documented in development MD §K3 PoC Stage 1 Lock applicability.

## Manual sanity

Manual reproduction in development environment is recommended after merge:

1. Open a Gantt view with two date fields and one self-table link field.
2. Configure the link field as `dependencyFieldId` from the toolbar.
3. Confirm only link-typed fields appear in the dropdown.
4. Add a record A with link to B and B with link to A; confirm two arrows render, no console errors, no infinite scrolling/freezing.
5. Add a record C with link to a deleted record D; confirm no arrow renders for C, no console errors.

(Manual sanity is documented but not gated; targeted vitest provides the regression net.)

## Result

All gates green. PR ready to open against `main` once PR #1406 (autoNumber hardening) is merged and this branch is rebased.
