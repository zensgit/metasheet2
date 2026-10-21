import assert from 'node:assert/strict'
import { io, type Socket } from 'socket.io-client'

const clients: Socket[] = []
let ready = false
let disconnects = 0
let disconnectTimeout: NodeJS.Timeout | undefined
let cleanupConnection: (() => void) | undefined
let resolveDisconnected!: () => void
let rejectDisconnected!: (error: Error) => void
const disconnected = new Promise<void>((resolve, reject) => {
  resolveDisconnected = resolve
  rejectDisconnected = reject
})
// A transport may disconnect while the other is still connecting.
void disconnected.catch(() => undefined)

try {
  let payload = ''
  for await (const chunk of process.stdin) {
    payload += chunk.toString()
    assert(payload.length < 262144)
  }
  const parsed: unknown = JSON.parse(payload)
  payload = ''
  assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed))
  const input = parsed as Record<string, unknown>
  assert(typeof input.origin === 'string' && typeof input.token === 'string' && input.token.length > 0)
  const origin = new URL(input.origin)
  assert(origin.protocol === 'http:' && origin.hostname === '127.0.0.1'
    && origin.origin === input.origin && !origin.username && !origin.password
    && origin.port === process.env.PLM_FULL_APP_PARENT_HTTP_PORT)
  const guard = (globalThis as typeof globalThis & {
    __PLM_FULL_APP_NETWORK_GUARD__?: { databaseAllowed: boolean }
  }).__PLM_FULL_APP_NETWORK_GUARD__
  assert(guard && guard.databaseAllowed === false)

  for (const transport of ['websocket', 'polling']) {
    const client: Socket = io(input.origin, { transports: [transport], reconnection: false,
      forceNew: true, autoConnect: false, auth: { token: input.token } })
    clients.push(client)
    client.once('disconnect', () => {
      disconnects++
      if (!ready) rejectDisconnected(new Error('APP_CONFIGURED_COLLAB_EARLY_DISCONNECT'))
      else if (disconnects === 2) resolveDisconnected()
    })
    await Promise.race([disconnected, new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => finish(false), 10000)
      const cleanup = () => {
        clearTimeout(timeout)
        client.off('connect', onConnect)
        client.off('connect_error', onError)
        cleanupConnection = undefined
      }
      const finish = (connected: boolean) => {
        cleanup()
        if (connected) resolve()
        else reject(new Error('APP_CONFIGURED_COLLAB_CONNECT_FAILED'))
      }
      const onConnect = () => finish(true)
      const onError = () => finish(false)
      cleanupConnection = cleanup
      client.once('connect', onConnect)
      client.once('connect_error', onError)
      client.connect()
    })])
    assert.equal(client.io.engine.transport.name, transport)
  }
  assert.equal(clients.length, 2)
  assert(clients.every(client => client.connected))
  assert.equal(disconnects, 0)
  ready = true
  console.log('PLM_FULL_APP_SOCKET_READY ' + JSON.stringify({ twoConnected: true, connected: 2,
    transports: ['websocket', 'polling'] }))
  disconnectTimeout = setTimeout(() => rejectDisconnected(new Error('APP_CONFIGURED_COLLAB_DISCONNECT_TIMEOUT')), 45000)
  await disconnected
  clearTimeout(disconnectTimeout)
  disconnectTimeout = undefined
  assert.equal(disconnects, 2)
  assert(clients.every(client => !client.connected))
  console.log('PLM_FULL_APP_SOCKET_RESULT ' + JSON.stringify({ twoDisconnected: true,
    disconnects: 2, allDisconnected: true }))
  // No successful-path disconnect or forced exit. The parent also requires the
  // natural child close and the guard's final counters, including late packets.
} catch (error) {
  process.exitCode = 1
  const diagnostic = error instanceof Error && /^APP_CONFIGURED_COLLAB_[A-Z_]+$/.test(error.message)
    ? error.message : 'APP_CONFIGURED_COLLAB_CHILD_FAILED'
  console.log('PLM_FULL_APP_SOCKET_FAILED ' + JSON.stringify({ diagnostic }))
  // Failure-only cleanup cannot contribute to a successful result frame.
  cleanupConnection?.()
  for (const client of clients) client.disconnect()
} finally {
  if (disconnectTimeout) clearTimeout(disconnectTimeout)
}
