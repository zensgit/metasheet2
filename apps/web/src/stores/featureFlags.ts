import { computed, reactive, readonly } from 'vue'
import { useAuth } from '../composables/useAuth'
import { apiFetch } from '../utils/api'

export type ProductMode = 'platform' | 'attendance' | 'plm-workbench'

export interface ProductFeatures {
  attendance: boolean
  workflow: boolean
  attendanceAdmin: boolean
  attendanceImport: boolean
  plm: boolean
  /**
   * T3-1 v0 — mobile approval surface (responsive web) rollout gate (ballot Q11).
   * Tenant/user-scoped, DEFAULT OFF: the flag is only true when the backend
   * session payload (or an authorized dev override) explicitly enables it.
   * There is intentionally NO plugin/admin inference — an admin does not get
   * the mobile surface for free — so the desktop approval center/detail stay
   * byte-identical for every tenant that has not opted in.
   */
  approvalMobile: boolean
  /**
   * B3-07 (#4195) — approval attachment upload pipeline gate. Mirrors the backend's
   * APPROVAL_ATTACHMENTS_ENABLED master flag (D5, default OFF): the fill view replaces the B2-28
   * honest-disabled placeholder with the real uploader ONLY when the backend session payload (or an
   * authorized dev override) explicitly enables it. No role/mode inference — flag OFF keeps the
   * placeholder + submit-time strip byte-identical.
   */
  approvalAttachments: boolean
  /**
   * Approval Canvas V2 authoring surface. Default OFF and enabled only by an explicit backend
   * session value or the existing authorized development override.
   */
  approvalCanvasV2: boolean
  /**
   * FWB production authoring (`write_approval_form_values` / create-from-approval). Mirrors the
   * backend APPROVAL_FWB_WRITEBACK_ENABLED master flag (default OFF). The automation rule editor
   * offers NEW FWB actions only when this is true AND the trigger is approval.completed; a
   * previously persisted FWB action remains visible as read-only while the flag is off.
   */
  approvalFwbWriteback: boolean
  /**
   * W6-3 (#4556) OD-W6-7=(a) — group effective-policy panel gate. Mirrors the backend's two-layer
   * default-OFF switch (master `ATTENDANCE_GROUP_EFFECTIVE_POLICY_PANEL_ENABLED` env AND a per-org
   * exact allowlist — see `w6-group-effective-policy-panel-flag.ts`). No role/mode/plugin
   * inference: OFF keeps `AttendanceGroupContextHost.vue` byte-identical to before this slice.
   */
  attendanceGroupEffectivePolicyPanel: boolean
  /**
   * E-learning V0.1 named-pilot navigation/route gate. Default OFF. True only when
   * the backend session payload (or the existing authorized dev override) supplies
   * an explicit boolean — never inferred from admin role, product mode, or plugin state.
   */
  elearning: boolean
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
  plm: false,
  approvalMobile: false,
  approvalAttachments: false,
  approvalCanvasV2: false,
  approvalFwbWriteback: false,
  attendanceGroupEffectivePolicyPanel: false,
  elearning: false,
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

// Exported (Navigability audit fix 1, 2026-08-22) so the "Capability not available" empty state
// can surface — not reinvent — this EXACT existing predicate: the state shows the local-override
// toggle only when this returns true, and an "ask your administrator" line otherwise. The
// predicate itself is unchanged (still DEV-mode-or-explicit-env-flag), matching the design-lock's
// "do not change... the override gate's own predicate" constraint.
export function isFeatureOverrideAllowed(): boolean {
  if (import.meta.env.DEV) return true
  return String(import.meta.env.VITE_ALLOW_FEATURE_OVERRIDE || '').trim().toLowerCase() === 'true'
}

/** Pure read-merge-write over the SAME `metasheet_features` localStorage key
 * `parseOverrideFeatures()` already reads (Navigability audit fix 1) — exported for direct unit
 * testing. Never touches keys other than the ones present in `patch`, so it cannot clobber a flag
 * a developer already set through the pre-existing manual localStorage-editing path. */
export function mergeFeatureOverrideJson(
  rawJson: string | null,
  patch: Partial<Record<keyof Omit<ProductFeatures, 'mode'>, boolean>>,
): string {
  let base: Record<string, unknown> = {}
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed
    } catch {
      base = {}
    }
  }
  return JSON.stringify({ ...base, ...patch })
}

/**
 * Enables (or disables) a single ProductFeatures flag in the local dev/QA override — the SAME
 * sanctioned path `parseOverrideFeatures()` already reads, just no longer requiring hand-editing
 * `localStorage` directly. No-ops when `isFeatureOverrideAllowed()` is false (never grants the
 * override capability itself). Callers must re-run `loadProductFeatures(true)` to pick up the
 * change — this function only persists it.
 */
export function setLocalFeatureOverride(feature: keyof Omit<ProductFeatures, 'mode'>, value: boolean): void {
  if (!isFeatureOverrideAllowed()) return
  if (typeof localStorage === 'undefined') return
  const next = mergeFeatureOverrideJson(localStorage.getItem('metasheet_features'), { [feature]: value })
  localStorage.setItem('metasheet_features', next)
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

function needsPluginInference(features: Partial<ProductFeatures>): boolean {
  return typeof features.attendance !== 'boolean' || typeof features.workflow !== 'boolean'
}

export function extractFeaturesFromPayload(payload: any): Partial<ProductFeatures> {
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
    plm:
      typeof featuresNode.plm === 'boolean'
        ? featuresNode.plm
        : typeof featuresNode.plmWorkbench === 'boolean'
          ? featuresNode.plmWorkbench
          : typeof featuresNode.plm_workbench === 'boolean'
            ? featuresNode.plm_workbench
            : undefined,
    approvalMobile:
      typeof featuresNode.approvalMobile === 'boolean'
        ? featuresNode.approvalMobile
        : typeof featuresNode.approval_mobile === 'boolean'
          ? featuresNode.approval_mobile
          : undefined,
    approvalAttachments:
      typeof featuresNode.approvalAttachments === 'boolean'
        ? featuresNode.approvalAttachments
        : typeof featuresNode.approval_attachments === 'boolean'
          ? featuresNode.approval_attachments
          : undefined,
    approvalCanvasV2:
      typeof featuresNode.approvalCanvasV2 === 'boolean'
        ? featuresNode.approvalCanvasV2
        : typeof featuresNode.approval_canvas_v2 === 'boolean'
          ? featuresNode.approval_canvas_v2
          : undefined,
    approvalFwbWriteback:
      typeof featuresNode.approvalFwbWriteback === 'boolean'
        ? featuresNode.approvalFwbWriteback
        : typeof featuresNode.approval_fwb_writeback === 'boolean'
          ? featuresNode.approval_fwb_writeback
          : undefined,
    attendanceGroupEffectivePolicyPanel:
      typeof featuresNode.attendanceGroupEffectivePolicyPanel === 'boolean'
        ? featuresNode.attendanceGroupEffectivePolicyPanel
        : typeof featuresNode.attendance_group_effective_policy_panel === 'boolean'
          ? featuresNode.attendance_group_effective_policy_panel
          : undefined,
    elearning: typeof featuresNode.elearning === 'boolean' ? featuresNode.elearning : undefined,
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

  let mode = normalizeMode(override.mode)
    || normalizeMode(backend.mode)
    || 'platform'
  const inferredPlm = boolOrDefault(
    override.plm,
    backend.plm,
    mode === 'plm-workbench',
    mode === 'platform',
  )
  const plm = mode === 'attendance' ? false : inferredPlm
  if (mode === 'plm-workbench' && !plm) {
    mode = 'platform'
  }

  // T3-1 v0 rollout gate: default OFF. Only an explicit backend/override boolean
  // flips it on — no inference from admin role or product mode. `boolOrDefault`
  // returns false when neither source supplies a boolean.
  const approvalMobile = boolOrDefault(
    override.approvalMobile,
    backend.approvalMobile,
  )

  // B3-07: same default-OFF discipline — only an explicit backend/override boolean enables it.
  const approvalAttachments = boolOrDefault(
    override.approvalAttachments,
    backend.approvalAttachments,
  )

  // Canvas V2 follows the same explicit-only rollout discipline as approval attachments/mobile.
  const approvalCanvasV2 = boolOrDefault(
    override.approvalCanvasV2,
    backend.approvalCanvasV2,
  )

  // FWB authoring: same default-OFF discipline — only an explicit backend/override boolean enables it.
  const approvalFwbWriteback = boolOrDefault(
    override.approvalFwbWriteback,
    backend.approvalFwbWriteback,
  )

  // W6-3 (#4556) OD-W6-7=(a): same default-OFF discipline — only an explicit backend/override
  // boolean enables it; no admin/mode/plugin inference.
  const attendanceGroupEffectivePolicyPanel = boolOrDefault(
    override.attendanceGroupEffectivePolicyPanel,
    backend.attendanceGroupEffectivePolicyPanel,
  )

  // E-learning V0.1: default OFF. Only an explicit backend/override boolean enables
  // it — no inference from admin role, product mode, or plugin state.
  const elearning = boolOrDefault(
    override.elearning,
    backend.elearning,
  )

  return {
    attendance,
    workflow,
    attendanceAdmin,
    attendanceImport,
    plm,
    approvalMobile,
    approvalAttachments,
    approvalCanvasV2,
    approvalFwbWriteback,
    attendanceGroupEffectivePolicyPanel,
    elearning,
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
    let backendFeatures: Partial<ProductFeatures> = {}
    const { ensureToken, getToken, bootstrapSession } = useAuth()

    try {
      const currentToken = getToken()

      if (!currentToken && requiresSessionProbe) {
        await ensureToken()
      }

      if (requiresSessionProbe && getToken()) {
        const session = await bootstrapSession()
        if (session.ok && session.payload) {
          mePayload = session.payload
          backendFeatures = extractFeaturesFromPayload(mePayload)
        }
      }

      if (needsPluginInference(backendFeatures)) {
        const pluginRes = await apiFetch('/api/plugins').catch(() => null)
        if (pluginRes?.ok) {
          pluginPayload = await pluginRes.json()
        }
      }
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Failed to load product features'
    }

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
  return state.features.mode === 'plm-workbench' && state.features.plm
}

function resolveHomePath(): string {
  if (isAttendanceFocused()) return '/attendance'
  if (isPlmWorkbenchFocused()) return '/plm'
  if (state.features.attendance && !state.features.plm) return '/attendance'
  return '/multitable'
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
    isFeatureOverrideAllowed,
    setLocalFeatureOverride,
  }
}
