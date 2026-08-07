<!--
  #4709 FSER-4 §3 (amendment `docs/development/
  attendance-4709-fser4-member-projection-contract-amendment-20260804.md` §3, RATIFIED
  `45d71c4209af35a63768ce7ce9f576377f6b8ce4`, OD-4709-2=(a)): REPORT surface.

  Consumes the EXISTING admin aggregate route via the shared composable. Allowed projection
  (amendment §3 table): group state and counts only -- NO actions, NO raw IDs. This component
  therefore never reads `result.groupId`, `result.desired.shiftId`, or `result.drift` into the
  DOM; only `result.state` and `result.coverage` are rendered. The groupId INPUT below is an
  admin-typed identifier (mirrors the existing free-text admin-trace userId input pattern in
  AttendanceView.vue) -- reports mode does not preload a groups list (`loadAttendanceGroups()` is
  gated on admin mode), so this mirrors existing precedent rather than inventing a new group-list
  fetch. Flagged in the PR body for the reviewer to reconsider if a select-from-list is preferred.
-->
<template>
  <section class="attendance__card" data-attendance-fixed-schedule-report-widget>
    <div class="attendance__requests-header">
      <div>
        <h3>{{ tr('Fixed schedule status by group', '按考勤组查看固定排班状态') }}</h3>
        <small class="attendance__field-hint">
          {{ tr('Group state and coverage counts only. No member identifiers.', '仅显示考勤组状态与覆盖计数，不含成员标识。') }}
        </small>
      </div>
    </div>
    <div class="attendance__admin-grid">
      <label class="attendance__field" for="attendance-fixed-schedule-report-group-id">
        <span>{{ tr('Group ID', '考勤组 ID') }}</span>
        <input
          id="attendance-fixed-schedule-report-group-id"
          v-model.trim="groupIdInput"
          type="text"
          data-attendance-fixed-schedule-report-group-id
        />
      </label>
    </div>
    <div class="attendance__admin-actions">
      <button
        class="attendance__btn attendance__btn--primary"
        type="button"
        data-attendance-fixed-schedule-report-load
        :disabled="loadState === 'loading'"
        @click="emit('load', groupIdInput)"
      >
        {{ loadState === 'loading' ? tr('Loading...', '加载中...') : tr('Load status', '查询状态') }}
      </button>
    </div>

    <p v-if="loadState === 'idle'" class="attendance__field-hint" data-attendance-fixed-schedule-report-idle>
      {{ tr('Enter a group ID and load its fixed schedule status.', '输入考勤组 ID 后查询其固定排班状态。') }}
    </p>
    <div
      v-else-if="loadState === 'error'"
      class="attendance-fs-report__unavailable"
      data-attendance-fixed-schedule-report-unavailable
      :data-attendance-fixed-schedule-report-unavailable-reason="unavailableReason || 'error'"
    >
      <strong>{{ unavailableTitle }}</strong>
    </div>

    <div v-else-if="loadState === 'loaded' && result" class="attendance-fs-report__result" data-attendance-fixed-schedule-report-result>
      <div class="attendance-fs-report__state" data-attendance-fixed-schedule-report-state :data-attendance-fixed-schedule-report-state-value="result.state">
        <span :class="['attendance-fs-state-badge', stateClass]">{{ stateLabel }}</span>
      </div>
      <div class="attendance-fs-report__counts" data-attendance-fixed-schedule-report-counts>
        <span data-attendance-fixed-schedule-report-count="target">{{ tr('Target members', '目标成员') }}: {{ result.coverage.targetMembers }}</span>
        <span data-attendance-fixed-schedule-report-count="matching">{{ tr('Matching', '已匹配') }}: {{ result.coverage.matchingMembers }}</span>
        <span data-attendance-fixed-schedule-report-count="missing">{{ tr('Missing', '缺失') }}: {{ result.coverage.missingMembers }}</span>
        <span data-attendance-fixed-schedule-report-count="non-member">{{ tr('Non-member rows', '非成员行') }}: {{ result.coverage.nonMemberTargets }}</span>
        <span data-attendance-fixed-schedule-report-count="different-key">{{ tr('Superseded rows', '待清理行') }}: {{ result.coverage.differentKeyRows }}</span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  attendanceFixedScheduleStateClass,
  attendanceFixedScheduleStateLabel,
  type AttendanceGroupFixedScheduleAdminResult,
} from './attendanceFixedScheduleEffectiveness'
import type { AttendanceFixedScheduleEffectivenessUnavailableReason } from './useAttendanceFixedScheduleEffectiveness'

type TranslateFn = (en: string, zh: string) => string

const props = defineProps<{
  tr: TranslateFn
  loadState: 'idle' | 'loading' | 'loaded' | 'error'
  unavailableReason?: AttendanceFixedScheduleEffectivenessUnavailableReason | null
  // Report projection is intentionally narrower than the full admin result type: only
  // `state`/`coverage` are ever read below. The prop type still carries the full result (it IS
  // the shared parser's output) so the widget cannot silently drift from the shared shape, but no
  // template expression below ever reads `.groupId`, `.desired`, or `.drift`.
  result?: AttendanceGroupFixedScheduleAdminResult | null
}>()

const emit = defineEmits<{ (event: 'load', groupId: string): void }>()

const groupIdInput = ref('')

const stateLabel = computed(() => (props.result ? attendanceFixedScheduleStateLabel(props.result.state, props.tr) : ''))
const stateClass = computed(() => (props.result ? attendanceFixedScheduleStateClass(props.result.state) : ''))

const unavailableTitle = computed(() => {
  switch (props.unavailableReason) {
    case 'unauthorized': return props.tr('Sign-in required', '需要登录')
    case 'forbidden': return props.tr('No permission', '无权限查看')
    case 'not_found': return props.tr('Group not found', '未找到考勤组')
    case 'db_not_ready': return props.tr('Service not ready', '服务未就绪')
    default: return props.tr('Status unavailable', '状态不可用')
  }
})
</script>

<style scoped>
.attendance-fs-report__unavailable {
  border: 1px solid var(--ms-color-danger);
  border-radius: var(--ms-radius-md);
  padding: var(--ms-space-2);
}

.attendance-fs-report__result {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
}

.attendance-fs-report__counts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-3);
  font-size: 12px;
  color: var(--ms-text-2);
}
</style>
