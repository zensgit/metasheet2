<template>
  <div class="meta-kanban">
    <div v-if="!groupField" class="meta-kanban__empty">
      <div class="meta-kanban__empty-icon">&#x1F4CA;</div>
      <p>Select a <strong>select</strong>-type field to group by:</p>
      <select class="meta-kanban__field-select" :value="kanbanDraft.groupFieldId ?? ''" @change="onPickGroupField($event)">
        <option value="">— Choose field —</option>
        <option v-for="f in selectFields" :key="f.id" :value="f.id">{{ f.name }}</option>
      </select>
      <p v-if="!selectFields.length" class="meta-kanban__empty-hint">No select-type fields found. Add a select field first.</p>
      <button v-if="canCreate" class="meta-kanban__header-add" @click="emit('create-record', {})">+ Add record</button>
    </div>

    <template v-else>
      <div class="meta-kanban__header">
        <label class="meta-kanban__header-field">
          <span>Group</span>
          <select class="meta-kanban__field-select" :value="kanbanDraft.groupFieldId ?? ''" @change="onPickGroupField($event)">
            <option value="">(none)</option>
            <option v-for="field in selectFields" :key="field.id" :value="field.id">{{ field.name }}</option>
          </select>
        </label>
        <span class="meta-kanban__group-label">Grouped by: <strong>{{ groupField.name }}</strong></span>
        <details class="meta-kanban__field-picker">
          <summary>Card fields ({{ previewFields.length }})</summary>
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
        <button v-if="canCreate" class="meta-kanban__header-add" @click="emit('create-record', {})">+ Add record</button>
        <button class="meta-kanban__change-btn" @click="onClearGroupField">Clear</button>
      </div>

      <div class="meta-kanban__board">
        <div class="meta-kanban__column">
          <div class="meta-kanban__column-header meta-kanban__column-header--uncategorized">
            <span>Uncategorized</span>
            <span class="meta-kanban__count">{{ uncategorized.length }}</span>
          </div>
          <div class="meta-kanban__cards" :class="{ 'meta-kanban__cards--drag-over': dragOverColumn === '__uncategorized__' }" @dragover.prevent="dragOverColumn = '__uncategorized__'" @dragleave="dragOverColumn = null" @drop="dragOverColumn = null; onDrop(null, $event)">
            <div
              v-for="row in uncategorized"
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
              <div class="meta-kanban__card-title">{{ cardTitle(row) }}</div>
              <div class="meta-kanban__card-fields">
                <span v-for="f in previewFields" :key="f.id" class="meta-kanban__card-field">
                  <span class="meta-kanban__card-field-label">{{ f.name }}:</span>
                  {{ formatValue(row, f) }}
                </span>
              </div>
            </div>
            <div v-if="!uncategorized.length" class="meta-kanban__drop-hint">
              {{ canEdit ? 'Drop a card here or add a new record' : 'No cards in this column' }}
            </div>
          </div>
          <button v-if="canCreate" class="meta-kanban__add-btn" @click="emit('create-record', {})">+ Add</button>
        </div>

        <div v-for="opt in groupOptions" :key="opt.value" class="meta-kanban__column">
          <div class="meta-kanban__column-header" :style="{ borderTopColor: opt.color ?? '#409eff' }">
            <span>{{ opt.value }}</span>
            <span class="meta-kanban__count">{{ columnRows(opt.value).length }}</span>
          </div>
          <div class="meta-kanban__cards" :class="{ 'meta-kanban__cards--drag-over': dragOverColumn === opt.value }" @dragover.prevent="dragOverColumn = opt.value" @dragleave="dragOverColumn = null" @drop="dragOverColumn = null; onDrop(opt.value, $event)">
            <div
              v-for="row in columnRows(opt.value)"
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
              <div class="meta-kanban__card-title">{{ cardTitle(row) }}</div>
              <div class="meta-kanban__card-fields">
                <span v-for="f in previewFields" :key="f.id" class="meta-kanban__card-field">
                  <span class="meta-kanban__card-field-label">{{ f.name }}:</span>
                  {{ formatValue(row, f) }}
                </span>
              </div>
            </div>
            <div v-if="!columnRows(opt.value).length" class="meta-kanban__drop-hint">
              {{ canEdit ? 'Drop a card here to update its group' : 'No cards in this column' }}
            </div>
          </div>
          <button v-if="canCreate" class="meta-kanban__add-btn" @click="emit('create-record', { [groupField!.id]: opt.value })">+ Add</button>
        </div>
      </div>
    </template>

    <div v-if="loading" class="meta-kanban__loading">Loading...</div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { LinkedRecordSummary, MetaAttachment, MetaField, MetaKanbanViewConfig, MetaRecord } from '../types'
import { resolveKanbanViewConfig } from '../utils/view-config'
import { formatFieldDisplay } from '../utils/field-display'

const props = defineProps<{
  rows: MetaRecord[]
  fields: MetaField[]
  loading: boolean
  canCreate?: boolean
  canEdit?: boolean
  groupInfo?: Record<string, unknown> | null
  viewConfig?: Record<string, unknown> | null
  linkSummaries?: Record<string, Record<string, LinkedRecordSummary[]>>
  attachmentSummaries?: Record<string, Record<string, MetaAttachment[]>>
}>()

const emit = defineEmits<{
  (e: 'select-record', recordId: string): void
  (e: 'patch-cell', recordId: string, fieldId: string, value: unknown, version: number): void
  (e: 'create-record', data: Record<string, unknown>): void
  (e: 'update-view-config', input: { config: Record<string, unknown>; groupInfo?: Record<string, unknown> }): void
}>()

const pendingConfigKey = ref<string | null>(null)
const kanbanDraft = reactive<Required<MetaKanbanViewConfig>>({
  groupFieldId: null,
  cardFieldIds: [],
})
let dragRecordId: string | null = null
let dragVersion = 0
const dragOverColumn = ref<string | null>(null)

const kanbanConfig = computed<Required<MetaKanbanViewConfig>>(() =>
  resolveKanbanViewConfig(props.fields, props.viewConfig, props.groupInfo),
)

function normalizeKanbanConfig(config?: Partial<Required<MetaKanbanViewConfig>>) {
  return {
    groupFieldId: config?.groupFieldId ?? null,
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

const uncategorized = computed(() => {
  if (!groupField.value) return []
  const optValues = new Set(groupOptions.value.map((o) => o.value))
  return props.rows.filter((r) => {
    const v = r.data[groupField.value!.id]
    return !v || !optValues.has(String(v))
  })
})

function columnRows(optionValue: string): MetaRecord[] {
  if (!groupField.value) return []
  return props.rows.filter((r) => String(r.data[groupField.value!.id] ?? '') === optionValue)
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
  })
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
    cardFieldIds: kanbanDraft.cardFieldIds,
    ...next,
  })
  kanbanDraft.groupFieldId = normalized.groupFieldId
  kanbanDraft.cardFieldIds = normalized.cardFieldIds
  pendingConfigKey.value = JSON.stringify(normalized)
  emit('update-view-config', {
    config: normalized,
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
  const ids: string[] = uncategorized.value.map((r) => r.id)
  for (const opt of groupOptions.value) {
    ids.push(...columnRows(opt.value).map((r) => r.id))
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
.meta-kanban__board { display: flex; flex: 1; overflow-x: auto; padding: 12px 8px; gap: 12px; }
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
.meta-kanban__card-title { font-size: 13px; font-weight: 500; color: #333; margin-bottom: 4px; }
.meta-kanban__card-fields { display: flex; flex-direction: column; gap: 2px; }
.meta-kanban__card-field { font-size: 11px; color: #888; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-kanban__card-field-label { color: #aaa; }
.meta-kanban__drop-hint { padding: 12px 10px; font-size: 11px; color: #94a3b8; text-align: center; border: 1px dashed #cbd5e1; border-radius: 6px; background: rgba(255,255,255,.7); }
.meta-kanban__add-btn { margin: 4px 8px 8px; padding: 4px; border: 1px dashed #ccc; border-radius: 4px; background: transparent; cursor: pointer; font-size: 12px; color: #999; }
.meta-kanban__add-btn:hover { border-color: #409eff; color: #409eff; }
.meta-kanban__loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,.7); font-size: 14px; color: #666; z-index: 10; }
</style>
