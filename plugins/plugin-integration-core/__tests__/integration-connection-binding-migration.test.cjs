'use strict'

// PR-1 Connection / Binding schema — text assertions on the zzzz Kysely migration.
// Style of read-source-config-migration.test.cjs: strip comments first so a commented-out CHECK
// or FK cannot satisfy the contract. Assertions inspect up() only; down() may drop IF EXISTS.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const migrationName = 'zzzz20260902120000_add_integration_connection_binding.ts'
const migrationPath = path.join(
  repoRoot,
  'packages',
  'core-backend',
  'src',
  'db',
  'migrations',
  migrationName,
)
const legacyNumericPath = path.join(
  repoRoot,
  'packages',
  'core-backend',
  'migrations',
  '082_add_integration_connection_binding.sql',
)

assert.equal(path.basename(migrationPath), migrationName, 'PR-1 schema lives in the zzzz Kysely stream')
assert.ok(fs.existsSync(migrationPath), 'zzzz connection-binding migration must exist')
assert.equal(
  fs.existsSync(legacyNumericPath),
  false,
  'numeric 082 must not exist; it sorts before 20251206000001_create_data_sources_table',
)

const migrationKey = path.basename(migrationName, '.ts')
assert.ok(
  migrationKey > '20251206000001_create_data_sources_table',
  'migration name must sort after the Kysely data_sources create',
)
assert.ok(
  migrationKey > '057_create_integration_core_tables',
  'migration name must sort after integration_external_systems create',
)

const rawSource = fs.readFileSync(migrationPath, 'utf8')

function stripComments(source) {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      if (!trimmed) return false
      if (trimmed.startsWith('//') || trimmed.startsWith('--')) return false
      if (trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed === '*/') return false
      return true
    })
    .join('\n')
}

function exportedFunction(source, name) {
  const start = source.indexOf(`export async function ${name}`)
  assert.ok(start >= 0, `expected export async function ${name}`)
  const otherStart = name === 'up'
    ? source.indexOf('export async function down', start + 1)
    : source.indexOf('export async function up', start + 1)
  const end = otherStart > start ? otherStart : source.length
  return stripComments(source.slice(start, end))
}

const up = exportedFunction(rawSource, 'up')
const down = exportedFunction(rawSource, 'down')

function firstIndex(source, pattern, label) {
  const match = source.match(pattern)
  assert.ok(match && match.index >= 0, label)
  return match.index
}

// --- destructive DDL is forbidden in up() -----------------------------------
assert.doesNotMatch(up, /\bDROP\s+TABLE\b/i, 'forward migration must not drop tables')
assert.doesNotMatch(up, /\bDROP\s+COLUMN\b/i, 'forward migration must not drop columns')
assert.doesNotMatch(up, /\bDROP\s+INDEX\b/i, 'forward migration must not drop indexes')
assert.doesNotMatch(up, /\bDROP\s+CONSTRAINT\b/i, 'forward migration must not drop constraints')
assert.doesNotMatch(up, /\bTRUNCATE\b/i, 'forward migration must not truncate')
assert.doesNotMatch(up, /\bDELETE\s+FROM\b/i, 'forward migration must not delete rows')
assert.doesNotMatch(up, /\bCREATE\s+TABLE\b/i, 'up() must ALTER existing tables, not recreate them')
assert.doesNotMatch(up, /\bON\s+DELETE\s+CASCADE\b/i, 'connection FK must not cascade deletes')
assert.doesNotMatch(up, /\bON\s+DELETE\s+SET\s+NULL\b/i, 'connection FK must not rewrite bindings on delete')
assert.doesNotMatch(up, /\bCREATE\s+UNIQUE\s+INDEX\b/i, 'connection_id must not be unique; Bindings may share a Connection')
assert.doesNotMatch(
  up,
  /\b(?:created_at|updated_at)\s*[<>=]/i,
  'cutover evidence must not use a wall-clock constant',
)
assert.doesNotMatch(up, /\b(?:NOW|CURRENT_TIMESTAMP|CURRENT_DATE)\s*\(/i, 'cutover evidence must not use a clock')
assert.doesNotMatch(up, /2026-09-0[12]/, 'cutover evidence must not hard-code a cutover date')

for (const forbidden of ['password', 'credential', 'secret', 'token', 'api_key', 'base_url', 'host']) {
  assert.ok(!up.toLowerCase().includes(forbidden), `up() live DDL must not mention ${forbidden}`)
}

// --- data_sources.tenant_id (nullable, no default, no NOT NULL) -------------
assert.match(
  up,
  /ALTER TABLE data_sources\s+ADD COLUMN IF NOT EXISTS tenant_id TEXT,\s+ADD COLUMN IF NOT EXISTS scope_kind TEXT/,
  'data_sources gains tenant_id and scope_kind idempotently, both added as nullable TEXT',
)
assert.doesNotMatch(up, /tenant_id\s+TEXT\s+NOT NULL/, 'tenant_id stays nullable for unproven legacy rows')
assert.doesNotMatch(up, /tenant_id\s+TEXT\s+DEFAULT/, 'tenant_id has no default; it is not derived from workspace_id')

// --- scope_kind: existing = legacy_private, future default = private, closed set
assert.doesNotMatch(
  up,
  /ADD COLUMN IF NOT EXISTS scope_kind\s+TEXT[^\n`]*DEFAULT\s+'private'/,
  'ADD COLUMN must not default existing rows to private',
)
assert.match(
  up,
  /UPDATE data_sources\s+SET\s+scope_kind = 'legacy_private'\s+WHERE scope_kind IS NULL/,
  'pre-existing NULL scope rows backfill to legacy_private only',
)
assert.doesNotMatch(up, /SET\s+scope_kind = 'private'/, 'backfill must not assign private to existing rows')
assert.match(
  up,
  /ALTER TABLE data_sources\s+ALTER COLUMN scope_kind SET DEFAULT 'private'/,
  'future inserts default to private',
)
assert.doesNotMatch(up, /SET DEFAULT 'legacy_private'/, 'future default must not stay legacy_private')
assert.match(
  up,
  /ALTER TABLE data_sources\s+ALTER COLUMN scope_kind SET NOT NULL/,
  'closed scope_kind set is NOT NULL after backfill',
)

const addScopeIdx = firstIndex(up, /ADD COLUMN IF NOT EXISTS scope_kind\s+TEXT/, 'scope_kind column is added')
const backfillIdx = firstIndex(
  up,
  /UPDATE data_sources\s+SET\s+scope_kind = 'legacy_private'\s+WHERE scope_kind IS NULL/,
  'legacy_private backfill exists',
)
const defaultIdx = firstIndex(up, /ALTER COLUMN scope_kind SET DEFAULT 'private'/, 'private default exists')
const notNullIdx = firstIndex(up, /ALTER COLUMN scope_kind SET NOT NULL/, 'scope_kind SET NOT NULL exists')
assert.ok(backfillIdx > addScopeIdx, 'backfill runs after the column exists')
assert.ok(defaultIdx > backfillIdx, 'private default is installed after the legacy backfill')
assert.ok(notNullIdx > backfillIdx, 'SET NOT NULL runs after NULL rows are backfilled')

assert.match(
  up,
  /conname = 'chk_data_sources_scope_kind'\s*\n\s*AND conrelid = 'data_sources'::regclass/,
  'scope_kind CHECK existence is relation-scoped rather than database-global',
)
const checkMatch = up.match(
  /ADD CONSTRAINT chk_data_sources_scope_kind\s+CHECK \(scope_kind IN \(([\s\S]*?)\)\)/,
)
assert.ok(checkMatch, 'named scope_kind CHECK is installed')
const checkValues = [...checkMatch[1].matchAll(/'([a-z_]+)'/g)].map((entry) => entry[1]).sort()
assert.deepEqual(
  checkValues,
  ['legacy_private', 'private', 'workspace'],
  'scope_kind CHECK is set-equal to legacy_private|private|workspace',
)

// --- integration_external_systems.connection_id + fallback flag --------------
assert.match(
  up,
  /ALTER TABLE integration_external_systems\s+ADD COLUMN IF NOT EXISTS connection_id TEXT,\s+ADD COLUMN IF NOT EXISTS legacy_connection_fallback_eligible BOOLEAN NOT NULL DEFAULT FALSE/,
  'connection_id is nullable TEXT; fallback flag is durable BOOLEAN NOT NULL DEFAULT FALSE',
)
assert.doesNotMatch(up, /connection_id\s+TEXT\s+NOT NULL/, 'connection_id stays nullable in the migration phase')
assert.doesNotMatch(
  up,
  /legacy_connection_fallback_eligible BOOLEAN NOT NULL DEFAULT TRUE/,
  'future rows must default FALSE, not TRUE',
)
assert.match(
  up,
  /UPDATE integration_external_systems\s+SET legacy_connection_fallback_eligible = FALSE\s+WHERE legacy_connection_fallback_eligible IS NULL/,
  'an interrupted earlier attempt cannot leave a nullable fallback marker',
)
assert.match(
  up,
  /ALTER TABLE integration_external_systems\s+ALTER COLUMN legacy_connection_fallback_eligible SET DEFAULT FALSE,\s+ALTER COLUMN legacy_connection_fallback_eligible SET NOT NULL/,
  'fallback marker invariant is completed even when the column already existed',
)

const connectionBackfill = up.match(
  /UPDATE integration_external_systems AS binding\s+SET\s+connection_id = ds\.id,\s+legacy_connection_fallback_eligible = TRUE\s+FROM data_sources AS ds\s+WHERE binding\.kind = 'data-source:sql-readonly'\s+AND binding\.connection_id IS NULL\s+AND binding\.legacy_connection_fallback_eligible IS NOT TRUE\s+AND ds\.id = NULLIF\(BTRIM\(binding\.config->>'dataSourceId'\), ''\)\s+AND NULLIF\(BTRIM\(binding\.config->>'dataSourceOwnerId'\), ''\) = ds\.owner_id/,
)
assert.ok(
  connectionBackfill,
  'TRUE is set only on owner-attributed data-source:sql-readonly rows actually joined to the matching data_sources.owner_id',
)
assert.match(
  up,
  /NULLIF\(BTRIM\(binding\.config->>'dataSourceOwnerId'\), ''\) = ds\.owner_id/,
  'canonical backfill requires a server-stamped owner id that matches data_sources.owner_id',
)
assert.equal(
  [...up.matchAll(/legacy_connection_fallback_eligible = TRUE/g)].length,
  1,
  'TRUE is assigned in exactly one backfill UPDATE',
)

assert.match(
  up,
  /conname = 'fk_integration_external_systems_connection_id'\s*\n\s*AND conrelid = 'integration_external_systems'::regclass/,
  'connection_id FK existence is relation-scoped rather than database-global',
)
assert.match(
  up,
  /ADD CONSTRAINT fk_integration_external_systems_connection_id\s+FOREIGN KEY \(connection_id\) REFERENCES data_sources\(id\) ON DELETE RESTRICT/,
  'connection_id references data_sources(id) ON DELETE RESTRICT',
)
assert.match(
  up,
  /CREATE INDEX IF NOT EXISTS idx_integration_external_systems_connection_id\s+ON integration_external_systems \(connection_id\)/,
  'non-unique lookup index exists on connection_id',
)

const foreignTableRefs = [...up.matchAll(/\bREFERENCES\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gi)].map((match) => match[1])
assert.deepEqual(foreignTableRefs, ['data_sources'], 'the only FK target is data_sources')

const upAlterTables = [...up.matchAll(/\bALTER TABLE\s+([a-zA-Z_][a-zA-Z0-9_]*)\b/gi)].map((match) => match[1])
assert.deepEqual(
  [...new Set(upAlterTables)].sort(),
  ['data_sources', 'integration_external_systems'],
  'up() only ALTERs data_sources and integration_external_systems',
)

assert.match(down, /\bDROP COLUMN IF EXISTS\b/i, 'down() uses IF EXISTS column drops')
assert.match(down, /\bDROP CONSTRAINT IF EXISTS\b/i, 'down() uses IF EXISTS constraint drops')
assert.doesNotMatch(down, /\bDROP TABLE\b/i, 'down() must not drop tables')
assert.doesNotMatch(down, /\bDELETE\s+FROM\b/i, 'down() must not delete rows')
assert.doesNotMatch(down, /\bTRUNCATE\b/i, 'down() must not truncate')

console.log('integration-connection-binding-migration.test.cjs OK')
