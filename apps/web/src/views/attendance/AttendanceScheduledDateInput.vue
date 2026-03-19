<template>
  <div class="attendance-date-input">
    <div class="attendance-date-input__control">
      <input
        :id="fieldId"
        :name="fieldName"
        :type="inputType"
        :value="modelValue"
        :placeholder="placeholder"
        @input="onInput"
        @dblclick.prevent.stop="openPicker"
      />
      <button
        class="attendance-date-input__toggle"
        type="button"
        :aria-expanded="pickerOpen"
        :aria-controls="`${fieldId}-picker`"
        @click="togglePicker"
      >
        {{ tr('Calendar', '日历') }}
      </button>
    </div>

    <div v-if="pickerOpen" class="attendance-date-input__overlay" @click.self="closePicker">
      <div :id="`${fieldId}-picker`" class="attendance-date-input__panel" @click.stop>
        <div class="attendance-date-input__header">
          <button class="attendance-date-input__nav" type="button" @click="changeMonth(-1)">
            {{ tr('Prev', '上月') }}
          </button>
          <div class="attendance-date-input__month">{{ calendarLabel }}</div>
          <button class="attendance-date-input__nav" type="button" @click="changeMonth(1)">
            {{ tr('Next', '下月') }}
          </button>
        </div>

        <div class="attendance-date-input__weekdays">
          <span v-for="day in weekDays" :key="day">{{ day }}</span>
        </div>

        <div class="attendance-date-input__grid">
          <button
            v-for="day in calendarDays"
            :key="day.key"
            type="button"
            class="attendance-date-input__day"
            :class="[
              !day.isCurrentMonth ? 'attendance-date-input__day--muted' : '',
              day.isToday ? 'attendance-date-input__day--today' : '',
              day.status ? `attendance-date-input__day--${day.status}` : '',
              selectedDateKey === day.key ? 'attendance-date-input__day--selected' : '',
            ]"
            :title="day.tooltip"
            @click="selectDay(day.key)"
          >
            <span class="attendance-date-input__day-number">{{ day.day }}</span>
            <span v-if="day.statusLabel" class="attendance-date-input__day-status">{{ day.statusLabel }}</span>
            <span v-else class="attendance-date-input__day-status attendance-date-input__day-status--empty">--</span>
            <span v-if="day.lunarLabel" class="attendance-date-input__day-lunar">{{ day.lunarLabel }}</span>
            <span v-if="day.holidayName" class="attendance-date-input__day-holiday">{{ day.holidayName }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

type Translate = (en: string, zh: string) => string
type MaybePromise<T> = T | Promise<T>

interface CalendarDay {
  key: string
  day: number
  isToday: boolean
  isCurrentMonth: boolean
  status?: string
  statusLabel?: string
  tooltip: string
  holidayName?: string
  lunarLabel?: string
}

const props = defineProps<{
  modelValue: string
  inputType: 'date' | 'datetime-local'
  fieldId: string
  fieldName?: string
  placeholder?: string
  defaultTime?: string
  calendarDays: CalendarDay[]
  calendarLabel: string
  weekDays: string[]
  shiftMonth: (delta: number) => MaybePromise<void>
  focusCalendarMonth: (value: string | null | undefined) => MaybePromise<void>
  tr: Translate
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const pickerOpen = ref(false)

const selectedDateKey = computed(() => {
  const value = String(props.modelValue || '').trim()
  if (!value) return ''
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/)
  return match?.[1] ?? ''
})

function onInput(event: Event): void {
  const target = event.target as HTMLInputElement | null
  emit('update:modelValue', target?.value ?? '')
}

function openPicker(): void {
  pickerOpen.value = true
  void props.focusCalendarMonth(props.modelValue || null)
}

function closePicker(): void {
  pickerOpen.value = false
}

function togglePicker(): void {
  if (pickerOpen.value) {
    closePicker()
    return
  }
  openPicker()
}

function changeMonth(delta: number): void {
  void props.shiftMonth(delta)
}

function extractTimePart(value: string): string {
  const match = String(value || '').match(/T(\d{2}:\d{2})(?::\d{2})?/)
  if (match?.[1]) return match[1]
  return props.defaultTime?.trim() || '00:00'
}

function buildDateValue(dateKey: string): string {
  if (props.inputType === 'date') return dateKey
  return `${dateKey}T${extractTimePart(props.modelValue)}`
}

function selectDay(dateKey: string): void {
  emit('update:modelValue', buildDateValue(dateKey))
  closePicker()
}
</script>

<style scoped>
.attendance-date-input {
  position: relative;
  display: grid;
  gap: 8px;
}

.attendance-date-input__control {
  display: flex;
  gap: 8px;
  align-items: stretch;
}

.attendance-date-input__control input {
  flex: 1 1 auto;
  min-width: 0;
}

.attendance-date-input__toggle,
.attendance-date-input__nav,
.attendance-date-input__day {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  background: #fff;
  color: #1f2937;
}

.attendance-date-input__toggle {
  padding: 0 12px;
  white-space: nowrap;
}

.attendance-date-input__overlay {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: grid;
  place-items: start center;
  padding: 96px 20px 20px;
  background: rgba(15, 23, 42, 0.14);
}

.attendance-date-input__panel {
  width: min(640px, 100%);
  max-height: min(78vh, 760px);
  overflow: auto;
  border: 1px solid #dbe3ef;
  border-radius: 16px;
  background: #fff;
  box-shadow: 0 24px 60px rgba(15, 35, 95, 0.18);
  padding: 16px;
  display: grid;
  gap: 12px;
}

.attendance-date-input__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.attendance-date-input__month {
  font-weight: 600;
  color: #0f172a;
}

.attendance-date-input__nav {
  padding: 6px 12px;
}

.attendance-date-input__weekdays {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 6px;
  font-size: 12px;
  color: #64748b;
}

.attendance-date-input__weekdays span {
  text-align: center;
}

.attendance-date-input__grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 6px;
}

.attendance-date-input__day {
  min-height: 88px;
  padding: 8px 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  text-align: left;
  cursor: pointer;
}

.attendance-date-input__day--muted {
  opacity: 0.48;
}

.attendance-date-input__day--today {
  border-color: #2563eb;
}

.attendance-date-input__day--selected {
  background: #e0efff;
  border-color: #2563eb;
}

.attendance-date-input__day--off {
  background: #f8fafc;
}

.attendance-date-input__day-number {
  font-weight: 700;
  color: #0f172a;
}

.attendance-date-input__day-status {
  font-size: 12px;
  color: #2563eb;
}

.attendance-date-input__day-status--empty {
  color: #94a3b8;
}

.attendance-date-input__day-lunar,
.attendance-date-input__day-holiday {
  font-size: 12px;
  color: #475569;
  line-height: 1.2;
}
</style>
