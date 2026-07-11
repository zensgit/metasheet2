import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { query } from '../../src/db/pg'
import { upsertDirectoryAccountDepartments } from '../../src/directory/directory-sync'
import { resolveApprovalRequesterOrgRelations } from '../../src/services/ApprovalDirectoryOrg'

/**
 * DT-HARDEN-07 — the primary department, written and then *consumed*, against real Postgres.
 *
 * The unit golden that used to guard this fed `resolveApprovalRequesterOrgRelations` a mock
 * that closed over the answer: `buildQuery('20')` returned "20 is primary" regardless of the
 * params, so it proved only that routing follows whatever the database says. It could not see
 * whether `is_primary` was written correctly — and the line that writes it (previously inline
 * in `syncDirectoryIntegration`, which no test can reach) could be reverted to
 * `departmentIds[0]` with 4353 tests still green.
 *
 * This closes the loop. `upsertDirectoryAccountDepartments` does the real write, then the real
 * `ApprovalDirectoryOrg` SQL reads it back and names a manager. The requester belongs to two
 * departments with two different leaders, so the flag's value is the difference between two
 * people receiving the approval.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const DEPT_A = `pdw-a-${TS}` // first in dept_id_list
const DEPT_B = `pdw-b-${TS}` // lowest dept_order_list order
const U_REQ = `pdw-req-${TS}`
const U_LEAD_A = `pdw-lead-a-${TS}`
const U_LEAD_B = `pdw-lead-b-${TS}`

const queryFn = <Row>(text: string, params?: unknown[]): Promise<{ rows: Row[] }> =>
  query(text, params).then((r) => ({ rows: r.rows as Row[] }))

const client = {
  query: (sql: string, params?: unknown[]) =>
    query(sql, params).then((r) => ({ rows: r.rows as Array<Record<string, unknown>> })),
}

describeIfDatabase('DT-HARDEN-07 primary department: write → approval routing (real DB)', () => {
  let integrationId = ''
  let requesterAccountId = ''
  const departmentIdMap = new Map<string, string>()

  /** The DingTalk user/get payload the sync stores verbatim in `directory_accounts.raw`. */
  const requesterSource = (deptOrderList?: unknown) => ({
    userid: `ext-${U_REQ}`,
    dept_id_list: [DEPT_A, DEPT_B],
    ...(deptOrderList === undefined ? {} : { dept_order_list: deptOrderList }),
  })

  const writeMemberships = (source: unknown) =>
    upsertDirectoryAccountDepartments(client, {
      users: [{ userId: `ext-${U_REQ}`, departmentIds: [DEPT_A, DEPT_B], source }],
      accountIdMap: new Map([[`ext-${U_REQ}`, { id: requesterAccountId }]]),
      departmentIdMap,
    })

  const primaryDepartments = async () =>
    (await query<{ external_department_id: string }>(
      `SELECT d.external_department_id
         FROM directory_account_departments ad
         JOIN directory_departments d ON d.id = ad.directory_department_id
        WHERE ad.directory_account_id = $1 AND ad.is_primary = true
        ORDER BY d.external_department_id`,
      [requesterAccountId],
    )).rows.map((r) => r.external_department_id)

  beforeAll(async () => {
    integrationId = (await query<{ id: string }>(
      `INSERT INTO directory_integrations (name, corp_id) VALUES ($1, $2) RETURNING id`,
      [`pdw-${TS}`, `pdw-corp-${TS}`],
    )).rows[0].id

    for (const external of [DEPT_A, DEPT_B]) {
      const row = (await query<{ id: string }>(
        `INSERT INTO directory_departments (integration_id, external_department_id, name, is_active, raw)
         VALUES ($1, $2, $3, true, '{}'::jsonb) RETURNING id`,
        [integrationId, external, `Dept ${external}`],
      )).rows[0]
      departmentIdMap.set(external, row.id)
    }

    await query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1,$2,'x'), ($3,$4,'x'), ($5,$6,'x')`,
      [U_REQ, `${U_REQ}@example.test`, U_LEAD_A, `${U_LEAD_A}@example.test`, U_LEAD_B, `${U_LEAD_B}@example.test`],
    )

    requesterAccountId = (await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, raw)
       VALUES ($1, $2, $3, 'Requester', $4::jsonb) RETURNING id`,
      [integrationId, `ext-${U_REQ}`, `key-${U_REQ}`, JSON.stringify(requesterSource())],
    )).rows[0].id

    // One leader per department, each flagged leader of their own department only.
    const leaders: Array<[string, string]> = [[U_LEAD_A, DEPT_A], [U_LEAD_B, DEPT_B]]
    for (const [userId, dept] of leaders) {
      const accountId = (await query<{ id: string }>(
        `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, raw)
         VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
        [integrationId, `ext-${userId}`, `key-${userId}`, `Leader ${dept}`,
          JSON.stringify({ leader_in_dept: [{ dept_id: dept, leader: true }] })],
      )).rows[0].id
      await query(
        `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
         VALUES ($1, $2, 'linked', 'manual')`,
        [accountId, userId],
      )
      await query(
        `INSERT INTO directory_account_departments (directory_account_id, directory_department_id, is_primary)
         VALUES ($1, $2, true)`,
        [accountId, departmentIdMap.get(dept)],
      )
    }

    await query(
      `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
       VALUES ($1, $2, 'linked', 'manual')`,
      [requesterAccountId, U_REQ],
    )
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await query(`DELETE FROM directory_account_departments WHERE directory_account_id = $1`, [requesterAccountId])
  })

  afterAll(async () => {
    if (!integrationId) return
    await query(`DELETE FROM directory_accounts WHERE integration_id = $1`, [integrationId])
    await query(`DELETE FROM directory_departments WHERE integration_id = $1`, [integrationId])
    await query(`DELETE FROM directory_integrations WHERE id = $1`, [integrationId])
    await query(`DELETE FROM users WHERE id = ANY($1)`, [[U_REQ, U_LEAD_A, U_LEAD_B]])
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('default (flag off): primary is dept_id_list[0], and approvals route to that leader', async () => {
    const summary = await writeMemberships(requesterSource([{ dept_id: DEPT_B, order: 1 }, { dept_id: DEPT_A, order: 9 }]))

    expect(summary).toEqual({ membershipsWritten: 2, accountsWithPrimary: 1, accountsWithoutKnownDepartment: 0 })
    await expect(primaryDepartments()).resolves.toEqual([DEPT_A])

    const relations = await resolveApprovalRequesterOrgRelations(U_REQ, queryFn)
    expect(relations.managerId).toBe(U_LEAD_A)
    expect(relations.primaryDepartmentName).toBe(`Dept ${DEPT_A}`)
  })

  // The whole point of the flag. Reverting the write to `departmentIds[0]` reddens this.
  it('flag on: the lowest dept_order_list order wins, and approvals route to the OTHER leader', async () => {
    vi.stubEnv('DIRECTORY_PRIMARY_DEPT_FROM_ORDER', 'true')
    await writeMemberships(requesterSource([{ dept_id: DEPT_B, order: 1 }, { dept_id: DEPT_A, order: 9 }]))

    await expect(primaryDepartments()).resolves.toEqual([DEPT_B])

    const relations = await resolveApprovalRequesterOrgRelations(U_REQ, queryFn)
    expect(relations.managerId).toBe(U_LEAD_B) // NOT U_LEAD_A — a different human approves
    expect(relations.primaryDepartmentName).toBe(`Dept ${DEPT_B}`)
  })

  it('exactly one department is primary, always', async () => {
    vi.stubEnv('DIRECTORY_PRIMARY_DEPT_FROM_ORDER', 'true')
    await writeMemberships(requesterSource([{ dept_id: DEPT_B, order: 1 }, { dept_id: DEPT_A, order: 9 }]))
    expect((await primaryDepartments()).length).toBe(1)

    const all = await query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM directory_account_departments WHERE directory_account_id = $1`,
      [requesterAccountId],
    )
    expect(all.rows[0].count).toBe(2)
  })

  it('re-running moves a stale primary rather than adding a second one (ON CONFLICT DO UPDATE)', async () => {
    const source = requesterSource([{ dept_id: DEPT_B, order: 1 }, { dept_id: DEPT_A, order: 9 }])
    await writeMemberships(source) // flag off → DEPT_A primary
    await expect(primaryDepartments()).resolves.toEqual([DEPT_A])

    vi.stubEnv('DIRECTORY_PRIMARY_DEPT_FROM_ORDER', 'true')
    await writeMemberships(source) // flag on → DEPT_B primary, DEPT_A demoted
    await expect(primaryDepartments()).resolves.toEqual([DEPT_B])
  })

  it('is idempotent: writing twice leaves the same primary', async () => {
    vi.stubEnv('DIRECTORY_PRIMARY_DEPT_FROM_ORDER', 'true')
    const source = requesterSource([{ dept_id: DEPT_B, order: 1 }, { dept_id: DEPT_A, order: 9 }])
    await writeMemberships(source)
    const first = await primaryDepartments()
    await writeMemberships(source)
    await expect(primaryDepartments()).resolves.toEqual(first)
  })

  // `Number(null)` is 0, and 0 is the winning order. A malformed entry must drop out, not
  // silently elect its department — that would re-route approvals on a typo.
  it('flag on: an entry with a null order is ignored, not treated as order 0', async () => {
    vi.stubEnv('DIRECTORY_PRIMARY_DEPT_FROM_ORDER', 'true')
    await writeMemberships(requesterSource([{ dept_id: DEPT_A, order: null }, { dept_id: DEPT_B, order: 3 }]))

    await expect(primaryDepartments()).resolves.toEqual([DEPT_B])
    const relations = await resolveApprovalRequesterOrgRelations(U_REQ, queryFn)
    expect(relations.managerId).toBe(U_LEAD_B)
  })

  it('flag on: a numeric string order is honoured', async () => {
    vi.stubEnv('DIRECTORY_PRIMARY_DEPT_FROM_ORDER', 'true')
    await writeMemberships(requesterSource([{ dept_id: DEPT_B, order: '2' }, { dept_id: DEPT_A, order: '7' }]))
    await expect(primaryDepartments()).resolves.toEqual([DEPT_B])
  })

  it('flag on with no usable order signal: falls back to dept_id_list[0]', async () => {
    vi.stubEnv('DIRECTORY_PRIMARY_DEPT_FROM_ORDER', 'true')
    await writeMemberships(requesterSource())
    await expect(primaryDepartments()).resolves.toEqual([DEPT_A])
  })

  it('departments unknown to this integration are skipped, and the account is reported', async () => {
    const summary = await upsertDirectoryAccountDepartments(client, {
      users: [{ userId: `ext-${U_REQ}`, departmentIds: ['no-such-dept'], source: requesterSource() }],
      accountIdMap: new Map([[`ext-${U_REQ}`, { id: requesterAccountId }]]),
      departmentIdMap,
    })

    expect(summary).toEqual({ membershipsWritten: 0, accountsWithPrimary: 0, accountsWithoutKnownDepartment: 1 })
    await expect(primaryDepartments()).resolves.toEqual([])
  })
})
