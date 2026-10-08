'use strict'

// The K3 material master -> stock-prep ERP intake path, pinned where it ACTUALLY lives.
//
// This file replaces k3-material-intake-map.cjs, which I added in #4751 and am retracting here.
// That module re-implemented a mapping the intake already performs, and gave the result a
// DIFFERENT identity, which would have broken idempotent re-sync the moment anyone wired it:
//
//     same K3 row -> #4751 mapper      -> erpMaterialId "k3:1001"
//     same K3 row -> the intake        -> erpMaterialId "stockprep_erp_material_6f377ca0768a9e0d"
//
// erpMaterialId is the persist's KEY FIELD (stock-preparation-erp-material-sync-persist.cjs:98,
// read from the template's keyFields rather than hardcoded). Two derivations for one material
// means two rows for one material. The module had zero product callers, so nothing shipped
// broken -- but it was a trap for whoever wired it, and the wiring was the next planned step.
//
// What is worth pinning is not a second mapper. It is the two properties of the real path that
// a future edit could silently remove:
//
//   1. the intake's alias lists accept RAW K3 column names, so no per-connector mapper is needed
//   2. the derived identity is namespaced by source system, so two ERPs reporting the same
//      internal id do not collide -- the property `k3:${internalId}` did NOT have
//
// Both are asserted against the real module, never text-parsed.

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  normalizeStockPreparationReadonlyIntake,
} = require('../lib/stock-preparation-readonly-intake.cjs')

// The raw K3 material-master columns. If a future edit drops one of these aliases from the
// intake, the K3 read path silently starts producing rows missing that field.
const RAW_K3_ROW = Object.freeze({
  FItemID: 1001,
  FNumber: 'MAT-EXISTING',
  FName: 'Existing material',
  FModel: 'SPEC-A',
})

function intakeFor(row, sourceSystem = 'erp_k3') {
  return normalizeStockPreparationReadonlyIntake({
    sourceSystem,
    runId: 'run-alias-pin',
    startedAt: '2026-08-04T00:00:00.000Z',
    createdBy: 'system',
    erpMaterials: [row],
  })
}

test('a RAW K3 material row feeds the intake with no per-connector mapper', () => {
  const out = intakeFor(RAW_K3_ROW)

  // Zero row errors is the whole claim: the intake understood the raw K3 shape by itself.
  assert.equal(out.evidence.result.rowErrors, 0, 'a raw K3 row must not produce row errors')

  const material = out.erpMaterials[0]
  assert.equal(material.erpMaterialCode, 'MAT-EXISTING', 'FNumber -> erpMaterialCode')
  assert.equal(material.erpMaterialInternalId, '1001', 'FItemID -> erpMaterialInternalId')
  assert.equal(material.erpMaterialName, 'Existing material', 'FName -> erpMaterialName')
  assert.equal(material.erpSpec, 'SPEC-A', 'FModel -> erpSpec')
})

test('each raw K3 column is INDIVIDUALLY load-bearing (drop one, lose that field)', () => {
  // A single all-columns-present assertion would still pass if only one alias survived and the
  // rest came from somewhere else. Drop them one at a time instead.
  const expectations = [
    ['FNumber', 'erpMaterialCode'],
    ['FItemID', 'erpMaterialInternalId'],
    ['FName', 'erpMaterialName'],
    ['FModel', 'erpSpec'],
  ]

  for (const [column, target] of expectations) {
    const without = { ...RAW_K3_ROW }
    delete without[column]
    const out = intakeFor(without)

    if (column === 'FNumber' || column === 'FItemID') {
      // Code and internal id are REQUIRED -- dropping them is a row error, not a null field.
      assert.ok(
        out.evidence.result.rowErrors > 0,
        `dropping ${column} must be a row error, since ${target} is required`,
      )
      continue
    }

    assert.equal(out.evidence.result.rowErrors, 0)
    assert.equal(
      out.erpMaterials[0][target],
      null,
      `${target} must come from ${column} and from nowhere else`,
    )
  }
})

test('the derived identity is STABLE for the same row', () => {
  const first = intakeFor(RAW_K3_ROW).erpMaterials[0].erpMaterialId
  const second = intakeFor(RAW_K3_ROW).erpMaterials[0].erpMaterialId
  assert.equal(first, second, 're-reading the same material must yield the same key, or re-sync duplicates')
  assert.ok(first.length > 0)
})

test('the derived identity is NAMESPACED by source system (the property a k3:<id> scheme lacks)', () => {
  // This is the concrete reason the retracted mapper's `k3:${internalId}` was the worse scheme:
  // two ERPs that both number a material 1001 would have collided on one key.
  const fromK3 = intakeFor(RAW_K3_ROW, 'erp_k3').erpMaterials[0].erpMaterialId
  const fromOther = intakeFor(RAW_K3_ROW, 'erp_other').erpMaterials[0].erpMaterialId
  assert.notEqual(
    fromK3,
    fromOther,
    'the same internal id from a different source system must not collide',
  )
})

test('an explicit erpMaterialId still wins, so an upstream that HAS a stable id keeps it', () => {
  // The derivation is a fallback, not an override. Pinning this keeps a future "always derive"
  // simplification from silently re-keying every already-synced material.
  const out = intakeFor({ ...RAW_K3_ROW, erpMaterialId: 'supplied-by-upstream' })
  assert.equal(out.evidence.result.rowErrors, 0)
  assert.equal(out.erpMaterials[0].erpMaterialId, 'supplied-by-upstream')
})
