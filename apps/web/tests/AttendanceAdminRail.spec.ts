import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AttendanceAdminRail from '../src/views/attendance/AttendanceAdminRail.vue'

type AdminRailGroup = {
  id: string
  label: string
  countLabel: string
  expanded: boolean
  items: Array<{ id: string; label: string }>
}

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('AttendanceAdminRail', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  function mountRail(overrides: Partial<Record<string, unknown>> = {}) {
    const handlers = {
      onToggleGroup: vi.fn(),
      onSelectSection: vi.fn(),
      onExpandAll: vi.fn(),
      onCollapseAll: vi.fn(),
      onCopyCurrentLink: vi.fn(),
      onClearRecents: vi.fn(),
      'onUpdate:compactNavOpen': vi.fn(),
      'onUpdate:sectionFilter': vi.fn(),
    }
    const props = {
      tr: (en: string) => en,
      adminSectionNavCountLabel: '22 items',
      adminNavStorageScope: 'default',
      adminNavDefaultStorageScope: 'default',
      adminNavScopeFeedback: '',
      activeAdminSectionContextLabel: 'Workspace · Settings',
      isCompactAdminNav: false,
      adminCompactNavOpen: false,
      adminSectionFilter: '',
      adminSectionFilterActive: false,
      allAdminSectionGroupsExpanded: false,
      allAdminSectionGroupsCollapsed: false,
      visibleRecentAdminSectionNavItems: [
        { id: 'attendance-admin-approval-flows', label: 'Approval Flows', groupLabel: 'Policies', contextLabel: 'Policies · Approval Flows' },
      ],
      visibleAdminSectionNavGroups: [
        {
          id: 'workspace',
          label: 'Workspace',
          countLabel: '2',
          expanded: true,
          items: [
            { id: 'attendance-admin-settings', label: 'Settings' },
            { id: 'attendance-admin-user-access', label: 'User Access' },
          ],
        },
      ] satisfies AdminRailGroup[],
      adminActiveSectionId: 'attendance-admin-settings',
      ...handlers,
      ...overrides,
    }

    app = createApp(AttendanceAdminRail, props)
    app.mount(container!)
    return handlers
  }

  it('renders current summary, groups, and recent shortcuts with context labels', async () => {
    mountRail()
    await flushUi()

    expect(container!.querySelector('.attendance__admin-nav-current')?.textContent).toContain('Workspace · Settings')
    expect(container!.querySelector('.attendance__admin-nav-group-title')?.textContent).toContain('Workspace')
    expect(container!.querySelector('[data-admin-anchor-recent="attendance-admin-approval-flows"]')?.textContent).toContain('Policies · Approval Flows')
    expect(container!.querySelector('[data-admin-recents-clear="true"]')).toBeTruthy()
  })

  it('emits interaction events for the extracted rail surface', async () => {
    const handlers = mountRail({ isCompactAdminNav: true, adminCompactNavOpen: true })
    await flushUi()

    const toggle = container!.querySelector<HTMLButtonElement>('.attendance__admin-nav-toggle')
    expect(toggle).toBeTruthy()
    toggle!.click()
    await flushUi()
    expect(handlers['onUpdate:compactNavOpen']).toHaveBeenCalledWith(false)

    const filter = container!.querySelector<HTMLInputElement>('#attendance-admin-nav-filter')!
    filter.value = 'pay'
    filter.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    expect(handlers['onUpdate:sectionFilter']).toHaveBeenCalledWith('pay')

    container!.querySelector<HTMLButtonElement>('.attendance__admin-nav-group-header')!.click()
    container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-settings"]')!.click()
    container!.querySelector<HTMLButtonElement>('[data-admin-anchor-recent="attendance-admin-approval-flows"]')!.click()
    container!.querySelector<HTMLButtonElement>('[data-admin-recents-clear="true"]')!.click()
    container!.querySelectorAll<HTMLButtonElement>('.attendance__admin-nav-actions .attendance__btn')[0]!.click()
    container!.querySelectorAll<HTMLButtonElement>('.attendance__admin-nav-actions .attendance__btn')[1]!.click()
    container!.querySelectorAll<HTMLButtonElement>('.attendance__admin-nav-actions .attendance__btn')[2]!.click()
    await flushUi()

    expect(handlers.onToggleGroup).toHaveBeenCalledWith('workspace')
    expect(handlers.onSelectSection).toHaveBeenCalledWith('attendance-admin-settings')
    expect(handlers.onSelectSection).toHaveBeenCalledWith('attendance-admin-approval-flows')
    expect(handlers.onClearRecents).toHaveBeenCalled()
    expect(handlers.onExpandAll).toHaveBeenCalled()
    expect(handlers.onCollapseAll).toHaveBeenCalled()
    expect(handlers.onCopyCurrentLink).toHaveBeenCalled()
  })
})
