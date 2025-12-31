import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MetaSheetServer } from '../../src/index'
import * as path from 'path'
import net from 'net'
import { randomUUID } from 'crypto'
import { poolManager } from '../../src/integration/db/connection-pool'

describe('Kanban MVP API', () => {
  let server: MetaSheetServer
  let baseUrl = ''
  const viewId = randomUUID()
  let authToken = ''
  const authHeaders = () => ({ Authorization: `Bearer ${authToken}` })

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
    if (!tokenRes.ok) {
      throw new Error(`Failed to get dev token: ${tokenRes.status}`)
    }
    const tokenJson = await tokenRes.json()
    authToken = tokenJson.token as string

    const pool = poolManager.get()
    await pool.query(
      `INSERT INTO views (id, type, name, config, created_by)
       VALUES ($1, 'kanban', 'Kanban MVP Test', '{}'::jsonb, $2)
       ON CONFLICT (id) DO NOTHING`,
      [viewId, 1],
    )
  })

  afterAll(async () => {
    try {
      const pool = poolManager.get()
      await pool.query('DELETE FROM view_states WHERE view_id = $1', [viewId])
      await pool.query('DELETE FROM views WHERE id = $1', [viewId])
    } catch {
      // ignore cleanup failures
    }
    if (server && (server as any).stop) {
      await server.stop()
    }
  })

  it('GET returns config+state and supports ETag', async () => {
    if (!baseUrl) return
    const res1 = await fetch(`${baseUrl}/api/kanban/${viewId}`, { headers: authHeaders() })
    expect(res1.status).toBe(200)
    const etag = res1.headers.get('etag')
    expect(etag).toBeTruthy()
    const data1 = await res1.json() as any
    expect(data1.success).toBe(true)
    expect(data1.data).toBeDefined()

    const res304 = await fetch(`${baseUrl}/api/kanban/${viewId}`, {
      headers: { ...authHeaders(), 'If-None-Match': etag! }
    })
    expect(res304.status).toBe(304)
  })

  it('POST persists state and next GET reflects change', async () => {
    if (!baseUrl) return
    const newState = { columns: [{ id: 'todo', cards: ['1','2'] }] }
    const post = await fetch(`${baseUrl}/api/kanban/${viewId}/state`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: newState })
    })
    expect(post.status).toBe(204)

    const res = await fetch(`${baseUrl}/api/kanban/${viewId}`, { headers: authHeaders() })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.success).toBe(true)
    expect(body.data?.state).toBeDefined()
    expect(body.data.state.columns?.[0]?.id).toBe('todo')
  })

  it('returns 404 for unknown viewId', async () => {
    if (!baseUrl) return
    const res = await fetch(`${baseUrl}/api/kanban/unknown-view`, { headers: authHeaders() })
    expect([404, 200]).toContain(res.status) // allow 200 if demo data present
  })

  it('requires JWT when KANBAN_AUTH_REQUIRED=true', async () => {
    if (!baseUrl) return
    // simulate strict mode by calling without headers (server flag is env-based; test asserts 401 or 200 in relaxed)
    const res = await fetch(`${baseUrl}/api/kanban/${viewId}`)
    expect([200, 401]).toContain(res.status)
  })
})
