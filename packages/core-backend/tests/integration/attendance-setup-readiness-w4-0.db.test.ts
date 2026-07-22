/**
 * W4-0 (Wave 4 onboarding design-lock 2026-07-21, RATIFIED §3/§4/§9): real-Postgres coverage of
 * `GET /api/attendance-admin/setup-readiness` and its computational core
 * (`services/AttendanceSetupReadinessAggregate.ts`). The mock-level unit test
 * (`tests/unit/attendance-admin-setup-readiness-w4-0.test.ts`) already covers query-shape/branch
 * coverage exhaustively; THIS file proves the things only real Postgres can prove:
 *   G1 — the org-membership door (two-org forgery + platform-admin single-column-labeled bypass);
 *   G2 — `SET TRANSACTION READ ONLY` actually REJECTS a write, a writable CTE, and a multi-statement
 *        batch (a mock cannot prove Postgres's own enforcement — this is the ONLY authorized proof,
 *        §4.2/§9 W4-0-G2);
 *   G3 — ①'s two positive controls (pure local org / DingTalk-linked org), both `ready`, proving
 *        `directoryLinked` is display-only and never gates;
 *   G4 — ⑥'s three independent notify signals against real directory tables + a real (mocked-
 *        singleton) scheduler state, and previewReady's independence from every combination;
 *   G5 — ④'s closed-set posture against a REAL `system_configs` row: positive control (punchPolicy
 *        change ⇒ customized) and negative control (an UNRELATED key changing ⇒ still default).
 *
 * Scope boundary (deliberate — read before "fixing" the auth setup, mirrors the S7-5 precedent):
 * the router's COARSE permission gate (`rbacGuard('attendance','admin')`) and the platform-admin
 * shortcut (`isRbacAdmin`) are pre-existing shared middleware exercised elsewhere; this file mocks
 * BOTH (bypass / per-userId-string) and keeps `../../src/db/pg`'s `query` AND `transaction` REAL
 * (each wrapped in `vi.fn(actual.fn)` so every call still hits Postgres, while `.mock.calls` gives
 * spy visibility for the "zero aggregation before 403" and SQL-text-audit proofs). The scheduler
 * SINGLETON (`getSharedAttendanceScheduler`) is mocked too — deliberately NOT started for real,
 * because the real `AttendanceScheduler.start()` registers hour-scale interval timers and an
 * optional Redis leader lock that would outlive this file's test run; G4 is about the readiness
 * PORT's decision logic (null vs non-null), which a controllable mock proves without that risk.
 *
 * Shared-DB fixture discipline: every fixture id is prefixed `w40_<run>_` — never a bare
 * `Date.now()` alone — because `plugin-tests.yml`'s attendance step runs many `.db.test.ts` files
 * against ONE shared Postgres; `vitest.integration.config.ts` also pins `fileParallelism: false`
 * so files never race, but the prefix stands as defense-in-depth.
 *
 * Fixture shape reference (per-table, so a future maintainer does not have to re-derive it from
 * migrations): `users(id, password_hash, is_active)` — minimal row satisfying the ① dual is_active
 * join; `user_orgs(user_id, org_id, is_active)`; `attendance_groups(org_id, name, attendance_type?)`;
 * `attendance_group_members(org_id, group_id, user_id)`; `attendance_shifts(org_id, name)`;
 * `attendance_rotation_rules(org_id, name, is_active?)`; `attendance_approval_flows(id, org_id,
 * name, request_type, steps, is_active)`; `directory_integrations(org_id, provider, name, status,
 * corp_id)`; `directory_accounts(integration_id, provider, external_user_id, external_key, name,
 * is_active)`; `directory_account_links(directory_account_id, link_status, match_strategy,
 * local_user_id)` (local_user_id set to a real seeded `users.id` — the readiness query REQUIRES
 * `local_user_id IS NOT NULL`, mirroring `resolveRecipient`'s own `WHERE l.local_user_id = $1`, see
 * §4.5(ii)); `system_configs(key, value)` for the ONE deployment-wide `attendance.settings` row.
 */
import express from 'express'
import request from 'supertest'
import { randomUUID } from 'crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const getSharedAttendanceSchedulerMock = vi.fn()
vi.mock('../../src/services/AttendanceScheduler', () => ({
  getSharedAttendanceScheduler: () => getSharedAttendanceSchedulerMock(),
}))

vi.mock('../../src/rbac/rbac', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rbac/rbac')>()
  return {
    ...actual,
    rbacGuard: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  }
})
vi.mock('../../src/rbac/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rbac/service')>()
  return { ...actual, isAdmin: vi.fn(async (userId: string) => userId.endsWith('_platform_admin')) }
})

// Real Postgres, spy-WRAPPED (not replaced): `vi.fn(actual.fn)` still calls through to the real
// `poolManager` implementation, so every assertion below is against real Postgres — the wrapper
// only gives `.mock.calls` visibility for the "zero aggregation before 403" proof (§9 W4-0-G1) and
// the org-anchor SQL-text audit (§4.2). `vi.mock` + `importOriginal` is required (not
// `vi.spyOn(pgModule, 'query')`) because Vitest's ESM interop makes named exports non-configurable
// for direct property-level spying.
vi.mock('../../src/db/pg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/pg')>()
  return { ...actual, query: vi.fn(actual.query), transaction: vi.fn(actual.transaction) }
})

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const { attendanceAdminRouter } = await import('../../src/routes/attendance-admin')
const { query: mockedQuery, transaction: mockedTransaction } = await import('../../src/db/pg')
const {
  runAttendanceSetupReadinessReadOnly,
  readAttendanceSetupReadinessOrgCounts,
} = await import('../../src/services/AttendanceSetupReadinessAggregate')
const queryMock = mockedQuery as unknown as ReturnType<typeof vi.fn>
const transactionMock = mockedTransaction as unknown as ReturnType<typeof vi.fn>

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const PFX = `w40_${RUN}`
const SETTINGS_KEY = 'attendance.settings'

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

// Fail-closed sentinel (trilens review: a sentinel placed INSIDE `describeIfDatabase` is
// structurally unable to ever fire when DATABASE_URL is unset — that whole block is
// `describe.skip`-ed, and a skipped test cannot itself go red). Kept at MODULE scope, a sibling of
// `describeIfDatabase(...)` below, not nested inside it, so it runs unconditionally: if this whole
// real-DB lane were ever invoked without DATABASE_URL set (e.g. a workflow-file misconfiguration),
// THIS is the one assertion that still executes and goes red, rather than the entire G1-G5 file
// silently reporting zero failures. `plugin-tests.yml`'s attendance step also shell-guards
// `DATABASE_URL` before ever reaching vitest, and `vitest.config.ts` excludes this file from the
// no-DB unit lane — this sentinel is defense-in-depth on top of those, not a substitute for them.
it('sentinel: DATABASE_URL is set (real-DB lane must not silently skip)', () => {
  expect(dbUrl).toBeTruthy()
})

describeIfDatabase('W4-0 GET /api/attendance-admin/setup-readiness (real DB)', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const pinned = usePinnedServer()

  const integrationIds: string[] = []
  let originalSettingsRow: { value: string } | null | undefined

  async function seedUser(userId: string, isActive = true): Promise<void> {
    await pool.query(
      `INSERT INTO users (id, password_hash, is_active) VALUES ($1, 'x', $2)
       ON CONFLICT (id) DO UPDATE SET is_active = EXCLUDED.is_active`,
      [userId, isActive],
    )
  }
  // `userIsActive` is a SEPARATE knob from `isActive` (which is `user_orgs.is_active`) — the ①
  // count is a DOUBLE filter (`user_orgs.is_active=true` AND `users.is_active=true`, RD-3), and
  // until this fix every caller passed `seedUser(userId, true)` unconditionally, leaving the
  // `users.is_active=false` leg of that double filter with zero real-DB behavioural coverage
  // (P2 — only a source-text regex asserted the SQL mentions `u.is_active = true` at all).
  async function seedMembership(
    orgId: string,
    userId: string,
    isActive = true,
    userIsActive = true,
  ): Promise<void> {
    await seedUser(userId, userIsActive)
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = EXCLUDED.is_active`,
      [userId, orgId, isActive],
    )
  }
  async function seedGroup(orgId: string, name: string, attendanceType = 'fixed_shift'): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO attendance_groups (org_id, name, attendance_type) VALUES ($1, $2, $3) RETURNING id`,
      [orgId, name, attendanceType],
    )
    return r.rows[0].id
  }
  async function seedGroupMember(orgId: string, groupId: string, userId: string): Promise<void> {
    await seedUser(userId, true)
    await pool.query(`INSERT INTO attendance_group_members (org_id, group_id, user_id) VALUES ($1, $2, $3)`, [
      orgId,
      groupId,
      userId,
    ])
  }
  async function seedShift(orgId: string, name: string): Promise<string> {
    const r = await pool.query<{ id: string }>(`INSERT INTO attendance_shifts (org_id, name) VALUES ($1, $2) RETURNING id`, [
      orgId,
      name,
    ])
    return r.rows[0].id
  }
  async function seedRotationRule(orgId: string, name: string, isActive = true): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO attendance_rotation_rules (org_id, name, is_active) VALUES ($1, $2, $3) RETURNING id`,
      [orgId, name, isActive],
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
  // `localUserId` is REQUIRED (not optional) — a NULL `local_user_id` link can never be resolved by
  // `AttendanceNotificationDeliveryWorker.resolveRecipient` (`WHERE l.local_user_id = $1`), so
  // `readAttendanceSetupReadinessOrgRecipientBinding` correctly excludes it too (P2 fix — the prior
  // fixture left this NULL and the query never filtered on it, silently counting an unresolvable
  // link as a "bound recipient"). Callers pass an id already seeded via `seedMembership`/`seedUser`
  // so the `users.id` FK is satisfied.
  async function linkAccount(
    accountId: string,
    linkStatus: 'linked' | 'pending' = 'linked',
    localUserId: string,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO directory_account_links (directory_account_id, link_status, match_strategy, local_user_id)
       VALUES ($1, $2, 'manual', $3)`,
      [accountId, linkStatus, localUserId],
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
  async function writeSettingsRow(value: Record<string, unknown>): Promise<void> {
    await pool.query(
      `INSERT INTO system_configs (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [SETTINGS_KEY, JSON.stringify(value)],
    )
  }
  async function deleteSettingsRow(): Promise<void> {
    await pool.query(`DELETE FROM system_configs WHERE key = $1`, [SETTINGS_KEY])
  }

  const NORMALIZED_DEFAULT_PUNCH_POLICY = {
    unscheduled: { mode: 'allow' },
    merge: { internalWinsOnIn: false, externalWinsOnOut: false },
    outdoor: { requireApproval: false, requireNote: false, requirePhoto: false, approvalFlowId: '' },
  }

  beforeAll(async () => {
    await snapshotSettings()
  }, 30000)

  afterAll(async () => {
    await restoreSettings()
    for (const id of integrationIds) {
      await pool.query(`DELETE FROM directory_integrations WHERE id = $1`, [id]) // cascades accounts/links
    }
    await pool.query(`DELETE FROM attendance_approval_flows WHERE org_id LIKE $1`, [`${PFX}%`])
    await pool.query(`DELETE FROM attendance_rotation_rules WHERE org_id LIKE $1`, [`${PFX}%`])
    await pool.query(`DELETE FROM attendance_shifts WHERE org_id LIKE $1`, [`${PFX}%`])
    await pool.query(`DELETE FROM attendance_group_members WHERE org_id LIKE $1`, [`${PFX}%`])
    await pool.query(`DELETE FROM attendance_groups WHERE org_id LIKE $1`, [`${PFX}%`])
    await pool.query(`DELETE FROM user_orgs WHERE org_id LIKE $1`, [`${PFX}%`])
    await pool.query(`DELETE FROM users WHERE id LIKE $1`, [`${PFX}%`])
    await pool.end()
  })

  beforeEach(() => {
    getSharedAttendanceSchedulerMock.mockReset()
    getSharedAttendanceSchedulerMock.mockReturnValue(null)
  })

  describe('§9 W4-0-G1: org-membership door (two-org forgery + platform-admin bypass)', () => {
    const ORG_A = `${PFX}_g1_org_a`
    const ORG_B = `${PFX}_g1_org_b`
    const ADMIN_ID = `${PFX}_g1_admin`

    beforeAll(async () => {
      // "该受托管理员" — writ per the lock's exact test identity: attendance:admin only (rbacGuard
      // is bypassed here, mirroring only the coarse gate — see file header), active member of A,
      // NOT a member of B, and — critically — NOT a platform admin (the mocked `isAdmin` only
      // returns true for ids ending `_platform_admin`, so this id is fail-closed false).
      await seedMembership(ORG_A, ADMIN_ID, true)
      // A minimal but non-empty org A so the 200 path exercises real aggregation, not just auth.
      const g = await seedGroup(ORG_A, `${PFX} g1 group`)
      await seedGroupMember(ORG_A, g, ADMIN_ID)
      await seedShift(ORG_A, `${PFX} g1 shift`)
      await seedApprovalFlow(ORG_A, `${PFX} g1 flow`, 'leave', true)
      // Org B exists (someone else's org) — the admin above is deliberately NOT a member.
      const ownerB = `${PFX}_g1_org_b_owner`
      await seedMembership(ORG_B, ownerB, true)
    }, 30000)

    afterAll(async () => {
      await pool.query(`DELETE FROM attendance_approval_flows WHERE org_id = $1`, [ORG_A])
      await pool.query(`DELETE FROM attendance_shifts WHERE org_id = $1`, [ORG_A])
      await pool.query(`DELETE FROM attendance_group_members WHERE org_id = $1`, [ORG_A])
      await pool.query(`DELETE FROM attendance_groups WHERE org_id = $1`, [ORG_A])
      await pool.query(`DELETE FROM user_orgs WHERE org_id IN ($1, $2)`, [ORG_A, ORG_B])
    })

    beforeEach(() => {
      queryMock.mockClear()
      transactionMock.mockClear()
    })

    it('case 1: delegated admin, orgId=A (own org) ⇒ 200', async () => {
      const app = makeApp({ id: ADMIN_ID })
      pinned.setApp(app)
      const res = await request(pinned.url()).get(`/api/attendance-admin/setup-readiness?orgId=${encodeURIComponent(ORG_A)}`)
      expect(res.status).toBe(200)
      expect(res.body.data.viewerIsPlatformAdmin).toBe(false)
      expect(res.body.data.orgActiveMemberCount).toBe(1)
    })

    it('case 2: delegated admin forges orgId=B ⇒ 403 BEFORE any aggregation SQL (transaction never opened)', async () => {
      const app = makeApp({ id: ADMIN_ID })
      pinned.setApp(app)
      const res = await request(pinned.url()).get(`/api/attendance-admin/setup-readiness?orgId=${encodeURIComponent(ORG_B)}`)
      expect(res.status).toBe(403)
      expect(res.body?.error?.code).toBe('FORBIDDEN')
      // Mutation target: reordering aggregation before authz would make this fail.
      expect(transactionMock).not.toHaveBeenCalled()
      // Exactly the one user_orgs membership-door query — no aggregation query at all.
      expect(queryMock).toHaveBeenCalledTimes(1)
      const [sql] = queryMock.mock.calls[0] as [string]
      expect(sql).toMatch(/user_orgs/)
    })

    it('case 3 (single-column-labeled bypass — does NOT substitute for case 2): platform admin, orgId=B ⇒ 200, zero user_orgs query', async () => {
      const platformAdminId = `${PFX}_g1_platform_admin`
      const app = makeApp({ id: platformAdminId })
      pinned.setApp(app)
      const res = await request(pinned.url()).get(`/api/attendance-admin/setup-readiness?orgId=${encodeURIComponent(ORG_B)}`)
      expect(res.status).toBe(200)
      expect(res.body.data.viewerIsPlatformAdmin).toBe(true)
      // The platform-admin shortcut (hasLegacyAdminClaim/isRbacAdmin) returns true BEFORE ever
      // querying user_orgs — this 200 proves the bypass exists, NOT that the org-membership door
      // works (that is case 2's job, and the real-DB two-org matrix's job as a whole).
      expect(queryMock).not.toHaveBeenCalled()
      expect(transactionMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('§9 W4-0-G2: read-only transaction — the ONLY authorized proof (real Postgres rejection)', () => {
    const ORG_RO = `${PFX}_g2_org`

    beforeAll(async () => {
      await seedShift(ORG_RO, `${PFX} g2 shift`)
    })
    afterAll(async () => {
      await pool.query(`DELETE FROM attendance_shifts WHERE org_id = $1`, [ORG_RO])
    })

    it('positive control: a legal SELECT succeeds inside the seam', async () => {
      const result = await runAttendanceSetupReadinessReadOnly(async (q) => {
        const r = await q<{ n: number }>('SELECT COUNT(*)::int AS n FROM attendance_shifts WHERE org_id = $1', [ORG_RO])
        return r.rows[0]?.n
      })
      expect(result).toBe(1)
    })

    it('rejects a bare UPDATE (first-word check would have PASSED this if it looked like SELECT — it does not even look like one, proving the guard is not text-based)', async () => {
      await expect(
        runAttendanceSetupReadinessReadOnly(async (q) => {
          await q(`UPDATE attendance_shifts SET name = name WHERE org_id = $1`, [ORG_RO])
        }),
      ).rejects.toThrow(/read-only transaction/i)
    })

    it('rejects a writable CTE — proves the guard is NOT a first-word/regex check (a WITH-prefix text check would PASS this)', async () => {
      await expect(
        runAttendanceSetupReadinessReadOnly(async (q) => {
          await q(
            `WITH d AS (DELETE FROM attendance_shifts WHERE org_id = $1 AND false RETURNING 1)
             SELECT COUNT(*)::int AS n FROM d`,
            [ORG_RO],
          )
        }),
      ).rejects.toThrow(/read-only transaction/i)
    })

    it('rejects a multi-statement batch (SELECT 1; DELETE ...) — a SELECT-prefix text check would PASS this', async () => {
      await expect(
        runAttendanceSetupReadinessReadOnly(async (q) => {
          // No params ⇒ node-pg's simple-query protocol, which executes every ;-separated
          // statement in the batch — the exact shape the design lock names as un-catchable by a
          // prefix/regex check.
          await q(`SELECT 1; DELETE FROM attendance_shifts WHERE org_id = 'nonexistent-org-guard'`)
        }),
      ).rejects.toThrow(/read-only transaction/i)
    })

    it('a rejected write leaves no trace — the shift count is unchanged after all three reject attempts', async () => {
      const result = await runAttendanceSetupReadinessReadOnly(async (q) => {
        const r = await q<{ n: number }>('SELECT COUNT(*)::int AS n FROM attendance_shifts WHERE org_id = $1', [ORG_RO])
        return r.rows[0]?.n
      })
      expect(result).toBe(1)
    })

    it('the production org-counts CTE itself runs cleanly through the seam (positive control, not just synthetic SQL)', async () => {
      const counts = await runAttendanceSetupReadinessReadOnly((q) => readAttendanceSetupReadinessOrgCounts(ORG_RO, q))
      expect(counts.shiftCount).toBe(1)
    })
  })

  describe('§9 W4-0-G3: ① two positive controls (P2-3, directoryLinked never gates)', () => {
    const ORG_LOCAL = `${PFX}_g3_local`
    const ORG_DINGTALK = `${PFX}_g3_dingtalk`
    const ADMIN_LOCAL = `${PFX}_g3_admin_local`
    const ADMIN_DT = `${PFX}_g3_admin_dt`

    beforeAll(async () => {
      // Positive control 1: PURE LOCAL org — active member, ZERO directory_account_links rows, AND
      // (P2 fix — a bare orgActiveMemberCount>0 check cannot distinguish "① is judged ready" from
      // "① is judged ready by an implementation that ALSO requires directoryLinked", since the
      // fixture below never populated ②③⑤ to make previewReady observable) a full ①②③⑤ fixture so
      // previewReady is independently, behaviourally provable — a mutant that ANDs step① with
      // `directoryLinked` (which is false here) would flip previewReady to false and this test
      // would catch it; a bare orgActiveMemberCount assertion alone would not.
      await seedMembership(ORG_LOCAL, ADMIN_LOCAL, true)
      const localGroup = await seedGroup(ORG_LOCAL, `${PFX} g3 local group`)
      await seedGroupMember(ORG_LOCAL, localGroup, ADMIN_LOCAL)
      await seedShift(ORG_LOCAL, `${PFX} g3 local shift`)
      await seedApprovalFlow(ORG_LOCAL, `${PFX} g3 local flow`, 'leave', true)

      // Positive control 2: DingTalk-LINKED org — active member AND a linked dingtalk account.
      await seedMembership(ORG_DINGTALK, ADMIN_DT, true)
      const integration = await seedDingtalkIntegration(ORG_DINGTALK, `${PFX} g3 dt integration`, `${PFX}-g3-corp`)
      const account = await seedDingtalkAccount(integration, `${PFX}-g3-ext`, `${PFX}-g3-key`, `${PFX} g3 account`)
      await linkAccount(account, 'linked', ADMIN_DT)
    }, 30000)

    afterAll(async () => {
      await pool.query(`DELETE FROM attendance_approval_flows WHERE org_id = $1`, [ORG_LOCAL])
      await pool.query(`DELETE FROM attendance_shifts WHERE org_id = $1`, [ORG_LOCAL])
      await pool.query(`DELETE FROM attendance_group_members WHERE org_id = $1`, [ORG_LOCAL])
      await pool.query(`DELETE FROM attendance_groups WHERE org_id = $1`, [ORG_LOCAL])
      await pool.query(`DELETE FROM user_orgs WHERE org_id IN ($1, $2)`, [ORG_LOCAL, ORG_DINGTALK])
    })

    it('pure local org: orgActiveMemberCount>0, directoryLinked=false, AND previewReady=true (directoryLinked never gates ① or ⑦)', async () => {
      const app = makeApp({ id: ADMIN_LOCAL })
      pinned.setApp(app)
      const res = await request(pinned.url()).get(
        `/api/attendance-admin/setup-readiness?orgId=${encodeURIComponent(ORG_LOCAL)}`,
      )
      expect(res.status).toBe(200)
      expect(res.body.data.orgActiveMemberCount).toBe(1)
      expect(res.body.data.directoryLinked).toBe(false)
      // Mutation target (P2): an implementation that computed ① (or previewReady) as
      // `orgActiveMemberCount>0 && directoryLinked` would flip this to false — directoryLinked is
      // false here by construction, so this is the actual, behavioural "OR semantics" proof the
      // frozen `orgActiveMemberCount` assertion above could not provide on its own.
      expect(res.body.data.previewReady).toBe(true)
    })

    it('DingTalk-linked org: orgActiveMemberCount>0 AND directoryLinked=true, both correctly reported', async () => {
      const app = makeApp({ id: ADMIN_DT })
      pinned.setApp(app)
      const res = await request(pinned.url()).get(
        `/api/attendance-admin/setup-readiness?orgId=${encodeURIComponent(ORG_DINGTALK)}`,
      )
      expect(res.status).toBe(200)
      expect(res.body.data.orgActiveMemberCount).toBe(1)
      expect(res.body.data.directoryLinked).toBe(true)
    })
  })

  describe('§9 W4-0-G4: ⑥ three independent notify signals + previewReady independence (real DB)', () => {
    const ORG_NOTIFY = `${PFX}_g4_org`
    const ADMIN_NOTIFY = `${PFX}_g4_admin`

    beforeAll(async () => {
      await seedMembership(ORG_NOTIFY, ADMIN_NOTIFY, true)
      // Fully "previewReady-able" org, so the notify combinations below can prove previewReady is
      // UNAFFECTED by them (not just vacuously false already).
      const g = await seedGroup(ORG_NOTIFY, `${PFX} g4 group`)
      await seedGroupMember(ORG_NOTIFY, g, ADMIN_NOTIFY)
      await seedShift(ORG_NOTIFY, `${PFX} g4 shift`)
      await seedApprovalFlow(ORG_NOTIFY, `${PFX} g4 flow`, 'leave', true)
      // A bound DingTalk recipient, so orgRecipientBinding can be exercised non-trivially.
      const integration = await seedDingtalkIntegration(ORG_NOTIFY, `${PFX} g4 dt integration`, `${PFX}-g4-corp`)
      const account = await seedDingtalkAccount(integration, `${PFX}-g4-ext`, `${PFX}-g4-key`, `${PFX} g4 account`)
      await linkAccount(account, 'linked', ADMIN_NOTIFY)
    }, 30000)

    afterAll(async () => {
      await pool.query(`DELETE FROM attendance_approval_flows WHERE org_id = $1`, [ORG_NOTIFY])
      await pool.query(`DELETE FROM attendance_shifts WHERE org_id = $1`, [ORG_NOTIFY])
      await pool.query(`DELETE FROM attendance_group_members WHERE org_id = $1`, [ORG_NOTIFY])
      await pool.query(`DELETE FROM attendance_groups WHERE org_id = $1`, [ORG_NOTIFY])
      await pool.query(`DELETE FROM user_orgs WHERE org_id = $1`, [ORG_NOTIFY])
    })

    it('scheduler NOT started (null) ⇒ deliveryRuntime=not_ready, EVEN WITH the worker-enabled env var set true', async () => {
      const original = process.env.ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED
      process.env.ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED = 'true'
      getSharedAttendanceSchedulerMock.mockReturnValue(null)
      try {
        const app = makeApp({ id: ADMIN_NOTIFY })
        pinned.setApp(app)
        const res = await request(pinned.url()).get(
          `/api/attendance-admin/setup-readiness?orgId=${encodeURIComponent(ORG_NOTIFY)}`,
        )
        expect(res.status).toBe(200)
        // Mutation target: reading the env var instead of the scheduler singleton would flip this.
        expect(res.body.data.notify.deliveryRuntime).toBe('not_ready')
        expect(res.body.data.previewReady).toBe(true)
      } finally {
        if (original === undefined) delete process.env.ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED
        else process.env.ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED = original
      }
    })

    it('scheduler STARTED (non-null) ⇒ deliveryRuntime=unknown (never ready), previewReady still unaffected', async () => {
      getSharedAttendanceSchedulerMock.mockReturnValue({ started: true })
      const app = makeApp({ id: ADMIN_NOTIFY })
      pinned.setApp(app)
      const res = await request(pinned.url()).get(
        `/api/attendance-admin/setup-readiness?orgId=${encodeURIComponent(ORG_NOTIFY)}`,
      )
      expect(res.status).toBe(200)
      expect(res.body.data.notify.deliveryRuntime).toBe('unknown')
      expect(res.body.data.previewReady).toBe(true)
    })

    it('orgRecipientBinding reflects the real seeded DingTalk link (boundRecipientCount>=1)', async () => {
      const app = makeApp({ id: ADMIN_NOTIFY })
      pinned.setApp(app)
      const res = await request(pinned.url()).get(
        `/api/attendance-admin/setup-readiness?orgId=${encodeURIComponent(ORG_NOTIFY)}`,
      )
      expect(res.body.data.notify.orgRecipientBinding.boundRecipientCount).toBeGreaterThanOrEqual(1)
      expect(res.body.data.notify.orgRecipientBinding.hasAnyBoundRecipient).toBe(true)
    })

    it('recipientScopeConfig is always unsupported, and previewReady is unaffected by ANY of the above', async () => {
      const app = makeApp({ id: ADMIN_NOTIFY })
      pinned.setApp(app)
      const res = await request(pinned.url()).get(
        `/api/attendance-admin/setup-readiness?orgId=${encodeURIComponent(ORG_NOTIFY)}`,
      )
      expect(res.body.data.notify.recipientScopeConfig).toBe('unsupported')
      expect(res.body.data.previewReady).toBe(true)
    })
  })

  describe('§9 W4-0-G5: ④ closed-set posture against a REAL system_configs row', () => {
    const ORG_G5 = `${PFX}_g5_org`
    const ADMIN_G5 = `${PFX}_g5_admin`

    beforeAll(async () => {
      await seedMembership(ORG_G5, ADMIN_G5, true)
    })
    afterAll(async () => {
      await pool.query(`DELETE FROM user_orgs WHERE org_id = $1`, [ORG_G5])
    })

    async function readPosture(): Promise<string> {
      const app = makeApp({ id: ADMIN_G5 })
      pinned.setApp(app)
      const res = await request(pinned.url()).get(`/api/attendance-admin/setup-readiness?orgId=${encodeURIComponent(ORG_G5)}`)
      expect(res.status).toBe(200)
      return res.body.data.punchPolicyPosture
    }

    it('no system_configs row at all ⇒ default', async () => {
      await deleteSettingsRow()
      expect(await readPosture()).toBe('default')
    })

    it('row equals normalized defaults exactly ⇒ default', async () => {
      await writeSettingsRow({
        punchPolicy: NORMALIZED_DEFAULT_PUNCH_POLICY,
        ipAllowlist: [],
        geoFence: null,
        minPunchIntervalMinutes: 1,
      })
      expect(await readPosture()).toBe('default')
    })

    it('negative control: ONLY holidaySync.lastRun differs (simulated machine write) ⇒ STILL default', async () => {
      await writeSettingsRow({
        punchPolicy: NORMALIZED_DEFAULT_PUNCH_POLICY,
        ipAllowlist: [],
        geoFence: null,
        minPunchIntervalMinutes: 1,
        holidaySync: { lastRun: new Date().toISOString() },
      })
      // Mutation target: an implementation that compares the WHOLE settings blob (not just the
      // §3.1 closed set) would misreport this as customized.
      expect(await readPosture()).toBe('default')
    })

    it('negative control: ONLY annualLeavePolicy differs ⇒ STILL default', async () => {
      await writeSettingsRow({
        punchPolicy: NORMALIZED_DEFAULT_PUNCH_POLICY,
        ipAllowlist: [],
        geoFence: null,
        minPunchIntervalMinutes: 1,
        annualLeavePolicy: { enabled: true, accrualDays: 5 },
      })
      expect(await readPosture()).toBe('default')
    })

    it('positive control: punchPolicy.unscheduled.mode differs ⇒ customized', async () => {
      await writeSettingsRow({
        punchPolicy: { ...NORMALIZED_DEFAULT_PUNCH_POLICY, unscheduled: { mode: 'block' } },
        ipAllowlist: [],
        geoFence: null,
        minPunchIntervalMinutes: 1,
      })
      expect(await readPosture()).toBe('customized')
    })

    it('positive control: ipAllowlist differs ⇒ customized', async () => {
      await writeSettingsRow({
        punchPolicy: NORMALIZED_DEFAULT_PUNCH_POLICY,
        ipAllowlist: ['10.0.0.0/8'],
        geoFence: null,
        minPunchIntervalMinutes: 1,
      })
      expect(await readPosture()).toBe('customized')
    })
  })

  describe('org-anchor SQL audit against REAL Postgres, with exact seeded counts (§4.2 追加门禁2)', () => {
    const ORG_AUDIT = `${PFX}_audit_org`
    const afterAllExtraOrgIds: string[] = []

    beforeAll(async () => {
      // "Rich" fixture — non-zero, DISTINCT values on every leg so a leg that silently counted
      // across all orgs (dropping its own org_id filter) would visibly diverge from a leg that
      // didn't, rather than every count coincidentally matching by chance.
      const memberA = `${PFX}_audit_member_a`
      const memberB = `${PFX}_audit_member_b`
      const memberInactive = `${PFX}_audit_member_inactive`
      const memberPlatformDeactivated = `${PFX}_audit_member_platform_deactivated`
      await seedMembership(ORG_AUDIT, memberA, true)
      await seedMembership(ORG_AUDIT, memberB, true)
      await seedMembership(ORG_AUDIT, memberInactive, false) // proves the user_orgs.is_active filter
      // P2 fix: user_orgs.is_active=true but users.is_active=false — e.g. a platform-level
      // deactivation (PATCH /api/admin/users/:id/status) that deliberately never touches user_orgs.
      // Before this fixture, the RD-3 double-filter's users.is_active leg had zero real-DB
      // behavioural coverage (only a source-text regex in the unit test asserted the SQL mentions
      // it). Mutation target: dropping `AND u.is_active = true` from member_scope would count this
      // member too, inflating orgActiveMemberCount to 3.
      await seedMembership(ORG_AUDIT, memberPlatformDeactivated, true, false)

      const groupWithMembers = await seedGroup(ORG_AUDIT, `${PFX} audit group with members`)
      await seedGroup(ORG_AUDIT, `${PFX} audit group without members`) // groupCount !== groupsWithMembers
      await seedGroupMember(ORG_AUDIT, groupWithMembers, memberA)
      await seedGroupMember(ORG_AUDIT, groupWithMembers, memberB)

      await seedShift(ORG_AUDIT, `${PFX} audit shift AM`)
      await seedShift(ORG_AUDIT, `${PFX} audit shift PM`)
      await seedShift(ORG_AUDIT, `${PFX} audit shift NIGHT`)

      await seedGroup(ORG_AUDIT, `${PFX} audit scheduled group`, 'scheduled_shift')
      await seedRotationRule(ORG_AUDIT, `${PFX} audit rotation active`, true)
      await seedRotationRule(ORG_AUDIT, `${PFX} audit rotation inactive`, false) // proves is_active filter

      await seedApprovalFlow(ORG_AUDIT, `${PFX} audit flow active`, 'leave', true)
      await seedApprovalFlow(ORG_AUDIT, `${PFX} audit flow inactive`, 'overtime', false) // proves is_active filter

      // A sibling org with DIFFERENT counts on every dimension — if any leg's org_id filter were
      // dropped, its count would leak this org's rows in and diverge from the assertion below.
      const otherOrg = `${PFX}_audit_other_org`
      const otherOwner = `${PFX}_audit_other_owner`
      await seedMembership(otherOrg, otherOwner, true)
      const otherGroup = await seedGroup(otherOrg, `${PFX} audit other group`)
      await seedGroupMember(otherOrg, otherGroup, otherOwner)
      await seedShift(otherOrg, `${PFX} audit other shift`)
      await seedShift(otherOrg, `${PFX} audit other shift 2`)
      await seedRotationRule(otherOrg, `${PFX} audit other rotation`, true)
      await seedApprovalFlow(otherOrg, `${PFX} audit other flow`, 'leave', true)
      afterAllExtraOrgIds.push(otherOrg)
    }, 30000)

    afterAll(async () => {
      for (const orgId of afterAllExtraOrgIds) {
        await pool.query(`DELETE FROM attendance_approval_flows WHERE org_id = $1`, [orgId])
        await pool.query(`DELETE FROM attendance_rotation_rules WHERE org_id = $1`, [orgId])
        await pool.query(`DELETE FROM attendance_shifts WHERE org_id = $1`, [orgId])
        await pool.query(`DELETE FROM attendance_group_members WHERE org_id = $1`, [orgId])
        await pool.query(`DELETE FROM attendance_groups WHERE org_id = $1`, [orgId])
        await pool.query(`DELETE FROM user_orgs WHERE org_id = $1`, [orgId])
      }
      await pool.query(`DELETE FROM attendance_approval_flows WHERE org_id = $1`, [ORG_AUDIT])
      await pool.query(`DELETE FROM attendance_rotation_rules WHERE org_id = $1`, [ORG_AUDIT])
      await pool.query(`DELETE FROM attendance_shifts WHERE org_id = $1`, [ORG_AUDIT])
      await pool.query(`DELETE FROM attendance_group_members WHERE org_id = $1`, [ORG_AUDIT])
      await pool.query(`DELETE FROM attendance_groups WHERE org_id = $1`, [ORG_AUDIT])
      await pool.query(`DELETE FROM user_orgs WHERE org_id = $1`, [ORG_AUDIT])
    })

    it('org_id = $1 appears exactly 7 times, one positional param, against REAL Postgres — with exact counts proving no cross-org leak', async () => {
      const spy = vi.fn<Parameters<typeof mockedQuery>, ReturnType<typeof mockedQuery>>()
      const counts = await runAttendanceSetupReadinessReadOnly(async (q) => {
        const wrapped: typeof q = ((sql: string, params?: unknown[]) => {
          spy(sql, params as never)
          return q(sql, params)
        }) as typeof q
        return readAttendanceSetupReadinessOrgCounts(ORG_AUDIT, wrapped)
      })
      expect(spy).toHaveBeenCalledTimes(1)
      const [sql, params] = spy.mock.calls[0]
      const orgIdMatches = (sql as string).match(/org_id\s*=\s*\$1/g) ?? []
      expect(orgIdMatches).toHaveLength(7)
      expect(params).toEqual([ORG_AUDIT])
      expect(sql).not.toMatch(/\$2/)
      // Exact counts — this org's rows only, the sibling org's rows never leak in.
      expect(counts).toEqual({
        orgActiveMemberCount: 2, // memberInactive (user_orgs.is_active=false) AND memberPlatformDeactivated (users.is_active=false) both excluded
        groupCount: 3, // 2 fixed_shift + 1 scheduled_shift
        groupsWithMembers: 1,
        shiftCount: 3,
        scheduledShiftGroupCount: 1,
        activeRotationRuleCount: 1, // the inactive rotation rule excluded
        approvalFlowCount: 1, // the inactive flow excluded
      })
    })
  })
})
