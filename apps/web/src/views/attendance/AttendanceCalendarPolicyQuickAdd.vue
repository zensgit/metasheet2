<template>
  <div class="attendance__admin-subsection" data-attendance-calendar-policy-quick-add>
    <div class="attendance__admin-subsection-header">
      <div>
        <h5>{{ tr('Group holiday length quick add', '班组节假日时长快捷配置') }}</h5>
        <p class="attendance__field-hint">
          {{
            tr(
              'Use this for "Group A rests 3 days while the base holiday is 5 days." The helper creates a group-scoped workday exception for the remaining holiday day indexes.',
              '用于“某个考勤组在 5 天假期里只休 3 天”这类场景。系统会为剩余节假日序号生成班组级调班规则。',
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
const labelInputId = `${quickAddId}-label`

const form = reactive({
  holidayName: tr('National Day', '国庆'),
  attendanceGroup: '',
  baseRestDays: 5,
  targetRestDays: 3,
  label: '',
})

const defaultLabel = computed(() => {
  const holidayName = form.holidayName.trim() || tr('Holiday', '节假日')
  return tr(`${holidayName} make-up workday`, `${holidayName}调班`)
})

const quickAddResult = computed(() => buildHolidayLengthCalendarPolicyOverride({
  ...form,
  localizedDefaultLabel: defaultLabel.value,
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
    return tr(
      `Will add a group workday exception for holiday day ${result.form.dayIndexStart}-${result.form.dayIndexEnd}.`,
      `将新增班组调班规则：节假日第 ${result.form.dayIndexStart}-${result.form.dayIndexEnd} 天改为工作日。`,
    )
  }
  if (result.reason === 'same_length') {
    return tr('No rule is needed because the target rest length equals the base holiday length.', '目标休息天数与基础假期一致，无需新增规则。')
  }
  if (result.reason === 'target_longer_than_base') {
    return tr('Longer-than-base rest spans are not generated automatically in v1; extend the base holiday range or use the advanced table.', 'v1 不自动生成长于基础假期的休息规则；请先延长基础假期范围，或使用高级表格手动配置。')
  }
  return tr('Fill a holiday name, attendance group, and valid day counts before adding a rule.', '请先填写节假日名称、考勤组和有效天数。')
})
</script>
