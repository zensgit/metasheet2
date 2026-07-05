#!/usr/bin/env node
// Report-sync A2 scheduled-trigger staging smoke helper — the "missing 'enqueue' worker" for
// plugin_attendance_report_sync_jobs (design-lock #3623, RATIFIED owner-delegated 2026-07-05;
// runtime #3630). This is S3 of the design-lock's §3 completion bar.
//
// Structure/style/two-stage-stamp convention mirrors
// scripts/ops/staging-attendance-manual-missed-punch-reminder-hmr5-smoke.mjs (pure helpers exported
// for the companion .test.mjs, IS_MAIN gate, resolveEnvConfig, STAMP regex lock, two-stage PASS
// stamp). The actual scheduler-job mechanics (direct plugin require + in-process tick calls + a
// second-tick idempotency proof) mirror scripts/ops/staging-attendance-auto-shift-a2-smoke.mjs — this
// helper runs the exported A2 tick directly against the staging DB, without waiting for
// AttendanceScheduler's own interval loop, same convention as that helper.
//
// Grounding (plugins/plugin-attendance/index.cjs, once #3630 lands):
//   DEFAULT_SETTINGS.reportSync.scheduledTrigger = { enabled:false, cadence:'daily', maxOrgsPerRun:5,
//   maxUsersPerRun:100 }; env gate ATTENDANCE_REPORT_SYNC_SCHEDULED_TRIGGER_ENABLED (double-gate with
//   settings.reportSync.scheduledTrigger.enabled — BOTH required, missing either is a byte-exact
//   no-op: { ran:false, reason:'disabled', orgs:[] }); scheduler job name
//   'attendance-report-sync-scheduled'; test seam
//   attendancePlugin.__attendanceReportFieldCatalogForTests.runAttendanceReportSyncScheduledTriggerOnce
//   (context, db, logger, { now, emitEvent }) -> { ran, cadence, orgs: [{ orgId, claimed, status,
//   freshlyCreated, totals, jobId, workDate, idempotencyKey, reason? }] }; per-org claim delegates to
//   the EXISTING runAttendanceReportSyncJobNextPage -> syncAttendanceReportRecordsForUsers path (zero
//   write-semantics change, design-lock §3); repeat-tick idempotency is the job table's
//   (org_id, idempotency_key) partial unique index PLUS the writer's own dual source/field-fingerprint
//   compare (skip vs create vs patch); resolveAttendanceReportSyncScheduledTriggerOrgIds does
//   `SELECT DISTINCT org_id FROM attendance_rules ORDER BY org_id` with NO per-org filter, sliced to
//   maxOrgsPerRun — see the SCOPE NOTE below.
//
// SCOPE NOTE (read before extending this helper) — two things this smoke deliberately does NOT prove:
//
//  1. Real multitable base/sheet writes. context.api.multitable here is an in-process, in-memory
//     stand-in (createFakeReportRecordsMultitable below), not the real multitable REST/plugin stack.
//     The design-lock explicitly delegates writes to the EXISTING syncAttendanceReportRecordsForUsers
//     writer and says A2 must not "re-implement stats/multitable writes" (§2 S2) — that writer's real
//     multitable behavior is already staging-proven separately (2026-05-19 live evidence via
//     `pnpm run verify:attendance-report-fields:live` JOB_MODE=1, scripts/ops/attendance-report-fields-
//     live-acceptance.mjs) and covered by the existing real-DB CI gate (which uses an identically-shaped
//     fake — see the 'attendance report sync scheduled trigger (A2)' describe block added to
//     packages/core-backend/tests/integration/attendance-plugin.test.ts by #3630). This smoke's job is
//     the NEW part: the scheduling/claim/idempotency/throttle layer around that writer, proven for real
//     against real staging Postgres (attendance_rules/users/user_orgs/attendance_records and the
//     plugin_attendance_report_sync_jobs control-plane table) and the real settings HTTP API — hence the
//     API_DB stamp name below, not an API_MULTITABLE one. See the runbook's "Manual close-out steps" for
//     the real-multitable spot-check some operators may want as an extra, optional proof.
//
//  2. The real AttendanceScheduler interval pickup. Like the auto-shift-a2 smoke, this helper calls the
//     exported tick function directly in this Node process — it does not prove the REAL deployed
//     scheduler actually registers and ticks 'attendance-report-sync-scheduled' on its own interval.
//     See the runbook's required manual step for that.
//
// CROSS-ORG FAN-OUT HAZARD (read before running on a real shared staging DB): resolveAttendance-
// ReportSyncScheduledTriggerOrgIds has NO per-org filter — a gate-open tick claims+runs a report-sync
// job for every org with an attendance_rules row, up to maxOrgsPerRun (deterministic ORDER BY org_id
// as of the #3630 review pass; still no allowlist). This helper computes maxOrgsPerRun wide enough to
// guarantee ITS OWN synthetic orgs are covered every time, which means it ALSO sweeps in any
// pre-existing real orgs on the target DB (read-only reads of their attendance_records, plus one real
// plugin_attendance_report_sync_jobs row created for each — this helper's in-memory multitable adapter
// means no multitable write escapes to them). See assertCrossOrgFanoutRisk() below: this helper REFUSES
// to run against a DB with pre-existing other-org attendance_rules rows unless
// ALLOW_CROSS_ORG_REPORT_SYNC_FANOUT=1 is set, and reports (but does not delete) any collateral job rows
// it caused for those other orgs at the end.
//
// Usage:
//   BASE_URL=http://127.0.0.1:8082 \
//   DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet \
//   DEPLOY_SHA=<staging-main-sha> \
//   ATTENDANCE_SCHEDULER_ENABLED=true \
//   ATTENDANCE_REPORT_SYNC_SCHEDULED_TRIGGER_ENABLED=true \
//   node scripts/ops/staging-attendance-report-sync-a2-smoke.mjs
//
// Optional: SMOKE_TOKEN=<admin bearer> STAMP=reportsync-a2-smoke-... RUN_DATE=2026-07-05
//           ALLOW_CROSS_ORG_REPORT_SYNC_FANOUT=1

import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

// --- pure helpers (exported for the companion .test.mjs) -------------------------------------

export const STAMP_PATTERN = /^reportsync-a2-smoke-[A-Za-z0-9-]+$/

export const ATTENDANCE_SCHEDULER_ENABLED_ENV = 'ATTENDANCE_SCHEDULER_ENABLED'
export const REPORT_SYNC_SCHEDULED_TRIGGER_ENV_FLAG = 'ATTENDANCE_REPORT_SYNC_SCHEDULED_TRIGGER_ENABLED'
export const REPORT_SYNC_JOB_TABLE = 'plugin_attendance_report_sync_jobs'
// Mirrors ATTENDANCE_REPORT_SYNC_SCHEDULED_TRIGGER_CREATED_BY (index.cjs) — used ONLY for the
// informational (non-asserted) collateral cross-org report at the end, never for a pass/fail gate. If
// this literal ever drifts from the real constant the report just undercounts; low risk by design.
export const REPORT_SYNC_SCHEDULED_TRIGGER_CREATED_BY = 'system:attendance-report-sync-scheduled-trigger'
export const ALLOW_CROSS_ORG_FANOUT_ENV = 'ALLOW_CROSS_ORG_REPORT_SYNC_FANOUT'
// zod ceiling on reportSync.scheduledTrigger.maxOrgsPerRun (index.cjs settingsSchema, design-lock §2 S1).
export const MAX_ORGS_PER_RUN_CEILING = 50

export function isStampedId(value, prefix) {
  return typeof value === 'string' && value.startsWith(prefix) && value.length > prefix.length
}

// Env-only contract (no CLI args), mirroring the HMR-5 helper: BASE_URL/DATABASE_URL required,
// DEPLOY_SHA mandatory (the PASS stamp must name the staging build actually smoked), STAMP regex-
// locked. All three synthetic org ids are DERIVED from the stamp (no separate ORG_ID override) so they
// are always visibly disposable and always prefix-safe for cleanup.
export function resolveEnvConfig(env = {}) {
  const errors = []
  const baseUrl = String(env.BASE_URL || env.BASE || '').replace(/\/$/, '')
  const databaseUrl = String(env.DATABASE_URL || '')
  if (!baseUrl || !databaseUrl) {
    errors.push('BASE_URL and DATABASE_URL are required.')
  }
  const deploySha = String(env.DEPLOY_SHA || env.EXPECTED_DEPLOY_SHA || '')
  if (!deploySha || deploySha === '<fill-from-staging-build>') {
    errors.push('DEPLOY_SHA is required so the PASS stamp names the staging build that was actually smoked.')
  }
  const suffix = Date.now().toString(36)
  const stamp = String(env.STAMP || `reportsync-a2-smoke-${suffix}`)
  if (!STAMP_PATTERN.test(stamp)) {
    errors.push('STAMP must match /^reportsync-a2-smoke-[A-Za-z0-9-]+$/ so cleanup stays visibly synthetic and LIKE-free.')
  }
  const orgIds = {
    gate: `${stamp}-gate`,
    main: `${stamp}-main`,
    throttle: `${stamp}-throttle`,
  }
  const runDate = String(env.RUN_DATE || '').trim()
  if (runDate && !/^\d{4}-\d{2}-\d{2}$/.test(runDate)) {
    errors.push('RUN_DATE must be YYYY-MM-DD when set.')
  }
  return {
    ok: errors.length === 0,
    errors,
    config: {
      baseUrl,
      databaseUrl,
      deploySha,
      stamp,
      suffix,
      orgIds,
      runDate,
      allowCrossOrgFanout: env[ALLOW_CROSS_ORG_FANOUT_ENV] === '1',
    },
  }
}

// Mirrors attendanceReportRecordRowKey in plugins/plugin-attendance/index.cjs (design-lock #3623,
// pre-existing since the 2026-05-19 report-sync-jobs PR2 writer) — keep in sync. Only the one-line
// row-key FORMULA is duplicated here so this helper can pre-compute expected rowKeys for its in-memory
// fixture; the actual sync/writer logic itself is never re-implemented (design-lock §2 S2).
export function attendanceReportRecordRowKey(orgId, userId, workDate) {
  return `${orgId}:${userId}:${workDate}`
}

// In-process stand-in for context.api.multitable, matching the SAME shape (records.queryRecords/
// createRecord/patchRecord, provisioning.ensureObject/resolveFieldIds) as the fake the #3630 real-DB
// vitest gate itself uses ('attendance report sync scheduled trigger (A2)' describe block) — including
// its 'fld_' physical-id prefixing convention, so this helper genuinely exercises the physical/logical
// field-id indirection rather than a degenerate identity mapping. See the file-header SCOPE NOTE:
// this is intentionally NOT the real multitable stack.
export function createFakeReportRecordsMultitable() {
  const store = []
  let seq = 0
  const rowKeyFieldId = 'fld_row_key'
  const fieldFingerprintFieldId = 'fld_field_fingerprint'
  const sourceFingerprintFieldId = 'fld_source_fingerprint'
  const records = {
    queryRecords: async ({ filters } = {}) => {
      const want = filters || {}
      return store.filter((row) => Object.entries(want).every(([key, value]) => row.data[key] === value))
    },
    createRecord: async ({ data }) => {
      const rec = { id: `rec-${++seq}`, data: { ...data } }
      store.push(rec)
      return rec
    },
    patchRecord: async ({ recordId, changes }) => {
      const rec = store.find((row) => row.id === recordId)
      if (rec) rec.data = { ...rec.data, ...changes }
      return rec
    },
  }
  const provisioning = {
    ensureObject: async () => ({ baseId: 'base_rr', sheet: { id: 'sheet_rr' } }),
    resolveFieldIds: async ({ fieldIds }) => Object.fromEntries(fieldIds.map((fieldId) => [fieldId, `fld_${fieldId}`])),
  }
  return { store, records, provisioning, rowKeyFieldId, fieldFingerprintFieldId, sourceFingerprintFieldId }
}

// Seeds a stale pre-existing report-record row (mismatched dual fingerprint) directly into the fake
// store so the FIRST tick must PATCH it rather than create/skip it — the "陈旧报表事实" (stale report
// fact) S3 asks for, reconstructed in-process per the design-lock's own "(或既有 report-record 对象的
// 可重建输入)" allowance, rather than requiring a real pre-existing staging multitable row.
export function seedStaleReportRecordFixture(fake, rowKey) {
  fake.store.push({
    id: 'rec-stale-seed',
    data: {
      [fake.rowKeyFieldId]: rowKey,
      [fake.fieldFingerprintFieldId]: 'stale-field-fingerprint-marker',
      [fake.sourceFingerprintFieldId]: 'stale-source-fingerprint-marker',
    },
  })
}

// --- pure assertion-shape predicates (unit-testable without DB/network) ----------------------
// Each mirrors a shape documented/observed directly in #3630's own diff and its real-DB vitest gate
// (packages/core-backend/tests/integration/attendance-plugin.test.ts, 'attendance report sync
// scheduled trigger (A2)' describe block), so the companion .test.mjs can lock them against
// hand-built fixtures without needing #3630 merged into this checkout.

export function isDoubleGateClosedResult(result) {
  return !!result
    && result.ran === false
    && result.reason === 'disabled'
    && Array.isArray(result.orgs)
    && result.orgs.length === 0
}

export function findOrgResult(result, orgId) {
  const orgs = Array.isArray(result?.orgs) ? result.orgs : []
  return orgs.find((entry) => entry?.orgId === orgId) ?? null
}

export function isFreshCompletedClaim(orgResult) {
  return !!orgResult
    && orgResult.claimed === true
    && orgResult.freshlyCreated === true
    && orgResult.status === 'completed'
}

export function isIdempotentNoOpRepeat(orgResult, expectedJobId) {
  return !!orgResult
    && orgResult.claimed === false
    && orgResult.reason === 'already_completed'
    && orgResult.jobId === expectedJobId
}

export function isResumingQueuedClaim(orgResult, expectedJobId) {
  return !!orgResult
    && orgResult.claimed === true
    && orgResult.freshlyCreated === false
    && orgResult.status === 'queued'
    && orgResult.jobId === expectedJobId
}

// maxOrgsPerRun is capped at MAX_ORGS_PER_RUN_CEILING (zod). To guarantee THIS helper's own synthetic
// orgs are always included in a capped fan-out regardless of SELECT DISTINCT ordering, it asks for
// enough headroom to cover every existing distinct org on the target DB plus its own. If that would
// exceed the real ceiling, refuse with a clear, actionable message rather than silently under-covering
// (which would make this helper's own assertions flaky against a crowded shared staging DB).
export function resolveMaxOrgsPerRunForFullCoverage(existingDistinctOrgCount, headroom = 3) {
  const needed = Math.max(1, Math.floor(Number(existingDistinctOrgCount) || 0) + headroom)
  if (needed > MAX_ORGS_PER_RUN_CEILING) {
    return {
      ok: false,
      error: `staging attendance_rules already has ${existingDistinctOrgCount} distinct org(s) — need `
        + `maxOrgsPerRun=${needed} to guarantee this smoke's synthetic orgs are covered every tick, but `
        + `the settings schema caps maxOrgsPerRun at ${MAX_ORGS_PER_RUN_CEILING}. Clean up stale/unrelated `
        + 'orgs on this DB first, or point DATABASE_URL at a less crowded one.',
    }
  }
  return { ok: true, value: Math.min(MAX_ORGS_PER_RUN_CEILING, needed) }
}

export function residueIsZero(counts) {
  return Object.values(counts).every((value) => Number(value) === 0)
}

// --- runtime wiring ----------------------------------------------------------------------------

const IS_MAIN = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false
const ENTRY = resolveEnvConfig(process.env)
if (IS_MAIN && !ENTRY.ok) {
  for (const message of ENTRY.errors) console.error(`FAIL: ${message}`)
  console.error('  e.g. BASE_URL=http://127.0.0.1:8082 DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet DEPLOY_SHA=<deployed-sha> ATTENDANCE_SCHEDULER_ENABLED=true ATTENDANCE_REPORT_SYNC_SCHEDULED_TRIGGER_ENABLED=true node scripts/ops/staging-attendance-report-sync-a2-smoke.mjs')
  process.exit(2)
}

const {
  baseUrl: BASE_URL,
  databaseUrl: DATABASE_URL,
  deploySha: DEPLOY_SHA,
  stamp: STAMP,
  orgIds: ORG_IDS,
  runDate: RUN_DATE_OVERRIDE,
} = ENTRY.config

const RUN_NOW = RUN_DATE_OVERRIDE ? new Date(`${RUN_DATE_OVERRIDE}T12:00:00.000Z`) : (() => {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0))
})()
const WORK_DATE = RUN_NOW.toISOString().slice(0, 10)

const USERS = {
  gate: `${ORG_IDS.gate}-u`,
  mainFresh: `${ORG_IDS.main}-fresh`,
  mainStale: `${ORG_IDS.main}-stale`,
  throttle: [1, 2, 3].map((n) => `${ORG_IDS.throttle}-u${n}`),
}
const ALL_ORG_IDS = [ORG_IDS.gate, ORG_IDS.main, ORG_IDS.throttle]
const ALL_USER_IDS = [USERS.gate, USERS.mainFresh, USERS.mainStale, ...USERS.throttle]

let token = process.env.SMOKE_TOKEN || process.env.ADMIN_TOKEN || process.env.TOKEN || ''
let originalReportSync = null
let cleanupAllowed = false
let seam = null
let runner = null

let pass = 0
const failures = []
function ok(condition, label, detail) {
  if (condition) {
    pass += 1
    console.log(`  PASS  ${label}`)
    return
  }
  failures.push(label)
  const extra = detail === undefined ? '' : ` — ${JSON.stringify(detail)}`
  console.error(`  FAIL  ${label}${extra}`)
}

function assertRequiredRuntimeEnv() {
  const required = [ATTENDANCE_SCHEDULER_ENABLED_ENV, REPORT_SYNC_SCHEDULED_TRIGGER_ENV_FLAG]
  const missing = required.filter((name) => process.env[name] !== 'true')
  if (missing.length) {
    throw new Error(`refusing to run: missing required staging runtime env in this runner process: ${missing.join(', ')}. This helper calls the scheduled-trigger runner directly (bypassing the interval scheduler, same convention as staging-attendance-auto-shift-a2-smoke.mjs), but still requires these flags exported truthfully so a PASS here reflects what the REAL deployed scheduler would also do once turned on. Export them (or run from the deployed backend/container environment) before invoking this helper.`)
  }
  ok(true, 'required scheduler/A2 report-sync runtime env flags are true in this runner process')
}

function requireRunnerExport() {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
  const require = createRequire(import.meta.url)
  const attendancePlugin = require(path.join(repoRoot, 'plugins/plugin-attendance/index.cjs'))
  seam = attendancePlugin.__attendanceReportFieldCatalogForTests || {}
  const requiredExports = [
    'runAttendanceReportSyncScheduledTriggerOnce',
    'resolveAttendanceReportSyncScheduledTriggerOrgIds',
    'resetAttendanceSettingsCacheForTests',
  ]
  const missingExports = requiredExports.filter((name) => typeof seam[name] !== 'function')
  ok(missingExports.length === 0, 'attendance plugin exports the A2 scheduled-trigger test seam', missingExports)
  if (missingExports.length) {
    throw new Error(`attendance plugin is missing exported test seam(s): ${missingExports.join(', ')}. Is the deployed/checked-out source at/after #3630 (report-sync A2 scheduled trigger runtime)? This helper depends on #3630 merging first.`)
  }
  runner = seam.runAttendanceReportSyncScheduledTriggerOnce
}

async function withEnvFlag(value, fn) {
  const prev = process.env[REPORT_SYNC_SCHEDULED_TRIGGER_ENV_FLAG]
  if (value === undefined) delete process.env[REPORT_SYNC_SCHEDULED_TRIGGER_ENV_FLAG]
  else process.env[REPORT_SYNC_SCHEDULED_TRIGGER_ENV_FLAG] = value
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env[REPORT_SYNC_SCHEDULED_TRIGGER_ENV_FLAG]
    else process.env[REPORT_SYNC_SCHEDULED_TRIGGER_ENV_FLAG] = prev
  }
}

async function api(pathname, { method = 'GET', body } = {}) {
  const url = new URL(`${BASE_URL}${pathname}`)
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json = null
  try { json = await res.json() } catch { /* non-json */ }
  return { status: res.status, body: json }
}

async function mintToken() {
  const userId = `${STAMP}-admin`
  const res = await api(`/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('attendance:read,attendance:write,attendance:admin')}`)
  token = res.body?.token || ''
  if (!token) throw new Error(`could not mint dev-token (status ${res.status}); set SMOKE_TOKEN for staging auth`)
  console.log('  minted dev-token for the smoke admin')
}

async function putReportSyncSettings(scheduledTrigger) {
  const res = await api('/api/attendance/settings', { method: 'PUT', body: { reportSync: { scheduledTrigger } } })
  ok(res.status === 200, `PUT reportSync.scheduledTrigger settings (${res.status})`, res.body)
  if (res.status !== 200) throw new Error('could not PUT reportSync.scheduledTrigger settings')
  return res.body?.data?.reportSync ?? null
}

function resetSettingsCache() {
  seam.resetAttendanceSettingsCacheForTests?.()
}

const poolBox = { pool: null }
const q = (text, params) => poolBox.pool.query(text, params).then((result) => result.rows)

function createPluginDb(poolForRunner) {
  return {
    query: async (text, params) => (await poolForRunner.query(text, params)).rows,
    transaction: async (callback) => {
      const client = await poolForRunner.connect()
      try {
        await client.query('BEGIN')
        const trx = { query: async (text, params) => (await client.query(text, params)).rows }
        const result = await callback(trx)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },
  }
}

let pluginDb = null
let fake = null
let context = null

function runTick() {
  return runner(context, pluginDb, console, { now: RUN_NOW, emitEvent: () => undefined })
}

async function jobRowCount(orgId) {
  const rows = await q(`SELECT count(*)::int AS n FROM ${REPORT_SYNC_JOB_TABLE} WHERE org_id = $1`, [orgId])
  return Number(rows[0]?.n || 0)
}

async function countDistinctAttendanceRulesOrgs() {
  const rows = await q('SELECT count(DISTINCT org_id)::int AS n FROM attendance_rules')
  return Number(rows[0]?.n || 0)
}

async function computeCoveringMaxOrgsPerRun() {
  const total = await countDistinctAttendanceRulesOrgs()
  const resolved = resolveMaxOrgsPerRunForFullCoverage(total)
  if (!resolved.ok) throw new Error(resolved.error)
  return resolved.value
}

// --- preflight -----------------------------------------------------------------------------

async function preflightNoExistingResidue() {
  const rows = await q(
    `SELECT
       (SELECT count(*)::int FROM ${REPORT_SYNC_JOB_TABLE} WHERE org_id = ANY($1::text[])) AS jobs,
       (SELECT count(*)::int FROM attendance_records WHERE org_id = ANY($1::text[])) AS records,
       (SELECT count(*)::int FROM attendance_rules WHERE org_id = ANY($1::text[])) AS rules,
       (SELECT count(*)::int FROM user_orgs WHERE user_id = ANY($2::text[])) AS user_orgs,
       (SELECT count(*)::int FROM users WHERE id = ANY($2::text[])) AS users`,
    [ALL_ORG_IDS, ALL_USER_IDS],
  )
  const row = rows[0] || {}
  const clean = Object.values(row).every((value) => Number(value) === 0)
  ok(clean, 'no pre-existing residue for this stamp\'s synthetic orgs/users', row)
  if (!clean) throw new Error(`pre-existing residue found for stamp ${STAMP}; use a fresh STAMP or inspect before running`)
}

// resolveAttendanceReportSyncScheduledTriggerOrgIds has no per-org filter (see file-header CROSS-ORG
// FAN-OUT HAZARD note) — refuse to open the gate on a DB with pre-existing other-org attendance_rules
// rows unless explicitly overridden.
async function assertCrossOrgFanoutRisk() {
  const rows = await q('SELECT DISTINCT org_id FROM attendance_rules WHERE org_id <> ALL($1::text[]) ORDER BY org_id', [ALL_ORG_IDS])
  const otherOrgIds = rows.map((row) => row.org_id)
  const allowed = ENTRY.config.allowCrossOrgFanout
  if (otherOrgIds.length > 0 && !allowed) {
    throw new Error(
      `refusing to run: resolveAttendanceReportSyncScheduledTriggerOrgIds has no per-org filter — `
      + `SELECT DISTINCT org_id FROM attendance_rules scans EVERY org on this DB. Once this helper opens `
      + `the double-gate, a tick will ALSO claim+run a report-sync job for ${otherOrgIds.length} `
      + `pre-existing other org(s) (${otherOrgIds.slice(0, 8).join(', ')}${otherOrgIds.length > 8 ? ', ...' : ''}), `
      + `creating real ${REPORT_SYNC_JOB_TABLE} rows this helper's cleanup will NOT remove (out of `
      + 'blast-radius scope — those orgs were not created by this run). This helper\'s own multitable '
      + `adapter is in-process/in-memory only (see file-header SCOPE NOTE), so no multitable write `
      + `escapes to those orgs — but the job-table row and the read of their real attendance_records IS `
      + `real. Set ${ALLOW_CROSS_ORG_FANOUT_ENV}=1 to proceed anyway, or point DATABASE_URL at a DB with `
      + 'no other orgs\' attendance_rules rows first.',
    )
  }
  ok(
    otherOrgIds.length === 0 || allowed,
    otherOrgIds.length === 0
      ? 'no pre-existing other-org attendance_rules rows (no cross-org fan-out risk)'
      : `cross-org fan-out allowed by explicit override (${otherOrgIds.length} other org(s))`,
    otherOrgIds,
  )
  return otherOrgIds
}

// --- seed ------------------------------------------------------------------------------------

async function seedRule(orgId, timezone = 'UTC') {
  await q(
    `INSERT INTO attendance_rules
       (id, org_id, name, timezone, work_start_time, work_end_time, late_grace_minutes, early_grace_minutes,
        severe_late_threshold_minutes, absence_late_threshold_minutes, rounding_minutes, working_days, is_default)
     VALUES ($1, $2, $3, $4, '09:00', '18:00', 5, 5, 30, 60, 1, '[1,2,3,4,5]'::jsonb, true)`,
    [randomUUID(), orgId, `A2 report-sync smoke rule ${orgId}`, timezone],
  )
}

async function seedUser(userId, orgId) {
  await q(
    `INSERT INTO users (id, email, password_hash, is_active) VALUES ($1, $2, 'no-login', true)
     ON CONFLICT (id) DO UPDATE SET is_active = true`,
    [userId, `${userId}@example.test`],
  )
  await q(
    `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)
     ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = true`,
    [userId, orgId],
  )
}

async function seedAttendanceRecord(orgId, userId, workDate) {
  await q(
    `INSERT INTO attendance_records
     (id, user_id, org_id, work_date, timezone, first_in_at, last_out_at, work_minutes, late_minutes,
      early_leave_minutes, status, is_workday, meta, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'UTC', $5, $6, 480, 0, 0, 'normal', true, '{}'::jsonb, now(), now())
     ON CONFLICT DO NOTHING`,
    [randomUUID(), userId, orgId, workDate, new Date(`${workDate}T09:00:00Z`), new Date(`${workDate}T18:00:00Z`)],
  )
}

// --- scenario 1: double-gate closed ------------------------------------------------------------

async function assertDoubleGateClosedBothHalves(orgId) {
  // half 1: env unset, settings still at their off default (never PUT anything yet).
  const envUnset = await withEnvFlag(undefined, () => runTick())
  ok(isDoubleGateClosedResult(envUnset), 'gate closed (env unset, settings default-off): byte-exact no-op', envUnset)
  ok(await jobRowCount(orgId) === 0, 'zero job rows for the gate org after the env-unset tick')

  // half 2: env true, settings still off (isolates that env=true ALONE does not open the gate).
  const settingsOff = await withEnvFlag('true', () => runTick())
  ok(isDoubleGateClosedResult(settingsOff), 'gate closed (env true, settings still off): byte-exact no-op', settingsOff)
  ok(await jobRowCount(orgId) === 0, 'zero job rows for the gate org after the settings-off tick')

  // half 3: settings enabled=true globally, but env temporarily unset for this ONE call — isolates
  // that the ENV half independently gates the runner, not just settings (mirrors #3630's own
  // 'double-gate: settings.enabled=true but env flag unset' vitest case).
  await putReportSyncSettings({ enabled: true, cadence: 'daily', maxOrgsPerRun: await computeCoveringMaxOrgsPerRun(), maxUsersPerRun: 100 })
  resetSettingsCache()
  const envUnsetAgain = await withEnvFlag(undefined, () => runTick())
  ok(isDoubleGateClosedResult(envUnsetAgain), 'gate closed (settings true, env unset): byte-exact no-op', envUnsetAgain)
  ok(await jobRowCount(orgId) === 0, 'zero job rows for the gate org even with settings enabled while env is unset')
  // Settings stay enabled=true globally for scenarios 2/3 below; the required env flag is already
  // 'true' in this process per assertRequiredRuntimeEnv().
}

// --- scenario 2: create + patch + idempotent repeat tick ----------------------------------------

async function assertMainFlowCreateAndPatch() {
  const orgId = ORG_IDS.main
  await seedRule(orgId)
  await seedUser(USERS.mainFresh, orgId)
  await seedAttendanceRecord(orgId, USERS.mainFresh, WORK_DATE)
  await seedUser(USERS.mainStale, orgId)
  await seedAttendanceRecord(orgId, USERS.mainStale, WORK_DATE)

  const staleRowKey = attendanceReportRecordRowKey(orgId, USERS.mainStale, WORK_DATE)
  seedStaleReportRecordFixture(fake, staleRowKey)

  await putReportSyncSettings({ enabled: true, cadence: 'daily', maxOrgsPerRun: await computeCoveringMaxOrgsPerRun(), maxUsersPerRun: 100 })
  resetSettingsCache()
  const tick1 = await runTick()
  const mine1 = findOrgResult(tick1, orgId)
  ok(isFreshCompletedClaim(mine1), 'main flow tick 1: fresh claim, completed in one page', mine1)
  ok(
    mine1?.totals?.usersScanned === 2 && mine1.totals.created === 1 && mine1.totals.patched === 1 && mine1.totals.skipped === 0,
    'main flow tick 1 totals: 1 created (fresh user) + 1 patched (stale user), 0 skipped',
    mine1?.totals,
  )

  const jobRow = (await q(
    `SELECT status, mode, kind, idempotency_key FROM ${REPORT_SYNC_JOB_TABLE} WHERE org_id = $1`,
    [orgId],
  ))[0]
  ok(
    jobRow?.status === 'completed' && jobRow?.mode === 'enqueue' && jobRow?.kind === 'daily_records'
      && jobRow?.idempotency_key === mine1?.idempotencyKey,
    'main flow: job control-plane row shape (mode=enqueue, kind=daily_records, status=completed, idempotency_key matches)',
    jobRow,
  )

  const freshRowKey = attendanceReportRecordRowKey(orgId, USERS.mainFresh, WORK_DATE)
  const freshRec = fake.store.find((row) => row.data[fake.rowKeyFieldId] === freshRowKey)
  const staleRec = fake.store.find((row) => row.data[fake.rowKeyFieldId] === staleRowKey)
  ok(!!freshRec, 'fresh user got a genuinely CREATED report-record row', freshRec)
  ok(
    !!staleRec
      && staleRec.data[fake.fieldFingerprintFieldId] !== 'stale-field-fingerprint-marker'
      && staleRec.data[fake.sourceFingerprintFieldId] !== 'stale-source-fingerprint-marker',
    'stale user\'s pre-seeded row was genuinely PATCHED away from its stale dual-fingerprint markers',
    staleRec,
  )
  ok(fake.store.length === 2, 'exactly 2 report-record rows exist after tick 1 (no extras)', fake.store.length)

  resetSettingsCache()
  const tick2 = await runTick()
  const mine2 = findOrgResult(tick2, orgId)
  ok(isIdempotentNoOpRepeat(mine2, mine1?.jobId), 'main flow tick 2 (same period): idempotent no-op, same jobId, reason=already_completed', mine2)
  ok(await jobRowCount(orgId) === 1, 'main flow: still exactly 1 job row after the repeat tick (no duplicate job)')
  ok(fake.store.length === 2, 'main flow: still exactly 2 report-record rows after the repeat tick (no duplicate/second write)', fake.store.length)

  return { totalsTick1: mine1?.totals ?? null }
}

// --- scenario 3: maxUsersPerRun throttles pagination across ticks ------------------------------

async function assertMaxUsersPerRunThrottle() {
  const orgId = ORG_IDS.throttle
  const baseline = fake.store.length
  await seedRule(orgId)
  for (const userId of USERS.throttle) {
    await seedUser(userId, orgId)
    await seedAttendanceRecord(orgId, userId, WORK_DATE)
  }

  await putReportSyncSettings({ enabled: true, cadence: 'daily', maxOrgsPerRun: await computeCoveringMaxOrgsPerRun(), maxUsersPerRun: 1 })

  resetSettingsCache()
  const t1 = findOrgResult(await runTick(), orgId)
  ok(isFreshCompletedClaim(t1) === false && t1?.claimed === true && t1?.freshlyCreated === true && t1?.status === 'queued',
    'throttle tick 1: fresh claim, queued (page 1 of 3, not yet complete)', t1)
  ok(fake.store.length === baseline + 1, 'throttle tick 1: exactly 1 new report-record row (maxUsersPerRun=1 paged one user)', fake.store.length - baseline)
  ok(await jobRowCount(orgId) === 1, 'throttle: exactly 1 job row after tick 1')
  const jobId = t1?.jobId

  resetSettingsCache()
  const t2 = findOrgResult(await runTick(), orgId)
  ok(isResumingQueuedClaim(t2, jobId), 'throttle tick 2: resumes the SAME job (not recreated), still queued (page 2 of 3)', t2)
  ok(fake.store.length === baseline + 2, 'throttle tick 2: exactly 2 new rows total so far', fake.store.length - baseline)
  ok(await jobRowCount(orgId) === 1, 'throttle: still exactly 1 job row after tick 2 (resumed, not duplicated)')

  resetSettingsCache()
  const t3 = findOrgResult(await runTick(), orgId)
  ok(t3?.claimed === true && t3.freshlyCreated === false && t3.status === 'completed' && t3.jobId === jobId,
    'throttle tick 3: SAME job completes (page 3 of 3, roster fully drained)', t3)
  ok(fake.store.length === baseline + 3, 'throttle tick 3: all 3 throttle users synced', fake.store.length - baseline)
  const expectedRowKeys = new Set(USERS.throttle.map((userId) => attendanceReportRecordRowKey(orgId, userId, WORK_DATE)))
  const actualRowKeys = new Set(fake.store.slice(baseline).map((row) => row.data[fake.rowKeyFieldId]))
  ok(
    actualRowKeys.size === expectedRowKeys.size && [...expectedRowKeys].every((key) => actualRowKeys.has(key)),
    'throttle: the 3 synced rowKeys exactly match the 3 throttle users',
    { expected: [...expectedRowKeys], actual: [...actualRowKeys] },
  )

  resetSettingsCache()
  const t4 = findOrgResult(await runTick(), orgId)
  ok(isIdempotentNoOpRepeat(t4, jobId), 'throttle tick 4: roster already drained -> no-op (reason=already_completed)', t4)
  ok(fake.store.length === baseline + 3, 'throttle tick 4: no additional writes', fake.store.length - baseline)
  ok(await jobRowCount(orgId) === 1, 'throttle: still exactly 1 job row after the roster fully drains')

  return { totalsAfterDrain: t3?.totals ?? null }
}

// --- maxOrgsPerRun throttle (pure helper, direct call — no full-flow org-inclusion guessing needed) --

async function assertMaxOrgsPerRunThrottle() {
  const total = await countDistinctAttendanceRulesOrgs()
  const resolveOrgIds = seam.resolveAttendanceReportSyncScheduledTriggerOrgIds
  const capped = await resolveOrgIds(pluginDb, 1, console)
  ok(capped.length === 1, 'maxOrgsPerRun=1 caps the org fan-out to exactly 1 org', capped.length)
  const exact = await resolveOrgIds(pluginDb, total, console)
  ok(exact.length === total, `maxOrgsPerRun=<total distinct orgs=${total}> covers every org`, exact.length)
  const overshoot = await resolveOrgIds(pluginDb, total + 25, console)
  ok(overshoot.length === total, 'maxOrgsPerRun far above the real total does not pad past the real total', overshoot.length)
}

// --- collateral cross-org report (informational only, never asserted) --------------------------

async function reportCollateralCrossOrgJobRows(smokeStartedAt) {
  const rows = await q(
    `SELECT org_id, count(*)::int AS n FROM ${REPORT_SYNC_JOB_TABLE}
     WHERE org_id <> ALL($1::text[]) AND created_by = $2 AND created_at >= $3
     GROUP BY org_id ORDER BY org_id`,
    [ALL_ORG_IDS, REPORT_SYNC_SCHEDULED_TRIGGER_CREATED_BY, smokeStartedAt],
  )
  if (rows.length) {
    console.warn(`  WARN: this run's gate-open ticks also claimed+ran a report-sync job for ${rows.length} pre-existing OTHER org(s) — outside this helper's cleanup scope, left in place for operator review: ${JSON.stringify(rows)}`)
  }
  return rows
}

// --- cleanup / residue ---------------------------------------------------------------------------

async function residueCounts() {
  const rows = await q(
    `SELECT
       (SELECT count(*)::int FROM ${REPORT_SYNC_JOB_TABLE} WHERE org_id = ANY($1::text[])) AS jobs,
       (SELECT count(*)::int FROM attendance_records WHERE org_id = ANY($1::text[])) AS records,
       (SELECT count(*)::int FROM attendance_rules WHERE org_id = ANY($1::text[])) AS rules,
       (SELECT count(*)::int FROM user_orgs WHERE user_id = ANY($2::text[])) AS user_orgs,
       (SELECT count(*)::int FROM users WHERE id = ANY($2::text[])) AS users`,
    [ALL_ORG_IDS, ALL_USER_IDS],
  )
  return rows[0] || {}
}

async function cleanup() {
  if (!cleanupAllowed) {
    console.log('  cleanup skipped: helper did not pass the initial safety/auth gate')
    return
  }
  // Scoped restore of just the reportSync sub-key (not a whole-blob PUT-back) — every top-level
  // settings key is independently .optional(), so this never touches unrelated sibling settings and
  // never inherits an unrelated sibling's round-trip quirk (mirrors #3630's own vitest teardown note).
  await api('/api/attendance/settings', {
    method: 'PUT',
    body: { reportSync: originalReportSync ?? { scheduledTrigger: { enabled: false } } },
  }).catch((error) => console.error(`  settings restore failed: ${error?.message || error}`))

  await q(`DELETE FROM ${REPORT_SYNC_JOB_TABLE} WHERE org_id = ANY($1::text[])`, [ALL_ORG_IDS]).catch((error) => console.error(`  delete job rows failed: ${error?.message || error}`))
  await q('DELETE FROM attendance_records WHERE org_id = ANY($1::text[])', [ALL_ORG_IDS]).catch((error) => console.error(`  delete records failed: ${error?.message || error}`))
  await q('DELETE FROM attendance_rules WHERE org_id = ANY($1::text[])', [ALL_ORG_IDS]).catch((error) => console.error(`  delete rules failed: ${error?.message || error}`))
  await q('DELETE FROM user_orgs WHERE user_id = ANY($1::text[])', [ALL_USER_IDS]).catch((error) => console.error(`  delete user_orgs failed: ${error?.message || error}`))
  await q('DELETE FROM users WHERE id = ANY($1::text[])', [ALL_USER_IDS]).catch((error) => console.error(`  delete users failed: ${error?.message || error}`))
}

// --- main ------------------------------------------------------------------------------------

async function main() {
  console.log(`Report-sync A2 scheduled-trigger API/DB staging smoke @ ${BASE_URL}`)
  console.log(`  deploy=${DEPLOY_SHA} stamp=${STAMP} workDate=${WORK_DATE} orgs=${ALL_ORG_IDS.join(',')}`)
  console.log('  SCOPE NOTE: this helper proves the SCHEDULING/claim/idempotency/throttle layer for real')
  console.log('  against staging Postgres + the real settings API. It does NOT prove real multitable')
  console.log('  base/sheet writes (in-memory adapter, see file header) or the real scheduler interval')
  console.log('  pickup (direct tick call, same convention as the auto-shift A2 smoke). See the runbook\'s')
  console.log('  "Manual close-out steps" — the final REPORT_SYNC_A2_STAGING_SMOKE_PASS stamp is recorded')
  console.log('  only after both this helper and those manual steps pass.')

  const smokeStartedAt = new Date().toISOString()

  assertRequiredRuntimeEnv()
  requireRunnerExport()

  if (!token) await mintToken()
  const got = await api('/api/attendance/settings')
  ok(got.status === 200, `auth/settings reachable (${got.status})`, got.body)
  if (got.status !== 200) throw new Error('settings API not reachable/authenticated')
  originalReportSync = got.body?.data?.reportSync ?? null

  await preflightNoExistingResidue()
  const collateralRiskOrgIds = await assertCrossOrgFanoutRisk()
  cleanupAllowed = true

  pluginDb = createPluginDb(poolBox.pool)
  fake = createFakeReportRecordsMultitable()
  context = { api: { multitable: { provisioning: fake.provisioning, records: fake.records }, database: pluginDb } }

  await seedRule(ORG_IDS.gate)
  await seedUser(USERS.gate, ORG_IDS.gate)
  await seedAttendanceRecord(ORG_IDS.gate, USERS.gate, WORK_DATE)
  await assertDoubleGateClosedBothHalves(ORG_IDS.gate)

  const { totalsTick1 } = await assertMainFlowCreateAndPatch()
  const { totalsAfterDrain } = await assertMaxUsersPerRunThrottle()
  await assertMaxOrgsPerRunThrottle()

  await reportCollateralCrossOrgJobRows(smokeStartedAt)

  await cleanup()
  const residue = await residueCounts()
  const residueOk = residueIsZero(residue)
  ok(residueOk, 'cleanup residue is zero', residue)
  if (!residueOk) throw new Error(`residue not zero: ${JSON.stringify(residue)}`)

  if (failures.length) {
    throw new Error(`report-sync A2 API/DB smoke had ${failures.length} failed assertion(s): ${failures.join('; ')}`)
  }

  const synced = Number(totalsTick1?.synced || 0) + Number(totalsAfterDrain?.synced || 0)
  console.log(`\nAssertions passed: ${pass}`)
  console.log(`REPORT_SYNC_A2_API_DB_SMOKE_PASS deploy=${DEPLOY_SHA} stamp=${STAMP} org=${ORG_IDS.main} orgs=${ALL_ORG_IDS.join('|')} synced=${synced} collateralOtherOrgs=${collateralRiskOrgIds.length} residue=0`)
}

if (IS_MAIN) {
  let pgModule
  try {
    pgModule = await import('pg')
  } catch {
    console.error('FAIL: package "pg" is required. Run this helper from a prepared metasheet2 checkout with dependencies installed.')
    process.exit(2)
  }
  poolBox.pool = new pgModule.default.Pool({ connectionString: DATABASE_URL })
  try {
    await main()
  } catch (error) {
    console.error(`FAIL: ${error?.message || error}`)
    try {
      await cleanup()
      const residue = await residueCounts()
      console.error(`Residue after best-effort cleanup: ${JSON.stringify(residue)}`)
    } catch (cleanupError) {
      console.error(`WARN: cleanup failed: ${cleanupError?.message || cleanupError}`)
    }
    process.exitCode = 1
  } finally {
    await poolBox.pool.end().catch(() => undefined)
  }
}
