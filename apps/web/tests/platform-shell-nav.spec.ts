import { afterEach, describe, expect, it, vi } from 'vitest'
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
    app.component('router-view', { render: () => h('div') })
    app.component('router-link', {
      props: ['to'],
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
    app.component('router-view', { render: () => h('div') })
    app.component('router-link', {
      props: ['to'],
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
    expect(links.some((link) => link.href === '/approvals')).toBe(false)
    // A3 runs view is admin-only (canManageUsers === snapshot.isAdmin) — hidden here.
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
    app.component('router-view', { render: () => h('div') })
    app.component('router-link', {
      props: ['to'],
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

    const links = Array.from(container.querySelectorAll('a')).map((node) => ({
      href: node.getAttribute('href'),
      text: node.textContent?.trim(),
    }))
    expect(links).toEqual(expect.arrayContaining([
      expect.objectContaining({ href: '/admin/automation-executions', text: '自动化运行' }),
    ]))
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
})
