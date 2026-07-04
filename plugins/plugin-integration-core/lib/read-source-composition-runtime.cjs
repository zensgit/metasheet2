'use strict'

// Read-source resolver composition — C-R3: chain runtime EXECUTOR (#1709, per
// docs/development/integration-read-source-resolver-composition-design-lock-20260703.md).
//
// Orchestrates an APPROVED two-hop composition in order, per-hop fail-closed, with values-free stitched
// evidence, READ-ONLY. It reuses the shipped pieces verbatim — it does NOT fork a second read/resolver
// path:
//   - the C-R2 planner (plan / derive / stitch) for ordering, the typed single-scalar handoff, and the
//     values-free chain evidence + last-hop-only data projection,
//   - the S3-1 `executeConfiguredRead` for each hop's bounded, capped, SSRF-reguarded outbound read,
//   - the R1 resolver (invoked inside `executeConfiguredRead` for resolver_lookup mode) for the per-hop
//     multiplicity selection.
//
// Scope fence (same discipline as read-source-read-runtime.cjs): pure orchestration + injected deps. NO
// route, NO persistence lookup inside this module (the route wiring — plus the config-store approved-only
// load, the client vocab mirror, and any UI — is a LATER gated rung; the route passes an already-loaded,
// already-approved composition config + a resolved per-step bundle in), NO write path, NO recursion (the
// plan depth is the C-R1 fixed bound), NO new credential path.
//
// Gate (design-lock C-R3): approved-only (the planner re-validates every referenced step config's
// status==='approved' + resolver_lookup + read-only + handoff-target match as defense-in-depth over the
// route's own load), key-only (the runtime request carries ONLY the first hop's business key — every
// intermediate key is DERIVED by the platform from the prior hop, never runtime-supplied), no write, no
// recursion. Nothing about the chain — not the intermediate resolved value, candidate values,
// field/target names, host, credential, tenant/system id, or the runtime key — rides into the chain
// evidence; the chain data is ONLY the last hop's single resolver output.

const {
  prepareConfiguredRead,
  executeConfiguredRead,
} = require('./read-source-read-runtime.cjs')
const {
  planReadSourceComposition,
  deriveCompositionStepInput,
  evaluateCompositionOutcome,
} = require('./read-source-composition-planner.cjs')

// Chain runtime request = key-only, exactly the S3-2 strict allowlist ({ inputs: { key } }). A request
// that tries to supply a config override, a per-hop key, a target/sheet id, or any other field is a
// contract violation → throw (route maps to 4xx), never a silently-dropped extra.
const COMPOSITION_RUNTIME_BODY_KEYS = Object.freeze(['inputs'])
const COMPOSITION_RUNTIME_INPUT_KEYS = Object.freeze(['key'])

class ReadSourceCompositionRuntimeError extends Error {
  constructor(reason) {
    super(`read_source_composition_runtime_${reason}`)
    this.name = 'ReadSourceCompositionRuntimeError'
    this.reason = reason
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

// Strict chain-boundary request validation (lock 3). Returns the first-hop key-only inputs object; the
// key VALUE is validated downstream by prepareConfiguredRead → normalizeReadSourceProbeInputs (the same
// bounded-key predicate every read uses), so no second key predicate lives here.
function normalizeCompositionRuntimeRequest(runtimeInput) {
  if (!isPlainObject(runtimeInput)) {
    throw new ReadSourceCompositionRuntimeError('request_not_object')
  }
  for (const key of Object.keys(runtimeInput)) {
    if (!COMPOSITION_RUNTIME_BODY_KEYS.includes(key)) {
      throw new ReadSourceCompositionRuntimeError('unexpected_field')
    }
  }
  const inputs = runtimeInput.inputs
  if (!isPlainObject(inputs)) {
    throw new ReadSourceCompositionRuntimeError('inputs_invalid')
  }
  for (const key of Object.keys(inputs)) {
    if (!COMPOSITION_RUNTIME_INPUT_KEYS.includes(key)) {
      throw new ReadSourceCompositionRuntimeError('inputs_unexpected_field')
    }
  }
  // Pass the key through unchanged; prepareConfiguredRead enforces the bounded-key contract.
  return { key: inputs.key }
}

function stepBundleById(stepConfigsById, id) {
  if (stepConfigsById instanceof Map) return stepConfigsById.get(id) || null
  if (isPlainObject(stepConfigsById)) return Object.prototype.hasOwnProperty.call(stepConfigsById, id) ? stepConfigsById[id] : null
  return null
}

// A per-hop outcome that failed to even RUN (a server-config inconsistency — kind mismatch, a step config
// that is not normalized, a missing bundle). Shaped so evaluateCompositionOutcome stitches it as a failed
// step (STEP_FAILED) and every downstream ordinal STEP_NOT_RUN. Values-free: no error message, no config.
function stepRunFailureOutcome() {
  return { evidence: { ok: false }, data: null }
}

// Execute one hop: build the plan-bound read + run the S3-1 executor. Any contract-level throw from
// prepare/execute (kind mismatch, non-normalized step config, missing bundle) becomes a values-free
// failed-hop outcome so the CHAIN fails closed instead of throwing a server-config error out.
async function executeChainHop(bundle, inputs, { createAdapter, timeoutMs }) {
  if (!isPlainObject(bundle) || !isPlainObject(bundle.config) || bundle.system === undefined) {
    return stepRunFailureOutcome()
  }
  try {
    const prepared = prepareConfiguredRead({ config: bundle.config, inputs })
    const outcome = await executeConfiguredRead(prepared, {
      system: bundle.system,
      createAdapter,
      timeoutMs,
    })
    if (!isPlainObject(outcome) || !isPlainObject(outcome.evidence)) return stepRunFailureOutcome()
    return outcome
  } catch {
    return stepRunFailureOutcome()
  }
}

// Execute an approved composition chain. Returns { evidence, data } for ALL execution outcomes (the
// values-free stitched chain vector; data = last hop's single resolver output, null on any failure).
// Throws ONLY for a client-supplied runtime-request contract violation (route → 4xx). A composition
// config that does not plan (unapproved / write-shaped / mis-wired step, or bad shape) returns a
// values-free PLAN_INVALID outcome with the C-R1 validator's values-free error triples.
async function executeReadSourceComposition(compositionConfig, runtimeInput, deps = {}) {
  const firstKeyInputs = normalizeCompositionRuntimeRequest(runtimeInput)
  const createAdapter = deps.createAdapter
  const timeoutMs = deps.timeoutMs
  const stepConfigsById = deps.stepConfigsById
  if (typeof createAdapter !== 'function') {
    throw new ReadSourceCompositionRuntimeError('create_adapter_required')
  }

  // Build the approved-read-config map from the resolved per-step bundle so the planner re-validates
  // approved-only / resolver-only / read-only / handoff-target as defense-in-depth over the route load.
  //
  // Fail-closed status coercion (defense-in-depth must not fail OPEN): the C-R1 validator's status
  // check is deliberately OPTIONAL at save-time (`ref.status !== undefined && ref.status !== 'approved'`
  // → an absent status is skipped). At RUNTIME approved-only is a HARD gate, so a bundle that lacks a
  // status — the exact route-side mistake this layer exists to catch — must NOT slip through as
  // approved. Only a literal 'approved' is forwarded as approved; every other value (missing / undefined
  // / draft / null / anything) is forwarded as an explicit not-approved marker so the planner rejects it.
  const readConfigsById = {}
  if (isPlainObject(compositionConfig) && Array.isArray(compositionConfig.steps)) {
    for (const step of compositionConfig.steps) {
      if (!isPlainObject(step) || typeof step.readSourceConfigId !== 'string') continue
      const bundle = stepBundleById(stepConfigsById, step.readSourceConfigId)
      if (bundle) {
        readConfigsById[step.readSourceConfigId] = {
          status: bundle.status === 'approved' ? 'approved' : 'not_approved',
          config: bundle.config,
        }
      }
    }
  }

  const planned = planReadSourceComposition(compositionConfig, { readConfigsById })
  if (!planned.ok) {
    return Object.freeze({
      evidence: Object.freeze({
        ok: false,
        failedStep: null,
        errorCode: 'READ_SOURCE_COMPOSITION_PLAN_INVALID',
        planErrors: Object.freeze(Array.isArray(planned.errors) ? planned.errors.map((e) => Object.freeze({ ...e })) : []),
        steps: Object.freeze([]),
      }),
      data: null,
    })
  }
  const plan = planned.plan

  // Orchestrate hops in order. `deriveCompositionStepInput` is the SINGLE gate between hops: it encodes
  // every fail-closed rule (prior hop failed / resolved non-scalar / wrong declared target), so a
  // failing derive aborts the chain and the missing tail is stitched STEP_NOT_RUN.
  const hopOutcomes = []
  let inputsForHop = firstKeyInputs
  for (let ordinal = 0; ordinal < plan.stepCount; ordinal += 1) {
    const step = plan.steps[ordinal]
    const bundle = stepBundleById(stepConfigsById, step.readSourceConfigId)
    const outcome = await executeChainHop(bundle, inputsForHop, { createAdapter, timeoutMs })
    hopOutcomes.push(outcome)

    const nextOrdinal = ordinal + 1
    if (nextOrdinal >= plan.stepCount) break
    const derived = deriveCompositionStepInput(plan, nextOrdinal, outcome.data)
    if (!derived.ok) break // abort: downstream hops never run (lock 4)
    inputsForHop = derived.inputs
  }

  return evaluateCompositionOutcome(plan, hopOutcomes)
}

module.exports = {
  ReadSourceCompositionRuntimeError,
  executeReadSourceComposition,
  __internals: {
    normalizeCompositionRuntimeRequest,
    stepBundleById,
  },
}
