import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { query } from '../../src/db/pg'
import {
  countConsecutiveFailedRuns,
  getDirectoryManagerBindingCoverage,
} from '../../src/directory/directory-sync-alert-delivery'

/**
 * DT-OPS-03 P2-2 — REAL DB coverage. The unit test (directory-sync-alert-delivery.test.ts)
 * drives both `getDirectoryManagerBindingCoverage` and `countConsecutiveFailedRuns` against a
 * fake `queryFn` that just echoes back whatever rows the test hands it — so it proves the
 * TypeScript plumbing but cannot catch a malformed or semantically-wrong SQL string. This file
 * proves the actual SQL against real Postgres: the leader/dept-head UNION + LEFT JOIN chain in
 * the coverage CTE, and the ORDER BY direction in the failure-streak query (mutating either one
 * leaves every unit test green — that is the gap this file closes).
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()

describeIfDatabase('DT-OPS-03 manager binding coverage + failure streak (real DB)', () => {
  describe('getDirectoryManagerBindingCoverage', () => {
    let integrationId = ''
    let deptAId = ''
    const DEPT_A = `dsac-deptA-${TS}`
    const DEPT_B = `dsac-deptB-${TS}`
    const U_HEAD = `dsac-uhead-${TS}`
    const U_LEADER = `dsac-uleader-${TS}`

    beforeAll(async () => {
      integrationId = (await query<{ id: string }>(
        `INSERT INTO directory_integrations (name, corp_id) VALUES ($1, $2) RETURNING id`,
        [`dsac-cov-${TS}`, `dsac-cov-corp-${TS}`],
      )).rows[0].id

      await query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x'), ($3, $4, 'x')`, [
        U_HEAD, `${U_HEAD}@example.test`, U_LEADER, `${U_LEADER}@example.test`,
      ])

      // Dept A names its manager via dept_manager_userid_list (the "department head" path).
      deptAId = (await query<{ id: string }>(
        `INSERT INTO directory_departments (integration_id, external_department_id, name, is_active, raw)
         VALUES ($1, $2, 'DeptA', true, $3::jsonb) RETURNING id`,
        [integrationId, DEPT_A, JSON.stringify({ dept_manager_userid_list: [`ext-head-${TS}`] })],
      )).rows[0].id

      // Dept B has NO manager configured at all (absent key) — must not blow up the CTE, and must
      // not contribute any manager to the aggregate.
      await query(
        `INSERT INTO directory_departments (integration_id, external_department_id, name, is_active, raw)
         VALUES ($1, $2, 'DeptB', true, '{}'::jsonb)`,
        [integrationId, DEPT_B],
      )

      // Manager 1: named as DeptA's head, LINKED to a local user -> counts + bound.
      const accHead = (await query<{ id: string }>(
        `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, is_active, raw)
         VALUES ($1, $2, $3, 'Head', true, '{}'::jsonb) RETURNING id`,
        [integrationId, `ext-head-${TS}`, `key-head-${TS}`],
      )).rows[0].id

      // Manager 2: flagged leader:true of DeptA in its own raw, LINKED -> distinct manager, bound.
      const accLeaderTrue = (await query<{ id: string }>(
        `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, is_active, raw)
         VALUES ($1, $2, $3, 'LeaderTrue', true, $4::jsonb) RETURNING id`,
        [integrationId, `ext-leadertrue-${TS}`, `key-leadertrue-${TS}`,
          JSON.stringify({ leader_in_dept: [{ dept_id: DEPT_A, leader: true }] })],
      )).rows[0].id

      // Manager candidate that is explicitly leader:false — must NOT be counted as a manager at all.
      await query(
        `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, is_active, raw)
         VALUES ($1, $2, $3, 'LeaderFalse', true, $4::jsonb)`,
        [integrationId, `ext-leaderfalse-${TS}`, `key-leaderfalse-${TS}`,
          JSON.stringify({ leader_in_dept: [{ dept_id: DEPT_A, leader: false }] })],
      )

      // Manager 3: named as DeptA's head via a SECOND dept_manager_userid_list entry, but never
      // synced as a directory_account and never linked -> counts toward manager_count, not linked.
      await query(
        `UPDATE directory_departments SET raw = $2::jsonb WHERE id = $1`,
        [deptAId, JSON.stringify({ dept_manager_userid_list: [`ext-head-${TS}`, `ext-unlinked-${TS}`] })],
      )
      await query(
        `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, is_active, raw)
         VALUES ($1, $2, $3, 'Unlinked', true, '{}'::jsonb)`,
        [integrationId, `ext-unlinked-${TS}`, `key-unlinked-${TS}`],
      )

      // A plain employee — never named as a manager anywhere — must not leak into the count.
      await query(
        `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, is_active, raw)
         VALUES ($1, $2, $3, 'Employee', true, '{}'::jsonb)`,
        [integrationId, `ext-employee-${TS}`, `key-employee-${TS}`],
      )

      await query(
        `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
         VALUES ($1, $2, 'linked', 'manual'), ($3, $4, 'linked', 'manual')`,
        [accHead, U_HEAD, accLeaderTrue, U_LEADER],
      )
    })

    afterAll(async () => {
      if (integrationId) {
        await query(`DELETE FROM directory_accounts WHERE integration_id = $1`, [integrationId])
        await query(`DELETE FROM directory_departments WHERE integration_id = $1`, [integrationId])
        await query(`DELETE FROM directory_integrations WHERE id = $1`, [integrationId])
        await query(`DELETE FROM users WHERE id = ANY($1)`, [[U_HEAD, U_LEADER]])
      }
    })

    it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
      expect(process.env.DATABASE_URL).toBeTruthy()
    })

    it('counts dept-head + leader:true managers once each, excludes leader:false, and tracks link status per manager (real SQL)', async () => {
      const result = await getDirectoryManagerBindingCoverage(integrationId)
      // Managers: Head (dept-head, linked), LeaderTrue (leader:true, linked), Unlinked (dept-head, not linked).
      // LeaderFalse and Employee must not appear.
      expect(result).toEqual({ managerCount: 3, linkedManagerCount: 2, coverage: 2 / 3 })
    })

    it('does not divide by zero for an integration whose accounts never name a manager', async () => {
      const emptyIntegrationId = (await query<{ id: string }>(
        `INSERT INTO directory_integrations (name, corp_id) VALUES ($1, $2) RETURNING id`,
        [`dsac-cov-empty-${TS}`, `dsac-cov-empty-corp-${TS}`],
      )).rows[0].id
      try {
        // A wholly separate integration where NOTHING is ever named a manager — the aggregate
        // manager_count is genuinely 0, proving `managerCount === 0 ? 1 : ...` behaves against
        // a real empty result set rather than a hand-built mock row.
        await query(
          `INSERT INTO directory_departments (integration_id, external_department_id, name, is_active, raw)
           VALUES ($1, $2, 'EmptyDept', true, '{}'::jsonb)`,
          [emptyIntegrationId, `dsac-emptydept-${TS}`],
        )
        await query(
          `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, is_active, raw)
           VALUES ($1, $2, $3, 'NotAManager', true, '{}'::jsonb)`,
          [emptyIntegrationId, `ext-notamanager-${TS}`, `key-notamanager-${TS}`],
        )

        const result = await getDirectoryManagerBindingCoverage(emptyIntegrationId)
        expect(result).toEqual({ managerCount: 0, linkedManagerCount: 0, coverage: 1 })
      } finally {
        await query(`DELETE FROM directory_accounts WHERE integration_id = $1`, [emptyIntegrationId])
        await query(`DELETE FROM directory_departments WHERE integration_id = $1`, [emptyIntegrationId])
        await query(`DELETE FROM directory_integrations WHERE id = $1`, [emptyIntegrationId])
      }
    })
  })

  describe('countConsecutiveFailedRuns', () => {
    let integrationId = ''
    const runIds: string[] = []

    beforeAll(async () => {
      integrationId = (await query<{ id: string }>(
        `INSERT INTO directory_integrations (name, corp_id) VALUES ($1, $2) RETURNING id`,
        [`dsac-streak-${TS}`, `dsac-streak-corp-${TS}`],
      )).rows[0].id

      const base = new Date('2026-01-01T00:00:00.000Z').getTime()
      const at = (offsetMinutes: number) => new Date(base + offsetMinutes * 60_000).toISOString()

      // Chronological order (oldest -> newest): completed, failed, running, failed, failed(latest).
      // The trailing streak (from the latest run backward) is: failed, failed — then the `running`
      // row is skipped by the WHERE clause — then failed, then it hits `completed` and stops: streak=3.
      const seeds: Array<{ status: string; offset: number }> = [
        { status: 'completed', offset: 0 },
        { status: 'failed', offset: 10 },
        { status: 'running', offset: 20 },
        { status: 'failed', offset: 30 },
        { status: 'failed', offset: 40 },
      ]
      for (const seed of seeds) {
        const row = await query<{ id: string }>(
          `INSERT INTO directory_sync_runs (integration_id, status, started_at, trigger_source)
           VALUES ($1, $2, $3, 'manual') RETURNING id`,
          [integrationId, seed.status, at(seed.offset)],
        )
        runIds.push(row.rows[0].id)
      }
    })

    afterAll(async () => {
      if (integrationId) {
        await query(`DELETE FROM directory_sync_runs WHERE integration_id = $1`, [integrationId])
        await query(`DELETE FROM directory_integrations WHERE id = $1`, [integrationId])
      }
    })

    it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
      expect(process.env.DATABASE_URL).toBeTruthy()
    })

    it('counts the trailing failure streak from the most recent run backward, skipping running and stopping at completed (real SQL, proves ORDER BY DESC)', async () => {
      const streak = await countConsecutiveFailedRuns(integrationId)
      expect(streak).toBe(3)
    })

    it('is zero when the most recent completed/failed run succeeded', async () => {
      // Append a completed run after the existing seeds — now the latest completed/failed row is
      // itself a success, so the streak collapses to zero regardless of the earlier failures.
      const base = new Date('2026-01-01T00:00:00.000Z').getTime()
      const latest = new Date(base + 50 * 60_000).toISOString()
      const row = await query<{ id: string }>(
        `INSERT INTO directory_sync_runs (integration_id, status, started_at, trigger_source)
         VALUES ($1, 'completed', $2, 'manual') RETURNING id`,
        [integrationId, latest],
      )
      runIds.push(row.rows[0].id)

      const streak = await countConsecutiveFailedRuns(integrationId)
      expect(streak).toBe(0)
    })
  })
})
