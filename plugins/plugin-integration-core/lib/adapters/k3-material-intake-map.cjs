'use strict'
// P2 join: K3 material master (t_ICItem / K3API Material read) -> stock-preparation ERP material intake.
//
// The delivery plan's body assumed `material.v1` was a canonical stock-prep shape to build. It is not —
// repo-wide it exists only as the K3 TEMPLATE id `k3wise.material.v1`. The stock-prep sealed-snapshot
// decoder's 16-field closed set is BOM-shaped and is NOT a material-master entry point. The real intake is
// persistStockPreparationErpMaterialSync({ erpMaterials }) via
//   POST /api/integration/stock-preparation/mvp/erp-materials/sync
// so the only thing genuinely missing between the two is this mapping. It is the whole of P2's join.
//
// VALUES-FREE NOTE: this module MAPS business values by definition — that is its job. It must never be used
// to build EVIDENCE. Callers put its output into the intake payload, never into a summary block.

// K3 source fields we consume, closed. A K3 column outside this set is IGNORED, deliberately: silently
// widening the intake as K3 gains columns is how a mapping drifts from what the target actually stores.
const K3_SOURCE_FIELDS = Object.freeze(['FItemID', 'FNumber', 'FName', 'FModel'])

// Target fields persistStockPreparationErpMaterialSync consumes, closed. Kept as data so the contract test
// can assert the mapping covers exactly this set — neither a missing key nor an invented one passes.
const INTAKE_FIELDS = Object.freeze([
  'erpMaterialId',
  'erpMaterialCode',
  'erpMaterialInternalId',
  'erpMaterialName',
  'erpSpec',
  'baseUnit',
  'inventoryUnit',
  'issueUnit',
  'unitGroup',
  'materialStatus',
  'lastSyncedAt',
])

class K3MaterialIntakeMapError extends Error {
  constructor(code) {
    // Closed-set code only. No value, no field content — a mapping error must not carry the row that
    // caused it out to the caller's error surface.
    super('k3 material intake mapping refused')
    this.name = 'K3MaterialIntakeMapError'
    this.code = code
  }
}

function requiredText(value, code) {
  if (typeof value !== 'string' && typeof value !== 'number') throw new K3MaterialIntakeMapError(code)
  const text = String(value).trim()
  if (text.length < 1) throw new K3MaterialIntakeMapError(code)
  return text
}

function optionalText(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  return String(value).trim()
}

/**
 * Map ONE K3 material row to ONE stock-preparation ERP material intake row.
 *
 * `defaults` carries what K3's t_ICItem does not: the three unit fields, the unit group, and the status.
 * They are REQUIRED arguments rather than hard-coded fallbacks — a unit silently defaulted to 'pcs' is a
 * wrong quantity downstream, and this module is not the place that gets to decide it.
 */
function mapK3MaterialToIntake(row, defaults) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new K3MaterialIntakeMapError('K3_MATERIAL_ROW_INVALID')
  }
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
    throw new K3MaterialIntakeMapError('K3_MATERIAL_DEFAULTS_INVALID')
  }
  const code = requiredText(row.FNumber, 'K3_MATERIAL_CODE_MISSING')
  const internalId = requiredText(row.FItemID, 'K3_MATERIAL_INTERNAL_ID_MISSING')
  const baseUnit = requiredText(defaults.baseUnit, 'K3_MATERIAL_BASE_UNIT_MISSING')
  const inventoryUnit = requiredText(defaults.inventoryUnit, 'K3_MATERIAL_INVENTORY_UNIT_MISSING')
  const issueUnit = requiredText(defaults.issueUnit, 'K3_MATERIAL_ISSUE_UNIT_MISSING')
  const unitGroup = requiredText(defaults.unitGroup, 'K3_MATERIAL_UNIT_GROUP_MISSING')
  const materialStatus = requiredText(defaults.materialStatus, 'K3_MATERIAL_STATUS_MISSING')
  const lastSyncedAt = requiredText(defaults.lastSyncedAt, 'K3_MATERIAL_LAST_SYNCED_AT_MISSING')
  return Object.freeze({
    // erpMaterialId is the intake's own stable handle. K3's internal id is the only stable K3 identity,
    // so derive rather than invent — an invented id would break idempotent re-sync.
    erpMaterialId: `k3:${internalId}`,
    erpMaterialCode: code,
    erpMaterialInternalId: internalId,
    erpMaterialName: optionalText(row.FName),
    erpSpec: optionalText(row.FModel),
    baseUnit,
    inventoryUnit,
    issueUnit,
    unitGroup,
    materialStatus,
    lastSyncedAt,
  })
}

function mapK3MaterialsToIntake(rows, defaults) {
  if (!Array.isArray(rows)) throw new K3MaterialIntakeMapError('K3_MATERIAL_ROWS_INVALID')
  return Object.freeze(rows.map((row) => mapK3MaterialToIntake(row, defaults)))
}

module.exports = Object.freeze({
  INTAKE_FIELDS,
  K3MaterialIntakeMapError,
  K3_SOURCE_FIELDS,
  mapK3MaterialToIntake,
  mapK3MaterialsToIntake,
})
