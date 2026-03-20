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
      target_type varchar(50) NOT NULL DEFAULT 'spreadsheet_row',
      target_id varchar(50) NOT NULL DEFAULT '',
      target_field_id varchar(50),
      container_type varchar(50) NOT NULL DEFAULT 'spreadsheet',
      container_id varchar(50) NOT NULL DEFAULT '',
      content text NOT NULL,
      author_id varchar(50) NOT NULL,
      parent_id varchar(50),
      resolved boolean DEFAULT false,
      created_at timestamp DEFAULT now(),
      updated_at timestamp DEFAULT now(),
      mentions jsonb
    );
  `)
  await pool.query(`ALTER TABLE meta_comments ADD COLUMN IF NOT EXISTS target_type varchar(50)`)
  await pool.query(`ALTER TABLE meta_comments ADD COLUMN IF NOT EXISTS target_id varchar(50)`)
  await pool.query(`ALTER TABLE meta_comments ADD COLUMN IF NOT EXISTS target_field_id varchar(50)`)
  await pool.query(`ALTER TABLE meta_comments ADD COLUMN IF NOT EXISTS container_type varchar(50)`)
  await pool.query(`ALTER TABLE meta_comments ADD COLUMN IF NOT EXISTS container_id varchar(50)`)
  await pool.query(`
    UPDATE meta_comments
    SET
      target_type = COALESCE(NULLIF(target_type, ''), 'spreadsheet_row'),
      target_id = COALESCE(NULLIF(target_id, ''), row_id),
      target_field_id = COALESCE(target_field_id, field_id),
      container_type = COALESCE(NULLIF(container_type, ''), 'spreadsheet'),
      container_id = COALESCE(NULLIF(container_id, ''), spreadsheet_id)
  `)
  await pool.query('CREATE INDEX IF NOT EXISTS idx_comments_sheet ON meta_comments(spreadsheet_id);')
  await pool.query('CREATE INDEX IF NOT EXISTS idx_comments_row ON meta_comments(row_id);')
  await pool.query('CREATE INDEX IF NOT EXISTS idx_comments_container ON meta_comments(container_type, container_id);')
  await pool.query('CREATE INDEX IF NOT EXISTS idx_comments_target ON meta_comments(target_type, target_id);')
}

describe('Comments API', () => {
  let server: MetaSheetServer
  let baseUrl: string
  let createdCommentIds: string[] = []

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
    expect(comment?.targetType).toBe('spreadsheet_row')
    expect(comment?.targetId).toBe(rowId)
    expect(comment?.containerType).toBe('spreadsheet')
    expect(comment?.containerId).toBe(spreadsheetId)
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

    const patchRes = await fetch(`${baseUrl}/api/comments/${comment.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ content: 'Hello @[user_1](u1) updated' }),
    })
    expect(patchRes.status).toBe(200)
    const patchJson = await patchRes.json()
    expect(patchJson.ok).toBe(true)
    expect(patchJson.data?.comment?.content).toBe('Hello @[user_1](u1) updated')
    expect(patchJson.data?.comment?.mentions?.includes('user_1')).toBe(true)

    const deleteRes = await fetch(`${baseUrl}/api/comments/${comment.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(deleteRes.status).toBe(204)

    const listDeletedRes = await fetch(`${baseUrl}/api/comments?spreadsheetId=${spreadsheetId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(listDeletedRes.status).toBe(200)
    const listDeletedJson = await listDeletedRes.json()
    expect(listDeletedJson.ok).toBe(true)
    expect(listDeletedJson.data?.items?.some((item: any) => item.id === comment.id)).toBe(false)
    createdCommentIds = createdCommentIds.filter((id) => id !== comment.id)
  })

  it('creates and lists polymorphic meta_record comments', async () => {
    if (!baseUrl) return

    const ts = Date.now()
    const containerId = `sheet_meta_${ts}`.slice(0, 50)
    const targetId = `rec_meta_${ts}`.slice(0, 50)
    const targetFieldId = `fld_meta_${ts}`.slice(0, 50)

    const tokenRes = await fetch(`${baseUrl}/api/auth/dev-token?userId=user_1`)
    expect(tokenRes.status).toBe(200)
    const tokenJson = await tokenRes.json()
    const token = tokenJson.token as string

    const createRes = await fetch(`${baseUrl}/api/comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        targetType: 'meta_record',
        targetId,
        targetFieldId,
        containerType: 'meta_sheet',
        containerId,
        content: 'Record scoped comment',
      }),
    })
    expect(createRes.status).toBe(201)
    const createJson = await createRes.json()
    expect(createJson.ok).toBe(true)
    const comment = createJson.data?.comment
    createdCommentIds.push(comment.id)
    expect(comment?.targetType).toBe('meta_record')
    expect(comment?.targetId).toBe(targetId)
    expect(comment?.targetFieldId).toBe(targetFieldId)
    expect(comment?.containerType).toBe('meta_sheet')
    expect(comment?.containerId).toBe(containerId)
    expect(comment?.spreadsheetId).toBe(containerId)
    expect(comment?.rowId).toBe(targetId)
    expect(comment?.fieldId).toBe(targetFieldId)

    const listRes = await fetch(
      `${baseUrl}/api/comments?containerType=meta_sheet&containerId=${containerId}&targetType=meta_record&targetId=${targetId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    expect(listRes.status).toBe(200)
    const listJson = await listRes.json()
    expect(listJson.ok).toBe(true)
    expect(listJson.data?.items?.some((item: any) => item.id === comment.id)).toBe(true)
    expect(listJson.data?.items?.every((item: any) => item.targetType === 'meta_record')).toBe(true)
  })
})
