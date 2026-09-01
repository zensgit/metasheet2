import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'

// 大 BOM 后台通道 — the PANEL half. Mounted only when a run's 试算 SKIPped with
// `PLAN_LARGE_BOM_BOUNDED` (see StockPreparationProjectSyncPanel.spec.ts's own large-BOM test for
// that wiring); THIS suite pins what happens once it exists:
//
//   D-01 it starts driving the background channel on mount and renders every phase it reaches.
//   D-02 a `done` terminal state shows the SAME "open the multitable" affordance the small-BOM path
//        shows on a successful import, and clicking it emits the SAME event.
//   D-03 a `failed` terminal state renders the PLAIN-LANGUAGE fallback, never a raw server code —
//        the code still shows in the technical disclosure, for someone who has to ask for help.
//   D-04 `confirm_required` renders its own honest message and shows NO deep link (nothing landed).
//   D-05 polling stops on unmount: no further API calls or renders once the component is gone.

const h = vi.hoisted(() => ({ locale: 'zh-CN' as string }))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: ref(h.locale),
    isZh: ref(h.locale === 'zh-CN'),
    setLocale: vi.fn(),
  }),
}))

import StockPreparationLargeBomPullPanel from '../src/components/integration/stockPreparation/StockPreparationLargeBomPullPanel.vue'
import {
  StockPreparationProjectSyncCallError,
  type StockPreparationLargeBomApplyJob,
  type StockPreparationLargeBomExpansionJob,
  type StockPreparationLargeBomJobApi,
} from '../src/services/integration/stockPreparation/largeBomPull'

const PROJECT_NO = 'P2026-999'

function instantWait(): (ms: number) => Promise<void> {
  return vi.fn().mockResolvedValue(undefined)
}

function expansionJob(overrides: Partial<StockPreparationLargeBomExpansionJob> = {}): StockPreparationLargeBomExpansionJob {
  return { jobId: 'large-bom-expansion-9', status: 'queued', authoritative: false, ...overrides }
}

function applyJob(overrides: Partial<StockPreparationLargeBomApplyJob> = {}): StockPreparationLargeBomApplyJob {
  return {
    jobId: 'large-bom-apply-9',
    status: 'queued',
    counts: { created: 0, updated: 0, inactive: 0, skipped: 0, held: 0, failed: 0 },
    ...overrides,
  }
}

function doneApi(overrides: Partial<StockPreparationLargeBomJobApi> = {}): StockPreparationLargeBomJobApi {
  return {
    startExpansion: vi.fn().mockResolvedValue(expansionJob()),
    runExpansion: vi.fn().mockResolvedValue(expansionJob({
      status: 'completed',
      authoritative: true,
      progress: { rowsExpanded: 900, readCount: 950, frontierRemaining: 0, completedChunks: 1 },
      budgets: { maxRows: 1000, maxPages: 10, maxReadCount: 1200, maxElapsedMs: 30000, maxDepth: 10, maxArtifactChunks: 1 },
    })),
    planExpansion: vi.fn().mockResolvedValue(expansionJob({
      status: 'completed',
      authoritative: true,
      evidence: { plan: { counts: { add: 90, update: 10, skip: 0, inactive: 0, manual_confirm: 0 } } },
    })),
    startApply: vi.fn().mockResolvedValue(applyJob()),
    runApplyChunk: vi.fn().mockResolvedValue(applyJob({
      status: 'succeeded',
      counts: { created: 90, updated: 10, inactive: 0, skipped: 0, held: 0, failed: 0 },
    })),
    ...overrides,
  } as StockPreparationLargeBomJobApi
}

async function flushUi(cycles = 8): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('StockPreparationLargeBomPullPanel', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    h.locale = 'zh-CN'
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
    app = createApp(StockPreparationLargeBomPullPanel as Component, { projectNo: PROJECT_NO, wait: instantWait(), ...props })
    app.mount(container!)
    return container!
  }

  /** `data-phase` lives on the component's own root `<section>`, a child of the mount container. */
  function phaseOf(root: HTMLElement): string | null {
    return root.querySelector('[data-testid="stock-prep-large-bom-pull"]')?.getAttribute('data-phase') ?? null
  }

  // ---- D-01 --------------------------------------------------------------------------------
  it('D-01: starts on mount and reaches done with progress rendered along the way', async () => {
    const api = doneApi()
    const root = mountPanel({ api })
    await flushUi()

    expect(phaseOf(root)).toBe('done')
    expect(api.startExpansion).toHaveBeenCalledWith(PROJECT_NO)

    const percent = root.querySelector('[data-testid="stock-prep-large-bom-percent"]') as HTMLElement
    expect(percent).not.toBeNull()
    expect(percent.textContent).toContain('90%') // 900 / 1000

    const counts = root.querySelector('[data-testid="stock-prep-large-bom-apply-counts"]') as HTMLElement
    expect(counts).not.toBeNull()
    expect(counts.textContent).toContain('90')
  })

  // ---- D-02 --------------------------------------------------------------------------------
  it('D-02: done shows the open-multitable affordance and emits the same event on click', async () => {
    const api = doneApi()
    const onOpenMultitable = vi.fn()
    const root = mountPanel({ api, onOpenMultitable })
    await flushUi()

    const link = root.querySelector('[data-testid="stock-prep-large-bom-open-multitable"]') as HTMLButtonElement
    expect(link).not.toBeNull()
    link.click()
    expect(onOpenMultitable).toHaveBeenCalledTimes(1)
  })

  it('D-02: no open-multitable link renders before done', async () => {
    const api = doneApi({
      // Never resolves within this test's window — stays mid-flight.
      runExpansion: vi.fn(() => new Promise(() => {})),
    })
    const root = mountPanel({ api })
    await flushUi(3)
    expect(root.querySelector('[data-testid="stock-prep-large-bom-open-multitable"]')).toBeNull()
    expect(phaseOf(root)).toBe('expanding')
  })

  // ---- D-03 --------------------------------------------------------------------------------
  it('D-03: a failed run renders the plain-language fallback, never a raw code, which still appears in the disclosure', async () => {
    const api = doneApi({
      startApply: vi.fn().mockRejectedValue(
        new StockPreparationProjectSyncCallError(500, 'apply-jobs', { code: 'LARGE_BOM_APPLY_TARGET_REQUIRED' }),
      ),
    })
    const root = mountPanel({ api })
    await flushUi()

    expect(phaseOf(root)).toBe('failed')
    const status = root.querySelector('[data-testid="stock-prep-large-bom-status"]') as HTMLElement
    expect(status.textContent).not.toContain('LARGE_BOM_APPLY_TARGET_REQUIRED')
    expect(status.textContent).toContain('没有保存成功') // the shared generic fallback sentence
    expect(root.querySelector('[data-testid="stock-prep-large-bom-open-multitable"]')).toBeNull()

    // The raw code is not GONE — it is DEMOTED, same rule as every other panel on this workbench.
    const errorCode = root.querySelector('[data-testid="stock-prep-large-bom-tech-error-code"]') as HTMLElement
    expect(errorCode).not.toBeNull()
    expect(errorCode.textContent).toBe('LARGE_BOM_APPLY_TARGET_REQUIRED')
  })

  // ---- D-04 --------------------------------------------------------------------------------
  it('D-04: a plan holding rows for a person renders confirm_required, honestly, with no deep link', async () => {
    const api = doneApi({
      planExpansion: vi.fn().mockResolvedValue(expansionJob({
        status: 'completed',
        authoritative: true,
        evidence: { plan: { counts: { add: 1, update: 0, skip: 0, inactive: 0, manual_confirm: 3 } } },
      })),
    })
    const root = mountPanel({ api })
    await flushUi()

    expect(phaseOf(root)).toBe('confirm_required')
    const status = root.querySelector('[data-testid="stock-prep-large-bom-status"]') as HTMLElement
    expect(status.textContent).toContain('需要人工确认')
    expect(root.querySelector('[data-testid="stock-prep-large-bom-open-multitable"]')).toBeNull()
    expect(api.startApply).not.toHaveBeenCalled()
  })

  // ---- D-05 --------------------------------------------------------------------------------
  it('D-05: unmounting stops the run — no further calls once the component is gone', async () => {
    let releaseRun: ((job: StockPreparationLargeBomExpansionJob) => void) | null = null
    const runExpansion = vi.fn(() => new Promise<StockPreparationLargeBomExpansionJob>((resolve) => { releaseRun = resolve }))
    const api = doneApi({ runExpansion })
    const root = mountPanel({ api })
    await flushUi(3)
    expect(phaseOf(root)).toBe('expanding')

    app!.unmount()
    app = null
    // Let the in-flight runExpansion() resolve AFTER unmount — the run must not proceed past it.
    releaseRun?.(expansionJob({ status: 'completed', authoritative: true, progress: {}, budgets: {} }))
    await flushUi(6)

    expect(api.planExpansion).not.toHaveBeenCalled()
    expect(api.startApply).not.toHaveBeenCalled()
  })

  it('is bilingual: the English side renders the same terminal state', async () => {
    h.locale = 'en'
    const api = doneApi()
    const root = mountPanel({ api })
    await flushUi()
    const status = root.querySelector('[data-testid="stock-prep-large-bom-status"]') as HTMLElement
    expect(status.textContent).toContain('multitable')
  })
})
