/**
 * W4-0 (Wave 4 onboarding design-lock 2026-07-21, RATIFIED §9): real-Postgres coverage of
 * `GET /api/attendance-admin/setup-readiness` — the aggregate the mock-level unit test
 * (`tests/unit/attendance-admin-setup-readiness-w4-0.test.ts`) already covers exhaustively at the
 * query-shape level. THIS file's job is the thing a mock cannot prove: that the SQL, run against a
 * real schema, produces the right org-anchored counts, and that a cross-org forgery is refused
 * BEFORE any aggregation SQL reaches Postgres (OD-W4-1 追加门禁1).
 *
 * Scope boundary (deliberate — read before "fixing" the auth setup):
 *   The router's COARSE permission gate (`rbacGuard('attendance','admin')`) and the platform-admin
 *   shortcut (`isRbacAdmin`) are PRE-EXISTING shared middleware, exercised elsewhere. This slice adds
 *   exactly one new authorization surface: the ORG-MEMBERSHIP door (`canReadAttendanceDirectoryReadiness`
 *   / `user_orgs`, reused verbatim from S7-5). So — mirroring the mock unit test's own boundary — this
 *   file mocks `rbacGuard` (bypass) and `isAdmin` (constant false) and keeps `../../src/db/pg`'s `query`
 *   REAL (wrapped in `vi.fn(actual.query)` so every call still hits Postgres, and `.mock.calls` gives us
 *   the exact SQL text and count for the "zero aggregation SQL before 403" proof). A `req.user = { id }`
 *   with no admin claims is therefore a faithful "org A's delegated attendance admin" — real DB
 *   membership in `user_orgs` is what separates a 200 from a 403, exactly as in production.
 *
 * Proves:
 *   A. Two-org forgery matrix (OD-W4-1 追加门禁1): an admin who is an active member of org A, but NOT
 *      of org B, requesting `orgId=orgB` gets 403 FORBIDDEN — and the query spy shows EXACTLY ONE query
 *      fired (the `user_orgs` membership door), never any of the aggregation tables.
 *   B. Positive control (the same admin, own org): every org-scoped signal is asserted to its exact
 *      seeded value — orgActiveMemberCount (is_active filter proven with a seeded inactive row),
 *      groupCount vs groupsWithMembers (OD-W4-6 split), shiftCount, rotationRuleCount/hasRotationRules,
 *      approvalFlowCount (is_active filter), directoryLinked, notify.orgRecipientBindingReady.
 *   C. Empty org: a member with zero seeded resources sees every org-scoped signal at 0/false.
 *   D. Org-anchor SQL audit against the REAL query text: the org-counts CTE contains `org_id = $1`
 *      exactly six times, a single positional param, and no PII/identifying columns (mirrors the unit
 *      test's assertion, now against Postgres's own EXPLAIN-able SQL rather than a mock).
 *   E. ④ punch-policy posture (OD-W4-4=(c)) against the REAL deployment-wide `system_configs` row —
 *      snapshotted and restored around a tight critical section so this file never permanently mutates
 *      the shared global key other attendance integration files also touch.
 *   F. §4.5 notify port: env-derived fields resolve from real env vars; the org-recipient-binding
 *      EXISTS query is asserted to be org-anchored.
 *
 * Deliberately deferred to the existing mock unit test (already covers it — see PR body): the
 * "missing table → 503 DB_NOT_READY" leg. Constructing a genuinely broken schema against the shared
 * CI Postgres would require an isolated schema/DB for one leg that's already exhaustively proven at
 * the mock level (`isDatabaseSchemaError` is a pure function of the driver error shape, not of
 * anything DB-specific), so the added real-DB complexity would not buy new confidence.
 *
 * Shared-DB fixture discipline: every fixture (org id, user id, corp id, resource name) is prefixed
 * `w40_<run>_` (a per-file-invocation-unique run suffix) — never a bare `Date.now()` — because
 * `plugin-tests.yml`'s attendance step runs many `.db.test.ts` files against ONE shared Postgres.
 * `vitest.integration.config.ts` also pins `fileParallelism: false` / `maxConcurrency: 1`, so files
 * never race each other; the prefix discipline still stands as defense-in-depth and for local re-runs.
 */
import express from 'express'
import request from 'supertest'
import { randomUUID } from 'crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

// Bypass the coarse, pre-existing RBAC gate — out of scope for this slice (see header). Keep the
// factory shape identical to the mock unit test so both files assert the exact same boundary.
vi.mock('../../src/rbac/rbac', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rbac/rbac')>()
  return {
    ...actual,
    rbacGuard: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  }
})
vi.mock('../../src/rbac/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rbac/service')>()
  return {
    ...actual,
    isAdmin: vi.fn(async () => false),
  }
})

// Real Postgres, spy-WRAPPED (not replaced): `vi.fn(actual.query)` still calls through to the real
// `poolManager` query implementation, so every assertion below is against real Postgres — the wrapper
// only gives `.mock.calls` visibility for the "zero aggregation SQL before 403" proof (§9 追加门禁1)
// and the org-anchor SQL-text audit (§4.2). This is the SAME technique the mock unit test would need
// if it wanted real-DB coverage — `vi.mock` with `importOriginal` is required here (not a bare
// `vi.spyOn(pgModule, 'query')`) because Vitest's ESM interop makes named exports non-configurable for
// direct property-level spying; replacing the whole module via the mock registry is what lets every
// importer (this file AND attendance-admin.ts) resolve to the same wrapped function.
vi.mock('../../src/db/pg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/pg')>()
  return { ...actual, query: vi.fn(actual.query) }
})

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const { attendanceAdminRouter } = await import('../../src/routes/attendance-admin')
const { query: mockedQuery } = await import('../../src/db/pg')
const queryMock = mockedQuery as unknown as ReturnType<typeof vi.fn>

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const PFX = `w40_${RUN}`
const SETTINGS_KEY = 'attendance.settings'

const ORG_A = `${PFX}_org_a`
const ORG_B = `${PFX}_org_b`
const ORG_EMPTY = `${PFX}_org_empty`

const ADMIN_ID = `${PFX}_admin`

function makeApp(user: Record<string, unknown> | null) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as express.Request & { user?: unknown }).user = user ?? undefined
    next()
  })
  app.use(attendanceAdminRouter())
  return app
}

describeIfDatabase('W4-0 GET /api/attendance-admin/setup-readiness (real DB)', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const pinned = usePinnedServer()

  const integrationIds: string[] = []
  let originalSettingsRow: { value: string } | null | undefined
  let originalEnv: Record<string, string | undefined> = {}

  const NOTIFY_ENV_KEYS = [
    'ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED',
    'ATTENDANCE_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED',
    'ATTENDANCE_NOTIFICATION_FAKE_CHANNEL_ENABLED',
  ]

  async function seedGroup(orgId: string, name: string): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO attendance_groups (org_id, name) VALUES ($1, $2) RETURNING id`,
      [orgId, name],
    )
    return r.rows[0].id
  }
  async function seedGroupMember(orgId: string, groupId: string, userId: string): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_group_members (org_id, group_id, user_id) VALUES ($1, $2, $3)`,
      [orgId, groupId, userId],
    )
  }
  async function seedShift(orgId: string, name: string): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO attendance_shifts (org_id, name) VALUES ($1, $2) RETURNING id`,
      [orgId, name],
    )
    return r.rows[0].id
  }
  async function seedRotationRule(orgId: string, name: string): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO attendance_rotation_rules (org_id, name) VALUES ($1, $2) RETURNING id`,
      [orgId, name],
    )
    return r.rows[0].id
  }
  async function seedApprovalFlow(orgId: string, name: string, requestType: string, isActive: boolean): Promise<string> {
    const id = randomUUID()
    await pool.query(
      `INSERT INTO attendance_approval_flows (id, org_id, name, request_type, steps, is_active)
       VALUES ($1, $2, $3, $4, '[]'::jsonb, $5)`,
      [id, orgId, name, requestType, isActive],
    )
    return id
  }
  async function seedDingtalkIntegration(orgId: string, name: string, corpId: string, status = 'active'): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id)
       VALUES ($1, 'dingtalk', $2, $3, $4) RETURNING id`,
      [orgId, name, status, corpId],
    )
    integrationIds.push(r.rows[0].id)
    return r.rows[0].id
  }
  async function seedDingtalkAccount(integrationId: string, externalUserId: string, externalKey: string, name: string): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, provider, external_user_id, external_key, name, is_active)
       VALUES ($1, 'dingtalk', $2, $3, $4, true) RETURNING id`,
      [integrationId, externalUserId, externalKey, name],
    )
    return r.rows[0].id
  }
  async function linkAccount(accountId: string, linkStatus: 'linked' | 'pending' = 'linked'): Promise<void> {
    // local_user_id intentionally NULL — the readiness queries (S7-5 reuse + §4.5 port) never filter
    // on it, and leaving it unset avoids needing a real `users` row for a directory_account_links FK.
    await pool.query(
      `INSERT INTO directory_account_links (directory_account_id, link_status, match_strategy)
       VALUES ($1, $2, 'manual')`,
      [accountId, linkStatus],
    )
  }
  async function seedMembership(orgId: string, userId: string, isActive = true): Promise<void> {
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = EXCLUDED.is_active`,
      [userId, orgId, isActive],
    )
  }

  async function snapshotSettings(): Promise<void> {
    const r = await pool.query<{ value: string }>(`SELECT value FROM system_configs WHERE key = $1`, [SETTINGS_KEY])
    originalSettingsRow = r.rows[0] ? { value: r.rows[0].value } : null
  }
  async function restoreSettings(): Promise<void> {
    if (originalSettingsRow === undefined) return
    if (originalSettingsRow === null) {
      await pool.query(`DELETE FROM system_configs WHERE key = $1`, [SETTINGS_KEY])
    } else {
      await pool.query(
        `INSERT INTO system_configs (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [SETTINGS_KEY, originalSettingsRow.value],
      )
    }
  }
  async function deleteSettingsRow(): Promise<void> {
    await pool.query(`DELETE FROM system_configs WHERE key = $1`, [SETTINGS_KEY])
  }
  async function writeSettingsPunchPolicy(punchPolicy: Record<string, unknown>): Promise<void> {
    await pool.query(
      `INSERT INTO system_configs (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [SETTINGS_KEY, JSON.stringify({ punchPolicy })],
    )
  }

  beforeAll(async () => {
    await snapshotSettings()
    for (const key of NOTIFY_ENV_KEYS) originalEnv[key] = process.env[key]

    // --- org A: the rich positive-control fixture ---
    await seedMembership(ORG_A, ADMIN_ID, true)
    await seedMembership(ORG_A, `${PFX}_member_2`, true)
    await seedMembership(ORG_A, `${PFX}_member_3`, true)
    await seedMembership(ORG_A, `${PFX}_member_inactive`, false) // proves the is_active filter

    const groupWithMembers = await seedGroup(ORG_A, `${PFX} group with members`)
    await seedGroup(ORG_A, `${PFX} group without members`) // proves groupCount !== groupsWithMembers
    await seedGroupMember(ORG_A, groupWithMembers, `${PFX}_member_2`)
    await seedGroupMember(ORG_A, groupWithMembers, `${PFX}_member_3`)

    await seedShift(ORG_A, `${PFX} shift AM`)
    await seedShift(ORG_A, `${PFX} shift PM`)

    await seedRotationRule(ORG_A, `${PFX} rotation`)

    await seedApprovalFlow(ORG_A, `${PFX} leave flow active`, 'leave', true)
    await seedApprovalFlow(ORG_A, `${PFX} leave flow inactive`, 'overtime', false) // proves is_active filter

    const orgAIntegration = await seedDingtalkIntegration(ORG_A, `${PFX} DT org A`, `${PFX}-corp-a`)
    const orgAAccount = await seedDingtalkAccount(orgAIntegration, `${PFX}-ext-a`, `${PFX}-key-a`, `${PFX} account A`)
    await linkAccount(orgAAccount, 'linked')

    // --- org B: forgery TARGET — the admin is deliberately NOT a member ---
    await seedMembership(ORG_B, `${PFX}_org_b_owner`, true) // someone else's org, never our admin
    const orgBGroup = await seedGroup(ORG_B, `${PFX} org B group`)
    await seedGroupMember(ORG_B, orgBGroup, `${PFX}_org_b_owner`)
    await seedShift(ORG_B, `${PFX} org B shift`)

    // --- org empty: membership only, zero of everything else ---
    await seedMembership(ORG_EMPTY, ADMIN_ID, true)
  }, 30000)

  afterAll(async () => {
    await restoreSettings()
    for (const key of NOTIFY_ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key]
      else process.env[key] = originalEnv[key]
    }
    for (const id of integrationIds) {
      await pool.query(`DELETE FROM directory_integrations WHERE id = $1`, [id]) // cascades accounts/links
    }
    await pool.query(`DELETE FROM attendance_approval_flows WHERE org_id LIKE $1`, [`${PFX}%`])
    await pool.query(`DELETE FROM attendance_rotation_rules WHERE org_id LIKE $1`, [`${PFX}%`])
    await pool.query(`DELETE FROM attendance_shifts WHERE org_id LIKE $1`, [`${PFX}%`])
    await pool.query(`DELETE FROM attendance_group_members WHERE org_id LIKE $1`, [`${PFX}%`])
    await pool.query(`DELETE FROM attendance_groups WHERE org_id LIKE $1`, [`${PFX}%`])
    await pool.query(`DELETE FROM user_orgs WHERE org_id LIKE $1`, [`${PFX}%`])
    await pool.end()
  })

  it('sentinel: DATABASE_URL is set (real-DB lane must not silently skip)', () => {
    expect(dbUrl).toBeTruthy()
  })

  it('A. cross-org forgery: org-A admin requesting orgId=B gets 403 and issues EXACTLY ONE query (the user_orgs door) — zero aggregation SQL', async () => {
    queryMock.mockClear()
    const app = makeApp({ id: ADMIN_ID })
    pinned.setApp(app)
    const res = await request(pinned.url()).get(`/api/attendance-admin/setup-readiness?orgId=${encodeURIComponent(ORG_B)}`)

    expect(res.status).toBe(403)
    expect(res.body?.error?.code).toBe('FORBIDDEN')

    const calls = queryMock.mock.calls as [string, unknown[]?][]
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toMatch(/user_orgs/i)
    expect(calls[0][1]).toEqual([ADMIN_ID, ORG_B])

    // Belt-and-suspenders: none of the aggregation tables ever appear in ANY captured SQL.
    const aggregationTables = [
      'attendance_groups', 'attendance_group_members', 'attendance_shifts',
      'attendance_rotation_rules', 'attendance_approval_flows', 'system_configs',
      'directory_account_links', 'directory_accounts', 'directory_integrations',
    ]
    for (const [sql] of calls) {
      for (const table of aggregationTables) {
        expect(sql).not.toMatch(new RegExp(table, 'i'))
      }
    }
  })

  it('B. positive control: org-A admin gets 200 with every org-scoped signal at its exact seeded value', async () => {
    queryMock.mockClear()
    const app = makeApp({ id: ADMIN_ID })
    pinned.setApp(app)
    const res = await request(pinned.url()).get(`/api/attendance-admin/setup-readiness?orgId=${encodeURIComponent(ORG_A)}`)

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const data = res.body.data

    expect(data.orgActiveMemberCount).toBe(3) // ADMIN_ID + member_2 + member_3 (inactive row excluded)
    expect(data.groupCount).toBe(2)
    expect(data.groupsWithMembers).toBe(1)
    expect(data.shiftCount).toBe(2)
    expect(data.rotationRuleCount).toBe(1)
    expect(data.hasRotationRules).toBe(true)
    expect(data.approvalFlowCount).toBe(1) // one active, one inactive seeded
    expect(data.directoryLinked).toBe(true)
    expect(data.notify.orgRecipientBindingReady).toBe(true)

    // Exact response key-set lock (§4.2), proven against a REAL response, not just the mock unit test.
    expect(Object.keys(data).sort()).toEqual(
      [
        'approvalFlowCount', 'deploymentScopedSignals', 'directoryLinked', 'groupCount',
        'groupsWithMembers', 'hasRotationRules', 'notify', 'orgActiveMemberCount', 'perStep',
        'punchPolicyPosture', 'rotationRuleCount', 'shiftCount',
      ].sort(),
    )

    // Values-free: no PII/identifying text anywhere in the real response payload.
    const flat = JSON.stringify(data)
    expect(flat).not.toMatch(/email|phone|mobile|password|secret|token/i)
    expect(flat).not.toContain(ADMIN_ID)
    expect(flat).not.toContain(`${PFX}-ext-a`)
  })

  it('C. empty org: a bare member sees every org-scoped signal at 0/false', async () => {
    const app = makeApp({ id: ADMIN_ID })
    pinned.setApp(app)
    const res = await request(pinned.url()).get(`/api/attendance-admin/setup-readiness?orgId=${encodeURIComponent(ORG_EMPTY)}`)

    expect(res.status).toBe(200)
    const data = res.body.data
    expect(data.orgActiveMemberCount).toBe(1) // only ADMIN_ID itself
    expect(data.groupCount).toBe(0)
    expect(data.groupsWithMembers).toBe(0)
    expect(data.shiftCount).toBe(0)
    expect(data.rotationRuleCount).toBe(0)
    expect(data.hasRotationRules).toBe(false)
    expect(data.approvalFlowCount).toBe(0)
    expect(data.directoryLinked).toBe(false)
    expect(data.notify.orgRecipientBindingReady).toBe(false)
  })

  it('D. org-anchor SQL audit: the real org-counts CTE anchors org_id = $1 exactly six times, single param, no PII columns', async () => {
    queryMock.mockClear()
    const app = makeApp({ id: ADMIN_ID })
    pinned.setApp(app)
    await request(pinned.url()).get(`/api/attendance-admin/setup-readiness?orgId=${encodeURIComponent(ORG_A)}`)

    const calls = queryMock.mock.calls as [string, unknown[]?][]
    const ctecall = calls.find(([sql]) => /WITH member_scope/i.test(sql))
    expect(ctecall).toBeTruthy()
    const [sql, params] = ctecall as [string, unknown[]]
    expect(params).toEqual([ORG_A])
    const orgAnchorMatches = sql.match(/org_id\s*=\s*\$1/g) ?? []
    expect(orgAnchorMatches.length).toBe(6)
    expect(sql).not.toMatch(/\$2\b/)
    expect(sql).not.toMatch(/email|phone|mobile|external_user_id|display_name|full_name/i)
  })

  it('E. ④ punch-policy posture against the real deployment-wide system_configs row (snapshot + restore)', async () => {
    try {
      // No row at all → 'default' (round-3 (b): the platform default is a legitimate ready state).
      await deleteSettingsRow()
      let app = makeApp({ id: ADMIN_ID })
      pinned.setApp(app)
      let res = await request(pinned.url()).get(`/api/attendance-admin/setup-readiness?orgId=${encodeURIComponent(ORG_A)}`)
      expect(res.body.data.punchPolicyPosture).toBe('default')

      // A row exists but matches the normalized defaults exactly → still 'default'.
      await writeSettingsPunchPolicy({
        unscheduled: { mode: 'allow' },
        merge: { internalWinsOnIn: false, externalWinsOnOut: false },
        outdoor: { requireApproval: false, requireNote: false, requirePhoto: false, approvalFlowId: '' },
      })
      app = makeApp({ id: ADMIN_ID })
      pinned.setApp(app)
      res = await request(pinned.url()).get(`/api/attendance-admin/setup-readiness?orgId=${encodeURIComponent(ORG_A)}`)
      expect(res.body.data.punchPolicyPosture).toBe('default')

      // A row diverges from the defaults → 'customized' (round-3 (b): also 'ready' at the discriminator
      // layer, but a DISTINCT posture value — the FE never sees the settings VALUES, only this enum).
      await writeSettingsPunchPolicy({
        unscheduled: { mode: 'block' },
        merge: { internalWinsOnIn: false, externalWinsOnOut: false },
        outdoor: { requireApproval: false, requireNote: false, requirePhoto: false, approvalFlowId: '' },
      })
      app = makeApp({ id: ADMIN_ID })
      pinned.setApp(app)
      res = await request(pinned.url()).get(`/api/attendance-admin/setup-readiness?orgId=${encodeURIComponent(ORG_A)}`)
      expect(res.body.data.punchPolicyPosture).toBe('customized')

      // Values-free: the customized punch-policy VALUE ('block') never appears in the response.
      expect(JSON.stringify(res.body.data)).not.toContain('block')
    } finally {
      await restoreSettings()
    }
  })

  it('F. §4.5 notify port: env-derived fields resolve live, org-recipient-binding query is org-anchored', async () => {
    queryMock.mockClear()
    process.env.ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED = 'true'
    process.env.ATTENDANCE_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED = 'true'
    delete process.env.ATTENDANCE_NOTIFICATION_FAKE_CHANNEL_ENABLED
    try {
      const app = makeApp({ id: ADMIN_ID })
      pinned.setApp(app)
      const res = await request(pinned.url()).get(`/api/attendance-admin/setup-readiness?orgId=${encodeURIComponent(ORG_A)}`)
      expect(res.status).toBe(200)
      expect(res.body.data.notify).toEqual({
        workerEnabled: true,
        defaultChannelAvailable: true,
        availableChannelCount: 1,
        orgRecipientBindingReady: true,
      })

      const calls = queryMock.mock.calls as [string, unknown[]?][]
      const notifyCall = calls.find(([sql]) => /directory_account_links/i.test(sql) && /provider = 'dingtalk'/i.test(sql))
      expect(notifyCall).toBeTruthy()
      const [sql, params] = notifyCall as [string, unknown[]]
      expect(params).toEqual([ORG_A])
      expect(sql).toMatch(/org_id\s*=\s*\$1/)
      expect(sql).not.toMatch(/env|channel_name|credential|secret|token/i)
    } finally {
      for (const key of NOTIFY_ENV_KEYS) {
        if (originalEnv[key] === undefined) delete process.env[key]
        else process.env[key] = originalEnv[key]
      }
    }
  })
})
