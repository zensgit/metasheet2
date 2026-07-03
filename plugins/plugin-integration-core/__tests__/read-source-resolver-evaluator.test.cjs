'use strict'

// resolver_lookup R1 — pure multiplicity-rule evaluator. No network, no persistence, no adapter.

const assert = require('node:assert/strict')
const path = require('node:path')

const { evaluateResolver, __internals } = require(path.join(__dirname, '..', 'lib', 'read-source-resolver-evaluator.cjs'))

// Base normalized resolver config; override per rule.
function cfg(overrides = {}) {
  return {
    version: 1,
    systemId: 'sys_1',
    requiredKind: 'erp:k3-wise-webapi',
    object: 'material',
    mode: 'resolver_lookup',
    readPath: '/K3API/Material/GetList',
    readMethod: 'POST',
    operations: ['read'],
    keyField: 'FNumber',
    containerPaths: ['Data.Rows'],
    resolverRule: 'exactly_one',
    fieldMap: [{ source: 'FItemID', target: 'internal_id' }],
    ...overrides,
  }
}
const wrap = (rows) => ({ Data: { Rows: rows } })

// Evidence values-free leak scan: none of the sentinels may appear in JSON.stringify(evidence).
function assertEvidenceValuesFree(evidence, sentinels) {
  const text = JSON.stringify(evidence)
  for (const s of sentinels) {
    if (typeof s === 'string' && s.length > 0) assert.ok(!text.includes(s), `evidence must not leak ${s}`)
  }
}

// ── exactly_one ────────────────────────────────────────────────────────────
function testExactlyOne() {
  const c = cfg()
  // PASS: exactly one candidate → resolve the one target.
  const ok = evaluateResolver(c, wrap([{ FNumber: 'MAT-001', FItemID: 4242 }]))
  assert.equal(ok.evidence.ok, true)
  assert.equal(ok.evidence.rule, 'exactly_one')
  assert.equal(ok.evidence.candidateCount, 1)
  assert.equal(ok.evidence.resolved, true)
  assert.deepEqual(ok.data, { resolver: { target: 'internal_id', value: 4242 } })
  // data carries the value; evidence must NOT leak the value, the material number, or the fieldMap names.
  assertEvidenceValuesFree(ok.evidence, ['MAT-001', '4242', 'FItemID', 'internal_id', 'FNumber'])

  // 0 → NO_MATCH
  const none = evaluateResolver(c, wrap([]))
  assert.equal(none.evidence.ok, false)
  assert.equal(none.evidence.errorCode, 'READ_SOURCE_RESOLVER_NO_MATCH')
  assert.equal(none.evidence.errorType, 'ReadSourceResolverError')
  assert.equal(none.data, null)

  // >1 → AMBIGUOUS (NOT resolved to the first)
  const many = evaluateResolver(c, wrap([{ FNumber: 'MAT-A', FItemID: 7001 }, { FNumber: 'MAT-B', FItemID: 7002 }]))
  assert.equal(many.evidence.errorCode, 'READ_SOURCE_RESOLVER_AMBIGUOUS')
  assert.equal(many.evidence.ambiguous, true)
  assert.equal(many.evidence.candidateCount, 2)
  assert.equal(many.data, null)
  assertEvidenceValuesFree(many.evidence, ['MAT-A', 'MAT-B', 'FItemID', '7001', '7002'])
}

// ── first_when_sorted ──────────────────────────────────────────────────────
function testFirstWhenSorted() {
  const c = cfg({ resolverRule: 'first_when_sorted', multiplicityRuleField: 'FVersion', resolverSortDirection: 'desc' })
  // PASS: highest FVersion wins (desc).
  const ok = evaluateResolver(c, wrap([
    { FVersion: 3, FItemID: 30 },
    { FVersion: 5, FItemID: 50 },
    { FVersion: 1, FItemID: 10 },
  ]))
  assert.equal(ok.evidence.ok, true)
  assert.equal(ok.evidence.rule, 'first_when_sorted')
  assert.deepEqual(ok.data, { resolver: { target: 'internal_id', value: 50 } })

  // asc direction picks the lowest.
  const asc = evaluateResolver(cfg({ resolverRule: 'first_when_sorted', multiplicityRuleField: 'FVersion', resolverSortDirection: 'asc' }),
    wrap([{ FVersion: 3, FItemID: 30 }, { FVersion: 1, FItemID: 10 }]))
  assert.deepEqual(asc.data, { resolver: { target: 'internal_id', value: 10 } })

  // string sort works
  const strs = evaluateResolver(cfg({ resolverRule: 'first_when_sorted', multiplicityRuleField: 'FName', resolverSortDirection: 'asc' }),
    wrap([{ FName: 'beta', FItemID: 2 }, { FName: 'alpha', FItemID: 1 }]))
  assert.deepEqual(strs.data, { resolver: { target: 'internal_id', value: 1 } })

  // FAIL: sort field MISSING on a candidate → FIELD_MISSING (fail-first: a naive sort would still pick one).
  const missing = evaluateResolver(c, wrap([{ FVersion: 5, FItemID: 50 }, { FItemID: 60 }]))
  assert.equal(missing.evidence.errorCode, 'READ_SOURCE_RESOLVER_FIELD_MISSING')
  assert.equal(missing.data, null)

  // FAIL: mixed types across the sort field → SHAPE_MISMATCH
  const mixed = evaluateResolver(c, wrap([{ FVersion: 5, FItemID: 50 }, { FVersion: 'v2', FItemID: 60 }]))
  assert.equal(mixed.evidence.errorCode, 'READ_SOURCE_RESOLVER_SHAPE_MISMATCH')

  // FAIL: TIE at the winning position → AMBIGUOUS (fail-first: a naive first-of-sorted would resolve a winner)
  const tie = evaluateResolver(c, wrap([{ FVersion: 5, FItemID: 50 }, { FVersion: 5, FItemID: 51 }, { FVersion: 2, FItemID: 20 }]))
  assert.equal(tie.evidence.errorCode, 'READ_SOURCE_RESOLVER_AMBIGUOUS')
  assert.equal(tie.evidence.ambiguous, true)
  assert.equal(tie.data, null)

  // a NON-winning tie is fine (unique top).
  const lowerTie = evaluateResolver(c, wrap([{ FVersion: 9, FItemID: 90 }, { FVersion: 2, FItemID: 20 }, { FVersion: 2, FItemID: 21 }]))
  assert.deepEqual(lowerTie.data, { resolver: { target: 'internal_id', value: 90 } })
}

// ── field_equals ───────────────────────────────────────────────────────────
function testFieldEquals() {
  const c = cfg({ resolverRule: 'field_equals', multiplicityRuleField: 'FIsCurrent', resolverDiscriminatorValue: 'Y' })
  // PASS: exactly one candidate with FIsCurrent === 'Y'
  const ok = evaluateResolver(c, wrap([
    { FIsCurrent: 'N', FItemID: 1 },
    { FIsCurrent: 'Y', FItemID: 2 },
    { FIsCurrent: 'N', FItemID: 3 },
  ]))
  assert.equal(ok.evidence.ok, true)
  assert.equal(ok.evidence.matchedCount, 1)
  assert.deepEqual(ok.data, { resolver: { target: 'internal_id', value: 2 } })

  // numeric flag matched via string form ('1' token vs 1 value)
  const numFlag = evaluateResolver(cfg({ resolverRule: 'field_equals', multiplicityRuleField: 'FStatus', resolverDiscriminatorValue: '1' }),
    wrap([{ FStatus: 0, FItemID: 9 }, { FStatus: 1, FItemID: 8 }]))
  assert.deepEqual(numFlag.data, { resolver: { target: 'internal_id', value: 8 } })

  // 0 matches → NO_MATCH
  const none = evaluateResolver(c, wrap([{ FIsCurrent: 'N', FItemID: 1 }]))
  assert.equal(none.evidence.errorCode, 'READ_SOURCE_RESOLVER_NO_MATCH')
  assert.equal(none.evidence.matchedCount, 0)

  // >1 matches → AMBIGUOUS
  const many = evaluateResolver(c, wrap([{ FIsCurrent: 'Y', FItemID: 8001 }, { FIsCurrent: 'Y', FItemID: 8002 }]))
  assert.equal(many.evidence.errorCode, 'READ_SOURCE_RESOLVER_AMBIGUOUS')
  assert.equal(many.evidence.matchedCount, 2)
  assertEvidenceValuesFree(many.evidence, ['FIsCurrent', 'FItemID', '8001', '8002'])
}

// ── container shape rules (all rules) ────────────────────────────────────────
function testContainerShapeRules() {
  const c = cfg()
  // container path unresolved → CONTAINER_NOT_FOUND
  const notFound = evaluateResolver(cfg({ containerPaths: ['Data.Missing'] }), wrap([{ FItemID: 1 }]))
  assert.equal(notFound.evidence.errorCode, 'READ_SOURCE_RESOLVER_CONTAINER_NOT_FOUND')
  assert.equal(notFound.evidence.containerLocated, false)

  // located but a scalar (not an array) → SHAPE_MISMATCH
  const scalar = evaluateResolver(c, { Data: { Rows: 'not-an-array' } })
  assert.equal(scalar.evidence.errorCode, 'READ_SOURCE_RESOLVER_SHAPE_MISMATCH')
  assert.equal(scalar.evidence.containerLocated, true)

  // array with a non-plain-object row → SHAPE_MISMATCH
  const scalarRow = evaluateResolver(c, wrap([{ FItemID: 1 }, 'oops']))
  assert.equal(scalarRow.evidence.errorCode, 'READ_SOURCE_RESOLVER_SHAPE_MISMATCH')

  // array with a nested-array row → SHAPE_MISMATCH
  const nested = evaluateResolver(c, wrap([[{ FItemID: 1 }]]))
  assert.equal(nested.evidence.errorCode, 'READ_SOURCE_RESOLVER_SHAPE_MISMATCH')

  // winning row missing the fieldMap source → FIELD_MISSING (not a fail-soft null)
  const noTarget = evaluateResolver(c, wrap([{ FNumber: 'MAT-001' }]))
  assert.equal(noTarget.evidence.errorCode, 'READ_SOURCE_RESOLVER_FIELD_MISSING')
  assert.equal(noTarget.data, null)

  // blank (whitespace) resolved output → FIELD_MISSING
  const blank = evaluateResolver(c, wrap([{ FItemID: '   ' }]))
  assert.equal(blank.evidence.errorCode, 'READ_SOURCE_RESOLVER_FIELD_MISSING')

  // prototype-key source never resolves → treated as missing, FIELD_MISSING (no prototype pollution)
  const proto = evaluateResolver(cfg({ fieldMap: [{ source: 'constructor', target: 'internal_id' }] }), wrap([{ FItemID: 1 }]))
  assert.equal(proto.evidence.errorCode, 'READ_SOURCE_RESOLVER_FIELD_MISSING')
}

// ── cap reached (fail-first: a naive impl would resolve/ambiguate a truncated window) ────────────────────
function testCapReached() {
  const c = cfg()
  // exactly_one with candidateCount >= rowCap → CAP_REACHED (cannot prove uniqueness on a truncated set)
  const rows = Array.from({ length: 3 }, (_, i) => ({ FItemID: i }))
  const capped = evaluateResolver(c, wrap(rows), { rowCap: 3 })
  assert.equal(capped.evidence.errorCode, 'READ_SOURCE_RESOLVER_CAP_REACHED')
  assert.equal(capped.evidence.capReached, true)
  assert.equal(capped.evidence.candidateCount, 3)
  assert.equal(capped.data, null)

  // first_when_sorted at cap also fails closed (can't prove first-in-total-order on a truncated window)
  const fws = evaluateResolver(cfg({ resolverRule: 'first_when_sorted', multiplicityRuleField: 'FVersion', resolverSortDirection: 'desc' }),
    wrap([{ FVersion: 9, FItemID: 1 }, { FVersion: 8, FItemID: 2 }, { FVersion: 7, FItemID: 3 }]), { rowCap: 3 })
  assert.equal(fws.evidence.errorCode, 'READ_SOURCE_RESOLVER_CAP_REACHED')

  // below the cap → normal evaluation (exactly_one resolves)
  const below = evaluateResolver(c, wrap([{ FItemID: 42 }]), { rowCap: 3 })
  assert.equal(below.evidence.ok, true)
  assert.deepEqual(below.data, { resolver: { target: 'internal_id', value: 42 } })
}

// ── rule guards ──────────────────────────────────────────────────────────────
function testRuleGuards() {
  // unknown rule → RULE_NOT_SUPPORTED (defensive; config validator also rejects)
  const bad = evaluateResolver(cfg({ resolverRule: 'take_the_first' }), wrap([{ FItemID: 1 }]))
  assert.equal(bad.evidence.errorCode, 'READ_SOURCE_RESOLVER_RULE_NOT_SUPPORTED')
  // fieldMap not exactly one target → RULE_INVALID
  const twoTargets = evaluateResolver(cfg({ fieldMap: [{ source: 'A', target: 'a' }, { source: 'B', target: 'b' }] }), wrap([{ FItemID: 1 }]))
  assert.equal(twoTargets.evidence.errorCode, 'READ_SOURCE_RESOLVER_RULE_INVALID')
}

// ── internals ────────────────────────────────────────────────────────────────
function testInternals() {
  assert.deepEqual(__internals.walkOwnPath({ a: { b: 5 } }, 'a.b'), { resolved: true, value: 5 })
  assert.deepEqual(__internals.walkOwnPath({}, 'constructor'), { resolved: false, value: null })
  assert.deepEqual(__internals.classifyContainerShape([1, 2]), { type: 'array', arrayLength: 2 })
  assert.equal(__internals.sortValueType(3), 'number')
  assert.equal(__internals.sortValueType('x'), 'string')
  assert.equal(__internals.sortValueType(true), null)
  assert.equal(__internals.sortValueType(NaN), null)
  assert.equal(__internals.isBlankResolved('  '), true)
  assert.equal(__internals.isBlankResolved(0), false)
}

testExactlyOne()
testFirstWhenSorted()
testFieldEquals()
testContainerShapeRules()
testCapReached()
testRuleGuards()
testInternals()
console.log('read-source-resolver-evaluator.test.cjs OK')
