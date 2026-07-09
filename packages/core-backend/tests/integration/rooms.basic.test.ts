import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import net from 'net'
import { io as ioClient } from 'socket.io-client'
import { MetaSheetServer } from '../../src/index'
import { ICollabService, type ICollabService as CollabServicePort } from '../../src/di/identifiers'
import { eventBus } from '../../src/integration/events/event-bus'
import { publishMultitableSheetRealtime } from '../../src/multitable/realtime-publish'

function waitForConnect(client: ReturnType<typeof ioClient>, label: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} connect timeout`)), 3000)
    client.on('connect', () => { clearTimeout(t); resolve() })
  })
}

function waitForEvent<T = any>(
  client: ReturnType<typeof ioClient>,
  event: string,
  label: string,
  timeoutMs = 3000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs)
    client.once(event, (payload: T) => {
      clearTimeout(t)
      resolve(payload)
    })
  })
}

async function expectNoEvent(
  client: ReturnType<typeof ioClient>,
  event: string,
  label: string,
  timeoutMs = 120,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      client.off(event, handler)
      resolve()
    }, timeoutMs)
    const handler = (payload: unknown) => {
      clearTimeout(t)
      client.off(event, handler)
      reject(new Error(`${label} unexpectedly received ${event}: ${JSON.stringify(payload)}`))
    }
    client.on(event, handler)
  })
}

async function waitForRoomMember(
  collabService: CollabServicePort,
  room: string,
  userId: string,
): Promise<void> {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const members = await collabService.getRoomMembers(room)
    if (members.includes(userId)) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${userId} in room ${room}`)
}

describe('WebSocket Rooms - basic flow', () => {
  let server: MetaSheetServer | undefined
  let baseUrl: string | undefined
  let collabService: CollabServicePort | undefined

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
    // @ts-expect-error integration test reaches into the server container to keep
    // Socket.IO tests independent from real JWT/RBAC fixtures.
    collabService = server.injector.get(ICollabService)
    collabService.setTokenVerifier(async (token) => {
      if (!token.startsWith('token:')) return null
      return token.slice('token:'.length).trim() || null
    })
    collabService.setSheetRoomAuthChecker(async ({ sheetId, userId }) => {
      return ['sheet_ops', 'sheet_orders'].includes(sheetId) && ['user_a', 'user_b', 'user_reader', 'a', 'b'].includes(userId)
    })
    collabService.setCommentRoomAuthChecker(async ({ spreadsheetId, rowId, userId }) => {
      const canReadSheet = ['sheet_ops', 'sheet_orders'].includes(spreadsheetId) && ['user_a', 'user_b', 'user_reader', 'a', 'b'].includes(userId)
      if (!canReadSheet) return false
      if (spreadsheetId === 'sheet_orders' && rowId === 'rec_secret') return false
      if (spreadsheetId === 'sheet_orders' && !rowId) return false
      return true
    })
  })

  afterAll(async () => {
    if (server && (server as any).stop) await server.stop()
  })

  it('broadcastTo affects only members of the room', async () => {
    if (!baseUrl || !server || !collabService) return
    const a = ioClient(baseUrl, { transports: ['websocket'], auth: { token: 'token:a' } })
    const b = ioClient(baseUrl, { transports: ['websocket'], auth: { token: 'token:b' } })

    await Promise.all([waitForConnect(a, 'A'), waitForConnect(b, 'B')])
    await Promise.all([
      waitForRoomMember(collabService, 'a', 'a'),
      waitForRoomMember(collabService, 'b', 'b'),
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

  it('rejects unauthenticated sheet joins and keeps the socket out of sheet broadcasts', async () => {
    if (!baseUrl) return
    const client = ioClient(baseUrl, { transports: ['websocket'] })
    await waitForConnect(client, 'unauthenticated')

    const denied = waitForEvent(client, 'join-denied', 'join denied')
    client.emit('join-sheet', 'sheet_ops')
    await expect(denied).resolves.toEqual({ sheetId: 'sheet_ops', reason: 'unauthorized' })

    eventBus.publish('spreadsheet.cell.updated', {
      spreadsheetId: 'sheet_ops',
      actorId: 'user_editor',
      source: 'multitable',
      kind: 'record-updated',
      recordIds: ['rec_1'],
      fieldIds: ['fld_secret'],
      recordPatches: [{ recordId: 'rec_1', patch: { fld_secret: 'SECRET_REALTIME_CANARY' } }],
    })
    await expectNoEvent(client, 'sheet:op', 'unauthenticated socket')
    await expectNoEvent(client, 'sheet:presence', 'unauthenticated socket')

    client.close()
  })

  it('rejects valid tokens without sheet read access', async () => {
    if (!baseUrl) return
    const client = ioClient(baseUrl, { transports: ['websocket'], auth: { token: 'token:user_denied' } })
    await waitForConnect(client, 'non-reader')

    const denied = waitForEvent(client, 'join-denied', 'join denied')
    client.emit('join-sheet', 'sheet_ops')
    await expect(denied).resolves.toEqual({ sheetId: 'sheet_ops', reason: 'forbidden' })

    eventBus.publish('spreadsheet.cell.updated', {
      spreadsheetId: 'sheet_ops',
      actorId: 'user_editor',
      source: 'multitable',
      kind: 'record-updated',
      recordIds: ['rec_1'],
      fieldIds: ['fld_secret'],
      recordPatches: [{ recordId: 'rec_1', patch: { fld_secret: 'SECRET_REALTIME_CANARY' } }],
    })
    await expectNoEvent(client, 'sheet:op', 'non-reader socket')

    client.close()
  })

  it('uses token identity for presence and broadcasts value-free sheet invalidations to readers', async () => {
    if (!baseUrl) return
    const client = ioClient(`${baseUrl}?userId=spoofed_user`, {
      transports: ['websocket'],
      auth: { token: 'token:user_reader' },
    })
    await waitForConnect(client, 'reader')

    const joined = waitForEvent(client, 'joined', 'reader join')
    const presence = waitForEvent(client, 'sheet:presence', 'reader presence')
    client.emit('join-sheet', 'sheet_ops')
    await expect(joined).resolves.toEqual({ sheetId: 'sheet_ops' })
    await expect(presence).resolves.toEqual({
      sheetId: 'sheet_ops',
      activeCount: 1,
      users: [{ id: 'user_reader' }],
    })

    const op = waitForEvent(client, 'sheet:op', 'reader sheet op')
    publishMultitableSheetRealtime({
      spreadsheetId: 'sheet_ops',
      actorId: 'user_editor',
      source: 'multitable',
      kind: 'record-updated',
      recordIds: ['rec_1'],
      fieldIds: ['fld_visible', 'fld_secret'],
      recordPatches: [{
        recordId: 'rec_1',
        version: 10,
        patch: { fld_visible: 'VISIBLE_CONTROL', fld_secret: 'SECRET_REALTIME_CANARY' },
      }],
    })
    const payload = await op
    expect(payload).toEqual({
      type: 'cell-update',
      data: {
        spreadsheetId: 'sheet_ops',
        actorId: 'user_editor',
        source: 'multitable',
        kind: 'record-updated',
        recordIds: ['rec_1'],
        fieldIds: ['fld_visible', 'fld_secret'],
      },
    })
    expect(JSON.stringify(payload)).not.toContain('SECRET_REALTIME_CANARY')
    expect(JSON.stringify(payload)).not.toContain('VISIBLE_CONTROL')

    client.close()
  })

  it('join-comment-record scopes comment delivery to a single record room', async () => {
    if (!baseUrl || !server) return

    // authenticated + authorized to read sheet_orders (comment rooms now require the same read gate as join-sheet)
    const a = ioClient(baseUrl, { transports: ['websocket'], auth: { token: 'token:user_a' } })
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

    const a1 = ioClient(`${baseUrl}?userId=spoofed_a1`, { transports: ['websocket'], auth: { token: 'token:user_a' } })
    const a2 = ioClient(`${baseUrl}?userId=spoofed_a2`, { transports: ['websocket'], auth: { token: 'token:user_a' } })
    const b = ioClient(`${baseUrl}?userId=spoofed_b`, { transports: ['websocket'], auth: { token: 'token:user_b' } })

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

    // the comment inbox now requires an authenticated identity to join (no anonymous access to the stream)
    const a = ioClient(baseUrl, { transports: ['websocket'], auth: { token: 'token:user_a' } })
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

  // --- Security: comment rooms expose a sheet's comment bodies (comment:created carries the full
  // comment), so joining one must require the SAME authenticated read gate as join-sheet. Without it an
  // anonymous socket could join any sheet's comment room and receive every comment body broadcast there.
  it('SECURITY: rejects an unauthenticated join-comment-sheet and keeps the socket out of comment-body broadcasts', async () => {
    if (!baseUrl || !server) return
    const client = ioClient(baseUrl, { transports: ['websocket'] })
    await waitForConnect(client, 'unauth-comment-sheet')

    const denied = waitForEvent(client, 'comment-join-denied', 'comment-sheet join denied')
    client.emit('join-comment-sheet', { spreadsheetId: 'sheet_orders' })
    await expect(denied).resolves.toEqual({ scope: 'sheet_orders', reason: 'unauthorized' })

    // the denied socket must NOT be in the room — a comment body broadcast there must never reach it
    const noBody = expectNoEvent(client, 'comment:created', 'denied comment-sheet socket')
    // @ts-ignore access private for test
    server['createCoreAPI']().websocket.broadcastTo('comments-sheet:sheet_orders', 'comment:created', {
      spreadsheetId: 'sheet_orders',
      comment: { id: 'leak', rowId: 'rec_1', body: 'secret' },
    })
    await noBody

    client.close()
  })

  it('SECURITY: rejects an unauthenticated join-comment-record and keeps the socket out of comment-body broadcasts', async () => {
    if (!baseUrl || !server) return
    const client = ioClient(baseUrl, { transports: ['websocket'] })
    await waitForConnect(client, 'unauth-comment-record')

    const denied = waitForEvent(client, 'comment-join-denied', 'comment-record join denied')
    client.emit('join-comment-record', { spreadsheetId: 'sheet_orders', rowId: 'rec_1' })
    await expect(denied).resolves.toEqual({ scope: 'sheet_orders', reason: 'unauthorized' })

    const noBody = expectNoEvent(client, 'comment:created', 'denied comment-record socket')
    // @ts-ignore access private for test
    server['createCoreAPI']().websocket.broadcastTo('comments:sheet_orders:rec_1', 'comment:created', {
      spreadsheetId: 'sheet_orders',
      comment: { id: 'leak', rowId: 'rec_1', body: 'secret' },
    })
    await noBody

    client.close()
  })

  it('SECURITY: rejects a join-comment-sheet from an authenticated user who cannot read the sheet', async () => {
    if (!baseUrl || !server) return
    // a verified identity, but 'intruder' is not in the sheet's read allowlist → forbidden, not just anonymous-denied
    const client = ioClient(baseUrl, { transports: ['websocket'], auth: { token: 'token:intruder' } })
    await waitForConnect(client, 'intruder-comment-sheet')

    const denied = waitForEvent(client, 'comment-join-denied', 'comment-sheet join forbidden')
    client.emit('join-comment-sheet', { spreadsheetId: 'sheet_orders' })
    await expect(denied).resolves.toEqual({ scope: 'sheet_orders', reason: 'forbidden' })

    client.close()
  })

  it('SECURITY: rejects join-comment-record when the authenticated user is row-denied', async () => {
    if (!baseUrl || !server) return
    const client = ioClient(baseUrl, { transports: ['websocket'], auth: { token: 'token:user_a' } })
    await waitForConnect(client, 'row-denied-comment-record')

    const denied = waitForEvent(client, 'comment-join-denied', 'comment-record row denied')
    client.emit('join-comment-record', { spreadsheetId: 'sheet_orders', rowId: 'rec_secret' })
    await expect(denied).resolves.toEqual({ scope: 'sheet_orders', reason: 'forbidden' })

    const noBody = expectNoEvent(client, 'comment:created', 'row-denied comment-record socket')
    // @ts-ignore access private for test
    server['createCoreAPI']().websocket.broadcastTo('comments:sheet_orders:rec_secret', 'comment:created', {
      spreadsheetId: 'sheet_orders',
      comment: { id: 'leak', rowId: 'rec_secret', body: 'secret' },
    })
    await noBody

    client.close()
  })

  it('SECURITY: rejects join-comment-sheet when row-deny makes the sheet-wide comment room unfilterable', async () => {
    if (!baseUrl || !server) return
    const client = ioClient(baseUrl, { transports: ['websocket'], auth: { token: 'token:user_a' } })
    await waitForConnect(client, 'row-denied-comment-sheet')

    const denied = waitForEvent(client, 'comment-join-denied', 'comment-sheet row-deny forbidden')
    client.emit('join-comment-sheet', { spreadsheetId: 'sheet_orders' })
    await expect(denied).resolves.toEqual({ scope: 'sheet_orders', reason: 'forbidden' })

    const noBody = expectNoEvent(client, 'comment:created', 'row-denied comment-sheet socket')
    // @ts-ignore access private for test
    server['createCoreAPI']().websocket.broadcastTo('comments-sheet:sheet_orders', 'comment:created', {
      spreadsheetId: 'sheet_orders',
      comment: { id: 'leak', rowId: 'rec_secret', body: 'secret' },
    })
    await noBody

    client.close()
  })

  it('SECURITY: rejects an unauthenticated join-comment-inbox', async () => {
    if (!baseUrl || !server) return
    const client = ioClient(baseUrl, { transports: ['websocket'] })
    await waitForConnect(client, 'unauth-inbox')

    const noJoin = expectNoEvent(client, 'joined-comment-inbox', 'unauth inbox join')
    const denied = waitForEvent(client, 'comment-join-denied', 'inbox join denied')
    client.emit('join-comment-inbox')
    await expect(denied).resolves.toEqual({ scope: 'comment-inbox', reason: 'unauthorized' })
    await noJoin

    client.close()
  })
})
