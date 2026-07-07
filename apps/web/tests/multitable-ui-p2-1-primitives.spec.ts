import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { Delete } from '@element-plus/icons-vue'
import MtButton from '../src/multitable/ui/MtButton.vue'
import MtIconButton from '../src/multitable/ui/MtIconButton.vue'
import MtBadge from '../src/multitable/ui/MtBadge.vue'

// multitable-ui-p2-structure-designlock-20260706.md §2 P2-1 — runnable interaction/behavior
// coverage for the shared UI primitives (owner finding: README usage samples alone don't prove
// the components actually behave; these assert real emit counts + DOM state, not snapshots).
// P2-1a (MtButton/MtIconButton/MtBadge) landed via #3744 with no component specs of their own —
// this file is that missing coverage, plus the new P2-1b overlay primitives in the sibling spec.

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

describe('MtButton', () => {
  it('renders its label slot', () => {
    const c = mount(MtButton, {}, { default: () => 'Save' })
    expect(c.querySelector('.mt-button__label')?.textContent).toBe('Save')
  })

  it('emits click when enabled', async () => {
    let clicks = 0
    const c = mount(MtButton, { onClick: () => { clicks += 1 } }, { default: () => 'Go' })
    const btn = c.querySelector('button.mt-button') as HTMLButtonElement
    btn.click()
    await nextTick()
    expect(clicks).toBe(1)
  })

  it('does NOT emit click when disabled', async () => {
    let clicks = 0
    const c = mount(MtButton, { disabled: true, onClick: () => { clicks += 1 } }, { default: () => 'Go' })
    const btn = c.querySelector('button.mt-button') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    btn.click()
    await nextTick()
    expect(clicks).toBe(0)
  })

  it('does NOT emit click when loading (loading implies disabled)', async () => {
    let clicks = 0
    const c = mount(MtButton, { loading: true, onClick: () => { clicks += 1 } }, { default: () => 'Go' })
    const btn = c.querySelector('button.mt-button') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(c.querySelector('.mt-button__icon--spinner')).not.toBeNull()
    btn.click()
    await nextTick()
    expect(clicks).toBe(0)
  })

  it('applies the variant and size classes', () => {
    const c = mount(MtButton, { variant: 'danger', size: 'sm' }, { default: () => 'Delete' })
    const btn = c.querySelector('button.mt-button') as HTMLButtonElement
    expect(btn.classList.contains('mt-button--danger')).toBe(true)
    expect(btn.classList.contains('mt-button--sm')).toBe(true)
  })

  it('defaults to the ghost variant and md size', () => {
    const c = mount(MtButton, {}, { default: () => 'Cancel' })
    const btn = c.querySelector('button.mt-button') as HTMLButtonElement
    expect(btn.classList.contains('mt-button--ghost')).toBe(true)
    expect(btn.classList.contains('mt-button--md')).toBe(true)
  })
})

describe('MtIconButton', () => {
  it('renders an icon passed via the `icon` prop', () => {
    const c = mount(MtIconButton, { icon: Delete, title: 'Delete row' })
    expect(c.querySelector('.mt-button__icon .el-icon')).not.toBeNull()
  })

  it('renders an icon passed via the `icon` slot', () => {
    const c = mount(MtIconButton, { title: 'More' }, { icon: () => h('span', { class: 'my-icon' }) })
    expect(c.querySelector('.mt-button__icon .my-icon')).not.toBeNull()
  })

  it('passes title/aria-label through to the rendered <button> (attrs fallthrough)', () => {
    const c = mount(MtIconButton, { icon: Delete, title: 'Delete row' })
    const btn = c.querySelector('button.mt-button') as HTMLButtonElement
    expect(btn.getAttribute('title')).toBe('Delete row')
    expect(btn.getAttribute('aria-label')).toBe('Delete row')
  })

  it('ariaLabel overrides title for aria-label specifically', () => {
    const c = mount(MtIconButton, { icon: Delete, title: 'Delete row', ariaLabel: 'Remove this row' })
    const btn = c.querySelector('button.mt-button') as HTMLButtonElement
    expect(btn.getAttribute('title')).toBe('Delete row')
    expect(btn.getAttribute('aria-label')).toBe('Remove this row')
  })

  it('emits click when enabled, not when disabled (same gating as MtButton)', async () => {
    let clicks = 0
    const c = mount(MtIconButton, { icon: Delete, title: 'Delete', onClick: () => { clicks += 1 } })
    const btn = c.querySelector('button.mt-button') as HTMLButtonElement
    btn.click()
    await nextTick()
    expect(clicks).toBe(1)

    clicks = 0
    app?.unmount()
    container?.remove()
    const c2 = mount(MtIconButton, { icon: Delete, title: 'Delete', disabled: true, onClick: () => { clicks += 1 } })
    const btn2 = c2.querySelector('button.mt-button') as HTMLButtonElement
    btn2.click()
    await nextTick()
    expect(clicks).toBe(0)
  })
})

describe('MtBadge', () => {
  it('is hidden when count is 0 and showZero is false (default)', () => {
    const c = mount(MtBadge, { count: 0 })
    expect(c.querySelector('.mt-badge')).toBeNull()
  })

  it('shows a 0 badge when showZero is true', () => {
    const c = mount(MtBadge, { count: 0, showZero: true })
    expect(c.querySelector('.mt-badge')?.textContent).toBe('0')
  })

  it('shows the numeric count', () => {
    const c = mount(MtBadge, { count: 7, tone: 'danger' })
    const el = c.querySelector('.mt-badge') as HTMLElement
    expect(el.textContent).toBe('7')
    expect(el.classList.contains('mt-badge--danger')).toBe(true)
  })

  it('caps the displayed count at 99+', () => {
    const c = mount(MtBadge, { count: 142 })
    expect(c.querySelector('.mt-badge')?.textContent).toBe('99+')
  })

  it('renders a dot instead of a count when dot is true (even at count 0)', () => {
    const c = mount(MtBadge, { dot: true, count: 0, tone: 'success' })
    const el = c.querySelector('.mt-badge') as HTMLElement
    expect(el).not.toBeNull()
    expect(el.classList.contains('mt-badge--dot')).toBe(true)
    expect(el.classList.contains('mt-badge--success')).toBe(true)
    expect(el.textContent).toBe('')
  })

  it.each(['info', 'primary', 'success', 'warning', 'danger'] as const)(
    'maps tone "%s" to its own modifier class',
    (tone) => {
      const c = mount(MtBadge, { count: 1, tone })
      expect(c.querySelector(`.mt-badge--${tone}`)).not.toBeNull()
    },
  )
})
