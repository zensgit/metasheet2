'use strict'

// #3751 stock-prep MVP — COMMIT a previously-previewed BOM-snapshot sync-run PLAN by persisting its
// rows into the MetaSheet-INTERNAL MVP tables. This is the FIRST slice that writes business rows, so
// the safety invariants below are load-bearing.
//
// It recomputes the deterministic plan (planBomSnapshotSyncRun — the SAME body the admin previewed via
// POST /mvp/sync/plan) and writes the plan's snapshot BATCH row, its snapshot LINE rows, and the
// sync-RUN row through the records API. Every write is bound to ONE resolved MVP sheet by a
// target-scoped records API (createTargetScopedRecordsApi), so a bug can NEVER address a foreign
// sheet — internal-only is STRUCTURAL, not conventional.
//
// #4163 audit gap T1: on an actual (non-skipped) commit this ALSO upserts the PROJECT row (the table
// the FE project-workspace selector reads via GET /projects) through the SAME scoped-API mechanism —
// no new write surface. Upsert, not create-only: query by the project's key field (`projectId`) first;
// absent -> createRecord; present -> patchRecord touching ONLY `lastSyncRunId` / `lastSyncedAt` /
// `projectStatus`. The patch payload NEVER carries `owner` (human_preserved — the project's business
// owner annotation must survive every resync untouched) nor `sourceProjectNo` / `projectName` — their
// FIRST-synced value is preserved verbatim by simply never being part of the patch payload.
//
// HARD boundary:
//   - admin-gated + fail-closed: assertAdminPermission runs BEFORE any provisioning / records access.
//   - internal-only: every createRecord / queryRecords goes through a scoped API bound to a resolved
//     MVP sheet whose objectId is in the frozen 9-table set. There is NO external ERP / K3 / PLM write,
//     NO apply-writer import, NO raw SQL, and NO fetch / live HTTP I/O of any kind.
//   - idempotent + immutable: an already-persisted snapshotBatchId SKIPS the whole commit (old
//     snapshots are immutable — never patched or overwritten). Only when absent do we create rows, and
//     ONLY via createRecord — the create path never mutates an existing row (no patch / update / delete).
//     The project row is the ONE deliberate exception to "never patched" (see above) — it is a live
//     pointer (last sync run/time/status), not an immutable snapshot.
//   - values-free evidence: counts / statuses / field-key NAMES / public objectId constants / booleans
//     only — never a raw drawing number, project value, or row payload.
//
// The who/when persistence stamps (startedAt / finishedAt / createdAt / createdBy) that the plan leaves
// unset are DELIBERATELY still unset here: the closed request allowlist carries no timestamp input, the
// records service does not require them at create time, and stamping would only inject non-determinism.
// Whether a commit should stamp who/when is an owner decision, left open. (The project row's own
// `lastSyncedAt` IS stamped — a live pointer needs it and no downstream slice depends on its absence.)
// (Every boundary token named above appears ONLY in this prose header — never as code.)

const {
  planBomSnapshotSyncRun,
  StockPreparationSyncRunPlanError,
  __internals: {
    BATCH_TEMPLATE,
    LINE_TEMPLATE,
    RUN_TEMPLATE,
    BATCH_FIELD_IDS,
    LINE_FIELD_IDS,
    RUN_FIELD_IDS,
  },
} = require('./stock-preparation-sync-run-plan.cjs')
const { createTargetScopedRecordsApi } = require('./stock-preparation-table-actions.cjs')
const {
  STOCK_PREPARATION_MVP_REQUIRED_OBJECT_IDS,
  STOCK_PREPARATION_MVP_TABLE_TEMPLATES,
} = require('./stock-preparation-templates.cjs')
const { optionalString, isPlainObject } = require('./stock-preparation-common.cjs')

const REQUIRED_PERMISSION = 'admin'

// The closed set of the 9 frozen MVP objectIds — every write target MUST be a member. The batch / line
// / run objectIds and their key fields come straight from the frozen templates, so nothing is invented.
const MVP_OBJECT_ID_SET = new Set(STOCK_PREPARATION_MVP_REQUIRED_OBJECT_IDS)
const BATCH_OBJECT_ID = BATCH_TEMPLATE.objectId
const LINE_OBJECT_ID = LINE_TEMPLATE.objectId
const RUN_OBJECT_ID = RUN_TEMPLATE.objectId
const BATCH_KEY_FIELD = BATCH_TEMPLATE.keyFields[0] // 'snapshotBatchId' — the idempotency key.

// #4163 T1: the PROJECT table template — grounds the project-row upsert the SAME way BATCH/LINE/RUN are
// grounded above (frozen template, never an invented field name).
const PROJECT_TEMPLATE = STOCK_PREPARATION_MVP_TABLE_TEMPLATES.find((entry) => entry.role === 'project')
const PROJECT_OBJECT_ID = PROJECT_TEMPLATE.objectId
const PROJECT_FIELD_IDS = Object.freeze(PROJECT_TEMPLATE.fields.map((entry) => entry.id))
const PROJECT_KEY_FIELD = PROJECT_TEMPLATE.keyFields[0] // 'projectId'
// Design-grounded enum literal (docs/development/stock-preparation-mvp-design-20260707.md §"Project
// Table": project_status includes 'active'). A project that just synced is, by definition, active.
const PROJECT_STATUS_ACTIVE = 'active'

class StockPreparationSyncRunPersistError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationSyncRunPersistError'
    this.status = status
    this.code = code
    this.details = details
  }
}

// Local, self-contained admin gate (parity with the sync-run-plan / target-provisioning gates). A
// mutation that drops this call is test-killable via the 403 case. Fail-closed on any non-admin value.
function assertAdminPermission(permission) {
  if (permission !== REQUIRED_PERMISSION) {
    throw new StockPreparationSyncRunPersistError(
      403,
      'PERSIST_PERMISSION_DENIED',
      'stock-preparation sync-run persist requires admin permission',
      { requiredPermission: REQUIRED_PERMISSION },
    )
  }
}

// #4160: resolveFieldIds is REQUIRED, not optional — the scoped records API translates the frozen
// templates' logical keys to the physical fieldIds the records service actually accepts, and it
// resolves that map through this API. A provisioning facade without it fails closed here.
function ensureProvisioning(provisioning) {
  if (!provisioning || typeof provisioning.findObjectSheet !== 'function' || typeof provisioning.resolveFieldIds !== 'function') {
    throw new StockPreparationSyncRunPersistError(
      503,
      'PERSIST_PROVISIONING_API_UNAVAILABLE',
      'stock-preparation sync-run persist requires multitable.provisioning findObjectSheet/resolveFieldIds',
      { requiredMethods: ['findObjectSheet', 'resolveFieldIds'] },
    )
  }
  return provisioning
}

// Resolve ONE MVP objectId to a scoped, sheet-bound records API. objectId MUST be a frozen MVP member
// (fail closed otherwise); the sheet MUST already exist (fail closed — NEVER create a sheet here). The
// returned scoped API forces every call onto sheet.id, so a write can never leave the resolved sheet,
// and it binds the logical->physical fieldId map (resolved from the frozen template under the SAME
// staging projectId the sheet was resolved with), so every write/read speaks the ids the records
// service accepts (#4160) while this module keeps writing plain logical keys.
async function resolveScopedTarget(recordsApi, provisioning, projectId, objectId) {
  if (!MVP_OBJECT_ID_SET.has(objectId)) {
    // Defense-in-depth: the batch / line / run objectIds come from frozen templates, so this only
    // fires if the frozen set drifts — never persist to a non-MVP object.
    throw new StockPreparationSyncRunPersistError(
      500,
      'PERSIST_TARGET_OBJECT_ID_INVALID',
      'sync-run persist target objectId is not a stock-preparation MVP table',
      { objectId },
    )
  }
  const sheet = await provisioning.findObjectSheet({ projectId, objectId })
  const sheetId = optionalString(sheet && sheet.id)
  if (!sheetId) {
    throw new StockPreparationSyncRunPersistError(
      409,
      'PERSIST_TARGET_NOT_PROVISIONED',
      'stock-preparation MVP target table is not provisioned; provision the MVP tables before commit',
      { objectId },
    )
  }
  const scoped = await createTargetScopedRecordsApi(recordsApi, { sheetId, objectId }, { provisioning, projectId })
  return { objectId, sheetId, scoped }
}

// Ground a mapped snapshot line to ONLY the frozen line-template field ids (dropping null / undefined
// and any plan-internal marker such as missingChildBom). This is a CORRECTNESS requirement, not just
// hygiene: the records service rejects an unknown fieldId, so a line row may carry only declared keys.
function groundLineRow(line) {
  const out = {}
  for (const key of LINE_FIELD_IDS) {
    const value = line ? line[key] : undefined
    if (value !== undefined && value !== null) out[key] = value
  }
  return out
}

// #4163 T1 — upsert the PROJECT row: query by the key field first (never trust "it must be new"), then
// EITHER createRecord (absent) OR patchRecord (present). The patch `changes` object is a closed,
// hand-built set of exactly 3 keys — `owner` (human_preserved) and `sourceProjectNo` / `projectName`
// are STRUCTURALLY absent from it (not merely "not updated"), so a resync can never overwrite them.
// `projectName` is passthrough-only on CREATE too: it is written only when the caller actually supplied
// one — this module never invents a project name.
async function upsertStockPreparationProject({ scoped, projectId, sourceProjectNo, projectName, sourceSystem, syncRunId }) {
  const existing = await scoped.queryRecords({
    filters: { [PROJECT_KEY_FIELD]: projectId },
    limit: 2,
    offset: 0,
  })
  if (!Array.isArray(existing)) {
    throw new StockPreparationSyncRunPersistError(500, 'PERSIST_RECORDS_API_INVALID', 'queryRecords must return an array')
  }
  const lastSyncedAt = new Date().toISOString()
  if (existing.length === 0) {
    const data = {
      [PROJECT_KEY_FIELD]: projectId,
      sourceProjectNo,
      projectStatus: PROJECT_STATUS_ACTIVE,
      lastSyncRunId: syncRunId,
      lastSyncedAt,
    }
    if (projectName) data.projectName = projectName
    if (sourceSystem) data.sourceSystem = sourceSystem
    await scoped.createRecord({ data })
    return { mode: 'created' }
  }
  const recordId = existing[0] && existing[0].id
  await scoped.patchRecord({
    recordId,
    changes: {
      lastSyncRunId: syncRunId,
      lastSyncedAt,
      projectStatus: PROJECT_STATUS_ACTIVE,
    },
  })
  return { mode: 'patched' }
}

// Values-free commit evidence: counts / statuses / field-key NAMES / public objectId constants /
// booleans only. The plan rows legitimately carry business values (that is the persisted data), but
// NOTHING of that reaches this evidence — the enum literals here (draft / plm_sync / succeeded) are
// design constants, and plan.flags is a pure count/boolean summary.
function buildEvidence({ persisted, mode, created, plan, plannedLineCount, existingBatchMatched, projectSync }) {
  return {
    persisted: Boolean(persisted),
    mode,
    created: { ...created },
    plannedLineCount,
    existingBatchMatched: Boolean(existingBatchMatched),
    snapshotStatus: optionalString(plan.snapshotBatch && plan.snapshotBatch.snapshotStatus),
    runType: optionalString(plan.syncRun && plan.syncRun.runType),
    runStatus: optionalString(plan.syncRun && plan.syncRun.status),
    targets: {
      snapshotBatch: { objectId: BATCH_OBJECT_ID, fieldKeys: BATCH_FIELD_IDS.slice() },
      snapshotLine: { objectId: LINE_OBJECT_ID, fieldKeys: LINE_FIELD_IDS.slice() },
      syncRun: { objectId: RUN_OBJECT_ID, fieldKeys: RUN_FIELD_IDS.slice() },
      project: { objectId: PROJECT_OBJECT_ID, fieldKeys: PROJECT_FIELD_IDS.slice() },
    },
    targetObjectIds: [BATCH_OBJECT_ID, LINE_OBJECT_ID, RUN_OBJECT_ID, PROJECT_OBJECT_ID],
    // project sync outcome: mode-only ('created' | 'patched' | 'skipped') — never the projectId /
    // sourceProjectNo / projectName values themselves.
    projectSync: { mode: (projectSync && projectSync.mode) || 'skipped' },
    flags: { ...(plan.flags || {}) },
    valuesFree: true,
  }
}

// ── the committer ─────────────────────────────────────────────────────────────────────────────────
// Recompute the plan and persist its rows into the 9 internal MVP tables — admin-gated, internal-only,
// idempotent, immutable, values-free. Returns { persisted, mode, created:{batch,lines,run}, evidence }.
async function persistStockPreparationSyncRun(input = {}) {
  if (!isPlainObject(input)) {
    throw new StockPreparationSyncRunPersistError(422, 'PERSIST_CONFIG_INVALID', 'input must be an object')
  }
  const { context, permission, recordsApi, provisioning: provisioningInput, targetProjectId: targetProjectIdInput, ...planInputs } = input

  // 1. admin gate FIRST — fail-closed before ANY provisioning / records access.
  assertAdminPermission(permission)
  const provisioning = ensureProvisioning(
    provisioningInput ||
      (context && context.api && context.api.multitable && context.api.multitable.provisioning),
  )

  // 2. recompute the deterministic plan (the SAME body the admin previewed). It re-asserts the admin
  //    gate and validates every plan input, and it PERSISTS nothing.
  const plan = planBomSnapshotSyncRun({ permission, ...planInputs })

  const projectId = optionalString(planInputs.projectId)
  if (!projectId) {
    throw new StockPreparationSyncRunPersistError(422, 'PERSIST_CONFIG_INVALID', 'projectId is required', { field: 'projectId' })
  }
  // #4163 T1: the project row's own required field. Read straight off planInputs (never invented) —
  // sourceProjectNo / projectName / sourceSystem are populator inputs, not plan-orchestrator outputs.
  const sourceProjectNo = optionalString(planInputs.sourceProjectNo)
  if (!sourceProjectNo) {
    throw new StockPreparationSyncRunPersistError(422, 'PERSIST_CONFIG_INVALID', 'sourceProjectNo is required', { field: 'sourceProjectNo' })
  }
  const projectName = optionalString(planInputs.projectName) // optional passthrough — never invented.
  const projectSourceSystem = optionalString(planInputs.sourceSystem)
  const snapshotBatchId = optionalString(plan.snapshotBatch && plan.snapshotBatch[BATCH_KEY_FIELD])
  if (!snapshotBatchId) {
    throw new StockPreparationSyncRunPersistError(422, 'PERSIST_CONFIG_INVALID', 'planned snapshotBatchId is required', { field: BATCH_KEY_FIELD })
  }
  const snapshotLines = Array.isArray(plan.snapshotLines) ? plan.snapshotLines : []

  // The MVP tables are provisioned under an INTERNAL STAGING project (readiness/ensure route
  // resolveIntegrationStagingProjectId -> `<tenant>:integration-core`), NOT the business projectId. So
  // sheet resolution MUST use the caller-derived targetProjectId (staging); the plan rows keep the
  // business `projectId`. targetProjectId is derived server-side by the route from the auth tenant — it is
  // NEVER request-sourced. Required + fail-closed so a route that omits it cannot silently fall back to
  // the business project (which would raise a spurious PERSIST_TARGET_NOT_PROVISIONED).
  const targetProjectId = optionalString(targetProjectIdInput)
  if (!targetProjectId) {
    throw new StockPreparationSyncRunPersistError(422, 'PERSIST_CONFIG_INVALID', 'targetProjectId (internal staging project) is required for table resolution', { field: 'targetProjectId' })
  }

  // 3. resolve ALL four MVP sheets up front UNDER THE STAGING PROJECT (fail-closed if ANY is
  //    unprovisioned) and bind a scoped records API to each — so every write is confined to its own sheet.
  const batchTarget = await resolveScopedTarget(recordsApi, provisioning, targetProjectId, BATCH_OBJECT_ID)
  const lineTarget = await resolveScopedTarget(recordsApi, provisioning, targetProjectId, LINE_OBJECT_ID)
  const runTarget = await resolveScopedTarget(recordsApi, provisioning, targetProjectId, RUN_OBJECT_ID)
  const projectTarget = await resolveScopedTarget(recordsApi, provisioning, targetProjectId, PROJECT_OBJECT_ID)

  // 4. idempotency + immutability: if a BATCH row with this snapshotBatchId already exists, SKIP the
  //    whole commit — old snapshots are immutable, so we never overwrite an existing batch or its lines.
  const existingBatch = await batchTarget.scoped.queryRecords({
    filters: { [BATCH_KEY_FIELD]: snapshotBatchId },
    limit: 2,
    offset: 0,
  })
  if (!Array.isArray(existingBatch)) {
    throw new StockPreparationSyncRunPersistError(500, 'PERSIST_RECORDS_API_INVALID', 'queryRecords must return an array')
  }
  if (existingBatch.length > 0) {
    // A duplicate/retried commit of the SAME snapshotBatchId: batch/lines/run are immutable and skip
    // whole-hog (unchanged behavior). The project row is left untouched too — nothing NEW was learned
    // about the project by a commit that turned out to be a no-op repeat (its lastSyncedAt already
    // reflects the ORIGINAL, non-duplicate commit that first created this batch).
    const created = { batch: 0, lines: 0, run: 0 }
    return {
      persisted: false,
      mode: 'skipped_existing',
      created,
      project: { mode: 'skipped' },
      evidence: buildEvidence({ persisted: false, mode: 'skipped_existing', created, plan, plannedLineCount: snapshotLines.length, existingBatchMatched: true, projectSync: null }),
    }
  }

  // 5. create-only path: batch row, then each line row, then the run row. createRecord ONLY — no
  //    existing row is ever mutated. (Batch-first is required so the idempotency key is planted before
  //    the lines/run; a crash mid-commit therefore skips on retry rather than duplicating rows.)
  await batchTarget.scoped.createRecord({ data: plan.snapshotBatch })
  let linesCreated = 0
  for (const line of snapshotLines) {
    await lineTarget.scoped.createRecord({ data: groundLineRow(line) })
    linesCreated += 1
  }
  await runTarget.scoped.createRecord({ data: plan.syncRun })

  // #4163 T1: upsert the project row LAST — the run just genuinely completed, so `lastSyncRunId` /
  // `lastSyncedAt` on the project row point at a run that actually finished (not one that merely
  // started). Idempotent by projectId: a SECOND, genuinely-new batch for the same project patches this
  // same row rather than creating a duplicate — the multi-sync-run case the populator exists for.
  const projectSync = await upsertStockPreparationProject({
    scoped: projectTarget.scoped,
    projectId,
    sourceProjectNo,
    projectName,
    sourceSystem: projectSourceSystem,
    syncRunId: plan.syncRun.runId,
  })

  const created = { batch: 1, lines: linesCreated, run: 1 }
  return {
    persisted: true,
    mode: 'created',
    created,
    project: projectSync,
    evidence: buildEvidence({ persisted: true, mode: 'created', created, plan, plannedLineCount: snapshotLines.length, existingBatchMatched: false, projectSync }),
  }
}

module.exports = {
  REQUIRED_PERMISSION,
  BATCH_OBJECT_ID,
  LINE_OBJECT_ID,
  RUN_OBJECT_ID,
  BATCH_KEY_FIELD,
  PROJECT_OBJECT_ID,
  PROJECT_KEY_FIELD,
  PROJECT_STATUS_ACTIVE,
  StockPreparationSyncRunPersistError,
  StockPreparationSyncRunPlanError,
  persistStockPreparationSyncRun,
  __internals: {
    assertAdminPermission,
    ensureProvisioning,
    resolveScopedTarget,
    groundLineRow,
    upsertStockPreparationProject,
    buildEvidence,
    MVP_OBJECT_ID_SET,
    PROJECT_FIELD_IDS,
  },
}
