'use strict'

// THE READ-BACK SEAM — install ledger -> live host read -> pack-aware refresh bands.
//
// This is the suite that proves the executable gap is actually closed. Everything before it
// (contract, installer, rehearsal, ledger) makes a pack installable and recorded; NONE of it makes a
// refresh honour the pack's ownership bands, because the refresh had no way to enumerate the sheet's
// `ext_` columns. This one runs the whole chain:
//
//     installCustomerPack (writes ledger)
//        -> loadPackInstalledFieldProperties (ledger ids + live readObjectFieldsContent)
//        -> derivePackAwarePlmWritableFields (packAware bands)
//
// and against the SAME fixtures runs the negative control: no ledger, and the planner returns the
// frozen-template bands, byte-identical to the pre-pack behaviour.
//
// THE SPLIT UNDER TEST. The ledger supplies CANDIDATES + PROVENANCE; the host supplies LIVE TRUTH.
// So the interesting cases are the disagreements:
//   * a column deleted in the UI after the install  -> drops out of the host read -> gone from the
//     bands, with no invalidation protocol anywhere;
//   * a column whose stanza was re-classified live  -> the LIVE classification wins;
//   * a ledger read that fails                      -> undefined -> legacy bands, which is the SAFE
//     direction (a pack column then sits in neither band, so the refresh writes fewer columns).
//
// Hermetic: no DB, no network, no clock.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const { createStockPreparationPackInstallStore } = require(path.join(LIB, 'stock-preparation-pack-install-store.cjs'))
const { loadPackInstalledFieldProperties } = require(path.join(LIB, 'stock-preparation-pack-installed-fields.cjs'))
const { installCustomerPack } = require(path.join(LIB, 'stock-preparation-customer-pack-installer.cjs'))
const { derivePackAwarePlmWritableFields } = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require(path.join(LIB, 'stock-preparation-templates.cjs'))

const TENANT_ID = 'tenant-a'
const PROJECT_ID = 'tenant-a:integration-core'
const OBJECT_ID = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId
const TEMPLATE_FIELDS = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields

const EXT_PLM_A = 'ext_legacyRowId'
const EXT_PLM_B = 'ext_plmObjectId'
const EXT_HUMAN = 'ext_blankLength'

const SUITE_PACK = Object.freeze({
  packId: 'readback-pack',
  packVersion: 1,
  label: 'read-back suite pack',
  extensionFields: [
    { id: EXT_PLM_A, label: 'legacy id', type: 'string', ownership: 'plm_system' },
    { id: EXT_PLM_B, label: 'plm id', type: 'string', ownership: 'plm_system' },
    { id: EXT_HUMAN, label: 'blank length', type: 'number', ownership: 'human_preserved' },
  ],
  optionSets: [],
  roleViews: [],
})

const SILENT_LOGGER = { info() {}, warn() {} }

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

function createFakeDb() {
  const rows = new Map()
  return {
    rows,
    async upsertOne(table, row, { conflictColumns, updateColumns } = {}) {
      const key = conflictColumns.map((column) => String(row[column])).join(' ')
      const existing = rows.get(key)
      if (!existing) {
        const created = { ...row, last_install_at: 't1', created_at: 't1' }
        rows.set(key, created)
        return [created]
      }
      const updated = { ...existing }
      for (const column of updateColumns || Object.keys(row)) {
        if (conflictColumns.includes(column)) continue
        updated[column] = Object.prototype.hasOwnProperty.call(row, column) ? row[column] : 't2'
      }
      rows.set(key, updated)
      return [updated]
    },
    async select(table, { where } = {}) {
      return [...rows.values()].filter((row) =>
        Object.entries(where || {}).every(([column, value]) => row[column] === value))
    },
  }
}

function physicalFieldId(projectId, objectId, fieldId) {
  return `fld_${projectId}_${objectId}_${fieldId}`
}

// A host that also serves the CANONICAL template columns, so the read-back genuinely has to pick
// the pack's ids out of a populated sheet rather than a sheet that only ever held the pack.
function createFakeProvisioning() {
  const calls = []
  const fields = new Map()
  for (const field of TEMPLATE_FIELDS) {
    fields.set(field.id, {
      name: field.id,
      type: field.type,
      property: { stockPreparation: { ownership: field.ownership } },
      order: 0,
    })
  }
  return {
    calls,
    fields,
    async findObjectSheet({ objectId }) {
      calls.push(['findObjectSheet', objectId])
      return { id: `sheet_${objectId}`, baseId: null, name: objectId, description: null }
    },
    getFieldId(projectId, objectId, fieldId) {
      return physicalFieldId(projectId, objectId, fieldId)
    },
    async readObjectFieldsContent({ fieldIds }) {
      calls.push(['readObjectFieldsContent', [...fieldIds].sort()])
      const out = {}
      for (const fieldId of fieldIds) {
        if (fields.has(fieldId)) out[fieldId] = fields.get(fieldId)
      }
      return out
    },
    async ensureMissingObjectFields({ projectId, objectId, fields: descriptors }) {
      const addedFieldIds = []
      const skippedExistingFieldIds = []
      for (const descriptor of descriptors) {
        const physical = physicalFieldId(projectId, objectId, descriptor.id)
        if (fields.has(descriptor.id)) skippedExistingFieldIds.push(physical)
        else {
          fields.set(descriptor.id, {
            name: descriptor.name,
            type: descriptor.type,
            property: descriptor.property,
            order: descriptor.order,
          })
          addedFieldIds.push(physical)
        }
      }
      return { addedFieldIds, skippedExistingFieldIds }
    },
    async patchObjectFieldProperty({ fieldId, propertyPatch }) {
      const current = fields.get(fieldId) || { name: fieldId, type: 'string', property: {}, order: 0 }
      fields.set(fieldId, {
        ...current,
        property: {
          ...current.property,
          stockPreparation: { ...(current.property.stockPreparation || {}), ...propertyPatch.stockPreparation },
        },
      })
      return { ok: true }
    },
    async ensureView({ descriptor }) {
      return { id: `view_${descriptor.id}` }
    },
  }
}

async function installOnce() {
  const db = createFakeDb()
  const store = createStockPreparationPackInstallStore({ db, idGenerator: () => 'ledger_1' })
  const provisioning = createFakeProvisioning()
  await installCustomerPack({
    provisioning,
    projectId: PROJECT_ID,
    pack: SUITE_PACK,
    logger: SILENT_LOGGER,
    packInstallStore: store,
    tenantId: TENANT_ID,
  })
  return { db, store, provisioning }
}

const SCOPE = Object.freeze({ tenantId: TENANT_ID, projectId: PROJECT_ID, objectId: OBJECT_ID })

function plan(installedFieldProperties) {
  const input = { templateFields: TEMPLATE_FIELDS }
  if (installedFieldProperties !== undefined) input.installedFieldProperties = installedFieldProperties
  return derivePackAwarePlmWritableFields(input)
}

// ---------------------------------------------------------------------------
// 1. the whole chain
// ---------------------------------------------------------------------------

async function installedPackDrivesPackAwareBands() {
  const { store, provisioning } = await installOnce()

  const installed = await loadPackInstalledFieldProperties({
    packInstallStore: store,
    provisioning,
    ...SCOPE,
    logger: SILENT_LOGGER,
  })
  assert.ok(Array.isArray(installed), 'the seam returns a projection once a pack is installed')
  assert.deepEqual(installed.map((entry) => entry.fieldId).sort(), [EXT_HUMAN, EXT_PLM_A, EXT_PLM_B])
  // The WHOLE property is handed over, not a pre-chewed stanza: the host stays the single source of
  // classification, including the malformed cases the planner is written to fail closed on.
  for (const entry of installed) {
    assert.deepEqual(Object.keys(entry).sort(), ['fieldId', 'property'])
    assert.equal(typeof entry.property.stockPreparation, 'object')
  }

  const packAware = plan(installed)
  const legacy = plan(undefined)

  assert.equal(packAware.packAware, true)
  assert.equal(legacy.packAware, false, 'omitting the input is the legacy path')

  // The two PLM pack columns joined the writable band; the human one joined the wall.
  assert.deepEqual(packAware.packPlmWritableFieldIds, [EXT_PLM_A, EXT_PLM_B].sort())
  assert.deepEqual(packAware.packHumanPreservedFieldIds, [EXT_HUMAN])
  assert.deepEqual(packAware.unclassifiedPackFieldIds, [])

  // And the legacy bands contain NO `ext_` column at all — which is exactly why falling back is the
  // safe direction: a pack column is then in neither band, so a refresh writes fewer columns.
  for (const fieldId of [EXT_PLM_A, EXT_PLM_B, EXT_HUMAN]) {
    assert.equal(legacy.plmWritableFieldIds.includes(fieldId), false)
    assert.equal(legacy.humanPreservedFieldIds.includes(fieldId), false)
  }
  // The frozen template bands themselves are untouched by the pack-aware path.
  assert.deepEqual(
    packAware.plmWritableFieldIds.filter((id) => !id.startsWith('ext_')),
    legacy.plmWritableFieldIds,
  )
  assert.deepEqual(
    packAware.humanPreservedFieldIds.filter((id) => !id.startsWith('ext_')),
    legacy.humanPreservedFieldIds,
  )

  // Values-free: ids and frozen reason tokens only.
  const serialized = JSON.stringify({ installed, packAware })
  for (const leak of ['blank length', 'legacy id', 'plm id']) {
    assert.equal(serialized.includes(leak), false, `the projection must not carry ${leak}`)
  }
}

// ---------------------------------------------------------------------------
// 2. liveness — the host, not the ledger, decides what exists
// ---------------------------------------------------------------------------

async function deletedColumnDropsOut() {
  const { store, provisioning } = await installOnce()

  // Someone deletes the human column in the UI between install and refresh.
  provisioning.fields.delete(EXT_HUMAN)

  const installed = await loadPackInstalledFieldProperties({
    packInstallStore: store,
    provisioning,
    ...SCOPE,
    logger: SILENT_LOGGER,
  })
  assert.deepEqual(installed.map((entry) => entry.fieldId).sort(), [EXT_PLM_A, EXT_PLM_B])

  const bands = plan(installed)
  assert.deepEqual(bands.packHumanPreservedFieldIds, [], 'a deleted column is in no band')
  assert.equal(bands.humanPreservedFieldIds.includes(EXT_HUMAN), false)

  // The LEDGER still names it — and that is correct. The ledger records what an install landed; only
  // the host knows what survived. Staleness is resolved by the read, not by an invalidation protocol.
  const candidates = await store.listInstalledFieldIds(SCOPE)
  assert.equal(candidates.fieldIds.includes(EXT_HUMAN), true)

  // Every pack column gone → undefined → legacy, not an empty packAware projection (which would
  // report a different, misleading posture).
  provisioning.fields.delete(EXT_PLM_A)
  provisioning.fields.delete(EXT_PLM_B)
  const allGone = await loadPackInstalledFieldProperties({
    packInstallStore: store,
    provisioning,
    ...SCOPE,
    logger: SILENT_LOGGER,
  })
  assert.equal(allGone, undefined)
}

async function liveClassificationWinsOverLedgerProvenance() {
  const { store, provisioning } = await installOnce()

  // The column is re-classified LIVE (someone pins it), while the ledger still says plm_system.
  const live = provisioning.fields.get(EXT_PLM_A)
  provisioning.fields.set(EXT_PLM_A, {
    ...live,
    property: { stockPreparation: { ...live.property.stockPreparation, preserveOnRefresh: true } },
  })

  const installed = await loadPackInstalledFieldProperties({
    packInstallStore: store,
    provisioning,
    ...SCOPE,
    logger: SILENT_LOGGER,
  })
  const bands = plan(installed)
  assert.equal(bands.packHumanPreservedFieldIds.includes(EXT_PLM_A), true, 'the LIVE pin wins')
  assert.equal(bands.packPlmWritableFieldIds.includes(EXT_PLM_A), false)
  const ledgerRow = await store.getInstall({ ...SCOPE, packId: SUITE_PACK.packId })
  assert.equal(
    ledgerRow.installedFields.find((entry) => entry.fieldId === EXT_PLM_A).ownership,
    'plm_system',
    'the ledger keeps the install-time provenance; it is not the classification authority',
  )

  // A live stanza that lost its `extension: true` stamp fails CLOSED — unclassified, not writable.
  const stripped = provisioning.fields.get(EXT_PLM_B)
  provisioning.fields.set(EXT_PLM_B, {
    ...stripped,
    property: { stockPreparation: { ownership: 'plm_system' } },
  })
  const rescanned = await loadPackInstalledFieldProperties({
    packInstallStore: store,
    provisioning,
    ...SCOPE,
    logger: SILENT_LOGGER,
  })
  const reBands = plan(rescanned)
  assert.equal(reBands.unclassifiedPackFieldIds.includes(EXT_PLM_B), true)
  assert.equal(reBands.plmWritableFieldIds.includes(EXT_PLM_B), false)
}

// ---------------------------------------------------------------------------
// 3. degradation is toward legacy, and only toward legacy
// ---------------------------------------------------------------------------

async function everyUnavailabilityDegradesToLegacy() {
  const { store, provisioning } = await installOnce()
  const warnings = []
  const logger = { info() {}, warn(message) { warnings.push(message) } }

  // no store at all
  assert.equal(await loadPackInstalledFieldProperties({ provisioning, ...SCOPE, logger }), undefined)
  // a store without the read method
  assert.equal(await loadPackInstalledFieldProperties({ packInstallStore: {}, provisioning, ...SCOPE, logger }), undefined)
  // a host that cannot serve per-field reads
  assert.equal(await loadPackInstalledFieldProperties({ packInstallStore: store, provisioning: {}, ...SCOPE, logger }), undefined)
  // an incomplete scope
  assert.equal(await loadPackInstalledFieldProperties({ packInstallStore: store, provisioning, projectId: PROJECT_ID, objectId: OBJECT_ID, logger }), undefined)
  assert.equal(warnings.length, 0, 'a MISSING dependency is not a warning — it is the legacy posture')

  // a ledger read that throws
  const explodingStore = {
    async listInstalledFieldIds() {
      const error = new Error('ledger down')
      error.code = 'LEDGER_DOWN'
      throw error
    },
  }
  assert.equal(
    await loadPackInstalledFieldProperties({ packInstallStore: explodingStore, provisioning, ...SCOPE, logger }),
    undefined,
  )
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /falls back to template bands/)
  assert.match(warnings[0], /LEDGER_DOWN/)

  // a host read that throws
  const explodingProvisioning = {
    async readObjectFieldsContent() {
      const error = new Error('host down')
      error.code = 'FIELD_READ_FAILED'
      throw error
    },
  }
  assert.equal(
    await loadPackInstalledFieldProperties({ packInstallStore: store, provisioning: explodingProvisioning, ...SCOPE, logger }),
    undefined,
  )
  assert.equal(warnings.length, 2)

  // no pack installed on this sheet: the accurate answer IS legacy, and it is not a warning.
  const emptyDb = createFakeDb()
  const emptyStore = createStockPreparationPackInstallStore({ db: emptyDb, idGenerator: () => 'ledger_empty' })
  assert.equal(
    await loadPackInstalledFieldProperties({ packInstallStore: emptyStore, provisioning, ...SCOPE, logger }),
    undefined,
  )
  assert.equal(warnings.length, 2, 'an empty ledger is not a failure')

  // Every degraded answer is the SAME answer, and it is the pre-pack one.
  assert.deepEqual(plan(undefined).plmWritableFieldIds, plan(undefined).plmWritableFieldIds)
  assert.equal(plan(undefined).packAware, false)

  // A FAILED install never contributes candidates, so a failed install cannot widen a refresh.
  await store.recordInstall({
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    objectId: OBJECT_ID,
    packId: 'failed-pack',
    packVersion: '1',
    status: 'failed',
    installedFields: [{ fieldId: 'ext_neverLanded', ownership: 'plm_system', preserveOnRefresh: false, extension: true }],
  })
  const afterFailed = await loadPackInstalledFieldProperties({
    packInstallStore: store,
    provisioning,
    ...SCOPE,
    logger,
  })
  assert.equal(afterFailed.some((entry) => entry.fieldId === 'ext_neverLanded'), false)
}

async function main() {
  await installedPackDrivesPackAwareBands()
  await deletedColumnDropsOut()
  await liveClassificationWinsOverLedgerProvenance()
  await everyUnavailabilityDegradesToLegacy()
}

main().then(
  () => {
    console.log('stock-preparation-pack-install-readback.test.cjs OK')
  },
  (error) => {
    console.error(error)
    process.exit(1)
  },
)
