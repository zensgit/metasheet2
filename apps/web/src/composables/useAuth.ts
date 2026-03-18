type FeatureFlags = {
  attendance?: boolean
  workflow?: boolean
  attendanceAdmin?: boolean
  attendanceImport?: boolean
  mode?: 'platform' | 'attendance' | 'attendance-focused' | 'plm-workbench'
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
  attendanceAdmin: false,
  attendanceImport: false,
  mode: 'platform',
}

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
    attendanceAdmin: raw.attendanceAdmin === true,
    attendanceImport: raw.attendanceImport === true,
    mode: normalizeMode(raw.mode),
  }
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value : ''
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

function buildAuthHeadersInternal(token: string | null): Record<string, string> {
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (!headers.Authorization) headers['x-user-id'] = 'dev-user'
  return headers
}

function getApiBase(): string {
  const envValue = (key: 'VITE_API_URL' | 'VITE_API_BASE') => {
    const fromMeta = (import.meta.env as { [key: string]: unknown })[key]
    if (typeof fromMeta === 'string' && fromMeta.trim().length > 0) return fromMeta
    return ''
  }

  const apiUrl = envValue('VITE_API_URL') || envValue('VITE_API_BASE')
  if (apiUrl) return apiUrl

  const origin = typeof window !== 'undefined' ? window.location?.origin : ''
  if (typeof origin === 'string' && origin.trim().length > 0) return origin

  return 'http://localhost:8900'
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
      localStorage.removeItem('user_permissions')
      localStorage.removeItem('user_roles')
    })

    primedSession = null
    primedSessionToken = null
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
  }
}
