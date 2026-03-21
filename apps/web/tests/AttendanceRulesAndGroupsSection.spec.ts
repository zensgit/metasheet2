import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, reactive, ref, type App, type Ref, nextTick } from 'vue'
import AttendanceRulesAndGroupsSection from '../src/views/attendance/AttendanceRulesAndGroupsSection.vue'
import type {
  AttendanceGroup,
  AttendanceGroupMember,
  AttendanceRuleSet,
  AttendanceRuleTemplateVersion,
} from '../src/views/attendance/useAttendanceAdminRulesAndGroups'

type MaybePromise<T> = T | Promise<T>

interface RuleSetFormState {
  name: string
  description: string
  version: number
  scope: string
  isDefault: boolean
  config: string
}

interface RulesAndGroupsBindings {
  attendanceGroupEditingId: Ref<string | null>
  attendanceGroupForm: {
    name: string
    code: string
    timezone: string
    ruleSetId: string
    description: string
  }
  attendanceGroupLoading: Ref<boolean>
  attendanceGroupMemberGroupId: Ref<string>
  attendanceGroupMemberLoading: Ref<boolean>
  attendanceGroupMemberSaving: Ref<boolean>
  attendanceGroupMemberUserIds: Ref<string>
  attendanceGroupMembers: Ref<AttendanceGroupMember[]>
  attendanceGroupSaving: Ref<boolean>
  attendanceGroups: Ref<AttendanceGroup[]>
  copySystemTemplates: () => MaybePromise<void>
  deleteAttendanceGroup: (id: string) => MaybePromise<void>
  deleteRuleSet: (id: string) => MaybePromise<void>
  editAttendanceGroup: (item: AttendanceGroup) => MaybePromise<void>
  editRuleSet: (item: AttendanceRuleSet) => MaybePromise<void>
  loadAttendanceGroupMembers: () => MaybePromise<void>
  loadAttendanceGroups: () => MaybePromise<void>
  loadRuleSetTemplate: () => MaybePromise<void>
  loadRuleSets: () => MaybePromise<void>
  loadRuleTemplates: () => MaybePromise<void>
  addAttendanceGroupMembers: () => MaybePromise<void>
  removeAttendanceGroupMember: (userId: string) => MaybePromise<void>
  resetAttendanceGroupForm: () => MaybePromise<void>
  resetRuleSetForm: () => MaybePromise<void>
  closeRuleTemplateVersionView: () => MaybePromise<void>
  resolveRuleSetName: (ruleSetId?: string | null) => string
  restoreRuleTemplates: (versionId: string) => MaybePromise<void>
  openRuleTemplateVersion: (versionId: string) => MaybePromise<void>
  ruleTemplateVersionLoading: Ref<boolean>
  selectedRuleTemplateVersion: Ref<AttendanceRuleTemplateVersion | null>
  ruleSetEditingId: Ref<string | null>
  ruleSetForm: RuleSetFormState
  ruleSetLoading: Ref<boolean>
  ruleSetSaving: Ref<boolean>
  ruleSets: Ref<AttendanceRuleSet[]>
  ruleTemplateLibraryText: Ref<string>
  ruleTemplateLoading: Ref<boolean>
  ruleTemplateRestoring: Ref<boolean>
  ruleTemplateSaving: Ref<boolean>
  ruleTemplateSystemText: Ref<string>
  ruleTemplateVersions: Ref<AttendanceRuleTemplateVersion[]>
  ruleBuilderSource?: Ref<string>
  ruleBuilderTimezone?: Ref<string>
  ruleBuilderWorkStartTime?: Ref<string>
  ruleBuilderWorkEndTime?: Ref<string>
  ruleBuilderLateGraceMinutes?: Ref<number>
  ruleBuilderEarlyGraceMinutes?: Ref<number>
  ruleBuilderWorkingDays?: Ref<string>
  ruleSetPreviewLoading?: Ref<boolean>
  ruleSetPreviewError?: Ref<string>
  ruleSetPreviewEventsText?: Ref<string>
  ruleSetPreviewResult?: Ref<{
    ruleSetId?: string | null
    totalEvents?: number
    preview?: Array<{
      userId: string
      workDate: string
      workMinutes?: number
      lateMinutes?: number
      earlyLeaveMinutes?: number
      status?: string
    }>
    notes?: string[]
  } | null>
  previewRuleSet?: () => MaybePromise<void>
  resetRuleBuilder?: () => MaybePromise<void>
  saveAttendanceGroup: () => MaybePromise<void>
  saveRuleSet: () => MaybePromise<void>
  saveRuleTemplates: () => MaybePromise<void>
}

function flushUi(): Promise<void> {
  return nextTick().then(() => nextTick())
}

function createBindings(overrides: Partial<RulesAndGroupsBindings> = {}): RulesAndGroupsBindings {
  const ruleSetEditingId = ref<string | null>(null)
  const ruleSetForm = reactive<RuleSetFormState>({
    name: 'Ops rules',
    description: 'Attendance rules for the operations team',
    version: 1,
    scope: 'org',
    isDefault: false,
    config: JSON.stringify({
      source: 'dingtalk',
      rule: {
        timezone: 'Asia/Shanghai',
        workStartTime: '09:00',
        workEndTime: '18:00',
        lateGraceMinutes: 12,
        earlyGraceMinutes: 8,
        workingDays: [1, 2, 3, 4, 5],
      },
      extraFlag: true,
    }, null, 2),
  })

  return {
    attendanceGroupEditingId: ref(null),
    attendanceGroupForm: reactive({
      name: '',
      code: '',
      timezone: '',
      ruleSetId: '',
      description: '',
    }),
    attendanceGroupLoading: ref(false),
    attendanceGroupMemberGroupId: ref(''),
    attendanceGroupMemberLoading: ref(false),
    attendanceGroupMemberSaving: ref(false),
    attendanceGroupMemberUserIds: ref(''),
    attendanceGroupMembers: ref<AttendanceGroupMember[]>([]),
    attendanceGroupSaving: ref(false),
    attendanceGroups: ref<AttendanceGroup[]>([]),
    copySystemTemplates: vi.fn(),
    deleteAttendanceGroup: vi.fn(),
    deleteRuleSet: vi.fn(),
    editAttendanceGroup: vi.fn(),
    editRuleSet: vi.fn(),
    loadAttendanceGroupMembers: vi.fn(),
    loadAttendanceGroups: vi.fn(),
    loadRuleSetTemplate: vi.fn(),
    loadRuleSets: vi.fn(),
    loadRuleTemplates: vi.fn(),
    addAttendanceGroupMembers: vi.fn(),
    removeAttendanceGroupMember: vi.fn(),
    resetAttendanceGroupForm: vi.fn(),
    resetRuleSetForm: vi.fn(),
    closeRuleTemplateVersionView: vi.fn(),
    resolveRuleSetName: (ruleSetId?: string | null) => (ruleSetId === 'rule-set-1' ? 'Ops rules' : 'Default'),
    restoreRuleTemplates: vi.fn(),
    openRuleTemplateVersion: vi.fn(),
    ruleTemplateVersionLoading: ref(false),
    selectedRuleTemplateVersion: ref(null),
    ruleSetEditingId,
    ruleSetForm,
    ruleSetLoading: ref(false),
    ruleSetSaving: ref(false),
    ruleSets: ref<AttendanceRuleSet[]>([
      {
        id: 'rule-set-1',
        name: 'Ops rules',
        version: 1,
        scope: 'org',
        isDefault: false,
      },
    ]),
    ruleTemplateLibraryText: ref('[]'),
    ruleTemplateLoading: ref(false),
    ruleTemplateRestoring: ref(false),
    ruleTemplateSaving: ref(false),
    ruleTemplateSystemText: ref('[]'),
    ruleTemplateVersions: ref<AttendanceRuleTemplateVersion[]>([]),
    saveAttendanceGroup: vi.fn(),
    saveRuleSet: vi.fn(),
    saveRuleTemplates: vi.fn(),
    ...overrides,
  }
}

describe('AttendanceRulesAndGroupsSection', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  const tr = (en: string, _zh: string) => en
  const formatDateTime = (value: string | null | undefined) => value ?? '--'

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

  it('keeps the structured builder in sync with the JSON draft', async () => {
    const rules = createBindings()

    app = createApp(AttendanceRulesAndGroupsSection, {
      tr,
      formatDateTime,
      rules,
    })
    app.mount(container!)
    await flushUi()

    expect(container!.textContent).toContain('Structured rule builder')
    expect(container!.textContent).toContain('Source: dingtalk')
    expect(container!.textContent).toContain('Timezone: Asia/Shanghai')
    expect(container!.textContent).toContain('Working days: Mon, Tue, Wed, Thu, Fri')
    expect(container!.textContent).toContain('"extraFlag": true')

    const sourceInput = container!.querySelector<HTMLInputElement>('#attendance-rule-builder-source')
    const timezoneInput = container!.querySelector<HTMLInputElement>('#attendance-rule-builder-timezone')
    const startInput = container!.querySelector<HTMLInputElement>('#attendance-rule-builder-start')
    const endInput = container!.querySelector<HTMLInputElement>('#attendance-rule-builder-end')
    const lateInput = container!.querySelector<HTMLInputElement>('#attendance-rule-builder-late-grace')
    const earlyInput = container!.querySelector<HTMLInputElement>('#attendance-rule-builder-early-grace')
    expect(sourceInput).toBeTruthy()
    expect(timezoneInput).toBeTruthy()
    expect(startInput).toBeTruthy()
    expect(endInput).toBeTruthy()
    expect(lateInput).toBeTruthy()
    expect(earlyInput).toBeTruthy()

    sourceInput!.value = 'csv'
    sourceInput!.dispatchEvent(new Event('input', { bubbles: true }))
    timezoneInput!.value = 'Europe/London'
    timezoneInput!.dispatchEvent(new Event('input', { bubbles: true }))
    startInput!.value = '08:30'
    startInput!.dispatchEvent(new Event('input', { bubbles: true }))
    endInput!.value = '17:30'
    endInput!.dispatchEvent(new Event('input', { bubbles: true }))
    lateInput!.value = '15'
    lateInput!.dispatchEvent(new Event('input', { bubbles: true }))
    earlyInput!.value = '5'
    earlyInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    const saturdayCheckbox = container!.querySelectorAll<HTMLInputElement>('.attendance__rule-builder-day input')[6]
    expect(saturdayCheckbox).toBeTruthy()
    saturdayCheckbox.click()
    await flushUi()

    const configTextarea = container!.querySelector<HTMLTextAreaElement>('#attendance-rule-set-config')
    expect(configTextarea).toBeTruthy()
    const parsed = JSON.parse(configTextarea!.value) as {
      source?: string
      extraFlag?: boolean
      rule?: {
        timezone?: string
        workStartTime?: string
        workEndTime?: string
        lateGraceMinutes?: number
        earlyGraceMinutes?: number
        workingDays?: number[]
      }
    }
    expect(parsed).toMatchObject({
      source: 'csv',
      extraFlag: true,
      rule: {
        timezone: 'Europe/London',
        workStartTime: '08:30',
        workEndTime: '17:30',
        lateGraceMinutes: 15,
        earlyGraceMinutes: 5,
        workingDays: [1, 2, 3, 4, 5, 6],
      },
    })
  })

  it('renders preview results and calls the preview action', async () => {
    const previewRuleSet = vi.fn()
    const rules = createBindings({
      previewRuleSet,
      ruleSetPreviewEventsText: ref('[{"eventType":"check_in","occurredAt":"2026-03-20T09:05:00+08:00","workDate":"2026-03-20","userId":"user-1"}]'),
      ruleSetPreviewResult: ref({
        ruleSetId: 'rule-set-1',
        totalEvents: 2,
        notes: ['Uses the current builder draft.'],
        preview: [
          {
            userId: 'user-1',
            workDate: '2026-03-20',
            workMinutes: 480,
            lateMinutes: 5,
            earlyLeaveMinutes: 0,
            status: 'ok',
          },
        ],
      }),
    })

    app = createApp(AttendanceRulesAndGroupsSection, {
      tr,
      formatDateTime,
      rules,
    })
    app.mount(container!)
    await flushUi()

    expect(container!.textContent).toContain('Draft preview')
    const previewEvents = container!.querySelector<HTMLTextAreaElement>('#attendance-rule-preview-events')
    expect(previewEvents?.value).toContain('"eventType":"check_in"')
    expect(container!.textContent).toContain('Preview rule set')
    expect(container!.textContent).toContain('Events: 2')
    expect(container!.textContent).toContain('Uses the current builder draft.')
    expect(container!.textContent).toContain('2026-03-20')
    expect(container!.textContent).toContain('user-1')

    const previewButton = Array.from(container!.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Preview rule set'))
    expect(previewButton).toBeTruthy()
    previewButton!.click()

    expect(previewRuleSet).toHaveBeenCalledTimes(1)
  })
})
