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
 * Owner P1 — per-case EXACT `facts` schema: the required fact keys (and value types) the real harness
 * actually asserts. An envelope missing a required fact, carrying an unknown/invented key, or with a
 * wrong type is rejected. Types: 'number' (finite), 'string' (non-empty), 'boolean', 'uuid'. Derived
 * key-for-key from the harnesses (pqa-09-outbox-retry.mjs / pqa-10-scheduled-sweep.mjs) — the harnesses
 * self-validate against this shape at emit time so any drift fails loudly there, not silently here.
 */
export const MACHINE_EVIDENCE_FACTS_SCHEMA = Object.freeze({
  'PQA-09': Object.freeze({
    scheduledRunId: { type: 'uuid' },
    outboxRowCount: { type: 'number' },
    pass1AttemptsAfterFailure: { type: 'number' },
    pass2AttemptsAfterRetry: { type: 'number' },
    pass2DeliveryState: { type: 'string' },
    sinkDeliveries: { type: 'number' },
    deliveredEventKind: { type: 'string' },
    businessDmlTablesChanged: { type: 'number' },
    businessDmlTablesTracked: { type: 'number' },
  }),
  'PQA-10': Object.freeze({
    scheduledRunId: { type: 'uuid' },
    createdKind: { type: 'string' },
    reTriggerKind: { type: 'string' },
    generation: { type: 'number' },
    runningRowsForIdentity: { type: 'number' },
    sweepScanned: { type: 'number' },
    sweepNotReady: { type: 'number' },
    sweepFinalized: { type: 'number' },
    targetTerminalOutcome: { type: 'string' },
    outboxEventKind: { type: 'string' },
    outboxIdentityKind: { type: 'string' },
    outboxDeliveredState: { type: 'string' },
    sinkDeliveries: { type: 'number' },
    runStateAfterFinalize: { type: 'string' },
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
