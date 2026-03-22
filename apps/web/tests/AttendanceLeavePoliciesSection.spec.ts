import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, reactive, ref, type App, type Ref } from 'vue'
import AttendanceLeavePoliciesSection from '../src/views/attendance/AttendanceLeavePoliciesSection.vue'
import type {
  AttendanceApprovalBuilderStep,
  AttendanceApprovalFlow,
  AttendanceApprovalFlowTemplateChoice,
  AttendanceLeaveType,
  AttendanceOvertimeRule,
} from '../src/views/attendance/useAttendanceAdminLeavePolicies'

const pushSpy = vi.fn()

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: pushSpy,
  }),
}))

vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    hasFeature: (feature: string) => feature === 'workflow',
  }),
}))

type MaybePromise<T> = T | Promise<T>

interface LeavePoliciesBindings {
  leaveTypes: Ref<AttendanceLeaveType[]>
  leaveTypeLoading: Ref<boolean>
  leaveTypeSaving: Ref<boolean>
  leaveTypeEditingId: Ref<string | null>
  leaveTypeForm: {
    code: string
    name: string
    paid: boolean
    requiresApproval: boolean
    requiresAttachment: boolean
    defaultMinutesPerDay: number
    isActive: boolean
  }
  resetLeaveTypeForm: () => MaybePromise<void>
  editLeaveType: (item: AttendanceLeaveType) => MaybePromise<void>
  loadLeaveTypes: () => MaybePromise<void>
  saveLeaveType: () => MaybePromise<void>
  deleteLeaveType: (id: string) => MaybePromise<void>
  overtimeRules: Ref<AttendanceOvertimeRule[]>
  overtimeRuleLoading: Ref<boolean>
  overtimeRuleSaving: Ref<boolean>
  overtimeRuleEditingId: Ref<string | null>
  overtimeRuleForm: {
    name: string
    minMinutes: number
    roundingMinutes: number
    maxMinutesPerDay: number
    requiresApproval: boolean
    isActive: boolean
  }
  resetOvertimeRuleForm: () => MaybePromise<void>
  editOvertimeRule: (item: AttendanceOvertimeRule) => MaybePromise<void>
  loadOvertimeRules: () => MaybePromise<void>
  saveOvertimeRule: () => MaybePromise<void>
  deleteOvertimeRule: (id: string) => MaybePromise<void>
  approvalFlows: Ref<AttendanceApprovalFlow[]>
  approvalFlowLoading: Ref<boolean>
  approvalFlowSaving: Ref<boolean>
  approvalFlowEditingId: Ref<string | null>
  approvalFlowForm: {
    name: string
    requestType: string
    steps: string
    isActive: boolean
  }
  approvalFlowBuilderSteps: Ref<AttendanceApprovalBuilderStep[]>
  approvalFlowBuilderError: Ref<string>
  approvalFlowBuilderSummary: Ref<{
    stepCount: number
    roleAssignmentCount: number
    directUserCount: number
    placeholderCount: number
  }>
  approvalFlowTemplates: Ref<AttendanceApprovalFlowTemplateChoice[]>
  addApprovalFlowBuilderStep: () => MaybePromise<void>
  removeApprovalFlowBuilderStep: (index: number) => MaybePromise<void>
  applyApprovalFlowTemplate: (templateId: string) => MaybePromise<void>
  resetApprovalFlowForm: () => MaybePromise<void>
  editApprovalFlow: (item: AttendanceApprovalFlow) => MaybePromise<void>
  loadApprovalFlows: () => MaybePromise<void>
  saveApprovalFlow: () => MaybePromise<void>
  deleteApprovalFlow: (id: string) => MaybePromise<void>
}

function flushUi(): Promise<void> {
  return nextTick().then(() => nextTick())
}

function createBindings(overrides: Partial<LeavePoliciesBindings> = {}): LeavePoliciesBindings {
  return {
    leaveTypes: ref<AttendanceLeaveType[]>([]),
    leaveTypeLoading: ref(false),
    leaveTypeSaving: ref(false),
    leaveTypeEditingId: ref<string | null>(null),
    leaveTypeForm: reactive({
      code: '',
      name: '',
      paid: true,
      requiresApproval: true,
      requiresAttachment: false,
      defaultMinutesPerDay: 480,
      isActive: true,
    }),
    resetLeaveTypeForm: vi.fn(),
    editLeaveType: vi.fn(),
    loadLeaveTypes: vi.fn(),
    saveLeaveType: vi.fn(),
    deleteLeaveType: vi.fn(),
    overtimeRules: ref<AttendanceOvertimeRule[]>([]),
    overtimeRuleLoading: ref(false),
    overtimeRuleSaving: ref(false),
    overtimeRuleEditingId: ref<string | null>(null),
    overtimeRuleForm: reactive({
      name: '',
      minMinutes: 0,
      roundingMinutes: 15,
      maxMinutesPerDay: 600,
      requiresApproval: true,
      isActive: true,
    }),
    resetOvertimeRuleForm: vi.fn(),
    editOvertimeRule: vi.fn(),
    loadOvertimeRules: vi.fn(),
    saveOvertimeRule: vi.fn(),
    deleteOvertimeRule: vi.fn(),
    approvalFlows: ref<AttendanceApprovalFlow[]>([
      {
        id: 'flow-1',
        name: 'Leave manager to HR',
        requestType: 'leave',
        steps: [
          { name: 'Manager review', approverRoleIds: ['manager'] },
          { name: 'HR review', approverRoleIds: ['hr'] },
        ],
        isActive: true,
      },
    ]),
    approvalFlowLoading: ref(false),
    approvalFlowSaving: ref(false),
    approvalFlowEditingId: ref<string | null>('flow-1'),
    approvalFlowForm: reactive({
      name: 'Leave manager to HR',
      requestType: 'leave',
      steps: JSON.stringify([
        { name: 'Manager review', approverRoleIds: ['manager'] },
        { name: 'HR review', approverRoleIds: ['hr'] },
      ], null, 2),
      isActive: true,
    }),
    approvalFlowBuilderSteps: ref<AttendanceApprovalBuilderStep[]>([
      {
        id: 'step-1',
        name: 'Manager review',
        approverRoleIdsText: 'manager',
        approverUserIdsText: '',
      },
      {
        id: 'step-2',
        name: 'HR review',
        approverRoleIdsText: 'hr',
        approverUserIdsText: 'user-hr-1',
      },
    ]),
    approvalFlowBuilderError: ref(''),
    approvalFlowBuilderSummary: ref({
      stepCount: 2,
      roleAssignmentCount: 2,
      directUserCount: 1,
      placeholderCount: 0,
    }),
    approvalFlowTemplates: ref<AttendanceApprovalFlowTemplateChoice[]>([
      {
        id: 'manager-only',
        label: 'Manager only',
        description: 'One-step approval for routine leave requests.',
        steps: [{ name: 'Manager review', approverRoleIds: ['manager'] }],
      },
      {
        id: 'manager-hr',
        label: 'Manager -> HR',
        description: 'Common path for annual and sick leave.',
        steps: [
          { name: 'Manager review', approverRoleIds: ['manager'] },
          { name: 'HR review', approverRoleIds: ['hr'] },
        ],
      },
    ]),
    addApprovalFlowBuilderStep: vi.fn(),
    removeApprovalFlowBuilderStep: vi.fn(),
    applyApprovalFlowTemplate: vi.fn(),
    resetApprovalFlowForm: vi.fn(),
    editApprovalFlow: vi.fn(),
    loadApprovalFlows: vi.fn(),
    saveApprovalFlow: vi.fn(),
    deleteApprovalFlow: vi.fn(),
    ...overrides,
  }
}

describe('AttendanceLeavePoliciesSection', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  const tr = (en: string, _zh: string) => en
  const formatRequestType = (value: string) => value

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    pushSpy.mockReset()
    vi.clearAllMocks()
  })

  it('renders the visual approval builder and delegates template and step actions', async () => {
    const policies = createBindings()

    app = createApp(AttendanceLeavePoliciesSection, {
      tr,
      policies,
      formatRequestType,
    })
    app.mount(container!)
    await flushUi()

    expect(container!.textContent).toContain('Visual approval builder')
    expect(container!.textContent).toContain('Workflow designer handoff')
    expect(container!.textContent).toContain('auto-apply the recommended starter template')
    expect(container!.textContent).toContain('Steps: 2')
    expect(container!.textContent).toContain('Role gates: 2')
    expect(container!.textContent).toContain('Direct users: 1')
    expect(container!.textContent).toContain('Manager -> HR')
    expect(container!.textContent).toContain('Parallel review starter')
    expect(container!.textContent).toContain('Advanced JSON fallback')
    expect(container!.textContent).toContain('Manager review -> HR review')
    expect(container!.textContent).toContain('starter draft with the recommended template')

    const rowsTextarea = container!.querySelector<HTMLTextAreaElement>('#attendance-approval-steps')
    expect(rowsTextarea?.getAttribute('rows')).toBe('8')

    const buttons = Array.from(container!.querySelectorAll<HTMLButtonElement>('button'))
    const templateButton = buttons.find((button) => button.textContent?.includes('Manager -> HR'))
    const addStepButton = buttons.find((button) => button.textContent?.includes('Add step'))
    const workflowButton = buttons.find((button) => button.textContent?.includes('Open in workflow designer'))
    const removeButtons = buttons.filter((button) => button.textContent?.includes('Remove'))

    expect(templateButton).toBeTruthy()
    expect(addStepButton).toBeTruthy()
    expect(workflowButton).toBeTruthy()
    expect(removeButtons).toHaveLength(2)

    templateButton!.click()
    addStepButton!.click()
    removeButtons[0]!.click()
    workflowButton!.click()
    await flushUi()

    expect(policies.applyApprovalFlowTemplate).toHaveBeenCalledWith('manager-hr')
    expect(policies.addApprovalFlowBuilderStep).toHaveBeenCalledTimes(1)
    expect(policies.removeApprovalFlowBuilderStep).toHaveBeenCalledWith(0)
    expect(pushSpy).toHaveBeenCalledWith({
      name: 'attendance',
      query: expect.objectContaining({
        tab: 'workflow',
        wfSource: 'attendance',
        wfHandoff: 'approval-flow',
        attendanceRequestType: 'leave',
        approvalFlowId: 'flow-1',
        approvalFlowName: 'Leave manager to HR',
        approvalStepCount: '2',
        workflowStarterId: 'parallel-review',
        templateId: 'parallel-review',
      }),
    })
  })

  it('shows builder sync errors from the JSON fallback', async () => {
    const policies = createBindings({
      approvalFlowBuilderError: ref('Fix the JSON fallback before editing with the visual builder.'),
      approvalFlowBuilderSteps: ref([
        {
          id: 'step-1',
          name: '',
          approverRoleIdsText: '',
          approverUserIdsText: '',
        },
      ]),
      approvalFlowBuilderSummary: ref({
        stepCount: 0,
        roleAssignmentCount: 0,
        directUserCount: 0,
        placeholderCount: 1,
      }),
    })

    app = createApp(AttendanceLeavePoliciesSection, {
      tr,
      policies,
      formatRequestType,
    })
    app.mount(container!)
    await flushUi()

    expect(container!.textContent).toContain('Fix the JSON fallback before editing with the visual builder.')
    expect(container!.textContent).toContain('Roles: Any role')
    expect(container!.textContent).toContain('Users: No direct users')
  })
})
