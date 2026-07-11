'use strict'

// BA-APPLY-2a — text assertions on the 065 migration (style of read-source-config-migration.test.cjs;
// migration-sql.test.cjs is left untouched).

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const migrationPath = path.join(repoRoot, 'packages', 'core-backend', 'migrations', '065_create_integration_bridge_agent_checklists.sql')
const rawSql = fs.readFileSync(migrationPath, 'utf8')
// Strip full-line SQL comments BEFORE matching so an assertion can never be satisfied by
// commented-out DDL.
const sql = rawSql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')

function tableBlock(table) {
  const match = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`, 'm'))
  assert.ok(match, `expected CREATE TABLE IF NOT EXISTS block for ${table}`)
  return match[1]
}

// Forward migration must never drop.
assert.doesNotMatch(sql, /\bDROP\s+TABLE\b/i, 'forward migration must not drop tables')

// --- integration_bridge_agent_checklists -----------------------------------
const checklists = tableBlock('integration_bridge_agent_checklists')
for (const column of ['id', 'tenant_id', 'workspace_id', 'checklist', 'content_key', 'version', 'status', 'created_by', 'updated_by', 'created_at', 'updated_at']) {
  assert.ok(new RegExp(`(^|\\n)\\s*${column}\\s`).test(checklists), `checklists table must declare ${column}`)
}
assert.match(checklists, /tenant_id\s+TEXT NOT NULL/, 'tenant_id is required')
assert.match(checklists, /checklist\s+JSONB NOT NULL/, 'checklist is JSONB NOT NULL')
assert.match(checklists, /content_key\s+TEXT NOT NULL/, 'content_key is required')
assert.match(checklists, /version\s+INTEGER NOT NULL/, 'version is required')
assert.match(
  checklists,
  /status\s+TEXT NOT NULL DEFAULT 'draft' CHECK \(status IN \('draft', 'approved', 'retired'\)\)/,
  'status CHECK lists exactly draft/approved/retired with draft default',
)
// HARD LOCK: this table stores structure only — NO credential, host, systemId, or apply column may
// exist (the backend never contacts / never writes the Bridge Agent).
for (const forbidden of ['credentials', 'credential', 'base_url', 'baseUrl', 'token', 'password', 'system_id', 'host', 'applied', 'apply']) {
  assert.ok(!checklists.includes(forbidden), `checklists table must not declare a ${forbidden} column`)
}

// Content-keyed idempotency: unique expression index over the (tenant, workspace) family + content
// key, with the COALESCE NULL-workspace coercion.
assert.match(
  sql,
  /CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_bridge_agent_checklists_content\s*\n\s*ON integration_bridge_agent_checklists \(tenant_id, COALESCE\(workspace_id, ''\), content_key\);/,
  'unique content index covers (scope, content_key)',
)
assert.match(
  sql,
  /CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_bridge_agent_checklists_family_version\s*\n\s*ON integration_bridge_agent_checklists \(tenant_id, COALESCE\(workspace_id, ''\), version\);/,
  'unique family-version index backstops concurrent version minting',
)
assert.match(
  sql,
  /CREATE INDEX IF NOT EXISTS idx_integration_bridge_agent_checklists_status/,
  'status index exists',
)

// --- integration_bridge_agent_checklist_audit -------------------------------
const audit = tableBlock('integration_bridge_agent_checklist_audit')
for (const column of ['id', 'tenant_id', 'workspace_id', 'checklist_id', 'action', 'actor', 'detail', 'created_at']) {
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
  /CREATE INDEX IF NOT EXISTS idx_integration_bridge_agent_checklist_audit_checklist\s*\n\s*ON integration_bridge_agent_checklist_audit \(tenant_id, checklist_id, created_at\);/,
  'audit lookup index exists',
)

// updated_at trigger rides the 057 shared function — anchored as ONE block.
assert.match(
  sql,
  /CREATE TRIGGER trg_integration_bridge_agent_checklists_updated_at\s*\n\s*BEFORE UPDATE ON integration_bridge_agent_checklists\s*\n\s*FOR EACH ROW EXECUTE FUNCTION integration_set_updated_at\(\);/,
  'checklists table has the anchored updated_at trigger block',
)

console.log('bridge-agent-change-checklist-migration.test.cjs OK')
