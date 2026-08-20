/**
 * Route-level coverage for the punch route's membership-derived org check
 * (plugins/plugin-attendance/lib/attendance-punch-org-resolution.cjs, wired into
 * POST /api/attendance/punch in plugins/plugin-attendance/index.cjs). Boots a
 * real MetaSheetServer with the real plugin and drives the real route end to
 * end against real PostgreSQL — this proves the ROUTE actually calls the
 * check and obeys its verdict, not just that the decision logic is correct
 * in isolation (that is covered, without a database, by
 * tests/unit/attendance-punch-org-resolution.test.ts).
 *
 * Cases (each uses its own user so no case's punch can trip another case's
 * min-punch-interval guard, and so cleanup is exact per case):
 *   a.   member of the default org (the common backfill shape — see the module doc for
 *        why an unscoped punch resolves there), no orgId in body -> the same org
 *        `getOrgId(req)` resolves today (200, unaffected by this check)
 *   b.   member of org A only, body.orgId = A                -> 200, org A (positive control for c)
 *   c.   member of org A only, body.orgId = B (not a member) -> 403 ATTENDANCE_PUNCH_ORG_NOT_PERMITTED,
 *        zero attendance_records rows for that user under B, before and after
 *   c-null. same as (c), on the request shape that omits `operationId` — this route's check
 *        applies identically on both request shapes.
 *   d / d-null. member of A and B, no orgId, on both request shapes -> the same org
 *        `getOrgId(req)` resolves today (this module does not run at all when no org is
 *        supplied); with body.orgId = B on either shape -> 200, under B.
 *   e / e-null. zero memberships, no orgId, on both request shapes -> the same outcome
 *        `getOrgId(req)`'s resolution already produces today, pinned honestly per shape
 *        (the two shapes reach different pre-existing downstream gates; this module changes
 *        neither, since it never runs when no org is supplied).
 *   f.   member of a mixed-case org id, body.orgId = the lowercase twin (not a member,
 *        differs only by case) -> 403; the exact-case string -> 200 (positive control) —
 *        pins that the membership comparison is exact-string, not case-insensitive.
 *
 * Shared-DB discipline: every fixture id is a file-namespaced random UUID.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as path from 'node:path'
import net from 'net'
import http from 'http'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'crypto'
import { Pool } from 'pg'
import type { MetaSheetServer } from '../../src/index'

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

describeDb('POST /api/attendance/punch — membership-derived org check', () => {
  let server: MetaSheetServer | undefined
  let pool: Pool
  let baseUrl = ''
  let priorRbacBypass: string | undefined
  let priorSkipPlugins: string | undefined

  const orgA = randomUUID()
  const orgB = randomUUID()
  // A free-form (non-UUID-shaped) org id — case (f) below uses the request shape that
  // omits `operationId`, which never enters the W4C2 canonical-org-key classifier or the
  // operation-registry's own (separately, UUID-canonicalizing) authorization layer, so
  // nothing downstream of this route's own check can confound the case-sensitivity result.
  const orgMixed = `Org-${randomUUID()}`

  const userA1 = randomUUID() // case a: member of the default org only, no orgId
  const userA2 = randomUUID() // case b: member of A only, body.orgId=A (positive control)
  const userA3 = randomUUID() // case c: member of A only, body.orgId=B (not a member)
  const userA4 = randomUUID() // case c-null: same as c, request shape without operationId
  const userD1 = randomUUID() // case d: member of A and B, operationId-present shape
  const userD2 = randomUUID() // case d-null: member of A and B, operationId-absent shape
  const userE1 = randomUUID() // case e: zero memberships, operationId-present shape
  const userE2 = randomUUID() // case e-null: zero memberships, operationId-absent shape
  const userF = randomUUID() // case f: member of a mixed-case org id

  const allUserIds = [userA1, userA2, userA3, userA4, userD1, userD2, userE1, userE2, userF]

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

  // The request shape that omits `operationId`. This route's org check applies identically
  // regardless of which shape a request uses; the two `punch*` helpers exist so every case
  // below can be run on both.
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
    await addMembership(userA1, 'default')
    await addMembership(userA2, orgA)
    await addMembership(userA3, orgA)
    await addMembership(userA4, orgA)
    await addMembership(userD1, orgA)
    await addMembership(userD1, orgB)
    await addMembership(userD2, orgA)
    await addMembership(userD2, orgB)
    await addMembership(userF, orgMixed)
    // userE1 / userE2 deliberately get NO user_orgs row — the zero-membership case.
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

  it("(a) member of the default org, no orgId in body -> the same org getOrgId(req) resolves today", async () => {
    // This module never runs when the request supplies no org — the route falls straight
    // back to getOrgId(req), which resolves to the default org for a request/token that
    // names no org at all (no body/query/header org, no tenant on the token). This user's
    // sole membership is that same default org (the shape the create-table migration's own
    // backfill produces for every pre-existing active user), so the punch succeeds exactly
    // as it did before this PR.
    const res = await punch(userA1)
    expect(res.status).toBe(200)
    expect(await recordOrgIdsFor(userA1)).toEqual(['default'])
  })

  it('(b) member of org A, body.orgId = A -> 200, org A (positive control for case c)', async () => {
    const res = await punch(userA2, orgA)
    expect(res.status).toBe(200)
    expect(await recordOrgIdsFor(userA2)).toEqual([orgA])
  })

  it('(c) member of org A, body.orgId = B (not a member) -> 403, zero writes under B', async () => {
    expect(await recordCountFor(userA3, orgB)).toBe(0)
    const res = await punch(userA3, orgB)
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ ok: false, error: { code: 'ATTENDANCE_PUNCH_ORG_NOT_PERMITTED' } })
    expect(await recordCountFor(userA3, orgB)).toBe(0)
    expect(await recordOrgIdsFor(userA3)).toEqual([])
  })

  it('(c-null) same as (c), on the request shape that omits operationId: 403, zero writes under B; the same shape into A still succeeds (positive control)', async () => {
    // This route's org check applies before any DML on both request shapes — the shape
    // without `operationId` is exercised explicitly here because it takes a different code
    // path once past this check (see the module doc for where the two shapes diverge
    // downstream).
    const refused = await punchNullOperationId(userA4, orgB)
    expect(refused.status).toBe(403)
    expect(refused.body).toEqual({ ok: false, error: { code: 'ATTENDANCE_PUNCH_ORG_NOT_PERMITTED' } })
    expect(await recordCountFor(userA4, orgB)).toBe(0)

    const accepted = await punchNullOperationId(userA4, orgA)
    expect(accepted.status).toBe(200)
    expect(await recordOrgIdsFor(userA4)).toEqual([orgA])
  })

  it('(d) member of A and B, no orgId, operationId-present shape -> the same outcome getOrgId(req)\'s resolution already produces today; body.orgId=B -> 200, org B', async () => {
    // This module never runs when the request supplies no org, so this leg is a pin of
    // TODAY'S unmodified outcome, not a new behavior. On this shape the resolved org feeds
    // into the pre-existing, unrelated operation-registry preflight (unchanged by this PR),
    // which independently requires the actor to hold an active membership in that SAME org —
    // this user's memberships are A and B, not the org getOrgId(req) resolves to when no org
    // is supplied, so that pre-existing check refuses the write with zero rows.
    const before = await recordOrgIdsFor(userD1)
    expect(before).toEqual([])
    const unscoped = await punch(userD1)
    expect(unscoped.status).toBe(403)
    expect(unscoped.body).toEqual({
      ok: false,
      error: { code: 'ATTENDANCE_WRITE_NOT_AUTHORIZED', message: 'ATTENDANCE_WRITE_NOT_AUTHORIZED' },
    })
    expect(await recordOrgIdsFor(userD1)).toEqual([])

    const scoped = await punch(userD1, orgB)
    expect(scoped.status).toBe(200)
    expect(await recordOrgIdsFor(userD1)).toEqual([orgB])
  })

  it('(d-null) member of A and B, no orgId, the request shape that omits operationId -> the same outcome getOrgId(req)\'s resolution already produces today; body.orgId=B -> 200, org B', async () => {
    // Same setup as (d), on the shape that omits operationId. That shape has no pre-existing
    // downstream membership check at all, so the punch simply lands under whatever
    // getOrgId(req) resolves to when no org is supplied — this pins that today's outcome
    // (a write, not a refusal) is unchanged by this PR.
    const unscoped = await punchNullOperationId(userD2)
    expect(unscoped.status).toBe(200)
    const unscopedOrgIds = await recordOrgIdsFor(userD2)
    expect(unscopedOrgIds).toHaveLength(1)
    expect(unscopedOrgIds[0]).not.toBe(orgA)
    expect(unscopedOrgIds[0]).not.toBe(orgB)

    const scoped = await punchNullOperationId(userD2, orgB)
    expect(scoped.status).toBe(200)
    expect(await recordOrgIdsFor(userD2)).toEqual(expect.arrayContaining([orgB]))
  })

  it('(e) zero memberships, no orgId, operationId-present shape -> the same outcome getOrgId(req)\'s resolution already produces today', async () => {
    // This module never runs when the request supplies no org. On this shape the resolved
    // org feeds into the pre-existing, unrelated operation-registry preflight (unchanged by
    // this PR), which requires an active membership in that org — this user has none
    // anywhere, so that pre-existing check refuses the write with zero rows, exactly as it
    // does today on unmodified `main`.
    const res = await punch(userE1)
    expect(res.status).toBe(403)
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'ATTENDANCE_WRITE_NOT_AUTHORIZED', message: 'ATTENDANCE_WRITE_NOT_AUTHORIZED' },
    })
    expect(await recordOrgIdsFor(userE1)).toEqual([])
  })

  it('(e-null) zero memberships, no orgId, the request shape that omits operationId -> the same outcome getOrgId(req)\'s resolution already produces today', async () => {
    // Same setup as (e), on the shape that omits operationId. That shape has no pre-existing
    // downstream membership check, so the punch writes under whatever getOrgId(req) resolves
    // to when no org is supplied — this pins that today's outcome (a write, not a refusal)
    // is unchanged by this PR.
    const res = await punchNullOperationId(userE2)
    expect(res.status).toBe(200)
    const orgIds = await recordOrgIdsFor(userE2)
    expect(orgIds).toHaveLength(1)
  })

  it('(f) member of a mixed-case org id: the lowercase twin (not a member) -> 403; the exact-case string -> 200 (positive control)', async () => {
    const twin = orgMixed.toLowerCase()
    expect(twin).not.toBe(orgMixed)

    const refused = await punchNullOperationId(userF, twin)
    expect(refused.status).toBe(403)
    expect(refused.body).toEqual({ ok: false, error: { code: 'ATTENDANCE_PUNCH_ORG_NOT_PERMITTED' } })
    expect(await recordCountFor(userF, twin)).toBe(0)

    const accepted = await punchNullOperationId(userF, orgMixed)
    expect(accepted.status).toBe(200)
    expect(await recordOrgIdsFor(userF)).toEqual([orgMixed])
  })
})
