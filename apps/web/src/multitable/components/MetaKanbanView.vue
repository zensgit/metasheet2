<template>
  <div class="meta-kanban">
    <div v-if="!groupField" class="meta-kanban__empty">
      <div class="meta-kanban__empty-icon">&#x1F4CA;</div>
      <p>{{ viewRenderLabel('kanban.selectFieldPromptPrefix', isZh) }}<strong>{{ fieldTypeLabel('select', isZh) }}</strong>{{ viewRenderLabel('kanban.selectFieldPromptSuffix', isZh) }}</p>
      <select class="meta-kanban__field-select" :value="kanbanDraft.groupFieldId ?? ''" @change="onPickGroupField($event)">
        <option value="">{{ viewRenderLabel('common.chooseField', isZh) }}</option>
        <option v-for="f in selectFields" :key="f.id" :value="f.id">{{ f.name }}</option>
      </select>
      <p v-if="!selectFields.length" class="meta-kanban__empty-hint">{{ viewRenderLabel('kanban.noSelectFields', isZh) }}</p>
      <button v-if="canCreate" class="meta-kanban__header-add" @click="emit('create-record', {})">{{ viewRenderLabel('common.addRecord', isZh) }}</button>
    </div>

    <template v-else>
      <div class="meta-kanban__header">
        <label class="meta-kanban__header-field">
          <span>{{ viewRenderLabel('gantt.group', isZh) }}</span>
          <select class="meta-kanban__field-select" :value="kanbanDraft.groupFieldId ?? ''" @change="onPickGroupField($event)">
            <option value="">{{ viewRenderLabel('common.none', isZh) }}</option>
            <option v-for="field in selectFields" :key="field.id" :value="field.id">{{ field.name }}</option>
          </select>
        </label>
        <label v-if="swimlaneFieldCandidates.length" class="meta-kanban__header-field">
          <span>{{ viewRenderLabel('kanban.swimlane', isZh) }}</span>
          <select class="meta-kanban__field-select" :value="kanbanDraft.swimlaneFieldId ?? ''" @change="onPickSwimlaneField($event)">
            <option value="">{{ viewRenderLabel('common.none', isZh) }}</option>
            <option v-for="field in swimlaneFieldCandidates" :key="field.id" :value="field.id">{{ field.name }}</option>
          </select>
        </label>
        <span class="meta-kanban__group-label">{{ viewRenderLabel('kanban.groupedBy', isZh) }} <strong>{{ groupField.name }}</strong></span>
        <details class="meta-kanban__field-picker">
          <summary>{{ cardFieldsSummary(previewFields.length, isZh) }}</summary>
          <div class="meta-kanban__field-picker-list">
            <label v-for="field in previewFieldCandidates" :key="field.id" class="meta-kanban__field-picker-item">
              <input
                type="checkbox"
                :checked="kanbanDraft.cardFieldIds.includes(field.id)"
                @change="toggleCardField(field.id)"
              />
              <span>{{ field.name }}</span>
            </label>
          </div>
        </details>
        <button v-if="canCreate" class="meta-kanban__header-add" @click="emit('create-record', {})">{{ viewRenderLabel('common.addRecord', isZh) }}</button>
        <button class="meta-kanban__change-btn" @click="onClearGroupField">{{ viewRenderLabel('kanban.clear', isZh) }}</button>
      </div>

      <div class="meta-kanban__board" :class="{ 'meta-kanban__board--swimlaned': !!swimlaneField }">
        <div v-for="lane in swimlaneRows" :key="lane.key ?? '__lane__'" class="meta-kanban__swimlane">
          <div v-if="lane.label !== null" class="meta-kanban__swimlane-header" :style="lane.color ? { borderLeftColor: lane.color } : {}">
            <span class="meta-kanban__swimlane-label">{{ lane.label }}</span>
            <span class="meta-kanban__count">{{ lane.count }}</span>
          </div>
          <div class="meta-kanban__swimlane-columns">
            <div v-for="col in lane.columns" :key="dropKey(lane.key, col.value)" class="meta-kanban__column">
              <div
                class="meta-kanban__column-header"
                :class="{ 'meta-kanban__column-header--uncategorized': col.isUncategorized }"
                :style="!col.isUncategorized ? { borderTopColor: col.color ?? '#409eff' } : {}"
              >
                <span>{{ col.label }}</span>
                <span class="meta-kanban__count">{{ col.rows.length }}</span>
              </div>
              <div
                class="meta-kanban__cards"
                :class="{ 'meta-kanban__cards--drag-over': dragOverColumn === dropKey(lane.key, col.value) }"
                @dragover.prevent="dragOverColumn = dropKey(lane.key, col.value)"
                @dragleave="dragOverColumn = null"
                @drop="dragOverColumn = null; onDrop(col.value, $event)"
              >
                <div
                  v-for="row in col.rows"
                  :key="row.id"
                  class="meta-kanban__card"
                  role="article"
                  tabindex="0"
                  :aria-label="cardTitle(row)"
                  draggable="true"
                  @dragstart="onDragStart(row, $event)"
                  @click="emit('select-record', row.id)"
                  @keydown="onCardKeydown($event, row.id)"
                >
                  <div class="meta-kanban__card-header">
                    <div class="meta-kanban__card-title">{{ cardTitle(row) }}</div>
                    <button
                      v-if="canComment"
                      class="meta-kanban__comment-btn"
                      :class="rowCommentButtonClass(row.id)"
                      type="button"
                      :aria-label="openRecordCommentsAria(cardTitle(row), isZh)"
                      @click.stop="emit('open-comments', row.id)"
                      @keydown="onRowCommentKeydown($event, row.id)"
                    >
                      <MetaCommentActionChip :label="commentsChipLabel" :state="rowCommentAffordance(row.id)" />
                    </button>
                  </div>
                  <div class="meta-kanban__card-fields">
                    <div v-for="f in previewFields" :key="f.id" class="meta-kanban__card-field">
                      <span class="meta-kanban__card-field-copy">
                        <span class="meta-kanban__card-field-label">{{ f.name }}:</span>
                        {{ formatValue(row, f) }}
                      </span>
                      <button
                        v-if="canComment"
                        type="button"
                        class="meta-kanban__field-comment-btn"
                        :class="fieldCommentButtonClass(row.id, f.id)"
                        :aria-label="openFieldCommentsForRecordAria(f.name, cardTitle(row), isZh)"
                        @click.stop="emit('open-field-comments', { recordId: row.id, fieldId: f.id })"
                        @keydown="onFieldCommentKeydown($event, row.id, f.id)"
                      >
                        <MetaCommentAffordance :state="fieldCommentAffordance(row.id, f.id)" />
                      </button>
                    </div>
                  </div>
                </div>
                <div v-if="!col.rows.length" class="meta-kanban__drop-hint">
                  {{ canEdit ? (col.isUncategorized ? viewRenderLabel('kanban.dropOrAdd', isZh) : viewRenderLabel('kanban.dropToUpdate', isZh)) : viewRenderLabel('kanban.noCards', isZh) }}
                </div>
              </div>
              <button v-if="canCreate" class="meta-kanban__add-btn" @click="onCreateInCell(lane.key, col.value)">{{ viewRenderLabel('common.add', isZh) }}</button>
            </div>
          </div>
        </div>
      </div>
    </template>

    <div v-if="loading" class="meta-kanban__loading">{{ viewRenderLabel('common.loading', isZh) }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { LinkedRecordSummary, MetaAttachment, MetaField, MetaKanbanViewConfig, MetaRecord, MultitableCommentPresenceSummary } from '../types'
import { resolveKanbanViewConfig } from '../utils/view-config'
import { formatFieldDisplay } from '../utils/field-display'
import { useLocale } from '../../composables/useLocale'
import MetaCommentActionChip from './MetaCommentActionChip.vue'
import MetaCommentAffordance from './MetaCommentAffordance.vue'
import {
  handleCommentAffordanceKeydown,
  resolveCommentAffordanceStateClass,
  resolveFieldCommentAffordance,
  resolveRecordCommentAffordance,
} from '../utils/comment-affordance'
import { commentLabel } from '../utils/meta-comment-labels'
import { fieldTypeLabel } from '../utils/meta-core-labels'
import {
  cardFieldsSummary,
  openFieldCommentsForRecordAria,
  openRecordCommentsAria,
  viewRenderLabel,
} from '../utils/meta-view-render-labels'

const props = defineProps<{
  rows: MetaRecord[]
  fields: MetaField[]
  loading: boolean
  canCreate?: boolean
  canEdit?: boolean
  canComment?: boolean
  groupInfo?: Record<string, unknown> | null
  viewConfig?: Record<string, unknown> | null
  linkSummaries?: Record<string, Record<string, LinkedRecordSummary[]>>
  attachmentSummaries?: Record<string, Record<string, MetaAttachment[]>>
  commentPresence?: Record<string, MultitableCommentPresenceSummary | undefined>
}>()

const emit = defineEmits<{
  (e: 'select-record', recordId: string): void
  (e: 'open-comments', recordId: string): void
  (e: 'open-field-comments', payload: { recordId: string; fieldId: string }): void
  (e: 'patch-cell', recordId: string, fieldId: string, value: unknown, version: number): void
  (e: 'create-record', data: Record<string, unknown>): void
  (e: 'update-view-config', input: { config: Record<string, unknown>; groupInfo?: Record<string, unknown> }): void
}>()

const pendingConfigKey = ref<string | null>(null)
const kanbanDraft = reactive<Required<MetaKanbanViewConfig>>({
  groupFieldId: null,
  swimlaneFieldId: null,
  cardFieldIds: [],
})
let dragRecordId: string | null = null
let dragVersion = 0
const dragOverColumn = ref<string | null>(null)
const { isZh } = useLocale()
const commentsChipLabel = computed(() => commentLabel('comment.title', isZh.value))

const kanbanConfig = computed<Required<MetaKanbanViewConfig>>(() =>
  resolveKanbanViewConfig(props.fields, props.viewConfig, props.groupInfo),
)

function normalizeKanbanConfig(config?: Partial<Required<MetaKanbanViewConfig>>) {
  const groupFieldId = config?.groupFieldId ?? null
  // A field can't be both axes: drop the swimlane if it equals the column group field.
  const rawSwimlane = config?.swimlaneFieldId ?? null
  return {
    groupFieldId,
    swimlaneFieldId: rawSwimlane && rawSwimlane !== groupFieldId ? rawSwimlane : null,
    cardFieldIds: [...(config?.cardFieldIds ?? [])],
  }
}

watch(
  kanbanConfig,
  (config) => {
    const normalized = normalizeKanbanConfig(config)
    const configKey = JSON.stringify(normalized)
    if (pendingConfigKey.value && pendingConfigKey.value !== configKey) return
    kanbanDraft.groupFieldId = normalized.groupFieldId
    kanbanDraft.swimlaneFieldId = normalized.swimlaneFieldId
    kanbanDraft.cardFieldIds = normalized.cardFieldIds
    if (pendingConfigKey.value === configKey) pendingConfigKey.value = null
  },
  { immediate: true },
)

const selectFields = computed(() => props.fields.filter((f) => f.type === 'select'))

const groupField = computed(() =>
  kanbanDraft.groupFieldId ? props.fields.find((f) => f.id === kanbanDraft.groupFieldId) ?? null : null,
)

const groupOptions = computed<Array<{ value: string; color?: string }>>(() =>
  groupField.value?.options ?? [],
)

// Swimlanes (optional row dimension). Unset → single implicit headerless lane = legacy 1D board.
const swimlaneField = computed(() =>
  kanbanDraft.swimlaneFieldId ? props.fields.find((f) => f.id === kanbanDraft.swimlaneFieldId) ?? null : null,
)
const swimlaneOptions = computed<Array<{ value: string; color?: string }>>(() =>
  swimlaneField.value?.options ?? [],
)
// Candidates for the swimlane picker: select fields except the column group field (no field on both axes).
const swimlaneFieldCandidates = computed(() =>
  selectFields.value.filter((f) => f.id !== kanbanDraft.groupFieldId),
)

const titleField = computed(() =>
  props.fields.find((f) => f.type === 'string') ?? props.fields[0] ?? null,
)

const previewFields = computed(() =>
  (kanbanDraft.cardFieldIds.length > 0
    ? kanbanDraft.cardFieldIds
      .map((fieldId) => props.fields.find((field) => field.id === fieldId) ?? null)
      .filter((field): field is MetaField => !!field)
      .filter((field) => field.id !== kanbanDraft.groupFieldId && field.id !== titleField.value?.id)
    : props.fields.filter((f) => f.id !== kanbanDraft.groupFieldId && f.id !== titleField.value?.id).slice(0, 2)),
)

const previewFieldCandidates = computed(() =>
  props.fields.filter((field) => field.id !== kanbanDraft.groupFieldId && field.id !== titleField.value?.id),
)

type KanbanColumn = { value: string | null; label: string; color?: string; isUncategorized: boolean; rows: MetaRecord[] }
type KanbanSwimlane = { key: string | null; label: string | null; color?: string; count: number; columns: KanbanColumn[] }

// Bucket a row set into [uncategorized, ...one per group option]. Shared by 1D + every swimlane row.
function bucketColumns(rows: MetaRecord[]): KanbanColumn[] {
  if (!groupField.value) return []
  const gid = groupField.value.id
  const optValues = new Set(groupOptions.value.map((o) => o.value))
  const uncategorized: KanbanColumn = {
    value: null,
    label: viewRenderLabel('kanban.uncategorized', isZh.value),
    isUncategorized: true,
    rows: rows.filter((r) => { const v = r.data[gid]; return !v || !optValues.has(String(v)) }),
  }
  const columns = groupOptions.value.map((opt): KanbanColumn => ({
    value: opt.value,
    label: opt.value,
    color: opt.color,
    isUncategorized: false,
    rows: rows.filter((r) => String(r.data[gid] ?? '') === opt.value),
  }))
  return [uncategorized, ...columns]
}

// Unified board model: 1D = one headerless lane over all rows; 2D = one lane per swimlane option (+ an
// uncategorized lane when needed), each lane bucketed into columns. Card template renders once over this.
const swimlaneRows = computed<KanbanSwimlane[]>(() => {
  if (!groupField.value) return []
  if (!swimlaneField.value) {
    return [{ key: null, label: null, count: props.rows.length, columns: bucketColumns(props.rows) }]
  }
  const sid = swimlaneField.value.id
  const laneValues = new Set(swimlaneOptions.value.map((o) => o.value))
  const lanes: KanbanSwimlane[] = swimlaneOptions.value.map((opt): KanbanSwimlane => {
    const laneRows = props.rows.filter((r) => String(r.data[sid] ?? '') === opt.value)
    return { key: opt.value, label: opt.value, color: opt.color, count: laneRows.length, columns: bucketColumns(laneRows) }
  })
  const uncatLaneRows = props.rows.filter((r) => { const v = r.data[sid]; return !v || !laneValues.has(String(v)) })
  if (uncatLaneRows.length) {
    lanes.push({ key: null, label: viewRenderLabel('kanban.uncategorized', isZh.value), count: uncatLaneRows.length, columns: bucketColumns(uncatLaneRows) })
  }
  return lanes
})

// Per-cell drag-over key (swimlane × column) so highlighting is scoped to one cell, not a whole column.
function dropKey(laneKey: string | null, columnValue: string | null): string {
  return (laneKey ?? '__lane__') + '::' + (columnValue ?? '__uncat__')
}

// Create in a cell: prefill the column (status) field AND, in swimlane mode, the swimlane field.
function onCreateInCell(laneKey: string | null, columnValue: string | null) {
  const data: Record<string, unknown> = {}
  if (groupField.value && columnValue !== null) data[groupField.value.id] = columnValue
  if (swimlaneField.value && laneKey !== null) data[swimlaneField.value.id] = laneKey
  emit('create-record', data)
}

function onPickSwimlaneField(e: Event) {
  emitConfigUpdate({ swimlaneFieldId: (e.target as HTMLSelectElement).value || null })
}

function cardTitle(row: MetaRecord): string {
  if (!titleField.value) return row.id
  const display = formatValue(row, titleField.value)
  return display === '—' ? row.id : display
}

function formatValue(row: MetaRecord, field: MetaField): string {
  return formatFieldDisplay({
    field,
    value: row.data[field.id],
    linkSummaries: props.linkSummaries?.[row.id]?.[field.id],
    attachmentSummaries: props.attachmentSummaries?.[row.id]?.[field.id],
    isZh: isZh.value,
  })
}

function rowCommentAffordance(recordId: string) {
  return resolveRecordCommentAffordance(props.commentPresence?.[recordId])
}

function fieldCommentAffordance(recordId: string, fieldId: string) {
  return resolveFieldCommentAffordance(props.commentPresence?.[recordId], fieldId)
}

function rowCommentButtonClass(recordId: string): string {
  return resolveCommentAffordanceStateClass('meta-kanban__comment-btn', rowCommentAffordance(recordId))
}

function fieldCommentButtonClass(recordId: string, fieldId: string): string {
  return resolveCommentAffordanceStateClass('meta-kanban__field-comment-btn', fieldCommentAffordance(recordId, fieldId))
}

function onRowCommentKeydown(event: KeyboardEvent, recordId: string) {
  handleCommentAffordanceKeydown(event, () => emit('open-comments', recordId))
}

function onFieldCommentKeydown(event: KeyboardEvent, recordId: string, fieldId: string) {
  handleCommentAffordanceKeydown(event, () => emit('open-field-comments', { recordId, fieldId }))
}

function onPickGroupField(e: Event) {
  const val = (e.target as HTMLSelectElement).value
  const nextGroupFieldId = val || null
  emitConfigUpdate({ groupFieldId: nextGroupFieldId })
}

function onClearGroupField() {
  emitConfigUpdate({ groupFieldId: null })
}

function emitConfigUpdate(next: Partial<Required<MetaKanbanViewConfig>>) {
  const normalized = normalizeKanbanConfig({
    groupFieldId: kanbanDraft.groupFieldId,
    swimlaneFieldId: kanbanDraft.swimlaneFieldId,
    cardFieldIds: kanbanDraft.cardFieldIds,
    ...next,
  })
  kanbanDraft.groupFieldId = normalized.groupFieldId
  kanbanDraft.swimlaneFieldId = normalized.swimlaneFieldId
  kanbanDraft.cardFieldIds = normalized.cardFieldIds
  pendingConfigKey.value = JSON.stringify(normalized)
  // Byte-identical wire for legacy (no-swimlane) configs: only persist the swimlane key when it's set, so
  // existing kanban views serialize exactly as before and don't churn.
  const config: Record<string, unknown> = {
    groupFieldId: normalized.groupFieldId,
    cardFieldIds: normalized.cardFieldIds,
  }
  if (normalized.swimlaneFieldId) config.swimlaneFieldId = normalized.swimlaneFieldId
  emit('update-view-config', {
    config,
    groupInfo: normalized.groupFieldId ? { fieldId: normalized.groupFieldId } : {},
  })
}

function toggleCardField(fieldId: string) {
  const nextCardFieldIds = kanbanDraft.cardFieldIds.includes(fieldId)
    ? kanbanDraft.cardFieldIds.filter((id) => id !== fieldId)
    : [...kanbanDraft.cardFieldIds, fieldId]
  emitConfigUpdate({ cardFieldIds: nextCardFieldIds })
}

function onDragStart(row: MetaRecord, e: DragEvent) {
  if (!props.canEdit) { e.preventDefault(); return }
  dragRecordId = row.id
  dragVersion = row.version
  e.dataTransfer?.setData('text/plain', row.id)
}

function onDrop(targetValue: string | null, _e: DragEvent) {
  if (!dragRecordId || !groupField.value || !props.canEdit) return
  emit('patch-cell', dragRecordId, groupField.value.id, targetValue ?? '', dragVersion)
  dragRecordId = null
}

const focusedCardId = ref<string | null>(null)

function allCards(): string[] {
  const ids: string[] = []
  for (const lane of swimlaneRows.value) {
    for (const col of lane.columns) ids.push(...col.rows.map((r) => r.id))
  }
  return ids
}

function onCardKeydown(e: KeyboardEvent, cardId: string) {
  if (e.key === 'Enter') {
    e.preventDefault()
    emit('select-record', cardId)
    return
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const ids = allCards()
    const idx = ids.indexOf(cardId)
    if (idx < 0) return
    const next = e.key === 'ArrowDown' ? idx + 1 : idx - 1
    if (next >= 0 && next < ids.length) {
      focusedCardId.value = ids[next]
      const el = (e.target as HTMLElement)?.parentElement?.querySelector(`[aria-label]`)?.parentElement?.querySelector(`[aria-label="${cardTitle(props.rows.find((r) => r.id === ids[next])!)}"]`) as HTMLElement
      if (!el) {
        const allEls = document.querySelectorAll('.meta-kanban__card[tabindex="0"]')
        ;(allEls[next] as HTMLElement)?.focus()
      } else {
        el.focus()
      }
    }
  }
}
</script>

<style scoped>
.meta-kanban { display: flex; flex-direction: column; flex: 1; min-height: 0; position: relative; }
.meta-kanban__empty { display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; color: #666; font-size: 14px; gap: 12px; }
.meta-kanban__empty-icon { font-size: 36px; opacity: 0.5; }
.meta-kanban__empty-hint { font-size: 12px; color: #aaa; }
.meta-kanban__field-select { padding: 6px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; }
.meta-kanban__header { display: flex; align-items: center; gap: 8px; padding: 8px 16px; border-bottom: 1px solid #eee; font-size: 13px; color: #666; }
.meta-kanban__header-field { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #64748b; }
.meta-kanban__header-add { padding: 5px 10px; border: 1px solid #c7ddff; border-radius: 6px; background: #ecf5ff; color: #2563eb; font-size: 12px; cursor: pointer; }
.meta-kanban__header-add:hover { background: #dbeafe; }
.meta-kanban__change-btn { padding: 2px 8px; border: 1px solid #ddd; border-radius: 3px; background: #fff; cursor: pointer; font-size: 11px; color: #409eff; }
.meta-kanban__field-picker { margin-left: auto; }
.meta-kanban__field-picker summary { list-style: none; cursor: pointer; font-size: 12px; color: #409eff; user-select: none; }
.meta-kanban__field-picker summary::-webkit-details-marker { display: none; }
.meta-kanban__field-picker-list { display: flex; flex-wrap: wrap; gap: 8px 12px; margin-top: 8px; padding: 10px 12px; border: 1px solid #d8e1ee; border-radius: 8px; background: #fff; box-shadow: 0 8px 20px rgba(15,23,42,.08); max-width: 360px; }
.meta-kanban__field-picker-item { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #475569; }
.meta-kanban__board { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow-y: auto; padding: 12px 8px; gap: 14px; }
/* 1D (no swimlane): single lane fills height so columns scroll internally — identical to the legacy board. */
.meta-kanban__board:not(.meta-kanban__board--swimlaned) .meta-kanban__swimlane { flex: 1; }
.meta-kanban__swimlane { display: flex; flex-direction: column; gap: 6px; min-height: 0; }
.meta-kanban__swimlane-header { display: flex; align-items: center; gap: 8px; padding: 5px 12px; font-size: 13px; font-weight: 600; color: #334155; background: #eef2f7; border-left: 3px solid #409eff; border-radius: 4px; position: sticky; left: 0; }
.meta-kanban__swimlane-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The horizontal column strip (the legacy board's role). 2D caps each lane's height so the board scrolls vertically. */
.meta-kanban__swimlane-columns { display: flex; flex: 1; min-height: 0; gap: 12px; overflow-x: auto; align-items: flex-start; padding-bottom: 4px; }
.meta-kanban__board--swimlaned .meta-kanban__swimlane-columns { max-height: 440px; align-items: stretch; }
.meta-kanban__column { min-width: 240px; width: 280px; flex-shrink: 0; background: #f5f7fa; border-radius: 8px; display: flex; flex-direction: column; max-height: 100%; }
.meta-kanban__column-header { padding: 10px 12px; font-size: 13px; font-weight: 600; color: #333; display: flex; justify-content: space-between; align-items: center; border-top: 3px solid #409eff; border-radius: 8px 8px 0 0; }
.meta-kanban__column-header--uncategorized { border-top-color: #999; color: #999; }
.meta-kanban__count { font-size: 11px; font-weight: 400; color: #999; background: #e8e8e8; padding: 1px 6px; border-radius: 10px; }
.meta-kanban__cards { flex: 1; overflow-y: auto; padding: 4px 8px; display: flex; flex-direction: column; gap: 6px; min-height: 40px; transition: background 0.15s, border-color 0.15s; border: 2px solid transparent; border-radius: 0 0 6px 6px; }
.meta-kanban__cards--drag-over { background: #ecf5ff; border-color: #409eff; }
.meta-kanban__card { background: #fff; border-radius: 6px; padding: 10px 12px; box-shadow: 0 1px 3px rgba(0,0,0,.08); cursor: pointer; transition: box-shadow 0.15s; }
.meta-kanban__card:hover { box-shadow: 0 2px 8px rgba(0,0,0,.12); }
.meta-kanban__card:focus-visible { outline: 2px solid #409eff; outline-offset: 1px; }
.meta-kanban__card[draggable="true"] { cursor: grab; }
.meta-kanban__card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
.meta-kanban__card-title { font-size: 13px; font-weight: 500; color: #333; min-width: 0; }
.meta-kanban__comment-btn { display: inline-flex; align-items: center; justify-content: center; min-height: 28px; padding: 2px 8px; border: 1px solid #d8e1ee; border-radius: 999px; background: #fff; cursor: pointer; color: #64748b; flex-shrink: 0; }
.meta-kanban__comment-btn:hover { border-color: #93c5fd; background: #eff6ff; color: #2563eb; }
.meta-kanban__comment-btn--active { border-color: #f59e0b; background: #fff7ed; color: #b45309; }
.meta-kanban__comment-btn--idle { border-color: #d8e1ee; background: #fff; color: #64748b; }
.meta-kanban__card-fields { display: flex; flex-direction: column; gap: 2px; }
.meta-kanban__card-field { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; font-size: 11px; color: #888; }
.meta-kanban__card-field-copy { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-kanban__card-field-label { color: #aaa; }
.meta-kanban__field-comment-btn { display: inline-flex; align-items: center; justify-content: center; min-width: 24px; height: 22px; padding: 0 5px; border: 1px solid #d8e1ee; border-radius: 999px; background: #fff; cursor: pointer; color: #64748b; flex-shrink: 0; }
.meta-kanban__field-comment-btn:hover { border-color: #93c5fd; background: #eff6ff; color: #2563eb; }
.meta-kanban__field-comment-btn--active { border-color: #f59e0b; background: #fff7ed; color: #b45309; }
.meta-kanban__field-comment-btn--idle { border-color: #d8e1ee; background: #fff; color: #64748b; }
.meta-kanban__drop-hint { padding: 12px 10px; font-size: 11px; color: #94a3b8; text-align: center; border: 1px dashed #cbd5e1; border-radius: 6px; background: rgba(255,255,255,.7); }
.meta-kanban__add-btn { margin: 4px 8px 8px; padding: 4px; border: 1px dashed #ccc; border-radius: 4px; background: transparent; cursor: pointer; font-size: 12px; color: #999; }
.meta-kanban__add-btn:hover { border-color: #409eff; color: #409eff; }
.meta-kanban__loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,.7); font-size: 14px; color: #666; z-index: 10; }
</style>
