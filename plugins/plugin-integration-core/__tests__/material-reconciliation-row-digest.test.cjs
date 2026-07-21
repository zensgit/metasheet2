'use strict'

// Material-reconciliation D1 canonicalRowDigest / sort-tuple / snapshot-content
// digest determinism battery (charter §4.6 rev-4/rev-5; mutation stakes
// §8.2b-15/15b). Plain node test (throws on failure). Values-free: fixtures use
// abstract tokens only. Also enforces charter §3 structural independence of the
// module source (no stock-preparation prefixes or requires).

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const MODULE_PATH = path.join(__dirname, '..', 'lib', 'material-reconciliation-row-digest.cjs')

const {
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
  __internals,
} = require(MODULE_PATH)

function assertThrowsReason(fn, reason, label) {
  let thrown = null
  try {
    fn()
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown, `${label}: expected a throw`)
  assert.ok(
    thrown instanceof MaterialReconciliationDigestError,
    `${label}: expected MaterialReconciliationDigestError, got ${thrown.name}`
  )
  assert.equal(thrown.reason, reason, `${label}: expected reason ${reason}, got ${thrown.reason}`)
  return thrown
}

function digestHex(fieldOrder, row) {
  return computeCanonicalRowDigest({ fieldOrder, row }).hex
}

function structuralIndependence() {
  const source = fs.readFileSync(MODULE_PATH, 'utf8')
  // Charter §3: forbidden stock-prep prefixes must not appear anywhere.
  assert.ok(!source.includes('plm_stock_preparation_'), 'no plm_stock_preparation_ prefix in module source')
  assert.ok(!source.includes('plm.stock-preparation'), 'no plm.stock-preparation prefix in module source')
  // Only node builtins may be required (payload-redaction would be allowed but is unused here).
  const requireCalls = [...source.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((match) => match[2])
  assert.ok(requireCalls.length >= 1, 'module has at least one require (node:crypto)')
  for (const specifier of requireCalls) {
    assert.ok(
      specifier.startsWith('node:') || specifier === './payload-redaction.cjs',
      `require("${specifier}") must be a node builtin or ./payload-redaction.cjs`
    )
    assert.ok(!/stock-preparation/.test(specifier), `require("${specifier}") must not touch stock-preparation modules`)
  }
}

function frozenVocabularies() {
  assert.ok(Object.isFrozen(MR_DIGEST_ERROR_REASONS))
  assert.ok(Object.isFrozen(MR_VALUE_KINDS))
  assert.ok(Object.isFrozen(MR_TYPE_TAGS))
  assert.ok(Object.isFrozen(MR_IDENTITY_KEY_CLASSES))
  assert.ok(Object.isFrozen(MR_IDENTITY_KEY_CLASS_BYTES))
  assert.deepEqual(MR_TYPE_TAGS, { missing: 0, null: 1, boolean: 2, integer: 3, decimal: 4, string: 5 })
  assert.deepEqual([...MR_VALUE_KINDS], ['missing', 'null', 'boolean', 'integer', 'decimal', 'string'])
  assert.deepEqual(MR_IDENTITY_KEY_CLASS_BYTES, { identity_invalid: 0, valid: 1 })
  for (const reason of [
    'DECIMAL_MALFORMED',
    'DECIMAL_FLOAT_TRANSIT',
    'MULTIPLICITY_OUT_OF_BOUNDS',
    'VALID_KEY_EMPTY',
    'INVALID_KEY_NONEMPTY',
    'FIELD_ORDER_MISMATCH',
    'UNSUPPORTED_KIND',
  ]) {
    assert.ok(MR_DIGEST_ERROR_REASONS.includes(reason), `reason vocabulary includes ${reason}`)
  }
}

function fieldOrderAuthority() {
  const fieldOrder = Object.freeze(['k1', 'k2', 'k3'])
  const rowA = { k1: 'v-a', k2: 7, k3: null }
  const rowB = {}
  rowB.k3 = null
  rowB.k2 = 7
  rowB.k1 = 'v-a'
  assert.equal(digestHex(fieldOrder, rowA), digestHex(fieldOrder, rowB), 'row key insertion order must not matter')

  // Same fields, different frozen order -> different digest (fieldOrder is authoritative input).
  const reversed = Object.freeze(['k3', 'k2', 'k1'])
  assert.notEqual(digestHex(fieldOrder, rowA), digestHex(reversed, rowA), 'different fieldOrder must change the digest')

  // Determinism: same input twice -> identical hex.
  assert.equal(digestHex(fieldOrder, rowA), digestHex(fieldOrder, rowA), 'digest is deterministic')

  // Extra row key not in fieldOrder fails closed.
  assertThrowsReason(
    () => computeCanonicalRowDigest({ fieldOrder: ['k1'], row: { k1: 'v-a', k9: 'v-b' } }),
    'FIELD_ORDER_MISMATCH',
    'extra row key'
  )
  // Duplicate fieldOrder ids fail closed.
  assertThrowsReason(
    () => computeCanonicalRowDigest({ fieldOrder: ['k1', 'k1'], row: { k1: 'v-a' } }),
    'FIELD_ORDER_MISMATCH',
    'duplicate fieldOrder id'
  )
}

function typeTagSeparation() {
  const fieldOrder = ['k1']
  // string '1' vs integer 1
  assert.notEqual(digestHex(fieldOrder, { k1: '1' }), digestHex(fieldOrder, { k1: 1 }), 'string "1" != integer 1')
  // '' vs null vs missing: three pairwise-different digests
  const empty = digestHex(fieldOrder, { k1: '' })
  const nul = digestHex(fieldOrder, { k1: null })
  const missing = digestHex(fieldOrder, {})
  assert.notEqual(empty, nul, '"" != null')
  assert.notEqual(empty, missing, '"" != missing')
  assert.notEqual(nul, missing, 'null != missing')
  // explicit undefined encodes as missing (same digest as absent key)
  assert.equal(digestHex(fieldOrder, { k1: undefined }), missing, 'undefined value == missing')
  // boolean true vs integer 1
  assert.notEqual(digestHex(fieldOrder, { k1: true }), digestHex(fieldOrder, { k1: 1 }), 'true != integer 1')
  // integer 1 vs decimal '1' (distinct tags — a contract field has one declared kind)
  assert.notEqual(
    digestHex(fieldOrder, { k1: 1 }),
    digestHex(fieldOrder, { k1: { decimal: '1' } }),
    'integer 1 != decimal "1"'
  )
  // classifyValue closed vocabulary
  assert.equal(classifyValue(undefined), 'missing')
  assert.equal(classifyValue(null), 'null')
  assert.equal(classifyValue(false), 'boolean')
  assert.equal(classifyValue(0), 'integer')
  assert.equal(classifyValue({ decimal: '0' }), 'decimal')
  assert.equal(classifyValue('t'), 'string')
  assertThrowsReason(() => classifyValue([]), 'UNSUPPORTED_KIND', 'array value')
  assertThrowsReason(() => classifyValue({ k1: 't' }), 'UNSUPPORTED_KIND', 'plain object value')
  assertThrowsReason(() => classifyValue({ decimal: 1 }), 'UNSUPPORTED_KIND', 'decimal wrapper with number')
  assertThrowsReason(() => classifyValue(Symbol('t')), 'UNSUPPORTED_KIND', 'symbol value')
}

function decimalNormalization() {
  const fieldOrder = ['k1']
  const dec = (text) => digestHex(fieldOrder, { k1: { decimal: text } })
  // canonical equivalences
  assert.equal(normalizeDecimalText('+1'), '1')
  assert.equal(normalizeDecimalText('01'), '1')
  assert.equal(normalizeDecimalText('1.10'), '1.1')
  assert.equal(normalizeDecimalText('1.0'), '1')
  assert.equal(normalizeDecimalText('-0'), '0')
  assert.equal(normalizeDecimalText('-0.00'), '0')
  assert.equal(normalizeDecimalText('0.5'), '0.5')
  assert.equal(normalizeDecimalText('-2.50'), '-2.5')
  assert.equal(normalizeDecimalText('000'), '0')
  assert.equal(dec('+1'), dec('1'), '+1 == 1 as decimals')
  assert.equal(dec('01'), dec('1'), '01 == 1 as decimals')
  assert.equal(dec('1.10'), dec('1.1'), '1.10 == 1.1 as decimals')
  assert.equal(dec('1.0'), dec('1'), '1.0 == 1 as decimals')
  assert.equal(dec('-0'), dec('0'), '-0 == 0 as decimals')
  assert.equal(dec('-0.00'), dec('0'), '-0.00 == 0 as decimals')
  assert.notEqual(dec('1.1'), dec('1.2'), 'distinct decimals stay distinct')

  // rejections (strictness pinned: '.5' and '1.' are REJECTED, not repaired)
  for (const bad of ['1e2', '1E2', '0x10', '1.', '.5', '--1', '', '-', '.', '+', '1 0', ' 1', '1 ', '1.2.3', '+-1', 'NaN', 'Infinity']) {
    assertThrowsReason(() => normalizeDecimalText(bad), 'DECIMAL_MALFORMED', `decimal reject ${JSON.stringify(bad)}`)
  }
  assertThrowsReason(() => normalizeDecimalText(1), 'DECIMAL_MALFORMED', 'decimal reject non-string')

  // IEEE754 transit forbidden
  assertThrowsReason(() => classifyValue(0.1), 'DECIMAL_FLOAT_TRANSIT', 'JS 0.1')
  assertThrowsReason(() => digestHex(fieldOrder, { k1: 0.1 }), 'DECIMAL_FLOAT_TRANSIT', 'JS 0.1 in row')
  assertThrowsReason(() => classifyValue(Number.MAX_SAFE_INTEGER + 1), 'DECIMAL_FLOAT_TRANSIT', 'unsafe integer')
  assertThrowsReason(() => classifyValue(Number.NaN), 'DECIMAL_FLOAT_TRANSIT', 'NaN')
  assertThrowsReason(() => classifyValue(Number.POSITIVE_INFINITY), 'DECIMAL_FLOAT_TRANSIT', 'Infinity')
  assert.equal(classifyValue(Number.MAX_SAFE_INTEGER), 'integer', 'MAX_SAFE_INTEGER itself is fine')

  // huge decimal strings (40+ digits) normalize exactly without precision loss
  const bigInteger = `1${'2'.repeat(45)}`
  const bigFraction = `${'3'.repeat(45)}7`
  assert.equal(
    normalizeDecimalText(`+0${bigInteger}.${bigFraction}00`),
    `${bigInteger}.${bigFraction}`,
    'arbitrary precision preserved on the string, never parseFloat'
  )
  assert.equal(normalizeDecimalText(`-${bigInteger}`), `-${bigInteger}`, 'huge negative integer text exact')
  assert.notEqual(
    dec(`${bigInteger}.${bigFraction}`),
    dec(`${bigInteger}.${'3'.repeat(45)}8`),
    'last of 46 fraction digits still distinguishes (no float collapse)'
  )
}

function unicodeRules() {
  const fieldOrder = ['k1']
  // NFC: composed U+00E9 vs decomposed 'e' + U+0301 -> SAME digest
  const composed = '\u00e9'
  const decomposed = 'e\u0301'
  assert.notEqual(composed, decomposed, 'fixture sanity: raw JS strings differ pre-normalization')
  assert.equal(
    digestHex(fieldOrder, { k1: composed }),
    digestHex(fieldOrder, { k1: decomposed }),
    'NFC folds composed/decomposed'
  )
  // case NOT folded
  assert.notEqual(digestHex(fieldOrder, { k1: 'A' }), digestHex(fieldOrder, { k1: 'a' }), 'no case folding')
  // whitespace NOT trimmed
  assert.notEqual(digestHex(fieldOrder, { k1: 'a' }), digestHex(fieldOrder, { k1: 'a ' }), 'no trailing trim')
  assert.notEqual(digestHex(fieldOrder, { k1: 'a' }), digestHex(fieldOrder, { k1: ' a' }), 'no leading trim')
}

function lengthPrefixAntiCollision() {
  // Row level: bare concatenation of (id, value) would collide 'ab'+'c' vs 'a'+'bc'.
  assert.notEqual(
    digestHex(['ab'], { ab: 'c' }),
    digestHex(['a'], { a: 'bc' }),
    'length prefixes prevent id/value splice collisions'
  )
  // Two fields vs one field carrying the concatenation.
  assert.notEqual(
    digestHex(['k1', 'k2'], { k1: 'a', k2: 'b' }),
    digestHex(['k1'], { k1: 'ab' }),
    'field boundaries cannot be respliced'
  )

  // Tuple level: the deep-review DIGEST_WIDTH_INVALID rule retires the old
  // short-digest splice fixture STRUCTURALLY — with every digest fixed at 32
  // bytes, a key/digest boundary shift always changes total tuple length, so
  // the splice class is excluded by construction. Pin the width rule instead.
  const digest32 = crypto.createHash('sha256').update('anti-collision').digest()
  for (const badWidth of [2, 31, 33]) {
    assertThrowsReason(
      () => encodeIdentitySortTuple({
        identityKeyClass: 'valid',
        identityKeyBytes: Buffer.from('ab', 'utf8'),
        canonicalRowDigest: Buffer.alloc(badWidth, 0xab),
        multiplicity: 1,
        multiplicityBound: 4,
      }),
      'DIGEST_WIDTH_INVALID',
      `digest width ${badWidth} rejected`
    )
  }
  const tupleA = encodeIdentitySortTuple({
    identityKeyClass: 'valid',
    identityKeyBytes: Buffer.from('ab', 'utf8'),
    canonicalRowDigest: digest32,
    multiplicity: 1,
    multiplicityBound: 4,
  })
  const tupleB = encodeIdentitySortTuple({
    identityKeyClass: 'valid',
    identityKeyBytes: Buffer.from('a', 'utf8'),
    canonicalRowDigest: digest32,
    multiplicity: 1,
    multiplicityBound: 4,
  })
  assert.ok(!tupleA.equals(tupleB), 'different keys with identical digests stay distinct')
  // 4-byte length prefix shape check via internals
  const prefixed = __internals.lengthPrefix(Buffer.from('ab', 'utf8'))
  assert.equal(prefixed.length, 6)
  assert.deepEqual([...prefixed.subarray(0, 4)], [0, 0, 0, 2], 'big-endian 4-byte length header')
}

function sortTupleContract() {
  const digest = computeCanonicalRowDigest({ fieldOrder: ['k1'], row: { k1: 'row-a' } }).buffer
  const base = {
    identityKeyClass: 'valid',
    identityKeyBytes: Buffer.from('key-a', 'utf8'),
    canonicalRowDigest: digest,
    multiplicity: 1,
    multiplicityBound: 8,
  }

  // valid requires non-empty key; invalid requires empty sentinel
  assertThrowsReason(
    () => encodeIdentitySortTuple({ ...base, identityKeyBytes: Buffer.alloc(0) }),
    'VALID_KEY_EMPTY',
    'valid + empty key'
  )
  assertThrowsReason(
    () => encodeIdentitySortTuple({ ...base, identityKeyClass: 'identity_invalid' }),
    'INVALID_KEY_NONEMPTY',
    'invalid + non-empty key'
  )
  assertThrowsReason(
    () => encodeIdentitySortTuple({ ...base, identityKeyClass: 'other' }),
    'UNSUPPORTED_KIND',
    'unknown class'
  )

  // multiplicity bounds: 0 red, bound+1 red, bound itself green
  assertThrowsReason(() => encodeIdentitySortTuple({ ...base, multiplicity: 0 }), 'MULTIPLICITY_OUT_OF_BOUNDS', 'multiplicity 0')
  assertThrowsReason(() => encodeIdentitySortTuple({ ...base, multiplicity: 9 }), 'MULTIPLICITY_OUT_OF_BOUNDS', 'multiplicity > bound')
  assertThrowsReason(() => encodeIdentitySortTuple({ ...base, multiplicity: 1.5 }), 'MULTIPLICITY_OUT_OF_BOUNDS', 'non-integer multiplicity')
  assertThrowsReason(
    () => encodeIdentitySortTuple({ ...base, multiplicityBound: 0 }),
    'MULTIPLICITY_OUT_OF_BOUNDS',
    'bound < 1'
  )
  const atBound = encodeIdentitySortTuple({ ...base, multiplicity: 8 })
  assert.ok(Buffer.isBuffer(atBound), 'multiplicity == bound is accepted')

  // multiplicity 1 vs 2 -> different tuples (fixed 4-byte BE tail)
  const m1 = encodeIdentitySortTuple({ ...base, multiplicity: 1 })
  const m2 = encodeIdentitySortTuple({ ...base, multiplicity: 2 })
  assert.ok(!m1.equals(m2), 'multiplicity participates in the tuple')
  assert.equal(m1.length, m2.length, 'fixed-width multiplicity keeps tuple length stable')

  // class byte domain separation: (invalid, empty sentinel, digest D) vs
  // (valid, key deliberately starting with 0x00 length-prefix-looking bytes, digest D)
  const invalidTuple = encodeIdentitySortTuple({
    identityKeyClass: 'identity_invalid',
    identityKeyBytes: Buffer.alloc(0),
    canonicalRowDigest: digest,
    multiplicity: 1,
    multiplicityBound: 8,
  })
  const adversarialKey = Buffer.from([0x00, 0x00, 0x00, 0x00])
  const validTuple = encodeIdentitySortTuple({
    identityKeyClass: 'valid',
    identityKeyBytes: adversarialKey,
    canonicalRowDigest: digest,
    multiplicity: 1,
    multiplicityBound: 8,
  })
  assert.ok(!invalidTuple.equals(validTuple), 'sentinel lives in its own class domain, no collision')
  assert.equal(invalidTuple[0], 0x00, 'identity_invalid class byte is 0x00')
  assert.equal(validTuple[0], 0x01, 'valid class byte is 0x01')

  // string key input is accepted and utf8-encoded identically to the Buffer form
  const fromString = encodeIdentitySortTuple({ ...base, identityKeyBytes: 'key-a' })
  assert.ok(fromString.equals(m1), 'string key encodes identically to its utf8 Buffer')

  assertThrowsReason(
    () => encodeIdentitySortTuple({ ...base, canonicalRowDigest: Buffer.alloc(0) }),
    'DIGEST_WIDTH_INVALID',
    'empty digest rejected (width rule)'
  )
}

function snapshotContentDigestContract() {
  // Corrective-review P2: the API takes structured identity GROUPS and enforces
  // ONE encoding per multiset — a repeated identity-content group is rejected,
  // so [mult=1, mult=1 same-row] can no longer masquerade as [mult=2].
  // Corrective-review P2: the multiplicityBound is supplied ONCE at the snapshot
  // level (the unified read bound); groups must NOT carry their own.
  const BOUND = 16
  const digestOf = (token) => computeCanonicalRowDigest({ fieldOrder: ['k1'], row: { k1: token } }).buffer
  const group = (token, multiplicity) => ({
    identityKeyClass: 'valid',
    identityKeyBytes: Buffer.from(token, 'utf8'),
    canonicalRowDigest: digestOf(token),
    multiplicity,
  })
  const snap = (groups) => computeSnapshotContentDigest(groups, BOUND)
  const g1 = group('row-a', 1)
  const g2 = group('row-b', 2)
  const g3 = group('row-c', 1)
  const invalidG = {
    identityKeyClass: 'identity_invalid',
    identityKeyBytes: Buffer.alloc(0),
    canonicalRowDigest: digestOf('row-d'),
    multiplicity: 1,
  }

  const forward = snap([g1, g2, g3, invalidG]).hex
  const shuffled = snap([invalidG, g3, g1, g2]).hex
  const shuffled2 = snap([g2, invalidG, g1, g3]).hex
  assert.equal(forward, shuffled, 'snapshot digest is order-independent (normalized multiset)')
  assert.equal(forward, shuffled2, 'snapshot digest is order-independent under any permutation')

  // changing one multiplicity -> different
  const bumped = snap([g1, group('row-b', 3), g3, invalidG]).hex
  assert.notEqual(forward, bumped, 'multiplicity change changes the snapshot digest')

  // Canonical multiset: a REPEATED identity-content group is rejected (two mult=1
  // must not masquerade as one mult=2); the caller must pre-aggregate.
  assertThrowsReason(
    () => snap([g1, g2, g3, invalidG, group('row-a', 1)]),
    'DUPLICATE_IDENTITY_GROUP',
    'repeated identity-content group rejected',
  )
  // Same row as mult=2 is DISTINCT from mult=1 and is the ONLY legal encoding.
  assert.notEqual(snap([group('row-a', 1)]).hex, snap([group('row-a', 2)]).hex, 'multiplicity is value-bearing')
  // Dedup keys on (class,key,digest) WITHOUT multiplicity: the same row with two
  // DIFFERENT multiplicities is contradictory (kills a full-tuple-key mutant).
  assertThrowsReason(
    () => snap([group('row-a', 1), group('row-a', 2)]),
    'DUPLICATE_IDENTITY_GROUP',
    'same identity-content with differing multiplicity rejected',
  )

  // The snapshot-level bound is the SOLE authority: a per-group bound override is
  // rejected fail-closed, and a group multiplicity above the snapshot bound is
  // rejected even if a (forbidden) larger group bound is attempted.
  assertThrowsReason(
    () => computeSnapshotContentDigest([{ ...group('row-a', 1), multiplicityBound: 10 }], 16),
    'UNSUPPORTED_KIND',
    'per-group multiplicityBound override forbidden',
  )
  assertThrowsReason(
    () => computeSnapshotContentDigest([group('row-a', 2)], 1),
    'MULTIPLICITY_OUT_OF_BOUNDS',
    'group multiplicity above the snapshot bound rejected (no group-level escape)',
  )
  assertThrowsReason(
    () => computeSnapshotContentDigest([group('row-a', 1)]),
    'MULTIPLICITY_OUT_OF_BOUNDS',
    'missing snapshot bound fails closed',
  )

  // input array is not mutated by the internal sort
  const inputs = [g3, g1, g2]
  snap(inputs)
  assert.ok(inputs[0] === g3 && inputs[1] === g1 && inputs[2] === g2, 'caller array untouched')

  assertThrowsReason(() => computeSnapshotContentDigest('t', BOUND), 'UNSUPPORTED_KIND', 'non-array input')
  assertThrowsReason(() => computeSnapshotContentDigest([Buffer.from([0x01])], BOUND), 'UNSUPPORTED_KIND', 'raw buffer is not a group')
}

function digestShape() {
  const result = computeCanonicalRowDigest({ fieldOrder: ['k1'], row: { k1: 'row-a' } })
  assert.ok(Buffer.isBuffer(result.buffer), 'digest exposes a Buffer')
  assert.equal(result.buffer.length, 32, 'sha256 digest is 32 bytes')
  assert.equal(result.hex, result.buffer.toString('hex'), 'hex mirrors the buffer')
  assert.ok(Object.isFrozen(result), 'digest result is frozen')
  const snapshot = computeSnapshotContentDigest([
    { identityKeyClass: 'valid', identityKeyBytes: 'k', canonicalRowDigest: result.buffer, multiplicity: 1 },
  ], 4)
  assert.equal(snapshot.buffer.length, 32)
  assert.equal(snapshot.hex, snapshot.buffer.toString('hex'))
  assert.ok(Object.isFrozen(snapshot), 'snapshot result is frozen')
}

// Review-P2 hardening: mutation-proven killing pairs + exact-layout and golden
// byte pins. These exist because probe mutants (length-prefix dropped at row
// level; multiplicity re-encoded as varint) survived the original battery.
function reviewHardening() {
  // (P2-1) Cross-field splice collision routed THROUGH the string tag byte:
  // under a no-length-prefix mutant, ['k']{k:'vm\x05w'} encodes byte-identically
  // to ['k','m']{k:'v',m:'w'} ('k'+05+'vm'+05+'w'). The prefixes must separate them.
  const spliced = `vm${String.fromCharCode(5)}w`
  const collideA = computeCanonicalRowDigest({ fieldOrder: ['k'], row: { k: spliced } })
  const collideB = computeCanonicalRowDigest({ fieldOrder: ['k', 'm'], row: { k: 'v', m: 'w' } })
  assert.notEqual(collideA.hex, collideB.hex, 'length prefixes must defeat cross-field splice collisions')

  // (P2-2) Exact sort-tuple layout: classByte + len4(key) + key + len4(digest)
  // + digest + FIXED 4-byte big-endian multiplicity. Pins width and byte order.
  const digest = computeCanonicalRowDigest({ fieldOrder: ['k1'], row: { k1: 'row-a' } }).buffer
  const layout = encodeIdentitySortTuple({
    identityKeyClass: 'valid',
    identityKeyBytes: Buffer.from('k1', 'utf8'),
    canonicalRowDigest: digest,
    multiplicity: 3,
    multiplicityBound: 100,
  })
  assert.equal(layout.length, 1 + 4 + 2 + 4 + 32 + 4, 'tuple layout is fixed: class + len4+key + len4+digest + fixed4 multiplicity')
  assert.equal(layout[0], 0x01, 'valid class byte')
  assert.deepStrictEqual([...layout.subarray(1, 5)], [0, 0, 0, 2], 'key length prefix is 4-byte big-endian')
  assert.deepStrictEqual([...layout.subarray(layout.length - 4)], [0, 0, 0, 3], 'multiplicity is fixed 4-byte big-endian')
  const multWide = encodeIdentitySortTuple({
    identityKeyClass: 'valid',
    identityKeyBytes: Buffer.from('k1', 'utf8'),
    canonicalRowDigest: digest,
    multiplicity: 16909060,
    multiplicityBound: 20000000,
  })
  assert.equal(multWide.length, layout.length, 'multiplicity width never varies with its value (no varint)')
  assert.equal(multWide.subarray(multWide.length - 4).toString('hex'), '01020304', 'big-endian byte order pinned')

  // (P3) Snapshot-level per-tuple length prefix: two groups that would bare-
  // concat to the same bytes as one different group must stay distinct.
  const dA = computeCanonicalRowDigest({ fieldOrder: ['k'], row: { k: 'a' } }).buffer
  const dB = computeCanonicalRowDigest({ fieldOrder: ['k'], row: { k: 'b' } }).buffer
  const snapTwo = computeSnapshotContentDigest([
    { identityKeyClass: 'valid', identityKeyBytes: 'ka', canonicalRowDigest: dA, multiplicity: 1 },
    { identityKeyClass: 'valid', identityKeyBytes: 'kb', canonicalRowDigest: dB, multiplicity: 1 },
  ], 4)
  const snapOne = computeSnapshotContentDigest([
    { identityKeyClass: 'valid', identityKeyBytes: 'kakb', canonicalRowDigest: dA, multiplicity: 1 },
  ], 4)
  assert.notEqual(snapTwo.hex, snapOne.hex, 'per-tuple length prefixes must defeat snapshot concat collisions')

  // Golden byte vectors: any drift in tags, prefixes, decimal canon, NFC, or
  // hashing changes these constants — the frozen encoding's strongest pin.
  const golden = computeCanonicalRowDigest({
    fieldOrder: ['k1', 'k2', 'k3', 'k4', 'k5'],
    row: { k1: 'row-a', k2: 7, k3: { decimal: '1.10' }, k4: null, k5: true },
  })
  assert.equal(golden.hex, '5eb48f1710425c9d8ed3b441ccd7c2897bf42345056532992debd9c865f9b6f4', 'golden canonical row digest')
  const goldenTuple = encodeIdentitySortTuple({
    identityKeyClass: 'valid',
    identityKeyBytes: Buffer.from('k1', 'utf8'),
    canonicalRowDigest: golden.buffer,
    multiplicity: 3,
    multiplicityBound: 100,
  })
  assert.equal(
    goldenTuple.toString('hex'),
    '01000000026b31000000205eb48f1710425c9d8ed3b441ccd7c2897bf42345056532992debd9c865f9b6f400000003',
    'golden sort-tuple encoding',
  )
  // The golden snapshot is the SAME digest — the group encodes to goldenTuple
  // internally, so the corrective P2 API change preserves the frozen vector.
  assert.equal(
    computeSnapshotContentDigest([
      { identityKeyClass: 'valid', identityKeyBytes: Buffer.from('k1', 'utf8'), canonicalRowDigest: golden.buffer, multiplicity: 3 },
    ], 100).hex,
    '95c50cc9a3f843f3d507fde4da8451831994030818cf9a612d1eae58af9da018',
    'golden snapshot content digest',
  )
}

// Deep-review round 2 (owner focus 2/6): kill the independently-survived
// mutants (interior-zero strip, boolean false byte, fieldId NFC, multiplicity
// upper edge) and pin the P1 fix (ill-formed UTF-16 rejection) plus rulings
// (empty-snapshot legality, digest width).
function deepReviewRound() {
  const fieldOrder = ['k1']
  // P1: lone surrogates are REJECTED, never folded into U+FFFD collisions.
  assertThrowsReason(() => digestHex(fieldOrder, { k1: '\uD800' }), 'STRING_ILL_FORMED', 'lone high surrogate value')
  assertThrowsReason(() => digestHex(fieldOrder, { k1: '\uDFFF' }), 'STRING_ILL_FORMED', 'lone low surrogate value')
  assertThrowsReason(() => digestHex(['\uD800'], { '\uD800': 't' }), 'STRING_ILL_FORMED', 'lone surrogate field id')
  // U+FFFD itself is a LEGAL character and digests normally.
  assert.equal(typeof digestHex(fieldOrder, { k1: '\uFFFD' }), 'string', 'U+FFFD is a legal value')
  // Well-formed astral pairs stay legal.
  assert.equal(typeof digestHex(fieldOrder, { k1: '\uD83D\uDE00' }), 'string', 'proper surrogate pair legal')
  const digest32 = crypto.createHash('sha256').update('drr').digest()
  assertThrowsReason(
    () => encodeIdentitySortTuple({ identityKeyClass: 'valid', identityKeyBytes: '\uD800', canonicalRowDigest: digest32, multiplicity: 1, multiplicityBound: 4 }),
    'STRING_ILL_FORMED',
    'lone surrogate string identity key',
  )

  // fieldId NFC (survived M4): composed and decomposed ids are ONE logical id.
  const composed = String.fromCharCode(0x00e9)
  const decomposed = 'e' + String.fromCharCode(0x0301)
  assert.notEqual(composed, decomposed, 'fixture sanity: raw forms differ')
  assert.equal(
    digestHex([composed], { [composed]: 'v' }),
    digestHex([decomposed], { [decomposed]: 'v' }),
    'field ids are NFC-normalized before encoding',
  )
  assertThrowsReason(
    () => computeCanonicalRowDigest({ fieldOrder: [composed, decomposed], row: { [composed]: 'v', [decomposed]: 'v' } }),
    'FIELD_ORDER_MISMATCH',
    'NFC-equal ids are duplicates',
  )
  // String identity keys are NFC-normalized on the convenience path too.
  const tupleComposedKey = encodeIdentitySortTuple({ identityKeyClass: 'valid', identityKeyBytes: composed, canonicalRowDigest: digest32, multiplicity: 1, multiplicityBound: 4 })
  const tupleDecomposedKey = encodeIdentitySortTuple({ identityKeyClass: 'valid', identityKeyBytes: decomposed, canonicalRowDigest: digest32, multiplicity: 1, multiplicityBound: 4 })
  assert.ok(tupleComposedKey.equals(tupleDecomposedKey), 'string keys NFC-normalize identically')
  // Buffer keys are the caller-owned BYTE authority: raw NFD bytes stay raw.
  const tupleNfdBufferKey = encodeIdentitySortTuple({ identityKeyClass: 'valid', identityKeyBytes: Buffer.from(decomposed, 'utf8'), canonicalRowDigest: digest32, multiplicity: 1, multiplicityBound: 4 })
  assert.ok(!tupleNfdBufferKey.equals(tupleComposedKey), 'Buffer keys bypass normalization by design')

  // Interior zero (survived M1): leading-zero strip must be anchored.
  assert.equal(normalizeDecimalText('105'), '105')
  assert.equal(normalizeDecimalText('1050'), '1050')
  assert.equal(normalizeDecimalText('10.05'), '10.05')
  assert.notEqual(
    digestHex(fieldOrder, { k1: { decimal: '105' } }),
    digestHex(fieldOrder, { k1: { decimal: '15' } }),
    'interior zeros are value-bearing',
  )

  // Boolean false byte (survived M2).
  assert.notEqual(digestHex(fieldOrder, { k1: false }), digestHex(fieldOrder, { k1: true }), 'false != true')
  assert.notEqual(digestHex(fieldOrder, { k1: false }), digestHex(fieldOrder, { k1: 0 }), 'false != integer 0')

  // Multiplicity bound upper edge (survived M3): 2^32 bound is rejected TYPED.
  assertThrowsReason(
    () => encodeIdentitySortTuple({ identityKeyClass: 'valid', identityKeyBytes: 'k', canonicalRowDigest: digest32, multiplicity: 1, multiplicityBound: 2 ** 32 }),
    'MULTIPLICITY_OUT_OF_BOUNDS',
    'bound above 2^32-1 rejected with the closed reason',
  )

  // Empty snapshot is LEGAL WITH a valid bound (charter §8.2-4 positive control):
  // sha256 of zero tuples. Corrective round-3 P2: the bound is validated BEFORE
  // the loop, so an empty snapshot cannot bypass it.
  assert.equal(
    computeSnapshotContentDigest([], 16).hex,
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'empty snapshot digest pinned (with a valid bound)',
  )
  // Empty snapshot with NO / invalid bound fails closed.
  assertThrowsReason(() => computeSnapshotContentDigest([]), 'MULTIPLICITY_OUT_OF_BOUNDS', 'empty snapshot with no bound fails closed')
  assertThrowsReason(() => computeSnapshotContentDigest([], 0), 'MULTIPLICITY_OUT_OF_BOUNDS', 'empty snapshot with zero bound fails closed')
  assertThrowsReason(() => computeSnapshotContentDigest([], 2 ** 32), 'MULTIPLICITY_OUT_OF_BOUNDS', 'empty snapshot with over-range bound fails closed')

  // Golden 2: interior-zero decimal + boolean false + composed unicode.
  const golden2 = computeCanonicalRowDigest({
    fieldOrder: ['a', 'b', 'c', 'd'],
    row: { a: 105, b: { decimal: '10.50' }, c: false, d: 'Caf' + composed },
  })
  assert.equal(golden2.hex, '35785be424f326d567759cbf530f0c0a5cb85091ada133ec710833021e872296', 'golden 2 canonical row digest')
}

// Round-4 (post-APPROVE verify pass): the CODEC export surface must not leak a
// live membership Set either — same poisoning class the templates round-1 fix
// closed. A reachable mutable Set flips a validator from reject to accept, and
// a poisoned identityKeyClass would encode class byte 0x00, colliding with the
// identity_invalid domain separator.
function round4CodecSurface() {
  const mod = require(MODULE_PATH)
  // 1. No *_SET key and no live Set instance anywhere on the export surface.
  for (const [scopeName, scope] of [['module', mod], ['__internals', mod.__internals]]) {
    for (const [key, value] of Object.entries(scope)) {
      assert.ok(!key.includes('_SET'), `${scopeName}.${key}: no exported Set-mirror names`)
      assert.ok(!(value instanceof Set), `${scopeName}.${key}: no live Set instances exported`)
    }
  }
  // 2. Poisoning attempt is a no-op: the Set is unreachable, and an unknown
  //    identityKeyClass still fails closed afterwards (positive control pair).
  const evil = { identityKeyClass: 'evil', identityKeyBytes: Buffer.from('k'), canonicalRowDigest: Buffer.alloc(32), multiplicity: 1, multiplicityBound: 16 }
  assertThrowsReason(() => encodeIdentitySortTuple(evil), 'UNSUPPORTED_KIND', 'unknown identityKeyClass rejected before poisoning attempt')
  __internals.MR_IDENTITY_KEY_CLASS_SET?.add?.('evil') // unreachable: optional-chain no-op
  assertThrowsReason(() => encodeIdentitySortTuple(evil), 'UNSUPPORTED_KIND', 'unknown identityKeyClass STILL rejected after poisoning attempt')
  // Positive control: the two chartered classes still encode.
  assert.equal(encodeIdentitySortTuple({ identityKeyClass: 'valid', identityKeyBytes: Buffer.from('k'), canonicalRowDigest: Buffer.alloc(32), multiplicity: 1, multiplicityBound: 16 })[0], MR_IDENTITY_KEY_CLASS_BYTES.valid, 'valid class still encodes')
  assert.equal(encodeIdentitySortTuple({ identityKeyClass: 'identity_invalid', identityKeyBytes: Buffer.alloc(0), canonicalRowDigest: Buffer.alloc(32), multiplicity: 1, multiplicityBound: 16 })[0], MR_IDENTITY_KEY_CLASS_BYTES.identity_invalid, 'identity_invalid class still encodes')
  // 3. Round-4 P3: error details carry sanitized values only — a non-integer
  //    bound/multiplicity never round-trips into the error surface verbatim.
  for (const [label, input, field] of [
    ['non-integer bound sanitized', { ...evil, identityKeyClass: 'valid', multiplicityBound: '9' }, 'multiplicityBound'],
    ['non-integer multiplicity sanitized', { ...evil, identityKeyClass: 'valid', multiplicity: 'x' }, 'multiplicity'],
  ]) {
    let thrown = null
    try { encodeIdentitySortTuple(input) } catch (error) { thrown = error }
    assert.ok(thrown && thrown.reason === 'MULTIPLICITY_OUT_OF_BOUNDS', `${label}: fails closed`)
    assert.equal(thrown.details[field], null, `${label}: details.${field} is null, not the raw value`)
  }
}

function main() {
  structuralIndependence()
  frozenVocabularies()
  fieldOrderAuthority()
  typeTagSeparation()
  decimalNormalization()
  unicodeRules()
  lengthPrefixAntiCollision()
  sortTupleContract()
  snapshotContentDigestContract()
  digestShape()
  reviewHardening()
  deepReviewRound()
  round4CodecSurface()
}

main()
console.log('material-reconciliation-row-digest.test.cjs OK')
