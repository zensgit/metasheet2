import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App as VueApp, type Component } from 'vue'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
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
      expect.objectContaining({ href: '/approvals', text: '审批中心' }),
    ]))
    expect(links.some((link) => link.href === '/plm')).toBe(false)
    expect(links.some((link) => link.href === '/plm/audit')).toBe(false)
  })

  it('keeps a dedicated approvals route in the platform shell', async () => {
    const source = await readFile(resolve(process.cwd(), 'src/router/appRoutes.ts'), 'utf8')

    expect(source).toContain("path: '/approvals'")
    expect(source).toContain("import('../views/ApprovalInboxView.vue')")
    expect(source).toContain("titleZh: '审批中心'")
  })
})
