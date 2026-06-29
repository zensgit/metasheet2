import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { MetaSheetServer } from '../../src/index'
import * as path from 'path'
import net from 'net'
import http from 'http'
import { randomUUID } from 'crypto'
import { Pool } from 'pg'

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

function ymd(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10)
}

type ErrBody = { ok?: boolean; error?: { code?: string; message?: string }; data?: unknown }
const codeOf = (r: HttpResponse) => (r.body as ErrBody | undefined)?.error?.code
const dataOf = (r: HttpResponse) => (r.body as { data?: any } | undefined)?.data

describeDb('AE-1 attendance anomaly result edit (real DB, route-level)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  let pool: Pool
  let adminToken = ''

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
    const repoRoot = path.join(__dirname, '../../../../')
    const { MetaSheetServer } = await import('../../src/index')
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')] })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('server did not expose a TCP address')
    baseUrl = `http://127.0.0.1:${address.port}`
    pool = new Pool({ connectionString: dbUrl })
    adminToken = await mintToken(`ae1-admin-${RUN}`, 'attendance:read,attendance:write,attendance:admin,attendance:approve')

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
  })

  afterAll(async () => {
    if (pool) {
      await pool.query(`DELETE FROM attendance_record_result_edits WHERE org_id = ANY($1)`, [[ORG, ORG_OTHER]]).catch(() => undefined)
      await pool.query(`DELETE FROM attendance_records WHERE org_id = ANY($1)`, [[ORG, ORG_OTHER]]).catch(() => undefined)
      await pool.query(`DELETE FROM attendance_payroll_cycles WHERE org_id = ANY($1)`, [[ORG, ORG_OTHER]]).catch(() => undefined)
    }
    if (server && (server as unknown as { stop?: () => Promise<void> }).stop) await (server as unknown as { stop: () => Promise<void> }).stop()
    await pool?.end().catch(() => undefined)
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
    expect(audit[0].notification_delivery_id).toBeNull()
    expect(audit[0].notification_skipped_reason).toBeNull()
  })

  it('AE-1b durability: same-facts import recompute preserves the corrected result without a review flag', async () => {
    const userId = `u-durable-same-${RUN}`
    const workDate = ymd(3)
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

  it('AE-1b durability: a no-status import recompute preserves the corrected result and flags changed facts', async () => {
    const userId = `u-durable-${RUN}`
    const workDate = ymd(3)
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

    // exact replay → alreadyApplied, no 2nd row
    const replay = await postEdit({ orgId: ORG, recordId, targetStatus: 'normal', reason: 'verified offline', idempotencyKey: key })
    expect(replay.status).toBe(200)
    expect(dataOf(replay).alreadyApplied).toBe(true)
    expect(await auditByKey(ORG, key)).toHaveLength(1)
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
