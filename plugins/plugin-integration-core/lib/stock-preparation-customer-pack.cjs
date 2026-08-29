'use strict'

// P0 — per-customer stock-preparation CONFIG PACK contract.
//
// A "customer pack" is the declarative, per-tenant delta that turns the FROZEN
// canonical stock-preparation main table (stock-preparation-templates.cjs,
// `plm_stock_preparation_main`) into the sheet a specific factory actually
// works in — without editing the frozen template. It is the converging move
// away from hand-built customer sheets: what a deployer used to do by dragging
// columns in the UI becomes a reviewable object with a closed shape.
//
// A pack may only carry three ADDITIVE things:
//   extensionFields — extra `ext_` columns on the canonical main table
//   optionSets      — dictionary literals for select fields (pack or template)
//   roleViews       — role-banded views over the main table (column hiding only)
//
// plus ONE placement key:
//   targetObjectId  — OPTIONAL. Absent = the frozen canonical main table (the
//                     original and unchanged posture). Present = install into
//                     the `plm_stock_preparation_sandbox*` namespace instead,
//                     validated by the target-provisioning module's own
//                     assertSandboxObjectId. It is server config, not request
//                     input: see normalizePackTargetObjectId below for why that
//                     is structural rather than a convention.
//
// What a pack can NEVER do, by construction:
//   * touch the frozen template (no field may be redefined, removed, retyped —
//     an `ext_` id that would collide with a template id is rejected by
//     assertExtensionFieldIdValid, which this module calls for EVERY field)
//   * invent an ownership value — the vocabulary is reused from the template
//     module, never re-declared here
//   * carry inline `options` on a field descriptor (the frozen template bans
//     them at stock-preparation-templates.cjs; a pack must route every option
//     literal through `optionSets`, where the option-sync normalizer's caps and
//     executable-key rejection apply)
//   * smuggle rows / SQL / payloads — FORBIDDEN_CONTENT_KEYS is reused from the
//     template module and asserted on every object in the pack
//
// This module is PURE: it validates and normalizes, it performs no I/O. The
// installer (stock-preparation-customer-pack-installer.cjs) is the only thing
// that talks to the host provisioning API, and it refuses to run on anything
// this module has not normalized.
//
// Fail-closed everywhere: an unknown key anywhere in the pack is an error, not
// something silently dropped. A pack that "almost" validates must not install.

const {
  STOCK_PREPARATION_FIELD_TYPES,
  STOCK_PREPARATION_FIELD_OWNERSHIPS,
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  __internals: {
    assertNoContentKeys: assertNoTemplateContentKeys,
    isPlainObject,
    isSecretShaped,
  },
} = require('./stock-preparation-templates.cjs')

const { assertExtensionFieldIdValid } = require('./stock-preparation-extension-namespace.cjs')

// WHERE a pack's columns land. The sandbox-objectId rule is NOT re-implemented
// here — it is imported from the target-provisioning module, which is the same
// authority the sandbox ensure/inspect paths already use. A second copy of that
// regex is exactly how "a sandbox target" comes to mean two different things in
// two modules. Safe to require statically: target-provisioning's own imports are
// leaf-only (templates + extension-namespace) and it never reaches back here, so
// this adds no edge to the load-time cycle documented in
// stock-preparation-ext-field-mapping.cjs.
const { assertSandboxObjectId } = require('./stock-preparation-target-provisioning.cjs')

// The 1-200 cap, duplicate-value rejection, allowed-option-key whitelist and
// executable-key rejection all live in the C6 option-sync normalizer. Reused
// (never re-implemented) so a pack literal and a runtime option sync can never
// disagree about what a legal option set is.
const {
  MAX_OPTIONS_PER_FIELD,
  __internals: { normalizeOptionSet },
} = require('./stock-preparation-option-sync.cjs')

// Pack ids and role-view ids share one shape: lowercase ASCII with dashes,
// 2-32 chars. Deliberately narrower than a field id — these strings end up in
// evidence, in a view descriptor id and in a deploy folder name, so they must
// stay boring and diffable.
const PACK_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/
const ROLE_VIEW_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/

const PACK_KEYS = Object.freeze(['packId', 'packVersion', 'label', 'targetObjectId', 'extensionFields', 'optionSets', 'roleViews'])
const EXTENSION_FIELD_KEYS = Object.freeze(['id', 'label', 'type', 'ownership'])
const OPTION_SET_KEYS = Object.freeze(['fieldId', 'options'])
const ROLE_VIEW_KEYS = Object.freeze(['viewId', 'label', 'hideOwnerships', 'hideFieldIds'])

// Content-bearing keys that would turn a schema-only field descriptor into a
// values carrier. Same vocabulary the frozen template's normalizeField rejects
// (stock-preparation-templates.cjs) — a pack gets no weaker gate than the
// template it extends.
const INLINE_VALUE_KEYS = Object.freeze(['options', 'values', 'value', 'default', 'optionSource'])

// Closed reason vocabulary: every throw from this module carries exactly one of
// these on `.reason`, so a caller can branch on the failure without parsing
// free text.
const STOCK_PREPARATION_CUSTOMER_PACK_ERROR_REASONS = Object.freeze([
  'PACK_NOT_AN_OBJECT',
  'PACK_UNKNOWN_KEY',
  'PACK_ID_INVALID',
  'PACK_VERSION_INVALID',
  'PACK_LABEL_INVALID',
  'PACK_TARGET_OBJECT_ID_INVALID',
  'EXTENSION_FIELDS_INVALID',
  'EXTENSION_FIELD_UNKNOWN_KEY',
  'EXTENSION_FIELD_INLINE_OPTIONS',
  'EXTENSION_FIELD_ID_INVALID',
  'EXTENSION_FIELD_DUPLICATE',
  'EXTENSION_FIELD_LABEL_INVALID',
  'EXTENSION_FIELD_TYPE_INVALID',
  'EXTENSION_FIELD_OWNERSHIP_INVALID',
  'OPTION_SETS_INVALID',
  'OPTION_SET_UNKNOWN_KEY',
  'OPTION_SET_FIELD_UNKNOWN',
  'OPTION_SET_FIELD_NOT_SELECT',
  'OPTION_SET_DUPLICATE_FIELD',
  'OPTION_SET_OPTIONS_INVALID',
  'ROLE_VIEWS_INVALID',
  'ROLE_VIEW_UNKNOWN_KEY',
  'ROLE_VIEW_ID_INVALID',
  'ROLE_VIEW_DUPLICATE',
  'ROLE_VIEW_LABEL_INVALID',
  'ROLE_VIEW_OWNERSHIP_INVALID',
  'ROLE_VIEW_HIDE_FIELD_UNKNOWN',
])

// Module-private brand stamped on a normalized pack. It exists so
// `normalizeCustomerPack` can be re-applied to its own output (the installer
// normalizes whatever it is handed, and a caller may reasonably hold a
// normalized pack across two installs) WITHOUT loosening the fail-closed
// unknown-key gate to tolerate the derived keys normalization adds. The symbol
// is deliberately not exported: only this module can mint a normalized pack, so
// the brand cannot be forged to skip validation.
const NORMALIZED_PACK_BRAND = Symbol('stockPreparationCustomerPackNormalized')

function isNormalizedCustomerPack(value) {
  return Boolean(value && typeof value === 'object' && value[NORMALIZED_PACK_BRAND] === true)
}

function brandAndFreeze(pack) {
  // Non-enumerable: the brand must never reach JSON, evidence or a diff.
  Object.defineProperty(pack, NORMALIZED_PACK_BRAND, { value: true, enumerable: false })
  return Object.freeze(pack)
}

class StockPreparationCustomerPackError extends Error {
  constructor(message, reason, details = {}) {
    super(message)
    this.name = 'StockPreparationCustomerPackError'
    this.reason = reason
    this.details = details
  }
}

function fail(reason, message, details) {
  throw new StockPreparationCustomerPackError(message, reason, details || {})
}

const TYPE_SET = new Set(STOCK_PREPARATION_FIELD_TYPES)
const OWNERSHIP_SET = new Set(STOCK_PREPARATION_FIELD_OWNERSHIPS)

// The frozen canonical catalog this pack extends. Read once, never mutated —
// the pack module is additive AROUND the template, never into it.
const TEMPLATE_FIELDS = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields
const TEMPLATE_FIELD_IDS = Object.freeze(TEMPLATE_FIELDS.map((field) => field.id))

function assertOnlyKnownKeys(input, allowedKeys, reason, label) {
  for (const key of Object.keys(input)) {
    if (!allowedKeys.includes(key)) {
      fail(reason, `${label}.${key} is not a supported key`, { field: `${label}.${key}`, key })
    }
  }
}

// The template module's content-key gate, re-thrown in THIS module's closed
// reason vocabulary. Without the re-throw a pack carrying `rows`/`sql` would
// surface a StockPreparationTemplateError, and a caller branching on `.reason`
// would see nothing at all.
function assertNoContentKeys(input, label, reason) {
  try {
    assertNoTemplateContentKeys(input, label)
  } catch (error) {
    fail(reason, `${label} must not carry content-smuggling keys (schema only)`, {
      field: error && error.details ? error.details.field : label,
    })
  }
}

function safeLabel(value, reason, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(reason, `${label} must be a non-empty string`, { field: label })
  }
  const text = value.trim()
  if (isSecretShaped(text)) {
    fail(reason, `${label} must not be secret-shaped`, { field: label })
  }
  return text
}

/**
 * WHERE THIS PACK'S COLUMNS LAND.
 *
 * ABSENT — the frozen canonical main table. This is the posture every pack had
 * before the key existed and the one a canonical deployment keeps: omission is
 * how a pack asks for `plm_stock_preparation_main`, and nothing about that path
 * changes.
 *
 * PRESENT — the pack installs into the stock-preparation SANDBOX namespace
 * instead, and the value must satisfy `assertSandboxObjectId`: inside
 * `plm_stock_preparation_sandbox*`, and not the production canonical id. An
 * unlisted or malformed value is REFUSED with this module's own closed reason
 * (`PACK_TARGET_OBJECT_ID_INVALID`), never coerced and never defaulted back to
 * canonical — a pack that names a target it may not have must not quietly
 * install somewhere else.
 *
 * PRESENT-AND-CANONICAL IS ALSO REFUSED, deliberately. Omission is already how a
 * pack says "canonical"; spelling the canonical objectId out is not a second way
 * to say the same thing, it is the shape a redirection attempt takes, and
 * `assertSandboxObjectId` rejects it with `reason: 'prod_canonical'`. So the key,
 * when present, means exactly one thing: sandbox.
 *
 * WHY THIS IS STILL NEVER REQUEST-SUPPLIED — the property the old hardcode was
 * really protecting. A pack reaches the installer through ONE door: the
 * server-held catalog (stock-preparation-customer-pack-catalog.cjs), built from
 * the `stockPreparationCustomerPacks` config key, which
 * packages/core-backend/src/plugin-runtime-config.ts populates from a deploy-time
 * JSON file named by INTEGRATION_CORE_STOCK_PREPARATION_CUSTOMER_PACKS_PATH. The
 * install route takes a `packId` from the path and nothing else — its body
 * allowlist is the single key `mode` (VALID_CUSTOMER_PACK_INSTALL_BODY_KEYS in
 * http-routes.cjs), so a request can carry neither a pack nor a targetObjectId.
 * The set of installable targets is therefore exactly the set of targets the
 * server's own pack file declares, and it is closed to the network.
 *
 * The catalog normalizes EVERY configured pack at build time, so a deployment
 * that mis-declares a target fails at plugin activation with this reason
 * attached — not on a deployer's first install call, and never as a silent
 * install onto the wrong sheet.
 */
function normalizePackTargetObjectId(value) {
  if (value === undefined || value === null) {
    return STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId
  }
  try {
    return assertSandboxObjectId(value, 'pack.targetObjectId')
  } catch (error) {
    // Re-thrown in THIS module's closed vocabulary. Without it a pack naming a
    // bad target would surface a StockPreparationTargetProvisioningError and a
    // caller branching on `.reason` would see nothing at all — the same reason
    // `assertNoContentKeys` re-throws the template module's error above.
    fail('PACK_TARGET_OBJECT_ID_INVALID', 'pack.targetObjectId must be a stock-preparation sandbox target objectId', {
      field: 'pack.targetObjectId',
      provisioningReason: error && error.details && error.details.reason ? error.details.reason : 'UNKNOWN',
    })
  }
}

function normalizeExtensionField(input, index) {
  const label = `extensionFields[${index}]`
  if (!isPlainObject(input)) {
    fail('EXTENSION_FIELDS_INVALID', `${label} must be a plain object`, { field: label })
  }
  // Inline-value gate first, so the ban that matters most here (`options` on a
  // field descriptor) reports as EXTENSION_FIELD_INLINE_OPTIONS rather than
  // being swallowed by the broader content-key or unknown-key checks.
  for (const key of INLINE_VALUE_KEYS) {
    if (key in input) {
      fail(
        'EXTENSION_FIELD_INLINE_OPTIONS',
        `${label}.${key} is banned — a pack carries option literals only under optionSets`,
        { field: `${label}.${key}`, key },
      )
    }
  }
  assertNoContentKeys(input, label, 'EXTENSION_FIELDS_INVALID')
  assertOnlyKnownKeys(input, EXTENSION_FIELD_KEYS, 'EXTENSION_FIELD_UNKNOWN_KEY', label)

  // The ONE authority on extension-field ids. Note the frozen catalog is passed
  // explicitly (the namespace module fails closed on a missing/empty catalog),
  // so a template collision — `ext_notes` against the template's `notes` — is
  // rejected here, not discovered in production.
  try {
    assertExtensionFieldIdValid(input.id, { templateFieldIds: TEMPLATE_FIELD_IDS })
  } catch (error) {
    fail('EXTENSION_FIELD_ID_INVALID', `${label}.id is not a valid tenant extension field id`, {
      field: `${label}.id`,
      namespaceReason: error && error.reason ? error.reason : 'UNKNOWN',
    })
  }

  const type = safeLabel(input.type, 'EXTENSION_FIELD_TYPE_INVALID', `${label}.type`)
  if (!TYPE_SET.has(type)) {
    fail('EXTENSION_FIELD_TYPE_INVALID', `${label}.type must be one of ${STOCK_PREPARATION_FIELD_TYPES.join(', ')}`, {
      field: `${label}.type`,
      value: type,
    })
  }
  const ownership = safeLabel(input.ownership, 'EXTENSION_FIELD_OWNERSHIP_INVALID', `${label}.ownership`)
  if (!OWNERSHIP_SET.has(ownership)) {
    fail(
      'EXTENSION_FIELD_OWNERSHIP_INVALID',
      `${label}.ownership must be one of ${STOCK_PREPARATION_FIELD_OWNERSHIPS.join(', ')}`,
      { field: `${label}.ownership`, value: ownership },
    )
  }

  return Object.freeze({
    id: input.id,
    label: safeLabel(input.label, 'EXTENSION_FIELD_LABEL_INVALID', `${label}.label`),
    type,
    ownership,
    // Derived, never authored — same rule the frozen template applies: a
    // human-owned column survives a PLM refresh, a system-owned one does not.
    preserveOnRefresh: ownership === 'human_preserved',
  })
}

function normalizeExtensionFields(input) {
  if (!Array.isArray(input)) {
    fail('EXTENSION_FIELDS_INVALID', 'extensionFields must be an array', { field: 'extensionFields' })
  }
  const fields = input.map(normalizeExtensionField)
  const seen = new Set()
  for (const field of fields) {
    if (seen.has(field.id)) {
      fail('EXTENSION_FIELD_DUPLICATE', 'extensionFields ids must be unique', { field: 'extensionFields' })
    }
    seen.add(field.id)
  }
  return Object.freeze(fields)
}

// Field catalog a pack is allowed to reference: the frozen template's fields
// plus the pack's own extension fields. `source` keeps the two apart so the
// installer never has to guess which half of the sheet a field belongs to.
function buildFieldCatalog(extensionFields) {
  const catalog = new Map()
  for (const field of TEMPLATE_FIELDS) {
    catalog.set(field.id, { id: field.id, type: field.type, ownership: field.ownership, source: 'template' })
  }
  for (const field of extensionFields) {
    catalog.set(field.id, { id: field.id, type: field.type, ownership: field.ownership, source: 'pack' })
  }
  return catalog
}

function normalizeOptionSets(input, catalog) {
  if (input === undefined || input === null) return Object.freeze([])
  if (!Array.isArray(input)) {
    fail('OPTION_SETS_INVALID', 'optionSets must be an array', { field: 'optionSets' })
  }
  const seen = new Set()
  const out = input.map((raw, index) => {
    const label = `optionSets[${index}]`
    if (!isPlainObject(raw)) {
      fail('OPTION_SETS_INVALID', `${label} must be a plain object`, { field: label })
    }
    assertOnlyKnownKeys(raw, OPTION_SET_KEYS, 'OPTION_SET_UNKNOWN_KEY', label)
    const fieldId = safeLabel(raw.fieldId, 'OPTION_SET_FIELD_UNKNOWN', `${label}.fieldId`)
    const target = catalog.get(fieldId)
    if (!target) {
      fail('OPTION_SET_FIELD_UNKNOWN', `${label}.fieldId is neither a template field nor a pack extension field`, {
        field: `${label}.fieldId`,
        fieldId,
      })
    }
    if (target.type !== 'select') {
      fail('OPTION_SET_FIELD_NOT_SELECT', `${label}.fieldId must reference a select field`, {
        field: `${label}.fieldId`,
        fieldId,
        type: target.type,
      })
    }
    if (seen.has(fieldId)) {
      fail('OPTION_SET_DUPLICATE_FIELD', 'optionSets must not carry two sets for the same field', {
        field: `${label}.fieldId`,
        fieldId,
      })
    }
    seen.add(fieldId)

    // The 1-200 cap, duplicate-value rejection, allowed-key whitelist and
    // executable-key rejection are the option-sync normalizer's, not ours.
    let normalized
    try {
      normalized = normalizeOptionSet(raw.options, fieldId)
    } catch (error) {
      fail('OPTION_SET_OPTIONS_INVALID', `${label}.options is not a valid option set`, {
        field: `${label}.options`,
        fieldId,
        optionSyncCode: error && error.code ? error.code : 'OPTION_SYNC_CONFIG_INVALID',
        maxOptions: MAX_OPTIONS_PER_FIELD,
      })
    }
    return Object.freeze({
      fieldId,
      fieldSource: target.source,
      options: Object.freeze(normalized.options.map((option) => Object.freeze({ ...option }))),
      actionBindings: Object.freeze(normalized.actionBindings.map((binding) => Object.freeze({ ...binding }))),
    })
  })
  return Object.freeze(out)
}

// Resolve a role view's hidden columns: every field whose ownership is banded
// out, plus the explicitly named ones. Catalog order (template fields first, in
// template order, then pack fields in pack order) makes the result stable and
// diffable across runs — an installer re-run must produce a byte-identical
// hiddenFieldIds array or "idempotent" would be a claim rather than a fact.
function resolveHiddenFieldIds({ catalog, hideOwnerships, hideFieldIds }) {
  const banded = new Set(hideOwnerships)
  const explicit = new Set(hideFieldIds)
  const hidden = []
  for (const entry of catalog.values()) {
    if (banded.has(entry.ownership) || explicit.has(entry.id)) hidden.push(entry.id)
  }
  return hidden
}

function normalizeRoleViews(input, catalog) {
  if (input === undefined || input === null) return Object.freeze([])
  if (!Array.isArray(input)) {
    fail('ROLE_VIEWS_INVALID', 'roleViews must be an array', { field: 'roleViews' })
  }
  const seen = new Set()
  const out = input.map((raw, index) => {
    const label = `roleViews[${index}]`
    if (!isPlainObject(raw)) {
      fail('ROLE_VIEWS_INVALID', `${label} must be a plain object`, { field: label })
    }
    assertNoContentKeys(raw, label, 'ROLE_VIEWS_INVALID')
    assertOnlyKnownKeys(raw, ROLE_VIEW_KEYS, 'ROLE_VIEW_UNKNOWN_KEY', label)

    const viewId = safeLabel(raw.viewId, 'ROLE_VIEW_ID_INVALID', `${label}.viewId`)
    if (!ROLE_VIEW_ID_PATTERN.test(viewId)) {
      fail('ROLE_VIEW_ID_INVALID', `${label}.viewId must match ${ROLE_VIEW_ID_PATTERN}`, {
        field: `${label}.viewId`,
        viewId,
      })
    }
    if (seen.has(viewId)) {
      fail('ROLE_VIEW_DUPLICATE', 'roleViews ids must be unique', { field: `${label}.viewId`, viewId })
    }
    seen.add(viewId)

    const hideOwnerships = raw.hideOwnerships === undefined || raw.hideOwnerships === null ? [] : raw.hideOwnerships
    if (!Array.isArray(hideOwnerships)) {
      fail('ROLE_VIEW_OWNERSHIP_INVALID', `${label}.hideOwnerships must be an array`, {
        field: `${label}.hideOwnerships`,
      })
    }
    for (const ownership of hideOwnerships) {
      if (!OWNERSHIP_SET.has(ownership)) {
        fail(
          'ROLE_VIEW_OWNERSHIP_INVALID',
          `${label}.hideOwnerships must only contain ${STOCK_PREPARATION_FIELD_OWNERSHIPS.join(', ')}`,
          { field: `${label}.hideOwnerships`, value: String(ownership) },
        )
      }
    }

    const hideFieldIds = raw.hideFieldIds === undefined || raw.hideFieldIds === null ? [] : raw.hideFieldIds
    if (!Array.isArray(hideFieldIds)) {
      fail('ROLE_VIEW_HIDE_FIELD_UNKNOWN', `${label}.hideFieldIds must be an array`, {
        field: `${label}.hideFieldIds`,
      })
    }
    for (const fieldId of hideFieldIds) {
      if (typeof fieldId !== 'string' || !catalog.has(fieldId)) {
        fail(
          'ROLE_VIEW_HIDE_FIELD_UNKNOWN',
          `${label}.hideFieldIds names a field that is neither a template field nor a pack extension field`,
          { field: `${label}.hideFieldIds`, fieldId: String(fieldId) },
        )
      }
    }

    return Object.freeze({
      viewId,
      label: safeLabel(raw.label, 'ROLE_VIEW_LABEL_INVALID', `${label}.label`),
      hideOwnerships: Object.freeze([...hideOwnerships]),
      hideFieldIds: Object.freeze([...hideFieldIds]),
      // Derived here so the installer never re-derives it (and so the mapping
      // is testable without any provisioning API in hand).
      hiddenFieldIds: Object.freeze(resolveHiddenFieldIds({ catalog, hideOwnerships, hideFieldIds })),
    })
  })
  return Object.freeze(out)
}

/**
 * Validate + normalize a customer pack. Throws StockPreparationCustomerPackError
 * with a closed `.reason` on any violation; on success returns a deeply frozen
 * pack. Pure — no I/O, no host API, no clock.
 */
function normalizeCustomerPack(input) {
  if (isNormalizedCustomerPack(input)) return input
  if (!isPlainObject(input)) {
    fail('PACK_NOT_AN_OBJECT', 'customer pack must be a plain object', {})
  }
  assertNoContentKeys(input, 'pack', 'PACK_UNKNOWN_KEY')
  assertOnlyKnownKeys(input, PACK_KEYS, 'PACK_UNKNOWN_KEY', 'pack')

  const packId = safeLabel(input.packId, 'PACK_ID_INVALID', 'pack.packId')
  if (!PACK_ID_PATTERN.test(packId)) {
    fail('PACK_ID_INVALID', `pack.packId must match ${PACK_ID_PATTERN}`, { field: 'pack.packId', packId })
  }
  if (!Number.isInteger(input.packVersion) || input.packVersion < 1) {
    fail('PACK_VERSION_INVALID', 'pack.packVersion must be a positive integer', { field: 'pack.packVersion' })
  }

  const extensionFields = normalizeExtensionFields(input.extensionFields)
  const catalog = buildFieldCatalog(extensionFields)

  return brandAndFreeze({
    packId,
    packVersion: input.packVersion,
    label: input.label === undefined || input.label === null
      ? packId
      : safeLabel(input.label, 'PACK_LABEL_INVALID', 'pack.label'),
    targetObjectId: normalizePackTargetObjectId(input.targetObjectId),
    extensionFields,
    optionSets: normalizeOptionSets(input.optionSets, catalog),
    roleViews: normalizeRoleViews(input.roleViews, catalog),
  })
}

/**
 * Values-free evidence projection: counts and schema ids only, never option
 * values or labels (those are customer dictionary data).
 */
function summarizeCustomerPackForEvidence(pack) {
  const normalized = normalizeCustomerPack(pack)
  return {
    packId: normalized.packId,
    packVersion: normalized.packVersion,
    targetObjectId: normalized.targetObjectId,
    extensionFields: normalized.extensionFields.map((field) => ({
      id: field.id,
      type: field.type,
      ownership: field.ownership,
      preserveOnRefresh: field.preserveOnRefresh,
    })),
    optionSets: normalized.optionSets.map((set) => ({
      fieldId: set.fieldId,
      fieldSource: set.fieldSource,
      optionCount: set.options.length,
      actionBindingCount: set.actionBindings.length,
    })),
    roleViews: normalized.roleViews.map((view) => ({
      viewId: view.viewId,
      hideOwnerships: [...view.hideOwnerships],
      hiddenFieldCount: view.hiddenFieldIds.length,
    })),
  }
}

module.exports = {
  PACK_ID_PATTERN,
  ROLE_VIEW_ID_PATTERN,
  STOCK_PREPARATION_CUSTOMER_PACK_ERROR_REASONS,
  StockPreparationCustomerPackError,
  isNormalizedCustomerPack,
  normalizeCustomerPack,
  summarizeCustomerPackForEvidence,
  __internals: {
    PACK_KEYS,
    EXTENSION_FIELD_KEYS,
    OPTION_SET_KEYS,
    ROLE_VIEW_KEYS,
    INLINE_VALUE_KEYS,
    TEMPLATE_FIELD_IDS,
    buildFieldCatalog,
    resolveHiddenFieldIds,
    normalizeExtensionFields,
    normalizePackTargetObjectId,
  },
}
