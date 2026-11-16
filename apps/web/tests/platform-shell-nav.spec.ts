/* eslint-disable vue/one-component-per-file -- Tests mount isolated apps with local component stubs. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveRouteGuardDecision, type RouteGuardPolicyContext } from '../src/router/guardPolicy'
import { createApp, h, nextTick, ref, type App as VueApp, type Component } from 'vue'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function resolveWebFile(relativePath: string): string {
  const candidates = [
    resolve(process.cwd(), relativePath),
    resolve(process.cwd(), 'apps/web', relativePath),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

describe('platform shell navigation', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.restoreAllMocks()
    vi.resetModules()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('shows attendance navigation and hides PLM links when attendance is enabled but PLM is disabled', async () => {
    vi.doMock('vue-router', () => ({
      useRoute: () => ({
        path: '/grid',
        fullPath: '/grid',
        meta: { requiresAuth: true },
      }),
    }))

    vi.doMock('../src/composables/usePlugins', () => ({
      usePlugins: () => ({
        navItems: ref([]),
        fetchPlugins: vi.fn().mockResolvedValue(undefined),
      }),
    }))

    vi.doMock('../src/stores/featureFlags', () => ({
      useFeatureFlags: () => ({
        resolveHomePath: () => '/home', // App.vue brand link (#5700) reads it; the brand target itself is pinned in App.spec.ts
        loadProductFeatures: vi.fn().mockResolvedValue(undefined),
        isAttendanceFocused: () => false,
        isPlmWorkbenchFocused: () => false,
        hasFeature: (feature: string) => feature === 'attendance',
      }),
    }))

    vi.doMock('../src/composables/useLocale', () => ({
      useLocale: () => ({
        locale: ref('zh-CN'),
        isZh: ref(true),
        setLocale: vi.fn(),
      }),
    }))

    vi.doMock('../src/composables/useAuth', () => ({
      useAuth: () => ({
        clearToken: vi.fn(),
        getAccessSnapshot: () => ({
          email: 'employee@test.local',
          roles: ['attendance_employee'],
          permissions: ['attendance:read', 'attendance:write'],
          isAdmin: false,
        }),
        getToken: () => 'session-token',
        hasPermission: () => false,
      }),
    }))

    vi.doMock('../src/utils/api', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/utils/api')>()
      return {
        ...actual,
        getApiBase: () => 'http://example.test',
      }
    })

    const { default: App } = await import('../src/App.vue')

    container = document.createElement('div')
    document.body.appendChild(container)

    app = createApp(App as Component)
    app.component('RouterView', { render: () => h('div') })
    app.component('RouterLink', {
      props: { to: { type: [String, Object], default: '' } },
      render() {
        return h('a', { href: this.$props.to }, this.$slots.default ? this.$slots.default() : [])
      },
    })

    app.mount(container)
    await flushUi()

    const links = Array.from(container.querySelectorAll('a')).map((node) => ({
      href: node.getAttribute('href'),
      text: node.textContent?.trim(),
    }))

    expect(links).toEqual(expect.arrayContaining([
      expect.objectContaining({ href: '/attendance', text: '考勤' }),
      expect.objectContaining({ href: '/multitable', text: '多维表' }),
    ]))
    expect(links.some((link) => link.href === '/approvals')).toBe(false)
    expect(links.some((link) => link.href === '/grid')).toBe(false)
    expect(links.some((link) => link.href === '/spreadsheets')).toBe(false)
    expect(links.some((link) => link.href === '/kanban')).toBe(false)
    expect(links.some((link) => link.href === '/calendar')).toBe(false)
    expect(links.some((link) => link.href === '/gallery')).toBe(false)
    expect(links.some((link) => link.href === '/form')).toBe(false)
    expect(links.some((link) => link.href === '/plm')).toBe(false)
    expect(links.some((link) => link.href === '/plm/audit')).toBe(false)
    expect(links.some((link) => link.href === '/integrations/k3-wise')).toBe(false)
  })

  it('shows data factory navigation for integration write permission without attendance admin', async () => {
    vi.doMock('vue-router', () => ({
      useRoute: () => ({
        path: '/grid',
        fullPath: '/grid',
        meta: { requiresAuth: true },
      }),
    }))

    vi.doMock('../src/composables/usePlugins', () => ({
      usePlugins: () => ({
        navItems: ref([]),
        fetchPlugins: vi.fn().mockResolvedValue(undefined),
      }),
    }))

    vi.doMock('../src/stores/featureFlags', () => ({
      useFeatureFlags: () => ({
        resolveHomePath: () => '/home', // App.vue brand link (#5700) reads it; the brand target itself is pinned in App.spec.ts
        loadProductFeatures: vi.fn().mockResolvedValue(undefined),
        isAttendanceFocused: () => false,
        isPlmWorkbenchFocused: () => false,
        hasFeature: (feature: string) => feature === 'plm',
      }),
    }))

    vi.doMock('../src/composables/useLocale', () => ({
      useLocale: () => ({
        locale: ref('zh-CN'),
        isZh: ref(true),
        setLocale: vi.fn(),
      }),
    }))

    vi.doMock('../src/composables/useAuth', () => ({
      useAuth: () => ({
        clearToken: vi.fn(),
        getAccessSnapshot: () => ({
          email: 'integrator@test.local',
          roles: ['integration_operator'],
          permissions: ['integration:write'],
          isAdmin: false,
        }),
        getToken: () => 'session-token',
        hasPermission: (permission: string) => permission === 'integration:read' || permission === 'integration:write',
      }),
    }))

    vi.doMock('../src/utils/api', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/utils/api')>()
      return {
        ...actual,
        getApiBase: () => 'http://example.test',
      }
    })

    const { default: App } = await import('../src/App.vue')

    container = document.createElement('div')
    document.body.appendChild(container)

    app = createApp(App as Component)
    app.component('RouterView', { render: () => h('div') })
    app.component('RouterLink', {
      props: { to: { type: [String, Object], default: '' } },
      render() {
        return h('a', { href: this.$props.to }, this.$slots.default ? this.$slots.default() : [])
      },
    })

    app.mount(container)
    await flushUi()

    const links = Array.from(container.querySelectorAll('a')).map((node) => ({
      href: node.getAttribute('href'),
      text: node.textContent?.trim(),
    }))

    expect(links).toEqual(expect.arrayContaining([
      expect.objectContaining({ href: '/multitable', text: '多维表' }),
      expect.objectContaining({ href: '/integrations/workbench', text: '数据工厂' }),
    ]))
    expect(links.some((link) => link.href === '/grid')).toBe(false)
    expect(links.some((link) => link.href === '/spreadsheets')).toBe(false)
    expect(links.some((link) => link.href === '/kanban')).toBe(false)
    expect(links.some((link) => link.href === '/calendar')).toBe(false)
    expect(links.some((link) => link.href === '/gallery')).toBe(false)
    expect(links.some((link) => link.href === '/form')).toBe(false)
    expect(links.some((link) => link.href === '/admin/users')).toBe(false)
    expect(links.some((link) => link.href === '/admin/role-delegation')).toBe(false)
    expect(links.some((link) => link.href === '/admin/permissions')).toBe(false)
    expect(container?.textContent).not.toContain('组织与权限')
    expect(links.some((link) => link.href === '/approvals')).toBe(false)
    // Platform-admin entries stay hidden until the capability endpoint grants them.
    expect(links.some((link) => link.href === '/admin/automation-executions')).toBe(false)
  })

  it('shows the approval center nav entry only when approval read permission is present', async () => {
    vi.doMock('vue-router', () => ({
      useRoute: () => ({ path: '/multitable', fullPath: '/multitable', meta: { requiresAuth: true } }),
    }))
    vi.doMock('../src/composables/usePlugins', () => ({
      usePlugins: () => ({ navItems: ref([]), fetchPlugins: vi.fn().mockResolvedValue(undefined) }),
    }))
    vi.doMock('../src/stores/featureFlags', () => ({
      useFeatureFlags: () => ({
        resolveHomePath: () => '/home', // App.vue brand link (#5700) reads it; the brand target itself is pinned in App.spec.ts
        loadProductFeatures: vi.fn().mockResolvedValue(undefined),
        isAttendanceFocused: () => false,
        isPlmWorkbenchFocused: () => false,
        hasFeature: () => false,
      }),
    }))
    vi.doMock('../src/composables/useLocale', () => ({
      useLocale: () => ({ locale: ref('zh-CN'), isZh: ref(true), setLocale: vi.fn() }),
    }))
    vi.doMock('../src/composables/useAuth', () => ({
      useAuth: () => ({
        clearToken: vi.fn(),
        getAccessSnapshot: () => ({
          email: 'approver@test.local',
          roles: ['approval_viewer'],
          permissions: ['approvals:read'],
          isAdmin: false,
        }),
        getToken: () => 'session-token',
        hasPermission: (permission: string) => permission === 'approvals:read',
      }),
    }))
    vi.doMock('../src/utils/api', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/utils/api')>()
      return {
        ...actual,
        getApiBase: () => 'http://example.test',
      }
    })

    const { default: App } = await import('../src/App.vue')
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(App as Component)
    app.component('RouterView', { render: () => h('div') })
    app.component('RouterLink', {
      props: { to: { type: [String, Object], default: '' } },
      render() {
        return h('a', { href: this.$props.to }, this.$slots.default ? this.$slots.default() : [])
      },
    })

    app.mount(container)
    await flushUi()

    const links = Array.from(container.querySelectorAll('a')).map((node) => ({
      href: node.getAttribute('href'),
      text: node.textContent?.trim(),
    }))
    expect(links).toEqual(expect.arrayContaining([
      expect.objectContaining({ href: '/approvals', text: '审批中心' }),
    ]))
  })

  it('shows the automation runs admin nav entry for an admin user', async () => {
    vi.doMock('vue-router', () => ({
      useRoute: () => ({ path: '/grid', fullPath: '/grid', meta: { requiresAuth: true } }),
    }))
    vi.doMock('../src/composables/usePlugins', () => ({
      usePlugins: () => ({ navItems: ref([]), fetchPlugins: vi.fn().mockResolvedValue(undefined) }),
    }))
    vi.doMock('../src/stores/featureFlags', () => ({
      useFeatureFlags: () => ({
        resolveHomePath: () => '/home', // App.vue brand link (#5700) reads it; the brand target itself is pinned in App.spec.ts
        loadProductFeatures: vi.fn().mockResolvedValue(undefined),
        isAttendanceFocused: () => false,
        isPlmWorkbenchFocused: () => false,
        hasFeature: () => false,
      }),
    }))
    vi.doMock('../src/composables/useLocale', () => ({
      useLocale: () => ({ locale: ref('zh-CN'), isZh: ref(true), setLocale: vi.fn() }),
    }))
    vi.doMock('../src/composables/useAuth', () => ({
      useAuth: () => ({
        clearToken: vi.fn(),
        getAccessSnapshot: () => ({
          email: 'admin@test.local',
          roles: ['admin'],
          permissions: ['*:*'],
          isAdmin: true,
        }),
        getToken: () => 'session-token',
        hasPermission: () => true,
      }),
    }))
    vi.doMock('../src/utils/api', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/utils/api')>()
      return { ...actual, getApiBase: () => 'http://example.test' }
    })

    const { publishAdminAccessCapabilities } = await import('../src/composables/adminAccessCapabilities')
    publishAdminAccessCapabilities({ isPlatformAdmin: true, canManageScope: false, delegableNamespaces: [] })
    const { default: App } = await import('../src/App.vue')
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(App as Component)
    app.component('RouterView', { render: () => h('div') })
    app.component('RouterLink', {
      props: { to: { type: [String, Object], default: '' } },
      render() {
        return h('a', { href: this.$props.to }, this.$slots.default ? this.$slots.default() : [])
      },
    })
    app.mount(container)
    await flushUi()

    const links = Array.from(container.querySelectorAll('a')).map((node) => ({
      href: node.getAttribute('href'),
      text: node.textContent?.trim(),
    }))
    expect(links).toEqual(expect.arrayContaining([
      expect.objectContaining({ href: '/admin/automation-executions', text: '自动化运行' }),
    ]))
  })

  it.each([true, false])('hides organization navigation while the capability is unknown (%s snapshot)', async (isAdmin) => {
    vi.doMock('vue-router', () => ({
      useRoute: () => ({ path: '/grid', fullPath: '/grid', meta: { requiresAuth: true } }),
    }))
    vi.doMock('../src/composables/usePlugins', () => ({
      usePlugins: () => ({ navItems: ref([]), fetchPlugins: vi.fn().mockResolvedValue(undefined) }),
    }))
    vi.doMock('../src/stores/featureFlags', () => ({
      useFeatureFlags: () => ({
        resolveHomePath: () => '/home',
        loadProductFeatures: vi.fn().mockResolvedValue(undefined),
        isAttendanceFocused: () => false,
        isPlmWorkbenchFocused: () => false,
        hasFeature: () => false,
      }),
    }))
    vi.doMock('../src/composables/useLocale', () => ({
      useLocale: () => ({ locale: ref('zh-CN'), isZh: ref(true), setLocale: vi.fn() }),
    }))
    vi.doMock('../src/composables/useAuth', () => ({
      useAuth: () => ({
        clearToken: vi.fn(),
        getAccessSnapshot: () => ({
          email: 'admin@test.local',
          roles: isAdmin ? ['admin'] : [],
          permissions: isAdmin ? ['*:*'] : [],
          isAdmin,
        }),
        getToken: () => 'session-token',
        hasPermission: () => isAdmin,
      }),
    }))
    vi.doMock('../src/utils/api', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/utils/api')>()
      return { ...actual, getApiBase: () => 'http://example.test' }
    })

    const { default: App } = await import('../src/App.vue')
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(App as Component)
    app.component('RouterView', { render: () => h('div') })
    app.component('RouterLink', {
      props: { to: { type: [String, Object], default: '' } },
      render() {
        return h('a', { href: this.$props.to }, this.$slots.default ? this.$slots.default() : [])
      },
    })
    app.mount(container)
    await flushUi()

    const group = container.querySelector('[data-testid="nav-org-permissions"]')
    expect(group).toBeNull()
    expect(container.querySelector('a[href="/admin/users"]')).toBeNull()
    expect(container.querySelector('a[href="/admin/role-delegation"]')).toBeNull()
    expect(container.querySelector('a[href="/admin/audit"]')).toBeNull()
    expect(container.querySelector('a[href="/admin/automation-executions"]')).toBeNull()

    const appSource = await readFile(resolveWebFile('src/App.vue'), 'utf8')
    const routes = await readFile(resolveWebFile('src/router/appRoutes.ts'), 'utf8')
    const delegation = routes.slice(routes.indexOf("path: '/admin/role-delegation'"), routes.indexOf("path: '/admin/directory'"))
    expect(delegation).toContain("title: 'Management Scope'")
    expect(delegation).toContain("titleZh: '管理范围'")
    expect(delegation).toContain('requiresAuth: true')
    expect(delegation).not.toContain('requiresAdmin')
    expect(delegation).not.toContain('permissions:')
    expect(routes).toContain("path: '/admin/users'")
    expect(routes).toContain('requiresAdmin: true')
    expect(appSource).toContain('v-if="canManageUsers"')
    expect(appSource).not.toContain('role-delegation:')
  })

  it('keeps platform shell nav labels from wrapping vertically on desktop', async () => {
    const source = await readFile(resolveWebFile('src/App.vue'), 'utf8')
    const style = source.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? ''
    const navLinksRule = style.match(/\.nav-links\s*\{([^}]+)\}/)?.[1] ?? ''
    const navLinkRule = style.match(/\.nav-link\s*\{([^}]+)\}/)?.[1] ?? ''
    const navUserRule = style.match(/\.nav-user\s*\{([^}]+)\}/)?.[1] ?? ''

    expect(navLinksRule).toMatch(/flex:\s*1 1 auto/)
    expect(navLinksRule).toMatch(/min-width:\s*0/)
    expect(navLinksRule).toMatch(/overflow-x:\s*auto/)
    expect(navLinkRule).toMatch(/flex:\s*0 0 auto/)
    expect(navLinkRule).toMatch(/white-space:\s*nowrap/)
    expect(navUserRule).toMatch(/text-overflow:\s*ellipsis/)
    expect(navUserRule).toMatch(/white-space:\s*nowrap/)
  })

  it('marks legacy table/view routes as deprecated while keeping deep links registered', async () => {
    const source = await readFile(resolveWebFile('src/router/appRoutes.ts'), 'utf8')
    const deprecatedPaths = ['/kanban', '/calendar', '/gallery', '/form']

    for (const path of deprecatedPaths) {
      const routePattern = new RegExp(
        `path:\\s*'${path.replace('/', '\\/')}'[\\s\\S]*?meta:\\s*\\{[^}]*requiresAuth:\\s*true[^}]*deprecated:\\s*true`,
      )
      expect(source, `Expected ${path} route to remain registered and deprecated`).toMatch(routePattern)
    }
  })

  it('redirects /grid to /multitable as part of Grid retirement (Phase B)', async () => {
    const source = await readFile(resolveWebFile('src/router/appRoutes.ts'), 'utf8')
    const gridRedirectPattern = /path:\s*'\/grid'[\s\S]*?redirect:\s*'\/multitable'[\s\S]*?deprecated:\s*true/
    expect(source, 'Expected /grid to redirect to /multitable with deprecated meta').toMatch(gridRedirectPattern)
    // GridView.vue and its formula engine have been removed; the route must not import them
    expect(source).not.toContain("import GridView from '../views/GridView.vue'")
  })

  it('keeps a dedicated approvals route in the platform shell', async () => {
    const source = await readFile(resolveWebFile('src/router/appRoutes.ts'), 'utf8')

    expect(source).toContain("path: '/approvals'")
    expect(source).toContain("import('../views/approval/ApprovalCenterView.vue')")
    expect(source).toContain("titleZh: '审批中心'")
    expect(source).toContain("permissions: ['approvals:read']")
    expect(source).toContain("path: '/p/plugin-attendance/attendance'")
    expect(source).toContain("redirect: '/attendance'")
  })

  async function mountCapabilityShell(options: {
    attendanceFocused?: boolean
    plmFocused?: boolean
    snapshotAdmin?: boolean
    permissions?: string[]
    capabilities: { isPlatformAdmin: boolean; canManageScope: boolean; canManagePermissions?: boolean; delegableNamespaces: string[] } | null
  }): Promise<void> {
    vi.resetModules()
    const path = options.attendanceFocused ? '/attendance' : options.plmFocused ? '/plm' : '/grid'
    vi.doMock('vue-router', () => ({
      useRoute: () => ({ path, fullPath: path, meta: { requiresAuth: true } }),
    }))
    vi.doMock('../src/composables/usePlugins', () => ({
      usePlugins: () => ({ navItems: ref([]), fetchPlugins: vi.fn().mockResolvedValue(undefined) }),
    }))
    vi.doMock('../src/stores/featureFlags', () => ({
      useFeatureFlags: () => ({
        resolveHomePath: () => '/home',
        loadProductFeatures: vi.fn().mockResolvedValue(undefined),
        isAttendanceFocused: () => options.attendanceFocused === true,
        isPlmWorkbenchFocused: () => options.plmFocused === true,
        hasFeature: () => false,
      }),
    }))
    vi.doMock('../src/composables/useLocale', () => ({
      useLocale: () => ({ locale: ref('zh-CN'), isZh: ref(true), setLocale: vi.fn() }),
    }))
    vi.doMock('../src/composables/useAuth', () => ({
      useAuth: () => ({
        clearToken: vi.fn(),
        getAccessSnapshot: () => ({
          email: 'person@test.local',
          roles: options.snapshotAdmin ? ['admin'] : [],
          permissions: options.permissions ?? [],
          isAdmin: options.snapshotAdmin === true,
        }),
        getToken: () => 'session-token',
        hasPermission: () => false,
      }),
    }))
    vi.doMock('../src/utils/api', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/utils/api')>()
      return { ...actual, getApiBase: () => 'http://example.test' }
    })

    const capabilities = await import('../src/composables/adminAccessCapabilities')
    if (options.capabilities) capabilities.publishAdminAccessCapabilities(options.capabilities)
    else capabilities.resetAdminAccessCapabilities()

    const { default: App } = await import('../src/App.vue')
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(App as Component)
    app.component('RouterView', { render: () => h('div') })
    app.component('RouterLink', {
      props: { to: { type: [String, Object], default: '' } },
      render() {
        return h('a', { href: this.$props.to }, this.$slots.default ? this.$slots.default() : [])
      },
    })
    app.mount(container)
    await flushUi()
  }

  function focusGuard(over: Partial<RouteGuardPolicyContext> = {}): RouteGuardPolicyContext {
    return {
      hasFeature: () => true,
      hasPermission: () => true,
      attendanceFocused: false,
      plmWorkbenchFocused: false,
      resolveHomePath: () => '/home',
      ...over,
    }
  }

  it('shows only management scope to a scope-only admin', async () => {
    await mountCapabilityShell({
      capabilities: { isPlatformAdmin: false, canManageScope: true, delegableNamespaces: ['attendance'] },
    })
    const group = container?.querySelector('[data-testid="nav-org-permissions"]')
    const links = Array.from(group?.querySelectorAll('a') || []).map((node) => ({
      href: node.getAttribute('href'),
      text: node.textContent?.trim(),
    }))
    expect(links).toEqual([{ href: '/admin/role-delegation', text: '管理范围' }])
    expect(container?.querySelector('a[href="/admin/users"]')).toBeNull()
    expect(container?.querySelector('a[href="/admin/roles"]')).toBeNull()
    expect(container?.querySelector('a[href="/admin/permissions"]')).toBeNull()
    expect(container?.querySelector('a[href="/admin/audit"]')).toBeNull()
    expect(container?.querySelector('a[href="/admin/automation-executions"]')).toBeNull()
  })

  it('shows organization navigation only after the capability endpoint grants platform admin', async () => {
    await mountCapabilityShell({
      snapshotAdmin: false,
      permissions: ['*:*', 'admin:all'],
      capabilities: { isPlatformAdmin: true, canManageScope: true, canManagePermissions: true, delegableNamespaces: [] },
    })
    const group = container?.querySelector('[data-testid="nav-org-permissions"]')
    const links = Array.from(group?.querySelectorAll('a') || []).map((node) => ({
      href: node.getAttribute('href'),
      text: node.textContent?.trim(),
    }))
    expect(links).toEqual([
      { href: '/admin/users', text: '成员与授权' },
      { href: '/admin/roles', text: '角色' },
      { href: '/admin/role-delegation', text: '管理范围' },
      { href: '/admin/permissions', text: '权限来源与例外' },
    ])
    expect(container?.querySelector('a[href="/admin/audit"]')?.textContent?.trim()).toBe('管理审计')

    const capabilities = await import('../src/composables/adminAccessCapabilities')
    capabilities.resetAdminAccessCapabilities()
    await flushUi()
    expect(container?.querySelector('[data-testid="nav-org-permissions"]')).toBeNull()
    expect(container?.querySelector('a[href="/admin/users"]')).toBeNull()
    expect(container?.querySelector('a[href="/admin/audit"]')).toBeNull()
  })

  it('hides permission-source navigation from a legacy platform admin', async () => {
    await mountCapabilityShell({
      snapshotAdmin: true,
      capabilities: { isPlatformAdmin: true, canManageScope: false, delegableNamespaces: [] },
    })
    expect(container?.querySelector('a[href="/admin/users"]')?.textContent?.trim()).toBe('成员与授权')
    expect(container?.querySelector('a[href="/admin/permissions"]')).toBeNull()
    expect(container?.querySelector('a[href="/admin/role-delegation"]')).toBeNull()
    expect(resolveRouteGuardDecision(
      { path: '/admin/permissions', meta: { requiresAdmin: true } },
      focusGuard(),
    )).toEqual({ action: 'redirect', target: '/home' })
  })

  it('drops admin links when another tab writes a new token and the route stays put', async () => {
    await mountCapabilityShell({
      snapshotAdmin: true,
      permissions: ['*:*', 'admin:all'],
      capabilities: { isPlatformAdmin: true, canManageScope: true, canManagePermissions: true, delegableNamespaces: [] },
    })
    expect(container?.querySelector('a[href="/apps"]')).toBeTruthy()
    expect(container?.querySelector('a[href="/admin/users"]')).toBeTruthy()
    expect(container?.querySelector('a[href="/admin/permissions"]')).toBeTruthy()
    expect(container?.querySelector('a[href="/admin/role-delegation"]')).toBeTruthy()

    window.dispatchEvent(new StorageEvent('storage', {
      key: 'locale',
      oldValue: null,
      newValue: 'en',
    }))
    await flushUi()
    expect(container?.querySelector('a[href="/admin/users"]')).toBeTruthy()
    expect(container?.querySelector('a[href="/admin/audit"]')).toBeTruthy()

    let release: (response: Response) => void = () => {}
    const pending = new Promise<Response>((resolve) => {
      release = resolve
    })
    vi.stubGlobal('fetch', vi.fn(() => pending))
    localStorage.setItem('jwt', 'ordinary-token')
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'jwt',
      oldValue: null,
      newValue: 'ordinary-token',
    }))
    await flushUi()
    expect(container?.querySelector('a[href="/apps"]')).toBeTruthy()
    expect(container?.querySelector('a[href="/admin/users"]')).toBeNull()
    expect(container?.querySelector('a[href="/admin/roles"]')).toBeNull()
    expect(container?.querySelector('a[href="/admin/permissions"]')).toBeNull()
    expect(container?.querySelector('a[href="/admin/role-delegation"]')).toBeNull()
    expect(container?.querySelector('a[href="/admin/audit"]')).toBeNull()

    const capabilities = await import('../src/composables/adminAccessCapabilities')
    release(new Response(JSON.stringify({
      ok: true,
      data: {
        isPlatformAdmin: false,
        canManageScope: false,
        canManagePermissions: false,
        delegableNamespaces: [],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    for (let i = 0; i < 20 && capabilities.adminAccessCapabilitiesState.loaded !== true; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(capabilities.adminAccessCapabilitiesState.loaded).toBe(true)
    expect(capabilities.adminAccessCapabilitiesState.isPlatformAdmin).toBe(false)
    expect(container?.querySelector('a[href="/apps"]')).toBeTruthy()
    expect(container?.querySelector('a[href="/admin/users"]')).toBeNull()
    expect(container?.querySelector('a[href="/admin/permissions"]')).toBeNull()
    expect(container?.querySelector('a[href="/admin/role-delegation"]')).toBeNull()
    expect(container?.querySelector('a[href="/admin/audit"]')).toBeNull()
  })

  it('drops admin links when another tab removes the token', async () => {
    localStorage.setItem('jwt', 'admin-token')
    await mountCapabilityShell({
      snapshotAdmin: true,
      permissions: ['*:*', 'admin:all'],
      capabilities: { isPlatformAdmin: true, canManageScope: true, canManagePermissions: true, delegableNamespaces: [] },
    })
    expect(container?.querySelector('a[href="/admin/users"]')).toBeTruthy()
    expect(container?.querySelector('a[href="/admin/permissions"]')).toBeTruthy()
    expect(container?.querySelector('a[href="/admin/role-delegation"]')).toBeTruthy()

    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    localStorage.removeItem('jwt')
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'jwt',
      oldValue: 'admin-token',
      newValue: null,
    }))
    await flushUi()
    expect(container?.querySelector('a[href="/apps"]')).toBeTruthy()
    expect(container?.querySelector('a[href="/admin/users"]')).toBeNull()
    expect(container?.querySelector('a[href="/admin/roles"]')).toBeNull()
    expect(container?.querySelector('a[href="/admin/permissions"]')).toBeNull()
    expect(container?.querySelector('a[href="/admin/role-delegation"]')).toBeNull()
    expect(container?.querySelector('a[href="/admin/audit"]')).toBeNull()
  })

  it('drops admin links on focus after another tab logs out', async () => {
    localStorage.setItem('jwt', 'admin-token')
    await mountCapabilityShell({
      snapshotAdmin: true,
      permissions: ['*:*', 'admin:all'],
      capabilities: { isPlatformAdmin: true, canManageScope: true, canManagePermissions: true, delegableNamespaces: [] },
    })
    expect(container?.querySelector('a[href="/admin/users"]')).toBeTruthy()
    expect(container?.querySelector('a[href="/admin/audit"]')).toBeTruthy()

    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    localStorage.removeItem('jwt')
    window.dispatchEvent(new Event('focus'))
    await flushUi()
    expect(container?.querySelector('a[href="/apps"]')).toBeTruthy()
    expect(container?.querySelector('a[href="/admin/users"]')).toBeNull()
    expect(container?.querySelector('a[href="/admin/roles"]')).toBeNull()
    expect(container?.querySelector('a[href="/admin/permissions"]')).toBeNull()
    expect(container?.querySelector('a[href="/admin/role-delegation"]')).toBeNull()
    expect(container?.querySelector('a[href="/admin/audit"]')).toBeNull()
  })

  it('hides /admin/users from a business-only user', async () => {
    await mountCapabilityShell({
      snapshotAdmin: false,
      permissions: ['attendance:read', 'attendance:write'],
      capabilities: { isPlatformAdmin: false, canManageScope: false, delegableNamespaces: [] },
    })
    expect(container?.querySelector('a[href="/admin/users"]')).toBeNull()
    expect(container?.querySelector('a[href="/admin/permissions"]')).toBeNull()
    expect(container?.querySelector('a[href="/admin/role-delegation"]')).toBeNull()
    expect(container?.querySelector('[data-testid="nav-org-permissions"]')).toBeNull()
  })

  it('hides platform admin pages from users:write even when the snapshot still says admin', async () => {
    await mountCapabilityShell({
      snapshotAdmin: true,
      permissions: ['users:write'],
      capabilities: { isPlatformAdmin: false, canManageScope: false, delegableNamespaces: [] },
    })
    expect(container?.querySelector('[data-testid="nav-org-permissions"]')).toBeNull()
    expect(container?.querySelector('a[href="/admin/users"]')).toBeNull()
    expect(container?.querySelector('a[href="/admin/role-delegation"]')).toBeNull()
    expect(container?.querySelector('a[href="/admin/audit"]')).toBeNull()
  })

  it.each([
    ['attendance', true, false],
    ['plm', false, true],
  ] as const)('exposes exact role-delegation in %s focus when scope can be managed', async (_label, attendanceFocused, plmFocused) => {
    await mountCapabilityShell({
      attendanceFocused,
      plmFocused,
      capabilities: { isPlatformAdmin: false, canManageScope: true, delegableNamespaces: ['attendance'] },
    })
    const link = container?.querySelector('[data-testid="nav-focused-management-scope"]')
    expect(link?.getAttribute('href')).toBe('/admin/role-delegation')
    expect(link?.textContent?.trim()).toBe('管理范围')
    expect(container?.querySelector('a[href="/admin/users"]')).toBeNull()
    expect(container?.querySelector('a[href="/admin/roles"]')).toBeNull()
    expect(container?.querySelector('[data-testid="nav-org-permissions"]')).toBeNull()

    const guard = focusGuard({
      attendanceFocused,
      plmWorkbenchFocused: plmFocused,
      canManageScope: true,
    })
    const home = attendanceFocused ? '/attendance' : '/plm'
    expect(resolveRouteGuardDecision({ path: '/admin/role-delegation', meta: { requiresAuth: true } }, guard))
      .toEqual({ action: 'allow' })
    expect(resolveRouteGuardDecision({ path: '/admin/users', meta: {} }, guard))
      .toEqual({ action: 'redirect', target: home })
    expect(resolveRouteGuardDecision({ path: '/admin/role-delegation/extra', meta: {} }, guard))
      .toEqual({ action: 'redirect', target: home })
  })

  it('does not show role-delegation in attendance focus without canManageScope', async () => {
    await mountCapabilityShell({
      attendanceFocused: true,
      snapshotAdmin: true,
      capabilities: { isPlatformAdmin: true, canManageScope: false, delegableNamespaces: [] },
    })
    expect(container?.querySelector('[data-testid="nav-focused-management-scope"]')).toBeNull()
    expect(container?.querySelector('a[href="/admin/users"]')).toBeNull()
    expect(resolveRouteGuardDecision(
      { path: '/admin/role-delegation', meta: {} },
      focusGuard({ attendanceFocused: true, canManageScope: false }),
    )).toEqual({ action: 'redirect', target: '/attendance' })
  })
})
