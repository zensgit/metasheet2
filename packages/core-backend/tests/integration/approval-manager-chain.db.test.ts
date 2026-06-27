import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { query } from '../../src/db/pg'
import { resolveApprovalRequesterOrgRelations } from '../../src/services/ApprovalDirectoryOrg'
import { runtimeGraphUsesManagerChain } from '../../src/services/ApprovalProductService'
import { resolveApprovalAssignees } from '../../src/services/ApprovalAssigneeResolver'
import type { RuntimeGraph } from '../../src/types/approval-product'

/**
 * continuous_managers chain walk — REAL DB. The unit test
 * (approval-manager-chain.test.ts) drives the walk logic against a fake query, so
 * it cannot catch a malformed SQL string. This proves the actual `findDeptLeaderHop`
 * SQL (the dept-membership joins + the primary-dept LEFT JOIN) executes against
 * Postgres and resolves a real one-level chain — which also exercises the
 * top-of-tree short-chain stop (only one level is seeded, so level 2 finds no
 * leader and the walk terminates at length 1). The design-lock (#2886 §4) asks for
 * this real-DB case alongside the unit coverage.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const DEPT = `cmd-${TS}`
const U_R = `cm-ur-${TS}`
const U_M = `cm-um-${TS}`

// Adapt the QueryResultRow-constrained `query` to the resolver's unconstrained QueryFn.
const queryFn = <Row>(text: string, params?: unknown[]): Promise<{ rows: Row[] }> =>
  query(text, params).then((r) => ({ rows: r.rows as Row[] }))

describeIfDatabase('continuous_managers chain walk (real DB)', () => {
  let integrationId = ''

  beforeAll(async () => {
    integrationId = (await query<{ id: string }>(
      `INSERT INTO directory_integrations (name, corp_id) VALUES ($1, $2) RETURNING id`,
      [`cmchain-${TS}`, `cmchain-corp-${TS}`],
    )).rows[0].id

    const deptId = (await query<{ id: string }>(
      `INSERT INTO directory_departments (integration_id, external_department_id, name, is_active, raw)
       VALUES ($1, $2, 'Eng', true, '{}'::jsonb) RETURNING id`,
      [integrationId, DEPT],
    )).rows[0].id

    await query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x'), ($3, $4, 'x')`, [
      U_R, `${U_R}@example.test`, U_M, `${U_M}@example.test`,
    ])

    // Requester account R (member of DEPT, primary), linked to U_R.
    const accR = (await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, raw)
       VALUES ($1, $2, $3, 'R', '{}'::jsonb) RETURNING id`,
      [integrationId, `extR-${TS}`, `keyR-${TS}`],
    )).rows[0].id
    // Manager account M: member of DEPT and flagged leader of DEPT in its own leader_in_dept.
    const accM = (await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, raw)
       VALUES ($1, $2, $3, 'M', $4::jsonb) RETURNING id`,
      [integrationId, `extM-${TS}`, `keyM-${TS}`, JSON.stringify({ leader_in_dept: [{ dept_id: DEPT, leader: true }] })],
    )).rows[0].id

    await query(
      `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
       VALUES ($1, $2, 'linked', 'manual'), ($3, $4, 'linked', 'manual')`,
      [accR, U_R, accM, U_M],
    )
    await query(
      `INSERT INTO directory_account_departments (directory_account_id, directory_department_id, is_primary)
       VALUES ($1, $2, true), ($3, $2, true)`,
      [accR, deptId, accM],
    )
  })

  afterAll(async () => {
    if (integrationId) {
      // account_departments + links cascade on directory_accounts delete.
      await query(`DELETE FROM directory_accounts WHERE integration_id = $1`, [integrationId])
      await query(`DELETE FROM directory_departments WHERE integration_id = $1`, [integrationId])
      await query(`DELETE FROM directory_integrations WHERE id = $1`, [integrationId])
      await query(`DELETE FROM users WHERE id = ANY($1)`, [[U_R, U_M]])
    }
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('resolves a real one-level chain and stops at the top of the tree (SQL validity + short-chain)', async () => {
    const rel = await resolveApprovalRequesterOrgRelations(U_R, queryFn, { includeManagerChain: true })
    expect(rel.managerChainIds).toEqual([U_M]) // exactly one level; level-2 finds no leader → stops
    expect(rel.managerId).toBe(U_M) // chain[0] agrees with the shipped direct-manager resolution
    expect(rel.primaryDepartmentName).toBe('Eng') // RA-1a: requester.department source SQL-lift proven on real DB
  })

  it('B1 end-to-end: a manager_at_level template bakes the chain (scanner gate) and resolves the level-1 manager', async () => {
    // Regression for the bake-gate bug: prove the FULL B1 path on the real org —
    // (1) the scanner sees manager_at_level so createApproval sets includeManagerChain,
    // (2) the chain bakes into the snapshot, (3) the resolver picks the level's manager.
    const runtimeGraph = {
      nodes: [{ key: 'approval_1', type: 'approval', config: { assigneeSources: [{ kind: 'manager_at_level', level: 1 }] } }],
    } as unknown as RuntimeGraph
    expect(runtimeGraphUsesManagerChain(runtimeGraph)).toBe(true)

    const rel = await resolveApprovalRequesterOrgRelations(U_R, queryFn, { includeManagerChain: true })
    expect(rel.managerChainIds).toEqual([U_M])

    const resolved = resolveApprovalAssignees({
      nodeKey: 'approval_1',
      sourceStep: 1,
      config: { assigneeSources: [{ kind: 'manager_at_level', level: 1 }] },
      formSnapshot: {},
      requesterSnapshot: { id: U_R, managerChainIds: rel.managerChainIds },
    })
    expect(resolved).toEqual([
      { assignmentType: 'user', assigneeId: U_M, nodeKey: 'approval_1', sourceStep: 1, metadata: { resolvedFrom: { kind: 'manager_at_level', sourceIndex: 0 } } },
    ])
  })

  it('does not bake the chain when includeManagerChain is off (only the direct manager)', async () => {
    const rel = await resolveApprovalRequesterOrgRelations(U_R, queryFn)
    expect(rel.managerChainIds).toBeUndefined()
    expect(rel.managerId).toBe(U_M)
  })
})
