'use strict'

// P0 — customer config pack INSTALLER battery.
// Plain node test (throws on failure). No DB, no network: the host multitable
// provisioning API is a mock that reproduces the three semantics this installer
// depends on — ensureMissingObjectFields is ON CONFLICT DO NOTHING (additive,
// never mutating), readObjectFieldsContent reads {logicalId: {name,type,property,
// order}} for the fields that physically exist, and patchObjectFieldProperty
// merges a property patch RECURSIVELY (multitable/provisioning.ts mergeJsonObject
// — a nested object patch merges key-by-key rather than replacing the branch,
// which is exactly what lets an ownership stamp and a synced option set share the
// `stockPreparation` namespace on one column).
// Values-free: only schema ids, business column labels and material grade
// samples appear.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const INSTALLER_PATH = path.join(__dirname, '..', 'lib', 'stock-preparation-customer-pack-installer.cjs')
const SAMPLE_PATH = path.join(__dirname, '..', 'lib', 'customer-packs', 'factory-a.sample.cjs')

const {
  EXTENSION_FIELD_ORDER_BASE,
  REQUIRED_PROVISIONING_METHODS,
  StockPreparationCustomerPackInstallError,
  installCustomerPack,
  __internals,
} = require(INSTALLER_PATH)

const { FACTORY_A_SAMPLE_PACK } = require(SAMPLE_PATH)

const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  HUMAN_PRESERVED_FIELD_IDS,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-templates.cjs'))

const { normalizeCustomerPack } = require(path.join(__dirname, '..', 'lib', 'stock-preparation-customer-pack.cjs'))

const PROJECT_ID = 'proj_unit'
const OBJECT_ID = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId
const SILENT_LOGGER = { info() {} }

// Physical id shape only has to be stable and derived from (project, object,
// field) — exactly the contract getFieldId offers. The real host hashes; the
// mock concatenates, which is enough to prove the installer never hands the
// host a LOGICAL id where a physical one is expected.
function physicalFieldId(projectId, objectId, fieldId) {
  return `fld_${projectId}_${objectId}_${fieldId}`
}

// Byte-for-byte the host's property merge (multitable/provisioning.ts
// mergeJsonObject): nested plain objects merge, everything else replaces. A
// shallow spread here would be a LIE about the host and would make the ownership
// stamp look like it wipes a synced option set.
function mergeJsonObjectLikeHost(base, patch) {
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (
      value && typeof value === 'object' && !Array.isArray(value)
      && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])
    ) {
      out[key] = mergeJsonObjectLikeHost(out[key], value)
    } else {
      out[key] = value
    }
  }
  return out
}

// The generic multitable ownership write-guard's predicate
// (adapters/multitable-ownership-guard.cjs isProtectedFieldProperty), restated
// here so this suite can assert what the guard would CONCLUDE about a column —
// the whole point of stamping ownership onto a hand-built one.
function guardWouldProtect(property) {
  if (!property || typeof property !== 'object') return false
  for (const namespace of ['stockPreparation', 'stockPreparationMvp']) {
    const meta = property[namespace]
    if (!meta || typeof meta !== 'object') continue
    if (meta.ownership === 'human_preserved') return true
    if (meta.preserveOnRefresh === true) return true
  }
  return false
}

/**
 * Mock host provisioning API.
 *
 * `sheetMissing` reproduces the not-yet-provisioned canonical table.
 * `ensureObject` is present but POISONED: the installer must never call it
 * (calling it on a live table would rewrite every field property wholesale and
 * wipe the options a previous install synced).
 */
function createMockProvisioning({ sheetMissing = false } = {}) {
  const fieldsByPhysicalId = new Map()
  const viewsById = new Map()
  const calls = {
    findObjectSheet: [],
    readObjectFieldsContent: [],
    ensureMissingObjectFields: [],
    patchObjectFieldProperty: [],
    ensureView: [],
    ensureObject: [],
  }
  // Seed the frozen template's own columns, as a real provisioned table has.
  if (!sheetMissing) {
    for (const [order, field] of STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.entries()) {
      fieldsByPhysicalId.set(physicalFieldId(PROJECT_ID, OBJECT_ID, field.id), {
        name: field.label,
        type: field.type,
        property: { stockPreparation: { ownership: field.ownership } },
        order,
      })
    }
  }

  const provisioning = {
    getFieldId: (projectId, objectId, fieldId) => physicalFieldId(projectId, objectId, fieldId),
    async findObjectSheet({ projectId, objectId }) {
      calls.findObjectSheet.push({ projectId, objectId })
      if (sheetMissing) return null
      return { id: `sheet_${objectId}`, baseId: 'base_unit', name: objectId, description: null }
    },
    // SELECT-only content read keyed by LOGICAL id, present-fields only — exactly
    // the host shape (multitable/provisioning.ts readObjectFieldsContent).
    async readObjectFieldsContent({ projectId, objectId, fieldIds }) {
      calls.readObjectFieldsContent.push({ projectId, objectId, fieldIds })
      const out = {}
      for (const fieldId of fieldIds || []) {
        const row = fieldsByPhysicalId.get(physicalFieldId(projectId, objectId, fieldId))
        if (!row) continue
        out[fieldId] = {
          name: row.name,
          type: row.type,
          property: JSON.parse(JSON.stringify(row.property || {})),
          order: row.order,
        }
      }
      return out
    },
    // ON CONFLICT (id) DO NOTHING — no UPDATE, no DELETE, exactly like the host
    // primitive (multitable/provisioning.ts ensureMissingObjectFields).
    async ensureMissingObjectFields({ projectId, objectId, fields }) {
      calls.ensureMissingObjectFields.push({ projectId, objectId, fields })
      const addedFieldIds = []
      const skippedExistingFieldIds = []
      for (const [index, field] of (fields || []).entries()) {
        const id = physicalFieldId(projectId, objectId, field.id)
        if (fieldsByPhysicalId.has(id)) {
          skippedExistingFieldIds.push(id)
          continue
        }
        fieldsByPhysicalId.set(id, {
          name: field.name,
          type: field.type,
          property: JSON.parse(JSON.stringify(field.property || {})),
          order: typeof field.order === 'number' ? field.order : index,
        })
        addedFieldIds.push(id)
      }
      return { addedFieldIds, skippedExistingFieldIds }
    },
    async patchObjectFieldProperty({ projectId, objectId, fieldId, propertyPatch }) {
      calls.patchObjectFieldProperty.push({ projectId, objectId, fieldId, propertyPatch })
      const id = physicalFieldId(projectId, objectId, fieldId)
      const row = fieldsByPhysicalId.get(id)
      if (!row) throw new Error(`mock: provisioned field not found: ${objectId}.${fieldId}`)
      row.property = mergeJsonObjectLikeHost(row.property || {}, JSON.parse(JSON.stringify(propertyPatch)))
      return { id, sheetId: `sheet_${objectId}`, name: row.name, type: row.type, property: row.property, order: row.order }
    },
    async ensureView({ projectId, sheetId, descriptor }) {
      calls.ensureView.push({ projectId, sheetId, descriptor })
      const id = `view_${descriptor.objectId}_${descriptor.id}`
      viewsById.set(id, {
        id,
        sheetId,
        name: descriptor.name,
        type: descriptor.type,
        hiddenFieldIds: [...(descriptor.hiddenFieldIds || [])],
        config: descriptor.config,
      })
      return viewsById.get(id)
    },
    async ensureObject(input) {
      calls.ensureObject.push(input)
      throw new Error('mock: ensureObject must never be called by the customer pack installer')
    },
  }
  return { provisioning, calls, fieldsByPhysicalId, viewsById }
}

function fieldsSnapshot(fieldsByPhysicalId) {
  return JSON.stringify([...fieldsByPhysicalId.entries()].sort((a, b) => a[0].localeCompare(b[0])))
}

async function apiSurfaceFailsClosed() {
  // Every required method is genuinely required, one at a time.
  for (const method of REQUIRED_PROVISIONING_METHODS) {
    const { provisioning } = createMockProvisioning()
    delete provisioning[method]
    await assert.rejects(
      () => installCustomerPack({ provisioning, projectId: PROJECT_ID, pack: FACTORY_A_SAMPLE_PACK, logger: SILENT_LOGGER }),
      (error) => error instanceof StockPreparationCustomerPackInstallError
        && error.code === 'CUSTOMER_PACK_API_UNAVAILABLE'
        && error.details.missingMethods.includes(method),
      `missing ${method} must fail closed`,
    )
  }
  // ensureObject is deliberately NOT on the required list — requiring it would
  // invite a future edit to reach for the property-clobbering primitive.
  assert.equal(REQUIRED_PROVISIONING_METHODS.includes('ensureObject'), false)

  const { provisioning } = createMockProvisioning()
  await assert.rejects(
    () => installCustomerPack({ provisioning, projectId: '  ', pack: FACTORY_A_SAMPLE_PACK, logger: SILENT_LOGGER }),
    (error) => error.code === 'CUSTOMER_PACK_PROJECT_ID_REQUIRED',
    'a blank projectId must fail closed',
  )
}

async function absentTargetFailsClosed() {
  const { provisioning, calls } = createMockProvisioning({ sheetMissing: true })
  await assert.rejects(
    () => installCustomerPack({ provisioning, projectId: PROJECT_ID, pack: FACTORY_A_SAMPLE_PACK, logger: SILENT_LOGGER }),
    (error) => error instanceof StockPreparationCustomerPackInstallError
      && error.code === 'CUSTOMER_PACK_TARGET_ABSENT'
      && error.details.objectId === OBJECT_ID,
    'an unprovisioned canonical target must fail closed, not be created here',
  )
  // The precondition must fail BEFORE any write is attempted.
  assert.equal(calls.ensureMissingObjectFields.length, 0)
  assert.equal(calls.patchObjectFieldProperty.length, 0)
  assert.equal(calls.ensureView.length, 0)
  assert.equal(calls.ensureObject.length, 0)
}

async function firstRunCreatesFieldsAdditively() {
  const { provisioning, calls, fieldsByPhysicalId } = createMockProvisioning()
  const templateFieldCount = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.length
  const before = fieldsSnapshot(fieldsByPhysicalId)

  const summary = await installCustomerPack({
    provisioning,
    projectId: PROJECT_ID,
    pack: FACTORY_A_SAMPLE_PACK,
    logger: SILENT_LOGGER,
  })

  assert.equal(calls.ensureObject.length, 0, 'ensureObject must never be called')
  assert.equal(calls.ensureMissingObjectFields.length, 1, 'one additive write for the whole pack')
  assert.deepEqual(summary.createdFields, FACTORY_A_SAMPLE_PACK.extensionFields.map((field) => field.id))
  assert.deepEqual(summary.skippedFields, [])
  assert.equal(summary.packId, 'factory-a')
  assert.equal(summary.objectId, OBJECT_ID)
  assert.equal(fieldsByPhysicalId.size, templateFieldCount + 10, 'ten columns added, none replaced')

  // ADDITIVE: every pre-existing template column is byte-for-byte untouched.
  const templateOnlyAfter = new Map(
    [...fieldsByPhysicalId.entries()].filter(([id]) => !id.includes('_ext_')),
  )
  assert.equal(fieldsSnapshot(templateOnlyAfter), before, 'no pre-existing column may change')

  // Descriptors carry no inline `options` — the host would fold them into the
  // property, which is exactly the inline-options path the template bans.
  const descriptors = calls.ensureMissingObjectFields[0].fields
  for (const descriptor of descriptors) {
    assert.equal('options' in descriptor, false, `${descriptor.id} must not carry inline options`)
    assert.ok(descriptor.order >= EXTENSION_FIELD_ORDER_BASE, `${descriptor.id} must sort after template columns`)
  }

  return { calls, fieldsByPhysicalId, summary }
}

function ownershipPropertyPayload(calls) {
  const descriptorsById = new Map(calls.ensureMissingObjectFields[0].fields.map((field) => [field.id, field]))

  const systemField = descriptorsById.get('ext_legacyRowId')
  assert.deepEqual(systemField.property.stockPreparation, {
    ownership: 'plm_system',
    preserveOnRefresh: false,
    required: false,
    key: false,
    extension: true,
    packId: 'factory-a',
    packVersion: 1,
  })

  const humanField = descriptorsById.get('ext_blankLength')
  assert.equal(humanField.property.stockPreparation.ownership, 'human_preserved')
  assert.equal(
    humanField.property.stockPreparation.preserveOnRefresh,
    true,
    'a human-owned pack column must survive a PLM refresh',
  )
  assert.equal(humanField.property.stockPreparation.extension, true)

  // Ownership is never invented: every value comes from the template vocabulary.
  for (const descriptor of descriptorsById.values()) {
    assert.ok(
      ['plm_system', 'human_preserved'].includes(descriptor.property.stockPreparation.ownership),
      `${descriptor.id} ownership must be in the template vocabulary`,
    )
  }
}

function optionSyncPayload(calls) {
  assert.equal(calls.patchObjectFieldProperty.length, 1, 'one option field in the sample pack')
  const patch = calls.patchObjectFieldProperty[0]
  assert.equal(patch.objectId, OBJECT_ID)
  assert.equal(patch.fieldId, 'ext_standard', 'the kernel is handed the LOGICAL field id')
  assert.equal(patch.propertyPatch.options.length, 12)
  // Sanitized shape: `value` (plus optional label/color/disabled) only.
  for (const option of patch.propertyPatch.options) {
    assert.deepEqual(Object.keys(option), ['value'])
  }
  assert.deepEqual(patch.propertyPatch.stockPreparation.optionSource, { type: 'config_info', key: 'ext_standard' })
  assert.equal(patch.propertyPatch.stockPreparation.optionSync.optionCount, 12)
  assert.deepEqual(patch.propertyPatch.stockPreparation.customerPack, {
    packId: 'factory-a',
    packVersion: 1,
    fieldId: 'ext_standard',
  })
}

async function optionSetOnATemplateFieldKeepsTemplateSource() {
  // A pack may supply the dictionary for a frozen template select column. The
  // patch must carry the TEMPLATE's declared optionSource, not a pack-derived
  // one — an install must not silently re-label a canonical column's origin.
  const { provisioning, calls } = createMockProvisioning()
  await installCustomerPack({
    provisioning,
    projectId: PROJECT_ID,
    logger: SILENT_LOGGER,
    pack: {
      packId: 'template-source',
      packVersion: 3,
      extensionFields: [],
      optionSets: [{ fieldId: 'materialType', options: [{ value: '20 - S30408' }, { value: '30 - Q345R' }] }],
      roleViews: [],
    },
  })
  const patch = calls.patchObjectFieldProperty[0]
  assert.equal(patch.fieldId, 'materialType')
  assert.deepEqual(patch.propertyPatch.stockPreparation.optionSource, { type: 'config_info', key: 'material_type' })
  assert.equal(patch.propertyPatch.stockPreparation.optionSync.sourceKey, 'material_type')
}

function roleViewHiddenFieldIds(calls) {
  assert.equal(calls.ensureView.length, 2)
  const [production, procurement] = calls.ensureView.map((call) => call.descriptor)

  assert.equal(production.id, 'sp-factory-a-production')
  assert.equal(production.objectId, OBJECT_ID)
  assert.equal(production.name, '生产备料视图')
  assert.equal(production.type, 'grid')

  // hideOwnerships resolves across BOTH catalogs, and every id reaching the
  // host is PHYSICAL (meta_views.hidden_field_ids is compared to meta_fields.id).
  const expectedProductionHidden = [
    'lastPlmConflictSummary',
    ...HUMAN_PRESERVED_FIELD_IDS,
    'ext_blankLength',
    'ext_blankWidth',
    'ext_blankQuantity',
  ].map((fieldId) => physicalFieldId(PROJECT_ID, OBJECT_ID, fieldId))
  assert.deepEqual(
    [...production.hiddenFieldIds].sort(),
    [...expectedProductionHidden].sort(),
    'production view hides the human band plus the named column',
  )
  for (const hidden of production.hiddenFieldIds) {
    assert.ok(hidden.startsWith('fld_'), 'hiddenFieldIds must be physical ids, never logical ones')
  }
  // A PLM/system column is not swept up by the human band.
  assert.equal(
    production.hiddenFieldIds.includes(physicalFieldId(PROJECT_ID, OBJECT_ID, 'componentCode')),
    false,
  )

  assert.equal(procurement.id, 'sp-factory-a-procurement')
  assert.deepEqual(
    [...procurement.hiddenFieldIds].sort(),
    ['idempotencyKey', 'componentSourceId', 'parentSourceId', 'path', 'ext_legacyRowId', 'ext_plmObjectId', 'ext_parentLegacyId']
      .map((fieldId) => physicalFieldId(PROJECT_ID, OBJECT_ID, fieldId))
      .sort(),
    'with an empty ownership band, only the named columns are hidden',
  )

  // The view config is values-free provenance, no dictionary content.
  assert.deepEqual(production.config.stockPreparationCustomerPack, {
    packId: 'factory-a',
    packVersion: 1,
    roleViewId: 'production',
    hideOwnerships: ['human_preserved'],
    hiddenFieldCount: production.hiddenFieldIds.length,
  })
}

async function secondRunIsANoOpOnFields() {
  const { provisioning, calls, fieldsByPhysicalId } = createMockProvisioning()
  const first = await installCustomerPack({
    provisioning,
    projectId: PROJECT_ID,
    pack: FACTORY_A_SAMPLE_PACK,
    logger: SILENT_LOGGER,
  })
  const afterFirst = fieldsSnapshot(fieldsByPhysicalId)

  const second = await installCustomerPack({
    provisioning,
    projectId: PROJECT_ID,
    pack: FACTORY_A_SAMPLE_PACK,
    logger: SILENT_LOGGER,
  })

  assert.equal(calls.ensureObject.length, 0, 'a re-run must still never call ensureObject')
  assert.deepEqual(second.createdFields, [], 'a re-run creates no column')
  assert.deepEqual(second.skippedFields, first.createdFields, 'every pack column is reported as already present')
  // A column this installer CREATED is born classified, so the re-run finds it
  // already stamped and patches nothing.
  assert.deepEqual(first.stampedExistingFields, [], 'a fresh install has nothing pre-existing to stamp')
  assert.deepEqual(first.alreadyStampedFields, [])
  assert.deepEqual(second.stampedExistingFields, [], 'a re-run never re-stamps')
  assert.deepEqual(second.alreadyStampedFields, first.createdFields)
  assert.equal(
    fieldsSnapshot(fieldsByPhysicalId),
    afterFirst,
    'the second run leaves every field row byte-identical (DO NOTHING semantics)',
  )

  // Both runs submitted an identical descriptor set and an identical option
  // patch — "idempotent" as a fact about the wire, not just about the summary.
  assert.deepEqual(
    calls.ensureMissingObjectFields[1].fields,
    calls.ensureMissingObjectFields[0].fields,
    'identical additive descriptors on both runs',
  )
  assert.deepEqual(
    calls.patchObjectFieldProperty[1].propertyPatch,
    calls.patchObjectFieldProperty[0].propertyPatch,
    'identical option patch on both runs',
  )
  assert.deepEqual(
    calls.ensureView.slice(2).map((call) => call.descriptor),
    calls.ensureView.slice(0, 2).map((call) => call.descriptor),
    'identical view descriptors on both runs',
  )
  assert.deepEqual(second.syncedOptionFields, first.syncedOptionFields)
  assert.deepEqual(second.ensuredViews, first.ensuredViews)
}

async function partialPreexistingFieldsAreSkippedNotRewritten() {
  // The realistic migration case: the hand-built sheet already carries some of
  // the pack's columns. Their COLUMN IDENTITY (name, type, order) and any
  // unrelated property keys must survive untouched — the additive primitive
  // cannot rewrite them and nothing else may either. The one thing the install
  // does add is the ownership classification the column was missing.
  const { provisioning, calls, fieldsByPhysicalId } = createMockProvisioning()
  const squatted = physicalFieldId(PROJECT_ID, OBJECT_ID, 'ext_legacyRowId')
  fieldsByPhysicalId.set(squatted, {
    name: '旧系统ID（人工建列）',
    type: 'string',
    property: { handBuilt: true },
    order: 42,
  })

  const summary = await installCustomerPack({
    provisioning,
    projectId: PROJECT_ID,
    pack: FACTORY_A_SAMPLE_PACK,
    logger: SILENT_LOGGER,
  })

  assert.deepEqual(summary.skippedFields, ['ext_legacyRowId'])
  assert.equal(summary.createdFields.length, 9)
  assert.deepEqual(summary.stampedExistingFields, ['ext_legacyRowId'])
  assert.deepEqual(summary.alreadyStampedFields, [])

  const after = fieldsByPhysicalId.get(squatted)
  assert.equal(after.name, '旧系统ID（人工建列）', 'a tenant rename survives the install')
  assert.equal(after.type, 'string')
  assert.equal(after.order, 42, 'the hand-built column keeps its position')
  assert.equal(after.property.handBuilt, true, 'unrelated property keys survive the stamp')
  assert.deepEqual(after.property.stockPreparation, {
    ownership: 'plm_system',
    preserveOnRefresh: false,
    extension: true,
    packId: 'factory-a',
    packVersion: 1,
  }, 'the skipped column is classified, not left unowned')
  assert.equal(calls.ensureObject.length, 0)
}

// Seed every pack column as a HAND-BUILT one: it exists, it has a tenant label
// and position, and its property is the empty object a UI-dragged column gets.
// This is the takeover sheet, not a hypothetical.
function seedHandBuiltPackColumns(fieldsByPhysicalId, { property = {} } = {}) {
  for (const [index, field] of FACTORY_A_SAMPLE_PACK.extensionFields.entries()) {
    fieldsByPhysicalId.set(physicalFieldId(PROJECT_ID, OBJECT_ID, field.id), {
      name: `${field.label}（人工建列）`,
      type: field.type,
      property: JSON.parse(JSON.stringify(property)),
      order: 500 + index,
    })
  }
}

async function handBuiltSheetIsClassifiedNotLeftUnowned() {
  // THE regression this battery exists for. Before the ownership pre-scan, an
  // install onto a fully hand-built sheet created nothing (every column already
  // existed), stamped nothing, and reported success — leaving every human column
  // with `property: {}`. The generic multitable ownership write-guard protects a
  // field only when a stanza says human_preserved / preserveOnRefresh, so the
  // customer's decision columns stayed writable by any pipeline that pointed at
  // the sheet. A "successful" install that silently disarms the guard is worse
  // than a failed one.
  const { provisioning, calls, fieldsByPhysicalId } = createMockProvisioning()
  seedHandBuiltPackColumns(fieldsByPhysicalId)

  // Precondition: the guard would protect NOTHING on this sheet.
  for (const field of FACTORY_A_SAMPLE_PACK.extensionFields) {
    const row = fieldsByPhysicalId.get(physicalFieldId(PROJECT_ID, OBJECT_ID, field.id))
    assert.equal(guardWouldProtect(row.property), false, `${field.id} starts unprotected`)
  }

  const summary = await installCustomerPack({
    provisioning,
    projectId: PROJECT_ID,
    pack: FACTORY_A_SAMPLE_PACK,
    logger: SILENT_LOGGER,
  })

  assert.equal(calls.ensureObject.length, 0, 'convergence is still additive-only')
  assert.deepEqual(summary.createdFields, [], 'nothing to create — the sheet already has every column')
  assert.deepEqual(
    summary.stampedExistingFields,
    FACTORY_A_SAMPLE_PACK.extensionFields.map((field) => field.id),
    'every pre-existing pack column is classified',
  )
  assert.deepEqual(summary.alreadyStampedFields, [])
  // The pre-scan is a READ, and it happens before the additive write.
  assert.equal(calls.readObjectFieldsContent.length, 1, 'one pre-scan for the whole pack')
  assert.deepEqual(
    calls.readObjectFieldsContent[0].fieldIds,
    FACTORY_A_SAMPLE_PACK.extensionFields.map((field) => field.id),
  )

  for (const field of FACTORY_A_SAMPLE_PACK.extensionFields) {
    const row = fieldsByPhysicalId.get(physicalFieldId(PROJECT_ID, OBJECT_ID, field.id))
    const expectedPreserve = field.ownership === 'human_preserved'
    assert.deepEqual(
      row.property.stockPreparation.ownership,
      field.ownership,
      `${field.id} carries the pack's ownership`,
    )
    assert.equal(row.property.stockPreparation.preserveOnRefresh, expectedPreserve)
    assert.equal(row.property.stockPreparation.extension, true)
    assert.equal(row.property.stockPreparation.packId, 'factory-a')
    assert.equal(row.property.stockPreparation.packVersion, 1)
    // Column identity is never rewritten — only the property gains keys.
    assert.equal(row.name, `${field.label}（人工建列）`, `${field.id} keeps its hand-built label`)
    assert.ok(row.order >= 500, `${field.id} keeps its hand-built position`)
    // The guard-relevant CONCLUSION, which is the whole point of the stamp.
    assert.equal(
      guardWouldProtect(row.property),
      expectedPreserve,
      `${field.id} protection must now follow its declared ownership`,
    )
  }

  // The ownership stamp and the option sync share the `stockPreparation`
  // namespace on ext_standard; the host's recursive merge must leave both.
  const standard = fieldsByPhysicalId.get(physicalFieldId(PROJECT_ID, OBJECT_ID, 'ext_standard'))
  assert.equal(standard.property.stockPreparation.ownership, 'plm_system', 'the stamp survives the option patch')
  assert.equal(standard.property.options.length, 12, 'and the option set survives the stamp')

  // A converged sheet re-runs to a no-op: nothing created, nothing re-stamped.
  const second = await installCustomerPack({
    provisioning,
    projectId: PROJECT_ID,
    pack: FACTORY_A_SAMPLE_PACK,
    logger: SILENT_LOGGER,
  })
  assert.deepEqual(second.createdFields, [])
  assert.deepEqual(second.stampedExistingFields, [], 'a converged sheet is never re-stamped')
  assert.deepEqual(
    second.alreadyStampedFields,
    FACTORY_A_SAMPLE_PACK.extensionFields.map((field) => field.id),
  )
}

async function identicalStanzaIsAlreadyStampedWithNoPatch() {
  // A column that already carries exactly the pack's classification is a no-op:
  // counted, never patched. "Idempotent" has to be a fact about the wire.
  const { provisioning, calls, fieldsByPhysicalId } = createMockProvisioning()
  for (const field of FACTORY_A_SAMPLE_PACK.extensionFields) {
    fieldsByPhysicalId.set(physicalFieldId(PROJECT_ID, OBJECT_ID, field.id), {
      name: field.label,
      type: field.type,
      property: {
        stockPreparation: {
          ownership: field.ownership,
          preserveOnRefresh: field.ownership === 'human_preserved',
        },
      },
      order: 900,
    })
  }

  const summary = await installCustomerPack({
    provisioning,
    projectId: PROJECT_ID,
    pack: FACTORY_A_SAMPLE_PACK,
    logger: SILENT_LOGGER,
  })

  assert.deepEqual(summary.createdFields, [])
  assert.deepEqual(summary.stampedExistingFields, [], 'an identical stanza is not re-written')
  assert.deepEqual(
    summary.alreadyStampedFields,
    FACTORY_A_SAMPLE_PACK.extensionFields.map((field) => field.id),
  )
  // The only property patch on the wire is the option sync — no ownership patch.
  assert.deepEqual(
    calls.patchObjectFieldProperty.map((call) => call.fieldId),
    ['ext_standard'],
    'the only patch is the option sync, never an ownership re-stamp',
  )
}

async function conflictingOwnershipAbortsBeforeAnyMutation() {
  // The live sheet says this column is system-owned; the pack says a human owns
  // it. Either direction is a re-classification of a LIVE column, and an
  // installer does not get to make that call on its way past. Fail closed, and
  // fail before a single field is created or patched — a half-applied pack on a
  // customer's production sheet is not a state anyone can reason about.
  for (const [declared, packOwnership, victim] of [
    ['plm_system', 'human_preserved', 'ext_blankLength'],
    ['human_preserved', 'plm_system', 'ext_legacyRowId'],
  ]) {
    const { provisioning, calls, fieldsByPhysicalId } = createMockProvisioning()
    seedHandBuiltPackColumns(fieldsByPhysicalId)
    const physical = physicalFieldId(PROJECT_ID, OBJECT_ID, victim)
    fieldsByPhysicalId.get(physical).property = {
      stockPreparation: { ownership: declared, preserveOnRefresh: declared === 'human_preserved' },
    }
    const before = fieldsSnapshot(fieldsByPhysicalId)

    await assert.rejects(
      () => installCustomerPack({
        provisioning,
        projectId: PROJECT_ID,
        pack: FACTORY_A_SAMPLE_PACK,
        logger: SILENT_LOGGER,
      }),
      (error) => error instanceof StockPreparationCustomerPackInstallError
        && error.code === 'CUSTOMER_PACK_OWNERSHIP_CONFLICT'
        && error.status === 409
        && error.details.conflictingFields.includes(victim)
        && error.details.conflicts.some(
          (entry) => entry.field === victim && entry.declared === declared && entry.property === 'ownership',
        ),
      `a live ${declared} column must not be silently re-classified as ${packOwnership}`,
    )

    // ZERO mutations: no create, no patch, no view, and nothing moved in the store.
    assert.equal(calls.ensureMissingObjectFields.length, 0, 'aborted before the additive write')
    assert.equal(calls.patchObjectFieldProperty.length, 0, 'aborted before any property patch')
    assert.equal(calls.ensureView.length, 0, 'aborted before any view write')
    assert.equal(calls.ensureObject.length, 0)
    assert.equal(fieldsSnapshot(fieldsByPhysicalId), before, 'the sheet is byte-identical after the refusal')
  }
}

async function conflictDetectionSpansBothGuardNamespaces() {
  // The write-guard ORs `stockPreparation` and `stockPreparationMvp`, so a
  // contradiction in the MVP namespace is just as real. The installer never
  // WRITES that namespace — it only refuses to contradict it.
  const { provisioning, calls, fieldsByPhysicalId } = createMockProvisioning()
  seedHandBuiltPackColumns(fieldsByPhysicalId)
  fieldsByPhysicalId.get(physicalFieldId(PROJECT_ID, OBJECT_ID, 'ext_legacyRowId')).property = {
    stockPreparationMvp: { role: 'main', ownership: 'human_preserved' },
  }
  await assert.rejects(
    () => installCustomerPack({ provisioning, projectId: PROJECT_ID, pack: FACTORY_A_SAMPLE_PACK, logger: SILENT_LOGGER }),
    (error) => error.code === 'CUSTOMER_PACK_OWNERSHIP_CONFLICT'
      && error.details.conflicts.some(
        (entry) => entry.field === 'ext_legacyRowId' && entry.namespace === 'stockPreparationMvp',
      ),
    'an MVP-namespace contradiction is a contradiction',
  )
  assert.equal(calls.ensureMissingObjectFields.length, 0)
  assert.equal(calls.patchObjectFieldProperty.length, 0)

  // A junk-typed declaration is a conflict too: an installer that cannot READ a
  // live classification must never overwrite it.
  const junk = createMockProvisioning()
  seedHandBuiltPackColumns(junk.fieldsByPhysicalId)
  junk.fieldsByPhysicalId.get(physicalFieldId(PROJECT_ID, OBJECT_ID, 'ext_blankWidth')).property = {
    stockPreparation: { preserveOnRefresh: 'yes' },
  }
  await assert.rejects(
    () => installCustomerPack({
      provisioning: junk.provisioning,
      projectId: PROJECT_ID,
      pack: FACTORY_A_SAMPLE_PACK,
      logger: SILENT_LOGGER,
    }),
    (error) => error.code === 'CUSTOMER_PACK_OWNERSHIP_CONFLICT'
      && error.details.conflicts.some(
        (entry) => entry.field === 'ext_blankWidth' && entry.declared === 'unrecognized',
      ),
    'an unreadable declaration fails closed and is never echoed verbatim',
  )
}

async function unreadableOwnershipFailsClosed() {
  // Same posture as the write-guard's unverifiable-metadata refusal: if the
  // pre-scan cannot run, the installer cannot tell a converged sheet from a
  // hand-built one, so it must not write.
  const { provisioning, calls } = createMockProvisioning()
  provisioning.readObjectFieldsContent = async () => {
    const error = new Error('mock: read refused')
    error.code = 'MOCK_READ_REFUSED'
    throw error
  }
  await assert.rejects(
    () => installCustomerPack({ provisioning, projectId: PROJECT_ID, pack: FACTORY_A_SAMPLE_PACK, logger: SILENT_LOGGER }),
    (error) => error instanceof StockPreparationCustomerPackInstallError
      && error.code === 'CUSTOMER_PACK_OWNERSHIP_UNVERIFIED'
      && error.details.errorCode === 'MOCK_READ_REFUSED',
    'an unverifiable ownership state must stop the install',
  )
  assert.equal(calls.ensureMissingObjectFields.length, 0)
  assert.equal(calls.patchObjectFieldProperty.length, 0)
}

async function ownershipStampFailurePropagatesAsAClosedCode() {
  const { provisioning, fieldsByPhysicalId } = createMockProvisioning()
  seedHandBuiltPackColumns(fieldsByPhysicalId)
  provisioning.patchObjectFieldProperty = async () => {
    const error = new Error('mock: stamp refused')
    error.code = 'MOCK_STAMP_REFUSED'
    throw error
  }
  await assert.rejects(
    () => installCustomerPack({ provisioning, projectId: PROJECT_ID, pack: FACTORY_A_SAMPLE_PACK, logger: SILENT_LOGGER }),
    (error) => error instanceof StockPreparationCustomerPackInstallError
      && error.code === 'CUSTOMER_PACK_OWNERSHIP_STAMP_FAILED'
      && error.details.errorCode === 'MOCK_STAMP_REFUSED',
    'a refused ownership stamp must not be swallowed',
  )
}

async function optionPatchFailurePropagatesAsAClosedCode() {
  const { provisioning } = createMockProvisioning()
  provisioning.patchObjectFieldProperty = async () => {
    const error = new Error('mock: patch refused')
    error.code = 'MOCK_PATCH_REFUSED'
    throw error
  }
  await assert.rejects(
    () => installCustomerPack({ provisioning, projectId: PROJECT_ID, pack: FACTORY_A_SAMPLE_PACK, logger: SILENT_LOGGER }),
    (error) => error instanceof StockPreparationCustomerPackInstallError
      && error.code === 'CUSTOMER_PACK_OPTION_SYNC_FAILED'
      && error.details.field === 'ext_standard'
      && error.details.errorCode === 'MOCK_PATCH_REFUSED',
    'a host patch failure must surface in the installer vocabulary',
  )
}

async function viewFailurePropagatesAsAClosedCode() {
  const { provisioning } = createMockProvisioning()
  provisioning.ensureView = async () => null
  await assert.rejects(
    () => installCustomerPack({ provisioning, projectId: PROJECT_ID, pack: FACTORY_A_SAMPLE_PACK, logger: SILENT_LOGGER }),
    (error) => error instanceof StockPreparationCustomerPackInstallError
      && error.code === 'CUSTOMER_PACK_VIEW_FAILED'
      && error.details.roleViewId === 'production',
    'a view that comes back without an id must fail closed',
  )
}

async function packWithoutOptionSetsSkipsTheKernel() {
  // The shared kernel throws when nothing syncs, so a pack with no dictionary
  // must not enter it at all.
  const { provisioning, calls } = createMockProvisioning()
  const summary = await installCustomerPack({
    provisioning,
    projectId: PROJECT_ID,
    logger: SILENT_LOGGER,
    pack: {
      packId: 'no-dictionary',
      packVersion: 1,
      extensionFields: [{ id: 'ext_probeOnly', label: '探针列', type: 'string', ownership: 'plm_system' }],
      optionSets: [],
      roleViews: [],
    },
  })
  assert.deepEqual(summary.syncedOptionFields, [])
  assert.deepEqual(summary.ensuredViews, [])
  assert.equal(calls.patchObjectFieldProperty.length, 0)
  assert.equal(calls.ensureView.length, 0)
}

async function summaryIsValuesFree() {
  const { provisioning, fieldsByPhysicalId } = createMockProvisioning()
  // Install onto a hand-built sheet so the stamp arms are represented in the
  // summary that gets checked for leaks.
  seedHandBuiltPackColumns(fieldsByPhysicalId)
  const summary = await installCustomerPack({
    provisioning,
    projectId: PROJECT_ID,
    pack: FACTORY_A_SAMPLE_PACK,
    logger: SILENT_LOGGER,
  })
  assert.equal(summary.stampedExistingFields.length, 10)
  const serialized = JSON.stringify(summary)
  for (const leak of ['S30408', 'Q345R', '旧系统ID', '生产备料视图']) {
    assert.equal(serialized.includes(leak), false, `summary must not echo ${leak}`)
  }
  assert.deepEqual(summary.syncedOptionFields, ['ext_standard'])
  assert.deepEqual(
    summary.ensuredViews,
    [
      { roleViewId: 'production', descriptorId: 'sp-factory-a-production', hiddenFieldCount: 12 },
      { roleViewId: 'procurement', descriptorId: 'sp-factory-a-procurement', hiddenFieldCount: 7 },
    ],
  )
}

function couplingIsNarrow() {
  // The installer must reach the host ONLY through the provisioning argument
  // and the shared option-sync kernel: no fs, no net, no DB client.
  const source = fs.readFileSync(INSTALLER_PATH, 'utf8')
  const requireCalls = [...source.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((match) => match[2])
  assert.deepEqual(
    requireCalls.slice().sort(),
    [
      './field-option-sync-runtime.cjs',
      './stock-preparation-customer-pack.cjs',
      './stock-preparation-templates.cjs',
    ],
    'installer must require exactly the pack contract, the frozen template and the shared option kernel',
  )
  // `ensureObject` may appear only in prose, never as a call.
  assert.equal(/\.ensureObject\s*\(/.test(source), false, 'the installer source must contain no ensureObject call')

  // A normalized pack is the only thing the installer will act on.
  const pack = normalizeCustomerPack(FACTORY_A_SAMPLE_PACK)
  assert.equal(__internals.resolveOptionSource('ext_standard').key, 'ext_standard')
  assert.equal(__internals.resolveOptionSource('materialType').key, 'material_type')
  assert.equal(__internals.buildExtensionFieldDescriptors(pack).length, 10)
}

async function main() {
  couplingIsNarrow()
  await apiSurfaceFailsClosed()
  await absentTargetFailsClosed()
  const { calls } = await firstRunCreatesFieldsAdditively()
  ownershipPropertyPayload(calls)
  optionSyncPayload(calls)
  roleViewHiddenFieldIds(calls)
  await optionSetOnATemplateFieldKeepsTemplateSource()
  await secondRunIsANoOpOnFields()
  await partialPreexistingFieldsAreSkippedNotRewritten()
  await handBuiltSheetIsClassifiedNotLeftUnowned()
  await identicalStanzaIsAlreadyStampedWithNoPatch()
  await conflictingOwnershipAbortsBeforeAnyMutation()
  await conflictDetectionSpansBothGuardNamespaces()
  await unreadableOwnershipFailsClosed()
  await ownershipStampFailurePropagatesAsAClosedCode()
  await optionPatchFailurePropagatesAsAClosedCode()
  await viewFailurePropagatesAsAClosedCode()
  await packWithoutOptionSetsSkipsTheKernel()
  await summaryIsValuesFree()
}

main().then(
  () => {
    console.log('stock-preparation-customer-pack-installer.test.cjs OK')
  },
  (error) => {
    // An async suite must fail the chain LOUDLY: without this the process could
    // exit before the rejection surfaced and the `&&` chain would march on.
    console.error(error)
    process.exitCode = 1
  },
)
