// Types & API client
export * from './types'
export { MultitableApiClient, multitableClient } from './api/client'

// Composables
export { useMultitableWorkbench } from './composables/useMultitableWorkbench'
export { useMultitableGrid, buildSortInfo, buildFilterInfo, FILTER_OPERATORS_BY_TYPE } from './composables/useMultitableGrid'
export type { SortRule, FilterRule, FilterOperator, FilterConjunction, CellEdit } from './composables/useMultitableGrid'
export { useMultitableCapabilities } from './composables/useMultitableCapabilities'
export type { MultitableCapabilities, MultitableRole } from './composables/useMultitableCapabilities'
export { useMultitableComments } from './composables/useMultitableComments'

// Cell components
export { default as MetaCellRenderer } from './components/cells/MetaCellRenderer.vue'
export { default as MetaCellEditor } from './components/cells/MetaCellEditor.vue'

// Grid components
export { default as MetaGridTable } from './components/MetaGridTable.vue'
export { default as MetaFieldHeader } from './components/MetaFieldHeader.vue'
export { default as MetaViewTabBar } from './components/MetaViewTabBar.vue'
export { default as MetaToolbar } from './components/MetaToolbar.vue'
export { default as MetaFormView } from './components/MetaFormView.vue'

// View-type components
export { default as MetaKanbanView } from './components/MetaKanbanView.vue'
export { default as MetaGalleryView } from './components/MetaGalleryView.vue'
export { default as MetaCalendarView } from './components/MetaCalendarView.vue'

// Management components
export { default as MetaFieldManager } from './components/MetaFieldManager.vue'
export { default as MetaViewManager } from './components/MetaViewManager.vue'
export { default as MetaBasePicker } from './components/MetaBasePicker.vue'

// Drawers & pickers
export { default as MetaRecordDrawer } from './components/MetaRecordDrawer.vue'
export { default as MetaCommentsDrawer } from './components/MetaCommentsDrawer.vue'
export { default as MetaLinkPicker } from './components/MetaLinkPicker.vue'
export { default as MetaToast } from './components/MetaToast.vue'

// Views
export { default as MultitableWorkbench } from './views/MultitableWorkbench.vue'
export { default as MultitableEmbedHost } from './views/MultitableEmbedHost.vue'
