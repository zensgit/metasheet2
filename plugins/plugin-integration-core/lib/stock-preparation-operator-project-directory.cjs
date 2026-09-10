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
// THE PULL TARGET — the sheet the operator's OWN four-step run writes, and the second store this
// directory is a union over. Shared with 项目备料页 rather than restated: one tenant gate, one
// timestamp parse, one rule about what a truncated scan may claim.
const {
  SCAN_WHOLE_SHEET,
  resolveFillTarget,
  resolveOwnBoundSheet,
  scanPullTargetProjects,
} = require('./stock-preparation-pull-target-scan.cjs')
const { __internals: AUDIT_STORE_INTERNALS } = require('./stock-preparation-audit-store.cjs')

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
 * WHERE A DIRECTORY ROW CAME FROM. Two stores, two tiers, and the difference is the whole reason
 * this union exists:
 *
 *   * `mvp` — the MVP project ledger under the caller's own staging project, written by
 *     `mvp-persist`, which is PLATFORM-ADMIN and flag-gated. It is the only store this directory
 *     ever read, and on the flow the operator tier exists for it is empty.
 *   * `pull_target` — the bound table-action target, the sheet `apply` writes and the export reads.
 *     It is the ONLY store a floor operator's own run touches, so a project they pulled themselves
 *     appears here and nowhere else.
 *
 * A row present in both carries both tokens, sorted, so a reader can tell 「管理员归档过」 from
 * 「我自己拉的」 from 「两者都有」 without a second call.
 */
const OPERATOR_PROJECT_SOURCE_MVP = 'mvp'
const OPERATOR_PROJECT_SOURCE_PULL_TARGET = 'pull_target'

/** The action the materials export stamps its own audit row with. */
const PREP_LINE_EXPORT_AUDIT_ACTION = 'prep_line_export'

/**
 * The audit window `lastExportAtByProjectNo` reads. The store clamps `limit` to its own
 * MAX_LIST_LIMIT, so asking for exactly that is asking for the widest single page it will serve.
 */
const EXPORT_AUDIT_WINDOW = AUDIT_STORE_INTERNALS.MAX_LIST_LIMIT

/** An audit row's `created_at`, normalized the one way both export-timestamp readers normalize it. */
function normalizeAuditCreatedAt(createdAt) {
  if (!createdAt) return null
  return createdAt instanceof Date ? createdAt.toISOString() : String(createdAt)
}

/**
 * The last time ONE project's materials workbook left the system, from the values-free audit trail.
 * 项目备料页's reader — one project, one row, exact.
 *
 * DEGRADES, never fails: an audit store without `list` (or one that throws) yields `null` and the
 * board still answers. The timestamp is a convenience on a status bar — a page that 500s because a
 * convenience is unavailable is a worse page.
 *
 * NOTE the `projectId` filter: the export route stamps the projectNo into the audit row's
 * `project_id` (it is that route's subject), which is what makes a per-project lookup possible.
 * Neither this module nor the board writes there — see each route's own audit call, which keeps
 * project_id NULL.
 *
 * NO WORKSPACE FILTER, deliberately. Neither route accepts the caller's `?workspaceId` as a selector
 * any more (it was the one reachable way to put a business value on the audit trail), so there is
 * nothing here to narrow by; "the last time THIS tenant exported THIS project" is the question the
 * status bar asks, and it is the right one.
 *
 * IT LIVES IN THIS MODULE, not in the board, because the board already requires this one and the
 * reverse require would be a cycle. Both export-timestamp readers are therefore side by side, which
 * is what stops them normalizing `created_at` two different ways.
 */
async function lastExportAtFor(audit, { tenantId, projectNo }) {
  if (!audit || typeof audit.list !== 'function') return null
  try {
    const result = await audit.list({
      tenantId,
      projectId: projectNo,
      action: PREP_LINE_EXPORT_AUDIT_ACTION,
      limit: 1,
    })
    const entries = result && Array.isArray(result.entries) ? result.entries : []
    const first = entries[0]
    if (!first || !first.createdAt) return null
    return normalizeAuditCreatedAt(first.createdAt)
  } catch {
    return null
  }
}

/**
 * The last export time for EVERY project in the tenant, in ONE query.
 *
 * WHY NOT `lastExportAtFor` N TIMES. The directory answers about the whole tenant, and the audit
 * table's only relevant index is `(tenant_id, action, created_at DESC)` — there is none on
 * `project_id` (migration 066). So N per-project lookups would be N index scans each filtering a
 * column the index does not carry, on the read a floor operator's HOME PAGE issues. One descending
 * window over that same index answers all of them at once, and the entries carry `projectId`, so the
 * FIRST row seen for a project number IS its most recent export.
 *
 * THE WINDOW IS BOUNDED, SO THE ANSWER IS THREE-STATE, NOT TWO. When the store returns a full page,
 * a project whose last export fell outside the window is indistinguishable from a project that has
 * never been exported — and 「从未导出」 is a claim, not an absence. `bounded` is how the caller tells
 * them apart; it is surfaced as `lastExportAtMayBeIncomplete` and never silently swallowed.
 *
 * DEGRADES the same way its per-project sibling does: a store with no `list`, or one that throws,
 * yields `ready:false` and an empty map rather than failing the directory.
 */
async function lastExportAtByProjectNo(audit, { tenantId, limit = EXPORT_AUDIT_WINDOW } = {}) {
  const empty = { ready: false, bounded: false, byProjectNo: new Map() }
  if (!audit || typeof audit.list !== 'function') return empty
  try {
    const result = await audit.list({
      tenantId,
      action: PREP_LINE_EXPORT_AUDIT_ACTION,
      limit,
    })
    const entries = result && Array.isArray(result.entries) ? result.entries : []
    const byProjectNo = new Map()
    for (const entry of entries) {
      // `project_id` is where the export route stamps the customer's projectNo. A row without one
      // cannot be attributed to a project, so it is skipped — never guessed at.
      const projectNo = optionalString(entry && entry.projectId)
      if (!projectNo || byProjectNo.has(projectNo)) continue
      const at = normalizeAuditCreatedAt(entry && entry.createdAt)
      if (at) byProjectNo.set(projectNo, at)
    }
    // A SATURATED page means older rows exist that this window did not see. `>=` rather than `===`
    // because a store is free to return fewer than asked but never more than it holds.
    return { ready: true, bounded: entries.length >= limit, byProjectNo }
  } catch {
    return empty
  }
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
 * name, plus the counts the values-free directory already served, the pending-work count that makes
 * this a worklist rather than a list, and the two timestamps a person sorts and filters by.
 *
 * ---------------------------------------------------------------------------
 * IT IS A UNION OVER TWO STORES, AND THAT IS THE POINT (设计稿 N1)
 * ---------------------------------------------------------------------------
 *
 * Until this change the directory read exactly one store: the MVP project ledger, written by
 * `mvp-persist`. `mvp-persist` is PLATFORM-ADMIN and flag-gated, and the operator pull split left it
 * that way deliberately — so on the flow this whole tier exists for, where a floor operator runs the
 * four-step pull themselves, NOTHING is ever written there. Their project was not in the directory
 * on the day they pulled it, and it was not going to be in it next week either. The home page, the
 * search box and every query built on this route were empty for the main line of business.
 *
 * The second store is the one their own run DOES write: the bound table-action target, the sheet
 * `apply` writes and the export reads. Scanning it for the DISTINCT project numbers it contains is
 * what 项目备料页 already does for one project; here it is done once, unnarrowed, and merged with the
 * ledger rows BY PROJECT NUMBER. `sources` on each row says which store(s) answered.
 *
 * THE MERGE KEY IS `projectNo` — the business number — because that is the only identifier the two
 * stores share: the pull target has no `projectId` column at all, and the ledger's `projectNo` IS
 * the project template's `sourceProjectNo` (http-routes stamps it on the persist path, and a suite
 * pins that identity). A ledger row whose `sourceProjectNo` is null cannot be merged with anything
 * and stays a `mvp`-only row, which is exactly what it is.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE SCAN COSTS, AND WHY IT IS THEREFORE OPT-IN (核验裁决 r3)
 * ---------------------------------------------------------------------------
 *
 * The union scan reads the WHOLE bound sheet, in pages of `PULL_TARGET_PAGE_LIMIT`, up to
 * `PULL_TARGET_MAX_PAGES` — the export's own bound, shared so the two cannot drift. There is no
 * DISTINCT and no column projection on the records port, so "which project numbers are in this
 * sheet" genuinely costs one full pass, of every column, discarded.
 *
 * AND THE PASS IS QUADRATIC, NOT LINEAR, WHICH IS THE PART THAT IS EASY TO UNDER-BUDGET. The records
 * port pages by LIMIT/OFFSET (`query-service.ts`), so page P skips P·500 rows server-side and a
 * full P-page pass touches about P²·500/2 rows: ~40 rows·10⁴ at 20,000 rows, ~2.5 rows·10⁶ at the
 * 50,000-row bound. A keyset variant exists in the host (`queryRecordsWithCursor`) but is NOT on the
 * plugin records API, so making this linear is a host-contract change and is not this change.
 *
 * SO THE UNION IS NOT WHAT AN UNQUALIFIED READ OF THIS DIRECTORY DOES. The owner ruled that a cost
 * of that shape may not be charged to every home-page open and every board mount: the union runs
 * only for a caller that passes `includePullTargets` (the route spells it `?includePullTargets=1`,
 * the same strict `=== '1'` flag as `includePendingCounts`), and WITHOUT it this function returns
 * byte-for-byte the response it returned before 设计稿 N1 — the same top-level keys, the same row
 * keys, no pull-target-only rows, and not one query against the bound sheet. A surface that needs
 * the union — the operator home page, the project query panel — asks for it explicitly and throttles
 * itself; 项目备料页's board mount does not ask and pays nothing. `createPullTargetScanCache` then
 * keeps a refresh button from turning one opt-in into one scan per click.
 *
 * THE EXPORT TIMESTAMPS RIDE THE SAME FLAG, and NOT because they share the scan — `lastExportAt`
 * comes from one bounded audit window, not from the bound sheet. They ride it because the default
 * response shape is pinned to what it was before this change (S-02a), and `lastExportAt` /
 * `lastExportAtMayBeIncomplete` are not in that shape. Said plainly rather than folded into the
 * scan's rationale, so nobody later "optimizes" them apart and is surprised by a widened default.
 *
 * PAST THE BOUND, THE ANSWER IS A SUBSET AND THE RESPONSE SAYS SO. `directoryMayBeIncomplete` is
 * true when the scan hit the page bound, when the scan broke mid-flight (whatever it had already
 * read is discarded, so the pull target contributes nothing), or when the merge hit `MAX_LIST_ROWS`.
 * A directory that silently returned the first 50,000 rows' worth of project numbers would
 * be telling an operator their project does not exist, which is the one answer a "find my project"
 * surface must never give by accident.
 *
 * ---------------------------------------------------------------------------
 * THE 50,000-ROW HARD CAP IS A DECLARED LIMIT. IT IS NOT SOLVED HERE.
 * ---------------------------------------------------------------------------
 *
 * Past `PULL_TARGET_MAX_PAGES` × `PULL_TARGET_PAGE_LIMIT` rows in the bound sheet,
 * `directoryMayBeIncomplete` is PERMANENTLY TRUE and every row's `lastChangedFromPlmAt` reads
 * null with `lastChangedFromPlmBounded: true` — 「不知道」 forever. That is a limitation this module
 * DECLARES; it is not a steady state it was designed for, and nothing below quietly degrades instead
 * of saying so. 备料主表 accumulates a row per BOM line, so a live deployment reaches it.
 *
 * A REAL FIX NEEDS THE HOST, which is why it is not attempted here: either a per-column projection
 * or a cursor/keyset read on the plugin records port (`queryRecordsWithCursor` exists on the host
 * and is not exposed to plugins), or a projectNo-keyed materialization written by `apply`. Both are
 * contract changes outside this route, and both are listed as the next wave in the PR body.
 *
 * WHAT THIS CHANGE DOES ADD IS THE ABILITY TO SAY WHICH FAILURE IT IS. `pullTargetScanCapped`
 * separates 「表太大,被上限截断」 from 「读挂了」, which `directoryMayBeIncomplete` alone cannot: see
 * the key's own note in the response below.
 *
 * @param {object} params.scope  a scope resolved by `stock-preparation-operator-scope.cjs`. REQUIRED:
 *                               this module will not project a value without one, so it cannot be
 *                               reached from a route that forgot to establish who is asking.
 * @param {string} params.targetProjectId  the STAGING locator, which the caller MUST have derived
 *                               from `scope.tenantId` — asserted below, so a route that resolved a
 *                               scope for tenant A and then read tenant B's staging project fails
 *                               loudly here instead of answering.
 * @param {string} [params.projectNo]  ONE project's number, for a caller that is about one project.
 * @param {boolean} [params.includePendingIndex]  hand the caller the pending-work MAP, in process.
 * @param {boolean} [params.includePendingCounts]  put a SERIALIZABLE pending-work index on the
 *                               response. Opt-in; see the key's own note below.
 * @param {boolean} [params.includePullTargets]  RUN THE UNION AT ALL. Default false, and false is
 *                               the pre-N1 response byte for byte: no query against the bound sheet,
 *                               no audit window, no `sources` / `lastChangedFromPlm*` / `lastExportAt`
 *                               on a row, no `pullTargetReady` / `directoryMayBeIncomplete` /
 *                               `lastExportAtMayBeIncomplete` / `pullTargetScanCapped` /
 *                               `fillTarget` on the response, and no pull-target-only rows. See the
 *                               cost section above
 *                               for why the owner made this the default. 项目备料页 does not opt in —
 *                               it runs its own NARROWED scan and must not also pay an unnarrowed
 *                               one — so this whole feature costs that route exactly zero queries.
 * @param {object} [params.boundTarget]  the bound table-action target (`action.target`), or null.
 *                               Read ONLY under `includePullTargets`. Absent (or opted out) means
 *                               "do not scan": the union, `lastChangedFromPlmAt` and
 *                               `pullTargetReady` all degrade to their not-ready values.
 * @param {object} [params.audit]  the audit store, for the values-free last-export lookup. Read ONLY
 *                               under `includePullTargets`. Absent means "do not look":
 *                               `lastExportAt` is null on every row and
 *                               `lastExportAtMayBeIncomplete` is true, because nobody looked.
 * @param {object} [params.pullTargetScanCache]  a `createPullTargetScanCache()`, so a landing page
 *                               whose refresh button an operator can hold down pays one scan per
 *                               window rather than one per click. Absent = every call scans. The
 *                               cache is keyed by the sheet id the caller was JUST PROVED to own,
 *                               so it can only ever return a caller their own sheet.
 *
 * The whole tenant's directory is returned (bounded at MAX_LIST_ROWS), not only the projects with
 * pending work: an operator who typed a number that yields nothing has to be able to tell "that
 * number is not in this system" from "that project is real and has nothing pending", and only the
 * full directory can tell them apart. Filtering to pending-only is the FRONT END's default view over
 * this response, never a narrowing of the response itself.
 *
 * WHY THE `projectNo` NARROWING LIVES HERE rather than in the caller. 项目备料页 asks about a single
 * project, and answering it by listing the tenant and then `.find()`-ing cost 3 record queries PER
 * PROJECT IN THE TENANT plus a hard 422 above MAX_LIST_ROWS — a page whose cost is set by somebody
 * else's project count, and which stops answering about ANY project once a tenant grows past the
 * bound. The obvious fix, a second module that resolves one project, would have been a SECOND
 * tenant-confinement implementation to keep in step with this one; the whole reason the board reuses
 * this function is that the two must not be able to drift on who may see what. So the narrowing is a
 * parameter: the scope check, the staging-prefix tripwire, the projection and the counts are one
 * implementation, and the only thing `projectNo` changes is WHICH project rows are fetched.
 *
 * It is a FILTER ON THE PROJECT SHEET, applied under the already-verified staging project, so it can
 * only ever return a subset of what the unnarrowed call would have — it cannot reach a row the
 * tenant confinement would have excluded. It narrows the pull-target scan the same way, for the same
 * reason. `projectCount` then means "matching projects" (0 or 1), which is what the board's audit
 * records, and `projects` is the same row shape either way.
 */
async function listOperatorProjectDirectory({
  recordsApi,
  provisioning,
  targetProjectId,
  scope,
  projectNo,
  includePendingIndex = false,
  includePendingCounts = false,
  includePullTargets = false,
  boundTarget = null,
  audit = null,
  pullTargetScanCache = null,
} = {}) {
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

  // THE SECOND STORE — AND THE ONE SWITCH THAT DECIDES WHETHER IT IS READ AT ALL.
  //
  // `unioned` false is the whole pre-N1 read: not one query against the bound sheet, not one audit
  // window, and (below) not one extra key on the response. It is the DEFAULT because the union is a
  // full-sheet, quadratically-paged scan — see the cost section in the header — and the owner ruled
  // that a home page may not charge it on every open.
  //
  // `resolveOwnBoundSheet` is the tenant gate — `action.target` is deploy-time configuration shared
  // by every tenant on the deployment, so the sheet id it names is NOT derived from the caller's
  // tenant, and a caller who is not the proved owner reads nothing here at all. With no
  // `boundTarget` the gate short-circuits to null and the scan never runs.
  const unioned = includePullTargets === true
  const ownSheet = unioned && boundTarget
    ? await resolveOwnBoundSheet(provisioning, stagingProjectId, boundTarget)
    : null
  // WHICH READ, SAID IN AS MANY WORDS. A caller about ONE project narrows the pull-target scan the
  // same way it narrows the archive query; the directory's own route never narrows and asks for the
  // whole sheet by name. The sentinel is what keeps a lost `projectNo` from silently becoming the
  // second read — see `SCAN_WHOLE_SHEET`.
  //
  // NOT-ASKED IS THE SAME SHAPE AS NOT-READY, deliberately: the opt-out yields the `notScanned`
  // triple the scan itself returns when nothing is bound, so every consumer below has one code path
  // and only the KEY EMISSION differs. That is what keeps "opted out" from growing its own
  // half-tested branch through the merge and the projection.
  const pullScan = unioned
    ? await scanPullTargetProjects(
      recordsApi,
      ownSheet,
      boundTarget,
      narrowTo === null ? SCAN_WHOLE_SHEET : narrowTo,
      { cache: pullTargetScanCache },
    )
    : { ready: false, failed: false, bounded: false, byProjectNo: new Map() }
  const exportTimes = unioned
    ? await lastExportAtByProjectNo(audit, { tenantId: scope.tenantId })
    : { ready: false, bounded: false, byProjectNo: new Map() }
  // THE DEEP-LINK HANDLE FOR THE SHEET THE OPERATOR FILLS — 「打开备料多维表」, and the reason this
  // directory carries it at all.
  //
  // 项目备料页 has returned this handle since it shipped, but that page 404s until a project number is
  // in hand, so every OTHER 「到多维表」 button on this workbench (the home page, the sync panel, the
  // large-BOM panel) had no sheet id to route with and fell back to the plain multitable workbench —
  // i.e. the operator landed on a table chooser instead of their own 备料主表.
  //
  // IT COSTS NO EXTRA IO AND OPENS NO NEW DOOR. `ownSheet` is the ALREADY-RESOLVED result of
  // `resolveOwnBoundSheet` above — the same tenant gate, the same proof, the same object — and
  // `resolveFillTarget` on top of it is a pure host-side id derivation. So this is the board's handle,
  // from the board's gate, not a second answer to "which sheet may this caller be pointed at".
  //
  // AND IT IS TIED TO THE UNION OPT-IN because `ownSheet` is: a caller that did not ask for the
  // pull-target union never resolved a bound sheet, and a `fillTarget: null` on that response would
  // claim 「这台系统没有备料主表」 when the truth is 「没人问过」 — the same "absent, not false" rule the
  // four union flags below are built on. VALUES-FREE: two ids, no customer row content.
  const fillTarget = unioned ? await resolveFillTarget(provisioning, ownSheet, stagingProjectId) : null

  /**
   * ONE ROW, BUILT KEY BY KEY. Never a spread of a stored record — that is what S-02b pins, and it
   * is the reason a column no template declares cannot reach this surface.
   *
   * THE TIMESTAMP IS THREE-STATE, and the third state is the one that matters:
   *   * a value            — this project's rows really did change at that moment;
   *   * null + bounded:false — we read the whole pull target and no row of this project carries a
   *                            `lastPlmRefreshAt`. 「从未变更」 is safe to say.
   *   * null + bounded:true  — 「不知道」. Either the scan hit its page bound (the max would then be
   *                            over an unordered PREFIX, and a newer row past the bound would make
   *                            the answer silently stale-looking), or nobody scanned at all because
   *                            the pull target is not the caller's own / not bound / unreadable.
   * The board reports the same field with the same first two meanings and hands its reader
   * `pullTargetReady` on the SAME object for the third. A directory row travels alone — into a table
   * cell, a sort key, a filter — so the "nobody looked" case is folded into the row's own flag here
   * rather than left to a top-level key the row is about to be separated from. `pullTargetReady` is
   * still returned, because "nobody looked" and "we looked and the scan was truncated" are different
   * things to tell an operator.
   *
   * ALL FOUR OF THOSE KEYS EXIST ONLY UNDER `includePullTargets`. Without the opt-in this returns
   * the ten-key row it returned before 设计稿 N1 — not the same keys carrying null, ABSENT — because
   * `lastChangedFromPlmBounded: true` on a row nobody scanned is a truthful "unknown" that a table
   * would render as a column of 「未知」 on every home page, and because the frozen projection
   * (S-02a) is the contract the default answer is held to.
   */
  function buildRow({ projectId, data, projectNo: rowProjectNo, sources, counts }) {
    const row = {
      projectId,
      // THE TWO VALUE-BEARING FIELDS. Null when the stored row genuinely has none — never a
      // placeholder that a reader could mistake for a real number or name.
      projectNo: rowProjectNo,
      projectName: data ? optionalString(data.projectName) : null,
      projectStatus: data ? foldEnum(data.projectStatus, PROJECT_STATUS_VALUES) : null,
      lastSyncRunId: data ? optionalString(data.lastSyncRunId) : null,
      snapshotBatchCount: counts.snapshotBatchCount,
      openExceptionCount: counts.openExceptionCount,
      heldLineCount: counts.heldLineCount,
      readyLineCount: counts.readyLineCount,
      pendingDecisionCount: rowProjectNo ? (pending.byProjectNo.get(rowProjectNo) || 0) : 0,
    }
    if (!unioned) return row
    const pullFacts = rowProjectNo ? pullScan.byProjectNo.get(rowProjectNo) : undefined
    const timestampUnknown = pullScan.ready === false || pullScan.bounded === true
    row.sources = sources
    row.lastChangedFromPlmAt = timestampUnknown || !pullFacts || pullFacts.lastChangedFromPlmAtMs === null
      ? null
      : new Date(pullFacts.lastChangedFromPlmAtMs).toISOString()
    row.lastChangedFromPlmBounded = timestampUnknown
    // Same three-state shape, one level up: the window this came from is bounded, so a null here
    // means 「从未导出」 only when `lastExportAtMayBeIncomplete` is false.
    row.lastExportAt = rowProjectNo ? (exportTimes.byProjectNo.get(rowProjectNo) || null) : null
    return row
  }

  const projects = []
  const seenProjectNos = new Set()
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
    const rowProjectNo = optionalString(data.sourceProjectNo)
    if (rowProjectNo) seenProjectNos.add(rowProjectNo)

    projects.push(buildRow({
      projectId,
      data,
      projectNo: rowProjectNo,
      // BOTH tokens when the same number is also in the pull target — that is the dedupe: one row,
      // two sources, never two rows for one project number.
      sources: rowProjectNo && pullScan.byProjectNo.has(rowProjectNo)
        ? [OPERATOR_PROJECT_SOURCE_MVP, OPERATOR_PROJECT_SOURCE_PULL_TARGET]
        : [OPERATOR_PROJECT_SOURCE_MVP],
      counts: {
        snapshotBatchCount: batchRows.length,
        openExceptionCount: exceptionRows.filter((row) => optionalString(row.status) === 'open').length,
        heldLineCount: prepCounts[PREP_STATUS_HELD] || 0,
        readyLineCount: prepLineRows.length - (prepCounts[PREP_STATUS_HELD] || 0),
      },
    }))
  }

  // THE PULL-TARGET-ONLY ROWS — the projects a floor operator pulled themselves. They have NO
  // `projectId`: there is no archive row to take one from, and inventing a handle that resolves to
  // nothing is exactly the placeholder this projection refuses to emit for projectNo/projectName.
  // Every archive-derived field is null/zero for the same reason, and `sources` is what tells a
  // reader that those zeros mean 「还没归档」 rather than 「归档里是零」.
  //
  // SORTED, so the response is stable across calls: page order out of the records API is not.
  const pullOnlyProjectNos = [...pullScan.byProjectNo.keys()].filter((no) => !seenProjectNos.has(no)).sort()
  let mergeTruncated = false
  for (const rowProjectNo of pullOnlyProjectNos) {
    if (projects.length >= MAX_LIST_ROWS) {
      // The MVP-only path throws 422 above this bound because a caller cannot act on a partial
      // archive list. Here it must not: refusing the whole directory because the pull target is
      // large would take away the ONLY view of the projects the operator pulled. So the union is
      // capped and `directoryMayBeIncomplete` says the list is short — degrade, then say so.
      mergeTruncated = true
      break
    }
    projects.push(buildRow({
      projectId: null,
      data: null,
      projectNo: rowProjectNo,
      sources: [OPERATOR_PROJECT_SOURCE_PULL_TARGET],
      counts: { snapshotBatchCount: 0, openExceptionCount: 0, heldLineCount: 0, readyLineCount: 0 },
    }))
  }

  return {
    // Echoed so a caller (and a test) can see WHICH tenant answered. A tenant id is a handle, not a
    // customer business value — the same class of thing as projectId, which the values-free directory
    // has always returned.
    tenantId: scope.tenantId,
    // The two honesty flags the empty state is built on: whether the project table exists at all, and
    // whether the pending-work ledger exists. Without them "nothing pending" and "nothing installed"
    // are the same screen, which is the bug the empty-state copy had.
    //
    // `directoryReady` IS SHEET EXISTENCE AND NOTHING MORE. It is true on any deployment where
    // `mvp/ensure` has run (which the post-deploy smoke does every time), whether or not a single
    // project has ever been archived — so it answers "is the table installed", never "is there an
    // archive to look a number up in". NOTHING ASKS THE LATTER ANY MORE: the reconcile visibility
    // gate that did was deleted when the owner ruled against project ownership (2026-09-06), and it
    // took its `archiveEmpty` opt-in with it.
    directoryReady: projectSheet !== null,
    ledgerReady: pending.ready,
    // ─────────────────────────────────────────────────────────────────────────
    // THE UNION'S OWN KEYS — PRESENT ONLY UNDER `includePullTargets` (核验裁决 r3).
    //
    // Absent, not false. A `pullTargetReady: false` on a response nobody asked to scan is not a
    // fact about the deployment, it is a fact about the request, and a home page that rendered
    // 「拉取目标没绑好」 off it would be wrong on every correctly-configured deployment. The default
    // response is therefore the pre-N1 key set exactly, which is what S-02a asserts.
    // ─────────────────────────────────────────────────────────────────────────
    ...(unioned ? {
      // WAS THE OPERATOR'S OWN STORE READABLE AT ALL. False when no target is bound, when the bound
      // sheet is not provably the caller's own, when the target's explicit field map does not bind
      // the scope columns, or when the scan broke mid-flight. (Never "because nobody asked" — that
      // case has no key at all, which is the point of the wrapper above.)
      //
      // IT IS NOT `directoryMayBeIncomplete`, AND THE TWO TOGETHER ARE WHAT SEPARATE THE CASES. A
      // deployment with nothing bound has no pull-target projects to be missing, so flagging it
      // incomplete would flag it forever and train every reader to ignore the flag. A scan that broke
      // mid-flight is the opposite: pull-target projects really are missing from this answer, so it
      // sets BOTH — false/true, a pair that no other state produces. That pair is also what a reader
      // of the audit trail needs, because `{pullTargetReady:false, directoryMayBeIncomplete:false}`
      // otherwise reads identically for 「什么都没绑」 and 「读挂了」.
      //
      // WHAT A FRONT END MAY SAY ON `pullTargetReady:false` IS THEREFORE LIMITED. It is one boolean
      // over four distinct situations (unbound / not ours / scope columns unbound / the read broke),
      // so it will not carry a sentence about deployment configuration — 「自助拉取的项目暂时读不到」
      // is true in all four; 「外接源还没绑好」 is a confident falsehood in the fourth. Splitting it
      // into a closed enum is a new top-level key and therefore a new S-02a contract review; it is
      // named in the PR body as the follow-up rather than smuggled in here.
      pullTargetReady: pullScan.ready,
      // THE DEEP-LINK HANDLE, `{ sheetId, viewId }` or null — see its own note above the computation.
      // It is NOT a permission decision and this module cannot make one: multitable enforces access
      // when the operator lands. Null means "no bound sheet this caller is proved to own", which the
      // front end renders as 「打开多维表工作台」 rather than as a dead button.
      fillTarget,
      // THE ANTI-SILENT-TRUNCATION FLAG (设计稿 N1). True when the union may be missing project
      // numbers, in all THREE ways that can happen: the pull-target scan hit `PULL_TARGET_MAX_PAGES`,
      // the scan broke mid-flight (`failed` — the pages already read are discarded, so the pull
      // target's whole contribution is gone), or the merge hit `MAX_LIST_ROWS`.
      // A "find my project" surface that quietly returns a prefix tells an operator their project does
      // not exist; this is the flag that lets the page say 「可能不全」 instead.
      directoryMayBeIncomplete: pullScan.bounded === true || pullScan.failed === true || mergeTruncated,
      // WHICH KIND OF SHORT ANSWER THIS IS — 「表太大,被上限截断」 vs 「读挂了」 (核验裁决 r3).
      //
      // `directoryMayBeIncomplete` alone cannot say, and the difference is the difference between
      // two sentences a front end must not confuse: 「备料主表太大,目录只列到前 N 行」 (a standing,
      // declared limit of this deployment — see the header's hard-cap section) and 「刚才读拉取目标
      // 失败了,稍后再试」 (a blip). Told wrong, an operator retries forever against a cap, or files
      // a data-loss ticket against a transient error.
      //
      // TRUE MEANS EXACTLY ONE THING: the scan reached `PULL_TARGET_MAX_PAGES` with a full page
      // still coming back. It is NOT the merge cap (`MAX_LIST_ROWS`, a different bound on a
      // different list) and NOT a mid-flight break. Together with `pullTargetReady` the three
      // states are separable and no other pair produces them:
      //   {ready:true,  capped:true }              — the sheet is past the scan bound;
      //   {ready:false, capped:false} + incomplete — the read broke mid-flight;
      //   {ready:true,  capped:false} + incomplete — the merge hit MAX_LIST_ROWS.
      //
      // IT IS A NEW TOP-LEVEL KEY and therefore an S-02a contract review in its own right; that
      // review is written into the assertion, not only here.
      pullTargetScanCapped: pullScan.bounded === true,
      // The same honesty for the export column: a null `lastExportAt` means 「从未导出」 only when this
      // is false. True when no audit store was passed, when its `list` threw, or when the single
      // descending window it serves came back full.
      lastExportAtMayBeIncomplete: exportTimes.ready === false || exportTimes.bounded === true,
    } : {}),
    projectCount: projects.length,
    pendingProjectCount: projects.filter((project) => project.pendingDecisionCount > 0).length,
    // THE PENDING MAP ITSELF, projectNo -> count — TWO opt-ins, neither of them on by default.
    //
    // It is keyed by the BUSINESS number, so it is answerable for a project that has NO archive row
    // at all: the normal shape after an operator's own pull, since the MVP project table is written
    // by mvp-persist and mvp-persist is platform-admin. A caller reading pending work off a
    // per-project row silently reports zero for exactly those projects — the board did.
    //
    // IT IS ALSO WIDER THAN `projects`. A project number can carry pending decisions while appearing
    // in NEITHER store — its archive row was never written and its pull-target rows are gone or
    // unreadable — and only the index can show that work exists at all. That is why the route gets
    // an opt-in on it rather than being told the rows are enough.
    //
    // WHY TWO KEYS AND NOT ONE. `pendingByProjectNo` is a Map: it is the IN-PROCESS channel for the
    // board, which consumes it and projects its own frozen key set, and a Map would serialize as
    // `{}` on the wire. `pendingCountsByProjectNo` is the SERIALIZABLE form, on a null-prototype
    // object so a project number spelled `__proto__` is an ordinary key. Both are computed from the
    // one `pending.byProjectNo`, so they cannot disagree.
    //
    // WHY OPT-IN AT ALL. The DIRECTORY ROUTE sends this object as its response and its top-level key
    // set is frozen and asserted (S-02a). Making either default would be an unreviewed widening of a
    // value-bearing response projection — the index's KEYS are customer project numbers — so only a
    // caller that asks gets it, and the route's default shape is unchanged by construction.
    ...(includePendingIndex ? { pendingByProjectNo: pending.byProjectNo } : {}),
    ...(includePendingCounts ? { pendingCountsByProjectNo: pendingCountsObject(pending.byProjectNo) } : {}),
    projects,
  }
}

/** The pending index as a plain, null-prototype object — the wire form of `pending.byProjectNo`. */
function pendingCountsObject(byProjectNo) {
  const counts = Object.create(null)
  for (const [projectNo, count] of byProjectNo) counts[projectNo] = count
  return counts
}

module.exports = {
  CONFIRMATION_DECISION_OBJECT_ID,
  OPERATOR_PROJECT_SOURCE_MVP,
  OPERATOR_PROJECT_SOURCE_PULL_TARGET,
  PREP_LINE_EXPORT_AUDIT_ACTION,
  PROJECT_OBJECT_ID,
  StockPreparationOperatorDirectoryError,
  StockPreparationProjectReadsError,
  listOperatorProjectDirectory,
  __internals: {
    EXPORT_AUDIT_WINDOW,
    lastExportAtByProjectNo,
    // Re-exported for 项目备料页, which owns the per-project reader's only caller but must not hold a
    // second copy of it — see the function's own note on why it lives here.
    lastExportAtFor,
    normalizeAuditCreatedAt,
    pendingCountsObject,
    pendingDecisionCountsByProjectNo,
    recordData,
    requiredString,
  },
}
