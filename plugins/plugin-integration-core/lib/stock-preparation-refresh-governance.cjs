'use strict'

// ---------------------------------------------------------------------------------------------------
// 备料 batch-refresh step 4, PR-2 — THE GOVERNANCE READER: the ONE consult every lane makes (design §5.1).
//
// `consult({ tenantId, projectNo, sheetId })` — the handle is SERVER-HELD: the route derives the tenant from
// the proven operator scope (never a header), the sheet from the overlay / registry and the project from
// the path validator (design §4.4). It performs, in order, each read failing closed:
//   1. the registry row by (tenant, project) AND by the resolved sheet, through PR B's pilot projection
//      (stock-preparation-project-target-store.cjs getPilotState / getPilotStateBySheetId: a row read on a
//      database without migration 101 reads as not pilot; a FAILED read is unreadable, never "not pilot");
//   2. continuations by (tenant, project) AND by sheet, their claim_active members;
//   3. open holds, the refresh-state row, the executions (newest five + every unfinished one) — by
//      (sheet, project) AND by (tenant, project);
//   4. the lock row: `readState(sheetWriteScopeKey(sheetId))` and `readGeneration(...)` (values-free).
//
// ONE SNAPSHOT FOR 1-3 (review X-1). Steps 1-3 run in ONE plugin-db transaction pinned to REPEATABLE READ by
// its first statement (the continuation store's `readGovernanceRows`; the registry reads are handed in as its
// `readFirst` and run on the same handle through PR B's `{ executor }` option). PostgreSQL takes the snapshot
// at the first SELECT — the registry read — so the pilot marker, the open holds, the continuations, their
// members and the state row's `decision_version` (the CAS key every hold reconciliation is handed back) are one
// point in time. A confirm / end that commits while the consult reads is wholly in the answer or wholly out of
// it; when out, the computation's reconciliation is refused 409 STOCK_PREP_PULL_STATE_MOVED instead of
// re-opening the hold the decision just resolved, and no derivation can mix "continuation gone" with "hold
// resolved" into a torn 已完成. A registry refusal still happens before any step-4 row is read.
//
// STEP 4 STAYS OUTSIDE THE SNAPSHOT. The lock module reads its row on its own handle, after the snapshot
// commits. The lock row is never the CAS key (decision_version is), so no tear there can let a stale hold set
// persist; and the derivation takes only a LIVE / HELD lease from it, so a lease or an execution row that
// straddles the boundary derives a state that refuses writes and the export: a lease acquired after the
// snapshot derives 执行中 (`executing`); a lease released after it leaves a snapshot `running` execution with no
// live lease, which derives 失败待恢复 (`failed_pending_recovery`, transient until the next consult); a lease
// acquired between `readState` and `readGeneration` derives 失败待恢复 too. The ONE interleaving this does not
// refuse: a WHOLE execution — its row begun after the snapshot's first SELECT, finished and its lease released
// before the lock read — is invisible to both halves, and the answer is the state before it (possibly 已完成,
// export allowed). The review (round 2) reproduced it with a zero-write FAILED run: the stale consult answers
// 已完成, the next one 失败待恢复. A settling computation built on such a consult names the execution it saw
// (O-14), so it cannot settle over the unseen one. The formal export must not trust one consult, and one more
// consult is not enough either: a FINAL re-consult can itself land after such a whole run and miss it the same
// way (reproduced on real PG by the reviewer of record). A zero-write failure leaves the generation token and
// the sheet's machine digest unchanged but ADVANCES the lock's fencing epoch (its acquire), so the formal
// export (PR-5, design §23.7 O-21 as replaced) must run the fixed order G0 -> C1 -> data read -> C2 +
// settlement -> G1: read the lock generation (G0), derive the state (C1), read the data and build the file,
// derive the state again with the settlement check (C2), read the lock generation again (G1) — and refuse
// unless G0 and G1 carry the same `generationToken` AND the same `fencingEpoch` with no in-flight lease.
// Nothing here guarantees that by itself; this module only answers one consult.
// Then the assertions: EVERY row's tenant must be the proven tenant (409 STOCK_PREP_REFRESH_TENANT_MISMATCH —
// a derivation discrepancy fails closed, A-M6); every governed row must name the RESOLVED sheet and this
// project, and the registry row of a PILOT project must name the resolved sheet (409
// STOCK_PREP_REFRESH_TARGET_RETARGETED — the project-sheets switch turned off re-targets the action at the env
// sheet while the project's protection lives on its managed sheet; nothing may be written or exported there,
// B-B3 / E-2(b)). A NON-pilot registered project is governed only by its step-4 rows, which `assertRows`
// checks against the resolved sheet; a registered project with neither answers `not_governed` (owner ruling
// 2026-10-24, GV-1: its switch-off pull keeps today's behaviour). The resolved sheet registered to ANOTHER
// tenant or project stays an unconditional refusal (TD-27). A header-steered tenant that owns no rows is
// therefore REFUSED by the sheet-keyed read, never answered "nothing governs this project".
//
// THREE ANSWERS, NEVER TWO (plan §8, §9.1 A11; design D8): a thrown read anywhere is
// StockPreparationRefreshGovernanceError(503, STOCK_PREP_REFRESH_STORE_FAILED, { store, operation,
// sqlState?, partial: false }) — the planner never proceeds "without continuations", the export never
// reads a row, the board answers `readable: false`; `not_governed` is answered only when EVERY store
// answered and none holds a row for this project. A service that is not wired (no plugin SQL db, or a
// registry store without PR B's pilot reads) is 501 STOCK_PREP_REFRESH_STORE_UNAVAILABLE at consult time —
// a wiring defect by name, never silently "not pilot" (the posture of the pilot gate's `store_surface`).
//
// THE ANSWER is frozen and server-held (it carries the PRIVATE member keys the planner's projection needs;
// it is never a response body): `{ ok: true, scope, governed, pilot, registry, continuations, members, holds,
// state, executions, changePlans, lock: { state, generation }, decisionVersionObserved }` — exactly
// what lib/stock-preparation-refresh-state.cjs `readProjectRefreshState` derives from and, through
// `plannerSlice`, what the pure core's `normalizeContinuationInput` accepts (non-ended headers with
// `memberCount`, claim_active members). `changePlans` (step 5 PR-8, migration 104; O-19 closed) are the PENDING
// plans — `confirmed` and `written` — as the store's values-free summaries, read in the same snapshot.
//
// `governed` = pilot.enabled === true || any durable step-4 / step-5 row for (tenant, project) on any sheet — the
// registry marker alone or persisted rows alone both govern (D3 / C10 / U07: clearing the pilot marker
// never releases protection that rows hold).
//
// NOT HERE: no lane wiring (PR-3), no route, no env flag, no write.
// ---------------------------------------------------------------------------------------------------

const { sheetWriteScopeKey } = require('./stock-preparation-project-write-lock.cjs')
const { StockPreparationRefreshStoreError, REFRESH_STORE_ERROR_CODES } = require('./stock-preparation-continuation-store.cjs')
const { readProjectRefreshState } = require('./stock-preparation-refresh-state.cjs')

const REFRESH_GOVERNANCE_ERROR_CODES = Object.freeze({
  STORE_FAILED: REFRESH_STORE_ERROR_CODES.STORE_FAILED,
  STORE_UNAVAILABLE: REFRESH_STORE_ERROR_CODES.STORE_UNAVAILABLE,
  TENANT_MISMATCH: REFRESH_STORE_ERROR_CODES.TENANT_MISMATCH,
  TARGET_RETARGETED: 'STOCK_PREP_REFRESH_TARGET_RETARGETED',
  INPUT_INVALID: REFRESH_STORE_ERROR_CODES.INPUT_INVALID,
})

// The stores a consult reads, as values-free tokens in error details.
const GOVERNANCE_STORES = Object.freeze(['registry', 'continuation', 'lock'])

class StockPreparationRefreshGovernanceError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationRefreshGovernanceError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function nonBlankString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function sqlStateOf(error) {
  const code = error && typeof error.code === 'string' ? error.code : ''
  return /^[0-9A-Z]{5}$/.test(code) ? code : undefined
}

function scopeInvalid(field) {
  return new StockPreparationRefreshGovernanceError(422, REFRESH_GOVERNANCE_ERROR_CODES.INPUT_INVALID, `${field} is required`, { field })
}

function unavailable(reason) {
  return new StockPreparationRefreshGovernanceError(501, REFRESH_GOVERNANCE_ERROR_CODES.STORE_UNAVAILABLE, 'the refresh governance reader is not wired on this deployment; refusing to answer', { reason })
}

function storeFailed(store, operation, error) {
  const sqlState = sqlStateOf(error)
  return new StockPreparationRefreshGovernanceError(503, REFRESH_GOVERNANCE_ERROR_CODES.STORE_FAILED, 'the refresh governance state could not be read; nothing continued', {
    store,
    operation,
    ...(sqlState ? { sqlState } : {}),
    partial: false,
  })
}

function tenantMismatch(store, table) {
  return new StockPreparationRefreshGovernanceError(409, REFRESH_GOVERNANCE_ERROR_CODES.TENANT_MISMATCH, 'a governance row does not belong to the proven tenant; refusing', { store, table })
}

function retargeted(store, table, reason) {
  return new StockPreparationRefreshGovernanceError(409, REFRESH_GOVERNANCE_ERROR_CODES.TARGET_RETARGETED, 'this project\'s refresh protection lives on another sheet (or this sheet is governed by another project); nothing may be planned, written or exported here', { store, table, reason })
}

// A store-level error becomes the governance error of the same meaning; anything else is 503.
function translate(store, operation, error) {
  if (error instanceof StockPreparationRefreshGovernanceError) return error
  if (error instanceof StockPreparationRefreshStoreError) {
    if (error.code === REFRESH_STORE_ERROR_CODES.TENANT_MISMATCH) return tenantMismatch(store, error.details && error.details.table)
    if (error.code === REFRESH_STORE_ERROR_CODES.STORE_UNAVAILABLE) return unavailable(error.details && error.details.reason ? error.details.reason : 'store_surface')
    return new StockPreparationRefreshGovernanceError(error.status === 503 ? 503 : error.status, error.code, error.message, { store, ...error.details })
  }
  // The lock's own typed store failure (503 STORE_FAILED) and any thrown read: unreadable, by name.
  return storeFailed(store, operation, error)
}

function normalizeScope(input = {}) {
  const tenantId = nonBlankString(input.tenantId) ? input.tenantId.trim() : null
  const projectNo = nonBlankString(input.projectNo) ? input.projectNo.trim() : null
  const sheetId = nonBlankString(input.sheetId) ? input.sheetId.trim() : null
  if (!tenantId) throw scopeInvalid('tenantId')
  if (!projectNo) throw scopeInvalid('projectNo')
  if (!sheetId) throw scopeInvalid('sheetId')
  return Object.freeze({ tenantId, projectNo, sheetId, writeScopeKey: sheetWriteScopeKey(sheetId) })
}

function assertRows(rows, scope, store, table) {
  for (const row of rows) {
    if (!row) continue
    if (row.tenantId !== scope.tenantId) throw tenantMismatch(store, table)
    if (row.sheetId !== scope.sheetId) throw retargeted(store, table, 'sheet')
    if (row.projectNo !== scope.projectNo) throw retargeted(store, table, 'project')
  }
}

function pilotOf(registry) {
  if (!registry) return null
  return Object.freeze({
    enabled: registry.pilot === true,
    enabledAt: registry.pilot === true ? registry.pilotEnabledAt || null : null,
    enabledBy: registry.pilot === true ? registry.pilotEnabledBy || null : null,
    readinessVersion: registry.pilot === true ? registry.pilotReadinessVersion ?? null : null,
  })
}

/**
 * The slice of a consult answer the planner's `continuation` input takes (design §6.1): non-ended headers
 * with `memberCount`, and the claim_active members. Pure. (PR-3 adds the recorder output, the source
 * identity and `specSlotDeclared` from the request it is planning.)
 */
function plannerSlice(consult) {
  if (!isPlainObject(consult) || consult.ok !== true) {
    throw new StockPreparationRefreshGovernanceError(503, REFRESH_GOVERNANCE_ERROR_CODES.STORE_FAILED, 'a planner slice needs a successful consult', { store: 'continuation', operation: 'planner_slice', partial: false })
  }
  const continuations = consult.continuations.filter((entry) => entry.status !== 'ended').map((entry) => Object.freeze({
    id: entry.id,
    status: entry.status,
    statusReason: entry.statusReason,
    revision: entry.revision,
    comparisonFingerprint: entry.comparisonFingerprint,
    evidenceFingerprint: entry.evidenceFingerprint,
    pairingFingerprint: entry.pairingFingerprint,
    sourceScopeDigest: entry.sourceScopeDigest,
    readPlanDigest: entry.readPlanDigest,
    oldRootKey: entry.oldRootKey,
    newRootKey: entry.newRootKey,
    memberCount: entry.memberCount,
  }))
  return Object.freeze({ continuations: Object.freeze(continuations), members: consult.members })
}

function createStockPreparationRefreshGovernance({ continuationStore = null, projectTargetStore = null, projectWriteLock = null } = {}) {
  function requireWired() {
    if (!continuationStore || typeof continuationStore.readGovernanceRows !== 'function') throw unavailable('continuation_store')
    if (!projectTargetStore || typeof projectTargetStore.getPilotState !== 'function' || typeof projectTargetStore.getPilotStateBySheetId !== 'function') throw unavailable('registry_pilot_reads')
    if (!projectWriteLock || typeof projectWriteLock.readState !== 'function' || typeof projectWriteLock.readGeneration !== 'function') throw unavailable('project_write_lock')
  }

  // `snapshot` is the consult's REPEATABLE READ transaction handle (review X-1): PR B's reads run ON it, so the
  // registry row and the step-4 rows are one point in time.
  async function readRegistry(scope, snapshot) {
    let byProject
    let bySheet
    try {
      byProject = await projectTargetStore.getPilotState({ tenantId: scope.tenantId, projectNo: scope.projectNo }, { executor: snapshot })
    } catch (error) {
      throw translate('registry', 'pilot_state_by_project', error)
    }
    try {
      bySheet = await projectTargetStore.getPilotStateBySheetId({ sheetId: scope.sheetId }, { executor: snapshot })
    } catch (error) {
      throw translate('registry', 'pilot_state_by_sheet', error)
    }
    if (bySheet) {
      if (bySheet.tenantId !== scope.tenantId) throw tenantMismatch('registry', 'project_target')
      if (bySheet.projectNo !== scope.projectNo) throw retargeted('registry', 'project_target', 'sheet_registered_to_another_project')
    }
    // GV-1 (batch-refresh step 4 PR-3a; coordinator ruling R-3 / TD-3 replaced, Ratified-by-default-2026-10-24):
    // only a PILOT registry row on another sheet refuses here, before any step-4 read. A registered project
    // that is not pilot is governed only by its step-4 rows, which `assertRows` checks against the resolved
    // sheet (the (tenant, project) reads return them wherever they live); with neither it answers
    // `not_governed`, which is today's behaviour for that project (switch off => the env sheet). The two
    // checks above (the resolved sheet registered to another tenant / project) stay unconditional (TD-27).
    if (byProject && byProject.pilot === true && byProject.sheetId !== scope.sheetId) throw retargeted('registry', 'project_target', 'project_registered_on_another_sheet')
    return byProject || null
  }

  /**
   * The consult. Throws 503 (unreadable), 409 (tenant mismatch / retargeted), 501 (not wired), 422 (scope);
   * otherwise answers the frozen, server-held consult object described in the module header.
   */
  async function consult(input = {}) {
    const scope = normalizeScope(input)
    requireWired()
    // ONE snapshot (review X-1): the store opens the REPEATABLE READ transaction and runs the registry reads
    // FIRST on its handle, then every step-4 read. A registry refusal (409) or failure (503) is thrown inside it
    // and passes through untouched (the transaction rolls back before any step-4 row is read).
    let registry = null
    let registryRead = false
    let rows
    try {
      rows = await continuationStore.readGovernanceRows(
        { tenantId: scope.tenantId, sheetId: scope.sheetId, projectNo: scope.projectNo },
        {
          readFirst: async (snapshot) => {
            registry = await readRegistry(scope, snapshot)
            registryRead = true
          },
        },
      )
    } catch (error) {
      throw translate('continuation', 'read_governance_rows', error)
    }
    if (!isPlainObject(rows) || rows.ok !== true) throw storeFailed('continuation', 'read_governance_rows', null)
    // A store that answered without running the registry reads in its snapshot never read the registry: that is
    // unreadable by name, never "not pilot".
    if (!registryRead) throw storeFailed('registry', 'read_snapshot', null)
    assertRows(rows.continuations, scope, 'continuation', 'continuation')
    assertRows(rows.members, scope, 'continuation', 'continuation_member')
    assertRows(rows.holds, scope, 'continuation', 'refresh_hold')
    assertRows(rows.states, scope, 'continuation', 'refresh_state')
    assertRows(rows.executions, scope, 'continuation', 'refresh_execution')
    // Step 5 PR-8 (O-19 closed): the pending change plans the store read in the same snapshot (values-free summaries
    // carrying their scope triple). A store answer without the list is unreadable by name, never "no plan".
    if (!Array.isArray(rows.changePlans)) throw storeFailed('continuation', 'read_change_plans', null)
    assertRows(rows.changePlans, scope, 'continuation', 'change_plan')
    if (rows.states.length > 1) throw retargeted('continuation', 'refresh_state', 'multiple_state_rows')

    let lockState
    let lockGeneration
    try {
      lockState = await projectWriteLock.readState(scope.writeScopeKey)
    } catch (error) {
      throw translate('lock', 'read_state', error)
    }
    try {
      lockGeneration = await projectWriteLock.readGeneration(scope.writeScopeKey)
    } catch (error) {
      throw translate('lock', 'read_generation', error)
    }
    if (!isPlainObject(lockState) || !isPlainObject(lockGeneration)) throw storeFailed('lock', 'read_state', null)
    // The lock answers an ABSENT row without `leaseLive` (nothing to be live); the derivation requires the two
    // booleans on every answer — stated explicitly here, never inferred from a missing key elsewhere.
    const lock = Object.freeze({
      state: Object.freeze({ ...lockState, leaseHeld: lockState.leaseHeld === true, leaseLive: lockState.leaseLive === true }),
      generation: lockGeneration,
    })

    const memberCounts = new Map()
    for (const member of rows.members) memberCounts.set(member.continuationId, (memberCounts.get(member.continuationId) || 0) + 1)
    const continuations = rows.continuations.map((entry) => Object.freeze({ ...entry, memberCount: memberCounts.get(entry.id) || 0 }))
    const state = rows.states[0] || null
    const pilot = pilotOf(registry)
    const anyRows = continuations.length > 0 || rows.members.length > 0 || rows.holds.length > 0 || state !== null || rows.executions.length > 0
      || rows.changePlans.length > 0
    return Object.freeze({
      ok: true,
      scope,
      governed: Boolean(pilot && pilot.enabled) || anyRows,
      pilot,
      registry: registry ? Object.freeze({ sheetId: registry.sheetId, objectId: registry.objectId, status: registry.status }) : null,
      continuations: Object.freeze(continuations),
      members: Object.freeze(rows.members.slice()),
      holds: Object.freeze(rows.holds.slice()),
      state,
      executions: Object.freeze(rows.executions.slice()),
      changePlans: Object.freeze(rows.changePlans.slice()),
      lock,
      decisionVersionObserved: state ? state.decisionVersion : 0,
    })
  }

  /**
   * Step 5 PR-8 review fix N1: the pilot marker of ONE project read ON THE CALLER'S TRANSACTION HANDLE — PR B's
   * projection by (tenant, project) with `{ executor: trx }`, the consult's own registry read. The combined change-plan
   * confirm calls it after its state-row lock (the PR-4 rule: every admissibility fact under the lock). Answers
   * `{ enabled }`: true only for a pilot row registered on THIS sheet (the consult refuses any other pilot row as
   * retargeted). A thrown read is the governance 503 (never "not pilot"); unwired is 501.
   */
  async function readPilotWithin(input = {}, trx) {
    const scope = normalizeScope(input)
    requireWired()
    if (!trx || typeof trx.selectOne !== 'function') throw unavailable('pilot_read_handle')
    let row
    try {
      row = await projectTargetStore.getPilotState({ tenantId: scope.tenantId, projectNo: scope.projectNo }, { executor: trx })
    } catch (error) {
      throw translate('registry', 'pilot_state_within', error)
    }
    return Object.freeze({ enabled: Boolean(row && row.pilot === true && row.sheetId === scope.sheetId) })
  }

  /**
   * The derived state for a read surface (board / directory / overview / export gate): a store failure is
   * answered as the `unreadable` state (never thrown away as "no rows"); a tenant mismatch or a retarget is
   * a refusal and is RETHROWN — those must stop the caller, not be displayed as a state.
   */
  async function readRefreshState(input = {}) {
    let answer
    try {
      answer = await consult(input)
    } catch (error) {
      if (error instanceof StockPreparationRefreshGovernanceError && (error.status === 409 || error.status === 422)) throw error
      // The values-free failure tokens ride into the derived state (`unreadable.store` / `.operation`).
      const details = error && isPlainObject(error.details) ? error.details : {}
      const failure = {
        store: typeof details.store === 'string' ? details.store : 'governance',
        operation: typeof details.operation === 'string' ? details.operation : (typeof details.reason === 'string' ? details.reason : 'consult'),
      }
      return Object.freeze({ consult: null, error, state: readProjectRefreshState({ ok: false, failure }) })
    }
    return Object.freeze({ consult: answer, error: null, state: readProjectRefreshState(answer) })
  }

  return Object.freeze({ consult, readRefreshState, readPilotWithin, plannerSlice })
}

module.exports = {
  GOVERNANCE_STORES,
  REFRESH_GOVERNANCE_ERROR_CODES,
  StockPreparationRefreshGovernanceError,
  createStockPreparationRefreshGovernance,
  plannerSlice,
  __internals: {
    assertRows,
    normalizeScope,
    pilotOf,
    translate,
  },
}
