# Multitable View Compatibility Matrix

Generated: 2026-04-11

## Data Source

All 6 view types (Grid, Form, Kanban, Gallery, Calendar, Timeline) plus the Record Drawer fetch data exclusively from `/api/multitable/view` and `/api/multitable/records/:recordId` (univer-meta.ts).
No view uses `/api/views/:viewId/data` for multitable data.

## View Configuration Storage

| View | Config Source | Legacy Bridge (`/api/views/:viewId/config`) | Plugin Provider |
|------|-------------|----------------------------------------------|-----------------|
| Grid | `meta_views.config` JSON | No | `plugin-view-grid` (component only, no config provider) |
| Form | `meta_views.config` JSON | No | None |
| Kanban | `meta_views.config` JSON + `kanban_configs` table | Yes (legacy fallback in `views.ts`) | None |
| Gallery | `meta_views.config` JSON + `gallery_configs` table | Yes | `plugin-view-gallery` (GalleryViewConfigProvider) |
| Calendar | `meta_views.config` JSON + `calendar_configs` table | Yes | `plugin-view-calendar` (CalendarViewConfigProvider) |
| Timeline | `meta_views.config` JSON | No | `plugin-view-gantt` (component only) |

## Field Rendering Consistency

All views use shared rendering primitives:

| Field Type | Grid | Form | Drawer | Kanban | Gallery | Calendar | Timeline |
|-----------|------|------|--------|--------|---------|----------|----------|
| string | MetaCellRenderer | inline input | MetaCellEditor | MetaCellRenderer | MetaCellRenderer | MetaCellRenderer | MetaCellRenderer |
| number | MetaCellRenderer | inline input | MetaCellEditor | MetaCellRenderer | MetaCellRenderer | MetaCellRenderer | MetaCellRenderer |
| boolean | checkbox | checkbox | checkbox | checkbox | checkbox | checkbox | checkbox |
| date | date input | date input | date input | formatted | formatted | event position | bar position |
| select | colored tag | `<select>` | `<select>` | colored tag | colored tag | colored tag | colored tag |
| link | summary chips (blue) | link picker | link picker | summary chips | summary chips | summary text | summary text |
| person | summary chips (green) | link picker | link picker | summary chips | summary chips | summary text | summary text |
| attachment | MetaAttachmentList | upload + list | upload + list | MetaAttachmentList | cover + list | MetaAttachmentList | MetaAttachmentList |
| formula | read-only text | read-only | read-only | text | text | text | text |
| lookup | read-only text | read-only | read-only | text | text | text | text |
| rollup | read-only text | read-only | read-only | text | text | text | text |

## Shared Components

- `MetaCellRenderer.vue` — read-only field display (used by all views)
- `MetaCellEditor.vue` — editable field input (used by grid inline, form, drawer)
- `MetaAttachmentList.vue` — attachment thumbnail/file list (used by all views)
- `MetaLinkPicker.vue` — link/person field selection modal
- `formatFieldDisplay()` in `field-display.ts` — value-to-string conversion

## Legacy Bridge Impact

The legacy bridge at `/api/views/:viewId/config` serves the old Univer spreadsheet layer only.
Multitable views do NOT depend on it for data fetching or rendering.
It is relevant only for:
- Kanban: reads `kanban_configs` table as fallback when no plugin provider is registered
- Gallery: `plugin-view-gallery` registers a ViewConfigProvider
- Calendar: `plugin-view-calendar` registers a ViewConfigProvider

Any changes to multitable view rendering do NOT need to regression-test the legacy bridge,
unless the change also modifies the plugin view config providers.

## Conclusion

Rendering consistency was achieved in Slice 1 across all 6 view types and the Record Drawer. No additional view rendering fixes are required for Slice 3.
