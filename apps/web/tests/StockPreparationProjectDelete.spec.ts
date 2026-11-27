import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'

const mock = vi.hoisted(() => ({ apiFetch: vi.fn(), replace: vi.fn(), query: {} as Record<string, string>, admin: true }))

vi.mock('../src/utils/api', async (original) => ({
  ...await original<typeof import('../src/utils/api')>(),
  apiFetch: mock.apiFetch,
}))
vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getToken: () => 'synthetic-session',
    getAccessSnapshot: () => ({ roles: ['admin'], permissions: [], isAdmin: true, email: '' }),
    hasAdminAccess: () => mock.admin,
    hasPermission: () => false,
  }),
}))
vi.mock('../src/composables/useLocale', () => ({ useLocale: () => ({ locale: ref('zh-CN') }) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: mock.query }), useRouter: () => ({ push: vi.fn(), replace: mock.replace }) }))

import StockPreparationProjectBoardView from '../src/components/integration/stockPreparation/StockPreparationProjectBoardView.vue'
import StockPreparationProjectDelete from '../src/components/integration/stockPreparation/StockPreparationProjectDelete.vue'
import StockPreparationWorkspace from '../src/components/integration/stockPreparation/StockPreparationWorkspace.vue'
import { readStockPrepRecentProjects, recordStockPrepProjectVisit } from '../src/services/integration/stockPreparation/operatorHomeMemory'
import { resetStockPreparationOperatorHomeDirectoryThrottle } from '../src/services/integration/stockPreparation/operatorHomeDirectory'

const PROJECT = 'SYN-DELETE-01'
const NEIGHBOR = 'SYN-KEEP-02'
const scope = { tenantId: 'synthetic-tenant' }
const CODE = 'C0DE0071'
const NEW_CODE = 'A0B0123F'
const ACTION_BASE = `/api/integration/stock-preparation/projects/${PROJECT}/delete`
const ID_PREFIX = 'stock-prep-project-delete-'
const impact = {
  ...scope,
  projectNo: PROJECT,
  tables: [
    { sheetId: 'synthetic-dedicated', name: '合成专属表', kind: 'dedicated', rowCount: 3 },
    { sheetId: 'synthetic-shared', name: '合成共享表', kind: 'shared', rowCount: 1 },
  ],
  counts: { pullBatches: 2, preparationLines: 3, exceptions: 1, confirmationDecisions: 1 },
}

function preview(verificationCode = CODE, challengeId = 'synthetic-first-challenge') {
  return ok({ ...impact, verificationCode, challengeId, expiresAt: new Date(Date.now() + 50_000).toISOString() })
}

function ok(data: unknown) {
  return new Response(JSON.stringify({ ok: true, data }))
}

function failure(status: number, code: string) {
  return new Response(JSON.stringify({ ok: false, error: { code, message: 'SYNTHETIC_NOT_FOR_DISPLAY' } }), { status })
}

function deferredResponse() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((done) => { resolve = done })
  return { promise, resolve }
}

type Fixture = {
  allowed?: boolean
  preview?: () => Response | Promise<Response>
  confirm?: () => Response | Promise<Response>
  state?: 'pulled-only' | 'registered-only' | 'pulled-and-registered'
}

function mockRoutes(fixture: Fixture = {}) {
  let deleted = false
  const state = fixture.state ?? 'pulled-and-registered'
  mock.apiFetch.mockImplementation(async (path: string) => {
    const pathname = path.split('?')[0]
    if (pathname.endsWith('/project-delete/access')) return ok({ mayDelete: fixture.allowed ?? true })
    if (pathname === `${ACTION_BASE}/preview`) return fixture.preview?.() ?? preview()
    if (pathname === `${ACTION_BASE}/confirm`) {
      if (fixture.confirm) {
        const result = await fixture.confirm()
        deleted = result.ok
        return result
      }
      deleted = true
      return ok({ ...scope, projectNo: PROJECT, counts: impact.counts, auditId: 'synthetic-audit-id' })
    }
    if (pathname.endsWith('/operator/projects')) {
      const projects = [{ projectNo: NEIGHBOR, projectName: '保留示例', pendingDecisionCount: 0 }]
      if (!deleted) projects.push({ projectNo: PROJECT, projectName: '删除示例', pendingDecisionCount: 0 })
      return ok({ ...scope, directoryReady: true, ledgerReady: true, projectCount: projects.length, pendingProjectCount: 0, projects })
    }
    if (pathname.endsWith('/project-targets')) return ok({ count: 0, limit: 200, items: [] })
    if (pathname.endsWith('/target')) {
      if (state === 'pulled-only') return failure(404, 'STOCK_PREPARATION_PROJECT_SHEETS_DISABLED')
      return ok({ status: 'active', sheetId: 'synthetic-dedicated', viewId: 'synthetic-fill', todoViewId: 'synthetic-todo',
        may: { create: false, archive: true, restore: false } })
    }
    if (pathname.endsWith('/board') && state !== 'registered-only') {
      return ok({ ...scope, projectNo: pathname.split('/').at(-2), pulledRowCount: 2, pullTargetReady: true, pendingDecisionCount: 0 })
    }
    return failure(404, 'STOCK_PREPARATION_PROJECT_BOARD_NOT_FOUND')
  })
}

let app: App | undefined
let root: HTMLDivElement

function mount(children: () => ReturnType<typeof h>): void {
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp({ render: children })
  app.mount(root)
}

function find<T extends HTMLElement = HTMLElement>(suffix: string): T | null {
  return root.querySelector<T>(`[data-testid="${ID_PREFIX}${suffix}"]`)
}

function callsFor(suffix: string) {
  return mock.apiFetch.mock.calls.filter(([path]) => String(path).split('?')[0].endsWith(suffix))
}

async function click(suffix: string) {
  const button = find<HTMLButtonElement>(suffix)
  expect(button).not.toBeNull()
  button!.click()
  await nextTick()
}

async function typeCode(value: string) {
  const input = find<HTMLInputElement>('code-input')!
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

beforeEach(() => {
  mock.apiFetch.mockReset()
  mock.replace.mockReset()
  mock.query = {}
  mock.admin = true
  resetStockPreparationOperatorHomeDirectoryThrottle()
  localStorage.clear()
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false } },
  })
})

afterEach(() => {
  app?.unmount()
  root?.remove()
})

describe('备料项目交付清理工作台', () => {
  it('requires both live platform administration and the stock-prep access grant', async () => {
    mock.admin = false
    mockRoutes()
    mount(() => h(StockPreparationProjectDelete, { projectNo: PROJECT }))
    await nextTick()
    expect(find('open')).toBeNull()
    expect(mock.apiFetch.mock.calls).toEqual([])

    app?.unmount()
    root.remove()
    mock.admin = true
    mockRoutes({ allowed: false })
    mount(() => h(StockPreparationProjectDelete, { projectNo: PROJECT }))
    await vi.waitFor(() => expect(callsFor('/project-delete/access')).toHaveLength(1))
    expect(find('open')).toBeNull()
    expect(callsFor('/delete/preview')).toEqual([])
  })

  it.each(['pulled-only', 'registered-only', 'pulled-and-registered'] as const)('previews the opened project from the board (%s)', async (state) => {
    mockRoutes({ state })
    mount(() => h(StockPreparationProjectBoardView, { scope, projectNo: PROJECT }))
    await vi.waitFor(() => expect(find<HTMLButtonElement>('open')?.disabled).toBe(false))
    await click('open')
    await vi.waitFor(() => expect(find('code')?.textContent).toBe(CODE))
    const content = find('dialog')!.textContent
    for (const text of [scope.tenantId, PROJECT, '合成专属表', '合成共享表', '删除整表', '仅删除本项目行', '手工试填和正式备料数据', '确认记录']) {
      expect(content).toContain(text)
    }
    expect(callsFor('/delete/preview')).toEqual([[`${ACTION_BASE}/preview`, {
      method: 'POST', body: '{}', cache: 'no-store', suppressUnauthorizedRedirect: true,
    }]])
    await typeCode('C0DE0072')
    expect(find<HTMLButtonElement>('confirm')?.disabled).toBe(true)
    find('dialog')?.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(callsFor('/delete/confirm')).toEqual([])
  })

  it.each([
    ['STALE', '预览后数据已变更'],
    ['BUSY', '项目正在处理'],
    ['AMBIGUOUS', '记录归属不明确'],
    ['DEPENDENCY', '关联资料或订阅受到保护'],
    ['CHALLENGE_INVALID', '验证码已失效'],
  ])('discards the previous challenge after %s and requires a new preview', async (code, message) => {
    mockRoutes({
      preview: vi.fn().mockImplementationOnce(() => preview()).mockImplementation(() => preview(NEW_CODE, 'synthetic-second-challenge')),
      confirm: () => failure(409, `STOCK_PREPARATION_PROJECT_DELETE_${code}`),
    })
    mount(() => h(StockPreparationProjectDelete, { projectNo: PROJECT }))
    await vi.waitFor(() => expect(find('open')).not.toBeNull())
    await click('open')
    await vi.waitFor(() => expect(find('code')?.textContent).toBe(CODE))
    await typeCode(CODE)
    await click('confirm')
    await vi.waitFor(() => expect(find('error')?.textContent).toContain(message))
    expect(find('error')?.textContent).not.toContain('SYNTHETIC_NOT_FOR_DISPLAY')
    expect(find('code')).toBeNull()
    expect(find('confirm')).toBeNull()
    await click('repreview')
    await vi.waitFor(() => expect(find('code')?.textContent).toBe(NEW_CODE))
    expect(find<HTMLInputElement>('code-input')?.value).toBe('')
    await typeCode(CODE)
    expect(find<HTMLButtonElement>('confirm')?.disabled).toBe(true)
    expect(callsFor('/delete/confirm')).toHaveLength(1)
  })

  it('fails closed on a preview for the wrong project or with an expired code', async () => {
    mockRoutes({ preview: vi.fn()
      .mockImplementationOnce(() => ok({ ...impact, projectNo: NEIGHBOR, verificationCode: CODE, challengeId: 'synthetic-other', expiresAt: new Date(Date.now() + 30_000).toISOString() }))
      .mockImplementation(() => ok({ ...impact, verificationCode: CODE, challengeId: 'synthetic-expired', expiresAt: new Date(0).toISOString() })) })
    mount(() => h(StockPreparationProjectDelete, { projectNo: PROJECT }))
    await vi.waitFor(() => expect(find('open')).not.toBeNull())
    await click('open')
    await vi.waitFor(() => expect(find('error')?.textContent).toContain('读取影响范围失败'))
    await click('repreview')
    await vi.waitFor(() => expect(find('error')?.textContent).toContain('验证码已过期'))
    expect(find('code')).toBeNull()
    expect(callsFor('/delete/confirm')).toEqual([])
  })

  it('sends only the challenge and typed code, clears stale project links and rereads the home directory and overview registry', async () => {
    const projectNo = ref('')
    const deleted = vi.fn()
    mockRoutes()
    recordStockPrepProjectVisit(NEIGHBOR, 'ready', scope)
    recordStockPrepProjectVisit(PROJECT, 'ready', scope)
    mount(() => h(StockPreparationProjectBoardView, {
      scope,
      projectNo: projectNo.value,
      onSelectProjectNo: (number: string) => { projectNo.value = number },
      onProjectDeleted: deleted,
    }))
    await vi.waitFor(() => expect(root.querySelector('datalist')?.textContent).toContain('删除示例'))
    projectNo.value = PROJECT
    await vi.waitFor(() => expect(find<HTMLButtonElement>('open')?.disabled).toBe(false))
    await click('open')
    await vi.waitFor(() => expect(find('code')?.textContent).toBe(CODE))
    await typeCode(CODE)
    await click('confirm')
    await vi.waitFor(() => expect(find('success')?.textContent).toContain('项目及全部备料数据已删除'))
    await vi.waitFor(() => expect(root.querySelector('datalist')?.textContent).toContain('保留示例'))
    expect(root.querySelector(`datalist option[value="${PROJECT}"]`)).toBeNull()
    expect(deleted).toHaveBeenCalledTimes(1)
    expect(projectNo.value).toBe('')
    expect(readStockPrepRecentProjects(scope).map((entry) => entry.projectNo)).toEqual([NEIGHBOR])
    expect(callsFor('/delete/confirm')).toEqual([[`${ACTION_BASE}/confirm`, {
      method: 'POST', body: JSON.stringify({ challengeId: 'synthetic-first-challenge', code: CODE }), cache: 'no-store',
      suppressUnauthorizedRedirect: true,
    }]])
    expect(callsFor('/operator/projects').filter(([path]) => String(path).includes('includePullTargets=1'))).toHaveLength(2)
    expect(callsFor('/project-targets')).toHaveLength(2)
    expect(mock.apiFetch.mock.calls.filter(([, init]) => init?.method === 'POST').map(([path]) => path)).toEqual([
      `${ACTION_BASE}/preview`, `${ACTION_BASE}/confirm`,
    ])
  })

  it('returns a platform administrator from a project deep link to the home directory and selects its sidebar tab', async () => {
    mockRoutes()
    mock.query = { projectNo: PROJECT }
    localStorage.setItem('tenantId', scope.tenantId)
    mount(() => h(StockPreparationWorkspace))
    await vi.waitFor(() => expect(find<HTMLButtonElement>('open')?.disabled).toBe(false))
    await click('open')
    await vi.waitFor(() => expect(find('code')?.textContent).toBe(CODE))
    await typeCode(CODE)
    await click('confirm')
    await vi.waitFor(() => expect(find('success')).not.toBeNull())
    expect(root.querySelector('[data-testid="stock-prep-tab-home"]')?.getAttribute('aria-selected')).toBe('true')
    expect(mock.replace.mock.calls).toEqual([[{ query: {} }]])
  })

  it('discards a late preview after another tab switches the tenant', async () => {
    localStorage.setItem('tenantId', scope.tenantId)
    const pending = deferredResponse()
    mockRoutes({ preview: () => pending.promise })
    mount(() => h(StockPreparationProjectDelete, { projectNo: PROJECT, scope }))
    await vi.waitFor(() => expect(find('open')).not.toBeNull())
    await click('open')
    localStorage.setItem('tenantId', 'synthetic-other-tenant')
    window.dispatchEvent(new StorageEvent('storage', { key: 'tenantId' }))
    await vi.waitFor(() => expect(find('dialog')).toBeNull())
    pending.resolve(preview())
    await vi.waitFor(() => expect(find('code')).toBeNull())
    expect(find('open')).toBeNull()
    expect(callsFor('/delete/confirm')).toEqual([])
  })

  it('revokes the affordance on a denied access recheck and discards an already issued preview', async () => {
    mockRoutes()
    mount(() => h(StockPreparationProjectDelete, { projectNo: PROJECT }))
    await vi.waitFor(() => expect(find('open')).not.toBeNull())
    await click('open')
    await vi.waitFor(() => expect(find('code')?.textContent).toBe(CODE))
    mock.apiFetch.mockResolvedValue(failure(401, 'UNAUTHENTICATED'))
    window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(find('error')?.textContent).toContain('当前无法使用项目删除'))
    expect(find('open')).toBeNull()
    expect(find('code')).toBeNull()
    expect(find('repreview')).toBeNull()
    expect(callsFor('/project-delete/access').at(-1)?.[1]).toEqual({ cache: 'no-store', suppressUnauthorizedRedirect: true })
  })

  it('invalidates the mounted directory when confirmation finishes after switching projects', async () => {
    const pending = deferredResponse()
    const projectNo = ref(PROJECT)
    mockRoutes({ confirm: () => pending.promise })
    recordStockPrepProjectVisit(PROJECT, 'ready', scope)
    mount(() => h(StockPreparationProjectBoardView, { scope, projectNo: projectNo.value }))
    await vi.waitFor(() => expect(find<HTMLButtonElement>('open')?.disabled).toBe(false))
    await click('open')
    await vi.waitFor(() => expect(find('code')?.textContent).toBe(CODE))
    await typeCode(CODE)
    await click('confirm')
    projectNo.value = NEIGHBOR
    await vi.waitFor(() => expect(find<HTMLButtonElement>('open')?.disabled).toBe(false))
    pending.resolve(ok({ ...scope, projectNo: PROJECT, counts: impact.counts, auditId: 'synthetic-audit-id' }))
    await vi.waitFor(() => expect(callsFor('/operator/projects')).toHaveLength(2))
    await vi.waitFor(() => expect(root.querySelector(`datalist option[value="${PROJECT}"]`)).toBeNull())
    expect(find('success')).toBeNull()
    expect(projectNo.value).toBe(NEIGHBOR)
    expect(readStockPrepRecentProjects(scope).map((entry) => entry.projectNo)).not.toContain(PROJECT)
  })
})
