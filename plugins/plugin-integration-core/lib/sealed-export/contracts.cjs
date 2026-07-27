'use strict'

// Sealed-export S1 — strict owned closed schemas and validators (issue #4636
// deliverable 2), plus the §6.2 binding map and the §6.3/§6.4 data checks.
//
// LATENT: no runtime consumer, no route, no scheduler, no storage, no session, no
// blob, no lease, no CAS, no source read. Every function here is pure over
// caller-supplied data.
//
// TRUST BOUNDARY (§6.0). First-party connector code and the server verifier are
// trusted CODE; what a connector SENDS is untrusted DATA. That distinction sets the
// structural refusal reason:
//   - SIGNED_MANIFEST / CHUNK_DESCRIPTOR / CHUNK_RECEIPT / CHUNK_SUBMISSION arrive
//     from the connector -> a malformed one is SEALED_EXPORT_MANIFEST_INVALID;
//   - EXPORT_REQUEST_ENVELOPE is "issued and authenticated by the server" (§6.1) and
//     LIFECYCLE_EVIDENCE is produced by the server, so a malformed one is a
//     first-party defect -> the fixed SEALED_EXPORT_INTERNAL_ERROR.
// §10 names no per-object structural reason; this two-way mapping reuses tokens the
// vocabulary already declares rather than inventing one.
//
// CLOSED means REFUSED, not dropped: an unknown key fails the whole object.
//
// FIELD NAMES. §6.1 names some fields in backticks and others in prose. Prose terms
// were given the narrowest faithful name; the mapping is in ./README.md and in the
// PR body, and no field exists here that §6/§9 does not name.

const { failSealedExport, isDeclaredFailureReason } = require('./failure-vocabulary.cjs')
const canonicalCodec = require('./canonical-json.cjs')
const {
  isLowerHexDigest,
  digestBytes,
  computeChunkDigest,
  computeWholeArtifactByteDigest,
  computeCanonicalRowsetMultiplicityDigest,
  constantTimeEqualDigest,
} = require('./digests.cjs')

const SEALED_EXPORT_CONTRACT_OBJECTS = Object.freeze([
  'EXPORT_REQUEST_ENVELOPE',
  'SIGNED_MANIFEST',
  'CHUNK_DESCRIPTOR',
  'CHUNK_RECEIPT',
  'CHUNK_SUBMISSION',
  'LIFECYCLE_EVIDENCE',
])

// Objects whose bytes arrive from a connector.
const CONNECTOR_ORIGIN_OBJECTS = Object.freeze([
  'SIGNED_MANIFEST',
  'CHUNK_DESCRIPTOR',
  'CHUNK_RECEIPT',
  'CHUNK_SUBMISSION',
])

// §5 froze exactly these three capture-consistency classes. "or another independently
// ratified source-time mechanism" is deliberately NOT modelled as an extension point:
// an open extension point in a latent contract is an invitation to smuggle.
const SEALED_EXPORT_SOURCE_CAPTURE_PROOF_CLASSES = Object.freeze([
  'IMMUTABLE_SNAPSHOT_TOKEN',
  'SOURCE_SNAPSHOT_TXN',
  'NOT_REQUIRED',
])

// §7 names ACTIVE explicitly; §10 names the unenrolled/expired/revoked conditions.
const SEALED_EXPORT_SIGNER_LIFECYCLE_STATES = Object.freeze([
  'UNENROLLED',
  'ACTIVE',
  'EXPIRED',
  'REVOKED',
])

// §9.1 "success/failure status".
const SEALED_EXPORT_EVIDENCE_STATUSES = Object.freeze(['SUCCESS', 'FAILURE'])

const SEALED_EXPORT_BUDGET_TOKENS = Object.freeze(['ROW_BUDGET', 'BYTE_BUDGET', 'CHUNK_BUDGET'])

// §6.4 "Re-sending an already accepted identical tuple is an idempotent replay".
const SEALED_EXPORT_SUBMISSION_DECISIONS = Object.freeze(['ACCEPT', 'IDEMPOTENT_REPLAY'])

const IDENTIFIER_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-'
const BASE64ISH_CHARSET = IDENTIFIER_CHARSET + '+/='

const TOKEN = Object.freeze({ kind: 'token', charset: IDENTIFIER_CHARSET, maxLength: 128 })
const OPAQUE = Object.freeze({ kind: 'token', charset: BASE64ISH_CHARSET, maxLength: 2048 })
const DIGEST = Object.freeze({ kind: 'digest' })
const COUNT = Object.freeze({ kind: 'count' })
const BOOL = Object.freeze({ kind: 'boolean' })
const FALSE_ONLY = Object.freeze({ kind: 'literalFalse' })
const CHUNK_LIST = Object.freeze({ kind: 'chunkDescriptorList' })
const NULLABLE_REASON = Object.freeze({ kind: 'nullableReason' })

function enumOf(members) {
  return Object.freeze({ kind: 'enum', members })
}

// ---------------------------------------------------------------------------
// §6.1(1) Export request envelope — server-issued.
// ---------------------------------------------------------------------------
const EXPORT_REQUEST_ENVELOPE_SCHEMA = Object.freeze({
  exportRequestId: TOKEN,
  nonce: TOKEN,
  expiry: TOKEN,
  scenarioVersion: TOKEN,
  bindingVersion: TOKEN,
  roleId: TOKEN,
  actionProfileVersion: TOKEN,
  roleBindingFingerprint: TOKEN,
  systemContentKey: TOKEN,
  approvedConfigVersionId: TOKEN,
  configContentKey: TOKEN,
  canonicalObjectVersion: TOKEN,
  qualificationDigest: DIGEST,
  executionMode: TOKEN,
  applyProfileVersion: TOKEN,
  queryObjectFilterBindingDigest: DIGEST,
  expectedSourceSchemaFieldMapDigest: DIGEST,
  tenantDomainBinding: TOKEN,
  rowBudget: COUNT,
  byteBudget: COUNT,
  chunkBudget: COUNT,
})

// ---------------------------------------------------------------------------
// §6.1(2) Signed manifest — agent-produced, untrusted bytes.
// ---------------------------------------------------------------------------
const SIGNED_MANIFEST_SCHEMA = Object.freeze({
  exportRequestEnvelopeDigest: DIGEST,
  sourceCaptureIdentity: TOKEN,
  sourceCaptureProofClass: enumOf(SEALED_EXPORT_SOURCE_CAPTURE_PROOF_CLASSES),
  agentImplementationVersion: TOKEN,
  agentProtocolVersion: TOKEN,
  encodingVersion: TOKEN,
  canonicalizationVersion: TOKEN,
  sourceSchemaDigest: DIGEST,
  totalRows: COUNT,
  totalBytes: COUNT,
  chunks: CHUNK_LIST,
  wholeArtifactByteDigest: DIGEST,
  canonicalRowsetMultiplicityDigest: DIGEST,
  captureCompletionTimestamp: TOKEN,
  manifestExpiry: TOKEN,
  signerKeyId: TOKEN,
  signatureAlgorithm: TOKEN,
  signature: OPAQUE,
})

// The signature cannot cover itself. §5 says the agent signs "the unsigned manifest
// payload"; that payload is every manifest field except `signature`.
const SIGNED_MANIFEST_SIGNATURE_FIELD = 'signature'

const CHUNK_DESCRIPTOR_SCHEMA = Object.freeze({
  chunkIndex: COUNT,
  chunkDigest: DIGEST,
  byteCount: COUNT,
})

// §6.4 verbatim: "A receipt is (manifestDigest, chunkIndex, chunkDigest, byteCount,
// acceptedAt)."
const CHUNK_RECEIPT_SCHEMA = Object.freeze({
  manifestDigest: DIGEST,
  chunkIndex: COUNT,
  chunkDigest: DIGEST,
  byteCount: COUNT,
  acceptedAt: TOKEN,
})

// The same tuple before acceptance — acceptedAt is assigned by the accepting side, so
// a submission cannot carry it.
const CHUNK_SUBMISSION_SCHEMA = Object.freeze({
  manifestDigest: DIGEST,
  chunkIndex: COUNT,
  chunkDigest: DIGEST,
  byteCount: COUNT,
})

// ---------------------------------------------------------------------------
// §9.1 public values-free evidence — exactly the permitted contents, nothing else.
// The §9.2 prohibition is enforced structurally: there is no key for a row, a value,
// an object name, an endpoint, a path, a credential, a raw filter, a query, a
// snapshot token, a cursor, a nonce, a signature, a key, or a raw content hash, and
// unknown keys are refused rather than dropped.
// ---------------------------------------------------------------------------
const LIFECYCLE_EVIDENCE_SCHEMA = Object.freeze({
  profileToken: TOKEN,
  proofClassToken: enumOf(SEALED_EXPORT_SOURCE_CAPTURE_PROOF_CLASSES),
  status: enumOf(SEALED_EXPORT_EVIDENCE_STATUSES),
  reason: NULLABLE_REASON,
  rowCount: COUNT,
  byteCount: COUNT,
  chunkCount: COUNT,
  duration: COUNT,
  retryCount: COUNT,
  manifestPresent: BOOL,
  signingKeyPresent: BOOL,
  domainIsolatedManifestDigest: DIGEST,
  domainIsolatedArtifactDigest: DIGEST,
  domainIsolatedSchemaDigest: DIGEST,
  domainIsolatedGenerationDigest: DIGEST,
  signerLifecycleState: enumOf(SEALED_EXPORT_SIGNER_LIFECYCLE_STATES),
  externalWrite: FALSE_ONLY,
  cleanupOutcome: TOKEN,
  activePointerOutcome: TOKEN,
})

const SCHEMAS_BY_OBJECT = Object.freeze({
  EXPORT_REQUEST_ENVELOPE: EXPORT_REQUEST_ENVELOPE_SCHEMA,
  SIGNED_MANIFEST: SIGNED_MANIFEST_SCHEMA,
  CHUNK_DESCRIPTOR: CHUNK_DESCRIPTOR_SCHEMA,
  CHUNK_RECEIPT: CHUNK_RECEIPT_SCHEMA,
  CHUNK_SUBMISSION: CHUNK_SUBMISSION_SCHEMA,
  LIFECYCLE_EVIDENCE: LIFECYCLE_EVIDENCE_SCHEMA,
})

function structuralReasonFor(objectName) {
  return CONNECTOR_ORIGIN_OBJECTS.indexOf(objectName) >= 0
    ? 'SEALED_EXPORT_MANIFEST_INVALID'
    : 'SEALED_EXPORT_INTERNAL_ERROR'
}

function refuseStructure(objectName, field) {
  const details = field === undefined
    ? { object: objectName }
    : { object: objectName, field }
  failSealedExport(structuralReasonFor(objectName), details)
}

function isTokenValue(value, spec) {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > spec.maxLength) return false
  for (let index = 0; index < value.length; index += 1) {
    if (spec.charset.indexOf(value.charAt(index)) < 0) return false
  }
  return true
}

function isCountValue(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function assertClosedObjectShape(objectName, input) {
  if (!canonicalCodec.__internals.isStrictPlainObject(input)) refuseStructure(objectName)
  const schema = SCHEMAS_BY_OBJECT[objectName]
  const present = Object.keys(input)
  for (let index = 0; index < present.length; index += 1) {
    // CLOSED: an unknown key is refused, never dropped.
    if (!Object.prototype.hasOwnProperty.call(schema, present[index])) {
      refuseStructure(objectName, undefined)
    }
  }
  const expected = Object.keys(schema)
  for (let index = 0; index < expected.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(input, expected[index])) {
      refuseStructure(objectName, expected[index])
    }
  }
  return schema
}

function validateFieldValue(objectName, field, spec, value) {
  if (spec.kind === 'token') {
    if (!isTokenValue(value, spec)) refuseStructure(objectName, field)
    return value
  }
  if (spec.kind === 'digest') {
    if (!isLowerHexDigest(value)) refuseStructure(objectName, field)
    return value
  }
  if (spec.kind === 'count') {
    if (!isCountValue(value)) refuseStructure(objectName, field)
    return value
  }
  if (spec.kind === 'boolean') {
    if (typeof value !== 'boolean') refuseStructure(objectName, field)
    return value
  }
  if (spec.kind === 'literalFalse') {
    // §9.1 lists `externalWrite=false`; true is not a legal value of this contract.
    if (value !== false) refuseStructure(objectName, field)
    return value
  }
  if (spec.kind === 'enum') {
    if (typeof value !== 'string' || spec.members.indexOf(value) < 0) refuseStructure(objectName, field)
    return value
  }
  if (spec.kind === 'nullableReason') {
    if (value === null) return null
    if (!isDeclaredFailureReason(value)) refuseStructure(objectName, field)
    return value
  }
  if (spec.kind === 'chunkDescriptorList') {
    if (!canonicalCodec.__internals.isStrictDenseArray(value)) refuseStructure(objectName, field)
    if (value.length === 0) {
      // A sealed export with no chunk has nothing to prove complete.
      failSealedExport('SEALED_EXPORT_CHUNK_SET_INCOMPLETE', { object: objectName, observedCount: 0 })
    }
    const descriptors = []
    for (let index = 0; index < value.length; index += 1) {
      descriptors.push(validateChunkDescriptor(value[index]))
    }
    return Object.freeze(descriptors)
  }
  refuseStructure(objectName, field)
  return undefined
}

function validateClosedObject(objectName, input) {
  const schema = assertClosedObjectShape(objectName, input)
  const fields = Object.keys(schema)
  const out = {}
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    const descriptor = Object.getOwnPropertyDescriptor(input, field)
    const value = validateFieldValue(objectName, field, schema[field], descriptor.value)
    Object.defineProperty(out, field, {
      value,
      enumerable: true,
      writable: false,
      configurable: false,
    })
  }
  return Object.freeze(out)
}

function validateChunkDescriptor(input) {
  return validateClosedObject('CHUNK_DESCRIPTOR', input)
}

function validateExportRequestEnvelope(input) {
  return validateClosedObject('EXPORT_REQUEST_ENVELOPE', input)
}

function validateChunkReceipt(input) {
  return validateClosedObject('CHUNK_RECEIPT', input)
}

function validateChunkSubmission(input) {
  return validateClosedObject('CHUNK_SUBMISSION', input)
}

function validateSignedManifest(input) {
  const manifest = validateClosedObject('SIGNED_MANIFEST', input)
  // §6.4 "A new chunk must be the next unaccepted manifest index" only means anything
  // if the manifest itself declares 0..n-1 exactly once, in order.
  for (let index = 0; index < manifest.chunks.length; index += 1) {
    if (manifest.chunks[index].chunkIndex !== index) {
      failSealedExport('SEALED_EXPORT_CHUNK_ORDER_INVALID', {
        expectedChunkIndex: index,
        chunkIndex: manifest.chunks[index].chunkIndex,
      })
    }
  }
  // Declared totals are checked against the manifest's own chunk descriptors rather
  // than believed.
  let declaredBytes = 0
  for (let index = 0; index < manifest.chunks.length; index += 1) {
    declaredBytes += manifest.chunks[index].byteCount
  }
  if (declaredBytes !== manifest.totalBytes) {
    failSealedExport('SEALED_EXPORT_MANIFEST_INVALID', {
      field: 'totalBytes',
      declaredCount: manifest.totalBytes,
      observedCount: declaredBytes,
    })
  }
  if (manifest.canonicalizationVersion !== canonicalCodec.SEALED_EXPORT_CANONICALIZATION_VERSION) {
    failSealedExport('SEALED_EXPORT_MANIFEST_INVALID', { field: 'canonicalizationVersion' })
  }
  return manifest
}

function validateLifecycleEvidence(input) {
  const evidence = validateClosedObject('LIFECYCLE_EVIDENCE', input)
  // §9.1 pairs "success/failure status and closed reason": a success carries no
  // reason, a failure carries a vocabulary member. Both directions fail closed.
  if (evidence.status === 'SUCCESS' && evidence.reason !== null) {
    refuseStructure('LIFECYCLE_EVIDENCE', 'reason')
  }
  if (evidence.status === 'FAILURE' && evidence.reason === null) {
    refuseStructure('LIFECYCLE_EVIDENCE', 'reason')
  }
  return evidence
}

// ---------------------------------------------------------------------------
// Canonical byte forms.
// ---------------------------------------------------------------------------
function canonicalizeOrFail(objectName, value) {
  const canonical = canonicalCodec.tryCanonicalJson(value)
  if (!canonical.ok) {
    // A canonicalization that did not succeed is NOT an empty digest.
    failSealedExport(structuralReasonFor(objectName), { object: objectName, canonical: false })
  }
  return canonical
}

function canonicalEnvelopeBytes(envelope) {
  return canonicalizeOrFail('EXPORT_REQUEST_ENVELOPE', envelope).bytes
}

function computeExportRequestEnvelopeDigest(envelope) {
  const probe = digestBytes(canonicalEnvelopeBytes(envelope))
  if (!probe.ok) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR', { object: 'EXPORT_REQUEST_ENVELOPE' })
  return probe.digest
}

function unsignedManifestPayload(manifest) {
  const out = {}
  const fields = Object.keys(SIGNED_MANIFEST_SCHEMA)
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (field === SIGNED_MANIFEST_SIGNATURE_FIELD) continue
    Object.defineProperty(out, field, {
      value: manifest[field],
      enumerable: true,
      writable: false,
      configurable: false,
    })
  }
  return Object.freeze(out)
}

function computeSignedManifestBytes(manifest) {
  return canonicalizeOrFail('SIGNED_MANIFEST', unsignedManifestPayload(manifest)).bytes
}

function computeManifestDigest(manifest) {
  const probe = digestBytes(computeSignedManifestBytes(manifest))
  if (!probe.ok) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR', { object: 'SIGNED_MANIFEST' })
  return probe.digest
}

// ---------------------------------------------------------------------------
// §6.2 required binding — the term list is the document's, verbatim.
// ---------------------------------------------------------------------------
const SEALED_EXPORT_BINDING_TERMS = Object.freeze([
  Object.freeze({
    term: 'query/filter identity',
    bindings: Object.freeze([Object.freeze(['EXPORT_REQUEST_ENVELOPE', 'queryObjectFilterBindingDigest'])]),
  }),
  Object.freeze({
    term: 'canonical object and schema contract',
    bindings: Object.freeze([
      Object.freeze(['EXPORT_REQUEST_ENVELOPE', 'canonicalObjectVersion']),
      Object.freeze(['EXPORT_REQUEST_ENVELOPE', 'expectedSourceSchemaFieldMapDigest']),
      Object.freeze(['SIGNED_MANIFEST', 'sourceSchemaDigest']),
    ]),
  }),
  Object.freeze({
    term: 'scenarioVersion, bindingVersion, and roleId',
    bindings: Object.freeze([
      Object.freeze(['EXPORT_REQUEST_ENVELOPE', 'scenarioVersion']),
      Object.freeze(['EXPORT_REQUEST_ENVELOPE', 'bindingVersion']),
      Object.freeze(['EXPORT_REQUEST_ENVELOPE', 'roleId']),
    ]),
  }),
  Object.freeze({
    term: 'roleBindingFingerprint and actionProfileVersion',
    bindings: Object.freeze([
      Object.freeze(['EXPORT_REQUEST_ENVELOPE', 'roleBindingFingerprint']),
      Object.freeze(['EXPORT_REQUEST_ENVELOPE', 'actionProfileVersion']),
    ]),
  }),
  Object.freeze({
    term: 'systemContentKey',
    bindings: Object.freeze([Object.freeze(['EXPORT_REQUEST_ENVELOPE', 'systemContentKey'])]),
  }),
  Object.freeze({
    term: 'approvedConfigVersionId and configContentKey',
    bindings: Object.freeze([
      Object.freeze(['EXPORT_REQUEST_ENVELOPE', 'approvedConfigVersionId']),
      Object.freeze(['EXPORT_REQUEST_ENVELOPE', 'configContentKey']),
    ]),
  }),
  Object.freeze({
    term: 'canonicalObjectVersion and qualificationDigest',
    bindings: Object.freeze([
      Object.freeze(['EXPORT_REQUEST_ENVELOPE', 'canonicalObjectVersion']),
      Object.freeze(['EXPORT_REQUEST_ENVELOPE', 'qualificationDigest']),
    ]),
  }),
  Object.freeze({
    term: 'executionMode and applyProfileVersion',
    bindings: Object.freeze([
      Object.freeze(['EXPORT_REQUEST_ENVELOPE', 'executionMode']),
      Object.freeze(['EXPORT_REQUEST_ENVELOPE', 'applyProfileVersion']),
    ]),
  }),
  Object.freeze({
    term: 'source snapshot identity',
    bindings: Object.freeze([Object.freeze(['SIGNED_MANIFEST', 'sourceCaptureIdentity'])]),
  }),
  Object.freeze({
    term: 'export request nonce',
    bindings: Object.freeze([Object.freeze(['EXPORT_REQUEST_ENVELOPE', 'nonce'])]),
  }),
  Object.freeze({
    term: 'ordered chunk identities and digests',
    bindings: Object.freeze([Object.freeze(['SIGNED_MANIFEST', 'chunks'])]),
  }),
  Object.freeze({
    term: 'row count and byte count',
    bindings: Object.freeze([
      Object.freeze(['SIGNED_MANIFEST', 'totalRows']),
      Object.freeze(['SIGNED_MANIFEST', 'totalBytes']),
    ]),
  }),
  Object.freeze({
    term: 'whole artifact digest',
    bindings: Object.freeze([Object.freeze(['SIGNED_MANIFEST', 'wholeArtifactByteDigest'])]),
  }),
  Object.freeze({
    term: 'signer identity and manifest expiry',
    bindings: Object.freeze([
      Object.freeze(['SIGNED_MANIFEST', 'signerKeyId']),
      Object.freeze(['SIGNED_MANIFEST', 'manifestExpiry']),
    ]),
  }),
])

// §6.1: the manifest carries the "exact digest of the export request envelope", so
// every envelope term is bound transitively through that digest.
function verifyManifestBinding(envelope, manifest) {
  const expectedEnvelopeDigest = computeExportRequestEnvelopeDigest(envelope)
  if (!constantTimeEqualDigest(expectedEnvelopeDigest, manifest.exportRequestEnvelopeDigest)) {
    failSealedExport('SEALED_EXPORT_MANIFEST_BINDING_MISMATCH', {
      field: 'exportRequestEnvelopeDigest',
    })
  }
  if (!constantTimeEqualDigest(envelope.expectedSourceSchemaFieldMapDigest, manifest.sourceSchemaDigest)) {
    failSealedExport('SEALED_EXPORT_MANIFEST_SCHEMA_MISMATCH', { field: 'sourceSchemaDigest' })
  }
  if (manifest.totalRows > envelope.rowBudget) {
    failSealedExport('SEALED_EXPORT_BUDGET_EXCEEDED', { budget: 'ROW_BUDGET' })
  }
  if (manifest.totalBytes > envelope.byteBudget) {
    failSealedExport('SEALED_EXPORT_BUDGET_EXCEEDED', { budget: 'BYTE_BUDGET' })
  }
  if (manifest.chunks.length > envelope.chunkBudget) {
    failSealedExport('SEALED_EXPORT_BUDGET_EXCEEDED', { budget: 'CHUNK_BUDGET' })
  }
  return Object.freeze({ manifestDigest: computeManifestDigest(manifest) })
}

// ---------------------------------------------------------------------------
// §5 source-time consistency. The document's central warning made mechanical:
// "The signer, manifest digest, export ID, or completion timestamp must never be
// relabeled as a source snapshot proof", and IMMUTABLE_SNAPSHOT_TOKEN "describes the
// sealed artifact after capture. It is NOT sufficient evidence that the source rows
// came from one point in time."
// ---------------------------------------------------------------------------
function resolveSourceTimeConsistencyProof(pointInTimeSourceConsistencyRequired, manifest) {
  if (typeof pointInTimeSourceConsistencyRequired !== 'boolean') {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR', { field: 'proofClassToken' })
  }
  const declared = manifest.sourceCaptureProofClass
  if (pointInTimeSourceConsistencyRequired) {
    if (declared !== 'SOURCE_SNAPSHOT_TXN') {
      failSealedExport('SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE', { proofClass: declared })
    }
    return Object.freeze({ proofClassToken: 'SOURCE_SNAPSHOT_TXN' })
  }
  // §5: "if the scenario does not require it, run evidence must explicitly record the
  // consistency requirement as NOT_REQUIRED" — explicitly, so anything else fails.
  if (declared !== 'NOT_REQUIRED') {
    failSealedExport('SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE', { proofClass: declared })
  }
  return Object.freeze({ proofClassToken: 'NOT_REQUIRED' })
}

// ---------------------------------------------------------------------------
// §6.3 artifact verification against the manifest — counts and digests are computed,
// never believed.
// ---------------------------------------------------------------------------
function verifyArtifactAgainstManifest(manifest, orderedChunkBytes) {
  if (!Array.isArray(orderedChunkBytes) || orderedChunkBytes.length !== manifest.chunks.length) {
    failSealedExport('SEALED_EXPORT_CHUNK_SET_INCOMPLETE', {
      declaredCount: manifest.chunks.length,
      observedCount: Array.isArray(orderedChunkBytes) ? orderedChunkBytes.length : 0,
    })
  }
  let observedBytes = 0
  for (let index = 0; index < orderedChunkBytes.length; index += 1) {
    const bytes = orderedChunkBytes[index]
    const descriptor = manifest.chunks[index]
    if (!(bytes instanceof Uint8Array) || bytes.length !== descriptor.byteCount) {
      failSealedExport('SEALED_EXPORT_CHUNK_DIGEST_MISMATCH', { chunkIndex: index })
    }
    const digest = computeChunkDigest(bytes)
    if (!digest.ok || !constantTimeEqualDigest(digest.digest, descriptor.chunkDigest)) {
      failSealedExport('SEALED_EXPORT_CHUNK_DIGEST_MISMATCH', { chunkIndex: index })
    }
    observedBytes += bytes.length
  }
  const whole = computeWholeArtifactByteDigest(orderedChunkBytes)
  if (!whole.ok || !constantTimeEqualDigest(whole.digest, manifest.wholeArtifactByteDigest)) {
    failSealedExport('SEALED_EXPORT_ARTIFACT_DIGEST_MISMATCH', { field: 'wholeArtifactByteDigest' })
  }
  return Object.freeze({ chunkCount: orderedChunkBytes.length, byteCount: observedBytes })
}

// §6.3: "The server independently parses the artifact and recomputes row count plus a
// multiset-aware canonical row digest."
function verifyRowsetAgainstManifest(manifest, rows) {
  if (!Array.isArray(rows)) {
    failSealedExport('SEALED_EXPORT_ROW_COUNT_MISMATCH', { declaredCount: manifest.totalRows })
  }
  if (rows.length !== manifest.totalRows) {
    failSealedExport('SEALED_EXPORT_ROW_COUNT_MISMATCH', {
      declaredCount: manifest.totalRows,
      observedCount: rows.length,
    })
  }
  const digest = computeCanonicalRowsetMultiplicityDigest(rows, canonicalCodec)
  if (!digest.ok) {
    failSealedExport('SEALED_EXPORT_MANIFEST_INVALID', {
      field: 'canonicalRowsetMultiplicityDigest',
      canonical: false,
    })
  }
  // §10 declares no rowset-digest-specific reason; ARTIFACT_DIGEST_MISMATCH is the
  // nearest declared token and is preferred to inventing one.
  if (!constantTimeEqualDigest(digest.digest, manifest.canonicalRowsetMultiplicityDigest)) {
    failSealedExport('SEALED_EXPORT_ARTIFACT_DIGEST_MISMATCH', {
      field: 'canonicalRowsetMultiplicityDigest',
    })
  }
  return Object.freeze({ rowCount: rows.length })
}

// ---------------------------------------------------------------------------
// §6.4 chunk ordering, duplication and replay classification.
//
// PURE. No upload session is created, nothing is persisted, no nonce is consumed and
// no tombstone is consulted — those are S3/S4 and are out of scope, which is why
// SEALED_EXPORT_MANIFEST_REPLAYED stays in the S1-unreached partition.
// ---------------------------------------------------------------------------
function classifyChunkSubmission(manifest, manifestDigest, acceptedReceipts, submission) {
  if (!isLowerHexDigest(manifestDigest)) {
    failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID', { field: 'manifestDigest' })
  }
  const validSubmission = validateChunkSubmission(submission)
  // §6.4: "An upload session is keyed by the immutable manifest digest."
  if (!constantTimeEqualDigest(validSubmission.manifestDigest, manifestDigest)) {
    failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID', { field: 'manifestDigest' })
  }
  if (!Array.isArray(acceptedReceipts)) {
    failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID', { object: 'CHUNK_RECEIPT' })
  }
  const acceptedByIndex = new Map()
  for (let index = 0; index < acceptedReceipts.length; index += 1) {
    const receipt = validateChunkReceipt(acceptedReceipts[index])
    if (!constantTimeEqualDigest(receipt.manifestDigest, manifestDigest)) {
      failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID', { field: 'manifestDigest' })
    }
    if (acceptedByIndex.has(receipt.chunkIndex)) {
      failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID', { chunkIndex: receipt.chunkIndex })
    }
    acceptedByIndex.set(receipt.chunkIndex, receipt)
  }
  // §6.4 resume "asks only for accepted receipt indexes"; an accepted set with a hole
  // is not a state this protocol can produce, so it is refused rather than repaired.
  for (let index = 0; index < acceptedByIndex.size; index += 1) {
    if (!acceptedByIndex.has(index)) {
      failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID', { expectedChunkIndex: index })
    }
  }

  const declared = validSubmission.chunkIndex < manifest.chunks.length
    ? manifest.chunks[validSubmission.chunkIndex]
    : null
  if (declared === null) {
    failSealedExport('SEALED_EXPORT_CHUNK_UNDECLARED', { chunkIndex: validSubmission.chunkIndex })
  }

  const already = acceptedByIndex.get(validSubmission.chunkIndex)
  if (already !== undefined) {
    const identical = constantTimeEqualDigest(already.chunkDigest, validSubmission.chunkDigest)
      && already.byteCount === validSubmission.byteCount
    if (!identical) {
      // §6.4: "Re-sending an accepted index with different bytes is a conflicting
      // duplicate and fails closed."
      failSealedExport('SEALED_EXPORT_CHUNK_DUPLICATE_CONFLICT', {
        chunkIndex: validSubmission.chunkIndex,
      })
    }
    // §6.4: an identical re-send "is an idempotent replay and does not increment counts".
    return Object.freeze({
      decision: 'IDEMPOTENT_REPLAY',
      acceptedChunkCount: acceptedByIndex.size,
    })
  }

  // §6.4: "A new chunk must be the next unaccepted manifest index." / "Skipping or
  // reordering a new index fails closed."
  const expectedIndex = acceptedByIndex.size
  if (validSubmission.chunkIndex !== expectedIndex) {
    failSealedExport('SEALED_EXPORT_CHUNK_ORDER_INVALID', {
      expectedChunkIndex: expectedIndex,
      chunkIndex: validSubmission.chunkIndex,
    })
  }
  if (!constantTimeEqualDigest(validSubmission.chunkDigest, declared.chunkDigest)
    || validSubmission.byteCount !== declared.byteCount) {
    failSealedExport('SEALED_EXPORT_CHUNK_DIGEST_MISMATCH', {
      chunkIndex: validSubmission.chunkIndex,
    })
  }
  return Object.freeze({
    decision: 'ACCEPT',
    acceptedChunkCount: acceptedByIndex.size + 1,
  })
}

function assertChunkSetComplete(manifest, acceptedReceipts) {
  const seen = new Set()
  if (!Array.isArray(acceptedReceipts)) {
    failSealedExport('SEALED_EXPORT_CHUNK_SET_INCOMPLETE', { declaredCount: manifest.chunks.length })
  }
  for (let index = 0; index < acceptedReceipts.length; index += 1) {
    seen.add(validateChunkReceipt(acceptedReceipts[index]).chunkIndex)
  }
  for (let index = 0; index < manifest.chunks.length; index += 1) {
    if (!seen.has(index)) {
      failSealedExport('SEALED_EXPORT_CHUNK_SET_INCOMPLETE', {
        declaredCount: manifest.chunks.length,
        observedCount: seen.size,
      })
    }
  }
  return Object.freeze({ chunkCount: manifest.chunks.length })
}

module.exports = {
  SEALED_EXPORT_CONTRACT_OBJECTS,
  SEALED_EXPORT_SOURCE_CAPTURE_PROOF_CLASSES,
  SEALED_EXPORT_SIGNER_LIFECYCLE_STATES,
  SEALED_EXPORT_EVIDENCE_STATUSES,
  SEALED_EXPORT_BUDGET_TOKENS,
  SEALED_EXPORT_SUBMISSION_DECISIONS,
  SEALED_EXPORT_BINDING_TERMS,
  SIGNED_MANIFEST_SIGNATURE_FIELD,
  SCHEMAS_BY_OBJECT,
  validateExportRequestEnvelope,
  validateSignedManifest,
  validateChunkDescriptor,
  validateChunkReceipt,
  validateChunkSubmission,
  validateLifecycleEvidence,
  canonicalEnvelopeBytes,
  computeExportRequestEnvelopeDigest,
  unsignedManifestPayload,
  computeSignedManifestBytes,
  computeManifestDigest,
  verifyManifestBinding,
  resolveSourceTimeConsistencyProof,
  verifyArtifactAgainstManifest,
  verifyRowsetAgainstManifest,
  classifyChunkSubmission,
  assertChunkSetComplete,
}
