#!/usr/bin/env tsx
// C5-5 staging smoke — attendance notification delivery / owner fan-out.
//
// This script has two modes:
//   C5_CHANNEL_MODE=fake     -> C5-5a: proves outbox fan-out, worker state-flow, retry/idempotency.
//   C5_CHANNEL_MODE=dingtalk -> C5-5b: sends real DingTalk work notifications, plus the same fake retry probe.
//
// It is intentionally conservative: the C5 delivery worker claims due rows globally, so the script refuses to run if
// non-smoke due delivery rows exist. That prevents a real DingTalk smoke from sending unrelated staging rows.

import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type {
  AttendanceNotificationDeliveryQuery,
} from '../../packages/core-backend/src/services/AttendanceNotificationDeliveryWorker.ts'

type DeliveryWorkerModule = typeof import('../../packages/core-backend/src/services/AttendanceNotificationDeliveryWorker.ts')
type UnscheduledReminderModule = typeof import('../../packages/core-backend/src/services/UnscheduledReminderService.ts')
type CompTimeExpiryReminderModule = typeof import('../../packages/core-backend/src/services/CompTimeExpiryReminderService.ts')

type ChannelMode = 'fake' | 'dingtalk'
type PgPool = {
  query: <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount: number | null }>
  end: () => Promise<void>
}
type PgModule = {
  Pool: new (options: { connectionString: string }) => PgPool
}

const requireFromCoreBackend = createRequire(new URL('../../packages/core-backend/package.json', import.meta.url))
const pg = requireFromCoreBackend('pg') as PgModule
const loadBackendModule = async <T>(path: string): Promise<T> => {
  const mod = await import(path) as { default?: T } & T
  return (mod.default ?? mod) as T
}

const BASE_URL = (process.env.BASE_URL || process.env.BASE || '').replace(/\/$/, '')
const DATABASE_URL = process.env.DATABASE_URL || ''
const CHANNEL_MODE = normalizeChannelMode(process.env.C5_CHANNEL_MODE || 'fake')
const SUFFIX = Date.now().toString(36)
const STAMP = `c5-delivery-${SUFFIX}`
const ORG_ID = process.env.ORG_ID || `org-${STAMP}`
const ORG_ID_WAS_SUPPLIED = Boolean(process.env.ORG_ID)
const DEPLOY_SHA = process.env.EXPECTED_DEPLOY_SHA || process.env.DEPLOY_SHA || 'unknown'
const RUN_NOW = parseRunDate(process.env.RUN_DATE)
const UNSCHEDULED_LOOKAHEAD_DAYS = Number(process.env.ATTENDANCE_UNSCHEDULED_REMINDER_LOOKAHEAD_DAYS || 1)
const EXPIRY_LOOKAHEAD_DAYS = Number(process.env.ATTENDANCE_COMP_TIME_EXPIRY_REMINDER_LOOKAHEAD_DAYS || 7)
const ALLOW_EXISTING_DUE = process.env.ALLOW_C5_SMOKE_EXISTING_DUE_DELIVERIES === '1'
const ALLOW_CUSTOM_ORG_CLEANUP = process.env.ALLOW_C5_SMOKE_CUSTOM_ORG_CLEANUP === '1'

if (!BASE_URL || !DATABASE_URL) {
  console.error('FAIL: BASE_URL and DATABASE_URL are required.')
  console.error('  e.g. BASE_URL=http://127.0.0.1:8082 DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet C5_CHANNEL_MODE=fake pnpm exec tsx scripts/ops/staging-attendance-c5-delivery-smoke.ts')
  process.exit(2)
}
if (CHANNEL_MODE === 'dingtalk' && process.env.ALLOW_REAL_DINGTALK_SEND !== '1') {
  console.error('FAIL: C5_CHANNEL_MODE=dingtalk sends real DingTalk work notifications. Set ALLOW_REAL_DINGTALK_SEND=1 to continue.')
  process.exit(2)
}

const {
  AttendanceNotificationDeliveryWorker,
  DeterministicFakeAttendanceDeliveryChannel,
  DingTalkAttendanceDeliveryChannel,
} = await loadBackendModule<DeliveryWorkerModule>('../../packages/core-backend/src/services/AttendanceNotificationDeliveryWorker.ts')
const { UnscheduledReminderService } = await loadBackendModule<UnscheduledReminderModule>('../../packages/core-backend/src/services/UnscheduledReminderService.ts')
const { CompTimeExpiryReminderService } = await loadBackendModule<CompTimeExpiryReminderModule>('../../packages/core-backend/src/services/CompTimeExpiryReminderService.ts')

const USERS = {
  subject: `${STAMP}-subject`,
  owner: `${STAMP}-owner`,
  subOwner: `${STAMP}-sub-owner`,
  admin: `${STAMP}-admin`,
}
const ALL_USERS = Object.values(USERS)
const GROUP_ID = randomUUID()
const SHIFT_ID = randomUUID()
const BALANCE_ID = randomUUID()
const FAKE_RETRY_ID = randomUUID()
const FAKE_RETRY_SOURCE_ID = randomUUID()
const INTEGRATION_IDS: string[] = []
const ACCOUNT_IDS: string[] = []
let adminToken = process.env.SMOKE_TOKEN || process.env.TOKEN || ''
let cleanupAllowed = false
let pass = 0
const failures: string[] = []

const pool = new pg.Pool({ connectionString: DATABASE_URL })
const query: AttendanceNotificationDeliveryQuery = async <T = unknown>(sqlText: string, params: unknown[] = []) => {
  const result = await pool.query<T>(sqlText, params)
  return { rows: result.rows, rowCount: result.rowCount }
}
const q = <T = Record<string, unknown>>(text: string, params?: unknown[]) =>
  pool.query<T>(text, params).then(result => result.rows)

function normalizeChannelMode(value: string): ChannelMode {
  const mode = value.trim().toLowerCase()
  if (mode === 'fake' || mode === 'dingtalk') return mode
  console.error(`FAIL: invalid C5_CHANNEL_MODE "${value}" (expected fake or dingtalk).`)
  process.exit(2)
}

function parseRunDate(value: string | undefined): Date {
  if (!value) return new Date()
  const date = new Date(value.includes('T') ? value : `${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) {
    console.error(`FAIL: invalid RUN_DATE "${value}".`)
    process.exit(2)
  }
  return date
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date)
  copy.setUTCDate(copy.getUTCDate() + days)
  return copy
}

function smokeExpiryOffsetDays(): number {
  const n = Number(EXPIRY_LOOKAHEAD_DAYS)
  if (!Number.isFinite(n)) return 7
  return Math.min(7, Math.max(1, Math.floor(n)))
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function ok(condition: boolean, label: string, detail?: unknown): void {
  if (condition) {
    pass += 1
    console.log(`  PASS  ${label}`)
    return
  }
  failures.push(label)
  const extra = detail === undefined ? '' : ` — ${JSON.stringify(detail)}`
  console.error(`  FAIL  ${label}${extra}`)
}

function assertSafeSyntheticScope(): void {
  const syntheticOrg = ORG_ID.startsWith('org-c5-delivery-')
  if (syntheticOrg) return
  if (ORG_ID_WAS_SUPPLIED && ALLOW_CUSTOM_ORG_CLEANUP) {
    console.warn(`WARNING: using custom ORG_ID=${ORG_ID}; cleanup will delete C5 smoke rows for that org. Continue only on a disposable staging org.`)
    return
  }
  throw new Error(
    `refusing ORG_ID=${ORG_ID}: C5 smoke cleanup deletes by org_id. ` +
    'Use the default synthetic org-c5-delivery-* id, or set ALLOW_C5_SMOKE_CUSTOM_ORG_CLEANUP=1 only for a disposable staging org.',
  )
}

async function api(path: string, { method = 'GET', body }: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-org-id': ORG_ID,
  }
  if (adminToken) headers.Authorization = `Bearer ${adminToken}`
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json: unknown = null
  try { json = await res.json() } catch { /* non-json */ }
  return { status: res.status, body: json as any }
}

async function mintAdminToken(): Promise<void> {
  if (adminToken) return
  const perms = encodeURIComponent('attendance:read,attendance:write,attendance:admin')
  const res = await api(`/api/auth/dev-token?userId=${encodeURIComponent(USERS.admin)}&roles=admin&perms=${perms}`)
  adminToken = res.body?.token || ''
  if (!adminToken) {
    throw new Error(`could not mint dev-token (status ${res.status}); set SMOKE_TOKEN for this staging environment`)
  }
  console.log('  minted dev-token for C5 smoke admin')
}

async function requireTable(table: string): Promise<void> {
  const rows = await q<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [table],
  )
  if (!rows[0]?.exists) throw new Error(`required table missing: ${table}`)
}

async function ensureNoDueDeliveriesOutsideSmoke(label: string): Promise<void> {
  const rows = await q<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM attendance_notification_deliveries
      WHERE NOT (org_id = $1 AND source_key LIKE $2)
        AND (
          (status IN ('pending','retrying') AND next_attempt_at <= now())
          OR (status = 'sending' AND claim_expires_at <= now())
        )`,
    [ORG_ID, `%${STAMP}%`],
  )
  const count = Number(rows[0]?.n || 0)
  if (count > 0 && !ALLOW_EXISTING_DUE) {
    throw new Error(`${label}: refusing to run delivery worker while ${count} due non-smoke delivery row(s) exist. Set ALLOW_C5_SMOKE_EXISTING_DUE_DELIVERIES=1 only on a disposable staging DB.`)
  }
  ok(count === 0 || ALLOW_EXISTING_DUE, `${label}: no due non-smoke delivery rows before worker claim`, { count })
}

async function seedUsersAndGroup(): Promise<void> {
  for (const userId of ALL_USERS) {
    await pool.query(
      `INSERT INTO users (id, email, password_hash, name, role, is_active)
       VALUES ($1,$2,'hash',$3,'user',true)
       ON CONFLICT (id) DO UPDATE SET is_active = true`,
      [userId, `${userId}@example.test`, userId],
    )
  }
  await pool.query(
    `INSERT INTO attendance_groups (id, org_id, name, attendance_type)
     VALUES ($1,$2,$3,'scheduled_shift')`,
    [GROUP_ID, ORG_ID, `C5 smoke group ${SUFFIX}`],
  )
  await pool.query(
    `INSERT INTO attendance_group_members (id, org_id, group_id, user_id)
     VALUES ($1,$2,$3,$4)`,
    [randomUUID(), ORG_ID, GROUP_ID, USERS.subject],
  )
  await pool.query(
    `INSERT INTO attendance_group_managers (id, org_id, group_id, user_id, role)
     VALUES ($1,$2,$3,$4,'owner'), ($5,$2,$3,$6,'sub_owner')`,
    [randomUUID(), ORG_ID, GROUP_ID, USERS.owner, randomUUID(), USERS.subOwner],
  )
  // A shift row is not assigned to the subject. Its presence makes the smoke org look like a normal schedule org
  // without covering the target date; the unscheduled service should still claim the subject.
  await pool.query(
    `INSERT INTO attendance_shifts (id, org_id, name, timezone, work_start_time, work_end_time, working_days)
     VALUES ($1,$2,$3,'UTC','09:00','18:00','[1,2,3,4,5,6,7]'::jsonb)`,
    [SHIFT_ID, ORG_ID, `C5 smoke shift ${SUFFIX}`],
  )
}

function externalUserIdFor(localUserId: string): string {
  const suffix = localUserId === USERS.subject ? 'SUBJECT' : localUserId === USERS.owner ? 'OWNER' : 'SUB_OWNER'
  const specific = process.env[`DINGTALK_SMOKE_${suffix}_USER_ID`]
  const shared = process.env.DINGTALK_SMOKE_EXTERNAL_USER_ID
  const value = (specific || shared || '').trim()
  if (!value) {
    throw new Error(`C5_CHANNEL_MODE=dingtalk requires DINGTALK_SMOKE_EXTERNAL_USER_ID or DINGTALK_SMOKE_${suffix}_USER_ID`)
  }
  return value
}

async function readDingTalkIntegrationConfigForSmoke(): Promise<Record<string, unknown>> {
  const integrationId = (process.env.DINGTALK_SMOKE_CONFIG_INTEGRATION_ID || '').trim()
  if (!integrationId) return {}
  const rows = await q<{ config: Record<string, unknown> | string | null }>(
    `SELECT config
       FROM directory_integrations
      WHERE id = $1
        AND provider = 'dingtalk'
      LIMIT 1`,
    [integrationId],
  )
  if (rows.length !== 1) {
    throw new Error(`DINGTALK_SMOKE_CONFIG_INTEGRATION_ID=${integrationId} was not found`)
  }
  const config = rows[0].config
  if (!config) return {}
  if (typeof config === 'string') {
    try {
      const parsed = JSON.parse(config)
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
    } catch {
      throw new Error(`DINGTALK_SMOKE_CONFIG_INTEGRATION_ID=${integrationId} has non-JSON config`)
    }
  }
  return config
}

async function seedDingTalkLinksIfNeeded(): Promise<void> {
  if (CHANNEL_MODE !== 'dingtalk') return
  const integrationConfig = await readDingTalkIntegrationConfigForSmoke()
  for (const localUserId of [USERS.subject, USERS.owner, USERS.subOwner]) {
    const integrationId = randomUUID()
    const accountId = randomUUID()
    const externalUserId = externalUserIdFor(localUserId)
    INTEGRATION_IDS.push(integrationId)
    ACCOUNT_IDS.push(accountId)
    await pool.query(
      `INSERT INTO directory_integrations (id, org_id, provider, name, status, corp_id, config)
       VALUES ($1,$2,'dingtalk',$3,'active',$4,$5::jsonb)`,
      [integrationId, ORG_ID, `C5 smoke DingTalk ${localUserId}`, `corp-${STAMP}`, JSON.stringify(integrationConfig)],
    )
    await pool.query(
      `INSERT INTO directory_accounts
         (id, integration_id, provider, corp_id, external_user_id, external_key, name, is_active)
       VALUES ($1,$2,'dingtalk',$3,$4,$5,$6,true)`,
      [accountId, integrationId, `corp-${STAMP}`, externalUserId, `${STAMP}:${localUserId}:${externalUserId}`, localUserId],
    )
    await pool.query(
      `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
       VALUES ($1,$2,'linked','manual')`,
      [accountId, localUserId],
    )
  }
  ok(true, 'seeded DingTalk directory links for subject + owner + sub_owner')
}

async function seedCompTimeBalance(): Promise<string> {
  const expiresAt = addDays(RUN_NOW, smokeExpiryOffsetDays()).toISOString()
  await pool.query(
    `INSERT INTO attendance_leave_balances
       (id, org_id, user_id, leave_type_code, amount_minutes, remaining_minutes, source_type, source_id, source_key, expires_at, status)
     VALUES ($1,$2,$3,'comp_time',120,120,'manual_grant',$4,$5,$6::timestamptz,'active')`,
    [BALANCE_ID, ORG_ID, USERS.subject, `c5-smoke-balance-${STAMP}`, `c5-smoke-balance:${STAMP}`, expiresAt],
  )
  return expiresAt
}

async function produceUnscheduledDeliveries(): Promise<{ targetDate: string; dispatchId: string }> {
  const svc = new UnscheduledReminderService({ query, now: () => RUN_NOW, lookaheadDays: UNSCHEDULED_LOOKAHEAD_DAYS })
  const targetDate = svc.computeTargetDate()
  const candidates = await svc.scanCandidates(targetDate)
  const outside = candidates.filter(candidate => candidate.orgId !== ORG_ID)
  if (outside.length > 0) {
    throw new Error(`refusing to claim unscheduled reminders: ${outside.length} non-smoke candidate(s) would be claimed by the global source job`)
  }
  ok(candidates.some(candidate => candidate.orgId === ORG_ID && candidate.userId === USERS.subject), 'unscheduled source sees the smoke subject as a candidate', candidates)
  const claimed = await svc.claimDispatches(targetDate) as Array<{ id: string; org_id: string; user_id: string; target_date: string; reminder_type: string }>
  const mine = claimed.filter(row => row.org_id === ORG_ID && row.user_id === USERS.subject)
  ok(mine.length === 1, 'unscheduled source claimed exactly one smoke dispatch', mine)
  if (mine.length !== 1) throw new Error('unscheduled smoke dispatch not claimed')
  const deliveries = await svc.produceDeliveriesForDispatches(mine)
  ok(deliveries === 3, 'unscheduled source produced subject + owner + sub_owner deliveries', { deliveries })
  await svc.produceDeliveriesForDispatches(mine)
  const rows = await sourceRows('unscheduled_reminder', mine[0].id)
  ok(rows.length === 3, 'unscheduled producer is idempotent on repeat', rows.map(row => row.source_key))
  return { targetDate, dispatchId: mine[0].id }
}

async function produceCompTimeExpiryDeliveries(): Promise<{ expiresAt: string }> {
  const expiresAt = await seedCompTimeBalance()
  const svc = new CompTimeExpiryReminderService({ query, now: () => RUN_NOW, lookaheadDays: EXPIRY_LOOKAHEAD_DAYS })
  const candidates = await svc.scanCandidates()
  const outside = candidates.filter(candidate => candidate.orgId !== ORG_ID)
  if (outside.length > 0) {
    throw new Error(`refusing to produce comp-time expiry reminders: ${outside.length} non-smoke candidate(s) would be processed by the global source job`)
  }
  ok(candidates.some(candidate => candidate.orgId === ORG_ID && candidate.balanceId === BALANCE_ID), 'comp-time expiry source sees the smoke lot as in-window', candidates)
  const deliveries = await svc.produceDeliveries()
  ok(deliveries === 3, 'comp-time expiry source produced subject + owner + sub_owner deliveries', { deliveries })
  await svc.produceDeliveries()
  const rows = await sourceRows('comp_time_expiry_reminder', BALANCE_ID)
  ok(rows.length === 3, 'comp-time expiry producer is idempotent on repeat', rows.map(row => row.source_key))
  const balance = (await q<{ remaining_minutes: string; status: string }>(
    `SELECT remaining_minutes, status FROM attendance_leave_balances WHERE id = $1`,
    [BALANCE_ID],
  ))[0]
  ok(Number(balance?.remaining_minutes || 0) === 120 && balance?.status === 'active', 'comp-time expiry reminder did not mutate the balance lot', balance)
  return { expiresAt }
}

async function sourceRows(sourceType: string, sourceId: string) {
  return q<{
    id: string
    source_key: string
    recipient_user_id: string
    recipient_role: string
    status: string
    delivered_at: string | null
    attempt_count: string | number
    last_error: string | null
  }>(
    `SELECT id::text, source_key, recipient_user_id, recipient_role, status, delivered_at::text, attempt_count, last_error
       FROM attendance_notification_deliveries
      WHERE org_id = $1 AND source_type = $2 AND source_id = $3
      ORDER BY source_type, recipient_role, recipient_user_id`,
    [ORG_ID, sourceType, sourceId],
  )
}

async function runDeliveryWorker(label: string, mode: ChannelMode | 'fake-retry') {
  await ensureNoDueDeliveriesOutsideSmoke(label)
  const channel = mode === 'dingtalk'
    ? new DingTalkAttendanceDeliveryChannel({ query })
    : new DeterministicFakeAttendanceDeliveryChannel()
  const worker = new AttendanceNotificationDeliveryWorker({
    query,
    channels: [channel],
    batchSize: 50,
    leaseMs: 30_000,
    maxAttempts: 2,
    workerId: `${STAMP}:${mode}`,
  })
  return worker.runBatch()
}

async function assertPrimaryDeliveriesSent(): Promise<void> {
  const rows = await q<{ source_type: string; recipient_role: string; status: string; delivered_at: string | null; last_error: string | null; attempt_count: number | string }>(
    `SELECT source_type, recipient_role, status, delivered_at::text, last_error, attempt_count
       FROM attendance_notification_deliveries
      WHERE org_id = $1
        AND source_type IN ('unscheduled_reminder','comp_time_expiry_reminder')
      ORDER BY source_type, recipient_role`,
    [ORG_ID],
  )
  ok(rows.length === 6, 'delivery rows exist for both sources × subject/owner/sub_owner', rows)
  ok(rows.every(row => row.status === 'sent' && row.delivered_at && row.last_error === null && Number(row.attempt_count) === 1),
    `${CHANNEL_MODE} worker sent all primary C5 deliveries exactly once`,
    rows)
  const rolesBySource = new Map<string, Set<string>>()
  for (const row of rows) {
    const set = rolesBySource.get(row.source_type) ?? new Set<string>()
    set.add(row.recipient_role)
    rolesBySource.set(row.source_type, set)
  }
  for (const source of ['unscheduled_reminder', 'comp_time_expiry_reminder']) {
    ok(
      ['subject', 'owner', 'sub_owner'].every(role => rolesBySource.get(source)?.has(role)),
      `${source}: subject + owner + sub_owner fan-out was delivered`,
      Array.from(rolesBySource.get(source) ?? []),
    )
  }
}

async function runFakeRetryProbe(): Promise<void> {
  await pool.query(
    `INSERT INTO attendance_notification_deliveries
       (id, org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, channel, payload)
     VALUES ($1,$2,'unscheduled_reminder',$3,$4,$5,'subject','dingtalk_work_notification',$6::jsonb)`,
    [
      FAKE_RETRY_ID,
      ORG_ID,
      FAKE_RETRY_SOURCE_ID,
      `c5-smoke-retry:${STAMP}`,
      USERS.subject,
      JSON.stringify({ title: 'C5 retry probe', body: 'This fake row proves retry state flow.', fakeDelivery: 'retry' }),
    ],
  )
  const first = await runDeliveryWorker('fake retry attempt 1', 'fake-retry')
  ok(first.claimed === 1 && first.retrying === 1, 'fake retry probe enters retrying state on first attempt', first)
  let row = (await q<{ status: string; attempt_count: string; last_error: string }>(
    `SELECT status, attempt_count, last_error FROM attendance_notification_deliveries WHERE id = $1`,
    [FAKE_RETRY_ID],
  ))[0]
  ok(row?.status === 'retrying' && Number(row.attempt_count) === 1 && row.last_error === 'fake_retryable_failure',
    'fake retry row persisted retrying status with visible error',
    row)
  await pool.query(
    `UPDATE attendance_notification_deliveries
        SET next_attempt_at = now() - interval '1 second'
      WHERE id = $1`,
    [FAKE_RETRY_ID],
  )
  const second = await runDeliveryWorker('fake retry attempt 2', 'fake-retry')
  ok(second.claimed === 1 && second.failed === 1, 'fake retry probe fails visibly after max attempts', second)
  row = (await q<{ status: string; attempt_count: string; last_error: string }>(
    `SELECT status, attempt_count, last_error FROM attendance_notification_deliveries WHERE id = $1`,
    [FAKE_RETRY_ID],
  ))[0]
  ok(row?.status === 'failed' && Number(row.attempt_count) === 2 && row.last_error === 'fake_retryable_failure',
    'fake retry row persisted terminal failed status',
    row)
}

async function assertAdminObservability(): Promise<void> {
  await mintAdminToken()
  const res = await api(`/api/attendance/notification-deliveries?orgId=${encodeURIComponent(ORG_ID)}&page=1&pageSize=50`)
  ok(res.status === 200, `C5-4 admin observability API reads delivery rows (status ${res.status})`, res.body)
  const data = res.body?.data ?? {}
  const total = Number(data.total ?? 0)
  const counters = data.counters ?? {}
  ok(total >= 7 && Number(counters.sent ?? 0) >= 6 && Number(counters.failed ?? 0) >= 1,
    'C5-4 counters show sent primary rows and failed retry probe',
    { total, counters })
}

async function cleanup(): Promise<void> {
  if (!cleanupAllowed) {
    console.error('cleanup skipped: safety gates did not pass')
    return
  }
  await pool.query('DELETE FROM attendance_notification_deliveries WHERE org_id = $1', [ORG_ID]).catch(() => undefined)
  await pool.query('DELETE FROM attendance_unscheduled_reminder_dispatch WHERE org_id = $1', [ORG_ID]).catch(() => undefined)
  await pool.query('DELETE FROM attendance_leave_balance_events WHERE user_id = $1', [USERS.subject]).catch(() => undefined)
  await pool.query('DELETE FROM attendance_leave_balances WHERE org_id = $1', [ORG_ID]).catch(() => undefined)
  await pool.query('DELETE FROM attendance_shift_assignments WHERE org_id = $1', [ORG_ID]).catch(() => undefined)
  await pool.query('DELETE FROM attendance_shifts WHERE org_id = $1', [ORG_ID]).catch(() => undefined)
  await pool.query('DELETE FROM attendance_group_managers WHERE org_id = $1', [ORG_ID]).catch(() => undefined)
  await pool.query('DELETE FROM attendance_group_members WHERE org_id = $1', [ORG_ID]).catch(() => undefined)
  await pool.query('DELETE FROM attendance_groups WHERE org_id = $1', [ORG_ID]).catch(() => undefined)
  if (ACCOUNT_IDS.length > 0) {
    await pool.query('DELETE FROM directory_account_links WHERE directory_account_id = ANY($1::uuid[])', [ACCOUNT_IDS]).catch(() => undefined)
    await pool.query('DELETE FROM directory_accounts WHERE id = ANY($1::uuid[])', [ACCOUNT_IDS]).catch(() => undefined)
  }
  if (INTEGRATION_IDS.length > 0) {
    await pool.query('DELETE FROM directory_integrations WHERE id = ANY($1::uuid[])', [INTEGRATION_IDS]).catch(() => undefined)
  }
  await pool.query('DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [ALL_USERS]).catch(() => undefined)
  await pool.query('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [ALL_USERS]).catch(() => undefined)
  await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [ALL_USERS]).catch(() => undefined)
}

async function residueCounts(): Promise<Record<string, number | string>> {
  const rows = await q<Record<string, number | string>>(
    `SELECT
       (SELECT count(*)::int FROM attendance_notification_deliveries WHERE org_id = $1) AS deliveries,
       (SELECT count(*)::int FROM attendance_unscheduled_reminder_dispatch WHERE org_id = $1) AS dispatches,
       (SELECT count(*)::int FROM attendance_leave_balances WHERE org_id = $1) AS balances,
       (SELECT count(*)::int FROM attendance_leave_balance_events WHERE user_id = $2) AS balance_events,
       (SELECT count(*)::int FROM attendance_groups WHERE org_id = $1) AS groups,
       (SELECT count(*)::int FROM attendance_group_members WHERE org_id = $1) AS members,
       (SELECT count(*)::int FROM attendance_group_managers WHERE org_id = $1) AS managers,
       (SELECT count(*)::int FROM attendance_shifts WHERE org_id = $1) AS shifts,
       (SELECT count(*)::int FROM directory_account_links WHERE directory_account_id = ANY($3::uuid[])) AS account_links,
       (SELECT count(*)::int FROM directory_accounts WHERE id = ANY($3::uuid[])) AS accounts,
       (SELECT count(*)::int FROM directory_integrations WHERE id = ANY($4::uuid[])) AS integrations,
       (SELECT count(*)::int FROM user_roles WHERE user_id = ANY($5::text[])) AS user_roles,
       (SELECT count(*)::int FROM user_permissions WHERE user_id = ANY($5::text[])) AS user_permissions,
       (SELECT count(*)::int FROM users WHERE id = ANY($5::text[])) AS users`,
    [ORG_ID, USERS.subject, ACCOUNT_IDS, INTEGRATION_IDS, ALL_USERS],
  )
  return rows[0] ?? {}
}

async function main(): Promise<void> {
  console.log(`C5 delivery staging smoke @ ${BASE_URL}`)
  console.log(`  mode=${CHANNEL_MODE} org=${ORG_ID} stamp=${STAMP} deploy=${DEPLOY_SHA}`)
  if (CHANNEL_MODE === 'dingtalk') {
    console.log('  real DingTalk work notifications are enabled for this run')
  }
  await Promise.all([
    requireTable('users'),
    requireTable('attendance_groups'),
    requireTable('attendance_group_members'),
    requireTable('attendance_group_managers'),
    requireTable('attendance_unscheduled_reminder_dispatch'),
    requireTable('attendance_leave_balances'),
    requireTable('attendance_notification_deliveries'),
  ])
  if (CHANNEL_MODE === 'dingtalk') {
    await Promise.all([
      requireTable('directory_integrations'),
      requireTable('directory_accounts'),
      requireTable('directory_account_links'),
    ])
  }
  assertSafeSyntheticScope()
  cleanupAllowed = true
  await cleanup()
  await ensureNoDueDeliveriesOutsideSmoke('pre-seed')

  await seedUsersAndGroup()
  await seedDingTalkLinksIfNeeded()
  const { targetDate, dispatchId } = await produceUnscheduledDeliveries()
  const { expiresAt } = await produceCompTimeExpiryDeliveries()
  console.log(`  produced sources: unscheduled target=${targetDate} dispatch=${dispatchId}; comp_time expiresAt=${expiresAt}`)

  const primary = await runDeliveryWorker(`primary ${CHANNEL_MODE} delivery`, CHANNEL_MODE)
  ok(primary.claimed === 6 && primary.sent === 6 && primary.retrying === 0 && primary.failed === 0,
    `${CHANNEL_MODE} worker claimed and sent the 6 primary C5 deliveries`,
    primary)
  await assertPrimaryDeliveriesSent()
  const repeatPrimary = await runDeliveryWorker('primary repeat/idempotency check', CHANNEL_MODE)
  ok(repeatPrimary.claimed === 0, 'repeat worker run does not resend already-sent primary deliveries', repeatPrimary)

  await runFakeRetryProbe()
  await assertAdminObservability()
}

try {
  await main()
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
  console.error(`\nC5 delivery smoke failed: ${error instanceof Error ? error.stack || error.message : String(error)}`)
} finally {
  try {
    if (cleanupAllowed) {
      await cleanup()
      const residue = await residueCounts()
      const residueTotal = Object.values(residue).map(value => Number(value || 0)).reduce((sum, value) => sum + value, 0)
      ok(residueTotal === 0, `cleanup residue = 0 (${Object.entries(residue).map(([key, value]) => `${key} ${value}`).join(', ')})`, residue)
    } else {
      await cleanup()
    }
  } catch (error) {
    failures.push(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
    console.error(`cleanup failed: ${error instanceof Error ? error.stack || error.message : String(error)}`)
  } finally {
    await pool.end().catch(() => undefined)
  }

  const failed = failures.length
  console.log(`\n=== ${failed === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${failed} failed${failed ? ` (${failures.join('; ')})` : ''} ===  stamp ${STAMP}`)
  if (failed === 0) {
    const marker = CHANNEL_MODE === 'dingtalk'
      ? 'C5_REAL_DINGTALK_STAGING_SMOKE_PASS'
      : 'C5_FAKE_CHANNEL_STAGING_SMOKE_PASS'
    console.log(`${marker} deploy=${DEPLOY_SHA} stamp=${STAMP} channel=${CHANNEL_MODE} residue=0`)
  }
  process.exit(failed === 0 ? 0 : 1)
}
