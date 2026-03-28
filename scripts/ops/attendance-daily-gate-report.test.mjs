import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parsePerfSummaryJson,
  parseLocaleZhSummaryJson,
  parsePreflightStepSummary,
  parseStorageStepSummary,
  parseBranchProtectionStepSummary,
  pickLatestCompletedRun,
  resolveGateSignalBranch,
  resolveQueryBranchDisplayValue,
} from './attendance-daily-gate-report.mjs'

test('pickLatestCompletedRun skips excluded conclusions and falls back to previous valid run', () => {
  const list = [
    { id: 4, status: 'in_progress', conclusion: '' },
    { id: 3, status: 'completed', conclusion: 'cancelled' },
    { id: 2, status: 'completed', conclusion: 'success' },
    { id: 1, status: 'completed', conclusion: 'failure' },
  ]

  const picked = pickLatestCompletedRun(list, {
    excludeConclusions: ['cancelled', 'neutral', 'skipped'],
  })

  assert.equal(picked?.id, 2)
  assert.equal(picked?.conclusion, 'success')
})

test('pickLatestCompletedRun falls back to latest completed when all are excluded', () => {
  const list = [
    { id: 3, status: 'completed', conclusion: 'cancelled' },
    { id: 2, status: 'completed', conclusion: 'cancelled' },
    { id: 1, status: 'queued', conclusion: '' },
  ]

  const picked = pickLatestCompletedRun(list, {
    excludeConclusions: ['cancelled'],
  })

  assert.equal(picked?.id, 3)
  assert.equal(picked?.conclusion, 'cancelled')
})

test('pickLatestCompletedRun returns null when no completed run exists', () => {
  const list = [
    { id: 2, status: 'queued', conclusion: '' },
    { id: 1, status: 'in_progress', conclusion: '' },
  ]

  const picked = pickLatestCompletedRun(list, {
    excludeConclusions: ['cancelled'],
  })

  assert.equal(picked, null)
})

test('parseLocaleZhSummaryJson returns normalized pass metadata', () => {
  const payload = {
    schemaVersion: 2,
    status: 'pass',
    locale: 'zh-CN',
    authSource: 'token',
    lunarLabelCount: 28,
    holidayCheckEnabled: true,
    holidayBadgeCount: 1,
  }

  const parsed = parseLocaleZhSummaryJson(JSON.stringify(payload))
  assert.equal(parsed?.reason, null)
  assert.equal(parsed?.schemaVersion, 2)
  assert.equal(parsed?.locale, 'zh-CN')
  assert.equal(parsed?.authSource, 'token')
  assert.equal(parsed?.lunarLabelCount, '28')
  assert.equal(parsed?.holidayCheckEnabled, 'true')
  assert.equal(parsed?.holidayBadgeCount, '1')
  assert.equal(parsed?.summaryValid, true)
  assert.equal(parsed?.summaryInvalidReasons, null)
})

test('parseLocaleZhSummaryJson flags missing zh shell labels as invalid for schema v3', () => {
  const payload = {
    schemaVersion: 3,
    status: 'pass',
    locale: 'zh-CN',
    authSource: 'token',
    lunarLabelCount: 28,
    holidayCheckEnabled: true,
    holidayBadgeCount: 1,
    zhShellTabsChecked: true,
    zhLabels: {},
  }

  const parsed = parseLocaleZhSummaryJson(JSON.stringify(payload))
  assert.equal(parsed?.reason, 'SUMMARY_INVALID')
  assert.equal(parsed?.summaryValid, false)
  assert.ok(Array.isArray(parsed?.summaryInvalidReasons))
  assert.ok(parsed?.summaryInvalidReasons.includes('zh_overview_tab'))
  assert.ok(parsed?.summaryInvalidReasons.includes('zh_admin_tab'))
  assert.ok(parsed?.summaryInvalidReasons.includes('zh_workflow_tab'))
})

test('parsePerfSummaryJson normalizes async commit gate telemetry fields', () => {
  const payload = {
    schemaVersion: 3,
    scenario: 'rows10k-commit',
    rows: 10000,
    mode: 'commit',
    uploadCsv: true,
    engine: 'bulk',
    requestedImportEngine: 'bulk',
    processedRows: 10000,
    failedRows: 0,
    jobElapsedMs: 163448,
    commitMs: 20000,
    commitGateMs: 20000,
    commitGateSource: 'jobElapsedMs',
    regressions: [],
  }

  const parsed = parsePerfSummaryJson(JSON.stringify(payload))
  assert.equal(parsed?.reason, null)
  assert.equal(parsed?.scenario, 'rows10k-commit')
  assert.equal(parsed?.rows, 10000)
  assert.equal(parsed?.mode, 'commit')
  assert.equal(parsed?.uploadCsv, 'true')
  assert.equal(parsed?.commitMs, '20000')
  assert.equal(parsed?.commitGateMs, '20000')
  assert.equal(parsed?.commitGateSource, 'jobElapsedMs')
  assert.equal(parsed?.processedRows, '10000')
  assert.equal(parsed?.failedRows, '0')
})

test('resolveGateSignalBranch routes remote gates to main branch by default on non-main report branch', () => {
  const resolved = resolveGateSignalBranch({
    gateName: 'Remote Preflight',
    reportBranch: 'codex/feature-branch',
    remoteSignalBranchValue: 'main',
  })
  assert.equal(resolved, 'main')
})

test('resolveGateSignalBranch keeps strict gates on report branch', () => {
  const resolved = resolveGateSignalBranch({
    gateName: 'Strict Gates',
    reportBranch: 'codex/feature-branch',
    remoteSignalBranchValue: 'main',
  })
  assert.equal(resolved, 'codex/feature-branch')
})

test('resolveGateSignalBranch can override remote signal branch explicitly', () => {
  const resolved = resolveGateSignalBranch({
    gateName: 'Host Metrics',
    reportBranch: 'codex/feature-branch',
    remoteSignalBranchValue: 'release/ops-signal',
  })
  assert.equal(resolved, 'release/ops-signal')
})

test('resolveQueryBranchDisplayValue prefers gate query branch', () => {
  const resolved = resolveQueryBranchDisplayValue({
    gate: { queryBranch: 'main' },
    reportBranchValue: 'codex/feature-branch',
  })
  assert.equal(resolved, 'main')
})

test('resolveQueryBranchDisplayValue falls back to report branch', () => {
  const resolved = resolveQueryBranchDisplayValue({
    gate: { queryBranch: '' },
    reportBranchValue: 'codex/feature-branch',
  })
  assert.equal(resolved, 'codex/feature-branch')
})

test('parsePreflightStepSummary maps drill and known preflight reasons', () => {
  const drill = parsePreflightStepSummary('- Remote exit code: `97`')
  assert.equal(drill?.rc, '97')
  assert.equal(drill?.reason, 'DRILL_FAIL')

  const tokenMissing = parsePreflightStepSummary([
    '- Remote exit code: `1`',
    '[attendance-preflight] ERROR: ATTENDANCE_IMPORT_REQUIRE_TOKEN must be set to 1',
  ].join('\n'))
  assert.equal(tokenMissing?.rc, '1')
  assert.equal(tokenMissing?.reason, 'IMPORT_REQUIRE_TOKEN_MISSING')
})

test('parseStorageStepSummary extracts reason and storage metrics', () => {
  const summary = [
    '- Failure reason: `UPLOAD_DIR_TOO_LARGE`',
    '- Computed: df_used_pct=`82` (max=`90`), upload_gb=`13` (max=`10`), oldest_file_days=`2` (max=`14`), file_count=`1024`',
  ].join('\n')

  const parsed = parseStorageStepSummary(summary)
  assert.equal(parsed?.reason, 'UPLOAD_DIR_TOO_LARGE')
  assert.equal(parsed?.dfUsedPct, '82')
  assert.equal(parsed?.uploadGb, '13')
  assert.equal(parsed?.oldestFileDays, '2')
  assert.equal(parsed?.fileCount, '1024')
})

test('parseBranchProtectionStepSummary extracts review policy fields', () => {
  const summary = [
    '- Failure reason: `PR_REVIEWS_NOT_ENABLED`',
    '- Branch: `main`',
    '- Required checks: `contracts (strict),contracts (dashboard)`',
    '- Require strict: `true`',
    '- Require enforce admins: `true`',
    '- Require PR reviews: `false`',
    '- Min approving reviews: `0`',
    '- Require code owner reviews: `false`',
  ].join('\n')

  const parsed = parseBranchProtectionStepSummary(summary)
  assert.equal(parsed?.reason, 'PR_REVIEWS_NOT_ENABLED')
  assert.equal(parsed?.branch, 'main')
  assert.equal(parsed?.checks, 'contracts (strict),contracts (dashboard)')
  assert.equal(parsed?.strict, 'true')
  assert.equal(parsed?.enforceAdmins, 'true')
  assert.equal(parsed?.requirePrReviews, 'false')
  assert.equal(parsed?.minApprovingReviews, '0')
  assert.equal(parsed?.requireCodeOwnerReviews, 'false')
})
