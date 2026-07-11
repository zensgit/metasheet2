import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import pg from 'pg'
import {
  resolveBackfillDepartmentOrder,
  runPrimaryDepartmentBackfill,
} from '../../scripts/backfill-directory-primary-department'

/**
 * DT-HARDEN-07 — the backfill, against real Postgres.
 *
 * The design-lock names `--dry-run` as the operator's go/no-go for flipping a live
 * approval-routing flag, and nothing exercised the script at all. Two consequences, both
 * measured on real PG before this test existed:
 *
 *  - it was NOT idempotent. `departmentIds` came from row order, there is no ordering column,
 *    and every `UPDATE` moves a tuple to the heap tail — so the primary department walked one
 *    step per run, *with the flag off*.
 *  - `--dry-run` therefore reported changes the sync would never make.
 *
 * The fixture below is chosen so `dept_id_list` order and alphabetical order DISAGREE
 * (`bfz` is declared first, `bfa` sorts first). A regression that re-derives the order from
 * rows — heap order, or the query's `ORDER BY external_department_id` — picks the wrong
 * department and turns these red.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const DEPT_DECLARED_FIRST = `bfz-${TS}` // dept_id_list[0]; sorts LAST
const DEPT_SORTS_FIRST = `bfa-${TS}` // sorts FIRST; declared second

describeIfDatabase('DT-HARDEN-07 primary-department backfill (real DB)', () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
  let integrationId = ''
  let accountId = ''
  const departmentIds = new Map<string, string>()

  const primaryOf = async (account: string) =>
    (await pool.query<{ external_department_id: string }>(
      `SELECT d.external_department_id
         FROM directory_account_departments ad
         JOIN directory_departments d ON d.id = ad.directory_department_id
        WHERE ad.directory_account_id = $1 AND ad.is_primary = true`,
      [account],
    )).rows.map((r) => r.external_department_id)

  async function seedAccount(raw: unknown, primaryExternalId: string | null): Promise<string> {
    const id = (await pool.query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, raw)
       VALUES ($1, $2, $3, 'Backfill Fixture', $4::jsonb) RETURNING id`,
      [integrationId, `ext-bf-${TS}-${Math.random().toString(36).slice(2, 8)}`,
        `key-bf-${TS}-${Math.random().toString(36).slice(2, 8)}`, JSON.stringify(raw)],
    )).rows[0].id

    for (const [external, deptId] of departmentIds) {
      await pool.query(
        `INSERT INTO directory_account_departments (directory_account_id, directory_department_id, is_primary)
         VALUES ($1, $2, $3)`,
        [id, deptId, external === primaryExternalId],
      )
    }
    return id
  }

  beforeEach(async () => {
    integrationId = (await pool.query<{ id: string }>(
      `INSERT INTO directory_integrations (name, corp_id) VALUES ($1, $2) RETURNING id`,
      [`bf-${TS}-${Math.random().toString(36).slice(2, 8)}`, `bf-corp-${TS}-${Math.random().toString(36).slice(2, 8)}`],
    )).rows[0].id

    departmentIds.clear()
    for (const external of [DEPT_DECLARED_FIRST, DEPT_SORTS_FIRST]) {
      const row = (await pool.query<{ id: string }>(
        `INSERT INTO directory_departments (integration_id, external_department_id, name, is_active, raw)
         VALUES ($1, $2, $3, true, '{}'::jsonb) RETURNING id`,
        [integrationId, external, `Dept ${external}`],
      )).rows[0]
      departmentIds.set(external, row.id)
    }
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await pool.query(`DELETE FROM directory_accounts WHERE integration_id = $1`, [integrationId])
    await pool.query(`DELETE FROM directory_departments WHERE integration_id = $1`, [integrationId])
    await pool.query(`DELETE FROM directory_integrations WHERE id = $1`, [integrationId])
  })

  afterAll(async () => {
    await pool.end()
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  describe('resolveBackfillDepartmentOrder', () => {
    it('follows dept_id_list, not row order', () => {
      expect(resolveBackfillDepartmentOrder({ dept_id_list: ['z', 'a'] }, ['a', 'z'])).toEqual(['z', 'a'])
    })

    it('appends rows the payload does not declare, in a stable order', () => {
      expect(resolveBackfillDepartmentOrder({ dept_id_list: ['z'] }, ['m', 'a', 'z'])).toEqual(['z', 'a', 'm'])
    })

    it('returns null — never a guess — when the payload has no usable list', () => {
      expect(resolveBackfillDepartmentOrder({}, ['a'])).toBeNull()
      expect(resolveBackfillDepartmentOrder(null, ['a'])).toBeNull()
      expect(resolveBackfillDepartmentOrder({ dept_id_list: [] }, ['a'])).toBeNull()
      expect(resolveBackfillDepartmentOrder({ dept_id_list: 'nope' }, ['a'])).toBeNull()
    })
  })

  // THE P1. Flag off, correct data: the backfill must be a no-op, forever.
  it('flag off + already-correct rows: dry-run predicts nothing and apply changes nothing, over 3 runs', async () => {
    const raw = { dept_id_list: [DEPT_DECLARED_FIRST, DEPT_SORTS_FIRST] }
    accountId = await seedAccount(raw, DEPT_DECLARED_FIRST) // what the sync would have written

    const dry = await runPrimaryDepartmentBackfill(pool, { dryRun: true, integrationId })
    expect(dry.changed).toBe(0)
    expect(dry.skipped).toBe(0)

    for (let run = 1; run <= 3; run += 1) {
      const summary = await runPrimaryDepartmentBackfill(pool, { dryRun: false, integrationId })
      expect(summary.changed, `run #${run} must write nothing`).toBe(0)
      await expect(primaryOf(accountId)).resolves.toEqual([DEPT_DECLARED_FIRST])
    }
  })

  // The walk: previously run #1 → 200, run #2 → 300, run #3 → 400 changed rows.
  it('flag off + wrong primary: fixes it once, then is idempotent across further runs', async () => {
    const raw = { dept_id_list: [DEPT_DECLARED_FIRST, DEPT_SORTS_FIRST] }
    accountId = await seedAccount(raw, DEPT_SORTS_FIRST) // wrong: the sorts-first dept is flagged

    const first = await runPrimaryDepartmentBackfill(pool, { dryRun: false, integrationId })
    expect(first.changed).toBe(2) // demote one, promote the other
    await expect(primaryOf(accountId)).resolves.toEqual([DEPT_DECLARED_FIRST])

    for (let run = 2; run <= 4; run += 1) {
      const summary = await runPrimaryDepartmentBackfill(pool, { dryRun: false, integrationId })
      expect(summary.changed, `run #${run} must be a no-op`).toBe(0)
      await expect(primaryOf(accountId)).resolves.toEqual([DEPT_DECLARED_FIRST])
    }
  })

  it('dry-run writes nothing and predicts exactly what apply then does', async () => {
    const raw = { dept_id_list: [DEPT_DECLARED_FIRST, DEPT_SORTS_FIRST] }
    accountId = await seedAccount(raw, DEPT_SORTS_FIRST)

    const dry = await runPrimaryDepartmentBackfill(pool, { dryRun: true, integrationId })
    expect(dry.changed).toBe(2)
    await expect(primaryOf(accountId)).resolves.toEqual([DEPT_SORTS_FIRST]) // untouched

    const applied = await runPrimaryDepartmentBackfill(pool, { dryRun: false, integrationId })
    expect(applied.changed).toBe(dry.changed) // the prediction was honest
    await expect(primaryOf(accountId)).resolves.toEqual([DEPT_DECLARED_FIRST])
  })

  it('flag on: re-routes to the lowest dept_order_list order, and dry-run shows it first', async () => {
    const raw = {
      dept_id_list: [DEPT_DECLARED_FIRST, DEPT_SORTS_FIRST],
      dept_order_list: [{ dept_id: DEPT_SORTS_FIRST, order: 1 }, { dept_id: DEPT_DECLARED_FIRST, order: 9 }],
    }
    accountId = await seedAccount(raw, DEPT_DECLARED_FIRST) // correct while the flag is off

    // Flag off → nothing to do. This is the operator's baseline.
    expect((await runPrimaryDepartmentBackfill(pool, { dryRun: true, integrationId })).changed).toBe(0)

    vi.stubEnv('DIRECTORY_PRIMARY_DEPT_FROM_ORDER', 'true')
    const dry = await runPrimaryDepartmentBackfill(pool, { dryRun: true, integrationId })
    expect(dry.changed).toBe(2) // the switch WOULD re-route this person
    await expect(primaryOf(accountId)).resolves.toEqual([DEPT_DECLARED_FIRST]) // still untouched

    await runPrimaryDepartmentBackfill(pool, { dryRun: false, integrationId })
    await expect(primaryOf(accountId)).resolves.toEqual([DEPT_SORTS_FIRST])
  })

  it('skips an account whose raw has no dept_id_list, leaving its primary untouched', async () => {
    accountId = await seedAccount({ userid: 'legacy-no-dept-list' }, DEPT_SORTS_FIRST)

    const summary = await runPrimaryDepartmentBackfill(pool, { dryRun: false, integrationId })
    expect(summary.skipped).toBe(1)
    expect(summary.changed).toBe(0)
    await expect(primaryOf(accountId)).resolves.toEqual([DEPT_SORTS_FIRST]) // not guessed at
  })

  it('leaves exactly one primary after re-routing', async () => {
    const raw = {
      dept_id_list: [DEPT_DECLARED_FIRST, DEPT_SORTS_FIRST],
      dept_order_list: [{ dept_id: DEPT_SORTS_FIRST, order: 1 }, { dept_id: DEPT_DECLARED_FIRST, order: 9 }],
    }
    accountId = await seedAccount(raw, DEPT_DECLARED_FIRST)
    vi.stubEnv('DIRECTORY_PRIMARY_DEPT_FROM_ORDER', 'true')

    await runPrimaryDepartmentBackfill(pool, { dryRun: false, integrationId })
    expect((await primaryOf(accountId)).length).toBe(1)
  })
})
