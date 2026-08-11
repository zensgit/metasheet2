import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { up as createFixedScheduleConfigs } from '../../src/db/migrations/zzzz20260803120000_create_attendance_group_fixed_schedule_configs'

const require = createRequire(import.meta.url)
const configServiceLib = require('../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-config-service.cjs') as {
  ATTENDANCE_FIXED_SCHEDULE_CONFIG_CHANGED: string
  createAttendanceGroupFixedScheduleConfigService(input: Record<string, unknown>): {
    resolveConfigForApplyRebuild(
      trx: { query(text: string, values?: unknown[]): Promise<Array<Record<string, unknown>>> },
      input: Record<string, unknown>,
    ): Promise<{ config: { shiftId: string }; created: boolean }>
  }
}

class FakeHttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
  }
}

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip
const filename = 'attendance-group-fixed-schedule-config-consume.db.test.ts'

describe('FSER-3 real-DB CI wiring', () => {
  it('is excluded from the no-DB lane and explicitly included in the attendance real-DB lane', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
    const vitestConfig = readFileSync(path.join(repoRoot, 'packages/core-backend/vitest.config.ts'), 'utf8')
    const workflow = readFileSync(path.join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
    expect(vitestConfig).toContain(`tests/integration/${filename}`)
    expect(workflow).toContain(`tests/integration/${filename}`)
  })
})

describeDb('FSER-3 apply/rebuild config consumption (real DB)', () => {
  let adminPool: Pool
  let pool: Pool
  let schema: string
  let db: Kysely<unknown>
  let groupId: string
  let shiftA: string
  let shiftB: string
  const orgId = 'fser3-org'
  const userId = 'fser3-member'

  const service = configServiceLib.createAttendanceGroupFixedScheduleConfigService({ HttpError: FakeHttpError })

  beforeEach(async () => {
    adminPool = new Pool({ connectionString: dbUrl })
    schema = `fser3_${randomUUID().replace(/-/g, '')}`
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({
      connectionString: dbUrl,
      max: 4,
      options: `-c search_path=${schema} -c statement_timeout=10000`,
    })
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })

    await sql`
      CREATE TABLE attendance_groups (
        id uuid PRIMARY KEY,
        org_id text NOT NULL,
        CONSTRAINT attendance_groups_id_org_unique UNIQUE (id, org_id)
      )
    `.execute(db)
    await sql`
      CREATE TABLE attendance_shifts (
        id uuid PRIMARY KEY,
        org_id text NOT NULL,
        CONSTRAINT attendance_shifts_id_org_unique UNIQUE (id, org_id)
      )
    `.execute(db)
    await sql`
      CREATE TABLE attendance_group_members (
        org_id text NOT NULL,
        group_id uuid NOT NULL,
        user_id text NOT NULL
      )
    `.execute(db)
    await sql`
      CREATE TABLE fser3_assignment_effects (
        org_id text NOT NULL,
        group_id uuid NOT NULL,
        user_id text NOT NULL,
        shift_id uuid NOT NULL,
        CONSTRAINT fser3_assignment_effects_unique UNIQUE (org_id, group_id, user_id)
      )
    `.execute(db)
    await createFixedScheduleConfigs(db)

    groupId = randomUUID()
    shiftA = randomUUID()
    shiftB = randomUUID()
    await pool.query('INSERT INTO attendance_groups (id, org_id) VALUES ($1, $2)', [groupId, orgId])
    await pool.query('INSERT INTO attendance_shifts (id, org_id) VALUES ($1, $3), ($2, $3)', [shiftA, shiftB, orgId])
    await pool.query(
      'INSERT INTO attendance_group_members (org_id, group_id, user_id) VALUES ($1, $2, $3)',
      [orgId, groupId, userId],
    )
  })

  afterEach(async () => {
    await db.destroy()
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await adminPool.end()
  })

  function candidate(shiftId = shiftA) {
    return {
      orgId,
      groupId,
      shiftId,
      startDate: '2026-08-01',
      endDate: '2026-08-31',
      updatedBy: 'fser3-admin',
    }
  }

  function createFirstReadBarrier(parties: number) {
    let arrivals = 0
    let release: (() => void) | undefined
    const opened = new Promise<void>((resolve) => { release = resolve })
    return async (statement: string, rows: Array<Record<string, unknown>>) => {
      if (!statement.includes('FROM attendance_group_fixed_schedule_configs')
        || !statement.includes('FOR UPDATE')
        || rows.length !== 0) return
      arrivals += 1
      if (arrivals === parties) release?.()
      await opened
    }
  }

  function transactionClient(client: PoolClient, firstReadBarrier?: ReturnType<typeof createFirstReadBarrier>) {
    return {
      async query(statement: string, values: unknown[] = []) {
        const rows = (await client.query(statement, values)).rows as Array<Record<string, unknown>>
        await firstReadBarrier?.(statement, rows)
        return rows
      },
    }
  }

  async function materialize(
    desired: ReturnType<typeof candidate>,
    firstReadBarrier?: ReturnType<typeof createFirstReadBarrier>,
    failAfterAssignment = false,
  ) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const resolved = await service.resolveConfigForApplyRebuild(transactionClient(client, firstReadBarrier), desired)
      await client.query(
        `INSERT INTO fser3_assignment_effects (org_id, group_id, user_id, shift_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (org_id, group_id, user_id) DO NOTHING`,
        [orgId, groupId, userId, resolved.config.shiftId],
      )
      if (failAfterAssignment) throw new Error('synthetic materialization failure')
      await client.query('COMMIT')
      return resolved
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async function counts() {
    const configs = await pool.query('SELECT count(*)::int AS total FROM attendance_group_fixed_schedule_configs')
    const effects = await pool.query('SELECT count(*)::int AS total FROM fser3_assignment_effects')
    return { configs: configs.rows[0].total as number, effects: effects.rows[0].total as number }
  }

  it('creates desired config and assignment effect in one successful transaction', async () => {
    const result = await materialize(candidate())
    expect(result).toMatchObject({ created: true, config: { shiftId: shiftA } })
    expect(await counts()).toEqual({ configs: 1, effects: 1 })
  })

  it('rolls back both the first-created config and assignment effect when materialization fails', async () => {
    await expect(materialize(candidate(), undefined, true)).rejects.toThrow('synthetic materialization failure')
    expect(await counts()).toEqual({ configs: 0, effects: 0 })
  })

  it('converges two real concurrent identical first candidates without a uniqueness error', async () => {
    const barrier = createFirstReadBarrier(2)
    const results = await Promise.all([materialize(candidate(), barrier), materialize(candidate(), barrier)])
    expect(results.filter(result => result.created)).toHaveLength(1)
    expect(await counts()).toEqual({ configs: 1, effects: 1 })
  })

  it('lets one different concurrent candidate win and rejects the loser with typed 409 and no losing effect', async () => {
    const barrier = createFirstReadBarrier(2)
    const results = await Promise.allSettled([
      materialize(candidate(shiftA), barrier),
      materialize(candidate(shiftB), barrier),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(result => result.status === 'rejected')
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: {
        status: 409,
        code: configServiceLib.ATTENDANCE_FIXED_SCHEDULE_CONFIG_CHANGED,
      },
    })
    expect(await counts()).toEqual({ configs: 1, effects: 1 })
    const stored = await pool.query(
      `SELECT c.shift_id::text AS config_shift, e.shift_id::text AS effect_shift
         FROM attendance_group_fixed_schedule_configs c
         JOIN fser3_assignment_effects e USING (org_id, group_id)`,
    )
    expect(stored.rows).toHaveLength(1)
    expect(stored.rows[0].effect_shift).toBe(stored.rows[0].config_shift)
  })
})
