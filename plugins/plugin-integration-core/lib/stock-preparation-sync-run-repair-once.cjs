'use strict'

// P4 Option C — owner-controlled, one-shot repair for PRE-P4 partial snapshot commits.
//
// This module is deliberately NOT mounted as an HTTP route. Its default is dry-run; the separate
// operator wrapper must pass apply:true explicitly. The repair can append only a proven missing write
// suffix (line suffix -> run -> project) or advance a provably stale project pointer. It never deletes,
// deduplicates, rewrites an immutable batch/line/run row, or calls an external system.

const {
  planBomSnapshotSyncRun,
  parseStrictVersion,
} = require('./stock-preparation-sync-run-plan.cjs')
const {
  BATCH_OBJECT_ID,
  LINE_OBJECT_ID,
  RUN_OBJECT_ID,
  PROJECT_OBJECT_ID,
  BATCH_KEY_FIELD,
  PROJECT_KEY_FIELD,
  StockPreparationSyncRunPersistError,
  __internals: {
    assertAdminPermission,
    ensureProvisioning,
    ensurePersistUnitOfWork,
    resolveScopedTarget,
    groundLineRow,
    upsertStockPreparationProject,
    projectionsEqual,
    assertPlanIdentityKeys,
    readExistingSnapshotLines,
    PERSIST_MAX_PLAN_LINES,
    BATCH_TEMPLATE,
    LINE_TEMPLATE,
    RUN_TEMPLATE,
    LINE_KEY_FIELD,
    RUN_KEY_FIELD,
  },
} = require('./stock-preparation-sync-run-persist.cjs')
const { optionalString, isPlainObject } = require('./stock-preparation-common.cjs')

const REPAIR_AUDIT_ACTION = 'persist_repair_once'

function repairRefused(target, reason) {
  throw new StockPreparationSyncRunPersistError(
    409,
    'PERSIST_REPAIR_REFUSED',
    'stock-preparation snapshot repair is not provably append-only',
    { target, reason },
  )
}

function recordsArray(value) {
  if (!Array.isArray(value)) {
    throw new StockPreparationSyncRunPersistError(
      500,
      'PERSIST_RECORDS_API_INVALID',
      'queryRecords must return an array',
    )
  }
  return value
}

function ensureAuditStore(auditStore) {
  if (!auditStore || typeof auditStore.append !== 'function') {
    throw new StockPreparationSyncRunPersistError(
      503,
      'PERSIST_REPAIR_AUDIT_UNAVAILABLE',
      'stock-preparation snapshot repair requires the values-free audit store',
    )
  }
  return auditStore
}

async function readProjectRows(projectScoped, projectId) {
  const rows = recordsArray(await projectScoped.queryRecords({
    filters: { [PROJECT_KEY_FIELD]: projectId },
    limit: 2,
    offset: 0,
  }))
  if (rows.length > 1) repairRefused('project', 'ambiguous')
  if (rows.length === 1 && !optionalString(rows[0] && rows[0].id)) {
    repairRefused('project', 'ambiguous')
  }
  return rows
}

function successAuditDetail(result) {
  return {
    persisted: result.persisted,
    repairable: result.repairable,
    applied: result.applied,
    created: {
      lines: result.created.lines,
      run: result.created.run,
      project: result.created.project,
    },
    patched: { project: result.patched.project },
    missing: { ...result.evidence.missing },
  }
}

function refusalAuditDetail(error, apply) {
  const detail = {
    persisted: false,
    applied: apply,
    result: 'refused',
    failureCode: optionalString(error && error.code) || 'PERSIST_REPAIR_FAILED',
  }
  if (error && error.code === 'PERSIST_REPAIR_REFUSED') {
    detail.target = optionalString(error.details && error.details.target) || 'unknown'
    detail.reason = optionalString(error.details && error.details.reason) || 'unknown'
  }
  return detail
}

async function appendRepairAudit({ auditStore, tenantId, workspaceId, projectId, actor, mode, detail }) {
  await auditStore.append({
    tenantId,
    workspaceId,
    projectId,
    action: REPAIR_AUDIT_ACTION,
    subjectId: null,
    mode,
    actor,
    detail,
  })
}

async function resolvePointerBatchVersion({ batchScoped, projectId, pointerRunId }) {
  const rows = recordsArray(await batchScoped.queryRecords({
    filters: { projectId, syncRunId: pointerRunId },
    limit: 2,
    offset: 0,
  }))
  if (rows.length !== 1) return null
  return parseStrictVersion(rows[0] && rows[0].data && rows[0].data.snapshotVersion)
}

function valuesFreeResult({ apply, analysis, created, projectMode }) {
  const changed = created.lines > 0 || created.run > 0 || created.project > 0 || projectMode === 'patched'
  return {
    persisted: apply && changed,
    mode: apply ? (changed ? 'repaired' : 'noop') : 'dry_run',
    repairable: analysis.repairable,
    applied: apply,
    created: { ...created },
    patched: { project: projectMode === 'patched' ? 1 : 0 },
    evidence: {
      expectedLineCount: analysis.expectedLineCount,
      existingPrefixLineCount: analysis.existingPrefixLineCount,
      missing: {
        lines: analysis.missingLines.length,
        run: analysis.runMissing ? 1 : 0,
        project: analysis.projectMissing ? 1 : 0,
      },
      staleProjectPointer: analysis.projectPointerAction === 'patch',
      advancedProjectPointerPreserved: analysis.projectPointerAction === 'preserve_advanced',
      externalWrite: false,
      valuesFree: true,
    },
  }
}

async function analyzeRepairState({
  plan,
  snapshotLines,
  batchScoped,
  lineScoped,
  runScoped,
  projectScoped,
}) {
  const snapshotBatchId = plan.snapshotBatch[BATCH_KEY_FIELD]
  const existingBatches = recordsArray(await batchScoped.queryRecords({
    filters: { [BATCH_KEY_FIELD]: snapshotBatchId },
    limit: 2,
    offset: 0,
  }))
  if (existingBatches.length === 0) repairRefused('snapshot_batch', 'missing_prefix')
  if (existingBatches.length > 1) repairRefused('snapshot_batch', 'ambiguous')
  if (!projectionsEqual(BATCH_TEMPLATE, plan.snapshotBatch, existingBatches[0])) {
    repairRefused('snapshot_batch', 'content_mismatch')
  }

  const existingLines = await readExistingSnapshotLines(lineScoped, snapshotBatchId)
  const expectedByKey = new Map(snapshotLines.map((line) => [line[LINE_KEY_FIELD], line]))
  const actualByKey = new Map()
  for (const row of existingLines) {
    const key = optionalString(row && row.data && row.data[LINE_KEY_FIELD])
    if (!key || actualByKey.has(key)) repairRefused('snapshot_line', 'ambiguous')
    const expected = expectedByKey.get(key)
    if (!expected) repairRefused('snapshot_line', 'unexpected_key')
    if (!projectionsEqual(LINE_TEMPLATE, groundLineRow(expected), row)) {
      repairRefused('snapshot_line', 'content_mismatch')
    }
    actualByKey.set(key, row)
  }

  let existingPrefixLineCount = 0
  while (
    existingPrefixLineCount < snapshotLines.length
    && actualByKey.has(snapshotLines[existingPrefixLineCount][LINE_KEY_FIELD])
  ) {
    existingPrefixLineCount += 1
  }
  if (actualByKey.size !== existingPrefixLineCount) {
    repairRefused('snapshot_line', 'non_suffix_gap')
  }
  const missingLines = snapshotLines.slice(existingPrefixLineCount)

  const runId = plan.syncRun[RUN_KEY_FIELD]
  const existingRuns = recordsArray(await runScoped.queryRecords({
    filters: { [RUN_KEY_FIELD]: runId },
    limit: 2,
    offset: 0,
  }))
  if (existingRuns.length > 1) repairRefused('run', 'ambiguous')
  if (existingRuns.length === 1 && !projectionsEqual(RUN_TEMPLATE, plan.syncRun, existingRuns[0])) {
    repairRefused('run', 'content_mismatch')
  }
  const runMissing = existingRuns.length === 0
  if (!runMissing && missingLines.length > 0) repairRefused('run', 'non_suffix_gap')

  const projectId = plan.snapshotBatch.projectId
  const projectRows = await readProjectRows(projectScoped, projectId)
  const projectMissing = projectRows.length === 0
  let projectPointerAction = projectMissing ? 'create' : 'none'
  if (!projectMissing) {
    const pointerRunId = optionalString(projectRows[0] && projectRows[0].data && projectRows[0].data.lastSyncRunId)
    if (pointerRunId === runId) {
      if (runMissing) repairRefused('project', 'pointer_without_run')
    } else if (!pointerRunId) {
      repairRefused('project', 'pointer_unresolvable')
    } else {
      const pointerVersion = await resolvePointerBatchVersion({ batchScoped, projectId, pointerRunId })
      const currentVersion = parseStrictVersion(plan.snapshotBatch.snapshotVersion)
      if (pointerVersion === null || currentVersion === null) repairRefused('project', 'pointer_unresolvable')
      if (pointerVersion < currentVersion) projectPointerAction = 'patch'
      else if (pointerVersion === currentVersion) repairRefused('project', 'pointer_ambiguous')
      else projectPointerAction = 'preserve_advanced'
    }
  }

  return {
    expectedLineCount: snapshotLines.length,
    existingPrefixLineCount,
    missingLines,
    runMissing,
    projectRows,
    projectMissing,
    projectPointerAction,
    repairable:
      missingLines.length > 0
      || runMissing
      || projectMissing
      || projectPointerAction === 'patch',
  }
}

async function repairStockPreparationSyncRunOnce(input = {}) {
  if (!isPlainObject(input)) {
    throw new StockPreparationSyncRunPersistError(422, 'PERSIST_REPAIR_CONFIG_INVALID', 'input must be an object')
  }
  if (input.apply !== undefined && typeof input.apply !== 'boolean') {
    throw new StockPreparationSyncRunPersistError(422, 'PERSIST_REPAIR_CONFIG_INVALID', 'apply must be a boolean', { field: 'apply' })
  }
  const apply = input.apply === true
  const {
    context,
    permission,
    recordsApi: recordsApiInput,
    provisioning: provisioningInput,
    auditStore: auditStoreInput,
    auditActor,
    auditWorkspaceId,
    targetProjectId: targetProjectIdInput,
    lockTenantId: lockTenantIdInput,
    apply: _apply,
    ...planInputs
  } = input

  assertAdminPermission(permission)
  const auditStore = ensureAuditStore(auditStoreInput)
  const provisioning = ensureProvisioning(
    provisioningInput
      || (context && context.api && context.api.multitable && context.api.multitable.provisioning),
  )
  const plan = planBomSnapshotSyncRun({ permission, ...planInputs })
  const projectId = optionalString(planInputs.projectId)
  const sourceProjectNo = optionalString(planInputs.sourceProjectNo)
  const projectName = optionalString(planInputs.projectName)
  const projectSourceSystem = optionalString(planInputs.sourceSystem)
  const snapshotBatchId = optionalString(plan.snapshotBatch && plan.snapshotBatch[BATCH_KEY_FIELD])
  const snapshotLines = Array.isArray(plan.snapshotLines) ? plan.snapshotLines : []
  if (!projectId || !sourceProjectNo || !snapshotBatchId) {
    throw new StockPreparationSyncRunPersistError(422, 'PERSIST_REPAIR_CONFIG_INVALID', 'repair identity is incomplete')
  }
  assertPlanIdentityKeys(plan, snapshotLines)
  if (snapshotLines.length > PERSIST_MAX_PLAN_LINES) {
    throw new StockPreparationSyncRunPersistError(
      422,
      'PERSIST_PLAN_TOO_LARGE',
      'planned snapshot line count exceeds the provable persist bound',
      { field: 'snapshotLines', maxLines: PERSIST_MAX_PLAN_LINES },
    )
  }
  const recordsApi = ensurePersistUnitOfWork(recordsApiInput)
  const lockTenantId = optionalString(lockTenantIdInput)
  const targetProjectId = optionalString(targetProjectIdInput)
  if (!lockTenantId || !targetProjectId) {
    throw new StockPreparationSyncRunPersistError(422, 'PERSIST_REPAIR_CONFIG_INVALID', 'repair lock scope is incomplete')
  }

  const batchTarget = await resolveScopedTarget(recordsApi, provisioning, targetProjectId, BATCH_OBJECT_ID)
  const lineTarget = await resolveScopedTarget(recordsApi, provisioning, targetProjectId, LINE_OBJECT_ID)
  const runTarget = await resolveScopedTarget(recordsApi, provisioning, targetProjectId, RUN_OBJECT_ID)
  const projectTarget = await resolveScopedTarget(recordsApi, provisioning, targetProjectId, PROJECT_OBJECT_ID)

  try {
    if (apply) {
      // The records unit-of-work cannot include the plugin audit table. Persist a values-free intent
      // first so a successful repair can never exist without at least one durable audit row; the
      // completion/refusal row below records the outcome when that second append is available.
      await appendRepairAudit({
        auditStore,
        tenantId: lockTenantId,
        workspaceId: auditWorkspaceId,
        projectId,
        actor: auditActor,
        mode: 'apply_requested',
        detail: {
          persisted: false,
          applied: true,
          result: 'requested',
        },
      })
    }
    const result = await recordsApi.runStockPreparationPersistUnitOfWork({
      tenantId: lockTenantId,
      sheetIds: [batchTarget.sheetId, lineTarget.sheetId, runTarget.sheetId, projectTarget.sheetId],
      project: { sheetId: projectTarget.sheetId, projectId },
      batch: { sheetId: batchTarget.sheetId, snapshotBatchId },
    }, async (transactionRecordsApi) => {
      const batchScoped = await batchTarget.bindRecordsApi(transactionRecordsApi)
      const lineScoped = await lineTarget.bindRecordsApi(transactionRecordsApi)
      const runScoped = await runTarget.bindRecordsApi(transactionRecordsApi)
      const projectScoped = await projectTarget.bindRecordsApi(transactionRecordsApi)
      const analysis = await analyzeRepairState({
        plan,
        snapshotLines,
        batchScoped,
        lineScoped,
        runScoped,
        projectScoped,
      })

      const created = { lines: 0, run: 0, project: 0 }
      let projectMode = 'skipped'
      if (apply) {
        for (const line of analysis.missingLines) {
          await lineScoped.createRecord({ data: groundLineRow(line) })
          created.lines += 1
        }
        if (analysis.runMissing) {
          await runScoped.createRecord({ data: plan.syncRun })
          created.run = 1
        }
        if (analysis.projectPointerAction === 'create' || analysis.projectPointerAction === 'patch') {
          const projectSync = await upsertStockPreparationProject({
            scoped: projectScoped,
            existing: analysis.projectRows,
            projectId,
            sourceProjectNo,
            projectName,
            sourceSystem: projectSourceSystem,
            syncRunId: plan.syncRun[RUN_KEY_FIELD],
          })
          projectMode = projectSync.mode
          if (projectMode === 'created') created.project = 1
        }
      }

      return valuesFreeResult({ apply, analysis, created, projectMode })
    })
    await appendRepairAudit({
      auditStore,
      tenantId: lockTenantId,
      workspaceId: auditWorkspaceId,
      projectId,
      actor: auditActor,
      mode: result.mode,
      detail: successAuditDetail(result),
    })
    return result
  } catch (error) {
    if (error instanceof StockPreparationSyncRunPersistError) {
      await appendRepairAudit({
        auditStore,
        tenantId: lockTenantId,
        workspaceId: auditWorkspaceId,
        projectId,
        actor: auditActor,
        mode: 'refused',
        detail: refusalAuditDetail(error, apply),
      })
    }
    throw error
  }
}

module.exports = {
  repairStockPreparationSyncRunOnce,
  __internals: {
    analyzeRepairState,
    appendRepairAudit,
    ensureAuditStore,
    readProjectRows,
    repairRefused,
    refusalAuditDetail,
    successAuditDetail,
    valuesFreeResult,
  },
}
