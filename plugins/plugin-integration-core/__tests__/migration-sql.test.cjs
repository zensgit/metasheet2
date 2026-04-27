'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const migrationPath = path.join(repoRoot, 'packages', 'core-backend', 'migrations', '057_create_integration_core_tables.sql')
const runningUniqueMigrationPath = path.join(repoRoot, 'packages', 'core-backend', 'migrations', '058_integration_runs_running_unique.sql')
const runHistoryIndexMigrationPath = path.join(repoRoot, 'packages', 'core-backend', 'migrations', '059_integration_runs_history_index.sql')
const sql = fs.readFileSync(migrationPath, 'utf8')
const runningUniqueSql = fs.readFileSync(runningUniqueMigrationPath, 'utf8')
const runHistoryIndexSql = fs.readFileSync(runHistoryIndexMigrationPath, 'utf8')

const expectedTables = [
  'integration_external_systems',
  'integration_pipelines',
  'integration_field_mappings',
  'integration_runs',
  'integration_watermarks',
  'integration_dead_letters',
  'integration_schedules',
]

const tablesWithUpdatedAtTriggers = [
  'integration_external_systems',
  'integration_pipelines',
  'integration_watermarks',
  'integration_dead_letters',
  'integration_schedules',
]

function tableBlock(table) {
  const match = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`, 'm'))
  assert.ok(match, `expected CREATE TABLE IF NOT EXISTS block for ${table}`)
  return match[1]
}

function hasSecondaryIndexOn(table) {
  return new RegExp(`CREATE (?:UNIQUE )?INDEX IF NOT EXISTS [\\s\\S]*?\\bON ${table}\\s*\\(`, 'm').test(sql)
}

function assertOnlyIntegrationTableRefs(kind, refs) {
  const disallowed = refs.filter((table) => !table.startsWith('integration_'))
  assert.deepEqual(disallowed, [], `${kind} only references integration_* tables`)
}

function main() {
  assert.ok(sql.includes('CREATE OR REPLACE FUNCTION integration_set_updated_at()'), 'updated_at trigger function exists')
  assert.doesNotMatch(sql, /\bDROP\s+TABLE\b/i, 'forward migration must not drop tables')

  for (const table of expectedTables) {
    const block = tableBlock(table)
    if (table === 'integration_watermarks') {
      assert.match(
        block,
        /\bpipeline_id\s+TEXT PRIMARY KEY REFERENCES integration_pipelines\(id\) ON DELETE CASCADE\b/,
        `${table} uses pipeline_id as primary key`,
      )
    } else {
      assert.match(block, /\bid\s+TEXT PRIMARY KEY\b/, `${table} has TEXT primary key id`)
    }
  }

  for (const table of expectedTables.filter((table) => table !== 'integration_watermarks')) {
    assert.ok(hasSecondaryIndexOn(table), `${table} has at least one secondary index`)
  }

  for (const table of tablesWithUpdatedAtTriggers) {
    assert.match(
      sql,
      new RegExp(`CREATE TRIGGER trg_${table}_updated_at[\\s\\S]*?BEFORE UPDATE ON ${table}[\\s\\S]*?EXECUTE FUNCTION integration_set_updated_at\\(\\);`, 'm'),
      `${table} updates updated_at through trigger`,
    )
  }

  for (const scopedTable of [
    'integration_external_systems',
    'integration_pipelines',
    'integration_runs',
    'integration_dead_letters',
  ]) {
    const block = tableBlock(scopedTable)
    assert.match(block, /\btenant_id\s+TEXT NOT NULL\b/, `${scopedTable} has tenant_id scope`)
    assert.match(block, /\bworkspace_id\s+TEXT\b/, `${scopedTable} has workspace_id scope`)
  }

  assert.match(
    sql,
    /CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_external_systems_scope_name\s+ON integration_external_systems \(tenant_id, COALESCE\(workspace_id, ''\), name\);/m,
    'external systems unique index treats NULL workspace_id deterministically',
  )
  assert.match(
    sql,
    /CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_pipelines_scope_name\s+ON integration_pipelines \(tenant_id, COALESCE\(workspace_id, ''\), name\);/m,
    'pipelines unique index treats NULL workspace_id deterministically',
  )
  assert.match(
    runningUniqueSql,
    /CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_runs_one_running_per_pipeline\s+ON integration_runs \(tenant_id, COALESCE\(workspace_id, ''\), pipeline_id\)\s+WHERE status = 'running';/m,
    'running-run unique index enforces one running row per tenant/workspace/pipeline',
  )
  assert.match(
    runningUniqueSql,
    /ROW_NUMBER\(\) OVER \(\s+PARTITION BY tenant_id, COALESCE\(workspace_id, ''\), pipeline_id[\s\S]*?WHERE status = 'running'/m,
    '058 migration closes duplicate running rows before creating unique index',
  )
  assert.doesNotMatch(runningUniqueSql, /\bDROP\s+(?:TABLE|INDEX)\b/i, '058 migration must not drop objects')
  assert.match(
    runHistoryIndexSql,
    /CREATE INDEX IF NOT EXISTS idx_integration_runs_scope_pipeline_status_created_at\s+ON integration_runs \(tenant_id, workspace_id, pipeline_id, status, created_at DESC\);/m,
    '059 migration adds run-history lookup index with workspace scope and created_at ordering',
  )
  assert.doesNotMatch(runHistoryIndexSql, /\bDROP\s+(?:TABLE|INDEX)\b/i, '059 migration must not drop objects')

  const ddlTableRefs = Array.from(sql.matchAll(/\b(?:CREATE|ALTER|DROP|TRUNCATE)\s+TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi))
    .map((match) => match[1])
    .filter((table) => table !== 'IF')
  assertOnlyIntegrationTableRefs('DDL', ddlTableRefs)

  const indexTableRefs = Array.from(sql.matchAll(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+[a-zA-Z_][a-zA-Z0-9_]*[\s\S]*?\bON\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gi))
    .map((match) => match[1])
  const runningUniqueIndexTableRefs = Array.from(runningUniqueSql.matchAll(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+[a-zA-Z_][a-zA-Z0-9_]*[\s\S]*?\bON\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gi))
    .map((match) => match[1])
  const runHistoryIndexTableRefs = Array.from(runHistoryIndexSql.matchAll(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+[a-zA-Z_][a-zA-Z0-9_]*[\s\S]*?\bON\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gi))
    .map((match) => match[1])
  assertOnlyIntegrationTableRefs('index', indexTableRefs.concat(runningUniqueIndexTableRefs, runHistoryIndexTableRefs))

  const foreignTableRefs = Array.from(sql.matchAll(/\bREFERENCES\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gi))
    .map((match) => match[1])
  assertOnlyIntegrationTableRefs('foreign key', foreignTableRefs)

  console.log('✓ migration-sql: 057/058/059 integration migration structure passed')
}

main()
