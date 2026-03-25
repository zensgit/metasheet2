# Multitable Phase 3 — Design & Verification Report

**Date**: 2026-03-18
**Branch**: `codex/multitable-fields-views-linkage-automation-20260312`
**Worktree**: `/Users/huazhou/Downloads/Github/metasheet2-multitable`
**Scope**: `apps/web/src/multitable/**` + `apps/web/tests/**multitable*`

---

## 1. Phase 3 Deliverables

### 1.1 Phase 3a — Field & View Management

| Component | Lines | Purpose |
|-----------|-------|---------|
| `MetaFieldManager.vue` | 181 | Full field CRUD modal: list with type icons, inline rename, reorder (move up/down), delete with confirmation, add new field (name + type selector) |
| `MetaViewManager.vue` | 125 | Full view CRUD modal: list with type icons, active view highlight, inline rename, delete (min 1 view required), add new view (name + type selector) |

**API Wiring**: Both managers are wired into `MultitableWorkbench.vue` with handlers that call:
- `client.createField()` / `client.updateField()` / `client.deleteField()`
- `client.createView()` / `client.updateView()` / `client.deleteView()`

**Capability Gating**:
- "Fields" button visible only when `canManageFields === true` (owner role)
- "Views" button visible only when `canManageViews === true` (owner role)

### 1.2 Phase 3b — Form Enhancement + Base Navigation

| Component | Lines | Purpose |
|-----------|-------|---------|
| `MetaFormView.vue` (enhanced) | 107 | Read-only mode support, submit/reset actions, success/error feedback, disabled state for readonly fields |
| `MetaBasePicker.vue` | 101 | Dropdown base selector with search, create new base, color-coded icons |

**Form Enhancement Details**:
- `readOnly` prop disables all inputs and hides submit button
- `submitting` state shows "Saving..." during submission
- Reset button reverts form to original record data
- Success/error banner messages
- Form-type views use `client.submitForm(viewId, ...)` instead of manual patch

**Base Navigation Details**:
- `MetaBasePicker` renders in workbench header when bases exist
- `onSelectBase()` calls `client.loadContext({ baseId })` to bootstrap sheets/views
- `onCreateBase()` creates base then auto-selects it
- Bases are loaded on mount via `client.listBases()`

### 1.3 Phase 3c — Deep-Link, Persistence, Multi-Select

| Feature | Implementation |
|---------|---------------|
| **Record deep-link** | URL hash `#recordId=xxx` — read on mount, update on record selection via `window.history.replaceState()` |
| **Column width persistence** | `localStorage` keyed by `mt_col_widths_{sheetId}_{viewId}` — saved on every `setColumnWidth()`, loaded on grid initialization |
| **Row multi-select** | Checkbox column in `MetaGridTable` (gated by `canDeleteRecord`), select-all header checkbox, bulk action bar with "Delete selected" button |

### 1.4 Capability Enhancement

`useMultitableCapabilities` now accepts both:
- `Ref<MultitableRole>` — maps to predefined capability sets
- `Ref<MetaCapabilities>` — uses backend-provided capability object directly

This enables server-driven capability control when the backend provides explicit capability flags via `/api/multitable/context`.

---

## 2. Architecture Updates

### 2.1 Updated Layer Diagram

```
┌─────────────────────────────────────────────────────────────┐
│  MultitableWorkbench / MultitableEmbedHost (Views)          │
│  - Orchestrates all composables + components                │
│  - Global Ctrl+Z/Y undo/redo shortcuts                      │
│  - Base-level navigation (MetaBasePicker + loadContext)      │
│  - Record deep-link (URL hash read/write)                   │
│  - Bulk delete handler                                       │
├─────────────────────────────────────────────────────────────┤
│  Components                                                  │
│  ┌────────────┐ ┌────────────┐ ┌──────────┐ ┌───────────┐  │
│  │MetaToolbar  │ │MetaGrid    │ │MetaForm  │ │MetaRecord │  │
│  │(sort/filter │ │Table (+    │ │View (+   │ │Drawer     │  │
│  │/undo/redo)  │ │multi-sel,  │ │readonly, │ │           │  │
│  │             │ │bulk bar)   │ │submit)   │ │           │  │
│  └────────────┘ └────────────┘ └──────────┘ └───────────┘  │
│  ┌────────────┐ ┌────────────┐ ┌──────────┐ ┌───────────┐  │
│  │MetaView    │ │MetaField   │ │MetaLink  │ │MetaComment│  │
│  │TabBar      │ │Header      │ │Picker    │ │sDrawer    │  │
│  └────────────┘ └────────────┘ └──────────┘ └───────────┘  │
│  ┌────────────┐ ┌────────────┐ ┌──────────────────────┐    │
│  │MetaField   │ │MetaView    │ │MetaBasePicker        │    │
│  │Manager     │ │Manager     │ │                      │    │
│  └────────────┘ └────────────┘ └──────────────────────┘    │
│  ┌──────────────────────┐                                   │
│  │Cell: Renderer+Editor │                                   │
│  └──────────────────────┘                                   │
├─────────────────────────────────────────────────────────────┤
│  Composables                                                 │
│  ┌───────────────────┐ ┌─────────────────────────────────┐  │
│  │useMultitable       │ │useMultitableGrid                │  │
│  │Workbench           │ │(+localStorage column widths)    │  │
│  └───────────────────┘ └─────────────────────────────────┘  │
│  ┌───────────────────┐ ┌─────────────────────────────────┐  │
│  │useMultitable       │ │useMultitableComments            │  │
│  │Capabilities (+obj) │ │                                 │  │
│  └───────────────────┘ └─────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│  API Client                                                  │
│  MultitableApiClient — all endpoints now wired to UI         │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Data Flow — Field/View Management

```
User clicks "⚙ Fields" → MetaFieldManager opens (modal)
  → User adds/renames/reorders/deletes field
    → MultitableWorkbench handler
      → client.createField/updateField/deleteField
      → workbench.loadSheetMeta (refresh fields+views)
      → grid.loadViewData (refresh grid with new schema)
```

### 2.3 Manager dirty-guard / prop-reconcile

- Opening `MetaFieldManager` or `MetaViewManager`, and switching a config target inside them, always initializes the local draft from the latest props.
- Once the local draft becomes dirty, background prop refreshes do not silently overwrite the current draft; the manager shows a stale warning and lets the user reload the latest settings explicitly.
- Structural invalidation still forces reconcile/reset: the target field/view disappears, referenced sheets/fields disappear, or the manager closes and reopens.
- After save, cancel, or reopen, the manager synchronizes from the latest props again.

### 2.4 Data Flow — Base Navigation

```
User selects base in MetaBasePicker
  → onSelectBase(baseId)
    → client.loadContext({ baseId })
    → Populate sheets[], views[] from context
    → Auto-select first sheet → triggers loadSheetMeta
    → Grid refreshes with new sheet's data
```

---

## 3. API Contract — Full Coverage

### 3.1 APIs Now Wired to UI (Phase 3 additions marked ⭐)

| API Endpoint | Used By | Client Method |
|-------------|---------|---------------|
| `GET /api/multitable/bases` | ⭐ loadBases | listBases() |
| `POST /api/multitable/bases` | ⭐ onCreateBase | createBase() |
| `GET /api/multitable/context` | ⭐ onSelectBase | loadContext() |
| `GET /api/multitable/sheets` | loadSheets | listSheets() |
| `GET /api/multitable/fields?sheetId=` | loadSheetMeta | listFields() |
| `POST /api/multitable/fields` | ⭐ onCreateField | createField() |
| `PATCH /api/multitable/fields/:id` | ⭐ onUpdateField | updateField() |
| `DELETE /api/multitable/fields/:id` | ⭐ onDeleteField | deleteField() |
| `GET /api/multitable/views?sheetId=` | loadSheetMeta | listViews() |
| `POST /api/multitable/views` | ⭐ onCreateView | createView() |
| `PATCH /api/multitable/views/:id` | persistSortFilter, ⭐ onUpdateView | updateView() |
| `DELETE /api/multitable/views/:id` | ⭐ onDeleteView | deleteView() |
| `GET /api/multitable/view` | loadViewData | loadView() |
| `POST /api/multitable/records` | createRecord | createRecord() |
| `POST /api/multitable/patch` | patchCell, undo, redo | patchRecords() |
| `DELETE /api/multitable/records/:id` | deleteRecord, ⭐ bulk delete | deleteRecord() |
| `GET /api/multitable/fields/:id/link-options` | MetaLinkPicker | listLinkOptions() |
| `POST /api/multitable/views/:id/submit` | ⭐ onFormSubmit (form view) | submitForm() |
| `GET /api/comments` | loadComments | listComments() |
| `POST /api/comments` | addComment | createComment() |
| `POST /api/comments/:id/resolve` | resolveComment | resolveComment() |

### 3.2 Remaining Unwired APIs

| Client Method | Status | Notes |
|--------------|--------|-------|
| createSheet() | Available | "New Sheet" — would need sheet tab UI enhancement |
| loadFormContext() | Available | Standalone form bootstrap — deferred to form-only mode |
| getRecord() | Available | Record detail deep-link with server fetch — deferred |
| listRecordSummaries() | Available | Link picker fallback — current approach uses listLinkOptions |

**21 of 25 API methods now wired to UI** (84% coverage, up from 48% in Phase 2).

---

## 4. Verification

### 4.1 Test Results

```
✓ tests/multitable-capabilities.spec.ts  (6 tests)  2ms
✓ tests/multitable-comments.spec.ts      (5 tests)  4ms
✓ tests/multitable-workbench.spec.ts     (8 tests)  6ms
✓ tests/multitable-grid.spec.ts          (20 tests) 8ms
✓ tests/multitable-phase3.spec.ts        (15 tests) 9ms

Test Files  5 passed (5)
     Tests  54 passed (54)
  Duration  352ms
```

### 4.2 Phase 3 Test Coverage

| Module | Tests | Coverage |
|--------|-------|----------|
| Column width persistence | 3 | Persist to localStorage; load from localStorage; corrupted data graceful fallback |
| Field management API | 3 | createField POST; updateField PATCH; deleteField DELETE |
| View management API | 2 | createView POST; deleteView DELETE |
| Base management API | 3 | listBases; createBase; loadContext with params |
| Form submit API | 2 | submitForm create mode; submitForm update mode with recordId |
| Backend capabilities | 2 | Accept MetaCapabilities object; null → viewer fallback |

### 4.3 Test Command

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable
npx vitest run apps/web/tests/multitable-capabilities.spec.ts \
  apps/web/tests/multitable-grid.spec.ts \
  apps/web/tests/multitable-workbench.spec.ts \
  apps/web/tests/multitable-comments.spec.ts \
  apps/web/tests/multitable-phase3.spec.ts
```

### 4.4 Scope Compliance

**Allowed modifications** (✅ verified):
- `apps/web/src/multitable/**` — 3 new files, 5 modified files
- `apps/web/tests/**multitable*` — 1 new test file
- `docs/development/` — 1 design doc

**Forbidden modifications** (✅ verified — none touched):
- `packages/core-backend/**` — read-only
- `packages/openapi/**` — read-only
- `apps/web/src/main.ts` — untouched
- `apps/web/src/App.vue` — untouched

---

## 5. Complete File Inventory

### 5.1 All Source Files (22 total)

| # | Path | Lines | Purpose | Phase |
|---|------|-------|---------|-------|
| 1 | `types.ts` | 276 | TypeScript types from OpenAPI | P1 |
| 2 | `api/client.ts` | 251 | Typed API client (25 methods) | P1 |
| 3 | `composables/useMultitableCapabilities.ts` | 60 | Role+object → capability mapping | P1+P3 |
| 4 | `composables/useMultitableComments.ts` | 50 | Comments CRUD | P1 |
| 5 | `composables/useMultitableGrid.ts` | 405 | Grid state + localStorage widths | P1+P2+P3 |
| 6 | `composables/useMultitableWorkbench.ts` | 89 | Sheet/view/field state | P1 |
| 7 | `components/cells/MetaCellRenderer.vue` | 76 | Read-only cell (8 types) | P1 |
| 8 | `components/cells/MetaCellEditor.vue` | 107 | Inline cell editor (5 types) | P1 |
| 9 | `components/MetaFieldHeader.vue` | 77 | Column header + resize | P1+P2 |
| 10 | `components/MetaGridTable.vue` | 195 | Grid + kb nav + multi-select | P1+P2+P3 |
| 11 | `components/MetaViewTabBar.vue` | 65 | Sheet/view tabs | P1 |
| 12 | `components/MetaToolbar.vue` | 176 | Sort/filter/undo/redo | P2 |
| 13 | `components/MetaFormView.vue` | 107 | Form entry + readonly + submit | P1+P3 |
| 14 | `components/MetaRecordDrawer.vue` | 87 | Record detail sidebar | P1 |
| 15 | `components/MetaCommentsDrawer.vue` | 83 | Comments panel | P1 |
| 16 | `components/MetaLinkPicker.vue` | 101 | Link record picker | P1 |
| 17 | `components/MetaFieldManager.vue` | 181 | Field CRUD modal | **P3** |
| 18 | `components/MetaViewManager.vue` | 125 | View CRUD modal | **P3** |
| 19 | `components/MetaBasePicker.vue` | 101 | Base selector dropdown | **P3** |
| 20 | `views/MultitableWorkbench.vue` | 270 | Main orchestrator (all features) | P1+P2+P3 |
| 21 | `views/MultitableEmbedHost.vue` | 28 | Embed wrapper | P1 |
| 22 | `index.ts` | 35 | Barrel exports | P1+P3 |

**Total source**: ~2,997 lines
**Test files**: 5 (54 tests)

### 5.2 Test Files

| # | Path | Tests | Phase |
|---|------|-------|-------|
| 1 | `multitable-capabilities.spec.ts` | 6 | P1+P3 |
| 2 | `multitable-grid.spec.ts` | 20 | P1+P2 |
| 3 | `multitable-workbench.spec.ts` | 8 | P1+P3 |
| 4 | `multitable-comments.spec.ts` | 5 | P1 |
| 5 | `multitable-phase3.spec.ts` | 15 | **P3** |

---

## 6. Remaining Limitations

1. **Sheet creation UI**: `createSheet()` available but no "New Sheet" button yet
2. **Standalone form mode**: `loadFormContext()` not yet used for form-only bootstrapping
3. **Row drag reorder**: Column/field drag-to-reorder not implemented
4. **Real-time sync**: WebSocket integration not included
5. **Route integration**: Cannot modify `main.ts` — host shell must mount externally
6. **Kanban/Calendar/Gallery**: View-type specific renderers not yet built
7. **Column width persistence**: Uses localStorage (session-local); not synced to server
8. **Bulk delete**: Sequential delete calls; no batch delete API endpoint

---

## 7. Phase Completion Summary

| Phase | Scope | Status | Tests |
|-------|-------|--------|-------|
| P1: Grid MVP | Types, API client, composables, cell components, grid, form, drawers, link picker | ✅ Complete | 37 |
| P2: Sort/Filter/UX | Toolbar, keyboard nav, column resize, undo/redo, BEM CSS | ✅ Complete | 37 |
| P3: Management | Field/View CRUD, base navigation, form submit, deep-link, column persistence, multi-select | ✅ Complete | 54 |

**Cumulative**: 22 source files, ~2,997 lines, 54 passing tests, 21/25 API methods wired (84%).
