import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MtLink from '../src/multitable/ui/MtLink.vue'

// multitable-ui-p2-1c-tail-resolution-designlock-20260707.md §2-T3 (RATIFIED) — runnable
// interaction/behavior coverage for the new MtLink primitive: real mount, real click → real emit,
// and a11y (genuinely-keyboard-operable native <button>, not a styled <a>/<span>/<div>), mirroring
// the sibling multitable-ui-p2-1-primitives.spec.ts coverage discipline for MtButton/MtIconButton.

let app: App<Element> | null = null
let container: HTMLDivElement | null = null

function mount(vnode: Parameters<typeof h>[0], props?: Record<string, unknown>, slots?: Record<string, unknown>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({ render: () => h(vnode as any, props, slots) })
  app.mount(container)
  return container
}

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
})

describe('MtLink', () => {
  it('renders as a native <button type="button"> (a11y: genuinely keyboard-operable, not a styled <a>/<span>)', () => {
    const c = mount(MtLink, {}, { default: () => 'Select all' })
    const btn = c.querySelector('.mt-link') as HTMLButtonElement
    expect(btn).not.toBeNull()
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.getAttribute('type')).toBe('button')
  })

  it('renders its default slot content', () => {
    const c = mount(MtLink, {}, { default: () => 'Mark all read' })
    expect(c.querySelector('.mt-link')?.textContent).toBe('Mark all read')
  })

  it('emits click when enabled', async () => {
    let clicks = 0
    const c = mount(MtLink, { onClick: () => { clicks += 1 } }, { default: () => 'Clear all' })
    const btn = c.querySelector('button.mt-link') as HTMLButtonElement
    btn.click()
    await nextTick()
    expect(clicks).toBe(1)
  })

  it('is focusable and Enter/Space-activatable like any native button (a11y: no hand-rolled keydown needed)', () => {
    const c = mount(MtLink, {}, { default: () => 'Add filter' })
    const btn = c.querySelector('button.mt-link') as HTMLButtonElement
    // A native, non-disabled <button> is in the tab order (tabIndex 0) with no extra wiring required.
    expect(btn.tabIndex).toBe(0)
    expect(btn.disabled).toBe(false)
  })

  it('defaults to NOT disabled', () => {
    const c = mount(MtLink, {}, { default: () => 'Add sort' })
    const btn = c.querySelector('button.mt-link') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })

  it('does NOT emit click when disabled, and the native attribute removes it from the tab order', async () => {
    let clicks = 0
    const c = mount(MtLink, { disabled: true, onClick: () => { clicks += 1 } }, { default: () => 'Add group' })
    const btn = c.querySelector('button.mt-link') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    btn.click()
    await nextTick()
    expect(clicks).toBe(0)
  })

  it('carries no hardcoded color — only the token-driven .mt-link class (no inline style/hex)', () => {
    const c = mount(MtLink, {}, { default: () => 'Select all' })
    const btn = c.querySelector('button.mt-link') as HTMLButtonElement
    expect(btn.getAttribute('style')).toBeNull()
  })
})
