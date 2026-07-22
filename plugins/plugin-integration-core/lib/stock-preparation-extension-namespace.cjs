'use strict'

// P1b — tenant extension-field NAMESPACE discipline (general-prep-system
// feasibility doc rev-2, §"层1 — 冻结治理核心": 审阅 P1-2). This is NEW
// governance, not a guard fix: the review confirmed the drift check
// (stock-preparation-target-provisioning.cjs:214-215, `missingLogicalFields`)
// is already ONE-WAY (it only reports template fields missing from the
// resolved map; it never inspects/rejects extra tenant fields), and that
// `stock-preparation-conflict-planner.cjs` only ever `pickFields(plmFields)`
// off the frozen template — so template-unknown tenant fields are already
// refresh-safe by construction. What does NOT exist yet is a naming
// convention that keeps a tenant's chosen extension-field id from someday
// colliding with a NEW frozen template field added under the same bare name.
// This module is that convention, standalone and hermetic (no DB, no
// network, no sheet I/O) — it only classifies and validates field-id
// strings.
//
// It depends on stock-preparation-templates.cjs for exactly one thing: the
// FORBIDDEN_CONTENT_KEYS vocabulary, reused (not duplicated) so the two
// modules can never drift apart on what counts as a content-smuggling key
// name. The frozen template field-id catalog itself is NOT imported here —
// callers must supply it explicitly via `templateFieldIds`, which keeps this
// module agnostic to which template (main table vs. any MVP satellite table)
// is in scope for a given collision check, and makes the catalog dependency
// visible and fail-closed at every call site instead of implicit.

// FORBIDDEN_CONTENT_KEYS is not on the templates module's top-level export
// surface, only on its `__internals` (test-facing) surface — that is the
// real, single-source vocabulary this module reuses.
const { __internals: { FORBIDDEN_CONTENT_KEYS: TEMPLATE_FORBIDDEN_CONTENT_KEYS } } = require('./stock-preparation-templates.cjs')

// Reserved prefix for every tenant/implementer-defined extension field id.
// Frozen template field ids (stock-preparation-templates.cjs) never use this
// prefix; enforcing that both directions (this module) is what keeps the two
// namespaces disjoint by construction.
const TENANT_EXTENSION_FIELD_ID_PREFIX = 'ext_'

// Closed reason vocabulary. Every throw from this module carries exactly one
// of these on `.reason` — never a free-text-only failure.
const STOCK_PREPARATION_EXTENSION_NAMESPACE_ERROR_REASONS = Object.freeze([
  'FIELD_ID_NOT_A_STRING',
  'FIELD_ID_PREFIX_MISSING',
  'FIELD_ID_SUFFIX_EMPTY',
  'FIELD_ID_SUFFIX_INVALID_CHARACTERS',
  'FIELD_ID_FORBIDDEN_CONTENT_KEY',
  'FIELD_ID_TEMPLATE_COLLISION',
  'TEMPLATE_FIELD_IDS_INVALID',
])

// Suffix (the part after the reserved prefix) must be ASCII camelCase
// starting with a lowercase letter, bounded to a sane length. This mirrors
// the shape of every existing frozen field id (e.g. `componentSourceId`,
// `lastPlmRefreshRunId`) so extension fields read like first-class fields
// once rendered, while staying a strictly closed character class (no
// separators, no unicode, nothing that could be used to smuggle structure).
const SUFFIX_SHAPE_PATTERN = /^[a-z][a-zA-Z0-9]{0,63}$/

// Case-insensitive: a suffix like `Data` or `RAWsql` must not be able to
// dodge the forbidden-content check just by casing, even though the shape
// pattern itself permits mixed-case interior characters.
const FORBIDDEN_CONTENT_KEY_SET = new Set(TEMPLATE_FORBIDDEN_CONTENT_KEYS.map((key) => key.toLowerCase()))

class StockPreparationExtensionNamespaceError extends Error {
  constructor(message, reason, details = {}) {
    super(message)
    this.name = 'StockPreparationExtensionNamespaceError'
    this.reason = reason
    this.details = details
  }
}

function fail(reason, message, details) {
  throw new StockPreparationExtensionNamespaceError(message, reason, details || {})
}

// Broad membership predicate: "does this id live in the tenant-extension
// namespace at all", independent of whether it would pass full validation.
// Intended for call sites that need a cheap, side-effect-free branch (e.g.
// "skip template-authority checks for this id") without needing the frozen
// template field-id catalog on hand.
function isTenantExtensionField(fieldId) {
  return (
    typeof fieldId === 'string' &&
    fieldId.startsWith(TENANT_EXTENSION_FIELD_ID_PREFIX) &&
    fieldId.length > TENANT_EXTENSION_FIELD_ID_PREFIX.length
  )
}

function extractSuffix(fieldId) {
  return fieldId.slice(TENANT_EXTENSION_FIELD_ID_PREFIX.length)
}

// Fail-closed on the catalog itself: a missing/empty/malformed
// templateFieldIds must never be silently treated as "nothing to collide
// with" (that would turn the collision check into a no-op).
function normalizeTemplateFieldIds(templateFieldIds) {
  const list = templateFieldIds instanceof Set ? [...templateFieldIds] : templateFieldIds
  if (!Array.isArray(list) || list.length === 0) {
    fail(
      'TEMPLATE_FIELD_IDS_INVALID',
      'templateFieldIds must be a non-empty array or Set of frozen template field ids',
      { received: Array.isArray(list) ? 'empty_array' : typeof templateFieldIds },
    )
  }
  const normalized = new Set()
  for (const id of list) {
    if (typeof id !== 'string' || id.length === 0) {
      fail('TEMPLATE_FIELD_IDS_INVALID', 'templateFieldIds entries must be non-empty strings', {})
    }
    normalized.add(id.toLowerCase())
  }
  return normalized
}

// Full validation. Throws StockPreparationExtensionNamespaceError with a
// closed `.reason` on any violation; on success returns a frozen descriptor.
function assertExtensionFieldIdValid(fieldId, options = {}) {
  if (typeof fieldId !== 'string' || fieldId.length === 0) {
    fail('FIELD_ID_NOT_A_STRING', 'extension field id must be a non-empty string', {})
  }
  if (!fieldId.startsWith(TENANT_EXTENSION_FIELD_ID_PREFIX)) {
    fail(
      'FIELD_ID_PREFIX_MISSING',
      `extension field id must start with "${TENANT_EXTENSION_FIELD_ID_PREFIX}"`,
      { fieldId },
    )
  }
  const suffix = extractSuffix(fieldId)
  if (suffix.length === 0) {
    fail(
      'FIELD_ID_SUFFIX_EMPTY',
      'extension field id must carry a non-empty suffix after the reserved prefix',
      { fieldId },
    )
  }
  if (!SUFFIX_SHAPE_PATTERN.test(suffix)) {
    fail(
      'FIELD_ID_SUFFIX_INVALID_CHARACTERS',
      'extension field id suffix must be ASCII camelCase starting with a lowercase letter (max 64 chars)',
      { fieldId },
    )
  }

  // Catalog validated before the content checks so an omitted/malformed
  // catalog can never produce a false "valid".
  const templateFieldIdSet = normalizeTemplateFieldIds(options.templateFieldIds)

  const suffixLower = suffix.toLowerCase()
  if (FORBIDDEN_CONTENT_KEY_SET.has(suffixLower)) {
    fail(
      'FIELD_ID_FORBIDDEN_CONTENT_KEY',
      'extension field id suffix must not be a forbidden content key',
      { fieldId, suffix },
    )
  }
  if (templateFieldIdSet.has(suffixLower)) {
    fail(
      'FIELD_ID_TEMPLATE_COLLISION',
      'extension field id suffix collides with a frozen template field id',
      { fieldId, suffix },
    )
  }

  return Object.freeze({ fieldId, suffix, prefix: TENANT_EXTENSION_FIELD_ID_PREFIX })
}

module.exports = {
  TENANT_EXTENSION_FIELD_ID_PREFIX,
  STOCK_PREPARATION_EXTENSION_NAMESPACE_ERROR_REASONS,
  StockPreparationExtensionNamespaceError,
  isTenantExtensionField,
  assertExtensionFieldIdValid,
  __internals: {
    extractSuffix,
    normalizeTemplateFieldIds,
    SUFFIX_SHAPE_PATTERN,
  },
}
