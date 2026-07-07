import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'
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

function dispatchOutsideMousedown() {
  const outside = document.createElement('div')
  outside.className = 'outside-target'
  document.body.appendChild(outside)
  outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  outside.remove()
}

describe('MtPopover', () => {
  it('opens on trigger click and closes again on a second trigger click (v-model:open)', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({
      setup() {
        const open = ref(false)
        return () =>
          h(
            MtPopover,
            { open: open.value, 'onUpdate:open': (v: boolean) => { open.value = v } },
            {
              trigger: () => h('button', { class: 'trigger-btn' }, 'Open'),
              default: () => h('div', { class: 'content' }, 'Popover content'),
            },
          )
      },
    })
    app.mount(container)
    await nextTick()

    expect(document.querySelector('.mt-popover')).toBeNull()

    const trigger = container.querySelector('.trigger-btn') as HTMLButtonElement
    trigger.click()
    await nextTick()
    expect(document.querySelector('.mt-popover')).not.toBeNull()
    expect(document.querySelector('.mt-popover .content')?.textContent).toBe('Popover content')

    trigger.click()
    await nextTick()
    expect(document.querySelector('.mt-popover')).toBeNull()
  })

  it('closes on Escape while open', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({
      setup() {
        const open = ref(false)
        return () =>
          h(
            MtPopover,
            { open: open.value, 'onUpdate:open': (v: boolean) => { open.value = v } },
            {
              trigger: () => h('button', { class: 'trigger-btn' }, 'Open'),
              default: () => h('div', { class: 'content' }, 'Content'),
            },
          )
      },
    })
    app.mount(container)
    await nextTick()

    ;(container.querySelector('.trigger-btn') as HTMLButtonElement).click()
    await nextTick()
    expect(document.querySelector('.mt-popover')).not.toBeNull()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(document.querySelector('.mt-popover')).toBeNull()
  })

  it('closes on a click outside the trigger and panel', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({
      setup() {
        const open = ref(false)
        return () =>
          h(
            MtPopover,
            { open: open.value, 'onUpdate:open': (v: boolean) => { open.value = v } },
            {
              trigger: () => h('button', { class: 'trigger-btn' }, 'Open'),
              default: () => h('div', { class: 'content' }, 'Content'),
            },
          )
      },
    })
    app.mount(container)
    await nextTick()

    ;(container.querySelector('.trigger-btn') as HTMLButtonElement).click()
    await nextTick()
    expect(document.querySelector('.mt-popover')).not.toBeNull()

    dispatchOutsideMousedown()
    await nextTick()
    expect(document.querySelector('.mt-popover')).toBeNull()
  })

  it('a click INSIDE the panel does not close it', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({
      setup() {
        const open = ref(false)
        return () =>
          h(
            MtPopover,
            { open: open.value, 'onUpdate:open': (v: boolean) => { open.value = v } },
            {
              trigger: () => h('button', { class: 'trigger-btn' }, 'Open'),
              default: () => h('div', { class: 'content' }, 'Content'),
            },
          )
      },
    })
    app.mount(container)
    await nextTick()

    ;(container.querySelector('.trigger-btn') as HTMLButtonElement).click()
    await nextTick()
    const content = document.querySelector('.mt-popover .content') as HTMLElement
    content.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await nextTick()
    expect(document.querySelector('.mt-popover')).not.toBeNull()
  })
})

describe('MtMenu / MtMenuItem', () => {
  function mountMenu(onSelect: () => void, onDisabledSelect: () => void) {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({
      render: () =>
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
    })
    app.mount(container!)
    return container!
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
})

describe('MtPanel', () => {
  it('renders its default slot content inside a .mt-panel container', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({ render: () => h(MtPanel, {}, { default: () => h('div', { class: 'inner' }, 'Grouped') }) })
    app.mount(container)
    const panel = container.querySelector('.mt-panel') as HTMLElement
    expect(panel).not.toBeNull()
    expect(panel.querySelector('.inner')?.textContent).toBe('Grouped')
  })

  it('applies the padding and shadow modifier classes', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({ render: () => h(MtPanel, { padding: 'sm', shadow: true }, { default: () => 'x' }) })
    app.mount(container)
    const panel = container.querySelector('.mt-panel') as HTMLElement
    expect(panel.classList.contains('mt-panel--sm')).toBe(true)
    expect(panel.classList.contains('mt-panel--shadow')).toBe(true)
  })

  it('defaults to md padding and no shadow', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({ render: () => h(MtPanel, {}, { default: () => 'x' }) })
    app.mount(container)
    const panel = container.querySelector('.mt-panel') as HTMLElement
    expect(panel.classList.contains('mt-panel--md')).toBe(true)
    expect(panel.classList.contains('mt-panel--shadow')).toBe(false)
  })
})
