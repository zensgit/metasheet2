'use strict'

// GIP-D0 strict canonical JSON codec — the ONE shared domain/serialization used by
// both the certification contracts and the qualification spike (review P2: two
// partial "strict JSON" definitions drifted and let Date / class instances / sparse
// arrays through as digest-colliding shapes).
//
// STRICT domain (everything else throws CanonicalDomainError):
//   null | boolean | finite number | string
//   dense arrays (no holes) of strict values
//   plain objects (prototype === Object.prototype or null) with
//     - no symbol keys
//     - no accessor properties (get/set)
//     - string keys mapping to strict values
// Rejected by construction: undefined, non-finite numbers, Date / Map / Set / class
// instances / functions / bigint / symbols, sparse arrays, exotic prototypes.
//
// The codec is mechanism-only: callers wrap CanonicalDomainError into their own
// frozen error vocabularies.

class CanonicalDomainError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CanonicalDomainError'
  }
}

function isStrictPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return false
  if (Object.getOwnPropertySymbols(value).length > 0) return false
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || descriptor.get || descriptor.set) return false
  }
  return true
}

function assertDenseArray(value) {
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) {
      throw new CanonicalDomainError('sparse arrays are outside the canonical domain')
    }
  }
}

function assertStrictValue(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CanonicalDomainError('non-finite numbers are outside the canonical domain')
    }
    return
  }
  if (Array.isArray(value)) {
    assertDenseArray(value)
    for (const entry of value) assertStrictValue(entry)
    return
  }
  if (isStrictPlainObject(value)) {
    for (const key of Object.keys(value)) assertStrictValue(value[key])
    return
  }
  // undefined, Date, Map/Set, class instances, functions, bigint, symbol …
  throw new CanonicalDomainError('value is outside the strict canonical JSON domain')
}

// Owned, recursively frozen clone — caller mutation after the fact cannot reach it.
function deepCloneFrozenCanonical(value) {
  assertStrictValue(value)
  const clone = (entry) => {
    if (Array.isArray(entry)) return Object.freeze(entry.map((item) => clone(item)))
    if (isStrictPlainObject(entry)) {
      const out = {}
      for (const key of Object.keys(entry)) out[key] = clone(entry[key])
      return Object.freeze(out)
    }
    return entry
  }
  return clone(value)
}

// Deterministic serialization over the strict domain: sorted keys, dense arrays,
// JSON literals — two values serialize identically iff they are structurally equal
// within the domain (no cross-type collisions: everything outside the domain throws).
function stableCanonicalStringify(value) {
  assertStrictValue(value)
  const serialize = (entry) => {
    if (Array.isArray(entry)) return `[${entry.map((item) => serialize(item)).join(',')}]`
    if (isStrictPlainObject(entry)) {
      const keys = Object.keys(entry).sort()
      return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(entry[key])}`).join(',')}}`
    }
    return JSON.stringify(entry)
  }
  return serialize(value)
}

module.exports = {
  CanonicalDomainError,
  isStrictPlainObject,
  assertStrictValue,
  deepCloneFrozenCanonical,
  stableCanonicalStringify,
}
