<template>
  <div class="mt-workbench" @keydown="onGlobalKeydown">
    <MetaToast ref="toastRef" />
    <div v-if="bases.length" class="mt-workbench__base-bar">
      <MetaBasePicker :bases="bases" :active-base-id="activeBaseId" :can-create="caps.canManageFields.value" @select="onSelectBase" @create="onCreateBase" />
    </div>
    <MetaViewTabBar :sheets="workbench.sheets.value" :views="workbench.views.value" :active-sheet-id="workbench.activeSheetId.value" :active-view-id="workbench.activeViewId.value" :can-create-sheet="caps.canManageFields.value" @select-sheet="workbench.selectSheet" @select-view="workbench.selectView" @create-sheet="onCreateSheet" />
    <div class="mt-workbench__actions">
      <button v-if="caps.canManageFields.value" class="mt-workbench__mgr-btn" @click="showFieldManager = true">&#x2699; Fields</button>
      <button v-if="caps.canManageViews.value" class="mt-workbench__mgr-btn" @click="showViewManager = true">&#x2630; Views</button>
    </div>
    <MetaToolbar
      :fields="grid.fields.value" :hidden-field-ids="grid.hiddenFieldIds.value"
      :sort-rules="grid.sortRules.value" :filter-rules="grid.filterRules.value"
      :filter-conjunction="grid.filterConjunction.value"
      :can-create-record="caps.canCreateRecord.value" :can-undo="grid.canUndo.value" :can-redo="grid.canRedo.value"
      @toggle-field="grid.toggleFieldVisibility" @add-sort="grid.addSortRule" @remove-sort="grid.removeSortRule"
      @update-sort="onUpdateSort" @add-filter="grid.addFilterRule" @update-filter="grid.updateFilterRule"
      @remove-filter="grid.removeFilterRule" @clear-filters="onClearFilters" @set-conjunction="onSetConjunction"
      :group-field-id="grid.groupFieldId.value"
      :search-text="searchText" :total-rows="grid.page.value.total" :row-density="rowDensity"
      @apply-sort-filter="grid.applySortFilter" @add-record="onAddRecord" @undo="grid.undo" @redo="grid.redo"
      @set-group-field="grid.setGroupField" @export-csv="onExportCsv" @import="showImportModal = true" @update:search-text="onSearchTextUpdate"
      @print="onPrint" @set-row-density="rowDensity = $event" @auto-fit-columns="onAutoFitColumns"
    />
    <div class="mt-workbench__content">
      <div class="mt-workbench__main">
        <MetaFormView
          v-if="activeViewType === 'form'"
          :fields="grid.fields.value" :hidden-field-ids="workbench.activeView.value?.hiddenFieldIds"
          :record="selectedRecordResolved" :loading="grid.loading.value"
          :read-only="formReadOnly"
          :submitting="formSubmitting"
          :success-message="formSuccessMessage"
          :error-message="formErrorMessage"
          :field-errors="formFieldErrors"
          :link-summaries-by-field="selectedRecordLinkSummaries"
          @submit="onFormSubmit" @open-link-picker="openLinkPicker"
        />
        <MetaKanbanView
          v-else-if="activeViewType === 'kanban'"
          :rows="grid.rows.value" :fields="grid.fields.value" :loading="grid.loading.value"
          :can-create="caps.canCreateRecord.value" :can-edit="caps.canEditRecord.value"
          @select-record="onSelectRecord" @patch-cell="onPatchCell" @create-record="onKanbanCreateRecord"
        />
        <MetaGalleryView
          v-else-if="activeViewType === 'gallery'"
          :rows="grid.rows.value" :fields="grid.fields.value" :loading="grid.loading.value"
          :current-page="grid.currentPage.value" :total-pages="grid.totalPages.value"
          @select-record="onSelectRecord" @go-to-page="grid.goToPage"
        />
        <MetaCalendarView
          v-else-if="activeViewType === 'calendar'"
          :rows="grid.rows.value" :fields="grid.fields.value" :loading="grid.loading.value"
          :can-create="caps.canCreateRecord.value"
          @select-record="onSelectRecord" @create-record="onKanbanCreateRecord"
        />
        <MetaTimelineView
          v-else-if="activeViewType === 'timeline'"
          :rows="grid.rows.value" :fields="grid.fields.value" :loading="grid.loading.value"
          @select-record="onSelectRecord"
        />
        <MetaGridTable
          v-else
          :rows="grid.rows.value" :visible-fields="grid.visibleFields.value" :sort-rules="grid.sortRules.value"
          :loading="grid.loading.value" :current-page="grid.currentPage.value" :total-pages="grid.totalPages.value"
          :start-index="pageStartIndex" :selected-record-id="selectedRecordId" :can-edit="caps.canEditRecord.value"
          :can-delete="caps.canDeleteRecord.value" :column-widths="grid.columnWidths.value" :link-summaries="grid.linkSummaries.value"
          :enable-multi-select="caps.canDeleteRecord.value"
          :group-field="grid.groupField.value"
          :search-text="searchText" :row-density="rowDensity"
          @select-record="onSelectRecord" @toggle-sort="onToggleSort" @patch-cell="onPatchCell"
          @go-to-page="grid.goToPage" @open-link-picker="onGridLinkPicker" @resize-column="grid.setColumnWidth"
          @bulk-delete="onBulkDelete" @reorder-field="onReorderField"
        />
      </div>
      <MetaRecordDrawer
        :visible="!!selectedRecordId" :record="selectedRecordResolved" :fields="grid.fields.value"
        :can-edit="caps.canEditRecord.value" :can-comment="caps.canComment.value" :can-delete="caps.canDeleteRecord.value"
        :link-summaries-by-field="selectedRecordLinkSummaries"
        :record-ids="drawerRecordIds"
        @close="selectedRecordId = null" @delete="onDeleteRecord" @patch="onDrawerPatch"
        @toggle-comments="showComments = !showComments" @open-link-picker="openLinkPicker"
        @navigate="onDrawerNavigate"
      />
      <MetaCommentsDrawer
        :visible="showComments && !!selectedRecordId" :comments="commentsState.comments.value"
        :loading="commentsState.loading.value" :can-comment="caps.canComment.value" :can-resolve="caps.canComment.value"
        :draft="commentDraft" :submitting="commentsState.submitting.value" :error="commentsState.error.value"
        :resolving-ids="commentsState.resolvingIds.value"
        @close="showComments = false" @submit="onSubmitComment" @resolve="onResolveComment" @update:draft="commentDraft = $event"
      />
    </div>
    <div v-if="showShortcuts" class="mt-workbench__shortcuts-overlay" @click.self="showShortcuts = false">
      <div class="mt-workbench__shortcuts">
        <div class="mt-workbench__shortcuts-header">
          <strong>Keyboard Shortcuts</strong>
          <button class="mt-workbench__shortcuts-close" @click="showShortcuts = false">&times;</button>
        </div>
        <div class="mt-workbench__shortcuts-grid">
          <div class="mt-workbench__shortcut"><kbd>&#x2191; &#x2193; &#x2190; &#x2192;</kbd><span>Navigate cells</span></div>
          <div class="mt-workbench__shortcut"><kbd>Enter</kbd><span>Edit cell</span></div>
          <div class="mt-workbench__shortcut"><kbd>Escape</kbd><span>Cancel edit / close</span></div>
          <div class="mt-workbench__shortcut"><kbd>Tab</kbd><span>Next cell</span></div>
          <div class="mt-workbench__shortcut"><kbd>Ctrl+C</kbd><span>Copy cell value</span></div>
          <div class="mt-workbench__shortcut"><kbd>Ctrl+V</kbd><span>Paste into cell</span></div>
          <div class="mt-workbench__shortcut"><kbd>Ctrl+Z</kbd><span>Undo</span></div>
          <div class="mt-workbench__shortcut"><kbd>Ctrl+Y</kbd><span>Redo</span></div>
          <div class="mt-workbench__shortcut"><kbd>?</kbd><span>Toggle this help</span></div>
        </div>
      </div>
    </div>
    <MetaImportModal :visible="showImportModal" :fields="grid.fields.value" @close="showImportModal = false" @import="onBulkImport" />
    <MetaLinkPicker :visible="linkPickerVisible" :field="linkPickerField" :current-value="linkPickerCurrentValue"
      @close="linkPickerVisible = false" @confirm="onLinkPickerConfirm"
    />
    <MetaFieldManager
      :visible="showFieldManager" :fields="workbench.fields.value" :sheet-id="workbench.activeSheetId.value"
      @close="showFieldManager = false" @create-field="onCreateField" @update-field="onUpdateField" @delete-field="onDeleteField"
    />
    <MetaViewManager
      :visible="showViewManager" :views="workbench.views.value" :sheet-id="workbench.activeSheetId.value"
      :active-view-id="workbench.activeViewId.value"
      @close="showViewManager = false" @create-view="onCreateView" @update-view="onUpdateView" @delete-view="onDeleteView"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import type { MetaField, MetaRecord, MetaFieldType, RowDensity, LinkedRecordSummary } from '../types'
import type { MultitableRole } from '../composables/useMultitableCapabilities'
import type { SortRule, FilterConjunction } from '../composables/useMultitableGrid'
import { useMultitableWorkbench } from '../composables/useMultitableWorkbench'
import { useMultitableGrid } from '../composables/useMultitableGrid'
import { useMultitableCapabilities } from '../composables/useMultitableCapabilities'
import { useMultitableComments } from '../composables/useMultitableComments'
import MetaViewTabBar from '../components/MetaViewTabBar.vue'
import MetaToolbar from '../components/MetaToolbar.vue'
import MetaGridTable from '../components/MetaGridTable.vue'
import MetaFormView from '../components/MetaFormView.vue'
import MetaRecordDrawer from '../components/MetaRecordDrawer.vue'
import MetaCommentsDrawer from '../components/MetaCommentsDrawer.vue'
import MetaLinkPicker from '../components/MetaLinkPicker.vue'
import MetaFieldManager from '../components/MetaFieldManager.vue'
import MetaViewManager from '../components/MetaViewManager.vue'
import MetaBasePicker from '../components/MetaBasePicker.vue'
import MetaKanbanView from '../components/MetaKanbanView.vue'
import MetaGalleryView from '../components/MetaGalleryView.vue'
import MetaCalendarView from '../components/MetaCalendarView.vue'
import MetaTimelineView from '../components/MetaTimelineView.vue'
import MetaToast from '../components/MetaToast.vue'
import MetaImportModal from '../components/MetaImportModal.vue'
import type { MetaBase } from '../types'
import { bulkImportRecords } from '../import/bulk-import'

const props = defineProps<{ sheetId?: string; viewId?: string; baseId?: string; recordId?: string; mode?: string; role?: MultitableRole }>()

const role = ref<MultitableRole>(props.role ?? 'editor')
const workbench = useMultitableWorkbench({ initialSheetId: props.sheetId, initialViewId: props.viewId })
const capabilitySource = computed(() => workbench.capabilities.value ?? role.value)
const caps = useMultitableCapabilities(capabilitySource)
const grid = useMultitableGrid({ sheetId: workbench.activeSheetId, viewId: workbench.activeViewId })
const commentsState = useMultitableComments()

const selectedRecordId = ref<string | null>(null)
const showComments = ref(false)
const linkPickerVisible = ref(false)
const linkPickerField = ref<MetaField | null>(null)
const linkPickerRecordId = ref<string | null>(null)
const linkPickerCurrentValue = ref<unknown>(null)
const showFieldManager = ref(false)
const showViewManager = ref(false)
const bases = ref<MetaBase[]>([])
const activeBaseId = ref(props.baseId ?? '')
const toastRef = ref<InstanceType<typeof MetaToast> | null>(null)
const commentDraft = ref('')
const searchText = ref('')
const showShortcuts = ref(false)
const showImportModal = ref(false)
const rowDensity = ref<RowDensity>('normal')
const formSubmitting = ref(false)
const formSuccessMessage = ref<string | null>(null)
const formErrorMessage = ref<string | null>(null)
const formFieldErrors = ref<Record<string, string>>({})
const deepLinkedRecordLinkSummaries = ref<Record<string, LinkedRecordSummary[]>>({})

function showError(msg: string) {
  workbench.error.value = null
  toastRef.value?.showError(msg)
}

function showSuccess(msg: string) {
  toastRef.value?.showSuccess(msg)
}

const activeViewType = computed(() => {
  if (props.mode === 'form') return 'form'
  if (props.mode === 'grid') return 'grid'
  return workbench.activeView.value?.type ?? 'grid'
})
const formReadOnly = computed(() => {
  return selectedRecordResolved.value ? !caps.canEditRecord.value : !caps.canCreateRecord.value
})
const pageStartIndex = computed(() => grid.page.value.offset)
const selectedRecordLinkSummaries = computed<Record<string, LinkedRecordSummary[]>>(() => {
  const recordId = selectedRecordId.value
  if (!recordId) return {}
  const fromGrid = grid.linkSummaries.value[recordId]
  if (fromGrid) return fromGrid
  if (deepLinkedRecord.value?.id === recordId) return deepLinkedRecordLinkSummaries.value
  return {}
})

function applyLocalLinkSummaries(recordId: string, fieldId: string, summaries: LinkedRecordSummary[]) {
  grid.linkSummaries.value = {
    ...grid.linkSummaries.value,
    [recordId]: {
      ...(grid.linkSummaries.value[recordId] ?? {}),
      [fieldId]: summaries,
    },
  }
  if (deepLinkedRecord.value?.id === recordId) {
    deepLinkedRecordLinkSummaries.value = {
      ...deepLinkedRecordLinkSummaries.value,
      [fieldId]: summaries,
    }
  }
}

async function loadCommentsForRecord(recordId: string) {
  if (workbench.activeSheetId.value) {
    await commentsState.loadComments({ containerId: workbench.activeSheetId.value, targetId: recordId })
  }
}

async function selectRecord(recordId: string, opts?: { openComments?: boolean }) {
  selectedRecordId.value = recordId
  commentDraft.value = ''
  showComments.value = opts?.openComments === true
  await loadCommentsForRecord(recordId)
}

function onSelectRecord(recordId: string) {
  void selectRecord(recordId)
}

function onToggleSort(fieldId: string) {
  const ex = grid.sortRules.value.find((r) => r.fieldId === fieldId)
  if (!ex) grid.addSortRule({ fieldId, direction: 'asc' })
  else if (ex.direction === 'asc') grid.addSortRule({ fieldId, direction: 'desc' })
  else grid.removeSortRule(fieldId)
  grid.applySortFilter()
}

function onUpdateSort(index: number, rule: SortRule) {
  grid.sortRules.value[index] = rule; grid.sortFilterDirty.value = true
}

function onSearchTextUpdate(text: string) {
  searchText.value = text
  grid.setSearchQuery(text)
}

function onClearFilters() { grid.clearFilters(); grid.applySortFilter() }
function onSetConjunction(c: FilterConjunction) { grid.filterConjunction.value = c; grid.sortFilterDirty.value = true }

async function onPatchCell(recordId: string, fieldId: string, value: unknown, version: number) { await grid.patchCell(recordId, fieldId, value, version) }
async function onAddRecord() { await grid.createRecord() }
async function onKanbanCreateRecord(data: Record<string, unknown>) { await grid.createRecord(data) }
async function onDeleteRecord() {
  if (!selectedRecordId.value) return
  const deleted = await grid.deleteRecord(selectedRecordId.value)
  if (deleted) {
    selectedRecordId.value = null
    showComments.value = false
    commentDraft.value = ''
    showSuccess('Record deleted')
    return
  }
  if (grid.error.value) showError(grid.error.value)
}

async function onDrawerPatch(fieldId: string, value: unknown) {
  if (!selectedRecordResolved.value) return
  const record = selectedRecordResolved.value
  await grid.patchCell(record.id, fieldId, value, record.version)
  if (grid.error.value) {
    showError(grid.error.value)
    return
  }
  if (deepLinkedRecord.value?.id === record.id) {
    deepLinkedRecord.value = {
      ...deepLinkedRecord.value,
      version: deepLinkedRecord.value.version + 1,
      data: { ...deepLinkedRecord.value.data, [fieldId]: value },
    }
  }
  showSuccess('Record updated')
}

async function onFormSubmit(data: Record<string, unknown>) {
  const viewId = workbench.activeViewId.value
  if (viewId && activeViewType.value === 'form') {
    try {
      formSubmitting.value = true
      formSuccessMessage.value = null
      formErrorMessage.value = null
      formFieldErrors.value = {}
      const result = await workbench.client.submitForm(viewId, {
        recordId: selectedRecordResolved.value?.id,
        expectedVersion: selectedRecordResolved.value?.version,
        data,
      })
      deepLinkedRecord.value = result.record
      selectedRecordId.value = result.record.id
      await grid.loadViewData(grid.page.value.offset)
      formSuccessMessage.value = result.mode === 'create' ? 'Record created' : 'Changes saved'
      formFieldErrors.value = {}
      showSuccess('Form submitted')
    } catch (e: any) {
      const message = e.message ?? 'Form submit failed'
      formErrorMessage.value = message
      formFieldErrors.value = e.fieldErrors ?? {}
      showError(message)
    } finally {
      formSubmitting.value = false
    }
  } else if (selectedRecordResolved.value) {
    const changes = Object.entries(data).filter(([k, v]) => v !== selectedRecordResolved.value!.data[k]).map(([fieldId, value]) => ({ recordId: selectedRecordResolved.value!.id, fieldId, value, expectedVersion: selectedRecordResolved.value!.version }))
    if (changes.length) {
      await workbench.client.patchRecords({ sheetId: workbench.activeSheetId.value || undefined, viewId: viewId || undefined, changes })
      await grid.loadViewData(grid.page.value.offset)
      showSuccess('Record updated')
    }
  } else await grid.createRecord(data)
}

async function onSubmitComment(content: string) {
  if (!workbench.activeSheetId.value || !selectedRecordId.value) return
  try {
    await commentsState.addComment({ containerId: workbench.activeSheetId.value, targetId: selectedRecordId.value, content })
    commentDraft.value = ''
    showSuccess('Comment added')
  } catch (e: any) {
    showError(commentsState.error.value ?? e.message ?? 'Failed to add comment')
  }
}

async function onResolveComment(commentId: string) {
  try {
    await commentsState.resolveComment(commentId)
    showSuccess('Comment resolved')
  } catch (e: any) {
    showError(commentsState.error.value ?? e.message ?? 'Failed to resolve comment')
  }
}

function openLinkPicker(field: MetaField) { linkPickerField.value = field; linkPickerRecordId.value = selectedRecordId.value; linkPickerCurrentValue.value = selectedRecordResolved.value?.data[field.id] ?? null; linkPickerVisible.value = true }
function onGridLinkPicker(ctx: { recordId: string; field: MetaField }) { const row = grid.rows.value.find((r) => r.id === ctx.recordId); linkPickerField.value = ctx.field; linkPickerRecordId.value = ctx.recordId; linkPickerCurrentValue.value = row?.data[ctx.field.id] ?? null; linkPickerVisible.value = true }
async function onLinkPickerConfirm(payload: { recordIds: string[]; summaries: LinkedRecordSummary[] }) {
  linkPickerVisible.value = false
  if (!linkPickerRecordId.value || !linkPickerField.value) return
  const recordId = linkPickerRecordId.value
  const fieldId = linkPickerField.value.id
  const previousSummaries = selectedRecordLinkSummaries.value[fieldId] ?? grid.linkSummaries.value[recordId]?.[fieldId]
  const row = grid.rows.value.find((r) => r.id === recordId)
  if (row) {
    await grid.patchCell(row.id, fieldId, payload.recordIds, row.version, {
      previousLinkSummaries: previousSummaries,
      nextLinkSummaries: payload.summaries,
    })
    if (grid.error.value) {
      showError(grid.error.value)
      return
    }
  } else if (selectedRecordResolved.value?.id === recordId) {
    try {
      const result = await workbench.client.patchRecords({
        sheetId: workbench.activeSheetId.value || undefined,
        viewId: workbench.activeViewId.value || undefined,
        changes: [{ recordId, fieldId, value: payload.recordIds, expectedVersion: selectedRecordResolved.value.version }],
      })
      const nextVersion = result.updated?.find((item) => item.recordId === recordId)?.version ?? selectedRecordResolved.value.version + 1
      deepLinkedRecord.value = {
        ...selectedRecordResolved.value,
        version: nextVersion,
        data: {
          ...selectedRecordResolved.value.data,
          [fieldId]: payload.recordIds,
        },
      }
      applyLocalLinkSummaries(recordId, fieldId, result.linkSummaries?.[recordId]?.[fieldId] ?? payload.summaries)
    } catch (e: any) {
      showError(e.message ?? 'Failed to update linked records')
      return
    }
  } else {
    return
  }
  showSuccess('Linked records updated')
}

// --- Field management ---
async function onCreateField(input: { sheetId: string; name: string; type: string }) {
  try {
    await workbench.client.createField({ sheetId: input.sheetId, name: input.name, type: input.type as MetaFieldType })
    await workbench.loadSheetMeta(workbench.activeSheetId.value)
    await grid.loadViewData(grid.page.value.offset)
  } catch (e: any) { showError(e.message ?? 'Failed to create field') }
}

async function onUpdateField(fieldId: string, input: { name?: string; order?: number }) {
  try {
    await workbench.client.updateField(fieldId, input)
    await workbench.loadSheetMeta(workbench.activeSheetId.value)
    await grid.loadViewData(grid.page.value.offset)
  } catch (e: any) { showError(e.message ?? 'Failed to update field') }
}

async function onDeleteField(fieldId: string) {
  try {
    await workbench.client.deleteField(fieldId)
    await workbench.loadSheetMeta(workbench.activeSheetId.value)
    await grid.loadViewData(grid.page.value.offset)
  } catch (e: any) { showError(e.message ?? 'Failed to delete field') }
}

// --- View management ---
async function onCreateView(input: { sheetId: string; name: string; type: string }) {
  try {
    const res = await workbench.client.createView({ sheetId: input.sheetId, name: input.name, type: input.type })
    await workbench.loadSheetMeta(workbench.activeSheetId.value)
    workbench.selectView(res.view.id)
  } catch (e: any) { showError(e.message ?? 'Failed to create view') }
}

async function onUpdateView(viewId: string, input: { name?: string }) {
  try {
    await workbench.client.updateView(viewId, input)
    await workbench.loadSheetMeta(workbench.activeSheetId.value)
  } catch (e: any) { showError(e.message ?? 'Failed to update view') }
}

async function onDeleteView(viewId: string) {
  try {
    await workbench.client.deleteView(viewId)
    await workbench.loadSheetMeta(workbench.activeSheetId.value)
    if (workbench.activeViewId.value === viewId) workbench.selectView(workbench.views.value[0]?.id ?? '')
  } catch (e: any) { showError(e.message ?? 'Failed to delete view') }
}

// --- Sheet management ---
async function onCreateSheet(name: string) {
  try {
    const res = await workbench.client.createSheet({ name, baseId: activeBaseId.value || undefined, seed: true })
    await workbench.loadSheets()
    workbench.selectSheet(res.sheet.id)
  } catch (e: any) { showError(e.message ?? 'Failed to create sheet') }
}

// --- Base management ---
async function loadBases() {
  try {
    const data = await workbench.client.listBases()
    bases.value = data.bases ?? []
    if (!activeBaseId.value && bases.value.length) activeBaseId.value = bases.value[0].id
  } catch { /* silent */ }
}

async function onSelectBase(baseId: string) {
  activeBaseId.value = baseId
  try {
    const ctx = await workbench.client.loadContext({ baseId })
    workbench.sheets.value = ctx.sheets ?? []
    workbench.views.value = ctx.views ?? []
    if (ctx.sheet) workbench.selectSheet(ctx.sheet.id)
    else if (workbench.sheets.value.length) workbench.selectSheet(workbench.sheets.value[0].id)
  } catch (e: any) { showError(e.message ?? 'Failed to load base') }
}

async function onCreateBase(name: string) {
  try {
    const res = await workbench.client.createBase({ name })
    bases.value.push(res.base)
    await onSelectBase(res.base.id)
  } catch (e: any) { showError(e.message ?? 'Failed to create base') }
}

// --- Print ---
function onPrint() { window.print() }

// --- Column auto-fit ---
function onAutoFitColumns() {
  const fields = grid.visibleFields.value
  const rows = grid.rows.value
  for (const f of fields) {
    let maxLen = f.name.length
    for (const r of rows) {
      const v = r.data[f.id]
      if (v != null) maxLen = Math.max(maxLen, String(v).length)
    }
    const width = Math.max(80, Math.min(400, maxLen * 8 + 24))
    grid.setColumnWidth(f.id, width)
  }
}

// --- Field reorder ---
function onReorderField(fromId: string, toId: string) {
  const arr = [...grid.fields.value]
  const fromIdx = arr.findIndex((f) => f.id === fromId)
  const toIdx = arr.findIndex((f) => f.id === toId)
  if (fromIdx < 0 || toIdx < 0) return
  const [moved] = arr.splice(fromIdx, 1)
  arr.splice(toIdx, 0, moved)
  grid.fields.value = arr
  // Persist order through field.order until backend exposes a dedicated view column-order contract.
  Promise.all(arr.map((field, index) => workbench.client.updateField(field.id, { order: index }))).catch(() => {})
}

// --- Bulk import ---
async function onBulkImport(records: Array<Record<string, unknown>>) {
  try {
    const result = await bulkImportRecords({
      client: workbench.client,
      sheetId: workbench.activeSheetId.value || undefined,
      viewId: workbench.activeViewId.value || undefined,
      records,
    })
    showImportModal.value = false
    if (result.succeeded > 0) {
      await grid.loadViewData(grid.page.value.offset)
    }
    if (result.failed === 0) {
      showSuccess(`${result.succeeded} record(s) imported`)
      return
    }
    if (result.succeeded > 0) {
      showError(`${result.failed} record(s) failed to import. ${result.firstError ?? ''}`.trim())
      showSuccess(`${result.succeeded} record(s) imported`)
      return
    }
    showError(result.firstError ?? 'Import failed')
  } catch (e: any) {
    showImportModal.value = false
    showError(e.message ?? 'Import failed')
  }
}

// --- CSV export ---
function onExportCsv() {
  const visibleFields = grid.visibleFields.value
  if (!visibleFields.length) return
  const header = visibleFields.map((f) => csvEscape(f.name)).join(',')
  const rows = grid.rows.value.map((row) =>
    visibleFields.map((f) => {
      const v = row.data[f.id]
      if (v === null || v === undefined) return ''
      if (typeof v === 'boolean') return v ? 'true' : 'false'
      if (Array.isArray(v)) return csvEscape(v.map(String).join('; '))
      return csvEscape(String(v))
    }).join(','),
  )
  const csv = [header, ...rows].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${workbench.activeSheetId.value || 'export'}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

function csvEscape(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) return `"${val.replace(/"/g, '""')}"`
  return val
}

const drawerRecordIds = computed(() => grid.rows.value.map((r) => r.id))

function onDrawerNavigate(recordId: string) {
  void selectRecord(recordId)
}

// --- Beforeunload: warn on unsaved changes ---
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (formSubmitting.value) {
    e.preventDefault()
    e.returnValue = ''
  }
}

function onGlobalKeydown(e: KeyboardEvent) {
  const mod = e.metaKey || e.ctrlKey
  if (mod && e.key === 'z' && !e.shiftKey) { e.preventDefault(); grid.undo() }
  else if (mod && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); grid.redo() }
  else if (e.key === '?' && !(e.target as HTMLElement)?.closest('input, textarea, select')) { showShortcuts.value = !showShortcuts.value }
}

// --- Record deep-link (read recordId from URL hash) ---
function parseDeepLink(): string | null {
  try {
    const hash = window.location.hash // e.g. #recordId=rec_abc123
    const m = hash.match(/recordId=([^&]+)/)
    return m ? decodeURIComponent(m[1]) : null
  } catch { return null }
}

// Update URL hash when a record is selected
watch(selectedRecordId, (rid) => {
  try {
    if (rid) window.history.replaceState(null, '', `#recordId=${encodeURIComponent(rid)}`)
    else if (window.location.hash.includes('recordId=')) window.history.replaceState(null, '', window.location.pathname + window.location.search)
  } catch { /* */ }
})

watch([selectedRecordId, () => workbench.activeViewId.value], () => {
  formSuccessMessage.value = null
  formErrorMessage.value = null
  formFieldErrors.value = {}
})

// --- Bulk delete ---
async function onBulkDelete(recordIds: string[]) {
  try {
    await Promise.all(recordIds.map((rid) => grid.deleteRecord(rid)))
    if (selectedRecordId.value && recordIds.includes(selectedRecordId.value)) selectedRecordId.value = null
    showSuccess(`${recordIds.length} record(s) deleted`)
  } catch (e: any) { showError(e.message ?? 'Bulk delete failed') }
}

// --- Deep-link record fetch (when record not in current page) ---
const deepLinkedRecord = ref<MetaRecord | null>(null)

async function resolveDeepLink(recordId: string) {
  // First check if it's in the current rows
  const inPage = grid.rows.value.find((r) => r.id === recordId)
  if (inPage) {
    await selectRecord(recordId)
    return
  }
  // Fetch from server
  try {
    const ctx = await workbench.client.getRecord(recordId, {
      sheetId: workbench.activeSheetId.value || undefined,
      viewId: workbench.activeViewId.value || undefined,
    })
    deepLinkedRecord.value = ctx.record
    deepLinkedRecordLinkSummaries.value = ctx.linkSummaries ?? {}
    await selectRecord(recordId)
  } catch (e: any) {
    showError(`Record not found: ${recordId}`)
  }
}

// Override selectedRecord to also consider deep-linked record
const selectedRecordResolved = computed<MetaRecord | null>(() => {
  if (selectedRecordId.value) {
    const inPage = grid.rows.value.find((r) => r.id === selectedRecordId.value)
    if (inPage) return inPage
    if (deepLinkedRecord.value?.id === selectedRecordId.value) return deepLinkedRecord.value
  }
  return null
})

// --- Standalone form bootstrap ---
async function loadStandaloneForm() {
  if (activeViewType.value !== 'form' || !workbench.activeViewId.value) return
  try {
    const ctx = await workbench.client.loadFormContext({
      sheetId: workbench.activeSheetId.value || undefined,
      viewId: workbench.activeViewId.value || undefined,
      recordId: selectedRecordId.value || undefined,
    })
    if (ctx.fields?.length) grid.fields.value = ctx.fields
    if (ctx.record) {
      deepLinkedRecord.value = ctx.record
      selectedRecordId.value = ctx.record.id
    }
  } catch { /* silent — grid loadViewData will handle */ }
}

watch(
  [activeViewType, () => workbench.activeViewId.value, selectedRecordId],
  ([type, viewId]) => {
    if (type === 'form' && viewId) void loadStandaloneForm()
  },
)

onMounted(async () => {
  window.addEventListener('beforeunload', onBeforeUnload)
  try {
    loadBases()
    await workbench.loadSheets()
    const deepRecordId = props.recordId ?? parseDeepLink()
    if (deepRecordId) await resolveDeepLink(deepRecordId)
    if (activeViewType.value === 'form') loadStandaloneForm()
  } catch (e: any) {
    showError(e.message ?? 'Failed to initialize workbench')
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnload)
})
</script>

<style scoped>
.mt-workbench { display: flex; flex-direction: column; height: 100%; background: #fff; }
.mt-workbench__content { display: flex; flex: 1; min-height: 0; }
.mt-workbench__main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.mt-workbench__actions { display: flex; gap: 6px; padding: 4px 16px 0; }
.mt-workbench__mgr-btn { padding: 3px 10px; border: 1px solid #ddd; border-radius: 4px; background: #fff; font-size: 12px; cursor: pointer; color: #666; }
.mt-workbench__mgr-btn:hover { background: #f5f7fa; color: #409eff; border-color: #c0d8f0; }
.mt-workbench__base-bar { padding: 8px 16px 0; border-bottom: 1px solid #f0f0f0; }
.mt-workbench__shortcuts-overlay { position: fixed; inset: 0; z-index: 100; background: rgba(0,0,0,.3); display: flex; align-items: center; justify-content: center; }
.mt-workbench__shortcuts { background: #fff; border-radius: 8px; padding: 20px 24px; min-width: 320px; box-shadow: 0 8px 24px rgba(0,0,0,.15); }
.mt-workbench__shortcuts-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; font-size: 15px; }
.mt-workbench__shortcuts-close { border: none; background: none; font-size: 20px; cursor: pointer; color: #999; }
.mt-workbench__shortcuts-grid { display: flex; flex-direction: column; gap: 8px; }
.mt-workbench__shortcut { display: flex; align-items: center; gap: 12px; font-size: 13px; }
.mt-workbench__shortcut kbd { background: #f0f0f0; border: 1px solid #ddd; border-radius: 3px; padding: 2px 8px; font-family: monospace; font-size: 12px; min-width: 80px; text-align: center; }
@media print {
  .mt-workbench__base-bar, .mt-workbench__actions, .mt-workbench__shortcuts-overlay { display: none !important; }
  .mt-workbench__content { overflow: visible !important; }
  .mt-workbench__main { overflow: visible !important; }
}
</style>
