/** SQL-emission contract only; actual casts, CHECK truth tables, locks and
 * history-preserving rollback are exercised by the schedule real-PG suite. */
import { Kysely, PostgresDialect, type PostgresPoolClient } from 'kysely'
import { describe, expect, it } from 'vitest'
import { up, down } from '../../../src/db/migrations/zzzz20261001141000_automation_read_interval_schedule_activation'
import { up as cronUp } from '../../../src/db/migrations/zzzz20261001136000_automation_read_schedule_activation'

async function capture(migrate: typeof up): Promise<string> {
  const statements: string[] = []
  const client: PostgresPoolClient = {
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
    expect(statements[0]).toContain('DO $migration$')
    return statements[0]
  } finally { await db.destroy() }
}

function admissionBody(statement: string): string {
  const normalized = statement.replace('CREATE FUNCTION __SCHEMA__.automation_read_schedule_activation_admit()',
    'CREATE OR REPLACE FUNCTION __SCHEMA__.automation_read_schedule_activation_admit()')
  const start = normalized.indexOf('CREATE OR REPLACE FUNCTION __SCHEMA__.automation_read_schedule_activation_admit()')
  expect(start).toBeGreaterThanOrEqual(0)
  const end = normalized.indexOf('END $function$;', start)
  expect(end).toBeGreaterThan(start)
  return normalized.slice(start, end + 'END $function$;'.length).replace(/--[^\n]*\n/gu, '').replace(/\s+/gu, ' ').trim()
}

describe('interval schedule activation migration — emitted SQL only', () => {
  it('adds only explicit family and phase, preserving old cron histories without data writes', async () => {
    const statement = await capture(up)
    expect(statement).toContain("ADD COLUMN IF NOT EXISTS trigger_type TEXT NOT NULL DEFAULT ''schedule.cron''")
    expect(statement).toContain('ADD COLUMN IF NOT EXISTS interval_anchor_ms BIGINT')
    expect(statement).not.toMatch(/\b(?:UPDATE|INSERT INTO|DELETE FROM|TRUNCATE)\s+__SCHEMA__\.integration_automation_read_/u)
    expect(statement).not.toContain('CREATE TABLE')
    expect(statement).not.toContain('DROP TRIGGER')
  })

  it('repeat-up verifies both existing column contracts and leaves immutable/deferred guards intact', async () => {
    const statement = await capture(up)
    expect(await capture(up)).toBe(statement)
    expect(statement).toContain("a.atttypid='pg_catalog.text'::pg_catalog.regtype AND a.attnotnull")
    expect(statement).toContain("pg_catalog.pg_get_expr(d.adbin,d.adrelid)='''schedule.cron''::text'")
    expect(statement).toContain("a.atttypid='pg_catalog.int8'::pg_catalog.regtype AND NOT a.attnotnull AND d.oid IS NULL")
    expect(statement).toContain('AUTOMATION_READ_INTERVAL_SCHEDULE_SCHEMA_INVALID')
    expect(statement).not.toContain('CREATE TRIGGER')
    expect(statement).not.toContain('DROP TRIGGER')
  })

  it('closes the exact config union, integral delay range and NULL CHECK escape', async () => {
    const statement = await capture(up)
    expect(statement).toContain("trigger_type='schedule.cron' AND interval_anchor_ms IS NULL")
    expect(statement).toContain("trigger_type='schedule.interval' AND interval_anchor_ms BETWEEN 1 AND 8640000000000000")
    expect(statement).toContain("cron_config ? 'intervalMs'")
    expect(statement).toContain("(cron_config-ARRAY['intervalMs'])='{}'::JSONB")
    expect(statement).toContain("CASE WHEN pg_catalog.jsonb_typeof(cron_config->'intervalMs')='number' THEN")
    expect(statement).toContain("(cron_config->>'intervalMs')::NUMERIC BETWEEN 1000 AND 2147483647")
    expect(statement).toContain("(cron_config->>'intervalMs')::NUMERIC=pg_catalog.trunc((cron_config->>'intervalMs')::NUMERIC)")
    expect(statement).toContain('ELSE FALSE END)) IS TRUE);')
    expect(statement).toContain('IF (((NEW.trigger_type=')
    expect(statement).toContain('IS NOT TRUE THEN')
  })

  it('binds phase to the actual locked DB created_at with floor, finite and Date-range checks', async () => {
    const body = admissionBody(await capture(up))
    expect(body).toContain("pg_catalog.isfinite((rule_row->>'created_at')::TIMESTAMPTZ) IS NOT TRUE")
    expect(body).toContain("anchor_ms := pg_catalog.floor(extract(epoch FROM (rule_row->>'created_at')::TIMESTAMPTZ)*1000)")
    expect(body).toContain('(anchor_ms BETWEEN 1 AND 8640000000000000) IS NOT TRUE')
    expect(body).toContain('anchor_ms IS DISTINCT FROM NEW.interval_anchor_ms::NUMERIC')
    expect(body).not.toContain('NEW.interval_anchor_ms :=')
    expect(body.indexOf('NEW.activated_at := pg_catalog.clock_timestamp()')).toBeGreaterThan(body.indexOf('anchor_ms IS DISTINCT FROM'))
  })

  it('retains grant→rule NOWAIT order and exact real rule family/config/revision/owner checks', async () => {
    const body = admissionBody(await capture(up))
    expect(body.indexOf('integration_automation_read_grants g')).toBeLessThan(body.indexOf('automation_rules r'))
    expect(body).toContain('FOR UPDATE NOWAIT')
    expect(body).toContain('FOR SHARE NOWAIT')
    for (const guard of ["grant_row->>'purpose' IS DISTINCT FROM 'automatic'", "grant_row->>'status' IS DISTINCT FROM 'active'",
      "grant_row->'workspace_id' IS DISTINCT FROM 'null'::JSONB", "grant_row->>'tenant_id' IS DISTINCT FROM NEW.tenant_id",
      "grant_row->>'owner_id' IS DISTINCT FROM NEW.owner_id", "grant_row->'selector'->>'ruleId' IS DISTINCT FROM NEW.rule_id",
      "grant_row->'projects' IS DISTINCT FROM pg_catalog.jsonb_build_array(NEW.project_no)",
      "grant_row->'triggers' IS DISTINCT FROM '[\"schedule\"]'::JSONB", "rule_row->>'created_by' IS DISTINCT FROM NEW.owner_id",
      "rule_row->'enabled' IS DISTINCT FROM 'true'::JSONB", "rule_row->>'integration_authority_revision' IS DISTINCT FROM NEW.rule_revision::TEXT",
      "rule_row->>'action_type' IS DISTINCT FROM 'integration_read_preview'", "rule_row->>'trigger_type' IS DISTINCT FROM NEW.trigger_type",
      "rule_row->'conditions' IS DISTINCT FROM 'null'::JSONB", "rule_row->'trigger_config' IS DISTINCT FROM NEW.cron_config",
      'OR other_binding']) expect(body).toContain(guard)
  })

  it.each([up, down])('serializes migration rule→grant→activation and uses resolved-schema qualified SQL', async migrate => {
    const statement = await capture(migrate)
    const rule = statement.indexOf('LOCK TABLE %I.automation_rules IN SHARE MODE')
    const grant = statement.indexOf('LOCK TABLE %I.integration_automation_read_grants IN ACCESS EXCLUSIVE MODE')
    const activation = statement.indexOf('LOCK TABLE %I.integration_automation_read_schedule_activations IN ACCESS EXCLUSIVE MODE')
    expect(rule).toBeGreaterThanOrEqual(0)
    expect(grant).toBeGreaterThan(rule)
    expect(activation).toBeGreaterThan(grant)
    expect(statement).toContain("WHERE c.oid='integration_automation_read_grants'::pg_catalog.regclass")
    expect(statement).toContain("$ddl$,'__SCHEMA__',pg_catalog.quote_ident(grant_schema))")
    expect(statement).toContain('LANGUAGE plpgsql SET search_path=pg_catalog')
  })

  it('refuses retained interval history before altering anything, but does not forbid cron history', async () => {
    const statement = await capture(down)
    expect(statement).toContain("WHERE trigger_type IS DISTINCT FROM ''schedule.cron'' OR interval_anchor_ms IS NOT NULL")
    expect(statement).toContain("ERRCODE='55000', MESSAGE='AUTOMATION_READ_INTERVAL_SCHEDULE_HAS_HISTORY'")
    expect(statement.indexOf('IF has_history THEN')).toBeLessThan(statement.indexOf('CREATE OR REPLACE FUNCTION'))
    expect(statement).toContain('DROP COLUMN interval_anchor_ms, DROP COLUMN trigger_type')
    expect(statement).not.toContain('DROP TABLE')
    expect(statement).not.toContain('DELETE FROM')
    expect(statement).not.toContain('TRUNCATE')
  })

  it('restores the actual 136000 admission body instead of leaving interval-aware SQL on removed columns', async () => {
    expect(admissionBody(await capture(down))).toBe(admissionBody(await capture(cronUp)))
    const statement = await capture(down)
    expect(statement).toContain("(cron_config ? 'expression') <> (cron_config ? 'cron')")
    expect(admissionBody(statement)).not.toContain('NEW.trigger_type')
    expect(admissionBody(statement)).not.toContain('NEW.interval_anchor_ms')
  })
})
