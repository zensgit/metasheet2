import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, nextTick, ref, type App } from 'vue'
import type { AdminSectionNavItem } from '../src/views/attendance/useAttendanceAdminRail'
import { useAttendanceAdminRailNavigation } from '../src/views/attendance/useAttendanceAdminRailNavigation'

async function flushUi(cycles = 5): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  })
  window.dispatchEvent(new Event('resize'))
}

describe('useAttendanceAdminRailNavigation', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null
  let scrollIntoViewSpy: ReturnType<typeof vi.fn>
  let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined

  beforeEach(() => {
    window.localStorage.clear()
    window.history.replaceState({}, '', '/attendance')
    setViewportWidth(1280)
    container = document.createElement('div')
    document.body.appendChild(container)
    scrollIntoViewSpy = vi.fn()
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoViewSpy,
    })
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
        configurable: true,
        value: originalScrollIntoView,
      })
    }
    app = null
    container = null
  })

  function mountHost(options?: { focused?: boolean }) {
    const items: AdminSectionNavItem[] = [
      { id: 'attendance-admin-settings', label: 'Settings' },
      { id: 'attendance-admin-approval-flows', label: 'Approval Flows' },
    ]
    const Host = defineComponent({
      setup() {
        const showAdmin = ref(true)
        const adminForbidden = ref(false)
        const adminFocusCurrentSectionOnly = ref(options?.focused ?? false)
        const adminNavStorageScope = ref('default')
        const adminActiveSectionId = ref(items[0].id)
        const previousAdminSectionId = computed(() => {
          const activeIndex = items.findIndex(item => item.id === adminActiveSectionId.value)
          if (activeIndex <= 0) return ''
          return items[activeIndex - 1]?.id ?? ''
        })
        const nextAdminSectionId = computed(() => {
          const activeIndex = items.findIndex(item => item.id === adminActiveSectionId.value)
          if (activeIndex < 0 || activeIndex >= items.length - 1) return ''
          return items[activeIndex + 1]?.id ?? ''
        })
        const isCompactAdminNav = ref(false)
        const adminCompactNavOpen = ref(false)
        const { adminSectionBinding, scrollToAdminSection } = useAttendanceAdminRailNavigation({
          showAdmin,
          adminForbidden,
          adminFocusCurrentSectionOnly,
          previousAdminSectionId,
          nextAdminSectionId,
          adminNavStorageScope,
          adminActiveSectionId,
          adminSectionNavItems: ref(items),
          isKnownAdminSectionId: (id: string | null | undefined): id is string => items.some(item => item.id === id),
          readLastAdminSection: () => window.localStorage.getItem('metasheet_attendance_admin_nav_last_section:default'),
          isCompactAdminNav,
          adminCompactNavOpen,
        })
        return {
          adminActiveSectionId,
          adminCompactNavOpen,
          adminSectionBinding,
          isCompactAdminNav,
          scrollToAdminSection,
        }
      },
      template: `
        <div>
          <button data-admin-anchor="attendance-admin-settings" type="button">Settings</button>
          <button data-admin-anchor="attendance-admin-approval-flows" type="button">Approval Flows</button>
          <input data-keyboard-blocker type="text" />
          <div data-active-id>{{ adminActiveSectionId }}</div>
          <section v-bind="adminSectionBinding('attendance-admin-settings')">Settings section</section>
          <section v-bind="adminSectionBinding('attendance-admin-approval-flows')">Approval section</section>
        </div>
      `,
    })

    app = createApp(Host)
    return app.mount(container!) as any
  }

  it('restores the hashed section on mount and syncs the active rail link into view', async () => {
    window.history.replaceState({}, '', '/attendance#attendance-admin-approval-flows')
    const vm = mountHost()
    await flushUi()

    expect(vm.adminActiveSectionId).toBe('attendance-admin-approval-flows')
    expect(window.location.hash).toBe('#attendance-admin-approval-flows')
    const scrolledTargets = scrollIntoViewSpy.mock.instances as HTMLElement[]
    expect(scrolledTargets.some(target => target.id === 'attendance-admin-approval-flows')).toBe(true)
    expect(scrolledTargets.some(target => target.dataset.adminAnchor === 'attendance-admin-approval-flows')).toBe(true)
  })

  it('scrolls only the content pane in focused mode when selecting a section', async () => {
    const vm = mountHost({ focused: true })
    await flushUi()

    const content = document.createElement('div')
    content.dataset.adminContent = 'true'
    const target = document.getElementById('attendance-admin-approval-flows')
    expect(target).toBeTruthy()
    content.appendChild(target!)
    container!.appendChild(content)
    scrollIntoViewSpy.mockClear()

    vm.scrollToAdminSection('attendance-admin-approval-flows')
    await flushUi()

    const scrolledTargets = scrollIntoViewSpy.mock.instances as HTMLElement[]
    expect(scrolledTargets.some(element => element.dataset.adminContent === 'true')).toBe(true)
    expect(scrolledTargets.some(element => element.id === 'attendance-admin-approval-flows')).toBe(false)
  })

  it('closes compact nav after selecting a section', async () => {
    setViewportWidth(640)
    const vm = mountHost()
    await flushUi()

    vm.adminCompactNavOpen = true
    vm.scrollToAdminSection('attendance-admin-approval-flows')
    await flushUi()

    expect(vm.isCompactAdminNav).toBe(true)
    expect(vm.adminCompactNavOpen).toBe(false)
    expect(vm.adminActiveSectionId).toBe('attendance-admin-approval-flows')
    expect(window.location.hash).toBe('#attendance-admin-approval-flows')
  })

  it('moves between sections with Alt+ArrowDown and Alt+ArrowUp', async () => {
    const vm = mountHost()
    await flushUi()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }))
    await flushUi()

    expect(vm.adminActiveSectionId).toBe('attendance-admin-approval-flows')
    expect(window.location.hash).toBe('#attendance-admin-approval-flows')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }))
    await flushUi()

    expect(vm.adminActiveSectionId).toBe('attendance-admin-settings')
    expect(window.location.hash).toBe('#attendance-admin-settings')
  })

  it('ignores keyboard navigation while an input is focused', async () => {
    const vm = mountHost()
    await flushUi()

    const input = container!.querySelector<HTMLInputElement>('[data-keyboard-blocker]')
    expect(input).toBeTruthy()
    input!.focus()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }))
    await flushUi()

    expect(vm.adminActiveSectionId).toBe('attendance-admin-settings')
    expect(window.location.hash).toBe('')
  })
})
