'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const migrationPath = path.resolve(
  __dirname,
  '../../../packages/core-backend/migrations/' +
    '073_create_sealed_export_stock_prep_runtime_authority.sql',
)
const sql = fs.readFileSync(migrationPath, 'utf8')

assert.match(
  sql,
  /CREATE TABLE IF NOT EXISTS integration_sealed_export_stock_prep_bindings/,
)
assert.match(
  sql,
  /relation_id\s+TEXT NOT NULL CHECK \(\s*relation_id = 'sqlserver\.relation\.rowid_payload\.v1'/,
)
assert.match(
  sql,
  /uniq_integration_sealed_export_stock_prep_active_binding[\s\S]*?WHERE status = 'ACTIVE'/,
)
assert.match(
  sql,
  /uniq_integration_sealed_export_stock_prep_single_customer[\s\S]*?ON integration_sealed_export_stock_prep_bindings \(\(1\)\)[\s\S]*?WHERE status = 'ACTIVE'/,
)
assert.match(
  sql,
  /integration_sealed_export_stock_prep_binding_anchors_immutable/,
)
assert.match(
  sql,
  /CREATE TABLE IF NOT EXISTS integration_sealed_export_stock_prep_runs/,
)
assert.match(
  sql,
  /UNIQUE \(\s*tenant_id,\s*workspace_scope_key,\s*operation_id\s*\)/,
)
assert.match(
  sql,
  /uniq_integration_sealed_export_stock_prep_active_run[\s\S]*?ON integration_sealed_export_stock_prep_runs \(binding_id\)[\s\S]*?WHERE status NOT IN \('CAPTURE_FAILED', 'COMPLETED'\)/,
)
assert.match(
  sql,
  /source_read_count\s+SMALLINT NOT NULL DEFAULT 1 CHECK \(\s*source_read_count = 1/,
)
assert.match(
  sql,
  /business_line_count\s+INTEGER CHECK \(\s*business_line_count BETWEEN 1 AND 24999/,
)
assert.match(
  sql,
  /status = 'COMPLETED'[\s\S]*?business_line_count IS NOT NULL/,
)
assert.match(
  sql,
  /OLD\.business_line_count IS NOT NULL[\s\S]*?NEW\.business_line_count IS DISTINCT FROM/,
)
assert.match(
  sql,
  /integration_sealed_export_stock_prep_run_anchors_immutable/,
)
assert.match(
  sql,
  /OLD\.status = 'CAPTURING' AND NEW\.status IN \(\s*'CAPTURE_FAILED',\s*'CAPTURED'/,
)
assert.match(
  sql,
  /OLD\.status = 'CAPTURED' AND NEW\.status = 'INGESTING'/,
)
assert.match(
  sql,
  /OLD\.status = 'INGESTING' AND NEW\.status = 'INGESTED'/,
)
assert.match(
  sql,
  /OLD\.status = 'ACTIVATED' AND NEW\.status = 'COMPLETED'/,
)

assert.match(sql, /metasheet\.sealed_export_runtime_role/)
assert.match(sql, /metasheet\.sealed_export_provisioning_role/)
assert.match(sql, /runtime and provisioning roles must be configured together/)
assert.match(sql, /runtime and provisioning roles must be distinct/)
assert.match(
  sql,
  /pg_has_role\(runtime_role, provisioning_role, 'MEMBER'\)[\s\S]*?pg_has_role\(provisioning_role, runtime_role, 'MEMBER'\)/,
)
assert.match(
  sql,
  /runtime and provisioning roles must not inherit each other/,
)
assert.match(sql, /sealed-export role has unsafe authority/)
assert.match(sql, /NOT candidate_row\.rolcanlogin/)
assert.match(sql, /candidate_row\.rolinherit/)
assert.match(sql, /FROM pg_auth_members membership/)
assert.match(sql, /format\([\s\S]*?%I/)
assert.doesNotMatch(sql, /CREATE\s+(?:USER|ROLE)\b/i)

assert.match(
  sql,
  /GRANT SELECT ON TABLE %I\.%I TO %I'[\s\S]*?'integration_sealed_export_authority_state'[\s\S]*?runtime_role/,
)
assert.doesNotMatch(
  sql,
  /GRANT SELECT, INSERT, UPDATE ON TABLE %I\.%I TO %I'[\s\S]{0,160}'integration_sealed_export_authority_state'[\s\S]{0,80}runtime_role/,
)
assert.match(
  sql,
  /GRANT SELECT ON TABLE %I\.%I TO %I'[\s\S]*?'integration_sealed_export_stock_prep_bindings'[\s\S]*?runtime_role/,
)
assert.match(
  sql,
  /GRANT SELECT, INSERT, UPDATE ON TABLE %I\.%I TO %I'[\s\S]*?'integration_sealed_export_stock_prep_runs'[\s\S]*?runtime_role/,
)
assert.match(
  sql,
  /GRANT SELECT, INSERT, UPDATE ON TABLE %I\.%I TO %I'[\s\S]*?'integration_sealed_export_stock_prep_bindings'[\s\S]*?provisioning_role/,
)
assert.match(
  sql,
  /GRANT SELECT, INSERT ON TABLE %I\.%I TO %I'[\s\S]*?'integration_sealed_export_terminal_signer_keys'[\s\S]*?provisioning_role/,
)

console.log('sealed-export-s6a-runtime-authority-migration.test.cjs OK')
