<template>
  <div class="meta-grid" :class="[rowDensity ? `meta-grid--${rowDensity}` : '']" tabindex="0" role="grid" :aria-label="l('grid.aria')" @keydown="onKeydown">
    <div v-if="enableMultiSelect && selectedIds.size > 0" class="meta-grid__bulk-bar">
      <span class="meta-grid__bulk-count">{{ selectedCount(selectedIds.size, isZh) }}</span>
      <button v-if="canBulkEdit" class="meta-grid__bulk-btn" :aria-label="l('grid.setFieldAria')" @click="onBulkEdit('set')">{{ l('grid.setField') }}</button>
      <button v-if="canBulkEdit" class="meta-grid__bulk-btn" :aria-label="l('grid.clearFieldAria')" @click="onBulkEdit('clear')">{{ l('grid.clearField') }}</button>
      <button v-if="canDelete" class="meta-grid__bulk-btn meta-grid__bulk-btn--danger" :aria-label="l('grid.deleteSelectedAria')" @click="onBulkDelete">{{ l('grid.deleteSelected') }}</button>
      <button class="meta-grid__bulk-btn" :aria-label="l('grid.clearSelection')" @click="selectedIds = new Set(); emit('selection-change', [])">{{ l('grid.clear') }}</button>
    </div>
    <div class="meta-grid__table-wrap">
      <table class="meta-grid__table">
        <thead>
          <tr>
            <th v-if="enableMultiSelect" class="meta-grid__check-col">
              <input type="checkbox" :checked="allSelected" @change="toggleSelectAll" />
            </th>
            <th class="meta-grid__row-num" :style="{ left: `${rowNumLeft}px` }">#</th>
            <MetaFieldHeader
              v-for="(field, fi) in visibleFields"
              :key="field.id"
              :field="field"
              :sort-direction="getSortDir(field.id)"
              :sortable="isSortable(field)"
              :width="columnWidths?.[field.id]"
              :frozen="isFrozen(fi)"
              :frozen-left="isFrozen(fi) ? frozenLeft(fi) : null"
              @toggle-sort="emit('toggle-sort', field.id)"
              @resize="(fid, w) => emit('resize-column', fid, w)"
              @reorder="(from, to) => emit('reorder-field', from, to)"
              @toggle-freeze="onToggleFreeze(fi)"
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
                :style="rowStyle(row.id)"
                @click="emit('select-record', row.id)"
              >
                <td v-if="enableMultiSelect" class="meta-grid__check-col" @click.stop>
                  <input type="checkbox" :checked="selectedIds.has(row.id)" :disabled="!rowAllowsAnyBulkAction(row.id)" @change="toggleSelectRow(row.id)" />
                </td>
                <td class="meta-grid__row-num" :style="{ left: `${rowNumLeft}px` }">
                  <span>{{ startIndex + flatIndex(group, ri) + 1 }}</span>
                  <button
                    v-if="resolveRowActions(row.id).canComment"
                    type="button"
                    class="meta-grid__comment-action"
                    :class="rowCommentActionClass(row.id)"
                    :aria-label="commentForRow(startIndex + flatIndex(group, ri) + 1, isZh)"
                    @click.stop="emit('open-comments', row.id)"
                    @keydown="onRowCommentKeydown($event, row.id)"
                  >
                    <MetaCommentAffordance :state="rowCommentAffordance(row.id)" />
                  </button>
                </td>
                <td
                  v-for="(field, ci) in visibleFields"
                  :key="field.id"
                  class="meta-grid__cell"
                  :class="{ 'meta-grid__cell--editing': isEditing(row.id, field.id), 'meta-grid__cell--readonly': !isEditable(row.id, field), 'meta-grid__cell--focused': focusRow === flatIndex(group, ri) && focusCol === ci, 'meta-grid__cell--scale-fill': cellHasScaleFill(row.id, field.id) }"
                  :style="cellStyle(row.id, field.id, ci)"
                  @dblclick="startEdit(row, field)"
                  @click.stop="onCellClick(flatIndex(group, ri), ci, row.id)"
                >
                  <span
                    v-if="!isEditing(row.id, field.id) && cellScaleIcon(row.id, field.id)"
                    class="meta-grid__cell-scale-icon"
                    data-test="cell-scale-icon"
                    :style="{ color: cellScaleIcon(row.id, field.id)!.color }"
                  >{{ cellScaleIcon(row.id, field.id)!.glyph }}</span>
                  <MetaCellEditor
                    v-if="isEditing(row.id, field.id)"
                    :field="field"
                    :model-value="editCell!.value"
                    :upload-fn="props.uploadFn"
                    :delete-attachment-fn="props.deleteAttachmentFn"
                    :attachment-summaries="props.attachmentSummaries?.[row.id]?.[field.id]"
                    :upload-context="{ recordId: row.id, fieldId: field.id }"
                    :ai-run-state="aiRunState"
                    @update:model-value="editCell!.value = $event"
                    @confirm="confirmEdit(row)"
                    @cancel="cancelEdit"
                    @open-link-picker="openLinkPickerFromCell(row.id, field)"
                    @ai-run="onAiRunFromCell(row.id, field)"
                  />
                  <MetaCellRenderer
                    v-else
                    :field="field"
                    :value="row.data[field.id]"
                    :link-summaries="props.linkSummaries?.[row.id]?.[field.id]"
                    :attachment-summaries="props.attachmentSummaries?.[row.id]?.[field.id]"
                    :button-pending="isButtonPending(row.id, field.id)"
                    :fetch-record="props.fetchRecord"
                    @run="emit('run-button', { recordId: row.id, field })"
                  />
                  <button
                    v-if="resolveRowActions(row.id).canComment && focusRow === flatIndex(group, ri) && focusCol === ci"
                    type="button"
                    class="meta-grid__field-comment-action"
                    :class="fieldCommentActionClass(row.id, field.id)"
                    :aria-label="commentForField(field.name, isZh)"
                    @click.stop="emit('open-field-comments', { recordId: row.id, fieldId: field.id })"
                    @keydown="onFieldCommentKeydown($event, row.id, field.id)"
                  >
                    <MetaCommentAffordance :state="fieldCommentAffordance(row.id, field.id)" />
                  </button>
                </td>
              </tr>
              <tr v-if="hasGroupSubtotals" class="meta-grid__group-subtotal">
                <td v-if="enableMultiSelect" class="meta-grid__check-col" :style="{ left: '0px' }"></td>
                <td class="meta-grid__row-num" :style="{ left: `${rowNumLeft}px` }">Σ</td>
                <td
                  v-for="(field, fi) in visibleFields"
                  :key="field.id"
                  class="meta-grid__foot-cell meta-grid__group-subtotal-cell"
                  :style="isFrozen(fi) ? { position: 'sticky', left: `${frozenLeft(fi)}px`, zIndex: '1', background: '#fcfcfd' } : undefined"
                >
                  <span class="meta-grid__foot-value">{{ groupAggValueDisplay(group.key, field.id) }}</span>
                </td>
              </tr>
            </template>
          </template>
          <tr v-if="!rows.length && !loading">
            <td :colspan="colSpan" class="meta-grid__empty">
              <div class="meta-grid__empty-icon">&#x1F4CB;</div>
              <div class="meta-grid__empty-title">{{ l('grid.noRecordsTitle') }}</div>
              <div class="meta-grid__empty-hint">{{ l('grid.noRecordsHintPrefix') }} <strong>{{ l('grid.noRecordsHintAction') }}</strong> {{ l('grid.noRecordsHintSuffix') }}</div>
            </td>
          </tr>
          <tr v-if="canCreate && filteredRows.length && !loading" class="meta-grid__add-row">
            <td :colspan="colSpan">
              <button type="button" class="meta-grid__add-row-btn" @click="emit('create-record')">
                <span class="meta-grid__add-row-plus" aria-hidden="true">+</span> {{ l('grid.addRecordInline') }}
              </button>
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
              :style="rowStyle(row.id)"
              @click="emit('select-record', row.id)"
            >
              <td v-if="enableMultiSelect" class="meta-grid__check-col" @click.stop>
                <input type="checkbox" :checked="selectedIds.has(row.id)" :disabled="!rowAllowsAnyBulkAction(row.id)" @change="toggleSelectRow(row.id)" />
              </td>
              <td class="meta-grid__row-num" :style="{ left: `${rowNumLeft}px` }">
                <button class="meta-grid__expand-btn" :class="{ 'meta-grid__expand-btn--open': expandedRowIds.has(row.id) }" :aria-label="expandedRowIds.has(row.id) ? l('grid.collapseRow') : l('grid.expandRow')" @click.stop="toggleRowExpand(row.id)">&#x25B6;</button>
                <span>{{ startIndex + ri + 1 }}</span>
                <span
                  v-if="isRowLocked(row.id)"
                  class="meta-grid__lock-indicator"
                  :title="l('grid.lockedIndicator')"
                  :aria-label="l('grid.lockedIndicator')"
                  data-test="row-lock-indicator"
                >&#x1F512;</span>
                <button
                  v-if="canShowLockAction(row.id)"
                  type="button"
                  class="meta-grid__lock-action"
                  :aria-label="isRowLocked(row.id) ? l('grid.unlockRow') : l('grid.lockRow')"
                  :title="isRowLocked(row.id) ? l('grid.unlockRow') : l('grid.lockRow')"
                  data-test="row-lock-action"
                  @click.stop="emit('toggle-lock', { recordId: row.id, locked: !isRowLocked(row.id) })"
                >{{ isRowLocked(row.id) ? '🔓' : '🔒' }}</button>
                <button
                  v-if="resolveRowActions(row.id).canComment"
                  type="button"
                  class="meta-grid__comment-action"
                  :class="rowCommentActionClass(row.id)"
                  :aria-label="commentForRow(startIndex + ri + 1, isZh)"
                  @click.stop="emit('open-comments', row.id)"
                  @keydown="onRowCommentKeydown($event, row.id)"
                >
                  <MetaCommentAffordance :state="rowCommentAffordance(row.id)" />
                </button>
              </td>
              <td
                v-for="(field, ci) in visibleFields"
                :key="field.id"
                role="gridcell"
                :aria-label="field.name"
                class="meta-grid__cell"
                :class="{ 'meta-grid__cell--editing': isEditing(row.id, field.id), 'meta-grid__cell--readonly': !isEditable(row.id, field), 'meta-grid__cell--focused': focusRow === ri && focusCol === ci, 'meta-grid__cell--scale-fill': cellHasScaleFill(row.id, field.id) }"
                :style="cellStyle(row.id, field.id, ci)"
                @dblclick="startEdit(row, field)"
                @click.stop="onCellClick(ri, ci, row.id)"
              >
                <span
                  v-if="!isEditing(row.id, field.id) && cellScaleIcon(row.id, field.id)"
                  class="meta-grid__cell-scale-icon"
                  data-test="cell-scale-icon"
                  :style="{ color: cellScaleIcon(row.id, field.id)!.color }"
                >{{ cellScaleIcon(row.id, field.id)!.glyph }}</span>
                <MetaCellEditor
                  v-if="isEditing(row.id, field.id)"
                  :field="field"
                  :model-value="editCell!.value"
                  :record-id="row.id"
                  :upload-fn="props.uploadFn"
                  :delete-attachment-fn="props.deleteAttachmentFn"
                  :attachment-summaries="props.attachmentSummaries?.[row.id]?.[field.id]"
                  :upload-context="{ recordId: row.id, fieldId: field.id }"
                  :ai-run-state="aiRunState"
                  @update:model-value="editCell!.value = $event"
                  @confirm="confirmEdit(row)"
                  @yjs-commit="markYjsHandled(row.id, field.id)"
                  @cancel="cancelEdit"
                  @open-link-picker="openLinkPickerFromCell(row.id, field)"
                  @ai-run="onAiRunFromCell(row.id, field)"
                />
                <MetaCellRenderer
                  v-else
                  :field="field"
                  :value="row.data[field.id]"
                  :link-summaries="props.linkSummaries?.[row.id]?.[field.id]"
                  :attachment-summaries="props.attachmentSummaries?.[row.id]?.[field.id]"
                  :button-pending="isButtonPending(row.id, field.id)"
                  :fetch-record="props.fetchRecord"
                  @run="emit('run-button', { recordId: row.id, field })"
                />
                <button
                  v-if="resolveRowActions(row.id).canComment && focusRow === ri && focusCol === ci"
                  type="button"
                  class="meta-grid__field-comment-action"
                  :class="fieldCommentActionClass(row.id, field.id)"
                  :aria-label="commentForField(field.name, isZh)"
                  @click.stop="emit('open-field-comments', { recordId: row.id, fieldId: field.id })"
                  @keydown="onFieldCommentKeydown($event, row.id, field.id)"
                >
                  <MetaCommentAffordance :state="fieldCommentAffordance(row.id, field.id)" />
                </button>
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
                        :button-pending="isButtonPending(row.id, field.id)"
                        @run="emit('run-button', { recordId: row.id, field })"
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
                <div class="meta-grid__empty-title">{{ l('grid.noMatchingTitle') }}</div>
                <div class="meta-grid__empty-hint">{{ l('grid.noMatchingHint') }}</div>
              </template>
              <template v-else>
                <div class="meta-grid__empty-icon">&#x1F4CB;</div>
                <div class="meta-grid__empty-title">{{ l('grid.noRecordsTitle') }}</div>
                <div class="meta-grid__empty-hint">{{ l('grid.noRecordsHintPrefix') }} <strong>{{ l('grid.noRecordsHintAction') }}</strong> {{ l('grid.noRecordsHintSuffix') }}</div>
              </template>
            </td>
          </tr>
          <tr v-if="canCreate && filteredRows.length && !loading" class="meta-grid__add-row">
            <td :colspan="colSpan">
              <button type="button" class="meta-grid__add-row-btn" @click="emit('create-record')">
                <span class="meta-grid__add-row-plus" aria-hidden="true">+</span> {{ l('grid.addRecordInline') }}
              </button>
            </td>
          </tr>
        </tbody>
        <tfoot v-if="hasAnyAggregation" class="meta-grid__foot">
          <tr>
            <td v-if="enableMultiSelect" class="meta-grid__check-col" :style="{ left: '0px' }"></td>
            <td class="meta-grid__row-num" :style="{ left: `${rowNumLeft}px` }">{{ aggregateTooLarge ? '!' : 'Σ' }}</td>
            <td
              v-for="(field, fi) in visibleFields"
              :key="field.id"
              class="meta-grid__foot-cell"
              :style="isFrozen(fi) ? { position: 'sticky', left: `${frozenLeft(fi)}px`, zIndex: '2', background: '#f9fafb' } : undefined"
            >
              <span class="meta-grid__foot-value" :title="aggregates?.[field.id] ? `${aggregates[field.id].fn}` : ''">{{ aggValueDisplay(field.id) }}</span>
              <select
                class="meta-grid__foot-fn"
                :value="aggregationConfig?.[field.id] ?? ''"
                :aria-label="`aggregation for ${field.name}`"
                @change="onAggChange(field.id, $event)"
              >
                <option value="">{{ '—' }}</option>
                <option v-for="fn in aggFnOptions(field)" :key="fn" :value="fn">{{ fn }}</option>
              </select>
            </td>
          </tr>
          <tr v-if="aggregateTooLarge" class="meta-grid__foot-toolarge">
            <td :colspan="colSpan">{{ l('grid.aggregateTooLarge') }}</td>
          </tr>
        </tfoot>
      </table>
    </div>
    <div v-if="totalPages > 1" class="meta-grid__pagination">
      <button class="meta-grid__page-btn" :disabled="currentPage <= 1" @click="emit('go-to-page', currentPage - 1)">&lsaquo; {{ l('grid.prev') }}</button>
      <span class="meta-grid__page-info">{{ currentPage }} / {{ totalPages }}</span>
      <button class="meta-grid__page-btn" :disabled="currentPage >= totalPages" @click="emit('go-to-page', currentPage + 1)">{{ l('grid.next') }} &rsaquo;</button>
    </div>
    <div v-if="loading" class="meta-grid__loading" aria-live="polite" :aria-label="l('grid.loading')">
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
import type {
  MetaAttachment,
  MetaAttachmentDeleteFn,
  MetaAttachmentUploadFn,
  MetaField,
  MetaRecordContext,
  MetaRowActions,
  MetaRecord,
  MultitableCommentPresenceSummary,
  RowDensity,
} from '../types'
import type { SortRule } from '../composables/useMultitableGrid'
import { composeStyleObject, type EvaluatedFormatting, type FieldScaleMap } from '../utils/conditional-formatting'

interface ConditionalFormattingByRecord {
  byRecordId: Map<string, EvaluatedFormatting>
}
import MetaCellRenderer from './cells/MetaCellRenderer.vue'
import MetaCellEditor from './cells/MetaCellEditor.vue'
import MetaFieldHeader from './MetaFieldHeader.vue'
import MetaCommentAffordance from './MetaCommentAffordance.vue'
import {
  handleCommentAffordanceKeydown,
  resolveCommentAffordanceStateClass,
  resolveFieldCommentAffordance,
  resolveRecordCommentAffordance,
} from '../utils/comment-affordance'
import { isSystemField } from '../utils/system-fields'
import { useLocale } from '../../composables/useLocale'
import { frozenPrefixCount } from '../utils/frozen-columns'
import {
  metaCoreLabel,
  selectedCount,
  commentForRow,
  commentForField,
  groupNoValue,
  type MetaCoreLabelKey,
} from '../utils/meta-core-labels'

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
  canBulkEdit?: boolean
  canCreate?: boolean
  frozenLeftColumnIds?: string[]
  rowActionOverrides?: Record<string, MetaRowActions>
  fieldReadOnlyIds?: string[]
  columnWidths?: Record<string, number>
  linkSummaries?: Record<string, Record<string, { id: string; display: string }[]>>
  attachmentSummaries?: Record<string, Record<string, MetaAttachment[]>>
  enableMultiSelect?: boolean
  groupField?: MetaField | null
  searchText?: string
  rowDensity?: RowDensity
  uploadFn?: MetaAttachmentUploadFn
  deleteAttachmentFn?: MetaAttachmentDeleteFn
  canComment?: boolean
  commentPresence?: Record<string, MultitableCommentPresenceSummary | undefined>
  conditionalFormatting?: ConditionalFormattingByRecord
  conditionalFormattingScale?: FieldScaleMap
  aggregationConfig?: Record<string, string>
  aggregates?: Record<string, { fn: string; value: number }>
  aggregateTooLarge?: boolean
  // #4-3b-2a: server-computed per-group subtotals (full filtered set, NOT page). Matched to the
  // client's rendered groups by key. Value rendered from this prop only — no local group aggregation.
  aggregateGroups?: Array<{ key: string | number | boolean | null; count: number; aggregates: Record<string, { fn: string; value: number }> }>
  // A3: AI shortcut run opt-in for the cell editor. `aiRunEnabled` gates the
  // button; `aiRunPending` is the UNIFIED in-flight state from useAiShortcut;
  // `aiRunBusy` (review F3) additionally covers the RATE_LIMITED countdown —
  // the button disables on it so a click can never be silently refused.
  aiRunEnabled?: boolean
  aiRunPending?: boolean
  aiRunBusy?: boolean
  // B1-b: per-cell in-flight keys `${recordId}:${fieldId}` for button runs
  // (keyed so one running button doesn't disable the others).
  buttonRunPending?: string[]
  // A3: cross-sheet record fetcher (getRecord with NO sheetId) threaded down to
  // the grid-cell renderer so a non-person link chip can peek the foreign
  // record in a popover. Default undefined → chips stay non-clickable.
  fetchRecord?: (recordId: string) => Promise<MetaRecordContext>
}>()

const emit = defineEmits<{
  (e: 'select-record', recordId: string): void
  (e: 'open-comments', recordId: string): void
  (e: 'toggle-lock', payload: { recordId: string; locked: boolean }): void
  (e: 'open-field-comments', payload: { recordId: string; fieldId: string }): void
  (e: 'toggle-sort', fieldId: string): void
  (e: 'patch-cell', recordId: string, fieldId: string, value: unknown, version: number): void
  (e: 'go-to-page', page: number): void
  (e: 'open-link-picker', ctx: { recordId: string; field: MetaField }): void
  (e: 'resize-column', fieldId: string, width: number): void
  (e: 'selection-change', recordIds: string[]): void
  (e: 'bulk-delete', recordIds: string[]): void
  (e: 'bulk-edit', payload: { mode: 'set' | 'clear'; recordIds: string[] }): void
  (e: 'reorder-field', fromFieldId: string, toFieldId: string): void
  (e: 'create-record'): void
  (e: 'set-frozen', frozenLeftColumnIds: string[]): void
  (e: 'set-aggregation', payload: { fieldId: string; fn: string | null }): void
  // A3: AI shortcut run requested from a cell editor.
  (e: 'ai-run', recordId: string, field: MetaField): void
  // B1-b: a button-field cell was clicked (run its configured action).
  (e: 'run-button', payload: { recordId: string; field: MetaField }): void
}>()

const { isZh } = useLocale()
const l = (key: MetaCoreLabelKey) => metaCoreLabel(key, isZh.value)

const editCell = ref<EditingCell | null>(null)
const focusRow = ref(-1)
const focusCol = ref(-1)
const selectedIds = ref<Set<string>>(new Set())
const expandedRowIds = ref<Set<string>>(new Set())

/**
 * Set when MetaCellEditor emits `yjs-commit`, meaning the active edit was
 * carried over Yjs and the server-side bridge will persist it. We then
 * suppress the REST `patch-cell` emit in `confirmEdit` to avoid a
 * redundant write — the backend Yjs bridge writes to `meta_records` via
 * `RecordWriteService.patchRecords`. Cleared on every new edit start.
 */
const yjsHandledCellKey = ref<string | null>(null)
const cellKey = (recordId: string, fieldId: string) => `${recordId}::${fieldId}`
function markYjsHandled(recordId: string, fieldId: string): void {
  yjsHandledCellKey.value = cellKey(recordId, fieldId)
}

function toggleRowExpand(rowId: string) {
  const s = new Set(expandedRowIds.value)
  if (s.has(rowId)) s.delete(rowId)
  else s.add(rowId)
  expandedRowIds.value = s
}

function rowAllowsAnyBulkAction(recordId: string): boolean {
  const actions = resolveRowActions(recordId)
  return actions.canEdit === true || actions.canDelete === true
}

const selectableRowIds = computed(() =>
  filteredRows.value
    .filter((row) => rowAllowsAnyBulkAction(row.id))
    .map((row) => row.id),
)
const allSelected = computed(() =>
  selectableRowIds.value.length > 0
  && selectableRowIds.value.every((recordId) => selectedIds.value.has(recordId)),
)

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
    groups.push({ key, label: key === '__ungrouped__' ? groupNoValue(isZh.value) : key, rows, count: rows.length })
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
  else selectedIds.value = new Set(selectableRowIds.value)
  emit('selection-change', [...selectedIds.value])
}

function toggleSelectRow(recordId: string) {
  if (!rowAllowsAnyBulkAction(recordId)) return
  const s = new Set(selectedIds.value)
  if (s.has(recordId)) s.delete(recordId)
  else s.add(recordId)
  selectedIds.value = s
  emit('selection-change', [...s])
}

// Bulk actions filter the selection to rows that actually permit the
// requested action — so canEdit-only users selecting from a mixed grid
// can still bulk-edit, and canDelete-only buttons silently skip
// edit-only rows. This matches the per-action gating pattern in
// MultitableWorkbench.onBulkDelete which calls ensureCanDeleteRecord
// per row before issuing deletes.
function onBulkDelete() {
  const deletable = [...selectedIds.value].filter((id) => resolveRowActions(id).canDelete)
  if (deletable.length > 0) emit('bulk-delete', deletable)
}

function onBulkEdit(mode: 'set' | 'clear') {
  const editable = [...selectedIds.value].filter((id) => resolveRowActions(id).canEdit)
  if (editable.length > 0) emit('bulk-edit', { mode, recordIds: editable })
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
function resolveRowActions(recordId: string): MetaRowActions {
  return props.rowActionOverrides?.[recordId] ?? {
    canEdit: props.canEdit,
    canDelete: props.canDelete !== false,
    canComment: props.canComment !== false,
  }
}
// Record-locking (design #2278 follow-up): index rows so the lock indicator + lock/unlock action +
// read-only-while-locked visual can resolve a row's lock state by id without scanning.
const recordById = computed(() => {
  const map = new Map<string, MetaRecord>()
  for (const row of props.rows) map.set(row.id, row)
  return map
})
const isRowLocked = (recordId: string): boolean => recordById.value.get(recordId)?.locked === true
const canUnlockRow = (recordId: string): boolean => recordById.value.get(recordId)?.canUnlock === true
// Show the lock/unlock affordance per `canUnlock` (decision b): a LOCKED row shows "unlock" only to an
// actor the server says can unlock it; an UNLOCKED row shows "lock" to anyone who can edit the row.
function canShowLockAction(recordId: string): boolean {
  return isRowLocked(recordId) ? canUnlockRow(recordId) : resolveRowActions(recordId).canEdit
}

const isEditable = (recordId: string, f: MetaField) =>
  !isRowLocked(recordId) &&
  resolveRowActions(recordId).canEdit && EDITABLE.has(f.type) && !isSystemField(f) && !props.fieldReadOnlyIds?.includes(f.id)
const isEditing = (rid: string, fid: string) => editCell.value?.recordId === rid && editCell.value?.fieldId === fid

function cellStyle(rid: string, fid: string, ci?: number) {
  const frozen = typeof ci === 'number' && isFrozen(ci)
  // frozen cells need a definite width so the sticky-offset math is exact
  const w = frozen ? colWidth(fid) : props.columnWidths?.[fid]
  const widthStyle: Record<string, string> | undefined = w
    ? { width: `${w}px`, minWidth: `${w}px`, maxWidth: `${w}px` }
    : undefined
  const formatting = props.conditionalFormatting?.byRecordId.get(rid)
  const formatStyle = formatting
    ? composeStyleObject(undefined, formatting.cellStyles[fid])
    : undefined
  // Data bar (A5-1): render the bar as a left-anchored gradient on the cell.
  // Per design-lock §2.3 the bar takes the cell background; the operator rule's
  // textColor still applies, but its backgroundColor is dropped so the two
  // don't fight. Covers both the grouped and flat render paths (both call this).
  const scaleEntry = props.conditionalFormattingScale?.byField[fid]?.byRecordId[rid]
  // Each scale kind renders its own way: dataBar (A5-1) = left-anchored gradient;
  // colorScale (A5-2) = solid cell background; iconSet (A5-3) = a glyph rendered
  // in the cell template (see cellScaleIcon), no cell-style change. The barPct
  // guard keeps colorScale/iconSet out of the gradient path (no `undefined%`).
  const barEntry = scaleEntry && typeof scaleEntry.barPct === 'number' ? scaleEntry : undefined
  const colorScaleFill = scaleEntry && typeof scaleEntry.scaleColor === 'string' ? scaleEntry.scaleColor : undefined
  const scaleStyle: Record<string, string> | undefined = barEntry
    ? { backgroundImage: `linear-gradient(to right, ${barEntry.barColor} ${barEntry.barPct}%, transparent ${barEntry.barPct}%)` }
    : colorScaleFill
      ? { backgroundColor: colorScaleFill }
      : undefined
  // dataBar + colorScale take the cell background, so drop the operator rule's
  // backgroundColor (keep its textColor) to avoid two fills fighting.
  const effectiveFormat: Record<string, string> | undefined = (barEntry || colorScaleFill)
    ? (formatStyle?.color ? { color: formatStyle.color } : undefined)
    : formatStyle
  // frozen body cell: sticky-left + an OPAQUE bg (occludes scrolled-under content). Preserve any
  // conditional-formatting backgroundColor — only fall back to #fff when formatting set none. (Row
  // hover/selection tint is still not shown on frozen cells — accepted MVP limitation; conditional
  // formatting is NOT lost.) With a data bar present, the opaque base is #fff so the gradient shows.
  const frozenStyle: Record<string, string> | undefined = frozen
    ? { position: 'sticky', left: `${frozenLeft(ci!)}px`, zIndex: '2', backgroundColor: colorScaleFill ?? effectiveFormat?.backgroundColor ?? '#fff' }
    : undefined
  // Over a scale fill, force a readable text color via a CSS var the cell-renderer
  // sign-colors inherit (see the `.meta-grid__cell--scale-fill` :deep rule). A
  // single neutral color can't be readable on every fill (color-scale spans
  // black→white), so pick dark/white by the fill's luminance. dataBar uses a
  // default dark (the bar is left-anchored; over-engineering per-bar isn't worth it).
  const scaleTextColor = colorScaleFill
    ? readableTextOn(colorScaleFill)
    : barEntry
      ? '#111827'
      : undefined
  const scaleTextVar: Record<string, string> | undefined = scaleTextColor
    ? { '--meta-grid-scale-text-color': scaleTextColor }
    : undefined
  if (!widthStyle && !effectiveFormat && !scaleStyle && !frozenStyle && !scaleTextVar) return undefined
  return { ...(widthStyle ?? {}), ...(effectiveFormat ?? {}), ...(scaleStyle ?? {}), ...(frozenStyle ?? {}), ...(scaleTextVar ?? {}) }
}

// Pick a readable text color (#111827 dark / #ffffff white) for a given fill hex,
// by perceived luminance (YIQ). Used so cell-renderer sign-colors don't go
// low-contrast over a color-scale fill (which can be any color incl. black/white).
function readableTextOn(hex: string): string {
  const h = hex.trim().replace(/^#/, '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6)
  const n = parseInt(full, 16)
  if (!Number.isFinite(n)) return '#111827'
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  const yiq = (r * 299 + g * 587 + b * 114) / 1000
  return yiq >= 140 ? '#111827' : '#ffffff'
}

/** True when a cell carries a data-bar or color-scale fill (drives the scale-fill class). */
function cellHasScaleFill(rid: string, fid: string): boolean {
  const e = props.conditionalFormattingScale?.byField[fid]?.byRecordId[rid]
  return !!e && (typeof e.barPct === 'number' || typeof e.scaleColor === 'string')
}

/** B1-b: is this button cell's run in flight? (disables the button, prevents double-fire) */
function isButtonPending(rid: string, fid: string): boolean {
  return (props.buttonRunPending ?? []).includes(`${rid}:${fid}`)
}

// A5-3 icon set render: map an `iconKey` (`${set}:${index}`) to a glyph + color.
// The backend (conditional-formatting-service) only emits index ∈ {0,1,2}; an
// out-of-range or unknown set yields no icon (fail-safe).
const SCALE_ICON_GLYPHS: Record<string, ReadonlyArray<{ glyph: string; color: string }>> = {
  arrows3: [{ glyph: '↓', color: '#e53935' }, { glyph: '→', color: '#fb8c00' }, { glyph: '↑', color: '#43a047' }],
  traffic3: [{ glyph: '●', color: '#e53935' }, { glyph: '●', color: '#fbc02d' }, { glyph: '●', color: '#43a047' }],
  signs3: [{ glyph: '✕', color: '#e53935' }, { glyph: '!', color: '#fb8c00' }, { glyph: '✓', color: '#43a047' }],
}
function cellScaleIcon(rid: string, fid: string): { glyph: string; color: string } | null {
  const entry = props.conditionalFormattingScale?.byField[fid]?.byRecordId[rid]
  if (!entry || typeof entry.iconKey !== 'string') return null
  const sep = entry.iconKey.lastIndexOf(':')
  if (sep < 0) return null
  const set = entry.iconKey.slice(0, sep)
  const idx = Number(entry.iconKey.slice(sep + 1))
  const glyphs = SCALE_ICON_GLYPHS[set]
  if (!glyphs || !Number.isInteger(idx) || idx < 0 || idx >= glyphs.length) return null
  return glyphs[idx]
}

// ── frozen columns (left-prefix) ──────────────────────────────────────────
const FROZEN_DEFAULT_WIDTH = 160
const CHECK_COL_W = 36
const ROW_NUM_W = 56
const frozenCount = computed(() => frozenPrefixCount(props.visibleFields.map((f) => f.id), props.frozenLeftColumnIds ?? []))
function isFrozen(i: number) { return i < frozenCount.value }
function colWidth(fid: string) { return props.columnWidths?.[fid] ?? FROZEN_DEFAULT_WIDTH }
const stickyBaseLeft = computed(() => (props.enableMultiSelect ? CHECK_COL_W : 0) + ROW_NUM_W)
function frozenLeft(i: number) {
  let left = stickyBaseLeft.value
  for (let j = 0; j < i; j++) left += colWidth(props.visibleFields[j].id)
  return left
}
// base-fix (global): row-num sits AFTER check-col, not overlapping at left:0
const rowNumLeft = computed(() => (props.enableMultiSelect ? CHECK_COL_W : 0))
function onToggleFreeze(i: number) {
  if (i === frozenCount.value - 1) emit('set-frozen', [])
  else emit('set-frozen', props.visibleFields.slice(0, i + 1).map((f) => f.id))
}

// ── aggregation footer (#4-3b-1): SERVER-RESPONSE ONLY, no local fallback ──
const AGG_NUMERIC_TYPES = new Set(['number', 'currency', 'percent', 'rating', 'autoNumber'])
const AGG_FNS_NUMERIC = ['sum', 'avg', 'min', 'max', 'count', 'countNonEmpty', 'countDistinct']
const AGG_FNS_OTHER = ['count', 'countNonEmpty', 'countDistinct']
function aggFnOptions(field: MetaField): string[] {
  return AGG_NUMERIC_TYPES.has(field.type) ? AGG_FNS_NUMERIC : AGG_FNS_OTHER
}
const hasAnyAggregation = computed(() => Object.keys(props.aggregationConfig ?? {}).length > 0 || !!props.aggregateTooLarge)
function formatAggValue(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100)
}
// value comes ONLY from the server response (props.aggregates) — never computed from local rows
function aggValueDisplay(fieldId: string): string {
  const a = props.aggregates?.[fieldId]
  return a ? formatAggValue(a.value) : ''
}
// #4-3b-2a: server per-group subtotals, keyed by the client group-key form ('__ungrouped__' for null)
const serverGroupAggByKey = computed(() => {
  const m = new Map<string, Record<string, { fn: string; value: number }>>()
  for (const g of props.aggregateGroups ?? []) {
    m.set(g.key === null ? '__ungrouped__' : String(g.key), g.aggregates)
  }
  return m
})
const hasGroupSubtotals = computed(() => hasAnyAggregation.value && !props.aggregateTooLarge && (props.aggregateGroups?.length ?? 0) > 0)
function groupAggValueDisplay(groupKey: string, fieldId: string): string {
  const a = serverGroupAggByKey.value.get(groupKey)?.[fieldId]
  return a ? formatAggValue(a.value) : ''
}
function onAggChange(fieldId: string, e: Event) {
  const v = (e.target as HTMLSelectElement).value
  emit('set-aggregation', { fieldId, fn: v || null })
}

function rowStyle(rid: string): Record<string, string> | undefined {
  const formatting = props.conditionalFormatting?.byRecordId.get(rid)
  if (!formatting?.rowStyle) return undefined
  return composeStyleObject(formatting.rowStyle, undefined)
}

function rowCommentAffordance(recordId: string) {
  return resolveRecordCommentAffordance(props.commentPresence?.[recordId])
}

function fieldCommentAffordance(recordId: string, fieldId: string) {
  return resolveFieldCommentAffordance(props.commentPresence?.[recordId], fieldId)
}

function rowCommentActionClass(recordId: string): string {
  return resolveCommentAffordanceStateClass('meta-grid__comment-action', rowCommentAffordance(recordId))
}

function fieldCommentActionClass(recordId: string, fieldId: string): string {
  return resolveCommentAffordanceStateClass('meta-grid__field-comment-action', fieldCommentAffordance(recordId, fieldId))
}

function onRowCommentKeydown(event: KeyboardEvent, recordId: string) {
  handleCommentAffordanceKeydown(event, () => emit('open-comments', recordId))
}

function onFieldCommentKeydown(event: KeyboardEvent, recordId: string, fieldId: string) {
  handleCommentAffordanceKeydown(event, () => emit('open-field-comments', { recordId, fieldId }))
}

function onCellClick(ri: number, ci: number, rid: string) {
  focusRow.value = ri; focusCol.value = ci; emit('select-record', rid)
}

function startEdit(row: MetaRecord, field: MetaField) {
  if (!isEditable(row.id, field)) return
  yjsHandledCellKey.value = null
  editCell.value = { recordId: row.id, fieldId: field.id, value: row.data[field.id] ?? null }
}

function confirmEdit(row: MetaRecord) {
  if (!editCell.value) return
  const { recordId, fieldId, value } = editCell.value
  // Skip the REST patch only when the editor signalled that Yjs carried
  // the edit for this exact cell. If the Yjs path was not active (flag
  // off, timeout, error) we stay on REST unchanged.
  const handledViaYjs = yjsHandledCellKey.value === cellKey(recordId, fieldId)
  if (!handledViaYjs && value !== row.data[fieldId]) {
    emit('patch-cell', recordId, fieldId, value, row.version)
  }
  editCell.value = null
  yjsHandledCellKey.value = null
}

function cancelEdit() { editCell.value = null; yjsHandledCellKey.value = null }

function openLinkPickerFromCell(recordId: string, field: MetaField) {
  cancelEdit()
  emit('open-link-picker', { recordId, field })
}

// A3: cell-editor opt-in payload (null = host did not enable → no button).
// `busy` (review F3) folds in the rate-limit countdown so the run button
// disables exactly like the drawer's aiBusy — never an enabled click that
// would only be refused by the composable guard.
const aiRunState = computed(() => (props.aiRunEnabled
  ? { pending: Boolean(props.aiRunPending), busy: Boolean(props.aiRunPending) || Boolean(props.aiRunBusy) }
  : null))

// A3: an AI run replaces the cell value server-side — close the edit session
// first so a stale editor draft can never overwrite the AI output on confirm.
// Review F3 guard: while the unified AI state is busy (in-flight elsewhere or
// rate-limit countdown) the composable would refuse the run anyway, so do NOT
// destroy the user's edit session — keep the editor open and no-op here.
function onAiRunFromCell(recordId: string, field: MetaField) {
  if (props.aiRunPending || props.aiRunBusy) return
  cancelEdit()
  emit('ai-run', recordId, field)
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
  if (!row || !field || !isEditable(row.id, field)) return
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
.meta-grid__row-num > span { display: inline-flex; align-items: center; justify-content: center; }
.meta-grid__check-col { position: sticky; z-index: 1; }
.meta-grid__row { transition: background 0.1s; content-visibility: auto; contain-intrinsic-size: auto 36px; }
.meta-grid__row:hover { background: #f5f7fa; }
.meta-grid__row--selected, .meta-grid__row--focused { background: #ecf5ff; }
.meta-grid__cell { position: relative; padding: 6px 12px; border-bottom: 1px solid #eee; overflow: hidden; text-overflow: ellipsis; cursor: default; }
.meta-grid__cell--editing { padding: 2px 4px; background: #fff; }
.meta-grid__cell--readonly { color: #666; }
.meta-grid__cell--focused { outline: 2px solid #409eff; outline-offset: -2px; }
.meta-grid__cell-scale-icon { display: inline-block; margin-right: 4px; font-weight: 700; vertical-align: middle; }
/* Over a data-bar / color-scale fill, force the cell-renderer's number sign-colors
   (green/red, set on an inner span that out-specifies the cell) to a luminance-
   picked readable color so values stay legible on saturated fills. */
.meta-grid__cell--scale-fill :deep(.meta-cell-renderer--positive),
.meta-grid__cell--scale-fill :deep(.meta-cell-renderer--negative) {
  color: var(--meta-grid-scale-text-color, inherit) !important;
}
.meta-grid__comment-action,
.meta-grid__field-comment-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  padding: 0;
  cursor: pointer;
}
.meta-grid__comment-action {
  margin-left: 4px;
  vertical-align: middle;
}
.meta-grid__field-comment-action {
  position: absolute;
  top: 4px;
  right: 6px;
}
.meta-grid__comment-action--active,
.meta-grid__field-comment-action--active {
  color: #1d4ed8;
}
.meta-grid__comment-action--idle,
.meta-grid__field-comment-action--idle {
  color: #94a3b8;
}
.meta-grid__add-row td { padding: 0; border-top: 1px solid #eef0f2; }
.meta-grid__foot td { position: sticky; bottom: 0; background: #f9fafb; border-top: 2px solid #e5e7eb; font-size: 12px; padding: 4px 8px; z-index: 1; }
.meta-grid__foot-value { font-weight: 600; color: #333; margin-right: 6px; }
.meta-grid__foot-fn { font-size: 11px; color: #999; border: none; background: transparent; cursor: pointer; opacity: 0.5; }
.meta-grid__foot-fn:hover { opacity: 1; }
.meta-grid__foot-toolarge td { color: #c0392b; font-weight: 500; }
.meta-grid__group-subtotal { background: #fcfcfd; }
.meta-grid__group-subtotal-cell { border-top: 1px solid #ececec; }
.meta-grid__group-subtotal .meta-grid__foot-value { font-weight: 600; color: #555; }
.meta-grid__add-row-btn {
  display: flex; align-items: center; gap: 6px; width: 100%;
  padding: 8px 12px; background: transparent; border: none; cursor: pointer;
  font-size: 13px; color: #4a5568; text-align: left; position: sticky; left: 0;
}
.meta-grid__add-row-btn:hover { background: #f5f7fa; color: #2563eb; }
.meta-grid__add-row-plus { font-weight: 700; font-size: 15px; line-height: 1; }
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
