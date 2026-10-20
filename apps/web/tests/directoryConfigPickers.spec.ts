import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import DirectoryManagementView from '../src/views/DirectoryManagementView.vue'
import {
  NON_ADMISSION_CONTROLLED_NAMESPACES,
  buildMemberGroupNamespaceOptions,
  buildMemberGroupRoleOptions,
  isRoleRejectedAsMemberGroupDefault,
} from '../src/views/directoryConfigPickerOptions'

const apiFetchMock = vi.fn()

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

type JsonResponse = { ok: boolean; status: number; json: () => Promise<unknown> }

function json(payload: unknown, status = 200): JsonResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => payload }
}

async function flushUi(cycles = 8): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function department(externalDepartmentId: string, name: string, fullPath: string, parent: string | null, orderIndex: number) {
  return {
    id: `dept-row-${externalDepartmentId}`,
    integrationId: 'dir-1',
    provider: 'dingtalk',
    externalDepartmentId,
    parentExternalDepartmentId: parent,
    name,
    fullPath,
    orderIndex,
    isActive: true,
    lastSeenAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    accountCount: 2,
    linkedAccountCount: 2,
    childCount: 0,
  }
}

const DEPARTMENTS = [
  department('1', '钉钉', '钉钉', null, 1),
  department('2', '技术部', '钉钉 / 技术部', '1', 2),
  department('3', '财务部', '钉钉 / 财务部', '1', 3),
]

const ROLE_CATALOG = [
  { id: 'admin', name: 'admin', permissions: ['*:*'] },
  { id: 'attendance_admin', name: 'Attendance Admin', permissions: ['attendance:admin'] },
  { id: 'attendance_employee', name: 'Attendance Employee', permissions: ['attendance:read', 'attendance:write'] },
  { id: 'crm_user', name: '销售人员', permissions: ['crm:read', 'multitable:read', 'approvals:read'] },
  { id: 'stock-prep_frontline', name: '操作人员', permissions: ['stock-prep:read', 'stock-prep:operate'] },
  { id: 'workflow_admin', name: 'Workflow Admin', permissions: ['workflow:admin'] },
]

function createIntegration(configOverrides: Record<string, unknown> = {}) {
  return {
    id: 'dir-1',
    name: 'DingTalk CN',
    corpId: 'dingcorp',
    status: 'active',
    syncEnabled: true,
    scheduleCron: '*/30 * * * *',
    defaultDeprovisionPolicy: 'mark_inactive',
    lastSyncAt: '2026-10-01T00:00:00.000Z',
    lastSuccessAt: '2026-10-01T00:00:00.000Z',
    lastError: null,
    config: {
      appKey: 'ding-app-key',
      appSecretConfigured: true,
      rootDepartmentId: '1',
      baseUrl: null,
      pageSize: 50,
      admissionMode: 'auto_for_scoped_departments',
      admissionDepartmentIds: [],
      excludeDepartmentIds: [],
      memberGroupSyncMode: 'sync_scoped_departments',
      memberGroupDepartmentIds: [],
      memberGroupDefaultRoleIds: [],
      memberGroupDefaultNamespaces: [],
      ...configOverrides,
    },
    stats: { departmentCount: 3, accountCount: 6, pendingLinkCount: 0, linkedCount: 6, lastRunStatus: 'completed' },
  }
}

function installApi(integration: ReturnType<typeof createIntegration>, options: { departments?: unknown[] } = {}) {
  const departments = options.departments ?? DEPARTMENTS
  apiFetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET'
    if (url === '/api/admin/directory/integrations' && method === 'GET') {
      return json({ ok: true, data: { items: [integration] } })
    }
    if (url === `/api/admin/directory/integrations/${integration.id}` && method === 'PUT') {
      return json({ ok: true, data: { integration } })
    }
    if (url === `/api/admin/directory/integrations/${integration.id}/departments`) {
      return json({ ok: true, data: { items: departments, total: departments.length } })
    }
    if (url === '/api/admin/roles') {
      return json({ ok: true, data: { items: ROLE_CATALOG, total: ROLE_CATALOG.length } })
    }
    if (url.includes('/schedule')) return json({ ok: true, data: { snapshot: null } })
    if (url.includes('/accounts')) return json({ ok: true, data: { items: [], total: 0, page: 1, pageSize: 25 } })
    return json({ ok: true, data: { items: [], total: 0 } })
  })
}

function readSavedPayload(): Record<string, unknown> {
  const call = apiFetchMock.mock.calls.find(([url, init]) => (
    url === '/api/admin/directory/integrations/dir-1' && (init as { method?: string } | undefined)?.method === 'PUT'
  ))
  expect(call).toBeTruthy()
  return JSON.parse(String((call![1] as { body: string }).body)) as Record<string, unknown>
}

function countCalls(url: string): number {
  return apiFetchMock.mock.calls.filter(([calledUrl]) => calledUrl === url).length
}

describe('directory config pickers', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    apiFetchMock.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    window.history.replaceState({}, '', '/')
    app = null
    container = null
  })

  async function mount(): Promise<HTMLDivElement> {
    app = createApp(DirectoryManagementView)
    app.component('RouterLink', { props: { to: { type: [String, Object], default: '' } }, template: '<a><slot /></a>' })
    app.mount(container!)
    await flushUi()
    return container!
  }

  function picker(root: HTMLElement, testId: string): HTMLElement {
    const element = root.querySelector(`[data-testid="${testId}"]`)
    expect(element).toBeTruthy()
    return element as HTMLElement
  }

  async function openPicker(root: HTMLElement, testId: string): Promise<HTMLElement> {
    const element = picker(root, testId)
    const toggle = element.querySelector('.directory-picker__toggle') as HTMLButtonElement
    toggle.click()
    await flushUi()
    return element
  }

  function chipValues(element: HTMLElement): string[] {
    return Array.from(element.querySelectorAll('.directory-picker__chip')).map((chip) => chip.getAttribute('data-value') ?? '')
  }

  function chipTexts(element: HTMLElement): string[] {
    return Array.from(element.querySelectorAll('.directory-picker__chip-label')).map((chip) => chip.textContent?.trim() ?? '')
  }

  function optionValues(element: HTMLElement): string[] {
    return Array.from(element.querySelectorAll('.directory-picker__option')).map((option) => option.getAttribute('data-value') ?? '')
  }

  async function checkOption(element: HTMLElement, value: string): Promise<void> {
    const input = element.querySelector(`.directory-picker__option[data-value="${value}"] input`) as HTMLInputElement | null
    expect(input).toBeTruthy()
    input!.checked = !input!.checked
    input!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
  }

  async function search(element: HTMLElement, query: string): Promise<void> {
    const input = element.querySelector('.directory-picker__search') as HTMLInputElement
    input.value = query
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
  }

  function button(root: HTMLElement, text: string): HTMLButtonElement {
    const found = Array.from(root.querySelectorAll('button')).find((candidate) => candidate.textContent?.trim() === text)
    expect(found, text).toBeTruthy()
    return found as HTMLButtonElement
  }

  async function save(root: HTMLElement): Promise<Record<string, unknown>> {
    button(root, '保存变更').click()
    await flushUi()
    return readSavedPayload()
  }

  it('loads, then saves an untouched existing config with the exact pre-picker payload', async () => {
    installApi(createIntegration({
      rootDepartmentId: '2',
      admissionDepartmentIds: ['2', 'gone-dept'],
      excludeDepartmentIds: ['3'],
      memberGroupDepartmentIds: ['2'],
      memberGroupDefaultRoleIds: ['crm_user', 'retired_role'],
      memberGroupDefaultNamespaces: ['crm', 'legacy-plugin'],
    }))
    const root = await mount()
    // Open every picker so departments and the role catalog are loaded and rendered.
    await openPicker(root, 'directory-admission-department-picker')
    await openPicker(root, 'directory-member-group-role-picker')
    await openPicker(root, 'directory-member-group-namespace-picker')

    expect(await save(root)).toEqual({
      integrationId: 'dir-1',
      name: 'DingTalk CN',
      corpId: 'dingcorp',
      appKey: 'ding-app-key',
      appSecret: '',
      rootDepartmentId: '2',
      baseUrl: '',
      pageSize: 50,
      admissionMode: 'auto_for_scoped_departments',
      admissionDepartmentIds: ['2', 'gone-dept'],
      excludeDepartmentIds: ['3'],
      memberGroupSyncMode: 'sync_scoped_departments',
      memberGroupDepartmentIds: ['2'],
      memberGroupDefaultRoleIds: ['crm_user', 'retired_role'],
      memberGroupDefaultNamespaces: ['crm', 'legacy-plugin'],
      status: 'active',
      scheduleCron: '*/30 * * * *',
      defaultDeprovisionPolicy: 'mark_inactive',
      syncEnabled: true,
    })
  })

  it('writes department ids picked by name and keeps unknown ids as removable chips', async () => {
    installApi(createIntegration({ admissionDepartmentIds: ['gone-dept'] }))
    const root = await mount()
    expect(countCalls('/api/admin/directory/integrations/dir-1/departments')).toBe(0)

    const admission = await openPicker(root, 'directory-admission-department-picker')
    expect(countCalls('/api/admin/directory/integrations/dir-1/departments')).toBe(1)
    expect(chipTexts(admission)).toEqual(['未知部门（ID gone-dept）'])

    await search(admission, '技术')
    expect(optionValues(admission)).toEqual(['2'])
    expect(admission.querySelector('.directory-picker__option')?.textContent).toContain('钉钉 / 技术部')
    await checkOption(admission, '2')
    expect(chipValues(admission)).toEqual(['gone-dept', '2'])
    expect(chipTexts(admission)).toEqual(['未知部门（ID gone-dept）', '技术部'])

    const exclude = await openPicker(root, 'directory-exclude-department-picker')
    await search(exclude, '钉钉 / 财务')
    await checkOption(exclude, '3')

    const memberGroup = await openPicker(root, 'directory-member-group-department-picker')
    await checkOption(memberGroup, '2')
    await checkOption(memberGroup, '3')
    await checkOption(memberGroup, '2')

    const payload = await save(root)
    expect(payload.admissionDepartmentIds).toEqual(['gone-dept', '2'])
    expect(payload.excludeDepartmentIds).toEqual(['3'])
    expect(payload.memberGroupDepartmentIds).toEqual(['3'])
  })

  it('removes an unknown id only when its chip is removed', async () => {
    installApi(createIntegration({ admissionDepartmentIds: ['gone-dept', '2'] }))
    const root = await mount()
    const admission = await openPicker(root, 'directory-admission-department-picker')
    const removeButtons = Array.from(admission.querySelectorAll('.directory-picker__chip-remove')) as HTMLButtonElement[]
    expect(removeButtons).toHaveLength(2)
    removeButtons[1].click()
    await flushUi()
    expect(chipValues(admission)).toEqual(['gone-dept'])
    expect((await save(root)).admissionDepartmentIds).toEqual(['gone-dept'])
  })

  it('tells the admin to sync first when no departments are mirrored, and keeps the manual-ID fallback', async () => {
    installApi(createIntegration(), { departments: [] })
    const root = await mount()
    const admission = await openPicker(root, 'directory-admission-department-picker')
    expect(admission.textContent).toContain('请先同步一次目录以加载部门')

    const fallback = admission.parentElement!.querySelector('details') as HTMLDetailsElement
    expect(fallback.open).toBe(false)
    expect(fallback.querySelector('summary')?.textContent).toContain('高级：手动填写 ID')
    const textarea = fallback.querySelector('textarea') as HTMLTextAreaElement
    textarea.value = 'typed-1, typed-2'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    expect(chipValues(admission)).toEqual(['typed-1', 'typed-2'])
    expect((await save(root)).admissionDepartmentIds).toEqual(['typed-1', 'typed-2'])
  })

  it('offers only roles and namespaces the backend accepts', async () => {
    installApi(createIntegration({
      memberGroupDefaultRoleIds: ['retired_role', 'attendance_admin'],
      memberGroupDefaultNamespaces: ['legacy-plugin'],
    }))
    const root = await mount()
    expect(countCalls('/api/admin/roles')).toBe(0)

    const roles = await openPicker(root, 'directory-member-group-role-picker')
    expect(countCalls('/api/admin/roles')).toBe(1)
    expect(optionValues(roles)).toEqual(['attendance_employee', 'crm_user', 'stock-prep_frontline'])
    expect(optionValues(roles)).not.toContain('admin')
    expect(optionValues(roles)).not.toContain('attendance_admin')
    expect(roles.querySelector('.directory-picker__option[data-value="attendance_employee"]')?.textContent).toContain('考勤员工')
    expect(chipTexts(roles)).toEqual(['已删除的角色（retired_role）', '考勤管理员（attendance_admin，不可作为默认角色，保存会被拒绝）'])
    await checkOption(roles, 'crm_user')

    const namespaces = await openPicker(root, 'directory-member-group-namespace-picker')
    expect(countCalls('/api/admin/roles')).toBe(1)
    expect(optionValues(namespaces)).toEqual(['attendance', 'crm', 'stock-prep'])
    for (const rejected of ['multitable', 'approvals', 'workflow', '*']) {
      expect(optionValues(namespaces)).not.toContain(rejected)
    }
    expect(namespaces.querySelector('.directory-picker__option[data-value="stock-prep"]')?.textContent).toContain('备料')
    expect(chipTexts(namespaces)).toEqual(['未知插件（legacy-plugin）'])
    await checkOption(namespaces, 'stock-prep')

    const payload = await save(root)
    expect(payload.memberGroupDefaultRoleIds).toEqual(['retired_role', 'attendance_admin', 'crm_user'])
    expect(payload.memberGroupDefaultNamespaces).toEqual(['legacy-plugin', 'stock-prep'])
  })

  it('keeps saved roles as-is when the role catalog fails to load, and retries on reopen', async () => {
    installApi(createIntegration({ memberGroupDefaultRoleIds: ['crm_user'] }))
    const fallthrough = apiFetchMock.getMockImplementation()!
    let failRoles = true
    apiFetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === '/api/admin/roles' && failRoles) return json({ ok: false, error: { message: 'boom' } }, 500)
      return fallthrough(url, init)
    })
    const root = await mount()
    const roles = await openPicker(root, 'directory-member-group-role-picker')
    expect(roles.textContent).toContain('加载角色列表失败')
    expect(chipTexts(roles)).toEqual(['crm_user'])
    expect(roles.querySelector('.directory-picker__chip--unknown')).toBeNull()

    failRoles = false
    const toggle = roles.querySelector('.directory-picker__toggle') as HTMLButtonElement
    toggle.click()
    await flushUi()
    toggle.click()
    await flushUi()
    expect(countCalls('/api/admin/roles')).toBe(2)
    expect(chipTexts(roles)).toEqual(['销售人员'])
    expect((await save(root)).memberGroupDefaultRoleIds).toEqual(['crm_user'])
  })

  it('does not call saved departments unknown when the department load fails', async () => {
    installApi(createIntegration({ admissionDepartmentIds: ['2'] }))
    const fallthrough = apiFetchMock.getMockImplementation()!
    apiFetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url.endsWith('/departments')) return json({ ok: false, error: { message: 'boom' } }, 500)
      return fallthrough(url, init)
    })
    const root = await mount()
    const admission = await openPicker(root, 'directory-admission-department-picker')
    expect(admission.textContent).toContain('加载部门失败')
    expect(chipTexts(admission)).toEqual(['2'])
    expect(admission.querySelector('.directory-picker__chip--unknown')).toBeNull()
    expect((await save(root)).admissionDepartmentIds).toEqual(['2'])
  })

  it('candidate helpers mirror the backend role and namespace rules', () => {
    const roleIds = buildMemberGroupRoleOptions(ROLE_CATALOG).map((option) => option.value)
    expect(roleIds.some(isRoleRejectedAsMemberGroupDefault)).toBe(false)
    expect(isRoleRejectedAsMemberGroupDefault('admin')).toBe(true)
    expect(isRoleRejectedAsMemberGroupDefault('crm_admin')).toBe(true)
    expect(isRoleRejectedAsMemberGroupDefault('crm_user')).toBe(false)
    const namespaces = buildMemberGroupNamespaceOptions(ROLE_CATALOG).map((option) => option.value)
    expect(namespaces.filter((namespace) => NON_ADMISSION_CONTROLLED_NAMESPACES.has(namespace))).toEqual([])
    expect(NON_ADMISSION_CONTROLLED_NAMESPACES.has('multitable')).toBe(true)
  })

  it('previews visible departments by name and keeps bulk add working on the same draft', async () => {
    installApi(createIntegration({ admissionDepartmentIds: ['gone-dept'] }))
    const root = await mount()
    button(root, '加载组织架构').click()
    await flushUi()

    const searchInput = Array.from(root.querySelectorAll('input'))
      .find((input) => input.getAttribute('placeholder')?.includes('部门名')) as HTMLInputElement
    searchInput.value = '钉钉 /'
    searchInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    expect(root.textContent).toContain('当前可见部门预览')
    expect(root.textContent).not.toContain('当前可见部门 ID 预览')
    const preview = root.querySelector('.directory-admin__visible-department-preview') as HTMLTextAreaElement
    expect(preview.value).toBe('技术部 · 钉钉 / 技术部\n财务部 · 钉钉 / 财务部')

    button(root, '批量加入当前可见到准入白名单').click()
    await flushUi()
    expect(chipValues(picker(root, 'directory-admission-department-picker'))).toEqual(['gone-dept', '2', '3'])
    button(root, '批量加入当前可见到成员组同步').click()
    await flushUi()
    expect((await save(root)).admissionDepartmentIds).toEqual(['gone-dept', '2', '3'])
    expect(readSavedPayload().memberGroupDepartmentIds).toEqual(['2', '3'])
  })

  it('adds a department picked in the manual area to each target, and the collapsed fallback still takes a typed id', async () => {
    installApi(createIntegration())
    const root = await mount()
    const manual = await openPicker(root, 'directory-manual-department-picker')
    const admitPicked = button(root, '将所选部门加入准入白名单')
    expect(admitPicked.disabled).toBe(true)

    await search(manual, '财务')
    await checkOption(manual, '3')
    expect(chipTexts(manual)).toEqual(['财务部'])
    admitPicked.click()
    button(root, '将所选部门加入排除部门').click()
    await flushUi()
    await search(manual, '技术部')
    await checkOption(manual, '2')
    expect(chipValues(manual)).toEqual(['2'])
    button(root, '将所选部门加入成员组同步').click()
    await flushUi()

    const fallback = root.querySelector('[data-testid="directory-manual-department-fallback"]') as HTMLDetailsElement
    expect(fallback.open).toBe(false)
    expect(fallback.querySelector('summary')?.textContent).toContain('高级：部门尚未同步时手动填写 ID')
    const idInput = fallback.querySelector('input[placeholder="例如 123456"]') as HTMLInputElement
    idInput.value = 'not-yet-synced'
    idInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    button(root, '手动加入准入白名单').click()
    await flushUi()

    const payload = await save(root)
    expect(payload.admissionDepartmentIds).toEqual(['3', 'not-yet-synced'])
    expect(payload.excludeDepartmentIds).toEqual(['3'])
    expect(payload.memberGroupDepartmentIds).toEqual(['2'])
  })

  it('keeps the root-department input with a first-sync hint until departments are loaded', async () => {
    installApi(createIntegration(), { departments: [] })
    const root = await mount()
    const field = picker(root, 'directory-root-department-field')
    expect(field.querySelector('select')).toBeNull()
    expect(field.querySelector('input[placeholder="默认 1"]')).toBeTruthy()
    expect(field.textContent).toContain('首次同步前请保持默认 1（全公司）或填写已知部门 ID')
    button(root, '从已同步部门中选择').click()
    await flushUi()
    expect(picker(root, 'directory-root-department-field').querySelector('select')).toBeNull()
    expect((await save(root)).rootDepartmentId).toBe('1')
  })

  it('lets the admin pick the root department by name once the tree is loaded', async () => {
    installApi(createIntegration({ rootDepartmentId: 'old-root' }))
    const root = await mount()
    button(root, '从已同步部门中选择').click()
    await flushUi()
    const select = root.querySelector('[data-testid="directory-root-department-select"]') as HTMLSelectElement
    expect(select).toBeTruthy()
    const optionTexts = Array.from(select.options).map((option) => option.textContent?.trim())
    expect(optionTexts).toEqual(['未知部门（ID old-root）', '钉钉', '钉钉 / 技术部', '钉钉 / 财务部'])
    expect(select.value).toBe('old-root')
    expect(root.querySelector('[data-testid="directory-root-department-hint"]')).toBeNull()

    select.value = '2'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    expect((await save(root)).rootDepartmentId).toBe('2')
  })

  it('can widen a too-narrow root back to 全公司 or a typed id even though the mirror never held them', async () => {
    // Synced from root 2, so department 1 never entered the mirror.
    installApi(createIntegration({ rootDepartmentId: '2' }), {
      departments: [
        department('2', '技术部', '技术部', null, 1),
        department('5', '前端组', '技术部 / 前端组', '2', 2),
      ],
    })
    const root = await mount()
    button(root, '从已同步部门中选择').click()
    await flushUi()
    const select = root.querySelector('[data-testid="directory-root-department-select"]') as HTMLSelectElement
    expect(Array.from(select.options).map((option) => option.textContent?.trim())).toEqual(['全公司（ID 1）', '技术部', '技术部 / 前端组'])
    select.value = '1'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    expect((await save(root)).rootDepartmentId).toBe('1')

    const manual = root.querySelector('[data-testid="directory-root-department-manual"]') as HTMLDetailsElement
    expect(manual.open).toBe(false)
    expect(manual.querySelector('summary')?.textContent).toContain('高级：手动填写 ID')
    const input = manual.querySelector('input') as HTMLInputElement
    input.value = 'corp-wide-9'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    const refreshedSelect = root.querySelector('[data-testid="directory-root-department-select"]') as HTMLSelectElement
    expect(refreshedSelect.value).toBe('corp-wide-9')
    expect(Array.from(refreshedSelect.options).map((option) => option.textContent?.trim())).toContain('未知部门（ID corp-wide-9）')
    apiFetchMock.mockClear()
    expect((await save(root)).rootDepartmentId).toBe('corp-wide-9')
  })

  it('drops a late department response for the previous integration and loads the new one', async () => {
    const integrationA = createIntegration()
    const integrationB = { ...createIntegration({ admissionDepartmentIds: ['2'] }), id: 'dir-2', name: 'DingTalk B', corpId: 'dingcorp-b' }
    let releaseA: () => void = () => undefined
    const pendingA = new Promise<void>((resolve) => { releaseA = resolve })
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/admin/directory/integrations') return json({ ok: true, data: { items: [integrationA, integrationB] } })
      if (url === '/api/admin/directory/integrations/dir-1/departments') {
        await pendingA
        return json({ ok: true, data: { items: DEPARTMENTS, total: DEPARTMENTS.length } })
      }
      if (url === '/api/admin/directory/integrations/dir-2/departments') {
        return json({ ok: true, data: { items: [department('2', 'B 研发部', 'B 公司 / B 研发部', null, 1)], total: 1 } })
      }
      if (url.includes('/schedule')) return json({ ok: true, data: { snapshot: null } })
      return json({ ok: true, data: { items: [], total: 0, page: 1, pageSize: 25 } })
    })
    const root = await mount()
    const admission = await openPicker(root, 'directory-admission-department-picker')
    expect(countCalls('/api/admin/directory/integrations/dir-1/departments')).toBe(1)
    expect(admission.textContent).toContain('加载中...')

    const switchToB = Array.from(root.querySelectorAll('.directory-admin__item'))
      .find((item) => item.textContent?.includes('DingTalk B')) as HTMLButtonElement
    switchToB.click()
    await flushUi()
    // The still-open picker asks for B's departments by itself.
    expect(countCalls('/api/admin/directory/integrations/dir-2/departments')).toBe(1)

    releaseA()
    await flushUi()
    const pickerAfter = picker(root, 'directory-admission-department-picker')
    expect(optionValues(pickerAfter)).toEqual(['2'])
    expect(chipTexts(pickerAfter)).toEqual(['B 研发部'])
    expect(root.textContent).not.toContain('钉钉 / 财务部')
  })

  it('keeps the tree, the open picker and the root select on screen across a save, reloading in place', async () => {
    let departmentCalls = 0
    let releaseReload: () => void = () => undefined
    installApi(createIntegration({ admissionDepartmentIds: ['2'] }))
    const fallthrough = apiFetchMock.getMockImplementation()!
    apiFetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url.endsWith('/departments')) {
        departmentCalls += 1
        if (departmentCalls === 2) await new Promise<void>((resolve) => { releaseReload = resolve })
      }
      return fallthrough(url, init)
    })
    const root = await mount()
    const admission = await openPicker(root, 'directory-admission-department-picker')
    expect(optionValues(admission)).toEqual(['1', '2', '3'])
    expect(root.querySelector('[data-testid="directory-root-department-select"]')).toBeTruthy()

    button(root, '保存变更').click()
    await flushUi()
    expect(departmentCalls).toBe(2)
    // Reload still in flight: nothing flips back to the loading text or the root text box.
    expect(root.querySelector('[data-testid="directory-root-department-select"]')).toBeTruthy()
    expect(admission.textContent).not.toMatch(/正在加载已同步的部门|加载中/)
    expect(optionValues(admission)).toEqual(['1', '2', '3'])

    releaseReload()
    await flushUi()
    expect(optionValues(admission)).toEqual(['1', '2', '3'])
    expect(chipTexts(admission)).toEqual(['技术部'])
  })

  it('retries a failed department load when the picker is reopened', async () => {
    let departmentCalls = 0
    installApi(createIntegration())
    const fallthrough = apiFetchMock.getMockImplementation()!
    apiFetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url.endsWith('/departments')) {
        departmentCalls += 1
        if (departmentCalls === 1) return json({ ok: false, error: { message: 'boom' } }, 500)
      }
      return fallthrough(url, init)
    })
    const root = await mount()
    const admission = await openPicker(root, 'directory-admission-department-picker')
    expect(admission.textContent).toContain('加载部门失败')
    expect(departmentCalls).toBe(1)

    const toggle = admission.querySelector('.directory-picker__toggle') as HTMLButtonElement
    toggle.click()
    await flushUi()
    toggle.click()
    await flushUi()
    expect(departmentCalls).toBe(2)
    expect(admission.textContent).not.toContain('加载部门失败')
    expect(optionValues(admission)).toEqual(['1', '2', '3'])
  })
})
