'use strict'

// GIP-D0 — bridge.bounded_read.v1 certification battery. Plain node test, hermetic.
// Proves: the profile is schema-valid + passes the C1–C11e compliance harness, its
// recovery derives to WHOLE_RERUN, its completeness adjudicator certifies SHORT_PAGE
// only (the concrete adapter's real capability) and fails closed elsewhere, its frozen
// numbers/identity cannot drift from the real bridge source/adapter, and its profile
// version binds correctly into the qualification digest.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  BRIDGE_BOUNDED_READ_PROFILE,
  BRIDGE_BOUNDED_READ_MAX_ROWS,
  BRIDGE_BOUNDED_READ_CONNECTOR_KIND,
  BRIDGE_BOUNDED_READ_IMPLEMENTATION_VERSION,
  BRIDGE_BOUNDED_READ_ERROR_REASONS,
  BridgeBoundedReadError,
  adjudicateBoundedReadCompleteness,
  bridgeBoundedReadRecoveryStrategy,
  assertCompletenessEvidenceCertified,
} = require(path.join(__dirname, '..', 'lib', 'gip-bridge-bounded-read-profile.cjs'))

const {
  runReadActionProfileComplianceBattery,
  summarizeBatteryForEvidence,
  BATTERY_CHECK_IDS,
} = require(path.join(__dirname, '..', 'lib', 'gip-profile-compliance-harness.cjs'))

const {
  deriveRecoveryStrategy,
  validateCompletenessEvidence,
} = require(path.join(__dirname, '..', 'lib', 'gip-profile-certification-contracts.cjs'))

const {
  computeQualificationDigest,
  computeEnvelopeMac,
  verifyBindingQualification,
  GipQualificationError,
} = require(path.join(__dirname, '..', 'lib', 'gip-binding-qualification-spike.cjs'))

// The REAL feeder + adapter — imported ONLY by the test (the profile module stays
// latent). The drift guard asserts the frozen spec still equals the live source/adapter.
const feeder = require(path.join(__dirname, '..', 'lib', 'stock-preparation-readonly-source-run.cjs'))
const bridgeAdapter = require(path.join(__dirname, '..', 'lib', 'adapters', 'bridge-agent-readonly-adapter.cjs'))

function rejectsWith(fn, reason) {
  let caught = null
  try { fn() } catch (error) { caught = error }
  assert.ok(caught instanceof BridgeBoundedReadError, `expected BridgeBoundedReadError (${reason})`)
  assert.equal(caught.reason, reason)
  return caught
}

const CANDIDATE = {
  profileId: 'bridge.bounded_read.v1',
  connectorKind: BRIDGE_BOUNDED_READ_CONNECTOR_KIND,
  actionId: 'bounded_read',
  implementationVersion: BRIDGE_BOUNDED_READ_IMPLEMENTATION_VERSION,
  certificate: {
    acquisitionMode: 'BOUNDED_READ',
    supportedConsistencyProofs: [],
    continuationLifetime: 'SINGLE_REQUEST',
    supportedCompletenessProofs: ['SHORT_PAGE'],
    completenessCombinationRules: [['SHORT_PAGE']],
    maxScale: { maxRowsPerBoundedRead: BRIDGE_BOUNDED_READ_MAX_ROWS },
    failureVocabulary: [...BRIDGE_BOUNDED_READ_ERROR_REASONS],
  },
}

// ── 1. Frozen error vocabulary + source-level fail() invariant ──
function frozenVocabulary() {
  assert.deepEqual([...BRIDGE_BOUNDED_READ_ERROR_REASONS], [
    'BOUNDED_READ_RESULT_INVALID',
    'BOUNDED_READ_CLAMP_UNREPORTED',
    'BOUNDED_READ_CLAMP_EXCEEDS_SUPPORTED_BOUND',
    'BOUNDED_READ_RESULT_EXCEEDS_CLAMP',
    'BOUNDED_READ_COMPLETENESS_UNPROVABLE',
  ])
  assert.ok(Object.isFrozen(BRIDGE_BOUNDED_READ_ERROR_REASONS))
  const src = fs
    .readFileSync(path.join(__dirname, '..', 'lib', 'gip-bridge-bounded-read-profile.cjs'), 'utf8')
    .replace(/\/\/.*$/gm, '')
  const declared = new Set(BRIDGE_BOUNDED_READ_ERROR_REASONS)
  const re = /\bfail\(\s*['"]([A-Z_]+)['"]/g
  const undeclared = []
  let count = 0
  let match
  while ((match = re.exec(src))) {
    count += 1
    if (!declared.has(match[1])) undeclared.push(match[1])
  }
  assert.ok(count >= 5, `expected to locate fail() call sites (found ${count})`)
  assert.deepEqual(undeclared, [], 'every fail() reason must be declared')
}

// ── 2. Profile identity: frozen, exactly the certified shape ──
function profileIdentity() {
  const p = BRIDGE_BOUNDED_READ_PROFILE
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.certificate))
  assert.equal(p.profileId, 'bridge.bounded_read.v1')
  assert.equal(p.actionProfileVersion, 'bridge.bounded_read.v1')
  // connector kind is the FULL runtime kind; implementation version is a SEPARATE identity
  assert.equal(p.connectorKind, 'bridge:legacy-sql-readonly')
  assert.equal(p.actionId, 'bounded_read')
  assert.equal(p.implementationVersion, 'bridge-readonly-adapter.v1')
  assert.notEqual(p.connectorKind, p.implementationVersion, 'kind must not be borrowed by implementationVersion')
  assert.equal(p.certificate.acquisitionMode, 'BOUNDED_READ')
  assert.equal(p.certificate.continuationLifetime, 'SINGLE_REQUEST')
  assert.deepEqual([...p.certificate.supportedConsistencyProofs], [])
  // SHORT_PAGE ONLY — DECLARED_TOTAL is a v2 capability (adapter has no total propagation)
  assert.deepEqual([...p.certificate.supportedCompletenessProofs], ['SHORT_PAGE'])
  assert.deepEqual(p.certificate.completenessCombinationRules.map((c) => [...c]), [['SHORT_PAGE']])
  assert.deepEqual(p.certificate.maxScale, { maxRowsPerBoundedRead: 500 })
  // failureVocabulary bound to the profile version, EXACT-pinned to the frozen list
  assert.deepEqual([...p.certificate.failureVocabulary], [...BRIDGE_BOUNDED_READ_ERROR_REASONS])
  assert.ok(Object.isFrozen(p.certificate.failureVocabulary))
  // manifest/token/cursor/orderingKey stay omitted (a single BOUNDED_READ page has none)
  for (const omitted of ['manifestShape', 'tokenShape', 'cursorShape', 'orderingKeyRequirement']) {
    assert.ok(!(omitted in p.certificate), `${omitted} must be omitted`)
  }
}

// ── 3. Compliance harness (C1–C11e) + values-free summary ──
function complianceHarness() {
  const report = runReadActionProfileComplianceBattery(CANDIDATE)
  assert.equal(report.passed, true, 'candidate must pass every compliance check')
  assert.equal(report.checks.length, BATTERY_CHECK_IDS.length)
  for (const check of report.checks) {
    assert.equal(check.ok, true, `check ${check.checkId} must pass (observed ${check.observed})`)
  }
  const summary = summarizeBatteryForEvidence(report)
  assert.equal(summary.passed, true)
  assert.equal(summary.checkCount, BATTERY_CHECK_IDS.length)
  assert.deepEqual([...summary.failedCheckIds], [])
}

// ── 4. Recovery derivation ──
function recovery() {
  assert.equal(bridgeBoundedReadRecoveryStrategy(), 'WHOLE_RERUN')
  assert.equal(deriveRecoveryStrategy(BRIDGE_BOUNDED_READ_PROFILE.certificate), 'WHOLE_RERUN')
}

// ── 5. Completeness adjudication — SHORT_PAGE only; everything else fails closed ──
function adjudication() {
  // SHORT PAGE (rows < clamp) ⇒ SHORT_PAGE proof, certificate-legal
  const shortEv = adjudicateBoundedReadCompleteness({ pageRowCount: 12, reportedClamp: 500 })
  assert.deepEqual({ runOutcome: shortEv.runOutcome, used: [...shortEv.usedCompletenessProofs] },
    { runOutcome: 'successful', used: ['SHORT_PAGE'] })
  assert.equal(assertCompletenessEvidenceCertified(shortEv).runOutcome, 'successful')
  validateCompletenessEvidence(BRIDGE_BOUNDED_READ_PROFILE, shortEv)

  // FULL PAGE (rows == clamp) ⇒ FAIL-CLOSED (no proof available for this profile — #4437)
  rejectsWith(() => adjudicateBoundedReadCompleteness({ pageRowCount: 500, reportedClamp: 500 }),
    'BOUNDED_READ_COMPLETENESS_UNPROVABLE')
  rejectsWith(() => adjudicateBoundedReadCompleteness({ pageRowCount: 20, reportedClamp: 20 }),
    'BOUNDED_READ_COMPLETENESS_UNPROVABLE')

  // ── DECLARED TOTAL IS A v2 CAPABILITY (review P1): a sourceDeclaredTotal input is
  //    REFUSED fail-closed (unknown field), NOT silently used — the concrete bridge
  //    adapter never propagates a total, so certifying/consuming one here would overstate
  //    the adapter's capability. Trusted totals ⇒ separate runtime/profile-v2 gate.
  rejectsWith(() => adjudicateBoundedReadCompleteness({ pageRowCount: 10, reportedClamp: 500, sourceDeclaredTotal: 20 }),
    'BOUNDED_READ_RESULT_INVALID')
  rejectsWith(() => adjudicateBoundedReadCompleteness({ pageRowCount: 500, reportedClamp: 500, sourceDeclaredTotal: 500 }),
    'BOUNDED_READ_RESULT_INVALID')

  // ── DISCRIMINATING PROBE (done is NEVER a proof): FULL page, adapterDone:true ⇒ STILL
  //    UNPROVABLE. A mutation reading adapterDone (`if (runResult.adapterDone) return
  //    completenessEvidence('SHORT_PAGE')`) would return a proof here and RED this.
  //    Feeder ground: "an adapter's done:true is NEVER evidence of completeness."
  rejectsWith(() => adjudicateBoundedReadCompleteness({ pageRowCount: 500, reportedClamp: 500, adapterDone: true }),
    'BOUNDED_READ_COMPLETENESS_UNPROVABLE')
  // …and a short page is SHORT_PAGE regardless of adapterDone being false
  const shortDone = adjudicateBoundedReadCompleteness({ pageRowCount: 10, reportedClamp: 500, adapterDone: false })
  assert.deepEqual([...shortDone.usedCompletenessProofs], ['SHORT_PAGE'])

  // clamp NOT reported (adapter_reported kind that omitted it) ⇒ fail-closed
  rejectsWith(() => adjudicateBoundedReadCompleteness({ pageRowCount: 10, reportedClamp: null }),
    'BOUNDED_READ_CLAMP_UNREPORTED')
  rejectsWith(() => adjudicateBoundedReadCompleteness({ pageRowCount: 10 }),
    'BOUNDED_READ_CLAMP_UNREPORTED')

  // clamp beyond the certified supported bound ⇒ out of scope, fail-closed
  rejectsWith(() => adjudicateBoundedReadCompleteness({ pageRowCount: 10, reportedClamp: 501 }),
    'BOUNDED_READ_CLAMP_EXCEEDS_SUPPORTED_BOUND')

  // page larger than the certified MAX (500) ⇒ genuine overflow, fail-closed
  rejectsWith(() => adjudicateBoundedReadCompleteness({ pageRowCount: 501, reportedClamp: 500 }),
    'BOUNDED_READ_RESULT_EXCEEDS_CLAMP')
  // DIVERGENT BAND (clamp < rows <= 500): DELIBERATELY stricter than the feeder (review
  // P3, keep-strict). Outside the conforming contract but RUNTIME-REACHABLE — the bridge
  // adapter does not trim agent records, so an anomalous agent can return more rows than
  // the clamp it reported. Fails closed (false-fail, never false-complete). Locked here.
  rejectsWith(() => adjudicateBoundedReadCompleteness({ pageRowCount: 150, reportedClamp: 100 }),
    'BOUNDED_READ_RESULT_EXCEEDS_CLAMP')

  // shape hygiene: unknown field / non-object / bad ints ⇒ INPUT invalid
  rejectsWith(() => adjudicateBoundedReadCompleteness({ pageRowCount: 10, reportedClamp: 500, rows: [{ secret: 'x' }] }),
    'BOUNDED_READ_RESULT_INVALID')
  rejectsWith(() => adjudicateBoundedReadCompleteness(null), 'BOUNDED_READ_RESULT_INVALID')
  rejectsWith(() => adjudicateBoundedReadCompleteness({ pageRowCount: -1, reportedClamp: 500 }), 'BOUNDED_READ_RESULT_INVALID')
  rejectsWith(() => adjudicateBoundedReadCompleteness({ pageRowCount: 1.5, reportedClamp: 500 }), 'BOUNDED_READ_RESULT_INVALID')
  rejectsWith(() => adjudicateBoundedReadCompleteness({ pageRowCount: 10, reportedClamp: 0 }), 'BOUNDED_READ_RESULT_INVALID')

  // VALUES-FREE: no adjudication path echoes row content into the error (only counts/
  // field names appear in details).
  const SECRET = 'SECRET_ROW_A17'
  const leaky = rejectsWith(() => adjudicateBoundedReadCompleteness({ pageRowCount: 500, reportedClamp: 500, adapterDone: SECRET }),
    'BOUNDED_READ_COMPLETENESS_UNPROVABLE')
  assert.ok(!JSON.stringify({ m: leaky.message, d: leaky.details }).includes(SECRET),
    'adjudication failure must stay values-free')
}

// ── 6. DRIFT GUARD — the frozen spec equals the REAL bridge source + adapter ──
function driftGuard() {
  // (a) certified bound == the feeder's exported BRIDGE_SOURCE_PAGE_SIZE (500), NOT the
  //     per-deployment config.maxLimit (20) or the cross-kind host ceiling (1000).
  assert.equal(BRIDGE_BOUNDED_READ_MAX_ROWS, feeder.BRIDGE_SOURCE_PAGE_SIZE,
    'maxScale must equal the live BRIDGE_SOURCE_PAGE_SIZE — drift means the profile lies about the source')
  assert.equal(BRIDGE_BOUNDED_READ_PROFILE.certificate.maxScale.maxRowsPerBoundedRead, feeder.BRIDGE_SOURCE_PAGE_SIZE)
  // (b) connector kind is a REAL registered runtime kind
  const caps = feeder.SOURCE_KIND_CAPABILITIES
  assert.ok(caps && Object.prototype.hasOwnProperty.call(caps, BRIDGE_BOUNDED_READ_CONNECTOR_KIND),
    'connectorKind must be a real SOURCE_KIND_CAPABILITIES key')
  const bridgeCap = caps[BRIDGE_BOUNDED_READ_CONNECTOR_KIND]
  assert.equal(bridgeCap.pagination, 'none', 'bridge kind must be unpaginated (bounded)')
  assert.equal(bridgeCap.limitContract, 'adapter_reported')
  assert.equal(bridgeCap.pageSize, BRIDGE_BOUNDED_READ_MAX_ROWS)
  // (c) implementation version == the adapter's own exported, incrementable constant —
  //     a bump there (behavioural change) RETs this and forces re-certification.
  assert.equal(BRIDGE_BOUNDED_READ_IMPLEMENTATION_VERSION, bridgeAdapter.BRIDGE_READONLY_ADAPTER_IMPLEMENTATION_VERSION,
    'implementationVersion must equal the adapter exported version — drift forces re-certification')
}

// ── 7. Qualification digest binding (SCOPED) ──
//   The qualification spike's ordering-key TOTAL-ORDER probe is a PAGED-READ concern; a
//   single BOUNDED_READ has no cross-page order, so it is intentionally NOT exercised.
//   What IS exercised: this profile's actionProfileVersion binds into the qualification
//   digest (the input-binding property the run layer relies on).
function qualificationDigestBinding() {
  const envelopeKey = { keyId: 'kbr2026', secret: Buffer.alloc(32, 5) }
  const inputs = {
    actionProfileVersion: BRIDGE_BOUNDED_READ_PROFILE.actionProfileVersion,
    systemContentKey: 'sys_fixture', configContentKey: 'cfg_fixture',
    objectKey: 'obj_fixture', canonicalObjectVersion: 'material.v1',
  }
  const evidence = { profileVersion: BRIDGE_BOUNDED_READ_PROFILE.actionProfileVersion, usedCompletenessProofs: ['SHORT_PAGE'] }
  const qualificationDigest = computeQualificationDigest({ ...inputs, evidence })
  const expiresAt = '2027-01-01T00:00:00Z'
  const qualification = {
    status: 'candidate',
    qualificationDigest,
    envelopeKeyId: envelopeKey.keyId,
    envelopeMac: computeEnvelopeMac({ envelopeKey, qualificationDigest, status: 'candidate', expiresAt }),
    evidence,
    expiresAt,
  }
  const verified = verifyBindingQualification({ qualification, expectedInputs: inputs, envelopeKey, now: '2026-07-23T00:00:00Z' })
  assert.equal(verified.verified, true)
  assert.equal(verified.qualificationDigest, qualificationDigest)

  // input binding: a DIFFERENT profile version cannot reuse this qualification
  let caught = null
  try {
    verifyBindingQualification({
      qualification, expectedInputs: { ...inputs, actionProfileVersion: 'bridge.bounded_read.v2' },
      envelopeKey, now: '2026-07-23T00:00:00Z',
    })
  } catch (error) { caught = error }
  assert.ok(caught instanceof GipQualificationError && caught.reason === 'QUALIFICATION_DIGEST_MISMATCH',
    'a different profile version must not verify against this qualification')
}

function main() {
  frozenVocabulary()
  profileIdentity()
  complianceHarness()
  recovery()
  adjudication()
  driftGuard()
  qualificationDigestBinding()
  console.log('gip-bridge-bounded-read-profile.test.cjs OK')
}

main()
