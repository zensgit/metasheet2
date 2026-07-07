import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp, type Component } from 'vue'
import IntegrationFieldOptionSyncPanel from '../src/components/integration/IntegrationFieldOptionSyncPanel.vue'

// IU-2d (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-2,
// stage D — run-push decomposition): structural smoke test for the extracted field-option-sync
// admin panel. The raw `optionSets JSON` textarea (`stock-option-sync-json`) is deliberately kept
// as-is — structuring it is IU-5's gated job — so this spec pins that it stays a plain <textarea>.

describe('IntegrationFieldOptionSyncPanel (unit)', () => {
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
        return () => h(IntegrationFieldOptionSyncPanel as unknown as Component, props)
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
      fieldOptionSyncPresets: [
        { presetId: 'preset.stock-preparation.v1', label: '备料选项同步 / Stock Preparation' },
      ],
      stockPreparationOptionSyncPlaceholder: '{}',
      stockPreparationOptionSyncCanRun: false,
      syncingStockPreparationOptions: false,
      fieldOptionSyncPathNote: '',
      stockPreparationOptionSyncEvidenceText: '',
      syncFieldOptions: vi.fn(noopFn),
      fieldOptionSyncPresetId: 'preset.stock-preparation.v1',
      stockPreparationOptionSyncText: '',
      'onUpdate:stockPreparationOptionSyncText': vi.fn(noopFn),
      ...overrides,
    }
  }

  it('renders the panel with the preset picker and the RAW optionSets JSON textarea (IU-5 boundary)', async () => {
    await mountPanel(baseProps())
    expect(container?.querySelector('[data-testid="stock-option-sync-panel"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="field-options-preset"]')).toBeTruthy()
    const jsonInput = container?.querySelector('[data-testid="stock-option-sync-json"]')
    expect(jsonInput).toBeTruthy()
    // must stay a plain textarea until IU-5 restructures it behind its own gate
    expect(jsonInput?.tagName).toBe('TEXTAREA')
    expect(container?.querySelector('[data-testid="stock-option-sync-boundary"]')?.textContent).toContain('不接受 SQL/JS/URL/function body')
  })

  it('renders NOTHING without integration:admin (permission-gate negative)', async () => {
    await mountPanel(baseProps({ hasIntegrationAdmin: false }))
    expect(container?.querySelector('[data-testid="stock-option-sync-panel"]')).toBeNull()
    expect(container?.querySelector('[data-testid="stock-option-sync-json"]')).toBeNull()
    expect(container?.querySelector('[data-testid="field-options-sync-run"]')).toBeNull()
  })

  it('honours the can-run disable gate and forwards the sync click', async () => {
    const syncFieldOptions = vi.fn(noopFn)
    await mountPanel(baseProps({ syncFieldOptions, stockPreparationOptionSyncCanRun: true }))
    const button = container?.querySelector<HTMLButtonElement>('[data-testid="field-options-sync-run"]')
    expect(button?.disabled).toBe(false)
    button?.click()
    await nextTick()
    expect(syncFieldOptions).toHaveBeenCalledTimes(1)
  })

  it('forwards textarea edits through update:stockPreparationOptionSyncText (defineModel wiring)', async () => {
    const onUpdateSyncText = vi.fn(noopFn)
    await mountPanel(baseProps({ 'onUpdate:stockPreparationOptionSyncText': onUpdateSyncText }))
    const textarea = container?.querySelector<HTMLTextAreaElement>('[data-testid="stock-option-sync-json"]')
    expect(textarea).toBeTruthy()
    if (textarea) {
      textarea.value = '{"optionSets":{}}'
      textarea.dispatchEvent(new Event('input'))
    }
    await nextTick()
    expect(onUpdateSyncText).toHaveBeenCalledWith('{"optionSets":{}}')
  })
})
