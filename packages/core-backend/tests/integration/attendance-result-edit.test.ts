import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest'
import { createRequire } from 'module'
import {
  snapshotAttendanceSettingsRow,
  restoreAttendanceSettingsRow,
  type AttendanceSettingsRowSnapshot,
} from '../utils/attendance-settings-row'

// Shared-DB isolation for the deployment-wide `system_configs` 'attendance.settings' row (see
// tests/utils/attendance-settings-row.ts for the full rationale): this suite writes that row via
// PUT /api/attendance/settings against a Postgres shared with every other suite in
// plugin-tests.yml's attendance step, so it must leave the row EXACTLY as found. The cache reset
// grabs the SAME plugin module instance the in-process server loaded (CJS require cache) and drops
// its 60s module-level settings cache so the row restore is what the next test actually reads.
const settingsRowRequireCjs = createRequire(import.meta.url)
function resetAttendanceSettingsCacheAfterRestore(): void {
  const plugin = settingsRowRequireCjs('../../../../plugins/plugin-attendance/index.cjs') as {
    resetAttendanceSettingsCacheForTests?: () => void
  }
  plugin.resetAttendanceSettingsCacheForTests?.()
}
let settingsRowSnapshot: AttendanceSettingsRowSnapshot | undefined

import type { MetaSheetServer } from '../../src/index'
import * as path from 'path'
import net from 'net'
import http from 'http'
import { randomUUID } from 'crypto'
import { Pool } from 'pg'
import {
  AttendanceNotificationDeliveryWorker,
  DeterministicFakeAttendanceDeliveryChannel,
  type AttendanceNotificationDeliveryQuery,
} from '../../src/services/AttendanceNotificationDeliveryWorker'

// AE-1 — audited admin correction of a confirmed attendance anomaly result (design-lock
// attendance-anomaly-result-edit-guard-design-lock-20260626, RATIFIED 2026-06-27). Route-level real-DB tests
// driving POST /api/attendance/anomaly-result-edits against a migrated postgres: the §8 invariant matrix
// (idempotency / editable-source / closed-cycle / edit-window / cross-org) plus the §3.5a metric-normalization
// outcomes, asserted through attendance_records + the immutable attendance_record_result_edits audit table.

type HttpResponse = { status: number; body?: unknown; raw: string }

function requestJson(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = http.request(
      {
        method: options.method || 'GET',
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: options.headers,
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          let body: unknown
          try { body = data ? JSON.parse(data) : undefined } catch { body = undefined }
          resolve({ status: res.statusCode || 0, body, raw: data })
        })
      },
    )
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

const RUN = Date.now().toString(36)
const ORG = `ae1-${RUN}`          // dedicated org → isolates seeded payroll cycles + records
const ORG_OTHER = `ae1-other-${RUN}`
const ADMIN_USER_ID = `ae1-admin-${RUN}`

function ymd(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10)
}

// A deterministic recent WEEKDAY (Mon–Fri). The default attendance schedule treats Sat/Sun as rest
// days, so a record seeded on a weekend has is_workday=true while a no-override recompute derives
// is_workday=false — which AE-1b (correctly) flags as a material-fact change. The durability
// conflict-detection tests pin to a weekday so the seed's is_workday matches the schedule recompute
// and only the punch facts under test drive reviewConflict; otherwise ymd(N) landing on a weekend
// (e.g. ymd(3) on a Tuesday) makes the suite date-fragile.
function workdayYmd(daysAgo: number): string {
  let d = new Date(Date.now() - daysAgo * 86400000)
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d = new Date(d.getTime() - 86400000)
  }
  return d.toISOString().slice(0, 10)
}

type ErrBody = { ok?: boolean; error?: { code?: string; message?: string }; data?: unknown }
const codeOf = (r: HttpResponse) => (r.body as ErrBody | undefined)?.error?.code
const dataOf = (r: HttpResponse) => (r.body as { data?: any } | undefined)?.data

describeDb('AE-1 attendance anomaly result edit (real DB, route-level)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  let pool: Pool
  let adminToken = ''
  let previousDefaultNotificationChannel: string | undefined

  const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })

  async function mintToken(userId: string, perms: string): Promise<string> {
    const res = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent(perms)}`)
    return (res.body as { token?: string } | undefined)?.token ?? ''
  }

  const postEdit = (body: Record<string, unknown>, token = adminToken) =>
    requestJson(`${baseUrl}/api/attendance/anomaly-result-edits`, { method: 'POST', headers: authHeaders(token), body: JSON.stringify(body) })
  const postImport = (body: Record<string, unknown>, token = adminToken) =>
    requestJson(`${baseUrl}/api/attendance/import`, { method: 'POST', headers: authHeaders(token), body: JSON.stringify(body) })
  const postRequest = (body: Record<string, unknown>, token = adminToken) =>
    requestJson(`${baseUrl}/api/attendance/requests`, { method: 'POST', headers: authHeaders(token), body: JSON.stringify(body) })
  const approveRequest = (requestId: string, token = adminToken) =>
    requestJson(`${baseUrl}/api/attendance/requests/${requestId}/approve`, { method: 'POST', headers: authHeaders(token), body: JSON.stringify({ comment: 'ok' }) })
  const getSettings = () =>
    requestJson(`${baseUrl}/api/attendance/settings`, { headers: authHeaders(adminToken) })
  const putSettings = (body: Record<string, unknown>) =>
    requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers: authHeaders(adminToken), body: JSON.stringify(body) })

  type ResultEditPolicySetting = {
    enabled?: boolean
    editWindowDays?: unknown
    requireReason?: boolean
    notifyAffectedEmployee?: boolean
  }

  function isResultEditPolicySetting(policy: unknown): policy is ResultEditPolicySetting {
    return policy !== null && typeof policy === 'object'
  }

  function resultEditPolicyWithEnabled(policy: unknown, enabled: boolean) {
    const base = isResultEditPolicySetting(policy) ? policy : {}
    return {
      enabled,
      editWindowDays: Number.isInteger(Number(base.editWindowDays)) ? Number(base.editWindowDays) : 180,
      requireReason: typeof base.requireReason === 'boolean' ? base.requireReason : true,
      notifyAffectedEmployee: typeof base.notifyAffectedEmployee === 'boolean' ? base.notifyAffectedEmployee : true,
    }
  }

  function resultEditPolicyWithNotifyAffectedEmployee(policy: unknown, notifyAffectedEmployee: boolean) {
    const base = resultEditPolicyWithEnabled(policy, true)
    return { ...base, notifyAffectedEmployee }
  }

  async function seedRecord(input: {
    userId: string
    workDate: string
    status: string
    workMinutes?: number
    lateMinutes?: number
    earlyLeaveMinutes?: number
    firstInAt?: string | null
    lastOutAt?: string | null
    isWorkday?: boolean
    meta?: Record<string, unknown>
    org?: string
  }): Promise<string> {
    const id = randomUUID()
    await pool.query(
      `INSERT INTO attendance_records
       (id, user_id, org_id, work_date, timezone, first_in_at, last_out_at, work_minutes, late_minutes, early_leave_minutes, status, is_workday, meta, source_batch_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'Asia/Shanghai', $5, $6, $7, $8, $9, $10, $11, $12::jsonb, NULL, now(), now())`,
      [
        id,
        input.userId,
        input.org ?? ORG,
        input.workDate,
        input.firstInAt ?? null,
        input.lastOutAt ?? null,
        input.workMinutes ?? 0,
        input.lateMinutes ?? 0,
        input.earlyLeaveMinutes ?? 0,
        input.status,
        input.isWorkday ?? true,
        JSON.stringify(input.meta ?? {}),
      ],
    )
    return id
  }

  async function recordById(id: string) {
    return (await pool.query(`SELECT * FROM attendance_records WHERE id = $1`, [id])).rows[0] ?? null
  }
  async function auditRowsForRecord(recordId: string) {
    return (await pool.query(`SELECT * FROM attendance_record_result_edits WHERE record_id = $1 ORDER BY created_at ASC`, [recordId])).rows as any[]
  }
  async function auditByKey(orgId: string, key: string) {
    return (await pool.query(`SELECT * FROM attendance_record_result_edits WHERE org_id = $1 AND idempotency_key = $2`, [orgId, key])).rows as any[]
  }
  async function deliveryRowsForRecord(recordId: string, orgId = ORG) {
    return (await pool.query(
      `SELECT * FROM attendance_notification_deliveries
        WHERE org_id = $1
          AND source_type = 'attendance_result_edit'
          AND source_key LIKE $2
        ORDER BY created_at ASC`,
      [orgId, `attendance_result_edit:${orgId}:${recordId}:%`],
    )).rows as any[]
  }
  async function seedClosedCycle(workDate: string, status: 'closed' | 'archived', org = ORG): Promise<string> {
    const start = new Date(new Date(`${workDate}T00:00:00Z`).getTime() - 5 * 86400000).toISOString().slice(0, 10)
    const end = new Date(new Date(`${workDate}T00:00:00Z`).getTime() + 5 * 86400000).toISOString().slice(0, 10)
    return (await pool.query(
      `INSERT INTO attendance_payroll_cycles (org_id, start_date, end_date, status) VALUES ($1, $2, $3, $4) RETURNING id`,
      [org, start, end, status],
    )).rows[0].id as string
  }
  async function withDefaultRule(input: {
    timezone: string
    workStartTime?: string
    workEndTime?: string
    lateGraceMinutes?: number
    earlyGraceMinutes?: number
    severeLateThresholdMinutes?: number
    absenceLateThresholdMinutes?: number
    roundingMinutes?: number
    workingDays?: number[]
  }, run: () => Promise<void>): Promise<void> {
    const ruleId = randomUUID()
    const previousDefaultIds = (await pool.query(
      `SELECT id FROM attendance_rules WHERE org_id = $1 AND is_default = true`,
      [ORG],
    )).rows.map((row) => String(row.id))
    try {
      await pool.query(`UPDATE attendance_rules SET is_default = false, updated_at = now() WHERE org_id = $1 AND is_default = true`, [ORG])
      await pool.query(
        `INSERT INTO attendance_rules
         (id, org_id, name, timezone, work_start_time, work_end_time, late_grace_minutes, early_grace_minutes,
          severe_late_threshold_minutes, absence_late_threshold_minutes, rounding_minutes, working_days, is_default)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, true)`,
        [
          ruleId,
          ORG,
          `ae1-rule-${ruleId}`,
          input.timezone,
          input.workStartTime ?? '09:00',
          input.workEndTime ?? '18:00',
          input.lateGraceMinutes ?? 5,
          input.earlyGraceMinutes ?? 5,
          input.severeLateThresholdMinutes ?? 30,
          input.absenceLateThresholdMinutes ?? 60,
          input.roundingMinutes ?? 5,
          JSON.stringify(input.workingDays ?? [0, 1, 2, 3, 4, 5, 6]),
        ],
      )
      await run()
    } finally {
      await pool.query(`DELETE FROM attendance_rules WHERE id = $1`, [ruleId]).catch(() => undefined)
      if (previousDefaultIds.length > 0) {
        await pool.query(`UPDATE attendance_rules SET is_default = true, updated_at = now() WHERE id = ANY($1::uuid[])`, [previousDefaultIds]).catch(() => undefined)
      }
    }
  }

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen || !dbUrl) throw new Error('AE-1 integration needs a loopback port + DATABASE_URL')

    process.env.DATABASE_URL = dbUrl
    process.env.RBAC_BYPASS = 'true'
    process.env.SKIP_PLUGINS = 'false'
    previousDefaultNotificationChannel = process.env.ATTENDANCE_NOTIFICATION_DEFAULT_CHANNEL
    delete process.env.ATTENDANCE_NOTIFICATION_DEFAULT_CHANNEL
    const repoRoot = path.join(__dirname, '../../../../')
    const { MetaSheetServer } = await import('../../src/index')
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')] })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('server did not expose a TCP address')
    baseUrl = `http://127.0.0.1:${address.port}`
    pool = new Pool({ connectionString: dbUrl })
    settingsRowSnapshot = await snapshotAttendanceSettingsRow(pool)
    await pool.query(
      `INSERT INTO users (
         id, email, username, name, password_hash, role, permissions,
         is_active, is_admin, created_at, updated_at
       ) VALUES ($1, $2, $1, 'AE-1 Admin', 'x', 'admin', '[]'::jsonb, true, true, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [ADMIN_USER_ID, `${ADMIN_USER_ID}@example.test`],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active)
       VALUES ($1, $2, true)
       ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = true`,
      [ADMIN_USER_ID, ORG],
    )
    adminToken = await mintToken(ADMIN_USER_ID, 'attendance:read,attendance:write,attendance:admin,attendance:approve')

    // This is a LIVE feature, not a dormant table: when a DB is present the AE-1 migration MUST have run.
    // A missing table here means the migration regressed — fail LOUD (RED), never a silent skip / false green.
    const cols = (await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'attendance_record_result_edits'`,
    )).rows as { column_name: string }[]
    if (cols.length === 0) {
      throw new Error('attendance_record_result_edits is missing — the AE-1 migration was not applied (regression)')
    }
    const names = new Set(cols.map((c) => c.column_name))
    for (const c of ['org_id', 'record_id', 'before_status', 'after_status', 'before_snapshot', 'after_snapshot', 'reason', 'evidence', 'idempotency_key', 'notification_delivery_id', 'notification_skipped_reason']) {
      expect(names.has(c)).toBe(true)
    }
    const deliveryCols = (await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'attendance_notification_deliveries'`,
    )).rows as { column_name: string }[]
    if (deliveryCols.length === 0) {
      throw new Error('attendance_notification_deliveries is missing — the AE-2 delivery outbox migration was not applied (regression)')
    }
  })

  afterEach(async () => {
    // Exact-restore the 'attendance.settings' row after EVERY test (including failed ones — an
    // in-test restore in a `finally` cannot help when the test dies before reaching it), then
    // drop the plugin's settings cache so the next test re-reads the restored row.
    if (pool) {
      await restoreAttendanceSettingsRow(pool, settingsRowSnapshot)
    }
    resetAttendanceSettingsCacheAfterRestore()
  })

  afterAll(async () => {
    if (pool) {
      await pool.query(`DELETE FROM attendance_notification_deliveries WHERE org_id = ANY($1)`, [[ORG, ORG_OTHER]]).catch(() => undefined)
      await pool.query(`DELETE FROM attendance_record_result_edits WHERE org_id = ANY($1)`, [[ORG, ORG_OTHER]]).catch(() => undefined)
      await pool.query(`DELETE FROM attendance_records WHERE org_id = ANY($1)`, [[ORG, ORG_OTHER]]).catch(() => undefined)
      await pool.query(`DELETE FROM attendance_payroll_cycles WHERE org_id = ANY($1)`, [[ORG, ORG_OTHER]]).catch(() => undefined)
    }
    if (server && (server as unknown as { stop?: () => Promise<void> }).stop) await (server as unknown as { stop: () => Promise<void> }).stop()
    await pool?.end().catch(() => undefined)
    if (previousDefaultNotificationChannel === undefined) delete process.env.ATTENDANCE_NOTIFICATION_DEFAULT_CHANNEL
    else process.env.ATTENDANCE_NOTIFICATION_DEFAULT_CHANNEL = previousDefaultNotificationChannel
  })

  it('§3.5a late→normal: zeroes late/early, preserves work_minutes, recomputes meta tiers; writes audit before/after', async () => {
    const userId = `u-late-${RUN}`
    const workDate = ymd(2)
    const recordId = await seedRecord({
      userId, workDate, status: 'late', workMinutes: 480, lateMinutes: 35, earlyLeaveMinutes: 0,
      firstInAt: `${workDate}T01:35:00Z`, lastOutAt: `${workDate}T10:00:00Z`,
      meta: { severe_late_count: 1, severe_late_minutes: 35, warnings: ['late'] },
    })
    const key = `k-late-${RUN}`
    const res = await postEdit({ orgId: ORG, recordId, targetStatus: 'normal', reason: '员工提交线下签到凭证，核验后更正', idempotencyKey: key })
    expect(res.status).toBe(200)
    expect(dataOf(res).alreadyApplied).toBe(false)
    expect(dataOf(res).edit.afterStatus).toBe('normal')
    expect(dataOf(res).edit.beforeStatus).toBe('late')

    const rec = await recordById(recordId)
    expect(rec.status).toBe('normal')
    expect(Number(rec.late_minutes)).toBe(0)
    expect(Number(rec.early_leave_minutes)).toBe(0)
    expect(Number(rec.work_minutes)).toBe(480) // preserved (an edit re-classifies, it doesn't fabricate work time)
    expect(Number(rec.meta?.severe_late_count ?? -1)).toBe(0) // tier meta recomputed from final late=0
    expect(rec.meta?.warnings).toEqual(['late']) // unrelated meta preserved
    expect(rec.meta?.manual_result_edit).toMatchObject({
      version: 1,
      idempotencyKey: key,
      targetStatus: 'normal',
      correctedMetrics: {
        workMinutes: 480,
        lateMinutes: 0,
        earlyLeaveMinutes: 0,
      },
      correctedAgainst: {
        workDate,
        firstInAt: `${workDate}T01:35:00.000Z`,
        lastOutAt: `${workDate}T10:00:00.000Z`,
        isWorkday: true,
      },
      actorUserId: `ae1-admin-${RUN}`,
      reviewConflict: null,
    })
    expect(rec.meta?.manual_result_edit.auditId).toEqual(expect.any(String))
    expect(rec.meta?.manual_result_edit.editedAt).toEqual(expect.any(String))

    const audit = await auditRowsForRecord(recordId)
    expect(audit).toHaveLength(1)
    expect(audit[0].before_status).toBe('late')
    expect(audit[0].after_status).toBe('normal')
    expect(audit[0].before_snapshot.status).toBe('late')
    expect(audit[0].after_snapshot.status).toBe('normal')
    expect(Number(audit[0].before_snapshot.lateMinutes)).toBe(35)
    expect(Number(audit[0].after_snapshot.lateMinutes)).toBe(0)
    expect(audit[0].reason).toContain('核验后更正')
    expect(audit[0].actor_user_id).toBe(`ae1-admin-${RUN}`)
    expect(audit[0].notification_delivery_id).toEqual(expect.any(String))
    expect(audit[0].notification_skipped_reason).toBeNull()

    const deliveries = await deliveryRowsForRecord(recordId)
    expect(deliveries).toHaveLength(1)
    expect(audit[0].notification_delivery_id).toBe(deliveries[0].id)
    expect(dataOf(res).edit.notificationDeliveryId).toBe(deliveries[0].id)
    expect(dataOf(res).edit.notificationSkippedReason).toBeNull()
    expect(deliveries[0]).toMatchObject({
      source_type: 'attendance_result_edit',
      source_id: audit[0].id,
      recipient_user_id: userId,
      recipient_role: 'subject',
      channel: 'dingtalk_work_notification',
      status: 'pending',
    })
    expect(deliveries[0].source_key).toBe(`attendance_result_edit:${ORG}:${recordId}:${audit[0].id}:employee:${userId}:channel:dingtalk_work_notification`)
    expect(deliveries[0].payload).toMatchObject({
      kind: 'attendance_result_edit',
      sourceType: 'attendance_result_edit',
      recipientUserId: userId,
      recipientRole: 'subject',
      channel: 'dingtalk_work_notification',
      workDate,
      beforeStatus: 'late',
      afterStatus: 'normal',
      reasonSummary: '员工提交线下签到凭证，核验后更正',
    })
    expect(deliveries[0].payload.overrideMetrics).toBeUndefined()
    expect(deliveries[0].payload.evidence).toBeUndefined()
    expect(deliveries.filter(row => row.recipient_user_id !== userId)).toHaveLength(0)
  })

  it('AE-2.1 notifyAffectedEmployee=false: correction succeeds but records a skipped notification and writes no outbox row', async () => {
    const settings = await getSettings()
    expect(settings.status).toBe(200)
    const originalPolicy = dataOf(settings)?.attendanceResultEditPolicy
    const disabledNotify = await putSettings({
      attendanceResultEditPolicy: resultEditPolicyWithNotifyAffectedEmployee(originalPolicy, false),
    })
    expect(disabledNotify.status).toBe(200)

    try {
      const userId = `u-ae2-off-${RUN}`
      const workDate = ymd(2)
      const recordId = await seedRecord({
        userId, workDate, status: 'late', workMinutes: 480, lateMinutes: 25, earlyLeaveMinutes: 0,
        firstInAt: `${workDate}T01:25:00Z`, lastOutAt: `${workDate}T10:00:00Z`,
      })
      const res = await postEdit({ orgId: ORG, recordId, targetStatus: 'normal', reason: '通知关闭但仍允许更正', idempotencyKey: `k-ae2-off-${RUN}` })
      expect(res.status).toBe(200)
      expect(dataOf(res).alreadyApplied).toBe(false)
      expect(dataOf(res).edit.notificationDeliveryId).toBeNull()
      expect(dataOf(res).edit.notificationSkippedReason).toBe('policy_disabled')

      const rec = await recordById(recordId)
      expect(rec.status).toBe('normal')
      expect(Number(rec.late_minutes)).toBe(0)
      expect(rec.meta?.manual_result_edit?.auditId).toEqual(expect.any(String))

      const audit = await auditRowsForRecord(recordId)
      expect(audit).toHaveLength(1)
      expect(audit[0].notification_delivery_id).toBeNull()
      expect(audit[0].notification_skipped_reason).toBe('policy_disabled')
      expect(await deliveryRowsForRecord(recordId)).toHaveLength(0)
    } finally {
      await putSettings({
        attendanceResultEditPolicy: resultEditPolicyWithEnabled(
          originalPolicy,
          isResultEditPolicySetting(originalPolicy) ? originalPolicy.enabled !== false : true,
        ),
      }).catch(() => undefined)
    }
  })

  it('AE-1b durability: same-facts import recompute preserves the corrected result without a review flag', async () => {
    const userId = `u-durable-same-${RUN}`
    const workDate = workdayYmd(3)
    const recordId = await seedRecord({
      userId, workDate, status: 'late', workMinutes: 480, lateMinutes: 35, earlyLeaveMinutes: 0,
      firstInAt: `${workDate}T01:35:00Z`, lastOutAt: `${workDate}T10:00:00Z`,
    })
    const edit = await postEdit({ orgId: ORG, recordId, targetStatus: 'normal', reason: '核验后更正', idempotencyKey: `k-durable-same-${RUN}` })
    expect(edit.status).toBe(200)

    const importRes = await postImport({
      orgId: ORG,
      userId,
      rows: [
        {
          workDate,
          fields: {
            firstInAt: `${workDate}T01:35:00Z`,
            lastOutAt: `${workDate}T10:00:00Z`,
          },
        },
      ],
      mode: 'override',
    })
    expect(importRes.status).toBe(200)

    const rec = await recordById(recordId)
    expect(rec.status).toBe('normal')
    expect(Number(rec.work_minutes)).toBe(480)
    expect(Number(rec.late_minutes)).toBe(0)
    expect(Number(rec.early_leave_minutes)).toBe(0)
    expect(rec.meta?.manual_result_edit?.reviewConflict).toBeNull()
    expect(await auditRowsForRecord(recordId)).toHaveLength(1)
  })

  it('AE-2 notification: channel-unavailable path still enqueues pending and never sends synchronously', async () => {
    const previousChannel = process.env.ATTENDANCE_NOTIFICATION_DEFAULT_CHANNEL
    process.env.ATTENDANCE_NOTIFICATION_DEFAULT_CHANNEL = 'email_smtp'
    try {
      const userId = `u-ae2-email-${RUN}`
      const workDate = workdayYmd(3)
      const recordId = await seedRecord({
        userId, workDate, status: 'late', workMinutes: 480, lateMinutes: 20, earlyLeaveMinutes: 0,
        firstInAt: `${workDate}T01:20:00Z`, lastOutAt: `${workDate}T10:00:00Z`,
      })
      const res = await postEdit({ orgId: ORG, recordId, targetStatus: 'normal', reason: 'email channel configured but worker not running', idempotencyKey: `k-ae2-email-${RUN}` })
      expect(res.status).toBe(200)

      const deliveries = await deliveryRowsForRecord(recordId)
      expect(deliveries).toHaveLength(1)
      expect(deliveries[0]).toMatchObject({
        recipient_user_id: userId,
        recipient_role: 'subject',
        channel: 'email_smtp',
        status: 'pending',
        attempt_count: 0,
        delivered_at: null,
        last_error: null,
      })
      expect(deliveries[0].source_key).toContain(':channel:email_smtp')
    } finally {
      if (previousChannel === undefined) delete process.env.ATTENDANCE_NOTIFICATION_DEFAULT_CHANNEL
      else process.env.ATTENDANCE_NOTIFICATION_DEFAULT_CHANNEL = previousChannel
    }
  })

  it('AE-1b durability: a no-status import recompute preserves the corrected result and flags changed facts', async () => {
    const userId = `u-durable-${RUN}`
    const workDate = workdayYmd(3)
    const recordId = await seedRecord({
      userId, workDate, status: 'late', workMinutes: 480, lateMinutes: 35, earlyLeaveMinutes: 0,
      firstInAt: `${workDate}T01:35:00Z`, lastOutAt: `${workDate}T10:00:00Z`,
    })
    const edit = await postEdit({ orgId: ORG, recordId, targetStatus: 'normal', reason: '核验后更正', idempotencyKey: `k-durable-${RUN}` })
    expect(edit.status).toBe(200)

    const importRes = await postImport({
      orgId: ORG,
      userId,
      rows: [
        {
          workDate,
          fields: {
            firstInAt: `${workDate}T01:55:00Z`,
            lastOutAt: `${workDate}T10:00:00Z`,
          },
        },
      ],
      mode: 'override',
    })
    expect(importRes.status).toBe(200)

    const rec = await recordById(recordId)
    expect(rec.first_in_at?.toISOString()).toBe(`${workDate}T01:55:00.000Z`)
    expect(rec.status).toBe('normal')
    expect(Number(rec.work_minutes)).toBe(480)
    expect(Number(rec.late_minutes)).toBe(0)
    expect(Number(rec.early_leave_minutes)).toBe(0)
    expect(Number(rec.meta?.severe_late_count ?? -1)).toBe(0)
    expect(Number(rec.meta?.severe_late_minutes ?? -1)).toBe(0)
    expect(Number(rec.meta?.absence_late_count ?? -1)).toBe(0)
    expect(rec.meta?.manual_result_edit?.reviewConflict).toMatchObject({
      state: 'needs_review',
      source: 'derived_recompute',
      attemptedDerivedStatus: expect.any(String),
      latestFacts: {
        workDate,
        firstInAt: `${workDate}T01:55:00.000Z`,
        lastOutAt: `${workDate}T10:00:00.000Z`,
        isWorkday: true,
      },
    })
    expect(await auditRowsForRecord(recordId)).toHaveLength(1)
  })

  it('AE-1b durability: explicit import statusOverride intentionally supersedes a stale manual marker', async () => {
    const userId = `u-durable-explicit-${RUN}`
    const workDate = ymd(3)
    const recordId = await seedRecord({
      userId, workDate, status: 'late', workMinutes: 480, lateMinutes: 35, earlyLeaveMinutes: 0,
      firstInAt: `${workDate}T01:35:00Z`, lastOutAt: `${workDate}T10:00:00Z`,
    })
    const edit = await postEdit({ orgId: ORG, recordId, targetStatus: 'normal', reason: '核验后更正', idempotencyKey: `k-durable-explicit-${RUN}` })
    expect(edit.status).toBe(200)

    const importRes = await postImport({
      orgId: ORG,
      userId,
      rows: [
        {
          workDate,
          fields: {
            firstInAt: `${workDate}T01:55:00Z`,
            lastOutAt: `${workDate}T10:00:00Z`,
            status: 'adjusted',
          },
        },
      ],
      mode: 'override',
    })
    expect(importRes.status).toBe(200)

    const rec = await recordById(recordId)
    expect(rec.status).toBe('adjusted')
    expect(rec.meta?.manual_result_edit).toBeUndefined()
    expect(await auditRowsForRecord(recordId)).toHaveLength(1)
  })

  it('AE-1b durability: approved request explicit override is intentional and clears a stale manual marker', async () => {
    const userId = `ae1-admin-${RUN}`
    const workDate = ymd(6)
    const recordId = await seedRecord({
      userId, workDate, status: 'late', workMinutes: 480, lateMinutes: 40, earlyLeaveMinutes: 0,
      firstInAt: `${workDate}T01:40:00Z`, lastOutAt: `${workDate}T10:00:00Z`,
    })
    const edit = await postEdit({ orgId: ORG, recordId, targetStatus: 'normal', reason: '核验后更正', idempotencyKey: `k-durable-approve-${RUN}` })
    expect(edit.status).toBe(200)

    const reqRes = await postRequest({
      orgId: ORG,
      workDate,
      requestType: 'time_correction',
      requestedInAt: `${workDate}T01:25:00Z`,
      requestedOutAt: `${workDate}T10:00:00Z`,
      reason: '补卡审批',
    })
    expect(reqRes.status).toBe(201)
    const requestId = dataOf(reqRes)?.request?.id
    expect(requestId).toEqual(expect.any(String))

    const approve = await approveRequest(requestId)
    expect(approve.status).toBe(200)

    const rec = await recordById(recordId)
    expect(rec.status).toBe('adjusted')
    expect(rec.first_in_at?.toISOString()).toBe(`${workDate}T01:25:00.000Z`)
    expect(rec.meta?.manual_result_edit).toBeUndefined()
    expect(await auditRowsForRecord(recordId)).toHaveLength(1)
  })

  it('W2 overtime final approval rejects a missing frozen anchor before every state/accounting write', async () => {
    const requestId = randomUUID()
    const approvalId = randomUUID()
    const workDate = workdayYmd(5)
    const overtimeUserId = `w2-ot-${RUN}`
    await pool.query(
      `INSERT INTO users (
         id, email, username, name, password_hash, role, permissions,
         is_active, is_admin, created_at, updated_at
       ) VALUES ($1, $2, $1, 'W2 OT', 'x', 'user', '[]'::jsonb, true, false, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [overtimeUserId, `${overtimeUserId}@example.test`],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active)
       VALUES ($1, $2, true)
       ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = true`,
      [overtimeUserId, ORG],
    )
    await pool.query(
      `INSERT INTO approval_instances
         (id, status, version, source_system, workflow_key, business_key, title,
          requester_snapshot, current_step, total_steps, current_node_key)
       VALUES ($1, 'pending', 0, 'platform', 'attendance_request_approval', $2, 'W2 OT guard',
               $3::jsonb, 0, 0, 'attendance_request_step_0')`,
      [
        approvalId,
        `attendance-request:${requestId}`,
        JSON.stringify({ id: overtimeUserId, name: overtimeUserId }),
      ],
    )
    await pool.query(
      `INSERT INTO attendance_requests
         (id, user_id, work_date, request_type, status, org_id, approval_instance_id, metadata)
       VALUES ($1, $2, $3, 'overtime', 'pending', $4, $5, $6::jsonb)`,
      [requestId, overtimeUserId, workDate, ORG, approvalId, JSON.stringify({ minutes: 60 })],
    )

    try {
      const approve = await approveRequest(requestId)
      expect(approve.status, approve.raw).toBe(422)
      expect(codeOf(approve)).toBe('OVERTIME_ATTRIBUTION_SNAPSHOT_REQUIRED')

      const request = (await pool.query(
        `SELECT status, resolved_at FROM attendance_requests WHERE id = $1`,
        [requestId],
      )).rows[0]
      expect(request).toMatchObject({ status: 'pending', resolved_at: null })
      const approval = (await pool.query(
        `SELECT status, version FROM approval_instances WHERE id = $1`,
        [approvalId],
      )).rows[0]
      expect(approval.status).toBe('pending')
      expect(Number(approval.version)).toBe(0)
      expect((await pool.query(
        `SELECT 1 FROM approval_records WHERE instance_id = $1`,
        [approvalId],
      )).rows).toHaveLength(0)
      expect((await pool.query(
        `SELECT 1 FROM attendance_records WHERE org_id = $1 AND user_id = $2 AND work_date = $3`,
        [ORG, overtimeUserId, workDate],
      )).rows).toHaveLength(0)
      expect((await pool.query(
        `SELECT 1 FROM attendance_leave_balance_events WHERE source_id = $1`,
        [requestId],
      )).rows).toHaveLength(0)
    } finally {
      await pool.query(`DELETE FROM approval_records WHERE instance_id = $1`, [approvalId]).catch(() => undefined)
      await pool.query(`DELETE FROM approval_assignments WHERE instance_id = $1`, [approvalId]).catch(() => undefined)
      await pool.query(`DELETE FROM attendance_requests WHERE id = $1`, [requestId]).catch(() => undefined)
      await pool.query(`DELETE FROM approval_instances WHERE id = $1`, [approvalId]).catch(() => undefined)
      await pool.query(`DELETE FROM user_orgs WHERE user_id = $1 AND org_id = $2`, [overtimeUserId, ORG]).catch(() => undefined)
      await pool.query(`DELETE FROM users WHERE id = $1`, [overtimeUserId]).catch(() => undefined)
    }
  })

  it('W2 overtime final approval copies the creation-frozen anchor into the result record', async () => {
    const requestId = randomUUID()
    const approvalId = randomUUID()
    const shiftId = randomUUID()
    const assignmentId = randomUUID()
    const workDate = workdayYmd(5)
    const overtimeUserId = `w2-ot-ok-${RUN}`
    const anchor = {
      version: 1,
      orgId: ORG,
      userId: overtimeUserId,
      workDate,
      shiftId,
      source: 'shift',
      assignmentId,
    }
    await pool.query(
      `INSERT INTO users (
         id, email, username, name, password_hash, role, permissions,
         is_active, is_admin, created_at, updated_at
       ) VALUES ($1, $2, $1, 'W2 OT accepted', 'x', 'user', '[]'::jsonb, true, false, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [overtimeUserId, `${overtimeUserId}@example.test`],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active)
       VALUES ($1, $2, true)
       ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = true`,
      [overtimeUserId, ORG],
    )
    await pool.query(
      `INSERT INTO approval_instances
         (id, status, version, source_system, workflow_key, business_key, title,
          requester_snapshot, current_step, total_steps, current_node_key)
       VALUES ($1, 'pending', 0, 'platform', 'attendance_request_approval', $2, 'W2 OT accepted',
               $3::jsonb, 0, 0, 'attendance_request_step_0')`,
      [
        approvalId,
        `attendance-request:${requestId}`,
        JSON.stringify({ id: overtimeUserId, name: overtimeUserId }),
      ],
    )
    await pool.query(
      `INSERT INTO attendance_requests
         (id, user_id, work_date, request_type, status, org_id, approval_instance_id, metadata)
       VALUES ($1, $2, $3, 'overtime', 'pending', $4, $5, $6::jsonb)`,
      [
        requestId,
        overtimeUserId,
        workDate,
        ORG,
        approvalId,
        JSON.stringify({ minutes: 60, overtimeAttributionV1: anchor }),
      ],
    )

    try {
      const approve = await approveRequest(requestId)
      expect(approve.status, approve.raw).toBe(200)
      const record = (await pool.query(
        `SELECT meta FROM attendance_records
         WHERE org_id = $1 AND user_id = $2 AND work_date = $3`,
        [ORG, overtimeUserId, workDate],
      )).rows[0]
      expect(record?.meta?.overtimeAttributionV1).toEqual(anchor)
      expect(record?.meta?.workDateAttributionV1).toMatchObject({
        version: 1,
        orgId: ORG,
        userId: overtimeUserId,
        workDate,
        shiftId,
      })
    } finally {
      await pool.query(
        `DELETE FROM attendance_leave_balance_events WHERE source_id = $1`,
        [requestId],
      ).catch(() => undefined)
      await pool.query(
        `DELETE FROM attendance_records WHERE org_id = $1 AND user_id = $2 AND work_date = $3`,
        [ORG, overtimeUserId, workDate],
      ).catch(() => undefined)
      await pool.query(`DELETE FROM approval_records WHERE instance_id = $1`, [approvalId]).catch(() => undefined)
      await pool.query(`DELETE FROM approval_assignments WHERE instance_id = $1`, [approvalId]).catch(() => undefined)
      await pool.query(`DELETE FROM attendance_requests WHERE id = $1`, [requestId]).catch(() => undefined)
      await pool.query(`DELETE FROM approval_instances WHERE id = $1`, [approvalId]).catch(() => undefined)
      await pool.query(`DELETE FROM user_orgs WHERE user_id = $1 AND org_id = $2`, [overtimeUserId, ORG]).catch(() => undefined)
      await pool.query(`DELETE FROM users WHERE id = $1`, [overtimeUserId]).catch(() => undefined)
    }
  })

  it('W2 correction and legacy import reject overlapping shift ambiguity with zero record writes', async () => {
    const workDate = workdayYmd(4)
    const ambiguityUserId = `w2-amb-${RUN}`
    const shiftA = randomUUID()
    const shiftB = randomUUID()
    const assignmentA = randomUUID()
    const assignmentB = randomUUID()
    const requestIds: string[] = []
    const approvalIds: string[] = []
    const importJobIds: string[] = []
    const importBatchIds: string[] = []
    const integrationIds: string[] = []
    let dingTalkMock: ReturnType<typeof http.createServer> | null = null
    await pool.query(
      `INSERT INTO users (
         id, email, username, name, password_hash, role, permissions,
         is_active, is_admin, created_at, updated_at
       ) VALUES ($1, $2, $1, 'W2 Ambiguous', 'x', 'user', '[]'::jsonb, true, false, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [ambiguityUserId, `${ambiguityUserId}@example.test`],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active)
       VALUES ($1, $2, true)
       ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = true`,
      [ambiguityUserId, ORG],
    )
    await pool.query(
      `INSERT INTO attendance_shifts
         (id, org_id, name, timezone, work_start_time, work_end_time, is_overnight, working_days)
       VALUES
         ($1, $3, 'W2 overlap A', 'UTC', '00:00', '12:00', false, '[0,1,2,3,4,5,6]'::jsonb),
         ($2, $3, 'W2 overlap B', 'UTC', '01:00', '11:00', false, '[0,1,2,3,4,5,6]'::jsonb)`,
      [shiftA, shiftB, ORG],
    )
    await pool.query(
      `INSERT INTO attendance_shift_assignments
         (id, org_id, user_id, shift_id, start_date, end_date, is_active, publish_status, slot_index)
       VALUES
         ($1, $3, $4, $5, $7, $7, true, 'published', 0),
         ($2, $3, $4, $6, $7, $7, true, 'published', 1)`,
      [assignmentA, assignmentB, ORG, ambiguityUserId, shiftA, shiftB, workDate],
    )

    try {
      const requestId = randomUUID()
      const approvalId = randomUUID()
      requestIds.push(requestId)
      approvalIds.push(approvalId)
      await pool.query(
        `INSERT INTO approval_instances
           (id, status, version, source_system, workflow_key, business_key, title,
            requester_snapshot, current_step, total_steps, current_node_key)
         VALUES ($1, 'pending', 0, 'platform', 'attendance_request_approval', $2,
                 'W2 correction guard', $3::jsonb, 0, 0, 'attendance_request_step_0')`,
        [
          approvalId,
          `attendance-request:${requestId}`,
          JSON.stringify({ id: ambiguityUserId, name: ambiguityUserId }),
        ],
      )
      await pool.query(
        `INSERT INTO attendance_requests
           (id, user_id, work_date, request_type, status, org_id, approval_instance_id,
            requested_in_at, requested_out_at, reason, metadata)
         VALUES ($1, $2, $3, 'time_correction', 'pending', $4, $5, $6, $7, $8, '{}'::jsonb)`,
        [
          requestId,
          ambiguityUserId,
          workDate,
          ORG,
          approvalId,
          `${workDate}T02:00:00.000Z`,
          `${workDate}T10:00:00.000Z`,
          'W2 overlapping shift guard',
        ],
      )

      const approve = await approveRequest(requestId)
      expect(approve.status, approve.raw).toBe(422)
      expect(codeOf(approve)).toBe('ATTENDANCE_CORRECTION_WORK_DATE_AMBIGUOUS')
      expect((await pool.query(
        `SELECT status FROM attendance_requests WHERE id = $1`,
        [requestId],
      )).rows[0]?.status).toBe('pending')
      expect((await pool.query(
        `SELECT 1 FROM attendance_records WHERE org_id = $1 AND user_id = $2 AND work_date = $3`,
        [ORG, ambiguityUserId, workDate],
      )).rows).toHaveLength(0)

      const importResponse = await postImport({
        orgId: ORG,
        userId: ambiguityUserId,
        rows: [{
          userId: ambiguityUserId,
          workDate,
          fields: {
            firstInAt: `${workDate}T02:00:00.000Z`,
            lastOutAt: `${workDate}T10:00:00.000Z`,
          },
        }],
        mode: 'override',
      })
      expect(importResponse.status, importResponse.raw).toBe(422)
      expect(codeOf(importResponse)).toBe('WORK_DATE_ATTRIBUTION_AMBIGUOUS')
      expect((await pool.query(
        `SELECT 1 FROM attendance_records WHERE org_id = $1 AND user_id = $2 AND work_date = $3`,
        [ORG, ambiguityUserId, workDate],
      )).rows).toHaveLength(0)

      const explicitShiftMismatch = await postImport({
        orgId: ORG,
        userId: ambiguityUserId,
        rows: [{
          userId: ambiguityUserId,
          workDate,
          fields: {
            firstInAt: `${workDate}T02:00:00.000Z`,
            lastOutAt: `${workDate}T10:00:00.000Z`,
            shiftId: randomUUID(),
          },
        }],
        mode: 'override',
      })
      expect(explicitShiftMismatch.status, explicitShiftMismatch.raw).toBe(422)
      expect(codeOf(explicitShiftMismatch)).toBe('WORK_DATE_ATTRIBUTION_EXPLICIT_SHIFT_MISMATCH')
      expect((await pool.query(
        `SELECT 1 FROM attendance_records WHERE org_id = $1 AND user_id = $2 AND work_date = $3`,
        [ORG, ambiguityUserId, workDate],
      )).rows).toHaveLength(0)

      const ambiguousRowsPayload = {
        orgId: ORG,
        userId: ambiguityUserId,
        rows: [{
          userId: ambiguityUserId,
          workDate,
          fields: {
            firstInAt: `${workDate}T02:00:00.000Z`,
            lastOutAt: `${workDate}T10:00:00.000Z`,
          },
        }],
        mode: 'override',
      }
      const prepareCommit = async () => {
        const prepared = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
          method: 'POST',
          headers: authHeaders(adminToken),
          body: JSON.stringify({ orgId: ORG }),
        })
        expect(prepared.status, prepared.raw).toBe(200)
        const token = dataOf(prepared)?.commitToken
        expect(token).toBeTruthy()
        return String(token)
      }
      const importPersistenceSnapshot = async () => {
        const batches = await pool.query(
          `SELECT id
             FROM attendance_import_batches
            WHERE org_id = $1
            ORDER BY id`,
          [ORG],
        )
        const items = await pool.query(
          `SELECT i.id
             FROM attendance_import_items i
             JOIN attendance_import_batches b ON b.id = i.batch_id
            WHERE b.org_id = $1
            ORDER BY i.id`,
          [ORG],
        )
        return {
          batchIds: batches.rows.map((row) => String(row.id)),
          itemIds: items.rows.map((row) => String(row.id)),
        }
      }

      const beforeCommitFailure = await importPersistenceSnapshot()
      const commitResponse = await requestJson(`${baseUrl}/api/attendance/import/commit`, {
        method: 'POST',
        headers: authHeaders(adminToken),
        body: JSON.stringify({
          ...ambiguousRowsPayload,
          commitToken: await prepareCommit(),
          idempotencyKey: `w2-commit-${RUN}`,
        }),
      })
      expect(commitResponse.status, commitResponse.raw).toBe(422)
      expect(codeOf(commitResponse)).toBe('WORK_DATE_ATTRIBUTION_AMBIGUOUS')
      expect((await pool.query(
        `SELECT 1 FROM attendance_records WHERE org_id = $1 AND user_id = $2 AND work_date = $3`,
        [ORG, ambiguityUserId, workDate],
      )).rows).toHaveLength(0)
      expect(await importPersistenceSnapshot()).toEqual(beforeCommitFailure)

      const beforeAsyncFailure = await importPersistenceSnapshot()
      const asyncResponse = await requestJson(`${baseUrl}/api/attendance/import/commit-async`, {
        method: 'POST',
        headers: authHeaders(adminToken),
        body: JSON.stringify({
          ...ambiguousRowsPayload,
          commitToken: await prepareCommit(),
          idempotencyKey: `w2-commit-async-${RUN}`,
        }),
      })
      expect(asyncResponse.status, asyncResponse.raw).toBe(200)
      const asyncJob = dataOf(asyncResponse)?.job
      const asyncJobId = String(asyncJob?.id ?? '')
      const asyncBatchId = String(asyncJob?.batchId ?? '')
      expect(asyncJobId).toBeTruthy()
      expect(asyncBatchId).toBeTruthy()
      importJobIds.push(asyncJobId)
      importBatchIds.push(asyncBatchId)
      let failedAsyncJob: any = null
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const jobResponse = await requestJson(
          `${baseUrl}/api/attendance/import/jobs/${encodeURIComponent(asyncJobId)}?orgId=${encodeURIComponent(ORG)}`,
          { headers: authHeaders(adminToken) },
        )
        expect(jobResponse.status, jobResponse.raw).toBe(200)
        const job = dataOf(jobResponse)
        if (job?.status === 'failed') {
          failedAsyncJob = job
          break
        }
        if (job?.status === 'completed') {
          throw new Error(`W2 ambiguous async import completed unexpectedly: ${jobResponse.raw}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(failedAsyncJob).toBeTruthy()
      expect(String(failedAsyncJob?.error ?? '')).toContain('Multiple shift windows match')
      expect((await pool.query(
        `SELECT 1 FROM attendance_records WHERE org_id = $1 AND user_id = $2 AND work_date = $3`,
        [ORG, ambiguityUserId, workDate],
      )).rows).toHaveLength(0)
      expect(await importPersistenceSnapshot()).toEqual(beforeAsyncFailure)
      expect((await pool.query(
        `SELECT status FROM attendance_import_jobs WHERE id = $1`,
        [asyncJobId],
      )).rows).toEqual([{ status: 'failed' }])
      expect((await pool.query(
        `SELECT 1 FROM attendance_import_batches WHERE id = $1`,
        [asyncBatchId],
      )).rows).toHaveLength(0)

      let mockFirstInAt: string = `${workDate}T02:00:00.000Z`
      let mockLastOutAt: string = `${workDate}T10:00:00.000Z`
      dingTalkMock = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json')
        if (req.url?.startsWith('/gettoken')) {
          res.end(JSON.stringify({ access_token: `w2-token-${RUN}`, expires_in: 7200 }))
          return
        }
        if (req.url?.startsWith('/topapi/attendance/getcolumnval')) {
          res.end(JSON.stringify({
            result: {
              column_vals: [
                {
                  column_vo: { id: 'first-in' },
                  column_vals: [{ date: workDate, value: mockFirstInAt }],
                },
                {
                  column_vo: { id: 'last-out' },
                  column_vals: [{ date: workDate, value: mockLastOutAt }],
                },
                {
                  column_vo: { id: 'clock-in-2' },
                  column_vals: [{ date: workDate, value: '23:00' }],
                },
                {
                  column_vo: { id: 'clock-out-2' },
                  column_vals: [{ date: workDate, value: '05:30' }],
                },
              ],
            },
          }))
          return
        }
        res.statusCode = 404
        res.end(JSON.stringify({ errmsg: 'not found' }))
      })
      await new Promise<void>((resolve, reject) => {
        dingTalkMock?.once('error', reject)
        dingTalkMock?.listen(0, '127.0.0.1', () => resolve())
      })
      const mockAddress = dingTalkMock.address()
      if (!mockAddress || typeof mockAddress === 'string') {
        throw new Error('W2 DingTalk mock did not expose a TCP address')
      }
      const integrationCreate = await requestJson(`${baseUrl}/api/attendance/integrations`, {
        method: 'POST',
        headers: authHeaders(adminToken),
        body: JSON.stringify({
          orgId: ORG,
          name: `W2 overlap ${RUN}`,
          type: 'dingtalk',
          config: {
            appKey: `w2-key-${RUN}`,
            appSecret: `w2-secret-${RUN}`,
            baseUrl: `http://127.0.0.1:${mockAddress.port}`,
            userIds: [ambiguityUserId],
            columnIds: ['first-in', 'last-out', 'clock-in-2', 'clock-out-2'],
            columns: [
              { id: 'first-in', alias: 'firstInAt' },
              { id: 'last-out', alias: 'lastOutAt' },
              { id: 'clock-in-2', alias: 'clockIn2' },
              { id: 'clock-out-2', alias: 'clockOut2' },
            ],
            mappingProfileId: 'dingtalk_api_columns',
            userMapKeyField: 'userId',
            userMap: { [ambiguityUserId]: ambiguityUserId },
          },
        }),
      })
      expect(integrationCreate.status, integrationCreate.raw).toBe(200)
      const integrationId = String(dataOf(integrationCreate)?.id ?? '')
      expect(integrationId).toBeTruthy()
      integrationIds.push(integrationId)

      const beforeIntegrationFailure = await importPersistenceSnapshot()
      const integrationSync = await requestJson(
        `${baseUrl}/api/attendance/integrations/${encodeURIComponent(integrationId)}/sync`,
        {
          method: 'POST',
          headers: authHeaders(adminToken),
          body: JSON.stringify({ orgId: ORG, from: workDate, to: workDate }),
        },
      )
      expect(integrationSync.status, integrationSync.raw).toBe(422)
      expect(codeOf(integrationSync)).toBe('WORK_DATE_ATTRIBUTION_AMBIGUOUS')
      expect((await pool.query(
        `SELECT 1 FROM attendance_records WHERE org_id = $1 AND user_id = $2 AND work_date = $3`,
        [ORG, ambiguityUserId, workDate],
      )).rows).toHaveLength(0)
      expect(await importPersistenceSnapshot()).toEqual(beforeIntegrationFailure)
      expect((await pool.query(
        `SELECT status
           FROM attendance_integration_runs
          WHERE integration_id = $1
          ORDER BY started_at DESC
          LIMIT 1`,
        [integrationId],
      )).rows).toEqual([{ status: 'failed' }])

      await pool.query(
        `UPDATE attendance_shift_assignments SET is_active = false WHERE id = $1`,
        [assignmentB],
      )
      await pool.query(
        `UPDATE attendance_shifts
         SET work_start_time = '22:00', work_end_time = '06:00', is_overnight = true
         WHERE id = $1`,
        [shiftA],
      )
      const overnightRowsPayload = {
        orgId: ORG,
        userId: ambiguityUserId,
        rows: [{
          userId: ambiguityUserId,
          workDate,
          fields: {
            firstInAt: '22:00',
            lastOutAt: '06:00',
            clockIn2: '23:00',
            clockOut2: '05:30',
          },
        }],
        mode: 'override',
      }
      const nextWorkDate = new Date(
        new Date(`${workDate}T00:00:00.000Z`).getTime() + 86400000,
      ).toISOString().slice(0, 10)
      const assertOvernightRecord = async () => {
        const record = (await pool.query(
          `SELECT first_in_at, last_out_at, meta, source_batch_id FROM attendance_records
           WHERE org_id = $1 AND user_id = $2 AND work_date = $3`,
          [ORG, ambiguityUserId, workDate],
        )).rows[0]
        expect(new Date(record?.first_in_at).toISOString()).toBe(`${workDate}T22:00:00.000Z`)
        expect(new Date(record?.last_out_at).toISOString()).toBe(`${nextWorkDate}T06:00:00.000Z`)
        expect(record?.meta).toMatchObject({
          clockIn2: `${workDate}T23:00:00.000Z`,
          clockOut2: `${nextWorkDate}T05:30:00.000Z`,
          workDateAttributionV1: {
            version: 1,
            orgId: ORG,
            userId: ambiguityUserId,
            workDate,
            shiftId: shiftA,
          },
        })
        return record?.source_batch_id ? String(record.source_batch_id) : null
      }
      const clearOvernightRecord = async () => {
        await pool.query(
          `DELETE FROM attendance_records
            WHERE org_id = $1 AND user_id = $2 AND work_date = $3`,
          [ORG, ambiguityUserId, workDate],
        )
      }
      const acceptedImport = await postImport(overnightRowsPayload)
      expect(acceptedImport.status, acceptedImport.raw).toBe(200)
      expect(await assertOvernightRecord()).toBeNull()
      await clearOvernightRecord()

      const acceptedCommit = await requestJson(`${baseUrl}/api/attendance/import/commit`, {
        method: 'POST',
        headers: authHeaders(adminToken),
        body: JSON.stringify({
          ...overnightRowsPayload,
          commitToken: await prepareCommit(),
          idempotencyKey: `w2-overnight-commit-${RUN}`,
        }),
      })
      expect(acceptedCommit.status, acceptedCommit.raw).toBe(200)
      expect(dataOf(acceptedCommit)?.imported, acceptedCommit.raw).toBe(1)
      const acceptedCommitBatchId = await assertOvernightRecord()
      expect(acceptedCommitBatchId).toBeTruthy()
      importBatchIds.push(String(acceptedCommitBatchId))
      await clearOvernightRecord()

      const acceptedAsync = await requestJson(`${baseUrl}/api/attendance/import/commit-async`, {
        method: 'POST',
        headers: authHeaders(adminToken),
        body: JSON.stringify({
          ...overnightRowsPayload,
          commitToken: await prepareCommit(),
          idempotencyKey: `w2-overnight-async-${RUN}`,
        }),
      })
      expect(acceptedAsync.status, acceptedAsync.raw).toBe(200)
      const acceptedAsyncJob = dataOf(acceptedAsync)?.job
      const acceptedAsyncJobId = String(acceptedAsyncJob?.id ?? '')
      const acceptedAsyncBatchId = String(acceptedAsyncJob?.batchId ?? '')
      expect(acceptedAsyncJobId).toBeTruthy()
      expect(acceptedAsyncBatchId).toBeTruthy()
      importJobIds.push(acceptedAsyncJobId)
      importBatchIds.push(acceptedAsyncBatchId)
      let completedAsyncJob: any = null
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const jobResponse = await requestJson(
          `${baseUrl}/api/attendance/import/jobs/${encodeURIComponent(acceptedAsyncJobId)}?orgId=${encodeURIComponent(ORG)}`,
          { headers: authHeaders(adminToken) },
        )
        expect(jobResponse.status, jobResponse.raw).toBe(200)
        const job = dataOf(jobResponse)
        if (job?.status === 'completed') {
          completedAsyncJob = job
          break
        }
        if (job?.status === 'failed') {
          throw new Error(`W2 overnight async import failed unexpectedly: ${jobResponse.raw}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(completedAsyncJob).toBeTruthy()
      expect(await assertOvernightRecord()).toBe(acceptedAsyncBatchId)
      await clearOvernightRecord()

      mockFirstInAt = '22:00'
      mockLastOutAt = '06:00'
      const acceptedIntegrationSync = await requestJson(
        `${baseUrl}/api/attendance/integrations/${encodeURIComponent(integrationId)}/sync`,
        {
          method: 'POST',
          headers: authHeaders(adminToken),
          body: JSON.stringify({ orgId: ORG, from: workDate, to: workDate }),
        },
      )
      expect(acceptedIntegrationSync.status, acceptedIntegrationSync.raw).toBe(200)
      const acceptedIntegrationBatchId = await assertOvernightRecord()
      expect(acceptedIntegrationBatchId).toBeTruthy()
      importBatchIds.push(String(acceptedIntegrationBatchId))
    } finally {
      for (const approvalId of approvalIds) {
        await pool.query(`DELETE FROM approval_records WHERE instance_id = $1`, [approvalId]).catch(() => undefined)
        await pool.query(`DELETE FROM approval_assignments WHERE instance_id = $1`, [approvalId]).catch(() => undefined)
      }
      for (const requestId of requestIds) {
        await pool.query(`DELETE FROM attendance_requests WHERE id = $1`, [requestId]).catch(() => undefined)
      }
      for (const approvalId of approvalIds) {
        await pool.query(`DELETE FROM approval_instances WHERE id = $1`, [approvalId]).catch(() => undefined)
      }
      if (dingTalkMock) {
        await new Promise<void>((resolve) => dingTalkMock?.close(() => resolve()))
      }
      for (const integrationId of integrationIds) {
        await pool.query(`DELETE FROM attendance_integration_runs WHERE integration_id = $1`, [integrationId]).catch(() => undefined)
        await pool.query(`DELETE FROM attendance_integrations WHERE id = $1`, [integrationId]).catch(() => undefined)
      }
      for (const jobId of importJobIds) {
        await pool.query(`DELETE FROM attendance_import_jobs WHERE id = $1`, [jobId]).catch(() => undefined)
      }
      for (const batchId of importBatchIds) {
        await pool.query(`DELETE FROM attendance_import_items WHERE batch_id = $1`, [batchId]).catch(() => undefined)
        await pool.query(`DELETE FROM attendance_import_batches WHERE id = $1`, [batchId]).catch(() => undefined)
      }
      await pool.query(`DELETE FROM attendance_records WHERE org_id = $1 AND work_date = $2`, [ORG, workDate]).catch(() => undefined)
      await pool.query(`DELETE FROM attendance_shift_assignments WHERE id = ANY($1::uuid[])`, [[assignmentA, assignmentB]]).catch(() => undefined)
      await pool.query(`DELETE FROM attendance_shifts WHERE id = ANY($1::uuid[])`, [[shiftA, shiftB]]).catch(() => undefined)
      await pool.query(`DELETE FROM user_orgs WHERE user_id = $1 AND org_id = $2`, [ambiguityUserId, ORG]).catch(() => undefined)
      await pool.query(`DELETE FROM users WHERE id = $1`, [ambiguityUserId]).catch(() => undefined)
    }
  })

  it('AE-1b durability: unmarked records keep route-derived behavior and never gain a manual marker', async () => {
    const userId = `u-durable-unmarked-${RUN}`
    const workDate = ymd(3)
    const recordId = await seedRecord({
      userId, workDate, status: 'late', workMinutes: 480, lateMinutes: 25, earlyLeaveMinutes: 0,
      firstInAt: `${workDate}T01:25:00Z`, lastOutAt: `${workDate}T10:00:00Z`,
    })

    const importRes = await postImport({
      orgId: ORG,
      userId,
      rows: [
        {
          workDate,
          fields: {
            firstInAt: `${workDate}T01:55:00Z`,
            lastOutAt: `${workDate}T10:00:00Z`,
          },
        },
      ],
      mode: 'override',
    })
    expect(importRes.status).toBe(200)

    const rec = await recordById(recordId)
    expect(rec.status).not.toBe('normal')
    expect(rec.meta?.manual_result_edit).toBeUndefined()
    expect(await auditRowsForRecord(recordId)).toHaveLength(0)
  })

  it('disabled policy: returns 403 ATTENDANCE_RESULT_EDIT_DISABLED before writing audit or record changes', async () => {
    const settings = await getSettings()
    expect(settings.status).toBe(200)
    const originalPolicy = dataOf(settings)?.attendanceResultEditPolicy
    const disabled = await putSettings({ attendanceResultEditPolicy: resultEditPolicyWithEnabled(originalPolicy, false) })
    expect(disabled.status).toBe(200)

    try {
      const userId = `u-disabled-${RUN}`
      const workDate = ymd(2)
      const recordId = await seedRecord({
        userId, workDate, status: 'late', workMinutes: 480, lateMinutes: 30, earlyLeaveMinutes: 0,
        firstInAt: `${workDate}T01:30:00Z`, lastOutAt: `${workDate}T10:00:00Z`,
      })

      const res = await postEdit({ orgId: ORG, recordId, targetStatus: 'normal', reason: 'policy disabled', idempotencyKey: `k-disabled-${RUN}` })
      expect(res.status).toBe(403)
      expect(codeOf(res)).toBe('ATTENDANCE_RESULT_EDIT_DISABLED')
      expect(await auditRowsForRecord(recordId)).toHaveLength(0)
      expect(await deliveryRowsForRecord(recordId)).toHaveLength(0)

      const rec = await recordById(recordId)
      expect(rec.status).toBe('late')
      expect(Number(rec.late_minutes)).toBe(30)
    } finally {
      await putSettings({
        attendanceResultEditPolicy: resultEditPolicyWithEnabled(
          originalPolicy,
          isResultEditPolicySetting(originalPolicy) ? originalPolicy.enabled !== false : true,
        ),
      }).catch(() => undefined)
    }
  })

  it('§3.5a absent→normal: keeps work_minutes=0 + null punches by default; overrideMetrics.workMinutes takes precedence', async () => {
    // default: no override → work stays 0, no fabricated punches
    const u1 = `u-abs-${RUN}`
    const wd1 = ymd(3)
    const r1 = await seedRecord({
      userId: u1,
      workDate: wd1,
      status: 'absent',
      workMinutes: 0,
      lateMinutes: 90,
      earlyLeaveMinutes: 15,
      firstInAt: null,
      lastOutAt: null,
      meta: { severe_late_count: 1, severe_late_minutes: 90, absence_late_count: 1, warnings: ['manual-review'] },
    })
    const e1 = await postEdit({ orgId: ORG, recordId: r1, targetStatus: 'normal', reason: '线下值班，核验后更正为正常', idempotencyKey: `k-abs1-${RUN}` })
    expect(e1.status).toBe(200)
    const rec1 = await recordById(r1)
    expect(rec1.status).toBe('normal')
    expect(Number(rec1.work_minutes)).toBe(0)
    expect(Number(rec1.late_minutes)).toBe(0)
    expect(Number(rec1.early_leave_minutes)).toBe(0)
    expect(rec1.first_in_at).toBeNull()
    expect(rec1.last_out_at).toBeNull()
    expect(Number(rec1.meta?.severe_late_count ?? -1)).toBe(0)
    expect(Number(rec1.meta?.severe_late_minutes ?? -1)).toBe(0)
    expect(Number(rec1.meta?.absence_late_count ?? -1)).toBe(0)
    expect(rec1.meta?.warnings).toEqual(['manual-review'])

    // override: admin supplies the payroll work minutes
    const u2 = `u-abs2-${RUN}`
    const wd2 = ymd(4)
    const r2 = await seedRecord({ userId: u2, workDate: wd2, status: 'absent', workMinutes: 0, firstInAt: null, lastOutAt: null })
    const e2 = await postEdit({ orgId: ORG, recordId: r2, targetStatus: 'normal', reason: '补登一整天工时', overrideMetrics: { workMinutes: 480 }, idempotencyKey: `k-abs2-${RUN}` })
    expect(e2.status).toBe(200)
    const rec2 = await recordById(r2)
    expect(rec2.status).toBe('normal')
    expect(Number(rec2.work_minutes)).toBe(480)
  })

  it('idempotency: missing key → 400 nothing written; same key+payload → alreadyApplied (one row); different payload → 409', async () => {
    const userId = `u-idem-${RUN}`
    const workDate = ymd(2)
    const recordId = await seedRecord({ userId, workDate, status: 'late', workMinutes: 480, lateMinutes: 20, firstInAt: `${workDate}T01:20:00Z`, lastOutAt: `${workDate}T10:00:00Z` })

    // missing key → 400, nothing written
    const missing = await postEdit({ orgId: ORG, recordId, targetStatus: 'normal', reason: 'no key' })
    expect(missing.status).toBe(400)
    expect(codeOf(missing)).toBe('VALIDATION_ERROR')
    expect(await auditRowsForRecord(recordId)).toHaveLength(0)

    const key = `k-idem-${RUN}`
    const first = await postEdit({ orgId: ORG, recordId, targetStatus: 'normal', reason: 'verified offline', idempotencyKey: key })
    expect(first.status).toBe(200)
    expect(dataOf(first).alreadyApplied).toBe(false)
    const afterFirst = await recordById(recordId)
    const firstMarker = afterFirst.meta?.manual_result_edit
    expect(firstMarker?.idempotencyKey).toBe(key)
    expect(firstMarker?.auditId).toEqual(expect.any(String))
    const afterFirstDeliveries = await deliveryRowsForRecord(recordId)
    expect(afterFirstDeliveries).toHaveLength(1)

    // exact replay → alreadyApplied, no 2nd row
    const replay = await postEdit({ orgId: ORG, recordId, targetStatus: 'normal', reason: 'verified offline', idempotencyKey: key })
    expect(replay.status).toBe(200)
    expect(dataOf(replay).alreadyApplied).toBe(true)
    expect(await auditByKey(ORG, key)).toHaveLength(1)
    expect(await deliveryRowsForRecord(recordId)).toHaveLength(1)
    const afterReplay = await recordById(recordId)
    expect(afterReplay.meta?.manual_result_edit).toMatchObject({
      idempotencyKey: key,
      auditId: firstMarker.auditId,
      targetStatus: 'normal',
      reviewConflict: null,
    })

    // v1 decision: overrideMetrics is intentionally not part of the idempotency identity.
    // A deliberate same-key replay with different metrics returns the first edit and does not mutate again.
    const metricsReplay = await postEdit({
      orgId: ORG,
      recordId,
      targetStatus: 'normal',
      reason: 'verified offline',
      overrideMetrics: { workMinutes: 1, lateMinutes: 99, earlyLeaveMinutes: 88 },
      idempotencyKey: key,
    })
    expect(metricsReplay.status).toBe(200)
    expect(dataOf(metricsReplay).alreadyApplied).toBe(true)
    expect(await auditByKey(ORG, key)).toHaveLength(1)
    const recAfterReplay = await recordById(recordId)
    expect(Number(recAfterReplay.work_minutes)).toBe(480)
    expect(Number(recAfterReplay.late_minutes)).toBe(0)
    expect(Number(recAfterReplay.early_leave_minutes)).toBe(0)
    expect(recAfterReplay.meta?.manual_result_edit?.auditId).toBe(firstMarker.auditId)

    // same key, different payload (target) → 409
    const conflict = await postEdit({ orgId: ORG, recordId, targetStatus: 'absent', reason: 'verified offline', idempotencyKey: key })
    expect(conflict.status).toBe(409)
    expect(codeOf(conflict)).toBe('ATTENDANCE_RESULT_EDIT_IDEMPOTENCY_CONFLICT')
    expect(await auditByKey(ORG, key)).toHaveLength(1)
    expect(await deliveryRowsForRecord(recordId)).toHaveLength(1)
  })

  it('AE-2 notification: worker failure is visible through the existing delivery status API', async () => {
    await pool.query(
      `UPDATE attendance_notification_deliveries
          SET next_attempt_at = now() + interval '1 day'
        WHERE org_id = $1 AND source_type = 'attendance_result_edit'`,
      [ORG],
    )
    const userId = `u-ae2-worker-${RUN}`
    const workDate = workdayYmd(3)
    const recordId = await seedRecord({
      userId, workDate, status: 'late', workMinutes: 480, lateMinutes: 22, earlyLeaveMinutes: 0,
      firstInAt: `${workDate}T01:22:00Z`, lastOutAt: `${workDate}T10:00:00Z`,
    })
    const res = await postEdit({ orgId: ORG, recordId, targetStatus: 'normal', reason: 'worker failure probe', idempotencyKey: `k-ae2-worker-${RUN}` })
    expect(res.status).toBe(200)
    const [delivery] = await deliveryRowsForRecord(recordId)
    expect(delivery).toBeTruthy()
    await pool.query(
      `UPDATE attendance_notification_deliveries
          SET payload = payload || $2::jsonb, next_attempt_at = '2000-01-01T00:00:00Z'::timestamptz
        WHERE id = $1`,
      [delivery.id, JSON.stringify({ fakeDelivery: 'fail' })],
    )

    const query: AttendanceNotificationDeliveryQuery = async (sqlText, params) => {
      const r = await pool.query(sqlText, params as unknown[])
      return { rows: r.rows, rowCount: r.rowCount }
    }
    const worker = new AttendanceNotificationDeliveryWorker({
      query,
      channels: [new DeterministicFakeAttendanceDeliveryChannel()],
      workerId: 'ae2-worker-test',
      batchSize: 1,
    })
    await expect(worker.runBatch()).resolves.toMatchObject({ failed: 1 })

    const failed = await requestJson(`${baseUrl}/api/attendance/notification-deliveries?orgId=${encodeURIComponent(ORG)}&status=failed&pageSize=50`, { headers: authHeaders(adminToken) })
    expect(failed.status).toBe(200)
    const items = dataOf(failed)?.items ?? []
    const row = items.find((item: any) => item.id === delivery.id)
    expect(row).toMatchObject({
      sourceType: 'attendance_result_edit',
      recipientUserId: userId,
      recipientRole: 'subject',
      channel: 'dingtalk_work_notification',
      status: 'failed',
      lastError: 'fake_non_retryable_failure',
    })
    expect(Number(dataOf(failed)?.counters?.failed ?? 0)).toBeGreaterThanOrEqual(1)
  })

  it('editable-source: off/adjusted → 422 SOURCE_NOT_EDITABLE; normal→abnormal → 422 NORMAL_TO_ABNORMAL_UNSUPPORTED; normal→normal → 422 SOURCE_NOT_EDITABLE', async () => {
    const wd = ymd(2)
    const off = await seedRecord({ userId: `u-off-${RUN}`, workDate: wd, status: 'off', isWorkday: false })
    const ro = await postEdit({ orgId: ORG, recordId: off, targetStatus: 'normal', reason: 'x', idempotencyKey: `k-off-${RUN}` })
    expect(ro.status).toBe(422)
    expect(codeOf(ro)).toBe('ATTENDANCE_RESULT_EDIT_SOURCE_NOT_EDITABLE')

    const adj = await seedRecord({ userId: `u-adj-${RUN}`, workDate: wd, status: 'adjusted' })
    const ra = await postEdit({ orgId: ORG, recordId: adj, targetStatus: 'normal', reason: 'x', idempotencyKey: `k-adj-${RUN}` })
    expect(ra.status).toBe(422)
    expect(codeOf(ra)).toBe('ATTENDANCE_RESULT_EDIT_SOURCE_NOT_EDITABLE')

    const norm = await seedRecord({ userId: `u-norm-${RUN}`, workDate: wd, status: 'normal', workMinutes: 480 })
    const rn = await postEdit({ orgId: ORG, recordId: norm, targetStatus: 'absent', reason: 'x', idempotencyKey: `k-norm-abn-${RUN}` })
    expect(rn.status).toBe(422)
    expect(codeOf(rn)).toBe('ATTENDANCE_RESULT_EDIT_NORMAL_TO_ABNORMAL_UNSUPPORTED')

    const rn2 = await postEdit({ orgId: ORG, recordId: norm, targetStatus: 'normal', reason: 'x', idempotencyKey: `k-norm-noop-${RUN}` })
    expect(rn2.status).toBe(422)
    expect(codeOf(rn2)).toBe('ATTENDANCE_RESULT_EDIT_SOURCE_NOT_EDITABLE')

    // none of the rejected edits wrote an audit row or changed status
    expect(await auditRowsForRecord(off)).toHaveLength(0)
    expect(await auditRowsForRecord(norm)).toHaveLength(0)
    expect(await deliveryRowsForRecord(off)).toHaveLength(0)
    expect(await deliveryRowsForRecord(norm)).toHaveLength(0)
    expect((await recordById(norm)).status).toBe('normal')
  })

  it('closed/archived cycle covering work_date → 409 CYCLE_CLOSED even with no settlement row; closed wins over an overlapping open cycle', async () => {
    const wd = ymd(2)
    const cycleClosed = await seedClosedCycle(wd, 'closed')
    try {
      const r1 = await seedRecord({ userId: `u-cyc1-${RUN}`, workDate: wd, status: 'late', lateMinutes: 30, workMinutes: 480, firstInAt: `${wd}T01:30:00Z`, lastOutAt: `${wd}T10:00:00Z` })
      const e1 = await postEdit({ orgId: ORG, recordId: r1, targetStatus: 'normal', reason: 'x', idempotencyKey: `k-cyc1-${RUN}` })
      expect(e1.status).toBe(409)
      expect(codeOf(e1)).toBe('ATTENDANCE_RESULT_EDIT_CYCLE_CLOSED')
      expect(await auditRowsForRecord(r1)).toHaveLength(0)
      expect(await deliveryRowsForRecord(r1)).toHaveLength(0)
      expect((await recordById(r1)).status).toBe('late') // unchanged

      // overlapping open cycle present too → the closed one still wins and rejects
      const openCycle = (await pool.query(
        `INSERT INTO attendance_payroll_cycles (org_id, start_date, end_date, status) VALUES ($1, $2, $3, 'open') RETURNING id`,
        [ORG, wd, wd],
      )).rows[0].id as string
      try {
        const e2 = await postEdit({ orgId: ORG, recordId: r1, targetStatus: 'normal', reason: 'x', idempotencyKey: `k-cyc2-${RUN}` })
        expect(e2.status).toBe(409)
        expect(codeOf(e2)).toBe('ATTENDANCE_RESULT_EDIT_CYCLE_CLOSED')
      } finally {
        await pool.query(`DELETE FROM attendance_payroll_cycles WHERE id = $1`, [openCycle]).catch(() => undefined)
      }
    } finally {
      await pool.query(`DELETE FROM attendance_payroll_cycles WHERE id = $1`, [cycleClosed]).catch(() => undefined)
    }

    // archived behaves identically
    const cycleArchived = await seedClosedCycle(wd, 'archived')
    try {
      const r2 = await seedRecord({ userId: `u-cyc3-${RUN}`, workDate: wd, status: 'late', lateMinutes: 30, workMinutes: 480, firstInAt: `${wd}T01:30:00Z`, lastOutAt: `${wd}T10:00:00Z` })
      const e3 = await postEdit({ orgId: ORG, recordId: r2, targetStatus: 'normal', reason: 'x', idempotencyKey: `k-cyc3-${RUN}` })
      expect(e3.status).toBe(409)
      expect(codeOf(e3)).toBe('ATTENDANCE_RESULT_EDIT_CYCLE_CLOSED')
    } finally {
      await pool.query(`DELETE FROM attendance_payroll_cycles WHERE id = $1`, [cycleArchived]).catch(() => undefined)
    }
  })

  it('edit-window: work_date older than editWindowDays (default 180) → 422 WINDOW_EXPIRED, nothing written', async () => {
    const wd = ymd(400)
    const recordId = await seedRecord({ userId: `u-win-${RUN}`, workDate: wd, status: 'late', lateMinutes: 30, workMinutes: 480, firstInAt: `${wd}T01:30:00Z`, lastOutAt: `${wd}T10:00:00Z` })
    const res = await postEdit({ orgId: ORG, recordId, targetStatus: 'normal', reason: 'too old', idempotencyKey: `k-win-${RUN}` })
    expect(res.status).toBe(422)
    expect(codeOf(res)).toBe('ATTENDANCE_RESULT_EDIT_WINDOW_EXPIRED')
    expect(await auditRowsForRecord(recordId)).toHaveLength(0)
  })

  it('edit-window: invalid resolved rule timezone fails closed before writing audit or mutating the record', async () => {
    await withDefaultRule({ timezone: 'Not/AZone' }, async () => {
      const wd = ymd(2)
      const recordId = await seedRecord({
        userId: `u-badtz-${RUN}`,
        workDate: wd,
        status: 'late',
        lateMinutes: 30,
        workMinutes: 480,
        firstInAt: `${wd}T01:30:00Z`,
        lastOutAt: `${wd}T10:00:00Z`,
      })
      const res = await postEdit({ orgId: ORG, recordId, targetStatus: 'normal', reason: 'bad timezone', idempotencyKey: `k-badtz-${RUN}` })
      expect(res.status).toBe(422)
      expect(codeOf(res)).toBe('ATTENDANCE_RESULT_EDIT_WINDOW_EXPIRED')
      expect(await auditRowsForRecord(recordId)).toHaveLength(0)

      const rec = await recordById(recordId)
      expect(rec.status).toBe('late')
      expect(Number(rec.late_minutes)).toBe(30)
    })
  })

  it('partition filter: caller orgId mismatch for a record in another org → 404, no audit row', async () => {
    const wd = ymd(2)
    const otherRecord = await seedRecord({ userId: `u-x-${RUN}`, workDate: wd, status: 'late', lateMinutes: 30, workMinutes: 480, org: ORG_OTHER, firstInAt: `${wd}T01:30:00Z`, lastOutAt: `${wd}T10:00:00Z` })
    const key = `k-xorg-${RUN}`
    const res = await postEdit({ orgId: ORG, recordId: otherRecord, targetStatus: 'normal', reason: 'x', idempotencyKey: key })
    expect(res.status).toBe(404)
    expect(codeOf(res)).toBe('ATTENDANCE_RECORD_NOT_FOUND')
    expect(await auditByKey(ORG, key)).toHaveLength(0)
    expect(await auditByKey(ORG_OTHER, key)).toHaveLength(0)
    expect((await recordById(otherRecord)).status).toBe('late') // untouched
  })

  it('reason: blank reason → 400 when policy.requireReason (default true), nothing written', async () => {
    const wd = ymd(2)
    const recordId = await seedRecord({ userId: `u-reason-${RUN}`, workDate: wd, status: 'late', lateMinutes: 30, workMinutes: 480, firstInAt: `${wd}T01:30:00Z`, lastOutAt: `${wd}T10:00:00Z` })
    const res = await postEdit({ orgId: ORG, recordId, targetStatus: 'normal', reason: '   ', idempotencyKey: `k-reason-${RUN}` })
    expect(res.status).toBe(400)
    expect(codeOf(res)).toBe('VALIDATION_ERROR')
    expect(await auditRowsForRecord(recordId)).toHaveLength(0)
  })

  it('evidence: raw http URL rejected; https + attachmentId accepted and persisted', async () => {
    const wd = ymd(2)
    const recordId = await seedRecord({ userId: `u-ev-${RUN}`, workDate: wd, status: 'late', lateMinutes: 30, workMinutes: 480, firstInAt: `${wd}T01:30:00Z`, lastOutAt: `${wd}T10:00:00Z` })

    // raw http → rejected, nothing written
    const bad = await postEdit({ orgId: ORG, recordId, targetStatus: 'normal', reason: 'r', evidence: [{ type: 'url', url: 'http://insecure.example.com/p' }], idempotencyKey: `k-ev-bad-${RUN}` })
    expect(bad.status).toBe(400)
    expect(codeOf(bad)).toBe('VALIDATION_ERROR')
    expect(await auditRowsForRecord(recordId)).toHaveLength(0)

    // markup in a text label → rejected
    const bad2 = await postEdit({ orgId: ORG, recordId, targetStatus: 'normal', reason: 'r', evidence: [{ type: 'text', text: '<script>x</script>' }], idempotencyKey: `k-ev-bad2-${RUN}` })
    expect(bad2.status).toBe(400)
    expect(await auditRowsForRecord(recordId)).toHaveLength(0)

    // https url + attachmentId → accepted, persisted on the audit row
    const ok = await postEdit({
      orgId: ORG, recordId, targetStatus: 'normal', reason: 'r',
      evidence: [{ type: 'url', label: 'site photo', url: 'https://files.example.com/a.jpg' }, { attachmentId: 'att-123' }],
      idempotencyKey: `k-ev-ok-${RUN}`,
    })
    expect(ok.status).toBe(200)
    const audit = await auditRowsForRecord(recordId)
    expect(audit).toHaveLength(1)
    expect(Array.isArray(audit[0].evidence)).toBe(true)
    expect(audit[0].evidence).toHaveLength(2)
    expect(audit[0].evidence[0]).toMatchObject({ type: 'url', url: 'https://files.example.com/a.jpg' })
    expect(audit[0].evidence[1]).toMatchObject({ type: 'attachment', attachmentId: 'att-123' })
  })
})
