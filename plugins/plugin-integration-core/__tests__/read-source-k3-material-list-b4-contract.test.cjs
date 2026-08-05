'use strict'

// B4 contract freeze (S5). Everything by require; the pinned contentKey literal IS the code-layer
// freeze — any content drift in the template is a RED here before it can reach a mint.

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  B4_TEMPLATE_SYSTEM_ID,
  K3WISE_MATERIAL_LIST_ACTION_PROFILE_VERSION,
  K3WISE_MATERIAL_LIST_PRESET_ID,
  K3WISE_MATERIAL_LIST_EXPECTED_PROJECTION,
  K3WISE_MATERIAL_LIST_B4_TEMPLATE,
  buildK3WiseMaterialListB4Config,
} = require('../lib/read-source-k3-material-list-b4-contract.cjs')

const { validateReadSourceConfig, normalizeReadSourceConfig } = require('../lib/read-source-config.cjs')
const { isValidProfileId } = require('../lib/gip-profile-certification-contracts.cjs')
const { __internals: storeInternals } = require('../lib/read-source-config-store.cjs')
const { READ_SMOKE_PRESETS } = require('../lib/read-smoke.cjs')
const { normalizeStockPreparationReadonlyIntake } = require('../lib/stock-preparation-readonly-intake.cjs')

// The code-layer freeze: contentKey of the normalized template with the canonical placeholder.
// Computed by the store's own contentKeyFor (which EXCLUDES the caller version) — never a
// re-implementation. Updating this literal is how a deliberate content change is made, and it
// must ride the same commit as the change (the same pairing discipline as the provenance pins).
const FROZEN_TEMPLATE_CONTENT_KEY = 'a0a8f349981dc9d07b97a915ed799ae640f68aae656da7edddfed2e958a8932a'

test('the B4 template validates with ZERO errors against the real read-source config contract', () => {
  const result = validateReadSourceConfig(K3WISE_MATERIAL_LIST_B4_TEMPLATE)
  assert.equal(result.valid, true, JSON.stringify(result.errors || []))
})

test('profile id grammar: underscore form certifies, the preset\'s hyphen form CANNOT', () => {
  // The correction this certification caught: PROFILE_ID_PATTERN segments allow [a-z0-9_] only.
  // Pinning BOTH directions keeps anyone from "fixing" one id into the other.
  assert.equal(isValidProfileId(K3WISE_MATERIAL_LIST_ACTION_PROFILE_VERSION), true)
  assert.equal(isValidProfileId(K3WISE_MATERIAL_LIST_PRESET_ID), false,
    'the hyphenated preset id must never be usable as actionProfileVersion')
  assert.notEqual(K3WISE_MATERIAL_LIST_ACTION_PROFILE_VERSION, K3WISE_MATERIAL_LIST_PRESET_ID)
})

test('CODE-LAYER FREEZE: the template contentKey equals the pinned literal', () => {
  const normalized = normalizeReadSourceConfig(K3WISE_MATERIAL_LIST_B4_TEMPLATE)
  assert.equal(storeInternals.contentKeyFor(normalized), FROZEN_TEMPLATE_CONTENT_KEY,
    'template content drifted — if deliberate, update the pin in the SAME commit and re-ratify B4')
})

test('the builder\'s only degree of freedom is the real systemId', () => {
  const built = buildK3WiseMaterialListB4Config({ systemId: 'real-sys-9' })
  assert.equal(built.systemId, 'real-sys-9')
  const { systemId: _a, ...builtRest } = normalizeReadSourceConfig(built)
  const { systemId: _b, ...templateRest } = normalizeReadSourceConfig(K3WISE_MATERIAL_LIST_B4_TEMPLATE)
  assert.deepEqual(builtRest, templateRest, 'every non-systemId field must be the frozen template verbatim')
  assert.throws(() => buildK3WiseMaterialListB4Config({}), /external-system id/)
})

test('MIRROR: the expected projection equals the live preset\'s readListFields', () => {
  const preset = READ_SMOKE_PRESETS[K3WISE_MATERIAL_LIST_PRESET_ID]
  assert.ok(preset, 'the material-list read-smoke preset must exist')
  assert.deepEqual(
    [...preset.readConfigOverlay.objects.material.readListFields],
    [...K3WISE_MATERIAL_LIST_EXPECTED_PROJECTION],
    'B4-ratified subset and the preset projection must be ONE list (mirror tripwire, not a copy)',
  )
})

test('END-TO-END: a projected row + the B4 fieldMap lands in the intake with baseUnit set', () => {
  // The B4-level version of S4\'s link test: projection (preset) + explicit mapping (this
  // contract) together produce an intake row that is ingestable AND unit-bearing.
  const raw = { FItemID: 1001, FNumber: 'MAT-B4', FName: 'B4 material', FModel: 'SPEC-B', FUnitID: 'PCS' }
  const projected = Object.fromEntries(
    K3WISE_MATERIAL_LIST_EXPECTED_PROJECTION.filter((f) => f in raw).map((f) => [f, raw[f]]),
  )
  const mapped = { ...projected }
  for (const entry of K3WISE_MATERIAL_LIST_B4_TEMPLATE.fieldMap) {
    if (entry.source in mapped) {
      mapped[entry.target] = mapped[entry.source]
      delete mapped[entry.source]
    }
  }
  const intake = normalizeStockPreparationReadonlyIntake({
    sourceSystem: 'erp_k3',
    runId: 'b4-contract-link',
    startedAt: '2026-08-05T00:00:00.000Z',
    createdBy: 'system',
    erpMaterials: [mapped],
  })
  assert.equal(intake.evidence.result.rowErrors, 0)
  const material = intake.erpMaterials[0]
  assert.equal(material.erpMaterialInternalId, '1001', 'identity still flows via the alias')
  assert.equal(material.baseUnit, 'PCS', 'the EXPLICIT FUnitID->baseUnit mapping is what sets the unit')

  // NEGATIVE CONTROL: without the B4 fieldMap the unit is NULL — proving the explicit mapping
  // is load-bearing, exactly why the owner ruled it must not rely on intake auto-recognition.
  const unmapped = normalizeStockPreparationReadonlyIntake({
    sourceSystem: 'erp_k3',
    runId: 'b4-contract-neg',
    startedAt: '2026-08-05T00:00:00.000Z',
    createdBy: 'system',
    erpMaterials: [projected],
  })
  assert.equal(unmapped.evidence.result.rowErrors, 0)
  assert.equal(unmapped.erpMaterials[0].baseUnit, null,
    'FUnitID is NOT an intake alias — the B4 mapping is the only path to a unit')
})

test('placeholder hygiene: the template systemId is the canonical placeholder, never real', () => {
  assert.equal(K3WISE_MATERIAL_LIST_B4_TEMPLATE.systemId, B4_TEMPLATE_SYSTEM_ID)
  assert.equal(B4_TEMPLATE_SYSTEM_ID, 'b4-template')
})
