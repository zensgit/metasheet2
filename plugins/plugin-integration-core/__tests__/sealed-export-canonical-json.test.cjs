'use strict'

// Sealed-export S1 — canonical JSON codec battery. Plain node test, hermetic:
// no network, no clock, no randomness, no filesystem beyond the vectors JSON.
//
// EVERY assertion here is derived from §6.3 of the ratified S0 baseline
// (docs/development/stock-prep-sealed-export-manifest-capability-spike-20260727.md)
// plus the codec's own frozen rule text, NOT from reading canonical-json.cjs and
// writing down what it happens to do.
//
// §6.3 requires: a versioned cross-language canonical byte form; RFC 8785/JCS as the
// named candidate; one frozen codec with shared golden vectors.

const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')

const codec = require(path.join(__dirname, '..', 'lib', 'sealed-export', 'canonical-json.cjs'))
const harness = require(path.join(__dirname, '..', 'lib', 'sealed-export', 'compliance-harness.cjs'))

const VECTORS_PATH = path.join(
  __dirname, '..', 'lib', 'sealed-export', 'vectors', 'sealed-export-canonical-vectors.json',
)
const vectorSet = JSON.parse(fs.readFileSync(VECTORS_PATH, 'utf8'))

function accepted(value, label) {
  const result = codec.tryCanonicalJson(value)
  assert.equal(result.ok, true, 'expected ACCEPT: ' + label)
  return result
}

function refused(value, expectedViolation, label) {
  const result = codec.tryCanonicalJson(value)
  assert.equal(result.ok, false, 'expected REFUSE: ' + label)
  assert.equal(result.violation, expectedViolation, 'violation for: ' + label)
  // Closed means REFUSED, not dropped: a refusal carries no partial output that a
  // careless caller could mistake for a canonical form.
  assert.equal(result.text, undefined, 'refusal must not carry text: ' + label)
  assert.equal(result.bytes, undefined, 'refusal must not carry bytes: ' + label)
}

// ---------------------------------------------------------------------------
// 1. Vector-driven conformance, pinned by DISAGREEMENT.
// ---------------------------------------------------------------------------
function vectorConformance() {
  const summary = harness.runSealedExportComplianceHarness({
    vectorSet,
    sources: [],
    declaredReasons: [],
    allowedThrowModule: null,
  })
  assert.deepEqual(summary.findings, [], 'vector conformance findings must be empty')
  assert.equal(summary.ok, true)
  assert.ok(summary.counts.vectors >= 12, 'vector count')
  assert.ok(summary.counts.nearMisses >= 20, 'near-miss count')

  // Each near-miss is pinned by HOW it disagrees — never merely "it failed".
  // A disposition of CANONICAL anywhere would mean a near-miss was accepted.
  let differentForm = 0
  let refusedParse = 0
  let refusedDomain = 0
  for (let index = 0; index < summary.dispositions.length; index += 1) {
    const entry = summary.dispositions[index]
    assert.notEqual(entry.disposition, harness.DISPOSITION_CANONICAL, 'near-miss accepted: ' + entry.id)
    if (entry.disposition === harness.DISPOSITION_DIFFERENT_CANONICAL_FORM) differentForm += 1
    if (entry.disposition === harness.DISPOSITION_REFUSED_PARSE) refusedParse += 1
    if (entry.disposition === harness.DISPOSITION_REFUSED_DOMAIN) refusedDomain += 1
  }
  // POSITIVE CONTROL for the disposition machinery: all three outcomes must actually
  // occur. If every vector landed in one bucket, the classifier would be proving
  // nothing (an "everything is refused" suite).
  assert.ok(differentForm > 0, 'some near-miss must normalize to a different canonical form')
  assert.ok(refusedParse > 0, 'some near-miss must be refused at parse')
  assert.ok(refusedDomain > 0, 'some near-miss must be refused by the domain')

  // The five near-miss families #4636 names must each be covered.
  const coverage = summary.nearMissCoverage
  const required = ['KEY_ORDER', 'UNICODE_FORM', 'NUMBER_FORM', 'TRAILING_ZERO', 'WHITESPACE']
  for (let index = 0; index < required.length; index += 1) {
    assert.ok(coverage[required[index]] > 0, 'near-miss family uncovered: ' + required[index])
  }
}

// ---------------------------------------------------------------------------
// 2. The six frozen rules, each exercised with a positive control.
// ---------------------------------------------------------------------------
function ruleKeyOrdering() {
  // Rule 2: keys sorted ascending by UTF-16 code unit.
  const a = accepted({ b: 1, a: 2, C: 3, _z: 4 }, 'unsorted input')
  const b = accepted({ C: 3, _z: 4, a: 2, b: 1 }, 'sorted input')
  assert.equal(a.text, b.text, 'insertion order must not change canonical bytes')
  assert.equal(a.text, '{"C":3,"_z":4,"a":2,"b":1}')
  // Case is significant, and uppercase sorts before lowercase in UTF-16.
  assert.ok(a.text.indexOf('"C"') < a.text.indexOf('"a"'))
}

function ruleNumbers() {
  // Rule 4: integers only, no exponent, no fraction, no sign on zero.
  assert.equal(accepted(0, 'zero').text, '0')
  assert.equal(accepted(-0, 'negative zero').text, '0', '-0 must normalize to 0')
  assert.equal(accepted(100, 'hundred').text, '100')
  assert.equal(accepted(Number.MAX_SAFE_INTEGER, 'max safe').text, '9007199254740991')
  assert.equal(accepted(-1, 'negative').text, '-1')
  refused(1.5, 'NON_INTEGER_NUMBER', 'fraction')
  refused(Number.MAX_SAFE_INTEGER + 2, 'NUMBER_OUT_OF_SAFE_RANGE', 'above safe range')
  refused(Infinity, 'NON_FINITE_NUMBER', 'infinity')
  refused(NaN, 'NON_FINITE_NUMBER', 'NaN')
}

function ruleStringsNoNormalization() {
  // Rule 3: NO Unicode normalization — NFC and NFD are DIFFERENT values.
  const nfc = accepted({ s: 'é' }, 'NFC')
  const nfd = accepted({ s: 'é' }, 'NFD')
  assert.notEqual(nfc.text, nfd.text, 'NFC and NFD must NOT be conflated')
  // JCS/ECMA-262 minimal escaping.
  assert.equal(accepted({ s: 'a"b\\c\nd\te\u0001f/g\u001f' }, 'escapes').text,
    '{"s":"a\\"b\\\\c\\nd\\te\\u0001f/g\\u001f"}')
  // A lone surrogate is not a well-formed string and is refused, not replaced.
  refused({ s: '\ud800' }, 'LONE_SURROGATE', 'lone high surrogate')
  refused({ s: '\udc00' }, 'LONE_SURROGATE', 'lone low surrogate')
  refused({ ['\ud800']: 1 }, 'LONE_SURROGATE', 'lone surrogate in a KEY')
  accepted({ s: '😀' }, 'well-formed surrogate pair') // positive control
}

function ruleDomainClosedMeansRefused() {
  // Rule 5: the domain is null | boolean | integer | string | dense array | plain
  // object. Everything else is REFUSED — never coerced, never dropped.
  accepted({ ok: true, n: null, list: [1, 2], nested: { a: 'b' } }, 'in-domain control')

  refused(undefined, 'UNSUPPORTED_TYPE', 'undefined')
  refused(() => 1, 'UNSUPPORTED_TYPE', 'function')
  refused(10n, 'UNSUPPORTED_TYPE', 'bigint')
  refused(Symbol('s'), 'UNSUPPORTED_TYPE', 'symbol')
  refused(new Date(0), 'EXOTIC_OBJECT', 'Date')
  refused(new Map(), 'EXOTIC_OBJECT', 'Map')
  refused(new (class X { constructor() { this.a = 1 } })(), 'EXOTIC_OBJECT', 'class instance')
  refused(Object.create({ inherited: 1 }), 'EXOTIC_OBJECT', 'non-null prototype')

  // An unknown/undeclared member of an object must fail the OBJECT, not vanish.
  const withSymbol = { a: 1 }
  withSymbol[Symbol('hidden')] = 2
  refused(withSymbol, 'EXOTIC_OBJECT', 'symbol key must refuse the whole object')
  assert.equal(accepted({ a: 1 }, 'same object without the symbol key').text, '{"a":1}',
    'positive control: the symbol key, not the shape, is what refused it')

  const accessor = {}
  Object.defineProperty(accessor, 'a', { get: () => 1, enumerable: true, configurable: true })
  refused(accessor, 'EXOTIC_OBJECT', 'accessor property')

  const nonEnumerable = {}
  Object.defineProperty(nonEnumerable, 'a', { value: 1, enumerable: false })
  refused(nonEnumerable, 'EXOTIC_OBJECT', 'non-enumerable property')

  // Sparse and exotic arrays.
  const sparse = [1, 2, 3]
  delete sparse[1]
  refused(sparse, 'SPARSE_OR_EXOTIC_ARRAY', 'sparse array')
  const tagged = [1, 2]
  tagged.extra = 3
  refused(tagged, 'SPARSE_OR_EXOTIC_ARRAY', 'array with an extra own property')
  accepted([1, 2], 'dense array positive control')

  // A proxy makes the [[Get]] path and the descriptor path disagree.
  refused(new Proxy({ a: 1 }, {}), 'EXOTIC_OBJECT', 'proxy object')
  refused(new Proxy([1], {}), 'SPARSE_OR_EXOTIC_ARRAY', 'proxy array')

  // Structural limits.
  let deep = 1
  for (let index = 0; index < codec.MAX_CANONICAL_DEPTH + 2; index += 1) deep = [deep]
  refused(deep, 'DEPTH_LIMIT_EXCEEDED', 'over-deep nesting')
  refused({ s: 'x'.repeat(codec.MAX_CANONICAL_BYTES + 16) }, 'SIZE_LIMIT_EXCEEDED', 'over-size')
}

function ruleCanonicalityIsAPredicateOnBytes() {
  // Rule 6: isCanonicalJsonText(bytes) <=> serialize(parse(bytes)) === bytes.
  assert.equal(codec.isCanonicalJsonText('{"a":1}'), true, 'positive control')
  assert.equal(codec.isCanonicalJsonText(Buffer.from('{"a":1}', 'utf8')), true, 'bytes positive control')

  // Whitespace, key order and duplicate keys are all refused by the ONE rule.
  assert.equal(codec.isCanonicalJsonText('{ "a":1}'), false, 'leading space')
  assert.equal(codec.isCanonicalJsonText('{"a": 1}'), false, 'space after colon')
  assert.equal(codec.isCanonicalJsonText('{"a":1} '), false, 'trailing whitespace')
  assert.equal(codec.isCanonicalJsonText('{"b":1,"a":2}'), false, 'wrong key order')
  assert.equal(codec.isCanonicalJsonText('{"a":1,"a":2}'), false, 'duplicate key')
  assert.equal(codec.isCanonicalJsonText('{"n":1.0}'), false, 'trailing zero')
  assert.equal(codec.isCanonicalJsonText('{"n":1e2}'), false, 'exponent')
  assert.equal(codec.isCanonicalJsonText('{"n":-0}'), false, 'signed zero')

  // A BOM must NOT be silently stripped: the bytes are not canonical.
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}', 'utf8')])
  assert.equal(codec.isCanonicalJsonText(bom), false, 'BOM-prefixed bytes')

  // Invalid UTF-8 must fail closed, not decode to replacement characters.
  assert.equal(codec.isCanonicalJsonText(Buffer.from([0x7b, 0xff, 0x7d])), false, 'invalid UTF-8')

  // A decode/parse that THREW is not a decode that came back clean.
  assert.equal(codec.isCanonicalJsonText('{'), false, 'unterminated')
  assert.equal(codec.isCanonicalJsonText(''), false, 'empty')
  assert.equal(codec.isCanonicalJsonText(null), false, 'null input')
  assert.equal(codec.isCanonicalJsonText(42), false, 'non-text input')
}

function decodeIsTotalAndFailsClosed() {
  // decodeCanonicalCandidate never throws and never returns a plausible empty text.
  const bad = codec.decodeCanonicalCandidate(Buffer.from([0xff, 0xfe]))
  assert.equal(bad.ok, false)
  assert.equal(bad.text, undefined, 'a failed decode must not degrade to a text')
  assert.equal(codec.decodeCanonicalCandidate({}).ok, false)
  assert.equal(codec.decodeCanonicalCandidate('{"a":1}').ok, true) // positive control
}

function freezeCanonicalOwnsItsClone() {
  const source = { a: [1, { b: 'c' }], z: -0 }
  const frozen = codec.tryFreezeCanonical(source)
  assert.equal(frozen.ok, true)
  assert.ok(Object.isFrozen(frozen.value) && Object.isFrozen(frozen.value.a))
  assert.equal(Object.is(frozen.value.z, -0), false, '-0 must be normalized in the clone')
  source.a.push('mutated')
  assert.equal(frozen.value.a.length, 2, 'clone must not alias the caller structure')

  // A legal own JSON key named __proto__ must stay a KEY, not become a prototype.
  const protoKey = JSON.parse('{"__proto__":{"polluted":true}}')
  const cloned = codec.tryFreezeCanonical(protoKey)
  assert.equal(cloned.ok, true)
  assert.equal(Object.getPrototypeOf(cloned.value), Object.prototype, 'prototype must be untouched')
  assert.equal(Object.prototype.hasOwnProperty.call(cloned.value, '__proto__'), true, '__proto__ kept as a key')
  assert.equal({}.polluted, undefined, 'no global prototype pollution')

  const refusedClone = codec.tryFreezeCanonical({ bad: undefined })
  assert.equal(refusedClone.ok, false)
  assert.equal(refusedClone.value, undefined, 'a refused clone must not carry a value')
}

function main() {
  vectorConformance()
  ruleKeyOrdering()
  ruleNumbers()
  ruleStringsNoNormalization()
  ruleDomainClosedMeansRefused()
  ruleCanonicalityIsAPredicateOnBytes()
  decodeIsTotalAndFailsClosed()
  freezeCanonicalOwnsItsClone()
  console.log('sealed-export-canonical-json.test.cjs OK')
}

main()
