import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, type App } from 'vue'
import MetaCommentComposer from '../src/multitable/components/MetaCommentComposer.vue'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c: MetaCommentComposer's submit control was migrated from a bespoke <button> to the shared
// MtButton primitive (variant="primary" = --ms-color-primary). Behavior-preservation proof: it stays a
// native, keyboard-operable <button>; the disabled binding (empty / submitting / disabled) survives; and
// clicking it still emits `submit` with the SAME { content, mentions } payload. The two other controls
// (mention-chip removal, @-suggestion item) are domain chips and stay bespoke (curated migration).

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []
afterEach(() => {
  while (mounts.length) { const m = mounts.pop()!; m.app.unmount(); m.container.remove() }
  expect(document.querySelectorAll('.meta-comment-composer').length).toBe(0) // residue guard
  useLocale().setLocale('en')
})

function mount(props: Record<string, unknown>, handlers: Record<string, unknown> = {}) {
  const container = document.createElement('div'); document.body.appendChild(container)
  const app = createApp({ setup: () => () => h(MetaCommentComposer, { ...props, ...handlers }) })
  app.mount(container)
  mounts.push({ app, container })
  return container
}

const submitBtn = (root: HTMLElement) => root.querySelector('.meta-comment-composer__submit') as HTMLButtonElement

describe('MetaCommentComposer — MtButton migration (UI-P2-1c)', () => {
  it('renders submit as a native <button>; disabled when the draft is empty', () => {
    const root = mount({ modelValue: '' })
    const btn = submitBtn(root)
    expect(btn).toBeTruthy()
    expect(btn.tagName).toBe('BUTTON') // keyboard-operable, not a bare div
    expect(btn.disabled).toBe(true) // :disabled="... || !modelValue.trim()"
  })

  it('clicking submit with a non-empty draft emits `submit` with { content, mentions } (unchanged)', () => {
    const onSubmit = vi.fn()
    const root = mount({ modelValue: 'hello world' }, { onSubmit })
    const btn = submitBtn(root)
    expect(btn.disabled).toBe(false)
    btn.click()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const payload = onSubmit.mock.calls[0][0]
    expect(typeof payload.content).toBe('string')
    expect(payload.content.length).toBeGreaterThan(0)
    expect(payload.mentions).toEqual([]) // no @-mentions selected
  })

  it('stays disabled (no emit) while submitting — disabled binding preserved through the migration', () => {
    const onSubmit = vi.fn()
    const root = mount({ modelValue: 'hello', submitting: true }, { onSubmit })
    const btn = submitBtn(root)
    expect(btn.disabled).toBe(true)
    btn.click()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
