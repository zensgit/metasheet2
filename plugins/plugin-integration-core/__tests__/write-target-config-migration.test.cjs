'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const migrationPath = path.join(repoRoot, 'packages', 'core-backend', 'migrations', '064_create_integration_write_target_configs.sql')
const rawSql = fs.readFileSync(migrationPath, 'utf8')
const sql = rawSql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')

function tableBlock(name) {
  const match = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(([\\s\\S]*?)\\n\\);`, 'm'))
  assert.ok(match, `${name} table exists`)
  return match[1]
}

const configs = tableBlock('integration_write_target_configs')
for (const column of [
  'tenant_id', 'workspace_id', 'system_id', 'sandbox_system_id', 'object', 'operation',
  'config', 'content_key', 'version', 'status', 'created_by', 'updated_by',
]) {
  assert.ok(new RegExp(`(^|\\n)\\s*${column}\\s`).test(configs), `${column} present`)
}
assert.match(configs, /tenant_id\s+TEXT NOT NULL/, 'tenant_id is required')
assert.match(configs, /system_id\s+TEXT NOT NULL/, 'system_id is required')
assert.match(configs, /sandbox_system_id\s+TEXT NOT NULL/, 'sandbox_system_id is required')
assert.match(configs, /config\s+JSONB NOT NULL/, 'config is JSONB NOT NULL')
assert.match(configs, /content_key\s+TEXT NOT NULL/, 'content_key is required')
assert.match(configs, /version\s+INTEGER NOT NULL/, 'version is required')
assert.match(configs, /operation\s+TEXT NOT NULL CHECK \(operation IN \('upsert', 'save_only'\)\)/)
assert.match(configs, /status\s+TEXT NOT NULL DEFAULT 'draft' CHECK \(status IN \('draft', 'approved', 'retired'\)\)/)
assert.match(
  sql,
  /CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_write_target_configs_content\s*\n\s*ON integration_write_target_configs \(\s*\n\s*tenant_id,\s*\n\s*COALESCE\(workspace_id, ''\),\s*\n\s*system_id,\s*\n\s*sandbox_system_id,\s*\n\s*object,\s*\n\s*operation,\s*\n\s*content_key\s*\n\s*\);/,
  'unique content index covers scope, system pair, object, operation, content_key',
)
assert.match(
  sql,
  /CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_write_target_configs_family_version\s*\n\s*ON integration_write_target_configs \(\s*\n\s*tenant_id,\s*\n\s*COALESCE\(workspace_id, ''\),\s*\n\s*system_id,\s*\n\s*sandbox_system_id,\s*\n\s*object,\s*\n\s*operation,\s*\n\s*version\s*\n\s*\);/,
  'unique family-version index covers scope, system pair, object, operation, version',
)
assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_integration_write_target_configs_system/)
assert.match(sql, /CREATE TRIGGER trg_integration_write_target_configs_updated_at/)

const audit = tableBlock('integration_write_target_config_audit')
for (const column of ['tenant_id', 'workspace_id', 'config_id', 'action', 'actor', 'detail']) {
  assert.ok(new RegExp(`(^|\\n)\\s*${column}\\s`).test(audit), `${column} present in audit`)
}
assert.match(audit, /tenant_id\s+TEXT NOT NULL/, 'audit tenant_id is required')
assert.match(audit, /config_id\s+TEXT NOT NULL/, 'audit config_id is required')
assert.match(audit, /action\s+TEXT NOT NULL CHECK \(action IN \('save_version', 'reuse_version', 'status_change'\)\)/)
assert.match(audit, /detail\s+JSONB NOT NULL DEFAULT '\{\}'::jsonb/, 'audit detail is JSONB with empty default')
assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_integration_write_target_config_audit_config/)

for (const forbidden of ['credential', 'password', 'token', 'base_url', 'payload_values']) {
  assert.ok(!configs.toLowerCase().includes(forbidden), `config table must not store ${forbidden}`)
}

assert.match(
  sql,
  /CREATE TRIGGER trg_integration_write_target_configs_updated_at\s*\n\s*BEFORE UPDATE ON integration_write_target_configs\s*\n\s*FOR EACH ROW EXECUTE FUNCTION integration_set_updated_at\(\);/,
  'configs table has the anchored updated_at trigger block',
)

console.log('write-target-config-migration.test.cjs OK')
