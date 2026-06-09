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
  publicBackgroundExpansionJob,
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
  assert.deepEqual(running.details, { status: 'running', authoritative: false })

  assertLargeBomJobError(
    () => assertAuthoritativeLargeBomExpansion({ status: 'completed', authoritative: false }),
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

async function main() {
  testStatusEnumsArePinned()
  testBackgroundEvidenceIsValuesFreeProjection()
  testBackgroundEvidenceRejectsUnsafeTokens()
  testAuthoritativeExpansionGate()
  testCheckpointApplyEvidenceIsValuesFreeProjection()
  testInvalidStatusAndCountsFailClosed()
  await testBackgroundJobStoreRequiresDurableStorageAndPrincipal()
  await testBackgroundJobLifecycleIsValuesFree()
}

main().catch((err) => {
  console.error('stock-preparation-large-bom-jobs FAILED')
  console.error(err)
  process.exit(1)
})
