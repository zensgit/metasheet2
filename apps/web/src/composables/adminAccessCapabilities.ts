/**
 * Authoritative platform-admin / management-scope capability.
 *
 * GET /api/admin/access-capabilities is the only grant for admin navigation and the
 * platform-admin route guard. Transport errors, malformed bodies, and a missing
 * session fail closed. A late response whose session signature or generation no
 * longer matches is discarded, including logout that races the read.
 *
 * A successful answer is not reused. The same JWT can lose admin or gain scope in
 * another process, so every route entry and window focus reads the server again.
 * The only short-circuit is an in-flight request for the same signature.
 *
 * Another tab's token write does not notify `onAuthPrincipalChange`. A `storage`
 * event for an auth token key clears the published grant immediately and reads
 * the token now in storage. Unrelated keys are ignored. Focus with no token
 * reconciles and drops that grant before returning, so a cross-tab logout cannot
 * keep admin links.
 */
import { reactive } from 'vue'
import { apiFetch } from '../utils/api'
import { TOKEN_KEYS, onAuthPrincipalChange, readAuthSessionSignature, readStoredToken } from './authPrincipal'

export const ADMIN_ACCESS_CAPABILITIES_PATH = '/api/admin/access-capabilities'

export type AdminAccessCapabilities = {
  isPlatformAdmin: boolean
  canManageScope: boolean
  /**
   * Valid live RBAC admin. Missing or any non-true value is false. A legacy
   * `users.role` admin can have `isPlatformAdmin: true` with this flag false.
   */
  canManagePermissions?: boolean
  delegableNamespaces: string[]
}

export const adminAccessCapabilitiesState = reactive({
  loaded: false,
  isPlatformAdmin: false,
  canManageScope: false,
  canManagePermissions: false,
  delegableNamespaces: [] as string[],
})

type InflightRead = {
  signature: string
  generation: number
  promise: Promise<AdminAccessCapabilities>
}

let capabilityGeneration = 0
let publishedSignature: string | null = null
let publishedGeneration = 0
let inflight: InflightRead | null = null

export function emptyAdminAccessCapabilities(): AdminAccessCapabilities {
  return {
    isPlatformAdmin: false,
    canManageScope: false,
    canManagePermissions: false,
    delegableNamespaces: [],
  }
}

function writeState(value: AdminAccessCapabilities, loaded: boolean): void {
  adminAccessCapabilitiesState.loaded = loaded
  adminAccessCapabilitiesState.isPlatformAdmin = value.isPlatformAdmin === true
  adminAccessCapabilitiesState.canManageScope = value.canManageScope === true
  adminAccessCapabilitiesState.canManagePermissions = value.canManagePermissions === true
  adminAccessCapabilitiesState.delegableNamespaces = value.delegableNamespaces.filter((item) => item.trim().length > 0)
}

function clearPublishedAuthority(): void {
  publishedSignature = null
  publishedGeneration = 0
  writeState(emptyAdminAccessCapabilities(), false)
}

export function resetAdminAccessCapabilities(): void {
  capabilityGeneration += 1
  inflight = null
  clearPublishedAuthority()
}

/**
 * Drop a published answer that belongs to a different session. Capability reads
 * call this so a storage swap cannot keep the previous identity's flags on screen.
 */
export function reconcileAdminAccessCapabilities(): void {
  const signature = readAuthSessionSignature()
  if (publishedSignature !== null && publishedSignature !== signature) {
    capabilityGeneration += 1
    inflight = null
    clearPublishedAuthority()
    return
  }
  if (inflight && inflight.signature !== signature) {
    capabilityGeneration += 1
    inflight = null
  }
}

function normalize(value: AdminAccessCapabilities): AdminAccessCapabilities {
  return {
    isPlatformAdmin: value.isPlatformAdmin === true,
    canManageScope: value.canManageScope === true,
    canManagePermissions: value.canManagePermissions === true,
    delegableNamespaces: Array.isArray(value.delegableNamespaces)
      ? value.delegableNamespaces.filter((item) => typeof item === 'string' && item.trim().length > 0)
      : [],
  }
}

/** Test seam. Publishes one answer for the current signature without skipping the next server read. */
export function publishAdminAccessCapabilities(value: AdminAccessCapabilities): void {
  const normalized = normalize(value)
  capabilityGeneration += 1
  inflight = null
  publishedSignature = readAuthSessionSignature()
  publishedGeneration = capabilityGeneration
  writeState(normalized, true)
}

function parseCapabilities(payload: unknown): AdminAccessCapabilities | null {
  if (!payload || typeof payload !== 'object') return null
  const root = payload as Record<string, unknown>
  if (root.ok !== true || !root.data || typeof root.data !== 'object') return null
  const data = root.data as Record<string, unknown>
  if (typeof data.isPlatformAdmin !== 'boolean' || typeof data.canManageScope !== 'boolean') return null
  if (!Array.isArray(data.delegableNamespaces) || data.delegableNamespaces.some((item) => typeof item !== 'string')) {
    return null
  }
  return {
    isPlatformAdmin: data.isPlatformAdmin,
    canManageScope: data.canManageScope,
    canManagePermissions: data.canManagePermissions === true,
    delegableNamespaces: data.delegableNamespaces.filter((item) => item.trim().length > 0),
  }
}

function stillCurrent(generation: number, signature: string): boolean {
  return generation === capabilityGeneration && readAuthSessionSignature() === signature
}

function discardStale(signature: string, generation: number): AdminAccessCapabilities {
  if (publishedSignature === signature && publishedGeneration === generation) {
    clearPublishedAuthority()
  }
  return emptyAdminAccessCapabilities()
}

function applyDenied(generation: number, signature: string): AdminAccessCapabilities {
  const value = emptyAdminAccessCapabilities()
  if (!stillCurrent(generation, signature)) return discardStale(signature, generation)
  writeState(value, true)
  publishedSignature = signature
  publishedGeneration = generation
  return value
}

function applyGrant(value: AdminAccessCapabilities, generation: number, signature: string): AdminAccessCapabilities {
  if (!stillCurrent(generation, signature)) return discardStale(signature, generation)
  writeState(value, true)
  publishedSignature = signature
  publishedGeneration = generation
  return value
}

async function readCapabilities(signature: string, generation: number): Promise<AdminAccessCapabilities> {
  let token: string | null = null
  try {
    token = readStoredToken()
  } catch {
    token = null
  }
  if (!token) return applyDenied(generation, signature)

  try {
    const response = await apiFetch(ADMIN_ACCESS_CAPABILITIES_PATH, { suppressUnauthorizedRedirect: true })
    if (!stillCurrent(generation, signature)) return discardStale(signature, generation)
    const payload = await response.json().catch(() => null)
    if (!stillCurrent(generation, signature)) return discardStale(signature, generation)
    if (!response.ok) return applyDenied(generation, signature)
    const parsed = parseCapabilities(payload)
    if (!parsed) return applyDenied(generation, signature)
    return applyGrant(parsed, generation, signature)
  } catch {
    if (!stillCurrent(generation, signature)) return discardStale(signature, generation)
    return applyDenied(generation, signature)
  }
}

export async function refreshAdminAccessCapabilities(): Promise<AdminAccessCapabilities> {
  reconcileAdminAccessCapabilities()
  const signature = readAuthSessionSignature()
  const generation = capabilityGeneration
  if (inflight && inflight.signature === signature && inflight.generation === generation) {
    return inflight.promise
  }
  const promise = readCapabilities(signature, generation).finally(() => {
    if (inflight?.promise === promise) inflight = null
  })
  inflight = { signature, generation, promise }
  return promise
}

onAuthPrincipalChange(() => {
  resetAdminAccessCapabilities()
})

type CapabilityEventHost = Window & {
  __metasheetRefreshAdminAccess?: () => void
  __metasheetAdminAccessOnStorage?: (event: StorageEvent) => void
  __metasheetAdminAccessFocusBound?: boolean
  __metasheetAdminAccessStorageBound?: boolean
}

function refreshOnFocus(): void {
  let token: string | null = null
  try {
    token = readStoredToken()
  } catch {
    token = null
  }
  if (!token) {
    reconcileAdminAccessCapabilities()
    if (
      adminAccessCapabilitiesState.isPlatformAdmin
      || adminAccessCapabilitiesState.canManageScope
      || adminAccessCapabilitiesState.canManagePermissions
    ) {
      resetAdminAccessCapabilities()
    }
    return
  }
  void refreshAdminAccessCapabilities()
}

function isAuthTokenStorageKey(key: string | null): boolean {
  return key === null || (TOKEN_KEYS as readonly string[]).includes(key)
}

function onAuthStorage(event: StorageEvent): void {
  if (event.storageArea && event.storageArea !== localStorage) return
  if (!isAuthTokenStorageKey(event.key)) return
  const signature = readAuthSessionSignature()
  if (publishedSignature !== null && publishedSignature !== signature) {
    capabilityGeneration += 1
    inflight = null
    clearPublishedAuthority()
  } else if (inflight && inflight.signature !== signature) {
    capabilityGeneration += 1
    inflight = null
  }
  void refreshAdminAccessCapabilities()
}

if (typeof window !== 'undefined') {
  const host = window as CapabilityEventHost
  host.__metasheetRefreshAdminAccess = refreshOnFocus
  host.__metasheetAdminAccessOnStorage = onAuthStorage
  if (!host.__metasheetAdminAccessFocusBound) {
    host.__metasheetAdminAccessFocusBound = true
    window.addEventListener('focus', () => {
      host.__metasheetRefreshAdminAccess?.()
    })
  }
  if (!host.__metasheetAdminAccessStorageBound) {
    host.__metasheetAdminAccessStorageBound = true
    window.addEventListener('storage', (event) => {
      host.__metasheetAdminAccessOnStorage?.(event)
    })
  }
}
