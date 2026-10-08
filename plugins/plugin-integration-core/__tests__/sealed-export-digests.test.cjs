'use strict'

// Sealed-export S1 — digest constructions battery. Plain node test, hermetic.
//
// Assertions derive from §6.3 of the ratified S0 baseline:
//   - "Every chunk digest covers the exact uploaded bytes."
//   - "The whole-artifact byte digest covers chunks in manifest order."
//   - "recomputes row count plus a multiset-aware canonical row digest. Duplicate
//      rows remain duplicate; no EXCEPT-style deduplication is allowed."
//   - "Public evidence uses a tenant/system-domain isolated digest or HMAC projection
//      so cross-tenant equality is not an existence side channel."

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const path = require('node:path')

const digests = require(path.join(__dirname, '..', 'lib', 'sealed-export', 'digests.cjs'))
const codec = require(path.join(__dirname, '..', 'lib', 'sealed-export', 'canonical-json.cjs'))

const bytes = (text) => Buffer.from(text, 'utf8')
// Independent oracle: sha256 computed here, not by the module under test.
const oracle = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')

function chunkDigestCoversExactBytes() {
  // §6.3: the chunk digest covers the exact uploaded bytes — no framing, no padding.
  const payload = bytes('sx-chunk-a')
  const result = digests.computeChunkDigest(payload)
  assert.equal(result.ok, true)
  assert.equal(result.digest, oracle(payload), 'must be sha256 over exactly those bytes')
  assert.equal(digests.isLowerHexDigest(result.digest), true)

  // One flipped byte changes the digest (the guard has discriminating power).
  const flipped = Buffer.from(payload)
  flipped[0] ^= 0x01
  assert.notEqual(digests.computeChunkDigest(flipped).digest, result.digest)

  // A non-bytes input is REFUSED, never degraded to a plausible empty digest.
  const bad = digests.computeChunkDigest('sx-chunk-a')
  assert.equal(bad.ok, false)
  assert.equal(bad.digest, undefined, 'a failed digest must not carry a digest')
  assert.equal(digests.computeChunkDigest(null).ok, false)
  assert.equal(digests.computeChunkDigest(undefined).ok, false)
}

function wholeArtifactCoversChunksInManifestOrder() {
  const a = bytes('sx-a')
  const b = bytes('sx-b')
  const forward = digests.computeWholeArtifactByteDigest([a, b])
  const reversed = digests.computeWholeArtifactByteDigest([b, a])
  assert.equal(forward.ok, true)
  assert.equal(forward.digest, oracle(Buffer.concat([a, b])), 'ordered concatenation')
  assert.notEqual(forward.digest, reversed.digest, 'chunk ORDER must change the digest')

  // Repeating the same call is deterministic (positive control).
  assert.equal(digests.computeWholeArtifactByteDigest([a, b]).digest, forward.digest)

  // KNOWN AND COMPENSATED: a pure concatenation digest does not by itself pin chunk
  // BOUNDARIES. [AB][C] and [A][BC] concatenate identically, so this digest alone
  // cannot tell them apart. The compensating control is the per-chunk digest, which
  // does differ — asserted here rather than assumed by a comment.
  const reshuffledLeft = digests.computeWholeArtifactByteDigest([bytes('sx-ab'), bytes('sx-c')])
  const reshuffledRight = digests.computeWholeArtifactByteDigest([bytes('sx-a'), bytes('b-sx-c')])
  assert.equal(
    digests.computeWholeArtifactByteDigest([bytes('sx'), bytes('-a')]).digest,
    digests.computeWholeArtifactByteDigest([bytes('sx-a')]).digest,
    'boundaries are NOT pinned by the whole-artifact digest alone',
  )
  assert.notEqual(
    digests.computeChunkDigest(bytes('sx')).digest,
    digests.computeChunkDigest(bytes('sx-a')).digest,
    'per-chunk digests DO distinguish the reshuffle',
  )
  assert.ok(reshuffledLeft.ok && reshuffledRight.ok)

  // A non-array, or an array with a non-bytes member, fails closed.
  assert.equal(digests.computeWholeArtifactByteDigest('sx-a').ok, false)
  assert.equal(digests.computeWholeArtifactByteDigest([a, 'sx-b']).ok, false)
  assert.equal(digests.computeWholeArtifactByteDigest([a, null]).ok, false)
  assert.equal(digests.computeWholeArtifactByteDigest([]).ok, true, 'empty list is well-defined')
}

function rowsetDigestIsMultisetAware() {
  const rowA = { k: 'sx-r1' }
  const rowB = { k: 'sx-r2' }
  const of = (rows) => digests.computeCanonicalRowsetMultiplicityDigest(rows, codec)

  const ordered = of([rowA, rowB])
  assert.equal(ordered.ok, true)

  // §6.3 multiset semantics: row ORDER does not change the digest ...
  assert.equal(of([rowB, rowA]).digest, ordered.digest, 'row order must not change the digest')

  // ... but MULTIPLICITY does. "Duplicate rows remain duplicate; no EXCEPT-style
  // deduplication is allowed."
  assert.notEqual(of([rowA, rowA]).digest, of([rowA]).digest, 'duplicates must NOT be deduplicated')
  assert.notEqual(of([rowA, rowA, rowB]).digest, of([rowA, rowB]).digest, 'multiplicity is significant')
  assert.equal(of([rowA, rowA]).digest, of([rowA, rowA]).digest, 'deterministic')

  // Framing: two different row sets that share a flattened text must not collide.
  assert.notEqual(of([{ k: 'sx-ab' }]).digest, of([{ k: 'sx-a' }, { k: 'b' }]).digest)

  // A row outside the canonical domain fails CLOSED — it is not skipped, and the
  // digest of the remaining rows is not returned as though the set were clean.
  const withBadRow = of([rowA, { k: undefined }])
  assert.equal(withBadRow.ok, false)
  assert.equal(withBadRow.digest, undefined)
  assert.notEqual(of([rowA]).ok, false, 'positive control: the good row alone is fine')
  assert.equal(of('sx-not-an-array').ok, false)
}

function domainIsolationSeparatesDomains() {
  const raw = oracle(bytes('sx-raw'))
  const keyOne = bytes('sx-domain-key-1')
  const keyTwo = bytes('sx-domain-key-2')

  const one = digests.computeDomainIsolatedDigestProjection(keyOne, raw)
  const two = digests.computeDomainIsolatedDigestProjection(keyTwo, raw)
  assert.equal(one.ok, true)
  assert.equal(two.ok, true)

  // §6.3: cross-tenant equality must not be an existence side channel.
  assert.notEqual(one.digest, two.digest, 'same raw digest under two domains must differ')
  assert.notEqual(one.digest, raw, 'the projection must not be the raw digest')
  assert.equal(digests.computeDomainIsolatedDigestProjection(keyOne, raw).digest, one.digest,
    'deterministic within a domain (positive control)')

  // WHAT THIS DOES NOT PROVE, asserted so no reader over-reads it: two DIFFERENT raw
  // digests still project differently within one domain, i.e. the projection is
  // injective-looking, not hiding. It does not conceal the raw digest from a holder
  // of the domain key.
  assert.notEqual(
    digests.computeDomainIsolatedDigestProjection(keyOne, oracle(bytes('sx-other'))).digest,
    one.digest,
  )

  // Malformed operands fail closed.
  assert.equal(digests.computeDomainIsolatedDigestProjection(bytes(''), raw).ok, false, 'empty key')
  assert.equal(digests.computeDomainIsolatedDigestProjection('sx-key', raw).ok, false, 'non-bytes key')
  assert.equal(digests.computeDomainIsolatedDigestProjection(keyOne, 'sx-not-a-digest').ok, false)
  assert.equal(digests.computeDomainIsolatedDigestProjection(keyOne, raw.toUpperCase()).ok, false,
    'upper-case hex is not the pinned form')
}

function digestComparisonFailsClosedAndNeverThrows() {
  const left = oracle(bytes('sx-x'))
  const right = oracle(bytes('sx-y'))

  // POSITIVE CONTROL: equal digests compare equal. Without this, "always false"
  // would satisfy every negative assertion below.
  assert.equal(digests.constantTimeEqualDigest(left, left), true)
  assert.equal(digests.constantTimeEqualDigest(left, right), false)

  // A one-character difference is caught (no prefix short-circuit that passes).
  const nearMiss = (left[63] === 'a' ? left.slice(0, 63) + 'b' : left.slice(0, 63) + 'a')
  assert.equal(digests.constantTimeEqualDigest(left, nearMiss), false, 'last-character difference')
  const firstCharDiff = (left[0] === 'a' ? 'b' : 'a') + left.slice(1)
  assert.equal(digests.constantTimeEqualDigest(left, firstCharDiff), false, 'first-character difference')

  // Length is compared OUTSIDE the timing-safe path, and anything not a well-formed
  // fixed-width lower-hex digest compares false rather than throwing. A throw here
  // would be catchable and could be degraded into a `true`.
  const shorter = left.slice(0, 63)
  assert.equal(digests.constantTimeEqualDigest(left, shorter), false, 'short operand')
  assert.equal(digests.constantTimeEqualDigest(left, left + 'a'), false, 'long operand')
  assert.equal(digests.constantTimeEqualDigest(left, left.toUpperCase()), false, 'case')
  assert.equal(digests.constantTimeEqualDigest(left, null), false)
  assert.equal(digests.constantTimeEqualDigest(undefined, undefined), false,
    'two undefined operands must NOT compare equal')
  assert.equal(digests.constantTimeEqualDigest('', ''), false, 'two empty operands must NOT compare equal')
  assert.equal(digests.constantTimeEqualDigest(left, { length: 64 }), false)
  assert.equal(digests.constantTimeEqualDigest(left, 'g'.repeat(64)), false, 'non-hex of right length')
}

function digestFormPin() {
  assert.equal(digests.SEALED_EXPORT_DIGEST_ALGORITHM, 'sha256')
  assert.equal(digests.SEALED_EXPORT_DIGEST_HEX_LENGTH, 64)
  assert.equal(digests.isLowerHexDigest('a'.repeat(64)), true)
  assert.equal(digests.isLowerHexDigest('A'.repeat(64)), false)
  assert.equal(digests.isLowerHexDigest('a'.repeat(63)), false)
  assert.equal(digests.isLowerHexDigest('a'.repeat(65)), false)
  assert.equal(digests.isLowerHexDigest('g'.repeat(64)), false)
  assert.equal(digests.isLowerHexDigest(64), false)
}

function main() {
  chunkDigestCoversExactBytes()
  wholeArtifactCoversChunksInManifestOrder()
  rowsetDigestIsMultisetAware()
  domainIsolationSeparatesDomains()
  digestComparisonFailsClosedAndNeverThrows()
  digestFormPin()
  console.log('sealed-export-digests.test.cjs OK')
}

main()
