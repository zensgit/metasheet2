'use strict'

// 项目备料页 — ONE PROJECT'S BOARD. The read behind the operator's single page.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
//
// Every PART of the operator's flow already shipped — the directory (#5445), the pull (#5435), the
// export (#5437), the confirmation queue — and no page strung them together. A floor operator
// arriving at 07:00 with a project number in their hand had to know which tab held which half of
// their own job. This module answers the one question that page opens on:
//
//     「这个项目现在到哪一步了,我下一步该点什么?」
//
// for exactly ONE project of the caller's OWN tenant.
//
// ---------------------------------------------------------------------------
// IT IS THE FOURTH VALUE-BEARING READ, SO IT JOINS THE LIST RATHER THAN INVENTING A FOURTH WAY
// ---------------------------------------------------------------------------
//
// stock-preparation-operator-scope.cjs's header names the complete set of value-bearing stock-prep
// reads and says, in as many words: "A FOURTH value-bearing read must join this list, not invent a
// fourth way to decide tenancy." This is that fourth read — it carries `projectNo` and
// `projectName` — and it obeys the instruction literally: the ROUTE derives its tenant through
// `resolveOperatorValueScope` (never `resolveTenantId`), and this module refuses outright if it is
// handed anything else.
//
// The three gates the H0 plane-boundary lock requires of a value-bearing read (三重门,缺一不可) are
// all present, split the same way the directory route splits them:
//   1. RBAC          — the route's `requireAccess(req, STOCK_PREP_OPERATE)`.
//   2. FIELD WHITELIST — `STOCK_PREPARATION_PROJECT_BOARD_KEYS` below, built key by key. The
//      directory row is NEVER spread into the response; each field is copied by name.
//   3. AUDIT         — appended by the route BEFORE the values are sent, values-free.
//
// ---------------------------------------------------------------------------
// WHERE THE NUMBERS COME FROM: reuse, not a second pipeline
// ---------------------------------------------------------------------------
//
// The batch count, the last sync run, the archived held/ready counts and the pending-decision count
// all come from `listOperatorProjectDirectory` — the SAME function the directory route answers with,
// called with the SAME scope and NARROWED to this one project. That is deliberate and it is the
// load-bearing reuse decision in this file:
//
//   * the tenant confinement is one implementation, not two that could drift apart (the directory
//     module refuses a staging project outside the scope's tenant, and every count is computed from
//     sheets under that project);
//   * the board and the directory can never disagree about the same project, which is what would
//     happen if this file re-derived counts from the same sheets with its own filters; and
//   * a cross-tenant projectNo is not a special case here at all — it is simply not in the caller's
//     own directory, so it takes the identical "no such project" path an unknown number takes. The
//     404 is therefore the SAME 404 by construction rather than by two branches agreeing to look
//     alike, which is what stops this route being an existence oracle across tenants.
//
// THE COST IS ONE PROJECT'S, NOT THE TENANT'S. The first cut listed the whole directory and then
// `.find()`-ed in it — 3 record queries per project in the tenant, and a hard 422 above
// MAX_LIST_ROWS that would have taken the board down for EVERY project on a tenant that grew past
// the bound. The narrowing is a parameter on the shared function rather than a second module, so the
// reuse above is unchanged and the read is now a filtered project-sheet query plus that project's
// own counts.
//
// ---------------------------------------------------------------------------
// TWO FAMILIES OF NUMBERS, AND WHICH ONE ANSWERS 「拉过了吗?」
// ---------------------------------------------------------------------------
//
// The counts above describe the MVP SNAPSHOT tables (project / bom_snapshot_batch /
// exception_confirmation / stock_preparation_line). Those are written by `mvp-persist`, which is
// platform-admin and flag-gated — so on the flow this page exists to serve, where a floor operator
// runs the pull themselves, every one of them stays ZERO and `lastSyncRunId` stays null no matter how
// many rows the pull just wrote. A status bar that answered 「还没从 PLM 拉过这个项目」 immediately
// after a successful import is the one answer that cannot be right.
//
// So the board carries a SECOND family, read from the sheet the pull actually writes — the bound
// table action's own `target`, the same object the export reads through (see `readBoundSheetRows`).
// `pulledRowCount` / `activePulledRowCount` / `pullTargetReady` are the operator's facts; the
// snapshot numbers stay, clearly named as the administrator's archived snapshot, because the diff
// view is built on them and they are the right answer to a different question.
//
// ---------------------------------------------------------------------------
// THE DEEP-LINK HANDLE, AND THE CLAIM IT DOES NOT MAKE
// ---------------------------------------------------------------------------
//
// `fillTarget` is a HANDLE — `{ sheetId, viewId }` — for the 备料主表, the sheet the operator
// actually fills 采购回复 / 仓库确认 into. It is NOT a permission decision and must never be read as
// one. This plugin has no user-aware multitable ACL seam: every read here runs on the service-account
// records API with the plugin's own authority, and the multitable ACL domain is deliberately separate
// from `integration:*` / `stock-prep:*`. So the plugin CANNOT pre-check whether this operator may
// open that sheet, and does not pretend to. Multitable enforces access when the operator lands.
//
// Two things make the handle honest anyway:
//   * it is present ONLY when `findObjectSheet` says the sheet EXISTS. A `{sheetId}` composed from
//     the deterministic hash alone would be a link to nothing on a deployment that never installed
//     the table, and "the button did nothing" is worse than "the button is not there".
//   * `viewId` is the id the plugin's own default-view provisioning uses. If a deployment's table
//     carries hand-made views instead, the workbench falls back to the sheet's first view
//     (useMultitableWorkbench's `preferredViewId` fold), so the handle degrades to "open this sheet"
//     rather than breaking.
//
// ---------------------------------------------------------------------------
// WHAT THIS MODULE DOES NOT DO
// ---------------------------------------------------------------------------
//
//   * It returns NO ROW VALUES — no materials array, no prep lines, no decision payloads. Filling
//     stays in the multitable grid; this is a status bar, not a second grid. The key set is frozen
//     and asserted literally by the suite.
//   * It performs NO WRITE and holds no capability toward one.
//   * It decides nothing about the handoff cursor. The 通知下一步 contract is a parallel slice; the
//     page reads it directly from its own route and hides the control when it is not configured.

const {
  listOperatorProjectDirectory,
  StockPreparationOperatorDirectoryError,
} = require('./stock-preparation-operator-project-directory.cjs')
const { optionalString } = require('./stock-preparation-common.cjs')
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require('./stock-preparation-templates.cjs')
const {
  REQUIRED_EXPORT_FIELD_IDS,
  __internals: EXPORT_INTERNALS,
} = require('./stock-preparation-prep-line-export.cjs')

/** The sheet the operator FILLS. Frozen here so the handle can never point at a different table. */
const STOCK_PREPARATION_FILL_OBJECT_ID = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId

/**
 * The logical view id the plugin's own default-view provisioning creates
 * (`ensureManagedTableDefaultView` -> host `ensureObjectDefaultView` -> `DEFAULT_OBJECT_VIEW_LOGICAL_ID`).
 * Kept as a constant rather than inlined so the two stay greppable together.
 */
const STOCK_PREPARATION_FILL_VIEW_LOGICAL_ID = 'default'

/**
 * THE FROZEN PROJECTION. A key is added here deliberately or not at all — the response object below
 * is built key by key against this list and the suite asserts the two are set-equal, so a future
 * `...row` spread cannot quietly put a customer row value on this surface.
 */
const STOCK_PREPARATION_PROJECT_BOARD_KEYS = Object.freeze([
  'tenantId',
  'projectId',
  'projectNo',
  'projectName',
  'projectStatus',
  // ── THE ARCHIVE. Written by `mvp-persist`, which is platform-admin: on an operator's own run these
  //    are all zero/null, and `archivedSnapshotPresent` is how a reader knows that is what they mean.
  'lastSyncRunId',
  'snapshotBatchCount',
  'openExceptionCount',
  'heldLineCount',
  'readyLineCount',
  'archivedSnapshotPresent',
  // ── THE PULL. Counted in the bound table-action target — the sheet `apply` writes and the export
  //    reads. This is the operator's own evidence, and the only family that answers 「拉过了吗?」.
  'pullTargetReady',
  'pulledRowCount',
  'activePulledRowCount',
  'pulledRowCountBounded',
  // The max `lastPlmRefreshAt` seen across this project's rows in the SAME scan that produces the
  // counts above — no second read, no new write. NAMED `lastChangedFromPlmAt`, deliberately NOT
  // `lastChangedFromPlmAt` / 「上次同步」: `lastPlmRefreshAt` is written ONLY by `runPatch`
  // (stock-preparation-conflict-planner.cjs), which rides along an add/update/inactive DECISION
  // (`makeAddDecision` / `makeUpdateDecision` / `makeInactiveDecision`). `makeSkipDecision` — the
  // decision an UNCHANGED row gets on every ordinary re-pull — calls no `runPatch` at all, so a run
  // that finds nothing new leaves this stamp exactly where the LAST run that changed something left
  // it. A project whose BOM has been stable for a week, pulled successfully every single day since,
  // shows a week-old timestamp here. That is why the exposed name and the frontend label both say
  // "最近变更 / last CHANGE", never "最近同步 / last SYNC" — the true "when did we last pull, even if
  // nothing changed" answer needs a dedicated audit action this PR does not add (owner decision).
  // NULL when the bound target does not bind `lastPlmRefreshAt` (an OPTIONAL column, unlike the two
  // SCOPE fields), has no rows yet, OR the scan hit `PULL_TARGET_MAX_PAGES` (see
  // `lastChangedFromPlmBounded`) — never a thrown error.
  'lastChangedFromPlmAt',
  // TRUE exactly when `lastChangedFromPlmAt` is a max over a TRUNCATED subset rather than the whole
  // project — the same `PULL_TARGET_MAX_PAGES` bound `pulledRowCountBounded` already reports for the
  // row counts. A max computed over a prefix of an UNORDERED page scan is not a floor the way a
  // truncated COUNT is: rows past the bound could easily carry a NEWER `lastPlmRefreshAt` than
  // anything seen, so reporting the partial max as `lastChangedFromPlmAt` would silently understate
  // how fresh the data is — the exact "cron ran fine, page just says it looks stale" failure this
  // field exists to prevent. So the bounded case reports `lastChangedFromPlmAt: null` INSTEAD of a
  // number that could quietly be wrong, and this flag is how a reader tells "we don't know" apart
  // from "no row has ever changed".
  'lastChangedFromPlmBounded',
  'pendingDecisionCount',
  'lastExportAt',
  'fillTarget',
  'directoryReady',
  'ledgerReady',
])

/**
 * The closed `mode` set for the audit row. Two values, and the miss is one of them: a board read that
 * found nothing still HAPPENED, and the trail records that it did without recording what was asked
 * for. Both are enum tokens, so neither can smuggle a business value past the store's structural gate.
 */
const STOCK_PREPARATION_PROJECT_BOARD_MODES = Object.freeze([
  'operator_project_board',
  'operator_project_board_miss',
])

const STOCK_PREPARATION_PROJECT_BOARD_AUDIT_ACTION = 'project_board_read'

class StockPreparationProjectBoardError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationProjectBoardError'
    this.status = status
    this.code = code
    this.details = details
  }
}

/**
 * THE ONE REFUSAL THIS MODULE RAISES, and it is deliberately shapeless.
 *
 * No `details`, no projectNo echo, no hint about which of the two reasons applied. "This project
 * number is not one of yours" and "this project number is nobody's" must be the same sentence, or a
 * tenant-A operator could enumerate tenant B's project numbers by watching the refusals differ.
 */
function notFound() {
  return new StockPreparationProjectBoardError(
    404,
    'STOCK_PREPARATION_PROJECT_BOARD_NOT_FOUND',
    'no such project in this tenant',
  )
}

/**
 * The last time THIS project's materials workbook left the system, from the values-free audit trail.
 *
 * DEGRADES, never fails: an audit store without `list` (or one that throws) yields `null` and the
 * board still answers. The timestamp is a convenience on a status bar — a page that 500s because a
 * convenience is unavailable is a worse page.
 *
 * NOTE the `projectId` filter: the export route stamps the projectNo into the audit row's
 * `project_id` (it is that route's subject), which is what makes a per-project lookup possible here.
 * This module writes nothing there — see the route's own audit call, which keeps project_id NULL.
 *
 * NO WORKSPACE FILTER, deliberately. The board route no longer accepts the caller's `?workspaceId`
 * as a selector at all (it was the one reachable way to put a business value on the audit trail —
 * see the route's allowlist comment), so there is nothing here to narrow by; "the last time THIS
 * tenant exported THIS project" is the question the status bar asks, and it is the right one.
 */
async function lastExportAtFor(audit, { tenantId, projectNo }) {
  if (!audit || typeof audit.list !== 'function') return null
  try {
    const result = await audit.list({
      tenantId,
      projectId: projectNo,
      action: 'prep_line_export',
      limit: 1,
    })
    const entries = result && Array.isArray(result.entries) ? result.entries : []
    const first = entries[0]
    if (!first || !first.createdAt) return null
    const createdAt = first.createdAt
    return createdAt instanceof Date ? createdAt.toISOString() : String(createdAt)
  } catch {
    return null
  }
}

/**
 * The deep-link handle, or null. See the header for the claim it does NOT make.
 *
 * IT IS BUILT FROM THE BOUND TABLE-ACTION TARGET, not from the canonical object id, because the
 * bound target is the sheet `apply` actually writes to — and on a deployment whose production gate is
 * closed that is the sandbox twin, not the canonical table. A link composed from the canonical id
 * would open an empty sheet and tell the operator their pull did nothing.
 *
 * AND IT IS TENANT-GUARDED, which is the load-bearing half. `action.target` is DEPLOY-TIME
 * configuration shared by every tenant on the deployment (see the export route's own note on this),
 * so the sheet id it names is NOT derived from the caller's tenant. Handing it out unchecked would be
 * this route's one reachable way to name a sheet outside the caller's own staging project. So it is
 * only ever handed out when it EQUALS the id the CALLER'S OWN provisioning would compute for that
 * object — which is also precisely the case in which the matching default view id is derivable at
 * all. Anything else yields null, and the page says the table is not ready rather than linking into
 * the dark.
 *
 * `findObjectSheet` is then the EXISTENCE proof and the only IO here. `getObjectSheetId` /
 * `getObjectViewId` are pure deterministic id derivations on the host side, treated as OPTIONAL
 * capabilities so a plugin newer than its host degrades to "no handle" rather than erroring.
 */
/**
 * THE TENANT GATE ON THE BOUND TARGET, factored out because TWO things ride it — the fill handle and
 * the pull-target row counts — and they must never be able to disagree about whether the bound sheet
 * is the caller's own.
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

async function resolveFillTarget(provisioning, ownSheet, stagingProjectId) {
  if (!ownSheet) return null
  if (typeof provisioning.getObjectViewId !== 'function') return null
  const viewId = provisioning.getObjectViewId(stagingProjectId, ownSheet.objectId, STOCK_PREPARATION_FILL_VIEW_LOGICAL_ID)
  if (typeof viewId !== 'string' || viewId.length === 0) return null
  return { sheetId: ownSheet.sheetId, viewId }
}

/** Paging bounds for the pull-target count. The same shape the export uses, from the same module. */
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
 * Best-effort timestamp parse for a `lastPlmRefreshAt` cell. The planner writes an ISO string
 * (`normalizeIsoTime`), but a row is somebody else's data by the time this reads it back, so this
 * accepts a `Date` too and rejects everything else — never throws, since one unparsable cell must not
 * cost the whole board its `lastChangedFromPlmAt`, only that cell's vote toward the max.
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
 * HOW MANY ROWS DID THE PULL ACTUALLY PUT THERE — counted in the bound table-action target.
 *
 * WHY THIS EXISTS. Every other number on this board comes from the MVP snapshot tables, which are
 * written by `mvp-persist` — platform-admin, and deliberately left there by the operator pull split.
 * So on the flow this page exists for, a floor operator importing hundreds of rows saw a status bar
 * that still read 「还没从 PLM 拉过这个项目」. The rows were in the sheet the whole time; nothing was
 * reading them.
 *
 * IT READS THE SAME OBJECT THE EXPORT READS, through the export module's own target normalization and
 * its own two-mode field-binding rule (an EMPTY `fieldIdMap` means logical addressing and every id
 * passes through; a map with bindings is the explicit mode, where an absent id is a HOLE). That is
 * the coupling that matters: if the export can read this project's rows, the board can count them,
 * and neither can drift onto a different sheet or a different scoping column from the other.
 *
 * IT DEGRADES, NEVER FAILS. A target that is not bound, not the caller's own, not provisioned, or
 * does not bind the two scope columns yields `ready:false` and the page says the table is not ready —
 * the same posture the fill handle already takes. A status bar that 500s because a deployment has not
 * finished configuring itself is a worse status bar.
 *
 * THE TENANT GATE IS THE CALLER'S ALREADY-RESOLVED OWN SHEET (see `resolveOwnBoundSheet`), never
 * `action.target` unchecked. `action.target` is DEPLOY-TIME configuration shared by every tenant on
 * the deployment, so its sheet id is NOT derived from the caller's tenant; handing it to a records
 * query unchecked would be this route's one reachable way to count rows outside the caller's own
 * staging project — and, because the count feeds the existence decision below, to answer a question
 * about another tenant's project number. Gated, it cannot.
 */
async function readPullTargetRowFacts(recordsApi, ownSheet, boundTarget, projectNo) {
  if (!ownSheet) return PULL_TARGET_NOT_READY
  if (!recordsApi || typeof recordsApi.queryRecords !== 'function') return PULL_TARGET_NOT_READY

  let bindings
  try {
    const target = EXPORT_INTERNALS.normalizeExportTarget(boundTarget)
    const explicit = EXPORT_INTERNALS.fieldIdMapHasExplicitBindings(target.fieldIdMap)
    bindings = {}
    for (const fieldId of REQUIRED_EXPORT_FIELD_IDS) {
      const physical = target.fieldIdMap[fieldId]
      if (physical) bindings[fieldId] = physical
      else if (!explicit) bindings[fieldId] = fieldId
      // An explicit map that does not bind a SCOPE column is a broken config: the export refuses it
      // outright (PREP_LINE_EXPORT_FIELD_IDS_UNRESOLVED) rather than scoping by guesswork, and a
      // count that cannot scope is worth exactly as little. Not ready.
      else return PULL_TARGET_NOT_READY
    }
    // `lastPlmRefreshAt` is OPTIONAL, unlike the two SCOPE columns above: it never gates readiness.
    // An explicit map that simply does not bind it leaves `bindings.lastPlmRefreshAt` undefined —
    // `lastChangedFromPlmAt` degrades to null below, exactly like an unprovisioned fill table degrades
    // `fillTarget` to null, never PULL_TARGET_NOT_READY.
    const lastPlmRefreshPhysical = target.fieldIdMap.lastPlmRefreshAt
    if (lastPlmRefreshPhysical) bindings.lastPlmRefreshAt = lastPlmRefreshPhysical
    else if (!explicit) bindings.lastPlmRefreshAt = 'lastPlmRefreshAt'
  } catch {
    return PULL_TARGET_NOT_READY
  }

  let rowCount = 0
  let activeRowCount = 0
  let lastChangedFromPlmAtMs = null
  try {
    for (let page = 0; page < PULL_TARGET_MAX_PAGES; page += 1) {
      const pageRows = await recordsApi.queryRecords({
        sheetId: ownSheet.sheetId,
        filters: { [bindings.projectNo]: projectNo },
        limit: PULL_TARGET_PAGE_LIMIT,
        offset: page * PULL_TARGET_PAGE_LIMIT,
      })
      if (!Array.isArray(pageRows)) return PULL_TARGET_NOT_READY
      for (const row of pageRows) {
        rowCount += 1
        const data = row && typeof row === 'object' && row.data && typeof row.data === 'object' ? row.data : (row || {})
        if (data[bindings.active] !== false) activeRowCount += 1
        if (bindings.lastPlmRefreshAt) {
          const ms = parsePlmRefreshTimestampMs(data[bindings.lastPlmRefreshAt])
          if (ms !== null && (lastChangedFromPlmAtMs === null || ms > lastChangedFromPlmAtMs)) lastChangedFromPlmAtMs = ms
        }
      }
      if (pageRows.length < PULL_TARGET_PAGE_LIMIT) {
        return {
          ready: true,
          rowCount,
          activeRowCount,
          bounded: false,
          lastChangedFromPlmAt: lastChangedFromPlmAtMs === null ? null : new Date(lastChangedFromPlmAtMs).toISOString(),
          lastChangedFromPlmBounded: false,
        }
      }
    }
  } catch {
    return PULL_TARGET_NOT_READY
  }
  // Past the scan bound. The row COUNTS so far are a floor, not a total, and `bounded` says so rather
  // than letting a truncated count read as an exact one — that caveat is fine for a count, which can
  // only be an undercount.
  //
  // A MAX is different, and unsafe to report the same way: this loop walks pages in whatever order
  // the records API returns them, not ordered by `lastPlmRefreshAt`, so the rows past the bound are
  // NOT necessarily older than the ones already seen — one of them could easily carry the actual
  // latest refresh. Reporting `lastChangedFromPlmAtMs` here would silently UNDERSTATE freshness with no way
  // for a reader to tell "this project's data really is old" apart from "the scan gave up before
  // finding the recent row" — precisely the "cron is fine, the page just looks stale" failure this
  // field exists to head off. So the bounded case reports `lastChangedFromPlmAt: null` — an honest "cannot
  // say" — and `lastChangedFromPlmBounded: true` is the flag a caller reads instead.
  return {
    ready: true,
    rowCount,
    activeRowCount,
    bounded: true,
    lastChangedFromPlmAt: null,
    lastChangedFromPlmBounded: true,
  }
}

/**
 * READ ONE PROJECT'S BOARD, or refuse with the shapeless 404.
 *
 * @param {object} params
 * @param {object} params.recordsApi        the service-account records API
 * @param {object} params.provisioning      the plugin-scoped multitable provisioning surface
 * @param {string} params.targetProjectId   the caller's OWN staging project (derived from the scope)
 * @param {object} params.scope             the resolved operator value scope — required, not optional
 * @param {string} params.projectNo         the project number asked for
 * @param {object} [params.boundTarget]     the bound table-action target (`action.target`), or null
 *                                          when nothing is bound — see `resolveFillTarget`
 * @param {object} [params.audit]           the audit store, for the values-free last-export lookup
 *
 * @returns {Promise<{ board: object, mode: string, projectCount: number }>}
 *          `mode` is the audit mode the ROUTE records; `projectCount` is the values-free size of the
 *          directory this read walked. Neither is part of the board projection.
 */
async function readOperatorProjectBoard({
  recordsApi,
  provisioning,
  targetProjectId,
  scope,
  projectNo,
  boundTarget,
  audit,
} = {}) {
  if (!scope || !optionalString(scope.tenantId)) {
    throw new StockPreparationProjectBoardError(
      500,
      'PROJECT_BOARD_SCOPE_REQUIRED',
      'the project board requires a resolved operator value scope',
    )
  }
  const wanted = optionalString(projectNo)
  if (!wanted) {
    throw new StockPreparationProjectBoardError(
      400,
      'STOCK_PREPARATION_PROJECT_BOARD_REQUEST_INVALID',
      'projectNo is required',
      { field: 'projectNo' },
    )
  }

  // The SAME read the directory route answers with, under the SAME scope, NARROWED to the one
  // project this board is about. A project belonging to another tenant is simply absent from it,
  // which is why the two 404s below cannot differ — the narrowing filters within the caller's own
  // already-verified staging project, so it can only ever return a subset of the unnarrowed read.
  const directory = await listOperatorProjectDirectory({
    recordsApi,
    provisioning,
    targetProjectId,
    scope,
    projectNo: wanted,
    // The board projects its own frozen key set, so it may consume the pending INDEX in process; the
    // directory route, whose response shape is frozen and asserted, does not ask for it.
    includePendingIndex: true,
  })

  const match = directory.projects.find((project) => optionalString(project.projectNo) === wanted) || null

  // THE PULL TARGET, resolved through the caller's OWN-sheet gate and counted for this project.
  // Both the fill handle and these counts hang off the one gate, so they cannot disagree.
  const ownSheet = await resolveOwnBoundSheet(provisioning, targetProjectId, boundTarget)
  const pullTarget = await readPullTargetRowFacts(recordsApi, ownSheet, boundTarget, wanted)

  // ---------------------------------------------------------------------------
  // EXISTENCE: EITHER STORE — AND THE TENANT MODEL THAT MAKES THAT SOUND
  // ---------------------------------------------------------------------------
  //
  // "Is this project one of yours?" has two admissible answers, because the two stores are written
  // by two different tiers and the operator can only reach one of them:
  //
  //   * the ARCHIVE (`match`) — the MVP project ledger under the caller's own staging project,
  //     written by `mvp-persist`, which stayed platform-admin; and
  //   * the PULL TARGET (`pullTarget.rowCount > 0`) — the rows `apply` wrote, which is the ONLY
  //     store an operator's own four-step run touches.
  //
  // Without the second, a project a floor operator pulled themselves was NOT FOUND forever: the page
  // built for them could not show them the work they had just done.
  //
  // ---------------------------------------------------------------------------
  // THE TENANT MODEL, STATED PLAINLY — because an earlier version of this comment overclaimed
  // ---------------------------------------------------------------------------
  //
  // THE FACTS, none of which this PR invented:
  //   * `action.target` is DEPLOY-TIME configuration. There is one list, shared by every tenant on
  //     the deployment; the sheet it names is not derived from anybody's tenant.
  //   * `plm_stock_preparation_main` has NO tenant column. The only row-level scope inside it is
  //     `projectNo`.
  // The export route has said exactly this in its own header since it shipped; this comment now says
  // it too, in the same words, instead of implying a stronger boundary than the data model has.
  //
  // WHAT THAT MAKES TRUE, AND IT IS ENOUGH:
  //   * the bound sheet is owned by exactly ONE project, and `resolveOwnBoundSheet` proves the
  //     caller's own staging project is that one — by the provisioning registry, or by the
  //     deterministic id. A caller who is NOT the owner never reads that sheet at all, so for them
  //     the pull-target disjunct cannot fire and every projectNo answers the identical, detail-free
  //     404 an unknown number gets. That much is a real boundary and B-02 pins it.
  //   * for the ONE tenant who DOES own the sheet, every projectNo in it is theirs BY DEFINITION.
  //     There is no "another tenant's projectNo" inside a single-tenant sheet — the sheet has one
  //     owner, and rows only arrive in it through an `apply` that owner ran.
  //
  // WHAT THIS DOES NOT CLAIM. It does not claim that a deployment which points several tenants at one
  // shared target keeps their rows apart: it cannot, because the table has no tenant column, and the
  // export route has the same property for the same reason. On such a deployment the owning tenant
  // reads the whole sheet — which is what "owning" means here. Making the target per-tenant is a
  // change to the table-action model that both routes need, and it is not this PR.
  //
  // The suite pins BOTH halves: two projectNos in the owner's own bound sheet are both readable, and
  // a non-owning tenant gets the identical 404 for a projectNo even when rows for it exist in that
  // sheet (B-13).
  if (!match && pullTarget.rowCount === 0) {
    // Reported so the ROUTE can audit that a miss happened, then rethrown. The refusal itself stays
    // shapeless — the caller learns nothing beyond "not one of yours".
    const error = notFound()
    error.auditMode = STOCK_PREPARATION_PROJECT_BOARD_MODES[1]
    error.projectCount = directory.projectCount
    error.pullTargetReady = pullTarget.ready
    throw error
  }

  const fillTarget = await resolveFillTarget(provisioning, ownSheet, targetProjectId)
  const lastExportAt = await lastExportAtFor(audit, {
    tenantId: scope.tenantId,
    projectNo: wanted,
  })

  // BUILT KEY BY KEY. `match` is never spread — see STOCK_PREPARATION_PROJECT_BOARD_KEYS.
  //
  // When there is no archive row, the archive fields are null/zero and `archivedSnapshotPresent` is
  // false — NOT because "nothing was pulled", but because nobody has archived it. Those are different
  // facts and the projection keeps them apart; conflating them is precisely what made a successful
  // import read as 「还没拉过」. `projectNo` is the caller's own input echoed back (it is theirs), and
  // `projectName` stays null rather than inventing one from a sheet that does not carry it.
  const board = {
    tenantId: scope.tenantId,
    projectId: match ? match.projectId : null,
    projectNo: match ? match.projectNo : wanted,
    projectName: match ? match.projectName : null,
    // NULL, not a placeholder enum: there is no archive row, so this project HAS no stored status.
    // ('unknown' would also be a literal outside the seeded stock_preparation_project_status_v1
    // vocabulary — the option-catalog guard is right that such a value has no fate on a real
    // deployment, and inventing one here would be exactly the placeholder the directory module
    // refuses to emit for projectNo/projectName.)
    projectStatus: match ? match.projectStatus : null,
    lastSyncRunId: match ? match.lastSyncRunId : null,
    snapshotBatchCount: match ? match.snapshotBatchCount : 0,
    openExceptionCount: match ? match.openExceptionCount : 0,
    heldLineCount: match ? match.heldLineCount : 0,
    readyLineCount: match ? match.readyLineCount : 0,
    archivedSnapshotPresent: match !== null,
    pullTargetReady: pullTarget.ready,
    pulledRowCount: pullTarget.rowCount,
    activePulledRowCount: pullTarget.activeRowCount,
    pulledRowCountBounded: pullTarget.bounded,
    lastChangedFromPlmAt: pullTarget.lastChangedFromPlmAt,
    lastChangedFromPlmBounded: pullTarget.lastChangedFromPlmBounded === true,
    // KEYED BY THE BUSINESS NUMBER, so it survives an absent archive row. Reading this off the
    // archive row made the board answer 「没有要您拿主意的事」 for precisely the flow this page
    // exists for — an operator's own pull, which queues decisions but writes no MVP project row —
    // while `ledgerReady: true` asserted the ledger had been consulted and was healthy. The map is
    // keyed by projectNo, which the ledger itself is keyed by, so it needs no archive at all.
    pendingDecisionCount: (directory.pendingByProjectNo instanceof Map
      ? directory.pendingByProjectNo.get(wanted)
      : undefined) ?? 0,
    lastExportAt,
    fillTarget,
    directoryReady: directory.directoryReady,
    ledgerReady: directory.ledgerReady,
  }

  return {
    board,
    mode: STOCK_PREPARATION_PROJECT_BOARD_MODES[0],
    projectCount: directory.projectCount,
  }
}

module.exports = {
  STOCK_PREPARATION_FILL_OBJECT_ID,
  STOCK_PREPARATION_FILL_VIEW_LOGICAL_ID,
  STOCK_PREPARATION_PROJECT_BOARD_AUDIT_ACTION,
  STOCK_PREPARATION_PROJECT_BOARD_KEYS,
  STOCK_PREPARATION_PROJECT_BOARD_MODES,
  StockPreparationOperatorDirectoryError,
  StockPreparationProjectBoardError,
  readOperatorProjectBoard,
  __internals: {
    lastExportAtFor,
    notFound,
    parsePlmRefreshTimestampMs,
    readPullTargetRowFacts,
    resolveFillTarget,
    resolveOwnBoundSheet,
  },
}
