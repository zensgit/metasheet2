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
    const a = ioClient(`${baseUrl}?userId=a`, { transports: ['websocket'] })
    const b = ioClient(`${baseUrl}?userId=b`, { transports: ['websocket'] })

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

    // Join user a to room R via server API
    // We invoke through server websocket API directly (simulating plugin call)
    // @ts-ignore access private for test
    await server['createCoreAPI']().websocket.join('room:R', { userId: 'a' })

    const gotA = new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('A did not receive')), 3000)
      a.on('kanban:notify', (payload: any) => { clearTimeout(t); resolve(payload) })
    })

    let gotB = false
    b.on('kanban:notify', () => { gotB = true })

    // Broadcast to room
    // @ts-ignore
    server['createCoreAPI']().websocket.broadcastTo('room:R', 'kanban:notify', { ok: true })

    const payload = await gotA
    expect(payload).toEqual({ ok: true })
    // Slight delay to ensure B would have received if incorrectly targeted
    await new Promise(r => setTimeout(r, 100))
    expect(gotB).toBe(false)

    a.close(); b.close()
  })

  it('join-comment-record scopes comment delivery to a single record room', async () => {
    if (!baseUrl || !server) return

    const a = ioClient(baseUrl, { transports: ['websocket'] })
    const b = ioClient(baseUrl, { transports: ['websocket'] })

    await Promise.all([
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('A connect timeout')), 3000)
        a.on('connect', () => { clearTimeout(t); resolve() })
      }),
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('B connect timeout')), 3000)
        b.on('connect', () => { clearTimeout(t); resolve() })
      }),
    ])

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('A join timeout')), 3000)
      a.on('joined-comment-record', (payload: any) => {
        try {
          expect(payload).toEqual({ spreadsheetId: 'sheet_orders', rowId: 'rec_1' })
          clearTimeout(t)
          resolve()
        } catch (error) {
          clearTimeout(t)
          reject(error)
        }
      })
      a.emit('join-comment-record', { spreadsheetId: 'sheet_orders', rowId: 'rec_1' })
    })

    const gotA = new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('A did not receive comment event')), 3000)
      a.on('comment:created', (payload: any) => { clearTimeout(t); resolve(payload) })
    })

    let gotB = false
    b.on('comment:created', () => { gotB = true })

    // @ts-ignore
    server['createCoreAPI']().websocket.broadcastTo('comments:sheet_orders:rec_1', 'comment:created', {
      spreadsheetId: 'sheet_orders',
      comment: { id: 'c1', rowId: 'rec_1' },
    })

    const payload = await gotA
    expect(payload).toEqual({
      spreadsheetId: 'sheet_orders',
      comment: { id: 'c1', rowId: 'rec_1' },
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(gotB).toBe(false)

    a.close()
    b.close()
  })

  it('join-sheet publishes deduplicated sheet presence for active users', async () => {
    if (!baseUrl || !server) return

    const a1 = ioClient(`${baseUrl}?userId=user_a`, { transports: ['websocket'] })
    const a2 = ioClient(`${baseUrl}?userId=user_a`, { transports: ['websocket'] })
    const b = ioClient(`${baseUrl}?userId=user_b`, { transports: ['websocket'] })

    const waitForConnect = (client: ReturnType<typeof ioClient>, label: string) => new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${label} connect timeout`)), 3000)
      client.on('connect', () => { clearTimeout(t); resolve() })
    })

    const waitForPresence = (
      client: ReturnType<typeof ioClient>,
      expected: { sheetId: string; activeCount: number; users: Array<{ id: string }> },
      label: string,
    ) => new Promise<void>((resolve, reject) => {
      let lastPayload: unknown = null
      const t = setTimeout(() => reject(new Error(`${label} presence timeout: ${JSON.stringify(lastPayload)}`)), 3000)
      const handler = (payload: any) => {
        lastPayload = payload
        try {
          expect(payload).toEqual(expected)
          clearTimeout(t)
          client.off('sheet:presence', handler)
          resolve()
        } catch (error) {
          // Presence broadcasts can race with earlier room transitions.
          // Keep waiting until the expected stabilized payload arrives.
        }
      }
      client.on('sheet:presence', handler)
    })

    await Promise.all([
      waitForConnect(a1, 'A1'),
      waitForConnect(a2, 'A2'),
      waitForConnect(b, 'B'),
    ])

    let presence = waitForPresence(a1, {
      sheetId: 'sheet_ops',
      activeCount: 1,
      users: [{ id: 'user_a' }],
    }, 'A1 first join')
    a1.emit('join-sheet', 'sheet_ops')
    await presence

    presence = waitForPresence(a1, {
      sheetId: 'sheet_ops',
      activeCount: 1,
      users: [{ id: 'user_a' }],
    }, 'A2 duplicate user join')
    a2.emit('join-sheet', 'sheet_ops')
    await presence

    presence = waitForPresence(a1, {
      sheetId: 'sheet_ops',
      activeCount: 2,
      users: [{ id: 'user_a' }, { id: 'user_b' }],
    }, 'B join')
    b.emit('join-sheet', 'sheet_ops')
    await presence

    presence = waitForPresence(a1, {
      sheetId: 'sheet_ops',
      activeCount: 2,
      users: [{ id: 'user_a' }, { id: 'user_b' }],
    }, 'A2 leave')
    a2.emit('leave-sheet', 'sheet_ops')
    await presence

    presence = waitForPresence(b, {
      sheetId: 'sheet_ops',
      activeCount: 1,
      users: [{ id: 'user_b' }],
    }, 'A1 leave')
    a1.emit('leave-sheet', 'sheet_ops')
    await presence

    a1.close()
    a2.close()
    b.close()
  })

  it('join-comment-inbox scopes activity delivery to inbox subscribers', async () => {
    if (!baseUrl || !server) return

    const a = ioClient(baseUrl, { transports: ['websocket'] })
    const b = ioClient(baseUrl, { transports: ['websocket'] })

    await Promise.all([
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('A connect timeout')), 3000)
        a.on('connect', () => { clearTimeout(t); resolve() })
      }),
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('B connect timeout')), 3000)
        b.on('connect', () => { clearTimeout(t); resolve() })
      }),
    ])

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('A inbox join timeout')), 3000)
      a.on('joined-comment-inbox', () => {
        clearTimeout(t)
        resolve()
      })
      a.emit('join-comment-inbox')
    })

    const gotA = new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('A did not receive inbox activity')), 3000)
      a.on('comment:activity', (payload: any) => { clearTimeout(t); resolve(payload) })
    })

    let gotB = false
    b.on('comment:activity', () => { gotB = true })

    // @ts-ignore
    server['createCoreAPI']().websocket.broadcastTo('comments-inbox', 'comment:activity', {
      kind: 'created',
      spreadsheetId: 'sheet_orders',
      rowId: 'rec_1',
      commentId: 'c1',
      authorId: 'user_other',
    })

    const payload = await gotA
    expect(payload).toEqual({
      kind: 'created',
      spreadsheetId: 'sheet_orders',
      rowId: 'rec_1',
      commentId: 'c1',
      authorId: 'user_other',
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(gotB).toBe(false)

    a.close()
    b.close()
  })
})
