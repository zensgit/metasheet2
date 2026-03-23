export interface AttendanceWorkflowHandoffStepInput {
  name?: string
  approverRoleIdsText?: string
  approverUserIdsText?: string
}

export interface AttendanceWorkflowHandoffInput {
  requestType: string
  approvalFlowId?: string | null
  approvalFlowName?: string
  steps: AttendanceWorkflowHandoffStepInput[]
}

export interface AttendanceWorkflowHandoffState {
  source: 'attendance'
  handoff: 'approval-flow'
  requestType: string
  approvalFlowId?: string
  approvalFlowName: string
  approvalStepCount: number
  approvalStepSummary: string
  workflowName: string
  workflowDescription: string
  workflowStarterId: string
  templateId: string
}

type AttendanceWorkflowStarterTranslator = (en: string, zh: string) => string

function normalizeQueryString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parseList(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function formatRequestTypeLabel(requestType: string): string {
  switch (requestType) {
    case 'leave':
      return 'Leave'
    case 'overtime':
      return 'Overtime'
    case 'missed_check_in':
      return 'Missed check-in'
    case 'missed_check_out':
      return 'Missed check-out'
    case 'time_correction':
      return 'Time correction'
    default:
      return 'Attendance'
  }
}

function buildDefaultApprovalFlowName(requestType: string): string {
  return `${formatRequestTypeLabel(requestType)} approval flow`
}

function summarizeSteps(steps: AttendanceWorkflowHandoffStepInput[]): string {
  const summary = steps
    .map((step, index) => {
      const name = typeof step.name === 'string' ? step.name.trim() : ''
      if (name) return name
      const roles = parseList(step.approverRoleIdsText)
      const users = parseList(step.approverUserIdsText)
      if (roles.length > 0) return `Roles: ${roles.join(', ')}`
      if (users.length > 0) return `Users: ${users.join(', ')}`
      return index >= 0 ? '' : ''
    })
    .filter(Boolean)
    .join(' -> ')

  return summary.slice(0, 240)
}

export function resolveAttendanceWorkflowStarterId(requestType: string, approvalStepCount: number): string {
  const hasEscalation = approvalStepCount > 1

  switch (requestType) {
    case 'leave':
      return hasEscalation ? 'attendance-leave-manager-hr' : 'attendance-leave-manager'
    case 'overtime':
      return hasEscalation ? 'attendance-overtime-manager-payroll' : 'attendance-overtime-manager'
    case 'missed_check_in':
    case 'missed_check_out':
    case 'time_correction':
      return hasEscalation ? 'attendance-exception-manager-ops' : 'attendance-exception-manager'
    default:
      return hasEscalation ? 'parallel-review' : 'simple-approval'
  }
}

export function formatAttendanceWorkflowStarterLabel(
  starterId: string,
  translate: AttendanceWorkflowStarterTranslator = (en) => en,
): string {
  switch (starterId) {
    case 'attendance-leave-manager':
      return translate('Leave manager starter', '请假主管起步模板')
    case 'attendance-leave-manager-hr':
      return translate('Leave manager -> HR starter', '请假主管 -> HR 起步模板')
    case 'attendance-overtime-manager':
      return translate('Overtime manager starter', '加班主管起步模板')
    case 'attendance-overtime-manager-payroll':
      return translate('Overtime manager -> Payroll starter', '加班主管 -> 薪资起步模板')
    case 'attendance-exception-manager':
      return translate('Attendance exception manager starter', '考勤异常主管起步模板')
    case 'attendance-exception-manager-ops':
      return translate('Attendance exception manager -> Ops starter', '考勤异常主管 -> 运营起步模板')
    case 'parallel-review':
      return translate('Parallel review starter', '并行评审起步模板')
    default:
      return translate('Simple approval starter', '简单审批起步模板')
  }
}

export function buildAttendanceWorkflowHandoffQuery(input: AttendanceWorkflowHandoffInput): Record<string, string> {
  const approvalFlowName = normalizeQueryString(input.approvalFlowName) || buildDefaultApprovalFlowName(input.requestType)
  const approvalStepSummary = summarizeSteps(Array.isArray(input.steps) ? input.steps : [])
  const approvalStepCount = Array.isArray(input.steps)
    ? input.steps.filter((step) => {
      const name = normalizeQueryString(step.name)
      return name.length > 0 || parseList(step.approverRoleIdsText).length > 0 || parseList(step.approverUserIdsText).length > 0
    }).length
    : 0
  const workflowStarterId = resolveAttendanceWorkflowStarterId(input.requestType, approvalStepCount)

  return {
    tab: 'workflow',
    wfSource: 'attendance',
    wfHandoff: 'approval-flow',
    attendanceRequestType: normalizeQueryString(input.requestType) || 'leave',
    approvalFlowName,
    approvalStepCount: String(approvalStepCount),
    approvalStepSummary,
    workflowName: approvalFlowName,
    workflowDescription: `Attendance ${formatRequestTypeLabel(input.requestType).toLowerCase()} starter from approval builder`,
    workflowStarterId,
    templateId: workflowStarterId,
    ...(normalizeQueryString(input.approvalFlowId) ? { approvalFlowId: normalizeQueryString(input.approvalFlowId) } : {}),
  }
}

export function readAttendanceWorkflowHandoff(query: Record<string, unknown>): AttendanceWorkflowHandoffState | null {
  const source = normalizeQueryString(query.wfSource)
  const handoff = normalizeQueryString(query.wfHandoff)
  if (source !== 'attendance' || handoff !== 'approval-flow') return null

  const requestType = normalizeQueryString(query.attendanceRequestType) || 'leave'
  const approvalFlowName = normalizeQueryString(query.approvalFlowName) || buildDefaultApprovalFlowName(requestType)
  const approvalStepCount = Number.parseInt(normalizeQueryString(query.approvalStepCount), 10)
  const workflowStarterId = normalizeQueryString(query.workflowStarterId)
    || resolveAttendanceWorkflowStarterId(requestType, Number.isFinite(approvalStepCount) ? approvalStepCount : 0)

  return {
    source: 'attendance',
    handoff: 'approval-flow',
    requestType,
    approvalFlowId: normalizeQueryString(query.approvalFlowId) || undefined,
    approvalFlowName,
    approvalStepCount: Number.isFinite(approvalStepCount) ? approvalStepCount : 0,
    approvalStepSummary: normalizeQueryString(query.approvalStepSummary),
    workflowName: normalizeQueryString(query.workflowName) || approvalFlowName,
    workflowDescription:
      normalizeQueryString(query.workflowDescription)
      || `Attendance ${formatRequestTypeLabel(requestType).toLowerCase()} starter from approval builder`,
    workflowStarterId,
    templateId: normalizeQueryString(query.templateId) || workflowStarterId,
  }
}
