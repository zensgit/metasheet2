/**
 * MetaViewTabBar — Slice 3 "My view" personal-toggle rendering (design-lock
 * docs/development/multitable-personal-views-slice3-fe-toggle-design-lock-20260706.md §3 P1 / G-FE-4).
 *
 * G-FE-4 (flag-off inert): with `personalViewsEnabled` absent/false, the toggle is NOT in the DOM at all —
 * no click target exists, so no personal-config request can ever originate from this component. When
 * enabled, the toggle renders ONLY next to the active view tab and reflects `isPersonalMode`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, type App } from 'vue'
import MetaViewTabBar from '../src/multitable/components/MetaViewTabBar.vue'
import type { MetaSheet, MetaView } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

let app: App<Element> | null = null
let container: HTMLDivElement | null = null
afterEach(() => { app?.unmount(); app = null; container?.remove(); container = null; useLocale().setLocale('en') })

const SHEETS: MetaSheet[] = [{ id: 's1', name: 'Sheet 1' }]
const VIEWS: MetaView[] = [
  { id: 'v1', sheetId: 's1', name: 'Grid view', type: 'grid' },
  { id: 'v2', sheetId: 's1', name: 'Kanban view', type: 'kanban' },
]

function mountTabBar(props: Record<string, unknown>) {
  container = document.createElement('div'); document.body.appendChild(container)
  app = createApp({ setup: () => () => h(MetaViewTabBar, {
    sheets: SHEETS, views: VIEWS, activeSheetId: 's1', activeViewId: 'v1',
    ...props,
  }) })
  app.mount(container)
  return container
}

describe('MetaViewTabBar personal-views toggle', () => {
  it('G-FE-4: renders NO toggle at all when personalViewsEnabled is absent/false', () => {
    const root = mountTabBar({})
    expect(root.querySelector('[data-testid="personal-view-toggle"]')).toBeNull()

    const rootExplicitOff = mountTabBar({ personalViewsEnabled: false })
    expect(rootExplicitOff.querySelector('[data-testid="personal-view-toggle"]')).toBeNull()
  })

  it('renders the toggle only next to the ACTIVE view when enabled', () => {
    const root = mountTabBar({ personalViewsEnabled: true, isPersonalMode: () => false })
    const toggles = root.querySelectorAll('[data-testid="personal-view-toggle"]')
    expect(toggles.length).toBe(1)
  })

  it('reflects isPersonalMode via aria-pressed + an "on" class', () => {
    const rootOff = mountTabBar({ personalViewsEnabled: true, isPersonalMode: () => false })
    const toggleOff = rootOff.querySelector('[data-testid="personal-view-toggle"]') as HTMLButtonElement
    expect(toggleOff.getAttribute('aria-pressed')).toBe('false')
    expect(toggleOff.className).not.toContain('meta-tab-bar__personal-toggle--on')

    const rootOn = mountTabBar({ personalViewsEnabled: true, isPersonalMode: () => true })
    const toggleOn = rootOn.querySelector('[data-testid="personal-view-toggle"]') as HTMLButtonElement
    expect(toggleOn.getAttribute('aria-pressed')).toBe('true')
    expect(toggleOn.className).toContain('meta-tab-bar__personal-toggle--on')
  })

  it('clicking the toggle emits toggle-personal with the view id', () => {
    const onTogglePersonal = vi.fn()
    const root = mountTabBar({ personalViewsEnabled: true, isPersonalMode: () => false, onTogglePersonal })
    const toggle = root.querySelector('[data-testid="personal-view-toggle"]') as HTMLButtonElement
    toggle.click()
    expect(onTogglePersonal).toHaveBeenCalledWith('v1')
  })

  it('labels the affordance unambiguously as personal ("My view" / 个人视图), never as editing the shared view', () => {
    const root = mountTabBar({ personalViewsEnabled: true, isPersonalMode: () => false })
    const toggle = root.querySelector('[data-testid="personal-view-toggle"]') as HTMLButtonElement
    expect(toggle.textContent?.trim()).toBe('My view')

    useLocale().setLocale('zh')
    const rootZh = mountTabBar({ personalViewsEnabled: true, isPersonalMode: () => false })
    const toggleZh = rootZh.querySelector('[data-testid="personal-view-toggle"]') as HTMLButtonElement
    expect(toggleZh.textContent?.trim()).toBe('个人视图')
  })
})
