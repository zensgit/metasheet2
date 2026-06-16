// B1-b: MetaCellRenderer button-field cell render + click→run emit.
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, type App } from 'vue'
import MetaCellRenderer from '../src/multitable/components/cells/MetaCellRenderer.vue'
import type { MetaField } from '../src/multitable/types'

let app: App<Element> | null = null
let container: HTMLDivElement | null = null
afterEach(() => { app?.unmount(); app = null; container?.remove(); container = null })

function mount(field: MetaField, extra: Record<string, unknown> = {}) {
  const runs: number[] = []
  container = document.createElement('div'); document.body.appendChild(container)
  app = createApp({
    setup: () => () => h(MetaCellRenderer, { field, value: undefined, ...extra, onRun: () => runs.push(1) }),
  })
  app.mount(container)
  return { runs, root: container, btn: () => container!.querySelector<HTMLButtonElement>('[data-test="cell-button"]')! }
}

const buttonField = (property: Record<string, unknown> = {}): MetaField =>
  ({ id: 'f1', name: 'Do it', type: 'button', property } as unknown as MetaField)

describe('MetaCellRenderer — button field (B1-b)', () => {
  it('renders a button with the property label + variant class', () => {
    const { btn } = mount(buttonField({ label: 'Approve', variant: 'primary' }))
    expect(btn().textContent?.trim()).toBe('Approve')
    expect(btn().classList.contains('meta-cell-renderer__button--primary')).toBe(true)
    expect(btn().getAttribute('aria-label')).toBe('Approve')
  })

  it('falls back to the field name when label is empty (non-empty accessible name)', () => {
    const { btn } = mount(buttonField({}))
    expect(btn().textContent?.trim()).toBe('Do it')
    expect(btn().getAttribute('aria-label')).toBe('Do it')
    // unknown/empty variant → secondary default
    expect(btn().classList.contains('meta-cell-renderer__button--secondary')).toBe(true)
  })

  it('emits run on click', () => {
    const { btn, runs } = mount(buttonField({ label: 'Go' }))
    btn().click()
    expect(runs).toEqual([1])
  })

  it('disables the button and emits nothing while pending', () => {
    const { btn, runs } = mount(buttonField({ label: 'Go' }), { buttonPending: true })
    expect(btn().disabled).toBe(true)
    btn().click()
    expect(runs).toEqual([])
  })
})
