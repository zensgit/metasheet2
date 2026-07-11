import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp, type Component } from 'vue'
import IntegrationStockPrepPanel from '../src/components/integration/IntegrationStockPrepPanel.vue'

// IU-2d (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-2,
// stage D — run-push decomposition): structural smoke test for the extracted stock-preparation S1
// admin panel. The `integration:admin` gate lives on this component's own root `v-if`
// (`hasIntegrationAdmin` prop, parent passes `auth.hasPermission('integration:admin')` verbatim) —
// the negative case is pinned here at component level in addition to the parent view spec's
// end-to-end panel-absent-without-permission assertion.

describe('IntegrationStockPrepPanel (unit)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  async function mountPanel(props: Record<string, unknown>): Promise<void> {
    container = document.createElement('div')
    document.body.appendChild(container)
    const Host = defineComponent({
      setup() {
        return () => h(IntegrationStockPrepPanel as unknown as Component, props)
      },
    })
    app = createApp(Host)
    app.mount(container)
    await nextTick()
  }

  const noopFn = (..._args: unknown[]): unknown => undefined

  function baseProps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      hasIntegrationAdmin: true,
      stockPreparationTargetRunning: '',
      stockPreparationTargetResult: null,
      stockPreparationTargetSummary: '尚未检查标准备料表 readiness。',
      stockPreparationTargetMetrics: [],
      stockPreparationTargetEvidenceText: '',
      checkStockPreparationTargetReadiness: vi.fn(noopFn),
      ensureStockPreparationTarget: vi.fn(noopFn),
      stockPreparationTargetBaseId: '',
      'onUpdate:stockPreparationTargetBaseId': vi.fn(noopFn),
      ...overrides,
    }
  }

  it('renders the panel, boundary hint, and both admin actions when integration:admin is granted', async () => {
    await mountPanel(baseProps())
    expect(container?.querySelector('[data-testid="stock-preparation-s1-panel"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="stock-preparation-s1-boundary"]')?.textContent).toContain('不读取 PLM')
    expect(container?.querySelector('[data-testid="stock-preparation-s1-readiness"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="stock-preparation-s1-ensure"]')).toBeTruthy()
  })

  it('renders NOTHING without integration:admin (permission-gate negative)', async () => {
    await mountPanel(baseProps({ hasIntegrationAdmin: false }))
    expect(container?.querySelector('[data-testid="stock-preparation-s1-panel"]')).toBeNull()
    expect(container?.querySelector('[data-testid="stock-preparation-s1-readiness"]')).toBeNull()
    expect(container?.querySelector('[data-testid="stock-preparation-s1-base-id"]')).toBeNull()
  })

  it('forwards readiness / ensure clicks to the prop functions', async () => {
    const checkStockPreparationTargetReadiness = vi.fn(noopFn)
    const ensureStockPreparationTarget = vi.fn(noopFn)
    await mountPanel(baseProps({ checkStockPreparationTargetReadiness, ensureStockPreparationTarget }))
    container?.querySelector<HTMLButtonElement>('[data-testid="stock-preparation-s1-readiness"]')?.click()
    container?.querySelector<HTMLButtonElement>('[data-testid="stock-preparation-s1-ensure"]')?.click()
    await nextTick()
    expect(checkStockPreparationTargetReadiness).toHaveBeenCalledTimes(1)
    expect(ensureStockPreparationTarget).toHaveBeenCalledTimes(1)
  })

  it('forwards base-id input through update:stockPreparationTargetBaseId (defineModel wiring)', async () => {
    const onUpdateBaseId = vi.fn(noopFn)
    await mountPanel(baseProps({ 'onUpdate:stockPreparationTargetBaseId': onUpdateBaseId }))
    const input = container?.querySelector<HTMLInputElement>('[data-testid="stock-preparation-s1-base-id"]')
    expect(input).toBeTruthy()
    if (input) {
      input.value = 'base_123'
      input.dispatchEvent(new Event('input'))
    }
    await nextTick()
    expect(onUpdateBaseId).toHaveBeenCalledWith('base_123')
  })
})
