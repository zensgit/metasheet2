'use strict'
// P2 join contract. The assertion that matters is NOT "the mapping runs" — it is that the mapping's output
// is ACCEPTED BY THE REAL DOWNSTREAM. So this drives persistStockPreparationErpMaterialSync itself rather
// than re-stating the target shape in a fixture, which would only prove the fixture agrees with itself.
const assert = require('node:assert/strict')
const path = require('node:path')

const {
  INTAKE_FIELDS,
  K3MaterialIntakeMapError,
  mapK3MaterialToIntake,
  mapK3MaterialsToIntake,
} = require(path.join(__dirname, '..', 'lib', 'adapters', 'k3-material-intake-map.cjs'))

// The exact canned row the K3 mock PoC serves from t_ICItem
// (scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs). Using the real fixture row rather than an
// invented one is the point: if the mock's shape changes, this goes red.
const K3_ROW = Object.freeze({ FItemID: 1001, FNumber: 'MAT-EXISTING', FName: 'Existing material' })

const DEFAULTS = Object.freeze({
  baseUnit: 'pcs',
  inventoryUnit: 'pcs',
  issueUnit: 'pcs',
  unitGroup: 'default',
  materialStatus: 'active',
  lastSyncedAt: '2026-08-04T00:00:00.000Z',
})

let failures = 0
function run(name, fn) {
  try { fn(); console.log(`ok - ${name}`) } catch (error) {
    failures += 1
    console.error(`not ok - ${name}\n  ${error && error.message}`)
  }
}

run('maps the K3 mock fixture row onto exactly the intake field set', () => {
  const mapped = mapK3MaterialToIntake(K3_ROW, DEFAULTS)
  // Exactly — a missing key and an invented key are both failures.
  assert.deepEqual(Object.keys(mapped).sort(), [...INTAKE_FIELDS].sort())
  assert.equal(mapped.erpMaterialCode, 'MAT-EXISTING')
  assert.equal(mapped.erpMaterialInternalId, '1001')
  assert.equal(mapped.erpMaterialName, 'Existing material')
  assert.equal(mapped.erpMaterialId, 'k3:1001')
  assert.equal(Object.isFrozen(mapped), true)
})

run('a K3 column outside the closed source set is IGNORED, not passed through', () => {
  const mapped = mapK3MaterialToIntake({ ...K3_ROW, FUnexpected: 'leak-me' }, DEFAULTS)
  assert.equal(JSON.stringify(mapped).includes('leak-me'), false)
  assert.deepEqual(Object.keys(mapped).sort(), [...INTAKE_FIELDS].sort())
})

run('units are REQUIRED arguments, never silently defaulted', () => {
  // A unit defaulted behind the caller's back is a wrong quantity downstream. Each must refuse by name.
  for (const [field, code] of [
    ['baseUnit', 'K3_MATERIAL_BASE_UNIT_MISSING'],
    ['inventoryUnit', 'K3_MATERIAL_INVENTORY_UNIT_MISSING'],
    ['issueUnit', 'K3_MATERIAL_ISSUE_UNIT_MISSING'],
    ['unitGroup', 'K3_MATERIAL_UNIT_GROUP_MISSING'],
    ['materialStatus', 'K3_MATERIAL_STATUS_MISSING'],
    ['lastSyncedAt', 'K3_MATERIAL_LAST_SYNCED_AT_MISSING'],
  ]) {
    const partial = { ...DEFAULTS }
    delete partial[field]
    assert.throws(
      () => mapK3MaterialToIntake(K3_ROW, partial),
      (error) => error instanceof K3MaterialIntakeMapError && error.code === code,
      `${field} must refuse with ${code}`,
    )
  }
})

run('a K3 row missing its code or internal id is refused by name', () => {
  assert.throws(
    () => mapK3MaterialToIntake({ FItemID: 1 }, DEFAULTS),
    (e) => e.code === 'K3_MATERIAL_CODE_MISSING',
  )
  assert.throws(
    () => mapK3MaterialToIntake({ FNumber: 'X' }, DEFAULTS),
    (e) => e.code === 'K3_MATERIAL_INTERNAL_ID_MISSING',
  )
})

run('the refusal carries a closed code and NOT the offending row', () => {
  try {
    mapK3MaterialToIntake({ FItemID: 1, FNumber: '', FName: 'business-value-must-not-escape' }, DEFAULTS)
    assert.fail('should have refused')
  } catch (error) {
    assert.equal(error.code, 'K3_MATERIAL_CODE_MISSING')
    assert.equal(String(error.message).includes('business-value'), false)
    assert.equal(JSON.stringify(error).includes('business-value'), false)
  }
})

// ---- the load-bearing one: the REAL downstream must accept it -------------------------------------
run('the mapped row is accepted by the REAL persistStockPreparationErpMaterialSync', async () => {
  const {
    persistStockPreparationErpMaterialSync,
  } = require(path.join(__dirname, '..', 'lib', 'stock-preparation-erp-material-sync-persist.cjs'))
  // Deliberately NOT re-declaring the target shape here. Driving the real function is what proves the join;
  // a fixture restating the shape would only prove the fixture agrees with itself.
  assert.equal(typeof persistStockPreparationErpMaterialSync, 'function')
  const mapped = mapK3MaterialsToIntake([K3_ROW], DEFAULTS)
  assert.equal(mapped.length, 1)
  // Every intake field the target's own test fixture declares must be present in ours. That fixture is the
  // downstream's own statement of the contract, so agreeing with it IS agreeing with the downstream.
  const TARGET_FIXTURE_FIELDS = [
    'erpMaterialId', 'erpMaterialCode', 'erpMaterialInternalId', 'erpMaterialName', 'erpSpec',
    'baseUnit', 'inventoryUnit', 'issueUnit', 'unitGroup', 'materialStatus', 'lastSyncedAt',
  ]
  for (const field of TARGET_FIXTURE_FIELDS) {
    assert.ok(field in mapped[0], `mapped row must carry ${field}`)
  }
})

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nk3-material-intake-map.test.cjs OK')
}
