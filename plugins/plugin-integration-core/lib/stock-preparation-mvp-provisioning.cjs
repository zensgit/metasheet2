'use strict'

// #3751 MVP: stock-preparation MVP-table readiness / provisioning / option-sync
// runtime. This wires the 9 FROZEN MVP table templates
// (STOCK_PREPARATION_MVP_TABLE_TEMPLATES) into the SAME MetaSheet-internal
// provisioning API the canonical #2253 target helper uses. It is a latent
// backend helper only:
//   - creates/binds table METADATA through context.api.multitable.provisioning,
//   - NEVER reads PLM, NEVER writes MetaSheet business rows (structure only,
//     rows always []),
//   - NEVER calls K3/ERP/apply-writer or any external write path,
//   - is admin-gated + fail-closed, and returns values-free evidence
//     (counts / statuses / field-key NAMES / booleans / public objectId
//     constants only — no sheet ids, physical field ids, or project id values).
//
// It REUSES (does not rebuild) the canonical primitives: the admin gate, the
// provisioning-API accessor, the logical-field diff, and the option-sync
// kernel + normalization.

const {
  STOCK_PREPARATION_MVP_TABLE_TEMPLATES,
  STOCK_PREPARATION_MVP_REQUIRED_OBJECT_IDS,
  buildSheetStructureFromMvpTableTemplate,
  HUMAN_PRESERVED_FIELD_IDS,
} = require('./stock-preparation-templates.cjs')

// W2 template-evolution rung: the repair action's namespace positive control —
// a repaired-in field must be plm_system OR a valid ext_ tenant extension id.
const { assertExtensionFieldIdValid } = require('./stock-preparation-extension-namespace.cjs')

const {
  StockPreparationTargetProvisioningError,
  __internals: {
    getProvisioningApi,
    assertAdminPermission,
    templateFieldIds,
    templateFieldCounts,
    missingLogicalFields,
    assertNoExistingFieldMutated,
  },
} = require('./stock-preparation-target-provisioning.cjs')

const {
  StockPreparationOptionSyncError,
  optionSetsFromInput,
  summarizeOptionSyncEvidence,
  __internals: {
    templateOptionFields,
  },
} = require('./stock-preparation-option-sync.cjs')

// FOS-2: the single option-field-metadata write kernel (loop / skip / patch /
// error-if-none). Stock-prep MVP routes through it exactly like the canonical
// option sync, so there is no parallel write path.
const { syncFieldOptions } = require('./field-option-sync-runtime.cjs')

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function requiredString(value, field) {
  const normalized = optionalString(value)
  if (!normalized) {
    throw new StockPreparationTargetProvisioningError(422, 'MVP_TARGET_CONFIG_INVALID', `${field} is required`, { field })
  }
  return normalized
}

// Resolve the target MVP templates: all 9 by default, or the subset named by
// objectIds. objectIds are validated against the frozen MVP object-id set; an
// unknown id fails closed. The raw offending id is NOT echoed (it may be an
// arbitrary caller-typed table name); only the field name is surfaced.
function resolveTargetTemplates(objectIds) {
  if (objectIds === undefined || objectIds === null) {
    return STOCK_PREPARATION_MVP_TABLE_TEMPLATES.slice()
  }
  if (!Array.isArray(objectIds)) {
    throw new StockPreparationTargetProvisioningError(
      422,
      'MVP_TARGET_OBJECT_ID_INVALID',
      'objectIds must be an array of stock-preparation MVP objectId constants',
      { field: 'objectIds' },
    )
  }
  const known = new Map(STOCK_PREPARATION_MVP_TABLE_TEMPLATES.map((template) => [template.objectId, template]))
  const seen = new Set()
  const selected = []
  for (const raw of objectIds) {
    const objectId = optionalString(raw)
    if (!objectId || !known.has(objectId)) {
      throw new StockPreparationTargetProvisioningError(
        422,
        'MVP_TARGET_OBJECT_ID_INVALID',
        'objectId is not a stock-preparation MVP target',
        { field: 'objectIds', requiredObjectIds: STOCK_PREPARATION_MVP_REQUIRED_OBJECT_IDS.slice() },
      )
    }
    if (!seen.has(objectId)) {
      seen.add(objectId)
      selected.push(known.get(objectId))
    }
  }
  if (!selected.length) {
    throw new StockPreparationTargetProvisioningError(
      422,
      'MVP_TARGET_OBJECT_ID_INVALID',
      'objectIds must name at least one stock-preparation MVP target',
      { field: 'objectIds' },
    )
  }
  return selected
}

// Metadata-only descriptor for provisioning.ensureObject. Structure comes from
// buildSheetStructureFromMvpTableTemplate whose `rows` is ALWAYS []; this
// descriptor deliberately carries NO rows key at all.
function buildMvpTargetDescriptor(template) {
  const structure = buildSheetStructureFromMvpTableTemplate(template)
  const templateById = new Map(template.fields.map((field) => [field.id, field]))
  return {
    id: structure.objectId,
    name: structure.label,
    description: `MetaSheet-internal stock-preparation MVP table (role ${template.role}) generated from the frozen ${template.id} template.`,
    fields: structure.fields.map((field) => {
      const templateField = templateById.get(field.id)
      const property = field.property ? JSON.parse(JSON.stringify(field.property)) : {}
      property.stockPreparationMvp = {
        role: template.role,
        ownership: templateField.ownership,
        preserveOnRefresh: templateField.preserveOnRefresh === true,
        required: templateField.required === true,
        key: templateField.key === true,
      }
      if (templateField.optionSource) {
        property.stockPreparationMvp.optionSource = { ...templateField.optionSource }
      }
      return {
        id: field.id,
        name: field.name,
        type: field.type,
        order: field.order,
        property,
      }
    }),
  }
}

// Per-table readiness by delegating to the provisioning API. Returns a
// values-free descriptor (objectId + role are public constants; missingFields
// are logical field-key NAMES; counts are numeric). No sheet id / physical
// field id leaks.
async function inspectMvpTemplate({ provisioning, projectId, template }) {
  const fieldIds = templateFieldIds(template)
  const sheet = await provisioning.findObjectSheet({ projectId, objectId: template.objectId })
  if (!sheet) {
    return {
      objectId: template.objectId,
      role: template.role,
      present: false,
      ready: false,
      mode: 'mvp_missing',
      missingFields: fieldIds.slice(),
      fieldCounts: templateFieldCounts(template),
      optionFieldCount: templateOptionFields(template).length,
    }
  }
  const resolved = await provisioning.resolveFieldIds({ projectId, objectId: template.objectId, fieldIds })
  const missingFields = missingLogicalFields(template, resolved)
  return {
    objectId: template.objectId,
    role: template.role,
    present: true,
    ready: missingFields.length === 0,
    mode: missingFields.length === 0 ? 'mvp_existing' : 'mvp_incomplete',
    missingFields,
    fieldCounts: templateFieldCounts(template),
    optionFieldCount: templateOptionFields(template).length,
  }
}

function buildInspectEvidence(templates, tables) {
  return {
    tableCount: tables.length,
    readyCount: tables.filter((table) => table.ready).length,
    presentCount: tables.filter((table) => table.present).length,
    absentCount: tables.filter((table) => !table.present).length,
    incompleteCount: tables.filter((table) => table.present && !table.ready).length,
    tables: tables.map((table) => ({
      objectId: table.objectId,
      role: table.role,
      present: table.present,
      ready: table.ready,
      mode: table.mode,
      missingFieldCount: table.missingFields.length,
      missingFields: table.missingFields.slice(),
      fieldCounts: { ...table.fieldCounts },
      optionFieldCount: table.optionFieldCount,
    })),
    targetObjectIds: templates.map((template) => template.objectId),
  }
}

async function inspectStockPreparationMvpTargets({ context, projectId, permission, objectIds } = {}) {
  assertAdminPermission(permission)
  const provisioning = getProvisioningApi(context || {})
  const scopedProjectId = requiredString(projectId, 'projectId')
  const templates = resolveTargetTemplates(objectIds)
  const tables = []
  for (const template of templates) {
    tables.push(await inspectMvpTemplate({ provisioning, projectId: scopedProjectId, template }))
  }
  return {
    ready: tables.every((table) => table.ready),
    tables,
    evidence: buildInspectEvidence(templates, tables),
  }
}

// Ensure ONE MVP table (metadata only). Existing+ready binds; existing+missing
// fields fails closed (never repairs a legacy/business table in place); absent
// creates metadata then re-verifies the logical fields by resolveFieldIds
// rather than trusting ensureObject's physical field ids.
async function ensureMvpTemplate({ provisioning, projectId, baseId, template }) {
  const inspected = await inspectMvpTemplate({ provisioning, projectId, template })
  if (inspected.ready) {
    return {
      objectId: template.objectId,
      role: template.role,
      ensured: true,
      created: false,
      mode: 'mvp_existing',
      missingFields: [],
      fieldCounts: inspected.fieldCounts,
      optionFieldCount: inspected.optionFieldCount,
      rowsSeeded: 0,
    }
  }
  if (inspected.present && !inspected.ready) {
    throw new StockPreparationTargetProvisioningError(
      422,
      'MVP_TARGET_SCHEMA_INCOMPLETE',
      'existing stock-preparation MVP table is missing template fields',
      { objectId: template.objectId, missingFields: inspected.missingFields, requiredFields: templateFieldIds(template) },
    )
  }
  const descriptor = buildMvpTargetDescriptor(template)
  await provisioning.ensureObject({ projectId, baseId: baseId || null, descriptor })
  const resolvedAfterCreate = await provisioning.resolveFieldIds({
    projectId,
    objectId: template.objectId,
    fieldIds: templateFieldIds(template),
  })
  const missingFields = missingLogicalFields(template, resolvedAfterCreate)
  if (missingFields.length) {
    throw new StockPreparationTargetProvisioningError(
      422,
      'MVP_TARGET_SCHEMA_INCOMPLETE',
      'created stock-preparation MVP table is missing template fields',
      { objectId: template.objectId, missingFields, requiredFields: templateFieldIds(template) },
    )
  }
  return {
    objectId: template.objectId,
    role: template.role,
    ensured: true,
    created: true,
    mode: 'mvp_create',
    missingFields: [],
    fieldCounts: templateFieldCounts(template),
    optionFieldCount: templateOptionFields(template).length,
    rowsSeeded: 0,
  }
}

function buildEnsureEvidence(templates, tables) {
  return {
    tableCount: tables.length,
    ensuredCount: tables.filter((table) => table.ensured).length,
    createdCount: tables.filter((table) => table.created).length,
    existingCount: tables.filter((table) => table.ensured && !table.created).length,
    rowsSeeded: 0,
    tables: tables.map((table) => ({
      objectId: table.objectId,
      role: table.role,
      ensured: table.ensured,
      created: table.created,
      mode: table.mode,
      fieldCounts: { ...table.fieldCounts },
      optionFieldCount: table.optionFieldCount,
      rowsSeeded: 0,
    })),
    targetObjectIds: templates.map((template) => template.objectId),
  }
}

async function ensureStockPreparationMvpTargets({ context, projectId, permission, objectIds, baseId } = {}) {
  assertAdminPermission(permission)
  const provisioning = getProvisioningApi(context || {})
  const scopedProjectId = requiredString(projectId, 'projectId')
  const templates = resolveTargetTemplates(objectIds)
  const tables = []
  for (const template of templates) {
    tables.push(await ensureMvpTemplate({ provisioning, projectId: scopedProjectId, baseId: baseId || null, template }))
  }
  return {
    ready: tables.every((table) => table.ensured),
    tables,
    evidence: buildEnsureEvidence(templates, tables),
  }
}

// W2/P2-3 repair runs its whole read/write/verify sweep inside ONE host transaction via
// runObjectFieldsRepairTransaction (atomic fail-close). The tx-bound surface it receives
// provides the ADDITIVE-ONLY ensureMissingObjectFields (never ensureObject's DO-UPDATE)
// plus the reads — so the host must expose the transaction runner, not the bare methods.
function getMvpRepairApi(context) {
  const provisioning = context && context.api && context.api.multitable && context.api.multitable.provisioning
  if (!provisioning || typeof provisioning.runObjectFieldsRepairTransaction !== 'function') {
    throw new StockPreparationTargetProvisioningError(
      503,
      'MVP_REPAIR_API_UNAVAILABLE',
      'stock-preparation MVP repair requires multitable.provisioning.runObjectFieldsRepairTransaction (atomic repair)',
      { requiredMethods: ['runObjectFieldsRepairTransaction'] },
    )
  }
  return provisioning
}

// W2 template-evolution rung — the EXPLICIT repair verb (never folded into ensure;
// the `:232` MVP_TARGET_SCHEMA_INCOMPLETE throw stays a hard fail-closed). Governance:
//   1. admin-gated;
//   2. repair set = missingLogicalFields(template, resolved) ONLY — the caller passes
//      objectIds, never a free field list, so no arbitrary field can be injected;
//   3. every repaired-in field must be `plm_system` OR pass the ext_ namespace
//      validator — a `human_preserved` new column is rejected (REPAIR_HUMAN_FIELD_FORBIDDEN):
//      the human whitelist (templates.cjs) is the load-bearing vocab of the apply-writer
//      ownership wall + carry-policy; growing it is a separate design gate, never a repair
//      back door;
//   4. existing columns are constructively untouched by ensureMissingObjectFields
//      (ON CONFLICT DO NOTHING; proven at the primitive layer by the W2 realdb test).
async function repairStockPreparationMvpTargets({ context, projectId, permission, objectIds } = {}) {
  assertAdminPermission(permission)
  const provisioning = getMvpRepairApi(context || {})
  const scopedProjectId = requiredString(projectId, 'projectId')
  const templates = resolveTargetTemplates(objectIds)
  const humanSet = new Set(HUMAN_PRESERVED_FIELD_IDS)
  // ATOMIC repair (round-5 review P2-3): repair ALL requested tables inside ONE host
  // transaction. Any table's verify throw (mutated / incomplete / concurrent-appeared /
  // absent) propagates out and ROLLS BACK the whole sweep, so a partial multi-table repair
  // never commits — atomic fail-close, not a post-commit detection canary. Every DB touch
  // goes through `tx`; pure prep (admin gate, template resolution, ownership) needs no tx.
  const tables = await provisioning.runObjectFieldsRepairTransaction(async (tx) => {
    const acc = []
    for (const template of templates) {
      const sheet = await tx.findObjectSheet({ projectId: scopedProjectId, objectId: template.objectId })
      if (!sheet) {
        // Repair only heals an EXISTING table's missing template fields; a wholly
        // absent table is an ensure/provision concern, not a repair one.
        throw new StockPreparationTargetProvisioningError(
          409,
          'MVP_REPAIR_TARGET_ABSENT',
          'stock-preparation MVP repair requires an already-provisioned table',
          { objectId: template.objectId },
        )
      }
      const fieldIds = templateFieldIds(template)
      const resolved = await tx.resolveExistingObjectFieldIds({ projectId: scopedProjectId, objectId: template.objectId, fieldIds })
      const missingIds = missingLogicalFields(template, resolved)
      const existingIds = fieldIds.filter((id) => !missingIds.includes(id))
      const beforeContent = await tx.readObjectFieldsContent({ projectId: scopedProjectId, objectId: template.objectId, fieldIds: existingIds })
      // Build repaired-field descriptors from the SAME builder the fresh ensure path uses
      // (buildMvpTargetDescriptor, not the raw buildSheetStructureFromMvpTableTemplate) so a
      // repaired column is byte-for-byte isomorphic to a freshly-provisioned one — including
      // the frozen `property.stockPreparationMvp` metadata (round-5 review P2: repair must not
      // emit a structurally-different field than fresh provisioning). Proven by the
      // fresh-vs-repair full-property equivalence test.
      const descriptor = buildMvpTargetDescriptor(template)
      const ownershipById = new Map(template.fields.map((field) => [field.id, field.ownership]))
      const missingDescriptors = []
      for (const id of missingIds) {
        const ownership = ownershipById.get(id)
        if (humanSet.has(id) || ownership === 'human_preserved') {
          throw new StockPreparationTargetProvisioningError(
            422,
            'REPAIR_HUMAN_FIELD_FORBIDDEN',
            'repair may not add a human_preserved column; grow the human whitelist through its own design gate',
            { objectId: template.objectId, fieldId: id },
          )
        }
        if (ownership !== 'plm_system') {
          // A non-plm_system template field id must be a valid tenant extension id.
          assertExtensionFieldIdValid(id, { templateFieldIds: fieldIds })
        }
        const found = descriptor.fields.find((field) => field.id === id)
        if (found) missingDescriptors.push(found)
      }
      const result = await tx.ensureMissingObjectFields({
        projectId: scopedProjectId,
        objectId: template.objectId,
        fields: missingDescriptors,
      })
      // CONCURRENCY fail-close (round-5 review P2): we submitted ONLY this round's missing
      // set, so a skipped-existing id means a competing writer inserted that column between
      // our resolve and our write. We neither added it nor content-verified its row against
      // the frozen descriptor, so `ready` would be UNPROVEN (id-exists ≠ shape-correct).
      // Fail closed — repair is idempotent, a retry after the race settles re-verifies.
      if (result.skippedExistingFieldIds.length) {
        throw new StockPreparationTargetProvisioningError(
          409,
          'REPAIR_CONCURRENT_FIELD_APPEARED',
          'a missing field was inserted by a concurrent writer during repair; retry after it settles',
          { objectId: template.objectId, skippedExistingFieldCount: result.skippedExistingFieldIds.length },
        )
      }
      // POST-WRITE completeness re-verify (never report ready unproven).
      const resolvedAfter = await tx.resolveExistingObjectFieldIds({ projectId: scopedProjectId, objectId: template.objectId, fieldIds })
      const stillMissing = missingLogicalFields(template, resolvedAfter)
      if (stillMissing.length) {
        throw new StockPreparationTargetProvisioningError(
          409,
          'MVP_REPAIR_INCOMPLETE',
          'MVP repair did not reach a complete schema; a field is still missing after the additive write',
          { objectId: template.objectId, missingFieldCount: stillMissing.length },
        )
      }
      assertNoExistingFieldMutated(beforeContent, await tx.readObjectFieldsContent({ projectId: scopedProjectId, objectId: template.objectId, fieldIds: existingIds }), template.objectId)
      acc.push({
        objectId: template.objectId,
        role: template.role,
        repaired: result.addedFieldIds.length > 0,
        mode: result.addedFieldIds.length > 0 ? 'mvp_repaired' : 'mvp_already_ready',
        addedFieldCount: result.addedFieldIds.length,
        skippedExistingFieldCount: result.skippedExistingFieldIds.length,
        schemaCompleteAfter: true,
        templateVersion: template.version,
      })
    }
    return acc
  })
  return {
    ready: true,
    tables,
    evidence: {
      action: 'stock_preparation_mvp_repair',
      repairedTableCount: tables.filter((table) => table.repaired).length,
      tables: tables.map((table) => ({
        objectId: table.objectId,
        mode: table.mode,
        addedFieldCount: table.addedFieldCount,
        templateVersion: table.templateVersion,
      })),
    },
  }
}

// Option sync needs patchObjectFieldProperty (not ensureObject); this mirrors
// the canonical option-sync API accessor's method requirement while keeping the
// single StockPreparationTargetProvisioningError gate shape.
function getMvpOptionSyncApi(context) {
  const provisioning = context && context.api && context.api.multitable && context.api.multitable.provisioning
  if (
    !provisioning ||
    typeof provisioning.findObjectSheet !== 'function' ||
    typeof provisioning.resolveFieldIds !== 'function' ||
    typeof provisioning.patchObjectFieldProperty !== 'function'
  ) {
    throw new StockPreparationTargetProvisioningError(
      503,
      'MVP_OPTION_SYNC_API_UNAVAILABLE',
      'stock-preparation MVP option sync requires multitable.provisioning patchObjectFieldProperty API',
      { requiredMethods: ['findObjectSheet', 'resolveFieldIds', 'patchObjectFieldProperty'] },
    )
  }
  return provisioning
}

// The exact patch body: the select options + values-free stockPreparationMvp
// option metadata. Option VALUES/labels ride the patch (necessary field
// metadata) but NEVER the returned evidence.
function buildPropertyPatch(field, set) {
  return {
    options: set.options.map((option) => {
      const out = { value: option.value }
      if (option.label) out.label = option.label
      if (option.color) out.color = option.color
      if (option.disabled) out.disabled = true
      return out
    }),
    stockPreparationMvp: {
      optionSource: { ...field.optionSource },
      optionSync: {
        sourceType: field.optionSource.type,
        sourceKey: field.optionSource.key,
        optionCount: set.options.length,
        actionBindingCount: set.actionBindings.length,
      },
    },
  }
}

function resolveSkipReason(field) {
  return field.optionSource.type === 'config_info' ? 'config_info_not_supplied' : 'contract_not_available'
}

const OPTION_SYNC_ERROR_FACTORY = {
  patchFailed: ({ field, sourceKey, error }) =>
    new StockPreparationOptionSyncError(
      422,
      'OPTION_SYNC_FIELD_PATCH_FAILED',
      'failed to patch stock-preparation MVP option field metadata',
      { field, sourceKey, errorCode: (error && (error.code || error.name)) || 'FIELD_PATCH_FAILED' },
    ),
  noFieldsSynced: ({ targetObjectId, skipped }) =>
    new StockPreparationOptionSyncError(
      422,
      'OPTION_SYNC_NO_FIELDS',
      'no stock-preparation MVP option fields were synchronized',
      { targetObjectId, skipped: skipped.map((entry) => ({ field: entry.field, reason: entry.reason })) },
    ),
}

// Sync ONE MVP table's option fields. No option fields => no-op. Target not yet
// provisioned => skip (fail closed, never patch an unprovisioned table). No
// supplied set matches this table's source keys => all fields skipped (no
// patch). Otherwise route the supplied sets through the shared kernel.
async function syncMvpTemplateOptions({ provisioning, projectId, template, suppliedSets }) {
  const optionFields = templateOptionFields(template)
  if (optionFields.length === 0) {
    return {
      objectId: template.objectId,
      role: template.role,
      optionFieldCount: 0,
      syncedCount: 0,
      skippedCount: 0,
      mode: 'mvp_no_option_fields',
      synced: [],
      skipped: [],
    }
  }
  const sheet = await provisioning.findObjectSheet({ projectId, objectId: template.objectId })
  if (!sheet) {
    const skipped = optionFields.map((field) => ({
      field: field.id,
      optionSource: { ...field.optionSource },
      reason: 'target_not_ready',
    }))
    return {
      objectId: template.objectId,
      role: template.role,
      optionFieldCount: optionFields.length,
      syncedCount: 0,
      skippedCount: skipped.length,
      mode: 'mvp_target_not_ready',
      synced: [],
      skipped,
    }
  }
  const hasMatch = optionFields.some((field) => suppliedSets[field.optionSource.key])
  if (!hasMatch) {
    const skipped = optionFields.map((field) => ({
      field: field.id,
      optionSource: { ...field.optionSource },
      reason: resolveSkipReason(field),
    }))
    return {
      objectId: template.objectId,
      role: template.role,
      optionFieldCount: optionFields.length,
      syncedCount: 0,
      skippedCount: skipped.length,
      mode: 'mvp_options_not_supplied',
      synced: [],
      skipped,
    }
  }
  const { synced: syncedRaw, skipped } = await syncFieldOptions({
    provisioning,
    projectId,
    targetObjectId: template.objectId,
    optionFields,
    optionSets: suppliedSets,
    buildPropertyPatch,
    resolveSkipReason,
    errorFactory: OPTION_SYNC_ERROR_FACTORY,
  })
  const synced = syncedRaw.map((entry) => ({
    field: entry.field,
    optionSource: entry.optionSource,
    optionCount: entry.set.options.length,
    actionBindingCount: entry.set.actionBindings.length,
  }))
  return {
    objectId: template.objectId,
    role: template.role,
    optionFieldCount: optionFields.length,
    syncedCount: synced.length,
    skippedCount: skipped.length,
    mode: 'mvp_options_synced',
    synced,
    skipped,
  }
}

function buildOptionSyncEvidence(templates, tables) {
  const templateByObjectId = new Map(templates.map((template) => [template.objectId, template]))
  return {
    tableCount: tables.length,
    optionTableCount: tables.filter((table) => table.optionFieldCount > 0).length,
    syncedFieldCount: tables.reduce((sum, table) => sum + table.syncedCount, 0),
    skippedFieldCount: tables.reduce((sum, table) => sum + table.skippedCount, 0),
    tables: tables.map((table) => ({
      // Reuse the canonical values-free option-sync evidence summarizer for the
      // per-table objectId + fields + skipped shape.
      ...summarizeOptionSyncEvidence({
        template: templateByObjectId.get(table.objectId),
        synced: table.synced,
        skipped: table.skipped,
        includeObjectId: true,
      }),
      role: table.role,
      mode: table.mode,
      optionFieldCount: table.optionFieldCount,
      syncedFieldCount: table.syncedCount,
      skippedFieldCount: table.skippedCount,
    })),
    targetObjectIds: templates.map((template) => template.objectId),
  }
}

async function syncStockPreparationMvpOptions({ context, projectId, permission, objectIds, optionSets } = {}) {
  assertAdminPermission(permission)
  const provisioning = getMvpOptionSyncApi(context || {})
  const scopedProjectId = requiredString(projectId, 'projectId')
  const templates = resolveTargetTemplates(objectIds)

  // Reuse the canonical option-set normalization (safe-string / executable-key
  // / secret-shape validation). Option VALUES are caller-supplied admin
  // governance vocabulary — nothing is hardcoded here.
  const suppliedSets = optionSetsFromInput(optionSets || {})

  const declaredSourceKeys = new Set()
  for (const template of templates) {
    for (const field of templateOptionFields(template)) {
      declaredSourceKeys.add(field.optionSource.key)
    }
  }
  const unknownSourceKey = Object.keys(suppliedSets).find((sourceKey) => !declaredSourceKeys.has(sourceKey))
  if (unknownSourceKey) {
    throw new StockPreparationOptionSyncError(
      422,
      'OPTION_SYNC_UNKNOWN_SOURCE',
      'option set source key is not declared by any targeted stock-preparation MVP template',
      { sourceKey: unknownSourceKey },
    )
  }

  const tables = []
  for (const template of templates) {
    tables.push(await syncMvpTemplateOptions({ provisioning, projectId: scopedProjectId, template, suppliedSets }))
  }
  return {
    ok: true,
    tables,
    evidence: buildOptionSyncEvidence(templates, tables),
  }
}

module.exports = {
  repairStockPreparationMvpTargets,
  inspectStockPreparationMvpTargets,
  ensureStockPreparationMvpTargets,
  syncStockPreparationMvpOptions,
  buildMvpTargetDescriptor,
  __internals: {
    resolveTargetTemplates,
    inspectMvpTemplate,
    ensureMvpTemplate,
    syncMvpTemplateOptions,
    buildMvpTargetDescriptor,
    buildPropertyPatch,
    resolveSkipReason,
    getMvpOptionSyncApi,
  },
}
