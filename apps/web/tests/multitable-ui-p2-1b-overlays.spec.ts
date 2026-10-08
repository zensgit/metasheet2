import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, ref, type App, type VNodeChild } from 'vue'
import MtPopover from '../src/multitable/ui/MtPopover.vue'
import MtMenu from '../src/multitable/ui/MtMenu.vue'
import MtMenuItem from '../src/multitable/ui/MtMenuItem.vue'
import MtPanel from '../src/multitable/ui/MtPanel.vue'

// multitable-ui-p2-structure-designlock-20260706.md §2 P2-1b — runnable interaction/behavior
// coverage for the new overlay primitives (MtPopover / MtMenu / MtMenuItem / MtPanel). Both
// MtPopover and MtMenu Teleport their floating content to `document.body`, so assertions query
// `document` rather than the mount container for that content (mirrors ContextMenu.vue's own
// Teleport-to-body shape).

let app: App<Element> | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
  // Belt-and-suspenders: nothing Teleported should survive unmount, but guard against a leak
  // masking a real bug in one test from failing the next.
  document.querySelectorAll('.mt-popover').forEach((el) => el.remove())
})

// F3 (2026-09-05, round 3): the ONE `createApp({ render })` in this file. `vue/one-component-per-file`
// counts every `createApp({...})` object literal as a component and reports ALL of them once a file
// holds more than one — this file held nine. Each test now passes a render CLOSURE; any reactive
// harness state (the MtPopover tests' `open` ref) lives in the closure, exactly as it did inside the
// former per-test `setup()`. Assigns the module-level `app`/`container` the `afterEach` above tears
// down, and returns the (non-null) container for the caller's own queries.
function mountApp(render: () => VNodeChild): HTMLDivElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  container = el
  app = createApp({ render })
  app.mount(el)
  return el
}

function dispatchOutsideMousedown() {
  const outside = document.createElement('div')
  outside.className = 'outside-target'
  document.body.appendChild(outside)
  outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  outside.remove()
}

describe('MtPopover', () => {
  it('opens on trigger click and closes again on a second trigger click (v-model:open)', async () => {
    const open = ref(false)
    const c = mountApp(() =>
      h(
        MtPopover,
        { open: open.value, 'onUpdate:open': (v: boolean) => { open.value = v } },
        {
          trigger: () => h('button', { class: 'trigger-btn' }, 'Open'),
          default: () => h('div', { class: 'content' }, 'Popover content'),
        },
      ),
    )
    await nextTick()

    expect(document.querySelector('.mt-popover')).toBeNull()

    const trigger = c.querySelector('.trigger-btn') as HTMLButtonElement
    trigger.click()
    await nextTick()
    expect(document.querySelector('.mt-popover')).not.toBeNull()
    expect(document.querySelector('.mt-popover .content')?.textContent).toBe('Popover content')

    trigger.click()
    await nextTick()
    expect(document.querySelector('.mt-popover')).toBeNull()
  })

  it('closes on Escape while open', async () => {
    const open = ref(false)
    const c = mountApp(() =>
      h(
        MtPopover,
        { open: open.value, 'onUpdate:open': (v: boolean) => { open.value = v } },
        {
          trigger: () => h('button', { class: 'trigger-btn' }, 'Open'),
          default: () => h('div', { class: 'content' }, 'Content'),
        },
      ),
    )
    await nextTick()

    ;(c.querySelector('.trigger-btn') as HTMLButtonElement).click()
    await nextTick()
    expect(document.querySelector('.mt-popover')).not.toBeNull()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(document.querySelector('.mt-popover')).toBeNull()
  })

  it('closes on a click outside the trigger and panel', async () => {
    const open = ref(false)
    const c = mountApp(() =>
      h(
        MtPopover,
        { open: open.value, 'onUpdate:open': (v: boolean) => { open.value = v } },
        {
          trigger: () => h('button', { class: 'trigger-btn' }, 'Open'),
          default: () => h('div', { class: 'content' }, 'Content'),
        },
      ),
    )
    await nextTick()

    ;(c.querySelector('.trigger-btn') as HTMLButtonElement).click()
    await nextTick()
    expect(document.querySelector('.mt-popover')).not.toBeNull()

    dispatchOutsideMousedown()
    await nextTick()
    expect(document.querySelector('.mt-popover')).toBeNull()
  })

  it('a click INSIDE the panel does not close it', async () => {
    const open = ref(false)
    const c = mountApp(() =>
      h(
        MtPopover,
        { open: open.value, 'onUpdate:open': (v: boolean) => { open.value = v } },
        {
          trigger: () => h('button', { class: 'trigger-btn' }, 'Open'),
          default: () => h('div', { class: 'content' }, 'Content'),
        },
      ),
    )
    await nextTick()

    ;(c.querySelector('.trigger-btn') as HTMLButtonElement).click()
    await nextTick()
    const content = document.querySelector('.mt-popover .content') as HTMLElement
    content.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await nextTick()
    expect(document.querySelector('.mt-popover')).not.toBeNull()
  })
})

describe('MtMenu / MtMenuItem', () => {
  function mountMenu(onSelect: () => void, onDisabledSelect: () => void) {
    return mountApp(() =>
      h(
        MtMenu,
        {},
        {
          trigger: () => h('button', { class: 'trigger-btn' }, 'Actions'),
          default: () => [
            h(MtMenuItem, { onSelect }, { default: () => 'Rename' }),
            h(MtMenuItem, { disabled: true, onSelect: onDisabledSelect }, { default: () => 'Delete' }),
          ],
        },
      ),
    )
  }

  it('is closed until the trigger is clicked, then shows its MtMenuItem rows', async () => {
    const c = mountMenu(() => {}, () => {})
    await nextTick()
    expect(document.querySelector('.mt-menu')).toBeNull()

    ;(c.querySelector('.trigger-btn') as HTMLButtonElement).click()
    await nextTick()
    const menu = document.querySelector('.mt-menu')
    expect(menu).not.toBeNull()
    const items = document.querySelectorAll('.mt-menu-item')
    expect(items.length).toBe(2)
    expect(items[0].textContent).toContain('Rename')
    expect(items[1].textContent).toContain('Delete')
  })

  it('emits select on an enabled item and closes the menu', async () => {
    let selectCount = 0
    const c = mountMenu(() => { selectCount += 1 }, () => {})
    ;(c.querySelector('.trigger-btn') as HTMLButtonElement).click()
    await nextTick()

    const renameItem = document.querySelectorAll('.mt-menu-item')[0] as HTMLElement
    renameItem.click()
    await nextTick()

    expect(selectCount).toBe(1)
    expect(document.querySelector('.mt-menu')).toBeNull()
  })

  it('does NOT emit select on a disabled item, and the menu stays open', async () => {
    let disabledSelectCount = 0
    const c = mountMenu(() => {}, () => { disabledSelectCount += 1 })
    ;(c.querySelector('.trigger-btn') as HTMLButtonElement).click()
    await nextTick()

    const deleteItem = document.querySelectorAll('.mt-menu-item')[1] as HTMLButtonElement
    // native `disabled` (not a css class) → removed from tab order + activation suppressed by the browser
    expect(deleteItem.disabled).toBe(true)
    deleteItem.click()
    await nextTick()

    expect(disabledSelectCount).toBe(0)
    expect(document.querySelector('.mt-menu')).not.toBeNull()
  })

  it('renders each item as a native <button type="button" role="menuitem"> — honestly keyboard-operable', async () => {
    // A11y contract: role="menuitem" on a bare, non-focusable <div> would be a lie (keyboard users
    // can't reach or activate it). A native <button> gives focusability + Enter/Space→click activation
    // + real `disabled` for free. jsdom does not synthesize the browser's native Enter/Space→click, so
    // the robust, non-flaky assertion of keyboard-operability here is structural: it IS a native button.
    const c = mountMenu(() => {}, () => {})
    ;(c.querySelector('.trigger-btn') as HTMLButtonElement).click()
    await nextTick()

    const items = document.querySelectorAll('.mt-menu-item')
    const enabled = items[0] as HTMLButtonElement
    const disabled = items[1] as HTMLButtonElement
    expect(enabled.tagName).toBe('BUTTON')
    expect(enabled.getAttribute('type')).toBe('button')
    expect(enabled.getAttribute('role')).toBe('menuitem')
    expect(enabled.disabled).toBe(false) // enabled item is focusable + activatable
    expect(disabled.disabled).toBe(true)  // disabled item is natively inert (tab-skipped, no activation)
  })

  it('activating an item (the click a browser fires for Enter/Space on a button) emits select once', async () => {
    // Native <button> maps Enter/Space to a click event; asserting the click path proves the same code
    // path keyboard activation drives (jsdom cannot emit the native keyboard→click itself).
    let selectCount = 0
    const c = mountMenu(() => { selectCount += 1 }, () => {})
    ;(c.querySelector('.trigger-btn') as HTMLButtonElement).click()
    await nextTick()
    const enabled = document.querySelectorAll('.mt-menu-item')[0] as HTMLButtonElement
    enabled.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(selectCount).toBe(1)
  })

  // Record inspector v3 (2026-09-05, PR-A §4 item 10 additive-only kit change): arrow-key roving +
  // Escape-returns-focus-to-trigger, added to this shared primitive for the kebab menu's benefit but
  // exercised here directly, decoupled from any one consumer.
  describe('keyboard roving + Escape-refocus (additive, PR-A §4 item 10)', () => {
    // The open-focus/close-refocus chain here is TWO nested `nextTick`s deep — `isOpen`'s own
    // `watch` callback (pre-flush, itself a microtask-scheduled job) schedules a SECOND `nextTick`
    // inside its body for the actual `.focus()` call — so a single `await nextTick()` after a click
    // observes the watcher having run but not yet its own inner focus call. Same multi-cycle
    // discipline as multitable-record-inspector-header.spec.ts's own `flushUi` helper.
    async function flushUi(cycles = 4) {
      for (let i = 0; i < cycles; i += 1) {
        await Promise.resolve()
        await nextTick()
      }
    }

    function mountThreeItemMenu(): HTMLDivElement {
      return mountApp(() =>
        h(
          MtMenu,
          {},
          {
            trigger: () => h('button', { class: 'trigger-btn' }, 'Actions'),
            default: () => [
              h(MtMenuItem, { onSelect: () => {} }, { default: () => 'One' }),
              h(MtMenuItem, { onSelect: () => {} }, { default: () => 'Two' }),
              h(MtMenuItem, { onSelect: () => {} }, { default: () => 'Three' }),
            ],
          },
        ),
      )
    }

    // P3-4: the existing consumer-level spec (multitable-record-inspector-header.spec.ts) titles its
    // roving test "ArrowDown/ArrowUp/Home/End" but its body never actually dispatches ArrowUp — this
    // is the direct, previously-missing coverage of that case on the shared primitive itself.
    it('ArrowUp moves focus to the PREVIOUS item, and wraps from the first item to the last', async () => {
      const c = mountThreeItemMenu()
      ;(c.querySelector('.trigger-btn') as HTMLButtonElement).click()
      await flushUi()
      const items = Array.from(document.querySelectorAll<HTMLElement>('.mt-menu-item'))
      expect(items).toHaveLength(3)
      expect(document.activeElement).toBe(items[0]) // auto-focused on open

      items[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      expect(document.activeElement).toBe(items[1])

      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
      expect(document.activeElement).toBe(items[0]) // the actual ArrowUp case P3-4 names

      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
      expect(document.activeElement).toBe(items[2]) // wraps past the first item to the last
    })

    // Round 3 (2026-09-05, refuter finding on round 2): the test above always starts from an
    // ALREADY-focused item, so it never exercised `currentIndex === -1` — NO item focused yet (focus
    // still on the trigger / the `role="menu"` container / body: the window before MtMenu's own
    // nextTick auto-focus lands, or after focus was moved off the items). The pre-fix ArrowUp math
    // `(currentIndex - 1 + n) % n` with -1 resolves to `n - 2`: the SECOND-TO-LAST item, silently
    // skipping the last one; ArrowDown's `(-1 + 1) % n === 0` was right only by arithmetic accident.
    // Positive control: 3 items, nothing focused → ArrowUp lands on items[2] (pre-fix: items[1]),
    // ArrowDown on items[0]. Mutation: restore the old modulo expression in MtMenu.vue's ArrowUp
    // branch → the first `toBe(items[2])` below reds with items[1].
    it('with NO item focused, ArrowUp enters at the LAST item (not n-2) and ArrowDown at the first; last-item ArrowDown still wraps to the first', async () => {
      const c = mountThreeItemMenu()
      ;(c.querySelector('.trigger-btn') as HTMLButtonElement).click()
      await flushUi()
      const menu = document.querySelector<HTMLElement>('.mt-menu')!
      const items = Array.from(document.querySelectorAll<HTMLElement>('.mt-menu-item'))
      expect(items).toHaveLength(3)
      expect(document.activeElement).toBe(items[0]) // auto-focused on open (the state we now leave)

      // Deterministic "nothing focused": move focus OFF every item (jsdom: `blur()` → body), the
      // same `document.activeElement` the handler reads before its auto-focus has landed, so
      // `items.indexOf(active) === -1` inside `onMenuKeydown`. The event is dispatched on the
      // `role="menu"` container itself — the element that carries the `@keydown` binding.
      ;(document.activeElement as HTMLElement).blur()
      expect(items.includes(document.activeElement as HTMLElement)).toBe(false)
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
      expect(document.activeElement).toBe(items[2]) // the LAST item — pre-fix landed on items[1]

      ;(document.activeElement as HTMLElement).blur()
      expect(items.includes(document.activeElement as HTMLElement)).toBe(false)
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      expect(document.activeElement).toBe(items[0]) // enters at the first item

      // Regression guard: the explicit "no item focused" entry must not have broken the ordinary
      // wrap — from the LAST item, ArrowDown still wraps around to the first.
      items[2].focus()
      expect(document.activeElement).toBe(items[2])
      items[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      expect(document.activeElement).toBe(items[0])
    })

    // P3-6: the pre-fix implementation captured `document.activeElement` at open time as "the
    // trigger" — correct only when a real mouse click already moved focus there FIRST. This host
    // opens the menu WITHOUT ever focusing the trigger button first (`.click()` in jsdom does not
    // synthesize the browser's own click-focuses-the-target behavior — see the header spec's own
    // comment on this exact jsdom gap), so `document.activeElement` at open is `document.body`, NOT
    // the trigger — the discriminating case the old implementation could not handle.
    it('Escape returns focus to the ACTUAL trigger even when the trigger was NOT document.activeElement at open time', async () => {
      const c = mountThreeItemMenu()
      const trigger = c.querySelector('.trigger-btn') as HTMLButtonElement
      expect(document.activeElement).not.toBe(trigger) // never focused — proves the discriminating setup
      trigger.click() // opens the menu via a plain click, no prior .focus()
      await flushUi()
      const items = document.querySelectorAll<HTMLElement>('.mt-menu-item')
      expect(items.length).toBeGreaterThan(0)
      // MtMenu's own auto-focus-first-item-on-open (unrelated to the trigger-capture bug) has already
      // moved focus off the trigger/body by the time Escape is dispatched — the real-world sequence.
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      await flushUi()
      expect(document.querySelector('.mt-menu')).toBeNull() // menu closed
      expect(document.activeElement).toBe(trigger)
    })
  })
})

describe('MtPanel', () => {
  it('renders its default slot content inside a .mt-panel container', () => {
    const c = mountApp(() => h(MtPanel, {}, { default: () => h('div', { class: 'inner' }, 'Grouped') }))
    const panel = c.querySelector('.mt-panel') as HTMLElement
    expect(panel).not.toBeNull()
    expect(panel.querySelector('.inner')?.textContent).toBe('Grouped')
  })

  it('applies the padding and shadow modifier classes', () => {
    const c = mountApp(() => h(MtPanel, { padding: 'sm', shadow: true }, { default: () => 'x' }))
    const panel = c.querySelector('.mt-panel') as HTMLElement
    expect(panel.classList.contains('mt-panel--sm')).toBe(true)
    expect(panel.classList.contains('mt-panel--shadow')).toBe(true)
  })

  it('defaults to md padding and no shadow', () => {
    const c = mountApp(() => h(MtPanel, {}, { default: () => 'x' }))
    const panel = c.querySelector('.mt-panel') as HTMLElement
    expect(panel.classList.contains('mt-panel--md')).toBe(true)
    expect(panel.classList.contains('mt-panel--shadow')).toBe(false)
  })
})
