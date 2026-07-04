import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  STAMP_PATTERN,
  MANUAL_MISSED_PUNCH_REMINDER_SOURCE_TYPE,
  DELIVERY_CHANNEL_ALLOWLIST,
  RECOGNIZED_TERMINAL_FAILURES,
  parseJson,
  jwtSubject,
  isStampedId,
  utcDateKey,
  addDaysUtc,
  buildDeliverySourceId,
  buildDeliverySourceKey,
  classifySendOutcome,
  resolveEnvConfig,
} from './staging-attendance-manual-missed-punch-reminder-hmr5-smoke.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const script = readFileSync(join(here, 'staging-attendance-manual-missed-punch-reminder-hmr5-smoke.mjs'), 'utf8')
const runbook = readFileSync(join(here, '../../docs/development/attendance-manual-missed-punch-reminder-hmr5-staging-runbook-20260626.md'), 'utf8')
const pluginIndex = readFileSync(join(here, '../../plugins/plugin-attendance/index.cjs'), 'utf8')

test('HMR-5 env contract: BASE_URL/DATABASE_URL/DEPLOY_SHA required, STAMP regex-locked, ORG_ID must be disposable', () => {
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
  assert.match(good.config.stamp, STAMP_PATTERN)
  assert.ok(good.config.stamp.startsWith('hmr5-smoke-'))
  assert.ok(good.config.orgId.startsWith('hmr5-smoke-'), 'default ORG_ID is disposable and derived from the stamp')
  assert.equal(good.config.orgId, `${good.config.stamp}-org`)
  assert.equal(good.config.workerExpected, true, 'WORKER_EXPECTED defaults to true (window keeps the worker live)')

  const badStamp = resolveEnvConfig({
    BASE_URL: 'http://127.0.0.1:8082',
    DATABASE_URL: 'postgresql://u@127.0.0.1:5432/metasheet',
    DEPLOY_SHA: 'abc123def456',
    STAMP: 'mp6-smoke-wrong-family',
  })
  assert.equal(badStamp.ok, false)
  assert.ok(badStamp.errors.some(msg => msg.includes('hmr5-smoke')))

  const sharedOrg = resolveEnvConfig({
    BASE_URL: 'http://127.0.0.1:8082',
    DATABASE_URL: 'postgresql://u@127.0.0.1:5432/metasheet',
    DEPLOY_SHA: 'abc123def456',
    ORG_ID: 'default',
  })
  assert.equal(sharedOrg.ok, false, 'a non-disposable ORG_ID must be rejected')
  assert.ok(sharedOrg.errors.some(msg => msg.includes('disposable org')))

  const workerOff = resolveEnvConfig({
    BASE_URL: 'http://127.0.0.1:8082',
    DATABASE_URL: 'postgresql://u@127.0.0.1:5432/metasheet',
    DEPLOY_SHA: 'abc123def456',
    WORKER_EXPECTED: '0',
  })
  assert.equal(workerOff.config.workerExpected, false)
})

test('HMR-5 scheduler interval resolution: default 15000ms, floor 5000ms, invalid input falls back', () => {
  assert.equal(resolveEnvConfig({ BASE_URL: 'x', DATABASE_URL: 'y', DEPLOY_SHA: 'z' }).config.schedulerIntervalMs, 15000)
  assert.equal(resolveEnvConfig({ BASE_URL: 'x', DATABASE_URL: 'y', DEPLOY_SHA: 'z', SCHEDULER_INTERVAL_MS: '1000' }).config.schedulerIntervalMs, 5000, 'floored at 5000ms')
  assert.equal(resolveEnvConfig({ BASE_URL: 'x', DATABASE_URL: 'y', DEPLOY_SHA: 'z', SCHEDULER_INTERVAL_MS: '20000' }).config.schedulerIntervalMs, 20000)
  assert.equal(resolveEnvConfig({ BASE_URL: 'x', DATABASE_URL: 'y', DEPLOY_SHA: 'z', SCHEDULER_INTERVAL_MS: 'not-a-number' }).config.schedulerIntervalMs, 15000)
})

test('HMR-5 delivery source_id/source_key builders match the REAL shipped shape, not the runbook prose', () => {
  const sourceId = buildDeliverySourceId('KEY-1')
  assert.equal(sourceId, 'manual_missed_punch_reminder:KEY-1')
  assert.equal(sourceId, `${MANUAL_MISSED_PUNCH_REMINDER_SOURCE_TYPE}:KEY-1`)

  const sourceKey = buildDeliverySourceKey({ idempotencyKey: 'KEY-1', recipientUserId: 'worker-1', channel: 'dingtalk_work_notification' })
  assert.equal(sourceKey, 'manual_missed_punch_reminder:KEY-1:recipient:worker-1:channel:dingtalk_work_notification')

  // The route's real source_key template includes a ':channel:' suffix (index.cjs L24994) that the
  // runbook's step-4 "Expected" prose omits. This helper must assert the REAL shape, and the drift must
  // stay documented in the header comment rather than silently "fixed" by relaxing the assertion.
  assert.match(pluginIndex, /sourceKey: `\$\{MANUAL_MISSED_PUNCH_REMINDER_SOURCE_TYPE\}:\$\{idempotencyKey\}:recipient:\$\{recipientUserId\}:channel:\$\{channel\}`/, 'the shipped route template still includes the :channel: suffix')
  assert.match(script, /KNOWN DOC DRIFT/, 'the drift between runbook prose and shipped source_key shape is called out loudly in the helper')
})

test('HMR-5 classifySendOutcome: sent/failed-recognized are terminal+proven; pending/retrying/unrecognized-failed are not', () => {
  const sentOnly = classifySendOutcome([{ status: 'sent' }])
  assert.equal(sentOnly.visiblyProven, true)
  assert.equal(sentOnly.terminal, 1)

  const recognizedFailure = classifySendOutcome([{ status: 'failed', last_error: 'dingtalk_recipient_not_bound' }])
  assert.equal(recognizedFailure.visiblyProven, true)
  assert.equal(recognizedFailure.failedRecognized, 1)

  const channelNotConfigured = classifySendOutcome([{ status: 'failed', last_error: 'attendance_delivery_channel_not_configured' }])
  assert.equal(channelNotConfigured.visiblyProven, true)

  const pending = classifySendOutcome([{ status: 'pending' }])
  assert.equal(pending.visiblyProven, false)
  assert.equal(pending.terminal, 0)

  const retrying = classifySendOutcome([{ status: 'retrying' }])
  assert.equal(retrying.visiblyProven, false)

  const unrecognizedFailure = classifySendOutcome([{ status: 'failed', last_error: 'some_other_error' }])
  assert.equal(unrecognizedFailure.visiblyProven, false)
  assert.equal(unrecognizedFailure.failedOther.length, 1)

  const empty = classifySendOutcome([])
  assert.equal(empty.visiblyProven, false, 'zero rows is never "proven" — there must be something to prove')

  assert.deepEqual(RECOGNIZED_TERMINAL_FAILURES, ['dingtalk_recipient_not_bound', 'attendance_delivery_channel_not_configured'])
  for (const reason of RECOGNIZED_TERMINAL_FAILURES) {
    assert.match(script, new RegExp(reason), `${reason} appears in the helper (borrowed from the same shared C5 worker as RD-4/5)`)
  }
})

test('HMR-5 delivery channel allowlist matches the shipped ATTENDANCE_ROUTABLE_DEFAULT_DELIVERY_CHANNELS', () => {
  assert.deepEqual(DELIVERY_CHANNEL_ALLOWLIST, ['dingtalk_work_notification', 'email_smtp'])
  assert.match(pluginIndex, /ATTENDANCE_ROUTABLE_DEFAULT_DELIVERY_CHANNELS = new Set\(\[ATTENDANCE_DINGTALK_WORK_NOTIFICATION_CHANNEL, 'email_smtp'\]\)/)
})

test('HMR-5 date helpers: utcDateKey/addDaysUtc are pure UTC day-math', () => {
  assert.equal(utcDateKey(new Date('2026-07-05T23:59:59.000Z')), '2026-07-05')
  assert.equal(addDaysUtc('2026-07-05', 1), '2026-07-06')
  assert.equal(addDaysUtc('2026-12-31', 1), '2027-01-01', 'year boundary')
  assert.equal(addDaysUtc('2028-02-28', 1), '2028-02-29', 'leap day')
})

test('HMR-5 pure helpers: parseJson/jwtSubject/isStampedId', () => {
  assert.equal(parseJson(null), null)
  assert.deepEqual(parseJson({ a: 1 }), { a: 1 }, 'objects pass through (pg already parses jsonb)')
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 })
  assert.equal(parseJson('not-json'), null)

  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ id: 'user-42' })).toString('base64url')
  assert.equal(jwtSubject(`${header}.${payload}.sig`), 'user-42')
  assert.equal(jwtSubject('not-a-jwt'), null)

  assert.equal(isStampedId('hmr5-smoke-abc-worker', 'hmr5-smoke-abc-'), true)
  assert.equal(isStampedId('hmr5-smoke-abc-', 'hmr5-smoke-abc-'), false, 'bare prefix is not a user id')
  assert.equal(isStampedId('real-employee-42', 'hmr5-smoke-abc-'), false)
  assert.equal(isStampedId(null, 'hmr5-smoke-abc-'), false)
})

test('HMR-5 helper does not claim the final staging pass', () => {
  assert.match(script, /HMR5_API_DB_SMOKE_PASS/)
  assert.doesNotMatch(script, /HMR5_MANUAL_MISSED_PUNCH_REMINDER_STAGING_SMOKE_PASS deploy=\$\{/, 'the helper never prints the final stamp shape as its own console.log output')
  assert.match(runbook, /HMR5_MANUAL_MISSED_PUNCH_REMINDER_STAGING_SMOKE_PASS deploy=<sha> stamp=hmr5-\.\.\. channel=<channel> residue=0/)
  assert.match(script, /does not close HMR-5 by itself/)
  assert.match(script, /admin-console UI confirm-snapshot/, 'the helper says out loud that the UI step (runbook step 3) is not automated')
})

test('HMR-5 helper cleanup is org-scoped, LIKE-free, and ordered children-before-parents', () => {
  assert.match(script, /STAMP must match \/\^hmr5-smoke-\[A-Za-z0-9-\]\+\$\//)
  assert.doesNotMatch(script, /LIKE '%/)
  assert.doesNotMatch(script, /payload::text LIKE/)
  assert.doesNotMatch(script, /meta::text LIKE/)

  const idx = (needle) => script.indexOf(needle)
  const deliveries = idx('DELETE FROM attendance_notification_deliveries')
  const requests = idx('DELETE FROM attendance_requests')
  const records = idx('DELETE FROM attendance_records')
  const scopes = idx('DELETE FROM attendance_scheduler_scopes')
  const userRoles = idx('DELETE FROM user_roles')
  const userOrgs = idx('DELETE FROM user_orgs')
  const users = idx('DELETE FROM users')
  for (const [name, value] of Object.entries({ deliveries, requests, records, scopes, userRoles, userOrgs, users })) {
    assert.ok(value !== -1, `${name} delete exists`)
  }
  assert.ok(deliveries < requests && requests < records && records < scopes, 'deliveries -> requests -> records -> scopes')
  assert.ok(scopes < userRoles && userRoles < userOrgs && userOrgs < users, 'scopes -> user_roles -> user_orgs -> users')
})

test('HMR-5 residue categories cover every table the smoke can dirty', () => {
  for (const table of ['attendance_requests', 'attendance_records', 'attendance_scheduler_scopes', 'user_orgs', 'users']) {
    assert.match(script, new RegExp(`to_regclass\\('public\\.${table}'\\)`), `${table} is preflighted`)
    assert.match(script, new RegExp(`FROM ${table}`), `${table} is counted`)
    assert.match(script, new RegExp(`DELETE FROM ${table}`), `${table} is cleaned`)
  }
  assert.match(script, /to_regclass\('public\.attendance_notification_deliveries'\)/, 'deliveries preflighted')
  assert.match(script, /FROM attendance_notification_deliveries WHERE org_id = \$1 AND source_type = \$2/, 'deliveries counted org+source_type scoped')
  assert.match(script, /DELETE FROM attendance_notification_deliveries WHERE org_id = \$1 AND source_type = \$2/, 'deliveries cleaned org+source_type scoped, never source_type alone')
  assert.match(script, /stray_deliveries_by_recipient/, 'a recipient-prefix catch-all guards against any delivery leaking outside the disposable org')
  assert.match(script, /to_regclass\('public\.user_roles'\)/, 'user_roles preflighted (admin role grant)')
  assert.match(script, /DELETE FROM user_roles WHERE user_id = ANY/, 'user_roles cleaned')
})

test('HMR-5 helper never sends orgId in the enqueue POST body (strict zod schema)', () => {
  assert.match(script, /NOTE: the enqueue schema is z\.object\(\{recordIds,message,idempotencyKey\}\)\.strict\(\)/)

  // Bounded slice right after the route registration (not an unbounded regex over the whole 28k-line
  // file) so this stays a precise grounding check on THIS route's schema, not an accidental match
  // against some unrelated later `.strict()` schema elsewhere in the plugin.
  const routeIdx = pluginIndex.indexOf("'/api/attendance/manual-missed-punch-reminders/enqueue'")
  assert.ok(routeIdx !== -1, 'enqueue route registration found in the plugin')
  const routeSlice = pluginIndex.slice(routeIdx, routeIdx + 600)
  assert.match(routeSlice, /recordIds:/, 'recordIds is the schema\'s first field')
  assert.match(routeSlice, /idempotencyKey:/)
  assert.match(routeSlice, /\}\)\.strict\(\)/, 'the shipped enqueue route schema is still .strict() (rejects unknown keys, incl. orgId)')
  assert.doesNotMatch(routeSlice, /orgId:/, 'orgId is NOT part of the enqueue body schema')

  // The enqueue() helper builds its body from exactly {recordIds, message, idempotencyKey} — never
  // spreads `orgId` into it (unlike the candidates GET, orgId here only travels via query string/header).
  const enqueueFnMatch = script.match(/async function enqueue\(token, \{ recordIds: ids, message, idempotencyKey \}\) \{[\s\S]*?\n\}/)
  assert.ok(enqueueFnMatch, 'enqueue() function body found')
  const body = enqueueFnMatch[0]
  // Precise shape check (not a bare doesNotMatch(/orgId/) — the function's own explanatory comments
  // legitimately discuss orgId in prose): the actual `body:` object literal passed to fetch() must be
  // exactly {recordIds, message, idempotencyKey}, nothing spread in from an outer scope.
  assert.match(body, /body: \{ recordIds: ids, message, idempotencyKey \}/)
  const bodyLiteralMatch = body.match(/body: \{[^}]*\}/)
  assert.ok(bodyLiteralMatch, 'body: {...} literal found in enqueue()')
  assert.doesNotMatch(bodyLiteralMatch[0], /orgId/, 'the body object literal itself must never include orgId')
})

test('HMR-5 helper refuses unstamped ids and fails the run before printing PASS', () => {
  assert.match(script, /if \(failures\.length\)/)
  assert.match(script, /failed assertion\(s\)/)
  assert.match(script, /refusing to run/)
  assert.match(script, /assertSyntheticUser/)
})

test('HMR-5 stale/scope probes use FRESH idempotency keys, never the API key (existing source_id short-circuits before stale/scope re-check)', () => {
  assert.match(script, /idempotencyKeys\.stale/)
  assert.match(script, /idempotencyKeys\.scope/)
  // Both fresh-key call sites must be textually distinct from the api key literal used at creation time.
  const staleCallSite = script.slice(script.indexOf('async function assertStaleCandidate409'), script.indexOf('async function assertOutOfScope403'))
  const scopeCallSite = script.slice(script.indexOf('async function assertOutOfScope403'), script.indexOf('// --- delivery worker status flow'))
  assert.match(staleCallSite, /idempotencyKey: idempotencyKeys\.stale/)
  assert.doesNotMatch(staleCallSite, /idempotencyKey: idempotencyKeys\.api/)
  assert.match(scopeCallSite, /idempotencyKey: idempotencyKeys\.scope/)
  assert.doesNotMatch(scopeCallSite, /idempotencyKey: idempotencyKeys\.api/)
  assert.match(script, /MUST use a FRESH idempotencyKey/)
})

test('HMR-5 runtime grounding: scheduler-scope remind action and the two ratified 40x codes exist on origin/main', () => {
  assert.match(pluginIndex, /ATTENDANCE_SCHEDULER_SCOPE_ACTION_VALUES = \[.*'remind'.*\]/)
  assert.match(pluginIndex, /MISSED_PUNCH_REMINDER_IDEMPOTENCY_CONFLICT/)
  assert.match(pluginIndex, /MISSED_PUNCH_REMINDER_CANDIDATE_STALE/)
  assert.match(pluginIndex, /SCHEDULER_SCOPE_FORBIDDEN/)
  for (const code of ['MISSED_PUNCH_REMINDER_IDEMPOTENCY_CONFLICT', 'MISSED_PUNCH_REMINDER_CANDIDATE_STALE', 'SCHEDULER_SCOPE_FORBIDDEN']) {
    assert.match(script, new RegExp(code), `${code} is asserted by the helper`)
  }
})
