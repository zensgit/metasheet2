'use strict'

// External-API read self-service S2-c — text assertions on the 062 migration
// (style of migration-sql.test.cjs; that file is left untouched).

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const migrationPath = path.join(repoRoot, 'packages', 'core-backend', 'migrations', '062_create_integration_read_source_configs.sql')
const rawSql = fs.readFileSync(migrationPath, 'utf8')
// Strip full-line SQL comments BEFORE matching, so an assertion can never be satisfied by
// commented-out DDL (a `-- CREATE TRIGGER ...` line must not pass the trigger check).
const sql = rawSql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')

function tableBlock(table) {
  const match = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`, 'm'))
  assert.ok(match, `expected CREATE TABLE IF NOT EXISTS block for ${table}`)
  return match[1]
}

// --- integration_read_source_configs ---------------------------------------
const configs = tableBlock('integration_read_source_configs')
for (const column of ['id', 'tenant_id', 'workspace_id', 'system_id', 'object', 'mode', 'config', 'content_key', 'version', 'status', 'created_by', 'updated_by', 'created_at', 'updated_at']) {
  assert.ok(new RegExp(`(^|\\n)\\s*${column}\\s`).test(configs), `configs table must declare ${column}`)
}
assert.match(configs, /tenant_id\s+TEXT NOT NULL/, 'tenant_id is required')
assert.match(configs, /system_id\s+TEXT NOT NULL/, 'system_id (reference only) is required')
assert.match(configs, /config\s+JSONB NOT NULL/, 'config is JSONB NOT NULL')
assert.match(configs, /content_key\s+TEXT NOT NULL/, 'content_key is required')
assert.match(configs, /version\s+INTEGER NOT NULL/, 'version is required')
// Enum strictness in the schema itself — the four S1 modes and the three statuses, nothing else.
assert.match(
  configs,
  /mode\s+TEXT NOT NULL CHECK \(mode IN \('single_record', 'list_page', 'detail_with_lines', 'resolver_lookup'\)\)/,
  'mode CHECK lists exactly the four S1 read modes',
)
assert.match(
  configs,
  /status\s+TEXT NOT NULL DEFAULT 'draft' CHECK \(status IN \('draft', 'approved', 'retired'\)\)/,
  'status CHECK lists exactly draft/approved/retired with draft default',
)
// The persistence stores structure + reference only — no credential/base-URL columns may exist.
for (const forbidden of ['credentials', 'credential', 'base_url', 'baseUrl', 'token', 'password']) {
  assert.ok(!configs.includes(forbidden), `configs table must not declare a ${forbidden} column`)
}

// Content-keyed idempotency: unique expression index over the family + content key, with the
// COALESCE NULL-workspace coercion (same trap as 057).
assert.match(
  sql,
  /CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_read_source_configs_content\s*\n\s*ON integration_read_source_configs \(tenant_id, COALESCE\(workspace_id, ''\), system_id, object, mode, content_key\);/,
  'unique content index covers (scope, system, object, mode, content_key)',
)
// Version-minting race backstop (review item 1a): unique family+version expression index.
assert.match(
  sql,
  /CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_read_source_configs_family_version\s*\n\s*ON integration_read_source_configs \(tenant_id, COALESCE\(workspace_id, ''\), system_id, object, mode, version\);/,
  'unique family-version index backstops concurrent version minting',
)
assert.match(
  sql,
  /CREATE INDEX IF NOT EXISTS idx_integration_read_source_configs_system/,
  'list index on (scope, system_id) exists',
)

// --- integration_read_source_config_audit -----------------------------------
const audit = tableBlock('integration_read_source_config_audit')
for (const column of ['id', 'tenant_id', 'workspace_id', 'config_id', 'action', 'actor', 'detail', 'created_at']) {
  assert.ok(new RegExp(`(^|\\n)\\s*${column}\\s`).test(audit), `audit table must declare ${column}`)
}
assert.match(
  audit,
  /action\s+TEXT NOT NULL CHECK \(action IN \('save_version', 'reuse_version', 'status_change'\)\)/,
  'audit action CHECK lists exactly the three audited actions',
)
assert.match(audit, /detail\s+JSONB NOT NULL DEFAULT '\{\}'::jsonb/, 'audit detail is JSONB with empty default')
assert.match(
  sql,
  /CREATE INDEX IF NOT EXISTS idx_integration_read_source_config_audit_config\s*\n\s*ON integration_read_source_config_audit \(tenant_id, config_id, created_at\);/,
  'audit lookup index exists',
)

// updated_at trigger rides the 057 shared function — anchored as ONE block (name + timing +
// function) so a renamed trigger, wrong table, or wrong function cannot slip through, and the
// comment-stripping above guarantees this matches live DDL, not a comment.
assert.match(
  sql,
  /CREATE TRIGGER trg_integration_read_source_configs_updated_at\s*\n\s*BEFORE UPDATE ON integration_read_source_configs\s*\n\s*FOR EACH ROW EXECUTE FUNCTION integration_set_updated_at\(\);/,
  'configs table has the anchored updated_at trigger block',
)

console.log('read-source-config-migration.test.cjs OK')
