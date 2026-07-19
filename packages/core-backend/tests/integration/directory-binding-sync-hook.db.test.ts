import { afterAll, describe, expect, it, vi } from 'vitest'

// Mocked DingTalk client (same pattern as directory-sync-orchestration.db.test.ts): the REAL
// syncDirectoryIntegration pulls a synthetic (empty) tenant and applies it against real Postgres.
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

import { Logger } from '../../src/core/logger'
import { query } from '../../src/db/pg'
import * as departmentBindingReconciliation from '../../src/directory/department-binding-reconciliation'
import { createDirectoryIntegration, getOrCreateLocalIntegration, syncDirectoryIntegration } from '../../src/directory/directory-sync'
import { createLocalDepartment } from '../../src/directory/local-directory-org'

/**
 * B7 Q6 (owner ruling) — the POST-SYNC auto-sweep hook, END-TO-END through the REAL sync:
 *
 *   A. A bound remote department disappears from the provider (empty pull → the sync's own absence
 *      sweep marks it `is_active=false`) → after the SUCCESSFUL sync commit, the hook sweeps and
 *      the binding is `stale` — with NO admin action. NARROWING: a second dingtalk integration's
 *      binding (whose remote dept is also archived) is left untouched by THIS integration's sync —
 *      the hook is scoped by `remoteIntegrationId` exactly as ruled.
 *   B. FAILURE ISOLATION + VALUES-FREE WARN: the post-sync sweep is forced to throw (Error with a
 *      unique sensitive name sentinel + PG-relation-like message) while the REAL sync still
 *      SUCCEEDS (completed run; last_error NULL). Logger.warn meta is ONLY
 *      { integrationId, reason: 'sweep_failed' } — serialized warn args must exclude the name
 *      sentinel, relation text, and raw message. Restoring readErrorMessage(error) into the
 *      message OR error.name into meta reds this pin. Admin `POST /department-bindings/sweep`
 *      is the retry path (proven in directory-binding-admin-routes.db.test.ts).
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()

clientMocks.fetchDingTalkAppAccessToken.mockResolvedValue(`b7q6-token-${TS}`)
clientMocks.listDingTalkDepartments.mockResolvedValue([]) // EMPTY tenant — every seeded dept departs
clientMocks.getDingTalkDepartmentDetail.mockResolvedValue({ deptManagerUserIdList: [] })
clientMocks.listDingTalkDepartmentUsers.mockResolvedValue({ users: [], hasMore: false })
clientMocks.getDingTalkUserDetail.mockResolvedValue({})

async function dtDeptSeen(integrationId: string, extId: string, name: string): Promise<string> {
  // last_seen_at in the PAST so the sync's absence sweep (`last_seen_at < syncTimestamp`) fires
  const r = await query<{ id: string }>(
    `INSERT INTO directory_departments (integration_id, provider, external_department_id, name, is_active, raw, last_seen_at)
     VALUES ($1, 'dingtalk', $2, $3, true, '{}'::jsonb, NOW() - interval '1 hour') RETURNING id`,
    [integrationId, extId, name],
  )
  return r.rows[0].id
}
async function bind(org: string, localInt: string, localDept: string, remoteInt: string, remoteDept: string): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO directory_department_bindings
       (org_id, local_integration_id, local_department_id, local_provider,
        remote_integration_id, remote_department_id, remote_provider, status)
     VALUES ($1, $2, $3, 'local', $4, $5, 'dingtalk', 'active') RETURNING id`,
    [org, localInt, localDept, remoteInt, remoteDept],
  )
  return r.rows[0].id
}
async function bindingStatus(id: string): Promise<string> {
  const r = await query<{ status: string }>(`SELECT status FROM directory_department_bindings WHERE id = $1`, [id])
  return r.rows[0].status
}

describeIfDatabase('B7 Q6 — post-sync auto-sweep hook (real sync, mocked provider pull)', () => {
  const cleanupBindingIds: string[] = []
  const cleanupDeptIds: string[] = []
  const cleanupIntegrationIds: string[] = []

  afterAll(async () => {
    try {
      for (const id of cleanupBindingIds.splice(0)) await query(`DELETE FROM directory_department_bindings WHERE id = $1`, [id])
      for (const id of cleanupDeptIds.splice(0)) await query(`DELETE FROM directory_departments WHERE id = $1`, [id])
      for (const id of cleanupIntegrationIds.splice(0)) {
        await query(`DELETE FROM directory_sync_runs WHERE integration_id = $1`, [id])
        await query(`DELETE FROM directory_integrations WHERE id = $1`, [id])
      }
    } catch {
      /* best effort */
    }
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('A. a successful sync auto-stales the departed remote binding — narrowed to the synced integration only', async () => {
    // integration A (will sync) + integration B (must NOT be swept by A's sync)
    const intA = await createDirectoryIntegration({
      name: `b7q6-A-${TS}`,
      corpId: `b7q6-corpA-${TS}`,
      appKey: `b7q6-keyA-${TS}`,
      appSecret: 's',
      admissionMode: 'manual_only',
    })
    cleanupIntegrationIds.push(intA.id)
    const intB = await query<{ id: string }>(
      `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config)
       VALUES ('default', 'dingtalk', $1, 'active', $2, '{}'::jsonb) RETURNING id`,
      [`b7q6-B-${TS}`, `b7q6-corpB-${TS}`],
    )
    cleanupIntegrationIds.push(intB.rows[0].id)

    const local = await getOrCreateLocalIntegration('default')
    const lDeptA = await createLocalDepartment({ orgId: 'default', name: `B7Q6 A ${TS}` })
    const lDeptB = await createLocalDepartment({ orgId: 'default', name: `B7Q6 B ${TS}` })
    cleanupDeptIds.push(lDeptA.id, lDeptB.id)
    const rDeptA = await dtDeptSeen(intA.id, `b7q6-a-${TS}`, `B7Q6 A ${TS}`)
    const rDeptB = await query<{ id: string }>(
      // integration B's remote dept is ALREADY archived — sweepable, but B is not the synced integration
      `INSERT INTO directory_departments (integration_id, provider, external_department_id, name, is_active, raw)
       VALUES ($1, 'dingtalk', $2, $3, false, '{}'::jsonb) RETURNING id`,
      [intB.rows[0].id, `b7q6-b-${TS}`, `B7Q6 B ${TS}`],
    )
    cleanupDeptIds.push(rDeptA, rDeptB.rows[0].id)
    const bindingA = await bind('default', local.id, lDeptA.id, intA.id, rDeptA)
    const bindingB = await bind('default', local.id, lDeptB.id, intB.rows[0].id, rDeptB.rows[0].id)
    cleanupBindingIds.push(bindingA, bindingB)

    const result = await syncDirectoryIntegration(intA.id, `system:b7q6-${TS}`)
    expect(result.run.status).toBe('completed')

    // the sync's own absence sweep archived the departed remote dept…
    const dept = await query<{ is_active: boolean }>(`SELECT is_active FROM directory_departments WHERE id = $1`, [rDeptA])
    expect(dept.rows[0].is_active).toBe(false)
    // …and the post-commit hook staled its binding WITHOUT any admin action
    expect(await bindingStatus(bindingA)).toBe('stale')
    // narrowing (Q6): integration B's sweepable binding is untouched by A's sync
    expect(await bindingStatus(bindingB)).toBe('active')
  })

  it('B. failure isolation + values-free warn: a broken sweep never fails the sync and logs no raw error text', async () => {
    const intC = await createDirectoryIntegration({
      name: `b7q6-C-${TS}`,
      corpId: `b7q6-corpC-${TS}`,
      appKey: `b7q6-keyC-${TS}`,
      appSecret: 's',
      admissionMode: 'manual_only',
    })
    cleanupIntegrationIds.push(intC.id)

    // Force the post-sync sweep to throw with attacker/adapter-shaped fields: a UNIQUE sensitive
    // Error.name sentinel plus relation-like message text. Production catch must log neither.
    const nameSentinel = `SENSITIVE_SWEEP_ERR_NAME_${TS}_corp_secret_token`
    const relationNeedle = 'directory_department_bindings'
    const forced = new Error(`relation "${relationNeedle}" does not exist`)
    forced.name = nameSentinel
    const sweepSpy = vi
      .spyOn(departmentBindingReconciliation, 'sweepStaleDepartmentBindings')
      .mockRejectedValue(forced)
    const warnSpy = vi.spyOn(Logger.prototype, 'warn')
    try {
      const result = await syncDirectoryIntegration(intC.id, `system:b7q6c-${TS}`)
      expect(result.run.status).toBe('completed') // the sync is UNAFFECTED by the sweep failure
      const row = await query<{ last_error: string | null }>(
        `SELECT last_error FROM directory_integrations WHERE id = $1`,
        [intC.id],
      )
      expect(row.rows[0].last_error).toBeNull() // not fail-marked either

      // Values-free warn: ONLY { integrationId, reason: 'sweep_failed' }. Serialized args must
      // exclude Error.name sentinel, relation text, and raw message. Mutations restoring
      // readErrorMessage(error) into the message OR error.name into meta red these pins.
      const sweepWarns = warnSpy.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('Department-binding sweep after successful sync failed'),
      )
      expect(sweepWarns.length).toBeGreaterThanOrEqual(1)
      const [message, meta] = sweepWarns[0] as [string, Record<string, unknown>]
      const serialized = JSON.stringify({ message, meta })
      expect(serialized).not.toContain(nameSentinel)
      expect(serialized).not.toContain(relationNeedle)
      expect(serialized.toLowerCase()).not.toContain('does not exist')
      expect(message).not.toMatch(/relation|undefined_table|42P01/i)
      expect(meta).toEqual({
        integrationId: intC.id,
        reason: 'sweep_failed',
      })
      expect(meta).not.toHaveProperty('errorClass')
      expect(meta).not.toHaveProperty('error')
      expect(meta).not.toHaveProperty('stack')
      expect(meta).not.toHaveProperty('code')
      expect(sweepSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
      sweepSpy.mockRestore()
    }
  })
})
