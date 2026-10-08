'use strict'

// GIP shared strict canonical codec battery. Plain node test, hermetic.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  CanonicalDomainError,
  isStrictPlainObject,
  assertStrictValue,
  deepCloneFrozenCanonical,
  stableCanonicalStringify,
} = require(path.join(__dirname, '..', 'lib', 'gip-canonical-json.cjs'))

function rejects(fn) {
  let caught = null
  try { fn() } catch (error) { caught = error }
  assert.ok(caught instanceof CanonicalDomainError, 'expected CanonicalDomainError')
}

function domainRejections() {
  // exotic objects that previously collided with {} / [] under partial checks
  rejects(() => assertStrictValue(new Date('2026-07-23T00:00:00Z')))
  rejects(() => assertStrictValue(new Map()))
  rejects(() => assertStrictValue(new (class X { constructor() { this.a = 1 } })()))
  rejects(() => assertStrictValue(Object.create({ inherited: 1 })))
  rejects(() => assertStrictValue(undefined))
  rejects(() => assertStrictValue(NaN))
  rejects(() => assertStrictValue(Infinity))
  rejects(() => assertStrictValue(() => 1))
  rejects(() => assertStrictValue(10n))
  // sparse array (collided with [] before)
  // eslint-disable-next-line no-sparse-arrays
  rejects(() => assertStrictValue([, 1]))
  const sparse = [1, 2, 3]; delete sparse[1]
  rejects(() => assertStrictValue(sparse))
  // symbol keys / accessors
  const sym = { ok: 1 }; sym[Symbol('s')] = 2
  rejects(() => assertStrictValue(sym))
  const accessor = {}; Object.defineProperty(accessor, 'a', { get: () => 1, enumerable: true, configurable: true })
  rejects(() => assertStrictValue(accessor))
  // nested violations are found too
  rejects(() => assertStrictValue({ deep: [{ d: new Date(0) }] }))
}

function domainAcceptance() {
  assertStrictValue(null)
  assertStrictValue(true)
  assertStrictValue(0)
  assertStrictValue('s')
  assertStrictValue([1, 'a', null, [true], { k: 1 }])
  assertStrictValue(Object.create(null, { a: { value: 1, enumerable: true } }))
  assert.equal(isStrictPlainObject({}), true)
  assert.equal(isStrictPlainObject(new Date(0)), false)
}

function cloneOwnership() {
  const input = { a: { b: ['x'] } }
  const cloned = deepCloneFrozenCanonical(input)
  input.a.b.push('y'); input.a.c = 1
  assert.deepEqual(cloned, { a: { b: ['x'] } })
  assert.throws(() => { cloned.a.b.push('z') }, TypeError)
  assert.throws(() => { cloned.a.newField = 1 }, TypeError)
}

function stringifyDeterminismAndNonCollision() {
  assert.equal(
    stableCanonicalStringify({ b: 1, a: [true, 'x'] }),
    stableCanonicalStringify({ a: [true, 'x'], b: 1 }),
  )
  // no cross-type collisions inside the domain
  assert.notEqual(stableCanonicalStringify({}), stableCanonicalStringify([]))
  assert.notEqual(stableCanonicalStringify(null), stableCanonicalStringify('null'))
  assert.notEqual(stableCanonicalStringify([null]), stableCanonicalStringify([]))
  // everything OUTSIDE the domain throws — collision by exclusion is impossible
  rejects(() => stableCanonicalStringify(new Date(0)))
  // eslint-disable-next-line no-sparse-arrays
  rejects(() => stableCanonicalStringify([, 1]))
}

// Review round-3 reproductions — all four structural holes stay closed.
function roundThreeReproductions() {
  // (a) legal JSON '__proto__' DATA key: preserved as an own key, clone prototype
  //     stays Object.prototype — no pollution, no key loss.
  const withProtoKey = JSON.parse('{"__proto__": {"polluted": 1}, "a": 1}')
  assertStrictValue(withProtoKey)
  const cloned = deepCloneFrozenCanonical(withProtoKey)
  assert.equal(Object.getPrototypeOf(cloned), Object.prototype, 'clone prototype must not be replaced')
  assert.equal(({}).polluted, undefined, 'no global prototype pollution')
  assert.ok(Object.prototype.hasOwnProperty.call(cloned, '__proto__'), 'own __proto__ data key preserved')
  assert.deepEqual(Object.getOwnPropertyDescriptor(cloned, '__proto__').value, { polluted: 1 })
  // and it serializes distinctly from the empty object
  assert.notEqual(stableCanonicalStringify(withProtoKey), stableCanonicalStringify({ a: 1 }))

  // (b) array with extra own properties: rejected (previously collided with clean [])
  const extra = [1]; extra.x = 'smuggled'
  rejects(() => assertStrictValue(extra))
  rejects(() => stableCanonicalStringify(extra))

  // (c) object whose only own property is non-enumerable: rejected (collided with {})
  const hidden = {}; Object.defineProperty(hidden, 'h', { value: 1, enumerable: false })
  rejects(() => assertStrictValue(hidden))

  // (d) inherited index is NOT a dense own element
  const fakeDense = Object.create([9, 9]); // inherits '0','1' — zero own indices
  rejects(() => assertStrictValue(fakeDense))

  // (e) round-4: EXOTIC array (replaced prototype + overridden map) — previously
  //     accepted yet serialized as [] and cloned to [] (digest collision with []).
  const exotic = [1]
  Object.setPrototypeOf(exotic, Object.create(Array.prototype, { map: { value: () => [] } }))
  rejects(() => assertStrictValue(exotic))
  rejects(() => stableCanonicalStringify(exotic))
  rejects(() => deepCloneFrozenCanonical(exotic))

  // (f) GLOBAL Array.prototype.map pollution must not affect clone/serialize —
  //     index loops never dispatch instance methods (review P2). This discriminates
  //     an entry.map() implementation even when the proto check holds.
  const originalMap = Array.prototype.map
  try {
    // eslint-disable-next-line no-extend-native
    Array.prototype.map = function polluted() { return [] }
    assert.equal(stableCanonicalStringify([1, 'a']), '[1,"a"]')
    assert.deepEqual([...deepCloneFrozenCanonical([1, 'a'])], [1, 'a'])
  } finally {
    // eslint-disable-next-line no-extend-native
    Array.prototype.map = originalMap
  }

  // (g) round-5: a PROXY whose [[Get]] and descriptor paths disagree must be rejected
  //     — validate saw one value, serialize/clone saw another (digest divergence).
  const proxy = new Proxy({ x: 1 }, {
    ownKeys: () => ['x'],
    get: (target, key) => target[key],
    getOwnPropertyDescriptor: () => ({ value: new Date('2020-01-01T00:00:00Z'), enumerable: true, writable: true, configurable: true }),
  })
  assert.equal(isStrictPlainObject(proxy), false)
  rejects(() => assertStrictValue(proxy))
  rejects(() => stableCanonicalStringify(proxy))
  rejects(() => deepCloneFrozenCanonical(proxy))
  const proxyArray = new Proxy([1], { get: (t, k) => t[k] })
  rejects(() => assertStrictValue(proxyArray))

  // (h) round-5: -0 and +0 are ONE canonical JSON number — same serialization, clone
  //     stores +0 (no -0/0 digest ambiguity).
  assert.equal(stableCanonicalStringify(-0), '0')
  assert.equal(stableCanonicalStringify({ a: -0 }), stableCanonicalStringify({ a: 0 }))
  assert.ok(Object.is(deepCloneFrozenCanonical({ a: -0 }).a, 0))
}

function main() {
  domainRejections()
  roundThreeReproductions()
  domainAcceptance()
  cloneOwnership()
  stringifyDeterminismAndNonCollision()
  console.log('gip-canonical-json.test.cjs OK')
}

main()
