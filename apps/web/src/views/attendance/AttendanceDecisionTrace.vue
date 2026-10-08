<template>
  <div
    class="decision-trace"
    data-attendance-decision-trace
    :data-trace-audience="audience"
    role="region"
    :aria-label="tr('Decision trace', '决策轨迹')"
  >
    <!--
      W5-1 (Wave 5 explainability design-lock, RATIFIED §6): pure DISPLAY component — 「规则依据与
      审计时间线展示」 lives here; 「权威数据加载与字段脱敏」 stays with the parent/backend
      (charter L265 division, verbatim). Props in, one `reload` emit out; ZERO fetch, ZERO writes
      (R1/owner freeze ⑦ — the ONLY button is the read-only reload; no correction/config CTA
      exists anywhere in this tree, "查看更正历史 ≠ 发起更正"). All branch logic lives in
      `attendanceDecisionTrace.ts` (charter L267-268: no discriminator branches hidden in the
      template — this template only renders the pre-derived display model).
    -->
    <div class="decision-trace__state" v-if="loadState === 'idle'" data-trace-idle>
      {{ tr('No explanation loaded yet. Pick a target and query.', '尚未加载解释。请选择目标后查询。') }}
    </div>
    <div class="decision-trace__state" v-else-if="loadState === 'loading'" data-trace-loading>
      {{ tr('Loading decision trace...', '正在加载决策轨迹...') }}
    </div>
    <div
      class="decision-trace__state decision-trace__state--error"
      v-else-if="loadState === 'error'"
      data-trace-error
      :data-trace-error-kind="errorKind || 'error'"
    >
      <strong>{{ errorTitle }}</strong>
      <p>{{ errorHint }}</p>
      <button class="decision-trace__reload" type="button" data-trace-reload @click="emit('reload')">
        {{ tr('Retry', '重试') }}
      </button>
    </div>

    <template v-else-if="display">
      <div class="decision-trace__header">
        <div class="decision-trace__header-copy">
          <h4 class="decision-trace__title" data-trace-category :data-trace-category-value="display.category">
            {{ display.categoryLabel }}
          </h4>
          <span
            class="decision-trace__confidence"
            :class="`decision-trace__confidence--${display.confidence}`"
            data-trace-confidence
            :data-trace-confidence-value="display.confidence"
          >
            {{ display.confidenceLabel }}
          </span>
        </div>
        <button
          class="decision-trace__reload"
          type="button"
          data-trace-reload
          :disabled="loadState !== 'loaded'"
          @click="emit('reload')"
        >
          {{ tr('Reload', '重新加载') }}
        </button>
      </div>

      <!-- Whole-trace fail-closed banner (charter L368 verbatim door). -->
      <p
        v-if="display.confidenceFailClosed"
        class="decision-trace__fail-closed"
        data-trace-fail-closed
      >
        {{ tr(
          'Basis cannot be determined for this result — the evidence chain is incomplete. No explanation is fabricated.',
          '该结果无法确定依据——证据链不完整。系统不会生成貌似合理的解释。',
        ) }}
      </p>

      <p v-if="display.reasonLabel" class="decision-trace__reason" data-trace-reason>
        <span class="decision-trace__reason-label">{{ tr('Reason', '结论归因') }}</span>
        <strong>{{ display.reasonLabel }}</strong>
      </p>

      <dl class="decision-trace__conclusion" data-trace-conclusion>
        <div
          v-for="row in display.conclusionRows"
          :key="row.key"
          class="decision-trace__conclusion-row"
          :data-trace-conclusion-row="row.key"
        >
          <dt>{{ row.label }}</dt>
          <dd>{{ row.value }}</dd>
        </div>
      </dl>

      <!-- ④ coverage-note caliber declaration (§5.2④ — explicit, never silently aligned). -->
      <p v-if="display.coverageNote" class="decision-trace__note" data-trace-coverage-note>
        {{ display.coverageNote }}
      </p>

      <div v-if="display.segments && display.segments.length > 0" class="decision-trace__block" data-trace-segments>
        <h5>{{ tr('Segments', '分段明细') }}</h5>
        <table class="decision-trace__table">
          <thead>
            <tr>
              <th>{{ tr('Day type', '日型') }}</th>
              <th>{{ tr('Minutes', '分钟') }}</th>
              <th>{{ tr('Day-type source', '日型判定来源') }}</th>
              <th>{{ tr('Holiday', '节假日') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="segment in display.segments" :key="segment.key" data-trace-segment>
              <td>{{ segment.dayTypeLabel }}</td>
              <td>{{ segment.minutesLabel }}</td>
              <td>{{ segment.reasonLabel }}</td>
              <td>{{ segment.holidayName || tr('—', '—') }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="display.lots" class="decision-trace__block" data-trace-lots>
        <h5>{{ tr('Active lots', '有效额度批次') }}</h5>
        <p v-if="display.lots.length === 0" class="decision-trace__empty">{{ tr('No active lots.', '无有效批次。') }}</p>
        <table v-else class="decision-trace__table">
          <thead>
            <tr>
              <th>{{ tr('Source', '来源') }}</th>
              <th>{{ tr('Granted at', '授予时间') }}</th>
              <th>{{ tr('Expires', '到期') }}</th>
              <th>{{ tr('Overtime source', '加班来源') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="lot in display.lots"
              :key="lot.key"
              data-trace-lot
              :data-trace-lot-resolved="lot.resolved ? 'mapped' : 'unknown_source'"
            >
              <td :class="{ 'decision-trace__cell--fail-closed': !lot.resolved }">{{ lot.reasonLabel }}</td>
              <td>{{ lot.grantedAtLabel }}</td>
              <td>{{ lot.expiresAtLabel }}</td>
              <td>{{ lot.overtimeSourceLabel || tr('—', '—') }}</td>
            </tr>
          </tbody>
        </table>
        <!-- OD-W5-5=(b) retention boundary disclosure — static because the delete-immunity fix has
             NOT landed (verified at implementation time; see attendanceCompTimeRetentionDisclosure
             for the timing guardrail note). -->
        <p
          v-if="display.retentionDisclosure"
          class="decision-trace__note decision-trace__note--retention"
          data-trace-retention-disclosure
        >
          {{ display.retentionDisclosure }}
        </p>
      </div>

      <div v-if="display.events" class="decision-trace__block" data-trace-events>
        <h5>{{ tr('Balance events', '余额流水') }}</h5>
        <p v-if="display.events.length === 0" class="decision-trace__empty">{{ tr('No events.', '无流水。') }}</p>
        <ul v-else class="decision-trace__timeline">
          <li v-for="event in display.events" :key="event.key" data-trace-event>
            <span class="decision-trace__timeline-at">{{ event.atLabel }}</span>
            <span>{{ event.typeLabel }}</span>
            <span>{{ event.deltaLabel }}</span>
          </li>
        </ul>
      </div>

      <div v-if="display.steps" class="decision-trace__block" data-trace-steps>
        <h5>{{ tr('Approver per step', '各步审批人来源') }}</h5>
        <p v-if="display.steps.length === 0" class="decision-trace__empty">{{ tr('No steps recorded.', '无指派步骤记录。') }}</p>
        <table v-else class="decision-trace__table">
          <thead>
            <tr>
              <th>{{ tr('Step', '步骤') }}</th>
              <th>{{ tr('Source', '来源') }}</th>
              <th>{{ tr('Approver', '审批人') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="step in display.steps" :key="step.key" data-trace-step>
              <td>{{ step.indexLabel }}</td>
              <td :class="{ 'decision-trace__cell--fail-closed': step.failClosed }">
                {{ step.sourceKindLabel }}<template v-if="step.levelLabel">（{{ step.levelLabel }}）</template>
              </td>
              <td>{{ step.actorLabel || tr('(approver pending)', '（审批人待定）') }}</td>
            </tr>
          </tbody>
        </table>
        <!-- §3.3⑥E2: the audit timeline is cited from approval_records (append-only truth source),
             never from the overwritable assignments rows. -->
        <p
          v-if="display.timelineSourceRef"
          class="decision-trace__note"
          data-trace-timeline-source
          :data-trace-timeline-source-ref="display.timelineSourceRef"
        >
          {{ tr('Audit timeline source: approval records (append-only).', '审计时间线以审批流水（approval_records，只增不改）为准。') }}
        </p>
      </div>

      <div class="decision-trace__block" data-trace-basis>
        <h5>{{ tr('Evidence chain', '依据链') }}</h5>
        <ol class="decision-trace__basis">
          <li
            v-for="env in display.basis"
            :key="env.key"
            class="decision-trace__basis-env"
            data-trace-basis-env
            :data-trace-basis-ref="env.refCode"
            :data-trace-posture="env.posture"
          >
            <div class="decision-trace__basis-head">
              <span class="decision-trace__basis-kind">{{ env.sourceKindLabel }}</span>
              <strong class="decision-trace__basis-ref">{{ env.refLabel }}</strong>
              <span
                class="decision-trace__posture"
                :class="`decision-trace__posture--${env.posture}`"
                data-trace-posture-label
              >
                {{ env.postureLabel }}
              </span>
            </div>
            <div class="decision-trace__basis-meta">
              <span v-if="env.asOfLabel" data-trace-as-of>{{ tr('As of', '锚点时刻') }}: {{ env.asOfLabel }}</span>
              <span v-if="env.snapshotVersionLabel" data-trace-snapshot-version>{{ env.snapshotVersionLabel }}</span>
            </div>
            <!-- W5-8 gate: current_live_no_history ALWAYS carries the may-differ declaration. -->
            <p v-if="env.mayDifferNote" class="decision-trace__note decision-trace__note--may-differ" data-trace-may-differ>
              {{ env.mayDifferNote }}
            </p>
            <!-- Fail-closed door: undeterminable env shows the verbatim copy, never a guess. -->
            <p v-if="env.undeterminableNote" class="decision-trace__note decision-trace__note--fail-closed" data-trace-undeterminable>
              {{ env.undeterminableNote }}
            </p>
            <!-- charter L196 organization: 发生了什么 / 谁操作 / 何时. -->
            <p v-if="env.audit" class="decision-trace__audit" data-trace-audit>
              <span>{{ env.audit.kindLabel }}</span>
              <span>· {{ env.audit.atLabel }}</span>
              <span v-if="env.audit.actorLabel" data-trace-audit-actor>· {{ tr('by', '操作人：') }} {{ env.audit.actorLabel }}</span>
            </p>
          </li>
        </ol>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  deriveAttendanceDecisionTraceDisplay,
  type AttendanceDecisionTraceParsed,
  type TranslateFn,
} from './attendanceDecisionTrace'
import type {
  AttendanceDecisionTraceErrorKind,
  AttendanceDecisionTraceLoadState,
} from './useAttendanceDecisionTrace'

const props = withDefaults(
  defineProps<{
    tr: TranslateFn
    audience: 'admin' | 'self'
    loadState: AttendanceDecisionTraceLoadState
    errorKind?: AttendanceDecisionTraceErrorKind | null
    trace?: AttendanceDecisionTraceParsed | null
  }>(),
  {
    errorKind: null,
    trace: null,
  },
)

const emit = defineEmits<{ (event: 'reload'): void }>()

const tr = computed(() => props.tr)

const display = computed(() =>
  props.trace ? deriveAttendanceDecisionTraceDisplay(props.trace, props.tr) : null,
)

// Error copy is values-free (closed error-kind set → fixed copy; no server message echo).
const errorTitle = computed(() => {
  switch (props.errorKind) {
    case 'invalid_target': return tr.value('Query incomplete', '查询条件不完整')
    case 'forbidden': return tr.value('No permission', '无权限查看')
    case 'not_found': return tr.value('Target not found', '目标不存在')
    case 'db_not_ready': return tr.value('Service not ready', '服务未就绪')
    case 'org_required': return tr.value('Organization required', '需要选择组织')
    default: return tr.value('Load failed', '加载失败')
  }
})

const errorHint = computed(() => {
  switch (props.errorKind) {
    case 'invalid_target':
      return tr.value('Fill in the required target fields for this category before querying.', '请先补全该解释类别所需的目标条件再查询。')
    case 'forbidden':
      return tr.value('This explanation is limited to authorized members of the organization.', '该解释仅对本组织有权限的成员开放。')
    case 'not_found':
      return tr.value('No such record in your scope. Nothing is explained for a non-existent target.', '在您的可见范围内不存在该目标。系统不会为不存在的目标生成解释。')
    case 'db_not_ready':
      return tr.value('Attendance storage is not ready. Try again later.', '考勤存储未就绪，请稍后重试。')
    case 'org_required':
      return tr.value('You belong to multiple organizations — pick one to query.', '您属于多个组织，请先选择要查询的组织。')
    default:
      return tr.value('Loading the decision trace failed. The result is unknown — it is never assumed.', '决策轨迹加载失败。未知状态不会被当作任何结论。')
  }
})
</script>

<style scoped>
.decision-trace {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
}

.decision-trace__state {
  padding: var(--ms-space-4);
  border: 1px dashed var(--ms-border-light);
  border-radius: var(--ms-radius-md);
  color: var(--ms-text-2);
}

.decision-trace__state--error {
  border-color: var(--ms-color-danger);
  color: var(--ms-text-1);
}

.decision-trace__state--error p {
  margin: var(--ms-space-1) 0 var(--ms-space-2);
  color: var(--ms-text-2);
}

.decision-trace__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--ms-space-2);
  flex-wrap: wrap;
}

.decision-trace__header-copy {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
  flex-wrap: wrap;
}

.decision-trace__title {
  margin: 0;
  color: var(--ms-text-1);
  font-size: var(--ms-font-size-section-title);
  font-weight: var(--ms-font-weight-title);
}

.decision-trace__confidence {
  padding: 0 var(--ms-space-2);
  border-radius: 999px;
  font-size: 12px;
  line-height: 1.8;
  border: 1px solid var(--ms-border-light);
  color: var(--ms-text-2);
  background: var(--ms-bg-page);
}

.decision-trace__confidence--grounded {
  border-color: var(--ms-color-success);
  color: var(--ms-color-success);
}

.decision-trace__confidence--partial {
  border-color: var(--ms-color-warning);
  color: var(--ms-color-warning);
}

.decision-trace__confidence--undeterminable {
  border-color: var(--ms-color-danger);
  color: var(--ms-color-danger);
}

.decision-trace__reload {
  border: 1px solid var(--ms-border-light);
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  border-radius: var(--ms-radius-md);
  padding: var(--ms-space-1) var(--ms-space-3);
  cursor: pointer;
}

.decision-trace__reload:disabled {
  opacity: 0.6;
  cursor: default;
}

.decision-trace__fail-closed {
  margin: 0;
  padding: var(--ms-space-2) var(--ms-space-3);
  border: 1px solid var(--ms-color-danger);
  border-radius: var(--ms-radius-md);
  color: var(--ms-color-danger);
  background: var(--ms-bg-page);
}

.decision-trace__reason {
  margin: 0;
  display: flex;
  gap: var(--ms-space-2);
  align-items: baseline;
  color: var(--ms-text-1);
}

.decision-trace__reason-label {
  color: var(--ms-text-3);
  font-size: 12px;
}

.decision-trace__conclusion {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
  gap: var(--ms-space-2);
}

.decision-trace__conclusion-row {
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-md);
  padding: var(--ms-space-2);
  background: var(--ms-bg-card);
}

.decision-trace__conclusion-row dt {
  color: var(--ms-text-3);
  font-size: 12px;
}

.decision-trace__conclusion-row dd {
  margin: var(--ms-space-1) 0 0;
  color: var(--ms-text-1);
  font-weight: var(--ms-font-weight-title);
  overflow-wrap: anywhere;
}

.decision-trace__block h5 {
  margin: 0 0 var(--ms-space-2);
  color: var(--ms-text-1);
}

.decision-trace__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.decision-trace__table th,
.decision-trace__table td {
  text-align: left;
  padding: var(--ms-space-1) var(--ms-space-2);
  border-bottom: 1px solid var(--ms-border-light);
  color: var(--ms-text-1);
  overflow-wrap: anywhere;
}

.decision-trace__table th {
  color: var(--ms-text-3);
  font-weight: var(--ms-font-weight-title);
}

.decision-trace__cell--fail-closed {
  color: var(--ms-color-danger);
}

.decision-trace__empty {
  margin: 0;
  color: var(--ms-text-3);
}

.decision-trace__timeline {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
}

.decision-trace__timeline li {
  display: flex;
  gap: var(--ms-space-2);
  flex-wrap: wrap;
  color: var(--ms-text-1);
}

.decision-trace__timeline-at {
  color: var(--ms-text-3);
  font-variant-numeric: tabular-nums;
}

.decision-trace__basis {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
}

.decision-trace__basis-env {
  border: 1px solid var(--ms-border-light);
  border-left: 3px solid var(--ms-border-light);
  border-radius: var(--ms-radius-md);
  padding: var(--ms-space-2) var(--ms-space-3);
  background: var(--ms-bg-card);
}

.decision-trace__basis-env[data-trace-posture='snapshot_frozen'] {
  border-left-color: var(--ms-color-success);
}

.decision-trace__basis-env[data-trace-posture='current_live_no_history'] {
  border-left-color: var(--ms-color-warning);
}

.decision-trace__basis-env[data-trace-posture='undeterminable'] {
  border-left-color: var(--ms-color-danger);
}

.decision-trace__basis-head {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
  flex-wrap: wrap;
}

.decision-trace__basis-kind {
  font-size: 12px;
  color: var(--ms-text-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 999px;
  padding: 0 var(--ms-space-2);
}

.decision-trace__basis-ref {
  color: var(--ms-text-1);
  overflow-wrap: anywhere;
}

.decision-trace__posture {
  font-size: 12px;
  color: var(--ms-text-2);
}

.decision-trace__posture--undeterminable {
  color: var(--ms-color-danger);
}

.decision-trace__posture--current_live_no_history {
  color: var(--ms-color-warning);
}

.decision-trace__basis-meta {
  display: flex;
  gap: var(--ms-space-3);
  flex-wrap: wrap;
  margin-top: var(--ms-space-1);
  color: var(--ms-text-3);
  font-size: 12px;
}

.decision-trace__note {
  margin: var(--ms-space-1) 0 0;
  color: var(--ms-text-2);
  font-size: 12px;
}

.decision-trace__note--may-differ {
  color: var(--ms-color-warning);
}

.decision-trace__note--fail-closed {
  color: var(--ms-color-danger);
}

.decision-trace__note--retention {
  color: var(--ms-text-2);
  border-top: 1px dashed var(--ms-border-light);
  padding-top: var(--ms-space-1);
}

.decision-trace__audit {
  margin: var(--ms-space-1) 0 0;
  color: var(--ms-text-2);
  font-size: 12px;
  display: flex;
  gap: var(--ms-space-1);
  flex-wrap: wrap;
}
</style>
