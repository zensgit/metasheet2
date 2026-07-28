'use strict'

// #3751 MVP provisioning runtime tests.
// Locks the latent backend helper that wires the 9 FROZEN MVP table templates
// into the MetaSheet-internal provisioning API: admin-only, metadata-only,
// structure-only (rows always []), no PLM/K3/external write, values-free
// evidence (no sheet id / physical field id / project id value leaks).

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  STOCK_PREPARATION_MVP_TABLE_TEMPLATES,
  STOCK_PREPARATION_MVP_REQUIRED_OBJECT_IDS,
  buildSheetStructureFromMvpTableTemplate,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-templates.cjs'))
const {
  StockPreparationTargetProvisioningError,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-target-provisioning.cjs'))
const {
  StockPreparationOptionSyncError,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-option-sync.cjs'))
const {
  inspectStockPreparationMvpTargets,
  ensureStockPreparationMvpTargets,
  repairStockPreparationMvpTargets,
  syncStockPreparationMvpOptions,
  buildMvpTargetDescriptor,
  __internals: { syncMvpTemplateOptions },
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-mvp-provisioning.cjs'))

const ALL_OBJECT_IDS = STOCK_PREPARATION_MVP_REQUIRED_OBJECT_IDS
const PROJECT_OBJECT_ID = 'plm_stock_preparation_project'
const RUN_OBJECT_ID = 'plm_stock_preparation_run'
const PROJECT_STATUS_SOURCE_KEY = 'stock_preparation_project_status_v1'

// A project id containing a unique secret token that MUST NEVER appear in evidence.
const LEAKY_PROJECT_ID = 'tenant_leaky:proj_P2026_SECRET_XYZ'

let passed = 0
let failed = 0
const failures = []

function run(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1
    })
    .catch((error) => {
      failed += 1
      failures.push({ name, error })
      console.error(`FAIL: ${name}`)
      console.error(error && error.stack ? error.stack : error)
    })
}

// In-memory provisioning fake. NO real I/O. Tracks every provisioning call and
// records created object metadata so create -> resolve round-trips work.
function createContext({ existingObjectIds = [], missingFieldsByObject = {}, failPatch = false } = {}) {
  const calls = { findObjectSheet: [], resolveFieldIds: [], ensureObject: [], patchObjectFieldProperty: [], ensureMissingObjectFields: [] }
  const sheets = new Map()
  const missing = {}
  for (const objectId of existingObjectIds) {
    sheets.set(objectId, { id: `sheet_${objectId}`, baseId: 'base_mvp', name: objectId })
  }
  for (const [objectId, fields] of Object.entries(missingFieldsByObject)) {
    missing[objectId] = new Set(fields)
  }
  const provisioning = {
    async findObjectSheet(input) {
      calls.findObjectSheet.push({ ...input })
      const sheet = sheets.get(input.objectId)
      return sheet ? { ...sheet } : null
    },
    async resolveFieldIds(input) {
      calls.resolveFieldIds.push({ ...input })
      const gone = missing[input.objectId] || new Set()
      const out = {}
      for (const fieldId of input.fieldIds || []) {
        if (!gone.has(fieldId)) out[fieldId] = `fld_${input.objectId}_${fieldId}`
      }
      return out
    },
    // W2: DB-backed existence — only EXISTING (non-missing) fields resolve.
    async resolveExistingObjectFieldIds(input) {
      calls.resolveExistingObjectFieldIds = calls.resolveExistingObjectFieldIds || []
      calls.resolveExistingObjectFieldIds.push({ ...input })
      const gone = missing[input.objectId] || new Set()
      const out = {}
      for (const fieldId of input.fieldIds || []) {
        if (!gone.has(fieldId)) out[fieldId] = `fld_${input.objectId}_${fieldId}`
      }
      return out
    },
    // W2: DB-backed content — stable {name,type,property} for existing fields.
    async readObjectFieldsContent(input) {
      calls.readObjectFieldsContent = calls.readObjectFieldsContent || []
      calls.readObjectFieldsContent.push({ ...input })
      const gone = missing[input.objectId] || new Set()
      const out = {}
      // Fake mirrors the REAL provisioning surface: content snapshot carries `order` too
      // (round-5 review P3 — `order` is part of the mutation-guard's column identity).
      for (const fieldId of input.fieldIds || []) {
        if (!gone.has(fieldId)) out[fieldId] = { name: fieldId, type: 'text', property: {}, order: 0 }
      }
      return out
    },
    async ensureObject(input) {
      calls.ensureObject.push({
        projectId: input.projectId,
        baseId: input.baseId,
        descriptor: JSON.parse(JSON.stringify(input.descriptor)),
      })
      sheets.set(input.descriptor.id, { id: `sheet_${input.descriptor.id}`, baseId: input.baseId || 'base_default', name: input.descriptor.name })
      delete missing[input.descriptor.id]
      return {
        baseId: input.baseId || 'base_default',
        sheet: { id: `sheet_${input.descriptor.id}` },
        fields: input.descriptor.fields.map((field, index) => ({
          id: `physical_${index}_${field.id}`,
          sheetId: `sheet_${input.descriptor.id}`,
          name: field.name,
          type: field.type,
        })),
      }
    },
    async ensureMissingObjectFields(input) {
      // Additive-only fake: adds each field that is currently in the `missing` set,
      // skips the rest; never mutates an existing field (mirrors DO NOTHING).
      calls.ensureMissingObjectFields.push(JSON.parse(JSON.stringify(input)))
      const gone = missing[input.objectId] || new Set()
      const addedFieldIds = []
      const skippedExistingFieldIds = []
      for (const field of input.fields || []) {
        const physicalId = `fld_${input.objectId}_${field.id}`
        if (gone.has(field.id)) {
          gone.delete(field.id)
          addedFieldIds.push(physicalId)
        } else {
          skippedExistingFieldIds.push(physicalId)
        }
      }
      return { addedFieldIds, skippedExistingFieldIds }
    },
    // W2/P2-3: atomic repair runner. The surface forwards to THIS provisioning object's
    // CURRENT methods, so a per-test override (e.g. of ensureMissingObjectFields /
    // readObjectFieldsContent set after createContext) is honored inside the repair body.
    async runObjectFieldsRepairTransaction(fn) {
      const p = this
      calls.runObjectFieldsRepairTransaction = (calls.runObjectFieldsRepairTransaction || 0) + 1
      return fn({
        findObjectSheet: (i) => p.findObjectSheet(i),
        resolveExistingObjectFieldIds: (i) => p.resolveExistingObjectFieldIds(i),
        readObjectFieldsContent: (i) => p.readObjectFieldsContent(i),
        ensureMissingObjectFields: (i) => p.ensureMissingObjectFields(i),
      })
    },
    async patchObjectFieldProperty(input) {
      calls.patchObjectFieldProperty.push(JSON.parse(JSON.stringify(input)))
      if (failPatch) {
        const error = new Error('field deleted mid-sync')
        error.code = 'FIELD_GONE'
        throw error
      }
      return {
        id: `fld_${input.objectId}_${input.fieldId}`,
        sheetId: `sheet_${input.objectId}`,
        name: input.fieldId,
        type: 'select',
        property: input.propertyPatch,
      }
    },
  }
  return { context: { api: { multitable: { provisioning } } }, calls }
}

async function rejectsWith(fn, ErrorClass, code) {
  let err = null
  try {
    await fn()
  } catch (error) {
    err = error
  }
  assert.ok(err instanceof ErrorClass, `expected ${ErrorClass.name} for ${code}, got ${err && err.name}`)
  assert.equal(err.code, code)
  return err
}

// Sentinels a values-free payload must NEVER contain.
function assertValuesFree(payload, label, extraForbidden = []) {
  const text = JSON.stringify(payload)
  const forbidden = ['sheet_', 'physical_', 'fld_', 'P2026_SECRET', 'base_mvp', 'base_default', ...extraForbidden]
  for (const token of forbidden) {
    assert.equal(text.includes(token), false, `${label} must not leak "${token}"`)
  }
}

async function main() {
  // ---- readiness: all 9 tables absent ----
  await run('readiness reports all 9 MVP tables absent', async () => {
    const { context, calls } = createContext({ existingObjectIds: [] })
    const result = await inspectStockPreparationMvpTargets({ context, projectId: LEAKY_PROJECT_ID, permission: 'admin' })
    assert.equal(result.ready, false)
    assert.equal(result.tables.length, 9)
    assert.deepEqual(result.tables.map((t) => t.objectId), ALL_OBJECT_IDS)
    assert.ok(result.tables.every((t) => t.present === false && t.ready === false && t.mode === 'mvp_missing'))
    assert.equal(result.evidence.tableCount, 9)
    assert.equal(result.evidence.presentCount, 0)
    assert.equal(result.evidence.absentCount, 9)
    // Absent tables are never resolved (short-circuit before resolveFieldIds).
    assert.equal(calls.findObjectSheet.length, 9)
    assert.equal(calls.resolveFieldIds.length, 0)
    assert.equal(calls.ensureObject.length, 0)
    assert.equal(calls.patchObjectFieldProperty.length, 0)
    assertValuesFree(result.evidence, 'readiness-absent evidence')
  })

  // ---- readiness: all present + complete ----
  await run('readiness reports all 9 MVP tables ready when present + complete', async () => {
    const { context, calls } = createContext({ existingObjectIds: ALL_OBJECT_IDS.slice() })
    const result = await inspectStockPreparationMvpTargets({ context, projectId: LEAKY_PROJECT_ID, permission: 'admin' })
    assert.equal(result.ready, true)
    assert.equal(result.evidence.readyCount, 9)
    assert.equal(result.evidence.presentCount, 9)
    assert.ok(result.tables.every((t) => t.mode === 'mvp_existing' && t.missingFields.length === 0))
    assert.equal(calls.resolveFieldIds.length, 9)
    assertValuesFree(result.evidence, 'readiness-present evidence')
  })

  // ---- readiness: subset via objectIds ----
  await run('readiness scopes to the objectIds subset', async () => {
    const { context } = createContext({ existingObjectIds: [PROJECT_OBJECT_ID] })
    const result = await inspectStockPreparationMvpTargets({
      context,
      projectId: LEAKY_PROJECT_ID,
      permission: 'admin',
      objectIds: [PROJECT_OBJECT_ID],
    })
    assert.equal(result.tables.length, 1)
    assert.equal(result.tables[0].objectId, PROJECT_OBJECT_ID)
    assert.equal(result.tables[0].ready, true)
  })

  // ---- readiness: present-but-incomplete ----
  await run('readiness marks a present table with a missing field as incomplete', async () => {
    const { context } = createContext({
      existingObjectIds: [PROJECT_OBJECT_ID],
      missingFieldsByObject: { [PROJECT_OBJECT_ID]: ['sourceProjectNo'] },
    })
    const result = await inspectStockPreparationMvpTargets({
      context,
      projectId: LEAKY_PROJECT_ID,
      permission: 'admin',
      objectIds: [PROJECT_OBJECT_ID],
    })
    assert.equal(result.ready, false)
    assert.equal(result.tables[0].present, true)
    assert.equal(result.tables[0].mode, 'mvp_incomplete')
    assert.deepEqual(result.tables[0].missingFields, ['sourceProjectNo'])
    assert.equal(result.evidence.incompleteCount, 1)
  })

  // ---- readiness: unknown objectId fails closed ----
  await run('readiness rejects an unknown objectId', async () => {
    const { context, calls } = createContext({})
    await rejectsWith(
      () => inspectStockPreparationMvpTargets({
        context,
        projectId: LEAKY_PROJECT_ID,
        permission: 'admin',
        objectIds: ['customer_real_table'],
      }),
      StockPreparationTargetProvisioningError,
      'MVP_TARGET_OBJECT_ID_INVALID',
    )
    assert.equal(calls.findObjectSheet.length, 0, 'unknown objectId is rejected before provisioning reads')
  })

  // ---- ensure: creates all 9, structure-only (rows always []) ----
  await run('ensure creates all 9 MVP tables with rows==[] and no external write', async () => {
    const { context, calls } = createContext({ existingObjectIds: [] })
    const result = await ensureStockPreparationMvpTargets({ context, projectId: LEAKY_PROJECT_ID, baseId: 'base_mvp', permission: 'admin' })
    assert.equal(result.ready, true)
    assert.equal(result.tables.length, 9)
    assert.equal(result.evidence.createdCount, 9)
    assert.equal(result.evidence.rowsSeeded, 0)
    assert.ok(result.tables.every((t) => t.created === true && t.mode === 'mvp_create' && t.rowsSeeded === 0))
    assert.equal(calls.ensureObject.length, 9)
    assert.equal(calls.patchObjectFieldProperty.length, 0, 'ensure never patches field metadata')

    // Every descriptor reaching ensureObject is structure-only: NO rows key.
    for (const call of calls.ensureObject) {
      assert.equal('rows' in call.descriptor, false, 'ensureObject descriptor carries no rows')
      assert.ok(call.descriptor.fields.length > 0, 'descriptor carries fields')
    }
    assert.deepEqual(
      calls.ensureObject.map((c) => c.descriptor.id),
      ALL_OBJECT_IDS,
      'ensureObject descriptors cover all 9 MVP objectIds in template order',
    )

    // The structure builder itself always produces rows == [].
    for (const template of STOCK_PREPARATION_MVP_TABLE_TEMPLATES) {
      assert.deepEqual(buildSheetStructureFromMvpTableTemplate(template).rows, [], 'MVP structure rows are always []')
    }
    assertValuesFree(result.evidence, 'ensure evidence')
  })

  // ---- ensure: idempotent on existing-ready tables ----
  await run('ensure is a no-op bind when all tables already exist', async () => {
    const { context, calls } = createContext({ existingObjectIds: ALL_OBJECT_IDS.slice() })
    const result = await ensureStockPreparationMvpTargets({ context, projectId: LEAKY_PROJECT_ID, permission: 'admin' })
    assert.equal(result.ready, true)
    assert.equal(result.evidence.createdCount, 0)
    assert.equal(result.evidence.existingCount, 9)
    assert.equal(calls.ensureObject.length, 0, 'existing tables are not re-created')
    assert.ok(result.tables.every((t) => t.mode === 'mvp_existing'))
  })

  // ---- ensure: fails closed on a present-but-incomplete table (no in-place repair) ----
  await run('ensure fails closed on an incomplete existing table', async () => {
    const { context, calls } = createContext({
      existingObjectIds: [PROJECT_OBJECT_ID],
      missingFieldsByObject: { [PROJECT_OBJECT_ID]: ['sourceProjectNo'] },
    })
    const err = await rejectsWith(
      () => ensureStockPreparationMvpTargets({
        context,
        projectId: LEAKY_PROJECT_ID,
        permission: 'admin',
        objectIds: [PROJECT_OBJECT_ID],
      }),
      StockPreparationTargetProvisioningError,
      'MVP_TARGET_SCHEMA_INCOMPLETE',
    )
    assert.deepEqual(err.details.missingFields, ['sourceProjectNo'])
    assert.equal(err.details.objectId, PROJECT_OBJECT_ID)
    assert.equal(calls.ensureObject.length, 0, 'incomplete existing table is never repaired in place')
    assertValuesFree(err.details, 'incomplete-ensure error details')
  })

  // ---- option sync: table WITH option fields + supplied set ----
  await run('option sync patches a table that has option fields when a set is supplied', async () => {
    const { context, calls } = createContext({ existingObjectIds: [PROJECT_OBJECT_ID] })
    const result = await syncStockPreparationMvpOptions({
      context,
      projectId: LEAKY_PROJECT_ID,
      permission: 'admin',
      objectIds: [PROJECT_OBJECT_ID],
      optionSets: {
        [PROJECT_STATUS_SOURCE_KEY]: [
          { value: 'topsecretvalue', label: 'TopSecretLabel' },
          { value: 'closed', label: 'Closed' },
        ],
      },
    })
    assert.equal(result.ok, true)
    assert.equal(result.tables.length, 1)
    assert.equal(result.tables[0].syncedCount, 1)
    assert.equal(result.tables[0].mode, 'mvp_options_synced')
    assert.equal(calls.patchObjectFieldProperty.length, 1)
    assert.equal(calls.patchObjectFieldProperty[0].fieldId, 'projectStatus')
    assert.equal(calls.patchObjectFieldProperty[0].objectId, PROJECT_OBJECT_ID)
    // The option VALUE rides the patch body (necessary field metadata)...
    assert.equal(calls.patchObjectFieldProperty[0].propertyPatch.options[0].value, 'topsecretvalue')
    assert.equal(result.evidence.syncedFieldCount, 1)
    // ...but the option VALUE/label MUST NOT appear anywhere in the evidence.
    assertValuesFree(result.evidence, 'option-sync evidence', ['topsecretvalue', 'TopSecretLabel'])
  })

  // ---- option sync: realistic no-op (targeted table, no supplied set) ----
  await run('option sync is a no-op when no set is supplied for a targeted table', async () => {
    const { context, calls } = createContext({ existingObjectIds: [RUN_OBJECT_ID] })
    const result = await syncStockPreparationMvpOptions({
      context,
      projectId: LEAKY_PROJECT_ID,
      permission: 'admin',
      objectIds: [RUN_OBJECT_ID],
      optionSets: {},
    })
    assert.equal(result.ok, true)
    assert.equal(result.tables[0].syncedCount, 0)
    assert.equal(result.tables[0].mode, 'mvp_options_not_supplied')
    assert.ok(result.tables[0].skippedCount > 0, 'run table option fields are recorded as skipped')
    assert.equal(calls.patchObjectFieldProperty.length, 0, 'no supplied set => no patch')
  })

  // ---- option sync: defensive no-op for a template with ZERO option fields ----
  // (No frozen MVP template has zero option fields, so exercise the branch via
  // the internal per-table helper with a synthetic optionless template.)
  await run('option sync is a no-op for a template with no option fields', async () => {
    const { context, calls } = createContext({})
    const optionlessTemplate = {
      objectId: PROJECT_OBJECT_ID,
      role: 'synthetic_optionless',
      fields: [{ id: 'plainField', name: 'Plain Field', type: 'string', ownership: 'plm_system' }],
    }
    const table = await syncMvpTemplateOptions({
      provisioning: context.api.multitable.provisioning,
      projectId: LEAKY_PROJECT_ID,
      template: optionlessTemplate,
      suppliedSets: {},
    })
    assert.equal(table.optionFieldCount, 0)
    assert.equal(table.mode, 'mvp_no_option_fields')
    assert.equal(table.syncedCount, 0)
    assert.equal(table.skippedCount, 0)
    assert.equal(calls.findObjectSheet.length, 0, 'no-option-field table short-circuits before any provisioning read')
  })

  // ---- option sync: target not yet provisioned => skip (fail closed) ----
  await run('option sync skips an unprovisioned target instead of patching it', async () => {
    const { context, calls } = createContext({ existingObjectIds: [] })
    const result = await syncStockPreparationMvpOptions({
      context,
      projectId: LEAKY_PROJECT_ID,
      permission: 'admin',
      objectIds: [PROJECT_OBJECT_ID],
      optionSets: { [PROJECT_STATUS_SOURCE_KEY]: [{ value: 'active', label: 'Active' }] },
    })
    assert.equal(result.tables[0].mode, 'mvp_target_not_ready')
    assert.equal(result.tables[0].syncedCount, 0)
    assert.equal(calls.patchObjectFieldProperty.length, 0, 'never patch an unprovisioned target')
  })

  // ---- option sync: unknown source key fails closed ----
  await run('option sync rejects an option source key not declared by any targeted template', async () => {
    const { context } = createContext({ existingObjectIds: [PROJECT_OBJECT_ID] })
    await rejectsWith(
      () => syncStockPreparationMvpOptions({
        context,
        projectId: LEAKY_PROJECT_ID,
        permission: 'admin',
        objectIds: [PROJECT_OBJECT_ID],
        optionSets: { not_a_declared_source_key: [{ value: 'x' }] },
      }),
      StockPreparationOptionSyncError,
      'OPTION_SYNC_UNKNOWN_SOURCE',
    )
  })

  // ---- admin permission is enforced FIRST on all three, fail-closed 403 ----
  await run('all three functions deny non-admin permission with 403 before touching provisioning', async () => {
    for (const invoke of [
      (ctx) => inspectStockPreparationMvpTargets({ context: ctx, projectId: LEAKY_PROJECT_ID, permission: 'write' }),
      (ctx) => ensureStockPreparationMvpTargets({ context: ctx, projectId: LEAKY_PROJECT_ID, permission: 'write' }),
      (ctx) => syncStockPreparationMvpOptions({ context: ctx, projectId: LEAKY_PROJECT_ID, permission: 'write', optionSets: {} }),
    ]) {
      const { context, calls } = createContext({ existingObjectIds: ALL_OBJECT_IDS.slice() })
      const err = await rejectsWith(() => invoke(context), StockPreparationTargetProvisioningError, 'TARGET_PROVISIONING_PERMISSION_DENIED')
      assert.equal(err.status, 403)
      assert.equal(calls.findObjectSheet.length, 0)
      assert.equal(calls.ensureObject.length, 0)
      assert.equal(calls.patchObjectFieldProperty.length, 0)
    }
  })

  // ---- provisioning API absence fails closed ----
  await run('missing provisioning API fails closed', async () => {
    const emptyContext = { api: { multitable: {} } }
    await rejectsWith(
      () => inspectStockPreparationMvpTargets({ context: emptyContext, projectId: LEAKY_PROJECT_ID, permission: 'admin' }),
      StockPreparationTargetProvisioningError,
      'TARGET_PROVISIONING_API_UNAVAILABLE',
    )
    await rejectsWith(
      () => syncStockPreparationMvpOptions({ context: emptyContext, projectId: LEAKY_PROJECT_ID, permission: 'admin', optionSets: {} }),
      StockPreparationTargetProvisioningError,
      'MVP_OPTION_SYNC_API_UNAVAILABLE',
    )
  })

  // ---- descriptor is metadata-only + values-free ----
  await run('buildMvpTargetDescriptor is structure-only and values-free for every template', async () => {
    for (const template of STOCK_PREPARATION_MVP_TABLE_TEMPLATES) {
      const descriptor = buildMvpTargetDescriptor(template)
      assert.equal(descriptor.id, template.objectId)
      assert.equal('rows' in descriptor, false, 'descriptor carries no rows')
      assert.deepEqual(descriptor.fields.map((f) => f.id), template.fields.map((f) => f.id))
      assertValuesFree(descriptor, `descriptor(${template.objectId})`)
    }
  })

  console.log(`\nstock-preparation-mvp-provisioning.test.cjs: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    for (const { name } of failures) console.error(`  - ${name}`)
    process.exit(1)
  }
  // ---- W2 template-evolution rung: MVP repair action ----
  // (canonical-main repair + its human-field-reject guard is tested in
  // stock-preparation-target-provisioning.test.cjs, where the 8 human fields live.)
  {
    const MAP = 'plm_stock_preparation_material_mapping'

    // (a) repair adds a missing plm_system field on an existing MVP table (admin), values-free.
    const { context, calls } = createContext({
      existingObjectIds: ALL_OBJECT_IDS.slice(),
      missingFieldsByObject: { [MAP]: ['plmDrawingNo'] },
    })
    const repaired = await repairStockPreparationMvpTargets({ context, projectId: LEAKY_PROJECT_ID, permission: 'admin', objectIds: [MAP] })
    const mapTable = repaired.tables.find((t) => t.objectId === MAP)
    assert.equal(mapTable.mode, 'mvp_repaired')
    assert.equal(mapTable.addedFieldCount, 1)
    assert.equal(calls.ensureMissingObjectFields.length, 1, 'repair goes through the additive-only primitive')
    assert.equal(repaired.evidence.repairedTableCount, 1)
    assertValuesFree(repaired.evidence, 'repair evidence')

    // (b) repair on an ABSENT table fails closed (that's an ensure concern).
    const absentCtx = createContext({ existingObjectIds: [] })
    await rejectsWith(
      () => repairStockPreparationMvpTargets({ context: absentCtx.context, projectId: LEAKY_PROJECT_ID, permission: 'admin', objectIds: [MAP] }),
      StockPreparationTargetProvisioningError,
      'MVP_REPAIR_TARGET_ABSENT',
    )

    // (c) non-admin is rejected before any provisioning access.
    const rbacCtx = createContext({ existingObjectIds: ALL_OBJECT_IDS.slice() })
    let denied = null
    try {
      await repairStockPreparationMvpTargets({ context: rbacCtx.context, projectId: LEAKY_PROJECT_ID, permission: 'write', objectIds: [MAP] })
    } catch (error) {
      denied = error
    }
    assert.ok(denied, 'non-admin repair rejected')
    assert.equal(rbacCtx.calls.findObjectSheet.length, 0, 'admin gate precedes all provisioning access')

    // (c2) API contract pin (round-5 review P3): a provisioning WITHOUT the atomic runner
    //      runObjectFieldsRepairTransaction must fail closed with a clean 503, never reach
    //      the repair body. Guards the getMvpRepairApi contract.
    const noRunner = createContext({ existingObjectIds: ALL_OBJECT_IDS.slice(), missingFieldsByObject: { [MAP]: ['plmDrawingNo'] } })
    delete noRunner.context.api.multitable.provisioning.runObjectFieldsRepairTransaction
    await rejectsWith(
      () => repairStockPreparationMvpTargets({ context: noRunner.context, projectId: LEAKY_PROJECT_ID, permission: 'admin', objectIds: [MAP] }),
      StockPreparationTargetProvisioningError,
      'MVP_REPAIR_API_UNAVAILABLE',
    )

    // (d) nothing missing → already-ready, zero adds.
    const readyCtx = createContext({ existingObjectIds: ALL_OBJECT_IDS.slice() })
    const already = await repairStockPreparationMvpTargets({ context: readyCtx.context, projectId: LEAKY_PROJECT_ID, permission: 'admin', objectIds: [MAP] })
    assert.equal(already.tables[0].mode, 'mvp_already_ready')
    assert.equal(already.tables[0].addedFieldCount, 0)

    // (e) POST-WRITE completeness re-verify is LOAD-BEARING for MVP too: neuter the
    //     additive write so the field stays missing → repair must fail closed.
    const incompleteCtx = createContext({ existingObjectIds: ALL_OBJECT_IDS.slice(), missingFieldsByObject: { [MAP]: ['plmDrawingNo'] } })
    incompleteCtx.context.api.multitable.provisioning.ensureMissingObjectFields = async () => ({ addedFieldIds: [], skippedExistingFieldIds: [] })
    await rejectsWith(
      () => repairStockPreparationMvpTargets({ context: incompleteCtx.context, projectId: LEAKY_PROJECT_ID, permission: 'admin', objectIds: [MAP] }),
      StockPreparationTargetProvisioningError,
      'MVP_REPAIR_INCOMPLETE',
    )

    // (f) REPAIR_MUTATED_EXISTING_FIELD for MVP: an existing field's content changed
    //     across the additive write → fail closed.
    const mutateCtx = createContext({ existingObjectIds: ALL_OBJECT_IDS.slice(), missingFieldsByObject: { [MAP]: ['plmDrawingNo'] } })
    let readCount = 0
    mutateCtx.context.api.multitable.provisioning.readObjectFieldsContent = async (input) => {
      readCount += 1
      const out = {}
      for (const fieldId of input.fieldIds || []) out[fieldId] = { name: fieldId, type: readCount >= 2 ? 'number' : 'text', property: {} }
      return out
    }
    await rejectsWith(
      () => repairStockPreparationMvpTargets({ context: mutateCtx.context, projectId: LEAKY_PROJECT_ID, permission: 'admin', objectIds: [MAP] }),
      StockPreparationTargetProvisioningError,
      'REPAIR_MUTATED_EXISTING_FIELD',
    )

    // (g) round-5 review P2: a REPAIRED field must be byte-for-byte isomorphic to a
    //     FRESHLY-provisioned one — same property INCLUDING the frozen stockPreparationMvp
    //     metadata. Fresh uses buildMvpTargetDescriptor; repair must use it too (not the
    //     raw structure builder, which omits stockPreparationMvp). Full-property equivalence.
    const isoCtx = createContext({ existingObjectIds: ALL_OBJECT_IDS.slice(), missingFieldsByObject: { [MAP]: ['plmDrawingNo'] } })
    await repairStockPreparationMvpTargets({ context: isoCtx.context, projectId: LEAKY_PROJECT_ID, permission: 'admin', objectIds: [MAP] })
    const mapTemplate = STOCK_PREPARATION_MVP_TABLE_TEMPLATES.find((t) => t.objectId === MAP)
    const freshField = buildMvpTargetDescriptor(mapTemplate).fields.find((f) => f.id === 'plmDrawingNo')
    const submittedField = isoCtx.calls.ensureMissingObjectFields[0].fields.find((f) => f.id === 'plmDrawingNo')
    assert.ok(submittedField, 'repair submitted the missing field')
    assert.ok(freshField.property.stockPreparationMvp, 'CONTROL: fresh field carries frozen mvp metadata')
    assert.deepEqual(submittedField.property, freshField.property, 'repaired field property === fresh (incl stockPreparationMvp)')
    assert.deepEqual(
      { name: submittedField.name, type: submittedField.type, order: submittedField.order },
      { name: freshField.name, type: freshField.type, order: freshField.order },
      'repaired field name/type/order === fresh',
    )

    // (h) round-5 review P2: a field from THIS round's missing set that returns as
    //     skipped-existing = a concurrent writer inserted an UNVERIFIED row → fail closed
    //     (id-exists ≠ shape-correct). Without the guard this reports ready unproven.
    const raceCtx = createContext({ existingObjectIds: ALL_OBJECT_IDS.slice(), missingFieldsByObject: { [MAP]: ['plmDrawingNo'] } })
    raceCtx.context.api.multitable.provisioning.ensureMissingObjectFields = async (input) => ({
      addedFieldIds: [],
      skippedExistingFieldIds: (input.fields || []).map((f) => `fld_${input.objectId}_${f.id}`),
    })
    await rejectsWith(
      () => repairStockPreparationMvpTargets({ context: raceCtx.context, projectId: LEAKY_PROJECT_ID, permission: 'admin', objectIds: [MAP] }),
      StockPreparationTargetProvisioningError,
      'REPAIR_CONCURRENT_FIELD_APPEARED',
    )

    // (i) round-5 review P3: `order` is part of the snapshotted column identity — an
    //     order-ONLY change across the additive write must ALSO fail closed. Landed CI pin
    //     (not just a manual mutation): the fake now carries `order`, and here it drifts.
    const orderCtx = createContext({ existingObjectIds: ALL_OBJECT_IDS.slice(), missingFieldsByObject: { [MAP]: ['plmDrawingNo'] } })
    let orderRead = 0
    orderCtx.context.api.multitable.provisioning.readObjectFieldsContent = async (input) => {
      orderRead += 1
      const out = {}
      for (const fieldId of input.fieldIds || []) out[fieldId] = { name: fieldId, type: 'text', property: {}, order: orderRead >= 2 ? 99 : 1 }
      return out
    }
    await rejectsWith(
      () => repairStockPreparationMvpTargets({ context: orderCtx.context, projectId: LEAKY_PROJECT_ID, permission: 'admin', objectIds: [MAP] }),
      StockPreparationTargetProvisioningError,
      'REPAIR_MUTATED_EXISTING_FIELD',
    )
  }

  console.log('stock-preparation-mvp-provisioning.test.cjs OK')
}

main().catch((error) => {
  console.error('stock-preparation-mvp-provisioning.test.cjs FAILED')
  console.error(error)
  process.exit(1)
})
