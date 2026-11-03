/**
 * 一个项目一张备料表 — G1 field defect (R67): migration
 * `zzzz20261015090000_admit_stock_prep_project_target_failed_pull_outcome`, against a FAKE database (no PostgreSQL).
 *
 *   M-01 up() issues exactly two statements on the registry table — DROP CONSTRAINT IF EXISTS, then ADD CONSTRAINT
 *        with the four outcomes — and a second up() issues the same two (idempotent by construction).
 *   M-02 down() with no `failed` row: one count read, then DROP + ADD with 087's three outcomes.
 *   M-03 down() with `failed` rows: the typed refusal naming the count, and NO ALTER at all.
 *   M-04 THE LISTS: up()'s list is set-equal to the plugin store's PROJECT_TARGET_PULL_OUTCOMES (what the plugin
 *        stamps), down()'s list is exactly migration 087's CHECK list (read from the SQL file).
 *
 * The fake answers ONLY the statements the migration is expected to issue (whitespace-normalised) and throws on
 * anything else. The same migration runs against real PostgreSQL in CI:
 * tests/integration/stock-prep-w2-scoped-repair-realdb.test.ts (G1 block: isolated schema, real 087 SQL).
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely'
import { describe, expect, it } from 'vitest'

import {
  FAILED_PULL_OUTCOME_DOWN_REFUSED_CODE,
  PULL_OUTCOMES,
  PULL_OUTCOMES_087,
  PULL_OUTCOME_CONSTRAINT,
  PROJECT_TARGET_TABLE,
  down,
  up,
} from '../../src/db/migrations/zzzz20261015090000_admit_stock_prep_project_target_failed_pull_outcome'

const require_ = createRequire(__filename)
const projectTargetStore = require_('../../../../plugins/plugin-integration-core/lib/stock-preparation-project-target-store.cjs') as {
  PROJECT_TARGET_PULL_OUTCOMES: readonly string[]
}

const norm = (text: string) => text.replace(/\s+/g, ' ').trim()
const DROP = `ALTER TABLE "${PROJECT_TARGET_TABLE}" DROP CONSTRAINT IF EXISTS "${PULL_OUTCOME_CONSTRAINT}"`
const ADD = (outcomes: readonly string[]) =>
  `ALTER TABLE "${PROJECT_TARGET_TABLE}" ADD CONSTRAINT "${PULL_OUTCOME_CONSTRAINT}" CHECK (last_pull_outcome IS NULL OR last_pull_outcome IN (${outcomes.map((o) => `'${o}'`).join(', ')}))`
const COUNT = `SELECT count(*)::int AS count FROM "${PROJECT_TARGET_TABLE}" WHERE last_pull_outcome = 'failed'`

function createFakeDb(state: { failedRows: number }, recorded: string[]): Kysely<unknown> {
  const connection: DatabaseConnection = {
    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const text = norm(compiled.sql)
      recorded.push(text)
      expect(compiled.parameters).toEqual([])
      if (text === COUNT) return { rows: [{ count: state.failedRows }] as unknown as R[] }
      if (text.startsWith('ALTER TABLE ')) return { rows: [] }
      throw new Error(`FAKE_DB_UNKNOWN_STATEMENT: ${text}`)
    },
    streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
      throw new Error('streamQuery is not used by migrations')
    },
  }
  const driver: Driver = {
    async init() {},
    async acquireConnection() { return connection },
    async beginTransaction() {},
    async commitTransaction() {},
    async rollbackTransaction() {},
    async releaseConnection() {},
    async destroy() {},
  }
  return new Kysely<unknown>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  })
}

describe('zzzz20261015090000 admit `failed` on the project-sheet registry outcome (fake DB)', () => {
  it('M-01 up(): DROP IF EXISTS then ADD with the four outcomes; a second up() issues the same pair', async () => {
    const recorded: string[] = []
    const db = createFakeDb({ failedRows: 0 }, recorded)
    await up(db)
    expect(recorded).toEqual([DROP, ADD(['applied', 'previewed', 'refused', 'failed'])])
    await up(db)
    expect(recorded).toEqual([DROP, ADD(['applied', 'previewed', 'refused', 'failed']), DROP, ADD(['applied', 'previewed', 'refused', 'failed'])])
  })

  it('M-02 down() with no failed row: count, then DROP + ADD with 087\'s three', async () => {
    const recorded: string[] = []
    await down(createFakeDb({ failedRows: 0 }, recorded))
    expect(recorded).toEqual([COUNT, DROP, ADD(['applied', 'previewed', 'refused'])])
  })

  it('M-03 down() with failed rows refuses with its code and the count, and alters nothing', async () => {
    const recorded: string[] = []
    const error = await down(createFakeDb({ failedRows: 3 }, recorded)).then(() => null, (caught: unknown) => caught as Error & { code?: string })
    expect(error).not.toBeNull()
    expect(error?.code).toBe(FAILED_PULL_OUTCOME_DOWN_REFUSED_CODE)
    expect(error?.message).toContain('3 registry row(s)')
    expect(recorded).toEqual([COUNT])
    expect(recorded.some((text) => text.startsWith('ALTER'))).toBe(false)
  })

  it('M-04 the lists: up() = what the plugin stamps; down() = migration 087\'s CHECK, read from the SQL file', () => {
    expect([...PULL_OUTCOMES].sort()).toEqual([...projectTargetStore.PROJECT_TARGET_PULL_OUTCOMES].sort())
    const sql087 = readFileSync(resolve(__dirname, '../../migrations/087_create_integration_stock_prep_project_target.sql'), 'utf8')
    const match = sql087.match(/last_pull_outcome IN \(([^)]*)\)/)
    expect(match).not.toBeNull()
    const list087 = (match?.[1] ?? '').split(',').map((entry) => entry.trim().replace(/^'|'$/g, ''))
    expect([...PULL_OUTCOMES_087]).toEqual(list087)
    expect(PULL_OUTCOMES.filter((outcome) => !list087.includes(outcome))).toEqual(['failed'])
  })
})
