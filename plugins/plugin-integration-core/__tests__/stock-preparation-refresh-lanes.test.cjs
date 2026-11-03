'use strict'

// Batch-refresh step 4, PR-3a — the LANE HELPERS as pure functions (lib/stock-preparation-refresh-lanes.cjs;
// plan-final §2.4). No lib lane, no route: each helper on hand-built consult answers / plans.
//
//   RL-01 the persisted-hold pick: exactly the 13 PHK keys, the STORED fingerprint and body verbatim,
//         continuationRoots from the named continuation of ANY status, never the row id / scope / timestamps.
//   RL-02 the planner input: exactly 11 keys (O-16 + persistedHolds + step 5's changePlan + review fix N3's expectedContent), never a spread consult; the normalizer takes it.
//   RL-03 the straddle mapping maps ONLY the two straddle shapes (P3-G9).
//   RL-04 the verdict, the completeness predicate (TD-24), the binding (sorted, non-ended), the plan digest.
//   RL-05 the refusals from ROWS (O-22: own lease vs another / failed), runbook-only (O-15), suspension, binding.
//   RL-06 the finish-status mapping (TD-9) and the large-lane reason order (TD-17).
//   RL-07 the source identity: the moved scope digest is byte-identical to the old route digest; the read-plan
//         digest is canonical; the spec slot predicate; the binding disagreement (R-1); the handle is frozen and
//         lazy (an unwired service refuses at consult time, not at build time).
//   RL-08 the settlement digest refuses rows without their record reference (O-10 / P3-T2).
// Synthetic values only.

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const lanes = require(path.join(LIB, 'stock-preparation-refresh-lanes.cjs'))
const pairing = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs'))
const { EXISTING_ROW_RECORD_REF } = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))

const tests = []
const test = (name, fn) => tests.push([name, fn])

const SCOPE = Object.freeze({ tenantId: 'tenant_rl', projectNo: 'PRJ-RL-1', sheetId: 'sheet_rl', writeScopeKey: 'spw2:rl' })

function holdRow(overrides = {}) {
  return {
    id: 'hold_rl_1', tenantId: SCOPE.tenantId, sheetId: SCOPE.sheetId, projectNo: SCOPE.projectNo,
    kind: 'relationship_reconfirm', fingerprint: 'f'.repeat(64), status: 'open', confirmable: false, notConfirmableReason: 'specialist_repair',
    shapeToken: null, runbookOnly: true, continuationId: 'cont_rl_1', subject: { continuationId: 'cont_rl_1' }, detail: { verdict: 'source_scope_changed', pairs: null },
    evidenceFingerprint: 'e1', comparisonFingerprint: 'c1', pairingFingerprint: 'p1', openedAt: '2026-10-26T00:00:00.000Z', openedLane: 'small_preview',
    openedGenerationToken: 'tok', lastSeenAt: '2026-10-26T00:00:00.000Z', resolvedAt: null, resolvedBy: null, resolution: null,
    ...overrides,
  }
}

function consultWith(overrides = {}) {
  return Object.freeze({
    ok: true,
    scope: SCOPE,
    governed: true,
    pilot: { enabled: false, enabledAt: null, enabledBy: null, readinessVersion: null },
    registry: null,
    continuations: [],
    members: [],
    holds: [],
    state: null,
    executions: [],
    changePlans: [],
    lock: { state: { leaseHeld: false, leaseLive: false }, generation: { generationToken: 'tok_rl', generation: 3, fencingEpoch: 2, leaseId: null } },
    decisionVersionObserved: 0,
    ...overrides,
  })
}

test('RL-01 pickPersistedHold copies exactly the 13 PHK keys (stored fingerprint and body verbatim), takes continuationRoots from the named continuation of ANY status, and never the row id, scope or timestamps', () => {
  const ended = { id: 'cont_rl_1', status: 'ended', oldRootKey: '{"old":1}', newRootKey: '{"new":1}' }
  const picked = lanes.pickPersistedHold(holdRow(), [ended])
  assert.deepEqual(Object.keys(picked).sort(), pairing.PERSISTED_HOLD_KEYS.slice().sort())
  assert.equal(picked.fingerprint, 'f'.repeat(64))
  assert.deepEqual(picked.continuationRoots, { oldRootKey: '{"old":1}', newRootKey: '{"new":1}' })
  for (const key of ['id', 'tenantId', 'sheetId', 'projectNo', 'status', 'openedAt', 'lastSeenAt', 'openedGenerationToken']) assert.equal(key in picked, false, key)
  assert.equal(lanes.pickPersistedHold(holdRow({ continuationId: null, runbookOnly: false }), [ended]).continuationRoots, null)
  // The pure core accepts exactly that entry.
  const normalized = pairing.__internals.normalizePersistedHolds([picked])
  assert.equal(normalized[0].fingerprint, picked.fingerprint)
})

test('RL-02 continuationInputFor builds EXACTLY the 11-key planner input (never a spread consult), and the pure core normalizes it', () => {
  const refresh = { consult: consultWith({ holds: [holdRow()], continuations: [] }), governed: true }
  const action = { actionId: 'plm.stock-preparation.pull-bom.v1', source: { externalSystemId: 'plm_rl', readPlan: { part: { specField: 'Spec' } } }, target: { sheetId: SCOPE.sheetId } }
  const input = lanes.continuationInputFor(refresh, { action, expansion: { demandEvidence: { observations: [] } } })
  assert.deepEqual(Object.keys(input).sort(), ['changePlan', 'continuations', 'demandEvidence', 'expectedContent', 'members', 'persistedHolds', 'pilot', 'projectNo', 'sourceIdentity', 'specSlotDeclared', 'storeState'])
  // Step 5 PR-8: no confirmed change plan in the consult => `changePlan: null` (the key is always present).
  assert.equal(input.changePlan, null)
  // Review fix N3: the consult's expected content is handed over as is ([] when the consult carries none).
  assert.deepEqual(input.expectedContent, [])
  const expected = [{ recordId: 'rec_rl_1', key: '{"k":1}', fields: { material: { after: 'M-RL', afterCanonical: 'M-RL' } } }]
  assert.equal(lanes.continuationInputFor({ consult: consultWith({ expectedContent: expected }), governed: true }, { action, expansion: null }).expectedContent, expected)
  assert.equal(pairing.normalizeContinuationInput({ ...input, expectedContent: expected }).expectedContent[0].fields.material.afterCanonical, 'M-RL')
  assert.equal(input.pilot, false)
  assert.equal(input.specSlotDeclared, true)
  assert.equal(input.sourceIdentity.sourceScopeDigest, lanes.stockPreparationSourceScopeDigest({ tenantId: SCOPE.tenantId, actionId: action.actionId, externalSystemId: 'plm_rl' }))
  assert.equal(pairing.normalizeContinuationInput(input).persistedHolds.length, 1)
  assert.throws(() => pairing.normalizeContinuationInput({ ...refresh.consult, ...input }), (error) => error.code === pairing.CONTINUATION_ERROR_CODES.INPUT_INVALID, 'a spread consult is refused 500')
})

test('RL-03 mapContinuationStraddle maps ONLY a projection inconsistency and a memberCount input defect to 409 STATE_MOVED projection_inconsistent; anything else passes through', () => {
  const thrower = (error) => () => { throw error }
  const projection = new pairing.StockPreparationContinuationError(500, pairing.CONTINUATION_ERROR_CODES.PROJECTION_INCONSISTENT, 'x')
  const memberCount = new pairing.StockPreparationContinuationError(500, pairing.CONTINUATION_ERROR_CODES.INPUT_INVALID, 'x', { field: 'continuation.continuations.memberCount' })
  const otherInput = new pairing.StockPreparationContinuationError(500, pairing.CONTINUATION_ERROR_CODES.INPUT_INVALID, 'x', { field: 'continuation.projectNo' })
  for (const error of [projection, memberCount]) {
    assert.throws(() => lanes.mapContinuationStraddle(thrower(error))(), (mapped) => mapped.status === 409 && mapped.code === 'STOCK_PREP_PULL_STATE_MOVED' && mapped.details.reason === 'projection_inconsistent' && mapped.details.partial === false)
  }
  assert.throws(() => lanes.mapContinuationStraddle(thrower(otherInput))(), (error) => error === otherInput)
  assert.equal(lanes.mapContinuationStraddle((value) => value + 1)(1), 2)
})

test('RL-04 the verdict (values-free), the completeness predicate, the binding (non-ended, sorted by id) and the plan digest (order-sensitive, value-hashing)', () => {
  assert.deepEqual(lanes.governanceVerdictOf({ consult: consultWith(), governed: true }), { consulted: true, verdict: 'projected', generationToken: 'tok_rl' })
  assert.deepEqual(lanes.governanceVerdictOf({ consult: consultWith({ lock: { state: {}, generation: { generationToken: null } } }), governed: false }), { consulted: true, verdict: 'not_governed', generationToken: null })
  const ok = { status: 'expanded', rowErrors: [], summary: {} }
  assert.equal(lanes.isCompleteComputation(ok, { hasGlobalErrors: false }), true)
  assert.equal(lanes.isCompleteComputation({ ...ok, status: 'not_found' }, { hasGlobalErrors: false }), false)
  assert.equal(lanes.isCompleteComputation(ok, { hasGlobalErrors: true }), false)
  assert.equal(lanes.isCompleteComputation({ ...ok, rowErrors: [{ type: 'missing_component' }] }, { hasGlobalErrors: false }), false)
  assert.equal(lanes.isCompleteComputation({ ...ok, summary: { rowErrorsTruncated: true } }, { hasGlobalErrors: false }), false)
  const binding = lanes.refreshBindingOf(consultWith({ continuations: [{ id: 'c_b', status: 'active', revision: 2 }, { id: 'c_a', status: 'needs_reconfirmation', revision: 1 }, { id: 'c_0', status: 'ended', revision: 5 }] }), 'h'.repeat(64))
  assert.deepEqual(binding, { continuations: [{ id: 'c_a', revision: 1 }, { id: 'c_b', revision: 2 }], changePlanId: null, holdSetFingerprint: 'h'.repeat(64) })
  const plan = { decisions: [{ idempotencyKey: 'k1', decision: 'add' }, { idempotencyKey: 'k2', decision: 'update', changedFields: ['a'] }] }
  const digest = lanes.planDigestOf(plan)
  assert.ok(/^[0-9a-f]{64}$/.test(digest))
  assert.equal(lanes.planDigestOf(JSON.parse(JSON.stringify(plan))), digest)
  assert.notEqual(lanes.planDigestOf({ decisions: plan.decisions.slice().reverse() }), digest)
  assert.notEqual(lanes.planDigestOf({ decisions: [plan.decisions[0], { ...plan.decisions[1], changedFields: ['b'] }] }), digest)
})

test('RL-05 the refusals: recovery from ROWS (a failed execution, or a running one of ANOTHER lease; never this lease\'s own), a runbook-only hold (carry), a suspended plan or outcome, a moved / absent / unexpected binding', () => {
  const guard = { hostWriteFence: () => ({ leaseId: 'lease_own' }) }
  const refusesRecovery = (executions) => assert.throws(() => lanes.assertNoUnfinishedExecution(consultWith({ executions }), guard), (error) => error.status === 409 && error.code === 'STOCK_PREP_REFRESH_RECOVERY_PENDING' && error.details.state === 'failed_pending_recovery' && error.details.partial === false)
  for (const status of ['partial', 'failed', 'aborted']) refusesRecovery([{ id: 'e', status, leaseId: 'lease_own' }])
  refusesRecovery([{ id: 'e', status: 'running', leaseId: 'lease_other' }])
  lanes.assertNoUnfinishedExecution(consultWith({ executions: [{ id: 'e', status: 'running', leaseId: 'lease_own' }, { id: 'e2', status: 'succeeded' }, { id: 'e3', status: 'verified_closed' }] }), guard)
  assert.throws(() => lanes.assertNoUnfinishedExecution(consultWith({ executions: [{ id: 'e', status: 'running', leaseId: 'lease_own' }] }), null), (error) => error.code === 'STOCK_PREP_REFRESH_RECOVERY_PENDING', 'no guard: every running row is foreign')
  assert.throws(() => lanes.assertNoRunbookOnlyHold(consultWith({ holds: [holdRow(), holdRow({ id: 'h2', runbookOnly: false })] })), (error) => error.code === 'STOCK_PREP_PULL_SUSPENDED' && error.details.reason === 'runbook_only_hold' && error.details.holdCount === 1)
  lanes.assertNoRunbookOnlyHold(consultWith({ holds: [holdRow({ runbookOnly: false })] }))
  assert.throws(() => lanes.assertPullNotSuspended({ plan: { suspended: true, holds: [{ kind: 'content_change' }] } }, null), (error) => error.code === 'STOCK_PREP_PULL_SUSPENDED' && error.details.holdCount === 1 && error.details.kinds.content_change === 1)
  assert.throws(() => lanes.assertPullNotSuspended({ plan: { suspended: false, holds: [] } }, { suspended: true, result: { holds: { open: 2 } } }), (error) => error.details.holdCount === 2)
  lanes.assertPullNotSuspended({ plan: { suspended: false, holds: [] } }, { suspended: false, result: { holds: { open: 0 } } })
  const outcome = { binding: { continuations: [{ id: 'c1', revision: 1 }], changePlanId: null, holdSetFingerprint: null } }
  lanes.assertRefreshBindingCurrent({ refreshBinding: { holdSetFingerprint: null, changePlanId: null, continuations: [{ revision: 1, id: 'c1' }] } }, outcome)
  assert.throws(() => lanes.assertRefreshBindingCurrent({}, outcome), (error) => error.details.reason === 'binding_absent')
  assert.throws(() => lanes.assertRefreshBindingCurrent({ refreshBinding: { ...outcome.binding, continuations: [{ id: 'c1', revision: 2 }] } }, outcome), (error) => error.details.reason === 'binding_moved')
  assert.throws(() => lanes.assertTokenCarriesNoRefreshBinding({ refreshBinding: outcome.binding }), (error) => error.details.reason === 'unexpected_binding')
  lanes.assertTokenCarriesNoRefreshBinding({})
})

test('RL-06 the finish-status mapping (TD-9) and the large-lane refusal reason order (TD-17)', () => {
  const map = (status, counts = {}) => lanes.executionFinishStatus({ status, counts })
  assert.equal(map('succeeded'), 'succeeded')
  assert.equal(map('held'), 'succeeded')
  assert.equal(map('partial', { failed: 0, held: 2 }), 'succeeded')
  assert.equal(map('partial', { failed: 1 }), 'partial')
  assert.equal(map('failed'), 'failed')
  assert.equal(map('aborted'), 'aborted')
  assert.equal(map('weird'), 'failed')
  assert.equal(lanes.executionFinishStatus(null), 'failed')
  const reason = (overrides) => lanes.largeLaneRefusalReason(consultWith(overrides))
  assert.equal(reason({ pilot: { enabled: true }, continuations: [{}], holds: [{}] }), 'pilot')
  assert.equal(reason({ continuations: [{}], holds: [{}] }), 'continuation')
  assert.equal(reason({ holds: [{}], executions: [{}] }), 'hold')
  assert.equal(reason({ executions: [{}] }), 'execution')
  assert.equal(reason({ changePlans: [{}] }), 'review')
  assert.equal(reason({ state: { id: 's' } }), 'refresh_state')
  assert.throws(() => lanes.largeLaneVerdictOf(consultWith({ holds: [{}] }), 'large_apply_chunk'), (error) => error.status === 409 && error.code === 'STOCK_PREP_REFRESH_LARGE_LANE_REFUSED' && error.details.reason === 'hold' && error.details.lane === 'large_apply_chunk')
  assert.deepEqual(lanes.largeLaneVerdictOf(consultWith({ governed: false }), 'large_apply_chunk'), { consulted: true, verdict: 'not_governed', generationToken: 'tok_rl' })
})

test('RL-07 the source identity: the moved scope digest is byte-identical to the old route digest; the read-plan digest is canonical (key order free); the spec slot; the binding disagreement (R-1); the handle is frozen and LAZY', async () => {
  const oldRouteDigest = ({ tenantId, actionId, externalSystemId }) => crypto.createHash('sha256').update(JSON.stringify(['stock-preparation/source-scope/v1', tenantId, actionId, externalSystemId])).digest('hex').slice(0, 32)
  for (const input of [{ tenantId: 't1', actionId: 'a1', externalSystemId: 'x1' }, { tenantId: 'tenant_x', actionId: 'plm.stock-preparation.pull-bom.v1', externalSystemId: 'es_9' }]) {
    assert.equal(lanes.stockPreparationSourceScopeDigest(input), oldRouteDigest(input))
  }
  // The literal the route's own digest produced on main (9bcaf4b81) for this fixed input.
  assert.equal(lanes.stockPreparationSourceScopeDigest({ tenantId: 't1', actionId: 'a1', externalSystemId: 'x1' }), 'ede0b7871ca8ae42b3a31a69f286995f')
  assert.equal(lanes.stockPreparationReadPlanDigest({ a: 1, b: { c: 2, d: 3 } }), lanes.stockPreparationReadPlanDigest({ b: { d: 3, c: 2 }, a: 1 }))
  assert.notEqual(lanes.stockPreparationReadPlanDigest({ a: 1 }), lanes.stockPreparationReadPlanDigest({ a: 2 }))
  assert.equal(lanes.specSlotDeclaredFor({ source: { readPlan: { part: { specField: 'Spec' } } } }), true)
  assert.equal(lanes.specSlotDeclaredFor({ source: { readPlan: { part: { specField: ' ' } } } }), false)
  assert.equal(lanes.specSlotDeclaredFor({ source: {} }), false)
  const store = (bindings, complete = true) => ({ listForAction: async () => ({ bindings, complete }) })
  assert.equal(await lanes.sourceBindingDisagreementOf({ sourceBindingStore: null, tenantId: 't', actionId: 'a', externalSystemId: 'x' }), null)
  assert.equal(await lanes.sourceBindingDisagreementOf({ sourceBindingStore: {}, tenantId: 't', actionId: 'a', externalSystemId: 'x' }), 'bindings_unverifiable')
  assert.equal(await lanes.sourceBindingDisagreementOf({ sourceBindingStore: store([{ externalSystemId: 'x' }], false), tenantId: 't', actionId: 'a', externalSystemId: 'x' }), 'bindings_unverifiable')
  assert.equal(await lanes.sourceBindingDisagreementOf({ sourceBindingStore: store([{ externalSystemId: 'x' }, { externalSystemId: 'y' }]), tenantId: 't', actionId: 'a', externalSystemId: 'x' }), 'bindings_disagree')
  assert.equal(await lanes.sourceBindingDisagreementOf({ sourceBindingStore: store([{ externalSystemId: 'x' }, { externalSystemId: 'x' }]), tenantId: 't', actionId: 'a', externalSystemId: 'x' }), null)
  const listingFault = Object.assign(new Error('down'), { code: 'XX000' })
  await assert.rejects(lanes.sourceBindingDisagreementOf({ sourceBindingStore: { listForAction: async () => { throw listingFault } }, tenantId: 't', actionId: 'a', externalSystemId: 'x' }), (error) => error === listingFault, 'a listing throw propagates unchanged (the mvp-persist guard\'s behaviour)')
  let resolved = 0
  const handle = lanes.createRefreshGovernanceHandle({
    tenantId: 'tenant_rl',
    resolveServices: () => { resolved += 1; throw Object.assign(new Error('unwired'), { status: 501, code: 'STOCK_PREP_REFRESH_STORE_UNAVAILABLE', details: { reason: 'governance_service' } }) },
    projectId: 'tenant_rl:integration-core',
    defaultObjectId: 'stockPreparationMain',
  })
  assert.ok(Object.isFrozen(handle) && Object.isFrozen(handle.store))
  assert.equal(resolved, 0, 'building the handle resolves nothing')
  await assert.rejects(handle.consult({ projectNo: 'P', sheetId: 's' }), (error) => error.status === 501)
  assert.equal(handle.evidenceOptions, true)
  assert.ok(lanes.__internals.isRefreshHandle(handle))
  assert.equal(lanes.__internals.isRefreshHandle({ ...handle }), false, 'an unfrozen copy is not the route\'s handle')
})

test('RL-08 the settlement digest is computed only over rows carrying their record reference (O-10): JSON-cloned rows refuse 500 SHEET_DIGEST_RECORD_REF_MISSING', () => {
  const row = { idempotencyKey: 'k1', componentSourceId: 'C', active: true }
  row[EXISTING_ROW_RECORD_REF] = { id: 'rec_1', version: 1 }
  const dryRun = { plan: { suspended: false, holds: [], counts: { add: 0, update: 0, inactive: 0, manual_confirm: 0 } }, existingRows: [row], sourceContentRevision: 'src', refresh: { installedFieldProperties: undefined } }
  const settled = lanes.settlementForComputation({ consult: consultWith(), dryRun, template: undefined })
  assert.ok(/^[0-9a-f]{64}$/.test(settled.sheetMachineDigest))
  assert.equal(settled.executionId, null)
  assert.equal(settled.generationToken, 'tok_rl')
  assert.throws(() => lanes.settlementForComputation({ consult: consultWith(), dryRun: { ...dryRun, existingRows: JSON.parse(JSON.stringify([row])) }, template: undefined }), (error) => error.code === 'STOCK_PREP_SHEET_DIGEST_RECORD_REF_MISSING')
  assert.equal(lanes.settlementForComputation({ consult: consultWith(), dryRun: { ...dryRun, plan: { ...dryRun.plan, counts: { add: 1 } } }, template: undefined }), null, 'pending decisions never settle')
  assert.equal(lanes.settlementForComputation({ consult: consultWith({ executions: [{ id: 'e', status: 'failed', startedAt: '2026-10-26T00:00:00.000Z' }] }), dryRun, template: undefined }), null, 'a failed newest execution never settles')
  assert.equal(lanes.settlementForComputation({ consult: consultWith({ executions: [{ id: 'e_new', status: 'succeeded', startedAt: '2026-10-26T00:00:01.000Z' }, { id: 'e_old', status: 'succeeded', startedAt: '2026-10-26T00:00:00.000Z' }] }), dryRun, template: undefined }).executionId, 'e_new', 'names the newest')
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-refresh-lanes.test.cjs', tests)
