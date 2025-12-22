import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'

async function canListenOnEphemeralPort(): Promise<boolean> {
  return await new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
  })
}

async function ensureCommentsTable() {
  const pool = poolManager.get()
  await pool.query(`
    CREATE TABLE IF NOT EXISTS meta_comments (
      id varchar(50) PRIMARY KEY,
      spreadsheet_id varchar(50) NOT NULL,
      row_id varchar(50) NOT NULL,
      field_id varchar(50),
      content text NOT NULL,
      author_id varchar(50) NOT NULL,
      parent_id varchar(50),
      resolved boolean DEFAULT false,
      created_at timestamp DEFAULT now(),
      updated_at timestamp DEFAULT now(),
      mentions jsonb
    );
  `)
  await pool.query('CREATE INDEX IF NOT EXISTS idx_comments_sheet ON meta_comments(spreadsheet_id);')
  await pool.query('CREATE INDEX IF NOT EXISTS idx_comments_row ON meta_comments(row_id);')
}

describe('Comments API', () => {
  let server: MetaSheetServer
  let baseUrl: string
  let createdCommentIds: string[] = []

  beforeAll(async () => {
    const canListen = await canListenOnEphemeralPort()
    if (!canListen) return

    await ensureCommentsTable()

    server = new MetaSheetServer({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [],
    })
    await server.start()
    const address = server.getAddress()
    if (!address?.port) return
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    try {
      const pool = poolManager.get()
      if (createdCommentIds.length > 0) {
        await pool.query('DELETE FROM meta_comments WHERE id = ANY($1::text[])', [createdCommentIds])
      }
    } catch {
      // ignore cleanup failures
    }

    if (server && (server as any).stop) {
      await server.stop()
    }
  })

  it('creates, lists, and resolves comments', async () => {
    if (!baseUrl) return

    const ts = Date.now()
    const spreadsheetId = `sheet_comments_${ts}`.slice(0, 50)
    const rowId = `rec_comments_${ts}`.slice(0, 50)
    const content = 'Hello @[user_1](u1)'

    const tokenRes = await fetch(`${baseUrl}/api/auth/dev-token?userId=user_1`)
    expect(tokenRes.status).toBe(200)
    const tokenJson = await tokenRes.json()
    const token = tokenJson.token as string
    expect(typeof token).toBe('string')

    const createRes = await fetch(`${baseUrl}/api/comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ spreadsheetId, rowId, content }),
    })
    expect(createRes.status).toBe(201)
    const created = await createRes.json()
    expect(created.ok).toBe(true)
    const comment = created.data?.comment
    expect(comment?.id).toBeTruthy()
    createdCommentIds.push(comment.id)
    expect(comment?.spreadsheetId).toBe(spreadsheetId)
    expect(comment?.rowId).toBe(rowId)
    expect(comment?.authorId).toBe('user_1')
    expect(Array.isArray(comment?.mentions)).toBe(true)
    expect(comment?.mentions?.includes('user_1')).toBe(true)

    const listRes = await fetch(`${baseUrl}/api/comments?spreadsheetId=${spreadsheetId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(listRes.status).toBe(200)
    const listJson = await listRes.json()
    expect(listJson.ok).toBe(true)
    const items = listJson.data?.items ?? []
    expect(items.some((item: any) => item.id === comment.id)).toBe(true)

    const listRowRes = await fetch(`${baseUrl}/api/comments?spreadsheetId=${spreadsheetId}&rowId=${rowId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(listRowRes.status).toBe(200)
    const listRowJson = await listRowRes.json()
    expect(listRowJson.ok).toBe(true)
    const rowItems = listRowJson.data?.items ?? []
    expect(rowItems.length).toBeGreaterThan(0)
    expect(rowItems.every((item: any) => item.rowId === rowId)).toBe(true)

    const resolveRes = await fetch(`${baseUrl}/api/comments/${comment.id}/resolve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(resolveRes.status).toBe(204)

    const listAfterRes = await fetch(`${baseUrl}/api/comments?spreadsheetId=${spreadsheetId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(listAfterRes.status).toBe(200)
    const listAfterJson = await listAfterRes.json()
    const updated = listAfterJson.data?.items?.find((item: any) => item.id === comment.id)
    expect(updated?.resolved).toBe(true)
  })
})
