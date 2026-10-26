'use strict'

// Batch-refresh step 5, PR-8 — THE CHANGE PLAN ON THE SMALL LANE, DIRECT LIB CALLS (design §9.3, §10.3 (2)-(4);
// refutation B1 / B2; plan §2 W5 / W6). `dryRunStockPreparationAction` / `applyStockPreparationAction` driven the way
// the routes drive them (the lock kit's lease and binder, the REAL governance reader and store over the faithful kit,
// the REAL handle builder), REAL expansions over the canonical synthetic fixtures, a sheet fake with versions.
//
//   CP-L01 the 10-key planner input carries the CONFIRMED plan with THIS computation's source digest; the token's and
//          the execution's binding name the plan only when the planner matches it; the reconcile receives the verdict.
//   CP-L02 the preview while a written change awaits review: `review_pending`, no token, no bump, the reconcile ran AND
//          settled; `suspended` and `recovery_pending` keep precedence.
//   CP-L03 the apply: a token bound to a plan the recompute calls stale => 409 CHANGE_PLAN_STALE (before SUSPENDED /
//          BINDING_STALE / TOKEN_MISMATCH), the plan invalidated, nothing written; a written change awaiting review =>
//          409 REVIEW_PENDING for an unbound token; a matching plan => only its fields written, the plan `written`.
//   CP-L04 (B1, no deadlock) W written + a new change => B confirmed => the preview MINTS (bound to B) though W awaits
//          review => the apply executes B => B absorbs W => the review of B completes => 已完成.
//   CP-L05 (B2) a concurrent computation's stale verdict: (a) between the apply's reconcile and its begin => the bound
//          begin refuses (nothing written, no execution row); (b) while the bound execution runs => deferred, the plan
//          ends `written`, the execution `succeeded`.
//   CP-L06 EV-7 / register ①: a person's edit between the preview and the apply => the in-lease recompute reads the new
//          version => ONE patch per UPDATE carrying it, no re-read; a NOT-governed small apply carries the versions too.
// Synthetic values only.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const tableActions = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const lanes = require(path.join(LIB, 'stock-preparation-refresh-lanes.cjs'))
const pairing = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs'))
const storeModule = require(path.join(LIB, 'stock-preparation-continuation-store.cjs'))
const { readProjectRefreshState } = require(path.join(LIB, 'stock-preparation-refresh-state.cjs'))
const { sheetWriteScopeKey } = require(path.join(LIB, 'stock-preparation-project-write-lock.cjs'))
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE, normalizeStockPreparationTemplate } = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const { __internals: plannerInternals } = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))
const lockKit = require('./support/stock-preparation-project-write-lock-kit.cjs')
const F = require('./support/stock-preparation-continuation-fixtures.cjs')

const tests = []
const test = (name, fn) => tests.push([name, fn])

const TENANT = 'tenant_cpl_a'
const SHEET = 'sheet_cpl_main'
const PROJECT = F.PROJECT_NO
const PLANNED_AT = '2026-10-27T01:00:00.000Z'
const RUN_ID = 'run_cpl'
const SANDBOX_POLICY = Object.freeze({ enabled: true, allowedTargetObjectIds: ['stockPreparationMain'] })
const SCOPE = Object.freeze({ tenantId: TENANT, sheetId: SHEET, projectNo: PROJECT })
const T = storeModule.REFRESH_STORE_TABLES
const TEMPLATE_FIELDS = plannerInternals.fieldMapForTemplate(normalizeStockPreparationTemplate(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE))

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function createSource(initial) {
  const state = { data: initial }
  const adapter = {
    async read(input = {}) {
      const rows = Array.isArray(state.data[input.object]) ? state.data[input.object] : []
      const matches = rows.filter((row) => Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected))
      const offset = input.cursor ? Number(input.cursor) : 0
      const limit = input.limit || 1000
      const records = matches.slice(offset, offset + limit).map(clone)
      return { records, done: offset + records.length >= matches.length, nextCursor: offset + records.length < matches.length ? String(offset + records.length) : null }
    },
  }
  return { state, adapter }
}

// The main sheet, version-faithful (records.ts: expectedVersion compared, version + 1 per patch); `onPatch` runs
// BEFORE a patch is applied (a concurrent computation, a person's edit).
function createSheet() {
  const rows = []
  const calls = []
  const hooks = { onPatch: null }
  const api = {
    supportsWriteFence: true,
    async queryRecords(input = {}) {
      calls.push(['queryRecords', clone(input.filters || {})])
      return rows
        .filter((record) => record.sheetId === input.sheetId)
        .filter((record) => Object.entries(input.filters || {}).every(([field, value]) => record.data[field] === value))
        .slice(input.offset || 0, (input.offset || 0) + (input.limit || 1000))
        .map(clone)
    },
    async createRecord(input = {}) {
      calls.push(['createRecord'])
      const record = { id: `rec_cpl_${rows.length + 1}`, sheetId: input.sheetId, version: 1, data: { ...(input.data || {}) } }
      rows.push(record)
      return clone(record)
    },
    async patchRecord(input = {}) {
      calls.push(['patchRecord', { recordId: input.recordId, expectedVersion: input.expectedVersion, fields: Object.keys(input.changes || {}).sort() }])
      if (typeof hooks.onPatch === 'function') await hooks.onPatch(input)
      const record = rows.find((row) => row.sheetId === input.sheetId && row.id === input.recordId)
      if (!record) throw new Error('sheet fake: record not found')
      if (input.expectedVersion !== undefined && record.version !== input.expectedVersion) {
        throw Object.assign(new Error('Record version conflict'), { code: 'VERSION_CONFLICT', name: 'MultitableRecordVersionConflictError' })
      }
      record.version += 1
      record.data = { ...record.data, ...(input.changes || {}) }
      return clone(record)
    },
  }
  return {
    rows,
    calls,
    hooks,
    api,
    writes: () => calls.filter(([op]) => op === 'createRecord' || op === 'patchRecord').length,
    patches: () => calls.filter(([op]) => op === 'patchRecord').map(([, input]) => input),
    byComponent: (component) => rows.find((row) => row.data.componentSourceId === component),
  }
}

// PART-A's material and PART-C's usage, on S-001's own order (the first-pull shape).
function changedSource({ material = 'M-ALU', partCUsage = 5 } = {}) {
  const parts = F.PARTS.map((part) => (part.OBJ_ID === 'PART-A' ? { ...part, Material: material } : part))
  return F.project({ orders: [{ part: 'S-001', qty: 10 }], parts, boms: { 'S-001': [{ part: 'PART-A', usage: 2 }, { part: 'PART-B', usage: 3 }], 'PART-A': [{ part: 'PART-C', usage: partCUsage }] } })
}

async function world({ pilot = true, registered = true } = {}) {
  const harness = lockKit.createLibWriteLockHarness({ refresh: {} })
  const env = harness.refresh()
  if (registered) await env.registerProject({ tenantId: TENANT, projectNo: PROJECT, sheetId: SHEET, objectId: 'stockPreparationMain', pilot })
  const source = createSource(F.firstPullSource())
  const sheet = createSheet()
  const tokenStore = lockKit.createConsumableStorage()
  const action = { actionId: 'plm.stock-preparation.pull-bom.v1', source: { externalSystemId: 'plm_cpl_fixture', kind: 'data-source:sql-readonly' }, target: { sheetId: SHEET, objectId: 'stockPreparationMain' } }
  const w = {
    harness, env, source, sheet, tokenStore, action,
    scopeKey: sheetWriteScopeKey(SHEET),
    dryRun(extra = {}) {
      return harness.wrapDryRun(tableActions.dryRunStockPreparationAction)({ action, parameters: { projectNo: PROJECT }, sourceAdapter: source.adapter, recordsApi: sheet.api, tokenStore, plannedAt: PLANNED_AT, runId: RUN_ID, tenantId: TENANT, ...extra })
    },
    apply(dryRunToken, extra = {}) {
      return harness.wrapApply(tableActions.applyStockPreparationAction)({ sandboxPolicy: SANDBOX_POLICY, action, parameters: { projectNo: PROJECT }, dryRunToken, sourceAdapter: source.adapter, recordsApi: sheet.api, tokenStore, permission: 'write', plannedAt: PLANNED_AT, runId: RUN_ID, tenantId: TENANT, ...extra })
    },
    rows: (table) => env.db.rows(T[table]),
    async consult() { return env.governance.consult(SCOPE) },
    async derived() { return readProjectRefreshState(await w.consult()) },
    async generation() { return harness.lock.readGeneration(w.scopeKey) },
    async tokenRecord(token) { return tokenStore.map.get(`integration:table-action:dry-run-token:${token}`) || null },
    async firstPullApplied() {
      source.state.data = F.firstPullSource()
      const preview = await w.dryRun()
      assert.equal(preview.status, 'ready', `first pull: ${preview.status}`)
      const applied = await w.apply(preview.dryRunToken)
      assert.equal(applied.status, 'succeeded')
    },
    // The confirm as the route will run it: every open content hold, the state's echoes (store transaction).
    async confirmAll() {
      const state = w.rows('state')[0]
      const content = w.rows('hold').filter((row) => row.status === 'open').map(storeModule.__internals.rowToHold).filter(pairing.isContentClassHold)
      const records = pairing.changePlanRecordsFromHolds(content)
      return env.store.confirmChangePlan({
        ...SCOPE,
        confirmedBy: 'u_cpl_puller',
        holds: content.map((hold) => ({ id: hold.id, fingerprint: hold.fingerprint })),
        echo: { holdSetFingerprint: state.hold_set_fingerprint, planFingerprint: pairing.changePlanFingerprintOf({ projectNo: PROJECT, records, sourceContentDigest: state.last_computation_source_content_digest }), sourceContentDigest: state.last_computation_source_content_digest },
        candidates: content.filter((hold) => hold.kind === 'candidate_content_differs').map((hold) => ({ holdId: hold.id, candidateId: hold.pairingFingerprint, basis: { kind: 'puller_confirmed_same_demand' } })),
        sourceIdentity: lanes.refreshSourceIdentity({ action: tableActions.assertStockPreparationTargetReady(action), tenantId: TENANT }),
        template: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
      }, { bumpWithin: env.bump.bumpWithin })
    },
    async review({ reviewedBy = 'u_cpl_reviewer' } = {}) {
      const plan = w.rows('changePlan').find((row) => row.status === 'written')
      const existing = await tableActions.__internals.readExistingStockPreparationRows(sheet.api, action.target, PROJECT)
      const byId = new Map(existing.map((row) => [pairing.recordRefOf(row).id, row]))
      const current = pairing.currentContentDigestOf({ records: storeModule.__internals.rowToChangePlan(plan).recordSet, rowsByRecordId: byId, templateFields: TEMPLATE_FIELDS })
      return env.store.completeChangeReview({ ...SCOPE, changePlanId: plan.id, reviewedBy, echoDigest: plan.written_content_digest, currentContentDigest: current, conclusion: 'handled' })
    },
  }
  return w
}

async function expectCode(promise, { status, code, reason }) {
  let caught = null
  try {
    await promise
  } catch (error) {
    caught = error
  }
  assert.ok(caught, `expected a refusal ${code}`)
  if (status !== undefined) assert.equal(caught.status, status, `${caught.code}: ${caught.message}`)
  if (code !== undefined) assert.equal(caught.code, code, `${caught.code}: ${caught.message} ${JSON.stringify(caught.details)}`)
  if (reason !== undefined) assert.equal(caught.details && caught.details.reason, reason, JSON.stringify(caught.details))
  return caught
}

// First pull applied, then the changed read previewed (suspended) and confirmed.
async function confirmedWorld(options = {}) {
  const w = await world(options)
  await w.firstPullApplied()
  w.source.state.data = changedSource()
  const suspended = await w.dryRun()
  assert.equal(suspended.status, 'suspended')
  const confirmed = await w.confirmAll()
  return { w, confirmed }
}

// ── CP-L01 ───────────────────────────────────────────────────────────────────────────────────────

test('CP-L01 the planner input carries the CONFIRMED plan with THIS computation\'s source digest; the binding names it only when the planner matches; the reconcile receives the verdict', async () => {
  const { w, confirmed } = await confirmedWorld()
  const consult = await w.consult()
  assert.equal(consult.changePlans.length, 1)
  const input = lanes.continuationInputFor({ consult }, { action: tableActions.assertStockPreparationTargetReady(w.action), expansion: null, sourceContentDigest: 'src_this' })
  assert.deepEqual(Object.keys(input.changePlan).sort(), ['currentSourceContentDigest', 'id', 'planFingerprint', 'recordIds'])
  assert.equal(input.changePlan.id, confirmed.changePlanId)
  assert.equal(input.changePlan.currentSourceContentDigest, 'src_this')
  assert.equal(input.changePlan.recordIds.length, 2)
  assert.throws(() => lanes.continuationInputFor({ consult }, { action: tableActions.assertStockPreparationTargetReady(w.action), expansion: null }), (error) => error.code === 'STOCK_PREP_REFRESH_STORE_FAILED', 'a confirmed plan without this computation\'s digest is a lane defect')
  // The re-preview: matches => token bound to the plan.
  const replan = await w.dryRun()
  assert.equal(replan.status, 'ready')
  assert.ok(replan.dryRunToken)
  const record = await w.tokenRecord(replan.dryRunToken)
  assert.equal(record.refreshBinding.changePlanId, confirmed.changePlanId)
  assert.equal(replan.evidence.plan.continuation.changePlan.verdict, 'matches')
  assert.equal(JSON.stringify(replan).includes('M-ALU'), false, 'the response carries no plan value')
  // A stale verdict binds nothing: the source moves again.
  w.source.state.data = changedSource({ partCUsage: 6 })
  const stale = await w.dryRun()
  assert.equal(stale.status, 'suspended')
  assert.equal(stale.dryRunToken, null)
  assert.equal(w.rows('changePlan')[0].status, 'invalidated')
  assert.equal(w.rows('changePlan')[0].invalidated_reason, 'source_changed')
  assert.equal(w.env.invalidationAudits.length, 1, 'the invalidation rode the reconcile with its audit row')
  assert.equal(w.env.invalidationAudits[0].event.lane, 'small_preview')
})

// ── CP-L02 ───────────────────────────────────────────────────────────────────────────────────────

test('CP-L02 the preview while a written change awaits review: review_pending, no token, no bump, reconciled AND settled; suspended / recovery_pending keep precedence', async () => {
  const { w } = await confirmedWorld()
  const replan = await w.dryRun()
  const applied = await w.apply(replan.dryRunToken)
  assert.equal(applied.status, 'succeeded')
  assert.equal(w.rows('changePlan')[0].status, 'written')
  assert.equal((await w.derived()).status, 'change_pending_review', 'C12: write success is never review complete (the review precedes the settlement in the derivation)')
  const generationBefore = await w.generation()
  const review = await w.dryRun()
  assert.equal(review.status, 'review_pending')
  assert.equal(review.dryRunToken, null)
  assert.equal(review.canApply, false)
  assert.deepEqual(review.refreshReview, { pending: true, pendingReviews: 1, blocksMint: true })
  assert.deepEqual(await w.generation(), generationBefore, 'no small_preview bump')
  const state = w.rows('state')[0]
  assert.ok(state.settled_at, 'the review_pending preview still SETTLED (the 核对 of what the update wrote)')
  assert.equal((await w.derived()).status, 'change_pending_review')
  // A hold opened meanwhile: suspended wins.
  w.source.state.data = changedSource({ partCUsage: 9 })
  const suspended = await w.dryRun()
  assert.equal(suspended.status, 'suspended')
  assert.deepEqual(suspended.refreshReview, { pending: true, pendingReviews: 1, blocksMint: true })
})

// ── CP-L03 ───────────────────────────────────────────────────────────────────────────────────────

test('CP-L03 the apply: a stale bound plan => 409 CHANGE_PLAN_STALE first (invalidated, nothing written); a written change awaiting review => 409 REVIEW_PENDING; a matching plan writes only its fields', async () => {
  {
    const { w, confirmed } = await confirmedWorld()
    const replan = await w.dryRun()
    assert.ok(replan.dryRunToken)
    // The source moves after the token was minted: the apply's recompute is stale (and suspended, and its revision moved).
    w.source.state.data = changedSource({ partCUsage: 7 })
    const writes = w.sheet.writes()
    const refused = await expectCode(w.apply(replan.dryRunToken), { status: 409, code: 'STOCK_PREP_CHANGE_PLAN_STALE', reason: 'plan_invalidated' })
    assert.equal(refused.details.partial, false)
    assert.equal(w.sheet.writes(), writes, 'zero main-sheet writes')
    assert.equal(w.rows('execution').filter((row) => row.refresh_binding.changePlanId === confirmed.changePlanId).length, 0)
    const plan = w.rows('changePlan')[0]
    assert.equal(plan.status, 'invalidated')
    assert.equal(plan.invalidated_reason, 'source_changed')
  }
  {
    const { w, confirmed } = await confirmedWorld()
    const replan = await w.dryRun()
    const applied = await w.apply(replan.dryRunToken)
    assert.equal(applied.status, 'succeeded')
    // Only the plan's fields (+ RUN), on the right rows, each with the in-lease version.
    const patches = w.sheet.patches().slice(-2)
    const fields = patches.map((patch) => patch.fields.filter((field) => !field.startsWith('lastPlm')).join('+')).sort()
    assert.deepEqual(fields, ['material', 'rawQuantity+totalQuantity'])
    assert.ok(patches.every((patch) => Number.isInteger(patch.expectedVersion)))
    const execution = w.rows('execution').find((row) => row.refresh_binding.changePlanId === confirmed.changePlanId)
    assert.ok(execution)
    assert.equal(execution.status, 'succeeded')
    const plan = w.rows('changePlan')[0]
    assert.equal(plan.status, 'written')
    assert.equal(plan.execution_id, execution.id)
    // A token minted for something else while the review is pending: an UNBOUND token is refused REVIEW_PENDING.
    // (Mint one by forging what a pre-review preview would have bound: the current generation, no plan.)
    const consult = await w.consult()
    const outcomeBinding = lanes.refreshBindingOf(consult, consult.state.holdSetFingerprint, null)
    const forged = await tableActions.__internals.createDryRunToken(w.tokenStore, {
      actionId: w.action.actionId,
      parametersHash: tableActions.__internals.hashJson({ projectNo: PROJECT }),
      revision: 'whatever',
      conflictPolicyReview: null,
      ...require(path.join(LIB, 'stock-preparation-project-write-lock.cjs')).writeBindingFromGeneration(await w.generation()),
      refreshBinding: outcomeBinding,
    })
    const writes = w.sheet.writes()
    const refused = await expectCode(w.apply(forged), { status: 409, code: 'STOCK_PREP_REFRESH_REVIEW_PENDING' })
    assert.deepEqual(refused.details, { state: 'change_pending_review', pendingReviews: 1, partial: false })
    assert.equal(w.sheet.writes(), writes)
  }
})

// ── CP-L04 (B1) ──────────────────────────────────────────────────────────────────────────────────

test('CP-L04 (B1, no deadlock) W written, a new change confirmed as B: the preview mints for B though W awaits review, the apply executes B, B absorbs W, the review of B completes the project', async () => {
  const { w } = await confirmedWorld()
  const first = await w.dryRun()
  await w.apply(first.dryRunToken)
  const planW = w.rows('changePlan')[0]
  assert.equal(planW.status, 'written')
  // A new change on another row (PART-B's material) before W's review.
  const parts = F.PARTS.map((part) => (part.OBJ_ID === 'PART-A' ? { ...part, Material: 'M-ALU' } : part.OBJ_ID === 'PART-B' ? { ...part, Material: 'M-BRASS' } : part))
  w.source.state.data = F.project({ orders: [{ part: 'S-001', qty: 10 }], parts, boms: { 'S-001': [{ part: 'PART-A', usage: 2 }, { part: 'PART-B', usage: 3 }], 'PART-A': [{ part: 'PART-C', usage: 5 }] } })
  const suspended = await w.dryRun()
  assert.equal(suspended.status, 'suspended')
  await expectCode(w.review(), { status: 409, code: 'STOCK_PREP_CHANGE_REVIEW_BLOCKED', reason: 'hold_open' })
  const b = await w.confirmAll()
  await expectCode(w.review(), { status: 409, code: 'STOCK_PREP_CHANGE_REVIEW_BLOCKED', reason: 'change_plan_pending' })
  const bound = await w.dryRun()
  assert.equal(bound.status, 'ready', 'the controlled update of B is not blocked by W\'s pending review')
  assert.ok(bound.dryRunToken)
  assert.deepEqual(bound.refreshReview, { pending: true, pendingReviews: 1, blocksMint: false })
  const applied = await w.apply(bound.dryRunToken)
  assert.equal(applied.status, 'succeeded')
  const plans = w.rows('changePlan')
  assert.equal(plans.find((plan) => plan.id === planW.id).status, 'superseded')
  const planB = plans.find((plan) => plan.id === b.changePlanId)
  assert.equal(planB.status, 'written')
  assert.deepEqual(planB.absorbed_change_plan_ids, [planW.id])
  assert.equal(planB.record_count, 3, 'B\'s own row + W\'s two rows (review-only)')
  await w.dryRun() // settle
  const reviewed = await w.review()
  assert.equal(reviewed.status, 'reviewed')
  assert.equal((await w.derived()).status, 'complete')
})

// ── CP-L05 (B2) ──────────────────────────────────────────────────────────────────────────────────

test('CP-L05 (B2) a concurrent computation\'s stale verdict: between the apply\'s reconcile and its begin => the bound begin refuses (nothing written); while the bound execution runs => deferred, the plan ends written', async () => {
  // (a) between the reconcile and the begin.
  {
    const { w, confirmed } = await confirmedWorld()
    const replan = await w.dryRun()
    const handle = w.env.handleFor(TENANT)
    const interposed = Object.freeze({
      ...handle,
      store: Object.freeze({
        ...handle.store,
        beginExecution: async (input) => {
          // A read-tier preview that read a moved source commits its stale verdict here.
          const consult = await w.consult()
          await w.env.store.reconcileHolds({ ...SCOPE, decisionVersionObserved: consult.decisionVersionObserved, holds: [], computation: { lane: 'small_preview', suspended: false, generationToken: null, sourceContentDigest: 'src_moved' }, changePlan: { id: confirmed.changePlanId, verdict: 'stale' } }, { auditWithin: handle.auditWithin })
          return handle.store.beginExecution(input)
        },
      }),
    })
    const writes = w.sheet.writes()
    await expectCode(w.apply(replan.dryRunToken, { refreshGovernance: interposed }), { status: 409, code: 'STOCK_PREP_CHANGE_PLAN_STALE', reason: 'plan_invalidated' })
    assert.equal(w.sheet.writes(), writes, 'nothing written')
    assert.equal(w.rows('execution').filter((row) => row.refresh_binding.changePlanId === confirmed.changePlanId).length, 0, 'no running row left behind')
    assert.equal(w.rows('changePlan')[0].status, 'invalidated')
  }
  // (b) while the bound execution runs (a straddling preview read the sheet mid-write).
  {
    const { w, confirmed } = await confirmedWorld()
    const replan = await w.dryRun()
    let interposed = false
    w.sheet.hooks.onPatch = async () => {
      if (interposed) return
      interposed = true
      const consult = await w.consult()
      const result = await w.env.store.reconcileHolds({ ...SCOPE, decisionVersionObserved: consult.decisionVersionObserved, holds: [], computation: { lane: 'small_preview', suspended: false, generationToken: null, sourceContentDigest: 'src_mid_write' }, changePlan: { id: confirmed.changePlanId, verdict: 'stale' } }, { auditWithin: w.env.handleFor(TENANT).auditWithin })
      assert.equal(result.changePlan.deferred, true, 'a running bound execution defers the invalidation')
    }
    const applied = await w.apply(replan.dryRunToken)
    assert.equal(applied.status, 'succeeded')
    assert.ok(interposed)
    const plan = w.rows('changePlan')[0]
    assert.equal(plan.status, 'written', 'the landed write is the plan\'s, recorded as written')
    const execution = w.rows('execution').find((row) => row.refresh_binding.changePlanId === confirmed.changePlanId)
    assert.equal(execution.status, 'succeeded')
    assert.equal(w.env.invalidationAudits.length, 0)
  }
})

// ── CP-L06 (EV-7, register ①) ────────────────────────────────────────────────────────────────────

test('CP-L06 (EV-7) the version moved between the preview and the apply: ONE patch per UPDATE carrying the IN-LEASE version, no re-read; a NOT-governed small apply carries the versions too', async () => {
  for (const governed of [true, false]) {
    const w = await world({ pilot: governed, registered: governed })
    await w.firstPullApplied()
    // A plain refresh change (governed: confirmed as a plan; not governed: an ordinary UPDATE).
    w.source.state.data = changedSource({ partCUsage: 5, material: 'M-STEEL' })
    let preview = await w.dryRun()
    if (governed) {
      assert.equal(preview.status, 'suspended')
      await w.confirmAll()
      preview = await w.dryRun()
    }
    assert.equal(preview.status, 'ready', `governed=${governed}`)
    // The row the apply will patch is written AFTER the preview without a data change (a no-op write by another
    // writer: the version moves, the revision — which hashes the rows as they stand — does not). A person's cell edit
    // here would move the revision and the token would be refused TOKEN_MISMATCH before any write (E-4: a re-preview is
    // required, pre-existing); its version fence is S8-13 / EV-2.
    const target = w.sheet.byComponent('PART-C')
    target.version += 1
    const versionAtApply = target.version
    const before = w.sheet.calls.length
    const applied = await w.apply(preview.dryRunToken)
    assert.equal(applied.status, 'succeeded', `governed=${governed}`)
    const calls = w.sheet.calls.slice(before)
    const patches = calls.filter(([op]) => op === 'patchRecord').map(([, input]) => input)
    assert.equal(patches.length, 1, `governed=${governed}: exactly one patch`)
    assert.equal(patches[0].recordId, target.id)
    assert.equal(patches[0].expectedVersion, versionAtApply, 'the version the in-lease recompute read (never the preview\'s)')
    // The writer's own per-key lookup of the target (this fake declares no list filter) is the only per-key read of it:
    // a conflict's re-read would be a second one.
    const perKeyReads = calls.filter(([op, filters]) => op === 'queryRecords' && filters.idempotencyKey === target.data.idempotencyKey)
    assert.equal(perKeyReads.length, 1, 'the lookup only — no conflict, no re-read')
    if (!governed) assert.equal(w.env.stepFourRowCount(), 0, 'not governed: no step-4 / step-5 row')
  }
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-change-plan-lanes.test.cjs', tests)
