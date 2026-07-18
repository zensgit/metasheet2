'use strict'

// #3751 stock-prep MVP — READONLY snapshot-batch LIST + DIFF read endpoints (backs FE view 2,
// "BOM Snapshot Batch & Diff"; contract = apps/web/src/services/integration/stockPreparation/
// bomSnapshotDiff.ts).
//
// This module READS the internal, MetaSheet-provisioned MVP tables (bom_snapshot_batch /
// bom_snapshot_line / run_record / exception_confirmation) through the multitable RECORDS api and
// returns the values-free summary shapes the FE declares. It is structurally READ-ONLY:
//   - it calls ONLY recordsApi.queryRecords — never createRecord / patchRecord / delete,
//   - it never reads PLM and never touches K3 / ERP / any external system / SQL / fetch / HTTP,
//   - every read target objectId is asserted to be a member of the FROZEN MVP object-id set,
//   - it is admin-gated (fail-closed) and returns only counts / status enums / internal MetaSheet
//     handles (snapshotBatchId / baseSnapshotBatchId / syncRunId / projectId) / booleans — never a
//     drawing number, quantity, unit, path key, version, or fingerprint value.
// (The forbidden-write tokens named in this header appear ONLY here, in prose, to document the
// boundary — never as code.)
//
// PROJECT-SCOPE SPLIT (load-bearing): the MVP tables are provisioned under the INTERNAL STAGING
// project (`${tenantId}:integration-core`, via resolveIntegrationStagingProjectId in the route), NOT
// under the business project. So a read uses TWO distinct project ids:
//   - `targetProjectId`   locates the provisioned sheet   -> findObjectSheet({ projectId: targetProjectId, ... })
//   - `businessProjectId` filters/echoes the PLM project   -> queryRecords filters { projectId: businessProjectId }
// Passing the business project to findObjectSheet would fail to find the tables (a real bug).

const {
  STOCK_PREPARATION_MVP_TABLE_TEMPLATES,
  STOCK_PREPARATION_MVP_REQUIRED_OBJECT_IDS,
} = require('./stock-preparation-templates.cjs')
const { planBomSnapshotDiff, CHANGE_TYPES, DIFF_TYPES, REVIEW_STATUSES } = require('./stock-preparation-snapshot-diff.cjs')
const { optionalString, isPlainObject } = require('./stock-preparation-common.cjs')
const { createTargetScopedRecordsApi } = require('./stock-preparation-table-actions.cjs')
const {
  StockPreparationTargetProvisioningError,
  __internals: { assertAdminPermission },
} = require('./stock-preparation-target-provisioning.cjs')

// Bounded pagination for the readonly scans. A single frozen MVP snapshot batch / line set is small;
// these bounds only guard against an unexpectedly huge sheet (fail closed rather than scan forever).
const READ_PAGE_LIMIT = 500
const READ_MAX_PAGES = 50

// Design-grounded blocking marker (docs/development/stock-preparation-mvp-design-20260707.md §8:
// exception `severity` ∈ {info, warning, blocking}; the generation engine emits severity 'blocking').
// This is a READ of a stored enum value, not an invented rule.
const BLOCKING_EXCEPTION_SEVERITY = 'blocking'

// planBomSnapshotDiff requires a non-empty previousSnapshotBatchId. When a batch has no immutable
// predecessor we still diff its lines against an EMPTY prior (every current line surfaces as `added`),
// so we pass this sentinel purely to satisfy the engine — it only ever rides the engine's internal
// diffId hashing / values-free evidence booleans and NEVER appears in the returned summary.
const NO_PREDECESSOR_SENTINEL = 'stockprep_no_predecessor'

function templateByRole(role) {
  const template = STOCK_PREPARATION_MVP_TABLE_TEMPLATES.find((entry) => entry.role === role)
  if (!template) {
    throw new StockPreparationTargetProvisioningError(
      500,
      'SNAPSHOT_READS_TEMPLATE_MISSING',
      `frozen MVP template for role ${role} is missing`,
      { role },
    )
  }
  return template
}

// Object-id constants come straight from the FROZEN MVP templates (never a hardcoded string), so a
// read target can only ever be one of the provisioned MVP tables.
const BATCH_OBJECT_ID = templateByRole('bom_snapshot_batch').objectId
const LINE_OBJECT_ID = templateByRole('bom_snapshot_line').objectId
const RUN_OBJECT_ID = templateByRole('run_record').objectId
const EXCEPTION_OBJECT_ID = templateByRole('exception_confirmation').objectId
const MVP_OBJECT_ID_SET = new Set(STOCK_PREPARATION_MVP_REQUIRED_OBJECT_IDS)

function requiredString(value, field) {
  const normalized = optionalString(value)
  if (!normalized) {
    throw new StockPreparationTargetProvisioningError(422, 'SNAPSHOT_READS_CONFIG_INVALID', `${field} is required`, { field })
  }
  return normalized
}

// Fail closed if a read target is not a frozen MVP objectId (a mutation that swapped the target away
// from the MVP set is killed here rather than reading an arbitrary sheet).
function assertMvpObjectId(objectId) {
  if (!MVP_OBJECT_ID_SET.has(objectId)) {
    throw new StockPreparationTargetProvisioningError(
      500,
      'SNAPSHOT_READS_OBJECT_ID_NOT_MVP',
      'snapshot read target objectId is not a frozen stock-preparation MVP table',
      { objectId },
    )
  }
  return objectId
}

// READONLY records-api guard: only queryRecords is required (no write methods are needed or used).
function ensureReadOnlyRecordsApi(recordsApi) {
  if (!recordsApi || typeof recordsApi.queryRecords !== 'function') {
    throw new StockPreparationTargetProvisioningError(
      501,
      'SNAPSHOT_READS_RECORDS_API_UNAVAILABLE',
      'stock-preparation snapshot reads require multitable.records.queryRecords',
      { requiredMethods: ['queryRecords'] },
    )
  }
  return recordsApi
}

// #4160: resolveFieldIds is REQUIRED — a read is as fieldId-bound as a write. The records service
// rejects a logical filter key ('Unknown fieldId') and returns rows keyed by PHYSICAL fieldId, so a
// read that skips the translation silently reports every cell as undefined.
function ensureProvisioningApi(provisioning) {
  if (!provisioning || typeof provisioning.findObjectSheet !== 'function' || typeof provisioning.resolveFieldIds !== 'function') {
    throw new StockPreparationTargetProvisioningError(
      501,
      'SNAPSHOT_READS_PROVISIONING_API_UNAVAILABLE',
      'stock-preparation snapshot reads require multitable.provisioning findObjectSheet/resolveFieldIds',
      { requiredMethods: ['findObjectSheet', 'resolveFieldIds'] },
    )
  }
  return provisioning
}

// Records may arrive as { data: {...} } or as a flat object; read the logical cell from whichever
// carries it (mirrors the table-action reader idiom).
function recordData(record) {
  if (isPlainObject(record) && isPlainObject(record.data)) return record.data
  return isPlainObject(record) ? record : {}
}

function readCell(record, key) {
  return recordData(record)[key]
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

// Locate a frozen MVP sheet by objectId (asserting the objectId is in the MVP set first), using the
// STAGING targetProjectId. Returns a READ-ONLY target-scoped records API bound to that sheet AND to
// its logical->physical fieldId map (#4160 — every read goes through the one translating entry point,
// so this module keeps filtering and reading by the frozen templates' logical keys), or null when the
// internal table has not been provisioned yet (tables may be empty — callers degrade gracefully).
async function findMvpSheet(recordsApi, provisioning, targetProjectId, objectId) {
  assertMvpObjectId(objectId)
  const sheet = await provisioning.findObjectSheet({ projectId: targetProjectId, objectId })
  const sheetId = sheet && sheet.id ? sheet.id : null
  if (!sheetId) return null
  const scoped = await createTargetScopedRecordsApi(recordsApi, { sheetId, objectId }, {
    provisioning,
    projectId: targetProjectId,
    readOnly: true,
  })
  return { id: sheetId, scoped }
}

// Bounded readonly scan: page queryRecords until a short page (last page) or the page bound is hit.
// `target` is a findMvpSheet result — the scoped, field-mapped API; filters/rows stay logical.
async function queryAllRecords(target, filters) {
  const rows = []
  for (let page = 0; page < READ_MAX_PAGES; page += 1) {
    const pageRows = await target.scoped.queryRecords({
      filters,
      limit: READ_PAGE_LIMIT,
      offset: page * READ_PAGE_LIMIT,
    })
    if (!Array.isArray(pageRows)) {
      throw new StockPreparationTargetProvisioningError(
        500,
        'SNAPSHOT_READS_RECORDS_API_INVALID',
        'queryRecords must return an array',
        { sheetId: target.id },
      )
    }
    rows.push(...pageRows)
    if (pageRows.length < READ_PAGE_LIMIT) return rows
  }
  throw new StockPreparationTargetProvisioningError(
    422,
    'SNAPSHOT_READS_RESULT_TOO_LARGE',
    'stock-preparation snapshot read exceeded the page bound',
    { maxPages: READ_MAX_PAGES },
  )
}

// A batch is `incomplete` when the multi-step persist path (batch row -> lines -> run row) did not
// finish: zero lines OR no matching run row. A batch row alone is NOT proof of completeness — an
// orphaned batch (crash mid-commit) must not be presented as normal.
// This single structural predicate backs BOTH the list's `incomplete` flag and the H-1 diff gate
// (assertDiffBatchComplete below) — one definition of completeness, not two drifting copies.
function isBatchIncomplete(lineCount, runPresent) {
  return lineCount === 0 || runPresent !== true
}

function batchSummary(batchRecord, lineCount, runPresent) {
  return {
    snapshotBatchId: optionalString(readCell(batchRecord, 'snapshotBatchId')),
    snapshotVersion: toNumber(readCell(batchRecord, 'snapshotVersion')) || 0,
    snapshotStatus: optionalString(readCell(batchRecord, 'snapshotStatus')),
    syncRunId: optionalString(readCell(batchRecord, 'syncRunId')),
    lineCount,
    // Presence of the createdAt stamp only — never the timestamp value itself (values-free).
    createdAtPresent: optionalString(readCell(batchRecord, 'createdAt')) !== null,
    incomplete: isBatchIncomplete(lineCount, runPresent),
  }
}

// Deterministic newest-first ordering (highest snapshotVersion first; snapshotBatchId breaks ties).
function orderBatches(summaries) {
  return summaries.slice().sort((left, right) => {
    if (right.snapshotVersion !== left.snapshotVersion) return right.snapshotVersion - left.snapshotVersion
    return String(left.snapshotBatchId || '').localeCompare(String(right.snapshotBatchId || ''))
  })
}

/**
 * List the immutable BOM snapshot batches for a (business) project.
 * `targetProjectId`   — STAGING project the MVP tables were provisioned under (locates the sheets).
 * `businessProjectId` — PLM business project id; FILTERS the batch rows and is ECHOED back.
 * Empty / unprovisioned batch sheet => { projectId, batchCount: 0, batches: [] }.
 */
async function listSnapshotBatches({ recordsApi, provisioning, targetProjectId, businessProjectId, permission } = {}) {
  assertAdminPermission(permission)
  const api = ensureReadOnlyRecordsApi(recordsApi)
  const prov = ensureProvisioningApi(provisioning)
  const stagingProjectId = requiredString(targetProjectId, 'targetProjectId')
  const projectId = requiredString(businessProjectId, 'businessProjectId')

  const batchSheet = await findMvpSheet(api, prov, stagingProjectId, BATCH_OBJECT_ID)
  if (!batchSheet) {
    return { projectId, batchCount: 0, batches: [] }
  }
  const lineSheet = await findMvpSheet(api, prov, stagingProjectId, LINE_OBJECT_ID)
  const runSheet = await findMvpSheet(api, prov, stagingProjectId, RUN_OBJECT_ID)

  const batchRows = await queryAllRecords(batchSheet, { projectId })
  const summaries = []
  for (const batchRow of batchRows) {
    const snapshotBatchId = optionalString(readCell(batchRow, 'snapshotBatchId'))
    const syncRunId = optionalString(readCell(batchRow, 'syncRunId'))
    let lineCount = 0
    if (lineSheet && snapshotBatchId) {
      const lineRows = await queryAllRecords(lineSheet, { snapshotBatchId })
      lineCount = lineRows.length
    }
    let runPresent = false
    if (runSheet && syncRunId) {
      const runRows = await queryAllRecords(runSheet, { runId: syncRunId })
      runPresent = runRows.length > 0
    }
    summaries.push(batchSummary(batchRow, lineCount, runPresent))
  }
  const batches = orderBatches(summaries)
  return { projectId, batchCount: batches.length, batches }
}

function changeCountsFromEvidence(diff) {
  const byChangeType = (diff && diff.evidence && diff.evidence.result && diff.evidence.result.byChangeType) || {}
  return {
    added: byChangeType[CHANGE_TYPES.ADDED] || 0,
    removed: byChangeType[CHANGE_TYPES.REMOVED] || 0,
    quantityChanged: byChangeType[CHANGE_TYPES.QUANTITY_CHANGED] || 0,
    unitChanged: byChangeType[CHANGE_TYPES.UNIT_CHANGED] || 0,
    versionChanged: byChangeType[CHANGE_TYPES.VERSION_CHANGED] || 0,
    pathChanged: byChangeType[CHANGE_TYPES.PATH_CHANGED] || 0,
    missingChildBom: byChangeType[CHANGE_TYPES.MISSING_CHILD_BOM] || 0,
    fingerprintChanged: byChangeType[CHANGE_TYPES.SOURCE_FINGERPRINT_CHANGED] || 0,
  }
}

// Predecessor rule: the batch (same business project) with the HIGHEST snapshotVersion strictly LESS
// than the current batch's version. null when the current version is unknown or nothing precedes it.
// Round-5: when the highest predecessor version is carried by MORE THAN ONE distinct snapshotBatchId
// (the substrate has no logical unique index and P4 is not landed — concurrent writers can produce
// such history), the auto-pick would otherwise depend on database return order. That is refused loud
// as 409 {target:'base', reason:'ambiguous'}; an EXPLICIT base keeps the existing rules (the caller
// named one specific batch).
function pickPredecessor(batchRows, currentSnapshotBatchId, currentVersion) {
  if (currentVersion === null) return null
  let bestVersion = null
  let bestIds = new Set()
  for (const row of batchRows) {
    const snapshotBatchId = optionalString(readCell(row, 'snapshotBatchId'))
    if (!snapshotBatchId || snapshotBatchId === currentSnapshotBatchId) continue
    const version = toNumber(readCell(row, 'snapshotVersion'))
    if (version === null || version >= currentVersion) continue
    if (bestVersion === null || version > bestVersion) {
      bestVersion = version
      bestIds = new Set([snapshotBatchId])
    } else if (version === bestVersion) {
      bestIds.add(snapshotBatchId)
    }
  }
  if (bestIds.size === 0) return null
  if (bestIds.size > 1) diffBatchAmbiguous('base')
  return bestIds.values().next().value
}

// Resolve the diff BASE batch id. An EXPLICIT `requestedBase` is a caller-chosen pair and must be
// validated (differ from current -> 400; exist -> 404; same business project -> 409). Without it the
// predecessor rule applies unchanged (highest version strictly below current, same business project).
async function resolveDiffBase(api, batchSheet, { currentSnapshotBatchId, projectId, currentVersion, requestedBase, currentBatchRowPresent }) {
  if (requestedBase) {
    // P2-A1 (review #4019): a caller-chosen pair is only verifiable when the DIFFED batch row exists.
    // Without this gate a ghost/stale current id skips the project-mismatch check entirely (projectId
    // is empty) and another project's rows would surface as a fabricated all-removed diff.
    if (!currentBatchRowPresent) {
      throw new StockPreparationTargetProvisioningError(404, 'SNAPSHOT_DIFF_BASE_NOT_FOUND', 'a caller-chosen base pair requires an existing diffed batch', { field: 'snapshotBatchId' })
    }
    if (requestedBase === currentSnapshotBatchId) {
      throw new StockPreparationTargetProvisioningError(400, 'SNAPSHOT_DIFF_BASE_INVALID', 'baseSnapshotBatchId must differ from the diffed batch', { field: 'baseSnapshotBatchId' })
    }
    const baseRows = batchSheet ? await queryAllRecords(batchSheet, { snapshotBatchId: requestedBase }) : []
    // Round-4: the ambiguity check MUST precede any [0] read — with duplicate base identities the
    // outcome otherwise depended on database return order (first-twin project match vs mismatch).
    if (baseRows.length > 1) diffBatchAmbiguous('base')
    const baseRow = baseRows[0] || null
    if (!baseRow) {
      throw new StockPreparationTargetProvisioningError(404, 'SNAPSHOT_DIFF_BASE_NOT_FOUND', 'base snapshot batch was not found', { field: 'baseSnapshotBatchId' })
    }
    const baseProjectId = optionalString(readCell(baseRow, 'projectId'))
    if (projectId && baseProjectId && baseProjectId !== projectId) {
      throw new StockPreparationTargetProvisioningError(409, 'SNAPSHOT_DIFF_BASE_PROJECT_MISMATCH', 'base snapshot batch belongs to a different business project', { field: 'baseSnapshotBatchId' })
    }
    return requestedBase
  }
  if (batchSheet && projectId) {
    const projectBatchRows = await queryAllRecords(batchSheet, { projectId })
    return pickPredecessor(projectBatchRows, currentSnapshotBatchId, currentVersion)
  }
  return null
}

// H-1 (P4 design-lock #4452, round-1 owner ruling): SERVER-SIDE diff completeness gate. The FE only
// DISABLES the diff entry for an incomplete batch (list `incomplete` flag); a deep link or a
// list-vs-diff race can still reach the diff endpoints directly, where an incomplete CURRENT serves a
// silently partial diff and a 0-line orphan BASE fabricates an all-'added' diff. So after base
// resolution BOTH sides are verified against the SAME structural predicate the list uses
// (isBatchIncomplete: at least one line AND the run row named by the batch row's syncRunId exists) and
// any incomplete side fails LOUD: 409 SNAPSHOT_DIFF_BATCH_INCOMPLETE. This applies to the AUTO-picked
// predecessor too — silently skipping past an incomplete predecessor to an older complete batch would
// silently change the diff result; the lock chose loud-409 over silent-skip.
// `batchRow` null (a base row that vanished between resolution and the gate) fails closed the same
// way: no row -> no verifiable run link -> incomplete. An absent RUN sheet likewise leaves runPresent
// false (exactly the list path's semantics).
// The details shape is CLOSED and values-free: ONLY { target: 'current'|'base', reason: 'incomplete' }
// — no counts, no ids; the message is a fixed values-free string.
function diffBatchAmbiguous(target) {
  // Round-3: duplicate business identities (no substrate unique index; concurrent writers can
  // produce them — P4 lock §0.3) mean "pick rows[0]" would silently answer from an arbitrary twin.
  throw new StockPreparationTargetProvisioningError(
    409,
    'SNAPSHOT_DIFF_BATCH_INCOMPLETE',
    'snapshot diff refuses an ambiguous snapshot batch identity',
    { target, reason: 'ambiguous' },
  )
}

async function assertDiffBatchComplete({ lineSheet, runSheet, batchRow, snapshotBatchId, target }) {
  const lineRows = lineSheet ? await queryAllRecords(lineSheet, { snapshotBatchId }) : []
  const syncRunId = optionalString(readCell(batchRow, 'syncRunId'))
  let runPresent = false
  if (runSheet && syncRunId) {
    const runRows = await queryAllRecords(runSheet, { runId: syncRunId })
    // Exactly-one run identity: duplicates are as unanswerable as absence (round-3).
    if (runRows.length > 1) diffBatchAmbiguous(target)
    runPresent = runRows.length > 0
  }
  if (isBatchIncomplete(lineRows.length, runPresent)) {
    throw new StockPreparationTargetProvisioningError(
      409,
      'SNAPSHOT_DIFF_BATCH_INCOMPLETE',
      'snapshot diff refuses an incomplete snapshot batch',
      { target, reason: 'incomplete' },
    )
  }
}

/**
 * Values-free diff of a snapshot batch against its immutable predecessor batch.
 * The batch id arrives from the route PATH. `targetProjectId` (STAGING) locates the MVP tables; the
 * business project used to scope the predecessor search is read from the current batch row itself (the
 * FE diff call carries no projectId), falling back to `businessProjectId` when the batch row is absent.
 * An optional `baseSnapshotBatchId` overrides the predecessor auto-pick with a validated caller-chosen
 * pair; when absent the original predecessor semantics are preserved unchanged.
 * H-1: both sides are completeness-gated after base resolution — an incomplete current or base
 * (explicit OR auto-picked) fails loud with 409 SNAPSHOT_DIFF_BATCH_INCOMPLETE, never a partial diff.
 */
async function getSnapshotDiff({ recordsApi, provisioning, targetProjectId, businessProjectId, snapshotBatchId, baseSnapshotBatchId: baseOverride, permission } = {}) {
  assertAdminPermission(permission)
  const api = ensureReadOnlyRecordsApi(recordsApi)
  const prov = ensureProvisioningApi(provisioning)
  const currentSnapshotBatchId = requiredString(snapshotBatchId, 'snapshotBatchId')
  const stagingProjectId = requiredString(targetProjectId, 'targetProjectId')
  const requestedBase = optionalString(baseOverride)

  const batchSheet = await findMvpSheet(api, prov, stagingProjectId, BATCH_OBJECT_ID)
  const lineSheet = await findMvpSheet(api, prov, stagingProjectId, LINE_OBJECT_ID)
  const exceptionSheet = await findMvpSheet(api, prov, stagingProjectId, EXCEPTION_OBJECT_ID)

  if (!batchSheet && !lineSheet && !exceptionSheet) {
    // An explicit base cannot be verified against an unprovisioned substrate — fail closed instead of
    // silently answering with the empty-diff shape.
    if (requestedBase) {
      throw new StockPreparationTargetProvisioningError(404, 'SNAPSHOT_DIFF_BASE_NOT_FOUND', 'base snapshot batch was not found', { field: 'baseSnapshotBatchId' })
    }
    return {
      snapshotBatchId: currentSnapshotBatchId,
      baseSnapshotBatchId: null,
      changeCounts: changeCountsFromEvidence(null),
      blockingExceptionCount: 0,
    }
  }

  // Current batch row (locates the business project + current snapshot version).
  let currentBatchRow = null
  let projectId = optionalString(businessProjectId)
  let currentVersion = null
  if (batchSheet) {
    const currentRows = await queryAllRecords(batchSheet, { snapshotBatchId: currentSnapshotBatchId })
    if (currentRows.length > 1) diffBatchAmbiguous('current')
    currentBatchRow = currentRows[0] || null
    if (currentBatchRow) {
      projectId = optionalString(readCell(currentBatchRow, 'projectId')) || projectId
      currentVersion = toNumber(readCell(currentBatchRow, 'snapshotVersion'))
    }
  }

  const baseSnapshotBatchId = await resolveDiffBase(api, batchSheet, {
    currentSnapshotBatchId,
    projectId,
    currentVersion,
    requestedBase,
    currentBatchRowPresent: Boolean(currentBatchRow),
  })

  // H-1 completeness gate — AFTER base resolution (explicit-base validation errors keep precedence),
  // BEFORE any diff is computed. Runs only when the current batch ROW exists: a ghost current keeps
  // the #4002 graceful empty shape on the auto path (locked by the existing ghost test) and already
  // 404s on the explicit-base path inside resolveDiffBase.
  const runSheet = await findMvpSheet(api, prov, stagingProjectId, RUN_OBJECT_ID)
  if (currentBatchRow) {
    await assertDiffBatchComplete({
      lineSheet,
      runSheet,
      batchRow: currentBatchRow,
      snapshotBatchId: currentSnapshotBatchId,
      target: 'current',
    })
  }
  if (baseSnapshotBatchId) {
    const baseRows = batchSheet ? await queryAllRecords(batchSheet, { snapshotBatchId: baseSnapshotBatchId }) : []
    if (baseRows.length > 1) diffBatchAmbiguous('base')
    await assertDiffBatchComplete({
      lineSheet,
      runSheet,
      batchRow: baseRows[0] || null,
      snapshotBatchId: baseSnapshotBatchId,
      target: 'base',
    })
  }

  // Lines for the current + predecessor batches (never mutated; passed straight to the diff engine).
  const currentLines = lineSheet
    ? (await queryAllRecords(lineSheet, { snapshotBatchId: currentSnapshotBatchId })).map(recordData)
    : []
  // H-1 round-2 residual: a GHOST current (no batch row) whose id still has orphan LINE rows would
  // otherwise serve a fabricated all-'added' diff with no gate (the row-conditioned gate above
  // skipped, auto base null). Genuinely empty ghost ids keep the #4002 graceful shape.
  if (!currentBatchRow && currentLines.length > 0) {
    throw new StockPreparationTargetProvisioningError(
      409,
      'SNAPSHOT_DIFF_BATCH_INCOMPLETE',
      'snapshot diff refuses an incomplete snapshot batch',
      { target: 'current', reason: 'incomplete' },
    )
  }
  const previousLines = lineSheet && baseSnapshotBatchId
    ? (await queryAllRecords(lineSheet, { snapshotBatchId: baseSnapshotBatchId })).map(recordData)
    : []

  const diff = planBomSnapshotDiff({
    previousSnapshotBatchId: baseSnapshotBatchId || NO_PREDECESSOR_SENTINEL,
    currentSnapshotBatchId,
    previousLines,
    currentLines,
  })

  // blockingExceptionCount = exception rows linked to THIS batch (via the exception template's
  // snapshotBatchId link field) whose stored severity is 'blocking'. No status filtering (see the
  // Open-Decision noted in the PR): a resolved-but-blocking-severity row is still counted here.
  let blockingExceptionCount = 0
  if (exceptionSheet) {
    const exceptionRows = await queryAllRecords(exceptionSheet, { snapshotBatchId: currentSnapshotBatchId })
    for (const row of exceptionRows) {
      if (optionalString(readCell(row, 'severity')) === BLOCKING_EXCEPTION_SEVERITY) blockingExceptionCount += 1
    }
  }

  return {
    snapshotBatchId: currentSnapshotBatchId,
    baseSnapshotBatchId,
    changeCounts: changeCountsFromEvidence(diff),
    blockingExceptionCount,
  }
}

// Per-row projection whitelist: EXACTLY the engine's values-free diff-row keys. makeDiff's output is
// already values-free (handles + sha16 fingerprints + enums), but projecting through this closed list
// means a FUTURE engine key can never leak through this route unreviewed.
const DIFF_ROW_KEYS = Object.freeze([
  'diffId',
  'diffType',
  'reviewStatus',
  'changeTypes',
  'reason',
  'rowCount',
  'previousSnapshotLineId',
  'currentSnapshotLineId',
  'keyFingerprint',
  'previousPathKeyFingerprint',
  'currentPathKeyFingerprint',
])
const MAX_DIFF_ROWS = 2000
const REVIEW_STATUS_VALUES = new Set(Object.values(REVIEW_STATUSES))
const DIFF_TYPE_VALUES = new Set(Object.values(DIFF_TYPES))

function projectDiffRow(diff) {
  const out = {}
  for (const key of DIFF_ROW_KEYS) {
    const value = diff ? diff[key] : undefined
    if (value !== undefined) out[key] = Array.isArray(value) ? value.slice() : value
  }
  return out
}

/**
 * Values-free PER-ROW diff of a snapshot batch (view 2's row browse: diffType / changeTypes /
 * reviewStatus per diff row). Same read flow + base semantics as getSnapshotDiff; each row passes the
 * closed DIFF_ROW_KEYS projection; optional reviewStatus / diffType filters; result capped fail-closed.
 * `heldRowCount` counts held rows over the WHOLE pair (pre-filter) so a filtered read keeps context.
 */
async function listSnapshotDiffRows({ recordsApi, provisioning, targetProjectId, businessProjectId, snapshotBatchId, baseSnapshotBatchId: baseOverride, reviewStatus, diffType, permission } = {}) {
  assertAdminPermission(permission)
  const api = ensureReadOnlyRecordsApi(recordsApi)
  const prov = ensureProvisioningApi(provisioning)
  const currentSnapshotBatchId = requiredString(snapshotBatchId, 'snapshotBatchId')
  const stagingProjectId = requiredString(targetProjectId, 'targetProjectId')
  const requestedBase = optionalString(baseOverride)
  // Belt-and-braces enum gates (the route allowlist rejects these first with its own 400 code).
  const reviewStatusFilter = optionalString(reviewStatus)
  if (reviewStatusFilter && !REVIEW_STATUS_VALUES.has(reviewStatusFilter)) {
    throw new StockPreparationTargetProvisioningError(422, 'SNAPSHOT_READS_CONFIG_INVALID', 'reviewStatus must be one of the review-status vocabulary', { field: 'reviewStatus' })
  }
  const diffTypeFilter = optionalString(diffType)
  if (diffTypeFilter && !DIFF_TYPE_VALUES.has(diffTypeFilter)) {
    throw new StockPreparationTargetProvisioningError(422, 'SNAPSHOT_READS_CONFIG_INVALID', 'diffType must be one of the diff-type vocabulary', { field: 'diffType' })
  }

  const batchSheet = await findMvpSheet(api, prov, stagingProjectId, BATCH_OBJECT_ID)
  const lineSheet = await findMvpSheet(api, prov, stagingProjectId, LINE_OBJECT_ID)

  if (!batchSheet && !lineSheet) {
    if (requestedBase) {
      throw new StockPreparationTargetProvisioningError(404, 'SNAPSHOT_DIFF_BASE_NOT_FOUND', 'base snapshot batch was not found', { field: 'baseSnapshotBatchId' })
    }
    return { snapshotBatchId: currentSnapshotBatchId, baseSnapshotBatchId: null, rowCount: 0, heldRowCount: 0, rows: [] }
  }

  let projectId = optionalString(businessProjectId)
  let currentVersion = null
  let currentBatchRow = null
  if (batchSheet) {
    const currentRows = await queryAllRecords(batchSheet, { snapshotBatchId: currentSnapshotBatchId })
    if (currentRows.length > 1) diffBatchAmbiguous('current')
    currentBatchRow = currentRows[0] || null
    if (currentBatchRow) {
      projectId = optionalString(readCell(currentBatchRow, 'projectId')) || projectId
      currentVersion = toNumber(readCell(currentBatchRow, 'snapshotVersion'))
    }
  }

  const baseSnapshotBatchId = await resolveDiffBase(api, batchSheet, {
    currentSnapshotBatchId,
    projectId,
    currentVersion,
    requestedBase,
    currentBatchRowPresent: Boolean(currentBatchRow),
  })

  // H-1 completeness gate — identical to getSnapshotDiff's (same order, same 409, same closed
  // values-free details): the per-row browse must not answer for an incomplete side either.
  const runSheet = await findMvpSheet(api, prov, stagingProjectId, RUN_OBJECT_ID)
  if (currentBatchRow) {
    await assertDiffBatchComplete({
      lineSheet,
      runSheet,
      batchRow: currentBatchRow,
      snapshotBatchId: currentSnapshotBatchId,
      target: 'current',
    })
  }
  if (baseSnapshotBatchId) {
    const baseRows = batchSheet ? await queryAllRecords(batchSheet, { snapshotBatchId: baseSnapshotBatchId }) : []
    if (baseRows.length > 1) diffBatchAmbiguous('base')
    await assertDiffBatchComplete({
      lineSheet,
      runSheet,
      batchRow: baseRows[0] || null,
      snapshotBatchId: baseSnapshotBatchId,
      target: 'base',
    })
  }

  const currentLines = lineSheet
    ? (await queryAllRecords(lineSheet, { snapshotBatchId: currentSnapshotBatchId })).map(recordData)
    : []
  // H-1 round-2 residual — identical to getSnapshotDiff's ghost-with-orphan-lines gate.
  if (!currentBatchRow && currentLines.length > 0) {
    throw new StockPreparationTargetProvisioningError(
      409,
      'SNAPSHOT_DIFF_BATCH_INCOMPLETE',
      'snapshot diff refuses an incomplete snapshot batch',
      { target: 'current', reason: 'incomplete' },
    )
  }
  const previousLines = lineSheet && baseSnapshotBatchId
    ? (await queryAllRecords(lineSheet, { snapshotBatchId: baseSnapshotBatchId })).map(recordData)
    : []

  const plan = planBomSnapshotDiff({
    previousSnapshotBatchId: baseSnapshotBatchId || NO_PREDECESSOR_SENTINEL,
    currentSnapshotBatchId,
    previousLines,
    currentLines,
  })

  const heldRowCount = plan.diffs.filter((diff) => diff.reviewStatus === REVIEW_STATUSES.HELD).length
  let rows = plan.diffs
  if (reviewStatusFilter) rows = rows.filter((diff) => diff.reviewStatus === reviewStatusFilter)
  if (diffTypeFilter) rows = rows.filter((diff) => diff.diffType === diffTypeFilter)
  if (rows.length > MAX_DIFF_ROWS) {
    throw new StockPreparationTargetProvisioningError(422, 'SNAPSHOT_READS_ROWS_TOO_LARGE', 'snapshot diff row read exceeded the row bound', { maxRows: MAX_DIFF_ROWS })
  }

  return {
    snapshotBatchId: currentSnapshotBatchId,
    baseSnapshotBatchId,
    rowCount: rows.length,
    heldRowCount,
    rows: rows.map(projectDiffRow),
  }
}

module.exports = {
  listSnapshotBatches,
  getSnapshotDiff,
  listSnapshotDiffRows,
  BATCH_OBJECT_ID,
  LINE_OBJECT_ID,
  RUN_OBJECT_ID,
  EXCEPTION_OBJECT_ID,
  BLOCKING_EXCEPTION_SEVERITY,
  __internals: {
    resolveDiffBase,
    projectDiffRow,
    DIFF_ROW_KEYS,
    MAX_DIFF_ROWS,
    templateByRole,
    assertMvpObjectId,
    ensureReadOnlyRecordsApi,
    ensureProvisioningApi,
    recordData,
    readCell,
    toNumber,
    queryAllRecords,
    batchSummary,
    isBatchIncomplete,
    assertDiffBatchComplete,
    orderBatches,
    changeCountsFromEvidence,
    pickPredecessor,
    NO_PREDECESSOR_SENTINEL,
    READ_PAGE_LIMIT,
    READ_MAX_PAGES,
  },
}
