'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const migrationPath = path.join(
  repoRoot,
  'packages',
  'core-backend',
  'migrations',
  '070_create_integration_sealed_export_signer_authority.sql',
)
const authorityMigrationPath = path.join(
  repoRoot,
  'packages',
  'core-backend',
  'migrations',
  '069_create_integration_sealed_export_generation_kernel.sql',
)
const lifecycleGuardMigrationPath = path.join(
  repoRoot,
  'packages',
  'core-backend',
  'migrations',
  '071_harden_integration_sealed_export_authority_lifecycle.sql',
)
const terminalHistoryMigrationPath = path.join(
  repoRoot,
  'packages',
  'core-backend',
  'migrations',
  '072_harden_integration_sealed_export_terminal_signer_history.sql',
)
const rawSql = fs.readFileSync(migrationPath, 'utf8')
const sql = rawSql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')
const authoritySql = fs
  .readFileSync(authorityMigrationPath, 'utf8')
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')
const lifecycleGuardSql = fs
  .readFileSync(lifecycleGuardMigrationPath, 'utf8')
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')
const terminalHistorySql = fs
  .readFileSync(terminalHistoryMigrationPath, 'utf8')
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')

function tableBlock(source, table) {
  const match = source.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`, 'm'),
  )
  assert.ok(match, `expected live CREATE TABLE block for ${table}`)
  return match[1]
}

assert.doesNotMatch(sql, /\bDROP\s+TABLE\b/i, 'forward migration must not drop tables')
assert.match(
  sql,
  /CREATE TABLE IF NOT EXISTS integration_sealed_export_signer_public_keys/,
  'S5 adds a dedicated public-key material table',
)

const keys = tableBlock(sql, 'integration_sealed_export_signer_public_keys')
for (const column of [
  'tenant_id',
  'workspace_id',
  'workspace_scope_key',
  'tenant_domain_binding',
  'system_content_key',
  'role_binding_fingerprint',
  'signer_key_id',
  'signature_algorithm',
  'public_key_spki_der',
  'public_key_spki_sha256',
  'enrolled_at',
  'updated_at',
]) {
  assert.ok(
    new RegExp(`(^|\\n)\\s*${column}\\s`).test(keys),
    `signer public key column ${column}`,
  )
}

// Lifecycle must NOT live on 070.
assert.doesNotMatch(keys, /(^|\n)\s*status\s/)
assert.doesNotMatch(keys, /(^|\n)\s*expires_at\s/)
assert.doesNotMatch(sql, /signer_status/)
assert.doesNotMatch(sql, /ACTIVE.*EXPIRED.*REVOKED/)

assert.match(
  keys,
  /signature_algorithm = 'ED25519'/,
  'only ED25519 public verification material is admitted',
)
assert.match(
  keys,
  /tenant_domain_binding\s+TEXT NOT NULL/,
  'public keys share 069 authority scope coordinates',
)
assert.match(
  keys,
  /role_binding_fingerprint\s+TEXT NOT NULL/,
  'public keys share 069 authority scope coordinates',
)
assert.match(
  keys,
  /signer_key_id = public_key_spki_sha256/,
  'key id is digest-bound to the stored public SPKI bytes',
)
assert.match(
  keys,
  /public_key_spki_der\s+BYTEA NOT NULL/,
  'public SPKI DER is durable',
)

// 069 remains the single lifecycle authority.
const authority = tableBlock(
  authoritySql,
  'integration_sealed_export_authority_state',
)
assert.match(authority, /signer_key_id\s+TEXT NOT NULL/)
assert.match(
  authority,
  /signer_status\s+TEXT NOT NULL CHECK \(\s*signer_status IN \('ACTIVE', 'EXPIRED', 'REVOKED'\)/,
)
assert.match(authority, /signer_expires_at\s+TIMESTAMPTZ NOT NULL/)

assert.doesNotMatch(
  sql,
  /ALTER TABLE integration_sealed_export_authority_state/,
  'S5 does not mutate migration 069 authority_state',
)

assert.doesNotMatch(
  lifecycleGuardSql,
  /\bCREATE\s+TABLE\b/i,
  '071 hardens the existing lifecycle authority without creating a second one',
)
assert.match(
  lifecycleGuardSql,
  /CREATE OR REPLACE FUNCTION integration_sealed_export_authority_state_guard\(\)/,
  '071 defines the lifecycle transition guard',
)
assert.match(
  lifecycleGuardSql,
  /NEW\.signer_key_id = OLD\.signer_key_id[\s\S]*?OLD\.signer_status IN \('EXPIRED', 'REVOKED'\)[\s\S]*?NEW\.signer_status IS DISTINCT FROM OLD\.signer_status/,
  'a terminal signer key cannot change lifecycle state in place',
)
assert.match(
  lifecycleGuardSql,
  /CREATE TRIGGER trg_integration_sealed_export_authority_state_guard[\s\S]*?BEFORE UPDATE ON integration_sealed_export_authority_state[\s\S]*?EXECUTE FUNCTION integration_sealed_export_authority_state_guard\(\)/,
  'the guard is wired to the live 069 authority table',
)

assert.match(
  terminalHistorySql,
  /CREATE TABLE IF NOT EXISTS integration_sealed_export_terminal_signer_keys/,
  '072 persists terminal signer history independently of the current authority row',
)
assert.match(
  terminalHistorySql,
  /PRIMARY KEY \(\s*tenant_id,\s*workspace_scope_key,\s*tenant_domain_binding,\s*system_content_key,\s*role_binding_fingerprint,\s*signer_key_id\s*\)/,
  'terminal signer history is exact-scope and key bound',
)
assert.match(
  terminalHistorySql,
  /NEW\.signer_status = 'ACTIVE'[\s\S]*?integration_sealed_export_terminal_signer_keys[\s\S]*?terminal\.signer_key_id = NEW\.signer_key_id/,
  'an ACTIVE key is checked against durable terminal history',
)
assert.match(
  terminalHistorySql,
  /BEFORE INSERT OR UPDATE OR DELETE ON integration_sealed_export_authority_state/,
  'rotate-back, delete-reinsert, and direct insert all cross the lifecycle guard',
)
assert.match(
  terminalHistorySql,
  /BEFORE UPDATE OR DELETE ON integration_sealed_export_terminal_signer_keys/,
  'terminal signer history is append-only for first-party DML',
)

for (const forbidden of [
  'private_key',
  'privatekey',
  'signing_key',
  'signingkey',
  'secret',
  'password',
  'credential',
  'pem',
]) {
  assert.ok(
    !sql.toLowerCase().includes(forbidden),
    `migration must not persist ${forbidden}`,
  )
}

console.log('sealed-export-s5-signer-authority-migration.test.cjs OK')
