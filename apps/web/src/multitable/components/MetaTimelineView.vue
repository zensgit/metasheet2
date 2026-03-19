<template>
  <div class="meta-timeline" role="region" aria-label="Timeline view">
    <div v-if="loading" class="meta-timeline__loading">Loading...</div>
    <template v-else>
      <!-- Field picker -->
      <div class="meta-timeline__config">
        <label class="meta-timeline__config-label">
          Start date
          <select class="meta-timeline__config-select" :value="startFieldId" @change="startFieldId = ($event.target as HTMLSelectElement).value">
            <option value="">— select —</option>
            <option v-for="f in dateFields" :key="f.id" :value="f.id">{{ f.name }}</option>
          </select>
        </label>
        <label class="meta-timeline__config-label">
          End date
          <select class="meta-timeline__config-select" :value="endFieldId" @change="endFieldId = ($event.target as HTMLSelectElement).value">
            <option value="">— select —</option>
            <option v-for="f in dateFields" :key="f.id" :value="f.id">{{ f.name }}</option>
          </select>
        </label>
        <label class="meta-timeline__config-label">
          Zoom
          <select class="meta-timeline__config-select" :value="zoom" @change="zoom = ($event.target as HTMLSelectElement).value as any">
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
          </select>
        </label>
      </div>

      <div v-if="!startFieldId || !endFieldId" class="meta-timeline__placeholder">
        Select start and end date fields to display the timeline.
      </div>

      <template v-else>
        <!-- Time axis header -->
        <div class="meta-timeline__header">
          <div class="meta-timeline__label-col">Record</div>
          <div class="meta-timeline__axis">
            <span v-for="tick in axisTicks" :key="tick.key" class="meta-timeline__tick" :style="{ left: tick.left + '%' }">
              {{ tick.label }}
            </span>
          </div>
        </div>

        <!-- Scheduled rows -->
        <div
          v-for="item in scheduledRows"
          :key="item.record.id"
          class="meta-timeline__row"
          :class="{ 'meta-timeline__row--selected': item.record.id === selectedRecordId }"
          tabindex="0"
          role="button"
          :aria-label="displayLabel(item.record)"
          @click="onSelect(item.record.id)"
          @keydown.enter="onSelect(item.record.id)"
        >
          <div class="meta-timeline__label-col">{{ displayLabel(item.record) }}</div>
          <div class="meta-timeline__bar-area">
            <div
              class="meta-timeline__bar"
              :style="{ left: item.barLeft + '%', width: item.barWidth + '%' }"
              :title="`${item.startDate} → ${item.endDate}`"
            ></div>
          </div>
        </div>

        <!-- Unscheduled section -->
        <div v-if="unscheduledRows.length" class="meta-timeline__unscheduled">
          <div class="meta-timeline__unscheduled-header">Unscheduled ({{ unscheduledRows.length }})</div>
          <div
            v-for="row in unscheduledRows"
            :key="row.id"
            class="meta-timeline__unscheduled-row"
            tabindex="0"
            role="button"
            :aria-label="displayLabel(row)"
            @click="onSelect(row.id)"
            @keydown.enter="onSelect(row.id)"
          >
            {{ displayLabel(row) }}
          </div>
        </div>

        <div v-if="!scheduledRows.length && !unscheduledRows.length" class="meta-timeline__empty">
          No records found
        </div>
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import type { MetaField, MetaRecord } from '../types'

const props = defineProps<{
  rows: MetaRecord[]
  fields: MetaField[]
  loading: boolean
}>()

const emit = defineEmits<{
  (e: 'select-record', recordId: string): void
}>()

const startFieldId = ref('')
const endFieldId = ref('')
const zoom = ref<'day' | 'week' | 'month'>('week')
const selectedRecordId = ref<string | null>(null)

const dateFields = computed(() => props.fields.filter((f) => f.type === 'date'))

const displayField = computed(() => props.fields.find((f) => f.type === 'string') ?? props.fields[0] ?? null)

function displayLabel(record: MetaRecord): string {
  if (!displayField.value) return record.id
  const v = record.data[displayField.value.id]
  return v != null ? String(v) : record.id
}

function parseDate(val: unknown): Date | null {
  if (!val) return null
  const d = new Date(String(val))
  return isNaN(d.getTime()) ? null : d
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
  // Add padding
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
</script>

<style scoped>
.meta-timeline { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: auto; padding: 8px; }
.meta-timeline__loading { text-align: center; padding: 32px; color: #999; }
.meta-timeline__config { display: flex; gap: 16px; padding: 8px 0 12px; flex-wrap: wrap; }
.meta-timeline__config-label { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: #666; }
.meta-timeline__config-select { padding: 4px 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; }
.meta-timeline__placeholder { text-align: center; padding: 32px; color: #999; font-size: 13px; }
.meta-timeline__header { display: flex; align-items: flex-end; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; height: 32px; }
.meta-timeline__label-col { width: 160px; min-width: 160px; font-size: 12px; font-weight: 600; color: #666; padding: 0 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-timeline__axis { flex: 1; position: relative; height: 20px; }
.meta-timeline__tick { position: absolute; font-size: 10px; color: #999; transform: translateX(-50%); white-space: nowrap; }
.meta-timeline__row { display: flex; align-items: center; height: 36px; border-bottom: 1px solid #f0f0f0; cursor: pointer; outline: none; }
.meta-timeline__row:hover { background: #f5f7fa; }
.meta-timeline__row--selected { background: #ecf5ff; }
.meta-timeline__row:focus-visible { outline: 2px solid #409eff; outline-offset: -2px; }
.meta-timeline__bar-area { flex: 1; position: relative; height: 24px; }
.meta-timeline__bar { position: absolute; top: 4px; height: 16px; background: #409eff; border-radius: 3px; min-width: 4px; }
.meta-timeline__unscheduled { margin-top: 12px; border-top: 1px solid #e5e7eb; padding-top: 8px; }
.meta-timeline__unscheduled-header { font-size: 12px; font-weight: 600; color: #999; margin-bottom: 4px; }
.meta-timeline__unscheduled-row { padding: 4px 8px; font-size: 12px; color: #666; cursor: pointer; border-radius: 3px; outline: none; }
.meta-timeline__unscheduled-row:hover { background: #f5f7fa; }
.meta-timeline__unscheduled-row:focus-visible { outline: 2px solid #409eff; outline-offset: -2px; }
.meta-timeline__empty { text-align: center; padding: 32px; color: #999; font-size: 13px; }
</style>
