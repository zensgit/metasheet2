# Multitable Grid Workbench — Design & Verification Report

**Date**: 2026-03-18
**Branch**: `codex/multitable-fields-views-linkage-automation-20260312`
**Worktree**: `/Users/huazhou/Downloads/Github/metasheet2-multitable`
**Scope**: `apps/web/src/multitable/**` + `apps/web/tests/**multitable*`

---

## 1. Architecture

### 1.1 Layer Diagram

```
┌─────────────────────────────────────────────────────────┐
│  MultitableWorkbench / MultitableEmbedHost (Views)      │
│  - Orchestrates all composables + components            │
│  - Global Ctrl+Z/Y undo/redo shortcuts                  │
├─────────────────────────────────────────────────────────┤
│  Components                                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │
│  │MetaToolbar│ │MetaGrid  │ │MetaForm  │ │MetaRecord │  │
│  │(sort/filt │ │Table     │ │View      │ │Drawer     │  │
│  │er/undo)  │ │(kb nav,  │ │          │ │           │  │
│  │          │ │col resize│ │          │ │           │  │
│  └──────────┘ └──────────┘ └──────────┘ └───────────┘  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │
│  │MetaView  │ │MetaField │ │MetaLink  │ │MetaComment│  │
│  │TabBar    │ │Header    │ │Picker    │ │sDrawer    │  │
│  └──────────┘ └──────────┘ └──────────┘ └───────────┘  │
│  ┌──────────────────────┐                               │
│  │Cell: Renderer+Editor │                               │
│  └──────────────────────┘                               │
├─────────────────────────────────────────────────────────┤
│  Composables                                            │
│  ┌─────────────────┐ ┌───────────────────────────────┐  │
│  │useMultitable     │ │useMultitableGrid              │  │
│  │Workbench         │ │(sort/filter/undo/redo/resize) │  │
│  └─────────────────┘ └───────────────────────────────┘  │
│  ┌─────────────────┐ ┌───────────────────────────────┐  │
│  │useMultitable     │ │useMultitableComments          │  │
│  │Capabilities      │ │                               │  │
│  └─────────────────┘ └───────────────────────────────┘  │
├─────────────────────────────────────────────────────────┤
│  API Client                                             │
│  MultitableApiClient ─ typed wrapper for all endpoints  │
│  Uses apiFetch() from utils/api.ts                      │
├─────────────────────────────────────────────────────────┤
│  Types                                                  │
│  types.ts ─ 276 lines, derived from OpenAPI base.yml    │
└─────────────────────────────────────────────────────────┘
```

### 1.2 Data Flow

```
User action → Component emit → MultitableWorkbench handler
  → Composable method → MultitableApiClient
  → fetch(/api/multitable/*) → Backend (univer-meta.ts)
  → Response → Composable state update (ref)
  → Vue reactivity → Component re-render
```

### 1.3 Capability Matrix

| Role | Read | Create | Edit | Delete | Fields | Views | Comment | Automation |
|------|------|--------|------|--------|--------|-------|---------|------------|
| owner | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| editor | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ |
| commenter | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| viewer | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

---

## 2. Design Decisions

### 2.1 Field Type Handling

| Field Type | Cell Renderer | Cell Editor | Sortable | Editable | Filter Operators |
|-----------|---------------|-------------|----------|----------|-----------------|
| string | Plain text | `<input type="text">` | ✅ | ✅ | is, isNot, contains, doesNotContain, isEmpty, isNotEmpty |
| number | Formatted number | `<input type="number">` | ✅ | ✅ | =, ≠, >, ≥, <, ≤, isEmpty, isNotEmpty |
| boolean | ☑/☐ glyph | `<input type="checkbox">` | ✅ | ✅ | is, isNot |
| select | Colored tags | `<select>` dropdown | ✅ | ✅ | is, isNot, isEmpty, isNotEmpty |
| link | Blue chips | "Choose linked records" button | ❌ | ✅ (picker) | isEmpty, isNotEmpty |
| formula | Plain text | Read-only | ✅ | ❌ | is, isNot, isEmpty, isNotEmpty |
| lookup | Plain text | Read-only | ❌ | ❌ | isEmpty, isNotEmpty |
| rollup | Plain text | Read-only | ❌ | ❌ | =, >, <, isEmpty, isNotEmpty |

### 2.2 Sort/Filter Serialisation

- **Sort**: `buildSortInfo()` → `{ rules: [{ fieldId: string, desc: boolean }] }`
- **Filter**: `buildFilterInfo()` → `{ conjunction: 'and'|'or', conditions: [{ fieldId, operator, value }] }`
- **Persistence**: `persistSortFilter()` calls `client.updateView(viewId, { sortInfo, filterInfo })`
- **Sync on load**: `syncFromView()` parses server-side sortInfo/filterInfo into local state

### 2.3 Undo/Redo Design

- `CellEdit[]` history stack tracking `{ recordId, fieldId, oldValue, newValue, version }`
- `historyIndex` pointer; `canUndo`/`canRedo` computed from pointer position
- `undo()` sends reverse patch to API (applies oldValue)
- `redo()` sends forward patch to API (applies newValue)
- History cleared on sheet/view change
- Keyboard: Ctrl+Z / Cmd+Z = undo; Ctrl+Y / Cmd+Shift+Z = redo

### 2.4 Keyboard Navigation

| Key | Action |
|-----|--------|
| ↑/↓ | Move focused row |
| ←/→ | Move focused column |
| Tab | Move to next cell (wraps to next row) |
| Enter | Open cell editor on focused cell |
| Escape | Clear focus |

### 2.5 Column Resize

- Drag handle on right edge of `MetaFieldHeader`
- `mousedown` → track `mousemove` delta → emit `resize(fieldId, width)`
- Min 60px, max 600px
- Widths stored in `columnWidths` reactive map, applied via inline styles

### 2.6 CSS Convention

- BEM naming: `.meta-grid__cell--focused`, `.meta-toolbar__btn--primary`
- Scoped CSS in every SFC, no global stylesheet pollution
- Consistent color palette: `#409eff` (primary blue), `#f56c6c` (danger red)
- No Element Plus dependency — all custom CSS

---

## 3. Verification

### 3.1 Test Results

```
✓ tests/multitable-capabilities.spec.ts  (5 tests)  2ms
✓ tests/multitable-grid.spec.ts          (20 tests) 6ms
✓ tests/multitable-comments.spec.ts      (5 tests)  5ms
✓ tests/multitable-workbench.spec.ts     (7 tests)  5ms

Test Files  4 passed (4)
     Tests  37 passed (37)
  Duration  322ms
```

### 3.2 Test Coverage Matrix

| Module | Tests | Coverage |
|--------|-------|----------|
| useMultitableCapabilities | 5 | All 4 roles; reactive role change |
| useMultitableGrid | 12 | Init state; visibleFields; field toggle; sort CRUD; filter CRUD; pagination; clearFilters; updateFilterRule; setColumnWidth; undo/redo availability; clearEditHistory |
| buildSortInfo | 2 | Empty → undefined; serialization to `{ rules: [{ fieldId, desc }] }` |
| buildFilterInfo | 3 | Empty → undefined; AND conjunction; OR conjunction |
| FILTER_OPERATORS_BY_TYPE | 4 | String ops; number comparison ops; boolean ops; select ops |
| useMultitableWorkbench | 7 | Load+auto-select; initialSheetId; selectSheet resets view; selectView; activeView; fields state; error handling |
| useMultitableComments | 5 | Load; add (prepend); resolve (in-place); clear; error handling |

### 3.3 Test Command

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable
npx vitest run apps/web/tests/multitable-capabilities.spec.ts \
  apps/web/tests/multitable-grid.spec.ts \
  apps/web/tests/multitable-workbench.spec.ts \
  apps/web/tests/multitable-comments.spec.ts
```

### 3.4 Scope Compliance

**Allowed modifications** (✅ verified):
- `apps/web/src/multitable/**` — 19 new files
- `apps/web/tests/**multitable*` — 4 new test files
- `docs/development/` — 1 design doc

**Forbidden modifications** (✅ verified — none touched):
- `packages/core-backend/**` — read-only for schema understanding
- `packages/openapi/**` — read-only for type derivation
- `apps/web/src/main.ts` — untouched
- `apps/web/src/App.vue` — untouched
- `apps/web/src/views/GridView.vue` — untouched
- `apps/web/src/services/ViewManager.ts` — untouched

---

## 4. API Contract Usage

| API Endpoint | Used By | Client Method |
|-------------|---------|---------------|
| `GET /api/multitable/sheets` | useMultitableWorkbench.loadSheets | listSheets() |
| `GET /api/multitable/fields?sheetId=` | useMultitableWorkbench.loadSheetMeta | listFields() |
| `GET /api/multitable/views?sheetId=` | useMultitableWorkbench.loadSheetMeta | listViews() |
| `PATCH /api/multitable/views/:id` | useMultitableGrid.persistSortFilter | updateView() |
| `GET /api/multitable/view?sheetId=&viewId=&limit=&offset=` | useMultitableGrid.loadViewData | loadView() |
| `POST /api/multitable/records` | useMultitableGrid.createRecord | createRecord() |
| `POST /api/multitable/patch` | useMultitableGrid.patchCell, undo, redo | patchRecords() |
| `DELETE /api/multitable/records/:id` | useMultitableGrid.deleteRecord | deleteRecord() |
| `GET /api/multitable/fields/:id/link-options` | MetaLinkPicker | listLinkOptions() |
| `GET /api/comments?containerId=&targetId=` | useMultitableComments.loadComments | listComments() |
| `POST /api/comments` | useMultitableComments.addComment | createComment() |
| `POST /api/comments/:id/resolve` | useMultitableComments.resolveComment | resolveComment() |

### API Methods Available but Not Yet Wired to UI

| Client Method | Status | Planned Use |
|--------------|--------|-------------|
| listBases() | Available | Base picker / multi-base navigation |
| createBase() | Available | "New Base" dialog |
| loadContext() | Available | Single-call workbench bootstrap |
| createSheet() | Available | "New Sheet" button |
| createField() | Available | Field management UI |
| updateField() | Available | Field rename/type change |
| deleteField() | Available | Field delete confirmation |
| createView() | Available | "New View" button |
| deleteView() | Available | View delete confirmation |
| loadFormContext() | Available | Form view bootstrap |
| getRecord() | Available | Record detail deep-link |
| submitForm() | Available | Form view submission |
| listRecordSummaries() | Available | Link picker fallback |

No new API endpoints introduced. ✅

---

## 5. File Inventory

### 5.1 New Files Created (19 source + 4 test + 1 doc = 24 total)

| # | Path | Lines | Purpose |
|---|------|-------|---------|
| 1 | `types.ts` | 276 | Complete TypeScript types from OpenAPI |
| 2 | `api/client.ts` | 251 | Typed API client for all endpoints |
| 3 | `composables/useMultitableCapabilities.ts` | 47 | Role → capability mapping |
| 4 | `composables/useMultitableComments.ts` | 50 | Comments CRUD |
| 5 | `composables/useMultitableGrid.ts` | 405 | Grid state + sort/filter + undo/redo + column resize |
| 6 | `composables/useMultitableWorkbench.ts` | 89 | Sheet/view/field state management |
| 7 | `components/cells/MetaCellRenderer.vue` | 76 | Read-only cell display (8 field types) |
| 8 | `components/cells/MetaCellEditor.vue` | 107 | Inline cell editing (5 editable types) |
| 9 | `components/MetaFieldHeader.vue` | 77 | Column header + sort indicator + resize drag handle |
| 10 | `components/MetaGridTable.vue` | 174 | Grid table + pagination + keyboard nav + column widths |
| 11 | `components/MetaViewTabBar.vue` | 65 | Sheet tabs + view tabs with type icons |
| 12 | `components/MetaToolbar.vue` | 176 | Fields/sort/filter panels + undo/redo buttons |
| 13 | `components/MetaFormView.vue` | 96 | Form-based record entry/edit |
| 14 | `components/MetaRecordDrawer.vue` | 87 | Record detail sidebar |
| 15 | `components/MetaCommentsDrawer.vue` | 83 | Comments panel |
| 16 | `components/MetaLinkPicker.vue` | 101 | Modal link record picker |
| 17 | `views/MultitableWorkbench.vue` | 144 | Main orchestrator + undo/redo shortcuts |
| 18 | `views/MultitableEmbedHost.vue` | 28 | Embed container wrapper |
| 19 | `index.ts` | 31 | Barrel exports |

**Total source**: 2,363 lines
**Test files**: 4 (37 tests)

---

## 6. Remaining Limitations

1. **Column widths not persisted**: Local state only, resets on page reload
2. **Link picker single-sheet only**: Uses `listLinkOptions` for the specific field's foreign sheet
3. **Route integration deferred**: Cannot modify `main.ts` — host shell must mount externally
4. **No row multi-select**: Checkbox column for bulk operations not implemented
5. **No field drag reorder**: Column drag-to-reorder not implemented
6. **No real-time sync**: WebSocket integration not included
7. **Base-level navigation**: Multi-base UI not yet built (API available)
8. **Field/view management UI**: CRUD UI for fields and views not yet built (APIs available)

---

## 7. Integration Points

### 7.1 Host Shell Mount

```vue
<!-- Option A: Route-based (requires main.ts change) -->
<MultitableEmbedHost :sheet-id="route.params.sheetId" :view-id="route.query.viewId" embedded role="editor" />

<!-- Option B: Dynamic import in existing view -->
<component :is="MultitableWorkbench" :sheet-id="selectedSheetId" />
```

### 7.2 Future Expansion

- **Kanban/Calendar/Gallery**: Add view-type components, switch in MultitableWorkbench based on `activeViewType`
- **Field management**: Create `MetaFieldManager.vue`, gate behind `canManageFields`
- **View configuration**: Create `MetaViewConfig.vue`, gate behind `canManageViews`
- **Base management**: Create `MetaBasePicker.vue`, use `loadContext()` for bootstrap
- **Real-time**: Add WebSocket layer to composables for live collaboration
