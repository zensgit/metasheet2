'use strict'

// GIP-D0 A1 — profile-certification contracts battery. Plain node test (throws on
// failure). Hermetic: no DB, no network, no runtime wiring. Values-free fixtures.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  GIP_ACQUISITION_MODES,
  GIP_CONSISTENCY_PROOFS,
  GIP_CONTINUATION_LIFETIMES,
  GIP_COMPLETENESS_PROOFS,
  GIP_APPLY_MODES,
  GIP_RECOVERY_STRATEGIES,
  GIP_ROLE_TYPES,
  GIP_CROSS_ROLE_TEMPORAL_POLICIES,
  GIP_CONSISTENCY_REQUIREMENT_STATUSES,
  GIP_PROFILE_ERROR_REASONS,
  GipProfileContractError,
  isValidProfileId,
  normalizeCertifiedReadActionProfile,
  normalizeCertifiedApplyProfile,
  deriveRecoveryStrategy,
  validateConsistencyEvidence,
  validateCompletenessEvidence,
  assertRoleTypeAllowed,
  __internals,
} = require(path.join(__dirname, '..', 'lib', 'gip-profile-certification-contracts.cjs'))

function rejectsWith(fn, reason) {
  let caught = null
  try {
    fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof GipProfileContractError, `expected contract error (${reason})`)
  assert.equal(caught.reason, reason)
  return caught
}

// Synthetic fixture — the `fixture.` namespace is NOT a certifiable connector kind;
// no concrete profile (bridge.*, sql.*, file.*) is certified by this suite.
function fixtureProfile(overrides = {}) {
  const base = {
    profileId: 'fixture.paged_read.v1',
    connectorKind: 'fixture',
    actionId: 'paged_read',
    implementationVersion: 'spike-0',
    certificate: {
      acquisitionMode: 'PAGED_READ',
      supportedConsistencyProofs: ['SOURCE_SNAPSHOT_TXN'],
      continuationLifetime: 'CONNECTION_BOUND',
      supportedCompletenessProofs: ['SHORT_PAGE', 'DECLARED_TOTAL'],
    },
  }
  return { ...base, ...overrides, certificate: { ...base.certificate, ...(overrides.certificate || {}) } }
}

// ── 1. Frozen vocabularies: EXACT pins (sneaking/dropping a value fails closed) ──
function frozenVocabularies() {
  assert.deepEqual([...GIP_ACQUISITION_MODES], ['BOUNDED_READ', 'PAGED_READ', 'SEALED_EXPORT', 'CHANGE_FEED'])
  assert.deepEqual([...GIP_CONSISTENCY_PROOFS], ['SOURCE_SNAPSHOT_TXN', 'IMMUTABLE_SNAPSHOT_TOKEN', 'MONOTONIC_VERSION_PIN'])
  assert.deepEqual([...GIP_CONTINUATION_LIFETIMES], ['SINGLE_REQUEST', 'CONNECTION_BOUND', 'DURABLE_TOKEN'])
  assert.deepEqual([...GIP_COMPLETENESS_PROOFS], ['SHORT_PAGE', 'DECLARED_TOTAL', 'SIGNED_MANIFEST'])
  assert.deepEqual([...GIP_APPLY_MODES], ['SYNCHRONOUS_UOW', 'STAGED_GENERATION'])
  assert.deepEqual([...GIP_RECOVERY_STRATEGIES], ['WHOLE_RERUN', 'WHOLE_ROUND_RESTART', 'PAGE_RESUME', 'CHUNK_RESUME'])
  assert.deepEqual([...GIP_ROLE_TYPES], ['EXTERNAL_READ_SOURCE', 'INTERNAL_APPLY_TARGET', 'EXTERNAL_WRITE_TARGET'])
  assert.deepEqual([...GIP_CROSS_ROLE_TEMPORAL_POLICIES], ['DISCLOSE_ONLY', 'MAX_CAPTURE_GAP', 'COMMON_EFFECTIVE_CUT', 'COORDINATED_SNAPSHOT'])
  assert.deepEqual([...GIP_CONSISTENCY_REQUIREMENT_STATUSES], ['REQUIRED', 'NOT_REQUIRED'])
  assert.deepEqual([...GIP_PROFILE_ERROR_REASONS], [
    'PROFILE_NOT_OBJECT',
    'PROFILE_ID_INVALID',
    'CONNECTOR_KIND_REQUIRED',
    'ACTION_REQUIRED',
    'IMPLEMENTATION_VERSION_REQUIRED',
    'CERTIFICATE_NOT_OBJECT',
    'CERTIFICATE_UNKNOWN_FIELD',
    'ACQUISITION_MODE_INVALID',
    'CONSISTENCY_PROOFS_INVALID',
    'CONTINUATION_LIFETIME_INVALID',
    'COMPLETENESS_PROOFS_INVALID',
    'COMPLETENESS_PROOFS_EMPTY',
    'COMPLETENESS_COMBINATION_INVALID',
    'APPLY_MODE_FORBIDDEN_ON_READ_PROFILE',
    'RECOVERY_DECLARATION_FORBIDDEN',
    'ILLEGAL_CAPABILITY_COMBINATION',
    'APPLY_PROFILE_NOT_OBJECT',
    'APPLY_PROFILE_ID_INVALID',
    'APPLY_MODE_INVALID',
    'CONSISTENCY_STATUS_INVALID',
    'CONSISTENCY_EVIDENCE_INVALID',
    'COMPLETENESS_EVIDENCE_INVALID',
    'ROLE_TYPE_INVALID',
    'EXTERNAL_WRITE_TARGET_FORBIDDEN',
  ])
  for (const vocab of [GIP_ACQUISITION_MODES, GIP_CONSISTENCY_PROOFS, GIP_CONTINUATION_LIFETIMES,
    GIP_COMPLETENESS_PROOFS, GIP_APPLY_MODES, GIP_RECOVERY_STRATEGIES, GIP_ROLE_TYPES,
    GIP_CROSS_ROLE_TEMPORAL_POLICIES, GIP_CONSISTENCY_REQUIREMENT_STATUSES, GIP_PROFILE_ERROR_REASONS]) {
    assert.ok(Object.isFrozen(vocab))
  }
  // 'NONE' must never be a proof class — "not required" lives in the status field.
  assert.ok(!GIP_CONSISTENCY_PROOFS.includes('NONE'))
}

// ── 2. Source-level invariant: every fail('REASON') in the module ∈ vocabulary ──
function everyFailCallSiteUsesADeclaredReason() {
  const src = fs
    .readFileSync(path.join(__dirname, '..', 'lib', 'gip-profile-certification-contracts.cjs'), 'utf8')
    .replace(/\/\/.*$/gm, '')
  const declared = new Set(GIP_PROFILE_ERROR_REASONS)
  const re = /\bfail\(\s*['"]([A-Z_]+)['"]/g
  const seen = []
  const undeclared = []
  let match
  while ((match = re.exec(src))) {
    seen.push(match[1])
    if (!declared.has(match[1])) undeclared.push(match[1])
  }
  assert.ok(seen.length >= 20, `expected to locate the fail() call sites (found ${seen.length})`)
  assert.deepEqual(undeclared, [], 'every fail() reason must be declared in GIP_PROFILE_ERROR_REASONS')
}

// ── 3. Read-action profile: happy path + closed shape ──
function readProfileHappyPath() {
  const profile = normalizeCertifiedReadActionProfile(fixtureProfile())
  assert.equal(profile.actionProfileVersion, 'fixture.paged_read.v1')
  assert.deepEqual([...profile.certificate.supportedCompletenessProofs], ['SHORT_PAGE', 'DECLARED_TOTAL'])
  // default combinations = singletons of each supported proof
  assert.deepEqual(profile.certificate.completenessCombinationRules.map((c) => [...c]), [['SHORT_PAGE'], ['DECLARED_TOTAL']])
  assert.ok(Object.isFrozen(profile) && Object.isFrozen(profile.certificate))
}

function readProfileFailClosed() {
  rejectsWith(() => normalizeCertifiedReadActionProfile(null), 'PROFILE_NOT_OBJECT')
  rejectsWith(() => normalizeCertifiedReadActionProfile(fixtureProfile({ profileId: 'BadName' })), 'PROFILE_ID_INVALID')
  // length cap (review NIT): a multi-KB matching id is refused before it reaches digests
  rejectsWith(() => normalizeCertifiedReadActionProfile(fixtureProfile({ profileId: 'a.' + ('b'.repeat(200)) + '.v1' })), 'PROFILE_ID_INVALID')
  rejectsWith(() => normalizeCertifiedReadActionProfile(fixtureProfile({ certificate: { acquisitionMode: 'TELEPATHIC_READ' } })), 'ACQUISITION_MODE_INVALID')
  rejectsWith(() => normalizeCertifiedReadActionProfile(fixtureProfile({ certificate: { supportedConsistencyProofs: ['NONE'] } })), 'CONSISTENCY_PROOFS_INVALID')
  rejectsWith(() => normalizeCertifiedReadActionProfile(fixtureProfile({ certificate: { supportedConsistencyProofs: ['SOURCE_SNAPSHOT_TXN', 'SOURCE_SNAPSHOT_TXN'] } })), 'CONSISTENCY_PROOFS_INVALID')
  rejectsWith(() => normalizeCertifiedReadActionProfile(fixtureProfile({ certificate: { supportedCompletenessProofs: [] } })), 'COMPLETENESS_PROOFS_EMPTY')
  rejectsWith(() => normalizeCertifiedReadActionProfile(fixtureProfile({ certificate: { applyMode: 'SYNCHRONOUS_UOW' } })), 'APPLY_MODE_FORBIDDEN_ON_READ_PROFILE')
  rejectsWith(() => normalizeCertifiedReadActionProfile(fixtureProfile({ certificate: { recoveryStrategy: 'PAGE_RESUME' } })), 'RECOVERY_DECLARATION_FORBIDDEN')
  rejectsWith(() => normalizeCertifiedReadActionProfile(fixtureProfile({ certificate: { smuggled: true } })), 'CERTIFICATE_UNKNOWN_FIELD')
  // empty consistency set is LEGAL (honest no-proof declaration) — not a failure.
  const honest = normalizeCertifiedReadActionProfile(fixtureProfile({
    certificate: { acquisitionMode: 'BOUNDED_READ', continuationLifetime: 'SINGLE_REQUEST', supportedConsistencyProofs: [] },
  }))
  assert.deepEqual([...honest.certificate.supportedConsistencyProofs], [])
}

// ── 4. Cross-dimension legality (only the frozen rules) ──
function crossDimensionLegality() {
  rejectsWith(() => normalizeCertifiedReadActionProfile(fixtureProfile({
    certificate: { acquisitionMode: 'BOUNDED_READ', continuationLifetime: 'CONNECTION_BOUND' },
  })), 'ILLEGAL_CAPABILITY_COMBINATION')
  rejectsWith(() => normalizeCertifiedReadActionProfile(fixtureProfile({
    certificate: { acquisitionMode: 'SEALED_EXPORT', supportedCompletenessProofs: ['SHORT_PAGE'] },
  })), 'ILLEGAL_CAPABILITY_COMBINATION')
  rejectsWith(() => normalizeCertifiedReadActionProfile(fixtureProfile({
    certificate: { acquisitionMode: 'CHANGE_FEED', supportedConsistencyProofs: ['SOURCE_SNAPSHOT_TXN'] },
  })), 'ILLEGAL_CAPABILITY_COMBINATION')
  rejectsWith(() => normalizeCertifiedReadActionProfile(fixtureProfile({
    certificate: { continuationLifetime: 'DURABLE_TOKEN', supportedConsistencyProofs: ['SOURCE_SNAPSHOT_TXN'] },
  })), 'ILLEGAL_CAPABILITY_COMBINATION')
  // MONOTONIC_VERSION_PIN anchors DURABLE_TOKEN ONLY on CHANGE_FEED — not on PAGED_READ.
  rejectsWith(() => normalizeCertifiedReadActionProfile(fixtureProfile({
    certificate: { acquisitionMode: 'PAGED_READ', continuationLifetime: 'DURABLE_TOKEN', supportedConsistencyProofs: ['MONOTONIC_VERSION_PIN'] },
  })), 'ILLEGAL_CAPABILITY_COMBINATION')
  // …and the legal variants of the same rules pass:
  normalizeCertifiedReadActionProfile(fixtureProfile({
    certificate: { acquisitionMode: 'SEALED_EXPORT', continuationLifetime: 'DURABLE_TOKEN', supportedConsistencyProofs: ['IMMUTABLE_SNAPSHOT_TOKEN'], supportedCompletenessProofs: ['SIGNED_MANIFEST'] },
  }))
  normalizeCertifiedReadActionProfile(fixtureProfile({
    certificate: { acquisitionMode: 'CHANGE_FEED', supportedConsistencyProofs: ['MONOTONIC_VERSION_PIN'], supportedCompletenessProofs: ['DECLARED_TOTAL'] },
  }))
  // scale-D0 §2 legal-combination table ROW 5 (enterprise): CHANGE_FEED × MONOTONIC_VERSION_PIN
  // × DURABLE_TOKEN(水位) × {DECLARED_TOTAL} — MUST be legal (review P2: the earlier blanket
  // DURABLE_TOKEN→IMMUTABLE rule wrongly rejected the doc-frozen enterprise coordinates).
  const enterprise = normalizeCertifiedReadActionProfile(fixtureProfile({
    certificate: { acquisitionMode: 'CHANGE_FEED', continuationLifetime: 'DURABLE_TOKEN', supportedConsistencyProofs: ['MONOTONIC_VERSION_PIN'], supportedCompletenessProofs: ['DECLARED_TOTAL'] },
  }))
  assert.equal(enterprise.certificate.continuationLifetime, 'DURABLE_TOKEN')
  // GIP-D0 §3 complete-contract components are expressible (opaque at schema level).
  const shaped = normalizeCertifiedReadActionProfile(fixtureProfile({
    certificate: { manifestShape: { keyId: 'shape' }, tokenShape: { kind: 'opaque' }, cursorShape: { kind: 'offset' }, failureVocabulary: ['X_FAILED'] },
  }))
  assert.deepEqual([...shaped.certificate.failureVocabulary], ['X_FAILED'])

  // DEEP immutability (review P2): opaque fields are owned frozen CLONES — caller
  // mutation after normalization must not change the certified result, and direct
  // mutation of the certified result must throw (strict mode + deep freeze).
  const shapeInput = { keyId: 'k1', nested: { rotation: ['a'] } }
  const cloned = normalizeCertifiedReadActionProfile(fixtureProfile({ certificate: { manifestShape: shapeInput } }))
  shapeInput.nested.rotation.push('b')
  shapeInput.keyId = 'k2'
  assert.equal(cloned.certificate.manifestShape.keyId, 'k1', 'caller mutation must not reach the certificate')
  assert.deepEqual([...cloned.certificate.manifestShape.nested.rotation], ['a'])
  assert.throws(() => { cloned.certificate.manifestShape.nested.rotation.push('x') }, TypeError)
  assert.throws(() => { cloned.certificate.manifestShape.keyId = 'x' }, TypeError)

  // strict canonical domain (shared codec): NaN / functions / Date / class
  // instances / sparse arrays inside opaque fields fail closed — no digest-colliding
  // shapes can enter a certificate (review P2).
  rejectsWith(() => normalizeCertifiedReadActionProfile(fixtureProfile({ certificate: { manifestShape: { bad: NaN } } })), 'CERTIFICATE_UNKNOWN_FIELD')
  rejectsWith(() => normalizeCertifiedReadActionProfile(fixtureProfile({ certificate: { tokenShape: { fn: () => 1 } } })), 'CERTIFICATE_UNKNOWN_FIELD')
  rejectsWith(() => normalizeCertifiedReadActionProfile(fixtureProfile({ certificate: { manifestShape: { when: new Date(0) } } })), 'CERTIFICATE_UNKNOWN_FIELD')
  rejectsWith(() => normalizeCertifiedReadActionProfile(fixtureProfile({ certificate: { cursorShape: new (class C { constructor() { this.a = 1 } })() } })), 'CERTIFICATE_UNKNOWN_FIELD')
  // eslint-disable-next-line no-sparse-arrays
  rejectsWith(() => normalizeCertifiedReadActionProfile(fixtureProfile({ certificate: { failureVocabulary: [, 'X'] } })), 'CERTIFICATE_UNKNOWN_FIELD')

  // strict TOP-LEVEL shape: unknown top-level input fields fail closed
  rejectsWith(() => normalizeCertifiedReadActionProfile({ ...fixtureProfile(), smuggledTop: 1 }), 'PROFILE_NOT_OBJECT')

  // CANONICAL set order: equivalent sets normalize identically (vocabulary order)
  const reordered = normalizeCertifiedReadActionProfile(fixtureProfile({
    certificate: { supportedCompletenessProofs: ['DECLARED_TOTAL', 'SHORT_PAGE'] },
  }))
  assert.deepEqual([...reordered.certificate.supportedCompletenessProofs], ['SHORT_PAGE', 'DECLARED_TOTAL'])

  // duplicate combination declaration fails closed
  rejectsWith(() => normalizeCertifiedReadActionProfile(fixtureProfile({
    certificate: { completenessCombinationRules: [['SHORT_PAGE'], ['SHORT_PAGE']] },
  })), 'COMPLETENESS_COMBINATION_INVALID')
}

// ── 5. Recovery derivation matrix (derived, never declared) ──
function recoveryDerivation() {
  // deriveRecoveryStrategy validates the FULL certificate (review P2 fail-closed), so
  // these are complete legal certs.
  const cases = [
    [{ acquisitionMode: 'BOUNDED_READ', continuationLifetime: 'SINGLE_REQUEST', supportedConsistencyProofs: [], supportedCompletenessProofs: ['SHORT_PAGE'] }, 'WHOLE_RERUN'],
    [{ acquisitionMode: 'SEALED_EXPORT', continuationLifetime: 'DURABLE_TOKEN', supportedConsistencyProofs: ['IMMUTABLE_SNAPSHOT_TOKEN'], supportedCompletenessProofs: ['SIGNED_MANIFEST'] }, 'CHUNK_RESUME'],
    [{ acquisitionMode: 'PAGED_READ', continuationLifetime: 'DURABLE_TOKEN', supportedConsistencyProofs: ['IMMUTABLE_SNAPSHOT_TOKEN'], supportedCompletenessProofs: ['SHORT_PAGE'] }, 'PAGE_RESUME'],
    [{ acquisitionMode: 'PAGED_READ', continuationLifetime: 'CONNECTION_BOUND', supportedConsistencyProofs: ['SOURCE_SNAPSHOT_TXN'], supportedCompletenessProofs: ['SHORT_PAGE'] }, 'WHOLE_ROUND_RESTART'],
    // enterprise watermark resume (scale-D0 §2 row 5's DURABLE_TOKEN(水位))
    [{ acquisitionMode: 'CHANGE_FEED', continuationLifetime: 'DURABLE_TOKEN', supportedConsistencyProofs: ['MONOTONIC_VERSION_PIN'], supportedCompletenessProofs: ['DECLARED_TOTAL'] }, 'PAGE_RESUME'],
  ]
  for (const [certificate, expected] of cases) {
    assert.equal(deriveRecoveryStrategy(certificate), expected)
  }
  // review P2: derivation is FAIL-CLOSED on schema-illegal certificates — no
  // resume-grade strategy for a cert normalize() would reject.
  rejectsWith(() => deriveRecoveryStrategy({ acquisitionMode: 'SEALED_EXPORT', continuationLifetime: 'DURABLE_TOKEN', supportedConsistencyProofs: ['IMMUTABLE_SNAPSHOT_TOKEN'], supportedCompletenessProofs: ['SHORT_PAGE'] }), 'ILLEGAL_CAPABILITY_COMBINATION')
  rejectsWith(() => deriveRecoveryStrategy({ acquisitionMode: 'PAGED_READ', continuationLifetime: 'DURABLE_TOKEN', supportedConsistencyProofs: ['SOURCE_SNAPSHOT_TXN'], supportedCompletenessProofs: ['SHORT_PAGE'] }), 'ILLEGAL_CAPABILITY_COMBINATION')
  rejectsWith(() => deriveRecoveryStrategy({ acquisitionMode: 'TELEPATHIC', continuationLifetime: 'SINGLE_REQUEST', supportedConsistencyProofs: [], supportedCompletenessProofs: ['SHORT_PAGE'] }), 'ACQUISITION_MODE_INVALID')
  rejectsWith(() => deriveRecoveryStrategy({}), 'ACQUISITION_MODE_INVALID')

  // DIFFERENTIAL (review P2): NO certificate exists that normalize REJECTS but derive
  // ACCEPTS — they share the single normalizer. Sweep the illegal shapes the reviewer
  // reproduced plus a few more; each must throw the SAME way from both.
  const illegalCerts = [
    { acquisitionMode: 'PAGED_READ', continuationLifetime: 'DURABLE_TOKEN', supportedConsistencyProofs: ['IMMUTABLE_SNAPSHOT_TOKEN'], supportedCompletenessProofs: [] },
    { acquisitionMode: 'PAGED_READ', continuationLifetime: 'DURABLE_TOKEN', supportedConsistencyProofs: ['IMMUTABLE_SNAPSHOT_TOKEN'], supportedCompletenessProofs: ['SHORT_PAGE'], completenessCombinationRules: [] },
    { acquisitionMode: 'SEALED_EXPORT', continuationLifetime: 'DURABLE_TOKEN', supportedConsistencyProofs: ['IMMUTABLE_SNAPSHOT_TOKEN'], supportedCompletenessProofs: ['SHORT_PAGE'] },
    { acquisitionMode: 'BOUNDED_READ', continuationLifetime: 'CONNECTION_BOUND', supportedConsistencyProofs: [], supportedCompletenessProofs: ['SHORT_PAGE'] },
    { acquisitionMode: 'PAGED_READ', continuationLifetime: 'DURABLE_TOKEN', supportedConsistencyProofs: ['SOURCE_SNAPSHOT_TXN'], supportedCompletenessProofs: ['SHORT_PAGE'] },
    { acquisitionMode: 'PAGED_READ', continuationLifetime: 'CONNECTION_BOUND', supportedConsistencyProofs: ['NONE'], supportedCompletenessProofs: ['SHORT_PAGE'] },
  ]
  for (const cert of illegalCerts) {
    let normReason = null, deriveReason = null
    try { normalizeCertifiedReadActionProfile(fixtureProfile({ certificate: cert })) } catch (e) { normReason = e.reason }
    try { deriveRecoveryStrategy(cert) } catch (e) { deriveReason = e.reason }
    assert.ok(normReason, 'normalize must reject the illegal cert')
    assert.equal(deriveReason, normReason, 'derive must reject with the SAME reason normalize uses')
  }
}

// ── 6. Apply profile (independent axis) ──
function applyProfile() {
  const apply = normalizeCertifiedApplyProfile({ applyProfileId: 'internal.staged_generation.v1', applyMode: 'STAGED_GENERATION' })
  assert.equal(apply.applyMode, 'STAGED_GENERATION')
  rejectsWith(() => normalizeCertifiedApplyProfile({ applyProfileId: 'internal.staged_generation.v1', applyMode: 'BULK_WRITE' }), 'APPLY_MODE_INVALID')
  rejectsWith(() => normalizeCertifiedApplyProfile(null), 'APPLY_PROFILE_NOT_OBJECT')
  // closed top-level shape (review P2)
  rejectsWith(() => normalizeCertifiedApplyProfile({ applyProfileId: 'internal.staged_generation.v1', applyMode: 'STAGED_GENERATION', smuggled: 1 }), 'APPLY_PROFILE_NOT_OBJECT')
}

// ── 7. Evidence shapes: both directions closed ──
function evidenceShapes() {
  const profile = normalizeCertifiedReadActionProfile(fixtureProfile())
  const okRequired = validateConsistencyEvidence(profile, { consistencyRequirementStatus: 'REQUIRED', proofClasses: ['SOURCE_SNAPSHOT_TXN'] })
  assert.deepEqual([...okRequired.proofClasses], ['SOURCE_SNAPSHOT_TXN'])
  const okNotRequired = validateConsistencyEvidence(profile, { consistencyRequirementStatus: 'NOT_REQUIRED', proofClasses: [] })
  assert.deepEqual([...okNotRequired.proofClasses], [])
  rejectsWith(() => validateConsistencyEvidence(profile, { consistencyRequirementStatus: 'REQUIRED', proofClasses: [] }), 'CONSISTENCY_EVIDENCE_INVALID')
  rejectsWith(() => validateConsistencyEvidence(profile, { consistencyRequirementStatus: 'NOT_REQUIRED', proofClasses: ['SOURCE_SNAPSHOT_TXN'] }), 'CONSISTENCY_EVIDENCE_INVALID')
  rejectsWith(() => validateConsistencyEvidence(profile, { consistencyRequirementStatus: 'REQUIRED', proofClasses: ['IMMUTABLE_SNAPSHOT_TOKEN'] }), 'CONSISTENCY_EVIDENCE_INVALID')
  rejectsWith(() => validateConsistencyEvidence(profile, { consistencyRequirementStatus: 'NONE', proofClasses: [] }), 'CONSISTENCY_STATUS_INVALID')
  // closed evidence shape (review NIT): an undeclared extra field is rejected
  rejectsWith(() => validateConsistencyEvidence(profile, { consistencyRequirementStatus: 'NOT_REQUIRED', proofClasses: [], smuggled: 'X' }), 'CONSISTENCY_EVIDENCE_INVALID')
  rejectsWith(() => validateCompletenessEvidence(profile, { runOutcome: 'successful', usedCompletenessProofs: ['SHORT_PAGE'], smuggled: 'X' }), 'COMPLETENESS_EVIDENCE_INVALID')

  const okUsed = validateCompletenessEvidence(profile, { runOutcome: 'successful', usedCompletenessProofs: ['SHORT_PAGE'] })
  assert.deepEqual([...okUsed.usedCompletenessProofs], ['SHORT_PAGE'])
  rejectsWith(() => validateCompletenessEvidence(profile, { runOutcome: 'successful', usedCompletenessProofs: [] }), 'COMPLETENESS_EVIDENCE_INVALID')
  rejectsWith(() => validateCompletenessEvidence(profile, { runOutcome: 'successful', usedCompletenessProofs: ['SIGNED_MANIFEST'] }), 'COMPLETENESS_EVIDENCE_INVALID')
  // combination not declared (default combos are singletons)
  rejectsWith(() => validateCompletenessEvidence(profile, { runOutcome: 'successful', usedCompletenessProofs: ['SHORT_PAGE', 'DECLARED_TOTAL'] }), 'COMPLETENESS_EVIDENCE_INVALID')
  // …but a certificate DECLARING the pair accepts it:
  const comboProfile = normalizeCertifiedReadActionProfile(fixtureProfile({
    certificate: { completenessCombinationRules: [['SHORT_PAGE'], ['SHORT_PAGE', 'DECLARED_TOTAL']] },
  }))
  const okCombo = validateCompletenessEvidence(comboProfile, { runOutcome: 'successful', usedCompletenessProofs: ['DECLARED_TOTAL', 'SHORT_PAGE'] })
  assert.equal(okCombo.usedCompletenessProofs.length, 2)
  // non-successful outcomes carry no completeness claim
  const failed = validateCompletenessEvidence(profile, { runOutcome: 'failed' })
  assert.deepEqual([...failed.usedCompletenessProofs], [])
  // non-successful outcomes normalize to the COARSE token — arbitrary caller strings
  // are never echoed into the frozen evidence shape (review NIT).
  assert.equal(failed.runOutcome, 'not_successful')
  const weird = validateCompletenessEvidence(profile, { runOutcome: 'caller_arbitrary_marker_xyz' })
  assert.equal(weird.runOutcome, 'not_successful')
}

// ── 8. Role-type gate ──
function roleTypeGate() {
  assert.equal(assertRoleTypeAllowed('EXTERNAL_READ_SOURCE'), 'EXTERNAL_READ_SOURCE')
  assert.equal(assertRoleTypeAllowed('INTERNAL_APPLY_TARGET'), 'INTERNAL_APPLY_TARGET')
  rejectsWith(() => assertRoleTypeAllowed('EXTERNAL_WRITE_TARGET'), 'EXTERNAL_WRITE_TARGET_FORBIDDEN')
  rejectsWith(() => assertRoleTypeAllowed('TELEPATHIC_TARGET'), 'ROLE_TYPE_INVALID')
}

// ── 9. Coarse details: contract errors never echo offending values ──
function coarseDetails() {
  const SMUGGLED = 'TELEPATHIC_READ_SECRET_VALUE'
  const caught = rejectsWith(
    () => normalizeCertifiedReadActionProfile(fixtureProfile({ certificate: { acquisitionMode: SMUGGLED } })),
    'ACQUISITION_MODE_INVALID',
  )
  assert.ok(!JSON.stringify({ m: caught.message, d: caught.details }).includes(SMUGGLED),
    'offending values must never appear in thrown errors')
}

// ── 10. Public isValidProfileId is the SAME source of truth as the internal PROFILE_ID_PATTERN ──
// Review B1a-1 P2: isValidProfileId (public) must never become a second copy of the profileId
// regex. This table proves it agrees with __internals.PROFILE_ID_PATTERN (plus the shared 128-char
// bound) across valid/invalid ids — including the two edge cases that would silently pass a hand-
// rolled-regex or dropped-bound divergence: an over-length id that is otherwise pattern-valid, and
// an id rejected purely by shape (not length).
function publicHelperAgreesWithInternalPattern() {
  const overLength = `fixture.${'a'.repeat(120)}.v1` // pattern-valid, 131 chars > 128 bound
  const table = [
    'fixture.paged_read.v1',
    'fixture.paged_read.v12',
    'fixture.multi.part.name.v3',
    'FIXTURE.paged_read.v1', // uppercase — invalid
    'fixture_paged_read_v1', // no dot — invalid
    'fixture.paged_read', // no version token — invalid
    'fixture.paged_read.v1.', // trailing dot — invalid
    '.fixture.paged_read.v1', // leading dot — invalid
    'fixture.paged_read.v0', // v0 — invalid (v[1-9][0-9]* excludes leading zero)
    '', // empty — invalid
    overLength,
  ]
  for (const id of table) {
    const expected = typeof id === 'string' && id.length <= 128 && __internals.PROFILE_ID_PATTERN.test(id)
    assert.equal(
      isValidProfileId(id),
      expected,
      `isValidProfileId must agree with __internals.PROFILE_ID_PATTERN (+128 bound) for ${JSON.stringify(id)}`,
    )
  }
  // Guard the table itself: each dimension must actually be exercised, or a broken helper could
  // still pass this function vacuously (e.g. an all-accept or all-reject helper against a table
  // that never varies).
  assert.ok(table.some((id) => isValidProfileId(id)), 'table must include at least one accepted id')
  assert.ok(table.some((id) => !__internals.PROFILE_ID_PATTERN.test(id)), 'table must include a pattern-invalid id')
  assert.ok(
    overLength.length > 128 && __internals.PROFILE_ID_PATTERN.test(overLength) && !isValidProfileId(overLength),
    'table must include an id that is pattern-valid but rejected ONLY by the 128-char bound',
  )
}

function main() {
  frozenVocabularies()
  everyFailCallSiteUsesADeclaredReason()
  readProfileHappyPath()
  readProfileFailClosed()
  crossDimensionLegality()
  recoveryDerivation()
  applyProfile()
  evidenceShapes()
  roleTypeGate()
  coarseDetails()
  publicHelperAgreesWithInternalPattern()
  console.log('gip-profile-certification-contracts.test.cjs OK')
}

main()
