import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  STAMP_PATTERN,
  DIGEST_SOURCE_TYPE,
  DIGEST_CADENCE,
  DEFAULT_ORG_ID,
  DELIVERY_CHANNEL_ALLOWLIST,
  RECOGNIZED_TERMINAL_FAILURES,
  RESIDUE_TABLES,
  DISABLED_DIGEST_POLICY_DEFAULT,
  utcDateKey,
  addDaysUtc,
  computeCompletedDailyPeriod,
  minutesUntilUtcMidnight,
  buildDigestSourceKeyPrefix,
  buildDigestSourceKey,
  parseDigestSourceKey,
  buildRestoreDigestPolicyBody,
  classifySendOutcome,
  resolveEnvConfig,
} from './staging-attendance-report-digest-rd45-smoke.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const script = readFileSync(join(here, 'staging-attendance-report-digest-rd45-smoke.mjs'), 'utf8')
const runbook = readFileSync(join(here, '../../docs/development/attendance-rd45-report-digest-staging-smoke-runbook-20260702.md'), 'utf8')
const bundle = readFileSync(join(here, '../../docs/development/attendance-staging-window-bundle-20260702.md'), 'utf8')

const GOOD_ENV = {
  BASE_URL: 'http://127.0.0.1:8082/',
  DATABASE_URL: 'postgresql://u@127.0.0.1:5432/metasheet',
  DEPLOY_SHA: 'abc123def456',
}

test('rd45 env contract: BASE_URL/DATABASE_URL/DEPLOY_SHA required, STAMP regex-locked, seam is the primary default', () => {
  const missing = resolveEnvConfig({})
  assert.equal(missing.ok, false)
  assert.ok(missing.errors.some(msg => msg.includes('BASE_URL and DATABASE_URL')))
  assert.ok(missing.errors.some(msg => msg.includes('DEPLOY_SHA is required')))

  const placeholder = resolveEnvConfig({ ...GOOD_ENV, DEPLOY_SHA: '<fill-from-staging-build>' })
  assert.equal(placeholder.ok, false)
  assert.ok(placeholder.errors.some(msg => msg.includes('DEPLOY_SHA is required')))

  const good = resolveEnvConfig(GOOD_ENV)
  assert.equal(good.ok, true)
  assert.equal(good.config.baseUrl, 'http://127.0.0.1:8082', 'trailing slash stripped')
  assert.equal(good.config.triggerMode, 'seam', 'seam (disposable smoke org) is the PRIMARY default track')
  assert.match(good.config.stamp, STAMP_PATTERN)
  assert.equal(good.config.orgId, `${good.config.stamp}-org`, 'seam default org is derived from the stamp (disposable)')
  assert.equal(good.config.workerExpected, true, 'window state keeps the delivery worker on; send proof expected by default')
  assert.equal(good.config.allowPreexistingDigestRows, false)
  assert.equal(good.config.allowUtcMidnightCrossing, false)

  const workerOff = resolveEnvConfig({ ...GOOD_ENV, WORKER_EXPECTED: '0' })
  assert.equal(workerOff.config.workerExpected, false)

  const badStamp = resolveEnvConfig({ ...GOOD_ENV, STAMP: 'otbank-v18-smoke-wrong-family' })
  assert.equal(badStamp.ok, false)
  assert.ok(badStamp.errors.some(msg => msg.includes('rd45-smoke')))

  const badMode = resolveEnvConfig({ ...GOOD_ENV, TRIGGER_MODE: 'cron' })
  assert.equal(badMode.ok, false)
  assert.ok(badMode.errors.some(msg => msg.includes('TRIGGER_MODE')))
})

test('rd45 env contract: org rules per track (seam=stamped disposable org; scheduler=default org + explicit fan-out ack + worker off)', () => {
  const seamRealOrg = resolveEnvConfig({ ...GOOD_ENV, ORG_ID: 'default' })
  assert.equal(seamRealOrg.ok, false, 'the seam track must never point at a real org')
  assert.ok(seamRealOrg.errors.some(msg => msg.includes('rd45-smoke-')))

  const seamCustom = resolveEnvConfig({ ...GOOD_ENV, ORG_ID: 'rd45-smoke-abc-org' })
  assert.equal(seamCustom.ok, true)

  const schedNoAck = resolveEnvConfig({ ...GOOD_ENV, TRIGGER_MODE: 'scheduler' })
  assert.equal(schedNoAck.ok, false)
  assert.ok(schedNoAck.errors.some(msg => msg.includes('ACK_DEFAULT_ORG_FANOUT=1')))
  assert.equal(schedNoAck.config.orgId, DEFAULT_ORG_ID, 'scheduler variant defaults to the default org (the backend job is hardwired to it)')

  const schedAck = resolveEnvConfig({ ...GOOD_ENV, TRIGGER_MODE: 'scheduler', ACK_DEFAULT_ORG_FANOUT: '1' })
  assert.equal(schedAck.ok, true)
  assert.equal(schedAck.config.workerExpected, false, 'scheduler variant must run with the delivery worker off (rows stay pending)')

  const schedWorkerOn = resolveEnvConfig({ ...GOOD_ENV, TRIGGER_MODE: 'scheduler', ACK_DEFAULT_ORG_FANOUT: '1', WORKER_EXPECTED: '1' })
  assert.equal(schedWorkerOn.ok, false, 'WORKER_EXPECTED=1 is rejected in scheduler mode')

  const schedWrongOrg = resolveEnvConfig({ ...GOOD_ENV, TRIGGER_MODE: 'scheduler', ACK_DEFAULT_ORG_FANOUT: '1', ORG_ID: 'rd45-smoke-abc-org' })
  assert.equal(schedWrongOrg.ok, false, 'the backend scheduler cannot serve a smoke org; ORG_ID must be default')

  assert.equal(resolveEnvConfig({ ...GOOD_ENV, SCHEDULER_INTERVAL_MS: '3000' }).config.schedulerIntervalMs, 5000, 'mirrors the backend 5000ms floor clamp')
  assert.equal(resolveEnvConfig({ ...GOOD_ENV, SCHEDULER_INTERVAL_MS: '20000' }).config.schedulerIntervalMs, 20000)
  assert.equal(resolveEnvConfig({ ...GOOD_ENV, SCHEDULER_INTERVAL_MS: 'abc' }).config.schedulerIntervalMs, 15000, 'default interval when unset/garbage')
})

test('rd45 completed-daily-period computation: previous UTC calendar day incl month/year/leap boundaries', () => {
  assert.deepEqual(computeCompletedDailyPeriod('2026-07-02'), { from: '2026-07-01', to: '2026-07-01', periodKey: 'daily:2026-07-01' })
  assert.deepEqual(computeCompletedDailyPeriod('2026-03-01'), { from: '2026-02-28', to: '2026-02-28', periodKey: 'daily:2026-02-28' })
  assert.deepEqual(computeCompletedDailyPeriod('2028-03-01'), { from: '2028-02-29', to: '2028-02-29', periodKey: 'daily:2028-02-29' }, 'leap-year boundary')
  assert.deepEqual(computeCompletedDailyPeriod('2026-01-01'), { from: '2025-12-31', to: '2025-12-31', periodKey: 'daily:2025-12-31' }, 'year boundary')
  assert.equal(addDaysUtc('2026-07-01', 1), '2026-07-02')
  assert.equal(utcDateKey(new Date('2026-07-02T23:59:59.000Z')), '2026-07-02')
})

test('rd45 source_key builder/parser round-trip on the verified template (":subject:" segment; cadence appears twice)', () => {
  // Literal example from the verified facts extract (implementation key shape).
  const literal = 'attendance_report_digest:default:daily:daily:2026-07-01:subject:u1:self:u1:channel:dingtalk_work_notification'
  const parts = {
    orgId: 'default',
    cadence: 'daily',
    periodKey: 'daily:2026-07-01',
    subjectUserId: 'u1',
    recipientRole: 'self',
    recipientUserId: 'u1',
    channel: 'dingtalk_work_notification',
  }
  assert.equal(buildDigestSourceKey(parts), literal)
  assert.deepEqual(parseDigestSourceKey(literal), parts)
  assert.ok(literal.startsWith(buildDigestSourceKeyPrefix('default', 'daily', 'daily:2026-07-01')))
  assert.ok(buildDigestSourceKeyPrefix('default', 'daily', 'daily:2026-07-01').endsWith(':subject:'), 'prefix pins the per-subject grain segment')

  // Weekly period keys embed colons; owner-role recipient differs from the subject.
  const weekly = buildDigestSourceKey({
    orgId: 'default',
    cadence: 'weekly',
    periodKey: 'weekly:2026-06-22:2026-06-28',
    subjectUserId: 'u1',
    recipientRole: 'owner',
    recipientUserId: 'mgr1',
    channel: 'email_smtp',
  })
  assert.deepEqual(parseDigestSourceKey(weekly)?.periodKey, 'weekly:2026-06-22:2026-06-28')
  assert.deepEqual(parseDigestSourceKey(weekly)?.recipientUserId, 'mgr1')
})

test('rd45 source_key parser rejects malformed keys, including the design-lock §4 doc-drift shape without ":subject:"', () => {
  // The design-lock doc template omits the ':subject:' segment; the implementation supersedes it,
  // and the parser must NOT accept the drifted shape.
  assert.equal(parseDigestSourceKey('attendance_report_digest:default:daily:daily:2026-07-01:u1:self:u1:channel:dingtalk_work_notification'), null)
  assert.equal(parseDigestSourceKey('attendance_result_edit:default:rec1:subject:u1:self:u1:channel:x'), null, 'wrong source_type prefix')
  assert.equal(parseDigestSourceKey('attendance_report_digest:default:daily:weekly:2026-06-22:2026-06-28:subject:u1:self:u1:channel:x'), null, 'periodKey must start with the cadence (cadence appears twice)')
  assert.equal(parseDigestSourceKey('attendance_report_digest:default:daily:daily:2026-07-01:subject:u1:self:u1:nochannel'), null, 'missing :channel: separator')
  assert.equal(parseDigestSourceKey('attendance_report_digest:default:daily:daily:2026-07-01:subject:u1:self:u:1:channel:x'), null, 'recipient section must be exactly subject:role:recipient')
  assert.equal(parseDigestSourceKey(null), null)
})

test('rd45 UTC-midnight guard math (scheduler variant only; the seam track pins todayKey)', () => {
  assert.equal(minutesUntilUtcMidnight(new Date('2026-07-02T23:45:00.000Z')), 15)
  assert.equal(minutesUntilUtcMidnight(new Date('2026-07-02T23:59:30.000Z')), 0)
  assert.equal(minutesUntilUtcMidnight(new Date('2026-07-02T00:00:00.000Z')), 1440)
})

test('rd45 settings restore body never PUTs an empty snapshot (deep-merge lesson) and re-asserts the digest policy explicitly', () => {
  const fromEmpty = buildRestoreDigestPolicyBody({})
  assert.deepEqual(fromEmpty.attendanceReportDigestPolicy, DISABLED_DIGEST_POLICY_DEFAULT, 'defaults to the all-off policy when the pre-smoke settings never carried it')
  assert.equal(fromEmpty.attendanceReportDigestPolicy.enabled, false)
  for (const cadence of ['daily', 'weekly', 'monthly']) {
    assert.equal(fromEmpty.attendanceReportDigestPolicy.cadences[cadence].enabled, false, `${cadence} cadence explicitly disabled`)
  }
  assert.equal(fromEmpty.attendanceReportDigestPolicy.cadences.daily.sendAt, '18:30', 'default daily sendAt matches DEFAULT_SETTINGS')

  const original = {
    someSiblingPolicy: { enabled: true, keep: 'me' },
    attendanceReportDigestPolicy: {
      enabled: true,
      timezone: 'Asia/Shanghai',
      channel: 'email_smtp',
      cadences: {
        daily: { enabled: true, sendAt: '19:00', recipients: ['self', 'owner'] },
        weekly: { enabled: false, weekday: 1, sendAt: '09:00', recipients: ['self'] },
        monthly: { enabled: false, dayOfMonth: 1, sendAt: '09:00', recipients: ['self'] },
      },
    },
  }
  const restored = buildRestoreDigestPolicyBody(original)
  assert.deepEqual(restored.attendanceReportDigestPolicy, original.attendanceReportDigestPolicy, 'a genuinely-configured pre-smoke policy is restored verbatim')
  assert.deepEqual(restored.someSiblingPolicy, { enabled: true, keep: 'me' }, 'sibling policies pass through untouched')

  const fromNull = buildRestoreDigestPolicyBody(null)
  assert.deepEqual(fromNull.attendanceReportDigestPolicy, DISABLED_DIGEST_POLICY_DEFAULT)
})

test('rd45 send-outcome classifier: sent / recognized visible failure = proven; stuck or unexplained = not proven', () => {
  assert.deepEqual(RECOGNIZED_TERMINAL_FAILURES, ['dingtalk_recipient_not_bound', 'attendance_delivery_channel_not_configured'])

  const allSent = classifySendOutcome([{ status: 'sent' }, { status: 'sent' }])
  assert.equal(allSent.visiblyProven, true)
  assert.equal(allSent.sent, 2)

  const mixed = classifySendOutcome([{ status: 'sent' }, { status: 'failed', last_error: 'dingtalk_recipient_not_bound' }])
  assert.equal(mixed.visiblyProven, true, 'unbound-recipient failure is a documented VISIBLE worker outcome')
  assert.equal(mixed.failedRecognized, 1)

  const channelMissing = classifySendOutcome([{ status: 'failed', last_error: 'attendance_delivery_channel_not_configured' }])
  assert.equal(channelMissing.visiblyProven, true, 'channel-not-configured is terminal and visible (weakest posture; runbook prefers the deterministic fake channel)')

  const unexplained = classifySendOutcome([{ status: 'failed', last_error: 'boom' }])
  assert.equal(unexplained.visiblyProven, false)
  assert.equal(unexplained.failedOther.length, 1)

  const stuck = classifySendOutcome([{ status: 'sent' }, { status: 'pending' }])
  assert.equal(stuck.visiblyProven, false, 'a stuck pending row is not a send proof')
  assert.equal(stuck.terminal, 1)

  assert.equal(classifySendOutcome([]).visiblyProven, false, 'zero rows prove nothing')
})

test('rd45 helper does not claim the final staging pass and prints the exact API/DB pass-line shape', () => {
  assert.match(script, /RD45_REPORT_DIGEST_API_DB_SMOKE_PASS deploy=\$\{DEPLOY_SHA\} stamp=\$\{STAMP\} org=\$\{ORG_ID\} produced=\$\{subjects\.length\} dedupOk=\$\{dedupOk \? 1 : 0\} residue=0/)
  assert.doesNotMatch(script, /RD45_REPORT_DIGEST_STAGING_SMOKE_PASS/)
  assert.match(runbook, /RD45_REPORT_DIGEST_STAGING_SMOKE_PASS/)
  assert.match(runbook, /\*\*Status:\*\* PREPARED/)
  assert.match(runbook, /does \*\*not\*\* claim a staging PASS/)
  assert.match(script, /if \(failures\.length\)/)
  assert.match(script, /failed assertion\(s\)/)
})

test('rd45 deterministic-source_key family deviation is loud in both artifacts (keys carry no stamp; RUN LOG is part of the residue record)', () => {
  assert.match(script, /KNOWN FAMILY DEVIATION/)
  assert.match(script, /RUN LOG — deterministic digest keys/)
  assert.match(runbook, /family deviation/i)
  assert.match(runbook, /deterministic/i)
  assert.match(script, /deterministic-key collision/i, 'same-day rerun collision is guarded at preflight')
  assert.equal('rd45-smoke-'.length, 11, 'window-bundle §7 residue SQL slices left(...,11)')
  assert.match(bundle, /left\(user_id, 11\) = 'rd45-smoke-'/)
  assert.match(bundle, /org_id = :rd45_smoke_org/)
})

test('rd45 helper residue triple-check covers every table the smoke can dirty; settings row is restored, never deleted', () => {
  assert.deepEqual(RESIDUE_TABLES, ['attendance_notification_deliveries', 'user_orgs', 'users'])
  for (const table of RESIDUE_TABLES) {
    assert.match(script, new RegExp(`to_regclass\\('public\\.${table}'\\)`), `${table} is preflighted`)
    assert.match(script, new RegExp(`FROM ${table}`), `${table} is counted`)
    assert.match(script, new RegExp(`DELETE FROM ${table}`), `${table} is cleaned`)
  }
  assert.match(script, /to_regclass\('public\.system_configs'\)/, 'settings storage is preflighted')
  assert.doesNotMatch(script, /DELETE FROM system_configs/, 'settings are restored via PUT, never deleted')
  // this smoke writes no other attendance business rows
  assert.doesNotMatch(script, /DELETE FROM attendance_records/)
  assert.doesNotMatch(script, /DELETE FROM attendance_requests/)
})

test('rd45 helper cleanup is stamped/prefix-scoped, LIKE-free, and restores settings BEFORE deleting rows (re-insert trap)', () => {
  assert.match(script, /STAMP must match \/\^rd45-smoke-\[A-Za-z0-9-\]\+\$\//)
  assert.doesNotMatch(script, /LIKE '%/)
  assert.doesNotMatch(script, /source_key LIKE/)
  const restoreCall = script.indexOf('await restoreSettings({ strict: strictSettingsRestore })')
  const deliveriesDelete = script.indexOf('DELETE FROM attendance_notification_deliveries')
  assert.ok(restoreCall !== -1 && deliveriesDelete !== -1 && restoreCall < deliveriesDelete,
    'policy restore/disable must precede row deletion or the still-open period is re-inserted on the next producer run')
  assert.match(script, /DELETE FROM attendance_notification_deliveries WHERE org_id = \$1 AND source_type = \$2 AND left\(source_key, \$3\) = \$4/,
    'the default-org variant deletes ONLY by deterministic source_key prefix, never org-wide')
})

test('rd45 helper keeps the three env gate layers distinct: producer gate set process-locally for the seam, send gate never touched', () => {
  assert.match(script, /process\.env\.ATTENDANCE_REPORT_DIGEST_ENABLED = 'true'/, 'seam track enables the producer gate in the helper process only')
  assert.doesNotMatch(script, /ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED/, 'the helper never reads or writes the send gate (backend env is operator-owned)')
  assert.doesNotMatch(script, /process\.env\.ATTENDANCE_SCHEDULER_ENABLED\s*=/, 'the helper never mutates the backend process gate')
  assert.match(script, /default-org leakage/i, 'seam track asserts the globally-shared policy did not fan out on the backend')
  for (const name of ['ATTENDANCE_REPORT_DIGEST_ENABLED', 'ATTENDANCE_SCHEDULER_ENABLED', 'ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED', 'ATTENDANCE_SCHEDULER_INTERVAL_MS']) {
    assert.match(runbook, new RegExp(name), `runbook documents ${name}`)
  }
  assert.match(runbook, /one FULL interval/i, 'first-tick-after-boot timing is documented explicitly')
  assert.match(runbook, /single-member/i, 'window-plan single-member smoke-org rule is stated')
  assert.match(runbook, /OQ-/, 'open questions are explicit blocks, not silent gaps')
})

test('rd45 constants match the verified producer facts', () => {
  assert.equal(DIGEST_SOURCE_TYPE, 'attendance_report_digest')
  assert.equal(DIGEST_CADENCE, 'daily')
  assert.equal(DEFAULT_ORG_ID, 'default')
  assert.deepEqual(DELIVERY_CHANNEL_ALLOWLIST, ['dingtalk_work_notification', 'email_smtp'])
  assert.match(script, /ON CONFLICT \(org_id, source_key\) DO NOTHING/, 'dedup mechanism named where the replay assertion is made')
  assert.match(script, /status IN \('pending', 'retrying'\) AND next_attempt_at <= now\(\)/, 'global worker-claim visibility check uses the worker claim shape')
})
