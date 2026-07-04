'use strict'

// Read-source resolver composition — C-R2: PURE chain planner/evaluator (#1709, per
// docs/development/integration-read-source-resolver-composition-design-lock-20260703.md).
//
// Scope fence: pure functions only. NO route, NO outbound call, NO adapter, NO persistence, NO write,
// NO recursion. The C-R3 chain runtime executor is a separate, later, gated opt-in. This module only:
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

const { validateReadSourceCompositionConfig } = require('./read-source-composition-config.cjs')
const { normalizeReadSourceProbeInputs } = require('./read-source-probe-runtime.cjs')
const { safeResolverRule } = require('./read-source-probe-contract.cjs')

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

// Coarse-code token guard for values copied out of hop evidence. Hop evidence is already sanitized by
// readSourceProbeEvidence, but the evaluator fails closed anyway: a non-token errorCode collapses to
// the chain-level STEP_FAILED code instead of riding into the stitched vector.
function safeStepErrorCode(value) {
  if (typeof value === 'string' && /^[A-Z0-9_]{1,64}$/.test(value)) return value
  return 'READ_SOURCE_COMPOSITION_STEP_FAILED'
}

// R1 success data shape: { resolver: { target, value } } with a non-blank scalar value. Anything else
// is not a resolved hop (fail-closed, never fail-soft).
function isResolverData(data) {
  if (!isPlainObject(data) || !isPlainObject(data.resolver)) return false
  const { target, value } = data.resolver
  if (typeof target !== 'string' || target.trim().length === 0) return false
  if (typeof value === 'number' && Number.isFinite(value)) return true
  if (typeof value === 'string' && value.trim().length > 0) return true
  return false
}

function isPlanShaped(plan) {
  return (
    isPlainObject(plan) &&
    Number.isInteger(plan.stepCount) &&
    Array.isArray(plan.steps) &&
    plan.steps.length === plan.stepCount &&
    Array.isArray(plan.handoffs)
  )
}

// ── 1. plan ────────────────────────────────────────────────────────────────────────────────────────
// Validates via the C-R1 validator (approved-only when options.readConfigsById is supplied) and shapes
// the ordered execution plan. The plan carries config identifiers only — never endpoints, filters,
// credentials, or values.
function planReadSourceComposition(composition, options = {}) {
  const result = validateReadSourceCompositionConfig(composition, options)
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
// Failure results carry ONLY { ok, errorCode } — never the value, target names, or any raw material.
function deriveCompositionStepInput(plan, stepOrdinal, priorData) {
  if (!isPlanShaped(plan)) {
    return Object.freeze({ ok: false, errorCode: 'READ_SOURCE_COMPOSITION_PLAN_INVALID' })
  }
  if (!Number.isInteger(stepOrdinal) || stepOrdinal < 1 || stepOrdinal >= plan.stepCount) {
    return Object.freeze({ ok: false, errorCode: 'READ_SOURCE_COMPOSITION_STEP_ORDINAL_INVALID' })
  }
  const handoff = plan.handoffs.find((entry) => isPlainObject(entry) && entry.toOrdinal === stepOrdinal)
  if (!handoff || typeof handoff.sourceTarget !== 'string') {
    return Object.freeze({ ok: false, errorCode: 'READ_SOURCE_COMPOSITION_PLAN_INVALID' })
  }
  if (!isResolverData(priorData)) {
    return Object.freeze({ ok: false, errorCode: 'READ_SOURCE_COMPOSITION_HANDOFF_VALUE_MISSING' })
  }
  if (priorData.resolver.target !== handoff.sourceTarget) {
    return Object.freeze({ ok: false, errorCode: 'READ_SOURCE_COMPOSITION_HANDOFF_TARGET_MISMATCH' })
  }
  try {
    const inputs = normalizeReadSourceProbeInputs(
      { requiredNamedInputs: ['key'] },
      { key: priorData.resolver.value },
    )
    return Object.freeze({ ok: true, inputs })
  } catch {
    return Object.freeze({ ok: false, errorCode: 'READ_SOURCE_COMPOSITION_HANDOFF_VALUE_INVALID' })
  }
}

// ── 3. evaluate ────────────────────────────────────────────────────────────────────────────────────
// Stitches per-hop outcomes ({ evidence, data } in step order; short array = chain aborted early) into
// the values-free chain vector. Any hop that did not resolve fails the CHAIN at that ordinal and marks
// every later hop STEP_NOT_RUN (design-lock lock 4: downstream hops do not run). Chain data is the
// LAST hop's single resolver output, explicitly re-projected so nothing extra can ride along.
function evaluateCompositionOutcome(plan, hopOutcomes) {
  if (!isPlanShaped(plan) || !Array.isArray(hopOutcomes) || hopOutcomes.length > plan.stepCount) {
    return freezeDeep({
      evidence: { ok: false, failedStep: null, errorCode: 'READ_SOURCE_COMPOSITION_PLAN_INVALID', steps: [] },
      data: null,
    })
  }
  const steps = []
  let failedStep = null
  for (let ordinal = 0; ordinal < plan.stepCount; ordinal += 1) {
    if (ordinal >= hopOutcomes.length) {
      steps.push({ step: ordinal, ok: false, errorCode: 'READ_SOURCE_COMPOSITION_STEP_NOT_RUN' })
      if (failedStep === null) failedStep = ordinal
      continue
    }
    const hop = hopOutcomes[ordinal]
    const evidence = isPlainObject(hop) && isPlainObject(hop.evidence) ? hop.evidence : {}
    const rule = safeResolverRule(evidence.rule)
    const hopOk = isPlainObject(hop) && isResolverData(hop.data)
    const entry = { step: ordinal, ok: hopOk }
    if (rule !== null) entry.rule = rule
    if (!hopOk) {
      entry.errorCode = safeStepErrorCode(evidence.errorCode)
      if (failedStep === null) failedStep = ordinal
    }
    steps.push(entry)
  }
  const ok = failedStep === null
  const chainEvidence = { ok, failedStep, steps }
  if (!ok) chainEvidence.errorCode = 'READ_SOURCE_COMPOSITION_STEP_FAILED'
  const last = ok ? hopOutcomes[plan.stepCount - 1] : null
  const data = ok
    ? { resolver: { target: last.data.resolver.target, value: last.data.resolver.value } }
    : null
  return freezeDeep({ evidence: chainEvidence, data })
}

module.exports = {
  READ_SOURCE_COMPOSITION_PLAN_ERROR_CODES,
  planReadSourceComposition,
  deriveCompositionStepInput,
  evaluateCompositionOutcome,
  __internals: {
    isResolverData,
    safeStepErrorCode,
  },
}
