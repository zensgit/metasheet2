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

function main() {
  domainRejections()
  domainAcceptance()
  cloneOwnership()
  stringifyDeterminismAndNonCollision()
  console.log('gip-canonical-json.test.cjs OK')
}

main()
