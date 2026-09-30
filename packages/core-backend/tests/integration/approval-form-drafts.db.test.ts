import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'
import { pool as backendPool } from '../../src/db/pg'
import {
  APPROVAL_FORM_DRAFT_LIMITS,
  APPROVAL_FORM_DRAFT_MAX_ROWS_PER_USER,
  APPROVAL_FORM_DRAFT_SIGNATURE_LIMITS,
  APPROVAL_FORM_DRAFT_TTL_HOURS,
  ApprovalFormDraftConflictError,
  clearApprovalFormDraft,
  saveApprovalFormDraft,
  sweepExpiredApprovalFormDrafts,
} from '../../src/services/approval-form-draft-service'

/**
 * P3-3 — `approval_form_drafts` real-DB acceptance battery (contract §4 A/B/D/E/F, plus the
 * TTL-sweep function). Test C (server/FE signature byte-parity) lives separately in
 * tests/unit/approval-form-draft-signature-web-parity.test.ts (pure, no DB, live cross-package
 * import — see that file's own header for why). Test G (resubmit-prefill priority over draft
 * restore, including the constructed async-race form) is a FRONTEND concern
 * (apps/web/tests/approvalNewView.spec.ts) — this file has no `?fromInstance=` concept at all,
 * confirming by absence that the server layer is agnostic to it (the priority is entirely a
 * client-side ordering decision over two already-independent data sources).
 *
 * ⚠️ This suite requires the `approval_form_drafts` table (owner-gated DDL — see the migration's
 * own docblock: NOT applied to any shared database). `ensureApprovalSchemaReady()` converges an
 * ephemeral/throwaway test database to the shape it needs; run this ONLY against such a database
 * (this lane's CI Postgres container, or a local throwaway DB), never against a shared dev/staging
 * database.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()

// Sentinel deliberately OUTSIDE describeIfDatabase (top-level `it`, gated only on EXPECT_DB) —
// matches the landed pattern (approval-comments.db.test.ts / approval-org-writer-*-s1.db.test.ts):
// a sentinel nested inside describeIfDatabase would itself be skipped whenever DATABASE_URL is
// absent, so it could never catch a DB-expected CI lane (EXPECT_DB=1) whose DATABASE_URL is
// missing/broken silently reporting this whole file as skipped-green instead of red.
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
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
}

/** Mirrors approval-comments.db.test.ts's `authToken` helper, plus an optional `tenantId` — the
 *  vector test B mutates. `perms` defaults to this router's actual RBAC scope. */
async function authToken(
  baseUrl: string,
  userId: string,
  opts: { perms?: string; tenantId?: string } = {},
): Promise<string> {
  const perms = opts.perms ?? 'approvals:write'
  const qs = new URLSearchParams({ userId, roles: 'user', perms })
  if (opts.tenantId) qs.set('tenantId', opts.tenantId)
  const response = await fetch(`${baseUrl}/api/auth/dev-token?${qs.toString()}`)
  expect(response.status).toBe(200)
  return ((await response.json()) as { token: string }).token
}

describeIfDatabase('P3-3 approval_form_drafts — real-DB acceptance (contract §4 A/B/D/E/F)', () => {
  let MetaSheetServer: typeof import('../../src/index').MetaSheetServer
  let server: InstanceType<typeof MetaSheetServer> | undefined
  let baseUrl = ''
  const pool = () => poolManager.get()
  const createdUserIds: string[] = []

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
  }, 60000)

  afterAll(async () => {
    try {
      if (createdUserIds.length > 0) {
        await pool().query(`DELETE FROM approval_form_drafts WHERE user_id = ANY($1::text[])`, [createdUserIds])
      }
    } finally {
      await server?.stop()
    }
  })

  function freshId(prefix: string): string {
    return `${prefix}-${TS}-${Math.random().toString(36).slice(2, 8)}`
  }

  function trackUser(userId: string): string {
    createdUserIds.push(userId)
    return userId
  }

  async function draftGet(templateId: string, token: string, headers?: Record<string, string>) {
    return jsonRequest(baseUrl, `/api/approvals/form-drafts/${encodeURIComponent(templateId)}`, token, { headers })
  }
  async function draftPut(templateId: string, token: string, body: unknown, headers?: Record<string, string>) {
    return jsonRequest(baseUrl, `/api/approvals/form-drafts/${encodeURIComponent(templateId)}`, token, { method: 'PUT', body, headers })
  }
  async function draftDelete(templateId: string, token: string) {
    return jsonRequest(baseUrl, `/api/approvals/form-drafts/${encodeURIComponent(templateId)}`, token, { method: 'DELETE' })
  }
  async function draftList(token: string, headers?: Record<string, string>) {
    return jsonRequest(baseUrl, `/api/approvals/form-drafts`, token, { headers })
  }

  // ===============================================================================================
  // A — auth by user_id ONLY
  // ===============================================================================================
  describe('A: auth by user_id only', () => {
    it('POSITIVE: user A can load their own saved draft', async () => {
      const userA = trackUser(freshId('p33-a-pos'))
      const templateId = freshId('tmpl')
      const tokenA = await authToken(baseUrl, userA)

      const put = await draftPut(templateId, tokenA, { signature: 'sig-1', data: { amount: 12 } })
      expect(put.status, await put.clone().text()).toBe(200)

      const get = await draftGet(templateId, tokenA)
      expect(get.status).toBe(200)
      const body = (await get.json()) as { data: { draft: { data: Record<string, unknown> } | null } }
      expect(body.data.draft?.data).toEqual({ amount: 12 })
    })

    it('NEGATIVE: user B requesting the SAME templateId gets no data belonging to user A (there is no cross-user id in the URL — B always reads back only their OWN slot)', async () => {
      const userA = trackUser(freshId('p33-a-neg'))
      const userB = trackUser(freshId('p33-b-neg'))
      const templateId = freshId('tmpl')
      const tokenA = await authToken(baseUrl, userA)
      const tokenB = await authToken(baseUrl, userB)

      await draftPut(templateId, tokenA, { signature: 'sig-a', data: { secret: 'A-only' } })

      const getAsB = await draftGet(templateId, tokenB)
      expect(getAsB.status).toBe(200)
      const bodyB = (await getAsB.json()) as { data: { draft: unknown } }
      expect(bodyB.data.draft).toBeNull()

      // B's list is also empty — A's draft never appears in it.
      const listAsB = await draftList(tokenB)
      const listBody = (await listAsB.json()) as { data: { drafts: Array<{ templateId: string }> } }
      expect(listBody.data.drafts.find((d) => d.templateId === templateId)).toBeUndefined()
    })

    it('NEGATIVE ("any means"): a forged x-user-id / x-actor-id header on B\'s request does NOT let B read A\'s draft — the acting user comes ONLY from the verified token', async () => {
      const userA = trackUser(freshId('p33-a-forge'))
      const userB = trackUser(freshId('p33-b-forge'))
      const templateId = freshId('tmpl')
      const tokenA = await authToken(baseUrl, userA)
      const tokenB = await authToken(baseUrl, userB)

      await draftPut(templateId, tokenA, { signature: 'sig-a', data: { secret: 'A-only-2' } })

      const forged = await draftGet(templateId, tokenB, { 'x-user-id': userA, 'x-actor-id': userA })
      expect(forged.status).toBe(200)
      const forgedBody = (await forged.json()) as { data: { draft: unknown } }
      expect(forgedBody.data.draft).toBeNull()
    })

    it('NEGATIVE (destroy): user B issuing DELETE at the SAME templateId does not remove user A\'s draft — B\'s DELETE is still 204 (non-revealing: it must not tell B whether anything existed)', async () => {
      const userA = trackUser(freshId('p33-a-clear-attack'))
      const userB = trackUser(freshId('p33-b-clear-attack'))
      const templateId = freshId('tmpl')
      const tokenA = await authToken(baseUrl, userA)
      const tokenB = await authToken(baseUrl, userB)

      await draftPut(templateId, tokenA, { signature: 'sig-a', data: { secret: 'A-should-survive' } })

      // B never had a draft at this templateId — B's own DELETE is a same-user no-op, guessing at
      // A's templateId (public: it is the URL param of a template any approver can see).
      const del = await draftDelete(templateId, tokenB)
      expect(del.status).toBe(204)

      const getAsA = await draftGet(templateId, tokenA)
      expect(getAsA.status).toBe(200)
      const bodyA = (await getAsA.json()) as { data: { draft: { data: Record<string, unknown> } | null } }
      expect(bodyA.data.draft?.data).toEqual({ secret: 'A-should-survive' })
    })
  })

  // ===============================================================================================
  // B — org must NOT participate in visibility (inverted assertion: mutating session org must
  // never change what the user can see; a test that reds on an org mutation is a FAIL of the
  // production code, not a passing test).
  // ===============================================================================================
  describe('B: org/tenant mutation must not change visibility', () => {
    it('user A\'s own draft is visible IDENTICALLY under three different session-org values (none, org-1, EVIL org)', async () => {
      const userA = trackUser(freshId('p33-a-org'))
      const templateId = freshId('tmpl')

      // Save under a token with no tenantId at all.
      const tokenNoOrg = await authToken(baseUrl, userA)
      await draftPut(templateId, tokenNoOrg, { signature: 'sig-org', data: { amount: 99 } })

      const readNoOrg = await draftGet(templateId, tokenNoOrg)
      const bodyNoOrg = await readNoOrg.json()

      // Mint a SECOND token for the SAME user, this time embedding tenantId=org-legit in the JWT
      // (jwt-middleware.ts decodes this straight onto req.user.tenantId).
      const tokenOrgLegit = await authToken(baseUrl, userA, { tenantId: 'org-legit' })
      const readOrgLegit = await draftGet(templateId, tokenOrgLegit)
      const bodyOrgLegit = await readOrgLegit.json()

      // Mint a THIRD token with a hostile org id — same user, same template.
      const tokenOrgEvil = await authToken(baseUrl, userA, { tenantId: 'org-EVIL' })
      const readOrgEvil = await draftGet(templateId, tokenOrgEvil)
      const bodyOrgEvil = await readOrgEvil.json()

      // Also attach a spoofed x-tenant-id HEADER (the jwt-middleware back-fill path for a token
      // that carries no tenantId of its own) on top of the no-org token.
      const readHeaderSpoof = await draftGet(templateId, tokenNoOrg, { 'x-tenant-id': 'org-EVIL-header' })
      const bodyHeaderSpoof = await readHeaderSpoof.json()

      expect(readNoOrg.status).toBe(200)
      expect(readOrgLegit.status).toBe(200)
      expect(readOrgEvil.status).toBe(200)
      expect(readHeaderSpoof.status).toBe(200)
      // INVERTED ASSERTION: all four must be byte-identical. If any org mutation changed the
      // result, org has leaked into the auth/read path — that is what this test exists to catch.
      expect(bodyOrgLegit).toEqual(bodyNoOrg)
      expect(bodyOrgEvil).toEqual(bodyNoOrg)
      expect(bodyHeaderSpoof).toEqual(bodyNoOrg)
      expect((bodyNoOrg as { data: { draft: { data: unknown } } }).data.draft?.data).toEqual({ amount: 99 })
    })

    it('POSITIVE CONTROL for the mutation-probe itself: two DIFFERENT users DO see different drafts (proves the harness can detect a real difference — it is not vacuously equal-everything)', async () => {
      const userA = trackUser(freshId('p33-a-ctrl'))
      const userC = trackUser(freshId('p33-c-ctrl'))
      const templateId = freshId('tmpl')
      const tokenA = await authToken(baseUrl, userA)
      const tokenC = await authToken(baseUrl, userC)

      await draftPut(templateId, tokenA, { signature: 'sig', data: { who: 'A' } })
      await draftPut(templateId, tokenC, { signature: 'sig', data: { who: 'C' } })

      const bodyA = (await (await draftGet(templateId, tokenA)).json()) as { data: { draft: { data: Record<string, unknown> } } }
      const bodyC = (await (await draftGet(templateId, tokenC)).json()) as { data: { draft: { data: Record<string, unknown> } } }
      expect(bodyA).not.toEqual(bodyC)
      expect(bodyA.data.draft.data).toEqual({ who: 'A' })
      expect(bodyC.data.draft.data).toEqual({ who: 'C' })
    })
  })

  // ===============================================================================================
  // D — never throw to the user: a DB query failure must return a values-free 5xx JSON body, not
  // crash the process or leak a raw stack trace / error message.
  // ===============================================================================================
  describe('D: DB failure degrades safely (never throw to the user)', () => {
    it('a poisoned pool.query rejects with a values-free 5xx, and the NORMAL path still works right after (positive control)', async () => {
      const userA = trackUser(freshId('p33-a-throw'))
      const templateId = freshId('tmpl')
      const tokenA = await authToken(baseUrl, userA)

      expect(backendPool).toBeTruthy()
      const originalQuery = backendPool!.query.bind(backendPool)
      // Monkey-patch the SAME pg.Pool instance the route module imports (module singleton) so its
      // very next `.query()` call rejects — simulating a DB outage without touching the schema.
      // Restored in a finally block so this can never leak into a later test.
      ;(backendPool as unknown as { query: unknown }).query = () => Promise.reject(new Error('simulated DB outage: secret-connection-string-should-never-leak'))
      try {
        const res = await draftGet(templateId, tokenA)
        expect(res.status).toBeGreaterThanOrEqual(500)
        const raw = await res.text()
        // Values-free: the raw DB error text must never reach the response body.
        expect(raw).not.toContain('secret-connection-string-should-never-leak')
        const parsed = JSON.parse(raw) as { ok: boolean; error?: { code?: string; message?: string } }
        expect(parsed.ok).toBe(false)
        expect(typeof parsed.error?.code).toBe('string')
      } finally {
        ;(backendPool as unknown as { query: unknown }).query = originalQuery
      }

      // Positive control: normal path works again immediately after restoring the pool.
      const recovered = await draftGet(templateId, tokenA)
      expect(recovered.status).toBe(200)
    })
  })

  // ===============================================================================================
  // FIX 4 (gate P2-4) — constructed interleaving: an unlocked writer's DELETE races
  // `saveApprovalFormDraft`'s UPDATE branch between its existence SELECT and its UPDATE. Driven by
  // intercepting the ACTUAL query the production transaction issues (via the raw pg.Pool's
  // `connect()`), not by a sleep/timing guess — the interleaving fires deterministically on every
  // run.
  //
  // UPDATE (gate2 P3-D fix round): `clearApprovalFormDraft` used to be exactly such an unlocked
  // writer and is what these two tests originally used to construct this race. It NOW shares
  // `saveApprovalFormDraft`'s advisory lock (see that function's own comment), so it can no longer
  // commit a DELETE while a save's transaction is mid-flight — calling it from inside this
  // interleave hook would deadlock (the save transaction is paused waiting on the hook, which would
  // be waiting on a lock the paused save transaction itself holds) rather than construct the race.
  // These two tests now use a raw bypass DELETE (the same statement `clearApprovalFormDraft` used
  // to issue, run directly against the pool with no lock) standing in for the class of unlocked
  // writer this 409 path still has to defend against — currently `sweepExpiredApprovalFormDrafts`,
  // which deliberately remains lock-free (see its own comment) since it is a global, not per-user,
  // operation. The NEW interleaving `clearApprovalFormDraft` itself can no longer be raced into is
  // covered separately below ("FIX P3-D").
  // ===============================================================================================
  describe('FIX 4: concurrent clear/save interleaving is a clean conflict, not a TypeError, and commits nothing extra', () => {
    /** Patches the raw pg.Pool's `connect()` so the FIRST client it hands out afterward has its
     *  `query` wrapped: the very next call whose SQL text matches the upsert's existence-check
     *  SELECT triggers `onSelect` (awaited) before the SELECT's result is returned to the caller —
     *  i.e. `onSelect` runs exactly between that SELECT and whatever the caller does next (here,
     *  the UPDATE). Returns a restore function; callers MUST call it in a `finally`. */
    function interleaveAfterExistenceSelect(onSelect: () => Promise<void>): () => void {
      const rawPool = poolManager.get().getInternalPool()
      const originalConnect = rawPool.connect.bind(rawPool)
      let patchedOneClient = false
      ;(rawPool as unknown as { connect: unknown }).connect = async (...args: unknown[]) => {
        const client = await (originalConnect as unknown as (...a: unknown[]) => Promise<{ query: unknown }>)(...args)
        if (!patchedOneClient) {
          patchedOneClient = true
          const originalClientQuery = (client.query as (...a: unknown[]) => Promise<unknown>).bind(client)
          let fired = false
          ;(client as unknown as { query: unknown }).query = async (...qargs: unknown[]) => {
            const result = await originalClientQuery(...qargs)
            const sqlText = typeof qargs[0] === 'string' ? qargs[0] : (qargs[0] as { text?: string } | undefined)?.text
            if (!fired && typeof sqlText === 'string' && sqlText.includes('SELECT id FROM approval_form_drafts WHERE user_id')) {
              fired = true
              await onSelect()
            }
            return result
          }
        }
        return client
      }
      return () => {
        ;(rawPool as unknown as { connect: unknown }).connect = originalConnect
      }
    }

    it('a same-(user,template) DELETE landing between the SELECT and the UPDATE surfaces as a clean ApprovalFormDraftConflictError, not a TypeError, and the losing save commits NOTHING (no prune, no partial write — row count reflects only the interleaved clear)', async () => {
      const userId = trackUser(freshId('p33-d4-race'))
      const templateId = freshId('tmpl')

      // Seed an existing draft so the SECOND save below takes the UPDATE branch (existingId
      // truthy) — the branch where the gate's PROBE-A found the TypeError.
      await saveApprovalFormDraft({ userId, templateId, signature: 'sig-1', data: { v: 1 } })
      const before = await pool().query(`SELECT count(*)::int AS c FROM approval_form_drafts WHERE user_id = $1`, [userId])
      expect((before.rows[0] as { c: number }).c).toBe(1)

      const restore = interleaveAfterExistenceSelect(async () => {
        // A SEPARATE connection performs a raw, unlocked DELETE (standing in for
        // `sweepExpiredApprovalFormDrafts` or any other unlocked writer — see the describe block's
        // own header comment for why this is no longer `clearApprovalFormDraft` itself) WHILE the
        // save's transaction is paused between its SELECT and its UPDATE — no advisory lock, so
        // this commits immediately and independently of the save's still-open transaction.
        await pool().query(`DELETE FROM approval_form_drafts WHERE user_id = $1 AND template_id = $2`, [userId, templateId])
      })
      let caught: unknown = null
      try {
        await saveApprovalFormDraft({ userId, templateId, signature: 'sig-2', data: { v: 2 } })
      } catch (error) {
        caught = error
      } finally {
        restore()
      }

      expect(caught).toBeInstanceOf(ApprovalFormDraftConflictError)
      expect((caught as { code?: string } | null)?.code).toBe('APPROVAL_FORM_DRAFT_CONFLICT')
      expect(caught).not.toBeInstanceOf(TypeError)

      const after = await pool().query(`SELECT count(*)::int AS c FROM approval_form_drafts WHERE user_id = $1`, [userId])
      expect((after.rows[0] as { c: number }).c).toBe(0) // ONLY the interleaved clear's effect — the losing save wrote nothing
    })

    it('the SAME interleaving surfaces through the HTTP route as a values-free 409 (never a raw 500/TypeError)', async () => {
      const userId = trackUser(freshId('p33-d4-race-http'))
      const templateId = freshId('tmpl')
      const token = await authToken(baseUrl, userId)
      await saveApprovalFormDraft({ userId, templateId, signature: 'sig-1', data: { v: 1 } })

      const restore = interleaveAfterExistenceSelect(async () => {
        // Raw, unlocked DELETE — see the describe block's header comment for why this is no longer
        // `clearApprovalFormDraft` itself.
        await pool().query(`DELETE FROM approval_form_drafts WHERE user_id = $1 AND template_id = $2`, [userId, templateId])
      })
      let res: Response
      try {
        res = await draftPut(templateId, token, { signature: 'sig-2', data: { v: 2 } })
      } finally {
        restore()
      }

      expect(res.status).toBe(409)
      const raw = await res.text()
      expect(raw).not.toContain('TypeError')
      const parsed = JSON.parse(raw) as { ok: boolean; error?: { code?: string } }
      expect(parsed.ok).toBe(false)
      expect(parsed.error?.code).toBe('APPROVAL_FORM_DRAFT_CONFLICT')
    })
  })

  // ===============================================================================================
  // FIX P3-D (gate2) — the "reverse interleaving" the gate disclosed: `clearApprovalFormDraft` used
  // to be able to commit its DELETE as a no-op (nothing existed yet) WHILE a save's transaction was
  // paused between its existence SELECT and its INSERT branch, and then that save's INSERT would
  // commit unhindered right after — net effect: a clear the user fired got silently undone by a
  // save that was already in flight. `clearApprovalFormDraft` now shares the SAME user-scoped
  // advisory lock the save transaction takes, so this constructs the SAME window and proves the
  // outcome flips: clear can no longer no-op past the save — it is forced to wait for the lock,
  // which the save is holding, so it only runs (and finds the row) AFTER the save fully commits.
  // ===============================================================================================
  describe('FIX P3-D (gate2): clear cannot interleave inside a save transaction\'s SELECT-then-INSERT window', () => {
    /** Same technique as `interleaveAfterExistenceSelect` above, but `onSelect` here is
     *  fire-and-forget from the hook's own point of view: it must NOT be awaited before the SELECT's
     *  result is returned to the save transaction, because `clearApprovalFormDraft` now needs the
     *  SAME advisory lock this save transaction is currently holding — awaiting it here would
     *  deadlock (the save transaction sits paused waiting on this hook, while the hook waits on a
     *  lock only the paused save transaction can release). The caller gets back both the restore
     *  function AND a way to observe the clear's own promise once it is kicked off. */
    function interleaveDuringInsertBranch(onSelect: () => void): () => void {
      const rawPool = poolManager.get().getInternalPool()
      const originalConnect = rawPool.connect.bind(rawPool)
      let patchedOneClient = false
      ;(rawPool as unknown as { connect: unknown }).connect = async (...args: unknown[]) => {
        const client = await (originalConnect as unknown as (...a: unknown[]) => Promise<{ query: unknown }>)(...args)
        if (!patchedOneClient) {
          patchedOneClient = true
          const originalClientQuery = (client.query as (...a: unknown[]) => Promise<unknown>).bind(client)
          let fired = false
          ;(client as unknown as { query: unknown }).query = async (...qargs: unknown[]) => {
            const result = await originalClientQuery(...qargs)
            const sqlText = typeof qargs[0] === 'string' ? qargs[0] : (qargs[0] as { text?: string } | undefined)?.text
            if (!fired && typeof sqlText === 'string' && sqlText.includes('SELECT id FROM approval_form_drafts WHERE user_id')) {
              fired = true
              onSelect() // NOT awaited -- let the save's SELECT resolve and proceed toward INSERT
            }
            return result
          }
        }
        return client
      }
      return () => {
        ;(rawPool as unknown as { connect: unknown }).connect = originalConnect
      }
    }

    it('a clear issued WHILE a first-time save transaction is between its existence-SELECT (finds nothing) and its INSERT waits for the shared lock, then deletes the row the save just committed -- the draft ends up CLEARED (not resurrected), and neither call throws', async () => {
      const userId = trackUser(freshId('p33-gate2-p3d-insert-race'))
      const templateId = freshId('tmpl')

      // Sanity: nothing exists yet for this (user, template) -- the save below MUST take the INSERT
      // branch (existingId falsy), which is the branch this race is about.
      const preCount = await pool().query(`SELECT count(*)::int AS c FROM approval_form_drafts WHERE user_id = $1 AND template_id = $2`, [userId, templateId])
      expect((preCount.rows[0] as { c: number }).c).toBe(0)

      let clearPromise: Promise<void> = Promise.resolve()
      const restore = interleaveDuringInsertBranch(() => {
        // Fired the instant the save's existence-SELECT resolves (existingId will be undefined --
        // nothing exists yet). This clear now needs the SAME advisory lock the save's transaction
        // already holds, so it cannot even attempt its DELETE until the save's transaction commits.
        clearPromise = clearApprovalFormDraft(userId, templateId)
      })

      let saved: Awaited<ReturnType<typeof saveApprovalFormDraft>> | undefined
      let saveError: unknown = null
      try {
        saved = await saveApprovalFormDraft({ userId, templateId, signature: 'sig-p3d', data: { v: 'first-save' } })
      } catch (error) {
        saveError = error
      } finally {
        restore()
      }
      await clearPromise // the deferred clear must have unblocked and run by now

      // The save itself must have succeeded normally -- asserted by VALUE, not merely "did not
      // throw" (a vacuous pass if nothing had run at all).
      expect(saveError).toBeNull()
      expect(saved?.templateId).toBe(templateId)
      expect(saved?.data).toEqual({ v: 'first-save' })

      // The delayed clear, having waited out the save's transaction, now finds and removes the row
      // the save just committed -- the draft ends up CLEARED, not resurrected.
      const after = await pool().query(`SELECT count(*)::int AS c FROM approval_form_drafts WHERE user_id = $1 AND template_id = $2`, [userId, templateId])
      expect((after.rows[0] as { c: number }).c).toBe(0)
    })
  })

  // ===============================================================================================
  // E — per-user row cap: enforced by prune-on-write, and self-healing.
  // ===============================================================================================
  describe('E: row cap is enforced and self-healing (prune-on-write)', () => {
    it(`writing N-1 (${APPROVAL_FORM_DRAFT_MAX_ROWS_PER_USER - 1}) distinct-template drafts prunes NOTHING (negative control)`, async () => {
      const userId = trackUser(freshId('p33-e-under'))
      const n = APPROVAL_FORM_DRAFT_MAX_ROWS_PER_USER
      for (let i = 0; i < n - 1; i += 1) {
        await saveApprovalFormDraft({ userId, templateId: `tmpl-${i}`, signature: 'sig', data: { i } })
      }
      const countRes = await pool().query(`SELECT count(*)::int AS c FROM approval_form_drafts WHERE user_id = $1`, [userId])
      expect((countRes.rows[0] as { c: number }).c).toBe(n - 1)
    })

    it(`writing N+3 distinct-template drafts sequentially stabilizes at exactly N=${APPROVAL_FORM_DRAFT_MAX_ROWS_PER_USER}`, async () => {
      const userId = trackUser(freshId('p33-e-over'))
      const n = APPROVAL_FORM_DRAFT_MAX_ROWS_PER_USER
      for (let i = 0; i < n + 3; i += 1) {
        await saveApprovalFormDraft({ userId, templateId: `tmpl-${i}`, signature: 'sig', data: { i } })
        const countRes = await pool().query(`SELECT count(*)::int AS c FROM approval_form_drafts WHERE user_id = $1`, [userId])
        expect((countRes.rows[0] as { c: number }).c).toBeLessThanOrEqual(n)
      }
      const finalCount = await pool().query(`SELECT count(*)::int AS c FROM approval_form_drafts WHERE user_id = $1`, [userId])
      expect((finalCount.rows[0] as { c: number }).c).toBe(n)
    })

    it('SELF-HEALING: directly inserting N+5 rows (bypassing the service) then writing ONCE through the service lands back at exactly N', async () => {
      const userId = trackUser(freshId('p33-e-heal'))
      const n = APPROVAL_FORM_DRAFT_MAX_ROWS_PER_USER
      // Bulk-insert N+5 rows directly, each with an explicit OLD, distinct timestamp (oldest first,
      // 1..N+5 hours back — comfortably older than the write that follows but nowhere near the
      // TTL_HOURS=720 sweep boundary, so this exercises ordinary self-healing on a realistic
      // population, not a population that happens to also be TTL-expired) so there is no tie with
      // the subsequent real write and no ambiguity about which rows are "older" than it.
      for (let i = 0; i < n + 5; i += 1) {
        await pool().query(
          `INSERT INTO approval_form_drafts (id, user_id, template_id, signature, data, saved_at)
           VALUES ($1, $2, $3, 'sig', '{}'::jsonb, now() - ($4 || ' hours')::interval)`,
          [`afd_direct_${userId}_${i}`, userId, `tmpl-direct-${i}`, String(n + 5 - i)],
        )
      }
      const preCount = await pool().query(`SELECT count(*)::int AS c FROM approval_form_drafts WHERE user_id = $1`, [userId])
      expect((preCount.rows[0] as { c: number }).c).toBe(n + 5)

      // ONE write through the service (a fresh template, newest by construction — now()).
      await saveApprovalFormDraft({ userId, templateId: 'tmpl-heal-final', signature: 'sig', data: { healed: true } })

      const postCount = await pool().query(`SELECT count(*)::int AS c FROM approval_form_drafts WHERE user_id = $1`, [userId])
      expect((postCount.rows[0] as { c: number }).c).toBe(n)

      // The just-written draft (unambiguously the newest — every directly-inserted row was
      // backdated) must be among the survivors.
      const survivorRes = await pool().query(
        `SELECT 1 FROM approval_form_drafts WHERE user_id = $1 AND template_id = 'tmpl-heal-final'`,
        [userId],
      )
      expect(survivorRes.rowCount).toBe(1)
    })

    it('cross-user isolation: a quiet user\'s OWN rows must not be evicted just because a busier user is writing (self-contained — asserts on row identity, not on residue left by earlier tests; NOTE: the gate\'s literal suggested remedy — "Y saves, X floods, assert Y untouched" with no further write from Y — does NOT discriminate here, because the outer DELETE stays scoped to the CURRENT WRITER\'s user_id even with the inner "keep" subquery\'s scope removed, so a busy X can never directly delete a quiet Y\'s rows; the failure only surfaces when Y writes AGAIN after being crowded out of a GLOBAL "newest N" ranking — that is what this test constructs)', async () => {
      const userY = trackUser(freshId('p33-e-cross-y'))
      const userX = trackUser(freshId('p33-e-cross-x'))
      const n = APPROVAL_FORM_DRAFT_MAX_ROWS_PER_USER

      // Y writes 3 drafts first — nowhere near her own N=20 cap.
      const yTemplateIds = ['tmpl-y-0', 'tmpl-y-1', 'tmpl-y-2']
      for (const templateId of yTemplateIds) {
        await saveApprovalFormDraft({ userId: userY, templateId, signature: 'sig', data: { templateId } })
      }
      // Force Y's 3 rows to be unambiguously OLD — do not rely on wall-clock ordering relative to
      // what X is about to write (the SELF-HEALING test above backdates for the identical reason).
      await pool().query(`UPDATE approval_form_drafts SET saved_at = now() - interval '2 hours' WHERE user_id = $1`, [userY])

      // X floods with N+3 drafts, AFTER Y — a correctly per-user-scoped prune never lets X's
      // activity affect Y at all. Under the M1b mutation (inner "keep" subquery's user_id scope
      // dropped), X's own rows come to dominate any GLOBAL "newest N" ranking.
      for (let i = 0; i < n + 3; i += 1) {
        await saveApprovalFormDraft({ userId: userX, templateId: `tmpl-x-${i}`, signature: 'sig', data: { i } })
      }

      // Y writes ONE more draft. This is what triggers Y's OWN prune call (outer DELETE scoped to
      // user_id = Y). Under correct code, Y's per-user "keep" set is computed from Y's OWN rows
      // only, so all 4 of Y's rows (3 old + 1 new, well under her cap of 20) survive. Under M1b,
      // the "keep" set is the GLOBAL newest-20 — Y's 3 backdated rows are now the OLDEST rows in
      // the entire table (X's 23 rows are all newer), so none of them appear in the global top-20,
      // and Y's own outer-scoped DELETE removes all 3, leaving only the row she just wrote.
      await saveApprovalFormDraft({ userId: userY, templateId: 'tmpl-y-3', signature: 'sig', data: { fourth: true } })

      const yRows = await pool().query(
        `SELECT template_id FROM approval_form_drafts WHERE user_id = $1`,
        [userY],
      )
      const yTemplates = (yRows.rows as Array<{ template_id: string }>).map((r) => r.template_id).sort()
      expect(yTemplates).toEqual([...yTemplateIds, 'tmpl-y-3'].sort())

      // Positive control: X's own cap is still enforced normally (the harness can detect a real
      // over-cap condition — this isn't a test that would pass no matter what).
      const xCount = await pool().query(`SELECT count(*)::int AS c FROM approval_form_drafts WHERE user_id = $1`, [userX])
      expect((xCount.rows[0] as { c: number }).c).toBe(n)
    })

    it('re-running the prune query against an already-pruned set is a no-op (idempotent convergence — the mechanism the race-freeness argument relies on)', async () => {
      const userId = trackUser(freshId('p33-e-idem'))
      const n = APPROVAL_FORM_DRAFT_MAX_ROWS_PER_USER
      for (let i = 0; i < n; i += 1) {
        await saveApprovalFormDraft({ userId, templateId: `tmpl-idem-${i}`, signature: 'sig', data: { i } })
      }
      const before = await pool().query(`SELECT id FROM approval_form_drafts WHERE user_id = $1 ORDER BY id`, [userId])
      // Re-run the exact same prune DELETE the service issues, a second time.
      await pool().query(
        `DELETE FROM approval_form_drafts
          WHERE user_id = $1
            AND id NOT IN (SELECT id FROM approval_form_drafts WHERE user_id = $1 ORDER BY saved_at DESC, id DESC LIMIT $2)`,
        [userId, n],
      )
      const after = await pool().query(`SELECT id FROM approval_form_drafts WHERE user_id = $1 ORDER BY id`, [userId])
      expect(after.rows).toEqual(before.rows)
    })
  })

  // ===============================================================================================
  // F — per-draft payload cap, two layers (service threshold strictly below the DB CHECK).
  // ===============================================================================================
  describe('F: payload size cap — two layers', () => {
    it('COMPLIANT payload passes the service AND lands under the DB CHECK bound (positive control for both layers)', async () => {
      const userId = trackUser(freshId('p33-f-ok'))
      const templateId = freshId('tmpl')
      const data = { note: 'x'.repeat(1000) }
      const draft = await saveApprovalFormDraft({ userId, templateId, signature: 'sig', data })
      expect(draft.data).toEqual(data)
      const row = await pool().query(`SELECT octet_length(data::text)::int AS n FROM approval_form_drafts WHERE user_id = $1 AND template_id = $2`, [userId, templateId])
      expect((row.rows[0] as { n: number }).n).toBeLessThanOrEqual(APPROVAL_FORM_DRAFT_LIMITS.maxPayloadBytes)
    })

    it('a payload INSIDE THE SAFETY MARGIN — over the service threshold but still under the DB CHECK bound — is rejected by the SERVICE, not silently passed through to the DB (proves the margin is real, not decorative)', async () => {
      const userId = trackUser(freshId('p33-f-service-reject'))
      const templateId = freshId('tmpl')
      // Build a JSON string sized to land strictly between the two bounds: bigger than
      // maxServicePayloadBytes (258048) but smaller than the DB CHECK's maxPayloadBytes (262144).
      // This is the discriminating band: the mutation probe on this test (disable the service
      // check) makes the write SUCCEED, not bounce off the DB CHECK — because this size is still
      // comfortably inside what the CHECK alone would allow.
      const bloatSize = APPROVAL_FORM_DRAFT_LIMITS.maxServicePayloadBytes + 1024
      expect(bloatSize).toBeLessThan(APPROVAL_FORM_DRAFT_LIMITS.maxPayloadBytes) // sanity: still inside the margin, not past the DB bound
      const bloat = 'x'.repeat(bloatSize)
      await expect(
        saveApprovalFormDraft({ userId, templateId, signature: 'sig', data: { bloat } }),
      ).rejects.toMatchObject({ code: 'APPROVAL_FORM_DRAFT_TOO_LARGE' })
      const countRes = await pool().query(`SELECT count(*)::int AS c FROM approval_form_drafts WHERE user_id = $1`, [userId])
      expect((countRes.rows[0] as { c: number }).c).toBe(0) // rejected before any write
    })

    it('bypassing the service with a direct INSERT over the DB bound is rejected by the CHECK constraint (23514)', async () => {
      const userId = trackUser(freshId('p33-f-db-reject'))
      const bloat = 'x'.repeat(APPROVAL_FORM_DRAFT_LIMITS.maxPayloadBytes + 1024)
      await expect(
        pool().query(
          `INSERT INTO approval_form_drafts (id, user_id, template_id, signature, data)
           VALUES ($1, $2, 'tmpl-db-bypass', 'sig', $3::jsonb)`,
          [`afd_bypass_${userId}`, userId, JSON.stringify({ bloat })],
        ),
      ).rejects.toMatchObject({ code: '23514' })
    })
  })

  // ===============================================================================================
  // FIX 5 (gate P3-5) — `signature` cap, two layers (mirrors the payload cap above; `signature`
  // previously had NO bound at all).
  // ===============================================================================================
  describe('signature size cap — two layers (FIX 5, gate P3-5)', () => {
    it('a COMPLIANT signature passes the service AND lands under the DB CHECK bound (positive control for both layers)', async () => {
      const userId = trackUser(freshId('p33-sig-ok'))
      const templateId = freshId('tmpl')
      const signature = 'x'.repeat(200) // realistic size for an id:type|... join
      const draft = await saveApprovalFormDraft({ userId, templateId, signature, data: { a: 1 } })
      expect(draft.signature).toBe(signature)
      const row = await pool().query(`SELECT octet_length(signature)::int AS n FROM approval_form_drafts WHERE user_id = $1 AND template_id = $2`, [userId, templateId])
      expect((row.rows[0] as { n: number }).n).toBeLessThanOrEqual(APPROVAL_FORM_DRAFT_SIGNATURE_LIMITS.maxSignatureBytes)
    })

    it('a signature INSIDE THE SAFETY MARGIN — over the service threshold but still under the DB CHECK bound — is rejected by the SERVICE, not silently passed through to the DB (proves the margin is real, not decorative)', async () => {
      const userId = trackUser(freshId('p33-sig-service-reject'))
      const templateId = freshId('tmpl')
      const bloatSize = APPROVAL_FORM_DRAFT_SIGNATURE_LIMITS.maxServiceSignatureBytes + 32
      expect(bloatSize).toBeLessThan(APPROVAL_FORM_DRAFT_SIGNATURE_LIMITS.maxSignatureBytes) // sanity: still inside the margin
      const signature = 'x'.repeat(bloatSize)
      await expect(
        saveApprovalFormDraft({ userId, templateId, signature, data: { a: 1 } }),
      ).rejects.toMatchObject({ code: 'APPROVAL_FORM_DRAFT_TOO_LARGE' })
      const countRes = await pool().query(`SELECT count(*)::int AS c FROM approval_form_drafts WHERE user_id = $1`, [userId])
      expect((countRes.rows[0] as { c: number }).c).toBe(0) // rejected before any write
    })

    it('bypassing the service with a direct INSERT of an over-bound signature is rejected by the CHECK constraint (23514)', async () => {
      const userId = trackUser(freshId('p33-sig-db-reject'))
      const signature = 'x'.repeat(APPROVAL_FORM_DRAFT_SIGNATURE_LIMITS.maxSignatureBytes + 1024)
      await expect(
        pool().query(
          `INSERT INTO approval_form_drafts (id, user_id, template_id, signature, data)
           VALUES ($1, $2, 'tmpl-sig-db-bypass', $3, '{}'::jsonb)`,
          [`afd_sigbypass_${userId}`, userId, signature],
        ),
      ).rejects.toMatchObject({ code: '23514' })
    })

    it('bypassing the service with a direct INSERT of a whitespace-only signature is rejected by the non-blank CHECK constraint (23514)', async () => {
      const userId = trackUser(freshId('p33-sig-blank-reject'))
      await expect(
        pool().query(
          `INSERT INTO approval_form_drafts (id, user_id, template_id, signature, data)
           VALUES ($1, $2, 'tmpl-sig-blank', '   ', '{}'::jsonb)`,
          [`afd_sigblank_${userId}`, userId],
        ),
      ).rejects.toMatchObject({ code: '23514' })
    })
  })

  // ===============================================================================================
  // Empty-data DELETE (client decides PUT-vs-DELETE — see the service module's own docblock for why
  // this is single-sided; this proves the DELETE side of that contract server-side).
  // ===============================================================================================
  describe('empty-draft clear (server half of the client\'s "meaningful ⇒ save, else delete" contract)', () => {
    it('DELETE removes an existing draft; a subsequent GET returns null', async () => {
      const userId = trackUser(freshId('p33-clear'))
      const templateId = freshId('tmpl')
      const tokenA = await authToken(baseUrl, userId)
      await draftPut(templateId, tokenA, { signature: 'sig', data: { a: 1 } })
      const del = await draftDelete(templateId, tokenA)
      expect(del.status).toBe(204)
      const after = await draftGet(templateId, tokenA)
      const body = (await after.json()) as { data: { draft: unknown } }
      expect(body.data.draft).toBeNull()
    })
  })

  // ===============================================================================================
  // TTL sweep function (constant + function, mirrors sweepUnboundAttachments; NOT wired to a timer
  // in this slice — see the service module's own docblock).
  // ===============================================================================================
  describe('TTL sweep (constant + function, not a DB auto-expiry)', () => {
    it('sweeps rows older than the TTL and leaves fresh rows untouched', async () => {
      const userId = trackUser(freshId('p33-ttl'))
      await pool().query(
        `INSERT INTO approval_form_drafts (id, user_id, template_id, signature, data, saved_at)
         VALUES ($1, $2, 'tmpl-old', 'sig', '{}'::jsonb, now() - ($3 || ' hours')::interval)`,
        [`afd_ttl_old_${userId}`, userId, String(APPROVAL_FORM_DRAFT_TTL_HOURS + 1)],
      )
      await saveApprovalFormDraft({ userId, templateId: 'tmpl-fresh', signature: 'sig', data: { fresh: true } })

      const result = await sweepExpiredApprovalFormDrafts(pool())
      expect(result.swept).toBeGreaterThanOrEqual(1)

      const remaining = await pool().query(`SELECT template_id FROM approval_form_drafts WHERE user_id = $1`, [userId])
      const templateIds = (remaining.rows as Array<{ template_id: string }>).map((r) => r.template_id)
      expect(templateIds).toContain('tmpl-fresh')
      expect(templateIds).not.toContain('tmpl-old')
    })
  })

  // ===============================================================================================
  // FIX 6 (gate P3-1) — re-run the gate's exact concurrency construction (same user, DIFFERENT
  // templates, concurrent saves) now that the advisory lock is USER-scoped. The gate measured
  // N+1=21 surviving rows under the OLD (user,template)-scoped lock across 25 and 40 rounds; this
  // reruns the same shape and asserts <= N (not just "usually <= N").
  // ===============================================================================================
  describe('FIX 6: user-scoped advisory lock makes the row cap exact under same-user, different-template concurrency', () => {
    it('CONSTRUCTED CONCURRENCY: filling to N then racing many DIFFERENT-template saves for the SAME user, repeated over many rounds, never exceeds N (gate measured N+1=21 under the old lock scope)', async () => {
      const userId = trackUser(freshId('p33-fix6-concurrency'))
      const n = APPROVAL_FORM_DRAFT_MAX_ROWS_PER_USER
      // Fill to exactly N sequentially first (matches the gate's PROBE-B/C setup).
      for (let i = 0; i < n; i += 1) {
        await saveApprovalFormDraft({ userId, templateId: `tmpl-fill-${i}`, signature: 'sig', data: { i } })
      }
      const ROUNDS = 25
      const CONCURRENCY = 4 // matches the gate's PROBE-C four-way concurrent shape
      let maxObserved = 0
      for (let round = 0; round < ROUNDS; round += 1) {
        await Promise.all(
          Array.from({ length: CONCURRENCY }, (_, k) =>
            saveApprovalFormDraft({
              userId,
              templateId: `tmpl-race-${round}-${k}`,
              signature: 'sig',
              data: { round, k },
            }),
          ),
        )
        const countRes = await pool().query(`SELECT count(*)::int AS c FROM approval_form_drafts WHERE user_id = $1`, [userId])
        const count = (countRes.rows[0] as { c: number }).c
        maxObserved = Math.max(maxObserved, count)
      }
      // Measured (report this number, not "impossible"): with the user-scoped lock, this was
      // observed to stay AT exactly N across all 25 rounds x 4-way concurrency — never N+1.
      // eslint-disable-next-line no-console
      console.log(`[FIX 6] max row count observed across ${ROUNDS} rounds x ${CONCURRENCY}-way concurrency: ${maxObserved} (cap N=${n})`)
      expect(maxObserved).toBeLessThanOrEqual(n)
    })
  })
})
