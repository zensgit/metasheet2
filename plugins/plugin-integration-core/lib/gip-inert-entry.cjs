'use strict'

// THE INERT-ENTRY GATE (B1a-3 round 5) — ONE door for hostile caller data.
//
// -- WHY THIS SHAPE, AND NOT ANOTHER GUARDED VERB ---------------------------
// Four review rounds each closed the trappable operations that round had found: a
// public error class and an exported `fail`; hostile getters; `Object.keys` and the
// `ownKeys` trap; the `for...of` iterator; symbol keys; a raw component read;
// `Object.getPrototypeOf`; and a raw read of a foreign factory's return value. Each
// round then found a NEW one. That sequence does not converge, and it cannot:
// JavaScript still offers `has`, `getOwnPropertyDescriptor`, `defineProperty`,
// `Symbol.toPrimitive`, `valueOf`, `toString` and more, so an enumeration of traps
// is only ever a snapshot of what somebody has so far thought of. "We found all the
// traps" is not an assertable claim.
//
// This module therefore does not enumerate traps. It closes the CLASS, in two layers
// that are INDEPENDENT and are neutered SEPARATELY:
//
//   L1 CONTAINMENT — `inertRecord` / `inertRecordList` perform EVERY interrogation
//      of a caller's object (prototype, own property names, own symbols, descriptor
//      lookup, getter invocation, array length and element read) inside ONE guarded
//      region, and return a value rebuilt from first-party literals. Downstream code
//      reads the SNAPSHOT and never touches the caller's object again, so no trap —
//      named or not yet named — is reachable from downstream at all.
//
//   L2 BOUNDARY — `createEntryGuard` wraps a public export so that ANY throw, and
//      ANY promise rejection, that is not an already-branded error of the wrapping
//      module is discarded unconditionally (no `cause`, no `message`, no `stack`, no
//      class exemption) and re-thrown as that module's own closed token. L2 does not
//      know or care WHICH operation threw. That is exactly why it holds against the
//      trap the next round would otherwise find.
//
// -- WHY THE BRAND IS A WeakSet AND NOT `instanceof` (ROUND 6, P1-A) --------
// Until round 6 L2 recognised "already branded" with `error instanceof BrandedError`.
// That criterion does not hold, and all three refutations were EXECUTED against the
// round-5 head before this change:
//   * `Object.create(BrandedError.prototype)` — `instanceof` is TRUE while the object
//     carries attacker `message`/`stack`. L2 rethrew it VERBATIM.
//   * a plain `Error` with `.name` assigned the branded class name — `.name` is an
//     ordinary writable property, so any "is branded" test written on `.name`
//     (including the criterion behind the RETRACTED 0/12 matrix) passes on an object
//     whose `instanceof` is false.
//   * `Symbol.hasInstance` — the `instanceof` EXPRESSION ITSELF throws, and it sat
//     inside L2's `catch`, so the attacker's text escaped past the boundary.
// A module-private `WeakSet` has none of those properties: membership is conferred
// ONLY by the `brandError` writer the minting module keeps private, `WeakSet.prototype
// .has` reads an internal slot and therefore invokes NO caller code (it cannot be made
// to throw, and it returns `false` rather than throwing on primitives), and no
// prototype, no writable property and no well-known symbol can add a member.
// `createErrorBrand()` is exported, and exporting it grants nothing: every call returns
// a FRESH, disconnected set, so branding an error into your own set is invisible to
// every other set in the process.
//
// -- NEITHER LAYER IS REDUNDANT, AND THE SUITE PROVES IT BY EXCLUSION --------
// Two fail-closed doors in series normally cover for each other: neuter either one
// and the other still refuses, so neither has an exclusive failure and neither is
// shown to be load-bearing. That is avoided HERE by construction: L2 fails with a
// reason token that L1 NEVER emits (`*_ENTRY_NOT_INERT`), and every hostile-matrix
// cell pins the EXACT reason rather than merely "branded".
//   * Remove L1 from one export  ⇒ that export's cells flip from its precise L1
//     token to the L2 token ⇒ RED, naming the export.
//   * Neuter L2 (rethrow instead of re-brand) ⇒ any touch L1 does not cover escapes
//     UNBRANDED ⇒ RED.
// A single door cannot produce both failures.
//
// -- THE BOUND ON L1, STATED RATHER THAN IMPLIED ----------------------------
// The snapshot is ONE level deep (`inertRecord`), or two for a list of records
// (`inertRecordList`). It is NOT a deep clone, and that is deliberate: several entry
// points receive containers whose MEMBERS must keep object identity, because
// admission downstream is `WeakSet.has(member)` — a deep clone would destroy the
// very identity the trust check reads. So members are carried BY IDENTITY past the
// snapshot bound.
//
// That is safe for a reason that is checkable rather than hopeful: every trap in the
// class lives on the CONTAINER (get / ownKeys / getPrototypeOf /
// getOwnPropertyDescriptor / has / defineProperty), and the container is what the
// snapshot replaces. A member carried by identity is only ever subjected to
// operations that cannot run caller code — `typeof`, `Array.isArray`,
// `WeakSet.has`, `Map.get` — or is CALLED inside an existing unconditional-discard
// try/catch. Nothing coerces a member, so `Symbol.toPrimitive`, `valueOf` and
// `toString` have no site to fire from. Where that reasoning is wrong, L2 catches it
// and the failure is a closed token rather than attacker text.
//
// -- (α) IS AN EXPLICIT NON-CUSTOMER OF THIS MODULE -------------------------
// One caller-adjacent value is deliberately NOT snapshotted: the opaque handle
// returned by a connector's credential factory. Snapshotting it would ENUMERATE the
// handle's own properties, and "never reachable from the executor ... cannot
// enumerate the secret" is precisely what decision (α) requires. That read is
// guarded explicitly at its own site instead, and the handle is retained BY IDENTITY
// so that no copy of anything it closes over is ever made. See the note at that site.
//
// LATENT: this module has no route, no scheduled run and no runtime consumer. It is
// required only by first-party contract modules that are themselves latent.

// A private sentinel. It never escapes this module and it carries NO caller text —
// not a message, not a stack, not a reference to the caller's value.
const NOT_INERT = Object.freeze({ gipInertEntry: 'NOT_INERT' })

// A stand-in for a caller value whose prototype is neither `Object.prototype` nor
// `null`. It is NOT a plain object, so every `isPlainObject` gate downstream refuses
// it exactly as it would have refused the original — the refusal is PRESERVED, while
// the original is never touched again. Returning `null` here instead would also be
// refused, but it would collapse "you passed a class instance" into "you passed
// nothing", and the two are different wiring bugs.
class GipNonPlainValue {}

// The single strict plain-object predicate for the gate's own use. It runs only on
// values this module has already made inert, or on primitives, so its
// `Object.getPrototypeOf` cannot reach a trap.
function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

// --- L1: containment --------------------------------------------------------

// Everything in here may throw NOT_INERT and nothing else. It is called ONLY from
// inside `inertRecord`'s try block.
function snapshotRecordUnderGuard(value) {
  if (value === null || value === undefined) return value
  const kind = typeof value
  // Primitives and functions are carried through untouched. A function is NEVER
  // interrogated — not `.name`, not `.length`, not its prototype — because reading a
  // caller's function is itself a trappable operation and nothing downstream needs
  // anything but `typeof` and the call.
  if (kind !== 'object') return value
  if (Array.isArray(value)) return new GipNonPlainValue()

  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return new GipNonPlainValue()

  const out = {}
  const names = Object.getOwnPropertyNames(value)
  const symbols = Object.getOwnPropertySymbols(value)
  for (let index = 0; index < names.length; index += 1) {
    defineSnapshotMember(out, value, names[index])
  }
  for (let index = 0; index < symbols.length; index += 1) {
    defineSnapshotMember(out, value, symbols[index])
  }
  return Object.freeze(out)
}

// THENABLE NEUTRALISATION (round 6, P1-B). A snapshot must not carry a CALLABLE
// `then`: `await`, `Promise.resolve`, `new Promise(r => r(x))` and every promise
// resolution path READ `then` and CALL it, and those operations run OUTSIDE any
// try/catch that a later reader happens to write. Carrying the caller's `then` by
// identity — which is what "functions are carried through untouched" did — therefore
// handed the caller a callback that fires from inside the promise machinery.
// EXECUTED before this change: `inertRecord({ then(){...} }).then` was a function.
//
// The stand-in is `GipNonPlainValue`, not `undefined`, for the reason stated at that
// class: collapsing "you passed a thenable" into "you passed nothing" loses a
// distinction the two are different wiring bugs. The KEY STAYS PRESENT, so every
// closed-key-set refusal downstream still fires exactly as it did.
function neutralizeThenable(key, member) {
  return key === 'then' && typeof member === 'function' ? new GipNonPlainValue() : member
}

function defineSnapshotMember(out, source, key) {
  // `ownKeys` may report a key whose descriptor is `undefined` — a Proxy is free to
  // be inconsistent. Skipping is correct: an absent descriptor is an absent member,
  // and the closed-key-set pins downstream see it as absent either way.
  const descriptor = Object.getOwnPropertyDescriptor(source, key)
  if (descriptor === undefined) return
  // READ ONCE. An accessor is invoked exactly once, here, and its answer is frozen
  // into a DATA property — so a differing-return getter cannot answer one thing to a
  // presence test and another to the use. Enumerability is preserved, because
  // `Object.keys` downstream distinguishes it and a snapshot that silently promoted
  // a non-enumerable member would change which shapes are admissible.
  const member = 'get' in descriptor || 'set' in descriptor
    ? (typeof descriptor.get === 'function' ? descriptor.get.call(source) : undefined)
    : descriptor.value
  Object.defineProperty(out, key, {
    value: neutralizeThenable(key, member),
    enumerable: descriptor.enumerable === true,
    writable: false,
    configurable: false,
  })
}

// ONE caller-supplied container ⇒ an inert record. `failHostile` is called OUTSIDE
// the try, so the branded error it throws is not re-caught and re-branded here.
function inertRecord(value, failHostile) {
  let snapshot
  let trapped = false
  try {
    snapshot = snapshotRecordUnderGuard(value)
  } catch (_error) {
    // Unconditional discard: no cause, no message, no stack, no class exemption.
    trapped = true
  }
  if (trapped) failHostile()
  return snapshot
}

// A caller-supplied ARRAY of records ⇒ an inert array of inert records. Non-arrays
// are returned as a non-plain stand-in so the caller's own `Array.isArray` refusal
// still fires with the caller's own reason token.
function inertRecordList(value, failHostile) {
  let snapshot
  let trapped = false
  try {
    if (!Array.isArray(value)) {
      snapshot = snapshotRecordUnderGuard(value)
    } else {
      const length = value.length
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) throw NOT_INERT
      const out = []
      for (let index = 0; index < length; index += 1) {
        out.push(snapshotRecordUnderGuard(value[index]))
      }
      snapshot = Object.freeze(out)
    }
  } catch (_error) {
    trapped = true
  }
  if (trapped) failHostile()
  return snapshot
}

// --- L2: the boundary -------------------------------------------------------

// THE BRAND. `createErrorBrand()` mints a FRESH module-private WeakSet plus the only
// two verbs over it. The minting module keeps `brandError` private and threads
// `isBrandedError` into `createEntryGuard`; calling `createErrorBrand()` from anywhere
// else yields an unrelated set, so this export confers nothing on anybody's errors.
// See the P1-A note in the header for the three constructions this replaces.
function createErrorBrand() {
  const branded = new WeakSet()
  return Object.freeze({
    brandError(error) {
      // `WeakSet.prototype.add` throws on a primitive; the modules only ever brand a
      // freshly constructed error, and a primitive simply stays unbranded.
      if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
        branded.add(error)
      }
      return error
    },
    isBrandedError(value) {
      // Reads an internal slot. Invokes no caller code, cannot throw, returns false
      // for primitives and for every forgery.
      return branded.has(value)
    },
  })
}

// `isBrandedError` is the wrapping module's UNFORGEABLE brand predicate (never its
// error CLASS — see the header); `failNotInert` throws that module's
// `*_ENTRY_NOT_INERT` token. Anything else that escapes — a bare `Error` from a trap
// nobody has enumerated, a `TypeError` from a shape nobody anticipated, an object
// built on the branded class's own prototype — is discarded whole and replaced.
function createEntryGuard(isBrandedError, failNotInert) {
  return function guardEntry(fn) {
    return function guardedEntry(...args) {
      let result
      try {
        result = fn.apply(this, args)
      } catch (error) {
        if (isBrandedError(error)) throw error
        failNotInert()
      }
      // ROUND 6, P1-B — THE `then` READ IS ITSELF A TRAPPABLE OPERATION, and until
      // this change it sat OUTSIDE the guarded region: `typeof result.then` fired a
      // hostile getter and the throw escaped past the boundary raw (EXECUTED). It is
      // now read ONCE, inside the guard, into a LOCAL — once, because reading it again
      // for the call would reopen a differing-return channel where a getter answers
      // "not a thenable" to the test and a callable to the use.
      let thenMember
      try {
        thenMember = (result !== null && typeof result === 'object') || typeof result === 'function'
          ? result.then
          : undefined
      } catch (_error) {
        failNotInert()
      }
      // An async entry point turns a throw into a REJECTION, which a synchronous
      // try/catch does not see at all. Re-branding only the synchronous half would
      // leave every `async` public export uncovered.
      if (typeof thenMember !== 'function') return result
      // THE CALL IS FOREIGN TOO. Adopting through a FIRST-PARTY promise is what makes
      // that safe: everything the thenable can do from here — throw out of `then`,
      // throw out of a synchronous resolve, resolve with a second hostile thenable —
      // happens inside the promise machinery, which converts it into a REJECTION this
      // handler sees, instead of a synchronous throw past the boundary. `result.then(
      // undefined, handler)` did NOT have that property: the call itself threw out.
      let adopted
      try {
        adopted = new Promise((resolve, reject) => { thenMember.call(result, resolve, reject) })
      } catch (_error) {
        failNotInert()
      }
      return adopted.then(undefined, (error) => {
        if (isBrandedError(error)) throw error
        failNotInert()
      })
    }
  }
}

// Wrap every function-valued member of an export table, plus every function under
// `__internals` — that namespace is `require()`-reachable, and both consuming modules
// already argue in their own comments that a verb reachable there is the identical
// hole one namespace deeper, so leaving it unguarded would be a decision against
// their own stated posture.
//
// TWO DELIBERATE NON-WRAPS, because wrapping them would BREAK the module:
//   * CLASSES. A wrapper is not the class: `new Wrapped(...)` and every
//     `instanceof`/prototype relationship a consumer writes against the exported class
//     would break. (The reason stated here BEFORE round 6 — "`instanceof` is what L2
//     itself uses to recognise an already-branded error" — is no longer true and would
//     be a false comment if left: L2 now recognises a brand by module-private WeakSet
//     membership and uses no `instanceof` at all.) The error classes take no caller
//     text by construction (they read a frozen per-reason map and ignore everything
//     else), so there is nothing to contain; note that a DIRECTLY constructed error is
//     deliberately NOT branded, so if a foreign callback throws one it is discarded and
//     replaced like any other foreign throw.
//   * EXPORTED OBJECTS THAT CARRY TRUST IDENTITY. Rebuilding an exported frozen
//     object produces a NEW object, and admission downstream is `WeakSet.has(it)` —
//     so a "helpful" wrap of `CERTIFIED_HTTP_PROBE_ACTION_REGISTRY` would silently
//     make the certified registry un-admittable. Only `__internals`, which carries
//     no identity, is recursed into. The methods on identity-carrying exports are
//     driven through the hostile matrix instead of wrapped, so the claim that they
//     are inert is EXECUTED rather than asserted.
function guardExportTable(table, guardEntry) {
  const out = {}
  const keys = Object.keys(table)
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    const value = table[key]
    if (typeof value === 'function') {
      out[key] = isClassConstructor(value) ? value : guardEntry(value)
    } else if (key === '__internals' && isPlainObject(value)) {
      out[key] = guardExportTable(value, guardEntry)
    } else {
      out[key] = value
    }
  }
  return Object.freeze(out)
}

function isClassConstructor(fn) {
  return /^class[\s{]/.test(Function.prototype.toString.call(fn))
}

module.exports = {
  GipNonPlainValue,
  isPlainObject,
  inertRecord,
  inertRecordList,
  createErrorBrand,
  createEntryGuard,
  guardExportTable,
}
