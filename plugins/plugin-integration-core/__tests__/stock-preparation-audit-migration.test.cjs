'use strict'

// W5b (#3751/#3890) + P4 Option C — text assertions on the 066 base audit migration and the 067
// closed-vocabulary extension (style of the 062/065 migration
// tests; migration-sql.test.cjs is left untouched). Locks:
//   - the CHECK action vocabulary is SET-EQUAL to the store's STOCK_PREP_AUDIT_ACTIONS (a drift
//     between the two would make a valid store action violate the DB CHECK — op-then-500);
//   - required columns / tenant scoping / integration_ prefix / no forbidden value-bearing columns;
//   - forward migration never drops.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { STOCK_PREP_AUDIT_ACTIONS, AUDIT_TABLE } = require(path.join(__dirname, '..', 'lib', 'stock-preparation-audit-store.cjs'))

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const migrationPath = path.join(repoRoot, 'packages', 'core-backend', 'migrations', '066_create_integration_stock_prep_audit.sql')
const rawSql = fs.readFileSync(migrationPath, 'utf8')
const vocabularyMigrationPath = path.join(repoRoot, 'packages', 'core-backend', 'migrations', '067_extend_stock_prep_audit_repair_action.sql')
const rawVocabularySql = fs.readFileSync(vocabularyMigrationPath, 'utf8')
// Strip full-line SQL comments BEFORE matching so an assertion can never be satisfied by
// commented-out DDL.
const sql = rawSql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')
const vocabularySql = rawVocabularySql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')

assert.doesNotMatch(sql, /\bDROP\s+TABLE\b/i, 'forward migration must not drop tables')
assert.doesNotMatch(vocabularySql, /\bDROP\s+TABLE\b/i, 'vocabulary migration must not drop tables')
assert.ok(AUDIT_TABLE.startsWith('integration_'), 'audit table keeps the integration_ prefix')

const blockMatch = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${AUDIT_TABLE} \\(([\\s\\S]*?)\\n\\);`, 'm'))
assert.ok(blockMatch, `expected CREATE TABLE IF NOT EXISTS block for ${AUDIT_TABLE}`)
const block = blockMatch[1]

for (const column of ['id', 'tenant_id', 'workspace_id', 'project_id', 'action', 'subject_id', 'mode', 'actor', 'detail', 'created_at']) {
  assert.ok(new RegExp(`(^|\\n)\\s*${column}\\s`).test(block), `audit table must declare ${column}`)
}
assert.match(block, /tenant_id\s+TEXT NOT NULL/, 'tenant_id is required')
assert.match(block, /detail\s+JSONB NOT NULL DEFAULT '\{\}'::jsonb/, 'detail is values-free JSONB with an empty default')

// The effective CHECK vocabulary after 067 is SET-EQUAL to the store constant.
assert.match(
  vocabularySql,
  /DROP CONSTRAINT IF EXISTS integration_stock_prep_audit_action_check/,
  '067 replaces the original inline action check',
)
const checkMatch = vocabularySql.match(/ADD CONSTRAINT integration_stock_prep_audit_action_check CHECK \(action IN \(([\s\S]*?)\)\)/)
assert.ok(checkMatch, '067 installs the expanded closed CHECK vocabulary')
const checkActions = [...checkMatch[1].matchAll(/'([a-z_]+)'/g)].map((entry) => entry[1]).sort()
assert.deepEqual(checkActions, [...STOCK_PREP_AUDIT_ACTIONS].sort(), 'CHECK vocabulary must stay set-equal to STOCK_PREP_AUDIT_ACTIONS')

// No value-bearing business columns may ever exist on the audit table.
for (const forbidden of ['drawing', 'quantity', 'qty', 'unit_symbol', 'message', 'credential', 'token', 'password', 'host', 'base_url']) {
  assert.ok(!block.includes(forbidden), `audit table must not declare a ${forbidden} column`)
}

// Tenant-scoped indexes exist.
assert.match(sql, new RegExp(`CREATE INDEX IF NOT EXISTS \\S+\\s+ON ${AUDIT_TABLE} \\(tenant_id, created_at DESC\\)`), 'tenant+time index exists')
assert.match(sql, new RegExp(`CREATE INDEX IF NOT EXISTS \\S+\\s+ON ${AUDIT_TABLE} \\(tenant_id, action, created_at DESC\\)`), 'tenant+action index exists')

console.log('✓ stock-preparation-audit-migration')
