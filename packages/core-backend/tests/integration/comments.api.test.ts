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
  await pool.query('DROP TABLE IF EXISTS meta_comments')
  await pool.query(`
    CREATE TABLE meta_comments (
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
        content: 'Hello @[user_2](u2)',
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
    expect(summaryJson.ok).toBe(true)
    expect(summaryJson.data?.items).toEqual([
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

  it('creates field comments and one-level replies with inherited field scope', async () => {
    if (!baseUrl) return

    const ts = Date.now()
    const spreadsheetId = `sheet_field_comments_${ts}`.slice(0, 50)
    const rowId = `rec_field_comments_${ts}`.slice(0, 50)
    const fieldId = 'fld_title'

    const tokenRes = await fetch(`${baseUrl}/api/auth/dev-token?userId=user_2`)
    expect(tokenRes.status).toBe(200)
    const token = (await tokenRes.json()).token as string

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
    const rootJson = await rootRes.json()
    const rootComment = rootJson.data?.comment
    createdCommentIds.push(rootComment.id)
    expect(rootComment?.fieldId).toBe(fieldId)
    expect(rootComment?.parentId).toBeUndefined()

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
    const replyJson = await replyRes.json()
    const replyComment = replyJson.data?.comment
    createdCommentIds.push(replyComment.id)
    expect(replyComment?.parentId).toBe(rootComment.id)
    expect(replyComment?.fieldId).toBe(fieldId)

    const listRes = await fetch(`${baseUrl}/api/comments?spreadsheetId=${spreadsheetId}&rowId=${rowId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(listRes.status).toBe(200)
    const listJson = await listRes.json()
    const items = listJson.data?.items ?? []
    expect(items.some((item: any) => item.id === rootComment.id && item.fieldId === fieldId)).toBe(true)
    expect(items.some((item: any) => item.id === replyComment.id && item.parentId === rootComment.id && item.fieldId === fieldId)).toBe(true)
  })

  it('rejects invalid parent comment scopes and reply-to-reply chains', async () => {
    if (!baseUrl) return

    const ts = Date.now()
    const spreadsheetId = `sheet_invalid_parent_${ts}`.slice(0, 50)
    const rowId = `rec_invalid_parent_${ts}`.slice(0, 50)
    const otherRowId = `rec_invalid_parent_other_${ts}`.slice(0, 50)

    const tokenRes = await fetch(`${baseUrl}/api/auth/dev-token?userId=user_3`)
    expect(tokenRes.status).toBe(200)
    const token = (await tokenRes.json()).token as string

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
    const rootJson = await rootRes.json()
    const rootComment = rootJson.data?.comment
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
    const replyJson = await replyRes.json()
    const replyComment = replyJson.data?.comment
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
    expect(nestedReplyJson.error?.code).toBe('VALIDATION_ERROR')
    expect(nestedReplyJson.error?.message).toContain('Replying to replies is not supported')

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
    expect(mismatchedRowJson.error?.code).toBe('VALIDATION_ERROR')
    expect(mismatchedRowJson.error?.message).toContain('same record thread')
  })

  it('returns current-user mention-summary with correct aggregation and sort order', async () => {
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

    // row1: 2 mentions of target_user across 2 fields
    await create({ spreadsheetId, rowId: row1, fieldId: 'fld_a', content: 'hey @[target_user](tu)' })
    await create({ spreadsheetId, rowId: row1, fieldId: 'fld_b', content: 'also @[target_user](tu)' })
    // row2: 1 mention of target_user, no field
    await create({ spreadsheetId, rowId: row2, content: 'cc @[target_user](tu)' })
    // row3: mention of different user — should NOT appear
    await create({ spreadsheetId, rowId: row3, content: 'hey @[other_user](ou)' })
    // row1: resolved mention — should NOT count
    const resolved = await create({ spreadsheetId, rowId: row1, content: '@[target_user](tu) done' })
    await fetch(`${baseUrl}/api/comments/${resolved.id}/resolve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authorToken}` },
    })

    // Fetch mention-summary as the mentioned user
    const res = await fetch(
      `${baseUrl}/api/comments/mention-summary?spreadsheetId=${spreadsheetId}`,
      { headers: { Authorization: `Bearer ${mentionedToken}` } },
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)

    const data = json.data
    // Only unresolved mentions of target_user count
    expect(data.unresolvedMentionCount).toBe(3)
    expect(data.mentionedRecordCount).toBe(2)

    // Sorted: row1 (count=2) before row2 (count=1)
    expect(data.items).toEqual([
      { rowId: row1, mentionedCount: 2, unreadCount: 2, mentionedFieldIds: ['fld_a', 'fld_b'] },
      { rowId: row2, mentionedCount: 1, unreadCount: 1, mentionedFieldIds: [] },
    ])
  })

  it('returns unresolved comment presence summaries per row and field', async () => {
    if (!baseUrl) return

    const ts = Date.now()
    const spreadsheetId = `sheet_presence_${ts}`.slice(0, 50)
    const rowOne = `rec_presence_1_${ts}`.slice(0, 50)
    const rowTwo = `rec_presence_2_${ts}`.slice(0, 50)

    const tokenRes = await fetch(`${baseUrl}/api/auth/dev-token?userId=user_4`)
    expect(tokenRes.status).toBe(200)
    const token = (await tokenRes.json()).token as string

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
    expect(summaryJson.ok).toBe(true)
    expect(summaryJson.data?.items).toEqual([
      {
        spreadsheetId,
        rowId: rowOne,
        unresolvedCount: 2,
        fieldCounts: { fld_title: 2 },
        mentionedCount: 0,
        mentionedFieldCounts: {},
      },
    ])
    expect(summaryJson.data?.total).toBe(1)
  })
})
