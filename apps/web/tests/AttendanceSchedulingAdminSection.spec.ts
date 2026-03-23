import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, reactive, type App, type Ref, ref, nextTick } from 'vue'
import AttendanceSchedulingAdminSection from '../src/views/attendance/AttendanceSchedulingAdminSection.vue'
import type {
  AttendanceAssignmentItem,
  AttendanceRotationAssignmentItem,
  AttendanceRotationRule,
  AttendanceShift,
} from '../src/views/attendance/useAttendanceAdminScheduling'

type Translate = (en: string, zh: string) => string

type MaybePromise<T> = T | Promise<T>

interface RuleFormState {
  name: string
  timezone: string
  workStartTime: string
  workEndTime: string
  lateGraceMinutes: number
  earlyGraceMinutes: number
  roundingMinutes: number
  workingDays: string
}

interface RotationRuleFormState {
  name: string
  timezone: string
  shiftSequence: string
  isActive: boolean
}

interface RotationAssignmentFormState {
  userId: string
  rotationRuleId: string
  startDate: string
  endDate: string
  isActive: boolean
}

interface ShiftFormState {
  name: string
  timezone: string
  workStartTime: string
  workEndTime: string
  isOvernight: boolean
  lateGraceMinutes: number
  earlyGraceMinutes: number
  roundingMinutes: number
  workingDays: string
}

interface AssignmentFormState {
  userId: string
  shiftId: string
  startDate: string
  endDate: string
  isActive: boolean
}

interface SchedulingBindings {
  loadRule: () => MaybePromise<void>
  ruleForm: RuleFormState
  ruleLoading: Ref<boolean>
  saveRule: () => MaybePromise<void>
  rotationRules: Ref<AttendanceRotationRule[]>
  rotationRuleLoading: Ref<boolean>
  rotationRuleSaving: Ref<boolean>
  rotationRuleEditingId: Ref<string | null>
  rotationRuleForm: RotationRuleFormState
  resetRotationRuleForm: () => MaybePromise<void>
  editRotationRule: (rule: AttendanceRotationRule) => MaybePromise<void>
  loadRotationRules: () => MaybePromise<void>
  saveRotationRule: () => MaybePromise<void>
  deleteRotationRule: (id: string) => MaybePromise<void>
  rotationAssignments: Ref<AttendanceRotationAssignmentItem[]>
  rotationAssignmentLoading: Ref<boolean>
  rotationAssignmentSaving: Ref<boolean>
  rotationAssignmentEditingId: Ref<string | null>
  rotationAssignmentForm: RotationAssignmentFormState
  resetRotationAssignmentForm: () => MaybePromise<void>
  editRotationAssignment: (item: AttendanceRotationAssignmentItem) => MaybePromise<void>
  loadRotationAssignments: () => MaybePromise<void>
  saveRotationAssignment: () => MaybePromise<void>
  deleteRotationAssignment: (id: string) => MaybePromise<void>
  shifts: Ref<AttendanceShift[]>
  shiftLoading: Ref<boolean>
  shiftSaving: Ref<boolean>
  shiftEditingId: Ref<string | null>
  shiftForm: ShiftFormState
  resetShiftForm: () => MaybePromise<void>
  editShift: (shift: AttendanceShift) => MaybePromise<void>
  loadShifts: () => MaybePromise<void>
  saveShift: () => MaybePromise<void>
  deleteShift: (id: string) => MaybePromise<void>
  assignments: Ref<AttendanceAssignmentItem[]>
  assignmentLoading: Ref<boolean>
  assignmentSaving: Ref<boolean>
  assignmentEditingId: Ref<string | null>
  assignmentForm: AssignmentFormState
  resetAssignmentForm: () => MaybePromise<void>
  editAssignment: (item: AttendanceAssignmentItem) => MaybePromise<void>
  loadAssignments: () => MaybePromise<void>
  saveAssignment: () => MaybePromise<void>
  deleteAssignment: (id: string) => MaybePromise<void>
}

function flushUi(): Promise<void> {
  return Promise.resolve().then(() => nextTick()).then(() => nextTick())
}

function createSchedulingBindings(overrides: Partial<SchedulingBindings> = {}): SchedulingBindings {
  return {
    loadRule: vi.fn(),
    ruleForm: reactive<RuleFormState>({
      name: 'Default',
      timezone: 'UTC',
      workStartTime: '09:00',
      workEndTime: '18:00',
      lateGraceMinutes: 10,
      earlyGraceMinutes: 10,
      roundingMinutes: 5,
      workingDays: '1,2,3,4,5',
    }),
    ruleLoading: ref(false),
    saveRule: vi.fn(),
    rotationRules: ref<AttendanceRotationRule[]>([
      {
        id: 'rot-1',
        name: 'Two shift',
        timezone: 'UTC',
        shiftSequence: ['shift-a', 'shift-b'],
        isActive: true,
      },
    ]),
    rotationRuleLoading: ref(false),
    rotationRuleSaving: ref(false),
    rotationRuleEditingId: ref('rot-1'),
    rotationRuleForm: reactive<RotationRuleFormState>({
      name: 'Two shift',
      timezone: 'UTC',
      shiftSequence: 'shift-a, shift-b',
      isActive: true,
    }),
    resetRotationRuleForm: vi.fn(),
    editRotationRule: vi.fn(),
    loadRotationRules: vi.fn(),
    saveRotationRule: vi.fn(),
    deleteRotationRule: vi.fn(),
    rotationAssignments: ref<AttendanceRotationAssignmentItem[]>([
      {
        assignment: {
          id: 'rotation-assignment-1',
          userId: 'user-7',
          rotationRuleId: 'rot-1',
          startDate: '2026-03-01',
          endDate: null,
          isActive: true,
        },
        rotation: {
          id: 'rot-1',
          name: 'Two shift',
          timezone: 'UTC',
          shiftSequence: ['shift-a', 'shift-b'],
          isActive: true,
        },
      },
    ]),
    rotationAssignmentLoading: ref(false),
    rotationAssignmentSaving: ref(false),
    rotationAssignmentEditingId: ref('rotation-assignment-1'),
    rotationAssignmentForm: reactive<RotationAssignmentFormState>({
      userId: 'user-7',
      rotationRuleId: 'rot-1',
      startDate: '2026-03-01',
      endDate: '',
      isActive: true,
    }),
    resetRotationAssignmentForm: vi.fn(),
    editRotationAssignment: vi.fn(),
    loadRotationAssignments: vi.fn(),
    saveRotationAssignment: vi.fn(),
    deleteRotationAssignment: vi.fn(),
    shifts: ref<AttendanceShift[]>([
      {
        id: 'shift-a',
        name: 'Day shift',
        timezone: 'UTC',
        workStartTime: '09:00',
        workEndTime: '18:00',
        isOvernight: false,
        lateGraceMinutes: 10,
        earlyGraceMinutes: 10,
        roundingMinutes: 5,
        workingDays: [1, 2, 3, 4, 5],
      },
    ]),
    shiftLoading: ref(false),
    shiftSaving: ref(false),
    shiftEditingId: ref('shift-a'),
    shiftForm: reactive<ShiftFormState>({
      name: 'Day shift',
      timezone: 'UTC',
      workStartTime: '09:00',
      workEndTime: '18:00',
      isOvernight: false,
      lateGraceMinutes: 10,
      earlyGraceMinutes: 10,
      roundingMinutes: 5,
      workingDays: '1,2,3,4,5',
    }),
    resetShiftForm: vi.fn(),
    editShift: vi.fn(),
    loadShifts: vi.fn(),
    saveShift: vi.fn(),
    deleteShift: vi.fn(),
    assignments: ref<AttendanceAssignmentItem[]>([
      {
        assignment: {
          id: 'assignment-1',
          userId: 'user-9',
          shiftId: 'shift-a',
          startDate: '2026-03-01',
          endDate: null,
          isActive: true,
        },
        shift: {
          id: 'shift-a',
          name: 'Day shift',
          timezone: 'UTC',
          workStartTime: '09:00',
          workEndTime: '18:00',
          isOvernight: false,
          lateGraceMinutes: 10,
          earlyGraceMinutes: 10,
          roundingMinutes: 5,
          workingDays: [1, 2, 3, 4, 5],
        },
      },
    ]),
    assignmentLoading: ref(false),
    assignmentSaving: ref(false),
    assignmentEditingId: ref('assignment-1'),
    assignmentForm: reactive<AssignmentFormState>({
      userId: 'user-9',
      shiftId: 'shift-a',
      startDate: '2026-03-01',
      endDate: '',
      isActive: true,
    }),
    resetAssignmentForm: vi.fn(),
    editAssignment: vi.fn(),
    loadAssignments: vi.fn(),
    saveAssignment: vi.fn(),
    deleteAssignment: vi.fn(),
    ...overrides,
  }
}

describe('AttendanceSchedulingAdminSection', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  const tr = (en: string, _zh: string) => en

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.clearAllMocks()
  })

  it('shows table counts and editing summaries for each scheduling section', async () => {
    const scheduling = createSchedulingBindings()

    app = createApp(AttendanceSchedulingAdminSection, {
      tr,
      scheduling,
    })
    app.mount(container!)
    await flushUi()

    expect(container!.textContent).toContain('Rotation rules: 1')
    expect(container!.textContent).toContain('Editing rotation rule: Two shift')
    expect(container!.textContent).toContain('Rotation assignments: 1')
    expect(container!.textContent).toContain('Editing rotation assignment: user-7 → rot-1')
    expect(container!.textContent).toContain('Shifts: 1')
    expect(container!.textContent).toContain('Editing shift: Day shift')
    expect(container!.textContent).toContain('Shift assignments: 1')
    expect(container!.textContent).toContain('Editing shift assignment: user-9 → shift-a')
  })

  it('falls back to plain counts when nothing is being edited', async () => {
    const scheduling = createSchedulingBindings({
      rotationRuleEditingId: ref(null),
      rotationAssignmentEditingId: ref(null),
      shiftEditingId: ref(null),
      assignmentEditingId: ref(null),
    })

    app = createApp(AttendanceSchedulingAdminSection, {
      tr,
      scheduling,
    })
    app.mount(container!)
    await flushUi()

    expect(container!.textContent).toContain('Rotation rules: 1')
    expect(container!.textContent).not.toContain('Editing rotation rule:')
    expect(container!.textContent).not.toContain('Editing rotation assignment:')
    expect(container!.textContent).not.toContain('Editing shift:')
    expect(container!.textContent).not.toContain('Editing shift assignment:')
  })

  it('shows overnight shift summaries and the overnight toggle', async () => {
    const scheduling = createSchedulingBindings({
      shifts: ref<AttendanceShift[]>([
        {
          id: 'shift-night',
          name: 'Night shift',
          timezone: 'UTC',
          workStartTime: '22:00',
          workEndTime: '06:00',
          isOvernight: true,
          lateGraceMinutes: 10,
          earlyGraceMinutes: 10,
          roundingMinutes: 5,
          workingDays: [1, 2, 3, 4, 5],
        },
      ]),
      shiftForm: reactive<ShiftFormState>({
        name: 'Night shift',
        timezone: 'UTC',
        workStartTime: '22:00',
        workEndTime: '06:00',
        isOvernight: true,
        lateGraceMinutes: 10,
        earlyGraceMinutes: 10,
        roundingMinutes: 5,
        workingDays: '1,2,3,4,5',
      }),
      shiftEditingId: ref('shift-night'),
    })

    app = createApp(AttendanceSchedulingAdminSection, {
      tr,
      scheduling,
    })
    app.mount(container!)
    await flushUi()

    expect(container!.textContent).toContain('Overnight shift')
    expect(container!.textContent).toContain('Schedule')
    expect(container!.textContent).toContain('22:00 → 06:00 · Overnight')
  })

  it('renders timezone selectors with UTC offset labels across scheduling forms', async () => {
    const scheduling = createSchedulingBindings()

    app = createApp(AttendanceSchedulingAdminSection, {
      tr,
      scheduling,
    })
    app.mount(container!)
    await flushUi()

    const defaultRuleTimezone = container!.querySelector<HTMLSelectElement>('#attendance-rule-timezone')
    const rotationTimezone = container!.querySelector<HTMLSelectElement>('#attendance-rotation-timezone')
    const shiftTimezone = container!.querySelector<HTMLSelectElement>('#attendance-shift-timezone')

    expect(defaultRuleTimezone).toBeTruthy()
    expect(rotationTimezone).toBeTruthy()
    expect(shiftTimezone).toBeTruthy()
    expect(defaultRuleTimezone!.selectedOptions[0]?.textContent).toContain('UTC+00:00')
    expect(rotationTimezone!.selectedOptions[0]?.textContent).toContain('UTC+00:00')
    expect(shiftTimezone!.selectedOptions[0]?.textContent).toContain('UTC+00:00')
    expect(Array.from(defaultRuleTimezone!.querySelectorAll('optgroup')).map((group) => group.label)).toContain('Common timezones')
    expect(Array.from(rotationTimezone!.querySelectorAll('optgroup')).map((group) => group.label)).toContain('Asia')
    expect(container!.textContent).toContain('UTC (UTC+00:00)')
  })
})
