import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import type { MetaSheetServer } from '../../src/index'
import { canReadApprovalInstance } from '../../src/services/approval-instance-readability'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

const dbUrl = process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

// Sentinel deliberately lives OUTSIDE describeIfDatabase (top-level `it`, gated only on
// EXPECT_DB): a sentinel nested inside `describeIfDatabase` would itself be skipped whenever
// DATABASE_URL is absent, so it could never catch the failure mode it exists to catch — a
// DB-expected CI lane (EXPECT_DB=1) whose DATABASE_URL is missing or broken silently reporting
// this whole file as skipped-green instead of red. Matches the landed pattern in
// approval-org-writer-w1w2-s1.db.test.ts / approval-org-writer-plm-mirror-s1.db.test.ts.
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

type HttpResponse = { status: number; body: Record<string, any> | null; raw: string }

function canListen(): Promise<boolean> {
  const probe = net.createServer()
  return new Promise((resolve) => {
    probe.once('error', () => resolve(false))
    probe.listen(0, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

function requestJson(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: Record<string, unknown> } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const payload = options.body !== undefined ? JSON.stringify(options.body) : null
    const request = http.request({
      method: options.method ?? 'GET',
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...options.headers,
      },
    }, (response) => {
      let raw = ''
      response.on('data', (chunk) => { raw += String(chunk) })
      response.on('end', () => {
        let body: Record<string, any> | null = null
        try { body = raw ? JSON.parse(raw) as Record<string, any> : null } catch { body = null }
        resolve({ status: response.statusCode ?? 0, body, raw })
      })
    })
    request.on('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
}

/**
 * Lock-11 §10 W-4 attendance writer org stamping — real-DB acceptance
 * (G-L11-0/4/5/6/8/9/10 + (β) migration-ordering tripwire).
 *
 * Ratified design: docs/development/approval-lock11-writer-org-derivation-20260822.md (RATIFIED
 * 2026-08-22, §10 + the §10.3 seventh by-reference ruling). Implements W-4 arm (f) validated
 * selector (a request-named org validated against the SUBJECT's active user_orgs) falling back
 * to arm (a) (subject's single active membership) when no org is named, inside
 * `upsertAttendanceApprovalInstance` (plugins/plugin-attendance/index.cjs). Boots a real
 * MetaSheetServer with plugin-attendance loaded (mirroring
 * attendance-w4c3b-request-operation-routes.db.test.ts's boot pattern) and drives the plugin's
 * OWN HTTP routes end-to-end, over a real PostgreSQL database.
 *
 * EXPLICITLY EXCLUDED from this file (per the implementation spec):
 *   - G-L11-1/2/3 — W-1/W-2 only (approval-org-writer-w1w2-s1.db.test.ts).
 *   - G-L11-11 (OpenAPI contract regeneration) — verified manually per the four-step procedure
 *     (source edit -> generate:sdk -> git diff on dist/+dist-sdk/ -> guard:codegen); not a
 *     vitest assertion (repo precedent: no other slice gates codegen inside a real-DB suite).
 *   - The G-L11-4 fallback-mutation / rows.length-guard mutation, the G-L11-8 attendance_requests
 *     revert mutation, the G-L11-9 DO-UPDATE-gains-org_id mutation, and the G-L11-5 stamped-value
 *     prefix mutation are all MANUAL (cp + sha256-verified, anchor-hit-count proven) — see the PR
 *     body for hashes. They are not re-run in CI, matching this repo's existing precedent for
 *     writer-pin mutations (G-W2/G-W3's own manual mutations).
 */
describeIfDatabase('Lock-11 §10 W-4 attendance writer org stamping — real-DB acceptance (G-L11-0/4/5/6/8/9/10 + (β))', () => {
  let server: MetaSheetServer | undefined
  let pool: Pool
  let baseUrl = ''
  const priorEnv = {
    databaseUrl: process.env.DATABASE_URL,
    rbacBypass: process.env.RBAC_BYPASS,
    skipPlugins: process.env.SKIP_PLUGINS,
    orgPin: process.env.APPROVAL_S1_ORG_PIN_ENABLED,
  }

  beforeAll(async () => {
    if (!dbUrl || !(await canListen())) throw new Error('W4_ORG_WRITER_TEST_REQUIRES_DATABASE_AND_LOOPBACK')
    await ensureApprovalSchemaReady()
    process.env.DATABASE_URL = dbUrl
    process.env.RBAC_BYPASS = 'true'
    process.env.SKIP_PLUGINS = 'false'
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
    const loaded = await import('../../src/index')
    server = new loaded.MetaSheetServer({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')],
    })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('attendance server did not expose a TCP address')
    baseUrl = `http://127.0.0.1:${address.port}`
    pool = new Pool({ connectionString: dbUrl })
  }, 120000)

  afterAll(async () => {
    await pool?.end().catch(() => undefined)
    if (server) await server.stop()
    for (const [key, value] of Object.entries({
      DATABASE_URL: priorEnv.databaseUrl,
      RBAC_BYPASS: priorEnv.rbacBypass,
      SKIP_PLUGINS: priorEnv.skipPlugins,
      APPROVAL_S1_ORG_PIN_ENABLED: priorEnv.orgPin,
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  function freshId(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  // Seeds an ACTIVE `users` row (is_active=true, activation_status='activated') for `userId` —
  // required for the VALIDATED leg (operationId set), whose boundary-level
  // recheckAttendanceActorLivenessInTransactionV1 does its own `requireActiveUser` check before
  // the writer ever runs; a dev-token mint alone never creates a `users` row. Every fixture
  // below calls this so a validated-leg refusal is unambiguously about MEMBERSHIP, never about a
  // missing/inactive user row.
  async function seedActiveUser(userId: string): Promise<void> {
    await pool.query(
      `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, activation_status, created_at, updated_at)
       VALUES ($1, $2, $1, 'W4 gate fixture user', 'x', 'user', '[]'::jsonb, true, false, 'activated', now(), now())
       ON CONFLICT (id) DO UPDATE SET is_active = true, activation_status = 'activated'`,
      [userId, `${userId}@example.test`],
    )
  }

  async function mintTokenNoSeed(userId: string, tenantId?: string): Promise<string> {
    await seedActiveUser(userId)
    const res = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}${tenantId ? `&tenantId=${encodeURIComponent(tenantId)}` : ''}&roles=admin&perms=${encodeURIComponent('attendance:read,attendance:write,attendance:admin,attendance:approve')}`,
    )
    const token = (res.body as { token?: string } | undefined)?.token
    if (typeof token !== 'string' || !token) throw new Error(`failed to mint token: ${res.raw}`)
    return token
  }

  async function grantMembership(userId: string, orgId: string): Promise<void> {
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)
       ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = TRUE`,
      [userId, orgId],
    )
  }

  async function activeMembershipCount(userId: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM user_orgs WHERE user_id = $1 AND is_active = TRUE`,
      [userId],
    )
    return Number(result.rows[0]?.count ?? '0')
  }

  async function attendanceRequestCountForOrg(orgId: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM attendance_requests WHERE org_id = $1`,
      [orgId],
    )
    return Number(result.rows[0]?.count ?? '0')
  }

  function authHeaders(token: string) {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  }

  const createdRequestIds: string[] = []
  const createdInstanceIds: string[] = []

  async function createGeneric(
    token: string,
    body: Record<string, unknown>,
  ): Promise<HttpResponse> {
    const res = await requestJson(`${baseUrl}/api/attendance/requests`, {
      method: 'POST',
      headers: authHeaders(token),
      body: {
        workDate: '2049-05-01',
        requestType: 'missed_check_in',
        requestedInAt: '2049-05-01T09:00:00.000Z',
        reason: 'W4 gate fixture',
        ...body,
      },
    })
    if (res.status === 201) {
      const requestId = res.body?.data?.request?.id
      if (typeof requestId === 'string') createdRequestIds.push(requestId)
    }
    return res
  }

  async function readInstanceOrg(instanceId: string): Promise<string | null> {
    const row = await pool.query<{ org_id: string | null }>(
      'SELECT org_id FROM approval_instances WHERE id = $1',
      [instanceId],
    )
    return row.rows[0]?.org_id ?? null
  }

  async function readRequestOrgById(requestId: string): Promise<string | null> {
    const row = await pool.query<{ org_id: string | null }>(
      'SELECT org_id FROM attendance_requests WHERE id = $1',
      [requestId],
    )
    return row.rows[0]?.org_id ?? null
  }

  async function approvalInstanceIdForRequest(requestId: string): Promise<string> {
    const row = await pool.query<{ approval_instance_id: string | null }>(
      'SELECT approval_instance_id FROM attendance_requests WHERE id = $1',
      [requestId],
    )
    const id = row.rows[0]?.approval_instance_id
    if (!id) throw new Error(`request ${requestId} has no approval_instance_id`)
    return id
  }

  afterAll(async () => {
    if (createdRequestIds.length > 0) {
      await pool.query('DELETE FROM attendance_requests WHERE id = ANY($1::uuid[])', [createdRequestIds]).catch(() => undefined)
    }
  })

  // =============================================================================================
  // (β) migration-ordering tripwire (Lock-11 §10.2/§10.3): this writer suite must not be able to
  // pass on a tree that lacks the two migrations the D-8(β) single-active-org premise (and
  // therefore this slice's arm-(a) fallback) relies on in production.
  // =============================================================================================
  describe('(β) migration-ordering tripwire', () => {
    it('the D-8(β) provisioning migration and the Migration B org_id backfill are BOTH recorded in kysely_migration before this suite\'s fixtures run', async () => {
      const result = await pool.query<{ name: string }>(
        `SELECT name FROM kysely_migration WHERE name = ANY($1::text[])`,
        [[
          'zzzz20260823050000_provision_zero_membership_active_users',
          'zzzz20260823100000_backfill_approval_instance_org_id',
        ]],
      )
      const found = new Set(result.rows.map((r) => r.name))
      expect(
        found.has('zzzz20260823050000_provision_zero_membership_active_users'),
        'provisioning migration zzzz20260823050000 must be recorded in kysely_migration',
      ).toBe(true)
      expect(
        found.has('zzzz20260823100000_backfill_approval_instance_org_id'),
        'Migration B backfill zzzz20260823100000 must be recorded in kysely_migration',
      ).toBe(true)
    })
  })

  // =============================================================================================
  // G-L11-4: per-leg refusal/success matrix.
  // =============================================================================================
  describe('G-L11-4: per-leg validated-selector / fallback matrix', () => {
    it('(i-validated) named org, operationId SET, subject NOT a member -> 403 ATTENDANCE_WRITE_NOT_AUTHORIZED (the BOUNDARY door), no row', async () => {
      const orgEvil = randomUUID()
      const actorId = freshId('g114-i-validated')
      const token = await mintTokenNoSeed(actorId)
      const before = await attendanceRequestCountForOrg(orgEvil)
      expect(before).toBe(0)

      const res = await createGeneric(token, { operationId: randomUUID(), orgId: orgEvil })
      expect(res.status, res.raw).toBe(403)
      expect(res.body?.error?.code).toBe('ATTENDANCE_WRITE_NOT_AUTHORIZED')

      expect(await attendanceRequestCountForOrg(orgEvil)).toBe(before)
    })

    it('(i-legacy) named org, operationId OMITTED, subject NOT a member -> 422 APPROVAL_ORG_SELECTOR_NOT_PERMITTED (the WRITER door — the only refusing mechanism on this leg), no row', async () => {
      const orgEvil = randomUUID()
      const actorId = freshId('g114-i-legacy')
      const token = await mintTokenNoSeed(actorId)
      const before = await attendanceRequestCountForOrg(orgEvil)
      expect(before).toBe(0)

      const res = await createGeneric(token, { orgId: orgEvil })
      expect(res.status, res.raw).toBe(422)
      expect(res.body?.error?.code).toBe('APPROVAL_ORG_SELECTOR_NOT_PERMITTED')
      // Values-free: no org id / user id in the response body.
      expect(res.raw).not.toContain(orgEvil)
      expect(res.raw).not.toContain(actorId)

      expect(await attendanceRequestCountForOrg(orgEvil)).toBe(before)
    })

    it('(ii) name nothing, subject multi-org (legacy leg, operationId omitted) -> 422 APPROVAL_ORG_UNRESOLVED, no row', async () => {
      const actorId = freshId('g114-ii-legacy')
      const token = await mintTokenNoSeed(actorId)
      const orgX = randomUUID()
      await grantMembership(actorId, 'default')
      await grantMembership(actorId, orgX)
      expect(await activeMembershipCount(actorId)).toBeGreaterThanOrEqual(2)

      const before = await attendanceRequestCountForOrg('default')
      const res = await createGeneric(token, {})
      expect(res.status, res.raw).toBe(422)
      expect(res.body?.error?.code).toBe('APPROVAL_ORG_UNRESOLVED')
      expect(res.body?.error?.details).toBeUndefined()
      expect(await attendanceRequestCountForOrg('default')).toBe(before)
    })

    it('(ii) name nothing, subject multi-org (validated leg, operationId SET) -> 422 APPROVAL_ORG_UNRESOLVED, no row — discriminates on both legs', async () => {
      const actorId = freshId('g114-ii-validated')
      const token = await mintTokenNoSeed(actorId)
      const orgY = randomUUID()
      await grantMembership(actorId, 'default')
      await grantMembership(actorId, orgY)
      expect(await activeMembershipCount(actorId)).toBeGreaterThanOrEqual(2)

      const before = await attendanceRequestCountForOrg('default')
      const res = await createGeneric(token, { operationId: randomUUID() })
      expect(res.status, res.raw).toBe(422)
      expect(res.body?.error?.code).toBe('APPROVAL_ORG_UNRESOLVED')
      expect(await attendanceRequestCountForOrg('default')).toBe(before)
    })

    it('(iii) subject zero-membership (G-L11-0/10: COUNT=0 confirmed at assertion time, immediately before) -> 422, no row', async () => {
      const actorId = freshId('g114-iii-zero')
      const token = await mintTokenNoSeed(actorId)
      expect(await activeMembershipCount(actorId)).toBe(0)

      const before = await attendanceRequestCountForOrg('default')
      const res = await createGeneric(token, {})
      expect(res.status, res.raw).toBe(422)
      expect(res.body?.error?.code).toBe('APPROVAL_ORG_UNRESOLVED')
      expect(await attendanceRequestCountForOrg('default')).toBe(before)
    })
  })

  // =============================================================================================
  // G-L11-5: reader-writer round-trip (D-9 byte-agreement).
  // =============================================================================================
  describe('G-L11-5: reader∘writer agreement under the S1 org pin', () => {
    async function withOrgPinEnabled<T>(fn: () => Promise<T>): Promise<T> {
      const prior = process.env.APPROVAL_S1_ORG_PIN_ENABLED
      process.env.APPROVAL_S1_ORG_PIN_ENABLED = 'true'
      try {
        return await fn()
      } finally {
        if (prior === undefined) delete process.env.APPROVAL_S1_ORG_PIN_ENABLED
        else process.env.APPROVAL_S1_ORG_PIN_ENABLED = prior
      }
    }

    it('POSITIVE: after a create, the requester can read their own instance with the pin ON', async () => {
      const subjectId = freshId('g115-pos')
      const token = await mintTokenNoSeed(subjectId)
      const orgOne = randomUUID()
      await grantMembership(subjectId, orgOne)

      const res = await createGeneric(token, { operationId: randomUUID(), orgId: orgOne })
      expect(res.status, res.raw).toBe(201)
      const requestId = res.body?.data?.request?.id as string
      const instanceId = await approvalInstanceIdForRequest(requestId)
      createdInstanceIds.push(instanceId)

      const canRead = await withOrgPinEnabled(() => canReadApprovalInstance(pool as never, subjectId, instanceId))
      expect(canRead).toBe(true)
    })

    it('(α) a viewer whose sole membership is elsewhere (not requester/assignee/admin) cannot read it with the pin ON', async () => {
      const subjectId = freshId('g115-alpha-subj')
      const token = await mintTokenNoSeed(subjectId)
      const orgOne = randomUUID()
      await grantMembership(subjectId, orgOne)

      const res = await createGeneric(token, { operationId: randomUUID(), orgId: orgOne })
      expect(res.status, res.raw).toBe(201)
      const requestId = res.body?.data?.request?.id as string
      const instanceId = await approvalInstanceIdForRequest(requestId)
      createdInstanceIds.push(instanceId)

      const otherViewerId = freshId('g115-alpha-other')
      const orgElsewhere = randomUUID()
      await grantMembership(otherViewerId, orgElsewhere)

      const canRead = await withOrgPinEnabled(() => canReadApprovalInstance(pool as never, otherViewerId, instanceId))
      expect(canRead).toBe(false)
    })

    it('(β) liveness fixture: subject has an active user_orgs row but users.is_active=false — legacy leg only (the validated leg 403s on requireActiveUser first); writer stamps and reader admits under the SAME single-is_active predicate (D-9)', async () => {
      const subjectId = freshId('g115-beta')
      const token = await mintTokenNoSeed(subjectId)
      const orgOne = randomUUID()
      await grantMembership(subjectId, orgOne)
      // Deactivate the user row itself (users.is_active=false) — the derivation and the reader
      // both consult ONLY user_orgs.is_active (D-9), never users.is_active, so this must not
      // change either side's answer.
      await pool.query(
        `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
         VALUES ($1, $2, $1, 'G-L11-5 beta fixture', 'x', 'user', '[]'::jsonb, false, false, now(), now())
         ON CONFLICT (id) DO UPDATE SET is_active = false`,
        [subjectId, `${subjectId}@example.test`],
      )

      // Legacy leg (operationId omitted): no requireActiveUser check runs before the writer.
      const res = await createGeneric(token, { orgId: orgOne })
      expect(res.status, res.raw).toBe(201)
      const requestId = res.body?.data?.request?.id as string
      const instanceId = await approvalInstanceIdForRequest(requestId)
      createdInstanceIds.push(instanceId)
      expect(await readInstanceOrg(instanceId)).toBe(orgOne)

      const canRead = await withOrgPinEnabled(() => canReadApprovalInstance(pool as never, subjectId, instanceId))
      expect(canRead).toBe(true)
    })
  })

  // =============================================================================================
  // G-L11-6: subject-keying — schedule-dispatch is the sole constructible actor≠subject writer.
  // =============================================================================================
  describe('G-L11-6: subject-keying (schedule-dispatch cross-user)', () => {
    async function seedDispatchTargets(prefix: string) {
      const attendanceGroupId = randomUUID()
      const scheduleGroupId = randomUUID()
      const shiftId = randomUUID()
      await pool.query(
        `INSERT INTO attendance_groups (id, org_id, name, code, timezone) VALUES ($1, $2, $3, $4, 'UTC')`,
        [attendanceGroupId, 'default', `${prefix}-ag`, `${prefix}-agcode`],
      )
      await pool.query(
        `INSERT INTO attendance_schedule_groups
         (id, org_id, name, code, attendance_group_id, department_ref, source, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, 'manual', true)`,
        [scheduleGroupId, 'default', `${prefix}-sg`, `${prefix}-sgcode`, attendanceGroupId, `${prefix}-dept`],
      )
      await pool.query(
        `INSERT INTO attendance_shifts (id, org_id, name, work_start_time, work_end_time) VALUES ($1, $2, $3, '09:00', '18:00')`,
        [shiftId, 'default', `${prefix}-shift`],
      )
      return { scheduleGroupId, shiftId }
    }

    async function seedDispatchFlow(adminToken: string, prefix: string): Promise<string> {
      const flow = await requestJson(`${baseUrl}/api/attendance/approval-flows`, {
        method: 'POST',
        headers: authHeaders(adminToken),
        body: { name: `${prefix}-flow`, requestType: 'schedule_dispatch', isActive: true, steps: [] },
      })
      expect(flow.status, flow.raw).toBe(201)
      return flow.body?.data?.id as string
    }

    it('the dispatch TARGET (subject) org is stamped — never the actor\'s own org, never the session org', async () => {
      const prefix = freshId('g116')
      const actorId = `${prefix}-actor`
      const subjectId = `${prefix}-subject`
      // Actor: full-admin bypass (RBAC_BYPASS=true), a DIFFERENT membership than the subject's,
      // proving the actor's own org never appears on the stamp.
      const actorToken = await mintTokenNoSeed(actorId, 'default')
      const orgActor = randomUUID()
      await grantMembership(actorId, orgActor)
      // Subject: exactly ONE membership, distinct from both the actor's org and the session org
      // ('default', from actorAccess.orgId — schedule-dispatch never treats it as "named").
      const orgSubject = randomUUID()
      await grantMembership(subjectId, orgSubject)
      expect(await activeMembershipCount(subjectId)).toBe(1)

      const { scheduleGroupId, shiftId } = await seedDispatchTargets(prefix)
      const approvalFlowId = await seedDispatchFlow(actorToken, prefix)

      const create = await requestJson(`${baseUrl}/api/attendance/schedule-dispatch-requests`, {
        method: 'POST',
        headers: authHeaders(actorToken),
        body: {
          userId: subjectId,
          targetScheduleGroupId: scheduleGroupId,
          targetShiftId: shiftId,
          startDate: '2049-05-10',
          endDate: '2049-05-10',
          approvalFlowId,
        },
      })
      expect(create.status, create.raw).toBe(201)
      const requestId = create.body?.data?.request?.id as string
      createdRequestIds.push(requestId)
      const instanceId = await approvalInstanceIdForRequest(requestId)
      createdInstanceIds.push(instanceId)

      const stampedOrg = await readInstanceOrg(instanceId)
      expect(stampedOrg).toBe(orgSubject)
      expect(stampedOrg).not.toBe(orgActor)
      expect(stampedOrg).not.toBe('default')
    })
  })

  // =============================================================================================
  // G-L11-8 (D-11(ii)): same-transaction equality gate, approval_instances.org_id ==
  // attendance_requests.org_id, for rows created by arm (a) or (f)-fallback.
  // =============================================================================================
  describe('G-L11-8: same-transaction org equality (approval_instances vs attendance_requests)', () => {
    it('named-selector create (arm f): the twin rows carry the SAME stamped org', async () => {
      const subjectId = freshId('g118-f')
      const token = await mintTokenNoSeed(subjectId)
      const orgOne = randomUUID()
      await grantMembership(subjectId, orgOne)

      const res = await createGeneric(token, { operationId: randomUUID(), orgId: orgOne })
      expect(res.status, res.raw).toBe(201)
      const requestId = res.body?.data?.request?.id as string
      const instanceId = await approvalInstanceIdForRequest(requestId)
      createdInstanceIds.push(instanceId)

      const instanceOrg = await readInstanceOrg(instanceId)
      const requestOrg = await readRequestOrgById(requestId)
      expect(instanceOrg).toBe(requestOrg)
      expect(instanceOrg).toBe(orgOne)
    })

    it('name-nothing create (arm a fallback, legacy leg): the twin rows carry the SAME stamped org', async () => {
      const subjectId = freshId('g118-a')
      const token = await mintTokenNoSeed(subjectId)
      const orgTwo = randomUUID()
      await grantMembership(subjectId, orgTwo)

      const res = await createGeneric(token, {})
      expect(res.status, res.raw).toBe(201)
      const requestId = res.body?.data?.request?.id as string
      const instanceId = await approvalInstanceIdForRequest(requestId)
      createdInstanceIds.push(instanceId)

      const instanceOrg = await readInstanceOrg(instanceId)
      const requestOrg = await readRequestOrgById(requestId)
      expect(instanceOrg).toBe(requestOrg)
      expect(instanceOrg).toBe(orgTwo)
      // The point of this fixture: the subject's single membership is DELIBERATELY not 'default'
      // — a discriminating fixture. A revert-to-route.orgId mutation on the twin INSERT (manual,
      // see PR body) makes this specific assertion diverge (requestOrg would read back
      // 'default' instead of orgTwo) — proving the equality gate is load-bearing, not vacuous.
      expect(requestOrg).not.toBe('default')
    })
  })

  // =============================================================================================
  // G-L11-9 / D-10-retired pin: DO UPDATE never re-derives org_id, even across a conflict whose
  // EXCLUDED carries a different validated org.
  // =============================================================================================
  describe('G-L11-9 / D-10 pin: conflict path never re-stamps org_id', () => {
    it('create (org O1) -> move membership O1->O2 -> pending-edit naming O2 (separate HTTP call) -> updated_at moves, org_id stays O1; who-can-read matrix under the pin', async () => {
      const subjectId = freshId('g119')
      const token = await mintTokenNoSeed(subjectId)
      const orgOne = randomUUID()
      const orgTwo = randomUUID()
      await grantMembership(subjectId, orgOne)

      const createRes = await createGeneric(token, { operationId: randomUUID(), orgId: orgOne })
      expect(createRes.status, createRes.raw).toBe(201)
      const requestId = createRes.body?.data?.request?.id as string
      const instanceId = await approvalInstanceIdForRequest(requestId)
      createdInstanceIds.push(instanceId)
      expect(await readInstanceOrg(instanceId)).toBe(orgOne)

      const beforeUpdatedAt = (await pool.query<{ updated_at: string }>(
        'SELECT updated_at FROM approval_instances WHERE id = $1',
        [instanceId],
      )).rows[0].updated_at

      // MOVE (not add): the subject's single membership becomes O2.
      await pool.query(
        `UPDATE user_orgs SET org_id = $2 WHERE user_id = $1 AND org_id = $3`,
        [subjectId, orgTwo, orgOne],
      )
      expect(await activeMembershipCount(subjectId)).toBe(1)

      // A SEPARATE HTTP call (separate transaction, so now() differs) — pending-edit NAMING O2,
      // a valid selector for the subject now.
      const editRes = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: {
          orgId: orgTwo,
          workDate: '2049-05-02',
          requestType: 'missed_check_in',
          requestedInAt: '2049-05-02T09:00:00.000Z',
          reason: 'G-L11-9 pending edit',
        },
      })
      expect(editRes.status, editRes.raw).toBe(200)

      const afterRow = (await pool.query<{ updated_at: string; org_id: string | null }>(
        'SELECT updated_at, org_id FROM approval_instances WHERE id = $1',
        [instanceId],
      )).rows[0]
      // Conflict branch executed (the only valid witness: version/created_at are absent from
      // the SET list by construction).
      expect(new Date(afterRow.updated_at).getTime()).toBeGreaterThan(new Date(beforeUpdatedAt).getTime())
      // D-10-retired pin: DO UPDATE never re-derives org_id, even though EXCLUDED carried O2.
      expect(afterRow.org_id).toBe(orgOne)

      // Who-can-read matrix under the pin, values-free.
      const priorPin = process.env.APPROVAL_S1_ORG_PIN_ENABLED
      process.env.APPROVAL_S1_ORG_PIN_ENABLED = 'true'
      try {
        // Subject (now O2-only) -> FALSE. Org sits OUTSIDE the arm disjunction (dark for
        // everyone, admins included, once membership has moved off the stored org).
        expect(await canReadApprovalInstance(pool as never, subjectId, instanceId)).toBe(false)

        // An unrelated O1-member viewer (not requester/assignee/admin) -> FALSE (the requester
        // arm requires an exact id match; being an O1 member alone satisfies only the org
        // conjunct, not any disjunct).
        const o1MemberViewerId = freshId('g119-o1member')
        await grantMembership(o1MemberViewerId, orgOne)
        expect(await canReadApprovalInstance(pool as never, o1MemberViewerId, instanceId)).toBe(false)

        // An admin viewer with NO O1 membership -> FALSE: the admin arm's inner disjunct would
        // match, but the org conjunct sits OUTSIDE that OR and denies regardless — "dark for
        // everyone incl. admins" is not a slogan, it is mechanically enforced here.
        const adminViewerId = freshId('g119-admin')
        await pool.query(
          `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
           VALUES ($1, $2, $1, 'G-L11-9 admin viewer', 'x', 'admin', '[]'::jsonb, true, true, now(), now())
           ON CONFLICT (id) DO UPDATE SET is_admin = true, is_active = true`,
          [adminViewerId, `${adminViewerId}@example.test`],
        )
        expect(await activeMembershipCount(adminViewerId)).toBe(0)
        expect(await canReadApprovalInstance(pool as never, adminViewerId, instanceId)).toBe(false)
      } finally {
        if (priorPin === undefined) delete process.env.APPROVAL_S1_ORG_PIN_ENABLED
        else process.env.APPROVAL_S1_ORG_PIN_ENABLED = priorPin
      }
    })
  })
})
