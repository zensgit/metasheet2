import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely'
import type { CompiledQuery, DatabaseConnection, Driver, QueryResult } from 'kysely'
import * as policy from '../../src/db/migrations/zzzz20261122151000_create_notification_topic_policies'
import * as decision from '../../src/db/migrations/zzzz20261122151100_create_task_notification_decisions'
import { CAPABILITY_WITNESS_SHAPE } from '../../src/integrations/integration-capability-witness'
type Recorded = { sql: string; parameters: readonly unknown[] }
type Answers = {
  lockTimeout: string
  statementTimeout: string
  prerequisites?: boolean
  evidenceRows?: boolean
}

function recordingDb(answers: Answers) {
  const log: Recorded[] = []
  const prerequisites = answers.prerequisites ?? true
  class RecordingConnection implements DatabaseConnection {
    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      log.push({ sql: compiled.sql.replace(/\s+/g, ' ').trim(), parameters: compiled.parameters })
      if (/current_setting\('lock_timeout'\)/.test(compiled.sql)) {
        return { rows: [{ lock_timeout: answers.lockTimeout, statement_timeout: answers.statementTimeout } as R] }
      }
      if (compiled.sql.includes('to_regclass')) return { rows: [{ present: prerequisites } as R] }
      if (compiled.sql.includes('SELECT EXISTS')) return { rows: [{ present: answers.evidenceRows ?? false } as R] }
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


describe.each([['policy', policy], ['decision', decision]] as const)('%s migration', (_name, migration) => {
  it.each(['up', 'down'] as const)('%s restores the actual previous timeout settings', async direction => {
    const { db, log } = recordingDb({ lockTimeout: '7s', statementTimeout: '42s' })
    await migration[direction](db)
    expect(log[0].sql).toContain("current_setting('lock_timeout')")
    expect(log[1].parameters).toEqual(['5s', '5min'])
    expect(log.at(-1)?.parameters).toEqual(['7s', '42s'])
    expect(log.at(-1)?.sql).toContain("set_config('statement_timeout'")
    expect(log.map(row => row.sql).join(' ')).not.toMatch(/ALTER TABLE|CREATE FUNCTION|CREATE OR REPLACE FUNCTION/)
    if (direction === 'down') expect(log.at(-2)?.sql).toBe(`DROP TABLE IF EXISTS ${_name === 'policy' ? 'org_notification_topic_policies' : 'task_notification_delivery_decisions'}`)
    await db.destroy()
  })
  it('rejects absent prerequisites before DDL', async () => {
    const { db, log } = recordingDb({ lockTimeout: '7s', statementTimeout: '42s', prerequisites: false })
    await expect(migration.up(db)).rejects.toThrow('NOTIFICATION_ROUTING_PREREQUISITE_MISSING')
    expect(log.some(row => row.sql.includes('CREATE'))).toBe(false)
    await db.destroy()
  })
  it('refuses to destroy a table containing rows', async () => {
    const { db, log } = recordingDb({ lockTimeout: '7s', statementTimeout: '42s', evidenceRows: true })
    await expect(migration.down(db)).rejects.toThrow('NOTIFICATION_ROUTING_DOWN_BLOCKED')
    expect(log.some(row => row.sql.includes('DROP'))).toBe(false)
    const table = _name === 'policy' ? 'org_notification_topic_policies' : 'task_notification_delivery_decisions'
    const lock = log.findIndex(row => row.sql === `LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`)
    expect(lock).toBeGreaterThan(-1)
    expect(lock).toBeLessThan(log.findIndex(row => row.sql.includes('SELECT EXISTS')))
    await db.destroy()
  })
})
it('pins the historical witness CHECK independently and does not import the live constant into the migration', () => {
  const source = readFileSync(path.resolve(__dirname, '../../src/db/migrations/zzzz20261122151100_create_task_notification_decisions.ts'), 'utf8')
  expect(CAPABILITY_WITNESS_SHAPE).toBe('^[0-9a-f]{64}$')
  expect(source).toContain(`capability_witness ~ '${CAPABILITY_WITNESS_SHAPE}'`)
  expect(source).not.toContain('integration-capability-witness')
  expect(source).toContain('ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED')
  expect(source).toContain('ON task_notification_delivery_decisions (org_id, recipient_user_id, event_key, rank)')
  expect(source).toContain("reason IS NOT NULL AND connection_id IS NULL")
})

it('checks the parent composite UNIQUE constraint before creating the policy table', async () => {
  const { db, log } = recordingDb({ lockTimeout: '7s', statementTimeout: '42s' })
  try {
    await policy.up(db)
    const prerequisite = log.findIndex(row => row.sql.includes("AS present"))
    expect(prerequisite).toBeGreaterThan(-1)
    expect(log[prerequisite].sql).toContain("conrelid = to_regclass('directory_integrations')")
    expect(log[prerequisite].sql).toContain("conname = 'uq_directory_integrations_id_org' AND contype = 'u'")
    expect(prerequisite).toBeLessThan(log.findIndex(row => row.sql.startsWith('CREATE TABLE')))
  } finally { await db.destroy() }
})
