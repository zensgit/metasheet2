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
import type { StockPreparationLargeBomJobApi } from '../src/services/integration/stockPreparation/largeBomPull'

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
