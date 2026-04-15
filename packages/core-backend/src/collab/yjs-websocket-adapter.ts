import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import type { Server as SocketServer, Socket } from 'socket.io'
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

export class YjsWebSocketAdapter {
  private bridge: YjsRecordBridge | null = null
  private authChecker: YjsAuthChecker | null = null
  private tokenVerifier: YjsTokenVerifier | null = null

  /** Per-socket verified userId (from JWT, not from client query) */
  private socketUserId = new Map<string, string>()

  /** Per-socket permission cache: socket.id → recordId → canWrite */
  private socketPermissions = new Map<string, Map<string, boolean>>()

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

  register(io: SocketServer): void {
    const nsp = io.of('/yjs')

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

      socket.on('yjs:unsubscribe', ({ recordId }: { recordId: string }) => {
        if (!recordId) return
        socket.leave(`yjs:${recordId}`)
        // Clean up cached permission for this record
        const perms = this.socketPermissions.get(socket.id)
        if (perms) perms.delete(recordId)
      })

      socket.on('disconnect', () => {
        this.socketPermissions.delete(socket.id)
        this.socketUserId.delete(socket.id)
      })
    })
  }
}
