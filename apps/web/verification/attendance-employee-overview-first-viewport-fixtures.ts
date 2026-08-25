import type { AttendanceOverviewAttentionItem } from '../src/views/attendance/attendanceOverviewPriority'
import { resolveAttendanceOverviewAttention } from '../src/views/attendance/attendanceOverviewPriority'

export type OverviewHarnessState = 'normal' | 'late' | 'missing' | 'pending' | 'empty'

const tr = (_en: string, zh: string) => zh

const requestFollowup = {
  title: '待跟进申请',
  detail: '4月15日的请假申请仍在等待审批。',
  status: 'pending' as string | null,
  action: 'request-report' as const,
  actionLabel: '打开申请报表',
}

const emptyFollowup = {
  title: '暂无申请',
  detail: '这个区间里没有待跟进的申请。',
  status: null,
  action: 'request-report' as const,
  actionLabel: '打开申请报表',
}

function attentionFor(state: OverviewHarnessState): AttendanceOverviewAttentionItem {
  if (state === 'missing') {
    return resolveAttendanceOverviewAttention({
      punchFailureActive: false,
      punchFailureMessage: '',
      anomalyCount: 1,
      focusDateLabel: '4月15日',
      latestRequestStatus: null,
      pendingRequestCount: 0,
      focusRecordStatus: 'late_early',
      focusRecordStatusLabel: '迟到早退',
      focusRecordDateLabel: '4月15日',
      needsSetup: false,
      setupHint: '',
    }, tr)
  }
  if (state === 'pending') {
    return resolveAttendanceOverviewAttention({
      punchFailureActive: false,
      punchFailureMessage: '',
      anomalyCount: 0,
      focusDateLabel: '4月15日',
      latestRequestStatus: 'pending',
      pendingRequestCount: 1,
      focusRecordStatus: 'normal',
      focusRecordStatusLabel: '正常',
      focusRecordDateLabel: '4月15日',
      needsSetup: false,
      setupHint: '',
    }, tr)
  }
  if (state === 'late') {
    return resolveAttendanceOverviewAttention({
      punchFailureActive: false,
      punchFailureMessage: '',
      anomalyCount: 0,
      focusDateLabel: '4月15日',
      latestRequestStatus: null,
      pendingRequestCount: 0,
      focusRecordStatus: 'late',
      focusRecordStatusLabel: '迟到',
      focusRecordDateLabel: '4月15日',
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
      setupHint: '如果刚入职或按预期应有排班，可能还没有被分配到考勤组。请让考勤管理员确认分组和班次。',
    }, tr)
  }
  return resolveAttendanceOverviewAttention({
    punchFailureActive: false,
    punchFailureMessage: '',
    anomalyCount: 0,
    focusDateLabel: '4月15日',
    latestRequestStatus: null,
    pendingRequestCount: 0,
    focusRecordStatus: 'normal',
    focusRecordStatusLabel: '正常',
    focusRecordDateLabel: '4月15日',
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
    heroClockDate: '周三 · 4月15日',
    punching: false,
    refreshingAfterPunch: false,
    heroTimeline: isEmpty ? { checkIn: null, checkOut: null } : { checkIn: '09:18', checkOut: state === 'normal' ? '18:00' : '17:42' },
    punchOutdoorNoteRequired: false,
    punchOutdoorNoteDraft: '',
    workbenchStatusDescription: isEmpty
      ? '这个区间里还没有考勤数据。'
      : isLate
        ? '当天同时记录了迟到和早退。'
        : '当天出勤正常。',
    workbenchRecordStatus: isEmpty ? null : isLate ? (state === 'missing' ? 'late_early' : 'late') : 'normal',
    workbenchFocusDateLabel: isEmpty ? null : '2026年4月15日',
    workbenchLatestPunchLabel: isEmpty ? '--:--' : '09:18',
    workbenchWorkMinutes: isEmpty ? 0 : 444,
    workbenchLateEarlyLabel: isLate ? '18 / 18' : '0 / 0',
    workbenchHasLateEarly: isLate,
    selfServiceNeedsSetupHint: isEmpty,
    selfServiceSetupFollowupHint: '如果刚入职或按预期应有排班，可能还没有被分配到考勤组。请让考勤管理员确认分组和班次。',
    formatStatus: (value: string) => ({
      late_early: '迟到早退',
      late: '迟到',
      normal: '正常',
      pending: '待审批',
    }[value] ?? value),
    statusMessage: '',
    statusKind: 'info' as const,
    statusCode: '',
    statusHint: '',
    statusActionLabel: '',
    statusActionBusy: false,
    attentionItem: attentionFor(state),
    requestsTotal: state === 'pending' ? 1 : 0,
    selfServiceRequestStatusItems: [
      { key: 'pending', label: '待审批', count: state === 'pending' ? 1 : 0 },
      { key: 'approved', label: '已通过', count: 0 },
      { key: 'rejected', label: '已驳回', count: 0 },
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
    selfServiceQuickActionHint: isEmpty
      ? '如果刚入职或按预期应有排班，可能还没有被分配到考勤组。请让考勤管理员确认分组和班次。'
      : '无需离开总览，直接进入申请或记录。',
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
    selfRulesWorkWindowSummary: isEmpty ? '—' : '09:00–18:00',
    selfRulesPunchPolicySummary: '—',
    selfRulesWorkingDaysSummary: '—',
    selfRulesGraceSummary: '—',
    selfRulesLateThresholdSummary: '—',
    selfRulesConfiguredRuleSummary: '',
    selfRulesWarningCodes: [] as string[],
    formatSelfRulesWarning: (code: string) => code,
  }
}
