<template>
  <div class="meta-grid" :class="[rowDensity ? `meta-grid--${rowDensity}` : '']" tabindex="0" role="grid" aria-label="Data grid" @keydown="onKeydown">
    <div v-if="enableMultiSelect && selectedIds.size > 0" class="meta-grid__bulk-bar">
      <span class="meta-grid__bulk-count">{{ selectedIds.size }} selected</span>
      <button v-if="canDelete" class="meta-grid__bulk-btn meta-grid__bulk-btn--danger" aria-label="Delete selected records" @click="onBulkDelete">Delete selected</button>
      <button class="meta-grid__bulk-btn" aria-label="Clear selection" @click="selectedIds = new Set(); emit('selection-change', [])">Clear</button>
    </div>
    <div class="meta-grid__table-wrap">
      <table class="meta-grid__table">
        <thead>
          <tr>
            <th v-if="enableMultiSelect" class="meta-grid__check-col">
              <input type="checkbox" :checked="allSelected" @change="toggleSelectAll" />
            </th>
            <th class="meta-grid__row-num">#</th>
            <MetaFieldHeader
              v-for="field in visibleFields"
              :key="field.id"
              :field="field"
              :sort-direction="getSortDir(field.id)"
              :sortable="isSortable(field)"
              :width="columnWidths?.[field.id]"
              @toggle-sort="emit('toggle-sort', field.id)"
              @resize="(fid, w) => emit('resize-column', fid, w)"
              @reorder="(from, to) => emit('reorder-field', from, to)"
            />
          </tr>
        </thead>
        <tbody v-if="groupedRows">
          <template v-for="group in groupedRows" :key="group.key">
            <tr class="meta-grid__group-header" @click="toggleGroup(group.key)">
              <td :colspan="colSpan">
                <span class="meta-grid__group-toggle">{{ collapsedGroups.has(group.key) ? '&#x25B6;' : '&#x25BC;' }}</span>
                <span class="meta-grid__group-label">{{ group.label }}</span>
                <span class="meta-grid__group-count">({{ group.count }})</span>
              </td>
            </tr>
            <template v-if="!collapsedGroups.has(group.key)">
              <tr
                v-for="(row, ri) in group.rows"
                :key="row.id"
                role="row"
                :aria-selected="row.id === selectedRecordId || undefined"
                class="meta-grid__row"
                :class="{ 'meta-grid__row--selected': row.id === selectedRecordId, 'meta-grid__row--focused': focusRow === flatIndex(group, ri) }"
                @click="emit('select-record', row.id)"
              >
                <td v-if="enableMultiSelect" class="meta-grid__check-col" @click.stop>
                  <input type="checkbox" :checked="selectedIds.has(row.id)" @change="toggleSelectRow(row.id)" />
                </td>
                <td class="meta-grid__row-num">{{ startIndex + flatIndex(group, ri) + 1 }}</td>
                <td
                  v-for="(field, ci) in visibleFields"
                  :key="field.id"
                  class="meta-grid__cell"
                  :class="{ 'meta-grid__cell--editing': isEditing(row.id, field.id), 'meta-grid__cell--readonly': !isEditable(field), 'meta-grid__cell--focused': focusRow === flatIndex(group, ri) && focusCol === ci }"
                  :style="cellStyle(field.id)"
                  @dblclick="startEdit(row, field)"
                  @click.stop="onCellClick(flatIndex(group, ri), ci, row.id)"
                >
                  <MetaCellEditor
                    v-if="isEditing(row.id, field.id)"
                    :field="field"
                    :model-value="editCell!.value"
                    :upload-fn="props.uploadFn"
                    :upload-context="{ recordId: row.id, fieldId: field.id }"
                    @update:model-value="editCell!.value = $event"
                    @confirm="confirmEdit(row)"
                    @cancel="cancelEdit"
                    @open-link-picker="openLinkPickerFromCell(row.id, field)"
                  />
                  <MetaCellRenderer
                    v-else
                    :field="field"
                    :value="row.data[field.id]"
                    :link-summaries="props.linkSummaries?.[row.id]?.[field.id]"
                    :attachment-summaries="props.attachmentSummaries?.[row.id]?.[field.id]"
                  />
                </td>
              </tr>
            </template>
          </template>
          <tr v-if="!rows.length && !loading">
            <td :colspan="colSpan" class="meta-grid__empty">
              <div class="meta-grid__empty-icon">&#x1F4CB;</div>
              <div class="meta-grid__empty-title">No records yet</div>
              <div class="meta-grid__empty-hint">Click <strong>+ New Record</strong> to add your first row</div>
            </td>
          </tr>
        </tbody>
        <tbody v-else>
          <template v-for="(row, ri) in filteredRows" :key="row.id">
            <tr
              role="row"
              :aria-selected="row.id === selectedRecordId || undefined"
              class="meta-grid__row"
              :class="{ 'meta-grid__row--selected': row.id === selectedRecordId, 'meta-grid__row--focused': focusRow === ri }"
              @click="emit('select-record', row.id)"
            >
              <td v-if="enableMultiSelect" class="meta-grid__check-col" @click.stop>
                <input type="checkbox" :checked="selectedIds.has(row.id)" @change="toggleSelectRow(row.id)" />
              </td>
              <td class="meta-grid__row-num">
                <button class="meta-grid__expand-btn" :class="{ 'meta-grid__expand-btn--open': expandedRowIds.has(row.id) }" :aria-label="expandedRowIds.has(row.id) ? 'Collapse row' : 'Expand row'" @click.stop="toggleRowExpand(row.id)">&#x25B6;</button>
                <span>{{ startIndex + ri + 1 }}</span>
              </td>
              <td
                v-for="(field, ci) in visibleFields"
                :key="field.id"
                role="gridcell"
                :aria-label="field.name"
                class="meta-grid__cell"
                :class="{ 'meta-grid__cell--editing': isEditing(row.id, field.id), 'meta-grid__cell--readonly': !isEditable(field), 'meta-grid__cell--focused': focusRow === ri && focusCol === ci }"
                :style="cellStyle(field.id)"
                @dblclick="startEdit(row, field)"
                @click.stop="onCellClick(ri, ci, row.id)"
              >
                <MetaCellEditor
                  v-if="isEditing(row.id, field.id)"
                  :field="field"
                  :model-value="editCell!.value"
                  :upload-fn="props.uploadFn"
                  :upload-context="{ recordId: row.id, fieldId: field.id }"
                  @update:model-value="editCell!.value = $event"
                  @confirm="confirmEdit(row)"
                  @cancel="cancelEdit"
                  @open-link-picker="openLinkPickerFromCell(row.id, field)"
                />
                <MetaCellRenderer
                  v-else
                  :field="field"
                  :value="row.data[field.id]"
                  :link-summaries="props.linkSummaries?.[row.id]?.[field.id]"
                  :attachment-summaries="props.attachmentSummaries?.[row.id]?.[field.id]"
                />
              </td>
            </tr>
            <tr v-if="expandedRowIds.has(row.id)" class="meta-grid__expand-row">
              <td :colspan="colSpan" class="meta-grid__expand-detail">
                <div class="meta-grid__expand-fields">
                  <div v-for="field in visibleFields" :key="field.id" class="meta-grid__expand-field">
                    <span class="meta-grid__expand-label">{{ field.name }}</span>
                    <span class="meta-grid__expand-value">
                      <MetaCellRenderer
                        :field="field"
                        :value="row.data[field.id]"
                        :link-summaries="props.linkSummaries?.[row.id]?.[field.id]"
                        :attachment-summaries="props.attachmentSummaries?.[row.id]?.[field.id]"
                      />
                    </span>
                  </div>
                </div>
              </td>
            </tr>
          </template>
          <tr v-if="!filteredRows.length && !loading">
            <td :colspan="colSpan" class="meta-grid__empty">
              <template v-if="searchText">
                <div class="meta-grid__empty-icon">&#x1F50D;</div>
                <div class="meta-grid__empty-title">No matching records</div>
                <div class="meta-grid__empty-hint">Try a different search term</div>
              </template>
              <template v-else>
                <div class="meta-grid__empty-icon">&#x1F4CB;</div>
                <div class="meta-grid__empty-title">No records yet</div>
                <div class="meta-grid__empty-hint">Click <strong>+ New Record</strong> to add your first row</div>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="totalPages > 1" class="meta-grid__pagination">
      <button class="meta-grid__page-btn" :disabled="currentPage <= 1" @click="emit('go-to-page', currentPage - 1)">&lsaquo; Prev</button>
      <span class="meta-grid__page-info">{{ currentPage }} / {{ totalPages }}</span>
      <button class="meta-grid__page-btn" :disabled="currentPage >= totalPages" @click="emit('go-to-page', currentPage + 1)">Next &rsaquo;</button>
    </div>
    <div v-if="loading" class="meta-grid__loading" aria-live="polite" aria-label="Loading data">
      <div class="meta-grid__skeleton">
        <div v-for="i in 5" :key="i" class="meta-grid__skeleton-row">
          <div v-for="j in Math.min(visibleFields.length || 4, 6)" :key="j" class="meta-grid__skeleton-cell"></div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { MetaAttachment, MetaAttachmentUploadFn, MetaField, MetaRecord, RowDensity } from '../types'
import type { SortRule } from '../composables/useMultitableGrid'
import MetaCellRenderer from './cells/MetaCellRenderer.vue'
import MetaCellEditor from './cells/MetaCellEditor.vue'
import MetaFieldHeader from './MetaFieldHeader.vue'

const EDITABLE = new Set(['string', 'number', 'boolean', 'date', 'select', 'link', 'attachment'])

interface EditingCell { recordId: string; fieldId: string; value: unknown }

const props = defineProps<{
  rows: MetaRecord[]
  visibleFields: MetaField[]
  sortRules: SortRule[]
  loading: boolean
  currentPage: number
  totalPages: number
  startIndex: number
  selectedRecordId?: string | null
  canEdit: boolean
  canDelete?: boolean
  columnWidths?: Record<string, number>
  linkSummaries?: Record<string, Record<string, { id: string; display: string }[]>>
  attachmentSummaries?: Record<string, Record<string, MetaAttachment[]>>
  enableMultiSelect?: boolean
  groupField?: MetaField | null
  searchText?: string
  rowDensity?: RowDensity
  uploadFn?: MetaAttachmentUploadFn
}>()

const emit = defineEmits<{
  (e: 'select-record', recordId: string): void
  (e: 'toggle-sort', fieldId: string): void
  (e: 'patch-cell', recordId: string, fieldId: string, value: unknown, version: number): void
  (e: 'go-to-page', page: number): void
  (e: 'open-link-picker', ctx: { recordId: string; field: MetaField }): void
  (e: 'resize-column', fieldId: string, width: number): void
  (e: 'selection-change', recordIds: string[]): void
  (e: 'bulk-delete', recordIds: string[]): void
  (e: 'reorder-field', fromFieldId: string, toFieldId: string): void
}>()

const editCell = ref<EditingCell | null>(null)
const focusRow = ref(-1)
const focusCol = ref(-1)
const selectedIds = ref<Set<string>>(new Set())
const expandedRowIds = ref<Set<string>>(new Set())

function toggleRowExpand(rowId: string) {
  const s = new Set(expandedRowIds.value)
  if (s.has(rowId)) s.delete(rowId)
  else s.add(rowId)
  expandedRowIds.value = s
}

const allSelected = computed(() => filteredRows.value.length > 0 && selectedIds.value.size === filteredRows.value.length)

// Server-side search replaces client-side filtering.
// filteredRows now passes through rows directly (search is handled by the API).
const filteredRows = computed(() => props.rows)

// --- GroupBy ---
const collapsedGroups = ref<Set<string>>(new Set())

interface RowGroup { key: string; label: string; rows: MetaRecord[]; count: number }

const groupedRows = computed<RowGroup[] | null>(() => {
  if (!props.groupField) return null
  const fid = props.groupField.id
  const map = new Map<string, MetaRecord[]>()
  for (const row of filteredRows.value) {
    const val = row.data[fid]
    const key = val == null || val === '' ? '__ungrouped__' : String(val)
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(row)
  }
  const groups: RowGroup[] = []
  for (const [key, rows] of map) {
    groups.push({ key, label: key === '__ungrouped__' ? '(No value)' : key, rows, count: rows.length })
  }
  return groups
})

function toggleGroup(key: string) {
  const s = new Set(collapsedGroups.value)
  if (s.has(key)) s.delete(key)
  else s.add(key)
  collapsedGroups.value = s
}

// Flat list for keyboard nav (respects collapsed groups)
const displayRows = computed(() => {
  if (!groupedRows.value) return filteredRows.value
  const result: MetaRecord[] = []
  for (const g of groupedRows.value) {
    if (!collapsedGroups.value.has(g.key)) result.push(...g.rows)
  }
  return result
})

function toggleSelectAll() {
  if (allSelected.value) selectedIds.value = new Set()
  else selectedIds.value = new Set(filteredRows.value.map((r) => r.id))
  emit('selection-change', [...selectedIds.value])
}

function toggleSelectRow(recordId: string) {
  const s = new Set(selectedIds.value)
  if (s.has(recordId)) s.delete(recordId)
  else s.add(recordId)
  selectedIds.value = s
  emit('selection-change', [...s])
}

function onBulkDelete() {
  if (selectedIds.value.size > 0) emit('bulk-delete', [...selectedIds.value])
}

watch(() => props.rows, () => { selectedIds.value = new Set() })

const colSpan = computed(() => props.visibleFields.length + 1 + (props.enableMultiSelect ? 1 : 0))

function flatIndex(group: RowGroup, localIdx: number): number {
  if (!groupedRows.value) return localIdx
  let offset = 0
  for (const g of groupedRows.value) {
    if (g.key === group.key) return offset + localIdx
    if (!collapsedGroups.value.has(g.key)) offset += g.rows.length
  }
  return offset + localIdx
}

const getSortDir = (fid: string) => props.sortRules.find((r) => r.fieldId === fid)?.direction ?? null
const isSortable = (f: MetaField) => !['link', 'lookup', 'rollup'].includes(f.type)
const isEditable = (f: MetaField) => props.canEdit && EDITABLE.has(f.type)
const isEditing = (rid: string, fid: string) => editCell.value?.recordId === rid && editCell.value?.fieldId === fid

function cellStyle(fid: string) {
  const w = props.columnWidths?.[fid]
  return w ? { width: `${w}px`, minWidth: `${w}px`, maxWidth: `${w}px` } : undefined
}

function onCellClick(ri: number, ci: number, rid: string) {
  focusRow.value = ri; focusCol.value = ci; emit('select-record', rid)
}

function startEdit(row: MetaRecord, field: MetaField) {
  if (!isEditable(field)) return
  editCell.value = { recordId: row.id, fieldId: field.id, value: row.data[field.id] ?? null }
}

function confirmEdit(row: MetaRecord) {
  if (!editCell.value) return
  const { recordId, fieldId, value } = editCell.value
  if (value !== row.data[fieldId]) emit('patch-cell', recordId, fieldId, value, row.version)
  editCell.value = null
}

function cancelEdit() { editCell.value = null }

function openLinkPickerFromCell(recordId: string, field: MetaField) {
  cancelEdit()
  emit('open-link-picker', { recordId, field })
}

function copyFocusedCell() {
  if (focusRow.value < 0 || focusCol.value < 0) return
  const row = displayRows.value[focusRow.value]
  const field = props.visibleFields[focusCol.value]
  if (!row || !field) return
  const val = row.data[field.id]
  const text = val == null ? '' : String(val)
  navigator.clipboard?.writeText(text).catch(() => {})
}

async function pasteFocusedCell() {
  if (focusRow.value < 0 || focusCol.value < 0) return
  const row = displayRows.value[focusRow.value]
  const field = props.visibleFields[focusCol.value]
  if (!row || !field || !isEditable(field)) return
  try {
    const text = await navigator.clipboard.readText()
    const value = field.type === 'number' && text !== '' ? Number(text) : text
    emit('patch-cell', row.id, field.id, value, row.version)
  } catch { /* clipboard access denied */ }
}

function onKeydown(e: KeyboardEvent) {
  const mod = e.metaKey || e.ctrlKey
  if (mod && e.key === 'c' && !editCell.value) { e.preventDefault(); copyFocusedCell(); return }
  if (mod && e.key === 'v' && !editCell.value) { e.preventDefault(); pasteFocusedCell(); return }
  if (editCell.value) return
  const navRows = displayRows.value
  const maxR = navRows.length - 1, maxC = props.visibleFields.length - 1
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); if (focusRow.value < maxR) { focusRow.value++; if (focusCol.value < 0) focusCol.value = 0; emit('select-record', navRows[focusRow.value].id) } break
    case 'ArrowUp': e.preventDefault(); if (focusRow.value > 0) { focusRow.value--; emit('select-record', navRows[focusRow.value].id) } break
    case 'ArrowRight': case 'Tab':
      if (e.key === 'Tab' && !e.shiftKey) e.preventDefault()
      if (e.key === 'ArrowRight') e.preventDefault()
      if (focusCol.value < maxC) focusCol.value++
      else if (focusRow.value < maxR) { focusRow.value++; focusCol.value = 0; emit('select-record', navRows[focusRow.value].id) }
      break
    case 'ArrowLeft': e.preventDefault();
      if (focusCol.value > 0) focusCol.value--
      else if (focusRow.value > 0) { focusRow.value--; focusCol.value = maxC; emit('select-record', navRows[focusRow.value].id) }
      break
    case 'Enter': e.preventDefault();
      if (focusRow.value >= 0 && focusCol.value >= 0) { const r = navRows[focusRow.value]; const f = props.visibleFields[focusCol.value]; if (r && f) startEdit(r, f) }
      break
    case 'Escape': e.preventDefault(); focusRow.value = -1; focusCol.value = -1; break
  }
}
</script>

<style scoped>
.meta-grid { position: relative; display: flex; flex-direction: column; flex: 1; min-height: 0; outline: none; }
.meta-grid__table-wrap { flex: 1; overflow: auto; }
.meta-grid__table { width: 100%; border-collapse: collapse; font-size: 13px; }
.meta-grid__row-num { width: 56px; min-width: 56px; text-align: center; color: #999; font-size: 12px; background: #f9fafb; border-bottom: 1px solid #eee; border-right: 1px solid #eee; padding: 6px 4px; position: sticky; left: 0; z-index: 1; }
.meta-grid__check-col { position: sticky; z-index: 1; }
.meta-grid__row { transition: background 0.1s; content-visibility: auto; contain-intrinsic-size: auto 36px; }
.meta-grid__row:hover { background: #f5f7fa; }
.meta-grid__row--selected, .meta-grid__row--focused { background: #ecf5ff; }
.meta-grid__cell { padding: 6px 12px; border-bottom: 1px solid #eee; overflow: hidden; text-overflow: ellipsis; cursor: default; }
.meta-grid__cell--editing { padding: 2px 4px; background: #fff; }
.meta-grid__cell--readonly { color: #666; }
.meta-grid__cell--focused { outline: 2px solid #409eff; outline-offset: -2px; }
.meta-grid__empty { text-align: center; padding: 48px 32px; color: #999; }
.meta-grid__empty-icon { font-size: 36px; margin-bottom: 8px; opacity: 0.5; }
.meta-grid__empty-title { font-size: 15px; font-weight: 600; color: #666; margin-bottom: 4px; }
.meta-grid__empty-hint { font-size: 13px; color: #aaa; }
.meta-grid__pagination { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 8px; border-top: 1px solid #e5e7eb; }
.meta-grid__page-btn { padding: 4px 12px; border: 1px solid #ddd; border-radius: 3px; background: #fff; cursor: pointer; font-size: 12px; }
.meta-grid__page-btn:hover:not(:disabled) { background: #f5f5f5; }
.meta-grid__page-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.meta-grid__page-info { font-size: 12px; color: #666; }
.meta-grid__loading { position: absolute; inset: 0; display: flex; align-items: flex-start; justify-content: stretch; background: rgba(255,255,255,.85); z-index: 10; padding-top: 40px; }
.meta-grid__skeleton { width: 100%; padding: 0 12px; }
.meta-grid__skeleton-row { display: flex; gap: 12px; margin-bottom: 12px; }
.meta-grid__skeleton-cell { flex: 1; height: 20px; background: linear-gradient(90deg, #eee 25%, #e0e0e0 50%, #eee 75%); background-size: 200% 100%; border-radius: 4px; animation: meta-skeleton-pulse 1.5s ease-in-out infinite; }
@keyframes meta-skeleton-pulse { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
.meta-grid__check-col { width: 36px; min-width: 36px; text-align: center; padding: 4px; border-bottom: 1px solid #eee; border-right: 1px solid #eee; background: #f9fafb; position: sticky; left: 0; z-index: 1; }
.meta-grid__expand-btn { border: none; background: none; cursor: pointer; font-size: 8px; color: #bbb; padding: 0 2px; transition: transform 0.15s; display: inline-block; }
.meta-grid__expand-btn:hover { color: #666; }
.meta-grid__expand-btn--open { transform: rotate(90deg); color: #409eff; }
.meta-grid__expand-row td { padding: 0; background: #fafbfc; border-bottom: 1px solid #eee; }
.meta-grid__expand-detail { padding: 8px 16px 12px !important; }
.meta-grid__expand-fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 6px 16px; }
.meta-grid__expand-field { display: flex; gap: 8px; font-size: 12px; padding: 3px 0; }
.meta-grid__expand-label { color: #999; font-weight: 500; min-width: 80px; flex-shrink: 0; }
.meta-grid__expand-value { color: #333; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.meta-grid__bulk-bar { display: flex; align-items: center; gap: 10px; padding: 6px 16px; background: #ecf5ff; border-bottom: 1px solid #c0d8f0; font-size: 12px; }
.meta-grid__bulk-count { color: #409eff; font-weight: 500; }
.meta-grid__bulk-btn { padding: 3px 10px; border: 1px solid #ddd; border-radius: 3px; background: #fff; cursor: pointer; font-size: 11px; }
.meta-grid__bulk-btn--danger { color: #f56c6c; border-color: #f56c6c; }
.meta-grid__bulk-btn--danger:hover { background: #fef0f0; }
.meta-grid__group-header { cursor: pointer; }
.meta-grid__group-header td { padding: 6px 12px; background: #f0f4f8; font-size: 13px; font-weight: 600; color: #333; border-bottom: 1px solid #dde3ea; }
.meta-grid__group-header:hover td { background: #e6ecf2; }
.meta-grid__group-toggle { display: inline-block; width: 16px; font-size: 10px; color: #999; }
.meta-grid__group-label { margin-right: 6px; }
.meta-grid__group-count { font-weight: 400; color: #999; font-size: 12px; }
.meta-grid--compact .meta-grid__cell { padding: 3px 8px; font-size: 12px; }
.meta-grid--compact .meta-grid__row { contain-intrinsic-size: auto 28px; }
.meta-grid--compact .meta-grid__row-num { padding: 3px 4px; font-size: 11px; }
.meta-grid--expanded .meta-grid__cell { padding: 10px 12px; }
.meta-grid--expanded .meta-grid__row { contain-intrinsic-size: auto 52px; }
@media print {
  .meta-grid { overflow: visible !important; height: auto !important; }
  .meta-grid__table-wrap { overflow: visible !important; }
  .meta-grid__table { font-size: 11px; }
  .meta-grid__row { content-visibility: visible !important; break-inside: avoid; }
  .meta-grid__cell--focused { outline: none !important; }
  .meta-grid__row--selected, .meta-grid__row--focused { background: none !important; }
  .meta-grid__bulk-bar, .meta-grid__pagination, .meta-grid__loading, .meta-grid__expand-btn { display: none !important; }
  .meta-grid__cell { border: 1px solid #ccc !important; padding: 4px 8px !important; }
  .meta-grid__row-num { border: 1px solid #ccc !important; }
  .meta-grid__check-col { display: none !important; }
}
</style>
