<template>
  <div class="meta-gantt" role="region" aria-label="Gantt view">
    <div v-if="loading" class="meta-gantt__loading">Loading...</div>
    <template v-else>
      <div class="meta-gantt__toolbar">
        <label class="meta-gantt__control">
          Start
          <select :value="startFieldId" @change="onConfigChange('startFieldId', ($event.target as HTMLSelectElement).value || null)">
            <option value="">select</option>
            <option v-for="field in dateFields" :key="field.id" :value="field.id">{{ field.name }}</option>
          </select>
        </label>
        <label class="meta-gantt__control">
          End
          <select :value="endFieldId" @change="onConfigChange('endFieldId', ($event.target as HTMLSelectElement).value || null)">
            <option value="">select</option>
            <option v-for="field in dateFields" :key="field.id" :value="field.id">{{ field.name }}</option>
          </select>
        </label>
        <label class="meta-gantt__control">
          Title
          <select :value="titleFieldId" @change="onConfigChange('titleFieldId', ($event.target as HTMLSelectElement).value || null)">
            <option value="">auto</option>
            <option v-for="field in titleFields" :key="field.id" :value="field.id">{{ field.name }}</option>
          </select>
        </label>
        <label class="meta-gantt__control">
          Progress
          <select :value="progressFieldId" @change="onConfigChange('progressFieldId', ($event.target as HTMLSelectElement).value || null)">
            <option value="">none</option>
            <option v-for="field in numericFields" :key="field.id" :value="field.id">{{ field.name }}</option>
          </select>
        </label>
        <label class="meta-gantt__control">
          Group
          <select :value="groupFieldId" @change="onConfigChange('groupFieldId', ($event.target as HTMLSelectElement).value || null)">
            <option value="">none</option>
            <option v-for="field in groupableFields" :key="field.id" :value="field.id">{{ field.name }}</option>
          </select>
        </label>
        <label class="meta-gantt__control">
          Dependencies
          <select :value="dependencyFieldId" @change="onConfigChange('dependencyFieldId', ($event.target as HTMLSelectElement).value || null)">
            <option value="">none</option>
            <option v-for="field in dependencyFields" :key="field.id" :value="field.id">{{ field.name }}</option>
          </select>
        </label>
        <label class="meta-gantt__control">
          Zoom
          <select :value="zoom" @change="onConfigChange('zoom', ($event.target as HTMLSelectElement).value)">
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
          </select>
        </label>
        <button v-if="canCreate" class="meta-gantt__create" @click="onQuickCreate">+ Add task</button>
      </div>

      <div v-if="!startFieldId || !endFieldId" class="meta-gantt__placeholder">
        Select start and end date fields to display Gantt tasks.
      </div>

      <template v-else>
        <div class="meta-gantt__head">
          <div class="meta-gantt__task-col">Task</div>
          <div class="meta-gantt__axis">
            <span v-for="tick in axisTicks" :key="tick.key" class="meta-gantt__tick" :style="{ left: tick.left + '%' }">
              {{ tick.label }}
            </span>
          </div>
        </div>

        <div v-for="section in groupedSections" :key="section.key" class="meta-gantt__section">
          <div v-if="groupFieldId" class="meta-gantt__group">{{ section.label }}</div>
          <button
            v-for="task in section.items"
            :key="task.record.id"
            class="meta-gantt__row"
            :class="{ 'meta-gantt__row--selected': task.record.id === selectedRecordId, 'meta-gantt__row--resizing': task.record.id === resizingRecordId }"
            @click="selectRecord(task.record.id)"
          >
            <span class="meta-gantt__task-col">
              <strong>{{ displayTitle(task.record) }}</strong>
              <small>{{ displayStartDate(task) }} to {{ displayEndDate(task) }}</small>
            </span>
            <span class="meta-gantt__bar-area">
              <span
                v-for="dependency in dependencyLinksFor(task)"
                :key="dependency.id"
                class="meta-gantt__dependency-arrow"
                :class="{ 'meta-gantt__dependency-arrow--backward': dependency.backward }"
                :style="{ left: dependency.left + '%', width: dependency.width + '%' }"
                :title="dependency.label"
                aria-hidden="true"
              ></span>
              <span
                class="meta-gantt__bar"
                :class="{ 'meta-gantt__bar--resizable': canResizeTasks }"
                :style="barStyle(task)"
                :title="`${displayStartDate(task)} → ${displayEndDate(task)}`"
              >
                <span
                  v-if="canResizeTasks"
                  class="meta-gantt__resize-handle meta-gantt__resize-handle--start"
                  role="separator"
                  aria-orientation="vertical"
                  :aria-label="`Resize start for ${displayTitle(task.record)}`"
                  @click.stop
                  @mousedown.stop.prevent="onResizeStart(task, 'start', $event)"
                ></span>
                <span class="meta-gantt__bar-progress" :style="{ width: task.progress + '%' }"></span>
                <span
                  v-if="canResizeTasks"
                  class="meta-gantt__resize-handle meta-gantt__resize-handle--end"
                  role="separator"
                  aria-orientation="vertical"
                  :aria-label="`Resize end for ${displayTitle(task.record)}`"
                  @click.stop
                  @mousedown.stop.prevent="onResizeStart(task, 'end', $event)"
                ></span>
              </span>
            </span>
          </button>
        </div>

        <div v-if="unscheduledRows.length" class="meta-gantt__unscheduled">
          <strong>Unscheduled ({{ unscheduledRows.length }})</strong>
          <button
            v-for="row in unscheduledRows"
            :key="row.id"
            class="meta-gantt__unscheduled-row"
            @click="selectRecord(row.id)"
          >
            {{ displayTitle(row) }}
          </button>
        </div>

        <div v-if="!scheduledTasks.length && !unscheduledRows.length" class="meta-gantt__placeholder">
          No records found.
        </div>
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { LinkedRecordSummary, MetaAttachment, MetaField, MetaGanttViewConfig, MetaRecord } from '../types'
import { formatFieldDisplay } from '../utils/field-display'
import { resolveGanttViewConfig } from '../utils/view-config'

const props = defineProps<{
  rows: MetaRecord[]
  fields: MetaField[]
  loading: boolean
  canCreate?: boolean
  canEdit?: boolean
  viewConfig?: Record<string, unknown> | null
  groupInfo?: Record<string, unknown> | null
  linkSummaries?: Record<string, Record<string, LinkedRecordSummary[]>>
  attachmentSummaries?: Record<string, Record<string, MetaAttachment[]>>
}>()

const emit = defineEmits<{
  (e: 'select-record', recordId: string): void
  (e: 'create-record', data: Record<string, unknown>): void
  (e: 'update-view-config', input: { config: Record<string, unknown>; groupInfo?: Record<string, unknown> }): void
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
const titleFieldId = ref('')
const progressFieldId = ref('')
const groupFieldId = ref('')
const dependencyFieldId = ref('')
const zoom = ref<'day' | 'week' | 'month'>('week')
const selectedRecordId = ref<string | null>(null)
const pendingConfigKey = ref<string | null>(null)
const resizingRecordId = ref<string | null>(null)

type ResizeEdge = 'start' | 'end'

const resizeState = ref<{
  recordId: string
  version: number
  edge: ResizeEdge
  axisLeft: number
  axisWidth: number
  originalStartMs: number
  originalEndMs: number
  nextStartMs: number
  nextEndMs: number
} | null>(null)

const resolvedConfig = computed<Required<MetaGanttViewConfig>>(() =>
  resolveGanttViewConfig(props.fields, props.viewConfig, props.groupInfo),
)

watch(
  resolvedConfig,
  (config) => {
    const key = JSON.stringify(config)
    if (pendingConfigKey.value && pendingConfigKey.value !== key) return
    startFieldId.value = config.startFieldId ?? ''
    endFieldId.value = config.endFieldId ?? ''
    titleFieldId.value = config.titleFieldId ?? ''
    progressFieldId.value = config.progressFieldId ?? ''
    groupFieldId.value = config.groupFieldId ?? ''
    dependencyFieldId.value = config.dependencyFieldId ?? ''
    zoom.value = config.zoom
    if (pendingConfigKey.value === key) pendingConfigKey.value = null
  },
  { immediate: true },
)

const dateFields = computed(() => props.fields.filter((field) => field.type === 'date' || field.type === 'dateTime'))
const titleFields = computed(() => props.fields)
const numericFields = computed(() => props.fields.filter((field) => ['number', 'percent', 'currency', 'rating'].includes(field.type)))
const groupableFields = computed(() => props.fields.filter((field) => ['select', 'string', 'boolean', 'date', 'dateTime'].includes(field.type)))
const dependencyFields = computed(() => props.fields.filter((field) => field.type === 'link'))
const canResizeTasks = computed(() => Boolean(props.canEdit && startFieldId.value && endFieldId.value && startFieldId.value !== endFieldId.value))

function parseDate(value: unknown): Date | null {
  if (!value) return null
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date
}

function displayTitle(record: MetaRecord): string {
  const field = props.fields.find((item) => item.id === titleFieldId.value)
    ?? props.fields.find((item) => item.type === 'string')
    ?? props.fields[0]
    ?? null
  if (!field) return record.id
  const value = formatFieldDisplay({
    field,
    value: record.data[field.id],
    linkSummaries: props.linkSummaries?.[record.id]?.[field.id],
    attachmentSummaries: props.attachmentSummaries?.[record.id]?.[field.id],
  })
  return value === '-' || value === '\u2014' ? record.id : value
}

function progressValue(record: MetaRecord): number {
  if (!progressFieldId.value) return 0
  const raw = record.data[progressFieldId.value]
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value > 0 && value <= 1 ? value * 100 : value))
}

const timeRange = computed(() => {
  let min = Infinity
  let max = -Infinity
  for (const row of props.rows) {
    const start = parseDate(row.data[startFieldId.value])
    const end = parseDate(row.data[endFieldId.value])
    if (start) { min = Math.min(min, start.getTime()); max = Math.max(max, start.getTime()) }
    if (end) { min = Math.min(min, end.getTime()); max = Math.max(max, end.getTime()) }
  }
  if (min === Infinity) return { min: Date.now(), max: Date.now() + 86400000 * 30 }
  const pad = (max - min) * 0.08 || 86400000
  const boundedPad = Math.max(pad, 86400000)
  return { min: min - boundedPad, max: max + boundedPad }
})

type ScheduledTask = {
  record: MetaRecord
  startDate: string
  endDate: string
  startMs: number
  endMs: number
  left: number
  width: number
  progress: number
  dependencyIds: string[]
}

const scheduledTasks = computed<ScheduledTask[]>(() => {
  if (!startFieldId.value || !endFieldId.value) return []
  const { min, max } = timeRange.value
  const range = max - min || 1
  return props.rows
    .map((record) => {
      const start = parseDate(record.data[startFieldId.value])
      const end = parseDate(record.data[endFieldId.value])
      if (!start || !end) return null
      const left = ((start.getTime() - min) / range) * 100
      const width = Math.max(1, ((end.getTime() - start.getTime()) / range) * 100)
      return {
        record,
        startDate: start.toISOString().slice(0, 10),
        endDate: end.toISOString().slice(0, 10),
        startMs: start.getTime(),
        endMs: end.getTime(),
        left: Math.max(0, left),
        width: Math.min(100 - Math.max(0, left), width),
        progress: progressValue(record),
        dependencyIds: dependencyIdsFor(record),
      }
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
})

const unscheduledRows = computed(() => {
  if (!startFieldId.value || !endFieldId.value) return props.rows
  return props.rows.filter((row) => !parseDate(row.data[startFieldId.value]) || !parseDate(row.data[endFieldId.value]))
})

const groupedSections = computed(() => {
  const buckets = new Map<string, { key: string; label: string; items: typeof scheduledTasks.value }>()
  for (const item of scheduledTasks.value) {
    const raw = groupFieldId.value ? item.record.data[groupFieldId.value] : 'All tasks'
    const key = raw === null || raw === undefined || raw === '' ? 'ungrouped' : String(raw)
    const label = key === 'ungrouped' ? 'Ungrouped' : key
    if (!buckets.has(key)) buckets.set(key, { key, label, items: [] })
    buckets.get(key)?.items.push(item)
  }
  return [...buckets.values()]
})

const scheduledTaskById = computed(() => new Map(scheduledTasks.value.map((task) => [task.record.id, task])))

const dependencyLinksByRecordId = computed(() => {
  const byId = scheduledTaskById.value
  const links = new Map<string, Array<{ id: string; left: number; width: number; backward: boolean; label: string }>>()
  for (const task of scheduledTasks.value) {
    const taskLinks = task.dependencyIds
      .map((dependencyId) => {
        const dependency = byId.get(dependencyId)
        if (!dependency || dependency.record.id === task.record.id) return null
        const dependencyEnd = dependency.left + dependency.width
        const forward = dependencyEnd <= task.left
        const left = Math.max(0, Math.min(forward ? dependencyEnd : task.left, forward ? task.left : dependencyEnd))
        const right = Math.min(100, Math.max(forward ? dependencyEnd : task.left, forward ? task.left : dependencyEnd))
        return {
          id: dependency.record.id,
          left,
          width: Math.max(1, right - left),
          backward: !forward,
          label: `${displayTitle(dependency.record)} \u2192 ${displayTitle(task.record)}`,
        }
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
    if (taskLinks.length) links.set(task.record.id, taskLinks)
  }
  return links
})

function normalizeDependencyIds(value: unknown): string[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,;\n]/)
      : value === null || value === undefined || value === ''
        ? []
        : [value]
  return [...new Set(rawValues
    .map((item) => String(item).trim())
    .filter((item) => item.length > 0))]
}

function dependencyIdsFor(record: MetaRecord): string[] {
  if (!dependencyFieldId.value) return []
  return normalizeDependencyIds(record.data[dependencyFieldId.value])
}

function dependencyLinksFor(task: ScheduledTask) {
  return dependencyLinksByRecordId.value.get(task.record.id) ?? []
}

function activeTaskRange(task: ScheduledTask) {
  if (resizeState.value?.recordId === task.record.id) {
    return {
      startMs: resizeState.value.nextStartMs,
      endMs: resizeState.value.nextEndMs,
    }
  }
  return {
    startMs: task.startMs,
    endMs: task.endMs,
  }
}

function isoDateFromMs(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

function displayStartDate(task: ScheduledTask): string {
  return isoDateFromMs(activeTaskRange(task).startMs)
}

function displayEndDate(task: ScheduledTask): string {
  return isoDateFromMs(activeTaskRange(task).endMs)
}

function barStyle(task: ScheduledTask) {
  const { min, max } = timeRange.value
  const range = max - min || 1
  const taskRange = activeTaskRange(task)
  const left = ((taskRange.startMs - min) / range) * 100
  const width = Math.max(1, ((taskRange.endMs - taskRange.startMs) / range) * 100)
  const boundedLeft = Math.max(0, Math.min(100, left))
  return {
    left: boundedLeft + '%',
    width: Math.min(100 - boundedLeft, width) + '%',
  }
}

const axisTicks = computed(() => {
  const { min, max } = timeRange.value
  const range = max - min || 1
  const step = zoom.value === 'day' ? 86400000 : zoom.value === 'week' ? 86400000 * 7 : 86400000 * 30
  const ticks: Array<{ key: string; label: string; left: number }> = []
  for (let ts = min; ts <= max; ts += step) {
    const date = new Date(ts)
    ticks.push({
      key: String(ts),
      label: zoom.value === 'month'
        ? date.toLocaleDateString(undefined, { month: 'short', year: '2-digit' })
        : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      left: ((ts - min) / range) * 100,
    })
  }
  return ticks
})

function currentConfig(): Required<MetaGanttViewConfig> {
  return {
    startFieldId: startFieldId.value || null,
    endFieldId: endFieldId.value || null,
    titleFieldId: titleFieldId.value || null,
    progressFieldId: progressFieldId.value || null,
    groupFieldId: groupFieldId.value || null,
    dependencyFieldId: dependencyFieldId.value || null,
    zoom: zoom.value,
  }
}

function onConfigChange(key: keyof Required<MetaGanttViewConfig>, value: unknown) {
  const next = { ...currentConfig(), [key]: value } as Required<MetaGanttViewConfig>
  startFieldId.value = next.startFieldId ?? ''
  endFieldId.value = next.endFieldId ?? ''
  titleFieldId.value = next.titleFieldId ?? ''
  progressFieldId.value = next.progressFieldId ?? ''
  groupFieldId.value = next.groupFieldId ?? ''
  dependencyFieldId.value = next.dependencyFieldId ?? ''
  zoom.value = next.zoom
  pendingConfigKey.value = JSON.stringify(next)
  emit('update-view-config', {
    config: next,
    groupInfo: next.groupFieldId ? { fieldId: next.groupFieldId } : {},
  })
}

function selectRecord(recordId: string) {
  selectedRecordId.value = recordId
  emit('select-record', recordId)
}

function timestampFromClientX(clientX: number): number {
  if (!resizeState.value) return Date.now()
  const ratio = Math.max(-0.5, Math.min(1.5, (clientX - resizeState.value.axisLeft) / resizeState.value.axisWidth))
  const { min, max } = timeRange.value
  return min + ratio * (max - min || 1)
}

function onResizeStart(task: ScheduledTask, edge: ResizeEdge, event: MouseEvent) {
  if (!canResizeTasks.value) return
  const barArea = (event.currentTarget as HTMLElement | null)?.closest('.meta-gantt__bar-area') as HTMLElement | null
  const rect = barArea?.getBoundingClientRect()
  if (!rect || rect.width <= 0) return
  resizingRecordId.value = task.record.id
  resizeState.value = {
    recordId: task.record.id,
    version: task.record.version,
    edge,
    axisLeft: rect.left,
    axisWidth: rect.width,
    originalStartMs: task.startMs,
    originalEndMs: task.endMs,
    nextStartMs: task.startMs,
    nextEndMs: task.endMs,
  }
  window.addEventListener('mousemove', onResizeMove)
  window.addEventListener('mouseup', onResizeEnd)
}

function onResizeMove(event: MouseEvent) {
  if (!resizeState.value) return
  const nextMs = timestampFromClientX(event.clientX)
  if (resizeState.value.edge === 'start') {
    resizeState.value.nextStartMs = Math.min(nextMs, resizeState.value.nextEndMs)
  } else {
    resizeState.value.nextEndMs = Math.max(nextMs, resizeState.value.nextStartMs)
  }
}

function onResizeEnd() {
  const state = resizeState.value
  if (!state || !startFieldId.value || !endFieldId.value) {
    cleanupResize()
    return
  }
  const startValue = isoDateFromMs(state.nextStartMs)
  const endValue = isoDateFromMs(state.nextEndMs)
  if (startValue !== isoDateFromMs(state.originalStartMs) || endValue !== isoDateFromMs(state.originalEndMs)) {
    emit('patch-dates', {
      recordId: state.recordId,
      version: state.version,
      startFieldId: startFieldId.value,
      endFieldId: endFieldId.value,
      startValue,
      endValue,
    })
  }
  cleanupResize()
}

function cleanupResize() {
  window.removeEventListener('mousemove', onResizeMove)
  window.removeEventListener('mouseup', onResizeEnd)
  resizingRecordId.value = null
  resizeState.value = null
}

onBeforeUnmount(cleanupResize)

function onQuickCreate() {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const value = today.toISOString().slice(0, 10)
  const data: Record<string, unknown> = {}
  if (startFieldId.value) data[startFieldId.value] = value
  if (endFieldId.value) data[endFieldId.value] = value
  emit('create-record', data)
}
</script>

<style scoped>
.meta-gantt { display: flex; flex-direction: column; flex: 1; min-height: 0; background: #f8fafc; color: #334155; }
.meta-gantt__loading, .meta-gantt__placeholder { margin: 24px; padding: 28px; border: 1px dashed #cbd5e1; border-radius: 10px; background: #fff; color: #64748b; text-align: center; }
.meta-gantt__toolbar { display: flex; flex-wrap: wrap; gap: 10px; padding: 12px 16px; border-bottom: 1px solid #e2e8f0; background: #fff; }
.meta-gantt__control { display: flex; flex-direction: column; gap: 4px; min-width: 118px; font-size: 11px; color: #64748b; }
.meta-gantt__control select { padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 6px; background: #fff; color: #334155; }
.meta-gantt__create { align-self: end; padding: 7px 12px; border: 1px solid #2563eb; border-radius: 6px; background: #2563eb; color: #fff; cursor: pointer; }
.meta-gantt__head { display: grid; grid-template-columns: 260px 1fr; min-height: 40px; border-bottom: 1px solid #e2e8f0; background: #f1f5f9; }
.meta-gantt__task-col { padding: 8px 12px; border-right: 1px solid #e2e8f0; text-align: left; }
.meta-gantt__task-col strong, .meta-gantt__task-col small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-gantt__task-col small { margin-top: 2px; color: #64748b; font-size: 11px; }
.meta-gantt__axis { position: relative; min-height: 40px; overflow: hidden; }
.meta-gantt__tick { position: absolute; top: 10px; transform: translateX(-50%); font-size: 11px; color: #64748b; white-space: nowrap; }
.meta-gantt__section { display: flex; flex-direction: column; }
.meta-gantt__group { padding: 7px 12px; border-bottom: 1px solid #e2e8f0; background: #eef2ff; color: #3730a3; font-size: 12px; font-weight: 600; }
.meta-gantt__row { display: grid; grid-template-columns: 260px 1fr; min-height: 52px; border: 0; border-bottom: 1px solid #e2e8f0; background: #fff; color: inherit; cursor: pointer; }
.meta-gantt__row:hover, .meta-gantt__row--selected, .meta-gantt__row--resizing { background: #eff6ff; }
.meta-gantt__bar-area { position: relative; display: block; min-height: 40px; margin: 6px 16px; border-radius: 999px; background: linear-gradient(90deg, rgba(203,213,225,.28) 1px, transparent 1px); background-size: 8.333% 100%; }
.meta-gantt__bar { position: absolute; top: 12px; height: 16px; min-width: 6px; overflow: hidden; border-radius: 999px; background: #93c5fd; box-shadow: 0 4px 10px rgba(37,99,235,.18); z-index: 2; }
.meta-gantt__bar--resizable { cursor: ew-resize; }
.meta-gantt__bar-progress { display: block; height: 100%; border-radius: inherit; background: #2563eb; }
.meta-gantt__resize-handle { position: absolute; top: 0; bottom: 0; width: 10px; z-index: 3; cursor: ew-resize; background: rgba(15,23,42,.12); opacity: 0; transition: opacity .12s ease; }
.meta-gantt__bar:hover .meta-gantt__resize-handle, .meta-gantt__row--resizing .meta-gantt__resize-handle { opacity: 1; }
.meta-gantt__resize-handle--start { left: 0; border-radius: 999px 0 0 999px; }
.meta-gantt__resize-handle--end { right: 0; border-radius: 0 999px 999px 0; }
.meta-gantt__dependency-arrow { position: absolute; top: 20px; height: 0; border-top: 2px solid #f97316; z-index: 1; pointer-events: none; }
.meta-gantt__dependency-arrow::after { content: ''; position: absolute; right: -1px; top: -5px; border-style: solid; border-width: 5px 0 5px 7px; border-color: transparent transparent transparent #f97316; }
.meta-gantt__dependency-arrow--backward { border-top-style: dashed; opacity: 0.85; }
.meta-gantt__dependency-arrow--backward::after { left: -1px; right: auto; border-width: 5px 7px 5px 0; border-color: transparent #f97316 transparent transparent; }
.meta-gantt__unscheduled { margin: 16px; padding: 12px; border: 1px solid #e2e8f0; border-radius: 8px; background: #fff; }
.meta-gantt__unscheduled-row { display: block; width: 100%; margin-top: 6px; padding: 6px 8px; border: 1px solid #e2e8f0; border-radius: 6px; background: #f8fafc; text-align: left; cursor: pointer; }
</style>
