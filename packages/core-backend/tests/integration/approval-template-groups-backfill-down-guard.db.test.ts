import { afterAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { query } from '../../src/db/pg'
import {
  up,
  down,
} from '../../src/db/migrations/zzzz20260919090000_create_approval_template_group_backfill_batches'

/**
 * Approval form grouping — design lock v2.13 (RATIFIED 2026-09-18), phase 2 slice A-3
 * ("backfill by existing category") — real-DB acceptance for the `down()` data-retention guard
 * on `zzzz20260919090000_create_approval_template_group_backfill_batches.ts` (design MD §23,
 * candidate, not yet ratified — see that migration's own `down()` doc comment for the full
 * provenance chain).
 *
 * Same shape as the sibling precedent this guard was modeled on —
 * `tests/integration/attendance-w4c0-durable-storage-smoke.db.test.ts:6,22-23` — which imports
 * `down` directly from a migration file and asserts it "fail-closes BEFORE DDL while any …
 * registry row exists". This file is the batch-tables' own version of that same test, plus the
 * force/empty/up-idempotent/table-existence cases the guard's own doc comment claims:
 *  - data present in all three tables -> down() rejects, before any DROP, tables/rows untouched;
 *  - force env set -> down() proceeds and actually drops all three tables (positive control,
 *    proving the Case-1 rejection above was THIS guard and not some other cause);
 *  - all three tables already missing -> down() must NOT crash with 42P01 (this is the guard's
 *    own regression test for the bug an independent implementation-gate review found in the
 *    original single-statement `CASE WHEN to_regclass(...) IS NULL THEN 0 ELSE (SELECT count(*)
 *    FROM t) END` form: Postgres resolves every relation name referenced anywhere in a statement
 *    at parse/analyze time, so the ELSE branch's table name was looked up even when unreachable);
 *  - half-applied (only the head table exists, the two child tables do not) WITH a row in the
 *    head table -> down() still rejects using the true count, and does so with
 *    ATG_BACKFILL_DOWN_BLOCKED, not 42P01 (proves the missing-table branch returns 0 for the
 *    genuinely-absent child tables while the present table's real count still drives the guard);
 *  - empty tables (present, zero rows) -> down() passes and actually drops them;
 *  - up() stays idempotent across all of the above DDL churn, and a second up() rebuilds cleanly
 *    after down() ran.
 *
 * Deliberately excluded from `vitest.config.ts`'s no-DB exclude list and from
 * `.github/workflows/plugin-tests.yml`'s `approval-real-db-integration` whitelist for this round:
 * the guard itself is still an unratified candidate (not merged, not applied to any shared/
 * staging/prod database), and this fix round's task explicitly required
 * `plugin-tests.yml`/s6a to stay byte-identical. `describeIfDatabase` below means this file is a
 * no-op (fully skipped) whenever DATABASE_URL is unset, exactly like every other `.db.test.ts`
 * file in this directory — so leaving it out of the exclude list does not change the no-DB
 * `pnpm test` run's outcome, only whether it is discovered-and-skipped vs not discovered. Wiring
 * this file into the real-DB CI lane (two-point wiring + its own `*-ci-wiring.test.mjs` guard +
 * s6a re-pin, per this repo's new-file census convention) is deferred to whichever round actually
 * proposes merging the guard, consistent with the round-1 gate report's own suggestion to do that
 * together with any other CI-facing changes in one commit rather than repin twice.
 *
 * This file exercises DDL directly (drops and recreates the three tables to simulate "missing"
 * and "half-applied" states) — safe because `vitest.integration.config.ts` runs all real-DB files
 * serially (`fileParallelism: false`, `maxConcurrency: 1`) and this file's own `afterAll` always
 * ends by calling `up()` again (idempotent `CREATE TABLE IF NOT EXISTS`) and deleting every row
 * this file itself inserted, restoring the three tables to the same present-and-empty shape any
 * sibling backfill file expects to find them in, regardless of which `it()` blocks ran or failed.
 */
const dbUrl = process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip
const EXPECT_DB = process.env.EXPECT_DB === '1'
const itIfExpectDb = EXPECT_DB ? it : it.skip

const FORCE_ENV = 'ALLOW_APPROVAL_TEMPLATE_GROUP_BACKFILL_DROP'
const HEAD = 'approval_template_group_backfill_batches'
const GROUPS = 'approval_template_group_backfill_batch_groups'
const LINKS = 'approval_template_group_backfill_batch_links'

type Snapshot = { exists: boolean; count: number }

async function snapshot(table: string): Promise<Snapshot> {
  const reg = await query<{ r: string | null }>(`SELECT to_regclass('public.${table}')::text AS r`)
  const exists = reg.rows[0].r !== null
  if (!exists) return { exists: false, count: -1 }
  const cnt = await query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`)
  return { exists: true, count: Number(cnt.rows[0].n) }
}

describeIfDatabase(
  'approval template groups — phase 2 backfill batch DDL down() data-retention guard (candidate, real DB)',
  () => {
    let migrationDb: Kysely<unknown> | undefined
    const templateIds: string[] = []
    const orgTags: string[] = []
    const batchIds: string[] = []

    itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
      expect(process.env.DATABASE_URL).toBeTruthy()
    })

    afterAll(async () => {
      delete process.env[FORCE_ENV]
      // Best-effort row cleanup before the final structural restore, in case a later assertion
      // in this file ever throws before its own cleanup runs.
      for (const id of batchIds.splice(0)) {
        await query(`DELETE FROM ${HEAD} WHERE id = $1`, [id]).catch(() => undefined)
      }
      for (const org of orgTags.splice(0)) {
        await query(`DELETE FROM approval_template_group_links WHERE org_id = $1`, [org]).catch(() => undefined)
        await query(`DELETE FROM approval_template_groups WHERE org_id = $1`, [org]).catch(() => undefined)
      }
      for (const id of templateIds.splice(0)) {
        await query(`DELETE FROM approval_templates WHERE id = $1`, [id]).catch(() => undefined)
      }
      // Structural restore: whatever DDL state this file's tests left behind (missing tables,
      // half-applied shape, etc.), `up()`'s `CREATE TABLE IF NOT EXISTS` brings all three back —
      // the shape every sibling backfill/schema/preview/execute/rollback/batches-list file
      // expects to find at its own start.
      if (!migrationDb) {
        migrationDb = new Kysely<unknown>({
          dialect: new PostgresDialect({ pool: new Pool({ connectionString: dbUrl }) }),
        })
      }
      await up(migrationDb)
      await migrationDb.destroy()
    })

    it('up() is idempotent before this file touches anything', async () => {
      const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: dbUrl }) }) })
      await expect(up(db)).resolves.toBeUndefined()
      await db.destroy()
      expect((await snapshot(HEAD)).exists).toBe(true)
    })

    it(
      'down() fail-closes BEFORE DDL while all three tables hold a row each, and leaves them ' +
        'byte-for-byte untouched (mirrors attendance-w4c0-durable-storage-smoke.db.test.ts:280-299)',
      async () => {
        const org = `atgbb-downguard-1-${Date.now()}`
        orgTags.push(org)
        const tmplId = (
          await query<{ id: string }>(
            `INSERT INTO approval_templates (key, name, category) VALUES ($1, $1, 'HR') RETURNING id`,
            [`atgbb-downguard-1-t-${Date.now()}`],
          )
        ).rows[0].id
        templateIds.push(tmplId)
        const groupId = `atgbb_downguard_1_g_${Date.now()}`
        await query(
          `INSERT INTO approval_template_groups (id, org_id, name, sort_order, created_by) VALUES ($1, $2, $2, 1, 'probe')`,
          [groupId, org],
        )
        const batchId = `atgbb_downguard_1_b_${Date.now()}`
        batchIds.push(batchId)
        await query(`INSERT INTO ${HEAD} (id, org_id, created_by) VALUES ($1, $2, 'probe')`, [batchId, org])
        const linkedAt = (
          await query<{ linked_at: Date }>(
            `INSERT INTO approval_template_group_links (org_id, template_id, group_id, linked_by, linked_at)
             VALUES ($1, $2, $3, 'probe', now()) RETURNING linked_at`,
            [org, tmplId, groupId],
          )
        ).rows[0].linked_at
        await query(`INSERT INTO ${GROUPS} (batch_id, org_id, group_id, created_new) VALUES ($1, $2, $3, true)`, [
          batchId,
          org,
          groupId,
        ])
        await query(
          `INSERT INTO ${LINKS} (batch_id, org_id, template_id, group_id, linked_at) VALUES ($1, $2, $3, $4, $5)`,
          [batchId, org, tmplId, groupId, linkedAt],
        )

        const before = await Promise.all([snapshot(HEAD), snapshot(GROUPS), snapshot(LINKS)])
        expect(before.every((s) => s.exists)).toBe(true)
        expect(before.every((s) => s.count >= 1)).toBe(true)

        migrationDb = new Kysely<unknown>({
          dialect: new PostgresDialect({ pool: new Pool({ connectionString: dbUrl }) }),
        })
        await expect(down(migrationDb)).rejects.toThrow(/ATG_BACKFILL_DOWN_BLOCKED/)
        await expect(down(migrationDb)).rejects.toThrow(new RegExp(FORCE_ENV))

        const after = await Promise.all([snapshot(HEAD), snapshot(GROUPS), snapshot(LINKS)])
        expect(after).toEqual(before) // fail-closed: zero DDL, zero row-count drift
      },
    )

    it('down() with the force env set passes and ACTUALLY drops all three tables (positive control for the case above)', async () => {
      // Same, still-populated fixture as the previous case — only the env var changes.
      expect((await snapshot(HEAD)).count).toBeGreaterThan(0)
      process.env[FORCE_ENV] = 'true'
      try {
        await expect(down(migrationDb!)).resolves.toBeUndefined()
      } finally {
        delete process.env[FORCE_ENV]
      }
      const after = await Promise.all([snapshot(HEAD), snapshot(GROUPS), snapshot(LINKS)])
      expect(after.every((s) => !s.exists)).toBe(true)
      // Only the three phase-2 batch tables were dropped (CASCADE took the batch_groups/
      // batch_links ROWS with the head row's table, since all three tables are gone) — the
      // phase-1 `approval_template_groups`/`approval_template_group_links` rows this fixture
      // created are untouched, separate tables. Clear batchIds only (nothing left to DELETE FROM,
      // the table itself is gone); orgTags/templateIds must stay so afterAll still cleans up the
      // phase-1 rows, or they leak into this shared DB.
      batchIds.length = 0
    })

    it('down() on fully-missing tables does not crash with 42P01 (P2-2 regression: the CASE-form guard parse-time-resolves the ELSE branch table name)', async () => {
      expect((await snapshot(HEAD)).exists).toBe(false)
      await expect(down(migrationDb!)).resolves.toBeUndefined()
      const after = await Promise.all([snapshot(HEAD), snapshot(GROUPS), snapshot(LINKS)])
      expect(after.every((s) => !s.exists)).toBe(true)
    })

    it('down() on empty (present, zero-row) tables passes and drops them', async () => {
      await up(migrationDb!)
      const before = await Promise.all([snapshot(HEAD), snapshot(GROUPS), snapshot(LINKS)])
      expect(before.every((s) => s.exists && s.count === 0)).toBe(true)
      await expect(down(migrationDb!)).resolves.toBeUndefined()
      const after = await Promise.all([snapshot(HEAD), snapshot(GROUPS), snapshot(LINKS)])
      expect(after.every((s) => !s.exists)).toBe(true)
    })

    it(
      'half-applied state (only the head table exists) WITH a row still fail-closes using the ' +
        'true count, with ATG_BACKFILL_DOWN_BLOCKED — not 42P01 (P2-2 regression, second shape)',
      async () => {
        await up(migrationDb!) // rebuild all three (previous case dropped everything)
        // Now knock out just the two children, simulating a partially-applied `up()`/partially-
        // dropped environment where only the batch head table survives.
        await query(`DROP TABLE IF EXISTS ${LINKS}`)
        await query(`DROP TABLE IF EXISTS ${GROUPS}`)
        const batchId = `atgbb_downguard_half_${Date.now()}`
        const org = `atgbb-downguard-half-${Date.now()}`
        await query(`INSERT INTO ${HEAD} (id, org_id, created_by) VALUES ($1, $2, 'probe')`, [batchId, org])
        batchIds.push(batchId)

        expect((await snapshot(GROUPS)).exists).toBe(false)
        expect((await snapshot(LINKS)).exists).toBe(false)
        expect((await snapshot(HEAD)).count).toBe(1)

        let caught: unknown
        try {
          await down(migrationDb!)
        } catch (e) {
          caught = e
        }
        expect(caught).toBeInstanceOf(Error)
        expect((caught as Error).message).toMatch(/ATG_BACKFILL_DOWN_BLOCKED/)
        expect((caught as Error).message).not.toMatch(/42P01/)
        // Fail-closed: the head table (the only one that existed) still survives, still 1 row.
        expect((await snapshot(HEAD))).toEqual({ exists: true, count: 1 })
      },
    )

    it('up() remains idempotent after this file\'s DDL churn, restoring the full three-table shape', async () => {
      // Clear the half-applied fixture's row before the structural restore below (afterAll would
      // also delete it, but this keeps this test's own before/after self-contained).
      await query(`DELETE FROM ${HEAD} WHERE id = ANY($1::text[])`, [batchIds.splice(0)])
      await expect(up(migrationDb!)).resolves.toBeUndefined()
      await expect(up(migrationDb!)).resolves.toBeUndefined() // second call: still a no-op
      const after = await Promise.all([snapshot(HEAD), snapshot(GROUPS), snapshot(LINKS)])
      expect(after).toEqual([
        { exists: true, count: 0 },
        { exists: true, count: 0 },
        { exists: true, count: 0 },
      ])
    })
  },
)
