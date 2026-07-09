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
// HARD boundary:
//   - admin-gated + fail-closed: assertAdminPermission runs BEFORE any provisioning / records access.
//   - internal-only: every createRecord / queryRecords goes through a scoped API bound to a resolved
//     MVP sheet whose objectId is in the frozen 9-table set. There is NO external ERP / K3 / PLM write,
//     NO apply-writer import, NO raw SQL, and NO fetch / live HTTP I/O of any kind.
//   - idempotent + immutable: an already-persisted snapshotBatchId SKIPS the whole commit (old
//     snapshots are immutable — never patched or overwritten). Only when absent do we create rows, and
//     ONLY via createRecord — the create path never mutates an existing row (no patch / update / delete).
//   - values-free evidence: counts / statuses / field-key NAMES / public objectId constants / booleans
//     only — never a raw drawing number, project value, or row payload.
//
// The who/when persistence stamps (startedAt / finishedAt / createdAt / createdBy) that the plan leaves
// unset are DELIBERATELY still unset here: the closed request allowlist carries no timestamp input, the
// records service does not require them at create time, and stamping would only inject non-determinism.
// Whether a commit should stamp who/when is an owner decision, left open.
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
const { STOCK_PREPARATION_MVP_REQUIRED_OBJECT_IDS } = require('./stock-preparation-templates.cjs')
const { optionalString, isPlainObject } = require('./stock-preparation-common.cjs')

const REQUIRED_PERMISSION = 'admin'

// The closed set of the 9 frozen MVP objectIds — every write target MUST be a member. The batch / line
// / run objectIds and their key fields come straight from the frozen templates, so nothing is invented.
const MVP_OBJECT_ID_SET = new Set(STOCK_PREPARATION_MVP_REQUIRED_OBJECT_IDS)
const BATCH_OBJECT_ID = BATCH_TEMPLATE.objectId
const LINE_OBJECT_ID = LINE_TEMPLATE.objectId
const RUN_OBJECT_ID = RUN_TEMPLATE.objectId
const BATCH_KEY_FIELD = BATCH_TEMPLATE.keyFields[0] // 'snapshotBatchId' — the idempotency key.

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

function ensureProvisioning(provisioning) {
  if (!provisioning || typeof provisioning.findObjectSheet !== 'function') {
    throw new StockPreparationSyncRunPersistError(
      503,
      'PERSIST_PROVISIONING_API_UNAVAILABLE',
      'stock-preparation sync-run persist requires multitable.provisioning findObjectSheet',
      { requiredMethods: ['findObjectSheet'] },
    )
  }
  return provisioning
}

// Resolve ONE MVP objectId to a scoped, sheet-bound records API. objectId MUST be a frozen MVP member
// (fail closed otherwise); the sheet MUST already exist (fail closed — NEVER create a sheet here). The
// returned scoped API forces every call onto sheet.id, so a write can never leave the resolved sheet.
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
  return { objectId, sheetId, scoped: createTargetScopedRecordsApi(recordsApi, { sheetId, objectId }) }
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

// Values-free commit evidence: counts / statuses / field-key NAMES / public objectId constants /
// booleans only. The plan rows legitimately carry business values (that is the persisted data), but
// NOTHING of that reaches this evidence — the enum literals here (draft / plm_sync / succeeded) are
// design constants, and plan.flags is a pure count/boolean summary.
function buildEvidence({ persisted, mode, created, plan, plannedLineCount, existingBatchMatched }) {
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
    },
    targetObjectIds: [BATCH_OBJECT_ID, LINE_OBJECT_ID, RUN_OBJECT_ID],
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
  const { context, permission, recordsApi, provisioning: provisioningInput, ...planInputs } = input

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
  const snapshotBatchId = optionalString(plan.snapshotBatch && plan.snapshotBatch[BATCH_KEY_FIELD])
  if (!snapshotBatchId) {
    throw new StockPreparationSyncRunPersistError(422, 'PERSIST_CONFIG_INVALID', 'planned snapshotBatchId is required', { field: BATCH_KEY_FIELD })
  }
  const snapshotLines = Array.isArray(plan.snapshotLines) ? plan.snapshotLines : []

  // 3. resolve ALL three MVP sheets up front (fail-closed if ANY is unprovisioned) and bind a scoped
  //    records API to each — so every subsequent write is structurally confined to its own MVP sheet.
  const batchTarget = await resolveScopedTarget(recordsApi, provisioning, projectId, BATCH_OBJECT_ID)
  const lineTarget = await resolveScopedTarget(recordsApi, provisioning, projectId, LINE_OBJECT_ID)
  const runTarget = await resolveScopedTarget(recordsApi, provisioning, projectId, RUN_OBJECT_ID)

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
    const created = { batch: 0, lines: 0, run: 0 }
    return {
      persisted: false,
      mode: 'skipped_existing',
      created,
      evidence: buildEvidence({ persisted: false, mode: 'skipped_existing', created, plan, plannedLineCount: snapshotLines.length, existingBatchMatched: true }),
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

  const created = { batch: 1, lines: linesCreated, run: 1 }
  return {
    persisted: true,
    mode: 'created',
    created,
    evidence: buildEvidence({ persisted: true, mode: 'created', created, plan, plannedLineCount: snapshotLines.length, existingBatchMatched: false }),
  }
}

module.exports = {
  REQUIRED_PERMISSION,
  BATCH_OBJECT_ID,
  LINE_OBJECT_ID,
  RUN_OBJECT_ID,
  BATCH_KEY_FIELD,
  StockPreparationSyncRunPersistError,
  StockPreparationSyncRunPlanError,
  persistStockPreparationSyncRun,
  __internals: {
    assertAdminPermission,
    ensureProvisioning,
    resolveScopedTarget,
    groundLineRow,
    buildEvidence,
    MVP_OBJECT_ID_SET,
  },
}
