import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import http from 'node:http'
import express from 'express'
import { authRouter } from '../../src/routes/auth'
import { adminUsersRouter } from '../../src/routes/admin-users'
import { query } from '../../src/db/pg'

/**
 * W4-PRE-1 (§3.3 of docs/development/attendance-vnext-wave4-onboarding-design-lock-20260721.md,
 * the pre-ticket owner errata #4513 blocked Wave 4 on): before this PR, `user_orgs` had exactly
 * ONE production writer — the one-time zzzz20260114110000 backfill migration. `POST
 * /api/admin/users` is the FIRST-PRIORITY write site named in the ticket: it already resolves
 * and validates a known-authoritative org (attendanceOrgId, checked against
 * attendance_groups.org_id / attendance_shifts.org_id above the write) whenever attendance
 * onboarding fields are supplied, but historically never persisted that org into `user_orgs`.
 *
 * This file proves, against a real Postgres, the three required suites (§3.3 item 3):
 *   - fresh-DB: a brand-new admission writes the user_orgs row, and a user_orgs write failure
 *     rolls back the WHOLE admission (no orphan `users` row with no membership).
 *   - two-org: two admissions in different orgs never cross-count.
 *   - upgrade: a pre-existing zzzz20260114110000-style backfill row survives a later admission
 *     in the same org.
 * …plus the org-unknowable negative control for THIS route (no attendanceGroupId/
 * defaultShiftId supplied): zero user_orgs rows, never a silent 'default' guess (§3.3 item 2).
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const RUN = crypto.randomBytes(4).toString('hex')
const NS = `w4pre1admit${TS}${RUN}`

function orgId(tag: string): string {
  return `${NS}_org_${tag}`
}
function emailFor(tag: string): string {
  return `${NS}.${tag}@example.com`
}

describeIfDatabase('W4-PRE-1 — user_orgs admission write site: POST /api/admin/users (real DB)', () => {
  // Deliberately NOT MetaSheetServer: its stop() closes the shared pg pool (src/index.ts, "Close
  // database pool" shutdown task), which would poison every OTHER .db.test.ts file that shares
  // this vitest.integration.config.ts invocation (fileParallelism:false runs them serially in one
  // process — plugin-tests.yml's "Run attendance integration tests" step runs dozens of files in
  // one command). A bare Express app mounting only the routers under test, closed via
  // httpServer.close() (HTTP listener only), keeps this file's real-route/real-DB coverage
  // without that blast radius.
  let httpServer: http.Server
  let baseUrl = ''
  let adminToken = ''

  const createdUserIds: string[] = []
  const createdGroupIds: string[] = []

  async function seedGroup(org: string, tag: string): Promise<{ id: string; name: string }> {
    const id = crypto.randomUUID()
    const name = `${NS}-group-${tag}`
    await query(
      `INSERT INTO attendance_groups (id, org_id, name, attendance_type) VALUES ($1, $2, $3, 'fixed_shift')`,
      [id, org, name],
    )
    createdGroupIds.push(id)
    return { id, name }
  }

  async function createUserViaRoute(body: Record<string, unknown>): Promise<{ status: number; json: any }> {
    const res = await fetch(`${baseUrl}/api/admin/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => null)
    if (json?.data?.user?.id) createdUserIds.push(json.data.user.id)
    return { status: res.status, json }
  }

  async function userOrgRow(userId: string, org: string): Promise<{ user_id: string; org_id: string; is_active: boolean } | null> {
    const result = await query<{ user_id: string; org_id: string; is_active: boolean }>(
      `SELECT user_id, org_id, is_active FROM user_orgs WHERE user_id = $1 AND org_id = $2`,
      [userId, org],
    )
    return result.rows[0] ?? null
  }

  async function activeMemberCount(org: string): Promise<number> {
    // Mirrors plugins/plugin-attendance/index.cjs:15532-15541 RD-3 target-population semantics
    // (§3.3 item 4): active org members = user_orgs.is_active=true AND users.is_active=true.
    const result = await query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM user_orgs uo
         JOIN users u ON u.id = uo.user_id
        WHERE uo.org_id = $1 AND uo.is_active = true AND u.is_active = true`,
      [org],
    )
    return result.rows[0]?.n ?? 0
  }

  beforeAll(async () => {
    const app = express()
    app.use(express.json())
    app.use('/api/auth', authRouter)
    app.use(adminUsersRouter())
    httpServer = http.createServer(app)
    const port = await new Promise<number>((resolve, reject) => {
      httpServer.once('error', reject)
      httpServer.listen(0, '127.0.0.1', () => {
        const address = httpServer.address()
        if (address && typeof address === 'object') resolve(address.port)
        else reject(new Error('failed to bind ephemeral port for W4-PRE-1 admission test server'))
      })
    })
    baseUrl = `http://127.0.0.1:${port}`

    const tokenRes = await fetch(
      `${baseUrl}/api/auth/dev-token?userId=${NS}-admin&roles=admin&perms=${encodeURIComponent('*:*')}`,
    )
    const tokenJson = await tokenRes.json()
    adminToken = tokenJson.token as string
  })

  afterAll(async () => {
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    }
    if (createdUserIds.length) {
      await query(`DELETE FROM attendance_shift_assignments WHERE user_id = ANY($1::text[])`, [createdUserIds])
      await query(`DELETE FROM attendance_group_members WHERE user_id = ANY($1::text[])`, [createdUserIds])
      await query(`DELETE FROM user_orgs WHERE user_id = ANY($1::text[])`, [createdUserIds])
      await query(`DELETE FROM users WHERE id = ANY($1::text[])`, [createdUserIds])
    }
    if (createdGroupIds.length) {
      await query(`DELETE FROM attendance_groups WHERE id = ANY($1::uuid[])`, [createdGroupIds])
    }
  })

  describe('fresh-DB', () => {
    it('a first-priority admission (attendanceOrgId known) writes user_orgs in the same transaction', async () => {
      const org = orgId('fresh')
      const group = await seedGroup(org, 'fresh')

      const { status, json } = await createUserViaRoute({
        name: 'W4PRE1 Fresh',
        email: emailFor('fresh'),
        orgId: org,
        attendanceGroupId: group.id,
      })

      expect(status).toBe(200)
      expect(json.ok).toBe(true)
      const userId = json.data.user.id as string
      expect(json.data.attendanceOnboarding).toEqual({
        orgId: org,
        group: { id: group.id, name: group.name, memberCreated: true },
        defaultShift: null,
      })

      const row = await userOrgRow(userId, org)
      expect(row).toEqual({ user_id: userId, org_id: org, is_active: true })
    })

    it('atomicity: a user_orgs write failure rolls back the whole admission (no orphan users row)', async () => {
      const org = orgId('atomicfail')
      const group = await seedGroup(org, 'atomicfail')
      const fnName = `w4pre1_fail_user_orgs_admin_${RUN}`
      const testEmail = emailFor('atomicfail')

      await query(`CREATE OR REPLACE FUNCTION ${fnName}() RETURNS trigger AS $fn$
        BEGIN
          RAISE EXCEPTION 'W4-PRE-1 injected admin-users user_orgs failure' USING ERRCODE = 'P0001';
        END $fn$ LANGUAGE plpgsql`)
      await query(`CREATE TRIGGER ${fnName}_trg BEFORE INSERT ON user_orgs
        FOR EACH ROW WHEN (NEW.org_id = '${org}') EXECUTE FUNCTION ${fnName}()`)

      try {
        const { status, json } = await createUserViaRoute({
          name: 'W4PRE1 Atomic',
          email: testEmail,
          orgId: org,
          attendanceGroupId: group.id,
        })

        expect(status).toBe(500)
        expect(json.ok).toBe(false)

        const usersRow = await query(`SELECT id FROM users WHERE email = $1`, [testEmail])
        expect(usersRow.rows).toEqual([])
        const orgRows = await query(`SELECT user_id FROM user_orgs WHERE org_id = $1`, [org])
        expect(orgRows.rows).toEqual([])
        // The group-member insert is part of the SAME transaction — it must have rolled back too.
        const memberRows = await query(`SELECT id FROM attendance_group_members WHERE group_id = $1`, [group.id])
        expect(memberRows.rows).toEqual([])
      } finally {
        await query(`DROP TRIGGER IF EXISTS ${fnName}_trg ON user_orgs`).catch(() => {})
        await query(`DROP FUNCTION IF EXISTS ${fnName}()`).catch(() => {})
      }
    })
  })

  describe('two-org', () => {
    it('admissions in org A and org B do not cross-count (org_id-anchored)', async () => {
      const orgA = orgId('twoA')
      const orgB = orgId('twoB')
      const groupA = await seedGroup(orgA, 'twoA')
      const groupB = await seedGroup(orgB, 'twoB')

      const { json: jsonA } = await createUserViaRoute({
        name: 'W4PRE1 TwoA',
        email: emailFor('twoA'),
        orgId: orgA,
        attendanceGroupId: groupA.id,
      })
      const { json: jsonB } = await createUserViaRoute({
        name: 'W4PRE1 TwoB',
        email: emailFor('twoB'),
        orgId: orgB,
        attendanceGroupId: groupB.id,
      })
      const userA = jsonA.data.user.id as string
      const userB = jsonB.data.user.id as string

      expect(await activeMemberCount(orgA)).toBe(1)
      expect(await activeMemberCount(orgB)).toBe(1)

      const rowsA = await query<{ user_id: string }>(`SELECT user_id FROM user_orgs WHERE org_id = $1`, [orgA])
      expect(rowsA.rows.map((r) => r.user_id)).toEqual([userA])
      const rowsB = await query<{ user_id: string }>(`SELECT user_id FROM user_orgs WHERE org_id = $1`, [orgB])
      expect(rowsB.rows.map((r) => r.user_id)).toEqual([userB])
    })
  })

  describe('org-unknowable (this route without attendance onboarding fields)', () => {
    it('creating a user with no attendanceGroupId/defaultShiftId writes zero user_orgs rows (no silent default)', async () => {
      const testEmail = emailFor('noorg')
      const { status, json } = await createUserViaRoute({
        name: 'W4PRE1 NoOrg',
        email: testEmail,
      })

      expect(status).toBe(200)
      const userId = json.data.user.id as string
      expect(json.data.attendanceOnboarding).toBeNull()

      const rows = await query(`SELECT org_id FROM user_orgs WHERE user_id = $1`, [userId])
      expect(rows.rows).toEqual([])
    })
  })

  describe('upgrade', () => {
    it('a pre-existing zzzz20260114110000-style backfill row survives a new admission in the same org', async () => {
      // 'default' is the literal org_id the real backfill migration writes for every pre-existing
      // active user (zzzz20260114110000_create_user_orgs_table.ts). Simulating it here (rather
      // than a synthetic org) is deliberate: it proves the new write path is additive against
      // the actual upgrade shape, not just against a fresh custom org.
      const org = 'default'
      const legacyUserId = `${NS}-legacy-user`
      const legacyEmail = emailFor('legacy')
      const legacyUsername = `${NS}legacyuser`
      createdUserIds.push(legacyUserId)

      await query(
        `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
         VALUES ($1, $2, $3, 'W4PRE1 Legacy', 'x', 'user', '[]'::jsonb, true, false, NOW(), NOW())`,
        [legacyUserId, legacyEmail, legacyUsername],
      )
      // Simulates the backfill migration's own INSERT shape exactly (user_id, org_id, is_active).
      await query(
        `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)`,
        [legacyUserId, org],
      )

      const group = await seedGroup(org, 'upgrade')
      const { status, json } = await createUserViaRoute({
        name: 'W4PRE1 Upgrade',
        email: emailFor('upgrade'),
        orgId: org,
        attendanceGroupId: group.id,
      })

      expect(status).toBe(200)
      const newUserId = json.data.user.id as string

      const newRow = await userOrgRow(newUserId, org)
      expect(newRow).toEqual({ user_id: newUserId, org_id: org, is_active: true })

      const legacyRow = await userOrgRow(legacyUserId, org)
      expect(legacyRow).toEqual({ user_id: legacyUserId, org_id: org, is_active: true })
    })
  })
})
