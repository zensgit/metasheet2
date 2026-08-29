<!--
  Dedicated employee 补卡申请 card (owner lock 2026-08-29).

  Display / form-UX only. Writes the same `requestForm` object AttendanceView
  already submits through POST /api/attendance/requests. Leave / overtime /
  shift-swap stay on the shared collapsed form. First viewport is untouched.

  Prefill uses the existing non-pending anomaly rule. Pending-only / empty
  lists stay hand-fill — this card does not invent an anomaly type.
-->
<template>
  <section
    class="makeup-card"
    data-attendance-makeup-request-card
    aria-labelledby="attendance-makeup-card-title"
  >
    <header class="makeup-card__header">
      <h3 id="attendance-makeup-card-title">{{ tr('Makeup punch request', '补卡申请') }}</h3>
      <button
        class="makeup-card__text-btn"
        type="button"
        data-makeup-card-cancel="header"
        @click="emit('cancel')"
      >
        {{ tr('Cancel', '取消') }}
      </button>
    </header>

    <label class="makeup-card__field" for="attendance-makeup-card-anomaly">
      <span>{{ tr('Anomaly', '异常') }}</span>
      <select
        id="attendance-makeup-card-anomaly"
        name="makeupCardAnomaly"
        :value="selectedAnomalyKey"
        :disabled="anomalies.length === 0"
        data-makeup-card-anomaly
        @change="onAnomalyChange"
      >
        <option value="" disabled>{{ anomalyPlaceholder }}</option>
        <option
          v-for="item in anomalies"
          :key="makeupAnomalyKey(item)"
          :value="makeupAnomalyKey(item)"
        >
          {{ formatMakeupAnomalyOptionLabel(item, todayWorkDate, tr) }}
        </option>
      </select>
    </label>

    <label class="makeup-card__field" for="attendance-makeup-card-time">
      <span>{{ tr('Makeup time', '补卡时间') }}</span>
      <input
        id="attendance-makeup-card-time"
        name="makeupCardTime"
        :value="makeupTimeValue"
        type="datetime-local"
        data-makeup-card-time
        @input="onTimeInput"
      />
    </label>

    <label class="makeup-card__field" for="attendance-makeup-card-reason">
      <span>{{ tr('Reason', '原因') }}</span>
      <input
        id="attendance-makeup-card-reason"
        name="makeupCardReason"
        v-model="requestForm.reason"
        type="text"
        data-makeup-card-reason
        :placeholder="tr('Optional', '可选')"
      />
    </label>

    <p class="makeup-card__hint" data-makeup-card-hint>
      {{
        tr(
          'If there is no eligible anomaly, fill the time and reason by hand. Pending requests are not prefilled.',
          '没有可补的异常就手填时间和原因。审批中的不预填。',
        )
      }}
    </p>

    <footer class="makeup-card__footer">
      <button
        class="makeup-card__btn"
        type="button"
        data-makeup-card-cancel="footer"
        @click="emit('cancel')"
      >
        {{ tr('Cancel', '取消') }}
      </button>
      <button
        class="makeup-card__btn makeup-card__btn--primary"
        type="button"
        data-makeup-card-submit
        :disabled="submitting"
        @click="emit('submit')"
      >
        {{ submitting ? tr('Submitting...', '提交中...') : tr('Submit request', '提交申请') }}
      </button>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  formatMakeupAnomalyOptionLabel,
  makeupAnomalyKey,
  makeupTimeFieldForRequestType,
  resolveMakeupRequestType,
  workDateFromDateTimeLocal,
  type MakeupAnomalyPrefillItem,
} from './makeupRequestCardPrefill'

type TranslateFn = (en: string, zh: string) => string

interface MakeupRequestFormFields {
  workDate: string
  requestType: string
  requestedInAt: string
  requestedOutAt: string
  reason: string
}

const props = defineProps<{
  tr: TranslateFn
  requestForm: MakeupRequestFormFields
  anomalies: MakeupAnomalyPrefillItem[]
  todayWorkDate: string
  submitting: boolean
}>()

const emit = defineEmits<{
  cancel: []
  submit: []
}>()

const selectedAnomalyKey = computed(() => {
  const match = props.anomalies.find(item =>
    item.workDate === props.requestForm.workDate
    && resolveMakeupRequestType(item) === props.requestForm.requestType,
  )
  return match ? makeupAnomalyKey(match) : ''
})

const anomalyPlaceholder = computed(() => (
  props.anomalies.length === 0
    ? props.tr('No eligible anomaly — fill by hand', '没有可补异常，请手填')
    : props.tr('Select an anomaly', '选择异常')
))

const timeField = computed(() => makeupTimeFieldForRequestType(props.requestForm.requestType))

const makeupTimeValue = computed(() => props.requestForm[timeField.value])

function onAnomalyChange(event: Event): void {
  const key = (event.target as HTMLSelectElement).value
  const item = props.anomalies.find(candidate => makeupAnomalyKey(candidate) === key)
  if (!item) return
  const previousField = timeField.value
  const nextType = resolveMakeupRequestType(item)
  const nextField = makeupTimeFieldForRequestType(nextType)
  const existingTime = props.requestForm[previousField]
  props.requestForm.workDate = item.workDate
  props.requestForm.requestType = nextType
  if (previousField !== nextField && existingTime) {
    props.requestForm[nextField] = existingTime
    props.requestForm[previousField] = ''
  }
}

function onTimeInput(event: Event): void {
  const value = (event.target as HTMLInputElement).value
  props.requestForm[timeField.value] = value
  const workDate = workDateFromDateTimeLocal(value)
  if (workDate) props.requestForm.workDate = workDate
}
</script>

<style scoped>
.makeup-card {
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

.makeup-card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.makeup-card__header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: #1f2329;
}

.makeup-card__text-btn {
  padding: 0;
  border: none;
  background: none;
  color: #8f959e;
  font-size: 13px;
  cursor: pointer;
}

.makeup-card__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
  color: #646a73;
}

.makeup-card__field select,
.makeup-card__field input {
  width: 100%;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid #e5e6eb;
  border-radius: 10px;
  background: #fff;
  color: #1f2329;
  font-size: 14px;
}

.makeup-card__hint {
  margin: 0;
  color: #8f959e;
  font-size: 12px;
  line-height: 1.4;
}

.makeup-card__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.makeup-card__btn {
  padding: 8px 14px;
  border: none;
  border-radius: 10px;
  background: #f2f3f5;
  color: #1f2329;
  font-size: 13px;
  cursor: pointer;
}

.makeup-card__btn--primary {
  background: #3370ff;
  color: #fff;
}

.makeup-card__btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
</style>
