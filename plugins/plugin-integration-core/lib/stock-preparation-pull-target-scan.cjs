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
// proved to own it — by the provisioning registry, or by the deterministic (project, object) hash —
// and, whenever the host's ports can decide it at all, only when that sheet has not since been
// DELETED (`proveBoundSheetIsAlive`: the registry goes on claiming a soft-deleted sheet forever).
// A caller who is not the owner never reads that sheet at all. This module adds no new way to name a
// sheet and takes no tenant id of its own: it is handed an already-proved `ownSheet` or it reads
// nothing.
//
// WHAT THIS DOES NOT CLAIM — carried over VERBATIM IN SUBSTANCE from the board's own header, because
// the correction it records was written to retract an overclaim and moving the code must not lose it.
// `plm_stock_preparation_main` has NO tenant column; the only row-level scope inside it is
// `projectNo`. So this does not claim that a deployment which points SEVERAL tenants at ONE shared
// target keeps their rows apart: it cannot, and the export route has the same property for the same
// reason. On such a deployment the owning tenant reads the whole sheet — which is what "owning"
// means here.
//
// AND THE UNNARROWED SCAN WIDENS WHAT THAT COSTS, so it is said out loud rather than left implied.
// The board's narrowed read let the owner CONFIRM a project number they already had. The directory's
// unnarrowed scan ENUMERATES every distinct project number in that sheet — including, on a shared
// target, the numbers another tenant's `apply` wrote. It is the same sheet, the same owner and the
// same gate: what changes is that the owner no longer has to guess a number to see it. Single-target
// deployments (222 today) are unaffected; a multi-tenant shared target needs the per-tenant target
// the board's header already names as the real fix, and it is not this change either.

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
 * "SCAN THE WHOLE SHEET" — SAID IN AS MANY WORDS, never inferred from a falsy value.
 *
 * The narrowing argument decides between two RADICALLY different reads: one project's rows, or every
 * row in the bound sheet. The first cut let `null`/`''`/a non-string mean the second, which is a
 * fail-OPEN default in a scan whose whole job is scoping: a caller that lost its project number
 * mid-flight would silently widen to the whole table and then attribute the WHOLE table's row count
 * and max timestamp to the one project it thought it was asking about. (Before the two reads were
 * merged, that same input produced `filters: { <projectNo field>: <falsy> }` — a filter that matches
 * nothing. Fail-closed by accident, but fail-closed.)
 *
 * So the whole-sheet read now has a NAME, and anything that is neither this sentinel nor a non-empty
 * string reads NOTHING (`ready: false`) instead of guessing which of the two the caller meant.
 */
const SCAN_WHOLE_SHEET = Symbol('stock-preparation.scanPullTargetProjects.SCAN_WHOLE_SHEET')

/**
 * HOW LONG ONE UNNARROWED SCAN MAY BE REUSED, and how many distinct scans may be held at once.
 *
 * The unnarrowed scan is the expensive read on this module (see `scanPullTargetProjects`), it is on
 * an operator's LANDING PAGE, and the page has a refresh button — so without this, an authenticated
 * operator holding down refresh is a full-table scan per click, serially paged, on a single-node
 * deployment. The cache is what makes the cost per WINDOW rather than per CLICK, and it also
 * coalesces the several-operators-refresh-at-once case, since concurrent callers share one in-flight
 * promise rather than starting a scan each.
 *
 * FIVE SECONDS IS CHOSEN AGAINST ONE SPECIFIC FAILURE: an operator finishes their own pull and goes
 * looking for the project. A pull that writes hundreds of rows takes far longer than this window, so
 * the project is in the sheet well before the window a post-pull navigation could land in — and a
 * second refresh five seconds later is never stale. Set the TTL to 0 to turn the cache off entirely.
 */
const PULL_TARGET_SCAN_CACHE_TTL_MS = 5_000
const PULL_TARGET_SCAN_CACHE_MAX_ENTRIES = 32

/**
 * A TINY, BOUNDED, PER-REGISTRATION MEMO for `scanPullTargetProjects`.
 *
 * WHAT IT MAY HOLD AND WHY THAT IS SAFE. Entries are keyed by the ALREADY-PROVED sheet id (plus the
 * narrowing and the field bindings the scan ran under). `resolveOwnBoundSheet` runs in the CALLER's
 * request, before this is ever consulted, so a caller who cannot prove ownership of a sheet never
 * reaches the key that names it: the cache can only ever hand a reader the sheet they had just been
 * proved to own. Two tenants that share one target read the same sheet with or without this — see the
 * header's WHAT THIS DOES NOT CLAIM.
 *
 * A FAILED SCAN IS NEVER HELD. Caching a transient read failure would turn one blip into five
 * seconds of degraded answers for every operator on the deployment, so a result that carries
 * `failed: true` (and a rejected promise, which today's scan cannot produce) is evicted on
 * settlement, leaving the next caller to retry immediately.
 *
 * It is created per `createHandlers` call — one per plugin registration in production, one per mount
 * in the suites, so no test ever sees another test's scan.
 */
function createPullTargetScanCache({
  ttlMs = PULL_TARGET_SCAN_CACHE_TTL_MS,
  maxEntries = PULL_TARGET_SCAN_CACHE_MAX_ENTRIES,
  now = Date.now,
} = {}) {
  const entries = new Map()
  return {
    async resolve(key, run) {
      if (!(ttlMs > 0)) return run()
      const nowMs = now()
      const hit = entries.get(key)
      if (hit && hit.expiresAt > nowMs) return hit.promise
      for (const [entryKey, entry] of entries) {
        if (entry.expiresAt <= nowMs) entries.delete(entryKey)
      }
      while (entries.size >= maxEntries) {
        const oldest = entries.keys().next()
        if (oldest.done) break
        entries.delete(oldest.value)
      }
      const promise = run()
      entries.set(key, { expiresAt: nowMs + ttlMs, promise })
      promise.then(
        (result) => { if (!result || result.failed === true) entries.delete(key) },
        () => { entries.delete(key) },
      )
      return promise
    },
    /** For the suites only: how many windows are currently held. */
    size() { return entries.size },
  }
}

/**
 * DOES THE BOUND SHEET STILL EXIST — `'alive'`, `'deleted'` or `'unprovable'`.
 *
 * WHY IT IS A THREE-STATE AND NOT A BOOLEAN. The only existence read this plugin has is
 * `findObjectSheet({ projectId, objectId })`, which on the host side is
 * `loadActiveSheet(getObjectSheetId(projectId, objectId))` — i.e. `SELECT ... FROM meta_sheets WHERE
 * id = $1 AND deleted_at IS NULL` over a DERIVED id. It can therefore answer about a sheet ONLY when
 * we can name a (project, objectId) pair whose derived id IS the bound sheet id. When no such pair
 * is available the honest answer is "cannot say", and collapsing that into `false` would refuse the
 * hand-bound sheets PROOF 1 exists to admit — a regression dressed up as a guard.
 *
 * THE TWO CANDIDATE OBJECT IDS, AND WHY THE SECOND ONE MATTERS. The binding's own objectId is tried
 * first (the ordinary deployment: the action names the canonical fill object and the sheet was
 * created under it). The canonical fill object is tried second, because that is exactly the D1=B
 * deploy-window shape the runbook sanctions: the action is rebound to a SANDBOX objectId while the
 * sheetId stays the one the deployment already had — created under the canonical object. Without the
 * second candidate that configuration would be permanently `'unprovable'`, i.e. the one shape a live
 * deployment actually runs would get no liveness check at all.
 *
 * WHAT STAYS UNPROVABLE, said out loud: a sheet an administrator bound BY HAND, whose id hashes from
 * neither candidate. Nothing on the plugin side can name it to the host's existence read, so it
 * keeps the behaviour it has always had (the registry's ownership answer alone). Closing that needs a
 * host port that takes a SHEET ID — `findSheetById`/`isSheetActive` — and that is a host change, not
 * one this plugin can fake. It is named in the PR body as the remaining gap rather than left implied.
 *
 * WHAT IT COSTS: at most ONE provisioning read, and only when a candidate id actually matches — the
 * pure hash comparison is what decides whether any IO happens at all. It is the SAME read PROOF 2
 * already paid on the same configuration (a registry hit now answers before PROOF 2 is reached, so
 * the two never both run), so the ordinary deployment's query budget is unchanged; what is new is one
 * read on the registry path, per resolution, and the resolution happens once per request.
 *
 * IT ADDS NO WAY TO NAME A SHEET. Every read here is `(the caller's OWN staging project, an objectId)`
 * and the result is only ever compared against the ALREADY-BOUND sheet id; a mismatch is `'deleted'`
 * — the sheet whose id we hold is not the live sheet that pair resolves to — never an invitation to
 * follow the id that came back.
 */
async function proveBoundSheetIsAlive(provisioning, stagingProjectId, boundSheetId, boundObjectId) {
  if (typeof provisioning.getObjectSheetId !== 'function') return 'unprovable'
  if (typeof provisioning.findObjectSheet !== 'function') return 'unprovable'
  const candidateObjectIds = boundObjectId === STOCK_PREPARATION_FILL_OBJECT_ID
    ? [boundObjectId]
    : [boundObjectId, STOCK_PREPARATION_FILL_OBJECT_ID]
  for (const candidateObjectId of candidateObjectIds) {
    if (provisioning.getObjectSheetId(stagingProjectId, candidateObjectId) !== boundSheetId) continue
    const sheet = await provisioning.findObjectSheet({ projectId: stagingProjectId, objectId: candidateObjectId })
    const sheetId = sheet && sheet.id ? String(sheet.id) : ''
    return sheetId === boundSheetId ? 'alive' : 'deleted'
  }
  return 'unprovable'
}

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
 * ---------------------------------------------------------------------------
 * OWNERSHIP IS NOT EXISTENCE — WHY THE REGISTRY PATH ALSO HAS TO ASK `proveBoundSheetIsAlive`
 * ---------------------------------------------------------------------------
 *
 * The first cut of PROOF 1 returned the sheet id the moment the registry said "yours", on the
 * reasoning that a sheet id is in `plugin_multitable_object_registry` because provisioning put it
 * there. That is evidence the sheet was CREATED. It is not evidence it still exists: deleting a
 * table is `UPDATE meta_sheets SET deleted_at = now()` (routes/univer-meta.ts), and NOTHING in the
 * product ever deletes the registry row — so after a delete the registry still answers "yours" about
 * a sheet that is gone, and the gate handed out a deep link into a deleted table plus a scan against
 * it. That contradicted this module's own claim that the gate proves the sheet "belongs to the
 * caller's own staging project AND exists", and the cost grew with this pass's second caller: the
 * handle went from 项目备料页 alone to the operator home page and the project workbench as well.
 *
 * So liveness is proved SEPARATELY, and only ever NARROWS: a sheet the registry does not claim is
 * still refused exactly as before, and a sheet proved DELETED is now refused too.
 * `proveBoundSheetIsAlive` explains what it can and cannot decide with the ports a host exposes.
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
    if (owned) {
      // OWNED, BUT IS IT STILL THERE? The registry never forgets a deleted sheet, so ownership alone
      // would keep pointing operators at a table that was dropped. `'unprovable'` keeps the answer
      // this path already gave (a hand-bound sheet's liveness cannot be decided with today's ports —
      // see the helper); `'deleted'` is a hard refusal.
      const liveness = await proveBoundSheetIsAlive(provisioning, stagingProjectId, boundSheetId, objectId)
      if (liveness === 'deleted') return null
      return { sheetId: boundSheetId, objectId }
    }
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
 * The logical view id the plugin's own default-view provisioning creates
 * (`ensureManagedTableDefaultView` -> host `ensureObjectDefaultView` -> `DEFAULT_OBJECT_VIEW_LOGICAL_ID`).
 * Kept as a constant rather than inlined so the two stay greppable together.
 */
const STOCK_PREPARATION_FILL_VIEW_LOGICAL_ID = 'default'

/**
 * THE DEEP-LINK HANDLE — `{ sheetId, viewId }` for the 备料主表 — or null.
 *
 * IT LIVES HERE, BESIDE `resolveOwnBoundSheet`, BECAUSE TWO READS NOW HAND IT OUT: 项目备料页's board
 * (which has always returned it) and the operator DIRECTORY (this pass, so the workbench's
 * 「打开备料多维表」 lands on the right sheet before any project has been opened). It was defined in
 * stock-preparation-project-board.cjs until the second caller appeared; it MOVED rather than being
 * copied, because two implementations of "which sheet may this caller be pointed at" are exactly the
 * pair that drifts. The board still re-exports it under `__internals`, so its suite addresses it
 * where it always did.
 *
 * IT IS NOT A PERMISSION DECISION and must never be read as one. This plugin has no user-aware
 * multitable ACL seam: every read here runs on the service-account records API with the plugin's own
 * authority, and the multitable ACL domain is deliberately separate from `integration:*` /
 * `stock-prep:*`. So the plugin CANNOT pre-check whether this operator may open that sheet, and does
 * not pretend to. Multitable enforces access when the operator lands.
 *
 * THE TENANT GATE IS `resolveOwnBoundSheet`'s, AND IT IS THE WHOLE SAFETY STORY. `ownSheet` is
 * non-null only when the caller's OWN staging project is proved to own the bound sheet, so this
 * function adds no new way to name a sheet: it takes an already-proved sheet or it returns null.
 * `getObjectViewId` is a pure deterministic id derivation on the host side, treated as an OPTIONAL
 * capability so a plugin newer than its host degrades to "no handle" rather than erroring — and it
 * costs NO IO, which is why a caller that already resolved `ownSheet` pays nothing for the handle.
 *
 * `viewId` is the id the plugin's own default-view provisioning uses. If a deployment's table carries
 * hand-made views instead, the workbench falls back to the sheet's first view
 * (useMultitableWorkbench's `preferredViewId` fold), so the handle degrades to "open this sheet"
 * rather than breaking.
 */
async function resolveFillTarget(provisioning, ownSheet, stagingProjectId) {
  if (!ownSheet) return null
  if (typeof provisioning.getObjectViewId !== 'function') return null
  const viewId = provisioning.getObjectViewId(stagingProjectId, ownSheet.objectId, STOCK_PREPARATION_FILL_VIEW_LOGICAL_ID)
  if (typeof viewId !== 'string' || viewId.length === 0) return null
  return { sheetId: ownSheet.sheetId, viewId }
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
 * @param {string|symbol} narrowing  a non-empty project number FILTERS the scan to that project (the
 *                                 board's read); `SCAN_WHOLE_SHEET` walks and groups the whole sheet
 *                                 (the directory's). Anything else reads nothing — see the sentinel.
 * @param {object} [options.cache]  a `createPullTargetScanCache()`, or nothing for an uncached scan.
 *
 * @returns {Promise<{ready:boolean, failed:boolean, bounded:boolean, byProjectNo:Map,
 *                    rowCount:number, activeRowCount:number, lastChangedFromPlmAtMs:number|null}>}
 *
 * IT DEGRADES, NEVER FAILS. A target that is not bound, not the caller's own, not provisioned, does
 * not bind the two scope columns, or whose query throws yields `ready:false` and the page says the
 * table is not ready — the same posture the fill handle already takes. A status bar (or a home page)
 * that 500s because a deployment has not finished configuring itself is a worse one.
 *
 * `failed` SEPARATES THE FOUR WAYS OF NOT BEING READY INTO THE TWO THAT MATTER TO A READER, and it
 * exists because collapsing them produced a response that contradicted itself. It is true ONLY for a
 * scan that started and then broke mid-flight — a page that came back as a non-array, or a query
 * that threw — and false for every state where nothing was read in the first place: no target bound,
 * the target not provably the caller's own, an explicit field map that binds no scope column.
 *
 * The distinction is load-bearing rather than decorative. On a mid-flight break the project numbers
 * found on the pages already read are DISCARDED (a partial group would understate row counts and
 * could hand back a max timestamp computed over an arbitrary prefix), so the caller's union really is
 * missing pull-target projects and must say so. Nothing-was-read is the opposite case: a deployment
 * with no target bound has no pull-target projects to be missing, and a caller that flagged it as
 * incomplete would be permanently flagged — which trains every reader to ignore the flag.
 *
 * `bounded` IS THE HONESTY FLAG AND IT IS LOAD-BEARING. Past `PULL_TARGET_MAX_PAGES` the counts are
 * a floor rather than a total, the set of project numbers is a SUBSET rather than the distinct set,
 * and — the case that actually misleads — the max is computed over a PREFIX of an UNORDERED page
 * scan, so rows past the bound may carry a NEWER `lastPlmRefreshAt` than anything seen. Callers must
 * report `lastChangedFromPlmAt: null` when `bounded` is true rather than a number that could quietly
 * understate freshness; that is the "cron ran fine, the page just says it looks stale" failure this
 * whole flag exists to head off.
 */
function notScanned(failed) {
  return {
    ready: false,
    failed,
    bounded: false,
    byProjectNo: new Map(),
    rowCount: 0,
    activeRowCount: 0,
    lastChangedFromPlmAtMs: null,
  }
}

async function scanPullTargetProjects(recordsApi, ownSheet, boundTarget, narrowing, options = {}) {
  if (!ownSheet) return notScanned(false)
  if (!recordsApi || typeof recordsApi.queryRecords !== 'function') return notScanned(false)

  const bindings = resolvePullTargetBindings(boundTarget)
  if (!bindings) return notScanned(false)

  // THE TWO READS, NAMED. `SCAN_WHOLE_SHEET` is the directory's; a non-empty string is the board's.
  // A caller that supplies neither has not said which read it wants, and guessing is how a lost
  // project number turns into a whole-table scan reported as one project's numbers.
  const narrowTo = narrowing === SCAN_WHOLE_SHEET ? null : optionalString(narrowing)
  if (narrowing !== SCAN_WHOLE_SHEET && narrowTo === null) return notScanned(false)

  const cache = options && options.cache
  const run = () => runPullTargetScan(recordsApi, ownSheet, bindings, narrowTo)
  if (!cache || typeof cache.resolve !== 'function') return run()
  // The key is the (proved-own) sheet, the read, and the bindings it was read through — a rebound
  // target is a different read and must not be answered from the old one's window.
  return cache.resolve(JSON.stringify([ownSheet.sheetId, narrowTo, bindings]), run)
}

async function runPullTargetScan(recordsApi, ownSheet, bindings, narrowTo) {
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
      // A MID-FLIGHT BREAK, both here and in the catch below: `failed: true`, and everything found so
      // far is dropped rather than returned as if it were the whole answer.
      if (!Array.isArray(pageRows)) return notScanned(true)
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
    return notScanned(true)
  }

  return { ready: true, failed: false, bounded, byProjectNo, rowCount, activeRowCount, lastChangedFromPlmAtMs }
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
 *
 * `projectNo` IS REQUIRED AND IS NEVER A WHOLE-SHEET READ. This projection is about ONE project, so
 * an empty or non-string number is a caller bug, and the scan's sentinel rule turns it into "not
 * ready" rather than into the whole sheet's counts reported under one project's name. 项目备料页
 * validates the number well before this (`STOCK_PREPARATION_PROJECT_BOARD_REQUEST_INVALID`), so the
 * board reaches this with a real number on every live path and its behaviour is unchanged.
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
  PULL_TARGET_SCAN_CACHE_MAX_ENTRIES,
  PULL_TARGET_SCAN_CACHE_TTL_MS,
  SCAN_WHOLE_SHEET,
  STOCK_PREPARATION_FILL_OBJECT_ID,
  STOCK_PREPARATION_FILL_VIEW_LOGICAL_ID,
  createPullTargetScanCache,
  parsePlmRefreshTimestampMs,
  proveBoundSheetIsAlive,
  readPullTargetRowFacts,
  resolveFillTarget,
  resolveOwnBoundSheet,
  resolvePullTargetBindings,
  scanPullTargetProjects,
}
