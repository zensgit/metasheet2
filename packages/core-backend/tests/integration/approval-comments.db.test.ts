import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import net from 'net'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'
import { canReadApprovalInstance } from '../../src/services/approval-instance-readability'
import {
  resetApprovalCommentMentionDeliveryForTests,
  resetApprovalCommentNotifyCheckerForTests,
  setApprovalCommentMentionDelivery,
  setApprovalCommentNotifyChecker,
  notifyApprovalCommentMentions,
} from '../../src/services/approval-comment-service'

/**
 * Lock-10 (S2) `approval_comments` — real-DB acceptance for the FULL gate battery (C-1..C-17):
 * list/create/edit/delete/mention-candidates authorization (S1's `canReadApprovalInstance` reused,
 * never re-derived — OD-S1-14), D3 write widening (participant union, not acting-assignee-only),
 * D2(b1) mutable storage + tombstone, the pointer-row dual-write invariant
 * (`approval_records.comment IS NULL` on the pointer row), one-level threading + cross-instance
 * `parentId` rejection, `plm:` refusal + spy-zero on `canReadApprovalInstance`, the `/history`
 * HISTORY-TIMELINE arm (i) exclusion (both the pointer-row negative AND the legacy-act-path-row
 * positive — the named §5.1 anti-pattern gate), the reply-refusal NOT-copied gate (C-15),
 * check-ordering (C-16), the G-S1-9 notify seam, and a mechanical FAIL-0 enumeration (C-17).
 *
 * `vi.mock` below wraps `canReadApprovalInstance` with a call-counting spy that ALWAYS calls
 * through to the real implementation (same pattern as the S1 consumers suite) — every assertion
 * here observes REAL admission decisions; the wrapper exists solely so C-6 can prove a `plm:` id
 * never reaches it.
 */
const readabilitySpyState = { calls: 0 }
vi.mock('../../src/services/approval-instance-readability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/approval-instance-readability')>()
  return {
    ...actual,
    canReadApprovalInstance: async (...args: Parameters<typeof actual.canReadApprovalInstance>) => {
      readabilitySpyState.calls += 1
      return actual.canReadApprovalInstance(...args)
    },
  }
})

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()

const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

async function canListenOnEphemeralPort(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function jsonRequest(
  baseUrl: string,
  path: string,
  token: string,
  options: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
}

async function authToken(baseUrl: string, userId: string, roles = 'admin', perms = '*:*'): Promise<string> {
  const response = await fetch(
    `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=${encodeURIComponent(roles)}&perms=${encodeURIComponent(perms)}`,
  )
  expect(response.status).toBe(200)
  return ((await response.json()) as { token: string }).token
}

// =================================================================================================
// C-17(a) — FAIL-0 mechanical enumeration: every route in approval-comments.ts appears with the
// EXACT middleware chain `authenticate, rbacGuard('approvals', 'read')`. Static source scan, runs
// regardless of DATABASE_URL (no DB needed) so it can never skip-green.
// =================================================================================================
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
function readRepoFile(relPath: string): string {
  return readFileSync(join(repoRoot, relPath), 'utf8')
}

describe('C-17(a): mechanical route/guard-chain enumeration (static, no DB required)', () => {
  const routesSrc = readRepoFile('packages/core-backend/src/routes/approval-comments.ts')
  const routeCallRegex = /r\.(get|post|patch|delete)\(\s*'([^']+)',\s*authenticate,\s*rbacGuard\('approvals',\s*'read'\)/g

  it('positive control: the source was actually read', () => {
    expect(routesSrc.length).toBeGreaterThan(500)
  })

  it('exactly five routes are registered, each with authenticate + rbacGuard(approvals,read)', () => {
    const matches = [...routesSrc.matchAll(routeCallRegex)]
    const routeKeys = matches.map((m) => `${m[1].toUpperCase()} ${m[2]}`).sort()
    expect(routeKeys).toEqual([
      'DELETE /api/approvals/:id/comments/:commentId',
      'GET /api/approvals/:id/comments',
      'GET /api/approvals/:id/comments/mention-candidates',
      'PATCH /api/approvals/:id/comments/:commentId',
      'POST /api/approvals/:id/comments',
    ])
  })

  it('mention-candidates is registered BEFORE the :commentId patterns (route-ordering caution)', () => {
    const mentionIdx = routesSrc.indexOf("'/api/approvals/:id/comments/mention-candidates'")
    const commentIdIdx = routesSrc.indexOf("'/api/approvals/:id/comments/:commentId'")
    expect(mentionIdx).toBeGreaterThan(-1)
    expect(commentIdIdx).toBeGreaterThan(-1)
    expect(mentionIdx).toBeLessThan(commentIdIdx)
  })

  it('no route on this file uses approvals:write (D3/OD-S1-14 — write scope stays approvals:read)', () => {
    expect(routesSrc).not.toContain("rbacGuard('approvals', 'write')")
    expect(routesSrc).not.toContain("rbacGuard('approvals:write'")
  })

  // Route -> seam wiring: C-11's assertions call `notifyApprovalCommentMentions` DIRECTLY (a
  // no-DB, no-server unit probe — see approval-comment-notify-seam.test.ts), so nothing in this
  // real-DB file exercises the actual POST/PATCH handlers' call to that function. Deleting the
  // call from either handler would red nothing here. This is the cheapest race-free static close:
  // both handlers must literally invoke it.
  it('POST and PATCH handlers both call notifyApprovalCommentMentions (static link to the G-S1-9 seam)', () => {
    const postHandlerSrc = routesSrc.slice(routesSrc.indexOf("r.post('/api/approvals/:id/comments',"), routesSrc.indexOf("r.patch("))
    const patchHandlerSrc = routesSrc.slice(routesSrc.indexOf("r.patch("), routesSrc.indexOf("r.delete("))
    expect(postHandlerSrc).toContain('notifyApprovalCommentMentions(')
    expect(patchHandlerSrc).toContain('notifyApprovalCommentMentions(')
  })
})

describe('C-17(b): every exported service function is exercised by >=1 real-DB gate (list-derived, not hand-picked)', () => {
  const serviceSrc = readRepoFile('packages/core-backend/src/services/approval-comment-service.ts')
  const exportedFunctionNames = [...serviceSrc.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1])

  it('positive control: at least eight exported functions were found in the service source', () => {
    expect(exportedFunctionNames.length).toBeGreaterThanOrEqual(8)
  })

  // Explicit function -> gate-id map. This is a DECLARATION, not a discovery — the test below
  // asserts its KEY SET equals the mechanically-extracted export list, so a future export added
  // to the service without a matching entry here fails immediately (never silently uncovered).
  const SERVICE_FUNCTION_COVERAGE: Record<string, string> = {
    createApprovalComment: 'C-2/C-3/C-8/C-9/R7 (POST route, real-DB)',
    listApprovalComments: 'C-1/C-13 (GET route, real-DB)',
    editApprovalComment: 'C-7/C-16/R2 (PATCH route, real-DB)',
    deleteApprovalComment: 'C-4/C-15 (DELETE route, real-DB)',
    listMentionCandidates: 'C-12 (mention-candidates route, real-DB)',
    notifyApprovalCommentMentions: 'C-11 (direct call, no-DB unit probe: approval-comment-notify-seam.test.ts)',
    setApprovalCommentNotifyChecker: 'C-11 (direct call)',
    resetApprovalCommentNotifyCheckerForTests: 'C-11 (afterEach)',
    setApprovalCommentMentionDelivery: 'C-11 (direct call)',
    resetApprovalCommentMentionDeliveryForTests: 'C-11 (afterEach)',
  }

  it('the declared coverage map\'s key set equals the mechanically-extracted export list (no drift either direction)', () => {
    expect(Object.keys(SERVICE_FUNCTION_COVERAGE).sort()).toEqual([...exportedFunctionNames].sort())
  })

  it.each(exportedFunctionNames)('exported function %s has a declared gate mapping', (name) => {
    expect(SERVICE_FUNCTION_COVERAGE[name]).toBeTruthy()
  })
})

describe('C-17(c): every service error code appears in this suite\'s own assertions (mechanical self-grep)', () => {
  const serviceSrc = readRepoFile('packages/core-backend/src/services/approval-comment-service.ts')
  const testSrc = readRepoFile('packages/core-backend/tests/integration/approval-comments.db.test.ts')
  const codes = [...serviceSrc.matchAll(/readonly code = '([A-Z_]+)'/g)].map((m) => m[1])

  it('positive control: at least four error codes were found in the service source', () => {
    expect(codes.length).toBeGreaterThanOrEqual(4)
  })

  it.each(codes)('error code %s is asserted somewhere in this suite', (code) => {
    expect(testSrc).toContain(code)
  })
})

describeIfDatabase('Lock-10 (S2) approval_comments — full gate battery, real DB', () => {
  let MetaSheetServer: typeof import('../../src/index').MetaSheetServer
  let server: InstanceType<typeof MetaSheetServer> | undefined
  let baseUrl = ''
  const pool = () => poolManager.get()
  const createdInstanceIds: string[] = []
  const createdUserIds: string[] = []
  const grantedUserIds = new Set<string>()

  beforeAll(async () => {
    ;({ MetaSheetServer } = await import('../../src/index'))
    expect(await canListenOnEphemeralPort()).toBe(true)
    await ensureApprovalSchemaReady()
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    const address = server.getAddress()
    const port = address && typeof address === 'object' ? address.port : undefined
    expect(port).toBeTruthy()
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterEach(() => {
    readabilitySpyState.calls = 0
    delete process.env.APPROVAL_S1_ORG_PIN_ENABLED
  })

  afterAll(async () => {
    try {
      if (createdInstanceIds.length > 0) {
        await pool().query(`DELETE FROM approval_comments WHERE instance_id = ANY($1::text[])`, [createdInstanceIds])
        await pool().query(`DELETE FROM approval_records WHERE instance_id = ANY($1::text[])`, [createdInstanceIds])
        await pool().query(`DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])`, [createdInstanceIds])
        await pool().query(`DELETE FROM approval_instances WHERE id = ANY($1::text[])`, [createdInstanceIds])
      }
      if (createdUserIds.length > 0) {
        await pool().query(`DELETE FROM users WHERE id = ANY($1::text[])`, [createdUserIds])
        await pool().query(`DELETE FROM user_orgs WHERE user_id = ANY($1::text[])`, [createdUserIds])
      }
      if (grantedUserIds.size > 0) {
        await pool().query('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[...grantedUserIds]])
      }
    } finally {
      await server?.stop()
    }
  })

  function freshId(prefix: string): string {
    return `${prefix}-${TS}-${Math.random().toString(36).slice(2, 8)}`
  }

  async function seedInstance(requesterId: string): Promise<string> {
    const id = freshId('s2-inst')
    await pool().query(
      `INSERT INTO approval_instances (id, status, requester_snapshot) VALUES ($1, 'pending', $2::jsonb)`,
      [id, JSON.stringify({ id: requesterId })],
    )
    createdInstanceIds.push(id)
    return id
  }

  async function seedAssignment(instanceId: string, assigneeId: string, type: 'user' | 'role' | 'source_queue' = 'user'): Promise<void> {
    await pool().query(
      `INSERT INTO approval_assignments (instance_id, assignment_type, assignee_id, is_active) VALUES ($1, $2, $3, TRUE)`,
      [instanceId, type, assigneeId],
    )
  }

  async function seedRecord(instanceId: string, action: string, actorId: string, metadata: Record<string, unknown> = {}): Promise<void> {
    await pool().query(
      `INSERT INTO approval_records (instance_id, action, actor_id, actor_name, to_status, to_version, metadata)
       VALUES ($1, $2, $3, 'Test Actor', 'pending', 1, $4::jsonb)`,
      [instanceId, action, actorId, JSON.stringify(metadata)],
    )
  }

  async function seedUser(userId: string, opts: { admin?: boolean } = {}): Promise<void> {
    createdUserIds.push(userId)
    await pool().query(
      `INSERT INTO users (id, email, name, password_hash, is_active, is_admin) VALUES ($1, $1||'@example.test', $1, 'x', TRUE, $2)`,
      [userId, opts.admin === true],
    )
  }

  async function participantToken(userId: string): Promise<string> {
    return authToken(baseUrl, userId, 'user', 'approvals:read')
  }

  async function commentsGet(instanceId: string, token: string, qs = ''): Promise<Response> {
    return jsonRequest(baseUrl, `/api/approvals/${instanceId}/comments${qs}`, token)
  }
  async function commentsPost(instanceId: string, token: string, body: unknown): Promise<Response> {
    return jsonRequest(baseUrl, `/api/approvals/${instanceId}/comments`, token, { method: 'POST', body })
  }
  async function commentsPatch(instanceId: string, commentId: string, token: string, body: unknown): Promise<Response> {
    return jsonRequest(baseUrl, `/api/approvals/${instanceId}/comments/${commentId}`, token, { method: 'PATCH', body })
  }
  async function commentsDelete(instanceId: string, commentId: string, token: string): Promise<Response> {
    return jsonRequest(baseUrl, `/api/approvals/${instanceId}/comments/${commentId}`, token, { method: 'DELETE' })
  }
  async function mentionCandidates(instanceId: string, token: string, qs = ''): Promise<Response> {
    return jsonRequest(baseUrl, `/api/approvals/${instanceId}/comments/mention-candidates${qs}`, token)
  }

  // -----------------------------------------------------------------------------------------------
  // C-1 / C-2 — list + create authorization
  // -----------------------------------------------------------------------------------------------
  describe('C-1/C-2: list + create authorization (S1 reused)', () => {
    it('C-1 POSITIVE: participant GET 200, seeded comment id present; NEGATIVE: non-participant GET 404, no body substring leak', async () => {
      const requesterId = freshId('c1-requester')
      const instanceId = await seedInstance(requesterId)
      const requesterToken = await participantToken(requesterId)
      const bodyText = `secret-body-${freshId('marker')}`

      const created = await commentsPost(instanceId, requesterToken, { body: bodyText })
      expect(created.status, await created.clone().text()).toBe(201)
      const createdJson = (await created.json()) as { data: { comment: { id: string } } }
      const commentId = createdJson.data.comment.id

      const list = await commentsGet(instanceId, requesterToken)
      expect(list.status).toBe(200)
      const listJson = (await list.json()) as { data: { comments: Array<{ id: string }> } }
      expect(listJson.data.comments.map((c) => c.id)).toContain(commentId)

      const outsiderId = freshId('c1-outsider')
      const outsiderToken = await participantToken(outsiderId)
      const denied = await commentsGet(instanceId, outsiderToken)
      expect(denied.status).toBe(404)
      const deniedText = await denied.clone().text()
      expect(deniedText).not.toContain(bodyText)
      const deniedJson = await denied.json()
      expect(deniedJson).toEqual({ ok: false, error: { code: 'APPROVAL_NOT_FOUND', message: 'Approval instance not found' } })
    })

    it('C-2 POSITIVE: participant POST 201, row present; NEGATIVE: non-participant POST 404, row count unchanged', async () => {
      const requesterId = freshId('c2-requester')
      const instanceId = await seedInstance(requesterId)
      const requesterToken = await participantToken(requesterId)

      const okRes = await commentsPost(instanceId, requesterToken, { body: 'hello' })
      expect(okRes.status).toBe(201)
      const okJson = (await okRes.json()) as { data: { comment: { id: string } } }
      const rowCheck = await pool().query(`SELECT 1 FROM approval_comments WHERE id = $1`, [okJson.data.comment.id])
      expect(rowCheck.rows.length).toBe(1)

      const before = await pool().query(`SELECT COUNT(*)::int AS n FROM approval_comments WHERE instance_id = $1`, [instanceId])
      const outsiderId = freshId('c2-outsider')
      const outsiderToken = await participantToken(outsiderId)
      const deniedRes = await commentsPost(instanceId, outsiderToken, { body: 'should not land' })
      expect(deniedRes.status).toBe(404)
      const after = await pool().query(`SELECT COUNT(*)::int AS n FROM approval_comments WHERE instance_id = $1`, [instanceId])
      expect((after.rows[0] as { n: number }).n).toBe((before.rows[0] as { n: number }).n)
    })
  })

  // -----------------------------------------------------------------------------------------------
  // C-3 — D3 widening: CC target + past actor can write; source_queue seat cannot
  // -----------------------------------------------------------------------------------------------
  describe('C-3: D3 write widening — participant UNION, not acting-assignee-only', () => {
    it('a CC target and a past actor (neither the acting assignee) can both POST 201', async () => {
      const requesterId = freshId('c3-requester')
      const instanceId = await seedInstance(requesterId)

      const ccUserId = freshId('c3-cc')
      await seedRecord(instanceId, 'cc', requesterId, { targetType: 'user', targetId: ccUserId })
      const ccToken = await participantToken(ccUserId)
      const ccRes = await commentsPost(instanceId, ccToken, { body: 'cc target comment' })
      expect(ccRes.status, await ccRes.clone().text()).toBe(201)

      const pastActorId = freshId('c3-pastactor')
      await seedRecord(instanceId, 'approve', pastActorId)
      const actorToken = await participantToken(pastActorId)
      const actorRes = await commentsPost(instanceId, actorToken, { body: 'past actor comment' })
      expect(actorRes.status, await actorRes.clone().text()).toBe(201)
    })

    it('a viewer whose ONLY relation is a source_queue assignment is denied (OD-S1-5 exclusion)', async () => {
      const requesterId = freshId('c3-sq-requester')
      const instanceId = await seedInstance(requesterId)
      const sqUserId = freshId('c3-sq-viewer')
      await seedAssignment(instanceId, sqUserId, 'source_queue')
      const sqToken = await participantToken(sqUserId)
      const res = await commentsPost(instanceId, sqToken, { body: 'should be denied' })
      expect(res.status).toBe(404)
    })
  })

  // -----------------------------------------------------------------------------------------------
  // C-4 / C-5 — tombstone shape + pointer-row dual-write invariant
  // -----------------------------------------------------------------------------------------------
  describe('C-4/C-5: tombstone + pointer-row invariant (D2(b1))', () => {
    it('author DELETE tombstones (never row-deletes); pointer row keeps comment IS NULL; body never leaks into approval_records', async () => {
      const requesterId = freshId('c4-requester')
      const instanceId = await seedInstance(requesterId)
      const requesterToken = await participantToken(requesterId)
      const bodyText = `tombstone-marker-${freshId('x')}`
      // Fix-round (gate P2-1): the comment MUST carry a non-empty `mentions` value going in, or a
      // storage-level assertion that `mentions` is `[]` after delete has zero discriminating power
      // — an empty-to-begin-with column stays `[]` whether or not the tombstone UPDATE's mentions
      // clause runs at all. `mentions: []` on the DEFAULT column is exactly the false-negative the
      // original mutation (deleting `mentions = '[]'::jsonb,`) hid behind.
      const secretMentionId = freshId('c4-secret-mentioned')

      const created = await commentsPost(instanceId, requesterToken, { body: bodyText, mentions: [secretMentionId] })
      const createdJson = (await created.json()) as { data: { comment: { id: string; createdAt: string; authorId: string } } }
      const commentId = createdJson.data.comment.id
      const originalCreatedAt = createdJson.data.comment.createdAt
      const originalAuthorId = createdJson.data.comment.authorId

      // C-5: exactly one new approval_records pointer row, action='comment', metadata.commentId
      // equals the returned id, comment IS NULL — the load-bearing D2(b1) invariant.
      const pointerAfterCreate = await pool().query(
        `SELECT comment, metadata FROM approval_records WHERE instance_id = $1 AND action = 'comment' AND metadata->>'commentId' = $2`,
        [instanceId, commentId],
      )
      expect(pointerAfterCreate.rows.length).toBe(1)
      expect((pointerAfterCreate.rows[0] as { comment: string | null }).comment).toBeNull()

      // Positive control (fix-round, gate P2-1): the mention DID land in storage pre-delete — the
      // post-delete `[]` assertion below only means something because this is non-empty here.
      const mentionsBeforeDelete = await pool().query(`SELECT mentions FROM approval_comments WHERE id = $1`, [commentId])
      expect((mentionsBeforeDelete.rows[0] as { mentions: unknown }).mentions).toEqual([secretMentionId])

      const deleteRes = await commentsDelete(instanceId, commentId, requesterToken)
      expect(deleteRes.status, await deleteRes.clone().text()).toBe(200)
      const deleteJson = (await deleteRes.json()) as { data: { comment: Record<string, unknown> } }
      expect(deleteJson.data.comment.deleted).toBe(true)
      expect(deleteJson.data.comment.body).toBeNull()
      expect(deleteJson.data.comment.mentions).toEqual([])

      const reread = await pool().query(
        `SELECT deleted_at, author_id, created_at, body, mentions FROM approval_comments WHERE id = $1`,
        [commentId],
      )
      const row = reread.rows[0] as { deleted_at: Date | null; author_id: string; created_at: Date; body: string | null; mentions: unknown }
      expect(row.deleted_at).not.toBeNull()
      expect(row.author_id).toBe(originalAuthorId)
      expect(new Date(row.created_at).toISOString()).toBe(originalCreatedAt)
      expect(row.body).toBeNull()
      // Fix-round (gate P2-1): the STORED column, not just the API-view projection which `toView`
      // masks unconditionally on `deleted_at`. Before this fix, deleting the service's `mentions =
      // '[]'::jsonb,` UPDATE clause left 45/45 green because this was the only DB re-read of
      // `mentions` and nothing asserted on it.
      expect(row.mentions).toEqual([])

      const idCount = await pool().query(`SELECT COUNT(*)::int AS n FROM approval_comments WHERE id = $1`, [commentId])
      expect((idCount.rows[0] as { n: number }).n).toBe(1) // tombstone, not delete

      // Substring scan for the body text: zero rows across BOTH tables for this instance.
      const commentsLeak = await pool().query(
        `SELECT 1 FROM approval_comments WHERE instance_id = $1 AND (body LIKE '%' || $2 || '%')`,
        [instanceId, bodyText],
      )
      expect(commentsLeak.rows.length).toBe(0)
      const recordsLeak = await pool().query(
        `SELECT 1 FROM approval_records WHERE instance_id = $1 AND (comment LIKE '%' || $2 || '%')`,
        [instanceId, bodyText],
      )
      expect(recordsLeak.rows.length).toBe(0)

      // C-5: after tombstone, the audit row STILL exists and STILL has comment IS NULL — the body
      // was never in the trail.
      const pointerAfterDelete = await pool().query(
        `SELECT comment FROM approval_records WHERE instance_id = $1 AND action = 'comment' AND metadata->>'commentId' = $2`,
        [instanceId, commentId],
      )
      expect(pointerAfterDelete.rows.length).toBe(1)
      expect((pointerAfterDelete.rows[0] as { comment: string | null }).comment).toBeNull()
    })

    // Fix-round (gate P3-3): a repeat DELETE on an already-tombstoned comment must be a true
    // no-op — same 200, same `deletedAt`, no second pointer row. Before this fix the second call
    // silently moved `deleted_at` forward on every retry.
    it('P3-3: a second DELETE on an already-tombstoned comment is idempotent — same deletedAt, pointer count stays 1', async () => {
      const requesterId = freshId('p33-requester')
      const instanceId = await seedInstance(requesterId)
      const requesterToken = await participantToken(requesterId)

      const created = await commentsPost(instanceId, requesterToken, { body: 'p3-3 idempotent delete' })
      const createdJson = (await created.json()) as { data: { comment: { id: string } } }
      const commentId = createdJson.data.comment.id

      const firstDelete = await commentsDelete(instanceId, commentId, requesterToken)
      expect(firstDelete.status).toBe(200)
      const firstJson = (await firstDelete.json()) as { data: { comment: { deletedAt: string | null } } }
      const firstDeletedAt = firstJson.data.comment.deletedAt
      expect(firstDeletedAt).not.toBeNull()
      // P3-3 precision fix (S3b carried-hardening item): the API-level `deletedAt` above goes
      // through `toIso` -> `new Date(v).toISOString()`, i.e. MILLISECOND precision, while
      // Postgres `now()` is MICROSECOND — a sub-millisecond rewrite of `deleted_at` (e.g. the
      // idempotency guard failing open and re-running the UPDATE with a fresh `now()` a few
      // microseconds later) would round-trip through `toIso` to the SAME string and pass the
      // API-level assertion vacuously. Read the raw column at full DB precision alongside it.
      const firstRawDeletedAt = await pool().query(`SELECT deleted_at::text AS d FROM approval_comments WHERE id = $1`, [commentId])
      const firstRaw = (firstRawDeletedAt.rows[0] as { d: string }).d

      const secondDelete = await commentsDelete(instanceId, commentId, requesterToken)
      expect(secondDelete.status).toBe(200)
      const secondJson = (await secondDelete.json()) as { data: { comment: { deletedAt: string | null } } }
      // The discriminating assertion: NOT merely "still deleted", but the EXACT SAME timestamp —
      // proves `deleted_at` was not rewritten by the second call.
      expect(secondJson.data.comment.deletedAt).toBe(firstDeletedAt)
      const secondRawDeletedAt = await pool().query(`SELECT deleted_at::text AS d FROM approval_comments WHERE id = $1`, [commentId])
      const secondRaw = (secondRawDeletedAt.rows[0] as { d: string }).d
      // Microsecond-precision gate: exact string equality of the two `::text` reads, the tier
      // the millisecond-rounded API assertion above cannot see through.
      expect(secondRaw).toBe(firstRaw)

      const pointerCount = await pool().query(
        `SELECT COUNT(*)::int AS n FROM approval_records WHERE instance_id = $1 AND action = 'comment' AND metadata->>'commentId' = $2`,
        [instanceId, commentId],
      )
      expect((pointerCount.rows[0] as { n: number }).n).toBe(1)
    })
  })

  // -----------------------------------------------------------------------------------------------
  // P3-6 (S3b carried-hardening item) — the `approval_cmt_instance_fk ... ON DELETE CASCADE`
  // constraint (migration + bootstrap parity pinned in approval-admin-jump-migration.test.ts) is
  // otherwise NEVER exercised: this suite's own `afterAll` deletes `approval_comments` BEFORE
  // `approval_instances` (see the top of this describe block), so the cascade path never actually
  // fires in the real gate battery. One behavioural gate is enough — the self-referencing
  // `parent_id` FK also cascades, but that arm is unreachable while the service only ever
  // TOMBSTONES a comment with replies (C-15) and never hard-deletes one, so a second test for it
  // would be exercising dead code, not a real path.
  // -----------------------------------------------------------------------------------------------
  describe('P3-6: DELETE FROM approval_instances cascades to approval_comments', () => {
    it('a root + reply seeded through the real API (with their own approval_records pointer rows) are both gone after the instance is deleted', async () => {
      const requesterId = freshId('cascade-requester')
      const instanceId = await seedInstance(requesterId)
      const token = await participantToken(requesterId)

      const rootRes = await commentsPost(instanceId, token, { body: 'cascade root' })
      expect(rootRes.status, await rootRes.clone().text()).toBe(201)
      const rootJson = (await rootRes.json()) as { data: { comment: { id: string } } }
      const replyRes = await commentsPost(instanceId, token, { body: 'cascade reply', parentId: rootJson.data.comment.id })
      expect(replyRes.status, await replyRes.clone().text()).toBe(201)

      const before = await pool().query(`SELECT COUNT(*)::int AS n FROM approval_comments WHERE instance_id = $1`, [instanceId])
      expect((before.rows[0] as { n: number }).n).toBe(2)

      // Raw DELETE (not the service, not this suite's own afterAll cleanup helper) — proves the
      // DATABASE-LEVEL cascade, not application-layer cleanup ordering.
      await pool().query(`DELETE FROM approval_instances WHERE id = $1`, [instanceId])

      const after = await pool().query(`SELECT COUNT(*)::int AS n FROM approval_comments WHERE instance_id = $1`, [instanceId])
      expect((after.rows[0] as { n: number }).n).toBe(0)
    })
  })

  // -----------------------------------------------------------------------------------------------
  // C-6 — plm: refusal + spy-zero, platform id spy-one
  // -----------------------------------------------------------------------------------------------
  describe('C-6: plm: ids refused on all five routes, spy-zero on canReadApprovalInstance', () => {
    it('all five routes return 404 for a plm: id, and canReadApprovalInstance is invoked ZERO times', async () => {
      const plmId = `plm:${freshId('c6-mirror')}`
      const viewerToken = await participantToken(freshId('c6-viewer'))
      expect(readabilitySpyState.calls).toBe(0)

      const list = await commentsGet(plmId, viewerToken)
      const create = await commentsPost(plmId, viewerToken, { body: 'x' })
      const patch = await commentsPatch(plmId, 'acmt_nope', viewerToken, { body: 'x' })
      const del = await commentsDelete(plmId, 'acmt_nope', viewerToken)
      const mentions = await mentionCandidates(plmId, viewerToken)

      expect(list.status).toBe(404)
      expect(create.status).toBe(404)
      expect(patch.status).toBe(404)
      expect(del.status).toBe(404)
      expect(mentions.status).toBe(404)
      expect(readabilitySpyState.calls).toBe(0)
    })

    it('a platform id invokes canReadApprovalInstance exactly once per request', async () => {
      const requesterId = freshId('c6-platform-requester')
      const instanceId = await seedInstance(requesterId)
      const requesterToken = await participantToken(requesterId)
      readabilitySpyState.calls = 0
      const res = await commentsGet(instanceId, requesterToken)
      expect(res.status).toBe(200)
      expect(readabilitySpyState.calls).toBe(1)
    })
  })

  // -----------------------------------------------------------------------------------------------
  // C-7 — authorship: author edit succeeds; non-author edit denied, body unchanged
  // -----------------------------------------------------------------------------------------------
  describe('C-7: author-only edit', () => {
    it('author PATCH 200, edited_at set, created_at/author_id unchanged; different S1-admitted participant PATCH 404, body byte-identical', async () => {
      const requesterId = freshId('c7-requester')
      const instanceId = await seedInstance(requesterId)
      const requesterToken = await participantToken(requesterId)
      const created = await commentsPost(instanceId, requesterToken, { body: 'original body' })
      const createdJson = (await created.json()) as { data: { comment: { id: string; createdAt: string; authorId: string; editedAt: string | null } } }
      const commentId = createdJson.data.comment.id
      expect(createdJson.data.comment.editedAt).toBeNull()

      const editRes = await commentsPatch(instanceId, commentId, requesterToken, { body: 'edited body' })
      expect(editRes.status, await editRes.clone().text()).toBe(200)
      const editJson = (await editRes.json()) as { data: { comment: { editedAt: string | null; createdAt: string; authorId: string; body: string } } }
      expect(editJson.data.comment.editedAt).not.toBeNull()
      expect(editJson.data.comment.createdAt).toBe(createdJson.data.comment.createdAt)
      expect(editJson.data.comment.authorId).toBe(createdJson.data.comment.authorId)
      expect(editJson.data.comment.body).toBe('edited body')

      // Different, fully S1-admitted participant (a CC target) attempts to edit — denied 404, and
      // the stored body is untouched.
      const otherId = freshId('c7-other-participant')
      await seedRecord(instanceId, 'cc', requesterId, { targetType: 'user', targetId: otherId })
      const otherToken = await participantToken(otherId)
      const deniedEdit = await commentsPatch(instanceId, commentId, otherToken, { body: 'hijacked body' })
      expect(deniedEdit.status).toBe(404)
      const deniedJson = await deniedEdit.json()
      expect(deniedJson).toEqual({ ok: false, error: { code: 'APPROVAL_COMMENT_NOT_FOUND', message: 'Approval comment not found' } })

      const stored = await pool().query(`SELECT body FROM approval_comments WHERE id = $1`, [commentId])
      expect((stored.rows[0] as { body: string }).body).toBe('edited body')
    })
  })

  // -----------------------------------------------------------------------------------------------
  // C-8 / C-9 — parentId validation: same instance, one-level threading
  // -----------------------------------------------------------------------------------------------
  describe('C-8/C-9: parentId validation', () => {
    it('C-8: same-instance parentId 201; parentId on ANOTHER instance the viewer ALSO participates in -> 400, zero rows written', async () => {
      const requesterId = freshId('c8-requester')
      const instanceA = await seedInstance(requesterId)
      const instanceB = await seedInstance(requesterId)
      const token = await participantToken(requesterId)

      const parentInA = await commentsPost(instanceA, token, { body: 'parent in A' })
      const parentInAJson = (await parentInA.json()) as { data: { comment: { id: string } } }

      const sameInstanceReply = await commentsPost(instanceA, token, { body: 'reply in A', parentId: parentInAJson.data.comment.id })
      expect(sameInstanceReply.status, await sameInstanceReply.clone().text()).toBe(201)

      const before = await pool().query(`SELECT COUNT(*)::int AS n FROM approval_comments WHERE instance_id = $1`, [instanceB])
      const graft = await commentsPost(instanceB, token, { body: 'graft attempt', parentId: parentInAJson.data.comment.id })
      expect(graft.status).toBe(400)
      const graftJson = await graft.json()
      expect((graftJson as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
      const after = await pool().query(`SELECT COUNT(*)::int AS n FROM approval_comments WHERE instance_id = $1`, [instanceB])
      expect((after.rows[0] as { n: number }).n).toBe((before.rows[0] as { n: number }).n)
    })

    it('C-9: one-level reply 201; reply-to-a-reply 400 VALIDATION_ERROR', async () => {
      const requesterId = freshId('c9-requester')
      const instanceId = await seedInstance(requesterId)
      const token = await participantToken(requesterId)

      const rootRes = await commentsPost(instanceId, token, { body: 'root' })
      const rootJson = (await rootRes.json()) as { data: { comment: { id: string } } }
      const replyRes = await commentsPost(instanceId, token, { body: 'reply', parentId: rootJson.data.comment.id })
      expect(replyRes.status).toBe(201)
      const replyJson = (await replyRes.json()) as { data: { comment: { id: string } } }

      const tooDeep = await commentsPost(instanceId, token, { body: 'reply to reply', parentId: replyJson.data.comment.id })
      expect(tooDeep.status).toBe(400)
      const tooDeepJson = await tooDeep.json()
      expect((tooDeepJson as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
    })

    // Fix-round (gate P3-4): a REAL parentId on another instance and a FABRICATED parentId must
    // deny with the IDENTICAL message — before this fix the two branches read differently
    // ("does not reference an existing comment" vs. "must reference a comment on the same
    // instance"), letting a caller who already holds an id learn whether it exists on SOME
    // instance even when denied on this one.
    //
    // S3b fixture fix (P3-4 NIT, carried-hardening item): `instanceA` and `instanceB` MUST be
    // seeded with DIFFERENT requesters. With the SAME requester (the original fixture), `token`
    // can already list/read instanceA's comments directly — the test then proves message
    // EQUALITY but reproduces no actual oracle, since the caller was never denied access to A in
    // the first place. The named scenario (service `:274-281`) is specifically about a caller
    // LEARNING an id exists on an instance they cannot read. `viewerToken` below participates
    // only in instanceB; the real parent comment is posted into instanceA by A's OWN requester.
    it('P3-4: foreign-instance parentId and a fabricated parentId deny with the SAME message', async () => {
      const requesterAId = freshId('p34-requester-a')
      const requesterBId = freshId('p34-requester-b')
      const instanceA = await seedInstance(requesterAId)
      const instanceB = await seedInstance(requesterBId)
      const requesterAToken = await participantToken(requesterAId)
      const viewerToken = await participantToken(requesterBId)

      // Posted by A's OWN requester — requesterB (viewerToken) cannot read instanceA at all, so
      // this could not have been posted through viewerToken's own token.
      const parentInA = await commentsPost(instanceA, requesterAToken, { body: 'parent in A' })
      expect(parentInA.status, await parentInA.clone().text()).toBe(201)
      const parentInAJson = (await parentInA.json()) as { data: { comment: { id: string } } }

      const foreignReal = await commentsPost(instanceB, viewerToken, { body: 'graft', parentId: parentInAJson.data.comment.id })
      expect(foreignReal.status).toBe(400)
      const foreignRealJson = (await foreignReal.json()) as { error: { code: string; message: string } }

      const fabricated = await commentsPost(instanceB, viewerToken, { body: 'graft', parentId: `acmt_${freshId('nonexistent')}` })
      expect(fabricated.status).toBe(400)
      const fabricatedJson = (await fabricated.json()) as { error: { code: string; message: string } }

      expect(foreignRealJson.error.code).toBe('VALIDATION_ERROR')
      expect(fabricatedJson.error.code).toBe('VALIDATION_ERROR')
      expect(foreignRealJson.error.message).toBe(fabricatedJson.error.message)
    })
  })

  // -----------------------------------------------------------------------------------------------
  // C-10 — cross-org, enumerated over all five routes (org pin forced ON in-process)
  // -----------------------------------------------------------------------------------------------
  describe('C-10: cross-org denial (org pin forced ON, enumerated over all five routes)', () => {
    async function seedActiveOrg(userId: string, orgId: string): Promise<void> {
      await pool().query(
        `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)
         ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = TRUE`,
        [userId, orgId],
      )
    }

    it('requester reads own org instance on all five routes; the SAME principal as a stale seat on a foreign org instance (NO membership there) is denied on all five', async () => {
      process.env.APPROVAL_S1_ORG_PIN_ENABLED = 'true'
      const viewerId = freshId('c10-viewer')
      const homeOrg = `c10-home-${TS}-${Math.random().toString(36).slice(2, 6)}`
      const foreignOrg = `c10-foreign-${TS}-${Math.random().toString(36).slice(2, 6)}`
      await seedUser(viewerId)
      await seedActiveOrg(viewerId, homeOrg)
      const token = await participantToken(viewerId)

      const homeInstanceId = await seedInstance(viewerId)
      await pool().query(`UPDATE approval_instances SET org_id = $1 WHERE id = $2`, [homeOrg, homeInstanceId])
      expect((await commentsGet(homeInstanceId, token)).status).toBe(200)

      const foreignRequesterId = freshId('c10-foreign-requester')
      const foreignInstanceId = await seedInstance(foreignRequesterId)
      await pool().query(`UPDATE approval_instances SET org_id = $1 WHERE id = $2`, [foreignOrg, foreignInstanceId])
      // Stale seat — membership without org access. The viewer holds NO membership in foreignOrg
      // at all (fixture precondition per G-S1-10 — the blanket 'default' backfill would make a
      // same-'default'-org negative vacuous).
      await seedAssignment(foreignInstanceId, viewerId, 'user')

      const list = await commentsGet(foreignInstanceId, token)
      const create = await commentsPost(foreignInstanceId, token, { body: 'x' })
      const patch = await commentsPatch(foreignInstanceId, 'acmt_nope', token, { body: 'x' })
      const del = await commentsDelete(foreignInstanceId, 'acmt_nope', token)
      const mentions = await mentionCandidates(foreignInstanceId, token)
      expect(list.status).toBe(404)
      expect(create.status).toBe(404)
      expect(patch.status).toBe(404)
      expect(del.status).toBe(404)
      expect(mentions.status).toBe(404)
    })
  })

  // -----------------------------------------------------------------------------------------------
  // C-11 — G-S1-9 notify seam, fail-closed default
  // -----------------------------------------------------------------------------------------------
  describe('C-11 (G-S1-9): notify seam is fail-closed by default; wiring a checker delivers exactly once', () => {
    afterEach(() => {
      resetApprovalCommentNotifyCheckerForTests()
      resetApprovalCommentMentionDeliveryForTests()
    })

    it('NEGATIVE: with the fail-closed default (no checker wired), zero deliveries', async () => {
      resetApprovalCommentNotifyCheckerForTests()
      const deliveries: unknown[] = []
      setApprovalCommentMentionDelivery((userId, event, payload) => deliveries.push({ userId, event, payload }))
      await notifyApprovalCommentMentions({
        instanceId: 'inst-x', commentId: 'acmt-x', authorId: 'author-x', mentions: ['mentioned-x'],
      })
      expect(deliveries.length).toBe(0)
    })

    it('POSITIVE: with a checker wired, a mentioned participant receives EXACTLY ONE delivery, values-free payload', async () => {
      setApprovalCommentNotifyChecker(async () => true)
      const deliveries: Array<{ userId: string; event: string; payload: unknown }> = []
      setApprovalCommentMentionDelivery((userId, event, payload) => deliveries.push({ userId, event, payload }))
      await notifyApprovalCommentMentions({
        instanceId: 'inst-y', commentId: 'acmt-y', authorId: 'author-y', mentions: ['mentioned-y'],
      })
      expect(deliveries.length).toBe(1)
      expect(deliveries[0].userId).toBe('mentioned-y')
      expect(deliveries[0].event).toBe('approval-comment:mention')
      expect(deliveries[0].payload).toEqual({ commentId: 'acmt-y', instanceId: 'inst-y', authorId: 'author-y' })
    })

    it('a thrown checker denies (fail-closed wrapper), never throws out to the caller', async () => {
      setApprovalCommentNotifyChecker(async () => {
        throw new Error('boom')
      })
      const deliveries: unknown[] = []
      setApprovalCommentMentionDelivery((userId, event, payload) => deliveries.push({ userId, event, payload }))
      await expect(
        notifyApprovalCommentMentions({ instanceId: 'inst-z', commentId: 'acmt-z', authorId: 'author-z', mentions: ['mentioned-z'] }),
      ).resolves.toBeUndefined()
      expect(deliveries.length).toBe(0)
    })
  })

  // -----------------------------------------------------------------------------------------------
  // C-12 — mention candidates: subset direction + non-participant absence
  // -----------------------------------------------------------------------------------------------
  describe('C-12: mention candidates — subset of admission, non-participant never appears', () => {
    it('POSITIVE (subset direction): every returned id satisfies canReadApprovalInstance, including a role-matched-via-users.role candidate; NEGATIVE: a same-org non-participant does not appear for ANY q, including one exactly matching their name', async () => {
      const requesterId = freshId('c12-requester')
      const instanceId = await seedInstance(requesterId)
      const ccUserId = freshId('c12-cc')
      await seedUser(ccUserId)
      await seedRecord(instanceId, 'cc', requesterId, { targetType: 'user', targetId: ccUserId })

      // Exercises the users.role UNION branch specifically (the mirror of viewerRoles's SECOND
      // role source): a role-typed assignment whose assignee_id is a plain role string, matched
      // directly against a user's `users.role` column (not via user_roles/roles).
      const roleMatchedUserId = freshId('c12-rolematch')
      await seedUser(roleMatchedUserId)
      await pool().query(`UPDATE users SET role = 'c12-manager' WHERE id = $1`, [roleMatchedUserId])
      await seedAssignment(instanceId, 'c12-manager', 'role')

      const nonParticipantId = freshId('c12-nonparticipant')
      await seedUser(nonParticipantId)

      const token = await participantToken(requesterId)
      const res = await mentionCandidates(instanceId, token)
      expect(res.status).toBe(200)
      const json = (await res.json()) as { data: { users: Array<{ id: string }> } }
      const ids = json.data.users.map((u) => u.id)

      // POSITIVE subset direction: the role-matched candidate IS present, and — looping over
      // EVERY returned id, not a hand-picked one — each independently satisfies the S1 predicate
      // for this instance. A candidate the CTE over-includes beyond admission would fail here.
      expect(ids).toContain(roleMatchedUserId)
      expect(ids).toContain(ccUserId)
      expect(ids.length).toBeGreaterThan(0)
      for (const id of ids) {
        await expect(canReadApprovalInstance(pool(), id, instanceId)).resolves.toBe(true)
      }

      expect(ids).not.toContain(nonParticipantId)

      // The discriminating case: q exactly matches the non-participant's name — they still must
      // not appear.
      const targeted = await mentionCandidates(instanceId, token, `?q=${encodeURIComponent(nonParticipantId)}`)
      const targetedJson = (await targeted.json()) as { data: { users: Array<{ id: string }> } }
      expect(targetedJson.data.users.map((u) => u.id)).not.toContain(nonParticipantId)
    })
  })

  // -----------------------------------------------------------------------------------------------
  // C-13 — tombstone readability: visible to participants, still 404 for non-participants
  // -----------------------------------------------------------------------------------------------
  describe('C-13: tombstone readability', () => {
    it('a tombstoned comment appears in the participant list with deleted:true/body:null/mentions:[]; non-participant still 404', async () => {
      const requesterId = freshId('c13-requester')
      const instanceId = await seedInstance(requesterId)
      const token = await participantToken(requesterId)
      const created = await commentsPost(instanceId, token, { body: 'to be deleted' })
      const createdJson = (await created.json()) as { data: { comment: { id: string } } }
      await commentsDelete(instanceId, createdJson.data.comment.id, token)

      const list = await commentsGet(instanceId, token)
      const listJson = (await list.json()) as { data: { comments: Array<{ id: string; deleted: boolean; body: string | null; mentions: string[] }> } }
      const tombstoned = listJson.data.comments.find((c) => c.id === createdJson.data.comment.id)
      expect(tombstoned).toBeTruthy()
      expect(tombstoned?.deleted).toBe(true)
      expect(tombstoned?.body).toBeNull()
      expect(tombstoned?.mentions).toEqual([])

      const outsiderToken = await participantToken(freshId('c13-outsider'))
      const outsiderList = await commentsGet(instanceId, outsiderToken)
      expect(outsiderList.status).toBe(404)
    })
  })

  // -----------------------------------------------------------------------------------------------
  // C-14a/C-14b — /history HISTORY-TIMELINE arm (i): pointer-row negative + legacy-row positive
  // -----------------------------------------------------------------------------------------------
  describe('C-14a/C-14b: /history arm (i) — pointer rows excluded, legacy comment rows stay visible', () => {
    it('C-14a: posting a comment does not move /history total or expose the pointer row id', async () => {
      const requesterId = freshId('c14a-requester')
      const instanceId = await seedInstance(requesterId)
      const token = await participantToken(requesterId)

      const before = await jsonRequest(baseUrl, `/api/approvals/${instanceId}/history`, token)
      const beforeJson = (await before.json()) as { data: { total: number } }

      const created = await commentsPost(instanceId, token, { body: 'history should not see this pointer row' })
      const createdJson = (await created.json()) as { data: { comment: { id: string } } }

      const after = await jsonRequest(baseUrl, `/api/approvals/${instanceId}/history`, token)
      const afterJson = (await after.json()) as { data: { total: number; items: Array<{ id: string }> } }
      expect(afterJson.data.total).toBe(beforeJson.data.total)
      const pointerRow = await pool().query(
        `SELECT id FROM approval_records WHERE instance_id = $1 AND metadata->>'commentId' = $2`,
        [instanceId, createdJson.data.comment.id],
      )
      const pointerRecordId = String((pointerRow.rows[0] as { id: string | number }).id)
      expect(afterJson.data.items.map((it) => String(it.id))).not.toContain(pointerRecordId)
    })

    it('C-14b (§5.1 anti-pattern gate): a LEGACY act-path comment row (body in `comment`, metadata:{nodeKey}, NO commentId) IS present in /history and DOES increment total', async () => {
      const requesterId = freshId('c14b-requester')
      const instanceId = await seedInstance(requesterId)
      const token = await participantToken(requesterId)

      const before = await jsonRequest(baseUrl, `/api/approvals/${instanceId}/history`, token)
      const beforeJson = (await before.json()) as { data: { total: number } }

      // Seed the LEGACY act-path shape directly — same row shape ApprovalProductService's dispatch
      // choke writes for `action:'comment'` (body IN the `comment` column, `metadata:{nodeKey}`, NO
      // `commentId`). Driving this through the full node-routed dispatch flow would require a
      // published template + live node — out of scope for a /history-predicate gate; the /history
      // route reads directly off approval_records and does not care how the row was produced.
      await pool().query(
        `INSERT INTO approval_records (instance_id, action, actor_id, actor_name, comment, from_status, to_status, from_version, to_version, metadata)
         VALUES ($1, 'comment', $2, 'Legacy Actor', 'legacy act-path comment body', 'pending', 'pending', 0, 0, $3::jsonb)`,
        [instanceId, requesterId, JSON.stringify({ nodeKey: 'node-1' })],
      )

      const after = await jsonRequest(baseUrl, `/api/approvals/${instanceId}/history`, token)
      const afterJson = (await after.json()) as { data: { total: number; items: Array<{ action: string; comment: string | null }> } }
      expect(afterJson.data.total).toBe(beforeJson.data.total + 1)
      expect(afterJson.data.items.some((it) => it.action === 'comment' && it.comment === 'legacy act-path comment body')).toBe(true)
    })
  })

  // -----------------------------------------------------------------------------------------------
  // C-15 — reply-refusal NOT copied from CommentService
  // -----------------------------------------------------------------------------------------------
  describe('C-15: deleting a comment WITH replies is ALLOWED (anti CommentService.ts:259 gate)', () => {
    it('author DELETEs a commented-on comment -> 200 tombstoned; the reply row still exists with parent_id intact', async () => {
      const requesterId = freshId('c15-requester')
      const instanceId = await seedInstance(requesterId)
      const token = await participantToken(requesterId)
      const rootRes = await commentsPost(instanceId, token, { body: 'root with a reply' })
      const rootJson = (await rootRes.json()) as { data: { comment: { id: string } } }
      const replyRes = await commentsPost(instanceId, token, { body: 'a reply', parentId: rootJson.data.comment.id })
      expect(replyRes.status).toBe(201)
      const replyJson = (await replyRes.json()) as { data: { comment: { id: string } } }

      const deleteRes = await commentsDelete(instanceId, rootJson.data.comment.id, token)
      // Positive assertion, never notEqual: the delete succeeds with 200, not a 409.
      expect(deleteRes.status).toBe(200)

      const replyRow = await pool().query(`SELECT parent_id FROM approval_comments WHERE id = $1`, [replyJson.data.comment.id])
      expect(replyRow.rows.length).toBe(1)
      expect((replyRow.rows[0] as { parent_id: string }).parent_id).toBe(rootJson.data.comment.id)
    })
  })

  // -----------------------------------------------------------------------------------------------
  // C-16 — check ordering: author check before payload validation
  // -----------------------------------------------------------------------------------------------
  describe('C-16: check ordering — non-author denial precedes payload validation', () => {
    it('non-author PATCH with a VALID payload -> 404; non-author PATCH with a BLANK payload -> ALSO 404, never 400', async () => {
      const requesterId = freshId('c16-requester')
      const instanceId = await seedInstance(requesterId)
      const token = await participantToken(requesterId)
      const created = await commentsPost(instanceId, token, { body: 'original' })
      const createdJson = (await created.json()) as { data: { comment: { id: string } } }

      const otherId = freshId('c16-other')
      await seedRecord(instanceId, 'cc', requesterId, { targetType: 'user', targetId: otherId })
      const otherToken = await participantToken(otherId)

      const validPayload = await commentsPatch(instanceId, createdJson.data.comment.id, otherToken, { body: 'a perfectly valid replacement body' })
      expect(validPayload.status).toBe(404)
      const validJson = await validPayload.json()
      expect((validJson as { error: { code: string } }).error.code).toBe('APPROVAL_COMMENT_NOT_FOUND')

      const blankPayload = await commentsPatch(instanceId, createdJson.data.comment.id, otherToken, { body: '' })
      expect(blankPayload.status).toBe(404)
      const blankJson = await blankPayload.json()
      expect((blankJson as { error: { code: string } }).error.code).toBe('APPROVAL_COMMENT_NOT_FOUND')
    })
  })

  // -----------------------------------------------------------------------------------------------
  // Body bounds (R7) + edit-a-tombstone (R2) + reply-to-a-tombstone (R3) — supporting gates
  // -----------------------------------------------------------------------------------------------
  describe('R2/R3/R7: body bounds, edit-a-tombstone 409, reply-to-a-tombstone 201', () => {
    it('R7: blank body -> 400; over-cap body -> 400', async () => {
      const requesterId = freshId('r7-requester')
      const instanceId = await seedInstance(requesterId)
      const token = await participantToken(requesterId)
      const blank = await commentsPost(instanceId, token, { body: '   ' })
      expect(blank.status).toBe(400)
      const overCap = await commentsPost(instanceId, token, { body: 'x'.repeat(5001) })
      expect(overCap.status).toBe(400)
    })

    it('R2: editing a tombstone -> 409 APPROVAL_COMMENT_DELETED; R3: replying to a tombstone -> 201', async () => {
      const requesterId = freshId('r2r3-requester')
      const instanceId = await seedInstance(requesterId)
      const token = await participantToken(requesterId)
      const created = await commentsPost(instanceId, token, { body: 'will be tombstoned' })
      const createdJson = (await created.json()) as { data: { comment: { id: string } } }
      await commentsDelete(instanceId, createdJson.data.comment.id, token)

      const editTombstone = await commentsPatch(instanceId, createdJson.data.comment.id, token, { body: 'resurrect me' })
      expect(editTombstone.status).toBe(409)
      const editJson = await editTombstone.json()
      expect((editJson as { error: { code: string } }).error.code).toBe('APPROVAL_COMMENT_DELETED')

      const replyToTombstone = await commentsPost(instanceId, token, { body: 'a reply to the tombstone', parentId: createdJson.data.comment.id })
      expect(replyToTombstone.status).toBe(201)
    })
  })
})
