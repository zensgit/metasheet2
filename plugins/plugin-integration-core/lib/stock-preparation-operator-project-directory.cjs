'use strict'

// 一线看得见自己工厂的项目 — THE OPERATOR-SCOPED, NAME-BEARING PROJECT DIRECTORY.
//
// ---------------------------------------------------------------------------
// THE PROBLEM THIS SOLVES
// ---------------------------------------------------------------------------
//
// A floor operator could not find their own project. The only project directory
// (`stock-preparation-project-reads.cjs` -> `listStockPreparationProjects`) is reachable only on
// `integration:read`/`:write`/platform admin — which the stock-prep operator tier deliberately does
// NOT confer (R-11's mapping is zero-automatic) — and it is values-free by construction, so even an
// admin sees option labels built from a status, some counts and a runId, with no number and no name.
// The confirmation queue then demands a hand-typed `projectNo`. Net effect: the operator had to
// memorise, out of band, that 230920006 is the RY2 注射水缓冲罐部件.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A NEW MODULE AND NOT A WIDER PROJECTION ON THE OLD ONE
// ---------------------------------------------------------------------------
//
// `stock-preparation-project-reads.cjs` is the PLATFORM contract: its projection is what the admin /
// platform-facing workspace consumes, its header states the values-free hard boundary as a property
// of that route, and a suite plants a secret into `sourceProjectNo`/`projectName` and asserts neither
// the values NOR THE FIELD NAMES ever appear in its response. Widening it would break the boundary
// for the surface the boundary exists to protect.
//
// So that module is not touched at all — not one byte — and this one is its operator-tier sibling:
// its own route, its own manifest row, its own gate, its own projection. It REUSES that module's
// internals (sheet resolution, paging, enum folding) rather than restating them, so the two cannot
// drift on how a project row is found, only on what is projected out of it.
//
// ---------------------------------------------------------------------------
// WHAT CROSSES HERE, AND WHY THAT IS NOT A REGRESSION
// ---------------------------------------------------------------------------
//
// `projectNo` (the project template's `sourceProjectNo`) and `projectName` cross this route. They do
// not cross any other. The posture, ruled by the owner, is that the boundary is "whose data is it",
// not "which screen is it": the values-free stance exists to keep the PLATFORM/CONSULTANT side out of
// customer values, and a factory operator seeing their OWN tenant's project numbers and names is the
// job, not a breach.
//
// The three things that make that safe are ALL enforced before this module reads anything:
//   1. the gate — `stock-prep:operate`, the same notch-tighter tier that already carries the ONLY two
//      other value-bearing stock-prep reads (the per-decision value readback, and 按项目导出物料
//      Excel, which already ships material names and quantities). This is not a new class of surface;
//      it is a third member of an existing one.
//   2. the scope — `stock-preparation-operator-scope.cjs`, which derives the tenant from the
//      AUTHENTICATED principal only and refuses a principal with no tenant of its own. A tenantless
//      platform admin is refused here even though `resolveTenantId` would have let them steer.
//   3. the target — `targetProjectId` is the staging locator derived from that verified tenant, never
//      request-sourced, so there is no reachable input by which tenant A's caller addresses tenant
//      B's staging project.
//
// AUDIT STAYS VALUES-FREE. This module returns values to the CALLER; nothing it returns may be put in
// an audit row. The route's audit append carries counts and handles only — never a projectNo, never a
// projectName. That is asserted by a suite, not left to discipline.

const {
  PROJECT_OBJECT_ID,
  BATCH_OBJECT_ID,
  EXCEPTION_OBJECT_ID,
  PREP_LINE_OBJECT_ID,
  PROJECT_STATUS_VALUES,
  StockPreparationProjectReadsError,
  __internals: PROJECT_READ_INTERNALS,
} = require('./stock-preparation-project-reads.cjs')
const {
  OBJECT_ID: CONFIRMATION_DECISION_OBJECT_ID,
  STATUSES: DECISION_STATUSES,
  StockPreparationConfirmationDecisionError,
  __internals: DECISION_INTERNALS,
} = require('./stock-preparation-confirmation-decisions.cjs')
const { optionalString } = require('./stock-preparation-common.cjs')

const {
  findMvpSheet,
  queryAllRecords,
  foldEnum,
  enumCounts,
  MAX_LIST_ROWS,
  PREP_STATUS_HELD,
} = PROJECT_READ_INTERNALS

class StockPreparationOperatorDirectoryError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationOperatorDirectoryError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function requiredString(value, field) {
  const normalized = optionalString(value)
  if (!normalized) {
    throw new StockPreparationOperatorDirectoryError(422, 'OPERATOR_DIRECTORY_CONFIG_INVALID', `${field} is required`, { field })
  }
  return normalized
}

function recordData(record) {
  if (record && typeof record === 'object' && record.data && typeof record.data === 'object') return record.data
  return record && typeof record === 'object' ? record : {}
}

/**
 * PENDING WORK PER PROJECT NUMBER, from the confirmation-decision ledger.
 *
 * The ledger keys rows by `projectNo`, and `projectNo` IS the project template's `sourceProjectNo`
 * (http-routes.cjs stamps `sourceProjectNo: prepared.parameters.projectNo` on the persist path) —
 * that identity is what makes this join meaningful, and a suite pins it.
 *
 * DEGRADES, never fails the whole directory: on a deployment where the ledger table has not been
 * provisioned yet, `ready:false` comes back with an empty map and every project reports zero pending.
 * The directory is still worth serving without it — the operator can still find their project by
 * name — and the FE says which of the two situations it is rather than showing one "都清了" for both.
 */
async function pendingDecisionCountsByProjectNo(recordsApi, provisioning, targetProjectId, projectNo) {
  let scoped
  try {
    scoped = await DECISION_INTERNALS.resolveScopedLedger(recordsApi, provisioning, targetProjectId, ['queryRecords'])
  } catch (error) {
    if (error instanceof StockPreparationConfirmationDecisionError
      && error.code === 'CONFIRMATION_DECISION_TARGET_NOT_READY') {
      return { ready: false, byProjectNo: new Map() }
    }
    throw error
  }
  // Narrowed the same way the project sheet is when the caller is about ONE project: the ledger is
  // keyed by `projectNo`, so the row bound (CONFIRMATION_DECISION_LIST_LIMIT_EXCEEDED) then applies
  // to that project's pending work rather than to the tenant's — a busy neighbour project can no
  // longer take the board down.
  const narrowTo = optionalString(projectNo)
  const rows = await DECISION_INTERNALS.queryAll(scoped, narrowTo
    ? { status: DECISION_STATUSES.PENDING, projectNo: narrowTo }
    : { status: DECISION_STATUSES.PENDING })
  const byProjectNo = new Map()
  for (const row of rows) {
    const projectNo = optionalString(DECISION_INTERNALS.readCell(row, 'projectNo'))
    if (!projectNo) continue
    byProjectNo.set(projectNo, (byProjectNo.get(projectNo) || 0) + 1)
  }
  return { ready: true, byProjectNo }
}

/**
 * THE OPERATOR PROJECT DIRECTORY — every project in the CALLER'S OWN tenant, with its number and its
 * name, plus the counts the values-free directory already served and the pending-work count that
 * makes this a worklist rather than a list.
 *
 * @param {object} params.scope  a scope resolved by `stock-preparation-operator-scope.cjs`. REQUIRED:
 *                               this module will not project a value without one, so it cannot be
 *                               reached from a route that forgot to establish who is asking.
 * @param {string} params.targetProjectId  the STAGING locator, which the caller MUST have derived
 *                               from `scope.tenantId` — asserted below, so a route that resolved a
 *                               scope for tenant A and then read tenant B's staging project fails
 *                               loudly here instead of answering.
 *
 * The whole tenant's directory is returned (bounded at MAX_LIST_ROWS), not only the projects with
 * pending work: an operator who typed a number that yields nothing has to be able to tell "that
 * number is not in this system" from "that project is real and has nothing pending", and only the
 * full directory can tell them apart. Filtering to pending-only is the FRONT END's default view over
 * this response, never a narrowing of the response itself.
 *
 * @param {string} [params.projectNo]  ONE project's number, for a caller that is about one project.
 *
 * WHY THE NARROWING LIVES HERE rather than in the caller. 项目备料页 asks about a single project, and
 * answering it by listing the tenant and then `.find()`-ing cost 3 record queries PER PROJECT IN THE
 * TENANT plus a hard 422 above MAX_LIST_ROWS — a page whose cost is set by somebody else's project
 * count, and which stops answering about ANY project once a tenant grows past the bound. The obvious
 * fix, a second module that resolves one project, would have been a SECOND tenant-confinement
 * implementation to keep in step with this one; the whole reason the board reuses this function is
 * that the two must not be able to drift on who may see what. So the narrowing is a parameter: the
 * scope check, the staging-prefix tripwire, the projection and the counts are one implementation, and
 * the only thing `projectNo` changes is WHICH project rows are fetched.
 *
 * It is a FILTER ON THE PROJECT SHEET, applied under the already-verified staging project, so it can
 * only ever return a subset of what the unnarrowed call would have — it cannot reach a row the
 * tenant confinement would have excluded. `projectCount` then means "matching projects" (0 or 1),
 * which is what the board's audit records, and `projects` is the same row shape either way.
 */
async function listOperatorProjectDirectory({ recordsApi, provisioning, targetProjectId, scope, projectNo } = {}) {
  if (!scope || !optionalString(scope.tenantId)) {
    throw new StockPreparationOperatorDirectoryError(500, 'OPERATOR_DIRECTORY_SCOPE_REQUIRED', 'operator project directory requires a resolved operator value scope')
  }
  const stagingProjectId = requiredString(targetProjectId, 'targetProjectId')
  // THE TENANT TRIPWIRE. The staging locator convention is `${tenantId}:integration-core`; if a
  // caller ever hands this module a staging project that is not the scope's own, refuse rather than
  // read. Cheap, and it makes the cross-tenant guard a property of this module rather than of the one
  // route that currently calls it.
  const expectedStagingPrefix = `${scope.tenantId}:`
  if (!stagingProjectId.startsWith(expectedStagingPrefix)) {
    throw new StockPreparationOperatorDirectoryError(403, 'OPERATOR_DIRECTORY_SCOPE_MISMATCH', 'the staging project does not belong to the resolved operator scope')
  }

  // The narrowing, if the caller asked about one project: a FILTER on the project sheet's own
  // `sourceProjectNo`, resolved through the same scoped records API every other read here uses. An
  // unnarrowed call passes `{}` and is byte-for-byte the read it always was.
  const narrowTo = optionalString(projectNo)
  const projectFilter = narrowTo ? { sourceProjectNo: narrowTo } : {}
  const projectSheet = await findMvpSheet(recordsApi, provisioning, stagingProjectId, PROJECT_OBJECT_ID)
  const projectRows = projectSheet ? (await queryAllRecords(projectSheet, projectFilter)).map(recordData) : []
  if (projectRows.length > MAX_LIST_ROWS) {
    throw new StockPreparationOperatorDirectoryError(422, 'OPERATOR_DIRECTORY_ROWS_TOO_LARGE', 'operator project directory exceeded the row bound', { maxRows: MAX_LIST_ROWS })
  }

  const batchSheet = await findMvpSheet(recordsApi, provisioning, stagingProjectId, BATCH_OBJECT_ID)
  const exceptionSheet = await findMvpSheet(recordsApi, provisioning, stagingProjectId, EXCEPTION_OBJECT_ID)
  const prepLineSheet = await findMvpSheet(recordsApi, provisioning, stagingProjectId, PREP_LINE_OBJECT_ID)
  const pending = await pendingDecisionCountsByProjectNo(recordsApi, provisioning, stagingProjectId, narrowTo)

  const projects = []
  for (const data of projectRows) {
    const projectId = optionalString(data.projectId)
    // Same defence-in-depth as the values-free directory: a row without its own key field cannot be
    // used as a navigation handle, so it is skipped rather than emitted unselectable.
    if (!projectId) continue

    const batchRows = batchSheet ? await queryAllRecords(batchSheet, { projectId }) : []
    const exceptionRows = exceptionSheet
      ? (await queryAllRecords(exceptionSheet, { projectId })).map(recordData)
      : []
    const prepLineRows = prepLineSheet
      ? (await queryAllRecords(prepLineSheet, { projectId })).map(recordData)
      : []
    const prepCounts = enumCounts(prepLineRows, 'prepStatus', [PREP_STATUS_HELD])
    const projectNo = optionalString(data.sourceProjectNo)

    projects.push({
      projectId,
      // THE TWO VALUE-BEARING FIELDS. Null when the stored row genuinely has none — never a
      // placeholder that a reader could mistake for a real number or name.
      projectNo,
      projectName: optionalString(data.projectName),
      projectStatus: foldEnum(data.projectStatus, PROJECT_STATUS_VALUES),
      lastSyncRunId: optionalString(data.lastSyncRunId),
      snapshotBatchCount: batchRows.length,
      openExceptionCount: exceptionRows.filter((row) => optionalString(row.status) === 'open').length,
      heldLineCount: prepCounts[PREP_STATUS_HELD] || 0,
      readyLineCount: prepLineRows.length - (prepCounts[PREP_STATUS_HELD] || 0),
      pendingDecisionCount: projectNo ? (pending.byProjectNo.get(projectNo) || 0) : 0,
    })
  }

  return {
    // Echoed so a caller (and a test) can see WHICH tenant answered. A tenant id is a handle, not a
    // customer business value — the same class of thing as projectId, which the values-free directory
    // has always returned.
    tenantId: scope.tenantId,
    // The two honesty flags the empty state is built on: whether the project table exists at all, and
    // whether the pending-work ledger exists. Without them "nothing pending" and "nothing installed"
    // are the same screen, which is the bug the empty-state copy had.
    directoryReady: projectSheet !== null,
    ledgerReady: pending.ready,
    projectCount: projects.length,
    pendingProjectCount: projects.filter((project) => project.pendingDecisionCount > 0).length,
    // THE PENDING MAP ITSELF, projectNo -> count. Returned because it is keyed by the BUSINESS
    // number and is therefore answerable for a project that has NO archive row at all — which is
    // the normal shape after an operator's own pull, since the MVP project table is written by
    // mvp-persist and mvp-persist is platform-admin. A caller that reads pending work off a
    // per-project row silently reports zero for exactly those projects; the board did.
    pendingByProjectNo: pending.byProjectNo,
    projects,
  }
}

module.exports = {
  CONFIRMATION_DECISION_OBJECT_ID,
  PROJECT_OBJECT_ID,
  StockPreparationOperatorDirectoryError,
  StockPreparationProjectReadsError,
  listOperatorProjectDirectory,
  __internals: {
    pendingDecisionCountsByProjectNo,
    recordData,
    requiredString,
  },
}
