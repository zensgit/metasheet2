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
  let originalIntersectionObserver: typeof window.IntersectionObserver | undefined

  beforeEach(() => {
    window.localStorage.clear()
    window.history.replaceState({}, '', '/attendance')
    setViewportWidth(1280)
    container = document.createElement('div')
    document.body.appendChild(container)
    scrollIntoViewSpy = vi.fn()
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    originalIntersectionObserver = window.IntersectionObserver
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
    Object.defineProperty(window, 'IntersectionObserver', {
      configurable: true,
      value: originalIntersectionObserver,
    })
    app = null
    container = null
  })

  function installIntersectionObserver() {
    let callback: IntersectionObserverCallback | null = null
    class TestIntersectionObserver {
      constructor(nextCallback: IntersectionObserverCallback) {
        callback = nextCallback
      }

      disconnect = vi.fn()
      observe = vi.fn()
      unobserve = vi.fn()
      takeRecords = vi.fn(() => [])
      root = null
      rootMargin = '0px'
      thresholds = []
    }
    Object.defineProperty(window, 'IntersectionObserver', {
      configurable: true,
      value: TestIntersectionObserver,
    })
    return {
      trigger(entries: IntersectionObserverEntry[]): void {
        callback?.(entries, {} as IntersectionObserver)
      },
    }
  }

  function mountHost(options?: { focused?: boolean; navigationEnabled?: boolean }) {
    const items: AdminSectionNavItem[] = [
      { id: 'attendance-admin-settings', label: 'Settings' },
      { id: 'attendance-admin-approval-flows', label: 'Approval Flows' },
    ]
    const Host = defineComponent({
      setup() {
        const showAdmin = ref(true)
        const adminForbidden = ref(false)
        const adminNavigationEnabled = ref(options?.navigationEnabled ?? true)
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
          adminNavigationEnabled,
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
          adminNavStorageScope,
          adminNavigationEnabled,
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

  it('keeps the selected section when the observer reports another section in focused mode', async () => {
    const observer = installIntersectionObserver()
    const vm = mountHost({ focused: true })
    await flushUi()

    const approval = document.getElementById('attendance-admin-approval-flows')
    expect(approval).toBeTruthy()
    observer.trigger([{
      target: approval!,
      isIntersecting: true,
      intersectionRatio: 0.9,
      boundingClientRect: approval!.getBoundingClientRect(),
    } as IntersectionObserverEntry])
    await flushUi()

    expect(vm.adminActiveSectionId).toBe('attendance-admin-settings')
  })

  // Positive control for the focused-mode suppression guard above: with focused mode OFF the observer
  // callback MUST assign the reported section — proving the suppressed scroll-spy logic is real logic
  // (not vacuously dead) and that the guard leg's green comes from the guard, not a broken observer.
  it('lets the observer drive the active section when focused mode is OFF (positive control)', async () => {
    const observer = installIntersectionObserver()
    const vm = mountHost({ focused: false })
    await flushUi()

    const approval = document.getElementById('attendance-admin-approval-flows')
    expect(approval).toBeTruthy()
    observer.trigger([{
      target: approval!,
      isIntersecting: true,
      intersectionRatio: 0.9,
      boundingClientRect: approval!.getBoundingClientRect(),
    } as IntersectionObserverEntry])
    await flushUi()

    expect(vm.adminActiveSectionId).toBe('attendance-admin-approval-flows')
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

  // vNext charter §7 Wave 3 (issue #4353): `adminNavigationEnabled` keeps a
  // hidden section workspace (admin task home open) inert — no restore from
  // a remembered section, no keyboard nav, no hash-sync side effects.
  describe('adminNavigationEnabled gate (Wave 3 task-home suppression)', () => {
    it('falls back to the first element instead of the remembered section when navigation is disabled', async () => {
      window.localStorage.setItem('metasheet_attendance_admin_nav_last_section:default', 'attendance-admin-approval-flows')
      const vm = mountHost({ navigationEnabled: false })
      await flushUi()

      expect(vm.adminActiveSectionId).toBe('attendance-admin-settings')
      expect(window.location.hash).toBe('')
      const scrolledTargets = scrollIntoViewSpy.mock.instances as HTMLElement[]
      expect(scrolledTargets.some(target => target.id === 'attendance-admin-approval-flows')).toBe(false)
    })

    // Positive control: the same stored last-section IS honored (and scrolled to) once
    // navigation is enabled, proving the disabled-case above comes from the gate and not a
    // broken fixture. (Hash-writing for this restore-only path is not this composable's own
    // guarantee in isolation — it stays '' here with or without the gate — so this control
    // asserts the id restore + scroll, the two effects the gate actually governs.)
    it('restores the remembered section when navigation is enabled (positive control)', async () => {
      window.localStorage.setItem('metasheet_attendance_admin_nav_last_section:default', 'attendance-admin-approval-flows')
      const vm = mountHost({ navigationEnabled: true })
      await flushUi()

      expect(vm.adminActiveSectionId).toBe('attendance-admin-approval-flows')
      const scrolledTargets = scrollIntoViewSpy.mock.instances as HTMLElement[]
      expect(scrolledTargets.some(target => target.id === 'attendance-admin-approval-flows')).toBe(true)
    })

    it('still honors an explicit hash even while navigation is disabled', async () => {
      window.history.replaceState({}, '', '/attendance#attendance-admin-approval-flows')
      const vm = mountHost({ navigationEnabled: false })
      await flushUi()

      expect(vm.adminActiveSectionId).toBe('attendance-admin-approval-flows')
      expect(window.location.hash).toBe('#attendance-admin-approval-flows')
    })

    it('ignores Alt+ArrowDown/ArrowUp keyboard navigation while navigation is disabled', async () => {
      const vm = mountHost({ navigationEnabled: false })
      await flushUi()

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }))
      await flushUi()

      expect(vm.adminActiveSectionId).toBe('attendance-admin-settings')
      expect(window.location.hash).toBe('')
    })

    it('does not sync the hash or nav-link scroll when the active section changes programmatically while navigation is disabled', async () => {
      const vm = mountHost({ navigationEnabled: false })
      await flushUi()
      scrollIntoViewSpy.mockClear()

      vm.adminActiveSectionId = 'attendance-admin-approval-flows'
      await flushUi()

      expect(window.location.hash).toBe('')
      const scrolledTargets = scrollIntoViewSpy.mock.instances as HTMLElement[]
      expect(scrolledTargets.some(target => target.dataset.adminAnchor === 'attendance-admin-approval-flows')).toBe(false)
    })

    it('does not re-restore the remembered section on a storage-scope change while navigation is disabled', async () => {
      // This fixture's readLastAdminSection ignores its scope argument (unlike the real
      // useAttendanceAdminRail), so the remembered id is stored under the one key it reads;
      // cross-org key isolation itself is covered by the AttendanceView.vue integration test
      // ('isolates admin rail persistence by org id' in attendance-admin-anchor-nav.spec.ts).
      window.localStorage.setItem('metasheet_attendance_admin_nav_last_section:default', 'attendance-admin-approval-flows')
      const vm = mountHost({ navigationEnabled: false })
      await flushUi()
      scrollIntoViewSpy.mockClear()

      vm.adminNavStorageScope = 'org-b'
      await flushUi()

      expect(vm.adminActiveSectionId).toBe('attendance-admin-settings')
      const scrolledTargets = scrollIntoViewSpy.mock.instances as HTMLElement[]
      expect(scrolledTargets.some(target => target.id === 'attendance-admin-approval-flows')).toBe(false)
    })
  })
})
