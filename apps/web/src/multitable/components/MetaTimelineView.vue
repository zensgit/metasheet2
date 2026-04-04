<template>
  <div class="meta-timeline" role="region" aria-label="Timeline view">
    <div v-if="loading" class="meta-timeline__loading">Loading...</div>
    <template v-else>
      <div class="meta-timeline__config">
        <label class="meta-timeline__config-label">
          Start date
          <select class="meta-timeline__config-select" :value="startFieldId" @change="onStartFieldChange">
            <option value="">— select —</option>
            <option v-for="f in dateFields" :key="f.id" :value="f.id">{{ f.name }}</option>
          </select>
        </label>
        <label class="meta-timeline__config-label">
          End date
          <select class="meta-timeline__config-select" :value="endFieldId" @change="onEndFieldChange">
            <option value="">— select —</option>
            <option v-for="f in dateFields" :key="f.id" :value="f.id">{{ f.name }}</option>
          </select>
        </label>
        <label class="meta-timeline__config-label">
          Label field
          <select class="meta-timeline__config-select" :value="labelFieldId" @change="onLabelFieldChange">
            <option value="">(auto)</option>
            <option v-for="f in labelFields" :key="f.id" :value="f.id">{{ f.name }}</option>
          </select>
          <span class="meta-timeline__config-hint">
            {{ labelFieldHint }}
          </span>
        </label>
        <label class="meta-timeline__config-label">
          Zoom
          <select class="meta-timeline__config-select" :value="zoom" @change="onZoomChange">
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
          </select>
          <span class="meta-timeline__config-hint">
            Axis spacing follows the selected zoom level.
          </span>
        </label>
        <button v-if="canCreate" class="meta-timeline__create-btn" @click="onQuickCreate">+ Add record</button>
      </div>

      <div v-if="!startFieldId || !endFieldId" class="meta-timeline__placeholder">
        Select start and end date fields to display the timeline.
        <button v-if="canCreate" class="meta-timeline__placeholder-action" @click="onQuickCreate">Create record</button>
      </div>

      <template v-else>
        <div class="meta-timeline__header">
          <div class="meta-timeline__label-col">
            <span>Record</span>
            <span class="meta-timeline__header-meta">
              {{ labelFieldSummary }}
            </span>
          </div>
          <div class="meta-timeline__axis">
            <span class="meta-timeline__zoom-badge">Zoom: {{ zoomLabel }}</span>
            <span v-for="tick in axisTicks" :key="tick.key" class="meta-timeline__tick" :style="{ left: tick.left + '%' }">
              {{ tick.label }}
            </span>
          </div>
        </div>

        <div
          v-for="item in scheduledRows"
          :key="item.record.id"
          class="meta-timeline__row"
          :class="{ 'meta-timeline__row--selected': item.record.id === selectedRecordId, 'meta-timeline__row--dragging': item.record.id === draggingRecordId }"
          tabindex="0"
          role="button"
          :aria-label="displayLabel(item.record)"
          @click="onSelect(item.record.id)"
          @keydown.enter="onSelect(item.record.id)"
        >
          <div class="meta-timeline__label-col" :class="{ 'meta-timeline__label-col--attachment': isAttachmentLabel }">
            <div class="meta-timeline__label-copy">
              <MetaAttachmentList
                v-if="isAttachmentLabel && displayField"
                :attachments="attachmentItems(item.record, displayField)"
                variant="compact"
                empty-label="No attachments"
              />
              <template v-else>{{ displayLabel(item.record) }}</template>
            </div>
            <div v-if="canComment" class="meta-timeline__label-actions">
              <button
                type="button"
                class="meta-timeline__comment-btn"
                :class="rowCommentButtonClass(item.record.id)"
                :aria-label="`Open comments for ${displayLabel(item.record)}`"
                @click.stop="emit('open-comments', item.record.id)"
                @keydown="onRowCommentKeydown($event, item.record.id)"
              >
                <MetaCommentActionChip label="Comments" :state="rowCommentAffordance(item.record.id)" />
              </button>
              <button
                v-if="displayField"
                type="button"
                class="meta-timeline__field-comment-btn"
                :class="fieldCommentButtonClass(item.record.id)"
                :aria-label="`Open comments for ${displayField.name}`"
                @click.stop="emit('open-field-comments', { recordId: item.record.id, fieldId: displayField.id })"
                @keydown="onFieldCommentKeydown($event, item.record.id, displayField.id)"
              >
                <MetaCommentAffordance :state="fieldCommentAffordance(item.record.id)" />
              </button>
            </div>
          </div>
          <div class="meta-timeline__bar-area" @dragover.prevent="onDragOver(item.record.id)" @drop="onDrop(item, $event)">
            <div
              class="meta-timeline__bar"
              :class="{ 'meta-timeline__bar--draggable': canEdit }"
              :style="{ left: item.barLeft + '%', width: item.barWidth + '%' }"
              :title="`${item.startDate} → ${item.endDate}`"
              :draggable="canEdit"
              @dragstart="onDragStart(item, $event)"
              @dragend="onDragEnd"
            ></div>
          </div>
        </div>

        <div v-if="unscheduledRows.length" class="meta-timeline__unscheduled">
          <div class="meta-timeline__unscheduled-header">Unscheduled ({{ unscheduledRows.length }})</div>
          <div
            v-for="row in unscheduledRows"
            :key="row.id"
            class="meta-timeline__unscheduled-row"
            :class="{ 'meta-timeline__unscheduled-row--attachment': isAttachmentLabel }"
            tabindex="0"
            role="button"
            :aria-label="displayLabel(row)"
            @click="onSelect(row.id)"
            @keydown.enter="onSelect(row.id)"
          >
            <div class="meta-timeline__label-copy">
              <MetaAttachmentList
                v-if="isAttachmentLabel && displayField"
                :attachments="attachmentItems(row, displayField)"
                variant="compact"
                empty-label="No attachments"
              />
              <template v-else>{{ displayLabel(row) }}</template>
            </div>
            <div v-if="canComment" class="meta-timeline__label-actions">
              <button
                type="button"
                class="meta-timeline__comment-btn"
                :class="rowCommentButtonClass(row.id)"
                :aria-label="`Open comments for ${displayLabel(row)}`"
                @click.stop="emit('open-comments', row.id)"
                @keydown="onRowCommentKeydown($event, row.id)"
              >
                <MetaCommentActionChip label="Comments" :state="rowCommentAffordance(row.id)" />
              </button>
              <button
                v-if="displayField"
                type="button"
                class="meta-timeline__field-comment-btn"
                :class="fieldCommentButtonClass(row.id)"
                :aria-label="`Open comments for ${displayField.name}`"
                @click.stop="emit('open-field-comments', { recordId: row.id, fieldId: displayField.id })"
                @keydown="onFieldCommentKeydown($event, row.id, displayField.id)"
              >
                <MetaCommentAffordance :state="fieldCommentAffordance(row.id)" />
              </button>
            </div>
          </div>
        </div>

        <div v-if="!scheduledRows.length && !unscheduledRows.length" class="meta-timeline__empty">
          No records found
          <button v-if="canCreate" class="meta-timeline__placeholder-action" @click="onQuickCreate">Create first record</button>
        </div>
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { LinkedRecordSummary, MetaAttachment, MetaField, MetaRecord, MetaTimelineViewConfig, MultitableCommentPresenceSummary } from '../types'
import { resolveTimelineViewConfig } from '../utils/view-config'
import { formatFieldDisplay } from '../utils/field-display'
import MetaAttachmentList from './MetaAttachmentList.vue'
import MetaCommentActionChip from './MetaCommentActionChip.vue'
import MetaCommentAffordance from './MetaCommentAffordance.vue'
import {
  handleCommentAffordanceKeydown,
  resolveCommentAffordanceStateClass,
  resolveFieldCommentAffordance,
  resolveRecordCommentAffordance,
} from '../utils/comment-affordance'

const props = defineProps<{
  rows: MetaRecord[]
  fields: MetaField[]
  loading: boolean
  canCreate?: boolean
  canEdit?: boolean
  canComment?: boolean
  viewConfig?: Record<string, unknown> | null
  linkSummaries?: Record<string, Record<string, LinkedRecordSummary[]>>
  attachmentSummaries?: Record<string, Record<string, MetaAttachment[]>>
  commentPresence?: Record<string, MultitableCommentPresenceSummary | undefined>
}>()

const emit = defineEmits<{
  (e: 'select-record', recordId: string): void
  (e: 'open-comments', recordId: string): void
  (e: 'open-field-comments', payload: { recordId: string; fieldId: string }): void
  (e: 'create-record', data: Record<string, unknown>): void
  (e: 'update-view-config', input: { config: Record<string, unknown> }): void
  (e: 'patch-dates', payload: {
    recordId: string
    version: number
    startFieldId: string
    endFieldId: string
    startValue: string
    endValue: string
  }): void
}>()

const startFieldId = ref('')
const endFieldId = ref('')
const labelFieldId = ref('')
const zoom = ref<'day' | 'week' | 'month'>('week')
const pendingConfigKey = ref<string | null>(null)
const selectedRecordId = ref<string | null>(null)
const draggingRecordId = ref<string | null>(null)
const dragState = ref<{
  recordId: string
  version: number
  startMs: number
  endMs: number
} | null>(null)

const timelineConfig = computed<Required<MetaTimelineViewConfig>>(() =>
  resolveTimelineViewConfig(props.fields, props.viewConfig),
)

function normalizeTimelineConfig(config?: Partial<Required<MetaTimelineViewConfig>>) {
  return {
    startFieldId: config?.startFieldId ?? null,
    endFieldId: config?.endFieldId ?? null,
    labelFieldId: config?.labelFieldId ?? null,
    zoom: (config?.zoom ?? 'week') as 'day' | 'week' | 'month',
  }
}

watch(
  timelineConfig,
  (config) => {
    const normalized = normalizeTimelineConfig(config)
    const configKey = JSON.stringify(normalized)
    if (pendingConfigKey.value && pendingConfigKey.value !== configKey) return
    startFieldId.value = normalized.startFieldId ?? ''
    endFieldId.value = normalized.endFieldId ?? ''
    labelFieldId.value = normalized.labelFieldId ?? ''
    zoom.value = normalized.zoom
    if (pendingConfigKey.value === configKey) pendingConfigKey.value = null
  },
  { immediate: true },
)

const dateFields = computed(() => props.fields.filter((f) => f.type === 'date'))
const labelFields = computed(() => props.fields)

const displayField = computed(() =>
  props.fields.find((field) => field.id === labelFieldId.value)
    ?? props.fields.find((f) => f.type === 'string')
    ?? props.fields[0]
    ?? null,
)
const isAttachmentLabel = computed(() => displayField.value?.type === 'attachment')

const zoomLabel = computed(() => {
  if (zoom.value === 'day') return 'Day'
  if (zoom.value === 'month') return 'Month'
  return 'Week'
})

const labelFieldSummary = computed(() => {
  if (!labelFieldId.value) return 'Label: auto'
  const field = props.fields.find((item) => item.id === labelFieldId.value)
  return field ? `Label: ${field.name}` : 'Label: custom'
})

const labelFieldHint = computed(() => {
  if (!labelFieldId.value) {
    const field = displayField.value
    return field ? `Auto uses ${field.name} when available.` : 'Auto falls back to record id.'
  }
  return 'Timeline labels use this field across rows and unscheduled items.'
})

function rowCommentAffordance(recordId: string) {
  return resolveRecordCommentAffordance(props.commentPresence?.[recordId])
}

function fieldCommentAffordance(recordId: string) {
  if (!displayField.value) return resolveFieldCommentAffordance(null, '')
  return resolveFieldCommentAffordance(props.commentPresence?.[recordId], displayField.value.id)
}

function rowCommentButtonClass(recordId: string): string {
  return resolveCommentAffordanceStateClass('meta-timeline__comment-btn', rowCommentAffordance(recordId))
}

function fieldCommentButtonClass(recordId: string): string {
  return resolveCommentAffordanceStateClass('meta-timeline__field-comment-btn', fieldCommentAffordance(recordId))
}

function onRowCommentKeydown(event: KeyboardEvent, recordId: string) {
  handleCommentAffordanceKeydown(event, () => emit('open-comments', recordId))
}

function onFieldCommentKeydown(event: KeyboardEvent, recordId: string, fieldId: string) {
  handleCommentAffordanceKeydown(event, () => emit('open-field-comments', { recordId, fieldId }))
}

function displayLabel(record: MetaRecord): string {
  if (!displayField.value) return record.id
  const label = formatFieldDisplay({
    field: displayField.value,
    value: record.data[displayField.value.id],
    linkSummaries: props.linkSummaries?.[record.id]?.[displayField.value.id],
    attachmentSummaries: props.attachmentSummaries?.[record.id]?.[displayField.value.id],
  })
  return label === '—' ? record.id : label
}

function attachmentIds(record: MetaRecord, field: MetaField): string[] {
  const rawValue = record.data[field.id]
  if (Array.isArray(rawValue)) return rawValue.map(String)
  if (rawValue) return [String(rawValue)]
  return []
}

function attachmentItems(record: MetaRecord, field: MetaField): MetaAttachment[] {
  const summaryById = new Map((props.attachmentSummaries?.[record.id]?.[field.id] ?? []).map((attachment) => [attachment.id, attachment]))
  return attachmentIds(record, field).map((id) => summaryById.get(id) ?? ({
    id,
    filename: id,
    mimeType: 'application/octet-stream',
    size: 0,
    url: '',
    thumbnailUrl: null,
    uploadedAt: '',
  }))
}

function parseDate(val: unknown): Date | null {
  if (!val) return null
  const d = new Date(String(val))
  return isNaN(d.getTime()) ? null : d
}

function emitConfigUpdate(next: Partial<Required<MetaTimelineViewConfig>>) {
  const normalized = normalizeTimelineConfig({
    startFieldId: startFieldId.value || null,
    endFieldId: endFieldId.value || null,
    labelFieldId: labelFieldId.value || null,
    zoom: zoom.value,
    ...next,
  })
  pendingConfigKey.value = JSON.stringify(normalized)
  emit('update-view-config', {
    config: normalized,
  })
}

function onStartFieldChange(event: Event) {
  const nextStartFieldId = ((event.target as HTMLSelectElement).value || null)
  startFieldId.value = nextStartFieldId ?? ''
  emitConfigUpdate({ startFieldId: nextStartFieldId })
}

function onEndFieldChange(event: Event) {
  const nextEndFieldId = ((event.target as HTMLSelectElement).value || null)
  endFieldId.value = nextEndFieldId ?? ''
  emitConfigUpdate({ endFieldId: nextEndFieldId })
}

function onLabelFieldChange(event: Event) {
  const nextLabelFieldId = ((event.target as HTMLSelectElement).value || null)
  labelFieldId.value = nextLabelFieldId ?? ''
  emitConfigUpdate({ labelFieldId: nextLabelFieldId })
}

function onZoomChange(event: Event) {
  const nextZoom = (event.target as HTMLSelectElement).value as 'day' | 'week' | 'month'
  zoom.value = nextZoom
  emitConfigUpdate({ zoom: nextZoom })
}

function todayIsoDate(): string {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  return date.toISOString().slice(0, 10)
}

function onQuickCreate() {
  const seedDate = todayIsoDate()
  const data: Record<string, unknown> = {}
  if (startFieldId.value) data[startFieldId.value] = seedDate
  if (endFieldId.value) data[endFieldId.value] = seedDate
  emit('create-record', data)
}

interface ScheduledItem {
  record: MetaRecord
  startDate: string
  endDate: string
  barLeft: number
  barWidth: number
}

const timeRange = computed(() => {
  let minDate = Infinity
  let maxDate = -Infinity
  for (const row of props.rows) {
    const s = parseDate(row.data[startFieldId.value])
    const e = parseDate(row.data[endFieldId.value])
    if (s) { minDate = Math.min(minDate, s.getTime()); maxDate = Math.max(maxDate, s.getTime()) }
    if (e) { minDate = Math.min(minDate, e.getTime()); maxDate = Math.max(maxDate, e.getTime()) }
  }
  if (minDate === Infinity) return { min: Date.now(), max: Date.now() + 86400000 * 30 }
  const pad = (maxDate - minDate) * 0.05 || 86400000
  return { min: minDate - pad, max: maxDate + pad }
})

const scheduledRows = computed<ScheduledItem[]>(() => {
  if (!startFieldId.value || !endFieldId.value) return []
  const { min, max } = timeRange.value
  const range = max - min || 1
  return props.rows
    .filter((row) => parseDate(row.data[startFieldId.value]) && parseDate(row.data[endFieldId.value]))
    .map((record) => {
      const s = parseDate(record.data[startFieldId.value])!
      const e = parseDate(record.data[endFieldId.value])!
      const barLeft = ((s.getTime() - min) / range) * 100
      const barWidth = Math.max(1, ((e.getTime() - s.getTime()) / range) * 100)
      return {
        record,
        startDate: s.toISOString().slice(0, 10),
        endDate: e.toISOString().slice(0, 10),
        barLeft: Math.max(0, barLeft),
        barWidth: Math.min(100 - Math.max(0, barLeft), barWidth),
      }
    })
})

const unscheduledRows = computed(() => {
  if (!startFieldId.value || !endFieldId.value) return []
  return props.rows.filter(
    (row) => !parseDate(row.data[startFieldId.value]) || !parseDate(row.data[endFieldId.value]),
  )
})

const axisTicks = computed(() => {
  const { min, max } = timeRange.value
  const range = max - min || 1
  const ticks: Array<{ key: string; label: string; left: number }> = []
  const zoomMs = zoom.value === 'day' ? 86400000 : zoom.value === 'week' ? 86400000 * 7 : 86400000 * 30
  let t = min
  while (t <= max) {
    const d = new Date(t)
    const label = zoom.value === 'month'
      ? d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' })
      : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    ticks.push({
      key: String(t),
      label,
      left: ((t - min) / range) * 100,
    })
    t += zoomMs
  }
  return ticks
})

function onSelect(recordId: string) {
  selectedRecordId.value = recordId
  emit('select-record', recordId)
}

function snapToIsoDate(timestamp: number): string {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.toISOString().slice(0, 10)
}

function onDragStart(item: ScheduledItem, event: DragEvent) {
  if (!props.canEdit) {
    event.preventDefault()
    return
  }
  draggingRecordId.value = item.record.id
  dragState.value = {
    recordId: item.record.id,
    version: item.record.version,
    startMs: new Date(`${item.startDate}T00:00:00`).getTime(),
    endMs: new Date(`${item.endDate}T00:00:00`).getTime(),
  }
  event.dataTransfer?.setData('text/plain', item.record.id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onDragOver(recordId: string) {
  if (!props.canEdit || !dragState.value) return
  draggingRecordId.value = recordId
}

function onDrop(item: ScheduledItem, event: DragEvent) {
  if (!props.canEdit || !dragState.value || !startFieldId.value || !endFieldId.value) return
  const barArea = event.currentTarget as HTMLDivElement | null
  if (!barArea) return
  const rect = barArea.getBoundingClientRect()
  if (rect.width <= 0) return
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
  const { min, max } = timeRange.value
  const range = max - min || 1
  const nextStartMs = min + ratio * range
  const durationMs = Math.max(0, dragState.value.endMs - dragState.value.startMs)
  emit('patch-dates', {
    recordId: dragState.value.recordId,
    version: dragState.value.version,
    startFieldId: startFieldId.value,
    endFieldId: endFieldId.value,
    startValue: snapToIsoDate(nextStartMs),
    endValue: snapToIsoDate(nextStartMs + durationMs),
  })
  onDragEnd()
}

function onDragEnd() {
  draggingRecordId.value = null
  dragState.value = null
}
</script>

<style scoped>
.meta-timeline { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: auto; padding: 8px; }
.meta-timeline__loading { text-align: center; padding: 32px; color: #999; }
.meta-timeline__config { display: flex; gap: 16px; padding: 8px 0 12px; flex-wrap: wrap; }
.meta-timeline__config-label { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: #666; }
.meta-timeline__config-select { padding: 4px 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; }
.meta-timeline__config-hint { font-size: 11px; color: #999; line-height: 1.3; max-width: 200px; }
.meta-timeline__create-btn { align-self: flex-end; padding: 6px 12px; border: 1px solid #c7ddff; border-radius: 6px; background: #ecf5ff; color: #2563eb; font-size: 12px; cursor: pointer; }
.meta-timeline__create-btn:hover { background: #dbeafe; }
.meta-timeline__placeholder { text-align: center; padding: 32px; color: #999; font-size: 13px; display: flex; flex-direction: column; align-items: center; gap: 12px; }
.meta-timeline__placeholder-action { padding: 6px 12px; border: 1px solid #c7ddff; border-radius: 6px; background: #ecf5ff; color: #2563eb; font-size: 12px; cursor: pointer; }
.meta-timeline__header { display: flex; align-items: flex-end; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; height: 40px; }
.meta-timeline__label-col { width: 180px; min-width: 180px; font-size: 12px; font-weight: 600; color: #666; padding: 0 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.meta-timeline__label-col--attachment { white-space: normal; overflow: visible; text-overflow: initial; }
.meta-timeline__label-copy { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; }
.meta-timeline__label-actions { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; }
.meta-timeline__comment-btn { display: inline-flex; align-items: center; justify-content: center; min-height: 28px; padding: 2px 8px; border: 1px solid #d8e1ee; border-radius: 999px; background: #fff; cursor: pointer; color: #64748b; }
.meta-timeline__comment-btn:hover { border-color: #93c5fd; background: #eff6ff; color: #2563eb; }
.meta-timeline__comment-btn--active { border-color: #f59e0b; background: #fff7ed; color: #b45309; }
.meta-timeline__comment-btn--idle { border-color: #d8e1ee; background: #fff; color: #64748b; }
.meta-timeline__field-comment-btn { display: inline-flex; align-items: center; justify-content: center; min-width: 24px; height: 22px; padding: 0 5px; border: 1px solid #d8e1ee; border-radius: 999px; background: #fff; cursor: pointer; color: #64748b; }
.meta-timeline__field-comment-btn:hover { border-color: #93c5fd; background: #eff6ff; color: #2563eb; }
.meta-timeline__field-comment-btn--active { border-color: #f59e0b; background: #fff7ed; color: #b45309; }
.meta-timeline__field-comment-btn--idle { border-color: #d8e1ee; background: #fff; color: #64748b; }
.meta-timeline__label-col--attachment :deep(.meta-attachment-list__items) { gap: 4px; }
.meta-timeline__label-col--attachment :deep(.meta-attachment-list__card) { border-color: #bfdbfe; background: #fff; }
.meta-timeline__header-meta { font-size: 10px; font-weight: 400; color: #94a3b8; }
.meta-timeline__axis { flex: 1; position: relative; height: 28px; }
.meta-timeline__zoom-badge { position: absolute; right: 0; top: -2px; font-size: 10px; color: #64748b; }
.meta-timeline__tick { position: absolute; font-size: 10px; color: #999; transform: translateX(-50%); white-space: nowrap; top: 12px; }
.meta-timeline__row { display: flex; align-items: center; min-height: 36px; padding: 4px 0; border-bottom: 1px solid #f0f0f0; cursor: pointer; outline: none; }
.meta-timeline__row:hover { background: #f5f7fa; }
.meta-timeline__row--selected { background: #ecf5ff; }
.meta-timeline__row--dragging { opacity: 0.72; }
.meta-timeline__row:focus-visible { outline: 2px solid #409eff; outline-offset: -2px; }
.meta-timeline__bar-area { flex: 1; position: relative; height: 24px; }
.meta-timeline__bar { position: absolute; top: 4px; height: 16px; background: #409eff; border-radius: 3px; min-width: 4px; }
.meta-timeline__bar--draggable { cursor: grab; }
.meta-timeline__bar--draggable:active { cursor: grabbing; }
.meta-timeline__unscheduled { margin-top: 12px; border-top: 1px solid #e5e7eb; padding-top: 8px; }
.meta-timeline__unscheduled-header { font-size: 12px; font-weight: 600; color: #999; margin-bottom: 4px; }
.meta-timeline__unscheduled-row { padding: 4px 8px; font-size: 12px; color: #666; cursor: pointer; border-radius: 3px; outline: none; }
.meta-timeline__unscheduled-row--attachment :deep(.meta-attachment-list__items) { gap: 4px; }
.meta-timeline__unscheduled-row--attachment :deep(.meta-attachment-list__card) { border-color: #bfdbfe; background: #fff; }
.meta-timeline__unscheduled-row:hover { background: #f5f7fa; }
.meta-timeline__unscheduled-row:focus-visible { outline: 2px solid #409eff; outline-offset: -2px; }
.meta-timeline__empty { text-align: center; padding: 32px; color: #999; font-size: 13px; display: flex; flex-direction: column; align-items: center; gap: 12px; }
</style>
