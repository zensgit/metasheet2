/**
 * The user notification endpoints and preferences migration executed against a recording Kysely driver:
 * the order of its statements (timeouts read, set, work, restored with the values read), the
 * prerequisite check, the guarded down(), and the source rules that do not depend on a live
 * database. Constraint and index definitions are pinned by the catalog snapshot in the real-database
 * suite, not here.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely'
import type { CompiledQuery, DatabaseConnection, Driver, QueryResult } from 'kysely'
import {
  USER_NOTIFICATION_DOWN_BLOCKED_CODE,
  USER_NOTIFICATION_PREREQUISITE_CODE,
  down,
  up,
} from '../../src/db/migrations/zzzz20261111093417_create_user_notification_endpoints_preferences'

const SOURCE = readFileSync(
  path.resolve(__dirname, '..', '..', 'src', 'db', 'migrations', 'zzzz20261111093417_create_user_notification_endpoints_preferences.ts'),
  'utf8',
)

type Recorded = { sql: string; parameters: readonly unknown[] }
type Answers = {
  lockTimeout: string
  statementTimeout: string
  prerequisites?: { present: boolean; by_provider: boolean; by_org: boolean }
  tablesExist?: boolean
  endpointRows?: boolean
  preferenceRows?: boolean
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
      if (/AS endpoints,/.test(compiled.sql)) {
        const exist = answers.tablesExist ?? true
        return { rows: [{ endpoints: exist, preferences: exist } as R] }
      }
      if (/EXISTS \(SELECT 1 FROM user_notification_endpoints\)/.test(compiled.sql)) return { rows: [{ present: answers.endpointRows ?? false } as R] }
      if (/EXISTS \(SELECT 1 FROM user_notification_preferences\)/.test(compiled.sql)) return { rows: [{ present: answers.preferenceRows ?? false } as R] }
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

const head = (entry: Recorded): string => entry.sql.replace(/\s*\(.*$/s, '').split(' ').slice(0, 4).join(' ').replace(/ ON$/, '')

describe('up()', () => {
  it('reads the timeouts, sets its own, checks the prerequisites, creates the tables and indexes, and restores what it read', async () => {
    const { db, log } = recordingDb({ lockTimeout: '7s', statementTimeout: '42s' })
    await up(db)
    expect(log.map(head)).toEqual([
      'SELECT current_setting',
      'SELECT set_config',
      'SELECT to_regclass',
      'CREATE TABLE user_notification_endpoints',
      'CREATE UNIQUE INDEX une_proof_uniq',
      'CREATE UNIQUE INDEX une_tenant_address_active_uniq',
      'CREATE INDEX une_user_idx',
      'CREATE TABLE user_notification_preferences',
      'CREATE INDEX unp_primary_idx',
      'CREATE INDEX unp_fallback_idx',
      'SELECT set_config',
    ])
    expect(log[1].parameters).toEqual(['5s', '5min'])
    expect(log[log.length - 1].parameters).toEqual(['7s', '42s'])
  })

  it('restores the values it read, whatever they are, and never a fixed value', async () => {
    for (const [lock, statement] of [['0', '0'], ['13s', '2min'], ['1ms', '90s']]) {
      const { db, log } = recordingDb({ lockTimeout: lock, statementTimeout: statement })
      await up(db)
      expect(log[log.length - 1].parameters).toEqual([lock, statement])
    }
  })

  it('refuses before any CREATE when the parent table or either unique constraint is missing, with a values-free message', async () => {
    for (const prerequisites of [
      { present: false, by_provider: false, by_org: false },
      { present: true, by_provider: false, by_org: true },
      { present: true, by_provider: true, by_org: false },
    ]) {
      const { db, log } = recordingDb({ lockTimeout: '0', statementTimeout: '0', prerequisites })
      const error = (await up(db).catch((e: Error) => e)) as Error & { code?: string }
      expect(error.code).toBe(USER_NOTIFICATION_PREREQUISITE_CODE)
      expect(error.message).not.toMatch(/\d/)
      expect(log.some((entry) => /CREATE/i.test(entry.sql))).toBe(false)
    }
  })

  it('has no IF NOT EXISTS, no CONCURRENTLY, no COLLATE, and reads no regular expression bound above 255', () => {
    expect(SOURCE).not.toContain('IF NOT EXISTS')
    expect(SOURCE).not.toMatch(/CONCURRENTLY|COLLATE/i)
    const bounds = [...SOURCE.matchAll(/\{(\d+)(?:,(\d*))?\}/g)]
    expect(bounds.length).toBeGreaterThan(0)
    for (const bound of bounds) {
      expect(Number(bound[1])).toBeLessThanOrEqual(255)
      if (bound[2]) expect(Number(bound[2])).toBeLessThanOrEqual(255)
    }
  })

  it('references no table of users or organizations, and keeps proof_id free of a foreign key', () => {
    expect(SOURCE).not.toMatch(/REFERENCES\s+(users|user_orgs)\b/)
    expect(SOURCE).not.toMatch(/proof_id[^,]*REFERENCES/)
    expect(SOURCE).not.toMatch(/ON DELETE CASCADE/i)
  })

  it('takes its timeout helpers from the shared module and defines none of its own', () => {
    expect(SOURCE).toContain("from '../migration-timeouts'")
    expect(SOURCE).not.toMatch(/set_config|current_setting/)
  })
})

describe('down()', () => {
  it('refuses while either table holds a row, with a values-free message and no DROP', async () => {
    for (const rows of [{ endpointRows: true }, { preferenceRows: true }, { endpointRows: true, preferenceRows: true }]) {
      const { db, log } = recordingDb({ lockTimeout: '0', statementTimeout: '0', ...rows })
      const error = (await down(db).catch((e: Error) => e)) as Error & { code?: string }
      expect(error.code).toBe(USER_NOTIFICATION_DOWN_BLOCKED_CODE)
      expect(error.message).not.toMatch(/\d/)
      expect(log.some((entry) => /DROP/i.test(entry.sql))).toBe(false)
    }
  })

  it('checks that a table exists in one statement and its rows in another', async () => {
    const { db, log } = recordingDb({ lockTimeout: '0', statementTimeout: '0' })
    await down(db)
    expect(log.slice(0, 5).map(head)).toEqual(['SELECT current_setting', 'SELECT set_config', 'SELECT to_regclass', 'SELECT EXISTS', 'SELECT EXISTS'])
    for (const entry of log.filter((item) => /EXISTS \(SELECT 1 FROM/.test(item.sql))) expect(entry.sql).not.toMatch(/to_regclass/)
  })

  it('drops preferences before endpoints and restores the timeouts it read', async () => {
    const { db, log } = recordingDb({ lockTimeout: '3s', statementTimeout: '9s' })
    await down(db)
    expect(log.slice(5).map((entry) => (entry.sql.startsWith('SELECT') ? 'SELECT set_config' : entry.sql))).toEqual([
      'DROP TABLE IF EXISTS user_notification_preferences',
      'DROP TABLE IF EXISTS user_notification_endpoints',
      'SELECT set_config',
    ])
    expect(log[log.length - 1].parameters).toEqual(['3s', '9s'])
  })

  it('never reads a table that does not exist', async () => {
    const { db, log } = recordingDb({ lockTimeout: '0', statementTimeout: '0', tablesExist: false, endpointRows: true, preferenceRows: true })
    await down(db)
    expect(log.some((entry) => /EXISTS \(SELECT 1 FROM/.test(entry.sql))).toBe(false)
  })
})
