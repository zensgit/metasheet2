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
  __internals: profileInternals,
} = require(path.join(__dirname, '..', 'lib', 'gip-bridge-bounded-read-profile.cjs'))

const {
  runReadActionProfileComplianceBattery,
  summarizeBatteryForEvidence,
  BATTERY_CHECK_IDS,
} = require(path.join(__dirname, '..', 'lib', 'gip-profile-compliance-harness.cjs'))

const {
  deriveRecoveryStrategy,
  validateCompletenessEvidence,
  GIP_RECOVERY_STRATEGIES,
  GipProfileContractError,
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

// The profile module's own source with line comments stripped — used by the two
// SOURCE-LEVEL invariants below (fail() vocabulary discipline, recovery delegation).
// Source-level, NOT behavioural: it pins how the module is written, which is exactly
// what those two invariants claim. Behavioural guards live in the sections above.
const PROFILE_SOURCE_PATH = path.join(__dirname, '..', 'lib', 'gip-bridge-bounded-read-profile.cjs')
function profileSourceWithoutComments() {
  const src = fs.readFileSync(PROFILE_SOURCE_PATH, 'utf8')
  assert.ok(src.length > 1000, 'profile source must actually be readable (empty read is not absence)')
  return src.replace(/\/\/.*$/gm, '')
}

function rejectsWith(fn, reason) {
  let caught = null
  try { fn() } catch (error) { caught = error }
  assert.ok(caught instanceof BridgeBoundedReadError, `expected BridgeBoundedReadError (${reason})`)
  assert.equal(caught.reason, reason)
  return caught
}

// Async sibling: await `fn`, assert it rejected, and that `predicate(error)` holds.
async function rejectsAsync(fn, predicate, message) {
  let caught = null
  try { await fn() } catch (error) { caught = error }
  assert.ok(caught, `${message} — expected a rejection, got none`)
  assert.ok(predicate(caught), `${message} — rejection did not match (got: ${caught && caught.code} / ${caught && caught.message})`)
  return caught
}

// The compliance battery runs against the REAL exported profile, not a re-typed copy — a
// hand-maintained duplicate can silently diverge, leaving the battery to certify a fiction.
// `actionProfileVersion` is stripped because the normalizer EMITS it but REJECTS it as
// input (round-tripping its own output fails `PROFILE_NOT_OBJECT: undeclared top-level
// field`); if the normalizer ever emits another output-only field, this reds — correctly.
const { actionProfileVersion: _emittedVersion, ...CANDIDATE } = BRIDGE_BOUNDED_READ_PROFILE

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
  const src = profileSourceWithoutComments()
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

  // LAYER 3 of the module's stated three-layer pin — the RUNTIME consumer. The source
  // scan above only sees LITERAL fail('X') call sites; this covers a dynamic reason and
  // is the only thing that keeps `fail()`'s own vocabulary check load-bearing (neutering
  // it to `if (false)` was previously green, and `__internals.fail` had no caller at all).
  const undeclaredReason = 'BOUNDED_READ_NOT_A_DECLARED_REASON'
  let coarse = null
  try { profileInternals.fail(undeclaredReason, 'probe', {}) } catch (error) { coarse = error }
  assert.ok(coarse instanceof Error && !(coarse instanceof BridgeBoundedReadError),
    'an undeclared reason must throw a plain internal Error, never a typed BridgeBoundedReadError')
  assert.match(coarse.message, /undeclared error reason/)
  assert.ok(!coarse.message.includes(undeclaredReason),
    'the internal token is COARSE — it must never echo the rejected reason value')
  // POSITIVE CONTROL: a fail() that threw for everything would satisfy the check above.
  // Every DECLARED reason must still come through as the typed, reason-carrying error.
  for (const reason of BRIDGE_BOUNDED_READ_ERROR_REASONS) {
    let typed = null
    try { profileInternals.fail(reason, 'probe', { field: 'probe' }) } catch (error) { typed = error }
    assert.ok(typed instanceof BridgeBoundedReadError && typed.reason === reason,
      `declared reason ${reason} must still fail() as a typed BridgeBoundedReadError`)
  }
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
  assert.equal(p.implementationVersion, 'bridge-readonly-adapter.v2')
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

  // SOURCE-LEVEL invariant (honestly labelled: this pins how the wrapper is WRITTEN, not
  // what it returns). The module comments "delegates to the shared derivation — never
  // declared here", and GIP contracts REFUSE a declared recovery strategy outright
  // (`RECOVERY_DECLARATION_FORBIDDEN`). Both values agree today, so no behavioural probe
  // can separate "derives" from "hardcodes 'WHOLE_RERUN'" — the claim itself is textual,
  // so the evidence is textual, matching the fail()-scan pattern above.
  const body = profileSourceWithoutComments()
    .split('function bridgeBoundedReadRecoveryStrategy()')[1]
  assert.ok(body, 'bridgeBoundedReadRecoveryStrategy must exist in the source')
  const wrapper = body.slice(0, body.indexOf('\n}') + 2)
  assert.ok(wrapper.includes('deriveRecoveryStrategy('),
    'the recovery wrapper must DELEGATE to the shared derivation')
  for (const strategy of GIP_RECOVERY_STRATEGIES) {
    assert.ok(!wrapper.includes(strategy),
      `the recovery wrapper must not DECLARE a strategy literal (${strategy}) — recovery is derived`)
  }
}

// ── 5. Completeness adjudication — SHORT_PAGE only; everything else fails closed ──
function adjudication() {
  // SHORT PAGE (rows < clamp) ⇒ SHORT_PAGE proof, certificate-legal
  const shortEv = adjudicateBoundedReadCompleteness({ pageRowCount: 12, reportedClamp: 500 })
  assert.deepEqual({ runOutcome: shortEv.runOutcome, used: [...shortEv.usedCompletenessProofs] },
    { runOutcome: 'successful', used: ['SHORT_PAGE'] })
  assert.equal(assertCompletenessEvidenceCertified(shortEv).runOutcome, 'successful')
  validateCompletenessEvidence(BRIDGE_BOUNDED_READ_PROFILE, shortEv)
  // …and it must actually VALIDATE against THIS certificate, not pass evidence through.
  // This is the module's whole contribution here: wiring the shared validator to the
  // frozen profile. An uncertified proof (DECLARED_TOTAL — a v2 capability this adapter
  // cannot produce) must be REFUSED. Reading `.runOutcome` off the result alone is
  // satisfied by any passthrough, so the negative case is what makes the wiring testable.
  for (const uncertified of [
    { runOutcome: 'successful', usedCompletenessProofs: ['DECLARED_TOTAL'] },
    { runOutcome: 'successful', usedCompletenessProofs: ['SHORT_PAGE', 'DECLARED_TOTAL'] },
    { runOutcome: 'successful', usedCompletenessProofs: [] },
  ]) {
    let caught = null
    try { assertCompletenessEvidenceCertified(uncertified) } catch (error) { caught = error }
    assert.ok(caught instanceof GipProfileContractError && caught.reason === 'COMPLETENESS_EVIDENCE_INVALID',
      `evidence ${JSON.stringify(uncertified.usedCompletenessProofs)} is not certified by this profile and must be refused`)
  }

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
  const SECRET = 'SECRET_ROW_A17'
  // VALUES-FREE, THE LOAD-BEARING CASE: the undeclared-field rejection is the ONLY branch
  // that can ever see arbitrary caller-supplied data, so it is the only place a leak can
  // originate. It must report a COUNT and nothing else. (Without this assertion, adding
  // operator-friendly diagnostics — `{ field: key, value: runResult[key] }` — ships row
  // content onto an audit surface with the whole suite still green.)
  const leakyField = rejectsWith(
    () => adjudicateBoundedReadCompleteness({ pageRowCount: 10, reportedClamp: 500, rows: [{ secret: SECRET }] }),
    'BOUNDED_READ_RESULT_INVALID')
  assert.ok(!JSON.stringify({ m: leakyField.message, d: leakyField.details }).includes(SECRET),
    'the undeclared-field rejection must stay values-free — it must never echo row content')
  // …and it must not echo the undeclared FIELD NAME either (a name can itself be data).
  const leakyKey = rejectsWith(
    () => adjudicateBoundedReadCompleteness({ pageRowCount: 10, reportedClamp: 500, [SECRET]: 1 }),
    'BOUNDED_READ_RESULT_INVALID')
  assert.ok(!JSON.stringify({ m: leakyKey.message, d: leakyKey.details }).includes(SECRET),
    'the undeclared-field rejection must not echo the undeclared key name')
  assert.deepEqual(leakyKey.details, { fieldCount: 3 }, 'details are COUNTS ONLY')
  rejectsWith(() => adjudicateBoundedReadCompleteness(null), 'BOUNDED_READ_RESULT_INVALID')
  rejectsWith(() => adjudicateBoundedReadCompleteness({ pageRowCount: -1, reportedClamp: 500 }), 'BOUNDED_READ_RESULT_INVALID')
  rejectsWith(() => adjudicateBoundedReadCompleteness({ pageRowCount: 1.5, reportedClamp: 500 }), 'BOUNDED_READ_RESULT_INVALID')
  rejectsWith(() => adjudicateBoundedReadCompleteness({ pageRowCount: 10, reportedClamp: 0 }), 'BOUNDED_READ_RESULT_INVALID')

  // VALUES-FREE (declared-field route): a DECLARED field carrying junk routes to the
  // UNPROVABLE branch, which must not echo it either.
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

// ── 6b. ADAPTER REACHABILITY PIN — the certificate's BEHAVIOURAL claims ──
//   §6 pins three LITERALS (500, the kind key, the version string). A literal cannot
//   notice a behaviour change, so on its own the drift guard only proves "the profile
//   matches the label", not "the profile matches the adapter". This section pins the
//   three adapter behaviours the certificate actually rests on, driving the REAL adapter
//   through its own `fetchImpl` seam (hermetic: no network, no DB, no runtime wiring —
//   the test imports the adapter, the latent profile module still imports nothing).
//
//   *** If any assertion here has to change, the adapter's read/limit/completeness
//   surface changed ⇒ BUMP BRIDGE_READONLY_ADAPTER_IMPLEMENTATION_VERSION and re-certify.
//   This section is that rule's enforcement; the version string alone is only a label. ***
function bridgeSystemFixture() {
  return {
    id: 'bridge_gip_probe',
    name: 'Readonly Bridge Agent (GIP probe)',
    kind: BRIDGE_BOUNDED_READ_CONNECTOR_KIND,
    role: 'source',
    config: { baseUrl: 'http://127.0.0.1:19099/', maxLimit: 20, authHeaderName: 'X-MetaSheet-Bridge-Secret' },
    credentials: { sharedSecret: 'probe-secret' },
  }
}

// A configurable fake BA-M1 agent. CRITICAL: `recordCount` (what the agent returns) and
// `echoLimit` (what the agent SAYS it applied, data.limit) are INDEPENDENT knobs — the two
// were collapsed in the earlier version of this fake (`limit: body.limit`), which is exactly
// why it could not witness the applied-limit tear the owner reproduced. Records are NOT
// sliced to any limit, so "does the adapter trim?" is answered by the adapter, not the mock.
//   echoLimit: 'match'  → echo the requested clamp (conformant agent; the ONLY 200 shape a
//                         real agent produces — it 400s an over-limit request, never caps).
//   echoLimit: <int>    → echo a fixed value (simulate a non-conformant / divergent agent).
//   echoLimit: 'omit'   → return no data.limit at all (older/incomplete agent).
//   echoLimit: <other>  → return that raw value (e.g. a non-integer).
function bridgeAdapterReturning(recordCount, { echoLimit = 'match' } = {}) {
  return bridgeAdapter.createBridgeAgentReadonlyAdapter({
    system: bridgeSystemFixture(),
    fetchImpl: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined
      const isQuery = new URL(url).pathname === '/query/material' && options.method === 'POST'
      if (!isQuery) {
        return { ok: false, status: 404, async text() { return JSON.stringify({ error: { code: 'UNKNOWN_OBJECT', message: 'not allowlisted' } }) } }
      }
      const payload = {
        object: 'material',
        records: Array.from({ length: recordCount }, (_, i) => ({ FItemID: i + 1, FNumber: `MAT-${i + 1}` })),
        nextCursor: null,
        done: true,
      }
      if (echoLimit !== 'omit') {
        payload.limit = echoLimit === 'match' ? (body && body.limit) : echoLimit
      }
      return { ok: true, status: 200, async text() { return JSON.stringify(payload) } }
    },
  })
}

async function adapterReachabilityPin() {
  const REQUESTED_CLAMP = 7

  // (a) SHORT_PAGE is REACHABLE — proven end-to-end, not by reading the adapter.
  //     The adapter must report the clamp it applied (metadata.limit ⇒ the runtime's
  //     `effectiveLimit`, read-source-read-runtime.cjs:308 `safeCount(metadata.limit, …)`),
  //     because a short page cannot be judged without it. Drop it and this profile's ONLY
  //     completeness proof becomes unreachable — i.e. the certificate would be a lie.
  const shortRead = await bridgeAdapterReturning(2).read({ object: 'material', limit: REQUESTED_CLAMP })
  assert.equal(shortRead.metadata.limit, REQUESTED_CLAMP,
    'the adapter MUST report the clamp it applied — without it SHORT_PAGE is unreachable')
  const reachedShortPage = adjudicateBoundedReadCompleteness({
    pageRowCount: shortRead.records.length,
    reportedClamp: shortRead.metadata.limit,
  })
  assert.deepEqual([...reachedShortPage.usedCompletenessProofs], ['SHORT_PAGE'],
    'a real short read must adjudicate to the certified SHORT_PAGE proof')
  assert.equal(assertCompletenessEvidenceCertified(reachedShortPage).runOutcome, 'successful')

  // (a′) APPLIED-LIMIT VERIFICATION — the P1 the owner reproduced. The completeness reasoning
  //      may ONLY rest on the limit the AGENT confirms it applied (data.limit), never on the
  //      value the adapter locally computed and requested. adapter v2 fails closed unless the
  //      echo is present, a positive integer, and equal to the requested clamp.
  //
  //      *** THE EXACT OWNER REPRO — must FAIL CLOSED, not certify SHORT_PAGE ***
  //      request 7, the agent says it applied 2, and returns 2 records. Reporting our local 7
  //      would make a full page (2/2 at the agent's own bound) look like a short page (2/7 —
  //      "complete"): a completeness fail-OPEN. The adapter must refuse.
  await rejectsAsync(
    () => bridgeAdapterReturning(2, { echoLimit: 2 }).read({ object: 'material', limit: REQUESTED_CLAMP }),
    (error) => bridgeAdapter.BridgeAgentReadonlyAdapterError && error instanceof bridgeAdapter.BridgeAgentReadonlyAdapterError
      && error.code === 'BRIDGE_AGENT_REQUEST_FAILED',
    'agent-echoed limit (2) ≠ requested clamp (7) must FAIL CLOSED — a full page must never masquerade as short')
  //      POSITIVE CONTROL: same request, but the agent confirms it applied 7 (the conformant
  //      shape) and returns 2 rows ⇒ a genuine short page, which must SUCCEED and certify.
  const conformantShort = await bridgeAdapterReturning(2, { echoLimit: 'match' }).read({ object: 'material', limit: REQUESTED_CLAMP })
  assert.equal(conformantShort.metadata.limit, REQUESTED_CLAMP, 'a confirmed applied limit passes through verified')
  assert.deepEqual([...adjudicateBoundedReadCompleteness({
    pageRowCount: conformantShort.records.length, reportedClamp: conformantShort.metadata.limit,
  }).usedCompletenessProofs], ['SHORT_PAGE'])
  //      MISSING and NON-INTEGER echoes must also fail closed (unverified bound).
  await rejectsAsync(
    () => bridgeAdapterReturning(2, { echoLimit: 'omit' }).read({ object: 'material', limit: REQUESTED_CLAMP }),
    (error) => error && error.code === 'BRIDGE_AGENT_REQUEST_FAILED',
    'a missing applied-limit echo must fail closed')
  await rejectsAsync(
    () => bridgeAdapterReturning(2, { echoLimit: 'not-an-int' }).read({ object: 'material', limit: REQUESTED_CLAMP }),
    (error) => error && error.code === 'BRIDGE_AGENT_REQUEST_FAILED',
    'a non-integer applied-limit echo must fail closed')

  // (b) DECLARED_TOTAL is UNREACHABLE — the reason the certificate narrows to SHORT_PAGE
  //     ONLY (review P1). The runtime derives a source total from EXACTLY two metadata
  //     keys (read-source-read-runtime.cjs:291 `safeCount(metadata.dataRowCount,
  //     metadata.totalCount)`); the adapter propagates NEITHER, so `sourceTotalCount` is
  //     permanently null and the feeder's declared_total proof can never fire. The exact
  //     key-set pin is what makes this a guard rather than a comment: adding ANY metadata
  //     key (a total most of all) reds here and forces re-certification.
  assert.deepEqual(Object.keys(shortRead.metadata).sort(),
    ['count', 'filterFields', 'filtersApplied', 'limit', 'object', 'source'],
    'the adapter read metadata key set is CERTIFIED — a new key may change what the runtime can derive')
  for (const totalKey of ['dataRowCount', 'totalCount']) {
    assert.ok(!(totalKey in shortRead.metadata),
      `the adapter must NOT propagate ${totalKey} — the certificate excludes DECLARED_TOTAL because it cannot`)
  }

  // (c) `rows > clamp` is RUNTIME-REACHABLE, not merely hypothetical — the source-code
  //     claim the keep-strict fail-closed guard is justified by. The adapter does NOT trim
  //     an agent's records to the limit it reported, so an anomalous agent genuinely
  //     produces this shape; the profile then fails closed (false-fail, never
  //     false-complete). If the adapter ever starts trimming, this band becomes dead and
  //     the certificate's comment goes stale — red it here rather than let it rot.
  const overRead = await bridgeAdapterReturning(9).read({ object: 'material', limit: REQUESTED_CLAMP })
  assert.equal(overRead.records.length, 9,
    'the adapter must NOT trim agent records to the reported clamp — that is why rows > clamp is reachable')
  assert.equal(overRead.metadata.limit, REQUESTED_CLAMP)
  rejectsWith(() => adjudicateBoundedReadCompleteness({
    pageRowCount: overRead.records.length,
    reportedClamp: overRead.metadata.limit,
  }), 'BOUNDED_READ_RESULT_EXCEEDS_CLAMP')
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

async function main() {
  frozenVocabulary()
  profileIdentity()
  complianceHarness()
  recovery()
  adjudication()
  driftGuard()
  await adapterReachabilityPin()
  qualificationDigestBinding()
  console.log('gip-bridge-bounded-read-profile.test.cjs OK')
}

main().catch((error) => {
  // An async failure must exit NON-ZERO: this suite is a link in the `&&` chain that
  // plugin-integration-core's `test` script runs, and a swallowed rejection would make
  // the chain green on a red suite.
  console.error(error)
  process.exit(1)
})
