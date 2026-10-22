'use strict'

// Batch-refresh phase 0 step 1 — the small-lane APPLY under the project write guard.
//
//   T1  the single-use dry-run token is claimed ATOMICALLY (one `consume`, no get+delete), and a store
//       without `consume` is refused 501 rather than claimed non-atomically.
//   G   BYTE IDENTITY: the revision / source-content / archive digests, the dry-run evidence and the
//       response key set are the literals captured on a clean origin/main (4c78e75a0) before this change.
//   T2  the binding is three keys stored ALONGSIDE the token record — not in the response, not in the
//       evidence, not in any revision (generation 3 and generation 99 plan byte-identically).
//   T3  E03: token A (generation 1) after token B (generation 2) -> A is PLAN_SUPERSEDED with zero
//       writes, B applies.
//   T4  an unbound token (minted without the lock) is refused token_unbound.
//   T5  no guard -> 501, a guard for another scope -> 500; neither burns the token nor writes.
//   T6  E04 / E08: a preview while a write is in flight is refused and moves nothing; after a lapse
//       (>= TTL + GRACE) the preview supersedes, the stalled writer's one in-flight write is the
//       accepted residual, and its next write is fenced (LEASE_LOST, partial counts).
//   T7  a lock store failure mid-run stops the writer: 503 with the partial counts.
//   T9  E02 / R-52: the scope is the SHEET. Another project on the same sheet is excluded (the race in
//       which two projects both pass the foreign-row guard of one empty sheet); the same project on
//       another sheet proceeds; one sheet under two tenant strings is ONE scope.
//
// Every value here is synthetic (support/stock-preparation-project-write-lock-kit.cjs).

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  applyStockPreparationAction,
  dryRunStockPreparationAction,
  prepareStockPreparationMvpSnapshot,
  stockPreparationSourceContentDigest,
  __internals: tableActionInternals,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-table-actions.cjs'))
const {
  PROJECT_WRITE_ERROR_CODES,
  PROJECT_WRITE_LEASE_TAKEOVER_GRACE_MS,
  PROJECT_WRITE_LEASE_TTL_MS,
  PROJECT_WRITE_LOCK_TABLE,
  sheetWriteScopeKey,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-project-write-lock.cjs'))
const { withoutReadPhaseClock } = require('./support/dry-run-read-phase-clock.cjs')
const kit = require(path.join(__dirname, 'support', 'stock-preparation-project-write-lock-kit.cjs'))

const tests = []
const test = (name, fn) => tests.push([name, fn])

// Captured on a CLEAN origin/main (4c78e75a0, lib untouched) with the same synthetic fixture and the
// same calls, before any line of this change existed. Asserted as literals: a generation (or anything
// else of this change) leaking into a revision, a digest or the evidence turns these red.
const GOLDEN = Object.freeze({
  dryRunRevision: '3585797fa18bb8817ba3079f4936c61393f2b0d8a62ab87d34bd24430e32aa7d',
  dryRunEvidenceHash: '6e3067bf1f2973a51d77d227767913778040ed07b7e150e271bc94b665ffefd1',
  dryRunResponseKeys: ['action', 'boundedPreview', 'canApply', 'counts', 'dryRunToken', 'evidence', 'largeBom', 'plmReadPhase', 'revision', 'status'],
  tokenRecordKeys: ['actionId', 'conflictPolicyReview', 'createdAt', 'expiresAt', 'parametersHash', 'revision'],
  tokenComparedHash: 'a6670f18d015b7f0f7eb1bfbba63fe17b7bc012dc596f653efbb7949c1f3748b',
  applySourceContentRevision: '3cbd8b9d7ac44bb4e3098e68a0910acec01ab1101c5d69869535031acc5c8096',
  applySourceContentDigest: '0926db3aef05c123f3606f6a5a4d3385',
  applyEvidenceHash: 'aa43c4633296745f4974ca6dff8d8a9a52728077cda0ba25560fa3ef49fa71a2',
  secondDryRunRevision: '602bc968860dfe321b22af2bd4f5631fdb91f00e214413d4c4d04bcfa9acfd91',
  secondDryRunEvidenceHash: '0cf2cfdc5e9d55ababdca2574aad6c4da4077d1bc420b990c2bee2c075bac5be',
  archiveRevision: '602bc968860dfe321b22af2bd4f5631fdb91f00e214413d4c4d04bcfa9acfd91',
})

// One synthetic project on one sheet, driven the way the routes drive the lib: the dry-run through the
// generation binder, the apply inside the lease with the guard (kit.createLibWriteLockHarness).
function scenario({ harness, sheetId = kit.GOLDEN_SHEET_ID, projectNo = kit.GOLDEN_PROJECT_NO, records, storage, tenantId } = {}) {
  const action = kit.goldenAction({ target: { sheetId, objectId: 'stockPreparationMain' } })
  const parameters = { projectNo }
  const source = kit.createSourceAdapter(kit.goldenPlmData(projectNo))
  const rec = records || kit.createRecordsApi()
  const store = storage || kit.createConsumableStorage()
  const common = { action, parameters, sourceAdapter: source.adapter, recordsApi: rec.recordsApi, plannedAt: kit.GOLDEN_PLANNED_AT, runId: kit.GOLDEN_RUN_ID, ...(tenantId ? { tenantId } : {}) }
  return {
    action,
    parameters,
    source,
    records: rec,
    storage: store,
    scope: sheetWriteScopeKey(sheetId),
    dryRun: (extra = {}) => harness.wrapDryRun(dryRunStockPreparationAction)({ ...common, tokenStore: store, ...extra }),
    apply: (token, extra = {}) => harness.wrapApply(applyStockPreparationAction)({
      ...common, dryRunToken: token, permission: 'write', tokenStore: store, sandboxPolicy: kit.SANDBOX_POLICY, ...extra,
    }),
  }
}

function tokenRecordOf(storage) {
  const records = Array.from(storage.map.values())
  assert.equal(records.length, 1, 'exactly one token is stored')
  return records[0]
}

function expectCode(code, status) {
  return (error) => {
    assert.equal(error.code, code, `${error.code}: ${error.message}`)
    if (status !== undefined) assert.equal(error.status, status)
    return true
  }
}

async function mintToken(storage, record = {}) {
  return tableActionInternals.createDryRunToken(storage, {
    actionId: 'swl-action',
    parametersHash: 'swl-parameters-hash',
    revision: 'swl-revision',
    conflictPolicyReview: null,
    ...record,
  })
}

// ── T1 ────────────────────────────────────────────────────────────────────────────────────────────
test('T1 eight concurrent claims of ONE token: exactly one gets the record, the other seven are TOKEN_INVALID', async () => {
  const storage = kit.createConsumableStorage()
  const token = await mintToken(storage)
  const expected = { actionId: 'swl-action', parametersHash: 'swl-parameters-hash' }
  const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () =>
    tableActionInternals.consumeDryRunToken(storage, token, expected)))
  const won = outcomes.filter((outcome) => outcome.status === 'fulfilled')
  const lost = outcomes.filter((outcome) => outcome.status === 'rejected')
  assert.equal(won.length, 1, 'exactly one claimant gets the token')
  assert.equal(won[0].value.revision, 'swl-revision')
  assert.equal(lost.length, 7)
  for (const outcome of lost) {
    assert.equal(outcome.reason.status, 409)
    assert.equal(outcome.reason.code, 'TABLE_ACTION_DRY_RUN_TOKEN_INVALID')
  }
  assert.equal(storage.map.size, 0, 'the token is gone')
  // The claim is ONE operation: no get, no delete.
  const claimOps = storage.calls.filter(([op]) => op !== 'set').map(([op]) => op)
  assert.deepEqual(claimOps, Array(8).fill('consume'))
})

test('T1 a store without consume is refused 501 TABLE_ACTION_TOKEN_STORE_UNAVAILABLE and the token is left in place', async () => {
  const storage = kit.createConsumableStorage({ withConsume: false })
  const token = await mintToken(storage)
  await assert.rejects(
    () => tableActionInternals.consumeDryRunToken(storage, token, { actionId: 'swl-action', parametersHash: 'swl-parameters-hash' }),
    (error) => error.status === 501 && error.code === 'TABLE_ACTION_TOKEN_STORE_UNAVAILABLE',
  )
  assert.equal(storage.map.size, 1, 'nothing was claimed')
  assert.deepEqual(storage.calls.map(([op]) => op), ['set'], 'no get / delete fallback was attempted')
})

test('T1 the existing refusals keep their codes, and a refused token stays burned', async () => {
  const storage = kit.createConsumableStorage()
  await assert.rejects(
    () => tableActionInternals.consumeDryRunToken(storage, '  ', { actionId: 'a', parametersHash: 'h' }),
    (error) => error.status === 400 && error.code === 'TABLE_ACTION_DRY_RUN_TOKEN_REQUIRED',
  )
  const mismatched = await mintToken(storage)
  await assert.rejects(
    () => tableActionInternals.consumeDryRunToken(storage, mismatched, { actionId: 'swl-action', parametersHash: 'other' }),
    (error) => error.status === 409 && error.code === 'TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH',
  )
  await assert.rejects(
    () => tableActionInternals.consumeDryRunToken(storage, mismatched, { actionId: 'swl-action', parametersHash: 'swl-parameters-hash' }),
    (error) => error.status === 409 && error.code === 'TABLE_ACTION_DRY_RUN_TOKEN_INVALID',
    'a mismatched claim burns the token (single-use semantics unchanged)',
  )
  const expired = await mintToken(storage)
  const key = Array.from(storage.map.keys()).find((k) => k.endsWith(expired))
  storage.map.set(key, { ...storage.map.get(key), expiresAt: '2000-01-01T00:00:00.000Z' })
  await assert.rejects(
    () => tableActionInternals.consumeDryRunToken(storage, expired, { actionId: 'swl-action', parametersHash: 'swl-parameters-hash' }),
    (error) => error.status === 409 && error.code === 'TABLE_ACTION_DRY_RUN_TOKEN_INVALID',
  )
  assert.equal(storage.map.size, 0)
})

// ── G: byte identity against the clean-tree literals ────────────────────────────────────────────────
test('G the revision, source-content, archive digests, evidence and response keys equal the clean-tree literals (through binder + guard)', async () => {
  const harness = kit.createLibWriteLockHarness()
  const s = scenario({ harness })
  const dry = await s.dryRun()
  assert.equal(dry.revision, GOLDEN.dryRunRevision)
  assert.equal(kit.hashJsonForGolden(dry.evidence), GOLDEN.dryRunEvidenceHash)
  assert.deepEqual(Object.keys(dry).sort(), GOLDEN.dryRunResponseKeys, 'no new response key')
  const record = tokenRecordOf(s.storage)
  assert.deepEqual(Object.keys(record).sort(), [...GOLDEN.tokenRecordKeys, 'writeGeneration', 'writeGenerationToken', 'writeScope'].sort(), 'the record gains exactly the three binding keys')
  assert.equal(kit.hashJsonForGolden({ actionId: record.actionId, parametersHash: record.parametersHash, revision: record.revision, conflictPolicyReview: record.conflictPolicyReview }), GOLDEN.tokenComparedHash, 'the compared subset is unchanged')
  const applied = await s.apply(dry.dryRunToken)
  assert.equal(applied.status, 'succeeded')
  assert.equal(applied.dryRunRevision, GOLDEN.dryRunRevision)
  assert.equal(applied.sourceContentRevision, GOLDEN.applySourceContentRevision)
  assert.equal(stockPreparationSourceContentDigest(applied.sourceContentRevision), GOLDEN.applySourceContentDigest)
  assert.equal(kit.hashJsonForGolden(applied.evidence), GOLDEN.applyEvidenceHash)
  const second = await s.dryRun()
  assert.equal(second.revision, GOLDEN.secondDryRunRevision)
  assert.equal(kit.hashJsonForGolden(second.evidence), GOLDEN.secondDryRunEvidenceHash)
  const snapshot = await prepareStockPreparationMvpSnapshot({ action: s.action, parameters: s.parameters, sourceAdapter: s.source.adapter, recordsApi: s.records.recordsApi, plannedAt: kit.GOLDEN_PLANNED_AT, runId: kit.GOLDEN_RUN_ID })
  assert.equal(snapshot.archiveRevision, GOLDEN.archiveRevision)
})

// ── T2 ────────────────────────────────────────────────────────────────────────────────────────────
test('T2 the binding is stored alongside the token only: generation 3 and generation 99 plan byte-identically', async () => {
  const harness = kit.createLibWriteLockHarness()
  const s = scenario({ harness })
  for (let i = 0; i < 2; i += 1) await harness.lock.bumpGeneration(s.scope, { reason: 'small_preview' })
  const at3 = await s.dryRun()
  const record3 = tokenRecordOf(s.storage)
  assert.equal(record3.writeGeneration, 3)
  assert.equal(record3.writeScope, s.scope)
  assert.equal(typeof record3.writeGenerationToken, 'string')
  s.storage.map.clear()
  for (let i = 0; i < 95; i += 1) await harness.lock.bumpGeneration(s.scope, { reason: 'small_preview' })
  const at99 = await s.dryRun()
  assert.equal(tokenRecordOf(s.storage).writeGeneration, 99)
  const comparable = (dry) => { const { dryRunToken, ...rest } = withoutReadPhaseClock(dry); assert.equal(typeof dryRunToken, 'string'); return rest }
  assert.deepEqual(comparable(at99), comparable(at3), 'response (token aside) and evidence are deep-equal')
  assert.equal(at99.revision, GOLDEN.dryRunRevision)
  const text = JSON.stringify(at99)
  for (const key of ['writeScope', 'writeGeneration', 'writeGenerationToken', record3.writeGenerationToken, s.scope]) {
    assert.equal(text.includes(key), false, `the response never carries ${key}`)
  }
})

// ── T3 ────────────────────────────────────────────────────────────────────────────────────────────
test('T3 (E03) token A planned at generation 1, token B at generation 2: A is PLAN_SUPERSEDED before any read or write, B applies', async () => {
  const harness = kit.createLibWriteLockHarness()
  const s = scenario({ harness })
  const a = await s.dryRun()
  const b = await s.dryRun()
  const readsBefore = s.source.calls.length
  await assert.rejects(() => s.apply(a.dryRunToken), (error) => {
    assert.equal(error.code, PROJECT_WRITE_ERROR_CODES.PLAN_SUPERSEDED)
    assert.equal(error.status, 409)
    assert.equal(error.details.reason, 'newer_plan')
    assert.equal(error.details.tokenGeneration, 1)
    assert.equal(error.details.currentGeneration, 2)
    return true
  })
  assert.equal(s.records.writes().length, 0, 'zero writes')
  assert.equal(s.source.calls.length, readsBefore, 'zero source reads: refused before the re-plan')
  await assert.rejects(() => s.apply(a.dryRunToken), expectCode('TABLE_ACTION_DRY_RUN_TOKEN_INVALID', 409), 'the superseded token stays burned')
  const applied = await s.apply(b.dryRunToken)
  assert.equal(applied.status, 'succeeded')
  assert.equal(applied.apply.counts.created, 2)
})

// ── T4 ────────────────────────────────────────────────────────────────────────────────────────────
test('T4 an unbound token (minted without the lock service) is refused token_unbound, zero writes', async () => {
  const harness = kit.createLibWriteLockHarness()
  const s = scenario({ harness })
  const dry = await s.dryRun({ projectWriteGenerationBinder: undefined })
  assert.equal(Object.prototype.hasOwnProperty.call(tokenRecordOf(s.storage), 'writeScope'), false, 'calibration: unbound')
  await assert.rejects(() => s.apply(dry.dryRunToken), (error) => {
    assert.equal(error.code, PROJECT_WRITE_ERROR_CODES.PLAN_SUPERSEDED)
    assert.equal(error.details.reason, 'token_unbound')
    return true
  })
  assert.equal(s.records.writes().length, 0)
})

// ── T5 ────────────────────────────────────────────────────────────────────────────────────────────
test('T5 no guard -> 501, a guard for another scope -> 500; the token is NOT consumed and nothing is read or written', async () => {
  const harness = kit.createLibWriteLockHarness()
  const s = scenario({ harness })
  const dry = await s.dryRun()
  const reads = s.source.calls.length
  await assert.rejects(() => s.apply(dry.dryRunToken, { projectWriteGuard: undefined }), expectCode(PROJECT_WRITE_ERROR_CODES.UNAVAILABLE, 501))
  const otherScope = sheetWriteScopeKey('sheet_swl_other_t5')
  await harness.lock.withProjectWriteLease(otherScope, { purpose: 'small_apply' }, async (wrongGuard) => {
    await assert.rejects(() => s.apply(dry.dryRunToken, { projectWriteGuard: wrongGuard }), expectCode(PROJECT_WRITE_ERROR_CODES.GUARD_SCOPE_MISMATCH, 500))
  })
  assert.equal(s.storage.map.size, 1, 'the token is still there')
  assert.equal(s.records.writes().length, 0)
  assert.equal(s.source.calls.length, reads)
  const applied = await s.apply(dry.dryRunToken)
  assert.equal(applied.status, 'succeeded', 'and still applies once the guard is right')
})

// ── T6 ────────────────────────────────────────────────────────────────────────────────────────────
test('T6 (E04) a preview while A is mid-write is refused (no token, generation unchanged); after A releases it supersedes', async () => {
  const harness = kit.createLibWriteLockHarness()
  const gate = kit.deferred()
  const entered = kit.deferred()
  const records = kit.createRecordsApi({ beforeWrite: async () => { entered.resolve(); await gate.promise } })
  const a = scenario({ harness, records })
  const tokenA = (await a.dryRun()).dryRunToken
  const running = a.apply(tokenA)
  await entered.promise
  const b = scenario({ harness, records })
  const before = await harness.lock.readState(a.scope)
  await assert.rejects(() => b.dryRun(), expectCode(PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED, 409))
  assert.equal(b.storage.map.size, 0, 'no token minted')
  assert.equal((await harness.lock.readState(a.scope)).generation, before.generation, 'generation unchanged')
  gate.resolve()
  const applied = await running
  assert.equal(applied.status, 'succeeded')
  const retry = await b.dryRun()
  assert.equal(typeof retry.dryRunToken, 'string')
  assert.equal((await harness.lock.readState(a.scope)).generation, before.generation + 1)
})

test('T6-lapse (E08) A stalls past TTL + GRACE after its first fence: B supersedes; A\'s one in-flight write lands (accepted residual), its next write is fenced', async () => {
  const clock = kit.createClock()
  const harness = kit.createLibWriteLockHarness({ clock })
  const gate = kit.deferred()
  const entered = kit.deferred()
  let held = false
  const records = kit.createRecordsApi({
    beforeWrite: async (op) => {
      if (op === 'createRecord' && !held) { held = true; entered.resolve(); await gate.promise }
    },
  })
  const a = scenario({ harness, records })
  const tokenA = (await a.dryRun()).dryRunToken
  const running = a.apply(tokenA)
  await entered.promise // A passed its first fence and is inside host write #1
  clock.advance(PROJECT_WRITE_LEASE_TTL_MS + PROJECT_WRITE_LEASE_TAKEOVER_GRACE_MS)
  const b = scenario({ harness, records: kit.createRecordsApi() })
  const preview = await b.dryRun()
  assert.equal(typeof preview.dryRunToken, 'string', 'B cleared the abandoned lease and bumped')
  const row = harness.db.rows(PROJECT_WRITE_LOCK_TABLE)[0]
  assert.equal(row.last_interrupted_purpose, 'small_apply')
  gate.resolve()
  await assert.rejects(() => running, (error) => {
    assert.equal(error.code, PROJECT_WRITE_ERROR_CODES.LEASE_LOST)
    assert.equal(error.status, 409)
    assert.equal(error.details.partial, true)
    assert.equal(error.details.written, 1)
    assert.equal(error.details.counts.created, 1)
    assert.equal(error.details.abortedAtDecisionIndex, 1)
    return true
  })
  assert.equal(records.writes().length, 1, 'exactly the one write that was already in flight')
})

test('T6-bump-first a preview committed before A acquires: A is PLAN_SUPERSEDED before any source read or write; the token is burned', async () => {
  const harness = kit.createLibWriteLockHarness()
  const s = scenario({ harness })
  const tokenA = (await s.dryRun()).dryRunToken
  await harness.lock.bumpGeneration(s.scope, { reason: 'small_preview' })
  const reads = s.source.calls.length
  await assert.rejects(() => s.apply(tokenA), expectCode(PROJECT_WRITE_ERROR_CODES.PLAN_SUPERSEDED, 409))
  assert.equal(s.source.calls.length, reads)
  assert.equal(s.records.writes().length, 0)
  assert.equal(s.storage.map.size, 0, 'burned')
})

// ── T7 ────────────────────────────────────────────────────────────────────────────────────────────
test('T7 the lock store fails mid-run: the writer stops, 503 STORE_FAILED with the partial counts', async () => {
  const harness = kit.createLibWriteLockHarness()
  const s = scenario({ harness })
  const token = (await s.dryRun()).dryRunToken
  let holderCas = 0
  harness.db.faults.updateRow = (args) => {
    if (args.set && Object.prototype.hasOwnProperty.call(args.set, 'lease_seq') && !Object.prototype.hasOwnProperty.call(args.set, 'lease_id')) {
      holderCas += 1
      if (holderCas === 2) return Object.assign(new Error('connection lost'), { code: '08006' })
    }
    return null
  }
  await assert.rejects(() => s.apply(token), (error) => {
    assert.equal(error.code, PROJECT_WRITE_ERROR_CODES.STORE_FAILED)
    assert.equal(error.status, 503)
    assert.equal(error.details.partial, true)
    assert.equal(error.details.written, 1)
    assert.equal(error.details.abortedAtDecisionIndex, 1)
    return true
  })
  assert.equal(s.records.writes().length, 1)
})

// ── T9 ────────────────────────────────────────────────────────────────────────────────────────────
test('T9 (E02, R-52) the scope is the sheet: another project on the same sheet is excluded; the same project on another sheet proceeds; two tenant strings are one scope', async () => {
  const harness = kit.createLibWriteLockHarness()
  const gate = kit.deferred()
  const entered = kit.deferred()
  const recordsA = kit.createRecordsApi({ beforeWrite: async () => { entered.resolve(); await gate.promise } })
  const a = scenario({ harness, records: recordsA, tenantId: 'tenant-swl-a' })
  const running = a.apply((await a.dryRun()).dryRunToken)
  await entered.promise
  const otherProject = scenario({ harness, projectNo: 'SYN-SWL-0004' })
  await assert.rejects(() => otherProject.dryRun(), expectCode(PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED, 409), 'another project on the SAME sheet is the same scope')
  assert.equal(otherProject.storage.map.size, 0, 'no token for it')
  const otherSheet = scenario({ harness, sheetId: 'sheet_swl_golden_b' })
  assert.equal((await otherSheet.apply((await otherSheet.dryRun()).dryRunToken)).status, 'succeeded', 'same project, another sheet: independent')
  const otherTenant = scenario({ harness, tenantId: 'tenant-swl-b' })
  await assert.rejects(() => otherTenant.dryRun(), expectCode(PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED, 409), 'same sheet under another tenant string is the SAME scope')
  gate.resolve()
  assert.equal((await running).status, 'succeeded')
})

test('T9b (R-52) two projects planned on one EMPTY sheet: only the newest plan can write, so the sheet never ends with both', async () => {
  const harness = kit.createLibWriteLockHarness()
  const records = kit.createRecordsApi()
  const p1 = scenario({ harness, records, projectNo: 'SYN-SWL-0006' })
  const p2 = scenario({ harness, records, projectNo: 'SYN-SWL-0007' })
  const t1 = (await p1.dryRun()).dryRunToken
  const t2 = (await p2.dryRun()).dryRunToken
  const [r1, r2] = await Promise.allSettled([p1.apply(t1), p2.apply(t2)])
  assert.equal(r1.status, 'rejected', 'the older plan (project 1) never writes')
  assert.ok(['STOCK_PREP_PROJECT_PLAN_SUPERSEDED', 'STOCK_PREP_PROJECT_WRITE_LOCKED'].includes(r1.reason.code), r1.reason.code)
  if (r2.status === 'rejected') {
    // The stale apply held the sheet for a moment; the newest plan was refused BUSY and kept its token (I4).
    assert.equal(r2.reason.code, 'STOCK_PREP_PROJECT_WRITE_LOCKED')
    assert.equal((await p2.apply(t2)).status, 'succeeded', 'the busy apply of the newest plan succeeds on retry')
  }
  const projects = new Set(records.rows.map((row) => row.data.projectNo))
  assert.equal(projects.size, 1, 'one project on the sheet')
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-project-write-guard-apply.test.cjs', tests, { passLine: '✓ stock-preparation-project-write-guard-apply' })
