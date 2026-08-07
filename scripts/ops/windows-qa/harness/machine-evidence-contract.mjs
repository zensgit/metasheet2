/**
 * Attendance Windows-native QA v2 — structured evidence contract (machine + operator kinds).
 *
 * Draft/HOLD. Synthetic data only. Pinned product SOURCE_SHA 0dc3596dd (unchanged by QA tooling).
 *
 * Shared by the harnesses that PRODUCE evidence and by the runner that VALIDATES it for a PASS. Kept as
 * a tiny, dependency-free module so the standalone runner can import it without pulling in `pg`/product
 * code. (The on-prem package requires THIS file by name — the runner imports it at startup.)
 *
 * TWO evidence kinds, one per PQA surface (owner direction a+):
 *   - machineEvidence@1 — for the route-less internal harness cases PQA-09/10. A PASS requires a
 *     STRUCTURED record whose `harnessModule` is the ONE whitelisted module FOR THAT CASE and whose
 *     `facts` match that case's EXACT schema (required keys + value types, no unknown/invented keys).
 *   - operatorEvidence@1 — for the operator-run HTTP/UI cases PQA-01..08. A PASS requires a structured
 *     record naming the tester + UTC timestamp + command/route + expected/observed + an artifact
 *     sha256 (screenshot / log digest) + the product sourceSha + the qaToolingSha, all bound to the
 *     package SHAs. For PQA-05/06/08 it additionally requires a per-case `boundaryAttestation` that the
 *     FULL matrix objective (not a thin fragment) was truly executed — else BLOCKED.
 *
 * WHY (owner P1). The runner used to accept a PASS on any long free-text string, and then on any
 * non-empty `facts` object with any `harnessModule` string — so a hand-written envelope with
 * `harnessModule:"totally-manual-not-a-real-harness.mjs"` + `facts:{invented:true}` forged a 10/10 PASS.
 * A JSON file is always copyable, so nothing here makes evidence perfectly unforgeable. What it DOES do
 * is bind each PASS to a case-specific shape a hand author cannot satisfy without the real artifact:
 * the whitelisted harness module + that case's exact fact schema (09/10), or a real artifact digest +
 * SHA binding + full-boundary attestation (01..08). The ACCURATE property is therefore: "PASS requires
 * a case-shaped, tooling-SHA-bound evidence record" — NOT "forgery-proof".
 */
export const MACHINE_EVIDENCE_SCHEMA = 'windows-qa/machine-evidence@1'
export const MACHINE_EVIDENCE_PRODUCER = 'windows-qa-harness'
export const OPERATOR_EVIDENCE_SCHEMA = 'windows-qa/operator-evidence@1'

const SHA40 = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Campaign runId (owner gate): binds the summary, every per-case evidence record, and each artifact
// manifest entry to ONE run so a same-product-SHA record from a DIFFERENT run cannot be spliced in.
export const RUN_ID_RE = /^[0-9a-zA-Z][0-9a-zA-Z._-]{7,63}$/

// Floors for operator-authored free text — raise the bar above a trivial token. Not proof of
// authenticity (an operator writes this file); a missing/short field fails closed.
const MIN_TESTER_LEN = 3
const MIN_TEXT_LEN = 8
const MIN_CMD_ROUTE_LEN = 3

/**
 * Owner P1 — case → its ONE legitimate harness module. An envelope whose `harnessModule` is not the
 * whitelisted module FOR THAT CASE is rejected. Only these two cases accept machineEvidence at all; a
 * machineEvidence attached to any other case id is rejected (those are operatorEvidence cases).
 */
export const MACHINE_EVIDENCE_CASE_HARNESS = Object.freeze({
  'PQA-09': 'pqa-09-outbox-retry.mjs',
  'PQA-10': 'pqa-10-scheduled-sweep.mjs',
})

/**
 * Owner P1 — per-case EXACT `facts` schema: the required fact keys, their value TYPES, AND — for every
 * load-bearing fact — a VALUE PREDICATE. Types ALONE let a well-typed-but-WRONG record forge a PASS: the
 * owner forged PQA-09 with the correct case + whitelisted harness + runId + SHA + the full key set, but
 * values that denote a FAILED scenario (pass2DeliveryState='definitely-not-delivered', sinkDeliveries=999,
 * businessDmlTablesChanged=999, businessDmlTablesTracked=0, negative attempts) — and it PASSED. Each
 * predicate below (`equals` exact / `min` floor / `integer` whole-number) EQUALS the value the REAL
 * harness (pqa-09-outbox-retry.mjs / pqa-10-scheduled-sweep.mjs) emits on a genuine PASS — derived from
 * the value the harness THROWS on if it differs (the cited `Lnn` is that assertion) and CONFIRMED against
 * the real emitted summary.json — so the genuine harness output still PASSes while any wrong-but-well-
 * typed value is REJECTED. Types: 'number' (finite), 'string' (non-empty), 'boolean', 'uuid'; constraints:
 * `equals`, `min`, `integer`. The harnesses self-validate against this shape at emit time (buildMachine-
 * Evidence) so any drift between what a harness asserts and this contract fails LOUDLY there, not here.
 */
export const MACHINE_EVIDENCE_FACTS_SCHEMA = Object.freeze({
  'PQA-09': Object.freeze({
    scheduledRunId: { type: 'uuid' }, // a fresh product-minted run UUID — no fixed value
    outboxRowCount: { type: 'number', integer: true, equals: 1 }, // pqa-09 L117: `rowCount !== 1` throws (no duplicate DML)
    pass1AttemptsAfterFailure: { type: 'number', integer: true, min: 0, equals: 1 }, // L93: attempts=1 after the injected failure
    pass2AttemptsAfterRetry: { type: 'number', integer: true, min: 0, equals: 2 }, // L114: attempts=2 after the retry
    pass2DeliveryState: { type: 'string', equals: 'delivered' }, // L114: `!== 'delivered'` throws
    sinkDeliveries: { type: 'number', integer: true, equals: 1 }, // L118: `delivered.length !== 1` throws
    deliveredEventKind: { type: 'string', equals: 'attendance.absence.generated' }, // L118: the one delivered event kind
    businessDmlTablesChanged: { type: 'number', integer: true, equals: 0 }, // L125: `changed.length > 0` throws (no duplicate DML)
    businessDmlTablesTracked: { type: 'number', integer: true, min: 1 }, // Object.keys(before).length over the 8 baseline tables; harness asserts no absolute count, only a >0 denominator is meaningful
  }),
  'PQA-10': Object.freeze({
    scheduledRunId: { type: 'uuid' },
    createdKind: { type: 'string', equals: 'created_running' }, // w4-common L93: `!== 'created_running'` throws
    reTriggerKind: { type: 'string', equals: 'resumed' }, // pqa-10 L88: `resumed.kind !== 'resumed'` throws (idempotent re-trigger)
    generation: { type: 'number', integer: true, equals: 1 }, // L88 pins it to runRow.generation; fresh (org,'cron',work_date) partition => MAX(gen)+1 = 1 (w4c2-scheduled-run.ts L634-638)
    runningRowsForIdentity: { type: 'number', integer: true, equals: 1 }, // L96: `runningCount !== 1` throws (one running row, no fork)
    sweepScanned: { type: 'number', integer: true, equals: 1 }, // L107: `sweep.scanned < 1` throws; the isolated single-run flow sweeps exactly the one running run => 1
    sweepNotReady: { type: 'number', integer: true, equals: 1 }, // L107: `sweep.notReady < 1` throws; the one running run is not_ready => 1
    sweepFinalized: { type: 'number', integer: true, equals: 0 }, // L107: `sweep.finalized !== 0` throws
    targetTerminalOutcome: { type: 'string', equals: 'completed' }, // L130: `!== 'completed'` throws
    outboxEventKind: { type: 'string', equals: 'attendance.absence.generated' }, // L148: `!== 'attendance.absence.generated'` throws
    outboxIdentityKind: { type: 'string', equals: 'scheduled_run' }, // L149: `!== 'scheduled_run'` throws
    outboxDeliveredState: { type: 'string', equals: 'delivered' }, // L164: `!== 'delivered'` throws
    sinkDeliveries: { type: 'number', integer: true, equals: 1 }, // L164: `delivered.length !== 1` throws
    runStateAfterFinalize: { type: 'string', equals: 'completed' }, // L141: `runAfter.state !== 'completed'` throws (terminal state)
  }),
})

/**
 * Owner P1/req-4 — PQA-05/06/08 stay BLOCKED unless the FULL boundary was truly executed. Their
 * operatorEvidence must carry a `boundaryAttestation` attesting the matrix objective's load-bearing
 * outcomes (not a thin fragment). Each key is `{ type, equals }`: the attested value must EQUAL the
 * objective's required outcome, so a thin/empty attestation cannot pass them.
 */
export const OPERATOR_BOUNDARY_ATTESTATION_SCHEMA = Object.freeze({
  // "Exact synthetic-org shadow keeps the legacy projection AND appends W4 shadow evidence."
  'PQA-05': Object.freeze({
    legacyProjectionUnchanged: { type: 'boolean', equals: true },
    shadowCalculationRowsAppended: { type: 'number', min: 1 },
  }),
  // "Duplicate/ambiguous candidates produce review-required, never a fabricated authoritative projection."
  'PQA-06': Object.freeze({
    outcome: { type: 'string', equals: 'review_required' },
    dailyProjectionNull: { type: 'boolean', equals: true },
  }),
  // "Changing a shift definition does not mutate an old snapshot; a new mismatch becomes review-required."
  'PQA-08': Object.freeze({
    oldSnapshotUnmutated: { type: 'boolean', equals: true },
    mismatchReviewRequired: { type: 'boolean', equals: true },
  }),
})

/**
 * Owner P3 — EXACT top-level envelope allowlists. `facts` / `boundaryAttestation` already reject unknown
 * keys; the machineEvidence / operatorEvidence / artifact-manifest TOP-LEVEL objects must too, so a
 * hand-authored envelope cannot smuggle an extra top-level field past the shape check. Each list is the
 * EXACT set the real emitters produce:
 *   - machineEvidence: the ten keys buildMachineEvidence() emits (qa-runtime.mjs) — the eight enforced
 *     fields plus the legit metadata `qaToolingShaSource` (the tooling-SHA provenance) + `producedAt`.
 *   - operatorEvidence: the fields the operator records per the runbook — schema/caseId/runId/tester/
 *     timestamp/command/route/expected/observed/artifact/sourceSha/qaToolingSha, plus the per-case
 *     `boundaryAttestation` (present only for PQA-05/06/08).
 *   - artifact manifest: exactly `{ path, sha256, runId }`.
 * A key outside its list fails the envelope closed (not silently ignored — an ignored unknown field is
 * exactly how a stale/forged attribute would slip through).
 */
export const MACHINE_EVIDENCE_TOP_LEVEL_KEYS = Object.freeze([
  'schema',
  'producedBy',
  'caseId',
  'runId',
  'harnessModule',
  'determination',
  'qaToolingSha',
  'qaToolingShaSource',
  'facts',
  'producedAt',
])

export const OPERATOR_EVIDENCE_TOP_LEVEL_KEYS = Object.freeze([
  'schema',
  'caseId',
  'runId',
  'tester',
  'timestamp',
  'command',
  'route',
  'expected',
  'observed',
  'artifact',
  'sourceSha',
  'qaToolingSha',
  'boundaryAttestation',
])

export const ARTIFACT_MANIFEST_KEYS = Object.freeze(['path', 'sha256', 'runId'])

/** Reject any top-level key not in `allowed`. Returns an error string or null. */
function checkTopLevelAllowlist(obj, allowed, label) {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k))
  if (extra.length > 0) {
    return `${label} carries unknown top-level key(s): ${extra.join(', ')} (only ${allowed.join(', ')} are allowed).`
  }
  return null
}

/** True when `caseId` is one of the machine-evidence (route-less harness) cases. */
export function isMachineEvidenceCase(caseId) {
  return Object.prototype.hasOwnProperty.call(MACHINE_EVIDENCE_CASE_HARNESS, caseId)
}

function checkTypedField(value, spec) {
  switch (spec.type) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a finite number'
      break
    case 'string':
      if (typeof value !== 'string' || value.length === 0) return 'must be a non-empty string'
      break
    case 'boolean':
      if (typeof value !== 'boolean') return 'must be a boolean'
      break
    case 'uuid':
      if (typeof value !== 'string' || !UUID.test(value)) return 'must be a UUID string'
      break
    default:
      return `has an unknown schema type "${spec.type}"`
  }
  // Owner P1 (well-typed-but-WRONG guard) — an `integer: true` spec additionally requires a WHOLE
  // number. Row counts / attempts / delivery tallies are integers; a fractional 1.5 is well-typed as a
  // finite number but is not a value the real harness can emit, so it must be rejected too. (Runs after
  // the type switch so a non-number still reports the plainer "must be a finite number" first.)
  if (spec.integer === true && !Number.isInteger(value)) {
    return 'must be an integer'
  }
  if (Object.prototype.hasOwnProperty.call(spec, 'equals') && value !== spec.equals) {
    return `must equal ${JSON.stringify(spec.equals)}`
  }
  if (Object.prototype.hasOwnProperty.call(spec, 'min') && typeof value === 'number' && value < spec.min) {
    return `must be >= ${spec.min}`
  }
  return null
}

/**
 * Validate an object against an EXACT schema: every required key present with the right type, no
 * unknown/invented keys. Returns null on success or an error string. This is what makes "missing a
 * required fact / carrying an invented key / wrong type" a rejection rather than an ignored field.
 */
function validateSchemaObject(obj, schema, label) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return `${label} must be an object of the required keys.`
  }
  const allowed = Object.keys(schema)
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      return `${label} is missing required key "${key}".`
    }
    const err = checkTypedField(obj[key], schema[key])
    if (err) return `${label}.${key} ${err}.`
  }
  const extra = Object.keys(obj).filter((k) => !Object.prototype.hasOwnProperty.call(schema, k))
  if (extra.length > 0) {
    return `${label} carries unknown key(s): ${extra.join(', ')} (only ${allowed.join(', ')} are allowed).`
  }
  return null
}

/**
 * Owner runId binding — the record's runId must be a well-formed campaign runId AND, when an
 * `expectedRunId` (the summary's runId) is supplied, must EQUAL it. A record carrying a stale/foreign
 * runId (old evidence spliced into this run's summary) is rejected. Returns an error string or null.
 */
function checkRunId(value, expectedRunId, label) {
  if (typeof value !== 'string' || !RUN_ID_RE.test(value)) {
    return `${label}.runId must be a campaign runId (8-64 chars of [A-Za-z0-9._-]).`
  }
  if (expectedRunId && value !== expectedRunId) {
    return `${label}.runId ${value} does not match the summary campaign runId ${expectedRunId} (stale/foreign-run evidence is rejected).`
  }
  return null
}

/**
 * Validate the SHAPE of an operatorEvidence artifact manifest entry `{ path, sha256, runId }`. The
 * actual file digest recompute (read the file, sha-256, compare) + traversal/symlink guards happen in
 * the runner (it holds the evidence dir + fs). Here we reject a path that is absolute or contains a
 * `..` segment, a malformed sha256, and (when `expectedRunId` is given) an artifact runId that does not
 * equal the summary runId.
 */
function validateArtifactManifestEntry(artifact, expectedRunId) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    return 'operatorEvidence.artifact must be a manifest object { path, sha256, runId }.'
  }
  // Owner P3 — exact manifest shape: reject any key beyond { path, sha256, runId }.
  const artifactTopLevelError = checkTopLevelAllowlist(artifact, ARTIFACT_MANIFEST_KEYS, 'operatorEvidence.artifact')
  if (artifactTopLevelError) return artifactTopLevelError
  const rel = artifact.path
  if (typeof rel !== 'string' || rel.trim().length === 0) {
    return 'operatorEvidence.artifact.path must be a non-empty path (relative to the evidence dir).'
  }
  if (rel.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rel)) {
    return `operatorEvidence.artifact.path must be RELATIVE to the evidence dir, not absolute: ${rel}`
  }
  if (rel.split(/[\\/]/).some((seg) => seg === '..')) {
    return `operatorEvidence.artifact.path must not traverse out of the evidence dir (no ".." segment): ${rel}`
  }
  if (typeof artifact.sha256 !== 'string' || !SHA256.test(artifact.sha256)) {
    return 'operatorEvidence.artifact.sha256 must be a 64-char lowercase sha256 of the artifact file.'
  }
  const runIdError = checkRunId(artifact.runId, expectedRunId, 'operatorEvidence.artifact')
  if (runIdError) return runIdError
  return null
}

/**
 * Validate the STRUCTURED machine-evidence envelope required for a PASS on PQA-09/10. Returns
 * `{ ok: true }` or `{ ok: false, error }`. `caseId` is REQUIRED — it selects the whitelisted harness
 * module + the exact facts schema AND the envelope's own `caseId` must equal it (no cross-case reuse).
 * When `expectedQaToolingSha` is supplied, `qaToolingSha` must equal it (owner P2); when
 * `expectedRunId` is supplied, the envelope's `runId` must equal it (owner runId binding). Both are
 * omitted for the harness self-check at emit time (only the shape is enforced there).
 */
export function validateMachineEvidence(machineEvidence, { expectedQaToolingSha, expectedRunId, caseId } = {}) {
  const me = machineEvidence
  if (typeof caseId !== 'string' || !isMachineEvidenceCase(caseId)) {
    return {
      ok: false,
      error: `machineEvidence is not accepted for ${caseId ?? 'an unknown case'} — only ${Object.keys(
        MACHINE_EVIDENCE_CASE_HARNESS,
      ).join('/')} produce machine evidence; the operator-run cases require operatorEvidence.`,
    }
  }
  if (!me || typeof me !== 'object' || Array.isArray(me)) {
    return {
      ok: false,
      error:
        'PASS requires a structured machineEvidence object produced by a harness (a long free-text ' +
        'reason/evidence string is no longer accepted as proof of a PASS).',
    }
  }
  // Owner P3 — exact top-level envelope: reject any key the real emitter does not produce.
  const topLevelError = checkTopLevelAllowlist(me, MACHINE_EVIDENCE_TOP_LEVEL_KEYS, 'machineEvidence')
  if (topLevelError) return { ok: false, error: topLevelError }
  if (me.schema !== MACHINE_EVIDENCE_SCHEMA) {
    return { ok: false, error: `machineEvidence.schema must be "${MACHINE_EVIDENCE_SCHEMA}"; got: ${me.schema ?? 'undefined'}.` }
  }
  if (me.producedBy !== MACHINE_EVIDENCE_PRODUCER) {
    return {
      ok: false,
      error: `machineEvidence.producedBy must be "${MACHINE_EVIDENCE_PRODUCER}" (a harness-emitted record); got: ${me.producedBy ?? 'undefined'}.`,
    }
  }
  // Owner gate 2/5(d) — the envelope's OWN caseId must equal the case slot: a PQA-09 envelope
  // masquerading as PQA-10 (or vice versa) is rejected, not accepted by the whitelist alone.
  if (me.caseId !== caseId) {
    return {
      ok: false,
      error: `machineEvidence.caseId must equal the case slot ${caseId}; got: ${me.caseId ?? 'undefined'} (no cross-case reuse).`,
    }
  }
  const expectedModule = MACHINE_EVIDENCE_CASE_HARNESS[caseId]
  if (me.harnessModule !== expectedModule) {
    return {
      ok: false,
      error: `machineEvidence.harnessModule for ${caseId} must be the whitelisted "${expectedModule}"; got: ${me.harnessModule ?? 'undefined'}.`,
    }
  }
  const runIdError = checkRunId(me.runId, expectedRunId, 'machineEvidence')
  if (runIdError) return { ok: false, error: runIdError }
  if (me.determination !== 'PASS') {
    return {
      ok: false,
      error: `machineEvidence.determination must be "PASS" for a PASS case (the harness's own verdict); got: ${me.determination ?? 'undefined'}.`,
    }
  }
  if (typeof me.qaToolingSha !== 'string' || !SHA40.test(me.qaToolingSha)) {
    return { ok: false, error: 'machineEvidence.qaToolingSha must be a 40-char lowercase git SHA.' }
  }
  if (expectedQaToolingSha && me.qaToolingSha !== expectedQaToolingSha) {
    return {
      ok: false,
      error: `machineEvidence.qaToolingSha ${me.qaToolingSha} does not match the package QA_TOOLING_SHA ${expectedQaToolingSha}.`,
    }
  }
  const factsError = validateSchemaObject(me.facts, MACHINE_EVIDENCE_FACTS_SCHEMA[caseId], 'machineEvidence.facts')
  if (factsError) {
    return { ok: false, error: factsError }
  }
  return { ok: true }
}

/**
 * Validate the STRUCTURED operator-evidence envelope required for a PASS on PQA-01..08. Returns
 * `{ ok: true }` or `{ ok: false, error }`. The envelope's `caseId` must equal the case slot (no
 * swapped-case reuse) and its `runId`/`artifact.runId` must equal the summary campaign `runId`. Binds
 * `sourceSha`/`qaToolingSha` to the package SHAs and requires an artifact MANIFEST entry
 * `{ path, sha256, runId }`; the runner recomputes the file digest. For PQA-05/06/08 it additionally
 * requires a per-case `boundaryAttestation` attesting the FULL matrix objective.
 */
export function validateOperatorEvidence(
  operatorEvidence,
  { expectedSourceSha, expectedQaToolingSha, expectedRunId, caseId } = {},
) {
  const oe = operatorEvidence
  if (!oe || typeof oe !== 'object' || Array.isArray(oe)) {
    return {
      ok: false,
      error:
        'PASS requires a structured operatorEvidence object (caseId + runId + tester + timestamp + ' +
        'command/route + expected/observed + artifact manifest + bound source/tooling SHAs). A status + long reason is not enough.',
    }
  }
  // Owner P3 — exact top-level envelope: reject any key the runbook does not have the operator record.
  const oeTopLevelError = checkTopLevelAllowlist(oe, OPERATOR_EVIDENCE_TOP_LEVEL_KEYS, 'operatorEvidence')
  if (oeTopLevelError) return { ok: false, error: oeTopLevelError }
  if (oe.schema !== OPERATOR_EVIDENCE_SCHEMA) {
    return { ok: false, error: `operatorEvidence.schema must be "${OPERATOR_EVIDENCE_SCHEMA}"; got: ${oe.schema ?? 'undefined'}.` }
  }
  // Owner gate 2/5(e) — the envelope's OWN caseId must equal the case slot (no swapped-case reuse).
  if (oe.caseId !== caseId) {
    return {
      ok: false,
      error: `operatorEvidence.caseId must equal the case slot ${caseId}; got: ${oe.caseId ?? 'undefined'} (no swapped-case reuse).`,
    }
  }
  const recordRunIdError = checkRunId(oe.runId, expectedRunId, 'operatorEvidence')
  if (recordRunIdError) return { ok: false, error: recordRunIdError }
  if (typeof oe.tester !== 'string' || oe.tester.trim().length < MIN_TESTER_LEN) {
    return { ok: false, error: `operatorEvidence.tester must name the tester (>= ${MIN_TESTER_LEN} chars).` }
  }
  if (typeof oe.timestamp !== 'string' || !/T.*(Z)$/.test(oe.timestamp) || Number.isNaN(Date.parse(oe.timestamp))) {
    return { ok: false, error: 'operatorEvidence.timestamp must be a UTC ISO-8601 instant ending in Z (e.g. 2026-08-06T09:00:00Z).' }
  }
  const command = typeof oe.command === 'string' ? oe.command.trim() : ''
  const route = typeof oe.route === 'string' ? oe.route.trim() : ''
  if (command.length < MIN_CMD_ROUTE_LEN && route.length < MIN_CMD_ROUTE_LEN) {
    return { ok: false, error: `operatorEvidence must record the command or route exercised (>= ${MIN_CMD_ROUTE_LEN} chars).` }
  }
  if (typeof oe.expected !== 'string' || oe.expected.trim().length < MIN_TEXT_LEN) {
    return { ok: false, error: `operatorEvidence.expected must describe the expected result (>= ${MIN_TEXT_LEN} chars).` }
  }
  if (typeof oe.observed !== 'string' || oe.observed.trim().length < MIN_TEXT_LEN) {
    return { ok: false, error: `operatorEvidence.observed must describe the observed result (>= ${MIN_TEXT_LEN} chars).` }
  }
  const artifactError = validateArtifactManifestEntry(oe.artifact, expectedRunId)
  if (artifactError) return { ok: false, error: artifactError }
  if (typeof oe.sourceSha !== 'string' || !SHA40.test(oe.sourceSha.trim().toLowerCase())) {
    return { ok: false, error: 'operatorEvidence.sourceSha must be a 40-char lowercase git SHA.' }
  }
  if (expectedSourceSha && oe.sourceSha.trim().toLowerCase() !== expectedSourceSha) {
    return {
      ok: false,
      error: `operatorEvidence.sourceSha ${oe.sourceSha} does not match the package SOURCE_SHA ${expectedSourceSha}.`,
    }
  }
  if (typeof oe.qaToolingSha !== 'string' || !SHA40.test(oe.qaToolingSha.trim().toLowerCase())) {
    return { ok: false, error: 'operatorEvidence.qaToolingSha must be a 40-char lowercase git SHA.' }
  }
  if (expectedQaToolingSha && oe.qaToolingSha.trim().toLowerCase() !== expectedQaToolingSha) {
    return {
      ok: false,
      error: `operatorEvidence.qaToolingSha ${oe.qaToolingSha} does not match the package QA_TOOLING_SHA ${expectedQaToolingSha}.`,
    }
  }
  // Owner req-4 — the full-boundary cases must attest the objective's load-bearing outcomes.
  if (Object.prototype.hasOwnProperty.call(OPERATOR_BOUNDARY_ATTESTATION_SCHEMA, caseId)) {
    const attestError = validateSchemaObject(
      oe.boundaryAttestation,
      OPERATOR_BOUNDARY_ATTESTATION_SCHEMA[caseId],
      `operatorEvidence.boundaryAttestation for ${caseId}`,
    )
    if (attestError) {
      return {
        ok: false,
        error: `${attestError} ${caseId} stays BLOCKED unless the FULL boundary was truly executed and attested.`,
      }
    }
  }
  return { ok: true }
}
