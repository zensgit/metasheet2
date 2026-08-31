import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'

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
}))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: ref(h.locale),
    isZh: ref(h.locale === 'zh-CN'),
    setLocale: vi.fn(),
  }),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getToken: () => 'session-token',
    clearToken: vi.fn(),
    getAccessSnapshot: () => ({ isAdmin: false, email: '' }),
    hasPermission: (permission: string) => h.permissions.includes(permission),
  }),
}))

import StockPreparationProjectSyncPanel from '../src/components/integration/stockPreparation/StockPreparationProjectSyncPanel.vue'
import {
  BATCH_ARCHIVE_DISABLED_CODE,
  StockPreparationProjectSyncCallError,
  type StockPreparationProjectSyncApi,
} from '../src/services/integration/stockPreparation/projectSync'

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

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('StockPreparationProjectSyncPanel', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    h.locale = 'zh-CN'
    h.permissions = ['integration:admin']
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

  function mountPanel(props: Record<string, unknown> = {}): HTMLDivElement {
    app = createApp(StockPreparationProjectSyncPanel as Component, props)
    app.mount(container!)
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

  // ---- P-01 --------------------------------------------------------------------------------
  it('P-01: a platform admin sees the sync control', () => {
    const root = mountPanel({ api: api() })
    expect(root.querySelector('[data-testid="stock-prep-project-sync-run"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-sync-denied"]')).toBeNull()
  })

  it('P-01: the stock-prep OPERATOR tier gets no sync control, and is told who runs it', () => {
    // The exact grant a customer operator holds: R-11's mapping is zero-automatic, so this principal
    // has no `integration:*` code at all and the server refuses them at the first call.
    h.permissions = ['stock-prep:read', 'stock-prep:operate']
    const root = mountPanel({ api: api() })
    expect(root.querySelector('[data-testid="stock-prep-project-sync-run"]')).toBeNull()
    const denied = root.querySelector('[data-testid="stock-prep-project-sync-denied"]') as HTMLElement
    expect(denied).not.toBeNull()
    expect(denied.textContent).toContain('平台管理员')
  })

  it('P-01: neither the workbench-admin nor the integration:write tier gets it either', () => {
    for (const permissions of [['stock-prep:admin'], ['integration:write'], ['integration:read'], []]) {
      h.permissions = permissions
      const root = mountPanel({ api: api() })
      expect(root.querySelector('[data-testid="stock-prep-project-sync-run"]')).toBeNull()
      expect(root.querySelector('[data-testid="stock-prep-project-sync-denied"]')).not.toBeNull()
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
