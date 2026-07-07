import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaToolbar from '../src/multitable/components/MetaToolbar.vue'
import type { MetaField } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c slice-2: MetaToolbar's row-density ("行高") dropdown was migrated from a hand-rolled
// `.meta-toolbar__dropdown` + `showDensityPanel` ref + `.meta-toolbar__panel--density` radio-list
// markup to the shared MtMenu/MtMenuItem primitives (built on MtPopover, Teleported to
// `document.body`). This is an interaction-preservation proof, not a snapshot: the trigger must
// open the menu, each option must still emit the exact same `set-row-density` event (same name,
// same payload value) it emitted before migration, the option must be a real keyboard-operable
// `<button role="menuitem">`, and selecting an option must close the menu.

// Track EVERY mount, not a single shared app/container (see meta-toolbar-action-buttons-migration
// .spec.ts): a shared global would leave a stale tree (and, here, stale Teleported `.mt-popover`
// content on document.body) after teardown — DOM pollution that risks false-pass / cross-talk
// across tests. afterEach unmounts ALL of them and asserts no toolbar DOM survives.
const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []

beforeEach(() => { useLocale().setLocale('en') })
afterEach(() => {
  while (mounts.length) {
    const m = mounts.pop()!
    m.app.unmount()
    m.container.remove()
  }
  expect(document.querySelectorAll('.meta-toolbar').length).toBe(0) // residue guard: no leaked toolbar
  // Belt-and-suspenders: the density menu Teleports its panel to document.body — nothing from it
  // should survive unmount either.
  expect(document.querySelectorAll('.mt-popover').length).toBe(0)
  useLocale().setLocale('en')
})

const FIELDS: MetaField[] = [
  { id: 'status', name: 'Status', type: 'select', options: [{ value: 'a' }] },
]

function mountToolbar(props: Record<string, unknown>) {
  const container = document.createElement('div'); document.body.appendChild(container)
  const app = createApp({ setup: () => () => h(MetaToolbar, {
    fields: FIELDS, hiddenFieldIds: [], sortRules: [], filterRules: [], filterConjunction: 'and',
    canCreateRecord: true, canExport: true, canUndo: true, canRedo: true, sortFilterDirty: false,
    ...props,
  }) })
  app.mount(container)
  mounts.push({ app, container })
  return container
}

function densityTrigger(root: HTMLElement): HTMLButtonElement {
  const btn = root.querySelector('button[title="Row height"]') as HTMLButtonElement | null
  expect(btn, 'expected a <button title="Row height"> trigger').toBeTruthy()
  return btn as HTMLButtonElement
}

describe('MetaToolbar row-density dropdown — MtMenu/MtMenuItem migration (UI-P2-1c slice-2)', () => {
  it('is closed until the trigger is clicked; clicking it opens the menu with the 3 density options', async () => {
    const root = mountToolbar({ rowDensity: 'normal' })
    expect(document.querySelector('.mt-menu')).toBeNull()

    const trigger = densityTrigger(root)
    expect(trigger.tagName).toBe('BUTTON')
    expect(trigger.getAttribute('aria-label')).toBe('Row height')
    trigger.click()
    await nextTick()

    const menu = document.querySelector('.mt-menu')
    expect(menu).not.toBeNull()
    const items = Array.from(document.querySelectorAll('.mt-menu-item')) as HTMLButtonElement[]
    expect(items.map((i) => i.textContent?.trim())).toEqual(['Compact', 'Normal', 'Expanded'])
  })

  it('each density option is a native keyboard-operable <button role="menuitem">', async () => {
    const root = mountToolbar({ rowDensity: 'normal' })
    densityTrigger(root).click()
    await nextTick()

    const items = Array.from(document.querySelectorAll('.mt-menu-item')) as HTMLButtonElement[]
    expect(items.length).toBe(3)
    for (const item of items) {
      expect(item.tagName).toBe('BUTTON')
      expect(item.getAttribute('type')).toBe('button')
      expect(item.getAttribute('role')).toBe('menuitem')
      expect(item.disabled).toBe(false)
    }
  })

  it.each([
    ['Compact', 'compact'],
    ['Normal', 'normal'],
    ['Expanded', 'expanded'],
  ])('clicking "%s" emits set-row-density(%j) — same event name + payload as before migration — and closes the menu', async (label, value) => {
    const onSetRowDensity = vi.fn()
    const root = mountToolbar({ rowDensity: 'normal', onSetRowDensity })
    densityTrigger(root).click()
    await nextTick()

    const item = Array.from(document.querySelectorAll('.mt-menu-item'))
      .find((el) => el.textContent?.trim() === label) as HTMLButtonElement
    expect(item, `expected a density option labeled "${label}"`).toBeTruthy()
    item.click()
    await nextTick()

    expect(onSetRowDensity).toHaveBeenCalledTimes(1)
    expect(onSetRowDensity).toHaveBeenCalledWith(value)
    expect(document.querySelector('.mt-menu')).toBeNull() // selecting an option closes the popover
  })

  it('marks the current density as active (aria-current + active class) among the rendered options', async () => {
    const root = mountToolbar({ rowDensity: 'compact' })
    densityTrigger(root).click()
    await nextTick()

    const items = Array.from(document.querySelectorAll('.mt-menu-item')) as HTMLButtonElement[]
    const compact = items.find((i) => i.textContent?.trim() === 'Compact')!
    const normal = items.find((i) => i.textContent?.trim() === 'Normal')!
    expect(compact.getAttribute('aria-current')).toBe('true')
    expect(compact.classList.contains('meta-toolbar__density-item--active')).toBe(true)
    expect(normal.getAttribute('aria-current')).toBeNull()
    expect(normal.classList.contains('meta-toolbar__density-item--active')).toBe(false)
  })

  it('a second click on the trigger closes the menu again (no option selected, no emit)', async () => {
    const onSetRowDensity = vi.fn()
    const root = mountToolbar({ rowDensity: 'normal', onSetRowDensity })
    const trigger = densityTrigger(root)
    trigger.click()
    await nextTick()
    expect(document.querySelector('.mt-menu')).not.toBeNull()

    trigger.click()
    await nextTick()
    expect(document.querySelector('.mt-menu')).toBeNull()
    expect(onSetRowDensity).not.toHaveBeenCalled()
  })
})
