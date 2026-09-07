'use strict'

// 拉取目标扫描 — THE ONE PLACE THAT READS THE SHEET THE OPERATOR'S OWN PULL WROTE.
//
// ---------------------------------------------------------------------------
// WHY THIS MODULE EXISTS AT ALL
// ---------------------------------------------------------------------------
//
// Two surfaces now need the same facts out of the bound table-action target:
//
//   * 项目备料页 (`stock-preparation-project-board.cjs`) — ONE project's row counts and its
//     `lastChangedFromPlmAt`, filtered to that project number; and
//   * 一线看得见自己工厂的项目 (`stock-preparation-operator-project-directory.cjs`) — the DISTINCT
//     project numbers that appear in that sheet at all, because the MVP project ledger the directory
//     used to be built from is written by `mvp-persist`, which is platform-admin and skips the floor
//     operator entirely. A project a one-line operator pulled themselves was never in the directory,
//     so the home page, the search box and the query panel were all empty on the ONE flow the
//     operator tier exists for.
//
// Both readings must agree about THREE things or the two pages contradict each other in front of the
// same person: which sheet is the caller's own, how a row's `lastPlmRefreshAt` cell is parsed, and
// what a TRUNCATED scan is allowed to claim. So the scan is one implementation with a `projectNo`
// parameter, exactly the way `listOperatorProjectDirectory` is one implementation with a `projectNo`
// parameter — the board's own header explains why that shape was chosen there, and the reasoning is
// unchanged here.
//
// NOTHING IN THIS FILE IS NEW BEHAVIOUR FOR THE BOARD. `resolveOwnBoundSheet`,
// `parsePlmRefreshTimestampMs` and `readPullTargetRowFacts` moved here byte-for-byte in intent; the
// board keeps re-exporting them under `__internals` so its suite still addresses them where it
// always did. What is new is `scanPullTargetProjects`, the UNNARROWED grouping the directory needs.
//
// ---------------------------------------------------------------------------
// THE TENANT GATE IS THE WHOLE SAFETY STORY, AND IT IS UNCHANGED
// ---------------------------------------------------------------------------
//
// `action.target` is DEPLOY-TIME configuration shared by every tenant on the deployment, so the
// sheet id it names is NOT derived from the caller's tenant. Every read here therefore goes through
// `resolveOwnBoundSheet`, which hands back a sheet id ONLY when the caller's own staging project is
// proved to own it — by the provisioning registry, or by the deterministic (project, object) hash.
// A caller who is not the owner never reads that sheet at all. This module adds no new way to name a
// sheet and takes no tenant id of its own: it is handed an already-proved `ownSheet` or it reads
// nothing.

const { optionalString } = require('./stock-preparation-common.cjs')
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require('./stock-preparation-templates.cjs')
const {
  REQUIRED_EXPORT_FIELD_IDS,
  __internals: EXPORT_INTERNALS,
} = require('./stock-preparation-prep-line-export.cjs')

/** The sheet the operator FILLS. Frozen here so the handle can never point at a different table. */
const STOCK_PREPARATION_FILL_OBJECT_ID = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId

/** Paging bounds for the pull-target scan. The same shape the export uses, from the same module. */
const PULL_TARGET_PAGE_LIMIT = EXPORT_INTERNALS.READ_PAGE_LIMIT
const PULL_TARGET_MAX_PAGES = EXPORT_INTERNALS.READ_MAX_PAGES

const PULL_TARGET_NOT_READY = Object.freeze({
  ready: false,
  rowCount: 0,
  activeRowCount: 0,
  bounded: false,
  lastChangedFromPlmAt: null,
  lastChangedFromPlmBounded: false,
})

/**
 * THE TENANT GATE ON THE BOUND TARGET, factored out because THREE things ride it — the board's fill
 * handle, the board's pull-target row counts, and now the directory's distinct-project scan — and
 * they must never be able to disagree about whether the bound sheet is the caller's own.
 *
 * Returns `{ sheetId, objectId }` when the bound sheet is PROVED to belong to the caller's own
 * staging project and to exist; otherwise null.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE ARE TWO PROOFS, AND WHY THE FIRST ONE ALONE WAS WRONG
 * ---------------------------------------------------------------------------
 *
 * The first cut proved ownership by recomputing `getObjectSheetId(ourStagingProject, boundObjectId)`
 * and comparing it to the bound sheet id. That is sound as far as it goes — the hash is over
 * (projectId, objectId), so a match embeds our own project id and cannot be forged by a config that
 * names someone else's sheet. But it is a BINDING-SHAPE test, and it answers "no" to sheets we
 * genuinely own whenever the binding names a different objectId than the one the sheet was created
 * under. That is not a hypothetical: the sanctioned 222 deploy-window step (D1=B) rebinds the action
 * to a SANDBOX objectId while KEEPING the sheet the deployment already had, so on exactly the
 * configuration the runbook tells operators to use, the fill handle would never appear and the row
 * counts would report "table not ready" over a table full of their own rows. It also cannot speak at
 * all about a sheet an administrator bound by hand.
 *
 * So ownership is proved from the SHEET as well. `isSheetOwnedByProject` is the host's
 * provisioning-registry lookup — `plugin_multitable_object_registry` records which project owns each
 * sheet at provisioning time — and it answers a BOOLEAN about the project we name, so no other
 * tenant's project id is ever returned to this plugin in the first place.
 *
 * The two are a DISJUNCTION of independently sufficient proofs, not a replacement: either the
 * registry says the sheet is ours, or its id hashes from our own project. Both are sound, so their
 * disjunction is sound, and a host too old to expose the port keeps exactly the behaviour it had.
 *
 * `findObjectSheet` remains the EXISTENCE proof — but it is only usable on the hash path, where we
 * know the (project, objectId) the sheet was created under. On the registry path the registry row IS
 * the existence evidence: a sheet id is in it because provisioning put it there.
 */
async function resolveOwnBoundSheet(provisioning, stagingProjectId, boundTarget) {
  if (!provisioning) return null
  const boundSheetId = optionalString(boundTarget && boundTarget.sheetId)
  if (!boundSheetId) return null
  const objectId = optionalString(boundTarget && boundTarget.objectId) || STOCK_PREPARATION_FILL_OBJECT_ID

  // PROOF 1 — THE REGISTRY. Optional capability: a plugin newer than its host simply falls through.
  // The port answers a yes/no about the project we ASK about, so it never hands back another
  // tenant's project id — an id-returning form could not be made safe here, because plugin project
  // namespaces are per-PLUGIN and every stock-prep tenant shares one.
  if (typeof provisioning.isSheetOwnedByProject === 'function') {
    let owned = false
    try {
      owned = await provisioning.isSheetOwnedByProject(boundSheetId, stagingProjectId) === true
    } catch {
      owned = false
    }
    // A "no" is not a refusal — an unclaimed sheet answers the same way — so it falls through to the
    // second proof rather than ending the resolution.
    if (owned) return { sheetId: boundSheetId, objectId }
  }

  // PROOF 2 — THE DETERMINISTIC ID, plus an existence check. Unchanged from the first cut.
  if (typeof provisioning.getObjectSheetId !== 'function') return null
  if (typeof provisioning.findObjectSheet !== 'function') return null
  if (provisioning.getObjectSheetId(stagingProjectId, objectId) !== boundSheetId) return null
  const sheet = await provisioning.findObjectSheet({ projectId: stagingProjectId, objectId })
  const sheetId = sheet && sheet.id ? String(sheet.id) : ''
  if (!sheetId || sheetId !== boundSheetId) return null
  return { sheetId, objectId }
}

/**
 * Best-effort timestamp parse for a `lastPlmRefreshAt` cell. The planner writes an ISO string
 * (`normalizeIsoTime`), but a row is somebody else's data by the time this reads it back, so this
 * accepts a `Date` too and rejects everything else — never throws, since one unparsable cell must not
 * cost the whole scan its `lastChangedFromPlmAt`, only that cell's vote toward the max.
 */
function parsePlmRefreshTimestampMs(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getTime()
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const ms = Date.parse(value)
    return Number.isNaN(ms) ? null : ms
  }
  return null
}

/**
 * THE TARGET'S FIELD BINDINGS, or null when the target cannot be read at all.
 *
 * Resolved through the export module's own target normalization and its own two-mode field-binding
 * rule (an EMPTY `fieldIdMap` means logical addressing and every id passes through; a map with
 * bindings is the explicit mode, where an absent id is a HOLE). That is the coupling that matters:
 * if the export can read this project's rows, these two scans can too, and none of the three can
 * drift onto a different sheet or a different scoping column from the others.
 *
 * An explicit map that does not bind a SCOPE column is a broken config: the export refuses it
 * outright (PREP_LINE_EXPORT_FIELD_IDS_UNRESOLVED) rather than scoping by guesswork, and a count
 * that cannot scope is worth exactly as little. Null — the caller reports "not ready".
 *
 * `lastPlmRefreshAt` is OPTIONAL, unlike the two SCOPE columns: it never gates readiness. An
 * explicit map that simply does not bind it leaves `bindings.lastPlmRefreshAt` undefined, and the
 * timestamp degrades to null exactly like an unprovisioned fill table degrades `fillTarget` to null.
 */
function resolvePullTargetBindings(boundTarget) {
  try {
    const target = EXPORT_INTERNALS.normalizeExportTarget(boundTarget)
    const explicit = EXPORT_INTERNALS.fieldIdMapHasExplicitBindings(target.fieldIdMap)
    const bindings = {}
    for (const fieldId of REQUIRED_EXPORT_FIELD_IDS) {
      const physical = target.fieldIdMap[fieldId]
      if (physical) bindings[fieldId] = physical
      else if (!explicit) bindings[fieldId] = fieldId
      else return null
    }
    const lastPlmRefreshPhysical = target.fieldIdMap.lastPlmRefreshAt
    if (lastPlmRefreshPhysical) bindings.lastPlmRefreshAt = lastPlmRefreshPhysical
    else if (!explicit) bindings.lastPlmRefreshAt = 'lastPlmRefreshAt'
    return bindings
  } catch {
    return null
  }
}

function rowData(row) {
  return row && typeof row === 'object' && row.data && typeof row.data === 'object' ? row.data : (row || {})
}

/**
 * THE SCAN. Pages the caller's OWN bound sheet and accumulates, per project number AND in aggregate,
 * the row count, the active row count and the max `lastPlmRefreshAt` seen.
 *
 * @param {string|null} projectNo  when set, the scan is FILTERED to that project (the board's read);
 *                                 when null, the whole sheet is walked and grouped (the directory's).
 *
 * @returns {Promise<{ready:boolean, bounded:boolean, byProjectNo:Map, rowCount:number,
 *                    activeRowCount:number, lastChangedFromPlmAtMs:number|null}>}
 *
 * IT DEGRADES, NEVER FAILS. A target that is not bound, not the caller's own, not provisioned, does
 * not bind the two scope columns, or whose query throws yields `ready:false` and the page says the
 * table is not ready — the same posture the fill handle already takes. A status bar (or a home page)
 * that 500s because a deployment has not finished configuring itself is a worse one.
 *
 * `bounded` IS THE HONESTY FLAG AND IT IS LOAD-BEARING. Past `PULL_TARGET_MAX_PAGES` the counts are
 * a floor rather than a total, the set of project numbers is a SUBSET rather than the distinct set,
 * and — the case that actually misleads — the max is computed over a PREFIX of an UNORDERED page
 * scan, so rows past the bound may carry a NEWER `lastPlmRefreshAt` than anything seen. Callers must
 * report `lastChangedFromPlmAt: null` when `bounded` is true rather than a number that could quietly
 * understate freshness; that is the "cron ran fine, the page just says it looks stale" failure this
 * whole flag exists to head off.
 */
async function scanPullTargetProjects(recordsApi, ownSheet, boundTarget, projectNo = null) {
  const notReady = {
    ready: false,
    bounded: false,
    byProjectNo: new Map(),
    rowCount: 0,
    activeRowCount: 0,
    lastChangedFromPlmAtMs: null,
  }
  if (!ownSheet) return notReady
  if (!recordsApi || typeof recordsApi.queryRecords !== 'function') return notReady

  const bindings = resolvePullTargetBindings(boundTarget)
  if (!bindings) return notReady

  const narrowTo = optionalString(projectNo)
  const byProjectNo = new Map()
  let rowCount = 0
  let activeRowCount = 0
  let lastChangedFromPlmAtMs = null
  let bounded = true

  try {
    for (let page = 0; page < PULL_TARGET_MAX_PAGES; page += 1) {
      const pageRows = await recordsApi.queryRecords({
        sheetId: ownSheet.sheetId,
        // The unnarrowed scan passes NO filter: "which project numbers are in this sheet at all" is
        // exactly the question that cannot be asked one project at a time, because the set of
        // projects is what is being discovered.
        filters: narrowTo === null ? {} : { [bindings.projectNo]: narrowTo },
        limit: PULL_TARGET_PAGE_LIMIT,
        offset: page * PULL_TARGET_PAGE_LIMIT,
      })
      if (!Array.isArray(pageRows)) return notReady
      for (const row of pageRows) {
        const data = rowData(row)
        rowCount += 1
        const active = data[bindings.active] !== false
        if (active) activeRowCount += 1
        let ms = null
        if (bindings.lastPlmRefreshAt) {
          ms = parsePlmRefreshTimestampMs(data[bindings.lastPlmRefreshAt])
          if (ms !== null && (lastChangedFromPlmAtMs === null || ms > lastChangedFromPlmAtMs)) {
            lastChangedFromPlmAtMs = ms
          }
        }
        // GROUPING IS BY THE ROW'S OWN project number. A row whose scope cell is blank cannot be a
        // directory entry — there is no number to navigate to — so it does not open a group, but it
        // is still COUNTED in the aggregate above, because it really is a row in this sheet.
        const rowProjectNo = optionalString(data[bindings.projectNo])
        if (rowProjectNo === null) continue
        let group = byProjectNo.get(rowProjectNo)
        if (!group) {
          group = { rowCount: 0, activeRowCount: 0, lastChangedFromPlmAtMs: null }
          byProjectNo.set(rowProjectNo, group)
        }
        group.rowCount += 1
        if (active) group.activeRowCount += 1
        if (ms !== null && (group.lastChangedFromPlmAtMs === null || ms > group.lastChangedFromPlmAtMs)) {
          group.lastChangedFromPlmAtMs = ms
        }
      }
      if (pageRows.length < PULL_TARGET_PAGE_LIMIT) {
        bounded = false
        break
      }
    }
  } catch {
    return notReady
  }

  return { ready: true, bounded, byProjectNo, rowCount, activeRowCount, lastChangedFromPlmAtMs }
}

/**
 * HOW MANY ROWS DID THE PULL ACTUALLY PUT THERE — counted in the bound table-action target, for ONE
 * project. The board's projection over `scanPullTargetProjects`.
 *
 * WHY THIS EXISTS. Every other number on the board comes from the MVP snapshot tables, which are
 * written by `mvp-persist` — platform-admin, and deliberately left there by the operator pull split.
 * So on the flow that page exists for, a floor operator importing hundreds of rows saw a status bar
 * that still read 「还没从 PLM 拉过这个项目」. The rows were in the sheet the whole time; nothing was
 * reading them.
 *
 * The bounded case reports `lastChangedFromPlmAt: null` — an honest "cannot say" — and
 * `lastChangedFromPlmBounded: true` is the flag a caller reads instead. See `scanPullTargetProjects`.
 */
async function readPullTargetRowFacts(recordsApi, ownSheet, boundTarget, projectNo) {
  const scan = await scanPullTargetProjects(recordsApi, ownSheet, boundTarget, projectNo)
  if (!scan.ready) return PULL_TARGET_NOT_READY
  return {
    ready: true,
    rowCount: scan.rowCount,
    activeRowCount: scan.activeRowCount,
    bounded: scan.bounded,
    lastChangedFromPlmAt: scan.bounded || scan.lastChangedFromPlmAtMs === null
      ? null
      : new Date(scan.lastChangedFromPlmAtMs).toISOString(),
    lastChangedFromPlmBounded: scan.bounded,
  }
}

module.exports = {
  PULL_TARGET_MAX_PAGES,
  PULL_TARGET_NOT_READY,
  PULL_TARGET_PAGE_LIMIT,
  STOCK_PREPARATION_FILL_OBJECT_ID,
  parsePlmRefreshTimestampMs,
  readPullTargetRowFacts,
  resolveOwnBoundSheet,
  resolvePullTargetBindings,
  scanPullTargetProjects,
}
