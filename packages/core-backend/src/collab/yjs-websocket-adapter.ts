import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import type { Server as SocketServer, Socket, Namespace } from 'socket.io'
import type { YjsSyncService } from './yjs-sync-service'
import type { YjsContribution, YjsRecordBridge } from './yjs-record-bridge'
import { baselineRealtimeProtection, type RealtimeProtection } from '../realtime-authz/protection'
import type { ProtectedConnections } from '../realtime-authz/protected-connections'
import { bindingKey, type RealtimeSessionBinding } from '../realtime-authz/session-binding'

// Message types
const MSG_SYNC = 0
// const MSG_AWARENESS = 1  // Not used in POC

export type YjsRecordAccess = { canRead: boolean; canWrite: boolean; canReadAllFields?: boolean }

/**
 * Callback to check if a user has access to a record.
 * Returns { canRead, canWrite }, or null if record doesn't exist, or 'unknown' when the facts could
 * not be read. 'unknown' (and a checker that rejects) is neither a yes nor a no: nothing is served on
 * it, and nothing is concluded from it.
 */
export type YjsAuthChecker = (
  userId: string,
  recordId: string,
) => Promise<YjsRecordAccess | null | 'unknown'>

/**
 * Callback to verify a JWT token and return the trusted userId.
 * Returns null if token is invalid/expired.
 */
export type YjsTokenVerifier = (token: string) => Promise<string | null>

export type YjsPresenceUser = {
  id: string
  fieldIds: string[]
}

export type YjsPresenceSnapshot = {
  recordId: string
  activeCount: number
  users: YjsPresenceUser[]
}

export type YjsInvalidatedPayload = {
  recordId: string
  reason: 'rest-write'
}

/**
 * Fresh write check for one user on one record: may this user write the record and every one of
 * these fields right now? Called for every write, never answered from a value cached at subscribe.
 */
export type YjsFieldWriteChecker = (userId: string, recordId: string, fieldIds: string[]) => Promise<boolean | 'unknown'>

/** allowed / denied by an authoritative fact / unknown: the facts could not be read or nothing is served. */
export type YjsWriteVerdict = 'allowed' | 'denied' | 'unknown'

export interface YjsWebSocketAdapterOptions {
  /** Delay between two attempts to process an incoming change whose check could not be answered. */
  heldUpdateRetryMs?: number
  /** How long an incoming change is held for an answer before it is refused visibly. */
  heldUpdateMaxMs?: number
  /** How many incoming changes of one record may wait in order; further ones are refused visibly. */
  heldUpdateMaxQueued?: number
  /** How long the attribution of a closed connection is kept when no write of it is waiting. */
  contributorRetentionMs?: number
  /** How long a namespace handshake may wait while handshakes are held; then it is refused as transient. */
  heldHandshakeMaxMs?: number
  /** How many namespace handshakes may wait at once; further ones are refused as transient. */
  heldHandshakeMaxWaiting?: number
}

/** Below the time after which the transport closes a client that has joined no namespace. */
export const DEFAULT_HELD_HANDSHAKE_MAX_MS = 20_000
export const DEFAULT_HELD_HANDSHAKE_MAX_WAITING = 1_000
export const DEFAULT_HELD_UPDATE_RETRY_MS = 250
export const DEFAULT_HELD_UPDATE_MAX_MS = 30_000
export const DEFAULT_HELD_UPDATE_MAX_QUEUED = 512
export const DEFAULT_CONTRIBUTOR_RETENTION_MS = 60_000

/** What is known about the sender of an incoming change at the moment the change arrives. */
interface ArrivalContext {
  userId: string | undefined
  binding: RealtimeSessionBinding | null
  subscribed: boolean
  arrivedAt: number
}

/**
 * What an incoming update would change, found by applying it to an isolated copy of the shared
 * document. `fields` lists the record fields it touches; `undeterminable` is an update whose
 * effect cannot be attributed to record fields (it depends on state the document does not have, or
 * it changes something other than the fields of the record).
 */
export type StagedYjsUpdate =
  | { kind: 'noop' }
  | { kind: 'fields'; fieldIds: string[] }
  | { kind: 'undeterminable' }

export function stageYjsUpdate(doc: Y.Doc, update: Uint8Array): StagedYjsUpdate {
  const staging = new Y.Doc()
  try {
    Y.applyUpdate(staging, Y.encodeStateAsUpdate(doc), 'staging-base')
    const fields = staging.getMap('fields')
    const fieldIds = new Set<string>()
    let changed = false
    let determinable = true
    staging.on('afterTransaction', (transaction: Y.Transaction) => {
      if (transaction.origin !== 'staged-update') return
      for (const [type, keys] of transaction.changed) {
        changed = true
        if ((type as unknown) === fields) {
          for (const key of keys) {
            if (typeof key === 'string') fieldIds.add(key)
            else determinable = false
          }
          continue
        }
        // A text value stored directly under a field key; anything nested deeper is not a field.
        const item = (type as unknown as { _item?: { parentSub?: string | null } | null })._item
        if (type instanceof Y.Text && (type.parent as unknown) === fields && typeof item?.parentSub === 'string') {
          fieldIds.add(item.parentSub)
          continue
        }
        determinable = false
      }
    })
    Y.applyUpdate(staging, update, 'staged-update')
    const store = staging.store as unknown as { pendingStructs?: unknown; pendingDs?: unknown }
    if (store.pendingStructs || store.pendingDs) return { kind: 'undeterminable' }
    if (!determinable) return { kind: 'undeterminable' }
    if (!changed) return { kind: 'noop' }
    return { kind: 'fields', fieldIds: [...fieldIds].sort() }
  } catch {
    return { kind: 'undeterminable' }
  } finally {
    staging.destroy()
  }
}

type SocketPresenceState = {
  userId: string
  fieldId: string | null
}

export class YjsWebSocketAdapter {
  private bridge: YjsRecordBridge | null = null
  private authChecker: YjsAuthChecker | null = null
  private tokenVerifier: YjsTokenVerifier | null = null
  private namespace: Namespace | null = null
  private fieldWriteChecker: YjsFieldWriteChecker | null = null
  // Realtime protection. With the baseline protection (the default) the handshake and the read
  // paths are the pre-existing ones.
  private protection: RealtimeProtection = baselineRealtimeProtection
  private connections: ProtectedConnections | null = null
  /** One write at a time per record, in arrival order: a later update may depend on an earlier one. */
  private recordWriteQueues = new Map<string, Promise<void>>()
  /**
   * Who each contributing connection was bound to, kept after the connection closed so a pending
   * write can still be attributed and re-checked when it is persisted.
   */
  private contributors = new Map<string, { userId: string; binding: RealtimeSessionBinding | null; closedAt: number | null }>()
  private queuedWrites = new Map<string, number>()
  private readonly heldUpdateRetryMs: number
  private readonly heldUpdateMaxMs: number
  private readonly heldUpdateMaxQueued: number
  private readonly contributorRetentionMs: number
  private readonly heldHandshakeMaxMs: number
  private readonly heldHandshakeMaxWaiting: number
  /** Namespace handshakes waiting for the next decision; each is settled exactly once. */
  private readonly heldHandshakes = new Set<(outcome: 'decided' | 'expired' | 'gone') => void>()

  /** Per-socket verified userId (from JWT, not from client query) */
  private socketUserId = new Map<string, string>()

  /** Per-socket permission cache: socket.id → recordId → canWrite */
  private socketPermissions = new Map<string, Map<string, boolean>>()

  /** Per-record presence state: recordId → socketId → { userId, fieldId } */
  private recordPresence = new Map<string, Map<string, SocketPresenceState>>()

  constructor(private syncService: YjsSyncService, options: YjsWebSocketAdapterOptions = {}) {
    this.heldUpdateRetryMs = options.heldUpdateRetryMs ?? DEFAULT_HELD_UPDATE_RETRY_MS
    this.heldUpdateMaxMs = options.heldUpdateMaxMs ?? DEFAULT_HELD_UPDATE_MAX_MS
    this.heldUpdateMaxQueued = options.heldUpdateMaxQueued ?? DEFAULT_HELD_UPDATE_MAX_QUEUED
    this.contributorRetentionMs = options.contributorRetentionMs ?? DEFAULT_CONTRIBUTOR_RETENTION_MS
    this.heldHandshakeMaxMs = options.heldHandshakeMaxMs ?? DEFAULT_HELD_HANDSHAKE_MAX_MS
    this.heldHandshakeMaxWaiting = options.heldHandshakeMaxWaiting ?? DEFAULT_HELD_HANDSHAKE_MAX_WAITING
  }

  /** Attach bridge for Y.Text → RecordWriteService patching. */
  setBridge(bridge: YjsRecordBridge): void {
    this.bridge = bridge
  }

  /** Attach auth checker for record-level access control. */
  setAuthChecker(checker: YjsAuthChecker): void {
    this.authChecker = checker
  }

  /** Attach the fresh per-write check of record and field write access. */
  setFieldWriteChecker(checker: YjsFieldWriteChecker): void {
    this.fieldWriteChecker = checker
  }

  /**
   * Attaches realtime protection. In protected mode the namespace handshake binds the connection to
   * its session, every message re-reads that session, and every send to a record room passes the
   * delivery boundary of `connections`.
   */
  setRealtimeProtection(protection: RealtimeProtection, connections: ProtectedConnections): void {
    this.protection = protection
    this.connections = connections
    connections.onSweep(() => this.sweepSubscriptions())
    protection.subscribe((event) => {
      if (event.type === 'decision' && event.decision.ordinaryHandshake !== 'hold') {
        // Handshakes are no longer held: every waiting one goes on and is judged by the new decision.
        for (const settle of [...this.heldHandshakes]) settle('decided')
      }
      if (event.type !== 'decision' || !this.namespace || !this.connections || !this.isProtected()) return
      for (const socket of this.namespace.sockets.values()) this.adoptSocket(socket, true)
      if (event.decision.established === 'terminate') {
        this.connections.endAll({ code: 'REALTIME_UNAVAILABLE', retry: true })
        return
      }
      void this.connections.sweep()
    })
  }

  private isProtected(): boolean {
    return this.connections !== null && this.protection.mode() !== 'baseline'
  }

  private handshakesHeld(): boolean {
    return this.isProtected() && this.protection.decision().ordinaryHandshake === 'hold'
  }

  /** How many namespace handshakes are waiting right now. */
  heldHandshakeCount(): number {
    return this.heldHandshakes.size
  }

  /**
   * Keeps a namespace handshake waiting while handshakes are held. The connection is not a member
   * of the namespace meanwhile, so nothing can be served to it. Resolves `decided` when a decision
   * that no longer holds handshakes is there, `expired` after the bound or when too many are
   * waiting, and `gone` when the client went away first.
   */
  private waitWhileHandshakesHeld(socket: Socket, remainingMs: number): Promise<'decided' | 'expired' | 'gone'> {
    if (remainingMs <= 0 || this.heldHandshakes.size >= this.heldHandshakeMaxWaiting) return Promise.resolve('expired')
    return new Promise((resolve) => {
      const conn = (socket as unknown as { conn?: { once?: (event: string, handler: () => void) => void; off?: (event: string, handler: () => void) => void } }).conn
      const onClose = (): void => settle('gone')
      const timer = setTimeout(() => settle('expired'), remainingMs)
      timer.unref?.()
      const settle = (outcome: 'decided' | 'expired' | 'gone'): void => {
        if (!this.heldHandshakes.delete(settle)) return
        clearTimeout(timer)
        conn?.off?.('close', onClose)
        resolve(outcome)
      }
      this.heldHandshakes.add(settle)
      conn?.once?.('close', onClose)
    })
  }

  /**
   * Idle pass over record subscriptions: a connection that stays subscribed without any traffic is
   * still taken out of the record once its user may no longer read it.
   */
  private async sweepSubscriptions(): Promise<void> {
    if (!this.namespace || !this.connections || !this.isProtected() || !this.authChecker) return
    for (const room of [...this.namespace.adapter.rooms.keys()]) {
      if (!room.startsWith('yjs:')) continue
      const recordId = room.slice('yjs:'.length)
      const members = this.localRoomSockets(room)
      if (members.length === 0) continue
      await this.connections.sweepResources(members, {
        resourceCheck: async (binding) => {
          const access = await this.readAccess(binding.userId, recordId)
          if (access === 'unknown') throw new Error('read access not answered')
          return Boolean(access && access.canRead && access.canReadAllFields !== false)
        },
        onResourceDenied: (socket) => this.dropSubscription(socket as Socket, recordId),
      })
    }
  }

  private adoptSocket(socket: Socket, established = false): void {
    this.connections?.register(socket, {
      onAdmitted: (admitted, binding) => {
        this.socketUserId.set(admitted.id, binding.userId)
      },
    }, { established })
  }

  /** The verified user of a connection for this message; in protected mode its session is read again. */
  private async currentUser(socket: Socket): Promise<{ userId: string; binding: RealtimeSessionBinding | null } | null> {
    if (this.isProtected() && this.connections) {
      this.adoptSocket(socket)
      const binding = await this.connections.ensureCurrent(socket)
      return binding ? { userId: binding.userId, binding } : null
    }
    const userId = this.socketUserId.get(socket.id)
    return userId ? { userId, binding: null } : null
  }

  /**
   * Read access of one user to one record, read now. 'unknown' when the facts could not be read.
   */
  private async readAccess(userId: string, recordId: string): Promise<YjsRecordAccess | null | 'unknown'> {
    if (!this.authChecker) return { canRead: true, canWrite: true }
    try {
      return await this.authChecker(userId, recordId)
    } catch {
      return 'unknown'
    }
  }

  private localRoomSockets(room: string): Socket[] {
    if (!this.namespace) return []
    const ids = this.namespace.adapter.rooms.get(room)
    if (!ids) return []
    const sockets: Socket[] = []
    for (const id of ids) {
      const socket = this.namespace.sockets.get(id)
      if (socket) sockets.push(socket)
    }
    return sockets
  }

  private dropSubscription(socket: Socket, recordId: string): void {
    socket.leave(`yjs:${recordId}`)
    this.socketPermissions.get(socket.id)?.delete(recordId)
    socket.emit('yjs:error', { recordId, code: 'FORBIDDEN', message: 'No read access' })
    if (this.removePresence(recordId, socket.id)) this.emitPresence(recordId)
  }

  /**
   * Sends to the room of a record. Baseline: the pre-existing room emit. Protected: every recipient
   * is checked again for the session it is bound to and for read access to the record.
   */
  private emitToRecordRoom(recordId: string, event: string, payload: unknown, except?: Socket): void {
    if (!this.namespace) return
    const room = `yjs:${recordId}`
    if (!this.isProtected() || !this.connections) {
      if (except) except.to(room).emit(event, payload)
      else this.namespace.to(room).emit(event, payload)
      return
    }
    const members = this.localRoomSockets(room).filter((socket) => socket !== except)
    const served = new Set<Socket>()
    void this.connections.deliver(members, (socket) => {
      served.add(socket as Socket)
      socket.emit(event, payload)
    }, {
      resourceCheck: async (binding) => {
        const access = await this.readAccess(binding.userId, recordId)
        // Not answered: withheld from this recipient; it is not a refusal.
        if (access === 'unknown') throw new Error('read access not answered')
        return Boolean(access && access.canRead && access.canReadAllFields !== false)
      },
      onResourceDenied: (socket) => this.dropSubscription(socket as Socket, recordId),
      stillSubscribed: (socket) => (socket as Socket).rooms.has(room),
    }).catch(() => undefined).then(() => {
      // A subscriber that did not get a change of the document can no longer follow the shared
      // document: it is told to reopen the record instead of being left behind in silence.
      if (event !== 'yjs:update') return
      for (const member of members) {
        if (served.has(member) || !member.connected || !member.rooms.has(room)) continue
        this.tellInvalidated(member, recordId)
      }
    })
  }

  private retireContributor(socketId: string): void {
    const now = Date.now()
    const entry = this.contributors.get(socketId)
    if (entry) entry.closedAt = now
    for (const [id, contributor] of this.contributors) {
      if (contributor.closedAt === null || now - contributor.closedAt <= this.contributorRetentionMs) continue
      // A write this connection contributed to may still be waiting for its re-check: the
      // attribution is kept until that write has been written or refused.
      if (this.bridge?.hasPendingOrigin(id)) continue
      this.contributors.delete(id)
    }
  }

  /**
   * Re-check of one contribution right before a merged write is persisted (attach it to the bridge
   * with `setContributionChecker`). The contributor must still be attributable to the connection the
   * changes arrived on, must still be allowed to write the record and each field it changed, and in
   * protected mode the session it was bound to must still be current.
   *
   * The answer is three-valued. `denied` is returned only for an authoritative fact; a read that
   * failed, an instance that is not serving and a session that could not be read are `unknown`.
   */
  async checkContribution(recordId: string, contribution: YjsContribution): Promise<YjsWriteVerdict> {
    if (contribution.originId === null) return 'denied'
    const contributor = this.contributors.get(contribution.originId)
    if (!contributor || contributor.userId !== contribution.actorId) return 'denied'
    const write = await this.mayWrite(contributor.userId, recordId, contribution.fieldIds)
    if (write !== 'allowed') return write
    if (!this.isProtected()) return 'allowed'
    return this.sessionVerdict(contributor.binding ?? this.liveBinding(contribution.originId))
  }

  private liveBinding(socketId: string): RealtimeSessionBinding | null {
    const socket = this.namespace?.sockets.get(socketId)
    return socket && this.connections ? this.connections.bindingOf(socket) : null
  }

  /** Session facts of a binding, read now, without touching any connection. */
  private async sessionVerdict(binding: RealtimeSessionBinding | null): Promise<YjsWriteVerdict> {
    // Not serving, or no session to read yet: nothing can be told either way.
    if (this.protection.decision().established !== 'revalidate' || !binding) return 'unknown'
    let result
    try {
      result = await this.protection.authorize([binding])
    } catch {
      return 'unknown'
    }
    const verdict = result.verdicts.get(bindingKey(binding))
    if (verdict?.state === 'denied') return 'denied'
    return result.serving && verdict?.state === 'allowed' ? 'allowed' : 'unknown'
  }

  /** Fresh record and field write check; with no checker attached there is nothing to refuse. */
  private async mayWrite(userId: string, recordId: string, fieldIds: string[]): Promise<YjsWriteVerdict> {
    if (!this.authChecker) return 'allowed'
    try {
      const access = await this.authChecker(userId, recordId)
      if (access === 'unknown') return 'unknown'
      if (!access || !access.canWrite) return 'denied'
      if (this.fieldWriteChecker) {
        const fields = await this.fieldWriteChecker(userId, recordId, fieldIds)
        if (fields === 'unknown') return 'unknown'
        if (fields !== true) return 'denied'
      }
      return 'allowed'
    } catch {
      return 'unknown'
    }
  }

  /** One write at a time per record, in arrival order; false when too many are already waiting. */
  private enqueueWrite(recordId: string, work: () => Promise<void>): boolean {
    const waiting = this.queuedWrites.get(recordId) ?? 0
    if (waiting >= this.heldUpdateMaxQueued) return false
    this.queuedWrites.set(recordId, waiting + 1)
    const previous = this.recordWriteQueues.get(recordId) ?? Promise.resolve()
    const next = previous.then(work).catch(() => undefined).finally(() => {
      const left = (this.queuedWrites.get(recordId) ?? 1) - 1
      if (left > 0) this.queuedWrites.set(recordId, left)
      else this.queuedWrites.delete(recordId)
      if (this.recordWriteQueues.get(recordId) === next) this.recordWriteQueues.delete(recordId)
    })
    this.recordWriteQueues.set(recordId, next)
    return true
  }

  private arrivalOf(socket: Socket, recordId: string): ArrivalContext {
    return {
      userId: this.socketUserId.get(socket.id),
      binding: this.connections ? this.connections.bindingOf(socket) : null,
      subscribed: !this.authChecker || this.socketPermissions.get(socket.id)?.has(recordId) === true,
      arrivedAt: Date.now(),
    }
  }

  /**
   * Tells one connection that its copy of a record document is no longer the shared one, and takes
   * it out of the record. The client leaves the document and reopens it from the shared state.
   */
  private tellInvalidated(socket: Socket, recordId: string): void {
    socket.leave(`yjs:${recordId}`)
    this.socketPermissions.get(socket.id)?.delete(recordId)
    socket.emit('yjs:invalidated', { recordId, reason: 'rest-write' } satisfies YjsInvalidatedPayload)
    if (this.removePresence(recordId, socket.id)) this.emitPresence(recordId)
  }

  private refuseVisibly(socket: Socket, recordId: string, code: 'FORBIDDEN' | 'UNAVAILABLE', message: string): void {
    socket.emit('yjs:error', { recordId, code, message })
    // The local document of this client now holds a change the server did not take.
    this.tellInvalidated(socket, recordId)
  }

  /**
   * Every incoming change — the update event and the two write forms of the sync message — is queued
   * here in arrival order. A change whose check cannot be answered is HELD: it is not applied, not
   * persisted and not relayed, the changes behind it wait, and it is tried again until an answer is
   * there. A change held longer than the bound is refused visibly. It is never dropped in silence.
   */
  private acceptIncomingUpdate(socket: Socket, recordId: string, update: Uint8Array, relayData: number[]): void {
    const arrival = this.arrivalOf(socket, recordId)
    if (!arrival.subscribed) {
      socket.emit('yjs:error', { recordId, code: 'FORBIDDEN', message: 'Not subscribed' })
      return
    }
    const queued = this.enqueueWrite(recordId, async () => {
      for (;;) {
        const outcome = await this.applyGuardedUpdate(socket, recordId, update, relayData, arrival)
        if (outcome !== 'hold') return
        if (Date.now() - arrival.arrivedAt >= this.heldUpdateMaxMs) {
          this.refuseVisibly(socket, recordId, 'UNAVAILABLE', 'Change could not be checked in time; reopen the record')
          return
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.heldUpdateRetryMs)
          timer.unref?.()
        })
      }
    })
    if (!queued) this.refuseVisibly(socket, recordId, 'UNAVAILABLE', 'Too many changes are waiting for this record; reopen it')
  }

  /**
   * One attempt to process an incoming change. The update is first applied to an isolated copy to
   * find the fields it touches; the sender is then checked for the record and for each of those
   * fields, and in protected mode its session is read again last. Only then is the update applied to
   * the shared document, which is what persists it and what the record write is derived from, and
   * relayed. Until that point neither the shared document, its persisted state nor any other client
   * has seen it.
   *
   * Returns 'hold' when a check could not be answered: nothing was applied and nothing was refused.
   */
  private async applyGuardedUpdate(
    socket: Socket,
    recordId: string,
    update: Uint8Array,
    relayData: number[],
    arrival: ArrivalContext,
  ): Promise<'done' | 'hold'> {
    const doc = this.syncService.getDoc(recordId)
    if (!doc) {
      // The document this change was made against is gone (invalidated or released): say so.
      this.tellInvalidated(socket, recordId)
      return 'done'
    }
    const staged = stageYjsUpdate(doc, update)
    if (staged.kind === 'noop') return 'done'
    if (staged.kind === 'undeterminable') {
      this.refuseVisibly(socket, recordId, 'FORBIDDEN', 'Update cannot be attributed to record fields')
      return 'done'
    }
    const baselineUserId = arrival.userId
    if (this.authChecker && !baselineUserId) {
      socket.emit('yjs:error', { recordId, code: 'UNAUTHENTICATED', message: 'Not authenticated' })
      return 'done'
    }
    if (baselineUserId) {
      const write = await this.mayWrite(baselineUserId, recordId, staged.fieldIds)
      if (write === 'unknown') return 'hold'
      if (write === 'denied') {
        this.refuseVisibly(socket, recordId, 'FORBIDDEN', 'No write access')
        return 'done'
      }
    }
    let binding: RealtimeSessionBinding | null = null
    let userId = baselineUserId
    if (this.isProtected() && this.connections) {
      if (socket.connected) {
        this.adoptSocket(socket)
        const current = await this.connections.checkCurrent(socket)
        if (current.state === 'unavailable') return 'hold'
        // Ended: the connection is not served any more; where it was ended it has been told.
        if (current.state === 'ended') return 'done'
        if (baselineUserId && current.binding.userId !== baselineUserId) return 'done'
        binding = current.binding
        userId = current.binding.userId
      } else {
        // The sender left after sending: its session is read from the binding it had on arrival.
        const session = await this.sessionVerdict(arrival.binding)
        if (session === 'unknown') return 'hold'
        if (session === 'denied') return 'done'
        binding = arrival.binding
      }
    }
    // The document may have been invalidated while the checks ran: nothing is applied to the old
    // generation, and the sender is told.
    if (this.syncService.getDoc(recordId) !== doc) {
      this.tellInvalidated(socket, recordId)
      return 'done'
    }
    if (userId) {
      const known = this.contributors.get(socket.id)
      this.contributors.set(socket.id, { userId, binding, closedAt: socket.connected ? null : (known?.closedAt ?? Date.now()) })
    }
    Y.applyUpdate(doc, update, socket.id)
    this.emitToRecordRoom(recordId, 'yjs:update', { recordId, data: relayData }, socket)
    return 'done'
  }

  /** Attach JWT token verifier. */
  setTokenVerifier(verifier: YjsTokenVerifier): void {
    this.tokenVerifier = verifier
  }

  /** Get verified userId for a socket (set at connection time via JWT). */
  getSocketUserId(socketId: string): string | undefined {
    // A change of a connection that has closed since it sent it is still attributed to its user.
    return this.socketUserId.get(socketId) ?? this.contributors.get(socketId)?.userId
  }

  getPresenceSnapshot(recordId: string): YjsPresenceSnapshot {
    const bySocket = this.recordPresence.get(recordId)
    const byUser = new Map<string, Set<string>>()

    for (const [, state] of bySocket ?? []) {
      const fieldIds = byUser.get(state.userId) ?? new Set<string>()
      if (state.fieldId) fieldIds.add(state.fieldId)
      byUser.set(state.userId, fieldIds)
    }

    const users = [...byUser.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, fieldIds]) => ({
        id,
        fieldIds: [...fieldIds].sort((left, right) => left.localeCompare(right)),
      }))

    return {
      recordId,
      activeCount: users.length,
      users,
    }
  }

  getMetrics(): { activeRecordCount: number; activeSocketCount: number } {
    return {
      activeRecordCount: this.recordPresence.size,
      activeSocketCount: [...this.recordPresence.values()].reduce((total, perRecord) => total + perRecord.size, 0),
    }
  }

  /**
   * Notify live editors that their in-memory Y.Doc was invalidated by an
   * authoritative REST write. Clients should disconnect and fall back to REST
   * until they explicitly reopen/reconnect, at which point the server will
   * seed from the committed meta_records.data row.
   */
  notifyInvalidated(recordIds: string[]): void {
    if (!this.namespace) return
    for (const recordId of [...new Set(recordIds.filter((id) => typeof id === 'string' && id.length > 0))]) {
      // A control message without record content: it only says "your copy is no longer the shared
      // one". It is sent to every subscriber directly, also while deliveries are withheld, because
      // an editor that is not told keeps typing into a document that no longer exists.
      this.namespace.to(`yjs:${recordId}`).emit('yjs:invalidated', {
        recordId,
        reason: 'rest-write',
      } satisfies YjsInvalidatedPayload)
    }
  }

  private normalizeFieldId(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const next = value.trim()
    return next.length > 0 ? next : null
  }

  private upsertPresence(recordId: string, socketId: string, userId: string, fieldId: string | null) {
    const bySocket = this.recordPresence.get(recordId) ?? new Map<string, SocketPresenceState>()
    bySocket.set(socketId, { userId, fieldId })
    this.recordPresence.set(recordId, bySocket)
  }

  private removePresence(recordId: string, socketId: string): boolean {
    const bySocket = this.recordPresence.get(recordId)
    if (!bySocket) return false
    const existed = bySocket.delete(socketId)
    if (bySocket.size === 0) {
      this.recordPresence.delete(recordId)
    } else {
      this.recordPresence.set(recordId, bySocket)
    }
    return existed
  }

  private emitPresence(recordId: string) {
    if (!this.namespace) return
    this.emitToRecordRoom(recordId, 'yjs:presence', this.getPresenceSnapshot(recordId))
  }

  register(io: SocketServer): void {
    const nsp = io.of('/yjs')
    this.namespace = nsp

    // Verify JWT at connection time — reject unauthenticated sockets immediately
    nsp.use(async (socket, next) => {
      const transient = (): Error & { data?: unknown } => {
        const error = new Error('UNAVAILABLE: realtime unavailable') as Error & { data?: unknown }
        error.data = { code: 'REALTIME_UNAVAILABLE', retry: true }
        return error
      }
      if (this.handshakesHeld()) {
        // Held: the handshake waits, unserved, and is judged by whatever is decided next.
        this.connections?.noteHeldHandshake()
        const deadline = Date.now() + this.heldHandshakeMaxMs
        while (this.handshakesHeld()) {
          const outcome = await this.waitWhileHandshakesHeld(socket as Socket, deadline - Date.now())
          if (outcome === 'gone') return
          if (outcome === 'expired') return next(transient())
        }
      }
      if (this.isProtected() && this.connections) {
        // Protected: the handshake binds the connection to its session and reads it as current.
        const token = (socket.handshake.auth as { token?: unknown })?.token
        const result = await this.protection.admit(typeof token === 'string' ? token.trim() : undefined)
        if ('refusal' in result) {
          const denied = result.refusal.kind !== 'unavailable'
          const error = new Error(denied ? 'UNAUTHENTICATED: session not current' : 'UNAVAILABLE: realtime unavailable') as Error & { data?: unknown }
          error.data = denied ? { code: 'SESSION_NOT_CURRENT', retry: false } : { code: 'REALTIME_UNAVAILABLE', retry: true }
          return next(error)
        }
        this.adoptSocket(socket)
        this.connections.adoptAdmitted(socket, result.binding, result.generation)
        this.socketUserId.set(socket.id, result.binding.userId)
        return next()
      }
      if (!this.tokenVerifier) return next()

      const token = (socket.handshake.auth as { token?: string })?.token
      if (!token || typeof token !== 'string') {
        return next(new Error('UNAUTHENTICATED: token required'))
      }

      const userId = await this.tokenVerifier(token)
      if (!userId) {
        return next(new Error('UNAUTHENTICATED: invalid token'))
      }

      this.socketUserId.set(socket.id, userId)
      next()
    })

    nsp.on('connection', (socket) => {
      socket.on('yjs:subscribe', async ({ recordId }: { recordId: string }) => {
        if (!recordId || typeof recordId !== 'string') return

        // ── Auth gate: userId is already verified by JWT middleware ──
        const userId = (await this.currentUser(socket))?.userId
        if (!userId) {
          socket.emit('yjs:error', { recordId, code: 'UNAUTHENTICATED', message: 'Not authenticated' })
          return
        }

        if (this.authChecker) {
          // A read that could not be answered is answered to the subscriber the way it always was.
          const access = await this.readAccess(userId, recordId)
          if (!access || access === 'unknown') {
            socket.emit('yjs:error', { recordId, code: 'NOT_FOUND', message: 'Record not found' })
            return
          }
          if (!access.canRead) {
            socket.emit('yjs:error', { recordId, code: 'FORBIDDEN', message: 'No read access' })
            return
          }
          // Yjs sync is record-wide. A field-masked actor cannot safely receive
          // a partial doc here, so the realtime path fails closed and the client
          // falls back to REST reads where field masking is response-scoped.
          if (access.canReadAllFields === false) {
            socket.emit('yjs:error', { recordId, code: 'FORBIDDEN', message: 'No read access' })
            return
          }
          // Cache write permission for this socket+record
          let perms = this.socketPermissions.get(socket.id)
          if (!perms) {
            perms = new Map()
            this.socketPermissions.set(socket.id, perms)
          }
          perms.set(recordId, access.canWrite)
        }

        let doc: Y.Doc
        try {
          doc = await this.syncService.getOrCreateDoc(recordId)
        } catch {
          // The document of this record cannot be served right now.
          this.socketPermissions.get(socket.id)?.delete(recordId)
          socket.emit('yjs:error', { recordId, code: 'UNAVAILABLE', message: 'Record document unavailable' })
          return
        }
        if (!socket.connected) return
        const room = `yjs:${recordId}`
        socket.join(room)
        this.upsertPresence(recordId, socket.id, userId, null)

        // Start bridge observation if bridge is attached
        if (this.bridge) {
          this.bridge.observe(recordId, doc)
        }

        // Send sync step 1
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MSG_SYNC)
        syncProtocol.writeSyncStep1(encoder, doc)
        socket.emit('yjs:message', {
          recordId,
          data: Array.from(encoding.toUint8Array(encoder)),
        })
        this.emitPresence(recordId)
      })

      socket.on(
        'yjs:message',
        async ({ recordId, data }: { recordId: string; data: number[] }) => {
          if (!recordId || !data) return

          // ── Auth gate: must be subscribed to this record ──
          const perms = this.socketPermissions.get(socket.id)
          if (this.authChecker && !perms?.has(recordId)) {
            socket.emit('yjs:error', { recordId, code: 'FORBIDDEN', message: 'Not subscribed' })
            return
          }

          // The message is classified before anything is applied: the first sync step is a read,
          // the second sync step and the update form are writes. Anything else is refused.
          let syncType: number
          let body: Uint8Array | null = null
          let decoder: decoding.Decoder
          try {
            decoder = decoding.createDecoder(new Uint8Array(data))
            if (decoding.readVarUint(decoder) !== MSG_SYNC) return
            syncType = decoding.readVarUint(decoder)
            if (syncType === syncProtocol.messageYjsSyncStep2 || syncType === syncProtocol.messageYjsUpdate) {
              body = decoding.readVarUint8Array(decoder)
            }
          } catch {
            socket.emit('yjs:error', { recordId, code: 'FORBIDDEN', message: 'Message not understood' })
            return
          }

          if (body) {
            // A write form. A change for a document that is gone is answered there, not dropped.
            this.acceptIncomingUpdate(socket, recordId, body, Array.from(body))
            return
          }

          const doc = this.syncService.getDoc(recordId)
          if (!doc) return

          if (syncType === syncProtocol.messageYjsSyncStep1) {
            if (this.isProtected()) {
              // Protected: the session and the read access of the requester are read again before
              // any document state is returned.
              const current = await this.currentUser(socket)
              if (!current) return
              if (this.authChecker) {
                const access = await this.readAccess(current.userId, recordId)
                // Not answered: no document state is returned, and the subscription is left alone.
                if (access === 'unknown') return
                if (!access || !access.canRead || access.canReadAllFields === false) {
                  this.dropSubscription(socket, recordId)
                  return
                }
              }
              if (this.syncService.getDoc(recordId) !== doc || !socket.connected) return
            }
            const encoder = encoding.createEncoder()
            encoding.writeVarUint(encoder, MSG_SYNC)
            try {
              syncProtocol.readSyncStep1(decoder, encoder, doc)
            } catch {
              socket.emit('yjs:error', { recordId, code: 'FORBIDDEN', message: 'Message not understood' })
              return
            }
            const reply = encoding.toUint8Array(encoder)
            if (reply.length > 1) {
              socket.emit('yjs:message', {
                recordId,
                data: Array.from(reply),
              })
            }
            return
          }

          socket.emit('yjs:error', { recordId, code: 'FORBIDDEN', message: 'Message not understood' })
        },
      )

      socket.on(
        'yjs:update',
        async ({ recordId, data }: { recordId: string; data: number[] }) => {
          if (!recordId || !data) return

          // ── Auth gate: must be subscribed; write access is checked afresh for every update ──
          if (this.authChecker && !this.socketPermissions.get(socket.id)?.has(recordId)) {
            socket.emit('yjs:error', { recordId, code: 'FORBIDDEN', message: 'Not subscribed' })
            return
          }
          let update: Uint8Array
          try {
            update = new Uint8Array(data)
          } catch {
            return
          }
          // Applied to the shared document, and relayed to the other clients of the room, only
          // after the sender was checked for the fields this update touches.
          this.acceptIncomingUpdate(socket, recordId, update, data)
        },
      )

      socket.on(
        'yjs:presence',
        async ({ recordId, fieldId }: { recordId: string; fieldId?: string | null }) => {
          if (!recordId || typeof recordId !== 'string') return

          const userId = (await this.currentUser(socket))?.userId
          if (!userId) {
            socket.emit('yjs:error', { recordId, code: 'UNAUTHENTICATED', message: 'Not authenticated' })
            return
          }

          const perms = this.socketPermissions.get(socket.id)
          if (this.authChecker && !perms?.has(recordId)) {
            socket.emit('yjs:error', { recordId, code: 'FORBIDDEN', message: 'Not subscribed' })
            return
          }

          this.upsertPresence(recordId, socket.id, userId, this.normalizeFieldId(fieldId))
          this.emitPresence(recordId)
        },
      )

      socket.on('yjs:unsubscribe', ({ recordId }: { recordId: string }) => {
        if (!recordId) return
        socket.leave(`yjs:${recordId}`)
        // Clean up cached permission for this record
        const perms = this.socketPermissions.get(socket.id)
        if (perms) perms.delete(recordId)
        if (this.removePresence(recordId, socket.id)) {
          this.emitPresence(recordId)
        }
      })

      socket.on('disconnect', () => {
        this.connections?.unregister(socket)
        this.retireContributor(socket.id)
        this.socketPermissions.delete(socket.id)
        this.socketUserId.delete(socket.id)
        for (const [recordId] of this.recordPresence) {
          if (this.removePresence(recordId, socket.id)) {
            this.emitPresence(recordId)
          }
        }
      })
    })
  }
}
