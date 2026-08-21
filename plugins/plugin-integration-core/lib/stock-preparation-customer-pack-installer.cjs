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
// Option-set writes route through the SHARED field-option-sync kernel
// (field-option-sync-runtime.cjs), the single place option metadata is patched,
// so a pack dictionary and a runtime option sync hit the host identically.
//
// Values-free: the returned summary and every log line carry schema ids and
// counts only — never an option value, a label or a row.

const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
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
const REQUIRED_PROVISIONING_METHODS = Object.freeze([
  'findObjectSheet',
  'getFieldId',
  'ensureMissingObjectFields',
  'patchObjectFieldProperty',
  'ensureView',
])

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

  const { createdFields, skippedFields } = await ensureExtensionFields({
    provisioning: api,
    projectId: resolvedProjectId,
    pack: normalized,
  })
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
      + ` optionFields=${syncedOptionFields.length} views=${ensuredViews.length}`,
  )

  return {
    packId: normalized.packId,
    packVersion: normalized.packVersion,
    objectId: normalized.targetObjectId,
    createdFields,
    skippedFields,
    syncedOptionFields,
    ensuredViews,
  }
}

module.exports = {
  EXTENSION_FIELD_ORDER_BASE,
  REQUIRED_PROVISIONING_METHODS,
  StockPreparationCustomerPackInstallError,
  installCustomerPack,
  __internals: {
    assertProvisioningApi,
    buildExtensionFieldProperty,
    buildExtensionFieldDescriptors,
    buildOptionPropertyPatch,
    buildOptionSyncInputs,
    buildRoleViewDescriptor,
    resolveOptionSource,
  },
}
