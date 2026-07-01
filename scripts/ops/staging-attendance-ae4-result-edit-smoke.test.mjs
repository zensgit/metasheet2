import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const script = readFileSync(join(here, 'staging-attendance-ae4-result-edit-smoke.mjs'), 'utf8')
const runbook = readFileSync(join(here, '../../docs/development/attendance-ae4-anomaly-result-edit-staging-smoke-runbook-20260701.md'), 'utf8')

test('AE-4 API/DB helper does not claim the final UI staging pass', () => {
  assert.match(script, /AE4_RESULT_EDIT_API_DB_SMOKE_PASS/)
  assert.doesNotMatch(script, /AE4_RESULT_EDIT_STAGING_SMOKE_PASS/)
  assert.match(runbook, /This is \*\*not\*\* the final AE-4 PASS stamp/)
})

test('AE-4 helper cleanup is scoped to this smoke record set', () => {
  assert.match(script, /STAMP must match \/\^ae4-smoke-\[A-Za-z0-9-\]\+\$\//)
  assert.match(script, /source_key LIKE ANY\(\$3::text\[\]\)/)
  assert.match(script, /d\.source_id = e\.id::text/)
  assert.doesNotMatch(script, /source_key LIKE `attendance_result_edit:\$\{ORG_ID\}:%`/)
  assert.doesNotMatch(script, /idempotency_key LIKE/)
  assert.doesNotMatch(script, /metadata::text LIKE/)
  assert.doesNotMatch(runbook, /stamp_like/)
})

test('AE-4 helper residue categories match the runbook broad cleanup surface', () => {
  for (const table of [
    'attendance_requests',
    'attendance_events',
    'attendance_import_batches',
    'attendance_import_items',
    'attendance_import_jobs',
  ]) {
    assert.match(script, new RegExp(`to_regclass\\('public\\.${table}'\\)`), `${table} is preflighted`)
    assert.match(script, new RegExp(`FROM ${table}`), `${table} is counted`)
    assert.match(script, new RegExp(`DELETE FROM ${table}`), `${table} is cleaned`)
  }
})

test('AE-4 helper fails the run when an assertion failed before printing PASS', () => {
  assert.match(script, /if \(failures\.length\)/)
  assert.match(script, /failed assertion\(s\)/)
})

test('AE-4 helper does not use the payroll-cycle create API for the closed-cycle guard', () => {
  assert.doesNotMatch(script, /\/api\/attendance\/payroll-cycles/)
  assert.match(script, /SQL-seeded stamped closed payroll cycle/)
})
