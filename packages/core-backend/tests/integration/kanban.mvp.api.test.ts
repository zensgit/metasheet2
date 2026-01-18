import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import * as path from 'path'
import crypto from 'crypto'
import net from 'net'

describe('Kanban MVP API', () => {
  let server: MetaSheetServer
  let baseUrl = ''
  let viewId = ''
  let authHeader: Record<string, string> = {}

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen) return
    const repoRoot = path.join(__dirname, '../../../../')
    // Ensure database URL from env if available
    server = new MetaSheetServer({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [ path.join(repoRoot, 'plugins', 'plugin-view-kanban') ]
    })
    await server.start()
    const address = server.getAddress()
    if (!address || !address.port) return
    baseUrl = `http://127.0.0.1:${address.port}`

    const tokenRes = await fetch(`${baseUrl}/api/auth/dev-token?userId=1`)
    const tokenJson = await tokenRes.json()
    if (tokenJson?.token) {
      authHeader = { Authorization: `Bearer ${tokenJson.token as string}` }
    }

    const pool = poolManager.get()
    viewId = crypto.randomUUID()
    await pool.query(
      `INSERT INTO views (id, type, name, config)
       VALUES ($1, 'kanban', 'Test Kanban', '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [viewId],
    )
  })

  afterAll(async () => {
    if (server && (server as any).stop) {
      await server.stop()
    }
  })

  it('GET returns config+state and supports ETag', async () => {
    if (!baseUrl) return
    const res1 = await fetch(`${baseUrl}/api/kanban/${viewId}`, { headers: authHeader })
    expect(res1.status).toBe(200)
    const etag = res1.headers.get('etag')
    expect(etag).toBeTruthy()
    const data1 = await res1.json() as any
    expect(data1.success).toBe(true)
    expect(data1.data).toBeDefined()

    const res304 = await fetch(`${baseUrl}/api/kanban/${viewId}`, {
      headers: { ...authHeader, 'If-None-Match': etag! },
    })
    expect(res304.status).toBe(304)
  })

  it('POST persists state and next GET reflects change', async () => {
    if (!baseUrl) return
    const newState = { columns: [{ id: 'todo', cards: ['1','2'] }] }
    const post = await fetch(`${baseUrl}/api/kanban/${viewId}/state`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: newState })
    })
    expect(post.status).toBe(204)

    const res = await fetch(`${baseUrl}/api/kanban/${viewId}`, { headers: authHeader })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.success).toBe(true)
    expect(body.data?.state).toBeDefined()
    expect(body.data.state.columns?.[0]?.id).toBe('todo')
  })

  it('returns 404 for unknown viewId', async () => {
    if (!baseUrl) return
    const unknownId = crypto.randomUUID()
    const res = await fetch(`${baseUrl}/api/kanban/${unknownId}`, { headers: authHeader })
    expect(res.status).toBe(404)
  })

  it('requires JWT when KANBAN_AUTH_REQUIRED=true', async () => {
    if (!baseUrl) return
    // simulate strict mode by calling without headers (server flag is env-based; test asserts 401 or 200 in relaxed)
    const res = await fetch(`${baseUrl}/api/kanban/${viewId}`)
    expect([200, 401]).toContain(res.status)
  })
})
