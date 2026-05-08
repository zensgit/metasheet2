# Multitable RC Hierarchy Smoke · Development

> Date: 2026-05-07
> Branch: `codex/multitable-rc-smoke-hierarchy-20260507`
> Base: `origin/main@22c04bd0f` (after PR #1417 public-form smoke merge)
> Closes RC TODO line 112: `Smoke test Hierarchy view rendering and child creation`

## Background

PR #1415 (lifecycle smoke) and PR #1417 (public-form smoke) shipped the first two executable Playwright specs under `packages/core-backend/tests/e2e/`. This PR forks the same template for the **Hierarchy view rendering + child creation** RC TODO item — the third of the original six — and adds two regression guards that exercise the backend hierarchy cycle guard at the HTTP layer.

The Hierarchy view + drag-to-reparent feature shipped in commits `052286ed6`, `06307c284`, and `f6ab034d6` (last is the "prevent hierarchy parent cycles" fix). The cycle guard at `packages/core-backend/src/multitable/hierarchy-cycle-guard.ts:111` is wired into both `RecordService.createRecord` (`record-service.ts:899`) and the patch path (`record-write-service.ts:632`); when triggered, the guard throws `HierarchyCycleError`, the patch service wraps it as `RecordValidationError(message, 'HIERARCHY_CYCLE')`, and the route layer maps that to **HTTP 400** with `error.code === 'HIERARCHY_CYCLE'`. There is no existing E2E coverage that exercises this end-to-end through HTTP — only unit tests at `record-service.test.ts:402` and `record-write-service.test.ts:441`. This PR closes that gap.

## Scope

### In

- New Playwright spec `packages/core-backend/tests/e2e/multitable-hierarchy-smoke.spec.ts` containing three `test` cases:
  1. **Render**: admin creates a base + sheet + Title (string) + Parent (link, self-table, `limitSingleRecord: true`) + Hierarchy view configured with `parentFieldId: <parent.id>`. Creates a parent record then a child record with `data: {Title: 'h-child-…', Parent: [parent.id]}`. Browser navigates to `/multitable/{sheet.id}/{view.id}` and asserts the workbench DOM contains both the parent and child name strings.
  2. **Self-parent rejection**: creates a single record, then PATCHes its Parent field to `[self.id]`. Asserts HTTP 400 + `error.code === 'HIERARCHY_CYCLE'`.
  3. **Descendant-as-parent rejection**: builds a 3-level chain `A → B → C` (where each row's Parent points at the previous record), then PATCHes `A.Parent = [C.id]`. Asserts HTTP 400 + `error.code === 'HIERARCHY_CYCLE'`. Sanity tail: a non-cycle reparent (clear `B.Parent`) on the same chain still succeeds, so the test does not silently accept a "everything fails" regression.
- README addition listing the new spec.
- RC TODO checkbox tick at line 112 with PR / dev MD / verification MD pointers in the same commit (per the post-#1417 review hardening pattern).

### Out

- Frontend drag-to-reparent UI flow (the `onDropRecord` / `descendantIdsOf` client-side guards in `MetaHierarchyView.vue`). The render-test verifies the workbench mounts and shows data; client-side drag logic is covered by `apps/web/tests/multitable-hierarchy-view.spec.ts` (6 vitest cases including `blocks dragging a parent under its own descendant`). The smoke deliberately exercises the SERVER-side cycle guard, not the client-side one, because the client guard is bypassable via direct API call and is therefore the less load-bearing layer for an integrity smoke.
- Multi-parent / multi-value link configurations. The Hierarchy view requires `limitSingleRecord: true` for the parent field per its config drawer; this PR keeps the same constraint.
- The remaining 3 RC smoke items (`formula editor`, `Gantt rendering`, `automation send_email`).

## K3 PoC Stage 1 Lock applicability

- Does NOT modify `plugins/plugin-integration-core/*`.
- Adds a test harness for already-shipped multitable surface — no new platform capability.
- No DingTalk / public-form runtime / Hierarchy runtime / migration / OpenAPI changes; only consumes existing endpoints.

## Implementation notes

### Why the regression guards are valuable beyond unit tests

`record-write-service.test.ts:441` and `record-service.test.ts:402` cover the cycle guard with mocked pools. The HTTP smoke catches a different class of regression: drift in the route-level error mapping. If a future change rewrote `record-write-service.ts:642-644` to drop the `RecordValidationError` wrap (or changed the code constant from `'HIERARCHY_CYCLE'` to something else), the unit tests would still pass — they assert the inner `HierarchyCycleError`. The HTTP smoke would catch that drift because it asserts the WRAPPED outer code reaching the wire.

### Why the chain test ends with a sanity reparent

Without the trailing `clear B.Parent` assertion, a regression that broke ALL hierarchy patches — for instance, if `assertNoHierarchyParentCycle` accidentally became unconditional `throw` — would still pass the cycle test (because the cycle error fires regardless). Asserting that a known non-cycle reparent SUCCEEDS on the same chain completes the bracket: the rejection path triggers AND the happy path remains live.

### Why the render test does not also click to expand

`MetaHierarchyView.vue` initializes `expandedIds = ref(new Set())` empty by default, but the v-show / v-if pattern still emits both labels into the DOM tree (Vue mounts collapsed children but hides them). `toContainText` matches against the DOM string regardless of visibility, so the assertion is robust without click choreography. If a future Hierarchy refactor moves to `v-if` lazy mounting, the test will need a click step or selector visibility check; that's a desirable signal, not a flake.

### Auth helpers typed as `APIRequestContext`

Following Codex's #1417 review hardening (`request: any` → `APIRequestContext`), this spec types both `authPost` / `authPatch` / `authGet` and the failure-expected variants (`authPostExpectingFailure`, `authPatchExpectingFailure`) with `APIRequestContext` from `@playwright/test`. Same for the `Page` parameter on `injectTokenAndGo`.

## Files changed

| File | Lines |
|---|---|
| `packages/core-backend/tests/e2e/multitable-hierarchy-smoke.spec.ts` | +new (~210) |
| `packages/core-backend/tests/e2e/README.md` | +1 |
| `docs/development/multitable-feishu-rc-todo-20260430.md` | tick line 112 + add PR/MD pointers |
| `docs/development/multitable-rc-hierarchy-smoke-development-20260507.md` | +new |
| `docs/development/multitable-rc-hierarchy-smoke-verification-20260507.md` | +new |

## Known limitations

1. **CI does not provision the dev stack** — same as #1415 / #1417. Suite skip-passes by default; promoting to a hard gate is a follow-up CI provisioning task.
2. **Render assertion is text-presence only**, not strict tree structure. The structural client-side test lives in `apps/web/tests/multitable-hierarchy-view.spec.ts`.
3. **Parent field is hard-coded as single-value link** — multi-value parent semantics (Feishu allows but Hierarchy view requires single) are not exercised.
4. **Test data not cleaned up** — timestamp + random suffix prevents collisions; matches lifecycle / public-form smoke policy.

## Cross-references

- RC TODO master: `docs/development/multitable-feishu-rc-todo-20260430.md` (line 112)
- Backend cycle guard: `packages/core-backend/src/multitable/hierarchy-cycle-guard.ts:111` (`assertNoHierarchyParentCycle`)
- Cycle guard wiring: `record-service.ts:899`, `record-write-service.ts:632`
- Existing unit coverage: `record-service.test.ts:402`, `record-write-service.test.ts:441`
- Pattern source: PR #1417 (`22c04bd0f`) — multitable public-form smoke
- Frontend drag-reparent: `MetaHierarchyView.vue` + `apps/web/tests/multitable-hierarchy-view.spec.ts`
