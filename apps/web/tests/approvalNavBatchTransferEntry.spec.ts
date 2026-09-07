import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App as VueApp, type Component } from 'vue'

// P1b round 2, item (1) — the 批量转交 nav entry's gate.
//
// The page's route/nav gate was `getAccessSnapshot().isAdmin`: JWT/localStorage roles containing
// `admin`, or any of `*:*` / `admin:all` / `users:write` / `roles:write` / `permissions:write`. The
// approval LIST SCOPE's admin arm is a different predicate entirely —
// `users.is_active AND (is_admin OR role = 'admin')`, read from the database. A principal admitted
// by the first but not the second reached the page and was served a SUBSET of the picked approver's
// queue, which the page then described as empty.
//
// The gate is now CONJUNCTIVE, and these tests pin both halves:
//   * the token gate still decides whether the shell issues the capability read at all (an ordinary
//     user's shell must not make an admin-shaped request), and
//   * the SERVER's own answer decides whether the entry renders.
// Any answer other than `granted` — including "could not determine" — hides the entry.

const capabilitySpy = vi.fn()
vi.mock('../src/approvals/adminCapability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/approvals/adminCapability')>()
  return { ...actual, resolveApprovalAdminCapability: (...args: unknown[]) => capabilitySpy(...args) }
})

const mocks = vi.hoisted(() => ({
  permissions: ['approvals:read'] as string[],
  isAdmin: true,
  isZh: true,
  routePath: '/multitable',
  routeMeta: { requiresAuth: true } as Record<string, unknown>,
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ path: mocks.routePath, fullPath: mocks.routePath, meta: mocks.routeMeta }),
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
      email: 'admin@test.local',
      roles: mocks.isAdmin ? ['admin'] : ['approval_viewer'],
      permissions: mocks.permissions,
      isAdmin: mocks.isAdmin,
    }),
    getToken: () => 'session-token',
    hasPermission: (permission: string) => mocks.permissions.includes(permission),
  }),
}))

vi.mock('../src/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/api')>()
  return { ...actual, getApiBase: () => 'http://example.test' }
})

// The sibling nav badge shares this shell; keep its network read out of these mounts.
vi.mock('../src/approvals/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/approvals/api')>()
  return { ...actual, getPendingCount: vi.fn().mockResolvedValue({ count: 0, unreadCount: 0 }) }
})

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('批量转交 nav entry gate', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    mocks.permissions = ['approvals:read']
    mocks.isAdmin = true
    mocks.isZh = true
    mocks.routePath = '/multitable'
    mocks.routeMeta = { requiresAuth: true }
    capabilitySpy.mockReset().mockResolvedValue('granted')
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

  function entryOf(root: HTMLElement): HTMLAnchorElement | null {
    return root.querySelector('[data-testid="nav-approval-batch-transfer"]')
  }

  it('renders for a principal the SERVER confirms is an approval administrator', async () => {
    const root = await mountApp()

    expect(capabilitySpy).toHaveBeenCalledTimes(1)
    const entry = entryOf(root)
    expect(entry).toBeTruthy()
    expect(entry!.getAttribute('href')).toBe('/approvals/batch-transfer')
  })

  it('carries the zh and en labels', async () => {
    let root = await mountApp()
    expect(entryOf(root)?.textContent?.trim()).toBe('批量转交')
    if (app) app.unmount()
    app = null
    container?.remove()
    container = null

    mocks.isZh = false
    root = await mountApp()
    expect(entryOf(root)?.textContent?.trim()).toBe('Batch Transfer')
  })

  it('is ABSENT when the server says the caller is not an approval administrator', async () => {
    capabilitySpy.mockResolvedValue('denied')
    const root = await mountApp()

    expect(entryOf(root)).toBeNull()
    // The rest of the admin block is untouched — this narrows one entry, not the nav.
    const hrefs = Array.from(root.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(hrefs).toContain('/approvals/metrics')
  })

  it('is ABSENT when the server could not confirm (an entry to a page that cannot answer is worse than none)', async () => {
    capabilitySpy.mockResolvedValue('unavailable')
    const root = await mountApp()
    expect(entryOf(root)).toBeNull()
  })

  it('is absent while the answer is still in flight', async () => {
    let release: ((value: string) => void) | null = null
    capabilitySpy.mockReturnValue(new Promise<string>((resolve) => { release = resolve }))
    const root = await mountApp()
    expect(entryOf(root)).toBeNull()

    release!('granted')
    await flushUi()
    expect(entryOf(root)).toBeTruthy()
  })

  it('an ordinary user’s shell never issues the capability read at all', async () => {
    mocks.isAdmin = false
    const root = await mountApp()

    expect(entryOf(root)).toBeNull()
    expect(capabilitySpy).not.toHaveBeenCalled()
    // Positive control: this principal's shell DID render, and still shows the approvals link.
    const hrefs = Array.from(root.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(hrefs).toContain('/approvals')
    expect(hrefs).not.toContain('/approvals/metrics')
  })

  it('issues no capability read on a public route', async () => {
    mocks.routePath = '/public-thing'
    mocks.routeMeta = { requiresAuth: false }
    const root = await mountApp()

    expect(capabilitySpy).not.toHaveBeenCalled()
    expect(entryOf(root)).toBeNull()
  })

  it('a THROWING entry component leaves the rest of the nav rendered (ShellChromeBoundary)', async () => {
    const throwingSetup = vi.fn(() => { throw new Error('nav entry exploded') })
    vi.resetModules()
    vi.doMock('../src/approvals/components/ApprovalBatchTransferNavEntry.vue', async () => {
      const { defineComponent } = await import('vue')
      return { default: defineComponent({ name: 'ApprovalBatchTransferNavEntry', props: { label: String }, setup: throwingSetup }) }
    })
    try {
      const root = await mountApp()
      expect(throwingSetup).toHaveBeenCalled()
      const hrefs = Array.from(root.querySelectorAll('a')).map((a) => a.getAttribute('href'))
      expect(hrefs).toContain('/approvals')
      expect(hrefs).toContain('/approvals/metrics')
      expect(hrefs).toContain('/settings')
      expect(entryOf(root)).toBeNull()
    } finally {
      vi.doUnmock('../src/approvals/components/ApprovalBatchTransferNavEntry.vue')
      vi.resetModules()
    }
  })

  it('the route it points at is still the requiresAdmin one (the token gate is NOT removed)', async () => {
    const { appRoutes } = await import('../src/router/appRoutes')
    const route = appRoutes.find((r) => r.path === '/approvals/batch-transfer')
    expect(route?.meta?.requiresAuth).toBe(true)
    // Conjunctive, not replaced: the server capability narrows the entry; the existing
    // token-derived route guard still keeps a non-admin off the route entirely.
    expect(route?.meta?.requiresAdmin).toBe(true)
  })
})
