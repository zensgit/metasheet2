import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App as VueApp, type Component } from 'vue'

// P1b slice 2 — the SELF-SERVICE /my-delegation entry.
//
// The route has existed and been requiresAuth-only for a while, but the only control in the app
// that mentioned delegation at all was TemplateCenterView's 委托管理 button: gated on
// `approval-templates:manage` and pointing at the ADMIN surface `/approval-delegations`. A
// non-admin approver could reach their own delegation page only by typing the URL. These tests pin
// (a) that a NON-ADMIN now gets an entry, (b) that it points at `/my-delegation`, and (c) that the
// admin button is unchanged — a fix that quietly relaxed the admin surface's own gate would be a
// different, worse change.

const mocks = vi.hoisted(() => ({
  permissions: ['approvals:read'] as string[],
  isAdmin: false,
  isZh: true,
  token: 'session-token' as string | null,
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
      roles: mocks.isAdmin ? ['admin'] : ['approval_viewer'],
      permissions: mocks.permissions,
      isAdmin: mocks.isAdmin,
    }),
    getToken: () => mocks.token,
    hasPermission: (permission: string) => mocks.permissions.includes(permission),
  }),
}))

vi.mock('../src/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/api')>()
  return { ...actual, getApiBase: () => 'http://example.test' }
})

// The nav badge from slice 1 shares this shell; keep its network read out of these mounts.
vi.mock('../src/approvals/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/approvals/api')>()
  return { ...actual, getPendingCount: vi.fn().mockResolvedValue({ count: 0, unreadCount: 0 }) }
})

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function readWebFile(rel: string): string {
  return readFileSync(join(__dirname, '..', rel), 'utf8')
}

describe('my-delegation self-service entry', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    mocks.permissions = ['approvals:read']
    mocks.isAdmin = false
    mocks.isZh = true
    mocks.token = 'session-token'
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
    return root.querySelector('[data-testid="nav-my-delegation"]')
  }

  it('is visible to a NON-ADMIN approver and links to /my-delegation', async () => {
    const root = await mountApp()

    const entry = entryOf(root)
    expect(entry).toBeTruthy()
    expect(entry!.getAttribute('href')).toBe('/my-delegation')
    // Not the admin surface — that one stays where it is, behind its own gate.
    expect(entry!.getAttribute('href')).not.toBe('/approval-delegations')
  })

  it('carries the zh and en labels', async () => {
    let root = await mountApp()
    expect(entryOf(root)?.textContent?.trim()).toBe('我的委托')
    if (app) app.unmount()
    app = null
    container?.remove()
    container = null

    mocks.isZh = false
    root = await mountApp()
    expect(entryOf(root)?.textContent?.trim()).toBe('My Delegation')
  })

  it('is reachable without any manage permission (the admin 委托管理 gate is not required)', async () => {
    mocks.permissions = ['approvals:read']
    const root = await mountApp()

    expect(entryOf(root)).toBeTruthy()
    // The principal here holds NEITHER of the gates the admin delegation surface uses.
    expect(mocks.permissions).not.toContain('approval-templates:manage')
    expect(mocks.isAdmin).toBe(false)
  })

  it('is absent for a signed-out visitor', async () => {
    mocks.token = null
    const root = await mountApp()
    expect(entryOf(root)).toBeNull()
  })

  it('is absent for a principal without approvals:read (documented narrowing)', async () => {
    mocks.permissions = []
    const root = await mountApp()
    expect(entryOf(root)).toBeNull()
    // The 审批中心 link is gated the same way, so the two stay consistent.
    const approvalsLink = Array.from(root.querySelectorAll('a')).find((a) => a.getAttribute('href') === '/approvals')
    expect(approvalsLink).toBeUndefined()
  })

  it('leaves the ADMIN delegation button in TemplateCenterView exactly as it was', () => {
    const source = readWebFile('src/views/approval/TemplateCenterView.vue')
    expect(source).toContain('data-testid="template-center-delegations-link"')
    expect(source).toContain("$router.push('/approval-delegations')")
    // Still behind canManageTemplates, and still NOT repointed at the self-service route.
    const block = source.slice(source.indexOf('data-testid="template-center-delegations-link"') - 200)
      .slice(0, 400)
    expect(block).toContain('v-if="canManageTemplates"')
    expect(source).not.toContain("$router.push('/my-delegation')")
  })

  it('the route it points at is still the requiresAuth-only self-service one', () => {
    const routes = readWebFile('src/router/appRoutes.ts')
    const block = routes.slice(routes.indexOf("path: '/my-delegation'")).slice(0, 400)
    expect(block).toContain('MyDelegationView.vue')
    expect(block).toContain('requiresAuth: true')
    // No manage permission and no admin flag was added to reach it from the new entry.
    expect(block).not.toContain('permissions:')
    expect(block).not.toContain('requiresAdmin')
  })
})
