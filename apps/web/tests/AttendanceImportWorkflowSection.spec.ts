import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, reactive, ref, type App, type ComputedRef, type Ref } from 'vue'
import AttendanceImportWorkflowSection from '../src/views/attendance/AttendanceImportWorkflowSection.vue'
import type {
  AttendanceImportCommitLane,
  AttendanceImportFormState,
  AttendanceImportJob,
  AttendanceImportMappingProfile,
  AttendanceImportMode,
  AttendanceImportPreviewItem,
  AttendanceImportPreviewLane,
  AttendanceImportPreviewTask,
  AttendanceImportProfileGuide,
  AttendanceImportTemplateGuide,
} from '../src/views/attendance/useAttendanceAdminImportWorkflow'
import type { AttendanceRuleSet } from '../src/views/attendance/useAttendanceAdminRulesAndGroups'

type MaybePromise<T> = T | Promise<T>

interface ImportWorkflowBindings {
  importForm: AttendanceImportFormState
  importLoading: Ref<boolean>
  importMode: Ref<AttendanceImportMode>
  importProfileId: Ref<string>
  importMappingProfiles: Ref<AttendanceImportMappingProfile[]>
  selectedImportProfile: ComputedRef<AttendanceImportMappingProfile | null>
  importTemplateGuide: ComputedRef<AttendanceImportTemplateGuide | null>
  selectedImportProfileGuide: ComputedRef<AttendanceImportProfileGuide | null>
  importCsvFileName: Ref<string>
  importCsvFileId: Ref<string>
  importCsvFileRowCountHint: Ref<number | null>
  importCsvFileExpiresAt: Ref<string>
  importPayloadRowCountHint: ComputedRef<number | null>
  importPreviewLane: ComputedRef<AttendanceImportPreviewLane>
  importCommitLane: ComputedRef<AttendanceImportCommitLane>
  importCsvHeaderRow: Ref<string>
  importCsvDelimiter: Ref<string>
  importUserMapFileName: Ref<string>
  importUserMapCount: ComputedRef<number>
  importUserMapError: Ref<string>
  importUserMapKeyField: Ref<string>
  importUserMapSourceFields: Ref<string>
  importGroupAutoCreate: Ref<boolean>
  importGroupAutoAssign: Ref<boolean>
  importGroupRuleSetId: Ref<string>
  importGroupTimezone: Ref<string>
  importScalabilityHint: ComputedRef<string>
  importPreviewTask: Ref<AttendanceImportPreviewTask | null>
  importAsyncJob: Ref<AttendanceImportJob | null>
  importAsyncPolling: Ref<boolean>
  importAsyncJobTelemetryText: ComputedRef<string>
  importCsvWarnings: Ref<string[]>
  importPreview: Ref<AttendanceImportPreviewItem[]>
  loadImportTemplate: () => MaybePromise<void>
  downloadImportTemplateCsv: () => MaybePromise<void>
  applyImportCsvFile: () => MaybePromise<void>
  applyImportProfile: () => void
  previewImport: () => MaybePromise<void>
  runImport: () => MaybePromise<void>
  clearImportPreviewTask: () => void
  refreshImportAsyncJob: (options?: { silent?: boolean }) => MaybePromise<void>
  resumeImportAsyncJobPolling: () => MaybePromise<void>
  clearImportAsyncJob: () => void
  handleImportCsvChange: (event: Event) => void
  handleImportUserMapChange: (event: Event) => MaybePromise<void>
}

function flushUi(): Promise<void> {
  return Promise.resolve()
}

function createWorkflowBindings(overrides: Partial<ImportWorkflowBindings> = {}): ImportWorkflowBindings {
  const importMappingProfiles = ref<AttendanceImportMappingProfile[]>([])
  const importProfileId = ref('')
  const importGroupRuleSetId = ref('')

  return {
    importForm: reactive<AttendanceImportFormState>({
      ruleSetId: '',
      userId: '',
      timezone: 'Asia/Shanghai',
      payload: '{}',
    }),
    importLoading: ref(false),
    importMode: ref<AttendanceImportMode>('override'),
    importProfileId,
    importMappingProfiles,
    selectedImportProfile: computed(() => (
      importMappingProfiles.value.find(item => item.id === importProfileId.value) ?? null
    )),
    importTemplateGuide: computed(() => null),
    selectedImportProfileGuide: computed(() => null),
    importCsvFileName: ref(''),
    importCsvFileId: ref(''),
    importCsvFileRowCountHint: ref<number | null>(null),
    importCsvFileExpiresAt: ref(''),
    importPayloadRowCountHint: computed(() => 120),
    importPreviewLane: computed(() => 'chunked'),
    importCommitLane: computed(() => 'async'),
    importCsvHeaderRow: ref(''),
    importCsvDelimiter: ref(','),
    importUserMapFileName: ref(''),
    importUserMapCount: computed(() => 0),
    importUserMapError: ref(''),
    importUserMapKeyField: ref(''),
    importUserMapSourceFields: ref(''),
    importGroupAutoCreate: ref(false),
    importGroupAutoAssign: ref(false),
    importGroupRuleSetId,
    importGroupTimezone: ref(''),
    importScalabilityHint: computed(() => 'Auto mode hint'),
    importPreviewTask: ref<AttendanceImportPreviewTask | null>(null),
    importAsyncJob: ref<AttendanceImportJob | null>(null),
    importAsyncPolling: ref(false),
    importAsyncJobTelemetryText: computed(() => ''),
    importCsvWarnings: ref([]),
    importPreview: ref<AttendanceImportPreviewItem[]>([]),
    loadImportTemplate: vi.fn(),
    downloadImportTemplateCsv: vi.fn(),
    applyImportCsvFile: vi.fn(),
    applyImportProfile: vi.fn(),
    previewImport: vi.fn(),
    runImport: vi.fn(),
    clearImportPreviewTask: vi.fn(),
    refreshImportAsyncJob: vi.fn(),
    resumeImportAsyncJobPolling: vi.fn(),
    clearImportAsyncJob: vi.fn(),
    handleImportCsvChange: vi.fn(),
    handleImportUserMapChange: vi.fn(),
    ...overrides,
  }
}

describe('AttendanceImportWorkflowSection', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  const tr = (en: string, _zh: string) => en
  const formatDateTime = (value: string | null | undefined) => value ?? '--'
  const formatStatus = (value: string) => value
  const formatList = (items?: string[] | null) => items?.join(', ') ?? '--'
  const formatPolicyList = () => '--'

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

  it('summarizes the current import plan with profile, user map, and group sync details', async () => {
    const profiles: AttendanceImportMappingProfile[] = [{
      id: 'profile-dingtalk',
      name: 'DingTalk',
      requiredFields: ['userId', 'workDate'],
    }]
    const ruleSets: AttendanceRuleSet[] = [{
      id: 'rule-set-1',
      name: 'Ops Rules',
      timezone: 'Asia/Shanghai',
      isDefault: false,
    }]

    const workflow = createWorkflowBindings({
      importMappingProfiles: ref(profiles),
      importProfileId: ref('profile-dingtalk'),
      selectedImportProfile: computed(() => profiles[0] ?? null),
      importCsvFileName: ref('attendance.csv'),
      importPayloadRowCountHint: computed(() => 240),
      importPreviewLane: computed(() => 'chunked'),
      importCommitLane: computed(() => 'async'),
      importUserMapCount: computed(() => 18),
      importUserMapKeyField: ref('empNo'),
      importUserMapSourceFields: ref('工号, 姓名'),
      importGroupAutoCreate: ref(true),
      importGroupRuleSetId: ref('rule-set-1'),
      importGroupTimezone: ref('Asia/Shanghai'),
    })

    app = createApp(AttendanceImportWorkflowSection, {
      tr,
      ruleSets,
      formatDateTime,
      workflow,
      importStatusVisible: false,
      statusMessage: '',
      statusCode: '',
      statusHint: '',
      statusActionLabel: '',
      statusActionBusy: false,
      runStatusAction: vi.fn(),
      formatStatus,
      formatList,
      formatPolicyList,
    })
    app.mount(container!)
    await flushUi()

    expect(container!.textContent).toContain('Current import plan')
    expect(container!.textContent).toContain('Input channel: local CSV file')
    expect(container!.textContent).toContain('attendance.csv')
    expect(container!.textContent).toContain('Estimated rows: 240')
    expect(container!.textContent).toContain('Preview lane: chunked preview')
    expect(container!.textContent).toContain('Import lane: async queue')
    expect(container!.textContent).toContain('Mapping profile: DingTalk (2 required fields)')
    expect(container!.textContent).toContain('User map: 18 entries ready · key empNo · source 工号, 姓名')
    expect(container!.textContent).toContain('Group sync: auto-create groups · rule set Ops Rules · timezone Asia/Shanghai')
  })

  it('shows manual-plan fallbacks when mapping, user map, and group sync are unset', async () => {
    const workflow = createWorkflowBindings({
      importPayloadRowCountHint: computed(() => 8),
      importPreviewLane: computed(() => 'sync'),
      importCommitLane: computed(() => 'sync'),
    })

    app = createApp(AttendanceImportWorkflowSection, {
      tr,
      ruleSets: [],
      formatDateTime,
      workflow,
      importStatusVisible: false,
      statusMessage: '',
      statusCode: '',
      statusHint: '',
      statusActionLabel: '',
      statusActionBusy: false,
      runStatusAction: vi.fn(),
      formatStatus,
      formatList,
      formatPolicyList,
    })
    app.mount(container!)
    await flushUi()

    expect(container!.textContent).toContain('Input channel: JSON payload')
    expect(container!.textContent).toContain('Preview lane: sync request')
    expect(container!.textContent).toContain('Import lane: sync request')
    expect(container!.textContent).toContain('Mapping profile: manual payload only')
    expect(container!.textContent).toContain('User map: not configured')
    expect(container!.textContent).toContain('Group sync: disabled')
  })
})
