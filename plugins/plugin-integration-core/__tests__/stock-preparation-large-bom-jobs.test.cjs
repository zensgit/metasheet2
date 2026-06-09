'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  LARGE_BOM_BACKGROUND_EXPANSION_STATUSES,
  LARGE_BOM_CHECKPOINT_APPLY_STATUSES,
  StockPreparationLargeBomJobError,
  assertAuthoritativeLargeBomExpansion,
  cancelLargeBomBackgroundExpansionJob,
  createLargeBomBackgroundExpansionJob,
  isAuthoritativeLargeBomExpansion,
  loadLargeBomBackgroundExpansionJob,
  planLargeBomBackgroundExpansionJob,
  publicBackgroundExpansionJob,
  runLargeBomBackgroundExpansionJob,
  summarizeLargeBomBackgroundExpansionJobForEvidence,
  summarizeLargeBomCheckpointApplyJobForEvidence,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-large-bom-jobs.cjs'))

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

async function testBackgroundWorkerFailsNonAuthoritativeOnScaleBudget() {
  const storage = createStorage()
  const source = createSourceAdapter(plmData())
  await createLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    action: {
      actionId: 'plm.stock-preparation.pull-bom.v1',
      source: { kind: 'data-source:sql-readonly' },
    },
    parameters: { projectNo: 'PROJECT_VALUE_SHOULD_NOT_APPEAR' },
    principal: 'PRIVATE_TOKEN_SHOULD_NOT_APPEAR',
    createJobId: () => 'job-failed-1',
    now: () => '2026-06-08T00:00:00.000Z',
  })

  const failed = await runLargeBomBackgroundExpansionJob({
    storage,
    ...TEST_SCOPE,
    actionId: 'plm.stock-preparation.pull-bom.v1',
    jobId: 'job-failed-1',
    sourceAdapter: source.adapter,
    expansionOptions: { maxRows: 1 },
    now: () => '2026-06-08T00:01:00.000Z',
  })

  assert.equal(failed.status, 'failed')
  assert.equal(failed.authoritative, false)
  assert.equal(failed.artifact, undefined)
  const publicJob = publicBackgroundExpansionJob(failed)
  assert.equal(publicJob.authoritative, false)
  assert.equal(publicJob.artifactRevisionPresent, false)
  assert.ok(publicJob.evidence.errorTypes.includes('max_rows_exceeded'))
  assert.ok(publicJob.evidence.scaleErrorTypes.includes('max_rows_exceeded'))
  assertValuesFree(publicJob)
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
  await testBackgroundWorkerFailsNonAuthoritativeOnScaleBudget()
  await testBackgroundWorkerStoresFailedJobWhenErrorTokenIsUnsafe()
  await testPlannerHandoffRequiresAuthoritativeArtifact()
  await testPlannerHandoffRejectsMalformedExistingRows()
  await testPlannerHandoffStoresValuesFreePlanEvidence()
}

main().catch((err) => {
  console.error('stock-preparation-large-bom-jobs FAILED')
  console.error(err)
  process.exit(1)
})
