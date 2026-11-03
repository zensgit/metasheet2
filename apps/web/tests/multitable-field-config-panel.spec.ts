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
import { createApp, h, nextTick, ref } from 'vue'
import MetaFieldManager from '../src/multitable/components/MetaFieldManager.vue'
import type { MetaField } from '../src/multitable/types'
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
// #7a review B1: the preference moved to a versioned key. The r8-B key below is what the deployed
// build wrote -- often a height the user never chose -- so it is ignored and removed, never migrated.
const CONFIG_PANE_STORAGE_KEY = 'metasheet.fieldManager.configPaneHeight.v2'
const LEGACY_CONFIG_PANE_STORAGE_KEY = 'metasheet.fieldManager.configPaneHeight'
const CONFIG_PANE_MIN = 120
const CONFIG_PANE_STEP = 16
// jsdom lays nothing out, so the component falls back to FALLBACK_FIXED_ROWS_HEIGHT (64) for its
// header + splitter + add-field row; with the list's 96px floor that is r8-B's `0.84vh - 160`.
// (Every viewport used by this block leaves room for both floors, so neither is scaled down here --
// the short-window regime is covered by the #7a block with a stubbed layout.)
const FALLBACK_FIXED_ROWS = 64
const FIELD_LIST_MIN = 96
/** Component: the room the list and the pane share = 84vh minus the fixed rows. */
function expectedRoom(viewportHeight: number): number {
  return viewportHeight * 0.84 - FALLBACK_FIXED_ROWS
}
/** Component: `floor(room - 96)`. */
function expectedMax(viewportHeight: number): number {
  return Math.floor(expectedRoom(viewportHeight) - FIELD_LIST_MIN)
}
/** Component (#7a): an untouched split gives each half `floor(room / 2)`, clamped. */
function expectedDefault(viewportHeight: number): number {
  return Math.max(CONFIG_PANE_MIN, Math.min(expectedMax(viewportHeight), Math.floor(expectedRoom(viewportHeight) / 2)))
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

      // `-50` exercises the `parsed <= 0` guard specifically: the floor (120) and the default (388)
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
      // Never the ceiling it is showing -- and (#7a) not the default either: the user chose no height,
      // so nothing is stored and the reload starts from the live default.
      expect(window.localStorage.getItem(CONFIG_PANE_STORAGE_KEY)).toBeNull()
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
        const setItemSpy = vi.spyOn(window.localStorage, 'setItem')
        expandToggle(container).click()
        await flushUi()
        // Collapse must not "restore" the ceiling it is already at. #7a round 3: it forgets the
        // manual height instead -- the key is removed and the LIVE default applies -- where r8-B
        // stored that default (a number derived from this window) as if the user had chosen it.
        expect(configPaneHeightPx(container)).toBe(expectedDefault(1000))
        expect(configPaneHeightPx(container)).toBeLessThan(expectedMax(1000))
        expect(expandToggle(container).getAttribute('aria-pressed')).toBe('false')
        expect(window.localStorage.getItem(CONFIG_PANE_STORAGE_KEY)).toBeNull()
        expect(setItemSpy).not.toHaveBeenCalled()
        // ...so it keeps following the window.
        setViewportHeight(1200)
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(expectedDefault(1200))
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
        // #7a review: End on a pane already pinned to the max draws nothing new, so it is not a
        // resize and chooses nothing -- the toggle stays pressed, which is still the truth.
        keydown(splitter(container), 'End')
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(expectedMax(1000))
        expect(expandToggle(container).getAttribute('aria-pressed')).toBe('true')
        // A real resize while expanded un-presses it.
        keydown(splitter(container), 'ArrowDown')
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(expectedMax(1000) - CONFIG_PANE_STEP)
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
    // #7a: the floor is published by the script (so a very short window can lower it), with the same
    // 96px as the CSS fallback.
    expect(body).toMatch(/min-height:\s*var\(--meta-field-mgr-list-min-height,\s*96px\)/)
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

// ==============================================================================================
// 客户反馈 2026-09-24 #7a (also #5864 ②): "配置区高度调不了、⤢ 无效".
//
// The splitter and ⤢/⤡ only moved the pane's max-height, and the pane -- a shrinkable flex item in an
// 84vh flex column -- was drawn below that ceiling whenever its content was tall, so nothing moved on
// screen. The drawn heights themselves are asserted in a real browser
// (apps/web/verification/field-manager-config-pane.spec.ts). This block pins the arithmetic that
// makes the ceiling honourable and the state rules around it, against a STUBBED layout: jsdom lays
// nothing out, so `getBoundingClientRect` reports the row heights Chromium measures (header 57,
// splitter 6, add-field row 74, delete confirmation 84.5).
// ==============================================================================================
type StubRows = {
  header: number
  splitter: number
  add: number
  addError: number
  confirm: number
  /** The pane's DRAWN height, fixed (its content is taken to be exactly that tall); null = not laid
   *  out (the component then uses the published px), unless `paneContent` is set. */
  pane: number | null
  /** #7a round 3: the pane's CONTENT (natural border-box) height. The pane is then drawn the way the
   *  browser draws it, at min(published height, content), whatever the published height becomes. */
  paneContent: number | null
  /** #7a round 3: the height of the list's rows (the `.meta-field-mgr__list` wrapper); null = not laid
   *  out. jsdom applies no scoped CSS, so the list's own 16px padding is folded into this number. */
  list: number | null
}
const CHROMIUM_ROWS: StubRows = {
  header: 57, splitter: 6, add: 74, addError: 18, confirm: 84.5, pane: null, paneContent: null, list: null,
}

/** The px the component publishes, read from the root the pane sits in. */
function publishedPaneHeight(pane: Element): number {
  const root = pane.closest<HTMLElement>('.meta-field-mgr')
  return Number(root?.style.getPropertyValue('--meta-field-mgr-config-height').replace('px', '') ?? 0)
}

function stubLayout(overrides: Partial<StubRows> = {}) {
  const rows: StubRows = { ...CHROMIUM_ROWS, ...overrides }
  const isPane = (el: Element) => el.classList.contains('meta-field-mgr__config--scrollable')
  const paneContent = () => rows.pane ?? rows.paneContent
  const paneDrawn = (pane: Element) => {
    if (rows.pane !== null) return rows.pane
    if (rows.paneContent !== null) return Math.min(publishedPaneHeight(pane), rows.paneContent)
    return 0
  }
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const cl = this.classList
    let height = 0
    if (cl.contains('meta-field-mgr__header')) height = rows.header
    else if (cl.contains('meta-field-mgr__splitter')) height = rows.splitter
    else if (cl.contains('meta-field-mgr__add-section')) {
      height = rows.add + (this.querySelector('[data-test="add-conflict-error"]') ? rows.addError : 0)
    } else if (cl.contains('meta-field-mgr__confirm')) height = rows.confirm
    else if (isPane(this)) height = paneDrawn(this)
    else if (cl.contains('meta-field-mgr__list') && rows.list !== null) height = rows.list
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: height, width: 0, height, toJSON: () => ({}) } as DOMRect
  })
  // The pane's padding box, as the browser reports it under its 1px top border: `scrollHeight` is the
  // content, `clientHeight` what is drawn of it. Every other element keeps jsdom's 0.
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) {
    const content = paneContent()
    return isPane(this) && content !== null ? Math.max(0, content - 1) : 0
  })
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
    return isPane(this) ? Math.max(0, paneDrawn(this) - 1) : 0
  })
  return rows
}

function listFloorPx(container: HTMLElement): number {
  const root = container.querySelector<HTMLElement>('.meta-field-mgr')!
  return Number(root.style.getPropertyValue('--meta-field-mgr-list-min-height').replace('px', ''))
}

function ariaTrio(container: HTMLElement) {
  const el = splitter(container)
  return {
    now: Number(el.getAttribute('aria-valuenow')),
    min: Number(el.getAttribute('aria-valuemin')),
    max: Number(el.getAttribute('aria-valuemax')),
  }
}

function rowByName(container: HTMLElement, name: string): HTMLElement {
  const row = Array.from(container.querySelectorAll<HTMLElement>('.meta-field-mgr__row'))
    .find((r) => r.querySelector('.meta-field-mgr__name')?.textContent === name)
  expect(row, `row ${name}`).toBeTruthy()
  return row!
}

async function openDeleteConfirm(container: HTMLElement, name: string) {
  rowByName(container, name).querySelector<HTMLButtonElement>('.meta-field-mgr__action--danger')!.click()
  await flushUi()
  expect(container.querySelector('.meta-field-mgr__confirm'), 'confirmation row shown').toBeTruthy()
}

const TWO_FIELDS = [
  { id: 'fld_qty', name: 'Qty', type: 'number', property: {} },
  { id: 'fld_note', name: 'Note', type: 'string', property: {} },
]

async function mountMeasured(viewportHeight: number, overrides: Partial<StubRows> = {}) {
  stubLayout(overrides)
  setViewportHeight(viewportHeight)
  const { container, app } = mountFieldManager(TWO_FIELDS)
  await openFieldConfig(container, 'Qty')
  return { container, app }
}

describe('MetaFieldManager — #7a the config pane height actually applies (客户反馈 2026-09-24)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    setViewportHeight(768)
  })

  describe('the ceiling comes from MEASURED rows', () => {
    it('at 800px: 84vh minus header/splitter/add-field row minus the 96px list floor, and the default is half of the room', async () => {
      const { container, app } = await mountMeasured(800)
      try {
        // room = 672 - (57 + 6 + 74) = 535; max = 535 - 96 = 439; default = floor(535 / 2) = 267.
        // (r8-B's estimate `0.84vh - 160` claimed 512 here, 73px more than the frame could give.)
        expect(ariaTrio(container)).toEqual({ now: 267, min: 120, max: 439 })
        expect(configPaneHeightPx(container)).toBe(267)
        expect(listFloorPx(container)).toBe(96)
        // ⤢ has a real distance to travel from the default.
        expandToggle(container).click()
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(439)
      } finally {
        app.unmount()
      }
    })

    it('a delete confirmation opened under the open pane lowers the ceiling by its height; cancelling restores it', async () => {
      const { container, app } = await mountMeasured(800)
      try {
        keydown(splitter(container), 'End')
        keyup(splitter(container), 'End')
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(439)

        await openDeleteConfirm(container, 'Note')
        // The pane stays open; rows = ceil(57 + 6 + 74 + 84.5) = 222 -> room 450 -> max 354.
        expect(container.querySelector('.meta-field-mgr__config--scrollable')).toBeTruthy()
        expect(ariaTrio(container).max).toBe(354)
        expect(configPaneHeightPx(container)).toBe(354)
        expect(ariaTrio(container).now).toBeLessThanOrEqual(ariaTrio(container).max)

        container.querySelector<HTMLButtonElement>('.meta-field-mgr__confirm .meta-field-mgr__btn-cancel')!.click()
        await flushUi()
        expect(container.querySelector('.meta-field-mgr__confirm')).toBeFalsy()
        expect(ariaTrio(container).max).toBe(439)
        // The manual End choice comes back in full: the confirmation only clamped it for display.
        expect(configPaneHeightPx(container)).toBe(439)
      } finally {
        app.unmount()
      }
    })

    it('the add-name conflict error re-measures the add-field row (no ResizeObserver needed)', async () => {
      const { container, app } = await mountMeasured(800)
      try {
        expect(ariaTrio(container).max).toBe(439)
        const input = container.querySelector<HTMLInputElement>('.meta-field-mgr__add-row input')!
        input.value = 'Note'
        input.dispatchEvent(new Event('input'))
        await flushUi()
        expect(container.querySelector('[data-test="add-conflict-error"]')).toBeTruthy()
        // add-field row 74 + 18 -> room 672 - 155 = 517 -> max 421.
        expect(ariaTrio(container).max).toBe(421)
      } finally {
        app.unmount()
      }
    })
  })

  describe('short windows: the fixed rows always fit', () => {
    it('rows + list floor + published pane never exceed the 84vh frame, with or without a pending delete', async () => {
      const { container, app } = await mountMeasured(1000)
      try {
        for (const confirming of [false, true]) {
          if (confirming) await openDeleteConfirm(container, 'Note')
          const rows = 57 + 6 + 74 + (confirming ? 84.5 : 0)
          for (let vh = 1200; vh >= 300; vh -= 20) {
            setViewportHeight(vh)
            await flushUi()
            const trio = ariaTrio(container)
            const floor = listFloorPx(container)
            const published = configPaneHeightPx(container)
            const label = `vh=${vh} confirming=${confirming}`
            // Against the CEILING, not just the current height: even ⤢ / End must fit.
            expect(Math.ceil(rows) + floor + trio.max, label).toBeLessThanOrEqual(vh * 0.84)
            expect(floor, label).toBeLessThanOrEqual(96)
            expect(trio.min, label).toBeLessThanOrEqual(trio.now)
            expect(trio.now, label).toBeLessThanOrEqual(trio.max)
            expect(published, label).toBe(trio.now)
          }
        }
      } finally {
        app.unmount()
      }
    })

    it('at 360px the two floors shrink in proportion instead of pushing rows out (the #6072 regression)', async () => {
      const { container, app } = await mountMeasured(360)
      try {
        // room = 302.4 - 137 = 165.4 < 96 + 120 -> list floor floor(165.4 * 96 / 216) = 73, pane 92.
        expect(listFloorPx(container)).toBe(73)
        expect(ariaTrio(container)).toEqual({ now: 92, min: 92, max: 92 })

        await openDeleteConfirm(container, 'Note')
        // room = 302.4 - 222 = 80.4 -> list floor 35, pane 45: the confirmation still fits.
        expect(listFloorPx(container)).toBe(35)
        expect(ariaTrio(container)).toEqual({ now: 45, min: 45, max: 45 })
      } finally {
        app.unmount()
      }
    })

    it('with no config pane open the list alone gives way (floor = what is left, at most 96)', async () => {
      stubLayout()
      setViewportHeight(360)
      const { container, app } = mountFieldManager(TWO_FIELDS)
      try {
        await flushUi()
        expect(listFloorPx(container)).toBe(96) // room 302.4 - 131 = 171.4
        await openDeleteConfirm(container, 'Note')
        // room = 302.4 - ceil(57 + 74 + 84.5) = 86.4 -> 86.
        expect(listFloorPx(container)).toBe(86)
      } finally {
        app.unmount()
      }
    })
  })

  describe('nothing is stored unless the user chose a height', () => {
    for (const vh of [360, 1000]) {
      it(`at ${vh}px ⤢/⤡ without a manual height never writes localStorage, and the default keeps following the window`, async () => {
        const { container, app } = await mountMeasured(vh)
        try {
          const setItemSpy = vi.spyOn(window.localStorage, 'setItem')
          expandToggle(container).click()
          await flushUi()
          expandToggle(container).click()
          await flushUi()
          expect(setItemSpy).not.toHaveBeenCalled()
          expect(window.localStorage.getItem(CONFIG_PANE_STORAGE_KEY)).toBeNull()

          setViewportHeight(900)
          await flushUi()
          // room = 756 - 137 = 619 -> default floor(619 / 2) = 309: still the live default.
          expect(configPaneHeightPx(container)).toBe(309)
          expect(setItemSpy).not.toHaveBeenCalled()
        } finally {
          app.unmount()
        }
      })
    }

    it('also in the unmeasured fallback at 360px (the case #6072 stored "120" in)', async () => {
      const { container, app } = await mountWithConfigOpen(360)
      try {
        const setItemSpy = vi.spyOn(window.localStorage, 'setItem')
        expandToggle(container).click()
        await flushUi()
        expandToggle(container).click()
        await flushUi()
        expect(setItemSpy).not.toHaveBeenCalled()
      } finally {
        app.unmount()
      }
    })

    it('a click on the splitter with no drag (pointerdown + pointerup) chooses nothing and writes nothing', async () => {
      const { container, app } = await mountMeasured(800)
      try {
        const setItemSpy = vi.spyOn(window.localStorage, 'setItem')
        const el = splitter(container)
        el.dispatchEvent(pointer('pointerdown', 500, 23))
        el.dispatchEvent(pointer('pointerup', 500, 23))
        await flushUi()
        expect(setItemSpy).not.toHaveBeenCalled()
        // ...so the default still follows the window afterwards.
        setViewportHeight(900)
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(309)
      } finally {
        app.unmount()
      }
    })

    it('window resizes never write, with or without a manual height', async () => {
      const { container, app } = await mountMeasured(800)
      try {
        const setItemSpy = vi.spyOn(window.localStorage, 'setItem')
        for (const vh of [500, 1200, 360, 900]) {
          setViewportHeight(vh)
          await flushUi()
        }
        expect(setItemSpy).not.toHaveBeenCalled()

        keydown(splitter(container), 'ArrowDown')
        keyup(splitter(container), 'ArrowDown')
        await flushUi()
        expect(setItemSpy).toHaveBeenCalledTimes(1)
        for (const vh of [500, 1200, 360, 900]) {
          setViewportHeight(vh)
          await flushUi()
        }
        expect(setItemSpy).toHaveBeenCalledTimes(1)
      } finally {
        app.unmount()
      }
    })

    it('a stored height is clamped only for display: a short window (and ⤢/⤡ there) never overwrites it, a tall one gives it back', async () => {
      window.localStorage.setItem(CONFIG_PANE_STORAGE_KEY, '500')
      const { container, app } = await mountMeasured(360)
      try {
        expect(configPaneHeightPx(container)).toBe(92)
        const setItemSpy = vi.spyOn(window.localStorage, 'setItem')
        expandToggle(container).click()
        await flushUi()
        expandToggle(container).click()
        await flushUi()
        expect(setItemSpy).not.toHaveBeenCalled()
        expect(window.localStorage.getItem(CONFIG_PANE_STORAGE_KEY)).toBe('500')

        setViewportHeight(1000)
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(500)
      } finally {
        app.unmount()
      }
    })
  })

  describe('drag and key steps start from the DRAWN height', () => {
    it('a short pane (drawn 200 under a 267 ceiling): dragging down 30 lands on 170, not 237', async () => {
      const { container, app } = await mountMeasured(800, { pane: 200 })
      try {
        expect(configPaneHeightPx(container)).toBe(267)
        const el = splitter(container)
        el.dispatchEvent(pointer('pointerdown', 500, 21))
        el.dispatchEvent(pointer('pointermove', 530, 21))
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(170)
        el.dispatchEvent(pointer('pointerup', 530, 21))
      } finally {
        app.unmount()
      }
    })

    it('ArrowDown steps from the drawn height as well', async () => {
      const { container, app } = await mountMeasured(800, { pane: 200 })
      try {
        keydown(splitter(container), 'ArrowDown')
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(200 - CONFIG_PANE_STEP)
      } finally {
        app.unmount()
      }
    })

    it('never starts ABOVE the published ceiling, whatever the drawn box reports', async () => {
      const { container, app } = await mountMeasured(800, { pane: 1000 })
      try {
        const el = splitter(container)
        el.dispatchEvent(pointer('pointerdown', 500, 22))
        el.dispatchEvent(pointer('pointermove', 530, 22))
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(267 - 30)
        el.dispatchEvent(pointer('pointerup', 530, 22))
      } finally {
        app.unmount()
      }
    })
  })

  describe('ResizeObserver wiring', () => {
    it('re-arms when a row mounts, re-measures from its callback, and disconnects everything on unmount', async () => {
      const observers: Array<{ callback: () => void; targets: Element[]; disconnected: boolean }> = []
      class FakeResizeObserver {
        record: { callback: () => void; targets: Element[]; disconnected: boolean }
        constructor(callback: () => void) {
          this.record = { callback, targets: [], disconnected: false }
          observers.push(this.record)
        }
        observe(target: Element) { this.record.targets.push(target) }
        unobserve() {}
        disconnect() { this.record.disconnected = true }
      }
      vi.stubGlobal('ResizeObserver', FakeResizeObserver)
      const rows = stubLayout()
      setViewportHeight(800)
      const { container, app } = mountFieldManager(TWO_FIELDS)
      await openFieldConfig(container, 'Qty')
      const live = () => observers.filter((o) => !o.disconnected)

      expect(live()).toHaveLength(1)
      expect(live()[0].targets.map((t) => t.className)).toEqual(expect.arrayContaining([
        expect.stringContaining('meta-field-mgr__header'),
        expect.stringContaining('meta-field-mgr__splitter'),
        expect.stringContaining('meta-field-mgr__add-section'),
      ]))

      await openDeleteConfirm(container, 'Note')
      expect(live()).toHaveLength(1)
      expect(live()[0].targets.some((t) => t.classList.contains('meta-field-mgr__confirm'))).toBe(true)
      expect(ariaTrio(container).max).toBe(354)

      // A row growing on its own (no mount/unmount) is caught by the observer callback alone.
      rows.add = 100
      live()[0].callback()
      await flushUi()
      // rows = ceil(57 + 6 + 100 + 84.5) = 248 -> room 424 -> max 328.
      expect(ariaTrio(container).max).toBe(328)

      app.unmount()
      expect(live()).toHaveLength(0)
    })
  })
})

// ==============================================================================================
// #7a adversarial review (B1 / S1 / S2 / N1): which stored heights are trusted, and when a gesture
// counts as a choice. Same stubbed Chromium rows as above -- at 800px: room 535, ceiling 439,
// default 267, collapse fallback min(267, 439 - 16) = 267.
// ==============================================================================================
describe('MetaFieldManager — #7a review: stored heights, gestures that draw nothing, the collapse fallback', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    setViewportHeight(768)
  })

  describe('B1: what the deployed r8-B build stored is ignored and removed, never trusted', () => {
    // r59 (05461c739) at an 800px window: the first ⤢ click stored the mount-time default
    // round(0.52 * 800) = 416, and a drag up started from the published ceiling and stored
    // round(0.84 * 800 - 160) = 512. Trusting either leaves ⤢ 0-23px of travel here.
    const POLLUTED = [
      ['the first ⤢ click, round(0.52 * 800)', '416'],
      ['a drag up from the ceiling, round(0.84 * 800 - 160)', '512'],
    ] as const
    for (const [origin, polluted] of POLLUTED) {
      it(`a legacy '${polluted}' (${origin}) is removed on mount, the pane opens at the default, and ⤢ travels >100px`, async () => {
        window.localStorage.setItem(LEGACY_CONFIG_PANE_STORAGE_KEY, polluted)
        const { container, app } = await mountMeasured(800)
        try {
          expect(window.localStorage.getItem(LEGACY_CONFIG_PANE_STORAGE_KEY)).toBeNull()
          expect(window.localStorage.getItem(CONFIG_PANE_STORAGE_KEY)).toBeNull()
          expect(configPaneHeightPx(container)).toBe(267)
          const setItemSpy = vi.spyOn(window.localStorage, 'setItem')
          expandToggle(container).click()
          await flushUi()
          expect(configPaneHeightPx(container)).toBe(439)
          expect(configPaneHeightPx(container) - 267).toBeGreaterThan(100)
          expandToggle(container).click()
          await flushUi()
          expect(configPaneHeightPx(container)).toBe(267)
          expect(setItemSpy).not.toHaveBeenCalled()
        } finally {
          app.unmount()
        }
      })
    }

    it('a height stored under the versioned key is still honoured, and the legacy key next to it is removed', async () => {
      window.localStorage.setItem(LEGACY_CONFIG_PANE_STORAGE_KEY, '416')
      window.localStorage.setItem(CONFIG_PANE_STORAGE_KEY, '300')
      const { container, app } = await mountMeasured(800)
      try {
        expect(configPaneHeightPx(container)).toBe(300)
        expect(window.localStorage.getItem(LEGACY_CONFIG_PANE_STORAGE_KEY)).toBeNull()
        expect(window.localStorage.getItem(CONFIG_PANE_STORAGE_KEY)).toBe('300')
      } finally {
        app.unmount()
      }
    })
  })

  describe('S1: a gesture that draws nothing new chooses nothing', () => {
    it('a short pane (content 140 under a stored 439): ArrowUp, End and a 100px drag up leave the preference alone', async () => {
      window.localStorage.setItem(CONFIG_PANE_STORAGE_KEY, '439')
      const { container, app } = await mountMeasured(800, { pane: 140 })
      try {
        expect(configPaneHeightPx(container)).toBe(439)
        const setItemSpy = vi.spyOn(window.localStorage, 'setItem')
        const el = splitter(container)
        for (const key of ['ArrowUp', 'End']) {
          keydown(el, key)
          keyup(el, key)
          await flushUi()
          expect(configPaneHeightPx(container), key).toBe(439)
        }
        el.dispatchEvent(pointer('pointerdown', 500, 31))
        el.dispatchEvent(pointer('pointermove', 400, 31))
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(439)
        el.dispatchEvent(pointer('pointerup', 400, 31))
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(439)
        expect(setItemSpy).not.toHaveBeenCalled()
        expect(window.localStorage.getItem(CONFIG_PANE_STORAGE_KEY)).toBe('439')
      } finally {
        app.unmount()
      }
    })

    it('a pane drawn below the 120px floor: ArrowDown and Home leave the preference alone', async () => {
      window.localStorage.setItem(CONFIG_PANE_STORAGE_KEY, '439')
      const { container, app } = await mountMeasured(800, { pane: 110 })
      try {
        const setItemSpy = vi.spyOn(window.localStorage, 'setItem')
        for (const key of ['ArrowDown', 'Home']) {
          keydown(splitter(container), key)
          keyup(splitter(container), key)
          await flushUi()
          expect(configPaneHeightPx(container), key).toBe(439)
        }
        expect(setItemSpy).not.toHaveBeenCalled()
      } finally {
        app.unmount()
      }
    })

    it('a VISIBLE shrink of a short pane is still a choice and is stored', async () => {
      window.localStorage.setItem(CONFIG_PANE_STORAGE_KEY, '439')
      const { container, app } = await mountMeasured(800, { pane: 200 })
      try {
        keydown(splitter(container), 'ArrowDown')
        keyup(splitter(container), 'ArrowDown')
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(200 - CONFIG_PANE_STEP)
        expect(window.localStorage.getItem(CONFIG_PANE_STORAGE_KEY)).toBe(String(200 - CONFIG_PANE_STEP))
      } finally {
        app.unmount()
      }
    })

    it('at 360px, where the floor meets the ceiling, no resize key chooses or writes anything', async () => {
      const { container, app } = await mountMeasured(360)
      try {
        expect(ariaTrio(container)).toEqual({ now: 92, min: 92, max: 92 })
        const setItemSpy = vi.spyOn(window.localStorage, 'setItem')
        for (const key of ['ArrowUp', 'ArrowDown', 'Home', 'End']) {
          keydown(splitter(container), key)
          keyup(splitter(container), key)
        }
        await flushUi()
        expect(setItemSpy).not.toHaveBeenCalled()
        // ...so the untouched default still follows the window.
        setViewportHeight(900)
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(309)
      } finally {
        app.unmount()
      }
    })
  })

  describe('N1: a click or a wobble on the splitter is not a drag', () => {
    it('pointer moves under 3px choose nothing and write nothing', async () => {
      const { container, app } = await mountMeasured(800)
      try {
        const setItemSpy = vi.spyOn(window.localStorage, 'setItem')
        const el = splitter(container)
        el.dispatchEvent(pointer('pointerdown', 500, 41))
        for (const y of [501, 498, 502]) el.dispatchEvent(pointer('pointermove', y, 41))
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(267)
        el.dispatchEvent(pointer('pointerup', 502, 41))
        await flushUi()
        expect(setItemSpy).not.toHaveBeenCalled()
        setViewportHeight(900)
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(309)
      } finally {
        app.unmount()
      }
    })

    it('a drag that returns to within 3px of where it started restores the untouched state', async () => {
      const { container, app } = await mountMeasured(800)
      try {
        const setItemSpy = vi.spyOn(window.localStorage, 'setItem')
        const el = splitter(container)
        el.dispatchEvent(pointer('pointerdown', 500, 42))
        el.dispatchEvent(pointer('pointermove', 530, 42))
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(237)
        el.dispatchEvent(pointer('pointermove', 501, 42))
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(267)
        el.dispatchEvent(pointer('pointerup', 501, 42))
        await flushUi()
        expect(setItemSpy).not.toHaveBeenCalled()
        setViewportHeight(900)
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(309)
      } finally {
        app.unmount()
      }
    })
  })

  describe('S2: a height chosen on a taller window is never overwritten by this window\'s clamp', () => {
    it('607 stored (chosen at 1080), window 800: ⤢/⤡ collapses visibly but keeps 607, and a taller window gives it back', async () => {
      window.localStorage.setItem(CONFIG_PANE_STORAGE_KEY, '607')
      const { container, app } = await mountMeasured(800)
      try {
        expect(configPaneHeightPx(container)).toBe(439)
        const setItemSpy = vi.spyOn(window.localStorage, 'setItem')
        expandToggle(container).click()
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(439)
        expandToggle(container).click()
        await flushUi()
        // Collapsing out of the ceiling still has to move (r8-B), so the fallback is SHOWN...
        expect(configPaneHeightPx(container)).toBe(267)
        // ...but it is not the user's height: nothing is written, 607 stays.
        expect(setItemSpy).not.toHaveBeenCalled()
        expect(window.localStorage.getItem(CONFIG_PANE_STORAGE_KEY)).toBe('607')

        // 1080px: room 907.2 - 137 = 770.2 -> ceiling 674, so 607 fits and comes back in full.
        setViewportHeight(1080)
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(607)
        expect(setItemSpy).not.toHaveBeenCalled()
      } finally {
        app.unmount()
      }
    })

    it('after that collapse, End returns to the ceiling without replacing 607; a visible step below it does replace it', async () => {
      window.localStorage.setItem(CONFIG_PANE_STORAGE_KEY, '607')
      const { container, app } = await mountMeasured(800)
      try {
        expandToggle(container).click()
        await flushUi()
        expandToggle(container).click()
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(267)

        const setItemSpy = vi.spyOn(window.localStorage, 'setItem')
        keydown(splitter(container), 'End')
        keyup(splitter(container), 'End')
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(439)
        expect(setItemSpy).not.toHaveBeenCalled()
        setViewportHeight(1080)
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(607)

        setViewportHeight(800)
        await flushUi()
        keydown(splitter(container), 'ArrowDown')
        keyup(splitter(container), 'ArrowDown')
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(439 - CONFIG_PANE_STEP)
        expect(window.localStorage.getItem(CONFIG_PANE_STORAGE_KEY)).toBe(String(439 - CONFIG_PANE_STEP))
      } finally {
        app.unmount()
      }
    })
  })
})

// ==============================================================================================
// #7a round 3 (second adversarial review): what a grow step may store (SF1), the untouched split on
// sheets with few fields (SF2), ⤡ at the ceiling (nit 3), the collapse fallback's lifetime (nit 4),
// a pane shorter than its own padding (nit 5), and a drag the dialog closes on (nit 6). Same stubbed
// Chromium rows as above; the list's rows are 34px each in Chromium, plus 16px of list padding.
// ==============================================================================================
const LIST_ROW = 34
const LIST_PADDING = 16
function listNeeds(fieldCount: number): number {
  return fieldCount * LIST_ROW + LIST_PADDING
}

/** Like `mountFieldManager`, with `visible` as a ref the test can flip -- the way
 *  MultitableWorkbench.vue mounts the component (always mounted, `:visible` toggled). */
function mountToggleableFieldManager(fields: Record<string, unknown>[]) {
  const visible = ref(true)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({
    render() {
      return h(MetaFieldManager, {
        visible: visible.value,
        sheetId: 'sheet_1',
        sheets: [],
        // Plain literals, as elsewhere in this file; the component only reads id/name/type/property.
        fields: fields as unknown as MetaField[],
        onClose: () => { visible.value = false },
      })
    },
  })
  app.mount(container)
  return { container, app, visible }
}

async function dragSplitterBy(container: HTMLElement, deltaY: number, pointerId: number) {
  const el = splitter(container)
  el.dispatchEvent(pointer('pointerdown', 500, pointerId))
  el.dispatchEvent(pointer('pointermove', 500 + deltaY, pointerId))
  await flushUi()
  el.dispatchEvent(pointer('pointerup', 500 + deltaY, pointerId))
  await flushUi()
}

describe('MetaFieldManager — #7a round 3: grow steps stop at the content, the default split, ⤡, closing', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    setViewportHeight(768)
  })

  describe('SF1: a step that grows the pane stops at its content height, so every stored height was drawn', () => {
    it('a mid config (content 345 under the 267 default): End draws and stores 345, never the 439 it cannot draw; a tall config then reopens at 345 and ⤢ travels 94px', async () => {
      const { container, app } = await mountMeasured(800, { paneContent: 345 })
      try {
        expect(ariaTrio(container)).toEqual({ now: 267, min: 120, max: 439 })
        keydown(splitter(container), 'End')
        keyup(splitter(container), 'End')
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(345)
        expect(window.localStorage.getItem(CONFIG_PANE_STORAGE_KEY)).toBe('345')
        // Already showing all of it: a second End draws nothing and chooses nothing.
        const setItemSpy = vi.spyOn(window.localStorage, 'setItem')
        keydown(splitter(container), 'End')
        keyup(splitter(container), 'End')
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(345)
        expect(setItemSpy).not.toHaveBeenCalled()
      } finally {
        app.unmount()
      }

      // The same preference opens the next config -- a tall one this time.
      const tall = await mountMeasured(800, { paneContent: 2000 })
      try {
        expect(configPaneHeightPx(tall.container)).toBe(345)
        expandToggle(tall.container).click()
        await flushUi()
        expect(configPaneHeightPx(tall.container) - 345).toBe(94)
      } finally {
        tall.app.unmount()
      }
    })

    it('a 150px drag up and a held ArrowUp stop at the same 345 (pointer and keyboard agree)', async () => {
      const dragged = await mountMeasured(800, { paneContent: 345 })
      try {
        const el = splitter(dragged.container)
        el.dispatchEvent(pointer('pointerdown', 500, 51))
        el.dispatchEvent(pointer('pointermove', 350, 51))
        await flushUi()
        expect(configPaneHeightPx(dragged.container)).toBe(345)
        el.dispatchEvent(pointer('pointerup', 350, 51))
        await flushUi()
        expect(window.localStorage.getItem(CONFIG_PANE_STORAGE_KEY)).toBe('345')
      } finally {
        dragged.app.unmount()
      }
      window.localStorage.removeItem(CONFIG_PANE_STORAGE_KEY)

      const held = await mountMeasured(800, { paneContent: 345 })
      try {
        // A held key: keydown repeats, one keyup at the end.
        for (let i = 0; i < 20; i += 1) {
          keydown(splitter(held.container), 'ArrowUp')
          await flushUi()
        }
        keyup(splitter(held.container), 'ArrowUp')
        await flushUi()
        expect(configPaneHeightPx(held.container)).toBe(345)
        expect(window.localStorage.getItem(CONFIG_PANE_STORAGE_KEY)).toBe('345')
      } finally {
        held.app.unmount()
      }
    })

    it('content 266.5 under the 267 pane: End, ArrowUp and a drag up would draw half a pixel, so they store nothing', async () => {
      const { container, app } = await mountMeasured(800, { paneContent: 266.5 })
      try {
        const setItemSpy = vi.spyOn(window.localStorage, 'setItem')
        for (const key of ['End', 'ArrowUp']) {
          keydown(splitter(container), key)
          keyup(splitter(container), key)
          await flushUi()
          expect(configPaneHeightPx(container), key).toBe(267)
        }
        await dragSplitterBy(container, -100, 52)
        expect(configPaneHeightPx(container)).toBe(267)
        expect(setItemSpy).not.toHaveBeenCalled()
        // ...so the untouched default still follows the window.
        setViewportHeight(900)
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(309)
      } finally {
        app.unmount()
      }
    })

    it('a short pane drawn at 140.4 (stored 439): ArrowUp could only add 0.6px, so it chooses nothing', async () => {
      window.localStorage.setItem(CONFIG_PANE_STORAGE_KEY, '439')
      const { container, app } = await mountMeasured(800, { paneContent: 140.4 })
      try {
        const setItemSpy = vi.spyOn(window.localStorage, 'setItem')
        keydown(splitter(container), 'ArrowUp')
        keyup(splitter(container), 'ArrowUp')
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(439)
        expect(setItemSpy).not.toHaveBeenCalled()
      } finally {
        app.unmount()
      }
    })
  })

  describe('SF2: the untouched split gives the list what its rows need, and never less than half to the pane', () => {
    it('the list\'s rows are observed: when they change, the untouched default follows without a resize', async () => {
      const observers: Array<{ callback: () => void; targets: Element[]; disconnected: boolean }> = []
      class FakeResizeObserver {
        record: { callback: () => void; targets: Element[]; disconnected: boolean }
        constructor(callback: () => void) {
          this.record = { callback, targets: [], disconnected: false }
          observers.push(this.record)
        }
        observe(target: Element) { this.record.targets.push(target) }
        unobserve() {}
        disconnect() { this.record.disconnected = true }
      }
      vi.stubGlobal('ResizeObserver', FakeResizeObserver)
      const rows = stubLayout({ list: listNeeds(48) })
      setViewportHeight(800)
      const { container, app } = mountFieldManager(TWO_FIELDS)
      try {
        await openFieldConfig(container, 'Qty')
        const live = observers.filter((o) => !o.disconnected)
        expect(live).toHaveLength(1)
        expect(live[0].targets.some((t) => t.classList.contains('meta-field-mgr__list'))).toBe(true)
        expect(ariaTrio(container).now).toBe(267)
        rows.list = listNeeds(3)
        live[0].callback()
        await flushUi()
        expect(ariaTrio(container).now).toBe(417)
      } finally {
        app.unmount()
      }
    })

    // room = 0.84vh - (57 + 6 + 74); ceiling = floor(room - 96); r8-B drew round(0.52vh) = 416 / 562 / 749.
    const CASES = [
      { vh: 800, max: 439, few: 417, many: 267, r8b: 416 },
      { vh: 1080, max: 674, few: 652, many: 385, r8b: 562 },
      { vh: 1440, max: 976, few: 954, many: 536, r8b: 749 },
    ] as const
    for (const { vh, max, few, many, r8b } of CASES) {
      it(`at ${vh}px: 3 fields -> the pane gets ${few} (list keeps its ${listNeeds(3)}px, r8-B drew ${r8b}); 48 fields -> half, ${many}`, async () => {
        const fewFields = await mountMeasured(vh, { list: listNeeds(3) })
        try {
          expect(ariaTrio(fewFields.container)).toEqual({ now: few, min: 120, max })
          expect(few).toBeGreaterThanOrEqual(r8b)
          // The list is left exactly what its rows need (rounding may leave it up to 1px more).
          const room = vh * 0.84 - (57 + 6 + 74)
          expect(room - few).toBeGreaterThanOrEqual(listNeeds(3))
          expect(room - few).toBeLessThan(listNeeds(3) + 1)
        } finally {
          fewFields.app.unmount()
        }
        const manyFields = await mountMeasured(vh, { list: listNeeds(48) })
        try {
          expect(ariaTrio(manyFields.container)).toEqual({ now: many, min: 120, max })
        } finally {
          manyFields.app.unmount()
        }
      })
    }

    it('a list that needs less than its 96px floor leaves the pane the whole ceiling; nothing is stored', async () => {
      const setItemSpy = vi.spyOn(window.localStorage, 'setItem')
      const { container, app } = await mountMeasured(800, { list: listNeeds(1) })
      try {
        expect(ariaTrio(container)).toEqual({ now: 439, min: 120, max: 439 })
        expect(setItemSpy).not.toHaveBeenCalled()
      } finally {
        app.unmount()
      }
    })
  })

  describe('nit 3: ⤡ at the ceiling forgets the manual height instead of storing a window-derived one', () => {
    it('End (439) then ⤢/⤡ at 800: the key is removed and the live default applies, also after a resize', async () => {
      const { container, app } = await mountMeasured(800)
      try {
        keydown(splitter(container), 'End')
        keyup(splitter(container), 'End')
        await flushUi()
        expect(window.localStorage.getItem(CONFIG_PANE_STORAGE_KEY)).toBe('439')
        const setItemSpy = vi.spyOn(window.localStorage, 'setItem')
        expandToggle(container).click()
        await flushUi()
        expandToggle(container).click()
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(267)
        expect(window.localStorage.getItem(CONFIG_PANE_STORAGE_KEY)).toBeNull()
        setViewportHeight(1080)
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(385)
        expect(setItemSpy).not.toHaveBeenCalled()
      } finally {
        app.unmount()
      }
    })

    it('with a delete pending: End reaches the lowered 354, ⤢/⤡ forgets it, and cancelling the delete shows the full-room default', async () => {
      const { container, app } = await mountMeasured(800)
      try {
        await openDeleteConfirm(container, 'Note')
        keydown(splitter(container), 'End')
        keyup(splitter(container), 'End')
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(354)
        const setItemSpy = vi.spyOn(window.localStorage, 'setItem')
        expandToggle(container).click()
        await flushUi()
        expandToggle(container).click()
        await flushUi()
        expect(setItemSpy).not.toHaveBeenCalled()
        expect(window.localStorage.getItem(CONFIG_PANE_STORAGE_KEY)).toBeNull()
        // r8-B's fallback here was min(floor(450 / 2), 354 - 16) = 225 -- a number that exists only
        // while the confirmation row takes its 84.5px -- stored for good.
        container.querySelector<HTMLButtonElement>('.meta-field-mgr__confirm .meta-field-mgr__btn-cancel')!.click()
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(267)
      } finally {
        app.unmount()
      }
    })
  })

  describe('nit 4: the collapse fallback lasts one dialog, and only while the manual height stays clamped', () => {
    it('607 stored, ⤢/⤡ at 800 shows 267; after the dialog closes and reopens it shows the clamped 439 again', async () => {
      window.localStorage.setItem(CONFIG_PANE_STORAGE_KEY, '607')
      stubLayout()
      setViewportHeight(800)
      const { container, app, visible } = mountToggleableFieldManager(TWO_FIELDS)
      try {
        await openFieldConfig(container, 'Qty')
        expandToggle(container).click()
        await flushUi()
        expandToggle(container).click()
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(267)

        visible.value = false
        await flushUi()
        visible.value = true
        await flushUi()
        await openFieldConfig(container, 'Qty')
        expect(configPaneHeightPx(container)).toBe(439)
        expect(window.localStorage.getItem(CONFIG_PANE_STORAGE_KEY)).toBe('607')
      } finally {
        app.unmount()
      }
    })

    it('607 stored, ⤢/⤡ at 800 (267), a 1080 window (607), back to 800: the clamped 439, not the fallback', async () => {
      window.localStorage.setItem(CONFIG_PANE_STORAGE_KEY, '607')
      const { container, app } = await mountMeasured(800)
      try {
        expandToggle(container).click()
        await flushUi()
        expandToggle(container).click()
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(267)
        setViewportHeight(1080)
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(607)
        setViewportHeight(800)
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(439)
      } finally {
        app.unmount()
      }
    })
  })

  describe('nit 5: a ceiling below the pane\'s own padding + border', () => {
    it('360px with the system-type hint (add-field row 109.5) and a pending delete: ceiling 25 < 29, so the pane drops its padding', async () => {
      const { container, app } = await mountMeasured(360, { add: 109.5 })
      try {
        const pane = () => container.querySelector('.meta-field-mgr__config--scrollable')!
        // room = 302.4 - 173 = 129.4 -> list floor 57, pane 72: the padding fits.
        expect(ariaTrio(container).max).toBe(72)
        expect(pane().classList.contains('meta-field-mgr__config--squeezed')).toBe(false)

        await openDeleteConfirm(container, 'Note')
        // rows = ceil(57 + 6 + 109.5 + 84.5) = 257 -> room 45.4 -> list floor 20, pane 25.
        expect(listFloorPx(container)).toBe(20)
        expect(ariaTrio(container)).toEqual({ now: 25, min: 25, max: 25 })
        expect(pane().classList.contains('meta-field-mgr__config--squeezed')).toBe(true)

        container.querySelector<HTMLButtonElement>('.meta-field-mgr__confirm .meta-field-mgr__btn-cancel')!.click()
        await flushUi()
        expect(pane().classList.contains('meta-field-mgr__config--squeezed')).toBe(false)
      } finally {
        app.unmount()
      }
    })
  })

  describe('nit 6: closing the dialog mid-drag', () => {
    it('detaches the drag listeners, writes nothing, and the pane reopens as the drag found it', async () => {
      stubLayout()
      setViewportHeight(800)
      const { container, app, visible } = mountToggleableFieldManager(TWO_FIELDS)
      try {
        await openFieldConfig(container, 'Qty')
        const el = splitter(container)
        const release = vi.fn()
        ;(el as unknown as { releasePointerCapture: (id: number) => void }).releasePointerCapture = release
        const removeSpy = vi.spyOn(el, 'removeEventListener')
        const setItemSpy = vi.spyOn(window.localStorage, 'setItem')
        el.dispatchEvent(pointer('pointerdown', 500, 61))
        el.dispatchEvent(pointer('pointermove', 470, 61))
        await flushUi()
        expect(configPaneHeightPx(container)).toBe(297)

        visible.value = false
        await flushUi()
        expect(removeSpy.mock.calls.map(([type]) => type)).toEqual(expect.arrayContaining(['pointermove', 'pointerup', 'pointercancel']))
        expect(release).toHaveBeenCalledWith(61)
        // Whatever still reaches the old handle is inert.
        el.dispatchEvent(pointer('pointermove', 400, 61))
        el.dispatchEvent(pointer('pointerup', 400, 61))
        await flushUi()
        expect(setItemSpy).not.toHaveBeenCalled()

        visible.value = true
        await flushUi()
        await openFieldConfig(container, 'Qty')
        expect(configPaneHeightPx(container)).toBe(267)
        expect(window.localStorage.getItem(CONFIG_PANE_STORAGE_KEY)).toBeNull()
      } finally {
        app.unmount()
      }
    })

    it('a drag released BEFORE the close is kept (the close discards only a drag still in progress)', async () => {
      stubLayout()
      setViewportHeight(800)
      const { container, app, visible } = mountToggleableFieldManager(TWO_FIELDS)
      try {
        await openFieldConfig(container, 'Qty')
        await dragSplitterBy(container, -30, 62)
        expect(window.localStorage.getItem(CONFIG_PANE_STORAGE_KEY)).toBe('297')
        visible.value = false
        await flushUi()
        visible.value = true
        await flushUi()
        await openFieldConfig(container, 'Qty')
        expect(configPaneHeightPx(container)).toBe(297)
      } finally {
        app.unmount()
      }
    })
  })
})

// --- #7a, source-level half ---------------------------------------------------------------------
describe('MetaFieldManager <style> — #7a the pane does not shrink, and the script mirrors the CSS it bounds', () => {
  it('the config pane is out of the flex shrink distribution and border-box', () => {
    const body = ruleBody(SCROLLABLE_RULE)
    expect(body).toMatch(/flex:\s*0 0 auto/)
    expect(body).toMatch(/box-sizing:\s*border-box/)
  })

  it('the field list is border-box too, so its published floor includes its own padding (review N2)', () => {
    // The component is exported (apps/web/src/multitable/index.ts); mounted without App.vue's global
    // reset, a content-box list would take floor + 16px and push the add-field row out by as much.
    expect(SFC_SOURCE.match(BODY_RULE)?.[1] ?? '').toMatch(/box-sizing:\s*border-box/)
  })

  it('the script constants mirror the CSS they bound (frame 84vh, list floor 96px)', () => {
    const root = SFC_SOURCE.match(ROOT_RULE)?.[1] ?? ''
    expect(root).toMatch(/max-height:\s*84vh/)
    expect(SFC_SOURCE).toMatch(/const FRAME_MAX_HEIGHT_VH_RATIO = 0\.84\b/)
    expect(SFC_SOURCE).toMatch(/const FIELD_LIST_MIN_HEIGHT = 96\b/)
    expect(SFC_SOURCE.match(BODY_RULE)?.[1] ?? '').toMatch(/min-height:\s*var\(--meta-field-mgr-list-min-height,\s*96px\)/)
  })

  // #7a round 3 (nit 5).
  it('the pane\'s padding + border constant mirrors its CSS, and the squeezed rule drops exactly that padding', () => {
    const config = SFC_SOURCE.match(/\.meta-field-mgr__config\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(config).toMatch(/padding:\s*14px 16px/)
    expect(config).toMatch(/border-top:\s*1px solid/)
    expect(SFC_SOURCE).toMatch(/const CONFIG_PANE_CHROME_HEIGHT = 29\b/)
    const squeezed = SFC_SOURCE.match(/\.meta-field-mgr__config--squeezed\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(squeezed).toMatch(/padding-top:\s*0/)
    expect(squeezed).toMatch(/padding-bottom:\s*0/)
  })

  it('the dialog frame scrolls whatever its fixed rows cannot fit, instead of spilling it', () => {
    expect(SFC_SOURCE.match(ROOT_RULE)?.[1] ?? '').toMatch(/overflow-y:\s*auto/)
  })
})
