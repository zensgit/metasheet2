// W4-2 evidence harness entry (copied to apps/web/src/dev-harness/w42SetupTemplatesHarness.ts at
// capture time by capture-setup-templates.mjs; removed afterwards). Mounts the REAL wizard shell
// (template gallery + ⑦ derivation + checklist) and, for dialog scenarios, the REAL
// AttendanceSetupTemplatePrefillDialog — with the same synthetic fixtures the mounted spec uses
// (apps/web/tests/attendance-setup-templates.spec.ts — charter §8.1: synthetic fixtures only).
// Query string: ?scenario=all-ready|mixed-missing
//               &dialog=none|confirm|confirm-no-tz|applied
//               &pending=<templateId|none>
import { createApp, h } from 'vue'
import '../styles/tokens.css'
import AttendanceSetupReadiness from '../views/attendance/AttendanceSetupReadiness.vue'
import AttendanceSetupTemplatePrefillDialog from '../views/attendance/AttendanceSetupTemplatePrefillDialog.vue'
import {
  ATTENDANCE_SETUP_STEP_IDS,
  deriveAttendanceSetupReadinessSteps,
  type AttendanceSetupReadinessResponse,
} from '../views/attendance/attendanceSetupReadiness'
import {
  buildAttendanceSetupTemplatePrefillPlan,
  getAttendanceSetupTemplate,
  type AttendanceSetupTemplateId,
} from '../views/attendance/attendanceSetupTemplates'

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
const scenario = params.get('scenario') === 'mixed-missing' ? mixedMissingResponse() : allReadyResponse()
const dialogMode = params.get('dialog') ?? 'none'
const pendingParam = params.get('pending')
const pendingTemplateId = pendingParam && pendingParam !== 'none' ? (pendingParam as AttendanceSetupTemplateId) : null
const zhTr = (_en: string, zh: string) => zh

const DIALOG_TEMPLATE_ID: AttendanceSetupTemplateId = dialogMode === 'applied' ? 'office-fixed' : 'store-scheduled'
const dialogTemplate = getAttendanceSetupTemplate(DIALOG_TEMPLATE_ID)!
const dialogTimezone = dialogMode === 'confirm-no-tz' ? '' : 'Asia/Shanghai'
const dialogPlan = buildAttendanceSetupTemplatePrefillPlan({
  templateId: DIALOG_TEMPLATE_ID,
  shiftPresetKey: dialogTemplate.shiftPresets[0]?.key ?? null,
  timezone: dialogTimezone,
  pickLabel: (label) => zhTr(label.en, label.zh),
})

const pristineGroup = { name: '', code: '', timezone: 'Asia/Shanghai', ruleSetId: '', attendanceType: 'fixed_shift', description: '' }
const pristineShift = { name: 'Standard Shift', timezone: 'Asia/Shanghai', workStartTime: '09:00', workEndTime: '18:00', lateGraceMinutes: 10, earlyGraceMinutes: 10, roundingMinutes: 5, workingDays: '1,2,3,4,5' }
// Dirty current group (an existing record loaded in the form) so the overwrite warning shows.
const currentGroup = { ...pristineGroup, name: '门店A考勤组' }
const currentShift = { ...pristineShift }

createApp({
  render() {
    const children = [
      h(AttendanceSetupReadiness, {
        tr: zhTr,
        steps: deriveAttendanceSetupReadinessSteps({ kind: 'ok', data: scenario }),
        summary: scenario,
        loadState: 'loaded',
        viewerIsPlatformAdmin: true,
        pendingTemplateId,
        onSelectSection: () => {},
        onOpenTemplate: () => {},
        onReload: () => {},
      }),
    ]
    if (dialogMode !== 'none') {
      children.push(
        h(AttendanceSetupTemplatePrefillDialog, {
          tr: zhTr,
          stage: dialogMode === 'applied' ? 'applied' : 'confirm',
          template: dialogTemplate,
          plan: dialogPlan,
          currentGroup,
          currentShift,
          pristineGroup,
          pristineShift,
          groupEditingId: 'harness-existing-group',
          shiftEditingId: null,
          orgTimezone: dialogMode === 'confirm-no-tz' ? null : 'Asia/Shanghai',
          timezone: dialogTimezone,
          timezoneOptions: [
            { value: 'Asia/Shanghai', label: 'UTC+08:00 · Asia/Shanghai' },
            { value: 'America/New_York', label: 'UTC-05:00 · America/New_York' },
          ],
          shiftPresetKey: dialogTemplate.shiftPresets[0]?.key ?? null,
          onApply: () => {},
          onCancel: () => {},
          onUndo: () => {},
          onClose: () => {},
          onNavigate: () => {},
        }),
      )
    }
    return h('div', { style: 'padding: 16px;' }, children)
  },
}).mount('#app')
