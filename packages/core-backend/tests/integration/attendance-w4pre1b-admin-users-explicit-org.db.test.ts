import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import http from 'http'
import { Pool } from 'pg'
import { buildAttendanceTimezoneRuntimeOrgLockKeyV1 } from '../../src/attendance/attendance-timezone-runtime-locks'
import type { MetaSheetServer } from '../../src/index'
import { query } from '../../src/db/pg'

/**
 * W4-PRE-1b item D (F6) — `POST /api/admin/users` accepts an independent explicit
 * `attendanceOrgId` body param, unconditionally sufficient (no `attendanceGroupId`/
 * `defaultShiftId` required) to onboard `user_orgs` membership. Closes the exact circular
 * dependency owner named (admin-users.ts:3172 previously resolved an org ONLY when a group/shift
 * id was ALSO submitted, so a brand-new org's first member could never complete step① — you
 * needed a group/shift to get an org, and a group/shift needs an org).
 *
 * Auth: platform admin via dev-token (`roles=admin` → `hasLegacyAdminClaim` inside
 * `ensurePlatformAdmin`) — this route's OWN gate, unrelated to the S7-5/rbacGuard namespace-
 * admission subsystem F5 had to route around, so the full real-server + dev-token path (proven
 * working by the existing `admin-users.api.test.ts` sanity test) is the natural fit here.
 */
async function canListenOnEphemeralPort(): Promise<boolean> {
  return await new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
  })
}

interface HttpResponse {
  status: number
  body: { ok?: boolean; error?: { code?: string; message?: string }; data?: Record<string, unknown> } & Record<string, unknown>
}

function requestJson(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = http.request(
      { method: options.method || 'GET', hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, headers: options.headers },
      (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => {
          let body: unknown
          try {
            body = data ? JSON.parse(data) : {}
          } catch {
            body = {}
          }
          resolve({ status: res.statusCode || 0, body: body as HttpResponse['body'] })
        })
      },
    )
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const TS = Date.now()
const NS = `w4pre1badminorg${TS}`

describeIfDatabase('W4-PRE-1b item D (F6) — POST /api/admin/users explicit attendanceOrgId (real DB, real endpoint)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  let adminToken = ''
  const createdUserIds: string[] = []
  const freshOrg = `${NS}-fresh-org`
  const groupDerivedOrg = `${NS}-group-org`
  const conflictOrg = `${NS}-conflict-org`

  async function devToken(): Promise<string> {
    const res = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(`${NS}-platform-admin`)}&roles=admin&perms=${encodeURIComponent('*:*')}`)
    const token = (res.body as { token?: string }).token
    if (!token) throw new Error('dev-token issuance failed')
    return token
  }

  async function createUser(body: Record<string, unknown>): Promise<HttpResponse> {
    const res = await requestJson(`${baseUrl}/api/admin/users`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const userId = (res.body?.data as { user?: { id?: string } } | undefined)?.user?.id
    if (userId) createdUserIds.push(userId)
    return res
  }

  async function membershipRow(userId: string, orgId: string): Promise<{ is_active: boolean } | undefined> {
    const rows = await query<{ is_active: boolean }>(`SELECT is_active FROM user_orgs WHERE user_id = $1 AND org_id = $2`, [userId, orgId])
    return rows.rows[0]
  }

  async function attendanceScaffoldCounts(orgId: string): Promise<{ groups: number; shifts: number }> {
    const [groups, shifts] = await Promise.all([
      query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM attendance_groups WHERE org_id = $1`, [orgId]),
      query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM attendance_shifts WHERE org_id = $1`, [orgId]),
    ])
    return { groups: Number(groups.rows[0]?.count ?? 0), shifts: Number(shifts.rows[0]?.count ?? 0) }
  }

  beforeAll(async () => {
    if (!(await canListenOnEphemeralPort())) throw new Error('F6 test requires an available loopback port')
    if (!dbUrl) throw new Error('DATABASE_URL / ATTENDANCE_TEST_DATABASE_URL is required')
    process.env.DATABASE_URL = dbUrl

    // `freshOrg` is genuinely new-to-ATTENDANCE (zero attendance_groups/attendance_shifts rows —
    // asserted explicitly in the F6 test below, not just implied by NS-scoped uniqueness) but
    // already carries a `directory_integrations` anchor (local provider) — the SHIPPED reading of
    // the owner's item-D ask ("支持显式 attendanceOrgId（不依赖考勤组/班次）⇒ canonical surface
    // 变为真无条件"): validate-can-fail against `directory_integrations`, not auto-vivify from
    // client input (see PR body deviation #1 for the alternate reading, requested for owner
    // ruling). This is what "fresh-org" means in F6: fresh to the OLD group/shift-derivation
    // circular dependency, not unanchored at the directory layer.
    await query(
      `INSERT INTO directory_integrations (org_id, name, corp_id, provider, status)
       VALUES ($1, $2, $3, 'local', 'active')`,
      [freshOrg, `${NS}-fresh-int`, `local:${freshOrg}`],
    )
    await query(
      `INSERT INTO directory_integrations (org_id, name, corp_id, provider, status)
       VALUES ($1, $2, $3, 'local', 'active')`,
      [conflictOrg, `${NS}-conflict-int`, `local:${conflictOrg}`],
    )

    const { MetaSheetServer } = await import('../../src/index')
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('server did not expose a TCP address')
    baseUrl = `http://127.0.0.1:${address.port}`
    adminToken = await devToken()
  })

  afterAll(async () => {
    if (createdUserIds.length) {
      await query(`DELETE FROM user_orgs WHERE user_id = ANY($1::text[])`, [createdUserIds])
      await query(`DELETE FROM users WHERE id = ANY($1::text[])`, [createdUserIds])
    }
    await query(`DELETE FROM directory_integrations WHERE org_id = ANY($1::text[])`, [[freshOrg, groupDerivedOrg, conflictOrg]])
    if (server) await server.stop()
  })

  it('fresh-org explicit attendanceOrgId with ZERO attendanceGroupId/defaultShiftId creates active membership (falsifies the old circular dependency)', async () => {
    // Self-verify the "fresh" claim (#4526 review) rather than relying solely on NS-scoped
    // uniqueness: freshOrg has zero attendance_groups/attendance_shifts BEFORE the call.
    expect(await attendanceScaffoldCounts(freshOrg)).toEqual({ groups: 0, shifts: 0 })

    const res = await createUser({
      name: 'F6 Fresh',
      email: `${NS}-fresh@example.test`,
      attendanceOrgId: freshOrg,
    })
    expect(res.status).toBe(200)
    const userId = (res.body?.data as { user?: { id?: string } } | undefined)?.user?.id
    expect(userId).toBeTruthy()
    expect(await membershipRow(userId!, freshOrg)).toEqual({ is_active: true })

    // ...and stays zero AFTER: the explicit-org path must not silently scaffold an attendance
    // group/shift as a side effect of onboarding.
    expect(await attendanceScaffoldCounts(freshOrg)).toEqual({ groups: 0, shifts: 0 })
  })

  it('unknown attendanceOrgId (no directory_integrations anchor) → 404 ATTENDANCE_ORG_NOT_FOUND', async () => {
    const res = await createUser({
      name: 'F6 Unknown Org',
      email: `${NS}-unknown@example.test`,
      attendanceOrgId: `${NS}-org-that-does-not-exist`,
    })
    expect(res.status).toBe(404)
    expect(res.body?.error?.code).toBe('ATTENDANCE_ORG_NOT_FOUND')
  })

  it('malformed attendanceOrgId (non-string) → 400 INVALID_ATTENDANCE_ORG_ID', async () => {
    const res = await createUser({
      name: 'F6 Bad Org',
      email: `${NS}-badorg@example.test`,
      attendanceOrgId: 12345,
    })
    expect(res.status).toBe(400)
    expect(res.body?.error?.code).toBe('INVALID_ATTENDANCE_ORG_ID')
  })

  it('backward compat: group/shift-derived path (no attendanceOrgId) is unchanged', async () => {
    const res = await createUser({
      name: 'F6 Legacy Path',
      email: `${NS}-legacy@example.test`,
    })
    expect(res.status).toBe(200)
    // No attendanceGroupId/defaultShiftId AND no attendanceOrgId submitted → attendanceOrgId
    // resolution never triggers (matches pre-W4-PRE-1b-item-D behavior byte-for-byte).
    expect(res.body?.data && (res.body.data as { attendanceOnboarding?: unknown }).attendanceOnboarding).toBeNull()
  })

  it('onboarding waits for the timezone org prefix before creating any user rows', async () => {
    const group = await query<{ id: string }>(
      "INSERT INTO attendance_groups (org_id,name,timezone) VALUES ($1,$2,'UTC') RETURNING id",
      [freshOrg, NS + '-prefix-group'],
    )
    const groupId = group.rows[0].id
    const email = NS + '-prefix@example.test'
    const lockKey = buildAttendanceTimezoneRuntimeOrgLockKeyV1(freshOrg)
    const blockerPool = new Pool({ connectionString: dbUrl, max: 1 })
    const blocker = await blockerPool.connect()
    let pending: Promise<HttpResponse> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [lockKey])
      let settled = false
      pending = createUser({ name: 'Prefix onboarding', email, orgId: freshOrg, attendanceOrgId: freshOrg, attendanceGroupId: groupId })
      void pending.then(() => { settled = true })
      let waiting = false
      for (let attempt = 0; attempt < 250 && !settled; attempt += 1) {
        const locks = await query<{ waiting: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory'
            AND mode='ExclusiveLock' AND NOT granted
            AND classid=((hashtextextended($1,0) >> 32) & 4294967295)::oid
            AND objid=(hashtextextended($1,0) & 4294967295)::oid AND objsubid=1) AS waiting`,
          [lockKey],
        )
        waiting = locks.rows[0].waiting
        if (waiting) break
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      // A red control must reach a valid successful endpoint, not a 4xx fixture refusal.
      if (!waiting && settled) expect((await pending).status).toBe(200)
      expect(waiting).toBe(true)
      expect((await query<{ count: number }>('SELECT COUNT(*)::int AS count FROM users WHERE email=$1', [email])).rows).toEqual([{ count: 0 }])
      await blocker.query('COMMIT')
      const result = await pending
      expect(result.status).toBe(200)
      const userId = (result.body.data as { user: { id: string } }).user.id
      expect(await membershipRow(userId, freshOrg)).toEqual({ is_active: true })
      expect((await query<{ user_id: string }>('SELECT user_id FROM attendance_group_members WHERE group_id=$1', [groupId])).rows).toEqual([{ user_id: userId }])
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
      await blockerPool.end()
      if (pending) await pending
      await query('DELETE FROM attendance_group_members WHERE group_id=$1', [groupId])
      await query('DELETE FROM attendance_groups WHERE id=$1', [groupId])
    }
  })

  it('rolls back the real onboarding transaction when policy admission rejects a second group', async () => {
    const firstGroup = (await query<{ id: string }>(
      "INSERT INTO attendance_groups(org_id,name,timezone) VALUES($1,$2,'UTC') RETURNING id",
      [freshOrg, NS + '-rollback-first'],
    )).rows[0].id
    const secondGroup = (await query<{ id: string }>(
      "INSERT INTO attendance_groups(org_id,name,timezone) VALUES($1,$2,'UTC') RETURNING id",
      [freshOrg, NS + '-rollback-second'],
    )).rows[0].id
    const email = NS + '-rollback@example.test'
    const triggerName = NS + '_membership_seed'
    // A synthetic DB-side first assignment makes rejection reachable after the
    // real user/user_orgs INSERTs, proving rollback rather than mocking ROLLBACK.
    // All interpolated literals/identifiers are this file's generated fixtures.
    try {
      await query(
        "CREATE FUNCTION " + triggerName + "() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN " +
        "IF NEW.org_id = '" + freshOrg + "' AND EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND email='" + email + "') THEN " +
        "INSERT INTO attendance_group_members(id,org_id,group_id,user_id) VALUES(gen_random_uuid(),NEW.org_id,'" + firstGroup + "'::uuid,NEW.user_id); " +
        "END IF; RETURN NEW; END $$",
      )
      await query("CREATE TRIGGER " + triggerName + " AFTER INSERT ON user_orgs FOR EACH ROW EXECUTE FUNCTION " + triggerName + "()")
      const result = await createUser({
        name: 'Synthetic rollback', email, orgId: freshOrg,
        attendanceOrgId: freshOrg, attendanceGroupId: secondGroup,
      })
      expect(result.status).toBe(409)
      expect(result.body).toMatchObject({ ok: false, error: { code: 'ATTENDANCE_MULTIPLE_GROUPS_DISABLED' } })
      expect((await query<{ count: number }>('SELECT count(*)::int AS count FROM users WHERE email=$1', [email])).rows)
        .toEqual([{ count: 0 }])
      expect((await query<{ count: number }>('SELECT count(*)::int AS count FROM attendance_group_members WHERE group_id=ANY($1::uuid[])', [[firstGroup, secondGroup]])).rows)
        .toEqual([{ count: 0 }])
    } finally {
      await query('DROP TRIGGER IF EXISTS ' + triggerName + ' ON user_orgs')
      await query('DROP FUNCTION IF EXISTS ' + triggerName + '()')
      await query('DELETE FROM attendance_group_members WHERE group_id=ANY($1::uuid[])', [[firstGroup, secondGroup]])
      await query('DELETE FROM attendance_groups WHERE id=ANY($1::uuid[])', [[firstGroup, secondGroup]])
    }
  })

  it('explicit attendanceOrgId conflicting with the group/shift-derived org → 400 ATTENDANCE_ORG_CONFLICT', async () => {
    // Seed a real attendance_group under `groupDerivedOrg` so resolveAttendanceOnboardingOrgId's
    // derivation path has something concrete to disagree with `conflictOrg` about. orgId is
    // supplied via body.orgId (resolveAttendanceOnboardingOrgId's own precedence chain).
    const groupId = (
      await query<{ id: string }>(
        `INSERT INTO attendance_groups (org_id, name, timezone, created_at, updated_at)
         VALUES ($1, 'F6 Conflict Group', 'UTC', NOW(), NOW()) RETURNING id`,
        [groupDerivedOrg],
      )
    ).rows[0].id
    try {
      const res = await createUser({
        name: 'F6 Conflict',
        email: `${NS}-conflict@example.test`,
        orgId: groupDerivedOrg,
        attendanceGroupId: groupId,
        attendanceOrgId: conflictOrg,
      })
      expect(res.status).toBe(400)
      expect(res.body?.error?.code).toBe('ATTENDANCE_ORG_CONFLICT')
    } finally {
      await query(`DELETE FROM attendance_groups WHERE id = $1`, [groupId])
    }
  })
})

// Keep cold server graph transformation outside the original 15s startup hook.
// All fixture refs are initialized before collection preload; the hook stays unchanged.
await import('../../src/index')
