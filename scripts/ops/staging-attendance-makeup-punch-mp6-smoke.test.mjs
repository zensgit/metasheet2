import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  STAMP_PATTERN,
  RESTORED_POLICY_KEYS,
  SMOKE_TIMEZONE,
  SMOKE_MAX_REQUESTS,
  SMOKE_WINDOW_DAYS,
  MAKEUP_PUNCH_CODES,
  buildEnabledMakeupPolicy,
  buildRestoreSettingsBody,
  addDaysToDateKey,
  dayOfMonth,
  sameCalendarMonth,
  pickMakeupDates,
  isStampedId,
  resolveEnvConfig,
} from './staging-attendance-makeup-punch-mp6-smoke.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const script = readFileSync(join(here, 'staging-attendance-makeup-punch-mp6-smoke.mjs'), 'utf8')
const runbook = readFileSync(join(here, '../../docs/development/attendance-makeup-punch-mp6-staging-smoke-runbook-20260703.md'), 'utf8')

test('MP-6 env contract: BASE_URL/DATABASE_URL/DEPLOY_SHA required, STAMP regex-locked, defaults applied', () => {
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
  assert.ok(good.config.stamp.startsWith('mp6-smoke-'))

  const badStamp = resolveEnvConfig({
    BASE_URL: 'http://127.0.0.1:8082',
    DATABASE_URL: 'postgresql://u@127.0.0.1:5432/metasheet',
    DEPLOY_SHA: 'abc123def456',
    STAMP: 'otbank-v18-smoke-wrong-family',
  })
  assert.equal(badStamp.ok, false)
  assert.ok(badStamp.errors.some(msg => msg.includes('mp6-smoke')))
})

test('MP-6 enabled policy body matches the design preset (quota cap 1, 30d window, both requires on)', () => {
  const policy = buildEnabledMakeupPolicy()
  assert.equal(policy.enabled, true)
  assert.equal(policy.timezone, SMOKE_TIMEZONE)
  assert.equal(policy.cycle.type, 'calendar_month')
  assert.equal(policy.cycle.startDay, 1)
  assert.equal(policy.quota.maxRequestsPerCycle, SMOKE_MAX_REQUESTS)
  assert.equal(SMOKE_MAX_REQUESTS, 1, 'cap 1 makes the quota probe deterministic (one pending fills the slot)')
  assert.deepEqual(policy.quota.countStatuses, ['pending', 'approved'])
  assert.equal(policy.quota.principal, 'self_service_user')
  assert.equal(policy.submitWindow.unit, 'calendar_day')
  assert.equal(policy.submitWindow.days, SMOKE_WINDOW_DAYS)
  assert.ok(policy.allowedAnomalyTypes.includes('missing_check_out'), 'the valid missed_check_out fact must be an allowed anomaly')
  assert.deepEqual(policy.allowedRequestTypes, ['missed_check_in', 'missed_check_out', 'time_correction'])
  assert.equal(policy.requireReason, true)
  assert.equal(policy.requireAttachment, true, 'requireAttachment on so ATTACHMENT_REQUIRED is provable')
})

test('MP-6 date plan: valid+quota share one calendar_month cycle, all within window, future/expired outside', () => {
  // Sweep a full year of "today" anchors incl. month starts/ends and Feb boundaries.
  const anchors = []
  for (let m = 1; m <= 12; m += 1) {
    for (const day of [1, 2, 3, 15, 27, 28]) {
      anchors.push(`2027-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
    }
  }
  anchors.push('2028-02-29', '2028-03-01', '2027-01-01', '2027-12-31')

  for (const today of anchors) {
    const d = pickMakeupDates(today, { windowDays: SMOKE_WINDOW_DAYS })
    const all = [d.validDate, d.quotaDate, d.typeDate, d.reasonDate, d.attachDate]

    assert.ok(sameCalendarMonth(d.validDate, d.quotaDate), `${today}: valid+quota same cycle`)
    assert.equal(d.quotaDate, addDaysToDateKey(d.validDate, 1), `${today}: quota is day after valid`)
    assert.ok(dayOfMonth(d.quotaDate) >= 2, `${today}: quotaDate nudged off day-1 so valid stays same month`)

    // every makeup date is strictly past and inside the submit window
    for (const date of all) {
      assert.ok(date < today, `${today}: ${date} must be past`)
      assert.ok(addDaysToDateKey(today, -SMOKE_WINDOW_DAYS) <= date, `${today}: ${date} inside submit window`)
    }
    // all distinct
    assert.equal(new Set(all).size, all.length, `${today}: makeup dates are distinct`)

    assert.ok(d.futureDate > today, `${today}: future date is future`)
    assert.ok(addDaysToDateKey(today, -SMOKE_WINDOW_DAYS) > d.windowExpiredDate, `${today}: expired date beyond window`)
  }
})

test('MP-6 the six enforcement codes are the ratified makeup-punch codes in enforce order', () => {
  assert.deepEqual(MAKEUP_PUNCH_CODES, [
    'MAKEUP_PUNCH_FUTURE_DATE_UNSUPPORTED',
    'MAKEUP_PUNCH_WINDOW_EXPIRED',
    'MAKEUP_PUNCH_TYPE_NOT_ALLOWED',
    'MAKEUP_PUNCH_REASON_REQUIRED',
    'MAKEUP_PUNCH_ATTACHMENT_REQUIRED',
    'MAKEUP_PUNCH_QUOTA_EXCEEDED',
  ])
  // every code the helper asserts must be a ratified code
  for (const code of MAKEUP_PUNCH_CODES) {
    assert.match(script, new RegExp(code), `${code} is asserted by the helper`)
  }
})

test('MP-6 settings restore body never PUTs an empty snapshot (deep-merge #3303 lesson)', () => {
  assert.deepEqual(RESTORED_POLICY_KEYS, ['makeupPunchPolicy'])

  const fromEmpty = buildRestoreSettingsBody({})
  assert.ok(fromEmpty.makeupPunchPolicy && typeof fromEmpty.makeupPunchPolicy === 'object', 'makeupPunchPolicy explicitly re-asserted')
  assert.equal(fromEmpty.makeupPunchPolicy.enabled, false, 'defaults to disabled when the pre-smoke settings never carried it')

  // getSettings returns a fully-normalized policy, so a real pre-smoke policy is restored verbatim.
  const original = {
    someSiblingPolicy: { enabled: true, keep: 'me' },
    makeupPunchPolicy: { enabled: true, timezone: 'UTC', quota: { maxRequestsPerCycle: 5, countStatuses: ['pending'], principal: 'self_service_user' } },
  }
  const restored = buildRestoreSettingsBody(original)
  assert.deepEqual(restored.someSiblingPolicy, { enabled: true, keep: 'me' }, 'sibling policies pass through untouched')
  assert.equal(restored.makeupPunchPolicy.enabled, true, 'a genuinely-enabled pre-smoke policy is restored enabled')
  assert.equal(restored.makeupPunchPolicy.quota.maxRequestsPerCycle, 5, 'the pre-smoke nested value is carried back')
})

test('MP-6 synthetic-id predicate refuses unstamped ids', () => {
  assert.equal(isStampedId('mp6-smoke-abc-subject', 'mp6-smoke-abc-'), true)
  assert.equal(isStampedId('mp6-smoke-abc-', 'mp6-smoke-abc-'), false, 'bare prefix is not a user id')
  assert.equal(isStampedId('real-employee-42', 'mp6-smoke-abc-'), false)
  assert.equal(isStampedId(null, 'mp6-smoke-abc-'), false)
})

test('MP-6 helper does not claim the final staging pass', () => {
  assert.match(script, /MP6_MAKEUP_PUNCH_API_DB_SMOKE_PASS/)
  assert.doesNotMatch(script, /MP6_MAKEUP_PUNCH_STAGING_SMOKE_PASS/)
  assert.match(runbook, /This is \*\*not\*\* the final MP-6 PASS stamp/)
})

test('MP-6 helper cleanup is stamped, LIKE-free, and FK-safe (approval children + requests before instances)', () => {
  assert.match(script, /STAMP must match \/\^mp6-smoke-\[A-Za-z0-9-\]\+\$\//)
  assert.doesNotMatch(script, /LIKE '%/)
  assert.doesNotMatch(script, /metadata::text LIKE/)
  assert.doesNotMatch(script, /meta::text LIKE/)
  assert.doesNotMatch(script, /left\(user_id, 17\)/, 'no hard-coded prefix length; uses USER_PREFIX.length')

  const idx = (needle) => script.indexOf(needle)
  const approvalRecords = idx('DELETE FROM approval_records')
  const approvalAssignments = idx('DELETE FROM approval_assignments')
  const events = idx('DELETE FROM attendance_events')
  const records = idx('DELETE FROM attendance_records')
  const requests = idx('DELETE FROM attendance_requests')
  const approvalInstances = idx('DELETE FROM approval_instances')
  const userOrgs = idx('DELETE FROM user_orgs')
  const users = idx('DELETE FROM users')
  for (const [name, value] of Object.entries({ approvalRecords, approvalAssignments, events, records, requests, approvalInstances, userOrgs, users })) {
    assert.ok(value !== -1, `${name} delete exists`)
  }
  assert.ok(approvalRecords < approvalInstances && approvalAssignments < approvalInstances, 'approval children deleted before their instance')
  assert.ok(requests < approvalInstances, 'attendance_requests (FK approval_instance_id) deleted before approval_instances')
  assert.ok(events < requests && records < requests, 'events + records deleted before requests')
  assert.ok(userOrgs < users, 'user_orgs (FK users) deleted before users')
})

test('MP-6 residue categories cover every table the smoke can dirty (incl attendance_events + approval tables)', () => {
  // deleted + counted + preflighted surfaces
  for (const table of [
    'attendance_requests',
    'attendance_records',
    'attendance_events',
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
  // counted-only surface: deliveries must be zero (makeup writes none) and must NOT be deleted.
  assert.match(script, /to_regclass\('public\.attendance_notification_deliveries'\)/, 'deliveries preflighted')
  assert.match(script, /FROM attendance_notification_deliveries/, 'deliveries counted')
  assert.doesNotMatch(script, /DELETE FROM attendance_notification_deliveries/, 'the makeup smoke writes no deliveries and must not delete any (coexistence with the AE/RD smokes)')
})

test('MP-6 helper fails the run before printing PASS and refuses unstamped subjects', () => {
  assert.match(script, /if \(failures\.length\)/)
  assert.match(script, /failed assertion\(s\)/)
  assert.match(script, /refusing to run/)
  assert.match(script, /assertSyntheticUser/)
  // the reduced-vs-full snapshot precision trap is encoded
  assert.match(script, /countStatuses === undefined/)
})
