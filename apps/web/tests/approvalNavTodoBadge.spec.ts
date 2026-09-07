import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App as VueApp, type Component } from 'vue'

// P1b slice 1 — the app-level 待办 badge on the top-nav 审批中心 entry.
//
// The badge reuses the SERVER-OWNED pending count that 审批中心 already renders: the initial
// `getPendingCount` read plus the `approval:counts-updated` realtime push routed through
// `useApprovalCountsRealtime`. Both are mocked here so the two halves can be driven independently:
//   * the initial read proves the badge is bound to the fetched count (not a constant), and
//   * the captured `onCountsUpdated` callback proves a later push moves the rendered number.
//
// `useApprovalCountsRealtime` is mocked rather than exercised because the real composable
// deliberately opens no socket under MODE==='test' (see its onMounted) — mocking it is the only way
// to reach the callback at all, and it also keeps the badge's own contract (which bucket of the
// payload it reads) pinned.

const getPendingCountSpy = vi.fn()
vi.mock('../src/approvals/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/approvals/api')>()
  return {
    ...actual,
    getPendingCount: (...args: unknown[]) => getPendingCountSpy(...args),
  }
})

type CountsCallback = (payload: {
  count: number
  unreadCount: number
  countsBySourceSystem?: Record<string, { count: number; unreadCount: number }>
}) => void

let capturedOnCountsUpdated: CountsCallback | null = null
vi.mock('../src/approvals/useApprovalCountsRealtime', () => ({
  useApprovalCountsRealtime: (options: { onCountsUpdated: CountsCallback }) => {
    capturedOnCountsUpdated = options.onCountsUpdated
    return { reconnect: vi.fn(), disconnect: vi.fn() }
  },
}))

const mocks = vi.hoisted(() => ({
  permissions: ['approvals:read'] as string[],
  isZh: true,
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/multitable', fullPath: '/multitable', meta: { requiresAuth: true } }),
}))

vi.mock('../src/composables/usePlugins', () => ({
  usePlugins: () => ({ navItems: ref([]), fetchPlugins: vi.fn().mockResolvedValue(undefined) }),
}))

vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    loadProductFeatures: vi.fn().mockResolvedValue(undefined),
    isAttendanceFocused: () => false,
    isPlmWorkbenchFocused: () => false,
    hasFeature: () => false,
  }),
}))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: ref(mocks.isZh ? 'zh-CN' : 'en'),
    isZh: ref(mocks.isZh),
    setLocale: vi.fn(),
  }),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    clearToken: vi.fn(),
    getAccessSnapshot: () => ({
      email: 'approver@test.local',
      roles: ['approval_viewer'],
      permissions: mocks.permissions,
      isAdmin: false,
    }),
    getToken: () => 'session-token',
    hasPermission: (permission: string) => mocks.permissions.includes(permission),
  }),
}))

vi.mock('../src/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/api')>()
  return { ...actual, getApiBase: () => 'http://example.test' }
})

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('app-level approval todo badge', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    mocks.permissions = ['approvals:read']
    mocks.isZh = true
    capturedOnCountsUpdated = null
    getPendingCountSpy.mockReset()
    getPendingCountSpy.mockResolvedValue({ count: 0, unreadCount: 0 })
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.clearAllMocks()
  })

  async function mountApp(): Promise<HTMLElement> {
    const { default: App } = await import('../src/App.vue')
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(App as Component)
    app.component('router-view', { render: () => h('div') })
    app.component('router-link', {
      props: ['to'],
      render() {
        return h('a', { href: this.$props.to }, this.$slots.default ? this.$slots.default() : [])
      },
    })
    app.mount(container)
    await flushUi()
    return container
  }

  function badgeOf(root: HTMLElement): HTMLElement | null {
    return root.querySelector('[data-testid="approval-todo-badge"]')
  }

  it('renders the fetched pending count beside the 审批中心 nav entry', async () => {
    getPendingCountSpy.mockResolvedValue({ count: 7, unreadCount: 2 })
    const root = await mountApp()

    expect(getPendingCountSpy).toHaveBeenCalledWith('all')
    const badge = badgeOf(root)
    expect(badge).toBeTruthy()
    // The badge is the TOTAL 待办 count (the figure 审批中心 shows beside 待办), not the 未读 count.
    expect(badge?.textContent?.trim()).toBe('7')
  })

  it('leaves the nav link text itself untouched (the badge is a sibling, not a child)', async () => {
    getPendingCountSpy.mockResolvedValue({ count: 7, unreadCount: 2 })
    const root = await mountApp()

    const link = Array.from(root.querySelectorAll('a')).find((a) => a.getAttribute('href') === '/approvals')
    expect(link).toBeTruthy()
    expect(link!.textContent?.trim()).toBe('审批中心')
    expect(link!.querySelector('[data-testid="approval-todo-badge"]')).toBeNull()
  })

  it('groups the badge with its own nav link in ONE flex item, not as a peer nav entry', async () => {
    getPendingCountSpy.mockResolvedValue({ count: 7, unreadCount: 2 })
    const root = await mountApp()

    const badge = badgeOf(root)!
    const group = badge.parentElement!
    expect(group.className).toContain('nav-approvals')
    // `.nav-links` puts its gap BETWEEN flex items; the badge must share one item with its label,
    // and that item must contain no other nav link.
    const linksInGroup = Array.from(group.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(linksInGroup).toEqual(['/approvals'])
    expect(group.parentElement?.className).toContain('nav-links')
  })

  it('updates from the realtime counts composable without any further fetch', async () => {
    getPendingCountSpy.mockResolvedValue({ count: 1, unreadCount: 1 })
    const root = await mountApp()
    expect(badgeOf(root)?.textContent?.trim()).toBe('1')

    const fetchCallsBefore = getPendingCountSpy.mock.calls.length
    expect(capturedOnCountsUpdated).toBeTypeOf('function')
    capturedOnCountsUpdated!({ count: 4, unreadCount: 3 })
    await flushUi()

    expect(badgeOf(root)?.textContent?.trim()).toBe('4')
    // No-auto-reload discipline: a push moves the number and triggers no additional read.
    expect(getPendingCountSpy.mock.calls.length).toBe(fetchCallsBefore)
  })

  it('prefers the "all" bucket of a per-source realtime payload', async () => {
    const root = await mountApp()
    capturedOnCountsUpdated!({
      count: 99,
      unreadCount: 99,
      countsBySourceSystem: {
        all: { count: 5, unreadCount: 1 },
        platform: { count: 2, unreadCount: 0 },
      },
    })
    await flushUi()

    expect(badgeOf(root)?.textContent?.trim()).toBe('5')
  })

  it('hides the badge when there is nothing pending', async () => {
    getPendingCountSpy.mockResolvedValue({ count: 0, unreadCount: 0 })
    const root = await mountApp()
    expect(badgeOf(root)).toBeNull()
  })

  it('hides the badge when the count read fails (no invented figure in the shell chrome)', async () => {
    getPendingCountSpy.mockRejectedValue(new Error('unavailable'))
    const root = await mountApp()
    expect(badgeOf(root)).toBeNull()
  })

  it('caps the rendered figure at 99+', async () => {
    getPendingCountSpy.mockResolvedValue({ count: 1200, unreadCount: 3 })
    const root = await mountApp()
    expect(badgeOf(root)?.textContent?.trim()).toBe('99+')
  })

  it('carries a values-free label in zh and en', async () => {
    getPendingCountSpy.mockResolvedValue({ count: 3, unreadCount: 1 })

    let root = await mountApp()
    expect(badgeOf(root)?.getAttribute('aria-label')).toBe('待办审批')
    if (app) app.unmount()
    app = null
    container?.remove()
    container = null

    mocks.isZh = false
    root = await mountApp()
    expect(badgeOf(root)?.getAttribute('aria-label')).toBe('Pending approvals')
    // The badge text is the count alone — the label never carries row content.
    expect(badgeOf(root)?.textContent?.trim()).toBe('3')
  })

  it('renders no badge (and reads no count) for a principal without approvals:read', async () => {
    mocks.permissions = []
    getPendingCountSpy.mockResolvedValue({ count: 7, unreadCount: 7 })
    const root = await mountApp()

    expect(badgeOf(root)).toBeNull()
    expect(getPendingCountSpy).not.toHaveBeenCalled()
  })
})
