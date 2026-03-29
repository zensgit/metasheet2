import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import DirectoryManagementView from '../src/views/DirectoryManagementView.vue'
import * as apiModule from '../src/utils/api'

vi.mock('../src/utils/api', () => ({
  apiFetch: vi.fn(),
}))

type MockResponseOptions = {
  status?: number
  ok?: boolean
  headers?: Record<string, string>
  blob?: Blob
}

const originalCreateObjectURL = globalThis.URL.createObjectURL
const originalRevokeObjectURL = globalThis.URL.revokeObjectURL
const originalClipboard = globalThis.navigator.clipboard
const BATCH_FAILURE_REASON_NOTE_PREFERENCES_STORAGE_KEY = 'metasheet_directory_batch_failure_note_preferences'
const BATCH_FAILURE_REASON_TEAM_TEMPLATES_STORAGE_KEY = 'metasheet_directory_batch_failure_team_templates'
const BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_HISTORY_STORAGE_KEY = 'metasheet_directory_batch_failure_team_template_import_history'
const BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_PRESETS_STORAGE_KEY = 'metasheet_directory_batch_failure_team_template_import_presets'
const BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_PRESET_PREFERENCES_STORAGE_KEY = 'metasheet_directory_batch_failure_team_template_import_preset_preferences'
const BATCH_FAILURE_REASON_TEAM_TEMPLATE_CODE_PREFIX = 'MSDT-TPL-1:'

function createMockResponse(payload: unknown, statusOrOptions: number | MockResponseOptions = 200, explicitOk?: boolean) {
  const options = typeof statusOrOptions === 'number'
    ? {
        status: statusOrOptions,
        ok: explicitOk ?? statusOrOptions < 300,
      }
    : {
        status: statusOrOptions.status ?? 200,
        ok: statusOrOptions.ok ?? (statusOrOptions.status ?? 200) < 300,
        headers: statusOrOptions.headers,
        blob: statusOrOptions.blob,
      }
  const headers = Object.fromEntries(
    Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  )

  return {
    ok: options.ok,
    status: options.status,
    headers: {
      get: vi.fn((name: string) => headers[name.toLowerCase()] ?? null),
    },
    json: vi.fn(async () => payload),
    blob: vi.fn(async () => options.blob ?? new Blob([''], { type: 'text/plain' })),
  } as Response
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), 0)
  })
}

function encodeTeamTemplateCode(payload: unknown): string {
  const json = JSON.stringify(payload)
  const bytes = new TextEncoder().encode(json)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return `${BATCH_FAILURE_REASON_TEAM_TEMPLATE_CODE_PREFIX}${btoa(binary)}`
}

function mountDirectoryManagement() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(DirectoryManagementView)
  app.mount(container)

  return {
    container,
    unmount: () => {
      app.unmount()
      container.remove()
    },
  }
}

const integrationId = 'dir-1'
const accountId = 'acct-1'
const accountsUrl = `/api/admin/directory/integrations/${integrationId}/accounts`

const integration = {
  id: integrationId,
  name: '钉钉总部目录',
  provider: 'dingtalk',
  corp_id: 'ding-test-corp',
  status: 'active',
  sync_enabled: true,
  schedule_cron: '0 3 * * *',
  default_deprovision_policy: ['mark_inactive', 'disable_dingtalk_auth'],
  config: {
    appKey: 'ding-app-key',
    appSecret: 'ding-app-secret',
    rootDepartmentId: 'root-department',
    captureUnboundLogins: true,
  },
}

const emptyTemplateCenter = {
  integration_id: integrationId,
  team_templates: {},
  import_history: [],
  import_presets: {},
  created_by: 'admin-1',
  updated_by: 'admin-1',
  created_at: '2026-03-27T00:00:00.000Z',
  updated_at: '2026-03-27T00:01:00.000Z',
}

const populatedTemplateCenter = {
  ...emptyTemplateCenter,
  team_templates: {
    ticket: {
      title: '团队工单模板',
    },
  },
  import_presets: {
    ticket: [{
      id: 'preset-1',
      name: '值班模板',
      tags: ['值班'],
      favorite: true,
      pinned: false,
      use_count: 3,
      last_used_at: '2026-03-27T00:03:00.000Z',
      ignored_field_count: 1,
      usage_bucket: 'high',
    }],
  },
}

const emptyTemplateCenterVersions: Array<Record<string, unknown>> = []

const populatedTemplateCenterVersions = [{
  id: 'ver-1',
  center_id: 'center-1',
  integration_id: integrationId,
  change_reason: 'save_team_template',
  created_by: 'admin-1',
  created_at: '2026-03-27T00:02:00.000Z',
  snapshot_summary: {
    output_modes: ['ticket'],
    team_template_count: 1,
    import_preset_count: 1,
    import_history_count: 0,
  },
}]

const emptyTemplateGovernanceReport = {
  integration_id: integrationId,
  generated_at: '2026-03-27T00:04:00.000Z',
  totals: {
    output_modes: 1,
    team_templates: 0,
    import_presets: 0,
    favorites: 0,
    pinned: 0,
    high_frequency: 0,
    low_frequency: 0,
    unused: 0,
    distinct_tags: 0,
  },
  tagSummary: [],
  presets: [],
}

const scheduleStatus = {
  integration_id: integrationId,
  sync_enabled: true,
  schedule_cron: '0 3 * * *',
  next_run_at: '2026-03-28T03:00:00.000Z',
  last_run_status: 'success',
  last_run_started_at: '2026-03-27T00:00:00.000Z',
  last_run_finished_at: '2026-03-27T00:05:00.000Z',
  last_success_at: '2026-03-27T00:05:00.000Z',
  last_error: '',
  alert_count: 1,
  unacknowledged_alert_count: 1,
  last_alert_at: '2026-03-27T00:06:00.000Z',
}

const populatedTemplateGovernanceReport = {
  ...emptyTemplateGovernanceReport,
  totals: {
    ...emptyTemplateGovernanceReport.totals,
    team_templates: 1,
    import_presets: 1,
    favorites: 1,
    high_frequency: 1,
    distinct_tags: 1,
  },
  tagSummary: [{
    tag: '值班',
    count: 1,
  }],
  presets: [{
    output_mode: 'ticket',
    id: 'preset-1',
    name: '值班模板',
    tags: ['值班'],
    favorite: true,
    pinned: false,
    use_count: 3,
    last_used_at: '2026-03-27T00:03:00.000Z',
    ignored_field_count: 1,
    usage_bucket: 'high',
  }],
}

const syncAlert = {
  id: 'alert-1',
  integration_id: integrationId,
  run_id: 'run-1',
  level: 'error',
  code: 'DIRECTORY_SYNC_FAILED',
  message: '同步失败',
  details: {
    source: 'scheduled',
  },
  sent_to_webhook: true,
  acknowledged_at: '',
  acknowledged_by: '',
  created_at: '2026-03-27T00:06:00.000Z',
  updated_at: '2026-03-27T00:06:00.000Z',
}

const emptySyncAlerts: Array<Record<string, unknown>> = []

const directoryActivityEntry = {
  id: 'audit-1',
  created_at: '2026-03-29T01:00:00.000Z',
  event_type: 'admin.directory',
  event_category: 'admin',
  event_severity: 'info',
  action: 'authorize',
  resource_type: 'directory-account',
  resource_id: accountId,
  actor_user_id: 'admin-1',
  actor_name: '管理员',
  actor_email: 'admin@example.com',
  action_details: {
    integrationId,
    accountId,
    localUserId: 'user-1',
    strategy: 'manual',
  },
  error_code: '',
  integration_id: integrationId,
  integration_name: '钉钉总部目录',
  account_id: accountId,
  account_name: '周华',
  account_email: 'zhou@example.com',
  account_external_user_id: 'ding-user-1',
}

const run = {
  id: 'run-1',
  status: 'success',
  started_at: '2026-03-24T00:00:00.000Z',
  finished_at: '2026-03-24T00:05:00.000Z',
  error_message: '',
  stats: {
    departmentsFetched: 4,
    accountsFetched: 12,
    accountsInserted: 2,
    accountsUpdated: 1,
    linksMatched: 3,
    linksConflicted: 1,
    accountsDeactivated: 0,
  },
}

const department = {
  id: 'dep-1',
  external_department_id: 'dep-external-1',
  name: '研发中心',
  full_path: '总部 / 研发中心',
  is_active: true,
  order_index: 1,
}

const account = {
  id: accountId,
  external_user_id: 'ding-user-1',
  name: '周华',
  nick: 'Zhou',
  email: 'zhou@example.com',
  mobile: '13800000000',
  job_number: 'E001',
  title: '工程师',
  is_active: true,
  match_status: 'pending',
  match_strategy: 'email_exact',
  link_status: 'pending',
  dingtalk_auth_enabled: false,
  is_bound: false,
  deprovision_policy_override: ['mark_inactive'],
  effective_deprovision_policy: ['mark_inactive'],
  departmentNames: ['研发中心'],
}

const secondAccountId = 'acct-2'
const secondAccount = {
  id: secondAccountId,
  external_user_id: 'ding-user-2',
  name: '李青',
  nick: 'Li',
  email: 'li@example.com',
  mobile: '13900000000',
  job_number: 'E002',
  title: '产品经理',
  is_active: true,
  match_status: 'conflict',
  match_strategy: 'manual',
  link_status: 'conflict',
  dingtalk_auth_enabled: true,
  is_bound: true,
  deprovision_policy_override: ['disable_dingtalk_auth', 'disable_local_user'],
  effective_deprovision_policy: ['disable_dingtalk_auth', 'disable_local_user'],
  departmentNames: ['研发中心'],
}

const thirdAccountId = 'acct-3'
const thirdAccount = {
  id: thirdAccountId,
  external_user_id: 'ding-user-3',
  name: '王敏',
  nick: 'Wang',
  email: '',
  mobile: '13600000000',
  job_number: 'E003',
  title: '运营',
  is_active: true,
  match_status: 'pending',
  match_strategy: '',
  link_status: 'pending',
  dingtalk_auth_enabled: false,
  is_bound: false,
  deprovision_policy_override: null,
  effective_deprovision_policy: ['mark_inactive'],
  departmentNames: ['研发中心'],
}

const accountDetail = {
  ...account,
  match_status: 'linked',
  link_status: 'linked',
  dingtalk_auth_enabled: true,
  is_bound: true,
  linkedUser: {
    id: 'user-1',
    email: 'zhou@example.com',
    name: '周华',
    is_active: true,
  },
}

const secondAccountDetail = {
  ...secondAccount,
  linkedUser: {
    id: 'user-2',
    email: 'li@example.com',
    name: '李青',
    is_active: true,
  },
}

const thirdAccountDetail = {
  ...thirdAccount,
  linkedUser: null,
}

const fourthAccountId = 'acct-4'
const fourthAccount = {
  id: fourthAccountId,
  external_user_id: 'ding-user-4',
  name: '陈晨',
  nick: 'Chen',
  email: 'chen@example.com',
  mobile: '13500000000',
  job_number: 'E004',
  title: '客服',
  is_active: true,
  match_status: 'pending',
  match_strategy: '',
  link_status: 'pending',
  dingtalk_auth_enabled: false,
  is_bound: false,
  deprovision_policy_override: null,
  effective_deprovision_policy: ['mark_inactive'],
  departmentNames: ['研发中心'],
}

const fourthAccountDetail = {
  ...fourthAccount,
  linkedUser: null,
}

function flushAll(): Promise<void> {
  return flushPromises().then(() => nextTick()).then(() => flushPromises()).then(() => nextTick())
}

function findButtonByText(root: ParentNode, text: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll('button'))
    .find((button) => button.textContent?.includes(text)) as HTMLButtonElement | undefined
}

function findInputByPlaceholder(root: ParentNode, placeholder: string): HTMLInputElement | undefined {
  return Array.from(root.querySelectorAll('input'))
    .find((input) => (input as HTMLInputElement).placeholder.includes(placeholder)) as HTMLInputElement | undefined
}

function findImportPresetTextInputs(root: ParentNode): HTMLInputElement[] {
  return Array.from(root.querySelectorAll('.directory-admin__batch-note-import input[type="text"]'))
    .map((input) => input as HTMLInputElement)
    .filter((input) => !input.placeholder.includes('按预设名称或标签筛选'))
}

function getSavedImportPresetButtonTexts(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll('.directory-admin__batch-note-import-presets .directory-admin__batch-note-import-preset-group .directory-admin__preset'))
    .map((button) => button.textContent?.trim())
    .filter((text): text is string => Boolean(text))
}

async function openTicketTemplateImportFromBatchFailure(container: HTMLElement): Promise<HTMLElement> {
  const accountSelectionCheckboxes = Array.from(
    container.querySelectorAll('.directory-admin__selection-toggle--account input[type="checkbox"]'),
  ) as HTMLInputElement[]
  accountSelectionCheckboxes[2]?.click()
  accountSelectionCheckboxes[3]?.click()
  await flushAll()

  findButtonByText(container, '批量开通并授权')?.click()
  await flushAll()

  const reasonButton = Array.from(container.querySelectorAll('.directory-admin__batch-failure-group-button'))
    .find((button) => button.textContent?.includes('邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联')) as HTMLButtonElement | undefined
  reasonButton?.click()
  await flushAll()

  let noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
  const ticketButton = Array.from(noteRoot?.querySelectorAll('.directory-admin__batch-note-output .directory-admin__preset') || [])
    .find((button) => button.textContent?.includes('工单 Markdown')) as HTMLButtonElement | undefined
  ticketButton?.click()
  await flushAll()

  noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
  findButtonByText(noteRoot || container, '导入模板码')?.click()
  await flushAll()

  return container.querySelector('.directory-admin__batch-note') as HTMLElement
}

async function pasteTeamTemplateImportCode(noteRoot: HTMLElement, payload: unknown): Promise<HTMLElement> {
  const importTextarea = noteRoot.querySelector('.directory-admin__batch-note-import textarea') as HTMLTextAreaElement | null
  expect(importTextarea).toBeTruthy()
  importTextarea!.value = encodeTeamTemplateCode(payload)
  importTextarea!.dispatchEvent(new Event('input', { bubbles: true }))
  await flushAll()
  return noteRoot
}

describe('DirectoryManagementView', () => {
  beforeEach(() => {
    localStorage.clear()
    Object.defineProperty(globalThis.URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(() => 'blob:directory-management-export'),
    })
    Object.defineProperty(globalThis.URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    })
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: {
        writeText: vi.fn(async () => {}),
      },
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.mocked(apiModule.apiFetch).mockReset()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/admin/directory/integrations') {
        return createMockResponse({ ok: true, data: { items: [integration] } })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}` && init?.method === 'PATCH') {
        return createMockResponse({
          ok: true,
          data: {
            ...integration,
            config: {
              ...integration.config,
              captureUnboundLogins: init?.body && typeof init.body === 'string'
                ? JSON.parse(init.body).captureUnboundLogins !== false
                : true,
            },
          },
        })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/runs`) {
        return createMockResponse({ ok: true, data: { items: [run] } })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/departments`) {
        return createMockResponse({ ok: true, data: { items: [department] } })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/template-center`) {
        if (init?.method === 'PATCH') {
          const body = init?.body && typeof init.body === 'string'
            ? JSON.parse(init.body)
            : {}
          return createMockResponse({
            ok: true,
            data: {
              ...emptyTemplateCenter,
              team_templates: body.teamTemplates ?? {},
              import_history: body.importHistory ?? [],
              import_presets: body.importPresets ?? {},
              updated_at: '2026-03-27T00:02:00.000Z',
            },
          })
        }
        return createMockResponse({ ok: true, data: emptyTemplateCenter })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/template-center/versions?limit=8`) {
        return createMockResponse({ ok: true, data: { items: emptyTemplateCenterVersions } })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/template-center/report`) {
        return createMockResponse({ ok: true, data: emptyTemplateGovernanceReport })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/template-center/report.csv`) {
        return createMockResponse(
          { ok: true },
          {
            headers: {
              'content-disposition': 'attachment; filename="directory-template-governance-dir-1.csv"',
            },
            blob: new Blob(['output_mode,preset_id,name\n ticket,preset-1,值班模板'], { type: 'text/csv' }),
          },
        )
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/template-center/versions/ver-1/restore` && init?.method === 'POST') {
        return createMockResponse({ ok: true, data: emptyTemplateCenter })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/schedule-status`) {
        return createMockResponse({ ok: true, data: scheduleStatus })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/alerts?limit=8`) {
        return createMockResponse({ ok: true, data: { items: emptySyncAlerts } })
      }

      if (url.startsWith(`/api/admin/directory/integrations/${integrationId}/activity/export.csv`)) {
        return createMockResponse(
          { ok: true },
          {
            headers: {
              'content-disposition': 'attachment; filename="directory-activity-dir-1.csv"',
              'x-export-total': '1',
              'x-export-returned': '1',
              'x-export-truncated': 'false',
            },
            blob: new Blob(['id,resource_type,action\n audit-1,directory-account,authorize'], { type: 'text/csv' }),
          },
        )
      }

      if (url.startsWith(`/api/admin/directory/integrations/${integrationId}/activity`)) {
        return createMockResponse({
          ok: true,
          data: {
            total: 1,
            page: 1,
            pageSize: 10,
            pageCount: 1,
            hasNextPage: false,
            hasPreviousPage: false,
            summary: {
              total: 1,
              integrationActions: 0,
              accountActions: 1,
              syncActions: 0,
              alertActions: 0,
              templateActions: 0,
            },
            items: [directoryActivityEntry],
          },
        })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/alerts/alert-1/ack` && init?.method === 'POST') {
        return createMockResponse({
          ok: true,
          data: {
            ...syncAlert,
            acknowledged_at: '2026-03-27T00:07:00.000Z',
            acknowledged_by: 'admin-1',
          },
        })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${accountId}`) {
        return createMockResponse({ ok: true, data: accountDetail })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${secondAccountId}`) {
        return createMockResponse({ ok: true, data: secondAccountDetail })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}`) {
        return createMockResponse({ ok: true, data: thirdAccountDetail })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}`) {
        return createMockResponse({ ok: true, data: fourthAccountDetail })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/test` && init?.method === 'POST') {
        return createMockResponse({ ok: true, data: { ok: true, departmentSampleCount: 2 } })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/export.csv`) {
        return createMockResponse(
          { ok: true },
          {
            headers: {
              'content-disposition': 'attachment; filename="directory-accounts-dir-1.csv"',
              'x-export-total': '45',
              'x-export-returned': '45',
              'x-export-truncated': 'false',
            },
            blob: new Blob(['external_user_id,name\n ding-user-1,周华'], { type: 'text/csv' }),
          },
        )
      }

      if (url === accountsUrl || url.startsWith(`${accountsUrl}?`)) {
        const query = url.slice(accountsUrl.length)
        const params = new URLSearchParams(query.replace(/^\?/, ''))
        const page = Number(params.get('page') || '1')
        const pageSize = Number(params.get('pageSize') || '20')

        if (page === 2) {
          return createMockResponse({
            ok: true,
            data: {
              total: 45,
              page,
              pageSize,
              pageCount: 3,
              hasNextPage: true,
              hasPreviousPage: true,
              summary: {
                linked: 18,
                pending: 20,
                conflict: 7,
                ignored: 0,
                active: 45,
                inactive: 0,
                dingtalkAuthEnabled: 21,
                dingtalkAuthDisabled: 24,
                bound: 20,
                unbound: 25,
              },
              items: [secondAccount],
            },
          })
        }

        return createMockResponse({
          ok: true,
          data: {
            total: 45,
            page,
            pageSize,
            pageCount: 3,
            hasNextPage: true,
            hasPreviousPage: false,
            summary: {
              linked: 18,
              pending: 20,
              conflict: 7,
              ignored: 0,
              active: 45,
              inactive: 0,
              dingtalkAuthEnabled: 21,
                dingtalkAuthDisabled: 24,
                bound: 20,
                unbound: 25,
              },
            items: [account, secondAccount, thirdAccount, fourthAccount],
          },
        })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/sync` && init?.method === 'POST') {
        return createMockResponse({ ok: true, data: { accepted: true } })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${accountId}/authorize-dingtalk` && init?.method === 'POST') {
        return createMockResponse({ ok: true, data: { updated: true } })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${accountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: true,
          data: {
            created: true,
            temporary_password: 'Temp#20260325',
            user: {
              email: 'zhou@example.com',
            },
          },
        })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: true,
          data: {
            created: true,
            temporary_password: 'Temp#20260326',
            user: {
              email: 'generated-third@example.com',
            },
          },
        })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${secondAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: true,
          data: {
            created: true,
            temporary_password: 'Temp#20260327',
            user: {
              email: 'li@example.com',
            },
          },
        })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}/auto-link-by-email` && init?.method === 'POST') {
        return createMockResponse({ ok: true, data: { linked: true } })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${accountId}/ignore` && init?.method === 'POST') {
        return createMockResponse({ ok: true, data: { ignored: true } })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/ignore` && init?.method === 'POST') {
        return createMockResponse({ ok: true, data: { ignored: true } })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${secondAccountId}/ignore` && init?.method === 'POST') {
        return createMockResponse({ ok: true, data: { ignored: true } })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}/ignore` && init?.method === 'POST') {
        return createMockResponse({ ok: true, data: { ignored: true } })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${accountId}/auto-link-by-email` && init?.method === 'POST') {
        return createMockResponse({ ok: true, data: { linked: true } })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/auto-link-by-email` && init?.method === 'POST') {
        return createMockResponse({ ok: true, data: { linked: true } })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${accountId}/unlink` && init?.method === 'POST') {
        return createMockResponse({ ok: true, data: { unlinked: true } })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${accountId}/deprovision-policy` && init?.method === 'POST') {
        return createMockResponse({ ok: true, data: { updated: true } })
      }

      throw new Error(`Unexpected apiFetch call: ${url}`)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.removeItem(BATCH_FAILURE_REASON_NOTE_PREFERENCES_STORAGE_KEY)
    localStorage.removeItem(BATCH_FAILURE_REASON_TEAM_TEMPLATES_STORAGE_KEY)
    localStorage.removeItem(BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_HISTORY_STORAGE_KEY)
    localStorage.removeItem(BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_PRESETS_STORAGE_KEY)
    localStorage.removeItem(BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_PRESET_PREFERENCES_STORAGE_KEY)
    Object.defineProperty(globalThis.URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: originalCreateObjectURL,
    })
    Object.defineProperty(globalThis.URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: originalRevokeObjectURL,
    })
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: originalClipboard,
    })
    document.body.innerHTML = ''
  })

  it('loads integrations, runs, members and policy details on mount', async () => {
    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    expect(container.textContent).toContain('钉钉总部目录')
    expect(container.textContent).toContain('研发中心')
    expect(container.textContent).toContain('周华')
    expect(container.textContent).toContain('标记目录失活')
    expect(container.textContent).toContain('同步运行')
    expect(container.textContent).toContain('45 名成员')
    expect(container.textContent).toContain('计划同步与告警')
    expect(container.textContent).toContain('目录操作历史')
    expect(container.textContent).toContain('授权钉钉')
    expect(container.textContent).toContain('模板中心')
    expect(container.textContent).toContain('团队标准 0 · 导入预设 0 · 高频 0')
    expect(vi.mocked(apiModule.apiFetch)).toHaveBeenCalledWith(`${accountsUrl}?page=1&pageSize=20`)
    unmount()
  })

  it('filters directory activity to the selected account and exports csv', async () => {
    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    findButtonByText(container, '仅看当前成员：周华')?.click()
    await flushAll()

    const activityCalls = vi.mocked(apiModule.apiFetch).mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.startsWith(`/api/admin/directory/integrations/${integrationId}/activity?`))
    expect(activityCalls.some((url) => url.includes(`accountId=${accountId}`))).toBe(true)

    findButtonByText(container, '导出历史 CSV')?.click()
    await flushAll()

    expect(vi.mocked(apiModule.apiFetch)).toHaveBeenCalledWith(
      expect.stringContaining(`/api/admin/directory/integrations/${integrationId}/activity/export.csv?accountId=${accountId}`),
      expect.objectContaining({
        headers: {
          Accept: 'text/csv',
        },
      }),
    )

    unmount()
  })

  it('loads server-backed governance resources and acknowledges alerts', async () => {
    const baseImplementation = vi.mocked(apiModule.apiFetch).getMockImplementation()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/template-center`) {
        return createMockResponse({ ok: true, data: populatedTemplateCenter })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/template-center/versions?limit=8`) {
        return createMockResponse({ ok: true, data: { items: populatedTemplateCenterVersions } })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/template-center/report`) {
        return createMockResponse({ ok: true, data: populatedTemplateGovernanceReport })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/template-center/report.csv`) {
        return createMockResponse(
          { ok: true },
          {
            headers: {
              'content-disposition': 'attachment; filename="directory-template-governance-dir-1.csv"',
            },
            blob: new Blob(['output_mode,preset_id,name\n ticket,preset-1,值班模板'], { type: 'text/csv' }),
          },
        )
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/template-center/versions/ver-1/restore` && init?.method === 'POST') {
        return createMockResponse({ ok: true, data: populatedTemplateCenter })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/alerts?limit=8`) {
        return createMockResponse({ ok: true, data: { items: [syncAlert] } })
      }

      if (url === `/api/admin/directory/integrations/${integrationId}/alerts/alert-1/ack` && init?.method === 'POST') {
        return createMockResponse({
          ok: true,
          data: {
            ...syncAlert,
            acknowledged_at: '2026-03-27T00:07:00.000Z',
            acknowledged_by: 'admin-1',
          },
        })
      }

      if (!baseImplementation) {
        throw new Error(`Unexpected apiFetch call: ${url}`)
      }
      return await baseImplementation(url, init)
    })

    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    expect(vi.mocked(apiModule.apiFetch).mock.calls.some((call) => call[0] === `/api/admin/directory/integrations/${integrationId}/template-center`)).toBe(true)
    expect(vi.mocked(apiModule.apiFetch).mock.calls.some((call) => call[0] === `/api/admin/directory/integrations/${integrationId}/template-center/versions?limit=8`)).toBe(true)
    expect(vi.mocked(apiModule.apiFetch).mock.calls.some((call) => call[0] === `/api/admin/directory/integrations/${integrationId}/template-center/report`)).toBe(true)
    expect(vi.mocked(apiModule.apiFetch).mock.calls.some((call) => call[0] === `/api/admin/directory/integrations/${integrationId}/schedule-status`)).toBe(true)
    expect(vi.mocked(apiModule.apiFetch).mock.calls.some((call) => call[0] === `/api/admin/directory/integrations/${integrationId}/alerts?limit=8`)).toBe(true)
    expect(container.textContent).toContain('团队标准 1 · 导入预设 1 · 高频 1')
    expect(container.textContent).toContain('同步失败告警')

    findButtonByText(container, '确认告警')?.click()
    await flushAll()
    expect(vi.mocked(apiModule.apiFetch)).toHaveBeenCalledWith(
      `/api/admin/directory/integrations/${integrationId}/alerts/alert-1/ack`,
      expect.objectContaining({ method: 'POST' }),
    )

    expect(container.textContent).toContain('同步告警已确认')
    unmount()
  })

  it('paginates members via the pagination controls', async () => {
    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const memberPager = Array.from(container.querySelectorAll('.directory-admin__pager'))
      .find((element) => element.textContent?.includes('共 45 条')) as HTMLElement | undefined
    const nextPageButton = Array.from(memberPager?.querySelectorAll('button') || [])
      .find((button) => button.textContent?.trim() === '下一页')
    expect(nextPageButton).toBeDefined()
    nextPageButton?.click()
    await flushAll()

    const accountCalls = vi.mocked(apiModule.apiFetch).mock.calls.filter((call) => call[0] === accountsUrl || call[0].startsWith(`${accountsUrl}?`))
    expect(accountCalls.pop()?.[0]).toContain('page=2')
    expect(container.textContent).toContain('李青')
    unmount()
  })

  it('applies quick filters for pending, bound, and DingTalk authorization states', async () => {
    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const findQuickFilter = (label: string) =>
      Array.from(container.querySelectorAll('.directory-admin__preset')).find((button) => button.textContent?.includes(label)) as HTMLButtonElement | undefined

    findQuickFilter('仅看待审核')?.click()
    await flushAll()
    let accountCalls = vi.mocked(apiModule.apiFetch).mock.calls.filter((call) => call[0] === accountsUrl || call[0].startsWith(`${accountsUrl}?`))
    expect(accountCalls.pop()?.[0]).toContain('linkStatus=pending')

    findQuickFilter('仅看已绑定')?.click()
    await flushAll()
    accountCalls = vi.mocked(apiModule.apiFetch).mock.calls.filter((call) => call[0] === accountsUrl || call[0].startsWith(`${accountsUrl}?`))
    expect(accountCalls.pop()?.[0]).toContain('isBound=true')

    findQuickFilter('仅看未授权钉钉')?.click()
    await flushAll()
    accountCalls = vi.mocked(apiModule.apiFetch).mock.calls.filter((call) => call[0] === accountsUrl || call[0].startsWith(`${accountsUrl}?`))
    expect(accountCalls.pop()?.[0]).toContain('dingtalkAuthEnabled=false')
    unmount()
  })

  it('calls the test connection endpoint', async () => {
    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const buttons = Array.from(container.querySelectorAll('button'))
    const testButton = buttons.find((button) => button.textContent?.includes('测试连接'))
    expect(testButton).toBeDefined()
    testButton?.click()
    await flushAll()

    expect(vi.mocked(apiModule.apiFetch)).toHaveBeenCalledWith(
      `/api/admin/directory/integrations/${integrationId}/test`,
      expect.objectContaining({ method: 'POST' }),
    )
    unmount()
  })

  it('supports selecting the current page and batch ignoring directory accounts', async () => {
    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const selectionLabel = Array.from(container.querySelectorAll('.directory-admin__selection-toggle'))
      .find((label) => label.textContent?.includes('全选当前页'))
    const selectionCheckbox = selectionLabel?.querySelector('input[type="checkbox"]') as HTMLInputElement | null
    const batchIgnoreButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('批量忽略'))

    expect(selectionCheckbox).not.toBeNull()
    expect(batchIgnoreButton).toBeDefined()

    selectionCheckbox?.click()
    await flushAll()
    batchIgnoreButton?.click()
    await flushAll()

    expect(vi.mocked(apiModule.apiFetch)).toHaveBeenCalledWith(
      `/api/admin/directory/integrations/${integrationId}/accounts/${accountId}/ignore`,
      expect.objectContaining({ method: 'POST' }),
    )
    expect(vi.mocked(apiModule.apiFetch)).toHaveBeenCalledWith(
      `/api/admin/directory/integrations/${integrationId}/accounts/${secondAccountId}/ignore`,
      expect.objectContaining({ method: 'POST' }),
    )
    expect(vi.mocked(apiModule.apiFetch)).toHaveBeenCalledWith(
      `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/ignore`,
      expect.objectContaining({ method: 'POST' }),
    )
    expect(container.textContent).toContain('批量忽略：已处理 4 项')
    unmount()
  })

  it('supports batch provisioning selected unlinked accounts with DingTalk authorization', async () => {
    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const selectionCheckboxes = Array.from(
      container.querySelectorAll('.directory-admin__selection-toggle--account input[type="checkbox"]'),
    ) as HTMLInputElement[]
    expect(selectionCheckboxes.length).toBeGreaterThanOrEqual(4)

    selectionCheckboxes[2]?.click()
    await flushAll()

    const batchProvisionButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('批量开通并授权'))
    expect(batchProvisionButton).toBeDefined()

    batchProvisionButton?.click()
    await flushAll()

    expect(vi.mocked(apiModule.apiFetch)).toHaveBeenCalledWith(
      `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/provision-user`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: '王敏',
          authorizeDingTalk: true,
        }),
      }),
    )
    expect(container.textContent).toContain('批量开通并授权：已处理 1 项')
    unmount()
  })

  it('supports batch auto-linking selected accounts by exact email', async () => {
    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const selectionCheckboxes = Array.from(
      container.querySelectorAll('.directory-admin__selection-toggle--account input[type="checkbox"]'),
    ) as HTMLInputElement[]
    expect(selectionCheckboxes.length).toBeGreaterThanOrEqual(4)

    selectionCheckboxes[3]?.click()
    await flushAll()

    const batchAutoLinkButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('按邮箱批量关联'))
    expect(batchAutoLinkButton).toBeDefined()

    batchAutoLinkButton?.click()
    await flushAll()

    expect(vi.mocked(apiModule.apiFetch)).toHaveBeenCalledWith(
      `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}/auto-link-by-email`,
      expect.objectContaining({ method: 'POST' }),
    )
    expect(container.textContent).toContain('按邮箱批量关联：已处理 1 项')
    unmount()
  })

  it('shows batch result details when email auto-link partially fails', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${secondAccountId}/auto-link-by-email` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱对应多个 MetaSheet 账号，请人工处理',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const selectionLabel = Array.from(container.querySelectorAll('.directory-admin__selection-toggle'))
      .find((label) => label.textContent?.includes('全选当前页'))
    const selectionCheckbox = selectionLabel?.querySelector('input[type="checkbox"]') as HTMLInputElement | null
    expect(selectionCheckbox).not.toBeNull()

    selectionCheckbox?.click()
    await flushAll()

    const batchAutoLinkButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('按邮箱批量关联'))
    expect(batchAutoLinkButton).toBeDefined()

    batchAutoLinkButton?.click()
    await flushAll()

    expect(container.textContent).toContain('本次批量处理结果')
    expect(container.textContent).toContain('共 2 项，成功 1 项，失败 1 项')
    expect(container.textContent).toContain('李青')
    expect(container.textContent).toContain('邮箱对应多个 MetaSheet 账号，请人工处理')
    unmount()
  })

  it('supports copying and exporting batch failure details', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${secondAccountId}/auto-link-by-email` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱对应多个 MetaSheet 账号，请人工处理',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const selectionLabel = Array.from(container.querySelectorAll('.directory-admin__selection-toggle'))
      .find((label) => label.textContent?.includes('全选当前页'))
    const selectionCheckbox = selectionLabel?.querySelector('input[type="checkbox"]') as HTMLInputElement | null
    expect(selectionCheckbox).not.toBeNull()

    selectionCheckbox?.click()
    await flushAll()

    const batchAutoLinkButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('按邮箱批量关联'))
    expect(batchAutoLinkButton).toBeDefined()
    batchAutoLinkButton?.click()
    await flushAll()

    const copyButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('复制失败清单'))
    const exportButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('导出失败 CSV'))
    expect(copyButton).toBeDefined()
    expect(exportButton).toBeDefined()

    copyButton?.click()
    await flushAll()
    expect(globalThis.navigator.clipboard.writeText).toHaveBeenCalled()
    expect(container.textContent).toContain('失败清单已复制（1 项）')

    exportButton?.click()
    await flushAll()
    expect(globalThis.URL.createObjectURL).toHaveBeenCalled()
    expect(container.textContent).toContain('失败清单 CSV 已导出（1 项）')
    unmount()
  })

  it('filters the account list down to failed batch members and can restore all members', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${secondAccountId}/auto-link-by-email` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱对应多个 MetaSheet 账号，请人工处理',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    let accountCards = Array.from(container.querySelectorAll('.directory-admin__account-card'))
    expect(accountCards.length).toBe(4)

    const selectionLabel = Array.from(container.querySelectorAll('.directory-admin__selection-toggle'))
      .find((label) => label.textContent?.includes('全选当前页'))
    const selectionCheckbox = selectionLabel?.querySelector('input[type="checkbox"]') as HTMLInputElement | null
    selectionCheckbox?.click()
    await flushAll()

    const batchAutoLinkButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('按邮箱批量关联'))
    batchAutoLinkButton?.click()
    await flushAll()

    const filterFailedButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('仅看失败成员（1）'))
    expect(filterFailedButton).toBeDefined()
    filterFailedButton?.click()
    await flushAll()

    accountCards = Array.from(container.querySelectorAll('.directory-admin__account-card'))
    expect(accountCards.length).toBe(1)
    expect(container.textContent).toContain('当前仅显示本次批量失败成员，便于立即重试处理。')
    expect(accountCards[0]?.textContent).toContain('李青')
    expect(accountCards[0]?.textContent).not.toContain('周华')

    const restoreAllButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('恢复全部成员'))
    expect(restoreAllButton).toBeDefined()
    restoreAllButton?.click()
    await flushAll()

    accountCards = Array.from(container.querySelectorAll('.directory-admin__account-card'))
    expect(accountCards.length).toBe(4)
    expect(container.textContent).toContain('已恢复全部成员列表')
    unmount()
  })

  it('offers and runs a recommended follow-up action for failed batch members', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${secondAccountId}/auto-link-by-email` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱对应多个 MetaSheet 账号，请人工处理',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const selectionLabel = Array.from(container.querySelectorAll('.directory-admin__selection-toggle'))
      .find((label) => label.textContent?.includes('全选当前页'))
    const selectionCheckbox = selectionLabel?.querySelector('input[type="checkbox"]') as HTMLInputElement | null
    selectionCheckbox?.click()
    await flushAll()

    const batchAutoLinkButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('按邮箱批量关联'))
    batchAutoLinkButton?.click()
    await flushAll()

    expect(container.textContent).toContain('推荐下一步')
    expect(container.textContent).toContain('推荐：批量开通并授权（1）')

    const recommendationButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('推荐：批量开通并授权（1）'))
    expect(recommendationButton).toBeDefined()
    recommendationButton?.click()
    await flushAll()

    expect(vi.mocked(apiModule.apiFetch)).toHaveBeenCalledWith(
      `/api/admin/directory/integrations/${integrationId}/accounts/${secondAccountId}/provision-user`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          email: 'li@example.com',
          name: '李青',
          authorizeDingTalk: true,
        }),
      }),
    )
    expect(container.textContent).toContain('推荐：批量开通并授权：已处理 1 项')
    unmount()
  })

  it('groups batch failures by reason in the result summary', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱不能为空，无法开户',
          },
        }, {
          status: 400,
          ok: false,
        })
      }
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱对应多个 MetaSheet 账号，请人工处理',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const accountSelectionCheckboxes = Array.from(
      container.querySelectorAll('.directory-admin__selection-toggle--account input[type="checkbox"]'),
    ) as HTMLInputElement[]
    accountSelectionCheckboxes[2]?.click()
    accountSelectionCheckboxes[3]?.click()
    await flushAll()

    const batchProvisionButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('批量开通并授权'))
    expect(batchProvisionButton).toBeDefined()
    batchProvisionButton?.click()
    await flushAll()

    expect(container.textContent).toContain('失败原因摘要')
    expect(container.textContent).toContain('邮箱不能为空，无法开户')
    expect(container.textContent).toContain('邮箱对应多个 MetaSheet 账号，请人工处理')
    expect(container.textContent).toContain('2 项，成功 0 项，失败 2 项')

    const summaryItems = Array.from(container.querySelectorAll('.directory-admin__batch-failure-group-list li'))
    expect(summaryItems.length).toBe(2)
    expect(summaryItems[0]?.textContent).toContain('1 项')
    expect(summaryItems[1]?.textContent).toContain('1 项')
    unmount()
  })

  it('filters failed members by clicking a failure reason group and restores all failed members on second click', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱不能为空，无法开户',
          },
        }, {
          status: 400,
          ok: false,
        })
      }
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱对应多个 MetaSheet 账号，请人工处理',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const accountSelectionCheckboxes = Array.from(
      container.querySelectorAll('.directory-admin__selection-toggle--account input[type="checkbox"]'),
    ) as HTMLInputElement[]
    accountSelectionCheckboxes[2]?.click()
    accountSelectionCheckboxes[3]?.click()
    await flushAll()

    const batchProvisionButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('批量开通并授权'))
    batchProvisionButton?.click()
    await flushAll()

    const reasonButton = Array.from(container.querySelectorAll('.directory-admin__batch-failure-group-button'))
      .find((button) => button.textContent?.includes('邮箱不能为空，无法开户')) as HTMLButtonElement | undefined
    expect(reasonButton).toBeDefined()

    reasonButton?.click()
    await flushAll()

    let accountCards = Array.from(container.querySelectorAll('.directory-admin__account-card'))
    expect(accountCards.length).toBe(1)
    expect(accountCards[0]?.textContent).toContain('王敏')
    expect(accountCards[0]?.textContent).not.toContain('陈晨')
    expect(container.textContent).toContain('当前仅显示失败原因“邮箱不能为空，无法开户”的成员')

    reasonButton?.click()
    await flushAll()

    accountCards = Array.from(container.querySelectorAll('.directory-admin__account-card'))
    expect(accountCards.length).toBe(2)
    expect(container.textContent).toContain('已恢复全部失败成员（2 项）')
    expect(container.textContent).toContain('邮箱不能为空，无法开户')
    expect(container.textContent).toContain('邮箱对应多个 MetaSheet 账号，请人工处理')
    unmount()
  })

  it('shows recommended action hints on failure reason summary items', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱不能为空，无法开户',
          },
        }, {
          status: 400,
          ok: false,
        })
      }
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const accountSelectionCheckboxes = Array.from(
      container.querySelectorAll('.directory-admin__selection-toggle--account input[type="checkbox"]'),
    ) as HTMLInputElement[]
    accountSelectionCheckboxes[2]?.click()
    accountSelectionCheckboxes[3]?.click()
    await flushAll()

    const batchProvisionButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('批量开通并授权'))
    expect(batchProvisionButton).toBeDefined()
    batchProvisionButton?.click()
    await flushAll()

    const missingEmailReasonButton = Array.from(container.querySelectorAll('.directory-admin__batch-failure-group-button'))
      .find((button) => button.textContent?.includes('邮箱不能为空，无法开户')) as HTMLButtonElement | undefined
    const autoLinkReasonButton = Array.from(container.querySelectorAll('.directory-admin__batch-failure-group-button'))
      .find((button) => button.textContent?.includes('邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联')) as HTMLButtonElement | undefined

    expect(missingEmailReasonButton).toBeDefined()
    expect(autoLinkReasonButton).toBeDefined()
    expect(missingEmailReasonButton?.textContent).toContain('建议：批量开通并授权')
    expect(autoLinkReasonButton?.textContent).toContain('建议：按邮箱批量关联')
    unmount()
  })

  it('shows and copies a manual handling note template for the active failure reason', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱不能为空，无法开户',
          },
        }, {
          status: 400,
          ok: false,
        })
      }
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const accountSelectionCheckboxes = Array.from(
      container.querySelectorAll('.directory-admin__selection-toggle--account input[type="checkbox"]'),
    ) as HTMLInputElement[]
    accountSelectionCheckboxes[2]?.click()
    accountSelectionCheckboxes[3]?.click()
    await flushAll()

    const batchProvisionButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('批量开通并授权'))
    expect(batchProvisionButton).toBeDefined()
    batchProvisionButton?.click()
    await flushAll()

    const reasonButton = Array.from(container.querySelectorAll('.directory-admin__batch-failure-group-button'))
      .find((button) => button.textContent?.includes('邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联')) as HTMLButtonElement | undefined
    expect(reasonButton).toBeDefined()
    reasonButton?.click()
    await flushAll()

    expect(container.textContent).toContain('人工处理备注模板')
    expect(container.textContent).toContain('建议动作：按邮箱批量关联')
    expect(container.textContent).toContain('陈晨（chen@example.com')

    const copyNoteButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('复制处理备注'))
    expect(copyNoteButton).toBeDefined()
    copyNoteButton?.click()
    await flushAll()

    expect(globalThis.navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('失败原因：邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联'),
    )
    expect(globalThis.navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('建议动作：按邮箱批量关联'),
    )
    expect(globalThis.navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('成员清单：'),
    )
    expect(container.textContent).toContain('处理备注已复制（1 项）')
    unmount()
  })

  it('supports switching manual handling note presets for an active failure reason', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱不能为空，无法开户',
          },
        }, {
          status: 400,
          ok: false,
        })
      }
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const accountSelectionCheckboxes = Array.from(
      container.querySelectorAll('.directory-admin__selection-toggle--account input[type="checkbox"]'),
    ) as HTMLInputElement[]
    accountSelectionCheckboxes[2]?.click()
    accountSelectionCheckboxes[3]?.click()
    await flushAll()

    const batchProvisionButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('批量开通并授权'))
    expect(batchProvisionButton).toBeDefined()
    batchProvisionButton?.click()
    await flushAll()

    const reasonButton = Array.from(container.querySelectorAll('.directory-admin__batch-failure-group-button'))
      .find((button) => button.textContent?.includes('邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联')) as HTMLButtonElement | undefined
    expect(reasonButton).toBeDefined()
    reasonButton?.click()
    await flushAll()

    const activePreset = Array.from(
      container.querySelectorAll('.directory-admin__batch-note-presets .directory-admin__preset--active'),
    )[0] as HTMLButtonElement | undefined
    expect(activePreset?.textContent).toContain('管理员处理')
    expect(container.textContent).toContain('默认推荐：管理员处理')

    const briefPresetButton = Array.from(
      container.querySelectorAll('.directory-admin__batch-note-presets .directory-admin__preset'),
    ).find((button) => button.textContent?.includes('IM 简版')) as HTMLButtonElement | undefined
    expect(briefPresetButton).toBeDefined()
    briefPresetButton?.click()
    await flushAll()

    expect(container.textContent).toContain('当前模板：IM 简版')
    expect(container.textContent).toContain('【目录失败】邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联')

    const copyNoteButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('复制处理备注'))
    expect(copyNoteButton).toBeDefined()
    copyNoteButton?.click()
    await flushAll()

    expect(globalThis.navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('【目录失败】邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联'),
    )
    unmount()
  })

  it('fills manual note context fields and snippets into the preview and copied note', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱不能为空，无法开户',
          },
        }, {
          status: 400,
          ok: false,
        })
      }
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const accountSelectionCheckboxes = Array.from(
      container.querySelectorAll('.directory-admin__selection-toggle--account input[type="checkbox"]'),
    ) as HTMLInputElement[]
    accountSelectionCheckboxes[2]?.click()
    accountSelectionCheckboxes[3]?.click()
    await flushAll()

    const batchProvisionButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('批量开通并授权'))
    expect(batchProvisionButton).toBeDefined()
    batchProvisionButton?.click()
    await flushAll()

    const reasonButton = Array.from(container.querySelectorAll('.directory-admin__batch-failure-group-button'))
      .find((button) => button.textContent?.includes('邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联')) as HTMLButtonElement | undefined
    expect(reasonButton).toBeDefined()
    reasonButton?.click()
    await flushAll()

    const noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot).toBeTruthy()

    const noteInputs = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-fields input')) as HTMLInputElement[]
    expect(noteInputs).toHaveLength(3)
    noteInputs[0]!.value = '值班管理员'
    noteInputs[0]!.dispatchEvent(new Event('input'))
    noteInputs[1]!.value = '今天 18:00 前'
    noteInputs[1]!.dispatchEvent(new Event('input'))
    noteInputs[2]!.value = '钉钉群#目录同步'
    noteInputs[2]!.dispatchEvent(new Event('input'))

    const extraTextarea = noteRoot!.querySelector('textarea') as HTMLTextAreaElement | null
    expect(extraTextarea).toBeTruthy()
    extraTextarea!.value = '请先核对邮箱归属'
    extraTextarea!.dispatchEvent(new Event('input'))
    await flushAll()

    const fillResultSnippet = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('处理后回填')) as HTMLButtonElement | undefined
    expect(fillResultSnippet).toBeDefined()
    fillResultSnippet?.click()
    await flushAll()

    expect(noteRoot!.textContent).toContain('处理负责人：值班管理员')
    expect(noteRoot!.textContent).toContain('截止时间：今天 18:00 前')
    expect(noteRoot!.textContent).toContain('同步渠道：钉钉群#目录同步')
    expect(noteRoot!.textContent).toContain('补充说明：请先核对邮箱归属；处理完成后请在群里或工单中回填结果。')

    const copyNoteButton = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('复制处理备注'))
    expect(copyNoteButton).toBeDefined()
    copyNoteButton?.click()
    await flushAll()

    expect(globalThis.navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('处理负责人：值班管理员'),
    )
    expect(globalThis.navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('截止时间：今天 18:00 前'),
    )
    expect(globalThis.navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('同步渠道：钉钉群#目录同步'),
    )
    expect(globalThis.navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('补充说明：请先核对邮箱归属；处理完成后请在群里或工单中回填结果。'),
    )
    unmount()
  })

  it('switches note output formats and copies the active formatted output', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱不能为空，无法开户',
          },
        }, {
          status: 400,
          ok: false,
        })
      }
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const accountSelectionCheckboxes = Array.from(
      container.querySelectorAll('.directory-admin__selection-toggle--account input[type="checkbox"]'),
    ) as HTMLInputElement[]
    accountSelectionCheckboxes[2]?.click()
    accountSelectionCheckboxes[3]?.click()
    await flushAll()

    const batchProvisionButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('批量开通并授权'))
    expect(batchProvisionButton).toBeDefined()
    batchProvisionButton?.click()
    await flushAll()

    const reasonButton = Array.from(container.querySelectorAll('.directory-admin__batch-failure-group-button'))
      .find((button) => button.textContent?.includes('邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联')) as HTMLButtonElement | undefined
    expect(reasonButton).toBeDefined()
    reasonButton?.click()
    await flushAll()

    const noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot).toBeTruthy()

    const ticketButton = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('工单 Markdown')) as HTMLButtonElement | undefined
    expect(ticketButton).toBeDefined()
    const backToTicketButton = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-output .directory-admin__preset'))
      .find((button) => button.textContent?.includes('工单 Markdown')) as HTMLButtonElement | undefined
    backToTicketButton?.click()
    await flushAll()

    expect(noteRoot!.textContent).toContain('当前输出：工单 Markdown')
    expect(noteRoot!.textContent).toContain('# 目录失败处理')

    let copyNoteButton = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('复制处理备注')) as HTMLButtonElement | undefined
    expect(copyNoteButton).toBeDefined()
    copyNoteButton?.click()
    await flushAll()

    expect(globalThis.navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('# 目录失败处理'),
    )

    const imButton = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('IM 外发')) as HTMLButtonElement | undefined
    expect(imButton).toBeDefined()
    imButton?.click()
    await flushAll()

    expect(noteRoot!.textContent).toContain('当前输出：IM 外发')
    expect(noteRoot!.textContent).toContain('【目录失败跟进】')

    copyNoteButton = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('复制处理备注')) as HTMLButtonElement | undefined
    copyNoteButton?.click()
    await flushAll()

    expect(globalThis.navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('【目录失败跟进】'),
    )
    unmount()
  })

  it('applies handling group presets without changing the current output mode or template', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱不能为空，无法开户',
          },
        }, {
          status: 400,
          ok: false,
        })
      }
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const accountSelectionCheckboxes = Array.from(
      container.querySelectorAll('.directory-admin__selection-toggle--account input[type="checkbox"]'),
    ) as HTMLInputElement[]
    accountSelectionCheckboxes[2]?.click()
    accountSelectionCheckboxes[3]?.click()
    await flushAll()

    const batchProvisionButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('批量开通并授权'))
    expect(batchProvisionButton).toBeDefined()
    batchProvisionButton?.click()
    await flushAll()

    const reasonButton = Array.from(container.querySelectorAll('.directory-admin__batch-failure-group-button'))
      .find((button) => button.textContent?.includes('邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联')) as HTMLButtonElement | undefined
    expect(reasonButton).toBeDefined()
    reasonButton?.click()
    await flushAll()

    let noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot).toBeTruthy()

    const ticketButton = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-output .directory-admin__preset'))
      .find((button) => button.textContent?.includes('工单 Markdown')) as HTMLButtonElement | undefined
    expect(ticketButton).toBeDefined()
    ticketButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('当前输出：工单 Markdown')
    expect(noteRoot!.textContent).toContain('当前模板：管理员处理')

    const opsHandlingGroupButton = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-handling-groups .directory-admin__preset'))
      .find((button) => button.textContent?.includes('运营跟进')) as HTMLButtonElement | undefined
    expect(opsHandlingGroupButton).toBeDefined()
    opsHandlingGroupButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('当前输出：工单 Markdown')
    expect(noteRoot!.textContent).toContain('当前模板：管理员处理')
    expect(noteRoot!.textContent).toContain('当前处理组：运营跟进')
    expect(noteRoot!.textContent).toContain('处理负责人：运营/客服')
    expect(noteRoot!.textContent).toContain('截止时间：今天内')
    expect(noteRoot!.textContent).toContain('同步渠道：运营群 / 客服工单')
    expect(noteRoot!.textContent).toContain('处理完成后请通知用户重新尝试。')
    expect(noteRoot!.textContent).toContain('处理完成后请在群里或工单中回填结果。')

    const copyNoteButton = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('复制处理备注')) as HTMLButtonElement | undefined
    expect(copyNoteButton).toBeDefined()
    copyNoteButton?.click()
    await flushAll()

    expect(globalThis.navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('# 目录失败处理'),
    )
    expect(globalThis.navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('处理负责人：运营/客服'),
    )
    unmount()
  })

  it('keeps handling group presets isolated per failure reason', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱不能为空，无法开户',
          },
        }, {
          status: 400,
          ok: false,
        })
      }
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const accountSelectionCheckboxes = Array.from(
      container.querySelectorAll('.directory-admin__selection-toggle--account input[type="checkbox"]'),
    ) as HTMLInputElement[]
    accountSelectionCheckboxes[2]?.click()
    accountSelectionCheckboxes[3]?.click()
    await flushAll()

    const batchProvisionButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('批量开通并授权'))
    expect(batchProvisionButton).toBeDefined()
    batchProvisionButton?.click()
    await flushAll()

    const autoLinkReasonButton = Array.from(container.querySelectorAll('.directory-admin__batch-failure-group-button'))
      .find((button) => button.textContent?.includes('邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联')) as HTMLButtonElement | undefined
    const missingEmailReasonButton = Array.from(container.querySelectorAll('.directory-admin__batch-failure-group-button'))
      .find((button) => button.textContent?.includes('邮箱不能为空，无法开户')) as HTMLButtonElement | undefined
    expect(autoLinkReasonButton).toBeDefined()
    expect(missingEmailReasonButton).toBeDefined()

    autoLinkReasonButton?.click()
    await flushAll()

    let noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot).toBeTruthy()
    const ticketDutyButton = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-handling-groups .directory-admin__preset'))
      .find((button) => button.textContent?.includes('工单值班')) as HTMLButtonElement | undefined
    expect(ticketDutyButton).toBeDefined()
    ticketDutyButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('当前处理组：工单值班')
    expect(noteRoot!.textContent).toContain('处理负责人：工单值班')
    expect(noteRoot!.textContent).toContain('同步渠道：工单系统 / Jira')

    missingEmailReasonButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('当前处理组：推荐处理组')
    expect(noteRoot!.textContent).toContain('处理负责人：运营/客服')
    expect(noteRoot!.textContent).toContain('同步渠道：运营群 / 客服工单')

    autoLinkReasonButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('当前处理组：工单值班')
    expect(noteRoot!.textContent).toContain('处理负责人：工单值班')
    expect(noteRoot!.textContent).toContain('同步渠道：工单系统 / Jira')
    unmount()
  })

  it('keeps the active handling group fields when switching to a new output mode without saved preferences', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱不能为空，无法开户',
          },
        }, {
          status: 400,
          ok: false,
        })
      }
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const accountSelectionCheckboxes = Array.from(
      container.querySelectorAll('.directory-admin__selection-toggle--account input[type="checkbox"]'),
    ) as HTMLInputElement[]
    accountSelectionCheckboxes[2]?.click()
    accountSelectionCheckboxes[3]?.click()
    await flushAll()

    const batchProvisionButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('批量开通并授权'))
    batchProvisionButton?.click()
    await flushAll()

    const reasonButton = Array.from(container.querySelectorAll('.directory-admin__batch-failure-group-button'))
      .find((button) => button.textContent?.includes('邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联')) as HTMLButtonElement | undefined
    reasonButton?.click()
    await flushAll()

    let noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot).toBeTruthy()

    const ticketDutyButton = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-handling-groups .directory-admin__preset'))
      .find((button) => button.textContent?.includes('工单值班')) as HTMLButtonElement | undefined
    ticketDutyButton?.click()
    await flushAll()

    const imButton = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-output .directory-admin__preset'))
      .find((button) => button.textContent?.includes('IM 外发')) as HTMLButtonElement | undefined
    expect(imButton).toBeDefined()
    imButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('当前输出：IM 外发')
    expect(noteRoot!.textContent).toContain('当前处理组：工单值班')
    expect(noteRoot!.textContent).toContain('处理负责人：工单值班')
    expect(noteRoot!.textContent).toContain('同步渠道：工单系统 / Jira')
    unmount()
  })

  it('saves, applies, and copies a team standard template for the active output mode', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱不能为空，无法开户',
          },
        }, {
          status: 400,
          ok: false,
        })
      }
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const accountSelectionCheckboxes = Array.from(
      container.querySelectorAll('.directory-admin__selection-toggle--account input[type="checkbox"]'),
    ) as HTMLInputElement[]
    accountSelectionCheckboxes[2]?.click()
    accountSelectionCheckboxes[3]?.click()
    await flushAll()

    const batchProvisionButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('批量开通并授权'))
    batchProvisionButton?.click()
    await flushAll()

    const reasonButton = Array.from(container.querySelectorAll('.directory-admin__batch-failure-group-button'))
      .find((button) => button.textContent?.includes('邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联')) as HTMLButtonElement | undefined
    reasonButton?.click()
    await flushAll()

    let noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot).toBeTruthy()

    const ticketButton = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-output .directory-admin__preset'))
      .find((button) => button.textContent?.includes('工单 Markdown')) as HTMLButtonElement | undefined
    expect(ticketButton).toBeDefined()
    ticketButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    const opsPresetButton = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-presets .directory-admin__preset'))
      .find((button) => button.textContent?.includes('运营跟进')) as HTMLButtonElement | undefined
    const opsHandlingGroupButton = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-handling-groups .directory-admin__preset'))
      .find((button) => button.textContent?.includes('运营跟进')) as HTMLButtonElement | undefined
    expect(opsPresetButton).toBeDefined()
    expect(opsHandlingGroupButton).toBeDefined()
    opsPresetButton?.click()
    opsHandlingGroupButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    const noteInputs = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-fields input')) as HTMLInputElement[]
    noteInputs[0]!.value = '运营值班经理'
    noteInputs[0]!.dispatchEvent(new Event('input', { bubbles: true }))
    noteInputs[1]!.value = '今天 21:00 前'
    noteInputs[1]!.dispatchEvent(new Event('input', { bubbles: true }))
    noteInputs[2]!.value = 'Jira #4321'
    noteInputs[2]!.dispatchEvent(new Event('input', { bubbles: true }))
    const extraTextarea = noteRoot!.querySelector('textarea') as HTMLTextAreaElement | null
    expect(extraTextarea).toBeTruthy()
    extraTextarea!.value = '处理后请回填交接单。'
    extraTextarea!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushAll()

    const saveTeamTemplateButton = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('保存为团队标准')) as HTMLButtonElement | undefined
    expect(saveTeamTemplateButton).toBeDefined()
    saveTeamTemplateButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('团队标准模板：处理组 运营跟进 · 模板 运营跟进 · 负责人 运营值班经理 · 截止 今天 21:00 前 · 渠道 Jira #4321')

    const imButton = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-output .directory-admin__preset'))
      .find((button) => button.textContent?.includes('IM 外发')) as HTMLButtonElement | undefined
    expect(imButton).toBeDefined()
    imButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('当前输出还没有团队标准模板；保存后可作为稳定快照反复应用')

    ticketButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    const adminPresetButton = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-presets .directory-admin__preset'))
      .find((button) => button.textContent?.includes('管理员处理')) as HTMLButtonElement | undefined
    adminPresetButton?.click()
    await flushAll()

    const mutatedInputs = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-fields input')) as HTMLInputElement[]
    mutatedInputs[0]!.value = '临时处理人'
    mutatedInputs[0]!.dispatchEvent(new Event('input', { bubbles: true }))
    mutatedInputs[2]!.value = '钉钉群#临时处理'
    mutatedInputs[2]!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushAll()

    const applyTeamTemplateButton = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('应用团队标准')) as HTMLButtonElement | undefined
    expect(applyTeamTemplateButton).toBeDefined()
    applyTeamTemplateButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('当前输出：工单 Markdown')
    expect(noteRoot!.textContent).toContain('当前模板：运营跟进')
    expect(noteRoot!.textContent).toContain('当前处理组：运营跟进')
    expect(noteRoot!.textContent).toContain('处理负责人：运营值班经理')
    expect(noteRoot!.textContent).toContain('同步渠道：Jira #4321')
    expect(noteRoot!.textContent).toContain('补充说明：处理后请回填交接单。')

    const copyTeamTemplateButton = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('复制团队模板')) as HTMLButtonElement | undefined
    expect(copyTeamTemplateButton).toBeDefined()
    copyTeamTemplateButton?.click()
    await flushAll()

    expect(globalThis.navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('团队标准模板：'),
    )
    expect(globalThis.navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('输出格式：工单 Markdown'),
    )
    expect(globalThis.navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('处理负责人：运营值班经理'),
    )
    unmount()
  })

  it('auto-applies the team standard template when no personal preference exists', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱不能为空，无法开户',
          },
        }, {
          status: 400,
          ok: false,
        })
      }
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    let mounted = mountDirectoryManagement()
    await flushAll()

    let accountSelectionCheckboxes = Array.from(
      mounted.container.querySelectorAll('.directory-admin__selection-toggle--account input[type="checkbox"]'),
    ) as HTMLInputElement[]
    accountSelectionCheckboxes[2]?.click()
    accountSelectionCheckboxes[3]?.click()
    await flushAll()

    let batchProvisionButton = Array.from(mounted.container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('批量开通并授权'))
    batchProvisionButton?.click()
    await flushAll()

    let reasonButton = Array.from(mounted.container.querySelectorAll('.directory-admin__batch-failure-group-button'))
      .find((button) => button.textContent?.includes('邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联')) as HTMLButtonElement | undefined
    reasonButton?.click()
    await flushAll()

    let noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot).toBeTruthy()

    const opsPresetButton = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-presets .directory-admin__preset'))
      .find((button) => button.textContent?.includes('运营跟进')) as HTMLButtonElement | undefined
    const opsHandlingGroupButton = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-handling-groups .directory-admin__preset'))
      .find((button) => button.textContent?.includes('运营跟进')) as HTMLButtonElement | undefined
    opsPresetButton?.click()
    opsHandlingGroupButton?.click()
    await flushAll()

    const noteInputs = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-fields input')) as HTMLInputElement[]
    noteInputs[0]!.value = '团队标准负责人'
    noteInputs[0]!.dispatchEvent(new Event('input', { bubbles: true }))
    noteInputs[2]!.value = '标准群#目录同步'
    noteInputs[2]!.dispatchEvent(new Event('input', { bubbles: true }))
    const saveTeamTemplateButton = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('保存为团队标准')) as HTMLButtonElement | undefined
    saveTeamTemplateButton?.click()
    await flushAll()

    mounted.unmount()
    localStorage.removeItem(BATCH_FAILURE_REASON_NOTE_PREFERENCES_STORAGE_KEY)

    mounted = mountDirectoryManagement()
    await flushAll()

    accountSelectionCheckboxes = Array.from(
      mounted.container.querySelectorAll('.directory-admin__selection-toggle--account input[type="checkbox"]'),
    ) as HTMLInputElement[]
    accountSelectionCheckboxes[2]?.click()
    accountSelectionCheckboxes[3]?.click()
    await flushAll()

    batchProvisionButton = Array.from(mounted.container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('批量开通并授权'))
    batchProvisionButton?.click()
    await flushAll()

    reasonButton = Array.from(mounted.container.querySelectorAll('.directory-admin__batch-failure-group-button'))
      .find((button) => button.textContent?.includes('邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联')) as HTMLButtonElement | undefined
    reasonButton?.click()
    await flushAll()

    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('团队标准模板：处理组 运营跟进 · 模板 运营跟进 · 负责人 团队标准负责人')
    expect(noteRoot!.textContent).toContain('当前模板：运营跟进')
    expect(noteRoot!.textContent).toContain('当前处理组：运营跟进')
    expect(noteRoot!.textContent).toContain('处理负责人：团队标准负责人')
    expect(noteRoot!.textContent).toContain('同步渠道：标准群#目录同步')
    mounted.unmount()
  })

  it('keeps personal remembered preferences ahead of the team standard until the team standard is applied explicitly', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱不能为空，无法开户',
          },
        }, {
          status: 400,
          ok: false,
        })
      }
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    let mounted = mountDirectoryManagement()
    await flushAll()

    let accountSelectionCheckboxes = Array.from(
      mounted.container.querySelectorAll('.directory-admin__selection-toggle--account input[type="checkbox"]'),
    ) as HTMLInputElement[]
    accountSelectionCheckboxes[2]?.click()
    accountSelectionCheckboxes[3]?.click()
    await flushAll()

    let batchProvisionButton = Array.from(mounted.container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('批量开通并授权'))
    batchProvisionButton?.click()
    await flushAll()

    let reasonButton = Array.from(mounted.container.querySelectorAll('.directory-admin__batch-failure-group-button'))
      .find((button) => button.textContent?.includes('邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联')) as HTMLButtonElement | undefined
    reasonButton?.click()
    await flushAll()

    let noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot).toBeTruthy()

    const ticketButton = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-output .directory-admin__preset'))
      .find((button) => button.textContent?.includes('工单 Markdown')) as HTMLButtonElement | undefined
    ticketButton?.click()
    await flushAll()

    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    const noteInputs = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-fields input')) as HTMLInputElement[]
    noteInputs[0]!.value = '团队负责人'
    noteInputs[0]!.dispatchEvent(new Event('input', { bubbles: true }))
    noteInputs[2]!.value = 'Jira #100'
    noteInputs[2]!.dispatchEvent(new Event('input', { bubbles: true }))
    const saveTeamTemplateButton = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('保存为团队标准')) as HTMLButtonElement | undefined
    saveTeamTemplateButton?.click()
    await flushAll()

    noteInputs[0]!.value = '个人偏好负责人'
    noteInputs[0]!.dispatchEvent(new Event('input', { bubbles: true }))
    noteInputs[2]!.value = 'Jira #999'
    noteInputs[2]!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushAll()

    mounted.unmount()

    mounted = mountDirectoryManagement()
    await flushAll()

    accountSelectionCheckboxes = Array.from(
      mounted.container.querySelectorAll('.directory-admin__selection-toggle--account input[type="checkbox"]'),
    ) as HTMLInputElement[]
    accountSelectionCheckboxes[2]?.click()
    accountSelectionCheckboxes[3]?.click()
    await flushAll()

    batchProvisionButton = Array.from(mounted.container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('批量开通并授权'))
    batchProvisionButton?.click()
    await flushAll()

    reasonButton = Array.from(mounted.container.querySelectorAll('.directory-admin__batch-failure-group-button'))
      .find((button) => button.textContent?.includes('邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联')) as HTMLButtonElement | undefined
    reasonButton?.click()
    await flushAll()

    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    const currentTicketButton = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-output .directory-admin__preset'))
      .find((button) => button.textContent?.includes('工单 Markdown')) as HTMLButtonElement | undefined
    currentTicketButton?.click()
    await flushAll()

    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('团队标准模板：处理组 推荐处理组 · 模板 管理员处理 · 负责人 团队负责人')
    expect(noteRoot!.textContent).toContain('已记住上次偏好：模板 管理员处理 · 负责人 个人偏好负责人')
    expect(noteRoot!.textContent).toContain('处理负责人：个人偏好负责人')
    expect(noteRoot!.textContent).toContain('同步渠道：Jira #999')

    const applyTeamTemplateButton = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('应用团队标准')) as HTMLButtonElement | undefined
    applyTeamTemplateButton?.click()
    await flushAll()

    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('处理负责人：团队负责人')
    expect(noteRoot!.textContent).toContain('同步渠道：Jira #100')
    mounted.unmount()
  })

  it('copies a versioned team template code and imports it into the matching output mode with preview', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱不能为空，无法开户',
          },
        }, {
          status: 400,
          ok: false,
        })
      }
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    let mounted = mountDirectoryManagement()
    await flushAll()

    let accountSelectionCheckboxes = Array.from(
      mounted.container.querySelectorAll('.directory-admin__selection-toggle--account input[type="checkbox"]'),
    ) as HTMLInputElement[]
    accountSelectionCheckboxes[2]?.click()
    accountSelectionCheckboxes[3]?.click()
    await flushAll()

    let batchProvisionButton = Array.from(mounted.container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('批量开通并授权'))
    batchProvisionButton?.click()
    await flushAll()

    let reasonButton = Array.from(mounted.container.querySelectorAll('.directory-admin__batch-failure-group-button'))
      .find((button) => button.textContent?.includes('邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联')) as HTMLButtonElement | undefined
    reasonButton?.click()
    await flushAll()

    let noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot).toBeTruthy()

    const ticketButton = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-output .directory-admin__preset'))
      .find((button) => button.textContent?.includes('工单 Markdown')) as HTMLButtonElement | undefined
    ticketButton?.click()
    await flushAll()

    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    const opsPresetButton = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-presets .directory-admin__preset'))
      .find((button) => button.textContent?.includes('运营跟进')) as HTMLButtonElement | undefined
    const opsHandlingGroupButton = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-handling-groups .directory-admin__preset'))
      .find((button) => button.textContent?.includes('运营跟进')) as HTMLButtonElement | undefined
    opsPresetButton?.click()
    opsHandlingGroupButton?.click()
    await flushAll()

    const noteInputs = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-fields input')) as HTMLInputElement[]
    noteInputs[0]!.value = '模板码负责人'
    noteInputs[0]!.dispatchEvent(new Event('input', { bubbles: true }))
    noteInputs[2]!.value = 'Jira #CODE'
    noteInputs[2]!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushAll()

    const saveTeamTemplateButton = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('保存为团队标准')) as HTMLButtonElement | undefined
    saveTeamTemplateButton?.click()
    await flushAll()

    const copyTeamTemplateCodeButton = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('复制模板码')) as HTMLButtonElement | undefined
    expect(copyTeamTemplateCodeButton).toBeDefined()
    copyTeamTemplateCodeButton?.click()
    await flushAll()

    const lastCopiedValue = vi.mocked(globalThis.navigator.clipboard.writeText).mock.calls.at(-1)?.[0]
    expect(lastCopiedValue).toEqual(expect.stringContaining(BATCH_FAILURE_REASON_TEAM_TEMPLATE_CODE_PREFIX))

    mounted.unmount()
    localStorage.removeItem(BATCH_FAILURE_REASON_NOTE_PREFERENCES_STORAGE_KEY)
    localStorage.removeItem(BATCH_FAILURE_REASON_TEAM_TEMPLATES_STORAGE_KEY)

    mounted = mountDirectoryManagement()
    await flushAll()

    accountSelectionCheckboxes = Array.from(
      mounted.container.querySelectorAll('.directory-admin__selection-toggle--account input[type="checkbox"]'),
    ) as HTMLInputElement[]
    accountSelectionCheckboxes[2]?.click()
    accountSelectionCheckboxes[3]?.click()
    await flushAll()

    batchProvisionButton = Array.from(mounted.container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('批量开通并授权'))
    batchProvisionButton?.click()
    await flushAll()

    reasonButton = Array.from(mounted.container.querySelectorAll('.directory-admin__batch-failure-group-button'))
      .find((button) => button.textContent?.includes('邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联')) as HTMLButtonElement | undefined
    reasonButton?.click()
    await flushAll()

    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    const currentTicketButton = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-output .directory-admin__preset'))
      .find((button) => button.textContent?.includes('工单 Markdown')) as HTMLButtonElement | undefined
    currentTicketButton?.click()
    await flushAll()

    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    const importToggleButton = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('导入模板码')) as HTMLButtonElement | undefined
    expect(importToggleButton).toBeDefined()
    importToggleButton?.click()
    await flushAll()

    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    const importTextarea = noteRoot!.querySelector('.directory-admin__batch-note-import textarea') as HTMLTextAreaElement | null
    expect(importTextarea).toBeTruthy()
    importTextarea!.value = String(lastCopiedValue)
    importTextarea!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushAll()

    expect(noteRoot!.textContent).toContain('将导入到 工单 Markdown / 运营跟进 / 运营跟进')

    const importConfirmButton = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('确认导入')) as HTMLButtonElement | undefined
    expect(importConfirmButton).toBeDefined()
    importConfirmButton?.click()
    await flushAll()

    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('团队标准模板：处理组 运营跟进 · 模板 运营跟进 · 负责人 模板码负责人')
    expect(noteRoot!.textContent).toContain('处理负责人：模板码负责人')
    expect(mounted.container.textContent).toContain('模板码已导入，并已应用到输出“工单 Markdown”')
    mounted.unmount()
  })

  it('imports template code into the encoded output slot without overwriting the current output', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱不能为空，无法开户',
          },
        }, {
          status: 400,
          ok: false,
        })
      }
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    localStorage.setItem(
      BATCH_FAILURE_REASON_TEAM_TEMPLATES_STORAGE_KEY,
      JSON.stringify({
        ticket: {
          preset: 'ops',
          handlingGroupKey: 'ops-handoff',
          owner: '导入负责人',
          deadline: '明天 09:00 前',
          channel: 'Jira #Imported',
          extra: '请按模板码导入后继续处理。',
          snippetKeys: ['notify-retry'],
          savedAt: '2026/3/27 12:00:00',
        },
      }),
    )

    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const accountSelectionCheckboxes = Array.from(
      container.querySelectorAll('.directory-admin__selection-toggle--account input[type="checkbox"]'),
    ) as HTMLInputElement[]
    accountSelectionCheckboxes[2]?.click()
    accountSelectionCheckboxes[3]?.click()
    await flushAll()

    const batchProvisionButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('批量开通并授权'))
    batchProvisionButton?.click()
    await flushAll()

    const reasonButton = Array.from(container.querySelectorAll('.directory-admin__batch-failure-group-button'))
      .find((button) => button.textContent?.includes('邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联')) as HTMLButtonElement | undefined
    reasonButton?.click()
    await flushAll()

    let noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('当前输出：备注原文')
    expect(noteRoot!.textContent).not.toContain('团队标准模板：处理组 运营跟进')

    const importToggleButton = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('导入模板码')) as HTMLButtonElement | undefined
    importToggleButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    const payload = {
      version: 1,
      outputMode: 'ticket',
      template: {
        preset: 'ops',
        handlingGroupKey: 'ops-handoff',
        owner: '导入负责人',
        deadline: '明天 09:00 前',
        channel: 'Jira #Imported',
        extra: '请按模板码导入后继续处理。',
        snippetKeys: ['notify-retry'],
        savedAt: '2026/3/27 12:00:00',
      },
    }
    const code = encodeTeamTemplateCode(payload)
    const importTextarea = noteRoot!.querySelector('.directory-admin__batch-note-import textarea') as HTMLTextAreaElement | null
    importTextarea!.value = code
    importTextarea!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushAll()

    expect(noteRoot!.textContent).toContain('将导入到 工单 Markdown / 运营跟进 / 运营跟进')

    const importConfirmButton = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('确认导入')) as HTMLButtonElement | undefined
    importConfirmButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(container.textContent).toContain('模板码已导入到输出“工单 Markdown”')
    expect(noteRoot!.textContent).toContain('当前输出：备注原文')
    expect(noteRoot!.textContent).not.toContain('团队标准模板：处理组 运营跟进 · 模板 运营跟进 · 负责人 导入负责人')

    const ticketButton = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-output .directory-admin__preset'))
      .find((button) => button.textContent?.includes('工单 Markdown')) as HTMLButtonElement | undefined
    ticketButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('团队标准模板：处理组 运营跟进 · 模板 运营跟进 · 负责人 导入负责人')
    expect(noteRoot!.textContent).toContain('处理负责人：导入负责人')
    unmount()
  })

  it('rejects invalid team template code with a clear error', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱不能为空，无法开户',
          },
        }, {
          status: 400,
          ok: false,
        })
      }
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const accountSelectionCheckboxes = Array.from(
      container.querySelectorAll('.directory-admin__selection-toggle--account input[type="checkbox"]'),
    ) as HTMLInputElement[]
    accountSelectionCheckboxes[2]?.click()
    accountSelectionCheckboxes[3]?.click()
    await flushAll()

    const batchProvisionButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('批量开通并授权'))
    batchProvisionButton?.click()
    await flushAll()

    const reasonButton = Array.from(container.querySelectorAll('.directory-admin__batch-failure-group-button'))
      .find((button) => button.textContent?.includes('邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联')) as HTMLButtonElement | undefined
    reasonButton?.click()
    await flushAll()

    const noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot).toBeTruthy()
    const importToggleButton = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('导入模板码')) as HTMLButtonElement | undefined
    importToggleButton?.click()
    await flushAll()

    const reopenedNoteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    const importTextarea = reopenedNoteRoot!.querySelector('.directory-admin__batch-note-import textarea') as HTMLTextAreaElement | null
    importTextarea!.value = 'not-a-valid-template-code'
    importTextarea!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushAll()

    const importConfirmButton = Array.from(reopenedNoteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('确认导入')) as HTMLButtonElement | undefined
    importConfirmButton?.click()
    await flushAll()

    expect(container.textContent).toContain('模板码无效，请粘贴通过“复制模板码”生成的内容或合法 JSON。')
    unmount()
  })

  it('records recent team template imports and rolls back to the previous template for the current output', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱不能为空，无法开户',
          },
        }, {
          status: 400,
          ok: false,
        })
      }
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    localStorage.setItem(
      BATCH_FAILURE_REASON_TEAM_TEMPLATES_STORAGE_KEY,
      JSON.stringify({
        ticket: {
          preset: 'ops',
          handlingGroupKey: 'ops-handoff',
          owner: '旧负责人',
          deadline: '今天 18:00 前',
          channel: 'Jira #OLD',
          extra: '旧模板说明',
          snippetKeys: ['notify-retry'],
          savedAt: '2026/3/27 12:20:00',
        },
      }),
    )

    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const accountSelectionCheckboxes = Array.from(
      container.querySelectorAll('.directory-admin__selection-toggle--account input[type="checkbox"]'),
    ) as HTMLInputElement[]
    accountSelectionCheckboxes[2]?.click()
    accountSelectionCheckboxes[3]?.click()
    await flushAll()

    const batchProvisionButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('批量开通并授权'))
    batchProvisionButton?.click()
    await flushAll()

    const reasonButton = Array.from(container.querySelectorAll('.directory-admin__batch-failure-group-button'))
      .find((button) => button.textContent?.includes('邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联')) as HTMLButtonElement | undefined
    reasonButton?.click()
    await flushAll()

    let noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    const ticketButton = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-output .directory-admin__preset'))
      .find((button) => button.textContent?.includes('工单 Markdown')) as HTMLButtonElement | undefined
    ticketButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('团队标准模板：处理组 运营跟进 · 模板 运营跟进 · 负责人 旧负责人')
    expect(noteRoot!.textContent).toContain('处理负责人：旧负责人')

    const importToggleButton = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('导入模板码')) as HTMLButtonElement | undefined
    importToggleButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    const importTextarea = noteRoot!.querySelector('.directory-admin__batch-note-import textarea') as HTMLTextAreaElement | null
    importTextarea!.value = encodeTeamTemplateCode({
      version: 1,
      outputMode: 'ticket',
      template: {
        preset: 'ops',
        handlingGroupKey: 'ops-handoff',
        owner: '新负责人',
        deadline: '明天 09:00 前',
        channel: 'Jira #NEW',
        extra: '新模板说明',
        snippetKeys: ['notify-retry', 'fill-result'],
        savedAt: '2026/3/27 12:30:00',
      },
    })
    importTextarea!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushAll()

    const importConfirmButton = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('确认导入')) as HTMLButtonElement | undefined
    expect(noteRoot!.textContent).toContain('导入差异：变更字段')
    expect(noteRoot!.textContent).toContain('处理负责人')
    expect(noteRoot!.textContent).toContain('旧负责人')
    expect(noteRoot!.textContent).toContain('新负责人')
    expect(noteRoot!.textContent).toContain('同步渠道')
    expect(noteRoot!.textContent).toContain('Jira #OLD')
    expect(noteRoot!.textContent).toContain('Jira #NEW')

    const channelDiffItem = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-diff-item'))
      .find((item) => item.textContent?.includes('同步渠道')) as HTMLElement | undefined
    const ignoreChannelButton = Array.from(channelDiffItem?.querySelectorAll('button') || [])
      .find((button) => button.textContent?.includes('忽略该字段')) as HTMLButtonElement | undefined
    expect(ignoreChannelButton).toBeDefined()
    ignoreChannelButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('当前忽略：同步渠道')
    expect(noteRoot!.textContent).toContain('导入差异：变更字段')
    expect(noteRoot!.textContent).toContain('已忽略 1 项')
    importConfirmButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('最近模板码导入')
    expect(noteRoot!.textContent).toContain('来源：模板码')
    expect(noteRoot!.textContent).toContain('差异：变更字段')
    expect(noteRoot!.textContent).toContain('已忽略：同步渠道')
    expect(noteRoot!.textContent).toContain('团队标准模板：处理组 运营跟进 · 模板 运营跟进 · 负责人 新负责人')
    expect(noteRoot!.textContent).toContain('处理负责人：新负责人')
    expect(noteRoot!.textContent).toContain('同步渠道：Jira #OLD')
    expect(noteRoot!.textContent).not.toContain('同步渠道：Jira #NEW')
    expect(noteRoot!.textContent).toContain('导入前：处理组 运营跟进 · 模板 运营跟进 · 负责人 旧负责人')

    const rollbackButton = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('回滚到导入前模板')) as HTMLButtonElement | undefined
    expect(rollbackButton).toBeDefined()
    rollbackButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(container.textContent).toContain('已回滚输出“工单 Markdown”的模板导入')
    expect(noteRoot!.textContent).toContain('团队标准模板：处理组 运营跟进 · 模板 运营跟进 · 负责人 旧负责人')
    expect(noteRoot!.textContent).toContain('处理负责人：旧负责人')
    expect(noteRoot!.textContent).toContain('已回滚')
    unmount()
  })

  it('saves, switches, and overwrites multiple named import presets', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱不能为空，无法开户',
          },
        }, {
          status: 400,
          ok: false,
        })
      }
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    localStorage.setItem(
      BATCH_FAILURE_REASON_TEAM_TEMPLATES_STORAGE_KEY,
      JSON.stringify({
        ticket: {
          preset: 'ops',
          handlingGroupKey: 'ops-handoff',
          owner: '旧负责人',
          deadline: '今天 18:00 前',
          channel: 'Jira #OLD',
          extra: '旧模板说明',
          snippetKeys: ['notify-retry'],
          savedAt: '2026/3/27 12:20:00',
        },
      }),
    )

    let mounted = mountDirectoryManagement()
    await flushAll()

    let noteRoot = await openTicketTemplateImportFromBatchFailure(mounted.container)
    noteRoot = await pasteTeamTemplateImportCode(noteRoot, {
      version: 1,
      outputMode: 'ticket',
      template: {
        preset: 'ops',
        handlingGroupKey: 'ops-handoff',
        owner: '新负责人',
        deadline: '明天 09:00 前',
        channel: 'Jira #NEW',
        extra: '新模板说明',
        snippetKeys: ['notify-retry', 'fill-result'],
        savedAt: '2026/3/27 12:30:00',
      },
    })
    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement

    const ownerDiffItem = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-diff-item'))
      .find((item) => item.textContent?.includes('处理负责人')) as HTMLElement | undefined
    const channelDiffItem = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-diff-item'))
      .find((item) => item.textContent?.includes('同步渠道')) as HTMLElement | undefined
    const ownerIgnoreButton = Array.from(ownerDiffItem?.querySelectorAll('button') || [])
      .find((button) => button.textContent?.includes('忽略该字段')) as HTMLButtonElement | undefined
    const channelIgnoreButton = Array.from(channelDiffItem?.querySelectorAll('button') || [])
      .find((button) => button.textContent?.includes('忽略该字段')) as HTMLButtonElement | undefined
    ownerIgnoreButton?.click()
    channelIgnoreButton?.click()
    await flushAll()

    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement
    const presetInputs = findImportPresetTextInputs(noteRoot)
    const presetNameInput = presetInputs[0] || null
    const presetTagsInput = presetInputs[1] || null
    expect(presetNameInput).toBeTruthy()
    expect(presetTagsInput).toBeTruthy()
    presetNameInput!.value = '保留负责人和渠道'
    presetNameInput!.dispatchEvent(new Event('input', { bubbles: true }))
    presetTagsInput!.value = '工单、渠道'
    presetTagsInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushAll()

    let savePresetButton = findButtonByText(noteRoot, '保存为新预设')
    expect(savePresetButton).toBeDefined()
    savePresetButton?.click()
    await flushAll()

    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('当前选中预设（工单 Markdown）：')
    expect(noteRoot!.textContent).toContain('保留负责人和渠道')
    expect(noteRoot!.textContent).toContain('处理负责人 / 同步渠道')
    expect(noteRoot!.textContent).toContain('当前选中标签：工单 / 渠道')

    const refreshedOwnerDiffItem = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-diff-item'))
      .find((item) => item.textContent?.includes('处理负责人')) as HTMLElement | undefined
    const ownerRestoreButton = Array.from(refreshedOwnerDiffItem?.querySelectorAll('button') || [])
      .find((button) => button.textContent?.includes('恢复导入')) as HTMLButtonElement | undefined
    ownerRestoreButton?.click()
    await flushAll()

    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('当前忽略：同步渠道')
    presetNameInput!.value = '仅保留渠道'
    presetNameInput!.dispatchEvent(new Event('input', { bubbles: true }))
    presetTagsInput!.value = '财务'
    presetTagsInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushAll()

    savePresetButton = findButtonByText(noteRoot!, '保存为新预设')
    savePresetButton?.click()
    await flushAll()

    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('当前选中预设（工单 Markdown）：')
    expect(noteRoot!.textContent).toContain('仅保留渠道')
    expect(noteRoot!.textContent).toContain('同步渠道')
    expect(noteRoot!.textContent).toContain('当前选中标签：财务')
    expect(noteRoot!.textContent).toContain('保留负责人和渠道')
    expect(noteRoot!.textContent).toContain('仅保留渠道')
    mounted.unmount()

    mounted = mountDirectoryManagement()
    await flushAll()

    noteRoot = await openTicketTemplateImportFromBatchFailure(mounted.container)
    noteRoot = await pasteTeamTemplateImportCode(noteRoot, {
      version: 1,
      outputMode: 'ticket',
      template: {
        preset: 'ops',
        handlingGroupKey: 'ops-handoff',
        owner: '再次导入负责人',
        deadline: '后天 10:00 前',
        channel: 'Jira #NEXT',
        extra: '再次导入模板说明',
        snippetKeys: ['notify-retry', 'fill-result'],
        savedAt: '2026/3/27 12:40:00',
      },
    })
    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement

    findButtonByText(noteRoot, '保留负责人和渠道')?.click()
    await flushAll()

    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('当前忽略：处理负责人 / 同步渠道')
    expect(noteRoot!.textContent).toContain('当前选中预设（工单 Markdown）：')
    expect(noteRoot!.textContent).toContain('保留负责人和渠道')
    expect(noteRoot!.textContent).toContain('处理负责人 / 同步渠道')

    findButtonByText(noteRoot!, '仅保留渠道')?.click()
    await flushAll()

    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('当前忽略：同步渠道')
    expect(noteRoot!.textContent).not.toContain('当前忽略：处理负责人 / 同步渠道')

    const secondPresetInputs = findImportPresetTextInputs(noteRoot!)
    const secondPresetNameInput = secondPresetInputs[0] || null
    const secondPresetTagsInput = secondPresetInputs[1] || null
    expect(secondPresetNameInput).toBeTruthy()
    expect(secondPresetTagsInput).toBeTruthy()
    secondPresetNameInput!.value = '仅保留渠道新版'
    secondPresetNameInput!.dispatchEvent(new Event('input', { bubbles: true }))
    secondPresetTagsInput!.value = '财务、新版'
    secondPresetTagsInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushAll()

    findButtonByText(noteRoot!, '覆盖当前预设')?.click()
    await flushAll()

    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('当前选中预设（工单 Markdown）：')
    expect(noteRoot!.textContent).toContain('仅保留渠道新版')
    expect(noteRoot!.textContent).toContain('同步渠道')
    expect(noteRoot!.textContent).toContain('当前选中标签：财务 / 新版')
    expect(noteRoot!.textContent).toContain('保留负责人和渠道')
    expect(noteRoot!.textContent).toContain('仅保留渠道新版')

    const importConfirmButton = findButtonByText(noteRoot!, '确认导入')
    importConfirmButton?.click()
    await flushAll()

    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('处理负责人：再次导入负责人')
    expect(noteRoot!.textContent).toContain('同步渠道：Jira #OLD')
    expect(noteRoot!.textContent).toContain('截止时间：后天 10:00 前')
    const storedPresets = JSON.parse(localStorage.getItem(BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_PRESETS_STORAGE_KEY) || '{}') as Record<string, Array<{ name: string, tags?: string[] }>>
    expect(Array.isArray(storedPresets.ticket)).toBe(true)
    expect(storedPresets.ticket?.map((item) => item.name).sort()).toEqual(['保留负责人和渠道', '仅保留渠道新版'].sort())
    expect(storedPresets.ticket?.find((item) => item.name === '保留负责人和渠道')?.tags).toEqual(['工单', '渠道'])
    expect(storedPresets.ticket?.find((item) => item.name === '仅保留渠道新版')?.tags).toEqual(['财务', '新版'])
    mounted.unmount()
  })

  it('removes the currently selected saved import preset', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱不能为空，无法开户',
          },
        }, {
          status: 400,
          ok: false,
        })
      }
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    localStorage.setItem(
      BATCH_FAILURE_REASON_TEAM_TEMPLATES_STORAGE_KEY,
      JSON.stringify({
        ticket: {
          preset: 'ops',
          handlingGroupKey: 'ops-handoff',
          owner: '旧负责人',
          deadline: '今天 18:00 前',
          channel: 'Jira #OLD',
          extra: '旧模板说明',
          snippetKeys: ['notify-retry'],
          savedAt: '2026/3/27 12:20:00',
        },
      }),
    )
    localStorage.setItem(
      BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_PRESETS_STORAGE_KEY,
      JSON.stringify({
        ticket: [
          {
            id: 'ticket-import-preset-1',
            name: '保留负责人和渠道',
            tags: ['工单', '渠道'],
            ignoredFieldKeys: ['owner', 'channel'],
            savedAt: '2026/3/27 12:30:00',
            updatedAt: '2026/3/27 12:30:00',
          },
          {
            id: 'ticket-import-preset-2',
            name: '仅保留渠道',
            tags: ['财务'],
            ignoredFieldKeys: ['channel'],
            savedAt: '2026/3/27 12:31:00',
            updatedAt: '2026/3/27 12:31:00',
          },
        ],
      }),
    )

    const mounted = mountDirectoryManagement()
    await flushAll()

    let noteRoot = await openTicketTemplateImportFromBatchFailure(mounted.container)
    noteRoot = await pasteTeamTemplateImportCode(noteRoot, {
      version: 1,
      outputMode: 'ticket',
      template: {
        preset: 'ops',
        handlingGroupKey: 'ops-handoff',
        owner: '再次导入负责人',
        deadline: '后天 10:00 前',
        channel: 'Jira #NEXT',
        extra: '再次导入模板说明',
        snippetKeys: ['notify-retry', 'fill-result'],
        savedAt: '2026/3/27 12:40:00',
      },
    })
    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement

    findButtonByText(noteRoot, '仅保留渠道')?.click()
    await flushAll()

    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('当前选中预设（工单 Markdown）：')
    expect(noteRoot!.textContent).toContain('仅保留渠道')
    expect(noteRoot!.textContent).toContain('同步渠道')

    findButtonByText(noteRoot!, '删除当前预设')?.click()
    await flushAll()

    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('当前选中预设（工单 Markdown）：')
    expect(noteRoot!.textContent).toContain('保留负责人和渠道')
    expect(noteRoot!.textContent).toContain('处理负责人 / 同步渠道')
    const savedPresetButtons = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-import-presets .directory-admin__batch-note-import-preset-group .directory-admin__preset'))
      .map((button) => button.textContent?.trim())
      .filter((text): text is string => Boolean(text))
    expect(savedPresetButtons.some((text) => text.includes('保留负责人和渠道'))).toBe(true)
    expect(savedPresetButtons.some((text) => text.includes('仅保留渠道'))).toBe(false)

    const storedPresets = JSON.parse(localStorage.getItem(BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_PRESETS_STORAGE_KEY) || '{}') as Record<string, Array<{ name: string }>>
    expect(storedPresets.ticket?.map((item) => item.name)).toEqual(['保留负责人和渠道'])
    mounted.unmount()
  })

  it('filters saved import presets by search and tag groups', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱不能为空，无法开户',
          },
        }, {
          status: 400,
          ok: false,
        })
      }
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    localStorage.setItem(
      BATCH_FAILURE_REASON_TEAM_TEMPLATES_STORAGE_KEY,
      JSON.stringify({
        ticket: {
          preset: 'ops',
          handlingGroupKey: 'ops-handoff',
          owner: '旧负责人',
          deadline: '今天 18:00 前',
          channel: 'Jira #OLD',
          extra: '旧模板说明',
          snippetKeys: ['notify-retry'],
          savedAt: '2026/3/27 12:20:00',
        },
      }),
    )
    localStorage.setItem(
      BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_PRESETS_STORAGE_KEY,
      JSON.stringify({
        ticket: [
          {
            id: 'ticket-import-preset-1',
            name: '保留负责人和渠道',
            tags: ['工单', '渠道'],
            ignoredFieldKeys: ['owner', 'channel'],
            savedAt: '2026/3/27 12:30:00',
            updatedAt: '2026/3/27 12:30:00',
          },
          {
            id: 'ticket-import-preset-2',
            name: '财务同步模板',
            tags: ['财务'],
            ignoredFieldKeys: ['channel'],
            savedAt: '2026/3/27 12:31:00',
            updatedAt: '2026/3/27 12:31:00',
          },
          {
            id: 'ticket-import-preset-3',
            name: '无标签预设',
            tags: [],
            ignoredFieldKeys: ['extra'],
            savedAt: '2026/3/27 12:32:00',
            updatedAt: '2026/3/27 12:32:00',
          },
        ],
      }),
    )

    const mounted = mountDirectoryManagement()
    await flushAll()

    let noteRoot = await openTicketTemplateImportFromBatchFailure(mounted.container)
    noteRoot = await pasteTeamTemplateImportCode(noteRoot, {
      version: 1,
      outputMode: 'ticket',
      template: {
        preset: 'ops',
        handlingGroupKey: 'ops-handoff',
        owner: '再次导入负责人',
        deadline: '后天 10:00 前',
        channel: 'Jira #NEXT',
        extra: '再次导入模板说明',
        snippetKeys: ['notify-retry', 'fill-result'],
        savedAt: '2026/3/27 12:40:00',
      },
    })
    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement

    const groupHints = Array.from(noteRoot.querySelectorAll('.directory-admin__batch-note-import-preset-group .directory-admin__hint'))
      .map((item) => item.textContent?.trim())
      .filter((text): text is string => Boolean(text))
    expect(groupHints).toContain('标签组：工单（1）')
    expect(groupHints).toContain('标签组：财务（1）')
    expect(groupHints).toContain('标签组：未分组（1）')

    const searchInput = findInputByPlaceholder(noteRoot, '按预设名称或标签筛选')
    expect(searchInput).toBeDefined()
    searchInput!.value = '渠道'
    searchInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushAll()

    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement
    const groupedPresetButtons = Array.from(
      noteRoot.querySelectorAll('.directory-admin__batch-note-import-preset-group .directory-admin__preset'),
    ).map((button) => button.textContent?.trim()).filter((text): text is string => Boolean(text))
    expect(groupedPresetButtons.some((text) => text.includes('保留负责人和渠道'))).toBe(true)
    expect(groupedPresetButtons.some((text) => text.includes('财务同步模板'))).toBe(false)
    expect(groupedPresetButtons.some((text) => text.includes('无标签预设'))).toBe(false)

    findButtonByText(noteRoot, '财务')?.click()
    await flushAll()

    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement
    expect(noteRoot.textContent).toContain('当前搜索与标签条件下没有匹配的导入预设。')

    searchInput!.value = ''
    searchInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushAll()

    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement
    const filteredGroups = Array.from(noteRoot.querySelectorAll('.directory-admin__batch-note-import-preset-group .directory-admin__hint'))
      .map((item) => item.textContent?.trim())
      .filter((text): text is string => Boolean(text))
    expect(filteredGroups).toEqual(['标签组：财务（1）'])
    const filteredButtons = Array.from(
      noteRoot.querySelectorAll('.directory-admin__batch-note-import-preset-group .directory-admin__preset'),
    ).map((button) => button.textContent?.trim()).filter((text): text is string => Boolean(text))
    expect(filteredButtons.length).toBe(1)
    expect(filteredButtons[0]).toContain('财务同步模板')
    expect(filteredButtons[0]).toContain('财务')
    mounted.unmount()
  })

  it('pins, favorites, and locks recent usage ordering for saved import presets', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱不能为空，无法开户',
          },
        }, {
          status: 400,
          ok: false,
        })
      }
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    localStorage.setItem(
      BATCH_FAILURE_REASON_TEAM_TEMPLATES_STORAGE_KEY,
      JSON.stringify({
        ticket: {
          preset: 'ops',
          handlingGroupKey: 'ops-handoff',
          owner: '旧负责人',
          deadline: '今天 18:00 前',
          channel: 'Jira #OLD',
          extra: '旧模板说明',
          snippetKeys: ['notify-retry'],
          savedAt: '2026/3/27 12:20:00',
        },
      }),
    )
    localStorage.setItem(
      BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_PRESETS_STORAGE_KEY,
      JSON.stringify({
        ticket: [
          {
            id: 'ticket-import-preset-a',
            name: '预设A',
            tags: ['工单'],
            favorite: false,
            pinned: false,
            lockedOrder: 0,
            useCount: 0,
            lastUsedAt: '',
            ignoredFieldKeys: ['owner'],
            savedAt: '2026/3/27 12:30:00',
            updatedAt: '2026/3/27 12:30:00',
          },
          {
            id: 'ticket-import-preset-b',
            name: '预设B',
            tags: ['工单'],
            favorite: false,
            pinned: false,
            lockedOrder: 1,
            useCount: 0,
            lastUsedAt: '',
            ignoredFieldKeys: ['channel'],
            savedAt: '2026/3/27 12:31:00',
            updatedAt: '2026/3/27 12:31:00',
          },
        ],
      }),
    )

    const mounted = mountDirectoryManagement()
    await flushAll()

    let noteRoot = await openTicketTemplateImportFromBatchFailure(mounted.container)
    noteRoot = await pasteTeamTemplateImportCode(noteRoot, {
      version: 1,
      outputMode: 'ticket',
      template: {
        preset: 'ops',
        handlingGroupKey: 'ops-handoff',
        owner: '再次导入负责人',
        deadline: '后天 10:00 前',
        channel: 'Jira #NEXT',
        extra: '再次导入模板说明',
        snippetKeys: ['notify-retry', 'fill-result'],
        savedAt: '2026/3/27 12:40:00',
      },
    })
    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement

    let presetButtons = getSavedImportPresetButtonTexts(noteRoot)
    expect(presetButtons[0]).toContain('预设B')
    expect(presetButtons[1]).toContain('预设A')

    findButtonByText(noteRoot, '预设A')?.click()
    await flushAll()

    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement
    presetButtons = getSavedImportPresetButtonTexts(noteRoot)
    expect(presetButtons[0]).toContain('预设A')
    expect(presetButtons[0]).toContain('使用 1 次')
    expect(noteRoot.textContent).toContain('当前选中统计：已使用 1 次')

    findButtonByText(noteRoot, '锁定最近使用排序')?.click()
    await flushAll()

    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement
    expect(noteRoot.textContent).toContain('解除排序锁定')
    findButtonByText(noteRoot, '预设B')?.click()
    await flushAll()

    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement
    presetButtons = getSavedImportPresetButtonTexts(noteRoot)
    expect(presetButtons[0]).toContain('预设A')
    expect(noteRoot.textContent).toContain('当前选中预设（工单 Markdown）：')
    expect(noteRoot.textContent).toContain('预设B')
    expect(noteRoot.textContent).toContain('当前选中统计：已使用 1 次')

    findButtonByText(noteRoot, '收藏当前预设')?.click()
    await flushAll()

    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement
    presetButtons = getSavedImportPresetButtonTexts(noteRoot)
    expect(presetButtons[0]).toContain('收藏')
    expect(presetButtons[0]).toContain('预设B')
    expect(noteRoot.textContent).toContain('当前选中状态：收藏')

    findButtonByText(noteRoot, '置顶当前预设')?.click()
    await flushAll()

    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement
    presetButtons = getSavedImportPresetButtonTexts(noteRoot)
    expect(presetButtons[0]).toContain('置顶')
    expect(presetButtons[0]).toContain('收藏')
    expect(presetButtons[0]).toContain('预设B')
    expect(noteRoot.textContent).toContain('当前选中状态：置顶 / 收藏')
    mounted.unmount()
  })

  it('shows usage stats and clears low-frequency presets within the current filtered scope', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱不能为空，无法开户',
          },
        }, {
          status: 400,
          ok: false,
        })
      }
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    localStorage.setItem(
      BATCH_FAILURE_REASON_TEAM_TEMPLATES_STORAGE_KEY,
      JSON.stringify({
        ticket: {
          preset: 'ops',
          handlingGroupKey: 'ops-handoff',
          owner: '旧负责人',
          deadline: '今天 18:00 前',
          channel: 'Jira #OLD',
          extra: '旧模板说明',
          snippetKeys: ['notify-retry'],
          savedAt: '2026/3/27 12:20:00',
        },
      }),
    )
    localStorage.setItem(
      BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_PRESETS_STORAGE_KEY,
      JSON.stringify({
        ticket: [
          {
            id: 'ticket-import-preset-low-1',
            name: '低频A',
            tags: ['工单'],
            favorite: false,
            pinned: false,
            lockedOrder: 0,
            useCount: 1,
            lastUsedAt: '2026/3/27 12:31:00',
            ignoredFieldKeys: ['channel'],
            savedAt: '2026/3/27 12:31:00',
            updatedAt: '2026/3/27 12:31:00',
          },
          {
            id: 'ticket-import-preset-low-2',
            name: '低频B',
            tags: ['财务'],
            favorite: false,
            pinned: false,
            lockedOrder: 1,
            useCount: 0,
            lastUsedAt: '',
            ignoredFieldKeys: ['owner'],
            savedAt: '2026/3/27 12:32:00',
            updatedAt: '2026/3/27 12:32:00',
          },
          {
            id: 'ticket-import-preset-keep-fav',
            name: '保留收藏',
            tags: ['财务'],
            favorite: true,
            pinned: false,
            lockedOrder: 2,
            useCount: 1,
            lastUsedAt: '2026/3/27 12:33:00',
            ignoredFieldKeys: ['extra'],
            savedAt: '2026/3/27 12:33:00',
            updatedAt: '2026/3/27 12:33:00',
          },
          {
            id: 'ticket-import-preset-keep-pin',
            name: '保留置顶',
            tags: ['工单'],
            favorite: false,
            pinned: true,
            lockedOrder: 3,
            useCount: 1,
            lastUsedAt: '2026/3/27 12:34:00',
            ignoredFieldKeys: ['snippetKeys'],
            savedAt: '2026/3/27 12:34:00',
            updatedAt: '2026/3/27 12:34:00',
          },
        ],
      }),
    )

    const mounted = mountDirectoryManagement()
    await flushAll()

    let noteRoot = await openTicketTemplateImportFromBatchFailure(mounted.container)
    noteRoot = await pasteTeamTemplateImportCode(noteRoot, {
      version: 1,
      outputMode: 'ticket',
      template: {
        preset: 'ops',
        handlingGroupKey: 'ops-handoff',
        owner: '再次导入负责人',
        deadline: '后天 10:00 前',
        channel: 'Jira #NEXT',
        extra: '再次导入模板说明',
        snippetKeys: ['notify-retry', 'fill-result'],
        savedAt: '2026/3/27 12:40:00',
      },
    })
    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement

    expect(noteRoot.textContent).toContain('当前范围低频预设：2 项')

    findButtonByText(noteRoot, '低频A')?.click()
    await flushAll()

    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement
    expect(noteRoot.textContent).toContain('当前选中统计：已使用 2 次')
    expect(noteRoot.textContent).toContain('当前范围低频预设：1 项')

    findButtonByText(noteRoot, '财务')?.click()
    await flushAll()

    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement
    expect(noteRoot.textContent).toContain('当前范围低频预设：1 项')
    findButtonByText(noteRoot, '清理低频预设（1）')?.click()
    await flushAll()

    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement
    expect(mounted.container.textContent).toContain('已清理输出“工单 Markdown”当前范围内的 1 条低频导入预设')
    const presetButtons = getSavedImportPresetButtonTexts(noteRoot)
    expect(presetButtons.some((text) => text.includes('低频B'))).toBe(false)
    expect(presetButtons.some((text) => text.includes('保留收藏'))).toBe(true)
    const storedPresets = JSON.parse(localStorage.getItem(BATCH_FAILURE_REASON_TEAM_TEMPLATE_IMPORT_PRESETS_STORAGE_KEY) || '{}') as Record<string, Array<{ name: string }>>
    expect(storedPresets.ticket?.map((item) => item.name)).toEqual(expect.arrayContaining(['低频A', '保留收藏', '保留置顶']))
    expect(storedPresets.ticket?.map((item) => item.name)).not.toContain('低频B')
    mounted.unmount()
  })

  it('rolls back an imported template in another output slot and can reapply it from recent history', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱不能为空，无法开户',
          },
        }, {
          status: 400,
          ok: false,
        })
      }
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const accountSelectionCheckboxes = Array.from(
      container.querySelectorAll('.directory-admin__selection-toggle--account input[type="checkbox"]'),
    ) as HTMLInputElement[]
    accountSelectionCheckboxes[2]?.click()
    accountSelectionCheckboxes[3]?.click()
    await flushAll()

    const batchProvisionButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('批量开通并授权'))
    batchProvisionButton?.click()
    await flushAll()

    const reasonButton = Array.from(container.querySelectorAll('.directory-admin__batch-failure-group-button'))
      .find((button) => button.textContent?.includes('邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联')) as HTMLButtonElement | undefined
    reasonButton?.click()
    await flushAll()

    let noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('当前输出：备注原文')

    const importToggleButton = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('导入模板码')) as HTMLButtonElement | undefined
    importToggleButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    const importTextarea = noteRoot!.querySelector('.directory-admin__batch-note-import textarea') as HTMLTextAreaElement | null
    importTextarea!.value = encodeTeamTemplateCode({
      version: 1,
      outputMode: 'ticket',
      template: {
        preset: 'ops',
        handlingGroupKey: 'ops-handoff',
        owner: '跨槽位负责人',
        deadline: '明天 10:00 前',
        channel: 'Jira #CROSS',
        extra: '跨槽位导入模板',
        snippetKeys: ['notify-retry'],
        savedAt: '2026/3/27 12:40:00',
      },
    })
    importTextarea!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushAll()

    const importConfirmButton = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('确认导入')) as HTMLButtonElement | undefined
    expect(noteRoot!.textContent).toContain('导入差异：将新增')
    expect(noteRoot!.textContent).toContain('处理负责人')
    expect(noteRoot!.textContent).toContain('未设置')
    expect(noteRoot!.textContent).toContain('跨槽位负责人')
    importConfirmButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(container.textContent).toContain('模板码已导入到输出“工单 Markdown”')
    expect(noteRoot!.textContent).toContain('最近模板码导入')
    expect(noteRoot!.textContent).toContain('差异：将新增')
    expect(noteRoot!.textContent).toContain('导入前：该输出还没有团队标准模板')
    expect(noteRoot!.textContent).toContain('当前输出：备注原文')

    const rollbackButton = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('回滚并清空该输出模板')) as HTMLButtonElement | undefined
    expect(rollbackButton).toBeDefined()
    rollbackButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(container.textContent).toContain('已回滚输出“工单 Markdown”的模板导入')
    expect(noteRoot!.textContent).toContain('已回滚')

    const ticketButton = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-output .directory-admin__preset'))
      .find((button) => button.textContent?.includes('工单 Markdown')) as HTMLButtonElement | undefined
    ticketButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('当前输出还没有团队标准模板')

    const reapplyButton = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('应用此导入')) as HTMLButtonElement | undefined
    expect(reapplyButton).toBeDefined()
    reapplyButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(container.textContent).toContain('已重新应用 工单 Markdown 的模板导入记录')
    expect(noteRoot!.textContent).toContain('团队标准模板：处理组 运营跟进 · 模板 运营跟进 · 负责人 跨槽位负责人')
    expect(noteRoot!.textContent).toContain('处理负责人：跨槽位负责人')
    unmount()
  })

  it('keeps manual note context isolated per failure reason and supports restore actions', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱不能为空，无法开户',
          },
        }, {
          status: 400,
          ok: false,
        })
      }
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const accountSelectionCheckboxes = Array.from(
      container.querySelectorAll('.directory-admin__selection-toggle--account input[type="checkbox"]'),
    ) as HTMLInputElement[]
    accountSelectionCheckboxes[2]?.click()
    accountSelectionCheckboxes[3]?.click()
    await flushAll()

    const batchProvisionButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('批量开通并授权'))
    expect(batchProvisionButton).toBeDefined()
    batchProvisionButton?.click()
    await flushAll()

    const autoLinkReasonButton = Array.from(container.querySelectorAll('.directory-admin__batch-failure-group-button'))
      .find((button) => button.textContent?.includes('邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联')) as HTMLButtonElement | undefined
    const missingEmailReasonButton = Array.from(container.querySelectorAll('.directory-admin__batch-failure-group-button'))
      .find((button) => button.textContent?.includes('邮箱不能为空，无法开户')) as HTMLButtonElement | undefined
    expect(autoLinkReasonButton).toBeDefined()
    expect(missingEmailReasonButton).toBeDefined()

    autoLinkReasonButton?.click()
    await flushAll()

    let noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot).toBeTruthy()

    const noteInputs = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-fields input')) as HTMLInputElement[]
    noteInputs[0]!.value = '值班管理员'
    noteInputs[0]!.dispatchEvent(new Event('input', { bubbles: true }))
    noteInputs[1]!.value = '今晚 20:00 前'
    noteInputs[1]!.dispatchEvent(new Event('input', { bubbles: true }))
    noteInputs[2]!.value = '钉钉群#目录同步'
    noteInputs[2]!.dispatchEvent(new Event('input', { bubbles: true }))

    const extraTextarea = noteRoot!.querySelector('textarea') as HTMLTextAreaElement | null
    expect(extraTextarea).toBeTruthy()
    extraTextarea!.value = '请先核对邮箱归属'
    extraTextarea!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushAll()

    const fillResultSnippet = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('处理后回填')) as HTMLButtonElement | undefined
    expect(fillResultSnippet).toBeDefined()
    fillResultSnippet?.click()
    await flushAll()

    missingEmailReasonButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot).toBeTruthy()
    expect(noteRoot!.textContent).toContain('已记住上次偏好：模板 管理员处理 · 负责人 值班管理员 · 截止 今晚 20:00 前 · 渠道 钉钉群#目录同步')
    expect(noteRoot!.textContent).toContain('当前处理组：推荐处理组')
    expect(noteRoot!.textContent).toContain('处理负责人：运营/客服')
    expect(noteRoot!.textContent).toContain('同步渠道：运营群 / 客服工单')
    expect(noteRoot!.textContent).not.toContain('请先核对邮箱归属；处理完成后请在群里或工单中回填结果。')
    expect(noteRoot!.textContent).toContain('补充说明：请先补齐邮箱或确认允许使用钉钉占位邮箱，再继续开户。')

    autoLinkReasonButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('处理负责人：值班管理员')
    expect(noteRoot!.textContent).toContain('截止时间：今晚 20:00 前')
    expect(noteRoot!.textContent).toContain('同步渠道：钉钉群#目录同步')
    expect(noteRoot!.textContent).toContain('补充说明：请先核对邮箱归属；处理完成后请在群里或工单中回填结果。')

    const clearExtraButton = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('清空补充说明')) as HTMLButtonElement | undefined
    expect(clearExtraButton).toBeDefined()
    clearExtraButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).not.toContain('请先核对邮箱归属；处理完成后请在群里或工单中回填结果。')

    const restoreButton = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('恢复推荐字段')) as HTMLButtonElement | undefined
    expect(restoreButton).toBeDefined()
    restoreButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('处理负责人：平台管理员')
    expect(noteRoot!.textContent).toContain('截止时间：今天 18:00 前')
    expect(noteRoot!.textContent).toContain('同步渠道：管理员处理群 / 工单')
    expect(noteRoot!.textContent).toContain('补充说明：请核对邮箱归属后执行关联，完成后通知用户重新尝试。')
    expect(container.textContent).toContain('已恢复失败原因“邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联”的推荐备注字段')
    unmount()
  })

  it('remembers note output preferences across remounts', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱不能为空，无法开户',
          },
        }, {
          status: 400,
          ok: false,
        })
      }
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    let mounted = mountDirectoryManagement()
    await flushAll()

    let accountSelectionCheckboxes = Array.from(
      mounted.container.querySelectorAll('.directory-admin__selection-toggle--account input[type="checkbox"]'),
    ) as HTMLInputElement[]
    accountSelectionCheckboxes[2]?.click()
    accountSelectionCheckboxes[3]?.click()
    await flushAll()

    let batchProvisionButton = Array.from(mounted.container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('批量开通并授权'))
    expect(batchProvisionButton).toBeDefined()
    batchProvisionButton?.click()
    await flushAll()

    let reasonButton = Array.from(mounted.container.querySelectorAll('.directory-admin__batch-failure-group-button'))
      .find((button) => button.textContent?.includes('邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联')) as HTMLButtonElement | undefined
    expect(reasonButton).toBeDefined()
    reasonButton?.click()
    await flushAll()

    let noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot).toBeTruthy()

    const opsPresetButton = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-presets .directory-admin__preset'))
      .find((button) => button.textContent?.includes('运营跟进')) as HTMLButtonElement | undefined
    expect(opsPresetButton).toBeDefined()
    opsPresetButton?.click()
    await flushAll()

    const ticketButton = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-output .directory-admin__preset'))
      .find((button) => button.textContent?.includes('工单 Markdown')) as HTMLButtonElement | undefined
    expect(ticketButton).toBeDefined()
    ticketButton?.click()
    await flushAll()

    let noteInputs = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-fields input')) as HTMLInputElement[]
    noteInputs[0]!.value = '值班经理'
    noteInputs[0]!.dispatchEvent(new Event('input', { bubbles: true }))
    noteInputs[1]!.value = '明天 10:00 前'
    noteInputs[1]!.dispatchEvent(new Event('input', { bubbles: true }))
    noteInputs[2]!.value = 'Jira #123'
    noteInputs[2]!.dispatchEvent(new Event('input', { bubbles: true }))

    const notifyRetryButton = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-snippets .directory-admin__preset'))
      .find((button) => button.textContent?.includes('通知用户重试')) as HTMLButtonElement | undefined
    expect(notifyRetryButton).toBeDefined()
    notifyRetryButton?.click()
    await flushAll()

    mounted.unmount()

    mounted = mountDirectoryManagement()
    await flushAll()

    accountSelectionCheckboxes = Array.from(
      mounted.container.querySelectorAll('.directory-admin__selection-toggle--account input[type="checkbox"]'),
    ) as HTMLInputElement[]
    accountSelectionCheckboxes[2]?.click()
    accountSelectionCheckboxes[3]?.click()
    await flushAll()

    batchProvisionButton = Array.from(mounted.container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('批量开通并授权'))
    expect(batchProvisionButton).toBeDefined()
    batchProvisionButton?.click()
    await flushAll()

    reasonButton = Array.from(mounted.container.querySelectorAll('.directory-admin__batch-failure-group-button'))
      .find((button) => button.textContent?.includes('邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联')) as HTMLButtonElement | undefined
    expect(reasonButton).toBeDefined()
    reasonButton?.click()
    await flushAll()

    noteRoot = mounted.container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot).toBeTruthy()
    expect(noteRoot!.textContent).toContain('当前输出：工单 Markdown')
    expect(noteRoot!.textContent).toContain('当前模板：运营跟进')
    expect(noteRoot!.textContent).toContain('已记住上次偏好：模板 运营跟进 · 负责人 值班经理 · 截止 明天 10:00 前 · 渠道 Jira #123 · 补充语 通知用户重试')
    expect(noteRoot!.textContent).toContain('已记住快捷补充语：通知用户重试')
    expect(noteRoot!.textContent).toContain('处理负责人：值班经理')
    expect(noteRoot!.textContent).toContain('截止时间：明天 10:00 前')
    expect(noteRoot!.textContent).toContain('同步渠道：Jira #123')
    expect(noteRoot!.textContent).toContain('补充说明：请核对邮箱归属后执行关联，完成后通知用户重新尝试。；处理完成后请通知用户重新尝试。')
    mounted.unmount()
  })

  it('keeps remembered preferences separate per output mode and restores them on demand', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱不能为空，无法开户',
          },
        }, {
          status: 400,
          ok: false,
        })
      }
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const accountSelectionCheckboxes = Array.from(
      container.querySelectorAll('.directory-admin__selection-toggle--account input[type="checkbox"]'),
    ) as HTMLInputElement[]
    accountSelectionCheckboxes[2]?.click()
    accountSelectionCheckboxes[3]?.click()
    await flushAll()

    const batchProvisionButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('批量开通并授权'))
    expect(batchProvisionButton).toBeDefined()
    batchProvisionButton?.click()
    await flushAll()

    const reasonButton = Array.from(container.querySelectorAll('.directory-admin__batch-failure-group-button'))
      .find((button) => button.textContent?.includes('邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联')) as HTMLButtonElement | undefined
    expect(reasonButton).toBeDefined()
    reasonButton?.click()
    await flushAll()

    let noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot).toBeTruthy()

    const opsPresetButton = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-presets .directory-admin__preset'))
      .find((button) => button.textContent?.includes('运营跟进')) as HTMLButtonElement | undefined
    const briefPresetButton = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-presets .directory-admin__preset'))
      .find((button) => button.textContent?.includes('IM 简版')) as HTMLButtonElement | undefined
    const ticketButton = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-output .directory-admin__preset'))
      .find((button) => button.textContent?.includes('工单 Markdown')) as HTMLButtonElement | undefined
    const imButton = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-output .directory-admin__preset'))
      .find((button) => button.textContent?.includes('IM 外发')) as HTMLButtonElement | undefined
    expect(opsPresetButton).toBeDefined()
    expect(briefPresetButton).toBeDefined()
    expect(ticketButton).toBeDefined()
    expect(imButton).toBeDefined()

    opsPresetButton?.click()
    ticketButton?.click()
    await flushAll()

    let noteInputs = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-fields input')) as HTMLInputElement[]
    noteInputs[0]!.value = 'Jira 值班'
    noteInputs[0]!.dispatchEvent(new Event('input', { bubbles: true }))
    noteInputs[2]!.value = 'Jira #123'
    noteInputs[2]!.dispatchEvent(new Event('input', { bubbles: true }))

    let snippetButton = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-snippets .directory-admin__preset'))
      .find((button) => button.textContent?.includes('处理后回填')) as HTMLButtonElement | undefined
    expect(snippetButton).toBeDefined()
    snippetButton?.click()
    await flushAll()

    imButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    briefPresetButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    noteInputs = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-fields input')) as HTMLInputElement[]
    noteInputs[0]!.value = 'IM 值班'
    noteInputs[0]!.dispatchEvent(new Event('input', { bubbles: true }))
    noteInputs[2]!.value = '钉钉群#目录同步'
    noteInputs[2]!.dispatchEvent(new Event('input', { bubbles: true }))
    const extraTextarea = noteRoot!.querySelector('textarea') as HTMLTextAreaElement | null
    expect(extraTextarea).toBeTruthy()
    extraTextarea!.value = '请核对邮箱归属后执行关联，完成后通知用户重新尝试。'
    extraTextarea!.dispatchEvent(new Event('input', { bubbles: true }))

    snippetButton = Array.from(noteRoot!.querySelectorAll('.directory-admin__batch-note-snippets .directory-admin__preset'))
      .find((button) => button.textContent?.includes('仍失败升级管理员')) as HTMLButtonElement | undefined
    expect(snippetButton).toBeDefined()
    snippetButton?.click()
    await flushAll()

    ticketButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('当前输出：工单 Markdown')
    expect(noteRoot!.textContent).toContain('当前模板：运营跟进')
    expect(noteRoot!.textContent).toContain('已记住上次偏好：模板 运营跟进 · 负责人 Jira 值班 · 截止 今天 18:00 前 · 渠道 Jira #123 · 补充语 处理后回填')
    expect(noteRoot!.textContent).toContain('已记住快捷补充语：处理后回填')

    let restoreRememberedButton = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('恢复上次偏好')) as HTMLButtonElement | undefined
    expect(restoreRememberedButton).toBeDefined()
    restoreRememberedButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('处理负责人：Jira 值班')
    expect(noteRoot!.textContent).toContain('同步渠道：Jira #123')
    expect(noteRoot!.textContent).toContain('补充说明：请核对邮箱归属后执行关联，完成后通知用户重新尝试。；处理完成后请在群里或工单中回填结果。')

    imButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('当前输出：IM 外发')
    expect(noteRoot!.textContent).toContain('当前模板：IM 简版')
    expect(noteRoot!.textContent).toContain('已记住上次偏好：模板 IM 简版 · 负责人 IM 值班 · 截止 今天 18:00 前 · 渠道 钉钉群#目录同步 · 补充语 处理后回填 / 仍失败升级管理员')
    expect(noteRoot!.textContent).toContain('已记住快捷补充语：处理后回填 / 仍失败升级管理员')

    let restoreRememberedSnippetsButton = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('恢复上次补充语')) as HTMLButtonElement | undefined
    expect(restoreRememberedSnippetsButton).toBeDefined()
    const clearExtraButton = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('清空补充说明')) as HTMLButtonElement | undefined
    expect(clearExtraButton).toBeDefined()
    clearExtraButton?.click()
    await flushAll()

    restoreRememberedSnippetsButton = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('恢复上次补充语')) as HTMLButtonElement | undefined
    restoreRememberedSnippetsButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('补充：请核对邮箱归属后执行关联，完成后通知用户重新尝试。；处理完成后请在群里或工单中回填结果。；若再次失败，请升级管理员继续排查。')

    restoreRememberedButton = Array.from(noteRoot!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('恢复上次偏好')) as HTMLButtonElement | undefined
    restoreRememberedButton?.click()
    await flushAll()

    noteRoot = container.querySelector('.directory-admin__batch-note') as HTMLElement | null
    expect(noteRoot!.textContent).toContain('负责人：IM 值班')
    expect(noteRoot!.textContent).toContain('渠道：钉钉群#目录同步')
    unmount()
  })

  it('copies and exports only the active failure reason subset', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱不能为空，无法开户',
          },
        }, {
          status: 400,
          ok: false,
        })
      }
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const accountSelectionCheckboxes = Array.from(
      container.querySelectorAll('.directory-admin__selection-toggle--account input[type="checkbox"]'),
    ) as HTMLInputElement[]
    accountSelectionCheckboxes[2]?.click()
    accountSelectionCheckboxes[3]?.click()
    await flushAll()

    const batchProvisionButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('批量开通并授权'))
    expect(batchProvisionButton).toBeDefined()
    batchProvisionButton?.click()
    await flushAll()

    const reasonButton = Array.from(container.querySelectorAll('.directory-admin__batch-failure-group-button'))
      .find((button) => button.textContent?.includes('邮箱不能为空，无法开户')) as HTMLButtonElement | undefined
    expect(reasonButton).toBeDefined()
    reasonButton?.click()
    await flushAll()

    const copyReasonFailuresButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('复制该类失败'))
    const exportReasonFailuresButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('导出该类 CSV'))
    expect(copyReasonFailuresButton).toBeDefined()
    expect(exportReasonFailuresButton).toBeDefined()

    copyReasonFailuresButton?.click()
    await flushAll()

    expect(globalThis.navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('失败原因,邮箱不能为空，无法开户'),
    )
    expect(globalThis.navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('王敏'),
    )
    expect(globalThis.navigator.clipboard.writeText).not.toHaveBeenCalledWith(
      expect.stringContaining('陈晨'),
    )
    expect(container.textContent).toContain('该类失败清单已复制（1 项）')

    exportReasonFailuresButton?.click()
    await flushAll()
    expect(globalThis.URL.createObjectURL).toHaveBeenCalled()
    expect(container.textContent).toContain('该类失败 CSV 已导出（1 项）')
    unmount()
  })

  it('scopes recommended follow-up actions to the active failure reason subset', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱不能为空，无法开户',
          },
        }, {
          status: 400,
          ok: false,
        })
      }
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}/provision-user` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const accountSelectionCheckboxes = Array.from(
      container.querySelectorAll('.directory-admin__selection-toggle--account input[type="checkbox"]'),
    ) as HTMLInputElement[]
    accountSelectionCheckboxes[2]?.click()
    accountSelectionCheckboxes[3]?.click()
    await flushAll()

    const batchProvisionButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('批量开通并授权'))
    expect(batchProvisionButton).toBeDefined()
    batchProvisionButton?.click()
    await flushAll()

    expect(container.textContent).toContain('推荐：批量开通并授权（1）')
    expect(container.textContent).toContain('推荐：按邮箱批量关联（1）')

    const reasonButton = Array.from(container.querySelectorAll('.directory-admin__batch-failure-group-button'))
      .find((button) => button.textContent?.includes('邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联')) as HTMLButtonElement | undefined
    expect(reasonButton).toBeDefined()
    reasonButton?.click()
    await flushAll()

    const recommendationButtons = Array.from(
      container.querySelectorAll('.directory-admin__batch-recommendations button'),
    ) as HTMLButtonElement[]
    expect(recommendationButtons).toHaveLength(1)
    expect(recommendationButtons[0]?.textContent).toContain('推荐：按邮箱批量关联（1）')
    expect(container.textContent).toContain('当前推荐已按失败原因“邮箱已存在但未关联 MetaSheet 账号，请先按邮箱关联”收窄')
    expect(container.textContent).not.toContain('推荐：批量开通并授权（1）')

    recommendationButtons[0]?.click()
    await flushAll()

    expect(vi.mocked(apiModule.apiFetch)).toHaveBeenCalledWith(
      `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}/auto-link-by-email`,
      expect.objectContaining({ method: 'POST' }),
    )
    expect(vi.mocked(apiModule.apiFetch)).not.toHaveBeenCalledWith(
      `/api/admin/directory/integrations/${integrationId}/accounts/${thirdAccountId}/auto-link-by-email`,
      expect.anything(),
    )
    expect(container.textContent).toContain('推荐：按邮箱批量关联：已处理 1 项')
    unmount()
  })

  it('keeps recent batch result history and allows restoring an earlier record', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${secondAccountId}/auto-link-by-email` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱对应多个 MetaSheet 账号，请人工处理',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const selectAllLabel = Array.from(container.querySelectorAll('.directory-admin__selection-toggle'))
      .find((label) => label.textContent?.includes('全选当前页'))
    const selectAllCheckbox = selectAllLabel?.querySelector('input[type="checkbox"]') as HTMLInputElement | null
    expect(selectAllCheckbox).not.toBeNull()

    selectAllCheckbox?.click()
    await flushAll()

    const batchAutoLinkButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('按邮箱批量关联'))
    expect(batchAutoLinkButton).toBeDefined()
    batchAutoLinkButton?.click()
    await flushAll()

    expect(container.textContent).toContain('按邮箱批量关联')
    expect(container.textContent).toContain('共 2 项，成功 1 项，失败 1 项')

    const clearSelectionButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('清空选择'))
    clearSelectionButton?.click()
    await flushAll()

    const accountSelectionCheckboxes = Array.from(
      container.querySelectorAll('.directory-admin__selection-toggle--account input[type="checkbox"]'),
    ) as HTMLInputElement[]
    accountSelectionCheckboxes[2]?.click()
    await flushAll()

    const batchProvisionButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('批量开通并授权'))
    expect(batchProvisionButton).toBeDefined()
    batchProvisionButton?.click()
    await flushAll()

    expect(container.textContent).toContain('最近批量处理记录')
    expect(container.textContent).toContain('批量开通并授权')

    const historyButton = Array.from(container.querySelectorAll('.directory-admin__batch-history-item'))
      .find((button) => button.textContent?.includes('按邮箱批量关联')) as HTMLButtonElement | undefined
    expect(historyButton).toBeDefined()
    historyButton?.click()
    await flushAll()

    expect(container.textContent).toContain('邮箱对应多个 MetaSheet 账号，请人工处理')
    unmount()
  })

  it('filters batch history between all, failed, and success records', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${secondAccountId}/auto-link-by-email` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱对应多个 MetaSheet 账号，请人工处理',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const selectAllLabel = Array.from(container.querySelectorAll('.directory-admin__selection-toggle'))
      .find((label) => label.textContent?.includes('全选当前页'))
    const selectAllCheckbox = selectAllLabel?.querySelector('input[type="checkbox"]') as HTMLInputElement | null
    selectAllCheckbox?.click()
    await flushAll()

    const batchAutoLinkButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('按邮箱批量关联'))
    batchAutoLinkButton?.click()
    await flushAll()

    const clearSelectionButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('清空选择'))
    clearSelectionButton?.click()
    await flushAll()

    const accountSelectionCheckboxes = Array.from(
      container.querySelectorAll('.directory-admin__selection-toggle--account input[type="checkbox"]'),
    ) as HTMLInputElement[]
    accountSelectionCheckboxes[2]?.click()
    await flushAll()

    const batchProvisionButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('批量开通并授权'))
    batchProvisionButton?.click()
    await flushAll()

    const historyFilterButtons = Array.from(container.querySelectorAll('.directory-admin__batch-history .directory-admin__preset'))
    const failedFilter = historyFilterButtons.find((button) => button.textContent?.includes('仅失败')) as HTMLButtonElement | undefined
    const successFilter = historyFilterButtons.find((button) => button.textContent?.includes('仅成功')) as HTMLButtonElement | undefined
    const allFilter = historyFilterButtons.find((button) => button.textContent?.includes('全部')) as HTMLButtonElement | undefined

    failedFilter?.click()
    await flushAll()
    let historyItems = Array.from(container.querySelectorAll('.directory-admin__batch-history-item'))
    expect(historyItems.length).toBe(1)
    expect(historyItems[0]?.textContent).toContain('按邮箱批量关联')

    successFilter?.click()
    await flushAll()
    historyItems = Array.from(container.querySelectorAll('.directory-admin__batch-history-item'))
    expect(historyItems.length).toBe(1)
    expect(historyItems[0]?.textContent).toContain('批量开通并授权')

    allFilter?.click()
    await flushAll()
    historyItems = Array.from(container.querySelectorAll('.directory-admin__batch-history-item'))
    expect(historyItems.length).toBe(2)
    const failedHistoryItem = historyItems.find((item) => item.textContent?.includes('按邮箱批量关联'))
    const successHistoryItem = historyItems.find((item) => item.textContent?.includes('批量开通并授权'))
    expect(failedHistoryItem?.className).toContain('directory-admin__batch-history-item--failed')
    expect(failedHistoryItem?.textContent).toContain('失败 1')
    expect(successHistoryItem?.className).not.toContain('directory-admin__batch-history-item--failed')
    unmount()
  })

  it('clears batch history without collapsing the current batch result', async () => {
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/accounts/${secondAccountId}/auto-link-by-email` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            message: '邮箱对应多个 MetaSheet 账号，请人工处理',
          },
        }, {
          status: 409,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const selectAllLabel = Array.from(container.querySelectorAll('.directory-admin__selection-toggle'))
      .find((label) => label.textContent?.includes('全选当前页'))
    const selectAllCheckbox = selectAllLabel?.querySelector('input[type="checkbox"]') as HTMLInputElement | null
    selectAllCheckbox?.click()
    await flushAll()

    const batchAutoLinkButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('按邮箱批量关联'))
    batchAutoLinkButton?.click()
    await flushAll()

    const clearSelectionButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('清空选择'))
    clearSelectionButton?.click()
    await flushAll()

    const accountSelectionCheckboxes = Array.from(
      container.querySelectorAll('.directory-admin__selection-toggle--account input[type="checkbox"]'),
    ) as HTMLInputElement[]
    accountSelectionCheckboxes[2]?.click()
    await flushAll()

    const batchProvisionButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('批量开通并授权'))
    batchProvisionButton?.click()
    await flushAll()

    expect(container.textContent).toContain('最近批量处理记录')
    expect(container.textContent).toContain('批量开通并授权')

    const clearHistoryButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('清空历史'))
    expect(clearHistoryButton).toBeDefined()
    clearHistoryButton?.click()
    await flushAll()

    expect(container.querySelector('.directory-admin__batch-history')).toBeNull()
    expect(container.textContent).toContain('本次批量处理结果')
    expect(container.textContent).toContain('最近批量处理记录已清空')
    expect(container.textContent).toContain('批量开通并授权')
    unmount()
  })

  it('calls the manual sync endpoint when the sync button is clicked', async () => {
    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const buttons = Array.from(container.querySelectorAll('button'))
    const syncButton = buttons.find((button) => button.textContent?.includes('立即同步'))
    expect(syncButton).toBeDefined()
    syncButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await flushAll()

    expect(vi.mocked(apiModule.apiFetch)).toHaveBeenCalledWith(
      `/api/admin/directory/integrations/${integrationId}/sync`,
      expect.objectContaining({ method: 'POST' }),
    )
    unmount()
  })

  it('renders DingTalk permission remediation from failed runs', async () => {
    const applyUrl = 'https://open-dev.dingtalk.com/appscope/apply?content=ding33bpfsmhnrdt0clu%23qyapi_get_department_list'
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/runs`) {
        return createMockResponse({
          ok: true,
          data: {
            items: [{
              ...run,
              status: 'error',
              error_message: `ding talk error[subcode=60011,submsg=应用尚未开通所需的权限：[qyapi_get_department_list]，点击链接申请并开通即可：${applyUrl}, {requiredScopes=[qyapi_get_department_list]}]`,
            }],
          },
        })
      }
      return await defaultImpl!(url, init)
    })

    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    expect(container.textContent).toContain('缺少权限：qyapi_get_department_list')
    const remediationLink = Array.from(container.querySelectorAll('a')).find((link) => link.textContent?.includes('申请钉钉权限'))
    expect(remediationLink?.getAttribute('href')).toBe(applyUrl)
    unmount()
  })

  it('shows permission remediation when manual sync returns structured DingTalk errors', async () => {
    const applyUrl = 'https://open-dev.dingtalk.com/appscope/apply?content=ding33bpfsmhnrdt0clu%23qyapi_get_department_list'
    const defaultImpl = vi.mocked(apiModule.apiFetch).getMockImplementation()
    expect(defaultImpl).toBeDefined()
    vi.mocked(apiModule.apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/directory/integrations/${integrationId}/sync` && init?.method === 'POST') {
        return createMockResponse({
          ok: false,
          error: {
            code: 'DINGTALK_PERMISSION_REQUIRED',
            message: '应用尚未开通所需的权限：[qyapi_get_department_list]',
            details: {
              provider: 'dingtalk',
              subcode: '60011',
              requiredScopes: ['qyapi_get_department_list'],
              applyUrl,
            },
          },
        }, {
          status: 502,
          ok: false,
        })
      }
      return await defaultImpl!(url, init)
    })

    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const buttons = Array.from(container.querySelectorAll('button'))
    const syncButton = buttons.find((button) => button.textContent?.includes('立即同步'))
    expect(syncButton).toBeDefined()
    syncButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushAll()

    expect(container.textContent).toContain('钉钉应用缺少通讯录权限')
    expect(container.textContent).toContain('qyapi_get_department_list')
    const remediationLink = Array.from(container.querySelectorAll('a')).find((link) => link.textContent?.includes('前往钉钉开放平台申请权限'))
    expect(remediationLink?.getAttribute('href')).toBe(applyUrl)
    unmount()
  })

  it('allows provisioning a local account without entering an email', async () => {
    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement | null
    expect(emailInput).not.toBeNull()
    if (!emailInput) {
      unmount()
      return
    }

    emailInput.value = ''
    emailInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    const buttons = Array.from(container.querySelectorAll('button'))
    const provisionButton = buttons.find((button) => button.textContent?.includes('开通本地账号'))
    expect(provisionButton).toBeDefined()
    expect(provisionButton?.hasAttribute('disabled')).toBe(false)
    provisionButton?.click()
    await flushAll()

    expect(vi.mocked(apiModule.apiFetch)).toHaveBeenCalledWith(
      `/api/admin/directory/integrations/${integrationId}/accounts/${accountId}/provision-user`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: '周华',
          authorizeDingTalk: true,
        }),
      }),
    )
    unmount()
  })

  it('allows saving an existing integration without re-entering app secret', async () => {
    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const secretInput = Array.from(container.querySelectorAll('input')).find((input) => input.getAttribute('type') === 'password') as HTMLInputElement | undefined
    const buttons = Array.from(container.querySelectorAll('button'))
    const saveButton = buttons.find((button) => button.textContent?.includes('保存集成'))

    expect(secretInput).toBeDefined()
    expect(saveButton).toBeDefined()

    secretInput!.value = ''
    secretInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushAll()

    expect(saveButton?.hasAttribute('disabled')).toBe(false)
    unmount()
  })

  it('persists the unbound DingTalk login capture toggle when saving an integration', async () => {
    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const checkboxes = Array.from(container.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[]
    const captureCheckbox = checkboxes.find((input) =>
      input.parentElement?.textContent?.includes('未开通钉钉用户登录时加入管理员待审核队列'),
    )
    const buttons = Array.from(container.querySelectorAll('button'))
    const saveButton = buttons.find((button) => button.textContent?.includes('保存集成'))

    expect(captureCheckbox).toBeDefined()
    expect(saveButton).toBeDefined()

    captureCheckbox!.click()
    await flushAll()

    saveButton?.click()
    await flushAll()

    const saveCall = vi.mocked(apiModule.apiFetch).mock.calls.find((call) =>
      call[0] === `/api/admin/directory/integrations/${integrationId}` && call[1]?.method === 'PATCH',
    )
    expect(saveCall).toBeDefined()
    const payload = JSON.parse(String(saveCall?.[1]?.body || '{}'))
    expect(payload.captureUnboundLogins).toBe(false)
    unmount()
  })

  it('persists combined default deprovision policies when saving an integration', async () => {
    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const policyGroups = Array.from(container.querySelectorAll('.directory-admin__policy-group'))
    const integrationPolicyGroup = policyGroups[0] as HTMLElement | undefined
    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('保存集成'))

    expect(integrationPolicyGroup).toBeDefined()
    expect(saveButton).toBeDefined()

    const policyOptions = Array.from(integrationPolicyGroup!.querySelectorAll('label'))
    const disableLocalUserOption = policyOptions.find((label) => label.textContent?.includes('停用本地账号'))
    const disableLocalUserCheckbox = disableLocalUserOption?.querySelector('input[type="checkbox"]') as HTMLInputElement | null

    expect(disableLocalUserCheckbox).not.toBeNull()
    disableLocalUserCheckbox?.click()
    await flushAll()

    saveButton?.click()
    await flushAll()

    const saveCall = vi.mocked(apiModule.apiFetch).mock.calls.find((call) =>
      call[0] === `/api/admin/directory/integrations/${integrationId}` && call[1]?.method === 'PATCH',
    )
    expect(saveCall).toBeDefined()
    const payload = JSON.parse(String(saveCall?.[1]?.body || '{}'))
    expect(payload.defaultDeprovisionPolicy).toEqual(['mark_inactive', 'disable_dingtalk_auth', 'disable_local_user'])
    unmount()
  })

  it('applies integration deprovision presets before saving', async () => {
    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const presetButtons = Array.from(container.querySelectorAll('.directory-admin__preset')) as HTMLButtonElement[]
    const presetButton = presetButtons.find((button) => button.textContent?.includes('失活+禁用钉钉'))
    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('保存集成'))

    expect(presetButton).toBeDefined()
    expect(saveButton).toBeDefined()

    presetButton?.click()
    await flushAll()
    saveButton?.click()
    await flushAll()

    const saveCall = vi.mocked(apiModule.apiFetch).mock.calls.find((call) =>
      call[0] === `/api/admin/directory/integrations/${integrationId}` && call[1]?.method === 'PATCH',
    )
    expect(saveCall).toBeDefined()
    const payload = JSON.parse(String(saveCall?.[1]?.body || '{}'))
    expect(payload.defaultDeprovisionPolicy).toEqual(['mark_inactive', 'disable_dingtalk_auth'])
    unmount()
  })

  it('exports directory accounts as csv', async () => {
    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const buttons = Array.from(container.querySelectorAll('button'))
    const exportButton = buttons.find((button) => button.textContent?.trim() === '导出 CSV')
    expect(exportButton).toBeDefined()
    exportButton?.click()
    await flushAll()

    expect(vi.mocked(apiModule.apiFetch)).toHaveBeenCalledWith(
      `/api/admin/directory/integrations/${integrationId}/accounts/export.csv`,
      expect.objectContaining({
        headers: {
          Accept: 'text/csv',
        },
      }),
    )
    expect(globalThis.URL.createObjectURL).toHaveBeenCalledTimes(1)
    expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('目录成员 CSV 已导出')
    unmount()
  })

  it('shows the generated temporary password after provisioning a local account', async () => {
    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement | null
    expect(emailInput).not.toBeNull()
    if (!emailInput) {
      unmount()
      return
    }

    emailInput.value = 'zhou@example.com'
    emailInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushAll()

    const buttons = Array.from(container.querySelectorAll('button'))
    const provisionButton = buttons.find((button) => button.textContent?.includes('开通本地账号'))
    expect(provisionButton).toBeDefined()
    provisionButton?.click()
    await flushAll()

    expect(vi.mocked(apiModule.apiFetch)).toHaveBeenCalledWith(
      `/api/admin/directory/integrations/${integrationId}/accounts/${accountId}/provision-user`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          email: 'zhou@example.com',
          name: '周华',
          authorizeDingTalk: true,
        }),
      }),
    )
    expect(container.textContent).toContain('最新开户临时密码：Temp#20260325（zhou@example.com）')
    expect(container.textContent).toContain('本地账号已开通并授权钉钉，临时密码已生成')
    unmount()
  })

  it('allows provisioning without auto-authorizing DingTalk when the toggle is disabled', async () => {
    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const authorizeCheckbox = Array.from(container.querySelectorAll('input[type="checkbox"]'))
      .find((input) => input.parentElement?.textContent?.includes('开户后自动授权钉钉登录')) as HTMLInputElement | undefined
    const provisionButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('开通本地账号'))

    expect(authorizeCheckbox).toBeDefined()
    expect(provisionButton).toBeDefined()

    authorizeCheckbox?.click()
    await flushAll()
    provisionButton?.click()
    await flushAll()

    expect(vi.mocked(apiModule.apiFetch)).toHaveBeenCalledWith(
      `/api/admin/directory/integrations/${integrationId}/accounts/${accountId}/provision-user`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: '周华',
          authorizeDingTalk: false,
        }),
      }),
    )
    unmount()
  })

  it('calls the revoke dingtalk action from the account detail pane', async () => {
    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const buttons = Array.from(container.querySelectorAll('button'))
    const authorizeButton = buttons.find((button) => button.textContent?.trim() === '取消钉钉授权')
    expect(authorizeButton).toBeDefined()
    authorizeButton?.click()
    await flushAll()

    const authorizeCall = vi.mocked(apiModule.apiFetch).mock.calls.find((call) =>
      call[0] === `/api/admin/directory/integrations/${integrationId}/accounts/${accountId}/authorize-dingtalk`,
    )
    expect(authorizeCall).toBeDefined()
    expect(vi.mocked(apiModule.apiFetch)).toHaveBeenCalledWith(
      `/api/admin/directory/integrations/${integrationId}/accounts/${accountId}/authorize-dingtalk`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ enabled: false }),
      }),
    )
    unmount()
  })

  it('auto-links the selected account by email from the detail pane', async () => {
    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const accountCards = Array.from(container.querySelectorAll('.directory-admin__account'))
    const targetCard = accountCards.find((button) => button.textContent?.includes('陈晨')) as HTMLButtonElement | undefined
    expect(targetCard).toBeDefined()
    targetCard?.click()
    await flushAll()

    const autoLinkButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === '按邮箱关联已有账号')
    expect(autoLinkButton).toBeDefined()

    autoLinkButton?.click()
    await flushAll()

    expect(vi.mocked(apiModule.apiFetch)).toHaveBeenCalledWith(
      `/api/admin/directory/integrations/${integrationId}/accounts/${fourthAccountId}/auto-link-by-email`,
      expect.objectContaining({ method: 'POST' }),
    )
    expect(container.textContent).toContain('已按邮箱关联已有账号')
    unmount()
  })

  it('saves combined member-level deprovision policies from the detail pane', async () => {
    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const detail = container.querySelector('.directory-admin__detail') as HTMLElement | null
    expect(detail).not.toBeNull()
    if (!detail) {
      unmount()
      return
    }

    const useDefaultLabel = Array.from(detail.querySelectorAll('label')).find((label) => label.textContent?.includes('沿用集成默认策略'))
    const useDefaultCheckbox = useDefaultLabel?.querySelector('input[type="checkbox"]') as HTMLInputElement | null
    expect(useDefaultCheckbox).not.toBeNull()
    if (useDefaultCheckbox?.checked) {
      useDefaultCheckbox.click()
      await flushAll()
    }

    const disableAuthLabel = Array.from(detail.querySelectorAll('label')).find((label) => label.textContent?.includes('禁用钉钉登录'))
    const disableAuthCheckbox = disableAuthLabel?.querySelector('input[type="checkbox"]') as HTMLInputElement | null
    expect(disableAuthCheckbox).not.toBeNull()
    if (!disableAuthCheckbox?.checked) {
      disableAuthCheckbox?.click()
      await flushAll()
    }

    const savePolicyButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('保存离职策略'))
    expect(savePolicyButton).toBeDefined()
    savePolicyButton?.click()
    await flushAll()

    expect(vi.mocked(apiModule.apiFetch)).toHaveBeenCalledWith(
      `/api/admin/directory/integrations/${integrationId}/accounts/${accountId}/deprovision-policy`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ policy: ['mark_inactive', 'disable_dingtalk_auth'] }),
      }),
    )
    unmount()
  })

  it('applies member deprovision presets and disables inherit mode', async () => {
    const { container, unmount } = mountDirectoryManagement()
    await flushAll()

    const detail = container.querySelector('.directory-admin__detail') as HTMLElement | null
    expect(detail).not.toBeNull()
    if (!detail) {
      unmount()
      return
    }

    const presetButton = Array.from(detail.querySelectorAll('.directory-admin__preset')).find((button) => button.textContent?.includes('全部执行')) as HTMLButtonElement | undefined
    const savePolicyButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('保存离职策略'))

    expect(presetButton).toBeDefined()
    expect(savePolicyButton).toBeDefined()

    presetButton?.click()
    await flushAll()
    savePolicyButton?.click()
    await flushAll()

    expect(vi.mocked(apiModule.apiFetch)).toHaveBeenCalledWith(
      `/api/admin/directory/integrations/${integrationId}/accounts/${accountId}/deprovision-policy`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ policy: ['mark_inactive', 'disable_dingtalk_auth', 'disable_local_user'] }),
      }),
    )
    unmount()
  })
})
