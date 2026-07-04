'use strict'

// Read-source composition C-R2 — pure chain planner/evaluator. No network, no route, no persistence,
// no write, no recursion. Locks under test (composition design-lock 2026-07-03):
//   lock 1  chain = bounded ordered APPROVED configs (plan reuses the C-R1 validator verbatim)
//   lock 2  typed single-value handoff (target-matched scalar, runtime key predicate reused)
//   lock 4  per-hop fail-closed, chain-level fail-closed, downstream hops do not run
//   lock 5  values-free stitched evidence; intermediate resolved values never exposed
//   lock 6  read-only (write-shaped step rejected at plan time)

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const MODULE_PATH = path.join(__dirname, '..', 'lib', 'read-source-composition-planner.cjs')
const {
  READ_SOURCE_COMPOSITION_PLAN_ERROR_CODES,
  planReadSourceComposition,
  deriveCompositionStepInput,
  evaluateCompositionOutcome,
  __internals,
} = require(MODULE_PATH)

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────────

function approvedReadConfig(overrides = {}) {
  return {
    status: 'approved',
    config: {
      mode: 'resolver_lookup',
      operations: ['read'],
      fieldMap: [{ source: 'FItemID', target: 'internal_id' }],
      ...overrides,
    },
  }
}

function composition(overrides = {}) {
  return {
    version: 1,
    name: 'material-to-bom',
    operations: ['read'],
    steps: [
      { id: 'resolve-item', readSourceConfigId: 'cfg-item' },
      {
        id: 'resolve-bom',
        readSourceConfigId: 'cfg-bom',
        input: { fromStep: 'resolve-item', sourceTarget: 'internal_id', toInput: 'key' },
      },
    ],
    ...overrides,
  }
}

function readConfigsById() {
  return {
    'cfg-item': approvedReadConfig(),
    'cfg-bom': approvedReadConfig({ fieldMap: [{ source: 'FBOMNumber', target: 'bom_number' }] }),
  }
}

function plannedPlan() {
  const planned = planReadSourceComposition(composition(), { readConfigsById: readConfigsById() })
  assert.equal(planned.ok, true)
  return planned.plan
}

function hopOutcome(rule, target, value) {
  return {
    evidence: { ok: true, object: 'material', mode: 'resolver_lookup', rule },
    data: { resolver: { target, value } },
  }
}

function failedHopOutcome(rule, errorCode) {
  return {
    evidence: { ok: false, object: 'material', mode: 'resolver_lookup', rule, errorCode, errorType: 'ReadSourceResolverError' },
    data: null,
  }
}

function assertValuesFree(subject, sentinels) {
  const text = JSON.stringify(subject)
  for (const sentinel of sentinels) {
    assert.ok(!text.includes(sentinel), `must not leak ${sentinel}: ${text}`)
  }
}

// ── purity tripwire ────────────────────────────────────────────────────────────────────────────────
function testPurity() {
  const source = fs.readFileSync(MODULE_PATH, 'utf8')
  assert.ok(
    !/require\(['"](node:)?(https?|net|tls|dns|child_process|worker_threads|fs)/.test(source),
    'planner must not require any I/O module',
  )
  assert.ok(!/\bfetch\s*\(/.test(source), 'planner must not fetch')
  assert.ok(!/\bquery\s*\(/.test(source), 'planner must not query a database')
  // Only the three sibling pure/contract modules may be required.
  const requires = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]).sort()
  assert.deepEqual(requires, [
    './read-source-composition-config.cjs',
    './read-source-probe-contract.cjs',
    './read-source-probe-runtime.cjs',
  ])
}

// ── plan (lock 1 / lock 6) ─────────────────────────────────────────────────────────────────────────
function testPlanValid() {
  const planned = planReadSourceComposition(composition(), { readConfigsById: readConfigsById() })
  assert.equal(planned.ok, true)
  const plan = planned.plan
  assert.equal(plan.name, 'material-to-bom')
  assert.equal(plan.stepCount, 2)
  assert.deepEqual(plan.steps, [
    { ordinal: 0, id: 'resolve-item', readSourceConfigId: 'cfg-item' },
    { ordinal: 1, id: 'resolve-bom', readSourceConfigId: 'cfg-bom' },
  ])
  assert.deepEqual(plan.handoffs, [
    { toOrdinal: 1, fromOrdinal: 0, sourceTarget: 'internal_id', toInput: 'key' },
  ])
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.steps) && Object.isFrozen(plan.handoffs[0]))
}

function testPlanRejectsWriteShapedAndUnapproved() {
  // lock 6: write-shaped composition never plans.
  const writeShaped = planReadSourceComposition(
    { ...composition(), savePath: '/K3API/Material/Save' },
    { readConfigsById: readConfigsById() },
  )
  assert.equal(writeShaped.ok, false)
  assert.equal(writeShaped.errorCode, 'READ_SOURCE_COMPOSITION_PLAN_INVALID')
  assert.ok(writeShaped.errors.some((e) => e.code === 'READ_SOURCE_COMPOSITION_WRITE_CONFIG_REJECTED'))

  // lock 1: a draft step config never plans (approved-only).
  const configs = readConfigsById()
  configs['cfg-bom'].status = 'draft'
  const unapproved = planReadSourceComposition(composition(), { readConfigsById: configs })
  assert.equal(unapproved.ok, false)
  assert.ok(unapproved.errors.some((e) => e.code === 'READ_SOURCE_COMPOSITION_STEP_NOT_APPROVED'))

  // Validator errors stay values-free triples.
  for (const e of [...writeShaped.errors, ...unapproved.errors]) {
    assert.deepEqual(Object.keys(e).sort(), ['code', 'field', 'reason'])
  }
  assertValuesFree(writeShaped, ['/K3API/Material/Save'])
}

// ── derive (lock 2) ────────────────────────────────────────────────────────────────────────────────
function testDeriveHappyPath() {
  const plan = plannedPlan()
  const stringDerive = deriveCompositionStepInput(plan, 1, { resolver: { target: 'internal_id', value: '  12345 ' } })
  assert.deepEqual(stringDerive, { ok: true, inputs: { key: '12345' } }) // trimmed by the runtime predicate
  assert.ok(Object.isFrozen(stringDerive) && Object.isFrozen(stringDerive.inputs))

  const numberDerive = deriveCompositionStepInput(plan, 1, { resolver: { target: 'internal_id', value: 987 } })
  assert.deepEqual(numberDerive.inputs, { key: '987' }) // same string coercion as the runtime
}

function testDeriveFailClosed() {
  const plan = plannedPlan()
  const cases = [
    // [stepOrdinal, priorData, expectedCode]
    [0, { resolver: { target: 'internal_id', value: 'x' } }, 'READ_SOURCE_COMPOSITION_STEP_ORDINAL_INVALID'],
    [2, { resolver: { target: 'internal_id', value: 'x' } }, 'READ_SOURCE_COMPOSITION_STEP_ORDINAL_INVALID'],
    [1.5, { resolver: { target: 'internal_id', value: 'x' } }, 'READ_SOURCE_COMPOSITION_STEP_ORDINAL_INVALID'],
    [1, null, 'READ_SOURCE_COMPOSITION_HANDOFF_VALUE_MISSING'],
    [1, undefined, 'READ_SOURCE_COMPOSITION_HANDOFF_VALUE_MISSING'],
    [1, { rows: [{ FItemID: 'x' }] }, 'READ_SOURCE_COMPOSITION_HANDOFF_VALUE_MISSING'],
    [1, { resolver: { target: 'internal_id', value: '   ' } }, 'READ_SOURCE_COMPOSITION_HANDOFF_VALUE_MISSING'], // blank never resolved
    [1, { resolver: { target: 'OTHER_TARGET_9', value: 'SECRET-HANDOFF-VALUE-1' } }, 'READ_SOURCE_COMPOSITION_HANDOFF_TARGET_MISMATCH'],
    [1, { resolver: { target: 'internal_id', value: 'k'.repeat(129) } }, 'READ_SOURCE_COMPOSITION_HANDOFF_VALUE_INVALID'], // > runtime max 128
    [1, { resolver: { target: 'internal_id', value: 'bad\u0007key' } }, 'READ_SOURCE_COMPOSITION_HANDOFF_VALUE_INVALID'], // control char
  ]
  for (const [ordinal, priorData, expected] of cases) {
    const derived = deriveCompositionStepInput(plan, ordinal, priorData)
    assert.equal(derived.ok, false, `ordinal=${ordinal} must fail`)
    assert.equal(derived.errorCode, expected)
    // Failure results carry ONLY { ok, errorCode } — never the value or target names.
    assert.deepEqual(Object.keys(derived).sort(), ['errorCode', 'ok'])
    assertValuesFree(derived, ['SECRET-HANDOFF-VALUE-1', 'OTHER_TARGET_9', 'internal_id'])
  }
  // Resolved-but-non-scalar values are VALUE_INVALID exactly (resolved ≠ missing) — pinned vocabulary:
  // MISSING = never resolved, MISMATCH = wrong declared target, INVALID = resolved but not key-usable.
  for (const value of [true, {}, ['12345'], Number.NaN]) {
    const derived = deriveCompositionStepInput(plan, 1, { resolver: { target: 'internal_id', value } })
    assert.equal(derived.ok, false)
    assert.equal(derived.errorCode, 'READ_SOURCE_COMPOSITION_HANDOFF_VALUE_INVALID')
  }
  // A malformed plan fails closed rather than deriving anything.
  const malformed = deriveCompositionStepInput({ steps: [] }, 1, { resolver: { target: 'internal_id', value: 'x' } })
  assert.equal(malformed.errorCode, 'READ_SOURCE_COMPOSITION_PLAN_INVALID')
}

// ── never-throw + single-read snapshot (accessor-bearing hop data) ─────────────────────────────────
function testAccessorBearingHopData() {
  const plan = plannedPlan()

  // A throwing value getter is a FAILED hop, not an escaped exception (and the exception message —
  // a leak channel — never surfaces anywhere in the outcome).
  const throwing = {
    evidence: { ok: true, rule: 'exactly_one' },
    data: { resolver: { target: 'internal_id', get value() { throw new Error('BOOM-SECRET-MSG') } } },
  }
  const thrownOutcome = evaluateCompositionOutcome(plan, [throwing])
  assert.equal(thrownOutcome.evidence.ok, false)
  assert.equal(thrownOutcome.evidence.failedStep, 0)
  assert.equal(thrownOutcome.evidence.steps[0].ok, false)
  assert.equal(thrownOutcome.data, null)
  assertValuesFree(thrownOutcome, ['BOOM-SECRET-MSG'])

  // TOCTOU getter (clean scalar on first read, smuggled object on the second) cannot defeat the
  // gate: validation and projection share ONE read, so the projected value is the validated one.
  let reads = 0
  const toctou = {
    evidence: { ok: true, rule: 'first_when_sorted' },
    data: { resolver: { target: 'bom_number', get value() { return ++reads === 1 ? 'CLEAN' : { leak: 'SECRET-BLOB' } } } },
  }
  const first = { evidence: { ok: true, rule: 'exactly_one' }, data: { resolver: { target: 'internal_id', value: 'i1' } } }
  const smuggled = evaluateCompositionOutcome(plan, [first, toctou])
  assert.equal(smuggled.evidence.ok, true)
  assert.deepEqual(smuggled.data, { resolver: { target: 'bom_number', value: 'CLEAN' } })
  assertValuesFree(smuggled, ['SECRET-BLOB'])

  // Same discipline on derive: a throwing prior getter is VALUE_MISSING, never an escaped throw.
  const derived = deriveCompositionStepInput(plan, 1, {
    resolver: { target: 'internal_id', get value() { throw new Error('DERIVE-BOOM') } },
  })
  assert.deepEqual(derived, { ok: false, errorCode: 'READ_SOURCE_COMPOSITION_HANDOFF_VALUE_MISSING' })

  // Getter-bearing plan / composition inputs also fail closed instead of throwing.
  const evilPlan = { get stepCount() { throw new Error('PLAN-BOOM') }, steps: [], handoffs: [] }
  assert.equal(evaluateCompositionOutcome(evilPlan, []).evidence.errorCode, 'READ_SOURCE_COMPOSITION_PLAN_INVALID')
  assert.equal(deriveCompositionStepInput(evilPlan, 1, null).errorCode, 'READ_SOURCE_COMPOSITION_PLAN_INVALID')
  const evilComposition = { get version() { throw new Error('CFG-BOOM') } }
  const planned = planReadSourceComposition(evilComposition, {})
  assert.equal(planned.ok, false)
  assert.equal(planned.errorCode, 'READ_SOURCE_COMPOSITION_PLAN_INVALID')
}

// ── L5 red test: chain data strips everything but target+value ─────────────────────────────────────
function testChainDataStripsExtraFields() {
  const plan = plannedPlan()
  const outcome = evaluateCompositionOutcome(plan, [
    hopOutcome('exactly_one', 'internal_id', 'i1'),
    {
      evidence: { ok: true, rule: 'first_when_sorted' },
      data: {
        resolver: { target: 'bom_number', value: 'BOM-OK', host: 'SECRET_HOST_X', candidateValues: ['SECRET-CAND-1'] },
        rawRows: [{ FBOMNumber: 'SECRET-RAW-ROW' }],
      },
    },
  ])
  assert.equal(outcome.evidence.ok, true)
  // deepEqual pins the EXACT shape: a `{ ...last.data.resolver }` spread regression fails here.
  assert.deepEqual(outcome.data, { resolver: { target: 'bom_number', value: 'BOM-OK' } })
  assertValuesFree(outcome, ['SECRET_HOST_X', 'SECRET-CAND-1', 'SECRET-RAW-ROW'])
}

// ── chain-only scalar narrowing: resolved non-scalar terminal hop ──────────────────────────────────
function testNonScalarResolvedHopGetsDedicatedCode() {
  const plan = plannedPlan()
  // R1 CAN legitimately resolve a boolean (K3 flag field) standalone; a CHAIN is scalar-only, and the
  // stitched entry must say so explicitly instead of contradicting the hop's ok evidence generically.
  const outcome = evaluateCompositionOutcome(plan, [
    hopOutcome('exactly_one', 'internal_id', 'i1'),
    { evidence: { ok: true, rule: 'field_equals' }, data: { resolver: { target: 'bom_number', value: true } } },
  ])
  assert.equal(outcome.evidence.ok, false)
  assert.equal(outcome.evidence.failedStep, 1)
  assert.deepEqual(outcome.evidence.steps[1], {
    step: 1,
    ok: false,
    rule: 'field_equals',
    errorCode: 'READ_SOURCE_COMPOSITION_STEP_OUTPUT_NOT_SCALAR',
  })
  assert.equal(outcome.data, null)
}

// ── L4 clamp: nothing can be stitched as run after an abort ────────────────────────────────────────
function testPostFailureOutcomesAreClamped() {
  const plan = plannedPlan()
  // A contract-violating (or evidence-trusting) executor supplies a SUCCESS outcome after hop 0
  // failed. The vector must not certify it: post-failure entries are void (STEP_NOT_RUN).
  const outcome = evaluateCompositionOutcome(plan, [
    failedHopOutcome('exactly_one', 'READ_SOURCE_RESOLVER_AMBIGUOUS'),
    hopOutcome('first_when_sorted', 'bom_number', 'SHOULD-BE-VOID'),
  ])
  assert.equal(outcome.evidence.ok, false)
  assert.equal(outcome.evidence.failedStep, 0)
  assert.deepEqual(outcome.evidence.steps[1], { step: 1, ok: false, errorCode: 'READ_SOURCE_COMPOSITION_STEP_NOT_RUN' })
  assert.ok(!outcome.evidence.steps.some((s) => s.step > 0 && s.ok), 'no ok entry may follow the failed step')
  assert.equal(outcome.data, null)
  assertValuesFree(outcome, ['SHOULD-BE-VOID'])
}

// ── evaluate (locks 4 + 5) ─────────────────────────────────────────────────────────────────────────
function testEvaluateSuccess() {
  const plan = plannedPlan()
  const outcome = evaluateCompositionOutcome(plan, [
    hopOutcome('exactly_one', 'internal_id', 'ITEM-SECRET-77'),
    hopOutcome('first_when_sorted', 'bom_number', 'BOM-2026-X'),
  ])
  assert.deepEqual(outcome.evidence, {
    ok: true,
    failedStep: null,
    steps: [
      { step: 0, ok: true, rule: 'exactly_one' },
      { step: 1, ok: true, rule: 'first_when_sorted' },
    ],
  })
  // lock 5: chain data = LAST hop's single output only; the intermediate value is not exposed anywhere.
  assert.deepEqual(outcome.data, { resolver: { target: 'bom_number', value: 'BOM-2026-X' } })
  assertValuesFree(outcome.evidence, ['ITEM-SECRET-77', 'BOM-2026-X', 'internal_id', 'bom_number'])
  assert.ok(!JSON.stringify(outcome.data).includes('ITEM-SECRET-77'), 'intermediate value must not ride into chain data')
  assert.ok(Object.isFrozen(outcome) && Object.isFrozen(outcome.evidence.steps[0]) && Object.isFrozen(outcome.data.resolver))
}

function testEvaluateHopFailureAborts() {
  const plan = plannedPlan()
  // Hop 0 ambiguated; the executor aborted, so hop 1 has no outcome at all.
  const outcome = evaluateCompositionOutcome(plan, [
    failedHopOutcome('exactly_one', 'READ_SOURCE_RESOLVER_AMBIGUOUS'),
  ])
  assert.equal(outcome.evidence.ok, false)
  assert.equal(outcome.evidence.failedStep, 0)
  assert.equal(outcome.evidence.errorCode, 'READ_SOURCE_COMPOSITION_STEP_FAILED')
  assert.deepEqual(outcome.evidence.steps, [
    { step: 0, ok: false, rule: 'exactly_one', errorCode: 'READ_SOURCE_RESOLVER_AMBIGUOUS' },
    { step: 1, ok: false, errorCode: 'READ_SOURCE_COMPOSITION_STEP_NOT_RUN' },
  ])
  assert.equal(outcome.data, null)
}

function testEvaluateIncompleteChainFailsClosed() {
  const plan = plannedPlan()
  // Executor stopped after a SUCCESSFUL hop 0 (crash/timeout upstream): the chain must NOT read as ok.
  const outcome = evaluateCompositionOutcome(plan, [hopOutcome('exactly_one', 'internal_id', 'ITEM-SECRET-77')])
  assert.equal(outcome.evidence.ok, false)
  assert.equal(outcome.evidence.failedStep, 1)
  assert.deepEqual(outcome.evidence.steps[1], { step: 1, ok: false, errorCode: 'READ_SOURCE_COMPOSITION_STEP_NOT_RUN' })
  assert.equal(outcome.data, null)
  // A successful-but-intermediate hop value still never leaks.
  assertValuesFree(outcome, ['ITEM-SECRET-77'])
}

function testEvaluateMalformedSuccessDataFailsClosed() {
  const plan = plannedPlan()
  // A hop claiming ok evidence but carrying non-resolver data (e.g. raw rows) is a FAILED hop.
  const outcome = evaluateCompositionOutcome(plan, [
    { evidence: { ok: true, rule: 'exactly_one' }, data: { rows: [{ FItemID: 'RAW-ROW-SECRET' }] } },
    hopOutcome('first_when_sorted', 'bom_number', 'BOM-2026-X'),
  ])
  assert.equal(outcome.evidence.ok, false)
  assert.equal(outcome.evidence.failedStep, 0)
  assert.equal(outcome.evidence.steps[0].ok, false)
  assert.equal(outcome.evidence.steps[0].errorCode, 'READ_SOURCE_COMPOSITION_STEP_FAILED')
  // The provided hop-1 success outcome after the failure is void (L4 clamp).
  assert.deepEqual(outcome.evidence.steps[1], { step: 1, ok: false, errorCode: 'READ_SOURCE_COMPOSITION_STEP_NOT_RUN' })
  assert.equal(outcome.data, null)
  assertValuesFree(outcome, ['RAW-ROW-SECRET', 'BOM-2026-X'])
}

function testEvaluateSanitizesForeignTokens() {
  const plan = plannedPlan()
  // Non-token errorCode / non-vocab rule from a buggy caller must not ride into the vector.
  const outcome = evaluateCompositionOutcome(plan, [
    {
      evidence: { ok: false, rule: 'made_up_rule', errorCode: 'boom: SELECT * FROM users -- SECRET-INJ' },
      data: null,
    },
  ])
  assert.deepEqual(outcome.evidence.steps[0], {
    step: 0,
    ok: false,
    errorCode: 'READ_SOURCE_COMPOSITION_STEP_FAILED',
  })
  assertValuesFree(outcome, ['SECRET-INJ', 'made_up_rule'])

  // P2 red test: TOKEN-SHAPED but UNREGISTERED codes must collapse too — the guard is the exact
  // registered probe/resolver code set, not a token-shape regex. A leaked business identifier that
  // happens to look like A_CODE (e.g. MAT_001_SECRET) must never ride into stitched evidence.
  const tokenShaped = evaluateCompositionOutcome(plan, [
    { evidence: { ok: false, rule: 'exactly_one', errorCode: 'MAT_001_SECRET' }, data: null },
  ])
  assert.equal(tokenShaped.evidence.steps[0].errorCode, 'READ_SOURCE_COMPOSITION_STEP_FAILED')
  assertValuesFree(tokenShaped, ['MAT_001_SECRET'])

  // Registered probe codes (non-resolver) pass through exactly.
  const probeCode = evaluateCompositionOutcome(plan, [
    { evidence: { ok: false, rule: 'exactly_one', errorCode: 'READ_SOURCE_PROBE_AUTH_FAILED' }, data: null },
  ])
  assert.equal(probeCode.evidence.steps[0].errorCode, 'READ_SOURCE_PROBE_AUTH_FAILED')
}

function testEvaluateStructuralMisuseFailsClosed() {
  const plan = plannedPlan()
  for (const bad of [null, undefined, 'x', { length: 3 }]) {
    const outcome = evaluateCompositionOutcome(plan, bad)
    assert.equal(outcome.evidence.ok, false)
    assert.equal(outcome.evidence.errorCode, 'READ_SOURCE_COMPOSITION_PLAN_INVALID')
    assert.equal(outcome.data, null)
  }
  // More hop outcomes than plan steps = executor bug, never a success.
  const over = evaluateCompositionOutcome(plan, [
    hopOutcome('exactly_one', 'internal_id', 'a'),
    hopOutcome('exactly_one', 'bom_number', 'b'),
    hopOutcome('exactly_one', 'bom_number', 'c'),
  ])
  assert.equal(over.evidence.errorCode, 'READ_SOURCE_COMPOSITION_PLAN_INVALID')
  // A malformed plan fails closed too.
  const badPlan = evaluateCompositionOutcome({ stepCount: 2, steps: [{}], handoffs: [] }, [])
  assert.equal(badPlan.evidence.errorCode, 'READ_SOURCE_COMPOSITION_PLAN_INVALID')

  // P1 red test: a ZERO-STEP shaped plan must fail closed (PLAN_INVALID), never read hopOutcomes[-1]
  // and crash. Same for derive, and for shapes outside the C-R1 step bounds / handoff arity.
  const zeroStep = { stepCount: 0, steps: [], handoffs: [] }
  const zeroEval = evaluateCompositionOutcome(zeroStep, [])
  assert.equal(zeroEval.evidence.ok, false)
  assert.equal(zeroEval.evidence.errorCode, 'READ_SOURCE_COMPOSITION_PLAN_INVALID')
  assert.equal(zeroEval.data, null)
  assert.equal(
    deriveCompositionStepInput(zeroStep, 1, { resolver: { target: 'internal_id', value: 'x' } }).errorCode,
    'READ_SOURCE_COMPOSITION_PLAN_INVALID',
  )
  const oneStep = { stepCount: 1, steps: [{ ordinal: 0 }], handoffs: [] }
  assert.equal(evaluateCompositionOutcome(oneStep, []).evidence.errorCode, 'READ_SOURCE_COMPOSITION_PLAN_INVALID')
  const wrongHandoffArity = { stepCount: 2, steps: [{ ordinal: 0 }, { ordinal: 1 }], handoffs: [] }
  assert.equal(evaluateCompositionOutcome(wrongHandoffArity, []).evidence.errorCode, 'READ_SOURCE_COMPOSITION_PLAN_INVALID')
}

// ── vector key discipline (lock 5) ─────────────────────────────────────────────────────────────────
function testStepVectorKeyDiscipline() {
  const plan = plannedPlan()
  const outcomes = [
    evaluateCompositionOutcome(plan, [
      hopOutcome('exactly_one', 'internal_id', 'v1'),
      hopOutcome('field_equals', 'bom_number', 'v2'),
    ]),
    evaluateCompositionOutcome(plan, [failedHopOutcome('exactly_one', 'READ_SOURCE_RESOLVER_NOT_FOUND')]),
  ]
  const allowed = new Set(['step', 'ok', 'rule', 'errorCode'])
  for (const outcome of outcomes) {
    for (const entry of outcome.evidence.steps) {
      for (const key of Object.keys(entry)) {
        assert.ok(allowed.has(key), `step vector key ${key} not allowlisted`)
      }
    }
    assert.deepEqual(
      Object.keys(outcome.evidence).sort(),
      outcome.evidence.ok ? ['failedStep', 'ok', 'steps'] : ['errorCode', 'failedStep', 'ok', 'steps'],
    )
  }
}

// ── exported vocabulary ────────────────────────────────────────────────────────────────────────────
function testExportedVocabulary() {
  assert.equal(READ_SOURCE_COMPOSITION_PLAN_ERROR_CODES.length, 8)
  assert.ok(Object.isFrozen(READ_SOURCE_COMPOSITION_PLAN_ERROR_CODES))
  for (const code of READ_SOURCE_COMPOSITION_PLAN_ERROR_CODES) {
    assert.match(code, /^READ_SOURCE_COMPOSITION_[A-Z_]+$/)
  }
  assert.equal(__internals.isResolverData({ resolver: { target: 't', value: 'v' } }), true)
  assert.equal(__internals.isResolverData({ resolver: { target: 't', value: '' } }), false)
  // isResolverData is scalar-gated (chain-usable), snapshot distinguishes resolved-non-scalar.
  assert.equal(__internals.isResolverData({ resolver: { target: 't', value: true } }), false)
  assert.deepEqual(__internals.snapshotResolverData({ resolver: { target: 't', value: true } }), { target: 't', value: true, scalar: false })
  assert.deepEqual(__internals.snapshotResolverData({ resolver: { target: 't', value: 9 } }), { target: 't', value: 9, scalar: true })
  assert.equal(__internals.snapshotResolverData({ resolver: { target: 't', value: null } }), null)
  assert.equal(__internals.safeStepErrorCode('not a token!'), 'READ_SOURCE_COMPOSITION_STEP_FAILED')
  // Registered-set discipline, not token shape: registered passes, token-shaped-unregistered collapses.
  assert.equal(__internals.safeStepErrorCode('READ_SOURCE_RESOLVER_NOT_FOUND'), 'READ_SOURCE_COMPOSITION_STEP_FAILED')
  assert.equal(__internals.safeStepErrorCode('READ_SOURCE_RESOLVER_NO_MATCH'), 'READ_SOURCE_RESOLVER_NO_MATCH')
  assert.equal(__internals.safeStepErrorCode('READ_SOURCE_PROBE_TIMEOUT'), 'READ_SOURCE_PROBE_TIMEOUT')
  assert.equal(__internals.safeStepErrorCode('MAT_001_SECRET'), 'READ_SOURCE_COMPOSITION_STEP_FAILED')
}

testPurity()
testPlanValid()
testPlanRejectsWriteShapedAndUnapproved()
testDeriveHappyPath()
testDeriveFailClosed()
testAccessorBearingHopData()
testChainDataStripsExtraFields()
testNonScalarResolvedHopGetsDedicatedCode()
testPostFailureOutcomesAreClamped()
testEvaluateSuccess()
testEvaluateHopFailureAborts()
testEvaluateIncompleteChainFailsClosed()
testEvaluateMalformedSuccessDataFailsClosed()
testEvaluateSanitizesForeignTokens()
testEvaluateStructuralMisuseFailsClosed()
testStepVectorKeyDiscipline()
testExportedVocabulary()

console.log('read-source-composition-planner.test.cjs OK')
