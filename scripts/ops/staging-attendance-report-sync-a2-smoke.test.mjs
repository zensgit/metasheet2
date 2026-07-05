import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  STAMP_PATTERN,
  ATTENDANCE_SCHEDULER_ENABLED_ENV,
  REPORT_SYNC_SCHEDULED_TRIGGER_ENV_FLAG,
  REPORT_SYNC_JOB_TABLE,
  ALLOW_CROSS_ORG_FANOUT_ENV,
  MAX_ORGS_PER_RUN_CEILING,
  isStampedId,
  resolveEnvConfig,
  attendanceReportRecordRowKey,
  createFakeReportRecordsMultitable,
  seedStaleReportRecordFixture,
  isDoubleGateClosedResult,
  findOrgResult,
  isFreshCompletedClaim,
  isIdempotentNoOpRepeat,
  isResumingQueuedClaim,
  resolveMaxOrgsPerRunForFullCoverage,
  residueIsZero,
} from './staging-attendance-report-sync-a2-smoke.mjs'

// This file intentionally does NOT connect to a real DB/network and does NOT require the attendance
// plugin file — it locks this helper's OWN pure logic (env contract, in-memory fixture behavior,
// assertion-shape predicates against hand-built fixtures matching #3630's documented contract, and the
// helper's own source-text shape: SQL parameterization, cleanup-table completeness, PASS stamp format).
// #3630 (the A2 scheduled-trigger runtime) is not merged into this checkout yet — see the PR body for
// the dependency note. Real-DB end-to-end coverage is the .mjs helper itself, run by an operator on
// staging per the runbook.

const here = dirname(fileURLToPath(import.meta.url))
const scriptPath = join(here, 'staging-attendance-report-sync-a2-smoke.mjs')
const script = readFileSync(scriptPath, 'utf8')

test('env contract: BASE_URL/DATABASE_URL/DEPLOY_SHA required, STAMP regex-locked, org ids derived from stamp', () => {
  const missing = resolveEnvConfig({})
  assert.equal(missing.ok, false)
  assert.ok(missing.errors.some((msg) => msg.includes('BASE_URL and DATABASE_URL')))
  assert.ok(missing.errors.some((msg) => msg.includes('DEPLOY_SHA is required')))

  const placeholder = resolveEnvConfig({
    BASE_URL: 'http://127.0.0.1:8082',
    DATABASE_URL: 'postgresql://u@127.0.0.1:5432/metasheet',
    DEPLOY_SHA: '<fill-from-staging-build>',
  })
  assert.equal(placeholder.ok, false)
  assert.ok(placeholder.errors.some((msg) => msg.includes('DEPLOY_SHA is required')))

  const good = resolveEnvConfig({
    BASE_URL: 'http://127.0.0.1:8082/',
    DATABASE_URL: 'postgresql://u@127.0.0.1:5432/metasheet',
    DEPLOY_SHA: 'abc123def456',
  })
  assert.equal(good.ok, true)
  assert.equal(good.config.baseUrl, 'http://127.0.0.1:8082', 'trailing slash stripped')
  assert.match(good.config.stamp, STAMP_PATTERN)
  assert.ok(good.config.stamp.startsWith('reportsync-a2-smoke-'))
  assert.equal(good.config.orgIds.gate, `${good.config.stamp}-gate`)
  assert.equal(good.config.orgIds.main, `${good.config.stamp}-main`)
  assert.equal(good.config.orgIds.throttle, `${good.config.stamp}-throttle`)
  for (const orgId of Object.values(good.config.orgIds)) {
    assert.ok(isStampedId(orgId, good.config.stamp), `${orgId} must be prefixed with the stamp`)
  }
  assert.equal(good.config.allowCrossOrgFanout, false, 'ALLOW_CROSS_ORG_REPORT_SYNC_FANOUT defaults to false')

  const badStamp = resolveEnvConfig({
    BASE_URL: 'http://127.0.0.1:8082',
    DATABASE_URL: 'postgresql://u@127.0.0.1:5432/metasheet',
    DEPLOY_SHA: 'abc123def456',
    STAMP: 'hmr5-smoke-wrong-family',
  })
  assert.equal(badStamp.ok, false)
  assert.ok(badStamp.errors.some((msg) => msg.includes('reportsync-a2-smoke')))

  const allowedOverride = resolveEnvConfig({
    BASE_URL: 'http://127.0.0.1:8082',
    DATABASE_URL: 'postgresql://u@127.0.0.1:5432/metasheet',
    DEPLOY_SHA: 'abc123def456',
    [ALLOW_CROSS_ORG_FANOUT_ENV]: '1',
  })
  assert.equal(allowedOverride.config.allowCrossOrgFanout, true)
})

test('env contract: RUN_DATE must be YYYY-MM-DD when set, otherwise passes through untouched', () => {
  const base = { BASE_URL: 'http://x', DATABASE_URL: 'postgresql://x', DEPLOY_SHA: 'abc123' }
  const unset = resolveEnvConfig(base)
  assert.equal(unset.ok, true)
  assert.equal(unset.config.runDate, '')

  const good = resolveEnvConfig({ ...base, RUN_DATE: '2026-07-05' })
  assert.equal(good.ok, true)
  assert.equal(good.config.runDate, '2026-07-05')

  const bad = resolveEnvConfig({ ...base, RUN_DATE: '07/05/2026' })
  assert.equal(bad.ok, false)
  assert.ok(bad.errors.some((msg) => msg.includes('RUN_DATE must be YYYY-MM-DD')))
})

test('isStampedId: true only for values that start with the prefix and have extra content', () => {
  assert.equal(isStampedId('reportsync-a2-smoke-abc-gate', 'reportsync-a2-smoke-abc'), true)
  assert.equal(isStampedId('reportsync-a2-smoke-abc', 'reportsync-a2-smoke-abc'), false, 'exact match with nothing extra is rejected')
  assert.equal(isStampedId('other-org', 'reportsync-a2-smoke-abc'), false)
  assert.equal(isStampedId(123, 'reportsync-a2-smoke-abc'), false, 'non-string is rejected')
})

test('attendanceReportRecordRowKey: mirrors the documented `${orgId}:${userId}:${workDate}` formula from #3630/the design-lock', () => {
  assert.equal(attendanceReportRecordRowKey('org1', 'user1', '2026-07-05'), 'org1:user1:2026-07-05')
  assert.equal(
    attendanceReportRecordRowKey('reportsync-a2-smoke-x-main', 'reportsync-a2-smoke-x-main-fresh', '2026-07-05'),
    'reportsync-a2-smoke-x-main:reportsync-a2-smoke-x-main-fresh:2026-07-05',
  )
})

test('createFakeReportRecordsMultitable: create/query/patch semantics match the real writer\'s contract shape', async () => {
  const fake = createFakeReportRecordsMultitable()
  assert.deepEqual(fake.store, [])
  assert.equal(fake.rowKeyFieldId, 'fld_row_key')
  assert.equal(fake.fieldFingerprintFieldId, 'fld_field_fingerprint')
  assert.equal(fake.sourceFingerprintFieldId, 'fld_source_fingerprint')

  const created = await fake.records.createRecord({ data: { [fake.rowKeyFieldId]: 'org:u:2026-07-05', [fake.fieldFingerprintFieldId]: 'ff1' } })
  assert.ok(created.id)
  assert.equal(fake.store.length, 1)

  const found = await fake.records.queryRecords({ filters: { [fake.rowKeyFieldId]: 'org:u:2026-07-05' } })
  assert.equal(found.length, 1)
  assert.equal(found[0].id, created.id)

  const notFound = await fake.records.queryRecords({ filters: { [fake.rowKeyFieldId]: 'nope' } })
  assert.equal(notFound.length, 0)

  await fake.records.patchRecord({ recordId: created.id, changes: { [fake.fieldFingerprintFieldId]: 'ff2' } })
  assert.equal(fake.store[0].data[fake.fieldFingerprintFieldId], 'ff2', 'patch merges onto the existing row')
  assert.equal(fake.store[0].data[fake.rowKeyFieldId], 'org:u:2026-07-05', 'patch preserves untouched fields')
  assert.equal(fake.store.length, 1, 'patch never creates a second row')

  const resolved = await fake.provisioning.resolveFieldIds({ fieldIds: ['row_key', 'field_fingerprint'] })
  assert.deepEqual(resolved, { row_key: 'fld_row_key', field_fingerprint: 'fld_field_fingerprint' })
  const ensured = await fake.provisioning.ensureObject({})
  assert.ok(ensured.baseId && ensured.sheet?.id)
})

test('seedStaleReportRecordFixture: seeds exactly one row with the given rowKey and stale dual-fingerprint markers', () => {
  const fake = createFakeReportRecordsMultitable()
  seedStaleReportRecordFixture(fake, 'org:stale-user:2026-07-05')
  assert.equal(fake.store.length, 1)
  const row = fake.store[0]
  assert.equal(row.data[fake.rowKeyFieldId], 'org:stale-user:2026-07-05')
  assert.equal(row.data[fake.fieldFingerprintFieldId], 'stale-field-fingerprint-marker')
  assert.equal(row.data[fake.sourceFingerprintFieldId], 'stale-source-fingerprint-marker')
})

test('isDoubleGateClosedResult: true only for the exact { ran:false, reason:"disabled", orgs:[] } shape', () => {
  assert.equal(isDoubleGateClosedResult({ ran: false, reason: 'disabled', orgs: [] }), true)
  assert.equal(isDoubleGateClosedResult({ ran: true, reason: 'disabled', orgs: [] }), false, 'ran must be false')
  assert.equal(isDoubleGateClosedResult({ ran: false, reason: 'other', orgs: [] }), false, 'reason must be "disabled"')
  assert.equal(isDoubleGateClosedResult({ ran: false, reason: 'disabled', orgs: [{ orgId: 'x' }] }), false, 'orgs must be empty')
  assert.equal(isDoubleGateClosedResult({ ran: false, reason: 'disabled' }), false, 'orgs must be an array')
  assert.equal(isDoubleGateClosedResult(null), false)
  assert.equal(isDoubleGateClosedResult(undefined), false)
})

test('findOrgResult: finds the matching org among several, returns null when absent', () => {
  const result = { ran: true, cadence: 'daily', orgs: [{ orgId: 'a', claimed: false }, { orgId: 'b', claimed: true }] }
  assert.deepEqual(findOrgResult(result, 'b'), { orgId: 'b', claimed: true })
  assert.equal(findOrgResult(result, 'zzz'), null)
  assert.equal(findOrgResult({ orgs: [] }, 'a'), null)
  assert.equal(findOrgResult(null, 'a'), null)
  assert.equal(findOrgResult(undefined, 'a'), null)
})

test('isFreshCompletedClaim: true only for claimed + freshlyCreated + status=completed', () => {
  assert.equal(isFreshCompletedClaim({ claimed: true, freshlyCreated: true, status: 'completed' }), true)
  assert.equal(isFreshCompletedClaim({ claimed: true, freshlyCreated: true, status: 'queued' }), false, 'must be completed')
  assert.equal(isFreshCompletedClaim({ claimed: true, freshlyCreated: false, status: 'completed' }), false, 'must be freshlyCreated')
  assert.equal(isFreshCompletedClaim({ claimed: false, freshlyCreated: true, status: 'completed' }), false, 'must be claimed')
  assert.equal(isFreshCompletedClaim(null), false)
})

test('isIdempotentNoOpRepeat: true only for claimed:false + reason=already_completed + matching jobId', () => {
  assert.equal(isIdempotentNoOpRepeat({ claimed: false, reason: 'already_completed', jobId: 'j1' }, 'j1'), true)
  assert.equal(isIdempotentNoOpRepeat({ claimed: true, reason: 'already_completed', jobId: 'j1' }, 'j1'), false, 'must be claimed:false')
  assert.equal(isIdempotentNoOpRepeat({ claimed: false, reason: 'error', jobId: 'j1' }, 'j1'), false, 'must be reason=already_completed')
  assert.equal(isIdempotentNoOpRepeat({ claimed: false, reason: 'already_completed', jobId: 'j2' }, 'j1'), false, 'jobId must match')
})

test('isResumingQueuedClaim: true only for claimed:true + freshlyCreated:false + status=queued + matching jobId', () => {
  assert.equal(isResumingQueuedClaim({ claimed: true, freshlyCreated: false, status: 'queued', jobId: 'j1' }, 'j1'), true)
  assert.equal(isResumingQueuedClaim({ claimed: true, freshlyCreated: true, status: 'queued', jobId: 'j1' }, 'j1'), false, 'must NOT be freshlyCreated (that would mean a new job, not a resume)')
  assert.equal(isResumingQueuedClaim({ claimed: true, freshlyCreated: false, status: 'completed', jobId: 'j1' }, 'j1'), false, 'must still be queued, not completed')
  assert.equal(isResumingQueuedClaim({ claimed: true, freshlyCreated: false, status: 'queued', jobId: 'j2' }, 'j1'), false, 'jobId must match (same job, not a new one)')
  assert.equal(isResumingQueuedClaim({ claimed: false, freshlyCreated: false, status: 'queued', jobId: 'j1' }, 'j1'), false, 'must be claimed')
})

test('resolveMaxOrgsPerRunForFullCoverage: adds headroom, caps at the real zod ceiling, refuses loudly past it', () => {
  assert.deepEqual(resolveMaxOrgsPerRunForFullCoverage(0), { ok: true, value: 3 })
  assert.deepEqual(resolveMaxOrgsPerRunForFullCoverage(2), { ok: true, value: 5 })
  assert.deepEqual(resolveMaxOrgsPerRunForFullCoverage(47), { ok: true, value: MAX_ORGS_PER_RUN_CEILING }, '47+3=50 exactly at the ceiling is still ok')

  const overCeiling = resolveMaxOrgsPerRunForFullCoverage(48)
  assert.equal(overCeiling.ok, false)
  assert.match(overCeiling.error, /caps maxOrgsPerRun at 50/)
  assert.match(overCeiling.error, /48 distinct org/)

  const customHeadroom = resolveMaxOrgsPerRunForFullCoverage(10, 1)
  assert.deepEqual(customHeadroom, { ok: true, value: 11 })
})

test('residueIsZero: true only when every counter is exactly zero', () => {
  assert.equal(residueIsZero({ jobs: 0, records: 0, rules: 0, user_orgs: 0, users: 0 }), true)
  assert.equal(residueIsZero({ jobs: 0, records: 1, rules: 0, user_orgs: 0, users: 0 }), false)
  assert.equal(residueIsZero({}), true, 'no keys vacuously passes (matches Array.prototype.every semantics)')
})

// --- source-text shape locks (regex against this helper's own script, no DB/network needed) --------

test('source shape: required runtime env flags are checked by their real literal names', () => {
  assert.match(script, /ATTENDANCE_SCHEDULER_ENABLED_ENV = 'ATTENDANCE_SCHEDULER_ENABLED'/)
  assert.match(script, /REPORT_SYNC_SCHEDULED_TRIGGER_ENV_FLAG = 'ATTENDANCE_REPORT_SYNC_SCHEDULED_TRIGGER_ENABLED'/)
  assert.equal(ATTENDANCE_SCHEDULER_ENABLED_ENV, 'ATTENDANCE_SCHEDULER_ENABLED')
  assert.equal(REPORT_SYNC_SCHEDULED_TRIGGER_ENV_FLAG, 'ATTENDANCE_REPORT_SYNC_SCHEDULED_TRIGGER_ENABLED')
  assert.match(script, /assertRequiredRuntimeEnv/)
})

test('source shape: the PASS stamp template names every field this helper promises', () => {
  assert.match(script, /REPORT_SYNC_A2_API_DB_SMOKE_PASS deploy=\$\{DEPLOY_SHA\} stamp=\$\{STAMP\} org=\$\{ORG_IDS\.main\} orgs=\$\{ALL_ORG_IDS\.join\('\|'\)\} synced=\$\{synced\} collateralOtherOrgs=\$\{collateralRiskOrgIds\.length\} residue=0/)
})

test('source shape: cross-org fan-out guard exists and is gated by the documented override env var', () => {
  assert.match(script, /ALLOW_CROSS_ORG_REPORT_SYNC_FANOUT/)
  assert.equal(ALLOW_CROSS_ORG_FANOUT_ENV, 'ALLOW_CROSS_ORG_REPORT_SYNC_FANOUT')
  assert.match(script, /assertCrossOrgFanoutRisk/)
  assert.match(script, /refusing to run: resolveAttendanceReportSyncScheduledTriggerOrgIds has no per-org filter/)
})

test('source shape: SQL statements use parameterized placeholders for org/user/date values, not string interpolation', () => {
  // Every WHERE clause that filters by org/user id in this helper's own SQL must use a $N placeholder,
  // never a template-literal-interpolated value. This regex looks for the dangerous shape
  // (`= '${...}'` or `= "${...}"` inside a SQL template) and asserts it never appears.
  assert.doesNotMatch(script, /(WHERE|AND)\s+\w+\s*=\s*['"]\$\{/i, 'no interpolated literal values in SQL WHERE clauses')
  // Every INSERT statement in this helper uses numbered placeholders ($1, $2, ...) for its VALUES.
  const insertStatements = script.match(/INSERT INTO \w+[\s\S]*?VALUES\s*\([^)]*\)/g) || []
  assert.ok(insertStatements.length >= 3, 'expected at least the rules/users/user_orgs/attendance_records INSERT statements')
  for (const statement of insertStatements) {
    assert.match(statement, /\$\d/, `INSERT statement should use $N placeholders: ${statement.slice(0, 80)}...`)
  }
})

test('source shape: cleanup DELETEs cover every table this helper seeds INTO (dual reachability)', () => {
  const insertedTables = new Set([...script.matchAll(/INSERT INTO (\w+)/g)].map((match) => match[1]))
  // DELETE targets are either a template-literal-interpolated constant (`DELETE FROM ${CONST_NAME}`) or
  // a plain identifier (`DELETE FROM table_name`) — match both forms.
  const deletedTables = new Set(
    [...script.matchAll(/DELETE FROM (?:\$\{(\w+)\}|(\w+))/g)].map((match) => match[1] || match[2]),
  )
  // REPORT_SYNC_JOB_TABLE is interpolated as `${REPORT_SYNC_JOB_TABLE}`, not a literal identifier — the
  // regex above captures the constant NAME in that case, so normalize it to the real table name.
  if (deletedTables.has('REPORT_SYNC_JOB_TABLE')) {
    deletedTables.delete('REPORT_SYNC_JOB_TABLE')
    deletedTables.add(REPORT_SYNC_JOB_TABLE)
  }
  for (const table of insertedTables) {
    assert.ok(deletedTables.has(table), `table "${table}" is INSERTed by a seed helper but has no matching DELETE FROM in cleanup()`)
  }
  // plugin_attendance_report_sync_jobs is never INSERTed by this helper directly (the runner creates
  // those rows) but MUST still be cleaned up.
  assert.ok(deletedTables.has(REPORT_SYNC_JOB_TABLE), `${REPORT_SYNC_JOB_TABLE} must be cleaned up even though this helper never INSERTs it directly`)
})

test('source shape: settings restore in cleanup() is scoped to just reportSync, not a whole-blob PUT-back', () => {
  assert.match(script, /body:\s*\{\s*reportSync:\s*originalReportSync/)
})

test('source shape: the scenario functions exist for every S3 assertion the design-lock/PR body promise', () => {
  for (const fn of [
    'assertDoubleGateClosedBothHalves',
    'assertMainFlowCreateAndPatch',
    'assertMaxUsersPerRunThrottle',
    'assertMaxOrgsPerRunThrottle',
    'reportCollateralCrossOrgJobRows',
  ]) {
    assert.match(script, new RegExp(`function ${fn}`), `expected a ${fn}() function`)
  }
})
