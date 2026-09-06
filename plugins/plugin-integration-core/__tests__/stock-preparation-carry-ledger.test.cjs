'use strict'

// W4 carry-policy WIRING, ledger side (mission piece 3): the three carry conflict types
// (carry_ambiguous_component_source / carry_reattach_requires_confirm /
// carry_conflicting_source_content — stock-preparation-carry-policy.cjs CARRY_CONFLICT_TYPES)
// become LEDGERABLE, while their confirm-apply routes ONLY through the W4a executor
// (applyCarryViaConfirm in confirm-writes) — never the first-cut apply path. Locked walls:
//
//   L1  deriveDecisionCandidates returns carry candidates in a SEPARATE carryCandidates array —
//       structurally invisible to the duplicate-policy readback (which destructures `candidates`),
//       and with NO duplicateGroupFingerprint, so no confirmed carry row can ever emit a policy.
//   L2  reconcile ledgers carry holds as PENDING rows (created / replay-idempotent / evidence
//       stanza values-free); the queue list shows them with their conflictType token unfiltered
//       (mission piece 7 — the READ path needs no change beyond the rows existing).
//   L3  the FIRST-CUT confirm endpoint REFUSES a carry-type row with a closed code pointing at
//       the carry confirm surface — first-cut resolution actions can never touch a carry row.
//   L4  confirmCarryConfirmationDecision (the narrow ledger-close the W4b route calls AFTER the
//       executor applied) confirms a pending carry row with the reserved carry_via_confirm
//       resolution token — which is NOT in the first-cut vocabulary, NOT accepted by the generic
//       confirm, and mapped to NO readback policy.
//   L5  even a CONFIRMED carry row emits ZERO policies from loadConfirmedDuplicatePolicyReview.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const {
  OBJECT_ID,
  FIRST_CUT_CONFLICT_TYPE,
  STATUSES,
  RESOLUTION_ACTIONS,
  CARRY_RESOLUTION_ACTION,
  StockPreparationConfirmationDecisionError,
  createConfirmationDecisionReconcileLease,
  deriveDecisionCandidates,
  reconcileConfirmationDecisions,
  listConfirmationDecisions,
  confirmConfirmationDecision,
  confirmCarryConfirmationDecision,
  loadConfirmedDuplicatePolicyReview,
} = require(path.join(LIB, 'stock-preparation-confirmation-decisions.cjs'))
const { CARRY_CONFLICT_TYPES } = require(path.join(LIB, 'stock-preparation-carry-policy.cjs'))
const {
  makeFakeProvisioning,
  makeStrictRecordsApi,
  logicalData,
} = require(path.join(__dirname, 'fixtures', 'stock-preparation-multitable-fakes.cjs'))

const STAGING = 'tenant-a:integration-core'
const LEDGER_SHEET = 'sheet_confirmation_decisions'
const PROJECT_NO = 'P-CARRY-01'
const REVISION = 'rev-carry-1'

let passed = 0
let failed = 0
const failures = []

function run(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1 })
    .catch((error) => {
      failed += 1
      failures.push(name)
      console.error(`FAIL: ${name}`)
      console.error(error && error.stack ? error.stack : error)
    })
}

function makeFakeLeaseDb() {
  const rows = new Map()
  return {
    rows,
    async insertOne(table, row) {
      if (rows.has(row.scope_key)) {
        const error = new Error('duplicate key')
        error.code = '23505'
        throw error
      }
      rows.set(row.scope_key, { ...row })
      return [{ ...row }]
    },
    async selectOne(table, where) {
      const row = rows.get(where.scope_key)
      return row ? { ...row } : null
    },
    async updateRow(table, set, where) {
      const row = rows.get(where.scope_key)
      if (!row || row.lease_id !== where.lease_id) return []
      Object.assign(row, set)
      return [{ ...row }]
    },
    async deleteRows(table, where) {
      const row = rows.get(where.scope_key)
      if (!row || row.lease_id !== where.lease_id) return []
      rows.delete(where.scope_key)
      return [{ ...row }]
    },
  }
}

function ledgerEnv({ rows = [] } = {}) {
  const provisioning = makeFakeProvisioning({
    stagingProjectId: STAGING,
    sheetIdByObjectId: { [OBJECT_ID]: LEDGER_SHEET },
  })
  const records = makeStrictRecordsApi({
    stagingProjectId: STAGING,
    objectIdBySheetId: { [LEDGER_SHEET]: OBJECT_ID },
    rowsBySheet: { [LEDGER_SHEET]: rows },
  })
  const lease = createConfirmationDecisionReconcileLease({ db: makeFakeLeaseDb() })
  return { provisioning, records, lease }
}

function ledgerRows(env) {
  return env.records.rows(LEDGER_SHEET).map((row) => ({ id: row.id, data: logicalData(STAGING, OBJECT_ID, row.data) }))
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

const NEW_KEY = JSON.stringify({ projectNo: PROJECT_NO, componentSourceId: 'COMP-X', parentSourceId: null, path: ['NEW', 'COMP-X'] })
const OLD_KEY = JSON.stringify({ projectNo: PROJECT_NO, componentSourceId: 'COMP-X', parentSourceId: null, path: ['OLD', 'COMP-X'] })

function carryProposalHold() {
  return {
    decision: 'manual_confirm',
    idempotencyKey: NEW_KEY,
    conflictSummary: { type: 'carry_reattach_requires_confirm', proposed: true },
    changedFields: [],
    source: 'carry_policy',
    carryProposal: {
      decision: 'carry_via_confirm',
      idempotencyKey: NEW_KEY,
      sourceIdempotencyKey: OLD_KEY,
      componentSourceId: 'COMP-X',
      carryKey: 'component_source_id',
      manualRowReattach: 'propose_confirm',
      carryFields: ['notes'],
      writeVia: 'k2_confirm',
      requiresConfirm: true,
      carry: true,
    },
  }
}

function ambiguousCarryHold() {
  return {
    decision: 'manual_confirm',
    idempotencyKey: NEW_KEY,
    componentSourceId: 'COMP-X',
    carryKey: 'component_source_id',
    manualRowReattach: 'propose_confirm',
    conflictSummary: { type: 'carry_ambiguous_component_source', matchCount: 2 },
    source: 'carry_policy',
    carry: false,
  }
}

function duplicateHold(key) {
  return {
    decision: 'manual_confirm',
    idempotencyKey: key,
    conflictSummary: { type: FIRST_CUT_CONFLICT_TYPE, count: 2 },
    changedFields: [],
    source: 'expanded_rows',
  }
}

async function rejectsWithCode(promiseFactory, code, message) {
  await assert.rejects(promiseFactory, (error) => {
    assert.ok(error instanceof StockPreparationConfirmationDecisionError,
      `${message}: expected ledger error, got ${error && error.name}: ${error && error.message}`)
    assert.equal(error.code, code, `${message}: expected ${code}, got ${error.code}`)
    return true
  })
}

async function main() {
  // L1 — structural separation in the candidate derivation.
  await run('L1: carry holds derive into a SEPARATE carryCandidates array (keyed, no duplicateGroupFingerprint)', () => {
    const derived = deriveDecisionCandidates({
      projectNo: PROJECT_NO,
      plan: { decisions: [carryProposalHold(), ambiguousCarryHold(), duplicateHold(NEW_KEY)] },
      sourceRevision: REVISION,
    })
    assert.ok(Array.isArray(derived.carryCandidates), 'derivation returns a carryCandidates array')
    assert.equal(derived.carryCandidates.length, 2)
    assert.equal(derived.candidates.length, 1, 'only the duplicate hold rides the readback-visible array')
    assert.equal(derived.candidates[0].conflictType, FIRST_CUT_CONFLICT_TYPE)
    const types = derived.carryCandidates.map((candidate) => candidate.conflictType).sort()
    assert.deepEqual(types, ['carry_ambiguous_component_source', 'carry_reattach_requires_confirm'])
    for (const candidate of derived.carryCandidates) {
      assert.equal(candidate.rowIdentity, NEW_KEY)
      assert.equal(Object.prototype.hasOwnProperty.call(candidate, 'duplicateGroupFingerprint'), false,
        'a carry candidate must never carry the readback fingerprint')
    }
    // carry types no longer land in the out-of-scope tally.
    assert.deepEqual(derived.outOfScopeByConflictType, {})
  })

  await run('L1-b: distinct carry conflict types on ONE key are distinct decisions; same type+key+input is one', () => {
    const derived = deriveDecisionCandidates({
      projectNo: PROJECT_NO,
      plan: { decisions: [carryProposalHold(), carryProposalHold()] },
      sourceRevision: REVISION,
    })
    // Two identical holds → same decisionId; reconcile's seenThisRun collapses them.
    assert.equal(derived.carryCandidates.length, 2)
    assert.equal(derived.carryCandidates[0].decisionId, derived.carryCandidates[1].decisionId)
  })

  // L2 — reconcile ledgers carry rows pending; replay idempotent; queue shows them.
  await run('L2: reconcile ledgers carry holds pending; replay is a no-op; the queue lists them with their conflictType token', async () => {
    const env = ledgerEnv()
    const plan = { decisions: [carryProposalHold(), ambiguousCarryHold()] }
    const first = await reconcileConfirmationDecisions(scopedCall(env, {
      projectNo: PROJECT_NO,
      plan,
      sourceRevision: REVISION,
    }))
    assert.equal(first.counts.created, 2)
    assert.equal(first.counts.pending, 2)
    assert.ok(first.evidence.carryDecisions, 'reconcile evidence names the carry stanza when carry rows ledgered')
    assert.equal(first.evidence.carryDecisions.ledgeredDecisionCount, 2)
    assert.deepEqual(first.evidence.carryDecisions.ledgeredByConflictType, {
      carry_reattach_requires_confirm: 1,
      carry_ambiguous_component_source: 1,
    })

    const replay = await reconcileConfirmationDecisions(scopedCall(env, {
      projectNo: PROJECT_NO,
      plan,
      sourceRevision: REVISION,
    }))
    assert.equal(replay.counts.created, 0, 'replay must not grow the ledger')
    assert.equal(replay.counts.existing, 2)
    assert.equal(ledgerRows(env).length, 2)

    // Piece 7 — the queue READ path shows carry rows without any filter change.
    const queue = await listConfirmationDecisions(scopedCall(env, { projectNo: PROJECT_NO }))
    assert.equal(queue.rowCount, 2)
    const queueTypes = queue.rows.map((row) => row.conflictType).sort()
    assert.deepEqual(queueTypes, ['carry_ambiguous_component_source', 'carry_reattach_requires_confirm'])
    for (const row of queue.rows) {
      assert.equal(row.status, STATUSES.PENDING)
    }
    // Values-free: the queue must not carry the row identity (which embeds source paths).
    assert.equal(JSON.stringify(queue).includes('COMP-X'), false, 'queue projection stays values-free')
  })

  await run('L2-b: no-carry deployments produce byte-identical reconcile evidence (no carry stanza)', async () => {
    const env = ledgerEnv()
    const result = await reconcileConfirmationDecisions(scopedCall(env, {
      projectNo: PROJECT_NO,
      plan: { decisions: [duplicateHold(NEW_KEY)] },
      sourceRevision: REVISION,
    }))
    assert.equal(Object.prototype.hasOwnProperty.call(result.evidence, 'carryDecisions'), false,
      'no carry rows => no carry evidence key')
  })

  // L3 — the first-cut confirm face refuses carry rows with a closed pointer code.
  await run('L3: first-cut confirm refuses a carry-type row (closed code; row untouched)', async () => {
    const env = ledgerEnv()
    await reconcileConfirmationDecisions(scopedCall(env, {
      projectNo: PROJECT_NO,
      plan: { decisions: [carryProposalHold()] },
      sourceRevision: REVISION,
    }))
    const row = ledgerRows(env)[0]
    await rejectsWithCode(
      () => confirmConfirmationDecision(scopedCall(env, {
        decisionId: row.data.decisionId,
        inputFingerprint: row.data.inputFingerprint,
        resolutionAction: RESOLUTION_ACTIONS.KEEP_MULTIPLE_ROWS,
        confirmedBy: 'user-a',
      })),
      'CONFIRMATION_DECISION_CARRY_CONFIRMS_VIA_CARRY_ROUTE',
      'first-cut confirm on a carry row',
    )
    assert.equal(ledgerRows(env)[0].data.status, STATUSES.PENDING, 'the carry row stays pending')
  })

  await run('L3-b: the reserved carry token is refused by the generic confirm (not first-cut vocabulary)', async () => {
    const env = ledgerEnv()
    await reconcileConfirmationDecisions(scopedCall(env, {
      projectNo: PROJECT_NO,
      plan: { decisions: [duplicateHold(NEW_KEY)] },
      sourceRevision: REVISION,
    }))
    const row = ledgerRows(env)[0]
    await rejectsWithCode(
      () => confirmConfirmationDecision(scopedCall(env, {
        decisionId: row.data.decisionId,
        inputFingerprint: row.data.inputFingerprint,
        resolutionAction: CARRY_RESOLUTION_ACTION,
        confirmedBy: 'user-a',
      })),
      'CONFIRMATION_DECISION_ACTION_INVALID',
      'carry_via_confirm through the generic confirm',
    )
  })

  // L4 — the narrow carry ledger-close.
  await run('L4: confirmCarryConfirmationDecision confirms a pending carry row with the reserved token; replay skips; walls hold', async () => {
    const env = ledgerEnv()
    await reconcileConfirmationDecisions(scopedCall(env, {
      projectNo: PROJECT_NO,
      plan: { decisions: [carryProposalHold()] },
      sourceRevision: REVISION,
    }))
    const row = ledgerRows(env)[0]

    const confirmed = await confirmCarryConfirmationDecision(scopedCall(env, {
      decisionId: row.data.decisionId,
      inputFingerprint: row.data.inputFingerprint,
      // The close is BOUND to the decision it applies (P1 fix): the row's rowIdentity, its
      // stableDecisionKey and its inputFingerprint are all re-derived from this object.
      decision: carryProposalHold().carryProposal,
      confirmedBy: 'user-a',
      now: () => new Date('2026-09-02T00:00:00.000Z'),
    }))
    assert.equal(confirmed.ok, true)
    assert.equal(confirmed.status, STATUSES.CONFIRMED)
    assert.equal(confirmed.resolutionAction, CARRY_RESOLUTION_ACTION)
    const stored = ledgerRows(env)[0].data
    assert.equal(stored.status, STATUSES.CONFIRMED)
    assert.equal(stored.resolutionAction, CARRY_RESOLUTION_ACTION)
    assert.equal(stored.confirmedBy, 'user-a')
    assert.equal(stored.confirmedAt, '2026-09-02T00:00:00.000Z')

    // Replay: already carry-confirmed → skip, never 409, never a second write.
    const replay = await confirmCarryConfirmationDecision(scopedCall(env, {
      decisionId: row.data.decisionId,
      inputFingerprint: row.data.inputFingerprint,
      decision: carryProposalHold().carryProposal,
      confirmedBy: 'user-b',
    }))
    assert.equal(replay.persisted, false)
    assert.equal(replay.mode, 'skipped_already_confirmed')
    assert.equal(ledgerRows(env)[0].data.confirmedBy, 'user-a', 'replay must not restamp')
  })

  await run('L4-b: carry ledger-close refuses fingerprint drift and non-carry rows', async () => {
    const env = ledgerEnv()
    await reconcileConfirmationDecisions(scopedCall(env, {
      projectNo: PROJECT_NO,
      plan: { decisions: [carryProposalHold(), duplicateHold(OLD_KEY)] },
      sourceRevision: REVISION,
    }))
    const rows = ledgerRows(env)
    const carryRow = rows.find((entry) => entry.data.conflictType === 'carry_reattach_requires_confirm')
    const duplicateRow = rows.find((entry) => entry.data.conflictType === FIRST_CUT_CONFLICT_TYPE)

    await rejectsWithCode(
      () => confirmCarryConfirmationDecision(scopedCall(env, {
        decisionId: carryRow.data.decisionId,
        inputFingerprint: 'stale-fingerprint',
        decision: carryProposalHold().carryProposal,
        confirmedBy: 'user-a',
      })),
      'CONFIRMATION_DECISION_REVISION_MISMATCH',
      'stale fingerprint on carry ledger-close',
    )
    await rejectsWithCode(
      () => confirmCarryConfirmationDecision(scopedCall(env, {
        decisionId: duplicateRow.data.decisionId,
        inputFingerprint: duplicateRow.data.inputFingerprint,
        decision: carryProposalHold().carryProposal,
        confirmedBy: 'user-a',
      })),
      'CONFIRMATION_DECISION_ACTION_CONFLICT_MISMATCH',
      'carry ledger-close on a duplicate row',
    )
    // P1 fix, contract leg: the close CANNOT be called without the decision it applies — an
    // unbound close is exactly what let one pair's carry stamp another pair's hold.
    await rejectsWithCode(
      () => confirmCarryConfirmationDecision(scopedCall(env, {
        decisionId: carryRow.data.decisionId,
        inputFingerprint: carryRow.data.inputFingerprint,
        confirmedBy: 'user-a',
      })),
      'CONFIRMATION_DECISION_CARRY_DECISION_REQUIRED',
      'carry ledger-close without the bound decision',
    )
    assert.equal(
      ledgerRows(env).find((entry) => entry.data.conflictType === 'carry_reattach_requires_confirm').data.status,
      STATUSES.PENDING,
      'every refusal above left the row pending',
    )
  })

  // L5 — readback blindness, even for confirmed carry rows.
  await run('L5: a CONFIRMED carry row emits ZERO readback policies (structural blindness)', async () => {
    const env = ledgerEnv()
    const plan = { decisions: [carryProposalHold()] }
    await reconcileConfirmationDecisions(scopedCall(env, {
      projectNo: PROJECT_NO,
      plan,
      sourceRevision: REVISION,
    }))
    const row = ledgerRows(env)[0]
    await confirmCarryConfirmationDecision(scopedCall(env, {
      decisionId: row.data.decisionId,
      inputFingerprint: row.data.inputFingerprint,
      decision: carryProposalHold().carryProposal,
      confirmedBy: 'user-a',
    }))
    const readback = await loadConfirmedDuplicatePolicyReview(scopedCall(env, {
      projectNo: PROJECT_NO,
      plan,
      sourceRevision: REVISION,
    }))
    assert.deepEqual(readback.policies, [], 'no carry row may ever release a duplicate hold')
  })

  console.log(`carry-ledger: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.error(`failures: ${failures.join(', ')}`)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
