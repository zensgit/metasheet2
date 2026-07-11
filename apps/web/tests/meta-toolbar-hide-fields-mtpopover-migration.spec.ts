import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaToolbar from '../src/multitable/components/MetaToolbar.vue'
import type { MetaField } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c slice-3: MetaToolbar's field-visibility ("字段" / hide-fields) dropdown was migrated
// from a hand-rolled `showFieldPicker` ref + `.meta-toolbar__dropdown`/`.meta-toolbar__panel`
// field-toggle list to the shared MtPopover primitive (NOT MtMenu — this is a multi-toggle list,
// so toggling one field row must NOT close the panel, unlike the row-density menu's
// select-and-close semantics from slice-2). This is an interaction-preservation proof: the trigger
// must open the popover, the field toggle rows must still render as real
// <label>/<input type="checkbox"> rows, toggling one must still emit the exact same
// `toggle-field(fieldId)` event it emitted before migration AND leave the popover open, and
// Escape / click-outside must still close it.

// Track EVERY mount, not a single shared app/container (see meta-toolbar-density-menu-migration
// .spec.ts): a shared global would leave a stale tree — and, here, stale Teleported `.mt-popover`
// content on document.body — after teardown. afterEach unmounts ALL of them and asserts no
// toolbar DOM, and no leaked popover Teleport content, survives.
const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []

beforeEach(() => { useLocale().setLocale('en') })
afterEach(() => {
  while (mounts.length) {
    const m = mounts.pop()!
    m.app.unmount()
    m.container.remove()
  }
  expect(document.querySelectorAll('.meta-toolbar').length).toBe(0) // residue guard: no leaked toolbar
  expect(document.querySelectorAll('.mt-popover').length).toBe(0) // no leaked Teleported popover content
  useLocale().setLocale('en')
})

const FIELDS: MetaField[] = [
  { id: 'status', name: 'Status', type: 'select', options: [{ value: 'a' }] },
  { id: 'owner', name: 'Owner', type: 'string' },
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

function fieldsTrigger(root: HTMLElement): HTMLButtonElement {
  const btn = root.querySelector('button[title="Fields"]') as HTMLButtonElement | null
  expect(btn, 'expected a <button title="Fields"> trigger').toBeTruthy()
  return btn as HTMLButtonElement
}

function fieldToggleRows(): HTMLLabelElement[] {
  return Array.from(document.querySelectorAll('.meta-toolbar__field-toggle')) as HTMLLabelElement[]
}

describe('MetaToolbar hide-fields dropdown — MtPopover migration (UI-P2-1c slice-3)', () => {
  it('is closed until the trigger is clicked; clicking it opens the popover with one row per field', async () => {
    const root = mountToolbar({ hiddenFieldIds: [] })
    expect(document.querySelector('.mt-popover')).toBeNull()

    const trigger = fieldsTrigger(root)
    expect(trigger.tagName).toBe('BUTTON')
    expect(trigger.getAttribute('aria-label')).toBe('Fields')
    trigger.click()
    await nextTick()

    expect(document.querySelector('.mt-popover')).not.toBeNull()
    const rows = fieldToggleRows()
    expect(rows.length).toBe(2)
    expect(rows.map((r) => r.textContent?.trim())).toEqual(['Status', 'Owner'])
  })

  it('a checkbox reflects hiddenFieldIds (checked = visible, i.e. NOT hidden)', async () => {
    const root = mountToolbar({ hiddenFieldIds: ['owner'] })
    fieldsTrigger(root).click()
    await nextTick()

    const rows = fieldToggleRows()
    const statusCheckbox = rows[0].querySelector('input[type="checkbox"]') as HTMLInputElement
    const ownerCheckbox = rows[1].querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(statusCheckbox.checked).toBe(true) // 'status' not in hiddenFieldIds → visible → checked
    expect(ownerCheckbox.checked).toBe(false) // 'owner' IS hidden → unchecked
  })

  it('toggling a field emits toggle-field(fieldId) — same event name + payload as before migration — AND keeps the popover OPEN', async () => {
    const onToggleField = vi.fn()
    const root = mountToolbar({ hiddenFieldIds: [], onToggleField })
    fieldsTrigger(root).click()
    await nextTick()
    expect(document.querySelector('.mt-popover')).not.toBeNull()

    const rows = fieldToggleRows()
    const ownerCheckbox = rows[1].querySelector('input[type="checkbox"]') as HTMLInputElement
    ownerCheckbox.click() // real user interaction: toggles native checked state + fires 'change'
    await nextTick()

    expect(onToggleField).toHaveBeenCalledTimes(1)
    expect(onToggleField).toHaveBeenCalledWith('owner')
    // The key multi-toggle behavior (unlike MtMenu's select-and-close row): the popover must still
    // be open after a toggle, so a second/third field can be toggled without reopening it.
    expect(document.querySelector('.mt-popover')).not.toBeNull()
    expect(fieldToggleRows().length).toBe(2) // rows still rendered, nothing torn down

    // Toggle a second field to further confirm the panel survives repeated toggles.
    const statusCheckbox = fieldToggleRows()[0].querySelector('input[type="checkbox"]') as HTMLInputElement
    statusCheckbox.click()
    await nextTick()
    expect(onToggleField).toHaveBeenCalledTimes(2)
    expect(onToggleField).toHaveBeenNthCalledWith(2, 'status')
    expect(document.querySelector('.mt-popover')).not.toBeNull()
  })

  it('pressing Escape closes the popover', async () => {
    const root = mountToolbar({ hiddenFieldIds: [] })
    fieldsTrigger(root).click()
    await nextTick()
    expect(document.querySelector('.mt-popover')).not.toBeNull()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(document.querySelector('.mt-popover')).toBeNull()
  })

  it('a click outside the trigger and panel closes the popover', async () => {
    const root = mountToolbar({ hiddenFieldIds: [] })
    fieldsTrigger(root).click()
    await nextTick()
    expect(document.querySelector('.mt-popover')).not.toBeNull()

    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await nextTick()
    expect(document.querySelector('.mt-popover')).toBeNull()
    expect(root).toBeTruthy() // root/toolbar itself is untouched by the close
  })

  it('a second click on the trigger closes the popover again (no field toggled, no emit)', async () => {
    const onToggleField = vi.fn()
    const root = mountToolbar({ hiddenFieldIds: [], onToggleField })
    const trigger = fieldsTrigger(root)
    trigger.click()
    await nextTick()
    expect(document.querySelector('.mt-popover')).not.toBeNull()

    trigger.click()
    await nextTick()
    expect(document.querySelector('.mt-popover')).toBeNull()
    expect(onToggleField).not.toHaveBeenCalled()
  })

  it('shows the hidden-field-count badge on the trigger, same as before migration', async () => {
    const root = mountToolbar({ hiddenFieldIds: ['owner'] })
    const trigger = fieldsTrigger(root)
    const badge = trigger.querySelector('.meta-toolbar__badge')
    expect(badge, 'expected the hidden-count badge inside the trigger button').toBeTruthy()
    expect(badge?.textContent?.trim()).toBe('1')
  })
})
