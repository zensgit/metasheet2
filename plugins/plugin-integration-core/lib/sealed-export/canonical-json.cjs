'use strict'

// Sealed-export S1 — owned canonical JSON codec (issue #4636 deliverables 1 and 2).
//
// LATENT: no runtime consumer. No import from lib/gip-canonical-json.cjs — this is a
// separate, owned codec with its own, narrower domain (that module's domain admits
// arbitrary finite numbers; this one does not, see NUMBERS below).
//
// §6.3 of the ratified S0 baseline says the signature covers "a versioned
// cross-language canonical byte form", that "a candidate is RFC 8785/JCS-compatible
// UTF-8 JSON", and that "the implementation gate must choose and freeze one codec
// with shared golden vectors". This module is that codec; the golden vectors live in
// ./vectors/sealed-export-canonical-vectors.json.
//
// THE RULE (the whole cross-language contract, in six lines):
//   1. UTF-8, no BOM, no insignificant whitespace anywhere.
//   2. Object keys sorted ascending by UTF-16 code unit; duplicate keys impossible.
//   3. Strings use JCS/ECMA-262 minimal escaping (\" \\ \b \f \n \r \t, otherwise
//      \u00xx lowercase hex for C0 controls); NO Unicode normalization is applied,
//      so NFC and NFD inputs are DIFFERENT values with DIFFERENT bytes.
//   4. NUMBERS: integers only, |n| <= Number.MAX_SAFE_INTEGER, written with no sign
//      for zero, no exponent, no fraction, no leading zero. Non-integers are
//      REFUSED. (§6.3 is silent on number formatting; the narrower option is taken
//      deliberately, because ECMA-262 double-to-string is the one part of JCS a
//      PowerShell or C# connector cannot reproduce cheaply, and every numeric field
//      §6.1/§6.4 names is a count, index, budget or byte count.)
//   5. Domain: null | boolean | integer | string | dense array | plain object.
//      Anything else — undefined, Date, Map, class instance, sparse or exotic array,
//      accessor property, symbol key, proxy, lone surrogate — is REFUSED.
//   6. Canonicality is a predicate on BYTES, not a parser:
//        isCanonicalJsonText(bytes) <=> serialize(JSON.parse(bytes)) === bytes
//      One rule refuses every near-miss family the vectors enumerate (key order,
//      whitespace, 1.0/1e2/-0, duplicate keys) with no hand-written JSON parser.
//
// NO THROW: every entry point is total and returns a discriminated result. A caller
// that ignores `ok` gets `undefined`, never a plausible-looking empty digest — and
// the contracts layer converts `ok === false` into a vocabulary refusal via
// failSealedExport(). This is deliberate: a serializer that throws invites a
// catch that degrades to '' and passes.

const nodeUtilTypes = require('node:util').types

const SEALED_EXPORT_CANONICALIZATION_VERSION = 'sealed-export/canonical-json/v1'

// Structural defence limits for untrusted connector bytes. These are parser limits,
// not business limits: they describe what this codec will process, not what any
// customer may export.
const MAX_CANONICAL_DEPTH = 64
const MAX_CANONICAL_BYTES = 1048576

const CANONICAL_VIOLATIONS = Object.freeze([
  'DEPTH_LIMIT_EXCEEDED',
  'EXOTIC_OBJECT',
  'LONE_SURROGATE',
  'NON_FINITE_NUMBER',
  'NON_INTEGER_NUMBER',
  'NUMBER_OUT_OF_SAFE_RANGE',
  'SIZE_LIMIT_EXCEEDED',
  'SPARSE_OR_EXOTIC_ARRAY',
  'UNSUPPORTED_TYPE',
])

function isProxyLike(value) {
  // node:util's isProxy is the only reliable detector; a proxy makes the [[Get]]
  // path and the descriptor path disagree, so validate-then-serialize could see two
  // different values.
  return nodeUtilTypes.isProxy(value)
}

function isStrictPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (isProxyLike(value)) return false
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return false
  if (Object.getOwnPropertySymbols(value).length > 0) return false
  const names = Object.getOwnPropertyNames(value)
  for (let index = 0; index < names.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, names[index])
    if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) return false
  }
  return true
}

function isStrictDenseArray(value) {
  if (!Array.isArray(value)) return false
  if (isProxyLike(value)) return false
  if (Object.getPrototypeOf(value) !== Array.prototype) return false
  if (Object.getOwnPropertySymbols(value).length > 0) return false
  const names = Object.getOwnPropertyNames(value)
  if (names.length !== value.length + 1) return false
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) return false
  }
  return names.indexOf('length') >= 0
}

function hasLoneSurrogate(text) {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
      continue
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return true
  }
  return false
}

// UTF-16 code unit order, exactly what JCS specifies and what JS `<` already does.
function compareUtf16(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function writeCanonicalValue(value, out, depth) {
  if (depth > MAX_CANONICAL_DEPTH) return 'DEPTH_LIMIT_EXCEEDED'
  if (value === null) {
    out.push('null')
    return null
  }
  const kind = typeof value
  if (kind === 'boolean') {
    out.push(value ? 'true' : 'false')
    return null
  }
  if (kind === 'number') {
    if (!Number.isFinite(value)) return 'NON_FINITE_NUMBER'
    if (!Number.isInteger(value)) return 'NON_INTEGER_NUMBER'
    if (!Number.isSafeInteger(value)) return 'NUMBER_OUT_OF_SAFE_RANGE'
    out.push(String(Object.is(value, -0) ? 0 : value))
    return null
  }
  if (kind === 'string') {
    if (hasLoneSurrogate(value)) return 'LONE_SURROGATE'
    out.push(JSON.stringify(value))
    return null
  }
  if (Array.isArray(value)) {
    if (!isStrictDenseArray(value)) return 'SPARSE_OR_EXOTIC_ARRAY'
    out.push('[')
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) out.push(',')
      // index read, never value.map — an exotic prototype could override map and
      // make the serialized form disagree with the validated form.
      const violation = writeCanonicalValue(value[index], out, depth + 1)
      if (violation) return violation
    }
    out.push(']')
    return null
  }
  if (isStrictPlainObject(value)) {
    const keys = Object.keys(value).sort(compareUtf16)
    out.push('{')
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]
      if (hasLoneSurrogate(key)) return 'LONE_SURROGATE'
      if (index > 0) out.push(',')
      out.push(JSON.stringify(key))
      out.push(':')
      // descriptor read: a legal own JSON key named __proto__ shadows the accessor,
      // and the domain guarantees enumerable data properties only.
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      const violation = writeCanonicalValue(descriptor.value, out, depth + 1)
      if (violation) return violation
    }
    out.push('}')
    return null
  }
  if (value && typeof value === 'object') return 'EXOTIC_OBJECT'
  return 'UNSUPPORTED_TYPE'
}

// { ok: true, text, bytes } | { ok: false, violation }
function tryCanonicalJson(value) {
  const out = []
  const violation = writeCanonicalValue(value, out, 0)
  if (violation) return Object.freeze({ ok: false, violation })
  const text = out.join('')
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length > MAX_CANONICAL_BYTES) {
    return Object.freeze({ ok: false, violation: 'SIZE_LIMIT_EXCEEDED' })
  }
  return Object.freeze({ ok: true, text, bytes })
}

// { ok: true, text } | { ok: false }
function decodeCanonicalCandidate(input) {
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > MAX_CANONICAL_BYTES) return Object.freeze({ ok: false })
    return Object.freeze({ ok: true, text: input })
  }
  if (input instanceof Uint8Array) {
    if (input.length > MAX_CANONICAL_BYTES) return Object.freeze({ ok: false })
    try {
      // ignoreBOM: true keeps a leading U+FEFF as a character so JSON.parse refuses
      // it — the default (false) would silently strip it and accept BOM-prefixed
      // bytes as canonical.
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      return Object.freeze({ ok: true, text: decoder.decode(input) })
    } catch (error) {
      // A decode that failed is NOT a decode that came back clean: fail closed.
      return Object.freeze({ ok: false })
    }
  }
  return Object.freeze({ ok: false })
}

// The single canonicality criterion. True only when the input bytes are exactly what
// this codec would emit for the value they denote.
function isCanonicalJsonText(input) {
  const decoded = decodeCanonicalCandidate(input)
  if (!decoded.ok) return false
  let parsed = null
  try {
    parsed = JSON.parse(decoded.text)
  } catch (error) {
    return false
  }
  const canonical = tryCanonicalJson(parsed)
  if (!canonical.ok) return false
  return canonical.text === decoded.text
}

// Owned, recursively frozen clone over the same domain.
// { ok: true, value } | { ok: false, violation }
function tryFreezeCanonical(value) {
  const probe = tryCanonicalJson(value)
  if (!probe.ok) return probe
  const clone = (entry) => {
    if (Array.isArray(entry)) {
      const out = []
      for (let index = 0; index < entry.length; index += 1) out.push(clone(entry[index]))
      return Object.freeze(out)
    }
    if (entry && typeof entry === 'object') {
      const out = {}
      const keys = Object.keys(entry)
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index]
        // defineProperty, never assignment: a legal own JSON key named __proto__
        // would otherwise set the clone's prototype and drop the key.
        Object.defineProperty(out, key, {
          value: clone(Object.getOwnPropertyDescriptor(entry, key).value),
          enumerable: true,
          writable: false,
          configurable: false,
        })
      }
      return Object.freeze(out)
    }
    return Object.is(entry, -0) ? 0 : entry
  }
  return Object.freeze({ ok: true, value: clone(value) })
}

module.exports = {
  SEALED_EXPORT_CANONICALIZATION_VERSION,
  MAX_CANONICAL_DEPTH,
  MAX_CANONICAL_BYTES,
  CANONICAL_VIOLATIONS,
  tryCanonicalJson,
  tryFreezeCanonical,
  isCanonicalJsonText,
  decodeCanonicalCandidate,
  __internals: Object.freeze({
    isStrictPlainObject,
    isStrictDenseArray,
    hasLoneSurrogate,
    compareUtf16,
  }),
}
