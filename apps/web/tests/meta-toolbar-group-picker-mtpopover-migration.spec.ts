import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaToolbar from '../src/multitable/components/MetaToolbar.vue'
import type { MetaField } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c slice-6: the group ("分组") dropdown — the LAST MetaToolbar dropdown — was migrated from a
// hand-rolled `showGroupPanel` toggle + `.meta-toolbar__panel--group` markup to the shared MtPopover.
// Its inner controls are native <select>/<button> (no Teleport), so MtPopover treats edits as "inside"
// and the panel STAYS OPEN during multi-level editing. This proves: same `set-group-fields` emit +
// payload, stays-open-on-edit, Esc/outside/second-click close — behaviour preserved, not a snapshot.

// Track EVERY mount (some tests mount twice); afterEach unmounts all + asserts no leaked toolbar OR
// teleported popover survives — the DOM-pollution guard the owner enforced in slice-1.
const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []

afterEach(() => {
  while (mounts.length) {
    const m = mounts.pop()!
    m.app.unmount()
    m.container.remove()
  }
  expect(document.querySelectorAll('.meta-toolbar').length).toBe(0)
  expect(document.querySelectorAll('.mt-popover').length).toBe(0) // Teleport residue guard
  useLocale().setLocale('en')
})

const FIELDS: MetaField[] = [
  { id: 'status', name: 'Status', type: 'select', options: [{ value: 'a' }] },
  { id: 'amount', name: 'Amount', type: 'number' },
  { id: 'city', name: 'City', type: 'string' },
]

function mountToolbar(props: Record<string, unknown> = {}) {
  const container = document.createElement('div'); document.body.appendChild(container)
  const app = createApp({ setup: () => () => h(MetaToolbar, {
    fields: FIELDS, hiddenFieldIds: [], sortRules: [], filterRules: [], filterConjunction: 'and',
    canCreateRecord: true, canExport: true, canUndo: false, canRedo: false, sortFilterDirty: false,
    ...props,
  }) })
  app.mount(container)
  mounts.push({ app, container })
  return container
}

const groupTrigger = (root: HTMLElement) =>
  Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.includes('Group')) as HTMLButtonElement
const panel = () => document.querySelector('.meta-toolbar__panel--group') as HTMLElement | null

describe('MetaToolbar group picker — MtPopover migration (UI-P2-1c slice-6)', () => {
  it('is closed by default; clicking the trigger opens the teleported MtPopover with the group-select', async () => {
    const root = mountToolbar()
    expect(panel()).toBeNull()
    expect(document.querySelector('.mt-popover')).toBeNull()
    groupTrigger(root).click(); await nextTick()
    expect(panel()).toBeTruthy()
    expect(panel()!.querySelector('.meta-toolbar__group-select')).toBeTruthy()
  })

  it('trigger is a native <button> (MtButton) and carries the group title/aria-label', async () => {
    const root = mountToolbar()
    const btn = groupTrigger(root)
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.getAttribute('aria-label')).toBe('Group')
    expect(btn.getAttribute('title')).toBe('Group')
  })

  it('selecting a group field emits set-group-fields with the deduped payload AND keeps the popover open', async () => {
    const onSetGroupFields = vi.fn()
    const root = mountToolbar({ onSetGroupFields })
    groupTrigger(root).click(); await nextTick()
    const select = panel()!.querySelector('.meta-toolbar__group-select') as HTMLSelectElement
    select.value = 'status'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    expect(onSetGroupFields).toHaveBeenCalledTimes(1)
    expect(onSetGroupFields).toHaveBeenCalledWith(['status'])
    // the defining multi-level behaviour: the panel must NOT close after a selection
    expect(document.querySelector('.mt-popover')).toBeTruthy()
    expect(panel()).toBeTruthy()
  })

  it('Escape closes the popover', async () => {
    const root = mountToolbar()
    groupTrigger(root).click(); await nextTick()
    expect(panel()).toBeTruthy()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(panel()).toBeNull()
  })

  it('outside click closes the popover', async () => {
    const root = mountToolbar()
    groupTrigger(root).click(); await nextTick()
    expect(panel()).toBeTruthy()
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await nextTick()
    expect(panel()).toBeNull()
  })

  it('second trigger click closes the popover with no set-group-fields emit', async () => {
    const onSetGroupFields = vi.fn()
    const root = mountToolbar({ onSetGroupFields })
    const btn = groupTrigger(root)
    btn.click(); await nextTick()
    expect(panel()).toBeTruthy()
    btn.click(); await nextTick()
    expect(panel()).toBeNull()
    expect(onSetGroupFields).not.toHaveBeenCalled()
  })
})
