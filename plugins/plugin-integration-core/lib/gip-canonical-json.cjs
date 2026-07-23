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
  // FULL own-property-descriptor sweep (review P2): Object.keys alone missed
  // non-enumerable own properties (collided with {}) — every own property must be
  // an enumerable, accessor-free data property.
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) return false
  }
  return true
}

function isStrictDenseArray(value) {
  if (!Array.isArray(value)) return false
  // exotic arrays are rejected (review P2): a replaced prototype can override map()
  // and make clone/serialize silently emit [] for a non-empty array.
  if (Object.getPrototypeOf(value) !== Array.prototype) return false
  if (Object.getOwnPropertySymbols(value).length > 0) return false
  const names = Object.getOwnPropertyNames(value)
  // EXACTLY the own contiguous indices + 'length' (review P2): an array with extra
  // properties collided with a clean array; inherited indices must not count as
  // dense own elements — own-property checks only, never the `in` operator.
  if (names.length !== value.length + 1) return false
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, String(index))) return false
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) return false
  }
  if (!names.includes('length')) return false
  return true
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
    if (!isStrictDenseArray(value)) {
      throw new CanonicalDomainError('arrays must be dense own-indexed arrays with no extra properties')
    }
    for (let index = 0; index < value.length; index += 1) assertStrictValue(value[index])
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
    if (Array.isArray(entry)) {
      // index loop, NEVER instance-method dispatch (review P2: entry.map is overridable)
      const out = []
      for (let index = 0; index < entry.length; index += 1) out.push(clone(entry[index]))
      return Object.freeze(out)
    }
    if (isStrictPlainObject(entry)) {
      const out = {}
      for (const key of Object.keys(entry)) {
        // defineProperty, NEVER assignment (review P2): `out[key] = …` with a legal
        // JSON data key named __proto__ would SET THE PROTOTYPE of the clone and
        // drop the key — prototype pollution + silent data loss.
        Object.defineProperty(out, key, {
          value: clone(entry[key]),
          enumerable: true,
          writable: false,
          configurable: false,
        })
      }
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
    if (Array.isArray(entry)) {
      // index loop, never entry.map (overridable via exotic prototypes)
      const parts = []
      for (let index = 0; index < entry.length; index += 1) parts.push(serialize(entry[index]))
      return `[${parts.join(',')}]`
    }
    if (isStrictPlainObject(entry)) {
      const keys = Object.keys(entry).sort()
      // own-property READ (a legal own '__proto__' data key shadows the accessor,
      // and the domain guarantees enumerable data properties only)
      return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(Object.getOwnPropertyDescriptor(entry, key).value)}`).join(',')}}`
    }
    return JSON.stringify(entry)
  }
  return serialize(value)
}

module.exports = {
  CanonicalDomainError,
  isStrictPlainObject,
  isStrictDenseArray,
  assertStrictValue,
  deepCloneFrozenCanonical,
  stableCanonicalStringify,
}
