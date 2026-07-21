'use strict'

// Material-reconciliation D1: canonicalRowDigest determinism contract + identity
// sort-tuple + snapshot-content-digest codec (charter §4.6, rev-4/rev-5 frozen;
// mutation-load-bearing per §8.2b-15/15b).
// Schema-only and latent: provisions no sheet, reads no data, writes no rows,
// exposes no runtime route. Pure deterministic codec over caller-supplied bytes;
// the only dependency is node:crypto. Structurally independent of every
// stock-preparation module (charter §3): nothing here may require stock-prep
// templates, BOM mapper, classifiers, generation, repair, or persist-unit-of-work.
//
// Frozen rules (any deviation is a determinism mutation red, §8.2b-15b):
// - field order: contractVersion-frozen fieldOrder authority, never row key order;
// - single-byte type tags: missing / null / boolean / integer / decimal / string
//   are six distinct domains ("1" can never collide with 1, "" never with null);
// - null vs empty string vs missing: three distinct encodings, never folded;
// - numbers: canonical decimal TEXT, arbitrary precision, never IEEE754 transit
//   (decimals must arrive as { decimal: '<text>' } strings);
// - strings: NFC-normalized UTF-8, no case folding, no trimming;
// - every variable-width component is 4-byte big-endian length-prefixed — bare
//   concatenation is forbidden (cross-component splice collisions, §8.2b-15);
// - identityKeyClass is a single-byte domain separator: the identity_invalid
//   empty sentinel lives in class 0x00 and can never collide with a real key.

// Deep-review recorded rulings (owner focus 2/5):
// - Kind classification is TRANSIT-TYPED by design: integer 5, {decimal:'5'}
//   and '5' occupy distinct tag domains. The UPSTREAM projection layer (D3a
//   design gate) owns coercion to the contractVersion-frozen per-field kind;
//   classifyValue is not a type-inference feature. D3a must also freeze a
//   per-source decimalTransit capability (decimal fields carried as text
//   end-to-end) and expand exponent notation before {decimal} wrapping
//   (String(1e-7) === '1e-7' would be DECIMAL_MALFORMED here, by design).
// - computeSnapshotContentDigest([]) is LEGAL: a complete, consistency-proven
//   EMPTY snapshot is a chartered positive control (§8.2-4); its digest is the
//   deterministic sha256 of zero tuples.
// - The returned {buffer, hex} object is frozen but Buffer CONTENTS are
//   inherently mutable; hex is the authoritative immutable form.

const crypto = require('node:crypto')

const MR_DIGEST_ERROR_REASONS = Object.freeze([
  'DECIMAL_MALFORMED',
  'DECIMAL_FLOAT_TRANSIT',
  'MULTIPLICITY_OUT_OF_BOUNDS',
  'VALID_KEY_EMPTY',
  'INVALID_KEY_NONEMPTY',
  'FIELD_ORDER_MISMATCH',
  'UNSUPPORTED_KIND',
  'LENGTH_OVERFLOW',
  // Deep-review P1: ill-formed UTF-16 (lone surrogates) silently folded to
  // U+FFFD by Buffer.from(...,'utf8'), colliding distinct inputs — rejected.
  'STRING_ILL_FORMED',
  // Deep-review P3: canonicalRowDigest must be exactly 32 bytes (sha256).
  'DIGEST_WIDTH_INVALID',
  // Corrective-review P2: a repeated identity-content group in the snapshot
  // digest is non-canonical (the multiset has two encodings) — rejected.
  'DUPLICATE_IDENTITY_GROUP',
])
const MR_DIGEST_ERROR_REASON_SET = new Set(MR_DIGEST_ERROR_REASONS)

class MaterialReconciliationDigestError extends Error {
  constructor(reason, message, details = {}) {
    super(message)
    this.name = 'MaterialReconciliationDigestError'
    if (!MR_DIGEST_ERROR_REASON_SET.has(reason)) {
      // Fail closed on codec-internal misuse: reasons are a closed vocabulary.
      throw new Error(`MaterialReconciliationDigestError: unknown reason "${reason}"`)
    }
    this.reason = reason
    this.details = details
  }
}

// Closed value-kind vocabulary and single-byte type tags (frozen, §4.6 rev-5).
const MR_VALUE_KINDS = Object.freeze(['missing', 'null', 'boolean', 'integer', 'decimal', 'string'])
const MR_VALUE_KIND_SET = new Set(MR_VALUE_KINDS)
const MR_TYPE_TAGS = Object.freeze({
  missing: 0x00,
  null: 0x01,
  boolean: 0x02,
  integer: 0x03,
  decimal: 0x04,
  string: 0x05,
})

// Closed identity-key class vocabulary + single-byte domain separators (rev-4).
const MR_IDENTITY_KEY_CLASSES = Object.freeze(['valid', 'identity_invalid'])
const MR_IDENTITY_KEY_CLASS_SET = new Set(MR_IDENTITY_KEY_CLASSES)
const MR_IDENTITY_KEY_CLASS_BYTES = Object.freeze({
  identity_invalid: 0x00,
  valid: 0x01,
})

const MAX_LENGTH_PREFIX = 0xffffffff
const MAX_MULTIPLICITY_ENCODABLE = 0xffffffff

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

// 4-byte big-endian unsigned length + bytes. Used for EVERY variable-width
// component everywhere; bare concatenation is forbidden (§8.2b-15).
function lengthPrefix(bytes) {
  if (!Buffer.isBuffer(bytes)) {
    throw new MaterialReconciliationDigestError('UNSUPPORTED_KIND', 'lengthPrefix requires a Buffer')
  }
  if (bytes.length > MAX_LENGTH_PREFIX) {
    throw new MaterialReconciliationDigestError('LENGTH_OVERFLOW', 'component exceeds 4-byte length prefix', {
      length: bytes.length,
    })
  }
  const header = Buffer.alloc(4)
  header.writeUInt32BE(bytes.length, 0)
  return Buffer.concat([header, bytes])
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest()
}

// Classify a raw row value into the closed kind vocabulary. JS numbers are
// accepted ONLY as safe integers: decimals must arrive as { decimal: '<text>' }
// strings — IEEE754 float transit is forbidden (§4.6 rev-5).
function classifyValue(value) {
  if (value === undefined) return 'missing'
  if (value === null) return 'null'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new MaterialReconciliationDigestError(
        'DECIMAL_FLOAT_TRANSIT',
        'non-integer or unsafe JS number: decimals must arrive as { decimal: "<text>" } strings',
        { typeofValue: 'number' }
      )
    }
    return 'integer'
  }
  if (typeof value === 'string') return 'string'
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
    if (keys.length === 1 && keys[0] === 'decimal' && typeof value.decimal === 'string') {
      return 'decimal'
    }
  }
  throw new MaterialReconciliationDigestError('UNSUPPORTED_KIND', 'unsupported value kind', {
    typeofValue: typeof value,
  })
}

const DECIMAL_TEXT_PATTERN = /^[+-]?[0-9]+(\.[0-9]+)?$/

// Canonical decimal text (frozen, §4.6 rev-5). Arbitrary precision — operates on
// the string only, never parseFloat. Rejects (DECIMAL_MALFORMED): exponent
// notation, hex, spaces, multiple dots, empty, bare sign, bare dot, '.5', '1.'.
// Canonical form: no leading '+', no leading zeros (single zero before a dot is
// kept, e.g. '0.5'), fractional trailing zeros trimmed entirely, '-0' folds to '0'.
function normalizeDecimalText(text) {
  if (typeof text !== 'string') {
    throw new MaterialReconciliationDigestError('DECIMAL_MALFORMED', 'decimal text must be a string')
  }
  if (!DECIMAL_TEXT_PATTERN.test(text)) {
    throw new MaterialReconciliationDigestError('DECIMAL_MALFORMED', 'malformed decimal text', {
      length: text.length,
    })
  }
  let rest = text
  let negative = false
  if (rest[0] === '+') {
    rest = rest.slice(1)
  } else if (rest[0] === '-') {
    negative = true
    rest = rest.slice(1)
  }
  const dotIndex = rest.indexOf('.')
  let integerPart = dotIndex === -1 ? rest : rest.slice(0, dotIndex)
  let fractionPart = dotIndex === -1 ? '' : rest.slice(dotIndex + 1)
  // Strip leading zeros, keeping a single '0' when the integer part is all zeros.
  integerPart = integerPart.replace(/^0+(?=[0-9])/, '')
  // Trim fractional trailing zeros entirely ('1.10' -> '1.1', '1.0' -> '1').
  fractionPart = fractionPart.replace(/0+$/, '')
  let canonical = fractionPart.length > 0 ? `${integerPart}.${fractionPart}` : integerPart
  const isZero = /^0(\.0*)?$/.test(canonical) || canonical === '0'
  if (isZero) return '0' // negative zero folds to zero
  return negative ? `-${canonical}` : canonical
}

// Canonical value bytes per kind. missing/null carry empty payloads (the type
// tag alone separates them); boolean is a single 0x00/0x01 byte; integer and
// decimal are canonical decimal text as UTF-8; string is NFC-normalized UTF-8
// with NO case folding and NO trimming.
function encodeValueBytes(kind, value) {
  switch (kind) {
    case 'missing':
    case 'null':
      return Buffer.alloc(0)
    case 'boolean':
      return Buffer.from([value ? 0x01 : 0x00])
    case 'integer':
      // Safe integers stringify in plain decimal form; String(-0) === '0'.
      return Buffer.from(normalizeDecimalText(String(value)), 'utf8')
    case 'decimal':
      return Buffer.from(normalizeDecimalText(value.decimal), 'utf8')
    case 'string':
      return Buffer.from(assertWellFormedString(value, 'string value').normalize('NFC'), 'utf8')
    default:
      throw new MaterialReconciliationDigestError('UNSUPPORTED_KIND', `unknown value kind "${kind}"`)
  }
}

function assertFieldOrder(fieldOrder) {
  if (!Array.isArray(fieldOrder) || fieldOrder.length === 0) {
    throw new MaterialReconciliationDigestError('FIELD_ORDER_MISMATCH', 'fieldOrder must be a non-empty array')
  }
  const seen = new Set()
  const rawIds = new Set()
  for (const fieldId of fieldOrder) {
    if (typeof fieldId !== 'string' || fieldId.length === 0) {
      throw new MaterialReconciliationDigestError('FIELD_ORDER_MISMATCH', 'fieldOrder entries must be non-empty strings')
    }
    // Deep-review P2: ids are encoded in NFC form, so uniqueness must also be
    // judged on NFC forms (['e\u0301','\u00e9'] is ONE logical field twice).
    assertWellFormedString(fieldId, 'fieldOrder entry')
    if (seen.has(fieldId.normalize('NFC'))) {
      throw new MaterialReconciliationDigestError('FIELD_ORDER_MISMATCH', 'fieldOrder entries must be unique', {
        fieldId,
      })
    }
    seen.add(fieldId.normalize('NFC'))
    // Row values are looked up by the RAW id (row[fieldId]) \u2014 the outside-key
    // guard must therefore accept the raw spellings the caller supplied.
    rawIds.add(fieldId)
  }
  return { seen, rawIds }
}

// canonicalRowDigest (frozen, §4.6 rev-5). fieldOrder is the contractVersion-
// frozen field order supplied by the caller — row key insertion order MUST NOT
// matter. Extra row keys not in fieldOrder fail closed (silent dropping could
// hide divergence between two sides claiming the same contract).
function computeCanonicalRowDigest(input) {
  if (!isPlainObject(input)) {
    throw new MaterialReconciliationDigestError('UNSUPPORTED_KIND', 'computeCanonicalRowDigest requires an options object')
  }
  const { fieldOrder, row } = input
  const { rawIds: orderedRawIds } = assertFieldOrder(fieldOrder)
  if (!isPlainObject(row)) {
    throw new MaterialReconciliationDigestError('UNSUPPORTED_KIND', 'row must be a plain object')
  }
  for (const key of Object.keys(row)) {
    if (!orderedRawIds.has(key)) {
      throw new MaterialReconciliationDigestError('FIELD_ORDER_MISMATCH', 'row carries a key outside fieldOrder', {
        fieldId: key,
      })
    }
  }
  const parts = []
  for (const fieldId of fieldOrder) {
    const hasKey = Object.prototype.hasOwnProperty.call(row, fieldId)
    const rawValue = hasKey ? row[fieldId] : undefined
    const kind = classifyValue(rawValue)
    const valueBytes = encodeValueBytes(kind, rawValue)
    parts.push(lengthPrefix(Buffer.from(fieldId.normalize('NFC'), 'utf8')))
    parts.push(Buffer.from([MR_TYPE_TAGS[kind]]))
    parts.push(lengthPrefix(valueBytes))
  }
  const buffer = sha256(Buffer.concat(parts))
  return Object.freeze({ buffer, hex: buffer.toString('hex') })
}

// Deep-review P1: Buffer.from(str,'utf8') folds lone surrogates to U+FFFD,
// making distinct accepted inputs collide. Every string ingestion point must
// reject ill-formed UTF-16 with a closed reason instead.
function assertWellFormedString(value, context) {
  const wellFormed = typeof value.isWellFormed === 'function' ? value.isWellFormed() : !/[\uD800-\uDFFF]/.test(value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))
  if (!wellFormed) {
    throw new MaterialReconciliationDigestError('STRING_ILL_FORMED', `${context} contains ill-formed UTF-16 (lone surrogate)`, {
      context,
    })
  }
  return value
}

// String convenience path: well-formed + NFC (the frozen string rules). Buffer
// path passes through untouched — bytes are the caller-owned authority.
function toKeyBytes(identityKeyBytes) {
  if (Buffer.isBuffer(identityKeyBytes)) return identityKeyBytes
  if (typeof identityKeyBytes === 'string') {
    return Buffer.from(assertWellFormedString(identityKeyBytes, 'identityKeyBytes').normalize('NFC'), 'utf8')
  }
  throw new MaterialReconciliationDigestError('UNSUPPORTED_KIND', 'identityKeyBytes must be a Buffer or string')
}

// Identity sort tuple (frozen, §4.6 rev-4):
//   classByte(1, fixed width = self-delimiting)
//   || lengthPrefix(identityKeyBytes)
//   || lengthPrefix(canonicalRowDigest)
//   || multiplicity(4-byte BE, fixed width)
// The class byte is a domain separator: identity_invalid rows carry the fixed
// empty sentinel key in class 0x00 and can never collide with a real key in
// class 0x01. multiplicity is bounded by the read upper bound supplied by the
// caller (page limit x page-count limit) — overflow is excluded by construction.
function encodeIdentitySortTuple(input) {
  if (!isPlainObject(input)) {
    throw new MaterialReconciliationDigestError('UNSUPPORTED_KIND', 'encodeIdentitySortTuple requires an options object')
  }
  const { identityKeyClass, identityKeyBytes, canonicalRowDigest, multiplicity, multiplicityBound } = input
  if (!MR_IDENTITY_KEY_CLASS_SET.has(identityKeyClass)) {
    throw new MaterialReconciliationDigestError('UNSUPPORTED_KIND', 'identityKeyClass must be "valid" or "identity_invalid"')
  }
  const keyBytes = toKeyBytes(identityKeyBytes === undefined ? Buffer.alloc(0) : identityKeyBytes)
  if (identityKeyClass === 'valid' && keyBytes.length === 0) {
    throw new MaterialReconciliationDigestError('VALID_KEY_EMPTY', 'valid identity key requires non-empty key bytes')
  }
  if (identityKeyClass === 'identity_invalid' && keyBytes.length !== 0) {
    throw new MaterialReconciliationDigestError('INVALID_KEY_NONEMPTY', 'identity_invalid rows use the fixed empty sentinel key')
  }
  if (!Buffer.isBuffer(canonicalRowDigest) || canonicalRowDigest.length !== 32) {
    throw new MaterialReconciliationDigestError('DIGEST_WIDTH_INVALID', 'canonicalRowDigest must be exactly 32 bytes (sha256)', {
      length: Buffer.isBuffer(canonicalRowDigest) ? canonicalRowDigest.length : null,
    })
  }
  if (
    !Number.isSafeInteger(multiplicityBound) ||
    multiplicityBound < 1 ||
    multiplicityBound > MAX_MULTIPLICITY_ENCODABLE
  ) {
    throw new MaterialReconciliationDigestError(
      'MULTIPLICITY_OUT_OF_BOUNDS',
      'multiplicityBound must be an integer within 1..2^32-1',
      { multiplicityBound }
    )
  }
  if (!Number.isSafeInteger(multiplicity) || multiplicity < 1 || multiplicity > multiplicityBound) {
    throw new MaterialReconciliationDigestError('MULTIPLICITY_OUT_OF_BOUNDS', 'multiplicity must be an integer within 1..multiplicityBound', {
      multiplicity,
      multiplicityBound,
    })
  }
  const multiplicityBytes = Buffer.alloc(4)
  multiplicityBytes.writeUInt32BE(multiplicity, 0)
  return Buffer.concat([
    Buffer.from([MR_IDENTITY_KEY_CLASS_BYTES[identityKeyClass]]),
    lengthPrefix(keyBytes),
    lengthPrefix(canonicalRowDigest),
    multiplicityBytes,
  ])
}

// snapshotContentDigest (frozen, §4.6). Corrective-review P2: the old form took
// pre-encoded tuple Buffers, which admitted TWO encodings of the same multiset
// (two multiplicity=1 tuples for one identity-content class vs one
// multiplicity=2 tuple) yielding different digests. The canonical unit is the
// identity GROUP: for each distinct (identityKeyClass, identityKeyBytes,
// canonicalRowDigest) there is EXACTLY ONE multiplicity. This function takes
// structured groups, encodes each canonically, and REJECTS a repeated
// identity-content group (DUPLICATE_IDENTITY_GROUP) — so the caller must
// pre-aggregate multiplicity and there is only one legal encoding per multiset.
function computeSnapshotContentDigest(groups, multiplicityBound) {
  if (!Array.isArray(groups)) {
    throw new MaterialReconciliationDigestError('UNSUPPORTED_KIND', 'computeSnapshotContentDigest requires an array of identity groups')
  }
  const seenGroupKeys = new Set()
  const tuples = []
  for (const group of groups) {
    if (!isPlainObject(group)) {
      throw new MaterialReconciliationDigestError('UNSUPPORTED_KIND', 'each identity group must be a plain object')
    }
    // Corrective-review P2: the snapshot-level multiplicityBound is the SOLE
    // read-upper-bound authority (Charter unified read bound). A group may NOT
    // carry its own multiplicityBound — that would let one group exceed the
    // snapshot cap (snapshot bound 1 + group bound 10 + multiplicity 2). Reject
    // any per-group override fail-closed.
    if (Object.prototype.hasOwnProperty.call(group, 'multiplicityBound')) {
      throw new MaterialReconciliationDigestError('UNSUPPORTED_KIND', 'per-group multiplicityBound is forbidden: the snapshot-level bound is authoritative')
    }
    const tuple = encodeIdentitySortTuple({ ...group, multiplicityBound })
    // Group identity = the tuple WITHOUT its trailing fixed 4-byte multiplicity:
    // (classByte || len4+key || len4+digest). A repeat is a non-canonical multiset.
    const groupKey = tuple.subarray(0, tuple.length - 4).toString('hex')
    if (seenGroupKeys.has(groupKey)) {
      throw new MaterialReconciliationDigestError('DUPLICATE_IDENTITY_GROUP', 'identity group repeated — pre-aggregate multiplicity (multiset must be canonical)')
    }
    seenGroupKeys.add(groupKey)
    tuples.push(tuple)
  }
  const sorted = [...tuples].sort(Buffer.compare)
  const parts = sorted.map((tuple) => lengthPrefix(tuple))
  const buffer = sha256(Buffer.concat(parts))
  return Object.freeze({ buffer, hex: buffer.toString('hex') })
}

module.exports = {
  MR_DIGEST_ERROR_REASONS,
  MR_VALUE_KINDS,
  MR_TYPE_TAGS,
  MR_IDENTITY_KEY_CLASSES,
  MR_IDENTITY_KEY_CLASS_BYTES,
  MaterialReconciliationDigestError,
  classifyValue,
  normalizeDecimalText,
  computeCanonicalRowDigest,
  encodeIdentitySortTuple,
  computeSnapshotContentDigest,
  __internals: {
    MR_DIGEST_ERROR_REASON_SET,
    MR_VALUE_KIND_SET,
    MR_IDENTITY_KEY_CLASS_SET,
    MAX_LENGTH_PREFIX,
    MAX_MULTIPLICITY_ENCODABLE,
    isPlainObject,
    lengthPrefix,
    sha256,
    encodeValueBytes,
    assertFieldOrder,
    toKeyBytes,
  },
}
