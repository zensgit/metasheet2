import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely'
import type { CompiledQuery, DatabaseConnection, Driver, QueryResult } from 'kysely'
import {
  NOTIFICATION_SEND_DOWN_BLOCKED_CODE,
  NOTIFICATION_SEND_PREREQUISITE_CODE,
  down,
  up,
} from '../../src/db/migrations/zzzz20261121130000_create_notification_verifications_test_sends'

import { CAPABILITY_WITNESS_SHAPE } from '../../src/integrations/integration-capability-resolve'

const SOURCE = readFileSync(
  path.resolve(__dirname, '..', '..', 'src', 'db', 'migrations', 'zzzz20261121130000_create_notification_verifications_test_sends.ts'),
  'utf8',
)

type Recorded = { sql: string; parameters: readonly unknown[] }
type Answers = {
  lockTimeout: string
  statementTimeout: string
  prerequisites?: { endpoints: boolean; preferences: boolean }
  tablesExist?: boolean
  evidenceRows?: boolean
  sendRows?: boolean
}

function recordingDb(answers: Answers) {
  const log: Recorded[] = []
  const prerequisites = answers.prerequisites ?? { endpoints: true, preferences: true }
  class RecordingConnection implements DatabaseConnection {
    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      log.push({ sql: compiled.sql.replace(/\s+/g, ' ').trim(), parameters: compiled.parameters })
      if (/current_setting\('lock_timeout'\)/.test(compiled.sql)) {
        return { rows: [{ lock_timeout: answers.lockTimeout, statement_timeout: answers.statementTimeout } as R] }
      }
      if (/AS endpoints,/.test(compiled.sql)) return { rows: [prerequisites as R] }
      if (/AS evidence,/.test(compiled.sql)) {
        const exist = answers.tablesExist ?? true
        return { rows: [{ evidence: exist, sends: exist } as R] }
      }
      if (/EXISTS \(SELECT 1 FROM notification_connection_verifications\)/.test(compiled.sql)) return { rows: [{ present: answers.evidenceRows ?? false } as R] }
      if (/EXISTS \(SELECT 1 FROM notification_test_sends\)/.test(compiled.sql)) return { rows: [{ present: answers.sendRows ?? false } as R] }
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
      'CREATE TABLE notification_connection_verifications',
      'CREATE TABLE notification_test_sends',
      'CREATE UNIQUE INDEX nts_key_uniq',
      'CREATE INDEX nts_user_time_idx',
      'CREATE INDEX nts_conn_time_idx',
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

  it('refuses before any CREATE when the endpoint or preference table is missing, with a values-free message', async () => {
    for (const prerequisites of [
      { endpoints: false, preferences: false },
      { endpoints: false, preferences: true },
      { endpoints: true, preferences: false },
    ]) {
      const { db, log } = recordingDb({ lockTimeout: '0', statementTimeout: '0', prerequisites })
      const error = (await up(db).catch((e: Error) => e)) as Error & { code?: string }
      expect(error.code).toBe(NOTIFICATION_SEND_PREREQUISITE_CODE)
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

  it('references no table of users or organizations and keeps foreign keys restrictive', () => {
    expect(SOURCE).not.toMatch(/REFERENCES\s+(users|user_orgs)\b/)
    expect(SOURCE).not.toMatch(/ON DELETE CASCADE/i)
  })

  it('takes its timeout helpers from the shared module and defines none of its own', () => {
    expect(SOURCE).toContain("from '../migration-timeouts'")
    expect(SOURCE).not.toMatch(/set_config|current_setting/)
  })
})

describe('table contract', () => {
  it('aligns the fingerprint CHECK with the exported capability witness shape', async () => {
    const { db, log } = recordingDb({ lockTimeout: '0', statementTimeout: '0' })
    await up(db)
    expect(log.find((entry) => entry.sql.startsWith('CREATE TABLE notification_connection_verifications'))?.sql)
      .toContain("CONSTRAINT ncv_fp_chk CHECK (tuple_fingerprint ~ '" + CAPABILITY_WITNESS_SHAPE + "')")
  })

  it('pins the closed states, levels and sending/terminal requirements', async () => {
    const { db, log } = recordingDb({ lockTimeout: '0', statementTimeout: '0' })
    await up(db)
    const statements = log.map((entry) => entry.sql).join('\n')
    expect(statements).toContain("CHECK (reached_level IN ('token', 'send'))")
    expect(statements).toContain("CHECK (state IN ('pending', 'sending', 'accepted', 'failed', 'outcome_unknown', 'refused'))")
    expect(statements).toContain("CHECK (state <> 'sending' OR sending_at IS NOT NULL)")
    expect(statements).toContain("CHECK (state IN ('pending', 'sending') OR outcome_code IS NOT NULL)")
    expect(statements).toContain('FOREIGN KEY (endpoint_id, connection_id) REFERENCES user_notification_endpoints (id, connection_id)')
  })
})

describe('down()', () => {
  it('refuses while either table holds a row, with a values-free message and no DROP', async () => {
    for (const rows of [{ evidenceRows: true }, { sendRows: true }, { evidenceRows: true, sendRows: true }]) {
      const { db, log } = recordingDb({ lockTimeout: '0', statementTimeout: '0', ...rows })
      const error = (await down(db).catch((e: Error) => e)) as Error & { code?: string }
      expect(error.code).toBe(NOTIFICATION_SEND_DOWN_BLOCKED_CODE)
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

  it('drops the ledger before evidence and restores the timeouts it read', async () => {
    const { db, log } = recordingDb({ lockTimeout: '3s', statementTimeout: '9s' })
    await down(db)
    expect(log.slice(5).map((entry) => (entry.sql.startsWith('SELECT') ? 'SELECT set_config' : entry.sql))).toEqual([
      'DROP TABLE IF EXISTS notification_test_sends',
      'DROP TABLE IF EXISTS notification_connection_verifications',
      'SELECT set_config',
    ])
    expect(log[log.length - 1].parameters).toEqual(['3s', '9s'])
  })

  it('never reads a table that does not exist', async () => {
    const { db, log } = recordingDb({ lockTimeout: '0', statementTimeout: '0', tablesExist: false, evidenceRows: true, sendRows: true })
    await down(db)
    expect(log.some((entry) => /EXISTS \(SELECT 1 FROM/.test(entry.sql))).toBe(false)
  })
})
