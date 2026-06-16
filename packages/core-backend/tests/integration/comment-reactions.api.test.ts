import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'

// B6 emoji-reaction keystone — split into its OWN file (not a `-t` name filter on
// comments.api.test.ts) so the CI gate is robust: a whole-file wire fails loud if
// the file is empty/renamed, whereas a `vitest -t "reaction"` that matches zero
// tests exits 0 (green) and would silently reintroduce the invisible-debt this
// suite exists to kill. comments.api.test.ts itself stays CI-excluded for now
// because 8 of its OTHER tests have a pre-existing real-wire failure
// (CommentService.mapRowToComment drops containerId/targetId/targetFieldId),
// tracked separately under its own opt-in fix.

async function canListenOnEphemeralPort(): Promise<boolean> {
  return await new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
  })
}

// The CREATE TABLE IF NOT EXISTS string columns below mirror the REAL migration
// shapes so a fresh DB (local run before db:migrate, or a brand-new CI database)
// tests the same column types the app runs against — text + timestamptz for
// users / meta_bases / meta_sheets / meta_comment_reads / meta_comment_reactions
// (their migrations are kysely text/timestamptz). The lone exception is
// meta_comments, whose production shape is varchar(50) + plain timestamp because
// its earliest-ordered `formalize` migration wins the IF NOT EXISTS race
// (zzzz20260318 < zzzz20260326), so that block stays varchar(50).
async function ensureCommentsTables() {
  const pool = poolManager.get()
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id text PRIMARY KEY,
      email text NOT NULL,
      name text,
      password_hash text NOT NULL DEFAULT '',
      role text NOT NULL DEFAULT 'editor',
      permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
      avatar_url text,
      is_active boolean NOT NULL DEFAULT true,
      is_admin boolean NOT NULL DEFAULT false,
      last_login_at timestamptz,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS meta_bases (
      id text PRIMARY KEY,
      name text NOT NULL,
      icon text,
      color text,
      owner_id text,
      workspace_id text,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      deleted_at timestamptz
    );
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS meta_sheets (
      id text PRIMARY KEY,
      base_id text,
      name text NOT NULL,
      description text,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      deleted_at timestamptz
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
      comment_id text NOT NULL,
      user_id text NOT NULL,
      read_at timestamptz DEFAULT now(),
      created_at timestamptz DEFAULT now(),
      PRIMARY KEY (comment_id, user_id)
    );
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS meta_comment_reactions (
      comment_id text NOT NULL,
      user_id text NOT NULL,
      emoji text NOT NULL,
      created_at timestamptz DEFAULT now(),
      PRIMARY KEY (comment_id, user_id, emoji)
    );
  `)
  await pool.query('CREATE INDEX IF NOT EXISTS idx_comments_sheet ON meta_comments(spreadsheet_id);')
  await pool.query('CREATE INDEX IF NOT EXISTS idx_comments_row ON meta_comments(row_id);')
  await pool.query('CREATE INDEX IF NOT EXISTS idx_comment_reactions_comment ON meta_comment_reactions(comment_id);')
}

describe('Comment Reactions API (B6, real wire)', () => {
  let server: MetaSheetServer
  let baseUrl: string
  const createdCommentIds: string[] = []
  const createdSheetIds: string[] = []
  const createdBaseIds: string[] = []

  beforeAll(async () => {
    process.env.RBAC_BYPASS = 'true'
    // FAIL-LOUD (skip-when-unreachable trap #1435/#1436): a missing PG / unbindable
    // port must turn this keystone RED, not skipped-green. There is intentionally no
    // `if (!baseUrl) return` escape hatch anywhere below — an unreachable backend
    // throws here in beforeAll, failing the whole file.
    const canListen = await canListenOnEphemeralPort()
    expect(canListen).toBe(true)

    await ensureCommentsTables()

    server = new MetaSheetServer({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [],
    })
    await server.start()
    const address = server.getAddress()
    expect(address?.port).toBeTruthy()
    baseUrl = `http://127.0.0.1:${address!.port}`
    expect(baseUrl).toBeTruthy()
  })

  afterAll(async () => {
    delete process.env.RBAC_BYPASS
    try {
      const pool = poolManager.get()
      if (createdCommentIds.length > 0) {
        await pool.query('DELETE FROM meta_comment_reactions WHERE comment_id = ANY($1::text[])', [createdCommentIds])
        await pool.query('DELETE FROM meta_comment_reads WHERE comment_id = ANY($1::text[])', [createdCommentIds])
        await pool.query('DELETE FROM meta_comments WHERE id = ANY($1::text[])', [createdCommentIds])
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

  // B6: emoji reactions through the REAL HTTP wire. The remove path is the
  // anti-drift keystone — a multi-codepoint emoji (❤️ = ❤ + U+FE0F) must round
  // trip add → aggregate → delete and actually remove the row, which an
  // in-process service call could false-green (design-lock §3.3).
  it('adds, aggregates, idempotently re-adds, and removes comment reactions (real wire, multi-codepoint emoji)', async () => {
    // FAIL-LOUD: this keystone must not skip-green if the backend never came up.
    expect(baseUrl).toBeTruthy()

    const ts = Date.now()
    const baseId = `base_react_${ts}`.slice(0, 50)
    const spreadsheetId = `sheet_react_${ts}`.slice(0, 50)
    const rowId = `rec_react_${ts}`.slice(0, 50)
    const pool = poolManager.get()

    await pool.query('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [baseId, 'React Base'])
    createdBaseIds.push(baseId)
    await pool.query('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [spreadsheetId, baseId, 'React Sheet'])
    createdSheetIds.push(spreadsheetId)

    const userA = (await (await fetch(`${baseUrl}/api/auth/dev-token?userId=user_react_a`)).json()).token as string
    const userB = (await (await fetch(`${baseUrl}/api/auth/dev-token?userId=user_react_b`)).json()).token as string

    // Create a comment to react to.
    const createRes = await fetch(`${baseUrl}/api/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userA}` },
      body: JSON.stringify({ spreadsheetId, rowId, content: 'react to me' }),
    })
    expect(createRes.status).toBe(201)
    const comment = (await createRes.json()).data.comment
    createdCommentIds.push(comment.id)

    const EMOJI = '❤️' // U+2764 U+FE0F — the multi-codepoint case
    const reactUrl = `${baseUrl}/api/comments/${comment.id}/reactions`
    const listUrl = `${baseUrl}/api/comments?spreadsheetId=${spreadsheetId}`

    // userA adds ❤️
    const addA = await fetch(reactUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userA}` },
      body: JSON.stringify({ emoji: EMOJI }),
    })
    expect(addA.status).toBe(201)

    // Idempotent: userA re-adds the same emoji → still one row for A.
    const addAgain = await fetch(reactUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userA}` },
      body: JSON.stringify({ emoji: EMOJI }),
    })
    expect(addAgain.status).toBe(201)

    // userB also adds ❤️ → count becomes 2.
    const addB = await fetch(reactUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userB}` },
      body: JSON.stringify({ emoji: EMOJI }),
    })
    expect(addB.status).toBe(201)

    // List as userA → aggregate count 2, reactedByMe true.
    const listA = await (await fetch(listUrl, { headers: { Authorization: `Bearer ${userA}` } })).json()
    const itemA = listA.data.items.find((c: { id: string }) => c.id === comment.id)
    expect(itemA.reactions).toEqual([{ emoji: EMOJI, count: 2, reactedByMe: true }])

    // List as a non-reactor (userB removed below; here a third viewer) → reactedByMe reflects viewer.
    const listB = await (await fetch(listUrl, { headers: { Authorization: `Bearer ${userB}` } })).json()
    const itemB = listB.data.items.find((c: { id: string }) => c.id === comment.id)
    expect(itemB.reactions).toEqual([{ emoji: EMOJI, count: 2, reactedByMe: true }])

    // Invalid emoji → 400 (allowlist).
    const bad = await fetch(reactUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userA}` },
      body: JSON.stringify({ emoji: '💩' }),
    })
    expect(bad.status).toBe(400)

    // KEYSTONE: userA removes ❤️ through the real DELETE wire → row actually gone.
    const del = await fetch(reactUrl, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userA}` },
      body: JSON.stringify({ emoji: EMOJI }),
    })
    expect(del.status).toBe(204)

    // Confirm in the DB the row is gone for A (count drops to 1, B remains).
    const remaining = await pool.query(
      'SELECT user_id FROM meta_comment_reactions WHERE comment_id = $1 AND emoji = $2 ORDER BY user_id',
      [comment.id, EMOJI.normalize('NFC')],
    )
    expect(remaining.rows.map((r: { user_id: string }) => r.user_id)).toEqual(['user_react_b'])

    // And the aggregate now shows count 1, reactedByMe false for A.
    const listAfter = await (await fetch(listUrl, { headers: { Authorization: `Bearer ${userA}` } })).json()
    const itemAfter = listAfter.data.items.find((c: { id: string }) => c.id === comment.id)
    expect(itemAfter.reactions).toEqual([{ emoji: EMOJI, count: 1, reactedByMe: false }])
  })

  // B6 permission-integrity negatives (design-lock §3.3 promised-then-dropped
  // reader-deny + cross-user self-scope). Real HTTP wire, real PG.
  it('scopes reaction removal to self, denies write to a reader-only token, and cascades on comment delete', async () => {
    // FAIL-LOUD: never skip-green when the backend is down.
    expect(baseUrl).toBeTruthy()

    const ts = Date.now()
    const baseId = `base_react_neg_${ts}`.slice(0, 50)
    const spreadsheetId = `sheet_react_neg_${ts}`.slice(0, 50)
    const rowId = `rec_react_neg_${ts}`.slice(0, 50)
    const pool = poolManager.get()

    await pool.query('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [baseId, 'React Neg Base'])
    createdBaseIds.push(baseId)
    await pool.query('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [spreadsheetId, baseId, 'React Neg Sheet'])
    createdSheetIds.push(spreadsheetId)

    // Default dev-token = roles=admin, perms=*:* → passes comments:write.
    const userA = (await (await fetch(`${baseUrl}/api/auth/dev-token?userId=user_neg_a`)).json()).token as string
    const userB = (await (await fetch(`${baseUrl}/api/auth/dev-token?userId=user_neg_b`)).json()).token as string
    // Reader-only token: an explicit non-admin role + a perms set WITHOUT comments:write.
    // The route is gated by rbacGuard('comments','write'); with RBAC_TOKEN_TRUST the
    // trusted-token claims govern, so this token must be rejected at the guard → 403.
    const reader = (
      await (await fetch(`${baseUrl}/api/auth/dev-token?userId=user_neg_reader&roles=viewer&perms=comments:read`)).json()
    ).token as string

    const createRes = await fetch(`${baseUrl}/api/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userA}` },
      body: JSON.stringify({ spreadsheetId, rowId, content: 'react integrity' }),
    })
    expect(createRes.status).toBe(201)
    const comment = (await createRes.json()).data.comment
    createdCommentIds.push(comment.id)

    const EMOJI = '👍'
    const reactUrl = `${baseUrl}/api/comments/${comment.id}/reactions`
    const listUrl = `${baseUrl}/api/comments?spreadsheetId=${spreadsheetId}`

    // userA and userB each add 👍 → count 2.
    for (const tok of [userA, userB]) {
      const add = await fetch(reactUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ emoji: EMOJI }),
      })
      expect(add.status).toBe(201)
    }

    // NEGATIVE (a): userA's DELETE is self-scoped — it removes A's row only and
    // CANNOT remove userB's reaction. The route exposes no target-user field, so
    // there is no way for A to address B's row; we prove the row survives.
    const delByA = await fetch(reactUrl, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userA}` },
      body: JSON.stringify({ emoji: EMOJI }),
    })
    expect(delByA.status).toBe(204)

    const afterSelfDelete = await pool.query(
      'SELECT user_id FROM meta_comment_reactions WHERE comment_id = $1 AND emoji = $2 ORDER BY user_id',
      [comment.id, EMOJI.normalize('NFC')],
    )
    // userB's reaction is untouched by A's delete; only A's own row is gone.
    expect(afterSelfDelete.rows.map((r: { user_id: string }) => r.user_id)).toEqual(['user_neg_b'])

    // And from B's viewpoint the aggregate still shows B's own reaction.
    const listAsB = await (await fetch(listUrl, { headers: { Authorization: `Bearer ${userB}` } })).json()
    const itemAsB = listAsB.data.items.find((c: { id: string }) => c.id === comment.id)
    expect(itemAsB.reactions).toEqual([{ emoji: EMOJI, count: 1, reactedByMe: true }])

    // NEGATIVE (b): a reader-only token (no comments:write) is denied at the guard.
    const readerAdd = await fetch(reactUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${reader}` },
      body: JSON.stringify({ emoji: EMOJI }),
    })
    expect(readerAdd.status).toBe(403)

    const readerDelete = await fetch(reactUrl, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${reader}` },
      body: JSON.stringify({ emoji: EMOJI }),
    })
    expect(readerDelete.status).toBe(403)

    // The reader's denied write left the data untouched (B's row still the only one).
    const afterReader = await pool.query(
      'SELECT user_id FROM meta_comment_reactions WHERE comment_id = $1 AND emoji = $2 ORDER BY user_id',
      [comment.id, EMOJI.normalize('NFC')],
    )
    expect(afterReader.rows.map((r: { user_id: string }) => r.user_id)).toEqual(['user_neg_b'])

    // CASCADE: deleting the (leaf) comment removes its surviving reactions through
    // the app-level cascade in CommentService.deleteComment (no DB FK in this
    // sub-domain — design-lock B6-a). userA authored the comment, so A may delete it.
    const deleteComment = await fetch(`${baseUrl}/api/comments/${comment.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${userA}` },
    })
    expect(deleteComment.status).toBe(204)
    const afterCommentDelete = await pool.query(
      'SELECT user_id FROM meta_comment_reactions WHERE comment_id = $1',
      [comment.id],
    )
    expect(afterCommentDelete.rows).toHaveLength(0)
  })
})
