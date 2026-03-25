<template>
  <div class="meta-calendar">
    <div v-if="!dateField" class="meta-calendar__picker">
      <div class="meta-calendar__picker-icon">&#x1F4C5;</div>
      <p>Select a date field to use for the calendar:</p>
      <select class="meta-calendar__field-select" @change="onPickDateField($event)">
        <option value="">— Choose field —</option>
        <option v-for="f in dateFields" :key="f.id" :value="f.id">{{ f.name }}</option>
      </select>
    </div>

    <template v-else>
      <div class="meta-calendar__header">
        <button class="meta-calendar__nav-btn" @click="goPrevious">&lsaquo;</button>
        <span class="meta-calendar__title">{{ periodLabel }}</span>
        <button class="meta-calendar__nav-btn" @click="goNext">&rsaquo;</button>
        <button class="meta-calendar__today-btn" @click="goToday">Today</button>
        <button v-if="canCreate" class="meta-calendar__create-btn" @click="onQuickCreate">+ Add record</button>
        <label class="meta-calendar__mode-label">
          View
          <select class="meta-calendar__mode-select" :value="viewMode" @change="onViewModeChange">
            <option value="month">Month</option>
            <option value="week">Week</option>
            <option value="day">Day</option>
          </select>
        </label>
        <span class="meta-calendar__field-label">
          Field: <strong>{{ dateField.name }}</strong>
          <button v-if="dateField" class="meta-calendar__change-btn" @click="onResetDateField">Change</button>
        </span>
      </div>

      <template v-if="viewMode === 'month'">
        <div class="meta-calendar__weekdays">
          <div v-for="d in weekdays" :key="d" class="meta-calendar__weekday">{{ d }}</div>
        </div>

        <div class="meta-calendar__grid meta-calendar__grid--month">
          <div
            v-for="(cell, cellIdx) in monthCells"
            :key="cell.key"
            class="meta-calendar__cell"
            :class="{
              'meta-calendar__cell--outside': !cell.inMonth,
              'meta-calendar__cell--today': cell.isToday,
            }"
            :role="cell.inMonth ? 'button' : undefined"
            :tabindex="cell.inMonth ? 0 : -1"
            :aria-label="cellAriaLabel(cell)"
            :aria-disabled="!cell.inMonth ? 'true' : undefined"
            @click="canCreate && cell.inMonth && emit('create-record', buildCreateRecordData(cell.dateStr))"
            @keydown="onCellKeydown($event, cellIdx, monthCells)"
          >
            <div class="meta-calendar__day-num">{{ cell.day }}</div>
            <div class="meta-calendar__events">
              <div
                v-for="ev in cell.events"
                :key="ev.id"
                class="meta-calendar__event"
                @click.stop="emit('select-record', ev.id)"
              >
                {{ ev.title }}
              </div>
              <div v-if="cell.overflow > 0" class="meta-calendar__overflow">+{{ cell.overflow }} more</div>
            </div>
          </div>
        </div>
      </template>

      <template v-else-if="viewMode === 'week'">
        <div class="meta-calendar__weekdays">
          <div v-for="d in weekdays" :key="d" class="meta-calendar__weekday">{{ d }}</div>
        </div>

        <div class="meta-calendar__grid meta-calendar__grid--week">
          <div
            v-for="(cell, cellIdx) in weekCells"
            :key="cell.key"
            class="meta-calendar__cell meta-calendar__cell--week"
            :class="{
              'meta-calendar__cell--today': cell.isToday,
            }"
            role="button"
            tabindex="0"
            :aria-label="cellAriaLabel(cell)"
            @click="canCreate && emit('create-record', buildCreateRecordData(cell.dateStr))"
            @keydown="onCellKeydown($event, cellIdx, weekCells)"
          >
            <div class="meta-calendar__day-num">{{ cell.day }}</div>
            <div class="meta-calendar__events">
              <div
                v-for="ev in cell.events"
                :key="ev.id"
                class="meta-calendar__event"
                @click.stop="emit('select-record', ev.id)"
              >
                {{ ev.title }}
              </div>
              <div v-if="cell.overflow > 0" class="meta-calendar__overflow">+{{ cell.overflow }} more</div>
            </div>
          </div>
        </div>
      </template>

      <template v-else>
        <div class="meta-calendar__day-view">
          <div class="meta-calendar__day-panel">
            <div class="meta-calendar__day-heading">{{ activeDayLabel }}</div>
            <div class="meta-calendar__day-meta">{{ currentDayEvents.length }} event{{ currentDayEvents.length === 1 ? '' : 's' }}</div>
            <button
              v-if="canCreate"
              class="meta-calendar__day-create"
              @click="emit('create-record', buildCreateRecordData(activeDayStr))"
            >
              + New record
            </button>
          </div>
          <div class="meta-calendar__day-list">
            <div
              v-for="ev in currentDayEvents"
              :key="ev.id"
              class="meta-calendar__day-event"
              role="button"
              tabindex="0"
              @click="emit('select-record', ev.id)"
              @keydown.enter="emit('select-record', ev.id)"
            >
              {{ ev.title }}
            </div>
            <div v-if="!currentDayEvents.length" class="meta-calendar__empty-hint">No records on this day</div>
          </div>
        </div>
      </template>
    </template>

    <div v-if="loading" class="meta-calendar__loading">Loading...</div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { LinkedRecordSummary, MetaAttachment, MetaCalendarViewConfig, MetaField, MetaRecord } from '../types'
import { resolveCalendarViewConfig } from '../utils/view-config'
import { formatFieldDisplay } from '../utils/field-display'

const MAX_EVENTS_PER_CELL = 3

const props = defineProps<{
  rows: MetaRecord[]
  fields: MetaField[]
  loading: boolean
  canCreate?: boolean
  viewConfig?: Record<string, unknown> | null
  linkSummaries?: Record<string, Record<string, LinkedRecordSummary[]>>
  attachmentSummaries?: Record<string, Record<string, MetaAttachment[]>>
}>()

const emit = defineEmits<{
  (e: 'select-record', recordId: string): void
  (e: 'create-record', data: Record<string, unknown>): void
  (e: 'update-view-config', input: { config: Record<string, unknown> }): void
}>()

const dateFieldId = ref<string | null>(null)
const viewMode = ref<'month' | 'week' | 'day'>('month')
const viewDate = ref(new Date())
const pendingConfigKey = ref<string | null>(null)

const baseWeekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const calendarConfig = computed<Required<MetaCalendarViewConfig>>(() =>
  resolveCalendarViewConfig(props.fields, props.viewConfig),
)

function normalizeCalendarConfig(config?: Partial<Required<MetaCalendarViewConfig>>) {
  return {
    dateFieldId: config?.dateFieldId ?? null,
    endDateFieldId: config?.endDateFieldId ?? null,
    titleFieldId: config?.titleFieldId ?? null,
    defaultView: (config?.defaultView ?? 'month') as 'month' | 'week' | 'day',
    weekStartsOn: config?.weekStartsOn ?? 0,
  }
}

watch(
  calendarConfig,
  (config) => {
    const normalized = normalizeCalendarConfig(config)
    const configKey = JSON.stringify(normalized)
    if (pendingConfigKey.value && pendingConfigKey.value !== configKey) return
    dateFieldId.value = normalized.dateFieldId
    viewMode.value = normalized.defaultView
    if (pendingConfigKey.value === configKey) pendingConfigKey.value = null
  },
  { immediate: true },
)

const weekdays = computed(() => {
  const weekStartsOn = calendarConfig.value.weekStartsOn
  return [...baseWeekdays.slice(weekStartsOn), ...baseWeekdays.slice(0, weekStartsOn)]
})

const dateFields = computed(() =>
  props.fields.filter((f) => f.type === 'date' || f.type === 'string' || f.type === 'number'),
)

const dateField = computed(() =>
  dateFieldId.value ? props.fields.find((f) => f.id === dateFieldId.value) ?? null : null,
)

const activeDayStr = computed(() => fmt(viewDate.value.getFullYear(), viewDate.value.getMonth() + 1, viewDate.value.getDate()))

const titleField = computed(() =>
  props.fields.find((f) => f.id === calendarConfig.value.titleFieldId)
    ?? props.fields.find((f) => f.type === 'string' && f.id !== dateFieldId.value)
    ?? props.fields[0]
    ?? null,
)

// Build a map: dateStr -> events
const eventsByDate = computed(() => {
  const map: Record<string, Array<{ id: string; title: string }>> = {}
  if (!dateField.value) return map
  for (const row of props.rows) {
    const titleDisplay = titleField.value
      ? formatFieldDisplay({
        field: titleField.value,
        value: row.data[titleField.value.id],
        linkSummaries: props.linkSummaries?.[row.id]?.[titleField.value.id],
        attachmentSummaries: props.attachmentSummaries?.[row.id]?.[titleField.value.id],
      })
      : row.id
    const title = titleDisplay === '—' ? row.id : titleDisplay
    const startDate = normalizeDate(String(row.data[dateField.value.id] ?? ''))
    const endFieldId = calendarConfig.value.endDateFieldId
    const endDate = endFieldId ? normalizeDate(String(row.data[endFieldId] ?? '')) : null
    if (!startDate) continue
    const start = new Date(`${startDate}T00:00:00`)
    const end = new Date(`${(endDate ?? startDate)}T00:00:00`)
    if (isNaN(start.getTime()) || isNaN(end.getTime())) continue
    const safeEnd = end.getTime() >= start.getTime() ? end : start
    for (let cursor = new Date(start); cursor.getTime() <= safeEnd.getTime(); cursor.setDate(cursor.getDate() + 1)) {
      const dateStr = fmt(cursor.getFullYear(), cursor.getMonth() + 1, cursor.getDate())
      if (!map[dateStr]) map[dateStr] = []
      map[dateStr].push({ id: row.id, title })
    }
  }
  return map
})

interface CalendarCell {
  key: string
  day: number
  dateStr: string
  inMonth: boolean
  isToday: boolean
  events: Array<{ id: string; title: string }>
  overflow: number
}

function startOfWeek(date: Date): Date {
  const start = new Date(date)
  start.setHours(0, 0, 0, 0)
  const offset = (start.getDay() - calendarConfig.value.weekStartsOn + 7) % 7
  start.setDate(start.getDate() - offset)
  return start
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function buildCell(date: Date, inMonth: boolean): CalendarCell {
  const dateStr = fmt(date.getFullYear(), date.getMonth() + 1, date.getDate())
  const all = eventsByDate.value[dateStr] ?? []
  return {
    key: dateStr,
    day: date.getDate(),
    dateStr,
    inMonth,
    isToday: dateStr === todayStr.value,
    events: all.slice(0, MAX_EVENTS_PER_CELL),
    overflow: Math.max(0, all.length - MAX_EVENTS_PER_CELL),
  }
}

const todayStr = computed(() => {
  const today = new Date()
  return fmt(today.getFullYear(), today.getMonth() + 1, today.getDate())
})

const monthCells = computed<CalendarCell[]>(() => {
  const cells: CalendarCell[] = []
  const first = new Date(viewDate.value.getFullYear(), viewDate.value.getMonth(), 1)
  const startDay = (first.getDay() - calendarConfig.value.weekStartsOn + 7) % 7

  // Days from previous month
  const prevLast = new Date(viewDate.value.getFullYear(), viewDate.value.getMonth(), 0)
  for (let i = startDay - 1; i >= 0; i--) {
    const d = prevLast.getDate() - i
    cells.push(buildCell(new Date(prevLast.getFullYear(), prevLast.getMonth(), d), false))
  }

  // Days of current month
  const daysInMonth = new Date(viewDate.value.getFullYear(), viewDate.value.getMonth() + 1, 0).getDate()
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(buildCell(new Date(viewDate.value.getFullYear(), viewDate.value.getMonth(), d), true))
  }

  // Fill remaining to complete 6 rows (42 cells)
  const remaining = 42 - cells.length
  for (let d = 1; d <= remaining; d++) {
    cells.push(buildCell(new Date(viewDate.value.getFullYear(), viewDate.value.getMonth() + 1, d), false))
  }

  return cells
})

const weekCells = computed<CalendarCell[]>(() => {
  const start = startOfWeek(viewDate.value)
  return Array.from({ length: 7 }, (_, idx) => buildCell(addDays(start, idx), true))
})

const currentDayEvents = computed(() => eventsByDate.value[activeDayStr.value] ?? [])

const activeDayLabel = computed(() =>
  viewDate.value.toLocaleDateString('default', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }),
)

const periodLabel = computed(() => {
  if (viewMode.value === 'day') return activeDayLabel.value
  if (viewMode.value === 'week') {
    const start = startOfWeek(viewDate.value)
    const end = addDays(start, 6)
    return `${start.toLocaleDateString('default', { month: 'short', day: 'numeric' })} - ${end.toLocaleDateString('default', { month: 'short', day: 'numeric', year: 'numeric' })}`
  }
  return viewDate.value.toLocaleString('default', { month: 'long', year: 'numeric' })
})

function fmt(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function normalizeDate(raw: string): string | null {
  // Accept YYYY-MM-DD, YYYY/MM/DD, or parseable date strings
  const m = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)
  if (m) return fmt(Number(m[1]), Number(m[2]), Number(m[3]))
  const d = new Date(raw)
  if (!isNaN(d.getTime())) return fmt(d.getFullYear(), d.getMonth() + 1, d.getDate())
  return null
}

function onPickDateField(e: Event) {
  const val = (e.target as HTMLSelectElement).value
  const nextDateFieldId = val || null
  emitConfigUpdate({ dateFieldId: nextDateFieldId })
}

function onResetDateField() {
  emitConfigUpdate({ dateFieldId: null })
}

function emitConfigUpdate(next: Partial<Required<MetaCalendarViewConfig>>) {
  const normalized = normalizeCalendarConfig({
    ...calendarConfig.value,
    dateFieldId: dateFieldId.value,
    defaultView: viewMode.value,
    ...next,
  })
  dateFieldId.value = normalized.dateFieldId
  viewMode.value = normalized.defaultView
  pendingConfigKey.value = JSON.stringify(normalized)
  emit('update-view-config', {
    config: normalized,
  })
}

function onViewModeChange(e: Event) {
  const nextMode = (e.target as HTMLSelectElement).value as 'month' | 'week' | 'day'
  emitConfigUpdate({ defaultView: nextMode })
}

function buildCreateRecordData(dateStr: string): Record<string, unknown> {
  if (!dateField.value) return {}
  const data: Record<string, unknown> = {
    [dateField.value.id]: dateStr,
  }
  const endFieldId = calendarConfig.value.endDateFieldId
  if (endFieldId) data[endFieldId] = dateStr
  return data
}

function onQuickCreate() {
  emit('create-record', buildCreateRecordData(activeDayStr.value))
}

function goPrevious() {
  if (viewMode.value === 'day') {
    viewDate.value = addDays(viewDate.value, -1)
    return
  }
  if (viewMode.value === 'week') {
    viewDate.value = addDays(viewDate.value, -7)
    return
  }
  viewDate.value = new Date(viewDate.value.getFullYear(), viewDate.value.getMonth() - 1, 1)
}

function goNext() {
  if (viewMode.value === 'day') {
    viewDate.value = addDays(viewDate.value, 1)
    return
  }
  if (viewMode.value === 'week') {
    viewDate.value = addDays(viewDate.value, 7)
    return
  }
  viewDate.value = new Date(viewDate.value.getFullYear(), viewDate.value.getMonth() + 1, 1)
}

function goToday() {
  viewDate.value = new Date()
}

const focusedCellIndex = ref(-1)

function cellAriaLabel(cell: CalendarCell): string {
  const d = new Date(cell.dateStr + 'T00:00:00')
  const dateLabel = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  const total = cell.events.length + cell.overflow
  if (total > 0) return `${dateLabel}, ${total} event${total > 1 ? 's' : ''}`
  return dateLabel
}

function onCellKeydown(e: KeyboardEvent, cellIdx: number, cells: CalendarCell[]) {
  let next = cellIdx
  if (e.key === 'ArrowRight') next = cellIdx + 1
  else if (e.key === 'ArrowLeft') next = cellIdx - 1
  else if (e.key === 'ArrowDown') next = cellIdx + 7
  else if (e.key === 'ArrowUp') next = cellIdx - 7
  else if (e.key === 'Enter') {
    e.preventDefault()
    const cell = cells[cellIdx]
    if (cell?.inMonth && props.canCreate && dateField.value) {
      emit('create-record', buildCreateRecordData(cell.dateStr))
    }
    return
  } else return

  e.preventDefault()
  if (next >= 0 && next < cells.length && cells[next].inMonth) {
    focusedCellIndex.value = next
    const allCells = document.querySelectorAll('.meta-calendar__cell[tabindex="0"]')
    ;(allCells[next] as HTMLElement)?.focus()
  }
}
</script>

<style scoped>
.meta-calendar { display: flex; flex-direction: column; flex: 1; min-height: 0; position: relative; }
.meta-calendar__picker { display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; color: #666; font-size: 14px; gap: 12px; }
.meta-calendar__picker-icon { font-size: 36px; opacity: 0.5; }
.meta-calendar__field-select { padding: 6px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; }
.meta-calendar__header { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid #eee; }
.meta-calendar__nav-btn { width: 28px; height: 28px; border: 1px solid #ddd; border-radius: 4px; background: #fff; cursor: pointer; font-size: 16px; display: flex; align-items: center; justify-content: center; }
.meta-calendar__nav-btn:hover { background: #f5f5f5; }
.meta-calendar__title { font-size: 15px; font-weight: 600; color: #333; min-width: 160px; text-align: center; }
.meta-calendar__today-btn { padding: 3px 10px; border: 1px solid #ddd; border-radius: 4px; background: #fff; cursor: pointer; font-size: 12px; color: #409eff; }
.meta-calendar__today-btn:hover { background: #ecf5ff; }
.meta-calendar__create-btn { padding: 3px 10px; border: 1px solid #c7ddff; border-radius: 4px; background: #ecf5ff; cursor: pointer; font-size: 12px; color: #2563eb; }
.meta-calendar__create-btn:hover { background: #dbeafe; }
.meta-calendar__mode-label { display: inline-flex; align-items: center; gap: 6px; margin-left: 4px; font-size: 12px; color: #999; }
.meta-calendar__mode-select { padding: 3px 8px; border: 1px solid #ddd; border-radius: 4px; background: #fff; font-size: 12px; }
.meta-calendar__field-label { margin-left: auto; font-size: 12px; color: #999; }
.meta-calendar__change-btn { padding: 1px 6px; border: 1px solid #ddd; border-radius: 3px; background: #fff; cursor: pointer; font-size: 11px; color: #409eff; margin-left: 4px; }
.meta-calendar__weekdays { display: grid; grid-template-columns: repeat(7, 1fr); border-bottom: 1px solid #eee; }
.meta-calendar__weekday { padding: 6px 0; text-align: center; font-size: 12px; font-weight: 600; color: #999; }
.meta-calendar__grid { display: grid; grid-template-columns: repeat(7, 1fr); flex: 1; overflow-y: auto; }
.meta-calendar__grid--week { min-height: 260px; }
.meta-calendar__cell { min-height: 80px; border: 1px solid #f0f0f0; padding: 4px 6px; cursor: pointer; transition: background 0.1s; }
.meta-calendar__cell--week { min-height: 200px; }
.meta-calendar__cell:hover { background: #fafbfc; }
.meta-calendar__cell:focus-visible { outline: 2px solid #409eff; outline-offset: -2px; }
.meta-calendar__cell--outside { background: #fafafa; }
.meta-calendar__cell--outside .meta-calendar__day-num { color: #ccc; }
.meta-calendar__cell--today { background: #ecf5ff; }
.meta-calendar__cell--today .meta-calendar__day-num { color: #409eff; font-weight: 700; }
.meta-calendar__day-num { font-size: 12px; color: #666; margin-bottom: 2px; }
.meta-calendar__events { display: flex; flex-direction: column; gap: 2px; }
.meta-calendar__event { padding: 2px 4px; background: #409eff; color: #fff; border-radius: 3px; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.meta-calendar__event:hover { background: #337ecc; }
.meta-calendar__overflow { font-size: 10px; color: #999; padding: 1px 4px; }
.meta-calendar__day-view { display: flex; gap: 12px; padding: 14px 16px; flex: 1; overflow: auto; }
.meta-calendar__day-panel { min-width: 240px; background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px; display: flex; flex-direction: column; gap: 8px; }
.meta-calendar__day-heading { font-size: 15px; font-weight: 600; color: #333; }
.meta-calendar__day-meta { font-size: 12px; color: #777; }
.meta-calendar__day-create { align-self: flex-start; padding: 5px 10px; border: 1px solid #d9e6ff; border-radius: 4px; background: #ecf5ff; color: #409eff; cursor: pointer; font-size: 12px; }
.meta-calendar__day-create:hover { background: #dfeeff; }
.meta-calendar__day-list { flex: 1; display: flex; flex-direction: column; gap: 8px; }
.meta-calendar__day-event { padding: 10px 12px; border: 1px solid #e5e7eb; border-radius: 6px; background: #fff; cursor: pointer; font-size: 13px; color: #333; }
.meta-calendar__day-event:hover { border-color: #409eff; background: #f5faff; }
.meta-calendar__empty-hint { padding: 16px; text-align: center; color: #999; font-size: 13px; }
.meta-calendar__loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,.7); font-size: 14px; color: #666; z-index: 10; }
</style>
