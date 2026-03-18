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
        <button class="meta-calendar__nav-btn" @click="prevMonth">&lsaquo;</button>
        <span class="meta-calendar__title">{{ monthLabel }}</span>
        <button class="meta-calendar__nav-btn" @click="nextMonth">&rsaquo;</button>
        <button class="meta-calendar__today-btn" @click="goToday">Today</button>
        <span class="meta-calendar__field-label">
          Field: <strong>{{ dateField.name }}</strong>
          <button class="meta-calendar__change-btn" @click="dateFieldId = null">Change</button>
        </span>
      </div>

      <div class="meta-calendar__weekdays">
        <div v-for="d in weekdays" :key="d" class="meta-calendar__weekday">{{ d }}</div>
      </div>

      <div class="meta-calendar__grid">
        <div
          v-for="cell in calendarCells"
          :key="cell.key"
          class="meta-calendar__cell"
          :class="{
            'meta-calendar__cell--outside': !cell.inMonth,
            'meta-calendar__cell--today': cell.isToday,
          }"
          @click="canCreate && cell.inMonth && emit('create-record', { [dateField!.id]: cell.dateStr })"
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

    <div v-if="loading" class="meta-calendar__loading">Loading...</div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import type { MetaField, MetaRecord } from '../types'

const MAX_EVENTS_PER_CELL = 3

const props = defineProps<{
  rows: MetaRecord[]
  fields: MetaField[]
  loading: boolean
  canCreate?: boolean
}>()

const emit = defineEmits<{
  (e: 'select-record', recordId: string): void
  (e: 'create-record', data: Record<string, unknown>): void
}>()

const dateFieldId = ref<string | null>(null)
const viewYear = ref(new Date().getFullYear())
const viewMonth = ref(new Date().getMonth()) // 0-indexed

const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const dateFields = computed(() =>
  props.fields.filter((f) => f.type === 'date' || f.type === 'string' || f.type === 'number'),
)

const dateField = computed(() =>
  dateFieldId.value ? props.fields.find((f) => f.id === dateFieldId.value) ?? null : null,
)

const titleField = computed(() =>
  props.fields.find((f) => f.type === 'string' && f.id !== dateFieldId.value) ?? props.fields[0] ?? null,
)

const monthLabel = computed(() => {
  const d = new Date(viewYear.value, viewMonth.value, 1)
  return d.toLocaleString('default', { month: 'long', year: 'numeric' })
})

// Build a map: dateStr -> events
const eventsByDate = computed(() => {
  const map: Record<string, Array<{ id: string; title: string }>> = {}
  if (!dateField.value) return map
  for (const row of props.rows) {
    const raw = row.data[dateField.value.id]
    if (!raw) continue
    const dateStr = normalizeDate(String(raw))
    if (!dateStr) continue
    if (!map[dateStr]) map[dateStr] = []
    const title = titleField.value ? String(row.data[titleField.value.id] ?? '') || row.id : row.id
    map[dateStr].push({ id: row.id, title })
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

const calendarCells = computed<CalendarCell[]>(() => {
  const cells: CalendarCell[] = []
  const first = new Date(viewYear.value, viewMonth.value, 1)
  const startDay = first.getDay() // 0=Sun

  const today = new Date()
  const todayStr = fmt(today.getFullYear(), today.getMonth() + 1, today.getDate())

  // Days from previous month
  const prevLast = new Date(viewYear.value, viewMonth.value, 0)
  for (let i = startDay - 1; i >= 0; i--) {
    const d = prevLast.getDate() - i
    const ds = fmt(prevLast.getFullYear(), prevLast.getMonth() + 1, d)
    const all = eventsByDate.value[ds] ?? []
    cells.push({ key: `p${d}`, day: d, dateStr: ds, inMonth: false, isToday: ds === todayStr, events: all.slice(0, MAX_EVENTS_PER_CELL), overflow: Math.max(0, all.length - MAX_EVENTS_PER_CELL) })
  }

  // Days of current month
  const daysInMonth = new Date(viewYear.value, viewMonth.value + 1, 0).getDate()
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = fmt(viewYear.value, viewMonth.value + 1, d)
    const all = eventsByDate.value[ds] ?? []
    cells.push({ key: `c${d}`, day: d, dateStr: ds, inMonth: true, isToday: ds === todayStr, events: all.slice(0, MAX_EVENTS_PER_CELL), overflow: Math.max(0, all.length - MAX_EVENTS_PER_CELL) })
  }

  // Fill remaining to complete 6 rows (42 cells)
  const remaining = 42 - cells.length
  for (let d = 1; d <= remaining; d++) {
    const next = new Date(viewYear.value, viewMonth.value + 1, d)
    const ds = fmt(next.getFullYear(), next.getMonth() + 1, next.getDate())
    const all = eventsByDate.value[ds] ?? []
    cells.push({ key: `n${d}`, day: d, dateStr: ds, inMonth: false, isToday: ds === todayStr, events: all.slice(0, MAX_EVENTS_PER_CELL), overflow: Math.max(0, all.length - MAX_EVENTS_PER_CELL) })
  }

  return cells
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
  dateFieldId.value = val || null
}

function prevMonth() {
  if (viewMonth.value === 0) { viewMonth.value = 11; viewYear.value-- }
  else viewMonth.value--
}

function nextMonth() {
  if (viewMonth.value === 11) { viewMonth.value = 0; viewYear.value++ }
  else viewMonth.value++
}

function goToday() {
  const now = new Date()
  viewYear.value = now.getFullYear()
  viewMonth.value = now.getMonth()
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
.meta-calendar__field-label { margin-left: auto; font-size: 12px; color: #999; }
.meta-calendar__change-btn { padding: 1px 6px; border: 1px solid #ddd; border-radius: 3px; background: #fff; cursor: pointer; font-size: 11px; color: #409eff; margin-left: 4px; }
.meta-calendar__weekdays { display: grid; grid-template-columns: repeat(7, 1fr); border-bottom: 1px solid #eee; }
.meta-calendar__weekday { padding: 6px 0; text-align: center; font-size: 12px; font-weight: 600; color: #999; }
.meta-calendar__grid { display: grid; grid-template-columns: repeat(7, 1fr); flex: 1; overflow-y: auto; }
.meta-calendar__cell { min-height: 80px; border: 1px solid #f0f0f0; padding: 4px 6px; cursor: pointer; transition: background 0.1s; }
.meta-calendar__cell:hover { background: #fafbfc; }
.meta-calendar__cell--outside { background: #fafafa; }
.meta-calendar__cell--outside .meta-calendar__day-num { color: #ccc; }
.meta-calendar__cell--today { background: #ecf5ff; }
.meta-calendar__cell--today .meta-calendar__day-num { color: #409eff; font-weight: 700; }
.meta-calendar__day-num { font-size: 12px; color: #666; margin-bottom: 2px; }
.meta-calendar__events { display: flex; flex-direction: column; gap: 2px; }
.meta-calendar__event { padding: 2px 4px; background: #409eff; color: #fff; border-radius: 3px; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.meta-calendar__event:hover { background: #337ecc; }
.meta-calendar__overflow { font-size: 10px; color: #999; padding: 1px 4px; }
.meta-calendar__loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,.7); font-size: 14px; color: #666; z-index: 10; }
</style>
