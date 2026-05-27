'use strict'

// K3 WISE customer-profiled Material Save preset (M1 fix) — preset-level guards.
// Adapter-flow checks (shaping / fail-closed / diagnostics / save-only locks) live in
// k3-wise-adapters.test.cjs which already has the K3 fetch mock.

const assert = require('node:assert')
const {
  getK3WiseDocumentObjectDefaults,
  getK3WiseMaterialProfile,
  listK3WiseMaterialProfiles,
  MATERIAL_CUSTOMER_PROFILE_ID,
} = require('../lib/adapters/k3-wise-document-templates.cjs')

const ALLOWED_FIELD_KEYS = new Set(['name', 'label', 'type', 'required', 'reference'])
const ALLOWED_REFERENCE_KEYS = new Set(['identifier'])
const ALLOWED_IDENTIFIERS = new Set(['FNumber', 'FID'])

// R-OPTIN: the customer profile is a DISTINCT id; the generic default is never the preset.
function testPresetIsDistinctAndOptIn() {
  const generic = getK3WiseDocumentObjectDefaults().material
  const genericFields = new Set(generic.schema.map((field) => field.name))
  assert.equal(generic.id, 'k3wise.material.v1', 'generic default is the minimal template')
  assert.equal(genericFields.has('FErpClsID'), false, 'generic template lacks the customer G2 fields')

  const profile = getK3WiseMaterialProfile(MATERIAL_CUSTOMER_PROFILE_ID)
  assert.ok(profile, 'customer profile resolves by id')
  assert.equal(profile.id, MATERIAL_CUSTOMER_PROFILE_ID)
  const profileFields = new Set(profile.schema.map((field) => field.name))
  // G2 fields the customer env requires (verbatim from the frozen design §1).
  for (const required of [
    'FErpClsID', 'FUseState', 'FTrack', 'FDefaultLoc', 'FDSManagerID', 'FPlanPrice',
    'FPlanTrategy', 'FOrderTrategy',
    'FInspectionLevel', 'FProChkMde', 'FWWChkMde', 'FSOChkMde', 'FWthDrwChkMde', 'FStkChkMde', 'FOtherChkMde',
    'FUnitGroupID', 'FUnitID',
  ]) {
    assert.ok(profileFields.has(required), `customer profile declares ${required}`)
  }
}

// G3: numbered base data → {FNumber}; enum/category → {FID}.
function testPerFieldShapeDeclared() {
  const profile = getK3WiseMaterialProfile(MATERIAL_CUSTOMER_PROFILE_ID)
  const byName = new Map(profile.schema.map((field) => [field.name, field]))
  const byNumber = ['FUnitGroupID', 'FUnitID', 'FBaseUnitID', 'FAcctID', 'FDefaultLoc']
  const byId = ['FErpClsID', 'FUseState', 'FInspectionLevel', 'FProChkMde', 'FPlanTrategy']
  for (const name of byNumber) {
    assert.equal(byName.get(name).reference.identifier, 'FNumber', `${name} is by-FNumber`)
  }
  for (const name of byId) {
    assert.equal(byName.get(name).reference.identifier, 'FID', `${name} is by-FID (enum/category)`)
  }
}

// Scope-creep guard: the preset must not grow operations beyond upsert.
function testOperationsStayUpsertOnly() {
  const profile = getK3WiseMaterialProfile(MATERIAL_CUSTOMER_PROFILE_ID)
  assert.deepEqual(profile.operations, ['upsert'], 'preset operations stay [upsert]')
  // Save-only by construction: no submit/audit endpoints on the profile.
  assert.equal(profile.submitPath, undefined, 'preset has no submitPath')
  assert.equal(profile.auditPath, undefined, 'preset has no auditPath')
}

// no-hardcoded-values: the preset declares STRUCTURE only — field name/label/type/shape.
// No concrete dictionary value (defaultValue / value / sample code) is baked into any
// reference field, and reference identifiers are restricted to FNumber/FID.
function testNoHardcodedCustomerValues() {
  const profile = getK3WiseMaterialProfile(MATERIAL_CUSTOMER_PROFILE_ID)
  for (const field of profile.schema) {
    for (const key of Object.keys(field)) {
      assert.ok(ALLOWED_FIELD_KEYS.has(key), `field ${field.name} carries only structural keys (got "${key}")`)
    }
    if (field.reference) {
      for (const key of Object.keys(field.reference)) {
        assert.ok(ALLOWED_REFERENCE_KEYS.has(key), `${field.name}.reference is structural only (got "${key}")`)
      }
      assert.ok(ALLOWED_IDENTIFIERS.has(field.reference.identifier), `${field.name} identifier is FNumber/FID`)
    }
  }
}

function testUnknownProfileResolvesNull() {
  assert.equal(getK3WiseMaterialProfile('material-does-not-exist'), null, 'unknown profile id → null')
  assert.equal(getK3WiseMaterialProfile(''), null, 'empty profile id → null')
  assert.ok(listK3WiseMaterialProfiles().includes(MATERIAL_CUSTOMER_PROFILE_ID), 'profile is registered')
}

function main() {
  testPresetIsDistinctAndOptIn()
  testPerFieldShapeDeclared()
  testOperationsStayUpsertOnly()
  testNoHardcodedCustomerValues()
  testUnknownProfileResolvesNull()
  console.log('✓ k3-wise-material-presets: preset opt-in, per-field shape, operations, no-hardcoded-values, unknown-profile passed')
}

main()
