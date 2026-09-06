'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  LARGE_BOM_ARTIFACT_CHUNK_COUNT,
  LARGE_BOM_BACKGROUND_EXPANSION_STATUSES,
  LARGE_BOM_CHECKPOINT_APPLY_STATUSES,
  StockPreparationLargeBomJobError,
  __internals,
  assertAuthoritativeLargeBomExpansion,
  cancelLargeBomBackgroundExpansionJob,
  createLargeBomBackgroundExpansionJob,
  createLargeBomCheckpointApplyJob,
  isAuthoritativeLargeBomExpansion,
  loadLargeBomBackgroundExpansionJob,
  loadLargeBomCheckpointApplyJob,
  planLargeBomBackgroundExpansionJob,
  publicBackgroundExpansionJob,
  publicCheckpointApplyJob,
  runLargeBomCheckpointApplyJobChunk,
  runLargeBomBackgroundExpansionJob,
  summarizeLargeBomBackgroundExpansionJobForEvidence,
  summarizeLargeBomCheckpointApplyJobForEvidence,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-large-bom-jobs.cjs'))
// The background lane's caps live with the action config that declares them.
const {
  LARGE_BOM_BACKGROUND_CAP_CEILINGS,
  LARGE_BOM_BACKGROUND_CAP_MULTIPLIERS,
  largeBomBackgroundExpansionCaps,
  normalizeStockPreparationActionConfig,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-table-actions.cjs'))

const RAW_MARKERS = Object.freeze([
  'PROJECT_VALUE_SHOULD_NOT_APPEAR',
  'COMPONENT_VALUE_SHOULD_NOT_APPEAR',
  'PARENT_VALUE_SHOULD_NOT_APPEAR',
  'PATH_VALUE_SHOULD_NOT_APPEAR',
  'TARGET_RECORD_VALUE_SHOULD_NOT_APPEAR',
  'PRIVATE_TOKEN_SHOULD_NOT_APPEAR',
  'SOURCE_BINDING_SHOULD_NOT_APPEAR',
  'CODE_VALUE_SHOULD_NOT_APPEAR',
  'NAME_VALUE_SHOULD_NOT_APPEAR',
  'MATERIAL_VALUE_SHOULD_NOT_APPEAR',
  'CHILD_VALUE_SHOULD_NOT_APPEAR',
  'CHILD_CODE_SHOULD_NOT_APPEAR',
  'CHILD_NAME_SHOULD_NOT_APPEAR',
  'CHILD_MATERIAL_SHOULD_NOT_APPEAR',
  'EXISTING_TARGET_VALUE_SHOULD_NOT_APPEAR',
])

function assertValuesFree(value) {
  const text = JSON.stringify(value)
  for (const marker of RAW_MARKERS) {
    assert.equal(text.includes(marker), false, `${marker} leaked into public evidence`)
  }
}

function assertLargeBomJobError(fn, code) {
  let err = null
  try {
    fn()
  } catch (error) {
    err = error
  }
  assert.ok(err instanceof StockPreparationLargeBomJobError, `expected ${code}`)
  assert.equal(err.code, code)
  return err
}

function createStorage({ durable = true } = {}) {
  const map = new Map()
  return {
    durable,
    map,
    async get(key) {
      return map.get(key) || null
    },
    async set(key, value) {
      map.set(key, JSON.parse(JSON.stringify(value)))
    },
  }
}

function createRecordingLogger() {
  const warnCalls = []
  return {
    warnCalls,
    warn(message, payload) {
      warnCalls.push([message, payload])
    },
  }
}

const TEST_SCOPE = Object.freeze({
  tenantId: 'tenant-1',
  workspaceId: 'workspace-1',
})

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function createSourceAdapter(data) {
  const calls = []
  return {
    calls,
    adapter: {
      async read(input = {}) {
        calls.push(clone(input))
        const rows = Array.isArray(data[input.object]) ? data[input.object] : []
        const matches = rows.filter((row) =>
          Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected),
        )
        const offset = input.cursor ? Number(input.cursor) : 0
        const limit = input.limit || 1000
        const records = matches.slice(offset, offset + limit).map(clone)
        return {
          records,
          done: offset + records.length >= matches.length,
          nextCursor: offset + records.length < matches.length ? String(offset + records.length) : null,
          metadata: {
            source: 'data-source:sql-readonly',
            filtersApplied: true,
            filterFields: Object.keys(input.filters || {}).sort(),
          },
        }
      },
    },
  }
}

function createTargetRecordsApi({ existing = [] } = {}) {
  const rows = existing.map((entry, index) => ({
    id: entry.id || `target_${index + 1}`,
    sheetId: entry.sheetId || 'sheet_stock_preparation',
    version: entry.version || 1,
    data: { ...(entry.data || entry) },
  }))
  const calls = []
  return {
    rows,
    calls,
    recordsApi: {
      async queryRecords(input = {}) {
        calls.push(['queryRecords', clone(input)])
        return rows
          .filter((row) => row.sheetId === input.sheetId)
          .filter((row) => Object.entries(input.filters || {}).every(([field, expected]) => row.data[field] === expected))
          .slice(input.offset || 0, (input.offset || 0) + (input.limit || 1000))
          .map(clone)
      },
      async createRecord(input = {}) {
        calls.push(['createRecord', clone(input)])
        const record = {
          id: `target_${rows.length + 1}`,
          sheetId: input.sheetId,
          version: 1,
          data: { ...(input.data || {}) },
        }
        rows.push(record)
        return clone(record)
      },
      async patchRecord(input = {}) {
        calls.push(['patchRecord', clone(input)])
        const row = rows.find((entry) => entry.sheetId === input.sheetId && entry.id === input.recordId)
        if (!row) throw new Error(`record not found: ${input.recordId}`)
        row.version += 1
        row.data = { ...row.data, ...(input.changes || {}) }
        return clone(row)
      },
    },
  }
}

function createBlockingTargetRecordsApi({ existing = [] } = {}) {
  const api = createTargetRecordsApi({ existing })
  let enteredFirstCreate
  let releaseFirstCreate
  let firstCreateBlocked = false
  const firstCreateEntered = new Promise((resolve) => {
    enteredFirstCreate = resolve
  })
  const firstCreateReleased = new Promise((resolve) => {
    releaseFirstCreate = resolve
  })
  return {
    rows: api.rows,
    calls: api.calls,
    firstCreateEntered,
    releaseFirstCreate,
    recordsApi: {
      ...api.recordsApi,
      async createRecord(input = {}) {
        if (!firstCreateBlocked) {
          firstCreateBlocked = true
          enteredFirstCreate()
          await firstCreateReleased
        }
        return api.recordsApi.createRecord(input)
      },
    },
  }
}

function targetBinding(overrides = {}) {
  return {
    sheetId: 'sheet_stock_preparation',
    ...overrides,
  }
}

function addDecision(key, overrides = {}) {
  return {
    decision: 'add',
    idempotencyKey: key,
    record: {
      idempotencyKey: key,
      projectNo: 'PROJECT_VALUE_SHOULD_NOT_APPEAR',
      componentSourceId: overrides.componentSourceId || 'COMPONENT_VALUE_SHOULD_NOT_APPEAR',
      parentSourceId: overrides.parentSourceId === undefined ? null : overrides.parentSourceId,
      path: overrides.path || 'PATH_VALUE_SHOULD_NOT_APPEAR',
      depth: overrides.depth || 0,
      componentCode: overrides.componentCode || 'CODE_VALUE_SHOULD_NOT_APPEAR',
      componentName: overrides.componentName || 'NAME_VALUE_SHOULD_NOT_APPEAR',
      material: overrides.material || 'MATERIAL_VALUE_SHOULD_NOT_APPEAR',
      sourceVersion: overrides.sourceVersion || 'V1',
      rawQuantity: overrides.rawQuantity || 1,
      totalQuantity: overrides.totalQuantity || 1,
      active: true,
      lastPlmRefreshRunId: 'run-large-bom-apply',
      lastPlmRefreshAt: '2026-06-08T00:00:00.000Z',
      lastPlmRefreshDecision: 'add',
      lastPlmConflictSummary: '',
    },
    conflictSummary: { type: 'add_missing' },
  }
}

function manualConfirmDecision(key) {
  return {
    decision: 'manual_confirm',
    idempotencyKey: key,
    conflictSummary: { type: 'source_correction_required' },
    source: 'planner',
  }
}

function planWithDecisions(decisions) {
  return {
    valid: true,
    ok: decisions.every((decision) => decision.decision !== 'manual_confirm'),
    counts: {
      add: decisions.filter((decision) => decision.decision === 'add').length,
      update: 0,
      skip: 0,
      inactive: 0,
      manual_confirm: decisions.filter((decision) => decision.decision === 'manual_confirm').length,
    },
    decisions: decisions.map(clone),
    plannedAt: '2026-06-08T00:00:00.000Z',
  }
}

async function seedPlannedLargeBomJob({
  storage = createStorage(),
  jobId = 'job-apply-source-1',
  plan = planWithDecisions([addDecision('PROJECT_VALUE_SHOULD_NOT_APPEAR::KEY-1')]),
  target = targetBinding(),
} = {}) {
  const actionId = 'plm.stock-preparation.pull-bom.v1'
  const job = {
    jobId,
    ...TEST_SCOPE,
    actionId,
    status: 'completed',
    authoritative: true,
    projectNoPresent: true,
    parameters: { projectNo: 'PROJECT_VALUE_SHOULD_NOT_APPEAR' },
    principal: 'PRIVATE_TOKEN_SHOULD_NOT_APPEAR',
    actionSnapshot: {
      actionId,
      source: { kind: 'data-source:sql-readonly', externalSystemId: 'SOURCE_BINDING_SHOULD_NOT_APPEAR' },
      target,
    },
    sourceKind: 'data-source:sql-readonly',
    artifactRevision: 'artifact-revision-1',
    artifact: {
      revision: 'artifact-revision-1',
      status: 'expanded',
      rows: [],
      summary: {},
      sealedAt: '2026-06-08T00:00:00.000Z',
    },
    planRevision: 'plan-revision-1',
    planArtifact: {
      revision: 'plan-revision-1',
      artifactRevision: 'artifact-revision-1',
      plan: clone(plan),
      existingRowCount: 0,
      plannedAt: plan.plannedAt,
    },
    progress: {
      rowsExpanded: 0,
      readCount: 0,
      frontierRemaining: 0,
      completedChunks: 1,
    },
    budgets: {},
    evidence: {
      sourceKind: 'data-source:sql-readonly',
      readObjects: [],
      errorTypes: [],
      readDiagnosticShapePresent: false,
    },
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:00.000Z',
  }
  await storage.set(__internals.backgroundJobKey({ ...TEST_SCOPE, actionId, jobId }), job)
  return { storage, ...TEST_SCOPE, actionId, jobId, job }
}

function plmData(overrides = {}) {
  return {
    DN_PDM_PathExAttrInfo: [{ FileCode: 'PROJECT_VALUE_SHOULD_NOT_APPEAR', Parent_OBJ_ID: 'PATH-1' }],
    DN_PDM_PathInfo: [{ OBJ_ID: 'PATH-1' }],
    DN_PDM_OrderHeadInfo: [{ OBJ_ID: 'ORDER-1', path_id: 'PATH-1' }],
    DN_PDM_OrderDetailInfo: [{ order_id: 'ORDER-1', part_id: 'COMPONENT_VALUE_SHOULD_NOT_APPEAR', quantity: '2', sort_id: 1 }],
    DN_PDM_PartLibraryInfo: [
      {
        OBJ_ID: 'COMPONENT_VALUE_SHOULD_NOT_APPEAR',
        IdentityNo: 'CODE_VALUE_SHOULD_NOT_APPEAR',
        IdentityName: 'NAME_VALUE_SHOULD_NOT_APPEAR',
        Material: 'MATERIAL_VALUE_SHOULD_NOT_APPEAR',
        SysVer: 'V1',
      },
      {
        OBJ_ID: 'CHILD_VALUE_SHOULD_NOT_APPEAR',
        IdentityNo: 'CHILD_CODE_SHOULD_NOT_APPEAR',
        IdentityName: 'CHILD_NAME_SHOULD_NOT_APPEAR',
        Material: 'CHILD_MATERIAL_SHOULD_NOT_APPEAR',
        SysVer: 'V1',
      },
    ],
    DN_PDM_BomHeadInfo: [{ part_id: 'COMPONENT_VALUE_SHOULD_NOT_APPEAR', bom_id: 'BOM-1', SysVer: 'V1', bom_able: true }],
    DN_PDM_BomDetailsInfo: [{ bom_pid: 'BOM-1', part_id: 'CHILD_VALUE_SHOULD_NOT_APPEAR', Bom_ExAttr1: '3', sort_id: 2 }],
    ...overrides,
  }
}

function testStatusEnumsArePinned() {
  assert.deepEqual(LARGE_BOM_BACKGROUND_EXPANSION_STATUSES, [
    'queued',
    'running',
    'paused',
    'failed',
    'completed',
    'cancelled',
    'expired',
  ])
  assert.deepEqual(LARGE_BOM_CHECKPOINT_APPLY_STATUSES, [
    'queued',
    'running',
    'paused',
    'partial',
    'succeeded',
    'failed',
    'cancelled',
    'expired',
  ])
}

function testBackgroundEvidenceIsValuesFreeProjection() {
  const summary = summarizeLargeBomBackgroundExpansionJobForEvidence({
    jobId: 'job-123',
    actionId: 'plm.stock-preparation.pull-bom.v1',
    status: 'running',
    authoritative: false,
    projectNoPresent: true,
    sourceKind: 'data-source:sql-readonly',
    readObjects: ['DN_PDM_PathExAttrInfo', 'DN_PDM_BomDetailsInfo', 'DN_PDM_BomDetailsInfo'],
    errorTypes: ['max_rows_exceeded', 'max_rows_exceeded', 'read_count_exceeded'],
    readDiagnosticShapePresent: true,
    progress: {
      rowsExpanded: 1200,
      readCount: 2401,
      frontierRemaining: 9,
      completedChunks: 3,
    },
    budgets: {
      maxRows: 10000,
      maxPages: 100,
      maxReadCount: 20000,
      maxElapsedMs: 600000,
      maxDepth: 20,
      maxArtifactChunks: 200,
    },
    parameters: {
      projectNo: RAW_MARKERS[0],
    },
    privateCheckpoint: {
      componentSourceId: RAW_MARKERS[1],
      parentSourceId: RAW_MARKERS[2],
      path: RAW_MARKERS[3],
      token: RAW_MARKERS[5],
    },
    rawRows: [{ component: RAW_MARKERS[1] }],
    target: {
      recordId: RAW_MARKERS[4],
      sheetId: 'sheet-value-should-not-appear',
      fieldIdMap: { projectNo: 'field-value-should-not-appear' },
    },
  })

  assert.deepEqual(summary, {
    jobIdPresent: true,
    actionId: 'plm.stock-preparation.pull-bom.v1',
    status: 'running',
    largeBom: true,
    authoritative: false,
    artifactRevisionPresent: false,
    planRevisionPresent: false,
    projectNoPresent: true,
    progress: {
      rowsExpanded: 1200,
      readCount: 2401,
      frontierRemaining: 9,
      completedChunks: 3,
    },
    budgets: {
      maxRows: 10000,
      maxPages: 100,
      maxReadCount: 20000,
      maxElapsedMs: 600000,
      maxDepth: 20,
      maxArtifactChunks: 200,
    },
    evidence: {
      sourceKind: 'data-source:sql-readonly',
      readObjects: ['DN_PDM_PathExAttrInfo', 'DN_PDM_BomDetailsInfo'],
      errorTypes: ['max_rows_exceeded', 'read_count_exceeded'],
      scaleErrorTypes: ['max_rows_exceeded', 'read_count_exceeded'],
      readDiagnosticShapePresent: true,
    },
  })
  assertValuesFree(summary)
}

function testBackgroundEvidenceRejectsUnsafeTokens() {
  assertLargeBomJobError(
    () => summarizeLargeBomBackgroundExpansionJobForEvidence({
      status: 'running',
      errorTypes: ['max_rows_exceeded: raw value appeared'],
    }),
    'LARGE_BOM_JOB_EVIDENCE_UNSAFE',
  )
  assertLargeBomJobError(
    () => summarizeLargeBomBackgroundExpansionJobForEvidence({
      status: 'running',
      readObjects: ['<redacted-secret-id>'],
    }),
    'LARGE_BOM_JOB_EVIDENCE_UNSAFE',
  )
}

function testAuthoritativeExpansionGate() {
  const completed = {
    status: 'completed',
    authoritative: true,
    artifactRevision: 'revision-1',
  }
  assert.equal(isAuthoritativeLargeBomExpansion(completed), true)
  assert.equal(assertAuthoritativeLargeBomExpansion(completed), completed)

  const running = assertLargeBomJobError(
    () => assertAuthoritativeLargeBomExpansion({ status: 'running', authoritative: false }),
    'LARGE_BOM_ARTIFACT_NOT_AUTHORITATIVE',
  )
  assert.deepEqual(running.details, { status: 'running', authoritative: false, artifactRevisionPresent: false })

  assertLargeBomJobError(
    () => assertAuthoritativeLargeBomExpansion({ status: 'completed', authoritative: false }),
    'LARGE_BOM_ARTIFACT_NOT_AUTHORITATIVE',
  )
  assert.equal(isAuthoritativeLargeBomExpansion({ status: 'completed', authoritative: true }), false)
  assertLargeBomJobError(
    () => assertAuthoritativeLargeBomExpansion({ status: 'completed', authoritative: true }),
    'LARGE_BOM_ARTIFACT_NOT_AUTHORITATIVE',
  )
}

function testCheckpointApplyEvidenceIsValuesFreeProjection() {
  const summary = summarizeLargeBomCheckpointApplyJobForEvidence({
    jobId: 'apply-job-1',
    status: 'partial',
    planRevision: 'plan-revision-1',
    targetRevision: 'target-revision-1',
    approvalPresent: true,
    counts: {
      created: 12,
      updated: 3,
      inactive: 1,
      skipped: 2,
      held: 4,
      failed: 1,
    },
    evidence: {
      resultStatuses: ['created', 'updated', 'held', 'failed', 'created'],
      errorCodes: ['target_row_not_found'],
      fieldCategories: ['plm_system'],
    },
    privatePlan: {
      projectNo: RAW_MARKERS[0],
      component: RAW_MARKERS[1],
      targetRecordId: RAW_MARKERS[4],
      token: RAW_MARKERS[5],
    },
  })

  assert.deepEqual(summary, {
    jobIdPresent: true,
    status: 'partial',
    planRevisionPresent: true,
    targetRevisionPresent: true,
    approvalPresent: true,
    counts: {
      created: 12,
      updated: 3,
      inactive: 1,
      skipped: 2,
      held: 4,
      failed: 1,
    },
    evidence: {
      resultStatuses: ['created', 'updated', 'held', 'failed'],
      errorCodes: ['target_row_not_found'],
      fieldCategories: ['plm_system'],
    },
  })
  assertValuesFree(summary)
}

function testInvalidStatusAndCountsFailClosed() {
  assertLargeBomJobError(
    () => summarizeLargeBomBackgroundExpansionJobForEvidence({ status: 'ready' }),
    'LARGE_BOM_JOB_STATUS_INVALID',
  )
  assertLargeBomJobError(
    () => summarizeLargeBomBackgroundExpansionJobForEvidence({ status: true }),
    'LARGE_BOM_JOB_EVIDENCE_INVALID',
  )
  assertLargeBomJobError(
    () => summarizeLargeBomBackgroundExpansionJobForEvidence({ status: 'running', errorTypes: [false] }),
    'LARGE_BOM_JOB_EVIDENCE_INVALID',
  )
  assertLargeBomJobError(
    () => summarizeLargeBomCheckpointApplyJobForEvidence({ status: 'running', counts: { created: -1 } }),
    'LARGE_BOM_JOB_EVIDENCE_INVALID',
  )
  assertLargeBomJobError(
    () => summarizeLargeBomCheckpointApplyJobForEvidence({ status: 'running', counts: { created: true } }),
    'LARGE_BOM_JOB_EVIDENCE_INVALID',
  )
  assertLargeBomJobError(
    () => summarizeLargeBomCheckpointApplyJobForEvidence({ status: 'running', counts: { created: ' ' } }),
    'LARGE_BOM_JOB_EVIDENCE_INVALID',
  )
  assertLargeBomJobError(
    () => summarizeLargeBomCheckpointApplyJobForEvidence({ status: 'running', counts: { created: [5] } }),
    'LARGE_BOM_JOB_EVIDENCE_INVALID',
  )
  const numericString = summarizeLargeBomCheckpointApplyJobForEvidence({
    status: 'running',
    counts: { created: '5' },
  })
  assert.equal(numericString.counts.created, 5)
}

async function testBackgroundJobStoreRequiresDurableStorageAndPrincipal() {
  await assert.rejects(
    () => createLargeBomBackgroundExpansionJob({
      storage: createStorage({ durable: false }),
      ...TEST_SCOPE,
      action: { actionId: 'plm.stock-preparation.pull-bom.v1' },
      parameters: { projectNo: 'PROJECT_VALUE_SHOULD_NOT_APPEAR' },
      principal: 'user-1',
      createJobId: () => 'job-1',
    }),
    (error) => error instanceof StockPreparationLargeBomJobError &&
      error.code === 'LARGE_BOM_JOB_STORE_UNAVAILABLE' &&
      error.status === 501,
  )

  await assert.rejects(
    () => createLargeBomBackgroundExpansionJob({
      storage: createStorage(),
      ...TEST_SCOPE,
      action: { actionId: 'plm.stock-preparation.pull-bom.v1' },
      parameters: { projectNo: 'PROJECT_VALUE_SHOULD_NOT_APPEAR' },
      principal: '',
      createJobId: () => 'job-1',
    }),
    (error) => error instanceof StockPreparationLargeBomJobError &&
      error.code === 'LARGE_BOM_JOB_PRINCIPAL_REQUIRED',
  )

  await assert.rejects(
    () => createLargeBomBackgroundExpansionJob({
      storage: createStorage(),
      tenantId: 'tenant-1',
      action: { actionId: 'plm.stock-preparation.pull-bom.v1' },
      parameters: { projectNo: 'PROJECT_VALUE_SHOULD_NOT_APPEAR' },
      principal: 'user-1',
      createJobId: () => 'job-1',
    }),
    (error) => error instanceof StockPreparationLargeBomJobError &&
      error.code === 'LARGE_BOM_JOB_SCOPE_REQUIRED' &&
      error.details.workspaceIdPresent === false,
  )
}

async function testBackgroundJobLifecycleIsValuesFree() {
  const storage = createStorage()
  const job = await createLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    action: {
      actionId: 'plm.stock-preparation.pull-bom.v1',
      source: { kind: 'data-source:sql-readonly' },
      target: { sheetId: 'TARGET_RECORD_VALUE_SHOULD_NOT_APPEAR' },
    },
    parameters: { projectNo: 'PROJECT_VALUE_SHOULD_NOT_APPEAR' },
    principal: 'PRIVATE_TOKEN_SHOULD_NOT_APPEAR',
    createJobId: () => 'job-values-free-1',
    now: () => '2026-06-08T00:00:00.000Z',
  })

  assert.equal(job.status, 'queued')
  assert.equal(job.authoritative, false)
  assert.equal(job.parameters.projectNo, 'PROJECT_VALUE_SHOULD_NOT_APPEAR', 'private job keeps operator parameter for future worker resume')
  assert.equal(job.principal, 'PRIVATE_TOKEN_SHOULD_NOT_APPEAR', 'private job captures request principal for future source reads')
  assert.equal(job.actionSnapshot.target.sheetId, 'TARGET_RECORD_VALUE_SHOULD_NOT_APPEAR', 'private job captures the server-side action config for future worker resume')

  const publicJob = publicBackgroundExpansionJob(job)
  assert.equal(publicJob.jobId, 'job-values-free-1')
  assert.equal(publicJob.artifactRevisionPresent, false)
  assert.equal(publicJob.planRevisionPresent, false)
  assert.deepEqual(publicJob.progress, {
    rowsExpanded: 0,
    readCount: 0,
    frontierRemaining: 0,
    completedChunks: 0,
  })
  assert.equal(publicJob.projectNoPresent, true)
  assert.equal(publicJob.evidence.sourceKind, 'data-source:sql-readonly')
  assertValuesFree(publicJob)

  const loaded = await loadLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    actionId: 'plm.stock-preparation.pull-bom.v1',
    jobId: 'job-values-free-1',
  })
  assert.deepEqual(loaded, job)

  await assert.rejects(
    () => loadLargeBomBackgroundExpansionJob({
      storage,
      tenantId: 'tenant-2',
      workspaceId: 'workspace-1',
      actionId: 'plm.stock-preparation.pull-bom.v1',
      jobId: 'job-values-free-1',
    }),
    (error) => error instanceof StockPreparationLargeBomJobError &&
      error.code === 'LARGE_BOM_JOB_NOT_FOUND' &&
      error.status === 404,
  )

  await assert.rejects(
    () => loadLargeBomBackgroundExpansionJob({
      storage,
      tenantId: 'tenant-1',
      workspaceId: 'workspace-2',
      actionId: 'plm.stock-preparation.pull-bom.v1',
      jobId: 'job-values-free-1',
    }),
    (error) => error instanceof StockPreparationLargeBomJobError &&
      error.code === 'LARGE_BOM_JOB_NOT_FOUND' &&
      error.status === 404,
  )

  const cancelled = await cancelLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    actionId: 'plm.stock-preparation.pull-bom.v1',
    jobId: 'job-values-free-1',
    principal: 'user-1',
    now: () => '2026-06-08T00:01:00.000Z',
  })
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.authoritative, false)
  assertValuesFree(publicBackgroundExpansionJob(cancelled))

  await assert.rejects(
    () => loadLargeBomBackgroundExpansionJob({
      storage,
      ...TEST_SCOPE,
      actionId: 'plm.stock-preparation.pull-bom.v1',
      jobId: 'missing-job',
    }),
    (error) => error instanceof StockPreparationLargeBomJobError &&
      error.code === 'LARGE_BOM_JOB_NOT_FOUND' &&
      error.status === 404,
  )
}

async function testBackgroundWorkerCompletesAuthoritativeArtifactWithoutPublicValues() {
  const storage = createStorage()
  const source = createSourceAdapter(plmData())
  await createLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    action: {
      actionId: 'plm.stock-preparation.pull-bom.v1',
      source: { kind: 'data-source:sql-readonly', externalSystemId: 'SOURCE_BINDING_SHOULD_NOT_APPEAR' },
      target: { sheetId: 'TARGET_RECORD_VALUE_SHOULD_NOT_APPEAR' },
    },
    parameters: { projectNo: 'PROJECT_VALUE_SHOULD_NOT_APPEAR' },
    principal: 'PRIVATE_TOKEN_SHOULD_NOT_APPEAR',
    createJobId: () => 'job-complete-1',
    now: () => '2026-06-08T00:00:00.000Z',
  })

  const completed = await runLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    actionId: 'plm.stock-preparation.pull-bom.v1',
    jobId: 'job-complete-1',
    sourceAdapter: source.adapter,
    now: () => '2026-06-08T00:01:00.000Z',
  })

  assert.equal(completed.status, 'completed')
  assert.equal(completed.authoritative, true)
  assert.equal(typeof completed.artifactRevision, 'string')
  assert.equal(completed.artifact.rows.length, 2, 'private artifact keeps full expanded rows for future planning')
  assert.equal(completed.artifact.rows[1].totalQuantity, 6)
  assert.equal(source.calls.length > 0, true, 'worker reads through the source adapter')
  assert.equal(source.calls.every((call) => call.filters && Object.keys(call.filters).length > 0), true, 'worker uses equality-filtered flat reads')
  assert.equal(source.calls.every((call) => !('sql' in call) && !('rawSql' in call) && !('query' in call)), true, 'worker never sends raw SQL')

  const publicJob = publicBackgroundExpansionJob(completed)
  assert.equal(publicJob.status, 'completed')
  assert.equal(publicJob.authoritative, true)
  assert.equal(publicJob.artifactRevisionPresent, true)
  assert.equal(publicJob.progress.rowsExpanded, 2)
  assert.equal(publicJob.progress.completedChunks, 1)
  assert.equal(publicJob.evidence.sourceKind, 'data-source:sql-readonly')
  assert.ok(publicJob.evidence.readObjects.includes('DN_PDM_PathExAttrInfo'))
  assertValuesFree(publicJob)

  const callCountAfterCompletion = source.calls.length
  const rerun = await runLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    actionId: 'plm.stock-preparation.pull-bom.v1',
    jobId: 'job-complete-1',
    sourceAdapter: source.adapter,
    now: () => '2026-06-08T00:02:00.000Z',
  })
  assert.equal(rerun.status, 'completed')
  assert.equal(rerun.artifactRevision, completed.artifactRevision, 'completed job retry keeps the same artifact revision')
  assert.equal(rerun.artifact.rows.length, 2, 'completed job retry does not append duplicate artifact rows')
  assert.equal(source.calls.length, callCountAfterCompletion, 'completed job retry does not re-read source')
}

async function runBackgroundJobUnderActionCaps({ action, jobId, source }) {
  const storage = createStorage()
  await createLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    action,
    parameters: { projectNo: 'PROJECT_VALUE_SHOULD_NOT_APPEAR' },
    principal: 'PRIVATE_TOKEN_SHOULD_NOT_APPEAR',
    createJobId: () => jobId,
    now: () => '2026-06-08T00:00:00.000Z',
  })
  return runLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    actionId: action.actionId,
    jobId,
    sourceAdapter: source.adapter,
    // The route's own composition (http-routes `largeBomExpansionOptionsForAction`):
    // background caps, NOT the interactive ones.
    expansionOptions: largeBomBackgroundExpansionCaps(action),
    now: () => '2026-06-08T00:01:00.000Z',
  })
}

// REGRESSION PIN for the 2026-09-05 field failure. This test used to hand the
// worker `expansionOptions: { maxRows: 1 }` and call the resulting `failed` the
// expected outcome — which pinned the bug: the background lane was handed the
// SAME cap that sent the caller into it, so every project big enough to need
// the lane failed in it. What is expected now is the pair: an interactive cap
// of N lets the background lane reach N x LARGE_BOM_BACKGROUND_CAP_MULTIPLIERS
// .maxRows, and only exceeding THAT cap fails non-authoritative.
async function testBackgroundWorkerScalesPastTheInteractiveScaleBudget() {
  const source = createSourceAdapter(plmData())
  // Interactive maxRows = 1: the dry-run that sent the operator here bounded at
  // one row. The fixture expands to two, so the pre-fix worker failed here.
  const completed = await runBackgroundJobUnderActionCaps({
    action: {
      actionId: 'plm.stock-preparation.pull-bom.v1',
      source: { kind: 'data-source:sql-readonly' },
      maxRows: 1,
    },
    jobId: 'job-scaled-1',
    source,
  })
  assert.equal(completed.status, 'completed', 'background lane must not re-hit the interactive maxRows')
  assert.equal(completed.authoritative, true)
  assert.equal(completed.artifact.rows.length, 2)
  assert.equal(
    completed.budgets.maxRows,
    1 * LARGE_BOM_BACKGROUND_CAP_MULTIPLIERS.maxRows,
    'budgets report the background cap that actually ran',
  )
  assert.equal(completed.budgets.maxArtifactChunks, LARGE_BOM_ARTIFACT_CHUNK_COUNT)
  // UNBOUNDED IS `null`, NOT 0. This action names no `maxReadCount`/
  // `maxElapsedMs`, the expander has no default for either, so the background
  // lane inherits "no bound" — and a projection of 0 would say the opposite.
  const publicJob = publicBackgroundExpansionJob(completed)
  assert.equal(publicJob.budgets.maxReadCount, null, 'an unbounded read budget must not read as zero')
  assert.equal(publicJob.budgets.maxElapsedMs, null, 'an unbounded time budget must not read as zero')
  assert.equal(publicJob.budgets.maxRows, 1 * LARGE_BOM_BACKGROUND_CAP_MULTIPLIERS.maxRows)
  assertValuesFree(publicJob)
}

async function testBackgroundWorkerFailsNonAuthoritativeOnScaleBudget() {
  const source = createSourceAdapter(plmData())
  // Explicit background cap of 1 — the ONLY way to fail on rows now.
  const failed = await runBackgroundJobUnderActionCaps({
    action: {
      actionId: 'plm.stock-preparation.pull-bom.v1',
      source: { kind: 'data-source:sql-readonly' },
      maxRows: 1,
      largeBom: { maxRows: 1 },
    },
    jobId: 'job-failed-1',
    source,
  })

  assert.equal(failed.status, 'failed')
  assert.equal(failed.authoritative, false)
  assert.equal(failed.artifact, undefined)
  assert.equal(failed.budgets.maxRows, 1, 'the failed run reports the background cap it hit')
  const publicJob = publicBackgroundExpansionJob(failed)
  assert.equal(publicJob.authoritative, false)
  assert.equal(publicJob.artifactRevisionPresent, false)
  assert.equal(publicJob.budgets.maxRows, 1)
  assert.ok(publicJob.evidence.errorTypes.includes('max_rows_exceeded'))
  assert.ok(publicJob.evidence.scaleErrorTypes.includes('max_rows_exceeded'))
  assertValuesFree(publicJob)
}

// The caps a run enforces are written down BEFORE the first source read, so a
// run that dies in the adapter still says which numbers were in force.
async function testBackgroundBudgetsAreRecordedBeforeTheSourceRead() {
  const storage = createStorage()
  await createLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    action: {
      actionId: 'plm.stock-preparation.pull-bom.v1',
      source: { kind: 'data-source:sql-readonly' },
    },
    parameters: { projectNo: 'PROJECT_VALUE_SHOULD_NOT_APPEAR' },
    principal: 'PRIVATE_TOKEN_SHOULD_NOT_APPEAR',
    createJobId: () => 'job-budget-evidence-1',
    now: () => '2026-06-08T00:00:00.000Z',
  })

  const failed = await runLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    actionId: 'plm.stock-preparation.pull-bom.v1',
    jobId: 'job-budget-evidence-1',
    sourceAdapter: {
      async read() {
        throw new Error('PROJECT_VALUE_SHOULD_NOT_APPEAR')
      },
    },
    expansionOptions: { maxRows: 200000, maxPages: 1000, maxReadCount: 600000, maxElapsedMs: 3600000 },
    now: () => '2026-06-08T00:01:00.000Z',
  })

  assert.equal(failed.status, 'failed')
  const publicJob = publicBackgroundExpansionJob(failed)
  assert.deepEqual(publicJob.budgets, {
    maxRows: 200000,
    maxPages: 1000,
    maxReadCount: 600000,
    maxElapsedMs: 3600000,
    maxDepth: 20,
    maxArtifactChunks: LARGE_BOM_ARTIFACT_CHUNK_COUNT,
  })
  assertValuesFree(publicJob)
}

function testBackgroundCapDerivationAndCeilings() {
  const base = {
    actionId: 'plm.stock-preparation.pull-bom.v1',
    source: { kind: 'data-source:sql-readonly' },
  }
  // Nothing configured: the expander's own interactive defaults are the base.
  assert.deepEqual(largeBomBackgroundExpansionCaps(base), {
    maxRows: 10000 * LARGE_BOM_BACKGROUND_CAP_MULTIPLIERS.maxRows,
    maxPages: 100 * LARGE_BOM_BACKGROUND_CAP_MULTIPLIERS.maxPages,
  })
  // The 222 shape: maxReadCount/maxElapsedMs configured interactively scale too.
  assert.deepEqual(
    largeBomBackgroundExpansionCaps({ ...base, maxRows: 10000, maxReadCount: 30000, maxElapsedMs: 600000 }),
    {
      maxRows: 200000,
      maxPages: 1000,
      maxReadCount: 600000,
      maxElapsedMs: 3600000,
    },
  )
  // An explicit block overrides the derived value, cap by cap.
  assert.deepEqual(
    largeBomBackgroundExpansionCaps({ ...base, maxRows: 10000, largeBom: { maxRows: 50000 } }),
    { maxRows: 50000, maxPages: 1000 },
  )
  // A derived value is clamped by the ceiling rather than running away.
  assert.equal(
    largeBomBackgroundExpansionCaps({ ...base, maxRows: 900000 }).maxRows,
    LARGE_BOM_BACKGROUND_CAP_CEILINGS.maxRows,
  )
}

function testBackgroundCapConfigBlockParsing() {
  const base = {
    actionId: 'plm.stock-preparation.pull-bom.v1',
    source: { kind: 'data-source:sql-readonly', externalSystemId: 'sys-1' },
    target: { sheetId: 'sheet_stock_preparation' },
  }
  const withBlock = normalizeStockPreparationActionConfig({
    ...base,
    largeBom: { maxRows: 200000, maxPages: 1000, maxReadCount: 600000, maxElapsedMs: 3600000 },
  })
  assert.deepEqual(withBlock.largeBom, {
    maxRows: 200000,
    maxPages: 1000,
    maxReadCount: 600000,
    maxElapsedMs: 3600000,
  })
  // Absent => the key is not added at all, so legacy config snapshots and their
  // hashes are byte-identical.
  assert.equal(Object.prototype.hasOwnProperty.call(normalizeStockPreparationActionConfig(base), 'largeBom'), false)
  assert.equal(
    Object.prototype.hasOwnProperty.call(normalizeStockPreparationActionConfig({ ...base, largeBom: {} }), 'largeBom'),
    false,
  )

  const rejected = [
    { largeBom: 5 },
    { largeBom: { maxRows: '200000' } },
    { largeBom: { maxRows: 0 } },
    { largeBom: { maxRows: -1 } },
    { largeBom: { maxRows: 1.5 } },
    { largeBom: { maxDepth: 40 } },
    { largeBom: { maxRows: LARGE_BOM_BACKGROUND_CAP_CEILINGS.maxRows + 1 } },
    { largeBom: { maxElapsedMs: LARGE_BOM_BACKGROUND_CAP_CEILINGS.maxElapsedMs + 1 } },
  ]
  for (const overrides of rejected) {
    let caught = null
    try {
      normalizeStockPreparationActionConfig({ ...base, ...overrides })
    } catch (error) {
      caught = error
    }
    assert.ok(caught, `expected a refusal for ${JSON.stringify(overrides)}`)
    assert.equal(caught.code, 'TABLE_ACTION_CONFIG_INVALID')
    assert.equal(caught.status, 422)
  }
}

async function testBackgroundWorkerStoresFailedJobWhenErrorTokenIsUnsafe() {
  const storage = createStorage()
  await createLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    action: {
      actionId: 'plm.stock-preparation.pull-bom.v1',
      source: { kind: 'data-source:sql-readonly' },
    },
    parameters: { projectNo: 'PROJECT_VALUE_SHOULD_NOT_APPEAR' },
    principal: 'PRIVATE_TOKEN_SHOULD_NOT_APPEAR',
    createJobId: () => 'job-unsafe-error-1',
    now: () => '2026-06-08T00:00:00.000Z',
  })

  const failed = await runLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    actionId: 'plm.stock-preparation.pull-bom.v1',
    jobId: 'job-unsafe-error-1',
    sourceAdapter: {
      async read() {
        const error = new Error('PROJECT_VALUE_SHOULD_NOT_APPEAR and COMPONENT_VALUE_SHOULD_NOT_APPEAR')
        error.code = 'unsafe token with PROJECT_VALUE_SHOULD_NOT_APPEAR'
        throw error
      },
    },
    now: () => '2026-06-08T00:01:00.000Z',
  })

  assert.equal(failed.status, 'failed')
  assert.deepEqual(failed.evidence.errorTypes, ['read_failed'])
  assertValuesFree(publicBackgroundExpansionJob(failed))

  const loaded = await loadLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    actionId: 'plm.stock-preparation.pull-bom.v1',
    jobId: 'job-unsafe-error-1',
  })
  assert.equal(loaded.status, 'failed')
  assert.deepEqual(loaded.evidence.errorTypes, ['read_failed'])
}

// REGRESSION PIN for the 222 field failure: a background job that ended
// `status: failed` with `errorTypes: ['read_failed']` persisted a BOOLEAN
// (`readDiagnosticShapePresent`) and nothing else, so nobody could say which
// object failed or with what driver code. What is expected now is the object
// and the code — and STILL not one byte of row data.
async function testBackgroundWorkerPersistsValuesFreeReadFailureDiagnostics() {
  const storage = createStorage()
  await createLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    action: {
      actionId: 'plm.stock-preparation.pull-bom.v1',
      source: { kind: 'data-source:sql-readonly' },
    },
    parameters: { projectNo: 'PROJECT_VALUE_SHOULD_NOT_APPEAR' },
    principal: 'PRIVATE_TOKEN_SHOULD_NOT_APPEAR',
    createJobId: () => 'job-read-diagnostics-1',
    now: () => '2026-06-08T00:00:00.000Z',
  })

  // The driver's message quotes the part it choked on. That literal is the
  // thing this test exists to keep OUT of the job row.
  const leakyMessage = `mssql read failed for ${RAW_MARKERS[1]}`
  const failed = await runLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    actionId: 'plm.stock-preparation.pull-bom.v1',
    jobId: 'job-read-diagnostics-1',
    sourceAdapter: {
      async read() {
        const error = new Error(leakyMessage)
        error.code = 'ECONNRESET'
        throw error
      },
    },
    now: () => '2026-06-08T00:01:00.000Z',
  })

  assert.equal(failed.status, 'failed')
  assert.deepEqual(failed.evidence.errorTypes, ['read_failed'])
  assert.equal(failed.evidence.readDiagnosticShapePresent, true, 'the pre-existing boolean is unchanged')

  assert.equal(Array.isArray(failed.evidence.readFailures), true)
  assert.equal(failed.evidence.readFailures.length, 1)
  assert.equal(failed.evidence.readFailures[0].object, 'DN_PDM_PathExAttrInfo')
  assert.equal(failed.evidence.readFailures[0].errorCode, 'ECONNRESET')
  assert.equal('cursor' in failed.evidence.readFailures[0], false, 'cursor can carry a row value and is never projected')
  assert.equal('message' in failed.evidence.readFailures[0], false)
  assert.equal(failed.evidence.readFailuresTotal, 1)
  assert.equal(failed.evidence.readFailuresTruncated, false)

  assert.equal(failed.evidence.errorDetails.length, 1)
  assert.equal(failed.evidence.errorDetails[0].type, 'read_failed')
  assert.equal(failed.evidence.errorDetails[0].object, 'DN_PDM_PathExAttrInfo')
  assert.equal(failed.evidence.errorDetails[0].causeClass, 'ECONNRESET')
  assert.equal('message' in failed.evidence.errorDetails[0], false)

  // THE WHOLE PERSISTED OBJECT, not just the public projection: the diagnostic
  // is stored, so the storage row is what has to be clean.
  const stored = JSON.stringify(failed)
  assert.equal(stored.includes(RAW_MARKERS[1]), false, 'the part number in the driver message never reaches the job row')
  assert.equal(stored.includes('mssql read failed for'), false, 'the driver message text never reaches the job row')
  assertValuesFree(failed.evidence)

  const loaded = await loadLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    actionId: 'plm.stock-preparation.pull-bom.v1',
    jobId: 'job-read-diagnostics-1',
  })
  assert.equal(JSON.stringify(loaded).includes(RAW_MARKERS[1]), false)

  const publicJob = publicBackgroundExpansionJob(loaded)
  assert.equal(publicJob.evidence.readFailures[0].object, 'DN_PDM_PathExAttrInfo')
  assert.equal(publicJob.evidence.readFailures[0].errorCode, 'ECONNRESET')
  assert.equal(publicJob.evidence.errorDetails[0].causeClass, 'ECONNRESET')
  assertValuesFree(publicJob)
}

// The throw that escapes the expander entirely (no summary, so no
// `readDiagnostics`). `readFailures` must stay ABSENT there — its absence is
// how a reader tells "the run died before the expander summarized" from "these
// reads failed" — while `errorDetails` still names the cause class.
async function testEscapedThrowKeepsCauseClassWithoutReadFailures() {
  const storage = createStorage()
  await createLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    action: { actionId: 'plm.stock-preparation.pull-bom.v1', source: { kind: 'data-source:sql-readonly' } },
    parameters: { projectNo: 'PROJECT_VALUE_SHOULD_NOT_APPEAR' },
    principal: 'PRIVATE_TOKEN_SHOULD_NOT_APPEAR',
    createJobId: () => 'job-escaped-throw-1',
    now: () => '2026-06-08T00:00:00.000Z',
  })

  const failed = await runLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    actionId: 'plm.stock-preparation.pull-bom.v1',
    jobId: 'job-escaped-throw-1',
    // `projectNo` is required by the expander, so an empty one throws BEFORE
    // any read — the one reliable way to reach the catch branch.
    sourceAdapter: { async read() { throw new Error(RAW_MARKERS[1]) } },
    expansionOptions: { projectNo: '' },
    now: () => '2026-06-08T00:01:00.000Z',
  })

  assert.equal(failed.status, 'failed')
  assert.equal(failed.evidence.readDiagnosticShapePresent, false)
  assert.equal('readFailures' in failed.evidence, false, 'no per-read record exists on this path')
  assert.equal(Array.isArray(failed.evidence.errorDetails), true)
  assert.equal(failed.evidence.errorDetails[0].type, failed.evidence.errorTypes[0])
  // The name of this test promises a cause class, so pin it: without one the
  // entry would carry only `{ type }` and `carriesObjectOrCauseClass` would drop
  // it, leaving this path with no detail stanza at all.
  assert.equal(typeof failed.evidence.errorDetails[0].causeClass, 'string')
  assert.equal(failed.evidence.errorDetails[0].causeClass.length > 0, true)
  assert.equal(JSON.stringify(failed).includes(RAW_MARKERS[1]), false)
  assertValuesFree(publicBackgroundExpansionJob(failed))
}

// http-routes.cjs wires `routeLogger` into this call as `logger` (#5507 follow-up): a job that
// lands in `failed` should show up as one values-free warn line, not only as a stored row nobody
// looks at until they open it. This covers the `updateJobFromExpansion` failure branch — the
// expander returned, but `expansion.valid !== true`.
async function testFailedExpansionWarnsOnceWithValuesFreePayload() {
  const storage = createStorage()
  const logger = createRecordingLogger()
  await createLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    action: {
      actionId: 'plm.stock-preparation.pull-bom.v1',
      source: { kind: 'data-source:sql-readonly' },
    },
    parameters: { projectNo: 'PROJECT_VALUE_SHOULD_NOT_APPEAR' },
    principal: 'PRIVATE_TOKEN_SHOULD_NOT_APPEAR',
    createJobId: () => 'job-warn-on-failure-1',
    now: () => '2026-06-08T00:00:00.000Z',
  })

  const leakyMessage = `mssql read failed for ${RAW_MARKERS[1]}`
  const failed = await runLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    actionId: 'plm.stock-preparation.pull-bom.v1',
    jobId: 'job-warn-on-failure-1',
    sourceAdapter: {
      async read() {
        const error = new Error(leakyMessage)
        error.code = 'ECONNRESET'
        throw error
      },
    },
    now: () => '2026-06-08T00:01:00.000Z',
    logger,
  })

  assert.equal(failed.status, 'failed')
  assert.equal(logger.warnCalls.length, 1, 'exactly one warn for one failed job')
  const [message, payload] = logger.warnCalls[0]
  assert.equal(typeof message, 'string')
  assert.equal(message.includes('failed'), true)

  assert.equal(payload.jobId, 'job-warn-on-failure-1')
  assert.equal(payload.actionId, 'plm.stock-preparation.pull-bom.v1')
  assert.equal(payload.tenantId, TEST_SCOPE.tenantId)
  assert.equal(payload.workspaceId, TEST_SCOPE.workspaceId)
  assert.equal(payload.status, 'failed')
  assert.deepEqual(payload.errorTypes, ['read_failed'])
  assert.deepEqual(payload.scaleErrorTypes, [])

  assert.equal(payload.readFailuresTotal, 1)
  assert.equal(payload.readFailures.length, 1)
  assert.deepEqual(Object.keys(payload.readFailures[0]).sort(), ['errorCode', 'object'])
  assert.equal(payload.readFailures[0].object, 'DN_PDM_PathExAttrInfo')
  assert.equal(payload.readFailures[0].errorCode, 'ECONNRESET')

  assert.equal(payload.errorDetails.length, 1)
  assert.deepEqual(Object.keys(payload.errorDetails[0]).sort(), ['causeClass', 'object', 'type'])
  assert.equal(payload.errorDetails[0].causeClass, 'ECONNRESET')

  // #5514 adversarial review: hand-picked substrings only checked 4 of the 15 markers this fixture
  // plants (e.g. a stray `projectNo` on the payload sailed through unnoticed). `assertValuesFree`
  // is the file's own values-free predicate — reuse it so every marker is covered, not just the
  // ones somebody thought to name here.
  assertValuesFree(payload)
  const serialized = JSON.stringify(payload)
  assert.equal(serialized.includes(RAW_MARKERS[1]), false, 'the part number in the driver message never reaches the log payload')
  assert.equal(serialized.includes('mssql read failed for'), false, 'the driver message text never reaches the log payload')
  assert.equal(serialized.includes('message'), false, 'no key named message ever mounts')
  assert.equal(serialized.includes('cursor'), false)
  assert.equal(serialized.includes('PRIVATE_TOKEN_SHOULD_NOT_APPEAR'), false, 'the read principal never reaches the log payload')
}

// The other failure branch: the expander throws before it can summarize (the catch block in
// `runLargeBomBackgroundExpansionJob`). No per-read record exists on this path, so the payload must
// omit `readFailures`/`readFailuresTotal` rather than report a misleading zero — mirroring the same
// "nothing to report => key absent" rule `job.evidence` already follows on this path (see
// `testEscapedThrowKeepsCauseClassWithoutReadFailures` above).
async function testEscapedThrowWarnsOnceWithoutReadFailureKeys() {
  const storage = createStorage()
  const logger = createRecordingLogger()
  await createLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    action: { actionId: 'plm.stock-preparation.pull-bom.v1', source: { kind: 'data-source:sql-readonly' } },
    parameters: { projectNo: 'PROJECT_VALUE_SHOULD_NOT_APPEAR' },
    principal: 'PRIVATE_TOKEN_SHOULD_NOT_APPEAR',
    createJobId: () => 'job-warn-escaped-throw-1',
    now: () => '2026-06-08T00:00:00.000Z',
  })

  const failed = await runLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    actionId: 'plm.stock-preparation.pull-bom.v1',
    jobId: 'job-warn-escaped-throw-1',
    sourceAdapter: { async read() { throw new Error(RAW_MARKERS[1]) } },
    expansionOptions: { projectNo: '' },
    now: () => '2026-06-08T00:01:00.000Z',
    logger,
  })

  assert.equal(failed.status, 'failed')
  assert.equal(logger.warnCalls.length, 1)
  const [, payload] = logger.warnCalls[0]
  assert.equal('readFailures' in payload, false, 'no per-read record exists on this path')
  assert.equal('readFailuresTotal' in payload, false)
  assert.equal(Array.isArray(payload.errorDetails), true)
  assert.equal(payload.errorDetails.length, 1)
  assert.equal(typeof payload.errorDetails[0].causeClass, 'string')
  assert.equal(JSON.stringify(payload).includes(RAW_MARKERS[1]), false)
}

// A successful run must never warn, and a caller that passes no logger at all must see
// byte-identical behaviour to before this change — no throw, same stored job.
async function testSuccessDoesNotWarnAndMissingLoggerIsInert() {
  const storage = createStorage()
  const source = createSourceAdapter(plmData())
  const logger = createRecordingLogger()
  await createLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    action: {
      actionId: 'plm.stock-preparation.pull-bom.v1',
      source: { kind: 'data-source:sql-readonly' },
      target: { sheetId: 'TARGET_RECORD_VALUE_SHOULD_NOT_APPEAR' },
    },
    parameters: { projectNo: 'PROJECT_VALUE_SHOULD_NOT_APPEAR' },
    principal: 'PRIVATE_TOKEN_SHOULD_NOT_APPEAR',
    createJobId: () => 'job-success-no-warn-1',
    now: () => '2026-06-08T00:00:00.000Z',
  })

  const completed = await runLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    actionId: 'plm.stock-preparation.pull-bom.v1',
    jobId: 'job-success-no-warn-1',
    sourceAdapter: source.adapter,
    now: () => '2026-06-08T00:01:00.000Z',
    logger,
  })
  assert.equal(completed.status, 'completed')
  assert.equal(logger.warnCalls.length, 0, 'a successful run never warns')

  // No `logger` at all — the pre-#5507-follow-up call shape — must neither throw nor change the
  // stored/returned job for a job that DOES fail.
  const storageNoLogger = createStorage()
  await createLargeBomBackgroundExpansionJob({
    storage: storageNoLogger,
    ...TEST_SCOPE,
    action: { actionId: 'plm.stock-preparation.pull-bom.v1', source: { kind: 'data-source:sql-readonly' } },
    parameters: { projectNo: 'PROJECT_VALUE_SHOULD_NOT_APPEAR' },
    principal: 'PRIVATE_TOKEN_SHOULD_NOT_APPEAR',
    createJobId: () => 'job-no-logger-1',
    now: () => '2026-06-08T00:00:00.000Z',
  })
  const failedWithoutLogger = await runLargeBomBackgroundExpansionJob({
    storage: storageNoLogger,
    ...TEST_SCOPE,
    actionId: 'plm.stock-preparation.pull-bom.v1',
    jobId: 'job-no-logger-1',
    sourceAdapter: {
      async read() {
        const error = new Error(`mssql read failed for ${RAW_MARKERS[1]}`)
        error.code = 'ECONNRESET'
        throw error
      },
    },
    now: () => '2026-06-08T00:01:00.000Z',
    // logger intentionally omitted
  })
  assert.equal(failedWithoutLogger.status, 'failed')
  assert.equal(failedWithoutLogger.evidence.readFailures[0].errorCode, 'ECONNRESET')
}

// C, FOUND IN ADVERSARIAL REVIEW OF #5507. The first cut fed `expansion.errors[]`
// to the projection unconditionally, so a bounded expansion with ZERO failed
// reads still grew three evidence keys whose content was a verbatim copy of
// `errorTypes`. `max_rows_exceeded` carries `{maxRows}` and nothing else, so it
// is the exact case that must come out key-for-key identical to pre-feature main.
async function testObjectLessBoundedExpansionKeepsThePreFeatureKeySet() {
  const source = createSourceAdapter(plmData())
  const failed = await runBackgroundJobUnderActionCaps({
    action: {
      actionId: 'plm.stock-preparation.pull-bom.v1',
      source: { kind: 'data-source:sql-readonly' },
      maxRows: 1,
      largeBom: { maxRows: 1 },
    },
    jobId: 'job-bounded-keyset-1',
    source,
  })

  assert.equal(failed.status, 'failed')
  assert.deepEqual(failed.evidence.errorTypes, ['max_rows_exceeded'])
  assert.deepEqual(Object.keys(failed.evidence), [
    'sourceKind',
    'readObjects',
    'errorTypes',
    'readDiagnosticShapePresent',
  ], 'an object-less bounded failure adds no detail keys')
  assert.deepEqual(Object.keys(publicBackgroundExpansionJob(failed).evidence), [
    'sourceKind',
    'readObjects',
    'errorTypes',
    'scaleErrorTypes',
    'readDiagnosticShapePresent',
  ])
}

// THE OTHER SIDE OF THE SAME BOUNDARY, so the narrowing is a rule and not a
// coincidence. A bounded error that NAMES ITS OBJECT still mounts, because
// "the read budget blew while reading which object" is the one thing
// `errorTypes` cannot say.
function testBoundedErrorsThatNameAnObjectStillMount() {
  const withoutObject = __internals.attachReadFailureEvidence(
    { errorTypes: ['max_rows_exceeded'] },
    { errors: [{ type: 'max_rows_exceeded', maxRows: 1 }] },
  )
  assert.deepEqual(Object.keys(withoutObject), ['errorTypes'])

  const withObject = __internals.attachReadFailureEvidence(
    { errorTypes: ['read_count_exceeded'] },
    { errors: [{ type: 'read_count_exceeded', object: 'DN_PDM_OrderHeadInfo', maxReadCount: 2 }] },
  )
  assert.deepEqual(withObject.errorDetails, [
    { type: 'read_count_exceeded', object: 'DN_PDM_OrderHeadInfo' },
  ])
  assert.equal(withObject.errorDetailsTotal, 1)
  assert.equal(withObject.errorDetailsTruncated, false)
}

// THE CAP'S EXACT EDGE. Off-by-one here would either hide the 20th failure or
// claim truncation that did not happen.
function testDetailCapBoundaryIsExact() {
  const limit = __internals.LARGE_BOM_READ_FAILURE_DETAIL_LIMIT
  const diagnosticsOf = (count) => Array.from({ length: count }, (_, index) => ({
    object: `DN_PDM_Object_${index}`,
    filterFields: ['FileCode'],
    cursor: null,
    status: 'failed',
    errorCode: 'ECONNRESET',
  }))

  const atCap = __internals.attachReadFailureEvidence({}, { readDiagnostics: diagnosticsOf(limit) })
  assert.equal(atCap.readFailures.length, limit)
  assert.equal(atCap.readFailuresTotal, limit)
  assert.equal(atCap.readFailuresTruncated, false, 'exactly at the cap is not truncated')

  const overCap = __internals.attachReadFailureEvidence({}, { readDiagnostics: diagnosticsOf(limit + 1) })
  assert.equal(overCap.readFailures.length, limit)
  assert.equal(overCap.readFailuresTotal, limit + 1)
  assert.equal(overCap.readFailuresTruncated, true, 'one over the cap is truncated')
}

// `<key>Total` COUNTS CANDIDATES, NOT SURVIVORS. Three reads that failed with
// driver codes too unsafe to project are still three failed reads; reporting 0
// would be a wrong answer to the question this stanza exists to answer.
function testTotalCountsCandidatesNotSurvivors() {
  const evidence = __internals.attachReadFailureEvidence({}, {
    readDiagnostics: [
      { object: 'DN_PDM_PathExAttrInfo', status: 'failed', errorCode: 'ECONNRESET' },
      // Every projectable field unsafe => an empty entry that is still a failed read.
      { object: `bad object ${RAW_MARKERS[0]}`, status: 'failed', errorCode: `bad code ${RAW_MARKERS[1]}`, filterFields: [] },
      { object: 'DN_PDM_Ok', status: 'ok', count: 3 },
    ],
  })
  assert.equal(evidence.readFailures.length, 1, 'only the projectable entry is listed')
  assert.equal(evidence.readFailuresTotal, 2, 'both failed reads are counted; the ok read is not')
  assert.equal(evidence.readFailuresTruncated, true, 'the array does not list everything counted')
  assertValuesFree(evidence)
}

// THE SAME RULE ON THE OTHER STANZA, found in review of dda3ede93: `errorDetails`
// used to count SURVIVORS, so two `read_count_exceeded` errors differing only in
// that one object contains a space reported `1 / 1 / false` — one detail gone
// while the stanza claimed nothing was missing. Counting candidates makes the
// two stanzas obey one rule.
function testErrorDetailTotalCountsCandidatesNotSurvivors() {
  const evidence = __internals.attachReadFailureEvidence({}, {
    errors: [
      { type: 'read_count_exceeded', object: 'DN_PDM_OrderHeadInfo', maxReadCount: 2 },
      // Names an object, but the token is unsafe => listed nowhere, counted here.
      { type: 'read_count_exceeded', object: `bad object ${RAW_MARKERS[0]}`, maxReadCount: 2 },
    ],
  })
  assert.equal(evidence.errorDetails.length, 1, 'only the projectable detail is listed')
  assert.equal(evidence.errorDetailsTotal, 2, 'both errors that named an object are counted')
  assert.equal(evidence.errorDetailsTruncated, true, 'the array does not list everything counted')
  assertValuesFree(evidence)

  // The narrowing still holds: an error that names NEITHER is not a candidate at
  // all, so an object-less bounded failure mounts nothing (the C regression pin).
  const objectLess = __internals.attachReadFailureEvidence({}, {
    errors: [{ type: 'max_rows_exceeded', maxRows: 1 }, { type: 'cycle_detected', depth: 3 }],
  })
  assert.deepEqual(Object.keys(objectLess), [])
}

// A STORED COUNTER IS A CLAIM. The public projection already refuses to trust
// the stored array; this pins that it does not then trust the number beside it.
function testPublicProjectionRepairsIncoherentStoredCounters() {
  const publicJob = summarizeLargeBomBackgroundExpansionJobForEvidence({
    jobId: 'job-incoherent-1',
    status: 'failed',
    evidence: {
      sourceKind: 'data-source:sql-readonly',
      readObjects: [],
      errorTypes: ['read_failed'],
      readDiagnosticShapePresent: true,
      readFailures: [{ object: 'DN_PDM_PathExAttrInfo', errorCode: 'ECONNRESET' }],
      readFailuresTotal: 999,
      readFailuresTruncated: 'maybe',
    },
  })

  assert.equal(publicJob.evidence.readFailures.length, 1)
  assert.equal(publicJob.evidence.readFailuresTotal >= publicJob.evidence.readFailures.length, true)
  assert.equal(typeof publicJob.evidence.readFailuresTruncated, 'boolean', 'a non-boolean stored flag is never copied through')
  assert.equal(publicJob.evidence.readFailuresTruncated, true, 'one shown out of 999 counted is truncated')
  assertValuesFree(publicJob)

  // A total that claims FEWER items than we can see is raised to what we see,
  // and an absurd one is clamped rather than repeated.
  const understated = summarizeLargeBomBackgroundExpansionJobForEvidence({
    status: 'failed',
    evidence: {
      readFailures: [
        { object: 'DN_PDM_A', errorCode: 'ECONNRESET' },
        { object: 'DN_PDM_B', errorCode: 'ECONNRESET' },
      ],
      readFailuresTotal: 0,
      readFailuresTruncated: true,
    },
  })
  assert.equal(understated.evidence.readFailuresTotal, 2)
  assert.equal(understated.evidence.readFailuresTruncated, false, 'nothing is missing, so nothing is truncated')

  const absurd = summarizeLargeBomBackgroundExpansionJobForEvidence({
    status: 'failed',
    evidence: {
      readFailures: [{ object: 'DN_PDM_A', errorCode: 'ECONNRESET' }],
      readFailuresTotal: Number.MAX_SAFE_INTEGER,
    },
  })
  assert.equal(absurd.evidence.readFailuresTotal, 1000000, 'an absurd stored counter is clamped to the ceiling')

  // The stored array is sliced no matter what the row claims, and the flag
  // follows the slice rather than the claim.
  const oversized = summarizeLargeBomBackgroundExpansionJobForEvidence({
    status: 'failed',
    evidence: {
      readFailures: Array.from({ length: 40 }, (_, index) => ({ object: `DN_PDM_Object_${index}`, errorCode: 'ECONNRESET' })),
      readFailuresTruncated: false,
    },
  })
  assert.equal(oversized.evidence.readFailures.length, __internals.LARGE_BOM_READ_FAILURE_DETAIL_LIMIT)
  assert.equal(oversized.evidence.readFailuresTotal, 40)
  assert.equal(oversized.evidence.readFailuresTruncated, true, 'an actual slice forces the flag true')
}

// The per-entry bound: `filterFields` is adapter-supplied, so one diagnostic
// must not be able to grow without limit while the item cap counts it as one.
function testFilterFieldsAreBoundedPerEntry() {
  const evidence = __internals.attachReadFailureEvidence({}, {
    readDiagnostics: [{
      object: 'DN_PDM_PathExAttrInfo',
      status: 'failed',
      errorCode: 'ECONNRESET',
      filterFields: Array.from({ length: 200 }, (_, index) => `Field_${index}`),
    }],
  })
  assert.equal(evidence.readFailures[0].filterFields.length, 32)
}

// The cap has to be a CAP, not a silent truncation: 20 entries out, the real
// count still reported. Driven through the same helper `updateJobFromExpansion`
// uses, because the expander abandons an expansion on its FIRST failed read and
// therefore cannot itself produce 21 of them.
function testReadFailureDetailsAreCappedAndReportTheRealTotal() {
  const limit = __internals.LARGE_BOM_READ_FAILURE_DETAIL_LIMIT
  assert.equal(limit, 20)
  const overCap = limit + 5
  const readDiagnostics = Array.from({ length: overCap }, (_, index) => ({
    object: `DN_PDM_Object_${index}`,
    filterFields: ['FileCode'],
    cursor: RAW_MARKERS[3],
    status: 'failed',
    filtersSent: true,
    errorCode: 'ECONNRESET',
  }))
  // One OK read in the middle: the projection filters on status, so this must
  // not be counted and must not consume a slot.
  readDiagnostics.push({ object: 'DN_PDM_Ok', filterFields: [], cursor: null, status: 'ok', count: 3 })
  const errors = Array.from({ length: overCap }, (_, index) => ({
    type: 'read_failed',
    object: `DN_PDM_Object_${index}`,
    causeClass: 'ECONNRESET',
    message: RAW_MARKERS[1],
  }))

  const evidence = __internals.attachReadFailureEvidence({
    sourceKind: 'data-source:sql-readonly',
    readObjects: [],
    errorTypes: ['read_failed'],
    readDiagnosticShapePresent: true,
  }, { readDiagnostics, errors })

  assert.equal(evidence.readFailures.length, limit)
  assert.equal(evidence.readFailuresTotal, overCap)
  assert.equal(evidence.readFailuresTruncated, true)
  assert.equal(evidence.errorDetails.length, limit)
  assert.equal(evidence.errorDetailsTotal, overCap)
  assert.equal(evidence.errorDetailsTruncated, true)
  assert.equal(JSON.stringify(evidence).includes(RAW_MARKERS[3]), false, 'cursor is never projected')
  assert.equal(JSON.stringify(evidence).includes(RAW_MARKERS[1]), false, 'message is never projected')
  assertValuesFree(evidence)

  // Same cap and same real total on the way back out of storage.
  const publicJob = summarizeLargeBomBackgroundExpansionJobForEvidence({
    jobId: 'job-capped-1',
    actionId: 'plm.stock-preparation.pull-bom.v1',
    status: 'failed',
    evidence,
  })
  assert.equal(publicJob.evidence.readFailures.length, limit)
  assert.equal(publicJob.evidence.readFailuresTotal, overCap)
  assert.equal(publicJob.evidence.readFailuresTruncated, true)
  assert.equal(publicJob.evidence.errorDetailsTotal, overCap)
  assertValuesFree(publicJob)
}

// SUCCESS PATH BYTE-IDENTICAL. Both stanzas are conditionally mounted, so a run
// with no failed read must produce the same evidence key set as before this
// change — no empty arrays, no zero counters.
async function testSuccessfulRunHasNoReadFailureKeys() {
  const storage = createStorage()
  const source = createSourceAdapter(plmData())
  await createLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    action: {
      actionId: 'plm.stock-preparation.pull-bom.v1',
      source: { kind: 'data-source:sql-readonly' },
      target: { sheetId: 'TARGET_RECORD_VALUE_SHOULD_NOT_APPEAR' },
    },
    parameters: { projectNo: 'PROJECT_VALUE_SHOULD_NOT_APPEAR' },
    principal: 'PRIVATE_TOKEN_SHOULD_NOT_APPEAR',
    createJobId: () => 'job-no-read-failures-1',
    now: () => '2026-06-08T00:00:00.000Z',
  })

  const completed = await runLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    actionId: 'plm.stock-preparation.pull-bom.v1',
    jobId: 'job-no-read-failures-1',
    sourceAdapter: source.adapter,
    now: () => '2026-06-08T00:01:00.000Z',
  })

  assert.equal(completed.status, 'completed')
  assert.deepEqual(Object.keys(completed.evidence), [
    'sourceKind',
    'readObjects',
    'errorTypes',
    'readDiagnosticShapePresent',
  ])
  assert.deepEqual(Object.keys(publicBackgroundExpansionJob(completed).evidence), [
    'sourceKind',
    'readObjects',
    'errorTypes',
    'scaleErrorTypes',
    'readDiagnosticShapePresent',
  ])
}

async function completedJobWithArtifact({ storage = createStorage(), jobId = 'job-plan-1' } = {}) {
  const source = createSourceAdapter(plmData())
  await createLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    action: {
      actionId: 'plm.stock-preparation.pull-bom.v1',
      source: { kind: 'data-source:sql-readonly', externalSystemId: 'SOURCE_BINDING_SHOULD_NOT_APPEAR' },
      target: { sheetId: 'TARGET_RECORD_VALUE_SHOULD_NOT_APPEAR' },
    },
    parameters: { projectNo: 'PROJECT_VALUE_SHOULD_NOT_APPEAR' },
    principal: 'PRIVATE_TOKEN_SHOULD_NOT_APPEAR',
    createJobId: () => jobId,
    now: () => '2026-06-08T00:00:00.000Z',
  })
  await runLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    actionId: 'plm.stock-preparation.pull-bom.v1',
    jobId,
    sourceAdapter: source.adapter,
    now: () => '2026-06-08T00:01:00.000Z',
  })
  return { storage, jobId }
}

async function testPlannerHandoffRequiresAuthoritativeArtifact() {
  const storage = createStorage()
  await createLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    action: {
      actionId: 'plm.stock-preparation.pull-bom.v1',
      source: { kind: 'data-source:sql-readonly' },
    },
    parameters: { projectNo: 'PROJECT_VALUE_SHOULD_NOT_APPEAR' },
    principal: 'PRIVATE_TOKEN_SHOULD_NOT_APPEAR',
    createJobId: () => 'job-not-authoritative',
  })

  await assert.rejects(
    () => planLargeBomBackgroundExpansionJob({
      storage,
      ...TEST_SCOPE,
      actionId: 'plm.stock-preparation.pull-bom.v1',
      jobId: 'job-not-authoritative',
      existingRows: [],
    }),
    (error) => error instanceof StockPreparationLargeBomJobError &&
      error.code === 'LARGE_BOM_ARTIFACT_NOT_AUTHORITATIVE',
  )
}

async function testPlannerHandoffRejectsMalformedExistingRows() {
  const { storage, jobId } = await completedJobWithArtifact({ jobId: 'job-bad-existing-row' })

  await assert.rejects(
    () => planLargeBomBackgroundExpansionJob({
      storage,
      ...TEST_SCOPE,
      actionId: 'plm.stock-preparation.pull-bom.v1',
      jobId,
      existingRows: [null],
    }),
    (error) => error instanceof StockPreparationLargeBomJobError &&
      error.code === 'LARGE_BOM_PLAN_EXISTING_ROWS_INVALID' &&
      error.details.index === 0,
  )

  const loaded = await loadLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    actionId: 'plm.stock-preparation.pull-bom.v1',
    jobId,
  })
  assert.equal(loaded.planRevision, undefined, 'malformed existingRows must not persist a plan')
}

async function testPlannerHandoffStoresValuesFreePlanEvidence() {
  const { storage, jobId } = await completedJobWithArtifact()
  const planned = await planLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    actionId: 'plm.stock-preparation.pull-bom.v1',
    jobId,
    existingRows: [{
      idempotencyKey: 'EXISTING_TARGET_VALUE_SHOULD_NOT_APPEAR',
      projectNo: 'PROJECT_VALUE_SHOULD_NOT_APPEAR',
      componentSourceId: 'EXISTING_TARGET_VALUE_SHOULD_NOT_APPEAR',
      componentName: 'EXISTING_TARGET_VALUE_SHOULD_NOT_APPEAR',
      active: true,
    }],
    runId: 'large-bom-plan-run',
    plannedAt: '2026-06-08T00:02:00.000Z',
    now: () => '2026-06-08T00:03:00.000Z',
  })

  assert.equal(planned.status, 'completed')
  assert.equal(planned.authoritative, true)
  assert.equal(typeof planned.planRevision, 'string')
  assert.equal(planned.planArtifact.plan.counts.add, 2, 'private plan keeps decisions for future C4')
  assert.equal(planned.planArtifact.plan.counts.manual_confirm, 0)
  assert.equal(planned.planArtifact.existingRowCount, 1)
  const publicJob = publicBackgroundExpansionJob(planned)
  assert.equal(publicJob.planRevisionPresent, true)
  assert.equal(publicJob.evidence.plan.counts.add, 2)
  assert.equal(publicJob.evidence.plan.expandedRows, 2)
  assert.equal(publicJob.evidence.plan.existingRows, 1)
  assertValuesFree(publicJob)

  const loaded = await loadLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    actionId: 'plm.stock-preparation.pull-bom.v1',
    jobId,
  })
  assert.equal(loaded.planRevision, planned.planRevision, 'plan artifact is persisted on the job')
}

async function testCheckpointApplyRequiresDurablePlanPermissionAndManualAck() {
  await assert.rejects(
    () => createLargeBomCheckpointApplyJob({
      storage: createStorage({ durable: false }),
      actionId: 'plm.stock-preparation.pull-bom.v1',
      jobId: 'missing',
      principal: 'user-1',
      permission: 'write',
      createApplyJobId: () => 'apply-job-1',
    }),
    (error) => error instanceof StockPreparationLargeBomJobError &&
      error.code === 'LARGE_BOM_JOB_STORE_UNAVAILABLE',
  )

  const storageWithoutPlan = createStorage()
  await createLargeBomBackgroundExpansionJob({
    storage: storageWithoutPlan,
    ...TEST_SCOPE,
    action: { actionId: 'plm.stock-preparation.pull-bom.v1', target: targetBinding() },
    parameters: { projectNo: 'PROJECT_VALUE_SHOULD_NOT_APPEAR' },
    principal: 'PRIVATE_TOKEN_SHOULD_NOT_APPEAR',
    createJobId: () => 'job-no-plan',
  })
  await assert.rejects(
    () => createLargeBomCheckpointApplyJob({
      storage: storageWithoutPlan,
      ...TEST_SCOPE,
      actionId: 'plm.stock-preparation.pull-bom.v1',
      jobId: 'job-no-plan',
      principal: 'user-1',
      permission: 'write',
      createApplyJobId: () => 'apply-job-no-plan',
    }),
    (error) => error instanceof StockPreparationLargeBomJobError &&
      error.code === 'LARGE_BOM_PLAN_ARTIFACT_NOT_AUTHORITATIVE',
  )

  const { storage, actionId, jobId } = await seedPlannedLargeBomJob()
  await assert.rejects(
    () => createLargeBomCheckpointApplyJob({
      storage,
      ...TEST_SCOPE,
      actionId,
      jobId,
      principal: 'user-1',
      permission: 'read',
      createApplyJobId: () => 'apply-job-read',
    }),
    (error) => error instanceof StockPreparationLargeBomJobError &&
      error.code === 'LARGE_BOM_APPLY_PERMISSION_REQUIRED' &&
      error.status === 403,
  )

  const manualPlan = planWithDecisions([
    addDecision('PROJECT_VALUE_SHOULD_NOT_APPEAR::KEY-1'),
    manualConfirmDecision('PROJECT_VALUE_SHOULD_NOT_APPEAR::HELD-1'),
  ])
  const seeded = await seedPlannedLargeBomJob({ plan: manualPlan, jobId: 'job-manual-ack' })
  await assert.rejects(
    () => createLargeBomCheckpointApplyJob({
      storage: seeded.storage,
      ...TEST_SCOPE,
      actionId: seeded.actionId,
      jobId: seeded.jobId,
      principal: 'user-1',
      permission: 'write',
      createApplyJobId: () => 'apply-job-needs-ack',
    }),
    (error) => error instanceof StockPreparationLargeBomJobError &&
      error.code === 'LARGE_BOM_APPLY_MANUAL_CONFIRM_ACK_REQUIRED' &&
      error.status === 409,
  )
}

async function testCheckpointApplyChunksPlanAndKeepsPublicEvidenceValuesFree() {
  const plan = planWithDecisions([
    addDecision('PROJECT_VALUE_SHOULD_NOT_APPEAR::KEY-1', { componentSourceId: 'COMPONENT_VALUE_SHOULD_NOT_APPEAR' }),
    manualConfirmDecision('PROJECT_VALUE_SHOULD_NOT_APPEAR::HELD-1'),
    addDecision('PROJECT_VALUE_SHOULD_NOT_APPEAR::KEY-2', { componentSourceId: 'CHILD_VALUE_SHOULD_NOT_APPEAR' }),
  ])
  const { storage, actionId, jobId } = await seedPlannedLargeBomJob({ plan })
  const api = createTargetRecordsApi()
  const created = await createLargeBomCheckpointApplyJob({
    storage,
    ...TEST_SCOPE,
    actionId,
    jobId,
    principal: 'user-1',
    permission: 'write',
    acceptManualConfirmHold: true,
    createApplyJobId: () => 'apply-job-chunks',
    now: () => '2026-06-08T00:01:00.000Z',
  })
  assert.equal(created.status, 'queued')
  assert.equal(created.totalDecisions, 3)
  assert.equal(created.approval.principal, 'user-1', 'private apply job records the authenticated approver')
  assert.equal(created.target.sheetId, 'sheet_stock_preparation', 'private apply job records server-configured target')

  const first = await runLargeBomCheckpointApplyJobChunk({
    storage,
    ...TEST_SCOPE,
    actionId,
    applyJobId: 'apply-job-chunks',
    recordsApi: api.recordsApi,
    maxDecisionsPerChunk: 1,
    now: () => '2026-06-08T00:02:00.000Z',
  })
  assert.equal(first.status, 'paused', 'completed non-terminal chunks are ready for the next explicit run')
  assert.equal(first.checkpoint.nextDecisionIndex, 1)
  assert.equal(first.counts.created, 1)
  assert.equal(api.rows.length, 1)

  const second = await runLargeBomCheckpointApplyJobChunk({
    storage,
    ...TEST_SCOPE,
    actionId,
    applyJobId: 'apply-job-chunks',
    recordsApi: api.recordsApi,
    maxDecisionsPerChunk: 2,
    now: () => '2026-06-08T00:03:00.000Z',
  })
  assert.equal(second.status, 'partial', 'manual_confirm remains held while clean rows write')
  assert.equal(second.checkpoint.nextDecisionIndex, 3)
  assert.equal(second.counts.created, 2)
  assert.equal(second.counts.held, 1)
  assert.equal(second.counts.failed, 0)
  assert.equal(api.rows.length, 2)
  assert.equal(api.calls.filter((call) => call[0] === 'createRecord').length, 2)

  const publicJob = publicCheckpointApplyJob(second)
  assert.equal(publicJob.jobId, 'apply-job-chunks')
  assert.equal(publicJob.status, 'partial')
  assert.equal(publicJob.planRevisionPresent, true)
  assert.equal(publicJob.targetRevisionPresent, true)
  assert.equal(publicJob.approvalPresent, true)
  assert.deepEqual(publicJob.counts, {
    created: 2,
    updated: 0,
    inactive: 0,
    skipped: 0,
    held: 1,
    failed: 0,
  })
  assert.ok(publicJob.evidence.resultStatuses.includes('created'))
  assert.ok(publicJob.evidence.resultStatuses.includes('held'))
  assert.ok(publicJob.evidence.fieldCategories.includes('plm_system'))
  assertValuesFree(publicJob)

  const loaded = await loadLargeBomCheckpointApplyJob({
    storage,
    ...TEST_SCOPE,
    actionId,
    applyJobId: 'apply-job-chunks',
  })
  assert.equal(loaded.status, 'partial')
}

async function testCheckpointApplyMissingRecordsApiFailsBeforeRunning() {
  const { storage, actionId, jobId } = await seedPlannedLargeBomJob({ jobId: 'job-missing-records-api' })
  await createLargeBomCheckpointApplyJob({
    storage,
    ...TEST_SCOPE,
    actionId,
    jobId,
    principal: 'user-1',
    permission: 'write',
    createApplyJobId: () => 'apply-job-missing-records-api',
  })

  await assert.rejects(
    () => runLargeBomCheckpointApplyJobChunk({
      storage,
      ...TEST_SCOPE,
      actionId,
      applyJobId: 'apply-job-missing-records-api',
      recordsApi: {},
      maxDecisionsPerChunk: 1,
    }),
    (error) => error instanceof StockPreparationLargeBomJobError &&
      error.code === 'LARGE_BOM_APPLY_RECORDS_API_UNAVAILABLE' &&
      error.status === 501,
  )

  const loaded = await loadLargeBomCheckpointApplyJob({
    storage,
    ...TEST_SCOPE,
    actionId,
    applyJobId: 'apply-job-missing-records-api',
  })
  assert.equal(loaded.status, 'queued', 'missing recordsApi fails before marking the job running')
  assert.equal(loaded.checkpoint.nextDecisionIndex, 0, 'missing recordsApi does not advance the checkpoint')
}

async function testCheckpointApplySingleFlightRejectsConcurrentQueuedRun() {
  const plan = planWithDecisions([addDecision('PROJECT_VALUE_SHOULD_NOT_APPEAR::CONCURRENT-KEY')])
  const { storage, actionId, jobId } = await seedPlannedLargeBomJob({ plan, jobId: 'job-single-flight-apply' })
  const api = createBlockingTargetRecordsApi()
  await createLargeBomCheckpointApplyJob({
    storage,
    ...TEST_SCOPE,
    actionId,
    jobId,
    principal: 'user-1',
    permission: 'admin',
    createApplyJobId: () => 'apply-job-single-flight',
  })

  const firstRun = runLargeBomCheckpointApplyJobChunk({
    storage,
    ...TEST_SCOPE,
    actionId,
    applyJobId: 'apply-job-single-flight',
    recordsApi: api.recordsApi,
    maxDecisionsPerChunk: 1,
  })
  await api.firstCreateEntered

  await assert.rejects(
    () => runLargeBomCheckpointApplyJobChunk({
      storage,
      ...TEST_SCOPE,
      actionId,
      applyJobId: 'apply-job-single-flight',
      recordsApi: api.recordsApi,
      maxDecisionsPerChunk: 1,
    }),
    (error) => error instanceof StockPreparationLargeBomJobError &&
      error.code === 'LARGE_BOM_APPLY_RUN_IN_PROGRESS' &&
      error.status === 409,
  )
  assert.equal(api.rows.length, 0, 'second concurrent run is rejected while the first chunk is in flight')

  api.releaseFirstCreate()
  const completed = await firstRun
  assert.equal(completed.status, 'succeeded')
  assert.equal(completed.counts.created, 1)
  assert.equal(api.rows.length, 1)
  assert.equal(api.calls.filter((call) => call[0] === 'createRecord').length, 1)
}

async function testCheckpointApplyRejectsConcurrentRunningChunk() {
  const key = 'PROJECT_VALUE_SHOULD_NOT_APPEAR::IDEMPOTENT-KEY'
  const plan = planWithDecisions([addDecision(key)])
  const { storage, actionId, jobId } = await seedPlannedLargeBomJob({ plan, jobId: 'job-concurrent-apply' })
  const api = createTargetRecordsApi()
  await createLargeBomCheckpointApplyJob({
    storage,
    ...TEST_SCOPE,
    actionId,
    jobId,
    principal: 'user-1',
    permission: 'admin',
    createApplyJobId: () => 'apply-job-concurrent',
  })

  const first = await runLargeBomCheckpointApplyJobChunk({
    storage,
    ...TEST_SCOPE,
    actionId,
    applyJobId: 'apply-job-concurrent',
    recordsApi: api.recordsApi,
    maxDecisionsPerChunk: 1,
  })
  assert.equal(first.status, 'succeeded')
  assert.equal(first.counts.created, 1)
  assert.equal(api.rows.length, 1)

  const applyKey = __internals.checkpointApplyJobKey({ ...TEST_SCOPE, actionId, applyJobId: 'apply-job-concurrent' })
  const persisted = await storage.get(applyKey)
  persisted.status = 'running'
  persisted.checkpoint.nextDecisionIndex = 0
  persisted.counts = {
    created: 0,
    updated: 0,
    inactive: 0,
    skipped: 0,
    held: 0,
    failed: 0,
  }
  persisted.evidence = {
    resultStatuses: [],
    errorCodes: [],
    fieldCategories: ['plm_system'],
  }
  await storage.set(applyKey, persisted)

  await assert.rejects(
    () => runLargeBomCheckpointApplyJobChunk({
      storage,
      ...TEST_SCOPE,
      actionId,
      applyJobId: 'apply-job-concurrent',
      recordsApi: api.recordsApi,
      maxDecisionsPerChunk: 1,
    }),
    (error) => error instanceof StockPreparationLargeBomJobError &&
      error.code === 'LARGE_BOM_APPLY_RUN_IN_PROGRESS' &&
      error.status === 409,
  )
  assert.equal(api.rows.length, 1, 'concurrent run rejection keeps a single target row')
  assert.equal(api.calls.filter((call) => call[0] === 'createRecord').length, 1)
  assert.equal(api.calls.filter((call) => call[0] === 'patchRecord').length, 0)

  const loaded = await loadLargeBomCheckpointApplyJob({
    storage,
    ...TEST_SCOPE,
    actionId,
    applyJobId: 'apply-job-concurrent',
  })
  assert.equal(loaded.status, 'running', 'concurrent rejection does not mutate the in-flight job')
  assertValuesFree(publicCheckpointApplyJob(loaded))
}

async function main() {
  testStatusEnumsArePinned()
  testBackgroundEvidenceIsValuesFreeProjection()
  testBackgroundEvidenceRejectsUnsafeTokens()
  testAuthoritativeExpansionGate()
  testCheckpointApplyEvidenceIsValuesFreeProjection()
  testInvalidStatusAndCountsFailClosed()
  await testBackgroundJobStoreRequiresDurableStorageAndPrincipal()
  await testBackgroundJobLifecycleIsValuesFree()
  await testBackgroundWorkerCompletesAuthoritativeArtifactWithoutPublicValues()
  testBackgroundCapDerivationAndCeilings()
  testBackgroundCapConfigBlockParsing()
  await testBackgroundWorkerScalesPastTheInteractiveScaleBudget()
  await testBackgroundWorkerFailsNonAuthoritativeOnScaleBudget()
  await testBackgroundBudgetsAreRecordedBeforeTheSourceRead()
  await testBackgroundWorkerStoresFailedJobWhenErrorTokenIsUnsafe()
  await testBackgroundWorkerPersistsValuesFreeReadFailureDiagnostics()
  await testEscapedThrowKeepsCauseClassWithoutReadFailures()
  await testFailedExpansionWarnsOnceWithValuesFreePayload()
  await testEscapedThrowWarnsOnceWithoutReadFailureKeys()
  await testSuccessDoesNotWarnAndMissingLoggerIsInert()
  await testObjectLessBoundedExpansionKeepsThePreFeatureKeySet()
  testBoundedErrorsThatNameAnObjectStillMount()
  testReadFailureDetailsAreCappedAndReportTheRealTotal()
  testDetailCapBoundaryIsExact()
  testTotalCountsCandidatesNotSurvivors()
  testErrorDetailTotalCountsCandidatesNotSurvivors()
  testPublicProjectionRepairsIncoherentStoredCounters()
  testFilterFieldsAreBoundedPerEntry()
  await testSuccessfulRunHasNoReadFailureKeys()
  await testPlannerHandoffRequiresAuthoritativeArtifact()
  await testPlannerHandoffRejectsMalformedExistingRows()
  await testPlannerHandoffStoresValuesFreePlanEvidence()
  await testCheckpointApplyRequiresDurablePlanPermissionAndManualAck()
  await testCheckpointApplyChunksPlanAndKeepsPublicEvidenceValuesFree()
  await testCheckpointApplyMissingRecordsApiFailsBeforeRunning()
  await testCheckpointApplySingleFlightRejectsConcurrentQueuedRun()
  await testCheckpointApplyRejectsConcurrentRunningChunk()
}

main().catch((err) => {
  console.error('stock-preparation-large-bom-jobs FAILED')
  console.error(err)
  process.exit(1)
})
