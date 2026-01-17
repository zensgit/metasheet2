import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import net from 'net'
import { io as ioClient } from 'socket.io-client'
import { MetaSheetServer } from '../../src/index'

describe('WebSocket Rooms - basic flow', () => {
  let server: MetaSheetServer | undefined
  let baseUrl: string | undefined

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen) return

    server = new MetaSheetServer({ port: 0, host: '127.0.0.1' })
    await server.start()
    const addr = server.getAddress()
    if (!addr || !addr.port) return
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    if (server && (server as any).stop) await server.stop()
  })

  it('broadcastTo affects only members of the room', async () => {
    if (!baseUrl || !server) return
    // Connect two clients with userIds
    const a = ioClient(`${baseUrl}?userId=a`, { transports: ['websocket'], reconnection: false })
    const b = ioClient(`${baseUrl}?userId=b`, { transports: ['websocket'], reconnection: false })

    // Wait for connection
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('A connect timeout')), 3000)
        a.on('connect', () => { clearTimeout(t); resolve() })
      }),
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('B connect timeout')), 3000)
        b.on('connect', () => { clearTimeout(t); resolve() })
      })
    ])

    // Join client A to room R via server API (simulating plugin call)
    // @ts-ignore access private for test
    await server['createCoreAPI']().websocket.join?.(a.id, 'room:R')

    const gotA = new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('A did not receive')), 3000)
      a.on('kanban:notify', (payload: any) => { clearTimeout(t); resolve(payload) })
    })

    let gotB = false
    b.on('kanban:notify', () => { gotB = true })

    // Broadcast to room
    // @ts-ignore
    server['createCoreAPI']().websocket.broadcastToRoom?.('room:R', 'kanban:notify', { ok: true })

    const payload = await gotA
    expect(payload).toEqual({ ok: true })
    // Slight delay to ensure B would have received if incorrectly targeted
    await new Promise(r => setTimeout(r, 100))
    expect(gotB).toBe(false)

    const closeSocket = (socket: ReturnType<typeof ioClient>) => new Promise<void>((resolve) => {
      if (socket.disconnected) return resolve()
      socket.once('disconnect', () => resolve())
      socket.disconnect()
    })

    await Promise.all([closeSocket(a), closeSocket(b)])
  })
})
