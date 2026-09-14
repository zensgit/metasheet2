// r4 items 4/5 (2026-09-10 field-manager test feedback, screenshots): the "配置" panel for a
// field type with no branch in MetaFieldManager.vue's configTargetType chain rendered nothing
// between the header and the Save/Cancel row — indistinguishable from a broken dialog. Separately,
// the formula panel (expression + AI generate + insert-field chips + formula reference catalog)
// had no bound on its own height, so inside the modal's fixed max-height box it pushed the
// Save/Cancel row below the viewport with no way to scroll to it.
//
// This file is intentionally separate from multitable-field-manager.spec.ts: the parallel
// #5602 branch (feat/multitable-field-manager-hint-palette-retype) appends ~800 lines to the end
// of that same file, and a second concurrent append to the same anchor line risks an avoidable
// merge hunk collision. Registered in .github/workflows/multitable-web-guard.yml (two `paths`
// lists + its own `Run field-config panel spec` step — deliberately NOT one more token on that
// workflow's single ~10KB `vitest run` line, which every concurrent web-spec branch also edits)
// and apps/web/scripts/run-required-web-tests.sh (own `npx vitest run` line, same reason).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaFieldManager from '../src/multitable/components/MetaFieldManager.vue'
import { managerLabel } from '../src/multitable/utils/meta-manager-labels'

describe('MetaFieldManager — field-config panel: no-options fallback + scroll container', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  function mountManager(fields: Record<string, unknown>[]) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({
      render() {
        return h(MetaFieldManager, { visible: true, sheetId: 'sheet_1', sheets: [], fields })
      },
    })
    app.mount(container)
    return { container, app }
  }

  async function openConfig(container: HTMLElement, fieldName: string) {
    const rows = Array.from(container.querySelectorAll('.meta-field-mgr__row'))
    const row = rows.find((r) => r.querySelector('.meta-field-mgr__name')?.textContent === fieldName)
    const configureButton = row?.querySelector('.meta-field-mgr__action[title="Configure"]') as HTMLButtonElement | null
    expect(configureButton).toBeTruthy()
    configureButton!.click()
    await nextTick()
  }

  // --- item 4: types with NO branch in the configTargetType chain (own enumeration —
  // dateTime and boolean/checkbox have no template branch, unlike select/link/person/
  // lookup/rollup/formula/attachment/number/currency/percent/rating/duration/button/
  // autoNumber which all DO, and unlike string/longText which render the separate
  // always-on AI-shortcut section instead of being blank). ---

  it('shows the no-configurable-options fallback (not a blank panel) for dateTime', async () => {
    const { container, app } = mountManager([{ id: 'fld_due', name: 'Due', type: 'dateTime', property: {} }])
    try {
      await openConfig(container, 'Due')

      const notice = container.querySelector('[data-test="field-config-no-options"]')
      expect(notice).toBeTruthy()
      expect(notice!.textContent).toBe(managerLabel('field.noConfigurableOptions', false))

      // Blank-panel proof: between the header and the Save/Cancel row there must be no
      // input/select/textarea control at all — only the notice text node.
      const configPanel = container.querySelector('.meta-field-mgr__config') as HTMLElement
      const controls = configPanel.querySelectorAll('input, select, textarea')
      expect(controls.length).toBe(0)
    } finally {
      app.unmount()
    }
  })

  it('shows the no-configurable-options fallback for boolean (checkbox)', async () => {
    const { container, app } = mountManager([{ id: 'fld_done', name: 'Done', type: 'boolean', property: {} }])
    try {
      await openConfig(container, 'Done')
      const notice = container.querySelector('[data-test="field-config-no-options"]')
      expect(notice).toBeTruthy()
      expect(notice!.textContent?.length).toBeGreaterThan(0)
    } finally {
      app.unmount()
    }
  })

  it('shows the no-configurable-options fallback for the read-only createdBy system field', async () => {
    const { container, app } = mountManager([{ id: 'fld_creator', name: 'Creator', type: 'createdBy', property: {} }])
    try {
      await openConfig(container, 'Creator')
      const notice = container.querySelector('[data-test="field-config-no-options"]')
      expect(notice).toBeTruthy()
    } finally {
      app.unmount()
    }
  })

  it('does NOT show the fallback for number, which has real configurable options', async () => {
    const { container, app } = mountManager([{ id: 'fld_qty', name: 'Qty', type: 'number', property: {} }])
    try {
      await openConfig(container, 'Qty')
      expect(container.querySelector('[data-test="field-config-no-options"]')).toBeFalsy()
      const configPanel = container.querySelector('.meta-field-mgr__config') as HTMLElement
      expect(configPanel.querySelectorAll('input, select, textarea').length).toBeGreaterThan(0)
    } finally {
      app.unmount()
    }
  })

  it('does NOT show the fallback for select, which has real configurable options', async () => {
    const { container, app } = mountManager([
      { id: 'fld_status', name: 'Status', type: 'select', property: { options: [] } },
    ])
    try {
      await openConfig(container, 'Status')
      expect(container.querySelector('[data-test="field-config-no-options"]')).toBeFalsy()
    } finally {
      app.unmount()
    }
  })

  it('does NOT show the fallback for string, which renders the AI-shortcut section instead', async () => {
    const { container, app } = mountManager([{ id: 'fld_name', name: 'Name', type: 'string', property: {} }])
    try {
      await openConfig(container, 'Name')
      expect(container.querySelector('[data-test="field-config-no-options"]')).toBeFalsy()
      expect(container.querySelector('[data-test="ai-shortcut-section"]')).toBeTruthy()
    } finally {
      app.unmount()
    }
  })

  // --- item 5: the config panel container must be its own bounded scroll region so the
  // Save/Cancel row stays reachable regardless of how tall the type-specific content is. ---

  it('gives the config panel container its own scroll region, with Save/Cancel inside it', async () => {
    const { container, app } = mountManager([{ id: 'fld_qty', name: 'Qty', type: 'number', property: {} }])
    try {
      await openConfig(container, 'Qty')
      const configPanel = container.querySelector('.meta-field-mgr__config') as HTMLElement
      expect(configPanel.classList.contains('meta-field-mgr__config--scrollable')).toBe(true)

      const actions = configPanel.querySelector('.meta-field-mgr__config-actions')
      expect(actions).toBeTruthy()
      // The Save/Cancel row must be a DESCENDANT of the scrollable container (so the sticky
      // footer rule in <style> — `.meta-field-mgr__config--scrollable .meta-field-mgr__config-actions`
      // — actually applies to it) rather than a sibling that merely happens to render after it.
      expect(configPanel.contains(actions)).toBe(true)
      const saveButton = Array.from(configPanel.querySelectorAll('button, [role="button"]'))
        .find((el) => el.textContent?.includes('Save field settings'))
      expect(saveButton).toBeTruthy()
    } finally {
      app.unmount()
    }
  })

  it('keeps the scroll container and reachable Save/Cancel row when the formula panel (tallest content) is mounted', async () => {
    const { container, app } = mountManager([
      { id: 'fld_total', name: 'Total', type: 'formula', property: { expression: '' } },
    ])
    try {
      await openConfig(container, 'Total')
      const configPanel = container.querySelector('.meta-field-mgr__config') as HTMLElement
      expect(configPanel.classList.contains('meta-field-mgr__config--scrollable')).toBe(true)

      // Formula-specific tall content actually mounted (expression box + reference catalog).
      expect(configPanel.querySelector('textarea.meta-field-mgr__textarea')).toBeTruthy()
      const formulaDocs = configPanel.querySelector('.meta-field-mgr__formula-docs')
      expect(formulaDocs).toBeTruthy()

      // Save/Cancel must still be inside the SAME scrollable container as the tall formula
      // content, not pushed outside it.
      const actions = configPanel.querySelector('.meta-field-mgr__config-actions')
      expect(configPanel.contains(actions)).toBe(true)
    } finally {
      app.unmount()
    }
  })
})

// --- item 5, source-level half ---------------------------------------------------------------
// The mount tests above can only prove the CLASS is applied and that Save/Cancel is a descendant
// of the container; jsdom parses no <style scoped> block and computes no layout, so the two CSS
// rules that ARE the actual fix could be deleted and every mount test would still pass. This
// block pins the rules themselves at source level — same mechanism as
// apps/web/tests/ui-foundation-style-guard.spec.ts:1-3, which is already a CI gate that reads
// .vue sources with readFileSync. Delete either rule from MetaFieldManager.vue and this reddens.
const SFC_SOURCE = readFileSync(
  join(__dirname, '../src/multitable/components/MetaFieldManager.vue'),
  'utf8',
)

// `[^}]*` is safe for both rules: neither declaration body contains a closing brace, and the
// single-selector pattern cannot swallow the descendant rule because it requires `{` right after
// the class name. Written as RegExp literals (not string concat) so the escapes are unambiguous.
const SCROLLABLE_RULE = /\.meta-field-mgr__config--scrollable\s*\{([^}]*)\}/
const STICKY_ACTIONS_RULE =
  /\.meta-field-mgr__config--scrollable\s+\.meta-field-mgr__config-actions\s*\{([^}]*)\}/

/** Body text of a `selector { ... }` rule (declarations only, braces stripped). */
function ruleBody(rule: RegExp): string {
  return SFC_SOURCE.match(rule)?.[1] ?? ''
}

describe('MetaFieldManager <style> — the config panel scroll rules (item 5 is 100% CSS)', () => {
  it('bounds .meta-field-mgr__config--scrollable and makes it scroll', () => {
    const body = ruleBody(SCROLLABLE_RULE)
    expect(body).not.toBe('')
    expect(body).toMatch(/overflow-y:\s*auto/)
    expect(body).toMatch(/max-height:\s*[^;]+/)
  })

  it('keeps that max-height viewport-relative, never a hardcoded px ceiling', () => {
    const body = ruleBody(SCROLLABLE_RULE)
    const maxHeight = body.match(/max-height:\s*([^;]+)/)?.[1]?.trim() ?? ''
    expect(maxHeight).not.toBe('')
    // A fixed px cap would clip the panel on short screens and waste space on tall ones —
    // the spec explicitly requires "相对弹窗可用高度，不要写死 px".
    expect(/^\d+(\.\d+)?px$/.test(maxHeight)).toBe(false)
    expect(maxHeight).toMatch(/vh|%/)
  })

  it('pins Save/Cancel to the bottom of that scroll region (sticky footer)', () => {
    const body = ruleBody(STICKY_ACTIONS_RULE)
    expect(body).not.toBe('')
    expect(body).toMatch(/position:\s*sticky/)
    expect(body).toMatch(/bottom:\s*0/)
    // Sticky over transparent background would let scrolled content show through the row.
    expect(body).toMatch(/background:\s*\S+/)
  })
})
// ==============================================================================================
// r8-B (2026-09-11, feedback item 8): the field-list / field-config splitter.
//
// The dialog's two halves shared one 84vh box with zero user control: `.meta-field-mgr__body` is
// `overflow-y: auto`, which resolves its `min-height: auto` to 0, so a tall config pane squeezed
// the field list to nothing and BOTH halves ended up unreadable. The splitter below moves the
// config pane's height ceiling (drag or keyboard), remembers it per browser, and the 放大/缩小
// toggle jumps to the current maximum and back to the last manually chosen height.
//
// Mechanics are a deliberate copy of MetaRecordInspector.vue's reviewed vertical splitter, so the
// cases here mirror multitable-record-inspector-resize.spec.ts's (primary-button guard, the
// try/finally teardown when releasePointerCapture throws, persist-on-release-only, the viewport
// re-clamp), retargeted at a HORIZONTAL separator.
// ==============================================================================================
const CONFIG_PANE_STORAGE_KEY = 'metasheet.fieldManager.configPaneHeight'
const CONFIG_PANE_MIN = 120
const CONFIG_PANE_STEP = 16
/** Component: `Math.round(viewportHeight * 0.84 - 160)`, floored at the minimum. */
function expectedMax(viewportHeight: number): number {
  return Math.max(CONFIG_PANE_MIN, Math.round(viewportHeight * 0.84 - 160))
}
/** Component: `clamp(Math.round(viewportHeight * 0.52))`. */
function expectedDefault(viewportHeight: number): number {
  return Math.max(CONFIG_PANE_MIN, Math.min(expectedMax(viewportHeight), Math.round(viewportHeight * 0.52)))
}

// Same jsdom idiom as multitable-record-inspector-resize.spec.ts's `setViewportWidth`: redefine the
// property and dispatch a real `resize` so the component's own listener (`syncViewportHeight`)
// picks it up.
function setViewportHeight(height: number): void {
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height })
  window.dispatchEvent(new Event('resize'))
}

async function flushUi(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function mountFieldManager(fields: Record<string, unknown>[]) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({
    render() {
      return h(MetaFieldManager, { visible: true, sheetId: 'sheet_1', sheets: [], fields })
    },
  })
  app.mount(container)
  return { container, app }
}

async function openFieldConfig(container: HTMLElement, fieldName: string) {
  const rows = Array.from(container.querySelectorAll('.meta-field-mgr__row'))
  const row = rows.find((r) => r.querySelector('.meta-field-mgr__name')?.textContent === fieldName)
  const configureButton = row?.querySelector('.meta-field-mgr__action[title="Configure"]') as HTMLButtonElement | null
  expect(configureButton).toBeTruthy()
  configureButton!.click()
  await flushUi()
}

/** Mount + open the config pane for a single number field — the shortest path to a live splitter. */
async function mountWithConfigOpen(viewportHeight = 1000) {
  setViewportHeight(viewportHeight)
  const { container, app } = mountFieldManager([{ id: 'fld_qty', name: 'Qty', type: 'number', property: {} }])
  await openFieldConfig(container, 'Qty')
  return { container, app }
}

function splitter(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>('[data-test="field-mgr-splitter"]')!
}

function expandToggle(container: HTMLElement): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('[data-test="field-mgr-config-expand"]')!
}

/** The px the component actually publishes to CSS (the inline custom property on the root). */
function configPaneHeightPx(container: HTMLElement): number {
  const root = container.querySelector<HTMLElement>('.meta-field-mgr')!
  return Number(root.style.getPropertyValue('--meta-field-mgr-config-height').replace('px', ''))
}

function ariaValueNow(el: HTMLElement): number {
  return Number(el.getAttribute('aria-valuenow'))
}

function keydown(el: HTMLElement, key: string) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}
function keyup(el: HTMLElement, key: string) {
  el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }))
}
function pointer(type: string, clientY: number, pointerId: number, extra: PointerEventInit = {}) {
  return new PointerEvent(type, { clientY, pointerId, bubbles: true, cancelable: true, ...extra })
}

describe('MetaFieldManager — resizable field-list / field-config split (r8-B)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    setViewportHeight(768)
  })

  describe('separator semantics', () => {
    it('exposes role=separator with aria-orientation=horizontal and the valuenow/min/max trio', async () => {
      const { container, app } = await mountWithConfigOpen(1000)
      try {
        const el = splitter(container)
        expect(el).toBeTruthy()
        expect(el.getAttribute('role')).toBe('separator')
        expect(el.getAttribute('aria-orientation')).toBe('horizontal')
        expect(el.getAttribute('tabindex')).toBe('0')
        expect(Number(el.getAttribute('aria-valuemin'))).toBe(CONFIG_PANE_MIN)
        expect(Number(el.getAttribute('aria-valuemax'))).toBe(expectedMax(1000))
        expect(ariaValueNow(el)).toBe(expectedDefault(1000))
        expect(configPaneHeightPx(container)).toBe(expectedDefault(1000))
        // Chrome copy comes from meta-manager-labels.ts, never inline in the SFC.
        expect(el.getAttribute('aria-label')).toBe(managerLabel('field.configPaneResizeHandle', false))
      } finally {
        app.unmount()
      }
    })

    it('mounts no splitter while no field config pane is open (nothing to split)', async () => {
      setViewportHeight(1000)
      const { container, app } = mountFieldManager([{ id: 'fld_qty', name: 'Qty', type: 'number', property: {} }])
      try {
        await flushUi()
        expect(container.querySelector('[data-test="field-mgr-splitter"]')).toBeFalsy()
        await openFieldConfig(container, 'Qty')
        expect(container.querySelector('[data-test="field-mgr-splitter"]')).toBeTruthy()
      } finally {
        app.unmount()
      }
    })
  })

  describe('keyboard resize (+-16px, Home/End, clamped)', () => {
    it('ArrowUp grows the config pane by one step and ArrowDown shrinks it back', async () => {
      const { container, app } = await mountWithConfigOpen(1000)
      try {
        const el = splitter(container)
        const start = expectedDefault(1000)
        keydown(el, 'ArrowUp')
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(start + CONFIG_PANE_STEP)
        expect(ariaValueNow(splitter(container))).toBe(start + CONFIG_PANE_STEP)
        keydown(el, 'ArrowDown')
        keydown(el, 'ArrowDown')
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(start - CONFIG_PANE_STEP)
      } finally {
        app.unmount()
      }
    })

    it('Home jumps to the 120px floor and End to the viewport-derived ceiling', async () => {
      const { container, app } = await mountWithConfigOpen(1000)
      try {
        const el = splitter(container)
        keydown(el, 'Home')
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(CONFIG_PANE_MIN)
        keydown(el, 'End')
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(expectedMax(1000))
      } finally {
        app.unmount()
      }
    })

    it('clamps at both ends: repeated ArrowDown never goes under the floor, ArrowUp never over the ceiling', async () => {
      const { container, app } = await mountWithConfigOpen(1000)
      try {
        const el = splitter(container)
        for (let i = 0; i < 60; i += 1) keydown(el, 'ArrowDown')
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(CONFIG_PANE_MIN)
        for (let i = 0; i < 60; i += 1) keydown(el, 'ArrowUp')
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(expectedMax(1000))
        const el2 = splitter(container)
        expect(ariaValueNow(el2)).toBeLessThanOrEqual(Number(el2.getAttribute('aria-valuemax')))
      } finally {
        app.unmount()
      }
    })

    it('consumes the four resize keys (preventDefault) so they do not also scroll the dialog', async () => {
      const { container, app } = await mountWithConfigOpen(1000)
      try {
        for (const key of ['ArrowUp', 'ArrowDown', 'Home', 'End']) {
          const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
          splitter(container).dispatchEvent(event)
          expect(event.defaultPrevented, `${key} must be consumed`).toBe(true)
        }
        // A key the splitter does NOT own stays available to the rest of the dialog.
        const passthrough = new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true, cancelable: true })
        splitter(container).dispatchEvent(passthrough)
        expect(passthrough.defaultPrevented).toBe(false)
      } finally {
        app.unmount()
      }
    })

    it('consumes the resize keys only from the splitter: the same keys elsewhere in the dialog do nothing', async () => {
      const { container, app } = await mountWithConfigOpen(1000)
      try {
        const before = configPaneHeightPx(container)
        const someInput = container.querySelector<HTMLElement>('.meta-field-mgr__config input')!
        keydown(someInput, 'ArrowUp')
        keydown(someInput, 'Home')
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(before)
      } finally {
        app.unmount()
      }
    })
  })

  describe('pointer drag', () => {
    it('pointerdown on the splitter calls preventDefault (blocks text selection mid-drag)', async () => {
      const { container, app } = await mountWithConfigOpen(1000)
      try {
        const event = pointer('pointerdown', 500, 3)
        splitter(container).dispatchEvent(event)
        expect(event.defaultPrevented).toBe(true)
      } finally {
        app.unmount()
      }
    })

    it('captures the pointer on the HANDLE itself (that is what makes handle-scoped listeners enough)', async () => {
      const { container, app } = await mountWithConfigOpen(1000)
      try {
        const el = splitter(container)
        // jsdom implements neither capture method, so an own-property stub is the only way to see
        // the call at all; without it the component's `?.` swallows the whole mechanic silently.
        const capture = vi.fn()
        ;(el as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture = capture
        el.dispatchEvent(pointer('pointerdown', 500, 11))
        expect(capture).toHaveBeenCalledWith(11)
        el.dispatchEvent(pointer('pointerup', 500, 11))
      } finally {
        app.unmount()
      }
    })

    it('primary-button guard: a right-click neither preventDefaults nor starts a drag', async () => {
      const { container, app } = await mountWithConfigOpen(1000)
      try {
        const el = splitter(container)
        const event = pointer('pointerdown', 500, 4, { pointerType: 'mouse', button: 2 })
        el.dispatchEvent(event)
        expect(event.defaultPrevented).toBe(false)
        el.dispatchEvent(pointer('pointermove', 300, 4))
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(expectedDefault(1000))
      } finally {
        app.unmount()
      }
    })

    it('dragging the handle UP (negative clientY delta) grows the config pane; listeners are torn down on pointerup', async () => {
      const { container, app } = await mountWithConfigOpen(1000)
      try {
        const el = splitter(container)
        const start = expectedDefault(1000)
        // jsdom has no real setPointerCapture, so the component's `?.` guard must swallow it; the
        // pointermove is dispatched on the same element, so no OS-level capture redirect is needed.
        el.dispatchEvent(pointer('pointerdown', 500, 1))
        el.dispatchEvent(pointer('pointermove', 470, 1)) // -30 -> +30 height
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(start + 30)
        el.dispatchEvent(pointer('pointerup', 470, 1))
        el.dispatchEvent(pointer('pointermove', 300, 1)) // must no longer be tracked
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(start + 30)
      } finally {
        app.unmount()
      }
    })

    it('dragging the handle DOWN shrinks the pane, clamped at the 120px floor', async () => {
      const { container, app } = await mountWithConfigOpen(1000)
      try {
        const el = splitter(container)
        el.dispatchEvent(pointer('pointerdown', 300, 2))
        el.dispatchEvent(pointer('pointermove', 1200, 2)) // way past the floor
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(CONFIG_PANE_MIN)
        el.dispatchEvent(pointer('pointerup', 1200, 2))
      } finally {
        app.unmount()
      }
    })

    it('does not persist on pointermove, writes exactly once on pointerup', async () => {
      const { container, app } = await mountWithConfigOpen(1000)
      try {
        // Storage.prototype spies do not record under tests/setup/localstorage.ts (a fresh plain
        // object Storage polyfill per test) — spy the INSTANCE.
        const setItemSpy = vi.spyOn(window.localStorage, 'setItem')
        const el = splitter(container)
        const start = expectedDefault(1000)
        el.dispatchEvent(pointer('pointerdown', 500, 5))
        el.dispatchEvent(pointer('pointermove', 480, 5))
        el.dispatchEvent(pointer('pointermove', 460, 5))
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(start + 40)
        expect(setItemSpy).not.toHaveBeenCalled()
        el.dispatchEvent(pointer('pointerup', 460, 5))
        await flushUi()
        expect(setItemSpy).toHaveBeenCalledTimes(1)
        expect(setItemSpy).toHaveBeenCalledWith(CONFIG_PANE_STORAGE_KEY, String(start + 40))
      } finally {
        app.unmount()
      }
    })

    it('pointercancel ends the gesture exactly like pointerup (persists, then stops tracking)', async () => {
      const { container, app } = await mountWithConfigOpen(1000)
      try {
        const el = splitter(container)
        const start = expectedDefault(1000)
        el.dispatchEvent(pointer('pointerdown', 500, 6))
        el.dispatchEvent(pointer('pointermove', 480, 6))
        await flushUi()
        el.dispatchEvent(pointer('pointercancel', 480, 6))
        await flushUi()
        expect(window.localStorage.getItem(CONFIG_PANE_STORAGE_KEY)).toBe(String(start + 20))
        el.dispatchEvent(pointer('pointermove', 200, 6))
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(start + 20)
      } finally {
        app.unmount()
      }
    })

    it('the finally path still tears down all three listeners (and persists) when releasePointerCapture throws', async () => {
      const { container, app } = await mountWithConfigOpen(1000)
      try {
        const el = splitter(container)
        const start = expectedDefault(1000)
        // jsdom has no releasePointerCapture on the prototype, so an own-property stub is what makes
        // the component's `handle.releasePointerCapture?.(...)` find and call a throwing function.
        ;(el as unknown as { releasePointerCapture: () => void }).releasePointerCapture = () => {
          throw new Error('boom (deliberate — proves cleanup runs despite the throw)')
        }
        // The throw propagates out of the listener; jsdom reports it as a window `error` event which
        // vitest would otherwise fail the run on. Swallow it here, scoped to this one test.
        const swallowExpectedThrow = (event: ErrorEvent) => event.preventDefault()
        window.addEventListener('error', swallowExpectedThrow)
        el.dispatchEvent(pointer('pointerdown', 500, 9))
        el.dispatchEvent(pointer('pointermove', 470, 9))
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(start + 30)
        el.dispatchEvent(pointer('pointerup', 470, 9))
        await flushUi()
        window.removeEventListener('error', swallowExpectedThrow)
        // The release-time persist lives in the same `finally`.
        expect(window.localStorage.getItem(CONFIG_PANE_STORAGE_KEY)).toBe(String(start + 30))
        // And a later bare pointermove must not still resize — without try/finally the three
        // removeEventListener calls would have been skipped and `onMove` would stay attached.
        el.dispatchEvent(pointer('pointermove', 200, 9))
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(start + 30)
      } finally {
        app.unmount()
      }
    })
  })

  describe('persistence (per browser, not per user)', () => {
    it('persists a keyboard resize on keyup and restores it on a fresh mount', async () => {
      const first = await mountWithConfigOpen(1000)
      const el = splitter(first.container)
      keydown(el, 'ArrowUp')
      keyup(el, 'ArrowUp')
      await flushUi()
      const expected = expectedDefault(1000) + CONFIG_PANE_STEP
      expect(window.localStorage.getItem(CONFIG_PANE_STORAGE_KEY)).toBe(String(expected))
      first.app.unmount()
      first.container.remove()

      const second = await mountWithConfigOpen(1000)
      try {
        expect(configPaneHeightPx(second.container)).toBe(expected)
        expect(ariaValueNow(splitter(second.container))).toBe(expected)
      } finally {
        second.app.unmount()
      }
    })

    it('a Tab keyup on the splitter (pure focus movement) writes nothing', async () => {
      const { container, app } = await mountWithConfigOpen(1000)
      try {
        const setItemSpy = vi.spyOn(window.localStorage, 'setItem')
        keyup(splitter(container), 'Tab')
        await flushUi()
        expect(setItemSpy).not.toHaveBeenCalled()
      } finally {
        app.unmount()
      }
    })

    it('clamps an out-of-range stored height instead of discarding it', async () => {
      window.localStorage.setItem(CONFIG_PANE_STORAGE_KEY, '5000')
      const { container, app } = await mountWithConfigOpen(1000)
      try {
        expect(configPaneHeightPx(container)).toBe(expectedMax(1000))
      } finally {
        app.unmount()
      }
    })

    it('falls back to the default for a corrupt or non-positive stored height', async () => {
      window.localStorage.setItem(CONFIG_PANE_STORAGE_KEY, 'not-a-number')
      const corrupt = await mountWithConfigOpen(1000)
      expect(configPaneHeightPx(corrupt.container)).toBe(expectedDefault(1000))
      corrupt.app.unmount()
      corrupt.container.remove()

      // `-50` exercises the `parsed <= 0` guard specifically: the floor (120) and the default (520)
      // differ here, so a missing guard would land on 120 and this assertion would fail.
      window.localStorage.setItem(CONFIG_PANE_STORAGE_KEY, '-50')
      const negative = await mountWithConfigOpen(1000)
      try {
        expect(configPaneHeightPx(negative.container)).toBe(expectedDefault(1000))
      } finally {
        negative.app.unmount()
      }
    })
  })

  describe('放大/缩小 toggle', () => {
    it('toggles aria-pressed, jumps to the ceiling, and returns to the last MANUAL height', async () => {
      const { container, app } = await mountWithConfigOpen(1000)
      try {
        const el = splitter(container)
        keydown(el, 'ArrowUp') // a manual choice: default + 16
        keyup(el, 'ArrowUp')
        await flushUi()
        const manual = expectedDefault(1000) + CONFIG_PANE_STEP

        const toggle = expandToggle(container)
        expect(toggle.getAttribute('aria-pressed')).toBe('false')
        expect(toggle.getAttribute('aria-label')).toBe(managerLabel('field.configPaneExpand', false))

        toggle.click()
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(expectedMax(1000))
        expect(expandToggle(container).getAttribute('aria-pressed')).toBe('true')
        expect(expandToggle(container).getAttribute('aria-label')).toBe(managerLabel('field.configPaneCollapse', false))
        // What gets stored is the MANUAL height, never the enlarge-produced ceiling. (This assertion
        // used to read `expectedMax(1000)` and was pinning the bug: storing the ceiling made the
        // next mount seed both the live height and the restore target from it, so the pair went
        // dead after a reload — see the cross-mount case below.)
        expect(window.localStorage.getItem(CONFIG_PANE_STORAGE_KEY)).toBe(String(manual))

        expandToggle(container).click()
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(manual)
        expect(expandToggle(container).getAttribute('aria-pressed')).toBe('false')
        expect(window.localStorage.getItem(CONFIG_PANE_STORAGE_KEY)).toBe(String(manual))
      } finally {
        app.unmount()
      }
    })

    // The two cases below are about the pair ACROSS MOUNTS / after a reload — the path every
    // same-mount case above structurally misses, and the one where the pair went dead: both clicks
    // produced no visual change at all once the stored number was the ceiling.
    it('after enlarge → reload, the pair still moves (a reload never comes back pinned to the ceiling)', async () => {
      const first = await mountWithConfigOpen(1000)
      expandToggle(first.container).click()
      await flushUi()
      expect(configPaneHeightPx(first.container)).toBe(expectedMax(1000))
      // The reload will read THIS number: the last manual height, not the ceiling it is showing.
      expect(window.localStorage.getItem(CONFIG_PANE_STORAGE_KEY)).toBe(String(expectedDefault(1000)))
      first.app.unmount()
      first.container.remove()

      const second = await mountWithConfigOpen(1000)
      try {
        expect(configPaneHeightPx(second.container)).toBe(expectedDefault(1000))
        expect(expandToggle(second.container).getAttribute('aria-pressed')).toBe('false')
        expandToggle(second.container).click()
        await flushUi()
        expect(configPaneHeightPx(second.container)).toBe(expectedMax(1000))
        expandToggle(second.container).click()
        await flushUi()
        expect(configPaneHeightPx(second.container)).toBeLessThan(expectedMax(1000))
        expect(configPaneHeightPx(second.container)).toBe(expectedDefault(1000))
      } finally {
        second.app.unmount()
      }
    })

    it('collapse still moves when the remembered MANUAL height is itself the ceiling (End, then the pair)', async () => {
      const { container, app } = await mountWithConfigOpen(1000)
      try {
        const el = splitter(container)
        keydown(el, 'End') // a manual choice that lands exactly on the ceiling
        keyup(el, 'End')
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(expectedMax(1000))

        expandToggle(container).click() // enlarging an already-maxed pane
        await flushUi()
        expect(expandToggle(container).getAttribute('aria-pressed')).toBe('true')
        expandToggle(container).click()
        await flushUi()
        // Collapse must not "restore" the ceiling it is already at: it falls back to the default,
        // capped one step below the ceiling so the move is always visible.
        const fallback = Math.min(expectedDefault(1000), expectedMax(1000) - CONFIG_PANE_STEP)
        expect(configPaneHeightPx(container)).toBe(fallback)
        expect(configPaneHeightPx(container)).toBeLessThan(expectedMax(1000))
        expect(expandToggle(container).getAttribute('aria-pressed')).toBe('false')
        expect(window.localStorage.getItem(CONFIG_PANE_STORAGE_KEY)).toBe(String(fallback))
      } finally {
        app.unmount()
      }
    })

    it('a manual resize while expanded drops the pressed state (aria-pressed must not lie)', async () => {
      const { container, app } = await mountWithConfigOpen(1000)
      try {
        expandToggle(container).click()
        await flushUi()
        expect(expandToggle(container).getAttribute('aria-pressed')).toBe('true')
        keydown(splitter(container), 'End') // lands exactly ON the max, and still un-presses
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(expectedMax(1000))
        expect(expandToggle(container).getAttribute('aria-pressed')).toBe('false')
      } finally {
        app.unmount()
      }
    })
  })

  describe('viewport changes', () => {
    it('re-clamps a too-tall pane when the window shrinks (aria-valuenow never exceeds valuemax)', async () => {
      const { container, app } = await mountWithConfigOpen(1000)
      try {
        keydown(splitter(container), 'End')
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(expectedMax(1000))

        setViewportHeight(500)
        await flushUi()
        const el = splitter(container)
        expect(configPaneHeightPx(container)).toBe(expectedMax(500))
        expect(ariaValueNow(el)).toBeLessThanOrEqual(Number(el.getAttribute('aria-valuemax')))
      } finally {
        app.unmount()
      }
    })

    it('keeps an EXPANDED pane pinned to the new ceiling in both directions', async () => {
      const { container, app } = await mountWithConfigOpen(1000)
      try {
        expandToggle(container).click()
        await flushUi()
        setViewportHeight(600)
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(expectedMax(600))
        setViewportHeight(1200)
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(expectedMax(1200))
        expect(expandToggle(container).getAttribute('aria-pressed')).toBe('true')
      } finally {
        app.unmount()
      }
    })

    it('stops tracking the viewport once the dialog unmounts (no leaked resize listener)', async () => {
      // This has to be proven through the listener REGISTRY, not through behaviour: a leaked
      // `syncViewportHeight` only assigns to a ref of a torn-down component, which throws nothing
      // and renders nothing — an earlier `expect(() => setViewportHeight(400)).not.toThrow()` here
      // stayed green with the component's `removeEventListener` line deleted outright.
      const addSpy = vi.spyOn(window, 'addEventListener')
      const { container, app } = await mountWithConfigOpen(1000)
      const added = addSpy.mock.calls.filter(([type]) => type === 'resize').map(([, handler]) => handler)
      expect(added.length).toBeGreaterThan(0)

      const el = splitter(container)
      keydown(el, 'End')
      await flushUi()

      const removeSpy = vi.spyOn(window, 'removeEventListener')
      app.unmount()
      const removed = removeSpy.mock.calls.filter(([type]) => type === 'resize').map(([, handler]) => handler)
      // Every resize handler this mount registered must have been handed back on unmount.
      expect(added.filter((handler) => !removed.includes(handler))).toEqual([])
      // ...and the post-unmount resize itself must still be inert.
      expect(() => setViewportHeight(400)).not.toThrow()
    })
  })
})

// --- r8-B, source-level half ------------------------------------------------------------------
// jsdom parses no <style scoped> and computes no layout, so the two rules that ARE half of this fix
// (the list's own floor, and the width no longer being a bare px literal) cannot be observed from a
// mounted test at all. Same mechanism as the item-5 block above.
const ROOT_RULE = /\.meta-field-mgr\s*\{([^}]*)\}/
const BODY_RULE = /\.meta-field-mgr__body\s*\{([^}]*)\}/
const SPLITTER_RULE = /\.meta-field-mgr__splitter\s*\{([^}]*)\}/

describe('MetaFieldManager <style> — the split is half CSS (r8-B)', () => {
  it('gives the field list a floor so a tall config pane can never squeeze it to zero', () => {
    const body = SFC_SOURCE.match(BODY_RULE)?.[1] ?? ''
    expect(body).not.toBe('')
    // `overflow-y: auto` resolves `min-height: auto` to 0 for a flex item — this is the ONLY thing
    // standing between a tall config pane and a zero-height field list.
    expect(body).toMatch(/overflow-y:\s*auto/)
    expect(body).toMatch(/min-height:\s*\d+px/)
  })

  it('drives the dialog width through a custom property with a viewport bound, not a bare 720px', () => {
    const body = SFC_SOURCE.match(ROOT_RULE)?.[1] ?? ''
    expect(body).not.toBe('')
    expect(body).toMatch(/width:\s*var\(--meta-field-mgr-width,\s*720px\)/)
    expect(body).toMatch(/max-width:\s*calc\(100vw - 32px\)/)
    // The pre-fix rule (`width: 720px`) ran off both edges of a narrow window with no way out.
    expect(/width:\s*720px\s*;/.test(body)).toBe(false)
  })

  it('drives the config pane ceiling from the splitter variable, keeping the viewport expression as its fallback', () => {
    const body = ruleBody(SCROLLABLE_RULE)
    expect(body).toMatch(/max-height:\s*var\(--meta-field-mgr-config-height,/)
  })

  it('makes the handle grabbable and keyboard-visible (row-resize, no touch scroll hijack)', () => {
    const body = SFC_SOURCE.match(SPLITTER_RULE)?.[1] ?? ''
    expect(body).not.toBe('')
    expect(body).toMatch(/cursor:\s*row-resize/)
    // Without this a touch drag scrolls the field list instead of moving the boundary.
    expect(body).toMatch(/touch-action:\s*none/)
    expect(SFC_SOURCE).toMatch(/\.meta-field-mgr__splitter:focus-visible\s*\{/)
  })
})
