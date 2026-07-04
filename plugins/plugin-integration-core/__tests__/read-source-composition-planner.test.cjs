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
  // Non-scalar values are invalid, not coerced.
  for (const value of [true, {}, ['12345'], Number.NaN]) {
    const derived = deriveCompositionStepInput(plan, 1, { resolver: { target: 'internal_id', value } })
    assert.equal(derived.ok, false)
    assert.ok(
      derived.errorCode === 'READ_SOURCE_COMPOSITION_HANDOFF_VALUE_INVALID' ||
        derived.errorCode === 'READ_SOURCE_COMPOSITION_HANDOFF_VALUE_MISSING',
    )
  }
  // A malformed plan fails closed rather than deriving anything.
  const malformed = deriveCompositionStepInput({ steps: [] }, 1, { resolver: { target: 'internal_id', value: 'x' } })
  assert.equal(malformed.errorCode, 'READ_SOURCE_COMPOSITION_PLAN_INVALID')
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
  assert.equal(READ_SOURCE_COMPOSITION_PLAN_ERROR_CODES.length, 7)
  assert.ok(Object.isFrozen(READ_SOURCE_COMPOSITION_PLAN_ERROR_CODES))
  for (const code of READ_SOURCE_COMPOSITION_PLAN_ERROR_CODES) {
    assert.match(code, /^READ_SOURCE_COMPOSITION_[A-Z_]+$/)
  }
  assert.equal(__internals.isResolverData({ resolver: { target: 't', value: 'v' } }), true)
  assert.equal(__internals.isResolverData({ resolver: { target: 't', value: '' } }), false)
  assert.equal(__internals.safeStepErrorCode('not a token!'), 'READ_SOURCE_COMPOSITION_STEP_FAILED')
}

testPurity()
testPlanValid()
testPlanRejectsWriteShapedAndUnapproved()
testDeriveHappyPath()
testDeriveFailClosed()
testEvaluateSuccess()
testEvaluateHopFailureAborts()
testEvaluateIncompleteChainFailsClosed()
testEvaluateMalformedSuccessDataFailsClosed()
testEvaluateSanitizesForeignTokens()
testEvaluateStructuralMisuseFailsClosed()
testStepVectorKeyDiscipline()
testExportedVocabulary()

console.log('read-source-composition-planner.test.cjs OK')
