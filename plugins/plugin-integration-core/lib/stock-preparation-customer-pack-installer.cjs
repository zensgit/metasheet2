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
 * The READ-ONLY half of the pre-scan (rule 4): read the live property of every pack column that
 * already exists and sort the pack's ids into the four buckets. It NEVER throws on a conflict — it
 * reports one — which is what lets the dry-run below reuse the exact classification the install
 * runs without duplicating it. The only throw is the unverifiable-read refusal, which is not a
 * verdict about the sheet but a refusal to guess at one.
 *
 * `missing` are the ids no live column carries: those will be CREATED with a full ownership
 * property and need no stamp.
 */
async function scanExistingExtensionFields({ provisioning, projectId, pack }) {
  if (pack.extensionFields.length === 0) {
    return { needsStamp: [], alreadyStamped: [], missing: [], conflicts: [] }
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
  const missing = []
  const conflicts = []
  const byLogicalId = isPlainObject(content) ? content : {}
  for (const field of pack.extensionFields) {
    const existing = byLogicalId[field.id]
    // Absent from the content map == the column does not exist yet. It will be
    // created with a full ownership property, so it needs no stamp.
    if (!existing) {
      missing.push(field.id)
      continue
    }
    const verdict = classifyExistingField(field, existing.property)
    if (verdict.state === 'CONFLICT') conflicts.push(...verdict.conflicts)
    else if (verdict.state === 'ALREADY_STAMPED') alreadyStamped.push(field.id)
    else needsStamp.push(field.id)
  }

  return { needsStamp, alreadyStamped, missing, conflicts }
}

/**
 * VALIDATE-ALL-THEN-WRITE pre-scan (rule 4). Runs before the first mutation of
 * the install and reads the live property of every pack column that already
 * exists. Returns the two work lists; throws on the first conflicting set, so a
 * pack that disagrees with the live sheet never lands half of itself.
 */
async function classifyExistingExtensionFields({ provisioning, projectId, pack }) {
  const scan = await scanExistingExtensionFields({ provisioning, projectId, pack })
  if (scan.conflicts.length) {
    throw new StockPreparationCustomerPackInstallError(
      409,
      'CUSTOMER_PACK_OWNERSHIP_CONFLICT',
      'customer pack ownership disagrees with the live classification of an existing column; '
        + 'no field was created or patched',
      {
        objectId: pack.targetObjectId,
        packId: pack.packId,
        conflictingFields: [...new Set(scan.conflicts.map((entry) => entry.field))],
        conflicts: scan.conflicts,
      },
    )
  }
  return { needsStamp: scan.needsStamp, alreadyStamped: scan.alreadyStamped }
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
 * THE HOST PORT'S CLOSED FAILURE VOCABULARY, mapped onto this installer's coded errors.
 *
 * `StockPreparationFieldPermissionsService` (packages/core-backend) throws a typed
 * `StockPreparationFieldPermissionsError` whose `.reason` is one of exactly four members. This
 * plugin is CommonJS and cannot import that TypeScript class, so it recognises the error
 * STRUCTURALLY (`name` + a string `reason`) -- which is the only honest way across the port
 * boundary, and is asserted by the department-fields suite with a hand-built error of that shape.
 *
 * WHY THIS MAPPING EXISTS AT ALL: without it the port's rejection escapes `installCustomerPack`
 * as a foreign error, and every caller above (the HTTP route included) turns it into an UNCODED
 * 500. "The role you named does not exist on this host" is a 4xx a deployer can act on, not a
 * server fault. An unrecognised error is deliberately NOT swallowed into this vocabulary -- it
 * propagates unchanged, so the mapping can never become a catch-all that hides a real bug.
 */
const FIELD_PERMISSION_ERROR_NAME = 'StockPreparationFieldPermissionsError'
const FIELD_PERMISSION_FAILURE_MAP = Object.freeze({
  ROLE_NOT_FOUND: Object.freeze({ status: 422, code: 'CUSTOMER_PACK_FIELD_PERMISSION_ROLE_UNKNOWN' }),
  FIELD_NOT_ON_SHEET: Object.freeze({ status: 422, code: 'CUSTOMER_PACK_FIELD_PERMISSION_FIELD_UNKNOWN' }),
  SHEET_NOT_FOUND: Object.freeze({ status: 409, code: 'CUSTOMER_PACK_FIELD_PERMISSION_SHEET_UNKNOWN' }),
  ENTRIES_INVALID: Object.freeze({ status: 422, code: 'CUSTOMER_PACK_FIELD_PERMISSION_ENTRIES_INVALID' }),
})

function isFieldPermissionsError(error) {
  return Boolean(error)
    && error.name === FIELD_PERMISSION_ERROR_NAME
    && typeof error.reason === 'string'
}

// Rethrow a port rejection as a coded install error. `offending` carries ids only (the port's own
// contract), so the details stay values-free.
function translateFieldPermissionsError(error, pack) {
  const mapped = FIELD_PERMISSION_FAILURE_MAP[error.reason]
  const offending = Array.isArray(error.offending) ? [...error.offending] : []
  return new StockPreparationCustomerPackInstallError(
    mapped ? mapped.status : 500,
    mapped ? mapped.code : 'CUSTOMER_PACK_FIELD_PERMISSION_FAILED',
    'the host field-permission port refused this pack\'s declared write scoping',
    {
      objectId: pack.targetObjectId,
      packId: pack.packId,
      reason: error.reason,
      // The role branch names its ids under a role-shaped key so a caller does not have to know
      // which member of the vocabulary produced them.
      ...(error.reason === 'ROLE_NOT_FOUND' ? { roleIds: offending } : { offending }),
    },
  )
}

/**
 * LOGICAL -> PHYSICAL, once. `field_permissions.field_id` references `meta_fields.id`, so every
 * derived denial must be mapped through the host's own pure `getFieldId` rather than by string
 * building. Both projections come out of here so the plan a dry-run PRINTS and the entries an
 * install WRITES cannot drift: `entries` is exactly the port's `{fieldId, roleId}` shape (nothing
 * else may reach it), while `rows` keeps the logical id alongside for human-readable reporting.
 */
function deriveFieldWriteScopePlan({ provisioning, projectId, pack }) {
  const rows = pack.fieldWriteDenials.map((denial) => ({
    fieldId: provisioning.getFieldId(projectId, pack.targetObjectId, denial.fieldId),
    logicalFieldId: denial.fieldId,
    roleId: denial.roleId,
  }))
  // THE GOVERNED REGION — the (columns × roles) rectangle this pack re-declares IN FULL, and the
  // bound on the port's reconcile delete. Deliberately built from `ownsFieldIds`, NOT from the
  // denial rows: a column every declared role owns (shared custody) produces no denial yet is very
  // much governed, and it is exactly the column a revision moves INTO shared custody — its older,
  // single-owner denial has to be removable or the move silently locks it for everyone.
  //
  // Roles are the pack's declared roles only, columns the ones its policies actually claim. A
  // column no policy names, or a role this pack does not declare, is outside the rectangle and the
  // port cannot touch it.
  //
  // THE RECTANGLE ALONE DOES NOT SEPARATE TWO PACKS. Two packs installed on the same canonical
  // sheet can declare OVERLAPPING rectangles — `targetObjectId` defaults to that one table and the
  // physical ids are a pure function of (project, object, logical id), so the overlap is the normal
  // case, not a contrived one. What keeps them apart is the per-PACK provenance marker the port
  // stamps, plus the pre-write conflict refusal below; the rectangle bounds the delete, it does not
  // attribute the rows inside it.
  const regionFieldIds = []
  const seenFields = new Set()
  for (const policy of pack.fieldWritePolicies) {
    for (const logicalFieldId of policy.ownsFieldIds) {
      const fieldId = provisioning.getFieldId(projectId, pack.targetObjectId, logicalFieldId)
      if (seenFields.has(fieldId)) continue
      seenFields.add(fieldId)
      regionFieldIds.push(fieldId)
    }
  }
  const regionRoleIds = [...new Set(pack.fieldWritePolicies.map((policy) => policy.roleId))]
  return {
    rows,
    entries: rows.map(({ fieldId, roleId }) => ({ fieldId, roleId })),
    declaredKeys: new Set(rows.map((row) => `${row.fieldId} ${row.roleId}`)),
    // NULL exactly when the pack declares no fieldWritePolicies at all — the pack validator forces
    // every declared policy to carry a NON-EMPTY ownsFieldIds and a roleId, so a declared policy
    // always yields both axes. `region !== null` is therefore the same question as "does this pack
    // govern anything", and it — never the DERIVED denial count — is what decides whether a
    // reconcile is requested and whether the census runs.
    region: regionRoleIds.length === 0
      ? null
      : { fieldIds: regionFieldIds, roleIds: regionRoleIds },
    // "is this existing row inside the rectangle" — what separates a stale row the install HEALS
    // from one only an operator can clear. BOTH axes matter: a row on a column no policy names is
    // as far out of reach as a row for a role this pack does not declare.
    inRegion: (fieldId, roleId) => seenFields.has(fieldId) && regionRoleIds.includes(roleId),
  }
}

// Physical -> logical for EVERY column this pack could possibly have scoped (frozen template band
// + the pack's own extension band), so a stale row left by an older revision can still be reported
// in the vocabulary a deployer reads the pack in. A row whose column is in neither band reports a
// null logical id rather than a guess.
function buildLogicalFieldIdIndex({ provisioning, projectId, pack }) {
  const index = new Map()
  const record = (fieldId) => {
    index.set(provisioning.getFieldId(projectId, pack.targetObjectId, fieldId), fieldId)
  }
  for (const field of STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields) record(field.id)
  for (const field of pack.extensionFields) record(field.id)
  return index
}

/**
 * THE STALE-SCOPE CENSUS — what is standing on this sheet that the CURRENT declaration does not
 * want, and which half of it can this install actually fix.
 *
 * Since the scoped reconcile landed there are two kinds of orphan and a deployer acts on them
 * differently, so this function classifies rather than merely lists:
 *
 *   INSIDE the pack's governed rectangle, carrying THIS PACK's provenance (or the pack-less legacy
 *   marker): the install RETIRES it itself, in the same transaction as the upserts. Without that,
 *   a revision that MOVES a column's owner leaves v1's denial standing beside v2's and the write
 *   gate ORs `read_only`, so the column becomes unwritable by every declared role.
 *
 *   Everything else — a column no policy names, a role this pack does not declare, another PACK's
 *   row, or a row an OPERATOR authored — the install cannot touch, by construction. Those it only
 *   REPORTS (`operatorMustClearWriteScopes`), because nothing in the current declaration
 *   establishes that they are wrong.
 *
 * FAIL-VISIBLE, NOT FAIL-CLOSED, for orphans. Refusing over a row only an operator can clear would
 * deadlock the deployment, so the honest posture is to report. (A cross-PACK CONFLICT is the one
 * exception and is refused instead — see `detectPackWriteScopeConflicts`: there the right answer is
 * a human decision, not a delete and not a shrug.) `null` vs `[]` is load-bearing throughout: a
 * host whose port has no census method reports `null` and `writeScopeCheck: 'unsupported_port'`,
 * never an empty list that would read as "checked, nothing stale".
 *
 * OPERATOR-HELD ROWS ARE REPORTED, NOT CLAIMED. `foreignEntries` (rows this plugin did not write)
 * are folded into the report when they sit inside the rectangle, so "a human holds this
 * (column, role)" is visible — but they are never counted as this plugin's debris and the port's
 * DELETE cannot see them at all.
 */
async function detectStaleWriteScopes({ fieldPermissions, sheetId, plan, logicalFieldIds, packId }) {
  if (!fieldPermissions || typeof fieldPermissions.listRoleWriteScopes !== 'function') {
    return { check: 'unsupported_port', stale: null }
  }
  const existing = await fieldPermissions.listRoleWriteScopes({ sheetId })
  const entries = (existing && Array.isArray(existing.entries)) ? existing.entries : []
  const foreign = (existing && Array.isArray(existing.foreignEntries)) ? existing.foreignEntries : []
  const inRegion = (fieldId, roleId) => (typeof plan.inRegion === 'function'
    ? plan.inRegion(fieldId, roleId)
    : false)
  // A row is RETIRABLE by this install only if it is in the rectangle AND this pack may own it.
  // `packId === null` is a legacy, pack-less row: no other pack can claim it, so whichever pack
  // governs it adopts it — the same rule the port's DELETE applies, stated once on each side.
  const ownedByThisPack = (entry) => entry.packId === undefined
    || entry.packId === null
    || entry.packId === packId
  const stale = entries
    .filter((entry) => entry && !plan.declaredKeys.has(`${entry.fieldId} ${entry.roleId}`))
    .map((entry) => ({
      fieldId: entry.fieldId,
      logicalFieldId: logicalFieldIds.get(entry.fieldId) || null,
      roleId: entry.roleId,
      // Which pack wrote it. `null` = a legacy row from before the marker carried a pack id.
      packId: entry.packId === undefined ? null : entry.packId,
      // THE ACTIONABLE HALF: true only when the install will really retire this row.
      inReconcileRegion: inRegion(entry.fieldId, entry.roleId) && ownedByThisPack(entry),
    }))
  // Rows a human owns inside the rectangle. Named so a deployer sees them; never `inReconcileRegion`.
  for (const entry of foreign) {
    if (!entry || !inRegion(entry.fieldId, entry.roleId)) continue
    if (plan.declaredKeys.has(`${entry.fieldId} ${entry.roleId}`)) continue
    stale.push({
      fieldId: entry.fieldId,
      logicalFieldId: logicalFieldIds.get(entry.fieldId) || null,
      roleId: entry.roleId,
      packId: null,
      inReconcileRegion: false,
      // The one thing that distinguishes it: it is not this plugin's row at all.
      heldBy: typeof entry.createdBy === 'string' ? entry.createdBy : null,
    })
  }
  stale.sort((left, right) => (left.fieldId === right.fieldId
    ? left.roleId.localeCompare(right.roleId)
    : left.fieldId.localeCompare(right.fieldId)))
  return { check: 'checked', stale }
}

/**
 * THE CROSS-PACK CONFLICT — the one write-scope condition that is REFUSED rather than reported.
 *
 * `targetObjectId` defaults to the single canonical main table and the physical field id is a pure
 * function of (project, object, logical id), so two customer packs installed in one project land on
 * the SAME sheet with the SAME ids. If both claim authority over the same (column, role) pair, one
 * of them is wrong — and the answer is a human deciding which, not this install deleting the other
 * pack's enforced denial and reporting it as its own history.
 *
 * Refused BEFORE the first schema write, with a coded 422 naming the other pack and every pair, so
 * a deployer gets an actionable message over an untouched sheet.
 */
async function detectPackWriteScopeConflicts({ fieldPermissions, sheetId, plan, packId }) {
  if (!plan.region) return { check: 'not_declared', conflicts: null }
  if (!fieldPermissions || typeof fieldPermissions.listRoleWriteScopes !== 'function') {
    return { check: 'unsupported_port', conflicts: null }
  }
  const existing = await fieldPermissions.listRoleWriteScopes({ sheetId })
  const entries = (existing && Array.isArray(existing.entries)) ? existing.entries : []
  const conflicts = entries
    .filter((entry) => entry
      && typeof entry.packId === 'string'
      && entry.packId !== packId
      && typeof plan.inRegion === 'function'
      && plan.inRegion(entry.fieldId, entry.roleId))
    .map((entry) => ({ fieldId: entry.fieldId, roleId: entry.roleId, packId: entry.packId }))
  conflicts.sort((left, right) => (left.fieldId === right.fieldId
    ? left.roleId.localeCompare(right.roleId)
    : left.fieldId.localeCompare(right.fieldId)))
  return { check: 'checked', conflicts }
}

/**
 * ROLE PRE-FLIGHT -- asked BEFORE the first schema write, which is the entire point.
 *
 * The pack's own validation can only check that a `roleId` is well SHAPED; whether the role EXISTS
 * is knowledge only the host has. Without this pre-flight the refusal arrives from the port at the
 * very END of the install, after every column has been created and stamped -- so a typo'd role id
 * leaves a half-applied sheet behind AND surfaces as an uncoded 500.
 *
 * FOUR independent conditions are checked here rather than at the port call:
 *   1. the port must be present at all when a policy is declared (fail-closed, 503);
 *   2. the host port must be able to HONOUR a reconcile region when one will be sent — a host that
 *      silently ignores it would leave the previous revision's denials in force while the install
 *      reported success, so this is a coded 501 rather than a quiet downgrade (fail-closed);
 *   3. no ANOTHER pack's row may sit inside this pack's governed rectangle (coded 422); and
 *   4. every declared role must exist (fail-closed, coded 422).
 * A host whose port predates `findMissingRoleIds` skips (4) only -- the late mapping in
 * applyFieldWritePolicies still turns its rejection into the same coded 422.
 *
 * GATED ON THE DECLARATION, NEVER ON ITS DERIVED COMPLEMENT. `fieldWriteDenials` is the set of
 * (column, role) pairs that follow from the declaration, and a perfectly ordinary revision — every
 * declared role owning every governed column — derives NONE while still governing a full rectangle.
 * Keying any of this on the denial count made the whole write-scope half of the install vanish for
 * exactly the revision it exists to serve.
 */
async function preflightFieldWritePolicies({ fieldPermissions, pack, sheetId, plan }) {
  const resolved = plan || null
  const governs = resolved ? Boolean(resolved.region) : pack.fieldWritePolicies.length > 0
  if (!governs) return { roleCheck: 'not_declared', packConflictCheck: 'not_declared' }
  assertFieldPermissionsPort({ fieldPermissions, pack })
  assertFieldPermissionsReconcileSupport({ fieldPermissions, pack })

  let packConflictCheck = 'not_declared'
  if (resolved && sheetId) {
    const conflictCensus = await detectPackWriteScopeConflicts({
      fieldPermissions, sheetId, plan: resolved, packId: pack.packId,
    })
    packConflictCheck = conflictCensus.check
    if (conflictCensus.conflicts && conflictCensus.conflicts.length > 0) {
      const others = [...new Set(conflictCensus.conflicts.map((row) => row.packId))].sort()
      throw new StockPreparationCustomerPackInstallError(
        422,
        'CUSTOMER_PACK_FIELD_WRITE_SCOPE_PACK_CONFLICT',
        'another customer pack already governs (column, role) pairs inside this pack\'s declared '
          + 'write-scope region on this sheet. Two packs claiming the same authority is a conflict '
          + 'a human must resolve — this install will neither delete the other pack\'s enforced '
          + 'denials nor silently coexist with them. Refused before any column is created.',
        {
          objectId: pack.targetObjectId,
          packId: pack.packId,
          conflictingPackIds: others,
          conflicts: conflictCensus.conflicts,
        },
      )
    }
  }

  if (typeof fieldPermissions.findMissingRoleIds !== 'function') {
    return { roleCheck: 'unsupported_port', packConflictCheck }
  }
  const roleIds = [...new Set(pack.fieldWritePolicies.map((policy) => policy.roleId))]
  const result = await fieldPermissions.findMissingRoleIds({ roleIds })
  const missing = (result && Array.isArray(result.missing)) ? [...result.missing].sort() : []
  if (missing.length > 0) {
    throw new StockPreparationCustomerPackInstallError(
      422,
      'CUSTOMER_PACK_FIELD_PERMISSION_ROLE_UNKNOWN',
      'this pack declares fieldWritePolicies for a role that does not exist on this host; '
        + 'refusing before any column is created, so the sheet is untouched',
      { objectId: pack.targetObjectId, packId: pack.packId, roleIds: missing },
    )
  }
  return { roleCheck: 'checked', packConflictCheck }
}

// The port-presence gate, shared by the pre-flight and the apply so the two cannot drift on the
// one condition that must never degrade into "call it and hope".
function assertFieldPermissionsPort({ fieldPermissions, pack }) {
  if (!fieldPermissions || typeof fieldPermissions.applyRoleWriteScopes !== 'function') {
    throw new StockPreparationCustomerPackInstallError(
      503,
      'CUSTOMER_PACK_FIELD_PERMISSIONS_UNAVAILABLE',
      'this pack declares fieldWritePolicies, but the host did not inject the '
        + 'stockPreparationFieldPermissions capability; refusing to report an install as complete '
        + 'while the declared column write scoping would not be enforced',
      { objectId: pack.targetObjectId, packId: pack.packId, declaredDenials: pack.fieldWriteDenials.length },
    )
  }
}

// The RECONCILE-SUPPORT gate. A host port that predates the region argument accepts the call and
// ignores it, so the only difference between "reconciled" and "silently did nothing" is a
// capability the port declares about itself. Without it a revision that MOVES a column's owner
// leaves the old denial in force while the install reports success — the exact silent breakage this
// whole mechanism exists to end — so it is refused, not degraded. Coded 501 (the HOST lacks the
// capability) rather than 422 (the request is wrong), and raised in the pre-flight so the sheet is
// untouched.
function assertFieldPermissionsReconcileSupport({ fieldPermissions, pack }) {
  if (fieldPermissions && fieldPermissions.supportsWriteScopeReconcile === true) return
  throw new StockPreparationCustomerPackInstallError(
    501,
    'CUSTOMER_PACK_FIELD_PERMISSION_RECONCILE_UNSUPPORTED',
    'this pack declares fieldWritePolicies, but the host\'s stockPreparationFieldPermissions port '
      + 'does not declare supportsWriteScopeReconcile. Installing against it would leave an earlier '
      + 'revision\'s denials in force while reporting success, so the install is refused before any '
      + 'column is created rather than downgraded silently.',
    { objectId: pack.targetObjectId, packId: pack.packId },
  )
}

/**
 * APPLY THE PACK'S FIELD WRITE POLICIES to the PLATFORM's own per-column permission
 * model. This is the step that makes the declaration real rather than decorative.
 *
 * IT USES THE PLATFORM MODEL; IT DOES NOT FORK ONE. The rows land in the host's
 * `field_permissions` table, which is what `loadFieldPermissionScopeMap` reads and what
 * `isFieldWriteForbidden` enforces server-side on the record-write routes. Note there is
 * a DIFFERENT, parallel table (`plugin_field_policy_registry`, written by
 * PluginRbacProvisioningService's `fieldPolicies`) that the multitable grid never reads —
 * writing there would look like a permission and enforce nothing, which is precisely the
 * trap this avoids.
 *
 * WRITE ONLY, READ SHARED. The port takes no visibility argument at all: it marks a
 * column read-only for a role and can never hide it. That is deliberate and structural —
 * purchasing and warehouse must keep SEEING the production band they work from.
 *
 * OPTIONAL CAPABILITY, and ABSENT DECLARATION CHANGES NOTHING. Two independent
 * conditions must both hold before a single row is written: the pack must declare
 * `fieldWritePolicies`, and the host must have injected the narrow
 * `stockPreparationFieldPermissions` port. A pack with no declaration returns
 * immediately, so behaviour is byte-for-byte today's. A declaration with NO host port is
 * a FAIL-CLOSED error rather than a silent skip: a deployer who asked for enforcement
 * must never be told the install succeeded while the columns stayed writable by everyone.
 *
 * RECONCILED WITHIN THIS PACK'S OWN REGION, ADDITIVE EVERYWHERE ELSE. The call carries the
 * `region` derived above — the (columns × roles) rectangle this pack re-declares in
 * full — and the port drops its OWN stale denials inside it in the SAME transaction as
 * the upserts. That is the fix for the revision that MOVES a column's owner: without it
 * v1's denial survives beside v2's and the write gate ORs them, so the column ends up
 * unwritable by every declared role while the install reports `applied=N`.
 *
 * What it still cannot do is exactly what it must not: rows an OPERATOR authored, rows an
 * operator relaxed, and rows outside the rectangle (another pack's columns or roles) are
 * unreachable by the statement. Those the install only REPORTS, via the census below.
 *
 * A host port that predates the region argument simply ignores it and returns no
 * `removed` array; that is detected (`reconcile: 'unsupported_port'`) rather than
 * assumed, so an older host degrades to the previous report-only behaviour visibly.
 */
async function applyFieldWritePolicies({ provisioning, fieldPermissions, projectId, sheetId, pack, plan }) {
  const resolvedPlan = plan || deriveFieldWriteScopePlan({ provisioning, projectId, pack })
  // GATED ON THE RECTANGLE, NOT ON THE DERIVED DENIAL COUNT. `region` is null exactly when the pack
  // declares no fieldWritePolicies at all; a pack that declares them but derives zero denials (every
  // declared role owns every governed column) still governs a rectangle, and skipping it there left
  // the previous revision's denials locking those columns for every role the new one names.
  if (!resolvedPlan.region) {
    return { applied: 0, roleCount: 0, skipped: 'not_declared', removed: null, reconcile: 'not_declared' }
  }
  assertFieldPermissionsPort({ fieldPermissions, pack })
  assertFieldPermissionsReconcileSupport({ fieldPermissions, pack })
  // The plan is derived ONCE per install (deriveFieldWriteScopePlan) and passed in, so the rows a
  // dry-run previewed, the rows the stale census diffs against, and the rows written here are the
  // same array. The fallback keeps this helper independently callable (it is exported on
  // __internals and exercised directly).
  const resolved = resolvedPlan
  let result
  try {
    result = await fieldPermissions.applyRoleWriteScopes({
      sheetId,
      entries: resolved.entries,
      // THE PACK IDENTITY, stamped into `created_by`. It is what makes "this pack's own rows" a
      // property of the data rather than of the plugin, and it is the DELETE's owner predicate.
      packId: pack.packId,
      reconcile: resolved.region,
    })
  } catch (error) {
    // A rejection from the port's closed failure vocabulary becomes a coded install error; any
    // OTHER error propagates unchanged, so this can never become a catch-all.
    if (isFieldPermissionsError(error)) throw translateFieldPermissionsError(error, pack)
    throw error
  }
  // `removed` ABSENT and `removed` EMPTY are different answers and are kept different: a port that
  // returned no array never looked, so it reports null + 'unsupported_port', never [] (which reads
  // as "looked, found nothing to retire"). The pre-flight refuses such a host outright, so this arm
  // is reachable only through a direct call to this function with a hand-built port — which is
  // exactly how the unit witness reaches it.
  const removedRaw = result && result.removed
  const reconciled = Array.isArray(removedRaw)
  return {
    applied: Number(result && result.applied) || 0,
    roleCount: new Set(pack.fieldWritePolicies.map((policy) => policy.roleId)).size,
    skipped: null,
    removed: reconciled
      ? removedRaw.map((entry) => ({ fieldId: entry.fieldId, roleId: entry.roleId }))
      : null,
    reconcile: reconciled ? 'reconciled' : 'unsupported_port',
  }
}

// The canonical target PRECONDITION, shared by the dry-run and the install so the two cannot drift
// on the one thing a deployer trips over first. The rehearsal report (F5) flags this as the reason a
// CLI/route needs a two-step flow, so the error names the ensure path rather than the raw absence.
async function requireCanonicalTargetSheet({ provisioning, projectId, pack }) {
  const sheet = await provisioning.findObjectSheet({ projectId, objectId: pack.targetObjectId })
  if (!sheet || !sheet.id) {
    throw new StockPreparationCustomerPackInstallError(
      409,
      'CUSTOMER_PACK_TARGET_ABSENT',
      'customer pack install requires an already-provisioned canonical stock-preparation target; '
        + 'run ensureStockPreparationCanonicalTarget first',
      { objectId: pack.targetObjectId, packId: pack.packId },
    )
  }
  return sheet
}

// F5 (rehearsal report): the install summary buckets ids by the ACTION TAKEN — created / stamped /
// alreadyStamped — while every consumer that matters (the ledger, a CLI, a route response) needs the
// OWNERSHIP BAND per id. The two are different axes and only the pack knows the second, so the join
// happens once, here, instead of in each caller re-normalizing the pack.
//
// The id set is deliberately createdFields ∪ stampedExistingFields ∪ alreadyStampedFields: every one
// of those is a column this install has confirmed present AND classified. `skippedFields` is NOT the
// same set — it also contains columns that exist but whose classification this run did not touch.
function buildInstalledFieldEntries(pack, { createdFields, stampedExistingFields, alreadyStampedFields }) {
  const byId = new Map(pack.extensionFields.map((field) => [field.id, field]))
  const actionById = new Map()
  for (const fieldId of createdFields || []) actionById.set(fieldId, 'created')
  for (const fieldId of stampedExistingFields || []) actionById.set(fieldId, 'stamped')
  for (const fieldId of alreadyStampedFields || []) actionById.set(fieldId, 'already_stamped')

  const entries = []
  for (const [fieldId, action] of actionById) {
    const field = byId.get(fieldId)
    // An id the pack does not declare cannot have an ownership band, and guessing one is exactly the
    // silent re-classification rule 4 forbids. Dropping it keeps the ledger honest.
    if (!field) continue
    entries.push({
      fieldId,
      ownership: field.ownership,
      preserveOnRefresh: field.preserveOnRefresh,
      extension: true,
      action,
    })
  }
  entries.sort((left, right) => left.fieldId.localeCompare(right.fieldId))
  return entries
}

// The ledger's own shape: the four specified keys, no `action`. `action` is install-run evidence
// (it answers "what did THIS run do"), while the ledger answers "what is on the sheet and who owns
// it" — a question whose answer must not change because the same install ran twice.
function toLedgerFieldEntries(entries) {
  return entries.map(({ fieldId, ownership, preserveOnRefresh, extension }) => ({
    fieldId,
    ownership,
    preserveOnRefresh,
    extension,
  }))
}

/**
 * DRY RUN — the read-only rehearsal of installCustomerPack (rehearsal report F5: "there is no
 * dry-run").
 *
 * It reuses the install's OWN pre-scan and classification rather than re-deriving them, so what it
 * reports is what the install will do, not a parallel model of it. Zero writes by construction: the
 * only host calls it makes are findObjectSheet, readObjectFieldsContent and the pure getFieldId
 * derivation. It requires the FULL provisioning surface anyway, so "the dry-run passed" also means
 * the install is not going to fail on a missing primitive.
 *
 * Unlike the install it does NOT throw on an ownership conflict — it reports the conflicting ids and
 * says canInstall:false. Reviewing the conflict is the entire point of a dry-run.
 *
 * Values-free: logical schema ids, frozen ownership tokens, counts. `conflicts` carries only the
 * already-sanitized describeDeclared* projections.
 */
async function planCustomerPackInstall({ provisioning, projectId, pack, fieldPermissions } = {}) {
  const api = assertProvisioningApi(provisioning)
  const resolvedProjectId = requiredProjectId(projectId)
  const normalized = normalizeCustomerPack(pack)

  const targetSheet = await requireCanonicalTargetSheet({
    provisioning: api,
    projectId: resolvedProjectId,
    pack: normalized,
  })

  // THE WRITE-SCOPE PREVIEW (F2/F3 of the adversarial review). Before this, a dry-run said nothing
  // at all about the permission rows an install would write, so the one step with no undo was also
  // the one step with no rehearsal. Everything below is READ-ONLY by construction: a pure
  // getFieldId derivation plus, at most, the port's two census reads.
  const writeScopePlan = deriveFieldWriteScopePlan({
    provisioning: api,
    projectId: resolvedProjectId,
    pack: normalized,
  })
  const portPresent = Boolean(fieldPermissions)
    && typeof fieldPermissions.applyRoleWriteScopes === 'function'
  const portReconciles = Boolean(fieldPermissions)
    && fieldPermissions.supportsWriteScopeReconcile === true
  let writeScopeCheck = 'not_declared'
  let staleWriteScopes = null
  let unknownRoleIds = null
  let packConflictWriteScopes = null
  // GATED ON THE RECTANGLE, not on the derived denial count — the same condition the install uses,
  // so a revision that governs columns but derives no denial is rehearsed instead of skipped.
  if (writeScopePlan.region) {
    if (!portPresent) {
      // Unlike the install this does NOT throw — reporting the blocker is the point of a dry-run.
      writeScopeCheck = 'port_absent'
    } else if (!portReconciles) {
      // The host accepts the call and ignores the region. Saying nothing here would let the
      // rehearsal promise removals that cannot happen; the install refuses such a host outright.
      writeScopeCheck = 'host_port_no_reconcile'
    } else {
      const conflictCensus = await detectPackWriteScopeConflicts({
        fieldPermissions,
        sheetId: targetSheet.id,
        plan: writeScopePlan,
        packId: normalized.packId,
      })
      packConflictWriteScopes = conflictCensus.conflicts
      const census = await detectStaleWriteScopes({
        fieldPermissions,
        sheetId: targetSheet.id,
        plan: writeScopePlan,
        packId: normalized.packId,
        logicalFieldIds: buildLogicalFieldIdIndex({
          provisioning: api,
          projectId: resolvedProjectId,
          pack: normalized,
        }),
      })
      // A cross-pack conflict is what the install REFUSES, so it is the headline the dry-run
      // reports — ahead of the census, which describes a sheet that install will never reach.
      writeScopeCheck = (packConflictWriteScopes && packConflictWriteScopes.length > 0)
        ? 'pack_conflict'
        : census.check
      staleWriteScopes = census.stale
      if (typeof fieldPermissions.findMissingRoleIds === 'function') {
        const roleIds = [...new Set(normalized.fieldWritePolicies.map((policy) => policy.roleId))]
        const missing = await fieldPermissions.findMissingRoleIds({ roleIds })
        unknownRoleIds = (missing && Array.isArray(missing.missing)) ? [...missing.missing].sort() : []
      }
    }
  }

  // THE SPLIT A DEPLOYER ACTS ON, derived ONCE. The install RETIRES the in-region orphans itself
  // (the port's scoped reconcile); the rest it can never touch. Computing this here rather than
  // twice inside the report is what keeps the lists and their counts from ever disagreeing.
  //
  // A host that cannot honour the region promises NOTHING: `willRemoveWriteScopes` is null there,
  // never a list, because a rehearsal that says "1 row will be retired" against a port that will
  // retire none is worse than saying nothing at all.
  const willRemoveWriteScopes = (staleWriteScopes && portReconciles)
    ? staleWriteScopes.filter((row) => row.inReconcileRegion)
    : null
  const operatorMustClearWriteScopes = staleWriteScopes
    ? staleWriteScopes.filter((row) => !row.inReconcileRegion)
    : null

  const scan = await scanExistingExtensionFields({
    provisioning: api,
    projectId: resolvedProjectId,
    pack: normalized,
  })

  const conflictingFieldIds = [...new Set(scan.conflicts.map((entry) => entry.field))].sort()
  const conflicting = new Set(conflictingFieldIds)
  const byId = new Map(normalized.extensionFields.map((field) => [field.id, field]))
  const describe = (fieldId, action) => {
    const field = byId.get(fieldId)
    return {
      fieldId,
      ownership: field ? field.ownership : null,
      preserveOnRefresh: field ? field.preserveOnRefresh : null,
      extension: true,
      action,
    }
  }
  const fields = [
    ...scan.missing.map((fieldId) => describe(fieldId, 'create')),
    ...scan.needsStamp.map((fieldId) => describe(fieldId, 'stamp')),
    ...scan.alreadyStamped.map((fieldId) => describe(fieldId, 'already_stamped')),
    ...conflictingFieldIds.map((fieldId) => describe(fieldId, 'conflict')),
  ].sort((left, right) => left.fieldId.localeCompare(right.fieldId))

  return {
    mode: 'dry_run',
    packId: normalized.packId,
    packVersion: normalized.packVersion,
    objectId: normalized.targetObjectId,
    targetPresent: true,
    // A declared policy whose port is missing, or which names a role this host does not have, is
    // as blocking as an ownership conflict — the install would refuse, so the dry-run says no.
    canInstall: conflicting.size === 0
      && writeScopeCheck !== 'port_absent'
      && writeScopeCheck !== 'host_port_no_reconcile'
      && writeScopeCheck !== 'pack_conflict'
      && (unknownRoleIds === null || unknownRoleIds.length === 0),
    willCreateFieldIds: [...scan.missing].sort(),
    willStampFieldIds: [...scan.needsStamp].sort(),
    alreadyStampedFieldIds: [...scan.alreadyStamped].sort(),
    conflictingFieldIds,
    conflicts: scan.conflicts.map((entry) => ({ ...entry })),
    fields,
    // The role views a real install would ensure, reported with the LOGICAL hidden ids the pack
    // derived (buildRoleViewDescriptor maps these to physical ids at write time; a dry-run report
    // reads better and travels better in the pack's own vocabulary).
    roleViews: normalized.roleViews.map((roleView) => ({
      roleViewId: roleView.viewId,
      descriptorId: `sp-${normalized.packId}-${roleView.viewId}`,
      hideOwnerships: [...roleView.hideOwnerships],
      hiddenFieldIds: [...roleView.hiddenFieldIds].sort(),
      hiddenFieldCount: roleView.hiddenFieldIds.length,
    })),
    // THE DERIVED DENIAL PLAN — exactly the rows installCustomerPack will upsert, named by both the
    // logical id the pack declares and the PHYSICAL id the platform table stores.
    fieldWriteDenials: writeScopePlan.rows.map((row) => ({ ...row })),
    fieldWritePolicyRoles: normalized.fieldWritePolicies.map((policy) => ({
      roleId: policy.roleId,
      ownsFieldCount: policy.ownsFieldIds.length,
    })),
    // Whether the host handed this plugin the capability at all. `false` with a non-empty
    // fieldWriteDenials is the fail-closed case the install refuses with a 503.
    fieldPermissionsPortAvailable: portPresent,
    // 'not_declared' | 'port_absent' | 'unsupported_port' | 'checked'. NULL (not []) whenever the
    // census did not actually run — absence of a check is not absence of stale rows.
    //
    // `staleWriteScopes` is EVERY orphan the census found; each row carries `inReconcileRegion`.
    // The two projections below split that list along the only line a deployer acts on: the install
    // RETIRES the in-region rows itself (the port's scoped reconcile), and can never touch the rest.
    // Before the reconcile existed the whole list was the second kind, so a dry-run that did not
    // make the distinction would now overstate the operator's to-do list by exactly the rows the
    // install is about to fix.
    writeScopeCheck,
    staleWriteScopes,
    // THE RECTANGLE ITSELF, not just its consequences. A deployer reading `willRemoveWriteScopes`
    // is being told which rows a DELETE will reach; the only way to check that claim without
    // re-deriving the pack is to see the BOUND the delete is issued under. This is verbatim the
    // `reconcile` argument installCustomerPack will pass to the port (physical ids, as the platform
    // table stores them). NULL — never an empty rectangle — when the pack governs nothing, which is
    // also exactly when the install requests no delete at all.
    writeScopeRegion: writeScopePlan.region
      ? {
        fieldIds: [...writeScopePlan.region.fieldIds].sort(),
        roleIds: [...writeScopePlan.region.roleIds].sort(),
      }
      : null,
    willRemoveWriteScopes,
    operatorMustClearWriteScopes,
    // Whether the host port declares that it HONOURS a reconcile region. `false` with a governed
    // rectangle is a refusal at install time, not a downgrade — so it belongs in the rehearsal.
    fieldPermissionsReconcileSupported: portReconciles,
    // (column, role) pairs inside this pack's rectangle that ANOTHER pack already governs. NULL
    // when the question could not be asked; a non-empty list is what the install refuses over.
    packConflictWriteScopes,
    // Declared roles this host does not have. NULL when the question could not be asked.
    unknownRoleIds,
    counts: {
      extensionFields: normalized.extensionFields.length,
      willCreate: scan.missing.length,
      willStamp: scan.needsStamp.length,
      alreadyStamped: scan.alreadyStamped.length,
      conflicting: conflicting.size,
      optionSets: normalized.optionSets.length,
      roleViews: normalized.roleViews.length,
      fieldWriteDenials: writeScopePlan.rows.length,
      // The rectangle's two dimensions, so "how wide is the delete allowed to be" is a number a
      // deployer can read off the report without walking the id lists.
      writeScopeRegionFields: writeScopePlan.region ? writeScopePlan.region.fieldIds.length : 0,
      writeScopeRegionRoles: writeScopePlan.region ? writeScopePlan.region.roleIds.length : 0,
      staleWriteScopes: staleWriteScopes ? staleWriteScopes.length : 0,
      willRemoveWriteScopes: willRemoveWriteScopes ? willRemoveWriteScopes.length : 0,
      operatorMustClearWriteScopes: operatorMustClearWriteScopes ? operatorMustClearWriteScopes.length : 0,
      packConflictWriteScopes: packConflictWriteScopes ? packConflictWriteScopes.length : 0,
    },
  }
}

/**
 * Install a customer config pack onto the canonical stock-preparation main
 * table. Additive only, idempotent: a second run adds no column, drops no
 * column, and never calls ensureObject.
 *
 *   provisioning     — scoped host multitable provisioning API
 *   projectId        — already-resolved tenant project id
 *   pack             — raw or normalized pack (normalized here either way)
 *   logger           — optional; only values-free counts are ever logged
 *   packInstallStore — OPTIONAL install ledger (stock-preparation-pack-install-store.cjs). Absent →
 *                      byte-identical to the pre-ledger behaviour: nothing is persisted and nothing
 *                      throws, so every existing caller and test keeps working unchanged.
 *   tenantId /
 *   workspaceId      — ledger scope; required ONLY when a store is supplied (a ledger row that
 *                      cannot be scoped to a tenant is not a row worth writing).
 *   mode             — 'install' (default) | 'reinstall'; recorded as last-attempted-mode audit.
 *
 * Returns a values-free summary: schema ids and counts, never option values.
 */
async function installCustomerPack({
  provisioning,
  projectId,
  pack,
  logger,
  packInstallStore,
  tenantId,
  workspaceId,
  mode,
  // The narrow host port that writes the platform's own `field_permissions`. OPTIONAL:
  // a pack that declares no fieldWritePolicies never touches it, which is why an older
  // host (or any caller that does not pass it) installs exactly as it does today.
  fieldPermissions,
} = {}) {
  const api = assertProvisioningApi(provisioning)
  const resolvedProjectId = requiredProjectId(projectId)
  const normalized = normalizeCustomerPack(pack)

  // PRECONDITION, not a creation path: the canonical table must already exist.
  const sheet = await requireCanonicalTargetSheet({
    provisioning: api,
    projectId: resolvedProjectId,
    pack: normalized,
  })

  // THE PLAN IS DERIVED ONCE, HERE, so the pre-flight, the write and the census all reason about
  // the same rectangle. (It is a pure `getFieldId` derivation — no host call, no write.)
  const writeScopePlan = deriveFieldWriteScopePlan({
    provisioning: api,
    projectId: resolvedProjectId,
    pack: normalized,
  })

  // PRE-FLIGHT, BEFORE THE FIRST SCHEMA WRITE. Every condition a declared fieldWritePolicies needs
  // from the host — the port exists, it honours a reconcile region, no OTHER pack already governs
  // pairs inside this rectangle, and every role it names exists — is answered here rather than at
  // the end of the install. A pack naming a role this host does not have used to create and stamp
  // every column first and only THEN be refused, as an uncoded 500 over a half-applied sheet.
  await preflightFieldWritePolicies({
    fieldPermissions,
    pack: normalized,
    sheetId: sheet.id,
    plan: writeScopePlan,
  })

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
  // LAST, and deliberately so: the columns must exist and be classified before any
  // permission can name one. A pack with no fieldWritePolicies makes no call at all.
  const appliedWriteScopes = await applyFieldWritePolicies({
    provisioning: api,
    fieldPermissions,
    projectId: resolvedProjectId,
    sheetId: sheet.id,
    pack: normalized,
    plan: writeScopePlan,
  })
  // THE STALE CENSUS — read AFTER the write on purpose, and since the reconcile landed that
  // ordering is LOAD-BEARING rather than merely tidier. The call above both upserts and (inside the
  // pack's governed rectangle) deletes, so a census read BEFORE it would list orphans the install
  // has since retired and hand a deployer a to-do list of work already done. Read last, this
  // reports the sheet as it now stands: only the orphans OUTSIDE the rectangle, which are exactly
  // the ones no install can clear.
  const writeScopeCensus = !writeScopePlan.region
    ? { check: 'not_declared', stale: null }
    : await detectStaleWriteScopes({
      fieldPermissions,
      sheetId: sheet.id,
      plan: writeScopePlan,
      packId: normalized.packId,
      logicalFieldIds: buildLogicalFieldIdIndex({
        provisioning: api,
        projectId: resolvedProjectId,
        pack: normalized,
      }),
    })

  const log = logger && typeof logger.info === 'function' ? logger : console
  log.info(
    `[plugin-integration-core] customer pack install done. pack=${normalized.packId}`
      + ` v${normalized.packVersion} created=${createdFields.length} skipped=${skippedFields.length}`
      + ` stamped=${stampedExistingFields.length} alreadyStamped=${alreadyStampedFields.length}`
      + ` optionFields=${syncedOptionFields.length} views=${ensuredViews.length}`
      + ` writeScopes=${appliedWriteScopes.applied}`
      + ` removedWriteScopes=${appliedWriteScopes.removed ? appliedWriteScopes.removed.length : 'unreconciled'}`
      + ` staleWriteScopes=${writeScopeCensus.stale ? writeScopeCensus.stale.length : 'unchecked'}`,
  )
  // A RETIRED denial is not an error, but it is a permission that just stopped applying, so it is
  // named at INFO rather than folded into a count nobody reads.
  if (appliedWriteScopes.removed && appliedWriteScopes.removed.length > 0) {
    log.info(
      `[plugin-integration-core] customer pack install RETIRED ${appliedWriteScopes.removed.length}`
        + ` write scope(s) this pack no longer declares. pack=${normalized.packId}`
        + ` v${normalized.packVersion} — each was written by THIS plugin, inside the (column, role)`
        + ' region the pack re-declares in full; operator-authored rows are never touched.',
    )
  }
  // What the reconcile could NOT reach is the part a deployer must not have to go looking for: an
  // orphan outside this pack's governed rectangle (an older, wider revision, or another pack) is
  // still denying a column, and only an operator can clear it.
  if (writeScopeCensus.stale && writeScopeCensus.stale.length > 0) {
    const warn = logger && typeof logger.warn === 'function' ? logger.warn.bind(logger) : log.info
    // WHY each row survived, in the row's own terms. Lumping them together under "outside the
    // region" was false for a row held by an operator or by another pack INSIDE the region, and it
    // is the sentence a deployer acts on, so it is derived rather than asserted.
    const outsideRegion = writeScopeCensus.stale.filter((row) => !row.inReconcileRegion && !row.heldBy)
    const humanHeld = writeScopeCensus.stale.filter((row) => row.heldBy)
    warn(
      `[plugin-integration-core] customer pack install left ${writeScopeCensus.stale.length} STALE`
        + ` write scope(s) behind. pack=${normalized.packId} v${normalized.packVersion}`
        + ` — ${outsideRegion.length} on (column, role) pairs OUTSIDE the region this pack governs`
        + ` and ${humanHeld.length} authored by somebody other than this plugin; the install may`
        + ' retire neither. Clear them with'
        + ' PUT /api/multitable/sheets/:sheetId/field-permissions { remove: true }.',
    )
  }

  // F5: the summary now carries the ownership band per id, so a CLI or a route no longer has to
  // re-normalize the pack to say "13 PLM / 8 human columns". Values-free — ids, frozen ownership
  // tokens, booleans and an action enum.
  const installedFields = buildInstalledFieldEntries(normalized, {
    createdFields,
    stampedExistingFields,
    alreadyStampedFields,
  })

  const summary = {
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
    installedFields,
    syncedOptionFields,
    ensuredViews,
    // Counts and role ids only — no option values, no rows. `appliedWriteScopes: 0` with
    // `skipped: 'not_declared'` is the shape EVERY pack that exists today reports, and it
    // is how a reader tells "nothing was declared" from "declared and applied".
    appliedWriteScopes: appliedWriteScopes.applied,
    writeScopeRoleCount: appliedWriteScopes.roleCount,
    writeScopeSkipped: appliedWriteScopes.skipped,
    // The denials this install RETIRED, in the port's own {fieldId, roleId} shape. NULL — never []
    // — when no reconcile happened at all ('not_declared', or a host port too old to accept the
    // region), because an empty list reads as "reconciled, nothing to retire".
    removedWriteScopes: appliedWriteScopes.removed,
    removedWriteScopeCount: appliedWriteScopes.removed ? appliedWriteScopes.removed.length : 0,
    // 'not_declared' | 'unsupported_port' | 'reconciled'.
    writeScopeReconcile: appliedWriteScopes.reconcile,
    // 'not_declared' | 'unsupported_port' | 'checked'. `staleWriteScopes` is NULL — never [] —
    // whenever the census did not run, because an empty list reads as "checked, nothing stale".
    // After a successful reconcile this holds only the orphans OUTSIDE the governed region.
    writeScopeCheck: writeScopeCensus.check,
    staleWriteScopes: writeScopeCensus.stale,
    staleWriteScopeCount: writeScopeCensus.stale ? writeScopeCensus.stale.length : 0,
  }

  // TERMINAL-ONLY LEDGER WRITE — the LAST thing the install does, after every host mutation has
  // succeeded. That ordering is the whole invariant: there is never a 'pending' row, and a crash
  // anywhere above leaves NO row, so "no row" means "nothing landed" and a retry is safe (the
  // install itself is additive and idempotent, so the retry is a no-op on a converged sheet).
  const ledger = await recordPackInstall({
    packInstallStore,
    tenantId,
    workspaceId,
    projectId: resolvedProjectId,
    pack: normalized,
    mode,
    installedFields,
    summary,
  })
  if (ledger) summary.ledger = ledger

  return summary
}

// The optional ledger persistence. Absent store → returns null and the caller's behaviour is
// unchanged; a store that is present but unusable is an error, not a silent skip, because a caller
// that asked for a ledger and got none would go on to plan refreshes against frozen-template bands
// while believing the pack was enumerable.
async function recordPackInstall({
  packInstallStore,
  tenantId,
  workspaceId,
  projectId,
  pack,
  mode,
  installedFields,
  summary,
}) {
  if (!packInstallStore) return null
  if (typeof packInstallStore.recordInstall !== 'function') {
    throw new StockPreparationCustomerPackInstallError(
      503,
      'CUSTOMER_PACK_LEDGER_UNAVAILABLE',
      'customer pack install ledger is missing recordInstall',
      { packId: pack.packId },
    )
  }
  try {
    const row = await packInstallStore.recordInstall({
      tenantId,
      workspaceId,
      projectId,
      objectId: pack.targetObjectId,
      packId: pack.packId,
      packVersion: pack.packVersion,
      mode: mode === 'reinstall' ? 'reinstall' : 'install',
      installedFields: toLedgerFieldEntries(installedFields),
      // Counts only — the store's own guard (assertValuesFreeSummary) accepts FINITE NUMBERS and
      // nothing else, so this stays arithmetic and the four permission numbers are FLAT rather than
      // a nested `writeScopes` object, which that guard would reject outright.
      //
      // Before these four, the ledger could say how many COLUMNS an install landed but nothing at
      // all about its permission half — the one half with a delete in it. `writeScopesApplied` +
      // `writeScopesRemoved` + `writeScopeStale` make the whole write-scope outcome enumerable from
      // the ledger row alone, without re-deriving the pack. `writeScopeRoles` is the denominator
      // that makes the other three readable (2 roles × N columns is a different fact from 5 × N).
      summary: {
        created: summary.createdFields.length,
        skipped: summary.skippedFields.length,
        stamped: summary.stampedExistingFields.length,
        alreadyStamped: summary.alreadyStampedFields.length,
        optionFields: summary.syncedOptionFields.length,
        views: summary.ensuredViews.length,
        writeScopesApplied: summary.appliedWriteScopes,
        writeScopesRemoved: summary.removedWriteScopeCount,
        writeScopeStale: summary.staleWriteScopeCount,
        writeScopeRoles: summary.writeScopeRoleCount,
      },
      // The installer throws rather than warns (validate-all-then-write), so a successful install
      // has no warnings and the store derives status='installed'. The empty array is passed
      // explicitly so the derivation is visible at the call site rather than implied by omission.
      warnings: [],
    })
    return {
      status: row.status,
      mode: row.mode,
      packId: row.packId,
      packVersion: row.packVersion,
      objectId: row.objectId,
      fieldCount: Array.isArray(row.installedFields) ? row.installedFields.length : 0,
    }
  } catch (error) {
    throw new StockPreparationCustomerPackInstallError(
      500,
      'CUSTOMER_PACK_LEDGER_WRITE_FAILED',
      'customer pack install completed but the install ledger write failed; '
        + 'the pack columns are on the sheet and a re-install is safe and idempotent',
      {
        objectId: pack.targetObjectId,
        packId: pack.packId,
        errorCode: (error && (error.code || error.name)) || 'LEDGER_WRITE_FAILED',
      },
    )
  }
}

module.exports = {
  EXTENSION_FIELD_ORDER_BASE,
  OWNERSHIP_PROPERTY_NAMESPACES,
  REQUIRED_PROVISIONING_METHODS,
  StockPreparationCustomerPackInstallError,
  installCustomerPack,
  planCustomerPackInstall,
  __internals: {
    applyFieldWritePolicies,
    assertProvisioningApi,
    buildLogicalFieldIdIndex,
    deriveFieldWriteScopePlan,
    detectStaleWriteScopes,
    isFieldPermissionsError,
    preflightFieldWritePolicies,
    translateFieldPermissionsError,
    buildExtensionFieldProperty,
    buildExtensionFieldDescriptors,
    buildInstalledFieldEntries,
    buildOptionPropertyPatch,
    buildOptionSyncInputs,
    buildOwnershipStampPatch,
    buildRoleViewDescriptor,
    classifyExistingField,
    resolveOptionSource,
    scanExistingExtensionFields,
    toLedgerFieldEntries,
  },
}
