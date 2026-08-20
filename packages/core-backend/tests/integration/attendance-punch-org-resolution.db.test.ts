/**
 * Route-level coverage for the punch route's membership-derived org resolution
 * (plugins/plugin-attendance/lib/attendance-punch-org-resolution.cjs, wired into
 * POST /api/attendance/punch in plugins/plugin-attendance/index.cjs). Boots a
 * real MetaSheetServer with the real plugin and drives the real route end to
 * end against real PostgreSQL — this proves the ROUTE actually calls the
 * resolver and obeys its verdict, not just that the resolver's own decision
 * logic is correct in isolation (that is covered, without a database, by
 * tests/unit/attendance-punch-org-resolution.test.ts).
 *
 * Cases (each uses its own user so no case's punch can trip another case's
 * min-punch-interval guard, and so cleanup is exact per case):
 *   a.   member of org A only, no orgId in body             -> 200, org A
 *   b.   member of org A only, body.orgId = A                -> 200, org A (positive control for c)
 *   c.   member of org A only, body.orgId = B (not a member) -> 403 ATTENDANCE_PUNCH_ORG_NOT_PERMITTED,
 *        zero attendance_records rows for that user under B, before and after
 *   c-null. same as (c) but the legacy NULL-operationId request shape — the discriminating
 *        case: that shape never enters the operation-registry preflight, so on unmodified
 *        `main` it had NO org-membership enforcement anywhere.
 *   d.   member of A and B, no orgId                         -> 400 ATTENDANCE_PUNCH_ORG_REQUIRED;
 *        same user with body.orgId = B                       -> 200, org B
 *   e-1. zero memberships, no orgId, called directly against the resolver -> the exact
 *        `legacyOrgId` the route passes in (the value `getOrgId(req)` already resolves)
 *   e-2. zero memberships, no orgId, through the real route -> BEHAVIORALLY INERT: the same
 *        outcome unmodified `main` already produces (a pre-existing, unrelated downstream
 *        write-boundary membership recheck rejects the write — see e-2's own comment). This
 *        is the documented residual: zero-membership callers keep today's resolution, not a
 *        new success and not a new (ATTENDANCE_PUNCH_ORG_*-coded) rejection.
 *
 * Shared-DB discipline: every fixture id is a file-namespaced random UUID.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as path from 'node:path'
import net from 'net'
import http from 'http'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'crypto'
import { createRequire } from 'node:module'
import { Pool } from 'pg'
import type { MetaSheetServer } from '../../src/index'

const require = createRequire(import.meta.url)
const { resolvePunchOrgIdV1 } = require(
  '../../../../plugins/plugin-attendance/lib/attendance-punch-org-resolution.cjs',
) as {
  resolvePunchOrgIdV1: (
    db: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> },
    req: Record<string, unknown>,
    legacyOrgId: string,
  ) => Promise<Record<string, unknown>>
}

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip
const HERE = path.dirname(fileURLToPath(import.meta.url))

type HttpResponse = { status: number; body?: any; raw: string }
function requestJson(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = http.request(
      {
        method: options.method || 'GET',
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: options.headers,
      },
      (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
        res.on('end', () => {
          let body: unknown
          try { body = data ? JSON.parse(data) : undefined } catch { body = undefined }
          resolve({ status: res.statusCode || 0, body, raw: data })
        })
      },
    )
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

describeDb('POST /api/attendance/punch — membership-derived org resolution', () => {
  let server: MetaSheetServer | undefined
  let pool: Pool
  let baseUrl = ''
  let priorRbacBypass: string | undefined
  let priorSkipPlugins: string | undefined

  const orgA = randomUUID()
  const orgB = randomUUID()
  const userA1 = randomUUID() // case a: member of A only, no orgId
  const userA2 = randomUUID() // case b: member of A only, body.orgId=A (positive control)
  const userA3 = randomUUID() // case c: member of A only, body.orgId=B (not a member)
  const userA4 = randomUUID() // case c-null: same as c, but the legacy null-operationId path
  const userAB = randomUUID() // case d: member of A and B
  const userZero = randomUUID() // case e: zero memberships

  const allUserIds = [userA1, userA2, userA3, userA4, userAB, userZero]

  const mintToken = async (userId: string): Promise<string> => {
    const res = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('attendance:read,attendance:write,attendance:admin')}`,
    )
    return (res.body as { token?: string } | undefined)?.token ?? ''
  }

  async function insertUser(userId: string): Promise<void> {
    await pool.query(
      `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
       VALUES ($1, $2, $1, 'punch org resolution fixture', 'x', 'user', '[]'::jsonb, true, false, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@punch-org-resolution.test`],
    )
  }

  async function addMembership(userId: string, orgId: string): Promise<void> {
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`,
      [userId, orgId],
    )
  }

  const punch = async (userId: string, orgId?: string) =>
    requestJson(`${baseUrl}/api/attendance/punch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await mintToken(userId)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        eventType: 'check_in',
        operationId: randomUUID(),
        ...(orgId ? { orgId } : {}),
      }),
    })

  // Deliberately omits `operationId` — the legacy null-ID punch shape. Before this change,
  // the org-membership recheck downstream (packages/core-backend/src/attendance/
  // w4c0-authorization.ts's `requireActiveMembership`) ran only inside the operation-registry
  // preflight, which the null-ID path never enters — so this shape previously had NO
  // org-membership enforcement anywhere. This resolver is the first membership check that
  // applies uniformly to both request shapes; case (c-null) below is the discriminating proof.
  const punchNullOperationId = async (userId: string, orgId?: string) =>
    requestJson(`${baseUrl}/api/attendance/punch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await mintToken(userId)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        eventType: 'check_in',
        ...(orgId ? { orgId } : {}),
      }),
    })

  const recordOrgIdsFor = async (userId: string): Promise<string[]> =>
    (
      await pool.query(`SELECT org_id FROM attendance_records WHERE user_id = $1`, [userId])
    ).rows.map((row: { org_id: string }) => row.org_id)

  const recordCountFor = async (userId: string, orgId: string): Promise<number> =>
    Number(
      (
        await pool.query(
          `SELECT COUNT(*)::int AS total FROM attendance_records WHERE user_id = $1 AND org_id = $2`,
          [userId, orgId],
        )
      ).rows[0]?.total ?? 0,
    )

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen || !dbUrl) throw new Error('suite needs loopback + DATABASE_URL')

    priorRbacBypass = process.env.RBAC_BYPASS
    priorSkipPlugins = process.env.SKIP_PLUGINS
    process.env.DATABASE_URL = dbUrl
    process.env.RBAC_BYPASS = 'true'
    process.env.SKIP_PLUGINS = 'false'

    const repoRoot = path.join(HERE, '../../../../')
    const { MetaSheetServer: Server } = await import('../../src/index')
    server = new Server({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')],
    })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('no TCP address')
    baseUrl = `http://127.0.0.1:${address.port}`
    pool = new Pool({ connectionString: dbUrl })

    for (const userId of allUserIds) {
      await insertUser(userId)
    }
    await addMembership(userA1, orgA)
    await addMembership(userA2, orgA)
    await addMembership(userA3, orgA)
    await addMembership(userA4, orgA)
    await addMembership(userAB, orgA)
    await addMembership(userAB, orgB)
    // userZero deliberately gets NO user_orgs row — the zero-membership case.
  }, 180_000)

  afterAll(async () => {
    for (const table of ['attendance_record_segments', 'attendance_record_calculations', 'attendance_records', 'attendance_events']) {
      await pool?.query(`DELETE FROM ${table} WHERE user_id = ANY($1::text[])`, [allUserIds]).catch(() => undefined)
    }
    await pool?.query(`DELETE FROM user_orgs WHERE user_id = ANY($1::text[])`, [allUserIds]).catch(() => undefined)
    await pool?.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [allUserIds]).catch(() => undefined)
    await pool?.end()
    await server?.stop?.()
    if (priorRbacBypass === undefined) delete process.env.RBAC_BYPASS
    else process.env.RBAC_BYPASS = priorRbacBypass
    if (priorSkipPlugins === undefined) delete process.env.SKIP_PLUGINS
    else process.env.SKIP_PLUGINS = priorSkipPlugins
  }, 60_000)

  it('(a) member of org A, no orgId in body -> punch recorded under org A', async () => {
    const res = await punch(userA1)
    expect(res.status).toBe(200)
    expect(await recordOrgIdsFor(userA1)).toEqual([orgA])
  })

  it('(b) member of org A, body.orgId = A -> 200, org A (positive control for case c)', async () => {
    const res = await punch(userA2, orgA)
    expect(res.status).toBe(200)
    expect(await recordOrgIdsFor(userA2)).toEqual([orgA])
  })

  it('(c) member of org A, body.orgId = B (exists, not a member) -> 403, zero writes under B', async () => {
    expect(await recordCountFor(userA3, orgB)).toBe(0)
    const res = await punch(userA3, orgB)
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ ok: false, error: { code: 'ATTENDANCE_PUNCH_ORG_NOT_PERMITTED' } })
    expect(await recordCountFor(userA3, orgB)).toBe(0)
    expect(await recordOrgIdsFor(userA3)).toEqual([])
  })

  it('(c-null) same as (c) but the legacy null-operationId shape: 403, zero writes under B; the null-ID path into A still succeeds (positive control)', async () => {
    // This is the discriminating case for the whole change: the null-operationId path
    // never enters the operation-registry preflight, so on unmodified `main` this exact
    // request (member of A, body.orgId=B, no operationId) had NO org-membership check at
    // all and would resolve org B via `getOrgId(req)` at face value.
    const refused = await punchNullOperationId(userA4, orgB)
    expect(refused.status).toBe(403)
    expect(refused.body).toEqual({ ok: false, error: { code: 'ATTENDANCE_PUNCH_ORG_NOT_PERMITTED' } })
    expect(await recordCountFor(userA4, orgB)).toBe(0)

    const accepted = await punchNullOperationId(userA4, orgA)
    expect(accepted.status).toBe(200)
    expect(await recordOrgIdsFor(userA4)).toEqual([orgA])
  })

  it('(d) member of A and B, no orgId -> 400 ATTENDANCE_PUNCH_ORG_REQUIRED; body.orgId=B -> 200, org B', async () => {
    const ambiguous = await punch(userAB)
    expect(ambiguous.status).toBe(400)
    expect(ambiguous.body).toEqual({ ok: false, error: { code: 'ATTENDANCE_PUNCH_ORG_REQUIRED' } })
    expect(await recordOrgIdsFor(userAB)).toEqual([])

    const disambiguated = await punch(userAB, orgB)
    expect(disambiguated.status).toBe(200)
    expect(await recordOrgIdsFor(userAB)).toEqual([orgB])
  })

  it('(e-1) resolver itself: zero memberships, no orgId -> the caller-supplied legacy org id, byte-identical', async () => {
    // Direct, unconfounded proof of rule 3's fallback leg: call the resolver the SAME way the
    // route does, with the SAME db handle, for a user this suite deliberately gave no
    // `user_orgs` row at all. `getOrgId(req)` on a request with no body/query orgId, no
    // x-org-id header, and no user.orgId/workspaceId always resolves to DEFAULT_ORG_ID
    // ('default') — that is the exact value the route passes in as `legacyOrgId`, so this
    // reproduces the route's own call shape without going through HTTP.
    const dbAdapter = { query: (sql: string, params?: unknown[]) => pool.query(sql, params).then((r) => r.rows) }
    const fakeReq = { user: { id: userZero }, body: {}, query: {}, headers: {} }
    const resolution = await resolvePunchOrgIdV1(dbAdapter, fakeReq, 'default')
    expect(resolution).toEqual({ ok: true, orgId: 'default' })
  })

  it('(e-2) route: zero memberships, no orgId -> behaviorally inert (matches the pre-existing outcome, not a new gate)', async () => {
    // The resolved org ('default', per e-1) is then fed into the SAME downstream write
    // boundary every other punch already goes through — and that boundary independently
    // requires the actor to hold an ACTIVE membership in the FINAL org before any DML
    // (packages/core-backend/src/attendance/w4c0-authorization.ts's `requireActiveMembership`,
    // untouched by this change). A caller with zero `user_orgs` rows anywhere already fails
    // that check today, on unmodified `main`, for the exact same reason and with the exact
    // same code (verified empirically against this suite's own fixtures before this change
    // existed) — this resolver does not change that outcome; it only changes WHICH org gets
    // checked when the caller supplies one the caller does not belong to (cases c/d above).
    // This case pins the residual as "byte-identical to before", not as "now succeeds": no
    // ATTENDANCE_PUNCH_ORG_* code appears here, and no attendance_records row is written.
    const res = await punch(userZero)
    expect(res.status).toBe(403)
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'ATTENDANCE_WRITE_NOT_AUTHORIZED', message: 'ATTENDANCE_WRITE_NOT_AUTHORIZED' },
    })
    expect(await recordOrgIdsFor(userZero)).toEqual([])
  })
})
