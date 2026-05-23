<template>
  <div class="attendance__admin-subsection" data-attendance-calendar-policy-quick-add>
    <div class="attendance__admin-subsection-header">
      <div>
        <h5>{{ tr('Group holiday length quick add', '班组节假日时长快捷配置') }}</h5>
        <p class="attendance__field-hint">
          {{
            tr(
              'Use this for "Group A rests 3 days while the base holiday is 5 days" or "Group B rests 5 days while the base holiday is 3 days." The helper creates a group-scoped calendar policy row.',
              '用于“某个考勤组在 5 天假期里只休 3 天”或“某个考勤组在 3 天基础假期上多休到 5 天”这类场景。系统会生成班组级日历规则。',
            )
          }}
        </p>
      </div>
    </div>
    <div class="attendance__admin-grid">
      <label class="attendance__field" :for="holidayInputId">
        <span>{{ tr('Holiday name', '节假日名称') }}</span>
        <input
          :id="holidayInputId"
          v-model="form.holidayName"
          type="text"
          data-calendar-policy-quick-holiday
          placeholder="国庆"
        />
      </label>
      <label class="attendance__field" :for="groupInputId">
        <span>{{ tr('Attendance group', '考勤组') }}</span>
        <input
          :id="groupInputId"
          v-model="form.attendanceGroup"
          type="text"
          :list="groupListId"
          data-calendar-policy-quick-group
          placeholder="单休办公"
        />
        <datalist :id="groupListId">
          <option v-for="group in attendanceGroupOptions" :key="group" :value="group" />
        </datalist>
        <small v-if="attendanceGroupOptions.length" class="attendance__field-hint">
          {{ tr('Known groups', '已知分组') }}: {{ attendanceGroupOptions.join(', ') }}
        </small>
      </label>
      <label class="attendance__field" :for="baseDaysInputId">
        <span>{{ tr('Base rest days', '基础休息天数') }}</span>
        <input
          :id="baseDaysInputId"
          v-model.number="form.baseRestDays"
          type="number"
          min="1"
          data-calendar-policy-quick-base-days
        />
      </label>
      <label class="attendance__field" :for="targetDaysInputId">
        <span>{{ tr('Target rest days', '目标休息天数') }}</span>
        <input
          :id="targetDaysInputId"
          v-model.number="form.targetRestDays"
          type="number"
          min="1"
          data-calendar-policy-quick-target-days
        />
      </label>
      <label class="attendance__field" :for="baseStartDateInputId">
        <span>{{ tr('Base rest start date', '基础休息起始日期') }}</span>
        <input
          :id="baseStartDateInputId"
          v-model="form.baseRestStartDate"
          type="date"
          data-calendar-policy-quick-base-start-date
        />
        <small class="attendance__field-hint">
          {{ tr('Required only when target rest days is greater than base rest days. Use the first date in the base rest range, not necessarily the festival date.', '仅当目标休息天数大于基础休息天数时必填。请填写基础休息范围的第一天，不一定是节日本身日期。') }}
        </small>
      </label>
      <label class="attendance__field" :for="labelInputId">
        <span>{{ tr('Label', '标签') }}</span>
        <input
          :id="labelInputId"
          v-model="form.label"
          type="text"
          data-calendar-policy-quick-label
          :placeholder="defaultLabel"
        />
      </label>
    </div>
    <p class="attendance__field-hint">
      {{ tr('After adding a quick row, run preview in group or user mode before saving.', '添加快捷规则后，请先用班组或用户模式预览，再保存。') }}
    </p>
    <p v-if="statusMessage" class="attendance__field-hint" :class="{ 'attendance__field-hint--warn': statusKind === 'warn' }" data-calendar-policy-quick-status>
      {{ statusMessage }}
    </p>
    <div class="attendance__admin-actions">
      <button
        class="attendance__btn"
        type="button"
        data-calendar-policy-quick-add
        :disabled="quickAddResult.kind !== 'append'"
        @click="appendQuickOverride"
      >
        {{ tr('Add group holiday rule', '添加班组节假日规则') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, useId } from 'vue'
import {
  buildHolidayLengthCalendarPolicyOverride,
  type CalendarPolicyOverrideFormState,
} from './attendanceCalendarPolicyOverrides'

type Translate = (en: string, zh: string) => string

const props = defineProps<{
  attendanceGroupOptions: string[]
  tr: Translate
}>()

const emit = defineEmits<{
  append: [form: CalendarPolicyOverrideFormState]
}>()

const tr = (en: string, zh: string) => props.tr(en, zh)
const attendanceGroupOptions = computed(() => props.attendanceGroupOptions)
const quickAddId = useId()
const holidayInputId = `${quickAddId}-holiday`
const groupInputId = `${quickAddId}-group`
const groupListId = `${quickAddId}-groups`
const baseDaysInputId = `${quickAddId}-base-days`
const targetDaysInputId = `${quickAddId}-target-days`
const baseStartDateInputId = `${quickAddId}-base-start-date`
const labelInputId = `${quickAddId}-label`

const form = reactive({
  holidayName: tr('National Day', '国庆'),
  attendanceGroup: '',
  baseRestDays: 5,
  targetRestDays: 3,
  baseRestStartDate: '',
  label: '',
})

const isLongerRestTarget = computed(() => Number(form.targetRestDays) > Number(form.baseRestDays))

const defaultWorkdayLabel = computed(() => {
  const holidayName = form.holidayName.trim() || tr('Holiday', '节假日')
  return tr(`${holidayName} make-up workday`, `${holidayName}调班`)
})

const defaultExtraRestLabel = computed(() => {
  const holidayName = form.holidayName.trim() || tr('Holiday', '节假日')
  return tr(`${holidayName} extra rest`, `${holidayName}延休`)
})

const defaultLabel = computed(() => (isLongerRestTarget.value ? defaultExtraRestLabel.value : defaultWorkdayLabel.value))

const quickAddResult = computed(() => buildHolidayLengthCalendarPolicyOverride({
  ...form,
  localizedDefaultLabel: defaultWorkdayLabel.value,
  localizedExtraRestLabel: defaultExtraRestLabel.value,
}))

function appendQuickOverride() {
  const result = quickAddResult.value
  if (result.kind !== 'append') return
  emit('append', result.form)
}

const statusKind = computed<'info' | 'warn'>(() => {
  const result = quickAddResult.value
  return result.kind === 'append' || result.kind === 'noop' ? 'info' : 'warn'
})

const statusMessage = computed(() => {
  const result = quickAddResult.value
  if (result.kind === 'append') {
    if (result.form.isWorkingDay === false && result.form.from && result.form.to) {
      return tr(
        `Will add a group rest exception from ${result.form.from} to ${result.form.to}.`,
        `将新增班组延休规则：${result.form.from} 至 ${result.form.to} 改为休息日。`,
      )
    }
    return tr(
      `Will add a group workday exception for holiday day ${result.form.dayIndexStart}-${result.form.dayIndexEnd}.`,
      `将新增班组调班规则：节假日第 ${result.form.dayIndexStart}-${result.form.dayIndexEnd} 天改为工作日。`,
    )
  }
  if (result.reason === 'same_length') {
    return tr('No rule is needed because the target rest length equals the base holiday length.', '目标休息天数与基础假期一致，无需新增规则。')
  }
  if (result.reason === 'missing_base_rest_start_date') {
    return tr('Enter the base rest start date to generate extra rest days.', '请填写基础休息起始日期，才能生成额外休息日规则。')
  }
  return isLongerRestTarget.value
    ? tr('Fill a holiday name, attendance group, valid day counts, and a valid base rest start date before adding a rule.', '请先填写节假日名称、考勤组、有效天数和有效的基础休息起始日期。')
    : tr('Fill a holiday name, attendance group, and valid day counts before adding a rule.', '请先填写节假日名称、考勤组和有效天数。')
})
</script>
