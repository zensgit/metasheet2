<template>
  <div class="meta-grid" :class="[rowDensity ? `meta-grid--${rowDensity}` : '']" tabindex="0" role="grid" :aria-label="l('grid.aria')" @keydown="onKeydown">
    <div v-if="enableMultiSelect && selectedIds.size > 0" class="meta-grid__bulk-bar">
      <span class="meta-grid__bulk-count">{{ selectedCount(selectedIds.size, isZh) }}</span>
      <button v-if="canBulkEdit" class="meta-grid__bulk-btn" :aria-label="l('grid.setFieldAria')" @click="onBulkEdit('set')">{{ l('grid.setField') }}</button>
      <button v-if="canBulkEdit" class="meta-grid__bulk-btn" :aria-label="l('grid.clearFieldAria')" @click="onBulkEdit('clear')">{{ l('grid.clearField') }}</button>
      <button v-if="canDelete" class="meta-grid__bulk-btn meta-grid__bulk-btn--danger" :aria-label="l('grid.deleteSelectedAria')" @click="onBulkDelete">{{ l('grid.deleteSelected') }}</button>
      <button class="meta-grid__bulk-btn" :aria-label="l('grid.clearSelection')" @click="selectedIds = new Set(); emit('selection-change', [])">{{ l('grid.clear') }}</button>
    </div>
    <div ref="tableWrap" class="meta-grid__table-wrap">
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
          <template v-for="item in groupRenderItems" :key="item.kind + ':' + (item.kind === 'data' ? item.row.id : item.path + ':' + item.kind)">
            <!-- Nested group header: one per level, indented by depth, per-level collapse toggle -->
            <tr v-if="item.kind === 'header'" class="meta-grid__group-header" :class="`meta-grid__group-header--l${item.level}`" data-test="group-header" :data-group-path="item.path" :data-group-level="item.level" @click="toggleGroup(item.path)">
              <td :colspan="colSpan">
                <span class="meta-grid__group-indent" :style="{ paddingLeft: `${item.level * 18}px` }">
                  <span class="meta-grid__group-toggle">{{ item.collapsed ? '&#x25B6;' : '&#x25BC;' }}</span>
                  <span class="meta-grid__group-label">{{ item.label }}</span>
                  <span class="meta-grid__group-count">({{ item.count }})</span>
                </span>
              </td>
            </tr>
            <!-- Leaf-level data row -->
            <tr
              v-else-if="item.kind === 'data'"
              :key="item.row.id"
              role="row"
              :aria-selected="item.row.id === selectedRecordId || undefined"
              class="meta-grid__row"
              :class="{ 'meta-grid__row--selected': item.row.id === selectedRecordId, 'meta-grid__row--focused': focusRow === item.navIndex }"
              :style="rowStyle(item.row.id)"
              @click="emit('select-record', item.row.id)"
              @contextmenu="onRowContextMenu($event, item.row.id)"
            >
              <td v-if="enableMultiSelect" class="meta-grid__check-col" @click.stop>
                <input type="checkbox" :checked="selectedIds.has(item.row.id)" :disabled="!rowAllowsAnyBulkAction(item.row.id)" @change="toggleSelectRow(item.row.id)" />
              </td>
              <td class="meta-grid__row-num" :style="{ left: `${rowNumLeft}px` }">
                <span>{{ startIndex + item.navIndex + 1 }}</span>
                <button
                  v-if="resolveRowActions(item.row.id).canComment"
                  type="button"
                  class="meta-grid__comment-action"
                  :class="rowCommentActionClass(item.row.id)"
                  :aria-label="commentForRow(startIndex + item.navIndex + 1, isZh)"
                  @click.stop="emit('open-comments', item.row.id)"
                  @keydown="onRowCommentKeydown($event, item.row.id)"
                >
                  <MetaCommentAffordance :state="rowCommentAffordance(item.row.id)" />
                </button>
              </td>
              <td
                v-for="(field, ci) in visibleFields"
                :key="field.id"
                class="meta-grid__cell"
                :class="{ 'meta-grid__cell--editing': isEditing(item.row.id, field.id), 'meta-grid__cell--readonly': !isEditable(item.row.id, field), 'meta-grid__cell--focused': focusRow === item.navIndex && focusCol === ci, 'meta-grid__cell--scale-fill': cellHasScaleFill(item.row.id, field.id), 'meta-grid__cell--remote-cursor': hasRemoteCursor(item.row.id, field.id) }"
                :style="cellStyle(item.row.id, field.id, ci)"
                @dblclick="startEdit(item.row, field)"
                @click.stop="onCellClick(item.navIndex, ci, item.row.id)"
              >
                <span
                  v-if="!isEditing(item.row.id, field.id) && cellScaleIcon(item.row.id, field.id)"
                  class="meta-grid__cell-scale-icon"
                  data-test="cell-scale-icon"
                  :style="{ color: cellScaleIcon(item.row.id, field.id)!.color }"
                >{{ cellScaleIcon(item.row.id, field.id)!.glyph }}</span>
                <MetaCellEditor
                  v-if="isEditing(item.row.id, field.id)"
                  :field="field"
                  :model-value="editCell!.value"
                  :upload-fn="props.uploadFn"
                  :delete-attachment-fn="props.deleteAttachmentFn"
                  :attachment-summaries="props.attachmentSummaries?.[item.row.id]?.[field.id]"
                  :upload-context="{ recordId: item.row.id, fieldId: field.id }"
                  :ai-run-state="aiRunState"
                  :mention-suggestions="props.mentionSuggestions"
                  @update:model-value="editCell!.value = $event"
                  @confirm="confirmEdit(item.row)"
                  @cancel="cancelEdit"
                  @open-link-picker="openLinkPickerFromCell(item.row.id, field)"
                  @open-person-picker="openPersonPickerFromCell(item.row.id, field)"
                  @ai-run="onAiRunFromCell(item.row.id, field)"
                />
                <MetaCellRenderer
                  v-else
                  :field="field"
                  :value="item.row.data[field.id]"
                  :link-summaries="props.linkSummaries?.[item.row.id]?.[field.id]"
                  :person-summaries="props.personSummaries?.[item.row.id]?.[field.id]"
                  :attachment-summaries="props.attachmentSummaries?.[item.row.id]?.[field.id]"
                  :button-pending="isButtonPending(item.row.id, field.id)"
                  :fetch-record="props.fetchRecord"
                  @run="emit('run-button', { recordId: item.row.id, field })"
                />
                <button
                  v-if="resolveRowActions(item.row.id).canComment && focusRow === item.navIndex && focusCol === ci"
                  type="button"
                  class="meta-grid__field-comment-action"
                  :class="fieldCommentActionClass(item.row.id, field.id)"
                  :aria-label="commentForField(field.name, isZh)"
                  @click.stop="emit('open-field-comments', { recordId: item.row.id, fieldId: field.id })"
                  @keydown="onFieldCommentKeydown($event, item.row.id, field.id)"
                >
                  <MetaCommentAffordance :state="fieldCommentAffordance(item.row.id, field.id)" />
                </button>
              </td>
            </tr>
            <!-- Per-level subtotal row (leaf + each ancestor); value from server tree by composite path -->
            <tr v-else-if="item.kind === 'subtotal' && hasGroupSubtotals" class="meta-grid__group-subtotal" :class="`meta-grid__group-subtotal--l${item.level}`" data-test="group-subtotal" :data-group-path="item.path" :data-group-level="item.level">
              <td v-if="enableMultiSelect" class="meta-grid__check-col" :style="{ left: '0px' }"></td>
              <td class="meta-grid__row-num" :style="{ left: `${rowNumLeft}px` }">Σ</td>
              <td
                v-for="(field, fi) in visibleFields"
                :key="field.id"
                class="meta-grid__foot-cell meta-grid__group-subtotal-cell"
                :style="isFrozen(fi) ? { position: 'sticky', left: `${frozenLeft(fi)}px`, zIndex: '1', background: '#fcfcfd' } : undefined"
              >
                <span class="meta-grid__foot-value">{{ groupAggValueDisplay(item.path, field.id) }}</span>
              </td>
            </tr>
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
          <!-- A1 virtualization top spacer: reserves the height of rows scrolled above the window so the
               scrollbar + row positions match a fully-rendered table. Height 0 → effectively absent. -->
          <tr v-if="topSpacerHeight > 0" class="meta-grid__spacer" aria-hidden="true" data-test="grid-top-spacer">
            <td :colspan="colSpan" :style="{ height: `${topSpacerHeight}px`, padding: '0', border: 'none' }"></td>
          </tr>
          <template v-for="{ row, index: ri } in windowRows" :key="row.id">
            <tr
              role="row"
              :aria-selected="row.id === selectedRecordId || undefined"
              class="meta-grid__row"
              :class="{ 'meta-grid__row--selected': row.id === selectedRecordId, 'meta-grid__row--focused': focusRow === ri }"
              :style="rowStyle(row.id)"
              @click="emit('select-record', row.id)"
              @contextmenu="onRowContextMenu($event, row.id)"
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
                :class="{ 'meta-grid__cell--editing': isEditing(row.id, field.id), 'meta-grid__cell--readonly': !isEditable(row.id, field), 'meta-grid__cell--focused': focusRow === ri && focusCol === ci, 'meta-grid__cell--scale-fill': cellHasScaleFill(row.id, field.id), 'meta-grid__cell--remote-cursor': hasRemoteCursor(row.id, field.id) }"
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
                  :mention-suggestions="props.mentionSuggestions"
                  @update:model-value="editCell!.value = $event"
                  @confirm="confirmEdit(row)"
                  @yjs-commit="markYjsHandled(row.id, field.id)"
                  @cancel="cancelEdit"
                  @open-link-picker="openLinkPickerFromCell(row.id, field)"
                  @open-person-picker="openPersonPickerFromCell(row.id, field)"
                  @ai-run="onAiRunFromCell(row.id, field)"
                />
                <MetaCellRenderer
                  v-else
                  :field="field"
                  :value="row.data[field.id]"
                  :link-summaries="props.linkSummaries?.[row.id]?.[field.id]"
                  :person-summaries="props.personSummaries?.[row.id]?.[field.id]"
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
                        :person-summaries="props.personSummaries?.[row.id]?.[field.id]"
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
          <!-- A1 virtualization bottom spacer: reserves the height of rows scrolled below the window. -->
          <tr v-if="bottomSpacerHeight > 0" class="meta-grid__spacer" aria-hidden="true" data-test="grid-bottom-spacer">
            <td :colspan="colSpan" :style="{ height: `${bottomSpacerHeight}px`, padding: '0', border: 'none' }"></td>
          </tr>
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
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import type {
  MetaAttachment,
  MetaAttachmentDeleteFn,
  MetaAttachmentUploadFn,
  MetaCommentMentionSuggestion,
  MetaField,
  MetaRecordContext,
  MetaRowActions,
  MetaRecord,
  MultitableCommentPresenceSummary,
  RowDensity,
} from '../types'
import type { SortRule } from '../composables/useMultitableGrid'
import { composeStyleObject, type EvaluatedFormatting, type FieldScaleMap } from '../utils/conditional-formatting'
import { glyphForIconKey, type ScaleIconGlyph } from '../utils/scale-icons'

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

// Server per-group subtotal node (mirrors api/client ViewAggregateGroup). Recursive for nested grouping.
interface ServerAggregateGroup {
  key: string | number | boolean | null
  count: number
  aggregates: Record<string, { fn: string; value: number }>
  children?: ServerAggregateGroup[]
}

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
  // Native person (人员) display source (userId → {id,display}), parallel to linkSummaries.
  personSummaries?: Record<string, Record<string, { id: string; display: string }[]>>
  attachmentSummaries?: Record<string, Record<string, MetaAttachment[]>>
  enableMultiSelect?: boolean
  // Nested / multi-level grouping: ordered 1..3 group fields (level 0 = outermost). Empty/undefined →
  // no grouping. `groupField` (singular) is the legacy single-field prop, kept as a BACKWARD-COMPAT
  // alias: when `groupFields` is empty/absent, a present `groupField` renders as `[groupField]` (one
  // header + one subtotal level, byte-identical to today). `groupFields` takes precedence when both set.
  groupField?: MetaField | null
  groupFields?: MetaField[]
  // Group-collapse is CONTROLLED by the parent (persist-display-prefs arc): the set of collapsed group
  // keys comes in as a prop and the component only emits `toggle-group`. Keys are COMPOSITE path keys
  // (per-level values joined by the NUL separator) for nested grouping; a single-level group's path is
  // just its own key (unchanged). Single source of truth = persisted `view.config.groupCollapse`.
  collapsedGroupKeys?: string[]
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
  // #4-3b-2a + nested grouping: server-computed per-group subtotals (full filtered set, NOT page).
  // Matched to the client's rendered groups by a per-level composite key. Value rendered from this prop
  // only — no local group aggregation. `children` carries deeper-level subtotals (nested grouping).
  aggregateGroups?: ServerAggregateGroup[]
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
  // B5: people-mention candidates for rich-`longText` in-cell editing. Forwarded to
  // MetaCellEditor; the workbench feeds its already-loaded commentMentionSuggestions.
  mentionSuggestions?: MetaCommentMentionSuggestion[]
  // Live cell-cursors: cellKey (`${recordId}:${fieldId}`) → remote collaborator userIds on that cell.
  // Presentational highlight only; absent/empty → no cursors rendered.
  remoteCursorsByCell?: Map<string, string[]>
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
  (e: 'open-person-picker', ctx: { recordId: string; field: MetaField }): void
  (e: 'resize-column', fieldId: string, width: number): void
  (e: 'selection-change', recordIds: string[]): void
  (e: 'bulk-delete', recordIds: string[]): void
  (e: 'bulk-edit', payload: { mode: 'set' | 'clear'; recordIds: string[] }): void
  // Duplicate / clone record (design 2026-06-16): right-click a row → request a duplicate. The native
  // context menu is suppressed so the row affordance is the menu; the workbench owns the create + clone-open.
  (e: 'duplicate-record', recordId: string): void
  (e: 'reorder-field', fromFieldId: string, toFieldId: string): void
  (e: 'create-record'): void
  (e: 'set-frozen', frozenLeftColumnIds: string[]): void
  (e: 'set-aggregation', payload: { fieldId: string; fn: string | null }): void
  // Group-collapse toggle request (controlled-from-parent): parent flips the key in the persisted set.
  (e: 'toggle-group', key: string): void
  // A3: AI shortcut run requested from a cell editor.
  (e: 'ai-run', recordId: string, field: MetaField): void
  // B1-b: a button-field cell was clicked (run its configured action).
  (e: 'run-button', payload: { recordId: string; field: MetaField }): void
  // Live cell-cursors: the local user focused a cell → parent broadcasts it as the active cursor.
  (e: 'cursor-focus', payload: { recordId: string; fieldId: string }): void
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

// ── A1: row virtualization (windowing) for the FLAT body path ──────────────────────────────
// RENDER-ONLY: we still receive the exact same (already masked/paged) `props.rows`; we just mount a
// visible window of <tr>s plus two spacer rows so the DOM node count stays bounded as the row set
// grows past current paging. No data-loading / masking / permission path is touched.
//
// Scope (v1): only the flat (ungrouped, no-expanded-row) path is windowed. The grouped path renders
// interleaved header/subtotal rows of non-uniform height (see groupRenderItems) so uniform spacer math
// doesn't apply; and an open expand-row is taller than a data row. In both cases we fall back to
// full render — preserving exact current behavior — and document it as an intentional v1 limitation.
//
// jsdom note: clientHeight/scrollTop are 0 under test (no layout). We default the viewport to a sane
// height so the INITIAL render is already windowed, and read scrollTop off the wrap ref on scroll.
const tableWrap = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportHeight = ref(0)
const measuredRowHeight = ref(0)
// Overscan rows above/below the viewport so fast scroll / keyboard nav never reveals a blank gap.
const OVERSCAN_ROWS = 8
// Below this many rows the common case renders identically (no spacer rows) — small datasets are
// untouched, matching the "no regression for the common case" requirement.
const VIRTUALIZE_MIN_ROWS = 60
const DEFAULT_VIEWPORT_HEIGHT = 600

// Fallback row height by density, matching the CSS contain-intrinsic-size (28 / 36 / 52). An onMounted
// first-row measure overrides this with the real rendered height when layout is available.
function densityRowHeight(): number {
  if (props.rowDensity === 'compact') return 28
  if (props.rowDensity === 'expanded') return 52
  return 36
}
const rowHeightPx = computed(() => (measuredRowHeight.value > 0 ? measuredRowHeight.value : densityRowHeight()))

// While printing we render EVERY row (a windowed table would print only ~20 rows). beforeprint flips
// this and afterprint restores it (the print itself reads the synchronously-rendered DOM).
const printing = ref(false)

// Windowing is active only on the flat path, with no expanded rows, and once the set is large enough to
// matter. Otherwise the template renders every row exactly as before.
const flatWindowEnabled = computed(() =>
  !printing.value
  && !groupedRows.value
  && expandedRowIds.value.size === 0
  && filteredRows.value.length > VIRTUALIZE_MIN_ROWS,
)

const effectiveViewportHeight = computed(() => (viewportHeight.value > 0 ? viewportHeight.value : DEFAULT_VIEWPORT_HEIGHT))

// First row index to render (clamped, minus overscan). Also clamped against the row count so a stale
// scrollTop after the set shrinks (search/filter, short last page) can't push the window past the end
// and blank the grid behind a giant top spacer.
const windowStart = computed(() => {
  if (!flatWindowEnabled.value) return 0
  const total = filteredRows.value.length
  const visibleCount = Math.ceil(effectiveViewportHeight.value / rowHeightPx.value)
  const maxStart = Math.max(0, total - visibleCount - OVERSCAN_ROWS)
  const raw = Math.floor(scrollTop.value / rowHeightPx.value) - OVERSCAN_ROWS
  return Math.min(maxStart, Math.max(0, raw))
})
// One-past-last row index to render (clamped, plus overscan).
const windowEnd = computed(() => {
  const total = filteredRows.value.length
  if (!flatWindowEnabled.value) return total
  const visibleCount = Math.ceil(effectiveViewportHeight.value / rowHeightPx.value)
  return Math.min(total, windowStart.value + visibleCount + OVERSCAN_ROWS * 2)
})
// The rows actually mounted. Carries each row's ABSOLUTE index so row-number / focus / selection /
// keyboard-nav all keep using the real index (window-local `ri` would desync them — the keystone bug).
const windowRows = computed<Array<{ row: MetaRecord; index: number }>>(() => {
  const rowsArr = filteredRows.value
  if (!flatWindowEnabled.value) return rowsArr.map((row, index) => ({ row, index }))
  const out: Array<{ row: MetaRecord; index: number }> = []
  for (let i = windowStart.value; i < windowEnd.value; i++) out.push({ row: rowsArr[i], index: i })
  return out
})
// Spacer heights reserve the off-screen rows' vertical space so the scrollbar + scroll position match a
// fully-rendered table. zero when windowing is off (no spacer rows are emitted then).
const topSpacerHeight = computed(() => (flatWindowEnabled.value ? windowStart.value * rowHeightPx.value : 0))
const bottomSpacerHeight = computed(() =>
  flatWindowEnabled.value ? (filteredRows.value.length - windowEnd.value) * rowHeightPx.value : 0,
)

function onTableScroll() {
  if (!tableWrap.value) return
  scrollTop.value = tableWrap.value.scrollTop
}
function measureViewport() {
  if (!tableWrap.value) return
  const h = tableWrap.value.clientHeight
  if (h > 0) viewportHeight.value = h
  // First data row height (real layout) overrides the density fallback when available.
  const firstRow = tableWrap.value.querySelector<HTMLElement>('tbody tr.meta-grid__row')
  const rh = firstRow?.offsetHeight ?? 0
  if (rh > 0) measuredRowHeight.value = rh
}
// Keep the focused row inside the mounted window during keyboard navigation so arrow-keys never land on
// an un-rendered row. No-op when windowing is off or no row is focused.
function scrollFocusedRowIntoWindow() {
  if (!flatWindowEnabled.value || !tableWrap.value || focusRow.value < 0) return
  const rowTop = focusRow.value * rowHeightPx.value
  const rowBottom = rowTop + rowHeightPx.value
  const viewTop = tableWrap.value.scrollTop
  const viewBottom = viewTop + effectiveViewportHeight.value
  let next = viewTop
  if (rowTop < viewTop) next = rowTop
  else if (rowBottom > viewBottom) next = rowBottom - effectiveViewportHeight.value
  if (next !== viewTop) {
    tableWrap.value.scrollTop = next
    scrollTop.value = next
  }
}

function onBeforePrint() { printing.value = true }
function onAfterPrint() { printing.value = false }

onMounted(() => {
  measureViewport()
  tableWrap.value?.addEventListener('scroll', onTableScroll, { passive: true })
  window.addEventListener('resize', measureViewport)
  window.addEventListener('beforeprint', onBeforePrint)
  window.addEventListener('afterprint', onAfterPrint)
})
onBeforeUnmount(() => {
  tableWrap.value?.removeEventListener('scroll', onTableScroll)
  window.removeEventListener('resize', measureViewport)
  window.removeEventListener('beforeprint', onBeforePrint)
  window.removeEventListener('afterprint', onAfterPrint)
})
// Re-measure when the row set or density changes (e.g. page load swaps the rows / new first-row height).
watch([() => props.rows, () => props.rowDensity], () => {
  nextTick(measureViewport)
})

// --- GroupBy (nested / multi-level) ---
// Collapse state is CONTROLLED by the parent (persisted in view.config). collapsedGroups derives a Set
// from the prop for O(1) lookups; flipping a key is delegated upward via `toggle-group`. The keys are
// COMPOSITE path keys (per-level keys joined by GROUP_KEY_SEP) so a level-2 "A" can't collide with a
// level-1 "A"; collapsing a parent path hides every descendant.
// GROUP_KEY_SEP is U+001F (ASCII Unit Separator) — a non-printable control char that satisfies TWO
// constraints at once: (1) collision-safe — real group values (select/string/number/date display text)
// never contain it, so paths ["a b","c"] and ["a","b c"] stay DISTINCT where a printable separator (a
// space) would silently MERGE them, corrupting subtotal lookup and parent/child collapse; (2) PERSISTABLE
// — the composite path is stored in the view.config.groupCollapse.collapsedKeys jsonb column, and
// Postgres jsonb REJECTS U+0000 (NUL cannot be converted to text), so NUL — though impossible in PG text
// — cannot be the separator. U+001F stores fine in jsonb and is realistically never typed by users.
const collapsedGroups = computed<Set<string>>(() => new Set(props.collapsedGroupKeys ?? []))
const GROUP_KEY_SEP = '\u001f'
const GROUP_UNGROUPED = '__ungrouped__'

// ONE per-level normalizer used on BOTH the client page-row bucketing side AND the server-tree lookup
// side, so per-level key agreement holds by construction (the highest-risk silent-wrong bug otherwise).
// Empty cell / server null → the synthetic ungrouped key; everything else → String(val). Valid only
// because GROUPABLE_TYPES keeps group fields primitive (select/string/boolean/number/date).
function levelKey(val: unknown): string {
  return val == null || val === '' ? GROUP_UNGROUPED : String(val)
}
function groupLabel(key: string): string {
  return key === GROUP_UNGROUPED ? groupNoValue(isZh.value) : key
}

// Nested group node over the current page rows. `path` is the composite key (ancestor keys + own key).
interface RowGroup { key: string; path: string; label: string; level: number; rows: MetaRecord[]; count: number; children: RowGroup[] }

// Resolve the ordered group fields. `groupFields` (array) takes precedence; a present singular
// `groupField` is the BACKWARD-COMPAT one-level alias when the array is empty/absent.
const effectiveGroupFields = computed<MetaField[]>(() => {
  if (props.groupFields && props.groupFields.length > 0) return props.groupFields
  return props.groupField ? [props.groupField] : []
})

// Build the nested group tree by recursively bucketing `rows` over groupFields[level..].
function buildGroupTree(rows: MetaRecord[], level: number, parentPath: string): RowGroup[] {
  const field = effectiveGroupFields.value[level]
  if (!field) return []
  const map = new Map<string, MetaRecord[]>()
  for (const row of rows) {
    const key = levelKey(row.data[field.id])
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(row)
  }
  // Insertion order = first-seen on this page (mirrors the prior single-level client behavior).
  const groups: RowGroup[] = []
  for (const [key, groupRows] of map) {
    const path = parentPath ? parentPath + GROUP_KEY_SEP + key : key
    groups.push({
      key,
      path,
      label: groupLabel(key),
      level,
      rows: groupRows,
      count: groupRows.length,
      children: buildGroupTree(groupRows, level + 1, path),
    })
  }
  return groups
}

const groupedRows = computed<RowGroup[] | null>(() => {
  if (effectiveGroupFields.value.length === 0) return null
  return buildGroupTree(filteredRows.value, 0, '')
})

// Controlled: flipping a collapse key is delegated upward — the parent owns + persists the Set.
function toggleGroup(path: string) {
  emit('toggle-group', path)
}

// Flat, ordered render-list driving the template (you cannot nest <tr>). Each item is tagged. Leaf-level
// data rows + a per-level subtotal item at every node boundary (deepest first). Collapsed subtrees are
// omitted entirely. `navIndex` is the data-only index (into displayRows) for keyboard-focus matching.
type GroupRenderItem =
  | { kind: 'header'; path: string; label: string; level: number; count: number; collapsed: boolean }
  | { kind: 'data'; row: MetaRecord; navIndex: number }
  | { kind: 'subtotal'; path: string; level: number }

const groupRenderItems = computed<GroupRenderItem[]>(() => {
  if (!groupedRows.value) return []
  const items: GroupRenderItem[] = []
  let navIndex = 0
  const walk = (nodes: RowGroup[]) => {
    for (const node of nodes) {
      const collapsed = collapsedGroups.value.has(node.path)
      items.push({ kind: 'header', path: node.path, label: node.label, level: node.level, count: node.count, collapsed })
      if (collapsed) continue
      if (node.children.length > 0) {
        walk(node.children)
      } else {
        for (const row of node.rows) {
          items.push({ kind: 'data', row, navIndex })
          navIndex += 1
        }
      }
      // subtotal AFTER the node's body (leaf rows or nested children) — one per level, ancestors last.
      items.push({ kind: 'subtotal', path: node.path, level: node.level })
    }
  }
  walk(groupedRows.value)
  return items
})

// Flat list for keyboard nav (data rows only, respecting collapsed groups). Built from the same tree so
// it matches groupRenderItems' navIndex ordering exactly.
const displayRows = computed(() => {
  if (!groupedRows.value) return filteredRows.value
  const result: MetaRecord[] = []
  const walk = (nodes: RowGroup[]) => {
    for (const node of nodes) {
      if (collapsedGroups.value.has(node.path)) continue
      if (node.children.length > 0) walk(node.children)
      else result.push(...node.rows)
    }
  }
  walk(groupedRows.value)
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

const getSortDir = (fid: string) => props.sortRules.find((r) => r.fieldId === fid)?.direction ?? null
const isSortable = (f: MetaField) => !['link', 'lookup', 'rollup'].includes(f.type)
function resolveRowActions(recordId: string): MetaRowActions {
  return props.rowActionOverrides?.[recordId] ?? {
    canEdit: props.canEdit,
    canDelete: props.canDelete !== false,
    canComment: props.canComment !== false,
  }
}

// Duplicate / clone record (design 2026-06-16): right-click a row → emit a duplicate request. Net-new grid
// context affordance — no floating menu component, just the native contextmenu suppressed when actionable.
// Gated on `canCreate` (a duplicate is a create; the server re-enforces it). NOT active while a cell is being
// edited, so the native menu (copy/paste) still works inside the cell editor.
function onRowContextMenu(e: MouseEvent, recordId: string): void {
  if (!props.canCreate || editCell.value) return
  e.preventDefault()
  emit('duplicate-record', recordId)
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
// The glyph table is shared with the authoring dialog (utils/scale-icons) so the
// in-dialog preview matches the grid render exactly.
function cellScaleIcon(rid: string, fid: string): ScaleIconGlyph | null {
  const entry = props.conditionalFormattingScale?.byField[fid]?.byRecordId[rid]
  if (!entry || typeof entry.iconKey !== 'string') return null
  return glyphForIconKey(entry.iconKey)
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
const AGG_NUMERIC_TYPES = new Set(['number', 'currency', 'percent', 'rating', 'duration', 'autoNumber'])
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
// #4-3b-2a + nested grouping: server per-group subtotals, keyed by the COMPOSITE path key. The server
// tree is flattened with the SAME per-level normalizer (levelKey) + separator the client render tree
// uses, so a level-N subtotal looks up by the exact composite path of its render node — agreement holds
// by construction (the null-key group maps to GROUP_UNGROUPED on both sides).
const serverGroupAggByKey = computed(() => {
  const m = new Map<string, Record<string, { fn: string; value: number }>>()
  const walk = (nodes: ServerAggregateGroup[], parentPath: string) => {
    for (const node of nodes) {
      const key = levelKey(node.key)
      const path = parentPath ? parentPath + GROUP_KEY_SEP + key : key
      m.set(path, node.aggregates)
      if (node.children?.length) walk(node.children, path)
    }
  }
  walk(props.aggregateGroups ?? [], '')
  return m
})
// Has subtotals at all (at least the level-1 groups arrived from the server).
const hasGroupSubtotals = computed(() => hasAnyAggregation.value && !props.aggregateTooLarge && (props.aggregateGroups?.length ?? 0) > 0)
function groupAggValueDisplay(groupPath: string, fieldId: string): string {
  const a = serverGroupAggByKey.value.get(groupPath)?.[fieldId]
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
  const fieldId = props.visibleFields[ci]?.id
  if (fieldId) emit('cursor-focus', { recordId: rid, fieldId })
}

// Live cell-cursors: remote collaborators currently occupying a given cell (presentational highlight).
function hasRemoteCursor(recordId: string, fieldId: string): boolean {
  return (props.remoteCursorsByCell?.get(`${recordId}:${fieldId}`)?.length ?? 0) > 0
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

function openPersonPickerFromCell(recordId: string, field: MetaField) {
  cancelEdit()
  emit('open-person-picker', { recordId, field })
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
  // A1: after a vertical move, keep the focused row inside the rendered window so arrow-keys never land
  // on an un-mounted row (no-op when windowing is off / no focus).
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Tab') {
    scrollFocusedRowIntoWindow()
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
/* Live cell-cursor: a remote collaborator is on this cell (presentational, no interaction change). */
.meta-grid__cell--remote-cursor { outline: 2px dashed #e6a23c; outline-offset: -2px; position: relative; }
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
/* Nested levels: lighter background + thinner text as depth increases (visual hierarchy). */
.meta-grid__group-header--l1 td { background: #f5f8fb; font-weight: 500; }
.meta-grid__group-header--l2 td { background: #fafcfe; font-weight: 500; }
.meta-grid__group-indent { display: inline-flex; align-items: center; }
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
