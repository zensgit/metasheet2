'use strict'

// Sealed-export S1 — digest constructions named by §6.3 (issue #4636 deliverable 2).
//
// LATENT: no runtime consumer. Total functions only — every entry point returns a
// discriminated result and never raises, so no caller can catch-and-degrade a digest
// to '' or undefined and have it read as "checked and clean".
//
// §6.3 constructions implemented, and only these:
//   - "Every chunk digest covers the exact uploaded bytes."
//   - "The whole-artifact byte digest covers chunks in manifest order."
//   - "a multiset-aware canonical row digest. Duplicate rows remain duplicate; no
//     EXCEPT-style deduplication is allowed."
//   - "Public evidence uses a tenant/system-domain isolated digest or HMAC
//     projection so cross-tenant equality is not an existence side channel."
//
// NOT implemented, deliberately: signature generation or verification. §7.2 leaves
// the signature algorithm to the concrete profile ("The profile pins the allowed
// signature algorithm and key constraints"); no algorithm is named anywhere in the
// baseline and #4636 excludes concrete profile certification. The narrower option is
// to verify nothing and shape-validate the signature fields only.
//
// WHAT THE DOMAIN-ISOLATED PROJECTION DOES AND DOES NOT PROVE: it is deterministic,
// it separates domains (same raw digest under two domain keys yields two different
// projections), and its output is not the raw digest. It does NOT hide the raw
// digest from anyone who already knows the domain key, and a low-entropy domain key
// is recomputable by anyone who can guess it. §6.3 asks for domain isolation against
// cross-tenant equality comparison; that is the property proven, and no more.

const crypto = require('node:crypto')

const SEALED_EXPORT_DIGEST_ALGORITHM = 'sha256'
const SEALED_EXPORT_DIGEST_HEX_LENGTH = 64

function isBytes(value) {
  return value instanceof Uint8Array
}

function isLowerHexDigest(value) {
  if (typeof value !== 'string') return false
  if (value.length !== SEALED_EXPORT_DIGEST_HEX_LENGTH) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    const isDigit = code >= 0x30 && code <= 0x39
    const isLowerAf = code >= 0x61 && code <= 0x66
    if (!isDigit && !isLowerAf) return false
  }
  return true
}

// { ok: true, digest } | { ok: false }
function digestBytes(bytes) {
  if (!isBytes(bytes)) return Object.freeze({ ok: false })
  const hash = crypto.createHash(SEALED_EXPORT_DIGEST_ALGORITHM)
  hash.update(bytes)
  return Object.freeze({ ok: true, digest: hash.digest('hex') })
}

// §6.3: the chunk digest covers the exact uploaded bytes — nothing else, no framing.
function computeChunkDigest(chunkBytes) {
  return digestBytes(chunkBytes)
}

// §6.3: the whole-artifact byte digest covers chunks in manifest order. The artifact
// IS the ordered concatenation, so this digests the concatenation.
//
// A concatenation digest does not by itself pin chunk boundaries — [AB][C] and
// [A][BC] concatenate identically. That is not a gap here: the per-chunk digest and
// byteCount are separate signed manifest terms, so a re-boundaried upload is refused
// by the per-chunk comparison. Asserted by the boundary-reshuffle probe rather than
// assumed.
function computeWholeArtifactByteDigest(orderedChunkBytes) {
  if (!Array.isArray(orderedChunkBytes)) return Object.freeze({ ok: false })
  const hash = crypto.createHash(SEALED_EXPORT_DIGEST_ALGORITHM)
  for (let index = 0; index < orderedChunkBytes.length; index += 1) {
    const chunk = orderedChunkBytes[index]
    if (!isBytes(chunk)) return Object.freeze({ ok: false })
    hash.update(chunk)
  }
  return Object.freeze({ ok: true, digest: hash.digest('hex') })
}

// §6.3 multiset-aware canonical row digest. Rows are canonicalized individually, the
// canonical texts are sorted (so row ORDER does not change the digest) and duplicates
// are RETAINED (so multiplicity does). The sorted texts are then digested as a
// canonical JSON array of strings, which supplies unambiguous framing without
// inventing a length-prefix scheme the baseline does not name.
function computeCanonicalRowsetMultiplicityDigest(rows, canonicalCodec) {
  if (!Array.isArray(rows)) return Object.freeze({ ok: false })
  const texts = []
  for (let index = 0; index < rows.length; index += 1) {
    const canonical = canonicalCodec.tryCanonicalJson(rows[index])
    if (!canonical.ok) return Object.freeze({ ok: false })
    texts.push(canonical.text)
  }
  texts.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  const framed = canonicalCodec.tryCanonicalJson(texts)
  if (!framed.ok) return Object.freeze({ ok: false })
  return digestBytes(framed.bytes)
}

// §6.3 domain-isolated projection for public evidence.
function computeDomainIsolatedDigestProjection(domainKeyBytes, rawDigestHex) {
  if (!isBytes(domainKeyBytes) || domainKeyBytes.length === 0) return Object.freeze({ ok: false })
  if (!isLowerHexDigest(rawDigestHex)) return Object.freeze({ ok: false })
  const mac = crypto.createHmac(SEALED_EXPORT_DIGEST_ALGORITHM, domainKeyBytes)
  mac.update(Buffer.from(rawDigestHex, 'utf8'))
  return Object.freeze({ ok: true, digest: mac.digest('hex') })
}

// Constant-time comparison for the digest comparisons that stand in for signature
// checks. Length is compared first and OUTSIDE the timing-safe path (lengths are
// public: both operands are fixed-width hex digests). Anything that is not a
// well-formed lower-hex digest of the expected width compares false — there is no
// catch that can return true.
function constantTimeEqualDigest(left, right) {
  if (!isLowerHexDigest(left) || !isLowerHexDigest(right)) return false
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')
  if (leftBytes.length !== rightBytes.length) return false
  return crypto.timingSafeEqual(leftBytes, rightBytes)
}

module.exports = {
  SEALED_EXPORT_DIGEST_ALGORITHM,
  SEALED_EXPORT_DIGEST_HEX_LENGTH,
  isLowerHexDigest,
  digestBytes,
  computeChunkDigest,
  computeWholeArtifactByteDigest,
  computeCanonicalRowsetMultiplicityDigest,
  computeDomainIsolatedDigestProjection,
  constantTimeEqualDigest,
}
