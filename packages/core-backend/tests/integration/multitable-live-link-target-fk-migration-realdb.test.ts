/**
 * Time Machine closeout: authoritative live-link target FK migration.
 *
 * This suite reconstructs the pre-migration tables in an isolated schema and runs the real
 * migration module. It pins the target-side posture: historical dangling rows remain repairable,
 * new dangling writes fail, and target deletes cannot erase authoritative link rows by cascade.
 */
import { randomUUID } from 'node:crypto'

import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  LIVE_TARGET_CONSTRAINT,
  down as migrateDown,
  up as migrateUp,
} from '../../src/db/migrations/zzzz20260721120000_guard_meta_links_live_targets'
import { up as migrateCorrection } from '../../src/db/migrations/zzzz20260728121000_correct_meta_links_live_target_fk'

const dbUrl = process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

type ConstraintShape = {
  oid: number
  contype: string
  source_columns: string[]
  target_table_matches: boolean
  target_columns: string[]
  confdeltype: string
  condeferrable: boolean
  condeferred: boolean
  convalidated: boolean
  definition: string
}

const DRIFT_CASES = [
  {
    dimension: 'contype',
    ddl: `ALTER TABLE meta_links
      ADD CONSTRAINT ${LIVE_TARGET_CONSTRAINT}
      CHECK (foreign_record_id <> '')`,
  },
  {
    dimension: 'conkey',
    ddl: `ALTER TABLE meta_links
      ADD CONSTRAINT ${LIVE_TARGET_CONSTRAINT}
      FOREIGN KEY (record_id) REFERENCES meta_records(id)
      ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE NOT VALID`,
  },
  {
    dimension: 'confrelid',
    ddl: `ALTER TABLE meta_links
      ADD CONSTRAINT ${LIVE_TARGET_CONSTRAINT}
      FOREIGN KEY (foreign_record_id) REFERENCES other_records(id)
      ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE NOT VALID`,
  },
  {
    dimension: 'confkey',
    ddl: `ALTER TABLE meta_links
      ADD CONSTRAINT ${LIVE_TARGET_CONSTRAINT}
      FOREIGN KEY (foreign_record_id) REFERENCES meta_records(alternate_id)
      ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE NOT VALID`,
  },
  {
    dimension: 'confdeltype',
    ddl: `ALTER TABLE meta_links
      ADD CONSTRAINT ${LIVE_TARGET_CONSTRAINT}
      FOREIGN KEY (foreign_record_id) REFERENCES meta_records(id)
      ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE NOT VALID`,
  },
  {
    dimension: 'condeferrable',
    ddl: `ALTER TABLE meta_links
      ADD CONSTRAINT ${LIVE_TARGET_CONSTRAINT}
      FOREIGN KEY (foreign_record_id) REFERENCES meta_records(id)
      ON DELETE NO ACTION NOT DEFERRABLE NOT VALID`,
  },
  {
    dimension: 'condeferred',
    ddl: `ALTER TABLE meta_links
      ADD CONSTRAINT ${LIVE_TARGET_CONSTRAINT}
      FOREIGN KEY (foreign_record_id) REFERENCES meta_records(id)
      ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED NOT VALID`,
  },
] as const

describeDb('live-link target FK migration (real DB, isolated schema)', () => {
  let adminPool: Pool
  let schema: string
  let testPool: Pool
  let testDb: Kysely<unknown>

  beforeEach(async () => {
    adminPool = new Pool({ connectionString: dbUrl })
    schema = `tmfk_${randomUUID().replace(/-/g, '')}`
    await adminPool.query(`CREATE SCHEMA "${schema}"`)

    testPool = new Pool({
      connectionString: dbUrl,
      options: `-c search_path=${schema}`,
    })
    testDb = new Kysely<unknown>({
      dialect: new PostgresDialect({ pool: testPool }),
    })

    await sql`
      CREATE TABLE meta_records (
        id text PRIMARY KEY,
        alternate_id text NOT NULL UNIQUE
      )
    `.execute(testDb)
    await sql`
      CREATE TABLE other_records (
        id text PRIMARY KEY
      )
    `.execute(testDb)
    await sql`
      CREATE TABLE meta_links (
        id text PRIMARY KEY,
        record_id text NOT NULL REFERENCES meta_records(id) ON DELETE CASCADE,
        foreign_record_id text NOT NULL
      )
    `.execute(testDb)
  })

  afterEach(async () => {
    await testDb.destroy()
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await adminPool.end()
  })

  const insertRecord = (id: string) =>
    sql`INSERT INTO meta_records (id, alternate_id) VALUES (${id}, ${`${id}_alternate`})`.execute(
      testDb,
    )

  const loadConstraint = async (): Promise<ConstraintShape | undefined> => {
    const result = await sql<ConstraintShape>`
      SELECT
        c.oid,
        c.contype,
        ARRAY(
          SELECT a.attname
            FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a
              ON a.attrelid = c.conrelid
             AND a.attnum = k.attnum
           ORDER BY k.ord
        )::text[] AS source_columns,
        c.confrelid = 'meta_records'::regclass AS target_table_matches,
        ARRAY(
          SELECT a.attname
            FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a
              ON a.attrelid = c.confrelid
             AND a.attnum = k.attnum
           ORDER BY k.ord
        )::text[] AS target_columns,
        c.confdeltype,
        c.condeferrable,
        c.condeferred,
        c.convalidated,
        pg_get_constraintdef(c.oid, true) AS definition
      FROM pg_constraint c
      WHERE c.conrelid = 'meta_links'::regclass
        AND c.conname = ${LIVE_TARGET_CONSTRAINT}
    `.execute(testDb)

    return result.rows[0]
  }

  const countConstraint = async (): Promise<number> => {
    const result = await sql<{ count: number }>`
      SELECT count(*)::int AS count
      FROM pg_constraint
      WHERE conrelid = 'meta_links'::regclass
        AND conname = ${LIVE_TARGET_CONSTRAINT}
    `.execute(testDb)
    return result.rows[0].count
  }

  it('fresh up installs the exact deferrable NO ACTION shape and preserves historical dangling rows', async () => {
    await insertRecord('source')
    await sql`
      INSERT INTO meta_links (id, record_id, foreign_record_id)
      VALUES ('historical_link', 'source', 'missing_before_migration')
    `.execute(testDb)

    await migrateUp(testDb)

    expect(await loadConstraint()).toMatchObject({
      contype: 'f',
      source_columns: ['foreign_record_id'],
      target_table_matches: true,
      target_columns: ['id'],
      confdeltype: 'a',
      condeferrable: true,
      condeferred: false,
      convalidated: false,
    })

    const historical = await sql<{ count: number }>`
      SELECT count(*)::int AS count
      FROM meta_links
      WHERE id = 'historical_link'
    `.execute(testDb)
    expect(historical.rows[0].count).toBe(1)

    await expect(
      sql`
        INSERT INTO meta_links (id, record_id, foreign_record_id)
        VALUES ('new_dangling_link', 'source', 'missing_after_migration')
      `.execute(testDb),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: LIVE_TARGET_CONSTRAINT,
    })
  })

  it('replay is idempotent and retains the original constraint object', async () => {
    await migrateUp(testDb)
    const first = await loadConstraint()

    await migrateUp(testDb)
    const replayed = await loadConstraint()

    expect(await countConstraint()).toBe(1)
    expect(replayed?.oid).toBe(first?.oid)
    expect(replayed?.definition).toBe(first?.definition)
  })

  it('corrective migration replaces only the exact legacy CASCADE shape', async () => {
    await sql`
      ALTER TABLE meta_links
        ADD CONSTRAINT ${sql.raw(LIVE_TARGET_CONSTRAINT)}
        FOREIGN KEY (foreign_record_id)
        REFERENCES meta_records(id)
        ON DELETE CASCADE
        DEFERRABLE INITIALLY IMMEDIATE
        NOT VALID
    `.execute(testDb)
    const legacy = await loadConstraint()
    expect(legacy?.confdeltype).toBe('c')

    await migrateCorrection(testDb)
    const corrected = await loadConstraint()
    expect(corrected).toMatchObject({
      confdeltype: 'a',
      condeferrable: true,
      condeferred: false,
      convalidated: false,
    })
    expect(corrected?.oid).not.toBe(legacy?.oid)
    await expect(migrateCorrection(testDb)).resolves.toBeUndefined()
    expect(await countConstraint()).toBe(1)
  })

  it('corrective migration fails loudly on a same-name wrong-column constraint', async () => {
    await sql`
      ALTER TABLE meta_links
        ADD CONSTRAINT ${sql.raw(LIVE_TARGET_CONSTRAINT)}
        FOREIGN KEY (record_id)
        REFERENCES meta_records(id)
        ON DELETE CASCADE
        DEFERRABLE INITIALLY IMMEDIATE
        NOT VALID
    `.execute(testDb)

    await expect(migrateCorrection(testDb)).rejects.toMatchObject({
      code: '55000',
      message: expect.stringContaining(
        `existing constraint ${LIVE_TARGET_CONSTRAINT} has unexpected definition`,
      ),
    })
    expect((await loadConstraint())?.source_columns).toEqual(['record_id'])
  })

  it('corrective migration classifies a same-name non-FK as explicit operator-owned drift', async () => {
    await sql`
      ALTER TABLE meta_links
        ADD CONSTRAINT ${sql.raw(LIVE_TARGET_CONSTRAINT)}
        CHECK (foreign_record_id <> '')
    `.execute(testDb)

    await expect(migrateCorrection(testDb)).rejects.toMatchObject({
      code: '55000',
      message: expect.stringContaining(
        `existing constraint ${LIVE_TARGET_CONSTRAINT} has unexpected definition`,
      ),
    })
    expect(await countConstraint()).toBe(1)
  })

  it('down removes only the target guard and can be replayed', async () => {
    await migrateUp(testDb)

    await migrateDown(testDb)
    expect(await countConstraint()).toBe(0)

    await expect(migrateDown(testDb)).resolves.toBeUndefined()
    expect(await countConstraint()).toBe(0)
  })

  it.each(DRIFT_CASES)(
    'fails loudly when the existing same-name constraint has the wrong $dimension',
    async ({ ddl }) => {
      await sql.raw(ddl).execute(testDb)

      await expect(migrateUp(testDb)).rejects.toMatchObject({
        code: '55000',
        message: expect.stringContaining(
          `existing constraint ${LIVE_TARGET_CONSTRAINT} has unexpected definition`,
        ),
      })

      expect(await countConstraint()).toBe(1)
    },
  )

  it('rejects target deletion instead of cascading, then permits explicit link cleanup followed by delete', async () => {
    await insertRecord('source')
    await insertRecord('target')
    await migrateUp(testDb)
    await sql`
      INSERT INTO meta_links (id, record_id, foreign_record_id)
      VALUES ('authoritative_link', 'source', 'target')
    `.execute(testDb)

    await expect(
      sql`DELETE FROM meta_records WHERE id = 'target'`.execute(testDb),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: LIVE_TARGET_CONSTRAINT,
    })

    const afterRejectedDelete = await sql<{ records: number; links: number }>`
      SELECT
        (SELECT count(*)::int FROM meta_records WHERE id = 'target') AS records,
        (SELECT count(*)::int FROM meta_links WHERE id = 'authoritative_link') AS links
    `.execute(testDb)
    expect(afterRejectedDelete.rows[0]).toEqual({ records: 1, links: 1 })

    await sql`DELETE FROM meta_links WHERE id = 'authoritative_link'`.execute(
      testDb,
    )
    await expect(
      sql`DELETE FROM meta_records WHERE id = 'target'`.execute(testDb),
    ).resolves.toBeTruthy()

    const targetCount = await sql<{ count: number }>`
      SELECT count(*)::int AS count FROM meta_records WHERE id = 'target'
    `.execute(testDb)
    expect(targetCount.rows[0].count).toBe(0)
  })
})
