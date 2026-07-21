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
      return Buffer.from(value.normalize('NFC'), 'utf8')
    default:
      throw new MaterialReconciliationDigestError('UNSUPPORTED_KIND', `unknown value kind "${kind}"`)
  }
}

function assertFieldOrder(fieldOrder) {
  if (!Array.isArray(fieldOrder) || fieldOrder.length === 0) {
    throw new MaterialReconciliationDigestError('FIELD_ORDER_MISMATCH', 'fieldOrder must be a non-empty array')
  }
  const seen = new Set()
  for (const fieldId of fieldOrder) {
    if (typeof fieldId !== 'string' || fieldId.length === 0) {
      throw new MaterialReconciliationDigestError('FIELD_ORDER_MISMATCH', 'fieldOrder entries must be non-empty strings')
    }
    if (seen.has(fieldId)) {
      throw new MaterialReconciliationDigestError('FIELD_ORDER_MISMATCH', 'fieldOrder entries must be unique', {
        fieldId,
      })
    }
    seen.add(fieldId)
  }
  return seen
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
  const orderedIds = assertFieldOrder(fieldOrder)
  if (!isPlainObject(row)) {
    throw new MaterialReconciliationDigestError('UNSUPPORTED_KIND', 'row must be a plain object')
  }
  for (const key of Object.keys(row)) {
    if (!orderedIds.has(key)) {
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
    parts.push(lengthPrefix(Buffer.from(fieldId, 'utf8')))
    parts.push(Buffer.from([MR_TYPE_TAGS[kind]]))
    parts.push(lengthPrefix(valueBytes))
  }
  const buffer = sha256(Buffer.concat(parts))
  return Object.freeze({ buffer, hex: buffer.toString('hex') })
}

function toKeyBytes(identityKeyBytes) {
  if (Buffer.isBuffer(identityKeyBytes)) return identityKeyBytes
  if (typeof identityKeyBytes === 'string') return Buffer.from(identityKeyBytes, 'utf8')
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
  if (!Buffer.isBuffer(canonicalRowDigest) || canonicalRowDigest.length === 0) {
    throw new MaterialReconciliationDigestError('UNSUPPORTED_KIND', 'canonicalRowDigest must be a non-empty Buffer')
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

// snapshotContentDigest (frozen, §4.6): normalized multiset digest of the
// encoded sort tuples — byte-lexicographic sort, each tuple length-prefixed,
// sha256. Deterministic under any input order; duplicates count (multiset).
function computeSnapshotContentDigest(tuples) {
  if (!Array.isArray(tuples)) {
    throw new MaterialReconciliationDigestError('UNSUPPORTED_KIND', 'computeSnapshotContentDigest requires an array of tuple Buffers')
  }
  for (const tuple of tuples) {
    if (!Buffer.isBuffer(tuple) || tuple.length === 0) {
      throw new MaterialReconciliationDigestError('UNSUPPORTED_KIND', 'each tuple must be a non-empty Buffer')
    }
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
