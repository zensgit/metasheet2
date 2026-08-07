<!--
  #4709 FSER-4 §3 (amendment `docs/development/
  attendance-4709-fser4-member-projection-contract-amendment-20260804.md` §3, RATIFIED
  `45d71c4209af35a63768ce7ce9f576377f6b8ce4`, OD-4709-2=(a)): EMPLOYEE SCHEDULE surface.

  Consumes the NEW member-safe route (GET .../fixed-schedule/effectiveness/me) via the shared
  composable. Allowed projection: state, desired config, own applicability, reason codes -- NO
  unrelated member counts (amendment §3 table). This component never renders `coverage`/`drift`;
  those fields structurally do not exist on the self-parsed result type.
-->
<template>
  <section
    class="attendance-fs-card"
    data-attendance-self-fixed-schedule-card
    aria-live="polite"
  >
    <div class="attendance-fs-card__header">
      <h4>{{ tr('My fixed schedule', '我的固定排班') }}</h4>
      <button
        class="attendance__btn attendance__btn--compact"
        type="button"
        data-attendance-self-fixed-schedule-reload
        :disabled="loadState === 'loading'"
        @click="emit('reload')"
      >
        {{ loadState === 'loading' ? tr('Loading...', '加载中...') : tr('Reload', '重新加载') }}
      </button>
    </div>

    <p v-if="loadState === 'idle'" class="attendance__field-hint" data-attendance-self-fixed-schedule-idle>
      {{ tr('No fixed schedule status loaded yet.', '尚未加载固定排班状态。') }}
    </p>
    <p v-else-if="loadState === 'loading'" class="attendance__field-hint" data-attendance-self-fixed-schedule-loading>
      {{ tr('Loading...', '加载中...') }}
    </p>
    <div
      v-else-if="loadState === 'error'"
      class="attendance-fs-card__unavailable"
      data-attendance-self-fixed-schedule-unavailable
      :data-attendance-self-fixed-schedule-unavailable-reason="unavailableReason || 'error'"
    >
      <strong>{{ unavailableTitle }}</strong>
      <p>{{ unavailableHint }}</p>
    </div>

    <template v-else-if="result">
      <div class="attendance-fs-card__state" data-attendance-self-fixed-schedule-state :data-attendance-self-fixed-schedule-state-value="result.state">
        <span :class="['attendance-fs-state-badge', stateClass]">{{ stateLabel }}</span>
      </div>

      <p
        class="attendance-fs-card__applicability"
        data-attendance-self-fixed-schedule-applicability
        :data-attendance-self-fixed-schedule-applicability-value="result.applicability"
      >
        {{ applicabilityLabel }}
      </p>

      <dl v-if="result.desired" class="attendance-fs-card__desired" data-attendance-self-fixed-schedule-desired>
        <div>
          <dt>{{ tr('Start date', '开始日期') }}</dt>
          <dd>{{ result.desired.startDate }}</dd>
        </div>
        <div>
          <dt>{{ tr('End date', '结束日期') }}</dt>
          <dd>{{ result.desired.endDate }}</dd>
        </div>
      </dl>

      <ul v-if="result.reasonCodes.length > 0" class="attendance-fs-card__reasons" data-attendance-self-fixed-schedule-reasons>
        <li v-for="code in result.reasonCodes" :key="code" :data-attendance-self-fixed-schedule-reason="code">
          {{ reasonLabel(code) }}
        </li>
      </ul>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  attendanceFixedScheduleApplicabilityLabel,
  attendanceFixedScheduleReasonCodeLabel,
  attendanceFixedScheduleStateClass,
  attendanceFixedScheduleStateLabel,
  type AttendanceFixedScheduleReasonCode,
  type AttendanceGroupFixedScheduleSelfResult,
} from './attendanceFixedScheduleEffectiveness'
import type { AttendanceFixedScheduleEffectivenessUnavailableReason } from './useAttendanceFixedScheduleEffectiveness'

type TranslateFn = (en: string, zh: string) => string

const props = defineProps<{
  tr: TranslateFn
  loadState: 'idle' | 'loading' | 'loaded' | 'error'
  unavailableReason?: AttendanceFixedScheduleEffectivenessUnavailableReason | null
  result?: AttendanceGroupFixedScheduleSelfResult | null
}>()

const emit = defineEmits<{ (event: 'reload'): void }>()

const stateLabel = computed(() => (props.result ? attendanceFixedScheduleStateLabel(props.result.state, props.tr) : ''))
const stateClass = computed(() => (props.result ? attendanceFixedScheduleStateClass(props.result.state) : ''))
const applicabilityLabel = computed(() =>
  props.result ? attendanceFixedScheduleApplicabilityLabel(props.result.applicability, props.tr) : '',
)

function reasonLabel(code: AttendanceFixedScheduleReasonCode): string {
  return attendanceFixedScheduleReasonCodeLabel(code, props.tr)
}

const unavailableTitle = computed(() => {
  switch (props.unavailableReason) {
    case 'unauthorized': return props.tr('Sign-in required', '需要登录')
    case 'forbidden': return props.tr('No permission', '无权限查看')
    case 'not_found': return props.tr('Not available for you', '该状态对您不可见')
    case 'db_not_ready': return props.tr('Service not ready', '服务未就绪')
    default: return props.tr('Status unavailable', '状态不可用')
  }
})

const unavailableHint = computed(() => {
  switch (props.unavailableReason) {
    case 'unauthorized': return props.tr('Sign in again to view your fixed schedule status.', '请重新登录后查看您的固定排班状态。')
    case 'forbidden': return props.tr('This status is limited to authorized members.', '该状态仅对有权限的成员开放。')
    case 'not_found': return props.tr('You are not a current member of this group, or it no longer exists.', '您当前不是该考勤组成员，或该组已不存在。')
    case 'db_not_ready': return props.tr('Attendance storage is not ready. Try again later.', '考勤存储未就绪，请稍后重试。')
    default: return props.tr('Loading your status failed. The status is unknown -- it is never assumed.', '加载您的状态失败。未知状态不会被当作任何结论。')
  }
})
</script>

<style scoped>
.attendance-fs-card {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
}

.attendance-fs-card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.attendance-fs-card__unavailable {
  border: 1px solid var(--ms-color-danger);
  border-radius: var(--ms-radius-md);
  padding: var(--ms-space-2);
}

.attendance-fs-card__unavailable p {
  margin: var(--ms-space-1) 0 0;
  color: var(--ms-text-2);
}

.attendance-fs-card__state {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
}

.attendance-fs-card__applicability {
  margin: 0;
  color: var(--ms-text-1);
}

.attendance-fs-card__desired {
  display: flex;
  gap: var(--ms-space-4);
  margin: 0;
}

.attendance-fs-card__desired dt {
  color: var(--ms-text-3);
  font-size: 12px;
}

.attendance-fs-card__desired dd {
  margin: 0;
  color: var(--ms-text-1);
}

.attendance-fs-card__reasons {
  margin: 0;
  padding-left: 1.2em;
  color: var(--ms-text-2);
  font-size: 12px;
}

/* Vue `scoped` styles do not cross component boundaries -- re-declared here rather than relying
   on AttendanceView.vue's scoped `.attendance__*` rules, matching this codebase's established
   sub-component convention (e.g. AttendanceRequestCenterSection.vue). */
.attendance__btn {
  padding: 8px 14px;
  border-radius: 6px;
  border: 1px solid #d0d0d0;
  background: #fff;
  cursor: pointer;
}

.attendance__btn--compact {
  padding: 4px 8px;
}

.attendance__field-hint {
  color: #777;
  font-size: 11px;
}
</style>
