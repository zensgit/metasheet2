<!--
  Dedicated employee 加班申请 card.

  Display / form-UX only. Writes the same `requestForm` object AttendanceView
  already submits through POST /api/attendance/requests. Shift-swap stays on
  the shared collapsed form. First viewport is untouched.

  Duration follows start/end after a manual edit (0.5-hour steps). Existing
  overtime rules (min / rounding / max) stay server-side — this card does not
  invent a client rounding policy. Hours display reuses the leave-card 0.5
  step because the shared overtime form has no tighter hour increment.
-->
<template>
  <section
    class="overtime-card"
    data-attendance-overtime-request-card
    aria-labelledby="attendance-overtime-card-title"
  >
    <header class="overtime-card__header">
      <h3 id="attendance-overtime-card-title">{{ tr('Overtime request', '加班申请') }}</h3>
      <button
        class="overtime-card__text-btn"
        type="button"
        data-overtime-card-cancel="header"
        @click="emit('cancel')"
      >
        {{ tr('Cancel', '取消') }}
      </button>
    </header>

    <label class="overtime-card__field" for="attendance-overtime-card-rule">
      <span>{{ tr('Overtime rule', '加班规则') }}</span>
      <select
        id="attendance-overtime-card-rule"
        name="overtimeCardRule"
        :value="requestForm.overtimeRuleId"
        :disabled="overtimeRules.length === 0"
        data-overtime-card-rule
        @change="onRuleChange"
      >
        <option value="" disabled>{{ tr('Select rule', '选择规则') }}</option>
        <option v-for="rule in overtimeRules" :key="rule.id" :value="rule.id">
          {{ rule.name }}
        </option>
      </select>
      <small v-if="overtimeRules.length === 0" class="overtime-card__hint" data-overtime-card-empty-rules>
        {{
          tr(
            'Ask an attendance admin to enable an active overtime rule before submitting overtime requests.',
            '请联系考勤管理员启用可用加班规则后再提交加班申请。',
          )
        }}
      </small>
    </label>

    <div class="overtime-card__range">
      <label class="overtime-card__field" for="attendance-overtime-card-start">
        <span>{{ tr('Start', '开始') }}</span>
        <input
          id="attendance-overtime-card-start"
          name="overtimeCardStart"
          :value="requestForm.requestedInAt"
          type="datetime-local"
          data-overtime-card-start
          @input="onStartInput"
        />
      </label>
      <label class="overtime-card__field" for="attendance-overtime-card-end">
        <span>{{ tr('End', '结束') }}</span>
        <input
          id="attendance-overtime-card-end"
          name="overtimeCardEnd"
          :value="requestForm.requestedOutAt"
          type="datetime-local"
          data-overtime-card-end
          @input="onEndInput"
        />
      </label>
    </div>

    <div class="overtime-card__duration" data-overtime-card-duration>
      <span class="overtime-card__label">{{ tr('Duration', '时长') }}</span>
      <div class="overtime-card__duration-row">
        <p class="overtime-card__duration-value" data-overtime-card-duration-value>
          <strong>{{ durationDisplayValue }}</strong>
          <span v-if="hasDuration" class="overtime-card__duration-unit">{{ durationUnitLabel }}</span>
        </p>
        <button
          v-if="hasDuration"
          class="overtime-card__switch"
          type="button"
          data-overtime-card-unit-switch
          @click="toggleDurationUnit"
        >
          {{
            durationUnit === 'hours'
              ? tr('Switch to minutes', '改用分钟')
              : tr('Switch to hours', '改用小时')
          }}
        </button>
      </div>
    </div>

    <label class="overtime-card__field" for="attendance-overtime-card-reason">
      <span>{{ tr('Reason', '原因') }}</span>
      <textarea
        id="attendance-overtime-card-reason"
        name="overtimeCardReason"
        v-model="requestForm.reason"
        rows="3"
        data-overtime-card-reason
        :placeholder="tr('Optional', '可选')"
      />
    </label>

    <footer class="overtime-card__footer">
      <button
        class="overtime-card__btn"
        type="button"
        data-overtime-card-cancel="footer"
        @click="emit('cancel')"
      >
        {{ tr('Cancel', '取消') }}
      </button>
      <button
        class="overtime-card__btn overtime-card__btn--primary"
        type="button"
        data-overtime-card-submit
        :disabled="submitting || overtimeRules.length === 0"
        @click="emit('submit')"
      >
        {{ submitting ? tr('Submitting...', '提交中...') : tr('Submit request', '提交申请') }}
      </button>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  formatLeaveDurationHours,
  minutesFromDateTimeRange,
  workDateFromDateTimeLocal,
  type LeaveDurationDisplayUnit,
} from './leaveRequestDurationDisplay'

type TranslateFn = (en: string, zh: string) => string

interface OvertimeRuleOption {
  id: string
  name: string
}

interface OvertimeRequestFormFields {
  overtimeRuleId: string
  requestedInAt: string
  requestedOutAt: string
  reason: string
  workDate: string
  minutes: string
}

const props = defineProps<{
  tr: TranslateFn
  requestForm: OvertimeRequestFormFields
  overtimeRules: OvertimeRuleOption[]
  submitting: boolean
}>()

const emit = defineEmits<{
  cancel: []
  submit: []
}>()

const durationUnit = ref<LeaveDurationDisplayUnit>('hours')

const parsedMinutes = computed(() => {
  const text = String(props.requestForm.minutes ?? '').trim()
  if (text.length === 0) return null
  const value = Number(text)
  return Number.isFinite(value) && value >= 0 ? value : null
})

const hasDuration = computed(() => parsedMinutes.value !== null)

const durationDisplayValue = computed(() => {
  if (parsedMinutes.value === null) return '—'
  if (durationUnit.value === 'minutes') return String(Math.round(parsedMinutes.value))
  return formatLeaveDurationHours(parsedMinutes.value) || '—'
})

const durationUnitLabel = computed(() => (
  durationUnit.value === 'minutes'
    ? props.tr('min', '分钟')
    : props.tr('hours', '小时')
))

function syncMinutesFromRange(): void {
  const minutes = minutesFromDateTimeRange(
    props.requestForm.requestedInAt,
    props.requestForm.requestedOutAt,
  )
  props.requestForm.minutes = minutes === null ? '' : String(minutes)
}

function onRuleChange(event: Event): void {
  props.requestForm.overtimeRuleId = (event.target as HTMLSelectElement).value
}

function onStartInput(event: Event): void {
  const value = (event.target as HTMLInputElement).value
  props.requestForm.requestedInAt = value
  const workDate = workDateFromDateTimeLocal(value)
  if (workDate) props.requestForm.workDate = workDate
  syncMinutesFromRange()
}

function onEndInput(event: Event): void {
  props.requestForm.requestedOutAt = (event.target as HTMLInputElement).value
  syncMinutesFromRange()
}

function toggleDurationUnit(): void {
  durationUnit.value = durationUnit.value === 'hours' ? 'minutes' : 'hours'
}
</script>

<style scoped>
.overtime-card {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  padding: 16px 18px;
  border: none;
  border-radius: 18px;
  background: #fff;
  box-shadow: 0 8px 24px rgba(31, 45, 82, 0.06);
}

.overtime-card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.overtime-card__header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: #1f2329;
}

.overtime-card__text-btn {
  padding: 0;
  border: none;
  background: none;
  color: #8f959e;
  font-size: 13px;
  cursor: pointer;
}

.overtime-card__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
  color: #646a73;
}

.overtime-card__field select,
.overtime-card__field input,
.overtime-card__field textarea {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid #e5e6eb;
  border-radius: 10px;
  background: #fff;
  color: #1f2329;
  font-size: 14px;
}

.overtime-card__field textarea {
  resize: vertical;
  min-height: 72px;
}

.overtime-card__hint {
  color: #8f959e;
  font-size: 12px;
  line-height: 1.4;
}

.overtime-card__range {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
}

.overtime-card__label,
.overtime-card__duration .overtime-card__label {
  display: block;
  font-size: 12px;
  color: #646a73;
}

.overtime-card__duration-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}

.overtime-card__duration-value {
  margin: 4px 0 0;
  color: #1f2329;
  font-size: 28px;
  font-weight: 700;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}

.overtime-card__duration-value strong {
  font-weight: 700;
}

.overtime-card__duration-unit {
  margin-left: 6px;
  font-size: 14px;
  font-weight: 400;
  color: #1f2329;
}

.overtime-card__switch {
  padding: 0;
  border: none;
  background: none;
  color: #3370ff;
  font-size: 13px;
  cursor: pointer;
}

.overtime-card__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.overtime-card__btn {
  padding: 8px 14px;
  border: none;
  border-radius: 10px;
  background: #f2f3f5;
  color: #1f2329;
  font-size: 13px;
  cursor: pointer;
}

.overtime-card__btn--primary {
  background: #3370ff;
  color: #fff;
}

.overtime-card__btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

@media (max-width: 640px) {
  .overtime-card__range {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
