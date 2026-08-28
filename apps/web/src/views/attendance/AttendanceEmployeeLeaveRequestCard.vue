<!--
  Dedicated employee 请假申请 card (owner lock 2026-08-28).

  Display / form-UX only. Writes the same `requestForm` object AttendanceView
  already submits through POST /api/attendance/requests. Makeup / overtime /
  shift-swap stay on the shared collapsed form. First viewport is untouched.

  Duration follows start/end after a manual edit (0.5-hour steps). A preset
  click is a one-time seed from halfDayLeaveHelper (shift window + leave type
  defaultMinutesPerDay) — not a second day-length.
-->
<template>
  <section
    class="leave-card"
    data-attendance-leave-request-card
    aria-labelledby="attendance-leave-card-title"
  >
    <header class="leave-card__header">
      <h3 id="attendance-leave-card-title">{{ tr('Leave request', '请假申请') }}</h3>
      <button
        class="leave-card__text-btn"
        type="button"
        data-leave-card-cancel="header"
        @click="emit('cancel')"
      >
        {{ tr('Cancel', '取消') }}
      </button>
    </header>

    <label class="leave-card__field" for="attendance-leave-card-type">
      <span>{{ tr('Leave type', '假期类型') }}</span>
      <select
        id="attendance-leave-card-type"
        name="leaveCardType"
        :value="requestForm.leaveTypeId"
        :disabled="leaveTypes.length === 0"
        data-leave-card-type
        @change="onLeaveTypeChange"
      >
        <option value="" disabled>{{ tr('Select leave type', '选择假期类型') }}</option>
        <option v-for="item in leaveTypes" :key="item.id" :value="item.id">
          {{ item.name }}
        </option>
      </select>
      <small v-if="leaveTypes.length === 0" class="leave-card__hint" data-leave-card-empty-types>
        {{
          tr(
            'Ask an attendance admin to enable an active leave type before submitting leave requests.',
            '请联系考勤管理员启用可用请假类型后再提交请假申请。',
          )
        }}
      </small>
    </label>

    <div class="leave-card__presets" data-leave-card-presets role="group" :aria-label="tr('Time preset', '时段')">
      <button
        v-for="preset in presets"
        :key="preset.kind"
        class="leave-card__preset"
        :class="{ 'leave-card__preset--active': activePreset === preset.kind }"
        type="button"
        :disabled="!canQuickFill"
        :data-leave-card-preset="preset.kind"
        :aria-pressed="activePreset === preset.kind"
        @click="onPreset(preset.kind)"
      >
        {{ preset.label }}
      </button>
    </div>

    <div class="leave-card__range">
      <label class="leave-card__field" for="attendance-leave-card-start">
        <span>{{ tr('Start', '开始') }}</span>
        <input
          id="attendance-leave-card-start"
          name="leaveCardStart"
          :value="requestForm.requestedInAt"
          type="datetime-local"
          data-leave-card-start
          @input="onStartInput"
        />
      </label>
      <label class="leave-card__field" for="attendance-leave-card-end">
        <span>{{ tr('End', '结束') }}</span>
        <input
          id="attendance-leave-card-end"
          name="leaveCardEnd"
          :value="requestForm.requestedOutAt"
          type="datetime-local"
          data-leave-card-end
          @input="onEndInput"
        />
      </label>
    </div>

    <div class="leave-card__duration" data-leave-card-duration>
      <span class="leave-card__label">{{ tr('Duration', '时长') }}</span>
      <div class="leave-card__duration-row">
        <p class="leave-card__duration-value" data-leave-card-duration-value>
          <strong>{{ durationDisplayValue }}</strong>
          <span v-if="hasDuration" class="leave-card__duration-unit">{{ durationUnitLabel }}</span>
        </p>
        <button
          v-if="hasDuration"
          class="leave-card__switch"
          type="button"
          data-leave-card-unit-switch
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

    <label
      v-if="selectedLeaveType?.requiresAttachment"
      class="leave-card__field"
      for="attendance-leave-card-attachment"
    >
      <span>{{ tr('Attachment URL', '附件链接') }}</span>
      <input
        id="attendance-leave-card-attachment"
        name="leaveCardAttachment"
        v-model="requestForm.attachmentUrl"
        type="text"
        data-leave-card-attachment
        :placeholder="tr('Required for this leave type', '该假种需要附件')"
      />
    </label>

    <label class="leave-card__field" for="attendance-leave-card-reason">
      <span>{{ tr('Reason', '原因') }}</span>
      <textarea
        id="attendance-leave-card-reason"
        name="leaveCardReason"
        v-model="requestForm.reason"
        rows="3"
        data-leave-card-reason
        :placeholder="tr('Optional', '可选')"
      />
    </label>

    <footer class="leave-card__footer">
      <button
        class="leave-card__btn"
        type="button"
        data-leave-card-cancel="footer"
        @click="emit('cancel')"
      >
        {{ tr('Cancel', '取消') }}
      </button>
      <button
        class="leave-card__btn leave-card__btn--primary"
        type="button"
        data-leave-card-submit
        :disabled="submitting || leaveTypes.length === 0"
        @click="emit('submit')"
      >
        {{ submitting ? tr('Submitting...', '提交中...') : tr('Submit request', '提交申请') }}
      </button>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AttendanceLeaveQuickFillKind } from './halfDayLeaveHelper'
import {
  formatLeaveDurationHours,
  minutesFromDateTimeRange,
  workDateFromDateTimeLocal,
  type LeaveDurationDisplayUnit,
} from './leaveRequestDurationDisplay'

type TranslateFn = (en: string, zh: string) => string

interface LeaveTypeOption {
  id: string
  name: string
  requiresAttachment?: boolean
}

interface LeaveRequestFormFields {
  leaveTypeId: string
  requestedInAt: string
  requestedOutAt: string
  reason: string
  attachmentUrl: string
  workDate: string
  minutes: string
}

const props = defineProps<{
  tr: TranslateFn
  requestForm: LeaveRequestFormFields
  leaveTypes: LeaveTypeOption[]
  canQuickFill: boolean
  submitting: boolean
}>()

const emit = defineEmits<{
  cancel: []
  submit: []
  quickFill: [kind: AttendanceLeaveQuickFillKind]
}>()

const durationUnit = ref<LeaveDurationDisplayUnit>('hours')
const activePreset = ref<AttendanceLeaveQuickFillKind | null>(null)

const presets = computed(() => [
  { kind: 'full_day' as const, label: props.tr('Full day', '全天') },
  { kind: 'morning_half' as const, label: props.tr('Morning', '上午') },
  { kind: 'afternoon_half' as const, label: props.tr('Afternoon', '下午') },
])

const selectedLeaveType = computed(
  () => props.leaveTypes.find(item => item.id === props.requestForm.leaveTypeId) ?? null,
)

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
  if (minutes === null) return
  props.requestForm.minutes = String(minutes)
}

function onLeaveTypeChange(event: Event): void {
  props.requestForm.leaveTypeId = (event.target as HTMLSelectElement).value
}

function onStartInput(event: Event): void {
  const value = (event.target as HTMLInputElement).value
  props.requestForm.requestedInAt = value
  activePreset.value = null
  const workDate = workDateFromDateTimeLocal(value)
  if (workDate) props.requestForm.workDate = workDate
  syncMinutesFromRange()
}

function onEndInput(event: Event): void {
  props.requestForm.requestedOutAt = (event.target as HTMLInputElement).value
  activePreset.value = null
  syncMinutesFromRange()
}

function onPreset(kind: AttendanceLeaveQuickFillKind): void {
  activePreset.value = kind
  emit('quickFill', kind)
}

function toggleDurationUnit(): void {
  durationUnit.value = durationUnit.value === 'hours' ? 'minutes' : 'hours'
}
</script>

<style scoped>
.leave-card {
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

.leave-card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.leave-card__header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: #1f2329;
}

.leave-card__text-btn {
  padding: 0;
  border: none;
  background: none;
  color: #8f959e;
  font-size: 13px;
  cursor: pointer;
}

.leave-card__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
  color: #646a73;
}

.leave-card__field select,
.leave-card__field input,
.leave-card__field textarea {
  width: 100%;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid #e5e6eb;
  border-radius: 10px;
  background: #fff;
  color: #1f2329;
  font-size: 14px;
}

.leave-card__field textarea {
  resize: vertical;
  min-height: 72px;
}

.leave-card__hint {
  color: #8f959e;
  font-size: 12px;
  line-height: 1.4;
}

.leave-card__presets {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.leave-card__preset {
  padding: 8px 10px;
  border: none;
  border-radius: 10px;
  background: #f2f3f5;
  color: #1f2329;
  font-size: 13px;
  cursor: pointer;
}

.leave-card__preset:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.leave-card__preset--active {
  background: #e8f1ff;
  color: #3370ff;
  font-weight: 600;
}

.leave-card__range {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
}

.leave-card__label,
.leave-card__duration .leave-card__label {
  display: block;
  font-size: 12px;
  color: #646a73;
}

.leave-card__duration-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}

.leave-card__duration-value {
  margin: 4px 0 0;
  color: #1f2329;
  font-size: 28px;
  font-weight: 700;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}

.leave-card__duration-value strong {
  font-weight: 700;
}

.leave-card__duration-unit {
  margin-left: 6px;
  font-size: 14px;
  font-weight: 400;
  color: #1f2329;
}

.leave-card__switch {
  padding: 0;
  border: none;
  background: none;
  color: #3370ff;
  font-size: 13px;
  cursor: pointer;
}

.leave-card__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.leave-card__btn {
  padding: 8px 14px;
  border: none;
  border-radius: 10px;
  background: #f2f3f5;
  color: #1f2329;
  font-size: 13px;
  cursor: pointer;
}

.leave-card__btn--primary {
  background: #3370ff;
  color: #fff;
}

.leave-card__btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

@media (max-width: 640px) {
  .leave-card__range {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
