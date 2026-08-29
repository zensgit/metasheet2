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

async function main() {
  const tests = [
    testLedgerHoldsNoCanonicalWriteCapability,
    testMigration077DefinesTheDbLevelLease,
    testInspectAndEnsureProvisionTheLedgerObject,
    testA01SameFingerprintReconcileReplayIsIdempotent,
    testA02FingerprintChangeSupersedesAndOldConfirmationDoesNotClearNewConflict,
    testA03OutOfScopeConflictAndUnknownActionRefusedWithZeroCanonicalWrites,
    testA04TwoIndependentReconcilersYieldOneActiveDecision,
    testConfirmRefusesUnregisteredMalformedAndStale,
    testReadbackDowngradesOnlyConfirmedMatchingKeepMultipleRows,
    testQueueEndpointEmitsNoCellValues,
    testEndToEndConfirmedDecisionDowngradesTheDuplicateHold,
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
