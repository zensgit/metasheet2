import { ref, shallowRef, onUnmounted, watch } from 'vue'
import type { Ref } from 'vue'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { io as socketIO, type Socket } from 'socket.io-client'
import { useAuth } from '../../composables/useAuth'

const MSG_SYNC = 0

function handleSyncMessage(
  doc: Y.Doc,
  socket: Socket,
  recordId: string,
  message: Uint8Array,
): void {
  const decoder = decoding.createDecoder(message)
  const messageType = decoding.readVarUint(decoder)

  if (messageType === MSG_SYNC) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MSG_SYNC)
    syncProtocol.readSyncMessage(decoder, encoder, doc, 'server')

    const reply = encoding.toUint8Array(encoder)
    if (reply.length > 1) {
      socket.emit('yjs:message', { recordId, data: Array.from(reply) })
    }
  }
}

/**
 * Composable that manages a Yjs document bound to a specific record,
 * connected via Socket.IO /yjs namespace.
 *
 * POC scope: single record, single text field, character-level merge,
 * disconnect/reconnect recovery.
 */
export function useYjsDocument(recordId: Ref<string | null>) {
  const doc = shallowRef<Y.Doc | null>(null)
  const connected = ref(false)
  const synced = ref(false)
  const error = ref<string | null>(null)

  const auth = useAuth()
  let socket: Socket | null = null
  let currentRecordId: string | null = null

  async function connect(rid: string) {
    disconnect()
    currentRecordId = rid
    error.value = null

    // Get userId from auth — matches existing socket pattern in useMultitableSheetPresence
    const userId = await auth.getCurrentUserId().catch(() => null)
    if (!userId) {
      error.value = 'Not authenticated'
      return
    }

    const yDoc = new Y.Doc()
    doc.value = yDoc

    socket = socketIO('/yjs', {
      transports: ['websocket'],
      query: { userId },
    })

    socket.on('connect', () => {
      connected.value = true
      socket!.emit('yjs:subscribe', { recordId: rid })
    })

    socket.on(
      'yjs:message',
      ({ recordId: rid2, data }: { recordId: string; data: number[] }) => {
        if (rid2 !== currentRecordId) return
        const message = new Uint8Array(data)
        handleSyncMessage(yDoc, socket!, rid2, message)
        synced.value = true
      },
    )

    socket.on(
      'yjs:update',
      ({ recordId: rid2, data }: { recordId: string; data: number[] }) => {
        if (rid2 !== currentRecordId) return
        Y.applyUpdate(yDoc, new Uint8Array(data), 'remote')
      },
    )

    // Send local updates to server
    yDoc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'remote' && socket?.connected) {
        socket.emit('yjs:update', {
          recordId: rid,
          data: Array.from(update),
        })
      }
    })

    socket.on('yjs:error', ({ code, message: msg }: { recordId: string; code: string; message: string }) => {
      error.value = `${code}: ${msg}`
    })

    socket.on('disconnect', () => {
      connected.value = false
      synced.value = false
    })
  }

  function disconnect() {
    if (socket) {
      if (currentRecordId) {
        socket.emit('yjs:unsubscribe', { recordId: currentRecordId })
      }
      socket.disconnect()
      socket = null
    }
    if (doc.value) {
      doc.value.destroy()
      doc.value = null
    }
    currentRecordId = null
    connected.value = false
    synced.value = false
  }

  // Auto-connect when recordId changes
  watch(
    recordId,
    (newId) => {
      if (newId) connect(newId)
      else disconnect()
    },
    { immediate: true },
  )

  onUnmounted(disconnect)

  return { doc, connected, synced, error, connect, disconnect }
}
