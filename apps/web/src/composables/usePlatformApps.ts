import { computed, ref } from 'vue'
import { apiGet } from '../utils/api'

export interface PlatformAppNavItem {
  id: string
  title: string
  path: string
  icon?: string
  order?: number
  location?: 'main-nav' | 'admin' | 'hidden'
}

export interface PlatformAppInstanceSummary {
  id: string
  tenantId: string
  workspaceId: string
  appId: string
  pluginId: string
  instanceKey: string
  projectId: string
  displayName: string
  status: 'active' | 'inactive' | 'failed'
  config: Record<string, unknown>
  metadata: Record<string, unknown>
  createdAt?: string
  updatedAt?: string
}

export interface PlatformAppSummary {
  id: string
  pluginId: string
  pluginName: string
  pluginVersion?: string
  pluginDisplayName?: string
  pluginStatus: 'active' | 'inactive' | 'failed'
  pluginError?: string
  displayName: string
  runtimeModel: 'instance' | 'direct'
  boundedContext: {
    code: string
    owner?: string
    description?: string
  }
  runtimeBindings?: {
    currentPath?: string
    installPath?: string
    installPayload?: Record<string, unknown>
  }
  platformDependencies: string[]
  navigation: PlatformAppNavItem[]
  permissions: string[]
  featureFlags: string[]
  objects: Array<{ id: string; name: string; backing: string }>
  workflows: Array<{ id: string; name: string; trigger?: string }>
  integrations: Array<{ id: string; type: string; direction: string }>
  entryPath: string | null
  instance: PlatformAppInstanceSummary | null
}

export interface PlatformAppActionDescriptor {
  kind: 'open' | 'onboard' | 'recover' | 'inspect' | 'install' | 'reinstall'
  label: string
  description: string
  route: string | null
  mutation?: {
    path: string
    payload: Record<string, unknown>
  }
}

function resolveShellRoute(appId: string): string {
  return `/apps/${encodeURIComponent(appId)}`
}

export function resolvePlatformAppInstallState(app: PlatformAppSummary): string {
  if (app.runtimeModel === 'direct') {
    return 'direct'
  }
  return app.instance?.status ?? 'not-installed'
}

export function resolvePlatformAppProjectLabel(app: PlatformAppSummary): string {
  if (app.runtimeModel === 'direct') {
    return 'n/a'
  }
  return app.instance?.projectId || 'Unavailable'
}

export function resolvePlatformAppInstanceLabel(app: PlatformAppSummary): string {
  if (app.runtimeModel === 'direct') {
    return 'This app runs directly from its entry route and does not require tenant installation.'
  }
  return app.instance?.displayName || 'App instance not installed for this tenant yet.'
}

export function resolvePlatformAppPrimaryAction(app: PlatformAppSummary): PlatformAppActionDescriptor {
  if (app.pluginStatus === 'failed') {
    return {
      kind: 'inspect',
      label: 'Inspect shell',
      description: 'Plugin runtime is degraded. Review shell state before entering the app.',
      route: resolveShellRoute(app.id),
    }
  }

  if (app.runtimeModel === 'direct') {
    return {
      kind: 'open',
      label: 'Open app',
      description: 'This app runs directly from its entry route and does not require tenant installation.',
      route: app.entryPath || resolveShellRoute(app.id),
    }
  }

  if (!app.instance) {
    if (app.runtimeBindings?.installPath) {
      return {
        kind: 'install',
        label: 'Install app',
        description: 'No tenant-scoped app instance exists yet. Open the platform shell to install it with the app-defined runtime contract.',
        route: resolveShellRoute(app.id),
        mutation: {
          path: app.runtimeBindings.installPath,
          payload: { ...(app.runtimeBindings.installPayload || {}) },
        },
      }
    }
    return {
      kind: 'onboard',
      label: 'Open onboarding',
      description: 'No tenant-scoped app instance exists yet. Enter the app to initialize it.',
      route: app.entryPath || resolveShellRoute(app.id),
    }
  }

  if (app.instance.status === 'failed') {
    if (app.runtimeBindings?.installPath) {
      return {
        kind: 'reinstall',
        label: 'Reinstall app',
        description: 'The current app instance is in a failed state. Open the platform shell to reinstall it with the existing runtime contract.',
        route: resolveShellRoute(app.id),
        mutation: {
          path: app.runtimeBindings.installPath,
          payload: {
            ...(app.runtimeBindings.installPayload || {}),
            mode: 'reinstall',
          },
        },
      }
    }
    return {
      kind: 'recover',
      label: 'Open recovery',
      description: 'The current app instance is in a failed state. Enter the app to repair or reinstall it.',
      route: app.entryPath || resolveShellRoute(app.id),
    }
  }

  if (app.instance.status === 'inactive') {
    return {
      kind: 'inspect',
      label: 'Review shell',
      description: 'The app instance exists but is inactive. Review shell state before reopening runtime entry.',
      route: resolveShellRoute(app.id),
    }
  }

  return {
    kind: 'open',
    label: 'Open app',
    description: 'The app instance is active and ready for direct entry.',
    route: app.entryPath || resolveShellRoute(app.id),
  }
}

const apps = ref<PlatformAppSummary[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
let inflightList: Promise<void> | null = null

async function fetchApps(options?: { force?: boolean }): Promise<void> {
  if (!options?.force && apps.value.length > 0) {
    return
  }
  if (inflightList) {
    return inflightList
  }

  inflightList = (async () => {
    loading.value = true
    error.value = null
    try {
      const response = await apiGet<{ list?: PlatformAppSummary[] }>('/api/platform/apps')
      apps.value = Array.isArray(response?.list) ? response.list : []
    } catch (err: any) {
      error.value = err?.message || 'Failed to load platform apps'
    } finally {
      loading.value = false
    }
  })()

  try {
    await inflightList
  } finally {
    inflightList = null
  }
}

async function fetchAppById(appId: string, options?: { force?: boolean }): Promise<PlatformAppSummary | null> {
  if (!appId.trim()) return null
  const existing = apps.value.find((item) => item.id === appId)
  if (existing && !options?.force) return existing
  try {
    const app = await apiGet<PlatformAppSummary>(`/api/platform/apps/${encodeURIComponent(appId)}`)
    const next = apps.value.filter((item) => item.id !== app.id)
    next.push(app)
    apps.value = next.sort((a, b) => a.displayName.localeCompare(b.displayName))
    return app
  } catch (err: any) {
    error.value = err?.message || 'Failed to load platform app'
    return null
  }
}

export function usePlatformApps() {
  const activeApps = computed(() => apps.value.filter((item) => item.pluginStatus === 'active'))
  return {
    apps,
    activeApps,
    loading,
    error,
    fetchApps,
    fetchAppById,
  }
}
