type FeatureFlags = {
  attendance?: boolean
  workflow?: boolean
  platformAdmin?: boolean
  attendanceAdmin?: boolean
  attendanceImport?: boolean
  mode?: 'platform' | 'attendance' | 'attendance-focused' | 'plm-workbench'
}

export type ExternalAuthProvider = 'dingtalk'
export type ExternalAuthMode = 'login' | 'bind'

export type ExternalAuthContext = {
  provider: ExternalAuthProvider
  mode: ExternalAuthMode
  redirect: string
  state: string | null
  createdAt: number
}

type PrimedSessionPayload = {
  success?: boolean
  user?: Record<string, unknown>
  features?: FeatureFlags
  data?: {
    user?: Record<string, unknown>
    features?: FeatureFlags
  }
}

type AccessSnapshot = {
  user: {
    id: string
    email: string
    name: string
    role: string
    permissions: string[]
  }
  permissions: string[]
  features: {
    attendance: boolean
    workflow: boolean
    platformAdmin: boolean
    attendanceAdmin: boolean
    attendanceImport: boolean
    mode: 'platform' | 'attendance' | string
  }
}

type BootstrapSessionResult = {
  ok: boolean
  status: number
  payload?: PrimedSessionPayload | null
  error?: string
}

const DEFAULT_FEATURES: AccessSnapshot['features'] = {
  attendance: false,
  workflow: false,
  platformAdmin: false,
  attendanceAdmin: false,
  attendanceImport: false,
  mode: 'platform',
}

const EXTERNAL_AUTH_CONTEXT_KEY = 'metasheet_external_auth_context'
const EXTERNAL_AUTH_CONTEXT_TTL_MS = 15 * 60 * 1000

let primedSession: PrimedSessionPayload | null = null
let primedSessionToken: string | null = null

function withLocalStorageSafe<T>(fn: () => T): T | null {
  try {
    return fn()
  } catch {
    return null
  }
}

function getStoredToken(): string | null {
  const token = withLocalStorageSafe(() =>
    localStorage.getItem('auth_token')
    || localStorage.getItem('jwt')
    || localStorage.getItem('devToken'),
  )

  if (!token) return null
  const trimmed = token.trim()
  return trimmed.length > 0 ? trimmed : null
}

function toStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return values.filter((entry): entry is string => typeof entry === 'string')
}

function normalizeMode(value: unknown): 'platform' | 'attendance' | string {
  if (value === 'attendance' || value === 'attendance-focused') return 'attendance'
  if (typeof value === 'string' && value.length > 0) return value
  return 'platform'
}

function normalizeFeatures(features: unknown): AccessSnapshot['features'] {
  const raw = features as Record<string, unknown> | undefined
  if (!raw || typeof raw !== 'object') return DEFAULT_FEATURES

  return {
    attendance: raw.attendance === true,
    workflow: raw.workflow === true,
    platformAdmin: raw.platformAdmin === true,
    attendanceAdmin: raw.attendanceAdmin === true,
    attendanceImport: raw.attendanceImport === true,
    mode: normalizeMode(raw.mode),
  }
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function normalizeExternalAuthProvider(value: unknown): ExternalAuthProvider | null {
  return value === 'dingtalk' ? value : null
}

function normalizeExternalAuthMode(value: unknown): ExternalAuthMode | null {
  return value === 'login' || value === 'bind' ? value : null
}

function normalizeUserPayload(payload: unknown): AccessSnapshot['user'] {
  const source = payload as Record<string, unknown> | undefined
  const id = normalizeString(source?.id || source?.userId || source?.sub)
  const email = normalizeString(source?.email)
  const name = normalizeString(source?.name)
  const role = normalizeString(source?.role)
  const permissions = toStringArray(source?.permissions)

  return {
    id,
    email,
    name,
    role,
    permissions,
  }
}

function extractAuthData(payload: PrimedSessionPayload | null): { user: AccessSnapshot['user']; features: AccessSnapshot['features'] } {
  const data = payload?.data ?? {}
  const userPayload = (data as Record<string, unknown>).user || payload?.user || {}
  const featurePayload = (data as Record<string, unknown>).features || payload?.features || {}

  const user = normalizeUserPayload(userPayload)
  return {
    user,
    features: normalizeFeatures(featurePayload),
  }
}

function extractAccessSnapshotFromPayload(payload: PrimedSessionPayload | null): AccessSnapshot {
  const { user, features } = extractAuthData(payload)

  return {
    user,
    permissions: user.permissions,
    features,
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const rawPayload = token.split('.')[1]
  if (!rawPayload) return null

  const base64 = rawPayload
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(rawPayload.length / 4) * 4, '=')

  try {
    if (typeof atob === 'function') {
      return JSON.parse(atob(base64)) as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

function extractAccessSnapshotFromToken(token: string): AccessSnapshot {
  const payload = decodeJwtPayload(token)
  if (!payload) {
    return {
      user: {
        id: '',
        email: '',
        name: '',
        role: '',
        permissions: [],
      },
      permissions: [],
      features: DEFAULT_FEATURES,
    }
  }

  const user = normalizeUserPayload(payload)

  return {
    user,
    permissions: user.permissions,
    features: {
      attendance: user.role === 'admin' || user.permissions.some((permission) => permission.startsWith('attendance:')),
      workflow: true,
      platformAdmin: user.role === 'admin',
      attendanceAdmin: user.role === 'admin' || user.permissions.includes('attendance:admin'),
      attendanceImport: user.role === 'admin' || user.permissions.includes('attendance:write'),
      mode: normalizeMode(payload.mode),
    },
  }
}

function getCurrentToken(): string | null {
  const token = getStoredToken()
  if (!token) {
    if (primedSessionToken !== null) {
      primedSession = null
      primedSessionToken = null
    }
    return null
  }

  if (primedSessionToken && primedSessionToken !== token) {
    primedSession = null
  }

  return token
}

function readExternalAuthContext(): ExternalAuthContext | null {
  const raw = withLocalStorageSafe(() => localStorage.getItem(EXTERNAL_AUTH_CONTEXT_KEY))
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const provider = normalizeExternalAuthProvider(parsed.provider)
    const mode = normalizeExternalAuthMode(parsed.mode)
    const redirect = normalizeString(parsed.redirect).trim()

    if (!provider || !mode || !redirect) return null

    const context = {
      provider,
      mode,
      redirect,
      state: typeof parsed.state === 'string' && parsed.state.trim().length > 0 ? parsed.state.trim() : null,
      createdAt: typeof parsed.createdAt === 'number' && Number.isFinite(parsed.createdAt) ? parsed.createdAt : Date.now(),
    }

    if (Date.now() - context.createdAt > EXTERNAL_AUTH_CONTEXT_TTL_MS) {
      clearExternalAuthContext()
      return null
    }

    return context
  } catch {
    clearExternalAuthContext()
    return null
  }
}

function writeExternalAuthContext(context: ExternalAuthContext): void {
  withLocalStorageSafe(() => {
    localStorage.setItem(EXTERNAL_AUTH_CONTEXT_KEY, JSON.stringify(context))
  })
}

function clearExternalAuthContext(): void {
  withLocalStorageSafe(() => {
    localStorage.removeItem(EXTERNAL_AUTH_CONTEXT_KEY)
  })
}

function buildAuthHeadersInternal(token: string | null): Record<string, string> {
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (!headers.Authorization) headers['x-user-id'] = 'dev-user'
  return headers
}

function getApiBase(): string {
  const resolveWindowOrigin = (): string => {
    const origin = typeof window !== 'undefined' ? window.location?.origin : ''
    return typeof origin === 'string' && origin.trim().length > 0 ? origin.trim() : ''
  }

  const isLoopbackUrl = (value: string): boolean => {
    try {
      const url = new URL(value)
      return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
    } catch {
      return false
    }
  }

  const envValue = (key: 'VITE_API_URL' | 'VITE_API_BASE') => {
    const fromMeta = (import.meta.env as { [key: string]: unknown })[key]
    if (typeof fromMeta === 'string' && fromMeta.trim().length > 0) return fromMeta
    return ''
  }

  const apiUrl = envValue('VITE_API_URL') || envValue('VITE_API_BASE')
  const browserOrigin = resolveWindowOrigin()
  if (apiUrl) {
    if (browserOrigin && isLoopbackUrl(apiUrl) && !isLoopbackUrl(browserOrigin)) {
      return browserOrigin
    }
    return apiUrl
  }

  if (browserOrigin) return browserOrigin

  return 'http://localhost:8900'
}

function openExternalUrl(url: string): void {
  if (typeof window === 'undefined') return
  window.location.assign(url)
}

export function useAuth() {
  function getToken(): string | null {
    return getCurrentToken()
  }

  function setToken(token: string): void {
    const value = token.trim()
    if (!value) return

    withLocalStorageSafe(() => {
      localStorage.setItem('auth_token', value)
      localStorage.setItem('jwt', value)
      localStorage.setItem('devToken', value)
    })

    if (primedSessionToken && primedSessionToken !== value) {
      primedSession = null
    }
    primedSessionToken = value
  }

  function clearToken(): void {
    withLocalStorageSafe(() => {
      localStorage.removeItem('auth_token')
      localStorage.removeItem('jwt')
      localStorage.removeItem('devToken')
      localStorage.removeItem('metasheet_features')
      localStorage.removeItem('metasheet_product_mode')
      localStorage.removeItem('user_permissions')
      localStorage.removeItem('user_roles')
    })

    primedSession = null
    primedSessionToken = null
    clearExternalAuthContext()
  }

  function buildAuthHeaders(): Record<string, string> {
    return buildAuthHeadersInternal(getToken())
  }

  function getAccessSnapshot(): AccessSnapshot {
    const token = getToken()
    if (token && primedSession && primedSessionToken === token) {
      return extractAccessSnapshotFromPayload(primedSession)
    }

    if (token) {
      return extractAccessSnapshotFromToken(token)
    }

    return {
      user: {
        id: '',
        email: '',
        name: '',
        role: '',
        permissions: [],
      },
      permissions: [],
      features: DEFAULT_FEATURES,
    }
  }

  async function ensureToken(): Promise<string | null> {
    const tokenUrl = `${getApiBase()}/api/auth/dev-token`
    try {
      const response = await fetch(tokenUrl)
      if (!response.ok) return null

      const payload = await response.json().catch(() => null)
      const token = payload && typeof payload === 'object' && typeof (payload as { token?: unknown }).token === 'string'
        ? ((payload as { token: string }).token)
        : null

      if (!token) return null
      setToken(token)
      return token
    } catch {
      return null
    }
  }

  async function bootstrapSession(): Promise<BootstrapSessionResult> {
    const token = getToken()
    if (!token) {
      return {
        ok: false,
        status: 401,
        error: 'No token provided',
      }
    }

    if (primedSession && primedSessionToken === token) {
      return {
        ok: true,
        status: 200,
        payload: primedSession,
      }
    }

    try {
      const response = await fetch(`${getApiBase()}/api/auth/me`, {
        headers: buildAuthHeadersInternal(token),
      })

      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        if (response.status === 401) {
          return {
            ok: false,
            status: 401,
            payload: payload as PrimedSessionPayload | null | undefined,
            error: 'Invalid token',
          }
        }

        return {
          ok: false,
          status: response.status,
          payload: payload as PrimedSessionPayload | null | undefined,
          error: 'Session bootstrap failed',
        }
      }

      const sessionPayload = payload as PrimedSessionPayload | null | undefined
      if (sessionPayload && typeof sessionPayload === 'object') {
        primedSession = sessionPayload
        primedSessionToken = token
        return {
          ok: true,
          status: response.status,
          payload: sessionPayload,
        }
      }

      return {
        ok: false,
        status: 200,
        payload: null,
        error: 'Invalid session payload',
      }
    } catch {
      return {
        ok: false,
        status: 500,
        error: 'Session bootstrap failed',
      }
    }
  }

  function primeSession(payload: PrimedSessionPayload): void {
    primedSession = payload
    primedSessionToken = getToken()
  }

  function hasAdminAccess(): boolean {
    const snapshot = getAccessSnapshot()
    const permissions = snapshot.permissions
    return (
      snapshot.user.role === 'admin'
      || permissions.includes('admin')
      || permissions.includes('admin:*')
      || permissions.includes('*:*')
    )
  }

  function getExternalAuthContext(): ExternalAuthContext | null {
    return readExternalAuthContext()
  }

  function setExternalAuthContext(context: ExternalAuthContext): void {
    writeExternalAuthContext(context)
  }

  function clearExternalAuthContextPublic(): void {
    clearExternalAuthContext()
  }

  return {
    getToken,
    setToken,
    clearToken,
    buildAuthHeaders,
    ensureToken,
    bootstrapSession,
    primeSession,
    getAccessSnapshot,
    hasAdminAccess,
    getExternalAuthContext,
    setExternalAuthContext,
    clearExternalAuthContext: clearExternalAuthContextPublic,
    openExternalUrl,
  }
}
