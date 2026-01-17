import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MetaSheetServer } from '../../src/index'
import * as path from 'path'
import net from 'net'
import crypto from 'crypto'
import { poolManager } from '../../src/integration/db/connection-pool'

describe('Kanban MVP API', () => {
  let server: MetaSheetServer
  let baseUrl = ''
  let viewId = ''
  let authToken = ''
  const userId = 1
  let previousSkip: string | undefined

  beforeAll(async () => {
    previousSkip = process.env.SKIP_PLUGINS
    process.env.SKIP_PLUGINS = 'false'
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
    const tokenRes = await fetch(`${baseUrl}/api/auth/dev-token?userId=${userId}`)
    const tokenJson = await tokenRes.json()
    authToken = tokenJson.token as string
    viewId = crypto.randomUUID()
    const pool = poolManager.get()
    await pool.query(
      'INSERT INTO views (id, type, name, config) VALUES ($1, $2, $3, $4)',
      [viewId, 'kanban', 'Kanban Test View', JSON.stringify({})]
    )
  })

  afterAll(async () => {
    if (viewId) {
      try {
        const pool = poolManager.get()
        await pool.query('DELETE FROM view_states WHERE view_id = $1', [viewId])
        await pool.query('DELETE FROM views WHERE id = $1', [viewId])
      } catch {
        // ignore cleanup failures
      }
    }
    if (server && (server as any).stop) {
      await server.stop()
    }
    if (previousSkip === undefined) {
      delete process.env.SKIP_PLUGINS
    } else {
      process.env.SKIP_PLUGINS = previousSkip
    }
  })

  it('GET returns config+state and supports ETag', async () => {
    if (!baseUrl) return
    const res1 = await fetch(`${baseUrl}/api/kanban/${viewId}`, {
      headers: { Authorization: `Bearer ${authToken}` }
    })
    expect(res1.status).toBe(200)
    const etag = res1.headers.get('etag')
    expect(etag).toBeTruthy()
    const data1 = await res1.json() as any
    expect(data1.success).toBe(true)
    expect(data1.data).toBeDefined()

    const res304 = await fetch(`${baseUrl}/api/kanban/${viewId}`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
        'If-None-Match': etag!
      }
    })
    expect(res304.status).toBe(304)
  })

  it('POST persists state and next GET reflects change', async () => {
    if (!baseUrl) return
    const newState = { columns: [{ id: 'todo', cards: ['1','2'] }] }
    const post = await fetch(`${baseUrl}/api/kanban/${viewId}/state`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({ state: newState })
    })
    expect(post.status).toBe(204)

    const res = await fetch(`${baseUrl}/api/kanban/${viewId}`, {
      headers: { Authorization: `Bearer ${authToken}` }
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.success).toBe(true)
    expect(body.data?.state).toBeDefined()
    expect(body.data.state.columns?.[0]?.id).toBe('todo')
  })

  it('returns 404 for unknown viewId', async () => {
    if (!baseUrl) return
    const unknownViewId = crypto.randomUUID()
    const res = await fetch(`${baseUrl}/api/kanban/${unknownViewId}`, {
      headers: { Authorization: `Bearer ${authToken}` }
    })
    expect(res.status).toBe(404)
  })

  it('requires JWT when KANBAN_AUTH_REQUIRED=true', async () => {
    if (!baseUrl) return
    // simulate strict mode by calling without headers (server flag is env-based; test asserts 401 or 200 in relaxed)
    const res = await fetch(`${baseUrl}/api/kanban/${viewId}`)
    expect(res.status).toBe(401)
  })
})
