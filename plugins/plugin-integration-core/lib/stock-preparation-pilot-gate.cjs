'use strict'

// ---------------------------------------------------------------------------------------------------
// 备料分批拉取第一期 step 3 PR B — THE PILOT LANE GATE.
//
// Plan §5.1 (第一期只支持小车道): a project whose registry row carries the pilot marker (migration 101,
// `pilot_enabled_at IS NOT NULL`) is REFUSED on every large-BOM route — expansion start, expansion run,
// plan, approve, and every chunk (again INSIDE the sheet write lease, before the job turns `running`) —
// and its small-lane preview, when the expansion hit any small-lane cap (max rows / pages / read count /
// read time), is refused instead of being handed to the large lane the panel would otherwise auto-start.
// Jobs approved BEFORE the enablement get this code too (L02), not PLAN_SUPERSEDED: the pilot check runs
// ahead of the generation binding check wherever both run.
//
// THREE ANSWERS, NEVER TWO (plan §9.1 A11 / step-4 design D8): `pilot`, `not_pilot`, and a read that
// FAILED — answered 503 STOCK_PREP_PILOT_STATE_UNREADABLE and never folded into "not pilot". A registry
// row read on a database where migration 101 has not run has no pilot column and reads as not pilot
// (nothing could have been enabled there; rowToPilotState in the store). A deployment with NO registry
// store at all (no plugin SQL db) has no project sheets and no enable route (501) — it reads as not pilot
// and says so (`registry: 'absent'`); a store that exists but lacks the pilot reads is a wiring defect
// and is 503, never silently not pilot.
//
// BY PROJECT AND BY SHEET (L04, step-4 design §5.1): the read consults the registry by (tenant, project
// number) AND by the sheet the lane is about to write; either row being pilot refuses. Splitting a pilot
// project into other parameter ranges keeps the same project number; targeting its sheet through a stored
// job snapshot keeps the same sheet id; switching the project-sheets switch off re-targets the project at
// the old env sheet but the project-number read still answers.
//
// VALUES-FREE: a refusal names the lane, a reason token and two booleans; a 503 names the operation and
// a SQLSTATE class code. No project number, sheet id or tenant leaves this module in an error.
// ---------------------------------------------------------------------------------------------------

const PILOT_ERROR_CODES = Object.freeze({
  LARGE_LANE_REFUSED: 'STOCK_PREP_PILOT_LARGE_LANE_REFUSED',
  SMALL_LANE_LIMIT_EXCEEDED: 'STOCK_PREP_PILOT_SMALL_LANE_LIMIT_EXCEEDED',
  STATE_UNREADABLE: 'STOCK_PREP_PILOT_STATE_UNREADABLE',
  NOT_READY: 'STOCK_PREP_PILOT_NOT_READY',
})

// The large lanes a refusal can name (closed; `assertLargeLaneAllowed` refuses an unknown token with 500).
const PILOT_LARGE_LANES = Object.freeze([
  'large_expansion_start',
  'large_expansion_run',
  'large_plan',
  'large_approve',
  'large_apply_chunk',
])

const PILOT_STATES = Object.freeze(['pilot', 'not_pilot'])

class StockPreparationPilotError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationPilotError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

// Values-free: SQLSTATE only (five characters, a class code — never a message, never a value).
function sqlStateOf(error) {
  const code = error && typeof error.code === 'string' ? error.code : ''
  return /^[0-9A-Z]{5}$/.test(code) ? code : undefined
}

function unreadable(operation, error) {
  const sqlState = sqlStateOf(error)
  return new StockPreparationPilotError(
    503,
    PILOT_ERROR_CODES.STATE_UNREADABLE,
    'the pilot state of this project could not be read; the lane did not continue',
    { operation, ...(sqlState ? { sqlState } : {}), partial: false },
  )
}

function assertLargeLane(lane) {
  if (!PILOT_LARGE_LANES.includes(lane)) {
    throw new StockPreparationPilotError(500, PILOT_ERROR_CODES.STATE_UNREADABLE, 'unknown pilot lane', { operation: 'lane_vocabulary', reason: 'lane_unknown', partial: false })
  }
  return lane
}

/**
 * The gate over the registry store (stock-preparation-project-target-store.cjs). `store` may be null
 * (no plugin SQL db): then nothing can be pilot and the gate says so by name.
 */
function createStockPreparationPilotGate({ store = null } = {}) {
  function pilotReads() {
    if (!store) return null
    if (typeof store.getPilotState !== 'function' || typeof store.getPilotStateBySheetId !== 'function') {
      throw unreadable('store_surface', null)
    }
    return store
  }

  /**
   * `{ state: 'pilot' | 'not_pilot', byProject, bySheet, registry: 'present' | 'absent' }`. Reads by
   * (tenant, project) when both are given and by sheet when one is given; a read that throws is 503.
   *
   * Pre-enable hardening F-4(a) (step-4 design §23.4): a call that names NEITHER identity — no (tenant,
   * project) pair and no sheet — is REFUSED, never answered `not_pilot`: with nothing to read, "not pilot"
   * would be a guess, and every lane gate built on it would let a pilot project through. Checked first,
   * before the absent-registry answer, because a caller that cannot name what it is about to touch is a
   * defect whatever the deployment (every route passes the sheet it writes). 500 STATE_UNREADABLE with
   * `reason: 'identity_missing'` — the same answer as an unknown lane token: a caller error, never a
   * client one, and never "proceed".
   */
  async function readPilotState({ tenantId, projectNo, sheetId } = {}) {
    const tenant = nonEmptyString(tenantId)
    const project = nonEmptyString(projectNo)
    const sheet = nonEmptyString(sheetId)
    if (!(tenant && project) && !sheet) {
      throw new StockPreparationPilotError(500, PILOT_ERROR_CODES.STATE_UNREADABLE, 'the pilot state was asked without a project or a sheet to read it by', { operation: 'pilot_state_read', reason: 'identity_missing', partial: false })
    }
    const reads = pilotReads()
    if (!reads) return Object.freeze({ state: 'not_pilot', byProject: false, bySheet: false, registry: 'absent' })
    let byProject = null
    let bySheet = null
    try {
      if (tenant && project) byProject = await reads.getPilotState({ tenantId: tenant, projectNo: project })
      if (sheet) bySheet = await reads.getPilotStateBySheetId({ sheetId: sheet })
    } catch (error) {
      throw unreadable('pilot_state_read', error)
    }
    const pilotByProject = Boolean(byProject && byProject.pilot === true)
    const pilotBySheet = Boolean(bySheet && bySheet.pilot === true)
    return Object.freeze({
      state: pilotByProject || pilotBySheet ? 'pilot' : 'not_pilot',
      byProject: pilotByProject,
      bySheet: pilotBySheet,
      registry: 'present',
    })
  }

  /** 409 STOCK_PREP_PILOT_LARGE_LANE_REFUSED for a pilot project; 503 when the state cannot be read. */
  async function assertLargeLaneAllowed(input, lane) {
    assertLargeLane(lane)
    const read = await readPilotState(input)
    if (read.state === 'pilot') {
      throw new StockPreparationPilotError(
        409,
        PILOT_ERROR_CODES.LARGE_LANE_REFUSED,
        'this project is a batch-refresh pilot: the large-BOM lane is refused for pilot projects (phase 1 supports the small lane only); nothing was written',
        { lane, reason: 'pilot_project', byProject: read.byProject, bySheet: read.bySheet, partial: false },
      )
    }
    return read
  }

  /**
   * The small lane's over-cap rule (plan §5.1 「超过小车道上限时明确拒绝,不自动转大车道、不截断数据」):
   * called by the dry run ONLY when the expansion hit a small-lane cap — a pilot project is refused 409
   * STOCK_PREP_PILOT_SMALL_LANE_LIMIT_EXCEEDED there, before any token is minted and before the response
   * that would have told the panel to start the large lane; a non-pilot project keeps its
   * `large_bom_bounded` answer byte for byte.
   */
  async function assertSmallLaneCapNotExceededForPilot(input) {
    const read = await readPilotState(input)
    if (read.state === 'pilot') {
      throw new StockPreparationPilotError(
        409,
        PILOT_ERROR_CODES.SMALL_LANE_LIMIT_EXCEEDED,
        'this pilot project exceeds a small-lane cap and the large lane is refused for pilot projects: the pull stops here (nothing was truncated, nothing was written); the owner decides how to proceed',
        { reason: 'pilot_project', byProject: read.byProject, bySheet: read.bySheet, partial: false },
      )
    }
    return read
  }

  return Object.freeze({ readPilotState, assertLargeLaneAllowed, assertSmallLaneCapNotExceededForPilot })
}

module.exports = {
  PILOT_ERROR_CODES,
  PILOT_LARGE_LANES,
  PILOT_STATES,
  StockPreparationPilotError,
  createStockPreparationPilotGate,
}
