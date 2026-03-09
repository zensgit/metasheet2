import test from 'node:test'
import assert from 'node:assert/strict'
import { parseLocaleZhSummaryJson, pickLatestCompletedRun, resolveGateSignalBranch } from './attendance-daily-gate-report.mjs'

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
    schemaVersion: 1,
    status: 'pass',
    locale: 'zh-CN',
    lunarCount: 28,
    holidayCheck: 'enabled',
    holidayBadgeCount: 1,
    holidayCalendarLabel: '二月 2026',
  }

  const parsed = parseLocaleZhSummaryJson(JSON.stringify(payload))
  assert.equal(parsed?.reason, null)
  assert.equal(parsed?.schemaVersion, 1)
  assert.equal(parsed?.locale, 'zh-CN')
  assert.equal(parsed?.lunarCount, '28')
  assert.equal(parsed?.holidayCheck, 'enabled')
  assert.equal(parsed?.holidayBadgeCount, '1')
  assert.equal(parsed?.holidayCalendarLabel, '二月 2026')
})

test('parseLocaleZhSummaryJson flags missing lunar labels as invalid', () => {
  const payload = {
    schemaVersion: 1,
    status: 'pass',
    locale: 'zh-CN',
    lunarCount: 0,
    holidayCheck: 'enabled',
    holidayBadgeCount: 1,
  }

  const parsed = parseLocaleZhSummaryJson(JSON.stringify(payload))
  assert.equal(parsed?.reason, 'LUNAR_LABELS_MISSING')
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
