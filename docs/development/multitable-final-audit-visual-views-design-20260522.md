# Multitable Final Audit Slice B Design — Visual View Render Chrome

Date: 2026-05-22
Branch: `frontend/multitable-final-audit-visual-views-design-20260522`
Base: `origin/main@a60d463c5` (`feat(multitable): close final i18n audit small residuals (#1753)`)

## 1. Decision Summary

Slice B localizes the remaining visual / alternative view render chrome found by
the final audit. It does not touch backend contracts, migrations, attendance,
K3, API client fallback errors, formula docs, or manager configuration panels.

Scope:

| Surface | Component | Decision |
| --- | --- | --- |
| Calendar | `MetaCalendarView.vue` | Localize picker/header/mode labels/empty states/comment aria/count helpers; keep dates, holiday names, lunar labels, record titles raw |
| Gallery | `MetaGalleryView.vue` | Localize toolbar controls, pagination, empty states, comment aria; keep field names, card titles, filenames raw |
| Timeline | `MetaTimelineView.vue` | Localize config labels, zoom labels, label summaries/hints, placeholders, unscheduled/empty states, comment aria |
| Gantt | `MetaGanttView.vue` | Localize toolbar, placeholder, task column, unscheduled/empty states, resize aria; keep task titles/date ranges/dependency labels raw |
| Hierarchy | `MetaHierarchyView.vue` | Localize toolbar, orphans options, root drop target, empty states, child action, comment aria |
| Kanban | `MetaKanbanView.vue` | Localize select-field prompt, header controls, uncategorized/drop hints, add/clear actions, comment aria |
| Dashboard | `MetaDashboardView.vue` | Localize dashboard shell, add-panel modal, panel-size labels, generated default dashboard name |
| Chart Renderer | `MetaChartRenderer.vue` | Localize table headers `Label` / `Value`; keep chart data labels and display config raw |

Architecture:

| Decision | Outcome |
| --- | --- |
| New render module | Add `apps/web/src/multitable/utils/meta-view-render-labels.ts` for view runtime chrome. |
| Existing manager module | Do not grow `meta-manager-labels.ts` into a render-surface bucket. Reuse its existing exact config labels/helpers only when the rendered control is the same semantic setting. |
| Existing core/comment modules | Reuse `metaCoreLabel('cell.noAttachments')` for attachment empty labels and `commentLabel('comment.title')` for chips. Add render helpers for comment button aria because those strings are view-runtime chrome. |
| Raw data | Preserve record titles, field names, view/dashboard/chart names, option values, attachment filenames, holiday names, lunar labels, dates/times, chart labels, chart values, IDs, and CSS/data enum values. |
| Slice shape | One Slice B PR is acceptable: 8 components plus one label module, but mostly template text and helper plumbing. |

## 2. Files In Scope

Implementation files:

```text
apps/web/src/multitable/utils/meta-view-render-labels.ts
apps/web/src/multitable/components/MetaCalendarView.vue
apps/web/src/multitable/components/MetaGalleryView.vue
apps/web/src/multitable/components/MetaTimelineView.vue
apps/web/src/multitable/components/MetaGanttView.vue
apps/web/src/multitable/components/MetaHierarchyView.vue
apps/web/src/multitable/components/MetaKanbanView.vue
apps/web/src/multitable/components/MetaDashboardView.vue
apps/web/src/multitable/components/MetaChartRenderer.vue
```

Tests:

```text
apps/web/tests/meta-view-render-labels.spec.ts
apps/web/tests/multitable-calendar-view.spec.ts
apps/web/tests/multitable-gallery-view.spec.ts
apps/web/tests/multitable-timeline-view.spec.ts
apps/web/tests/multitable-gantt-view.spec.ts
apps/web/tests/multitable-hierarchy-view.spec.ts
apps/web/tests/multitable-kanban-view.spec.ts
apps/web/tests/multitable-dashboard-view.spec.ts
apps/web/tests/multitable-chart-renderer.spec.ts
apps/web/tests/multitable-alt-view-comment-chip-i18n.spec.ts
```

Docs:

```text
docs/development/multitable-final-audit-visual-views-design-20260522.md
docs/development/multitable-final-audit-visual-views-verification-20260522.md
```

Out of scope:

| Deferred Surface | Reason |
| --- | --- |
| Formula docs / formula diagnostics | Final audit Slice C |
| API client fallback errors | Final audit Slice D; likely use dedicated API error label helper rather than direct `useLocale()` in client |
| Manager configuration panels | Already owned by `meta-manager-labels.ts`; only exact existing keys may be reused |
| Category labels | H2-era `category-labels.ts`; not part of T3/Slice B |
| Backend, contract, migration, attendance, K3 | K3 stage-1 frontend i18n lock remains in effect |

## 3. Label Module Contract

Add a new render-surface module:

```ts
export type MetaViewRenderLabelKey =
  | 'common.loading'
  | 'common.chooseField'
  | 'common.select'
  | 'common.auto'
  | 'common.none'
  | 'common.addRecord'
  | 'common.add'
  | 'common.createRecord'
  | 'common.createFirstRecord'
  | 'common.noRecordsFound'
  | 'calendar.today'
  | 'calendar.view'
  | 'calendar.month'
  | 'calendar.week'
  | 'calendar.day'
  | 'calendar.change'
  | 'calendar.newRecord'
  | 'calendar.selectDateField'
  | 'calendar.noRecordsOnDay'
  | 'gallery.title'
  | 'gallery.cover'
  | 'gallery.columns'
  | 'gallery.cardSize'
  | 'gallery.noRecordsTitle'
  | 'gallery.noRecordsHint'
  | 'gallery.prev'
  | 'gallery.next'
  | 'timeline.viewAria'
  | 'timeline.startDate'
  | 'timeline.endDate'
  | 'timeline.record'
  | 'timeline.axisZoomHint'
  | 'timeline.selectStartEnd'
  | 'timeline.autoRecordIdHint'
  | 'timeline.labelFieldHint'
  | 'gantt.viewAria'
  | 'gantt.start'
  | 'gantt.end'
  | 'gantt.title'
  | 'gantt.progress'
  | 'gantt.group'
  | 'gantt.dependencies'
  | 'gantt.addTask'
  | 'gantt.selectStartEnd'
  | 'gantt.task'
  | 'gantt.to'
  | 'gantt.allTasks'
  | 'gantt.ungrouped'
  | 'hierarchy.viewAria'
  | 'hierarchy.autoLinkField'
  | 'hierarchy.showAtRoot'
  | 'hierarchy.hide'
  | 'hierarchy.addRoot'
  | 'hierarchy.noParentConfigured'
  | 'hierarchy.parentHelp'
  | 'hierarchy.dropToRoot'
  | 'hierarchy.empty'
  | 'hierarchy.child'
  | 'kanban.selectFieldPromptPrefix'
  | 'kanban.selectFieldPromptSuffix'
  | 'kanban.noSelectFields'
  | 'kanban.groupedBy'
  | 'kanban.cardFields'
  | 'kanban.clear'
  | 'kanban.uncategorized'
  | 'kanban.dropOrAdd'
  | 'kanban.dropToUpdate'
  | 'kanban.noCards'
  | 'dashboard.rename'
  | 'dashboard.addPanel'
  | 'dashboard.newDashboard'
  | 'dashboard.loadingDashboard'
  | 'dashboard.empty'
  | 'dashboard.loadingChart'
  | 'dashboard.addChartPanel'
  | 'dashboard.noCharts'
  | 'chart.label'
  | 'chart.value'

export function viewRenderLabel(key: MetaViewRenderLabelKey, isZh: boolean): string
```

Helper contract:

```ts
export type ViewRenderSize = 'small' | 'medium' | 'large'
export type ViewRenderZoom = 'day' | 'week' | 'month'
export type CalendarViewMode = 'month' | 'week' | 'day'

export function viewSizeLabel(size: ViewRenderSize | (string & {}), isZh: boolean): string
export function viewZoomLabel(zoom: ViewRenderZoom | (string & {}), isZh: boolean): string
export function calendarViewModeLabel(mode: CalendarViewMode | (string & {}), isZh: boolean): string
export function calendarWeekdayShort(index: 0 | 1 | 2 | 3 | 4 | 5 | 6, isZh: boolean): string
export function calendarMoreEvents(count: number, isZh: boolean): string
export function calendarEventCount(count: number, isZh: boolean): string
export function calendarCellAriaLabel(dateLabel: string, annotations: string[], eventCount: number, isZh: boolean): string
export function openRecordCommentsAria(recordLabel: string, isZh: boolean): string
export function openFieldCommentsAria(fieldName: string, isZh: boolean): string
export function openFieldCommentsForRecordAria(fieldName: string, recordLabel: string, isZh: boolean): string
export function cardFieldsSummary(count: number, isZh: boolean): string
export function unscheduledCount(count: number, isZh: boolean): string
export function timelineLabelSummary(kind: 'auto' | 'custom' | 'field', fieldName: string | null, isZh: boolean): string
export function timelineAutoUsesFieldHint(fieldName: string, isZh: boolean): string
export function ganttResizeAria(edge: 'start' | 'end', taskLabel: string, isZh: boolean): string
export function dashboardDefaultName(index: number, isZh: boolean): string
```

Unknown enum fallback rule:

- `viewSizeLabel`, `viewZoomLabel`, and `calendarViewModeLabel` return `String(value)` for unknown values.
- Raw field/record/task/view names passed into helpers are interpolated unchanged.
- `common.*` means common only inside `meta-view-render-labels.ts` view-render
  surfaces. It is not an app-wide shared namespace and must not be imported
  outside multitable view-render components without a separate ownership review.
- `dashboardDefaultName(index, isZh)` is event-time. The generated name uses the
  current locale at create time; once persisted, the dashboard name becomes user
  data and must not retranslate on later locale switches.

## 4. Reuse Discipline

Reuse existing modules only when the ownership is already correct:

| Existing owner | Reuse in Slice B | Rationale |
| --- | --- | --- |
| `meta-core-labels.ts` | `metaCoreLabel('cell.noAttachments', isZh)` for `MetaAttachmentList` empty-label; `fieldTypeLabel('select', isZh)` for Kanban select-field prompt | Cross-surface attachment and field-type chrome already live in the core label module; do not duplicate them. |
| `meta-comment-labels.ts` | `commentLabel('comment.title', isZh)` for `MetaCommentActionChip` labels | Already proven in alt-view comment chip spec; keep chip title stable. |
| `meta-manager-labels.ts` | Existing exact config labels/helpers only when a render toolbar exposes the same setting, e.g. `view.groupField`, `view.cardFields`, `view.defaultExpandDepth`, `sizeLabel`, `zoomLabel`, `autoLabel`, `groupNoneLabel`, `orphanModeLabel` | Reuse prevents duplicate manager-config semantics, but Slice B must not extend manager module for runtime empty states or action text. |
| `workbench-labels.ts` | None | Workbench shell/toast domain; visual view internals should not import it. |

Practical import rule:

- Components may import both `viewRenderLabel` and existing manager/core/comment helpers.
- `meta-view-render-labels.ts` should not import `meta-manager-labels.ts`; keep modules acyclic and explicit at call sites.
- If a label is a runtime state or action (`No records`, `Drop here`, `+ Add record`, `Open comments for ...`), it belongs in `meta-view-render-labels.ts`.
- If a label is the same persisted view setting label (`Title field`, `Card size`, `Zoom`, `Orphans`), reuse existing manager helper/key where exact.

## 5. Exact Chrome Targets

Line numbers are from the current Slice B design branch and may drift after
implementation; verification must rerun grep.

### 5.1 Calendar

| Line(s) | Current string | Target / helper |
| --- | --- | --- |
| 5, 7 | `Select a date field to use for the calendar:`, `— Choose field —` | `calendar.selectDateField`, `common.chooseField` |
| 17-29 | `Today`, `+ Add record`, `View`, `Month`, `Week`, `Day`, `Field:`, `Change` | `calendar.today`, `common.addRecord`, `calendar.view`, `calendarViewModeLabel`, `calendar.change`; field name raw |
| 88, 175, 256 | `No attachments` | Reuse `metaCoreLabel('cell.noAttachments')` |
| 97, 108, 184, 195, 265, 276 | `Open comments for ...` | `openRecordCommentsAria`, `openFieldCommentsAria` |
| 116, 203 | `+{{ overflow }} more` | `calendarMoreEvents(count)` |
| 230 | `${n} event(s)` | `calendarEventCount(count)` |
| 236, 284, 290 | `+ New record`, `No records on this day`, `Loading...` | `calendar.newRecord`, `calendar.noRecordsOnDay`, `common.loading` |
| 364 | `Sun` ... `Sat` | `calendarWeekdayShort(index)` |
| 704-714 | `en-US` date aria + `${n} event(s)` | `calendarCellAriaLabel(dateLabel, annotations, count, isZh)`; for zh use `toLocaleDateString('zh-CN', ...)` |

Raw: `dateField.name`, event titles, holiday names, effective-calendar tooltip content, lunar labels, date strings.

### 5.2 Gallery

| Line(s) | Current string | Target / helper |
| --- | --- | --- |
| 5-32 | `Title`, `Auto`, `Cover`, `None`, `Columns`, `Card size`, `Small/Medium/Large` | `gallery.title`, `common.auto`, `gallery.cover`, `common.none`, `gallery.columns`, `gallery.cardSize`, `viewSizeLabel` |
| 36, 48 | `Card fields (${n})`, `+ Add record` | `cardFieldsSummary`, `common.addRecord` |
| 78, 103 | `Open comments for ...` | `openRecordCommentsAria`, `openFieldCommentsForRecordAria` |
| 93 | `No attachments` | Reuse `metaCoreLabel('cell.noAttachments')` |
| 114-116 | `No records to display`, `Add records to see them as cards here`, `Create first record` | `gallery.noRecordsTitle`, `gallery.noRecordsHint`, `common.createFirstRecord` |
| 120-124 | `Prev`, `Next`, `Loading...` | `gallery.prev`, `gallery.next`, `common.loading` |

Raw: field names, card titles, attachment filenames, field values.

### 5.3 Timeline

| Line(s) | Current string | Target / helper |
| --- | --- | --- |
| 2-3 | `Timeline view`, `Loading...` | `timeline.viewAria`, `common.loading` |
| 7-39 | `Start date`, `End date`, `Label field`, `(auto)`, `Zoom`, `Day/Week/Month`, `Axis spacing...` | `timeline.startDate`, `timeline.endDate`, existing `managerLabel('view.labelField')`, `common.auto`, existing `managerLabel('view.zoom')`, `viewZoomLabel`, `timeline.axisZoomHint` |
| 41-46 | `+ Add record`, `Select start and end date fields...`, `Create record` | `common.addRecord`, `timeline.selectStartEnd`, `common.createRecord` |
| 52, 58 | `Record`, `Zoom: ${label}` | `timeline.record`, helper text wrapping raw zoom label |
| 82, 141 | `No attachments` | Reuse `metaCoreLabel('cell.noAttachments')` |
| 91, 102, 150, 161 | `Open comments for ...` | comment aria helpers |
| 124, 172-173 | `Unscheduled (${n})`, `No records found`, `Create first record` | `unscheduledCount`, `common.noRecordsFound`, `common.createFirstRecord` |
| 281-299 | `Day/Week/Month`, `Label: auto`, `Label: ${field}`, `Label: custom`, auto-label hints | `viewZoomLabel`, `timelineLabelSummary`, `timelineAutoUsesFieldHint`, `timeline.autoRecordIdHint`, `timeline.labelFieldHint` |

Raw: field names, display labels, date ticks, date ranges.

### 5.4 Gantt

| Line(s) | Current string | Target / helper |
| --- | --- | --- |
| 2-3 | `Gantt view`, `Loading...` | `gantt.viewAria`, `common.loading` |
| 7-56 | `Start`, `select`, `End`, `Title`, `auto`, `Progress`, `none`, `Group`, `Dependencies`, `Zoom`, `Day/Week/Month`, `+ Add task` | `gantt.*`, `common.select`, `common.auto`, `common.none`, `viewZoomLabel`, `gantt.addTask` |
| 60, 65 | `Select start and end date fields...`, `Task` | `gantt.selectStartEnd`, `gantt.task` |
| 84 | `to` | `gantt.to` |
| 107, 117 | `Resize start/end for ${title}` | `ganttResizeAria(edge, title, isZh)` |
| 127, 139 | `Unscheduled (${n})`, `No records found.` | `unscheduledCount`, `common.noRecordsFound` |
| 325-327 | `All tasks`, `Ungrouped` | `gantt.allTasks`, `gantt.ungrouped` |

Raw: task titles, group option values except empty/ungrouped fallback, dependency labels, date strings.

### 5.5 Hierarchy

| Line(s) | Current string | Target / helper |
| --- | --- | --- |
| 2 | `Hierarchy view` | `hierarchy.viewAria` |
| 5-35 | `Parent field`, `(auto link field)`, `Title field`, `(auto)`, `Expand depth`, `Orphans`, `show at root`, `hide`, `+ Add root` | Reuse exact manager labels for field/depth/orphans where possible; `hierarchy.autoLinkField`, `common.auto`, `hierarchy.showAtRoot`, `hierarchy.hide`, `hierarchy.addRoot` |
| 39-40 | `No parent link field configured.`, `Add or choose a link field...` | `hierarchy.noParentConfigured`, `hierarchy.parentHelp` |
| 55 | `Drop here to move to root` | `hierarchy.dropToRoot` |
| 79, 82 | `No records match this hierarchy view.`, `Loading...` | `hierarchy.empty`, `common.loading` |
| 408 | default prop `Comments` | Keep as EN fallback; parent passes localized `commentLabel('comment.title')`; hierarchy render spec must assert zh fixture shows `评论`, never fallback `Comments` |
| 472, 482 | `Open comments for ${title}`, `+ Child` | `openRecordCommentsAria`, `hierarchy.child` |

Raw: record titles, field names, generated diagnostics from tree builder unless they are static frontend strings discovered during implementation.

### 5.6 Kanban

| Line(s) | Current string | Target / helper |
| --- | --- | --- |
| 5-10 | `Select a select-type field to group by:`, `— Choose field —`, `No select-type fields found...` | `kanban.selectFieldPromptPrefix` + `fieldTypeLabel('select')` + `kanban.selectFieldPromptSuffix`, `common.chooseField`, `kanban.noSelectFields` |
| 17-38 | `Group`, `(none)`, `Grouped by:`, `Card fields (${n})`, `+ Add record`, `Clear` | Reuse manager `view.groupField` only if exact; otherwise `gantt.group`/`kanban.groupedBy`, `common.none`, `cardFieldsSummary`, `common.addRecord`, `kanban.clear` |
| 44, 95, 98, 154, 157, 162 | `Uncategorized`, drop hints, `+ Add`, `Loading...` | `kanban.uncategorized`, `kanban.dropOrAdd`, `kanban.dropToUpdate`, `kanban.noCards`, `common.add`, `common.loading` |
| 67, 85, 126, 144 | `Open comments for ...` | comment aria helpers |

Raw: select option values, group field names, card titles, preview field names/values.

### 5.7 Dashboard

| Line(s) | Current string | Target / helper |
| --- | --- | --- |
| 35-42 | title/text `Rename`, `+ Add Panel`, `+ New Dashboard` | `dashboard.rename`, `dashboard.addPanel`, `dashboard.newDashboard` |
| 46-48 | `Loading dashboard...`, `No dashboards yet...` | `dashboard.loadingDashboard`, `dashboard.empty` |
| 69-71 | `Small/Medium/Large` | `viewSizeLabel` |
| 87, 96, 100 | `Loading chart...`, `Add Chart Panel`, `No charts available...` | `dashboard.loadingChart`, `dashboard.addChartPanel`, `dashboard.noCharts` |
| 194 | generated `Dashboard ${n}` | `dashboardDefaultName(n, isZh)` |

Raw: dashboard names from server/user input, chart names, chart type enum shown in picker unless a separate chart-type label helper already exists in future scope.

### 5.8 Chart Renderer

| Line(s) | Current string | Target / helper |
| --- | --- | --- |
| 127-128 | `Label`, `Value` | `chart.label`, `chart.value` |

Raw: chart title, prefix/suffix, data point labels, data values.

## 6. Raw Boundary

Do not localize these values:

| Raw value | Reason |
| --- | --- |
| Field names and view names | User-authored metadata |
| Record titles / task titles / card titles | User-authored data |
| Select option values and colors | User-authored option domain |
| Attachment filenames and URLs | User file metadata |
| Holiday names, lunar labels, effective-calendar layer labels | Domain data already produced upstream |
| Chart names, chart data labels, display title/prefix/suffix, numeric values | User/chart configuration and data |
| Dates, date ranges, axis tick labels | Formatted data; only surrounding chrome localizes |
| IDs, `data-*` values, CSS suffixes, enum persistence values | Selector/persistence contract |
| Backend/client errors surfaced through `error.message` | Raw error channel unless explicitly in Slice D |

If implementation discovers additional static frontend fallbacks in these files,
classify them in the verification MD as localized, raw, or deferred before
wiring.

## 7. A11y Boundary

Slice B localizes existing visible text and existing a11y text. It must not add
new a11y attributes unless a real existing control is otherwise inaccessible.

Implementation specs must lock fixture-render counts for:

```ts
container.querySelectorAll('[aria-label]').length
container.querySelectorAll('[title]').length
container.querySelectorAll('[placeholder]').length
```

Expected behavior:

- Existing `aria-label` values localize where they contain static chrome, e.g. `Timeline view`, `Gantt view`, `Open comments for ...`, `Resize start for ...`.
- Existing `title` values localize only when they are static chrome, e.g. Dashboard `Rename`; date-range and dependency title strings remain raw data.
- No placeholder additions are expected in Slice B.
- `data-*` values stay raw and must never bind localized strings.

## 8. Test Plan

### 8.1 Helper Unit Spec

Create `apps/web/tests/meta-view-render-labels.spec.ts`.

Required coverage:

- `ALL_KEYS` style exhaustive test for every `MetaViewRenderLabelKey`.
- EN and zh static labels for common keys.
- Plural/count helpers:
  - `calendarMoreEvents(1/2)`
  - `calendarEventCount(1/2)`
  - `cardFieldsSummary(1/3)`
  - `unscheduledCount(1/2)`
- Raw interpolation helpers:
  - `openRecordCommentsAria('Alpha', true)`
  - `openFieldCommentsForRecordAria('状态', '客户 A', false)` keeps Chinese field/record names raw inside English chrome.
  - `ganttResizeAria('start', '任务 A', false)` keeps task label raw.
  - `dashboardDefaultName(2, true)`.
- Unknown fallback for `viewSizeLabel`, `viewZoomLabel`, and `calendarViewModeLabel`.

### 8.2 Render Specs

Extend existing specs rather than creating unrelated harnesses:

| Spec | Minimum Slice B assertions |
| --- | --- |
| `multitable-calendar-view.spec.ts` | zh picker/header/mode labels; `No records on this day`; localized `No attachments`; `Open comments...` aria; date aria uses zh date/event wording while holiday names remain raw |
| `multitable-gallery-view.spec.ts` | zh toolbar labels, card size options, empty state, pagination, comment aria; field/card names raw |
| `multitable-timeline-view.spec.ts` | zh view aria, toolbar, zoom badge, label summary/hints, unscheduled count, empty state, attachment empty label |
| `multitable-gantt-view.spec.ts` | zh view aria, toolbar, placeholder, task column, `to`, unscheduled count, resize aria, all/ungrouped fallbacks |
| `multitable-hierarchy-view.spec.ts` | zh tree aria, toolbar/options, parent placeholder, root drop target, empty state, child action, comment aria |
| `multitable-kanban-view.spec.ts` | zh select-field prompt with localized `select` field type, header controls, drop hints, uncategorized, add/clear actions, comment aria |
| `multitable-dashboard-view.spec.ts` | zh shell, add-panel modal, generated dashboard name body, panel size options; dashboard/chart names raw |
| `multitable-chart-renderer.spec.ts` | zh table headers; chart title/data labels/prefix/suffix raw |
| `multitable-alt-view-comment-chip-i18n.spec.ts` | Existing chip-label coverage stays green; add no redundant mount unless comment-chip regression is not covered elsewhere |

Mount/teardown pattern:

- Use the canonical `createApp` + container cleanup shape from existing visual-view specs.
- Each render spec touching locale must reset `useLocale().setLocale('en')` in `afterEach`.
- Prefer behavior/DOM text assertions over implementation-only prop inspection.

### 8.3 Validation Commands

Commands run from repo root:

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

pnpm --filter @metasheet/web run type-check
pnpm --filter @metasheet/web build
git diff --check origin/main..HEAD
```

Because `pnpm --filter @metasheet/web exec` runs with package context
available, test paths stay `tests/...`, not `apps/web/tests/...`.

## 9. Preflight Grep

Before implementation, rerun:

```bash
rg -n "Select a date field|Today|Open comments for|No attachments|No records|Create first record|Timeline view|Gantt view|Hierarchy view|Unscheduled|Drop here to move to root|Select a <strong>select</strong>|Uncategorized|Drop a card here|No cards in this column|Rename|Add Panel|New Dashboard|Loading dashboard|Add Chart Panel|No charts available|<th>Label</th>|<th>Value</th>" \
  apps/web/src/multitable/components/MetaCalendarView.vue \
  apps/web/src/multitable/components/MetaGalleryView.vue \
  apps/web/src/multitable/components/MetaTimelineView.vue \
  apps/web/src/multitable/components/MetaGanttView.vue \
  apps/web/src/multitable/components/MetaHierarchyView.vue \
  apps/web/src/multitable/components/MetaKanbanView.vue \
  apps/web/src/multitable/components/MetaDashboardView.vue \
  apps/web/src/multitable/components/MetaChartRenderer.vue
```

Also verify reuse-key reachability:

```bash
rg -n "cell.noAttachments|fieldTypeLabel" apps/web/src/multitable/utils/meta-core-labels.ts
rg -n "comment.title" apps/web/src/multitable/utils/meta-comment-labels.ts
rg -n "view\\.cardSize|view\\.groupField|view\\.defaultExpandDepth|sizeLabel|zoomLabel|orphanModeLabel|autoLabel|groupNoneLabel" apps/web/src/multitable/utils/meta-manager-labels.ts
```

Verification MD must include the final grep classification:

- localized by `meta-view-render-labels.ts`
- reused from existing module
- raw-data / deferred

## 10. Implementation Order

1. Rebase/fetch latest `origin/main`; confirm `git diff --name-status origin/main..HEAD` is empty before coding.
2. Run the preflight grep in §9 and update the implementation checklist if line numbers drift.
3. Add `meta-view-render-labels.ts` with static labels and helpers.
4. Add `meta-view-render-labels.spec.ts`.
5. Wire common helpers into Calendar/Gallery/Timeline/Kanban/Hierarchy/Gantt first, because they share comment aria, attachment empty label, loading, add/create, and count helpers.
6. Wire Dashboard + Chart Renderer.
7. Extend render specs and a11y count sentinels.
8. Add verification MD with files changed, grep evidence, raw boundary evidence, and command outputs.
9. Run validation commands in §8.3.
10. Commit only Slice B files; do not stage `node_modules`, `dist`, unrelated T3D/audit work, backend, contracts, migrations, attendance, or K3.
11. Stop before push/PR for implementation review.

## 11. Risk Register

| Risk | Mitigation |
| --- | --- |
| `meta-manager-labels.ts` becomes an overloaded render bucket | New `meta-view-render-labels.ts` owns runtime chrome; only exact existing manager config labels/helpers are reused. |
| Duplicate helper drift | Reuse `fieldTypeLabel`, `commentLabel`, `metaCoreLabel`, and exact manager helpers instead of redeclaring their semantics. |
| Localized text enters selectors | Keep all `data-*`, CSS suffixes, enum values, and option values raw; add raw selector assertions where tests already depend on them. |
| A11y count changes silently | Each touched render spec records fixture `[aria-label]` / `[title]` / `[placeholder]` counts. |
| Raw user data gets translated | Helper tests include Chinese field/record/view names inside English chrome to prove raw interpolation. |
| Large Slice B PR is hard to review | Verification MD groups diff by module/components/specs and includes per-component target matrix. If implementation reveals excessive churn, split Dashboard/Chart into B2 before push. |
| Mid-flight `origin/main` advances | Use `git fetch origin && git rebase origin/main` before push; for zero-overlap BEHIND PRs, Path A admin squash remains acceptable but verification must record the behind interval. |

## 12. Approval Gate

Implementation is ready for push only when all are true:

- `meta-view-render-labels.ts` exists and owns render-only chrome.
- Existing `meta-core-labels.ts`, `meta-comment-labels.ts`, and `meta-manager-labels.ts` are reused only for their established ownership surfaces.
- All planned true-positive strings in §5 are either localized, reused, or explicitly classified raw/deferred in verification MD.
- Targeted visual-view specs and helper spec pass.
- `vue-tsc`, frontend build, and `git diff --check origin/main..HEAD` pass.
- Diff remains frontend multitable i18n only.
