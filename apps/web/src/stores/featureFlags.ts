import { computed, reactive, readonly } from 'vue'
import { apiFetch } from '../utils/api'

export type ProductMode = 'platform' | 'attendance' | 'plm-workbench'

export interface ProductFeatures {
  attendance: boolean
  workflow: boolean
  attendanceAdmin: boolean
  attendanceImport: boolean
  mode: ProductMode
}

export interface RouteFeatureGuard {
  requiredFeature?: keyof Omit<ProductFeatures, 'mode'>
}

export interface MobileCapabilityPolicy {
  allow: string[]
  desktopOnly: string[]
}

interface ProductFeatureState {
  loaded: boolean
  loading: boolean
  sessionAwareLoaded: boolean
  error: string | null
  features: ProductFeatures
}

interface LoadProductFeatureOptions {
  skipSessionProbe?: boolean
}

const DEFAULT_FEATURES: ProductFeatures = {
  attendance: false,
  workflow: false,
  attendanceAdmin: false,
  attendanceImport: false,
  mode: 'platform',
}

const state = reactive<ProductFeatureState>({
  loaded: false,
  loading: false,
  sessionAwareLoaded: false,
  error: null,
  features: { ...DEFAULT_FEATURES },
})

const mobileCapabilityPolicy: MobileCapabilityPolicy = {
  allow: ['punch', 'request', 'approve', 'records'],
  desktopOnly: ['import', 'rule-template', 'payroll-cycle', 'workflow-designer'],
}

let loadPromise: Promise<ProductFeatures> | null = null

function parseJwtPayload(token: string | null): Record<string, unknown> {
  if (!token) return {}
  const chunks = token.split('.')
  if (chunks.length < 2) return {}
  try {
    const normalized = chunks[1]
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(chunks[1].length / 4) * 4, '=')
    const json = atob(normalized)
    const parsed = JSON.parse(json)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function isFeatureOverrideAllowed(): boolean {
  if (import.meta.env.DEV) return true
  return String(import.meta.env.VITE_ALLOW_FEATURE_OVERRIDE || '').trim().toLowerCase() === 'true'
}

function parseOverrideFeatures(): Partial<ProductFeatures> {
  if (!isFeatureOverrideAllowed()) return {}
  if (typeof localStorage === 'undefined') return {}

  const modeRaw = localStorage.getItem('metasheet_product_mode')
  const mode: ProductMode | undefined = modeRaw === 'attendance' || modeRaw === 'platform' || modeRaw === 'plm-workbench'
    ? modeRaw
    : undefined

  const raw = localStorage.getItem('metasheet_features')
  if (!raw) return mode ? { mode } : {}

  try {
    const parsed = JSON.parse(raw) as Partial<ProductFeatures>
    return {
      ...parsed,
      ...(mode ? { mode } : {}),
    }
  } catch {
    return mode ? { mode } : {}
  }
}

function normalizeMode(value: unknown): ProductMode | undefined {
  if (value === 'attendance' || value === 'platform') return value
  if (value === 'plm-workbench' || value === 'plmWorkbench') return 'plm-workbench'
  if (value === 'attendance-focused') return 'attendance'
  if (value === 'plm-focused') return 'plm-workbench'
  return undefined
}

function boolOrDefault(...values: Array<unknown>): boolean {
  for (const value of values) {
    if (typeof value === 'boolean') return value
  }
  return false
}

function extractFeaturesFromPayload(payload: any): Partial<ProductFeatures> {
  const featuresNode =
    payload?.data?.features ||
    payload?.features ||
    payload?.data?.user?.features ||
    payload?.user?.features ||
    null

  if (!featuresNode || typeof featuresNode !== 'object') {
    return {}
  }

  return {
    attendance: typeof featuresNode.attendance === 'boolean' ? featuresNode.attendance : undefined,
    workflow: typeof featuresNode.workflow === 'boolean' ? featuresNode.workflow : undefined,
    attendanceAdmin:
      typeof featuresNode.attendanceAdmin === 'boolean'
        ? featuresNode.attendanceAdmin
        : typeof featuresNode.attendance_admin === 'boolean'
          ? featuresNode.attendance_admin
          : undefined,
    attendanceImport:
      typeof featuresNode.attendanceImport === 'boolean'
        ? featuresNode.attendanceImport
        : typeof featuresNode.attendance_import === 'boolean'
          ? featuresNode.attendance_import
          : undefined,
    mode: normalizeMode(
      featuresNode.mode ??
      featuresNode.productMode ??
      featuresNode.shellMode,
    ),
  }
}

function isAdminRole(payload: any): boolean {
  const roleCandidates = [
    payload?.data?.user?.role,
    payload?.user?.role,
    payload?.role,
  ]
  if (roleCandidates.some((role) => role === 'admin')) return true

  const rolesCandidates = [
    payload?.data?.user?.roles,
    payload?.user?.roles,
    payload?.roles,
  ]
  for (const roles of rolesCandidates) {
    if (Array.isArray(roles) && roles.includes('admin')) return true
  }

  const tokenPayload = parseJwtPayload(
    typeof localStorage !== 'undefined'
      ? localStorage.getItem('auth_token') || localStorage.getItem('jwt') || localStorage.getItem('devToken')
      : null,
  )
  if (tokenPayload.role === 'admin') return true
  if (Array.isArray(tokenPayload.roles) && tokenPayload.roles.includes('admin')) return true

  return false
}

function inferPluginFeatures(payload: any): {
  attendance: boolean
  workflow: boolean
} {
  const list: any[] = Array.isArray(payload) ? payload : Array.isArray(payload?.list) ? payload.list : []
  const active = list.filter((item) => item?.status === 'active')
  const activeNames = active.map((item) => String(item?.name || '').toLowerCase())

  const attendance = activeNames.some((name) => name === 'plugin-attendance' || name.endsWith('/plugin-attendance'))
  const workflow = activeNames.some((name) => name.includes('workflow'))

  return { attendance, workflow }
}

function resolveFeatures(
  backend: Partial<ProductFeatures>,
  override: Partial<ProductFeatures>,
  pluginInference: { attendance: boolean; workflow: boolean },
  isAdmin: boolean,
): ProductFeatures {
  const attendance = boolOrDefault(
    override.attendance,
    backend.attendance,
    pluginInference.attendance,
  )

  const workflow = boolOrDefault(
    override.workflow,
    backend.workflow,
    pluginInference.workflow,
  )

  const attendanceAdmin = boolOrDefault(
    override.attendanceAdmin,
    backend.attendanceAdmin,
    isAdmin,
  )

  const attendanceImport = boolOrDefault(
    override.attendanceImport,
    backend.attendanceImport,
    attendanceAdmin,
  )

  const mode = normalizeMode(override.mode)
    || normalizeMode(backend.mode)
    || 'platform'

  return {
    attendance,
    workflow,
    attendanceAdmin,
    attendanceImport,
    mode,
  }
}

async function loadProductFeatures(
  force = false,
  options: LoadProductFeatureOptions = {},
): Promise<ProductFeatures> {
  const requiresSessionProbe = !options.skipSessionProbe
  if (state.loaded && !force && (!requiresSessionProbe || state.sessionAwareLoaded)) return state.features
  if (state.loading && loadPromise) return loadPromise

  state.loading = true
  state.error = null

  loadPromise = (async () => {
    let mePayload: any = null
    let pluginPayload: any = null

    try {
      const requests: Array<Promise<Response | null>> = [
        apiFetch('/api/plugins').catch(() => null),
      ]

      if (requiresSessionProbe) {
        requests.unshift(apiFetch('/api/auth/me').catch(() => null))
      }

      const responses = await Promise.all(requests)
      const pluginRes = responses.at(-1) ?? null
      const meRes = requiresSessionProbe ? (responses[0] ?? null) : null

      if (meRes?.ok) {
        mePayload = await meRes.json()
      }

      if (pluginRes?.ok) {
        pluginPayload = await pluginRes.json()
      }
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Failed to load product features'
    }

    const backendFeatures = extractFeaturesFromPayload(mePayload)
    const pluginInference = inferPluginFeatures(pluginPayload)
    const overrideFeatures = parseOverrideFeatures()
    const adminRole = isAdminRole(mePayload)

    state.features = resolveFeatures(backendFeatures, overrideFeatures, pluginInference, adminRole)
    state.loaded = true
    state.sessionAwareLoaded = state.sessionAwareLoaded || requiresSessionProbe
    state.loading = false

    return state.features
  })()

  try {
    return await loadPromise
  } finally {
    loadPromise = null
  }
}

function hasFeature(feature: keyof Omit<ProductFeatures, 'mode'>): boolean {
  return state.features[feature]
}

function isAttendanceFocused(): boolean {
  return state.features.mode === 'attendance' && state.features.attendance
}

function isPlmWorkbenchFocused(): boolean {
  return state.features.mode === 'plm-workbench'
}

function resolveHomePath(): string {
  if (isAttendanceFocused()) return '/attendance'
  if (isPlmWorkbenchFocused()) return '/plm'
  return '/grid'
}

export function useFeatureFlags() {
  return {
    state: readonly(state),
    features: computed(() => state.features),
    mobileCapabilityPolicy,
    loadProductFeatures,
    hasFeature,
    isAttendanceFocused,
    isPlmWorkbenchFocused,
    resolveHomePath,
  }
}
