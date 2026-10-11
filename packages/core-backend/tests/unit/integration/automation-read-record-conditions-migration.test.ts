/** Actual migration SQL through Kysely, not a PG evaluator. The real-PG owner must additionally prove
 * missing-migration atomic rollback, direct malformed descriptors/NULL mismatches, metadata ABA,
 * cutover minting, immutable confirmation, repeated up, and history-protected down.
 */
import { Kysely, PostgresDialect, type PostgresPoolClient } from 'kysely'
import { describe, expect, it } from 'vitest'
import { up, down } from '../../../src/db/migrations/zzzz20261001140000_automation_read_record_conditions'
import { up as previousUp } from '../../../src/db/migrations/zzzz20261001137000_automation_read_record_updated_activation'

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

function functionBody(statement: string): string {
  const start = statement.indexOf('CREATE OR REPLACE FUNCTION __SCHEMA__.automation_read_record_activation_admit()')
  expect(start).toBeGreaterThanOrEqual(0)
  const end = statement.indexOf('END $function$;', start)
  expect(end).toBeGreaterThan(start)
  return statement.slice(start, end + 'END $function$;'.length).replace(/--[^\n]*\n/gu, '').replace(/\s+/gu, ' ').trim()
}

describe('record condition confirmation migration — emitted SQL only', () => {
  it('installs only an unconditional historical default and never derives old consent from current rules', async () => {
    const statement = await capture(up)
    expect(statement).toContain('ADD COLUMN IF NOT EXISTS condition_confirmation JSONB NOT NULL DEFAULT')
    expect(statement).toContain("''{\"mode\":\"unconditional\"}''::JSONB")
    expect(statement).not.toMatch(/\b(?:UPDATE|INSERT INTO|DELETE FROM|TRUNCATE)\s+__SCHEMA__\.integration_automation_read_record_activations\b/u)
    expect(statement).not.toContain('SET condition_confirmation')
  })
  it('repeat-up checks the existing column type/nullability/default and recreates only its own CHECK', async () => {
    const first = await capture(up), second = await capture(up)
    expect(second).toBe(first)
    expect(first).toContain("a.atttypid='pg_catalog.jsonb'::pg_catalog.regtype AND a.attnotnull")
    expect(first).toContain('pg_catalog.pg_get_expr(d.adbin,d.adrelid)')
    expect(first).toContain('AUTOMATION_READ_RECORD_CONDITIONS_SCHEMA_INVALID')
    expect(first).toContain('DROP CONSTRAINT IF EXISTS automation_read_record_condition_confirmation')
    expect(first).not.toContain('DROP TRIGGER')
  })
  it('closes both descriptor variants, exact keys, lower UUID and bounded string timezone without NULL CHECK escapes', async () => {
    const statement = await capture(up)
    expect(statement).toContain("condition_confirmation='{\"mode\":\"unconditional\"}'::JSONB")
    expect(statement).toContain("condition_confirmation->>'mode'='saved_conditions'")
    expect(statement).toContain("condition_confirmation->>'schemaRevision' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'")
    expect(statement).toContain("length(condition_confirmation->>'businessTimeZone') BETWEEN 1 AND 128")
    expect(statement).toContain("condition_confirmation=pg_catalog.jsonb_build_object('mode','saved_conditions',")
    expect(statement).toContain(')) IS TRUE);')
    expect(statement).toContain('IF ((NEW.condition_confirmation=')
    expect(statement).toContain('IS NOT TRUE THEN')
  })
  it('keeps the actual grant then rule NOWAIT locks and all existing owner/scope/action/trigger gates', async () => {
    const statement = await capture(up), body = functionBody(statement)
    expect(body.indexOf('integration_automation_read_grants g')).toBeLessThan(body.indexOf('automation_rules r'))
    expect(body).toContain('FOR UPDATE NOWAIT')
    expect(body).toContain('FOR SHARE NOWAIT')
    for (const guard of ["grant_row->>'purpose' IS DISTINCT FROM 'automatic'", "grant_row->>'status' IS DISTINCT FROM 'active'",
      "grant_row->>'tenant_id' IS DISTINCT FROM NEW.tenant_id", "grant_row->>'owner_id' IS DISTINCT FROM NEW.owner_id",
      "grant_row->'selector'->>'ruleId' IS DISTINCT FROM NEW.rule_id", "grant_row->'projects' IS DISTINCT FROM pg_catalog.jsonb_build_array(NEW.project_no)",
      "grant_row->'triggers' IS DISTINCT FROM '[\"record\"]'::JSONB", "rule_row->>'created_by' IS DISTINCT FROM NEW.owner_id",
      "rule_row->'enabled' IS DISTINCT FROM 'true'::JSONB", "rule_row->>'sheet_id' IS DISTINCT FROM NEW.sheet_id",
      "rule_row->>'integration_authority_revision' IS DISTINCT FROM NEW.rule_revision::TEXT", "rule_row->>'action_type' IS DISTINCT FROM 'integration_read_preview'",
      "rule_row->>'trigger_type' IS DISTINCT FROM 'record.created'", "rule_row->>'trigger_type' IS DISTINCT FROM 'record.updated'",
      "rule_row->'trigger_config' IS DISTINCT FROM '{}'::JSONB"]) expect(body).toContain(guard)
  })
  it('requires unconditional for null conditions and saved_conditions plus a bounded JSON object otherwise', async () => {
    const statement = await capture(up)
    expect(statement).toContain("IF rule_row->'conditions'='null'::JSONB THEN")
    expect(statement).toContain("NEW.condition_confirmation IS DISTINCT FROM '{\"mode\":\"unconditional\"}'::JSONB")
    expect(statement).toContain("NEW.condition_confirmation->>'mode' IS DISTINCT FROM 'saved_conditions'")
    expect(statement).toContain("pg_catalog.jsonb_typeof(rule_row->'conditions') IS DISTINCT FROM 'object'")
    expect(statement).toContain("octet_length((rule_row->'conditions')::TEXT)>65536")
    expect(statement).not.toContain('jsonb_array_elements')
    expect(statement).not.toContain("operator'")
  })
  it('uses exact pg timezone names, not a mutable host timezone or UTC fallback', async () => {
    const statement = await capture(up)
    expect(statement).toContain('SELECT 1 FROM pg_catalog.pg_timezone_names')
    expect(statement).toContain("WHERE name=NEW.condition_confirmation->>'businessTimeZone'")
    expect(statement).toContain("name NOT LIKE 'posix/%' AND name NOT LIKE 'right/%'")
    expect(statement).not.toContain("COALESCE(NEW.condition_confirmation->>'businessTimeZone','UTC')")
    expect(statement).not.toMatch(/SET (?:LOCAL )?TIME ZONE/u)
  })
  it('reproves the same-schema live metadata fence and exact sheet epoch, never captures a later nonce', async () => {
    const statement = await capture(up)
    expect(statement).toContain("'%1$I.plugin_multitable_object_registry IN SHARE MODE NOWAIT'")
    expect(statement).toContain("count(c.oid)=4 AND bool_and(c.relkind='r' AND NOT c.relrowsecurity)")
    expect(statement).toContain("pg_catalog.format('%I.%I',TG_TABLE_SCHEMA,expected.name)")
    expect(statement).toContain('SELECT deleted_at IS NULL FROM %I.meta_sheets WHERE id=$1')
    expect(statement).toContain('SELECT revision FROM %I.automation_read_material_epochs')
    expect(statement).toContain("WHERE kind=''sheet'' AND scope=pg_catalog.jsonb_build_object(''id'',$1::text) FOR SHARE NOWAIT")
    expect(statement).toContain("schema_revision::TEXT IS DISTINCT FROM\n          NEW.condition_confirmation->>'schemaRevision'")
    expect(statement).not.toContain('NEW.condition_confirmation :=')
  })
  it('mints cutover only after all descriptor/schema facts and retains existing whole-row immutability', async () => {
    const statement = await capture(up)
    expect(statement.indexOf('NEW.activated_at := pg_catalog.clock_timestamp()')).toBeGreaterThan(statement.indexOf('schema_revision::TEXT IS DISTINCT FROM'))
    expect(statement.indexOf("IF (grant_row->>'expires_at')::TIMESTAMPTZ<=pg_catalog.clock_timestamp() THEN"))
      .toBeGreaterThan(statement.indexOf('schema_revision::TEXT IS DISTINCT FROM'))
    expect(statement).not.toContain('CREATE TRIGGER automation_read_record_activation_immutable')
    expect(statement).not.toContain('DROP TRIGGER automation_read_record_activation_immutable')
    expect(statement).not.toContain('DISABLE TRIGGER')
  })
  it('resolves the actual owner schema and pins every trigger lookup to its schema, not public/search_path', async () => {
    for (const migrate of [up, down]) {
      const statement = await capture(migrate)
      expect(statement).toContain("c.oid='integration_automation_read_grants'::pg_catalog.regclass")
      expect(statement).toContain('LANGUAGE plpgsql SET search_path=pg_catalog')
      expect(statement).toContain("pg_catalog.quote_ident(grant_schema)")
      expect(statement).not.toContain('public.')
      expect(statement).not.toContain('SECURITY DEFINER')
    }
  })
  it('refuses every retained record history before restoring/removing anything, without destroying schedule history', async () => {
    const statement = await capture(down)
    const locks = statement.indexOf('LOCK TABLE %I.integration_automation_read_record_activations IN ACCESS EXCLUSIVE MODE')
    const refusal = statement.indexOf('AUTOMATION_READ_RECORD_CONDITIONS_HAS_HISTORY')
    const restore = statement.indexOf('CREATE OR REPLACE FUNCTION')
    expect(locks).toBeGreaterThanOrEqual(0); expect(refusal).toBeGreaterThan(locks); expect(restore).toBeGreaterThan(refusal)
    expect(statement).toContain("purpose=''automatic'' AND triggers=ARRAY[''record'']::TEXT[]")
    expect(statement).toContain('DROP COLUMN IF EXISTS condition_confirmation')
    expect(statement).not.toMatch(/\b(?:DELETE FROM|TRUNCATE|UPDATE)\s+(?:__SCHEMA__\.|%I\.)?integration_automation_read_/u)
    expect(statement).not.toContain('integration_automation_read_schedule_activations')
  })
  it('restores the exact 137 dual-record null-only function, disregarding only comments and whitespace', async () => {
    expect(functionBody(await capture(down))).toBe(functionBody(await capture(previousUp)))
    expect(functionBody(await capture(down))).not.toContain('condition_confirmation')
  })
})
