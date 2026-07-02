import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  STAMP_PATTERN,
  RESTORED_POLICY_KEYS,
  CASE_PLAN,
  addDays,
  isWeekend,
  firstMondayOfMonth,
  lastDayOfMonth,
  pickSmokeYear,
  buildSmokeWindow,
  buildRestoreSettingsBody,
  isStampedId,
  resolveEnvConfig,
} from './staging-attendance-overtime-bank-v18-smoke.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const script = readFileSync(join(here, 'staging-attendance-overtime-bank-v18-smoke.mjs'), 'utf8')
const runbook = readFileSync(join(here, '../../docs/development/attendance-overtime-bank-v18-staging-smoke-runbook-20260702.md'), 'utf8')

test('v1-8 env contract: BASE_URL/DATABASE_URL/DEPLOY_SHA required, STAMP regex-locked, defaults applied', () => {
  const missing = resolveEnvConfig({})
  assert.equal(missing.ok, false)
  assert.ok(missing.errors.some(msg => msg.includes('BASE_URL and DATABASE_URL')))
  assert.ok(missing.errors.some(msg => msg.includes('DEPLOY_SHA is required')))

  const placeholder = resolveEnvConfig({
    BASE_URL: 'http://127.0.0.1:8082',
    DATABASE_URL: 'postgresql://u@127.0.0.1:5432/metasheet',
    DEPLOY_SHA: '<fill-from-staging-build>',
  })
  assert.equal(placeholder.ok, false)
  assert.ok(placeholder.errors.some(msg => msg.includes('DEPLOY_SHA is required')))

  const good = resolveEnvConfig({
    BASE_URL: 'http://127.0.0.1:8082/',
    DATABASE_URL: 'postgresql://u@127.0.0.1:5432/metasheet',
    DEPLOY_SHA: 'abc123def456',
  })
  assert.equal(good.ok, true)
  assert.equal(good.config.baseUrl, 'http://127.0.0.1:8082', 'trailing slash stripped')
  assert.equal(good.config.orgId, 'default')
  assert.match(good.config.stamp, STAMP_PATTERN)
  assert.ok(good.config.stamp.startsWith('otbank-v18-smoke-'))
  assert.equal(good.config.allowNonSyntheticPopulation, false)

  const badStamp = resolveEnvConfig({
    BASE_URL: 'http://127.0.0.1:8082',
    DATABASE_URL: 'postgresql://u@127.0.0.1:5432/metasheet',
    DEPLOY_SHA: 'abc123def456',
    STAMP: 'ae4-smoke-wrong-family',
  })
  assert.equal(badStamp.ok, false)
  assert.ok(badStamp.errors.some(msg => msg.includes('otbank-v18-smoke')))

  const override = resolveEnvConfig({
    BASE_URL: 'http://127.0.0.1:8082',
    DATABASE_URL: 'postgresql://u@127.0.0.1:5432/metasheet',
    DEPLOY_SHA: 'abc123def456',
    SMOKE_YEAR: '2055',
    ALLOW_NON_SYNTHETIC_SETTLEMENT_POPULATION: '1',
  })
  assert.equal(override.config.year, 2055)
  assert.equal(override.config.allowNonSyntheticPopulation, true)
})

test('v1-8 window builder: far-future month, weekday smoke dates inside the settlement period', () => {
  assert.ok(pickSmokeYear('abc') >= 2041 && pickSmokeYear('abc') <= 2070, 'default year is far-future')
  assert.equal(pickSmokeYear('abc', '2049'), 2049, 'SMOKE_YEAR override honored')
  assert.notEqual(pickSmokeYear('abc', '1999'), 1999, 'implausible override rejected')

  for (const year of [2043, 2051, 2067]) {
    const window = buildSmokeWindow(year)
    assert.equal(window.periodStart, `${year}-10-01`)
    assert.equal(window.periodEnd, lastDayOfMonth(year, 9))
    assert.equal(window.otDate, firstMondayOfMonth(year, 9))
    assert.equal(new Date(`${window.otDate}T00:00:00.000Z`).getUTCDay(), 1, 'OT accrual date is a Monday (workday source)')
    assert.equal(window.leaveDate, addDays(window.otDate, 1))
    assert.equal(window.holidayDate, addDays(window.otDate, 2))
    for (const date of [window.otDate, window.leaveDate, window.holidayDate]) {
      assert.equal(isWeekend(date), false, `${date} must be a weekday`)
      assert.ok(date >= window.periodStart && date <= window.periodEnd, `${date} inside settlement period`)
    }
  }
})

test('v1-8 settings restore body never PUTs an empty snapshot (deep-merge #3303 lesson)', () => {
  const fromEmpty = buildRestoreSettingsBody({})
  for (const key of RESTORED_POLICY_KEYS) {
    assert.ok(fromEmpty[key] && typeof fromEmpty[key] === 'object', `${key} explicitly re-asserted`)
    assert.equal(fromEmpty[key].enabled, false, `${key} defaults to disabled when the pre-smoke settings never carried it`)
  }
  assert.deepEqual(fromEmpty.overtimeBankPolicy.pooledSources, [])
  assert.deepEqual(fromEmpty.leaveBalanceDeductionPolicy.rules, [])

  const original = {
    someSiblingPolicy: { enabled: true, keep: 'me' },
    overtimeBankPolicy: { enabled: true, pooledSources: ['restday'], maxMinutesPerPeriod: 0, validityDays: null },
  }
  const restored = buildRestoreSettingsBody(original)
  assert.deepEqual(restored.someSiblingPolicy, { enabled: true, keep: 'me' }, 'sibling policies pass through untouched')
  assert.equal(restored.overtimeBankPolicy.enabled, true, 'a genuinely-enabled pre-smoke bank policy is restored enabled')
  assert.deepEqual(restored.overtimeBankPolicy.pooledSources, ['restday'])
  assert.equal(restored.compTimeFromOvertime.enabled, false, 'untouched-by-original keys still explicitly reset')
})

test('v1-8 case plan replays the owner acceptance arithmetic with conservation', () => {
  assert.equal(CASE_PLAN.length, 3)
  assert.deepEqual(CASE_PLAN.map(plan => plan.leaveMinutes), [600, 300, 900], 'leave 10h / 5h / 15h in minutes')
  for (const plan of CASE_PLAN) {
    assert.equal(plan.otMinutes, 600, 'every case accrues +10h overtime into the pool')
    assert.equal(plan.expectDeductMinutes, Math.min(plan.otMinutes, plan.leaveMinutes), 'FIFO deducts at most the pool')
    assert.equal(plan.expectRemainingMinutes, plan.otMinutes - plan.expectDeductMinutes, 'remaining = granted - deducted')
    assert.equal(plan.expectShortfallMinutes, plan.leaveMinutes - plan.expectDeductMinutes, 'real absence = requested - deducted')
    assert.equal(plan.expectConvertibleMinutes, plan.expectRemainingMinutes, 'cycle-end convertible = close-time remaining')
  }
  assert.deepEqual(CASE_PLAN.map(plan => plan.expectConvertibleMinutes), [0, 300, 0], 'owner table: convertible 0 / 5h / 0')
  assert.deepEqual(CASE_PLAN.map(plan => plan.expectShortfallMinutes), [0, 0, 300], 'owner table: real absence 0 / 0 / 5h')
})

test('v1-8 synthetic-id predicate refuses unstamped ids', () => {
  assert.equal(isStampedId('otbank-v18-smoke-abc-case1', 'otbank-v18-smoke-abc-'), true)
  assert.equal(isStampedId('otbank-v18-smoke-abc-', 'otbank-v18-smoke-abc-'), false, 'bare prefix is not a user id')
  assert.equal(isStampedId('real-employee-42', 'otbank-v18-smoke-abc-'), false)
  assert.equal(isStampedId(null, 'otbank-v18-smoke-abc-'), false)
})

test('v1-8 helper does not claim the final staging pass', () => {
  assert.match(script, /OTBANK_V18_API_DB_SMOKE_PASS/)
  assert.doesNotMatch(script, /OTBANK_V18_STAGING_SMOKE_PASS/)
  assert.match(runbook, /This is \*\*not\*\* the final v1-8 PASS stamp/)
})

test('v1-8 helper cleanup is stamped and LIKE-free, with settlements deleted before cycles (FK RESTRICT)', () => {
  assert.match(script, /STAMP must match \/\^otbank-v18-smoke-\[A-Za-z0-9-\]\+\$\//)
  assert.doesNotMatch(script, /LIKE '%/)
  assert.doesNotMatch(script, /metadata::text LIKE/)
  assert.doesNotMatch(script, /meta::text LIKE/)
  assert.doesNotMatch(script, /source_key LIKE/)
  const settlementsDelete = script.indexOf('DELETE FROM attendance_payroll_cycle_settlements')
  const cyclesDelete = script.indexOf('DELETE FROM attendance_payroll_cycles')
  assert.ok(settlementsDelete !== -1 && cyclesDelete !== -1 && settlementsDelete < cyclesDelete,
    'settlement rows must be deleted before their cycle (ON DELETE RESTRICT; the API refuses with 409)')
  assert.match(script, /cascade/i, 'balance-event cleanup relies on the documented lot→event cascade')
})

test('v1-8 helper residue categories cover every table the smoke can dirty (incl approval-engine rows)', () => {
  for (const table of [
    'attendance_requests',
    'attendance_records',
    'attendance_events',
    'attendance_leave_balances',
    'attendance_payroll_cycle_settlements',
    'attendance_payroll_cycles',
    'attendance_holidays',
    'attendance_overtime_rules',
    'attendance_leave_types',
    'approval_instances',
    'approval_assignments',
    'approval_records',
    'user_orgs',
    'users',
  ]) {
    assert.match(script, new RegExp(`to_regclass\\('public\\.${table}'\\)`), `${table} is preflighted`)
    assert.match(script, new RegExp(`FROM ${table}`), `${table} is counted`)
    assert.match(script, new RegExp(`DELETE FROM ${table}`), `${table} is cleaned`)
  }
  // counted-only surfaces: balance events cascade from lots; deliveries must stay untouched (0).
  for (const table of ['attendance_leave_balance_events', 'attendance_notification_deliveries']) {
    assert.match(script, new RegExp(`to_regclass\\('public\\.${table}'\\)`), `${table} is preflighted`)
    assert.match(script, new RegExp(`FROM ${table}`), `${table} is counted`)
  }
  assert.doesNotMatch(script, /DELETE FROM attendance_notification_deliveries/,
    'the OT-bank smoke writes no deliveries and must not delete any (coexistence with the AE/report-digest smokes)')
})

test('v1-8 helper fails the run before printing PASS and gates the shared-org settlement population', () => {
  assert.match(script, /if \(failures\.length\)/)
  assert.match(script, /failed assertion\(s\)/)
  assert.match(script, /ALLOW_NON_SYNTHETIC_SETTLEMENT_POPULATION=1 \(dangerous\)/)
  assert.match(script, /poison/i)
  assert.match(script, /9999/)
})
