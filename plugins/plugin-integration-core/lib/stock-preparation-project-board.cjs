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
// The batch count, the last sync run, the held/ready counts and the pending-decision count all come
// from `listOperatorProjectDirectory` — the SAME function the directory route answers with, called
// with the SAME scope. That is deliberate and it is the load-bearing reuse decision in this file:
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
// The cost is honest and stated: one board read walks the caller's own directory. That is the same
// work the page's own search box already does, and the directory is bounded by MAX_LIST_ROWS.
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
  'lastSyncRunId',
  'snapshotBatchCount',
  'openExceptionCount',
  'heldLineCount',
  'readyLineCount',
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
 */
async function lastExportAtFor(audit, { tenantId, workspaceId, projectNo }) {
  if (!audit || typeof audit.list !== 'function') return null
  try {
    const result = await audit.list({
      tenantId,
      workspaceId,
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
async function resolveFillTarget(provisioning, stagingProjectId, boundTarget) {
  if (!provisioning || typeof provisioning.findObjectSheet !== 'function') return null
  if (typeof provisioning.getObjectSheetId !== 'function' || typeof provisioning.getObjectViewId !== 'function') return null
  const boundSheetId = optionalString(boundTarget && boundTarget.sheetId)
  if (!boundSheetId) return null
  const objectId = optionalString(boundTarget && boundTarget.objectId) || STOCK_PREPARATION_FILL_OBJECT_ID
  if (provisioning.getObjectSheetId(stagingProjectId, objectId) !== boundSheetId) return null
  const sheet = await provisioning.findObjectSheet({ projectId: stagingProjectId, objectId })
  const sheetId = sheet && sheet.id ? String(sheet.id) : ''
  if (!sheetId || sheetId !== boundSheetId) return null
  const viewId = provisioning.getObjectViewId(stagingProjectId, objectId, STOCK_PREPARATION_FILL_VIEW_LOGICAL_ID)
  if (typeof viewId !== 'string' || viewId.length === 0) return null
  return { sheetId, viewId }
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
 * @param {string} [params.workspaceId]
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
  workspaceId,
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

  // The SAME read the directory route answers with, under the SAME scope. A project belonging to
  // another tenant is simply absent from it, which is why the two 404s below cannot differ.
  const directory = await listOperatorProjectDirectory({
    recordsApi,
    provisioning,
    targetProjectId,
    scope,
  })

  const match = directory.projects.find((project) => optionalString(project.projectNo) === wanted)
  if (!match) {
    // Reported so the ROUTE can audit that a miss happened, then rethrown. The refusal itself stays
    // shapeless — the caller learns nothing beyond "not one of yours".
    const error = notFound()
    error.auditMode = STOCK_PREPARATION_PROJECT_BOARD_MODES[1]
    error.projectCount = directory.projectCount
    throw error
  }

  const fillTarget = await resolveFillTarget(provisioning, targetProjectId, boundTarget)
  const lastExportAt = await lastExportAtFor(audit, {
    tenantId: scope.tenantId,
    workspaceId,
    projectNo: wanted,
  })

  // BUILT KEY BY KEY. `match` is never spread — see STOCK_PREPARATION_PROJECT_BOARD_KEYS.
  const board = {
    tenantId: scope.tenantId,
    projectId: match.projectId,
    projectNo: match.projectNo,
    projectName: match.projectName,
    projectStatus: match.projectStatus,
    lastSyncRunId: match.lastSyncRunId,
    snapshotBatchCount: match.snapshotBatchCount,
    openExceptionCount: match.openExceptionCount,
    heldLineCount: match.heldLineCount,
    readyLineCount: match.readyLineCount,
    pendingDecisionCount: match.pendingDecisionCount,
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
    resolveFillTarget,
  },
}
