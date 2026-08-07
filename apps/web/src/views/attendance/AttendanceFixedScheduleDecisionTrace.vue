<!--
  #4709 FSER-4 §3 (amendment `docs/development/
  attendance-4709-fser4-member-projection-contract-amendment-20260804.md` §3, RATIFIED
  `45d71c4209af35a63768ce7ce9f576377f6b8ce4`, OD-4709-2=(a)): SELF and ADMIN DECISION TRACE
  surfaces, mirroring the `audience` split `AttendanceDecisionTrace.vue` already uses for the
  unrelated W5-1 explainability trace.

  Self  (audience="self"):  consumes the /me route via the shared composable's `self` result.
                             Projection: desired revision, state, applicability, reason codes.
  Admin (audience="admin"): consumes the admin aggregate route via the shared composable's
                             `admin` result. Projection: desired revision, state, PRODUCER
                             COMPARISON (the drift managed sets -- group-safe values only, no
                             coverage counts, no raw member IDs), reason codes.

  Read-only end to end: the only interactive control is the reload button.
-->
<template>
  <div
    class="attendance-fs-trace"
    data-attendance-fixed-schedule-trace
    :data-attendance-fixed-schedule-trace-audience="audience"
    role="region"
  >
    <p v-if="loadState === 'idle'" class="attendance__field-hint" data-attendance-fixed-schedule-trace-idle>
      {{ tr('No trace loaded yet.', '尚未加载轨迹。') }}
    </p>
    <p v-else-if="loadState === 'loading'" class="attendance__field-hint" data-attendance-fixed-schedule-trace-loading>
      {{ tr('Loading...', '加载中...') }}
    </p>
    <div
      v-else-if="loadState === 'error'"
      class="attendance-fs-trace__unavailable"
      data-attendance-fixed-schedule-trace-unavailable
      :data-attendance-fixed-schedule-trace-unavailable-reason="unavailableReason || 'error'"
    >
      <strong>{{ unavailableTitle }}</strong>
      <p>{{ unavailableHint }}</p>
      <button class="attendance__btn attendance__btn--compact" type="button" data-attendance-fixed-schedule-trace-reload @click="emit('reload')">
        {{ tr('Retry', '重试') }}
      </button>
    </div>

    <template v-else-if="display">
      <div class="attendance-fs-trace__header">
        <div class="attendance-fs-trace__state" data-attendance-fixed-schedule-trace-state :data-attendance-fixed-schedule-trace-state-value="display.state">
          <span :class="['attendance-fs-state-badge', display.stateClass]">{{ display.stateLabel }}</span>
          <span v-if="display.desired" class="attendance-fs-trace__revision" data-attendance-fixed-schedule-trace-revision>
            {{ tr('Revision', '版本') }} {{ display.desired.revision }}
          </span>
        </div>
        <button class="attendance__btn attendance__btn--compact" type="button" data-attendance-fixed-schedule-trace-reload @click="emit('reload')">
          {{ tr('Reload', '重新加载') }}
        </button>
      </div>

      <p
        v-if="display.applicabilityLabel"
        class="attendance-fs-trace__applicability"
        data-attendance-fixed-schedule-trace-applicability
      >
        {{ display.applicabilityLabel }}
      </p>

      <div v-if="display.producerComparison" class="attendance-fs-trace__comparison" data-attendance-fixed-schedule-trace-producer-comparison>
        <h6>{{ tr('Producer comparison', '来源对比') }}</h6>
        <p v-if="display.producerComparison.length === 0" class="attendance__field-hint">
          {{ tr('No superseded managed set -- the desired producer is the only active one.', '不存在待清理的已管理排班——当前唯一生效来源即期望配置。') }}
        </p>
        <table v-else class="attendance__table">
          <thead>
            <tr>
              <th>{{ tr('Superseded window', '被替代窗口') }}</th>
              <th>{{ tr('Rows', '行数') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="set in display.producerComparison" :key="set.producerKey" data-attendance-fixed-schedule-trace-managed-set>
              <td>{{ set.startDate }} – {{ set.endDate }}</td>
              <td>{{ set.rowCount }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <ul v-if="display.reasonCodes.length > 0" class="attendance-fs-trace__reasons" data-attendance-fixed-schedule-trace-reasons>
        <li v-for="code in display.reasonCodes" :key="code" :data-attendance-fixed-schedule-trace-reason="code">
          {{ reasonLabel(code) }}
        </li>
      </ul>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  attendanceFixedScheduleApplicabilityLabel,
  attendanceFixedScheduleReasonCodeLabel,
  attendanceFixedScheduleStateClass,
  attendanceFixedScheduleStateLabel,
  type AttendanceFixedScheduleReasonCode,
  type AttendanceGroupFixedScheduleAdminResult,
  type AttendanceGroupFixedScheduleSelfResult,
} from './attendanceFixedScheduleEffectiveness'
import type { AttendanceFixedScheduleEffectivenessUnavailableReason } from './useAttendanceFixedScheduleEffectiveness'

type TranslateFn = (en: string, zh: string) => string

const props = defineProps<{
  tr: TranslateFn
  audience: 'admin' | 'self'
  loadState: 'idle' | 'loading' | 'loaded' | 'error'
  unavailableReason?: AttendanceFixedScheduleEffectivenessUnavailableReason | null
  adminResult?: AttendanceGroupFixedScheduleAdminResult | null
  selfResult?: AttendanceGroupFixedScheduleSelfResult | null
}>()

const emit = defineEmits<{ (event: 'reload'): void }>()

function reasonLabel(code: AttendanceFixedScheduleReasonCode): string {
  return attendanceFixedScheduleReasonCodeLabel(code, props.tr)
}

// Single derivation point for BOTH audiences -- never a second state/reasonCode switch anywhere
// else in this component or its caller (gate 7). `applicabilityLabel`/`producerComparison` are
// mutually exclusive by audience, never both populated.
const display = computed(() => {
  if (props.audience === 'self') {
    const result = props.selfResult
    if (!result) return null
    return {
      state: result.state,
      stateLabel: attendanceFixedScheduleStateLabel(result.state, props.tr),
      stateClass: attendanceFixedScheduleStateClass(result.state),
      desired: result.desired,
      reasonCodes: result.reasonCodes,
      applicabilityLabel: attendanceFixedScheduleApplicabilityLabel(result.applicability, props.tr),
      producerComparison: null as AttendanceGroupFixedScheduleAdminResult['drift']['managedSets'] | null,
    }
  }
  const result = props.adminResult
  if (!result) return null
  return {
    state: result.state,
    stateLabel: attendanceFixedScheduleStateLabel(result.state, props.tr),
    stateClass: attendanceFixedScheduleStateClass(result.state),
    desired: result.desired,
    reasonCodes: result.reasonCodes,
    applicabilityLabel: null as string | null,
    producerComparison: result.drift.managedSets,
  }
})

const unavailableTitle = computed(() => {
  switch (props.unavailableReason) {
    case 'unauthorized': return props.tr('Sign-in required', '需要登录')
    case 'forbidden': return props.tr('No permission', '无权限查看')
    case 'not_found': return props.tr('Target not found', '目标不存在')
    case 'db_not_ready': return props.tr('Service not ready', '服务未就绪')
    default: return props.tr('Load failed', '加载失败')
  }
})

const unavailableHint = computed(() => {
  switch (props.unavailableReason) {
    case 'unauthorized': return props.tr('Sign in again to view this trace.', '请重新登录后查看该轨迹。')
    case 'forbidden': return props.tr('This trace is limited to authorized users.', '该轨迹仅对有权限的用户开放。')
    case 'not_found': return props.tr('No such group in your scope.', '在您的可见范围内不存在该考勤组。')
    case 'db_not_ready': return props.tr('Attendance storage is not ready. Try again later.', '考勤存储未就绪，请稍后重试。')
    default: return props.tr('Loading the trace failed. The result is unknown -- it is never assumed.', '加载轨迹失败。未知状态不会被当作任何结论。')
  }
})
</script>

<style scoped>
.attendance-fs-trace {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
}

.attendance-fs-trace__unavailable {
  border: 1px solid var(--ms-color-danger);
  border-radius: var(--ms-radius-md);
  padding: var(--ms-space-2);
}

.attendance-fs-trace__unavailable p {
  margin: var(--ms-space-1) 0 0;
  color: var(--ms-text-2);
}

.attendance-fs-trace__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ms-space-2);
}

.attendance-fs-trace__state {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
}

.attendance-fs-trace__revision {
  color: var(--ms-text-3);
  font-size: 12px;
}

.attendance-fs-trace__applicability {
  margin: 0;
  color: var(--ms-text-1);
}

.attendance-fs-trace__comparison h6 {
  margin: 0 0 var(--ms-space-1);
}

.attendance-fs-trace__reasons {
  margin: 0;
  padding-left: 1.2em;
  color: var(--ms-text-2);
  font-size: 12px;
}
</style>
