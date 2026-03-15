<template>
  <div class="attendance__admin-section">
    <div class="attendance__admin-section-header">
      <h4>{{ tr('Holidays', '节假日') }}</h4>
      <button class="attendance__btn" :disabled="holidayLoading" @click="loadHolidays">
        {{ holidayLoading ? tr('Loading...', '加载中...') : tr('Reload holidays', '重载节假日') }}
      </button>
    </div>
    <div class="attendance__admin-grid">
      <label class="attendance__field" for="attendance-holiday-date">
        <span>{{ tr('Date', '日期') }}</span>
        <input id="attendance-holiday-date" v-model="holidayForm.date" name="holidayDate" type="date" />
      </label>
      <label class="attendance__field" for="attendance-holiday-name">
        <span>{{ tr('Name', '名称') }}</span>
        <input id="attendance-holiday-name" v-model="holidayForm.name" name="holidayName" type="text" :placeholder="tr('Optional', '可选')" />
      </label>
      <label class="attendance__field attendance__field--checkbox" for="attendance-holiday-working">
        <span>{{ tr('Working day override', '工作日覆盖') }}</span>
        <input id="attendance-holiday-working" v-model="holidayForm.isWorkingDay" name="holidayWorkingDay" type="checkbox" />
      </label>
    </div>
    <div class="attendance__admin-actions">
      <button class="attendance__btn attendance__btn--primary" :disabled="holidaySaving" @click="saveHoliday">
        {{ holidaySaving ? tr('Saving...', '保存中...') : holidayEditingId ? tr('Update holiday', '更新节假日') : tr('Create holiday', '创建节假日') }}
      </button>
      <button v-if="holidayEditingId" class="attendance__btn" :disabled="holidaySaving" @click="resetHolidayForm">
        {{ tr('Cancel edit', '取消编辑') }}
      </button>
    </div>
    <div v-if="holidays.length === 0" class="attendance__empty">{{ tr('No holidays in this range.', '当前范围内暂无节假日。') }}</div>
    <div v-else class="attendance__table-wrapper">
      <table class="attendance__table">
        <thead>
          <tr>
            <th>{{ tr('Date', '日期') }}</th>
            <th>{{ tr('Name', '名称') }}</th>
            <th>{{ tr('Working day', '工作日') }}</th>
            <th>{{ tr('Actions', '操作') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="holiday in holidays" :key="holiday.id">
            <td>{{ formatDate(holiday.date) }}</td>
            <td>{{ holiday.name || '--' }}</td>
            <td>{{ holiday.isWorkingDay ? tr('Yes', '是') : tr('No', '否') }}</td>
            <td class="attendance__table-actions">
              <button class="attendance__btn" @click="editHoliday(holiday)">{{ tr('Edit', '编辑') }}</button>
              <button class="attendance__btn attendance__btn--danger" @click="deleteHoliday(holiday.id)">{{ tr('Delete', '删除') }}</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Ref } from 'vue'
import type { AttendanceHoliday } from './useAttendanceAdminScheduling'

type Translate = (en: string, zh: string) => string
type MaybePromise<T> = T | Promise<T>

interface HolidayFormState {
  date: string
  name: string
  isWorkingDay: boolean
}

interface HolidayDataBindings {
  holidays: Ref<AttendanceHoliday[]>
  holidayLoading: Ref<boolean>
  holidaySaving: Ref<boolean>
  holidayEditingId: Ref<string | null>
  holidayForm: HolidayFormState
  resetHolidayForm: () => MaybePromise<void>
  editHoliday: (holiday: AttendanceHoliday) => MaybePromise<void>
  loadHolidays: () => MaybePromise<void>
  saveHoliday: () => MaybePromise<void>
  deleteHoliday: (id: string) => MaybePromise<void>
}

const props = defineProps<{
  holiday: HolidayDataBindings
  formatDate: (value: string | null | undefined) => string
  tr: Translate
}>()

const tr = props.tr
const formatDate = props.formatDate
const holidays = props.holiday.holidays
const holidayLoading = props.holiday.holidayLoading
const holidaySaving = props.holiday.holidaySaving
const holidayEditingId = props.holiday.holidayEditingId
const holidayForm = props.holiday.holidayForm
const resetHolidayForm = () => props.holiday.resetHolidayForm()
const editHoliday = (holiday: AttendanceHoliday) => props.holiday.editHoliday(holiday)
const loadHolidays = () => props.holiday.loadHolidays()
const saveHoliday = () => props.holiday.saveHoliday()
const deleteHoliday = (id: string) => props.holiday.deleteHoliday(id)
</script>

<style scoped>
.attendance__admin-section { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
.attendance__admin-section-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.attendance__admin-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.attendance__admin-actions, .attendance__table-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.attendance__field { display: flex; flex-direction: column; gap: 6px; }
.attendance__field--checkbox { justify-content: flex-end; }
.attendance__btn { padding: 8px 14px; border-radius: 6px; border: 1px solid #d0d0d0; background: #fff; cursor: pointer; }
.attendance__btn--primary { background: #1976d2; border-color: #1976d2; color: #fff; }
.attendance__btn--danger { color: #c62828; }
.attendance__btn:disabled { opacity: 0.6; cursor: not-allowed; }
.attendance__table-wrapper { width: 100%; overflow-x: auto; }
.attendance__table { width: 100%; border-collapse: collapse; margin-top: 12px; }
.attendance__table th, .attendance__table td { border-bottom: 1px solid #e0e0e0; padding: 8px; text-align: left; font-size: 13px; }
.attendance__empty { color: #888; font-size: 13px; margin-top: 8px; }
</style>
