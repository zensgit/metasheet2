import { getApiBase } from '../utils/api'
// Single definitions, in a module with no dependencies of its own so a leaf that caches a
// per-principal answer can import them without importing this whole surface. See
// `authPrincipal.ts` for why that separation exists.
import {
  TOKEN_KEYS,
  notifyAuthPrincipalChange,
  parseJwtPayload,
  readStoredToken,
} from './authPrincipal'

const USER_SNAPSHOT_KEYS = ['user_permissions', 'user_roles'] as const
const TENANT_HINT_KEYS = ['tenantId', 'workspaceId'] as const

type AuthAccessSnapshot = {
  email: string
  roles: string[]
  permissions: string[]
  isAdmin: boolean
}

type SessionUserRecord = Record<string, unknown>

type SessionBootstrapPayload = Record<string, unknown>

type SessionBootstrapResult = {
  ok: boolean
  status: number
  payload: SessionBootstrapPayload | null
}

let sessionPromise: Promise<SessionBootstrapResult> | null = null
let sessionToken: string | null = null
let sessionCache: SessionBootstrapResult | null = null

function clearStoredUserSnapshot() {
  try {
    if (typeof localStorage === 'undefined') return
    for (const key of USER_SNAPSHOT_KEYS) {
      localStorage.removeItem(key)
    }
  } catch (err) {
    console.warn('[auth] failed to clear persisted user snapshot', err)
  }
}

function persistUserSnapshot(user: unknown): void {
  try {
    if (typeof localStorage === 'undefined') return
    const record = user && typeof user === 'object' ? user as Record<string, unknown> : {}

    if (Array.isArray(record.permissions)) {
      localStorage.setItem('user_permissions', JSON.stringify(record.permissions))
    }

    if (Array.isArray(record.roles) && record.roles.length > 0) {
      localStorage.setItem('user_roles', JSON.stringify(record.roles))
      return
    }

    if (typeof record.role === 'string' && record.role.trim().length > 0) {
      localStorage.setItem('user_roles', JSON.stringify([record.role]))
    }
  } catch (err) {
    console.warn('[auth] failed to persist user snapshot', err)
  }
}

function resetSessionBootstrap(clearUserSnapshot = false, clearTenantHint = false) {
  sessionPromise = null
  sessionToken = null
  sessionCache = null
  if (clearUserSnapshot) {
    clearStoredUserSnapshot()
  }
  if (clearTenantHint) {
    clearStoredTenantHint()
  }
  // THE app's single "the principal may have changed" announcement. Every transition routes here:
  // `setToken` (login, invite acceptance, DingTalk callback, forced password change, dev-token
  // refresh), `clearToken` (sign-out, and `bootstrapSession`'s 401 branch, which clears with NO
  // navigation), and `bootstrapSession`'s no-token branch. Subscribers can only drop their own
  // per-principal state; see `authPrincipal.ts`.
  notifyAuthPrincipalChange()
}

function extractSessionUser(payload: SessionBootstrapPayload | null): unknown {
  if (!payload) return null
  const data = payload.data
  if (data && typeof data === 'object') {
    return (data as Record<string, unknown>).user ?? null
  }
  return payload.user ?? null
}

function extractUserId(user: unknown): string | null {
  if (!user || typeof user !== 'object') return null
  const record = user as Record<string, unknown>
  const raw = record.id ?? record.userId ?? record.sub
  if (typeof raw === 'string' && raw.trim().length > 0) return raw
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  return null
}

function extractTenantHint(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const raw = record.tenantId ?? record.workspaceId
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim()
  return null
}

function clearStoredTenantHint(): void {
  try {
    if (typeof localStorage === 'undefined') return
    for (const key of TENANT_HINT_KEYS) {
      localStorage.removeItem(key)
    }
  } catch (err) {
    console.warn('[auth] failed to clear tenant hint from localStorage', err)
  }
}

export function useAuth() {
  function readStoredTenantHint(): string | null {
    try {
      if (typeof localStorage === 'undefined') return null
      for (const key of TENANT_HINT_KEYS) {
        const value = localStorage.getItem(key)
        if (typeof value === 'string' && value.trim().length > 0) {
          return value.trim()
        }
      }
    } catch (err) {
      console.warn('[auth] failed to read tenant hint from localStorage', err)
    }
    return null
  }

  function persistTenantHint(tenantId: string | null): void {
    if (!tenantId || typeof localStorage === 'undefined') return
    try {
      localStorage.setItem('tenantId', tenantId)
      localStorage.setItem('workspaceId', tenantId)
    } catch (err) {
      console.warn('[auth] failed to persist tenant hint in localStorage', err)
    }
  }

  function readLocationTenantHint(): string | null {
    try {
      if (typeof window === 'undefined') return null
      const params = new URLSearchParams(window.location.search || '')
      for (const key of TENANT_HINT_KEYS) {
        const value = params.get(key)
        if (typeof value === 'string' && value.trim().length > 0) {
          return value.trim()
        }
      }
    } catch (err) {
      console.warn('[auth] failed to read tenant hint from location', err)
    }
    return null
  }

  function readTenantHint(): string | null {
    return readStoredTenantHint() || readLocationTenantHint()
  }

  function getToken(): string | null {
    return readStoredToken()
  }

  function setToken(token: string) {
    resetSessionBootstrap()
    try {
      if (typeof localStorage === 'undefined') return
      localStorage.setItem('auth_token', token)
      localStorage.setItem('jwt', token)
      clearStoredTenantHint()
      persistTenantHint(extractTenantHint(parseJwtPayload(token)) || readLocationTenantHint())
    } catch (err) {
      console.warn('[auth] failed to persist token in localStorage', err)
    }
  }

  function clearToken() {
    resetSessionBootstrap(true, true)
    try {
      if (typeof localStorage === 'undefined') return
      for (const key of TOKEN_KEYS) {
        localStorage.removeItem(key)
      }
    } catch (err) {
      console.warn('[auth] failed to clear token from localStorage', err)
    }
  }

  // Only the explicit, authenticated organization-switch response uses this
  // hook. Payload checks are consistency checks, not signature verification.
  // Login hints and login/logout behavior are intentionally unchanged.
  function setExplicitSessionOrg(token: string, orgId: string, expectedToken: string): boolean {
    if (!expectedToken || getToken() !== expectedToken || !orgId
      || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return false
    const previous = parseJwtPayload(expectedToken)
    const next = parseJwtPayload(token)
    const actor = previous?.userId ?? previous?.sub ?? previous?.id
    if (typeof actor !== 'string' || !actor
      || (next?.userId ?? next?.sub ?? next?.id) !== actor
      || next?.tenantId !== orgId || typeof next?.exp !== 'number'
      || !Number.isFinite(next.exp) || next.exp <= Date.now() / 1000
      || typeof localStorage === 'undefined') return false
    const originalAuth = localStorage.getItem('auth_token')
    const originalJwt = localStorage.getItem('jwt')
    try {
      localStorage.setItem('auth_token', token)
      localStorage.setItem('jwt', token)
    } catch {
      for (const [key, value] of [['auth_token', originalAuth], ['jwt', originalJwt]]) {
        if (value === null) localStorage.removeItem(key!)
        else localStorage.setItem(key!, value!)
      }
      return false
    }
    resetSessionBootstrap(true)
    return true
  }

  function parseStringArray(raw: unknown): string[] {
    if (Array.isArray(raw)) {
      return raw.map((item) => String(item || '').trim()).filter(Boolean)
    }
    if (typeof raw === 'string' && raw.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(raw) as unknown
        return parseStringArray(parsed)
      } catch {
        return []
      }
    }
    return []
  }

  function getAccessSnapshot(): AuthAccessSnapshot {
    const token = getToken()
    const payload = token ? parseJwtPayload(token) : null
    const storedRoles = typeof localStorage !== 'undefined' ? parseStringArray(localStorage.getItem('user_roles')) : []
    const storedPermissions = typeof localStorage !== 'undefined' ? parseStringArray(localStorage.getItem('user_permissions')) : []
    const payloadRoles = parseStringArray(payload?.roles)
    const payloadPermissions = [...parseStringArray(payload?.perms), ...parseStringArray(payload?.permissions)]
    const singularRole = typeof payload?.role === 'string' && payload.role.trim().length > 0 ? [payload.role.trim()] : []
    const roles = Array.from(new Set([...storedRoles, ...payloadRoles, ...singularRole]))
    const permissions = Array.from(new Set([...storedPermissions, ...payloadPermissions]))
    const email = typeof payload?.email === 'string' ? payload.email : ''
    const isAdmin =
      roles.includes('admin') ||
      permissions.includes('*:*') ||
      permissions.includes('admin:all') ||
      permissions.includes('users:write') ||
      permissions.includes('roles:write') ||
      permissions.includes('permissions:write')

    return {
      email,
      roles,
      permissions,
      isAdmin,
    }
  }

  async function refreshDevToken(): Promise<string | null> {
    if (import.meta.env.PROD) return null

    try {
      const devTokenUrl = new URL('/api/auth/dev-token', getApiBase())
      const tenantHint = readTenantHint()
      if (tenantHint) {
        devTokenUrl.searchParams.set('tenantId', tenantHint)
      }

      const response = await fetch(devTokenUrl.toString())
      if (!response.ok) return null

      const payload = await response.json().catch(() => ({})) as Record<string, unknown>
      const token =
        typeof payload.token === 'string'
          ? payload.token
          : payload.data && typeof payload.data === 'object' && typeof (payload.data as Record<string, unknown>).token === 'string'
            ? (payload.data as Record<string, unknown>).token as string
            : null

      if (!token) return null
      setToken(token)
      if (tenantHint) {
        persistTenantHint(tenantHint)
      }

      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem('devToken', token)
      } catch (err) {
        console.warn('[auth] failed to persist devToken alias in localStorage', err)
      }

      return token
    } catch (err) {
      console.warn('[auth] failed to refresh dev token', err)
      return null
    }
  }

  async function ensureToken(): Promise<string | null> {
    const existing = getToken()
    if (existing) return existing
    return refreshDevToken()
  }

  async function bootstrapSession(force = false): Promise<SessionBootstrapResult> {
    const existingToken = getToken()
    if (!existingToken) {
      resetSessionBootstrap(true)
      return {
        ok: false,
        status: 401,
        payload: null,
      }
    }

    if (!force && sessionCache && sessionToken === existingToken) {
      return sessionCache
    }

    if (!force && sessionPromise && sessionToken === existingToken) {
      return sessionPromise
    }

    sessionToken = existingToken
    sessionPromise = (async (): Promise<SessionBootstrapResult> => {
      let resolvedToken = existingToken
      let response = await fetch(`${getApiBase()}/api/auth/me`, {
        headers: buildAuthHeaders(resolvedToken),
      }).catch(() => null)

      if (response?.status === 401) {
        const refreshedToken = await refreshDevToken()
        if (refreshedToken && refreshedToken !== resolvedToken) {
          resolvedToken = refreshedToken
          sessionToken = refreshedToken
          response = await fetch(`${getApiBase()}/api/auth/me`, {
            headers: buildAuthHeaders(resolvedToken),
          }).catch(() => null)
        }
      }

      if (!response) {
        sessionCache = {
          ok: false,
          status: 0,
          payload: null,
        }
        return sessionCache
      }

      let payload: SessionBootstrapPayload | null = null
      try {
        payload = await response.json() as SessionBootstrapPayload
      } catch {
        payload = null
      }

      if (!response.ok) {
        if (response.status === 401) {
          clearToken()
        }
        sessionCache = {
          ok: false,
          status: response.status,
          payload,
        }
        return sessionCache
      }

      persistUserSnapshot(extractSessionUser(payload))
      persistTenantHint(extractTenantHint(extractSessionUser(payload)))
      sessionCache = {
        ok: true,
        status: response.status,
        payload,
      }
      return sessionCache
    })()

    try {
      return await sessionPromise
    } finally {
      sessionPromise = null
    }
  }

  function primeSession(payload: SessionBootstrapPayload | null) {
    const token = getToken()
    sessionToken = token
    sessionCache = {
      ok: true,
      status: 200,
      payload,
    }
    sessionPromise = null
    persistUserSnapshot(extractSessionUser(payload))
    persistTenantHint(extractTenantHint(extractSessionUser(payload)))
  }

  function buildAuthHeaders(tokenOverride?: string | null): Record<string, string> {
    const headers: Record<string, string> = {}
    const token = tokenOverride || getToken()
    if (token) headers['Authorization'] = `Bearer ${token}`
    const tenantHint = readStoredTenantHint() || readLocationTenantHint() || extractTenantHint(parseJwtPayload(token || ''))
    if (tenantHint) headers['x-tenant-id'] = tenantHint
    // Dev/test fallback aligns with backend flag behaviour
    if (!headers['Authorization']) headers['x-user-id'] = 'dev-user'
    return headers
  }

  function hasAdminAccess(): boolean {
    return getAccessSnapshot().isAdmin
  }

  function hasPermission(requiredPermission: string): boolean {
    const normalized = String(requiredPermission || '').trim()
    if (!normalized) return true

    const snapshot = getAccessSnapshot()
    if (snapshot.isAdmin || snapshot.roles.includes('admin')) return true

    const permissions = snapshot.permissions
    if (permissions.includes(normalized) || permissions.includes('*:*')) return true

    const [resource, action] = normalized.split(':')
    if (!resource || !action) return false
    if (permissions.includes(`${resource}:*`)) return true
    if (permissions.includes(`${resource}:admin`) && action !== 'admin') return true
    if (action === 'read' && permissions.includes(`${resource}:write`)) return true
    return false
  }

  function getCurrentUser(): SessionUserRecord | null {
    return (extractSessionUser(sessionCache?.payload ?? null) as SessionUserRecord | null) ?? null
  }

  async function getCurrentUserId(force = false): Promise<string | null> {
    const cached = extractUserId(getCurrentUser())
    if (cached && !force) return cached
    const session = await bootstrapSession(force)
    return extractUserId(extractSessionUser(session.payload))
  }

  return {
    getToken,
    setToken,
    setExplicitSessionOrg,
    clearToken,
    bootstrapSession,
    primeSession,
    persistUserSnapshot,
    clearStoredUserSnapshot,
    refreshDevToken,
    ensureToken,
    buildAuthHeaders,
    getAccessSnapshot,
    hasAdminAccess,
    hasPermission,
    getCurrentUser,
    getCurrentUserId,
  }
}
