'use strict'

// Read-source resolver composition C-R1 — text assertions on migration 063.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const migrationPath = path.join(repoRoot, 'packages', 'core-backend', 'migrations', '063_create_integration_read_source_composition_configs.sql')
const rawSql = fs.readFileSync(migrationPath, 'utf8')
const sql = rawSql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')

function tableBlock(table) {
  const match = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`, 'm'))
  assert.ok(match, `expected CREATE TABLE IF NOT EXISTS block for ${table}`)
  return match[1]
}

const configs = tableBlock('integration_read_source_composition_configs')
for (const column of ['id', 'tenant_id', 'workspace_id', 'name', 'config', 'content_key', 'version', 'status', 'created_by', 'updated_by', 'created_at', 'updated_at']) {
  assert.ok(new RegExp(`(^|\\n)\\s*${column}\\s`).test(configs), `composition configs table must declare ${column}`)
}
assert.match(configs, /tenant_id\s+TEXT NOT NULL/, 'tenant_id is required')
assert.match(configs, /name\s+TEXT NOT NULL/, 'name is required')
assert.match(configs, /config\s+JSONB NOT NULL/, 'config is JSONB NOT NULL')
assert.match(configs, /content_key\s+TEXT NOT NULL/, 'content_key is required')
assert.match(configs, /version\s+INTEGER NOT NULL/, 'version is required')
assert.match(
  configs,
  /status\s+TEXT NOT NULL DEFAULT 'draft' CHECK \(status IN \('draft', 'approved', 'retired'\)\)/,
  'status CHECK lists exactly draft/approved/retired with draft default',
)
for (const forbidden of ['credentials', 'credential', 'base_url', 'baseUrl', 'token', 'password', 'runtime_key', 'resolved_value', 'payload']) {
  assert.ok(!configs.includes(forbidden), `composition configs table must not declare a ${forbidden} column`)
}

assert.match(
  sql,
  /CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_read_source_composition_configs_content\s*\n\s*ON integration_read_source_composition_configs \(tenant_id, COALESCE\(workspace_id, ''\), name, content_key\);/,
  'unique content index covers (scope, name, content_key)',
)
assert.match(
  sql,
  /CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_read_source_composition_configs_family_version\s*\n\s*ON integration_read_source_composition_configs \(tenant_id, COALESCE\(workspace_id, ''\), name, version\);/,
  'unique family-version index backstops concurrent version minting',
)
assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_integration_read_source_composition_configs_status/, 'status index exists')

const audit = tableBlock('integration_read_source_composition_config_audit')
for (const column of ['id', 'tenant_id', 'workspace_id', 'config_id', 'action', 'actor', 'detail', 'created_at']) {
  assert.ok(new RegExp(`(^|\\n)\\s*${column}\\s`).test(audit), `composition audit table must declare ${column}`)
}
assert.match(
  audit,
  /action\s+TEXT NOT NULL CHECK \(action IN \('save_version', 'reuse_version', 'status_change'\)\)/,
  'audit action CHECK lists exactly the three audited actions',
)
assert.match(audit, /detail\s+JSONB NOT NULL DEFAULT '\{\}'::jsonb/, 'audit detail is JSONB with empty default')
assert.match(
  sql,
  /CREATE INDEX IF NOT EXISTS idx_integration_read_source_composition_config_audit_config\s*\n\s*ON integration_read_source_composition_config_audit \(tenant_id, config_id, created_at\);/,
  'audit lookup index exists',
)

assert.match(
  sql,
  /CREATE TRIGGER trg_integration_read_source_composition_configs_updated_at\s*\n\s*BEFORE UPDATE ON integration_read_source_composition_configs\s*\n\s*FOR EACH ROW EXECUTE FUNCTION integration_set_updated_at\(\);/,
  'composition configs table has the anchored updated_at trigger block',
)
assert.doesNotMatch(sql, /\bDROP\s+(?:TABLE|INDEX)\b/i, '063 migration must not drop objects')

console.log('read-source-composition-config-migration.test.cjs OK')
