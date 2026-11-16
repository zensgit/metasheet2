/**
 * YiDa 发料确认日期回写 core (slice Y9a): migration `zzzz20261106093100_create_integration_yida_issue_confirm_writeback`
 * against a FAKE database (no PostgreSQL), plus the host-equivalence pin of the plugin's business-day zone.
 *
 *   M-01 up() issues exactly the exported UP statement, unparameterized, and a second up() issues the same one
 *        (replayable by construction: IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS first).
 *   M-02 the table shape the write-back relies on: PRIMARY KEY (ledger_id) referencing the delivery ledger, the
 *        date shape CHECK, the append-only triggers (UPDATE / DELETE / TRUNCATE refused, created_at stamped).
 *   M-03 THE LIST: the outcome CHECK is exactly the plugin module's ISSUE_CONFIRM_WRITEBACK_OUTCOMES (and the dated
 *        outcomes match), so the module can never record an outcome the table refuses, or the reverse.
 *   M-04 down() issues exactly the exported DOWN statement; that statement refuses with the fixed code while any row
 *        exists, BEFORE any DROP.
 *   TZ   the plugin's resolveIssueConfirmBusinessTimeZone equals the host's resolveMultitableBusinessTimezone on a
 *        matrix of values (the plugin cannot import the host module, so it keeps a mirror).
 *
 * The real-PG cases (up, replay, down refusal, down with no row, the triggers) are slice Y9.
 */
import { createRequire } from 'node:module'

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
  YIDA_ISSUE_CONFIRM_WRITEBACK_DATED_OUTCOMES,
  YIDA_ISSUE_CONFIRM_WRITEBACK_DOWN_REFUSED_CODE,
  YIDA_ISSUE_CONFIRM_WRITEBACK_DOWN_SQL,
  YIDA_ISSUE_CONFIRM_WRITEBACK_OUTCOMES,
  YIDA_ISSUE_CONFIRM_WRITEBACK_TABLE,
  YIDA_ISSUE_CONFIRM_WRITEBACK_UP_SQL,
  down,
  up,
} from '../../src/db/migrations/zzzz20261106093100_create_integration_yida_issue_confirm_writeback'
import { resolveMultitableBusinessTimezone } from '../../src/multitable/business-timezone'

const require_ = createRequire(__filename)
const plugin = require_('../../../../plugins/plugin-integration-core/lib/yida-issue-confirm-writeback.cjs') as {
  ISSUE_CONFIRM_WRITEBACK_OUTCOMES: readonly string[]
  ISSUE_CONFIRM_DATED_OUTCOMES: readonly string[]
  ISSUE_CONFIRM_TRACE_TABLE: string
  resolveIssueConfirmBusinessTimeZone: (env: Record<string, string | undefined>) => string
}

const norm = (text: string) => text.replace(/\s+/g, ' ').trim()

function createFakeDb(recorded: CompiledQuery[]): Kysely<unknown> {
  const connection: DatabaseConnection = {
    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      recorded.push(compiled)
      return { rows: [] }
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

function outcomeCheckList(sqlText: string): string[] {
  const match = /CONSTRAINT integration_yida_issue_confirm_writeback_outcome_check CHECK \(outcome IN \(([^)]*)\)\)/.exec(norm(sqlText))
  expect(match).not.toBeNull()
  return match![1].split(',').map(value => value.trim().replace(/^'|'$/g, ''))
}

describe('migration zzzz20261106093100 — YiDa issue-confirm write-back trace', () => {
  it('M-01 up() issues exactly the exported statement, unparameterized, and is replay-safe', async () => {
    const recorded: CompiledQuery[] = []
    const db = createFakeDb(recorded)
    await up(db)
    await up(db)
    expect(recorded.map(query => query.sql)).toEqual([YIDA_ISSUE_CONFIRM_WRITEBACK_UP_SQL, YIDA_ISSUE_CONFIRM_WRITEBACK_UP_SQL])
    expect(recorded.every(query => query.parameters.length === 0)).toBe(true)
    const text = norm(YIDA_ISSUE_CONFIRM_WRITEBACK_UP_SQL)
    expect(text).toContain('CREATE TABLE IF NOT EXISTS integration_yida_issue_confirm_writeback (')
    expect(text).toContain('CREATE INDEX IF NOT EXISTS idx_integration_yida_issue_confirm_writeback_owner ON integration_yida_issue_confirm_writeback (tenant_id, owner_id, created_at)')
    for (const statement of text.split(';').map(part => part.trim()).filter(part => /^CREATE TRIGGER /.test(part))) {
      const name = /^CREATE TRIGGER (\S+)/.exec(statement)![1]
      expect(text).toContain(`DROP TRIGGER IF EXISTS ${name} ON integration_yida_issue_confirm_writeback`)
    }
    expect(text.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(2)
    expect(text).not.toMatch(/CREATE FUNCTION /)
  })

  it('M-02 one row per ledger row, the date shape, and append-only', () => {
    expect(YIDA_ISSUE_CONFIRM_WRITEBACK_TABLE).toBe(plugin.ISSUE_CONFIRM_TRACE_TABLE)
    const text = norm(YIDA_ISSUE_CONFIRM_WRITEBACK_UP_SQL)
    expect(text).toContain('ledger_id TEXT PRIMARY KEY REFERENCES integration_yida_delivery_ledger(id) ON DELETE RESTRICT')
    expect(text.match(/PRIMARY KEY/g)).toHaveLength(1)
    expect(text).toContain("(outcome IN ('written', 'already_set')) = (written_date IS NOT NULL) AND (written_date IS NULL) = (time_zone IS NULL)")
    expect(text).toContain('sheet_id TEXT CHECK (sheet_id IS NULL OR length(sheet_id) BETWEEN 1 AND 128)')
    expect(text).toContain('BEFORE INSERT OR UPDATE OR DELETE ON integration_yida_issue_confirm_writeback FOR EACH ROW EXECUTE FUNCTION integration_yida_issue_confirm_writeback_guard()')
    expect(text).toContain('BEFORE TRUNCATE ON integration_yida_issue_confirm_writeback FOR EACH STATEMENT EXECUTE FUNCTION integration_yida_issue_confirm_writeback_truncate_guard()')
    // The row guard lets INSERT through (stamping created_at) and raises on everything else.
    expect(text).toMatch(/IF TG_OP = 'INSERT' THEN NEW\.created_at := NOW\(\); RETURN NEW; END IF; RAISE EXCEPTION 'YIDA_ISSUE_CONFIRM_WRITEBACK_IMMUTABLE'/)
    // Values-free: exactly these columns, none holding a business value.
    const body = /CREATE TABLE IF NOT EXISTS integration_yida_issue_confirm_writeback \((.*?)\); CREATE INDEX/.exec(text)![1]
    const columns = body.split(/,\s(?![^()]*\))/).map(part => part.trim().split(' ')[0]).filter(name => name !== 'CONSTRAINT')
    expect(columns).toEqual(['ledger_id', 'tenant_id', 'owner_id', 'target_ref', 'sheet_id', 'outcome', 'written_date', 'time_zone', 'created_at'])
  })

  it('M-03 the outcome CHECK is exactly the plugin module vocabulary', () => {
    expect(outcomeCheckList(YIDA_ISSUE_CONFIRM_WRITEBACK_UP_SQL)).toEqual([...plugin.ISSUE_CONFIRM_WRITEBACK_OUTCOMES])
    expect([...YIDA_ISSUE_CONFIRM_WRITEBACK_OUTCOMES]).toEqual([...plugin.ISSUE_CONFIRM_WRITEBACK_OUTCOMES])
    expect([...YIDA_ISSUE_CONFIRM_WRITEBACK_DATED_OUTCOMES]).toEqual([...plugin.ISSUE_CONFIRM_DATED_OUTCOMES])
    expect(plugin.ISSUE_CONFIRM_WRITEBACK_OUTCOMES).toHaveLength(12)
  })

  it('M-04 down() refuses with the fixed code while any row exists, before any DROP', async () => {
    const recorded: CompiledQuery[] = []
    await down(createFakeDb(recorded))
    expect(recorded.map(query => query.sql)).toEqual([YIDA_ISSUE_CONFIRM_WRITEBACK_DOWN_SQL])
    const text = norm(YIDA_ISSUE_CONFIRM_WRITEBACK_DOWN_SQL)
    const refusal = text.indexOf(`IF EXISTS (SELECT 1 FROM integration_yida_issue_confirm_writeback) THEN RAISE EXCEPTION '${YIDA_ISSUE_CONFIRM_WRITEBACK_DOWN_REFUSED_CODE}'`)
    expect(refusal).toBeGreaterThan(0)
    const firstDrop = text.indexOf('DROP ')
    expect(firstDrop).toBeGreaterThan(refusal)
    expect(text).toContain('DROP TABLE integration_yida_issue_confirm_writeback;')
    expect(text).toContain('DROP FUNCTION IF EXISTS integration_yida_issue_confirm_writeback_guard();')
    expect(text).toContain('DROP FUNCTION IF EXISTS integration_yida_issue_confirm_writeback_truncate_guard();')
  })
})

describe('plugin business-day zone mirrors the host resolver', () => {
  it('TZ resolveIssueConfirmBusinessTimeZone === resolveMultitableBusinessTimezone on a value matrix', () => {
    const values = [undefined, '', '   ', 'Asia/Shanghai', ' Asia/Tokyo ', 'America/Los_Angeles', 'Etc/UTC', 'UTC', 'Not/AZone', 'asia/shanghai', '+08:00']
    for (const value of values) {
      const env = value === undefined ? {} : { MULTITABLE_BUSINESS_TIMEZONE: value }
      expect(plugin.resolveIssueConfirmBusinessTimeZone(env)).toBe(resolveMultitableBusinessTimezone(env as NodeJS.ProcessEnv))
    }
  })
})
