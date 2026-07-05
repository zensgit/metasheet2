'use strict'

// Read-source resolver composition — C-R2: PURE chain planner/evaluator (#1709, per
// docs/development/integration-read-source-resolver-composition-design-lock-20260703.md).
//
// Scope fence: pure functions only. NO route, NO outbound call, NO adapter, NO persistence, NO write,
// NO recursion. The C-R3 chain runtime executor has since shipped and lives in
// read-source-composition-runtime.cjs, which consumes this planner's output; later rungs (recursive
// expansion) remain a separate, gated opt-in. This module only:
//   1. plans an approved two-hop composition (reusing the C-R1 save-time validator verbatim, so
//      approved-only / resolver_lookup-only / write-shaped-step-rejected all hold at plan time),
//   2. derives hop N+1's key-only input from hop N's resolved single value — a typed scalar handoff
//      validated by the SAME normalizeReadSourceProbeInputs predicate the probe/read runtime enforces
//      (no second key predicate to drift), and
//   3. stitches values-free per-step chain evidence: a `{step, ok, rule?, errorCode?}` vector only —
//      never the intermediate resolved value, candidate values, field/target names, hosts, credentials,
//      or the runtime key (design-lock lock 5).
// Final chain data carries ONLY the last hop's single resolver output (target + value); intermediate
// resolved values (e.g. the FItemID between materialNumber and FBOMNumber) are never exposed (lock 5).
//
// Never-throw contract: every exported function returns a fail-closed, values-free result for ANY
// input — including accessor-bearing / throwing hop data from a buggy non-R1 producer. Hop fields are
// read ONCE through a guarded snapshot so validation and projection share the same read (no TOCTOU
// getter can pass validation with one value and expose another), and each body has a fail-closed
// catch so no exception (and no exception MESSAGE — a leak channel) can escape.
//
// Chain-only scalar narrowing (explicit): the standalone R1 resolver can emit a non-scalar resolved
// value (its only output guard is blank/missing — a K3 boolean flag or object field is a legitimate
// STANDALONE read product). A CHAIN is narrower by design: lock 2 makes every handoff a typed single
// scalar, and the chain product is the last hop's single value. A hop that resolves to a non-scalar
// therefore fails the CHAIN with the dedicated STEP_OUTPUT_NOT_SCALAR code (not a generic failure
// that would contradict the hop's own ok evidence). R1/R2 standalone behavior is unchanged.

const {
  COMPOSITION_MAX_STEPS,
  COMPOSITION_MIN_STEPS,
  validateReadSourceCompositionConfig,
} = require('./read-source-composition-config.cjs')
const { normalizeReadSourceProbeInputs } = require('./read-source-probe-runtime.cjs')
const { READ_SOURCE_PROBE_ERROR_CODES, safeResolverRule } = require('./read-source-probe-contract.cjs')

// Chain-level coarse codes. Per-hop resolver failures keep their own READ_SOURCE_RESOLVER_* /
// READ_SOURCE_PROBE_* codes inside the step vector; these codes cover what only the CHAIN can fail on.
const READ_SOURCE_COMPOSITION_PLAN_ERROR_CODES = Object.freeze([
  'READ_SOURCE_COMPOSITION_PLAN_INVALID',
  'READ_SOURCE_COMPOSITION_STEP_ORDINAL_INVALID',
  'READ_SOURCE_COMPOSITION_HANDOFF_VALUE_MISSING',
  'READ_SOURCE_COMPOSITION_HANDOFF_TARGET_MISMATCH',
  'READ_SOURCE_COMPOSITION_HANDOFF_VALUE_INVALID',
  'READ_SOURCE_COMPOSITION_STEP_FAILED',
  'READ_SOURCE_COMPOSITION_STEP_NOT_RUN',
  'READ_SOURCE_COMPOSITION_STEP_OUTPUT_NOT_SCALAR',
])

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function freezeDeep(value) {
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item)
    return Object.freeze(value)
  }
  if (isPlainObject(value)) {
    for (const item of Object.values(value)) freezeDeep(item)
    return Object.freeze(value)
  }
  return value
}

// Registered-code guard for values copied out of hop evidence. Hop evidence is already sanitized by
// readSourceProbeEvidence, but the evaluator fails closed anyway — and against the EXACT registered
// probe/resolver code set (READ_SOURCE_PROBE_ERROR_CODES includes the resolver codes), never a
// token-shape regex: a token-shaped-but-unregistered value (e.g. a leaked business identifier that
// happens to look like A_CODE) collapses to the chain-level STEP_FAILED code instead of riding into
// the stitched vector.
const REGISTERED_STEP_ERROR_CODES = new Set(READ_SOURCE_PROBE_ERROR_CODES)

function safeStepErrorCode(value) {
  if (typeof value === 'string' && REGISTERED_STEP_ERROR_CODES.has(value)) return value
  return 'READ_SOURCE_COMPOSITION_STEP_FAILED'
}

// Guarded ONE-read snapshot of a hop's resolver output. Each field is read exactly once; validation
// and any later projection use this snapshot, never a second property read (TOCTOU-safe). A getter
// that throws yields null (a failed hop), not an escaped exception.
//   null                       → not resolved (missing / malformed / blank / throwing)
//   { target, value, scalar }  → resolved; `scalar` says whether the value is chain-usable
//                                (finite number or non-blank string — lock 2's typed single scalar)
function snapshotResolverData(data) {
  try {
    if (!isPlainObject(data)) return null
    const resolver = data.resolver
    if (!isPlainObject(resolver)) return null
    const target = resolver.target
    const value = resolver.value
    if (typeof target !== 'string' || target.trim().length === 0) return null
    if (value === undefined || value === null) return null
    if (typeof value === 'string' && value.trim().length === 0) return null
    const scalar =
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && value.trim().length > 0)
    return { target, value, scalar }
  } catch {
    return null
  }
}

// Back-compat boolean view of the snapshot (a resolved, chain-usable hop).
function isResolverData(data) {
  const snapshot = snapshotResolverData(data)
  return snapshot !== null && snapshot.scalar === true
}

// A consumable plan must carry the C-R1 step bounds (2..2 in v1) and the matching handoff arity: a
// zero-step or over-long shape is structural misuse and fails closed BEFORE any evaluate/derive
// arithmetic can touch it (a zero-step plan would otherwise read hopOutcomes[-1] and crash instead
// of returning PLAN_INVALID).
function isPlanShaped(plan) {
  return (
    isPlainObject(plan) &&
    Number.isInteger(plan.stepCount) &&
    plan.stepCount >= COMPOSITION_MIN_STEPS &&
    plan.stepCount <= COMPOSITION_MAX_STEPS &&
    Array.isArray(plan.steps) &&
    plan.steps.length === plan.stepCount &&
    Array.isArray(plan.handoffs) &&
    plan.handoffs.length === plan.stepCount - 1
  )
}

function planInvalidResult() {
  return Object.freeze({ ok: false, errorCode: 'READ_SOURCE_COMPOSITION_PLAN_INVALID' })
}

function planInvalidOutcome() {
  return freezeDeep({
    evidence: { ok: false, failedStep: null, errorCode: 'READ_SOURCE_COMPOSITION_PLAN_INVALID', steps: [] },
    data: null,
  })
}

// ── 1. plan ────────────────────────────────────────────────────────────────────────────────────────
// Validates via the C-R1 validator (approved-only when options.readConfigsById is supplied) and shapes
// the ordered execution plan. The plan carries config identifiers only — never endpoints, filters,
// credentials, or values.
function planReadSourceComposition(composition, options = {}) {
  // Approval is a plan-time gate (design-lock lock 1). The C-R1 validator only verifies that each
  // referenced step config is APPROVED / resolver_lookup / read-only WHEN an approved-config map is
  // supplied (validateReferencedReadConfigs returns early when options.readConfigsById is absent) —
  // so a plan produced without that map is approval-UNVERIFIED. This planner is the C-R3 executor
  // seam: it fails closed rather than emit an unvetted plan. A caller (the C-R3 runtime) MUST pass
  // options.readConfigsById (the approved-status read-config map); omission is a contract violation,
  // never a valid "preview" plan.
  if (!isPlainObject(options) || options.readConfigsById === undefined || options.readConfigsById === null) {
    return freezeDeep({ ok: false, errorCode: 'READ_SOURCE_COMPOSITION_PLAN_INVALID', errors: [] })
  }
  let result
  try {
    result = validateReadSourceCompositionConfig(composition, options)
  } catch {
    return freezeDeep({ ok: false, errorCode: 'READ_SOURCE_COMPOSITION_PLAN_INVALID', errors: [] })
  }
  if (!result.valid) {
    return freezeDeep({ ok: false, errorCode: 'READ_SOURCE_COMPOSITION_PLAN_INVALID', errors: result.errors })
  }
  const normalized = result.normalized
  return freezeDeep({
    ok: true,
    plan: {
      name: normalized.name,
      stepCount: normalized.steps.length,
      steps: normalized.steps.map((step, ordinal) => ({
        ordinal,
        id: step.id,
        readSourceConfigId: step.readSourceConfigId,
      })),
      handoffs: normalized.steps.slice(1).map((step, index) => ({
        toOrdinal: index + 1,
        fromOrdinal: index,
        sourceTarget: step.input.sourceTarget,
        toInput: 'key',
      })),
    },
  })
}

// ── 2. derive ──────────────────────────────────────────────────────────────────────────────────────
// Derives hop `stepOrdinal`'s key-only input from the PREVIOUS hop's resolved data. The handoff is a
// typed single scalar: the prior resolver's declared output target must match the config-declared
// wiring, and the value must pass the SAME key predicate the runtime applies (reused, not re-stated).
// Failure vocabulary is pinned:
//   VALUE_MISSING   — the prior hop never resolved (null / malformed / blank / throwing data)
//   TARGET_MISMATCH — resolved, but to a different declared output target than the wiring expects
//   VALUE_INVALID   — resolved, but the value is not usable as a runtime key (non-scalar, over-long,
//                     control characters — anything the runtime key predicate rejects)
// Failure results carry ONLY { ok, errorCode } — never the value, target names, or any raw material.
function deriveCompositionStepInput(plan, stepOrdinal, priorData) {
  try {
    if (!isPlanShaped(plan)) return planInvalidResult()
    if (!Number.isInteger(stepOrdinal) || stepOrdinal < 1 || stepOrdinal >= plan.stepCount) {
      return Object.freeze({ ok: false, errorCode: 'READ_SOURCE_COMPOSITION_STEP_ORDINAL_INVALID' })
    }
    const handoff = plan.handoffs.find((entry) => isPlainObject(entry) && entry.toOrdinal === stepOrdinal)
    if (!handoff || typeof handoff.sourceTarget !== 'string') return planInvalidResult()
    const snapshot = snapshotResolverData(priorData)
    if (snapshot === null) {
      return Object.freeze({ ok: false, errorCode: 'READ_SOURCE_COMPOSITION_HANDOFF_VALUE_MISSING' })
    }
    if (snapshot.target !== handoff.sourceTarget) {
      return Object.freeze({ ok: false, errorCode: 'READ_SOURCE_COMPOSITION_HANDOFF_TARGET_MISMATCH' })
    }
    if (!snapshot.scalar) {
      return Object.freeze({ ok: false, errorCode: 'READ_SOURCE_COMPOSITION_HANDOFF_VALUE_INVALID' })
    }
    try {
      const inputs = normalizeReadSourceProbeInputs({ requiredNamedInputs: ['key'] }, { key: snapshot.value })
      return Object.freeze({ ok: true, inputs })
    } catch {
      return Object.freeze({ ok: false, errorCode: 'READ_SOURCE_COMPOSITION_HANDOFF_VALUE_INVALID' })
    }
  } catch {
    return planInvalidResult()
  }
}

// ── 3. evaluate ────────────────────────────────────────────────────────────────────────────────────
// Stitches per-hop outcomes ({ evidence, data } in step order; short array = chain aborted early) into
// the values-free chain vector. Any hop that did not resolve to a chain-usable scalar fails the CHAIN
// at that ordinal, and EVERY later ordinal is stitched STEP_NOT_RUN — even if a (contract-violating or
// evidence-trusting) executor supplied an outcome there. Lock 4's "downstream hops do not run" is
// enforced on the vector itself: post-failure entries are void, so stitched evidence can never certify
// a downstream execution after an abort. Chain data is the LAST hop's single resolver output,
// projected FROM THE VALIDATED SNAPSHOT (same read — nothing extra, and nothing unvalidated, can ride
// along).
function evaluateCompositionOutcome(plan, hopOutcomes) {
  try {
    if (!isPlanShaped(plan) || !Array.isArray(hopOutcomes) || hopOutcomes.length > plan.stepCount) {
      return planInvalidOutcome()
    }
    const steps = []
    let failedStep = null
    let lastSnapshot = null
    for (let ordinal = 0; ordinal < plan.stepCount; ordinal += 1) {
      if (failedStep !== null || ordinal >= hopOutcomes.length) {
        steps.push({ step: ordinal, ok: false, errorCode: 'READ_SOURCE_COMPOSITION_STEP_NOT_RUN' })
        if (failedStep === null) failedStep = ordinal
        continue
      }
      let entry
      try {
        const hop = hopOutcomes[ordinal]
        const evidence = isPlainObject(hop) && isPlainObject(hop.evidence) ? hop.evidence : {}
        const rule = safeResolverRule(evidence.rule)
        const snapshot = isPlainObject(hop) ? snapshotResolverData(hop.data) : null
        // A hop is a success ONLY when it BOTH claims success (evidence.ok === true) AND carries a
        // chain-usable scalar. Keying on the data snapshot alone would trust a contradictory hop
        // (evidence.ok === false but resolver-shaped data) and certify a stale/aborted value as chain
        // success — a fail-OPEN the real R1 producer never emits (it nulls data on failure), but the
        // module's threat model is a buggy / evidence-trusting non-R1 producer, so the seam requires
        // both to agree. The mirror direction (ok evidence + non-resolver data = failed) was already
        // enforced; this closes the other direction.
        const hopOk = evidence.ok === true && snapshot !== null && snapshot.scalar === true
        entry = { step: ordinal, ok: hopOk }
        if (rule !== null) entry.rule = rule
        if (!hopOk) {
          // A hop that CLAIMED success but RESOLVED to a non-scalar gets the dedicated chain-only code
          // (see the narrowing note in the header) instead of contradicting its own ok evidence
          // generically. A hop that claimed FAILURE keeps its own coarse code (via safeStepErrorCode).
          entry.errorCode =
            evidence.ok === true && snapshot !== null && snapshot.scalar !== true
              ? 'READ_SOURCE_COMPOSITION_STEP_OUTPUT_NOT_SCALAR'
              : safeStepErrorCode(evidence.errorCode)
        } else {
          lastSnapshot = snapshot
        }
      } catch {
        entry = { step: ordinal, ok: false, errorCode: 'READ_SOURCE_COMPOSITION_STEP_FAILED' }
      }
      steps.push(entry)
      if (!entry.ok && failedStep === null) failedStep = ordinal
    }
    const ok = failedStep === null
    const chainEvidence = { ok, failedStep, steps }
    if (!ok) chainEvidence.errorCode = 'READ_SOURCE_COMPOSITION_STEP_FAILED'
    const data = ok && lastSnapshot !== null
      ? { resolver: { target: lastSnapshot.target, value: lastSnapshot.value } }
      : null
    return freezeDeep({ evidence: chainEvidence, data })
  } catch {
    return planInvalidOutcome()
  }
}

module.exports = {
  READ_SOURCE_COMPOSITION_PLAN_ERROR_CODES,
  planReadSourceComposition,
  deriveCompositionStepInput,
  evaluateCompositionOutcome,
  __internals: {
    isResolverData,
    snapshotResolverData,
    safeStepErrorCode,
  },
}
