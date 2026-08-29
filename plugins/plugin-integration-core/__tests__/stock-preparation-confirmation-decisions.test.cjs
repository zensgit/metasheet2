'use strict'

// B-stage confirmation-decision LEDGER tests (first cut: duplicate_expanded_key
// x keep_multiple_rows ONLY), structured on the HG v1.2 §15.2 acceptance
// matrix. Guards, each RED-witnessed by mutation (see the landing commit body
// for the mutation table):
//   A-01 same-fingerprint reconcile replay is idempotent (no row growth)
//   A-02 fingerprint change supersedes the live row; the OLD confirmation does
//        NOT clear the NEW conflict
//   A-03 out-of-scope conflict classes / unknown or unimplemented actions are
//        refused with fixed codes; canonical/external writes stay at ZERO
//   A-04 two INDEPENDENT reconcilers (separate module instances over one
//        shared substrate) end with exactly ONE active decision row; the loser
//        gets the fixed conflict code and has written nothing
//   G1   the ledger holds NO canonical-sheet write capability (structural + runtime)
//   G3   a stale confirmation (different source revision) never downgrades a hold
//   G4   only a CONFIRMED keep_multiple_rows decision downgrades; accept_current is inert
//   G7   an unregistered / malformed / stale confirm is refused
//   G8   the queue endpoint emits NO source cell values (seeded-marker negative control)
//   M77  migration 077 defines the DB-level lease uniqueness the module leans on
//   W4a  A→B→A fingerprint RETURN reopens the superseded row (human decision
//        cleared, stale intermediate pending superseded in the same run) — no
//        permanent wedge
//   W4b  a conflict that vanished from the plan is closed by the orphan sweep
//        (pending only; confirmed orphans stay untouched)
//   W4c  lease renew is CAS-guarded; an overtaken holder ABORTS mid-run with
//        CONFIRMATION_DECISION_RECONCILE_LEASE_LOST and no duplicate active
//        rows result

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const MODULE_PATH = path.join(__dirname, '..', 'lib', 'stock-preparation-confirmation-decisions.cjs')
const MIGRATION_077_PATH = path.join(__dirname, '..', '..', '..', 'packages', 'core-backend', 'migrations', '077_create_integration_stock_prep_confirmation_reconcile_lease.sql')
const {
  OBJECT_ID,
  FIRST_CUT_CONFLICT_TYPE,
  STATUSES,
  RESOLUTION_ACTIONS,
  RECONCILE_LEASE_TABLE,
  StockPreparationConfirmationDecisionError,
  createConfirmationDecisionReconcileLease,
  inspectConfirmationDecisionTarget,
  ensureConfirmationDecisionTarget,
  deriveDecisionCandidates,
  reconcileConfirmationDecisions,
  listConfirmationDecisions,
  confirmConfirmationDecision,
  loadConfirmedDuplicatePolicyReview,
  __internals: ledgerInternals,
} = require(MODULE_PATH)
const {
  makeFakeProvisioning,
  makeStrictRecordsApi,
  physicalRow,
  logicalData,
} = require(path.join(__dirname, 'fixtures', 'stock-preparation-multitable-fakes.cjs'))
const {
  PLM_STOCK_PREPARATION_ACTION_ID,
  dryRunStockPreparationAction,
  prepareStockPreparationConfirmationDecisions,
  normalizeStockPreparationActionConfig,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-table-actions.cjs'))
const {
  ANONYMOUS_HOLD_IDENTITY_PREFIX,
  planStockPreparationConflicts,
  __internals: plannerInternals,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-conflict-planner.cjs'))

const STAGING = 'tenant-a:integration-core'
const LEDGER_SHEET = 'sheet_confirmation_decisions'
// Marker that must NEVER cross the values-free queue surface. It is seeded into
// value-bearing ledger cells below and asserted absent from every response.
const LEAK_MARKER = 'VALUES-LEAK-CANARY-9c1'
const ACTIVE_STATUSES = [STATUSES.PENDING, STATUSES.CONFIRMED]

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

// A fake of the SCOPED SQL helper with genuine single-statement atomicity: each
// method is synchronous inside (no awaits), exactly like one SQL statement, and
// insertOne enforces the PRIMARY KEY on scope_key the way Postgres does. This
// is the shared "database" both independent reconcilers in A-04 talk to.
function makeFakeLeaseDb() {
  const rows = new Map()
  function assertLeaseTable(table) {
    assert.equal(table, RECONCILE_LEASE_TABLE, `lease store must only touch ${RECONCILE_LEASE_TABLE}, saw ${table}`)
  }
  return {
    rows,
    async insertOne(table, row) {
      assertLeaseTable(table)
      if (rows.has(row.scope_key)) {
        const error = new Error(`duplicate key value violates unique constraint "${table}_pkey"`)
        error.code = '23505'
        throw error
      }
      rows.set(row.scope_key, { ...row })
      return [{ ...row }]
    },
    async selectOne(table, where) {
      assertLeaseTable(table)
      const row = rows.get(where.scope_key)
      return row ? { ...row } : null
    },
    async updateRow(table, set, where) {
      assertLeaseTable(table)
      const row = rows.get(where.scope_key)
      if (!row || row.lease_id !== where.lease_id) return []
      Object.assign(row, set)
      return [{ ...row }]
    },
    async deleteRows(table, where) {
      assertLeaseTable(table)
      const row = rows.get(where.scope_key)
      if (!row || row.lease_id !== where.lease_id) return []
      rows.delete(where.scope_key)
      return [{ ...row }]
    },
  }
}

function ledgerEnv({ rows = [], leaseDb } = {}) {
  const provisioning = makeFakeProvisioning({
    stagingProjectId: STAGING,
    sheetIdByObjectId: { [OBJECT_ID]: LEDGER_SHEET },
  })
  const records = makeStrictRecordsApi({
    stagingProjectId: STAGING,
    objectIdBySheetId: { [LEDGER_SHEET]: OBJECT_ID },
    rowsBySheet: { [LEDGER_SHEET]: rows },
  })
  const lease = createConfirmationDecisionReconcileLease({ db: leaseDb || makeFakeLeaseDb() })
  return { provisioning, records, lease }
}

function seedLedgerRow(logical, id) {
  const row = physicalRow(STAGING, OBJECT_ID, logical, id)
  row.sheetId = LEDGER_SHEET
  return row
}

function ledgerRows(records) {
  return records.rows(LEDGER_SHEET).map((row) => ({ id: row.id, data: logicalData(STAGING, OBJECT_ID, row.data) }))
}

function duplicateHold(key, details = { count: 2 }) {
  return {
    decision: 'manual_confirm',
    idempotencyKey: key,
    conflictSummary: { type: FIRST_CUT_CONFLICT_TYPE, ...details },
    changedFields: [],
    source: 'expanded_rows',
  }
}

function planOf(decisions) {
  return { decisions }
}

function scopedCall(env, extra = {}) {
  return {
    recordsApi: env.records,
    provisioning: env.provisioning,
    targetProjectId: STAGING,
    permission: 'admin',
    reconcileLease: env.lease,
    ...extra,
  }
}

async function rejectsWithCode(promiseFactory, code, message) {
  await assert.rejects(promiseFactory, (error) => {
    assert.ok(
      error instanceof StockPreparationConfirmationDecisionError,
      `${message}: expected StockPreparationConfirmationDecisionError, got ${error && error.name}: ${error && error.message}`,
    )
    assert.equal(error.code, code, `${message}: expected ${code}, got ${error.code}`)
    return true
  })
}

// ── G1: no canonical-sheet write capability ─────────────────────────────────

async function testLedgerHoldsNoCanonicalWriteCapability() {
  const src = fs.readFileSync(MODULE_PATH, 'utf8')

  // Structural half. The canonical stock-preparation object must be unnameable
  // from this module: no canonical identifier, no main-table template import,
  // no apply-writer import — in code OR comments.
  assert.equal(src.includes('plm_stock_preparation_main'), false, 'module must not name the canonical objectId')
  assert.equal(src.includes('STOCK_PREPARATION_MAIN_TABLE_TEMPLATE'), false, 'module must not import the canonical template')
  assert.equal(src.includes('apply-writer'), false, 'module must not reach the apply writer')

  // Every objectId this module ever passes anywhere is the ledger's own.
  const objectIdUses = [...src.matchAll(/objectId:\s*([A-Za-z0-9_.'"`]+)/g)].map((match) => match[1])
  assert.ok(objectIdUses.length >= 3, `expected several objectId uses, saw ${objectIdUses.length}`)
  for (const use of objectIdUses) {
    assert.equal(use, 'OBJECT_ID', `every objectId use must be the ledger's own constant, saw: ${use}`)
  }
  // ... and the scoped records API is built with that pinned target.
  assert.ok(
    /createTargetScopedRecordsApi\(recordsApi, \{ sheetId, objectId: OBJECT_ID \}/.test(src),
    'the one records-API constructor must pin the ledger target',
  )

  // Runtime half: the scoped API the ledger builds refuses to leave its sheet.
  const env = ledgerEnv()
  const scoped = await ledgerInternals.resolveScopedLedger(env.records, env.provisioning, STAGING, ['queryRecords', 'createRecord', 'patchRecord'])
  await assert.rejects(
    () => scoped.createRecord({ sheetId: 'sheet_stock', data: { decisionId: 'x' } }),
    /leave configured target sheet/,
    'a write naming another sheet must be refused',
  )
  await assert.rejects(
    () => scoped.queryRecords({ sheetId: 'sheet_stock', filters: {} }),
    /leave configured target sheet/,
    'a read naming another sheet must be refused',
  )
}

// ── M77: the DB-level lease the module leans on is real ─────────────────────

async function testMigration077DefinesTheDbLevelLease() {
  const sql = fs.readFileSync(MIGRATION_077_PATH, 'utf8')
  assert.ok(
    sql.includes(`CREATE TABLE IF NOT EXISTS ${RECONCILE_LEASE_TABLE}`),
    'migration 077 must create the lease table the module names',
  )
  const block = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${RECONCILE_LEASE_TABLE} \\(([\\s\\S]*?)\\n\\);`, 'm'))
  assert.ok(block, 'lease table block must parse')
  // THE concurrency guarantee: scope_key is the PRIMARY KEY (DB-level unique),
  // and the CAS/steal columns exist non-null.
  assert.match(block[1], /scope_key TEXT PRIMARY KEY/, 'scope_key must be the PRIMARY KEY — this IS the DB-level uniqueness')
  assert.match(block[1], /lease_id TEXT NOT NULL/, 'lease_id (the CAS guard) must exist')
  assert.match(block[1], /expires_at TIMESTAMPTZ NOT NULL/, 'expires_at (the steal bound) must exist')
  assert.doesNotMatch(sql, /\bDROP\s+TABLE\b/i, 'forward migration must not drop tables')
  // The status vocabulary freeze (HG v1.2): no exposed cancellation anywhere on
  // the public module surface until its slice lands completely.
  assert.equal(Object.prototype.hasOwnProperty.call(STATUSES, 'CANCELLED'), false, 'cancelled must not be exposed in the public status vocabulary')
  assert.deepEqual(Object.values(STATUSES).sort(), ['confirmed', 'pending', 'superseded'])
}

// ── provisioning surfaces ───────────────────────────────────────────────────

async function testInspectAndEnsureProvisionTheLedgerObject() {
  const registry = new Map()
  const fake = makeFakeProvisioning({ stagingProjectId: STAGING, sheetIdByObjectId: {} })
  const provisioning = {
    async findObjectSheet({ projectId, objectId }) {
      if (projectId !== STAGING) return null
      return registry.has(objectId) ? { id: registry.get(objectId) } : null
    },
    resolveFieldIds: fake.resolveFieldIds,
    async ensureObject({ projectId, descriptor }) {
      assert.equal(projectId, STAGING)
      assert.equal(descriptor.id, OBJECT_ID)
      const ownerships = descriptor.fields.map((field) => field.property.stockPreparationConfirmationDecision.ownership)
      assert.ok(ownerships.includes('plm_system') && ownerships.includes('human_preserved'))
      registry.set(descriptor.id, LEDGER_SHEET)
    },
  }
  const context = { api: { multitable: { provisioning } } }

  const missing = await inspectConfirmationDecisionTarget({ context, projectId: STAGING, permission: 'admin' })
  assert.equal(missing.ready, false)
  assert.equal(missing.mode, 'confirmation_decision_missing')

  const created = await ensureConfirmationDecisionTarget({ context, projectId: STAGING, permission: 'admin' })
  assert.equal(created.created, true)
  assert.equal(created.mode, 'confirmation_decision_created')

  const again = await ensureConfirmationDecisionTarget({ context, projectId: STAGING, permission: 'admin' })
  assert.equal(again.created, false)
  assert.equal(again.mode, 'confirmation_decision_existing')

  await assert.rejects(
    () => ensureConfirmationDecisionTarget({ context, projectId: STAGING, permission: 'read' }),
    /admin permission/,
    'ensure is admin-gated',
  )
}

// ── A-01: same-fingerprint reconcile replay is idempotent ───────────────────

async function testA01SameFingerprintReconcileReplayIsIdempotent() {
  const env = ledgerEnv()
  const plan = planOf([duplicateHold('KEY-A')])
  const call = () => reconcileConfirmationDecisions(scopedCall(env, {
    projectNo: 'P-001',
    plan,
    sourceRevision: 'rev-1',
  }))

  const first = await call()
  assert.equal(first.counts.created, 1)
  assert.equal(first.counts.pending, 1)
  assert.equal(first.evidence.concurrencyModel, 'db_backed_reconcile_lease')
  assert.equal(ledgerRows(env.records).length, 1)

  // Replay of the SAME (plan, revision): no new row, no supersede, no touch.
  const replay = await call()
  assert.equal(replay.counts.created, 0)
  assert.equal(replay.counts.existing, 1)
  assert.equal(replay.counts.superseded, 0)
  assert.equal(ledgerRows(env.records).length, 1, 'A-01: replay must not grow the ledger')

  // ... and a third time, after the row is CONFIRMED: still untouched.
  const list = await listConfirmationDecisions(scopedCall(env, { projectNo: 'P-001' }))
  await confirmConfirmationDecision(scopedCall(env, {
    decisionId: list.rows[0].decisionId,
    inputFingerprint: list.rows[0].inputFingerprint,
    resolutionAction: RESOLUTION_ACTIONS.KEEP_MULTIPLE_ROWS,
    confirmedBy: 'admin-user',
  }))
  const confirmedReplay = await call()
  assert.equal(confirmedReplay.counts.created, 0)
  assert.equal(confirmedReplay.counts.existing, 1)
  assert.equal(confirmedReplay.counts.confirmed, 1)
  assert.equal(ledgerRows(env.records).length, 1)
}

// ── A-02: fingerprint change supersedes; old confirmation clears nothing ────

async function testA02FingerprintChangeSupersedesAndOldConfirmationDoesNotClearNewConflict() {
  const env = ledgerEnv()
  const plan = planOf([duplicateHold('KEY-A')])
  const call = (sourceRevision) => reconcileConfirmationDecisions(scopedCall(env, {
    projectNo: 'P-001',
    plan,
    sourceRevision,
    now: () => new Date('2026-08-27T10:00:00.000Z'),
  }))

  await call('rev-1')
  const second = await call('rev-2')
  assert.equal(second.counts.superseded, 1, 'the rev-1 pending row is superseded')
  assert.equal(second.counts.created, 1, 'a fresh pending row opens for rev-2')

  const rows = ledgerRows(env.records)
  assert.equal(rows.length, 2)
  const superseded = rows.find((row) => row.data.status === STATUSES.SUPERSEDED)
  const pending = rows.find((row) => row.data.status === STATUSES.PENDING)
  assert.ok(superseded, 'old row carries superseded status')
  assert.equal(superseded.data.supersededAt, '2026-08-27T10:00:00.000Z')
  assert.ok(pending, 'new row is pending')
  assert.notEqual(superseded.data.inputFingerprint, pending.data.inputFingerprint)
  assert.equal(superseded.data.stableDecisionKey, pending.data.stableDecisionKey, 'same logical decision, new input')

  // Confirm the rev-2 decision, then move the input again: the CONFIRMED row is
  // superseded exactly like a pending one ...
  const list = await listConfirmationDecisions(scopedCall(env, { projectNo: 'P-001', status: STATUSES.PENDING }))
  await confirmConfirmationDecision(scopedCall(env, {
    decisionId: list.rows[0].decisionId,
    inputFingerprint: list.rows[0].inputFingerprint,
    resolutionAction: RESOLUTION_ACTIONS.KEEP_MULTIPLE_ROWS,
    confirmedBy: 'admin-user',
  }))
  const third = await call('rev-3')
  assert.equal(third.counts.superseded, 1, 'the confirmed rev-2 row is superseded by rev-3')
  const statuses = ledgerRows(env.records).map((row) => row.data.status).sort()
  assert.deepEqual(statuses, [STATUSES.PENDING, STATUSES.SUPERSEDED, STATUSES.SUPERSEDED])

  // ... and the OLD (rev-2) confirmation must NOT clear the NEW (rev-3)
  // conflict: the readback for rev-3 yields no policy, so the hold stands.
  const review = await loadConfirmedDuplicatePolicyReview(scopedCall(env, {
    projectNo: 'P-001',
    plan,
    sourceRevision: 'rev-3',
  }))
  assert.deepEqual(review.policies, [], 'A-02: a superseded confirmation clears nothing for the new input')
}

// ── A-03: out-of-scope class / unknown action refused; zero canonical writes ─

async function testA03OutOfScopeConflictAndUnknownActionRefusedWithZeroCanonicalWrites() {
  const env = ledgerEnv()
  const plan = planOf([
    duplicateHold('KEY-A'),
    { decision: 'manual_confirm', conflictSummary: { type: 'lineage_mismatch' }, idempotencyKey: 'KEY-L', changedFields: ['path'], source: 'existing_row' },
    { decision: 'manual_confirm', conflictSummary: { type: 'component_identity_conflict' }, idempotencyKey: 'KEY-I', changedFields: ['material'], source: 'existing_row' },
    { decision: 'add', idempotencyKey: 'KEY-CLEAN', record: {} },
  ])

  const result = await reconcileConfirmationDecisions(scopedCall(env, {
    projectNo: 'P-001',
    plan,
    sourceRevision: 'rev-1',
  }))
  // Out-of-scope conflict classes are NOT ledgered — counted values-free only.
  assert.equal(result.counts.created, 1, 'A-03: exactly the ONE duplicate-class hold is ledgered')
  assert.deepEqual(result.evidence.outOfScopeManualConfirm, { lineage_mismatch: 1, component_identity_conflict: 1 })
  const rows = ledgerRows(env.records)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].data.conflictType, FIRST_CUT_CONFLICT_TYPE)

  // Unknown / unimplemented actions: fixed refusal codes, nothing written.
  const list = await listConfirmationDecisions(scopedCall(env, { projectNo: 'P-001' }))
  const { decisionId, inputFingerprint } = list.rows[0]
  const base = { decisionId, inputFingerprint, confirmedBy: 'admin-user' }
  await rejectsWithCode(
    () => confirmConfirmationDecision(scopedCall(env, { ...base, resolutionAction: 'delete_everything' })),
    'CONFIRMATION_DECISION_ACTION_INVALID',
    'A-03 unknown action',
  )
  for (const action of [RESOLUTION_ACTIONS.ACCEPT_CURRENT, RESOLUTION_ACTIONS.MANUAL_HOLD]) {
    await rejectsWithCode(
      () => confirmConfirmationDecision(scopedCall(env, { ...base, resolutionAction: action })),
      'CONFIRMATION_DECISION_ACTION_UNIMPLEMENTED',
      `A-03 unimplemented action ${action}`,
    )
  }
  const afterRefusals = ledgerRows(env.records)
  assert.equal(afterRefusals.length, 1)
  assert.equal(afterRefusals[0].data.status, STATUSES.PENDING, 'refused confirms leave the row untouched')

  // ZERO canonical/external writes: every write the whole flow performed names
  // the LEDGER sheet — no other sheet, no external system, ever.
  for (const call of [...env.records.createCalls, ...env.records.patchCalls]) {
    assert.equal(call.sheetId, LEDGER_SHEET, 'A-03: all writes stay on the ledger sheet')
  }
}

// ── A-04: two independent reconcilers -> exactly ONE active decision ────────

function loadIsolatedLedgerModule() {
  const resolved = require.resolve(MODULE_PATH)
  const cached = require.cache[resolved]
  delete require.cache[resolved]
  // eslint-disable-next-line global-require
  const fresh = require(MODULE_PATH)
  delete require.cache[resolved]
  if (cached) require.cache[resolved] = cached
  return fresh
}

async function testA04TwoIndependentReconcilersYieldOneActiveDecision() {
  // Absent lease: reconcile REFUSES fail-closed. The concurrency guarantee is
  // mandatory — there is no in-process fallback.
  const noLease = ledgerEnv()
  await rejectsWithCode(
    () => reconcileConfirmationDecisions(scopedCall(noLease, {
      projectNo: 'P-001',
      plan: planOf([duplicateHold('KEY-A')]),
      sourceRevision: 'rev-1',
      reconcileLease: null,
    })),
    'CONFIRMATION_DECISION_RECONCILE_LEASE_UNAVAILABLE',
    'A-04 lease required',
  )

  // Two INDEPENDENT module instances (fresh require, no shared JS state — the
  // in-model equivalent of two processes) over ONE shared substrate: the same
  // strict multitable store and the same lease database.
  const moduleA = loadIsolatedLedgerModule()
  const moduleB = loadIsolatedLedgerModule()
  assert.notEqual(moduleA, require(MODULE_PATH), 'instance A is a fresh module copy')
  assert.notEqual(moduleA, moduleB, 'the two reconcilers share no module state')

  const provisioning = makeFakeProvisioning({
    stagingProjectId: STAGING,
    sheetIdByObjectId: { [OBJECT_ID]: LEDGER_SHEET },
  })
  const records = makeStrictRecordsApi({
    stagingProjectId: STAGING,
    objectIdBySheetId: { [LEDGER_SHEET]: OBJECT_ID },
    rowsBySheet: { [LEDGER_SHEET]: [] },
  })
  // Interleaving gate: the first ledger read of each in-flight reconcile parks
  // until the gate opens, so WITHOUT the lease both reconcilers would read
  // "no existing decisions" before either writes — the classic double-create.
  let releaseGate
  const gate = new Promise((resolve) => { releaseGate = resolve })
  let gatedReads = 0
  const gatedRecords = {
    ...records,
    async queryRecords(input) {
      gatedReads += 1
      if (gatedReads <= 2) await gate
      return records.queryRecords(input)
    },
  }
  const sharedLeaseDb = makeFakeLeaseDb()
  const plan = planOf([duplicateHold('KEY-A')])
  const reconcilerInput = (mod) => ({
    recordsApi: gatedRecords,
    provisioning,
    targetProjectId: STAGING,
    permission: 'admin',
    projectNo: 'P-001',
    plan,
    sourceRevision: 'rev-1',
    reconcileLease: mod.createConfirmationDecisionReconcileLease({ db: sharedLeaseDb }),
  })

  const attemptA = moduleA.reconcileConfirmationDecisions(reconcilerInput(moduleA))
  const attemptB = moduleB.reconcileConfirmationDecisions(reconcilerInput(moduleB))
  // Attach the settle handlers FIRST (a loser rejecting during the pause must
  // not surface as an unhandled rejection), let both attempts reach their
  // first blocking point, then open the gate.
  const settledPromise = Promise.allSettled([attemptA, attemptB])
  await new Promise((resolve) => setTimeout(resolve, 25))
  releaseGate()
  const settled = await settledPromise

  // THE acceptance criterion first: whatever the two attempts reported, the
  // ledger must end with exactly ONE active decision row.
  const active = ledgerRows(records).filter((row) => ACTIVE_STATUSES.includes(row.data.status))
  assert.equal(active.length, 1, 'A-04: final active decision count is exactly 1')

  const fulfilled = settled.filter((entry) => entry.status === 'fulfilled')
  const rejected = settled.filter((entry) => entry.status === 'rejected')
  assert.equal(fulfilled.length, 1, 'A-04: exactly one reconciler wins')
  assert.equal(fulfilled[0].value.counts.created, 1)
  assert.equal(rejected.length, 1, 'A-04: exactly one reconciler loses')
  assert.equal(rejected[0].reason.code, 'CONFIRMATION_DECISION_RECONCILE_BUSY', 'A-04: the loser gets the fixed conflict code')
  assert.equal(sharedLeaseDb.rows.size, 0, 'the winner released its lease')

  // The loser retries after the winner finished: idempotent no-op (A-01).
  const retry = await moduleB.reconcileConfirmationDecisions(reconcilerInput(moduleB))
  assert.equal(retry.counts.created, 0)
  assert.equal(retry.counts.existing, 1)
  assert.equal(ledgerRows(records).filter((row) => ACTIVE_STATUSES.includes(row.data.status)).length, 1)
}

// ── W-4(a): A→B→A fingerprint RETURN must reopen, not wedge ─────────────────

async function testW4aFingerprintReturnReopensSupersededRowAndClearsHumanDecision() {
  const env = ledgerEnv()
  const plan = planOf([duplicateHold('KEY-A')])
  const call = (sourceRevision) => reconcileConfirmationDecisions(scopedCall(env, {
    projectNo: 'P-001',
    plan,
    sourceRevision,
    now: () => new Date('2026-08-29T10:00:00.000Z'),
  }))

  // Cycle 1: rev-1 opens A; a human confirms it WITH notes, so the later
  // revival has actual human content to clear.
  await call('rev-1')
  const first = await listConfirmationDecisions(scopedCall(env, { projectNo: 'P-001', status: STATUSES.PENDING }))
  const original = first.rows[0]
  await confirmConfirmationDecision(scopedCall(env, {
    decisionId: original.decisionId,
    inputFingerprint: original.inputFingerprint,
    resolutionAction: RESOLUTION_ACTIONS.KEEP_MULTIPLE_ROWS,
    confirmedBy: 'admin-user',
    notes: 'first-cycle decision',
  }))

  // Cycle 2: rev-2 supersedes A and opens B (plain A-02 behaviour).
  await call('rev-2')

  // Cycle 3: the source content REVERTS — the revision handle is a pure
  // content hash, so rev-1's fingerprint RETURNS. Pre-fix this run was a total
  // no-op: A stayed superseded (unconfirmable), B stayed pending (stale) — the
  // key was permanently wedged.
  const third = await call('rev-1')
  assert.equal(third.counts.reopened, 1, 'W-4(a): the RETURNED fingerprint reopens its superseded row')
  assert.equal(third.counts.created, 0, 'reopen reuses the row — stable decisionId, no duplicate')
  assert.equal(third.counts.superseded, 1, 'W-4(a): the stale rev-2 pending row is superseded in the SAME run despite the exact hit')
  assert.equal(third.counts.pending, 1)

  const rows = ledgerRows(env.records)
  assert.equal(rows.length, 2, 'no row growth across the oscillation')
  const revived = rows.find((row) => row.data.decisionId === original.decisionId)
  const stale = rows.find((row) => row.data.decisionId !== original.decisionId)
  assert.equal(revived.data.status, STATUSES.PENDING)
  assert.equal(stale.data.status, STATUSES.SUPERSEDED)
  assert.equal(revived.data.supersededAt, null, 'supersededAt is cleared on reopen')
  // Conservative default (flagged for the owner — O1' matrix Q5): a revived
  // conflict is a NEW question to the human. The old answer is cleared, never
  // silently carried forward.
  assert.equal(revived.data.resolutionAction, null, 'W-4(a): the old human resolutionAction is cleared on reopen')
  assert.equal(revived.data.notes, null, 'W-4(a): the old human notes are cleared on reopen')
  assert.equal(revived.data.confirmedBy, null, 'stale confirmation bookkeeping is cleared with it')
  assert.equal(revived.data.confirmedAt, null)

  // Cleared means NOT auto-downgraded: the readback stays empty until a human
  // re-confirms the revived row.
  const readback = () => loadConfirmedDuplicatePolicyReview(scopedCall(env, { projectNo: 'P-001', plan, sourceRevision: 'rev-1' }))
  assert.deepEqual((await readback()).policies, [], 'a revived conflict must be re-confirmed by a human')

  // ... and the key is fully un-wedged: pending -> confirmable -> readable.
  await confirmConfirmationDecision(scopedCall(env, {
    decisionId: original.decisionId,
    inputFingerprint: original.inputFingerprint,
    resolutionAction: RESOLUTION_ACTIONS.KEEP_MULTIPLE_ROWS,
    confirmedBy: 'admin-user',
  }))
  assert.equal((await readback()).policies.length, 1, 'W-4(a): the oscillated key confirms and reads back again — no permanent wedge')

  // Replay after the revival: plain A-01 no-op (reopen fires only on RETURN).
  const replay = await call('rev-1')
  assert.equal(replay.counts.reopened, 0)
  assert.equal(replay.counts.existing, 1)
  assert.equal(replay.counts.created, 0)
  assert.equal(ledgerRows(env.records).length, 2)
}

// ── W-4(b): a conflict that vanishes from the plan is closed by the sweep ───

async function testW4bVanishedConflictSweepClosesOrphanPendingRows() {
  const env = ledgerEnv()
  const call = (plan) => reconcileConfirmationDecisions(scopedCall(env, {
    projectNo: 'P-001',
    plan,
    sourceRevision: 'rev-1',
    now: () => new Date('2026-08-29T11:00:00.000Z'),
  }))
  const bothPlan = planOf([duplicateHold('KEY-A'), duplicateHold('KEY-B')])
  await call(bothPlan)
  assert.equal(ledgerRows(env.records).length, 2)

  const { candidates } = deriveDecisionCandidates({ projectNo: 'P-001', plan: bothPlan, sourceRevision: 'rev-1' })
  const byIdentity = new Map(candidates.map((candidate) => [candidate.rowIdentity, candidate]))
  // Confirm KEY-B so the sweep later has a confirmed orphan to LEAVE ALONE.
  await confirmConfirmationDecision(scopedCall(env, {
    decisionId: byIdentity.get('KEY-B').decisionId,
    inputFingerprint: byIdentity.get('KEY-B').inputFingerprint,
    resolutionAction: RESOLUTION_ACTIONS.KEEP_MULTIPLE_ROWS,
    confirmedBy: 'admin-user',
  }))

  // KEY-A vanishes from the source while still PENDING: the sweep closes it.
  const swept = await call(planOf([duplicateHold('KEY-B')]))
  assert.equal(swept.counts.orphanSuperseded, 1, 'W-4(b): the vanished pending conflict is closed')
  assert.equal(swept.counts.superseded, 0, 'the sweep is distinguishable from a fingerprint supersede')
  assert.equal(swept.counts.created, 0)
  assert.equal(swept.counts.existing, 1)
  assert.deepEqual(
    swept.evidence.orphanSweep,
    { closed: 1, reason: 'conflict_vanished_from_plan', truncated: false },
    'W-4(b): the sweep reason travels in the run evidence',
  )

  const afterSweep = ledgerRows(env.records)
  const keyARow = afterSweep.find((row) => row.data.stableDecisionKey === byIdentity.get('KEY-A').stableDecisionKey)
  const keyBRow = afterSweep.find((row) => row.data.stableDecisionKey === byIdentity.get('KEY-B').stableDecisionKey)
  assert.equal(keyARow.data.status, STATUSES.SUPERSEDED, 'the orphan is closed with the frozen superseded status, not a new one')
  assert.equal(keyARow.data.supersededAt, '2026-08-29T11:00:00.000Z')
  assert.equal(keyBRow.data.status, STATUSES.CONFIRMED, 'the still-present confirmed row is untouched')

  // The closed orphan is no longer confirmable — the queue cannot wedge on it.
  await rejectsWithCode(
    () => confirmConfirmationDecision(scopedCall(env, {
      decisionId: byIdentity.get('KEY-A').decisionId,
      inputFingerprint: byIdentity.get('KEY-A').inputFingerprint,
      resolutionAction: RESOLUTION_ACTIONS.KEEP_MULTIPLE_ROWS,
      confirmedBy: 'admin-user',
    })),
    'CONFIRMATION_DECISION_NOT_PENDING',
    'W-4(b) swept row refuses confirm',
  )

  // KEY-B vanishes too — but it is CONFIRMED: a historical human decision the
  // sweep must NOT touch (the readback already ignores it via the fingerprint
  // bind, so it is inert, not dangerous).
  const emptied = await call(planOf([]))
  assert.equal(emptied.counts.orphanSuperseded, 0, 'W-4(b): confirmed orphans are never swept')
  assert.equal(
    ledgerRows(env.records).find((row) => row.data.stableDecisionKey === byIdentity.get('KEY-B').stableDecisionKey).data.status,
    STATUSES.CONFIRMED,
  )

  // Sweep replay is idempotent: nothing left to close, no row growth.
  const replay = await call(planOf([duplicateHold('KEY-B')]))
  assert.equal(replay.counts.orphanSuperseded, 0)
  assert.equal(replay.counts.existing, 1)
  assert.equal(ledgerRows(env.records).length, 2)
}

// ── W-4(c): lease renew CAS + mid-run lost-lease abort ──────────────────────

async function testW4cLeaseOverrunAbortsWithFixedCodeAndNoDuplicateActiveRows() {
  // renew CAS semantics first, in isolation.
  const casDb = makeFakeLeaseDb()
  const casLease = createConfirmationDecisionReconcileLease({ db: casDb, ttlMs: 60_000, now: () => new Date(0) })
  const casGot = await casLease.acquire('scope-cas')
  assert.equal(casGot.held, true)
  assert.deepEqual(await casLease.renew({ scopeKey: 'scope-cas', leaseId: casGot.leaseId }), { held: true })
  assert.equal(casDb.rows.get('scope-cas').expires_at, new Date(60_000).toISOString(), 'renew CAS-extends expires_at over the existing 077 columns')
  assert.deepEqual(await casLease.renew({ scopeKey: 'scope-cas', leaseId: casGot.leaseId, ttlMs: 5 }), { held: true })
  assert.equal(casDb.rows.get('scope-cas').expires_at, new Date(5).toISOString(), 'renew honours an explicit ttlMs')
  assert.deepEqual(
    await casLease.renew({ scopeKey: 'scope-cas', leaseId: 'someone-else' }),
    { held: false },
    'W-4(c): renew is CAS-guarded by lease_id — a non-holder extends nothing',
  )
  assert.equal(casDb.rows.get('scope-cas').expires_at, new Date(5).toISOString(), 'a refused renew leaves expires_at untouched')

  // A lease surface WITHOUT renew is refused fail-closed: without mid-run
  // renewal the write loop cannot notice a lost lease at all.
  const noRenewEnv = ledgerEnv()
  await rejectsWithCode(
    () => reconcileConfirmationDecisions(scopedCall(noRenewEnv, {
      projectNo: 'P-001',
      plan: planOf([duplicateHold('KEY-A')]),
      sourceRevision: 'rev-1',
      reconcileLease: { acquire: async () => ({ held: true, leaseId: 'x' }), release: async () => {} },
    })),
    'CONFIRMATION_DECISION_RECONCILE_LEASE_UNAVAILABLE',
    'W-4(c) lease without renew',
  )

  // THE overrun reproduction, deterministic: a holder whose lease TTL (1ms on
  // a frozen clock) is expired the moment anyone looks — exactly like a 60s
  // TTL against a write loop slower than 60s — and a stealer that takes the
  // lease over right after the holder's FIRST write lands.
  const provisioning = makeFakeProvisioning({
    stagingProjectId: STAGING,
    sheetIdByObjectId: { [OBJECT_ID]: LEDGER_SHEET },
  })
  const records = makeStrictRecordsApi({
    stagingProjectId: STAGING,
    objectIdBySheetId: { [LEDGER_SHEET]: OBJECT_ID },
    rowsBySheet: { [LEDGER_SHEET]: [] },
  })
  const sharedLeaseDb = makeFakeLeaseDb()
  const holderLease = createConfirmationDecisionReconcileLease({ db: sharedLeaseDb, ttlMs: 1, now: () => new Date(0) })
  const stealerLease = createConfirmationDecisionReconcileLease({ db: sharedLeaseDb, now: () => new Date(1000) })
  const scopeKey = ledgerInternals.stableHash('reconcile-lock', { targetProjectId: STAGING, projectNo: 'P-001' })
  // 26 candidates: the renew cadence is every 25 writes, so the holder renews
  // before write #1 (still unstolen), writes #1..#25 land, the steal happens
  // after write #1, and the renew before write #26 discovers the loss.
  const keys = Array.from({ length: 26 }, (_, index) => `KEY-${String(index).padStart(2, '0')}`)
  const plan = planOf(keys.map((key) => duplicateHold(key)))
  let stolenLeaseId = null
  const interceptedRecords = {
    ...records,
    async createRecord(input) {
      const created = await records.createRecord(input)
      if (!stolenLeaseId) {
        const grabbed = await stealerLease.acquire(scopeKey)
        assert.equal(grabbed.held, true, 'the stealer takes over the expired lease mid-run')
        stolenLeaseId = grabbed.leaseId
      }
      return created
    },
  }
  await assert.rejects(
    () => reconcileConfirmationDecisions({
      recordsApi: interceptedRecords,
      provisioning,
      targetProjectId: STAGING,
      permission: 'admin',
      projectNo: 'P-001',
      plan,
      sourceRevision: 'rev-1',
      reconcileLease: holderLease,
    }),
    (error) => {
      assert.ok(error instanceof StockPreparationConfirmationDecisionError, `expected ledger error, got ${error && error.name}: ${error && error.message}`)
      assert.equal(error.code, 'CONFIRMATION_DECISION_RECONCILE_LEASE_LOST', 'W-4(c): the overtaken holder aborts with the fixed code')
      assert.equal(error.status, 409)
      assert.equal(error.details.partial, true)
      assert.equal(error.details.counts.created, 25, 'W-4(c): partial counts surface in the abort payload')
      return true
    },
  )
  assert.equal(ledgerRows(records).length, 25, 'the holder stopped mid-run — a bounded, not unbounded, overrun')
  assert.ok(sharedLeaseDb.rows.get(scopeKey), 'the aborted holder must NOT free the stealer lease on release')
  assert.equal(sharedLeaseDb.rows.get(scopeKey).lease_id, stolenLeaseId)

  // The takeover reconciler finishes the job; the ledger converges with NO
  // duplicate active rows — the one-active-decision invariant migration 077
  // exists for.
  await stealerLease.release(scopeKey, stolenLeaseId)
  const takeover = await reconcileConfirmationDecisions({
    recordsApi: records,
    provisioning,
    targetProjectId: STAGING,
    permission: 'admin',
    projectNo: 'P-001',
    plan,
    sourceRevision: 'rev-1',
    reconcileLease: stealerLease,
  })
  assert.equal(takeover.counts.existing, 25, 'the aborted holder partial writes replay as no-ops (A-01)')
  assert.equal(takeover.counts.created, 1, 'the takeover writes only what the holder never reached')
  const active = ledgerRows(records).filter((row) => ACTIVE_STATUSES.includes(row.data.status))
  assert.equal(active.length, 26, 'every key ends with exactly one active row')
  assert.equal(new Set(active.map((row) => row.data.stableDecisionKey)).size, 26, 'W-4(c): no duplicate active rows for any key')
}

// ── G7: unregistered / malformed / stale confirms are refused ───────────────

async function testConfirmRefusesUnregisteredMalformedAndStale() {
  const env = ledgerEnv()
  await reconcileConfirmationDecisions(scopedCall(env, {
    projectNo: 'P-001',
    plan: planOf([duplicateHold('KEY-A')]),
    sourceRevision: 'rev-1',
  }))
  const list = await listConfirmationDecisions(scopedCall(env, { projectNo: 'P-001' }))
  const { decisionId, inputFingerprint } = list.rows[0]
  const base = { resolutionAction: RESOLUTION_ACTIONS.KEEP_MULTIPLE_ROWS, confirmedBy: 'admin-user' }

  // UNREGISTERED: a decisionId the ledger never opened.
  await rejectsWithCode(
    () => confirmConfirmationDecision(scopedCall(env, { ...base, decisionId: 'sha256:0000000000000000000000000000dead', inputFingerprint })),
    'CONFIRMATION_DECISION_NOT_FOUND',
    'unknown decisionId',
  )
  // STALE: fingerprint no longer matching.
  await rejectsWithCode(
    () => confirmConfirmationDecision(scopedCall(env, { ...base, decisionId, inputFingerprint: 'sha256:1111111111111111111111111111beef' })),
    'CONFIRMATION_DECISION_REVISION_MISMATCH',
    'stale fingerprint',
  )
  // FIRST-CUT boundary: value entry belongs to the out-of-scope human-column line.
  await rejectsWithCode(
    () => confirmConfirmationDecision(scopedCall(env, { ...base, decisionId, inputFingerprint, resolvedValue: 'anything' })),
    'CONFIRMATION_DECISION_VALUE_ENTRY_UNIMPLEMENTED',
    'value entry refused',
  )
  // MALFORMED plan: a duplicate-class hold with no idempotencyKey is not a
  // planner artifact and must be refused, not anonymously ledgered.
  await rejectsWithCode(
    () => reconcileConfirmationDecisions(scopedCall(env, {
      projectNo: 'P-001',
      plan: planOf([{ decision: 'manual_confirm', conflictSummary: { type: FIRST_CUT_CONFLICT_TYPE } }]),
      sourceRevision: 'rev-1',
    })),
    'CONFIRMATION_DECISION_PLAN_INVALID',
    'keyless duplicate hold',
  )
  // Queue status filter is a frozen vocabulary too — and the reserved (not yet
  // implemented) cancellation token is NOT part of it.
  for (const status of ['weird', 'cancelled']) {
    await rejectsWithCode(
      () => listConfirmationDecisions(scopedCall(env, { projectNo: 'P-001', status })),
      'CONFIRMATION_DECISION_STATUS_INVALID',
      `status filter ${status}`,
    )
  }

  // The refusals above must have left the row untouched and still confirmable.
  const confirmed = await confirmConfirmationDecision(scopedCall(env, { ...base, decisionId, inputFingerprint, notes: 'checked with procurement' }))
  assert.equal(confirmed.status, STATUSES.CONFIRMED)
  assert.equal(confirmed.evidence.notesPresent, true)
  // NOT PENDING: confirming twice is refused.
  await rejectsWithCode(
    () => confirmConfirmationDecision(scopedCall(env, { ...base, decisionId, inputFingerprint })),
    'CONFIRMATION_DECISION_NOT_PENDING',
    'double confirm',
  )
}

// ── G3 + G4: readback downgrades ONLY confirmed+matching keep_multiple_rows ──

async function testReadbackDowngradesOnlyConfirmedMatchingKeepMultipleRows() {
  const env = ledgerEnv()
  const plan = planOf([duplicateHold('KEY-A')])
  const readback = (sourceRevision) => loadConfirmedDuplicatePolicyReview(scopedCall(env, {
    projectNo: 'P-001',
    plan,
    sourceRevision,
  }))

  // Nothing ledgered: empty review.
  assert.deepEqual(await readback('rev-1'), { scope: 'table_scope', policies: [] })

  await reconcileConfirmationDecisions(scopedCall(env, { projectNo: 'P-001', plan, sourceRevision: 'rev-1' }))
  // PENDING must not downgrade.
  assert.deepEqual((await readback('rev-1')).policies, [])

  const list = await listConfirmationDecisions(scopedCall(env, { projectNo: 'P-001' }))
  await confirmConfirmationDecision(scopedCall(env, {
    decisionId: list.rows[0].decisionId,
    inputFingerprint: list.rows[0].inputFingerprint,
    resolutionAction: RESOLUTION_ACTIONS.KEEP_MULTIPLE_ROWS,
    confirmedBy: 'admin-user',
  }))

  // CONFIRMED + matching revision: exactly one keep_multiple_rows policy, keyed
  // by the PLANNER's duplicate-group fingerprint for this key.
  const confirmedReview = await readback('rev-1')
  assert.equal(confirmedReview.policies.length, 1)
  assert.deepEqual(confirmedReview.policies[0], {
    fingerprint: plannerInternals.stableFingerprint('KEY-A'),
    policy: 'keep_multiple_rows',
    approvedAtPresent: true,
    approvedByPresent: true,
  })

  // G3: the SAME confirmation under a DIFFERENT source revision is stale — the
  // hold must stand.
  assert.deepEqual((await readback('rev-2')).policies, [], 'a stale confirmation never downgrades')

  // G4: a confirmed row whose resolutionAction is NOT keep_multiple_rows is
  // inert for the planner. (Seeded directly — the confirm boundary refuses this
  // action, which is itself asserted in A-03.)
  const acceptEnv = (() => {
    const { candidates } = deriveDecisionCandidates({ projectNo: 'P-001', plan, sourceRevision: 'rev-1' })
    const candidate = candidates[0]
    return ledgerEnv({
      rows: [seedLedgerRow({
        decisionId: candidate.decisionId,
        stableDecisionKey: candidate.stableDecisionKey,
        projectNo: 'P-001',
        rowIdentity: candidate.rowIdentity,
        conflictType: candidate.conflictType,
        inputFingerprint: candidate.inputFingerprint,
        sourceRevision: 'rev-1',
        status: STATUSES.CONFIRMED,
        openedAt: '2026-08-27T09:00:00.000Z',
        resolutionAction: RESOLUTION_ACTIONS.ACCEPT_CURRENT,
        confirmedBy: 'admin-user',
        confirmedAt: '2026-08-27T09:30:00.000Z',
      }, 'rec_seed_accept')],
    })
  })()
  const acceptReview = await loadConfirmedDuplicatePolicyReview(scopedCall(acceptEnv, {
    projectNo: 'P-001',
    plan,
    sourceRevision: 'rev-1',
  }))
  assert.deepEqual(acceptReview.policies, [], 'a confirmed accept_current row must not downgrade the hold')

  // A-03 companion: a confirmed row for ANOTHER conflict class never reaches
  // the planner, even when seeded with the exact ids the (out-of-scope)
  // candidate would get.
  const lineagePlan = planOf([
    { decision: 'manual_confirm', idempotencyKey: 'KEY-L', conflictSummary: { type: 'lineage_mismatch' }, changedFields: ['path'], source: 'existing_row' },
  ])
  const lineageKey = ledgerInternals.stableHash('stable-key', { projectNo: 'P-001', rowIdentity: 'KEY-L', conflictType: 'lineage_mismatch' })
  const lineageFingerprint = ledgerInternals.stableHash('input', {
    sourceRevision: 'rev-1',
    stableDecisionKey: lineageKey,
    conflictSummary: { type: 'lineage_mismatch' },
    changedFields: ['path'],
  })
  const lineageEnv = ledgerEnv({
    rows: [seedLedgerRow({
      decisionId: ledgerInternals.stableHash('revision-key', { stableDecisionKey: lineageKey, inputFingerprint: lineageFingerprint }),
      stableDecisionKey: lineageKey,
      projectNo: 'P-001',
      rowIdentity: 'KEY-L',
      conflictType: 'lineage_mismatch',
      inputFingerprint: lineageFingerprint,
      sourceRevision: 'rev-1',
      status: STATUSES.CONFIRMED,
      openedAt: '2026-08-27T09:00:00.000Z',
      resolutionAction: RESOLUTION_ACTIONS.KEEP_MULTIPLE_ROWS,
      confirmedBy: 'admin-user',
      confirmedAt: '2026-08-27T09:30:00.000Z',
    }, 'rec_seed_lineage')],
  })
  const lineageReview = await loadConfirmedDuplicatePolicyReview(scopedCall(lineageEnv, {
    projectNo: 'P-001',
    plan: lineagePlan,
    sourceRevision: 'rev-1',
  }))
  assert.deepEqual(lineageReview.policies, [], 'other conflict classes are untouched by construction')
}

// ── G8: the queue is values-free ────────────────────────────────────────────

async function testQueueEndpointEmitsNoCellValues() {
  const env = ledgerEnv()
  // The duplicated key and the revision handle BOTH carry the marker — the two
  // value-bearing cells the ledger stores verbatim (rowIdentity, sourceRevision).
  await reconcileConfirmationDecisions(scopedCall(env, {
    projectNo: 'P-001',
    plan: planOf([duplicateHold(`KEY-${LEAK_MARKER}`)]),
    sourceRevision: `rev-${LEAK_MARKER}`,
  }))

  // NEGATIVE CONTROL: the marker IS in the underlying store, so a projection
  // leak would be caught, not vacuously green.
  assert.ok(
    JSON.stringify(env.records.rows(LEDGER_SHEET)).includes(LEAK_MARKER),
    'negative control: the marker must exist in the raw ledger rows',
  )

  const list = await listConfirmationDecisions(scopedCall(env, { projectNo: 'P-001' }))
  const serialized = JSON.stringify(list)
  assert.equal(serialized.includes(LEAK_MARKER), false, 'queue response must not carry source cell values')
  assert.equal(list.rowCount, 1)
  assert.deepEqual(list.byStatus, { pending: 1 })
  assert.equal(list.rows[0].status, STATUSES.PENDING)
  assert.equal(list.rows[0].conflictType, FIRST_CUT_CONFLICT_TYPE)
  assert.ok(list.rows[0].decisionId.startsWith('sha256:'))
  assert.ok(list.rows[0].inputFingerprint.startsWith('sha256:'))
  assert.equal(list.rows[0].sourceRevisionPresent, true, 'presence booleans replace the values')
  assert.equal(Object.prototype.hasOwnProperty.call(list.rows[0], 'rowIdentity'), false, 'rowIdentity never crosses the queue surface')
}

// ── end to end: dry-run -> reconcile -> confirm -> downgraded dry-run ───────
// (The canonical-side fakes mirror stock-preparation-table-actions.test.cjs.)

function createMemoryStorage() {
  const map = new Map()
  return {
    map,
    async get(key) { return map.get(key) || null },
    async set(key, value) { map.set(key, clone(value)) },
    async delete(key) { map.delete(key) },
  }
}

function duplicateRootPlmData() {
  return {
    DN_PDM_PathExAttrInfo: [{ FileCode: 'P-001', Parent_OBJ_ID: 'PATH-1' }],
    DN_PDM_PathInfo: [{ OBJ_ID: 'PATH-1' }],
    DN_PDM_OrderHeadInfo: [{ OBJ_ID: 'ORDER-1', path_id: 'PATH-1' }],
    DN_PDM_OrderDetailInfo: [
      { order_id: 'ORDER-1', part_id: 'PART-A', quantity: '2', sort_id: '10' },
      { order_id: 'ORDER-1', part_id: 'PART-A', quantity: '3', sort_id: '20' },
    ],
    DN_PDM_PartLibraryInfo: [{ OBJ_ID: 'PART-A', IdentityNo: 'A-001', IdentityName: 'Assembly', Material: 'Steel', SysVer: 'V1' }],
    DN_PDM_BomHeadInfo: [],
    DN_PDM_BomDetailsInfo: [],
  }
}

function createSourceAdapter(data) {
  return {
    async read(input = {}) {
      const rows = Array.isArray(data[input.object]) ? data[input.object] : []
      const matches = rows.filter((row) =>
        Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected),
      )
      const offset = input.cursor ? Number(input.cursor) : 0
      const limit = input.limit || 1000
      const records = matches.slice(offset, offset + limit).map(clone)
      return {
        records,
        done: offset + records.length >= matches.length,
        nextCursor: offset + records.length < matches.length ? String(offset + records.length) : null,
      }
    },
  }
}

function createCanonicalRecordsApi() {
  const rows = []
  return {
    rows,
    async queryRecords(input = {}) {
      return rows
        .filter((record) => record.sheetId === input.sheetId)
        .filter((record) => Object.entries(input.filters || {}).every(([field, value]) => record.data[field] === value))
        .slice(input.offset || 0, (input.offset || 0) + (input.limit || 1000))
        .map(clone)
    },
    async createRecord(input = {}) {
      const record = { id: `rec_${rows.length + 1}`, sheetId: input.sheetId, version: 1, data: { ...(input.data || {}) } }
      rows.push(record)
      return clone(record)
    },
    async patchRecord(input = {}) {
      const record = rows.find((row) => row.sheetId === input.sheetId && row.id === input.recordId)
      if (!record) throw new Error(`record not found: ${input.recordId}`)
      record.version += 1
      record.data = { ...record.data, ...(input.changes || {}) }
      return clone(record)
    },
  }
}

async function testEndToEndConfirmedDecisionDowngradesTheDuplicateHold() {
  const storage = createMemoryStorage()
  const sourceAdapter = createSourceAdapter(duplicateRootPlmData())
  const canonicalRecords = createCanonicalRecordsApi()
  const ledger = ledgerEnv()
  const action = normalizeStockPreparationActionConfig({
    actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    source: { externalSystemId: 'plm_source_1', kind: 'data-source:sql-readonly' },
    target: { sheetId: 'sheet_stock', objectId: 'stockPreparationMain' },
  })
  // The route-side seam, reproduced: server-held, threaded as a parameter.
  const confirmationDecisionResolver = async ({ projectNo, plan, sourceRevision }) =>
    loadConfirmedDuplicatePolicyReview(scopedCall(ledger, { projectNo, plan, sourceRevision }))
  const dryRunInput = () => ({
    action,
    parameters: { projectNo: 'P-001' },
    sourceAdapter,
    recordsApi: canonicalRecords,
    tokenStore: storage,
    policyStore: storage,
    confirmationDecisionResolver,
  })

  // 1) Un-ledgered: the duplicate group holds; no ledger evidence key appears.
  const held = await dryRunStockPreparationAction(dryRunInput())
  assert.equal(held.status, 'manual_confirm_required')
  assert.equal(held.counts.manual_confirm, 1)
  assert.equal(held.counts.add, 0)
  assert.equal(Object.prototype.hasOwnProperty.call(held.evidence, 'confirmationDecision'), false,
    'no ledger match -> evidence is byte-identical to the pre-ledger shape')

  // 2) Reconcile: the SERVER re-plans and ledgers the hold.
  const prepared = await prepareStockPreparationConfirmationDecisions({
    action,
    parameters: { projectNo: 'P-001' },
    sourceAdapter,
    recordsApi: canonicalRecords,
    policyStore: storage,
  })
  assert.equal(prepared.plan.counts.manual_confirm, 1)
  const reconciled = await reconcileConfirmationDecisions(scopedCall(ledger, {
    projectNo: 'P-001',
    plan: prepared.plan,
    sourceRevision: prepared.revision,
  }))
  assert.equal(reconciled.counts.created, 1)

  // 3) Pending is NOT enough: the hold still stands.
  const stillHeld = await dryRunStockPreparationAction(dryRunInput())
  assert.equal(stillHeld.status, 'manual_confirm_required')
  assert.equal(stillHeld.counts.manual_confirm, 1)

  // 4) Human confirms keep_multiple_rows (queue -> confirm, values-free ids only).
  const queue = await listConfirmationDecisions(scopedCall(ledger, { projectNo: 'P-001', status: STATUSES.PENDING }))
  assert.equal(queue.rowCount, 1)
  await confirmConfirmationDecision(scopedCall(ledger, {
    decisionId: queue.rows[0].decisionId,
    inputFingerprint: queue.rows[0].inputFingerprint,
    resolutionAction: RESOLUTION_ACTIONS.KEEP_MULTIPLE_ROWS,
    confirmedBy: 'admin-user',
  }))

  // 5) The confirmed decision downgrades the hold: the group resolves into two
  //    discriminated add decisions; nothing else moved.
  const resolved = await dryRunStockPreparationAction(dryRunInput())
  assert.equal(resolved.status, 'ready')
  assert.equal(resolved.counts.manual_confirm, 0)
  assert.equal(resolved.counts.add, 2)
  const resolution = resolved.evidence.plan.duplicateExpandedKeyResolution
  assert.equal(resolution.resolvedGroupCount, 1)
  assert.equal(resolution.resolvedRowCount, 2)
  assert.equal(resolution.resolvedPolicies[0].policy, 'keep_multiple_rows')
  assert.equal(resolved.evidence.confirmationDecision.matchedPolicyCount, 1)
  assert.equal(resolved.evidence.confirmationDecision.conflictingPolicyCount, 0)
  assert.equal(resolved.evidence.confirmationDecision.inputRevision, prepared.revision,
    'the ledger consultation is bound to the SAME pre-merge revision reconcile stored')
  assert.equal(JSON.stringify(resolved.evidence).includes('P-001'), false, 'dry-run evidence stays values-free')
  assert.equal(JSON.stringify(resolved.evidence).includes('PART-A'), false, 'dry-run evidence hides source ids')

  // 6) The canonical sheet was never touched by any ledger step: only the
  //    LEDGER sheet holds new rows; the canonical fake saw no writes at all.
  assert.equal(canonicalRecords.rows.length, 0, 'dry-run/reconcile/confirm wrote no canonical row')
  assert.equal(ledger.records.rows(LEDGER_SHEET).length, 1)
}

// ── O1-B: the ANONYMOUS hold families reach the ledger ──────────────────────
//
// RED-witnessed guards (mutation table in the landing commit body):
//   O1B-L1  identity-capable anonymous families ledger as PENDING rows, and a
//           REPEAT RECONCILE over the same source state reproduces the same
//           decisionId per family — zero row growth
//   O1B-L2  a change in how many holds sit on one identity supersedes and
//           reopens; a stale acknowledgement never rides the new input
//   O1B-L3  the reserved identity namespace is fenced in BOTH directions
//   O1B-L4  an anonymous-family row can NEVER downgrade a hold: the readback
//           structurally cannot receive one, and confirming one changes nothing
//   O1B-L5  identity-less anonymous holds stay un-ledgered under their own
//           explicit deferral marker, disjoint from the out-of-scope tally

const KEYED_OUT_OF_SCOPE_HOLD = Object.freeze({
  decision: 'manual_confirm',
  conflictSummary: { type: 'lineage_mismatch' },
  idempotencyKey: 'KEY-L',
  changedFields: ['path'],
  source: 'existing_row',
})

// Built by the REAL planner, so the identities under test are the ones
// production would derive — not hand-written fixtures that could drift from it.
function anonymousPlan({ missingComponentCount = 2 } = {}) {
  const rowErrors = []
  for (let i = 0; i < missingComponentCount; i += 1) {
    // Same (type, field, depth): ONE locus, N holds. The expander attaches no
    // per-row discriminator, so folding is the honest granularity.
    rowErrors.push({ type: 'missing_component', field: 'OBJ_ID', depth: 2 })
  }
  rowErrors.push({ type: 'SOURCE_VALUE_NOT_A_NUMBER', target: 'ext_weight', sourceColumn: 'WGT', expectedType: 'number', depth: 0 })
  // Identity-less: the unvalidated umbrella fallback carries nothing at all.
  rowErrors.push({ message: 'only a message' })
  const plan = planStockPreparationConflicts({
    // keyless expanded row WITH lineage -> `row` granularity identity
    expandedRows: [{ projectNo: 'P-001', componentSourceId: 'PART-NOKEY', path: '["PART-NOKEY"]', depth: 0 }],
    // keyless existing row with NO discriminator -> identity-less deferral
    existingRows: [{ active: true }],
    rowErrors,
    runId: 'run-o1b',
    plannedAt: '2026-06-04T09:00:00.000Z',
  })
  // A KEYED out-of-scope hold rides along, so the three evidence buckets can be
  // asserted disjoint rather than merely non-empty.
  plan.decisions.push(clone(KEYED_OUT_OF_SCOPE_HOLD))
  return plan
}

async function testO1bAnonymousFamiliesLedgerAsPendingAndRepeatReconcileIsStable() {
  const env = ledgerEnv()
  const call = (plan) => reconcileConfirmationDecisions(scopedCall(env, {
    projectNo: 'P-001',
    plan,
    sourceRevision: 'rev-1',
  }))

  const first = await call(anonymousPlan())
  // One decision row per DERIVED IDENTITY: the keyless row, the folded
  // missing_component locus, and the coercion cell.
  assert.equal(first.counts.created, 3)
  assert.equal(first.counts.pending, 3)
  assert.deepEqual(first.evidence.anonymousHoldIdentity.ledgeredByFamily, {
    missing_expanded_idempotency_key: 1,
    missing_component: 1,
    SOURCE_VALUE_NOT_A_NUMBER: 1,
  })
  assert.equal(first.evidence.anonymousHoldIdentity.ledgeredDecisionCount, 3)
  assert.equal(first.evidence.anonymousHoldIdentity.ledgeredHoldCount, 4, 'the locus folded 2 holds into 1 row, and says so')

  // O1B-L5: the three buckets are disjoint and each names families + counts only.
  assert.deepEqual(first.evidence.anonymousHoldIdentity.deferredByFamily, {
    missing_existing_idempotency_key: 1,
    c2_row_error: 1,
  })
  assert.equal(first.evidence.anonymousHoldIdentity.deferralCode, 'ANONYMOUS_HOLD_IDENTITY_UNAVAILABLE')
  assert.deepEqual(first.evidence.outOfScopeManualConfirm, { lineage_mismatch: 1 })
  assert.equal(ledgerRows(env.records).length, 3)

  // VALUES-FREE: the marker carries family tokens and counts, nothing else.
  const marker = JSON.stringify(first.evidence.anonymousHoldIdentity)
  for (const secret of ['PART-NOKEY', 'OBJ_ID', 'WGT', 'ext_weight', 'P-001']) {
    assert.equal(marker.includes(secret), false, `evidence marker must not carry ${secret}`)
  }

  // O1B-L1 proper: a SECOND reconcile built from an equal-but-independent plan
  // must reproduce every decisionId. Without reconcile-reproducibility the rows
  // would churn and no supersede/reopen semantics could hold.
  const before = ledgerRows(env.records).map((row) => row.data.decisionId).sort()
  const replay = await call(anonymousPlan())
  assert.equal(replay.counts.created, 0, 'O1B-L1: repeat reconcile creates nothing')
  assert.equal(replay.counts.existing, 3)
  assert.equal(replay.counts.superseded, 0)
  assert.equal(replay.counts.orphanSuperseded, 0, 'anonymous rows are in the candidate set, so the sweep leaves them alone')
  const after = ledgerRows(env.records).map((row) => row.data.decisionId).sort()
  assert.deepEqual(after, before, 'the same source state reproduces the same decisionIds')
  assert.equal(ledgerRows(env.records).length, 3)

  // Every anonymous row is addressed by a NAMESPACED HASH — the source ids that
  // went into it never come back out of the stored cell.
  for (const row of ledgerRows(env.records)) {
    assert.ok(row.data.rowIdentity.startsWith(ANONYMOUS_HOLD_IDENTITY_PREFIX))
    for (const secret of ['PART-NOKEY', 'OBJ_ID', 'WGT']) {
      assert.equal(row.data.rowIdentity.includes(secret), false)
    }
  }
}

async function testO1bOccurrenceCountChangeSupersedesTheLocusRow() {
  // O1B-L2. Repairing 1 of 2 errors on a locus is a material change: the same
  // stableDecisionKey must open a NEW pending row, never keep riding the old
  // acknowledgement.
  const env = ledgerEnv()
  const call = (plan) => reconcileConfirmationDecisions(scopedCall(env, {
    projectNo: 'P-001',
    plan,
    sourceRevision: 'rev-1',
    now: () => new Date('2026-08-29T10:00:00.000Z'),
  }))

  await call(anonymousPlan({ missingComponentCount: 2 }))
  const second = await call(anonymousPlan({ missingComponentCount: 1 }))
  assert.equal(second.counts.superseded, 1, 'the 2-occurrence locus row is superseded')
  assert.equal(second.counts.created, 1, 'a fresh pending row opens for the 1-occurrence locus')

  const locusRows = ledgerRows(env.records).filter((row) => row.data.conflictType === 'missing_component')
  assert.equal(locusRows.length, 2)
  assert.equal(new Set(locusRows.map((row) => row.data.stableDecisionKey)).size, 1, 'same logical decision, new input')
  assert.equal(new Set(locusRows.map((row) => row.data.inputFingerprint)).size, 2, 'occurrenceCount is bound into the fingerprint')

  // Repairing them ALL removes the conflict from the plan entirely, and the
  // orphan sweep closes the row rather than leaving it pending forever.
  const third = await call(anonymousPlan({ missingComponentCount: 0 }))
  assert.equal(third.counts.orphanSuperseded, 1)
  const stillPending = ledgerRows(env.records).filter((row) => row.data.status === STATUSES.PENDING)
  assert.equal(stillPending.some((row) => row.data.conflictType === 'missing_component'), false)
}

async function testO1bIdentityNamespaceIsFencedBothWays() {
  // O1B-L3. stableDecisionKey folds rowIdentity in, so a row crossing between
  // the two addressing schemes would claim (or be claimed by) somebody else's
  // decision history. Both directions refuse, with one fixed code.
  const env = ledgerEnv()
  const forged = `${ANONYMOUS_HOLD_IDENTITY_PREFIX}row:sha256:${'0'.repeat(32)}`

  await rejectsWithCode(
    () => reconcileConfirmationDecisions(scopedCall(env, {
      projectNo: 'P-001',
      plan: planOf([duplicateHold(forged)]),
      sourceRevision: 'rev-1',
    })),
    'CONFIRMATION_DECISION_IDENTITY_NAMESPACE_VIOLATION',
    'an idempotencyKey may not impersonate a derived identity',
  )

  await rejectsWithCode(
    () => reconcileConfirmationDecisions(scopedCall(env, {
      projectNo: 'P-001',
      plan: planOf([{
        decision: 'manual_confirm',
        conflictSummary: { type: 'missing_component' },
        changedFields: [],
        source: 'c2_row_error',
        derivedRowIdentity: 'not-namespaced',
      }]),
      sourceRevision: 'rev-1',
    })),
    'CONFIRMATION_DECISION_IDENTITY_NAMESPACE_VIOLATION',
    'a derived identity must self-identify by its reserved prefix',
  )

  assert.equal(ledgerRows(env.records).length, 0, 'a refused plan writes nothing')

  // Structural non-collision, not a probabilistic one: a real idempotencyKey is
  // a JSON object literal, so it can never begin with the reserved prefix.
  const realKey = JSON.stringify({ projectNo: 'P-001', componentSourceId: 'PART-A', parentSourceId: null, path: ['PART-A'] })
  assert.equal(realKey.startsWith(ANONYMOUS_HOLD_IDENTITY_PREFIX), false)
  assert.equal(realKey[0], '{')
}

async function testO1bAnonymousRowsCanNeverDowngradeAHold() {
  // O1B-L4. This is the load-bearing boundary of the whole cut: O1-B adds
  // IDENTITY, never write capability.
  const env = ledgerEnv()
  const plan = anonymousPlan()
  await reconcileConfirmationDecisions(scopedCall(env, { projectNo: 'P-001', plan, sourceRevision: 'rev-1' }))

  // Structural half: the readback destructures `candidates`, and anonymous rows
  // are not in it. It cannot filter them out because it never receives them.
  const derived = deriveDecisionCandidates({ projectNo: 'P-001', plan, sourceRevision: 'rev-1' })
  assert.equal(derived.candidates.length, 0, 'no duplicate_expanded_key hold in this plan')
  assert.equal(derived.anonymousCandidates.length, 3)
  for (const candidate of derived.anonymousCandidates) {
    assert.equal(Object.prototype.hasOwnProperty.call(candidate, 'duplicateGroupFingerprint'), false,
      'an anonymous candidate must not carry the field the policy readback consumes')
  }

  // Runtime half #1: the EXISTING confirm boundary already refuses any conflict
  // type outside the first cut, so an anonymous row is ledgered as a visible
  // PENDING queue entry that cannot even be confirmed yet. O1-B leaves that
  // boundary untouched — this cut adds identity, not a resolution surface.
  const list = await listConfirmationDecisions(scopedCall(env, { projectNo: 'P-001', status: STATUSES.PENDING }))
  assert.equal(list.rows.length, 3)
  for (const row of list.rows) {
    await rejectsWithCode(
      () => confirmConfirmationDecision(scopedCall(env, {
        decisionId: row.decisionId,
        inputFingerprint: row.inputFingerprint,
        resolutionAction: RESOLUTION_ACTIONS.KEEP_MULTIPLE_ROWS,
        confirmedBy: 'admin-user',
      })),
      'CONFIRMATION_DECISION_ACTION_CONFLICT_MISMATCH',
      'an anonymous-family row has no implemented resolution action',
    )
  }

  // Runtime half #2: the readback wall must NOT depend on that confirm guard.
  // Seed an anonymous row that is already CONFIRMED with the resolving policy —
  // whatever future path might produce one — alongside a genuine duplicate hold
  // so the readback actually queries instead of returning early. It must still
  // emit no policy for the anonymous row.
  const anonymousCandidate = derived.anonymousCandidates[0]
  const planWithDuplicate = anonymousPlan()
  planWithDuplicate.decisions.push(duplicateHold('KEY-A'))
  const forcedEnv = ledgerEnv({
    rows: [seedLedgerRow({
      decisionId: anonymousCandidate.decisionId,
      stableDecisionKey: anonymousCandidate.stableDecisionKey,
      projectNo: 'P-001',
      rowIdentity: anonymousCandidate.rowIdentity,
      conflictType: anonymousCandidate.conflictType,
      inputFingerprint: anonymousCandidate.inputFingerprint,
      sourceRevision: 'rev-1',
      status: STATUSES.CONFIRMED,
      resolutionAction: RESOLUTION_ACTIONS.KEEP_MULTIPLE_ROWS,
      openedAt: '2026-08-29T10:00:00.000Z',
      confirmedBy: 'admin-user',
      confirmedAt: '2026-08-29T10:00:00.000Z',
    }, 'rec-forced-anonymous')],
  })
  const forcedReview = await loadConfirmedDuplicatePolicyReview(scopedCall(forcedEnv, {
    projectNo: 'P-001',
    plan: planWithDuplicate,
    sourceRevision: 'rev-1',
  }))
  assert.deepEqual(forcedReview.policies, [], 'O1B-L4: even a CONFIRMED anonymous row downgrades nothing')

  // The queue projection stays values-free for the new rows too.
  const queue = await listConfirmationDecisions(scopedCall(env, { projectNo: 'P-001' }))
  const serialized = JSON.stringify(queue)
  for (const secret of ['PART-NOKEY', 'OBJ_ID', 'WGT', 'rowIdentity']) {
    assert.equal(serialized.includes(secret), false, `queue surface must not carry ${secret}`)
  }
}

async function main() {
  const tests = [
    testLedgerHoldsNoCanonicalWriteCapability,
    testMigration077DefinesTheDbLevelLease,
    testInspectAndEnsureProvisionTheLedgerObject,
    testA01SameFingerprintReconcileReplayIsIdempotent,
    testA02FingerprintChangeSupersedesAndOldConfirmationDoesNotClearNewConflict,
    testA03OutOfScopeConflictAndUnknownActionRefusedWithZeroCanonicalWrites,
    testA04TwoIndependentReconcilersYieldOneActiveDecision,
    testW4aFingerprintReturnReopensSupersededRowAndClearsHumanDecision,
    testW4bVanishedConflictSweepClosesOrphanPendingRows,
    testW4cLeaseOverrunAbortsWithFixedCodeAndNoDuplicateActiveRows,
    testConfirmRefusesUnregisteredMalformedAndStale,
    testReadbackDowngradesOnlyConfirmedMatchingKeepMultipleRows,
    testQueueEndpointEmitsNoCellValues,
    testEndToEndConfirmedDecisionDowngradesTheDuplicateHold,
    testO1bAnonymousFamiliesLedgerAsPendingAndRepeatReconcileIsStable,
    testO1bOccurrenceCountChangeSupersedesTheLocusRow,
    testO1bIdentityNamespaceIsFencedBothWays,
    testO1bAnonymousRowsCanNeverDowngradeAHold,
  ]
  for (const test of tests) {
    await test()
    console.log(`  ${test.name} OK`)
  }
  console.log('stock-preparation-confirmation-decisions.test.cjs OK')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
