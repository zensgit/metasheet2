/**
 * include_children migration against a recording Kysely driver. No database is contacted.
 * down() must lock both scope tables before any false-row read, count each present column
 * in its own statement, refuse when either table stores false, and emit no DROP on refusal.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely'
import type { CompiledQuery, DatabaseConnection, Driver, QueryResult } from 'kysely'
import {
  DELEGATED_SCOPE_INCLUDE_CHILDREN_DOWN_REFUSED_CODE,
  down,
  up,
} from '../../src/db/migrations/zzzz20261111181500_add_delegated_role_scope_include_children'

const MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  'src',
  'db',
  'migrations',
  'zzzz20261111181500_add_delegated_role_scope_include_children.ts',
)
const SOURCE = readFileSync(MIGRATION, 'utf8')

const ADMIN = 'delegated_role_admin_scopes'
const TEMPLATE = 'delegated_role_scope_template_departments'

type Recorded = { sql: string; parameters: readonly unknown[] }
type Answers = {
  columns: readonly string[]
  adminFalse: number
  templateFalse: number
}

function recordingDb(answers: Answers) {
  const log: Recorded[] = []
  class RecordingConnection implements DatabaseConnection {
    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const sqlText = compiled.sql.replace(/\s+/g, ' ').trim()
      log.push({ sql: sqlText, parameters: compiled.parameters })
      if (/^LOCK TABLE /.test(sqlText)) return { rows: [] }
      if (/FROM information_schema\.columns/.test(sqlText)) {
        return { rows: answers.columns.map((table_name) => ({ table_name })) as R[] }
      }
      if (/FROM delegated_role_admin_scopes WHERE include_children IS FALSE/.test(sqlText)) {
        if (!answers.columns.includes(ADMIN)) throw new Error('counted include_children on delegated_role_admin_scopes after the catalog said it was absent')
        return { rows: [{ count: answers.adminFalse } as R] }
      }
      if (/FROM delegated_role_scope_template_departments WHERE include_children IS FALSE/.test(sqlText)) {
        if (!answers.columns.includes(TEMPLATE)) throw new Error('counted include_children on delegated_role_scope_template_departments after the catalog said it was absent')
        return { rows: [{ count: answers.templateFalse } as R] }
      }
      if (/^ALTER TABLE /.test(sqlText)) return { rows: [] }
      throw new Error(`unexpected statement: ${sqlText}`)
    }
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
      throw new Error('no stream')
    }
  }
  class RecordingDriver implements Driver {
    async init(): Promise<void> {}
    async acquireConnection(): Promise<DatabaseConnection> {
      return new RecordingConnection()
    }
    async beginTransaction(): Promise<void> {}
    async commitTransaction(): Promise<void> {}
    async rollbackTransaction(): Promise<void> {}
    async releaseConnection(): Promise<void> {}
    async destroy(): Promise<void> {}
  }
  const db = new Kysely<unknown>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new RecordingDriver(),
      createIntrospector: (instance) => new PostgresIntrospector(instance),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  })
  return { db, log }
}

function bothColumns(adminFalse: number, templateFalse: number): Answers {
  return { columns: [ADMIN, TEMPLATE], adminFalse, templateFalse }
}

const LOCK = 'LOCK TABLE delegated_role_admin_scopes, delegated_role_scope_template_departments IN ACCESS EXCLUSIVE MODE'
const CATALOG = "SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'include_children' AND table_name IN ('delegated_role_admin_scopes', 'delegated_role_scope_template_departments')"
const COUNT_ADMIN = 'SELECT count(*)::int AS count FROM delegated_role_admin_scopes WHERE include_children IS FALSE'
const COUNT_TEMPLATE = 'SELECT count(*)::int AS count FROM delegated_role_scope_template_departments WHERE include_children IS FALSE'
const DROP_TEMPLATE = 'ALTER TABLE delegated_role_scope_template_departments DROP COLUMN IF EXISTS include_children'
const DROP_ADMIN = 'ALTER TABLE delegated_role_admin_scopes DROP COLUMN IF EXISTS include_children'

async function refused(answers: Answers): Promise<{ message: string; log: Recorded[] }> {
  const { db, log } = recordingDb(answers)
  const error = (await down(db).catch((caught: unknown) => caught)) as Error & { code?: string }
  expect(error).toBeInstanceOf(Error)
  expect(error.code).toBe(DELEGATED_SCOPE_INCLUDE_CHILDREN_DOWN_REFUSED_CODE)
  return { message: error.message, log }
}

describe('include_children migration', () => {
  it('up() adds the boolean column to both tables and does not read or lock them', async () => {
    const { db, log } = recordingDb(bothColumns(0, 0))
    await up(db)
    expect(log.map((entry) => entry.sql)).toEqual([
      'ALTER TABLE delegated_role_admin_scopes ADD COLUMN IF NOT EXISTS include_children boolean NOT NULL DEFAULT true',
      'ALTER TABLE delegated_role_scope_template_departments ADD COLUMN IF NOT EXISTS include_children boolean NOT NULL DEFAULT true',
    ])
  })

  it('does not hide a missing column behind a CASE in the same statement as the false-row predicate', () => {
    const lockAt = SOURCE.indexOf('LOCK TABLE')
    const predicateAt = SOURCE.indexOf('include_children IS FALSE')
    expect(lockAt).toBeGreaterThan(-1)
    expect(predicateAt).toBeGreaterThan(lockAt)
    expect(SOURCE).not.toMatch(/CASE[\s\S]{0,800}include_children IS FALSE/)
    expect(SOURCE).toContain('IN ACCESS EXCLUSIVE MODE')
  })

  it('locks both tables, then counts, then drops both columns when every present flag is true', async () => {
    const { db, log } = recordingDb(bothColumns(0, 0))
    await down(db)
    expect(log.map((entry) => entry.sql)).toEqual([LOCK, CATALOG, COUNT_ADMIN, COUNT_TEMPLATE, DROP_TEMPLATE, DROP_ADMIN])
  })

  it('refuses when only delegated_role_admin_scopes stores false, and drops nothing', async () => {
    const { message, log } = await refused(bothColumns(1, 0))
    expect(message).toContain('1 scope row(s)')
    expect(message).toContain('Nothing was changed')
    expect(log.map((entry) => entry.sql)).toEqual([LOCK, CATALOG, COUNT_ADMIN, COUNT_TEMPLATE])
  })

  it('refuses when only delegated_role_scope_template_departments stores false, and drops nothing', async () => {
    const { message, log } = await refused(bothColumns(0, 4))
    expect(message).toContain('4 scope row(s)')
    expect(log.map((entry) => entry.sql)).toEqual([LOCK, CATALOG, COUNT_ADMIN, COUNT_TEMPLATE])
  })

  it('refuses with the sum when both tables store false, and drops nothing', async () => {
    const { message, log } = await refused(bothColumns(2, 3))
    expect(message).toContain('5 scope row(s)')
    expect(log.map((entry) => entry.sql)).toEqual([LOCK, CATALOG, COUNT_ADMIN, COUNT_TEMPLATE])
  })

  it('does not count a column the catalog did not return, and still refuses the other table', async () => {
    const { message, log } = await refused({ columns: [TEMPLATE], adminFalse: 0, templateFalse: 1 })
    expect(message).toContain('1 scope row(s)')
    expect(log.map((entry) => entry.sql)).toEqual([LOCK, CATALOG, COUNT_TEMPLATE])
    expect(log.some((entry) => entry.sql.includes(COUNT_ADMIN))).toBe(false)
  })

  it('counts only the admin column when the template column is already absent, and drops both with IF EXISTS when that count is zero', async () => {
    const { db, log } = recordingDb({ columns: [ADMIN], adminFalse: 0, templateFalse: 9 })
    await down(db)
    expect(log.map((entry) => entry.sql)).toEqual([LOCK, CATALOG, COUNT_ADMIN, DROP_TEMPLATE, DROP_ADMIN])
  })

  it('locks, reads the catalog, and drops with IF EXISTS when neither column is present', async () => {
    const { db, log } = recordingDb({ columns: [], adminFalse: 1, templateFalse: 1 })
    await down(db)
    expect(log.map((entry) => entry.sql)).toEqual([LOCK, CATALOG, DROP_TEMPLATE, DROP_ADMIN])
    expect(log.some((entry) => /include_children IS FALSE/.test(entry.sql))).toBe(false)
  })
})
