import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const SCRIPT = path.join(REPO_ROOT, 'scripts/ops/staging-migration-alignment-report.mjs')

const STAGING_LIST = `Applied: 86
Pending: 77

Pending migrations (in load order):
  - 008_plugin_infrastructure
  - 032_create_approval_records
  - 033_create_rbac_core
  - 034_create_spreadsheets
  - 035_create_files
  - 036_create_spreadsheet_permissions
  - 037_add_gallery_form_support
  - 038_config_and_secrets
  - 040_data_sources
  - 041_script_sandbox
  - 042_core_model_completion
  - 042a_core_model_views
  - 042b_external_data_model
  - 042c_audit_placeholder
  - 042d_audit_and_cache
  - 042d_plugins_and_templates
  - 043_core_model_views
  - 044_external_data_model
  - 045_audit_placeholder
  - 046_plugins_and_templates
  - 047_audit_and_cache
  - 047_create_event_bus_tables
  - 048_create_event_bus_tables
  - 049_create_bpmn_workflow_tables
  - 050_create_snapshot_core
  - 051_create_minimal_views
  - 052_recreate_minimal_views
  - 053_create_protection_rules
  - 054_create_users_table
  - 055_create_attendance_import_tokens
  - 056_add_users_must_change_password
  - 057_create_integration_core_tables
  - 058_integration_runs_running_unique
  - 059_integration_runs_history_index
  - 20250925_create_view_tables
  - 20250926_create_audit_tables
  - zzzz20260410100000_create_plugin_automation_rule_registry
  - zzzz20260410101500_create_plugin_field_policy_registry
  - zzzz20260411120000_approval_templates_and_instance_extensions
  - zzzz20260519070000_create_plugin_attendance_report_sync_jobs`

function run(args, input = '') {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    input,
    encoding: 'utf8',
  })
}

function makeTmp() {
  return mkdtempSync(path.join(tmpdir(), 'ms2-migration-alignment-'))
}

test('classifies staging pending migrations and blocks full migrate recommendation', () => {
  const tmp = makeTmp()
  try {
    const listFile = path.join(tmp, 'migrate-list.txt')
    const outDir = path.join(tmp, 'out')
    writeFileSync(listFile, STAGING_LIST)

    const result = run(['--migrate-list-file', listFile, '--out-dir', outDir])
    assert.equal(result.status, 0, result.stderr)

    const report = JSON.parse(readFileSync(path.join(outDir, 'report.json'), 'utf8'))
    assert.equal(report.applied, 86)
    assert.equal(report.pending, 77)
    assert.equal(report.categoryCounts.superseded_legacy_noop_marker, 29)
    assert.equal(report.categoryCounts.legacy_executable_sql, 5)
    assert.equal(report.categoryCounts.timestamp_sql, 2)
    assert.equal(report.categoryCounts.modern_timestamp_migration, 4)
    assert.equal(report.recommendation.fullMigrateRecommended, false)
    assert.equal(report.recommendation.decision, 'do_not_run_full_migrate')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('flags timestamp SQL with non-idempotent CREATE TABLE as high risk', () => {
  const tmp = makeTmp()
  try {
    const outDir = path.join(tmp, 'out')
    const input = `Applied: 1
Pending: 1

Pending migrations (in load order):
  - 20250926_create_audit_tables
`

    const result = run(['--out-dir', outDir], input)
    assert.equal(result.status, 0, result.stderr)

    const report = JSON.parse(readFileSync(path.join(outDir, 'report.json'), 'utf8'))
    const probeSql = readFileSync(path.join(outDir, 'schema-probes.sql'), 'utf8')
    const item = report.items.find((it) => it.name === '20250926_create_audit_tables')
    assert.equal(item.category, 'timestamp_sql')
    assert.equal(item.risk, 'high')
    assert.equal(item.hasCreateTableWithoutIfNotExists, true)
    assert.ok(report.schemaProbeSqlCounts.tables > 0)
    assert.ok(report.schemaProbeSqlCounts.columns > 0)
    assert.ok(item.schemaTargets.createTables.includes('audit_logs'))
    assert.ok(item.schemaTargets.addColumns.some((target) => (
      target.table === 'audit_logs' && target.column === 'event_id'
    )))
    assert.equal(item.schemaTargets.addColumns.some((target) => (
      target.table === 'audit_logs_2025_01' && target.column === 'id'
    )), false)
    assert.ok(report.schemaProbePlan.some((entry) => (
      entry.migration === '20250926_create_audit_tables'
      && entry.tablesToCheck.includes('audit_logs')
      && entry.columnsToCheck.includes('audit_logs.event_id')
    )))
    assert.match(probeSql, /BEGIN READ ONLY/)
    assert.match(probeSql, /WITH probe_plan/)
    assert.match(probeSql, /pg_catalog\.pg_attribute/)
    assert.match(probeSql, /matched_schemas/)
    assert.match(probeSql, /\('column', '20250926_create_audit_tables', NULL, 'audit_logs', 'event_id', NULL\)/)
    assert.doesNotMatch(probeSql, /to_regclass/)
    assert.doesNotMatch(probeSql, /information_schema\.columns/)
    assert.doesNotMatch(probeSql, /\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX|COLUMN)\b/i)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('reports aligned when there are no pending migrations', () => {
  const tmp = makeTmp()
  try {
    const outDir = path.join(tmp, 'out')
    const input = `Applied: 163
Pending: 0

No pending migrations — schema is up to date.
`

    const result = run(['--out-dir', outDir], input)
    assert.equal(result.status, 0, result.stderr)

    const report = JSON.parse(readFileSync(path.join(outDir, 'report.json'), 'utf8'))
    assert.equal(report.pending, 0)
    assert.equal(report.recommendation.decision, 'aligned')
    assert.equal(report.recommendation.fullMigrateRecommended, true)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('ignores down-path drops when scanning replay risk', () => {
  const tmp = makeTmp()
  try {
    const outDir = path.join(tmp, 'out')
    const input = `Applied: 1
Pending: 1

Pending migrations (in load order):
  - zzzz20260519070000_create_plugin_attendance_report_sync_jobs
`

    const result = run(['--out-dir', outDir], input)
    assert.equal(result.status, 0, result.stderr)

    const report = JSON.parse(readFileSync(path.join(outDir, 'report.json'), 'utf8'))
    const probeSql = readFileSync(path.join(outDir, 'schema-probes.sql'), 'utf8')
    const item = report.items.find((it) => it.name === 'zzzz20260519070000_create_plugin_attendance_report_sync_jobs')
    assert.equal(item.category, 'modern_timestamp_migration')
    assert.notEqual(item.risk, 'high')
    assert.equal(item.hasDropStatement, false)
    assert.deepEqual(item.schemaTargets.createTables, ['plugin_attendance_report_sync_jobs'])
    assert.ok(item.schemaTargets.addColumns.some((target) => (
      target.table === 'plugin_attendance_report_sync_jobs' && target.column === 'status'
    )))
    assert.ok(item.schemaTargets.indexes.some((target) => (
      target.table === 'plugin_attendance_report_sync_jobs'
      && target.index === 'uq_plugin_attendance_report_sync_jobs_idempotency'
    )))
    assert.equal(report.schemaProbeSqlCounts.tables, 1)
    assert.equal(report.schemaProbeSqlCounts.indexes, 1)
    assert.match(probeSql, /pg_catalog\.pg_index/)
    assert.match(probeSql, /plugin_attendance_report_sync_jobs/)
    assert.match(probeSql, /status/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('keeps SQL alter-column probes within the same statement', () => {
  const tmp = makeTmp()
  try {
    const outDir = path.join(tmp, 'out')
    const input = `Applied: 1
Pending: 1

Pending migrations (in load order):
  - zzzz20260411120100_approval_templates_and_instance_extensions
`

    const result = run(['--out-dir', outDir], input)
    assert.equal(result.status, 0, result.stderr)

    const report = JSON.parse(readFileSync(path.join(outDir, 'report.json'), 'utf8'))
    const item = report.items.find((it) => it.name === 'zzzz20260411120100_approval_templates_and_instance_extensions')
    assert.ok(item.schemaTargets.addColumns.some((target) => (
      target.table === 'approval_assignments' && target.column === 'node_key'
    )))
    assert.equal(item.schemaTargets.addColumns.some((target) => (
      target.table === 'approval_records' && target.column === 'node_key'
    )), false)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('emits full schema probe SQL from the whole probe plan', () => {
  const tmp = makeTmp()
  try {
    const outDir = path.join(tmp, 'out')
    const result = run(['--out-dir', outDir], STAGING_LIST)
    assert.equal(result.status, 0, result.stderr)

    const report = JSON.parse(readFileSync(path.join(outDir, 'report.json'), 'utf8'))
    const markdown = readFileSync(path.join(outDir, 'report.md'), 'utf8')
    const probeSql = readFileSync(path.join(outDir, 'schema-probes.sql'), 'utf8')

    const planRowsInSql = [...probeSql.matchAll(/\('(?:table|column|index)', /g)].length
    const expectedRows = report.schemaProbeSqlCounts.tables
      + report.schemaProbeSqlCounts.columns
      + report.schemaProbeSqlCounts.indexes

    assert.equal(planRowsInSql, expectedRows)
    assert.equal(report.schemaProbePlan.length, 40)
    assert.match(markdown, /The companion `schema-probes\.sql`/)
    assert.match(probeSql, /Unqualified table names are not assumed to be public/)
    assert.match(probeSql, /coalesce\(probe\.matched_schemas, ''\) AS matched_schemas/)
    assert.match(probeSql, /\('table', '008_plugin_infrastructure', NULL, 'plugin_registry', NULL, NULL\)/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('fails clearly when no migrate list input is provided', () => {
  const result = run([])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Provide --migrate-list-file/)
})
