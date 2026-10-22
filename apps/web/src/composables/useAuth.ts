import { getApiBase } from '../utils/api'
import {
  AuthIdentityLockError,
  assertOrdinarySyncWriterAllowed,
  authIdentityLocksAvailable,
  managedResidueRemains,
  ordinaryTakeoverRequired,
  managedRenewalPendingPresent,
  readManagedCompletePending,
  readManagedRenewalPending,
  runSyncAuthMutation,
  sameManagedRenewalSession,
  withAuthIdentityLock,
} from './authIdentityLock'
import {
  PlmManagedCompanionError,
  continuousRenewalDue,
  continuousRenewalEligible,
  postManagedLogoutUnlocked,
  renewManagedContinuousSessionUnlocked,
  type ManagedRenewalOutcome,
} from '../services/plm/plmManagedCompanion'
import { matchesPermission } from '../utils/permission-match'
import { getCurrentScope, onScopeDispose } from 'vue'
import { beginExplicitSessionOrgChange, clearExplicitSessionOrg, EXPLICIT_SESSION_ORG_KEY, installExplicitSessionOrg, ownsExplicitSessionOrgChange, restoreExplicitSessionOrg } from '../utils/explicitSessionOrg'
// Single definitions, in a module with no dependencies of its own so a leaf that caches a
// per-principal answer can import them without importing this whole surface. See
// `authPrincipal.ts` for why that separation exists.
import {
  TOKEN_KEYS,
  bumpManagedEpoch,
  clearManagedDescriptor,
  explicitSessionOrg,
  getAuthPrincipalKey,
  installManagedDescriptor,
  isManagedEntryActive,
  notifyAuthPrincipalChange,
  parseJwtPayload,
  readAuthRequestStamp,
  readAuthSessionSignature,
  readManagedDescriptor,
  readManagedEpoch,
  readStoredToken,
  sameAuthRequest,
  setManagedProbeMarker,
  type AuthRequestStamp,
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
let managedFlight: { key: string; promise: Promise<SessionBootstrapResult> } | null = null
let sessionToken: string | null = null
let sessionCache: SessionBootstrapResult | null = null
let explicitSessionRevision = 0
let sessionIdentity: string | null = null
let sessionWasExplicit = false
const observedScopes = new WeakSet<object>()
let storageSubscribers = 0
let storageListener: ((event: StorageEvent) => void) | null = null
let observedToken: string | null = null
let observedMarker: string | null = null

function readMarker(): string | null {
  try { return localStorage.getItem(EXPLICIT_SESSION_ORG_KEY) } catch { return 'unavailable' }
}

function rememberSessionStorage(): void {
  observedToken = readStoredToken()
  observedMarker = readMarker()
}

function observeExplicitSessionStorage(): void {
  const scope = getCurrentScope()
  if (!scope || observedScopes.has(scope) || typeof window === 'undefined') return
  observedScopes.add(scope)
  storageSubscribers++
  if (!storageListener) {
    rememberSessionStorage()
    storageListener = (event) => {
      if (event.storageArea && event.storageArea !== localStorage) return
      if (event.key !== null && event.key !== EXPLICIT_SESSION_ORG_KEY
        && !(TOKEN_KEYS as readonly string[]).includes(event.key)) return
      const token = readStoredToken()
      const marker = readMarker()
      const explicitTransition = observedMarker !== null || marker !== null
        || (event.key === EXPLICIT_SESSION_ORG_KEY && Boolean(event.oldValue || event.newValue))
      if (!explicitTransition || (token === observedToken && marker === observedMarker)) return
      explicitSessionRevision++
      // Notification and local cache invalidation, not a write lock. The
      // principal/header guards detect changes synchronously before this event.
      resetSessionBootstrap(true, false, true)
    }
    window.addEventListener('storage', storageListener)
  }
  onScopeDispose(() => {
    storageSubscribers--
    if (storageSubscribers === 0 && storageListener) {
      window.removeEventListener('storage', storageListener)
      storageListener = null
    }
  })
}

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

function resetSessionBootstrap(clearUserSnapshot = false, clearTenantHint = false, preserveExplicitSession = false) {
  if (!preserveExplicitSession) clearExplicitSessionOrg()
  sessionPromise = null
  managedFlight = null
  sessionToken = null
  sessionCache = null
  sessionIdentity = null
  sessionWasExplicit = false
  if (clearUserSnapshot) {
    clearStoredUserSnapshot()
  }
  if (clearTenantHint) {
    clearStoredTenantHint()
  }
  clearManagedDescriptor()
  bumpManagedEpoch()
  // THE app's single "the principal may have changed" announcement. Every transition routes here:
  // `setToken` (login, invite acceptance, DingTalk callback, forced password change, dev-token
  // refresh), `clearToken` (sign-out, and `bootstrapSession`'s 401 branch, which clears with NO
  // navigation), and `bootstrapSession`'s no-token branch. Subscribers can only drop their own
  // per-principal state; see `authPrincipal.ts`.
  rememberSessionStorage()
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
  observeExplicitSessionStorage()
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
    assertOrdinarySyncWriterAllowed()
    resetSessionBootstrap(false, false, true)
    try {
      if (typeof localStorage === 'undefined') return
      localStorage.setItem('auth_token', token)
      localStorage.setItem('jwt', token)
      clearStoredTenantHint()
      persistTenantHint(extractTenantHint(parseJwtPayload(token)) || readLocationTenantHint())
      clearExplicitSessionOrg()
      rememberSessionStorage()
    } catch (err) {
      console.warn('[auth] failed to persist token in localStorage', err)
    }
  }

  function clearToken() {
    assertOrdinarySyncWriterAllowed()
    resetSessionBootstrap(true, true, true)
    try {
      if (typeof localStorage === 'undefined') return
      for (const key of TOKEN_KEYS) {
        localStorage.removeItem(key)
      }
      clearExplicitSessionOrg()
      rememberSessionStorage()
    } catch (err) {
      console.warn('[auth] failed to clear token from localStorage', err)
    }
  }

  // Only the explicit, authenticated organization-switch response uses this
  // hook. Payload checks are consistency checks, not signature verification.
  // Login hints and login/logout behavior are intentionally unchanged.
  function setExplicitSessionOrg(token: string, orgId: string, expectedToken: string): boolean {
    assertOrdinarySyncWriterAllowed()
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
    const change = beginExplicitSessionOrgChange(expectedToken)
    if (!change) return false
    try {
      if (!ownsExplicitSessionOrgChange(change) || getToken() !== expectedToken) throw new Error('SESSION_ORG_SUPERSEDED')
      localStorage.setItem('auth_token', token)
      if (!ownsExplicitSessionOrgChange(change) || getToken() !== token) throw new Error('SESSION_ORG_SUPERSEDED')
      localStorage.setItem('jwt', token)
      if (!installExplicitSessionOrg(token, orgId, next, change)) throw new Error('EXPLICIT_SESSION_STORAGE_FAILED')
    } catch {
      if (!ownsExplicitSessionOrgChange(change)) return false
      try {
        for (const [key, value] of [['auth_token', originalAuth], ['jwt', originalJwt]]) {
          if (!ownsExplicitSessionOrgChange(change)
            || ![originalAuth, token].includes(localStorage.getItem('auth_token'))
            || ![originalJwt, token].includes(localStorage.getItem('jwt'))) return false
          if (value === null) localStorage.removeItem(key!)
          else localStorage.setItem(key!, value!)
        }
        restoreExplicitSessionOrg(change)
      } catch { /* Keep the barrier if rollback storage itself is unavailable. */ }
      return false
    }
    explicitSessionRevision++
    resetSessionBootstrap(true, false, true)
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

  async function publishOrdinary<T>(mutate: () => T): Promise<T> {
    if (ordinaryTakeoverRequired()) {
      await postManagedLogoutUnlocked()
      if (managedResidueRemains()) throw new AuthIdentityLockError('AUTH_IDENTITY_REVOKE_FAILED')
    }
    return runSyncAuthMutation(mutate)
  }

  async function commitOrdinaryAuthTransition<T>(
    mutate: () => T,
    options: { refuseTakeover?: boolean; expectedSignature?: string } = {},
  ): Promise<T> {
    const run = async () => {
      if (options.expectedSignature !== undefined && readAuthSessionSignature() !== options.expectedSignature) {
        throw new AuthIdentityLockError('AUTH_IDENTITY_STALE')
      }
      if (options.refuseTakeover && ordinaryTakeoverRequired()) {
        throw new AuthIdentityLockError('AUTH_IDENTITY_LOCK_REQUIRED')
      }
      return publishOrdinary(mutate)
    }
    if (authIdentityLocksAvailable()) return withAuthIdentityLock(run, { failClosed: true })
    return run()
  }

  async function commitClearedOrdinaryAuth(expected?: AuthRequestStamp): Promise<boolean> {
    const { clearStoredAuthState } = await import('../utils/api')
    const run = async (): Promise<boolean> => {
      if (expected && !sameAuthRequest(expected)) return false
      await publishOrdinary(() => {
        clearToken()
        clearStoredAuthState()
      })
      return true
    }
    if (authIdentityLocksAvailable()) return withAuthIdentityLock(run, { failClosed: true })
    return run()
  }

  async function commitExplicitSessionOrg(token: string, orgId: string, expectedToken: string): Promise<boolean> {
    const run = async () => {
      if (getToken() !== expectedToken) return false
      if (ordinaryTakeoverRequired()) {
        await postManagedLogoutUnlocked()
        if (managedResidueRemains()) throw new AuthIdentityLockError('AUTH_IDENTITY_REVOKE_FAILED')
      }
      if (getToken() !== expectedToken) return false
      return runSyncAuthMutation(() => setExplicitSessionOrg(token, orgId, expectedToken))
    }
    if (authIdentityLocksAvailable()) return withAuthIdentityLock(run, { failClosed: true })
    return run()
  }

  async function refreshDevToken(): Promise<string | null> {
    if (isManagedEntryActive() || managedResidueRemains()) return null
    if (import.meta.env.PROD) return null

    const expectedSignature = readAuthSessionSignature()
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
      await commitOrdinaryAuthTransition(() => {
        setToken(token)
        if (tenantHint) persistTenantHint(tenantHint)
        try {
          if (typeof localStorage !== 'undefined') localStorage.setItem('devToken', token)
        } catch (err) {
          console.warn('[auth] failed to persist devToken alias in localStorage', err)
        }
      }, { refuseTakeover: true, expectedSignature })

      return token
    } catch (err) {
      if (err instanceof AuthIdentityLockError && err.code === 'AUTH_IDENTITY_STALE') return null
      console.warn('[auth] failed to refresh dev token', err)
      return null
    }
  }

  async function ensureToken(): Promise<string | null> {
    const existing = getToken()
    if (existing) return existing
    if (isManagedEntryActive()) return null
    return refreshDevToken()
  }

  function staleManagedAttempt(startedEpoch: number, startedSignature: string): boolean {
    return readManagedEpoch() !== startedEpoch || readAuthSessionSignature() !== startedSignature
  }

  async function bootstrapManagedCookie(
    force: boolean,
    keepSessionOnFailure: boolean,
  ): Promise<SessionBootstrapResult> {
    if (readManagedCompletePending()) {
      return { ok: false, status: 0, payload: null }
    }
    let currentUrl: URL
    try {
      currentUrl = new URL(`${getApiBase()}/api/plm/managed-login/current`, window.location.origin)
      if (currentUrl.origin !== window.location.origin) throw new Error('Managed origin mismatch')
    } catch {
      resetSessionBootstrap(true)
      return { ok: false, status: 0, payload: null }
    }
    const startedEpoch = readManagedEpoch()
    const startedSignature = readAuthSessionSignature()
    const startedToken = readStoredToken()
    const startedIdentity = (() => {
      try { return getAuthPrincipalKey() } catch { return null }
    })()
    const flightKey = `${startedEpoch}:${startedIdentity ?? ''}`
    if (!force && sessionCache && sessionToken === null && sessionIdentity === startedIdentity && startedIdentity) {
      return sessionCache
    }
    if (managedFlight?.key === flightKey) return managedFlight.promise
    const pending = (async (): Promise<SessionBootstrapResult> => {
      const context = readManagedDescriptor()
      const renewalSameSession = sameManagedRenewalSession(
        readManagedRenewalPending(),
        context,
        startedEpoch,
        startedToken,
      )
      if (managedRenewalPendingPresent() && !renewalSameSession) {
        if (!authIdentityLocksAvailable()) return { ok: false, status: 0, payload: null }
        try {
          await withAuthIdentityLock(async () => {
            if (
              managedRenewalPendingPresent()
              && !sameManagedRenewalSession(
                readManagedRenewalPending(),
                readManagedDescriptor(),
                readManagedEpoch(),
                readStoredToken(),
              )
            ) {
              await postManagedLogoutUnlocked()
            }
          }, { failClosed: true })
        } catch {
          return { ok: false, status: 0, payload: null }
        }
        return { ok: false, status: 0, payload: null }
      }
      let renewalUsed = false
      const renewalStops = (outcome: ManagedRenewalOutcome | null): boolean => {
        if (!outcome || outcome.ok) return false
        return outcome.reason === 'transport' || outcome.reason === 'stale' || outcome.reason === 'malformed'
      }
      const renewOnce = async (): Promise<ManagedRenewalOutcome | null> => {
        if (renewalUsed || !continuousRenewalEligible(context)) return null
        renewalUsed = true
        if (!authIdentityLocksAvailable()) return { ok: false, reason: 'unavailable' }
        try {
          return await withAuthIdentityLock(async () => {
            const moved = readManagedEpoch() !== startedEpoch
              || readAuthSessionSignature() !== startedSignature
              || readStoredToken() !== startedToken
            const pendingOwner = readManagedRenewalPending()
            const pendingMismatch = managedRenewalPendingPresent() && !sameManagedRenewalSession(
              pendingOwner,
              readManagedDescriptor(),
              readManagedEpoch(),
              readStoredToken(),
            )
            if (moved || pendingMismatch) {
              if (managedRenewalPendingPresent()) await postManagedLogoutUnlocked()
              return { ok: false, reason: 'stale' }
            }
            return renewManagedContinuousSessionUnlocked()
          }, { failClosed: true })
        } catch (error) {
          if (error instanceof AuthIdentityLockError || error instanceof PlmManagedCompanionError) {
            return { ok: false, reason: 'unavailable' }
          }
          throw error
        }
      }
      const loadCurrent = async (allowRecovery: boolean): Promise<SessionBootstrapResult> => {
        const response = await fetch(currentUrl.toString(), {
          credentials: 'include',
          headers: { accept: 'application/json' },
        }).catch(() => null)
        if (staleManagedAttempt(startedEpoch, startedSignature) || readStoredToken() !== startedToken) {
          return { ok: false, status: 0, payload: null }
        }
        if (!response) {
          if (keepSessionOnFailure) return { ok: false, status: 0, payload: null }
          sessionCache = { ok: false, status: 0, payload: null }
          return sessionCache
        }
        let payload: SessionBootstrapPayload | null = null
        try {
          payload = await response.json() as SessionBootstrapPayload
        } catch {
          payload = null
        }
        if (staleManagedAttempt(startedEpoch, startedSignature) || readStoredToken() !== startedToken) {
          return { ok: false, status: 0, payload: null }
        }
        if (!response.ok) {
          if (allowRecovery && response.status === 401) {
            const outcome = await renewOnce()
            if (outcome?.ok === true) return loadCurrent(false)
            if (renewalStops(outcome)) return { ok: false, status: 0, payload: null }
          }
          if (keepSessionOnFailure && response.status !== 401) {
            return { ok: false, status: response.status, payload }
          }
          clearManagedDescriptor()
          clearStoredUserSnapshot()
          sessionToken = null
          sessionIdentity = null
          sessionCache = { ok: false, status: response.status, payload }
          notifyAuthPrincipalChange()
          return sessionCache
        }
        const data = payload?.data
        const record = data && typeof data === 'object' ? data as Record<string, unknown> : {}
        const user = record.user
        const userId = extractUserId(user)
        if (staleManagedAttempt(startedEpoch, startedSignature) || readStoredToken() !== startedToken) {
          return { ok: false, status: 0, payload: null }
        }
        const installed = installManagedDescriptor(record.managedSession)
        if (!installed || !userId || installed.userId !== userId) {
          clearManagedDescriptor()
          sessionCache = { ok: false, status: 401, payload }
          return sessionCache
        }
        if (readManagedEpoch() !== startedEpoch || readStoredToken() !== startedToken) {
          const current = readManagedDescriptor()
          if (
            current
            && current.userId === installed.userId
            && current.tenantId === installed.tenantId
            && current.sessionId === installed.sessionId
            && current.revision === installed.revision
          ) {
            clearManagedDescriptor()
          }
          return { ok: false, status: 0, payload: null }
        }
        setManagedProbeMarker()
        persistUserSnapshot(user)
        persistTenantHint(installed.tenantId)
        sessionToken = null
        sessionWasExplicit = false
        sessionIdentity = getAuthPrincipalKey()
        sessionCache = { ok: true, status: response.status, payload }
        notifyAuthPrincipalChange()
        return sessionCache
      }
      if (continuousRenewalDue(context)) {
        const outcome = await renewOnce()
        if (renewalStops(outcome)) return { ok: false, status: 0, payload: null }
      }
      return loadCurrent(true)
    })()
    sessionPromise = pending
    managedFlight = { key: flightKey, promise: pending }
    try {
      return await pending
    } finally {
      if (sessionPromise === pending) sessionPromise = null
      if (managedFlight?.promise === pending) managedFlight = null
    }
  }

  /**
   * `keepSessionOnFailure` IS THE ONLY NEW BEHAVIOUR HERE, and it is opt-in: with the default
   * (`false`) every branch below is byte-for-byte today's. It exists for
   * `installPermissionSnapshotRefresh`, a refresh nobody asked for that fires while the user is
   * sitting in the app: a transient 401/offline answer to THAT request must not sign them out,
   * must not drop the stored snapshot, and must not poison `sessionCache` into a login redirect
   * on the next navigation. A user-initiated bootstrap (boot, route guard) still fails exactly
   * as it does today.
   */
  async function bootstrapSession(
    force = false,
    options: { keepSessionOnFailure?: boolean } = {},
  ): Promise<SessionBootstrapResult> {
    const keepSessionOnFailure = options.keepSessionOnFailure === true
    const existingToken = getToken()
    const startedExplicitRevision = explicitSessionRevision
    const startedExplicit = Boolean(explicitSessionOrg(existingToken))
    const startedIdentity = getAuthPrincipalKey()
    if (!existingToken) {
      if (!isManagedEntryActive()) {
        resetSessionBootstrap(true)
        return {
          ok: false,
          status: 401,
          payload: null,
        }
      }
      return bootstrapManagedCookie(force, keepSessionOnFailure)
    }

    const matchingIdentity = (!startedExplicit && !sessionWasExplicit) || sessionIdentity === startedIdentity
    if (!force && sessionCache && sessionToken === existingToken && matchingIdentity) {
      return sessionCache
    }

    if (!force && sessionPromise && sessionToken === existingToken && matchingIdentity) {
      return sessionPromise
    }

    sessionToken = existingToken
    sessionIdentity = startedIdentity
    sessionWasExplicit = startedExplicit
    sessionPromise = (async (): Promise<SessionBootstrapResult> => {
      let resolvedToken = existingToken
      const staleExplicitSession = () => startedExplicitRevision !== explicitSessionRevision
        || ((startedExplicit || Boolean(explicitSessionOrg(getToken())))
          && (resolvedToken !== getToken() || startedIdentity !== getAuthPrincipalKey()))
      const staleResult = (): SessionBootstrapResult => ({ ok: false, status: 0, payload: null })
      let failedRequest = readAuthRequestStamp()
      let response = await fetch(`${getApiBase()}/api/auth/me`, {
        headers: buildAuthHeaders(resolvedToken),
      }).catch(() => null)

      if (staleExplicitSession()) return staleResult()
      if (response?.status === 401 && !startedExplicit) {
        const refreshedToken = await refreshDevToken()
        if (refreshedToken && refreshedToken !== resolvedToken) {
          resolvedToken = refreshedToken
          sessionToken = refreshedToken
          failedRequest = readAuthRequestStamp()
          response = await fetch(`${getApiBase()}/api/auth/me`, {
            headers: buildAuthHeaders(resolvedToken),
          }).catch(() => null)
        }
      }

      if (staleExplicitSession()) return staleResult()
      if (!response) {
        if (keepSessionOnFailure) return { ok: false, status: 0, payload: null }
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

      if (staleExplicitSession()) return staleResult()
      if (!response.ok) {
        // Reported, never acted on: no `clearToken()` (which would clear the token, the snapshot
        // and the tenant hint, and announce a principal change) and no `sessionCache` write
        // (which would make the next route guard redirect to the login page). The last good
        // session stays exactly as it was before this background request.
        if (keepSessionOnFailure) return { ok: false, status: response.status, payload }
        if (response.status === 401) {
          const cleared = await commitClearedOrdinaryAuth(failedRequest)
          if (!cleared) return staleResult()
        }
        sessionCache = {
          ok: false,
          status: response.status,
          payload,
        }
        return sessionCache
      }

      persistUserSnapshot(extractSessionUser(payload))
      if (!explicitSessionOrg(resolvedToken)) persistTenantHint(extractTenantHint(extractSessionUser(payload)))
      sessionCache = {
        ok: true,
        status: response.status,
        payload,
      }
      return sessionCache
    })()

    const pending = sessionPromise
    try {
      return await pending
    } finally {
      if (sessionPromise === pending) sessionPromise = null
    }
  }

  function primeSession(payload: SessionBootstrapPayload | null) {
    const token = getToken()
    const explicitOrg = explicitSessionOrg(token)
    if (explicitOrg && (extractTenantHint(extractSessionUser(payload)) !== explicitOrg
      || extractUserId(extractSessionUser(payload)) !== extractUserId(parseJwtPayload(token!)))) return
    sessionToken = token
    sessionIdentity = getAuthPrincipalKey()
    sessionWasExplicit = Boolean(explicitOrg)
    sessionCache = {
      ok: true,
      status: 200,
      payload,
    }
    sessionPromise = null
    persistUserSnapshot(extractSessionUser(payload))
    if (!explicitOrg) persistTenantHint(extractTenantHint(extractSessionUser(payload)))
  }

  function buildAuthHeaders(tokenOverride?: string | null): Record<string, string> {
    const headers: Record<string, string> = {}
    const token = tokenOverride || getToken()
    if (token) headers['Authorization'] = `Bearer ${token}`
    const tenantHint = explicitSessionOrg(token) || readStoredTenantHint() || readLocationTenantHint() || extractTenantHint(parseJwtPayload(token || ''))
    if (tenantHint) headers['x-tenant-id'] = tenantHint
    // Dev/test fallback aligns with backend flag behaviour
    if (!headers['Authorization'] && !isManagedEntryActive() && !managedResidueRemains()) headers['x-user-id'] = 'dev-user'
    return headers
  }

  function hasAdminAccess(): boolean {
    return getAccessSnapshot().isAdmin
  }

  /**
   * Unchanged behaviour, one owner: the admin/roles short-circuit stays here (it needs the session
   * snapshot), and the code algebra below it now lives in `utils/permission-match.ts`, which the
   * server's `packages/core-backend/src/auth/permission-match.ts` mirrors against a shared truth
   * table. Before this, the server had no matcher at all and App Center shipped zero server-side
   * filtering; inlining the algebra a second time on the server would have been the drift.
   */
  function hasPermission(requiredPermission: string): boolean {
    const normalized = String(requiredPermission || '').trim()
    if (!normalized) return true

    const snapshot = getAccessSnapshot()
    if (snapshot.isAdmin || snapshot.roles.includes('admin')) return true

    return matchesPermission(snapshot.permissions, normalized)
  }

  function getCurrentUser(): SessionUserRecord | null {
    try {
      if ((sessionWasExplicit || Boolean(explicitSessionOrg(getToken()))) && sessionIdentity !== getAuthPrincipalKey()) return null
    } catch { return null }
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
    commitOrdinaryAuthTransition,
    commitClearedOrdinaryAuth,
    commitExplicitSessionOrg,
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

/*
 * HOW A TAB THAT IS ALREADY OPEN LEARNS IT WAS GRANTED A PERMISSION.
 *
 * Every permission read in this app answers from the snapshot `persistUserSnapshot` writes into
 * `localStorage` (`getAccessSnapshot`), and that snapshot was written once per page load: the
 * route guard calls `bootstrapSession()` unforced, which serves `sessionCache` for the rest of
 * the tab's life. The listeners that already re-read the snapshot on `storage` / `focus`
 * (`src/approvals/permissions.ts`) therefore had nothing new to read, and an administrator's
 * grant only surfaced after a page reload. This is the missing writer, not a new permission
 * model: the server remains the only authority, this just re-asks it.
 *
 * WHY `focus` AND NOT ALSO `visibilitychange`: the snapshot consumers in this app listen on
 * `focus` (plus `storage`); `visibilitychange` is used once, for an unrelated dialog concern in
 * `multitable/views/MultitableWorkbench.vue`. Binding both would double-fire on every tab
 * switch for no extra coverage.
 */

/**
 * Hard minimum spacing between focus-driven refreshes.
 *
 * 60s IS THE SERVER'S OWN NUMBER, not a guess: `listUserPermissions` memoises a user's
 * permission codes for `RBAC_CACHE_TTL_MS` (default `60000`) in
 * `packages/core-backend/src/rbac/service.ts`, and `/api/auth/me` re-hydrates through it
 * (`routes/auth.ts` -> `AuthService.verifyToken` -> `getUserById` -> `resolveRbacProfile`). Two
 * refreshes inside one TTL window can only return the SAME permission set, so a shorter
 * interval buys nothing and costs a request per alt-tab. If the server TTL ever changes, this
 * should follow it.
 */
const PERMISSION_SNAPSHOT_REFRESH_MIN_INTERVAL_MS = 60_000

let permissionSnapshotRefreshBound = false
let lastPermissionSnapshotRefreshAt = Number.NEGATIVE_INFINITY
let permissionSnapshotRefreshInFlight = false

function readUserSnapshotEntries(): Record<string, string | null> {
  const entries: Record<string, string | null> = {}
  for (const key of USER_SNAPSHOT_KEYS) {
    try {
      entries[key] = typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
    } catch {
      entries[key] = null
    }
  }
  return entries
}

/**
 * Re-emit the `storage` event this document's own write did NOT produce.
 *
 * A same-document `localStorage` write notifies other documents only, so without this the
 * in-tab snapshot listeners would not observe the refreshed permissions until some later focus.
 * Only genuinely changed keys are announced. Every `storage` listener in this app either filters
 * on `key` (`useAuth` above, `useLocale`) or re-reads storage idempotently (`usePlmAuthStatus`,
 * `ElearningAppInstallationSection`, `approvals/permissions`), so this is a notification, never
 * a new input: it carries no value a listener could not read for itself.
 */
function announceUserSnapshotChange(
  before: Record<string, string | null>,
  after: Record<string, string | null>,
): void {
  if (typeof window === 'undefined' || typeof StorageEvent === 'undefined') return
  let storageArea: Storage | undefined
  try {
    storageArea = typeof Storage !== 'undefined' && typeof localStorage !== 'undefined'
      && localStorage instanceof Storage
      ? localStorage
      : undefined
  } catch {
    storageArea = undefined
  }
  for (const key of USER_SNAPSHOT_KEYS) {
    if (before[key] === after[key]) continue
    try {
      window.dispatchEvent(new StorageEvent('storage', {
        key,
        oldValue: before[key],
        newValue: after[key],
        ...(storageArea ? { storageArea } : {}),
      }))
    } catch (err) {
      console.warn('[auth] failed to announce refreshed user snapshot', err)
    }
  }
}

async function refreshUserSnapshotOnFocus(): Promise<void> {
  // No session: return BEFORE touching `bootstrapSession` at all. Its no-token branch clears the
  // stored snapshot and announces a principal change, which a background refresh must never do.
  if (!readStoredToken() && !isManagedEntryActive()) return
  // `focus` can reach a document that is not actually on screen; a hidden document is not "the
  // user came back to the tab".
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  if (permissionSnapshotRefreshInFlight) return
  const now = Date.now()
  // Charged at ATTEMPT time, not on success, so a failing or slow server cannot turn rapid
  // alt-tabbing into a request storm.
  if (now - lastPermissionSnapshotRefreshAt < PERMISSION_SNAPSHOT_REFRESH_MIN_INTERVAL_MS) return
  lastPermissionSnapshotRefreshAt = now
  permissionSnapshotRefreshInFlight = true
  const before = readUserSnapshotEntries()
  try {
    // `keepSessionOnFailure`: a 401 or an offline answer to a refresh the user never asked for
    // leaves the session exactly as it was. See `bootstrapSession`.
    const result = await useAuth().bootstrapSession(true, { keepSessionOnFailure: true })
    if (!result.ok) return
    announceUserSnapshotChange(before, readUserSnapshotEntries())
  } catch (err) {
    console.warn('[auth] permission snapshot refresh failed', err)
  } finally {
    permissionSnapshotRefreshInFlight = false
  }
}

/**
 * Bind the focus refresh once per document. Module-level flag, same idiom as
 * `bindApprovalAccessRefresh` in `src/approvals/permissions.ts`: calling this from several places
 * (or from a component that mounts many times) still installs exactly one listener and therefore
 * still produces at most one refresh per interval. Called once from the app entry point; there is
 * deliberately no uninstall, because the listener lives as long as the document does.
 */
export function installPermissionSnapshotRefresh(): void {
  if (permissionSnapshotRefreshBound || typeof window === 'undefined') return
  permissionSnapshotRefreshBound = true
  window.addEventListener('focus', () => {
    void refreshUserSnapshotOnFocus()
  })
}
