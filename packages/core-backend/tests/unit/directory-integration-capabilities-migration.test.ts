/**
 * The directory_integration_capabilities migration executed against a recording Kysely driver: the
 * statement sequence of up() and down(), the prerequisite check, the guarded down(), and the table
 * shape that the registry constants and the evaluator rely on. No database is contacted.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely'
import type { CompiledQuery, DatabaseConnection, Driver, QueryResult } from 'kysely'
import { INTEGRATION_CAPABILITIES } from '../../src/integrations/provider-capability-registry'
import {
  DIRECTORY_INTEGRATION_CAPABILITIES_DOWN_BLOCKED_CODE,
  DIRECTORY_INTEGRATION_CAPABILITIES_PREREQUISITE_CODE,
  down,
  up,
} from '../../src/db/migrations/zzzz20261106130000_create_directory_integration_capabilities'

const MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  'src',
  'db',
  'migrations',
  'zzzz20261106130000_create_directory_integration_capabilities.ts',
)
const SOURCE = readFileSync(MIGRATION, 'utf8')

type Recorded = { sql: string; parameters: readonly unknown[] }
type Answers = {
  lockTimeout: string
  statementTimeout: string
  prerequisites?: { present: boolean; by_provider: boolean; by_org: boolean }
  capabilitiesExist?: boolean
  historyExist?: boolean
  capabilitiesHaveRows?: boolean
  historyHaveRows?: boolean
}

function recordingDb(answers: Answers) {
  const log: Recorded[] = []
  const prerequisites = answers.prerequisites ?? { present: true, by_provider: true, by_org: true }
  class RecordingConnection implements DatabaseConnection {
    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      log.push({ sql: compiled.sql.replace(/\s+/g, ' ').trim(), parameters: compiled.parameters })
      if (/current_setting\('lock_timeout'\)/.test(compiled.sql)) {
        return { rows: [{ lock_timeout: answers.lockTimeout, statement_timeout: answers.statementTimeout } as R] }
      }
      if (/AS by_provider/.test(compiled.sql)) return { rows: [prerequisites as R] }
      if (/AS capabilities,/.test(compiled.sql)) {
        return { rows: [{ capabilities: answers.capabilitiesExist ?? true, history: answers.historyExist ?? true } as R] }
      }
      if (/EXISTS \(SELECT 1 FROM directory_integration_capabilities\)/.test(compiled.sql)) {
        return { rows: [{ present: answers.capabilitiesHaveRows ?? false } as R] }
      }
      if (/EXISTS \(SELECT 1 FROM directory_integration_capability_history\)/.test(compiled.sql)) {
        return { rows: [{ present: answers.historyHaveRows ?? false } as R] }
      }
      return { rows: [] }
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

function heads(log: Recorded[]): string[] {
  return log.map((entry) => entry.sql.replace(/\s*\(.*$/s, '').split(' ').slice(0, 4).join(' ').replace(/ (?:ON|BEFORE|LANGUAGE)$/, ''))
}

describe('up()', () => {
  it('reads the timeouts, bounds them, checks the prerequisites, creates both tables, the index, the guards and the triggers, then restores the timeouts', async () => {
    const { db, log } = recordingDb({ lockTimeout: '7s', statementTimeout: '42s' })
    await up(db)
    expect(heads(log)).toEqual([
      'SELECT current_setting',
      'SELECT set_config',
      'SELECT to_regclass',
      'CREATE TABLE directory_integration_capabilities',
      'CREATE UNIQUE INDEX dic_login_scope_uniq',
      'CREATE FUNCTION dic_guard_update',
      'CREATE TRIGGER dic_guard_update_trg',
      'CREATE TABLE directory_integration_capability_history',
      'CREATE INDEX dich_integration_idx',
      'CREATE FUNCTION dich_guard_append_only',
      'CREATE TRIGGER dich_append_only_trg',
      'SELECT set_config',
    ])
    expect(log[1].parameters).toEqual(['5s', '5min'])
    expect(log[11].parameters).toEqual(['7s', '42s'])
  })

  it('refuses before any CREATE when the parent table or either unique constraint is missing, with a values-free message', async () => {
    for (const prerequisites of [
      { present: false, by_provider: false, by_org: false },
      { present: true, by_provider: false, by_org: true },
      { present: true, by_provider: true, by_org: false },
    ]) {
      const { db, log } = recordingDb({ lockTimeout: '0', statementTimeout: '0', prerequisites })
      const error = await up(db).catch((e: Error) => e)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error & { code?: string }).code).toBe(DIRECTORY_INTEGRATION_CAPABILITIES_PREREQUISITE_CODE)
      expect((error as Error).message).not.toMatch(/\d/)
      expect(log.some((entry) => /CREATE/i.test(entry.sql))).toBe(false)
    }
  })

  it('creates both tables without IF NOT EXISTS and without CONCURRENTLY, and imports kysely only', () => {
    expect(SOURCE).not.toContain('IF NOT EXISTS')
    expect(SOURCE).not.toMatch(/CONCURRENTLY/i)
    const source = ts.createSourceFile('m.ts', SOURCE, ts.ScriptTarget.Latest, true)
    const specifiers = source.statements.flatMap((statement) =>
      ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) ? [statement.moduleSpecifier.text] : [])
    expect(specifiers).toEqual(['kysely'])
    expect(SOURCE).not.toMatch(/\brequire\s*\(/)
  })

  it('declares the two composite foreign keys on the parent unique keys, restricting delete and update', () => {
    expect(SOURCE).toContain('CONSTRAINT dic_integration_provider_fk FOREIGN KEY (integration_id, bound_provider)')
    expect(SOURCE).toContain('REFERENCES directory_integrations (id, provider) ON DELETE RESTRICT ON UPDATE RESTRICT')
    expect(SOURCE).toContain('CONSTRAINT dic_integration_org_fk FOREIGN KEY (integration_id, bound_org_id)')
    expect(SOURCE).toContain('REFERENCES directory_integrations (id, org_id) ON DELETE RESTRICT ON UPDATE RESTRICT')
    expect(SOURCE).not.toMatch(/ON DELETE CASCADE/i)
  })

  it('builds the login unique index on the provider and the case-folded login scope, for enabled rows only', () => {
    expect(SOURCE).toContain(
      'ON directory_integration_capabilities (bound_provider, lower(login_bound_tenant), lower(login_bound_app_scope))',
    )
    expect(SOURCE).toMatch(/dic_login_scope_uniq[\s\S]*?WHERE login_enabled\s*`/)
  })

  it('requires the anchor to be present while a capability is on and absent while it is off, with an explicit NOT NULL test', () => {
    for (const capability of INTEGRATION_CAPABILITIES) {
      const check = new RegExp(
        `CONSTRAINT dic_${capability}_anchor_chk CHECK \\(CASE WHEN ${capability}_enabled THEN\\s+` +
          `\\(${capability}_bound_tenant IS NOT NULL AND ${capability}_bound_tenant ~ '\\^\\[!-~\\]\\+\\$'\\s+` +
          `AND ${capability}_bound_app_scope IS NOT NULL AND ${capability}_bound_app_scope ~ '\\^\\[!-~\\]\\+\\$'\\s+` +
          `AND char_length\\(${capability}_bound_app_scope\\) <= 256\\)\\s+` +
          `ELSE \\(${capability}_bound_tenant IS NULL AND ${capability}_bound_app_scope IS NULL\\) END\\)`,
      )
      expect(SOURCE, capability).toMatch(check)
    }
    expect(SOURCE.match(/IS NOT NULL AND \w+_bound_(?:tenant|app_scope) ~/g)).toHaveLength(6)
  })

  it('uses only regular expression bounds that PostgreSQL accepts (at most 255)', () => {
    const patterns = [...SOURCE.matchAll(/~ '([^']*)'/g)].map((match) => match[1])
    expect(patterns.length).toBeGreaterThanOrEqual(7)
    for (const pattern of patterns) {
      for (const bound of pattern.matchAll(/\{(\d+)(?:,(\d*))?\}/g)) {
        expect(Number(bound[1]), pattern).toBeLessThanOrEqual(255)
        if (bound[2]) expect(Number(bound[2]), pattern).toBeLessThanOrEqual(255)
      }
    }
  })

  it('guards updates: revision advances by exactly one and the identity, binding and creation columns never change', () => {
    expect(SOURCE).toContain('IF NEW.revision IS DISTINCT FROM OLD.revision + 1 THEN')
    for (const column of ['integration_id', 'bound_provider', 'bound_org_id', 'created_by', 'created_at']) {
      expect(SOURCE).toContain(`NEW.${column} IS DISTINCT FROM OLD.${column}`)
    }
    expect(SOURCE).toContain('BEFORE UPDATE ON directory_integration_capabilities')
    expect(SOURCE.match(/SET search_path = pg_catalog/g)).toHaveLength(2)
  })

  it('keeps the history append-only for update and delete, and admits only the three capability names', () => {
    expect(SOURCE).toContain('BEFORE UPDATE OR DELETE ON directory_integration_capability_history')
    expect(SOURCE).toContain("changed <@ ARRAY['directory', 'login', 'notification']::text[]")
    expect(SOURCE).toContain("anchor_rebound <@ ARRAY['directory', 'login', 'notification']::text[]")
    expect(SOURCE).toContain('cardinality(changed) >= 1')
    expect(INTEGRATION_CAPABILITIES).toEqual(['directory', 'login', 'notification'])
    const history = SOURCE.slice(SOURCE.indexOf('CREATE TABLE directory_integration_capability_history'))
    expect(history.slice(0, history.indexOf('`.execute(db)'))).not.toMatch(/REFERENCES/)
  })
})

describe('down()', () => {
  it('refuses while either table holds a row, with a values-free message and no DROP', async () => {
    for (const rows of [{ capabilitiesHaveRows: true }, { historyHaveRows: true }, { capabilitiesHaveRows: true, historyHaveRows: true }]) {
      const { db, log } = recordingDb({ lockTimeout: '0', statementTimeout: '0', ...rows })
      const error = await down(db).catch((e: Error) => e)
      expect((error as Error & { code?: string }).code).toBe(DIRECTORY_INTEGRATION_CAPABILITIES_DOWN_BLOCKED_CODE)
      expect((error as Error).message).toMatch(/^DIRECTORY_INTEGRATION_CAPABILITIES_DOWN_BLOCKED: down\(\) refused while the directory integration capability tables hold rows/)
      expect((error as Error).message).not.toMatch(/\d/)
      expect(log.some((entry) => /DROP/i.test(entry.sql))).toBe(false)
    }
  })

  it('checks that a table exists in one statement and its rows in another, never both in one', async () => {
    const { db, log } = recordingDb({ lockTimeout: '0', statementTimeout: '0' })
    await down(db)
    const existence = log.find((entry) => /to_regclass/.test(entry.sql))!
    expect(existence.sql).not.toMatch(/EXISTS \(SELECT 1 FROM/)
    for (const entry of log.filter((item) => /EXISTS \(SELECT 1 FROM/.test(item.sql))) {
      expect(entry.sql).not.toMatch(/to_regclass/)
    }
    expect(heads(log).slice(0, 5)).toEqual(['SELECT current_setting', 'SELECT set_config', 'SELECT to_regclass', 'SELECT EXISTS', 'SELECT EXISTS'])
  })

  it('drops the history table, the capability table and both functions, then restores the timeouts', async () => {
    const empty = recordingDb({ lockTimeout: '3s', statementTimeout: '9s' })
    await down(empty.db)
    expect(empty.log.slice(5).map((entry) => (entry.sql.startsWith('SELECT') ? 'SELECT set_config' : entry.sql))).toEqual([
      'DROP TABLE IF EXISTS directory_integration_capability_history',
      'DROP TABLE IF EXISTS directory_integration_capabilities',
      'DROP FUNCTION IF EXISTS dich_guard_append_only()',
      'DROP FUNCTION IF EXISTS dic_guard_update()',
      'SELECT set_config',
    ])
    expect(empty.log[empty.log.length - 1].parameters).toEqual(['3s', '9s'])
  })

  it('is a no-op that never reads a missing table', async () => {
    const absent = recordingDb({ lockTimeout: '0', statementTimeout: '0', capabilitiesExist: false, historyExist: false, capabilitiesHaveRows: true, historyHaveRows: true })
    await down(absent.db)
    expect(absent.log.some((entry) => /EXISTS \(SELECT 1 FROM/.test(entry.sql))).toBe(false)
    expect(heads(absent.log).filter((head) => head.startsWith('DROP'))).toHaveLength(4)
  })
})
