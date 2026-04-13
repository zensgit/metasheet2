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

export type PlatformAppRuntimeInstallState = 'not-installed' | 'installed' | 'partial' | 'failed'

const runtimeInstallStateByAppId = ref<Record<string, PlatformAppRuntimeInstallState>>({})

export function setPlatformAppRuntimeInstallState(appId: string, state: PlatformAppRuntimeInstallState | null): void {
  const next = { ...runtimeInstallStateByAppId.value }
  if (!state || state === 'installed') {
    delete next[appId]
  } else {
    next[appId] = state
  }
  runtimeInstallStateByAppId.value = next
}

function resolveRuntimeInstallState(
  app: PlatformAppSummary,
  runtimeInstallState?: PlatformAppRuntimeInstallState | null,
): PlatformAppRuntimeInstallState | 'active' | 'inactive' | 'direct' {
  if (app.runtimeModel === 'direct') {
    return 'direct'
  }

  if (runtimeInstallState && runtimeInstallState !== 'installed') {
    return runtimeInstallState
  }

  const cachedRuntimeState = runtimeInstallStateByAppId.value[app.id]
  if (cachedRuntimeState) {
    return cachedRuntimeState
  }

  const instanceInstallStatus = app.instance?.metadata?.installStatus
  if (instanceInstallStatus === 'partial' || instanceInstallStatus === 'failed' || instanceInstallStatus === 'not-installed') {
    return instanceInstallStatus
  }

  return app.instance?.status ?? 'not-installed'
}

function normalizeRuntimeInstallState(payload: unknown): PlatformAppRuntimeInstallState | null {
  const candidate = payload && typeof payload === 'object' && 'data' in (payload as Record<string, unknown>)
    ? (payload as { data?: unknown }).data
    : payload
  if (!candidate || typeof candidate !== 'object') return null

  const candidateStatus = (candidate as { status?: unknown }).status
  if (candidateStatus === 'partial' || candidateStatus === 'failed' || candidateStatus === 'not-installed') {
    return candidateStatus
  }

  const installResult = (candidate as { installResult?: unknown }).installResult
  if (!installResult || typeof installResult !== 'object') return null

  const installResultStatus = (installResult as { status?: unknown }).status
  if (installResultStatus === 'partial' || installResultStatus === 'failed' || installResultStatus === 'not-installed') {
    return installResultStatus
  }

  return null
}

async function syncRuntimeInstallStates(appList: PlatformAppSummary[]): Promise<void> {
  const currentStateRequests = appList
    .filter((app) => app.runtimeModel === 'instance' && app.runtimeBindings?.currentPath)
    .map(async (app) => {
      try {
        const response = await apiGet<unknown>(app.runtimeBindings!.currentPath!)
        setPlatformAppRuntimeInstallState(app.id, normalizeRuntimeInstallState(response))
      } catch {
        // Keep the last known install state if the runtime snapshot cannot be refreshed.
      }
    })

  await Promise.all(currentStateRequests)
}

export function resolvePlatformAppInstallState(
  app: PlatformAppSummary,
  runtimeInstallState?: PlatformAppRuntimeInstallState | null,
): string {
  if (app.runtimeModel === 'direct') {
    return 'direct'
  }

  const resolvedRuntimeState = resolveRuntimeInstallState(app, runtimeInstallState)
  if (resolvedRuntimeState === 'partial' || resolvedRuntimeState === 'failed' || resolvedRuntimeState === 'not-installed') {
    return resolvedRuntimeState
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

export function resolvePlatformAppPrimaryAction(
  app: PlatformAppSummary,
  runtimeInstallState?: PlatformAppRuntimeInstallState | null,
): PlatformAppActionDescriptor {
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

  const resolvedInstallState = resolveRuntimeInstallState(app, runtimeInstallState)

  if (!app.instance || resolvedInstallState === 'not-installed') {
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

  if (resolvedInstallState === 'partial' || resolvedInstallState === 'failed') {
    if (app.runtimeBindings?.installPath) {
      return {
        kind: 'reinstall',
        label: 'Reinstall app',
        description: 'The current app runtime snapshot is degraded. Open the platform shell to reinstall it with the existing runtime contract.',
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
      description: 'The current app runtime snapshot is degraded. Enter the app to repair or reinstall it.',
      route: app.entryPath || resolveShellRoute(app.id),
    }
  }

  if (resolvedInstallState === 'inactive' || app.instance.status === 'inactive') {
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
const inflightByAppId = new Map<string, Promise<PlatformAppSummary | null>>()
let pendingRequestCount = 0

function beginRequest(): void {
  pendingRequestCount += 1
  loading.value = true
}

function endRequest(): void {
  pendingRequestCount = Math.max(0, pendingRequestCount - 1)
  loading.value = pendingRequestCount > 0
}

async function runTrackedRequest<T>(
  handler: () => Promise<T>,
  fallbackErrorMessage: string,
): Promise<T | null> {
  beginRequest()
  error.value = null
  try {
    return await handler()
  } catch (err: any) {
    error.value = err?.message || fallbackErrorMessage
    return null
  } finally {
    endRequest()
  }
}

function sortApps(items: PlatformAppSummary[]): PlatformAppSummary[] {
  return [...items].sort((a, b) => a.displayName.localeCompare(b.displayName))
}

async function fetchApps(options?: { force?: boolean }): Promise<void> {
  if (!options?.force && apps.value.length > 0) {
    return
  }
  if (inflightList) {
    return inflightList
  }

  inflightList = (async () => {
    await runTrackedRequest(async () => {
      const response = await apiGet<{ list?: PlatformAppSummary[] }>('/api/platform/apps')
      const nextApps = sortApps(Array.isArray(response?.list) ? response.list : [])
      apps.value = nextApps
      await syncRuntimeInstallStates(nextApps)
    }, 'Failed to load platform apps')
  })()

  try {
    await inflightList
  } finally {
    inflightList = null
  }
}

async function fetchAppById(
  appId: string,
  options?: { force?: boolean; syncRuntimeState?: boolean },
): Promise<PlatformAppSummary | null> {
  const normalizedAppId = appId.trim()
  if (!normalizedAppId) return null
  const existing = apps.value.find((item) => item.id === normalizedAppId)
  if (existing && !options?.force) return existing

  const inflight = inflightByAppId.get(normalizedAppId)
  if (inflight) {
    return inflight
  }

  const request = runTrackedRequest(async () => {
    const app = await apiGet<PlatformAppSummary>(`/api/platform/apps/${encodeURIComponent(normalizedAppId)}`)
    const next = apps.value.filter((item) => item.id !== app.id)
    next.push(app)
    apps.value = sortApps(next)
    if (options?.syncRuntimeState !== false) {
      await syncRuntimeInstallStates([app])
    }
    return app
  }, 'Failed to load platform app').finally(() => {
    inflightByAppId.delete(normalizedAppId)
  })

  inflightByAppId.set(normalizedAppId, request)
  return request
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
