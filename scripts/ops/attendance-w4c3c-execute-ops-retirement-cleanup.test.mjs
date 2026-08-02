#!/usr/bin/env node
/**
 * W4C-3c P15 — execute-ops-retirement-cleanup inventories W4-backed rows only.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const cleanup = require(path.join(rootDir, 'scripts/attendance/execute-ops-retirement-cleanup.cjs'))

test('P15 isW4BackedInventoryRow: pointer OR non-legacy owner OR calculation child', () => {
  assert.equal(
    cleanup.isW4BackedInventoryRow({
      current_calculation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      projection_owner: 'legacy_untracked',
      has_calculation_child: false,
    }),
    true,
  )
  assert.equal(
    cleanup.isW4BackedInventoryRow({
      current_calculation_id: null,
      projection_owner: 'segment_authoritative',
      has_calculation_child: false,
    }),
    true,
  )
  assert.equal(
    cleanup.isW4BackedInventoryRow({
      current_calculation_id: null,
      projection_owner: 'legacy_untracked',
      has_calculation_child: true,
    }),
    true,
  )
  assert.equal(
    cleanup.isW4BackedInventoryRow({
      current_calculation_id: null,
      projection_owner: 'legacy_untracked',
      has_calculation_child: false,
    }),
    false,
  )
  assert.equal(
    cleanup.isW4BackedInventoryRow({
      current_calculation_id: null,
      projection_owner: 'legacy_untracked',
      has_calculation_child: 't',
    }),
    true,
  )
})

test('P15 mixed W4/legacy inventory: only W4-backed rows become retirement targets', () => {
  const rows = [
    {
      record_id: 'w4-pointer',
      current_calculation_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      projection_owner: 'legacy_untracked',
      has_calculation_child: false,
    },
    {
      record_id: 'legacy-only',
      current_calculation_id: null,
      projection_owner: 'legacy_untracked',
      has_calculation_child: false,
    },
    {
      record_id: 'w4-child',
      current_calculation_id: null,
      projection_owner: 'legacy_untracked',
      has_calculation_child: true,
    },
    {
      record_id: 'w4-owner',
      current_calculation_id: null,
      projection_owner: 'shadow',
      has_calculation_child: false,
    },
  ]
  const targets = []
  const skippedNonW4 = []
  for (const row of rows) {
    if (!cleanup.isW4BackedInventoryRow(row)) {
      skippedNonW4.push({
        recordId: row.record_id,
        classification: 'tooling_only_non_w4_fixture',
      })
      continue
    }
    targets.push(row.record_id)
  }
  assert.deepEqual(targets.sort(), ['w4-child', 'w4-owner', 'w4-pointer'])
  assert.deepEqual(
    skippedNonW4.map((s) => s.recordId),
    ['legacy-only'],
  )
  assert.equal(skippedNonW4[0].classification, 'tooling_only_non_w4_fixture')
})

test('P15 source: inventory SQL includes W4-backed filter predicates', async () => {
  const fs = await import('node:fs')
  const source = fs.readFileSync(
    path.join(rootDir, 'scripts/attendance/execute-ops-retirement-cleanup.cjs'),
    'utf8',
  )
  assert.match(source, /isW4BackedInventoryRow/)
  assert.match(source, /tooling_only_non_w4_fixture/)
  assert.match(source, /has_calculation_child/)
  assert.match(source, /projection_owner/)
  assert.match(source, /current_calculation_id/)
  // Comment may name the forbidden DELETE; live executable body must not issue it.
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const withoutLineComments = withoutBlockComments.replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(
    withoutLineComments,
    /(?:^|[^'"`])\s*DELETE\s+FROM\s+attendance_records/i,
    'P15 executor must never issue live DELETE attendance_records',
  )
  assert.match(source, /ops-retirement/)
})

test('P15 explicit operation id is single-target only; command seed derives per-record ids', () => {
  const seed = '11111111-1111-4111-8111-111111111111'
  const explicit = '22222222-2222-4222-8222-222222222222'
  const one = cleanup.assignStableOperationIds([{ record_id: 'record-a' }], seed, explicit)
  assert.equal(one[0].operationId, explicit)
  assert.throws(
    () => cleanup.assignStableOperationIds(
      [{ record_id: 'record-a' }, { record_id: 'record-b' }],
      seed,
      explicit,
    ),
    (error) => error?.code === 'SINGLE_OPERATION_ID_MULTIPLE_TARGETS',
  )
  const many = cleanup.assignStableOperationIds(
    [{ record_id: 'record-a' }, { record_id: 'record-b' }],
    seed,
    '',
  )
  assert.match(many[0].operationId, /^[0-9a-f-]{36}$/)
  assert.match(many[1].operationId, /^[0-9a-f-]{36}$/)
  assert.notEqual(many[0].operationId, many[1].operationId)
})

test('P15 privileged executor requires an explicit organization target', () => {
  assert.equal(cleanup.requireExplicitOrgId(' org-test '), 'org-test')
  assert.throws(
    () => cleanup.requireExplicitOrgId(''),
    (error) => error?.code === 'ATTENDANCE_P15_ORG_REQUIRED',
  )
})
