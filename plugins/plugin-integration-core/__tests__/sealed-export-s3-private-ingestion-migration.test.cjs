'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const migrationPath = path.join(
  repoRoot,
  'packages',
  'core-backend',
  'migrations',
  '068_create_integration_sealed_export_ingestion.sql',
)
const rawSql = fs.readFileSync(migrationPath, 'utf8')
const realDbSuite = 'tests/integration/sealed-export-s3-private-ingestion-realdb.test.ts'
const sql = rawSql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')

function tableBlock(table) {
  const match = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`, 'm'))
  assert.ok(match, `expected live CREATE TABLE block for ${table}`)
  return match[1]
}

assert.doesNotMatch(sql, /\bDROP\s+TABLE\b/i, 'forward migration must not drop tables')

const sessions = tableBlock('integration_sealed_export_ingestion_sessions')
for (const column of [
  'session_id',
  'tenant_id',
  'workspace_id',
  'workspace_scope_key',
  'tenant_domain_binding',
  'system_content_key',
  'role_binding_fingerprint',
  'manifest_digest',
  'export_request_envelope',
  'manifest',
  'status',
  'expected_chunk_count',
  'accepted_chunk_count',
  'pending_chunk_index',
  'pending_chunk_digest',
  'pending_byte_count',
  'pending_write_token',
  'expires_at',
  'completed_at',
]) {
  assert.ok(new RegExp(`(^|\\n)\\s*${column}\\s`).test(sessions), `session column ${column}`)
}
assert.match(
  sessions,
  /status\s+TEXT NOT NULL CHECK \(\s*status IN \('UPLOADING', 'CHUNK_WRITING', 'UPLOAD_COMPLETE', 'CLEANING'\)\s*\)/,
  'S3 persists the upload lifecycle and its write-cleanup fence',
)
assert.match(
  sessions,
  /status = 'CHUNK_WRITING'[\s\S]*?pending_chunk_index = accepted_chunk_count[\s\S]*?status <> 'CHUNK_WRITING'[\s\S]*?pending_write_token IS NULL/,
  'pending write metadata exists exactly while the durable write fence is held',
)
assert.match(
  sessions,
  /status = 'UPLOAD_COMPLETE'[\s\S]*?completed_at IS NOT NULL[\s\S]*?accepted_chunk_count = expected_chunk_count/,
  'completed status requires the complete manifest receipt count and timestamp',
)
assert.match(
  sessions,
  /export_request_envelope\s+JSONB NOT NULL/,
  'the original server envelope survives restart',
)
assert.match(sessions, /manifest\s+JSONB NOT NULL/, 'validated manifest survives restart')
assert.match(
  sessions,
  /CHECK \(accepted_chunk_count <= expected_chunk_count\)/,
  'accepted count cannot exceed the manifest chunk count',
)
assert.match(
  sessions,
  /workspace_scope_key\s+TEXT GENERATED ALWAYS AS \(COALESCE\(workspace_id, ''\)\) STORED/,
  'nullable workspace identity has a stable composite-FK key',
)
assert.match(
  sessions,
  /CONSTRAINT uq_integration_sealed_export_ingestion_session_scope[\s\S]*?UNIQUE \([\s\S]*?session_id,[\s\S]*?tenant_id,[\s\S]*?workspace_scope_key,[\s\S]*?tenant_domain_binding,[\s\S]*?system_content_key,[\s\S]*?role_binding_fingerprint,[\s\S]*?manifest_digest/,
  'session exposes one complete parent key for scoped receipts',
)
assert.match(
  sql,
  /CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_sealed_export_ingestion_identity[\s\S]*?tenant_id,[\s\S]*?COALESCE\(workspace_id, ''\),[\s\S]*?tenant_domain_binding,[\s\S]*?system_content_key,[\s\S]*?role_binding_fingerprint,[\s\S]*?manifest_digest/,
  'one authoritative session is backed by the complete binding identity',
)

const receipts = tableBlock('integration_sealed_export_ingestion_receipts')
for (const column of [
  'session_id',
  'tenant_id',
  'workspace_id',
  'workspace_scope_key',
  'tenant_domain_binding',
  'system_content_key',
  'role_binding_fingerprint',
  'manifest_digest',
  'chunk_index',
  'chunk_digest',
  'byte_count',
  'accepted_at',
]) {
  assert.ok(new RegExp(`(^|\\n)\\s*${column}\\s`).test(receipts), `receipt column ${column}`)
}
assert.match(
  receipts,
  /PRIMARY KEY \(session_id, chunk_index\)/,
  'one durable receipt per manifest index',
)
assert.match(
  receipts,
  /CONSTRAINT fk_integration_sealed_export_ingestion_receipt_scope[\s\S]*?FOREIGN KEY \([\s\S]*?session_id,[\s\S]*?tenant_id,[\s\S]*?workspace_scope_key,[\s\S]*?tenant_domain_binding,[\s\S]*?system_content_key,[\s\S]*?role_binding_fingerprint,[\s\S]*?manifest_digest[\s\S]*?REFERENCES integration_sealed_export_ingestion_sessions \([\s\S]*?ON DELETE CASCADE/,
  'receipt ownership and every copied scope anchor are bound to one session',
)

const tombstones = tableBlock('integration_sealed_export_ingestion_tombstones')
for (const column of [
  'session_id',
  'tenant_id',
  'workspace_id',
  'tenant_domain_binding',
  'system_content_key',
  'role_binding_fingerprint',
  'manifest_digest',
  'cleanup_reason',
  'cleaned_at',
]) {
  assert.ok(new RegExp(`(^|\\n)\\s*${column}\\s`).test(tombstones), `tombstone column ${column}`)
}
assert.match(
  tombstones,
  /cleanup_reason\s+TEXT NOT NULL CHECK \(cleanup_reason IN \('COMPLETED', 'EXPIRED'\)\)/,
  'cleanup reason is a closed values-free vocabulary',
)

for (const forbidden of [
  'credential',
  'password',
  'endpoint',
  'query_text',
  'source_row',
  'artifact_path',
  'chunk_bytes',
]) {
  assert.ok(!sql.toLowerCase().includes(forbidden), `migration must not persist ${forbidden}`)
}

assert.match(
  sql,
  /CREATE TRIGGER trg_integration_sealed_export_ingestion_sessions_updated_at\s*\n\s*BEFORE UPDATE ON integration_sealed_export_ingestion_sessions\s*\n\s*FOR EACH ROW EXECUTE FUNCTION integration_set_updated_at\(\);/,
  'session updated_at trigger is live',
)
assert.match(
  sql,
  /tgname = 'trg_integration_sealed_export_ingestion_sessions_updated_at'\s*\n\s*AND tgrelid = 'integration_sealed_export_ingestion_sessions'::regclass/,
  'updated_at trigger existence is relation-scoped rather than database-global',
)
assert.match(
  sql,
  /CREATE OR REPLACE FUNCTION integration_sealed_export_ingestion_session_anchors_immutable\(\)[\s\S]*?NEW\.manifest_digest,[\s\S]*?NEW\.export_request_envelope,[\s\S]*?NEW\.manifest,[\s\S]*?NEW\.expected_chunk_count,[\s\S]*?NEW\.expires_at[\s\S]*?ERRCODE = '55000'/,
  'signed identity, scope, count and retention deadline are immutable in PostgreSQL',
)
assert.match(
  sql,
  /tgname = 'trg_integration_sealed_export_ingestion_sessions_anchors_immutable'\s*\n\s*AND tgrelid = 'integration_sealed_export_ingestion_sessions'::regclass[\s\S]*?CREATE TRIGGER trg_integration_sealed_export_ingestion_sessions_anchors_immutable/,
  'immutable-anchor trigger existence is relation-scoped and live',
)

async function assertRealDbProofWiring() {
  const vitestConfig = fs.readFileSync(
    path.join(repoRoot, 'packages', 'core-backend', 'vitest.config.ts'),
    'utf8',
  )
  const contractUrl = pathToFileURL(
    path.join(repoRoot, 'scripts', 'ops', 'ci-realdb-step-contract.mjs'),
  ).href
  const {
    isQuotedInTestExclude,
    isSuiteWiredInRealDbStep,
  } = await import(contractUrl)
  assert.ok(
    isQuotedInTestExclude(vitestConfig, realDbSuite),
    `vitest.config.ts must structurally exclude ${realDbSuite} from the no-DB job`,
  )

  const workflow = fs.readFileSync(
    path.join(repoRoot, '.github', 'workflows', 'plugin-tests.yml'),
    'utf8',
  )
  assert.ok(
    isSuiteWiredInRealDbStep(
      workflow,
      'sealed-export-s3-real-db',
      realDbSuite,
    ),
    'the stable S3 step must run the whole real-DB suite on Node 20 with a literal DATABASE_URL',
  )
  assert.ok(
    fs.existsSync(path.join(repoRoot, 'packages', 'core-backend', realDbSuite)),
    `wired suite packages/core-backend/${realDbSuite} must exist`,
  )
}

assertRealDbProofWiring().then(
  () => console.log('sealed-export-s3-private-ingestion-migration.test.cjs OK'),
  (error) => {
    console.error(error)
    process.exitCode = 1
  },
)
