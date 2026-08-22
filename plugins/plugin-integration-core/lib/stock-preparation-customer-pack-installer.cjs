'use strict'

// P0 — customer config pack INSTALLER.
//
// Takes a pack normalized by stock-preparation-customer-pack.cjs and lands it on
// the already-provisioned canonical stock-preparation main table through the
// host multitable provisioning API. Nothing else: it reads no PLM, calls no K3,
// writes no business rows, and reaches no external system.
//
// THREE structural rules make a re-run safe, and they are the whole design:
//
//   1. `ensureObject` is NEVER called. It is not even required on the API
//      surface this module asserts. `ensureObject` re-writes every field's
//      `property` wholesale (multitable/provisioning.ts ensureFields, INSERT …
//      ON CONFLICT DO UPDATE), so a second install through it would wipe the
//      select options the previous install just synced. Columns are added ONLY
//      through `ensureMissingObjectFields` (ON CONFLICT DO NOTHING), the
//      additive primitive whose statement set contains no UPDATE and no DELETE.
//
//   2. The canonical object is a PRECONDITION, not something this installer
//      creates. If the main table is absent we fail closed and name the
//      existing ensure path (ensureStockPreparationCanonicalTarget in
//      stock-preparation-target-provisioning.cjs) rather than duplicating the
//      frozen template's provisioning logic here.
//
//   3. Only `ext_`-namespaced columns are ever added. Every id was already
//      checked against the frozen template catalog by the pack normalizer, so
//      this installer cannot add, retype, rename or remove a template column.
//
//   4. A pack column that ALREADY EXISTS still gets its ownership classified.
//      This is the real takeover shape: the customer's sheet was hand-built in
//      the UI, so every pack column is already there with `property: {}`.
//      `ensureMissingObjectFields` reports those as skipped and — by rule 1 —
//      cannot touch them, which used to leave them UNCLASSIFIED. Unclassified
//      is not neutral: the generic multitable ownership write-guard treats a
//      field as protected only when a `stockPreparation` / `stockPreparationMvp`
//      stanza says ownership === 'human_preserved' OR preserveOnRefresh === true,
//      so a hand-built human column with no stanza is WRITABLE by any pipeline.
//      Converging the sheet therefore means stamping ownership onto the columns
//      that already exist, ADDITIVELY, through patchObjectFieldProperty (the
//      host merges a property patch recursively, so a previously-synced option
//      set survives the stamp untouched).
//
//      Re-classification is never silent. Before ANY write the installer reads
//      the current property of every pack column that exists and sorts it into
//      needs-a-stamp / already-stamped / CONFLICTING. A conflicting column — one
//      whose live stanza declares an ownership or preserveOnRefresh that
//      disagrees with the pack — aborts the whole install
//      (CUSTOMER_PACK_OWNERSHIP_CONFLICT) before a single field is created or
//      patched. Flipping a live column from human-owned to system-owned, or the
//      reverse, is a decision for a human to make in the pack, not something an
//      installer may do on its way past.
//
// Option-set writes route through the SHARED field-option-sync kernel
// (field-option-sync-runtime.cjs), the single place option metadata is patched,
// so a pack dictionary and a runtime option sync hit the host identically.
//
// Values-free: the returned summary and every log line carry schema ids and
// counts only — never an option value, a label or a row.

const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  STOCK_PREPARATION_FIELD_OWNERSHIPS,
} = require('./stock-preparation-templates.cjs')
const { normalizeCustomerPack } = require('./stock-preparation-customer-pack.cjs')
const { syncFieldOptions } = require('./field-option-sync-runtime.cjs')

// Extension columns sort AFTER every frozen template column. The canonical
// template is 26 fields today; a base far above it keeps pack columns at the
// right edge of the grid even as the template grows, and keeps the order value
// deterministic across installs (an unstable order would make "idempotent" a
// claim rather than a fact).
const EXTENSION_FIELD_ORDER_BASE = 1000

// Methods this installer genuinely needs. `ensureObject` is deliberately absent
// — see rule 1 above; requiring it would invite a future edit to reach for it.
// `readObjectFieldsContent` IS required (rule 4): without the pre-scan the
// installer cannot tell a hand-built column from a converged one, and it must
// never guess. The host exposes it on the same scoped provisioning surface as
// the write primitives (multitable/plugin-scope.ts), object-scope checked.
const REQUIRED_PROVISIONING_METHODS = Object.freeze([
  'findObjectSheet',
  'getFieldId',
  'readObjectFieldsContent',
  'ensureMissingObjectFields',
  'patchObjectFieldProperty',
  'ensureView',
])

// The two property namespaces the generic multitable ownership write-guard reads
// (adapters/multitable-ownership-guard.cjs). Conflict detection mirrors the guard
// exactly: a contradiction in EITHER namespace is a contradiction, because the
// guard ORs across both. The installer only ever WRITES the first one — the MVP
// namespace belongs to the MVP provisioner and is not this installer's to edit.
const OWNERSHIP_PROPERTY_NAMESPACES = Object.freeze(['stockPreparation', 'stockPreparationMvp'])

class StockPreparationCustomerPackInstallError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationCustomerPackInstallError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function assertProvisioningApi(provisioning) {
  const missing = REQUIRED_PROVISIONING_METHODS.filter(
    (method) => !provisioning || typeof provisioning[method] !== 'function',
  )
  if (missing.length) {
    throw new StockPreparationCustomerPackInstallError(
      503,
      'CUSTOMER_PACK_API_UNAVAILABLE',
      'customer pack install requires the multitable provisioning API',
      { requiredMethods: [...REQUIRED_PROVISIONING_METHODS], missingMethods: missing },
    )
  }
  return provisioning
}

function requiredProjectId(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new StockPreparationCustomerPackInstallError(
      422,
      'CUSTOMER_PACK_PROJECT_ID_REQUIRED',
      'customer pack install requires a projectId',
      { field: 'projectId' },
    )
  }
  return value.trim()
}

// The ownership write path, mirroring buildFieldProperty in
// stock-preparation-target-provisioning.cjs. Written out rather than imported:
// that one is shaped by the frozen template's field descriptor (it reads
// `optionSource` / `key` off a template field) and is not on the module's public
// export surface. The `stockPreparation` record keeps the SAME key set as the
// canonical writer's so a consumer never has to branch on which writer made a
// column, plus the pack provenance that identifies it as tenant-added.
function buildExtensionFieldProperty(field, pack) {
  return {
    stockPreparation: {
      ownership: field.ownership,
      preserveOnRefresh: field.ownership === 'human_preserved',
      required: false,
      key: false,
      extension: true,
      packId: pack.packId,
      packVersion: pack.packVersion,
    },
  }
}

// Field descriptors for ensureMissingObjectFields. Note: no `options` key ever
// — the host's buildFieldProperty would fold inline options into the property,
// which is precisely the inline-options path the frozen template bans. Select
// options arrive later, through the option-sync kernel.
function buildExtensionFieldDescriptors(pack) {
  return pack.extensionFields.map((field, index) => ({
    id: field.id,
    name: field.label,
    type: field.type,
    order: EXTENSION_FIELD_ORDER_BASE + index,
    property: buildExtensionFieldProperty(field, pack),
  }))
}

// The ADDITIVE ownership stamp for a column that already exists (rule 4). It is
// deliberately NARROWER than buildExtensionFieldProperty: only the two keys the
// ownership guard actually reads, plus the provenance that says who put them
// there. `required` and `key` are left out on purpose — they are not ownership
// classification, and a live hand-built column may carry its own; overwriting
// them would be exactly the kind of silent re-classification rule 4 forbids.
function buildOwnershipStampPatch(field, pack) {
  return {
    stockPreparation: {
      ownership: field.ownership,
      preserveOnRefresh: field.preserveOnRefresh,
      extension: true,
      packId: pack.packId,
      packVersion: pack.packVersion,
    },
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

// Report a declared ownership value in the error details WITHOUT echoing whatever
// a hand-built column happens to carry: a recognized vocabulary member is schema,
// anything else could be arbitrary text and the summary is values-free.
function describeDeclaredOwnership(value) {
  if (value === undefined) return null
  return STOCK_PREPARATION_FIELD_OWNERSHIPS.includes(value) ? value : 'unrecognized'
}

function describeDeclaredPreserveOnRefresh(value) {
  if (value === undefined) return null
  return typeof value === 'boolean' ? value : 'unrecognized'
}

// One existing column against one pack declaration. A key that is ABSENT is not a
// disagreement — there is nothing to disagree with, and stamping it is the whole
// point. A key that is PRESENT and not strictly equal to the pack's value is a
// conflict, junk types included: an installer that cannot read a live
// classification must not overwrite it.
function classifyExistingField(field, property) {
  const conflicts = []
  for (const namespace of OWNERSHIP_PROPERTY_NAMESPACES) {
    const stanza = isPlainObject(property) ? property[namespace] : undefined
    if (!isPlainObject(stanza)) continue
    if (stanza.ownership !== undefined && stanza.ownership !== field.ownership) {
      conflicts.push({
        field: field.id,
        namespace,
        property: 'ownership',
        declared: describeDeclaredOwnership(stanza.ownership),
        expected: field.ownership,
      })
    }
    if (stanza.preserveOnRefresh !== undefined && stanza.preserveOnRefresh !== field.preserveOnRefresh) {
      conflicts.push({
        field: field.id,
        namespace,
        property: 'preserveOnRefresh',
        declared: describeDeclaredPreserveOnRefresh(stanza.preserveOnRefresh),
        expected: field.preserveOnRefresh,
      })
    }
  }
  if (conflicts.length) return { state: 'CONFLICT', conflicts }

  // Already stamped only when the namespace this installer writes carries BOTH
  // guard-relevant keys at the pack's values. A half-stanza (or a match that only
  // exists in the MVP namespace) still needs the stamp — and stamping it is a
  // no-op-shaped merge, never a re-classification, since nothing disagreed.
  //
  // Deliberately NOT part of this comparison: packId / packVersion. They are
  // provenance, not classification. Folding them in would make every pack version
  // bump re-patch every column — churn on a live sheet to correct a label nothing
  // enforces — and would put "idempotent" at the mercy of a version string. A
  // column stamped by an earlier version keeps that provenance until its
  // ownership actually changes, which is the only event worth a write.
  const stanza = isPlainObject(property) ? property.stockPreparation : undefined
  if (
    isPlainObject(stanza)
    && stanza.ownership === field.ownership
    && stanza.preserveOnRefresh === field.preserveOnRefresh
  ) {
    return { state: 'ALREADY_STAMPED', conflicts: [] }
  }
  return { state: 'NEEDS_STAMP', conflicts: [] }
}

/**
 * VALIDATE-ALL-THEN-WRITE pre-scan (rule 4). Runs before the first mutation of
 * the install and reads the live property of every pack column that already
 * exists. Returns the two work lists; throws on the first conflicting set, so a
 * pack that disagrees with the live sheet never lands half of itself.
 */
async function classifyExistingExtensionFields({ provisioning, projectId, pack }) {
  if (pack.extensionFields.length === 0) {
    return { needsStamp: [], alreadyStamped: [] }
  }
  let content
  try {
    content = await provisioning.readObjectFieldsContent({
      projectId,
      objectId: pack.targetObjectId,
      fieldIds: pack.extensionFields.map((field) => field.id),
    })
  } catch (error) {
    // Same posture as the ownership guard's unverifiable-metadata refusal: an
    // installer that cannot read the live classification must stop, because the
    // alternative is silently leaving human columns writable.
    throw new StockPreparationCustomerPackInstallError(
      422,
      'CUSTOMER_PACK_OWNERSHIP_UNVERIFIED',
      'failed to read existing customer pack field ownership before installing',
      {
        objectId: pack.targetObjectId,
        packId: pack.packId,
        errorCode: (error && (error.code || error.name)) || 'FIELD_READ_FAILED',
      },
    )
  }

  const needsStamp = []
  const alreadyStamped = []
  const conflicts = []
  const byLogicalId = isPlainObject(content) ? content : {}
  for (const field of pack.extensionFields) {
    const existing = byLogicalId[field.id]
    // Absent from the content map == the column does not exist yet. It will be
    // created with a full ownership property, so it needs no stamp.
    if (!existing) continue
    const verdict = classifyExistingField(field, existing.property)
    if (verdict.state === 'CONFLICT') conflicts.push(...verdict.conflicts)
    else if (verdict.state === 'ALREADY_STAMPED') alreadyStamped.push(field.id)
    else needsStamp.push(field.id)
  }

  if (conflicts.length) {
    throw new StockPreparationCustomerPackInstallError(
      409,
      'CUSTOMER_PACK_OWNERSHIP_CONFLICT',
      'customer pack ownership disagrees with the live classification of an existing column; '
        + 'no field was created or patched',
      {
        objectId: pack.targetObjectId,
        packId: pack.packId,
        conflictingFields: [...new Set(conflicts.map((entry) => entry.field))],
        conflicts,
      },
    )
  }
  return { needsStamp, alreadyStamped }
}

async function stampExistingExtensionFields({ provisioning, projectId, pack, fieldIds }) {
  if (fieldIds.length === 0) return []
  const byId = new Map(pack.extensionFields.map((field) => [field.id, field]))
  const stamped = []
  for (const fieldId of fieldIds) {
    const field = byId.get(fieldId)
    if (!field) continue
    try {
      await provisioning.patchObjectFieldProperty({
        projectId,
        objectId: pack.targetObjectId,
        // LOGICAL id: the host resolves it to the physical one, exactly as the
        // option-sync kernel hands it over.
        fieldId,
        propertyPatch: buildOwnershipStampPatch(field, pack),
      })
    } catch (error) {
      throw new StockPreparationCustomerPackInstallError(
        422,
        'CUSTOMER_PACK_OWNERSHIP_STAMP_FAILED',
        'failed to stamp ownership onto an existing customer pack field',
        {
          objectId: pack.targetObjectId,
          packId: pack.packId,
          field: fieldId,
          errorCode: (error && (error.code || error.name)) || 'FIELD_PATCH_FAILED',
        },
      )
    }
    stamped.push(fieldId)
  }
  return stamped
}

// Where a synced option set's `optionSource` comes from. For a frozen template
// select field it is the template's OWN declared source, so an install cannot
// silently re-label a canonical column's dictionary origin. For a pack column
// there is no template declaration, so the field id is the source key.
function resolveOptionSource(fieldId) {
  const templateField = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.find((field) => field.id === fieldId)
  if (templateField && templateField.optionSource) return { ...templateField.optionSource }
  return { type: 'config_info', key: fieldId }
}

// The kernel routes field -> set by `field.optionSource.key`. Routing on the
// FIELD ID (never on the canonical source key) keeps two pack sets from ever
// colliding on one key, while the canonical source still reaches the patch body.
function buildOptionSyncInputs(pack) {
  const optionFields = []
  const optionSets = {}
  const canonicalSourceByFieldId = new Map()
  for (const set of pack.optionSets) {
    optionFields.push({ id: set.fieldId, optionSource: { type: 'config_info', key: set.fieldId } })
    optionSets[set.fieldId] = { options: set.options, actionBindings: set.actionBindings }
    canonicalSourceByFieldId.set(set.fieldId, resolveOptionSource(set.fieldId))
  }
  return { optionFields, optionSets, canonicalSourceByFieldId }
}

// Byte-identical to the option patch stock-preparation-option-sync.cjs sends,
// plus a `customerPack` provenance stanza. Same kernel, same wire.
function buildOptionPropertyPatch({ field, set, canonicalSource, pack }) {
  return {
    options: set.options.map((option) => {
      const out = { value: option.value }
      if (option.label) out.label = option.label
      if (option.color) out.color = option.color
      if (option.disabled) out.disabled = true
      return out
    }),
    stockPreparation: {
      optionSource: { ...canonicalSource },
      optionSync: {
        sourceType: canonicalSource.type,
        sourceKey: canonicalSource.key,
        optionCount: set.options.length,
        actionBindingCount: set.actionBindings.length,
      },
      optionActionBindings: set.actionBindings.map((binding) => ({ ...binding })),
      customerPack: {
        packId: pack.packId,
        packVersion: pack.packVersion,
        fieldId: field.id,
      },
    },
  }
}

// A view's hidden columns are stored as PHYSICAL field ids (meta_views
// .hidden_field_ids is compared against meta_fields.id), so the pack's logical
// ids must be mapped through the host's stable-id function — the same mapping
// erp-feedback.cjs and the multitable target adapter already use.
function buildRoleViewDescriptor({ provisioning, projectId, pack, roleView }) {
  return {
    id: `sp-${pack.packId}-${roleView.viewId}`,
    objectId: pack.targetObjectId,
    name: roleView.label,
    type: 'grid',
    hiddenFieldIds: roleView.hiddenFieldIds.map((fieldId) =>
      provisioning.getFieldId(projectId, pack.targetObjectId, fieldId),
    ),
    config: {
      stockPreparationCustomerPack: {
        packId: pack.packId,
        packVersion: pack.packVersion,
        roleViewId: roleView.viewId,
        hideOwnerships: [...roleView.hideOwnerships],
        hiddenFieldCount: roleView.hiddenFieldIds.length,
      },
    },
  }
}

async function ensureExtensionFields({ provisioning, projectId, pack }) {
  if (pack.extensionFields.length === 0) {
    return { createdFields: [], skippedFields: [] }
  }
  // Logical -> physical up front: ensureMissingObjectFields reports PHYSICAL
  // ids, and a values-free summary must speak in the pack's own logical ids.
  const logicalByPhysical = new Map()
  for (const field of pack.extensionFields) {
    logicalByPhysical.set(provisioning.getFieldId(projectId, pack.targetObjectId, field.id), field.id)
  }

  let result
  try {
    result = await provisioning.ensureMissingObjectFields({
      projectId,
      objectId: pack.targetObjectId,
      fields: buildExtensionFieldDescriptors(pack),
    })
  } catch (error) {
    throw new StockPreparationCustomerPackInstallError(
      422,
      'CUSTOMER_PACK_FIELD_WRITE_FAILED',
      'failed to add customer pack extension fields',
      {
        objectId: pack.targetObjectId,
        packId: pack.packId,
        errorCode: (error && (error.code || error.name)) || 'FIELD_WRITE_FAILED',
      },
    )
  }

  const toLogical = (ids) => (Array.isArray(ids) ? ids : []).map((id) => logicalByPhysical.get(id) || id)
  return {
    createdFields: toLogical(result && result.addedFieldIds),
    skippedFields: toLogical(result && result.skippedExistingFieldIds),
  }
}

async function syncPackOptionSets({ provisioning, projectId, pack }) {
  if (pack.optionSets.length === 0) return []
  const { optionFields, optionSets, canonicalSourceByFieldId } = buildOptionSyncInputs(pack)
  const { synced } = await syncFieldOptions({
    provisioning,
    projectId,
    targetObjectId: pack.targetObjectId,
    optionFields,
    optionSets,
    buildPropertyPatch: (field, set) =>
      buildOptionPropertyPatch({
        field,
        set,
        canonicalSource: canonicalSourceByFieldId.get(field.id),
        pack,
      }),
    // Every declared set is present by construction (the map is built from the
    // pack itself), so a skip here would mean the pack and the kernel disagree.
    resolveSkipReason: () => 'pack_option_set_missing',
    errorFactory: {
      patchFailed: ({ field, error }) =>
        new StockPreparationCustomerPackInstallError(
          422,
          'CUSTOMER_PACK_OPTION_SYNC_FAILED',
          'failed to patch customer pack option field metadata',
          {
            objectId: pack.targetObjectId,
            packId: pack.packId,
            field,
            errorCode: (error && (error.code || error.name)) || 'FIELD_PATCH_FAILED',
          },
        ),
      noFieldsSynced: ({ skipped }) =>
        new StockPreparationCustomerPackInstallError(
          422,
          'CUSTOMER_PACK_OPTION_SYNC_FAILED',
          'no customer pack option fields were synchronized',
          {
            objectId: pack.targetObjectId,
            packId: pack.packId,
            skipped: (skipped || []).map((entry) => ({ field: entry.field, reason: entry.reason })),
          },
        ),
    },
  })
  return synced.map((entry) => entry.field)
}

async function ensureRoleViews({ provisioning, projectId, sheetId, pack }) {
  const ensured = []
  for (const roleView of pack.roleViews) {
    const descriptor = buildRoleViewDescriptor({ provisioning, projectId, pack, roleView })
    let view
    try {
      view = await provisioning.ensureView({ projectId, sheetId, descriptor })
    } catch (error) {
      throw new StockPreparationCustomerPackInstallError(
        422,
        'CUSTOMER_PACK_VIEW_FAILED',
        'failed to ensure a customer pack role view',
        {
          objectId: pack.targetObjectId,
          packId: pack.packId,
          roleViewId: roleView.viewId,
          errorCode: (error && (error.code || error.name)) || 'VIEW_ENSURE_FAILED',
        },
      )
    }
    if (!view || !view.id) {
      throw new StockPreparationCustomerPackInstallError(
        422,
        'CUSTOMER_PACK_VIEW_FAILED',
        'ensureView returned no view id for a customer pack role view',
        { objectId: pack.targetObjectId, packId: pack.packId, roleViewId: roleView.viewId },
      )
    }
    ensured.push({
      roleViewId: roleView.viewId,
      descriptorId: descriptor.id,
      hiddenFieldCount: descriptor.hiddenFieldIds.length,
    })
  }
  return ensured
}

/**
 * Install a customer config pack onto the canonical stock-preparation main
 * table. Additive only, idempotent: a second run adds no column, drops no
 * column, and never calls ensureObject.
 *
 *   provisioning — scoped host multitable provisioning API
 *   projectId    — already-resolved tenant project id
 *   pack         — raw or normalized pack (normalized here either way)
 *   logger       — optional; only values-free counts are ever logged
 *
 * Returns a values-free summary: schema ids and counts, never option values.
 */
async function installCustomerPack({ provisioning, projectId, pack, logger } = {}) {
  const api = assertProvisioningApi(provisioning)
  const resolvedProjectId = requiredProjectId(projectId)
  const normalized = normalizeCustomerPack(pack)

  // PRECONDITION, not a creation path: the canonical table must already exist.
  const sheet = await api.findObjectSheet({ projectId: resolvedProjectId, objectId: normalized.targetObjectId })
  if (!sheet || !sheet.id) {
    throw new StockPreparationCustomerPackInstallError(
      409,
      'CUSTOMER_PACK_TARGET_ABSENT',
      'customer pack install requires an already-provisioned canonical stock-preparation target; '
        + 'run ensureStockPreparationCanonicalTarget first',
      { objectId: normalized.targetObjectId, packId: normalized.packId },
    )
  }

  // VALIDATE ALL, THEN WRITE. The pre-scan is the last read-only step: after it
  // returns, either the pack agrees with every live column or nothing happened.
  const { needsStamp, alreadyStamped } = await classifyExistingExtensionFields({
    provisioning: api,
    projectId: resolvedProjectId,
    pack: normalized,
  })

  const { createdFields, skippedFields } = await ensureExtensionFields({
    provisioning: api,
    projectId: resolvedProjectId,
    pack: normalized,
  })
  // Stamp only what the additive write itself confirmed as pre-existing. The
  // pre-scan and ensureMissingObjectFields agree by construction here; taking the
  // intersection means a column created by THIS run can never be re-patched with
  // a property it already carries, whichever of the two reads is stale.
  const skippedSet = new Set(skippedFields)
  const stampedExistingFields = await stampExistingExtensionFields({
    provisioning: api,
    projectId: resolvedProjectId,
    pack: normalized,
    fieldIds: needsStamp.filter((fieldId) => skippedSet.has(fieldId)),
  })
  const alreadyStampedFields = alreadyStamped.filter((fieldId) => skippedSet.has(fieldId))

  const syncedOptionFields = await syncPackOptionSets({
    provisioning: api,
    projectId: resolvedProjectId,
    pack: normalized,
  })
  const ensuredViews = await ensureRoleViews({
    provisioning: api,
    projectId: resolvedProjectId,
    sheetId: sheet.id,
    pack: normalized,
  })

  const log = logger && typeof logger.info === 'function' ? logger : console
  log.info(
    `[plugin-integration-core] customer pack install done. pack=${normalized.packId}`
      + ` v${normalized.packVersion} created=${createdFields.length} skipped=${skippedFields.length}`
      + ` stamped=${stampedExistingFields.length} alreadyStamped=${alreadyStampedFields.length}`
      + ` optionFields=${syncedOptionFields.length} views=${ensuredViews.length}`,
  )

  return {
    packId: normalized.packId,
    packVersion: normalized.packVersion,
    objectId: normalized.targetObjectId,
    createdFields,
    skippedFields,
    // Of the skipped (pre-existing) columns: the ones this run classified, and
    // the ones that were already classified the same way. A converged sheet
    // re-runs to created=0 / stamped=0.
    stampedExistingFields,
    alreadyStampedFields,
    syncedOptionFields,
    ensuredViews,
  }
}

module.exports = {
  EXTENSION_FIELD_ORDER_BASE,
  OWNERSHIP_PROPERTY_NAMESPACES,
  REQUIRED_PROVISIONING_METHODS,
  StockPreparationCustomerPackInstallError,
  installCustomerPack,
  __internals: {
    assertProvisioningApi,
    buildExtensionFieldProperty,
    buildExtensionFieldDescriptors,
    buildOptionPropertyPatch,
    buildOptionSyncInputs,
    buildOwnershipStampPatch,
    buildRoleViewDescriptor,
    classifyExistingField,
    resolveOptionSource,
  },
}
