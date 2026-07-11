'use strict'

// K3 WISE BOM/GetList-by-material-id — BL1 contract/preset metadata. Pure module; no adapter, no runtime,
// no network, no write. Locks (BL0 design-lock #3603): the preset owns endpoint/filter/field/container;
// the coarse-code family is exact-registered (no prefix); everything is values-free and latent
// (runtimeValidated flipped true at BL3 #3701 standalone entity-machine PASS).

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const MODULE_PATH = path.join(__dirname, '..', 'lib', 'read-source-bom-list-by-material-contract.cjs')
const {
  K3WISE_BOM_LIST_BY_MATERIAL_PRESET,
  K3_WISE_BOM_LIST_BY_MATERIAL_ERROR_CODES,
  K3_WISE_BOM_LIST_BY_MATERIAL_FAILED,
  safeBomListByMaterialErrorCode,
  isBomListByMaterialPresetConfig,
} = require(MODULE_PATH)

// ── purity: contract/metadata only, no runtime/network ────────────────────────────────────────────
function testPurity() {
  const source = fs.readFileSync(MODULE_PATH, 'utf8')
  assert.ok(!/require\(/.test(source), 'BL1 contract must require nothing (pure metadata)')
  assert.ok(!/\bfetch\s*\(|\.read\s*\(|\.query\s*\(|createAdapter|http/.test(source), 'BL1 contract must not touch any runtime/adapter/network path')
  // No write/Save/Submit/Audit token anywhere.
  assert.ok(!/\b(save|submit|audit|upsert|write)\s*\(/i.test(source), 'BL1 contract must not reference any write operation')
}

// ── preset shape reflects the confirmed #3683 live contract ───────────────────────────────────────
function testPresetShape() {
  const p = K3WISE_BOM_LIST_BY_MATERIAL_PRESET
  assert.ok(Object.isFrozen(p))
  assert.equal(p.preset, 'k3wise.bom-list-by-material-id.v1')
  assert.equal(p.requiredKind, 'erp:k3-wise-webapi')
  assert.equal(p.mode, 'resolver_lookup')
  assert.equal(p.endpointClass, 'GetList')
  assert.equal(p.readMethod, 'POST')
  assert.equal(p.readPath, 'BOM/GetList')
  // The produced scalar is FItemID; the K3 query column is FPercentItemID — the reconciled distinction.
  assert.equal(p.inputName, 'FItemID')
  assert.equal(p.filterField, 'FPercentItemID')
  assert.equal(p.filterDialect, 'bracketed_field_key_expression')
  assert.equal(p.selectPage, 2)
  assert.equal(p.requestBodyRoot, 'Data')
  assert.equal(p.rowContainerPath, 'Data.DATA') // uppercase, per #3683
  assert.equal(p.outputField, 'FBOMNumber')
  // No auto-pick; unique-only fail-closed (owner c126/c127).
  assert.equal(p.resolverRulePolicy, 'unique_only_fail_closed')
  assert.equal(p.automaticSelectionByStatusVersionDate, false)
  // Identity class for this customer (EII-R0 + operator confirmation).
  assert.equal(p.entryIdentifierClass, 'ID')
  // Docs fact: no by-material example existed; the contract was proven on hardware instead —
  // BL3 standalone entity-machine smoke PASS (#3701) flipped runtimeValidated in its controlled transition.
  assert.equal(p.byMaterialExampleInDocs, false)
  assert.equal(p.runtimeValidated, true)
}

// ── values-free: no business value can be hiding in the metadata ──────────────────────────────────
function testValuesFree() {
  const text = JSON.stringify(K3WISE_BOM_LIST_BY_MATERIAL_PRESET)
  // Only K3 field-key names / endpoint / structural tokens; assert nothing that looks like a business
  // value (digits-only runs that could be a material/BOM number, host/credential markers) is present.
  assert.ok(!/https?:\/\//.test(text), 'no host/url in preset')
  assert.ok(!/token|secret|password|bearer|cookie|authority/i.test(text), 'no credential marker in preset')
  assert.ok(!/\b\d{4,}\b/.test(text), 'no long digit run (would be a business id) in preset')
}

// ── coarse-code family: exact 8, registered set, safe fallback (no prefix passthrough) ─────────────
function testErrorCodeFamily() {
  assert.ok(Object.isFrozen(K3_WISE_BOM_LIST_BY_MATERIAL_ERROR_CODES))
  assert.equal(K3_WISE_BOM_LIST_BY_MATERIAL_ERROR_CODES.length, 8)
  assert.equal(new Set(K3_WISE_BOM_LIST_BY_MATERIAL_ERROR_CODES).size, 8)
  for (const code of K3_WISE_BOM_LIST_BY_MATERIAL_ERROR_CODES) {
    assert.match(code, /^K3_WISE_BOM_LIST_BY_MATERIAL_[A-Z_]+$/)
    assert.equal(safeBomListByMaterialErrorCode(code), code) // registered → passes exactly
  }
  // The BL0 taxonomy's eight conditions are all present.
  for (const suffix of ['NOT_CONFIGURED', 'KEY_INVALID', 'REJECTED', 'FAILED', 'SHAPE_MISMATCH', 'NOT_FOUND', 'AMBIGUOUS', 'FIELD_MISSING']) {
    assert.ok(K3_WISE_BOM_LIST_BY_MATERIAL_ERROR_CODES.includes(`K3_WISE_BOM_LIST_BY_MATERIAL_${suffix}`), `missing ${suffix}`)
  }
  // Unknown / prefix-shaped / business-shaped tokens degrade to the generic FAILED fallback (never pass).
  assert.equal(safeBomListByMaterialErrorCode('K3_WISE_BOM_LIST_BY_MATERIAL_MADE_UP'), K3_WISE_BOM_LIST_BY_MATERIAL_FAILED)
  assert.equal(safeBomListByMaterialErrorCode('MAT_001_SECRET'), K3_WISE_BOM_LIST_BY_MATERIAL_FAILED)
  assert.equal(safeBomListByMaterialErrorCode(undefined), K3_WISE_BOM_LIST_BY_MATERIAL_FAILED)
  assert.equal(safeBomListByMaterialErrorCode(42), K3_WISE_BOM_LIST_BY_MATERIAL_FAILED)
}

// ── preset-config identity predicate (for BL2 to gate on before wiring) ───────────────────────────
function testPresetConfigPredicate() {
  assert.equal(isBomListByMaterialPresetConfig({ mode: 'resolver_lookup', requiredKind: 'erp:k3-wise-webapi', object: 'material-bom-list' }), true)
  assert.equal(isBomListByMaterialPresetConfig({ mode: 'single_record', requiredKind: 'erp:k3-wise-webapi', object: 'material-bom-list' }), false)
  assert.equal(isBomListByMaterialPresetConfig({ mode: 'resolver_lookup', requiredKind: 'erp:k3-wise-webapi', object: 'material' }), false)
  assert.equal(isBomListByMaterialPresetConfig(null), false)
  assert.equal(isBomListByMaterialPresetConfig('nope'), false)
}

testPurity()
testPresetShape()
testValuesFree()
testErrorCodeFamily()
testPresetConfigPredicate()

console.log('read-source-bom-list-by-material-contract.test.cjs OK')
