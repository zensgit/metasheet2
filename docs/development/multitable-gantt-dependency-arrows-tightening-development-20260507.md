# Multitable Gantt Dependency Arrows — Tightening to Link Fields · Development

> Date: 2026-05-07
> Branch: `codex/multitable-gantt-dependency-arrows-20260507`
> Base: `origin/main@8d3e5df1f` (after PR #1407 dead-letter merged)
> Lane: B (Gantt dependency arrows)

## Background

Commits `d8bbab3ca feat(multitable): add gantt dependency arrows` and `7735b3d80 feat(multitable): add gantt drag resize` shipped the core dependency-arrow feature (toolbar dropdown, `MetaGanttViewConfig.dependencyFieldId`, `dependencyLinksByRecordId` rendering, forward/backward arrow distinction, CSS, basic tests). RC TODO line 366 (`Gantt dependencies and dependency arrows`) is functionally satisfied at the code level.

The discussion document `docs/development/multitable-feishu-three-lane-plan-discussion-20260507.md` §3 B1 explicitly required:

> "dependencyFieldId 必须限制为 self-table link field"

The shipped implementation accepted `link / multiSelect / string` as candidate field types. This PR closes the tightening half of B1 (link-only narrowing) and adds five edge-case tests covering self-loop / missing dependency / multi-predecessor / cycle / non-link rejection scenarios that the original tests did not assert.

Self-table validation (the second half of B1) is left as a known limitation — see §Known Limitations.

## Scope

### In

- Narrow accepted dependency field type to `['link']` (was `['link', 'multiSelect', 'string']`):
  - `apps/web/src/multitable/utils/view-config.ts:131`
  - `apps/web/src/multitable/components/MetaGanttView.vue:228`
  - `apps/web/src/multitable/components/MetaViewManager.vue:565`
- Add five focused edge-case tests in `apps/web/tests/multitable-gantt-view.spec.ts`:
  - Non-link field configured as `dependencyFieldId` resolved to `null` (link / multiSelect / string / select coverage)
  - Dependency dropdown only lists link fields
  - Self-dependency is filtered (`dependency.record.id === task.record.id` branch)
  - Missing dependency (record not present in `scheduledTasks`) silently skipped
  - Multi-predecessor task (two distinct dependencies) renders both arrows with correct titles
  - Cycle `A → B → A` renders exactly two arrows, one of which carries the `meta-gantt__dependency-arrow--backward` class

### Out

- **autoNumber files** — PR #1406 hardening is in flight; this branch does not touch any autoNumber-related code.
- **Hierarchy view drag-to-reparent** — explicitly excluded by user's brief.
- **DingTalk** anywhere — excluded.
- **plugins/plugin-integration-core/** — K3 PoC Stage 1 Lock.
- **Backend zod validation** for `dependencyFieldId` in view config save — see Known Limitations.
- **Self-table link constraint** — see Known Limitations.

## K3 PoC Stage 1 Lock applicability

This PR is permitted under the lock for the following reasons:

1. No file under `plugins/plugin-integration-core/*` is modified.
2. The Gantt view was shipped in the multitable Wave 5 batch (commit `2651ab971 feat(multitable): add formula editor view builder and gantt view (#1227)`); this PR is parity-deepening on an already-shipped feature, not a new platform capability.
3. No external ERP integration code path is introduced or modified.

## Implementation notes

### Type narrowing rationale

`link` is the only field type whose persisted value is a list of record IDs by API contract. `multiSelect` stores option values, not record references. `string` could in principle hold comma-separated record IDs but there is no codebase convention for this; treating it as a dependency source produced a confusing UX (a free-text field in the dependency dropdown).

The existing `resolveGanttViewConfig` already validates that the configured field exists, so legacy stored configs with non-link dependency fields gracefully degrade to `dependencyFieldId: null` (visible as "none" in the dropdown). No data migration required.

### Why not also restrict to self-table link

`MetaField.property.foreignSheetId` (or equivalent) is the basis for self-table validation. The Gantt view component currently does not have access to the current sheet ID at render time, and threading it through would touch `MultitableWorkbench.vue`, view rendering scaffolding, and the props contract of `MetaGanttView`. That is a larger refactor and was scoped out for this PR. Cross-table links pointing to records that are not in the current view's `rows` already silently skip rendering (covered by the new `filters self-dependencies and skips dependencies whose record is missing` test), so the user-visible regression is limited to "configured an obviously wrong cross-table link, dropdown allowed it, no arrows render". Acceptable as a follow-up.

### Why not backend zod validation

View config persistence in metasheet2 is a JSONB blob; backend validation for view-specific field schemas is not currently performed for any view type. Adding it for Gantt alone would set a one-off precedent. Recommended as a project-wide follow-up rather than a Lane B side-effect.

## Files changed

| File | Lines |
|---|---|
| `apps/web/src/multitable/utils/view-config.ts` | -1 / +1 |
| `apps/web/src/multitable/components/MetaGanttView.vue` | -1 / +1 |
| `apps/web/src/multitable/components/MetaViewManager.vue` | -1 / +1 |
| `apps/web/tests/multitable-gantt-view.spec.ts` | +203 |
| `apps/web/tests/multitable-view-manager.spec.ts` | view-manager dependency dropdown assertion tightened |
| `docs/development/multitable-gantt-dependency-arrows-tightening-development-20260507.md` | +new |
| `docs/development/multitable-gantt-dependency-arrows-tightening-verification-20260507.md` | +new |

## Known Limitations

1. **Self-table link not enforced**: dependencyFieldId may still point to a link field that targets a different sheet. Render layer skips silently; UI does not warn the user. Follow-up scope.
2. **Backend zod validation not added**: invalid configs are scrubbed by `resolveGanttViewConfig` on read; persisted blob may contain stale `dependencyFieldId` values. Follow-up scope.
3. **No explicit cycle warning UI**: cycles render both arrows (one forward, one backward) without a banner. The cycle is naturally bounded because the renderer only paints immediate predecessors (no recursive traversal), so there is no infinite-loop risk; the existing implementation is correct. Adding a "cycle detected" badge is a UX enhancement deferred to a future polish.

## Cross-references

- PR #1406 autoNumber hardening — in flight, must merge before this PR is rebased and final-reviewed
- RC TODO `docs/development/multitable-feishu-rc-todo-20260430.md` line 366 ("Gantt dependencies and dependency arrows") — this PR completes the tightening half
- Discussion doc `docs/development/multitable-feishu-three-lane-plan-discussion-20260507.md` §3 B1 — origin of the tightening requirement
