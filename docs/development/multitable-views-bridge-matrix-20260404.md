# Multitable Legacy Bridge Matrix

## Purpose
- Clarify which non-grid surfaces still depend on legacy `/api/views/:viewId/*` flows.
- Clarify which multitable workbench surfaces already run on `/api/multitable/*`.
- Provide the compatibility baseline for Slice 3 and Slice 4 changes.

## Matrix
| Surface | Frontend entry | Config source | Data / submit source | Comments path | Attachment behavior | Bridge status | Next action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Grid workbench | `apps/web/src/multitable/views/MultitableWorkbench.vue` | `/api/multitable/context`, `/api/multitable/views`, `/api/multitable/view` | `/api/multitable/view`, `/api/multitable/records`, `/api/multitable/patch` | `commentsScope` + `/api/comments` | Native multitable attachment summaries and upload/delete flows | Direct multitable | Keep as source of truth |
| Form workbench mode | `apps/web/src/multitable/views/MultitableWorkbench.vue` with active view type `form` | `/api/multitable/context`, `/api/multitable/form-context` | `/api/multitable/views/:viewId/submit`, `/api/multitable/records/:recordId` | `commentsScope` from form context / submit result | Native multitable attachment summaries | Direct multitable | Extend here for comment jump/realtime |
| Standalone legacy form page | `apps/web/src/views/FormView.vue` | `ViewManager.loadViewConfig()` -> `loadContext({ viewId })` | submit uses multitable `submitForm(viewId, { data })`; responses still use `/api/views/:viewId/responses` via `ViewManager.getFormResponses()` | None | No multitable attachment comment integration | Hybrid | Keep compatible; do not assume comments/realtime here yet |
| Standalone legacy gallery page | `apps/web/src/views/GalleryView.vue` | `ViewManager.loadViewConfig()` | `/api/views/:viewId/data` via `ViewManager.loadViewData()` | None | Legacy card template path, not multitable comment-aware | Legacy | Keep display parity only; no comment inbox coupling |
| Standalone legacy calendar page | `apps/web/src/views/CalendarView.vue` | `ViewManager.loadViewConfig()` | `/api/views/:viewId/data` via `ViewManager.loadViewData()` | None | Legacy event rendering, not multitable attachment comment-aware | Legacy | Keep display parity only; no comment inbox coupling |
| Timeline inside workbench | `apps/web/src/multitable/components/MetaTimelineView.vue` routed through `MultitableWorkbench.vue` | `/api/multitable/context`, `/api/multitable/view` | `/api/multitable/view`, `/api/multitable/patch` | `commentsScope` from selected record | Native multitable attachment summaries | Direct multitable | Treat as multitable-only surface |
| Gallery inside workbench | `apps/web/src/multitable/components/MetaGalleryView.vue` | `/api/multitable/context`, `/api/multitable/view` | `/api/multitable/view` | `commentsScope` from selected record | Native multitable attachment summaries | Direct multitable | Treat as multitable-only surface |
| Calendar inside workbench | `apps/web/src/multitable/components/MetaCalendarView.vue` | `/api/multitable/context`, `/api/multitable/view` | `/api/multitable/view` | `commentsScope` from selected record | Native multitable attachment summaries | Direct multitable | Treat as multitable-only surface |

## Observations
- `ViewManager` is the boundary for legacy standalone pages. It still calls `/api/views/:viewId/data`, `/api/views/:viewId/state`, and `/api/views/:viewId/responses` in `apps/web/src/services/ViewManager.ts`.
- `ViewManager.loadViewConfig()` is already partially bridged onto multitable by calling `loadContext({ viewId })`, so config is no longer purely legacy even when data still is.
- `FormView.vue` is the only obvious hybrid surface today: config comes through multitable context, submit goes through multitable form submit, but responses still come from legacy `/api/views/:viewId/responses`.
- `GalleryView.vue` and `CalendarView.vue` remain standalone legacy pages and should only receive parity fixes, not multitable comment/inbox coupling.
- The multitable comments flow currently belongs to workbench surfaces only. `MultitableWorkbench.vue` loads comments through record-scoped `commentsScope` and `/api/comments`.
- There is no standalone legacy timeline page in `apps/web/src/views`; timeline exists only as a multitable workbench surface.

## Slice 3 / 4 rules
- Slice 3 comments composer and inbox work should only target multitable workbench surfaces.
- Slice 3 display consistency fixes may touch both workbench components and legacy standalone pages, but must not assume shared state stores.
- Slice 4 jump/realtime recovery should only guarantee multitable workbench restoration:
  - `baseId`
  - `sheetId`
  - `viewId`
  - `recordId`
  - `commentId`
- Legacy standalone pages should remain compatible, but they are not required to support comment inbox jump in this phase.

## Key files
- `apps/web/src/multitable/views/MultitableWorkbench.vue`
- `apps/web/src/services/ViewManager.ts`
- `apps/web/src/views/FormView.vue`
- `apps/web/src/views/GalleryView.vue`
- `apps/web/src/views/CalendarView.vue`
- `packages/core-backend/src/routes/views.ts`
