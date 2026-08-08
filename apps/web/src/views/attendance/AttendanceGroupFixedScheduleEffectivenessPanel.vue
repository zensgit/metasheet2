<!--
  #4709 FSER-4 §3 (amendment `docs/development/
  attendance-4709-fser4-member-projection-contract-amendment-20260804.md` §3, RATIFIED
  `45d71c4209af35a63768ce7ce9f576377f6b8ce4`, OD-4709-2=(a)): GROUP DRAWER surface.

  Consumes the EXISTING admin aggregate route
  (GET /api/attendance/groups/:groupId/fixed-schedule/effectiveness) via the shared composable.
  Allowed projection (amendment §3 table): state, desired config, counts, drift sets, and the
  EXISTING exact-key actions -- this component is read-only DISPLAY only; the preview/apply/
  rebuild/clear buttons already exist in AttendanceView.vue's "schedule" group-editor stage and
  are unchanged by this slice (no new writable path).

  ZERO status derivation: `state`/`reasonCodes` render through the shared label/class tables in
  `attendanceFixedScheduleEffectiveness.ts`; this component never switches on `coverage`/`drift`
  to pick a badge.
-->
<template>
  <section
    class="attendance-fs-panel"
    data-attendance-fixed-schedule-effectiveness-panel
    aria-live="polite"
  >
    <div class="attendance-fs-panel__header">
      <h6>{{ tr('Fixed schedule status', '固定排班状态') }}</h6>
      <button
        class="attendance__btn attendance__btn--compact"
        type="button"
        data-attendance-fixed-schedule-reload
        :disabled="loadState === 'loading'"
        @click="emit('reload')"
      >
        {{ loadState === 'loading' ? tr('Loading...', '加载中...') : tr('Reload', '重新加载') }}
      </button>
    </div>

    <p v-if="loadState === 'idle'" class="attendance-fs-panel__hint" data-attendance-fixed-schedule-idle>
      {{ tr('No status loaded yet.', '尚未加载状态。') }}
    </p>
    <p v-else-if="loadState === 'loading'" class="attendance-fs-panel__hint" data-attendance-fixed-schedule-loading>
      {{ tr('Loading fixed schedule status...', '正在加载固定排班状态...') }}
    </p>
    <div
      v-else-if="loadState === 'error'"
      class="attendance-fs-panel__unavailable"
      data-attendance-fixed-schedule-unavailable
      :data-attendance-fixed-schedule-unavailable-reason="unavailableReason || 'error'"
    >
      <strong>{{ unavailableTitle }}</strong>
      <p>{{ unavailableHint }}</p>
    </div>

    <template v-else-if="result">
      <div class="attendance-fs-panel__state" data-attendance-fixed-schedule-state :data-attendance-fixed-schedule-state-value="result.state">
        <span :class="['attendance-fs-state-badge', stateClass]">{{ stateLabel }}</span>
        <span v-if="result.desired" class="attendance-fs-panel__revision" data-attendance-fixed-schedule-revision>
          {{ tr('Revision', '版本') }} {{ result.desired.revision }}
        </span>
      </div>

      <dl v-if="result.desired" class="attendance-fs-panel__desired" data-attendance-fixed-schedule-desired>
        <div>
          <dt>{{ tr('Start date', '开始日期') }}</dt>
          <dd>{{ result.desired.startDate }}</dd>
        </div>
        <div>
          <dt>{{ tr('End date', '结束日期') }}</dt>
          <dd>{{ result.desired.endDate }}</dd>
        </div>
      </dl>

      <div class="attendance-fs-panel__counts" data-attendance-fixed-schedule-counts>
        <span data-attendance-fixed-schedule-count="target">{{ tr('Target members', '目标成员') }}: {{ result.coverage.targetMembers }}</span>
        <span data-attendance-fixed-schedule-count="matching">{{ tr('Matching', '已匹配') }}: {{ result.coverage.matchingMembers }}</span>
        <span data-attendance-fixed-schedule-count="missing">{{ tr('Missing', '缺失') }}: {{ result.coverage.missingMembers }}</span>
        <span data-attendance-fixed-schedule-count="non-member">{{ tr('Non-member rows', '非成员行') }}: {{ result.coverage.nonMemberTargets }}</span>
        <span data-attendance-fixed-schedule-count="different-key">{{ tr('Superseded rows', '待清理行') }}: {{ result.coverage.differentKeyRows }}</span>
      </div>

      <ul v-if="result.reasonCodes.length > 0" class="attendance-fs-panel__reasons" data-attendance-fixed-schedule-reasons>
        <li v-for="code in result.reasonCodes" :key="code" :data-attendance-fixed-schedule-reason="code">
          {{ reasonLabel(code) }}
        </li>
      </ul>

      <div v-if="result.drift.managedSets.length > 0" class="attendance-fs-panel__drift" data-attendance-fixed-schedule-drift>
        <h6>{{ tr('Superseded managed sets', '待清理的已管理排班') }}</h6>
        <table class="attendance__table">
          <thead>
            <tr>
              <th>{{ tr('Window', '窗口') }}</th>
              <th>{{ tr('Rows', '行数') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="set in result.drift.managedSets" :key="set.producerKey" data-attendance-fixed-schedule-managed-set>
              <td>{{ set.startDate }} – {{ set.endDate }}</td>
              <td>{{ set.rowCount }}</td>
            </tr>
          </tbody>
        </table>
        <small class="attendance__field-hint">
          {{ tr('Use the exact shift/window above with "Clear managed rows" to retire a superseded set.', '在上方选择对应班次/窗口后使用“清除已管理排班”清理待清理集合。') }}
        </small>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  attendanceFixedScheduleReasonCodeLabel,
  attendanceFixedScheduleStateClass,
  attendanceFixedScheduleStateLabel,
  type AttendanceFixedScheduleReasonCode,
} from './attendanceFixedScheduleEffectiveness'
import type { AttendanceFixedScheduleEffectivenessUnavailableReason } from './useAttendanceFixedScheduleEffectiveness'
import type { AttendanceGroupFixedScheduleAdminResult } from './attendanceFixedScheduleEffectiveness'

type TranslateFn = (en: string, zh: string) => string

const props = defineProps<{
  tr: TranslateFn
  loadState: 'idle' | 'loading' | 'loaded' | 'error'
  unavailableReason?: AttendanceFixedScheduleEffectivenessUnavailableReason | null
  result?: AttendanceGroupFixedScheduleAdminResult | null
}>()

const emit = defineEmits<{ (event: 'reload'): void }>()

const stateLabel = computed(() => (props.result ? attendanceFixedScheduleStateLabel(props.result.state, props.tr) : ''))
const stateClass = computed(() => (props.result ? attendanceFixedScheduleStateClass(props.result.state) : ''))

function reasonLabel(code: AttendanceFixedScheduleReasonCode): string {
  return attendanceFixedScheduleReasonCodeLabel(code, props.tr)
}

const unavailableTitle = computed(() => {
  switch (props.unavailableReason) {
    case 'unauthorized': return props.tr('Sign-in required', '需要登录')
    case 'forbidden': return props.tr('No permission', '无权限查看')
    case 'not_found': return props.tr('Group not found', '未找到考勤组')
    case 'db_not_ready': return props.tr('Service not ready', '服务未就绪')
    default: return props.tr('Status unavailable', '状态不可用')
  }
})

const unavailableHint = computed(() => {
  switch (props.unavailableReason) {
    case 'unauthorized': return props.tr('Sign in again to view this status.', '请重新登录后查看该状态。')
    case 'forbidden': return props.tr('This status is limited to authorized administrators.', '该状态仅对有权限的管理员开放。')
    case 'not_found': return props.tr('This group could not be found in your organization.', '在您的组织内未找到该考勤组。')
    case 'db_not_ready': return props.tr('Attendance storage is not ready. Try again later.', '考勤存储未就绪，请稍后重试。')
    default: return props.tr('Loading this status failed. The status is unknown -- it is never assumed.', '加载该状态失败。未知状态不会被当作任何结论。')
  }
})
</script>

<style scoped>
.attendance-fs-panel {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-md);
  padding: var(--ms-space-3);
  background: var(--ms-bg-card);
}

.attendance-fs-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.attendance-fs-panel__hint {
  margin: 0;
  color: var(--ms-text-2);
}

.attendance-fs-panel__unavailable {
  border: 1px solid var(--ms-color-danger);
  border-radius: var(--ms-radius-md);
  padding: var(--ms-space-2);
  color: var(--ms-text-1);
}

.attendance-fs-panel__unavailable p {
  margin: var(--ms-space-1) 0 0;
  color: var(--ms-text-2);
}

.attendance-fs-panel__state {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
}

.attendance-fs-state-badge {
  padding: 0 var(--ms-space-2);
  border-radius: 999px;
  font-size: 12px;
  line-height: 1.8;
  border: 1px solid var(--ms-border-light);
}

.attendance-fs-state--neutral { color: var(--ms-text-2); }
.attendance-fs-state--warning { color: var(--ms-color-warning); border-color: var(--ms-color-warning); }
.attendance-fs-state--pending { color: var(--ms-color-warning); border-color: var(--ms-color-warning); }
.attendance-fs-state--success { color: var(--ms-color-success); border-color: var(--ms-color-success); }

.attendance-fs-panel__revision {
  color: var(--ms-text-3);
  font-size: 12px;
}

.attendance-fs-panel__desired {
  display: flex;
  gap: var(--ms-space-4);
  margin: 0;
}

.attendance-fs-panel__desired dt {
  color: var(--ms-text-3);
  font-size: 12px;
}

.attendance-fs-panel__desired dd {
  margin: 0;
  color: var(--ms-text-1);
}

.attendance-fs-panel__counts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-3);
  font-size: 12px;
  color: var(--ms-text-2);
}

.attendance-fs-panel__reasons {
  margin: 0;
  padding-left: 1.2em;
  color: var(--ms-text-2);
  font-size: 12px;
}

.attendance-fs-panel__drift h6 {
  margin: 0 0 var(--ms-space-1);
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

.attendance__btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.attendance__field-hint {
  color: #777;
  font-size: 11px;
}

.attendance__table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 12px;
}

.attendance__table th,
.attendance__table td {
  border-bottom: 1px solid #e0e0e0;
  padding: 8px;
  text-align: left;
  font-size: 13px;
}
</style>
