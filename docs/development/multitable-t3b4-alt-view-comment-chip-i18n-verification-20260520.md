# T3B4 - Alternative View Comment Chip i18n Verification

- **Date**: 2026-05-20
- **Scope**: row-comment action chip labels in calendar, gallery, hierarchy, timeline, and kanban views.
- **Design packet**: `docs/development/multitable-t3b4-alt-view-comment-chip-i18n-design-20260520.md`
- **Status**: implemented and locally verified.

## Implementation Summary

- Reused existing `commentLabel('comment.title', isZh)` for the row-comment chip label.
- Wired `MetaCalendarView.vue`, `MetaGalleryView.vue`, `MetaTimelineView.vue`, and `MetaKanbanView.vue` with `useLocale()` and a `commentsChipLabel` computed.
- Wired `MetaHierarchyView.vue` by passing the localized label from the parent into the render-function `HierarchyNode` component and through recursive child rendering.
- Updated the `meta-comment-labels.ts` module comment so its declared scope includes alternative-view row-comment chip labels.

## Boundary Check

| Area | Result |
|---|---|
| Backend/API/OpenAPI | Not touched |
| Migrations / `attendance_*` | Not touched |
| Direct `meta_*` writes | Not touched |
| View events / emitted payloads | Not changed |
| User-authored data | Not translated |
| Broader alternative-view chrome | Deferred by design |

## Test Coverage Added

| File | Coverage |
|---|---|
| `apps/web/tests/multitable-alt-view-comment-chip-i18n.spec.ts` | Mounts all five alternative views and asserts zh-CN row-comment chip labels are `评论`; also asserts English default remains `Comments`. |

## Verification Commands

```bash
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-alt-view-comment-chip-i18n.spec.ts \
  tests/multitable-calendar-view.spec.ts \
  tests/multitable-gallery-view.spec.ts \
  tests/multitable-hierarchy-view.spec.ts \
  tests/multitable-timeline-view.spec.ts \
  tests/multitable-kanban-view.spec.ts \
  tests/meta-comment-labels.spec.ts \
  tests/meta-comments-drawer-i18n.spec.ts \
  tests/meta-comment-composer-i18n.spec.ts --watch=false
```

Result: PASS, 30 tests across 9 files.

```bash
pnpm --filter @metasheet/web type-check
```

Result: PASS.

```bash
pnpm --filter @metasheet/web build
```

Result: PASS. Vite emitted the existing dynamic-import and large-chunk warnings only.

```bash
git diff --check
```

Result: PASS.

## Acceptance Notes

- T3B2 S1's nine hardcoded `Comments` chip sites are now locale-aware.
- `MetaCommentActionChip.vue` remains prop-driven; consumers still own the label text.
- The hierarchy render-function site keeps the default `Comments` fallback for direct internal use, but production parent wiring passes the localized prop.
- Field-comment affordance aria labels and other view-level English strings remain intentionally deferred to a broader alternative-view chrome slice.
