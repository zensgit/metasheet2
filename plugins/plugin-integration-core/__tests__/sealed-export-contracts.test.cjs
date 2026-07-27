'use strict'

// Sealed-export S1 — closed contract validators battery. Plain node test, hermetic.
//
// Field lists are transcribed from §6.1/§6.2 of the ratified S0 baseline, NOT read
// out of contracts.cjs. Where the document names a field in prose rather than in
// backticks, the transcription records the prose term and the schema name it maps
// to, so a silently renamed or invented field REDs.
//
// CONNECTOR INPUTS ARE ADVERSARIAL DATA (§6.0): first-party connector code is trusted
// CODE, but what a connector SENDS is untrusted. Declared counts are therefore
// checked, never believed.
//
// SYNTHETIC VALUES ONLY: every token below is a `sx-*` placeholder and every digest
// is sha256 over a `sealed-export-test:*` label. No customer value, identifier,
// endpoint, credential, path, filter or business limit appears here.

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const path = require('node:path')

const SEALED_DIR = path.join(__dirname, '..', 'lib', 'sealed-export')
const contracts = require(path.join(SEALED_DIR, 'contracts.cjs'))
const codec = require(path.join(SEALED_DIR, 'canonical-json.cjs'))
const digests = require(path.join(SEALED_DIR, 'digests.cjs'))
const vocabulary = require(path.join(SEALED_DIR, 'failure-vocabulary.cjs'))

const D = (label) => crypto.createHash('sha256').update('sealed-export-test:' + label).digest('hex')
const bytes = (text) => Buffer.from(text, 'utf8')

// §6.1(1): the twenty-one export request envelope terms, as the document lists them.
const DOCUMENT_ENVELOPE_TERMS = [
  'exportRequestId', 'nonce',                     // "one-time exportRequestId and nonce"
  'expiry',                                       // "expiry"
  'scenarioVersion', 'bindingVersion', 'roleId',  // "scenarioVersion, bindingVersion, and semantic roleId"
  'actionProfileVersion',
  'roleBindingFingerprint',
  'systemContentKey',
  'approvedConfigVersionId', 'configContentKey',
  'canonicalObjectVersion',
  'qualificationDigest',
  'executionMode', 'applyProfileVersion',
  'queryObjectFilterBindingDigest',               // "canonical query/object/filter binding digest"
  'expectedSourceSchemaFieldMapDigest',           // "expected source schema/field-map digest"
  'tenantDomainBinding',                          // "tenant-domain binding"
  'rowBudget', 'byteBudget', 'chunkBudget',       // "row/byte/chunk budgets"
]

// §6.1(2): the eighteen signed manifest terms.
const DOCUMENT_MANIFEST_TERMS = [
  'exportRequestEnvelopeDigest',                  // "exact digest of the export request envelope"
  'sourceCaptureIdentity', 'sourceCaptureProofClass', // "source capture identity and proof class"
  'agentImplementationVersion', 'agentProtocolVersion', // "agent implementation/protocol version"
  'encodingVersion', 'canonicalizationVersion',   // "encoding and canonicalization version"
  'sourceSchemaDigest',                           // "source schema digest"
  'totalRows', 'totalBytes',                      // "total rows and bytes"
  'chunks',                                       // "ordered chunk descriptors"
  'wholeArtifactByteDigest',                      // "whole-artifact byte digest"
  'canonicalRowsetMultiplicityDigest',            // "canonical rowset/multiplicity digest"
  'captureCompletionTimestamp', 'manifestExpiry', // "capture completion timestamp and manifest expiry"
  'signerKeyId', 'signatureAlgorithm', 'signature', // "signer keyId, algorithm, and signature"
]

// §6.2: the fourteen required binding terms, verbatim.
const DOCUMENT_BINDING_TERMS = [
  'query/filter identity',
  'canonical object and schema contract',
  'scenarioVersion, bindingVersion, and roleId',
  'roleBindingFingerprint and actionProfileVersion',
  'systemContentKey',
  'approvedConfigVersionId and configContentKey',
  'canonicalObjectVersion and qualificationDigest',
  'executionMode and applyProfileVersion',
  'source snapshot identity',
  'export request nonce',
  'ordered chunk identities and digests',
  'row count and byte count',
  'whole artifact digest',
  'signer identity and manifest expiry',
]

// ---------------------------------------------------------------------------
// Fixtures. Chunk bytes are real, so digests are real and recomputable.
// ---------------------------------------------------------------------------
const CHUNK_BYTES = [bytes('sx-chunk-zero'), bytes('sx-chunk-one')]
const ROWS = [{ k: 'sx-row-a' }, { k: 'sx-row-b' }, { k: 'sx-row-a' }]

function chunkDescriptors() {
  return CHUNK_BYTES.map((buffer, index) => ({
    chunkIndex: index,
    chunkDigest: digests.computeChunkDigest(buffer).digest,
    byteCount: buffer.length,
  }))
}

function envelope(overrides) {
  return Object.assign({
    exportRequestId: 'sx-request-id',
    nonce: 'sx-nonce',
    expiry: 'sx-expiry',
    scenarioVersion: 'sx-scenario-v1',
    bindingVersion: 'sx-binding-v1',
    roleId: 'sx-role',
    actionProfileVersion: 'sx-action-profile-v1',
    roleBindingFingerprint: 'sx-role-binding-fp',
    systemContentKey: 'sx-system-content-key',
    approvedConfigVersionId: 'sx-approved-config-v1',
    configContentKey: 'sx-config-content-key',
    canonicalObjectVersion: 'sx-canonical-object-v1',
    qualificationDigest: D('qualification'),
    executionMode: 'sx-execution-mode',
    applyProfileVersion: 'sx-apply-profile-v1',
    queryObjectFilterBindingDigest: D('query-binding'),
    expectedSourceSchemaFieldMapDigest: D('schema'),
    tenantDomainBinding: 'sx-tenant-domain',
    rowBudget: 100,
    byteBudget: 1000,
    chunkBudget: 10,
  }, overrides || {})
}

function manifest(forEnvelope, overrides) {
  const descriptors = chunkDescriptors()
  return Object.assign({
    exportRequestEnvelopeDigest: contracts.computeExportRequestEnvelopeDigest(forEnvelope),
    sourceCaptureIdentity: 'sx-capture-identity',
    sourceCaptureProofClass: 'NOT_REQUIRED',
    agentImplementationVersion: 'sx-agent-impl-v1',
    agentProtocolVersion: 'sx-agent-protocol-v1',
    encodingVersion: 'sx-encoding-v1',
    canonicalizationVersion: codec.SEALED_EXPORT_CANONICALIZATION_VERSION,
    sourceSchemaDigest: D('schema'),
    totalRows: ROWS.length,
    totalBytes: CHUNK_BYTES[0].length + CHUNK_BYTES[1].length,
    chunks: descriptors,
    wholeArtifactByteDigest: digests.computeWholeArtifactByteDigest(CHUNK_BYTES).digest,
    canonicalRowsetMultiplicityDigest:
      digests.computeCanonicalRowsetMultiplicityDigest(ROWS, codec).digest,
    captureCompletionTimestamp: 'sx-capture-completed',
    manifestExpiry: 'sx-manifest-expiry',
    signerKeyId: 'sx-signer-key',
    signatureAlgorithm: 'sx-signature-alg',
    signature: 'c2lnbmF0dXJl',
  }, overrides || {})
}

function evidence(overrides) {
  return Object.assign({
    profileToken: 'sx-profile',
    proofClassToken: 'NOT_REQUIRED',
    status: 'SUCCESS',
    reason: null,
    rowCount: 3,
    byteCount: 26,
    chunkCount: 2,
    duration: 1,
    retryCount: 0,
    manifestPresent: true,
    signingKeyPresent: true,
    domainIsolatedManifestDigest: D('dm'),
    domainIsolatedArtifactDigest: D('da'),
    domainIsolatedSchemaDigest: D('ds'),
    domainIsolatedGenerationDigest: D('dg'),
    signerLifecycleState: 'ACTIVE',
    externalWrite: false,
    cleanupOutcome: 'sx-cleanup',
    activePointerOutcome: 'sx-pointer',
  }, overrides || {})
}

function receipt(index, overrides) {
  const descriptors = chunkDescriptors()
  return Object.assign({
    manifestDigest: D('manifest-session'),
    chunkIndex: index,
    chunkDigest: descriptors[index] ? descriptors[index].chunkDigest : D('unknown-chunk'),
    byteCount: descriptors[index] ? descriptors[index].byteCount : 1,
    acceptedAt: 'sx-accepted-at',
  }, overrides || {})
}

function submission(index, overrides) {
  const full = receipt(index, overrides)
  delete full.acceptedAt
  return full
}

function refuses(fn, expectedReason, label) {
  let caught = null
  try { fn() } catch (error) { caught = error }
  assert.ok(caught instanceof vocabulary.SealedExportError, 'expected refusal: ' + label)
  assert.equal(vocabulary.isDeclaredFailureReason(caught.reason), true,
    'refusal reason must be a vocabulary member: ' + label)
  if (expectedReason) assert.equal(caught.reason, expectedReason, 'reason for: ' + label)
  return caught
}

// ---------------------------------------------------------------------------
// §6.1 / §6.2 shape pins, against the DOCUMENT.
// ---------------------------------------------------------------------------
function documentShapePins() {
  assert.equal(DOCUMENT_ENVELOPE_TERMS.length, 21, '§6.1 lists 21 envelope terms')
  assert.equal(DOCUMENT_MANIFEST_TERMS.length, 18, '§6.1 lists 18 manifest terms')
  assert.deepEqual(
    Object.keys(contracts.SCHEMAS_BY_OBJECT.EXPORT_REQUEST_ENVELOPE).sort(),
    DOCUMENT_ENVELOPE_TERMS.slice().sort(),
    'envelope schema must be the document list, one for one — no invention, no omission',
  )
  assert.deepEqual(
    Object.keys(contracts.SCHEMAS_BY_OBJECT.SIGNED_MANIFEST).sort(),
    DOCUMENT_MANIFEST_TERMS.slice().sort(),
    'manifest schema must be the document list, one for one',
  )

  // §6.4 verbatim: "A receipt is (manifestDigest, chunkIndex, chunkDigest,
  // byteCount, acceptedAt)."
  assert.deepEqual(
    Object.keys(contracts.SCHEMAS_BY_OBJECT.CHUNK_RECEIPT).sort(),
    ['acceptedAt', 'byteCount', 'chunkDigest', 'chunkIndex', 'manifestDigest'],
  )
  // A submission is the same tuple before acceptance: acceptedAt is assigned by the
  // accepting side, so a submission must not be able to carry one.
  assert.deepEqual(
    Object.keys(contracts.SCHEMAS_BY_OBJECT.CHUNK_SUBMISSION).sort(),
    ['byteCount', 'chunkDigest', 'chunkIndex', 'manifestDigest'],
  )
  refuses(() => contracts.validateChunkSubmission(receipt(0)),
    'SEALED_EXPORT_MANIFEST_INVALID', 'submission carrying acceptedAt')

  // §6.2's fourteen binding terms, verbatim and in order.
  assert.equal(contracts.SEALED_EXPORT_BINDING_TERMS.length, 14, '§6.2 lists 14 terms')
  assert.deepEqual(
    contracts.SEALED_EXPORT_BINDING_TERMS.map((entry) => entry.term),
    DOCUMENT_BINDING_TERMS,
    '§6.2 binding terms, verbatim',
  )
  // Every binding term must point at a field that actually exists.
  for (const entry of contracts.SEALED_EXPORT_BINDING_TERMS) {
    assert.ok(entry.bindings.length > 0, 'unbound term: ' + entry.term)
    for (const [objectName, field] of entry.bindings) {
      assert.ok(contracts.SCHEMAS_BY_OBJECT[objectName], 'unknown object: ' + objectName)
      assert.ok(
        Object.prototype.hasOwnProperty.call(contracts.SCHEMAS_BY_OBJECT[objectName], field),
        'binding term ' + entry.term + ' points at a missing field: ' + objectName + '.' + field,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// CLOSED MEANS REFUSED, not dropped — for every contract object.
// ---------------------------------------------------------------------------
function closedMeansRefused() {
  const goodEnvelope = envelope()
  const goodManifest = manifest(goodEnvelope)

  const cases = [
    ['EXPORT_REQUEST_ENVELOPE', contracts.validateExportRequestEnvelope, goodEnvelope,
      'SEALED_EXPORT_INTERNAL_ERROR'],
    ['SIGNED_MANIFEST', contracts.validateSignedManifest, goodManifest,
      'SEALED_EXPORT_MANIFEST_INVALID'],
    ['CHUNK_DESCRIPTOR', contracts.validateChunkDescriptor, chunkDescriptors()[0],
      'SEALED_EXPORT_MANIFEST_INVALID'],
    ['CHUNK_RECEIPT', contracts.validateChunkReceipt, receipt(0),
      'SEALED_EXPORT_MANIFEST_INVALID'],
    ['CHUNK_SUBMISSION', contracts.validateChunkSubmission, submission(0),
      'SEALED_EXPORT_MANIFEST_INVALID'],
    ['LIFECYCLE_EVIDENCE', contracts.validateLifecycleEvidence, evidence(),
      'SEALED_EXPORT_INTERNAL_ERROR'],
  ]

  for (const [objectName, validate, good, expectedReason] of cases) {
    // POSITIVE CONTROL — the well-formed object is ACCEPTED. Every refusal below is
    // therefore caused by the specific damage, not by a validator that refuses all.
    const accepted = validate(good)
    assert.ok(Object.isFrozen(accepted), objectName + ' result must be frozen')
    assert.deepEqual(Object.keys(accepted).sort(),
      Object.keys(contracts.SCHEMAS_BY_OBJECT[objectName]).sort(),
      objectName + ' must return exactly its schema fields')

    // An UNKNOWN key refuses the whole object — it is not silently dropped.
    const extraKey = Object.assign({}, good, { zzUnknownKey: 'sx-smuggled' })
    const unknown = refuses(() => validate(extraKey), expectedReason, objectName + ' unknown key')
    assert.equal(JSON.stringify(unknown.details).indexOf('sx-smuggled'), -1,
      'the smuggled value must not be echoed')
    assert.equal(JSON.stringify(unknown.details).indexOf('zzUnknownKey'), -1,
      'even the smuggled KEY NAME must not be echoed')

    // A MISSING key refuses, and names the field.
    for (const field of Object.keys(contracts.SCHEMAS_BY_OBJECT[objectName])) {
      const missing = Object.assign({}, good)
      delete missing[field]
      const error = refuses(() => validate(missing), null, objectName + ' missing ' + field)
      assert.equal(vocabulary.isDeclaredFailureReason(error.reason), true)
    }

    // A SYMBOL key refuses the object rather than being ignored.
    const withSymbol = Object.assign({}, good)
    withSymbol[Symbol('sx-symbol')] = 'sx-smuggled'
    refuses(() => validate(withSymbol), expectedReason, objectName + ' symbol key')

    // Prototype games and non-objects refuse.
    refuses(() => validate(Object.assign(Object.create({ inherited: 1 }), good)),
      expectedReason, objectName + ' inherited prototype')
    refuses(() => validate(null), expectedReason, objectName + ' null')
    refuses(() => validate([good]), expectedReason, objectName + ' array')
    refuses(() => validate('sx-string'), expectedReason, objectName + ' string')

    // An ACCESSOR property refuses: [[Get]] and the descriptor could disagree.
    const accessor = Object.assign({}, good)
    const firstField = Object.keys(contracts.SCHEMAS_BY_OBJECT[objectName])[0]
    delete accessor[firstField]
    Object.defineProperty(accessor, firstField, { get: () => good[firstField], enumerable: true })
    refuses(() => validate(accessor), expectedReason, objectName + ' accessor property')
  }
}

function fieldTypesAreClosed() {
  const goodEnvelope = envelope()

  // A digest field takes a fixed-width lower-hex digest and nothing else.
  refuses(() => contracts.validateExportRequestEnvelope(envelope({ qualificationDigest: 'sx-not-a-digest' })),
    'SEALED_EXPORT_INTERNAL_ERROR', 'digest field, wrong form')
  refuses(() => contracts.validateExportRequestEnvelope(
    envelope({ qualificationDigest: D('qualification').toUpperCase() })),
    'SEALED_EXPORT_INTERNAL_ERROR', 'digest field, upper case')

  // A count field takes a non-negative safe integer.
  for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 2, '1', null, true, NaN]) {
    refuses(() => contracts.validateExportRequestEnvelope(envelope({ rowBudget: bad })),
      'SEALED_EXPORT_INTERNAL_ERROR', 'count field: ' + String(bad))
  }
  assert.ok(contracts.validateExportRequestEnvelope(envelope({ rowBudget: 0 })), '0 is a valid count')

  // A token field is charset- and length-bounded and never empty.
  refuses(() => contracts.validateExportRequestEnvelope(envelope({ roleId: '' })),
    'SEALED_EXPORT_INTERNAL_ERROR', 'empty token')
  refuses(() => contracts.validateExportRequestEnvelope(envelope({ roleId: 'sx role' })),
    'SEALED_EXPORT_INTERNAL_ERROR', 'token with a space')
  refuses(() => contracts.validateExportRequestEnvelope(envelope({ roleId: 'sx-é' })),
    'SEALED_EXPORT_INTERNAL_ERROR', 'token outside the charset')
  refuses(() => contracts.validateExportRequestEnvelope(envelope({ roleId: 'a'.repeat(129) })),
    'SEALED_EXPORT_INTERNAL_ERROR', 'over-long token')

  // An enum field admits only its declared members.
  refuses(() => contracts.validateSignedManifest(manifest(goodEnvelope, { sourceCaptureProofClass: 'sx-other' })),
    'SEALED_EXPORT_MANIFEST_INVALID', 'enum field, undeclared member')
  // §5 froze exactly three proof classes; "another independently ratified mechanism"
  // is NOT modelled as an open extension point.
  assert.deepEqual(Array.from(contracts.SEALED_EXPORT_SOURCE_CAPTURE_PROOF_CLASSES),
    ['IMMUTABLE_SNAPSHOT_TOKEN', 'SOURCE_SNAPSHOT_TXN', 'NOT_REQUIRED'])

  // §9.1 lists `externalWrite=false`; true is not a legal value of this contract.
  refuses(() => contracts.validateLifecycleEvidence(evidence({ externalWrite: true })),
    'SEALED_EXPORT_INTERNAL_ERROR', 'externalWrite=true')
  assert.ok(contracts.validateLifecycleEvidence(evidence({ externalWrite: false })))

  // §9.1 pairs status with a CLOSED reason, in both directions.
  refuses(() => contracts.validateLifecycleEvidence(evidence({ status: 'SUCCESS', reason: 'SEALED_EXPORT_CAPTURE_FAILED' })),
    'SEALED_EXPORT_INTERNAL_ERROR', 'success carrying a reason')
  refuses(() => contracts.validateLifecycleEvidence(evidence({ status: 'FAILURE', reason: null })),
    'SEALED_EXPORT_INTERNAL_ERROR', 'failure without a reason')
  refuses(() => contracts.validateLifecycleEvidence(evidence({ status: 'FAILURE', reason: 'ZZ-NOT-A-REASON' })),
    'SEALED_EXPORT_INTERNAL_ERROR', 'failure with an undeclared reason')
  assert.ok(contracts.validateLifecycleEvidence(
    evidence({ status: 'FAILURE', reason: 'SEALED_EXPORT_CAPTURE_FAILED' })), 'positive control')
}

function chunkListIsClosed() {
  const goodEnvelope = envelope()

  // An EXTRA array member with an unknown key refuses the manifest.
  const extraMember = manifest(goodEnvelope, {
    chunks: chunkDescriptors().concat([{ chunkIndex: 2, chunkDigest: D('x'), byteCount: 1, zzExtra: 1 }]),
  })
  refuses(() => contracts.validateSignedManifest(extraMember),
    'SEALED_EXPORT_MANIFEST_INVALID', 'chunk descriptor with an unknown key')

  // A sparse chunk list refuses.
  const sparse = chunkDescriptors()
  delete sparse[0]
  refuses(() => contracts.validateSignedManifest(manifest(goodEnvelope, { chunks: sparse })),
    'SEALED_EXPORT_MANIFEST_INVALID', 'sparse chunk list')

  // An empty chunk list is not a sealed export with nothing to prove — it is refused.
  refuses(() => contracts.validateSignedManifest(manifest(goodEnvelope, { chunks: [] })),
    'SEALED_EXPORT_CHUNK_SET_INCOMPLETE', 'empty chunk list')
  refuses(() => contracts.validateSignedManifest(manifest(goodEnvelope, { chunks: 'sx-not-a-list' })),
    'SEALED_EXPORT_MANIFEST_INVALID', 'non-array chunk list')
}

// ---------------------------------------------------------------------------
// DECLARED COUNTS ARE CHECKED, NOT BELIEVED.
// ---------------------------------------------------------------------------
function declaredCountsAreChecked() {
  const goodEnvelope = envelope()
  assert.ok(contracts.validateSignedManifest(manifest(goodEnvelope)), 'positive control')

  // totalBytes must equal the sum of the manifest's own chunk byteCounts.
  const liedBytes = refuses(
    () => contracts.validateSignedManifest(manifest(goodEnvelope, { totalBytes: 999 })),
    'SEALED_EXPORT_MANIFEST_INVALID', 'declared totalBytes disagreeing with the chunk sum',
  )
  assert.equal(liedBytes.details.field, 'totalBytes')
  assert.equal(liedBytes.details.declaredCount, 999, 'the DECLARED count is reported ...')
  assert.notEqual(liedBytes.details.observedCount, 999, '... alongside the OBSERVED one')

  // Chunk indexes must be 0..n-1 exactly once, in order.
  const reordered = chunkDescriptors().slice().reverse()
  refuses(() => contracts.validateSignedManifest(manifest(goodEnvelope, { chunks: reordered })),
    'SEALED_EXPORT_CHUNK_ORDER_INVALID', 'reordered chunk descriptors')
  const duplicated = [chunkDescriptors()[0], chunkDescriptors()[0]]
  refuses(() => contracts.validateSignedManifest(manifest(goodEnvelope, {
    chunks: duplicated,
    totalBytes: duplicated[0].byteCount * 2,
  })), 'SEALED_EXPORT_CHUNK_ORDER_INVALID', 'duplicated chunk index in the manifest')
  const gapped = [Object.assign(chunkDescriptors()[0], { chunkIndex: 1 })]
  refuses(() => contracts.validateSignedManifest(manifest(goodEnvelope, {
    chunks: gapped, totalBytes: gapped[0].byteCount,
  })), 'SEALED_EXPORT_CHUNK_ORDER_INVALID', 'chunk list not starting at 0')

  // The canonicalization version is pinned, so a manifest canonicalized by another
  // codec version cannot be verified with this one.
  refuses(() => contracts.validateSignedManifest(manifest(goodEnvelope, { canonicalizationVersion: 'sx-other-v9' })),
    'SEALED_EXPORT_MANIFEST_INVALID', 'foreign canonicalization version')
}

function artifactVerificationRecomputes() {
  const goodEnvelope = envelope()
  const goodManifest = contracts.validateSignedManifest(manifest(goodEnvelope))

  // POSITIVE CONTROL — the real bytes verify.
  const verified = contracts.verifyArtifactAgainstManifest(goodManifest, CHUNK_BYTES)
  assert.deepEqual(verified, { chunkCount: 2, byteCount: CHUNK_BYTES[0].length + CHUNK_BYTES[1].length })

  // A declared chunk count disagreeing with the observed count fails closed.
  const short = refuses(() => contracts.verifyArtifactAgainstManifest(goodManifest, [CHUNK_BYTES[0]]),
    'SEALED_EXPORT_CHUNK_SET_INCOMPLETE', 'fewer chunks than declared')
  assert.equal(short.details.declaredCount, 2)
  assert.equal(short.details.observedCount, 1)
  refuses(() => contracts.verifyArtifactAgainstManifest(goodManifest, CHUNK_BYTES.concat([bytes('sx-extra')])),
    'SEALED_EXPORT_CHUNK_SET_INCOMPLETE', 'more chunks than declared')
  refuses(() => contracts.verifyArtifactAgainstManifest(goodManifest, 'sx-not-an-array'),
    'SEALED_EXPORT_CHUNK_SET_INCOMPLETE', 'non-array artifact')

  // Reordered bytes are caught by the per-chunk digest.
  refuses(() => contracts.verifyArtifactAgainstManifest(goodManifest, [CHUNK_BYTES[1], CHUNK_BYTES[0]]),
    'SEALED_EXPORT_CHUNK_DIGEST_MISMATCH', 'reordered chunk bytes')
  // A byte-count lie is caught before the digest is even computed.
  refuses(() => contracts.verifyArtifactAgainstManifest(goodManifest, [bytes('sx-x'), CHUNK_BYTES[1]]),
    'SEALED_EXPORT_CHUNK_DIGEST_MISMATCH', 'wrong chunk length')
  refuses(() => contracts.verifyArtifactAgainstManifest(goodManifest, ['sx-a', CHUNK_BYTES[1]]),
    'SEALED_EXPORT_CHUNK_DIGEST_MISMATCH', 'non-bytes chunk')

  // GUARD ISOLATION. Three separate guards run here — chunk byteCount, per-chunk
  // digest, and whole-artifact digest — and each must be shown to carry a failure
  // ALONE, or a mutation could neuter one while a sibling silently covers for it.
  //
  // (a) whole-artifact digest ONLY: every chunk length and every chunk digest is
  //     correct, so nothing but the whole-artifact comparison can refuse this.
  const wrongWhole = contracts.validateSignedManifest(
    manifest(goodEnvelope, { wholeArtifactByteDigest: D('wrong-whole') }),
  )
  refuses(() => contracts.verifyArtifactAgainstManifest(wrongWhole, CHUNK_BYTES),
    'SEALED_EXPORT_ARTIFACT_DIGEST_MISMATCH', 'whole-artifact digest mismatch alone')

  // (b) per-chunk digest ONLY: the byte lengths match their descriptors and the
  //     concatenation matches the whole-artifact digest, so the ONLY thing wrong is
  //     one chunk's declared digest. Without this case the per-chunk comparison
  //     could be deleted and the suite would stay green, because the length check
  //     and the whole-artifact check happen to catch every other probe.
  const descriptors = chunkDescriptors()
  const wrongChunkDigestOnly = contracts.validateSignedManifest(manifest(goodEnvelope, {
    chunks: [
      Object.assign({}, descriptors[0], { chunkDigest: D('wrong-chunk-zero') }),
      descriptors[1],
    ],
  }))
  assert.equal(wrongChunkDigestOnly.wholeArtifactByteDigest,
    digests.computeWholeArtifactByteDigest(CHUNK_BYTES).digest,
    'precondition: the whole-artifact digest still matches, so it cannot be what refuses')
  assert.equal(wrongChunkDigestOnly.chunks[0].byteCount, CHUNK_BYTES[0].length,
    'precondition: the byte count still matches, so it cannot be what refuses')
  const chunkOnly = refuses(() => contracts.verifyArtifactAgainstManifest(wrongChunkDigestOnly, CHUNK_BYTES),
    'SEALED_EXPORT_CHUNK_DIGEST_MISMATCH', 'per-chunk digest mismatch alone')
  assert.equal(chunkOnly.details.chunkIndex, 0, 'the refusal names which chunk')
}

function rowsetVerificationRecomputes() {
  const goodEnvelope = envelope()
  const goodManifest = contracts.validateSignedManifest(manifest(goodEnvelope))

  assert.deepEqual(contracts.verifyRowsetAgainstManifest(goodManifest, ROWS), { rowCount: 3 })
  // §6.3: row ORDER does not change the multiset digest.
  assert.deepEqual(contracts.verifyRowsetAgainstManifest(goodManifest, ROWS.slice().reverse()), { rowCount: 3 })

  // A declared row count disagreeing with the observed count fails closed.
  const wrongCount = refuses(() => contracts.verifyRowsetAgainstManifest(goodManifest, ROWS.slice(0, 2)),
    'SEALED_EXPORT_ROW_COUNT_MISMATCH', 'row count lie')
  assert.equal(wrongCount.details.declaredCount, 3)
  assert.equal(wrongCount.details.observedCount, 2)
  refuses(() => contracts.verifyRowsetAgainstManifest(goodManifest, 'sx-not-an-array'),
    'SEALED_EXPORT_ROW_COUNT_MISMATCH', 'non-array rowset')

  // §6.3: "Duplicate rows remain duplicate; no EXCEPT-style deduplication."
  // Substituting a distinct row for the duplicate keeps the COUNT but changes the
  // multiset, so it must still fail.
  refuses(() => contracts.verifyRowsetAgainstManifest(goodManifest,
    [{ k: 'sx-row-a' }, { k: 'sx-row-b' }, { k: 'sx-row-c' }]),
    'SEALED_EXPORT_ARTIFACT_DIGEST_MISMATCH', 'same row count, different multiset')

  // A rowset the codec cannot canonicalize fails CLOSED — the comparison must not be
  // swallowed into a pass.
  refuses(() => contracts.verifyRowsetAgainstManifest(goodManifest,
    [{ k: 'sx-row-a' }, { k: undefined }, { k: 'sx-row-a' }]),
    'SEALED_EXPORT_MANIFEST_INVALID', 'uncanonicalizable row')
}

// ---------------------------------------------------------------------------
// §6.2 binding: changing ANY one term must change the signed payload.
// ---------------------------------------------------------------------------
function bindingCoversEveryTerm() {
  const goodEnvelope = envelope()
  const goodManifest = contracts.validateSignedManifest(manifest(goodEnvelope))

  // POSITIVE CONTROL — a matching pair verifies.
  const bound = contracts.verifyManifestBinding(goodEnvelope, goodManifest)
  assert.equal(digests.isLowerHexDigest(bound.manifestDigest), true)

  // §6.2 "Changing any one term produces a different signed payload." Proven for
  // EVERY envelope term: perturb it, and the envelope digest must move, which breaks
  // the manifest's binding.
  const baseline = contracts.computeExportRequestEnvelopeDigest(goodEnvelope)
  for (const field of DOCUMENT_ENVELOPE_TERMS) {
    const spec = contracts.SCHEMAS_BY_OBJECT.EXPORT_REQUEST_ENVELOPE[field]
    const perturbed = envelope({
      [field]: spec.kind === 'count' ? goodEnvelope[field] + 1
        : spec.kind === 'digest' ? D('perturbed-' + field)
          : 'sx-perturbed',
    })
    assert.notEqual(contracts.computeExportRequestEnvelopeDigest(perturbed), baseline,
      'envelope term not covered by the digest: ' + field)
    refuses(() => contracts.verifyManifestBinding(perturbed, goodManifest),
      null, 'binding must break when ' + field + ' changes')
  }

  // Every manifest term must be covered by the signed payload, except the signature
  // itself — a signature cannot cover itself.
  const payload = contracts.unsignedManifestPayload(goodManifest)
  assert.deepEqual(Object.keys(payload).sort(),
    DOCUMENT_MANIFEST_TERMS.filter((f) => f !== 'signature').sort(),
    'the signed payload is every manifest field except the signature')
  const payloadBaseline = contracts.computeManifestDigest(goodManifest)
  for (const field of DOCUMENT_MANIFEST_TERMS) {
    if (field === 'signature') continue
    if (field === 'chunks') continue // covered by the descriptor perturbation below
    const spec = contracts.SCHEMAS_BY_OBJECT.SIGNED_MANIFEST[field]
    const perturbed = Object.assign({}, goodManifest, {
      [field]: spec.kind === 'count' ? goodManifest[field] + 1
        : spec.kind === 'digest' ? D('perturbed-' + field)
          : spec.kind === 'enum' ? 'SOURCE_SNAPSHOT_TXN'
            : 'sx-perturbed',
    })
    assert.notEqual(contracts.computeManifestDigest(perturbed), payloadBaseline,
      'manifest term not covered by the signed payload: ' + field)
  }
  // Changing a chunk digest changes the payload (ordered chunk identities).
  const reChunked = Object.assign({}, goodManifest, {
    chunks: [Object.assign({}, goodManifest.chunks[0], { chunkDigest: D('perturbed-chunk') }),
      goodManifest.chunks[1]],
  })
  assert.notEqual(contracts.computeManifestDigest(reChunked), payloadBaseline, 'chunk identities bound')
  // The signature field itself is NOT part of the payload.
  assert.equal(
    contracts.computeManifestDigest(Object.assign({}, goodManifest, { signature: 'b3RoZXI=' })),
    payloadBaseline, 'the signature does not cover itself',
  )

  // §10 declares a SEPARATE schema-mismatch reason, and it must actually be used:
  // a manifest whose sourceSchemaDigest disagrees with the envelope's expected
  // schema digest still carries a correct envelope digest, so the generic binding
  // check passes and the specific schema check is what refuses it. The two guards
  // must not cover for each other.
  const schemaSkew = contracts.validateSignedManifest(
    manifest(goodEnvelope, { sourceSchemaDigest: D('other-schema') }),
  )
  const skewError = refuses(() => contracts.verifyManifestBinding(goodEnvelope, schemaSkew),
    'SEALED_EXPORT_MANIFEST_SCHEMA_MISMATCH', 'schema digest skew')
  assert.equal(skewError.details.field, 'sourceSchemaDigest')
  // ... whereas a manifest bound to a DIFFERENT envelope fails the generic check.
  refuses(() => contracts.verifyManifestBinding(goodEnvelope,
    contracts.validateSignedManifest(manifest(goodEnvelope,
      { exportRequestEnvelopeDigest: D('other-envelope') }))),
    'SEALED_EXPORT_MANIFEST_BINDING_MISMATCH', 'envelope digest skew')
}

function budgetsAreCheckedNotBelieved() {
  const goodEnvelope = envelope()

  // POSITIVE CONTROL — an in-budget manifest passes.
  assert.ok(contracts.verifyManifestBinding(goodEnvelope, contracts.validateSignedManifest(manifest(goodEnvelope))))

  // Each budget refuses independently, and names WHICH budget — so the three guards
  // cannot cover for one another.
  const overRows = envelope({ rowBudget: 1 })
  assert.equal(refuses(() => contracts.verifyManifestBinding(overRows, manifest(overRows)),
    'SEALED_EXPORT_BUDGET_EXCEEDED', 'row budget').details.budget, 'ROW_BUDGET')
  const overBytes = envelope({ byteBudget: 1 })
  assert.equal(refuses(() => contracts.verifyManifestBinding(overBytes, manifest(overBytes)),
    'SEALED_EXPORT_BUDGET_EXCEEDED', 'byte budget').details.budget, 'BYTE_BUDGET')
  const overChunks = envelope({ chunkBudget: 1 })
  assert.equal(refuses(() => contracts.verifyManifestBinding(overChunks, manifest(overChunks)),
    'SEALED_EXPORT_BUDGET_EXCEEDED', 'chunk budget').details.budget, 'CHUNK_BUDGET')

  // A budget that is ABSENT must fail closed. `n > undefined` is false, so an
  // unchecked comparison would let a manifest of any size through while looking
  // exactly like a clean pass. "Checked and clean" must be distinguishable from
  // "the check did not happen".
  for (const budget of ['rowBudget', 'byteBudget', 'chunkBudget']) {
    const missing = envelope()
    delete missing[budget]
    const error = refuses(() => contracts.verifyManifestBinding(missing,
      manifest(missing, { totalRows: 10 ** 6, totalBytes: 10 ** 6 })),
      'SEALED_EXPORT_INTERNAL_ERROR', 'absent ' + budget)
    assert.equal(error.details.field, budget, 'the refusal names the absent budget')
  }
  // A non-count budget is refused too, not coerced.
  for (const bad of [null, '100', -1, 1.5, true]) {
    refuses(() => contracts.verifyManifestBinding(envelope({ rowBudget: bad }), manifest(envelope())),
      null, 'non-count rowBudget: ' + String(bad))
  }
  // Manifest-side counts are equally unbelieved.
  refuses(() => contracts.verifyManifestBinding(goodEnvelope,
    Object.assign(manifest(goodEnvelope), { totalRows: undefined })),
    null, 'absent totalRows')
  refuses(() => contracts.verifyManifestBinding(goodEnvelope,
    Object.assign(manifest(goodEnvelope), { chunks: undefined })),
    null, 'absent chunks')
  refuses(() => contracts.verifyManifestBinding(null, manifest(goodEnvelope)), null, 'null envelope')
  refuses(() => contracts.verifyManifestBinding(goodEnvelope, null), null, 'null manifest')
}

// ---------------------------------------------------------------------------
// §5 source-time consistency: the signer, manifest digest, export ID and completion
// timestamp must never be relabelled as a source snapshot proof.
// ---------------------------------------------------------------------------
function snapshotProofIsNotRelabelled() {
  const goodEnvelope = envelope()
  const notRequired = contracts.validateSignedManifest(manifest(goodEnvelope))
  const txn = contracts.validateSignedManifest(
    manifest(goodEnvelope, { sourceCaptureProofClass: 'SOURCE_SNAPSHOT_TXN' }))
  const immutableToken = contracts.validateSignedManifest(
    manifest(goodEnvelope, { sourceCaptureProofClass: 'IMMUTABLE_SNAPSHOT_TOKEN' }))

  // POSITIVE CONTROLS, both directions.
  assert.deepEqual(contracts.resolveSourceTimeConsistencyProof(true, txn), { proofClassToken: 'SOURCE_SNAPSHOT_TXN' })
  assert.deepEqual(contracts.resolveSourceTimeConsistencyProof(false, notRequired), { proofClassToken: 'NOT_REQUIRED' })

  // IMMUTABLE_SNAPSHOT_TOKEN describes the sealed ARTIFACT after capture; §5 says it
  // is NOT sufficient evidence that the source rows came from one point in time.
  const relabelled = refuses(() => contracts.resolveSourceTimeConsistencyProof(true, immutableToken),
    'SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE', 'artifact immutability is not source-time proof')
  assert.equal(relabelled.details.proofClass, 'IMMUTABLE_SNAPSHOT_TOKEN')
  refuses(() => contracts.resolveSourceTimeConsistencyProof(true, notRequired),
    'SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE', 'NOT_REQUIRED cannot satisfy a requirement')

  // §5: when consistency is not required the evidence must record NOT_REQUIRED
  // EXPLICITLY — anything else, including a stronger class, fails.
  refuses(() => contracts.resolveSourceTimeConsistencyProof(false, txn),
    'SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE', 'must be explicit, not merely sufficient')

  // The requirement flag itself must be an explicit boolean.
  refuses(() => contracts.resolveSourceTimeConsistencyProof('true', txn),
    'SEALED_EXPORT_INTERNAL_ERROR', 'non-boolean requirement flag')
  refuses(() => contracts.resolveSourceTimeConsistencyProof(undefined, txn),
    'SEALED_EXPORT_INTERNAL_ERROR', 'absent requirement flag')
}

// ---------------------------------------------------------------------------
// §6.4 chunk resume: ordering, duplicates and replay.
// ---------------------------------------------------------------------------
function chunkSubmissionClassification() {
  const goodEnvelope = envelope()
  const goodManifest = contracts.validateSignedManifest(manifest(goodEnvelope))
  const sessionDigest = D('manifest-session')

  // POSITIVE CONTROL — the first chunk of an empty session is ACCEPTed.
  assert.deepEqual(
    contracts.classifyChunkSubmission(goodManifest, sessionDigest, [], submission(0)),
    { decision: 'ACCEPT', acceptedChunkCount: 1 },
  )
  // ... and the next index after one acceptance.
  assert.deepEqual(
    contracts.classifyChunkSubmission(goodManifest, sessionDigest, [receipt(0)], submission(1)),
    { decision: 'ACCEPT', acceptedChunkCount: 2 },
  )

  // §6.4: an identical re-send is an IDEMPOTENT REPLAY and does not increment counts.
  assert.deepEqual(
    contracts.classifyChunkSubmission(goodManifest, sessionDigest, [receipt(0)], submission(0)),
    { decision: 'IDEMPOTENT_REPLAY', acceptedChunkCount: 1 },
  )
  // §6.4: the same index with DIFFERENT bytes is a conflicting duplicate.
  refuses(() => contracts.classifyChunkSubmission(goodManifest, sessionDigest, [receipt(0)],
    submission(0, { chunkDigest: D('different-bytes') })),
    'SEALED_EXPORT_CHUNK_DUPLICATE_CONFLICT', 'same index, different digest')
  refuses(() => contracts.classifyChunkSubmission(goodManifest, sessionDigest, [receipt(0)],
    submission(0, { byteCount: 999 })),
    'SEALED_EXPORT_CHUNK_DUPLICATE_CONFLICT', 'same index, different byte count')

  // §6.4: "Skipping or reordering a new index fails closed."
  const skipped = refuses(() => contracts.classifyChunkSubmission(goodManifest, sessionDigest, [], submission(1)),
    'SEALED_EXPORT_CHUNK_ORDER_INVALID', 'skipping an index')
  assert.equal(skipped.details.expectedChunkIndex, 0)
  assert.equal(skipped.details.chunkIndex, 1)

  // An index the manifest never declared is UNDECLARED, not merely out of order.
  refuses(() => contracts.classifyChunkSubmission(goodManifest, sessionDigest,
    [receipt(0), receipt(1)], submission(2, { chunkDigest: D('x'), byteCount: 1 })),
    'SEALED_EXPORT_CHUNK_UNDECLARED', 'index beyond the manifest')

  // Bytes that do not match the manifest descriptor are refused.
  refuses(() => contracts.classifyChunkSubmission(goodManifest, sessionDigest, [],
    submission(0, { chunkDigest: D('wrong') })),
    'SEALED_EXPORT_CHUNK_DIGEST_MISMATCH', 'digest disagreeing with the descriptor')

  // The session is keyed by the immutable manifest digest.
  refuses(() => contracts.classifyChunkSubmission(goodManifest, D('other-session'), [], submission(0)),
    'SEALED_EXPORT_UPLOAD_SESSION_INVALID', 'submission for another session')
  refuses(() => contracts.classifyChunkSubmission(goodManifest, 'sx-not-a-digest', [], submission(0)),
    'SEALED_EXPORT_UPLOAD_SESSION_INVALID', 'malformed session key')
  refuses(() => contracts.classifyChunkSubmission(goodManifest, sessionDigest,
    [receipt(0, { manifestDigest: D('other-session') })], submission(1)),
    'SEALED_EXPORT_UPLOAD_SESSION_INVALID', 'receipt from another session')

  // A receipt set that is not a prefix 0..n-1 is refused rather than repaired.
  refuses(() => contracts.classifyChunkSubmission(goodManifest, sessionDigest,
    [receipt(0), receipt(0)], submission(1)),
    'SEALED_EXPORT_UPLOAD_SESSION_INVALID', 'duplicate receipt in the accepted set')
  refuses(() => contracts.classifyChunkSubmission(goodManifest, sessionDigest, 'sx-not-an-array', submission(0)),
    'SEALED_EXPORT_UPLOAD_SESSION_INVALID', 'non-array receipt set')
}

function chunkSetCompletenessRefusesDuplicatesAndUndeclared() {
  const goodEnvelope = envelope()
  const goodManifest = contracts.validateSignedManifest(manifest(goodEnvelope))

  // POSITIVE CONTROL — the exact declared set is complete.
  assert.deepEqual(contracts.assertChunkSetComplete(goodManifest, [receipt(0), receipt(1)]), { chunkCount: 2 })
  // Order of the receipt list itself is not significant; the SET is.
  assert.deepEqual(contracts.assertChunkSetComplete(goodManifest, [receipt(1), receipt(0)]), { chunkCount: 2 })

  // A missing index is incomplete.
  const incomplete = refuses(() => contracts.assertChunkSetComplete(goodManifest, [receipt(0)]),
    'SEALED_EXPORT_CHUNK_SET_INCOMPLETE', 'missing receipt')
  assert.equal(incomplete.details.declaredCount, 2)
  assert.equal(incomplete.details.observedCount, 1)

  // A DUPLICATED receipt index must be refused, not silently collapsed by a Set.
  // Before the S1 fix this returned { chunkCount: 2 } and reported the set complete.
  const duplicate = refuses(
    () => contracts.assertChunkSetComplete(goodManifest, [receipt(0), receipt(0), receipt(1)]),
    'SEALED_EXPORT_CHUNK_DUPLICATE_CONFLICT', 'duplicated receipt index',
  )
  assert.equal(duplicate.details.chunkIndex, 0)

  // A receipt for an index the manifest never declared must be refused. Before the
  // S1 fix this was tolerated because the loop only walked manifest indexes.
  const undeclared = refuses(
    () => contracts.assertChunkSetComplete(goodManifest,
      [receipt(0), receipt(1), receipt(2, { chunkDigest: D('x'), byteCount: 1 })]),
    'SEALED_EXPORT_CHUNK_UNDECLARED', 'receipt beyond the manifest',
  )
  assert.equal(undeclared.details.chunkIndex, 2)

  refuses(() => contracts.assertChunkSetComplete(goodManifest, 'sx-not-an-array'),
    'SEALED_EXPORT_CHUNK_SET_INCOMPLETE', 'non-array receipt set')
}

// ---------------------------------------------------------------------------
// §9.2: no caller value may reach the refusal surface.
// ---------------------------------------------------------------------------
function refusalSurfaceIsValuesFree() {
  const marker = 'ZZ-CONTRACT-VALUE-MARKER-4636'
  const probes = [
    () => contracts.validateExportRequestEnvelope(envelope({ roleId: marker + '-with spaces' })),
    () => contracts.validateSignedManifest(manifest(envelope(), { signerKeyId: marker + ' bad' })),
    () => contracts.validateChunkReceipt(receipt(0, { acceptedAt: marker + ' bad' })),
    () => contracts.validateLifecycleEvidence(evidence({ profileToken: marker + ' bad' })),
    () => contracts.validateExportRequestEnvelope(Object.assign(envelope(), { [marker]: 1 })),
    () => contracts.verifyRowsetAgainstManifest(
      contracts.validateSignedManifest(manifest(envelope())), [{ [marker]: marker }]),
  ]
  for (let index = 0; index < probes.length; index += 1) {
    const error = refuses(probes[index], null, 'values-free probe ' + index)
    const surface = JSON.stringify({
      reason: error.reason, message: error.message, details: error.details, stack: String(error.stack),
    })
    assert.equal(surface.indexOf(marker), -1, 'caller value reached the refusal surface, probe ' + index)
  }

  // Every detail VALUE that does escape must be a declared safe token or a number
  // or a boolean — checked exhaustively over the probes above plus the guards that
  // report counts.
  const detailProbes = [
    () => contracts.validateSignedManifest(manifest(envelope(), { totalBytes: 999 })),
    () => contracts.verifyArtifactAgainstManifest(
      contracts.validateSignedManifest(manifest(envelope())), [CHUNK_BYTES[0]]),
    () => contracts.verifyManifestBinding(envelope({ rowBudget: 0 }), manifest(envelope({ rowBudget: 0 }))),
  ]
  const safeTokens = new Set(vocabulary.SEALED_EXPORT_SAFE_DETAIL_TOKENS)
  const detailFields = new Set(vocabulary.SEALED_EXPORT_DETAIL_FIELDS)
  for (let index = 0; index < detailProbes.length; index += 1) {
    const error = refuses(detailProbes[index], null, 'detail probe ' + index)
    for (const [key, value] of Object.entries(error.details)) {
      assert.equal(detailFields.has(key), true, 'undeclared detail field: ' + key)
      if (typeof value === 'string') {
        assert.equal(safeTokens.has(value), true, 'unsafe detail token: ' + value)
      } else {
        assert.ok(typeof value === 'boolean' || Number.isSafeInteger(value),
          'detail values must be tokens, booleans or counts')
      }
    }
  }
}

function canonicalBytesFailClosed() {
  // A canonicalization that did NOT succeed must not become an empty digest.
  refuses(() => contracts.canonicalEnvelopeBytes({ bad: undefined }),
    'SEALED_EXPORT_INTERNAL_ERROR', 'uncanonicalizable envelope')
  refuses(() => contracts.computeSignedManifestBytes({}),
    'SEALED_EXPORT_MANIFEST_INVALID', 'manifest missing every field')

  // POSITIVE CONTROL — a real envelope canonicalizes to recognisable canonical bytes.
  const canonicalBytes = contracts.canonicalEnvelopeBytes(envelope())
  assert.ok(canonicalBytes instanceof Uint8Array)
  assert.equal(codec.isCanonicalJsonText(canonicalBytes), true, 'envelope bytes are canonical')

  // The digest is stable across key insertion order — the whole point of §6.3.
  const shuffled = {}
  for (const key of Object.keys(envelope()).reverse()) shuffled[key] = envelope()[key]
  assert.equal(
    contracts.computeExportRequestEnvelopeDigest(shuffled),
    contracts.computeExportRequestEnvelopeDigest(envelope()),
    'property order must not change the envelope digest',
  )
}

function main() {
  documentShapePins()
  closedMeansRefused()
  fieldTypesAreClosed()
  chunkListIsClosed()
  declaredCountsAreChecked()
  artifactVerificationRecomputes()
  rowsetVerificationRecomputes()
  bindingCoversEveryTerm()
  budgetsAreCheckedNotBelieved()
  snapshotProofIsNotRelabelled()
  chunkSubmissionClassification()
  chunkSetCompletenessRefusesDuplicatesAndUndeclared()
  refusalSurfaceIsValuesFree()
  canonicalBytesFailClosed()
  console.log('sealed-export-contracts.test.cjs OK')
}

main()
