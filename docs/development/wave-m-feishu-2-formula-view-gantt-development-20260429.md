# Wave M-Feishu-2 Development - Formula / View Builder / Gantt

Date: 2026-04-29

Branch: `codex/mfeishu2-formula-view-gantt-20260429`

Base after final rebase: `origin/main@0635dc2a8`

## Scope

本轮继续对标飞书多维表格，但刻意避开当前钉钉集成窗口正在修改的 public form / JWT / DingTalk 路由文件。

Implemented lanes:

- MF4 Formula editor: function reference, field-token insertion, expression diagnostics.
- MF5 Visual view builder: configure `filterInfo`, `sortInfo`, and `groupInfo` from `MetaViewManager`.
- MF6 Gantt view: frontend `gantt` view type, workbench wiring, config resolver, tests.

Explicitly not touched:

- `apps/web/src/multitable/components/MetaFormShareManager.vue`
- `apps/web/src/views/PublicMultitableFormView.vue`
- `apps/web/src/router/multitableRoute.ts`
- `packages/core-backend/src/auth/jwt-middleware.ts`
- public form backend tests
- DingTalk integration files

## Design

### MF4 Formula Editor

Before this change, formula field chips inserted `{fieldName}` tokens. Backend formula dependency tracking only recognizes stable `{fld_xxx}` field-id tokens, so formulas could look valid in the UI while dependency tracking did not fire.

Changes:

- Added `apps/web/src/multitable/utils/formula-docs.ts`.
- Formula field chips now insert `{field.id}` tokens.
- Added documented functions for `SUM`, `AVERAGE`, `MIN`, `MAX`, `IF`, `AND`, `OR`, `CONCAT`, `LEN`, `TODAY`, `DATEDIFF`.
- Added diagnostics for empty formulas, unknown field references, name-based references, unknown functions, and unbalanced parentheses.
- Blocking errors prevent saving; warnings remain visible but do not block.

### MF5 Visual Filter / Sort / Group Builder

The toolbar already supported sort/filter/group, but view management did not expose those settings when configuring a view.

Changes:

- `MetaViewManager` now hydrates and persists shared view rules:
  - `filterInfo.conditions`
  - `filterInfo.conjunction`
  - `sortInfo.rules`
  - `groupInfo.fieldId`
- The builder reuses the existing `useMultitableGrid` operator vocabulary and persistence shape.
- Empty payloads are only sent when clearing previously configured settings, avoiding unnecessary clobbering on old views.
- `MultitableWorkbench` update/create view payload types now include `filterInfo` and `sortInfo`.

### MF6 Gantt View

This is a frontend unlock using the existing `meta_views` config surface. It does not introduce a separate Gantt task table or dependency graph.

Changes:

- Added `MetaGanttView.vue`.
- Added `MetaGanttViewConfig` to multitable types.
- Added `resolveGanttViewConfig()` for default start/end/title/progress/group/zoom selection.
- Added `gantt` to `MetaViewManager` create/config UI.
- Wired `activeViewType === 'gantt'` in `MultitableWorkbench`.
- Added router mode type support for `gantt`.

## Files

Core:

- `apps/web/src/multitable/components/MetaFieldManager.vue`
- `apps/web/src/multitable/components/MetaViewManager.vue`
- `apps/web/src/multitable/components/MetaGanttView.vue`
- `apps/web/src/multitable/utils/formula-docs.ts`
- `apps/web/src/multitable/utils/view-config.ts`
- `apps/web/src/multitable/types.ts`
- `apps/web/src/multitable/views/MultitableWorkbench.vue`
- `apps/web/src/router/types.ts`

Tests:

- `apps/web/tests/multitable-formula-editor.spec.ts`
- `apps/web/tests/multitable-gantt-view.spec.ts`
- `apps/web/tests/multitable-view-manager.spec.ts`

## Deferred

- Formula runtime parity remains backend-owned. The companion #1228 backend PR adds the `DATEDIFF` runtime alias; this PR stays frontend-only for formula editing, view building, and Gantt rendering.
- Gantt dependencies, hierarchy, critical path, and drag-resize are intentionally out of scope.
- Backend OpenAPI schemas for `gantt` can be added in a separate contract PR if needed; current REST view routes accept string view types and `meta_views.type` has no active check constraint in the canonical meta schema.
