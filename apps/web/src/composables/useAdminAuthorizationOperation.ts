import { readonly, ref, type DeepReadonly, type Ref } from 'vue'
import { randomUuid } from '../utils/uuid'
import {
  ADMIN_AUTHORIZATION_OPERATIONS_PATH,
  ADMIN_AUTHORIZATION_PENDING_FORMAT_VERSION,
  ADMIN_AUTHORIZATION_PENDING_STORAGE_KEY,
  ADMIN_AUTHORIZATION_PREVIEW_PATH,
  adminAuthorizationOperationLookupPath,
  isAdminAuthorizationOperationUuid,
  readAdminAuthorizationLookup,
  readAdminAuthorizationPendingFile,
  readAdminAuthorizationPreview,
  readAdminAuthorizationRequest,
  serializeAdminAuthorizationPendingFile,
  type AdminAuthorizationImpact,
  type AdminAuthorizationPendingEntry,
  type AdminAuthorizationPendingFile,
  type AdminAuthorizationPreview,
  type AdminAuthorizationReceipt,
  type AdminAuthorizationRequest,
  type AdminAuthorizationTransport,
  type AdminAuthorizationTransportResponse,
} from '../utils/adminAuthorizationOperation'

export type AdminAuthorizationOperationPhase =
  | 'idle'
  | 'previewing'
  | 'awaiting_confirmation'
  | 'committing'
  | 'pending'
  | 'validation_failed'
  | 'forbidden'
  | 'unverified_no_read'
  | 'committed'
  | 'verified'

/** Receipt success is `receipt_only` until the caller live-reads permissions. */
export type AdminAuthorizationOperationDetail =
  | 'none'
  | 'needs_repreview'
  | 'no_access'
  | 'unverified_no_read'
  | 'pending'
  | 'receipt_only'
  | 'verified'
  | 'preview_failed'
  | 'storage_blocked'

export interface AdminAuthorizationOperationDeps {
  transport: AdminAuthorizationTransport
  getPrincipalId: () => string
  getTargetId: () => string
  /** Live permission read. Only a strict `true` can mark the operation verified. */
  verifyLive: () => Promise<boolean>
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
  createClientOperationId?: () => string
}

export interface AdminAuthorizationOperation {
  phase: DeepReadonly<Ref<AdminAuthorizationOperationPhase>>
  detail: DeepReadonly<Ref<AdminAuthorizationOperationDetail>>
  verified: DeepReadonly<Ref<boolean>>
  clientOperationId: DeepReadonly<Ref<string | null>>
  expectedVersion: DeepReadonly<Ref<string | null>>
  impact: DeepReadonly<Ref<AdminAuthorizationImpact | null>>
  receipt: DeepReadonly<Ref<AdminAuthorizationReceipt | null>>
  whenSettled: () => Promise<void>
  syncContext: () => void
  preview: (request: AdminAuthorizationRequest, signal?: AbortSignal) => Promise<void>
  confirm: (signal?: AbortSignal) => Promise<void>
  lookup: (signal?: AbortSignal) => Promise<void>
  verify: () => Promise<void>
}

interface OpenPreview {
  request: AdminAuthorizationRequest
  expectedVersion: string
}

function browserPendingStore(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    if (typeof sessionStorage === 'undefined') return null
    return sessionStorage
  } catch {
    return null
  }
}

export function useAdminAuthorizationOperation(deps: AdminAuthorizationOperationDeps): AdminAuthorizationOperation {
  const storage = deps.storage === undefined ? browserPendingStore() : deps.storage
  const phase = ref<AdminAuthorizationOperationPhase>('idle')
  const detail = ref<AdminAuthorizationOperationDetail>('none')
  const verified = ref(false)
  const clientOperationId = ref<string | null>(null)
  const expectedVersion = ref<string | null>(null)
  const impact = ref<AdminAuthorizationImpact | null>(null)
  const receipt = ref<AdminAuthorizationReceipt | null>(null)

  let generation = 0
  let previewEpoch = 0
  let boundPrincipal = ''
  let boundTarget = ''
  let confirmLocked = false
  let heldId: string | null = null
  let openPreview: OpenPreview | null = null
  let storageUntrusted = false
  let tail: Promise<void> = Promise.resolve()

  function track(work: Promise<void>): Promise<void> {
    const settled = work.then(() => undefined, () => undefined)
    tail = tail.then(() => settled)
    return work
  }

  function resetView(): void {
    phase.value = 'idle'
    detail.value = 'none'
    verified.value = false
    clientOperationId.value = null
    expectedVersion.value = null
    impact.value = null
    receipt.value = null
    openPreview = null
    heldId = null
  }

  function readStore(): AdminAuthorizationPendingFile | 'empty' | 'untrusted' {
    if (!storage) return 'untrusted'
    let raw: string | null
    try {
      raw = storage.getItem(ADMIN_AUTHORIZATION_PENDING_STORAGE_KEY)
    } catch {
      return 'untrusted'
    }
    // A missing key is a first use. An empty string is a damaged record.
    if (raw === null) return 'empty'
    if (raw === '') return 'untrusted'
    try {
      const parsed = readAdminAuthorizationPendingFile(JSON.parse(raw) as unknown)
      return parsed ?? 'untrusted'
    } catch {
      return 'untrusted'
    }
  }

  function writeStore(file: AdminAuthorizationPendingFile): boolean {
    if (!storage) return false
    try {
      storage.setItem(ADMIN_AUTHORIZATION_PENDING_STORAGE_KEY, serializeAdminAuthorizationPendingFile(file))
      storageUntrusted = false
      return true
    } catch {
      return false
    }
  }

  function matchingEntry(file: AdminAuthorizationPendingFile): AdminAuthorizationPendingEntry | null {
    return file.entries.find((entry) => entry.principalId === boundPrincipal && entry.targetId === boundTarget) ?? null
  }

  function matchingStored(): AdminAuthorizationPendingEntry | 'untrusted' | null {
    const current = readStore()
    if (current === 'untrusted') return 'untrusted'
    if (current === 'empty') return null
    return matchingEntry(current)
  }

  function remember(entry: AdminAuthorizationPendingEntry): 'stored' | 'conflict' | 'blocked' {
    const current = readStore()
    if (current === 'untrusted') {
      storageUntrusted = true
      return 'blocked'
    }
    const entries = current === 'empty' ? [] : current.entries
    const existing = entries.find((item) => (
      item.principalId === entry.principalId && item.targetId === entry.targetId
    ))
    if (existing) {
      return existing.clientOperationId === entry.clientOperationId ? 'stored' : 'conflict'
    }
    return writeStore({
      formatVersion: ADMIN_AUTHORIZATION_PENDING_FORMAT_VERSION,
      entries: [...entries, entry],
    }) ? 'stored' : 'blocked'
  }

  function forget(entry: AdminAuthorizationPendingEntry): void {
    const current = readStore()
    if (current === 'untrusted' || current === 'empty') return
    writeStore({
      formatVersion: ADMIN_AUTHORIZATION_PENDING_FORMAT_VERSION,
      entries: current.entries.filter((item) => (
        item.principalId !== entry.principalId
        || item.targetId !== entry.targetId
        || item.clientOperationId !== entry.clientOperationId
      )),
    })
  }

  function hold(entry: AdminAuthorizationPendingEntry, nextPhase: 'pending' | 'committed'): void {
    heldId = entry.clientOperationId
    clientOperationId.value = entry.clientOperationId
    openPreview = null
    verified.value = false
    phase.value = nextPhase
    detail.value = nextPhase === 'committed' ? 'receipt_only' : 'pending'
  }

  function adoptStored(): 'pending' | 'blocked' | 'none' {
    const current = readStore()
    if (current === 'untrusted') {
      storageUntrusted = true
      phase.value = 'pending'
      detail.value = 'storage_blocked'
      verified.value = false
      return 'blocked'
    }
    storageUntrusted = false
    if (current === 'empty') return 'none'
    const entry = matchingEntry(current)
    if (!entry) return 'none'
    hold(entry, 'pending')
    return 'pending'
  }

  function still(ticket: number, principalId: string, targetId: string): boolean {
    if (ticket !== generation || deps.getPrincipalId() !== principalId || deps.getTargetId() !== targetId) {
      rebind()
      return false
    }
    return true
  }

  function idsReady(): boolean {
    return boundPrincipal.trim().length > 0 && boundTarget.trim().length > 0
  }

  function blocksNewOperation(): boolean {
    const current = phase.value
    return current === 'pending'
      || current === 'committing'
      || current === 'committed'
      || current === 'unverified_no_read'
  }

  function previewResponseCurrent(epoch: number): boolean {
    if (epoch !== previewEpoch || heldId || confirmLocked || storageUntrusted) return false
    return phase.value !== 'verified' && !blocksNewOperation()
  }

  function showReceipt(parsed: Extract<ReturnType<typeof readAdminAuthorizationLookup>, { status: 'committed' }>): void {
    if (parsed.receipt.targetUserId !== boundTarget) {
      receipt.value = null
      verified.value = false
      hold({ principalId: boundPrincipal, targetId: boundTarget, clientOperationId: parsed.clientOperationId }, 'pending')
      return
    }
    receipt.value = parsed.receipt
    impact.value = parsed.receipt.impact
    hold(
      { principalId: boundPrincipal, targetId: boundTarget, clientOperationId: parsed.clientOperationId },
      'committed',
    )
  }

  function enterPending(id: string | null): void {
    receipt.value = null
    verified.value = false
    if (id && isAdminAuthorizationOperationUuid(id)) {
      hold({ principalId: boundPrincipal, targetId: boundTarget, clientOperationId: id }, 'pending')
      return
    }
    openPreview = null
    phase.value = 'pending'
    detail.value = 'pending'
  }

  function clearHeldOutcome(): void {
    if (heldId) {
      forget({ principalId: boundPrincipal, targetId: boundTarget, clientOperationId: heldId })
    }
    heldId = null
    openPreview = null
    receipt.value = null
    verified.value = false
  }

  function applyCommit(response: AdminAuthorizationTransportResponse, id: string): void {
    if (response.status === 400 || response.status === 409) {
      clearHeldOutcome()
      phase.value = 'validation_failed'
      detail.value = 'needs_repreview'
      return
    }
    if (response.status === 403) {
      clearHeldOutcome()
      phase.value = 'forbidden'
      detail.value = 'no_access'
      return
    }
    if (response.status >= 200 && response.status < 300) {
      const parsed = readAdminAuthorizationLookup(response.body)
      if (parsed?.status === 'committed' && parsed.clientOperationId === id) {
        showReceipt(parsed)
        return
      }
    }
    enterPending(id)
  }

  function rebind(): boolean {
    const principalId = deps.getPrincipalId()
    const targetId = deps.getTargetId()
    if (principalId === boundPrincipal && targetId === boundTarget) return false
    generation += 1
    confirmLocked = false
    boundPrincipal = principalId
    boundTarget = targetId
    resetView()
    const adopted = adoptStored()
    if (adopted === 'pending') track(lookup())
    return true
  }

  async function lookup(signal?: AbortSignal): Promise<void> {
    rebind()
    if (storageUntrusted || !heldId) return
    const ticket = generation
    const principalId = boundPrincipal
    const targetId = boundTarget
    const id = heldId
    try {
      const response = await deps.transport({
        path: adminAuthorizationOperationLookupPath(id),
        method: 'GET',
        signal,
      })
      if (!still(ticket, principalId, targetId) || heldId !== id) return
      if (response.status === 403) {
        verified.value = false
        if (phase.value === 'committed' && receipt.value) {
          detail.value = 'unverified_no_read'
          return
        }
        receipt.value = null
        phase.value = 'unverified_no_read'
        detail.value = 'unverified_no_read'
        return
      }
      if (response.status === 404 || response.status < 200 || response.status >= 300) {
        if (phase.value !== 'committed') enterPending(id)
        return
      }
      const parsed = readAdminAuthorizationLookup(response.body)
      if (!parsed || parsed.clientOperationId !== id) {
        if (phase.value !== 'committed') enterPending(id)
        return
      }
      if (parsed.status === 'unknown_or_pending') {
        if (phase.value !== 'committed') enterPending(id)
        return
      }
      showReceipt(parsed)
    } catch {
      if (!still(ticket, principalId, targetId)) return
      if (phase.value !== 'committed') enterPending(id)
    }
  }

  async function preview(request: AdminAuthorizationRequest, signal?: AbortSignal): Promise<void> {
    rebind()
    if (confirmLocked || heldId || storageUntrusted || blocksNewOperation()) return
    const parsed = readAdminAuthorizationRequest(request)
    if (!parsed || !idsReady() || parsed.targetUserId !== boundTarget) {
      phase.value = 'validation_failed'
      detail.value = 'needs_repreview'
      verified.value = false
      return
    }
    const ticket = generation
    const principalId = boundPrincipal
    const targetId = boundTarget
    const epoch = ++previewEpoch
    phase.value = 'previewing'
    detail.value = 'none'
    verified.value = false
    openPreview = null
    try {
      const response = await deps.transport({
        path: ADMIN_AUTHORIZATION_PREVIEW_PATH,
        method: 'POST',
        body: parsed,
        signal,
      })
      if (!still(ticket, principalId, targetId) || !previewResponseCurrent(epoch)) return
      if (response.status === 400 || response.status === 409) {
        phase.value = 'validation_failed'
        detail.value = 'needs_repreview'
        return
      }
      if (response.status === 403) {
        phase.value = 'forbidden'
        detail.value = 'no_access'
        return
      }
      const body = response.status >= 200 && response.status < 300
        ? readAdminAuthorizationPreview(response.body)
        : null
      if (!body) {
        phase.value = 'idle'
        detail.value = 'preview_failed'
        return
      }
      acceptPreview(parsed, body)
    } catch {
      if (!still(ticket, principalId, targetId) || !previewResponseCurrent(epoch)) return
      phase.value = 'idle'
      detail.value = 'preview_failed'
    }
  }

  function acceptPreview(request: AdminAuthorizationRequest, body: AdminAuthorizationPreview): void {
    expectedVersion.value = body.expectedVersion
    impact.value = body.impact
    receipt.value = null
    verified.value = false
    openPreview = { request, expectedVersion: body.expectedVersion }
    phase.value = 'awaiting_confirmation'
    detail.value = 'none'
  }

  async function confirm(signal?: AbortSignal): Promise<void> {
    rebind()
    // Same-instance synchronous latch. A held id, including one just read back
    // from storage, must not be replaced by another POST.
    if (confirmLocked) return
    if (openPreview === null || storageUntrusted || !idsReady()) return
    if (heldId) return
    const previewing = openPreview
    confirmLocked = true
    const ticket = generation
    const principalId = boundPrincipal
    const targetId = boundTarget
    let postedId: string | null = null
    try {
      const occupied = matchingStored()
      if (occupied === 'untrusted') {
        storageUntrusted = true
        phase.value = 'pending'
        detail.value = 'storage_blocked'
        verified.value = false
        return
      }
      if (occupied) {
        previewEpoch += 1
        hold(occupied, 'pending')
        await lookup(signal)
        return
      }
      const id = deps.createClientOperationId ? deps.createClientOperationId() : randomUuid()
      if (!isAdminAuthorizationOperationUuid(id)) return
      const entry = { principalId, targetId, clientOperationId: id }
      const saved = remember(entry)
      if (saved === 'conflict') {
        const winner = matchingStored()
        if (winner && winner !== 'untrusted') {
          previewEpoch += 1
          hold(winner, 'pending')
          await lookup(signal)
        }
        return
      }
      if (saved !== 'stored') {
        storageUntrusted = true
        phase.value = 'pending'
        detail.value = 'storage_blocked'
        verified.value = false
        return
      }
      previewEpoch += 1
      postedId = id
      heldId = id
      clientOperationId.value = id
      phase.value = 'committing'
      detail.value = 'pending'
      verified.value = false
      const response = await deps.transport({
        path: ADMIN_AUTHORIZATION_OPERATIONS_PATH,
        method: 'POST',
        body: commitBody(previewing, id),
        signal,
      })
      if (!still(ticket, principalId, targetId)) return
      if (phase.value === 'committed' || phase.value === 'verified') return
      applyCommit(response, id)
    } catch {
      if (!still(ticket, principalId, targetId)) return
      if (phase.value === 'committed' || phase.value === 'verified') return
      if (postedId) enterPending(postedId)
    } finally {
      if (ticket === generation) confirmLocked = false
    }
  }

  function commitBody(previewing: OpenPreview, id: string): AdminAuthorizationRequest & {
    clientOperationId: string
    expectedVersion: string
  } {
    return {
      targetUserId: previewing.request.targetUserId,
      action: previewing.request.action,
      admissionChanges: previewing.request.admissionChanges.map((change) => ({
        namespace: change.namespace,
        enabled: change.enabled,
      })),
      ...(previewing.request.reason !== undefined ? { reason: previewing.request.reason } : {}),
      clientOperationId: id,
      expectedVersion: previewing.expectedVersion,
    }
  }

  async function verify(): Promise<void> {
    rebind()
    if (phase.value !== 'committed' || !heldId) return
    const ticket = generation
    const principalId = boundPrincipal
    const targetId = boundTarget
    const id = heldId
    let live = false
    try {
      live = await deps.verifyLive()
    } catch {
      live = false
    }
    if (!still(ticket, principalId, targetId) || heldId !== id || phase.value !== 'committed') return
    if (live !== true) {
      verified.value = false
      detail.value = 'receipt_only'
      return
    }
    forget({ principalId, targetId, clientOperationId: id })
    heldId = null
    verified.value = true
    phase.value = 'verified'
    detail.value = 'verified'
  }

  boundPrincipal = deps.getPrincipalId()
  boundTarget = deps.getTargetId()
  if (adoptStored() === 'pending') track(lookup())

  return {
    phase: readonly(phase),
    detail: readonly(detail),
    verified: readonly(verified),
    clientOperationId: readonly(clientOperationId),
    expectedVersion: readonly(expectedVersion),
    impact: readonly(impact),
    receipt: readonly(receipt),
    whenSettled: () => tail,
    syncContext: () => {
      rebind()
    },
    preview: (request, signal) => track(preview(request, signal)),
    confirm: (signal) => track(confirm(signal)),
    lookup: (signal) => track(lookup(signal)),
    verify: () => track(verify()),
  }
}
