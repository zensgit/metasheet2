import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const SCRIPT = path.join(REPO_ROOT, 'scripts/ops/staging-migration-schema-probe-summary.mjs')

function run(args, input = '') {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    input,
    encoding: 'utf8',
  })
}

function makeTmp() {
  return mkdtempSync(path.join(tmpdir(), 'ms2-migration-probe-results-'))
}

test('summarizes CSV probe results into json and markdown', () => {
  const tmp = makeTmp()
  try {
    const resultsFile = path.join(tmp, 'schema-probe-results.csv')
    const outDir = path.join(tmp, 'out')
    writeFileSync(resultsFile, [
      'probe_type,migration,target,exists,match_count,matched_schemas',
      'table,008_plugin_infrastructure,plugin_registry,t,1,public',
      'column,008_plugin_infrastructure,plugin_registry.error,t,1,public',
      'column,20250926_create_audit_tables,audit_logs.event_id,f,0,',
      'index,zzzz20260519070000_create_plugin_attendance_report_sync_jobs,plugin_attendance_report_sync_jobs.uq_job,t,2,"public, archive"',
      '',
    ].join('\n'))

    const result = run(['--input', resultsFile, '--out-dir', outDir])
    assert.equal(result.status, 0, result.stderr)

    const report = JSON.parse(readFileSync(path.join(outDir, 'schema-probe-summary.json'), 'utf8'))
    const markdown = readFileSync(path.join(outDir, 'schema-probe-summary.md'), 'utf8')
    assert.deepEqual(readdirSync(outDir).sort(), ['schema-probe-summary.json', 'schema-probe-summary.md'])
    assert.equal(report.decision, 'manual_review_required')
    assert.deepEqual(report.counts, {
      total: 4,
      matched: 2,
      missing: 1,
      ambiguous: 1,
    })
    assert.equal(report.byProbeType.column.missing, 1)
    assert.equal(report.byProbeType.index.ambiguous, 1)
    assert.equal(report.byMigration.find((it) => it.migration === '008_plugin_infrastructure').status, 'all_matched')
    assert.equal(report.byMigration.find((it) => it.migration === '20250926_create_audit_tables').status, 'has_missing')
    assert.equal(
      report.byMigration.find((it) => it.migration === 'zzzz20260519070000_create_plugin_attendance_report_sync_jobs').status,
      'has_ambiguous',
    )
    assert.equal(report.missing[0].target, 'audit_logs.event_id')
    assert.deepEqual(report.ambiguous[0].matchedSchemas, ['public', 'archive'])
    assert.match(markdown, /manual_review_required/)
    assert.match(markdown, /audit_logs\.event_id/)
    assert.match(markdown, /public, archive/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('classifies mixed per-migration status without failing the process', () => {
  const tmp = makeTmp()
  try {
    const outDir = path.join(tmp, 'out')
    const input = [
      'probe_type,migration,target,exists,match_count,matched_schemas',
      'table,mixed_migration,missing_table,false,0,',
      'index,mixed_migration,ambiguous_index,true,2,"public, shadow"',
      '',
    ].join('\n')

    const result = run(['--out-dir', outDir], input)
    assert.equal(result.status, 0, result.stderr)

    const report = JSON.parse(readFileSync(path.join(outDir, 'schema-probe-summary.json'), 'utf8'))
    assert.equal(report.decision, 'manual_review_required')
    assert.equal(report.byMigration[0].status, 'mixed_missing_and_ambiguous')
    assert.deepEqual(report.byMigration[0].missingTargets, ['missing_table'])
    assert.deepEqual(report.byMigration[0].ambiguousTargets, ['ambiguous_index'])
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('accepts TSV probe results from stdin', () => {
  const tmp = makeTmp()
  try {
    const outDir = path.join(tmp, 'out')
    const input = [
      'probe_type\tmigration\ttarget\texists\tmatch_count\tmatched_schemas',
      'table\t008_plugin_infrastructure\tplugin_registry\ttrue\t1\tpublic',
      'column\t008_plugin_infrastructure\tplugin_registry.error\ttrue\t1\tpublic',
      '',
    ].join('\n')

    const result = run(['--format', 'tsv', '--out-dir', outDir], input)
    assert.equal(result.status, 0, result.stderr)

    const report = JSON.parse(readFileSync(path.join(outDir, 'schema-probe-summary.json'), 'utf8'))
    assert.equal(report.decision, 'schema_probe_targets_present')
    assert.deepEqual(report.counts, {
      total: 2,
      matched: 2,
      missing: 0,
      ambiguous: 0,
    })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('keeps quoted CSV fields with embedded commas intact', () => {
  const tmp = makeTmp()
  try {
    const outDir = path.join(tmp, 'out')
    const input = [
      'probe_type,migration,target,exists,match_count,matched_schemas',
      'table,quoted_target,"audit_logs, legacy",t,1,public',
      'index,quoted_schema,idx,t,2,"public, shadow"',
      '',
    ].join('\n')

    const result = run(['--out-dir', outDir], input)
    assert.equal(result.status, 0, result.stderr)

    const report = JSON.parse(readFileSync(path.join(outDir, 'schema-probe-summary.json'), 'utf8'))
    assert.equal(report.rows[0].target, 'audit_logs, legacy')
    assert.deepEqual(report.rows[1].matchedSchemas, ['public', 'shadow'])
    assert.equal(report.rows[1].status, 'ambiguous')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('fails clearly when required columns are missing', () => {
  const result = run([], 'probe_type,migration,target\ncolumn,m,t\n')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /missing required column/)
  assert.match(result.stderr, /exists/)
  assert.match(result.stderr, /match_count/)
})

test('fails clearly on invalid booleans and counts', () => {
  const invalidBoolean = run([], [
    'probe_type,migration,target,exists,match_count,matched_schemas',
    'table,m,t,maybe,1,public',
  ].join('\n'))
  assert.equal(invalidBoolean.status, 1)
  assert.match(invalidBoolean.stderr, /Invalid exists value/)

  const invalidCount = run([], [
    'probe_type,migration,target,exists,match_count,matched_schemas',
    'table,m,t,true,nope,public',
  ].join('\n'))
  assert.equal(invalidCount.status, 1)
  assert.match(invalidCount.stderr, /Invalid match_count value/)
})

test('fails clearly when no input is provided', () => {
  const result = run([])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Provide --input/)
})

test('fails clearly for unsupported format', () => {
  const result = run(['--format', 'json'], 'probe_type,migration,target,exists,match_count,matched_schemas\n')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Unsupported --format value/)
})
