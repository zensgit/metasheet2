import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { io as ioClient } from 'socket.io-client'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'

async function canListenOnEphemeralPort(): Promise<boolean> {
  return await new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
  })
}

async function ensureCommentsTables() {
  const pool = poolManager.get()
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id varchar(50) PRIMARY KEY,
      email text NOT NULL,
      name text,
      password_hash text NOT NULL DEFAULT '',
      role text NOT NULL DEFAULT 'editor',
      permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
      avatar_url text,
      is_active boolean NOT NULL DEFAULT true,
      is_admin boolean NOT NULL DEFAULT false,
      last_login_at timestamp,
      created_at timestamp DEFAULT now(),
      updated_at timestamp DEFAULT now()
    );
  `)
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
  const createdCommentIds: string[] = []
  const createdViewIds: string[] = []
  const createdSheetIds: string[] = []
  const createdBaseIds: string[] = []

  beforeAll(async () => {
    process.env.RBAC_BYPASS = 'true'
    const canListen = await canListenOnEphemeralPort()
    if (!canListen) return

    await ensureCommentsTables()

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

  it('creates, lists, resolves, and exposes inbox activity state', async () => {
    if (!baseUrl) return

    const ts = Date.now()
    const baseId = `base_comments_${ts}`.slice(0, 50)
    const spreadsheetId = `sheet_comments_${ts}`.slice(0, 50)
    const viewId = `view_comments_${ts}`.slice(0, 50)
    const rowId = `rec_comments_${ts}`.slice(0, 50)
    const pool = poolManager.get()

    await pool.query('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [baseId, 'Comments Base'])
    createdBaseIds.push(baseId)
    await pool.query('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [
      spreadsheetId,
      baseId,
      'Comments Sheet',
    ])
    createdSheetIds.push(spreadsheetId)
    await pool.query('INSERT INTO meta_views (id, sheet_id, name, type) VALUES ($1, $2, $3, $4)', [
      viewId,
      spreadsheetId,
      'All Comments',
      'grid',
    ])
    createdViewIds.push(viewId)

    const authorToken = (await (await fetch(`${baseUrl}/api/auth/dev-token?userId=user_1`)).json()).token as string
    const mentionedToken = (await (await fetch(`${baseUrl}/api/auth/dev-token?userId=user_2`)).json()).token as string

    const createRes = await fetch(`${baseUrl}/api/comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authorToken}`,
      },
      body: JSON.stringify({
        spreadsheetId,
        rowId,
        content: 'Hello from user_1',
        mentions: ['user_2'],
      }),
    })
    expect(createRes.status).toBe(201)
    const created = await createRes.json()
    const comment = created.data?.comment
    createdCommentIds.push(comment.id)
    expect(comment?.mentions).toEqual(['user_2'])

    const fallbackRes = await fetch(`${baseUrl}/api/comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authorToken}`,
      },
      body: JSON.stringify({
        spreadsheetId,
        rowId,
        content: 'Fallback @[Jamie](user_2)',
      }),
    })
    expect(fallbackRes.status).toBe(201)
    const fallbackJson = await fallbackRes.json()
    createdCommentIds.push(fallbackJson.data.comment.id)
    expect(fallbackJson.data.comment.mentions).toEqual(['user_2'])

    const plainRes = await fetch(`${baseUrl}/api/comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authorToken}`,
      },
      body: JSON.stringify({
        spreadsheetId,
        rowId,
        content: 'Unread activity without mention',
      }),
    })
    expect(plainRes.status).toBe(201)
    const plainJson = await plainRes.json()
    const plainComment = plainJson.data?.comment
    createdCommentIds.push(plainComment.id)
    expect(plainComment?.mentions).toEqual([])

    const listRes = await fetch(`${baseUrl}/api/comments?spreadsheetId=${spreadsheetId}`, {
      headers: { Authorization: `Bearer ${authorToken}` },
    })
    expect(listRes.status).toBe(200)
    const listJson = await listRes.json()
    expect(listJson.data.items.some((item: any) => item.id === comment.id)).toBe(true)

    const unreadCountRes = await fetch(`${baseUrl}/api/comments/unread-count`, {
      headers: { Authorization: `Bearer ${mentionedToken}` },
    })
    expect(unreadCountRes.status).toBe(200)
    const unreadCountJson = await unreadCountRes.json()
    expect(unreadCountJson.data.count).toBe(3)

    const inboxRes = await fetch(`${baseUrl}/api/comments/inbox`, {
      headers: { Authorization: `Bearer ${mentionedToken}` },
    })
    expect(inboxRes.status).toBe(200)
    const inboxJson = await inboxRes.json()
    const inboxItem = inboxJson.data.items.find((item: any) => item.id === comment.id)
    const plainInboxItem = inboxJson.data.items.find((item: any) => item.id === plainComment.id)
    expect(inboxItem).toBeTruthy()
    expect(inboxItem.unread).toBe(true)
    expect(inboxItem.mentioned).toBe(true)
    expect(inboxItem.baseId).toBe(baseId)
    expect(inboxItem.sheetId).toBe(spreadsheetId)
    expect(inboxItem.viewId).toBe(viewId)
    expect(inboxItem.recordId).toBe(rowId)
    expect(plainInboxItem).toBeTruthy()
    expect(plainInboxItem.unread).toBe(true)
    expect(plainInboxItem.mentioned).toBe(false)
    expect(inboxJson.data.total).toBe(3)

    const markReadRes = await fetch(`${baseUrl}/api/comments/${comment.id}/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mentionedToken}` },
    })
    expect(markReadRes.status).toBe(204)

    const unreadAfterRes = await fetch(`${baseUrl}/api/comments/unread-count`, {
      headers: { Authorization: `Bearer ${mentionedToken}` },
    })
    expect(unreadAfterRes.status).toBe(200)
    const unreadAfterJson = await unreadAfterRes.json()
    expect(unreadAfterJson.data.count).toBe(2)

    const resolveRes = await fetch(`${baseUrl}/api/comments/${comment.id}/resolve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authorToken}` },
    })
    expect(resolveRes.status).toBe(204)

    const resolvedListRes = await fetch(`${baseUrl}/api/comments?spreadsheetId=${spreadsheetId}&resolved=true`, {
      headers: { Authorization: `Bearer ${authorToken}` },
    })
    expect(resolvedListRes.status).toBe(200)
    const resolvedListJson = await resolvedListRes.json()
    expect(resolvedListJson.data.items.some((item: any) => item.id === comment.id)).toBe(true)
  })

  it('updates authored comments and only deletes leaf comments', async () => {
    if (!baseUrl) return

    const ts = Date.now()
    const baseId = `base_comments_edit_${ts}`.slice(0, 50)
    const spreadsheetId = `sheet_comments_edit_${ts}`.slice(0, 50)
    const viewId = `view_comments_edit_${ts}`.slice(0, 50)
    const rowId = `rec_comments_edit_${ts}`.slice(0, 50)
    const pool = poolManager.get()

    await pool.query('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [baseId, 'Comments Edit Base'])
    createdBaseIds.push(baseId)
    await pool.query('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [
      spreadsheetId,
      baseId,
      'Comments Edit Sheet',
    ])
    createdSheetIds.push(spreadsheetId)
    await pool.query('INSERT INTO meta_views (id, sheet_id, name, type) VALUES ($1, $2, $3, $4)', [
      viewId,
      spreadsheetId,
      'Edit Comments',
      'grid',
    ])
    createdViewIds.push(viewId)

    const authorToken = (await (await fetch(`${baseUrl}/api/auth/dev-token?userId=user_edit_author`)).json()).token as string
    const otherToken = (await (await fetch(`${baseUrl}/api/auth/dev-token?userId=user_edit_other`)).json()).token as string

    const rootRes = await fetch(`${baseUrl}/api/comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authorToken}`,
      },
      body: JSON.stringify({
        spreadsheetId,
        rowId,
        fieldId: 'fld_note',
        content: 'Root @[Reviewer](user_edit_other)',
        mentions: ['user_edit_other'],
      }),
    })
    expect(rootRes.status).toBe(201)
    const rootComment = (await rootRes.json()).data?.comment
    createdCommentIds.push(rootComment.id)

    const patchRes = await fetch(`${baseUrl}/api/comments/${rootComment.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authorToken}`,
      },
      body: JSON.stringify({
        content: 'Edited @[Reviewer](user_edit_other)',
        mentions: ['user_edit_other'],
      }),
    })
    expect(patchRes.status).toBe(200)
    const patchJson = await patchRes.json()
    expect(patchJson.data.comment.content).toBe('Edited @[Reviewer](user_edit_other)')
    expect(patchJson.data.comment.mentions).toEqual(['user_edit_other'])
    expect(typeof patchJson.data.comment.updatedAt).toBe('string')

    const forbiddenPatchRes = await fetch(`${baseUrl}/api/comments/${rootComment.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${otherToken}`,
      },
      body: JSON.stringify({
        content: 'Hijack',
      }),
    })
    expect(forbiddenPatchRes.status).toBe(403)

    const replyRes = await fetch(`${baseUrl}/api/comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${otherToken}`,
      },
      body: JSON.stringify({
        spreadsheetId,
        rowId,
        parentId: rootComment.id,
        content: 'Reply',
      }),
    })
    expect(replyRes.status).toBe(201)
    const replyComment = (await replyRes.json()).data?.comment
    createdCommentIds.push(replyComment.id)

    const conflictDeleteRes = await fetch(`${baseUrl}/api/comments/${rootComment.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authorToken}` },
    })
    expect(conflictDeleteRes.status).toBe(409)

    const deleteReplyRes = await fetch(`${baseUrl}/api/comments/${replyComment.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${otherToken}` },
    })
    expect(deleteReplyRes.status).toBe(204)

    const listAfterDeleteRes = await fetch(`${baseUrl}/api/comments?spreadsheetId=${spreadsheetId}`, {
      headers: { Authorization: `Bearer ${authorToken}` },
    })
    expect(listAfterDeleteRes.status).toBe(200)
    const listAfterDeleteJson = await listAfterDeleteRes.json()
    expect(listAfterDeleteJson.data.items.some((item: any) => item.id === replyComment.id)).toBe(false)
    expect(listAfterDeleteJson.data.items.some((item: any) => item.id === rootComment.id)).toBe(true)
  })

  it('returns mention-aware unresolved comment summaries for the current requester', async () => {
    if (!baseUrl) return

    const ts = Date.now()
    const spreadsheetId = `sheet_summary_${ts}`.slice(0, 50)
    const rowId = `rec_summary_${ts}`.slice(0, 50)
    const fieldId = 'fld_title'

    const mentionedToken = (await (await fetch(`${baseUrl}/api/auth/dev-token?userId=user_2`)).json()).token as string
    const authorToken = (await (await fetch(`${baseUrl}/api/auth/dev-token?userId=user_1`)).json()).token as string

    const createMentionedRes = await fetch(`${baseUrl}/api/comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authorToken}`,
      },
      body: JSON.stringify({
        spreadsheetId,
        rowId,
        fieldId,
        content: 'Hello',
        mentions: ['user_2'],
      }),
    })
    expect(createMentionedRes.status).toBe(201)
    const mentionedComment = (await createMentionedRes.json()).data?.comment
    createdCommentIds.push(mentionedComment.id)

    const createPlainRes = await fetch(`${baseUrl}/api/comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authorToken}`,
      },
      body: JSON.stringify({
        spreadsheetId,
        rowId,
        content: 'Plain note',
      }),
    })
    expect(createPlainRes.status).toBe(201)
    const plainComment = (await createPlainRes.json()).data?.comment
    createdCommentIds.push(plainComment.id)

    const summaryRes = await fetch(`${baseUrl}/api/comments/summary?spreadsheetId=${spreadsheetId}&rowIds=${rowId}`, {
      headers: { Authorization: `Bearer ${mentionedToken}` },
    })
    expect(summaryRes.status).toBe(200)
    const summaryJson = await summaryRes.json()
    expect(summaryJson.data.items).toEqual([
      {
        spreadsheetId,
        rowId,
        unresolvedCount: 2,
        fieldCounts: { [fieldId]: 1 },
        mentionedCount: 1,
        mentionedFieldCounts: { [fieldId]: 1 },
      },
    ])
  })

  it('lists active mention candidates for comment authoring', async () => {
    if (!baseUrl) return

    const pool = poolManager.get()
    await pool.query(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, avatar_url, is_active, is_admin)
       VALUES
         ($1, $2, $3, '', 'editor', '[]'::jsonb, NULL, true, false),
         ($4, $5, $6, '', 'editor', '[]'::jsonb, NULL, true, false),
         ($7, $8, $9, '', 'editor', '[]'::jsonb, NULL, false, false)
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         name = EXCLUDED.name,
         is_active = EXCLUDED.is_active`,
      [
        'user_jamie',
        'jamie@example.com',
        'Jamie Example',
        'user_jordan',
        'jordan@example.com',
        'Jordan Example',
        'user_inactive',
        'inactive@example.com',
        'Inactive Example',
      ],
    )

    const token = (await (await fetch(`${baseUrl}/api/auth/dev-token?userId=user_1`)).json()).token as string
    const response = await fetch(`${baseUrl}/api/comments/mention-candidates?spreadsheetId=sheet_orders&q=jam&limit=10`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(200)

    const json = await response.json()
    expect(json.data.total).toBe(1)
    expect(json.data.limit).toBe(10)
    expect(json.data.items).toEqual([
      {
        id: 'user_jamie',
        label: 'Jamie Example',
        subtitle: 'jamie@example.com',
      },
    ])
  })

  it('creates field comments and one-level replies with inherited field scope', async () => {
    if (!baseUrl) return

    const ts = Date.now()
    const spreadsheetId = `sheet_field_comments_${ts}`.slice(0, 50)
    const rowId = `rec_field_comments_${ts}`.slice(0, 50)
    const fieldId = 'fld_title'
    const token = (await (await fetch(`${baseUrl}/api/auth/dev-token?userId=user_2`)).json()).token as string

    const rootRes = await fetch(`${baseUrl}/api/comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        spreadsheetId,
        rowId,
        fieldId,
        content: 'Field root',
      }),
    })
    expect(rootRes.status).toBe(201)
    const rootComment = (await rootRes.json()).data?.comment
    createdCommentIds.push(rootComment.id)
    expect(rootComment.fieldId).toBe(fieldId)

    const replyRes = await fetch(`${baseUrl}/api/comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        spreadsheetId,
        rowId,
        parentId: rootComment.id,
        content: 'Reply note',
      }),
    })
    expect(replyRes.status).toBe(201)
    const replyComment = (await replyRes.json()).data?.comment
    createdCommentIds.push(replyComment.id)
    expect(replyComment.parentId).toBe(rootComment.id)
    expect(replyComment.fieldId).toBe(fieldId)
  })

  it('filters listed comments by field scope when fieldId is provided', async () => {
    if (!baseUrl) return

    const ts = Date.now()
    const spreadsheetId = `sheet_field_filter_${ts}`.slice(0, 50)
    const rowId = `rec_field_filter_${ts}`.slice(0, 50)
    const token = (await (await fetch(`${baseUrl}/api/auth/dev-token?userId=user_2`)).json()).token as string

    const create = async (payload: { fieldId?: string; content: string }) => {
      const response = await fetch(`${baseUrl}/api/comments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          spreadsheetId,
          rowId,
          fieldId: payload.fieldId,
          content: payload.content,
        }),
      })
      expect(response.status).toBe(201)
      const json = await response.json()
      createdCommentIds.push(json.data.comment.id)
      return json.data.comment
    }

    const titleComment = await create({ fieldId: 'fld_title', content: 'Title note' })
    await create({ fieldId: 'fld_status', content: 'Status note' })
    await create({ content: 'Record note' })

    const response = await fetch(`${baseUrl}/api/comments?spreadsheetId=${spreadsheetId}&rowId=${rowId}&fieldId=fld_title`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(200)

    const json = await response.json()
    expect(json.data.total).toBe(1)
    expect(json.data.items).toHaveLength(1)
    expect(json.data.items[0]).toMatchObject({
      id: titleComment.id,
      spreadsheetId,
      rowId,
      fieldId: 'fld_title',
      content: 'Title note',
    })
  })

  it('rejects invalid parent comment scopes and reply-to-reply chains', async () => {
    if (!baseUrl) return

    const ts = Date.now()
    const spreadsheetId = `sheet_invalid_parent_${ts}`.slice(0, 50)
    const rowId = `rec_invalid_parent_${ts}`.slice(0, 50)
    const otherRowId = `rec_invalid_parent_other_${ts}`.slice(0, 50)
    const token = (await (await fetch(`${baseUrl}/api/auth/dev-token?userId=user_3`)).json()).token as string

    const rootRes = await fetch(`${baseUrl}/api/comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        spreadsheetId,
        rowId,
        fieldId: 'fld_status',
        content: 'Status root',
      }),
    })
    expect(rootRes.status).toBe(201)
    const rootComment = (await rootRes.json()).data?.comment
    createdCommentIds.push(rootComment.id)

    const replyRes = await fetch(`${baseUrl}/api/comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        spreadsheetId,
        rowId,
        parentId: rootComment.id,
        content: 'First reply',
      }),
    })
    expect(replyRes.status).toBe(201)
    const replyComment = (await replyRes.json()).data?.comment
    createdCommentIds.push(replyComment.id)

    const nestedReplyRes = await fetch(`${baseUrl}/api/comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        spreadsheetId,
        rowId,
        parentId: replyComment.id,
        content: 'Nested reply',
      }),
    })
    expect(nestedReplyRes.status).toBe(400)
    const nestedReplyJson = await nestedReplyRes.json()
    expect(nestedReplyJson.error.code).toBe('VALIDATION_ERROR')
    expect(nestedReplyJson.error.message).toContain('Replying to replies is not supported')

    const mismatchedRowRes = await fetch(`${baseUrl}/api/comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        spreadsheetId,
        rowId: otherRowId,
        parentId: rootComment.id,
        content: 'Wrong row reply',
      }),
    })
    expect(mismatchedRowRes.status).toBe(400)
    const mismatchedRowJson = await mismatchedRowRes.json()
    expect(mismatchedRowJson.error.code).toBe('VALIDATION_ERROR')
    expect(mismatchedRowJson.error.message).toContain('same record thread')
  })

  it('returns current-user mention-summary with correct aggregation, unread counts, and sort order', async () => {
    if (!baseUrl) return

    const ts = Date.now()
    const spreadsheetId = `sheet_mention_${ts}`.slice(0, 50)
    const row1 = `rec_mention_1_${ts}`.slice(0, 50)
    const row2 = `rec_mention_2_${ts}`.slice(0, 50)
    const row3 = `rec_mention_3_${ts}`.slice(0, 50)

    const authorToken = (await (await fetch(`${baseUrl}/api/auth/dev-token?userId=author_1`)).json()).token as string
    const mentionedToken = (await (await fetch(`${baseUrl}/api/auth/dev-token?userId=target_user`)).json()).token as string

    async function create(body: Record<string, unknown>) {
      const res = await fetch(`${baseUrl}/api/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authorToken}` },
        body: JSON.stringify(body),
      })
      expect(res.status).toBe(201)
      const json = await res.json()
      createdCommentIds.push(json.data.comment.id)
      return json.data.comment
    }

    await create({ spreadsheetId, rowId: row1, fieldId: 'fld_a', content: 'hey', mentions: ['target_user'] })
    await create({ spreadsheetId, rowId: row1, fieldId: 'fld_b', content: 'also', mentions: ['target_user'] })
    await create({ spreadsheetId, rowId: row2, content: 'cc', mentions: ['target_user'] })
    await create({ spreadsheetId, rowId: row3, content: 'hey', mentions: ['other_user'] })
    const resolved = await create({ spreadsheetId, rowId: row1, content: 'done', mentions: ['target_user'] })
    await fetch(`${baseUrl}/api/comments/${resolved.id}/resolve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authorToken}` },
    })

    const res = await fetch(`${baseUrl}/api/comments/mention-summary?spreadsheetId=${spreadsheetId}`, {
      headers: { Authorization: `Bearer ${mentionedToken}` },
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.unresolvedMentionCount).toBe(3)
    expect(json.data.mentionedRecordCount).toBe(2)
    expect(json.data.unreadMentionCount).toBe(3)
    expect(json.data.unreadRecordCount).toBe(2)
    expect(json.data.items).toEqual([
      { rowId: row1, mentionedCount: 2, unreadCount: 2, mentionedFieldIds: ['fld_a', 'fld_b'] },
      { rowId: row2, mentionedCount: 1, unreadCount: 1, mentionedFieldIds: [] },
    ])

    const markReadRes = await fetch(`${baseUrl}/api/comments/mention-summary/mark-read`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${mentionedToken}`,
      },
      body: JSON.stringify({ spreadsheetId }),
    })
    expect(markReadRes.status).toBe(204)

    const afterMarkReadRes = await fetch(`${baseUrl}/api/comments/mention-summary?spreadsheetId=${spreadsheetId}`, {
      headers: { Authorization: `Bearer ${mentionedToken}` },
    })
    expect(afterMarkReadRes.status).toBe(200)
    const afterMarkReadJson = await afterMarkReadRes.json()
    expect(afterMarkReadJson.data.unresolvedMentionCount).toBe(3)
    expect(afterMarkReadJson.data.unreadMentionCount).toBe(0)
    expect(afterMarkReadJson.data.unreadRecordCount).toBe(0)

    await create({ spreadsheetId, rowId: row2, content: 'fresh', mentions: ['target_user'] })

    const afterFreshMentionRes = await fetch(`${baseUrl}/api/comments/mention-summary?spreadsheetId=${spreadsheetId}`, {
      headers: { Authorization: `Bearer ${mentionedToken}` },
    })
    expect(afterFreshMentionRes.status).toBe(200)
    const afterFreshMentionJson = await afterFreshMentionRes.json()
    expect(afterFreshMentionJson.data.unresolvedMentionCount).toBe(4)
    expect(afterFreshMentionJson.data.unreadMentionCount).toBe(1)
    expect(afterFreshMentionJson.data.items).toEqual([
      { rowId: row1, mentionedCount: 2, unreadCount: 0, mentionedFieldIds: ['fld_a', 'fld_b'] },
      { rowId: row2, mentionedCount: 2, unreadCount: 1, mentionedFieldIds: [] },
    ])
  })

  it('returns unresolved comment presence summaries per row and field', async () => {
    if (!baseUrl) return

    const ts = Date.now()
    const spreadsheetId = `sheet_presence_${ts}`.slice(0, 50)
    const rowOne = `rec_presence_1_${ts}`.slice(0, 50)
    const rowTwo = `rec_presence_2_${ts}`.slice(0, 50)
    const token = (await (await fetch(`${baseUrl}/api/auth/dev-token?userId=user_4`)).json()).token as string

    async function createComment(body: Record<string, unknown>) {
      const response = await fetch(`${baseUrl}/api/comments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(201)
      const payload = await response.json()
      createdCommentIds.push(payload.data.comment.id)
      return payload.data.comment as { id: string }
    }

    const root = await createComment({
      spreadsheetId,
      rowId: rowOne,
      fieldId: 'fld_title',
      content: 'Field thread',
    })
    await createComment({
      spreadsheetId,
      rowId: rowOne,
      parentId: root.id,
      content: 'Field reply',
    })
    const resolvedComment = await createComment({
      spreadsheetId,
      rowId: rowTwo,
      content: 'Record comment',
    })

    const resolveRes = await fetch(`${baseUrl}/api/comments/${resolvedComment.id}/resolve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(resolveRes.status).toBe(204)

    const summaryRes = await fetch(`${baseUrl}/api/comments/summary?spreadsheetId=${spreadsheetId}&rowIds=${rowOne},${rowTwo}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(summaryRes.status).toBe(200)
    const summaryJson = await summaryRes.json()
    expect(summaryJson.data.items).toEqual([
      {
        spreadsheetId,
        rowId: rowOne,
        unresolvedCount: 2,
        fieldCounts: { fld_title: 2 },
        mentionedCount: 0,
        mentionedFieldCounts: {},
      },
    ])
    expect(summaryJson.data.total).toBe(1)
  })

  it('broadcasts global inbox activity for comment create and resolve', async () => {
    if (!baseUrl) return

    const ts = Date.now()
    const baseId = `base_comment_ws_${ts}`.slice(0, 50)
    const spreadsheetId = `sheet_comment_ws_${ts}`.slice(0, 50)
    const rowId = `rec_comment_ws_${ts}`.slice(0, 50)
    const pool = poolManager.get()

    await pool.query('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [baseId, 'Comment WS Base'])
    createdBaseIds.push(baseId)
    await pool.query('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [
      spreadsheetId,
      baseId,
      'Comment WS Sheet',
    ])
    createdSheetIds.push(spreadsheetId)

    const authorToken = (await (await fetch(`${baseUrl}/api/auth/dev-token?userId=user_ws_author`)).json()).token as string
    const socket = ioClient(`${baseUrl}?userId=user_ws_target`, { transports: ['websocket'] })

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('socket connect timeout')), 3000)
      socket.on('connect', () => { clearTimeout(t); resolve() })
    })

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('inbox join timeout')), 3000)
      socket.on('joined-comment-inbox', () => {
        clearTimeout(t)
        resolve()
      })
      socket.emit('join-comment-inbox')
    })

    const createdActivity = new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('create activity timeout')), 3000)
      socket.on('comment:activity', (payload: any) => {
        if (payload?.kind !== 'created') return
        clearTimeout(t)
        resolve(payload)
      })
    })

    const createRes = await fetch(`${baseUrl}/api/comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authorToken}`,
      },
      body: JSON.stringify({
        spreadsheetId,
        rowId,
        fieldId: 'fld_note',
        content: 'Realtime inbox activity',
      }),
    })
    expect(createRes.status).toBe(201)
    const createJson = await createRes.json()
    const createdComment = createJson.data.comment as { id: string }
    createdCommentIds.push(createdComment.id)

    await expect(createdActivity).resolves.toEqual({
      kind: 'created',
      spreadsheetId,
      rowId,
      fieldId: 'fld_note',
      commentId: createdComment.id,
      authorId: 'user_ws_author',
    })

    const updatedActivity = new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('update activity timeout')), 3000)
      socket.on('comment:activity', (payload: any) => {
        if (payload?.kind !== 'updated' || payload?.commentId !== createdComment.id) return
        clearTimeout(t)
        resolve(payload)
      })
    })

    const updateRes = await fetch(`${baseUrl}/api/comments/${createdComment.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authorToken}`,
      },
      body: JSON.stringify({
        content: 'Realtime inbox activity edited',
      }),
    })
    expect(updateRes.status).toBe(200)

    await expect(updatedActivity).resolves.toEqual({
      kind: 'updated',
      spreadsheetId,
      rowId,
      fieldId: 'fld_note',
      commentId: createdComment.id,
      authorId: 'user_ws_author',
    })

    const resolvedActivity = new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('resolve activity timeout')), 3000)
      socket.on('comment:activity', (payload: any) => {
        if (payload?.kind !== 'resolved' || payload?.commentId !== createdComment.id) return
        clearTimeout(t)
        resolve(payload)
      })
    })

    const resolveRes = await fetch(`${baseUrl}/api/comments/${createdComment.id}/resolve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authorToken}` },
    })
    expect(resolveRes.status).toBe(204)

    await expect(resolvedActivity).resolves.toEqual({
      kind: 'resolved',
      spreadsheetId,
      rowId,
      fieldId: 'fld_note',
      commentId: createdComment.id,
    })

    const leafRes = await fetch(`${baseUrl}/api/comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authorToken}`,
      },
      body: JSON.stringify({
        spreadsheetId,
        rowId,
        content: 'Delete me',
      }),
    })
    expect(leafRes.status).toBe(201)
    const leafJson = await leafRes.json()
    const leafComment = leafJson.data.comment as { id: string }
    createdCommentIds.push(leafComment.id)

    const deletedActivity = new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('delete activity timeout')), 3000)
      socket.on('comment:activity', (payload: any) => {
        if (payload?.kind !== 'deleted' || payload?.commentId !== leafComment.id) return
        clearTimeout(t)
        resolve(payload)
      })
    })

    const deleteRes = await fetch(`${baseUrl}/api/comments/${leafComment.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authorToken}` },
    })
    expect(deleteRes.status).toBe(204)

    await expect(deletedActivity).resolves.toEqual({
      kind: 'deleted',
      spreadsheetId,
      rowId,
      commentId: leafComment.id,
      authorId: 'user_ws_author',
    })

    socket.close()
  })
})
