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
    CREATE TABLE IF NOT EXISTS meta_bases (
      id varchar(50) PRIMARY KEY,
      name text NOT NULL,
      icon text,
      color text,
      owner_id text,
      workspace_id text,
      created_at timestamp DEFAULT now(),
      updated_at timestamp DEFAULT now(),
      deleted_at timestamp
    );
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS meta_sheets (
      id varchar(50) PRIMARY KEY,
      base_id varchar(50),
      name text NOT NULL,
      description text,
      created_at timestamp DEFAULT now(),
      updated_at timestamp DEFAULT now(),
      deleted_at timestamp
    );
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS meta_views (
      id varchar(50) PRIMARY KEY,
      sheet_id varchar(50) NOT NULL,
      name text NOT NULL,
      type text NOT NULL,
      filter_info jsonb DEFAULT '{}'::jsonb,
      sort_info jsonb DEFAULT '{}'::jsonb,
      group_info jsonb DEFAULT '{}'::jsonb,
      hidden_field_ids jsonb DEFAULT '[]'::jsonb,
      config jsonb DEFAULT '{}'::jsonb,
      created_at timestamp DEFAULT now(),
      updated_at timestamp DEFAULT now()
    );
  `)
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS meta_comment_reads (
      comment_id varchar(50) NOT NULL,
      user_id varchar(50) NOT NULL,
      read_at timestamp DEFAULT now(),
      created_at timestamp DEFAULT now(),
      PRIMARY KEY (comment_id, user_id)
    );
  `)
  await pool.query('CREATE INDEX IF NOT EXISTS idx_comments_sheet ON meta_comments(spreadsheet_id);')
  await pool.query('CREATE INDEX IF NOT EXISTS idx_comments_row ON meta_comments(row_id);')
  await pool.query('CREATE INDEX IF NOT EXISTS idx_comment_reads_user ON meta_comment_reads(user_id, read_at DESC);')
}

describe('Comments API', () => {
  let server: MetaSheetServer
  let baseUrl: string
  let createdCommentIds: string[] = []
  let createdViewIds: string[] = []
  let createdSheetIds: string[] = []
  let createdBaseIds: string[] = []

  beforeAll(async () => {
    process.env.RBAC_BYPASS = 'true'
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
    delete process.env.RBAC_BYPASS
    try {
      const pool = poolManager.get()
      if (createdCommentIds.length > 0) {
        await pool.query('DELETE FROM meta_comment_reads WHERE comment_id = ANY($1::text[])', [createdCommentIds])
        await pool.query('DELETE FROM meta_comments WHERE id = ANY($1::text[])', [createdCommentIds])
      }
      if (createdViewIds.length > 0) {
        await pool.query('DELETE FROM meta_views WHERE id = ANY($1::text[])', [createdViewIds])
      }
      if (createdSheetIds.length > 0) {
        await pool.query('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [createdSheetIds])
      }
      if (createdBaseIds.length > 0) {
        await pool.query('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [createdBaseIds])
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
    const baseId = `base_comments_${ts}`.slice(0, 50)
    const spreadsheetId = `sheet_comments_${ts}`.slice(0, 50)
    const viewId = `view_comments_${ts}`.slice(0, 50)
    const rowId = `rec_comments_${ts}`.slice(0, 50)
    const content = 'Hello from user_1'

    const pool = poolManager.get()
    await pool.query(
      'INSERT INTO meta_bases (id, name) VALUES ($1, $2)',
      [baseId, 'Comments Base'],
    )
    createdBaseIds.push(baseId)
    await pool.query(
      'INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)',
      [spreadsheetId, baseId, 'Comments Sheet'],
    )
    createdSheetIds.push(spreadsheetId)
    await pool.query(
      'INSERT INTO meta_views (id, sheet_id, name, type) VALUES ($1, $2, $3, $4)',
      [viewId, spreadsheetId, 'All Comments', 'grid'],
    )
    createdViewIds.push(viewId)

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
      body: JSON.stringify({ spreadsheetId, rowId, content, mentions: ['user_2'] }),
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
    expect(comment?.mentions?.includes('user_2')).toBe(true)

    const listRes = await fetch(`${baseUrl}/api/comments?spreadsheetId=${spreadsheetId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(listRes.status).toBe(200)
    const listJson = await listRes.json()
    expect(listJson.ok).toBe(true)
    const items = listJson.data?.items ?? []
    const total = listJson.data?.total ?? 0
    expect(total).toBeGreaterThanOrEqual(items.length)
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

    const listLimitedRes = await fetch(`${baseUrl}/api/comments?spreadsheetId=${spreadsheetId}&limit=1&offset=0`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(listLimitedRes.status).toBe(200)
    const listLimitedJson = await listLimitedRes.json()
    expect(listLimitedJson.ok).toBe(true)
    expect(listLimitedJson.data?.items?.length).toBeLessThanOrEqual(1)
    expect(listLimitedJson.data?.total).toBeGreaterThanOrEqual(1)

    const listUnresolvedRes = await fetch(`${baseUrl}/api/comments?spreadsheetId=${spreadsheetId}&resolved=false`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(listUnresolvedRes.status).toBe(200)
    const listUnresolvedJson = await listUnresolvedRes.json()
    expect(listUnresolvedJson.ok).toBe(true)
    expect(listUnresolvedJson.data?.items?.some((item: any) => item.id === comment.id)).toBe(true)

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

    const listResolvedRes = await fetch(`${baseUrl}/api/comments?spreadsheetId=${spreadsheetId}&resolved=true`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(listResolvedRes.status).toBe(200)
    const listResolvedJson = await listResolvedRes.json()
    expect(listResolvedJson.ok).toBe(true)
    expect(listResolvedJson.data?.items?.some((item: any) => item.id === comment.id)).toBe(true)

    const mentionTokenRes = await fetch(`${baseUrl}/api/auth/dev-token?userId=user_2`)
    expect(mentionTokenRes.status).toBe(200)
    const mentionTokenJson = await mentionTokenRes.json()
    const mentionToken = mentionTokenJson.token as string

    const unreadCountRes = await fetch(`${baseUrl}/api/comments/unread-count`, {
      headers: { Authorization: `Bearer ${mentionToken}` },
    })
    expect(unreadCountRes.status).toBe(200)
    const unreadCountJson = await unreadCountRes.json()
    expect(unreadCountJson.ok).toBe(true)
    expect(unreadCountJson.data?.count).toBeGreaterThanOrEqual(1)

    const inboxRes = await fetch(`${baseUrl}/api/comments/inbox`, {
      headers: { Authorization: `Bearer ${mentionToken}` },
    })
    expect(inboxRes.status).toBe(200)
    const inboxJson = await inboxRes.json()
    expect(inboxJson.ok).toBe(true)
    const inboxItem = inboxJson.data?.items?.find((item: any) => item.id === comment.id)
    expect(inboxItem).toBeTruthy()
    expect(inboxItem.unread).toBe(true)
    expect(inboxItem.baseId).toBe(baseId)
    expect(inboxItem.sheetId).toBe(spreadsheetId)
    expect(inboxItem.viewId).toBe(viewId)
    expect(inboxItem.recordId).toBe(rowId)

    const markReadRes = await fetch(`${baseUrl}/api/comments/${comment.id}/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mentionToken}` },
    })
    expect(markReadRes.status).toBe(204)

    const unreadAfterRes = await fetch(`${baseUrl}/api/comments/unread-count`, {
      headers: { Authorization: `Bearer ${mentionToken}` },
    })
    expect(unreadAfterRes.status).toBe(200)
    const unreadAfterJson = await unreadAfterRes.json()
    expect(unreadAfterJson.ok).toBe(true)
    expect(unreadAfterJson.data?.count).toBe(0)

    const tokenFallbackRes = await fetch(`${baseUrl}/api/comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        spreadsheetId,
        rowId,
        content: 'Fallback @[Jamie](user_2)',
      }),
    })
    expect(tokenFallbackRes.status).toBe(201)
    const fallbackJson = await tokenFallbackRes.json()
    if (fallbackJson.data?.comment?.id) {
      createdCommentIds.push(fallbackJson.data.comment.id)
    }
    expect(fallbackJson.data?.comment?.mentions).toEqual(['user_2'])
  })
})
