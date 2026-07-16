import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp, type Component } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import {
  setPlatformAppRuntimeInstallState,
  type PlatformAppSummary,
  usePlatformApps,
} from '../src/composables/usePlatformApps'

const apiGetMock = vi.fn()

vi.mock('vue-router', async () => {
  const vue = await import('vue')
  return {
    RouterLink: vue.defineComponent({
      props: {
        to: {
          type: [String, Object],
          required: false,
        },
      },
      setup(props, { slots }) {
        return () => vue.h('a', { href: typeof props.to === 'string' ? props.to : '#' }, slots.default ? slots.default() : [])
      },
    }),
  }
})

vi.mock('../src/utils/api', () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
}))

function createInstanceApp(overrides: Partial<PlatformAppSummary> = {}): PlatformAppSummary {
  return {
    id: 'after-sales',
    pluginId: 'plugin-after-sales',
    pluginName: 'plugin-after-sales',
    pluginVersion: '1.0.0',
    pluginDisplayName: 'After Sales Plugin',
    pluginStatus: 'active',
    pluginError: undefined,
    displayName: 'After Sales',
    runtimeModel: 'instance',
    boundedContext: {
      code: 'after-sales',
      owner: 'customer-success',
      description: 'Support ops',
    },
    runtimeBindings: {
      currentPath: '/api/after-sales/projects/current',
      installPath: '/api/after-sales/projects/install',
      installPayload: {
        templateId: 'after-sales-default',
      },
    },
    platformDependencies: ['multitable'],
    navigation: [
      {
        id: 'after-sales-home',
        title: 'After Sales',
        path: '/p/plugin-after-sales/after-sales',
        location: 'main-nav',
      },
    ],
    permissions: [],
    featureFlags: ['afterSales'],
    objects: [],
    workflows: [],
    integrations: [],
    entryPath: '/p/plugin-after-sales/after-sales',
    instance: {
      id: 'pai_1',
      tenantId: 'tenant_42',
      workspaceId: 'tenant_42',
      appId: 'after-sales',
      pluginId: 'plugin-after-sales',
      instanceKey: 'primary',
      projectId: 'tenant_42:after-sales',
      displayName: 'Acme Support',
      status: 'active',
      config: {},
      metadata: {},
    },
    ...overrides,
  }
}

function createDirectApp(overrides: Partial<PlatformAppSummary> = {}): PlatformAppSummary {
  return createInstanceApp({
    id: 'attendance',
    pluginId: 'plugin-attendance',
    pluginName: 'plugin-attendance',
    pluginDisplayName: 'Attendance Plugin',
    displayName: 'Attendance',
    runtimeModel: 'direct',
    boundedContext: {
      code: 'attendance',
      owner: 'people-ops',
      description: 'Attendance tracking, reports, import operations, and workflow-backed adjustments.',
    },
    runtimeBindings: undefined,
    platformDependencies: ['workflow'],
    entryPath: '/attendance',
    instance: null,
    ...overrides,
  })
}

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('PlatformAppLauncherView', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    setPlatformAppRuntimeInstallState('after-sales', null)
    const platformApps = usePlatformApps()
    platformApps.apps.value = []
    platformApps.error.value = null
    platformApps.loading.value = false
    useLocale().setLocale('en')
    window.localStorage.removeItem('user_roles')
    window.localStorage.removeItem('user_permissions')
    apiGetMock.mockReset()
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    setPlatformAppRuntimeInstallState('after-sales', null)
    useLocale().setLocale('en')
    window.localStorage.removeItem('user_roles')
    window.localStorage.removeItem('user_permissions')
  })

  async function mountLauncher(): Promise<void> {
    const View = (await import('../src/views/PlatformAppLauncherView.vue')).default
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(View as Component)
    app.mount(container)
    await flushUi(6)
  }

  it('marks apps as partial when the current runtime snapshot is degraded', async () => {
    apiGetMock
      .mockResolvedValueOnce({
        list: [createInstanceApp()],
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          status: 'partial',
          projectId: 'tenant_42:after-sales',
          installResult: {
            status: 'partial',
            createdObjects: ['serviceTicket'],
            createdViews: ['ticket-board'],
            warnings: ['runtime install is incomplete'],
            reportRef: 'ledger_partial',
          },
        },
      })

    await mountLauncher()

    expect(apiGetMock).toHaveBeenNthCalledWith(1, '/api/platform/apps')
    expect(apiGetMock).toHaveBeenNthCalledWith(2, '/api/after-sales/projects/current', {
      suppressUnauthorizedRedirect: true,
    })
    expect(container.querySelector<HTMLElement>('.platform-app-launcher__instance')?.dataset.state).toBe('partial')
    expect(container.textContent).toContain('Incomplete')
    expect(container.textContent).toContain('Reinstall app')
  })

  it('switches every launcher label and built-in app copy with the active locale', async () => {
    apiGetMock.mockResolvedValueOnce({ list: [createDirectApp()] })

    await mountLauncher()

    expect(container.textContent).toContain('Platform Apps')
    expect(container.textContent).toContain('App Center')
    expect(container.textContent).toContain('Attendance')
    expect(container.textContent).toContain('Direct entry')
    expect(container.textContent).toContain('Open app')
    expect(container.querySelector('.platform-app-launcher__instance')).toBeNull()
    expect(container.querySelector('.platform-app-launcher__ghost')).toBeNull()
    expect(container.querySelector('.platform-app-launcher__refresh')?.getAttribute('aria-label')).toBe('Refresh apps')

    useLocale().setLocale('zh-CN')
    await flushUi()

    expect(container.textContent).toContain('平台应用')
    expect(container.textContent).toContain('应用中心')
    expect(container.textContent).toContain('考勤')
    expect(container.textContent).toContain('考勤记录、报表、导入操作及工作流驱动的调整。')
    expect(container.textContent).toContain('直接使用')
    expect(container.textContent).toContain('打开应用')
    expect(container.textContent).toContain('从标准入口直接打开应用，无需为当前租户安装。')
    expect(container.textContent).not.toContain('Platform Apps')
    expect(container.textContent).not.toContain('Attendance tracking')
    expect(container.textContent).not.toContain('Open app')
    expect(container.querySelector('.platform-app-launcher__refresh')?.getAttribute('aria-label')).toBe('刷新应用')
  })

  it('shows shell diagnostics only to administrators and labels them as diagnostics', async () => {
    window.localStorage.setItem('user_roles', JSON.stringify(['admin']))
    apiGetMock.mockResolvedValueOnce({ list: [createDirectApp()] })

    await mountLauncher()

    const diagnosticLink = container.querySelector<HTMLAnchorElement>('.platform-app-launcher__ghost')
    expect(diagnosticLink?.textContent?.trim()).toBe('Admin diagnostics')
    expect(diagnosticLink?.getAttribute('href')).toBe('/apps/attendance')
  })

  it('renders a locale-safe error state without exposing backend fallback text', async () => {
    useLocale().setLocale('zh-CN')
    apiGetMock.mockRejectedValueOnce(new Error('Failed to load platform apps'))

    await mountLauncher()

    const alert = container.querySelector<HTMLElement>('[role="alert"]')
    expect(alert?.textContent?.trim()).toBe('应用加载失败，请重试。')
    expect(container.textContent).not.toContain('Failed to load platform apps')
  })

  it('pins readable foreground colors on light launcher surfaces', () => {
    const source = readFileSync(resolve(__dirname, '../src/views/PlatformAppLauncherView.vue'), 'utf8')

    expect(source).toMatch(/\.platform-app-launcher__card\s*\{[^}]*background:\s*#fff;[^}]*color:\s*#0f172a;/s)
    expect(source).toMatch(/\.platform-app-launcher__meta dd\s*\{[^}]*color:\s*#0f172a;/s)
    expect(source).toMatch(/\.platform-app-launcher__error,\s*\.platform-app-launcher__state\s*\{[^}]*background:\s*#fff;[^}]*color:\s*#334155;/s)
    expect(source).toMatch(/\.platform-app-launcher__primary\s*\{[^}]*background:\s*#2563eb;[^}]*color:\s*#fff;/s)
  })
})
