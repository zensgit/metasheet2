# Multitable Final I18n Audit (2026-05-22)

## 1. Purpose

This document is the post-T3D final audit plan and scout result for
`apps/web/src/multitable/**`.

Baseline:

- Branch: `frontend/multitable-final-i18n-audit-20260522`
- Base: `origin/main@a235a5c1e` (`chore(integration): add bridge source refresh staging smoke`)
- T3D-4 is already on `origin/main` through PR `#1750`
- Scope: frontend multitable i18n only
- Out of scope: backend contracts, migrations, attendance, K3 integration, non-multitable app chrome

This pass does not assume that every English token is a defect. It classifies
each finding into one of three buckets:

| Bucket | Meaning | Action |
| --- | --- | --- |
| True-positive chrome | User-visible UI or fallback text that should follow locale | Fix in follow-up slices |
| Raw-data / technical literal | User data, IDs, enum values, examples, protocol tokens, backend messages | Keep raw; add tests only if risky |
| Deferred / non-goal | Larger feature domain or intentionally English technical reference | Keep documented; revisit only by explicit scope |

## 2. Audit Commands

Commands run from the clean audit worktree:

```bash
git fetch origin
git log --oneline -1 origin/main
find apps/web/src/multitable -maxdepth 3 -type f | wc -l
rg --files apps/web/src/multitable | rg 'labels|Label|i18n|locale'
rg -n --glob '*.vue' ">\\s*[A-Z][A-Za-z0-9 ,.'’:/()&+\\-]*\\s*<" apps/web/src/multitable
rg -n --glob '*.vue' "(placeholder|aria-label|title)=\\\"[^\\\"]*[A-Za-z][^\\\"]*\\\"" apps/web/src/multitable
rg -n "validateAttachmentSelection|formatLinkActionLabel|linkActionLabel|Choose linked records|Open comments|Mentions|Unread|Timeline view|Gantt view|Hierarchy view|Loading\\.\\.\\.|No records|Create first record|Select a date field|Formula|Unexpected closing|People field only allows|This field only allows" apps/web/src/multitable
rg -n "Validation failed|Insufficient permissions|Please sign in|Please check|This field only allows|File type not allowed|People field only allows|Import cancelled|Yes' : 'No|Unexpected closing|Formula expression is empty|not balanced|cannot end" apps/web/src/multitable/{api,utils,import,composables} apps/web/src/multitable/components
```

Scout size:

- `apps/web/src/multitable`: 103 source files at depth <= 3
- Label/helper modules found: 15

Current label/helper modules:

```text
meta-automation-labels.ts
meta-core-labels.ts
meta-manager-labels.ts
meta-record-labels.ts
meta-comment-labels.ts
meta-link-picker-labels.ts
meta-import-labels.ts
meta-attachment-labels.ts
meta-bulk-edit-labels.ts
meta-api-token-labels.ts
meta-permission-labels.ts
meta-form-share-labels.ts
meta-base-picker-labels.ts
workbench-labels.ts
category-labels.ts
```

## 3. True-Positive Findings

### 3.1 High: Visual / Alternative View Chrome

The largest remaining user-visible English surface is the visual view family.
These components already import `useLocale()` in several places, but their own
view chrome is still mostly hard-coded English.

| File | Representative findings | Notes |
| --- | --- | --- |
| `MetaCalendarView.vue` | `Select a date field to use for the calendar:`, `Today`, `View`, `Month`, `Week`, `Day`, `Change`, `No records on this day`, `Loading...`, `Open comments for ...`, `No attachments` | Also owns effective-calendar tooltip/chip display from Step 4 |
| `MetaGalleryView.vue` | `Title`, `Auto`, `Cover`, `None`, `Columns`, `Card size`, `Small/Medium/Large`, `Card fields`, `+ Add record`, `No records to display`, `Create first record`, `Prev/Next`, `Loading...`, `Open comments for ...`, `No attachments` | View-manager labels already include many config labels but component template is not wired |
| `MetaTimelineView.vue` | `Timeline view`, `Start date`, `End date`, `Label field`, `Zoom`, `Day/Week/Month`, `Axis spacing...`, `Select start and end date fields...`, `Record`, `Unscheduled`, `No records found`, `Create first record`, `Open comments for ...`, `No attachments` | Also includes scheduling/drag wording |
| `MetaGanttView.vue` | `Gantt view`, `Loading...`, `Start`, `End`, `Title`, `Progress`, `Group`, `Dependencies`, `Zoom`, `+ Add task`, `Select start and end date fields to display Gantt tasks.`, `Task`, `No records found.` | Gantt-specific labels should likely be a view label group, not manager-only labels |
| `MetaHierarchyView.vue` | `Hierarchy view`, `Parent field`, `Title field`, `Expand depth`, `Orphans`, `No parent link field configured.`, `No records match this hierarchy view.`, `Loading...`, `Open comments for ...` | Some config labels exist in `meta-manager-labels.ts`; render chrome still unwired |
| `MetaKanbanView.vue` | `Select a select-type field to group by:`, `No select-type fields found...`, `+ Add record`, `Group`, `Grouped by:`, `Card fields`, `Clear`, `Uncategorized`, `Drop a card here...`, `No cards in this column`, `+ Add`, `Loading...`, `Open comments for ...` | Kanban has the densest true-positive template strings after timeline/gallery |
| `MetaDashboardView.vue` | `Rename`, `+ Add Panel`, `+ New Dashboard`, `Loading dashboard...`, `No dashboards yet...`, `Small/Medium/Large`, `Loading chart...`, `Add Chart Panel`, `No charts available...` | Dashboard surface was not covered by earlier T2/T3 slices |
| `MetaChartRenderer.vue` | table headers `Label` / `Value` | Small but visible; chart labels/data remain raw |

Recommended slice: `final-audit-visual-views`.

Implementation notes:

- Prefer a new `meta-view-render-labels.ts` or extend `meta-manager-labels.ts`
  only if the label is truly shared with manager config.
- Reuse `commentLabel('comment.title', isZh)` for action-chip labels, but add
  dedicated helpers for `Open comments for ${record}` and
  `Open comments for ${field} on ${record}`.
- Preserve record titles, field names, option values, chart labels, attachment
  filenames, and date strings as raw user data.

### 3.2 Medium: Mention Popover

`MetaMentionPopover.vue` remains fully English:

| Line | String |
| --- | --- |
| 3 | `aria-label="Mentions"` |
| 5 | `Mentions` |
| 6 | `aria-label="Close mentions"` |
| 16 | `aria-label="Unread"` |
| 72 | `${primary} +${n} more` |

Recommended slice: include with `final-audit-small-residuals`.

Suggested owner: `meta-comment-labels.ts`, because it is comment/mention chrome.

### 3.3 Medium: Link Cell Editor Button

`linkActionLabel(field, count, isZh = false)` is localized, but one remaining
caller still uses the English default:

| File | Line | Finding |
| --- | --- | --- |
| `components/cells/MetaCellEditor.vue` | 428 | `return formatLinkActionLabel(props.field, count)` |

The earlier T3A2 comment at lines 425-426 still references a deferred
`formatLinkActionLabel` path. This is now stale after T3B1/T3B3 localized the
helper. The cell editor should pass `isZh.value` and add a regression test in
`meta-cell-editor-i18n.spec.ts`.

Recommended slice: include with `final-audit-small-residuals`.

### 3.4 Medium: Attachment / People / Display Utility Fallbacks

Utility-level frontend fallback messages still return English:

| File | Lines | Finding |
| --- | --- | --- |
| `utils/field-config.ts` | 296, 302 | `This field only allows one attachment...`, `File type not allowed: ...` from `validateAttachmentSelection()` |
| `utils/people-import.ts` | 74, 87 | `People field only allows one person: ...` |
| `utils/field-display.ts` | 116 | boolean display `Yes` / `No` |

These strings are user-visible through record drawer/form/cell/editor/import
flows, not backend raw messages.

Recommended slice: include with `final-audit-small-residuals` if kept narrow;
otherwise make a small `final-audit-utils` PR.

Design rule:

- Do not translate raw `rawValue`, MIME types, filenames, user IDs, or field IDs.
- Add optional `isZh = false` arguments to helpers rather than forcing all
  existing callers to change at once.

### 3.5 Medium: API Client Static Fallbacks

`apps/web/src/multitable/api/client.ts` still emits English fallback messages:

| Lines | String |
| --- | --- |
| 174, 186 | `Validation failed` |
| 198 | `Insufficient permissions` |
| 200 | `Please sign in to continue.` |
| 202 | `Please check the submitted data and try again.` |
| 109 | `API ${status}` |

These are frontend-generated fallback strings when backend payloads do not
provide messages. They are likely user-visible because many components surface
`e.message` raw first.

Recommended slice: `final-audit-api-fallbacks`.

Risk:

- This client is not a Vue component and currently does not consume
  `useLocale()`. Avoid a broad composable dependency if possible.
- Options: pass a formatter/context at call sites, or centralize a multitable
  API error label helper with a default English fallback.

### 3.6 Medium: Formula Reference Docs and Diagnostics

`utils/formula-docs.ts` remains intentionally documented as raw in
`meta-manager-labels.ts`, but final audit confirms it is user-visible in the
field manager formula reference panel.

Findings:

- Category labels/descriptions: `Aggregate`, `Math`, `Operators`, etc.
- Function descriptions: `Adds numeric values together.`, `Returns the arithmetic mean...`, etc.
- Formula diagnostics: `Unexpected closing parenthesis.`, `Formula expression is empty.`, `Unknown field reference {...}.`, etc.

Recommended slice: `final-audit-formula-docs`.

Design rule:

- Function names, signatures, examples, insert text, formula tokens, and field
  refs stay raw.
- Category labels, descriptions, and diagnostics should be localized.
- This slice is larger than the small residuals and should not be mixed with
  visual view chrome.

### 3.7 Low: Dashboard / Chart Renderer If Not Folded Into Visual Views

If `MetaDashboardView.vue` is not included in the visual-view slice, it should
be a separate low-risk PR with `MetaChartRenderer.vue`:

- Dashboard chrome: `Rename`, `+ Add Panel`, `+ New Dashboard`, `Loading dashboard...`
- Chart table headers: `Label`, `Value`

Chart data labels and `displayConfig.title/prefix/suffix` stay raw/user-owned.

## 4. Raw / Keep As-Is Findings

These were seen by grep but should not be localized by default:

| Pattern | Reason |
| --- | --- |
| Field names, view names, record titles, chart labels, option values | User-authored data |
| IDs such as `recordId`, `sheetId`, `actorId`, `fld_target`, `fld_xxx` | Technical identifiers |
| URLs/emails/MIME placeholders such as `https://example.com`, `name@example.com`, `image/png,application/pdf` | Format examples, not chrome |
| HTTP methods `GET`, `POST`, `PUT` | Protocol values |
| Formula function names/signatures/examples/insert text | Formula language tokens |
| Currency codes and symbols (`CNY`, `USD`, `HK$`) | ISO/code data |
| Timezone `UTC` | Technical value |
| `data-*` enum values and CSS suffixes | Selector/persistence raw values |
| Backend/API `e.message`, `payload.message`, field error values | Backend/user-visible raw message source |
| Template tokens `{{recordId}}`, `{{record.xxx}}` | Template syntax |
| Attachment filenames and MIME types | User/file metadata |

## 5. Deferred / Review-Later Findings

| Surface | Reason |
| --- | --- |
| Formula docs if product wants English formula reference | Current code comment explicitly listed formula docs as raw in T3C; final audit recommends revisiting, but this is a product decision |
| API client fallback strategy | Needs a deliberate architecture choice because it is outside component scope |
| Full alt-view visual polish | Many visual views have UI/UX debt beyond string localization; keep i18n fix narrow |
| Tests with English expectations | Only update tests that assert changed user-facing copy; do not bulk-localize test fixture names |

## 6. Recommended Follow-Up Slices

### Slice A: `final-audit-small-residuals`

Scope:

- `MetaMentionPopover.vue`
- `MetaCellEditor.vue` link action caller
- `validateAttachmentSelection()`
- `people-import.ts`
- `field-display.ts` boolean display

Why first:

- Smallest real closure.
- Directly addresses earlier deferred `validateAttachmentSelection` and
  `formatLinkActionLabel` markers.
- Low UI risk and focused tests exist.

Expected tests:

- `meta-cell-editor-i18n.spec.ts`
- `multitable-mention-popover.spec.ts` or new i18n spec
- focused unit tests for `field-config`, `people-import`, `field-display`

### Slice B: `final-audit-visual-views`

Scope:

- `MetaCalendarView.vue`
- `MetaGalleryView.vue`
- `MetaTimelineView.vue`
- `MetaGanttView.vue`
- `MetaHierarchyView.vue`
- `MetaKanbanView.vue`
- optionally `MetaDashboardView.vue` / `MetaChartRenderer.vue`

Why second:

- Biggest remaining visible EN surface.
- Needs a coherent label module strategy and render-spec coverage.

Expected tests:

- Extend existing `multitable-*-view.spec.ts` files.
- Add zh-CN render assertions for each view.
- Add a11y sentinel counts for `[aria-label]`, `[title]`, `[placeholder]`.

### Slice C: `final-audit-formula-docs`

Scope:

- `utils/formula-docs.ts`
- `MetaFieldManager.vue` formula reference rendering

Why third:

- Larger data table and diagnostic path.
- Needs careful raw boundary for formula syntax, function names, examples, and field refs.

Expected tests:

- formula docs unit tests for category/diagnostic localization
- FieldManager render spec for zh category/description/diagnostic display

### Slice D: `final-audit-api-fallbacks`

Scope:

- `api/client.ts`
- any call-site needing locale-aware fallback formatting

Why last:

- Requires architectural decision on how non-component API code accesses locale.
- Many existing flows intentionally preserve backend `e.message` raw first.

## 7. Acceptance Gate for Each Fix Slice

Each follow-up PR must include:

- Narrow design note or verification MD section with true-positive list.
- No backend/contract/migration/attendance/K3 changes.
- No `node_modules` or unrelated worktree noise.
- `git diff --check origin/main..HEAD` clean.
- Focused Vitest specs for changed surfaces.
- `pnpm --filter @metasheet/web run type-check`.
- `pnpm --filter @metasheet/web build` unless the slice is docs-only.
- CI `test (18.x)` and `test (20.x)` green before merge.

## 8. Current Recommendation

Proceed with Slice A first: `final-audit-small-residuals`.

This gives the highest closure per line changed and explicitly closes the two
known early deferred markers:

- `validateAttachmentSelection()`
- `MetaCellEditor` / `formatLinkActionLabel` caller path

After Slice A, decide whether to take visual views as one PR or split
Calendar/Gallery/Timeline/Gantt/Kanban/Hierarchy/Dashboard into two smaller PRs
based on implementation size.
