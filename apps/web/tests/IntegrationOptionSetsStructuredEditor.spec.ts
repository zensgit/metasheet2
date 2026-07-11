import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp, type Component } from 'vue'
import IntegrationOptionSetsStructuredEditor from '../src/components/integration/IntegrationOptionSetsStructuredEditor.vue'
import { useLocale } from '../src/composables/useLocale'

// D2 (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-5, site 5):
// isolation tests for the optionSets repeatable-row structured editor. Same light createApp/h
// harness pattern as JsonAssist.spec.ts / IntegrationFieldOptionSyncPanel.spec.ts. Pure
// parse/serialize contract coverage lives in tests/utils/optionSetsStructured.spec.ts — these
// tests exercise the same contract through real DOM interactions (typing, clicking add/remove).
describe('IntegrationOptionSetsStructuredEditor (unit)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    // useLocale()'s locale is module-level singleton state shared across spec files in the same
    // worker — reset after every test so only the dedicated zh test (below) opts into zh-CN.
    useLocale().setLocale('en')
  })

  async function mount(props: Record<string, unknown>): Promise<void> {
    container = document.createElement('div')
    document.body.appendChild(container)
    const Host = defineComponent({
      setup() {
        return () => h(IntegrationOptionSetsStructuredEditor as unknown as Component, props)
      },
    })
    app = createApp(Host)
    app.mount(container)
    await nextTick()
  }

  function baseProps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      modelValue: '',
      'onUpdate:modelValue': vi.fn(),
      ...overrides,
    }
  }

  function typeInto(testId: string, value: string): void {
    const input = container?.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)
    expect(input, `expected input ${testId} to exist`).toBeTruthy()
    if (!input) return
    input.value = value
    input.dispatchEvent(new Event('input'))
  }

  it('renders the empty-state hint with zero rows on a fresh (blank) document', async () => {
    await mount(baseProps())
    expect(container?.querySelector('[data-testid="option-sets-structured-editor"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="option-sets-empty-hint"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="option-sets-row-0"]')).toBeNull()
  })

  it('BYTE-EQUALITY: add field + add option + fill value/label serializes to the SAME JSON the raw textarea would hold', async () => {
    const onUpdate = vi.fn()
    await mount(baseProps({ 'onUpdate:modelValue': onUpdate }))

    container?.querySelector<HTMLButtonElement>('[data-testid="option-sets-add-row"]')?.click()
    await nextTick()
    typeInto('option-sets-row-key-0', 'material_type')
    await nextTick()
    container?.querySelector<HTMLButtonElement>('[data-testid="option-sets-option-add-0"]')?.click()
    await nextTick()
    typeInto('option-sets-option-value-0-0', 'plate')
    await nextTick()
    typeInto('option-sets-option-label-0-0', 'Plate')
    await nextTick()

    const finalText = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0] as string
    // What a user directly typing the same shape into the raw textarea (and formatting it via
    // JsonAssist / JSON.stringify(_, null, 2), the canonical form used app-wide) would hold.
    const expected = JSON.stringify({ optionSets: { material_type: [{ value: 'plate', label: 'Plate' }] } }, null, 2)
    expect(finalText).toBe(expected)
  })

  it('adds a second field row and a second option on an existing row', async () => {
    const source = JSON.stringify({ optionSets: { material_type: [{ value: 'plate', label: 'Plate' }] } }, null, 2)
    const onUpdate = vi.fn()
    await mount(baseProps({ modelValue: source, 'onUpdate:modelValue': onUpdate }))

    expect(container?.querySelector('[data-testid="option-sets-row-0"]')).toBeTruthy()
    container?.querySelector<HTMLButtonElement>('[data-testid="option-sets-option-add-0"]')?.click()
    await nextTick()
    typeInto('option-sets-option-value-0-1', 'bar')
    await nextTick()
    typeInto('option-sets-option-label-0-1', 'Bar')
    await nextTick()

    container?.querySelector<HTMLButtonElement>('[data-testid="option-sets-add-row"]')?.click()
    await nextTick()
    typeInto('option-sets-row-key-1', 'blank_type')
    await nextTick()
    container?.querySelector<HTMLButtonElement>('[data-testid="option-sets-option-add-1"]')?.click()
    await nextTick()
    typeInto('option-sets-option-value-1-0', 'casting')
    await nextTick()
    typeInto('option-sets-option-label-1-0', 'Casting')
    await nextTick()

    const finalText = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0] as string
    expect(JSON.parse(finalText)).toEqual({
      optionSets: {
        material_type: [{ value: 'plate', label: 'Plate' }, { value: 'bar', label: 'Bar' }],
        blank_type: [{ value: 'casting', label: 'Casting' }],
      },
    })
  })

  it('removes an option and removes a field row', async () => {
    const source = JSON.stringify({
      optionSets: {
        material_type: [{ value: 'plate', label: 'Plate' }, { value: 'bar', label: 'Bar' }],
        blank_type: [{ value: 'casting', label: 'Casting' }],
      },
    }, null, 2)
    const onUpdate = vi.fn()
    await mount(baseProps({ modelValue: source, 'onUpdate:modelValue': onUpdate }))

    container?.querySelector<HTMLButtonElement>('[data-testid="option-sets-option-remove-0-1"]')?.click()
    await nextTick()
    container?.querySelector<HTMLButtonElement>('[data-testid="option-sets-row-remove-1"]')?.click()
    await nextTick()

    const finalText = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0] as string
    expect(JSON.parse(finalText)).toEqual({
      optionSets: { material_type: [{ value: 'plate', label: 'Plate' }] },
    })
  })

  it('preserves unmodeled extra option keys (actionBindings) through an unrelated edit', async () => {
    const source = JSON.stringify({
      optionSets: {
        stock_preparation_status: [
          { value: 'pending', label: 'Pending', actionBindings: [{ actionId: 'plm.stock-preparation.pull-bom.v1' }] },
        ],
      },
    }, null, 2)
    const onUpdate = vi.fn()
    await mount(baseProps({ modelValue: source, 'onUpdate:modelValue': onUpdate }))

    // Add an unrelated second field row — the untouched entry's actionBindings must survive.
    container?.querySelector<HTMLButtonElement>('[data-testid="option-sets-add-row"]')?.click()
    await nextTick()
    typeInto('option-sets-row-key-1', 'material_type')
    await nextTick()

    const finalText = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0] as string
    const parsed = JSON.parse(finalText)
    expect(parsed.optionSets.stock_preparation_status[0]).toEqual({
      value: 'pending',
      label: 'Pending',
      actionBindings: [{ actionId: 'plm.stock-preparation.pull-bom.v1' }],
    })
  })

  it('shows a duplicate-field-key warning without blocking edits, and clears it once renamed', async () => {
    await mount(baseProps())
    container?.querySelector<HTMLButtonElement>('[data-testid="option-sets-add-row"]')?.click()
    await nextTick()
    container?.querySelector<HTMLButtonElement>('[data-testid="option-sets-add-row"]')?.click()
    await nextTick()
    typeInto('option-sets-row-key-0', 'material_type')
    await nextTick()
    typeInto('option-sets-row-key-1', 'material_type')
    await nextTick()
    expect(container?.querySelector('[data-testid="option-sets-duplicate-warning"]')).toBeTruthy()

    typeInto('option-sets-row-key-1', 'blank_type')
    await nextTick()
    expect(container?.querySelector('[data-testid="option-sets-duplicate-warning"]')).toBeNull()
  })

  it('SENTINEL: a secret-shaped option value never leaks into the duplicate-warning hint text', async () => {
    const secret = 'sk-SECRET-TOKEN-do-not-leak-9f8e7d6c5b4a'
    await mount(baseProps())
    container?.querySelector<HTMLButtonElement>('[data-testid="option-sets-add-row"]')?.click()
    await nextTick()
    container?.querySelector<HTMLButtonElement>('[data-testid="option-sets-add-row"]')?.click()
    await nextTick()
    typeInto('option-sets-row-key-0', 'material_type')
    await nextTick()
    typeInto('option-sets-row-key-1', 'material_type')
    await nextTick()
    container?.querySelector<HTMLButtonElement>('[data-testid="option-sets-option-add-0"]')?.click()
    await nextTick()
    typeInto('option-sets-option-value-0-0', secret)
    await nextTick()

    const warning = container?.querySelector('[data-testid="option-sets-duplicate-warning"]')
    expect(warning).toBeTruthy()
    expect(warning?.textContent ?? '').not.toContain(secret)
  })

  it('zh: renders zh-CN copy when the locale is zh-CN', async () => {
    // useLocale()'s jsdom-resolved default is 'en' (no `metasheet_locale` in localStorage, no
    // zh-ish `navigator.language`) — pin zh-CN explicitly, same convention as
    // approvalMobileI18n.spec.ts's `useLocale().setLocale(...)`. Reset in this file's shared
    // afterEach.
    useLocale().setLocale('zh-CN')
    await mount(baseProps())
    expect(container?.querySelector('[data-testid="option-sets-empty-hint"]')?.textContent).toContain('还没有字段')
    container?.querySelector<HTMLButtonElement>('[data-testid="option-sets-add-row"]')?.click()
    await nextTick()
    expect(container?.querySelector('[data-testid="option-sets-row-remove-0"]')?.textContent).toContain('删除字段')
  })
})
