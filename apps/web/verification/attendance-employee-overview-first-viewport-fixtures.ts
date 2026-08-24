import type { AttendanceOverviewAttentionItem } from '../src/views/attendance/attendanceOverviewPriority'
import { resolveAttendanceOverviewAttention } from '../src/views/attendance/attendanceOverviewPriority'

export type OverviewHarnessState = 'normal' | 'late' | 'missing' | 'pending' | 'empty'

const tr = (en: string, _zh: string) => en

const requestFollowup = {
  title: 'Pending follow-up',
  detail: 'Leave request for Apr 15, 2026 is still waiting for approval.',
  status: 'pending' as string | null,
  action: 'request-report' as const,
  actionLabel: 'Open request report',
}

const emptyFollowup = {
  title: 'No recent requests',
  detail: 'No request follow-up in this range.',
  status: null,
  action: 'request-report' as const,
  actionLabel: 'Open request report',
}

function attentionFor(state: OverviewHarnessState): AttendanceOverviewAttentionItem {
  if (state === 'missing') {
    return resolveAttendanceOverviewAttention({
      punchFailureActive: false,
      punchFailureMessage: '',
      anomalyCount: 1,
      focusDateLabel: 'Apr 15, 2026',
      latestRequestStatus: null,
      pendingRequestCount: 0,
      focusRecordStatus: 'late_early',
      focusRecordStatusLabel: 'Late + Early',
      focusRecordDateLabel: 'Apr 15, 2026',
      needsSetup: false,
      setupHint: '',
    }, tr)
  }
  if (state === 'pending') {
    return resolveAttendanceOverviewAttention({
      punchFailureActive: false,
      punchFailureMessage: '',
      anomalyCount: 0,
      focusDateLabel: 'Apr 15, 2026',
      latestRequestStatus: 'pending',
      pendingRequestCount: 1,
      focusRecordStatus: 'normal',
      focusRecordStatusLabel: 'Normal',
      focusRecordDateLabel: 'Apr 15, 2026',
      needsSetup: false,
      setupHint: '',
    }, tr)
  }
  if (state === 'late') {
    return resolveAttendanceOverviewAttention({
      punchFailureActive: false,
      punchFailureMessage: '',
      anomalyCount: 0,
      focusDateLabel: 'Apr 15, 2026',
      latestRequestStatus: null,
      pendingRequestCount: 0,
      focusRecordStatus: 'late',
      focusRecordStatusLabel: 'Late',
      focusRecordDateLabel: 'Apr 15, 2026',
      needsSetup: false,
      setupHint: '',
    }, tr)
  }
  if (state === 'empty') {
    return resolveAttendanceOverviewAttention({
      punchFailureActive: false,
      punchFailureMessage: '',
      anomalyCount: 0,
      focusDateLabel: null,
      latestRequestStatus: null,
      pendingRequestCount: 0,
      focusRecordStatus: null,
      focusRecordStatusLabel: null,
      focusRecordDateLabel: null,
      needsSetup: true,
      setupHint: 'If you recently joined or expected a schedule here, you may not be assigned to an attendance group yet. Ask an attendance admin to confirm your group and shift setup.',
    }, tr)
  }
  return resolveAttendanceOverviewAttention({
    punchFailureActive: false,
    punchFailureMessage: '',
    anomalyCount: 0,
    focusDateLabel: 'Apr 15, 2026',
    latestRequestStatus: null,
    pendingRequestCount: 0,
    focusRecordStatus: 'normal',
    focusRecordStatusLabel: 'Normal',
    focusRecordDateLabel: 'Apr 15, 2026',
    needsSetup: false,
    setupHint: '',
  }, tr)
}

export function buildEmployeeWorkspaceProps(state: OverviewHarnessState) {
  const isEmpty = state === 'empty'
  const isLate = state === 'late' || state === 'missing'
  return {
    tr,
    heroClockTime: '09:18',
    heroClockDate: 'Wed, Apr 15',
    punching: false,
    refreshingAfterPunch: false,
    heroTimeline: isEmpty ? { checkIn: null, checkOut: null } : { checkIn: '09:18', checkOut: state === 'normal' ? '18:00' : '17:42' },
    punchOutdoorNoteRequired: false,
    punchOutdoorNoteDraft: '',
    workbenchStatusDescription: isEmpty
      ? 'No attendance data is available in this range yet.'
      : isLate
        ? 'Both a late arrival and an early departure were recorded.'
        : 'The workday looks normal.',
    workbenchRecordStatus: isEmpty ? null : isLate ? (state === 'missing' ? 'late_early' : 'late') : 'normal',
    workbenchFocusDateLabel: isEmpty ? null : 'Apr 15, 2026',
    workbenchLatestPunchLabel: isEmpty ? '--:--' : '09:18',
    workbenchWorkMinutes: isEmpty ? 0 : 444,
    workbenchLateEarlyLabel: isLate ? '18 / 18' : '0 / 0',
    workbenchHasLateEarly: isLate,
    selfServiceNeedsSetupHint: isEmpty,
    selfServiceSetupFollowupHint: 'If you recently joined or expected a schedule here, you may not be assigned to an attendance group yet. Ask an attendance admin to confirm your group and shift setup.',
    formatStatus: (value: string) => value,
    statusMessage: '',
    statusKind: 'info' as const,
    statusCode: '',
    statusHint: '',
    statusActionLabel: '',
    statusActionBusy: false,
    attentionItem: attentionFor(state),
    requestsTotal: state === 'pending' ? 1 : 0,
    selfServiceRequestStatusItems: [
      { key: 'pending', label: 'Pending', count: state === 'pending' ? 1 : 0 },
      { key: 'approved', label: 'Approved', count: 0 },
      { key: 'rejected', label: 'Rejected', count: 0 },
    ],
    selfServiceRequestFollowup: state === 'pending' ? requestFollowup : emptyFollowup,
    selfServiceRecentRequests: [],
    formatRequestType: (value: string) => value,
    formatDate: (value: string | null | undefined) => value ?? '',
    selfServiceRequestSubtitle: () => '',
    requestReasonText: () => '',
    requestDecisionCommentText: () => '',
    requestDecisionCommentLabel: () => 'Comment',
    describeRequestStatus: () => '',
    selfServiceQuickActionHint: 'Jump into the request form or records table without leaving overview.',
    annualSelfBalanceLoading: false,
    annualSelfBalanceError: null,
    annualSelfBalanceSummary: null,
    balanceLeaveType: 'annual' as const,
    balanceTraceHref: '',
    selfRulesLoading: false,
    selfRulesError: null,
    selfRulesHasData: false,
    selfRulesAttendanceGroupSummary: '—',
    selfRulesScheduleGroupSummary: '—',
    selfRulesWorkWindowSummary: '—',
    selfRulesPunchPolicySummary: '—',
    selfRulesWorkingDaysSummary: '—',
    selfRulesGraceSummary: '—',
    selfRulesLateThresholdSummary: '—',
    selfRulesConfiguredRuleSummary: '',
    selfRulesWarningCodes: [] as string[],
    formatSelfRulesWarning: (code: string) => code,
  }
}
