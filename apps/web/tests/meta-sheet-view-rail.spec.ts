/**
 * UI-P2-2a — MetaSheetViewRail extraction (design-lock
 * docs/development/multitable-ui-p2-2-left-rail-detail-designlock-20260707.md §5 P2-2a).
 *
 * P2-2a's charter is a PURE extraction: the sheet/view tab logic that used to live in
 * MetaViewTabBar.vue (sole consumer: MultitableWorkbench.vue:25 pre-PR) moves verbatim into
 * MetaSheetViewRail.vue, which the workbench now mounts instead — no visual change, no logic
 * edits. This spec is the behavior-equivalence proof the lock's §5 gate demands:
 *
 *   1. The 4 emits (select-sheet / select-view / create-sheet / toggle-personal), asserted
 *      one-by-one so a single broken emit-forward reds exactly one test (mutation-provable).
 *   2. Gating equivalence (can-create-sheet gates the "+" button; personal-views-enabled +
 *      active-view-only gates the personal toggle — G-FE-4 from the personal-views slice-3 lock).
 *   3. Count conservation (N sheets -> N sheet tabs, M views -> M view tabs, regardless of
 *      gating state).
 *   4. A DOM-snapshot equivalence lock against MetaViewTabBar.vue, which UI-P2-2a intentionally
 *      RETAINS (unused by production code, see its own header comment) as a frozen pre-extraction
 *      baseline — mounting both with identical props must produce byte-identical outerHTML.
 *
 * Selectors are structural (class + fixture-array position) or the pre-existing
 * `data-testid="personal-view-toggle"` hook — never i18n textContent, and every lookup is
 * asserted non-null before use (no `?.click()` silent no-ops masking a broken selector as a
 * vacuous pass).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, type App, type Component } from 'vue'
import MetaSheetViewRail from '../src/multitable/components/MetaSheetViewRail.vue'
import MetaViewTabBar from '../src/multitable/components/MetaViewTabBar.vue'
import type { MetaSheet, MetaView } from '../src/multitable/types'

const SHEETS: MetaSheet[] = [
  { id: 's1', name: 'Sales' },
  { id: 's2', name: 'Inventory' },
]

const VIEWS: MetaView[] = [
  { id: 'v1', sheetId: 's1', name: 'Grid view', type: 'grid' },
  { id: 'v2', sheetId: 's1', name: 'Kanban view', type: 'kanban' },
  { id: 'v3', sheetId: 's1', name: 'Odd type', type: 'no-such-type' },
]

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    sheets: SHEETS,
    views: VIEWS,
    activeSheetId: 's1',
    activeViewId: 'v1',
    canCreateSheet: true,
    personalViewsEnabled: true,
    isPersonalMode: (id: string) => id === 'v1',
    ...overrides,
  }
}

type Mounted = { app: App<Element>; container: HTMLDivElement }
const mounted: Mounted[] = []

function mountComponent(component: Component, props: Record<string, unknown>): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ setup: () => () => h(component, props) })
  app.mount(container)
  mounted.push({ app, container })
  return container
}

afterEach(() => {
  while (mounted.length) {
    const m = mounted.pop()!
    m.app.unmount()
    m.container.remove()
  }
})

// Structural, non-fuzzy element lookups shared by every describe block below.
function sheetTabs(root: HTMLElement): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll('.meta-tab-bar__sheets > .meta-tab-bar__tab:not(.meta-tab-bar__tab--add)'))
}
function addSheetButton(root: HTMLElement): HTMLButtonElement | null {
  return root.querySelector('.meta-tab-bar__tab--add')
}
function viewTabs(root: HTMLElement): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll('.meta-tab-bar__view-group > .meta-tab-bar__view'))
}
function personalToggles(root: HTMLElement): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll('[data-testid="personal-view-toggle"]'))
}

// Vue's <style scoped> compiler stamps a per-FILE hash (data-v-xxxxxxxx) onto every element for CSS
// scoping. Two byte-identical SFCs living at different paths (MetaViewTabBar.vue vs
// MetaSheetViewRail.vue) necessarily get DIFFERENT hashes — that is an inert compiler artifact (zero
// visual/behavioral effect, never selected on, never asserted elsewhere in this repo's tests) and
// must be normalized out before a structural-equivalence diff, or every case would spuriously fail on
// nothing but the two files' distinct identities.
function normalizeScopeHash(html: string): string {
  return html.replace(/ data-v-[0-9a-f]+=""/g, '')
}

describe('MetaSheetViewRail — 4-emit equivalence (one by one)', () => {
  it('emits select-sheet with the clicked sheet id, and ONLY select-sheet', () => {
    const onSelectSheet = vi.fn()
    const onSelectView = vi.fn()
    const onCreateSheet = vi.fn()
    const onTogglePersonal = vi.fn()
    const root = mountComponent(MetaSheetViewRail, baseProps({ onSelectSheet, onSelectView, onCreateSheet, onTogglePersonal }))
    const tabs = sheetTabs(root)
    expect(tabs.length).toBe(2)
    tabs[1].click() // SHEETS[1] === { id: 's2', ... }
    expect(onSelectSheet).toHaveBeenCalledTimes(1)
    expect(onSelectSheet).toHaveBeenCalledWith('s2')
    expect(onSelectView).not.toHaveBeenCalled()
    expect(onCreateSheet).not.toHaveBeenCalled()
    expect(onTogglePersonal).not.toHaveBeenCalled()
  })

  it('emits select-view with the clicked view id, and ONLY select-view', () => {
    const onSelectSheet = vi.fn()
    const onSelectView = vi.fn()
    const onCreateSheet = vi.fn()
    const onTogglePersonal = vi.fn()
    const root = mountComponent(MetaSheetViewRail, baseProps({ onSelectSheet, onSelectView, onCreateSheet, onTogglePersonal }))
    const tabs = viewTabs(root)
    expect(tabs.length).toBe(3)
    tabs[1].click() // VIEWS[1] === { id: 'v2', ... }
    expect(onSelectView).toHaveBeenCalledTimes(1)
    expect(onSelectView).toHaveBeenCalledWith('v2')
    expect(onSelectSheet).not.toHaveBeenCalled()
    expect(onCreateSheet).not.toHaveBeenCalled()
    expect(onTogglePersonal).not.toHaveBeenCalled()
  })

  it('emits create-sheet with the computed "Sheet N+1" name, and ONLY create-sheet', () => {
    const onSelectSheet = vi.fn()
    const onSelectView = vi.fn()
    const onCreateSheet = vi.fn()
    const onTogglePersonal = vi.fn()
    const root = mountComponent(MetaSheetViewRail, baseProps({ onSelectSheet, onSelectView, onCreateSheet, onTogglePersonal }))
    const addBtn = addSheetButton(root)
    expect(addBtn).toBeTruthy()
    addBtn!.click()
    expect(onCreateSheet).toHaveBeenCalledTimes(1)
    expect(onCreateSheet).toHaveBeenCalledWith('Sheet 3') // SHEETS.length (2) + 1
    expect(onSelectSheet).not.toHaveBeenCalled()
    expect(onSelectView).not.toHaveBeenCalled()
    expect(onTogglePersonal).not.toHaveBeenCalled()
  })

  it('emits toggle-personal with the active view id, and ONLY toggle-personal', () => {
    const onSelectSheet = vi.fn()
    const onSelectView = vi.fn()
    const onCreateSheet = vi.fn()
    const onTogglePersonal = vi.fn()
    const root = mountComponent(MetaSheetViewRail, baseProps({ onSelectSheet, onSelectView, onCreateSheet, onTogglePersonal }))
    const toggles = personalToggles(root)
    expect(toggles.length).toBe(1)
    toggles[0].click()
    expect(onTogglePersonal).toHaveBeenCalledTimes(1)
    expect(onTogglePersonal).toHaveBeenCalledWith('v1') // activeViewId
    expect(onSelectSheet).not.toHaveBeenCalled()
    expect(onSelectView).not.toHaveBeenCalled()
    expect(onCreateSheet).not.toHaveBeenCalled()
  })
})

describe('MetaSheetViewRail — gating equivalence', () => {
  it('can-create-sheet=false hides the "+" button entirely (no click target, no possible emit)', () => {
    const root = mountComponent(MetaSheetViewRail, baseProps({ canCreateSheet: false }))
    expect(addSheetButton(root)).toBeNull()
  })

  it('can-create-sheet=true renders exactly one "+" button', () => {
    const root = mountComponent(MetaSheetViewRail, baseProps({ canCreateSheet: true }))
    const btn = addSheetButton(root)
    expect(btn).toBeTruthy()
    expect(root.querySelectorAll('.meta-tab-bar__tab--add').length).toBe(1)
  })

  it('G-FE-4: personal-views-enabled absent/false renders NO toggle at all', () => {
    const rootAbsent = mountComponent(MetaSheetViewRail, baseProps({ personalViewsEnabled: undefined }))
    expect(personalToggles(rootAbsent).length).toBe(0)

    const rootFalse = mountComponent(MetaSheetViewRail, baseProps({ personalViewsEnabled: false }))
    expect(personalToggles(rootFalse).length).toBe(0)
  })

  it('personal-views-enabled=true renders the toggle ONLY next to the active view, not inactive ones', () => {
    // activeViewId 'v1' is VIEWS[0]; VIEWS[1]/[2] are inactive and must show no toggle.
    const root = mountComponent(MetaSheetViewRail, baseProps({ personalViewsEnabled: true, activeViewId: 'v1' }))
    const groups = Array.from(root.querySelectorAll('.meta-tab-bar__view-group'))
    expect(groups.length).toBe(3)
    expect(groups[0].querySelector('[data-testid="personal-view-toggle"]')).toBeTruthy()
    expect(groups[1].querySelector('[data-testid="personal-view-toggle"]')).toBeNull()
    expect(groups[2].querySelector('[data-testid="personal-view-toggle"]')).toBeNull()

    // Switching the active view moves the (sole) toggle with it.
    const rootV2Active = mountComponent(MetaSheetViewRail, baseProps({ personalViewsEnabled: true, activeViewId: 'v2' }))
    const groupsV2 = Array.from(rootV2Active.querySelectorAll('.meta-tab-bar__view-group'))
    expect(groupsV2[0].querySelector('[data-testid="personal-view-toggle"]')).toBeNull()
    expect(groupsV2[1].querySelector('[data-testid="personal-view-toggle"]')).toBeTruthy()
    expect(groupsV2[2].querySelector('[data-testid="personal-view-toggle"]')).toBeNull()
  })
})

describe('MetaSheetViewRail — count conservation', () => {
  it('renders exactly one sheet tab per sheets[] entry, regardless of gating', () => {
    for (const canCreateSheet of [true, false]) {
      const root = mountComponent(MetaSheetViewRail, baseProps({ canCreateSheet }))
      expect(sheetTabs(root).length).toBe(SHEETS.length)
      expect(!!addSheetButton(root)).toBe(canCreateSheet)
    }
  })

  it('renders exactly one view tab per views[] entry, regardless of gating', () => {
    for (const personalViewsEnabled of [true, false]) {
      const root = mountComponent(MetaSheetViewRail, baseProps({ personalViewsEnabled }))
      expect(viewTabs(root).length).toBe(VIEWS.length)
    }
  })

  it('scales with a different sheets/views count (3 sheets, 1 view)', () => {
    const threeSheets: MetaSheet[] = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }]
    const oneView: MetaView[] = [{ id: 'v', sheetId: 'a', name: 'Only view', type: 'grid' }]
    const root = mountComponent(MetaSheetViewRail, baseProps({ sheets: threeSheets, views: oneView, activeSheetId: 'a', activeViewId: 'v' }))
    expect(sheetTabs(root).length).toBe(3)
    expect(viewTabs(root).length).toBe(1)
  })

  it('renders zero view tabs and hides the views strip when views[] is empty', () => {
    const root = mountComponent(MetaSheetViewRail, baseProps({ views: [] }))
    expect(viewTabs(root).length).toBe(0)
    expect(root.querySelector('.meta-tab-bar__views')).toBeNull() // v-if="views.length"
  })
})

describe('MetaSheetViewRail vs MetaViewTabBar — DOM-snapshot equivalence (byte-identical rendering)', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['default (all gates on, mid-list active)', baseProps()],
    ['can-create-sheet off', baseProps({ canCreateSheet: false })],
    ['personal-views-enabled off', baseProps({ personalViewsEnabled: false })],
    ['personal-views-enabled absent', baseProps({ personalViewsEnabled: undefined })],
    ['last sheet + last view active, isPersonalMode true', baseProps({
      activeSheetId: 's2', activeViewId: 'v3', isPersonalMode: () => true,
    })],
    // P3-1 (adversarial-review hardening on #4237): every case above that renders the toggle at
    // all renders it ON (isPersonalMode true, via baseProps()'s default `id === 'v1'` matching the
    // default activeViewId, or the explicit `() => true` case above). Toggle-visible-but-OFF
    // (`aria-pressed="false"`, no `--on` class) was therefore never byte-compared by THIS spec —
    // it's covered transitively today by tests/meta-view-tab-bar-personal-toggle.spec.ts mounting
    // MetaViewTabBar alone, but this spec's own baseline forward-pin (the one P2-2b will build on)
    // had a gap. Close it directly.
    ['personal-views-enabled on, toggle visible but OFF (isPersonalMode false)', baseProps({
      personalViewsEnabled: true, isPersonalMode: () => false,
    })],
    ['empty views[]', baseProps({ views: [] })],
    ['single sheet, no create', baseProps({ sheets: [SHEETS[0]], canCreateSheet: false, activeSheetId: 's1' })],
  ]

  for (const [label, props] of cases) {
    it(`identical outerHTML for: ${label}`, () => {
      const oldRoot = mountComponent(MetaViewTabBar, props)
      const newRoot = mountComponent(MetaSheetViewRail, props)
      expect(normalizeScopeHash(newRoot.innerHTML)).toBe(normalizeScopeHash(oldRoot.innerHTML))
    })
  }

  it('identical outerHTML after an interactive state change (post-click active class)', () => {
    const oldRoot = mountComponent(MetaViewTabBar, baseProps())
    const newRoot = mountComponent(MetaSheetViewRail, baseProps())
    // Drive the SAME interaction on both (click the 2nd sheet tab) — the parent (in production,
    // MultitableWorkbench) is what actually reacts to the emit and re-passes activeSheetId; this
    // step only proves the emit-driven DOM (e.g. hover/focus-independent markup) stays identical
    // pre-click too, since both components are prop-driven and stateless w.r.t. active-ness.
    sheetTabs(oldRoot)[1].click()
    sheetTabs(newRoot)[1].click()
    expect(normalizeScopeHash(newRoot.innerHTML)).toBe(normalizeScopeHash(oldRoot.innerHTML))
  })
})
