import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Server } from 'socket.io'
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client'
import * as Y from 'yjs'
import { YjsWebSocketAdapter } from '../../src/collab/yjs-websocket-adapter'

function createMockSyncService() {
  const docs = new Map<string, Y.Doc>()
  return {
    async getOrCreateDoc(recordId: string) {
      let doc = docs.get(recordId)
      if (!doc) {
        doc = new Y.Doc()
        docs.set(recordId, doc)
      }
      return doc
    },
    getDoc(recordId: string) {
      return docs.get(recordId) ?? null
    },
  }
}

async function connectClient(baseUrl: string, token: string): Promise<ClientSocket> {
  const client = ioClient(`${baseUrl}/yjs`, {
    transports: ['websocket'],
    auth: { token },
    forceNew: true,
    reconnection: false,
  })

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('connect timeout')), 3000)
    client.once('connect', () => {
      clearTimeout(timeout)
      resolve()
    })
    client.once('connect_error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })

  return client
}

function waitForEvent<T>(
  client: ClientSocket,
  event: string,
  predicate: (payload: T) => boolean,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let lastPayload: T | null = null
    const timeout = setTimeout(() => {
      client.off(event, handler)
      reject(new Error(`timeout waiting for ${event}: ${JSON.stringify(lastPayload)}`))
    }, 3000)

    const handler = (payload: T) => {
      lastPayload = payload
      if (!predicate(payload)) return
      clearTimeout(timeout)
      client.off(event, handler)
      resolve(payload)
    }

    client.on(event, handler)
  })
}

describe('Yjs awareness presence socket protocol', () => {
  let httpServer: ReturnType<typeof createServer>
  let io: Server
  let adapter: YjsWebSocketAdapter
  let baseUrl = ''

  beforeEach(async () => {
    httpServer = createServer()
    io = new Server(httpServer, {
      cors: { origin: '*' },
    })

    const syncService = createMockSyncService()
    adapter = new YjsWebSocketAdapter(syncService as any)
    adapter.setTokenVerifier(async (token) => {
      if (!token.startsWith('token-')) return null
      return token.slice('token-'.length)
    })
    adapter.setAuthChecker(async (userId, recordId) => {
      if (recordId !== 'rec_presence') return null
      return {
        canRead: true,
        canWrite: userId !== 'user_readonly',
      }
    })
    adapter.register(io)

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
    const address = httpServer.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      io.close(() => resolve())
    })
    if (!httpServer.listening) return
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  })

  it('publishes presence snapshots per record and cleans them up on unsubscribe', async () => {
    const alice = await connectClient(baseUrl, 'token-user_alice')
    const bob = await connectClient(baseUrl, 'token-user_bob')

    try {
      const alicePresence = waitForEvent(alice, 'yjs:presence', (payload: any) => (
        payload.recordId === 'rec_presence'
        && payload.activeCount === 1
        && payload.users?.length === 1
      ))
      alice.emit('yjs:subscribe', { recordId: 'rec_presence' })
      await alicePresence

      const dualPresence = waitForEvent(alice, 'yjs:presence', (payload: any) => (
        payload.recordId === 'rec_presence'
        && payload.activeCount === 2
      ))
      bob.emit('yjs:subscribe', { recordId: 'rec_presence' })
      await dualPresence

      const fieldPresence = waitForEvent(alice, 'yjs:presence', (payload: any) => (
        payload.recordId === 'rec_presence'
        && payload.users?.some((user: any) => user.id === 'user_bob' && user.fieldIds?.includes('fld_body'))
      ))
      bob.emit('yjs:presence', { recordId: 'rec_presence', fieldId: 'fld_body' })
      const snapshot = await fieldPresence

      expect(snapshot.users).toEqual([
        { id: 'user_alice', fieldIds: [] },
        { id: 'user_bob', fieldIds: ['fld_body'] },
      ])
      expect(adapter.getMetrics()).toEqual({ activeRecordCount: 1, activeSocketCount: 2 })

      const afterUnsubscribe = waitForEvent(alice, 'yjs:presence', (payload: any) => (
        payload.recordId === 'rec_presence'
        && payload.activeCount === 1
        && payload.users?.every((user: any) => user.id !== 'user_bob')
      ))
      bob.emit('yjs:unsubscribe', { recordId: 'rec_presence' })
      await afterUnsubscribe

      expect(adapter.getPresenceSnapshot('rec_presence')).toEqual({
        recordId: 'rec_presence',
        activeCount: 1,
        users: [{ id: 'user_alice', fieldIds: [] }],
      })
    } finally {
      alice.disconnect()
      bob.disconnect()
    }
  })

  it('rejects presence updates from sockets that are not subscribed to the record', async () => {
    const client = await connectClient(baseUrl, 'token-user_alice')

    try {
      const error = waitForEvent(client, 'yjs:error', (payload: any) => payload.code === 'FORBIDDEN')
      client.emit('yjs:presence', { recordId: 'rec_presence', fieldId: 'fld_body' })
      await expect(error).resolves.toMatchObject({
        recordId: 'rec_presence',
        code: 'FORBIDDEN',
      })
    } finally {
      client.disconnect()
    }
  })
})
