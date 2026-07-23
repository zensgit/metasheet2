// W4-1 evidence harness entry (copied to apps/web/src/dev-harness/w41SetupReadinessHarness.ts at
// capture time by capture-setup-readiness.mjs; removed afterwards). Mounts the REAL wizard shell
// with the REAL design tokens and the same synthetic fixtures the mounted spec uses
// (apps/web/tests/AttendanceSetupReadiness.spec.ts — charter §8.1: synthetic fixtures only).
// Scenario/role come from the query string: ?scenario=all-ready|mixed-missing&role=admin|delegated
import { createApp } from 'vue'
import '../styles/tokens.css'
import AttendanceSetupReadiness from '../views/attendance/AttendanceSetupReadiness.vue'
import {
  ATTENDANCE_SETUP_STEP_IDS,
  deriveAttendanceSetupReadinessSteps,
  type AttendanceSetupReadinessResponse,
} from '../views/attendance/attendanceSetupReadiness'

const PER_STEP = Object.fromEntries(
  ATTENDANCE_SETUP_STEP_IDS.map((id) => [id, { effectiveTime: { source: 'harness', posture: 'immediate' as const } }]),
) as AttendanceSetupReadinessResponse['perStep']

function allReadyResponse(): AttendanceSetupReadinessResponse {
  return {
    directoryLinked: false,
    orgActiveMemberCount: 12,
    groupCount: 3,
    groupsWithMembers: 3,
    shiftCount: 4,
    scheduledShiftGroupCount: 1,
    activeRotationRuleCount: 2,
    hasRotationRules: true,
    approvalFlowCount: 2,
    punchPolicyPosture: 'customized',
    notify: {
      deliveryRuntime: 'unknown',
      orgRecipientBinding: { boundRecipientCount: 5, hasAnyBoundRecipient: true },
      recipientScopeConfig: 'unsupported',
    },
    previewReady: true,
    perStep: PER_STEP,
  }
}

function mixedMissingResponse(): AttendanceSetupReadinessResponse {
  return {
    ...allReadyResponse(),
    orgActiveMemberCount: 0,
    groupCount: 1,
    groupsWithMembers: 0,
    shiftCount: 0,
    approvalFlowCount: 0,
    punchPolicyPosture: 'default',
    notify: {
      deliveryRuntime: 'not_ready',
      orgRecipientBinding: { boundRecipientCount: 0, hasAnyBoundRecipient: false },
      recipientScopeConfig: 'unsupported',
    },
    previewReady: false,
  }
}

const params = new URLSearchParams(window.location.search)
const scenario = params.get('scenario') === 'all-ready' ? allReadyResponse() : mixedMissingResponse()
const viewerIsPlatformAdmin = params.get('role') !== 'delegated'
const zhTr = (_en: string, zh: string) => zh

createApp(AttendanceSetupReadiness, {
  tr: zhTr,
  steps: deriveAttendanceSetupReadinessSteps({ kind: 'ok', data: scenario }),
  summary: scenario,
  loadState: 'loaded',
  viewerIsPlatformAdmin,
  onSelectSection: () => {},
  onReload: () => {},
}).mount('#app')
