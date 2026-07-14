/**
 * UI-P2-2b — MetaSheetViewRail vertical tree relayout (design
 * docs/development/multitable-ui-p2-2b-vertical-tree-design-20260713.md, per RATIFIED parent lock
 * docs/development/multitable-ui-p2-2-left-rail-detail-designlock-20260707.md §4.6/§5).
 *
 * P2-2a's DOM-snapshot-equivalence baseline (MetaViewTabBar.vue, mount-both-diff-outerHTML) RETIRES
 * here — a real visual relayout (horizontal tab strip -> vertical tree) cannot stay byte-identical.
 * The replacement safety net, all in this one file:
 *
 *   T1  4-emit behavior-equivalence (select-sheet / select-view / create-sheet / toggle-personal),
 *       one-by-one so a single broken emit-forward reds exactly one test.
 *   T2  Gating equivalence (canCreateSheet gates "+ add sheet"; personalViewsEnabled + active-view-
 *       only gates the personal toggle — G-FE-4).
 *   T3  Count conservation (N sheets -> N sheet nodes, M views -> M view leaves under the active
 *       sheet only, regardless of gating).
 *   T4  Assertions ABSORBED verbatim from the retired tests/meta-view-tab-bar-personal-toggle.spec.ts
 *       (deleted this same PR) — aria-pressed on/off + the "--on" modifier class, click emits
 *       toggle-personal(viewId), and the bilingual "My view" / "个人视图" label. Nothing dropped.
 *   T5  Native keyboard/ARIA: role="tree"/"treeitem"/"group", aria-selected on both layers,
 *       aria-expanded's 3-state rule (true / omitted / false), roving tabindex ("exactly one 0"),
 *       arrow/Home/End focus movement (never emits — the deliberate ARIA deviation: here "expand" IS
 *       "activate" IS side-effecting, so arrow keys move focus ONLY).
 *   T6  UF token gate: the component source contains zero hardcoded CSS hex colors.
 *
 * Selectors are structural data-testid hooks or ARIA roles/attributes — never fuzzy textContent or
 * `?.click()` silently no-opping past a broken selector; every lookup is asserted non-null/non-empty
 * before use.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaSheetViewRail from '../src/multitable/components/MetaSheetViewRail.vue'
import type { MetaSheet, MetaView } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

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

function mountComponent(props: Record<string, unknown>): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ setup: () => () => h(MetaSheetViewRail, props) })
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
  useLocale().setLocale('en')
})

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

// Structural, non-fuzzy element lookups shared by every describe block below.
function sheetNodes(root: HTMLElement): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll('[data-testid="rail-sheet-node"]'))
}
function addSheetButton(root: HTMLElement): HTMLButtonElement | null {
  return root.querySelector('[data-testid="rail-add-sheet"]')
}
function viewNodes(root: HTMLElement): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll('[data-testid="rail-view-node"]'))
}
function personalToggles(root: HTMLElement): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll('[data-testid="personal-view-toggle"]'))
}

describe('MetaSheetViewRail — T1: 4-emit behavior equivalence (one by one)', () => {
  it('emits select-sheet with the clicked sheet id, and ONLY select-sheet', () => {
    const onSelectSheet = vi.fn()
    const onSelectView = vi.fn()
    const onCreateSheet = vi.fn()
    const onTogglePersonal = vi.fn()
    const root = mountComponent(baseProps({ onSelectSheet, onSelectView, onCreateSheet, onTogglePersonal }))
    const nodes = sheetNodes(root)
    expect(nodes.length).toBe(2)
    nodes[1].click() // SHEETS[1] === { id: 's2', ... }
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
    const root = mountComponent(baseProps({ onSelectSheet, onSelectView, onCreateSheet, onTogglePersonal }))
    const nodes = viewNodes(root)
    expect(nodes.length).toBe(3)
    nodes[1].click() // VIEWS[1] === { id: 'v2', ... }
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
    const root = mountComponent(baseProps({ onSelectSheet, onSelectView, onCreateSheet, onTogglePersonal }))
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
    const root = mountComponent(baseProps({ onSelectSheet, onSelectView, onCreateSheet, onTogglePersonal }))
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

describe('MetaSheetViewRail — T2: gating equivalence', () => {
  it('canCreateSheet=false hides the "add sheet" row entirely (no click target, no possible emit)', () => {
    const root = mountComponent(baseProps({ canCreateSheet: false }))
    expect(addSheetButton(root)).toBeNull()
  })

  it('canCreateSheet=true renders exactly one "add sheet" row', () => {
    const root = mountComponent(baseProps({ canCreateSheet: true }))
    const btn = addSheetButton(root)
    expect(btn).toBeTruthy()
    expect(root.querySelectorAll('[data-testid="rail-add-sheet"]').length).toBe(1)
  })

  it('G-FE-4: personalViewsEnabled absent/false renders NO toggle at all', () => {
    const rootAbsent = mountComponent(baseProps({ personalViewsEnabled: undefined }))
    expect(personalToggles(rootAbsent).length).toBe(0)

    const rootFalse = mountComponent(baseProps({ personalViewsEnabled: false }))
    expect(personalToggles(rootFalse).length).toBe(0)
  })

  it('personalViewsEnabled=true renders the toggle ONLY next to the active view, not inactive ones', () => {
    // activeViewId 'v1' is VIEWS[0]; VIEWS[1]/[2] are inactive and must show no toggle.
    const root = mountComponent(baseProps({ personalViewsEnabled: true, activeViewId: 'v1' }))
    const rows = Array.from(root.querySelectorAll('.meta-view-rail__view-row'))
    expect(rows.length).toBe(3)
    expect(rows[0].querySelector('[data-testid="personal-view-toggle"]')).toBeTruthy()
    expect(rows[1].querySelector('[data-testid="personal-view-toggle"]')).toBeNull()
    expect(rows[2].querySelector('[data-testid="personal-view-toggle"]')).toBeNull()

    // Switching the active view moves the (sole) toggle with it.
    const rootV2Active = mountComponent(baseProps({ personalViewsEnabled: true, activeViewId: 'v2' }))
    const rowsV2 = Array.from(rootV2Active.querySelectorAll('.meta-view-rail__view-row'))
    expect(rowsV2[0].querySelector('[data-testid="personal-view-toggle"]')).toBeNull()
    expect(rowsV2[1].querySelector('[data-testid="personal-view-toggle"]')).toBeTruthy()
    expect(rowsV2[2].querySelector('[data-testid="personal-view-toggle"]')).toBeNull()
  })
})

describe('MetaSheetViewRail — T3: count conservation', () => {
  it('renders exactly one sheet node per sheets[] entry, regardless of gating', () => {
    for (const canCreateSheet of [true, false]) {
      const root = mountComponent(baseProps({ canCreateSheet }))
      expect(sheetNodes(root).length).toBe(SHEETS.length)
      expect(!!addSheetButton(root)).toBe(canCreateSheet)
    }
  })

  it('renders exactly one view leaf per views[] entry (under the active sheet), regardless of gating', () => {
    for (const personalViewsEnabled of [true, false]) {
      const root = mountComponent(baseProps({ personalViewsEnabled }))
      expect(viewNodes(root).length).toBe(VIEWS.length)
    }
  })

  it('scales with a different sheets/views count (3 sheets, 1 view)', () => {
    const threeSheets: MetaSheet[] = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }]
    const oneView: MetaView[] = [{ id: 'v', sheetId: 'a', name: 'Only view', type: 'grid' }]
    const root = mountComponent(baseProps({ sheets: threeSheets, views: oneView, activeSheetId: 'a', activeViewId: 'v' }))
    expect(sheetNodes(root).length).toBe(3)
    expect(viewNodes(root).length).toBe(1)
  })

  it('renders zero view leaves and no group when views[] is empty', () => {
    const root = mountComponent(baseProps({ views: [] }))
    expect(viewNodes(root).length).toBe(0)
    expect(root.querySelector('[role="group"]')).toBeNull() // v-if="views.length"
  })
})

// T4 — assertions ABSORBED verbatim from the retired tests/meta-view-tab-bar-personal-toggle.spec.ts
// (deleted this PR, see design MD §7/§8.1). Same claims, new selectors/class names.
describe('MetaSheetViewRail — T4: absorbed MetaViewTabBar personal-toggle retirement checklist', () => {
  it('[absorbed] G-FE-4: renders NO toggle at all when personalViewsEnabled is absent/false', () => {
    const rootAbsent = mountComponent(baseProps({ personalViewsEnabled: undefined }))
    expect(rootAbsent.querySelector('[data-testid="personal-view-toggle"]')).toBeNull()

    const rootOff = mountComponent(baseProps({ personalViewsEnabled: false }))
    expect(rootOff.querySelector('[data-testid="personal-view-toggle"]')).toBeNull()
  })

  it('[absorbed] renders the toggle only next to the ACTIVE view when enabled', () => {
    const root = mountComponent(baseProps({ personalViewsEnabled: true, isPersonalMode: () => false }))
    const toggles = root.querySelectorAll('[data-testid="personal-view-toggle"]')
    expect(toggles.length).toBe(1)
  })

  it('[absorbed] reflects isPersonalMode via aria-pressed + the "--on" modifier class', () => {
    const rootOff = mountComponent(baseProps({ personalViewsEnabled: true, isPersonalMode: () => false }))
    const toggleOff = rootOff.querySelector('[data-testid="personal-view-toggle"]') as HTMLButtonElement
    expect(toggleOff.getAttribute('aria-pressed')).toBe('false')
    expect(toggleOff.classList.contains('--on')).toBe(false)

    const rootOn = mountComponent(baseProps({ personalViewsEnabled: true, isPersonalMode: () => true }))
    const toggleOn = rootOn.querySelector('[data-testid="personal-view-toggle"]') as HTMLButtonElement
    expect(toggleOn.getAttribute('aria-pressed')).toBe('true')
    expect(toggleOn.classList.contains('--on')).toBe(true)
  })

  it('[absorbed] clicking the toggle emits toggle-personal with the view id', () => {
    const onTogglePersonal = vi.fn()
    const root = mountComponent(baseProps({ personalViewsEnabled: true, isPersonalMode: () => false, onTogglePersonal }))
    const toggle = root.querySelector('[data-testid="personal-view-toggle"]') as HTMLButtonElement
    toggle.click()
    expect(onTogglePersonal).toHaveBeenCalledWith('v1')
  })

  it('[absorbed] labels the affordance unambiguously as personal ("My view" / 个人视图), never as editing the shared view', () => {
    const root = mountComponent(baseProps({ personalViewsEnabled: true, isPersonalMode: () => false }))
    const toggle = root.querySelector('[data-testid="personal-view-toggle"]') as HTMLButtonElement
    expect(toggle.textContent?.trim()).toBe('My view')

    useLocale().setLocale('zh')
    const rootZh = mountComponent(baseProps({ personalViewsEnabled: true, isPersonalMode: () => false }))
    const toggleZh = rootZh.querySelector('[data-testid="personal-view-toggle"]') as HTMLButtonElement
    expect(toggleZh.textContent?.trim()).toBe('个人视图')
  })
})

describe('MetaSheetViewRail — T5: tree roles + ARIA state', () => {
  it('role structure: tree > treeitem (sheet nodes), group > treeitem (view leaves)', () => {
    const root = mountComponent(baseProps())
    expect(root.querySelector('[role="tree"]')).toBeTruthy()
    expect(root.querySelectorAll('[role="group"]').length).toBe(1) // only the active sheet's group renders (§1.3)
    for (const el of sheetNodes(root)) expect(el.getAttribute('role')).toBe('treeitem')
    for (const el of viewNodes(root)) expect(el.getAttribute('role')).toBe('treeitem')
  })

  it('aria-selected reflects activeSheetId / activeViewId on both layers', () => {
    const root = mountComponent(baseProps({ activeSheetId: 's1', activeViewId: 'v2' }))
    const [s1, s2] = sheetNodes(root)
    expect(s1.getAttribute('aria-selected')).toBe('true')
    expect(s2.getAttribute('aria-selected')).toBe('false')
    const [v1, v2, v3] = viewNodes(root)
    expect(v1.getAttribute('aria-selected')).toBe('false')
    expect(v2.getAttribute('aria-selected')).toBe('true')
    expect(v3.getAttribute('aria-selected')).toBe('false')
  })

  it('aria-expanded: "true" when active-with-views, OMITTED when active-with-zero-views, "false" when not active', () => {
    const root = mountComponent(baseProps())
    const [s1, s2] = sheetNodes(root)
    expect(s1.getAttribute('aria-expanded')).toBe('true') // active, has views
    expect(s2.getAttribute('aria-expanded')).toBe('false') // not active

    const rootEmpty = mountComponent(baseProps({ views: [], activeViewId: '' }))
    const s1Empty = sheetNodes(rootEmpty)[0]
    expect(s1Empty.hasAttribute('aria-expanded')).toBe(false) // active but no children: not "true"
  })

  it('the tree carries a bilingual aria-label (typed-label module wiring proof)', () => {
    const root = mountComponent(baseProps())
    expect(root.querySelector('[role="tree"]')?.getAttribute('aria-label')).toBe('Tables and views')

    useLocale().setLocale('zh')
    const rootZh = mountComponent(baseProps())
    expect(rootZh.querySelector('[role="tree"]')?.getAttribute('aria-label')).toBe('数据表与视图')
  })

  it('the "add sheet" row label is bilingual (typed-label module wiring proof)', () => {
    const root = mountComponent(baseProps({ canCreateSheet: true }))
    expect(addSheetButton(root)?.textContent?.trim()).toBe('＋ New table')

    useLocale().setLocale('zh')
    const rootZh = mountComponent(baseProps({ canCreateSheet: true }))
    expect(addSheetButton(rootZh)?.textContent?.trim()).toBe('＋ 新建数据表')
  })

  it('roving tabindex: exactly one treeitem has tabindex=0, initially the active view leaf', () => {
    const root = mountComponent(baseProps())
    const treeitems = Array.from(root.querySelectorAll('[role="treeitem"]'))
    const zeroTabIndex = treeitems.filter((el) => el.getAttribute('tabindex') === '0')
    expect(zeroTabIndex.length).toBe(1)
    expect(zeroTabIndex[0]).toBe(viewNodes(root)[0]) // activeViewId 'v1' === VIEWS[0]
  })

  it('roving tabindex falls back to the active sheet node when there is no active view (empty views[])', () => {
    const root = mountComponent(baseProps({ views: [], activeViewId: '' }))
    const treeitems = Array.from(root.querySelectorAll('[role="treeitem"]'))
    const zeroTabIndex = treeitems.filter((el) => el.getAttribute('tabindex') === '0')
    expect(zeroTabIndex.length).toBe(1)
    expect(zeroTabIndex[0]).toBe(sheetNodes(root)[0]) // activeSheetId 's1' === SHEETS[0]
  })

  it('ArrowDown/ArrowUp move focus within the flattened node sequence and update roving tabindex', async () => {
    const root = mountComponent(baseProps())
    const v1 = viewNodes(root)[0]
    v1.focus()
    expect(document.activeElement).toBe(v1)

    v1.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    await flushPromises()
    const v2 = viewNodes(root)[1]
    expect(document.activeElement).toBe(v2)
    expect(v2.getAttribute('tabindex')).toBe('0')
    expect(v1.getAttribute('tabindex')).toBe('-1')

    v2.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(document.activeElement).toBe(v1)
    expect(v1.getAttribute('tabindex')).toBe('0')
  })

  it('ArrowRight on the active (expanded) sheet moves focus into its first view leaf', async () => {
    const root = mountComponent(baseProps())
    const s1 = sheetNodes(root)[0]
    s1.focus()
    s1.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(document.activeElement).toBe(viewNodes(root)[0])
  })

  it('ArrowRight on a non-active sheet is a no-op (expand is never an arrow-key side effect)', async () => {
    const root = mountComponent(baseProps())
    const s2 = sheetNodes(root)[1]
    s2.focus()
    s2.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(document.activeElement).toBe(s2)
  })

  it('ArrowRight on a view leaf is a no-op', async () => {
    const root = mountComponent(baseProps())
    const v1 = viewNodes(root)[0]
    v1.focus()
    v1.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(document.activeElement).toBe(v1)
  })

  it('ArrowLeft on a view leaf moves focus back to its parent (active) sheet node; on a sheet node is a no-op', async () => {
    const root = mountComponent(baseProps())
    const v2 = viewNodes(root)[1]
    v2.focus()
    v2.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
    await flushPromises()
    const s1 = sheetNodes(root)[0]
    expect(document.activeElement).toBe(s1)

    s1.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(document.activeElement).toBe(s1) // no-op: collapse is derived state, not arrow-cancellable
  })

  it('Home/End move focus to the first/last node in the flattened sequence', async () => {
    const root = mountComponent(baseProps())
    const v2 = viewNodes(root)[1]
    v2.focus()
    v2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(document.activeElement).toBe(sheetNodes(root)[0]) // first node overall: sheet s1

    const s1 = sheetNodes(root)[0]
    s1.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(document.activeElement).toBe(sheetNodes(root)[1]) // last node overall: sheet s2 (views only under active s1)
  })

  it('every arrow/Home/End keypress across every node never emits any of the 4 events', async () => {
    const onSelectSheet = vi.fn()
    const onSelectView = vi.fn()
    const onCreateSheet = vi.fn()
    const onTogglePersonal = vi.fn()
    const root = mountComponent(baseProps({ onSelectSheet, onSelectView, onCreateSheet, onTogglePersonal }))
    const keys = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End']
    for (const node of [...sheetNodes(root), ...viewNodes(root)]) {
      for (const key of keys) {
        node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      }
    }
    await flushPromises()
    expect(onSelectSheet).not.toHaveBeenCalled()
    expect(onSelectView).not.toHaveBeenCalled()
    expect(onCreateSheet).not.toHaveBeenCalled()
    expect(onTogglePersonal).not.toHaveBeenCalled()
  })

  it('the decorative chevron is aria-hidden (not part of the accessible name twice-over)', () => {
    const root = mountComponent(baseProps())
    const chevron = sheetNodes(root)[0].querySelector('.meta-view-rail__chevron')
    expect(chevron).toBeTruthy()
    expect(chevron!.getAttribute('aria-hidden')).toBe('true')
  })
})

describe('MetaSheetViewRail — T6: UF token gate (design MD §6: zero hardcoded hex)', () => {
  it('the component source contains no hardcoded CSS hex colors', () => {
    const source = readFileSync(join(__dirname, '..', 'src/multitable/components/MetaSheetViewRail.vue'), 'utf-8')
    const hexMatches = source.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
    expect(hexMatches).toEqual([])
  })
})
