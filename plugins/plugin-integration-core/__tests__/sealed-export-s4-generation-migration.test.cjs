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
  '069_create_integration_sealed_export_generation_kernel.sql',
)
const realDbSuite = 'tests/integration/sealed-export-s4-generation-kernel-realdb.test.ts'
const rawSql = fs.readFileSync(migrationPath, 'utf8')
const sql = rawSql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')

function tableBlock(table) {
  const match = sql.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`, 'm'),
  )
  assert.ok(match, `expected live CREATE TABLE block for ${table}`)
  return match[1]
}

assert.doesNotMatch(sql, /\bDROP\s+TABLE\b/i, 'forward migration must not drop tables')
assert.match(
  sql,
  /ALTER TABLE integration_sealed_export_ingestion_sessions[\s\S]*?ADD COLUMN IF NOT EXISTS generation_claim_id TEXT,[\s\S]*?ADD COLUMN IF NOT EXISTS generation_claimed_at TIMESTAMPTZ/,
  'S4 adds one durable generation claim to completed S3 sessions',
)
assert.match(
  sql,
  /generation_claim_id IS NOT NULL[\s\S]*?generation_claimed_at IS NOT NULL[\s\S]*?status = 'UPLOAD_COMPLETE'/,
  'only a complete upload can be claimed by the generation kernel',
)

const generations = tableBlock('integration_sealed_export_generations')
for (const column of [
  'generation_id',
  'session_id',
  'tenant_id',
  'workspace_id',
  'workspace_scope_key',
  'tenant_domain_binding',
  'system_content_key',
  'role_binding_fingerprint',
  'manifest_digest',
  'signer_key_id',
  'qualification_digest',
  'canonical_object_version',
  'approved_config_version_id',
  'config_content_key',
  'status',
  'manifest_row_count',
  'manifest_byte_count',
  'manifest_chunk_count',
  'manifest_artifact_digest',
  'manifest_rowset_digest',
  'manifest_chunk_set_digest',
  'staged_row_count',
  'sealed_row_count',
  'sealed_artifact_digest',
  'sealed_rowset_digest',
  'sealed_receipt_set_digest',
  'applied_row_count',
  'applied_rowset_digest',
  'lease_token',
  'lease_fence',
  'lease_expires_at',
]) {
  assert.ok(new RegExp(`(^|\\n)\\s*${column}\\s`).test(generations), `generation column ${column}`)
}
assert.match(
  generations,
  /status IN \('STAGING', 'SEALED', 'APPLYING', 'VERIFIED', 'ACTIVE', 'QUARANTINED'\)/,
  'the persisted S4 lifecycle is closed',
)
assert.match(
  generations,
  /lease_token IS NOT NULL[\s\S]*?lease_expires_at IS NOT NULL[\s\S]*?lease_fence > 0[\s\S]*?status IN \('STAGING', 'APPLYING'\)/,
  'a persisted lease is fenced and exists only in write phases',
)
assert.match(
  generations,
  /status NOT IN \('VERIFIED', 'ACTIVE'\)[\s\S]*?applied_row_count = sealed_row_count[\s\S]*?applied_rowset_digest = sealed_rowset_digest/,
  'VERIFIED and ACTIVE require count and digest equality',
)
for (const equality of [
  'sealed_row_count = manifest_row_count',
  'sealed_byte_count = manifest_byte_count',
  'sealed_chunk_count = manifest_chunk_count',
  'sealed_artifact_digest = manifest_artifact_digest',
  'sealed_rowset_digest = manifest_rowset_digest',
  'sealed_receipt_set_digest = manifest_chunk_set_digest',
]) {
  assert.ok(
    generations.includes(equality),
    `sealed generation pins signed-manifest fact: ${equality}`,
  )
}
assert.match(
  generations,
  /CONSTRAINT uq_integration_sealed_export_generation_scope[\s\S]*?generation_id,[\s\S]*?tenant_id,[\s\S]*?workspace_scope_key,[\s\S]*?tenant_domain_binding,[\s\S]*?system_content_key,[\s\S]*?role_binding_fingerprint,[\s\S]*?manifest_digest/,
  'child rows bind to the complete generation authority',
)
assert.match(
  sql,
  /CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_sealed_export_generation_manifest[\s\S]*?tenant_id,[\s\S]*?COALESCE\(workspace_id, ''\),[\s\S]*?tenant_domain_binding,[\s\S]*?system_content_key,[\s\S]*?role_binding_fingerprint,[\s\S]*?manifest_digest/,
  'one manifest has one generation inside its full authority scope',
)

for (const table of [
  'integration_sealed_export_generation_staging_rows',
  'integration_sealed_export_generation_rows',
]) {
  const rows = tableBlock(table)
  assert.match(rows, /PRIMARY KEY \(generation_id, row_index\)/)
  assert.match(rows, /canonical_row_text\s+TEXT NOT NULL/)
  assert.match(rows, /row_sort_key\s+BYTEA NOT NULL/)
  assert.match(rows, /row_digest\s+TEXT NOT NULL/)
  assert.match(
    rows,
    /FOREIGN KEY \([\s\S]*?generation_id,[\s\S]*?tenant_id,[\s\S]*?workspace_scope_key,[\s\S]*?tenant_domain_binding,[\s\S]*?system_content_key,[\s\S]*?role_binding_fingerprint,[\s\S]*?manifest_digest[\s\S]*?REFERENCES integration_sealed_export_generations/,
    `${table} cannot drift from its generation scope`,
  )
}

const authority = tableBlock('integration_sealed_export_authority_state')
assert.match(
  authority,
  /signer_status\s+TEXT NOT NULL CHECK \(\s*signer_status IN \('ACTIVE', 'EXPIRED', 'REVOKED'\)/,
  'authority signer state is closed',
)
for (const column of [
  'binding_current',
  'binding_expires_at',
  'qualification_digest',
  'qualification_current',
  'qualification_expires_at',
]) {
  assert.ok(new RegExp(`(^|\\n)\\s*${column}\\s`).test(authority), `authority column ${column}`)
}

const pointers = tableBlock('integration_sealed_export_active_pointers')
assert.match(
  pointers,
  /active_generation_id IS NULL AND pointer_version = 0[\s\S]*?active_generation_id IS NOT NULL AND pointer_version > 0/,
  'the pointer is version zero before its first CAS and positive after activation',
)
assert.match(
  pointers,
  /FOREIGN KEY \([\s\S]*?active_generation_id,[\s\S]*?tenant_id,[\s\S]*?workspace_scope_key,[\s\S]*?tenant_domain_binding,[\s\S]*?system_content_key,[\s\S]*?role_binding_fingerprint,[\s\S]*?active_manifest_digest[\s\S]*?REFERENCES integration_sealed_export_generations/,
  'the visible pointer cannot cross generation authority',
)

const audit = tableBlock('integration_sealed_export_generation_audit')
assert.match(
  audit,
  /event_type IN \('SEALED', 'VERIFIED', 'ACTIVE', 'QUARANTINED'\)/,
  'audit terminal events are closed',
)
assert.match(
  audit,
  /event_type <> 'QUARANTINED'[\s\S]*?reason IS NULL[\s\S]*?event_type = 'QUARANTINED'[\s\S]*?reason IN \(/,
  'only quarantines carry a closed failure reason',
)
assert.match(
  audit,
  /external_write\s+BOOLEAN NOT NULL DEFAULT FALSE CHECK \(external_write = FALSE\)/,
  'S4 records no external write',
)

assert.match(
  sql,
  /OLD\.status = 'STAGING' AND NEW\.status IN \('SEALED', 'QUARANTINED'\)[\s\S]*?OLD\.status = 'SEALED' AND NEW\.status IN \('APPLYING', 'QUARANTINED'\)[\s\S]*?OLD\.status = 'APPLYING' AND NEW\.status IN \('VERIFIED', 'QUARANTINED'\)[\s\S]*?OLD\.status = 'VERIFIED' AND NEW\.status IN \('ACTIVE', 'QUARANTINED'\)/,
  'database transition guard permits only the ratified S4 progression and quarantine',
)
assert.match(
  sql,
  /NEW\.lease_fence < OLD\.lease_fence[\s\S]*?ERRCODE = '55000'/,
  'database fence never decreases',
)
assert.match(
  sql,
  /OLD\.lease_token IS NOT NULL[\s\S]*?NEW\.lease_fence = OLD\.lease_fence[\s\S]*?clock_timestamp\(\) >= OLD\.lease_expires_at[\s\S]*?ERRCODE = '55000'/,
  'an expired lease cannot perform a final write without acquiring a new fence',
)
assert.match(
  sql,
  /NEW\.pointer_version <> OLD\.pointer_version \+ 1[\s\S]*?ERRCODE = '55000'/,
  'every pointer update is one CAS version',
)
assert.match(
  sql,
  /BEFORE UPDATE OR DELETE ON integration_sealed_export_generation_audit/,
  'audit records are immutable',
)
assert.match(
  sql,
  /TG_OP = 'INSERT'[\s\S]*?status = 'APPLYING'[\s\S]*?lease_token IS NOT NULL[\s\S]*?lease_fence = NEW\.apply_fence[\s\S]*?clock_timestamp\(\) < lease_expires_at/,
  'applied rows can only be inserted by the current unexpired apply fence',
)
assert.match(
  sql,
  /BEFORE INSERT OR UPDATE OR DELETE ON integration_sealed_export_generation_rows[\s\S]*?integration_sealed_export_generation_rows_guard/,
  'applied rows are immutable after their leased insert',
)

for (const forbidden of [
  'password',
  'private_key',
  'credential',
  'endpoint',
  'query_text',
  'source_column',
  'external_write = TRUE',
]) {
  assert.ok(!sql.toLowerCase().includes(forbidden.toLowerCase()), `migration excludes ${forbidden}`)
}

async function assertRealDbProofWiring() {
  const packageJson = JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, 'plugins', 'plugin-integration-core', 'package.json'),
      'utf8',
    ),
  )
  const s4Commands = [
    'node __tests__/sealed-export-s4-generation-kernel.test.cjs',
    'node __tests__/sealed-export-s4-generation-migration.test.cjs',
  ]
  const s5Commands = [
    'node __tests__/sealed-export-sqlserver-sealed-snapshot-profile.test.cjs',
    'node __tests__/sealed-export-s5-public-export-surface.test.cjs',
    'node __tests__/sealed-export-binding-qualification.test.cjs',
    'node __tests__/sealed-export-signer-authority.test.cjs',
    'node __tests__/sealed-export-signer-authority-store.test.cjs',
    'node __tests__/sealed-export-s5-signer-authority-migration.test.cjs',
    'node __tests__/sealed-export-sqlserver-sealed-snapshot-action.test.cjs',
    'node __tests__/sealed-export-package-provenance.test.cjs',
    'node __tests__/sealed-export-s5-evidence.test.cjs',
    'node __tests__/sealed-export-s5-ci-wiring.test.cjs',
    'node __tests__/sealed-export-s5-product-to-s3-s4-integration.test.cjs',
  ]
  const s6Commands = [
    'node __tests__/stock-preparation-sealed-snapshot-decoder.test.cjs',
    'node __tests__/sealed-export-s6a-lifecycle-provisioning.test.cjs',
    'node __tests__/sealed-export-s6a-initial-provisioning.test.cjs',
    'node __tests__/sealed-export-s6a-runtime-authority-migration.test.cjs',
    'node __tests__/sealed-export-s6a-runtime-store.test.cjs',
    'node __tests__/sealed-export-s6a-source-authority.test.cjs',
    'node __tests__/sealed-export-s6a-runtime-config.test.cjs',
    'node __tests__/sealed-export-s6a-runtime-persist.test.cjs',
    'node __tests__/sealed-export-s6a-runtime-core.test.cjs',
    'node __tests__/sealed-export-s6a-product-runtime.test.cjs',
  ]
  const chain = packageJson.scripts.test.split(' && ')
  // S4 remains contiguous; the S5 and S6-A suites follow it exactly once.
  assert.deepEqual(
    chain.slice(-(s4Commands.length + s5Commands.length + s6Commands.length)),
    [...s4Commands, ...s5Commands, ...s6Commands],
    'the explicit plugin test chain must execute S4, S5, then S6-A',
  )
  for (const command of [...s4Commands, ...s5Commands, ...s6Commands]) {
    assert.equal(
      chain.filter((entry) => entry === command).length,
      1,
      `${command} must occur exactly once in the explicit test chain`,
    )
  }

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
    `vitest.config.ts must exclude ${realDbSuite} from no-DB jobs`,
  )

  const workflow = fs.readFileSync(
    path.join(repoRoot, '.github', 'workflows', 'plugin-tests.yml'),
    'utf8',
  )
  assert.ok(
    isSuiteWiredInRealDbStep(
      workflow,
      'sealed-export-s4-real-db',
      realDbSuite,
    ),
    'the stable S4 step must run the exact real-DB suite',
  )
  assert.ok(
    fs.existsSync(path.join(repoRoot, 'packages', 'core-backend', realDbSuite)),
    `wired suite packages/core-backend/${realDbSuite} must exist`,
  )
}

assertRealDbProofWiring().then(
  () => console.log('sealed-export-s4-generation-migration.test.cjs OK'),
  (error) => {
    console.error(error)
    process.exitCode = 1
  },
)
