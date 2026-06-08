'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  LARGE_BOM_BACKGROUND_EXPANSION_STATUSES,
  LARGE_BOM_CHECKPOINT_APPLY_STATUSES,
  StockPreparationLargeBomJobError,
  assertAuthoritativeLargeBomExpansion,
  isAuthoritativeLargeBomExpansion,
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

function main() {
  testStatusEnumsArePinned()
  testBackgroundEvidenceIsValuesFreeProjection()
  testBackgroundEvidenceRejectsUnsafeTokens()
  testAuthoritativeExpansionGate()
  testCheckpointApplyEvidenceIsValuesFreeProjection()
  testInvalidStatusAndCountsFailClosed()
}

main()
