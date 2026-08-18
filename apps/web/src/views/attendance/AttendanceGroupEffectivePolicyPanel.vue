<!--
  W6-3 (#4556) group effective-policy aggregate panel.

  Governing document:
    docs/development/attendance-issue-4556-w6-group-effective-policy-design-lock-20260805.md §5, §7.4

  Mounted inside `AttendanceGroupContextHost.vue` (the #4711 host) behind the OD-W6-7 gate
  (`hasFeature('attendanceGroupEffectivePolicyPanel')`, default OFF). Gate-OFF: this component is
  never imported into the render tree, so it makes zero API calls and renders nothing.

  §5.4 ("exactly one aggregate GET per explicit open/refresh... keeps no second cached status"):
  the panel starts COLLAPSED and fetches nothing on mount. The host already remounts this
  component on every step/surface change (`groupRouteHostKey` in AttendanceExperienceView.vue) —
  auto-fetch-on-mount would silently multiply GETs on every such remount, which is not "explicit".
  A user click (open, or refresh once open) is the only fetch trigger.

  Every rendered field is bound 1:1 from the closed machine unions via
  `attendanceGroupEffectivePolicyLabels.ts` (§5.5) — no free-text status is composed here, and an
  unrecognized value renders a fixed "unrecognized" indicator rather than a fabricated valid label.
-->
<template>
  <section
    class="attendance-group-effective-policy-panel"
    data-attendance-w6-effective-policy-panel
    :data-attendance-w6-effective-policy-status="status"
  >
    <header class="attendance-group-effective-policy-panel__header">
      <h3 class="attendance-group-effective-policy-panel__title">
        {{ tr('Group effective policy', '组有效策略汇总') }}
      </h3>
      <button
        v-if="status === 'idle'"
        type="button"
        data-attendance-w6-effective-policy-open
        @click="load"
      >
        {{ tr('View', '查看') }}
      </button>
      <button
        v-else-if="status === 'error'"
        type="button"
        data-attendance-w6-effective-policy-retry
        @click="load"
      >
        {{ tr('Retry', '重试') }}
      </button>
      <button
        v-else-if="status === 'ready'"
        type="button"
        data-attendance-w6-effective-policy-refresh
        @click="load"
      >
        {{ tr('Refresh', '刷新') }}
      </button>
    </header>

    <p v-if="status === 'idle'" class="attendance-group-effective-policy-panel__placeholder">
      {{ tr('Not loaded yet.', '尚未加载。') }}
    </p>
    <p v-else-if="status === 'loading'" data-attendance-w6-effective-policy-loading>
      {{ tr('Loading…', '加载中…') }}
    </p>
    <p v-else-if="status === 'unavailable'" data-attendance-w6-effective-policy-unavailable>
      {{ tr('Effective policy is unavailable for this group.', '该组的有效策略当前不可用。') }}
    </p>
    <p v-else-if="status === 'error'" data-attendance-w6-effective-policy-error>
      {{ tr('Unable to load the effective policy.', '无法加载有效策略。') }}
    </p>

    <div v-else-if="status === 'ready' && aggregate" data-attendance-w6-effective-policy-content>
      <dl class="attendance-group-effective-policy-panel__summary">
        <dt>{{ tr('Group type', '考勤类型') }}</dt>
        <dd>{{ groupTypeText }}</dd>
        <dt>{{ tr('Timezone', '时区') }}</dt>
        <dd>{{ aggregate.timezone ?? tr('(none)', '（无）') }}</dd>
        <dt>{{ tr('Active members', '生效成员数') }}</dt>
        <dd>{{ aggregate.activeMemberCount }}</dd>
        <dt>{{ tr('Managers', '管理员') }}</dt>
        <dd>
          {{ tr('owners', '主管理员') }}: {{ managerPosture.ownerCount }},
          {{ tr('sub-owners', '副管理员') }}: {{ managerPosture.subOwnerCount }}
        </dd>
        <dt>{{ tr('Calculation posture', '核算口径') }}</dt>
        <dd>{{ calculationPostureText }}</dd>
      </dl>

      <ul class="attendance-group-effective-policy-panel__domains" data-attendance-w6-effective-policy-domains>
        <li
          v-for="row in domainRows"
          :key="row.key"
          class="attendance-group-effective-policy-panel__domain-row"
        >
          <span class="attendance-group-effective-policy-panel__domain-name">{{ row.domainText }}</span>
          <span class="attendance-group-effective-policy-panel__domain-label">{{ row.labelText }}</span>
          <button
            v-if="row.nav"
            type="button"
            class="attendance-group-effective-policy-panel__domain-action"
            :data-attendance-w6-effective-policy-domain-nav="row.key"
            @click="navigate(row.nav.href)"
          >
            {{ tr('Open', '前往') }}
          </button>
        </li>
      </ul>

      <div
        v-if="fixedSchedule"
        class="attendance-group-effective-policy-panel__fser"
        data-attendance-w6-effective-policy-fser
      >
        <h4>{{ tr('Fixed-schedule effectiveness', '固定排班生效情况') }}</h4>
        <p>{{ tr('State', '状态') }}: {{ fixedScheduleStateText }}</p>
        <p v-if="fixedSchedule.reasonCodes && fixedSchedule.reasonCodes.length">
          {{ tr('Reasons', '原因代码') }}: {{ fixedSchedule.reasonCodes.join(', ') }}
        </p>
        <p v-if="fixedSchedule.coverage" data-attendance-w6-effective-policy-fser-coverage>
          {{ tr('Coverage', '覆盖情况') }}:
          {{ tr('target', '目标') }} {{ fixedSchedule.coverage.targetMembers }},
          {{ tr('matching', '匹配') }} {{ fixedSchedule.coverage.matchingMembers }},
          {{ tr('missing', '缺失') }} {{ fixedSchedule.coverage.missingMembers }},
          {{ tr('non-member targets', '非成员目标') }} {{ fixedSchedule.coverage.nonMemberTargets }},
          {{ tr('different-key rows', '键不一致行') }} {{ fixedSchedule.coverage.differentKeyRows }}
        </p>
        <p v-if="fixedSchedule.drift" data-attendance-w6-effective-policy-fser-drift>
          {{ tr('Drift', '漂移') }}:
          {{ tr('unconfigured', '未配置') }} {{ fixedSchedule.drift.unconfiguredManagedRows }},
          {{ tr('unpublished', '未发布') }} {{ fixedSchedule.drift.unpublishedManagedRows }}
        </p>
      </div>

      <div class="attendance-group-effective-policy-panel__conflicts" data-attendance-w6-effective-policy-conflicts>
        <h4>{{ tr('Conflicts', '冲突') }}</h4>
        <p v-if="conflictRows.length === 0" data-attendance-w6-effective-policy-no-conflicts>
          {{ tr('No conflicts.', '暂无冲突。') }}
        </p>
        <ul v-else>
          <li
            v-for="(row, index) in conflictRows"
            :key="index"
            class="attendance-group-effective-policy-panel__conflict-row"
            data-attendance-w6-effective-policy-conflict-row
          >
            <span>{{ row.codeText }}</span>
            <span>({{ row.domainText }})</span>
            <span v-if="typeof row.affectedUserCount === 'number'">
              {{ tr('affected', '受影响') }}: {{ row.affectedUserCount }}
            </span>
            <button
              v-if="row.nav"
              type="button"
              class="attendance-group-effective-policy-panel__conflict-action"
              :data-attendance-w6-effective-policy-conflict-nav="index"
              @click="navigate(row.nav.href)"
            >
              {{ tr('Resolve', '前往处理') }}
            </button>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useLocale } from '../../composables/useLocale'
import { apiFetch } from '../../utils/api'
import {
  attendanceGroupEffectivePolicyCalculationPostureText,
  attendanceGroupEffectivePolicyConflictCodeText,
  attendanceGroupEffectivePolicyDomainText,
  attendanceGroupEffectivePolicyGroupTypeText,
  attendanceGroupEffectivePolicySourceLabelText,
  attendanceGroupFixedScheduleStateText,
  isAttendanceGroupEffectivePolicyCalculationPostureV1,
  isAttendanceGroupEffectivePolicyConflictCodeV1,
  isAttendanceGroupEffectivePolicyDomainV1,
  isAttendanceGroupEffectivePolicyGroupTypeV1,
  isAttendanceGroupEffectivePolicySourceLabelV1,
  isAttendanceGroupFixedScheduleStateV1,
  parseAttendanceGroupEffectivePolicyEditorRefV1,
  parseAttendanceGroupEffectivePolicyEnvelopeV1,
  resolveAttendanceGroupEffectivePolicyEditorNavigationV1,
  ATTENDANCE_GROUP_EFFECTIVE_POLICY_DOMAIN_SUMMARY_KEYS_V1,
  type AttendanceGroupEffectivePolicyAggregateRawV1,
  type AttendanceGroupEffectivePolicyDomainSummaryKeyV1,
} from './attendanceGroupEffectivePolicyLabels'

const props = defineProps<{
  groupId: string
  returnTo: string
}>()

const { isZh } = useLocale()
const tr = (en: string, zh: string): string => (isZh.value ? zh : en)
const router = useRouter()

type PanelStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'

const status = ref<PanelStatus>('idle')
const aggregate = ref<AttendanceGroupEffectivePolicyAggregateRawV1 | null>(null)

async function load(): Promise<void> {
  status.value = 'loading'
  aggregate.value = null
  try {
    const response = await apiFetch(`/api/attendance/groups/${encodeURIComponent(props.groupId)}/effective-policy`)
    if (response.status === 403 || response.status === 404) {
      status.value = 'unavailable'
      return
    }
    if (!response.ok) {
      status.value = 'error'
      return
    }
    const payload = await response.json()
    const parsed = parseAttendanceGroupEffectivePolicyEnvelopeV1(payload)
    if (!parsed) {
      status.value = 'error'
      return
    }
    aggregate.value = parsed
    status.value = 'ready'
  } catch {
    status.value = 'error'
  }
}

function navigate(href: string): void {
  void router.push(href)
}

const UNRECOGNIZED = () => (isZh.value ? '未识别' : 'Unrecognized')

const groupTypeText = computed(() => {
  const value = aggregate.value?.groupType
  return isAttendanceGroupEffectivePolicyGroupTypeV1(value)
    ? attendanceGroupEffectivePolicyGroupTypeText(value, tr)
    : UNRECOGNIZED()
})

const calculationPostureText = computed(() => {
  const value = aggregate.value?.calculationPosture
  return isAttendanceGroupEffectivePolicyCalculationPostureV1(value)
    ? attendanceGroupEffectivePolicyCalculationPostureText(value, tr)
    : UNRECOGNIZED()
})

const managerPosture = computed(() => {
  const raw = aggregate.value?.managerPosture as { ownerCount?: unknown; subOwnerCount?: unknown } | undefined
  return {
    ownerCount: typeof raw?.ownerCount === 'number' ? raw.ownerCount : 0,
    subOwnerCount: typeof raw?.subOwnerCount === 'number' ? raw.subOwnerCount : 0,
  }
})

interface DomainRow {
  key: AttendanceGroupEffectivePolicyDomainSummaryKeyV1
  domainText: string
  labelText: string
  nav: { kind: 'route' | 'group-list'; href: string } | null
}

const domainRows = computed<DomainRow[]>(() => {
  const domains = aggregate.value?.domains as Record<string, unknown> | undefined
  if (!domains) return []
  const rows: DomainRow[] = []
  for (const [key, domainEnumValue] of Object.entries(ATTENDANCE_GROUP_EFFECTIVE_POLICY_DOMAIN_SUMMARY_KEYS_V1)) {
    const summary = domains[key] as Record<string, unknown> | undefined
    const labelText = summary && isAttendanceGroupEffectivePolicySourceLabelV1(summary.label)
      ? attendanceGroupEffectivePolicySourceLabelText(summary.label, tr)
      : UNRECOGNIZED()
    const editorRef = summary ? parseAttendanceGroupEffectivePolicyEditorRefV1(summary.editorRef) : null
    const nav = editorRef
      ? resolveAttendanceGroupEffectivePolicyEditorNavigationV1(editorRef, {
          groupId: props.groupId,
          returnTo: props.returnTo,
        })
      : null
    rows.push({
      key: key as AttendanceGroupEffectivePolicyDomainSummaryKeyV1,
      domainText: attendanceGroupEffectivePolicyDomainText(domainEnumValue, tr),
      labelText,
      nav,
    })
  }
  return rows
})

const fixedSchedule = computed(() => {
  const domains = aggregate.value?.domains as Record<string, unknown> | undefined
  const schedule = domains?.schedule as Record<string, unknown> | undefined
  const raw = schedule?.fixedSchedule
  if (!raw || typeof raw !== 'object') return null
  return raw as {
    state?: unknown
    reasonCodes?: string[]
    coverage?: { targetMembers: number; matchingMembers: number; missingMembers: number; nonMemberTargets: number; differentKeyRows: number }
    drift?: { unconfiguredManagedRows: number; unpublishedManagedRows: number }
  }
})

const fixedScheduleStateText = computed(() => {
  const value = fixedSchedule.value?.state
  return isAttendanceGroupFixedScheduleStateV1(value) ? attendanceGroupFixedScheduleStateText(value, tr) : UNRECOGNIZED()
})

interface ConflictRow {
  codeText: string
  domainText: string
  affectedUserCount: number | null
  nav: { kind: 'route' | 'group-list'; href: string } | null
}

const conflictRows = computed<ConflictRow[]>(() => {
  const raw = aggregate.value?.conflicts
  if (!Array.isArray(raw)) return []
  return raw.map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>
    const codeText = isAttendanceGroupEffectivePolicyConflictCodeV1(record.code)
      ? attendanceGroupEffectivePolicyConflictCodeText(record.code, tr)
      : UNRECOGNIZED()
    const domainText = isAttendanceGroupEffectivePolicyDomainV1(record.domain)
      ? attendanceGroupEffectivePolicyDomainText(record.domain, tr)
      : UNRECOGNIZED()
    const editorRef = parseAttendanceGroupEffectivePolicyEditorRefV1(record.editorRef)
    const nav = editorRef
      ? resolveAttendanceGroupEffectivePolicyEditorNavigationV1(editorRef, {
          groupId: props.groupId,
          returnTo: props.returnTo,
        })
      : null
    return {
      codeText,
      domainText,
      affectedUserCount: typeof record.affectedUserCount === 'number' ? record.affectedUserCount : null,
      nav,
    }
  })
})
</script>

<style scoped>
.attendance-group-effective-policy-panel {
  padding: 12px;
  border: 1px dashed var(--ms-border-color, #d0d0d0);
  border-radius: 8px;
}
.attendance-group-effective-policy-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.attendance-group-effective-policy-panel__title {
  margin: 0 0 4px;
  font-size: 14px;
}
.attendance-group-effective-policy-panel__placeholder {
  margin: 0;
  font-size: 12px;
  opacity: 0.75;
}
.attendance-group-effective-policy-panel__summary {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  font-size: 12px;
  margin: 8px 0;
}
.attendance-group-effective-policy-panel__domains {
  list-style: none;
  margin: 8px 0;
  padding: 0;
  display: grid;
  gap: 4px;
}
.attendance-group-effective-policy-panel__domain-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.attendance-group-effective-policy-panel__conflicts ul {
  list-style: none;
  margin: 4px 0;
  padding: 0;
  display: grid;
  gap: 4px;
}
.attendance-group-effective-policy-panel__conflict-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
</style>
