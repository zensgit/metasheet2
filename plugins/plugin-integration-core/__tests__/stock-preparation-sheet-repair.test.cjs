'use strict'

// 备料 batch-refresh step 6d-2a (S6-6; step-6 design §6.6, §10 「S6-6」; register row R-91) — THE DOUBLED-SHEET REPAIR
// LIBRARY: lib/stock-preparation-sheet-repair.cjs over the REAL repair ledger store and the REAL sheet write lock on ONE
// faithful fake of migrations 108 + 100 (support/stock-preparation-sheet-repair-kit.cjs), a records host that enforces
// the write fence and versions like the real one, and a synthetic D1 sheet.
//
//   RP-00  the closed vocabularies; the switch reader (exact 'true'); the closed bodies (400 naming the field)
//   RP-01  retire preconditions, each refused BEFORE any write with its token: governed / unknown governance, an
//          incomplete source read, not D1, an ambiguous or unreadable old root, keyless rows, duplicate keys, no /
//          two paired copies, an old key still in the expansion, an unaddressable row, a row that is not machine-shaped
//   RP-02  the write: `active` is the BOOLEAN false (F-11) with the three RUN stamps; deepest row first, the root last
//   RP-03  the backup (run row + claim, one transaction) is committed BEFORE the first patch
//   RP-04  restore against CURRENT versions: a row whose version moved under an intact stamp IS restored at its current
//          version; revived / restamped / missing / never-retired rows are counted and not written; the four cells
//          come back byte-identical and a person's edit survives
//   RP-05  the one-shot claim: a second run of an approved digest is 409 ALREADY_CONSUMED (prelude, and in the lease);
//          a failed claim insert is read back and fails closed
//   RP-06  an execute's refusals (installing, not applicable, digest differs) leave zero patches and zero ledger rows
//   RP-07  a row that moved stops the run (never a blind retry); the rest needs a NEW digest and claim, and can be re-run
//   RP-08  a locked / missing record and a host failure stop the run with their reason
//   RP-09  a lease lost mid-run: the fence's own error with the partial counts; the run stays open and is closed
//          `abandoned` by the next run that holds the sheet
//   RP-10  the write surface is exactly the four repair cells (ruling C7), asserted at the send
//   RP-11  the sequence nonce: a run that began makes every later preview a new digest
//   RP-12  the generation is bumped after the release, only when something was written; a failed bump never fails the run
//   RP-13  the preview: refused while a writer holds the sheet; audited before the answer; values-free
//   NI-01  the installing gate: absent while the batch identifier is off (never read); a refusal token in the preview
//          and 409 in the lease when on
//   FR-01  the fills report: the K2 classes, per-column states, unpaired old rows, paging, values-free
// Every value is synthetic.

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const R = require(path.join(LIB, 'stock-preparation-sheet-repair.cjs'))
const { createStockPreparationSheetRepairStore } = require(path.join(LIB, 'stock-preparation-sheet-repair-store.cjs'))
const lockLib = require(path.join(LIB, 'stock-preparation-project-write-lock.cjs'))
const { HUMAN_PRESERVED_FIELD_IDS } = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const { __internals: auditInternals } = require(path.join(LIB, 'stock-preparation-audit-store.cjs'))
const { assertHostFencedWriteSupported } = require(path.join(LIB, 'stock-preparation-apply-writer.cjs'))
const kit = require('./support/stock-preparation-sheet-repair-kit.cjs')
const lockKit = require('./support/stock-preparation-project-write-lock-kit.cjs')

const tests = []
const test = (name, fn) => tests.push([name, fn])

const CODES = R.SHEET_REPAIR_ERROR_CODES
const RETIRE = R.SHEET_REPAIR_RECIPES[0]
const RESTORE = R.SHEET_REPAIR_RECIPES[1]
const SCOPE = Object.freeze({ tenantId: kit.TENANT_ID, sheetId: kit.SHEET_ID, projectNo: kit.PROJECT_NO })
const WRITE_SCOPE = lockLib.sheetWriteScopeKey(kit.SHEET_ID)
const HANDLE = kit.handleOf()
const P = kit.PHYSICAL_FIELD_IDS

async function rejects(promise, { status, code, reason, field }) {
  let caught = null
  try {
    await promise
  } catch (error) {
    caught = error
  }
  assert.ok(caught, `expected a refusal ${code}`)
  if (status !== undefined) assert.equal(caught.status, status, `${caught.code}: ${caught.message}`)
  if (code !== undefined) assert.equal(caught.code, code, caught.message)
  if (reason !== undefined) assert.equal(caught.details && caught.details.reason, reason, JSON.stringify(caught.details))
  if (field !== undefined) assert.equal(caught.details && caught.details.field, field, JSON.stringify(caught.details))
  return caught
}

function throwsSync(fn, { code, field }) {
  let caught = null
  try {
    fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught, `expected a refusal ${code}`)
  assert.equal(caught.code, code, caught.message)
  if (field !== undefined) assert.equal(caught.details.field, field, JSON.stringify(caught.details))
  return caught
}

/** The library over the REAL store and the REAL lock on one fake db, and a fenced host over the fixture's rows. */
function mount({ sheet = kit.doubledSheet(), governed = false, complete = true, expansionKeys = kit.expansionKeysOf() } = {}) {
  const clock = kit.createClock()
  const db = kit.createFakeRepairDb({ clock })
  const store = createStockPreparationSheetRepairStore({ db, now: clock.now })
  const timers = lockKit.createManualTimers()
  const lock = lockLib.createStockPreparationProjectWriteLock({ db, now: clock.now, timers })
  const host = kit.makeHost(sheet.rows)
  const records = lockKit.withFakeHostWriteFence(host, { lockDb: db })
  const state = { governed, complete, expansionKeys, reads: [], auditsWithin: [], auditReads: [], bumps: 0, failBump: false, beforeFencedPatch: null, patchCalls: 0 }
  const deps = {
    scope: SCOPE,
    actor: 'u_syn_admin',
    store,
    physicalFieldIds: P,
    readForRetire: async ({ guard } = {}) => {
      state.reads.push(guard ? 'retire:lease' : 'retire:preview')
      return { governed: state.governed, complete: state.complete, rows: host.rows(), expansionKeys: state.expansionKeys }
    },
    readForRestore: async ({ guard } = {}) => {
      state.reads.push(guard ? 'restore:lease' : 'restore:preview')
      return { governed: state.governed, rows: host.rows() }
    },
    assertNoLiveWriter: () => lock.assertNoLiveWriter(WRITE_SCOPE),
    withLease: (runId, fn) => lock.withProjectWriteLease(WRITE_SCOPE, { purpose: R.SHEET_REPAIR_LEASE_PURPOSE, runId, tenantId: SCOPE.tenantId }, fn),
    holderWithinFor: (guard) => (trx) => lock.assertHolderWithin(trx, guard.scopeKey, { leaseId: guard.hostWriteFence().leaseId, fencingEpoch: guard.fencingEpoch, reason: 'sheet_repair' }),
    leaseOf: (guard) => ({ leaseId: guard.hostWriteFence().leaseId, fencingEpoch: guard.fencingEpoch }),
    // The route's fenced patch, spelled here: the host's fence support checked once, then per patch the pre-write
    // holder CAS and the fenced, version-conditional host write.
    patchFor: (guard) => {
      assertHostFencedWriteSupported(records, guard)
      return async ({ recordId, changes, expectedVersion }) => {
        state.patchCalls += 1
        if (typeof state.beforeFencedPatch === 'function') await state.beforeFencedPatch(state.patchCalls)
        await guard.beforeWrite({ operation: 'patchRecord', decision: 'sheet_repair' })
        try {
          return await guard.withHostWrite(() => records.patchRecord({ sheetId: SCOPE.sheetId, recordId, changes, expectedVersion, writeFence: guard.hostWriteFence() }))
        } catch (error) {
          if (lockLib.isHostWriteFenceError(error)) throw await guard.hostFenceRefused(error)
          throw error
        }
      }
    },
    bumpAfterRelease: async () => {
      state.bumps += 1
      if (state.failBump) throw Object.assign(new Error('bump refused'), { code: 'SYN_BUMP_FAILED' })
      return lock.bumpGeneration(WRITE_SCOPE, { reason: R.SHEET_REPAIR_GENERATION_REASON, tenantId: SCOPE.tenantId })
    },
    auditWithin: async (trx, entry) => {
      assert.equal(typeof trx.setLocalLockTimeout, 'function', 'the audit row is handed the ledger TRANSACTION handle')
      auditInternals.assertValuesFreeDetail(entry.detail)
      state.auditsWithin.push({ mode: entry.mode, subjectId: entry.subjectId, detail: { ...entry.detail } })
    },
    auditRead: async (entry) => {
      auditInternals.assertValuesFreeDetail(entry.detail)
      state.auditReads.push({ mode: entry.mode, detail: { ...entry.detail } })
    },
    newRunId: () => `${R.SHEET_REPAIR_RUN_ID_PREFIX}${crypto.randomUUID()}`,
    logger: { warn() {} },
  }
  const run = (body) => R.runSheetRepairRequest(deps, body)
  const preview = (extra = {}) => run({ mode: 'preview', recipe: RETIRE, confirmProjectNo: SCOPE.projectNo, componentHandle: HANDLE, ...extra })
  const execute = (planDigest, extra = {}) => run({ mode: 'execute', recipe: RETIRE, confirmProjectNo: SCOPE.projectNo, componentHandle: HANDLE, planDigest, approvalRef: 'R-91:syn-1', ...extra })
  const restorePreview = (runId) => run({ mode: 'preview', recipe: RESTORE, confirmProjectNo: SCOPE.projectNo, runId })
  const restoreExecute = (runId, planDigest) => run({ mode: 'execute', recipe: RESTORE, confirmProjectNo: SCOPE.projectNo, runId, planDigest, approvalRef: 'R-91:syn-2' })
  /** Another writer takes the sheet over (the repair's lease lapsed): returns its guard. */
  const takeOver = async () => {
    clock.advance(lockLib.PROJECT_WRITE_LEASE_TTL_MS + lockLib.PROJECT_WRITE_LEASE_TAKEOVER_GRACE_MS + 1000)
    return lock.createGuard(await lock.acquire(WRITE_SCOPE, { purpose: 'small_apply', runId: 'syn-pull-takeover', tenantId: SCOPE.tenantId }))
  }
  return { clock, db, store, lock, host, records, state, deps, sheet, run, preview, execute, restorePreview, restoreExecute, takeOver }
}

const analysisBase = (sheet, extra = {}) => ({
  scope: SCOPE,
  rows: sheet.rows,
  expansionKeys: kit.expansionKeysOf(),
  retireRunIds: new Set(),
  sequence: 0,
  governed: false,
  complete: true,
  installing: false,
  componentHandle: HANDLE,
  ...extra,
})
const refusalsOf = (sheet, extra) => R.analyzeRetire(analysisBase(sheet, extra)).component

// ── RP-00 ────────────────────────────────────────────────────────────────────────────────────────────────

test('RP-00 the closed vocabularies are frozen; the switch reader is the exact literal; the audit rides existing actions', () => {
  assert.deepEqual(R.SHEET_REPAIR_RECIPES, ['retire_superseded_root_subtree', 'restore_retired_rows'])
  assert.deepEqual(R.SHEET_REPAIR_MODES, ['preview', 'execute'])
  assert.deepEqual(R.SHEET_REPAIR_RUN_STATUSES, ['running', 'completed', 'stopped'])
  assert.deepEqual(R.SHEET_REPAIR_STOP_REASONS, ['version_conflict', 'record_locked', 'record_missing', 'host_version_unexpected', 'host_write_failed', 'abandoned'])
  assert.deepEqual(R.SHEET_REPAIR_WRITE_FIELD_IDS, ['active', 'lastPlmRefreshRunId', 'lastPlmRefreshDecision', 'lastPlmConflictSummary'])
  assert.deepEqual(R.SHEET_REPAIR_BODY_KEYS, ['mode', 'recipe', 'confirmProjectNo', 'componentHandle', 'runId', 'planDigest', 'approvalRef'])
  assert.deepEqual(R.SHEET_REPAIR_FILL_CLASSES, ['k2_carryable', 'reenter_ext_human', 'reenter_conflict', 'nothing_to_carry'])
  assert.equal(R.SHEET_REPAIR_RETIRE_SUMMARY, '{"type":"sheet_repair_retire"}')
  assert.equal(R.SHEET_REPAIR_RETIRE_DECISION, 'inactive')
  assert.deepEqual([R.SHEET_REPAIR_LEASE_PURPOSE, R.SHEET_REPAIR_GENERATION_REASON], ['sheet_repair', 'sheet_repair'])
  assert.ok(lockLib.PROJECT_WRITE_PURPOSES.includes(R.SHEET_REPAIR_LEASE_PURPOSE), 'the lock knows the purpose')
  assert.ok(lockLib.PROJECT_WRITE_GENERATION_REASONS.includes(R.SHEET_REPAIR_GENERATION_REASON), 'the lock knows the reason')
  for (const list of [R.SHEET_REPAIR_RECIPES, R.SHEET_REPAIR_REFUSALS, R.SHEET_REPAIR_STOP_REASONS, R.SHEET_REPAIR_ERROR_CODES, R.SHEET_REPAIR_AUDIT, R.SHEET_REPAIR_AUDIT.modes]) assert.ok(Object.isFrozen(list))
  const codes = Object.values(CODES)
  assert.equal(new Set(codes).size, codes.length)
  for (const code of codes) assert.match(code, /^STOCK_PREP_SHEET_REPAIR_[A-Z_]+$/)
  // No audit vocabulary migration (design T6-12): both actions predate this feature.
  assert.deepEqual([R.SHEET_REPAIR_AUDIT.writeAction, R.SHEET_REPAIR_AUDIT.readAction], ['exception_resolve', 'project_board_read'])
  // MF-01 (the reader half): exact 'true', default OFF, no trim, no case folding.
  assert.equal(R.STOCK_PREP_SHEET_REPAIR_WRITE_ENABLED_ENV, 'MULTITABLE_STOCK_PREP_SHEET_REPAIR_WRITE_ENABLED')
  assert.equal(R.stockPrepSheetRepairWriteEnabled({ [R.STOCK_PREP_SHEET_REPAIR_WRITE_ENABLED_ENV]: 'true' }), true)
  for (const value of [undefined, '', 'false', 'TRUE', 'True', ' true', 'true ', '1', 'yes', 'on']) {
    assert.equal(R.stockPrepSheetRepairWriteEnabled({ [R.STOCK_PREP_SHEET_REPAIR_WRITE_ENABLED_ENV]: value }), false, `${JSON.stringify(value)} must not enable`)
  }
  assert.equal(R.stockPrepSheetRepairWriteEnabled({}), false)
  assert.equal(R.stockPrepSheetRepairWriteEnabled(null), false)
})

test('RP-00b the closed bodies: every refusal is 400 naming the FIELD (never its value)', () => {
  const ok = { mode: 'preview', recipe: RETIRE, confirmProjectNo: 'SYN-1' }
  const digest = 'a'.repeat(64)
  const runId = `${R.SHEET_REPAIR_RUN_ID_PREFIX}${crypto.randomUUID()}`
  assert.deepEqual({ ...R.normalizeSheetRepairBody(ok) }, { mode: 'preview', recipe: RETIRE, confirmProjectNo: 'SYN-1', componentHandle: null, runId: null, planDigest: null, approvalRef: null })
  assert.equal(R.normalizeSheetRepairBody({ ...ok, componentHandle: HANDLE }).componentHandle, HANDLE)
  assert.equal(R.normalizeSheetRepairBody({ mode: 'execute', recipe: RESTORE, confirmProjectNo: 'SYN-1', runId, planDigest: digest, approvalRef: 'R-91:t.1' }).approvalRef, 'R-91:t.1')
  for (const [body, field] of [
    [null, 'body'],
    [[], 'body'],
    [{ ...ok, tenantId: 't' }, 'tenantId'],
    [{ ...ok, sheetId: 's' }, 'sheetId'],
    [{ ...ok, extra: 1 }, 'extra'],
    [{ ...ok, mode: 'run' }, 'mode'],
    [{ recipe: RETIRE, confirmProjectNo: 'SYN-1' }, 'mode'],
    [{ ...ok, recipe: 'delete_rows' }, 'recipe'],
    [{ ...ok, confirmProjectNo: ' ' }, 'confirmProjectNo'],
    [{ ...ok, componentHandle: 'SENTINEL-PART-NUMBER' }, 'componentHandle'],
    [{ ...ok, componentHandle: HANDLE.toUpperCase() }, 'componentHandle'],
    [{ ...ok, runId }, 'runId'],
    [{ ...ok, planDigest: digest }, 'planDigest'],
    [{ ...ok, approvalRef: 'R-91' }, 'approvalRef'],
    [{ ...ok, mode: 'execute', planDigest: digest, approvalRef: 'R-91' }, 'componentHandle'],
    [{ ...ok, mode: 'execute', componentHandle: HANDLE, approvalRef: 'R-91' }, 'planDigest'],
    [{ ...ok, mode: 'execute', componentHandle: HANDLE, planDigest: digest.toUpperCase(), approvalRef: 'R-91' }, 'planDigest'],
    [{ ...ok, mode: 'execute', componentHandle: HANDLE, planDigest: digest }, 'approvalRef'],
    [{ ...ok, mode: 'execute', componentHandle: HANDLE, planDigest: digest, approvalRef: 'has space' }, 'approvalRef'],
    [{ ...ok, mode: 'execute', componentHandle: HANDLE, planDigest: digest, approvalRef: 'x'.repeat(65) }, 'approvalRef'],
    [{ mode: 'preview', recipe: RESTORE, confirmProjectNo: 'SYN-1' }, 'runId'],
    [{ mode: 'preview', recipe: RESTORE, confirmProjectNo: 'SYN-1', runId: 'sheet-repair:not-a-uuid' }, 'runId'],
    [{ mode: 'preview', recipe: RESTORE, confirmProjectNo: 'SYN-1', runId, componentHandle: HANDLE }, 'componentHandle'],
  ]) {
    const error = throwsSync(() => R.normalizeSheetRepairBody(body), { code: CODES.REQUEST_INVALID, field })
    assert.equal(error.status, 400)
    assert.equal(JSON.stringify(error.details).includes('SENTINEL'), false, 'the value is never echoed')
  }
  assert.deepEqual({ ...R.normalizeFillsReportQuery({}) }, { componentHandle: null, cursor: 0, limit: 100 })
  assert.deepEqual({ ...R.normalizeFillsReportQuery({ componentHandle: HANDLE, cursor: '40', limit: '200' }) }, { componentHandle: HANDLE, cursor: 40, limit: 200 })
  for (const [query, field] of [[{ tenantId: 't' }, 'tenantId'], [{ componentHandle: 'x' }, 'componentHandle'], [{ componentHandle: HANDLE, cursor: '-1' }, 'cursor'], [{ componentHandle: HANDLE, limit: '201' }, 'limit'], [{ componentHandle: HANDLE, limit: '0' }, 'limit'], [{ cursor: '5' }, 'cursor'], [{ componentHandle: HANDLE, cursor: '1e3' }, 'cursor']]) {
    throwsSync(() => R.normalizeFillsReportQuery(query), { code: CODES.REQUEST_INVALID, field })
  }
  assert.deepEqual({ ...R.normalizeRunsQuery({}) }, {})
  throwsSync(() => R.normalizeRunsQuery({ limit: '5' }), { code: CODES.REQUEST_INVALID, field: 'limit' })
})

// ── RP-01 ────────────────────────────────────────────────────────────────────────────────────────────────

test('RP-01 the D1 fixture is eligible; the listing answers every doubled component; the digest binds rows, pairs, scope and sequence', () => {
  const sheet = kit.doubledSheet()
  const one = refusalsOf(sheet)
  assert.equal(one.eligible, true, JSON.stringify(one.refusals))
  assert.deepEqual(one.counts, { nestedCopies: 1, oldRows: 4, toRetire: 4, alreadyRetired: 0, pairedCopies: 1, pairs: 4, stillExpanded: 0, unaddressable: 0, notMachineShaped: 0 })
  assert.match(one.planDigest, /^[0-9a-f]{64}$/)
  const listing = R.analyzeRetire(analysisBase(sheet, { componentHandle: null }))
  assert.deepEqual([listing.listing, listing.total, listing.components.map((entry) => [entry.componentHandle, entry.eligible, entry.planDigest])], [true, 1, [[HANDLE, true, one.planDigest]]])
  // Stable, and moved by every input an approval covers.
  assert.equal(refusalsOf(kit.doubledSheet()).planDigest, one.planDigest)
  const moved = (extra, mutate) => refusalsOf(kit.doubledSheet(mutate ? { mutate } : {}), extra).planDigest
  assert.notEqual(moved({ sequence: 1 }), one.planDigest, 'the run sequence')
  assert.notEqual(moved({ scope: { ...SCOPE, sheetId: 'sheet_syn_other' } }), one.planDigest, 'the sheet')
  assert.notEqual(moved({}, (spec) => (spec.id === 'rec_old_2' ? { ...spec, version: 99 } : spec)), one.planDigest, 'an old row version')
  assert.notEqual(moved({}, (spec) => (spec.id === 'rec_copy_3' ? { ...spec, id: 'rec_copy_other' } : spec)), one.planDigest, 'a paired copy')
  assert.equal(moved({}, (spec) => (spec.id === 'rec_copy_3' ? { ...spec, version: 7 } : spec)), one.planDigest, 'a copy row version alone does not (people fill the copies)')
  // An unknown handle is a refusal, never another component.
  const absent = R.analyzeRetire(analysisBase(sheet, { componentHandle: 'f'.repeat(24) })).component
  assert.deepEqual([absent.eligible, absent.refusals, absent.planDigest], [false, ['component_not_found'], null])
})

test('RP-01 retire preconditions: each one refuses with its closed token and plans nothing', () => {
  const mutated = (mutate) => kit.doubledSheet({ mutate })
  const cases = [
    ['project_governed', kit.doubledSheet(), { governed: true }],
    ['project_governed', kit.doubledSheet(), { governed: undefined }],
    ['source_incomplete', kit.doubledSheet(), { complete: false }],
    ['install_in_progress', kit.doubledSheet(), { installing: true }],
    // The old root's key (or a key under it) is still produced by the source: the next pull would revive it.
    ['old_root_still_expanded', kit.doubledSheet(), { expansionKeys: kit.expansionKeysOf({ includeOldRoot: true }) }],
    ['old_subtree_still_expanded', kit.doubledSheet(), { expansionKeys: kit.expansionKeysOf({ includeOldChild: true }) }],
    // D2 (the root already inactive): not this recipe's shape.
    ['not_two_copy', mutated((spec) => (spec.id === 'rec_old_1' ? { ...spec, active: false, decision: 'inactive', summary: '{"type":"missing_from_plm"}' } : spec)), {}],
    // The copy lacks one position / carries one more: the old subtree is not superseded as a whole.
    ['copy_not_paired', mutated((spec) => (spec.id === 'rec_copy_4' ? null : spec)), {}],
    ['copy_not_paired', mutated((spec) => (spec.id === 'rec_old_3' ? null : spec)), {}],
    ['row_unaddressable', mutated((spec) => (spec.id === 'rec_old_2' ? { ...spec, id: undefined } : spec)), {}],
    ['row_unaddressable', mutated((spec) => (spec.id === 'rec_copy_2' ? { ...spec, id: undefined } : spec)), {}],
    ['row_unaddressable', mutated((spec) => (spec.id === 'rec_old_2' ? { ...spec, version: 0 } : spec)), {}],
    // F-11 / D5: an `active` cell that is not the boolean true cannot be put back byte-identically.
    ['row_not_machine_shaped', mutated((spec) => (spec.id === 'rec_old_2' ? { ...spec, active: 'true' } : spec)), {}],
    ['row_not_machine_shaped', mutated((spec) => (spec.id === 'rec_old_2' ? { ...spec, active: 1 } : spec)), {}],
    ['row_not_machine_shaped', mutated((spec) => (spec.id === 'rec_old_2' ? { ...spec, summary: 'SENTINEL free text a person typed' } : spec)), {}],
    ['row_not_machine_shaped', mutated((spec) => (spec.id === 'rec_old_2' ? { ...spec, summary: '{"type":"x","note":"SENTINEL free text"}' } : spec)), {}],
    ['row_not_machine_shaped', mutated((spec) => (spec.id === 'rec_old_2' ? { ...spec, summary: '{"type":"x","nested":{"a":1}}' } : spec)), {}],
    ['row_not_machine_shaped', mutated((spec) => (spec.id === 'rec_old_2' ? { ...spec, decision: 'SENTINEL' } : spec)), {}],
    ['row_not_machine_shaped', mutated((spec) => (spec.id === 'rec_old_2' ? { ...spec, runId: 'run with spaces' } : spec)), {}],
    ['row_not_machine_shaped', mutated((spec) => (spec.id === 'rec_old_2' ? { ...spec, runId: 42 } : spec)), {}],
  ]
  for (const [token, sheet, extra] of cases) {
    const component = refusalsOf(sheet, extra)
    assert.equal(component.eligible, false, token)
    assert.ok(component.refusals.includes(token), `${token}: ${JSON.stringify(component.refusals)}`)
    assert.equal(component.planDigest, null, token)
    assert.equal(component.writes, undefined, `${token}: no plan`)
    assert.equal(JSON.stringify(component).includes('SENTINEL'), false, `${token}: values-free`)
    for (const refusal of component.refusals) assert.ok(R.SHEET_REPAIR_REFUSALS.includes(refusal), `${refusal} is in the closed list`)
  }
  // A stamp cell that is ABSENT cannot be restored (a patch cannot delete a cell); an explicit null can.
  const absentStamp = kit.doubledSheet()
  delete absentStamp.rows.find((row) => row.componentSourceId === 'C-1' && row.parentSourceId === kit.OLD_ROOT).lastPlmConflictSummary
  assert.ok(refusalsOf(absentStamp).refusals.includes('row_not_machine_shaped'))
  const nullStamp = refusalsOf(mutated((spec) => (spec.id === 'rec_old_2' ? { ...spec, summary: null, runId: null, decision: null } : spec)))
  assert.equal(nullStamp.eligible, true, JSON.stringify(nullStamp.refusals))
  assert.deepEqual(nullStamp.backup.find((entry) => entry[0] === 'rec_old_2').slice(2), [true, null, null, null])
  // The planner's own summaries are machine-shaped.
  for (const summary of ['', '{"type":"missing_from_plm"}', '{"type":"plm_system_refresh","changedFields":["componentName","ext_componentSortNo"]}', '{"type":"change_plan_update","changePlanId":"chp_1a2b","changedFields":["material"]}']) {
    assert.equal(R.__internals.isMachineSummary(summary), true, summary)
  }
  // Two active roots of the component; a root whose path cannot be read.
  const twoRoots = kit.doubledSheet()
  twoRoots.rows.push(kit.sheetRow({ tokens: [kit.OLD_ROOT], id: 'rec_old_twin' }))
  assert.ok(refusalsOf(twoRoots).refusals.includes('old_root_ambiguous'))
  const badPath = kit.doubledSheet()
  badPath.rows.find((row) => row.componentSourceId === kit.OLD_ROOT && row.parentSourceId === null).path = 'not json'
  assert.ok(refusalsOf(badPath).refusals.includes('old_root_path_unreadable'))
  // A keyless active row of the component (a hand-added row): never silently skipped.
  const keyless = kit.doubledSheet()
  keyless.rows.push({ ...kit.sheetRow({ tokens: [kit.OLD_ROOT, 'K-7'], id: 'rec_keyless' }), idempotencyKey: '' })
  assert.ok(refusalsOf(keyless).refusals.includes('keyless_rows_present'))
  // A duplicated key inside the old subtree (D3).
  const duplicate = kit.doubledSheet()
  duplicate.rows.push(kit.sheetRow({ tokens: [kit.OLD_ROOT, 'C-2'], id: 'rec_old_dup', active: false, decision: 'inactive' }))
  assert.ok(refusalsOf(duplicate).refusals.includes('duplicate_keys'))
  // Two nested copies that both pair: which one supersedes the old subtree is not this tool's call.
  const twoCopies = kit.doubledSheet()
  for (const [index, tokens] of kit.OLD_PATHS.entries()) twoCopies.rows.push(kit.sheetRow({ tokens: ['U-300'].concat(tokens), id: `rec_copy_b_${index + 1}` }))
  const ambiguous = refusalsOf(twoCopies)
  assert.ok(ambiguous.refusals.includes('copy_ambiguous'))
  assert.equal(ambiguous.counts.pairedCopies, 2)
})

// ── RP-02 / RP-03 ────────────────────────────────────────────────────────────────────────────────────────

test('RP-02 / RP-03 the retire: the backup, the run row and the claim are committed BEFORE the first patch; `active` is the BOOLEAN false; deepest first, the root last', async () => {
  const m = mount()
  const before = Object.fromEntries(m.sheet.ids.old.map((id) => [id, m.host.dataOf(id)]))
  const versions = Object.fromEntries(m.sheet.ids.old.map((id) => [id, m.host.versionOf(id)]))
  const preview = await m.preview()
  assert.deepEqual([preview.mode, preview.eligible, preview.refusals, preview.sequence, preview.openRun], ['preview', true, [], 0, false])
  assert.deepEqual(preview.requires, { approvalRef: true, planDigest: preview.planDigest })
  assert.deepEqual([m.db.rows(kit.T.run).length, m.db.rows(kit.T.claim).length, m.host.calls.length], [0, 0, 0], 'a preview writes nothing')
  // The ledger state at the FIRST patch: the run row (running, with every before-value) and the claim are committed.
  let ledgerAtFirstPatch = null
  m.host.beforePatch = (_recordId, callIndex) => {
    if (callIndex === 1) ledgerAtFirstPatch = { runs: m.db.rows(kit.T.run), claims: m.db.rows(kit.T.claim), log: m.db.log.map(([method]) => method) }
  }
  const answer = await m.execute(preview.planDigest)
  assert.deepEqual([answer.mode, answer.recipe, answer.status, answer.planned, answer.written, answer.planDigest, answer.componentHandle, answer.generationBumped], ['execute', RETIRE, 'completed', 4, 4, preview.planDigest, HANDLE, true])
  assert.match(answer.runId, /^sheet-repair:[0-9a-f-]{36}$/)
  assert.ok(ledgerAtFirstPatch, 'the host was patched')
  assert.equal(ledgerAtFirstPatch.runs.length, 1)
  const atFirst = ledgerAtFirstPatch.runs[0]
  assert.deepEqual([atFirst.status, atFirst.written_count, atFirst.planned_count, atFirst.plan_digest, atFirst.approval_ref, atFirst.sequence_no], ['running', null, 4, preview.planDigest, 'R-91:syn-1', 0])
  assert.deepEqual(atFirst.backup, [
    ['rec_old_4', versions.rec_old_4, true, kit.PULL_RUN_ID, 'add', ''],
    ['rec_old_2', versions.rec_old_2, true, kit.PULL_RUN_ID, 'add', ''],
    ['rec_old_3', versions.rec_old_3, true, kit.PULL_RUN_ID, 'add', ''],
    ['rec_old_1', versions.rec_old_1, true, kit.PULL_RUN_ID, 'add', ''],
  ], 'the backup holds exactly the four cells a retire writes, as read in the lease')
  assert.deepEqual(ledgerAtFirstPatch.claims.map((claim) => [claim.run_id, claim.plan_digest, claim.recipe]), [[answer.runId, preview.planDigest, RETIRE]])
  assert.ok(ledgerAtFirstPatch.log.lastIndexOf('commit') > ledgerAtFirstPatch.log.indexOf('trx.insertOne'), 'the begin transaction committed before the first patch')
  // The patches: plan order (deepest first, the root last), the planned version, the four physical cells only.
  assert.deepEqual(m.host.calls.map((call) => [call.recordId, call.expectedVersion]), [['rec_old_4', versions.rec_old_4], ['rec_old_2', versions.rec_old_2], ['rec_old_3', versions.rec_old_3], ['rec_old_1', versions.rec_old_1]])
  for (const call of m.host.calls) {
    assert.deepEqual(Object.keys(call.changes).sort(), Object.values(P).sort())
    assert.strictEqual(call.changes[P.active], false, 'F-11: the boolean false')
    assert.equal(typeof call.changes[P.active], 'boolean')
    assert.deepEqual([call.changes[P.lastPlmRefreshRunId], call.changes[P.lastPlmRefreshDecision], call.changes[P.lastPlmConflictSummary]], [answer.runId, 'inactive', '{"type":"sheet_repair_retire"}'])
  }
  assert.equal(m.records.fakeHostFences.length, 4, 'every patch carried the host write fence')
  // The sheet: the old subtree retired, every other cell of every row untouched.
  for (const id of m.sheet.ids.old) {
    const after = m.host.dataOf(id)
    assert.strictEqual(after.active, false)
    assert.equal(m.host.versionOf(id), versions[id] + 1)
    const { active: _a, lastPlmRefreshRunId: _r, lastPlmRefreshDecision: _d, lastPlmConflictSummary: _s, ...rest } = after
    const { active: _a2, lastPlmRefreshRunId: _r2, lastPlmRefreshDecision: _d2, lastPlmConflictSummary: _s2, ...restBefore } = before[id]
    assert.deepEqual(rest, restBefore, 'nothing but the four repair cells moved (lastPlmRefreshAt included)')
  }
  for (const id of m.sheet.ids.copy.concat(m.sheet.ids.other)) assert.equal(m.host.versionOf(id), 1, 'no copy row and no other row was written')
  // The ledger and the lock afterwards.
  const run = m.db.rows(kit.T.run)[0]
  assert.deepEqual([run.status, run.stop_reason, run.written_count, run.component_handle, run.source_run_id, run.write_scope_key, run.started_by], ['completed', null, 4, HANDLE, null, WRITE_SCOPE, 'u_syn_admin'])
  assert.ok(run.finished_at)
  const lockRow = m.db.rows(kit.T.lock)[0]
  assert.deepEqual([lockRow.lease_id, lockRow.generation_reason, lockRow.last_interrupted_run_id || null], [null, 'sheet_repair', null], 'released, then bumped with the repair reason')
  assert.deepEqual(m.state.auditsWithin.map((entry) => [entry.mode, entry.subjectId]), [['sheet_repair_started', answer.runId], ['sheet_repair_completed', answer.runId]])
  assert.deepEqual(m.state.reads, ['retire:preview', 'retire:lease'], 'the execute recomputed the preview INSIDE the lease')
  for (const text of [JSON.stringify(preview), JSON.stringify(answer), JSON.stringify(m.state.auditsWithin)]) {
    for (const planted of [kit.PROJECT_NO, kit.OLD_ROOT, kit.PARENT, 'C-1', kit.TENANT_ID, kit.SHEET_ID]) assert.equal(text.includes(planted), false, `${planted} leaked`)
  }
})

// ── RP-04 ────────────────────────────────────────────────────────────────────────────────────────────────

test('RP-04 restore against CURRENT versions: a moved row with an intact stamp is restored at its current version; the four cells come back byte-identical; revived / restamped / missing rows are counted and not written', async () => {
  const m = mount()
  const before = Object.fromEntries(m.sheet.ids.old.map((id) => [id, m.host.dataOf(id)]))
  const versionsBefore = Object.fromEntries(m.sheet.ids.old.map((id) => [id, m.host.versionOf(id)]))
  const retired = await m.execute((await m.preview()).planDigest)
  // After the retire: a person fills a human cell of one hidden old row (its version moves, its stamp stays).
  m.host.humanEdit('rec_old_3', { notes: 'SENTINEL note typed after the retire' })
  const preview = await m.restorePreview(retired.runId)
  assert.deepEqual([preview.mode, preview.recipe, preview.sourceRunId, preview.eligible, preview.refusals, preview.sequence], ['preview', RESTORE, retired.runId, true, [], 1])
  assert.deepEqual(preview.counts, { backupRows: 4, toRestore: 4, versionMovedStampIntact: 1, notRetired: 0, revived: 0, restamped: 0, missing: 0, unaddressable: 0 })
  assert.equal(JSON.stringify(preview).includes('SENTINEL'), false)
  m.host.calls.length = 0
  const answer = await m.restoreExecute(retired.runId, preview.planDigest)
  assert.deepEqual([answer.status, answer.planned, answer.written, answer.sourceRunId, answer.recipe], ['completed', 4, 4, retired.runId, RESTORE])
  // Root first (the reverse of the retire), each at its CURRENT version — the moved row included.
  assert.deepEqual(m.host.calls.map((call) => [call.recordId, call.expectedVersion]), [
    ['rec_old_1', versionsBefore.rec_old_1 + 1],
    ['rec_old_3', versionsBefore.rec_old_3 + 2],
    ['rec_old_2', versionsBefore.rec_old_2 + 1],
    ['rec_old_4', versionsBefore.rec_old_4 + 1],
  ])
  for (const call of m.host.calls) assert.strictEqual(call.changes[P.active], true)
  // Byte-identity of the stored data (retire + restore = version + 2), and the person's edit survives.
  for (const id of m.sheet.ids.old) {
    const after = m.host.dataOf(id)
    if (id === 'rec_old_3') {
      assert.equal(after.notes, 'SENTINEL note typed after the retire', 'a human cell is never in a patch')
      delete after.notes
      assert.equal(m.host.versionOf(id), versionsBefore[id] + 3)
    } else {
      assert.equal(m.host.versionOf(id), versionsBefore[id] + 2)
    }
    assert.equal(JSON.stringify(after), JSON.stringify(before[id]), `${id}: byte-identical to before the retire`)
  }
  const restoreRun = m.db.rows(kit.T.run).find((row) => row.recipe === RESTORE)
  assert.deepEqual([restoreRun.status, restoreRun.source_run_id, restoreRun.component_handle, restoreRun.sequence_no, restoreRun.written_count], ['completed', retired.runId, null, 1, 4])
  assert.deepEqual(restoreRun.backup.map((entry) => entry.slice(2)), Array(4).fill([false, retired.runId, 'inactive', '{"type":"sheet_repair_retire"}']), 'a restore backs its rows up too')
  assert.equal(m.db.rows(kit.T.claim).length, 2, 'the restore spent its OWN claim')
  // A second restore of the same run finds nothing left to restore.
  const again = await m.restorePreview(retired.runId)
  assert.deepEqual([again.eligible, again.refusals, again.counts.notRetired, again.planDigest], [false, ['nothing_to_restore'], 4, null])
})

test('RP-04b restore: revived, restamped, missing and never-retired rows are told apart and never written; a governed project and a foreign run are refused', async () => {
  const m = mount()
  const retired = await m.execute((await m.preview()).planDigest)
  // One row revived by a pull (its key re-entered the expansion), one restamped inactive by another machine write, one gone.
  Object.assign(m.host.records.get('rec_old_2').data, { active: true, lastPlmRefreshRunId: 'table-action:syn-pull-2', lastPlmRefreshDecision: 'update', lastPlmConflictSummary: '{"type":"plm_system_refresh","changedFields":["material"]}' })
  m.host.records.get('rec_old_2').version += 1
  Object.assign(m.host.records.get('rec_old_3').data, { lastPlmRefreshRunId: 'table-action:syn-pull-2', lastPlmConflictSummary: '{"type":"missing_from_plm"}' })
  m.host.records.get('rec_old_3').version += 1
  m.host.records.delete('rec_old_4')
  const preview = await m.restorePreview(retired.runId)
  assert.deepEqual(preview.counts, { backupRows: 4, toRestore: 1, versionMovedStampIntact: 0, notRetired: 0, revived: 1, restamped: 1, missing: 1, unaddressable: 0 })
  m.host.calls.length = 0
  const answer = await m.restoreExecute(retired.runId, preview.planDigest)
  assert.deepEqual([answer.planned, answer.written], [1, 1])
  assert.deepEqual(m.host.calls.map((call) => call.recordId), ['rec_old_1'], 'only the row still in the retired state')
  // Governed since the retire: nothing is restored on a governed project.
  const governed = mount()
  const run = await governed.execute((await governed.preview()).planDigest)
  governed.state.governed = true
  const refused = await governed.restorePreview(run.runId)
  assert.deepEqual([refused.eligible, refused.refusals], [false, ['project_governed']])
  await rejects(governed.restoreExecute(run.runId, 'b'.repeat(64)), { status: 409, code: CODES.NOT_APPLICABLE })
  // A run id of another scope (or none at all) answers the same refusal; a restore run cannot itself be restored.
  const unknown = await m.restorePreview(`${R.SHEET_REPAIR_RUN_ID_PREFIX}${crypto.randomUUID()}`)
  assert.deepEqual([unknown.eligible, unknown.refusals, unknown.sourceRunId], [false, ['run_not_found'], null])
  const notRetire = await m.restorePreview(answer.runId)
  assert.deepEqual([notRetire.eligible, notRetire.refusals], [false, ['run_not_retire']])
})

// ── RP-05 ────────────────────────────────────────────────────────────────────────────────────────────────

test('RP-05 the one-shot claim: a second run of the same approved digest is 409 ALREADY_CONSUMED before any lease, and in the lease when the claim lands between the prelude and the lease', async () => {
  const m = mount()
  const preview = await m.preview()
  await m.execute(preview.planDigest)
  const lockBefore = JSON.stringify(m.db.rows(kit.T.lock))
  m.host.calls.length = 0
  await rejects(m.execute(preview.planDigest), { status: 409, code: CODES.ALREADY_CONSUMED, reason: 'claim_consumed' })
  assert.equal(JSON.stringify(m.db.rows(kit.T.lock)), lockBefore, 'the prelude refused before any lease')
  assert.deepEqual([m.db.rows(kit.T.run).length, m.db.rows(kit.T.claim).length, m.host.calls.length], [1, 1, 0])
  // The claim appears between the prelude read and the lease (another request ran the same digest): the in-lease
  // recompute's digest differs (the sequence moved), and the answer is still ALREADY_CONSUMED, never PLAN_CHANGED.
  const race = mount()
  const racePreview = await race.preview()
  const realReadClaim = race.store.readClaim
  let reads = 0
  race.deps.store = { ...race.store, readClaim: async (input) => { reads += 1; return reads === 1 ? null : realReadClaim(input) } }
  await race.store.beginRun({
    ...SCOPE, runId: `${R.SHEET_REPAIR_RUN_ID_PREFIX}${crypto.randomUUID()}`, writeScopeKey: WRITE_SCOPE, recipe: RETIRE, planDigest: racePreview.planDigest, approvalRef: 'R-91:other',
    componentHandle: HANDLE, backup: [['rec_old_1', 3, true, kit.PULL_RUN_ID, 'add', '']], plannedCount: 1, expectSequence: 0, lease: { leaseId: 'lease_other', fencingEpoch: 1 }, startedBy: 'u_other',
    holderWithin: async () => {}, auditWithin: async () => {},
  })
  await rejects(race.execute(racePreview.planDigest), { status: 409, code: CODES.ALREADY_CONSUMED })
  assert.equal(reads, 2, 'the prelude read and the in-lease read')
  assert.equal(race.host.calls.length, 0)
})

test('RP-05b the claim insert fails closed: a failure that is not "already claimed" is 503 and leaves no run row; nothing is written to the sheet', async () => {
  const m = mount()
  const preview = await m.preview()
  m.db.faults.insertOne = (args) => (args.table === kit.T.claim ? kit.sqlError('57014', 'canceling statement due to statement timeout') : null)
  const error = await rejects(m.execute(preview.planDigest), { status: 503, code: CODES.STORE_FAILED })
  assert.deepEqual([error.details.operation, error.details.sqlState, error.details.partial], ['claim', '57014', false])
  delete m.db.faults.insertOne
  assert.deepEqual([m.db.rows(kit.T.run).length, m.db.rows(kit.T.claim).length, m.host.calls.length, m.state.auditsWithin.length], [0, 0, 0, 0], 'the begin rolled back: no run without its claim, and no audit row of a run that never began')
  assert.equal(m.db.rows(kit.T.lock)[0].lease_id, null, 'the lease was released')
  // The same digest is still executable afterwards (nothing was consumed).
  const answer = await m.execute(preview.planDigest)
  assert.equal(answer.status, 'completed')
})

// ── RP-06 ────────────────────────────────────────────────────────────────────────────────────────────────

test('RP-06 an execute refuses BEFORE any patch and any ledger row: a moved digest, a precondition that no longer holds, a sheet being installed', async () => {
  const zero = (m) => assert.deepEqual([m.host.calls.length, m.db.rows(kit.T.run).length, m.db.rows(kit.T.claim).length, m.state.bumps], [0, 0, 0, 0])
  // A digest that is not the sheet's.
  const stale = mount()
  await rejects(stale.execute('c'.repeat(64)), { status: 409, code: CODES.PLAN_CHANGED, reason: 'plan_digest_differs' })
  zero(stale)
  // A person edits an old row between the preview and the execute: its version is in the digest.
  const edited = mount()
  const preview = await edited.preview()
  edited.host.humanEdit('rec_old_2', { notes: 'typed between preview and execute' })
  await rejects(edited.execute(preview.planDigest), { status: 409, code: CODES.PLAN_CHANGED })
  zero(edited)
  // The project became governed between the preview and the execute (RP-01, in the lease).
  const governed = mount()
  const governedPreview = await governed.preview()
  governed.state.governed = true
  const refusal = await rejects(governed.execute(governedPreview.planDigest), { status: 409, code: CODES.NOT_APPLICABLE })
  assert.deepEqual(refusal.details.reasons, ['project_governed'])
  zero(governed)
  // The old root's key came back into the source.
  const expanded = mount()
  const expandedPreview = await expanded.preview()
  expanded.state.expansionKeys = kit.expansionKeysOf({ includeOldRoot: true })
  assert.deepEqual((await rejects(expanded.execute(expandedPreview.planDigest), { status: 409, code: CODES.NOT_APPLICABLE })).details.reasons, ['old_root_still_expanded'])
  zero(expanded)
  // An unknown component.
  const unknown = mount()
  assert.deepEqual((await rejects(unknown.execute('d'.repeat(64), { componentHandle: 'f'.repeat(24) }), { status: 409, code: CODES.NOT_APPLICABLE })).details.reasons, ['component_not_found'])
  zero(unknown)
  for (const m of [stale, edited, governed, expanded, unknown]) assert.equal(m.db.rows(kit.T.lock)[0].lease_id, null, 'the lease is released on a refusal')
})

// ── RP-07 / RP-08 ────────────────────────────────────────────────────────────────────────────────────────

test('RP-07 a row that moved under the lease STOPS the run (no blind retry); the rest needs a NEW digest and its own claim, and the re-run pairs over the rows already retired', async () => {
  const m = mount()
  const preview = await m.preview()
  // A person edits the third planned row after the in-lease read and before its patch.
  m.host.beforePatch = (recordId, callIndex) => {
    if (callIndex === 3 && recordId === 'rec_old_3') m.host.humanEdit('rec_old_3', { notes: 'typed during the run' })
  }
  const stop = await rejects(m.execute(preview.planDigest), { status: 409, code: CODES.STOPPED, reason: 'version_conflict' })
  assert.deepEqual([stop.details.planned, stop.details.written, stop.details.partial], [4, 2, true])
  assert.match(stop.details.runId, /^sheet-repair:/)
  assert.equal(m.host.calls.length, 3, 'the conflicting row was tried ONCE and the root never')
  const run = m.db.rows(kit.T.run)[0]
  assert.deepEqual([run.status, run.stop_reason, run.written_count, run.planned_count], ['stopped', 'version_conflict', 2, 4])
  assert.deepEqual(m.state.auditsWithin.map((entry) => entry.mode), ['sheet_repair_started', 'sheet_repair_stopped'])
  assert.deepEqual([m.host.dataOf('rec_old_1').active, m.host.dataOf('rec_old_3').active, m.host.dataOf('rec_old_4').active, m.host.dataOf('rec_old_2').active], [true, true, false, false], 'the root is still active: the component is still D1')
  assert.equal(m.state.bumps, 1, 'rows were written, so the generation is bumped')
  // The approved digest is spent; the sheet now previews as a DIFFERENT plan.
  m.host.beforePatch = null
  await rejects(m.execute(preview.planDigest), { status: 409, code: CODES.ALREADY_CONSUMED })
  const next = await m.preview()
  assert.deepEqual([next.eligible, next.sequence, next.counts.oldRows, next.counts.toRetire, next.counts.alreadyRetired, next.counts.pairs], [true, 1, 4, 2, 2, 4])
  assert.notEqual(next.planDigest, preview.planDigest)
  m.host.calls.length = 0
  const rerun = await m.execute(next.planDigest, { approvalRef: 'R-91:syn-rerun' })
  assert.deepEqual([rerun.status, rerun.planned, rerun.written], ['completed', 2, 2])
  assert.deepEqual(m.host.calls.map((call) => call.recordId), ['rec_old_3', 'rec_old_1'])
  assert.deepEqual(m.db.rows(kit.T.claim).map((claim) => claim.approval_ref).sort(), ['R-91:syn-1', 'R-91:syn-rerun'])
  for (const id of m.sheet.ids.old) assert.strictEqual(m.host.dataOf(id).active, false)
  // A row retired by a run this ledger does NOT know is not "already retired": the stamp alone proves nothing.
  const foreign = kit.doubledSheet({ mutate: (spec) => (spec.id === 'rec_old_4' ? { ...spec, active: false, runId: 'sheet-repair:00000000-0000-4000-8000-000000000000', decision: 'inactive', summary: kit.RETIRE_SUMMARY } : spec) })
  assert.ok(refusalsOf(foreign).refusals.includes('copy_not_paired'))
  assert.equal(refusalsOf(foreign, { retireRunIds: new Set(['sheet-repair:00000000-0000-4000-8000-000000000000']) }).eligible, true)
})

test('RP-08 a locked record, a missing record, a host failure and an unexpected host version each stop the run with their own reason', async () => {
  for (const [reason, arrange, written] of [
    ['record_locked', (m) => { m.host.records.get('rec_old_2').locked = true }, 1],
    ['record_missing', (m) => { m.host.beforePatch = (recordId) => { if (recordId === 'rec_old_2') m.host.records.delete('rec_old_2') } }, 1],
    ['host_write_failed', (m) => { m.host.beforePatch = (recordId) => { if (recordId === 'rec_old_2') throw Object.assign(new Error('SENTINEL host detail'), { code: 'SYN_HOST_DOWN' }) } }, 1],
    ['host_version_unexpected', (m) => { m.host.beforePatch = (recordId) => { if (recordId === 'rec_old_2') m.host.records.get('rec_old_2').version += 0 }; const patch = m.host.patchRecord; m.host.patchRecord = async (input) => { const out = await patch(input); return input.recordId === 'rec_old_2' ? { ...out, version: out.version + 5 } : out } }, 2],
  ]) {
    const m = mount()
    const preview = await m.preview()
    arrange(m)
    const stop = await rejects(m.execute(preview.planDigest), { status: 409, code: CODES.STOPPED, reason })
    assert.deepEqual([stop.details.written, stop.details.planned], [written, 4], reason)
    assert.equal(JSON.stringify(stop.details).includes('SENTINEL'), false)
    const run = m.db.rows(kit.T.run)[0]
    assert.deepEqual([run.status, run.stop_reason, run.written_count], ['stopped', reason, written], reason)
    assert.equal(m.db.rows(kit.T.lock)[0].lease_id, null)
  }
})

// ── RP-09 ────────────────────────────────────────────────────────────────────────────────────────────────

test('RP-09 a lease lost mid-run: the fence refuses the next patch (nothing more lands), the answer carries the partial counts, the run stays open and the NEXT run that holds the sheet closes it `abandoned`', async () => {
  const m = mount()
  const preview = await m.preview()
  let taker = null
  // Before the THIRD patch's holder CAS: the repair's lease lapsed and a pull took the sheet over.
  m.state.beforeFencedPatch = async (callIndex) => {
    if (callIndex === 3) taker = await m.takeOver()
  }
  const lost = await rejects(m.execute(preview.planDigest), { status: 409, code: lockLib.PROJECT_WRITE_ERROR_CODES.LEASE_LOST })
  assert.deepEqual([lost.details.written, lost.details.planned, lost.details.partial], [2, 4, true])
  assert.equal(m.host.calls.length, 2, 'the zombie wrote nothing after the takeover')
  const open = m.db.rows(kit.T.run)[0]
  assert.deepEqual([open.status, open.written_count, open.finished_at], ['running', null, null], 'a run whose lease is gone cannot record its own outcome')
  assert.deepEqual(m.state.auditsWithin.map((entry) => entry.mode), ['sheet_repair_started'])
  // While the taker holds the sheet nothing of a repair runs: preview and execute are WRITE_LOCKED.
  await rejects(m.preview(), { status: 409, code: lockLib.PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED })
  await rejects(m.execute('e'.repeat(64)), { status: 409, code: lockLib.PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED })
  await taker.release()
  // The next repair run of the sheet: its begin closes the open run (lease identity, not a clock) and proceeds.
  m.state.beforeFencedPatch = null
  const next = await m.preview()
  assert.deepEqual([next.openRun, next.sequence, next.counts.toRetire, next.counts.alreadyRetired], [true, 1, 2, 2])
  const rerun = await m.execute(next.planDigest, { approvalRef: 'R-91:after-takeover' })
  assert.equal(rerun.status, 'completed')
  const runs = m.db.rows(kit.T.run).sort((left, right) => left.sequence_no - right.sequence_no)
  assert.deepEqual(runs.map((row) => [row.status, row.stop_reason, row.written_count]), [['stopped', 'abandoned', null], ['completed', null, 2]])
  assert.deepEqual(m.state.auditsWithin.map((entry) => entry.mode), ['sheet_repair_started', 'sheet_repair_abandoned', 'sheet_repair_started', 'sheet_repair_completed'])
  assert.equal(m.state.auditsWithin[1].subjectId, runs[0].id)
})

test('RP-09b a takeover AFTER the holder CAS and before the host write: the HOST fence refuses the patch; and a takeover after the last patch: the finish is refused, never "completed"', async () => {
  const m = mount()
  const preview = await m.preview()
  // The takeover lands between the pre-write CAS and the host's own fence check of the second patch.
  const fenced = m.records.patchRecord
  let calls = 0
  const records = new Proxy(m.records, { get: (target, key) => (key === 'patchRecord' ? async (input) => { calls += 1; if (calls === 2) await m.takeOver(); return fenced(input) } : Reflect.get(target, key)) })
  m.deps.patchFor = (guard) => async ({ recordId, changes, expectedVersion }) => {
    await guard.beforeWrite({ operation: 'patchRecord', decision: 'sheet_repair' })
    try {
      return await guard.withHostWrite(() => records.patchRecord({ sheetId: SCOPE.sheetId, recordId, changes, expectedVersion, writeFence: guard.hostWriteFence() }))
    } catch (error) {
      if (lockLib.isHostWriteFenceError(error)) throw await guard.hostFenceRefused(error)
      throw error
    }
  }
  const lost = await rejects(m.execute(preview.planDigest), { status: 409, code: lockLib.PROJECT_WRITE_ERROR_CODES.LEASE_LOST })
  assert.deepEqual([lost.details.written, m.host.calls.length], [1, 1], 'the host refused the fenced write: only the first patch landed')
  assert.equal(m.db.rows(kit.T.run)[0].status, 'running')
  // After the LAST patch: every row is written, but the finish's holder assert refuses — the answer is the lost lease.
  const late = mount()
  const latePreview = await late.preview()
  late.host.beforePatch = async (_recordId, callIndex) => {
    if (callIndex === 4) await late.takeOver()
  }
  const lateLost = await rejects(late.execute(latePreview.planDigest), { status: 409, code: lockLib.PROJECT_WRITE_ERROR_CODES.LEASE_LOST })
  assert.deepEqual([lateLost.details.written, lateLost.details.planned, lateLost.details.partial], [4, 4, true])
  assert.equal(late.db.rows(kit.T.run)[0].status, 'running', 'never recorded as completed by a holder that lost the sheet')
})

// ── RP-10 ────────────────────────────────────────────────────────────────────────────────────────────────

test('RP-10 the write surface is exactly the four repair cells (ruling C7): a fifth cell, a missing one or a non-boolean `active` is refused at the send, before any patch', async () => {
  const deps = { physicalFieldIds: P }
  const sent = []
  const patch = async (input) => { sent.push(input); return { version: input.expectedVersion + 1 } }
  const items = [{ recordId: 'rec_1', version: 1 }]
  const good = await R.__internals.writePlan({ deps, patch, items, changesOf: () => R.__internals.retireChangesOf('sheet-repair:x') })
  assert.deepEqual([good.written, good.stop, Object.keys(sent[0].changes).sort()], [1, null, Object.values(P).sort()])
  sent.length = 0
  for (const changesOf of [
    () => ({ ...R.__internals.retireChangesOf('sheet-repair:x'), pullBatch: '第1批' }),
    () => ({ ...R.__internals.retireChangesOf('sheet-repair:x'), notes: 'a human cell' }),
    () => ({ active: false }),
    () => ({ ...R.__internals.retireChangesOf('sheet-repair:x'), active: 'false' }),
    () => ({ ...R.__internals.retireChangesOf('sheet-repair:x'), active: 0 }),
    () => ({ ...R.__internals.retireChangesOf('sheet-repair:x'), active: null }),
  ]) {
    await rejects(R.__internals.writePlan({ deps, patch, items, changesOf }), { status: 500, code: CODES.UNAVAILABLE, field: 'changes' })
  }
  assert.equal(sent.length, 0, 'nothing was sent')
  // The route's deps must hand four DISTINCT physical ids.
  const m = mount()
  m.deps.physicalFieldIds = { ...P, lastPlmConflictSummary: P.active }
  await rejects(m.preview(), { status: 500, code: CODES.UNAVAILABLE, field: 'physicalFieldIds' })
  m.deps.physicalFieldIds = { active: P.active }
  await rejects(m.preview(), { status: 500, code: CODES.UNAVAILABLE, field: 'physicalFieldIds' })
})

// ── RP-11 / RP-12 ────────────────────────────────────────────────────────────────────────────────────────

test('RP-11 the sequence nonce: a run that began and wrote NOTHING still makes the next preview a new digest (no dead-ended approval)', async () => {
  const m = mount()
  const preview = await m.preview()
  // The very first patch fails: the run is stopped with zero rows written; the sheet is exactly as it was.
  m.host.beforePatch = () => { throw Object.assign(new Error('host down'), { code: 'SYN_HOST_DOWN' }) }
  const stop = await rejects(m.execute(preview.planDigest), { status: 409, code: CODES.STOPPED, reason: 'host_write_failed' })
  assert.deepEqual([stop.details.written, stop.details.partial], [0, false])
  assert.equal(m.state.bumps, 0, 'nothing was written: no bump')
  m.host.beforePatch = null
  const next = await m.preview()
  assert.deepEqual([next.eligible, next.sequence, next.counts.toRetire], [true, 1, 4])
  assert.notEqual(next.planDigest, preview.planDigest, 'the same rows, a new digest: the spent approval cannot dead-end the sheet')
  assert.equal((await m.execute(next.planDigest, { approvalRef: 'R-91:second' })).status, 'completed')
})

test('RP-12 the generation bump runs after the release and only when something was written; a failed bump never fails the run', async () => {
  const m = mount()
  m.state.failBump = true
  const answer = await m.execute((await m.preview()).planDigest)
  assert.deepEqual([answer.status, answer.written, answer.generationBumped, m.state.bumps], ['completed', 4, false, 1])
  assert.equal(m.db.rows(kit.T.lock)[0].generation_reason, null, 'the bump did not land')
})

// ── RP-13 ────────────────────────────────────────────────────────────────────────────────────────────────

test('RP-13 the preview: refused while a writer holds the sheet; audited BEFORE the answer (a refusing audit => no answer); the listing is values-free', async () => {
  const m = mount()
  const guard = lockKit ? m.lock.createGuard(await m.lock.acquire(WRITE_SCOPE, { purpose: 'small_apply', runId: 'syn-pull', tenantId: SCOPE.tenantId })) : null
  await rejects(m.preview(), { status: 409, code: lockLib.PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED })
  assert.deepEqual(m.state.reads, [], 'no read of a sheet that is being written')
  await guard.release()
  const listing = await m.run({ mode: 'preview', recipe: RETIRE, confirmProjectNo: SCOPE.projectNo })
  assert.deepEqual([listing.total, listing.components.length, listing.components[0].componentHandle, listing.components[0].eligible], [1, 1, HANDLE, true])
  assert.deepEqual(m.state.auditReads.map((entry) => [entry.mode, entry.detail.listing, entry.detail.components, entry.detail.eligible]), [['sheet_repair_preview_read', true, 1, false]])
  for (const planted of [kit.PROJECT_NO, kit.OLD_ROOT, kit.PARENT, kit.TENANT_ID, kit.SHEET_ID, 'rec_old']) assert.equal(JSON.stringify(listing).includes(planted), false, `${planted} leaked`)
  m.deps.auditRead = async () => { throw Object.assign(new Error('audit down'), { status: 503, code: 'AUDIT_STORE_FAILED' }) }
  await rejects(m.preview(), { status: 503, code: 'AUDIT_STORE_FAILED' })
  // Incomplete wiring is a named 500 / 501, never a silent degrade.
  const broken = mount()
  delete broken.deps.readForRetire
  await rejects(broken.preview(), { status: 500, code: CODES.UNAVAILABLE, field: 'readForRetire' })
  const noStore = mount()
  noStore.deps.store = { listRunsOf: noStore.store.listRunsOf }
  await rejects(noStore.preview(), { status: 501, code: CODES.UNAVAILABLE, field: 'store' })
  // A ledger that cannot be read is 503 — never "sequence 0".
  const unreadable = mount()
  unreadable.db.faults.select = (args) => (args.table === kit.T.run ? kit.sqlError('42P01', 'relation does not exist') : null)
  const failure = await rejects(unreadable.preview(), { status: 503, code: CODES.STORE_FAILED })
  assert.deepEqual([failure.details.operation, failure.details.sqlState], ['list_runs', '42P01'])
})

// ── NI-01 ────────────────────────────────────────────────────────────────────────────────────────────────

test('NI-01 the installing gate (rebaseline B-9): no dependency => the batch ledger is never asked; installing => a preview refusal and 409 in the lease, also when the install began after the preview', async () => {
  const off = mount()
  assert.equal(off.deps.installStateOf, undefined, 'the batch identifier is off: the route hands no reader')
  assert.equal((await off.preview()).eligible, true)
  const on = mount()
  let asked = 0
  let installing = true
  on.deps.installStateOf = async () => { asked += 1; return { installing } }
  const refused = await on.preview()
  assert.deepEqual([refused.eligible, refused.refusals, refused.planDigest, asked], [false, ['install_in_progress'], null, 1])
  // Not installing at the preview, installing by the time the lease is held: the in-lease check decides.
  installing = false
  const preview = await on.preview()
  assert.equal(preview.eligible, true)
  installing = true
  const error = await rejects(on.execute(preview.planDigest), { status: 409, code: CODES.INSTALL_IN_PROGRESS, reason: 'install_in_progress' })
  assert.equal(error.details.partial, false)
  assert.deepEqual([on.host.calls.length, on.db.rows(kit.T.run).length, on.db.rows(kit.T.claim).length], [0, 0, 0])
  assert.equal(on.db.rows(kit.T.lock)[0].lease_id, null)
  // A restore is gated the same way.
  installing = false
  const retired = await on.execute(preview.planDigest)
  installing = true
  assert.deepEqual((await on.restorePreview(retired.runId)).refusals, ['install_in_progress'])
  // A reader that answers anything but a boolean is a wiring defect, never "not installing".
  on.deps.installStateOf = async () => ({})
  await rejects(on.preview(), { status: 500, code: CODES.UNAVAILABLE, field: 'installStateOf' })
})

// ── FR-01 ────────────────────────────────────────────────────────────────────────────────────────────────

test('FR-01 the fills report: the K2 class of every pair, per-column states, unpaired old rows, paging — and never a cell value', async () => {
  const EXT = 'ext_shopNote'
  const cells = {
    // old root: one template fill the copy lacks => K2 can carry it
    rec_old_1: { notes: 'SENTINEL-OLD-NOTE' },
    // old C-1: the copy holds a DIFFERENT value => K2 refuses the whole row
    rec_old_2: { notes: 'SENTINEL-A', materialType: 'SENTINEL-SAME' },
    rec_copy_2: { notes: 'SENTINEL-B', materialType: 'SENTINEL-SAME' },
    // old C-2: a pack human column K2 cannot carry (and a template cell that is already equal)
    rec_old_3: { [EXT]: 'SENTINEL-EXT', demandDate: '2026-11-20' },
    rec_copy_3: { demandDate: '2026-11-20' },
    // old G-1: nothing on the old side; the copy alone is filled
    rec_copy_4: { procurementReply: 'SENTINEL-COPY-ONLY' },
  }
  const sheet = kit.doubledSheet({ mutate: (spec) => ({ ...spec, cells: cells[spec.id] || {} }) })
  // An inactive old row with a fill and no copy position (a child that left the BOM long ago).
  sheet.rows.push(kit.sheetRow({ tokens: [kit.OLD_ROOT, 'X-9'], id: 'rec_old_orphan', active: false, decision: 'inactive', summary: '{"type":"missing_from_plm"}', cells: { notes: 'SENTINEL-ORPHAN' } }))
  const summary = R.buildFillsReport({ scope: SCOPE, rows: sheet.rows, humanFieldIds: HUMAN_PRESERVED_FIELD_IDS, extHumanFieldIds: [EXT] })
  assert.deepEqual([summary.componentHandle, summary.total, summary.humanColumns], [null, 1, { template: HUMAN_PRESERVED_FIELD_IDS.length, pack: 1 }])
  assert.deepEqual(summary.components, [{
    componentHandle: HANDLE,
    shape: 'two_copy',
    counts: { nestedCopies: 1, pairs: 4, pairsWithFills: 4, k2Carryable: 1, reenterExtHuman: 1, reenterConflict: 1, nothingToCarry: 1, unpairedOldRows: 1, unpairedOldRowsWithFills: 1 },
    problems: ['path_only_old'],
  }])
  const detail = R.buildFillsReport({ scope: SCOPE, rows: sheet.rows, humanFieldIds: HUMAN_PRESERVED_FIELD_IDS, extHumanFieldIds: [EXT], componentHandle: HANDLE })
  assert.deepEqual([detail.found, detail.shape, detail.nextCursor, detail.pairs.length], [true, 'two_copy', null, 4])
  const byOld = Object.fromEntries(detail.pairs.map((pair) => [pair.oldRecordId, pair]))
  assert.deepEqual(byOld.rec_old_1, { ordinal: 1, copy: 1, depth: 0, oldRecordId: 'rec_old_1', copyRecordId: 'rec_copy_1', oldActive: true, class: 'k2_carryable', fields: { notes: { old: true, copy: false, state: 'carry' } } })
  assert.deepEqual([byOld.rec_old_2.class, byOld.rec_old_2.fields], ['reenter_conflict', { materialType: { old: true, copy: true, state: 'equal' }, notes: { old: true, copy: true, state: 'conflict' } }])
  assert.deepEqual([byOld.rec_old_3.class, byOld.rec_old_3.fields], ['reenter_ext_human', { demandDate: { old: true, copy: true, state: 'equal' }, [EXT]: { old: true, copy: false, state: 'carry', ext: true } }])
  assert.deepEqual([byOld.rec_old_4.class, byOld.rec_old_4.fields], ['nothing_to_carry', { procurementReply: { old: false, copy: true, state: 'copy_only' } }])
  for (const pair of detail.pairs) assert.ok(R.SHEET_REPAIR_FILL_CLASSES.includes(pair.class))
  for (const text of [JSON.stringify(summary), JSON.stringify(detail)]) {
    assert.equal(text.includes('SENTINEL'), false, 'no cell value')
    for (const planted of [kit.PROJECT_NO, kit.OLD_ROOT, kit.PARENT, 'C-1', '2026-11-20']) assert.equal(text.includes(planted), false, `${planted} leaked`)
  }
  // Paging.
  const first = R.buildFillsReport({ scope: SCOPE, rows: sheet.rows, extHumanFieldIds: [EXT], componentHandle: HANDLE, cursor: 0, limit: 3 })
  assert.deepEqual([first.pairs.map((pair) => pair.ordinal), first.nextCursor], [[1, 2, 3], '3'])
  const second = R.buildFillsReport({ scope: SCOPE, rows: sheet.rows, extHumanFieldIds: [EXT], componentHandle: HANDLE, cursor: 3, limit: 3 })
  assert.deepEqual([second.pairs.map((pair) => pair.ordinal), second.nextCursor], [[4], null])
  assert.deepEqual(R.buildFillsReport({ scope: SCOPE, rows: sheet.rows, componentHandle: 'f'.repeat(24) }), { componentHandle: 'f'.repeat(24), found: false, humanColumns: { template: HUMAN_PRESERVED_FIELD_IDS.length, pack: 0 } })
  // D2 (the old subtree already inactive — the item-10 shape) is reported too: that is where the hidden fills sit.
  const remnant = kit.doubledSheet({ mutate: (spec) => (spec.role === 'old' ? { ...spec, active: false, decision: 'inactive', summary: '{"type":"missing_from_plm"}', cells: spec.id === 'rec_old_2' ? { notes: 'hidden fill' } : {} } : spec) })
  const d2 = R.buildFillsReport({ scope: SCOPE, rows: remnant.rows })
  assert.deepEqual([d2.components[0].shape, d2.components[0].counts.pairs, d2.components[0].counts.k2Carryable, d2.components[0].problems], ['inactive_root_remnant', 4, 1, []])
  // The route's read: the report, audited before the answer (counts only); the pack band from the sheet's own properties.
  const audits = []
  const read = await R.readFillsReport({
    scope: SCOPE,
    template: { fields: HUMAN_PRESERVED_FIELD_IDS.map((id) => ({ id, ownership: 'human_preserved' })) },
    installedFieldProperties: [{ fieldId: EXT, property: { stockPreparation: { ownership: 'human_preserved', extension: true } } }],
    readRows: async () => sheet.rows,
    auditRead: async (entry) => { auditInternals.assertValuesFreeDetail(entry.detail); audits.push(entry) },
  }, { componentHandle: HANDLE })
  assert.deepEqual([read.humanColumns, read.counts.reenterExtHuman], [{ template: HUMAN_PRESERVED_FIELD_IDS.length, pack: 1 }, 1])
  assert.deepEqual(audits.map((entry) => [entry.mode, entry.detail.operation, entry.detail.listing, entry.detail.pairs, entry.detail.pairsWithFills, entry.detail.pageSize]), [['sheet_fills_report_read', 'sheet_fills_report', false, 4, 4, 4]])
  await rejects(R.readFillsReport({ scope: SCOPE, template: { fields: [] }, readRows: async () => sheet.rows, auditRead: async () => { throw Object.assign(new Error('audit down'), { status: 503, code: 'AUDIT_STORE_FAILED' }) } }, {}), { status: 503, code: 'AUDIT_STORE_FAILED' })
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-sheet-repair.test.cjs', tests)
