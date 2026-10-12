import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, reactive, ref, type App as VueApp, type Component } from 'vue'

// 项目接入 — the PANEL. The DOM half of the entry the owner asked for:
//   「PLM系统接通后,在页面哪里可点击项目号,然后该项目号里的bom就自动导入到我们的多维表中」
//
// What this suite pins that the service suite cannot:
//
//   P-01 R-11 / the operator tier: the sync control is ABSENT for anyone below platform admin, and
//        the reason is rendered in words. This is the browser agreeing with the server refusal —
//        a stock-prep operator holds no `integration:*` code, so the very first call (dry-run,
//        requireAccess(req,'read')) 403s for them.
//   P-02 the plain-language register: a HELD plan renders as 待办 with a route to the queue, and the
//        word 失败/Failed appears nowhere on the panel.
//   P-03 a failed batch archive renders its own FAIL line while the panel's headline still says the
//        import succeeded.
//   P-04 the counts are a SENTENCE, and zero clauses are dropped.
//   P-05 values-free: nothing from a response reaches the DOM except counts and closed tokens; the
//        project number the OPERATOR TYPED is the one business string, and it is theirs.

const h = vi.hoisted(() => ({
  locale: 'zh-CN' as string,
  permissions: ['integration:admin'] as string[],
  useStoredAccess: false,
  fetch: vi.fn(),
}))
vi.mock('../src/utils/api', () => ({ apiFetch: h.fetch }))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: ref(h.locale),
    isZh: ref(h.locale === 'zh-CN'),
    setLocale: vi.fn(),
  }),
}))

vi.mock('../src/composables/useAuth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/composables/useAuth')>()
  return {
    useAuth: () => h.useStoredAccess ? actual.useAuth() : ({
      getToken: () => 'session-token',
      clearToken: vi.fn(),
      // `roles` / `permissions` are the shape `workbenchAccess.ts` decides on (it takes the SNAPSHOT,
      // never the expanding probe), so this double has to carry them or every stock-prep predicate
      // reads an empty principal.
      getAccessSnapshot: () => ({ isAdmin: false, email: '', roles: [], permissions: h.permissions }),
      hasPermission: (permission: string) => h.permissions.includes(permission),
    }),
  }
})

import StockPreparationProjectSyncPanel from '../src/components/integration/stockPreparation/StockPreparationProjectSyncPanel.vue'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'
import {
  BATCH_ARCHIVE_DISABLED_CODE,
  StockPreparationProjectSyncCallError,
  type StockPreparationProjectSyncApi,
} from '../src/services/integration/stockPreparation/projectSync'
import type { StockPreparationLargeBomJobApi } from '../src/services/integration/stockPreparation/largeBomPull'
import type { StockPrepProjectTargetState, StockPreparationProjectTargetApi } from '../src/services/integration/stockPreparation/projectTarget'

const PROJECT_NO = 'P2026-001'
const PLANTED_DRAWING = 'DWG-88472-A'
const PLANTED_NAME = '涡轮增压器总成'
const PLANTED_SECRET = 'pwd=secret-42007'

function api(overrides: Partial<StockPreparationProjectSyncApi> = {}): StockPreparationProjectSyncApi {
  return {
    dryRun: vi.fn().mockResolvedValue({
      status: 'ready',
      canApply: true,
      dryRunToken: 'tok_abc',
      counts: { add: 3, update: 2, skip: 7, inactive: 0, manual_confirm: 0 },
      evidence: { note: PLANTED_DRAWING, secret: PLANTED_SECRET },
      projectName: PLANTED_NAME,
    }),
    reconcile: vi.fn().mockResolvedValue({ counts: { created: 2, existing: 0, pending: 2 } }),
    apply: vi.fn().mockResolvedValue({
      status: 'succeeded',
      apply: { counts: { created: 3, updated: 2, inactive: 0, skipped: 7, held: 0, failed: 0 } },
    }),
    archive: vi.fn().mockResolvedValue({ status: 'created', persisted: true, created: { batch: 1, lines: 9, run: 1 } }),
    ...overrides,
  } as StockPreparationProjectSyncApi
}

/** A large-BOM job api double that reaches `done` in one tick of everything. */
function largeBomJobApi(overrides: Partial<StockPreparationLargeBomJobApi> = {}): StockPreparationLargeBomJobApi {
  return {
    startExpansion: vi.fn().mockResolvedValue({ jobId: 'large-bom-expansion-panel-1', status: 'queued', authoritative: false }),
    runExpansion: vi.fn().mockResolvedValue({
      jobId: 'large-bom-expansion-panel-1',
      status: 'completed',
      authoritative: true,
      progress: { rowsExpanded: 500, readCount: 520, frontierRemaining: 0, completedChunks: 1 },
      budgets: { maxRows: 1000, maxPages: 10, maxReadCount: 1200, maxElapsedMs: 30000, maxDepth: 10, maxArtifactChunks: 1 },
    }),
    planExpansion: vi.fn().mockResolvedValue({
      jobId: 'large-bom-expansion-panel-1',
      status: 'completed',
      authoritative: true,
      evidence: { plan: { counts: { add: 40, update: 10, skip: 0, inactive: 0, manual_confirm: 0 } } },
    }),
    startApply: vi.fn().mockResolvedValue({
      jobId: 'large-bom-apply-panel-1',
      status: 'queued',
      counts: { created: 0, updated: 0, inactive: 0, skipped: 0, held: 0, failed: 0 },
    }),
    runApplyChunk: vi.fn().mockResolvedValue({
      jobId: 'large-bom-apply-panel-1',
      status: 'succeeded',
      counts: { created: 40, updated: 10, inactive: 0, skipped: 0, held: 0, failed: 0 },
    }),
    ...overrides,
  } as StockPreparationLargeBomJobApi
}

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('StockPreparationProjectSyncPanel', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  let panelVm: { run: () => Promise<void> }

  beforeEach(() => {
    h.locale = 'zh-CN'
    h.permissions = ['integration:admin']
    h.useStoredAccess = false
    h.fetch.mockReset()
    localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.clearAllMocks()
    localStorage.clear()
  })

  function mountPanel(props: Record<string, unknown> = {}): HTMLDivElement {
    app = createApp(StockPreparationProjectSyncPanel as Component, props)
    panelVm = app.mount(container!) as unknown as { run: () => Promise<void> }
    return container!
  }

  async function runSync(root: HTMLElement, projectNo = PROJECT_NO): Promise<void> {
    const input = root.querySelector('[data-testid="stock-prep-project-sync-project-no"]') as HTMLInputElement
    input.value = projectNo
    input.dispatchEvent(new Event('input'))
    await nextTick()
    ;(root.querySelector('[data-testid="stock-prep-project-sync-run"]') as HTMLButtonElement).click()
    await flushUi()
  }

  async function runPreview(root: HTMLElement, project = PROJECT_NO): Promise<void> {
    const input = root.querySelector('[data-testid="stock-prep-project-sync-project-no"]') as HTMLInputElement
    input.value = project
    input.dispatchEvent(new Event('input'))
    await nextTick()
    ;(root.querySelector('[data-testid="stock-prep-project-preview-run"]') as HTMLButtonElement).click()
    await flushUi()
  }

  function previewNode(root: HTMLElement): HTMLElement | null { return root.querySelector('[data-testid="stock-prep-project-preview"]') }
  function deferredPlan() {
    let resolve!: (value: Record<string, unknown>) => void
    let reject!: (error: Error) => void
    const promise = new Promise<Record<string, unknown>>((done, fail) => { resolve = done; reject = fail })
    return { promise, resolve, reject }
  }

  const statuses = [
    { status: 'ready', canApply: true, manual: 0, zh: '变更计划已生成', en: 'Change plan generated' },
    { status: 'manual_confirm_required', canApply: true, manual: 2, zh: '待人工确认', en: 'manual confirmation' },
    { status: 'not_found', canApply: false, manual: 0, zh: '未找到此项目', en: 'Project not found' },
    { status: 'large_bom_bounded', canApply: false, manual: 0, zh: '没有启动后台任务', en: 'no background job was started' },
    { status: 'failed', canApply: false, manual: 0, zh: '变更计划未通过检查', en: 'did not pass checks' },
  ]

  it.each(['zh-CN', 'en'].flatMap(locale => statuses.map(status => ({ ...status, locale }))))('previews only status and counts for $status in $locale', async ({ status, canApply, manual, zh, en, locale }) => {
    h.locale = locale
    const add = status === 'not_found' ? 0 : 3
    const raw = { status, canApply, dryRunToken: 'PRIVATE_PREVIEW_TOKEN', revision: PLANTED_SECRET,
      counts: { add, update: status === 'not_found' ? 0 : 2, skip: status === 'not_found' ? 0 : 7, inactive: 0, manual_confirm: manual },
      evidence: { secret: PLANTED_SECRET }, error: { code: 'PRIVATE_POISON_CODE', message: PLANTED_NAME },
      missingComponents: { items: [{ componentSourceId: PLANTED_DRAWING }] } }
    h.fetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, data: raw })))
    const synced = vi.fn()
    const jobs = largeBomJobApi()
    const root = mountPanel({ scope: { tenantId: 'synthetic_tenant', workspaceId: 'synthetic_workspace' }, largeBomApi: jobs, onSynced: synced })
    await runPreview(root, ` ${PROJECT_NO} `)
    expect(previewNode(root)?.getAttribute('data-status')).toBe(status)
    expect(previewNode(root)?.textContent).toContain(locale === 'zh-CN' ? zh : en)
    const counts = root.querySelector('[data-testid="stock-prep-project-preview-counts"]')!
    expect(counts.textContent).toContain(locale === 'zh-CN' ? `计划新增 ${add}` : `Planned additions ${add}`)
    expect(counts.textContent).toContain(locale === 'zh-CN' ? '计划停用 0' : 'Planned inactive rows 0')
    expect(root.querySelector('[data-testid="stock-prep-project-preview-note"]')?.textContent).toContain(locale === 'zh-CN' ? '服务端可能保留短期预览令牌' : 'server may retain an expiring preview token')
    expect(root.querySelector('[data-testid="stock-prep-project-preview-note"]')?.textContent).toContain(locale === 'zh-CN' ? '重新试算' : 'fresh plan')
    for (const poison of ['PRIVATE_PREVIEW_TOKEN', 'PRIVATE_POISON_CODE', PLANTED_SECRET, PLANTED_DRAWING, PLANTED_NAME, 'dryRunToken', 'revision', 'evidence']) expect(root.textContent).not.toContain(poison)
    expect(h.fetch).toHaveBeenCalledTimes(1)
    expect(String(h.fetch.mock.calls[0][0])).toContain('/dry-run?')
    expect(JSON.parse(h.fetch.mock.calls[0][1].body)).toEqual({ parameters: { projectNo: PROJECT_NO }, includeMissingComponents: true })
    expect(synced).not.toHaveBeenCalled()
    expect(jobs.startExpansion).not.toHaveBeenCalled()
    expect(root.querySelector('[data-testid="stock-prep-large-bom-pull"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-sync-verdict"]')).toBeNull()
  })

  it.each([
    { counts: { add: -1, update: 0, skip: 0, inactive: 0, manual_confirm: 0 } },
    { counts: { add: '3', update: 0, skip: 0, inactive: 0, manual_confirm: 0 } },
    { counts: { add: 3 } }, { status: 'PRIVATE_POISON_CODE' }, { status: 'failed', canApply: true },
    { status: 'not_found', canApply: false },
    { status: 'ready', counts: { add: 3, update: 0, skip: 0, inactive: 0, manual_confirm: 1 } },
    { canApply: 'true' },
  ])('does not render invented counts or ready status for malformed data %#', async extra => {
    const double = api({ dryRun: vi.fn().mockResolvedValue({ status: 'ready', canApply: true, dryRunToken: PLANTED_SECRET,
      counts: { add: 3, update: 2, skip: 0, inactive: 0, manual_confirm: 0 }, ...extra }) })
    const root = mountPanel({ api: double })
    await runPreview(root)
    expect(previewNode(root)?.getAttribute('data-status')).toBe('unavailable')
    expect(previewNode(root)?.textContent).toContain('预览响应无法核实')
    expect(root.querySelector('[data-testid="stock-prep-project-preview-counts"]')).toBeNull()
    expect(root.textContent).not.toContain('PRIVATE_POISON_CODE')
    expect(double.apply).not.toHaveBeenCalled()
  })

  it('rejects ambiguous HTTP success and hides arbitrary error codes and messages', async () => {
    h.fetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { status: 'ready', canApply: true,
      counts: { add: 3, update: 0, skip: 0, inactive: 0, manual_confirm: 0 } }, error: { code: 'PRIVATE_POISON_CODE', message: PLANTED_SECRET } })))
    const root = mountPanel()
    await runPreview(root)
    expect(previewNode(root)?.textContent).toContain('预览响应无法核实')
    expect(root.textContent).not.toContain('PRIVATE_POISON_CODE')
    expect(root.textContent).not.toContain(PLANTED_SECRET)
    expect(h.fetch).toHaveBeenCalledTimes(1)
  })

  it.each([new Error(PLANTED_SECRET), new StockPreparationProjectSyncCallError(400, '/dry-run', { code: 'PRIVATE_POISON_CODE' })])('renders fixed preview failure guidance only %#', async error => {
    const double = api({ dryRun: vi.fn().mockRejectedValue(error) })
    const root = mountPanel({ api: double })
    await runPreview(root)
    expect(previewNode(root)?.textContent).toContain('未能生成预览')
    expect(root.textContent).not.toContain(PLANTED_SECRET)
    expect(root.textContent).not.toContain('PRIVATE_POISON_CODE')
    expect(double.apply).not.toHaveBeenCalled()
  })

  function projectTargetApi(status: StockPrepProjectTargetState['status']): StockPreparationProjectTargetApi {
    return {
      get: vi.fn().mockResolvedValue({ status, sheetId: 'synthetic-project-sheet', viewId: 'synthetic-project-view',
        todoViewId: null, rowCount: 0, activeRowCount: 0, rowCountBounded: false, lastPulledAt: null,
        lastPullOutcome: null, archivedAt: status === 'archived' ? '2026-10-10T00:00:00Z' : null,
        may: { create: true, archive: true, restore: true } } satisfies StockPrepProjectTargetState),
      create: vi.fn(), list: vi.fn(), archive: vi.fn(), restore: vi.fn(),
    }
  }

  it.each([
    [409, 'STOCK_PREPARATION_PROJECT_ABSENT', '还没有备料表', '不会新建'],
    [409, 'STOCK_PREPARATION_PROJECT_ARCHIVED', '已归档', '不会恢复'],
    [409, 'TABLE_ACTION_TARGET_TENANT_MISMATCH', '归属无法核实', '不会更换或修复'],
    [409, 'TABLE_ACTION_TARGET_OWNER_UNKNOWN', '归属无法核实', '不会更换或修复'],
    [409, 'TABLE_ACTION_TARGET_UNBOUND', '归属无法核实', '不会更换或修复'],
  ])('shows fixed refusal guidance for %s/%s without entering project-target writes', async (status, code, guidance, action) => {
    const targetApi = projectTargetApi('absent')
    h.fetch.mockResolvedValue(new Response(JSON.stringify({ ok: false, error: { code, message: PLANTED_SECRET } }), { status }))
    const synced = vi.fn()
    const root = mountPanel({ targetApi, onSynced: synced })
    await runPreview(root)
    expect(previewNode(root)?.textContent).toContain(guidance)
    expect(previewNode(root)?.textContent).toContain(action)
    expect(root.querySelector('[data-testid="stock-prep-project-preview-counts"]')).toBeNull()
    expect(root.textContent).not.toContain(code)
    expect(root.textContent).not.toContain(PLANTED_SECRET)
    expect(root.querySelector('[data-testid="stock-prep-project-sync-target-prompt"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-sync-restore-prompt"]')).toBeNull()
    expect(h.fetch).toHaveBeenCalledTimes(1)
    expect(String(h.fetch.mock.calls[0][0])).toContain('/dry-run')
    for (const method of [targetApi.get, targetApi.create, targetApi.list, targetApi.archive, targetApi.restore]) expect(method).not.toHaveBeenCalled()
    expect(synced).not.toHaveBeenCalled()
  })

  it('clears an old archived/restore prompt at preview start without restoring or writing the project', async () => {
    const targetApi = projectTargetApi('archived')
    const double = api()
    const root = mountPanel({ api: double, targetApi })
    await runSync(root)
    expect(root.querySelector('[data-testid="stock-prep-project-sync-target-notice"]')?.getAttribute('data-notice')).toBe('archived')
    ;(root.querySelector('[data-testid="stock-prep-project-sync-restore"]') as HTMLButtonElement).click()
    await flushUi()
    expect(root.querySelector('[data-testid="stock-prep-project-sync-restore-prompt"]')).not.toBeNull()
    await runPreview(root)
    expect(previewNode(root)).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-sync-target-notice"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-sync-restore-prompt"]')).toBeNull()
    expect(targetApi.get).toHaveBeenCalledTimes(1)
    expect(double.dryRun).toHaveBeenCalledTimes(1)
    for (const method of [targetApi.create, targetApi.archive, targetApi.restore, double.reconcile, double.apply, double.archive]) expect(method).not.toHaveBeenCalled()
    await runSync(root)
    expect(previewNode(root)).toBeNull()
    expect(targetApi.get).toHaveBeenCalledTimes(2)
    expect(double.dryRun).toHaveBeenCalledTimes(1)
  })

  it('keeps the explicit project-sheet creation question and blocks preview while that question is live', async () => {
    const targetApi = projectTargetApi('absent')
    const double = api()
    const root = mountPanel({ api: double, targetApi })
    await runSync(root)
    expect(root.querySelector('[data-testid="stock-prep-project-sync-target-prompt"]')?.getAttribute('data-prompt')).toBe('create')
    await runPreview(root)
    expect(double.dryRun).not.toHaveBeenCalled()
    expect(targetApi.create).not.toHaveBeenCalled()
    ;(root.querySelector('[data-testid="stock-prep-project-sync-target-prompt-cancel"]') as HTMLButtonElement).click()
    await flushUi()
    await runPreview(root)
    expect(previewNode(root)).not.toBeNull()
    expect(targetApi.get).toHaveBeenCalledTimes(1)
    expect(double.dryRun).toHaveBeenCalledTimes(1)
    for (const method of [targetApi.create, targetApi.archive, targetApi.restore, double.reconcile, double.apply, double.archive]) expect(method).not.toHaveBeenCalled()
  })

  it.each(['', '   ', 'P'.repeat(129), 'P\u0001SYN'])('does not request preview for invalid input %#', async project => {
    const double = api()
    const root = mountPanel({ api: double })
    await runPreview(root, project)
    expect((root.querySelector('[data-testid="stock-prep-project-preview-run"]') as HTMLButtonElement).disabled).toBe(true)
    expect(double.dryRun).not.toHaveBeenCalled()
  })

  it('uses the same pull/admin predicate without widening preview access', async () => {
    for (const permissions of [
      ['integration:read'], ['stock-prep:operate'], [], ['stock-prep:read', 'stock-prep:operate'],
      ['stock-prep:read', 'stock-prep:pull'], ['stock-prep:operate', 'stock-prep:pull'],
      ['stock-prep:read', 'stock-prep:operate', 'stock-prep:pull'],
    ]) {
      h.permissions = permissions
      const double = api()
      const root = mountPanel({ api: double })
      const allowed = permissions.includes('stock-prep:read') && permissions.includes('stock-prep:operate')
        && permissions.includes('stock-prep:pull')
      expect(Boolean(root.querySelector('[data-testid="stock-prep-project-preview-run"]'))).toBe(allowed)
      expect(double.dryRun).not.toHaveBeenCalled()
      app?.unmount(); app = null; root.innerHTML = ''
    }
  })

  it('locks double clicks, Enter and exposed sync during preview until the promise settles', async () => {
    const pending = deferredPlan()
    const double = api({ dryRun: vi.fn().mockReturnValueOnce(pending.promise) })
    const root = mountPanel({ api: double })
    await runPreview(root)
    ;(root.querySelector('[data-testid="stock-prep-project-preview-run"]') as HTMLButtonElement).click()
    ;(root.querySelector('[data-testid="stock-prep-project-sync-run"]') as HTMLButtonElement).click()
    root.querySelector('input')!.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter' }))
    await panelVm.run()
    notifyAuthPrincipalChange()
    await flushUi()
    expect((root.querySelector('[data-testid="stock-prep-project-preview-run"]') as HTMLButtonElement).disabled).toBe(true)
    expect(double.dryRun).toHaveBeenCalledTimes(1)
    pending.resolve({ status: 'ready', canApply: true, counts: { add: 1, update: 0, skip: 0, inactive: 0, manual_confirm: 0 } })
    await flushUi()
    expect(previewNode(root)).toBeNull()
    expect((root.querySelector('[data-testid="stock-prep-project-preview-run"]') as HTMLButtonElement).disabled).toBe(false)
    expect(double.apply).not.toHaveBeenCalled()
  })

  it.each(['project', 'scope', 'session', 'unmount'].flatMap(change => ['success', 'error'].map(reply => ({ change, reply }))))('drops late preview $reply after $change without pretending IO ended', async ({ change, reply }) => {
    const pending = deferredPlan()
    const double = api({ dryRun: vi.fn().mockReturnValue(pending.promise) })
    const scope = reactive({ tenantId: 'synthetic_tenant', workspaceId: 'synthetic_workspace' })
    const synced = vi.fn()
    const root = mountPanel({ api: double, scope, onSynced: synced })
    await runPreview(root)
    if (change === 'project') {
      const input = root.querySelector('input')!
      input.value = 'SYN-OTHER'
      input.dispatchEvent(new Event('input'))
    } else if (change === 'scope') scope.workspaceId = 'synthetic_other_workspace'
    else if (change === 'session') { localStorage.setItem('auth_token', 'synthetic_other_session'); notifyAuthPrincipalChange() }
    else { app?.unmount(); app = null }
    await flushUi()
    if (change !== 'unmount') expect((root.querySelector('[data-testid="stock-prep-project-preview-run"]') as HTMLButtonElement).disabled).toBe(true)
    if (reply === 'success') pending.resolve({ status: 'ready', canApply: true, counts: { add: 99, update: 0, skip: 0, inactive: 0, manual_confirm: 0 } })
    else pending.reject(new Error(PLANTED_SECRET))
    await flushUi()
    expect(previewNode(root)).toBeNull()
    expect(double.dryRun).toHaveBeenCalledTimes(1)
    expect(double.apply).not.toHaveBeenCalled()
    expect(synced).not.toHaveBeenCalled()
  })

  it('clears an already displayed preview on input, scope and session changes without reading again', async () => {
    const double = api()
    const scope = reactive({ tenantId: 'synthetic_tenant', workspaceId: 'synthetic_workspace' })
    const root = mountPanel({ api: double, scope })
    await runPreview(root)
    expect(previewNode(root)).not.toBeNull()
    scope.tenantId = 'synthetic_other_tenant'
    await flushUi()
    expect(previewNode(root)).toBeNull()
    await runPreview(root)
    localStorage.setItem('auth_token', 'synthetic_other_session')
    window.dispatchEvent(new Event('storage'))
    await flushUi()
    expect(previewNode(root)).toBeNull()
    await runPreview(root)
    const input = root.querySelector('input')!
    input.value = 'SYN-OTHER'
    input.dispatchEvent(new Event('input'))
    await flushUi()
    expect(previewNode(root)).toBeNull()
    expect(double.dryRun).toHaveBeenCalledTimes(3)
  })

  // Exercise the real useAuth snapshot reader and the real stock-prep predicate.
  // The token intentionally carries no permissions: only the refreshed stored snapshot changes.
  const storedAccessCases = [
    { key: 'user_permissions', granted: ['stock-prep:read', 'stock-prep:operate', 'stock-prep:pull'], revoked: ['stock-prep:read'] },
    { key: 'user_roles', granted: ['admin'], revoked: [] },
  ]

  function seedStoredAccess(key: string, values: string[]): void {
    h.useStoredAccess = true
    localStorage.setItem('auth_token', 'synthetic_unchanged_session')
    localStorage.setItem('user_permissions', '[]')
    localStorage.setItem('user_roles', '[]')
    localStorage.setItem(key, JSON.stringify(values))
  }

  function announceAccessChange(event: string, key: string): void {
    if (event === 'storage') window.dispatchEvent(new StorageEvent('storage', { key }))
    else if (event === 'focus') window.dispatchEvent(new Event('focus'))
  }

  it.each(storedAccessCases.flatMap(access => ['storage', 'focus'].map(event => ({ ...access, event }))))(
    'enables a same-token $key grant on $event without automatically requesting a preview',
    async ({ key, granted, revoked, event }) => {
      seedStoredAccess(key, revoked)
      const double = api()
      const root = mountPanel({ api: double, projectNo: PROJECT_NO })
      expect(root.querySelector('[data-testid="stock-prep-project-preview-run"]')).toBeNull()

      localStorage.setItem(key, JSON.stringify(granted))
      announceAccessChange(event, key)
      await flushUi()

      expect(localStorage.getItem('auth_token')).toBe('synthetic_unchanged_session')
      expect(root.querySelector('[data-testid="stock-prep-project-sync-denied"]')).toBeNull()
      expect((root.querySelector('[data-testid="stock-prep-project-preview-run"]') as HTMLButtonElement).disabled).toBe(false)
      expect(double.dryRun).not.toHaveBeenCalled()
      await runPreview(root)
      expect(previewNode(root)).not.toBeNull()
      expect(double.dryRun).toHaveBeenCalledTimes(1)
      expect(double.apply).not.toHaveBeenCalled()
    },
  )

  it.each(storedAccessCases.flatMap(access => ['storage', 'focus'].map(event => ({ ...access, event }))))(
    'clears a displayed preview and hides controls after same-token $key revocation on $event',
    async ({ key, granted, revoked, event }) => {
      seedStoredAccess(key, granted)
      const double = api()
      const root = mountPanel({ api: double })
      await runPreview(root)
      expect(previewNode(root)).not.toBeNull()

      localStorage.setItem(key, JSON.stringify(revoked))
      announceAccessChange(event, key)
      await flushUi()

      expect(localStorage.getItem('auth_token')).toBe('synthetic_unchanged_session')
      expect(previewNode(root)).toBeNull()
      expect(root.querySelector('[data-testid="stock-prep-project-preview-run"]')).toBeNull()
      expect(root.querySelector('[data-testid="stock-prep-project-sync-run"]')).toBeNull()
      expect(root.querySelector('[data-testid="stock-prep-project-sync-denied"]')).not.toBeNull()
      await panelVm.run()
      expect(double.dryRun).toHaveBeenCalledTimes(1)
      expect(double.apply).not.toHaveBeenCalled()
    },
  )

  it.each(storedAccessCases.flatMap(access => ['storage', 'focus', 'no event'].flatMap(event =>
    ['success', 'error'].map(reply => ({ ...access, event, reply })),
  )))(
    'drops in-flight preview $reply after same-token $key revocation with $event',
    async ({ key, granted, revoked, event, reply }) => {
      seedStoredAccess(key, granted)
      const pending = deferredPlan()
      const double = api({ dryRun: vi.fn().mockReturnValueOnce(pending.promise) })
      const root = mountPanel({ api: double })
      await runPreview(root)

      localStorage.setItem(key, JSON.stringify(revoked))
      announceAccessChange(event, key)
      await flushUi()
      expect((root.querySelector('input') as HTMLInputElement).disabled).toBe(true)
      if (event !== 'no event') expect(root.querySelector('[data-testid="stock-prep-project-preview-run"]')).toBeNull()

      if (reply === 'success') pending.resolve({ status: 'ready', canApply: true, counts: { add: 99, update: 0, skip: 0, inactive: 0, manual_confirm: 0 } })
      else pending.reject(new Error(PLANTED_SECRET))
      await flushUi()

      expect(localStorage.getItem('auth_token')).toBe('synthetic_unchanged_session')
      expect(previewNode(root)).toBeNull()
      expect(root.querySelector('[data-testid="stock-prep-project-preview-run"]')).toBeNull()
      expect(root.querySelector('[data-testid="stock-prep-project-sync-denied"]')).not.toBeNull()
      expect((root.querySelector('input') as HTMLInputElement).disabled).toBe(false)
      expect(double.dryRun).toHaveBeenCalledTimes(1)
      expect(double.apply).not.toHaveBeenCalled()
    },
  )

  it('discards a pending preview even when the changed same-token snapshot still allows preview', async () => {
    seedStoredAccess('user_permissions', ['stock-prep:read', 'stock-prep:operate', 'stock-prep:pull'])
    const pending = deferredPlan()
    const double = api({ dryRun: vi.fn().mockReturnValueOnce(pending.promise) })
    const root = mountPanel({ api: double })
    await runPreview(root)
    localStorage.setItem('user_permissions', JSON.stringify(['stock-prep:read', 'stock-prep:operate', 'stock-prep:pull', 'stock-prep:admin']))
    // No notification: the completion check must compare the entire captured snapshot.
    pending.resolve({ status: 'ready', canApply: true, counts: { add: 99, update: 0, skip: 0, inactive: 0, manual_confirm: 0 } })
    await flushUi()
    expect(previewNode(root)).toBeNull()
    expect((root.querySelector('[data-testid="stock-prep-project-preview-run"]') as HTMLButtonElement).disabled).toBe(false)
    expect(double.dryRun).toHaveBeenCalledTimes(1)
  })

  it('a later sync plans freshly and uses its own token through the unchanged explicit path', async () => {
    const double = api({ dryRun: vi.fn()
      .mockResolvedValueOnce({ status: 'ready', canApply: true, dryRunToken: 'PRIVATE_PREVIEW_TOKEN', counts: { add: 9, update: 0, skip: 0, inactive: 0, manual_confirm: 0 } })
      .mockResolvedValueOnce({ status: 'ready', canApply: true, dryRunToken: 'FRESH_SYNC_TOKEN', counts: { add: 3, update: 0, skip: 0, inactive: 0, manual_confirm: 0 } }) })
    const synced = vi.fn()
    const root = mountPanel({ api: double, onSynced: synced })
    await runPreview(root)
    expect(double.apply).not.toHaveBeenCalled()
    await runSync(root)
    expect(previewNode(root)).toBeNull()
    expect(double.dryRun).toHaveBeenCalledTimes(2)
    expect(double.apply).toHaveBeenCalledWith(PROJECT_NO, 'FRESH_SYNC_TOKEN')
    expect(double.archive).toHaveBeenCalledTimes(1)
    expect(synced).toHaveBeenCalledTimes(1)
    expect(root.querySelector('[data-testid="stock-prep-project-sync-verdict"]')?.textContent).toContain('导入完成')
  })

  it('clears a previous imported verdict at preview start and prevents preview during a sync', async () => {
    const pending = deferredPlan()
    const double = api()
    const root = mountPanel({ api: double })
    await runSync(root)
    expect(root.querySelector('[data-testid="stock-prep-project-sync-verdict"]')).not.toBeNull()
    vi.mocked(double.dryRun).mockReturnValueOnce(pending.promise)
    await runPreview(root)
    expect(root.querySelector('[data-testid="stock-prep-project-sync-verdict"]')).toBeNull()
    pending.resolve({ status: 'ready', canApply: true, counts: { add: 3, update: 0, skip: 0, inactive: 0, manual_confirm: 0 } })
    await flushUi()
    const syncPending = deferredPlan()
    vi.mocked(double.dryRun).mockReturnValueOnce(syncPending.promise)
    await runSync(root)
    ;(root.querySelector('[data-testid="stock-prep-project-preview-run"]') as HTMLButtonElement).click()
    await flushUi()
    expect(double.dryRun).toHaveBeenCalledTimes(3)
    expect(previewNode(root)).toBeNull()
    syncPending.resolve({ status: 'ready', canApply: true, dryRunToken: 'FRESH_SYNC_TOKEN', counts: { add: 3, update: 0, skip: 0, inactive: 0, manual_confirm: 0 } })
    await flushUi()
  })

  // ---- P-01 --------------------------------------------------------------------------------
  it('P-01: a platform admin sees the sync control', () => {
    const root = mountPanel({ api: api() })
    expect(root.querySelector('[data-testid="stock-prep-project-sync-run"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-sync-denied"]')).toBeNull()
  })

  // 拉取人员拉数据 (R-33, 2026-10-08; was 一线自己拉数据): the owner first ruled a floor operator may
  // self-serve the pull, then reversed it — pulling belongs to the 拉取人员, a holder of
  // `stock-prep:pull` on top of operate and read. The control follows the server, not the other way
  // round — the plugin suite stock-preparation-operator-pull-gate.test.cjs (P-14) is what proves the
  // server admits the puller and refuses the floor operator.
  it('P-01: the stock-prep PULL tier (read+operate+pull) gets the sync control', () => {
    h.permissions = ['stock-prep:read', 'stock-prep:operate', 'stock-prep:pull']
    const root = mountPanel({ api: api() })
    expect(root.querySelector('[data-testid="stock-prep-project-sync-run"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-sync-denied"]')).toBeNull()
  })

  it('P-01: the floor operator (read+operate, no pull) no longer gets it, and is sent to the 拉取人员', () => {
    h.permissions = ['stock-prep:read', 'stock-prep:operate']
    const root = mountPanel({ api: api() })
    expect(root.querySelector('[data-testid="stock-prep-project-sync-run"]')).toBeNull()
    const denied = root.querySelector('[data-testid="stock-prep-project-sync-denied"]') as HTMLElement
    expect(denied).not.toBeNull()
    expect(denied.textContent).toContain('请联系拉取人员')
    // …and is NOT told to obtain a permission they already hold.
    expect(denied.textContent).not.toContain('备料操作权限')
  })

  it('P-01: the pull tier is a CONJUNCTION — pull WITHOUT operate, pull WITHOUT read, and operate WITHOUT read all get nothing', () => {
    for (const permissions of [['stock-prep:read', 'stock-prep:pull'], ['stock-prep:operate', 'stock-prep:pull'], ['stock-prep:pull'], ['stock-prep:operate']]) {
      h.permissions = permissions
      const root = mountPanel({ api: api() })
      expect(root.querySelector('[data-testid="stock-prep-project-sync-run"]'), permissions.join('+')).toBeNull()
      expect(root.querySelector('[data-testid="stock-prep-project-sync-denied"]'), permissions.join('+')).not.toBeNull()
      app?.unmount()
      app = null
      container!.innerHTML = ''
    }
  })

  it('P-01: neither the integration:write nor the read-only tier gets it, and both are told who does', () => {
    // NOTE the probe this suite injects is an EXACT-match one, so `stock-prep:admin` does not satisfy
    // `stock-prep:pull` here the way the real `useAuth` ladder would. That is deliberate: this
    // assertion is about the codes the panel asks for, and the ladder itself is pinned by
    // stockPrepPermissionMatrix.spec.ts against the live plugin module.
    for (const permissions of [['integration:write'], ['integration:read'], ['stock-prep:read'], []]) {
      h.permissions = permissions
      const root = mountPanel({ api: api() })
      expect(root.querySelector('[data-testid="stock-prep-project-sync-run"]')).toBeNull()
      const denied = root.querySelector('[data-testid="stock-prep-project-sync-denied"]') as HTMLElement
      expect(denied).not.toBeNull()
      // The reason names BOTH tiers that can run it — the 拉取人员 first, the platform administrator
      // second — because sending someone to the wrong person is its own kind of dead end.
      expect(denied.textContent).toContain('拉取人员')
      expect(denied.textContent).toContain('平台管理员')
      app?.unmount()
      app = null
      container!.innerHTML = ''
    }
  })

  // ---- the happy path ----------------------------------------------------------------------
  it('runs the four steps from a typed project number and points at the multitable', async () => {
    const double = api()
    const onOpenMultitable = vi.fn()
    const root = mountPanel({ api: double, onOpenMultitable })
    await runSync(root)

    expect(double.dryRun).toHaveBeenCalledWith(PROJECT_NO)
    expect(double.apply).toHaveBeenCalledWith(PROJECT_NO, 'tok_abc')

    const steps = root.querySelectorAll('[data-testid="stock-prep-project-sync-step"]')
    expect(steps.length).toBe(4)
    expect((steps[2] as HTMLElement).getAttribute('data-status')).toBe('ok')

    const verdict = root.querySelector('[data-testid="stock-prep-project-sync-verdict"]') as HTMLElement
    expect(verdict.getAttribute('data-verdict')).toBe('imported')
    expect(verdict.textContent).toContain('导入完成')

    const openMultitable = root.querySelector('[data-testid="stock-prep-project-sync-open-multitable"]') as HTMLButtonElement
    expect(openMultitable).not.toBeNull()
    openMultitable.click()
    expect(onOpenMultitable).toHaveBeenCalledTimes(1)
  })

  // ---- 打开备料多维表: THE LABEL AND THE DESTINATION AGREE -----------------------------------
  //
  // The parent owns routing, and until this pass it had nowhere to route: the panel's link always
  // said 「到多维表看数据」 and always landed on the multitable chooser. The operator directory now
  // hands the parent the same tenant-gated `{ sheetId, viewId }` 项目备料页 returns, so the button
  // says which of the two things it will actually do. It still composes NO route itself.

  it('with a fill handle the link names the 备料主表', async () => {
    const root = mountPanel({ api: api(), fillTarget: { sheetId: 'sheet_x', viewId: 'view_x' } })
    await runSync(root)
    const link = root.querySelector('[data-testid="stock-prep-project-sync-open-multitable"]') as HTMLButtonElement
    expect(link.getAttribute('data-fill-target')).toBe('bound')
    expect(link.textContent).toContain('打开备料多维表')
  })

  it('with NO handle it promises only the workbench — the destination the parent really has', async () => {
    const root = mountPanel({ api: api() })
    await runSync(root)
    const link = root.querySelector('[data-testid="stock-prep-project-sync-open-multitable"]') as HTMLButtonElement
    expect(link.getAttribute('data-fill-target')).toBe('none')
    expect(link.textContent).toContain('打开多维表工作台')
    expect(link.textContent).not.toContain('打开备料多维表')
  })
  // ---- P-04 --------------------------------------------------------------------------------
  it('P-04: the plan counts read as a sentence, with the zero clauses dropped', async () => {
    const root = mountPanel({ api: api() })
    await runSync(root)
    const counts = root.querySelector('[data-testid="stock-prep-project-sync-counts"]') as HTMLElement
    expect(counts.textContent).toContain('新增 3 行')
    expect(counts.textContent).toContain('更新 2 行')
    expect(counts.textContent).toContain('7 行已经是最新的')
    // inactive and manual_confirm were 0 — their clauses must not be printed at all.
    expect(counts.textContent).not.toContain('0 行')
  })

  // ---- P-02 --------------------------------------------------------------------------------
  it('P-02: a held plan renders as 待办 — no 失败 anywhere, and a route to the queue', async () => {
    const double = api({
      dryRun: vi.fn().mockResolvedValue({
        status: 'manual_confirm_required',
        canApply: true,
        dryRunToken: 'tok_held',
        counts: { add: 4, update: 0, skip: 0, inactive: 0, manual_confirm: 5 },
      }),
    })
    const onNavigateStage = vi.fn()
    const root = mountPanel({ api: double, onNavigateStage })
    await runSync(root)

    const verdict = root.querySelector('[data-testid="stock-prep-project-sync-verdict"]') as HTMLElement
    expect(verdict.getAttribute('data-verdict')).toBe('held')
    expect(verdict.textContent).toContain('还差一步')

    // THE REGISTER: a held plan is work outstanding, so the failure word must not be on the panel.
    const text = root.textContent || ''
    expect(text).not.toContain('失败')
    expect(text).toContain('确认队列')

    // The write step is a SKIP whose reason is rendered with the same weight as an OK line.
    const write = root.querySelector('[data-step="apply"]') as HTMLElement
    expect(write.getAttribute('data-status')).toBe('skip')
    expect(write.textContent).toContain('先不写入')

    // ...and the route out of it carries the pending count.
    const queue = root.querySelector('[data-testid="stock-prep-project-sync-open-queue"]') as HTMLButtonElement
    expect(queue).not.toBeNull()
    expect(queue.textContent).toContain('2') // reconcile's pending count
    queue.click()
    expect(onNavigateStage).toHaveBeenCalledWith('confirmation-queue')

    expect(double.apply).not.toHaveBeenCalled()
  })

  // ---- P-03 --------------------------------------------------------------------------------
  it('P-03: a failed batch archive shows its own FAIL line while the headline still says imported', async () => {
    const double = api({
      archive: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(500, '/mvp-persist', { code: 'PERSIST_PLAN_TOO_LARGE' })),
    })
    const root = mountPanel({ api: double })
    await runSync(root)

    const verdict = root.querySelector('[data-testid="stock-prep-project-sync-verdict"]') as HTMLElement
    expect(verdict.getAttribute('data-verdict')).toBe('imported')
    expect(verdict.textContent).toContain('导入完成')

    const archive = root.querySelector('[data-step="archive"]') as HTMLElement
    expect(archive.getAttribute('data-status')).toBe('fail')
    expect(archive.textContent).toContain('存档没成功')
    // ...and it says, in the same breath, that the import itself is fine.
    expect(archive.textContent).toContain('导入本身不受影响')
  })

  it('P-03: the archive being off for this deployment renders as a setting, not a fault', async () => {
    const double = api({
      archive: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(403, '/mvp-persist', { code: BATCH_ARCHIVE_DISABLED_CODE })),
    })
    const root = mountPanel({ api: double })
    await runSync(root)
    const archive = root.querySelector('[data-step="archive"]') as HTMLElement
    expect(archive.getAttribute('data-status')).toBe('skip')
    expect(archive.textContent).toContain('这是设置,不是故障')
    expect((root.textContent || '')).not.toContain('失败')
  })

  // ---- P-07: 客户反馈 2026-09-24 #2 (裁定见 PR #6074;后端诊断见 #6067) —————————————————————————
  // a dry-run failure names its ACTUAL cause instead of always printing the same "try again" line.
  // The OLD, always-the-same sentence — asserted absent for the two classes it used to wrongly cover.
  const OLD_GENERIC_PLAN_READ_FAILED_ZH = '没能连上取数,试算没有跑起来'

  it('P-07: a CONNECTION_* dry-run refusal names the broken connection, not the generic retry line', async () => {
    const double = api({
      dryRun: vi.fn().mockRejectedValue(
        new StockPreparationProjectSyncCallError(500, '/dry-run', { code: 'CONNECTION_CANONICAL_UNAVAILABLE' }),
      ),
    })
    const root = mountPanel({ api: double })
    await runSync(root)
    const plan = root.querySelector('[data-step="dry-run"]') as HTMLElement
    expect(plan.getAttribute('data-status')).toBe('fail')
    expect(plan.textContent).toContain('连接配置失效')
    expect(plan.textContent).not.toContain(OLD_GENERIC_PLAN_READ_FAILED_ZH)
    // The code stays visible in 技术详情 for whoever quotes it to an administrator.
    const tech = root.querySelector('[data-testid="stock-prep-project-sync-tech"]') as HTMLElement
    expect(tech.textContent).toContain('PLAN_READ_FAILED_CONNECTION')
    expect(tech.textContent).toContain('CONNECTION_CANONICAL_UNAVAILABLE')
  })

  it('P-07: a TARGET_SHEET_FOREIGN_PROJECT refusal names the other project, not the generic retry line', async () => {
    const double = api({
      dryRun: vi.fn().mockRejectedValue(
        new StockPreparationProjectSyncCallError(409, '/dry-run', { code: 'TARGET_SHEET_FOREIGN_PROJECT' }),
      ),
    })
    const root = mountPanel({ api: double })
    await runSync(root)
    const plan = root.querySelector('[data-step="dry-run"]') as HTMLElement
    expect(plan.getAttribute('data-status')).toBe('fail')
    expect(plan.textContent).toContain('其他项目的有效数据')
    expect(plan.textContent).not.toContain(OLD_GENERIC_PLAN_READ_FAILED_ZH)
    const tech = root.querySelector('[data-testid="stock-prep-project-sync-tech"]') as HTMLElement
    expect(tech.textContent).toContain('PLAN_READ_FAILED_FOREIGN_PROJECT')
    expect(tech.textContent).toContain('TARGET_SHEET_FOREIGN_PROJECT')
  })

  it('P-07: a bare 403 on the plan is named as a permission refusal', async () => {
    const double = api({
      dryRun: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(403, '/dry-run', {})),
    })
    const root = mountPanel({ api: double })
    await runSync(root)
    const plan = root.querySelector('[data-step="dry-run"]') as HTMLElement
    expect(plan.getAttribute('data-status')).toBe('fail')
    expect(plan.textContent).toContain('没有从 PLM 拉取')
  })

  it('P-07: a bare 401 on the plan is named as an expired session, not a permission refusal', async () => {
    const double = api({
      dryRun: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(401, '/dry-run', {})),
    })
    const root = mountPanel({ api: double })
    await runSync(root)
    const plan = root.querySelector('[data-step="dry-run"]') as HTMLElement
    expect(plan.getAttribute('data-status')).toBe('fail')
    expect(plan.textContent).toContain('登录已过期')
    expect(plan.textContent).not.toContain('没有从 PLM 拉取')
    expect(plan.textContent).not.toContain(OLD_GENERIC_PLAN_READ_FAILED_ZH)
    const tech = root.querySelector('[data-testid="stock-prep-project-sync-tech"]') as HTMLElement
    expect(tech.textContent).toContain('PLAN_READ_UNAUTHENTICATED')
  })

  it('P-07: SOURCE_UNAVAILABLE keeps the original "try again shortly" sentence — this IS the transient case', async () => {
    const double = api({
      dryRun: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(503, '/dry-run', { code: 'SOURCE_UNAVAILABLE' })),
    })
    const root = mountPanel({ api: double })
    await runSync(root)
    const plan = root.querySelector('[data-step="dry-run"]') as HTMLElement
    expect(plan.textContent).toContain(OLD_GENERIC_PLAN_READ_FAILED_ZH)
  })

  it('P-07: an unrecognized dry-run failure asks the operator to screenshot the technical details', async () => {
    const double = api({
      dryRun: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(400, '/dry-run', { code: 'SOME_OTHER_CODE' })),
    })
    const root = mountPanel({ api: double })
    await runSync(root)
    const plan = root.querySelector('[data-step="dry-run"]') as HTMLElement
    expect(plan.textContent).toContain('截图')
    expect(plan.textContent).not.toContain(OLD_GENERIC_PLAN_READ_FAILED_ZH)
  })

  // ---- P-06: the partial-write headline tells the truth ------------------------------------
  it('P-06: a partial write says rows landed, counts what did not, and KEEPS the sheet link', async () => {
    const double = api({
      apply: vi.fn().mockResolvedValue({
        status: 'partial',
        apply: { counts: { created: 2, updated: 0, inactive: 0, skipped: 0, held: 0, failed: 1 } },
      }),
    })
    const root = mountPanel({ api: double })
    await runSync(root)

    const verdict = root.querySelector('[data-testid="stock-prep-project-sync-verdict"]') as HTMLElement
    // THE VERDICT AND THE HEADLINE, both pinned. Asserting only the step reason is what let the false
    // headline ship: the step said WRITE_PARTIAL while the sentence above it said nothing changed.
    expect(verdict.getAttribute('data-verdict')).toBe('partial')
    expect(verdict.textContent).toContain('写入了一部分')
    expect(verdict.textContent).not.toContain('数据没有变化')
    expect(verdict.textContent).not.toContain('没有导入成功')

    // ...and HOW MANY are missing, which is what makes it actionable.
    const count = root.querySelector('[data-testid="stock-prep-project-sync-verdict-count"]') as HTMLElement
    expect(count).not.toBeNull()
    expect(count.textContent).toContain('1')

    // The rows ARE in the sheet, so the way to look at them must be on screen.
    expect(root.querySelector('[data-testid="stock-prep-project-sync-open-multitable"]')).not.toBeNull()
  })

  it('P-06: a genuinely blocked run keeps the "nothing changed" headline and hides the sheet link', async () => {
    const double = api({
      apply: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(500, '/apply')),
    })
    const root = mountPanel({ api: double })
    await runSync(root)
    const verdict = root.querySelector('[data-testid="stock-prep-project-sync-verdict"]') as HTMLElement
    expect(verdict.getAttribute('data-verdict')).toBe('blocked')
    expect(verdict.textContent).toContain('数据没有变化')
    expect(root.querySelector('[data-testid="stock-prep-project-sync-open-multitable"]')).toBeNull()
  })

  it('P-06: an archive whose outcome the server did not state makes no claim about it', async () => {
    const double = api({ archive: vi.fn().mockResolvedValue({ status: 'created' }) })
    const root = mountPanel({ api: double })
    await runSync(root)
    const archive = root.querySelector('[data-step="archive"]') as HTMLElement
    expect(archive.getAttribute('data-status')).toBe('ok')
    // No positive claim in either direction.
    expect(archive.textContent).not.toContain('之前已经存过了')
    expect(archive.textContent).toContain('没说清')
  })

  // ---- L-BOM: the audit's second dead-end ---------------------------------------------------
  it('L-BOM: a large_bom_bounded plan mounts the background channel, which drives itself to done', async () => {
    const jobApi = largeBomJobApi()
    const double = api({
      dryRun: vi.fn().mockResolvedValue({
        status: 'large_bom_bounded',
        canApply: false,
        dryRunToken: null,
        counts: {},
      }),
    })
    const onOpenMultitable = vi.fn()
    const root = mountPanel({
      api: double,
      largeBomApi: jobApi,
      largeBomPollWait: vi.fn().mockResolvedValue(undefined),
      onOpenMultitable,
    })
    await runSync(root)

    // The SKIP still renders exactly as before — this fix adds a surface, it does not hide the SKIP.
    const planStep = root.querySelector('[data-step="dry-run"]') as HTMLElement
    expect(planStep.getAttribute('data-status')).toBe('skip')
    expect(planStep.textContent).toContain('太大')
    // The small-BOM apply/archive steps never ran — the plan stopped before them.
    expect(double.apply).not.toHaveBeenCalled()

    // The background channel is now visible and already driving itself (it starts on its own mount).
    const largeBom = root.querySelector('[data-testid="stock-prep-large-bom-pull"]') as HTMLElement
    expect(largeBom).not.toBeNull()
    expect(jobApi.startExpansion).toHaveBeenCalledWith(PROJECT_NO)

    await flushUi()
    expect(largeBom.getAttribute('data-phase')).toBe('done')

    // Its deep link is wired to the SAME parent event the small-BOM path's own link uses.
    const link = root.querySelector('[data-testid="stock-prep-large-bom-open-multitable"]') as HTMLButtonElement
    expect(link).not.toBeNull()
    link.click()
    expect(onOpenMultitable).toHaveBeenCalledTimes(1)
  })

  it('L-BOM: an ordinary (non-large-BOM) run never mounts the background channel', async () => {
    const root = mountPanel({ api: api(), largeBomApi: largeBomJobApi() })
    await runSync(root)
    expect(root.querySelector('[data-testid="stock-prep-large-bom-pull"]')).toBeNull()
  })

  // ---- P-05 --------------------------------------------------------------------------------
  it('P-05: no business value from a response reaches the DOM; the typed number does', async () => {
    const root = mountPanel({ api: api() })
    await runSync(root)
    const text = root.textContent || ''
    for (const forbidden of [PLANTED_DRAWING, PLANTED_NAME, PLANTED_SECRET, 'secret', 'tok_abc']) {
      expect(text).not.toContain(forbidden)
    }
    // The operator's own input is still in their own field.
    const input = root.querySelector('[data-testid="stock-prep-project-sync-project-no"]') as HTMLInputElement
    expect(input.value).toBe(PROJECT_NO)
  })

  it('refuses to run on an empty project number', async () => {
    const double = api()
    const root = mountPanel({ api: double })
    const button = root.querySelector('[data-testid="stock-prep-project-sync-run"]') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    button.click()
    await flushUi()
    expect(double.dryRun).not.toHaveBeenCalled()
  })

  it('renders the four steps as pending before any run', () => {
    const root = mountPanel({ api: api() })
    const steps = root.querySelectorAll('[data-testid="stock-prep-project-sync-step"]')
    expect(steps.length).toBe(4)
    for (const step of steps) expect((step as HTMLElement).getAttribute('data-status')).toBe('pending')
    expect(root.querySelector('[data-testid="stock-prep-project-sync-verdict"]')).toBeNull()
  })

  it('arming from a row 刷新 explains why the number has to be typed and focuses the field', async () => {
    const root = mountPanel({ api: api(), armedAt: 0 })
    expect(root.querySelector('[data-testid="stock-prep-project-sync-armed"]')).toBeNull()

    app!.unmount()
    app = createApp(StockPreparationProjectSyncPanel as Component, { api: api(), armedAt: 1 })
    // Mounting with a non-zero armedAt must NOT arm — only a CHANGE does, so a re-render cannot
    // spontaneously grab focus from wherever the operator is.
    app.mount(container!)
    await flushUi()
    expect(container!.querySelector('[data-testid="stock-prep-project-sync-armed"]')).toBeNull()
  })

  it('is bilingual: the English side renders the same steps and verdict', async () => {
    h.locale = 'en'
    const root = mountPanel({ api: api() })
    await runSync(root)
    const verdict = root.querySelector('[data-testid="stock-prep-project-sync-verdict"]') as HTMLElement
    expect(verdict.textContent).toContain('Imported')
    expect((root.textContent || '')).toContain('rows added')
  })

  it('keeps the raw outcome code in the technical disclosure for an implementer to grep', async () => {
    const root = mountPanel({ api: api() })
    await runSync(root)
    const tech = root.querySelector('[data-testid="stock-prep-project-sync-tech"]') as HTMLElement
    expect(tech).not.toBeNull()
    expect(tech.textContent).toContain('IMPORTED')
    expect(tech.textContent).toContain('mvp-persist')
    // The disclosure is a real <details> that is CLOSED by default: plain language first.
    expect(tech.tagName.toLowerCase()).toBe('details')
    expect(tech.getAttribute('data-open')).toBe('false')
  })
})
