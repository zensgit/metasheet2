# Multitable RC Gantt Smoke · Development

> Date: 2026-05-07
> Branch: `codex/multitable-rc-smoke-gantt-20260507`
> Base: `origin/main@9de886a29` after reviewer rebase
> Closes RC TODO item: `Smoke test Gantt view rendering`

## Background

PRs #1415 / #1417 / #1419 shipped the first three executable RC smoke specs (lifecycle, public-form, hierarchy). This PR forks the same template for the **Gantt view rendering** RC TODO item — the fourth of the original six. Unlike the previous specs, Gantt's value is in two visual surfaces (bars + dependency arrows) and a backend invariant landed in PR #1412 (`validateGanttDependencyConfig`, asserting `dependencyFieldId` must be a self-table link). All three are exercised here.

The Gantt feature itself has shipped over multiple commits:
- `2651ab971` initial Gantt view
- `d8bbab3ca` dependency arrows
- `7735b3d80` drag resize
- `8c2dc9f79` self-table link tightening (PR #1412)
- `13f6f21a7` link-only narrowing (PR #1409)

There is no E2E coverage that exercises any of these end-to-end through the HTTP layer; this PR closes that gap.

## Scope

### In

- New Playwright spec `packages/core-backend/tests/e2e/multitable-gantt-smoke.spec.ts` containing three `test` cases:
  1. **Bar rendering**: admin creates a base + sheet + Title (string) + Start (date) + End (date) fields and a gantt view configured with `{startFieldId, endFieldId, titleFieldId}`. Creates two records spanning date ranges 2026-04-01..05 and 2026-04-06..12. Browser navigates to the workbench gantt URL and asserts (a) at least two `.meta-gantt__bar` selectors are visible and (b) both task labels appear in the rendered DOM.
  2. **Dependency arrow rendering**: same setup plus a self-table single-value link `Predecessor` field and a second gantt view configured with `dependencyFieldId: predecessor.id`. Creates record A with one date range and B with `[Predecessor: A]` and a later date range. Asserts at least one `.meta-gantt__dependency-arrow` selector is visible.
  3. **Backend rejection of non-link `dependencyFieldId`**: PATCHes the gantt view's config so that `dependencyFieldId` points at the Title (string) field. Asserts HTTP 400 + `error.code === 'VALIDATION_ERROR'` + message contains `self-table link field`. Exercises `validateGanttDependencyConfig` (`packages/core-backend/src/routes/univer-meta.ts`) at the HTTP layer; previously only covered indirectly by the resolver-level frontend tests in `apps/web/tests/multitable-gantt-view.spec.ts`.
- README addition listing the new spec.
- RC TODO item ticked in the same commit with PR / dev MD / verification MD pointers (per the post-#1419 hardening pattern).

### Out

- Gantt drag-resize interaction (covered by frontend vitest at `apps/web/tests/multitable-gantt-view.spec.ts`).
- Gantt zoom switch / unscheduled-row rendering / progress-bar formatting (frontend-only behaviors not tied to backend correctness).
- The remaining 2 RC smoke items (`formula editor`, `automation send_email`).
- Cross-sheet `dependencyFieldId` rejection: would require provisioning a second sheet with its own link target. The non-link-field case exercises the same code path (`validateGanttDependencyConfig` returns the same error string for both invariant violations) so additional cross-sheet setup adds no marginal coverage.

## K3 PoC Stage 1 Lock applicability

- Does NOT modify `plugins/plugin-integration-core/*`.
- Adds a test harness for already-shipped multitable surface — no new platform capability.
- Does NOT touch DingTalk / public-form runtime / Gantt runtime / migration / OpenAPI; only consumes existing endpoints.

## Implementation notes

### Reviewer hardening

Codex review rebased the branch onto `origin/main@9de886a29` and kept the PR source-only/test-only scope. The review patch tightened the smoke helper types by replacing the loose JSON helper return with typed `ApiEnvelope` / `Entity` helpers, removed an unused destructured `view` binding in the dependency-arrow test, and replaced drift-prone line-number references in the MDs with symbol / route references.

### Why the regression guard targets PATCH and not POST

`validateGanttDependencyConfig` runs in both `POST /views` and `PATCH /views/:viewId`. The PATCH path also runs when `parsed.data.config !== undefined || parsed.data.type !== undefined`, matching this PR's payload shape. The PATCH path is more interesting because it covers the operator workflow ("operator already has a Gantt view; tries to wire dependency on the wrong field"); the POST path is structurally identical from the validator's perspective. One representative case is sufficient.

### Why the bar-rendering case asserts both selector visibility AND label text

`.meta-gantt__bar` is a CSS class on the rendered SVG-style div. Its `count() >= 2` confirms the rendering path completes without crashing. The label text assertion (`toContainText(designName)`) confirms the title-field resolution worked end-to-end (a regression that broke `displayTitle()` would render bars but no labels). Two layers of assertion isolate the failure surface.

### Why the dependency-arrow case creates a fresh second view

Reusing the first test's gantt view would require a PATCH to add `dependencyFieldId`. The backend would invoke `validateGanttDependencyConfig` and the validator's input check (`config.dependencyFieldId` must already be a real link field on the same sheet) would pass. But that path also intersects the unrelated assertion that we leave the first view's behavior alone. Creating a second view keeps each test's setup isolated.

### Auth helper hygiene per Codex's #1419 review hardening

Only two failure-expected helpers are needed by this spec (`authPatchExpectingFailure` for the rejection regression). I deliberately did NOT include the `authPostExpectingFailure` helper that Codex removed from the hierarchy spec on review — same pattern would have been dead code here. `APIRequestContext` typing throughout. No `any` parameters.

## Files changed

| File | Lines |
|---|---|
| `packages/core-backend/tests/e2e/multitable-gantt-smoke.spec.ts` | +new (~225) |
| `packages/core-backend/tests/e2e/README.md` | +1 |
| `docs/development/multitable-feishu-rc-todo-20260430.md` | tick RC TODO item + PR/MD pointers |
| `docs/development/multitable-rc-gantt-smoke-development-20260507.md` | +new |
| `docs/development/multitable-rc-gantt-smoke-verification-20260507.md` | +new |

## Known limitations

1. **CI does not provision the dev stack** — same caveat as #1415 / #1417 / #1419. Suite skip-passes by default; promoting to a hard gate is a follow-up CI provisioning task.
2. **No drag-resize interaction**: the spec does not click and drag bar handles. Drag-resize is covered by the existing frontend Gantt view tests.
3. **Test data not cleaned up** — timestamp + random suffix prevents collision; matches lifecycle / public-form / hierarchy smoke policy.

## Cross-references

- RC TODO master: `docs/development/multitable-feishu-rc-todo-20260430.md`
- Backend validator: `packages/core-backend/src/routes/univer-meta.ts` (`validateGanttDependencyConfig`)
- Validator wiring: `POST /views` and `PATCH /views/:viewId`
- Frontend resolver tests: `apps/web/tests/multitable-gantt-view.spec.ts`
- Pattern source: PR #1419 (`449cc6353`) — multitable hierarchy smoke
