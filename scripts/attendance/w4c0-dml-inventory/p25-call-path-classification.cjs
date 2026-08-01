'use strict'

// #4556 W4C-3a P25 — generated static call-path guard. This is intentionally a closed
// classification ledger: a new read/write, a renamed enclosing wrapper, or a changed number of
// sites fails instead of inheriting a broad operational-table allowlist.

const { assertP25Use } = require('./table-classification.cjs')

const P25_IDENTITY_ADAPTER_PATHS = Object.freeze({
  enqueue: ['packages/core-backend/src/attendance/w4c3a-legacy-plan-enqueue.ts'],
  private_worker: ['packages/core-backend/src/attendance/w4c3a-legacy-plan-worker-repository.ts'],
})

const P25_IDENTITY_ROLES = new Set([
  'compatibility_transport',
  'retryable_job_identity_claim',
  'identity_transport',
])

function entry(relPath, enclosingSymbol, table, access, verb, count, role, adapter) {
  return Object.freeze({ relPath, enclosingSymbol, table, access, verb, count, role, adapter })
}

const P25_CALL_PATH_CLASSIFICATIONS = Object.freeze([
  entry('packages/core-backend/scripts/encrypt-dingtalk-integration-secrets.ts', 'runIntegrationBackfill', 'attendance_integrations', 'read', 'select', 1, 'configuration_maintenance', 'maintenance_script'),
  entry('packages/core-backend/src/attendance/w4c0-operation-registry.ts', 'attendanceResultOperationPreflightV1', 'attendance_import_jobs', 'read', 'select', 1, 'concurrency_control', 'sync_rejection_preflight'),
  entry('packages/core-backend/src/attendance/w4c3a-import-rollback-boundary.ts', 'legacyDeleteEligible', 'attendance_import_jobs', 'read', 'select', 1, 'concurrency_control', 'rollback_rejection_preflight'),
  entry('packages/core-backend/src/attendance/w4c3a-import-rollback.ts', 'readAttendanceImportRollbackSourceJobsV1', 'attendance_import_jobs', 'read', 'select', 1, 'concurrency_control', 'rollback_rejection_preflight'),
  entry('packages/core-backend/src/attendance/w4c3a-legacy-plan-enqueue.ts', 'assertPreCutoverImportWorkersDrainedV1', 'attendance_import_jobs', 'read', 'select', 1, 'concurrency_control', 'enqueue'),
  entry('packages/core-backend/src/attendance/w4c3a-legacy-plan-enqueue.ts', 'reserveAttendanceLegacyImportPlanJobV1', 'attendance_import_jobs', 'read', 'select', 1, 'retryable_job_identity_claim', 'enqueue'),
  entry('packages/core-backend/src/attendance/w4c3a-legacy-plan-enqueue.ts', 'persistAttendanceLegacyImportPlanEnqueueV1', 'attendance_import_jobs', 'write', 'insert', 1, 'identity_transport', 'enqueue'),
  entry('packages/core-backend/src/attendance/w4c3a-legacy-plan-enqueue.ts', 'persistAttendanceLegacyImportPlanEnqueueV1', 'attendance_import_legacy_execution_plans', 'write', 'insert', 1, 'identity_transport', 'enqueue'),
  entry('packages/core-backend/src/attendance/w4c3a-legacy-plan-enqueue.ts', 'persistAttendanceLegacyImportPlanEnqueueV1', 'attendance_import_legacy_execution_plan_chunks', 'write', 'insert', 1, 'identity_transport', 'enqueue'),
  entry('packages/core-backend/src/attendance/w4c3a-legacy-plan-worker-repository.ts', 'mapStoredChunk', 'attendance_import_jobs', 'read', 'select', 2, 'compatibility_transport', 'private_worker'),
  entry('packages/core-backend/src/attendance/w4c3a-legacy-plan-worker-repository.ts', 'mapStoredChunk', 'attendance_import_legacy_execution_plans', 'read', 'select', 2, 'compatibility_transport', 'private_worker'),
  entry('packages/core-backend/src/attendance/w4c3a-legacy-plan-worker-repository.ts', 'mapStoredChunk', 'attendance_import_legacy_execution_plan_chunks', 'read', 'select', 1, 'compatibility_transport', 'private_worker'),
  entry('packages/core-backend/src/attendance/w4c3a-legacy-plan-worker-repository.ts', 'mapStoredChunk', 'attendance_import_legacy_terminal_responses', 'read', 'select', 1, 'compatibility_transport', 'private_worker'),
  entry('packages/core-backend/src/attendance/w4c3a-legacy-plan-worker-repository.ts', 'mapStoredChunk', 'attendance_import_jobs', 'write', 'update', 4, 'operational_status', 'private_worker'),
  entry('packages/core-backend/src/attendance/w4c3a-legacy-plan-worker-repository.ts', 'mapStoredChunk', 'attendance_import_legacy_terminal_responses', 'write', 'insert', 1, 'compatibility_transport', 'private_worker'),
  entry('packages/core-backend/src/attendance/w4c3a-legacy-plan-worker-repository.ts', 'mapStoredChunk', 'attendance_import_upload_cleanup_commands', 'write', 'insert', 1, 'operational_status', 'private_worker'),
  entry('packages/core-backend/src/attendance/w4c3a-rollout-control.ts', 'lockJobsBatchesAndItems', 'attendance_import_jobs', 'read', 'select', 1, 'concurrency_control', 'rollout_transition_guard'),
  entry('packages/core-backend/src/attendance/w4c3a-rollout-control.ts', 'loadBatchReferenceState', 'attendance_import_jobs', 'read', 'select', 1, 'concurrency_control', 'rollout_transition_guard'),
  entry('packages/core-backend/src/attendance/w4c3a-sync-import-host.ts', 'assertNoBlockingV1Job', 'attendance_import_jobs', 'read', 'select', 1, 'concurrency_control', 'sync_rejection_preflight'),
  entry('packages/core-backend/src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage.ts', 'down', 'attendance_import_jobs', 'read', 'select', 1, 'schema_migration', 'migration'),
  entry('packages/core-backend/src/db/migrations/zzzz20260730120000_w4c3a_durable_legacy_execution_plan.ts', 'rejectExistingV1', 'attendance_import_jobs', 'read', 'select', 1, 'schema_migration', 'migration'),
  entry('packages/core-backend/src/db/migrations/zzzz20260730120000_w4c3a_durable_legacy_execution_plan.ts', 'up', 'attendance_import_upload_cleanup_commands', 'read', 'select', 4, 'schema_migration', 'migration'),
  entry('packages/core-backend/src/db/migrations/zzzz20260730120000_w4c3a_durable_legacy_execution_plan.ts', 'up', 'attendance_import_upload_cleanup_commands', 'write', 'update', 2, 'schema_migration', 'migration'),
  entry('packages/core-backend/src/db/migrations/zzzz20260730120000_w4c3a_durable_legacy_execution_plan.ts', 'up', 'attendance_import_jobs', 'read', 'select', 1, 'schema_migration', 'migration'),
  entry('packages/core-backend/src/db/migrations/zzzz20260730120000_w4c3a_durable_legacy_execution_plan.ts', 'up', 'attendance_import_legacy_execution_plans', 'read', 'select', 3, 'schema_migration', 'migration'),
  entry('packages/core-backend/src/db/migrations/zzzz20260730120000_w4c3a_durable_legacy_execution_plan.ts', 'up', 'attendance_import_legacy_execution_plan_chunks', 'read', 'select', 8, 'schema_migration', 'migration'),
  entry('packages/core-backend/src/db/migrations/zzzz20260730120000_w4c3a_durable_legacy_execution_plan.ts', 'up', 'attendance_import_legacy_terminal_responses', 'read', 'select', 3, 'schema_migration', 'migration'),
  entry('packages/core-backend/src/db/migrations/zzzz20260730120000_w4c3a_durable_legacy_execution_plan.ts', 'down', 'attendance_import_jobs', 'read', 'select', 1, 'schema_migration', 'migration'),
  entry('packages/core-backend/src/db/migrations/zzzz20260730120000_w4c3a_durable_legacy_execution_plan.ts', 'down', 'attendance_import_legacy_execution_plans', 'read', 'select', 1, 'schema_migration', 'migration'),
  entry('packages/core-backend/src/db/migrations/zzzz20260730120000_w4c3a_durable_legacy_execution_plan.ts', 'down', 'attendance_import_legacy_execution_plan_chunks', 'read', 'select', 1, 'schema_migration', 'migration'),
  entry('packages/core-backend/src/db/migrations/zzzz20260730120000_w4c3a_durable_legacy_execution_plan.ts', 'down', 'attendance_import_legacy_terminal_responses', 'read', 'select', 1, 'schema_migration', 'migration'),
  entry('packages/core-backend/src/db/migrations/zzzz20260730120000_w4c3a_durable_legacy_execution_plan.ts', 'down', 'attendance_import_upload_cleanup_commands', 'read', 'select', 1, 'schema_migration', 'migration'),
  entry('plugins/plugin-attendance/index.cjs', 'pruneImportCommitTokensDb', 'attendance_import_tokens', 'write', 'delete', 1, 'transport', 'token_lifecycle'),
  entry('plugins/plugin-attendance/index.cjs', 'createImportCommitToken', 'attendance_import_tokens', 'write', 'insert', 2, 'transport', 'token_lifecycle'),
  entry('plugins/plugin-attendance/index.cjs', 'consumeImportCommitToken', 'attendance_import_tokens', 'write', 'delete', 3, 'transport', 'token_lifecycle'),
  entry('plugins/plugin-attendance/index.cjs', 'consumeImportCommitToken', 'attendance_import_tokens', 'read', 'select', 1, 'transport', 'token_lifecycle'),
  entry('plugins/plugin-attendance/index.cjs', 'loadAttendanceV1ImportReservationForSync', 'attendance_import_jobs', 'read', 'select', 1, 'concurrency_control', 'sync_rejection_preflight'),
  entry('plugins/plugin-attendance/index.cjs', 'createIntegrationRun', 'attendance_integration_runs', 'write', 'insert', 1, 'audit_attempt', 'integration_audit'),
  entry('plugins/plugin-attendance/index.cjs', 'updateIntegrationRun', 'attendance_integration_runs', 'write', 'update', 1, 'audit_attempt', 'integration_audit'),
  entry('plugins/plugin-attendance/index.cjs', 'copyAttendanceImportRowsToStage', 'attendance_import_records_stage', 'write', 'copy', 1, 'transport', 'staging_transport'),
  entry('plugins/plugin-attendance/index.cjs', 'copyAttendanceImportItemsToStage', 'attendance_import_items_stage', 'write', 'copy', 1, 'transport', 'staging_transport'),
  entry('plugins/plugin-attendance/index.cjs', 'ensureAttendanceImportRecordsStageTable', 'attendance_import_records_stage', 'write', 'staging_create', 1, 'transport', 'staging_transport'),
  entry('plugins/plugin-attendance/index.cjs', 'batchUpsertAttendanceRecordsStaging', 'attendance_import_records_stage', 'write', 'truncate', 3, 'transport', 'staging_transport'),
  entry('plugins/plugin-attendance/index.cjs', 'batchUpsertAttendanceRecordsStaging', 'attendance_import_records_stage', 'write', 'insert', 1, 'transport', 'staging_transport'),
  entry('plugins/plugin-attendance/index.cjs', 'batchUpsertAttendanceRecordsStaging', 'attendance_import_records_stage', 'read', 'select', 1, 'transport', 'staging_transport'),
  entry('plugins/plugin-attendance/index.cjs', 'batchInsertAttendanceImportItemsStaging', 'attendance_import_items_stage', 'write', 'truncate', 3, 'transport', 'staging_transport'),
  entry('plugins/plugin-attendance/index.cjs', 'ensureAttendanceImportItemsStageTable', 'attendance_import_items_stage', 'write', 'staging_create', 1, 'transport', 'staging_transport'),
  entry('plugins/plugin-attendance/index.cjs', 'batchInsertAttendanceImportItemsStaging', 'attendance_import_items_stage', 'write', 'insert', 1, 'transport', 'staging_transport'),
  entry('plugins/plugin-attendance/index.cjs', 'batchInsertAttendanceImportItemsStaging', 'attendance_import_items_stage', 'read', 'select', 1, 'transport', 'staging_transport'),
  entry('plugins/plugin-attendance/index.cjs', 'buildImportJobProjectionSql', 'attendance_import_jobs', 'read', 'select', 1, 'operational_status', 'job_status_reader'),
  entry('plugins/plugin-attendance/index.cjs', 'buildImportJobProjectionSql', 'attendance_import_legacy_terminal_responses', 'read', 'select', 1, 'operational_status', 'job_status_reader'),
  entry('plugins/plugin-attendance/index.cjs', 'updateImportJobProgress', 'attendance_import_jobs', 'write', 'update', 1, 'operational_status', 'legacy_async_worker'),
  entry('plugins/plugin-attendance/index.cjs', 'processAsyncImportPreviewJob', 'attendance_import_jobs', 'write', 'update', 1, 'operational_status', 'legacy_async_worker'),
  entry('plugins/plugin-attendance/index.cjs', 'drainImportUploadCleanupCommand', 'attendance_import_upload_cleanup_commands', 'read', 'select', 1, 'operational_status', 'upload_cleanup_worker'),
  entry('plugins/plugin-attendance/index.cjs', 'processAsyncImportCommitJob', 'attendance_import_jobs', 'read', 'select', 2, 'operational_status', 'legacy_async_worker'),
  entry('plugins/plugin-attendance/index.cjs', 'runAttendanceLegacyNullVersionCommitAtomically', 'attendance_import_jobs', 'read', 'select', 1, 'operational_status', 'legacy_async_worker'),
  entry('plugins/plugin-attendance/index.cjs', 'runAttendanceLegacyNullVersionCommitAtomically', 'attendance_import_jobs', 'write', 'update', 1, 'operational_status', 'legacy_async_worker'),
  entry('plugins/plugin-attendance/index.cjs', 'drainAttendanceImportStartupRecoveryPages', 'attendance_import_jobs', 'read', 'select', 2, 'operational_status', 'legacy_async_worker'),
  entry('plugins/plugin-attendance/index.cjs', 'drainAttendanceImportStartupRecoveryPages', 'attendance_import_upload_cleanup_commands', 'read', 'select', 1, 'operational_status', 'upload_cleanup_worker'),
  entry('plugins/plugin-attendance/index.cjs', 'getTemplatePrefsActorId', 'attendance_import_template_prefs', 'read', 'select', 1, 'configuration_maintenance', 'template_preferences'),
  entry('plugins/plugin-attendance/index.cjs', 'getTemplatePrefsActorId', 'attendance_import_template_prefs', 'write', 'delete', 1, 'configuration_maintenance', 'template_preferences'),
  entry('plugins/plugin-attendance/index.cjs', 'getTemplatePrefsActorId', 'attendance_import_template_prefs', 'write', 'insert', 1, 'configuration_maintenance', 'template_preferences'),
  entry('plugins/plugin-attendance/index.cjs', 'dataTypeFor', 'attendance_import_jobs', 'write', 'insert', 1, 'operational_status', 'legacy_plugin_compatibility'),
  entry('plugins/plugin-attendance/index.cjs', 'dataTypeFor', 'attendance_integrations', 'read', 'select', 4, 'configuration_maintenance', 'integration_configuration'),
  entry('plugins/plugin-attendance/index.cjs', 'dataTypeFor', 'attendance_integrations', 'write', 'insert', 1, 'configuration_maintenance', 'integration_configuration'),
  entry('plugins/plugin-attendance/index.cjs', 'dataTypeFor', 'attendance_integrations', 'write', 'update', 2, 'configuration_maintenance', 'integration_configuration'),
  entry('plugins/plugin-attendance/index.cjs', 'dataTypeFor', 'attendance_integrations', 'write', 'delete', 1, 'configuration_maintenance', 'integration_configuration'),
  entry('plugins/plugin-attendance/index.cjs', 'dataTypeFor', 'attendance_integration_runs', 'read', 'select', 2, 'audit_attempt', 'integration_audit'),
  entry('scripts/ops/staging-attendance-ae4-result-edit-smoke.mjs', 'row', 'attendance_import_jobs', 'read', 'select', 1, 'tooling_cleanup', 'staging_smoke'),
  entry('scripts/ops/staging-attendance-ae4-result-edit-smoke.mjs', 'residueCounts', 'attendance_import_jobs', 'read', 'select', 1, 'tooling_cleanup', 'staging_smoke'),
  entry('scripts/ops/staging-attendance-ae4-result-edit-smoke.mjs', 'cleanup', 'attendance_import_jobs', 'write', 'delete', 1, 'tooling_cleanup', 'staging_smoke'),
])

function keyOf(site) {
  return [site.relPath, site.enclosingSymbol, site.table, site.access, site.verb].join(' :: ')
}

function assertIdentityAdapterPath(classification) {
  if (!P25_IDENTITY_ROLES.has(classification.role)) return
  const allowedPaths = P25_IDENTITY_ADAPTER_PATHS[classification.adapter]
  if (!allowedPaths || !allowedPaths.includes(classification.relPath)) {
    const error = new Error(`ATTENDANCE_P25_IDENTITY_ADAPTER_PATH_FORBIDDEN: ${keyOf(classification)}`)
    error.code = 'ATTENDANCE_P25_IDENTITY_ADAPTER_PATH_FORBIDDEN'
    throw error
  }
}

function classifyP25CallPathSites(sites, classifications = P25_CALL_PATH_CLASSIFICATIONS) {
  const expected = new Map()
  for (const classification of classifications) {
    const key = keyOf(classification)
    if (expected.has(key)) throw new Error(`ATTENDANCE_P25_DUPLICATE_CALL_PATH_CLASSIFICATION: ${key}`)
    assertIdentityAdapterPath(classification)
    assertP25Use(classification)
    expected.set(key, classification)
  }

  const actual = new Map()
  for (const site of sites) {
    const key = keyOf(site)
    const values = actual.get(key) || []
    values.push(site)
    actual.set(key, values)
  }

  const unclassified = []
  const countDrift = []
  const classifiedSites = []
  for (const [key, values] of actual) {
    const classification = expected.get(key)
    if (!classification) {
      unclassified.push(...values)
      continue
    }
    if (classification.count !== values.length) {
      countDrift.push({ key, expected: classification.count, actual: values.length })
      if (values.length > classification.count) unclassified.push(...values.slice(classification.count))
    }
    classifiedSites.push(...values.slice(0, classification.count).map((site) => ({ ...site, role: classification.role, adapter: classification.adapter })))
  }
  const stale = [...expected.values()].filter((classification) => !actual.has(keyOf(classification)))
  return { unclassified, countDrift, stale, classifiedSites, classifiedCount: sites.length }
}

module.exports = {
  P25_CALL_PATH_CLASSIFICATIONS,
  P25_IDENTITY_ADAPTER_PATHS,
  classifyP25CallPathSites,
  keyOf,
}
