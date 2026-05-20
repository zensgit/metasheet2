# T3B4 - Alternative View Comment Chip i18n Design

- **Date**: 2026-05-20
- **Type**: small implementation slice
- **Status**: implemented; paired verification in `docs/development/multitable-t3b4-alt-view-comment-chip-i18n-verification-20260520.md`
- **Preceded by**:
  - `docs/development/multitable-t3b2-comments-i18n-design-20260520.md`
  - `docs/development/multitable-t3b3-link-picker-i18n-design-20260520.md`
- **Goal**: close the T3B2 S1 deferred row-comment action-chip label in non-grid views without expanding into full view chrome localization.

## Scope

T3B2 intentionally left `MetaCommentActionChip label="Comments"` hardcoded in five alternative views. T3B4 rewires only that visible chip label to the existing comment namespace:

| Component | Sites |
|---|---:|
| `MetaCalendarView.vue` | 3 |
| `MetaGalleryView.vue` | 1 |
| `MetaHierarchyView.vue` | 1 render-function site |
| `MetaTimelineView.vue` | 2 |
| `MetaKanbanView.vue` | 2 |

The localized value is `commentLabel('comment.title', isZh.value)`, reusing the T3B2 key:

| Locale | Chip label |
|---|---|
| en | Comments |
| zh-CN | 评论 |

## Boundaries

This slice deliberately does not localize the rest of those views.

Out of scope:

- Calendar/timeline/gallery/kanban/hierarchy toolbar labels.
- Empty states, date labels, zoom labels, field-comment aria labels, drag/drop hints, and view configuration copy.
- Backend, API, routes, OpenAPI, migrations, `attendance_*`, or direct `meta_*` writes.
- User data: record titles, field names, option values, attachment filenames, and linked-record display values remain raw.

## Implementation Notes

- Each template-based view imports `useLocale()` and `commentLabel`, then passes a computed `commentsChipLabel` into `MetaCommentActionChip`.
- `MetaHierarchyView.vue` uses an inner render-function component, so the parent passes `commentLabel` as a prop to `HierarchyNode`; recursive child rendering forwards the same prop.
- `meta-comment-labels.ts` header comment now includes alternative-view action-chip labels in its scope. No new label key was needed.

## Acceptance

- In zh-CN, every row comment chip in the five alternative views renders `评论`.
- In English/default locale, every row comment chip remains `Comments`.
- Existing view behavior and events remain unchanged.
- T3B2's S1 deferred chip-label item is closed, while broader alternative-view chrome remains a future T3C/T3D view-localization slice.
