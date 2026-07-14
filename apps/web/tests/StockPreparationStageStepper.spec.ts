import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'

// Stock Preparation UI humanization H2 (H0 plane-boundary design-lock #4202 — PLANE A ONLY).
// StockPreparationStageStepper is a pure presentational widget: it takes an already-derived
// StockPreparationStageMetric[] + coarse loading/errored flags as props and fetches nothing itself.
// Covers the four states (loading / errored / empty-ish "unknown" stub / data), the per-stage status
// rendering, the caveat markers, click-to-navigate, and the values-free contract.

const h = vi.hoisted(() => ({ locale: 'zh-CN' as string }))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: ref(h.locale),
    isZh: ref(h.locale === 'zh-CN'),
    setLocale: vi.fn(),
  }),
}))

import StockPreparationStageStepper from '../src/components/integration/stockPreparation/StockPreparationStageStepper.vue'
import type { StockPreparationStageMetric } from '../src/services/integration/stockPreparation/stageOverview'

async function flushUi(cycles = 3): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

const FULL_STAGES: StockPreparationStageMetric[] = [
  { key: 'provision', status: 'clear', count: 1, blockingCount: null },
  { key: 'sync', status: 'not_started', count: 0, blockingCount: null },
  { key: 'map', status: 'blocked', count: 5, blockingCount: 3, caveat: 'tenant_wide' },
  { key: 'unit', status: 'clear', count: 0, blockingCount: 0 },
  { key: 'generate', status: 'not_started', count: 0, blockingCount: 0 },
  { key: 'exception', status: 'blocked', count: 4, blockingCount: 2, caveat: 'display_only' },
]

describe('StockPreparationStageStepper', () => {
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

  function mount(props: Record<string, unknown>): HTMLDivElement {
    app = createApp(StockPreparationStageStepper as Component, props)
    app.mount(container!)
    return container!
  }

  it('renders only the loading state while loading is true', async () => {
    const root = mount({ stages: [], loading: true, errored: false })
    await flushUi()
    expect(root.querySelector('[data-testid="stock-prep-stage-loading"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-stage-list"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-stage-error"]')).toBeNull()
  })

  it('renders a neutral error state when errored is true, never the stage list', async () => {
    const root = mount({ stages: [], loading: false, errored: true })
    await flushUi()
    expect(root.querySelector('[data-testid="stock-prep-stage-error"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-stage-list"]')).toBeNull()
  })

  it('renders all six canonical stage slots even when the parent supplies a partial array', async () => {
    const root = mount({ stages: [FULL_STAGES[0]], loading: false, errored: false })
    await flushUi()
    const items = root.querySelectorAll('[data-testid="stock-prep-stage-item"]')
    expect(items.length).toBe(6)
    // The five missing stages fall back to the 'unknown' placeholder rather than vanishing.
    const unknownItems = root.querySelectorAll('[data-status="unknown"]')
    expect(unknownItems.length).toBe(5)
  })

  it('renders each stage in canonical pipeline order with its status/count/blocking count', async () => {
    const root = mount({ stages: FULL_STAGES, loading: false, errored: false })
    await flushUi()
    const items = Array.from(root.querySelectorAll('[data-testid="stock-prep-stage-item"]'))
    expect(items.map((el) => el.getAttribute('data-stage'))).toEqual([
      'provision', 'sync', 'map', 'unit', 'generate', 'exception',
    ])

    const mapCount = root.querySelector('[data-testid="stock-prep-stage-count-map"]') as HTMLElement
    expect(mapCount.textContent).toContain('5')
    const mapBlocking = root.querySelector('[data-testid="stock-prep-stage-blocking-map"]') as HTMLElement
    expect(mapBlocking.textContent).toContain('3')
    expect(mapBlocking.className).toContain('sp-stage__metric--warn')

    // provision has no blockingCount concept (null) — no blocking metric renders for it.
    expect(root.querySelector('[data-testid="stock-prep-stage-blocking-provision"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-stage-count-provision"]')?.textContent).toContain('1')
  })

  it('shows the forbidden copy instead of counts (and suppresses the now-moot caveat) for a forbidden stage', async () => {
    // exception in FULL_STAGES already carries caveat:'display_only' — forbidden must suppress it too,
    // since a caveat qualifies a rendered number and there is no number left to qualify.
    const stages = FULL_STAGES.map((stage) =>
      stage.key === 'exception' ? { ...stage, status: 'forbidden' as const, count: null, blockingCount: null } : stage,
    )
    const root = mount({ stages, loading: false, errored: false })
    await flushUi()
    expect(root.querySelector('[data-testid="stock-prep-stage-forbidden-exception"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-stage-count-exception"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-stage-caveat-exception"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-stage-blocking-exception"]')).toBeNull()
  })

  it('renders a caveat marker with a tooltip for tenant_wide and display_only stages', async () => {
    const root = mount({ stages: FULL_STAGES, loading: false, errored: false })
    await flushUi()
    const mapCaveat = root.querySelector('[data-testid="stock-prep-stage-caveat-map"]') as HTMLElement
    expect(mapCaveat).not.toBeNull()
    expect(mapCaveat.getAttribute('title')).toMatch(/tenant|租户/i)

    const exceptionCaveat = root.querySelector('[data-testid="stock-prep-stage-caveat-exception"]') as HTMLElement
    expect(exceptionCaveat).not.toBeNull()
    expect(exceptionCaveat.getAttribute('title')).toMatch(/generation gate|生成闸/i)

    // A stage with no caveat renders none.
    expect(root.querySelector('[data-testid="stock-prep-stage-caveat-sync"]')).toBeNull()
  })

  it('emits navigate with the stage key (not a view key) when a stage is clicked', async () => {
    const onNavigate = vi.fn()
    const root = mount({ stages: FULL_STAGES, loading: false, errored: false, onNavigate })
    await flushUi()
    ;(root.querySelector('[data-testid="stock-prep-stage-nav-map"]') as HTMLButtonElement).click()
    expect(onNavigate).toHaveBeenCalledWith('map')
    ;(root.querySelector('[data-testid="stock-prep-stage-nav-exception"]') as HTMLButtonElement).click()
    expect(onNavigate).toHaveBeenCalledWith('exception')
  })

  it('renders English labels when locale is not zh-CN', async () => {
    h.locale = 'en'
    const root = mount({ stages: FULL_STAGES, loading: false, errored: false })
    await flushUi()
    expect(root.textContent).toContain('Blocked')
    expect(root.textContent).toContain('Not started')
    expect(root.textContent).toContain('Clear')
  })

  it('is values-free: a business-looking value planted on a stage object never renders', async () => {
    const plantedDrawingNo = 'DWG-99201-C'
    const plantedMaterialName = '涡轮叶片总成'
    const poisoned = FULL_STAGES.map((stage) =>
      stage.key === 'map'
        ? ({ ...stage, drawingNo: plantedDrawingNo, materialName: plantedMaterialName } as unknown as StockPreparationStageMetric)
        : stage,
    )
    const root = mount({ stages: poisoned, loading: false, errored: false })
    await flushUi()
    const text = root.textContent || ''
    expect(text).not.toContain(plantedDrawingNo)
    expect(text).not.toContain(plantedMaterialName)
  })
})
