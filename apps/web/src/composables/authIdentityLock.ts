import {
  isManagedEntryLocation,
  MANAGED_PROBE_MARKER_KEY,
  readManagedDescriptor,
  readManagedProbeMarker,
} from './authPrincipal'

/** Origin-wide exclusive lock shared by cooperating normal-app identity writers. */
export const AUTH_IDENTITY_LOCK_NAME = 'metasheet-auth-identity-v1'

/** Crash marker for a complete POST that may already have stored a session cookie. Not a credential. */
export const MANAGED_COMPLETE_PENDING_KEY = 'metasheet_managed_complete_pending'

/**
 * Crash marker for a renew-recovery POST whose response was lost.
 * Distinct from an initial complete. The value is the descriptor identity and epoch.
 * It is not a bearer and not a session signature. A stored bearer makes the marker unreadable.
 */
export const MANAGED_RENEWAL_PENDING_KEY = 'metasheet_managed_renewal_pending'

export type ManagedRenewalPendingOwner = {
  userId: string
  tenantId: string
  sessionId: string
  revision: number
  epoch: number
}

export class AuthIdentityLockError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'AuthIdentityLockError'
    this.code = code
  }
}

/**
 * Depth is non-zero only while `runSyncAuthMutation` is inside its synchronous callback.
 * It is reset before that function returns, so it is never still set across an await.
 * A second async turn must not observe this and skip `navigator.locks`.
 */
let syncMutationDepth = 0

type LockCallback = () => unknown

function lockRequest():
  | ((name: string, options: { mode: 'exclusive' }, callback: LockCallback) => Promise<unknown>)
  | null {
  if (typeof navigator === 'undefined') return null
  const locks = (navigator as Navigator & { locks?: { request?: unknown } }).locks
  if (!locks || typeof locks.request !== 'function') return null
  return locks.request.bind(locks) as (
    name: string,
    options: { mode: 'exclusive' },
    callback: LockCallback,
  ) => Promise<unknown>
}

export function authIdentityLocksAvailable(): boolean {
  return lockRequest() !== null
}

export function syncMutationOpen(): boolean {
  return syncMutationDepth > 0
}

export function runSyncAuthMutation<T>(mutate: () => T): T {
  syncMutationDepth += 1
  try {
    const value = mutate()
    if (value && typeof (value as { then?: unknown }).then === 'function') {
      throw new AuthIdentityLockError('AUTH_IDENTITY_MUTATION_ASYNC')
    }
    return value
  } finally {
    syncMutationDepth -= 1
  }
}

/**
 * Every external call requests the lock when the browser has one.
 * There is no async reentry shortcut: a second call while the holder awaits network queues here.
 */
export async function withAuthIdentityLock<T>(
  body: () => Promise<T> | T,
  options: { failClosed: boolean },
): Promise<T> {
  const request = lockRequest()
  if (!request) {
    if (options.failClosed) throw new AuthIdentityLockError('AUTH_IDENTITY_LOCK_UNAVAILABLE')
    return await body()
  }
  return await request(AUTH_IDENTITY_LOCK_NAME, { mode: 'exclusive' }, async () => body()) as T
}

export function readManagedCompletePending(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false
    return localStorage.getItem(MANAGED_COMPLETE_PENDING_KEY) === '1'
  } catch {
    return true
  }
}

function renewalOwner(value: unknown): ManagedRenewalPendingOwner | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.userId !== 'string' || record.userId.length === 0) return null
  if (typeof record.tenantId !== 'string' || record.tenantId.length === 0) return null
  if (typeof record.sessionId !== 'string' || record.sessionId.length === 0) return null
  if (typeof record.revision !== 'number' || !Number.isInteger(record.revision) || record.revision < 1) return null
  if (typeof record.epoch !== 'number' || !Number.isInteger(record.epoch) || record.epoch < 0) return null
  // A bearer, or a signature that embeds one, is not an owner. Null is the absent ordinary token.
  if ('token' in record && record.token !== null) return null
  if ('signature' in record && record.signature != null) return null
  return {
    userId: record.userId,
    tenantId: record.tenantId,
    sessionId: record.sessionId,
    revision: record.revision,
    epoch: record.epoch,
  }
}

/** Parsed same-session owner. A present but unreadable value is not a recoverable owner. */
export function readManagedRenewalPending(): ManagedRenewalPendingOwner | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(MANAGED_RENEWAL_PENDING_KEY)
    if (raw === null) return null
    return renewalOwner(JSON.parse(raw))
  } catch {
    return null
  }
}

/** Any stored renewal marker, including one this document cannot parse. */
export function managedRenewalPendingPresent(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false
    return localStorage.getItem(MANAGED_RENEWAL_PENDING_KEY) !== null
  } catch {
    return true
  }
}

export function sameManagedRenewalSession(
  owner: ManagedRenewalPendingOwner | null,
  descriptor: { userId: string, tenantId: string, sessionId: string, revision: number } | null,
  epoch: number,
  token: string | null,
): boolean {
  if (!owner || !descriptor) return false
  // An ordinary bearer is a different session. The marker does not carry that secret.
  if (token !== null) return false
  return owner.userId === descriptor.userId
    && owner.tenantId === descriptor.tenantId
    && owner.sessionId === descriptor.sessionId
    && owner.revision === descriptor.revision
    && owner.epoch === epoch
}

export function markManagedRenewalPending(owner: ManagedRenewalPendingOwner): void {
  if (typeof localStorage === 'undefined') throw new AuthIdentityLockError('AUTH_IDENTITY_PENDING_STORAGE')
  const encoded = JSON.stringify({
    userId: owner.userId,
    tenantId: owner.tenantId,
    sessionId: owner.sessionId,
    revision: owner.revision,
    epoch: owner.epoch,
  })
  try {
    localStorage.setItem(MANAGED_RENEWAL_PENDING_KEY, encoded)
    if (localStorage.getItem(MANAGED_RENEWAL_PENDING_KEY) !== encoded) {
      throw new AuthIdentityLockError('AUTH_IDENTITY_PENDING_STORAGE')
    }
  } catch (error) {
    if (error instanceof AuthIdentityLockError) throw error
    throw new AuthIdentityLockError('AUTH_IDENTITY_PENDING_STORAGE')
  }
}

export function clearManagedRenewalPending(): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(MANAGED_RENEWAL_PENDING_KEY)
    if (localStorage.getItem(MANAGED_RENEWAL_PENDING_KEY) !== null) {
      throw new AuthIdentityLockError('AUTH_IDENTITY_PENDING_STORAGE')
    }
  } catch (error) {
    if (error instanceof AuthIdentityLockError) throw error
    throw new AuthIdentityLockError('AUTH_IDENTITY_PENDING_STORAGE')
  }
}

/** Marker, in-memory descriptor, pending complete, or lost renewal. The entry URL is not residue. */
export function managedResidueRemains(): boolean {
  if (readManagedProbeMarker()) return true
  if (readManagedDescriptor()) return true
  if (managedRenewalPendingPresent()) return true
  return readManagedCompletePending()
}

/** Pre-publish check. Includes this document's managed entry location so a return page still revokes first. */
export function ordinaryTakeoverRequired(): boolean {
  return managedResidueRemains() || isManagedEntryLocation()
}

export function assertOrdinarySyncWriterAllowed(): void {
  if (syncMutationDepth > 0) return
  if (authIdentityLocksAvailable() || ordinaryTakeoverRequired()) {
    throw new AuthIdentityLockError('AUTH_IDENTITY_LOCK_REQUIRED')
  }
}

export function markManagedCompletePending(): void {
  if (typeof localStorage === 'undefined') throw new AuthIdentityLockError('AUTH_IDENTITY_PENDING_STORAGE')
  try {
    localStorage.setItem(MANAGED_COMPLETE_PENDING_KEY, '1')
    if (localStorage.getItem(MANAGED_COMPLETE_PENDING_KEY) !== '1') {
      throw new AuthIdentityLockError('AUTH_IDENTITY_PENDING_STORAGE')
    }
  } catch (error) {
    if (error instanceof AuthIdentityLockError) throw error
    throw new AuthIdentityLockError('AUTH_IDENTITY_PENDING_STORAGE')
  }
}

export function clearManagedCompletePending(): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(MANAGED_COMPLETE_PENDING_KEY)
    if (localStorage.getItem(MANAGED_COMPLETE_PENDING_KEY) !== null) {
      throw new AuthIdentityLockError('AUTH_IDENTITY_PENDING_STORAGE')
    }
  } catch (error) {
    if (error instanceof AuthIdentityLockError) throw error
    throw new AuthIdentityLockError('AUTH_IDENTITY_PENDING_STORAGE')
  }
}

export function writeManagedProbeMarkerOrThrow(): void {
  if (typeof localStorage === 'undefined') throw new AuthIdentityLockError('AUTH_IDENTITY_MARKER_STORAGE')
  try {
    localStorage.setItem(MANAGED_PROBE_MARKER_KEY, '1')
    if (localStorage.getItem(MANAGED_PROBE_MARKER_KEY) !== '1') {
      throw new AuthIdentityLockError('AUTH_IDENTITY_MARKER_STORAGE')
    }
  } catch (error) {
    if (error instanceof AuthIdentityLockError) throw error
    throw new AuthIdentityLockError('AUTH_IDENTITY_MARKER_STORAGE')
  }
}
