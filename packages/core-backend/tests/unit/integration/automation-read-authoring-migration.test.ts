/** Captures the SQL emitted by the real migration through Kysely's PostgreSQL
 * dialect. Structural guards only; SQL evaluation/constraints need real PG. */
import { Kysely, PostgresDialect, type PostgresPoolClient } from 'kysely'
import { describe, expect, it } from 'vitest'
import { AUTOMATION_ACTION_TYPES_WITH_FWB } from '../../../src/db/migrations/zzzz20260720120000_add_write_approval_form_values_automation_action'
import { AUTOMATION_ACTION_TYPES_WITH_INTEGRATION_READ_PREVIEW, up, down } from '../../../src/db/migrations/zzzz20261001133000_add_automation_read_preview_action'

async function capture(migrate: typeof up): Promise<string> {
  const statements: string[] = []
  const client: PostgresPoolClient = {
    // This fixture supports only migration SQL, never cursor/network execution.
    query: (async (statement: string) => {
      if (typeof statement !== 'string') throw new Error('SYNTHETIC_MIGRATION_SQL_REQUIRED')
      statements.push(statement)
      return { rows: [], command: 'SELECT' as const, rowCount: 0 }
    }) as unknown as PostgresPoolClient['query'],
    release() {},
  }
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({
    pool: { async connect() { return client }, async end() {} },
  }) })
  try {
    await migrate(db)
    expect(statements).toHaveLength(1)
    expect(statements[0]).toMatch(/DO \$migration\$/u)
    return statements[0]
  } finally { await db.destroy() }
}

describe('automation read preview final-row migration: emitted DDL only', () => {
  it('adds only the read action to the latest FWB action superset', () => {
    expect(AUTOMATION_ACTION_TYPES_WITH_INTEGRATION_READ_PREVIEW).toEqual([
      ...AUTOMATION_ACTION_TYPES_WITH_FWB, 'integration_read_preview',
    ])
    expect(new Set(AUTOMATION_ACTION_TYPES_WITH_INTEGRATION_READ_PREVIEW).size)
      .toBe(AUTOMATION_ACTION_TYPES_WITH_FWB.length + 1)
    expect(AUTOMATION_ACTION_TYPES_WITH_FWB).toContain('write_approval_form_values')
  })
  it('resolves the table schema for the function/check and pins function lookup to pg_catalog', async () => {
    const statement = await capture(up)
    expect(statement).toContain("rule_table pg_catalog.regclass := 'automation_rules'::pg_catalog.regclass")
    expect(statement).toContain('n.oid = c.relnamespace WHERE c.oid = rule_table')
    expect(statement).toContain('CREATE OR REPLACE FUNCTION %I.automation_read_preview_row_valid(')
    expect(statement).toContain('LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog')
    expect(statement).toContain('CHECK (%I.automation_read_preview_row_valid(action_type, action_config, actions, execution_mode, trigger_type) IS TRUE)')
    expect(statement).not.toContain('SECURITY DEFINER')
    expect(statement).not.toContain('public.')
  })
  it('guards exact read config, mirror equality, legacy-only mode and explicit supported triggers', async () => {
    const statement = await capture(up)
    expect(statement).toContain("WHEN p_action_type = 'integration_read_preview' THEN COALESCE(")
    expect(statement).toContain("pg_catalog.jsonb_typeof(p_action_config->'allowManual') = 'boolean'")
    expect(statement).toContain('p_action_config = pg_catalog.jsonb_build_object(')
    expect(statement).toContain("p_actions IS NULL OR p_actions = 'null'::pg_catalog.jsonb OR p_actions = '[]'::pg_catalog.jsonb")
    expect(statement).toContain("'type', 'integration_read_preview', 'config', p_action_config")
    expect(statement).toContain("p_execution_mode IS NULL OR p_execution_mode = 'legacy'")
    expect(statement).toContain("'schedule.cron', 'schedule.interval', 'schedule.date_field'")
    expect(statement).toContain("'record.created', 'record.updated', 'record.deleted', 'field.value_changed'")
    expect(statement).not.toContain("'field.changed'")
    expect(statement).not.toContain("'webhook.received'")
  })
  it('walks effective action/branch arrays recursively without scanning arbitrary object fields', async () => {
    for (const migrate of [up, down]) {
      const statement = await capture(migrate)
      expect(statement).toContain('WITH RECURSIVE action_nodes(node)')
      expect(statement).toContain("parent.node->>'type' IN ('condition_branch', 'parallel_branch')")
      expect(statement).toContain("parent.node#>'{config,branches}'")
      expect(statement).toContain("parent.node->>'type' = 'condition_branch'")
      expect(statement).toContain("parent.node#>'{config,defaultBranch,actions}'")
      expect(statement).toContain("branch.value->'actions'")
      expect(statement).not.toMatch(/jsonb_(?:each|path_query)|LIKE|ILIKE/u)
    }
  })
  it('adds a bounded owner-options partial index with C ordering and no row mutation', async () => {
    const statement = await capture(up)
    expect(statement).toContain('CREATE INDEX IF NOT EXISTS idx_automation_read_rule_owner_options')
    expect(statement).toContain('ON %s (sheet_id, created_by, id COLLATE "C")')
    expect(statement).toContain("WHERE enabled AND action_type = 'integration_read_preview'")
    expect(statement).not.toMatch(/\b(?:INSERT INTO|UPDATE automation_rules|DELETE FROM)\b/u)
  })
  it('guards rollback under an exclusive lock before DDL, retains FWB, and can repeat without the helper', async () => {
    const statement = await capture(down)
    const lock = statement.indexOf('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE')
    const guard = statement.indexOf("MESSAGE = 'AUTOMATION_READ_PREVIEW_ACTION_IN_USE'")
    const firstDrop = statement.indexOf('DROP CONSTRAINT')
    expect(lock).toBeGreaterThanOrEqual(0)
    expect(guard).toBeGreaterThan(lock)
    expect(firstDrop).toBeGreaterThan(guard)
    expect(statement).toContain("ERRCODE = '55000'")
    expect(statement).toContain('WITH RECURSIVE action_nodes(node)')
    expect(statement).toContain('DROP INDEX IF EXISTS %I.idx_automation_read_rule_owner_options')
    expect(statement).toContain('DROP FUNCTION IF EXISTS %I.automation_read_preview_row_valid(')
    const enumCheck = statement.slice(statement.indexOf('CHECK (action_type IN'))
    for (const action of AUTOMATION_ACTION_TYPES_WITH_FWB) expect(enumCheck).toContain(`'${action}'`)
    expect(enumCheck).not.toContain("'integration_read_preview'")
    expect(statement).not.toMatch(/\b(?:DELETE FROM|TRUNCATE|UPDATE automation_rules)\b/u)
  })
})
