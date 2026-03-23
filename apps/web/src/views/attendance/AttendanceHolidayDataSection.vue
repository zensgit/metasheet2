<template>
  <div class="attendance__admin-section">
    <div class="attendance__admin-section-header">
      <h4>{{ tr('Holidays', '节假日') }}</h4>
      <div class="attendance__admin-actions">
        <button type="button" class="attendance__btn" :disabled="holidayLoading" @click="goPrevMonth">
          {{ tr('Previous month', '上个月') }}
        </button>
        <span class="attendance__section-meta" aria-live="polite">
          {{ calendarLabel }}
          <span v-if="holidayLoading" class="attendance__field-hint"> · {{ tr('Loading month...', '月份加载中...') }}</span>
        </span>
        <button type="button" class="attendance__btn" :disabled="holidayLoading" @click="goCurrentMonth">
          {{ tr('Current month', '本月') }}
        </button>
        <button type="button" class="attendance__btn" :disabled="holidayLoading" @click="goNextMonth">
          {{ tr('Next month', '下个月') }}
        </button>
        <button type="button" class="attendance__btn" :disabled="holidayLoading" @click="loadHolidays">
          {{ holidayLoading ? tr('Loading...', '加载中...') : tr('Reload holidays', '重载节假日') }}
        </button>
      </div>
    </div>
    <div class="attendance__admin-grid">
      <div class="attendance__field attendance__field--full">
        <small class="attendance__field-hint">
          {{ tr('Holiday management now follows a month calendar. Click a date to review that day and create or edit holiday overrides.', '节假日管理现在按月历展示。点击日期即可查看当天节假日，并创建或编辑节假日/调班。') }}
        </small>
      </div>
    </div>
    <div class="attendance__holiday-layout" :aria-busy="holidayLoading ? 'true' : 'false'">
      <div class="attendance__holiday-calendar">
        <div class="attendance__holiday-weekdays">
          <span v-for="weekday in weekdayLabels" :key="weekday">{{ weekday }}</span>
        </div>
        <div class="attendance__holiday-grid">
          <button
            v-for="day in calendarDays"
            :key="day.date"
            type="button"
            class="attendance__holiday-cell"
            :class="{
              'attendance__holiday-cell--muted': !day.isCurrentMonth,
              'attendance__holiday-cell--today': day.isToday,
              'attendance__holiday-cell--selected': day.date === selectedDate,
              'attendance__holiday-cell--holiday': day.holidays.length > 0,
            }"
            :disabled="holidayLoading"
            @click="selectDate(day.date)"
          >
            <span class="attendance__holiday-cell-day">{{ day.dayNumber }}</span>
            <span v-if="day.lunarLabel" class="attendance__holiday-cell-lunar">{{ day.lunarLabel }}</span>
            <span
              v-for="holiday in day.holidays.slice(0, 2)"
              :key="`${day.date}-${holiday.id}`"
              class="attendance__holiday-chip"
              :class="holiday.isWorkingDay ? 'attendance__holiday-chip--working' : 'attendance__holiday-chip--holiday'"
            >
              {{ holiday.name || fallbackHolidayName(holiday.isWorkingDay) }}
            </span>
            <span v-if="day.holidays.length > 2" class="attendance__holiday-more">
              +{{ day.holidays.length - 2 }}
            </span>
          </button>
        </div>
      </div>

      <div class="attendance__holiday-side">
        <div class="attendance__holiday-panel">
          <div class="attendance__holiday-panel-title">
            {{ tr('Selected date', '当前日期') }}: <strong>{{ formatDate(selectedDate) }}</strong>
          </div>
          <div v-if="selectedDateHolidays.length === 0" class="attendance__empty">
            {{ tr('No holidays or working-day overrides on this date.', '当前日期没有节假日或调班覆盖。') }}
          </div>
          <div v-else class="attendance__holiday-day-list">
            <div v-for="holiday in selectedDateHolidays" :key="holiday.id" class="attendance__holiday-day-item">
              <div>
                <strong>{{ holiday.name || fallbackHolidayName(holiday.isWorkingDay) }}</strong>
                <div class="attendance__field-hint">
                  {{ holiday.isWorkingDay ? tr('Working day override', '调班工作日') : tr('Holiday', '节假日') }}
                </div>
              </div>
              <div class="attendance__table-actions">
                <button type="button" class="attendance__btn" @click="startEditHoliday(holiday)">
                  {{ tr('Edit', '编辑') }}
                </button>
                <button type="button" class="attendance__btn attendance__btn--danger" @click="deleteHoliday(holiday.id)">
                  {{ tr('Delete', '删除') }}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="attendance__admin-grid">
          <label class="attendance__field" for="attendance-holiday-date">
            <span>{{ tr('Date', '日期') }}</span>
            <input id="attendance-holiday-date" v-model="holidayForm.date" name="holidayDate" type="date" />
          </label>
          <label class="attendance__field" for="attendance-holiday-name">
            <span>{{ tr('Name', '名称') }}</span>
            <input
              id="attendance-holiday-name"
              v-model="holidayForm.name"
              name="holidayName"
              type="text"
              :placeholder="tr('Required holiday name', '必填节假日名称')"
            />
          </label>
          <label class="attendance__field attendance__field--checkbox" for="attendance-holiday-working">
            <span>{{ tr('Working day override', '工作日覆盖') }}</span>
            <input id="attendance-holiday-working" v-model="holidayForm.isWorkingDay" name="holidayWorkingDay" type="checkbox" />
          </label>
        </div>
        <div class="attendance__admin-actions">
          <button type="button" class="attendance__btn attendance__btn--primary" :disabled="holidaySaving" @click="saveHoliday">
            {{ holidaySaving ? tr('Saving...', '保存中...') : holidayEditingId ? tr('Update holiday', '更新节假日') : tr('Create holiday', '创建节假日') }}
          </button>
          <button v-if="holidayEditingId" type="button" class="attendance__btn" :disabled="holidaySaving" @click="cancelEdit">
            {{ tr('Cancel edit', '取消编辑') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, type Ref } from 'vue'
import type { AttendanceHoliday } from './useAttendanceAdminScheduling'
import { formatLunarDayLabel } from '../attendanceCalendarUtils'

type Translate = (en: string, zh: string) => string
type MaybePromise<T> = T | Promise<T>

interface HolidayFormState {
  date: string
  name: string
  isWorkingDay: boolean
}

interface HolidayDataBindings {
  holidays: Ref<AttendanceHoliday[]>
  holidayTotal: Ref<number>
  holidayLoading: Ref<boolean>
  holidaySaving: Ref<boolean>
  holidayEditingId: Ref<string | null>
  holidayRange: {
    from: string
    to: string
  }
  holidayForm: HolidayFormState
  resetHolidayForm: () => MaybePromise<void>
  editHoliday: (holiday: AttendanceHoliday) => MaybePromise<void>
  loadHolidays: () => MaybePromise<void>
  saveHoliday: () => MaybePromise<void>
  deleteHoliday: (id: string) => MaybePromise<void>
}

interface CalendarDayCell {
  date: string
  dayNumber: number
  isCurrentMonth: boolean
  isToday: boolean
  holidays: AttendanceHoliday[]
  lunarLabel?: string
}

const props = defineProps<{
  holiday: HolidayDataBindings
  formatDate: (value: string | null | undefined) => string
  showLunarCalendar?: boolean
  tr: Translate
}>()

const tr = props.tr
const formatDate = props.formatDate
const holidays = props.holiday.holidays
const holidayLoading = props.holiday.holidayLoading
const holidaySaving = props.holiday.holidaySaving
const holidayEditingId = props.holiday.holidayEditingId
const holidayRange = props.holiday.holidayRange
const holidayForm = props.holiday.holidayForm
const resetHolidayForm = () => props.holiday.resetHolidayForm()
const editHoliday = (holiday: AttendanceHoliday) => props.holiday.editHoliday(holiday)
const loadHolidays = () => props.holiday.loadHolidays()
const saveHoliday = () => props.holiday.saveHoliday()
const deleteHoliday = (id: string) => props.holiday.deleteHoliday(id)

const weekdayLabels = computed(() => [
  tr('Sun', '周日'),
  tr('Mon', '周一'),
  tr('Tue', '周二'),
  tr('Wed', '周三'),
  tr('Thu', '周四'),
  tr('Fri', '周五'),
  tr('Sat', '周六'),
])

function parseDateOnly(value: string | null | undefined): Date | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  const [, year, month, day] = match
  const date = new Date(Number(year), Number(month) - 1, Number(day))
  return Number.isNaN(date.getTime()) ? null : date
}

function toDateInput(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function firstDayOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function lastDayOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0)
}

function sameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()
}

function fallbackHolidayName(isWorkingDay: boolean): string {
  return isWorkingDay
    ? tr('Working day override', '调班工作日')
    : tr('Unnamed holiday', '未命名节假日')
}

const today = new Date()
const selectedDate = ref(holidayForm.date || toDateInput(today))
const calendarMonth = ref(firstDayOfMonth(parseDateOnly(holidayForm.date) ?? today))

const holidayMap = computed(() => {
  const map = new Map<string, AttendanceHoliday[]>()
  for (const holiday of holidays.value) {
    if (!map.has(holiday.date)) map.set(holiday.date, [])
    map.get(holiday.date)?.push(holiday)
  }
  return map
})

const selectedDateHolidays = computed(() => holidayMap.value.get(selectedDate.value) ?? [])

const calendarLabel = computed(() => {
  const month = calendarMonth.value.getMonth() + 1
  const year = calendarMonth.value.getFullYear()
  return tr(`${year}-${String(month).padStart(2, '0')}`, `${year}年${month}月`)
})

const calendarDays = computed<CalendarDayCell[]>(() => {
  const start = firstDayOfMonth(calendarMonth.value)
  const startOffset = start.getDay()
  const firstCell = new Date(start)
  firstCell.setDate(start.getDate() - startOffset)
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(firstCell)
    date.setDate(firstCell.getDate() + index)
    const key = toDateInput(date)
    return {
      date: key,
      dayNumber: date.getDate(),
      isCurrentMonth: sameMonth(date, calendarMonth.value),
      isToday: key === toDateInput(today),
      holidays: holidayMap.value.get(key) ?? [],
      lunarLabel: formatLunarDayLabel(date, {
        enabled: Boolean(props.showLunarCalendar),
      }),
    }
  })
})

async function syncMonthRange(date: Date) {
  holidayRange.from = toDateInput(firstDayOfMonth(date))
  holidayRange.to = toDateInput(lastDayOfMonth(date))
  await loadHolidays()
}

async function setCalendarMonth(date: Date, selectedDateOverride: Date = date) {
  const nextMonth = firstDayOfMonth(date)
  const nextSelectedDate = toDateInput(selectedDateOverride)
  calendarMonth.value = nextMonth
  selectedDate.value = nextSelectedDate
  holidayForm.date = nextSelectedDate
  await syncMonthRange(nextMonth)
}

async function goPrevMonth() {
  const previousMonth = new Date(calendarMonth.value.getFullYear(), calendarMonth.value.getMonth() - 1, 1)
  await setCalendarMonth(previousMonth, previousMonth)
}

async function goNextMonth() {
  const nextMonth = new Date(calendarMonth.value.getFullYear(), calendarMonth.value.getMonth() + 1, 1)
  await setCalendarMonth(nextMonth, nextMonth)
}

async function goCurrentMonth() {
  await setCalendarMonth(today, today)
}

function selectDate(date: string) {
  selectedDate.value = date
  holidayForm.date = date
}

async function startEditHoliday(holiday: AttendanceHoliday) {
  selectDate(holiday.date)
  await editHoliday(holiday)
}

async function cancelEdit() {
  await resetHolidayForm()
  selectDate(selectedDate.value)
}

watch(
  () => holidayForm.date,
  async (value) => {
    const date = parseDateOnly(value)
    if (!date) return
    selectedDate.value = toDateInput(date)
    if (!sameMonth(date, calendarMonth.value)) {
      await setCalendarMonth(date)
    }
  }
)

void syncMonthRange(calendarMonth.value)
</script>

<style scoped>
.attendance__admin-section { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
.attendance__admin-section-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.attendance__admin-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.attendance__admin-actions, .attendance__table-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.attendance__field { display: flex; flex-direction: column; gap: 6px; }
.attendance__field--full { grid-column: 1 / -1; }
.attendance__field--checkbox { justify-content: flex-end; }
.attendance__field-hint { color: #666; font-size: 12px; }
.attendance__section-meta { color: #555; font-size: 12px; align-self: center; }
.attendance__btn { padding: 8px 14px; border-radius: 6px; border: 1px solid #d0d0d0; background: #fff; cursor: pointer; }
.attendance__btn--primary { background: #1976d2; border-color: #1976d2; color: #fff; }
.attendance__btn--danger { color: #c62828; }
.attendance__btn:disabled { opacity: 0.6; cursor: not-allowed; }
.attendance__holiday-layout { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(320px, 0.9fr); gap: 16px; align-items: start; }
.attendance__holiday-calendar { border: 1px solid #e0e0e0; border-radius: 10px; padding: 12px; background: #fff; }
.attendance__holiday-weekdays { display: grid; grid-template-columns: repeat(7, 1fr); gap: 8px; margin-bottom: 8px; color: #666; font-size: 12px; }
.attendance__holiday-weekdays span { text-align: center; }
.attendance__holiday-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 8px; }
.attendance__holiday-cell { min-height: 92px; padding: 8px; border-radius: 10px; border: 1px solid #e6e6e6; background: #fafafa; text-align: left; display: flex; flex-direction: column; gap: 6px; cursor: pointer; }
.attendance__holiday-cell--muted { opacity: 0.45; }
.attendance__holiday-cell--today { border-color: #1976d2; }
.attendance__holiday-cell--selected { box-shadow: 0 0 0 2px rgba(25, 118, 210, 0.18); background: #f3f8ff; }
.attendance__holiday-cell--holiday { background: #fffaf1; }
.attendance__holiday-cell-day { font-weight: 600; }
.attendance__holiday-cell-lunar { color: #8a5c2e; font-size: 11px; line-height: 1.3; }
.attendance__holiday-chip { display: inline-flex; align-items: center; max-width: 100%; padding: 2px 6px; border-radius: 999px; font-size: 11px; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attendance__holiday-chip--holiday { background: #ffe8e8; color: #9a1a1a; }
.attendance__holiday-chip--working { background: #e5f7ec; color: #15693a; }
.attendance__holiday-more { color: #666; font-size: 11px; }
.attendance__holiday-side { display: flex; flex-direction: column; gap: 12px; }
.attendance__holiday-panel { border: 1px solid #e0e0e0; border-radius: 10px; padding: 12px; background: #fff; display: flex; flex-direction: column; gap: 10px; }
.attendance__holiday-panel-title { font-size: 13px; color: #444; }
.attendance__holiday-day-list { display: flex; flex-direction: column; gap: 10px; }
.attendance__holiday-day-item { display: flex; justify-content: space-between; gap: 12px; align-items: center; border: 1px solid #ededed; border-radius: 8px; padding: 10px; background: #fafafa; }
.attendance__empty { color: #888; font-size: 13px; }

@media (max-width: 960px) {
  .attendance__holiday-layout { grid-template-columns: 1fr; }
}
</style>
