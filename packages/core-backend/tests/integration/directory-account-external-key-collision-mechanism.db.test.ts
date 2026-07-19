import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// T2-Gate EVIDENCE TOOLING (§3.4) — the DB-LEVEL half of the two-corp coexistence question.
//
// §3.4's open question is staging-gated: only two REAL DingTalk corps can show whether the
// provider hands the same person the same provider-level identity (unionId) in both corps. What
// this suite proves — permanently, in CI — is the MECHANISM that makes that question load-bearing:
//
//   1. `directory_accounts` is UNIQUE on (provider, external_key)
//      [idx_directory_accounts_provider_external_key], and
//   2. the sync derives external_key WITHOUT corp scoping — `unionId || openId || userId`
//      (directory-sync.ts account upsert) — and
//   3. the account upsert loop has NO per-account savepoint, so a cross-corp collision does not
//      skip one account: it aborts the whole apply transaction and the SECOND corp's sync run
//      FAILS wholesale — including department rows upserted earlier in the same apply (not just
//      accounts).
//
// Together: IF staging shows equal unionIds across corps, coexistence is impossible today and the
// collision signature is a failed corp-B sync run whose closed classifications are
// duplicate_key_detected + expected_constraint_detected (idx_directory_accounts_provider_external_key)
// — which is exactly what the staging runbook
// (canonical-org-t2-gate-two-corp-staging-runbook-20260717.md) tells ops to record (never raw
// error_message / err-head — PostgreSQL duplicate-key text can embed the real external_key), and
// what T2.5's tenant-scoped key migration would fix. If staging shows distinct unionIds, the
// contrast leg here (distinct keys coexist, both syncs complete) is the shape ops should observe.
//
// DATABASE_URL-gated (describeIfDatabase): excluded from the no-DB vitest job so it cannot
// skip-green, and wired as a WHOLE FILE into the approval real-DB step in plugin-tests.yml
// (both points asserted by t2gate-collision-mechanism-ci-wiring.test.mjs).
const clientMocks = vi.hoisted(() => ({
  fetchDingTalkAppAccessToken: vi.fn(),
  listDingTalkDepartments: vi.fn(),
  getDingTalkDepartmentDetail: vi.fn(),
  listDingTalkDepartmentUsers: vi.fn(),
  getDingTalkUserDetail: vi.fn(),
}))

vi.mock('../../src/integrations/dingtalk/client', () => ({
  fetchDingTalkAppAccessToken: clientMocks.fetchDingTalkAppAccessToken,
  listDingTalkDepartments: clientMocks.listDingTalkDepartments,
  getDingTalkDepartmentDetail: clientMocks.getDingTalkDepartmentDetail,
  listDingTalkDepartmentUsers: clientMocks.listDingTalkDepartmentUsers,
  getDingTalkUserDetail: clientMocks.getDingTalkUserDetail,
}))

import { query } from '../../src/db/pg'
import { createDirectoryIntegration, syncDirectoryIntegration } from '../../src/directory/directory-sync'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()

/** One root department with one user; the user's identity fields are per-test knobs. */
type MockTenant = { unionId?: string; openId?: string; userId: string; name: string }
let activeTenant: MockTenant | null = null

describeIfDatabase('T2-Gate evidence — directory_accounts (provider, external_key) collision mechanism (real sync, mocked pull)', () => {
  const cleanupIntegrationIds: string[] = []

  beforeAll(() => {
    clientMocks.fetchDingTalkAppAccessToken.mockResolvedValue('t2g-token')
    clientMocks.listDingTalkDepartments.mockImplementation(async (_token: string, parentId: string) =>
      parentId === '1' && activeTenant ? [{ id: 'd100', parentId: '1', name: 'Mechanism Dept', order: 1, source: {} }] : []
    )
    clientMocks.getDingTalkDepartmentDetail.mockResolvedValue({ deptManagerUserIdList: [] })
    clientMocks.listDingTalkDepartmentUsers.mockImplementation(async (_token: string, deptId: string) => ({
      users:
        deptId === 'd100' && activeTenant
          ? [{ userId: activeTenant.userId, name: activeTenant.name, departmentIds: ['d100'], source: {} }]
          : [],
      nextCursor: null,
      hasMore: false,
    }))
    clientMocks.getDingTalkUserDetail.mockImplementation(async () => ({
      userId: activeTenant!.userId,
      name: activeTenant!.name,
      unionId: activeTenant!.unionId,
      openId: activeTenant!.openId,
      email: undefined,
      mobile: undefined,
      departmentIds: ['d100'],
      source: {},
    }))
  })

  afterAll(async () => {
    for (const id of cleanupIntegrationIds.splice(0)) await query(`DELETE FROM directory_integrations WHERE id = $1`, [id])
  })

  async function seedIntegration(tag: string): Promise<string> {
    const integration = await createDirectoryIntegration({
      name: `t2g-${tag}-${TS}`,
      corpId: `t2g-corp-${tag}-${TS}`,
      appKey: `t2g-appkey-${tag}-${TS}`,
      appSecret: 't2g-secret',
      admissionMode: 'manual_only',
    })
    cleanupIntegrationIds.push(integration.id)
    return integration.id
  }

  async function accountKeys(integrationId: string): Promise<Array<{ external_key: string; is_active: boolean }>> {
    const rows = await query<{ external_key: string; is_active: boolean }>(
      `SELECT external_key, is_active FROM directory_accounts WHERE integration_id = $1 ORDER BY external_key`,
      [integrationId]
    )
    return rows.rows
  }

  /** Values-free local-directory write probe: count of department rows for one integration. */
  async function departmentCount(integrationId: string): Promise<number> {
    const rows = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM directory_departments WHERE integration_id = $1`,
      [integrationId],
    )
    return rows.rows[0]?.n ?? 0
  }

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('pins the schema mechanism: same (provider, external_key) across two integrations is UNINSERTABLE — distinct keys coexist', async () => {
    const a = await seedIntegration('probe-a')
    const b = await seedIntegration('probe-b')
    const sharedKey = `t2g-shared-${TS}`

    await query(
      `INSERT INTO directory_accounts (integration_id, provider, external_user_id, external_key, name, is_active, raw)
       VALUES ($1, 'dingtalk', $2, $3, 'Probe A', true, '{}'::jsonb)`,
      [a, `t2g-probe-a-${TS}`, sharedKey]
    )
    // positive-coexistence control FIRST: a distinct key under B inserts fine
    await query(
      `INSERT INTO directory_accounts (integration_id, provider, external_user_id, external_key, name, is_active, raw)
       VALUES ($1, 'dingtalk', $2, $3, 'Probe B distinct', true, '{}'::jsonb)`,
      [b, `t2g-probe-b1-${TS}`, `t2g-distinct-${TS}`]
    )
    // the collision: same key under B — 23505 on the exact closed constraint name the runbook
    // classifies via expected_constraint_detected (never raw error text in operator evidence)
    let caught: { code?: string; constraint?: string } | null = null
    try {
      await query(
        `INSERT INTO directory_accounts (integration_id, provider, external_user_id, external_key, name, is_active, raw)
         VALUES ($1, 'dingtalk', $2, $3, 'Probe B colliding', true, '{}'::jsonb)`,
        [b, `t2g-probe-b2-${TS}`, sharedKey]
      )
    } catch (error) {
      caught = error as { code?: string; constraint?: string }
    }
    expect(caught, 'colliding INSERT unexpectedly succeeded').not.toBeNull()
    expect(caught?.code).toBe('23505')
    expect(caught?.constraint).toBe('idx_directory_accounts_provider_external_key')
  })

  it('pins the derivation: the synced external_key is the BARE unionId — no corp scoping (the §3.4 precondition; T2.5 would change this)', async () => {
    const a = await seedIntegration('derive')
    activeTenant = { unionId: `t2g-union-derive-${TS}`, openId: `t2g-open-derive-${TS}`, userId: `t2g-uid-derive-${TS}`, name: 'Derive' }
    const result = await syncDirectoryIntegration(a, `t2g-admin-${TS}`)
    expect(result.run.status).toBe('completed')
    const keys = await accountKeys(a)
    expect(keys).toHaveLength(1)
    // bare unionId wins over openId/userId, and carries NO corp prefix
    expect(keys[0].external_key).toBe(`t2g-union-derive-${TS}`)
  })

  it('END-TO-END collision signature: the SECOND corp sync FAILS WHOLESALE when the overlapping person carries the same unionId', async () => {
    const corpA = await seedIntegration('e2e-a')
    const corpB = await seedIntegration('e2e-b')
    const sharedUnion = `t2g-union-shared-${TS}`

    activeTenant = { unionId: sharedUnion, userId: `t2g-uid-a-${TS}`, name: 'Overlap Person' }
    const first = await syncDirectoryIntegration(corpA, `t2g-admin-${TS}`)
    expect(first.run.status).toBe('completed')
    expect((await accountKeys(corpA)).map((r) => r.external_key)).toEqual([sharedUnion])

    // same person, same unionId, DIFFERENT corp + different corp-local userId
    activeTenant = { unionId: sharedUnion, userId: `t2g-uid-b-${TS}`, name: 'Overlap Person' }
    let caught: unknown = null
    try {
      await syncDirectoryIntegration(corpB, `t2g-admin-${TS}`)
    } catch (error) {
      caught = error
    }
    // no per-account savepoint in the upsert loop: the whole apply aborts — corp B's run FAILS
    expect(caught, 'corp-B sync unexpectedly completed despite the shared unionId').not.toBeNull()
    // Closed constraint name only — do not assert/print full SQL error text (can embed external_key).
    const thrown = caught as { code?: string; constraint?: string; message?: string }
    const constraintHit =
      thrown.constraint === 'idx_directory_accounts_provider_external_key' ||
      (typeof thrown.message === 'string' &&
        thrown.message.includes('idx_directory_accounts_provider_external_key'))
    expect(constraintHit, 'thrown failure must name the closed unique-index constraint').toBe(true)

    // corp B got NOTHING (whole apply transaction rolled back) — not only accounts.
    // Departments are upserted BEFORE the colliding account; a regression that catches the
    // 23505, marks the run failed, but commits the already-upserted d100 department would still
    // pass an accounts-only empty check. Pin zero directory_departments for corp B.
    expect(await accountKeys(corpB)).toHaveLength(0)
    expect(
      await departmentCount(corpB),
      'corp-B directory_departments must be empty after wholesale collision rollback (dept upsert precedes account collision)',
    ).toBe(0)
    // Positive control: corp A still holds its synced department + account (untouched).
    expect((await accountKeys(corpA)).map((r) => r.external_key)).toEqual([sharedUnion])
    expect(
      await departmentCount(corpA),
      'corp-A directory_departments positive control: successful first sync must leave its dept row',
    ).toBeGreaterThan(0)

    // Run-row evidence uses the same closed boolean classifications as the staging runbook —
    // never SELECT/project raw error_message (PostgreSQL duplicate-key DETAIL can embed the key).
    const run = await query<{
      status: string
      duplicate_key_detected: boolean
      expected_constraint_detected: boolean
    }>(
      `SELECT status,
              (error_message IS NOT NULL
                AND position('duplicate key' in error_message) > 0) AS duplicate_key_detected,
              (error_message IS NOT NULL
                AND position('idx_directory_accounts_provider_external_key' in error_message) > 0)
                AS expected_constraint_detected
         FROM directory_sync_runs
        WHERE integration_id = $1
        ORDER BY started_at DESC LIMIT 1`,
      [corpB]
    )
    expect(run.rows[0].status).toBe('failed')
    expect(run.rows[0].duplicate_key_detected).toBe(true)
    expect(run.rows[0].expected_constraint_detected).toBe(true)
  })

  it('CONTRAST (what a collision-free staging proof would look like): distinct unionIds per corp — both syncs complete and coexist', async () => {
    const corpA = await seedIntegration('ok-a')
    const corpB = await seedIntegration('ok-b')

    activeTenant = { unionId: `t2g-union-okA-${TS}`, userId: `t2g-uid-okA-${TS}`, name: 'Person A-side' }
    expect((await syncDirectoryIntegration(corpA, `t2g-admin-${TS}`)).run.status).toBe('completed')

    activeTenant = { unionId: `t2g-union-okB-${TS}`, userId: `t2g-uid-okB-${TS}`, name: 'Person B-side' }
    expect((await syncDirectoryIntegration(corpB, `t2g-admin-${TS}`)).run.status).toBe('completed')

    expect((await accountKeys(corpA)).map((r) => r.external_key)).toEqual([`t2g-union-okA-${TS}`])
    expect((await accountKeys(corpB)).map((r) => r.external_key)).toEqual([`t2g-union-okB-${TS}`])
  })
})
