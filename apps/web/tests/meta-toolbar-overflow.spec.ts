import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaToolbar from '../src/multitable/components/MetaToolbar.vue'
import type { MetaField } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []

beforeEach(() => { useLocale().setLocale('zh-CN') })
afterEach(() => {
  while (mounts.length) {
    const m = mounts.pop()!
    m.app.unmount()
    m.container.remove()
  }
  expect(document.querySelectorAll('.meta-toolbar').length).toBe(0)
  useLocale().setLocale('en')
})

const FIELDS: MetaField[] = [
  { id: 'status', name: 'Status', type: 'select', options: [{ value: 'a' }] },
]

function mountToolbar(slots?: { overflow?: () => ReturnType<typeof h> }) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({
    setup: () => () => h(MetaToolbar, {
      fields: FIELDS,
      hiddenFieldIds: [],
      sortRules: [],
      filterRules: [],
      filterConjunction: 'and',
      canCreateRecord: true,
      canExport: true,
      canUndo: true,
      canRedo: true,
      sortFilterDirty: false,
    }, slots),
  })
  app.mount(container)
  mounts.push({ app, container })
  return container
}

describe('MetaToolbar overflow 「更多」', () => {
  it('does not render 更多 when no overflow slot is provided', () => {
    const root = mountToolbar()
    expect(root.querySelector('[data-testid="toolbar-more"]')).toBeNull()
    expect(root.querySelector('[data-testid="toolbar-more-panel"]')).toBeNull()
  })

  it('keeps overflow actions in the tree (v-show) and preserves data-action', async () => {
    const onHistory = vi.fn()
    const root = mountToolbar({
      overflow: () => h(
        'button',
        { class: 'mt-workbench__mgr-btn', 'data-action': 'open-history', onClick: onHistory },
        'History',
      ),
    })
    const more = root.querySelector('[data-testid="toolbar-more"]') as HTMLButtonElement
    expect(more).toBeTruthy()
    expect(more.tagName).toBe('BUTTON')
    expect(more.getAttribute('aria-haspopup')).toBe('menu')
    expect(more.textContent).toContain('更多')

    const history = root.querySelector('[data-action="open-history"]') as HTMLButtonElement
    expect(history).toBeTruthy()
    expect(history.textContent).toBe('History')

    history.click()
    expect(onHistory).toHaveBeenCalledTimes(1)
  })

  it('pins 更多 outside the scrollable primary cluster so it stays reachable', () => {
    const root = mountToolbar({
      overflow: () => h('button', { 'data-action': 'open-history' }, 'History'),
    })
    const more = root.querySelector('[data-testid="toolbar-more"]') as HTMLButtonElement
    const end = root.querySelector('.meta-toolbar__end') as HTMLElement
    const primary = root.querySelector('.meta-toolbar__primary') as HTMLElement
    expect(end).toBeTruthy()
    expect(end.contains(more)).toBe(true)
    expect(primary.contains(more)).toBe(false)
  })

  it('toggles aria-expanded on the 更多 trigger', async () => {
    const root = mountToolbar({
      overflow: () => h('button', { 'data-action': 'open-history' }, 'History'),
    })
    const more = root.querySelector('[data-testid="toolbar-more"]') as HTMLButtonElement
    const panel = root.querySelector('[data-testid="toolbar-more-panel"]') as HTMLElement
    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(panel.style.display).toBe('none')
    more.click()
    await nextTick()
    expect(more.getAttribute('aria-expanded')).toBe('true')
    expect(panel.style.display).not.toBe('none')
    more.click()
    await nextTick()
    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(panel.style.display).toBe('none')
  })
})
