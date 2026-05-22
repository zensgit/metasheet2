# Multitable Final Audit Slice A — Small Residuals Design (2026-05-22)

## 1. Scope

This slice closes the smallest true-positive residuals found by
`multitable-final-i18n-audit-20260522.md`.

In scope:

- `MetaMentionPopover.vue` mention popover chrome.
- `MetaCellEditor.vue` link action button caller now that `linkActionLabel()` is locale-aware.
- `validateAttachmentSelection()` frontend fallback messages.
- `people-import.ts` single-person import fallback message.
- `formatFieldDisplay()` boolean / link-count / attachment-count summaries.

Out of scope:

- Visual/alternative view render chrome (`MetaCalendarView`, `MetaGalleryView`, `MetaTimelineView`, `MetaGanttView`, `MetaHierarchyView`, `MetaKanbanView`, `MetaDashboardView`).
- Formula docs and diagnostics.
- `api/client.ts` static fallback architecture.
- Backend contracts, migrations, attendance, K3, and non-multitable app chrome.

## 2. Decisions

### 2.1 Mention Popover

Owner: `meta-comment-labels.ts`.

Rationale: the popover is comment/mention chrome; it should not create a new
module or depend on workbench labels.

New labels/helpers:

- `comment.mentions`
- `comment.closeMentions`
- `comment.unread`
- `mentionFieldScope(primaryFieldName, extraCount, isZh)`

Raw boundary:

- Record labels stay raw.
- Field names stay raw.
- Counts stay numeric.

### 2.2 Cell Editor Link Action

`linkActionLabel(field, count, isZh = false)` is already localized. The remaining
cell editor caller should pass `isZh.value`.

The old unreachable fallback branch stays English and documented as unreachable:

```ts
if (props.field.type !== 'link') return 'Choose linked records...'
```

Reason: the surrounding `v-else-if="field.type === 'link'"` means this branch is
not currently rendered. Creating a key for it would reintroduce the T3A2
dead-key problem.

### 2.3 Attachment Validation

`validateAttachmentSelection(field, files, existingCount, isZh = false)` keeps
English as default for compatibility and supports zh at call-sites that already
have `useLocale()`.

Raw boundary:

- MIME types stay raw.
- File names stay raw.
- `maxFiles` stays numeric.

### 2.4 People Import

`resolvePeopleImportValue()` receives optional `isZh?: boolean` while preserving
English default behavior.

Only the single-person limit fallback is in scope. Ambiguous lookup guidance
remains English for this slice because it is tied to import matching workflow
copy and should be handled with import-modal/API fallback surfaces if needed.

### 2.5 Field Display Summaries

`formatFieldDisplay()` receives optional `isZh?: boolean`.

Localized outputs:

- boolean: `Yes` / `No` -> `是` / `否`
- people summary: `1 person`, `N people` -> `1 个人员`, `N 个人员`
- linked record summary: `1 linked record`, `N linked records` -> `1 条关联记录`, `N 条关联记录`
- attachment summary: `1 attachment`, `N attachments` -> `1 个附件`, `N 个附件`

Raw boundary:

- Link summary display values stay raw.
- Attachment filenames stay raw.
- User-authored select/multi-select option values stay raw.
- Dates/times use the existing browser locale behavior and are not changed here.

## 3. Preflight Evidence

Cells directory audit:

```bash
rg --files apps/web/src/multitable/components/cells
rg -n "Choose linked records|validateAttachmentSelection|placeholder=\"[A-Za-z]|aria-label=\"[A-Za-z]" apps/web/src/multitable/components/cells
```

Result: only `MetaCellEditor.vue` has in-scope link/attachment residuals.
There are no separate `MetaSelectCellEditor` / `MetaDateCellEditor` /
`MetaLinkCellEditor` variants in this checkout.

Primary grep:

```bash
rg -n "Choose linked records|linkActionLabel|validateAttachmentSelection|People field only allows|Yes' : 'No|Mentions|Unread|more" apps/web/src/multitable apps/web/tests
```

## 4. Implementation Order

1. Extend `meta-comment-labels.ts` with mention popover labels/helper.
2. Wire `MetaMentionPopover.vue` with `useLocale()` and new labels.
3. Pass `isZh.value` from `MetaCellEditor.vue` to `linkActionLabel()` and `validateAttachmentSelection()`.
4. Add optional `isZh` parameter to `validateAttachmentSelection()` and update record/form/cell callers.
5. Add optional `isZh` parameter to `resolvePeopleImportValue()` and single-person message helper.
6. Add optional `isZh` parameter to `formatFieldDisplay()` and update visible component call-sites that already render field values.
7. Add/extend focused tests.
8. Write verification MD and stop before push.

## 5. Test Plan

Focused tests:

- `multitable-mention-popover.spec.ts`: en baseline, zh chrome, raw field/record labels.
- `meta-cell-editor-i18n.spec.ts`: zh link action.
- `multitable-people-import.spec.ts`: en default and zh single-person limit fallback.
- field display unit spec: en default, zh boolean/link/attachment summaries, raw user display preservation.
- field config unit spec: en default and zh attachment validation fallback, raw MIME value preservation.

Validation:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-mention-popover.spec.ts \
  tests/meta-cell-editor-i18n.spec.ts \
  tests/multitable-people-import.spec.ts \
  tests/multitable-field-display-i18n.spec.ts \
  tests/multitable-field-config-i18n.spec.ts \
  tests/multitable-number-format.spec.ts \
  tests/multitable-system-fields.spec.ts \
  tests/multitable-location-field.spec.ts \
  --watch=false

pnpm --filter @metasheet/web run type-check
pnpm --filter @metasheet/web build
git diff --check origin/main..HEAD
```

## 6. Risks

| Risk | Mitigation |
| --- | --- |
| Accidentally localizing user data | Tests keep field names, record labels, option values, raw IDs, MIME types, and filenames unchanged |
| Broad call-site churn from `formatFieldDisplay()` | Keep `isZh` optional with English default; only pass it from visible multitable components |
| Dead-key regression in cell link fallback | Do not add a key for the unreachable non-link branch |
| People import ambiguity guidance remains English | Explicitly deferred; only single-person limit fallback is in this small slice |
| Visual view residuals remain | Tracked in final audit Slice B, not mixed into Slice A |
