// Deterministic YiDa material code, algorithm `material-code-v1` (R-71 ⑦.4 PR-1).
//
// Pure, synchronous and dependency-free: no imports, no I/O, no `node:` built-ins, no Web Crypto. The browser preview
// computes the same code as Node, so SHA-1 is implemented here in plain JS.
//
// FROZEN. The code is part of the YiDa payload, the payload is fixed by the ledger's payload digest, and stored drafts
// are recompiled on every read and must reproduce their plan digest. Any change to the namespace, the name layout, the
// prefix, the case or the hyphenation would change every code and make existing drafts unavailable. A different rule is
// a NEW generator id (`material-code-v2`), never an edit of this one. The golden vectors in
// __tests__/yida-material-code.test.cjs pin every byte of the output.
//
//   name = UTF-8(JSON.stringify(['metasheet.stock-prep.yida-material-code', 'v1', keyValue, projectNo]))
//   uuid = UUIDv5(NAMESPACE_V1, name)          // RFC 4122 / RFC 9562 §5.5: SHA-1(ns || name)[0..16), version 5
//   code = 'WLBH-' + uuid.toUpperCase()        // hyphenated, 41 characters (D2 default a)
//
// Inputs are exactly the logical creation identity (baseline §3.3 / §7.2): `keyValue` is the server-read unique key of
// the stock-prep row (its `idempotencyKey`), `projectNo` is the single project number after the split. No tenant, target,
// form, sheet id or record id goes in: a sheet move or a delete-and-recreate keeps the code.
//
// Inputs are validated and NEVER normalised: a silent trim or NFC would give one row two codes. Errors carry a fixed code
// only, never the offending value.

export const YIDA_MATERIAL_CODE_GENERATOR = 'material-code-v1'
export const YIDA_MATERIAL_CODE_PREFIX = 'WLBH-'
export const YIDA_MATERIAL_CODE_NAME_TAG = 'metasheet.stock-prep.yida-material-code'
export const YIDA_MATERIAL_CODE_NAME_VERSION = 'v1'
// A random v4 UUID generated once for PR-1. Not a secret; it only separates this name space from every other UUIDv5 use.
export const YIDA_MATERIAL_CODE_NAMESPACE_V1 = '6d37f698-e75c-4b5e-8eef-b702478a1cfb'
export const YIDA_MATERIAL_CODE_LENGTH = 41
export const YIDA_MATERIAL_CODE_INPUT_MAX_UNITS = 4096

const CODE_PATTERN = /^WLBH-[0-9A-F]{8}-[0-9A-F]{4}-5[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const INPUT_KEYS = ['keyValue', 'projectNo']
const CODES = new Set(['INPUT', 'KEY_VALUE', 'PROJECT_NO'])
const encoder = new TextEncoder()

export class YidaMaterialCodeError extends Error {
  constructor(kind = 'INPUT') {
    const code = `YIDA_MATERIAL_CODE_${CODES.has(kind) ? kind : 'INPUT'}`
    super(code)
    this.name = 'YidaMaterialCodeError'
    this.code = code
  }
}

function fail(kind) { throw new YidaMaterialCodeError(kind) }

// Realm-independent Uint8Array check. `instanceof Uint8Array` is false for bytes made in another realm (jsdom's
// TextEncoder under vitest, an iframe), although they are real Uint8Arrays. The %TypedArray%.prototype[@@toStringTag]
// getter reads the internal [[TypedArrayName]] slot, so it works across realms, cannot be spoofed by an own
// Symbol.toStringTag, and returns undefined for anything that is not a typed array. Output bytes are unchanged.
const typedArrayName = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag).get

function isBytes(value) { return typedArrayName.call(value) === 'Uint8Array' }

function isTrimmed(value) { return value.trim() === value }

function hasControl(value) {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i)
    if (unit <= 0x1f || (unit >= 0x7f && unit <= 0x9f)) return true
  }
  return false
}

function isWellFormedUtf16(value) {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0
      if (next < 0xdc00 || next > 0xdfff) return false
      i += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false
    }
  }
  return true
}

function checkPart(value, kind) {
  if (typeof value !== 'string') fail(kind)
  if (value.length < 1 || value.length > YIDA_MATERIAL_CODE_INPUT_MAX_UNITS) fail(kind)
  if (!isTrimmed(value) || hasControl(value) || !isWellFormedUtf16(value)) fail(kind)
  return value
}

function readInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('INPUT')
  const proto = Object.getPrototypeOf(input)
  if (proto !== Object.prototype && proto !== null) fail('INPUT')
  const keys = Reflect.ownKeys(input)
  if (keys.length !== INPUT_KEYS.length || !INPUT_KEYS.every((key) => keys.includes(key))) fail('INPUT')
  const values = {}
  for (const key of INPUT_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('INPUT')
    values[key] = descriptor.value
  }
  return {
    keyValue: checkPart(values.keyValue, 'KEY_VALUE'),
    projectNo: checkPart(values.projectNo, 'PROJECT_NO'),
  }
}

function rotl(value, bits) { return (value << bits) | (value >>> (32 - bits)) }

/**
 * SHA-1 (FIPS 180-4) of a byte array, synchronous and pure. Used only for UUIDv5 name hashing, where RFC 4122 mandates
 * it; nothing here relies on SHA-1 collision resistance (the inputs are PLM keys, not adversarial).
 * @param {Uint8Array} bytes
 * @returns {Uint8Array} 20 bytes
 */
export function yidaMaterialCodeSha1(bytes) {
  if (!isBytes(bytes)) fail('INPUT')
  const length = bytes.length
  const blocks = Math.ceil((length + 9) / 64)
  const padded = new Uint8Array(blocks * 64)
  padded.set(bytes)
  padded[length] = 0x80
  const bitLengthHigh = Math.floor(length / 0x20000000)
  const bitLengthLow = (length * 8) >>> 0
  const end = padded.length
  padded[end - 8] = (bitLengthHigh >>> 24) & 0xff
  padded[end - 7] = (bitLengthHigh >>> 16) & 0xff
  padded[end - 6] = (bitLengthHigh >>> 8) & 0xff
  padded[end - 5] = bitLengthHigh & 0xff
  padded[end - 4] = (bitLengthLow >>> 24) & 0xff
  padded[end - 3] = (bitLengthLow >>> 16) & 0xff
  padded[end - 2] = (bitLengthLow >>> 8) & 0xff
  padded[end - 1] = bitLengthLow & 0xff

  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0
  const w = new Int32Array(80)
  for (let offset = 0; offset < end; offset += 64) {
    for (let t = 0; t < 16; t += 1) {
      const i = offset + t * 4
      w[t] = (padded[i] << 24) | (padded[i + 1] << 16) | (padded[i + 2] << 8) | padded[i + 3]
    }
    for (let t = 16; t < 80; t += 1) w[t] = rotl(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1)
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    for (let t = 0; t < 80; t += 1) {
      let f
      let k
      if (t < 20) { f = (b & c) | (~b & d); k = 0x5a827999 }
      else if (t < 40) { f = b ^ c ^ d; k = 0x6ed9eba1 }
      else if (t < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc }
      else { f = b ^ c ^ d; k = 0xca62c1d6 }
      const temp = (rotl(a, 5) + f + e + k + w[t]) | 0
      e = d
      d = c
      c = rotl(b, 30)
      b = a
      a = temp
    }
    h0 = (h0 + a) | 0
    h1 = (h1 + b) | 0
    h2 = (h2 + c) | 0
    h3 = (h3 + d) | 0
    h4 = (h4 + e) | 0
  }
  const out = new Uint8Array(20)
  const words = [h0, h1, h2, h3, h4]
  for (let i = 0; i < 5; i += 1) {
    out[i * 4] = (words[i] >>> 24) & 0xff
    out[i * 4 + 1] = (words[i] >>> 16) & 0xff
    out[i * 4 + 2] = (words[i] >>> 8) & 0xff
    out[i * 4 + 3] = words[i] & 0xff
  }
  return out
}

function hex(bytes) {
  let text = ''
  for (let i = 0; i < bytes.length; i += 1) text += bytes[i].toString(16).padStart(2, '0')
  return text
}

/**
 * RFC 4122 / RFC 9562 UUIDv5: lower-case, hyphenated.
 * @param {string} namespace a lower-case hyphenated UUID
 * @param {Uint8Array} nameBytes the name, already encoded
 * @returns {string}
 */
export function yidaMaterialCodeUuidV5(namespace, nameBytes) {
  if (typeof namespace !== 'string' || !UUID_PATTERN.test(namespace)) fail('INPUT')
  if (!isBytes(nameBytes)) fail('INPUT')
  const nsHex = namespace.replace(/-/g, '')
  const message = new Uint8Array(16 + nameBytes.length)
  for (let i = 0; i < 16; i += 1) message[i] = parseInt(nsHex.slice(i * 2, i * 2 + 2), 16)
  message.set(nameBytes, 16)
  const digest = yidaMaterialCodeSha1(message).slice(0, 16)
  digest[6] = (digest[6] & 0x0f) | 0x50
  digest[8] = (digest[8] & 0x3f) | 0x80
  const h = hex(digest)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

/**
 * The exact UTF-8 name bytes `material-code-v1` hashes. Exported so tests and the later v3 transform can pin the layout.
 * @param {{ keyValue: string, projectNo: string }} input
 * @returns {Uint8Array}
 */
export function yidaMaterialCodeName(input) {
  const { keyValue, projectNo } = readInput(input)
  return encoder.encode(JSON.stringify([YIDA_MATERIAL_CODE_NAME_TAG, YIDA_MATERIAL_CODE_NAME_VERSION, keyValue, projectNo]))
}

/**
 * `material-code-v1`: 'WLBH-' + upper-case hyphenated UUIDv5 of the logical creation identity.
 * @param {{ keyValue: string, projectNo: string }} input
 * @returns {string} 41 characters
 */
export function generateYidaMaterialCode(input) {
  const uuid = yidaMaterialCodeUuidV5(YIDA_MATERIAL_CODE_NAMESPACE_V1, yidaMaterialCodeName(input))
  return YIDA_MATERIAL_CODE_PREFIX + uuid.toUpperCase()
}

/**
 * Shape check only (prefix, case, hyphens, version 5, RFC variant, length). It does not prove which inputs made the code.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isYidaMaterialCodeFormat(value) {
  return typeof value === 'string' && value.length === YIDA_MATERIAL_CODE_LENGTH && CODE_PATTERN.test(value)
}
