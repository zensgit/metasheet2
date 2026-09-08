import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import MetaToolbar from '../src/multitable/components/MetaToolbar.vue'
import OverflowCommandRow from '../src/multitable/components/OverflowCommandRow.vue'
import type { MetaField } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'
import { TOOLBAR_PINS_STORAGE_KEY } from '../src/multitable/utils/toolbar-pins'

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []

beforeEach(() => {
  localStorage.clear()
  useLocale().setLocale('en')
})

afterEach(() => {
  while (mounts.length) {
    const m = mounts.pop()!
    m.app.unmount()
    m.container.remove()
  }
  localStorage.clear()
  expect(document.querySelectorAll('.meta-toolbar').length).toBe(0)
  useLocale().setLocale('en')
})

const FIELDS: MetaField[] = [
  { id: 'status', name: 'Status', type: 'select', options: [{ value: 'a' }] },
]

function mountToolbar(options?: {
  props?: Record<string, unknown>
  overflow?: boolean
  onHistory?: () => void
}) {
  const onHistory = options?.onHistory ?? vi.fn()
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
      pinUserId: 'qa-pin-user',
      pinSheetId: 'qa-pin-sheet',
      ...options?.props,
    }, options?.overflow === false ? undefined : {
      overflow: ({ pinApi }: { pinApi?: unknown }) => h(
        OverflowCommandRow,
        { commandId: 'history', pinApi },
        () => h('button', {
          class: 'mt-workbench__mgr-btn',
          'data-command': 'history',
          'data-action': 'open-history',
          onClick: onHistory,
        }, 'History'),
      ),
    }),
  })
  app.mount(container)
  mounts.push({ app, container })
  return { app, container, onHistory }
}

describe('MetaToolbar user-customizable pins', () => {
  it('keeps the default first row empty of pins when localStorage has never been set', () => {
    const { container } = mountToolbar({ overflow: false })
    const primary = container.querySelector('.meta-toolbar__primary') as HTMLElement
    expect(container.querySelector('[data-testid="toolbar-pins"]')).toBeNull()
    expect(container.querySelector('[data-testid="toolbar-layout"]')).toBeNull()
    for (const title of ['Fields', 'Sort', 'Filter', 'Group']) {
      expect(primary.querySelector(`button[title="${title}"]`)).toBeTruthy()
    }
    expect(Array.from(primary.querySelectorAll('button')).some((b) => b.textContent?.trim() === '+ New Record')).toBe(true)
    expect(primary.querySelector('[data-testid="toolbar-pin-btn-fit"]')).toBeNull()
    expect(container.querySelector('[data-testid="toolbar-more"]')).toBeTruthy()
  })

  it('pins a More item onto the primary cluster and still fires the same action', async () => {
    const onAutoFit = vi.fn()
    const { container } = mountToolbar({ props: { onAutoFitColumns: onAutoFit } })
    const pin = container.querySelector('[data-testid="toolbar-pin-fit"]') as HTMLButtonElement
    expect(pin).toBeTruthy()
    expect(pin.getAttribute('title')).toBe('Pin to toolbar')
    pin.click()
    await nextTick()

    const pinned = container.querySelector('[data-testid="toolbar-pin-btn-fit"]') as HTMLButtonElement
    expect(pinned).toBeTruthy()
    const primary = container.querySelector('.meta-toolbar__primary') as HTMLElement
    expect(primary.contains(pinned)).toBe(true)
    const search = primary.querySelector('.meta-toolbar__search') as HTMLElement
    expect(pinned.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    const moreFit = container.querySelector('[data-command="fit"]') as HTMLButtonElement
    expect(moreFit).toBeTruthy()
    expect((moreFit.closest('.meta-toolbar__more-row') as HTMLElement).style.display).toBe('none')

    pinned.click()
    expect(onAutoFit).toHaveBeenCalledTimes(1)
  })

  it('unpins from the layout section and returns the command to More only', async () => {
    const { container } = mountToolbar()
    ;(container.querySelector('[data-testid="toolbar-pin-print"]') as HTMLButtonElement).click()
    await nextTick()
    expect(container.querySelector('[data-testid="toolbar-pin-btn-print"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="toolbar-layout"]')).toBeTruthy()

    const layoutPin = Array.from(container.querySelectorAll('[data-testid="toolbar-pin-print"]'))
      .find((el) => (el as HTMLElement).closest('[data-testid="toolbar-layout"]')) as HTMLButtonElement
    expect(layoutPin).toBeTruthy()
    layoutPin.click()
    await nextTick()

    expect(container.querySelector('[data-testid="toolbar-pin-btn-print"]')).toBeNull()
    expect(container.querySelector('[data-testid="toolbar-layout"]')).toBeNull()
    const morePrint = container.querySelector('[data-command="print"]') as HTMLButtonElement
    expect(morePrint).toBeTruthy()
    expect((morePrint.closest('.meta-toolbar__more-row') as HTMLElement).style.display).not.toBe('none')
  })

  it('persists pin order in localStorage and restores it on remount', async () => {
    const first = mountToolbar()
    ;(first.container.querySelector('[data-testid="toolbar-pin-fit"]') as HTMLButtonElement).click()
    await nextTick()
    ;(first.container.querySelector('[data-testid="toolbar-pin-print"]') as HTMLButtonElement).click()
    await nextTick()
    const down = first.container.querySelector('[data-testid="toolbar-layout-down"]') as HTMLButtonElement
    down.click()
    await nextTick()

    const stored = JSON.parse(localStorage.getItem(TOOLBAR_PINS_STORAGE_KEY) ?? '{}') as Record<string, string[]>
    expect(stored['qa-pin-user::qa-pin-sheet']).toEqual(['print', 'fit'])

    first.app.unmount()
    first.container.remove()
    const idx = mounts.findIndex((m) => m.app === first.app)
    if (idx >= 0) mounts.splice(idx, 1)

    const second = mountToolbar()
    await nextTick()
    const pins = Array.from(second.container.querySelectorAll('[data-testid^="toolbar-pin-btn-"]'))
      .map((el) => el.getAttribute('data-testid'))
    expect(pins).toEqual(['toolbar-pin-btn-print', 'toolbar-pin-btn-fit'])
  })

  it('reset restores the default empty first-row pin list', async () => {
    const { container } = mountToolbar()
    ;(container.querySelector('[data-testid="toolbar-pin-fit"]') as HTMLButtonElement).click()
    await nextTick()
    expect(container.querySelector('[data-testid="toolbar-pin-btn-fit"]')).toBeTruthy()
    ;(container.querySelector('[data-testid="toolbar-pins-reset"]') as HTMLButtonElement).click()
    await nextTick()
    expect(container.querySelector('[data-testid="toolbar-pins"]')).toBeNull()
    expect(JSON.parse(localStorage.getItem(TOOLBAR_PINS_STORAGE_KEY) ?? '{}')).toEqual({})
  })

  it('pins a workbench overflow command and forwards the original click', async () => {
    const { container, onHistory } = mountToolbar()
    const pin = container.querySelector('[data-testid="toolbar-pin-history"]') as HTMLButtonElement
    expect(pin).toBeTruthy()
    pin.click()
    await nextTick()

    const pinned = container.querySelector('[data-testid="toolbar-pin-btn-history"]') as HTMLButtonElement
    expect(pinned).toBeTruthy()
    const source = container.querySelector('[data-action="open-history"]') as HTMLButtonElement
    expect(source).toBeTruthy()
    expect(source.classList.contains('mt-workbench__mgr-btn')).toBe(true)

    pinned.click()
    expect(onHistory).toHaveBeenCalledTimes(1)
  })

  it('registers stable data-command ids on workbench overflow mgr buttons', () => {
    const source = readFileSync(join(__dirname, '../src/multitable/views/MultitableWorkbench.vue'), 'utf-8')
    for (const id of [
      'comment-inbox', 'fields', 'access', 'views', 'workflow', 'automations',
      'templates', 'dashboard', 'share-form', 'api', 'trash', 'history',
      'config-history', 'archive-recovery',
    ]) {
      expect(source, `expected data-command="${id}"`).toMatch(new RegExp(`data-command="${id}"`))
    }
    expect(source).toMatch(/data-action="open-history"/)
    expect(source).toMatch(/data-action="toggle-dashboard"/)
  })
})
