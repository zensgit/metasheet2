import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp, type Component } from 'vue'
import IntegrationFieldOptionSyncPanel from '../src/components/integration/IntegrationFieldOptionSyncPanel.vue'
import { useLocale } from '../src/composables/useLocale'

// IU-2d (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-2,
// stage D — run-push decomposition): structural smoke test for the extracted field-option-sync
// admin panel. The raw `optionSets JSON` textarea (`stock-option-sync-json`) is deliberately kept
// as-is — structuring it was IU-5's gated job. D2 below is that slice (site 5, structured editor);
// its own tests are appended after the pre-existing (ADD-ONLY, zero-assertion-change) block. The
// four pre-existing tests above the D2 `describe` still pass exactly as written, byte-for-byte
// unmodified: `v-show` (not `v-if`) keeps the textarea reachable/queryable regardless of which
// edit mode is active.

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

  // Only for tests that need a REAL two-way `stockPreparationOptionSyncText` round trip (edit the
  // textarea -> parent ref updates -> child prop reflects it on next render), mirroring how
  // `IntegrationWorkbenchView.vue`'s actual `v-model:stock-preparation-option-sync-text` binds a
  // real ref (unlike `mountPanel`'s static-props + spy harness, which only records emitted calls
  // without feeding them back into the prop).
  async function mountPanelReactive(props: Record<string, unknown>, initialText: string): Promise<{ text: ReturnType<typeof ref<string>> }> {
    container = document.createElement('div')
    document.body.appendChild(container)
    const text = ref(initialText)
    const Host = defineComponent({
      setup() {
        return () => h(IntegrationFieldOptionSyncPanel as unknown as Component, {
          ...props,
          stockPreparationOptionSyncText: text.value,
          'onUpdate:stockPreparationOptionSyncText': (value: string) => { text.value = value },
        })
      },
    })
    app = createApp(Host)
    app.mount(container)
    await nextTick()
    return { text }
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

  // D2 (site 5 of IU-5): structured editor default + expert-JSON toggle. ADD-ONLY — nothing above
  // this line was changed.
  describe('D2 structured editor + expert toggle', () => {
    // useLocale()'s jsdom-resolved default is 'en' (no `metasheet_locale` in localStorage, no
    // zh-ish `navigator.language`) — pin zh-CN explicitly for this describe block's zh-text
    // assertions, same convention as approvalMobileI18n.spec.ts's `useLocale().setLocale(...)`.
    // Reset afterward so it can't leak into other spec files sharing the same module-level state.
    beforeEach(() => {
      useLocale().setLocale('zh-CN')
    })
    afterEach(() => {
      useLocale().setLocale('en')
    })

    it('defaults to structured mode with a structurable (blank) starting document', async () => {
      await mountPanel(baseProps())
      expect(container?.querySelector('[data-testid="option-sets-structured-editor"]')).toBeTruthy()
      expect(container?.querySelector('[data-testid="field-options-mode-toggle"]')?.textContent).toContain('切换到专家 JSON')
      // the expert textarea is still reachable (v-show), just not the active mode
      expect(container?.querySelector('[data-testid="stock-option-sync-json"]')?.tagName).toBe('TEXTAREA')
    })

    it('toggles to expert mode and shows the JsonAssist strip beside the textarea', async () => {
      await mountPanel(baseProps())
      const toggle = container?.querySelector<HTMLButtonElement>('[data-testid="field-options-mode-toggle"]')
      expect(toggle?.disabled).toBe(false)
      toggle?.click()
      await nextTick()
      expect(container?.querySelector('[data-testid="option-sets-structured-editor"]')).toBeNull()
      expect(container?.querySelector('[data-testid="stock-option-sync-json-json-assist"]')).toBeTruthy()
      expect(toggle?.textContent).toContain('切换到结构化编辑')
    })

    it('toggling structured -> expert -> structured round-trips a well-formed edit', async () => {
      const source = JSON.stringify({ optionSets: { material_type: [{ value: 'plate', label: 'Plate' }] } }, null, 2)
      await mountPanel(baseProps({ stockPreparationOptionSyncText: source }))
      const toggle = container?.querySelector<HTMLButtonElement>('[data-testid="field-options-mode-toggle"]')
      toggle?.click() // -> expert
      await nextTick()
      toggle?.click() // -> structured again (current text is still the same structurable source)
      await nextTick()
      expect(container?.querySelector('[data-testid="option-sets-structured-editor"]')).toBeTruthy()
      expect(container?.querySelector('[data-testid="option-sets-row-key-0"]')).toHaveProperty('value', 'material_type')
    })

    it('starts in expert mode (forced) when the initial document is not structurable, and disables switching back', async () => {
      await mountPanel(baseProps({ stockPreparationOptionSyncText: '{ not valid json' }))
      expect(container?.querySelector('[data-testid="option-sets-structured-editor"]')).toBeNull()
      expect(container?.querySelector('[data-testid="stock-option-sync-json"]')?.tagName).toBe('TEXTAREA')
      const toggle = container?.querySelector<HTMLButtonElement>('[data-testid="field-options-mode-toggle"]')
      expect(toggle?.disabled).toBe(true)
      expect(container?.querySelector('[data-testid="field-options-structured-unavailable-hint"]')).toBeTruthy()
    })

    it('does not silently drop the malformed text: it stays exactly in the model/textarea', async () => {
      const malformed = '{ "optionSets": { "material_type": [ { "value": "plate" '
      const onUpdateSyncText = vi.fn(noopFn)
      await mountPanel(baseProps({ stockPreparationOptionSyncText: malformed, 'onUpdate:stockPreparationOptionSyncText': onUpdateSyncText }))
      const textarea = container?.querySelector<HTMLTextAreaElement>('[data-testid="stock-option-sync-json"]')
      expect(textarea?.value).toBe(malformed)
      // no forced rewrite of the model on mount
      expect(onUpdateSyncText).not.toHaveBeenCalled()
    })

    it('re-enables the toggle once the expert-mode text is fixed into a structurable shape', async () => {
      // Needs a REAL two-way model round trip (edit -> parent ref updates -> child prop reflects
      // it), which `mountPanel`'s static-props harness doesn't simulate — see
      // `mountPanelReactive`'s own comment.
      await mountPanelReactive(baseProps(), '{ not valid json')
      const textarea = container?.querySelector<HTMLTextAreaElement>('[data-testid="stock-option-sync-json"]')
      const fixed = JSON.stringify({ optionSets: { material_type: [{ value: 'plate', label: 'Plate' }] } })
      if (textarea) {
        textarea.value = fixed
        textarea.dispatchEvent(new Event('input'))
      }
      await nextTick()
      await nextTick()
      const toggle = container?.querySelector<HTMLButtonElement>('[data-testid="field-options-mode-toggle"]')
      expect(toggle?.disabled).toBe(false)
      expect(container?.querySelector('[data-testid="field-options-structured-unavailable-hint"]')).toBeNull()
    })

    it('SENTINEL: a secret-shaped value in malformed JSON never leaks into the unavailable-mode hint', async () => {
      const secret = 'sk-SECRET-TOKEN-do-not-leak-9f8e7d6c5b4a'
      await mountPanel(baseProps({ stockPreparationOptionSyncText: `{"optionSets": ${secret}}` }))
      const hint = container?.querySelector('[data-testid="field-options-structured-unavailable-hint"]')
      expect(hint).toBeTruthy()
      expect(hint?.textContent ?? '').not.toContain(secret)
      // No other rendered hint/label text surface (the textarea's own .value DOM property is
      // intentionally excluded — that's the field itself echoing the user's own input back at
      // them, not a leak into a *validation/error* line) echoes the secret either.
      const toggle = container?.querySelector('[data-testid="field-options-mode-toggle"]')
      const boundary = container?.querySelector('[data-testid="stock-option-sync-boundary"]')
      expect(toggle?.textContent ?? '').not.toContain(secret)
      expect(boundary?.textContent ?? '').not.toContain(secret)
    })

    it('zh: the mode toggle and unavailable hint render zh-CN copy by default', async () => {
      await mountPanel(baseProps({ stockPreparationOptionSyncText: '{ not valid json' }))
      expect(container?.querySelector('[data-testid="field-options-mode-toggle"]')?.textContent).toContain('切换到结构化编辑')
      expect(container?.querySelector('[data-testid="field-options-structured-unavailable-hint"]')?.textContent).toContain('结构化编辑器')
    })
  })
})
