# Multitable Final Audit Slice B Verification — Visual View Render Chrome

Date: 2026-05-22
Branch: `frontend/multitable-final-audit-visual-views-design-20260522`
Base: `origin/main@a60d463c5` after rebase

## DoD

- Slice B design exists:
  `docs/development/multitable-final-audit-visual-views-design-20260522.md`.
- New render module exists:
  `apps/web/src/multitable/utils/meta-view-render-labels.ts`.
- Visual view render chrome is localized in:
  Calendar, Gallery, Timeline, Gantt, Hierarchy, Kanban, Dashboard, and Chart
  table rendering.
- Existing ownership surfaces are reused rather than redeclared:
  `meta-core-labels.ts`, `meta-comment-labels.ts`, and
  `meta-manager-labels.ts`.
- Raw data remains raw: record titles, field names, option values, dashboard
  names from the server, chart names, chart labels/data, attachment filenames,
  holiday names, lunar labels, dates, IDs, and data/CSS enum values.
- Deferred surfaces remain out of scope: formula docs, API client fallbacks,
  category labels, backend/contract/migration/attendance/K3.

## Files Changed

Implementation:

- `apps/web/src/multitable/utils/meta-view-render-labels.ts`
- `apps/web/src/multitable/components/MetaCalendarView.vue`
- `apps/web/src/multitable/components/MetaGalleryView.vue`
- `apps/web/src/multitable/components/MetaTimelineView.vue`
- `apps/web/src/multitable/components/MetaGanttView.vue`
- `apps/web/src/multitable/components/MetaHierarchyView.vue`
- `apps/web/src/multitable/components/MetaKanbanView.vue`
- `apps/web/src/multitable/components/MetaDashboardView.vue`
- `apps/web/src/multitable/components/MetaChartRenderer.vue`

Tests:

- `apps/web/tests/meta-view-render-labels.spec.ts`
- `apps/web/tests/multitable-calendar-view.spec.ts`
- `apps/web/tests/multitable-gallery-view.spec.ts`
- `apps/web/tests/multitable-timeline-view.spec.ts`
- `apps/web/tests/multitable-gantt-view.spec.ts`
- `apps/web/tests/multitable-hierarchy-view.spec.ts`
- `apps/web/tests/multitable-kanban-view.spec.ts`
- `apps/web/tests/multitable-dashboard-view.spec.ts`
- `apps/web/tests/multitable-chart-renderer.spec.ts`

Docs:

- `docs/development/multitable-final-audit-visual-views-design-20260522.md`
- `docs/development/multitable-final-audit-visual-views-verification-20260522.md`

## Preflight / Reachability Evidence

Source-string grep before implementation found target literals in all 8 visual
components. After implementation, the same grep only matched identifiers or
localized key names:

```text
MetaCalendarView.vue: calendar.today key, cell.isToday class, goToday function
MetaDashboardView.vue: startRename / finishRename function and event names
```

No original target UI literals remain for:

```text
Select a date field
Open comments for
No attachments
No records
Create first record
Timeline view
Gantt view
Hierarchy view
Unscheduled
Drop here to move to root
Select a <strong>select</strong>
Uncategorized
Drop a card here
No cards in this column
Add Panel
New Dashboard
Loading dashboard
Add Chart Panel
No charts available
<th>Label</th>
<th>Value</th>
```

Reuse-key reachability was verified before wiring:

```text
meta-core-labels.ts: cell.noAttachments
meta-core-labels.ts: fieldTypeLabel
meta-comment-labels.ts: comment.title
meta-manager-labels.ts: view.cardSize / view.groupField / view.defaultExpandDepth
meta-manager-labels.ts: sizeLabel / zoomLabel / orphanModeLabel / autoLabel / groupNoneLabel
```

## Test Evidence

Command:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/meta-view-render-labels.spec.ts \
  tests/multitable-calendar-view.spec.ts \
  tests/multitable-gallery-view.spec.ts \
  tests/multitable-timeline-view.spec.ts \
  tests/multitable-gantt-view.spec.ts \
  tests/multitable-hierarchy-view.spec.ts \
  tests/multitable-kanban-view.spec.ts \
  tests/multitable-dashboard-view.spec.ts \
  tests/multitable-chart-renderer.spec.ts \
  tests/multitable-alt-view-comment-chip-i18n.spec.ts \
  --watch=false
```

Result:

```text
Test Files  10 passed (10)
Tests       69 passed (69)
```

Command:

```bash
pnpm --filter @metasheet/web run type-check
```

Result:

```text
> @metasheet/web@2.0.0-alpha.1 type-check
> vue-tsc -b
```

Exit code: 0.

Command:

```bash
pnpm --filter @metasheet/web build
```

Result:

```text
✓ 2421 modules transformed.
✓ built in 6.34s
```

Build warnings:

- Existing Vite warning: `WorkflowDesigner.vue` is both dynamically and
  statically imported.
- Existing Vite chunk-size warning for large bundles.

Command:

```bash
git diff --check
```

Result: clean.

## A11y Sentinel Coverage

Render specs lock fixture-level `[aria-label]`, `[title]`, and `[placeholder]`
counts on localized fixtures.

| Spec | Sentinel |
| --- | --- |
| `multitable-calendar-view.spec.ts` | Calendar zh fixture locks 42 aria labels, 0 title, 0 placeholder |
| `multitable-gallery-view.spec.ts` | Gallery empty zh fixture locks 0 aria, 0 title, 0 placeholder |
| `multitable-timeline-view.spec.ts` | Timeline zh fixture locks 2 aria, 1 title, 0 placeholder |
| `multitable-gantt-view.spec.ts` | Gantt zh fixture locks 3 aria, 1 title, 0 placeholder |
| `multitable-hierarchy-view.spec.ts` | Hierarchy zh fixture locks 2 aria, 0 title, 0 placeholder |
| `multitable-kanban-view.spec.ts` | Kanban zh fixture locks 3 aria, 0 title, 0 placeholder |
| `multitable-dashboard-view.spec.ts` | Dashboard zh fixture locks 0 aria, 1 title, 0 placeholder |
| `multitable-chart-renderer.spec.ts` | Chart table zh fixture locks 0 aria, 0 title, 0 placeholder |

No Slice B implementation adds new a11y attributes. Existing a11y text is
localized where it contains chrome; raw data titles/date ranges remain raw.

## Raw Boundary Checks

- Calendar: event title `Contract renewal` and holiday `春节` remain raw while
  header/picker/date aria chrome localizes.
- Gallery: field name `Status` remains raw while toolbar/empty/pagination chrome
  localizes.
- Timeline: field name `Name` and row label `Roadmap` remain raw while labels,
  hints, zoom badge, and view aria localize.
- Gantt: task `Design` and group value `Open` remain raw while toolbar, task
  column, date-range connector, unscheduled count, and resize aria localize.
- Hierarchy: record title `Root` remains raw while tree aria, toolbar/options,
  child action, and comment chip/aria localize.
- Kanban: option value `Doing`, card title `Pilot card`, and field value
  `Raw note` remain raw while prompts, headers, drop hints, and comment aria
  localize.
- Dashboard: server chart name `Sales Chart` remains raw; generated
  `dashboardDefaultName()` is event-time and becomes user data after create.
- Chart Renderer: chart table headers localize; chart data labels and values
  remain raw.

## Notes

- `common.*` keys are common only inside `meta-view-render-labels.ts`, not a
  cross-application namespace.
- `MetaHierarchyView` keeps the internal Options API fallback
  `commentLabel: 'Comments'`; the zh fixture asserts the parent passes
  localized `评论` and never exposes fallback `Comments`.
- `apps/web/dist/` and `apps/web/node_modules` are ignored worktree artifacts
  from build/test execution and are not part of the intended PR diff.
