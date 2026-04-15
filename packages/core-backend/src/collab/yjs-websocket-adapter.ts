import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import type { Server as SocketServer } from 'socket.io'
import type { YjsSyncService } from './yjs-sync-service'

// Message types
const MSG_SYNC = 0
// const MSG_AWARENESS = 1  // Not used in POC

export class YjsWebSocketAdapter {
  constructor(private syncService: YjsSyncService) {}

  register(io: SocketServer): void {
    const nsp = io.of('/yjs')

    nsp.on('connection', (socket) => {
      socket.on('yjs:subscribe', async ({ recordId }: { recordId: string }) => {
        if (!recordId || typeof recordId !== 'string') return

        const doc = await this.syncService.getOrCreateDoc(recordId)
        const room = `yjs:${recordId}`
        socket.join(room)

        // Send sync step 1: our state vector so the client can send us what we're missing
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

          const doc = await this.syncService.getOrCreateDoc(recordId)
          const message = new Uint8Array(data)
          const decoder = decoding.createDecoder(message)
          const messageType = decoding.readVarUint(decoder)

          if (messageType === MSG_SYNC) {
            const encoder = encoding.createEncoder()
            encoding.writeVarUint(encoder, MSG_SYNC)
            syncProtocol.readSyncMessage(decoder, encoder, doc, socket.id)

            const reply = encoding.toUint8Array(encoder)
            // reply.length > 1 means there is actual content beyond the message type byte
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

          const doc = await this.syncService.getOrCreateDoc(recordId)
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
      })

      // Socket.IO automatically handles room cleanup on disconnect
    })
  }
}
