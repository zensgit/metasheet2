'use strict'

// W4 carry-policy WIRING, plan side (execution-plan W4a/W4b; adjudication Layer 3
// docs/development/platform-overall-design/stock-prep-change-adjudication-20260901.md §3.1).
//
// planCarry (stock-preparation-carry-policy.cjs:399) had ZERO production callers: a re-keyed
// component's human work was stranded on the inactive predecessor row while the fresh ADD was
// created human-free, with nothing linking the two. This suite locks the wiring that closes it,
// invariant by invariant:
//
//   (i)   NO carryPolicy input  => plan output BYTE-IDENTICAL to the pre-wiring planner
//         (deep-equal against a frozen golden captured from the pre-wiring code).
//   (ii)  opt-in + re-keyed row with an inactive human-carrying predecessor => the ADD still
//         happens (human-free — the assertNoHumanFields wall untouched) AND a
//         carry_reattach_requires_confirm manual_confirm hold rides beside it carrying the
//         CARRY_VIA_CONFIRM proposal (writeVia k2_confirm, requiresConfirm, field NAMES only).
//   (iii) the human wall still throws on any smuggled human field, and a raw carry_via_confirm
//         decision dropped into the apply path is refused (unsupported_decision) — carry NEVER
//         applies through the plan writer.
//   (vi)  ambiguous multi-predecessor (1->N) => carry_ambiguous_component_source MANUAL_CONFIRM
//         hold, never a guess, never a proposal.
//
// Plus the config opt-in home (piece 1): carryPolicy is validated deploy-time action config
// (closed keys/vocabulary; absent = byte-identical config) and both plan call sites thread it
// (table-actions computeDryRun via action.carryPolicy; large-bom-jobs via job.actionSnapshot).

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const {
  DECISIONS,
  planStockPreparationConflicts,
  summarizeConflictPlanForEvidence,
  StockPreparationConflictPlannerError,
} = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))
const {
  CARRY_DECISIONS,
  CARRY_WRITE_VIA,
  StockPreparationCarryPolicyError,
} = require(path.join(LIB, 'stock-preparation-carry-policy.cjs'))
const {
  normalizeStockPreparationActionConfig,
  prepareStockPreparationConfirmationDecisions,
  StockPreparationTableActionError,
} = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const {
  applyStockPreparationPlan,
  StockPreparationApplyWriterError,
} = require(path.join(LIB, 'stock-preparation-apply-writer.cjs'))
const {
  HUMAN_PRESERVED_FIELD_IDS,
} = require(path.join(LIB, 'stock-preparation-templates.cjs'))

const HUMAN_FIELDS = HUMAN_PRESERVED_FIELD_IDS

let passed = 0
let failed = 0
const failures = []

function run(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1
    })
    .catch((error) => {
      failed += 1
      failures.push(name)
      console.error(`FAIL: ${name}`)
      console.error(error && error.stack ? error.stack : error)
    })
}

function keyFor(componentSourceId, pathTokens) {
  return JSON.stringify({
    projectNo: 'P-001',
    componentSourceId,
    parentSourceId: null,
    path: pathTokens,
  })
}

function row(overrides = {}) {
  const componentSourceId = overrides.componentSourceId || 'PART-A'
  const pathTokens = overrides.pathTokens || [componentSourceId]
  return {
    projectNo: 'P-001',
    idempotencyKey: keyFor(componentSourceId, pathTokens),
    componentSourceId,
    parentSourceId: null,
    path: JSON.stringify(pathTokens),
    depth: pathTokens.length - 1,
    componentCode: `${componentSourceId}-CODE`,
    componentName: `${componentSourceId} Name`,
    material: 'Steel',
    sourceVersion: 'V1',
    rawQuantity: 2,
    totalQuantity: 2,
    active: true,
    ...overrides,
  }
}

function assertNoHumanFieldPresent(payload, message) {
  for (const field of HUMAN_FIELDS) {
    assert.equal(Object.prototype.hasOwnProperty.call(payload, field), false, `${message}: ${field} must not be present`)
  }
}

function holds(plan, conflictType) {
  return plan.decisions.filter((decision) =>
    decision.decision === DECISIONS.MANUAL_CONFIRM
    && decision.conflictSummary
    && decision.conflictSummary.type === conflictType)
}

function adds(plan) {
  return plan.decisions.filter((decision) => decision.decision === DECISIONS.ADD)
}

// ---------------------------------------------------------------------------
// Invariant (i) — the representative fixture and its FROZEN pre-wiring golden.
//
// The golden below was captured by running THIS input through the PRE-WIRING
// planner (origin/main a2080ae8e, before any carry code existed). With no
// carryPolicy input the wired planner must reproduce it byte-for-byte.
// ---------------------------------------------------------------------------
function representativePlanInput() {
  const addRow = row({ componentSourceId: 'PART-ADD' })
  const updateRow = row({ componentSourceId: 'PART-UPD', rawQuantity: 5, totalQuantity: 5 })
  const skipRow = row({ componentSourceId: 'PART-SKIP' })
  const goneExisting = row({ componentSourceId: 'PART-GONE', notes: 'human note survives inactive' })
  const alreadyInactive = row({ componentSourceId: 'PART-OFF', active: false })
  const existingUpdate = { ...row({ componentSourceId: 'PART-UPD' }), rawQuantity: 4, totalQuantity: 4, notes: 'operator note' }
  const existingSkip = { ...row({ componentSourceId: 'PART-SKIP' }), notes: 'keep me' }
  return {
    expandedRows: [addRow, updateRow, skipRow],
    existingRows: [existingUpdate, existingSkip, goneExisting, alreadyInactive],
    runId: 'carry-golden-run',
    plannedAt: '2026-09-01T00:00:00.000Z',
  }
}

const PRE_WIRING_GOLDEN_PATH = path.join(__dirname, 'fixtures', 'stock-preparation-carry-pre-wiring-golden.json')

function baseActionConfig(overrides = {}) {
  return {
    source: { externalSystemId: 'sys_demo' },
    target: { sheetId: 'sheet_main' },
    ...overrides,
  }
}

async function main() {
  // -------------------------------------------------------------------------
  // Piece 1 — config opt-in home (deploy-time action config world).
  // -------------------------------------------------------------------------
  await run('config: absent carryPolicy => key absent from the normalized action (byte-identical config)', () => {
    const action = normalizeStockPreparationActionConfig(baseActionConfig())
    assert.equal(Object.prototype.hasOwnProperty.call(action, 'carryPolicy'), false,
      'an action that never asked for carry must not grow a carryPolicy key')
  })

  await run('config: opt-in carryPolicy is normalized through the carry module (defaults filled, closed vocabulary)', () => {
    const action = normalizeStockPreparationActionConfig(baseActionConfig({ carryPolicy: { carryKey: 'component_source_id' } }))
    assert.deepEqual(action.carryPolicy, { carryKey: 'component_source_id', manualRowReattach: 'propose_confirm' })
  })

  await run('config: carryPolicy validation is fail-closed (unknown key / unknown vocabulary => 422 with the carry reason)', () => {
    for (const bad of [
      { carryKey: 'latest_create_time' },
      { carryKey: 'component_source_id', smuggled: true },
      { manualRowReattach: 'auto_pick' },
      'component_source_id',
    ]) {
      let caught = null
      try {
        normalizeStockPreparationActionConfig(baseActionConfig({ carryPolicy: bad }))
      } catch (error) {
        caught = error
      }
      assert.ok(caught instanceof StockPreparationTableActionError, `expected refusal for ${JSON.stringify(bad)}`)
      assert.equal(caught.status, 422)
      assert.equal(caught.code, 'TABLE_ACTION_CONFIG_INVALID')
      assert.equal(caught.details.field, 'carryPolicy')
      assert.ok(caught.details.carryPolicyReason, 'refusal names the closed carry-policy reason token')
    }
  })

  // -------------------------------------------------------------------------
  // Invariant (i) — no config => byte-identical plan.
  // -------------------------------------------------------------------------
  await run('(i) no carryPolicy input => plan deep-equals the frozen pre-wiring golden', () => {
    const fs = require('node:fs')
    const golden = JSON.parse(fs.readFileSync(PRE_WIRING_GOLDEN_PATH, 'utf8'))
    const plan = planStockPreparationConflicts(representativePlanInput())
    assert.deepEqual(JSON.parse(JSON.stringify(plan)), golden,
      'without a carryPolicy input the plan must be byte-identical to the pre-wiring planner output')
  })

  await run('(i) carryPolicy: null behaves exactly like absent (no carry key anywhere)', () => {
    const withNull = planStockPreparationConflicts({ ...representativePlanInput(), carryPolicy: null })
    const without = planStockPreparationConflicts(representativePlanInput())
    assert.deepEqual(withNull, without)
    assert.equal(Object.prototype.hasOwnProperty.call(withNull.summary, 'carry'), false, 'no carry stanza on a no-config plan')
    assert.equal(withNull.decisions.some((decision) => Object.prototype.hasOwnProperty.call(decision, 'carryProposal')), false,
      'no carry proposal on a no-config plan')
  })

  // -------------------------------------------------------------------------
  // Invariant (ii) — the headline: re-key no longer strands human work.
  // -------------------------------------------------------------------------
  await run('(ii) opt-in + re-keyed row with inactive human-carrying predecessor => ADD stays human-free AND carries a CARRY_VIA_CONFIRM proposal hold', () => {
    const newAdd = row({ componentSourceId: 'PART-X', pathTokens: ['ROOT', 'PART-X'] })
    const predecessor = row({
      componentSourceId: 'PART-X',
      pathTokens: ['OLD-ROOT', 'PART-X'],
      notes: 'ordered 2026-08-01',
      procurementReply: 'supplier confirmed',
    })
    const plan = planStockPreparationConflicts({
      expandedRows: [newAdd],
      existingRows: [predecessor],
      runId: 'run-carry',
      plannedAt: '2026-09-01T00:00:00.000Z',
      carryPolicy: { carryKey: 'component_source_id' },
    })

    // The ADD still happens and its record is still human-free — the wall is untouched.
    const addDecisions = adds(plan)
    assert.equal(addDecisions.length, 1)
    assertNoHumanFieldPresent(addDecisions[0].record, 'auto-written ADD record')

    // The predecessor is still marked inactive exactly as before.
    assert.equal(plan.counts[DECISIONS.INACTIVE], 1)

    // The proposal hold rides beside the ADD.
    const proposalHolds = holds(plan, 'carry_reattach_requires_confirm')
    assert.equal(proposalHolds.length, 1, 'a carry_reattach_requires_confirm hold must be emitted')
    const hold = proposalHolds[0]
    assert.equal(hold.idempotencyKey, newAdd.idempotencyKey)
    assert.equal(hold.source, 'carry_policy')
    const proposal = hold.carryProposal
    assert.ok(proposal, 'the hold carries the CARRY_VIA_CONFIRM proposal')
    assert.equal(proposal.decision, CARRY_DECISIONS.CARRY_VIA_CONFIRM)
    assert.equal(proposal.writeVia, CARRY_WRITE_VIA)
    assert.equal(proposal.requiresConfirm, true)
    assert.equal(proposal.idempotencyKey, newAdd.idempotencyKey)
    assert.equal(proposal.sourceIdempotencyKey, predecessor.idempotencyKey)
    assert.deepEqual(proposal.carryFields.slice().sort(), ['notes', 'procurementReply'])
    // Field NAMES only — never a human-field VALUE on the proposal.
    assert.equal(JSON.stringify(proposal).includes('ordered 2026-08-01'), false)
    assert.equal(JSON.stringify(proposal).includes('supplier confirmed'), false)
    assertNoHumanFieldPresent(proposal, 'carry proposal')

    // The hold counts as manual_confirm: the plan is honestly "needs a human look".
    assert.equal(plan.valid, false)
    assert.equal(plan.counts[DECISIONS.MANUAL_CONFIRM], 1)

    // Values-free summary stanza, present only under opt-in.
    assert.ok(plan.summary.carry, 'summary carries the carry stanza under opt-in')
    assert.deepEqual(plan.summary.carry.carryPolicy, { carryKey: 'component_source_id', manualRowReattach: 'propose_confirm' })
    assert.equal(plan.summary.carry.counts.carryViaConfirm, 1)
    const evidence = summarizeConflictPlanForEvidence(plan)
    assert.deepEqual(evidence.carry, JSON.parse(JSON.stringify(plan.summary.carry)))
  })

  await run('(ii-b) predecessor being marked inactive THIS run (not yet inactive in storage) is a carry source too', () => {
    const newAdd = row({ componentSourceId: 'PART-Y', pathTokens: ['NEW', 'PART-Y'] })
    const predecessor = row({
      componentSourceId: 'PART-Y',
      pathTokens: ['OLD', 'PART-Y'],
      active: true, // still active in storage; THIS plan's sweep marks it inactive
      warehouseConfirmation: 'shelf B-12',
    })
    const plan = planStockPreparationConflicts({
      expandedRows: [newAdd],
      existingRows: [predecessor],
      carryPolicy: { carryKey: 'component_source_id' },
    })
    assert.equal(plan.counts[DECISIONS.INACTIVE], 1, 'the predecessor is swept inactive in the same plan')
    const proposalHolds = holds(plan, 'carry_reattach_requires_confirm')
    assert.equal(proposalHolds.length, 1)
    assert.deepEqual(proposalHolds[0].carryProposal.carryFields, ['warehouseConfirmation'])
  })

  await run('no_human_context: single inactive predecessor with NO human values => plain ADD, no hold, counted no_carry', () => {
    const newAdd = row({ componentSourceId: 'PART-Z', pathTokens: ['NEW', 'PART-Z'] })
    const predecessor = row({ componentSourceId: 'PART-Z', pathTokens: ['OLD', 'PART-Z'], active: false })
    const plan = planStockPreparationConflicts({
      expandedRows: [newAdd],
      existingRows: [predecessor],
      carryPolicy: { carryKey: 'component_source_id' },
    })
    assert.equal(plan.counts[DECISIONS.MANUAL_CONFIRM], 0)
    assert.equal(plan.valid, true)
    assert.equal(plan.summary.carry.counts.noCarry, 1)
    assert.equal(plan.summary.carry.noCarryByReason.no_human_context, 1)
  })

  await run('default carryKey (idempotency_key) opt-in => every ADD is an explicit NO_CARRY, zero holds, plan decisions unchanged', () => {
    const input = { ...representativePlanInput(), carryPolicy: {} }
    const plan = planStockPreparationConflicts(input)
    const noConfig = planStockPreparationConflicts(representativePlanInput())
    assert.deepEqual(plan.decisions, noConfig.decisions, 'decisions unchanged under the default carry key')
    assert.equal(plan.summary.carry.counts.noCarry, 1)
    assert.equal(plan.summary.carry.noCarryByReason.same_key_update_preserve, 1)
  })

  await run('manualRowReattach none: single match => bare carry_reattach_requires_confirm hold, NO proposal', () => {
    const newAdd = row({ componentSourceId: 'PART-N', pathTokens: ['NEW', 'PART-N'] })
    const predecessor = row({ componentSourceId: 'PART-N', pathTokens: ['OLD', 'PART-N'], active: false, notes: 'n1' })
    const plan = planStockPreparationConflicts({
      expandedRows: [newAdd],
      existingRows: [predecessor],
      carryPolicy: { carryKey: 'component_source_id', manualRowReattach: 'none' },
    })
    const reattachHolds = holds(plan, 'carry_reattach_requires_confirm')
    assert.equal(reattachHolds.length, 1)
    assert.equal(Object.prototype.hasOwnProperty.call(reattachHolds[0], 'carryProposal'), false,
      'reattach none must surface a bare hold, never a proposal')
    assert.equal(reattachHolds[0].source, 'carry_policy')
  })

  // -------------------------------------------------------------------------
  // Invariant (vi) — 1->N ambiguity holds, never guesses.
  // -------------------------------------------------------------------------
  await run('(vi) ambiguous multi-predecessor => carry_ambiguous_component_source MANUAL_CONFIRM hold, never a proposal', () => {
    const newAdd = row({ componentSourceId: 'PART-M', pathTokens: ['NEW', 'PART-M'] })
    const predecessorA = row({ componentSourceId: 'PART-M', pathTokens: ['OLD-A', 'PART-M'], active: false, notes: 'note A' })
    const predecessorB = row({ componentSourceId: 'PART-M', pathTokens: ['OLD-B', 'PART-M'], active: false, notes: 'note B' })
    const plan = planStockPreparationConflicts({
      expandedRows: [newAdd],
      existingRows: [predecessorA, predecessorB],
      carryPolicy: { carryKey: 'component_source_id' },
    })
    const ambiguous = holds(plan, 'carry_ambiguous_component_source')
    assert.equal(ambiguous.length, 1, '1->N must hold under carry_ambiguous_component_source')
    assert.equal(ambiguous[0].conflictSummary.matchCount, 2)
    assert.equal(Object.prototype.hasOwnProperty.call(ambiguous[0], 'carryProposal'), false, 'never a proposal on ambiguity')
    assert.equal(holds(plan, 'carry_reattach_requires_confirm').length, 0)
    // The ADD still rode (human-free) — the ambiguity is about the human context, not the row.
    assert.equal(adds(plan).length, 1)
    assertNoHumanFieldPresent(adds(plan)[0].record, 'ambiguous ADD record')
  })

  await run('cross-key carry with a blank componentSourceId on the ADD row fails closed (never a silent skip)', () => {
    const newAdd = row({ componentSourceId: 'PART-Q', pathTokens: ['NEW', 'PART-Q'] })
    newAdd.componentSourceId = ''
    let caught = null
    try {
      planStockPreparationConflicts({
        expandedRows: [newAdd],
        existingRows: [],
        carryPolicy: { carryKey: 'component_source_id' },
      })
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof StockPreparationCarryPolicyError)
    assert.equal(caught.reason, 'MISSING_COMPONENT_SOURCE_ID')
  })

  // -------------------------------------------------------------------------
  // Invariant (iii) — the wall, mutation-style.
  // -------------------------------------------------------------------------
  await run('(iii) a plan ADD record smuggling a human field is thrown out by the apply-writer wall', async () => {
    const newAdd = row({ componentSourceId: 'PART-W', pathTokens: ['NEW', 'PART-W'] })
    const plan = planStockPreparationConflicts({
      expandedRows: [newAdd],
      existingRows: [],
      runId: 'wall-run',
      plannedAt: '2026-09-01T00:00:00.000Z',
    })
    // Mutation: smuggle a human field into the ADD record, bypassing the executor entirely.
    const smuggled = JSON.parse(JSON.stringify(plan))
    smuggled.decisions[0].record.notes = 'smuggled human value'
    const result = await applyStockPreparationPlan({
      permission: 'write',
      plan: smuggled,
      target: { objectId: 'obj_main', sheetId: 'sheet_main', keyField: 'idempotencyKey' },
      recordsApi: {
        async queryRecords() { return [] },
        async createRecord() { throw new Error('the wall must throw before any write') },
        async patchRecord() { throw new Error('the wall must throw before any write') },
      },
    })
    assert.equal(result.counts.failed, 1, 'the smuggled record must fail')
    assert.equal(result.counts.created, 0, 'nothing may be written')
    assert.ok(result.errors.length >= 1)
    assert.equal(result.errors[0].field, 'notes')
  })

  await run('(iii-b) a raw carry_via_confirm decision in the apply path is refused as unsupported_decision', async () => {
    const newAdd = row({ componentSourceId: 'PART-V', pathTokens: ['NEW', 'PART-V'] })
    const predecessor = row({ componentSourceId: 'PART-V', pathTokens: ['OLD', 'PART-V'], active: false, notes: 'v' })
    const plan = planStockPreparationConflicts({
      expandedRows: [newAdd],
      existingRows: [predecessor],
      carryPolicy: { carryKey: 'component_source_id' },
    })
    const hold = holds(plan, 'carry_reattach_requires_confirm')[0]
    // Mutation: route the raw proposal into the apply path as if it were a plan decision.
    const forged = {
      ...plan,
      decisions: [hold.carryProposal],
      counts: { add: 0, update: 0, skip: 0, inactive: 0, manual_confirm: 0 },
    }
    const result = await applyStockPreparationPlan({
      permission: 'write',
      plan: forged,
      target: { objectId: 'obj_main', sheetId: 'sheet_main', keyField: 'idempotencyKey' },
      recordsApi: {
        async queryRecords() { return [] },
        async createRecord() { throw new Error('carry decisions must never reach a write') },
        async patchRecord() { throw new Error('carry decisions must never reach a write') },
      },
    })
    assert.equal(result.counts.failed, 1)
    assert.equal(result.errors[0].code, 'unsupported_decision')
  })

  await run('(iii-c) a carry hold in a real plan routes to held with zero writes (apply-writer unchanged)', async () => {
    const newAdd = row({ componentSourceId: 'PART-H', pathTokens: ['NEW', 'PART-H'] })
    const predecessorA = row({ componentSourceId: 'PART-H', pathTokens: ['OLD-A', 'PART-H'], active: false, notes: 'a' })
    const predecessorB = row({ componentSourceId: 'PART-H', pathTokens: ['OLD-B', 'PART-H'], active: false, notes: 'b' })
    const plan = planStockPreparationConflicts({
      expandedRows: [newAdd],
      existingRows: [predecessorA, predecessorB],
      carryPolicy: { carryKey: 'component_source_id' },
    })
    const created = []
    const patched = []
    const result = await applyStockPreparationPlan({
      permission: 'write',
      plan,
      target: { objectId: 'obj_main', sheetId: 'sheet_main', keyField: 'idempotencyKey' },
      recordsApi: {
        async queryRecords() { return [] },
        async createRecord(input) { created.push(input); return { id: `rec_${created.length}` } },
        async patchRecord(input) { patched.push(input); return { id: input.recordId } },
      },
    })
    assert.equal(result.counts.held, 1, 'the carry hold routes to held')
    assert.equal(result.counts.created, 1, 'the human-free ADD still applies')
    for (const call of created) {
      assertNoHumanFieldPresent(call.data || {}, 'applied ADD payload')
    }
    // The two predecessors were already inactive => skip; nothing patches human fields.
    for (const call of patched) {
      assertNoHumanFieldPresent(call.changes || {}, 'applied patch payload')
    }
  })

  // -------------------------------------------------------------------------
  // Call-site pass-through — large-bom-jobs (the second production caller).
  // -------------------------------------------------------------------------
  await run('large-bom plan handoff threads actionSnapshot.carryPolicy into the planner', async () => {
    const {
      createLargeBomBackgroundExpansionJob,
      runLargeBomBackgroundExpansionJob,
      planLargeBomBackgroundExpansionJob,
    } = require(path.join(LIB, 'stock-preparation-large-bom-jobs.cjs'))

    const map = new Map()
    const storage = {
      durable: true,
      async get(key) { return map.get(key) || null },
      async set(key, value) { map.set(key, JSON.parse(JSON.stringify(value))) },
    }
    const scope = { tenantId: 'tenant-carry', workspaceId: 'workspace-carry' }
    const data = {
      DN_PDM_PathExAttrInfo: [{ FileCode: 'P-CARRY', Parent_OBJ_ID: 'PATH-1' }],
      DN_PDM_PathInfo: [{ OBJ_ID: 'PATH-1' }],
      DN_PDM_OrderHeadInfo: [{ OBJ_ID: 'ORDER-1', path_id: 'PATH-1' }],
      DN_PDM_OrderDetailInfo: [{ order_id: 'ORDER-1', part_id: 'COMP-1', quantity: '2', sort_id: 1 }],
      DN_PDM_PartLibraryInfo: [{ OBJ_ID: 'COMP-1', IdentityNo: 'C-1', IdentityName: 'Comp 1', Material: 'Steel', SysVer: 'V1' }],
      DN_PDM_BomHeadInfo: [],
      DN_PDM_BomDetailsInfo: [],
    }
    const adapter = {
      async read(input = {}) {
        const rows = Array.isArray(data[input.object]) ? data[input.object] : []
        const matches = rows.filter((entry) =>
          Object.entries(input.filters || {}).every(([field, expected]) => entry[field] === expected))
        return {
          records: matches.map((entry) => ({ ...entry })),
          done: true,
          nextCursor: null,
          metadata: { source: 'data-source:sql-readonly', filtersApplied: true, filterFields: Object.keys(input.filters || {}).sort() },
        }
      },
    }
    await createLargeBomBackgroundExpansionJob({
      storage,
      ...scope,
      action: {
        actionId: 'plm.stock-preparation.pull-bom.v1',
        source: { kind: 'data-source:sql-readonly' },
        carryPolicy: { carryKey: 'component_source_id', manualRowReattach: 'propose_confirm' },
      },
      parameters: { projectNo: 'P-CARRY' },
      principal: 'user-carry-admin',
      createJobId: () => 'job-carry-1',
      now: () => '2026-09-01T00:00:00.000Z',
    })
    await runLargeBomBackgroundExpansionJob({
      storage,
      ...scope,
      actionId: 'plm.stock-preparation.pull-bom.v1',
      jobId: 'job-carry-1',
      sourceAdapter: adapter,
      now: () => '2026-09-01T00:01:00.000Z',
    })
    const predecessor = {
      idempotencyKey: JSON.stringify({ projectNo: 'P-CARRY', componentSourceId: 'COMP-1', parentSourceId: null, path: ['OLD', 'COMP-1'] }),
      projectNo: 'P-CARRY',
      componentSourceId: 'COMP-1',
      active: false,
      notes: 'human context on the predecessor',
    }
    const planned = await planLargeBomBackgroundExpansionJob({
      storage,
      ...scope,
      actionId: 'plm.stock-preparation.pull-bom.v1',
      jobId: 'job-carry-1',
      existingRows: [predecessor],
      runId: 'large-bom-carry-run',
      plannedAt: '2026-09-01T00:02:00.000Z',
      now: () => '2026-09-01T00:03:00.000Z',
    })
    const plan = planned.planArtifact.plan
    assert.ok(plan.summary.carry, 'the large-BOM plan consulted the carry policy from the action snapshot')
    assert.equal(plan.summary.carry.counts.carryViaConfirm, 1)
    const proposalHolds = plan.decisions.filter((decision) =>
      decision.decision === DECISIONS.MANUAL_CONFIRM
      && decision.conflictSummary && decision.conflictSummary.type === 'carry_reattach_requires_confirm')
    assert.equal(proposalHolds.length, 1)
    assert.deepEqual(proposalHolds[0].carryProposal.carryFields, ['notes'])
  })

  // -------------------------------------------------------------------------
  // Call-site pass-through — table-actions computeDryRun (the OTHER production caller).
  //
  // This is the ONLY link from deploy config to the planner for the dry-run / apply / MVP-persist /
  // reconcile entry points. Its large-BOM twin was pinned from the start; this one was not, so
  // deleting `carryPolicy: action.carryPolicy` left every suite green. Pinned here.
  // -------------------------------------------------------------------------
  await run('dry-run call site threads action.carryPolicy into the planner (mutation-pinned)', async () => {
    const { dryRunStockPreparationAction } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))

    const plmData = {
      DN_PDM_PathExAttrInfo: [{ FileCode: 'P-DRY', Parent_OBJ_ID: 'PATH-1' }],
      DN_PDM_PathInfo: [{ OBJ_ID: 'PATH-1' }],
      DN_PDM_OrderHeadInfo: [{ OBJ_ID: 'ORDER-1', path_id: 'PATH-1' }],
      DN_PDM_OrderDetailInfo: [{ order_id: 'ORDER-1', part_id: 'COMP-D', quantity: '2' }],
      DN_PDM_PartLibraryInfo: [{ OBJ_ID: 'COMP-D', IdentityNo: 'D-1', IdentityName: 'Part D', Material: 'Steel', SysVer: 'V1' }],
      DN_PDM_BomHeadInfo: [],
      DN_PDM_BomDetailsInfo: [],
    }
    const sourceAdapter = {
      async read(input = {}) {
        const rows = Array.isArray(plmData[input.object]) ? plmData[input.object] : []
        const matches = rows.filter((entry) =>
          Object.entries(input.filters || {}).every(([field, expected]) => entry[field] === expected))
        return { records: matches.map((entry) => ({ ...entry })), done: true, nextCursor: null }
      },
    }
    // The predecessor: same component, DIFFERENT key, inactive, carrying human work.
    const predecessorKey = JSON.stringify({ projectNo: 'P-DRY', componentSourceId: 'COMP-D', parentSourceId: null, path: ['OLD', 'COMP-D'] })
    const existingRow = {
      id: 'rec_1',
      sheetId: 'sheet_stock',
      version: 1,
      data: {
        projectNo: 'P-DRY',
        idempotencyKey: predecessorKey,
        componentSourceId: 'COMP-D',
        path: JSON.stringify(['OLD', 'COMP-D']),
        totalQuantity: 2,
        active: false,
        notes: 'human work on the predecessor',
      },
    }
    const recordsApi = {
      async queryRecords(input = {}) {
        return [existingRow].filter((row) => row.sheetId === input.sheetId)
          .filter((row) => Object.entries(input.filters || {}).every(([field, expected]) => row.data[field] === expected))
      },
      async createRecord() { throw new Error('dry-run must not write') },
      async patchRecord() { throw new Error('dry-run must not write') },
    }
    const action = (carryPolicy) => ({
      actionId: 'plm.stock-preparation.pull-bom.v1',
      source: { externalSystemId: 'sys_demo', kind: 'data-source:sql-readonly' },
      target: { sheetId: 'sheet_stock' },
      ...(carryPolicy ? { carryPolicy } : {}),
    })

    const memoryStorage = () => {
      const map = new Map()
      return {
        async get(key) { return map.get(key) || null },
        async set(key, value) { map.set(key, JSON.parse(JSON.stringify(value))) },
        async delete(key) { map.delete(key) },
      }
    }

    // OPT-IN, through the REAL dry-run entry point: the carry stanza must reach route-visible
    // evidence, and the plan must hold the proposal.
    const optedInAction = action({ carryKey: 'component_source_id' })
    const optedIn = await dryRunStockPreparationAction({
      action: optedInAction,
      parameters: { projectNo: 'P-DRY' },
      sourceAdapter,
      recordsApi,
      tokenStore: memoryStorage(),
    })
    assert.ok(optedIn.evidence.plan.carry, 'the dry-run consulted the carry policy from the action config')
    assert.equal(optedIn.evidence.plan.carry.counts.carryViaConfirm, 1)
    assert.deepEqual(optedIn.evidence.plan.carry.carryPolicy, { carryKey: 'component_source_id', manualRowReattach: 'propose_confirm' })
    assert.ok(optedIn.evidence.plan.conflictTypes.includes('carry_reattach_requires_confirm'))
    assert.equal(optedIn.counts[DECISIONS.MANUAL_CONFIRM], 1)
    assert.equal(optedIn.status, 'manual_confirm_required', 'a carry proposal makes the run need a human look')

    // ...and the RAW plan behind the same computeDryRun path carries the proposal itself.
    const prepared = await prepareStockPreparationConfirmationDecisions({
      action: optedInAction,
      parameters: { projectNo: 'P-DRY' },
      sourceAdapter,
      recordsApi,
    })
    const preparedHolds = holds(prepared.plan, 'carry_reattach_requires_confirm')
    assert.equal(preparedHolds.length, 1, 'the carry proposal hold reached the dry-run plan')
    assert.deepEqual(preparedHolds[0].carryProposal.carryFields, ['notes'])
    assert.equal(preparedHolds[0].carryProposal.sourceIdempotencyKey, predecessorKey)
    assertNoHumanFieldPresent(adds(prepared.plan)[0].record, 'dry-run ADD record')

    // NO CONFIG: byte-identical to the pre-wiring dry-run — no carry stanza anywhere.
    const noConfig = await dryRunStockPreparationAction({
      action: action(null),
      parameters: { projectNo: 'P-DRY' },
      sourceAdapter,
      recordsApi,
      tokenStore: memoryStorage(),
    })
    assert.equal(Object.prototype.hasOwnProperty.call(noConfig.evidence.plan, 'carry'), false, 'no config => no carry stanza')
    assert.equal(noConfig.evidence.plan.conflictTypes.includes('carry_reattach_requires_confirm'), false)
    assert.equal(noConfig.counts[DECISIONS.MANUAL_CONFIRM], 0)
  })

  // -------------------------------------------------------------------------
  // The carry-source MEMBERSHIP filter. The planner draws carry sources from the rows its
  // missing-from-PLM sweep is about to close; the `expanded/resolvedExpanded/duplicate` exclusion is
  // the ONLY thing keeping a row that is STILL PRESENT in the incoming PLM data out of that pool.
  // Without it, a component that merely gained a second occurrence would look like a re-key and
  // propose carrying a live row's human work onto the new one.
  // -------------------------------------------------------------------------
  await run('a component still present in PLM is NOT a carry source (membership filter, mutation-pinned)', () => {
    const keptTokens = ['KEEP', 'COMP-K']
    const addedTokens = ['NEW', 'COMP-K']
    const kept = row({ componentSourceId: 'COMP-K', pathTokens: keptTokens })
    const added = row({ componentSourceId: 'COMP-K', pathTokens: addedTokens })
    // The SAME row survives the refresh (present in both expanded and existing) and carries human
    // work; a second occurrence of the same component arrives under a new key.
    const existingKept = { ...kept, notes: 'live human work — must never be carried away' }

    const plan = planStockPreparationConflicts({
      expandedRows: [kept, added],
      existingRows: [existingKept],
      runId: 'membership-run',
      plannedAt: '2026-09-01T00:00:00.000Z',
      carryPolicy: { carryKey: 'component_source_id' },
    })

    assert.equal(holds(plan, 'carry_reattach_requires_confirm').length, 0, 'a live row is never a carry source')
    assert.equal(holds(plan, 'carry_ambiguous_component_source').length, 0)
    assert.equal(plan.summary.carry.counts.carryViaConfirm, 0)
    assert.equal(plan.summary.carry.noCarryByReason.no_source_match, 1, 'the new occurrence finds NO carry source')
    assert.equal(plan.counts[DECISIONS.INACTIVE], 0, 'nothing was swept inactive')
    // And the surviving row keeps its human work untouched (it is a SKIP/UPDATE, never a carry).
    assert.equal(plan.decisions.some((decision) => decision.decision === DECISIONS.ADD
      && decision.idempotencyKey === added.idempotencyKey), true)
  })

  // keep linters honest about intentionally-unused imports used only for typing context
  void StockPreparationConflictPlannerError
  void StockPreparationApplyWriterError

  console.log(`carry-plan-wiring: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.error(`failures: ${failures.join(', ')}`)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
