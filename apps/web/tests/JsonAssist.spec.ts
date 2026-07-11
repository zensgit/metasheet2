import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp, type Component } from 'vue'
import JsonAssist from '../src/components/integration/JsonAssist.vue'

// IU-5a (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-5):
// isolation test for the shared JsonAssist strip (format button + validation status line) mounted
// beside sites 1-4's raw JSON textareas. Same light createApp/h harness pattern as
// IntegrationConnectionSection.spec.ts / IntegrationPayloadPreviewSection.spec.ts.
describe('JsonAssist (unit)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  async function mount(props: Record<string, unknown>): Promise<void> {
    container = document.createElement('div')
    document.body.appendChild(container)
    const Host = defineComponent({
      setup() {
        return () => h(JsonAssist as unknown as Component, props)
      },
    })
    app = createApp(Host)
    app.mount(container)
    await nextTick()
  }

  function baseProps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      modelValue: '{}',
      placeholderExample: '{ "<key>": "<value>" }',
      testId: 'sample-record',
      'onUpdate:modelValue': vi.fn(),
      ...overrides,
    }
  }

  it('renders the format button and status line with testId-derived data-testids', async () => {
    await mount(baseProps())
    expect(container?.querySelector('[data-testid="sample-record-json-assist"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="sample-record-json-format"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="sample-record-json-status"]')).toBeTruthy()
  })

  it('shows the values-free placeholder example and disables format when the field is empty', async () => {
    await mount(baseProps({ modelValue: '' }))
    const status = container?.querySelector('[data-testid="sample-record-json-status"]')
    expect(status?.getAttribute('data-status')).toBe('empty')
    expect(status?.textContent).toContain('{ "<key>": "<value>" }')
    const button = container?.querySelector<HTMLButtonElement>('[data-testid="sample-record-json-format"]')
    expect(button?.disabled).toBe(true)
  })

  it('shows a clean valid state and formats the model on button click', async () => {
    const onUpdate = vi.fn()
    await mount(baseProps({ modelValue: '{"a":1,"b":2}', 'onUpdate:modelValue': onUpdate }))
    const status = container?.querySelector('[data-testid="sample-record-json-status"]')
    expect(status?.getAttribute('data-status')).toBe('valid')
    const button = container?.querySelector<HTMLButtonElement>('[data-testid="sample-record-json-format"]')
    expect(button?.disabled).toBe(false)
    button?.click()
    await nextTick()
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate).toHaveBeenCalledWith('{\n  "a": 1,\n  "b": 2\n}')
  })

  it('shows an error status line on invalid JSON and disables the format button', async () => {
    await mount(baseProps({ modelValue: '{"a": 1,}' }))
    const status = container?.querySelector('[data-testid="sample-record-json-status"]')
    expect(status?.getAttribute('data-status')).toBe('invalid')
    expect(status?.textContent?.length ?? 0).toBeGreaterThan(0)
    const button = container?.querySelector<HTMLButtonElement>('[data-testid="sample-record-json-format"]')
    expect(button?.disabled).toBe(true)
  })

  it('SENTINEL: never echoes a secret-shaped value from invalid JSON into the status line', async () => {
    const secret = 'sk-SECRET-TOKEN-do-not-leak-9f8e7d6c5b4a'
    // Bareword value (not a quoted string) makes this invalid JSON, exercising the catch path;
    // V8's own SyntaxError.message would embed a snippet of exactly this text.
    await mount(baseProps({ modelValue: `{"apiKey": ${secret}}` }))
    const status = container?.querySelector('[data-testid="sample-record-json-status"]')
    expect(status?.getAttribute('data-status')).toBe('invalid')
    expect(status?.textContent ?? '').not.toContain(secret)
    expect(status?.textContent ?? '').not.toContain('SECRET-TOKEN')
    expect(container?.innerHTML ?? '').not.toContain(secret)
  })
})
