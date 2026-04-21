import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import type { Server as SocketServer, Socket, Namespace } from 'socket.io'
import type { YjsSyncService } from './yjs-sync-service'
import type { YjsRecordBridge } from './yjs-record-bridge'

// Message types
const MSG_SYNC = 0
// const MSG_AWARENESS = 1  // Not used in POC

/**
 * Callback to check if a user has access to a record.
 * Returns { canRead, canWrite } or null if record doesn't exist.
 */
export type YjsAuthChecker = (
  userId: string,
  recordId: string,
) => Promise<{ canRead: boolean; canWrite: boolean } | null>

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

type SocketPresenceState = {
  userId: string
  fieldId: string | null
}

export class YjsWebSocketAdapter {
  private bridge: YjsRecordBridge | null = null
  private authChecker: YjsAuthChecker | null = null
  private tokenVerifier: YjsTokenVerifier | null = null
  private namespace: Namespace | null = null

  /** Per-socket verified userId (from JWT, not from client query) */
  private socketUserId = new Map<string, string>()

  /** Per-socket permission cache: socket.id → recordId → canWrite */
  private socketPermissions = new Map<string, Map<string, boolean>>()

  /** Per-record presence state: recordId → socketId → { userId, fieldId } */
  private recordPresence = new Map<string, Map<string, SocketPresenceState>>()

  constructor(private syncService: YjsSyncService) {}

  /** Attach bridge for Y.Text → RecordWriteService patching. */
  setBridge(bridge: YjsRecordBridge): void {
    this.bridge = bridge
  }

  /** Attach auth checker for record-level access control. */
  setAuthChecker(checker: YjsAuthChecker): void {
    this.authChecker = checker
  }

  /** Attach JWT token verifier. */
  setTokenVerifier(verifier: YjsTokenVerifier): void {
    this.tokenVerifier = verifier
  }

  /** Get verified userId for a socket (set at connection time via JWT). */
  getSocketUserId(socketId: string): string | undefined {
    return this.socketUserId.get(socketId)
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
    this.namespace.to(`yjs:${recordId}`).emit('yjs:presence', this.getPresenceSnapshot(recordId))
  }

  register(io: SocketServer): void {
    const nsp = io.of('/yjs')
    this.namespace = nsp

    // Verify JWT at connection time — reject unauthenticated sockets immediately
    nsp.use(async (socket, next) => {
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
        const userId = this.socketUserId.get(socket.id)
        if (!userId) {
          socket.emit('yjs:error', { recordId, code: 'UNAUTHENTICATED', message: 'Not authenticated' })
          return
        }

        if (this.authChecker) {
          const access = await this.authChecker(userId, recordId)
          if (!access) {
            socket.emit('yjs:error', { recordId, code: 'NOT_FOUND', message: 'Record not found' })
            return
          }
          if (!access.canRead) {
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

        const doc = await this.syncService.getOrCreateDoc(recordId)
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

          const doc = this.syncService.getDoc(recordId)
          if (!doc) return

          const message = new Uint8Array(data)
          const decoder = decoding.createDecoder(message)
          const messageType = decoding.readVarUint(decoder)

          if (messageType === MSG_SYNC) {
            const encoder = encoding.createEncoder()
            encoding.writeVarUint(encoder, MSG_SYNC)
            syncProtocol.readSyncMessage(decoder, encoder, doc, socket.id)

            const reply = encoding.toUint8Array(encoder)
            if (reply.length > 1) {
              socket.emit('yjs:message', {
                recordId,
                data: Array.from(reply),
              })
            }
          }
        },
      )

      socket.on(
        'yjs:update',
        async ({ recordId, data }: { recordId: string; data: number[] }) => {
          if (!recordId || !data) return

          // ── Auth gate: check write permission ──
          if (this.authChecker) {
            const perms = this.socketPermissions.get(socket.id)
            const canWrite = perms?.get(recordId)
            if (canWrite === false) {
              socket.emit('yjs:error', { recordId, code: 'FORBIDDEN', message: 'No write access' })
              return
            }
            if (canWrite === undefined) {
              // Not subscribed to this record — reject
              socket.emit('yjs:error', { recordId, code: 'FORBIDDEN', message: 'Not subscribed' })
              return
            }
          }

          const doc = this.syncService.getDoc(recordId)
          if (!doc) return

          const update = new Uint8Array(data)
          Y.applyUpdate(doc, update, socket.id)

          // Broadcast to all OTHER clients in the room
          const room = `yjs:${recordId}`
          socket.to(room).emit('yjs:update', { recordId, data })
        },
      )

      socket.on(
        'yjs:presence',
        ({ recordId, fieldId }: { recordId: string; fieldId?: string | null }) => {
          if (!recordId || typeof recordId !== 'string') return

          const userId = this.socketUserId.get(socket.id)
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
