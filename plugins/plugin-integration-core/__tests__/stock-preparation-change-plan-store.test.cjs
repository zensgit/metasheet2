'use strict'

// Batch-refresh step 5, PR-8 — THE CHANGE-PLAN STORE (migration 104; lib/stock-preparation-continuation-store.cjs
// confirmChangePlan / completeChangeReview / readChangePlan, the consult read, the reconcile verdict, the bound
// beginExecution and the finish). Design §4.3 (as corrected), §10.3 (1)-(5); plan §3.4, §9.3 C01-C12; refutation of
// the PR-8 plan B1 / B2 / M2 / M3 / m2 / m3. Every hold here comes from the REAL planner over the canonical synthetic
// S/P fixtures (support/stock-preparation-continuation-fixtures.cjs) unless a case says otherwise.
//
//   CP-S01 migration 104: table, enum CHECKs set-equal to the store, the two partial unique indexes, the shape CHECKs
//          the kit models, the header (FAIL CLOSED, G10 SQL, Q-B, up-only, no audit vocabulary re-listing).
//   CP-S02 the consult answers the PENDING plans (confirmed + written), values-free (no record_set, no notes), with the
//          scope triple (m3); a reviewed / invalidated / superseded plan is not pending; a foreign row refuses.
//   CP-S03 the confirm: the plan row, the bump (`change_plan_confirm`) on the transaction handle, the holds resolved,
//          decision_version + 1, the audit row last on the handle; the statement order (state FOR UPDATE first, the
//          open holds before the bump, the executions after it, the inserts after, the audit last).
//   CP-S04 every admissibility fact decided from the ROWS (the echo built from an earlier state): hold set moved,
//          source moved, a content hold re-keyed / missing / extra, a runbook-only hold (S25), a structure hold (C07),
//          a failed execution (RECOVERY_PENDING after the bump) — nothing persisted, the bump not reached or refused.
//   CP-S05 a relationship content change: the relationship re-stamped with the POST-CHANGE pair, revision + 1,
//          unconsumed, confirmed_* moved; a relationship that moved since => STALE continuation_moved.
//   CP-S06 the combined confirm (candidate_content_differs): relationship + members + plan, ONE bump, the stamps are
//          the post-change pair; a claim collision => 409 CONFIRM_CONFLICT, nothing persisted.
//   CP-S07 supersede and ABSORPTION (B1): a later confirm supersedes the confirmed plan; a written plan is never
//          superseded by a confirm — its fields' review baselines are carried; the later plan's successful WRITE
//          absorbs every unreviewed field (review-only) and supersedes it; an invalidated / failed later plan leaves the
//          written one pending (the obligation is durable) — the derived state stays 变更待复核.
//   CP-S08 the reconcile verdict: stale => invalidated(source_changed) + its audit row on the reconcile's handle;
//          matches => still confirmed; a plan invalidated meanwhile => 409 CHANGE_PLAN_STALE; a plan written meanwhile
//          => STATE_MOVED; a running bound execution => deferred; no audit hook => 501; nothing on a CAS miss.
//   CP-S09 the bound begin asserts the plan under the lock; the finish marks written / invalidated(execution_failed).
//   CP-S10 the review: happy path (no bump, decision_version + 1, the state's reviewed_*); BLOCKED hold_open /
//          change_plan_pending; RECOVERY_PENDING; STALE content_moved / echo_moved / plan_replaced; the notes rules;
//          an audit failure and a COMMIT failure roll it back.
//   CP-S11 E09 on the confirm with the REAL lock on the same db: an audit failure rolls back the plan, the holds, the
//          re-stamp AND the generation bump; a COMMIT failure => 503 `commit`.
//   CP-S12 M2: a person's edit on a content-changed row re-keys nothing (same hold id / fingerprint; the volatile
//          observations refreshed on keep); the confirm built before the edit still commits.
//   CP-S13 M3: a needs_reconfirmation relationship whose content changed (re-confirmable reason) is resolved and
//          RE-ACTIVATED by the confirm; with a non-re-confirmable reason the hold says reconfirm_not_admissible.
//   CP-S14 review fix N1: the combined confirm re-reads the pilot marker on its own transaction handle after the state
//          lock (the real governance reader over the same db): cleared / on another sheet => 409 NOT_PILOT, unwired =>
//          501, nothing persisted, no bump; a content-only confirm never reads it.
//   CP-S15 review fix N3 (C06): the consult's private `expectedContent` — the written plan's cells; after its review the
//          reviewed plan the state's digest names (never a timestamp order); a later written plan wins per field; none
//          without a review / write; a store answer without it is unreadable.
// Synthetic values only.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const kit = require(path.join(__dirname, 'support', 'stock-preparation-refresh-store-kit.cjs'))
const F = require(path.join(__dirname, 'support', 'stock-preparation-continuation-fixtures.cjs'))
const storeModule = require(path.join(LIB, 'stock-preparation-continuation-store.cjs'))
const pairing = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs'))
const governanceModule = require(path.join(LIB, 'stock-preparation-refresh-governance.cjs'))
const { readProjectRefreshState } = require(path.join(LIB, 'stock-preparation-refresh-state.cjs'))
const lockModule = require(path.join(LIB, 'stock-preparation-project-write-lock.cjs'))
const { createStockPreparationProjectTargetStore } = require(path.join(LIB, 'stock-preparation-project-target-store.cjs'))
const { normalizeStockPreparationTemplate, STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const { __internals: plannerInternals } = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))

const {
  REFRESH_STORE_TABLES: T,
  REFRESH_STORE_ERROR_CODES: CODES,
  CHANGE_PLAN_STATUSES,
  CHANGE_PLAN_INVALIDATED_REASONS,
  REVIEW_CONCLUSIONS,
  createStockPreparationContinuationStore,
} = storeModule

const tests = []
const test = (name, fn) => tests.push([name, fn])

const TENANT = 'tenant_cps_a'
const SHEET = 'sheet_cps_a'
const PULLER = 'u_cps_puller'
const REVIEWER = 'u_cps_reviewer'
const SRC_1 = 'src_cps_1'
const SRC_2 = 'src_cps_2'
const FREE_LOCK = { state: { present: true, leaseHeld: false, leaseLive: false }, generation: { generationToken: 'g_free', fencingEpoch: 1, leaseId: null } }
const TEMPLATE_FIELDS = plannerInternals.fieldMapForTemplate(normalizeStockPreparationTemplate(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE))
// Values that must never leave the store through a values-free surface.
const VALUE_SENTINELS = ['M-ALU-SENTINEL', 'S-001', 'PART-A', 'PART-B', 'D100-01', 'SubAssembly', '"path":']

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

async function expectError(promise, { status, code, reason }) {
  let caught = null
  try {
    await promise
  } catch (error) {
    caught = error
  }
  assert.ok(caught, `expected a throw (${code})`)
  if (status !== undefined) assert.equal(caught.status, status, `status of ${caught.code}: ${caught.message}`)
  if (code !== undefined) assert.equal(caught.code, code, `${caught.code}: ${caught.message} ${JSON.stringify(caught.details)}`)
  if (reason !== undefined) assert.equal(caught.details && caught.details.reason, reason, JSON.stringify(caught.details))
  const text = JSON.stringify({ message: caught.message, details: caught.details })
  for (const sentinel of VALUE_SENTINELS) assert.ok(!text.includes(sentinel), `error carries a value (${sentinel}): ${text}`)
  return caught
}

function tablesSnapshot(db) {
  return JSON.stringify(Object.values(T).map((table) => db.rows(table)))
}

function statementsOf(db, prefix = 'trx.') {
  return db.statements(prefix).map(([method, table]) => `${method.slice(prefix.length)}:${String(table).replace('integration_stock_prep_', '')}`)
}

// ── the world ────────────────────────────────────────────────────────────────────────────────────

async function world({ realLock = false } = {}) {
  const clock = kit.createClock('2026-10-27T00:00:00.000Z')
  const db = kit.createFakeRefreshDb({ clock, lockTable: realLock })
  let n = 0
  const store = createStockPreparationContinuationStore({ db, now: clock.now, idGenerator: (kind) => `${kind}_${String((n += 1)).padStart(4, '0')}` })
  const scope = { tenantId: TENANT, sheetId: SHEET, projectNo: F.PROJECT_NO }
  const bump = kit.createFakeBumpWithin()
  const lock = realLock ? lockModule.createStockPreparationProjectWriteLock({ db, now: clock.now }) : null
  const audits = []
  const auditWithin = async (trx, event) => { audits.push({ trx, event: clone(event) }) }
  // Review fix N1: the project is a PILOT in the registry of the SAME kit db, and the combined confirm re-reads that marker
  // through the REAL governance reader (PR B's projection with the store's transaction handle as executor).
  const registryRowId = `pt_${SHEET}`
  db.tables.get(kit.REGISTRY_TABLE).set(registryRowId, kit.registryRow({ id: registryRowId, tenantId: TENANT, projectNo: F.PROJECT_NO, sheetId: SHEET, pilot: true }))
  const governance = governanceModule.createStockPreparationRefreshGovernance({
    continuationStore: store,
    projectTargetStore: createStockPreparationProjectTargetStore({ db }),
    projectWriteLock: { readState: async () => FREE_LOCK.state, readGeneration: async () => FREE_LOCK.generation },
  })
  const pilotReads = []
  const pilotWithin = async (trx) => {
    const answer = await governance.readPilotWithin(scope, trx)
    pilotReads.push(answer.enabled)
    return answer
  }
  const setRegistry = (changes) => {
    const row = db.tables.get(kit.REGISTRY_TABLE).get(registryRowId)
    db.tables.get(kit.REGISTRY_TABLE).set(registryRowId, { ...row, ...changes })
  }
  return { clock, db, store, scope, bump, lock, audits, auditWithin, governance, pilotReads, pilotWithin, setRegistry }
}

function rowsOf(w, table) {
  return w.db.rows(T[table] || table)
}

function stateRow(w) {
  return rowsOf(w, 'state')[0] || null
}

function computation(overrides = {}) {
  return { lane: 'small_preview', suspended: true, generationToken: 'g_cps', sourceContentDigest: SRC_1, ...overrides }
}

async function reconcile(w, holds, extra = {}, options = {}) {
  const state = stateRow(w)
  return w.store.reconcileHolds({
    ...w.scope,
    decisionVersionObserved: state ? state.decision_version : 0,
    holds,
    computation: computation({ suspended: holds.length > 0, ...(extra.computation || {}) }),
    ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'computation')),
  }, { auditWithin: w.auditWithin, ...options })
}

function openHolds(w) {
  return rowsOf(w, 'hold').filter((row) => row.status === 'open').map(storeModule.__internals.rowToHold)
}

// The confirm's inputs as GET current shows them: every open content-class hold, the state's echoes, the plan
// fingerprint over the records derived from those holds (+ the state's last source content digest).
function proposalOf(w, { candidates = [] } = {}) {
  const state = stateRow(w)
  const content = openHolds(w).filter(pairing.isContentClassHold)
  const records = pairing.changePlanRecordsFromHolds(content)
  return {
    holds: content.map((hold) => ({ id: hold.id, fingerprint: hold.fingerprint })),
    echo: {
      holdSetFingerprint: state.hold_set_fingerprint,
      planFingerprint: pairing.changePlanFingerprintOf({ projectNo: F.PROJECT_NO, records, sourceContentDigest: state.last_computation_source_content_digest }),
      sourceContentDigest: state.last_computation_source_content_digest,
    },
    candidates: candidates.length > 0 ? candidates : content.filter((hold) => hold.kind === 'candidate_content_differs').map((hold) => ({ holdId: hold.id, candidateId: hold.pairingFingerprint, basis: { kind: 'puller_confirmed_same_demand' } })),
    records,
  }
}

async function confirmPlan(w, { proposal = proposalOf(w), hooks = {}, input = {} } = {}) {
  return w.store.confirmChangePlan({
    ...w.scope,
    confirmedBy: PULLER,
    holds: proposal.holds,
    echo: proposal.echo,
    candidates: proposal.candidates,
    sourceIdentity: F.SOURCE_IDENTITY,
    template: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
    ...input,
  }, { bumpWithin: w.realLockBump || w.bump.bumpWithin, auditWithin: w.auditWithin, pilotWithin: w.pilotWithin, ...hooks })
}

// A RUNNING execution bound to `changePlanId` (the bound begin under the state lock), and its finish.
const GUARD = Object.freeze({ leaseRunId: 'run_cps', leaseId: 'lease_cps', fencingEpoch: 1, generation: 1, generationToken: 'g_cps_run' })
async function beginBound(w, changePlanId, continuations = []) {
  return w.store.beginExecution({
    ...w.scope,
    lane: 'small_apply',
    guard: GUARD,
    tokenRevision: 'rev_cps',
    planDigest: 'pd_cps',
    plannedCounts: { update: 1 },
    refreshBinding: { continuations, changePlanId, holdSetFingerprint: null },
    startedBy: PULLER,
  })
}

async function finish(w, executionId, status = 'succeeded', extra = {}) {
  return w.store.finishExecution({ ...w.scope, executionId, status, written: status === 'succeeded' ? 2 : 1, attemptedWrites: 2, counts: { updated: 2 }, ...extra })
}

// ── hold scenarios from the REAL planner ─────────────────────────────────────────────────────────

const CHANGED_MATERIAL = 'M-ALU-SENTINEL'

// First pull (S-001 on its own) on the sheet; the second read changes PART-A's material (an identity field) and
// PART-C's usage 4 -> 5 (its single-level usage and total). Pilot: two content_change holds.
async function contentScenario({ partAMaterial = CHANGED_MATERIAL, partCUsage = 5, sheet: sheetIn } = {}) {
  const sheet = sheetIn || await F.firstPullSheet()
  const parts = F.PARTS.map((part) => (part.OBJ_ID === 'PART-A' ? { ...part, Material: partAMaterial } : part))
  const expansion = await F.expand(F.project({ orders: [{ part: 'S-001', qty: 10 }], parts, boms: { 'S-001': [{ part: 'PART-A', usage: 2 }, { part: 'PART-B', usage: 3 }], 'PART-A': [{ part: 'PART-C', usage: partCUsage }] } }))
  const planned = F.plan(expansion, sheet, { continuation: F.continuationInput({ pilot: true, demandEvidence: expansion.demandEvidence }) })
  return { sheet, expansion, planned, holds: planned.holds }
}

// The second pull with S-001 nested in P-001 at `edge` (3 => the S root total 15 vs the old order quantity 10):
// a candidate_content_differs hold (pilot).
async function candidateContentScenario({ edge = 3 } = {}) {
  const sheet = await F.firstPullSheet()
  const expansion = await F.expand(F.secondPullSource({ edge }))
  const planned = F.plan(expansion, sheet, { continuation: F.continuationInput({ pilot: true, demandEvidence: expansion.demandEvidence }) })
  return { sheet, expansion, planned, holds: planned.holds }
}

// A CONFIRMED relationship (the canonical candidate confirmed through the store), then a read in which PART-B's
// material changed inside the continued subtree => relationship_content_change (with its post-change pair).
async function relationshipScenario(w, { material = CHANGED_MATERIAL, statusOverride } = {}) {
  const fixture = await kit.candidateHoldFixture()
  await reconcile(w, [fixture.hold])
  const row = rowsOf(w, 'hold').find((entry) => entry.fingerprint === fixture.hold.fingerprint && entry.status === 'open')
  await w.store.confirmContinuation({ ...w.scope, holdId: row.id, echo: kit.echoOf(fixture.hold), basis: { kind: 'puller_confirmed_same_demand' }, confirmedBy: PULLER, sourceIdentity: F.SOURCE_IDENTITY }, { bumpWithin: w.bump.bumpWithin, pilotWithin: kit.seedPilotWithin })
  if (statusOverride) {
    const cont = rowsOf(w, 'continuation')[0]
    await w.db.updateRow(T.continuation, statusOverride, { id: cont.id })
  }
  const governance = await w.store.readGovernanceRows(w.scope)
  const memberCounts = new Map()
  for (const member of governance.members) memberCounts.set(member.continuationId, (memberCounts.get(member.continuationId) || 0) + 1)
  const slice = governanceModule.plannerSlice({ ok: true, continuations: governance.continuations.map((entry) => ({ ...entry, memberCount: memberCounts.get(entry.id) || 0 })), members: governance.members })
  const parts = F.PARTS.map((part) => (part.OBJ_ID === 'PART-B' ? { ...part, Material: material } : part))
  const expansion = await F.expand(F.secondPullSource({ parts }))
  const planned = F.plan(expansion, fixture.sheet, { continuation: F.continuationInput({ pilot: true, demandEvidence: expansion.demandEvidence, continuations: slice.continuations, members: slice.members }) })
  return { fixture, expansion, planned, holds: planned.holds, continuationId: slice.continuations[0].id }
}

// ── CP-S01 ───────────────────────────────────────────────────────────────────────────────────────

test('CP-S01 migration 104: the table, enum CHECKs set-equal to the store, the two partial unique indexes, the modelled shape CHECKs, and the header', () => {
  const sql = kit.readMigrationText(kit.MIGRATION_FILES.changePlan)
  assert.ok(sql.includes(`CREATE TABLE IF NOT EXISTS ${T.changePlan} (`))
  const schema = kit.loadSchema()
  const enumOf = (column) => schema[T.changePlan].enums.find((entry) => entry.column === column)
  assert.deepEqual(enumOf('status').values.slice().sort(), CHANGE_PLAN_STATUSES.slice().sort())
  assert.equal(enumOf('status').nullable, false)
  assert.deepEqual(enumOf('invalidated_reason').values.slice().sort(), CHANGE_PLAN_INVALIDATED_REASONS.slice().sort())
  assert.equal(enumOf('invalidated_reason').nullable, true)
  assert.deepEqual(enumOf('review_conclusion').values.slice().sort(), REVIEW_CONCLUSIONS.slice().sort())
  for (const name of ['uniq_integration_stock_prep_change_plan_confirmed', 'uniq_integration_stock_prep_change_plan_written']) {
    const index = kit.UNIQUE_INDEXES.find((entry) => entry.name === name)
    assert.ok(index, name)
    const match = sql.match(new RegExp(`CREATE UNIQUE INDEX IF NOT EXISTS ${name}\\s+ON ${T.changePlan} \\(([^)]*)\\) WHERE status = '(\\w+)';`))
    assert.ok(match, `${name} is partial in the SQL`)
    assert.deepEqual(match[1].split(',').map((column) => column.trim()), index.columns)
    assert.ok(index.where({ status: match[2] }) && !index.where({ status: 'reviewed' }))
  }
  for (const check of kit.SHAPE_CHECKS.filter((entry) => entry.table === T.changePlan)) assert.ok(sql.includes(`CONSTRAINT ${check.name}`), check.name)
  for (const column of ['record_set', 'absorbed_change_plan_ids', 'hold_ids', 'continuation_ids', 'plan_fingerprint', 'planned_content_digest', 'review_baseline_digest']) {
    assert.ok(schema[T.changePlan].columns[column].notNull, `${column} NOT NULL`)
  }
  assert.match(sql, /FAIL CLOSED/)
  assert.match(sql, /SELECT count\(\*\) FROM integration_stock_prep_change_plan WHERE status IN \('confirmed', 'written'\);/, 'the G10 stop-condition SQL')
  assert.match(sql, /OWNER GATE Q-B/)
  assert.match(sql, /up-only/)
  assert.match(sql, /RunMigrations 0/)
  assert.doesNotMatch(sql, /\bDROP\s+TABLE\b/i)
  assert.ok(!sql.includes('ADD CONSTRAINT integration_stock_prep_audit_action_check'), 'D9: the audit-migration discovery phrase is absent')
  assert.deepEqual(storeModule.BUMP_REASONS.changePlan, 'change_plan_confirm')
  assert.ok(lockModule.PROJECT_WRITE_GENERATION_REASONS.includes('change_plan_confirm'))
})

// ── CP-S02 ───────────────────────────────────────────────────────────────────────────────────────

test('CP-S02 the consult answers the pending plans both ways, values-free and scoped; ended plans are not pending; a foreign row refuses', async () => {
  const w = await world()
  const scenario = await contentScenario()
  await reconcile(w, scenario.holds)
  const confirmed = await confirmPlan(w)
  const rows = await w.store.readGovernanceRows(w.scope)
  assert.equal(rows.changePlans.length, 1)
  const summary = rows.changePlans[0]
  assert.equal(summary.id, confirmed.changePlanId)
  assert.equal(summary.status, 'confirmed')
  assert.deepEqual([summary.tenantId, summary.sheetId, summary.projectNo], [TENANT, SHEET, F.PROJECT_NO], 'm3: the scope triple the reader asserts')
  assert.equal(summary.recordIds.length, 2)
  assert.equal(Object.prototype.hasOwnProperty.call(summary, 'recordSet'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(summary, 'reviewNotes'), false)
  assert.ok(rowsOf(w, 'changePlan')[0].record_set.some((record) => JSON.stringify(record).includes(CHANGED_MATERIAL)), 'the private record set holds the value')
  assert.equal(JSON.stringify(rows.changePlans).includes(CHANGED_MATERIAL), false, 'the consult answer does not')
  // The governance reader asserts the triple and counts the plan as a durable row.
  const governance = governanceModule.createStockPreparationRefreshGovernance({
    continuationStore: w.store,
    projectTargetStore: { getPilotState: async () => null, getPilotStateBySheetId: async () => null },
    projectWriteLock: { readState: async () => FREE_LOCK.state, readGeneration: async () => FREE_LOCK.generation },
  })
  const consult = await governance.consult(w.scope)
  assert.equal(consult.changePlans.length, 1)
  assert.equal(readProjectRefreshState(consult).status, 'confirmed_pending_execution')
  // Only the plan: every other step-4 row removed => still governed (anyRows counts the plan).
  for (const table of ['hold', 'state', 'continuation', 'member', 'execution']) for (const row of rowsOf(w, table)) w.db.tables.get(T[table]).delete(row.id)
  const onlyPlan = await governance.consult(w.scope)
  assert.equal(onlyPlan.governed, true, 'O-19: a change plan alone governs the project')
  // Ended plans are not pending.
  for (const status of ['reviewed', 'invalidated', 'superseded']) {
    const id = rowsOf(w, 'changePlan')[0].id
    const set = status === 'reviewed'
      ? { status, written_at: new Date(), written_content_digest: 'd', execution_id: 'exec_x', reviewed_at: new Date(), reviewed_by: 'u', review_conclusion: 'handled', reviewed_content_digest: 'd' }
      : status === 'invalidated' ? { status, invalidated_at: new Date(), invalidated_reason: 'source_changed' } : { status, superseded_at: new Date(), superseded_by: 'chp_x' }
    const copy = { ...rowsOf(w, 'changePlan')[0], id: `${id}_${status}`, ...set }
    w.db.tables.get(T.changePlan).set(copy.id, copy)
  }
  w.db.tables.get(T.changePlan).delete(rowsOf(w, 'changePlan').find((row) => row.status === 'confirmed').id)
  const ended = await w.store.readGovernanceRows(w.scope)
  assert.equal(ended.changePlans.length, 0, 'reviewed / invalidated / superseded plans are not pending')
  // A foreign tenant's pending row on this sheet + project refuses the consult (TENANT_MISMATCH), never "none".
  const foreign = { ...rowsOf(w, 'changePlan')[0], id: 'chp_foreign', tenant_id: 'tenant_other', status: 'confirmed', superseded_at: null, superseded_by: null, invalidated_at: null, invalidated_reason: null, reviewed_at: null, reviewed_by: null, review_conclusion: null, reviewed_content_digest: null, written_at: null, written_content_digest: null, execution_id: null }
  w.db.tables.get(T.changePlan).set(foreign.id, foreign)
  await expectError(governance.consult(w.scope), { status: 409, code: 'STOCK_PREP_REFRESH_TENANT_MISMATCH' })
})

// ── CP-S03 ───────────────────────────────────────────────────────────────────────────────────────

test('CP-S03 the confirm: plan row, in-transaction bump, holds resolved, decision_version + 1, audit last — in that statement order', async () => {
  const w = await world()
  const scenario = await contentScenario()
  await reconcile(w, scenario.holds)
  const before = stateRow(w)
  const proposal = proposalOf(w)
  assert.equal(proposal.holds.length, 2)
  w.db.log.length = 0
  const confirmed = await confirmPlan(w, { proposal })
  assert.equal(confirmed.state, 'confirmed_pending_execution')
  assert.equal(confirmed.nextStep, 'preview_again')
  assert.equal(confirmed.recordCount, 2)
  const plan = rowsOf(w, 'changePlan')[0]
  assert.equal(plan.status, 'confirmed')
  assert.equal(plan.plan_fingerprint, proposal.echo.planFingerprint)
  assert.equal(plan.source_content_digest, SRC_1)
  assert.equal(plan.review_baseline_digest, 'none')
  assert.equal(plan.write_record_count, 2)
  assert.deepEqual(plan.absorbed_change_plan_ids, [])
  assert.equal(plan.planned_content_digest, pairing.plannedContentDigestOf(plan.record_set))
  for (const record of plan.record_set) {
    for (const cell of Object.values(record.fields)) {
      assert.ok(Object.prototype.hasOwnProperty.call(cell, 'afterCanonical'))
      assert.equal(cell.reviewOnly, undefined)
    }
  }
  const material = plan.record_set.find((record) => record.fields.material)
  assert.deepEqual(material.fields.material, { before: 'M-STEEL', after: CHANGED_MATERIAL, afterCanonical: CHANGED_MATERIAL })
  assert.equal(w.bump.calls.length, 1)
  assert.equal(w.bump.calls[0].options.reason, 'change_plan_confirm')
  assert.equal(w.bump.calls[0].trx, w.db.lastTransactionHandle, 'the bump rides the confirm\'s transaction handle')
  assert.equal(plan.confirmed_generation, w.bump.current())
  const holds = rowsOf(w, 'hold')
  assert.ok(holds.every((row) => row.status === 'resolved' && row.resolution === 'change_plan_confirmed' && row.resolved_by === PULLER))
  const after = stateRow(w)
  assert.equal(after.decision_version, before.decision_version + 1)
  assert.equal(after.hold_set_fingerprint, null)
  assert.equal(w.audits.length, 1)
  assert.equal(w.audits[0].trx, w.db.lastTransactionHandle)
  assert.deepEqual(Object.keys(w.audits[0].event).sort(), ['changePlanId', 'continuationCount', 'createdContinuationCount', 'generationToken', 'holdCount', 'operation', 'recordCount', 'supersededCount'])
  assert.equal(w.audits[0].event.operation, 'change_plan_confirmed')
  const statements = statementsOf(w.db)
  const index = (needle, from = 0) => statements.findIndex((entry, i) => i >= from && entry === needle)
  assert.equal(statements[0], 'selectOneForUpdate:refresh_state', 'the state row FIRST')
  const holdRead = index('select:refresh_hold')
  const firstExecutionRead = index('select:refresh_execution')
  const insertPlan = index('insertOne:change_plan')
  assert.ok(holdRead > 0 && holdRead < firstExecutionRead, 'the open holds are re-read before the executions')
  assert.ok(firstExecutionRead < insertPlan, 'the executions (after the bump) before the insert')
  assert.equal(statements[statements.length - 1], 'updateRow:refresh_state', 'the decision_version advance is the last statement before the audit hook')
  assert.ok(statements.indexOf('updateRow:refresh_hold') > insertPlan, 'the holds are resolved after the plan insert')
})

test('CP-S03b the audit row is the LAST write of the confirm transaction (E09: it rides the same handle)', async () => {
  const w = await world()
  await reconcile(w, (await contentScenario()).holds)
  let logAtAudit = null
  await confirmPlan(w, { hooks: { auditWithin: async (trx) => { logAtAudit = { length: w.db.log.length, trx } } } })
  const commitIndex = w.db.log.map(([method]) => method).lastIndexOf('commit')
  assert.equal(logAtAudit.trx, w.db.lastTransactionHandle)
  assert.equal(logAtAudit.length, commitIndex, 'nothing between the audit row and the COMMIT')
})

// ── CP-S04 ───────────────────────────────────────────────────────────────────────────────────────

test('CP-S04 every fact is decided from the rows under the lock: a stale echo / hold set / source, a runbook-only or structure hold, a failed execution — nothing persisted', async () => {
  const scenario = await contentScenario()
  const base = async () => {
    const w = await world()
    await reconcile(w, scenario.holds)
    return { w, proposal: proposalOf(w) }
  }
  // (a) the hold set moved after the page was read (a computation re-kept one hold and added a structure-free new one).
  {
    const { w, proposal } = await base()
    const other = await contentScenario({ partCUsage: 6 })
    await reconcile(w, other.holds)
    const snapshot = tablesSnapshot(w.db)
    await expectError(confirmPlan(w, { proposal }), { status: 409, code: CODES.CHANGE_PLAN_STALE, reason: 'hold_set_moved' })
    assert.equal(tablesSnapshot(w.db), snapshot)
    assert.equal(w.bump.calls.length, 0)
  }
  // (b) the source moved (the same holds, another source digest recorded by the latest computation).
  {
    const { w, proposal } = await base()
    await reconcile(w, scenario.holds, { computation: { sourceContentDigest: SRC_2 } })
    await expectError(confirmPlan(w, { proposal }), { status: 409, code: CODES.CHANGE_PLAN_STALE, reason: 'source_moved' })
    assert.equal(rowsOf(w, 'changePlan').length, 0)
  }
  // (c) the named set is not the open content set (one named hold missing) / a fingerprint echoed wrong.
  {
    const { w, proposal } = await base()
    await expectError(confirmPlan(w, { proposal: { ...proposal, holds: proposal.holds.slice(0, 1) } }), { status: 409, code: CODES.CHANGE_PLAN_STALE, reason: 'hold_set_incomplete' })
    await expectError(confirmPlan(w, { proposal: { ...proposal, holds: [proposal.holds[0], { ...proposal.holds[1], fingerprint: 'f'.repeat(64) }] } }), { status: 409, code: CODES.CHANGE_PLAN_STALE, reason: 'hold_fingerprint' })
    await expectError(confirmPlan(w, { proposal: { ...proposal, echo: { ...proposal.echo, planFingerprint: 'e'.repeat(64) } } }), { status: 409, code: CODES.CHANGE_PLAN_STALE, reason: 'plan_fingerprint' })
    assert.equal(rowsOf(w, 'changePlan').length, 0)
    assert.equal(w.bump.calls.length, 0)
  }
  // (d) S25: a runbook-only hold opened (an escalation landed after the page was read).
  {
    const { w, proposal } = await base()
    const runbook = kit.reconfirmHoldFor('cont_cps_other', { confirmable: false, reason: 'specialist_repair', verdict: 'structure_changed' })
    await reconcile(w, [...scenario.holds, runbook])
    const row = rowsOf(w, 'hold').find((entry) => entry.fingerprint === runbook.fingerprint)
    await w.db.updateRow(T.hold, { runbook_only: true }, { id: row.id })
    const refreshed = proposalOf(w)
    await expectError(confirmPlan(w, { proposal: refreshed }), { status: 409, code: CODES.CHANGE_PLAN_NOT_ALLOWED, reason: 'runbook_only_hold_open' })
    assert.equal(w.bump.calls.length, 0)
    void proposal
  }
  // (e) C07: a structure-class hold open on the project (a relationship verdict structure_changed).
  {
    const { w } = await base()
    const structure = kit.reconfirmHoldFor('cont_cps_other', { confirmable: false, reason: 'reconfirm_not_admissible', verdict: 'structure_changed' })
    await reconcile(w, [...scenario.holds, structure])
    const refused = await expectError(confirmPlan(w, { proposal: proposalOf(w) }), { status: 409, code: CODES.CHANGE_PLAN_STRUCTURE_CHANGE_PRESENT })
    assert.equal(refused.details.holdCount, 1)
    assert.equal(rowsOf(w, 'changePlan').length, 0)
  }
  // (f) a failed execution recorded after the page was read: refused AFTER the bump, the bump rolled back with it.
  {
    const { w, proposal } = await base()
    const execution = await w.store.beginExecution({ ...w.scope, lane: 'small_apply', guard: GUARD, tokenRevision: 'r', planDigest: 'p', plannedCounts: {}, refreshBinding: { continuations: [] }, startedBy: PULLER })
    await finish(w, execution.id, 'failed')
    const snapshot = tablesSnapshot(w.db)
    await expectError(confirmPlan(w, { proposal }), { status: 409, code: CODES.RECOVERY_PENDING })
    assert.equal(w.bump.calls.length, 1, 'refused after the bump')
    assert.equal(tablesSnapshot(w.db), snapshot, 'rolled back')
  }
})

// ── CP-S05 ───────────────────────────────────────────────────────────────────────────────────────

test('CP-S05 a relationship content change: the relationship is re-stamped with the POST-CHANGE pair, revision + 1, unconsumed; a moved relationship refuses', async () => {
  const w = await world()
  const scenario = await relationshipScenario(w)
  const content = scenario.holds.filter((hold) => hold.kind === 'relationship_content_change')
  assert.equal(content.length, 1, `holds: ${scenario.holds.map((hold) => hold.kind)}`)
  const post = content[0].detail.postChange
  assert.ok(post && /^[0-9a-f]{64}$/.test(post.comparisonFingerprint) && /^[0-9a-f]{64}$/.test(post.evidenceFingerprint))
  await reconcile(w, scenario.holds)
  const before = rowsOf(w, 'continuation')[0]
  // A consumed revision (an execution stamped it): the re-stamp makes it unconsumed again.
  await w.db.updateRow(T.continuation, { executed_execution_id: 'exec_earlier' }, { id: before.id })
  const proposal = proposalOf(w)
  const records = proposal.records
  assert.ok(records.length >= 1 && records.every((record) => record.inContinuation === before.id))
  await confirmPlan(w, { proposal })
  const after = rowsOf(w, 'continuation')[0]
  assert.equal(after.revision, before.revision + 1)
  assert.equal(after.comparison_fingerprint, post.comparisonFingerprint)
  assert.equal(after.evidence_fingerprint, post.evidenceFingerprint)
  assert.equal(after.pairing_fingerprint, before.pairing_fingerprint, 'content only: the pairing is kept')
  assert.equal(after.executed_execution_id, null)
  assert.equal(after.status, 'active')
  assert.equal(after.confirmed_by, PULLER)
  assert.deepEqual(rowsOf(w, 'changePlan')[0].continuation_ids, [before.id])
  // A relationship that moved since the page (its revision bumped by another decision): refused, nothing persisted.
  const w2 = await world()
  const scenario2 = await relationshipScenario(w2)
  await reconcile(w2, scenario2.holds)
  const proposal2 = proposalOf(w2)
  const cont = rowsOf(w2, 'continuation')[0]
  await w2.db.updateRow(T.continuation, { status: 'needs_reconfirmation', status_reason: 'structure_changed' }, { id: cont.id })
  await expectError(confirmPlan(w2, { proposal: proposal2 }), { status: 409, code: CODES.CHANGE_PLAN_STALE, reason: 'continuation_moved' })
  assert.equal(rowsOf(w2, 'changePlan').length, 0)
})

// ── CP-S06 ───────────────────────────────────────────────────────────────────────────────────────

test('CP-S06 the combined confirm (candidate_content_differs): relationship + members + plan in ONE transaction with ONE bump, stamped with the post-change pair; a claim collision rolls everything back', async () => {
  const w = await world()
  const scenario = await candidateContentScenario()
  const candidate = scenario.holds.find((hold) => hold.kind === 'candidate_content_differs')
  assert.ok(candidate && candidate.detail.postChange, `holds: ${scenario.holds.map((hold) => hold.kind)}`)
  await reconcile(w, scenario.holds)
  const proposal = proposalOf(w)
  assert.equal(proposal.candidates.length, 1)
  const confirmed = await confirmPlan(w, { proposal })
  assert.equal(confirmed.createdContinuationIds.length, 1)
  assert.equal(w.bump.calls.length, 1, 'ONE bump for both inserts')
  const cont = rowsOf(w, 'continuation')[0]
  assert.equal(cont.status, 'active')
  assert.equal(cont.revision, 1)
  assert.equal(cont.comparison_fingerprint, candidate.detail.postChange.comparisonFingerprint)
  assert.equal(cont.evidence_fingerprint, candidate.detail.postChange.evidenceFingerprint)
  assert.notEqual(cont.comparison_fingerprint, candidate.comparisonFingerprint, 'never the candidate\'s CURRENT comparison (M-CMB1)')
  assert.equal(rowsOf(w, 'member').length, candidate.detail.pairs.length)
  const plan = rowsOf(w, 'changePlan')[0]
  assert.deepEqual(plan.continuation_ids, [cont.id])
  assert.ok(plan.record_set.every((record) => record.inContinuation === cont.id), 'the candidate\'s records are the new relationship\'s')
  const root = plan.record_set.find((record) => record.root === true)
  assert.ok(root.fields.totalQuantity && root.fields.rawQuantity, 'S-root rule: total AND raw')
  assert.equal(root.fields.rawQuantity.after, root.fields.totalQuantity.after, 'the root raw receives the derived root total')
  assert.equal(root.fields.rawQuantity.before, 10)
  // Missing / wrong candidate decisions are refused under the lock.
  const w2 = await world()
  await reconcile(w2, scenario.holds)
  const proposal2 = proposalOf(w2)
  await expectError(confirmPlan(w2, { proposal: { ...proposal2, candidates: [] } }), { status: 409, code: CODES.CHANGE_PLAN_STALE, reason: 'candidate_set' })
  await expectError(confirmPlan(w2, { proposal: { ...proposal2, candidates: [{ ...proposal2.candidates[0], candidateId: 'x'.repeat(64) }] } }), { status: 409, code: CODES.CHANGE_PLAN_STALE, reason: 'candidate' })
  // A claim collision (another relationship already claims the old root): 23505 => CONFIRM_CONFLICT, nothing persisted.
  const w3 = await world()
  await reconcile(w3, scenario.holds)
  const proposal3 = proposalOf(w3)
  const pairs = candidate.detail.pairs
  const blocker = { ...kit.clone(rowsOf(w, 'continuation')[0]), id: 'cont_blocker', new_root_key_digest: 'z'.repeat(64) }
  w3.db.tables.get(T.continuation).set(blocker.id, blocker)
  const snapshot = tablesSnapshot(w3.db)
  const refused = await expectError(confirmPlan(w3, { proposal: proposal3 }), { status: 409, code: CODES.CONFIRM_CONFLICT })
  assert.equal(refused.details.reason, 'claim_taken')
  assert.equal(tablesSnapshot(w3.db), snapshot)
  void pairs
})

// ── CP-S07 ───────────────────────────────────────────────────────────────────────────────────────

test('CP-S07 supersede, baseline carry and ABSORPTION (B1): a written change never escapes review — through a later confirm, a later write, a later invalidation or a later failure', async () => {
  // (a) a confirmed plan superseded by the next confirm (nothing written => nothing absorbed).
  {
    const w = await world()
    await reconcile(w, (await contentScenario()).holds)
    const first = await confirmPlan(w)
    await reconcile(w, (await contentScenario({ partCUsage: 7 })).holds)
    const second = await confirmPlan(w)
    const plans = rowsOf(w, 'changePlan')
    assert.equal(plans.find((plan) => plan.id === first.changePlanId).status, 'superseded')
    assert.equal(plans.find((plan) => plan.id === first.changePlanId).superseded_by, second.changePlanId)
    assert.equal(second.supersededCount, 1)
  }
  // (b) A written (R1 = PART-A material), then B confirmed for a change on R1 again AND R2: baselines carried from A;
  //     B written absorbs A's unreviewed field it does not rewrite.
  const w = await world()
  const sheet = await F.firstPullSheet()
  await reconcile(w, (await contentScenario({ sheet, partCUsage: 4 })).holds) // material only
  const a = await confirmPlan(w)
  const execA = await beginBound(w, a.changePlanId)
  await finish(w, execA.id)
  let plans = rowsOf(w, 'changePlan')
  const planA = plans.find((plan) => plan.id === a.changePlanId)
  assert.equal(planA.status, 'written')
  assert.equal(planA.written_content_digest, planA.planned_content_digest)
  // The sheet as A left it (R1's material written).
  const aRecord = planA.record_set[0]
  const sheetAfterA = sheet.map((row) => (pairing.recordRefOf(row) && pairing.recordRefOf(row).id === aRecord.recordId ? F.withRecordRef({ ...row, material: CHANGED_MATERIAL }, aRecord.recordId, 2) : row))
  // A's review is refused while a new change is open (C12) ...
  await reconcile(w, (await contentScenario({ sheet: sheetAfterA, partCUsage: 6, partAMaterial: CHANGED_MATERIAL })).holds, { computation: { sourceContentDigest: SRC_2 } })
  const current = planA.written_content_digest
  await expectError(w.store.completeChangeReview({ ...w.scope, changePlanId: a.changePlanId, reviewedBy: REVIEWER, echoDigest: current, currentContentDigest: current, conclusion: 'handled' }, { auditWithin: w.auditWithin }), { status: 409, code: CODES.CHANGE_REVIEW_BLOCKED, reason: 'hold_open' })
  // ... B confirmed for R2 (PART-C's usage): A stays WRITTEN (a confirm never supersedes a written plan).
  const b = await confirmPlan(w)
  plans = rowsOf(w, 'changePlan')
  assert.equal(plans.find((plan) => plan.id === a.changePlanId).status, 'written')
  // ... and while B awaits its update, A's review is refused (its baselines were carried into B).
  await expectError(w.store.completeChangeReview({ ...w.scope, changePlanId: a.changePlanId, reviewedBy: REVIEWER, echoDigest: current, currentContentDigest: current, conclusion: 'handled' }, { auditWithin: w.auditWithin }), { status: 409, code: CODES.CHANGE_REVIEW_BLOCKED, reason: 'change_plan_pending' })
  // B written: A superseded and absorbed.
  const execB = await beginBound(w, b.changePlanId)
  const finished = await finish(w, execB.id)
  assert.equal(finished.changePlan.status, 'written')
  assert.equal(finished.changePlan.absorbedPlans, 1)
  plans = rowsOf(w, 'changePlan')
  const finalA = plans.find((plan) => plan.id === a.changePlanId)
  const finalB = plans.find((plan) => plan.id === b.changePlanId)
  assert.equal(finalA.status, 'superseded')
  assert.equal(finalA.superseded_by, b.changePlanId)
  assert.equal(finalB.status, 'written')
  assert.deepEqual(finalB.absorbed_change_plan_ids, [a.changePlanId])
  const absorbed = finalB.record_set.find((record) => record.recordId === aRecord.recordId)
  assert.ok(absorbed, 'R1 is in B\'s record set')
  assert.deepEqual(absorbed.fields.material, { before: CHANGED_MATERIAL, after: CHANGED_MATERIAL, afterCanonical: CHANGED_MATERIAL, baseline: 'M-STEEL', reviewOnly: true }, 'review-only: the written value, against the last REVIEWED value')
  assert.equal(finalB.plan_fingerprint, b.changePlanId ? rowsOf(w, 'changePlan').find((plan) => plan.id === b.changePlanId).plan_fingerprint : null)
  assert.equal(finalB.written_content_digest, pairing.plannedContentDigestOf(finalB.record_set), 'the written digest covers the absorbed field too')
  assert.notEqual(finalB.written_content_digest, finalB.planned_content_digest)
  assert.equal(finalB.write_record_count, 1)
  assert.equal(finalB.record_count, 2)
  // The derived state: one pending review (B).
  const state = readProjectRefreshState({ ok: true, pilot: { enabled: true }, continuations: [], holds: [], state: storeModule.__internals.rowToState(stateRow(w)), executions: rowsOf(w, 'execution').map(storeModule.__internals.rowToExecution), changePlans: (await w.store.readGovernanceRows(w.scope)).changePlans, lock: FREE_LOCK })
  assert.equal(state.status, 'change_pending_review')
  assert.equal(state.counts.pendingReviews, 1)
})

test('CP-S07c the obligation is durable: a written plan stays written when the later plan is invalidated (source revert) or fails — the derived state stays 变更待复核', async () => {
  for (const outcome of ['invalidated', 'failed']) {
    const w = await world()
    const sheet = await F.firstPullSheet()
    await reconcile(w, (await contentScenario({ sheet, partCUsage: 4 })).holds)
    const a = await confirmPlan(w)
    const execA = await beginBound(w, a.changePlanId)
    await finish(w, execA.id)
    await reconcile(w, (await contentScenario({ partCUsage: 6, partAMaterial: CHANGED_MATERIAL })).holds, { computation: { sourceContentDigest: SRC_2 } })
    const b = await confirmPlan(w)
    if (outcome === 'invalidated') {
      // The R2 source reverts: the next computation finds no change => stale => B invalidated(source_changed).
      await reconcile(w, [], { changePlan: { id: b.changePlanId, verdict: 'stale' }, computation: { suspended: false } })
      assert.equal(rowsOf(w, 'changePlan').find((plan) => plan.id === b.changePlanId).status, 'invalidated')
    } else {
      const execB = await beginBound(w, b.changePlanId)
      await finish(w, execB.id, 'partial')
      const planB = rowsOf(w, 'changePlan').find((plan) => plan.id === b.changePlanId)
      assert.equal(planB.status, 'invalidated')
      assert.equal(planB.invalidated_reason, 'execution_failed')
      assert.equal(planB.execution_id, execB.id)
    }
    const planA = rowsOf(w, 'changePlan').find((plan) => plan.id === a.changePlanId)
    assert.equal(planA.status, 'written', `${outcome}: A's review obligation survives`)
    const consult = { ok: true, pilot: { enabled: true }, continuations: [], holds: openHolds(w), state: storeModule.__internals.rowToState(stateRow(w)), executions: rowsOf(w, 'execution').map(storeModule.__internals.rowToExecution), changePlans: (await w.store.readGovernanceRows(w.scope)).changePlans, lock: FREE_LOCK }
    const derived = readProjectRefreshState(consult)
    if (outcome === 'invalidated') assert.equal(derived.status, 'change_pending_review', 'export stays refused')
    else assert.equal(derived.status, 'failed_pending_recovery', 'the failed run dominates (step 6), the written plan still pending behind it')
    assert.equal(derived.counts.pendingReviews, 1)
  }
})

// ── CP-S08 ───────────────────────────────────────────────────────────────────────────────────────

test('CP-S08 the reconcile verdict under the state lock: stale => invalidated + audit on its handle; matches => kept; an invalidated / written plan => refused; a running bound execution => deferred; no audit hook => 501', async () => {
  const setup = async () => {
    const w = await world()
    await reconcile(w, (await contentScenario()).holds)
    const confirmed = await confirmPlan(w)
    w.audits.length = 0
    return { w, id: confirmed.changePlanId }
  }
  {
    const { w, id } = await setup()
    const result = await reconcile(w, [], { changePlan: { id, verdict: 'matches' }, computation: { suspended: false } })
    assert.equal(result.changePlan.status, 'confirmed')
    assert.equal(rowsOf(w, 'changePlan')[0].status, 'confirmed')
    assert.equal(w.audits.length, 0)
  }
  {
    const { w, id } = await setup()
    const scenario = await contentScenario({ partCUsage: 9 })
    const result = await reconcile(w, scenario.holds, { changePlan: { id, verdict: 'stale' } })
    assert.equal(result.changePlan.invalidated, true)
    const plan = rowsOf(w, 'changePlan')[0]
    assert.equal(plan.status, 'invalidated')
    assert.equal(plan.invalidated_reason, 'source_changed')
    assert.equal(w.audits.length, 1)
    assert.equal(w.audits[0].trx, w.db.lastTransactionHandle, 'the audit rides the reconcile\'s own transaction')
    assert.deepEqual(w.audits[0].event, { operation: 'change_plan_invalidated', changePlanId: id, reason: 'source_changed', lane: 'small_preview', recordCount: 2, generationToken: 'g_cps' })
    assert.equal(rowsOf(w, 'hold').filter((row) => row.status === 'open').length, scenario.holds.length, 'the computation\'s holds stand')
    // A second stale verdict on the invalidated plan: idempotent (no second audit row).
    await reconcile(w, scenario.holds, { changePlan: { id, verdict: 'stale' } })
    assert.equal(w.audits.length, 1)
    // A matches verdict on the invalidated plan: 409 CHANGE_PLAN_STALE plan_invalidated, nothing persisted.
    const snapshot = tablesSnapshot(w.db)
    await expectError(reconcile(w, [], { changePlan: { id, verdict: 'matches' }, computation: { suspended: false } }), { status: 409, code: CODES.CHANGE_PLAN_STALE, reason: 'plan_invalidated' })
    assert.equal(tablesSnapshot(w.db), snapshot)
  }
  {
    // A running execution bound to the plan: the stale verdict of a straddling computation is DEFERRED (B2).
    const { w, id } = await setup()
    await beginBound(w, id)
    const result = await reconcile(w, (await contentScenario({ partCUsage: 9 })).holds, { changePlan: { id, verdict: 'stale' } })
    assert.equal(result.changePlan.deferred, true)
    assert.equal(rowsOf(w, 'changePlan')[0].status, 'confirmed')
    assert.equal(w.audits.length, 0)
  }
  {
    // The finish committed P -> written before this computation's lock: STATE_MOVED, nothing persisted.
    const { w, id } = await setup()
    const execution = await beginBound(w, id)
    await finish(w, execution.id)
    const snapshot = tablesSnapshot(w.db)
    await expectError(reconcile(w, (await contentScenario({ partCUsage: 9 })).holds, { changePlan: { id, verdict: 'stale' } }), { status: 409, code: CODES.STATE_MOVED, reason: 'change_plan_moved' })
    assert.equal(tablesSnapshot(w.db), snapshot)
    await expectError(reconcile(w, [], { changePlan: { id, verdict: 'matches' }, computation: { suspended: false } }), { status: 409, code: CODES.CHANGE_PLAN_STALE, reason: 'plan_written' })
  }
  {
    // No audit hook: the invalidation is refused 501 by name — a plan never disappears unaudited.
    const { w, id } = await setup()
    const snapshot = tablesSnapshot(w.db)
    await expectError(reconcile(w, [], { changePlan: { id, verdict: 'stale' }, computation: { suspended: false } }, { auditWithin: null }), { status: 501, code: CODES.STORE_UNAVAILABLE, reason: 'invalidation_audit_missing' })
    assert.equal(tablesSnapshot(w.db), snapshot)
  }
  {
    // A CAS miss (a decision landed since the consult): nothing, the plan stays confirmed.
    const { w, id } = await setup()
    const observed = stateRow(w).decision_version - 1
    await expectError(w.store.reconcileHolds({ ...w.scope, decisionVersionObserved: observed, holds: [], computation: computation({ suspended: false }), changePlan: { id, verdict: 'stale' } }, { auditWithin: w.auditWithin }), { status: 409, code: CODES.STATE_MOVED })
    assert.equal(rowsOf(w, 'changePlan')[0].status, 'confirmed')
  }
  // A malformed verdict is a lane defect (500), refused before any statement.
  const { w, id } = await setup()
  await expectError(reconcile(w, [], { changePlan: { id, verdict: 'maybe' } }), { status: 500, code: CODES.INPUT_INVALID })
})

// ── CP-S09 ───────────────────────────────────────────────────────────────────────────────────────

test('CP-S09 the bound begin asserts the plan under the state lock; the finish marks it written (digest) or invalidated(execution_failed)', async () => {
  const setup = async () => {
    const w = await world()
    await reconcile(w, (await contentScenario()).holds)
    return { w, id: (await confirmPlan(w)).changePlanId }
  }
  {
    const { w, id } = await setup()
    w.db.log.length = 0
    const execution = await beginBound(w, id)
    const statements = statementsOf(w.db)
    assert.deepEqual(statements.slice(0, 3), ['selectOneForUpdate:refresh_state', 'selectOneForUpdate:change_plan', 'insertOne:refresh_execution'], 'state -> plan -> the execution insert, one transaction')
    assert.equal(rowsOf(w, 'execution')[0].refresh_binding.changePlanId, id)
    const done = await finish(w, execution.id)
    assert.equal(done.changePlan.status, 'written')
    const plan = rowsOf(w, 'changePlan')[0]
    assert.equal(plan.status, 'written')
    assert.equal(plan.execution_id, execution.id)
    assert.equal(plan.written_content_digest, plan.planned_content_digest)
    assert.ok(plan.written_at)
  }
  for (const status of ['partial', 'failed', 'aborted']) {
    const { w, id } = await setup()
    const execution = await beginBound(w, id)
    await finish(w, execution.id, status)
    const plan = rowsOf(w, 'changePlan')[0]
    assert.equal(plan.status, 'invalidated', status)
    assert.equal(plan.invalidated_reason, 'execution_failed')
    assert.equal(plan.execution_id, execution.id)
  }
  {
    // The plan invalidated before the begin: refused, no execution row (nothing written can follow).
    const { w, id } = await setup()
    await reconcile(w, [], { changePlan: { id, verdict: 'stale' }, computation: { suspended: false } })
    await expectError(beginBound(w, id), { status: 409, code: CODES.CHANGE_PLAN_STALE, reason: 'plan_invalidated' })
    assert.equal(rowsOf(w, 'execution').length, 0)
  }
  {
    // An unbound begin is the pre-PR-8 autocommit insert (no state lock, no plan read).
    const { w } = await setup()
    w.db.log.length = 0
    await w.store.beginExecution({ ...w.scope, lane: 'small_apply', guard: GUARD, tokenRevision: 'r', planDigest: 'p', plannedCounts: {}, refreshBinding: { continuations: [] }, startedBy: PULLER })
    assert.deepEqual(w.db.log.map(([method]) => method), ['insertOne'])
  }
})

// ── CP-S10 ───────────────────────────────────────────────────────────────────────────────────────

async function writtenWorld() {
  const w = await world()
  await reconcile(w, (await contentScenario()).holds)
  const { changePlanId } = await confirmPlan(w)
  const execution = await beginBound(w, changePlanId)
  await finish(w, execution.id)
  const plan = rowsOf(w, 'changePlan')[0]
  w.audits.length = 0
  return { w, plan }
}

function review(w, plan, extra = {}, options = {}) {
  const digest = plan.written_content_digest
  return w.store.completeChangeReview({ ...w.scope, changePlanId: plan.id, reviewedBy: REVIEWER, echoDigest: digest, currentContentDigest: digest, conclusion: 'handled', ...extra }, { auditWithin: w.auditWithin, ...options })
}

test('CP-S10 the review: digest-bound, no bump, decision_version + 1, the state\'s reviewed baseline; refused while anything else is open; rolled back on an audit / COMMIT failure', async () => {
  {
    const { w, plan } = await writtenWorld()
    const before = stateRow(w)
    const bumps = w.bump.calls.length
    const reviewed = await review(w, plan, { conclusion: 'handled_with_notes', notes: 'synthetic review note' })
    assert.equal(reviewed.status, 'reviewed')
    assert.equal(w.bump.calls.length, bumps, 'NO generation bump')
    const after = stateRow(w)
    assert.equal(after.decision_version, before.decision_version + 1)
    assert.equal(after.reviewed_content_digest, plan.written_content_digest)
    assert.equal(after.reviewed_by, REVIEWER)
    const row = rowsOf(w, 'changePlan')[0]
    assert.equal(row.status, 'reviewed')
    assert.equal(row.review_conclusion, 'handled_with_notes')
    assert.equal(row.review_notes, 'synthetic review note')
    assert.equal(row.reviewed_content_digest, plan.written_content_digest)
    assert.equal(w.audits.length, 1)
    assert.deepEqual(w.audits[0].event, { operation: 'change_review_completed', changePlanId: plan.id, recordCount: 2, conclusion: 'handled_with_notes', notesPresent: true, sameActorAsConfirm: false })
    assert.equal(JSON.stringify(w.audits[0].event).includes('synthetic review note'), false, 'the notes stay private')
    // Reviewed is terminal: a second review is STALE.
    await expectError(review(w, plan), { status: 409, code: CODES.CHANGE_REVIEW_STALE, reason: 'already_reviewed' })
    // The NEXT plan's baseline is this review's digest.
    await reconcile(w, (await contentScenario({ partCUsage: 8 })).holds, { computation: { sourceContentDigest: SRC_2 } })
    await confirmPlan(w)
    assert.equal(rowsOf(w, 'changePlan').find((entry) => entry.status === 'confirmed').review_baseline_digest, plan.written_content_digest)
  }
  {
    // The same principal may review what they confirmed (C11): a separate operation, traced.
    const { w, plan } = await writtenWorld()
    await review(w, plan, { reviewedBy: PULLER })
    assert.equal(w.audits[0].event.sameActorAsConfirm, true)
  }
  {
    const { w, plan } = await writtenWorld()
    await expectError(review(w, plan, { currentContentDigest: 'c'.repeat(64) }), { status: 409, code: CODES.CHANGE_REVIEW_STALE, reason: 'content_moved' })
    await expectError(review(w, plan, { echoDigest: 'e'.repeat(64), currentContentDigest: 'e'.repeat(64) }), { status: 409, code: CODES.CHANGE_REVIEW_STALE, reason: 'echo_moved' })
    // C12: another hold open.
    await reconcile(w, (await contentScenario({ partCUsage: 9 })).holds, { computation: { sourceContentDigest: SRC_2 } })
    await expectError(review(w, plan), { status: 409, code: CODES.CHANGE_REVIEW_BLOCKED, reason: 'hold_open' })
    assert.equal(rowsOf(w, 'changePlan')[0].status, 'written')
  }
  {
    // A failed execution recorded since: RECOVERY_PENDING (nothing reviewed).
    const { w, plan } = await writtenWorld()
    const execution = await w.store.beginExecution({ ...w.scope, lane: 'small_apply', guard: GUARD, tokenRevision: 'r', planDigest: 'p', plannedCounts: {}, refreshBinding: { continuations: [] }, startedBy: PULLER })
    await finish(w, execution.id, 'failed')
    await expectError(review(w, plan), { status: 409, code: CODES.RECOVERY_PENDING })
    assert.equal(rowsOf(w, 'changePlan')[0].status, 'written')
  }
  {
    // E09 / commit: an audit failure and a COMMIT-time failure both leave the plan written and the state unmoved.
    const { w, plan } = await writtenWorld()
    const snapshot = tablesSnapshot(w.db)
    await expectError(review(w, plan, {}, { auditWithin: async () => { throw Object.assign(new Error('audit down'), { code: '42501' }) } }), { status: 503, code: CODES.STORE_FAILED, reason: undefined })
    assert.equal(tablesSnapshot(w.db), snapshot)
    w.db.faults.commit = Object.assign(new Error('deferred constraint'), { code: '23514' })
    const refused = await expectError(review(w, plan), { status: 503, code: CODES.STORE_FAILED })
    assert.equal(refused.details.operation, 'commit')
    assert.equal(tablesSnapshot(w.db), snapshot)
  }
  {
    // The notes: control characters refused (400), handled_with_notes needs notes, an unknown conclusion 400.
    const { w, plan } = await writtenWorld()
    await expectError(review(w, plan, { notes: 'line\u0007break' }), { status: 400, code: CODES.INPUT_INVALID })
    await expectError(review(w, plan, { conclusion: 'handled_with_notes' }), { status: 400, code: CODES.INPUT_INVALID })
    await expectError(review(w, plan, { conclusion: 'approved' }), { status: 400, code: CODES.INPUT_INVALID })
    await expectError(review(w, plan, { notes: 'x'.repeat(2001) }), { status: 422, code: CODES.INPUT_INVALID })
  }
})

// ── CP-S11 ───────────────────────────────────────────────────────────────────────────────────────

test('CP-S11 E09 with the REAL lock on the same db: an audit failure rolls back the plan, the holds, the re-stamp AND the generation; a COMMIT failure is 503 commit with nothing persisted', async () => {
  const w = await world({ realLock: true })
  w.realLockBump = (trx, scopeKey, options) => w.lock.bumpGenerationWithin(trx, scopeKey, options)
  const scenario = await relationshipScenario(w)
  await reconcile(w, scenario.holds)
  const scopeKey = lockModule.sheetWriteScopeKey(SHEET)
  await w.lock.bumpGeneration(scopeKey, { reason: 'small_preview', tenantId: TENANT })
  const generationBefore = await w.lock.readGeneration(scopeKey)
  const proposal = proposalOf(w)
  const snapshot = tablesSnapshot(w.db)
  await expectError(confirmPlan(w, { proposal, hooks: { auditWithin: async () => { throw Object.assign(new Error('audit refused'), { code: '42501' }) } } }), { status: 503, code: CODES.STORE_FAILED })
  assert.equal(tablesSnapshot(w.db), snapshot, 'no plan, holds open, the relationship not re-stamped')
  assert.deepEqual(await w.lock.readGeneration(scopeKey), generationBefore, 'the in-transaction bump rolled back with it')
  w.db.faults.commit = Object.assign(new Error('deferred'), { code: '23514' })
  const refused = await expectError(confirmPlan(w, { proposal }), { status: 503, code: CODES.STORE_FAILED })
  assert.equal(refused.details.operation, 'commit')
  assert.equal(tablesSnapshot(w.db), snapshot)
  assert.deepEqual(await w.lock.readGeneration(scopeKey), generationBefore)
  // Then it commits, bumping under `change_plan_confirm`.
  await confirmPlan(w, { proposal })
  const generationAfter = await w.lock.readGeneration(scopeKey)
  assert.equal(generationAfter.generation, generationBefore.generation + 1)
  assert.equal((await w.lock.readState(scopeKey)).generationReason, 'change_plan_confirm')
})

// ── CP-S12 (M2) ──────────────────────────────────────────────────────────────────────────────────

test('CP-S12 (M2) a person filling a cell of a content-changed row re-keys nothing: same hold id and fingerprint, the volatile observations refreshed; the confirm built before the edit commits', async () => {
  const w = await world()
  const scenario = await contentScenario()
  await reconcile(w, scenario.holds)
  const proposal = proposalOf(w)
  const idsBefore = rowsOf(w, 'hold').map((row) => [row.id, row.fingerprint])
  // The same read after a person filled `notes` on both rows (record versions + 1, human presence moves).
  const edited = scenario.sheet.map((row) => {
    const ref = pairing.recordRefOf(row)
    return F.withRecordRef({ ...row, notes: 'synthetic person note' }, ref.id, ref.version + 1)
  })
  const again = await contentScenario({ sheet: edited })
  assert.deepEqual(again.holds.map((hold) => hold.fingerprint).sort(), scenario.holds.map((hold) => hold.fingerprint).sort(), 'the fingerprints do not move')
  await reconcile(w, again.holds)
  assert.deepEqual(rowsOf(w, 'hold').map((row) => [row.id, row.fingerprint]), idsBefore, 'kept, never superseded and re-opened')
  const refreshed = rowsOf(w, 'hold').find((row) => row.detail.fields && row.detail.fields.material)
  assert.equal(refreshed.detail.humanColumnsPresent.notes, true, 'the page shows the current presence')
  assert.equal(refreshed.detail.recordVersion, 2)
  await confirmPlan(w, { proposal })
  assert.equal(rowsOf(w, 'changePlan').length, 1)
  // The relationship / candidate bodies carry no version and no human observation at all.
  const w2 = await world()
  const rel = await relationshipScenario(w2)
  const body = JSON.stringify(rel.holds.find((hold) => hold.kind === 'relationship_content_change').detail)
  assert.equal(/recordVersion|humanColumnsPresent|"version"/.test(body), false)
})

// ── CP-S13 (M3) ──────────────────────────────────────────────────────────────────────────────────

test('CP-S13 (M3) a needs_reconfirmation relationship whose content changed: re-confirmable reason => content-class, the confirm re-activates it; otherwise reconfirm_not_admissible (no step-5 promise)', async () => {
  const w = await world()
  const scenario = await relationshipScenario(w, { statusOverride: { status: 'needs_reconfirmation', status_reason: 'evidence_changed' } })
  const hold = scenario.holds.find((entry) => entry.kind === 'relationship_reconfirm')
  assert.ok(hold, `holds: ${scenario.holds.map((entry) => entry.kind)}`)
  assert.equal(hold.detail.verdict, 'content_changed')
  assert.equal(hold.notConfirmableReason, 'needs_step5')
  assert.ok(hold.detail.postChange)
  assert.equal(pairing.isContentClassHold(hold), true)
  await reconcile(w, scenario.holds)
  await confirmPlan(w)
  const cont = rowsOf(w, 'continuation')[0]
  assert.equal(cont.status, 'active')
  assert.equal(cont.status_reason, null)
  assert.equal(cont.comparison_fingerprint, hold.detail.postChange.comparisonFingerprint)
  assert.equal(cont.source_scope_digest, F.SOURCE_IDENTITY.sourceScopeDigest)
  // A non-re-confirmable stored reason: the honest token, neither content- nor structure-class.
  const w2 = await world()
  const scenario2 = await relationshipScenario(w2, { statusOverride: { status: 'needs_reconfirmation', status_reason: 'demand_changed' } })
  const hold2 = scenario2.holds.find((entry) => entry.kind === 'relationship_reconfirm')
  assert.equal(hold2.detail.verdict, 'content_changed')
  assert.equal(hold2.notConfirmableReason, 'reconfirm_not_admissible')
  assert.equal(hold2.detail.postChange, undefined)
  assert.equal(pairing.isContentClassHold(hold2), false)
  assert.equal(pairing.isStructureClassHold(hold2), false)
})

// ── CP-S14 (review fix N1) ───────────────────────────────────────────────────────────────────────

test('CP-S14 (N1) the combined confirm re-decides the pilot marker on its OWN transaction handle under the state lock: cleared since the consult / on another sheet => 409 NOT_PILOT, unwired => 501, nothing persisted; a content-only confirm never reads it', async () => {
  const scenario = await candidateContentScenario()
  // (a) the marker cleared between the route's consult and this transaction (V8PG-09): refused, nothing written.
  const w = await world()
  await reconcile(w, scenario.holds)
  const proposal = proposalOf(w)
  assert.equal(proposal.candidates.length, 1)
  w.setRegistry({ pilot_enabled_at: null, pilot_enabled_by: null, pilot_readiness_version: null })
  const before = tablesSnapshot(w.db)
  w.db.log.length = 0
  const cleared = await expectError(confirmPlan(w, { proposal }), { status: 409, code: CODES.NOT_PILOT })
  assert.deepEqual(cleared.details, { decidedUnderLock: true, partial: false })
  assert.equal(tablesSnapshot(w.db), before, 'nothing persisted')
  assert.equal(w.bump.calls.length, 0, 'refused before the bump')
  assert.deepEqual(w.pilotReads, [false])
  // The read ran ON the confirm's transaction handle, AFTER the state-row lock.
  const statements = statementsOf(w.db)
  const stateLock = statements.indexOf('selectOneForUpdate:refresh_state')
  const pilotRead = statements.indexOf('selectOne:project_target')
  assert.ok(stateLock >= 0 && pilotRead > stateLock, statements.join(' > '))
  // (b) a pilot row registered on ANOTHER sheet is not this sheet's pilot.
  w.setRegistry({ pilot_enabled_at: new Date('2026-10-24T00:00:00.000Z'), pilot_enabled_by: 'u_admin', pilot_readiness_version: 1, sheet_id: 'sheet_cps_elsewhere' })
  await expectError(confirmPlan(w, { proposal }), { status: 409, code: CODES.NOT_PILOT })
  assert.equal(tablesSnapshot(w.db), before)
  // (c) unwired: a combined confirm without the in-transaction read is 501 by name, never "pilot".
  w.setRegistry({ sheet_id: SHEET })
  await expectError(confirmPlan(w, { proposal, hooks: { pilotWithin: undefined } }), { status: 501, code: CODES.STORE_UNAVAILABLE, reason: 'pilot_read_within' })
  assert.equal(tablesSnapshot(w.db), before)
  // (d) the marker back: the same confirm commits (one bump), the read answered `enabled`.
  const done = await confirmPlan(w, { proposal })
  assert.equal(done.createdContinuationIds.length, 1)
  assert.equal(w.bump.calls.length, 1)
  assert.deepEqual(w.pilotReads, [false, false, true])
  // (e) a content-only plan (no candidate) is not a pilot decision: the marker is never read, and a cleared one is irrelevant.
  const w2 = await world()
  const content = await contentScenario()
  await reconcile(w2, content.holds)
  w2.setRegistry({ pilot_enabled_at: null, pilot_enabled_by: null, pilot_readiness_version: null })
  await confirmPlan(w2)
  assert.deepEqual(w2.pilotReads, [])
  assert.equal(rowsOf(w2, 'changePlan').length, 1)
})

// ── CP-S15 (review fix N3) ───────────────────────────────────────────────────────────────────────

function expectedCellsOf(record) {
  return Object.fromEntries(Object.entries(record.fields).map(([fieldId, cell]) => [fieldId, { after: cell.after, afterCanonical: cell.afterCanonical }]))
}

test('CP-S15 (N3, C06) the consult carries the content the sheet must still hold: the WRITTEN plan\'s cells; after its review the reviewed cells (round 2: the register the review wrote — a decoy reviewed plan row is never read); a later written plan wins per field; private (never in the values-free summaries); none without a review / write', async () => {
  const fresh = await world()
  assert.deepEqual((await fresh.store.readGovernanceRows(fresh.scope)).expectedContent, [])
  const { w, plan } = await writtenWorld()
  const ids = plan.record_set.map((record) => record.recordId).sort()
  // (a) a written plan awaiting review: exactly its cells.
  let rows = await w.store.readGovernanceRows(w.scope)
  assert.deepEqual(rows.expectedContent.map((entry) => entry.recordId), ids)
  for (const entry of rows.expectedContent) {
    const record = plan.record_set.find((candidate) => candidate.recordId === entry.recordId)
    assert.equal(entry.key, record.key)
    assert.deepEqual(entry.fields, expectedCellsOf(record))
  }
  assert.equal(JSON.stringify(rows.changePlans).includes(CHANGED_MATERIAL), false, 'the summaries stay values-free')
  assert.equal(JSON.stringify(rows.expectedContent).includes(CHANGED_MATERIAL), true, 'the expected content is the one private projection')
  // (b) reviewed: exactly the cells that review bound (round 2: the reviewed-cell register it wrote) — a decoy reviewed
  // plan row of ANOTHER digest at the SAME reviewed_at (the frozen clock of this kit) is never taken.
  await review(w, plan)
  const reviewedRow = rowsOf(w, 'changePlan').find((row) => row.id === plan.id)
  const decoy = { ...kit.clone(reviewedRow), id: 'chp_zzzz_decoy', reviewed_content_digest: 'e'.repeat(64), record_set: reviewedRow.record_set.map((record) => ({ ...record, fields: Object.fromEntries(Object.entries(record.fields).map(([fieldId, cell]) => [fieldId, { ...cell, after: 'M-DECOY', afterCanonical: 'M-DECOY' }])) })) }
  w.db.tables.get(T.changePlan).set(decoy.id, decoy)
  rows = await w.store.readGovernanceRows(w.scope)
  assert.deepEqual(rows.expectedContent.map((entry) => entry.recordId), ids)
  for (const entry of rows.expectedContent) assert.deepEqual(entry.fields, expectedCellsOf(reviewedRow.record_set.find((record) => record.recordId === entry.recordId)))
  assert.equal(JSON.stringify(rows.expectedContent).includes('M-DECOY'), false)
  w.db.tables.get(T.changePlan).delete(decoy.id)
  // (c) a later change confirmed and WRITTEN: the written plan wins per field over the review.
  await reconcile(w, (await contentScenario({ partCUsage: 8 })).holds, { computation: { sourceContentDigest: SRC_2 } })
  const second = await confirmPlan(w)
  const execution = await beginBound(w, second.changePlanId)
  await finish(w, execution.id)
  const secondRow = rowsOf(w, 'changePlan').find((row) => row.id === second.changePlanId)
  assert.equal(secondRow.status, 'written')
  rows = await w.store.readGovernanceRows(w.scope)
  for (const record of secondRow.record_set) {
    const entry = rows.expectedContent.find((candidate) => candidate.recordId === record.recordId)
    assert.ok(entry, record.recordId)
    for (const [fieldId, cell] of Object.entries(expectedCellsOf(record))) assert.deepEqual(entry.fields[fieldId], cell, `${fieldId}: the written plan wins`)
  }
  // The governance consult hands it through (and refuses a store answer without it).
  const governance = governanceModule.createStockPreparationRefreshGovernance({
    continuationStore: w.store,
    projectTargetStore: { getPilotState: async () => null, getPilotStateBySheetId: async () => null },
    projectWriteLock: { readState: async () => FREE_LOCK.state, readGeneration: async () => FREE_LOCK.generation },
  })
  assert.deepEqual((await governance.consult(w.scope)).expectedContent.map((entry) => entry.recordId), rows.expectedContent.map((entry) => entry.recordId))
  const stripped = governanceModule.createStockPreparationRefreshGovernance({
    continuationStore: { readGovernanceRows: async (input, options) => { const answer = await w.store.readGovernanceRows(input, options); const { expectedContent: omitted, ...rest } = answer; void omitted; return rest } },
    projectTargetStore: { getPilotState: async () => null, getPilotStateBySheetId: async () => null },
    projectWriteLock: { readState: async () => FREE_LOCK.state, readGeneration: async () => FREE_LOCK.generation },
  })
  await expectError(stripped.consult(w.scope), { status: 503, code: 'STOCK_PREP_REFRESH_STORE_FAILED' })
})

// ── CP-S16 (review fix N3-b, round 2) ────────────────────────────────────────────────────────────

const registerRows = (w) => rowsOf(w, 'reviewedCell').slice().sort((left, right) => `${left.record_key}|${left.field_id}`.localeCompare(`${right.record_key}|${right.field_id}`))
const consultReads = (w) => w.db.statements('trx.').filter(([method, table]) => method === 'trx.select' && table === T.reviewedCell).length

test('CP-S16 (N3-b, C06; delta probe V8D-05) the REVIEWED-CELL REGISTER: the review writes one row per reviewed (key, field) in its own transaction, review-only cells included; a LATER review overwrites only its own cells, so a cell an EARLIER plan reviewed stays in the consult\'s expected content; an invalidated plan removes nothing (no path deletes a cell); the consult reads it only after a review; private; a foreign row refuses', async () => {
  const { w, plan } = await writtenWorld()
  const planCells = plan.record_set.flatMap((record) => Object.keys(record.fields).map((fieldId) => `${record.key}|${fieldId}`)).sort()
  // (a) before any review: the register is empty and the consult does not read it (the state row says no review).
  w.db.log.length = 0
  await w.store.readGovernanceRows(w.scope)
  assert.equal(consultReads(w), 0, 'no register read before a review')
  assert.equal(rowsOf(w, 'reviewedCell').length, 0)
  // (b) the review writes every cell of the plan's record set, on its transaction handle, after the plan row and before
  //     the state row (the read gate) and the audit.
  w.db.log.length = 0
  await review(w, plan)
  const order = statementsOf(w.db)
  const upserts = order.filter((entry) => entry === 'upsertOne:reviewed_cell')
  assert.equal(upserts.length, planCells.length, order.join(' > '))
  assert.ok(order.indexOf('upsertOne:reviewed_cell') > order.indexOf('updateRow:change_plan'), order.join(' > '))
  assert.ok(order.lastIndexOf('upsertOne:reviewed_cell') < order.indexOf('updateRow:refresh_state'), order.join(' > '))
  const first = registerRows(w)
  assert.deepEqual(first.map((row) => `${row.record_key}|${row.field_id}`), planCells)
  for (const row of first) {
    const record = plan.record_set.find((entry) => entry.key === row.record_key)
    assert.equal(row.change_plan_id, plan.id)
    assert.equal(row.record_id, record.recordId)
    assert.equal(row.tenant_id, TENANT)
    assert.deepEqual(row.reviewed_cell, { after: record.fields[row.field_id].after, afterCanonical: record.fields[row.field_id].afterCanonical })
    assert.equal(row.record_key_digest, pairing.__internals.subjectDigest(row.record_key), 'the unique key carries the key\'s digest')
  }
  // The consult now reads it (once, in its snapshot) and hands every cell to the planner.
  w.db.log.length = 0
  let rows = await w.store.readGovernanceRows(w.scope)
  assert.equal(consultReads(w), 1)
  assert.deepEqual(rows.expectedContent.flatMap((entry) => Object.keys(entry.fields).map((fieldId) => `${entry.key}|${fieldId}`)).sort(), planCells)
  const partA = plan.record_set.find((record) => Object.prototype.hasOwnProperty.call(record.fields, 'material'))
  assert.ok(partA, 'plan 1 reviewed PART-A\'s material')
  // (c) V8D-05: a LATER plan that changes only PART-C is confirmed, written and reviewed. Its cells overwrite PART-C's
  //     entries; PART-A's material — reviewed by the EARLIER plan only — stays in the register and in the expected content.
  await reconcile(w, (await contentScenario({ partAMaterial: 'M-STEEL', partCUsage: 8 })).holds, { computation: { sourceContentDigest: SRC_2 } })
  const second = await confirmPlan(w)
  const secondExecution = await beginBound(w, second.changePlanId)
  await finish(w, secondExecution.id)
  const secondRow = rowsOf(w, 'changePlan').find((row) => row.id === second.changePlanId)
  assert.equal(secondRow.status, 'written')
  assert.equal(secondRow.record_set.some((record) => record.recordId === partA.recordId && Object.prototype.hasOwnProperty.call(record.fields, 'material')), false, 'plan 2 does not carry PART-A\'s material')
  await review(w, secondRow)
  const after = registerRows(w)
  const materialCell = after.find((row) => row.record_key === partA.key && row.field_id === 'material')
  assert.ok(materialCell, 'the earlier review\'s cell survives the later review')
  assert.equal(materialCell.change_plan_id, plan.id)
  assert.deepEqual(materialCell.reviewed_cell, { after: CHANGED_MATERIAL, afterCanonical: partA.fields.material.afterCanonical })
  for (const record of secondRow.record_set) {
    for (const fieldId of Object.keys(record.fields)) {
      const cell = after.find((row) => row.record_key === record.key && row.field_id === fieldId)
      assert.equal(cell.change_plan_id, second.changePlanId, `${fieldId}: the later review overwrote its own cell`)
      assert.deepEqual(cell.reviewed_cell.afterCanonical, record.fields[fieldId].afterCanonical)
    }
  }
  assert.equal(new Set(after.map((row) => `${row.record_key}|${row.field_id}`)).size, after.length, 'one row per (key, field)')
  rows = await w.store.readGovernanceRows(w.scope)
  const entryA = rows.expectedContent.find((entry) => entry.key === partA.key)
  assert.ok(entryA && entryA.fields.material, 'the consult still protects the cell the earlier plan reviewed')
  assert.equal(entryA.fields.material.after, CHANGED_MATERIAL)
  // (d) an INVALIDATED plan (a confirm whose source then moved) and the plans it never wrote remove nothing.
  const snapshotBefore = JSON.stringify(registerRows(w))
  await reconcile(w, (await contentScenario({ partAMaterial: 'M-ANOTHER', partCUsage: 8 })).holds, { computation: { sourceContentDigest: 'src_cps_3' } })
  const third = await confirmPlan(w)
  await reconcile(w, (await contentScenario({ partAMaterial: 'M-YET-ANOTHER', partCUsage: 8 })).holds, { computation: { sourceContentDigest: 'src_cps_4' }, changePlan: { id: third.changePlanId, verdict: 'stale' } })
  assert.equal(rowsOf(w, 'changePlan').find((row) => row.id === third.changePlanId).status, 'invalidated')
  assert.equal(JSON.stringify(registerRows(w)), snapshotBefore, 'an invalidated plan removes no reviewed cell')
  // (e) a register row of ANOTHER tenant under this sheet + project is refused (never merged).
  const foreign = { ...kit.clone(after[0]), id: 'rcell_foreign', tenant_id: 'tenant_cps_other', record_key_digest: 'f'.repeat(64) }
  w.db.tables.get(T.reviewedCell).set(foreign.id, foreign)
  await expectError(w.store.readGovernanceRows(w.scope), { status: 409, code: CODES.TENANT_MISMATCH })
  w.db.tables.get(T.reviewedCell).delete(foreign.id)
  // (f) private: the values-free summaries never carry a reviewed value; the expected content is the one projection.
  rows = await w.store.readGovernanceRows(w.scope)
  assert.equal(JSON.stringify(rows.changePlans).includes(CHANGED_MATERIAL), false)
  assert.equal(JSON.stringify(rows.expectedContent).includes(CHANGED_MATERIAL), true)
  // (g) a review-only (absorbed, B1) field is a reviewed cell too: the review bound it; a record the confirm could not
  //     have written (no id / key) is not.
  const cells = storeModule.__internals.reviewedCellsOf({ record_set: [
    { recordId: 'rec_cps_x', key: '{"k":"x"}', fields: { material: { before: 'a', after: 'b', afterCanonical: 'b' }, totalQuantity: { before: 1, after: 2, afterCanonical: 2, baseline: 1, reviewOnly: true } } },
    { recordId: '', key: '{"k":"y"}', fields: { material: { before: 'a', after: 'b', afterCanonical: 'b' } } },
  ] })
  assert.deepEqual(cells.map((cell) => `${cell.key}|${cell.fieldId}`).sort(), ['{"k":"x"}|material', '{"k":"x"}|totalQuantity'])
})

test('CP-S16b (N3-b) the register read has a CEILING of 100000 rows: exactly 100000 reviewed cells are read whole; one more makes the consult unreadable (503 STORE_FAILED row_cap, read_reviewed_cells), never a truncated "reviewed" answer', async () => {
  const w = await world()
  // A state row that says a review happened (only a review writes `reviewed_content_digest`), so the consult reads the register.
  await w.db.insertOne(T.state, { id: 'rst_cps_cap', tenant_id: TENANT, sheet_id: SHEET, project_no: F.PROJECT_NO, write_scope_key: 'spw2:x', governed_since: w.clock.now(), reviewed_content_digest: 'd'.repeat(64) })
  const register = w.db.tables.get(T.reviewedCell)
  const at = w.clock.now()
  const cellRow = (i) => {
    const id = `rcell_cap_${String(i).padStart(6, '0')}`
    const recordKey = `{"k":"cap_${i}"}`
    return { id, tenant_id: TENANT, sheet_id: SHEET, project_no: F.PROJECT_NO, record_key: recordKey, record_key_digest: pairing.__internals.subjectDigest(recordKey), field_id: 'material', record_id: `rec_cap_${i}`, reviewed_cell: { after: 'x', afterCanonical: 'x' }, change_plan_id: 'chp_cap', reviewed_at: at, created_at: at, updated_at: at }
  }
  const CEILING = 100000
  // Inserted in id order (the read's ORDER BY), straight into the kit table: the bound is what is under test, not the writer.
  for (let i = 0; i < CEILING; i += 1) {
    const row = cellRow(i)
    register.set(row.id, row)
  }
  assert.equal(new Set(Array.from(register.values(), (row) => row.record_key_digest)).size, CEILING, 'distinct record_key_digest per row')
  // (a) at the ceiling: the consult reads every row (paged) and hands every cell to the planner.
  const read = await w.store.readGovernanceRows(w.scope)
  assert.equal(read.expectedContent.length, CEILING)
  // (b) one row above it: refused by name, never a partial register.
  const extra = cellRow(CEILING)
  register.set(extra.id, extra)
  const capped = await expectError(w.store.readGovernanceRows(w.scope), { status: 503, code: CODES.STORE_FAILED, reason: 'row_cap' })
  assert.equal(capped.details.operation, 'read_reviewed_cells')
  assert.equal(capped.details.ceiling, CEILING)
})

// ── CP-S17 (review fix N1-b, round 2) ────────────────────────────────────────────────────────────

test('CP-S17 (N1-b) the PLAIN continuation confirm (a continuation_candidate hold, PR-4) re-decides the pilot marker on its OWN transaction handle under the state lock: cleared since the consult / on another sheet => 409 NOT_PILOT, nothing persisted, no bump; unwired => 501 before any statement; the marker back => it commits', async () => {
  const fixture = await kit.candidateHoldFixture()
  const w = await world()
  await reconcile(w, [fixture.hold])
  const row = rowsOf(w, 'hold').find((entry) => entry.fingerprint === fixture.hold.fingerprint && entry.status === 'open')
  assert.ok(row && row.kind === 'continuation_candidate')
  const confirmPlain = (hooks = {}) => w.store.confirmContinuation({ ...w.scope, holdId: row.id, echo: kit.echoOf(fixture.hold), basis: { kind: 'puller_confirmed_same_demand' }, confirmedBy: PULLER, sourceIdentity: F.SOURCE_IDENTITY }, { bumpWithin: w.bump.bumpWithin, auditWithin: w.auditWithin, pilotWithin: w.pilotWithin, ...hooks })
  // (a) the marker cleared between the route's consult and this transaction: refused under the lock, nothing written.
  w.setRegistry({ pilot_enabled_at: null, pilot_enabled_by: null, pilot_readiness_version: null })
  const before = tablesSnapshot(w.db)
  w.db.log.length = 0
  const cleared = await expectError(confirmPlain(), { status: 409, code: CODES.NOT_PILOT })
  assert.deepEqual(cleared.details, { decidedUnderLock: true, partial: false })
  assert.equal(tablesSnapshot(w.db), before, 'nothing persisted')
  assert.equal(w.bump.calls.length, 0, 'refused before the bump')
  assert.deepEqual(w.pilotReads, [false])
  // The read ran ON the confirm's transaction handle, after the state-row lock and the hold re-read, before any write.
  const statements = statementsOf(w.db)
  const stateLock = statements.indexOf('selectOneForUpdate:refresh_state')
  const pilotRead = statements.indexOf('selectOne:project_target')
  assert.ok(stateLock >= 0 && pilotRead > stateLock, statements.join(' > '))
  assert.ok(statements.indexOf('selectOne:refresh_hold') < pilotRead, statements.join(' > '))
  assert.equal(statements.some((entry) => /^(insertOne|insertMany|updateRow|upsertOne):/.test(entry) && entry !== 'upsertOne:refresh_state'), false, statements.join(' > '))
  // (b) a pilot row registered on ANOTHER sheet is not this sheet's pilot.
  w.setRegistry({ pilot_enabled_at: new Date('2026-10-24T00:00:00.000Z'), pilot_enabled_by: 'u_admin', pilot_readiness_version: 1, sheet_id: 'sheet_cps_elsewhere' })
  await expectError(confirmPlain(), { status: 409, code: CODES.NOT_PILOT })
  assert.equal(tablesSnapshot(w.db), before)
  // (c) unwired: refused 501 by name BEFORE any statement (no transaction is opened).
  w.setRegistry({ sheet_id: SHEET })
  w.db.log.length = 0
  await expectError(confirmPlain({ pilotWithin: undefined }), { status: 501, code: CODES.STORE_UNAVAILABLE, reason: 'pilot_read_within' })
  assert.equal(w.db.log.length, 0, 'no statement')
  assert.equal(tablesSnapshot(w.db), before)
  // (d) the marker back: the same confirm commits (one bump, one relationship), the read answered `enabled`.
  const done = await confirmPlain()
  assert.ok(done.continuationId)
  assert.equal(w.bump.calls.length, 1)
  assert.equal(rowsOf(w, 'continuation').length, 1)
  assert.deepEqual(w.pilotReads, [false, false, true])
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-change-plan-store.test.cjs', tests)
