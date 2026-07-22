'use strict'

// P1b — tenant extension-field NAMESPACE discipline hermetic battery.
// Plain node test (throws on failure). No DB, no network. Values-free:
// exercises id-shape/collision logic only, never sheet content.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const MODULE_PATH = path.join(__dirname, '..', 'lib', 'stock-preparation-extension-namespace.cjs')
const TEMPLATES_MODULE_PATH = path.join(__dirname, '..', 'lib', 'stock-preparation-templates.cjs')

const {
  TENANT_EXTENSION_FIELD_ID_PREFIX,
  STOCK_PREPARATION_EXTENSION_NAMESPACE_ERROR_REASONS,
  StockPreparationExtensionNamespaceError,
  isTenantExtensionField,
  assertExtensionFieldIdValid,
  __internals,
} = require(MODULE_PATH)

const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  STOCK_PREPARATION_MVP_TABLE_TEMPLATES,
  __internals: { FORBIDDEN_CONTENT_KEYS },
} = require(TEMPLATES_MODULE_PATH)

// The real frozen field-id catalog, exactly as it would be assembled by a
// future call site (main table + every MVP satellite table), not a
// hand-typed duplicate.
const REAL_TEMPLATE_FIELD_IDS = [
  ...STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => field.id),
  ...STOCK_PREPARATION_MVP_TABLE_TEMPLATES.flatMap((template) => template.fields.map((field) => field.id)),
]

function assertThrowsReason(fn, reason, label) {
  let thrown = null
  try {
    fn()
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown, `${label}: expected a throw`)
  assert.ok(
    thrown instanceof StockPreparationExtensionNamespaceError,
    `${label}: expected StockPreparationExtensionNamespaceError, got ${thrown.name}`,
  )
  assert.equal(thrown.reason, reason, `${label}: expected reason ${reason}, got ${thrown.reason}`)
  assert.ok(
    STOCK_PREPARATION_EXTENSION_NAMESPACE_ERROR_REASONS.includes(thrown.reason),
    `${label}: reason ${thrown.reason} must be in the closed vocabulary`,
  )
  return thrown
}

function singleSourceDependency() {
  // Charter discipline: this module reuses FORBIDDEN_CONTENT_KEYS from
  // stock-preparation-templates.cjs rather than duplicating the vocabulary,
  // and touches no other project file (node builtins aside).
  const source = fs.readFileSync(MODULE_PATH, 'utf8')
  const requireCalls = [...source.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((match) => match[2])
  assert.deepEqual(requireCalls, ['./stock-preparation-templates.cjs'], 'exactly one project require, no other coupling')
}

function frozenVocabularies() {
  assert.ok(Object.isFrozen(STOCK_PREPARATION_EXTENSION_NAMESPACE_ERROR_REASONS))
  assert.equal(TENANT_EXTENSION_FIELD_ID_PREFIX, 'ext_')
  for (const reason of [
    'FIELD_ID_NOT_A_STRING',
    'FIELD_ID_PREFIX_MISSING',
    'FIELD_ID_SUFFIX_EMPTY',
    'FIELD_ID_SUFFIX_INVALID_CHARACTERS',
    'FIELD_ID_FORBIDDEN_CONTENT_KEY',
    'FIELD_ID_TEMPLATE_COLLISION',
    'TEMPLATE_FIELD_IDS_INVALID',
  ]) {
    assert.ok(STOCK_PREPARATION_EXTENSION_NAMESPACE_ERROR_REASONS.includes(reason), `reason vocabulary includes ${reason}`)
  }
  // No accidental extra reasons beyond the pinned set (closed vocab both ways).
  assert.equal(STOCK_PREPARATION_EXTENSION_NAMESPACE_ERROR_REASONS.length, 7)
}

function namespaceDisjointFromRealCatalogToday() {
  // Positive control: today's frozen catalog never uses the reserved prefix,
  // so the two namespaces are disjoint by construction (the doc's claim).
  for (const fieldId of REAL_TEMPLATE_FIELD_IDS) {
    assert.ok(!fieldId.startsWith(TENANT_EXTENSION_FIELD_ID_PREFIX), `frozen field id "${fieldId}" must not use the reserved prefix`)
  }
  assert.ok(REAL_TEMPLATE_FIELD_IDS.length > 20, 'sanity: catalog is not accidentally empty')
}

function validExtensionFieldIdAccepted() {
  const result = assertExtensionFieldIdValid('ext_customPurchaseNote', { templateFieldIds: REAL_TEMPLATE_FIELD_IDS })
  assert.deepEqual(result, { fieldId: 'ext_customPurchaseNote', suffix: 'customPurchaseNote', prefix: 'ext_' })
  assert.ok(Object.isFrozen(result), 'success descriptor is frozen')

  // Set input for templateFieldIds is accepted identically to an array.
  const viaSet = assertExtensionFieldIdValid('ext_customPurchaseNote', { templateFieldIds: new Set(REAL_TEMPLATE_FIELD_IDS) })
  assert.deepEqual(viaSet, result, 'Set and Array template catalogs validate identically')

  // A bare single-letter suffix is the minimal legal shape.
  assertExtensionFieldIdValid('ext_a', { templateFieldIds: REAL_TEMPLATE_FIELD_IDS })
}

function missingPrefixRejected() {
  assertThrowsReason(
    () => assertExtensionFieldIdValid('projectNo', { templateFieldIds: REAL_TEMPLATE_FIELD_IDS }),
    'FIELD_ID_PREFIX_MISSING',
    'unprefixed real field name',
  )
  assertThrowsReason(
    () => assertExtensionFieldIdValid('customField', { templateFieldIds: REAL_TEMPLATE_FIELD_IDS }),
    'FIELD_ID_PREFIX_MISSING',
    'unprefixed arbitrary name',
  )
  assertThrowsReason(
    () => assertExtensionFieldIdValid('EXT_customField', { templateFieldIds: REAL_TEMPLATE_FIELD_IDS }),
    'FIELD_ID_PREFIX_MISSING',
    'wrong-case prefix is not the reserved prefix',
  )
  // Non-string / empty-string inputs fail closed on the same string gate.
  for (const bad of [undefined, null, 42, {}, [], '']) {
    assertThrowsReason(
      () => assertExtensionFieldIdValid(bad, { templateFieldIds: REAL_TEMPLATE_FIELD_IDS }),
      'FIELD_ID_NOT_A_STRING',
      `non-string fieldId ${JSON.stringify(bad)}`,
    )
  }
}

function suffixShapeRejected() {
  assertThrowsReason(
    () => assertExtensionFieldIdValid('ext_', { templateFieldIds: REAL_TEMPLATE_FIELD_IDS }),
    'FIELD_ID_SUFFIX_EMPTY',
    'bare prefix with empty suffix',
  )
  for (const bad of [
    'ext_Custom', // must start lowercase
    'ext_1custom', // must start with a letter
    'ext_custom_field', // no underscores after the prefix
    'ext_custöm', // ASCII only
    `ext_${'a'.repeat(65)}`, // over the 64-char suffix bound
  ]) {
    assertThrowsReason(
      () => assertExtensionFieldIdValid(bad, { templateFieldIds: REAL_TEMPLATE_FIELD_IDS }),
      'FIELD_ID_SUFFIX_INVALID_CHARACTERS',
      `invalid suffix shape ${JSON.stringify(bad)}`,
    )
  }
  // 64-char suffix (the boundary itself) is legal.
  assertExtensionFieldIdValid(`ext_${'a'.repeat(64)}`, { templateFieldIds: REAL_TEMPLATE_FIELD_IDS })
}

function templateFieldIdsCatalogFailsClosed() {
  for (const bad of [undefined, null, [], new Set(), 'not-an-array', ['ok', '', 'also-ok'], ['ok', 42]]) {
    assertThrowsReason(
      () => assertExtensionFieldIdValid('ext_customField', { templateFieldIds: bad }),
      'TEMPLATE_FIELD_IDS_INVALID',
      `malformed templateFieldIds ${JSON.stringify(bad)}`,
    )
  }
  // Omitting the options object entirely is the same as omitting the catalog.
  assertThrowsReason(
    () => assertExtensionFieldIdValid('ext_customField'),
    'TEMPLATE_FIELD_IDS_INVALID',
    'no options object at all',
  )
}

function collisionWithRealTemplateFieldIdRejected() {
  // Uses the REAL catalog assembled from stock-preparation-templates.cjs, not
  // a synthetic fixture — 'projectNo' is a genuine REQUIRED_SYSTEM_FIELDS id
  // on the main table template.
  assert.ok(REAL_TEMPLATE_FIELD_IDS.includes('projectNo'), 'fixture sanity: projectNo is a real frozen field id')
  assertThrowsReason(
    () => assertExtensionFieldIdValid('ext_projectNo', { templateFieldIds: REAL_TEMPLATE_FIELD_IDS }),
    'FIELD_ID_TEMPLATE_COLLISION',
    'suffix exactly matches a real frozen field id',
  )
  // Case-insensitive: componentSourceId is real; an all-lowercase suffix must
  // still be caught (defends against a casing-based dodge of the check).
  assert.ok(REAL_TEMPLATE_FIELD_IDS.includes('componentSourceId'), 'fixture sanity: componentSourceId is real')
  assertThrowsReason(
    () => assertExtensionFieldIdValid('ext_componentsourceid', { templateFieldIds: REAL_TEMPLATE_FIELD_IDS }),
    'FIELD_ID_TEMPLATE_COLLISION',
    'case-insensitive collision against a real frozen field id',
  )
  // A collision that is scoped OUT of the supplied catalog does not fire —
  // proves the check is genuinely catalog-driven, not a hardcoded blocklist.
  assertExtensionFieldIdValid('ext_projectNo', { templateFieldIds: ['unrelatedFieldOnly'] })
}

function forbiddenContentKeyRejected() {
  assert.ok(FORBIDDEN_CONTENT_KEYS.includes('rawSql'), 'fixture sanity: rawSql is a real forbidden content key')
  assertThrowsReason(
    () => assertExtensionFieldIdValid('ext_rawSql', { templateFieldIds: REAL_TEMPLATE_FIELD_IDS }),
    'FIELD_ID_FORBIDDEN_CONTENT_KEY',
    'suffix exactly matches a forbidden content key',
  )
  // Case-insensitive dodge attempt.
  assertThrowsReason(
    () => assertExtensionFieldIdValid('ext_rawsql', { templateFieldIds: REAL_TEMPLATE_FIELD_IDS }),
    'FIELD_ID_FORBIDDEN_CONTENT_KEY',
    'case-insensitive collision against a forbidden content key',
  )
  for (const key of ['data', 'sql', 'query', 'payload']) {
    assertThrowsReason(
      () => assertExtensionFieldIdValid(`ext_${key}`, { templateFieldIds: REAL_TEMPLATE_FIELD_IDS }),
      'FIELD_ID_FORBIDDEN_CONTENT_KEY',
      `forbidden content key ${key}`,
    )
  }
}

function isTenantExtensionFieldPredicate() {
  assert.equal(isTenantExtensionField('ext_foo'), true)
  assert.equal(isTenantExtensionField('ext_foo_bar'), true, 'predicate is a broad membership check, not full shape validation')
  assert.equal(isTenantExtensionField('foo'), false)
  assert.equal(isTenantExtensionField('ext_'), false, 'bare prefix with no suffix is not membership')
  assert.equal(isTenantExtensionField('EXT_foo'), false, 'wrong-case prefix is not membership')
  assert.equal(isTenantExtensionField('projectNo'), false)
  for (const bad of [undefined, null, 42, {}, [], '']) {
    assert.equal(isTenantExtensionField(bad), false, `non-string/empty ${JSON.stringify(bad)} is not membership`)
  }
  // Predicate/assert nuance: a string can be a namespace MEMBER (predicate
  // true) yet still fail full validation (assert throws) because its shape
  // is invalid — the predicate is deliberately cheaper than the assertion.
  assert.equal(isTenantExtensionField('ext_foo_bar'), true)
  assertThrowsReason(
    () => assertExtensionFieldIdValid('ext_foo_bar', { templateFieldIds: REAL_TEMPLATE_FIELD_IDS }),
    'FIELD_ID_SUFFIX_INVALID_CHARACTERS',
    'namespace member that still fails full validation',
  )
}

function noLiveMutableExportLeak() {
  // Parity with the sibling material-reconciliation-row-digest module's
  // hardening: no live Set/Map anywhere on the export surface (a reachable
  // mutable collection could be poisoned to flip a validator from reject to
  // accept), walked recursively with a cycle guard.
  const mod = require(MODULE_PATH)
  const seen = new WeakSet()
  const walk = (value, label) => {
    assert.ok(!(value instanceof Set), `${label}: live Set instance exported`)
    assert.ok(!(value instanceof Map), `${label}: live Map instance exported`)
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return
    if (seen.has(value)) return
    seen.add(value)
    for (const [key, child] of Object.entries(value)) {
      walk(child, `${label}.${key}`)
    }
  }
  walk(mod, 'module')

  // Even __internals.normalizeTemplateFieldIds, which builds a Set
  // internally, returns a fresh one each call — mutating the return value
  // must not affect a later call.
  const set1 = __internals.normalizeTemplateFieldIds(['alpha'])
  set1.add('poisoned')
  const set2 = __internals.normalizeTemplateFieldIds(['alpha'])
  assert.equal(set2.has('poisoned'), false, 'internal catalog normalization is not shared/poisonable across calls')
}

function main() {
  singleSourceDependency()
  frozenVocabularies()
  namespaceDisjointFromRealCatalogToday()
  validExtensionFieldIdAccepted()
  missingPrefixRejected()
  suffixShapeRejected()
  templateFieldIdsCatalogFailsClosed()
  collisionWithRealTemplateFieldIdRejected()
  forbiddenContentKeyRejected()
  isTenantExtensionFieldPredicate()
  noLiveMutableExportLeak()
}

main()
console.log('stock-preparation-extension-namespace.test.cjs OK')
