'use strict'

// FACTORY-A INSTALL REHEARSAL — the full-shape proof, not another unit battery.
//
// stock-preparation-customer-pack.test.cjs proves the CONTRACT holds and
// stock-preparation-customer-pack-installer.test.cjs proves the INSTALLER is
// additive. Neither answers the question a deployer actually has:
//
//     "Does one config object regenerate the whole sheet my factory works in,
//      and after that, does a PLM refresh still leave my people's cells alone?"
//
// This suite is that rehearsal, run end to end against an in-memory fake of the
// host multitable provisioning API:
//
//   a. normalize the 21-column rehearsal pack
//   b. install run #1 onto a table that already carries the frozen 33 canonical
//      columns  ->  54 logical columns, ownership-stamped
//   c. install run #2  ->  nothing created, nothing destroyed, same wire
//   d. REFRESH-PRESERVATION PROOF: seed a row with BOTH bands filled, project a
//      PLM refresh through the ownership filter DERIVED FROM THE INSTALLED FIELD
//      PROPERTIES, and assert every human cell is byte-identical while every PLM
//      cell moved — then the negative control, the same refresh WITHOUT the
//      filter, which clobbers all 21 human cells and proves the assertion bites
//   e. values-free guard over the whole summary + log stream
//
// Hermetic: no DB, no network, no clock, no filesystem writes. Values-free: the
// only literals are schema ids, business column labels, published national-standard
// material designations (GB/T grades — industry vocabulary, not anyone's data),
// SYNTHETIC 示例* dictionary entries and synthetic cell contents. No customer's
// internal id→name pair appears here; customer-dictionary-leak-guard.test.cjs
// enforces that mechanically.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const {
  EXTENSION_FIELD_ORDER_BASE,
  StockPreparationCustomerPackInstallError,
  installCustomerPack,
} = require(path.join(LIB, 'stock-preparation-customer-pack-installer.cjs'))

const {
  normalizeCustomerPack,
  summarizeCustomerPackForEvidence,
} = require(path.join(LIB, 'stock-preparation-customer-pack.cjs'))

const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  HUMAN_PRESERVED_FIELD_IDS,
} = require(path.join(LIB, 'stock-preparation-templates.cjs'))

const {
  FACTORY_A_REHEARSAL_PACK,
  ID_NOISE_FIELD_IDS,
} = require(path.join(LIB, 'customer-packs', 'factory-a.rehearsal.cjs'))

// The productionized form of this suite's own ownership spec — see
// "THE SPEC IS NOW REAL" in refreshPreservesHumanCells().
const {
  derivePackAwarePlmWritableFields,
} = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))

const PROJECT_ID = 'proj_rehearsal'
const OBJECT_ID = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId

// The three numbers the whole rehearsal is about. Written as expressions, not
// literals, so a change to the frozen template or the pack moves them together
// and the shape assertions below stay honest.
const CANONICAL_FIELD_COUNT = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.length
const PACK_FIELD_COUNT = FACTORY_A_REHEARSAL_PACK.extensionFields.length
const LANDING_SHEET_FIELD_COUNT = CANONICAL_FIELD_COUNT + PACK_FIELD_COUNT

// ---------------------------------------------------------------------------
// Fake host provisioning API
// ---------------------------------------------------------------------------

// Same contract getFieldId offers: stable and derived from (project, object,
// field). The real host hashes; concatenating is enough to prove the installer
// never hands the host a LOGICAL id where a physical one belongs.
function physicalFieldId(projectId, objectId, fieldId) {
  return `fld_${projectId}_${objectId}_${fieldId}`
}

// The property a REAL canonical provisioning run leaves on a frozen template
// column — buildFieldProperty in stock-preparation-target-provisioning.cjs,
// which is not on that module's export surface, so it is mirrored here the same
// way the installer mirrors it for its own extension columns.
//
// This is the one place this fake goes further than the #5065 installer mock
// (which stored `{ ownership }` alone): the refresh proof in act (d) derives its
// writable set from the STORED property, so a fake that omits preserveOnRefresh
// on the canonical half would make that proof vacuous for 28 of the 49 columns.
function canonicalFieldProperty(templateField) {
  const property = {
    stockPreparation: {
      ownership: templateField.ownership,
      preserveOnRefresh: templateField.preserveOnRefresh === true,
      required: templateField.required === true,
      key: templateField.key === true,
    },
  }
  if (templateField.optionSource) {
    property.stockPreparation.optionSource = { ...templateField.optionSource }
  }
  return property
}

// RECURSIVE property merge, mirroring `mergeJsonObject` in
// packages/core-backend/src/multitable/provisioning.ts, which is what the real
// `patchObjectFieldProperty` applies before it writes meta_fields.property.
//
// This is the second place this fake outruns the #5065 installer mock, and the
// reason matters: that mock merges SHALLOWLY (`{ ...row.property, ...patch }`),
// so an option patch there REPLACES `property.stockPreparation` wholesale and
// wipes ownership / preserveOnRefresh / packId off every select column. The
// real host does not — it recurses, so the option stanza lands BESIDE the
// ownership stanza. The #5065 suites never notice because they assert on the
// descriptor that was SUBMITTED, never on the row as stored after the patch.
// Act (d) reads ownership back off the stored row, so getting this wrong would
// have made the refresh proof test a fiction. Asserted explicitly below.
function mergeJsonObject(base, patch) {
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new Error(`fake: unsafe field property patch key: ${key}`)
    }
    const isMergeable = (candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    out[key] = isMergeable(value) && isMergeable(out[key]) ? mergeJsonObject(out[key], value) : value
  }
  return out
}

/**
 * In-memory host. Implements exactly the five methods the installer asserts,
 * plus a poisoned set of DESTRUCTIVE primitives: the installer must never reach
 * for any of them, on a first run or a fiftieth.
 */
function createFakeProvisioning() {
  const fields = new Map()
  const views = new Map()
  const logs = []
  const calls = {
    findObjectSheet: [],
    ensureMissingObjectFields: [],
    readObjectFieldsContent: [],
    patchObjectFieldProperty: [],
    ensureView: [],
  }
  const destructiveCalls = []

  for (const [order, field] of STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.entries()) {
    fields.set(physicalFieldId(PROJECT_ID, OBJECT_ID, field.id), {
      logicalId: field.id,
      name: field.label,
      type: field.type,
      property: canonicalFieldProperty(field),
      order,
    })
  }

  function poison(name) {
    return async (input) => {
      destructiveCalls.push({ method: name, input })
      throw new Error(`fake: ${name} must never be called by the customer pack installer`)
    }
  }

  const provisioning = {
    getFieldId: (projectId, objectId, fieldId) => physicalFieldId(projectId, objectId, fieldId),

    async findObjectSheet({ projectId, objectId }) {
      calls.findObjectSheet.push({ projectId, objectId })
      return { id: `sheet_${objectId}`, baseId: 'base_rehearsal', name: objectId, description: null }
    },

    // ON CONFLICT (id) DO NOTHING — no UPDATE, no DELETE, exactly like the host
    // primitive (multitable/provisioning.ts ensureMissingObjectFields).
    async ensureMissingObjectFields({ projectId, objectId, fields: descriptors }) {
      calls.ensureMissingObjectFields.push({ projectId, objectId, fields: descriptors })
      const addedFieldIds = []
      const skippedExistingFieldIds = []
      for (const [index, descriptor] of (descriptors || []).entries()) {
        const id = physicalFieldId(projectId, objectId, descriptor.id)
        if (fields.has(id)) {
          skippedExistingFieldIds.push(id)
          continue
        }
        fields.set(id, {
          logicalId: descriptor.id,
          name: descriptor.name,
          type: descriptor.type,
          property: JSON.parse(JSON.stringify(descriptor.property || {})),
          order: typeof descriptor.order === 'number' ? descriptor.order : index,
        })
        addedFieldIds.push(id)
      }
      return { addedFieldIds, skippedExistingFieldIds }
    },

    // Host contract (multitable/provisioning.ts readObjectFieldsContent via the
    // plugin provisioning surface): logicalId -> {name, type, property, order}
    // for the ids that EXIST; absent ids are simply omitted. The customer-pack
    // installer's pre-scan reads through this to classify pre-existing columns
    // (NEEDS_STAMP / ALREADY_STAMPED / CONFLICTING) before it writes anything.
    async readObjectFieldsContent({ projectId, objectId, fieldIds }) {
      calls.readObjectFieldsContent.push({ projectId, objectId, fieldIds })
      const content = {}
      for (const logicalId of fieldIds || []) {
        const row = fields.get(physicalFieldId(projectId, objectId, logicalId))
        if (!row) continue
        content[logicalId] = {
          name: row.name,
          type: row.type,
          property: JSON.parse(JSON.stringify(row.property || {})),
          order: row.order,
        }
      }
      return content
    },

    async patchObjectFieldProperty({ projectId, objectId, fieldId, propertyPatch }) {
      calls.patchObjectFieldProperty.push({ projectId, objectId, fieldId, propertyPatch })
      const id = physicalFieldId(projectId, objectId, fieldId)
      const row = fields.get(id)
      if (!row) throw new Error(`fake: provisioned field not found: ${objectId}.${fieldId}`)
      row.property = mergeJsonObject(row.property, JSON.parse(JSON.stringify(propertyPatch)))
      return { id, sheetId: `sheet_${objectId}`, name: row.name, type: row.type, property: row.property }
    },

    async ensureView({ projectId, sheetId, descriptor }) {
      calls.ensureView.push({ projectId, sheetId, descriptor })
      const id = `view_${descriptor.objectId}_${descriptor.id}`
      views.set(id, {
        id,
        sheetId,
        name: descriptor.name,
        type: descriptor.type,
        hiddenFieldIds: [...(descriptor.hiddenFieldIds || [])],
        config: descriptor.config,
      })
      return views.get(id)
    },

    // Never legitimate on this path. `ensureObject` in particular rewrites every
    // field property wholesale and would wipe the options a previous install
    // synced — the whole reason the installer is built on the additive primitive.
    ensureObject: poison('ensureObject'),
    deleteObjectField: poison('deleteObjectField'),
    removeObjectField: poison('removeObjectField'),
    deleteView: poison('deleteView'),
  }

  const logger = {
    info(line) {
      logs.push(String(line))
    },
  }

  return { provisioning, logger, logs, calls, destructiveCalls, fields, views }
}

function fieldStoreSnapshot(fields) {
  return JSON.stringify([...fields.entries()].sort((a, b) => a[0].localeCompare(b[0])))
}

function ownershipOf(fieldId) {
  const templateField = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.find((field) => field.id === fieldId)
  if (templateField) return templateField.ownership
  const packField = FACTORY_A_REHEARSAL_PACK.extensionFields.find((field) => field.id === fieldId)
  assert.ok(packField, `${fieldId} belongs to neither catalog`)
  return packField.ownership
}

// ---------------------------------------------------------------------------
// (a) the pack normalizes to the shape the rehearsal claims
// ---------------------------------------------------------------------------

function rehearsalPackNormalizes() {
  const pack = normalizeCustomerPack(FACTORY_A_REHEARSAL_PACK)

  assert.equal(pack.packId, 'factory-a-rehearsal')
  assert.equal(pack.targetObjectId, OBJECT_ID)
  assert.equal(pack.extensionFields.length, 21, 'the rehearsal pack carries 21 extension columns')
  assert.equal(PACK_FIELD_COUNT, 21)
  // 25 -> 28: 备料主表 gained parentComponentCode / parentComponentName / componentSpec, the three
  // PLM columns the working sheet was missing (they reached the sheet only through THIS pack's
  // ext_parentDrawingNo / ext_parentName / ext_spec until now). The pack is unchanged: the frozen
  // ids deliberately avoid those ext_ suffixes, because a frozen id equal to an installed pack's
  // suffix is refused outright (FIELD_ID_TEMPLATE_COLLISION) and would break this very install.
    // 28 -> 33: on top of those three PLM columns, the template ALSO gained 自制/外购 plus the
  // four departmental response columns. All five are human_preserved, so the PLM band is unmoved
  // by them; the two growths are independent and both land here.
  assert.equal(CANONICAL_FIELD_COUNT, 33, 'the frozen canonical template carries 33 columns')
  assert.equal(LANDING_SHEET_FIELD_COUNT, 54)

  const byOwnership = { plm_system: [], human_preserved: [] }
  for (const field of pack.extensionFields) {
    byOwnership[field.ownership].push(field.id)
    // THE derived rule, restated as an assertion on every single column: a
    // human column survives a refresh, a system column does not. Nothing in the
    // pack authors this — flipping it requires editing the normalizer.
    assert.equal(
      field.preserveOnRefresh,
      field.ownership === 'human_preserved',
      `${field.id}: preserveOnRefresh must be derived from ownership`,
    )
    assert.ok(field.id.startsWith('ext_'), `${field.id} must live in the tenant namespace`)
  }
  assert.equal(byOwnership.plm_system.length, 13, '13 PLM-derived extension columns')
  assert.equal(byOwnership.human_preserved.length, 8, '8 human-preserved extension columns')

  // No extension id may shadow a canonical one (the normalizer enforces it; this
  // asserts the rehearsal pack actually exercises a disjoint 51-column shape).
  const canonicalIds = new Set(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => field.id))
  for (const field of pack.extensionFields) {
    assert.equal(canonicalIds.has(field.id), false, `${field.id} must not shadow a canonical column`)
  }

  // FINDING, asserted rather than filed: normalizeCustomerPack resolves an
  // optionSet against the FULL catalog (template + pack) and gates only on
  // `type === 'select'`, so a pack MAY carry the dictionary for a frozen
  // canonical select. `fieldSource` is what keeps the two halves apart.
  assert.equal(pack.optionSets.length, 5, 'two pack selects plus the three canonical selects')
  assert.deepEqual(
    pack.optionSets.map((set) => `${set.fieldId}:${set.fieldSource}:${set.options.length}`),
    [
      'ext_pickingNode:pack:6',
      'ext_handoverSection:pack:15',
      'materialType:template:6',
      'blankType:template:6',
      'stockPreparationStatus:template:5',
    ],
  )
  for (const set of pack.optionSets) {
    const values = set.options.map((option) => option.value)
    assert.equal(new Set(values).size, values.length, `${set.fieldId} options must be unique`)
    assert.deepEqual(set.actionBindings, [], 'a landing-sheet dictionary binds no executable action')
  }

  assert.equal(pack.roleViews.length, 3)
  assert.deepEqual(pack.roleViews.map((view) => view.viewId), ['production', 'procurement', 'warehouse'])
  for (const view of pack.roleViews) {
    // Ownership is the REFRESH boundary on this sheet, not the visibility one —
    // every role both reads PLM columns and writes human ones.
    assert.deepEqual(view.hideOwnerships, [], `${view.viewId} hides by name, never by ownership band`)
    for (const fieldId of ID_NOISE_FIELD_IDS) {
      assert.ok(view.hiddenFieldIds.includes(fieldId), `${view.viewId} must band out ${fieldId}`)
    }
    // A view that hid the row's own identity would be unusable.
    assert.equal(view.hiddenFieldIds.includes('componentCode'), false)
    assert.equal(view.hiddenFieldIds.includes('componentName'), false)
    assert.ok(
      view.hiddenFieldIds.length < LANDING_SHEET_FIELD_COUNT,
      `${view.viewId} must leave columns visible`,
    )
  }
  // Production is the band that FILLS the human columns, so none may be hidden.
  const production = pack.roleViews[0]
  for (const fieldId of HUMAN_PRESERVED_FIELD_IDS) {
    assert.equal(production.hiddenFieldIds.includes(fieldId), false, `production must see ${fieldId}`)
  }
  for (const fieldId of byOwnership.human_preserved) {
    assert.equal(production.hiddenFieldIds.includes(fieldId), false, `production must see ${fieldId}`)
  }

  // Evidence stays counts-and-ids: no dictionary value ever reaches it.
  const evidence = JSON.stringify(summarizeCustomerPackForEvidence(FACTORY_A_REHEARSAL_PACK))
  // Each literal is one the pack ACTUALLY carries, so the assertion bites: a
  // leak guard naming strings absent from its own input proves nothing.
  for (const leak of ['示例节点一', '示例历史桶', 'S30408', '生产备料视图', '毛胚长度']) {
    assert.ok(
      JSON.stringify(FACTORY_A_REHEARSAL_PACK).includes(leak),
      `${leak} must be present in the pack, or this guard is vacuous`,
    )
    assert.equal(evidence.includes(leak), false, `pack evidence must not echo ${leak}`)
  }

  return pack
}

// ---------------------------------------------------------------------------
// (b) install run #1 regenerates the 51-column landing sheet
// ---------------------------------------------------------------------------

async function installRunOneRegeneratesTheSheet(pack) {
  const fake = createFakeProvisioning()
  assert.equal(fake.fields.size, CANONICAL_FIELD_COUNT, 'the fake starts as a provisioned canonical table')

  const summary = await installCustomerPack({
    provisioning: fake.provisioning,
    projectId: PROJECT_ID,
    pack: FACTORY_A_REHEARSAL_PACK,
    logger: fake.logger,
  })

  assert.deepEqual(fake.destructiveCalls, [], 'no destructive host primitive may be reached')
  assert.equal(fake.calls.ensureMissingObjectFields.length, 1, 'one additive write for the whole pack')
  assert.deepEqual(
    summary.createdFields,
    FACTORY_A_REHEARSAL_PACK.extensionFields.map((field) => field.id),
    'every one of the 21 pack columns is created, in pack order',
  )
  assert.equal(summary.createdFields.length, PACK_FIELD_COUNT)
  assert.deepEqual(summary.skippedFields, [])

  // THE SHAPE CLAIM: one config object -> the full landing sheet.
  assert.equal(
    fake.fields.size,
    LANDING_SHEET_FIELD_COUNT,
    'canonical + pack = 46 logical columns on the landing sheet',
  )

  // Options synced on all five selects; the canonical three keep the TEMPLATE's
  // own declared optionSource, so an install cannot re-label where a canonical
  // column's dictionary comes from.
  assert.deepEqual(
    summary.syncedOptionFields,
    ['ext_pickingNode', 'ext_handoverSection', 'materialType', 'blankType', 'stockPreparationStatus'],
  )
  const patchBySource = new Map(
    fake.calls.patchObjectFieldProperty.map((call) => [
      call.fieldId,
      call.propertyPatch.stockPreparation.optionSource,
    ]),
  )
  assert.deepEqual(patchBySource.get('ext_pickingNode'), { type: 'config_info', key: 'ext_pickingNode' })
  assert.deepEqual(patchBySource.get('ext_handoverSection'), { type: 'config_info', key: 'ext_handoverSection' })
  assert.deepEqual(patchBySource.get('materialType'), { type: 'config_info', key: 'material_type' })
  assert.deepEqual(patchBySource.get('blankType'), { type: 'config_info', key: 'blank_type' })
  assert.deepEqual(
    patchBySource.get('stockPreparationStatus'),
    { type: 'config_info', key: 'stock_preparation_status' },
  )

  assert.equal(fake.calls.ensureView.length, 3)
  assert.deepEqual(
    summary.ensuredViews.map((view) => view.roleViewId),
    ['production', 'procurement', 'warehouse'],
  )
  for (const call of fake.calls.ensureView) {
    for (const hidden of call.descriptor.hiddenFieldIds) {
      assert.ok(hidden.startsWith('fld_'), 'hiddenFieldIds reach the host as PHYSICAL ids')
    }
  }

  // Every pack column landed with the FULL ownership stanza — the metadata the
  // refresh guard in act (d) reads back out of the sheet.
  const OWNERSHIP_STANZA_KEYS = ['ownership', 'preserveOnRefresh', 'required', 'key', 'extension', 'packId', 'packVersion']
  for (const field of pack.extensionFields) {
    const row = fake.fields.get(physicalFieldId(PROJECT_ID, OBJECT_ID, field.id))
    assert.ok(row, `${field.id} must exist on the sheet after install`)
    const stanza = row.property.stockPreparation
    const ownershipHalf = {}
    for (const key of OWNERSHIP_STANZA_KEYS) ownershipHalf[key] = stanza[key]
    assert.deepEqual(
      ownershipHalf,
      {
        ownership: field.ownership,
        preserveOnRefresh: field.ownership === 'human_preserved',
        required: false,
        key: false,
        extension: true,
        packId: 'factory-a-rehearsal',
        packVersion: 1,
      },
      `${field.id} must carry ownership + pack provenance`,
    )
    assert.equal(row.name, field.label)
    assert.equal(row.type, field.type)
  }

  // The classification SURVIVES the option patch. This is the property the
  // whole refresh guard rests on and the one a shallow-merging fake cannot
  // express: the option stanza must land BESIDE ownership, never over it.
  for (const fieldId of ['ext_pickingNode', 'ext_handoverSection']) {
    const stanza = fake.fields.get(physicalFieldId(PROJECT_ID, OBJECT_ID, fieldId)).property.stockPreparation
    assert.equal(stanza.ownership, 'human_preserved', `${fieldId} keeps its ownership through an option sync`)
    assert.equal(stanza.preserveOnRefresh, true)
    assert.equal(stanza.extension, true)
    assert.equal(stanza.optionSync.optionCount > 0, true, `${fieldId} also carries its option provenance`)
  }
  for (const fieldId of ['materialType', 'blankType', 'stockPreparationStatus']) {
    const stanza = fake.fields.get(physicalFieldId(PROJECT_ID, OBJECT_ID, fieldId)).property.stockPreparation
    assert.equal(stanza.ownership, 'human_preserved', `canonical ${fieldId} keeps its ownership`)
    assert.equal(stanza.preserveOnRefresh, true)
    assert.equal('extension' in stanza, false, `canonical ${fieldId} must not be re-labelled as an extension`)
  }

  // Descriptors stay schema-only and sort after every canonical column.
  for (const descriptor of fake.calls.ensureMissingObjectFields[0].fields) {
    assert.equal('options' in descriptor, false, `${descriptor.id} must not carry inline options`)
    assert.ok(descriptor.order >= EXTENSION_FIELD_ORDER_BASE, `${descriptor.id} must sort after canonical columns`)
  }

  // The canonical half is byte-for-byte what it was before the install, apart
  // from the three dictionaries the pack deliberately supplied.
  const untouchedCanonical = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields
    .filter((field) => !['materialType', 'blankType', 'stockPreparationStatus'].includes(field.id))
  for (const field of untouchedCanonical) {
    const row = fake.fields.get(physicalFieldId(PROJECT_ID, OBJECT_ID, field.id))
    assert.deepEqual(row.property, canonicalFieldProperty(field), `${field.id} must be untouched`)
  }

  return { fake, summary }
}

// ---------------------------------------------------------------------------
// (c) install run #2 — idempotence
// ---------------------------------------------------------------------------

async function installRunTwoIsInert() {
  const fake = createFakeProvisioning()
  const first = await installCustomerPack({
    provisioning: fake.provisioning,
    projectId: PROJECT_ID,
    pack: FACTORY_A_REHEARSAL_PACK,
    logger: fake.logger,
  })
  const afterFirst = fieldStoreSnapshot(fake.fields)

  const second = await installCustomerPack({
    provisioning: fake.provisioning,
    projectId: PROJECT_ID,
    pack: FACTORY_A_REHEARSAL_PACK,
    logger: fake.logger,
  })

  assert.deepEqual(second.createdFields, [], 'a re-run creates no column')
  assert.deepEqual(second.skippedFields, first.createdFields, 'all 21 report as already present')
  assert.deepEqual(fake.destructiveCalls, [], 'a re-run must still reach no destructive primitive')
  assert.equal(
    fieldStoreSnapshot(fake.fields),
    afterFirst,
    'the second run leaves every field row byte-identical (DO NOTHING semantics)',
  )
  assert.equal(fake.fields.size, LANDING_SHEET_FIELD_COUNT, 'the sheet neither grew nor shrank')

  // Idempotent as a fact about the WIRE, not just about the summary.
  assert.deepEqual(
    fake.calls.ensureMissingObjectFields[1].fields,
    fake.calls.ensureMissingObjectFields[0].fields,
  )
  assert.deepEqual(
    fake.calls.patchObjectFieldProperty.slice(5).map((call) => call.propertyPatch),
    fake.calls.patchObjectFieldProperty.slice(0, 5).map((call) => call.propertyPatch),
  )
  assert.deepEqual(
    fake.calls.ensureView.slice(3).map((call) => call.descriptor),
    fake.calls.ensureView.slice(0, 3).map((call) => call.descriptor),
    'the three role views are re-ensured with identical descriptors',
  )
  assert.equal(fake.views.size, 3, 'views are ensured, never duplicated')
  assert.deepEqual(second.syncedOptionFields, first.syncedOptionFields)
  assert.deepEqual(second.ensuredViews, first.ensuredViews)

  return fake
}

// ---------------------------------------------------------------------------
// (d) THE REFRESH-PRESERVATION PROOF
// ---------------------------------------------------------------------------

/**
 * The ownership guard, derived from what is ACTUALLY STORED ON THE SHEET —
 * not from the frozen template, and not from the pack. This is the projection a
 * pack-aware PLM refresh has to compute: read each column's `stockPreparation`
 * stanza back off the provisioned field and decide whether a refresh may write
 * it.
 *
 * Fail-closed: a column with no ownership stanza at all is NOT writable. An
 * unclassified column is a column nobody has decided about, and a refresh must
 * not be the thing that decides.
 */
function plmWritableFieldIds(fields) {
  const writable = []
  for (const row of fields.values()) {
    const meta = row.property && row.property.stockPreparation
    if (!meta) continue
    if (meta.ownership !== 'human_preserved' && !meta.preserveOnRefresh) writable.push(row.logicalId)
  }
  return writable
}

async function refreshPreservesHumanCells() {
  const fake = createFakeProvisioning()
  await installCustomerPack({
    provisioning: fake.provisioning,
    projectId: PROJECT_ID,
    pack: FACTORY_A_REHEARSAL_PACK,
    logger: fake.logger,
  })

  // The guard can only be trusted if EVERY column is classified — otherwise the
  // fail-closed `continue` above would silently shrink the writable set and the
  // preservation assertion would pass for the wrong reason.
  for (const row of fake.fields.values()) {
    assert.ok(
      row.property && row.property.stockPreparation && row.property.stockPreparation.ownership,
      `${row.logicalId} must carry an ownership classification after install`,
    )
  }

  const writable = plmWritableFieldIds(fake.fields)
  const writableSet = new Set(writable)
  const allFieldIds = [...fake.fields.values()].map((row) => row.logicalId)
  const humanFieldIds = allFieldIds.filter((fieldId) => ownershipOf(fieldId) === 'human_preserved')
  const plmFieldIds = allFieldIds.filter((fieldId) => ownershipOf(fieldId) === 'plm_system')

  assert.equal(allFieldIds.length, LANDING_SHEET_FIELD_COUNT)
  // 16 -> 21: the five new canonical human columns land on the human side of the
  // ownership wall, which is the point — a PLM refresh must not be able to write them.
  assert.equal(humanFieldIds.length, 21, '13 canonical + 8 pack human columns')
  assert.equal(plmFieldIds.length, 33, '20 canonical + 13 pack PLM columns')
  assert.deepEqual([...writable].sort(), [...plmFieldIds].sort(), 'the guard admits exactly the PLM band')
  for (const fieldId of humanFieldIds) {
    assert.equal(writableSet.has(fieldId), false, `a refresh must not be allowed to write ${fieldId}`)
  }
  // The pack's human columns are in there by OWNERSHIP, not by luck: the frozen
  // template has never heard of them.
  for (const fieldId of ['ext_blankLength', 'ext_pickingNode', 'ext_stockPrepDate', 'ext_blankMass']) {
    assert.ok(humanFieldIds.includes(fieldId))
    assert.equal(writableSet.has(fieldId), false)
  }

  // ── THE SPEC IS NOW REAL ──────────────────────────────────────────────────
  // `plmWritableFieldIds` above was written as a SPECIFICATION for a refresh that
  // did not yet exist. The conflict planner now ships that semantic as
  // derivePackAwarePlmWritableFields (tightened by an extension-stamp requirement
  // the local guard predates and does not model). The local guard is kept — an
  // independently restated spec is the point of a rehearsal — but it is pinned to
  // production here, so the two can no longer drift apart in silence.
  const production = derivePackAwarePlmWritableFields({
    templateFields: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields,
    installedFieldProperties: fake.fields,
  })
  assert.deepEqual(
    production.packPlmWritableFieldIds,
    [...writableSet].filter((fieldId) => fieldId.startsWith('ext_')).sort(),
    'the production derivation admits exactly the pack PLM columns this spec admits',
  )
  assert.deepEqual(
    production.packHumanPreservedFieldIds,
    humanFieldIds.filter((fieldId) => fieldId.startsWith('ext_')).sort(),
    'and the production HUMAN band is exactly the pack human columns',
  )
  assert.deepEqual(production.unclassifiedPackFieldIds, [], 'a fully installed pack leaves nothing unclassified')
  for (const fieldId of humanFieldIds) {
    assert.equal(
      production.plmWritableFieldIds.includes(fieldId),
      false,
      `production must not let a refresh write ${fieldId}`,
    )
    // The half the spec could not assert before: the human WALL now knows the
    // pack's columns BY NAME, not merely by their absence from the template.
    assert.ok(production.humanPreservedFieldIds.includes(fieldId))
  }

  // A row as it stands the morning after someone worked it: PLM identity filled
  // by the last refresh, human columns filled by 备料 / 采购 / 仓库.
  const seededRow = Object.freeze({
    // canonical PLM band
    projectNo: 'PRJ-REHEARSAL-01',
    idempotencyKey: 'PRJ-REHEARSAL-01/CMP-0007/1',
    componentSourceId: 'CMP-0007',
    parentSourceId: 'CMP-0001',
    path: 'CMP-0001/CMP-0007',
    depth: 2,
    componentCode: 'GJ-0007',
    componentName: '筒体',
    // The three PLM columns 备料主表 gained: 父组件图号 / 父组件名称 / 规格. The pack's own
    // ext_parentDrawingNo / ext_parentName / ext_spec below still carry the same data on this
    // deployment — both bands coexist, and both are plm_system, so BOTH must move on a refresh.
    parentComponentCode: 'TZ-0001',
    parentComponentName: '主体组件',
    componentSpec: 'DN1200',
    material: 'Q345R',
    sourceVersion: 'A.1',
    rawQuantity: 2,
    totalQuantity: 4,
    active: true,
    lastPlmRefreshRunId: 'run-0001',
    lastPlmRefreshAt: '2026-08-20T01:00:00.000Z',
    lastPlmRefreshDecision: 'update',
    lastPlmConflictSummary: '',
    // pack PLM band
    ext_parentDrawingNo: 'TZ-0001',
    ext_parentName: '主体组件',
    ext_spec: 'DN1200',
    ext_nameAndSpec: '筒体 DN1200',
    ext_standard: 'GB/T 150',
    ext_designer: '设计一组',
    ext_createdSource: 'PLM',
    ext_legacyRowId: 'L-100007',
    ext_parentLegacyId: 'L-100001',
    ext_supplementId: 'S-0007',
    ext_parentSortNo: 1,
    ext_componentSortNo: 7,
    ext_materialCode: 'WL-000123',
    // canonical human band
    materialType: '30 - Q345R',
    blankType: '20 - 管材',
    stockPreparationStatus: '20 - 已下单',
    demandDate: '2026-09-01',
    leadTimeDays: 14,
    notes: '按图纸复核后下单',
    procurementReply: '供应商确认排产',
    warehouseConfirmation: '待到货',
    // 自制/外购 + the departmental response band: the completion markers and the real
    // dates the legacy 备料 system carried in its purchase_info / warehouse_info tables.
    // Seeded here so the clobber proof below covers them BY NAME — a refresh that could
    // reset 采购完成 to false or wipe 实际到货日期 is exactly the regression this suite
    // is here to catch.
    makeOrBuy: '20 - 外购',
    procurementDone: true,
    procurementReplyDate: '2026-08-21',
    warehouseDone: false,
    actualArrivalDate: '2026-09-05',
    // pack human band
    ext_stockPrepDate: '2026-08-18',
    ext_pickingNode: '10 - 示例节点一',
    ext_handoverSection: '10 - 示例工段一',
    ext_blankLength: 1250,
    ext_blankWidth: 800,
    ext_blankThickness: 12,
    ext_blankQuantity: 4,
    ext_blankMass: 94.2,
  })
  assert.deepEqual(
    Object.keys(seededRow).sort(),
    [...allFieldIds].sort(),
    'the seeded row must cover the whole 54-column sheet, or the proof has blind spots',
  )

  // A refresh payload shaped like the SHEET, not like the PLM band — this is
  // precisely the naive projection the guard exists to narrow. Every one of the
  // 49 columns carries a new value.
  const refreshPayload = {}
  for (const fieldId of allFieldIds) {
    const current = seededRow[fieldId]
    if (typeof current === 'number') refreshPayload[fieldId] = current + 1000
    else if (typeof current === 'boolean') refreshPayload[fieldId] = !current
    else refreshPayload[fieldId] = `${current}#refreshed`
  }
  for (const fieldId of allFieldIds) {
    assert.notEqual(
      JSON.stringify(refreshPayload[fieldId]),
      JSON.stringify(seededRow[fieldId]),
      `${fieldId}: the payload must genuinely differ, or "preserved" would be meaningless`,
    )
  }

  // THE MONEY SHOT: apply the refresh THROUGH the ownership filter.
  const refreshed = { ...seededRow }
  for (const fieldId of writable) refreshed[fieldId] = refreshPayload[fieldId]

  for (const fieldId of humanFieldIds) {
    assert.equal(
      JSON.stringify(refreshed[fieldId]),
      JSON.stringify(seededRow[fieldId]),
      `${fieldId}: a human cell must be byte-identical after a PLM refresh`,
    )
  }
  for (const fieldId of plmFieldIds) {
    assert.equal(
      JSON.stringify(refreshed[fieldId]),
      JSON.stringify(refreshPayload[fieldId]),
      `${fieldId}: a PLM cell must take the refreshed value`,
    )
    assert.notEqual(JSON.stringify(refreshed[fieldId]), JSON.stringify(seededRow[fieldId]))
  }

  // NEGATIVE CONTROL. The same payload, applied WITHOUT the ownership filter —
  // the shape of the bug. If this did not clobber, the assertion above would be
  // passing for free.
  const clobbered = { ...seededRow }
  for (const [fieldId, value] of Object.entries(refreshPayload)) clobbered[fieldId] = value

  for (const fieldId of humanFieldIds) {
    assert.notEqual(
      JSON.stringify(clobbered[fieldId]),
      JSON.stringify(seededRow[fieldId]),
      `${fieldId}: WITHOUT the filter this human cell IS destroyed — the guard is load-bearing`,
    )
  }
  const divergent = allFieldIds
    .filter((fieldId) => JSON.stringify(refreshed[fieldId]) !== JSON.stringify(clobbered[fieldId]))
    .sort()
  assert.deepEqual(
    divergent,
    [...humanFieldIds].sort(),
    'filtered and unfiltered refresh differ on EXACTLY the 16 human cells, nothing else',
  )

  // BOTH HALVES of the guard have to carry weight. On a correctly written sheet
  // `ownership` and `preserveOnRefresh` agree on all 46 columns, so the two
  // clauses are redundant and either could rot unnoticed. They stop agreeing on
  // a sheet a person has touched: a deployer pins a hand-maintained column by
  // setting preserveOnRefresh WITHOUT restating ownership. The flag must win.
  const pinned = new Map()
  for (const [id, row] of fake.fields.entries()) {
    const clone = JSON.parse(JSON.stringify(row))
    if (clone.logicalId === 'ext_createdSource') clone.property.stockPreparation.preserveOnRefresh = true
    pinned.set(id, clone)
  }
  const pinnedWritable = new Set(plmWritableFieldIds(pinned))
  assert.equal(
    pinnedWritable.has('ext_createdSource'),
    false,
    'preserveOnRefresh alone must exclude a column, even when ownership would admit it',
  )
  assert.equal(pinnedWritable.size, plmFieldIds.length - 1, 'exactly the pinned column drops out')
  for (const fieldId of humanFieldIds) {
    assert.equal(pinnedWritable.has(fieldId), false, `${fieldId} stays excluded regardless`)
  }

  return fake
}

// ---------------------------------------------------------------------------
// (e) values-free guard
// ---------------------------------------------------------------------------

// Host / credential shapes that must never appear in a summary or a log line.
// Deliberately small and readable — a denylist is a tripwire, not a scrubber.
const FORBIDDEN_PATTERNS = Object.freeze([
  { id: 'ipv4', pattern: /\b\d{1,3}(?:\.\d{1,3}){3}\b/ },
  { id: 'url', pattern: /\b(?:https?|jdbc|mssql|postgres(?:ql)?|mongodb):\/\//i },
  { id: 'hostname', pattern: /\b[a-z0-9][a-z0-9-]*\.(?:com|cn|net|org|io|local|internal|lan)\b/i },
  { id: 'unc-path', pattern: /\\\\[a-z0-9]/i },
  { id: 'credential-word', pattern: /\b(?:password|passwd|secret|token|apikey|api[_-]key|credential|bearer|authorization)\b/i },
  { id: 'connection-string', pattern: /\b(?:uid|pwd|user\s*id|data\s*source|initial\s*catalog|integrated\s*security)\s*=/i },
  { id: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
])

function assertNoForbiddenPatterns(text, label) {
  for (const { id, pattern } of FORBIDDEN_PATTERNS) {
    assert.equal(pattern.test(text), false, `${label} must not carry a ${id} shape`)
  }
}

async function summaryAndLogsAreValuesFree() {
  const fake = createFakeProvisioning()
  const summary = await installCustomerPack({
    provisioning: fake.provisioning,
    projectId: PROJECT_ID,
    pack: FACTORY_A_REHEARSAL_PACK,
    logger: fake.logger,
  })

  // The denylist must BITE, or this whole act is decoration. Probes are
  // assembled from fragments so no host or credential literal is committed.
  const probes = [
    ['ipv4', ['10', '0', '0', '1'].join('.')],
    ['url', `${'ht'}${'tps'}://example-host/path`],
    ['hostname', `some-host${'.'}internal`],
    ['unc-path', `${'\\\\'}some-share`],
    ['credential-word', `${'pass'}${'word'} rotated`],
    ['connection-string', `${'U'}${'id'}=someone;`],
    ['private-key', '-----BEGIN RSA PRIVATE KEY-----'],
  ]
  for (const [id, probe] of probes) {
    const matcher = FORBIDDEN_PATTERNS.find((entry) => entry.id === id)
    assert.ok(matcher.pattern.test(probe), `denylist entry ${id} must actually match its own shape`)
  }

  const serialized = JSON.stringify({ summary, logs: fake.logs })
  assertNoForbiddenPatterns(serialized, 'install summary + logs')

  // Dictionary content and human-facing labels are the customer's data: counts
  // and ids only ever leave the installer.
  for (const leak of [
    '示例节点一', '示例历史桶', '交接工段', '生产备料视图', '仓库跟进视图',
    'Q345R', 'S30408', '毛胚长度', '按图纸复核后下单',
  ]) {
    assert.equal(serialized.includes(leak), false, `summary/logs must not echo ${leak}`)
  }

  assert.equal(fake.logs.length, 1, 'one values-free line per install')
  // stamped/alreadyStamped come from the installer's pre-existing-column
  // classification: this rehearsal installs all 21 ext_ columns fresh onto a
  // canonical-only sheet, so both are 0 — the takeover case (hand-built columns
  // needing an ownership stamp) is covered by the installer suite.
  // `operatorMustClearWriteScopes=unchecked` is the honest reading for a pack that declared nothing:
  // the classification has nothing to diff against and was never run, which is NOT the same as
  // "0 stale rows found". `legacyAdoption=no_ledger` says the same about the adoption proof.
  // `removedWriteScopes=unreconciled` (not `=0`) is the honest token for a pack that declares no
  // fieldWritePolicies: no region was governed, so no reconcile was even requested — which is a
  // different fact from "reconciled and retired nothing".
  assert.match(fake.logs[0], /pack=factory-a-rehearsal v1 created=21 skipped=0 stamped=0 alreadyStamped=0 optionFields=5 views=3 writeScopes=0 removedWriteScopes=unreconciled operatorHeldWriteScopes=unclassified otherPackWriteScopes=unclassified operatorMustClearWriteScopes=unchecked legacyAdoption=no_ledger/)
  assert.deepEqual(Object.keys(summary).sort(), [
    'alreadyStampedFields',
    // COLUMN WRITE SCOPING. This rehearsal pack declares NO `fieldWritePolicies`, which is
    // the state every pack that exists today is in — so the count is 0, the reason is
    // `not_declared`, and the host permission port was never reached. The keys are present
    // (and asserted below) precisely so "nothing was declared" is legible in the summary
    // rather than indistinguishable from "declared and silently skipped".
    'appliedWriteScopes',
    'createdFields',
    'ensuredViews',
    // ANOTHER PACK'S ROWS inside this pack's region. NULL here — nothing was classified — and it is a
    // separate projection from the operator's to-do list precisely because a sibling pack's live
    // denials are not this install's debris and must never be reported as work for a human.
    'governedByOtherPackCount',
    'governedByOtherPacks',
    // F5 closure: the summary now carries the OWNERSHIP BAND per id, so a CLI/route no longer has to
    // re-normalize the pack to say "13 PLM / 8 human columns added". `ledger` is absent here because
    // this rehearsal installs without an install store — the ledger stays optional.
    'installedFields',
    // WHY pack-less rows were or were not adoptable on this sheet, in the ledger's own terms
    // ('no_ledger' here: no install store was supplied, so nothing could be proven).
    'legacyAdoption',
    'objectId',
    // PAIRS THE INSTALL DEFERRED TO A HUMAN ON. NULL here for the same reason as everything else on
    // this list: nothing was declared, so nothing was classified.
    'operatorHeldWriteScopeCount',
    'operatorHeldWriteScopes',
    // THE OPERATOR'S TO-DO LIST — THIS pack's OWN denials outside the region it governs, and only
    // those. NULL here — never [] — because this pack declares no policy, so no classification ran;
    // `writeScopeCheck` names which of the three reasons that was. The distinction is the whole
    // point: an empty array would read as "checked, nothing orphaned", which is a claim this install
    // never made.
    'operatorMustClearWriteScopeCount',
    'operatorMustClearWriteScopes',
    'packId',
    'packVersion',
    // THE RETIRED DENIALS. NULL here — never [] — for the same reason as the census below: this
    // pack governs no (column, role) region, so no reconcile was requested at all, which is a
    // different fact from "reconciled and found nothing to retire".
    'removedWriteScopeCount',
    'removedWriteScopes',
    'skippedFields',
    'stampedExistingFields',
    'syncedOptionFields',
    'writeScopeCheck',
    'writeScopeReconcile',
    'writeScopeRoleCount',
    'writeScopeSkipped',
  ])

  // ABSENT DECLARATION => BEHAVIOUR UNCHANGED. A pack with no fieldWritePolicies writes no
  // permission row at all, and the summary says so in a way a reader can act on.
  assert.equal(summary.appliedWriteScopes, 0)
  assert.equal(summary.writeScopeRoleCount, 0)
  assert.equal(summary.writeScopeSkipped, 'not_declared')
  assert.equal(summary.writeScopeCheck, 'not_declared')
  assert.equal(summary.operatorMustClearWriteScopes, null, 'no declaration => no census => NULL, not an empty list')
  assert.equal(summary.operatorMustClearWriteScopeCount, 0)
  assert.equal(summary.operatorHeldWriteScopes, null)
  assert.equal(summary.governedByOtherPacks, null)
  assert.equal(summary.legacyAdoption.basis, 'no_ledger', 'no store was supplied, so nothing was proven')
  assert.equal(summary.legacyAdoption.allowed, false)
  assert.equal(summary.writeScopeReconcile, 'not_declared')
  assert.equal(summary.removedWriteScopes, null, 'no declaration => no reconcile => NULL, not an empty list')
  assert.equal(summary.removedWriteScopeCount, 0)

  // The join is the point: every installed id carries the band the pack declared, and NOTHING else
  // (no label, no option value, no free text) rides along.
  assert.equal(summary.installedFields.length, PACK_FIELD_COUNT)
  const declaredById = new Map(FACTORY_A_REHEARSAL_PACK.extensionFields.map((field) => [field.id, field]))
  for (const entry of summary.installedFields) {
    assert.deepEqual(Object.keys(entry).sort(), ['action', 'extension', 'fieldId', 'ownership', 'preserveOnRefresh'])
    assert.equal(entry.ownership, declaredById.get(entry.fieldId).ownership)
    assert.equal(entry.preserveOnRefresh, entry.ownership === 'human_preserved')
    assert.equal(entry.extension, true)
    assert.equal(entry.action, 'created')
  }
}

// ---------------------------------------------------------------------------
// the rehearsal, in order
// ---------------------------------------------------------------------------

async function main() {
  // Guard against a pack that silently stopped being installable at all.
  assert.equal(typeof installCustomerPack, 'function')
  assert.equal(typeof StockPreparationCustomerPackInstallError, 'function')

  const pack = rehearsalPackNormalizes()
  await installRunOneRegeneratesTheSheet(pack)
  await installRunTwoIsInert()
  await refreshPreservesHumanCells()
  await summaryAndLogsAreValuesFree()
}

main().then(
  () => {
    console.log('stock-preparation-customer-pack-rehearsal.test.cjs OK')
  },
  (error) => {
    // An async suite must fail the chain LOUDLY: without this the process could
    // exit before the rejection surfaced and the `&&` chain would march on.
    console.error(error)
    process.exitCode = 1
  },
)
