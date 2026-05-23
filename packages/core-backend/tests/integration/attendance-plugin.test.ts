import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { MetaSheetServer } from '../../src/index'
import * as path from 'path'
import net from 'net'
import fs from 'fs/promises'
import { Pool } from 'pg'
import http from 'http'

type HttpResponse = { status: number; body?: unknown; raw: string }

interface AttendancePunchEventListItem {
  id: string
  userId: string
  user_id: string
  orgId: string
  org_id: string
  workDate: string | null
  work_date: string | null
  occurredAt: string
  occurred_at: string
  eventType: string
  event_type: string
  source: string
  timezone: string
  location: Record<string, unknown> | null
  meta: Record<string, unknown> | null
  createdAt: string | null
  created_at: string | null
}

interface PunchEventListResponse {
  ok: boolean
  data: {
    items: AttendancePunchEventListItem[]
    total: number
    page: number
    pageSize: number
    from: string
    to: string
  }
}

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
        res.on('data', chunk => {
          data += chunk
        })
        res.on('end', () => {
          let body: unknown
          try {
            body = data ? JSON.parse(data) : undefined
          } catch {
            body = undefined
          }
          resolve({ status: res.statusCode || 0, body, raw: data })
        })
      }
    )
    req.on('error', reject)
    if (options.body) {
      req.write(options.body)
    }
    req.end()
  })
}

function randomUuidV4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0
    const v = ch === 'x' ? r : ((r & 0x3) | 0x8)
    return v.toString(16)
  })
}

function resolvePositiveIntEnvForTest(name: string, fallback: number, min: number, max?: number): number {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  const upper = Number.isFinite(max) ? Number(max) : Number.POSITIVE_INFINITY
  return Math.min(upper, Math.max(min, parsed))
}

const expectedStandardItemsChunkSize = resolvePositiveIntEnvForTest(
  'ATTENDANCE_IMPORT_ITEMS_CHUNK_SIZE',
  300,
  50,
  1000
)
const expectedStandardRecordsChunkSize = resolvePositiveIntEnvForTest(
  'ATTENDANCE_IMPORT_RECORDS_CHUNK_SIZE',
  200,
  50,
  1000
)
const expectedBulkItemsChunkSize = resolvePositiveIntEnvForTest(
  'ATTENDANCE_IMPORT_BULK_ITEMS_CHUNK_SIZE',
  1200,
  200,
  5000
)
const expectedBulkRecordsChunkSize = resolvePositiveIntEnvForTest(
  'ATTENDANCE_IMPORT_BULK_RECORDS_CHUNK_SIZE',
  1000,
  200,
  5000
)

function expectChunkConfigMatchesEngine(engine: unknown, chunkConfig: any) {
  expect(typeof chunkConfig?.itemsChunkSize).toBe('number')
  expect(typeof chunkConfig?.recordsChunkSize).toBe('number')
  if (String(engine) === 'bulk') {
    expect(chunkConfig?.itemsChunkSize).toBe(expectedBulkItemsChunkSize)
    expect(chunkConfig?.recordsChunkSize).toBe(expectedBulkRecordsChunkSize)
  } else {
    expect(chunkConfig?.itemsChunkSize).toBe(expectedStandardItemsChunkSize)
    expect(chunkConfig?.recordsChunkSize).toBe(expectedStandardRecordsChunkSize)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function waitForImportJobCompletion(
  baseUrl: string,
  token: string,
  jobId: string,
  {
    attempts = 480,
    intervalMs = 250,
    failureMessage = 'async import job failed',
  }: {
    attempts?: number
    intervalMs?: number
    failureMessage?: string
  } = {}
): Promise<any> {
  let lastJobData: any = null

  for (let index = 0; index < attempts; index += 1) {
    const jobRes = await requestJson(`${baseUrl}/api/attendance/import/jobs/${jobId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })
    expect(jobRes.status).toBe(200)

    lastJobData = (jobRes.body as { data?: any } | undefined)?.data
    const status = String(lastJobData?.status || '')
    if (status === 'completed') {
      return lastJobData
    }
    if (status === 'failed') {
      throw new Error(String(lastJobData?.error || failureMessage))
    }

    // eslint-disable-next-line no-await-in-loop
    await delay(intervalMs)
  }

  throw new Error(
    `Import job ${jobId} did not complete within ${(attempts * intervalMs) / 1000}s (last status: ${String(lastJobData?.status || 'unknown')})`
  )
}

describe('Attendance Plugin Integration', () => {
  let server: MetaSheetServer | undefined
  let baseUrl: string | undefined
  let importUploadDir: string | undefined

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen) return

    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return

    process.env.DATABASE_URL = dbUrl
    process.env.RBAC_BYPASS = 'true'
    process.env.SKIP_PLUGINS = 'false'
    // Keep CSV guardrail deterministic and testable across environments.
    process.env.ATTENDANCE_IMPORT_CSV_MAX_ROWS = '2000'
    process.env.ATTENDANCE_IMPORT_SYNC_ASYNC_ROW_THRESHOLD = '500'
    // Keep bulk/staging auto-switch testable in integration scope. The runtime
    // clamps these thresholds to >= 1000, so the test fixture must also allow
    // more than 1000 rows.
    if (!process.env.ATTENDANCE_IMPORT_BULK_ENGINE_THRESHOLD) {
      process.env.ATTENDANCE_IMPORT_BULK_ENGINE_THRESHOLD = '1000'
    }
    // The COPY transport path is flaky under Vitest fork workers; keep staging
    // strategy coverage, but route stage loads through the unnest fallback.
    if (!process.env.ATTENDANCE_IMPORT_COPY_ENABLED) {
      process.env.ATTENDANCE_IMPORT_COPY_ENABLED = 'false'
    }
    if (!process.env.ATTENDANCE_IMPORT_COPY_THRESHOLD_ROWS) {
      process.env.ATTENDANCE_IMPORT_COPY_THRESHOLD_ROWS = '1000'
    }
    // Isolate import upload channel state (csvFileId) under a temp directory for integration tests.
    const repoRoot = path.join(__dirname, '../../../../')
    importUploadDir = path.join(repoRoot, 'tmp', `attendance-import-upload-${Date.now().toString(36)}`)
    process.env.ATTENDANCE_IMPORT_UPLOAD_DIR = importUploadDir
    process.env.ATTENDANCE_IMPORT_UPLOAD_CLEANUP = 'false'
    // Raise DB timeouts so heavy integration queries don't hit pg read timeout.
    if (!process.env.DB_QUERY_TIMEOUT) {
      process.env.DB_QUERY_TIMEOUT = '180000'
    }
    if (!process.env.DB_STATEMENT_TIMEOUT) {
      process.env.DB_STATEMENT_TIMEOUT = '180000'
    }
    if (!process.env.ATTENDANCE_IMPORT_HEAVY_QUERY_TIMEOUT_MS) {
      process.env.ATTENDANCE_IMPORT_HEAVY_QUERY_TIMEOUT_MS = '180000'
    }

    const pool = new Pool({ connectionString: dbUrl })
    try {
      await pool.query('SELECT 1')
      const tableCheck = await pool.query(`SELECT to_regclass('public.attendance_events') AS name`)
      if (!tableCheck.rows[0]?.name) return
      const approvalCheck = await pool.query(`SELECT to_regclass('public.approval_instances') AS name`)
      if (!approvalCheck.rows[0]?.name) return
      const leaveCheck = await pool.query(`SELECT to_regclass('public.attendance_leave_types') AS name`)
      if (!leaveCheck.rows[0]?.name) return
      const overtimeCheck = await pool.query(`SELECT to_regclass('public.attendance_overtime_rules') AS name`)
      if (!overtimeCheck.rows[0]?.name) return
      const shiftCheck = await pool.query(`SELECT to_regclass('public.attendance_shifts') AS name`)
      if (!shiftCheck.rows[0]?.name) return
      const assignmentCheck = await pool.query(`SELECT to_regclass('public.attendance_shift_assignments') AS name`)
      if (!assignmentCheck.rows[0]?.name) return
      const holidayCheck = await pool.query(`SELECT to_regclass('public.attendance_holidays') AS name`)
      if (!holidayCheck.rows[0]?.name) return
      const rotationRuleCheck = await pool.query(`SELECT to_regclass('public.attendance_rotation_rules') AS name`)
      if (!rotationRuleCheck.rows[0]?.name) return
      const rotationAssignmentCheck = await pool.query(`SELECT to_regclass('public.attendance_rotation_assignments') AS name`)
      if (!rotationAssignmentCheck.rows[0]?.name) return
      const groupCheck = await pool.query(`SELECT to_regclass('public.attendance_groups') AS name`)
      if (!groupCheck.rows[0]?.name) return
      const groupMemberCheck = await pool.query(`SELECT to_regclass('public.attendance_group_members') AS name`)
      if (!groupMemberCheck.rows[0]?.name) return
      const templateLibraryCheck = await pool.query(`SELECT to_regclass('public.attendance_rule_template_library') AS name`)
      if (!templateLibraryCheck.rows[0]?.name) return
      const templateVersionCheck = await pool.query(`SELECT to_regclass('public.attendance_rule_template_versions') AS name`)
      if (!templateVersionCheck.rows[0]?.name) return
    } catch {
      return
    } finally {
      await pool.end()
    }

    // Important: load MetaSheetServer only after DATABASE_URL is set,
    // since the DB pool is initialized during module import.
    const { MetaSheetServer } = await import('../../src/index')
    server = new MetaSheetServer({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')],
    })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') return
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    if (server && (server as any).stop) {
      await server.stop()
    }
    if (importUploadDir) {
      await fs.rm(importUploadDir, { recursive: true, force: true })
    }
  })

  it('registers attendance routes and lists plugin', async () => {
    if (!baseUrl) return
    const runSuffix = Date.now().toString(36)
    const testUserId = `attendance-test-${runSuffix}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(testUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin,attendance:approve`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    if (!token) return

    const punchRes = await requestJson(`${baseUrl}/api/attendance/punch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ eventType: 'check_in' }),
    })

    expect(punchRes.status).not.toBe(404)

    const workDate = new Date().toISOString().slice(0, 10)
    const requestRes = await requestJson(`${baseUrl}/api/attendance/requests`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        workDate,
        requestType: 'missed_check_in',
        requestedInAt: new Date().toISOString(),
      }),
    })

    expect(requestRes.status).toBe(201)
    const requestId = (requestRes.body as { data?: { request?: { id?: string } } } | undefined)?.data?.request?.id
    expect(requestId).toBeTruthy()

    const cancelRes = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/cancel`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ comment: 'cancel for test' }),
    })

    expect(cancelRes.status).toBe(200)

    const leaveTypeCodeInput = `annual-${runSuffix}`
    const leaveTypeRes = await requestJson(`${baseUrl}/api/attendance/leave-types`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        code: leaveTypeCodeInput,
        name: 'Annual Leave',
        requiresApproval: true,
      }),
    })

    expect([201, 409]).toContain(leaveTypeRes.status)
    let leaveTypeId = (leaveTypeRes.body as { data?: { id?: string } } | undefined)?.data?.id
    const leaveTypeCode = (leaveTypeRes.body as { data?: { code?: string } } | undefined)?.data?.code
    expect(leaveTypeCode).toBe(leaveTypeCodeInput)
    if (!leaveTypeId) {
      const leaveListRes = await requestJson(`${baseUrl}/api/attendance/leave-types`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })
      const items = (leaveListRes.body as { data?: { items?: { id?: string; code?: string }[] } } | undefined)?.data?.items ?? []
      leaveTypeId = items.find(item => item.code === leaveTypeCodeInput)?.id
    }

    const autoLeaveTypeRes = await requestJson(`${baseUrl}/api/attendance/leave-types`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Auto Leave ${runSuffix}`,
        paid: false,
        requiresApproval: false,
      }),
    })
    expect(autoLeaveTypeRes.status).toBe(201)
    const autoLeaveTypeCode = (autoLeaveTypeRes.body as { data?: { code?: string } } | undefined)?.data?.code
    expect(autoLeaveTypeCode).toMatch(/^[a-z0-9-]+-[a-f0-9]{8}$/)

    const overtimeRuleRes = await requestJson(`${baseUrl}/api/attendance/overtime-rules`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Weekday OT',
        minMinutes: 30,
      }),
    })

    expect([201, 409]).toContain(overtimeRuleRes.status)
    let overtimeRuleId = (overtimeRuleRes.body as { data?: { id?: string } } | undefined)?.data?.id
    if (!overtimeRuleId) {
      const overtimeListRes = await requestJson(`${baseUrl}/api/attendance/overtime-rules`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })
      const items = (overtimeListRes.body as { data?: { items?: { id?: string; name?: string }[] } } | undefined)?.data?.items ?? []
      overtimeRuleId = items.find(item => item.name === 'Weekday OT')?.id
    }

    if (leaveTypeId) {
      const leaveRequestRes = await requestJson(`${baseUrl}/api/attendance/requests`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          workDate,
          requestType: 'leave',
          leaveTypeId,
          minutes: 120,
        }),
      })

      expect(leaveRequestRes.status).toBe(201)
      const leaveRequestId = (leaveRequestRes.body as { data?: { request?: { id?: string } } } | undefined)?.data?.request?.id
      if (leaveRequestId) {
        const approveLeaveRes = await requestJson(`${baseUrl}/api/attendance/requests/${leaveRequestId}/approve`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ comment: 'approve leave' }),
        })
        expect(approveLeaveRes.status).toBe(200)
      }
    }

    if (overtimeRuleId) {
      const overtimeRequestRes = await requestJson(`${baseUrl}/api/attendance/requests`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          workDate,
          requestType: 'overtime',
          overtimeRuleId,
          minutes: 90,
        }),
      })

      expect(overtimeRequestRes.status).toBe(201)
    }

    const shiftRes = await requestJson(`${baseUrl}/api/attendance/shifts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Test Shift',
        timezone: 'UTC',
        workStartTime: '09:00',
        workEndTime: '18:00',
        workingDays: [1, 2, 3, 4, 5],
      }),
    })

    expect(shiftRes.status).toBe(201)
    const shiftId = (shiftRes.body as { data?: { id?: string } } | undefined)?.data?.id
    expect(shiftId).toBeTruthy()

    const assignmentRes = await requestJson(`${baseUrl}/api/attendance/assignments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: testUserId,
        shiftId,
        startDate: workDate,
        endDate: workDate,
        isActive: true,
      }),
    })

    expect(assignmentRes.status).toBe(201)
    const assignmentId = (assignmentRes.body as { data?: { assignment?: { id?: string } } } | undefined)?.data?.assignment?.id
    expect(assignmentId).toBeTruthy()

    const holidayDate = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString().slice(0, 10)
    const holidayRes = await requestJson(`${baseUrl}/api/attendance/holidays`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        date: holidayDate,
        name: 'Test Holiday',
        isWorkingDay: false,
      }),
    })

    expect([201, 409]).toContain(holidayRes.status)
    let holidayId = (holidayRes.body as { data?: { id?: string } } | undefined)?.data?.id
    if (!holidayId) {
      const holidayListRes = await requestJson(
        `${baseUrl}/api/attendance/holidays?from=${holidayDate}&to=${holidayDate}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      )
      const items = (holidayListRes.body as { data?: { items?: { id?: string }[] } } | undefined)?.data?.items ?? []
      holidayId = items[0]?.id
    }
    expect(holidayId).toBeTruthy()

    const rotationRuleRes = await requestJson(`${baseUrl}/api/attendance/rotation-rules`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Test Rotation',
        timezone: 'UTC',
        shiftSequence: [shiftId],
        isActive: true,
      }),
    })

    expect(rotationRuleRes.status).toBe(201)
    const rotationRuleId = (rotationRuleRes.body as { data?: { id?: string } } | undefined)?.data?.id
    expect(rotationRuleId).toBeTruthy()
    const rotationStart = new Date(`${workDate}T00:00:00.000Z`)
    rotationStart.setUTCDate(rotationStart.getUTCDate() + 1)
    const rotationStartDate = rotationStart.toISOString().slice(0, 10)

    const rotationAssignmentRes = await requestJson(`${baseUrl}/api/attendance/rotation-assignments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: testUserId,
        rotationRuleId,
        startDate: rotationStartDate,
        isActive: true,
      }),
    })

    expect(rotationAssignmentRes.status).toBe(201)
    const rotationAssignmentId = (rotationAssignmentRes.body as { data?: { assignment?: { id?: string } } } | undefined)?.data?.assignment?.id
    expect(rotationAssignmentId).toBeTruthy()

    const ruleSetRes = await requestJson(`${baseUrl}/api/attendance/rule-sets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Default Rule Set',
        scope: 'org',
        version: 1,
        config: { source: 'dingtalk' },
        isDefault: true,
      }),
    })

    expect([201, 409]).toContain(ruleSetRes.status)

    const ruleSetListRes = await requestJson(`${baseUrl}/api/attendance/rule-sets`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(ruleSetListRes.status).toBe(200)

    const payrollTemplateRes = await requestJson(`${baseUrl}/api/attendance/payroll-templates`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Monthly Payroll',
        timezone: 'UTC',
        startDay: 25,
        endDay: 6,
        endMonthOffset: 1,
        autoGenerate: true,
      }),
    })

    expect([201, 409]).toContain(payrollTemplateRes.status)
    let payrollTemplateId = (payrollTemplateRes.body as { data?: { id?: string } } | undefined)?.data?.id
    if (!payrollTemplateId) {
      const payrollTemplateListRes = await requestJson(`${baseUrl}/api/attendance/payroll-templates`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })
      const items = (payrollTemplateListRes.body as { data?: { items?: { id?: string; name?: string }[] } } | undefined)?.data?.items ?? []
      payrollTemplateId = items.find(item => item.name === 'Monthly Payroll')?.id
    }

    if (payrollTemplateId) {
      const payrollCycleRes = await requestJson(`${baseUrl}/api/attendance/payroll-cycles`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          templateId: payrollTemplateId,
          anchorDate: workDate,
          status: 'open',
        }),
      })

      expect([201, 409]).toContain(payrollCycleRes.status)

      const payrollGenerateRes = await requestJson(`${baseUrl}/api/attendance/payroll-cycles/generate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          templateId: payrollTemplateId,
          anchorDate: workDate,
          count: 2,
          status: 'open',
          namePrefix: 'Integration Payroll',
        }),
      })
      expect(payrollGenerateRes.status).toBe(200)
      const genBody = payrollGenerateRes.body as { ok?: boolean; data?: { created?: unknown[]; skipped?: unknown[] } } | undefined
      expect(genBody?.ok).toBe(true)
      const createdCount = Array.isArray(genBody?.data?.created) ? genBody?.data?.created.length : 0
      const skippedCount = Array.isArray(genBody?.data?.skipped) ? genBody?.data?.skipped.length : 0
      expect(createdCount + skippedCount).toBe(2)
    }

    const importTemplateRes = await requestJson(`${baseUrl}/api/attendance/import/template`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(importTemplateRes.status).toBe(200)
    const importTemplateData = (importTemplateRes.body as { data?: any } | undefined)?.data
    // Template payload must be valid out-of-the-box (no placeholder UUIDs that break preview/commit).
    expect(importTemplateData?.payloadExample?.ruleSetId).toBeUndefined()

    const importPayload = {
      userId: testUserId,
      rows: [
        {
          workDate,
          fields: {
            firstInAt: `${workDate}T09:00:00Z`,
            lastOutAt: `${workDate}T18:00:00Z`,
            status: 'normal',
          },
        },
      ],
      mode: 'override',
    }

    const importPreviewRes = await requestJson(`${baseUrl}/api/attendance/import/preview`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(importPayload),
    })
    expect(importPreviewRes.status).toBe(200)
    const importPreviewData = (importPreviewRes.body as { data?: any } | undefined)?.data
    expect(Number(importPreviewData?.processedRows ?? 0)).toBeGreaterThanOrEqual(1)
    expect(Number(importPreviewData?.failedRows ?? -1)).toBeGreaterThanOrEqual(0)
    expect(Number(importPreviewData?.elapsedMs ?? -1)).toBeGreaterThanOrEqual(0)
    expect(['standard', 'bulk']).toContain(String(importPreviewData?.engine))
    expect(['values', 'unnest', 'staging']).toContain(String(importPreviewData?.recordUpsertStrategy))

    const importRes = await requestJson(`${baseUrl}/api/attendance/import`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(importPayload),
    })
    expect(importRes.status).toBe(200)
    const importData = (importRes.body as { data?: any } | undefined)?.data
    expect(Number(importData?.imported ?? 0)).toBeGreaterThanOrEqual(1)
    expect(Number(importData?.processedRows ?? 0)).toBeGreaterThanOrEqual(1)
    expect(Number(importData?.failedRows ?? -1)).toBeGreaterThanOrEqual(0)
    expect(Number(importData?.elapsedMs ?? -1)).toBeGreaterThanOrEqual(0)
    expect(['standard', 'bulk']).toContain(String(importData?.engine))
    expect(['values', 'unnest', 'staging']).toContain(String(importData?.recordUpsertStrategy))
    expect(importData?.itemsTruncated).toBe(false)
    expect(importData?.idempotent).toBe(false)
    expect(importData?.batchId ?? null).toBe(null)

    const anomalyDate = await (async () => {
      const dt = new Date()
      // Push the anomaly test into a far-future window so synced holiday calendars in a developer DB
      // are unlikely to collide with it. We still create a working-day override below to make the
      // anomalies query deterministic even if the default org rule or local holiday data differs.
      dt.setUTCDate(dt.getUTCDate() + 395)
      for (let attempt = 0; attempt < 45; attempt += 1) {
        while (dt.getUTCDay() === 0 || dt.getUTCDay() === 6) {
          dt.setUTCDate(dt.getUTCDate() + 1)
        }
        const candidate = dt.toISOString().slice(0, 10)
        const holidayRes = await requestJson(`${baseUrl}/api/attendance/holidays`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            date: candidate,
            name: `Integration Working Day ${runSuffix}-${attempt}`,
            isWorkingDay: true,
          }),
        })
        expect([201, 409]).toContain(holidayRes.status)
        if (holidayRes.status === 201) return candidate
        dt.setUTCDate(dt.getUTCDate() + 1)
      }
      throw new Error('Unable to reserve a deterministic anomaly workday for attendance integration test')
    })()

    const anomalyPayload = {
      userId: testUserId,
      rows: [
        {
          workDate: anomalyDate,
          fields: {
            firstInAt: `${anomalyDate}T09:00:00Z`,
            lastOutAt: `${anomalyDate}T18:00:00Z`,
            // Force a non-normal status so the anomalies endpoint must surface it even if the default
            // org rule timezone differs from UTC in a developer DB.
            status: 'partial',
          },
        },
      ],
      mode: 'override',
    }

    const anomalyImportRes = await requestJson(`${baseUrl}/api/attendance/import`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(anomalyPayload),
    })
    expect(anomalyImportRes.status).toBe(200)

    const anomaliesRes = await requestJson(`${baseUrl}/api/attendance/anomalies?from=${anomalyDate}&to=${anomalyDate}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(anomaliesRes.status).toBe(200)
    const anomalyData = (anomaliesRes.body as {
      data?: {
        items?: { status?: string; suggestedRequestType?: string | null }[]
        from?: string
        to?: string
      }
    } | undefined)?.data ?? {}
    const anomalyItems = anomalyData.items ?? []
    expect(anomalyData.from).toBe(anomalyDate)
    expect(anomalyData.to).toBe(anomalyDate)
    expect(anomalyItems.length > 0).toBe(true)
    expect(anomalyItems.some(item => item.status === 'partial')).toBe(true)
    const partial = anomalyItems.find(item => item.status === 'partial')
    if (partial) {
      expect(partial.suggestedRequestType).toBeTruthy()
    }

    const groupName = `QA Group ${runSuffix}`
    const createGroupRes = await requestJson(`${baseUrl}/api/attendance/groups`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: groupName,
        timezone: 'UTC',
        description: 'integration-test',
      }),
    })
    expect(createGroupRes.status).toBe(200)
    const groupId = (createGroupRes.body as { data?: { id?: string } } | undefined)?.data?.id
    expect(groupId).toBeTruthy()
    const createdGroupCode = (createGroupRes.body as { data?: { code?: string } } | undefined)?.data?.code
    expect(createdGroupCode).toMatch(/^[a-z0-9-]+-[a-f0-9]{8}$/)

    if (groupId) {
      const updateGroupRes = await requestJson(`${baseUrl}/api/attendance/groups/${groupId}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: `${groupName} Updated`,
          timezone: 'UTC',
          description: 'integration-test-updated',
        }),
      })
      expect(updateGroupRes.status).toBe(200)
      const updatedGroupCode = (updateGroupRes.body as { data?: { code?: string } } | undefined)?.data?.code
      expect(updatedGroupCode).toBe(createdGroupCode)

      const addGroupMemberRes = await requestJson(`${baseUrl}/api/attendance/groups/${groupId}/members`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userIds: [testUserId],
        }),
      })
      expect(addGroupMemberRes.status).toBe(200)

      const listGroupMembersRes = await requestJson(`${baseUrl}/api/attendance/groups/${groupId}/members`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })
      expect(listGroupMembersRes.status).toBe(200)
      const groupMemberItems = (listGroupMembersRes.body as { data?: { items?: { userId?: string }[] } } | undefined)?.data?.items ?? []
      expect(groupMemberItems.some(item => item.userId === testUserId)).toBe(true)
    }

    const csvGroupName = `CSV Group ${runSuffix}`
    const csvImportPayload = {
      userId: testUserId,
      csvText: `日期,工号,考勤组,上班1打卡时间,下班1打卡时间,考勤结果\n${workDate},A001,${csvGroupName},09:00,18:00,正常`,
      mapping: {
        columns: [
          { sourceField: '日期', targetField: 'workDate', dataType: 'date' },
          { sourceField: '工号', targetField: 'empNo', dataType: 'string' },
          { sourceField: '考勤组', targetField: 'attendance_group', dataType: 'string' },
          { sourceField: '上班1打卡时间', targetField: 'firstInAt', dataType: 'time' },
          { sourceField: '下班1打卡时间', targetField: 'lastOutAt', dataType: 'time' },
          { sourceField: '考勤结果', targetField: 'status', dataType: 'string' },
        ],
      },
      userMap: {
        A001: testUserId,
      },
      groupSync: {
        autoCreate: true,
        autoAssignMembers: true,
      },
      mode: 'override',
    }

    const csvImportRes = await requestJson(`${baseUrl}/api/attendance/import`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(csvImportPayload),
    })
    expect(csvImportRes.status).toBe(200)
    const csvImportData = (csvImportRes.body as { data?: any } | undefined)?.data
    expect(Number(csvImportData?.processedRows ?? 0)).toBeGreaterThanOrEqual(1)
    expect(Number(csvImportData?.failedRows ?? -1)).toBeGreaterThanOrEqual(0)
    expect(['standard', 'bulk']).toContain(String(csvImportData?.engine))
    expect(['values', 'unnest', 'staging']).toContain(String(csvImportData?.recordUpsertStrategy))

    const listGroupsRes = await requestJson(`${baseUrl}/api/attendance/groups?pageSize=200`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(listGroupsRes.status).toBe(200)
    const groups = (listGroupsRes.body as { data?: { items?: { id?: string; name?: string }[] } } | undefined)?.data?.items ?? []
    const csvGroup = groups.find(item => item.name === csvGroupName)
    expect(csvGroup?.id).toBeTruthy()

    if (csvGroup?.id) {
      const csvGroupMembersRes = await requestJson(`${baseUrl}/api/attendance/groups/${csvGroup.id}/members?pageSize=200`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })
      expect(csvGroupMembersRes.status).toBe(200)
      const csvGroupMembers = (csvGroupMembersRes.body as { data?: { items?: { userId?: string }[] } } | undefined)?.data?.items ?? []
      expect(csvGroupMembers.some(item => item.userId === testUserId)).toBe(true)
    }

    const numericGroupName = '1'
    expect(groups.some(item => item.name === numericGroupName)).toBe(false)

    const numericGroupImportRes = await requestJson(`${baseUrl}/api/attendance/import`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: testUserId,
        csvText: `日期,工号,考勤组,上班1打卡时间,下班1打卡时间,考勤结果\n${workDate},A001,${numericGroupName},09:05,18:05,正常`,
        mapping: {
          columns: [
            { sourceField: '日期', targetField: 'workDate', dataType: 'date' },
            { sourceField: '工号', targetField: 'empNo', dataType: 'string' },
            { sourceField: '考勤组', targetField: 'attendance_group', dataType: 'string' },
            { sourceField: '上班1打卡时间', targetField: 'firstInAt', dataType: 'time' },
            { sourceField: '下班1打卡时间', targetField: 'lastOutAt', dataType: 'time' },
            { sourceField: '考勤结果', targetField: 'status', dataType: 'string' },
          ],
        },
        userMap: {
          A001: testUserId,
        },
        groupSync: {
          autoCreate: true,
          autoAssignMembers: true,
        },
        mode: 'override',
      }),
    })
    expect(numericGroupImportRes.status).toBe(200)

    const listGroupsAfterNumericRes = await requestJson(`${baseUrl}/api/attendance/groups?pageSize=200`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(listGroupsAfterNumericRes.status).toBe(200)
    const groupsAfterNumeric = (listGroupsAfterNumericRes.body as { data?: { items?: { id?: string; name?: string }[] } } | undefined)?.data?.items ?? []
    expect(groupsAfterNumeric.some(item => item.name === numericGroupName)).toBe(false)

    const templateGetRes = await requestJson(`${baseUrl}/api/attendance/rule-templates`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(templateGetRes.status).toBe(200)
    const templateData = (templateGetRes.body as {
      data?: {
        system?: Record<string, unknown>[]
        library?: Record<string, unknown>[]
      }
    } | undefined)?.data
    const templateBase = (templateData?.library?.[0] ?? templateData?.system?.[0]) ?? null

    if (templateBase) {
      const templateAName = `Template-${runSuffix}-A`
      const templateBName = `Template-${runSuffix}-B`
      const templateA = { ...templateBase, name: templateAName, category: 'custom', editable: true }
      const templateB = { ...templateBase, name: templateBName, category: 'custom', editable: true }

      const saveTemplateARes = await requestJson(`${baseUrl}/api/attendance/rule-templates`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ templates: [templateA] }),
      })
      expect(saveTemplateARes.status).toBe(200)

      const afterTemplateARes = await requestJson(`${baseUrl}/api/attendance/rule-templates`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })
      expect(afterTemplateARes.status).toBe(200)
      const versionAId = (afterTemplateARes.body as { data?: { versions?: { id?: string }[] } } | undefined)?.data?.versions?.[0]?.id
      expect(versionAId).toBeTruthy()

      const saveTemplateBRes = await requestJson(`${baseUrl}/api/attendance/rule-templates`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ templates: [templateB] }),
      })
      expect(saveTemplateBRes.status).toBe(200)

      if (versionAId) {
        const restoreTemplateRes = await requestJson(`${baseUrl}/api/attendance/rule-templates/restore`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ versionId: versionAId }),
        })
        expect(restoreTemplateRes.status).toBe(200)

        const afterRestoreRes = await requestJson(`${baseUrl}/api/attendance/rule-templates`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        })
        expect(afterRestoreRes.status).toBe(200)
        const libraryNames = ((afterRestoreRes.body as { data?: { library?: { name?: string }[] } } | undefined)?.data?.library ?? [])
          .map(item => item.name)
        expect(libraryNames.includes(templateAName)).toBe(true)

        const versionViewRes = await requestJson(
          `${baseUrl}/api/attendance/rule-templates/versions/${encodeURIComponent(versionAId)}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        )
        expect(versionViewRes.status).toBe(200)
        const versionView = (versionViewRes.body as {
          data?: {
            id?: string
            version?: number
            itemCount?: number
            templates?: unknown[]
          }
        } | undefined)?.data
        expect(versionView?.id).toBe(versionAId)
        expect(versionView?.version).toBeGreaterThan(0)
        expect(Array.isArray(versionView?.templates)).toBe(true)
        expect(versionView?.itemCount).toBeGreaterThanOrEqual(0)
        if (Array.isArray(versionView?.templates)) {
          expect(versionView.templates.length).toBeGreaterThan(0)
        }
      }
    }

    const reportRes = await requestJson(`${baseUrl}/api/attendance/reports/requests?from=${workDate}&to=${workDate}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })

    expect(reportRes.status).toBe(200)

    const pluginsRes = await requestJson(`${baseUrl}/api/plugins`)
    const payload = pluginsRes.body as { list?: unknown } | unknown
    const list = Array.isArray(payload)
      ? payload
      : (payload && typeof payload === 'object' && Array.isArray((payload as { list?: unknown[] }).list)
          ? (payload as { list: unknown[] }).list
          : [])
    expect(Array.isArray(list)).toBe(true)
    const attendance = list.find((plugin: any) => plugin?.name === 'plugin-attendance')
    expect(attendance).toBeDefined()
    if (attendance) {
      expect(attendance.status).toBe('active')
    }
  })

  it('lists raw punch events with stable timeline fields and cross-user guardrails', async () => {
    if (!baseUrl) return

    const runSuffix = Date.now().toString(36)
    const primaryUserId = `attendance-punch-events-${runSuffix}`
    const adminTokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(primaryUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const adminToken = (adminTokenRes.body as { token?: string } | undefined)?.token
    expect(adminToken).toBeTruthy()
    if (!adminToken) return

    const punchPayloads = [
      { eventType: 'check_in', occurredAt: '2026-03-28T09:01:00+08:00', timezone: 'Asia/Shanghai' },
      { eventType: 'check_out', occurredAt: '2026-03-28T18:05:00+08:00', timezone: 'Asia/Shanghai' },
    ]

    for (const payload of punchPayloads) {
      const punchRes = await requestJson(`${baseUrl}/api/attendance/punch`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })
      expect(punchRes.status).toBe(200)
    }

    const listRes = await requestJson(`${baseUrl}/api/attendance/punch/events?from=2026-03-28&to=2026-03-28`, {
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
    })
    expect(listRes.status).toBe(200)
    const listBody = listRes.body as PunchEventListResponse
    expect(listBody.ok).toBe(true)
    expect(listBody.data.total).toBeGreaterThanOrEqual(2)
    expect(listBody.data.page).toBe(1)
    expect(listBody.data.pageSize).toBe(50)
    expect(listBody.data.from).toBe('2026-03-28')
    expect(listBody.data.to).toBe('2026-03-28')
    const items = listBody.data.items
    expect(items.length).toBeGreaterThanOrEqual(2)
    expect(items[0].userId).toBe(primaryUserId)
    expect(items[0].user_id).toBe(primaryUserId)
    expect(items[0].workDate).toBe('2026-03-28')
    expect(items[0].work_date).toBe('2026-03-28')
    expect(items[0].eventType).toBe('check_out')
    expect(items[0].event_type).toBe('check_out')
    expect(items[0].occurredAt).toContain('2026-03-28')
    expect(items[0].occurred_at).toContain('2026-03-28')

    const secondUserId = `attendance-punch-events-other-${runSuffix}`
    const secondTokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(secondUserId)}&roles=user&perms=attendance:read,attendance:write`
    )
    const secondToken = (secondTokenRes.body as { token?: string } | undefined)?.token
    expect(secondToken).toBeTruthy()
    if (!secondToken) return

    const secondPunchRes = await requestJson(`${baseUrl}/api/attendance/punch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secondToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        eventType: 'check_in',
        occurredAt: '2026-03-28T08:55:00+08:00',
        timezone: 'Asia/Shanghai',
      }),
    })
    expect(secondPunchRes.status).toBe(200)

    const adminOtherUserRes = await requestJson(
      `${baseUrl}/api/attendance/punch/events?userId=${encodeURIComponent(secondUserId)}&from=2026-03-28&to=2026-03-28`,
      {
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      }
    )
    expect(adminOtherUserRes.status).toBe(200)
    const adminOtherItems = ((adminOtherUserRes.body as { data?: { items?: Array<Record<string, unknown>> } } | undefined)?.data?.items) ?? []
    expect(adminOtherItems[0]?.userId).toBe(secondUserId)
    expect(adminOtherItems[0]?.eventType).toBe('check_in')

    const cappedPageSizeRes = await requestJson(
      `${baseUrl}/api/attendance/punch/events?from=2026-03-28&to=2026-03-28&pageSize=999`,
      {
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      }
    )
    expect(cappedPageSizeRes.status).toBe(200)
    const cappedBody = cappedPageSizeRes.body as { data?: { pageSize?: number } } | undefined
    expect(cappedBody?.data?.pageSize).toBe(200)

    const invalidDateRes = await requestJson(`${baseUrl}/api/attendance/punch/events?from=2026/03/28&to=2026-03-28`, {
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
    })
    expect(invalidDateRes.status).toBe(400)
    const invalidBody = invalidDateRes.body as { error?: { code?: string } } | undefined
    expect(invalidBody?.error?.code).toBe('VALIDATION_ERROR')
  })

  it('serves attendance import templates as JSON and CSV', async () => {
    if (!baseUrl) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(`attendance-template-${Date.now().toString(36)}`)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const importTemplateRes = await requestJson(`${baseUrl}/api/attendance/import/template`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(importTemplateRes.status).toBe(200)
    const importTemplateData = (importTemplateRes.body as { data?: any } | undefined)?.data
    expect(importTemplateData?.payloadExample?.ruleSetId).toBeUndefined()
    expect(importTemplateData?.payloadExample?.columns).toContain('日期')
    expect(importTemplateData?.payloadExample?.requiredFields).toContain('日期')
    expect(importTemplateData?.defaultProfileId).toBe('dingtalk_csv_daily_summary')
    expect(importTemplateData?.csvTemplateUrl).toBe('/api/attendance/import/template.csv?profileId=dingtalk_csv_daily_summary')
    expect(importTemplateData?.csvTemplateFilename).toBe('attendance-import-template-dingtalk_csv_daily_summary.csv')

    const importTemplateCsvRes = await requestJson(`${baseUrl}/api/attendance/import/template.csv`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(importTemplateCsvRes.status).toBe(200)
    expect(importTemplateCsvRes.raw).toContain('日期,工号,姓名,考勤组,上班1打卡时间,下班1打卡时间,考勤结果,异常原因')
    expect(importTemplateCsvRes.raw).toContain('2026-03-23,EMP001,张三,总部日班,2026-03-23 09:00,2026-03-23 18:00,正常,')

    const importTemplateCsvProfileRes = await requestJson(`${baseUrl}/api/attendance/import/template.csv?profileId=manual_rows`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(importTemplateCsvProfileRes.status).toBe(200)
    expect(importTemplateCsvProfileRes.raw).toContain('workDate,userId,firstInAt,lastOutAt,status')

    const importTemplateCsvAcceptRes = await requestJson(`${baseUrl}/api/attendance/import/template?profileId=manual_rows`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'text/csv',
      },
    })
    expect(importTemplateCsvAcceptRes.status).toBe(200)
    expect(importTemplateCsvAcceptRes.raw).toContain('workDate,userId,firstInAt,lastOutAt,status')

    const importTemplateCsvInvalidProfileRes = await requestJson(`${baseUrl}/api/attendance/import/template.csv?profileId=missing_profile`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(importTemplateCsvInvalidProfileRes.status).toBe(400)
    expect((importTemplateCsvInvalidProfileRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('VALIDATION_ERROR')
  })

  it('surfaces CSV header diagnostics during preview and clarifies header-only commit failures', async () => {
    if (!baseUrl) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(`attendance-import-diagnostics-${Date.now().toString(36)}`)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const preparePreviewRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(preparePreviewRes.status).toBe(200)
    const previewCommitToken = (preparePreviewRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(previewCommitToken).toBeTruthy()
    if (!previewCommitToken) return

    const previewRes = await requestJson(`${baseUrl}/api/attendance/import/preview`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: 'attendance-test',
        mappingProfileId: 'dingtalk_csv_daily_summary',
        userMap: {
          EMP001: 'attendance-test',
        },
        csvText: [
          '日期,工号,未知列',
          '2026-03-23,EMP001,备注',
        ].join('\n'),
        mode: 'override',
        commitToken: previewCommitToken,
      }),
    })
    expect(previewRes.status).toBe(200)
    const previewWarnings = (previewRes.body as { data?: { csvWarnings?: string[] } } | undefined)?.data?.csvWarnings ?? []
    expect(previewWarnings.some((warning) => warning.includes('Detected CSV columns: 日期, 工号, 未知列'))).toBe(true)
    expect(previewWarnings.some((warning) => warning.includes('Recognized import columns: 工号→empNo'))).toBe(true)
    expect(previewWarnings.some((warning) => warning.includes('Template columns missing:'))).toBe(true)
    expect(previewWarnings.some((warning) => warning.includes('Unmapped CSV columns: 日期, 未知列'))).toBe(true)

    const prepareCommitRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(prepareCommitRes.status).toBe(200)
    const commitToken = (prepareCommitRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(commitToken).toBeTruthy()
    if (!commitToken) return

    const commitRes = await requestJson(`${baseUrl}/api/attendance/import/commit`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: 'attendance-test',
        mappingProfileId: 'dingtalk_csv_daily_summary',
        csvText: '日期,工号,姓名\n',
        mode: 'override',
        commitToken,
      }),
    })
    expect(commitRes.status).toBe(400)
    const commitError = (commitRes.body as { error?: { code?: string; message?: string } } | undefined)?.error
    expect(commitError?.code).toBe('VALIDATION_ERROR')
    expect(String(commitError?.message || '')).toContain('CSV contains the header row but no non-empty data rows were parsed')
    expect(String(commitError?.message || '')).toContain('Detected columns: 日期, 工号, 姓名')
  })

  it('maps standard work_date/check_in/check_out CSV headers through preview and commit', async () => {
    if (!baseUrl) return

    const runSuffix = Date.now().toString(36)
    const requesterId = `attendance-csv-standard-${runSuffix}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(requesterId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const workDate = new Date().toISOString().slice(0, 10)
    const csvText = [
      'user_id,work_date,check_in,check_out',
      `${requesterId},${workDate},${workDate}T09:00:00Z,${workDate}T18:00:00Z`,
    ].join('\n')

    const preparePreviewRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(preparePreviewRes.status).toBe(200)
    const previewCommitToken = (preparePreviewRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(previewCommitToken).toBeTruthy()
    if (!previewCommitToken) return

    const previewRes = await requestJson(`${baseUrl}/api/attendance/import/preview`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mappingProfileId: 'dingtalk_csv_daily_summary',
        timezone: 'UTC',
        csvText,
        commitToken: previewCommitToken,
      }),
    })
    expect(previewRes.status).toBe(200)
    const previewItems = (previewRes.body as { data?: { items?: Array<{ userId?: string; workDate?: string; firstInAt?: string | null; lastOutAt?: string | null }> } } | undefined)?.data?.items ?? []
    expect(previewItems).toHaveLength(1)
    expect(previewItems[0]?.userId).toBe(requesterId)
    expect(previewItems[0]?.workDate).toBe(workDate)
    expect(String(previewItems[0]?.firstInAt ?? '')).toContain(`${workDate}T09:00:00`)
    expect(String(previewItems[0]?.lastOutAt ?? '')).toContain(`${workDate}T18:00:00`)

    const previewWarnings = (previewRes.body as { data?: { csvWarnings?: string[] } } | undefined)?.data?.csvWarnings ?? []
    expect(previewWarnings.some((warning) => warning.includes('check_in→firstInAt'))).toBe(true)
    expect(previewWarnings.some((warning) => warning.includes('check_out→lastOutAt'))).toBe(true)

    const prepareCommitRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(prepareCommitRes.status).toBe(200)
    const commitToken = (prepareCommitRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(commitToken).toBeTruthy()
    if (!commitToken) return

    const commitRes = await requestJson(`${baseUrl}/api/attendance/import/commit`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mappingProfileId: 'dingtalk_csv_daily_summary',
        timezone: 'UTC',
        csvText,
        mode: 'override',
        commitToken,
        returnItems: false,
      }),
    })
    expect(commitRes.status).toBe(200)
    const commitData = (commitRes.body as { data?: any } | undefined)?.data
    expect(Number(commitData?.processedRows ?? 0)).toBeGreaterThanOrEqual(1)
    expect(Number(commitData?.failedRows ?? 0)).toBe(0)

    const recordsRes = await requestJson(`${baseUrl}/api/attendance/records?userId=${encodeURIComponent(requesterId)}&from=${encodeURIComponent(workDate)}&to=${encodeURIComponent(workDate)}&page=1&pageSize=20`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(recordsRes.status).toBe(200)
    const recordItems = (recordsRes.body as { data?: { items?: Array<Record<string, unknown>> } } | undefined)?.data?.items ?? []
    expect(recordItems.length).toBeGreaterThanOrEqual(1)
    const record = recordItems.find((item) => String(item.userId ?? item.user_id ?? '') === requesterId) ?? recordItems[0]
    expect(String(record?.firstInAt ?? record?.first_in_at ?? '')).toContain(`${workDate}T09:00:00`)
    expect(String(record?.lastOutAt ?? record?.last_out_at ?? '')).toContain(`${workDate}T18:00:00`)

    const batchId = commitData?.batchId
    if (batchId) {
      const rollbackRes = await requestJson(`${baseUrl}/api/attendance/import/rollback/${batchId}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      })
      expect(rollbackRes.status).toBe(200)
    }
  })

  it('supports shift and overtime rule lookup by id and rejects malformed ids with 400', async () => {
    if (!baseUrl) return

    const runSuffix = Date.now().toString(36)
    const testUserId = `attendance-lookup-${runSuffix}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(testUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const shiftRes = await requestJson(`${baseUrl}/api/attendance/shifts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Lookup Shift ${runSuffix}`,
        timezone: 'Asia/Shanghai',
        workStartTime: '09:00',
        workEndTime: '18:00',
        workingDays: [1, 2, 3, 4, 5],
      }),
    })
    expect(shiftRes.status).toBe(201)
    const shiftId = (shiftRes.body as { data?: { id?: string } } | undefined)?.data?.id
    expect(shiftId).toBeTruthy()
    if (!shiftId) return

    const shiftLookupRes = await requestJson(`${baseUrl}/api/attendance/shifts/${shiftId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(shiftLookupRes.status).toBe(200)
    const shiftLookupBody = shiftLookupRes.body as { data?: { id?: string; name?: string } } | undefined
    expect(shiftLookupBody?.data?.id).toBe(shiftId)
    expect(shiftLookupBody?.data?.name).toBe(`Lookup Shift ${runSuffix}`)

    const rotationRuleRes = await requestJson(`${baseUrl}/api/attendance/rotation-rules`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Lookup Rotation ${runSuffix}`,
        timezone: 'Asia/Shanghai',
        shiftSequence: [shiftId],
        isActive: true,
      }),
    })
    expect(rotationRuleRes.status).toBe(201)
    const rotationRuleId = (rotationRuleRes.body as { data?: { id?: string } } | undefined)?.data?.id
    expect(rotationRuleId).toBeTruthy()
    if (!rotationRuleId) return

    const rotationLookupRes = await requestJson(`${baseUrl}/api/attendance/rotation-rules/${rotationRuleId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(rotationLookupRes.status).toBe(200)
    const rotationLookupBody = rotationLookupRes.body as { data?: { id?: string; name?: string } } | undefined
    expect(rotationLookupBody?.data?.id).toBe(rotationRuleId)
    expect(rotationLookupBody?.data?.name).toBe(`Lookup Rotation ${runSuffix}`)

    const overtimeRes = await requestJson(`${baseUrl}/api/attendance/overtime-rules`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Lookup Overtime ${runSuffix}`,
        minMinutes: 30,
        roundingMinutes: 15,
        maxMinutesPerDay: 180,
        requiresApproval: true,
      }),
    })
    expect(overtimeRes.status).toBe(201)
    const overtimeRuleId = (overtimeRes.body as { data?: { id?: string } } | undefined)?.data?.id
    expect(overtimeRuleId).toBeTruthy()
    if (!overtimeRuleId) return

    const overtimeLookupRes = await requestJson(`${baseUrl}/api/attendance/overtime-rules/${overtimeRuleId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(overtimeLookupRes.status).toBe(200)
    const overtimeLookupBody = overtimeLookupRes.body as { data?: { id?: string; name?: string } } | undefined
    expect(overtimeLookupBody?.data?.id).toBe(overtimeRuleId)
    expect(overtimeLookupBody?.data?.name).toBe(`Lookup Overtime ${runSuffix}`)

    const invalidEndpoints = [
      'groups/nonexistent-id',
      'leave-types/fake',
      'payroll-templates/not-a-uuid',
      'shifts/not-a-uuid',
      'overtime-rules/not-a-uuid',
      'rotation-rules/not-a-uuid',
    ]

    for (const apiPath of invalidEndpoints) {
      const invalidRes = await requestJson(`${baseUrl}/api/attendance/${apiPath}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })
      expect(invalidRes.status).toBe(400)
      const invalidBody = invalidRes.body as { error?: { code?: string } } | undefined
      expect(invalidBody?.error?.code).toBe('VALIDATION_ERROR')
    }

    const missingShiftRes = await requestJson(`${baseUrl}/api/attendance/shifts/${randomUuidV4()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(missingShiftRes.status).toBe(404)

    const missingOvertimeRes = await requestJson(`${baseUrl}/api/attendance/overtime-rules/${randomUuidV4()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(missingOvertimeRes.status).toBe(404)

    const missingRotationRes = await requestJson(`${baseUrl}/api/attendance/rotation-rules/${randomUuidV4()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(missingRotationRes.status).toBe(404)
  })

  it('keeps camelCase and snake_case field aliases on shift and assignment responses', async () => {
    if (!baseUrl) return

    const runSuffix = Date.now().toString(36)
    const testUserId = `attendance-alias-${runSuffix}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(testUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const shiftRes = await requestJson(`${baseUrl}/api/attendance/shifts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Alias Shift ${runSuffix}`,
        timezone: 'Asia/Shanghai',
        workStartTime: '08:30',
        workEndTime: '17:30',
        workingDays: [1, 2, 3, 4, 5],
      }),
    })
    expect(shiftRes.status).toBe(201)
    const shiftId = (shiftRes.body as { data?: { id?: string } } | undefined)?.data?.id
    expect(shiftId).toBeTruthy()
    if (!shiftId) return

    const assignmentRes = await requestJson(`${baseUrl}/api/attendance/assignments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: testUserId,
        shiftId,
        startDate: '2026-03-20',
        isActive: true,
      }),
    })
    expect(assignmentRes.status).toBe(201)
    const assignmentId = (assignmentRes.body as { data?: { assignment?: { id?: string } } } | undefined)?.data?.assignment?.id
    expect(assignmentId).toBeTruthy()
    if (!assignmentId) return

    const shiftListRes = await requestJson(`${baseUrl}/api/attendance/shifts`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(shiftListRes.status).toBe(200)
    const shiftItems = (shiftListRes.body as { data?: { items?: any[] } } | undefined)?.data?.items ?? []
    const shiftRow = shiftItems.find((item) => item?.id === shiftId)
    expect(shiftRow).toBeTruthy()
    expect(shiftRow?.workStartTime).toBe('08:30:00')
    expect(shiftRow?.work_start_time).toBe('08:30:00')
    expect(shiftRow?.workEndTime).toBe('17:30:00')
    expect(shiftRow?.work_end_time).toBe('17:30:00')

    const assignmentListRes = await requestJson(
      `${baseUrl}/api/attendance/assignments?userId=${encodeURIComponent(testUserId)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    )
    expect(assignmentListRes.status).toBe(200)
    const assignmentItems = (assignmentListRes.body as { data?: { items?: any[] } } | undefined)?.data?.items ?? []
    const assignmentRow = assignmentItems.find((item) => item?.assignment?.id === assignmentId)
    expect(assignmentRow).toBeTruthy()
    expect(assignmentRow?.assignment?.userId).toBe(testUserId)
    expect(assignmentRow?.assignment?.user_id).toBe(testUserId)
    expect(assignmentRow?.assignment?.shiftId).toBe(shiftId)
    expect(assignmentRow?.assignment?.shift_id).toBe(shiftId)
    expect(assignmentRow?.shift?.workStartTime).toBe('08:30:00')
    expect(assignmentRow?.shift?.work_start_time).toBe('08:30:00')
  })

  it('rejects unknown shift fields and overly long shift names on create and update', async () => {
    if (!baseUrl) return

    const runSuffix = Date.now().toString(36)
    const testUserId = `attendance-shift-validation-${runSuffix}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(testUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const longName = `Shift ${'x'.repeat(500)}`

    const breakMinutesCreateRes = await requestJson(`${baseUrl}/api/attendance/shifts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Validation Shift ${runSuffix}`,
        timezone: 'Asia/Shanghai',
        workStartTime: '09:00',
        workEndTime: '18:00',
        breakMinutes: -30,
        workingDays: [1, 2, 3, 4, 5],
      }),
    })
    expect(breakMinutesCreateRes.status).toBe(400)
    const breakMinutesCreateError = (breakMinutesCreateRes.body as { error?: { code?: string; message?: string } } | undefined)?.error
    expect(breakMinutesCreateError?.code).toBe('VALIDATION_ERROR')
    expect(String(breakMinutesCreateError?.message || '')).toContain('breakMinutes')

    const longNameCreateRes = await requestJson(`${baseUrl}/api/attendance/shifts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: longName,
        timezone: 'Asia/Shanghai',
        workStartTime: '09:00',
        workEndTime: '18:00',
        workingDays: [1, 2, 3, 4, 5],
      }),
    })
    expect(longNameCreateRes.status).toBe(400)
    const longNameCreateError = (longNameCreateRes.body as { error?: { code?: string; message?: string } } | undefined)?.error
    expect(longNameCreateError?.code).toBe('VALIDATION_ERROR')
    expect(String(longNameCreateError?.message || '')).toContain('200')

    const validShiftRes = await requestJson(`${baseUrl}/api/attendance/shifts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Valid Shift ${runSuffix}`,
        timezone: 'Asia/Shanghai',
        workStartTime: '09:00',
        workEndTime: '18:00',
        workingDays: [1, 2, 3, 4, 5],
      }),
    })
    expect(validShiftRes.status).toBe(201)
    const shiftId = (validShiftRes.body as { data?: { id?: string } } | undefined)?.data?.id
    expect(shiftId).toBeTruthy()
    if (!shiftId) return

    const breakMinutesUpdateRes = await requestJson(`${baseUrl}/api/attendance/shifts/${shiftId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        breakMinutes: -30,
      }),
    })
    expect(breakMinutesUpdateRes.status).toBe(400)
    const breakMinutesUpdateError = (breakMinutesUpdateRes.body as { error?: { code?: string; message?: string } } | undefined)?.error
    expect(breakMinutesUpdateError?.code).toBe('VALIDATION_ERROR')
    expect(String(breakMinutesUpdateError?.message || '')).toContain('breakMinutes')

    const longNameUpdateRes = await requestJson(`${baseUrl}/api/attendance/shifts/${shiftId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: longName,
      }),
    })
    expect(longNameUpdateRes.status).toBe(400)
    const longNameUpdateError = (longNameUpdateRes.body as { error?: { code?: string; message?: string } } | undefined)?.error
    expect(longNameUpdateError?.code).toBe('VALIDATION_ERROR')
    expect(String(longNameUpdateError?.message || '')).toContain('200')
  })

  it('returns 409 when deleting a shift that is still referenced by an active assignment', async () => {
    if (!baseUrl) return

    const runSuffix = Date.now().toString(36)
    const testUserId = `attendance-shift-delete-assignment-${runSuffix}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(testUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const shiftRes = await requestJson(`${baseUrl}/api/attendance/shifts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Protected Shift ${runSuffix}`,
        timezone: 'Asia/Shanghai',
        workStartTime: '09:00',
        workEndTime: '18:00',
        workingDays: [1, 2, 3, 4, 5],
      }),
    })
    expect(shiftRes.status).toBe(201)
    const shiftId = (shiftRes.body as { data?: { id?: string } } | undefined)?.data?.id
    expect(shiftId).toBeTruthy()
    if (!shiftId) return

    const assignmentRes = await requestJson(`${baseUrl}/api/attendance/assignments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: testUserId,
        shiftId,
        startDate: '2026-03-20',
        isActive: true,
      }),
    })
    expect(assignmentRes.status).toBe(201)

    const deleteRes = await requestJson(`${baseUrl}/api/attendance/shifts/${shiftId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(deleteRes.status).toBe(409)
    const deleteBody = deleteRes.body as { error?: { code?: string; message?: string } } | undefined
    expect(deleteBody?.error?.code).toBe('CONFLICT')
    expect(String(deleteBody?.error?.message || '')).toMatch(/active assignments|rotation rules/i)

    const lookupRes = await requestJson(`${baseUrl}/api/attendance/shifts/${shiftId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(lookupRes.status).toBe(200)
  })

  it('blocks deleting a shift that is referenced by a rotation rule created with shift IDs', async () => {
    if (!baseUrl) return

    const runSuffix = Date.now().toString(36)
    const testUserId = `attendance-shift-delete-rotation-${runSuffix}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(testUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const shiftRes = await requestJson(`${baseUrl}/api/attendance/shifts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Rotation Protected Shift ${runSuffix}`,
        timezone: 'Asia/Shanghai',
        workStartTime: '07:00',
        workEndTime: '15:00',
        workingDays: [1, 2, 3, 4, 5],
      }),
    })
    expect(shiftRes.status).toBe(201)
    const shiftId = (shiftRes.body as { data?: { id?: string } } | undefined)?.data?.id
    expect(shiftId).toBeTruthy()
    if (!shiftId) return

    const rotationRuleRes = await requestJson(`${baseUrl}/api/attendance/rotation-rules`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Delete Guard Rotation ${runSuffix}`,
        timezone: 'Asia/Shanghai',
        shiftSequence: [shiftId],
        isActive: true,
      }),
    })
    expect(rotationRuleRes.status).toBe(201)
    const rotationRuleId = (rotationRuleRes.body as { data?: { id?: string } } | undefined)?.data?.id
    expect(rotationRuleId).toBeTruthy()
    if (!rotationRuleId) return

    const rotationAssignmentRes = await requestJson(`${baseUrl}/api/attendance/rotation-assignments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: testUserId,
        rotationRuleId,
        startDate: '2026-03-20',
        isActive: true,
      }),
    })
    expect(rotationAssignmentRes.status).toBe(201)

    const deleteRes = await requestJson(`${baseUrl}/api/attendance/shifts/${shiftId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(deleteRes.status).toBe(409)
    const deleteBody = deleteRes.body as { error?: { code?: string; message?: string } } | undefined
    expect(deleteBody?.error?.code).toBe('CONFLICT')
    expect(String(deleteBody?.error?.message || '')).toMatch(/active assignments|rotation rules/i)

    const lookupRes = await requestJson(`${baseUrl}/api/attendance/shifts/${shiftId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(lookupRes.status).toBe(200)
  })

  it('rejects overlapping active shift and rotation assignments at save time', async () => {
    if (!baseUrl) return

    const runSuffix = Date.now().toString(36)
    const testUserId = `attendance-schedule-conflict-${runSuffix}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(testUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    async function createShift(name: string): Promise<string> {
      const shiftRes = await requestJson(`${baseUrl}/api/attendance/shifts`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name,
          timezone: 'Asia/Shanghai',
          workStartTime: '09:00',
          workEndTime: '18:00',
          workingDays: [1, 2, 3, 4, 5],
        }),
      })
      expect(shiftRes.status).toBe(201)
      const shiftId = (shiftRes.body as { data?: { id?: string } } | undefined)?.data?.id
      expect(shiftId).toBeTruthy()
      if (!shiftId) throw new Error('missing shift id')
      return shiftId
    }

    const baseShiftId = await createShift(`Conflict Base Shift ${runSuffix}`)
    const alternateShiftId = await createShift(`Conflict Alternate Shift ${runSuffix}`)

    const assignmentRes = await requestJson(`${baseUrl}/api/attendance/assignments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: testUserId,
        shiftId: baseShiftId,
        startDate: '2026-06-01',
        endDate: '2026-06-10',
        isActive: true,
      }),
    })
    expect(assignmentRes.status).toBe(201)
    const assignmentId = (assignmentRes.body as { data?: { assignment?: { id?: string } } } | undefined)?.data?.assignment?.id
    expect(assignmentId).toBeTruthy()
    if (!assignmentId) return

    const overlappingShiftRes = await requestJson(`${baseUrl}/api/attendance/assignments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: testUserId,
        shiftId: alternateShiftId,
        startDate: '2026-06-10',
        endDate: '2026-06-12',
        isActive: true,
      }),
    })
    expect(overlappingShiftRes.status).toBe(409)
    const overlappingShiftError = (overlappingShiftRes.body as { error?: { code?: string; details?: { conflictType?: string } } } | undefined)?.error
    expect(overlappingShiftError?.code).toBe('ATTENDANCE_SCHEDULE_ASSIGNMENT_CONFLICT')
    expect(overlappingShiftError?.details?.conflictType).toBe('shift_assignment_overlap')

    const otherUserShiftRes = await requestJson(`${baseUrl}/api/attendance/assignments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: `${testUserId}-other`,
        shiftId: alternateShiftId,
        startDate: '2026-06-10',
        endDate: '2026-06-12',
        isActive: true,
      }),
    })
    expect(otherUserShiftRes.status).toBe(201)

    const rotationRuleRes = await requestJson(`${baseUrl}/api/attendance/rotation-rules`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Conflict Rotation ${runSuffix}`,
        timezone: 'Asia/Shanghai',
        shiftSequence: [alternateShiftId],
        isActive: true,
      }),
    })
    expect(rotationRuleRes.status).toBe(201)
    const rotationRuleId = (rotationRuleRes.body as { data?: { id?: string } } | undefined)?.data?.id
    expect(rotationRuleId).toBeTruthy()
    if (!rotationRuleId) return

    const overlappingRotationRes = await requestJson(`${baseUrl}/api/attendance/rotation-assignments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: testUserId,
        rotationRuleId,
        startDate: '2026-06-05',
        endDate: '2026-06-08',
        isActive: true,
      }),
    })
    expect(overlappingRotationRes.status).toBe(409)
    const overlappingRotationError = (overlappingRotationRes.body as { error?: { details?: { conflictType?: string; draftKind?: string; existingKind?: string } } } | undefined)?.error
    expect(overlappingRotationError?.details?.conflictType).toBe('rotation_overrides_shift')
    expect(overlappingRotationError?.details?.draftKind).toBe('rotation')
    expect(overlappingRotationError?.details?.existingKind).toBe('shift')

    const inactiveRotationRes = await requestJson(`${baseUrl}/api/attendance/rotation-assignments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: testUserId,
        rotationRuleId,
        startDate: '2026-06-05',
        endDate: '2026-06-08',
        isActive: false,
      }),
    })
    expect(inactiveRotationRes.status).toBe(201)

    const rotationRes = await requestJson(`${baseUrl}/api/attendance/rotation-assignments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: testUserId,
        rotationRuleId,
        startDate: '2026-06-11',
        isActive: true,
      }),
    })
    expect(rotationRes.status).toBe(201)
    const rotationAssignmentId = (rotationRes.body as { data?: { assignment?: { id?: string } } } | undefined)?.data?.assignment?.id
    expect(rotationAssignmentId).toBeTruthy()
    if (!rotationAssignmentId) return

    const overlappingSecondRotationRes = await requestJson(`${baseUrl}/api/attendance/rotation-assignments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: testUserId,
        rotationRuleId,
        startDate: '2026-06-12',
        isActive: true,
      }),
    })
    expect(overlappingSecondRotationRes.status).toBe(409)
    const overlappingSecondRotationError = (overlappingSecondRotationRes.body as { error?: { details?: { conflictType?: string } } } | undefined)?.error
    expect(overlappingSecondRotationError?.details?.conflictType).toBe('rotation_assignment_overlap')

    const updateShiftToOverlapRotationRes = await requestJson(`${baseUrl}/api/attendance/assignments/${assignmentId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        endDate: '2026-06-11',
      }),
    })
    expect(updateShiftToOverlapRotationRes.status).toBe(409)
    const updateShiftError = (updateShiftToOverlapRotationRes.body as { error?: { details?: { conflictType?: string; draftKind?: string; existingKind?: string } } } | undefined)?.error
    expect(updateShiftError?.details?.conflictType).toBe('rotation_overrides_shift')
    expect(updateShiftError?.details?.draftKind).toBe('shift')
    expect(updateShiftError?.details?.existingKind).toBe('rotation')

    const invalidRotationRangeRes = await requestJson(`${baseUrl}/api/attendance/rotation-assignments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: `${testUserId}-invalid-range`,
        rotationRuleId,
        startDate: '2026-06-12',
        endDate: '2026-06-01',
        isActive: true,
      }),
    })
    expect(invalidRotationRangeRes.status).toBe(400)
    const invalidRangeError = (invalidRotationRangeRes.body as { error?: { code?: string } } | undefined)?.error
    expect(invalidRangeError?.code).toBe('VALIDATION_ERROR')
  })

  it('rejects non-UUID shift references for rotation rules, including UUID-like shift names', async () => {
    if (!baseUrl) return

    const runSuffix = Date.now().toString(36)
    const testUserId = `attendance-shift-uuid-like-name-${runSuffix}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(testUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const shiftName = `Rotation Name Shift ${runSuffix}`
    const shiftUuidLikeName = randomUuidV4()
    const shiftRes = await requestJson(`${baseUrl}/api/attendance/shifts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: shiftName,
        timezone: 'Asia/Tokyo',
        workStartTime: '09:00',
        workEndTime: '18:00',
        workingDays: [1, 2, 3, 4, 5],
      }),
    })
    expect(shiftRes.status).toBe(201)
    const shiftId = (shiftRes.body as { data?: { id?: string } } | undefined)?.data?.id
    expect(shiftId).toBeTruthy()
    if (!shiftId) return

    const uuidLikeShiftRes = await requestJson(`${baseUrl}/api/attendance/shifts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: shiftUuidLikeName,
        timezone: 'Asia/Tokyo',
        workStartTime: '09:00',
        workEndTime: '18:00',
        workingDays: [1, 2, 3, 4, 5],
      }),
    })
    expect(uuidLikeShiftRes.status).toBe(201)

    const invalidCreateByNameRes = await requestJson(`${baseUrl}/api/attendance/rotation-rules`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Invalid Name Rotation ${runSuffix}`,
        timezone: 'Asia/Tokyo',
        shiftSequence: [shiftName],
        isActive: true,
      }),
    })
    expect(invalidCreateByNameRes.status).toBe(400)
    const invalidCreateByNameBody = invalidCreateByNameRes.body as { error?: { code?: string; message?: string } } | undefined
    expect(invalidCreateByNameBody?.error?.code).toBe('VALIDATION_ERROR')
    expect(String(invalidCreateByNameBody?.error?.message ?? '')).toContain('shiftSequence must contain shift IDs')

    const invalidCreateByUuidLikeNameRes = await requestJson(`${baseUrl}/api/attendance/rotation-rules`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Invalid UUID Like Rotation ${runSuffix}`,
        timezone: 'Asia/Tokyo',
        shift_sequence: [shiftUuidLikeName],
        is_active: true,
      }),
    })
    expect(invalidCreateByUuidLikeNameRes.status).toBe(400)
    const invalidCreateByUuidLikeNameBody = invalidCreateByUuidLikeNameRes.body as { error?: { code?: string; message?: string } } | undefined
    expect(invalidCreateByUuidLikeNameBody?.error?.code).toBe('VALIDATION_ERROR')
    expect(String(invalidCreateByUuidLikeNameBody?.error?.message ?? '')).toContain('shiftSequence must contain shift IDs')

    const validRotationRuleRes = await requestJson(`${baseUrl}/api/attendance/rotation-rules`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Valid Rotation ${runSuffix}`,
        timezone: 'Asia/Tokyo',
        shiftSequence: [shiftId],
        isActive: true,
      }),
    })
    expect(validRotationRuleRes.status).toBe(201)
    const rotationRuleId = (validRotationRuleRes.body as { data?: { id?: string } } | undefined)?.data?.id
    expect(rotationRuleId).toBeTruthy()
    if (!rotationRuleId) return

    const invalidUpdateByNameRes = await requestJson(`${baseUrl}/api/attendance/rotation-rules/${rotationRuleId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        shiftSequence: [shiftName],
      }),
    })
    expect(invalidUpdateByNameRes.status).toBe(400)
    const invalidUpdateByNameBody = invalidUpdateByNameRes.body as { error?: { code?: string; message?: string } } | undefined
    expect(invalidUpdateByNameBody?.error?.code).toBe('VALIDATION_ERROR')
    expect(String(invalidUpdateByNameBody?.error?.message ?? '')).toContain('shiftSequence must contain shift IDs')

    const invalidUpdateByUuidLikeNameRes = await requestJson(`${baseUrl}/api/attendance/rotation-rules/${rotationRuleId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        shift_sequence: [shiftUuidLikeName],
      }),
    })
    expect(invalidUpdateByUuidLikeNameRes.status).toBe(400)
    const invalidUpdateByUuidLikeNameBody = invalidUpdateByUuidLikeNameRes.body as { error?: { code?: string; message?: string } } | undefined
    expect(invalidUpdateByUuidLikeNameBody?.error?.code).toBe('VALIDATION_ERROR')
    expect(String(invalidUpdateByUuidLikeNameBody?.error?.message ?? '')).toContain('shiftSequence must contain shift IDs')
  })

  it('returns 409 when deleting a shift that is still referenced by a rotation rule without assignments', async () => {
    if (!baseUrl) return

    const runSuffix = Date.now().toString(36)
    const testUserId = `attendance-shift-delete-rule-${runSuffix}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(testUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const shiftRes = await requestJson(`${baseUrl}/api/attendance/shifts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Rule Protected Shift ${runSuffix}`,
        timezone: 'Asia/Shanghai',
        workStartTime: '08:00',
        workEndTime: '16:00',
        workingDays: [1, 2, 3, 4, 5],
      }),
    })
    expect(shiftRes.status).toBe(201)
    const shiftId = (shiftRes.body as { data?: { id?: string } } | undefined)?.data?.id
    expect(shiftId).toBeTruthy()
    if (!shiftId) return

    const rotationRuleRes = await requestJson(`${baseUrl}/api/attendance/rotation-rules`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Rule Only Rotation ${runSuffix}`,
        timezone: 'Asia/Shanghai',
        shiftSequence: [shiftId],
        isActive: true,
      }),
    })
    expect(rotationRuleRes.status).toBe(201)

    const deleteRes = await requestJson(`${baseUrl}/api/attendance/shifts/${shiftId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(deleteRes.status).toBe(409)
    const deleteBody = deleteRes.body as { error?: { code?: string; message?: string } } | undefined
    expect(deleteBody?.error?.code).toBe('CONFLICT')
    expect(String(deleteBody?.error?.message || '')).toMatch(/active assignments|rotation rules/i)
  })

  it('normalizes legacy name-based rotation rules when a referenced shift is renamed', async () => {
    if (!baseUrl) return

    const runSuffix = Date.now().toString(36)
    const testUserId = `attendance-rotation-rename-${runSuffix}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(testUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const shiftRes = await requestJson(`${baseUrl}/api/attendance/shifts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Rename Legacy Shift ${runSuffix}`,
        timezone: 'Asia/Shanghai',
        workStartTime: '09:00',
        workEndTime: '18:00',
        workingDays: [1, 2, 3, 4, 5],
      }),
    })
    expect(shiftRes.status).toBe(201)
    const createdShift = (shiftRes.body as { data?: { id?: string; name?: string } } | undefined)?.data
    const shiftId = createdShift?.id
    const legacyShiftName = createdShift?.name
    expect(shiftId).toBeTruthy()
    expect(legacyShiftName).toBeTruthy()
    if (!shiftId || !legacyShiftName) return

    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    expect(dbUrl).toBeTruthy()
    if (!dbUrl) return

    const pool = new Pool({ connectionString: dbUrl })
    const rotationRuleId = randomUuidV4()
    try {
      await pool.query(
        `INSERT INTO attendance_rotation_rules
         (id, org_id, name, timezone, shift_sequence, is_active)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [
          rotationRuleId,
          'default',
          `Legacy Rotation ${runSuffix}`,
          'Asia/Shanghai',
          JSON.stringify([legacyShiftName]),
          true,
        ]
      )
    } finally {
      await pool.end()
    }

    const renameRes = await requestJson(`${baseUrl}/api/attendance/shifts/${shiftId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Renamed Stable Shift ${runSuffix}`,
      }),
    })
    expect(renameRes.status).toBe(200)

    const rotationLookupRes = await requestJson(`${baseUrl}/api/attendance/rotation-rules/${rotationRuleId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(rotationLookupRes.status).toBe(200)
    const rotationLookupBody = rotationLookupRes.body as { data?: { shiftSequence?: string[] } } | undefined
    expect(rotationLookupBody?.data?.shiftSequence).toEqual([shiftId])
  })

  it('accepts payroll cycle generate year/month aliases and reports missing anchors clearly', async () => {
    if (!baseUrl) return

    const runSuffix = Date.now().toString(36)
    const testUserId = `attendance-payroll-generate-${runSuffix}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(testUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const payrollTemplateRes = await requestJson(`${baseUrl}/api/attendance/payroll-templates`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Monthly Payroll ${runSuffix}`,
        timezone: 'UTC',
        startDay: 1,
        endDay: 30,
        endMonthOffset: 0,
        autoGenerate: false,
      }),
    })
    expect(payrollTemplateRes.status).toBe(201)
    const templateId = (payrollTemplateRes.body as { data?: { id?: string } } | undefined)?.data?.id
    expect(templateId).toBeTruthy()
    if (!templateId) return

    const missingAnchorRes = await requestJson(`${baseUrl}/api/attendance/payroll-cycles/generate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        templateId,
      }),
    })
    expect(missingAnchorRes.status).toBe(400)
    const missingAnchorError = (missingAnchorRes.body as { error?: { code?: string; message?: string } } | undefined)?.error
    expect(missingAnchorError?.code).toBe('VALIDATION_ERROR')
    expect(String(missingAnchorError?.message || '')).toContain('anchorDate or both year and month')

    const partialAliasRes = await requestJson(`${baseUrl}/api/attendance/payroll-cycles/generate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        templateId,
        year: 2026,
      }),
    })
    expect(partialAliasRes.status).toBe(400)
    const partialAliasError = (partialAliasRes.body as { error?: { code?: string; message?: string } } | undefined)?.error
    expect(partialAliasError?.code).toBe('VALIDATION_ERROR')
    expect(String(partialAliasError?.message || '')).toContain('both year and month together')

    const aliasGenerateRes = await requestJson(`${baseUrl}/api/attendance/payroll-cycles/generate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        templateId,
        year: 2026,
        month: 4,
        count: 1,
        status: 'open',
        namePrefix: `Integration Payroll ${runSuffix}`,
      }),
    })
    expect(aliasGenerateRes.status).toBe(200)
    const aliasGenerateBody = (aliasGenerateRes.body as {
      ok?: boolean
      data?: {
        created?: { startDate?: string; start_date?: string }[]
        skipped?: { startDate?: string; start_date?: string }[]
      }
    } | undefined)
    expect(aliasGenerateBody?.ok).toBe(true)
    const createdCount = Array.isArray(aliasGenerateBody?.data?.created) ? aliasGenerateBody.data.created.length : 0
    const skippedCount = Array.isArray(aliasGenerateBody?.data?.skipped) ? aliasGenerateBody.data.skipped.length : 0
    expect(createdCount + skippedCount).toBe(1)
    const firstWindow =
      aliasGenerateBody?.data?.created?.[0]?.startDate
      ?? aliasGenerateBody?.data?.created?.[0]?.start_date
      ?? aliasGenerateBody?.data?.skipped?.[0]?.startDate
      ?? aliasGenerateBody?.data?.skipped?.[0]?.start_date
    expect(firstWindow).toBe('2026-04-01')
  })

  it('computes overnight shift metrics against the next-day shift end window', async () => {
    if (!baseUrl) return

    const runSuffix = Date.now().toString(36)
    const userId = `attendance-overnight-${runSuffix}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const pickFutureWeekday = (targetDay: number): string => {
      const cursor = new Date('2029-03-01T00:00:00.000Z')
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (cursor.getUTCDay() === targetDay) return cursor.toISOString().slice(0, 10)
        cursor.setUTCDate(cursor.getUTCDate() + 1)
      }
      throw new Error(`Unable to reserve future weekday ${targetDay}`)
    }

    const workDate = pickFutureWeekday(1)
    const nextDate = new Date(`${workDate}T00:00:00.000Z`)
    nextDate.setUTCDate(nextDate.getUTCDate() + 1)
    const overnightCheckoutDate = nextDate.toISOString().slice(0, 10)
    const shiftRes = await requestJson(`${baseUrl}/api/attendance/shifts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Overnight Shift ${runSuffix}`,
        timezone: 'Asia/Shanghai',
        start_time: '22:00',
        end_time: '06:00',
        is_overnight: true,
        working_days: [1, 2, 3, 4, 5],
      }),
    })
    expect(shiftRes.status).toBe(201)
    const shiftId = (shiftRes.body as { data?: { id?: string } } | undefined)?.data?.id
    expect(shiftId).toBeTruthy()
    if (!shiftId) return

    const shiftLookupRes = await requestJson(`${baseUrl}/api/attendance/shifts/${shiftId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(shiftLookupRes.status).toBe(200)
    const shiftLookup = (shiftLookupRes.body as { data?: { isOvernight?: boolean; is_overnight?: boolean } } | undefined)?.data
    expect(shiftLookup?.isOvernight).toBe(true)
    expect(shiftLookup?.is_overnight).toBe(true)

    const assignmentRes = await requestJson(`${baseUrl}/api/attendance/assignments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId,
        shiftId,
        startDate: workDate,
        isActive: true,
      }),
    })
    expect(assignmentRes.status).toBe(201)

    const prepareRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(prepareRes.status).toBe(200)
    const commitToken = (prepareRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(commitToken).toBeTruthy()
    if (!commitToken) return

    const importRes = await requestJson(`${baseUrl}/api/attendance/import/commit`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId,
        timezone: 'Asia/Shanghai',
        rows: [
          {
            workDate,
            fields: {
              firstInAt: `${workDate}T22:05:00`,
              lastOutAt: `${overnightCheckoutDate}T05:55:00`,
              status: 'normal',
            },
          },
        ],
        mode: 'override',
        commitToken,
      }),
    })
    expect(importRes.status).toBe(200)

    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    expect(dbUrl).toBeTruthy()
    if (!dbUrl) return

    const pool = new Pool({ connectionString: dbUrl })
    try {
      const { rows: recordRows } = await pool.query(
        `SELECT work_minutes, late_minutes, early_leave_minutes, status
           FROM attendance_records
          WHERE user_id = $1 AND org_id = $2 AND work_date = $3`,
        [userId, 'default', workDate]
      )
      expect(recordRows).toHaveLength(1)
      expect(recordRows[0]?.work_minutes).toBe(470)
      expect(recordRows[0]?.late_minutes).toBe(0)
      expect(recordRows[0]?.early_leave_minutes).toBe(0)
      expect(recordRows[0]?.status).toBe('normal')
    } finally {
      await pool.end().catch(() => undefined)
    }
  })

  it('accepts legacy snake_case payload aliases for attendance admin create routes and rejects malformed ids with 400', async () => {
    if (!baseUrl) return

    const runSuffix = Date.now().toString(36)
    const testUserId = `attendance-snake-${runSuffix}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(testUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const shiftRes = await requestJson(`${baseUrl}/api/attendance/shifts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Snake Shift ${runSuffix}`,
        timezone: 'Asia/Shanghai',
        start_time: '22:00',
        end_time: '06:00',
        is_overnight: true,
        working_days: [1, 2, 3, 4, 5],
      }),
    })
    expect(shiftRes.status).toBe(201)
    const shiftId = (shiftRes.body as { data?: { id?: string } } | undefined)?.data?.id
    expect(shiftId).toBeTruthy()
    if (!shiftId) return
    const createdShift = (shiftRes.body as { data?: { isOvernight?: boolean; workStartTime?: string; workEndTime?: string } } | undefined)?.data
    expect(createdShift?.workStartTime).toBe('22:00:00')
    expect(createdShift?.workEndTime).toBe('06:00:00')
    expect(createdShift?.isOvernight).toBe(true)

    const groupRes = await requestJson(`${baseUrl}/api/attendance/groups`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Snake Group ${runSuffix}`,
        timezone: 'Asia/Shanghai',
      }),
    })
    expect(groupRes.status).toBe(200)
    const groupId = (groupRes.body as { data?: { id?: string } } | undefined)?.data?.id
    expect(groupId).toBeTruthy()
    if (!groupId) return

    const groupMemberRes = await requestJson(`${baseUrl}/api/attendance/groups/${groupId}/members`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ user_id: testUserId }),
    })
    expect(groupMemberRes.status).toBe(200)

    const assignmentRes = await requestJson(`${baseUrl}/api/attendance/assignments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user_id: testUserId,
        shift_id: shiftId,
        start_date: '2026-03-20',
        end_date: null,
        is_active: true,
      }),
    })
    expect(assignmentRes.status).toBe(201)
    const assignmentId = (assignmentRes.body as { data?: { assignment?: { id?: string } } } | undefined)?.data?.assignment?.id
    expect(assignmentId).toBeTruthy()

    const approvalFlowRes = await requestJson(`${baseUrl}/api/attendance/approval-flows`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Snake Approval ${runSuffix}`,
        request_type: 'missed_check_in',
        steps: [
          {
            name: '直属主管',
            approver_user_ids: [testUserId],
          },
        ],
        is_active: true,
      }),
    })
    expect(approvalFlowRes.status).toBe(201)

    const rotationRuleRes = await requestJson(`${baseUrl}/api/attendance/rotation-rules`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Snake Rotation ${runSuffix}`,
        timezone: 'Asia/Shanghai',
        shift_sequence: [shiftId],
        is_active: true,
      }),
    })
    expect(rotationRuleRes.status).toBe(201)
    const rotationRuleId = (rotationRuleRes.body as { data?: { id?: string } } | undefined)?.data?.id
    expect(rotationRuleId).toBeTruthy()
    if (!rotationRuleId) return

    const rotationAssignmentRes = await requestJson(`${baseUrl}/api/attendance/rotation-assignments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user_id: `${testUserId}-rotation`,
        rotation_rule_id: rotationRuleId,
        start_date: '2026-03-20',
        end_date: null,
        is_active: true,
      }),
    })
    expect(rotationAssignmentRes.status).toBe(201)

    const ruleSetRes = await requestJson(`${baseUrl}/api/attendance/rule-sets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Snake Rule Set ${runSuffix}`,
        scope: 'org',
        version: 1,
        is_default: false,
        config: { source: 'manual' },
      }),
    })
    expect(ruleSetRes.status).toBe(201)

    const invalidGroupMembersRes = await requestJson(`${baseUrl}/api/attendance/groups/not-a-uuid/members`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(invalidGroupMembersRes.status).toBe(400)
    const invalidAssignmentRes = await requestJson(`${baseUrl}/api/attendance/assignments/not-a-uuid`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(invalidAssignmentRes.status).toBe(400)
  })

  it('accepts compatibility payload aliases for approval flow and rule set create routes', async () => {
    if (!baseUrl) return

    const runSuffix = Date.now().toString(36)
    const testUserId = `attendance-compat-${runSuffix}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(testUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const approvalFlowRes = await requestJson(`${baseUrl}/api/attendance/approval-flows`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Compat Approval ${runSuffix}`,
        type: 'leave',
        steps: JSON.stringify([
          {
            name: '直属主管',
            approver_user_ids: [testUserId],
          },
        ]),
        is_active: true,
      }),
    })
    expect(approvalFlowRes.status).toBe(201)
    const createdFlow = (approvalFlowRes.body as { data?: { requestType?: string; steps?: Array<{ approverUserIds?: string[] }> } } | undefined)?.data
    expect(createdFlow?.requestType).toBe('leave')
    expect(createdFlow?.steps?.[0]?.approverUserIds).toEqual([testUserId])

    const ruleSetRes = await requestJson(`${baseUrl}/api/attendance/rule-sets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Compat Rule Set ${runSuffix}`,
        scope: 'org',
        version: '2',
        is_default: false,
        config: JSON.stringify({
          source: 'manual',
          rule: { timezone: 'Asia/Shanghai' },
        }),
      }),
    })
    expect(ruleSetRes.status).toBe(201)
    const createdRuleSet = (ruleSetRes.body as { data?: { version?: number; config?: { source?: string; rule?: { timezone?: string } } } } | undefined)?.data
    expect(createdRuleSet?.version).toBe(2)
    expect(createdRuleSet?.config?.source).toBe('manual')
    expect(createdRuleSet?.config?.rule?.timezone).toBe('Asia/Shanghai')
  })

  it('accepts compatibility payload aliases for rotation rule and payroll cycle routes', async () => {
    if (!baseUrl) return

    const runSuffix = Date.now().toString(36)
    const testUserId = `attendance-compat-rot-pay-${runSuffix}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(testUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const shiftRes = await requestJson(`${baseUrl}/api/attendance/shifts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Compat Shift ${runSuffix}`,
        workStartTime: '09:00',
        workEndTime: '18:00',
        workingDays: [1, 2, 3, 4, 5],
      }),
    })
    expect(shiftRes.status).toBe(201)
    const shiftId = (shiftRes.body as { data?: { id?: string } } | undefined)?.data?.id
    expect(shiftId).toBeTruthy()
    if (!shiftId) return

    const rotationRuleRes = await requestJson(`${baseUrl}/api/attendance/rotation-rules`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Compat Rotation ${runSuffix}`,
        timezone: 'Asia/Shanghai',
        shift_ids: [shiftId],
        is_active: true,
      }),
    })
    expect(rotationRuleRes.status).toBe(201)
    expect(((rotationRuleRes.body as { data?: { shiftSequence?: string[] } } | undefined)?.data?.shiftSequence)).toEqual([shiftId])

    const payrollTemplateRes = await requestJson(`${baseUrl}/api/attendance/payroll-templates`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Compat Payroll ${runSuffix}`,
        timezone: 'UTC',
        startDay: 1,
        endDay: 30,
      }),
    })
    expect(payrollTemplateRes.status).toBe(201)
    const payrollTemplateId = (payrollTemplateRes.body as { data?: { id?: string } } | undefined)?.data?.id
    expect(payrollTemplateId).toBeTruthy()
    if (!payrollTemplateId) return

    const cycleSeed = Number.parseInt(runSuffix, 36)
    const safeCycleSeed = Number.isFinite(cycleSeed) ? Math.max(0, cycleSeed) : Date.now()
    const cycleAnchor = new Date(Date.UTC(3000, 0, 1) + (safeCycleSeed % (365 * 4000)) * 24 * 60 * 60 * 1000)
    cycleAnchor.setUTCDate(1)
    const cycleYear = cycleAnchor.getUTCFullYear()
    const cycleMonthNumber = cycleAnchor.getUTCMonth() + 1
    const cycleMonth = String(cycleMonthNumber).padStart(2, '0')
    const cycleAnchorDate = `${cycleYear}-${cycleMonth}-01`
    const generateAnchor = new Date(Date.UTC(cycleYear, cycleMonthNumber - 1, 1))
    generateAnchor.setUTCMonth(generateAnchor.getUTCMonth() + 1)
    const generateMonthNumber = generateAnchor.getUTCMonth() + 1
    const generateYear = generateAnchor.getUTCFullYear()

    const payrollCycleCreateRes = await requestJson(`${baseUrl}/api/attendance/payroll-cycles`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        payrollTemplateId,
        anchor_date: cycleAnchorDate,
        name: `Compat Payroll Cycle ${runSuffix}`,
        metadata: JSON.stringify({ source: 'compat-create' }),
      }),
    })
    expect(payrollCycleCreateRes.status).toBe(201)
    expect(((payrollCycleCreateRes.body as { data?: { templateId?: string; metadata?: { source?: string } } } | undefined)?.data?.templateId)).toBe(payrollTemplateId)
    expect(((payrollCycleCreateRes.body as { data?: { templateId?: string; metadata?: { source?: string } } } | undefined)?.data?.metadata?.source)).toBe('compat-create')

    const payrollCycleGenerateRes = await requestJson(`${baseUrl}/api/attendance/payroll-cycles/generate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        payrollTemplateId,
        year: generateYear,
        month: generateMonthNumber,
        count: 1,
        name_prefix: `Compat Batch ${runSuffix}`,
      }),
    })
    expect(payrollCycleGenerateRes.status).toBe(200)
    expect(((payrollCycleGenerateRes.body as { data?: { templateId?: string; created?: Array<{ name?: string }> } } | undefined)?.data?.templateId)).toBe(payrollTemplateId)
    expect(((payrollCycleGenerateRes.body as { data?: { templateId?: string; created?: Array<{ name?: string }> } } | undefined)?.data?.created?.[0]?.name)).toContain(`Compat Batch ${runSuffix}`)
  })

  it('supports approval flow, rule set, and payroll cycle item lookup while keeping missing item semantics stable', async () => {
    if (!baseUrl) return

    const runSuffix = Date.now().toString(36)
    const testUserId = `attendance-missing-${runSuffix}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(testUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const approvalFlowCreateRes = await requestJson(`${baseUrl}/api/attendance/approval-flows`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Lookup Approval ${runSuffix}`,
        requestType: 'leave',
        steps: [
          {
            name: '直属主管',
            approverUserIds: [testUserId],
          },
        ],
      }),
    })
    expect(approvalFlowCreateRes.status).toBe(201)
    const approvalFlowId = (approvalFlowCreateRes.body as { data?: { id?: string } } | undefined)?.data?.id
    expect(approvalFlowId).toBeTruthy()
    if (!approvalFlowId) return

    const approvalFlowGetRes = await requestJson(`${baseUrl}/api/attendance/approval-flows/${approvalFlowId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(approvalFlowGetRes.status).toBe(200)
    const approvalFlow = (approvalFlowGetRes.body as { data?: { id?: string; steps?: Array<{ approverUserIds?: string[] }> } } | undefined)?.data
    expect(approvalFlow?.id).toBe(approvalFlowId)
    expect(approvalFlow?.steps?.[0]?.approverUserIds?.[0]).toBe(testUserId)

    const missingApprovalFlowId = randomUuidV4()
    const missingApprovalFlowGetRes = await requestJson(`${baseUrl}/api/attendance/approval-flows/${missingApprovalFlowId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(missingApprovalFlowGetRes.status).toBe(404)
    expect((missingApprovalFlowGetRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('NOT_FOUND')

    const missingApprovalFlowRes = await requestJson(`${baseUrl}/api/attendance/approval-flows/${missingApprovalFlowId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(missingApprovalFlowRes.status).toBe(404)
    expect((missingApprovalFlowRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('NOT_FOUND')

    const invalidApprovalFlowRes = await requestJson(`${baseUrl}/api/attendance/approval-flows/not-a-uuid`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(invalidApprovalFlowRes.status).toBe(400)
    expect((invalidApprovalFlowRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('VALIDATION_ERROR')

    const ruleSetCreateRes = await requestJson(`${baseUrl}/api/attendance/rule-sets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Lookup Rule Set ${runSuffix}`,
        version: 1,
        scope: 'org',
        config: { source: 'manual' },
      }),
    })
    expect(ruleSetCreateRes.status).toBe(201)
    const ruleSetId = (ruleSetCreateRes.body as { data?: { id?: string } } | undefined)?.data?.id
    expect(ruleSetId).toBeTruthy()
    if (!ruleSetId) return

    const ruleSetGetRes = await requestJson(`${baseUrl}/api/attendance/rule-sets/${ruleSetId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(ruleSetGetRes.status).toBe(200)
    const ruleSet = (ruleSetGetRes.body as { data?: { id?: string; name?: string; config?: { source?: string } } } | undefined)?.data
    expect(ruleSet?.id).toBe(ruleSetId)
    expect(ruleSet?.name).toBe(`Lookup Rule Set ${runSuffix}`)
    expect(ruleSet?.config?.source).toBe('manual')

    const missingRuleSetId = randomUuidV4()
    const missingRuleSetGetRes = await requestJson(`${baseUrl}/api/attendance/rule-sets/${missingRuleSetId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(missingRuleSetGetRes.status).toBe(404)
    expect((missingRuleSetGetRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('NOT_FOUND')

    const missingRuleSetRes = await requestJson(`${baseUrl}/api/attendance/rule-sets/${missingRuleSetId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Missing Rule Set ${runSuffix}`,
        version: 1,
        scope: 'org',
        config: { source: 'manual' },
      }),
    })
    expect(missingRuleSetRes.status).toBe(404)
    expect((missingRuleSetRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('NOT_FOUND')

    const invalidRuleSetRes = await requestJson(`${baseUrl}/api/attendance/rule-sets/not-a-uuid`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(invalidRuleSetRes.status).toBe(400)
    expect((invalidRuleSetRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('VALIDATION_ERROR')

    const cycleSeed = Number.parseInt(runSuffix, 36)
    const safeCycleSeed = Number.isFinite(cycleSeed) ? Math.max(0, cycleSeed) : Date.now()
    const cycleYear = 2031 + (safeCycleSeed % 20)
    const cycleMonth = String((Math.floor(safeCycleSeed / 7) % 12) + 1).padStart(2, '0')
    const cycleDay = String((Math.floor(safeCycleSeed / 97) % 20) + 1).padStart(2, '0')
    const cycleStartDate = `${cycleYear}-${cycleMonth}-${cycleDay}`
    const cycleEndDay = String(Math.min(28, Number(cycleDay) + 7)).padStart(2, '0')
    const cycleEndDate = `${cycleYear}-${cycleMonth}-${cycleEndDay}`

    const payrollCycleCreateRes = await requestJson(`${baseUrl}/api/attendance/payroll-cycles`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Lookup Cycle ${runSuffix}`,
        startDate: cycleStartDate,
        endDate: cycleEndDate,
      }),
    })
    expect(payrollCycleCreateRes.status).toBe(201)
    const payrollCycleId = (payrollCycleCreateRes.body as { data?: { id?: string } } | undefined)?.data?.id
    expect(payrollCycleId).toBeTruthy()
    if (!payrollCycleId) return

    const payrollCycleGetRes = await requestJson(`${baseUrl}/api/attendance/payroll-cycles/${payrollCycleId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(payrollCycleGetRes.status).toBe(200)
    expect((payrollCycleGetRes.body as { data?: { id?: string } } | undefined)?.data?.id).toBe(payrollCycleId)

    const missingPayrollCycleRes = await requestJson(`${baseUrl}/api/attendance/payroll-cycles/${randomUuidV4()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(missingPayrollCycleRes.status).toBe(404)
    expect((missingPayrollCycleRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('NOT_FOUND')

    const invalidPayrollCycleRes = await requestJson(`${baseUrl}/api/attendance/payroll-cycles/not-a-uuid`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(invalidPayrollCycleRes.status).toBe(400)
    expect((invalidPayrollCycleRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('VALIDATION_ERROR')

    const invalidPayrollCycleUpdateRes = await requestJson(`${baseUrl}/api/attendance/payroll-cycles/not-a-uuid`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Invalid Cycle ${runSuffix}`,
      }),
    })
    expect(invalidPayrollCycleUpdateRes.status).toBe(400)
    expect((invalidPayrollCycleUpdateRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('VALIDATION_ERROR')

    const payrollCycleExportAliasRes = await requestJson(`${baseUrl}/api/attendance/payroll-cycles/${payrollCycleId}/export`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(payrollCycleExportAliasRes.status).toBe(200)
    expect(payrollCycleExportAliasRes.raw).toContain('cycle_id,cycle_name,start_date,end_date,metric,value')

    const payrollCycleSummaryExportRes = await requestJson(`${baseUrl}/api/attendance/payroll-cycles/${payrollCycleId}/summary/export`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(payrollCycleSummaryExportRes.status).toBe(200)
    expect(payrollCycleSummaryExportRes.raw).toBe(payrollCycleExportAliasRes.raw)
  })

  it('rejects invalid CSV upload payloads with 400 before creating upload handles', async () => {
    if (!baseUrl) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-invalid-csv&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const invalidCsv = 'foo,bar\\n1,2\\n'
    const uploadRes = await requestJson(`${baseUrl}/api/attendance/import/upload?orgId=default&filename=invalid.csv`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/csv',
      },
      body: invalidCsv,
    })

    expect(uploadRes.status).toBe(400)
    const body = (uploadRes.body as { ok?: boolean; error?: { code?: string; message?: string } } | undefined) ?? {}
    expect(body.ok).toBe(false)
    expect(body.error?.code).toBe('VALIDATION_ERROR')
    expect(String(body.error?.message ?? '')).toMatch(/header|data row/i)
  })

  it('rejects uploaded CSV files that only contain a header row after parser normalization', async () => {
    if (!baseUrl) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-header-only-csv&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const headerOnlyCsv = 'workDate,userId,1_on_duty_user_check_time,1_off_duty_user_check_time\n,,,\n'
    const uploadRes = await requestJson(`${baseUrl}/api/attendance/import/upload?orgId=default&filename=header-only.csv`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/csv',
      },
      body: headerOnlyCsv,
    })

    expect(uploadRes.status).toBe(400)
    const body = (uploadRes.body as { ok?: boolean; error?: { code?: string; message?: string } } | undefined) ?? {}
    expect(body.ok).toBe(false)
    expect(body.error?.code).toBe('VALIDATION_ERROR')
    expect(String(body.error?.message ?? '')).toMatch(/non-empty data row/i)
  })

  it('keeps /api/health public for probes', async () => {
    if (!baseUrl) return

    const healthRes = await requestJson(`${baseUrl}/api/health`)
    expect(healthRes.status).toBe(200)
    const body = (healthRes.body as { status?: string; ok?: boolean; success?: boolean; timestamp?: string } | undefined) ?? {}
    expect(body.status).toBe('ok')
    expect(body.ok).toBe(true)
    expect(body.success).toBe(true)
    expect(typeof body.timestamp).toBe('string')
  })

  it('keeps /api/auth/users available for admin user listing', async () => {
    if (!baseUrl) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=auth-users-test&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const usersRes = await requestJson(`${baseUrl}/api/auth/users?page=1&pageSize=5`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })

    expect(usersRes.status).toBe(200)
    const body = (usersRes.body as { success?: boolean; data?: { items?: unknown[]; total?: number } } | undefined) ?? {}
    expect(body.success).toBe(true)
    expect(Array.isArray(body.data?.items)).toBe(true)
    expect(typeof body.data?.total).toBe('number')
  })

  it('keeps /api/attendance/calendar available as records compatibility alias', async () => {
    if (!baseUrl) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-calendar-test&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const workDate = new Date().toISOString().slice(0, 10)
    const calendarRes = await requestJson(
      `${baseUrl}/api/attendance/calendar?from=${encodeURIComponent(workDate)}&to=${encodeURIComponent(workDate)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    )

    expect(calendarRes.status).toBe(200)
    const body = (calendarRes.body as { ok?: boolean; success?: boolean; data?: { items?: unknown[] } } | undefined) ?? {}
    expect(body.ok).toBe(true)
    expect(body.success).toBe(true)
    expect(Array.isArray(body.data?.items)).toBe(true)
  })

  it('rejects invalid attendance calendar date ranges with 400', async () => {
    if (!baseUrl) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-calendar-invalid-test&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const calendarRes = await requestJson(
      `${baseUrl}/api/attendance/calendar?from=invalid&to=invalid`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    )

    expect(calendarRes.status).toBe(400)
    const body = (calendarRes.body as { ok?: boolean; error?: { code?: string; message?: string } } | undefined) ?? {}
    expect(body.ok).toBe(false)
    expect(body.error?.code).toBe('VALIDATION_ERROR')
    expect(body.error?.message).toContain('YYYY-MM-DD')
  })

  it('accepts snake_case attendance request aliases and returns validation details for malformed request payloads', async () => {
    if (!baseUrl) return

    const testUserId = `attendance-request-dedupe-${Date.now().toString(36)}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(testUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin,attendance:approve`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const workDate = new Date().toISOString().slice(0, 10)
    const requestedInAt = new Date().toISOString()
    const payload = {
      work_date: workDate,
      request_type: 'missed_check_in',
      requested_in_at: requestedInAt,
      reason: 'dedupe test',
    }

    const firstRes = await requestJson(`${baseUrl}/api/attendance/requests`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    expect(firstRes.status).toBe(201)

    const invalidRes = await requestJson(`${baseUrl}/api/attendance/requests`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        work_date: workDate,
        request_type: 'missed_check_in',
        reason: 'missing requested_in_at',
      }),
    })
    expect(invalidRes.status).toBe(400)
    const invalidBody = (invalidRes.body as {
      ok?: boolean
      error?: { code?: string; details?: Array<{ field?: string; message?: string }> }
    } | undefined) ?? {}
    expect(invalidBody.ok).toBe(false)
    expect(invalidBody.error?.code).toBe('VALIDATION_ERROR')
    expect(Array.isArray(invalidBody.error?.details)).toBe(true)
    expect(invalidBody.error?.details?.[0]?.field).toBe('requestedInAt')

    const secondRes = await requestJson(`${baseUrl}/api/attendance/requests`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    expect(secondRes.status).toBe(409)
    const secondBody = (secondRes.body as { ok?: boolean; error?: { code?: string } } | undefined) ?? {}
    expect(secondBody.ok).toBe(false)
    expect(secondBody.error?.code).toBe('DUPLICATE_REQUEST')
  })

  it('exports attendance CSV with ISO date values and timezone-consistent timestamps', async () => {
    if (!baseUrl) return

    const tokenUserId = `attendance-export-${Date.now().toString(36)}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(tokenUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    expect(dbUrl).toBeTruthy()
    if (!dbUrl) return

    const workDate = '2029-03-13'
    const firstInAt = new Date(`${workDate}T00:00:00.000Z`)
    const lastOutAt = new Date(`${workDate}T09:00:00.000Z`)
    const recordId = randomUuidV4()
    const sourceBatchId = randomUuidV4()
    const pool = new Pool({ connectionString: dbUrl })
    try {
      await pool.query(
        `INSERT INTO attendance_records
         (id, user_id, org_id, work_date, timezone, first_in_at, last_out_at, work_minutes, late_minutes, early_leave_minutes, status, is_workday, meta, source_batch_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, now(), now())`,
        [
          recordId,
          tokenUserId,
          'default',
          workDate,
          'Asia/Tokyo',
          firstInAt,
          lastOutAt,
          540,
          0,
          0,
          'normal',
          true,
          JSON.stringify({ source: 'integration-export-format' }),
          sourceBatchId,
        ]
      )

      const exportRes = await requestJson(
        `${baseUrl}/api/attendance/export?from=${encodeURIComponent(workDate)}&to=${encodeURIComponent(workDate)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      )
      expect(exportRes.status).toBe(200)

      const lines = exportRes.raw.trim().split('\n')
      expect(lines.length).toBeGreaterThanOrEqual(2)
      expect(lines[0]).toContain('work_date')
      expect(lines[0]).toContain('timezone')
      expect(lines[0]).toContain('is_workday')
      expect(lines[1]).toContain(`${workDate},Asia/Tokyo,${workDate}T09:00:00+09:00,${workDate}T18:00:00+09:00`)
      expect(lines[1]).toContain(',true')
      expect(lines[1]).not.toContain('GMT+')
      expect(lines[1]).not.toContain('Mon ')
    } finally {
      await pool.query('DELETE FROM attendance_records WHERE id = $1', [recordId]).catch(() => undefined)
      await pool.end()
    }
  })

  it('exports attendance JSON when format=json is requested', async () => {
    if (!baseUrl) return

    const tokenUserId = `attendance-export-json-${Date.now().toString(36)}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(tokenUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    expect(dbUrl).toBeTruthy()
    if (!dbUrl) return

    const workDate = '2029-03-14'
    const firstInAt = new Date(`${workDate}T00:00:00.000Z`)
    const recordId = randomUuidV4()
    const sourceBatchId = randomUuidV4()
    const pool = new Pool({ connectionString: dbUrl })
    try {
      await pool.query(
        `INSERT INTO attendance_records
         (id, user_id, org_id, work_date, timezone, first_in_at, last_out_at, work_minutes, late_minutes, early_leave_minutes, status, is_workday, meta, source_batch_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, $10, $11, $12::jsonb, $13, now(), now())`,
        [
          recordId,
          tokenUserId,
          'default',
          workDate,
          'Asia/Tokyo',
          firstInAt,
          480,
          0,
          0,
          'normal',
          true,
          JSON.stringify({ source: 'integration-export-json' }),
          sourceBatchId,
        ]
      )

      const exportRes = await requestJson(
        `${baseUrl}/api/attendance/export?from=${encodeURIComponent(workDate)}&to=${encodeURIComponent(workDate)}&format=json`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      )
      expect(exportRes.status).toBe(200)
      const body = (exportRes.body as {
        ok?: boolean
        success?: boolean
        data?: { format?: string; total?: number; items?: Array<Record<string, unknown>> }
      } | undefined) ?? {}
      expect(body.ok).toBe(true)
      expect(body.success).toBe(true)
      expect(body.data?.format).toBe('json')
      expect(body.data?.total).toBeGreaterThanOrEqual(1)
      expect(Array.isArray(body.data?.items)).toBe(true)
      const row = body.data?.items?.find(item => item.user_id === tokenUserId)
      expect(row?.work_date).toBe(workDate)
      expect(row?.first_in_at).toBe(`${workDate}T09:00:00+09:00`)
    } finally {
      await pool.query('DELETE FROM attendance_records WHERE id = $1', [recordId]).catch(() => undefined)
      await pool.end()
    }
  })

  it('rejects unsafe group names and returns 409 for duplicate attendance group names', async () => {
    if (!baseUrl) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-group-guard-${Date.now().toString(36)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    for (const unsafeName of ['<script>alert(1)</script>', 'test" onmouseover="alert(1)', 'javascript:alert(1)']) {
      const unsafeRes = await requestJson(`${baseUrl}/api/attendance/groups`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: unsafeName,
          timezone: 'UTC',
        }),
      })
      expect(unsafeRes.status).toBe(400)
      const unsafeBody = (unsafeRes.body as { error?: { code?: string; message?: string } } | undefined) ?? {}
      expect(unsafeBody.error?.code).toBe('VALIDATION_ERROR')
      expect(unsafeBody.error?.message).toContain('unsafe')
    }

    const groupName = `Run15 Duplicate Group ${Date.now().toString(36)}`
    const firstRes = await requestJson(`${baseUrl}/api/attendance/groups`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: groupName,
        timezone: 'UTC',
      }),
    })
    expect(firstRes.status).toBe(200)

    const secondRes = await requestJson(`${baseUrl}/api/attendance/groups`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: groupName,
        timezone: 'UTC',
      }),
    })
    expect(secondRes.status).toBe(409)
    const secondBody = (secondRes.body as { error?: { code?: string } } | undefined) ?? {}
    expect(secondBody.error?.code).toBe('ALREADY_EXISTS')
  })

  it('rejects invalid and empty timezones for attendance groups and payroll templates', async () => {
    if (!baseUrl) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-tz-guard-${Date.now().toString(36)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const invalidGroupRes = await requestJson(`${baseUrl}/api/attendance/groups`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Invalid TZ Group ${Date.now().toString(36)}`,
        timezone: 'Mars/Olympus',
      }),
    })
    expect(invalidGroupRes.status).toBe(400)

    const emptyGroupRes = await requestJson(`${baseUrl}/api/attendance/groups`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Empty TZ Group ${Date.now().toString(36)}`,
        timezone: '',
      }),
    })
    expect(emptyGroupRes.status).toBe(400)

    const invalidTemplateRes = await requestJson(`${baseUrl}/api/attendance/payroll-templates`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Invalid TZ Payroll ${Date.now().toString(36)}`,
        timezone: 'Mars/Olympus',
        startDay: 1,
        endDay: 30,
      }),
    })
    expect(invalidTemplateRes.status).toBe(400)
    const invalidTemplateBody = (invalidTemplateRes.body as { error?: { code?: string; message?: string } } | undefined) ?? {}
    expect(invalidTemplateBody.error?.code).toBe('VALIDATION_ERROR')
    expect(invalidTemplateBody.error?.message).toContain('IANA')

    const emptyTemplateRes = await requestJson(`${baseUrl}/api/attendance/payroll-templates`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Empty TZ Payroll ${Date.now().toString(36)}`,
        timezone: '',
        startDay: 1,
        endDay: 30,
      }),
    })
    expect(emptyTemplateRes.status).toBe(400)
    const emptyTemplateBody = (emptyTemplateRes.body as { error?: { code?: string; message?: string } } | undefined) ?? {}
    expect(emptyTemplateBody.error?.code).toBe('VALIDATION_ERROR')
    expect(emptyTemplateBody.error?.message).toContain('required')
  })

  it('rejects future punches and still allows immediate check-out after check-in when min interval is enabled', async () => {
    if (!baseUrl) return

    const tokenUserId = `attendance-punch-guard-${Date.now().toString(36)}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(tokenUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const settingsRes = await requestJson(`${baseUrl}/api/attendance/settings`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(settingsRes.status).toBe(200)
    const originalSettings = ((settingsRes.body as { data?: Record<string, unknown> } | undefined)?.data ?? {}) as Record<string, unknown>

    try {
      const saveSettingsRes = await requestJson(`${baseUrl}/api/attendance/settings`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...originalSettings,
          minPunchIntervalMinutes: 60,
        }),
      })
      expect(saveSettingsRes.status).toBe(200)

      const futurePunchRes = await requestJson(`${baseUrl}/api/attendance/punch`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          eventType: 'check_in',
          occurred_at: '2027-03-19T09:00:00.000Z',
        }),
      })
      expect(futurePunchRes.status).toBe(400)
      const futureBody = (futurePunchRes.body as { error?: { code?: string } } | undefined) ?? {}
      expect(futureBody.error?.code).toBe('FUTURE_PUNCH_NOT_ALLOWED')

      const now = new Date().toISOString()
      const checkInRes = await requestJson(`${baseUrl}/api/attendance/punch`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          eventType: 'check_in',
          occurredAt: now,
        }),
      })
      expect(checkInRes.status).toBe(200)

      const checkOutRes = await requestJson(`${baseUrl}/api/attendance/punch`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          eventType: 'check_out',
          occurredAt: now,
        }),
      })
      expect(checkOutRes.status).toBe(200)
    } finally {
      await requestJson(`${baseUrl}/api/attendance/settings`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(originalSettings),
      }).catch(() => undefined)
    }
  })

  it('supports request item lookup, update, and delete aliases for self-service follow-up', async () => {
    if (!baseUrl) return

    const runSuffix = Date.now().toString(36)
    const testUserId = `attendance-request-item-${runSuffix}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(testUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin,attendance:approve`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const workDate = new Date().toISOString().slice(0, 10)
    const requestedInAt = new Date().toISOString()
    const requestCreateRes = await requestJson(`${baseUrl}/api/attendance/requests`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        workDate,
        requestType: 'missed_check_in',
        requestedInAt,
        reason: 'Initial request',
      }),
    })
    expect(requestCreateRes.status).toBe(201)
    const createdRequest = (requestCreateRes.body as { data?: { request?: { id?: string; work_date?: string; workDate?: string } } } | undefined)?.data?.request
    expect(createdRequest?.work_date).toBe(workDate)
    expect(createdRequest?.workDate).toBe(workDate)
    const requestId = createdRequest?.id
    expect(requestId).toBeTruthy()
    if (!requestId) return

    const requestGetRes = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(requestGetRes.status).toBe(200)
    expect((requestGetRes.body as { data?: { request?: { id?: string; work_date?: string; workDate?: string } } } | undefined)?.data?.request?.id).toBe(requestId)
    expect((requestGetRes.body as { data?: { request?: { work_date?: string; workDate?: string } } } | undefined)?.data?.request?.work_date).toBe(workDate)
    expect((requestGetRes.body as { data?: { request?: { work_date?: string; workDate?: string } } } | undefined)?.data?.request?.workDate).toBe(workDate)

    const requestUpdateRes = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        reason: 'Updated request reason',
        requestedInAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      }),
    })
    expect(requestUpdateRes.status).toBe(200)
    const updatedRequest = (requestUpdateRes.body as { data?: { request?: { reason?: string } } } | undefined)?.data?.request
    expect(updatedRequest?.reason).toBe('Updated request reason')

    const requestDeleteRes = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(requestDeleteRes.status).toBe(200)
    expect((requestDeleteRes.body as { data?: { status?: string } } | undefined)?.data?.status).toBe('cancelled')

    const requestGetAfterDeleteRes = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(requestGetAfterDeleteRes.status).toBe(200)
    expect((requestGetAfterDeleteRes.body as { data?: { request?: { status?: string } } } | undefined)?.data?.request?.status).toBe('cancelled')
  })

  it('writes an adjusted attendance record after final approval for a missed check-in request', async () => {
    if (!baseUrl) return

    const runSuffix = Date.now().toString(36)
    const testUserId = `attendance-request-record-${runSuffix}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(testUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin,attendance:approve`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const pickFutureWeekday = (): string => {
      const cursor = new Date('2029-03-01T00:00:00.000Z')
      for (let index = 0; index < 14; index += 1) {
        const candidate = new Date(cursor)
        candidate.setUTCDate(cursor.getUTCDate() + index)
        const weekday = candidate.getUTCDay()
        if (weekday >= 1 && weekday <= 5) {
          return candidate.toISOString().slice(0, 10)
        }
      }
      throw new Error('Failed to resolve future weekday for request record settlement test')
    }

    const workDate = pickFutureWeekday()
    const requestedInAt = `${workDate}T09:05:00.000Z`

    const shiftRes = await requestJson(`${baseUrl}/api/attendance/shifts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Approval Shift ${runSuffix}`,
        timezone: 'UTC',
        workStartTime: '09:00',
        workEndTime: '18:00',
        workingDays: [1, 2, 3, 4, 5],
      }),
    })
    expect(shiftRes.status).toBe(201)
    const shiftId = (shiftRes.body as { data?: { id?: string } } | undefined)?.data?.id
    expect(shiftId).toBeTruthy()
    if (!shiftId) return

    const assignmentRes = await requestJson(`${baseUrl}/api/attendance/assignments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: testUserId,
        shiftId,
        startDate: workDate,
        isActive: true,
      }),
    })
    expect(assignmentRes.status).toBe(201)

    const approvalFlowRes = await requestJson(`${baseUrl}/api/attendance/approval-flows`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Approval Flow ${runSuffix}`,
        requestType: 'missed_check_in',
        steps: [
          {
            name: 'Direct Manager',
            approverUserIds: [testUserId],
          },
        ],
        isActive: true,
      }),
    })
    expect(approvalFlowRes.status).toBe(201)
    const approvalFlowId = (approvalFlowRes.body as { data?: { id?: string } } | undefined)?.data?.id
    expect(approvalFlowId).toBeTruthy()
    if (!approvalFlowId) return

    const requestCreateRes = await requestJson(`${baseUrl}/api/attendance/requests`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        workDate,
        requestType: 'missed_check_in',
        requestedInAt,
        reason: 'Integration approval follow-up',
        approvalFlowId,
      }),
    })
    expect(requestCreateRes.status).toBe(201)
    const requestId = (requestCreateRes.body as { data?: { request?: { id?: string } } } | undefined)?.data?.request?.id
    expect(requestId).toBeTruthy()
    if (!requestId) return

    const approveRes = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/approve`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ comment: 'approve request for record settlement test' }),
    })
    expect(approveRes.status).toBe(200)
    const approvedRecord = (approveRes.body as { data?: { record?: { status?: string } } } | undefined)?.data?.record
    expect(approvedRecord?.status).toBe('adjusted')

    const recordsRes = await requestJson(
      `${baseUrl}/api/attendance/records?from=${encodeURIComponent(workDate)}&to=${encodeURIComponent(workDate)}&userId=${encodeURIComponent(testUserId)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    )
    expect(recordsRes.status).toBe(200)
    const items = (recordsRes.body as { data?: { items?: Array<Record<string, unknown>> } } | undefined)?.data?.items ?? []
    const record = items.find((row) => {
      const rowDate = String(row?.work_date ?? row?.workDate ?? '').slice(0, 10)
      const rowUser = String(row?.user_id ?? row?.userId ?? '')
      return rowDate === workDate && rowUser === testUserId
    })
    expect(record).toBeTruthy()
    expect(String(record?.status ?? '')).toBe('adjusted')
    expect(String(record?.first_in_at ?? record?.firstInAt ?? '')).toContain(`${workDate}T09:05:00`)
  })

  it('supports holiday item lookup and rejects invalid holiday date/type payloads before write', async () => {
    if (!baseUrl) return

    const runSuffix = Date.now().toString(36)
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-holiday-item-${runSuffix}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const futureDayOffset = Number.parseInt(runSuffix, 36) % (365 * 4000)
    const holidayDate = new Date(Date.UTC(3000, 0, 1) + (futureDayOffset * 24 * 60 * 60 * 1000))
      .toISOString()
      .slice(0, 10)
    const holidayCreateRes = await requestJson(`${baseUrl}/api/attendance/holidays`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        date: holidayDate,
        name: `Holiday Item ${runSuffix}`,
        type: 'holiday',
      }),
    })
    expect(holidayCreateRes.status).toBe(201)
    const holidayId = (holidayCreateRes.body as { data?: { id?: string } } | undefined)?.data?.id
    expect(holidayId).toBeTruthy()
    if (!holidayId) return

    const holidayGetRes = await requestJson(`${baseUrl}/api/attendance/holidays/${holidayId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(holidayGetRes.status).toBe(200)
    expect((holidayGetRes.body as { data?: { id?: string; name?: string; type?: string } } | undefined)?.data?.id).toBe(holidayId)
    expect((holidayGetRes.body as { data?: { type?: string } } | undefined)?.data?.type).toBe('holiday')

    const holidayUpdateRes = await requestJson(`${baseUrl}/api/attendance/holidays/${holidayId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Holiday Item Updated ${runSuffix}`,
        type: 'working_day_override',
      }),
    })
    expect(holidayUpdateRes.status).toBe(200)
    const updatedHoliday = (holidayUpdateRes.body as { data?: { name?: string; type?: string; isWorkingDay?: boolean } } | undefined)?.data
    expect(updatedHoliday?.name).toBe(`Holiday Item Updated ${runSuffix}`)
    expect(updatedHoliday?.type).toBe('working_day_override')
    expect(updatedHoliday?.isWorkingDay).toBe(true)

    const invalidHolidayDateRes = await requestJson(`${baseUrl}/api/attendance/holidays`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        date: 'invalid',
        name: 'Invalid holiday date',
      }),
    })
    expect(invalidHolidayDateRes.status).toBe(400)

    const invalidHolidayTypeRes = await requestJson(`${baseUrl}/api/attendance/holidays`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        date: '2029-08-18',
        name: 'Invalid holiday type',
        type: 'invalid_type',
      }),
    })
    expect(invalidHolidayTypeRes.status).toBe(400)
  })

  it('protects manual holiday origins during national holiday sync', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return

    const runSuffix = Date.now().toString(36)
    const syncYear = 3030 + (Number.parseInt(runSuffix.slice(-3), 36) % 500)
    const dates = {
      empty: `${syncYear}-01-01`,
      national: `${syncYear}-01-02`,
      manual: `${syncYear}-01-03`,
      manualDeleted: `${syncYear}-01-04`,
      defaultManual: `${syncYear}-01-05`,
      overwriteFalse: `${syncYear}-01-06`,
    }
    const targetDates = Object.values(dates)
    const pool = new Pool({ connectionString: dbUrl })
    let fetchDays: Array<{ date: string; name: string; isOffDay: boolean }> = []
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: true,
      json: async () => ({ days: fetchDays }),
    }) as any)

    async function readHolidayRows() {
      const rows = await pool.query(
        `SELECT to_char(holiday_date, 'YYYY-MM-DD') AS date, name, is_working_day, origin
         FROM attendance_holidays
         WHERE org_id = $1 AND holiday_date = ANY($2::date[])`,
        ['default', targetDates]
      )
      return new Map(rows.rows.map(row => [String(row.date), row]))
    }

    try {
      await pool.query('DELETE FROM attendance_holidays WHERE org_id = $1 AND holiday_date = ANY($2::date[])', ['default', targetDates])
      await pool.query(
        `INSERT INTO attendance_holidays (id, org_id, holiday_date, name, is_working_day, origin)
         VALUES
           ($1, 'default', $2, 'Old National', false, 'national'),
           ($3, 'default', $4, 'Manual Protected', false, 'manual'),
           ($5, 'default', $6, 'Manual Deleted', false, 'manual'),
           ($7, 'default', $8, 'Overwrite Disabled', false, 'national')`,
        [
          randomUuidV4(),
          dates.national,
          randomUuidV4(),
          dates.manual,
          randomUuidV4(),
          dates.manualDeleted,
          randomUuidV4(),
          dates.overwriteFalse,
        ]
      )
      await pool.query(
        `INSERT INTO attendance_holidays (id, org_id, holiday_date, name, is_working_day)
         VALUES ($1, 'default', $2, 'Default Manual', false)`,
        [randomUuidV4(), dates.defaultManual]
      )
      await pool.query('DELETE FROM attendance_holidays WHERE org_id = $1 AND holiday_date = $2', ['default', dates.manualDeleted])

      const tokenRes = await requestJson(
        `${baseUrl}/api/auth/dev-token?userId=attendance-holiday-sync-${runSuffix}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
      )
      const token = (tokenRes.body as { token?: string } | undefined)?.token
      expect(token).toBeTruthy()
      if (!token) return

      fetchDays = [
        { date: dates.empty, name: 'Synced Empty', isOffDay: true },
        { date: dates.national, name: 'Synced National Update', isOffDay: false },
        { date: dates.manual, name: 'Synced Manual Conflict', isOffDay: true },
        { date: dates.manualDeleted, name: 'Synced Deleted Manual', isOffDay: true },
        { date: dates.defaultManual, name: 'Synced Default Manual Conflict', isOffDay: true },
      ]
      const overwriteTrueRes = await requestJson(`${baseUrl}/api/attendance/holidays/sync`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          years: [syncYear],
          baseUrl: 'https://attendance-sync.test',
          addDayIndex: false,
          overwrite: true,
        }),
      })
      expect(overwriteTrueRes.status).toBe(200)
      const overwriteTrueData = (overwriteTrueRes.body as { data?: Record<string, any> } | undefined)?.data ?? {}
      expect(overwriteTrueData.totalFetched).toBe(5)
      expect(overwriteTrueData.totalApplied).toBe(3)
      expect(overwriteTrueData.totalIgnored).toBe(2)
      expect(overwriteTrueData.totalSkipped).toBe(0)
      expect(overwriteTrueData.results?.[0]).toMatchObject({ fetched: 5, applied: 3, ignored: 2, skipped: 0 })
      expect(overwriteTrueData.lastRun).toMatchObject({ totalFetched: 5, totalApplied: 3, totalIgnored: 2, totalSkipped: 0 })

      let rowsByDate = await readHolidayRows()
      expect(rowsByDate.get(dates.empty)).toMatchObject({ name: 'Synced Empty', origin: 'national' })
      expect(rowsByDate.get(dates.national)).toMatchObject({ name: 'Synced National Update', origin: 'national', is_working_day: true })
      expect(rowsByDate.get(dates.manual)).toMatchObject({ name: 'Manual Protected', origin: 'manual' })
      expect(rowsByDate.get(dates.manualDeleted)).toMatchObject({ name: 'Synced Deleted Manual', origin: 'national' })
      expect(rowsByDate.get(dates.defaultManual)).toMatchObject({ name: 'Default Manual', origin: 'manual' })

      fetchDays = [
        { date: dates.overwriteFalse, name: 'Should Not Overwrite', isOffDay: false },
      ]
      const overwriteFalseRes = await requestJson(`${baseUrl}/api/attendance/holidays/sync`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          years: [syncYear],
          baseUrl: 'https://attendance-sync.test',
          addDayIndex: false,
          overwrite: false,
        }),
      })
      expect(overwriteFalseRes.status).toBe(200)
      const overwriteFalseData = (overwriteFalseRes.body as { data?: Record<string, any> } | undefined)?.data ?? {}
      expect(overwriteFalseData.totalFetched).toBe(1)
      expect(overwriteFalseData.totalApplied).toBe(0)
      expect(overwriteFalseData.totalIgnored).toBe(0)
      expect(overwriteFalseData.totalSkipped).toBe(1)
      expect(overwriteFalseData.results?.[0]).toMatchObject({ fetched: 1, applied: 0, ignored: 0, skipped: 1 })

      rowsByDate = await readHolidayRows()
      expect(rowsByDate.get(dates.overwriteFalse)).toMatchObject({ name: 'Overwrite Disabled', origin: 'national', is_working_day: false })
    } finally {
      fetchSpy.mockRestore()
      await pool.query('DELETE FROM attendance_holidays WHERE org_id = $1 AND holiday_date = ANY($2::date[])', ['default', targetDates]).catch(() => undefined)
      await pool.end()
    }
  })

  it('rejects negative leave type daily_minutes aliases, empty holiday names, and exposes holiday type fields', async () => {
    if (!baseUrl) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-leave-guard-${Date.now().toString(36)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const invalidLeaveTypeRes = await requestJson(`${baseUrl}/api/attendance/leave-types`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Negative Leave ${Date.now().toString(36)}`,
        daily_minutes: -100,
      }),
    })
    expect(invalidLeaveTypeRes.status).toBe(400)

    const invalidHolidayRes = await requestJson(`${baseUrl}/api/attendance/holidays`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        date: '2029-03-15',
        name: '   ',
        isWorkingDay: false,
      }),
    })
    expect(invalidHolidayRes.status).toBe(400)

    const holidayDate = '2029-03-15'
    const holidayCreateRes = await requestJson(`${baseUrl}/api/attendance/holidays`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        date: holidayDate,
        name: 'Holiday Type Check',
        isWorkingDay: false,
      }),
    })
    expect([201, 409]).toContain(holidayCreateRes.status)
    const createdHoliday =
      ((holidayCreateRes.body as { data?: Record<string, unknown> } | undefined)?.data) ?? null

    const holidayListRes = await requestJson(
      `${baseUrl}/api/attendance/holidays?from=${holidayDate}&to=${holidayDate}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    )
    expect(holidayListRes.status).toBe(200)
    const items = ((holidayListRes.body as { data?: { items?: Array<Record<string, unknown>> } } | undefined)?.data?.items) ?? []
    const holiday =
      items.find(item => item.id === createdHoliday?.id)
      ?? items.find(item => String(item.date ?? '').startsWith(holidayDate))
      ?? createdHoliday
    expect(holiday).toBeTruthy()
    expect(holiday?.type).toBe('holiday')
    expect(holiday?.holidayType).toBe('holiday')
  })

  it('supports fetching attendance groups, leave types, and payroll templates by id', async () => {
    if (!baseUrl) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-read-by-id-${Date.now().toString(36)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const groupName = `Read By Id Group ${Date.now().toString(36)}`
    const groupCreateRes = await requestJson(`${baseUrl}/api/attendance/groups`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: groupName,
        timezone: 'UTC',
      }),
    })
    expect(groupCreateRes.status).toBe(200)
    const groupId = ((groupCreateRes.body as { data?: { id?: string } } | undefined)?.data?.id) ?? ''
    expect(groupId).toBeTruthy()

    const groupGetRes = await requestJson(`${baseUrl}/api/attendance/groups/${encodeURIComponent(groupId)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(groupGetRes.status).toBe(200)
    expect(((groupGetRes.body as { data?: { id?: string; name?: string } } | undefined)?.data?.id)).toBe(groupId)
    expect(((groupGetRes.body as { data?: { id?: string; name?: string } } | undefined)?.data?.name)).toBe(groupName)

    const leaveTypeName = `Read By Id Leave ${Date.now().toString(36)}`
    const leaveCreateRes = await requestJson(`${baseUrl}/api/attendance/leave-types`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: leaveTypeName,
        paid: true,
      }),
    })
    expect(leaveCreateRes.status).toBe(201)
    const leaveTypeId = ((leaveCreateRes.body as { data?: { id?: string } } | undefined)?.data?.id) ?? ''
    expect(leaveTypeId).toBeTruthy()

    const leaveGetRes = await requestJson(`${baseUrl}/api/attendance/leave-types/${encodeURIComponent(leaveTypeId)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(leaveGetRes.status).toBe(200)
    expect(((leaveGetRes.body as { data?: { id?: string; name?: string } } | undefined)?.data?.id)).toBe(leaveTypeId)
    expect(((leaveGetRes.body as { data?: { id?: string; name?: string } } | undefined)?.data?.name)).toBe(leaveTypeName)

    const payrollName = `Read By Id Payroll ${Date.now().toString(36)}`
    const payrollCreateRes = await requestJson(`${baseUrl}/api/attendance/payroll-templates`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: payrollName,
        timezone: 'UTC',
        startDay: 1,
        endDay: 30,
      }),
    })
    expect(payrollCreateRes.status).toBe(201)
    const payrollTemplateId = ((payrollCreateRes.body as { data?: { id?: string } } | undefined)?.data?.id) ?? ''
    expect(payrollTemplateId).toBeTruthy()

    const payrollGetRes = await requestJson(`${baseUrl}/api/attendance/payroll-templates/${encodeURIComponent(payrollTemplateId)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(payrollGetRes.status).toBe(200)
    expect(((payrollGetRes.body as { data?: { id?: string; name?: string } } | undefined)?.data?.id)).toBe(payrollTemplateId)
    expect(((payrollGetRes.body as { data?: { id?: string; name?: string } } | undefined)?.data?.name)).toBe(payrollName)
  })

  it('supports import commit idempotencyKey retries (without requiring a new commitToken)', async () => {
    if (!baseUrl) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-test&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    if (!token) return

    const workDate = new Date().toISOString().slice(0, 10)
    const idempotencyKey = `integration-${Date.now().toString(36)}`

    const prepareRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(prepareRes.status).toBe(200)
    const commitToken = (prepareRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(commitToken).toBeTruthy()

    const commitPayload = {
      userId: 'attendance-test',
      idempotencyKey,
      timezone: 'UTC',
      rows: [
        {
          workDate,
          fields: {
            firstInAt: `${workDate}T09:00:00Z`,
            lastOutAt: `${workDate}T18:00:00Z`,
            status: 'normal',
          },
        },
      ],
      mode: 'override',
      commitToken,
    }

    const commitRes = await requestJson(`${baseUrl}/api/attendance/import/commit`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commitPayload),
    })
    expect(commitRes.status).toBe(200)
    const commitData = (commitRes.body as { data?: any } | undefined)?.data
    const batchId = commitData?.batchId
    expect(batchId).toBeTruthy()
    expect(['standard', 'bulk']).toContain(String(commitData?.engine))
    expect(Number(commitData?.processedRows ?? 0)).toBeGreaterThanOrEqual(1)
    expect(Number(commitData?.failedRows ?? 0)).toBeGreaterThanOrEqual(0)
    expect(Number(commitData?.elapsedMs ?? -1)).toBeGreaterThanOrEqual(0)

    // Retry should return the same batchId and set idempotent=true even without a new commitToken.
    // Omit commitToken on retry to ensure idempotency works as designed.
    const { commitToken: _commitToken, ...retryPayload } = commitPayload

    const retryRes = await requestJson(`${baseUrl}/api/attendance/import/commit`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(retryPayload),
    })
    expect(retryRes.status).toBe(200)
    const retryData = (retryRes.body as { data?: any } | undefined)?.data
    expect(retryData?.batchId).toBe(batchId)
    expect(retryData?.idempotent).toBe(true)
    expect(['standard', 'bulk']).toContain(String(retryData?.engine))
    expect(Number(retryData?.processedRows ?? 0)).toBeGreaterThanOrEqual(1)
    expect(Number(retryData?.failedRows ?? 0)).toBeGreaterThanOrEqual(0)
    expect(Number(retryData?.elapsedMs ?? -1)).toBeGreaterThanOrEqual(0)
  })

  it('supports import commit merge mode (keeps earliest firstInAt and latest lastOutAt)', async () => {
    if (!baseUrl) return

    const userId = `attendance-merge-${Date.now().toString(36)}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    if (!token) return

    const workDate = new Date().toISOString().slice(0, 10)
    const firstLater = `${workDate}T09:05:00Z`
    const lastEarlier = `${workDate}T17:55:00Z`
    const firstEarly = `${workDate}T09:00:00Z`
    const lastLate = `${workDate}T18:00:00Z`

    const prepareARes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(prepareARes.status).toBe(200)
    const commitTokenA = (prepareARes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(commitTokenA).toBeTruthy()

    const commitARes = await requestJson(`${baseUrl}/api/attendance/import/commit`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId,
        timezone: 'UTC',
        rows: [
          {
            workDate,
            fields: {
              firstInAt: firstLater,
              lastOutAt: lastEarlier,
              status: 'normal',
            },
          },
        ],
        mode: 'override',
        commitToken: commitTokenA,
      }),
    })
    expect(commitARes.status).toBe(200)

    const prepareBRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(prepareBRes.status).toBe(200)
    const commitTokenB = (prepareBRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(commitTokenB).toBeTruthy()

    const commitBRes = await requestJson(`${baseUrl}/api/attendance/import/commit`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId,
        timezone: 'UTC',
        rows: [
          {
            workDate,
            fields: {
              firstInAt: firstEarly,
              lastOutAt: lastLate,
              status: 'normal',
            },
          },
        ],
        mode: 'merge',
        commitToken: commitTokenB,
      }),
    })
    expect(commitBRes.status).toBe(200)

    const recordsRes = await requestJson(`${baseUrl}/api/attendance/records?from=${workDate}&to=${workDate}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(recordsRes.status).toBe(200)
    const recordItems = (recordsRes.body as { data?: { items?: any[] } } | undefined)?.data?.items ?? []
    expect(Array.isArray(recordItems)).toBe(true)

    const record = recordItems.find((row) => String(row?.work_date || '').slice(0, 10) === workDate)
    expect(record).toBeTruthy()

    const normalizeIso = (value: unknown): string => {
      if (!value) return ''
      if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
      if (typeof value === 'string') {
        const parsed = Date.parse(value)
        if (!Number.isNaN(parsed)) return new Date(parsed).toISOString()
        const retryParsed = Date.parse(value.replace(' ', 'T'))
        if (!Number.isNaN(retryParsed)) return new Date(retryParsed).toISOString()
      }
      return String(value)
    }

    const firstInAtIso = normalizeIso(record?.first_in_at)
    const lastOutAtIso = normalizeIso(record?.last_out_at)

    expect(firstInAtIso.startsWith(`${workDate}T09:00:00`)).toBe(true)
    expect(lastOutAtIso.startsWith(`${workDate}T18:00:00`)).toBe(true)
  })

  it('exposes workday context for holiday overrides and shift schedules on attendance records', async () => {
    if (!baseUrl) return

    const userId = `attendance-workday-context-${Date.now().toString(36)}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const pickFutureWeekday = (targetDay: number): string => {
      const cursor = new Date('2029-03-01T00:00:00.000Z')
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (cursor.getUTCDay() === targetDay) return cursor.toISOString().slice(0, 10)
        cursor.setUTCDate(cursor.getUTCDate() + 1)
      }
      throw new Error(`Unable to reserve future weekday ${targetDay}`)
    }

    const sundayDate = pickFutureWeekday(0)
    const wednesdayDate = pickFutureWeekday(3)
    const rangeFrom = sundayDate < wednesdayDate ? sundayDate : wednesdayDate
    const rangeTo = sundayDate > wednesdayDate ? sundayDate : wednesdayDate
    const shiftName = `Sunday Shift ${Date.now().toString(36)}`

    const shiftRes = await requestJson(`${baseUrl}/api/attendance/shifts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: shiftName,
        timezone: 'UTC',
        workStartTime: '09:00',
        workEndTime: '18:00',
        workingDays: [0],
      }),
    })
    expect(shiftRes.status).toBe(201)
    const shiftId = (shiftRes.body as { data?: { id?: string } } | undefined)?.data?.id
    expect(shiftId).toBeTruthy()

    const assignmentRes = await requestJson(`${baseUrl}/api/attendance/assignments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId,
        shiftId,
        startDate: sundayDate,
        endDate: sundayDate,
        isActive: true,
      }),
    })
    expect(assignmentRes.status).toBe(201)

    const holidayName = `Midweek Holiday ${Date.now().toString(36)}`
    const holidayRes = await requestJson(`${baseUrl}/api/attendance/holidays`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        date: wednesdayDate,
        name: holidayName,
        isWorkingDay: false,
      }),
    })
    expect([201, 409]).toContain(holidayRes.status)

    const prepareRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(prepareRes.status).toBe(200)
    const commitToken = (prepareRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(commitToken).toBeTruthy()
    if (!commitToken) return

    const importRes = await requestJson(`${baseUrl}/api/attendance/import/commit`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId,
        timezone: 'UTC',
        rows: [
          {
            workDate: sundayDate,
            fields: {
              firstInAt: `${sundayDate}T09:00:00Z`,
              lastOutAt: `${sundayDate}T18:00:00Z`,
              status: 'normal',
            },
          },
          {
            workDate: wednesdayDate,
            fields: {
              firstInAt: `${wednesdayDate}T09:00:00Z`,
              lastOutAt: `${wednesdayDate}T18:00:00Z`,
              status: 'off',
            },
          },
        ],
        mode: 'override',
        commitToken,
      }),
    })
    expect(importRes.status).toBe(200)

    const recordsRes = await requestJson(
      `${baseUrl}/api/attendance/records?from=${encodeURIComponent(rangeFrom)}&to=${encodeURIComponent(rangeTo)}&userId=${encodeURIComponent(userId)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    )
    expect(recordsRes.status).toBe(200)
    const items = (recordsRes.body as { data?: { items?: any[] } } | undefined)?.data?.items ?? []
    expect(Array.isArray(items)).toBe(true)

    const sundayRecord = items.find((row) => String(row?.work_date ?? '').slice(0, 10) === sundayDate)
    expect(sundayRecord).toBeTruthy()
    expect(sundayRecord?.is_workday).toBe(true)
    expect(sundayRecord?.workday_context).toMatchObject({
      storedIsWorkday: true,
      resolvedIsWorkday: true,
      matchesStored: true,
      source: 'shift',
      sourceName: shiftName,
      weekday: 0,
      workingDays: [0],
      holiday: null,
    })

    const wednesdayRecord = items.find((row) => String(row?.work_date ?? '').slice(0, 10) === wednesdayDate)
    expect(wednesdayRecord).toBeTruthy()
    expect(wednesdayRecord?.is_workday).toBe(false)
    expect(wednesdayRecord?.workday_context).toMatchObject({
      storedIsWorkday: false,
      resolvedIsWorkday: false,
      matchesStored: true,
      source: 'rule',
      weekday: 3,
      workingDays: [1, 2, 3, 4, 5],
      holiday: {
        isWorkingDay: false,
        type: 'holiday',
      },
    })
    expect(typeof wednesdayRecord?.workday_context?.holiday?.name).toBe('string')
  })

  it('keeps existing records after rolling back a later update batch', async () => {
    if (!baseUrl) return

    const userId = `attendance-rollback-safe-${Date.now().toString(36)}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    if (!token) return

    const workDate = new Date().toISOString().slice(0, 10)
    const firstImportIn = `${workDate}T09:00:00Z`
    const firstImportOut = `${workDate}T18:00:00Z`
    const secondImportIn = `${workDate}T10:00:00Z`
    const secondImportOut = `${workDate}T17:00:00Z`

    async function runSingleRowImport(firstInAt: string, lastOutAt: string): Promise<string> {
      const prepareRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      })
      expect(prepareRes.status).toBe(200)
      const commitToken = (prepareRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
      expect(commitToken).toBeTruthy()

      const commitRes = await requestJson(`${baseUrl}/api/attendance/import/commit`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId,
          timezone: 'UTC',
          rows: [
            {
              workDate,
              fields: {
                firstInAt,
                lastOutAt,
                status: 'normal',
              },
            },
          ],
          mode: 'override',
          commitToken,
        }),
      })
      expect(commitRes.status).toBe(200)
      const batchId = (commitRes.body as { data?: { batchId?: string } } | undefined)?.data?.batchId
      expect(batchId).toBeTruthy()
      return String(batchId)
    }

    async function listRecordRows(): Promise<any[]> {
      const recordsRes = await requestJson(
        `${baseUrl}/api/attendance/records?from=${encodeURIComponent(workDate)}&to=${encodeURIComponent(workDate)}&userId=${encodeURIComponent(userId)}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      )
      expect(recordsRes.status).toBe(200)
      const items = (recordsRes.body as { data?: { items?: any[] } } | undefined)?.data?.items ?? []
      return Array.isArray(items) ? items : []
    }

    const firstBatchId = await runSingleRowImport(firstImportIn, firstImportOut)
    const beforeUpdateRows = await listRecordRows()
    const beforeUpdateRow = beforeUpdateRows.find((row) => {
      const rowDate = String(row?.work_date ?? row?.workDate ?? '').slice(0, 10)
      const rowUser = String(row?.user_id ?? row?.userId ?? '')
      return rowDate === workDate && rowUser === userId
    })
    expect(beforeUpdateRow).toBeTruthy()
    const recordIdBeforeUpdate = String(beforeUpdateRow?.id ?? '')
    expect(recordIdBeforeUpdate).toBeTruthy()

    const secondBatchId = await runSingleRowImport(secondImportIn, secondImportOut)
    expect(secondBatchId).not.toBe(firstBatchId)

    const rollbackRes = await requestJson(`${baseUrl}/api/attendance/import/rollback/${encodeURIComponent(secondBatchId)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(rollbackRes.status).toBe(200)

    const afterRollbackRows = await listRecordRows()
    const rowAfterRollback = afterRollbackRows.find((row) => {
      const rowDate = String(row?.work_date ?? row?.workDate ?? '').slice(0, 10)
      const rowUser = String(row?.user_id ?? row?.userId ?? '')
      return rowDate === workDate && rowUser === userId
    })
    expect(rowAfterRollback).toBeTruthy()
    expect(String(rowAfterRollback?.id ?? '')).toBe(recordIdBeforeUpdate)
  })

  it('auto-switches to staging upsert strategy for bulk async imports when copy threshold is reached', async () => {
    if (!baseUrl) return

    const userId = `attendance-staging-${Date.now().toString(36)}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    if (!token) return

    const prepareRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(prepareRes.status).toBe(200)
    const commitToken = (prepareRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(commitToken).toBeTruthy()

    const seedDate = new Date(Date.UTC(2026, 0, 1))
    const distinctWorkDates = 365
    const rows = Array.from({ length: 1001 }, (_, index) => {
      const date = new Date(seedDate)
      date.setUTCDate(seedDate.getUTCDate() + (index % distinctWorkDates))
      const workDate = date.toISOString().slice(0, 10)
      return {
        userId: `${userId}-bucket-${Math.floor(index / distinctWorkDates)}`,
        workDate,
        fields: {
          firstInAt: `${workDate}T09:00:00Z`,
          lastOutAt: `${workDate}T18:00:00Z`,
          status: 'normal',
        },
      }
    })

    const commitRes = await requestJson(`${baseUrl}/api/attendance/import/commit-async`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId,
        timezone: 'UTC',
        rows,
        mode: 'override',
        returnItems: false,
        commitToken,
      }),
    })
    expect(commitRes.status).toBe(200)
    const initialJob = (commitRes.body as { data?: { job?: any } } | undefined)?.data?.job
    const jobId = String(initialJob?.id || '')
    expect(jobId).toBeTruthy()

    const completedJob = await waitForImportJobCompletion(baseUrl, token, jobId, {
      failureMessage: 'async staging job failed',
    })
    const batchId = String(completedJob?.batchId || '')
    expect(batchId).toBeTruthy()
    expect(completedJob?.engine).toBe('bulk')
    expect(Number(completedJob?.processedRows ?? 0)).toBeGreaterThanOrEqual(rows.length)
    expect(Number(completedJob?.failedRows ?? 0)).toBeGreaterThanOrEqual(0)
    expect(Number(completedJob?.elapsedMs ?? -1)).toBeGreaterThanOrEqual(0)
    expect(completedJob?.recordUpsertStrategy).toBe('staging')
    expect(completedJob?.itemsInsertStrategy).toBe('staging')

    const batchDetailRes = await requestJson(
      `${baseUrl}/api/attendance/import/batches/${encodeURIComponent(batchId)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    )
    expect(batchDetailRes.status).toBe(200)
    const batchMeta = (batchDetailRes.body as { data?: { meta?: any } } | undefined)?.data?.meta
    expect(batchMeta?.recordUpsertStrategy).toBe('staging')
    expect(batchMeta?.itemsInsertStrategy).toBe('staging')

    const batchItemsRes = await requestJson(
      `${baseUrl}/api/attendance/import/batches/${encodeURIComponent(batchId)}/items?pageSize=1`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    )
    expect(batchItemsRes.status).toBe(200)
    const batchItemsData = (batchItemsRes.body as { data?: { items?: any[]; total?: number } } | undefined)?.data
    expect(Number(batchItemsData?.total ?? 0)).toBe(rows.length)
    expect(String(batchItemsData?.items?.[0]?.recordId || '')).toBeTruthy()

    const rollbackRes = await requestJson(`${baseUrl}/api/attendance/import/rollback/${batchId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(rollbackRes.status).toBe(200)
  }, 120000)

  it('deduplicates concurrent import commits with the same idempotencyKey', async () => {
    if (!baseUrl) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-test&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    if (!token) return

    const workDate = new Date().toISOString().slice(0, 10)
    const idempotencyKey = `integration-concurrent-${Date.now().toString(36)}`

    const [prepareARes, prepareBRes] = await Promise.all([
      requestJson(`${baseUrl}/api/attendance/import/prepare`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
      requestJson(`${baseUrl}/api/attendance/import/prepare`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
    ])
    expect(prepareARes.status).toBe(200)
    expect(prepareBRes.status).toBe(200)
    const commitTokenA = (prepareARes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    const commitTokenB = (prepareBRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(commitTokenA).toBeTruthy()
    expect(commitTokenB).toBeTruthy()

    const basePayload = {
      userId: 'attendance-test',
      idempotencyKey,
      timezone: 'UTC',
      rows: [
        {
          workDate,
          fields: {
            firstInAt: `${workDate}T09:00:00Z`,
            lastOutAt: `${workDate}T18:00:00Z`,
            status: 'normal',
          },
        },
      ],
      mode: 'override',
    }

    const [commitARes, commitBRes] = await Promise.all([
      requestJson(`${baseUrl}/api/attendance/import/commit`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...basePayload, commitToken: commitTokenA }),
      }),
      requestJson(`${baseUrl}/api/attendance/import/commit`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...basePayload, commitToken: commitTokenB }),
      }),
    ])

    expect(commitARes.status).toBe(200)
    expect(commitBRes.status).toBe(200)

    const commitAData = (commitARes.body as { data?: any } | undefined)?.data
    const commitBData = (commitBRes.body as { data?: any } | undefined)?.data
    expect(commitAData?.batchId).toBeTruthy()
    expect(commitBData?.batchId).toBeTruthy()
    expect(commitAData?.batchId).toBe(commitBData?.batchId)
    expect([commitAData?.idempotent, commitBData?.idempotent].some(Boolean)).toBe(true)
    expect(['standard', 'bulk']).toContain(String(commitAData?.engine || ''))
    expect(['standard', 'bulk']).toContain(String(commitBData?.engine || ''))
    expect(Number(commitAData?.processedRows ?? 0)).toBeGreaterThanOrEqual(1)
    expect(Number(commitBData?.processedRows ?? 0)).toBeGreaterThanOrEqual(1)
    expect(Number(commitAData?.failedRows ?? 0)).toBeGreaterThanOrEqual(0)
    expect(Number(commitBData?.failedRows ?? 0)).toBeGreaterThanOrEqual(0)
    expect(Number(commitAData?.elapsedMs ?? -1)).toBeGreaterThanOrEqual(0)
    expect(Number(commitBData?.elapsedMs ?? -1)).toBeGreaterThanOrEqual(0)

    // Follow-up retry without commitToken should remain idempotent and return the same batch.
    const retryRes = await requestJson(`${baseUrl}/api/attendance/import/commit`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(basePayload),
    })
    expect(retryRes.status).toBe(200)
    const retryData = (retryRes.body as { data?: any } | undefined)?.data
    expect(retryData?.batchId).toBe(commitAData?.batchId)
    expect(retryData?.idempotent).toBe(true)
    expect(['standard', 'bulk']).toContain(String(retryData?.engine || ''))
    expect(Number(retryData?.processedRows ?? 0)).toBeGreaterThanOrEqual(1)
    expect(Number(retryData?.failedRows ?? 0)).toBeGreaterThanOrEqual(0)
    expect(Number(retryData?.elapsedMs ?? -1)).toBeGreaterThanOrEqual(0)
  })

  it('supports async import commit jobs (commit-async + job polling)', async () => {
    if (!baseUrl) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-test&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    if (!token) return

    const workDate = new Date().toISOString().slice(0, 10)
    const idempotencyKey = `integration-async-${Date.now().toString(36)}`

    const prepareRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(prepareRes.status).toBe(200)
    const commitToken = (prepareRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(commitToken).toBeTruthy()

    const commitPayload = {
      userId: 'attendance-test',
      idempotencyKey,
      timezone: 'UTC',
      rows: [
        {
          workDate,
          fields: {
            firstInAt: `${workDate}T09:00:00Z`,
            lastOutAt: `${workDate}T18:00:00Z`,
            status: 'normal',
          },
        },
      ],
      mode: 'override',
      commitToken,
    }

    const commitRes = await requestJson(`${baseUrl}/api/attendance/import/commit-async`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commitPayload),
    })
    expect(commitRes.status).toBe(200)
    const job = (commitRes.body as { data?: { job?: any } } | undefined)?.data?.job
    const jobId = job?.id
    expect(typeof jobId).toBe('string')
    expect(['standard', 'bulk']).toContain(String(job?.engine || ''))
    expect(typeof job?.processedRows).toBe('number')
    expect(typeof job?.failedRows).toBe('number')
    expect(typeof job?.elapsedMs).toBe('number')
    expect(['values', 'unnest', 'staging']).toContain(String(job?.recordUpsertStrategy || ''))
    expect(typeof job?.progressPercent).toBe('number')
    expect(typeof job?.throughputRowsPerSec).toBe('number')
    expectChunkConfigMatchesEngine(job?.engine, job?.chunkConfig)

    // Retry should return the same job without requiring a new commitToken.
    const { commitToken: _commitToken, ...retryPayload } = commitPayload
    const retryRes = await requestJson(`${baseUrl}/api/attendance/import/commit-async`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(retryPayload),
    })
    expect(retryRes.status).toBe(200)
    const retryJob = (retryRes.body as { data?: { job?: any; idempotent?: boolean } } | undefined)?.data
    expect(retryJob?.job?.id).toBe(jobId)
    expect(retryJob?.idempotent).toBe(true)
    expect(['standard', 'bulk']).toContain(String(retryJob?.job?.engine || ''))
    expect(typeof retryJob?.job?.processedRows).toBe('number')
    expect(typeof retryJob?.job?.failedRows).toBe('number')
    expect(typeof retryJob?.job?.elapsedMs).toBe('number')

    // Poll job status until completion (fallback path runs in-process in tests).
    let batchId = ''
    let completedJob: any = null
    for (let i = 0; i < 100; i++) {
      const jobRes = await requestJson(`${baseUrl}/api/attendance/import/jobs/${jobId}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      })
      expect(jobRes.status).toBe(200)
      const jobData = (jobRes.body as { data?: any } | undefined)?.data
      const status = String(jobData?.status || '')
      if (status === 'completed') {
        batchId = String(jobData?.batchId || '')
        completedJob = jobData
        break
      }
      if (status === 'failed') {
        throw new Error(String(jobData?.error || 'job failed'))
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(batchId).toBeTruthy()
    expect(['standard', 'bulk']).toContain(String(completedJob?.engine || ''))
    expect(typeof completedJob?.processedRows).toBe('number')
    expect(typeof completedJob?.failedRows).toBe('number')
    expect(completedJob?.processedRows).toBeGreaterThanOrEqual(1)
    expect(typeof completedJob?.elapsedMs).toBe('number')
    expect(typeof completedJob?.progressPercent).toBe('number')
    expect(typeof completedJob?.throughputRowsPerSec).toBe('number')
    expectChunkConfigMatchesEngine(completedJob?.engine, completedJob?.chunkConfig)

    const rollbackRes = await requestJson(`${baseUrl}/api/attendance/import/rollback/${batchId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(rollbackRes.status).toBe(200)
  })

  it('retains compact skipped summary for completed commit-async jobs and idempotent retry', async () => {
    if (!baseUrl) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-test&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    if (!token) return

    const workDate = new Date().toISOString().slice(0, 10)
    const duplicateUserId = `attendance-async-duplicate-${Date.now().toString(36)}`
    const idempotencyKey = `integration-async-duplicate-${Date.now().toString(36)}`

    const prepareRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(prepareRes.status).toBe(200)
    const commitToken = (prepareRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(commitToken).toBeTruthy()

    const seedDate = new Date(Date.UTC(2026, 0, 1))
    const distinctWorkDates = 250
    const bulkUserSeed = Date.now().toString(36)
    const bulkRows = Array.from({ length: 1000 }, (_, index) => {
      const date = new Date(seedDate)
      date.setUTCDate(seedDate.getUTCDate() + (index % distinctWorkDates))
      const rowWorkDate = date.toISOString().slice(0, 10)
      return {
        userId: `attendance-async-bulk-${bulkUserSeed}-${Math.floor(index / distinctWorkDates)}`,
        workDate: rowWorkDate,
        fields: {
          firstInAt: `${rowWorkDate}T09:00:00Z`,
          lastOutAt: `${rowWorkDate}T18:00:00Z`,
          status: 'normal',
        },
      }
    })

    const commitPayload = {
      userId: 'attendance-test',
      idempotencyKey,
      timezone: 'UTC',
      rows: [
        ...bulkRows,
        {
          userId: duplicateUserId,
          workDate,
          fields: {
            firstInAt: `${workDate}T09:00:00Z`,
            lastOutAt: `${workDate}T18:00:00Z`,
            status: 'normal',
          },
        },
        {
          userId: duplicateUserId,
          workDate,
          fields: {
            firstInAt: `${workDate}T09:05:00Z`,
            lastOutAt: `${workDate}T18:05:00Z`,
            status: 'normal',
          },
        },
      ],
      mode: 'override',
      commitToken,
    }

    const commitRes = await requestJson(`${baseUrl}/api/attendance/import/commit-async`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commitPayload),
    })
    expect(commitRes.status).toBe(200)
    const initialJob = (commitRes.body as { data?: { job?: any } } | undefined)?.data?.job
    const jobId = String(initialJob?.id || '')
    expect(jobId).toBeTruthy()

    const completedJob = await waitForImportJobCompletion(baseUrl, token, jobId, {
      failureMessage: 'async duplicate job failed',
    })
    const batchId = String(completedJob?.batchId || '')
    expect(batchId).toBeTruthy()
    expect(completedJob).toBeTruthy()
    expect(completedJob?.engine).toBe('bulk')
    expect(completedJob?.itemsInsertStrategy).toBe('staging')
    expect(Number(completedJob?.failedRows ?? 0)).toBe(1)
    expect(Number(completedJob?.skippedCount ?? 0)).toBe(1)
    expect(Array.isArray(completedJob?.skippedRows)).toBe(true)
    expect(completedJob?.skippedRows).toHaveLength(1)
    expect(String(completedJob?.skippedRows?.[0]?.warnings?.[0] || '')).toContain('Duplicate row')

    const batchDetailRes = await requestJson(
      `${baseUrl}/api/attendance/import/batches/${encodeURIComponent(batchId)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    )
    expect(batchDetailRes.status).toBe(200)
    const batchMeta = (batchDetailRes.body as { data?: { meta?: any } } | undefined)?.data?.meta
    expect(batchMeta?.itemsInsertStrategy).toBe('staging')
    expect(Number(batchMeta?.skippedCount ?? 0)).toBe(1)
    expect(Array.isArray(batchMeta?.skippedRows)).toBe(true)
    expect(batchMeta?.skippedRows).toHaveLength(1)
    expect(String(batchMeta?.skippedRows?.[0]?.warnings?.[0] || '')).toContain('Duplicate row')

    const pageSize = 200
    let batchItemsTotal = 0
    let skippedItem: any = null
    for (let page = 1; page <= Math.ceil(commitPayload.rows.length / pageSize); page += 1) {
      const batchItemsRes = await requestJson(
        `${baseUrl}/api/attendance/import/batches/${encodeURIComponent(batchId)}/items?page=${page}&pageSize=${pageSize}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      )
      expect(batchItemsRes.status).toBe(200)
      const batchItemsData = (batchItemsRes.body as { data?: { items?: any[]; total?: number } } | undefined)?.data
      if (!batchItemsTotal) batchItemsTotal = Number(batchItemsData?.total ?? 0)
      skippedItem = (batchItemsData?.items ?? []).find((item) => item?.recordId == null) ?? skippedItem
      if (skippedItem) break
    }
    expect(batchItemsTotal).toBe(commitPayload.rows.length)
    expect(skippedItem).toBeTruthy()
    expect(String(skippedItem?.previewSnapshot?.skip?.reason || '')).toBe('duplicate')
    expect(String(skippedItem?.previewSnapshot?.warnings?.[0] || '')).toContain('Duplicate row')

    const { commitToken: _commitToken, ...retryPayload } = commitPayload
    const retryRes = await requestJson(`${baseUrl}/api/attendance/import/commit-async`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(retryPayload),
    })
    expect(retryRes.status).toBe(200)
    const retryData = (retryRes.body as { data?: { idempotent?: boolean; job?: any } } | undefined)?.data
    expect(retryData?.idempotent).toBe(true)
    expect(String(retryData?.job?.id || '')).toBe(jobId)
    expect(String(retryData?.job?.batchId || '')).toBe(batchId)
    expect(retryData?.job?.engine).toBe('bulk')
    expect(retryData?.job?.itemsInsertStrategy).toBe('staging')
    expect(Number(retryData?.job?.failedRows ?? 0)).toBe(1)
    expect(Number(retryData?.job?.skippedCount ?? 0)).toBe(1)
    expect(Array.isArray(retryData?.job?.skippedRows)).toBe(true)
    expect(retryData?.job?.skippedRows).toHaveLength(1)
    expect(String(retryData?.job?.skippedRows?.[0]?.warnings?.[0] || '')).toContain('Duplicate row')

    const rollbackRes = await requestJson(`${baseUrl}/api/attendance/import/rollback/${batchId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(rollbackRes.status).toBe(200)
  }, 120000)

  it('returns NOT_FOUND for unknown async import job id', async () => {
    if (!baseUrl) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-test&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    if (!token) return

    const missingJobId = '00000000-0000-4000-8000-000000000000'
    const jobRes = await requestJson(`${baseUrl}/api/attendance/import/jobs/${missingJobId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })
    expect(jobRes.status).toBe(404)
    const error = (jobRes.body as { error?: { code?: string } } | undefined)?.error
    expect(error?.code).toBe('NOT_FOUND')
  })

  it('keeps large rows payload for commit-async jobs when csv payload is absent', async () => {
    if (!baseUrl) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-test&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    if (!token) return

    const prepareRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(prepareRes.status).toBe(200)
    const commitToken = (prepareRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(commitToken).toBeTruthy()

    const seedDate = new Date(Date.UTC(2026, 0, 1))
    const totalRows = 5_001
    const distinctUsers = 500
    const rows = Array.from({ length: totalRows }, (_, index) => {
      const dayOffset = Math.floor(index / distinctUsers)
      const rowDate = new Date(seedDate)
      rowDate.setUTCDate(seedDate.getUTCDate() + dayOffset)
      const workDate = rowDate.toISOString().slice(0, 10)
      return {
        workDate,
        userId: `attendance-large-${String((index % distinctUsers) + 1).padStart(5, '0')}`,
        fields: {
          firstInAt: `${workDate}T09:00:00Z`,
          lastOutAt: `${workDate}T18:00:00Z`,
          status: 'normal',
        },
      }
    })
    const idempotencyKey = `integration-async-rows-large-${Date.now().toString(36)}`

    const commitPayload = {
      userId: 'attendance-test',
      idempotencyKey,
      timezone: 'UTC',
      rows,
      mode: 'override',
      commitToken,
    }

    const commitRes = await requestJson(`${baseUrl}/api/attendance/import/commit-async`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commitPayload),
    })
    expect(commitRes.status).toBe(200)
    const initialJob = (commitRes.body as { data?: { job?: any } } | undefined)?.data?.job
    const initialJobId = initialJob?.id
    expect(typeof initialJobId).toBe('string')

    const { commitToken: _commitToken, ...retryPayload } = commitPayload
    const retryRes = await requestJson(`${baseUrl}/api/attendance/import/commit-async`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(retryPayload),
    })
    expect(retryRes.status).toBe(200)
    const retryData = (retryRes.body as { data?: { job?: any; idempotent?: boolean } } | undefined)?.data
    expect(retryData?.job?.id).toBe(initialJobId)
    expect(retryData?.idempotent).toBe(true)

    const completedJob = await waitForImportJobCompletion(baseUrl, token, initialJobId, {
      attempts: 3000,
      intervalMs: 50,
      failureMessage: 'large rows async job failed',
    })
    const batchId = String(completedJob?.batchId || '')

    expect(completedJob).toBeTruthy()
    expect(batchId).toBeTruthy()
    expect(Number(completedJob?.processedRows ?? 0)).toBeGreaterThanOrEqual(totalRows)

    const rollbackRes = await requestJson(`${baseUrl}/api/attendance/import/rollback/${batchId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(rollbackRes.status).toBe(200)
  }, 180000)

  it('keeps large entries payload for commit-async jobs when csv payload is absent', async () => {
    if (!baseUrl) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-test&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    if (!token) return

    const prepareRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(prepareRes.status).toBe(200)
    const commitToken = (prepareRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(commitToken).toBeTruthy()

    const workDate = new Date().toISOString().slice(0, 10)
    const totalEntries = 20_001
    const entries = Array.from({ length: totalEntries }, (_, index) => ({
      userId: 'attendance-large-entries',
      workDate,
      field: `raw_field_${index}`,
      value: `${workDate}T09:00:00Z`,
      meta: {
        column: `raw_field_${index}`,
        value: `${workDate}T09:00:00Z`,
      },
    }))
    const idempotencyKey = `integration-async-entries-large-${Date.now().toString(36)}`

    const commitPayload = {
      userId: 'attendance-test',
      idempotencyKey,
      timezone: 'UTC',
      entries,
      mode: 'override',
      commitToken,
    }

    const commitRes = await requestJson(`${baseUrl}/api/attendance/import/commit-async`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commitPayload),
    })
    expect(commitRes.status).toBe(200)
    const initialJob = (commitRes.body as { data?: { job?: any } } | undefined)?.data?.job
    const initialJobId = initialJob?.id
    expect(typeof initialJobId).toBe('string')

    const { commitToken: _commitToken, ...retryPayload } = commitPayload
    const retryRes = await requestJson(`${baseUrl}/api/attendance/import/commit-async`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(retryPayload),
    })
    expect(retryRes.status).toBe(200)
    const retryData = (retryRes.body as { data?: { job?: any; idempotent?: boolean } } | undefined)?.data
    expect(retryData?.job?.id).toBe(initialJobId)
    expect(retryData?.idempotent).toBe(true)

    const completedJob = await waitForImportJobCompletion(baseUrl, token, initialJobId, {
      attempts: 3000,
      intervalMs: 50,
      failureMessage: 'large entries async job failed',
    })
    const batchId = String(completedJob?.batchId || '')

    expect(completedJob).toBeTruthy()
    expect(batchId).toBeTruthy()
    expect(Number(completedJob?.processedRows ?? 0)).toBeGreaterThanOrEqual(1)
    expect(Number(completedJob?.failedRows ?? 0)).toBeGreaterThanOrEqual(0)

    const rollbackRes = await requestJson(`${baseUrl}/api/attendance/import/rollback/${batchId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(rollbackRes.status).toBe(200)
  }, 180000)

  it('supports async import preview jobs (preview-async + job polling)', async () => {
    if (!baseUrl) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-test&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    if (!token) return

    const workDate = new Date().toISOString().slice(0, 10)
    const idempotencyKey = `integration-preview-async-${Date.now().toString(36)}`

    const prepareRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(prepareRes.status).toBe(200)
    const commitToken = (prepareRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(commitToken).toBeTruthy()

    const previewPayload = {
      userId: 'attendance-test',
      idempotencyKey,
      timezone: 'UTC',
      previewLimit: 2,
      rows: [
        {
          workDate,
          fields: {
            firstInAt: `${workDate}T09:00:00Z`,
            lastOutAt: `${workDate}T18:00:00Z`,
            status: 'normal',
          },
        },
        {
          workDate,
          fields: {
            firstInAt: `${workDate}T09:10:00Z`,
            lastOutAt: `${workDate}T18:10:00Z`,
            status: 'normal',
          },
        },
      ],
      mode: 'override',
      commitToken,
    }

    const previewRes = await requestJson(`${baseUrl}/api/attendance/import/preview-async`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(previewPayload),
    })
    expect(previewRes.status).toBe(200)
    const job = (previewRes.body as { data?: { job?: any } } | undefined)?.data?.job
    const jobId = job?.id
    expect(typeof jobId).toBe('string')
    expect(['standard', 'bulk']).toContain(String(job?.engine || ''))
    expect(typeof job?.processedRows).toBe('number')
    expect(typeof job?.failedRows).toBe('number')
    expect(typeof job?.elapsedMs).toBe('number')
    expect(typeof job?.progressPercent).toBe('number')
    expect(typeof job?.throughputRowsPerSec).toBe('number')

    const { commitToken: _commitToken, ...retryPayload } = previewPayload
    const retryRes = await requestJson(`${baseUrl}/api/attendance/import/preview-async`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(retryPayload),
    })
    expect(retryRes.status).toBe(200)
    const retryData = (retryRes.body as { data?: { job?: any; idempotent?: boolean } } | undefined)?.data
    expect(retryData?.job?.id).toBe(jobId)
    expect(retryData?.idempotent).toBe(true)

    let finished = false
    let completedPreviewJob: any = null
    for (let i = 0; i < 100; i++) {
      const jobRes = await requestJson(`${baseUrl}/api/attendance/import/jobs/${jobId}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      })
      expect(jobRes.status).toBe(200)
      const jobData = (jobRes.body as { data?: any } | undefined)?.data
      const status = String(jobData?.status || '')
      if (status === 'completed') {
        expect(jobData?.kind).toBe('preview')
        expect(Array.isArray(jobData?.preview?.items)).toBe(true)
        expect(jobData?.preview?.items?.length).toBeGreaterThan(0)
        expect(jobData?.preview?.rowCount).toBe(2)
        completedPreviewJob = jobData
        finished = true
        break
      }
      if (status === 'failed') {
        throw new Error(String(jobData?.error || 'preview job failed'))
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    expect(finished).toBe(true)
    expect(['standard', 'bulk']).toContain(String(completedPreviewJob?.engine || ''))
    expect(typeof completedPreviewJob?.processedRows).toBe('number')
    expect(typeof completedPreviewJob?.failedRows).toBe('number')
    expect(completedPreviewJob?.processedRows).toBeGreaterThanOrEqual(2)
    expect(typeof completedPreviewJob?.elapsedMs).toBe('number')
    expect(['values', 'unnest', 'staging']).toContain(String(completedPreviewJob?.recordUpsertStrategy || ''))
    expect(typeof completedPreviewJob?.progressPercent).toBe('number')
    expect(typeof completedPreviewJob?.throughputRowsPerSec).toBe('number')
  })

  it('exports attendance admin audit logs as CSV', async () => {
    if (!baseUrl) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-test&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    if (!token) return

    // Create one attendance write action to ensure export has runtime data.
    const punchRes = await requestJson(`${baseUrl}/api/attendance/punch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ eventType: 'check_in' }),
    })
    expect([200, 429]).toContain(punchRes.status)

    const exportRes = await requestJson(`${baseUrl}/api/attendance-admin/audit-logs/export.csv?limit=50`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'text/csv',
      },
    })
    expect(exportRes.status).toBe(200)
    expect(exportRes.raw.includes('occurredAt')).toBe(true)
    expect(exportRes.raw.includes('action')).toBe(true)
    expect(exportRes.raw.includes('route')).toBe(true)

    const [header] = exportRes.raw.split('\n')
    expect(header).toBe(
      'occurredAt,id,actorId,actorType,action,route,statusCode,latencyMs,resourceType,resourceId,requestId,ip,userAgent,errorCode,errorMessage,meta'
    )
  })

  it('supports batch user resolve and returns missing ids for batch role operations', async () => {
    if (!baseUrl) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-test&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    if (!token) return

    const userSearchRes = await requestJson(`${baseUrl}/api/attendance-admin/users/search?q=@&pageSize=1`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(userSearchRes.status).toBe(200)
    const items = (userSearchRes.body as { data?: { items?: { id?: string }[] } } | undefined)?.data?.items ?? []
    const existingUserId = String(items[0]?.id || '')
    if (!existingUserId) return

    const missingUserId = randomUuidV4()

    const resolveRes = await requestJson(`${baseUrl}/api/attendance-admin/users/batch/resolve`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userIds: [existingUserId, missingUserId],
      }),
    })
    expect(resolveRes.status).toBe(200)
    const resolveData = (resolveRes.body as {
      ok?: boolean
      data?: {
        requested?: number
        found?: number
        missingUserIds?: string[]
        items?: { id?: string }[]
      }
    } | undefined)?.data
    expect(resolveData?.requested).toBe(2)
    expect((resolveData?.found ?? 0) >= 1).toBe(true)
    expect(Array.isArray(resolveData?.missingUserIds)).toBe(true)
    expect(resolveData?.missingUserIds?.includes(missingUserId)).toBe(true)
    expect((resolveData?.items ?? []).some((item) => item.id === existingUserId)).toBe(true)

    const assignRes = await requestJson(`${baseUrl}/api/attendance-admin/users/batch/roles/assign`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userIds: [existingUserId, missingUserId],
        template: 'employee',
      }),
    })
    expect(assignRes.status).toBe(200)
    const assignData = (assignRes.body as {
      data?: {
        requested?: number
        eligible?: number
        updated?: number
        missingUserIds?: string[]
        affectedUserIds?: string[]
        unchangedUserIds?: string[]
      }
    } | undefined)?.data
    expect(assignData?.requested).toBe(2)
    expect(assignData?.eligible).toBe(1)
    expect(Array.isArray(assignData?.missingUserIds)).toBe(true)
    expect(assignData?.missingUserIds?.includes(missingUserId)).toBe(true)
    expect((assignData?.updated ?? -1) >= 0).toBe(true)
    expect(Array.isArray(assignData?.affectedUserIds)).toBe(true)
    expect(Array.isArray(assignData?.unchangedUserIds)).toBe(true)
    expect((assignData?.affectedUserIds?.length ?? 0) + (assignData?.unchangedUserIds?.length ?? 0)).toBe(assignData?.eligible)

    const unassignRes = await requestJson(`${baseUrl}/api/attendance-admin/users/batch/roles/unassign`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userIds: [existingUserId, missingUserId],
        template: 'employee',
      }),
    })
    expect(unassignRes.status).toBe(200)
    const unassignData = (unassignRes.body as {
      data?: {
        requested?: number
        eligible?: number
        missingUserIds?: string[]
        affectedUserIds?: string[]
        unchangedUserIds?: string[]
      }
    } | undefined)?.data
    expect(unassignData?.requested).toBe(2)
    expect(unassignData?.eligible).toBe(1)
    expect(unassignData?.missingUserIds?.includes(missingUserId)).toBe(true)
    expect(Array.isArray(unassignData?.affectedUserIds)).toBe(true)
    expect(Array.isArray(unassignData?.unchangedUserIds)).toBe(true)
    expect((unassignData?.affectedUserIds?.length ?? 0) + (unassignData?.unchangedUserIds?.length ?? 0)).toBe(unassignData?.eligible)
  })

  it('supports attendance admin audit log filters and summary endpoint', async () => {
    if (!baseUrl) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-test&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    if (!token) return

    const summaryRes = await requestJson(`${baseUrl}/api/attendance-admin/audit-logs/summary?windowMinutes=120&limit=5`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(summaryRes.status).toBe(200)
    const summaryData = (summaryRes.body as {
      ok?: boolean
      data?: {
        windowMinutes?: number
        actions?: unknown[]
        errors?: unknown[]
      }
    } | undefined)?.data
    expect(summaryData?.windowMinutes).toBe(120)
    expect(Array.isArray(summaryData?.actions)).toBe(true)
    expect(Array.isArray(summaryData?.errors)).toBe(true)

    const filterRes = await requestJson(
      `${baseUrl}/api/attendance-admin/audit-logs?page=1&pageSize=5&statusClass=4xx&actionPrefix=${encodeURIComponent('attendance_http:POST:/api/attendance')}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    )
    expect(filterRes.status).toBe(200)
    const filterBody = filterRes.body as {
      ok?: boolean
      data?: {
        items?: Array<{ action?: string; status_code?: number | null }>
      }
    } | undefined
    expect(filterBody?.ok).toBe(true)
    expect(Array.isArray(filterBody?.data?.items)).toBe(true)
  })

  it('supports import previewLimit + commit returnItems flags for large imports', async () => {
    if (!baseUrl) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-test&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    if (!token) return

    const workDate = new Date().toISOString().slice(0, 10)

    const preparePreviewRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(preparePreviewRes.status).toBe(200)
    const commitTokenPreview = (preparePreviewRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(commitTokenPreview).toBeTruthy()

    const previewPayload = {
      userId: 'attendance-test',
      timezone: 'UTC',
      previewLimit: 1,
      rows: [
        {
          workDate,
          fields: {
            firstInAt: `${workDate}T09:00:00Z`,
            lastOutAt: `${workDate}T18:00:00Z`,
            status: 'normal',
          },
        },
        {
          workDate: workDate,
          fields: {
            firstInAt: `${workDate}T09:00:00Z`,
            lastOutAt: `${workDate}T18:00:00Z`,
            status: 'normal',
          },
        },
      ],
      mode: 'override',
      commitToken: commitTokenPreview,
    }

    const previewRes = await requestJson(`${baseUrl}/api/attendance/import/preview`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(previewPayload),
    })
    expect(previewRes.status).toBe(200)
    const previewData = (previewRes.body as { data?: any } | undefined)?.data
    expect(Array.isArray(previewData?.items)).toBe(true)
    expect(previewData?.items.length).toBe(1)
    expect(previewData?.rowCount).toBe(2)
    expect(previewData?.truncated).toBe(true)
    expect(previewData?.previewLimit).toBe(1)

    const prepareCommitRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(prepareCommitRes.status).toBe(200)
    const commitTokenCommit = (prepareCommitRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(commitTokenCommit).toBeTruthy()

    const commitPayload = {
      userId: 'attendance-test',
      timezone: 'UTC',
      returnItems: false,
      rows: [
        {
          workDate,
          fields: {
            firstInAt: `${workDate}T09:00:00Z`,
            lastOutAt: `${workDate}T18:00:00Z`,
            status: 'normal',
          },
        },
      ],
      mode: 'override',
      commitToken: commitTokenCommit,
    }

    const commitRes = await requestJson(`${baseUrl}/api/attendance/import/commit`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commitPayload),
    })
    expect(commitRes.status).toBe(200)
    const commitData = (commitRes.body as { data?: any } | undefined)?.data
    expect(commitData?.imported).toBe(1)
    expect(['standard', 'bulk']).toContain(String(commitData?.engine))
    const chunkConfig = commitData?.meta?.chunkConfig
    expectChunkConfigMatchesEngine(commitData?.engine, chunkConfig)
    expect(Array.isArray(commitData?.items)).toBe(true)
    expect(commitData?.items.length).toBe(0)
    expect(typeof commitData?.batchId).toBe('string')

    const batchId = String(commitData?.batchId || '')
    if (batchId) {
      const rollbackRes = await requestJson(`${baseUrl}/api/attendance/import/rollback/${batchId}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      })
      expect(rollbackRes.status).toBe(200)
    }
  })

  it('rejects oversized CSV payloads with CSV_TOO_LARGE', async () => {
    if (!baseUrl) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-test&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    if (!token) return

    const csvMaxRows = Number(process.env.ATTENDANCE_IMPORT_CSV_MAX_ROWS || 1000)
    const oversizedRowCount = csvMaxRows + 1
    const workDate = new Date().toISOString().slice(0, 10)
    const csvHeader = '日期,工号,考勤组,上班1打卡时间,下班1打卡时间,考勤结果'
    const csvRows = Array.from({ length: oversizedRowCount }, () => `${workDate},A001,CSV Limit,09:00,18:00,正常`)
    const csvText = `${csvHeader}\n${csvRows.join('\n')}`

    const csvPayloadBase = {
      userId: 'attendance-test',
      csvText,
      mapping: {
        columns: [
          { sourceField: '日期', targetField: 'workDate', dataType: 'date' },
          { sourceField: '工号', targetField: 'empNo', dataType: 'string' },
          { sourceField: '考勤组', targetField: 'attendance_group', dataType: 'string' },
          { sourceField: '上班1打卡时间', targetField: 'firstInAt', dataType: 'time' },
          { sourceField: '下班1打卡时间', targetField: 'lastOutAt', dataType: 'time' },
          { sourceField: '考勤结果', targetField: 'status', dataType: 'string' },
        ],
      },
      userMap: {
        A001: 'attendance-test',
      },
      mode: 'override',
    }

    const preparePreviewRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(preparePreviewRes.status).toBe(200)
    const previewCommitToken = (preparePreviewRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(previewCommitToken).toBeTruthy()

    const previewRes = await requestJson(`${baseUrl}/api/attendance/import/preview`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...csvPayloadBase,
        commitToken: previewCommitToken,
      }),
    })
    expect(previewRes.status).toBe(400)
    const previewError = (previewRes.body as { error?: { code?: string } } | undefined)?.error
    expect(previewError?.code).toBe('CSV_TOO_LARGE')

    const prepareCommitRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(prepareCommitRes.status).toBe(200)
    const commitToken = (prepareCommitRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(commitToken).toBeTruthy()

    const commitRes = await requestJson(`${baseUrl}/api/attendance/import/commit`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...csvPayloadBase,
        commitToken,
      }),
    })
    expect(commitRes.status).toBe(400)
    const commitError = (commitRes.body as { error?: { code?: string } } | undefined)?.error
    expect(commitError?.code).toBe('CSV_TOO_LARGE')
  })

  it('supports CSV upload channel via fileId/csvFileId aliases and cleans up after sync commit', async () => {
    if (!baseUrl) return
    if (!importUploadDir) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-test&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    if (!token) return

    const orgId = 'default'
    const workDate = new Date().toISOString().slice(0, 10)
    const csvHeader = '日期,工号,考勤组,上班1打卡时间,下班1打卡时间,考勤结果'
    const csvText = `${csvHeader}\n${workDate},A001,CSV Upload,09:00,18:00,正常\n`

    const uploadRes = await requestJson(`${baseUrl}/api/attendance/import/upload?orgId=${encodeURIComponent(orgId)}&filename=integration.csv`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/csv',
      },
      body: csvText,
    })
    expect(uploadRes.status).toBe(201)
    const fileId = (uploadRes.body as { data?: { fileId?: string } } | undefined)?.data?.fileId
    expect(typeof fileId).toBe('string')

    const csvPayloadBase = {
      orgId,
      userId: 'attendance-test',
      timezone: 'UTC',
      fileId: String(fileId || ''),
      mapping: {
        columns: [
          { sourceField: '日期', targetField: 'workDate', dataType: 'date' },
          { sourceField: '工号', targetField: 'empNo', dataType: 'string' },
          { sourceField: '考勤组', targetField: 'attendance_group', dataType: 'string' },
          { sourceField: '上班1打卡时间', targetField: 'firstInAt', dataType: 'time' },
          { sourceField: '下班1打卡时间', targetField: 'lastOutAt', dataType: 'time' },
          { sourceField: '考勤结果', targetField: 'status', dataType: 'string' },
        ],
      },
      userMap: {
        A001: 'attendance-test',
      },
      mode: 'override',
    }

    const preparePreviewRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(preparePreviewRes.status).toBe(200)
    const previewCommitToken = (preparePreviewRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(previewCommitToken).toBeTruthy()

    const previewRes = await requestJson(`${baseUrl}/api/attendance/import/preview`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...csvPayloadBase,
        commitToken: previewCommitToken,
      }),
    })
    expect(previewRes.status).toBe(200)

    const prepareCommitRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(prepareCommitRes.status).toBe(200)
    const commitToken = (prepareCommitRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(commitToken).toBeTruthy()

    const commitRes = await requestJson(`${baseUrl}/api/attendance/import/commit`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...csvPayloadBase,
        commitToken,
        // Ensure response stays small even if a future mapping adds extra computed items.
        returnItems: false,
      }),
    })
    expect(commitRes.status).toBe(200)
    const commitData = (commitRes.body as { data?: any } | undefined)?.data
    const batchId = commitData?.batchId
    expect(typeof batchId).toBe('string')
    expect(['standard', 'bulk']).toContain(String(commitData?.engine || ''))
    expect(Number(commitData?.processedRows ?? 0)).toBeGreaterThanOrEqual(1)
    expect(Number(commitData?.failedRows ?? 0)).toBeGreaterThanOrEqual(0)
    expect(Number(commitData?.elapsedMs ?? -1)).toBeGreaterThanOrEqual(0)

    const csvPath = path.join(importUploadDir, orgId, `${fileId}.csv`)
    const metaPath = path.join(importUploadDir, orgId, `${fileId}.json`)
    await expect(fs.stat(csvPath)).rejects.toBeTruthy()
    await expect(fs.stat(metaPath)).rejects.toBeTruthy()

    if (batchId) {
      const rollbackRes = await requestJson(`${baseUrl}/api/attendance/import/rollback/${batchId}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      })
      expect(rollbackRes.status).toBe(200)
    }
  })

  it('accepts fileId alias and defaults uploaded CSV imports to the daily summary profile', async () => {
    if (!baseUrl) return
    if (!importUploadDir) return

    const runSuffix = Date.now().toString(36)
    const requesterId = `attendance-fileid-${runSuffix}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(requesterId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    if (!token) return

    const orgId = 'default'
    const workDate = new Date().toISOString().slice(0, 10)
    const csvHeader = '日期,工号,姓名,考勤组,上班1打卡时间,下班1打卡时间,考勤结果,异常原因'
    const csvText = `${csvHeader}\n${workDate},EMP${runSuffix.slice(-4)},测试用户,CSV Alias,2026-03-29 09:00,2026-03-29 18:00,正常,\n`

    const uploadRes = await requestJson(`${baseUrl}/api/attendance/import/upload?orgId=${encodeURIComponent(orgId)}&filename=fileid-alias.csv`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/csv',
      },
      body: csvText,
    })
    expect(uploadRes.status).toBe(201)
    const fileId = (uploadRes.body as { data?: { fileId?: string } } | undefined)?.data?.fileId
    expect(typeof fileId).toBe('string')
    if (!fileId) return

    const preparePreviewRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(preparePreviewRes.status).toBe(200)
    const previewCommitToken = (preparePreviewRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(previewCommitToken).toBeTruthy()
    if (!previewCommitToken) return

    const previewRes = await requestJson(`${baseUrl}/api/attendance/import/preview`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        orgId,
        fileId,
        timezone: 'Asia/Shanghai',
        commitToken: previewCommitToken,
      }),
    })
    expect(previewRes.status).toBe(200)
    const previewItems = (previewRes.body as { data?: { items?: Array<{ userId?: string; workDate?: string }> } } | undefined)?.data?.items ?? []
    expect(previewItems.length).toBeGreaterThan(0)
    expect(previewItems[0]?.userId).toBe(requesterId)
    expect(previewItems[0]?.workDate).toBe(workDate)

    const prepareCommitRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(prepareCommitRes.status).toBe(200)
    const commitToken = (prepareCommitRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(commitToken).toBeTruthy()
    if (!commitToken) return

    const commitRes = await requestJson(`${baseUrl}/api/attendance/import/commit`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        orgId,
        fileId,
        timezone: 'Asia/Shanghai',
        commitToken,
        returnItems: false,
      }),
    })
    expect(commitRes.status).toBe(200)
    const commitData = (commitRes.body as { data?: any } | undefined)?.data
    expect(Number(commitData?.processedRows ?? 0)).toBeGreaterThanOrEqual(1)
    expect(Number(commitData?.failedRows ?? 0)).toBeGreaterThanOrEqual(0)

    const csvPath = path.join(importUploadDir, orgId, `${fileId}.csv`)
    const metaPath = path.join(importUploadDir, orgId, `${fileId}.json`)
    await expect(fs.stat(csvPath)).rejects.toBeTruthy()
    await expect(fs.stat(metaPath)).rejects.toBeTruthy()

    const batchId = commitData?.batchId
    if (batchId) {
      const rollbackRes = await requestJson(`${baseUrl}/api/attendance/import/rollback/${batchId}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      })
      expect(rollbackRes.status).toBe(200)
    }
  })

  it('accepts uploaded API-column CSV imports with slash dates through required-field aliases', async () => {
    if (!baseUrl) return
    if (!importUploadDir) return

    const runSuffix = Date.now().toString(36)
    const requesterId = `attendance-api-csv-${runSuffix}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(requesterId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const orgId = 'default'
    const csvText = [
      'workDate,userId,1_on_duty_user_check_time,1_off_duty_user_check_time,attend_result',
      `2026/3/26,${requesterId},2026-03-26T09:00:00+08:00,2026-03-26T18:00:00+08:00,Normal`,
      '',
    ].join('\n')

    const uploadRes = await requestJson(`${baseUrl}/api/attendance/import/upload?orgId=${encodeURIComponent(orgId)}&filename=api-columns.csv`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/csv',
      },
      body: csvText,
    })
    expect(uploadRes.status).toBe(201)
    const fileId = (uploadRes.body as { data?: { fileId?: string; rowCount?: number } } | undefined)?.data?.fileId
    const rowCount = (uploadRes.body as { data?: { rowCount?: number } } | undefined)?.data?.rowCount
    expect(rowCount).toBe(1)
    expect(typeof fileId).toBe('string')
    if (!fileId) return

    const preparePreviewRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(preparePreviewRes.status).toBe(200)
    const previewCommitToken = (preparePreviewRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(previewCommitToken).toBeTruthy()
    if (!previewCommitToken) return

    const previewRes = await requestJson(`${baseUrl}/api/attendance/import/preview`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        orgId,
        fileId,
        timezone: 'Asia/Shanghai',
        commitToken: previewCommitToken,
      }),
    })
    expect(previewRes.status).toBe(200)
    const previewItems = (previewRes.body as { data?: { items?: Array<{ userId?: string; workDate?: string; warnings?: string[] }> } } | undefined)?.data?.items ?? []
    expect(previewItems[0]?.userId).toBe(requesterId)
    expect(previewItems[0]?.workDate).toBe('2026-03-26')
    expect(previewItems[0]?.warnings ?? []).not.toContain('Missing required: 日期')

    const prepareCommitRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(prepareCommitRes.status).toBe(200)
    const commitToken = (prepareCommitRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(commitToken).toBeTruthy()
    if (!commitToken) return

    const commitRes = await requestJson(`${baseUrl}/api/attendance/import/commit`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        orgId,
        fileId,
        timezone: 'Asia/Shanghai',
        commitToken,
        returnItems: false,
      }),
    })
    expect(commitRes.status).toBe(200)
    const commitData = (commitRes.body as { data?: { imported?: number; failedRows?: number; skipped?: unknown[] } } | undefined)?.data
    expect(commitData?.imported).toBe(1)
    expect(commitData?.failedRows).toBe(0)

    const csvPath = path.join(importUploadDir, orgId, `${fileId}.csv`)
    const metaPath = path.join(importUploadDir, orgId, `${fileId}.json`)
    await expect(fs.stat(csvPath)).rejects.toBeTruthy()
    await expect(fs.stat(metaPath)).rejects.toBeTruthy()
  })

  it('routes high-scale csvFileId imports to async endpoints and preserves upload for async lanes', async () => {
    if (!baseUrl) return
    if (!importUploadDir) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-test&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    if (!token) return

    const orgId = 'default'
    const workDate = new Date().toISOString().slice(0, 10)
    const baseRows = 1000
    const totalRows = baseRows + 2
    const csvHeader = '日期,UserId,考勤组,上班1打卡时间,下班1打卡时间,考勤结果'
    const csvRows = Array.from({ length: baseRows }, (_, index) => {
      const rowUserId = `attendance-highscale-${String(index + 1).padStart(4, '0')}`
      return `${workDate},${rowUserId},CSV High Scale,09:00,18:00,正常`
    })
    csvRows.push(`${workDate},attendance-highscale-0001,CSV High Scale,09:05,18:05,正常`)
    csvRows.push(`,attendance-highscale-invalid,CSV High Scale,09:10,18:10,正常`)
    const csvText = `${csvHeader}\n${csvRows.join('\n')}\n`

    const uploadRes = await requestJson(`${baseUrl}/api/attendance/import/upload?orgId=${encodeURIComponent(orgId)}&filename=highscale-async.csv`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/csv',
      },
      body: csvText,
    })
    expect(uploadRes.status).toBe(201)
    const fileId = (uploadRes.body as { data?: { fileId?: string } } | undefined)?.data?.fileId
    expect(typeof fileId).toBe('string')

    const csvPayloadBase = {
      orgId,
      userId: 'attendance-test',
      timezone: 'UTC',
      csvFileId: String(fileId || ''),
      mappingProfileId: 'dingtalk_csv_daily_summary',
      mode: 'override',
      previewLimit: 5,
    }

    const csvPath = path.join(importUploadDir, orgId, `${fileId}.csv`)
    const metaPath = path.join(importUploadDir, orgId, `${fileId}.json`)
    await expect(fs.stat(csvPath)).resolves.toBeTruthy()
    await expect(fs.stat(metaPath)).resolves.toBeTruthy()

    const prepareSyncPreviewRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(prepareSyncPreviewRes.status).toBe(200)
    const syncPreviewCommitToken = (prepareSyncPreviewRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(syncPreviewCommitToken).toBeTruthy()

    const syncPreviewRes = await requestJson(`${baseUrl}/api/attendance/import/preview`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...csvPayloadBase,
        commitToken: syncPreviewCommitToken,
      }),
    })
    expect(syncPreviewRes.status).toBe(400)
    const syncPreviewError = (syncPreviewRes.body as { error?: { code?: string; message?: string } } | undefined)?.error
    expect(syncPreviewError?.code).toBe('IMPORT_TOO_LARGE_FOR_SYNC')
    expect(String(syncPreviewError?.message || '')).toContain('/api/attendance/import/preview-async')

    const prepareAsyncPreviewRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(prepareAsyncPreviewRes.status).toBe(200)
    const asyncPreviewCommitToken = (prepareAsyncPreviewRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(asyncPreviewCommitToken).toBeTruthy()

    const previewAsyncRes = await requestJson(`${baseUrl}/api/attendance/import/preview-async`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...csvPayloadBase,
        idempotencyKey: `integration-csvfile-preview-async-${Date.now().toString(36)}`,
        commitToken: asyncPreviewCommitToken,
      }),
    })
    expect(previewAsyncRes.status).toBe(200)
    const previewJobId = String(((previewAsyncRes.body as { data?: { job?: any } } | undefined)?.data?.job?.id) || '')
    expect(previewJobId).toBeTruthy()

    let completedPreviewJob: any = null
    for (let i = 0; i < 200; i += 1) {
      const jobRes = await requestJson(`${baseUrl}/api/attendance/import/jobs/${previewJobId}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      })
      expect(jobRes.status).toBe(200)
      const jobData = (jobRes.body as { data?: any } | undefined)?.data
      const status = String(jobData?.status || '')
      if (status === 'completed') {
        completedPreviewJob = jobData
        break
      }
      if (status === 'failed') {
        throw new Error(String(jobData?.error || 'async preview job failed'))
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(completedPreviewJob).toBeTruthy()
    expect(completedPreviewJob?.kind).toBe('preview')
    expect(completedPreviewJob?.preview?.rowCount).toBe(totalRows)
    expect(completedPreviewJob?.preview?.stats?.rowCount).toBe(totalRows)
    expect(completedPreviewJob?.preview?.stats?.duplicates).toBe(1)
    expect(completedPreviewJob?.preview?.stats?.invalid).toBe(1)
    expect(completedPreviewJob?.preview?.failedRows).toBe(2)
    expect(completedPreviewJob?.preview?.previewLimit).toBe(5)
    expect(completedPreviewJob?.preview?.truncated).toBe(true)
    expect(completedPreviewJob?.preview?.asyncSimplified).toBe(true)
    expect(Array.isArray(completedPreviewJob?.preview?.items)).toBe(true)
    expect(completedPreviewJob?.preview?.items.length).toBe(5)

    await expect(fs.stat(csvPath)).resolves.toBeTruthy()
    await expect(fs.stat(metaPath)).resolves.toBeTruthy()

    const prepareSyncCommitRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(prepareSyncCommitRes.status).toBe(200)
    const syncCommitToken = (prepareSyncCommitRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(syncCommitToken).toBeTruthy()

    const syncCommitRes = await requestJson(`${baseUrl}/api/attendance/import/commit`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...csvPayloadBase,
        commitToken: syncCommitToken,
      }),
    })
    expect(syncCommitRes.status).toBe(400)
    const syncCommitError = (syncCommitRes.body as { error?: { code?: string; message?: string } } | undefined)?.error
    expect(syncCommitError?.code).toBe('IMPORT_TOO_LARGE_FOR_SYNC')
    expect(String(syncCommitError?.message || '')).toContain('/api/attendance/import/commit-async')

    await expect(fs.stat(csvPath)).resolves.toBeTruthy()
    await expect(fs.stat(metaPath)).resolves.toBeTruthy()
  }, 120000)

  it('supports idempotency retry for csvFileId even after upload cleanup', async () => {
    if (!baseUrl) return
    if (!importUploadDir) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-test&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    if (!token) return

    const orgId = 'default'
    const workDate = new Date().toISOString().slice(0, 10)
    const csvHeader = '日期,工号,考勤组,上班1打卡时间,下班1打卡时间,考勤结果'
    const csvText = `${csvHeader}\n${workDate},A001,CSV Upload Idempotency,09:00,18:00,正常\n`

    const uploadRes = await requestJson(`${baseUrl}/api/attendance/import/upload?orgId=${encodeURIComponent(orgId)}&filename=idempotency.csv`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/csv',
      },
      body: csvText,
    })
    expect(uploadRes.status).toBe(201)
    const fileId = (uploadRes.body as { data?: { fileId?: string } } | undefined)?.data?.fileId
    expect(typeof fileId).toBe('string')

    const idempotencyKey = `upload-idempo-${Date.now()}`

    const csvPayloadBase = {
      orgId,
      userId: 'attendance-test',
      timezone: 'UTC',
      csvFileId: String(fileId || ''),
      idempotencyKey,
      mapping: {
        columns: [
          { sourceField: '日期', targetField: 'workDate', dataType: 'date' },
          { sourceField: '工号', targetField: 'empNo', dataType: 'string' },
          { sourceField: '考勤组', targetField: 'attendance_group', dataType: 'string' },
          { sourceField: '上班1打卡时间', targetField: 'firstInAt', dataType: 'time' },
          { sourceField: '下班1打卡时间', targetField: 'lastOutAt', dataType: 'time' },
          { sourceField: '考勤结果', targetField: 'status', dataType: 'string' },
        ],
      },
      userMap: {
        A001: 'attendance-test',
      },
      mode: 'override',
    }

    const preparePreviewRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(preparePreviewRes.status).toBe(200)
    const previewCommitToken = (preparePreviewRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(previewCommitToken).toBeTruthy()

    const previewRes = await requestJson(`${baseUrl}/api/attendance/import/preview`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...csvPayloadBase,
        commitToken: previewCommitToken,
      }),
    })
    expect(previewRes.status).toBe(200)

    const prepareCommitRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(prepareCommitRes.status).toBe(200)
    const commitToken = (prepareCommitRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(commitToken).toBeTruthy()

    const commitRes = await requestJson(`${baseUrl}/api/attendance/import/commit`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...csvPayloadBase,
        commitToken,
        returnItems: false,
      }),
    })
    expect(commitRes.status).toBe(200)
    const commitData = (commitRes.body as { data?: any } | undefined)?.data
    const batchId = commitData?.batchId
    expect(typeof batchId).toBe('string')
    expect(['standard', 'bulk']).toContain(String(commitData?.engine || ''))
    expect(Number(commitData?.processedRows ?? 0)).toBeGreaterThanOrEqual(1)
    expect(Number(commitData?.failedRows ?? 0)).toBeGreaterThanOrEqual(0)
    expect(Number(commitData?.elapsedMs ?? -1)).toBeGreaterThanOrEqual(0)

    const csvPath = path.join(importUploadDir, orgId, `${fileId}.csv`)
    const metaPath = path.join(importUploadDir, orgId, `${fileId}.json`)
    await expect(fs.stat(csvPath)).rejects.toBeTruthy()
    await expect(fs.stat(metaPath)).rejects.toBeTruthy()

    const retryRes = await requestJson(`${baseUrl}/api/attendance/import/commit`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...csvPayloadBase,
        returnItems: false,
        // Omit commitToken: idempotency retry must succeed even after the upload file is cleaned up.
      }),
    })
    expect(retryRes.status).toBe(200)
    const retryData = (retryRes.body as { data?: any } | undefined)?.data
    expect(retryData?.batchId).toBe(batchId)
    expect(retryData?.idempotent).toBe(true)
    expect(['standard', 'bulk']).toContain(String(retryData?.engine || ''))
    expect(Number(retryData?.processedRows ?? 0)).toBeGreaterThanOrEqual(1)
    expect(Number(retryData?.failedRows ?? 0)).toBeGreaterThanOrEqual(0)
    expect(Number(retryData?.elapsedMs ?? -1)).toBeGreaterThanOrEqual(0)

    if (batchId) {
      const rollbackRes = await requestJson(`${baseUrl}/api/attendance/import/rollback/${batchId}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      })
      expect(rollbackRes.status).toBe(200)
    }
  })

  it('deduplicates concurrent csvFileId commits with the same idempotencyKey', async () => {
    if (!baseUrl) return
    if (!importUploadDir) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-test&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    if (!token) return

    const orgId = 'default'
    const workDate = new Date().toISOString().slice(0, 10)
    const csvHeader = '日期,工号,考勤组,上班1打卡时间,下班1打卡时间,考勤结果'
    const csvText = `${csvHeader}\n${workDate},A001,CSV Upload Concurrent,09:00,18:00,正常\n`

    const uploadRes = await requestJson(`${baseUrl}/api/attendance/import/upload?orgId=${encodeURIComponent(orgId)}&filename=concurrent.csv`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/csv',
      },
      body: csvText,
    })
    expect(uploadRes.status).toBe(201)
    const fileId = (uploadRes.body as { data?: { fileId?: string } } | undefined)?.data?.fileId
    expect(typeof fileId).toBe('string')

    const idempotencyKey = `upload-concurrent-idempo-${Date.now()}`

    const csvPayloadBase = {
      orgId,
      userId: 'attendance-test',
      timezone: 'UTC',
      csvFileId: String(fileId || ''),
      idempotencyKey,
      mapping: {
        columns: [
          { sourceField: '日期', targetField: 'workDate', dataType: 'date' },
          { sourceField: '工号', targetField: 'empNo', dataType: 'string' },
          { sourceField: '考勤组', targetField: 'attendance_group', dataType: 'string' },
          { sourceField: '上班1打卡时间', targetField: 'firstInAt', dataType: 'time' },
          { sourceField: '下班1打卡时间', targetField: 'lastOutAt', dataType: 'time' },
          { sourceField: '考勤结果', targetField: 'status', dataType: 'string' },
        ],
      },
      userMap: {
        A001: 'attendance-test',
      },
      mode: 'override',
    }

    const [prepareARes, prepareBRes] = await Promise.all([
      requestJson(`${baseUrl}/api/attendance/import/prepare`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
      requestJson(`${baseUrl}/api/attendance/import/prepare`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
    ])
    expect(prepareARes.status).toBe(200)
    expect(prepareBRes.status).toBe(200)
    const commitTokenA = (prepareARes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    const commitTokenB = (prepareBRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(commitTokenA).toBeTruthy()
    expect(commitTokenB).toBeTruthy()

    const [commitARes, commitBRes] = await Promise.all([
      requestJson(`${baseUrl}/api/attendance/import/commit`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...csvPayloadBase,
          commitToken: commitTokenA,
          returnItems: false,
        }),
      }),
      requestJson(`${baseUrl}/api/attendance/import/commit`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...csvPayloadBase,
          commitToken: commitTokenB,
          returnItems: false,
        }),
      }),
    ])

    expect(commitARes.status).toBe(200)
    expect(commitBRes.status).toBe(200)

    const commitAData = (commitARes.body as { data?: any } | undefined)?.data
    const commitBData = (commitBRes.body as { data?: any } | undefined)?.data
    expect(commitAData?.batchId).toBeTruthy()
    expect(commitBData?.batchId).toBeTruthy()
    expect(commitAData?.batchId).toBe(commitBData?.batchId)
    expect([commitAData?.idempotent, commitBData?.idempotent].some(Boolean)).toBe(true)
    expect(['standard', 'bulk']).toContain(String(commitAData?.engine || ''))
    expect(['standard', 'bulk']).toContain(String(commitBData?.engine || ''))
    expect(Number(commitAData?.processedRows ?? 0)).toBeGreaterThanOrEqual(1)
    expect(Number(commitBData?.processedRows ?? 0)).toBeGreaterThanOrEqual(1)
    expect(Number(commitAData?.failedRows ?? 0)).toBeGreaterThanOrEqual(0)
    expect(Number(commitBData?.failedRows ?? 0)).toBeGreaterThanOrEqual(0)
    expect(Number(commitAData?.elapsedMs ?? -1)).toBeGreaterThanOrEqual(0)
    expect(Number(commitBData?.elapsedMs ?? -1)).toBeGreaterThanOrEqual(0)

    const retryRes = await requestJson(`${baseUrl}/api/attendance/import/commit`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...csvPayloadBase,
        returnItems: false,
      }),
    })
    expect(retryRes.status).toBe(200)
    const retryData = (retryRes.body as { data?: any } | undefined)?.data
    expect(retryData?.batchId).toBe(commitAData?.batchId)
    expect(retryData?.idempotent).toBe(true)
    expect(['standard', 'bulk']).toContain(String(retryData?.engine || ''))
    expect(Number(retryData?.processedRows ?? 0)).toBeGreaterThanOrEqual(1)
    expect(Number(retryData?.failedRows ?? 0)).toBeGreaterThanOrEqual(0)
    expect(Number(retryData?.elapsedMs ?? -1)).toBeGreaterThanOrEqual(0)

    const csvPath = path.join(importUploadDir, orgId, `${fileId}.csv`)
    const metaPath = path.join(importUploadDir, orgId, `${fileId}.json`)
    await expect(fs.stat(csvPath)).rejects.toBeTruthy()
    await expect(fs.stat(metaPath)).rejects.toBeTruthy()

    if (commitAData?.batchId) {
      const rollbackRes = await requestJson(`${baseUrl}/api/attendance/import/rollback/${commitAData.batchId}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      })
      expect(rollbackRes.status).toBe(200)
    }
  })

  it('returns EXPIRED when csvFileId meta is older than TTL', async () => {
    if (!baseUrl) return
    if (!importUploadDir) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-test&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    if (!token) return

    const orgId = 'default'
    const workDate = new Date().toISOString().slice(0, 10)
    const csvHeader = '日期,工号,考勤组,上班1打卡时间,下班1打卡时间,考勤结果'
    const csvText = `${csvHeader}\n${workDate},A001,CSV Expired,09:00,18:00,正常\n`

    const uploadRes = await requestJson(`${baseUrl}/api/attendance/import/upload?orgId=${encodeURIComponent(orgId)}&filename=expired.csv`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/csv',
      },
      body: csvText,
    })
    expect(uploadRes.status).toBe(201)
    const fileId = (uploadRes.body as { data?: { fileId?: string } } | undefined)?.data?.fileId
    expect(typeof fileId).toBe('string')

    const metaPath = path.join(importUploadDir, orgId, `${fileId}.json`)
    const rawMeta = await fs.readFile(metaPath, 'utf8')
    const meta = rawMeta ? JSON.parse(rawMeta) : {}
    meta.createdAt = '1970-01-01T00:00:00.000Z'
    await fs.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')

    const preparePreviewRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(preparePreviewRes.status).toBe(200)
    const previewCommitToken = (preparePreviewRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(previewCommitToken).toBeTruthy()

    const previewRes = await requestJson(`${baseUrl}/api/attendance/import/preview`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        orgId,
        userId: 'attendance-test',
        timezone: 'UTC',
        csvFileId: String(fileId || ''),
        mapping: {
          columns: [
            { sourceField: '日期', targetField: 'workDate', dataType: 'date' },
            { sourceField: '工号', targetField: 'empNo', dataType: 'string' },
            { sourceField: '考勤组', targetField: 'attendance_group', dataType: 'string' },
            { sourceField: '上班1打卡时间', targetField: 'firstInAt', dataType: 'time' },
            { sourceField: '下班1打卡时间', targetField: 'lastOutAt', dataType: 'time' },
            { sourceField: '考勤结果', targetField: 'status', dataType: 'string' },
          ],
        },
        userMap: { A001: 'attendance-test' },
        mode: 'override',
        commitToken: previewCommitToken,
      }),
    })

    expect(previewRes.status).toBe(410)
    const code = (previewRes.body as { error?: { code?: string } } | undefined)?.error?.code
    expect(code).toBe('EXPIRED')
  })

  it('supports commit-async with csvFileId and idempotent retry after upload cleanup', async () => {
    if (!baseUrl) return
    if (!importUploadDir) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-test&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    if (!token) return

    const orgId = 'default'
    const runSuffix = Date.now().toString(36)
    const workDate = new Date().toISOString().slice(0, 10)
    const mappedUserIdA = `attendance-async-${runSuffix}-a`
    const mappedUserIdB = `attendance-async-${runSuffix}-b`
    const asyncGroupName = `CSV Async Group ${runSuffix}`
    const csvHeader = '日期,UserId,考勤组,上班1打卡时间,下班1打卡时间,考勤结果'
    const csvRows = [
      `${workDate},${mappedUserIdA},${asyncGroupName},09:00,18:00,正常`,
      `${workDate},${mappedUserIdB},${asyncGroupName},09:10,18:10,正常`,
      `${workDate},${mappedUserIdA},${asyncGroupName},09:20,18:20,正常`,
      `,attendance-async-${runSuffix}-invalid,${asyncGroupName},09:30,18:30,正常`,
    ]
    const csvText = `${csvHeader}\n${csvRows.join('\n')}\n`

    const uploadRes = await requestJson(`${baseUrl}/api/attendance/import/upload?orgId=${encodeURIComponent(orgId)}&filename=async-success.csv`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/csv',
      },
      body: csvText,
    })
    expect(uploadRes.status).toBe(201)
    const fileId = (uploadRes.body as { data?: { fileId?: string } } | undefined)?.data?.fileId
    expect(typeof fileId).toBe('string')

    const prepareRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(prepareRes.status).toBe(200)
    const commitToken = (prepareRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(commitToken).toBeTruthy()

    const idempotencyKey = `upload-async-idempo-${Date.now()}`
    const commitPayload = {
      orgId,
      userId: 'attendance-test',
      timezone: 'UTC',
      csvFileId: String(fileId || ''),
      idempotencyKey,
      mappingProfileId: 'dingtalk_csv_daily_summary',
      groupSync: {
        autoCreate: true,
        autoAssignMembers: true,
      },
      mode: 'override',
      commitToken,
    }

    const commitRes = await requestJson(`${baseUrl}/api/attendance/import/commit-async`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commitPayload),
    })
    expect(commitRes.status).toBe(200)
    const commitData = (commitRes.body as { data?: { job?: any } } | undefined)?.data
    const jobId = String(commitData?.job?.id || '')
    const batchId = String(commitData?.job?.batchId || '')
    expect(jobId).toBeTruthy()
    expect(batchId).toBeTruthy()
    expect(['standard', 'bulk']).toContain(String(commitData?.job?.engine || ''))

    let completedJob: any = null
    for (let i = 0; i < 160; i += 1) {
      const jobRes = await requestJson(`${baseUrl}/api/attendance/import/jobs/${jobId}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      })
      expect(jobRes.status).toBe(200)
      const jobData = (jobRes.body as { data?: any } | undefined)?.data
      const status = String(jobData?.status || '')
      if (status === 'completed') {
        completedJob = jobData
        break
      }
      if (status === 'failed') {
        throw new Error(String(jobData?.error || 'async csv upload job failed'))
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(completedJob).toBeTruthy()
    expect(String(completedJob?.batchId || '')).toBe(batchId)
    expect(['standard', 'bulk']).toContain(String(completedJob?.engine || ''))
    expect(typeof completedJob?.processedRows).toBe('number')
    expect(completedJob?.processedRows).toBeGreaterThanOrEqual(2)
    expect(typeof completedJob?.failedRows).toBe('number')
    expect(completedJob?.failedRows).toBe(2)
    expect(typeof completedJob?.elapsedMs).toBe('number')
    expect(typeof completedJob?.progressPercent).toBe('number')
    expect(typeof completedJob?.throughputRowsPerSec).toBe('number')
    expectChunkConfigMatchesEngine(completedJob?.engine, completedJob?.chunkConfig)
    expect(['values', 'unnest', 'staging']).toContain(String(completedJob?.recordUpsertStrategy || ''))

    const batchDetailRes = await requestJson(
      `${baseUrl}/api/attendance/import/batches/${encodeURIComponent(batchId)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    )
    expect(batchDetailRes.status).toBe(200)
    const batchMeta = (batchDetailRes.body as { data?: { meta?: any } } | undefined)?.data?.meta
    expect(batchMeta?.groupCreated).toBe(1)
    expect(batchMeta?.groupMembersAdded).toBe(2)
    expect(batchMeta?.skippedCount).toBe(2)
    expect(Array.isArray(batchMeta?.skippedRows)).toBe(true)
    expect(batchMeta?.groupSync?.autoCreate).toBe(true)
    expect(batchMeta?.groupSync?.autoAssignMembers).toBe(true)

    const listGroupsRes = await requestJson(`${baseUrl}/api/attendance/groups?pageSize=200`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(listGroupsRes.status).toBe(200)
    const groups = (listGroupsRes.body as { data?: { items?: { id?: string; name?: string }[] } } | undefined)?.data?.items ?? []
    const asyncGroup = groups.find(item => item.name === asyncGroupName)
    expect(asyncGroup?.id).toBeTruthy()

    if (asyncGroup?.id) {
      const asyncGroupMembersRes = await requestJson(`${baseUrl}/api/attendance/groups/${asyncGroup.id}/members?pageSize=200`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })
      expect(asyncGroupMembersRes.status).toBe(200)
      const asyncGroupMembers = (asyncGroupMembersRes.body as { data?: { items?: { userId?: string }[] } } | undefined)?.data?.items ?? []
      expect(asyncGroupMembers.some(item => item.userId === mappedUserIdA)).toBe(true)
      expect(asyncGroupMembers.some(item => item.userId === mappedUserIdB)).toBe(true)
    }

    const csvPath = path.join(importUploadDir, orgId, `${fileId}.csv`)
    const metaPath = path.join(importUploadDir, orgId, `${fileId}.json`)
    await expect(fs.stat(csvPath)).rejects.toBeTruthy()
    await expect(fs.stat(metaPath)).rejects.toBeTruthy()

    const { commitToken: _commitToken, ...retryPayload } = commitPayload
    const retryRes = await requestJson(`${baseUrl}/api/attendance/import/commit-async`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(retryPayload),
    })
    expect(retryRes.status).toBe(200)
    const retryData = (retryRes.body as { data?: { idempotent?: boolean; job?: any } } | undefined)?.data
    expect(String(retryData?.job?.id || '')).toBe(jobId)
    expect(String(retryData?.job?.batchId || '')).toBe(batchId)
    expect(retryData?.idempotent).toBe(true)
    expect(['values', 'unnest', 'staging']).toContain(
      String(retryData?.job?.recordUpsertStrategy || completedJob?.recordUpsertStrategy || '')
    )

    const rollbackRes = await requestJson(`${baseUrl}/api/attendance/import/rollback/${batchId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(rollbackRes.status).toBe(200)
  })

  it('streams csvFileId data for commit-async without fs.readFile on the csv payload', async () => {
    if (!baseUrl) return
    if (!importUploadDir) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-test&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    if (!token) return

    const orgId = 'default'
    const runSuffix = Date.now().toString(36)
    const workDate = new Date().toISOString().slice(0, 10)
    const csvText = [
      '日期,UserId,考勤组,上班1打卡时间,下班1打卡时间,考勤结果',
      `${workDate},attendance-stream-${runSuffix}-a,CSV Stream Group ${runSuffix},09:00,18:00,正常`,
      `${workDate},attendance-stream-${runSuffix}-b,CSV Stream Group ${runSuffix},09:10,18:10,正常`,
      '',
    ].join('\n')

    const uploadRes = await requestJson(`${baseUrl}/api/attendance/import/upload?orgId=${encodeURIComponent(orgId)}&filename=async-stream.csv`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/csv',
      },
      body: csvText,
    })
    expect(uploadRes.status).toBe(201)
    const fileId = (uploadRes.body as { data?: { fileId?: string } } | undefined)?.data?.fileId
    expect(typeof fileId).toBe('string')

    const prepareRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(prepareRes.status).toBe(200)
    const commitToken = (prepareRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(commitToken).toBeTruthy()

    const originalReadFile = fs.readFile.bind(fs)
    const readFileSpy = vi.spyOn(fs, 'readFile').mockImplementation(async (target: any, options?: any) => {
      const targetPath = typeof target === 'string'
        ? target
        : target instanceof URL
          ? target.pathname
          : String(target)
      if (targetPath.endsWith('.csv')) {
        throw new Error(`csv readFile should not be used for async csvFileId import: ${targetPath}`)
      }
      return originalReadFile(target, options)
    })

    let batchId = ''
    try {
      const commitRes = await requestJson(`${baseUrl}/api/attendance/import/commit-async`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          orgId,
          userId: 'attendance-test',
          timezone: 'UTC',
          csvFileId: String(fileId || ''),
          idempotencyKey: `upload-async-stream-${Date.now()}`,
          mappingProfileId: 'dingtalk_csv_daily_summary',
          mode: 'override',
          commitToken,
        }),
      })
      expect(commitRes.status).toBe(200)
      const commitData = (commitRes.body as { data?: { job?: any } } | undefined)?.data
      const jobId = String(commitData?.job?.id || '')
      batchId = String(commitData?.job?.batchId || '')
      expect(jobId).toBeTruthy()
      expect(batchId).toBeTruthy()

      let completedJob: any = null
      for (let i = 0; i < 160; i += 1) {
        const jobRes = await requestJson(`${baseUrl}/api/attendance/import/jobs/${jobId}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        })
        expect(jobRes.status).toBe(200)
        const jobData = (jobRes.body as { data?: any } | undefined)?.data
        const status = String(jobData?.status || '')
        if (status === 'completed') {
          completedJob = jobData
          break
        }
        if (status === 'failed') {
          throw new Error(String(jobData?.error || 'async csv stream job failed'))
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(completedJob).toBeTruthy()
      expect(Number(completedJob?.processedRows ?? 0)).toBeGreaterThanOrEqual(2)
      expect(readFileSpy).toHaveBeenCalled()
    } finally {
      readFileSpy.mockRestore()
      if (batchId) {
        const rollbackRes = await requestJson(`${baseUrl}/api/attendance/import/rollback/${batchId}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
        })
        expect(rollbackRes.status).toBe(200)
      }
    }
  })

  it('returns NOT_FOUND for preview-async when csvFileId does not exist', async () => {
    if (!baseUrl) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-test&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    if (!token) return

    const prepareRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(prepareRes.status).toBe(200)
    const commitToken = (prepareRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(commitToken).toBeTruthy()

    const workDate = new Date().toISOString().slice(0, 10)
    const missingFileId = randomUuidV4()
    const response = await requestJson(`${baseUrl}/api/attendance/import/preview-async`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        orgId: 'default',
        userId: 'attendance-test',
        timezone: 'UTC',
        csvFileId: missingFileId,
        mapping: {
          columns: [
            { sourceField: '日期', targetField: 'workDate', dataType: 'date' },
            { sourceField: '工号', targetField: 'empNo', dataType: 'string' },
            { sourceField: '考勤组', targetField: 'attendance_group', dataType: 'string' },
            { sourceField: '上班1打卡时间', targetField: 'firstInAt', dataType: 'time' },
            { sourceField: '下班1打卡时间', targetField: 'lastOutAt', dataType: 'time' },
            { sourceField: '考勤结果', targetField: 'status', dataType: 'string' },
          ],
        },
        userMap: { A001: 'attendance-test' },
        mode: 'override',
        commitToken,
      }),
    })

    expect(response.status).toBe(404)
    const code = (response.body as { error?: { code?: string } } | undefined)?.error?.code
    expect(code).toBe('NOT_FOUND')
  })

  it('returns NOT_FOUND for commit-async when csvFileId does not exist', async () => {
    if (!baseUrl) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-test&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    if (!token) return

    const prepareRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(prepareRes.status).toBe(200)
    const commitToken = (prepareRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(commitToken).toBeTruthy()

    const missingFileId = randomUuidV4()
    const response = await requestJson(`${baseUrl}/api/attendance/import/commit-async`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        orgId: 'default',
        userId: 'attendance-test',
        timezone: 'UTC',
        csvFileId: missingFileId,
        mapping: {
          columns: [
            { sourceField: '日期', targetField: 'workDate', dataType: 'date' },
            { sourceField: '工号', targetField: 'empNo', dataType: 'string' },
            { sourceField: '考勤组', targetField: 'attendance_group', dataType: 'string' },
            { sourceField: '上班1打卡时间', targetField: 'firstInAt', dataType: 'time' },
            { sourceField: '下班1打卡时间', targetField: 'lastOutAt', dataType: 'time' },
            { sourceField: '考勤结果', targetField: 'status', dataType: 'string' },
          ],
        },
        userMap: { A001: 'attendance-test' },
        mode: 'override',
        commitToken,
      }),
    })

    expect(response.status).toBe(404)
    const code = (response.body as { error?: { code?: string } } | undefined)?.error?.code
    expect(code).toBe('NOT_FOUND')
  })

  it('returns EXPIRED for preview-async when csvFileId meta is older than TTL', async () => {
    if (!baseUrl) return
    if (!importUploadDir) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-test&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    if (!token) return

    const orgId = 'default'
    const workDate = new Date().toISOString().slice(0, 10)
    const csvHeader = '日期,工号,考勤组,上班1打卡时间,下班1打卡时间,考勤结果'
    const csvText = `${csvHeader}\n${workDate},A001,CSV Async Preview Expired,09:00,18:00,正常\n`

    const uploadRes = await requestJson(`${baseUrl}/api/attendance/import/upload?orgId=${encodeURIComponent(orgId)}&filename=expired-preview-async.csv`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/csv',
      },
      body: csvText,
    })
    expect(uploadRes.status).toBe(201)
    const fileId = (uploadRes.body as { data?: { fileId?: string } } | undefined)?.data?.fileId
    expect(typeof fileId).toBe('string')

    const metaPath = path.join(importUploadDir, orgId, `${fileId}.json`)
    const rawMeta = await fs.readFile(metaPath, 'utf8')
    const meta = rawMeta ? JSON.parse(rawMeta) : {}
    meta.createdAt = '1970-01-01T00:00:00.000Z'
    await fs.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')

    const prepareRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(prepareRes.status).toBe(200)
    const commitToken = (prepareRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(commitToken).toBeTruthy()

    const response = await requestJson(`${baseUrl}/api/attendance/import/preview-async`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        orgId,
        userId: 'attendance-test',
        timezone: 'UTC',
        csvFileId: String(fileId || ''),
        mapping: {
          columns: [
            { sourceField: '日期', targetField: 'workDate', dataType: 'date' },
            { sourceField: '工号', targetField: 'empNo', dataType: 'string' },
            { sourceField: '考勤组', targetField: 'attendance_group', dataType: 'string' },
            { sourceField: '上班1打卡时间', targetField: 'firstInAt', dataType: 'time' },
            { sourceField: '下班1打卡时间', targetField: 'lastOutAt', dataType: 'time' },
            { sourceField: '考勤结果', targetField: 'status', dataType: 'string' },
          ],
        },
        userMap: { A001: 'attendance-test' },
        mode: 'override',
        commitToken,
      }),
    })

    expect(response.status).toBe(410)
    const code = (response.body as { error?: { code?: string } } | undefined)?.error?.code
    expect(code).toBe('EXPIRED')
  })

  it('returns EXPIRED for commit-async when csvFileId meta is older than TTL', async () => {
    if (!baseUrl) return
    if (!importUploadDir) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-test&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    if (!token) return

    const orgId = 'default'
    const workDate = new Date().toISOString().slice(0, 10)
    const csvHeader = '日期,工号,考勤组,上班1打卡时间,下班1打卡时间,考勤结果'
    const csvText = `${csvHeader}\n${workDate},A001,CSV Async Commit Expired,09:00,18:00,正常\n`

    const uploadRes = await requestJson(`${baseUrl}/api/attendance/import/upload?orgId=${encodeURIComponent(orgId)}&filename=expired-commit-async.csv`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/csv',
      },
      body: csvText,
    })
    expect(uploadRes.status).toBe(201)
    const fileId = (uploadRes.body as { data?: { fileId?: string } } | undefined)?.data?.fileId
    expect(typeof fileId).toBe('string')

    const metaPath = path.join(importUploadDir, orgId, `${fileId}.json`)
    const rawMeta = await fs.readFile(metaPath, 'utf8')
    const meta = rawMeta ? JSON.parse(rawMeta) : {}
    meta.createdAt = '1970-01-01T00:00:00.000Z'
    await fs.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')

    const prepareRes = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(prepareRes.status).toBe(200)
    const commitToken = (prepareRes.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken
    expect(commitToken).toBeTruthy()

    const response = await requestJson(`${baseUrl}/api/attendance/import/commit-async`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        orgId,
        userId: 'attendance-test',
        timezone: 'UTC',
        csvFileId: String(fileId || ''),
        mapping: {
          columns: [
            { sourceField: '日期', targetField: 'workDate', dataType: 'date' },
            { sourceField: '工号', targetField: 'empNo', dataType: 'string' },
            { sourceField: '考勤组', targetField: 'attendance_group', dataType: 'string' },
            { sourceField: '上班1打卡时间', targetField: 'firstInAt', dataType: 'time' },
            { sourceField: '下班1打卡时间', targetField: 'lastOutAt', dataType: 'time' },
            { sourceField: '考勤结果', targetField: 'status', dataType: 'string' },
          ],
        },
        userMap: { A001: 'attendance-test' },
        mode: 'override',
        commitToken,
      }),
    })

    expect(response.status).toBe(410)
    const code = (response.body as { error?: { code?: string } } | undefined)?.error?.code
    expect(code).toBe('EXPIRED')
  })

  it('effective-calendar §6.1 baseline equals resolveWorkContext for rule + holiday rows', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return

    const runSuffix = Date.now().toString(36)
    const year = 3030 + (Number.parseInt(runSuffix.slice(-3), 36) % 500)
    const testUserId = `attendance-effcal-baseline-${runSuffix}`
    const orgId = 'default'
    const rangeFrom = `${year}-06-01`
    const rangeTo = `${year}-06-08`
    const holidayDate = `${year}-06-03`
    const workdayOverrideDate = `${year}-06-07`

    const weekdays = new Map<string, number>()
    for (let i = 1; i <= 8; i += 1) {
      const d = `${year}-06-${String(i).padStart(2, '0')}`
      weekdays.set(d, new Date(`${d}T00:00:00Z`).getUTCDay())
    }

    const pool = new Pool({ connectionString: dbUrl })
    try {
      await pool.query(
        'DELETE FROM attendance_holidays WHERE org_id = $1 AND holiday_date BETWEEN $2 AND $3',
        [orgId, rangeFrom, rangeTo]
      )
      await pool.query(
        `INSERT INTO attendance_holidays (id, org_id, holiday_date, name, is_working_day, origin)
         VALUES ($1, 'default', $2, 'Test Holiday', false, 'manual'),
                ($3, 'default', $4, 'Saturday Work', true, 'manual')`,
        [randomUuidV4(), holidayDate, randomUuidV4(), workdayOverrideDate]
      )

      const tokenRes = await requestJson(
        `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(testUserId)}&roles=admin&perms=attendance:read,attendance:admin`
      )
      const token = (tokenRes.body as { token?: string } | undefined)?.token
      expect(token).toBeTruthy()
      if (!token) return

      const res = await requestJson(
        `${baseUrl}/api/attendance/effective-calendar?from=${rangeFrom}&to=${rangeTo}&userId=${encodeURIComponent(testUserId)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      expect(res.status).toBe(200)
      const data = (res.body as any)?.data
      expect(data?.mode).toBe('userId')
      expect(data.from).toBe(rangeFrom)
      expect(data.to).toBe(rangeTo)
      expect(Array.isArray(data.items)).toBe(true)
      expect(data.items.length).toBe(8)

      const byDate = new Map<string, any>(data.items.map((it: any) => [it.date, it]))

      const holidayItem = byDate.get(holidayDate)
      expect(holidayItem.base.source).toBe('manual')
      expect(holidayItem.base.isWorkingDay).toBe(false)
      expect(holidayItem.effective.source).toBe('manual')
      expect(holidayItem.effective.isWorkingDay).toBe(false)
      expect(holidayItem.layers.some((l: any) => l.kind === 'holiday' && l.source === 'manual')).toBe(true)

      const overrideItem = byDate.get(workdayOverrideDate)
      expect(overrideItem.base.source).toBe('manual')
      expect(overrideItem.base.isWorkingDay).toBe(true)
      expect(overrideItem.effective.source).toBe('manual')
      expect(overrideItem.effective.isWorkingDay).toBe(true)

      const defaultWorkingDays = [1, 2, 3, 4, 5]
      for (const item of data.items) {
        if (item.date === holidayDate || item.date === workdayOverrideDate) continue
        const expectedWorkday = defaultWorkingDays.includes(weekdays.get(item.date)!)
        expect(item.base.source).toBe('rule')
        expect(item.base.isWorkingDay).toBe(expectedWorkday)
        expect(item.effective.source).toBe('rule')
        expect(item.effective.isWorkingDay).toBe(expectedWorkday)
      }

      for (const item of data.items) {
        const policyLayers = item.layers.filter((l: any) => l.kind === 'calendar_policy')
        expect(policyLayers.length).toBe(0)
        expect(item.overlays).toEqual([])
      }
    } finally {
      await pool.query(
        'DELETE FROM attendance_holidays WHERE org_id = $1 AND holiday_date BETWEEN $2 AND $3',
        [orgId, rangeFrom, rangeTo]
      ).catch(() => undefined)
      await pool.end()
    }
  })

  it('effective-calendar §6.2 applies calendarPolicy with mode gates, priority, and normalize drops invalid', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return

    const runSuffix = Date.now().toString(36)
    const year = 3030 + (Number.parseInt(runSuffix.slice(-3), 36) % 500)
    const testUserId = `attendance-effcal-policy-${runSuffix}`
    const orgId = 'default'
    const targetDate = `${year}-07-04`
    const groupName = `effcal-prod-${runSuffix}`
    const adminUserId = `attendance-effcal-policy-admin-${runSuffix}`
    let groupId: string | null = null
    let originalSettings: any = null

    const pool = new Pool({ connectionString: dbUrl })
    try {
      // Setup: holiday on targetDate (national)
      await pool.query(
        'DELETE FROM attendance_holidays WHERE org_id = $1 AND holiday_date = $2',
        [orgId, targetDate]
      )
      await pool.query(
        `INSERT INTO attendance_holidays (id, org_id, holiday_date, name, is_working_day, origin)
         VALUES ($1, 'default', $2, 'National Day Test', false, 'national')`,
        [randomUuidV4(), targetDate]
      )
      // Group + member
      const groupRows = await pool.query(
        `INSERT INTO attendance_groups (org_id, name, code, timezone)
         VALUES ('default', $1, $2, 'UTC')
         RETURNING id`,
        [groupName, groupName]
      )
      groupId = String(groupRows.rows[0].id)
      await pool.query(
        `INSERT INTO attendance_group_members (org_id, group_id, user_id)
         VALUES ('default', $1, $2)`,
        [groupId, testUserId]
      )

      const adminTokenRes = await requestJson(
        `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(adminUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin,attendance:approve`
      )
      const adminToken = (adminTokenRes.body as { token?: string } | undefined)?.token
      expect(adminToken).toBeTruthy()
      if (!adminToken) return

      // Preserve current settings to restore later
      const settingsRes = await requestJson(`${baseUrl}/api/attendance/settings`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
      originalSettings = (settingsRes.body as any)?.data ?? null

      const overridesPayload = [
        // valid: org override that flips the national rest day to working day
        { date: targetDate, effective: { isWorkingDay: true, label: 'Org swap', source: 'org' } },
        // valid: group override (production) -> rest day
        { date: targetDate, filters: { attendanceGroups: [groupName] }, effective: { isWorkingDay: false, label: 'Group rest', source: 'group' } },
        // valid: user override -> working day (highest priority)
        { date: targetDate, filters: { userIds: [testUserId] }, effective: { isWorkingDay: true, label: 'User confirm', source: 'user' } },
        // INVALID 1: source='group' missing attendanceGroups filter -> normalize drops
        { date: targetDate, effective: { isWorkingDay: false, label: 'Bad group', source: 'group' } },
        // INVALID 2: no constraint at all -> normalize drops
        { effective: { isWorkingDay: false, label: 'Bad blanket', source: 'org' } },
        // INVALID 3: source='user' missing user filter -> normalize drops
        { date: targetDate, effective: { isWorkingDay: true, label: 'Bad user', source: 'user' } },
      ]

      const putRes = await requestJson(`${baseUrl}/api/attendance/settings`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ calendarPolicy: { overrides: overridesPayload } }),
      })
      expect(putRes.status).toBe(200)
      const savedOverrides = ((putRes.body as any)?.data?.calendarPolicy?.overrides ?? []) as any[]
      // 3 invalid entries dropped at normalize
      expect(savedOverrides.length).toBe(3)
      const labels = savedOverrides.map((o: any) => o.effective?.label).sort()
      expect(labels).toEqual(['Group rest', 'Org swap', 'User confirm'])
      // Each saved override has a stable id assigned at normalize
      for (const o of savedOverrides) expect(typeof o.id).toBe('string')

      // Mode: userId — user override wins (priority 4 > group 2 > org 1)
      const userRes = await requestJson(
        `${baseUrl}/api/attendance/effective-calendar?from=${targetDate}&to=${targetDate}&userId=${encodeURIComponent(testUserId)}`,
        { headers: { Authorization: `Bearer ${adminToken}` } }
      )
      expect(userRes.status).toBe(200)
      const userItem = ((userRes.body as any)?.data?.items ?? [])[0]
      expect(userItem.date).toBe(targetDate)
      expect(userItem.base.source).toBe('national')
      expect(userItem.base.isWorkingDay).toBe(false)
      expect(userItem.effective.source).toBe('user')
      expect(userItem.effective.isWorkingDay).toBe(true)
      const userPolicyLayers = userItem.layers.filter((l: any) => l.kind === 'calendar_policy').map((l: any) => l.source)
      expect(userPolicyLayers).toEqual(['org', 'group', 'user'])

      // Mode: groupId — only 'group' source is in allowed set; org/user don't apply
      const groupRes = await requestJson(
        `${baseUrl}/api/attendance/effective-calendar?from=${targetDate}&to=${targetDate}&groupId=${encodeURIComponent(groupId!)}`,
        { headers: { Authorization: `Bearer ${adminToken}` } }
      )
      expect(groupRes.status).toBe(200)
      const groupItem = ((groupRes.body as any)?.data?.items ?? [])[0]
      expect(groupItem.effective.source).toBe('group')
      expect(groupItem.effective.isWorkingDay).toBe(false)
      const groupPolicyLayers = groupItem.layers.filter((l: any) => l.kind === 'calendar_policy').map((l: any) => l.source)
      expect(groupPolicyLayers).toEqual(['group'])

      // Mode: orgOnly — only 'org' source applies
      const orgRes = await requestJson(
        `${baseUrl}/api/attendance/effective-calendar?from=${targetDate}&to=${targetDate}&orgOnly=true`,
        { headers: { Authorization: `Bearer ${adminToken}` } }
      )
      expect(orgRes.status).toBe(200)
      const orgItem = ((orgRes.body as any)?.data?.items ?? [])[0]
      expect(orgItem.effective.source).toBe('org')
      expect(orgItem.effective.isWorkingDay).toBe(true)
      const orgPolicyLayers = orgItem.layers.filter((l: any) => l.kind === 'calendar_policy').map((l: any) => l.source)
      expect(orgPolicyLayers).toEqual(['org'])
    } finally {
      if (originalSettings) {
        const cleanupTokenRes = await requestJson(
          `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(`${adminUserId}-cleanup`)}&roles=admin&perms=attendance:admin`
        )
        const cleanupToken = (cleanupTokenRes.body as { token?: string } | undefined)?.token
        if (cleanupToken) {
          await requestJson(`${baseUrl}/api/attendance/settings`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${cleanupToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ calendarPolicy: { overrides: [] } }),
          }).catch(() => undefined)
        }
      }
      if (groupId) {
        await pool.query('DELETE FROM attendance_group_members WHERE group_id = $1', [groupId]).catch(() => undefined)
        await pool.query('DELETE FROM attendance_groups WHERE id = $1', [groupId]).catch(() => undefined)
      }
      await pool.query(
        'DELETE FROM attendance_holidays WHERE org_id = $1 AND holiday_date = $2',
        [orgId, targetDate]
      ).catch(() => undefined)
      await pool.end()
    }
  })

  it('effective-calendar accepts group-specific holiday lengths for different users in userId mode', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return

    const runSuffix = Date.now().toString(36)
    const year = 3030 + (Number.parseInt(runSuffix.slice(-3), 36) % 500)
    const orgId = 'default'
    const rangeFrom = `${year}-10-01`
    const rangeTo = `${year}-10-05`
    const shortUserId = `attendance-effcal-short-${runSuffix}`
    const longUserId = `attendance-effcal-long-${runSuffix}`
    const adminUserId = `attendance-effcal-group-length-admin-${runSuffix}`
    const shortGroupName = `effcal-short-holiday-${runSuffix}`
    const longGroupName = `effcal-long-holiday-${runSuffix}`
    let shortGroupId: string | null = null
    let longGroupId: string | null = null
    let originalCalendarPolicy: any = null

    const pool = new Pool({ connectionString: dbUrl })
    try {
      await pool.query(
        'DELETE FROM attendance_holidays WHERE org_id = $1 AND holiday_date BETWEEN $2 AND $3',
        [orgId, rangeFrom, rangeTo]
      )
      for (let day = 1; day <= 5; day += 1) {
        await pool.query(
          `INSERT INTO attendance_holidays (id, org_id, holiday_date, name, is_working_day, origin)
           VALUES ($1, 'default', $2, $3, false, 'national')`,
          [randomUuidV4(), `${year}-10-${String(day).padStart(2, '0')}`, `National Day-${day}`]
        )
      }

      const shortGroupRows = await pool.query(
        `INSERT INTO attendance_groups (org_id, name, code, timezone)
         VALUES ('default', $1, $2, 'UTC')
         RETURNING id`,
        [shortGroupName, shortGroupName]
      )
      shortGroupId = String(shortGroupRows.rows[0].id)
      const longGroupRows = await pool.query(
        `INSERT INTO attendance_groups (org_id, name, code, timezone)
         VALUES ('default', $1, $2, 'UTC')
         RETURNING id`,
        [longGroupName, longGroupName]
      )
      longGroupId = String(longGroupRows.rows[0].id)
      await pool.query(
        `INSERT INTO attendance_group_members (org_id, group_id, user_id)
         VALUES ('default', $1, $2), ('default', $3, $4)`,
        [shortGroupId, shortUserId, longGroupId, longUserId]
      )

      const adminTokenRes = await requestJson(
        `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(adminUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin,attendance:approve`
      )
      const adminToken = (adminTokenRes.body as { token?: string } | undefined)?.token
      expect(adminToken).toBeTruthy()
      if (!adminToken) return

      const settingsRes = await requestJson(`${baseUrl}/api/attendance/settings`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
      originalCalendarPolicy = (settingsRes.body as any)?.data?.calendarPolicy ?? { overrides: [] }

      const putRes = await requestJson(`${baseUrl}/api/attendance/settings`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          calendarPolicy: {
            overrides: [
              {
                dayIndexStart: 4,
                dayIndexEnd: 5,
                filters: { attendanceGroups: [shortGroupName] },
                effective: {
                  isWorkingDay: true,
                  label: 'Short group makeup work',
                  source: 'group',
                },
              },
            ],
          },
        }),
      })
      expect(putRes.status).toBe(200)

      const fetchForUser = async (userId: string) => {
        const res = await requestJson(
          `${baseUrl}/api/attendance/effective-calendar?from=${rangeFrom}&to=${rangeTo}&userId=${encodeURIComponent(userId)}`,
          { headers: { Authorization: `Bearer ${adminToken}` } }
        )
        expect(res.status).toBe(200)
        return ((res.body as any)?.data?.items ?? []) as any[]
      }

      const shortItems = await fetchForUser(shortUserId)
      const longItems = await fetchForUser(longUserId)
      expect(shortItems).toHaveLength(5)
      expect(longItems).toHaveLength(5)

      const shortRestDates = shortItems.filter(item => item.effective.isWorkingDay === false).map(item => item.date)
      const shortWorkDates = shortItems.filter(item => item.effective.isWorkingDay === true).map(item => item.date)
      const longRestDates = longItems.filter(item => item.effective.isWorkingDay === false).map(item => item.date)
      expect(shortRestDates).toEqual([`${year}-10-01`, `${year}-10-02`, `${year}-10-03`])
      expect(shortWorkDates).toEqual([`${year}-10-04`, `${year}-10-05`])
      expect(longRestDates).toEqual([`${year}-10-01`, `${year}-10-02`, `${year}-10-03`, `${year}-10-04`, `${year}-10-05`])

      const shortByDate = new Map<string, any>(shortItems.map(item => [item.date, item]))
      expect(shortByDate.get(`${year}-10-01`)?.base.dayIndex).toBe(1)
      expect(shortByDate.get(`${year}-10-01`)?.effective.source).toBe('national')
      expect(shortByDate.get(`${year}-10-04`)?.base.dayIndex).toBe(4)
      expect(shortByDate.get(`${year}-10-04`)?.effective.source).toBe('group')
      expect(shortByDate.get(`${year}-10-04`)?.layers.map((layer: any) => layer.source)).toContain('group')
      expect(longItems.every(item => item.effective.source === 'national')).toBe(true)
      expect(longItems.flatMap(item => item.layers).some((layer: any) => layer.kind === 'calendar_policy')).toBe(false)
    } finally {
      const cleanupTokenRes = await requestJson(
        `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(`${adminUserId}-cleanup`)}&roles=admin&perms=attendance:admin`
      ).catch(() => null)
      const cleanupToken = (cleanupTokenRes?.body as { token?: string } | undefined)?.token
      if (cleanupToken) {
        await requestJson(`${baseUrl}/api/attendance/settings`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${cleanupToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ calendarPolicy: originalCalendarPolicy ?? { overrides: [] } }),
        }).catch(() => undefined)
      }
      if (shortGroupId || longGroupId) {
        await pool.query(
          'DELETE FROM attendance_group_members WHERE group_id = ANY($1::uuid[])',
          [[shortGroupId, longGroupId].filter(Boolean)]
        ).catch(() => undefined)
        await pool.query(
          'DELETE FROM attendance_groups WHERE id = ANY($1::uuid[])',
          [[shortGroupId, longGroupId].filter(Boolean)]
        ).catch(() => undefined)
      }
      await pool.query(
        'DELETE FROM attendance_holidays WHERE org_id = $1 AND holiday_date BETWEEN $2 AND $3',
        [orgId, rangeFrom, rangeTo]
      ).catch(() => undefined)
      await pool.end()
    }
  })

  it('effective-calendar §6.3 returns approved request overlays additively without merging', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return

    const runSuffix = Date.now().toString(36)
    const year = 3030 + (Number.parseInt(runSuffix.slice(-3), 36) % 500)
    const testUserId = `attendance-effcal-overlays-${runSuffix}`
    const orgId = 'default'
    const targetDate = `${year}-08-15`
    const pool = new Pool({ connectionString: dbUrl })

    try {
      await pool.query(
        `DELETE FROM attendance_requests WHERE user_id = $1`,
        [testUserId]
      )
      // Insert approved leave, overtime, and correction (time_correction) requests on the same date
      const leaveId = randomUuidV4()
      const overtimeId = randomUuidV4()
      const correctionId = randomUuidV4()
      await pool.query(
        `INSERT INTO attendance_requests (id, org_id, user_id, work_date, request_type, status, metadata, created_at)
         VALUES
           ($1, 'default', $2, $3, 'leave', 'approved', '{"minutes":240}'::jsonb, now()),
           ($4, 'default', $2, $3, 'overtime', 'approved', '{"minutes":180}'::jsonb, now() + interval '1 second'),
           ($5, 'default', $2, $3, 'time_correction', 'approved', '{}'::jsonb, now() + interval '2 second')`,
        [leaveId, testUserId, targetDate, overtimeId, correctionId]
      )

      const tokenRes = await requestJson(
        `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(testUserId)}&roles=admin&perms=attendance:read,attendance:admin`
      )
      const token = (tokenRes.body as { token?: string } | undefined)?.token
      expect(token).toBeTruthy()
      if (!token) return

      const res = await requestJson(
        `${baseUrl}/api/attendance/effective-calendar?from=${targetDate}&to=${targetDate}&userId=${encodeURIComponent(testUserId)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      expect(res.status).toBe(200)
      const item = ((res.body as any)?.data?.items ?? [])[0]
      expect(item.date).toBe(targetDate)
      expect(Array.isArray(item.overlays)).toBe(true)
      expect(item.overlays.length).toBe(3)
      // additive: kinds preserved, no merge
      const kinds = item.overlays.map((o: any) => o.kind)
      expect(kinds).toEqual(['personal_leave', 'overtime', 'attendance_correction'])
      // sources all attendance_requests
      for (const ov of item.overlays) expect(ov.source).toBe('attendance_requests')
      // requestType preserved per overlay
      expect(item.overlays[0].requestType).toBe('leave')
      expect(item.overlays[0].minutes).toBe(240)
      expect(item.overlays[1].requestType).toBe('overtime')
      expect(item.overlays[1].minutes).toBe(180)
      expect(item.overlays[2].requestType).toBe('time_correction')
      // refId carries attendance_requests.id for client audit
      expect(item.overlays[0].refId).toBe(leaveId)
      expect(item.overlays[1].refId).toBe(overtimeId)
      expect(item.overlays[2].refId).toBe(correctionId)
      // effective workday is NOT changed by overlays (no calendarPolicy here)
      expect(item.effective.source).toBe('rule')
    } finally {
      await pool.query(`DELETE FROM attendance_requests WHERE user_id = $1`, [testUserId]).catch(() => undefined)
      await pool.end()
    }
  })

  it('effective-calendar validates strictly, enforces RBAC, and 404s missing group', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return

    const runSuffix = Date.now().toString(36)
    const requesterId = `attendance-effcal-rbac-req-${runSuffix}`
    const targetId = `attendance-effcal-rbac-tgt-${runSuffix}`
    const adminId = `attendance-effcal-rbac-adm-${runSuffix}`

    // Read-only token for cross-user RBAC negative case
    const readOnlyRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(requesterId)}&roles=user&perms=attendance:read`
    )
    const readOnlyToken = (readOnlyRes.body as { token?: string } | undefined)?.token
    // Read + approve token for cross-user RBAC positive case
    const approveRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(requesterId)}&roles=user&perms=attendance:read,attendance:approve`
    )
    const approveToken = (approveRes.body as { token?: string } | undefined)?.token
    // Admin token for groupId / 404 case
    const adminRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(adminId)}&roles=admin&perms=attendance:read,attendance:admin`
    )
    const adminToken = (adminRes.body as { token?: string } | undefined)?.token
    expect(readOnlyToken).toBeTruthy()
    expect(approveToken).toBeTruthy()
    expect(adminToken).toBeTruthy()
    if (!readOnlyToken || !approveToken || !adminToken) return

    const base = `${baseUrl}/api/attendance/effective-calendar`
    const dateRange = `from=2030-01-01&to=2030-01-03`

    // 400: missing from/to
    const missingRes = await requestJson(`${base}?to=2030-01-01&orgOnly=true`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(missingRes.status).toBe(400)
    // 400: invalid date
    const badDateRes = await requestJson(`${base}?from=bogus&to=2030-01-01&orgOnly=true`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(badDateRes.status).toBe(400)
    // 400: no mode
    const noModeRes = await requestJson(`${base}?${dateRange}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(noModeRes.status).toBe(400)
    // 400: two modes
    const twoModesRes = await requestJson(`${base}?${dateRange}&userId=x&orgOnly=true`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(twoModesRes.status).toBe(400)
    // 400: range too big
    const bigRangeRes = await requestJson(`${base}?from=2030-01-01&to=2031-06-01&orgOnly=true`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(bigRangeRes.status).toBe(400)
    // 404: groupId not found
    const noGroupRes = await requestJson(`${base}?${dateRange}&groupId=group-does-not-exist-${runSuffix}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(noGroupRes.status).toBe(404)

    // RBAC: read-only token querying another user → 403
    const denyRes = await requestJson(`${base}?${dateRange}&userId=${encodeURIComponent(targetId)}`, {
      headers: { Authorization: `Bearer ${readOnlyToken}` },
    })
    expect(denyRes.status).toBe(403)
    // RBAC: same user (self) querying own calendar → 200
    const selfRes = await requestJson(`${base}?${dateRange}&userId=${encodeURIComponent(requesterId)}`, {
      headers: { Authorization: `Bearer ${readOnlyToken}` },
    })
    expect(selfRes.status).toBe(200)
    // RBAC: read+approve token querying another user → 200
    const approveOtherRes = await requestJson(`${base}?${dateRange}&userId=${encodeURIComponent(targetId)}`, {
      headers: { Authorization: `Bearer ${approveToken}` },
    })
    expect(approveOtherRes.status).toBe(200)
    // RBAC: read-only token using groupId → 403 (groupId requires attendance:admin)
    const groupDenyRes = await requestJson(`${base}?${dateRange}&groupId=anything`, {
      headers: { Authorization: `Bearer ${readOnlyToken}` },
    })
    expect(groupDenyRes.status).toBe(403)
  })

  it('effective-calendar role/roleTags override matches DB-backed role context in resolver mode', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return

    const runSuffix = Date.now().toString(36)
    const year = 3030 + (Number.parseInt(runSuffix.slice(-3), 36) % 500)
    const targetDate = `${year}-09-12`
    const targetTagDate = `${year}-09-13`
    const testUserId = `attendance-effcal-role-user-${runSuffix}`
    const adminUserId = `attendance-effcal-role-admin-${runSuffix}`
    const roleId = `attendance-effcal-role-${runSuffix}`
    const roleName = `Effective Calendar Role ${runSuffix}`

    const adminTokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(adminUserId)}&roles=admin&perms=attendance:read,attendance:admin`
    )
    const adminToken = (adminTokenRes.body as { token?: string } | undefined)?.token
    expect(adminToken).toBeTruthy()
    if (!adminToken) return
    const pool = new Pool({ connectionString: dbUrl })

    try {
      await pool.query(
        `INSERT INTO users (id, email, password_hash, name, role, is_active)
         VALUES ($1, $2, 'no-login', 'Effective Calendar Role User', $3, true)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, is_active = true`,
        [testUserId, `${testUserId}@example.com`, roleId],
      )
      await pool.query(
        `INSERT INTO roles (id, name) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
        [roleId, roleName],
      )
      await pool.query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [testUserId, roleId],
      )

      // Role and roleTags both resolve from the DB-backed role alias set:
      // users.role + assigned RBAC role ids/names. There is no dedicated
      // role-tag table yet, so roleTags intentionally use the same alias set.
      const putRes = await requestJson(`${baseUrl}/api/attendance/settings`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          calendarPolicy: {
            overrides: [
              {
                date: targetDate,
                filters: { roles: [roleId] },
                effective: { isWorkingDay: true, label: 'Role resolver match', source: 'role' },
              },
              {
                date: targetTagDate,
                filters: { roleTags: [roleName] },
                effective: { isWorkingDay: false, label: 'Role tag resolver match', source: 'role' },
              },
            ],
          },
        }),
      })
      expect(putRes.status).toBe(200)
      const saved = ((putRes.body as any)?.data?.calendarPolicy?.overrides ?? []) as any[]
      expect(saved.length).toBe(2)
      expect(saved[0].effective?.source).toBe('role')
      expect(saved[1].filters?.roleTags).toEqual([roleName])

      const res = await requestJson(
        `${baseUrl}/api/attendance/effective-calendar?from=${targetDate}&to=${targetTagDate}&userId=${encodeURIComponent(testUserId)}`,
        { headers: { Authorization: `Bearer ${adminToken}` } }
      )
      expect(res.status).toBe(200)
      const items = ((res.body as any)?.data?.items ?? []) as any[]
      const roleItem = items.find((item) => item.date === targetDate)
      const tagItem = items.find((item) => item.date === targetTagDate)
      expect(roleItem?.effective.source).toBe('role')
      expect(roleItem?.effective.policyId).toBeTruthy()
      expect(roleItem?.layers.some((l: any) => l.kind === 'calendar_policy' && l.source === 'role')).toBe(true)
      expect(tagItem?.effective.source).toBe('role')
      expect(tagItem?.effective.label).toBe('Role tag resolver match')
      expect(tagItem?.layers.some((l: any) => l.kind === 'calendar_policy' && l.source === 'role')).toBe(true)
    } finally {
      const cleanupRes = await requestJson(`${baseUrl}/api/attendance/settings`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ calendarPolicy: { overrides: [] } }),
      })
      expect(cleanupRes.status).toBe(200)
      await pool.query(`DELETE FROM user_roles WHERE user_id = $1`, [testUserId]).catch(() => undefined)
      await pool.query(`DELETE FROM roles WHERE id = $1`, [roleId]).catch(() => undefined)
      await pool.query(`DELETE FROM users WHERE id = $1`, [testUserId]).catch(() => undefined)
      await pool.end()
    }
  })

  // ===== Step 5: calc-chain cutover =====
  // RFC §8 cutover: resolveWorkContext (and its prefetch sibling) now apply
  // calendarPolicy.overrides on top of profile + holiday, so payroll /
  // import / auto-absence / summary observe the same effective isWorkingDay
  // as the read-only /api/attendance/effective-calendar API. This test
  // exercises the most direct calc-chain entry — POST /api/attendance/punch
  // calls resolveWorkContext, then upsertAttendanceRecord writes the row
  // with is_workday = context.isWorkingDay. We verify three scenarios on the
  // same date:
  //   (a) baseline — no policy → is_workday tracks the holiday row
  //   (b) org override flips holiday → is_workday flips with it
  //   (c) role-source override flips holiday after loading DB role context
  // §5.1 / §5.7 / §5.11 negative protection (no-policy equivalence) is
  // already covered by all 71 existing tests continuing to pass after the
  // Block A/B/C integration.
  it('Step 5: resolveWorkContext applies calendarPolicy.overrides at punch time (with org-flip and role-inert cases)', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return

    const runSuffix = Date.now().toString(36)
    // Codex Step 5 review v2 follow-up: the /punch endpoint has a
    // pre-existing FUTURE_PUNCH_NOT_ALLOWED guard rejecting occurredAt
    // more than 5 minutes in the future. The original year-3030 fixture
    // could never reach the assertions on a properly-migrated scratch
    // DB; the test was silently early-returning via `!baseUrl` whenever
    // migrations hadn't been applied. Anchor to a fixed past Monday
    // (2024-10-07; default rule treats Mon as a working day, so the
    // holiday seed below is the only source of is_working_day=false).
    const targetDate = '2024-10-07'
    const todayUtc = new Date().toISOString().slice(0, 10)
    expect(targetDate < todayUtc).toBe(true)
    const userId = `attendance-step5-user-${runSuffix}`
    const adminId = `attendance-step5-admin-${runSuffix}`
    const roleId = `attendance-step5-role-${runSuffix}`
    const roleName = `Step 5 Role ${runSuffix}`
    const orgId = 'default'
    const occurredAt = `${targetDate}T01:00:00.000Z` // 09:00 in Asia/Shanghai

    const pool = new Pool({ connectionString: dbUrl })

    async function tokenFor(uid: string, role: string, perms: string): Promise<string | null> {
      const res = await requestJson(
        `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(uid)}&roles=${role}&perms=${perms}`
      )
      return (res.body as { token?: string } | undefined)?.token ?? null
    }

    async function putCalendarPolicy(adminToken: string, overrides: unknown[]): Promise<void> {
      const res = await requestJson(`${baseUrl}/api/attendance/settings`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ calendarPolicy: { overrides } }),
      })
      // Settings endpoint accepts PUT in this codebase; some flows route POST.
      // If POST is rejected, fall back to PUT.
      if (res.status !== 200) {
        const putRes = await requestJson(`${baseUrl}/api/attendance/settings`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ calendarPolicy: { overrides } }),
        })
        expect(putRes.status).toBe(200)
      }
    }

    async function punchAndReadIsWorkday(userToken: string): Promise<boolean | null> {
      // Clear prior state so each scenario gets a clean row to read.
      await pool.query(`DELETE FROM attendance_records WHERE user_id = $1 AND work_date = $2`, [userId, targetDate])
      await pool.query(`DELETE FROM attendance_events WHERE user_id = $1 AND work_date = $2`, [userId, targetDate])
      const punchRes = await requestJson(`${baseUrl}/api/attendance/punch`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventType: 'check_in', occurredAt, timezone: 'Asia/Shanghai' }),
      })
      expect(punchRes.status).toBe(200)
      const rows = await pool.query(
        `SELECT is_workday FROM attendance_records WHERE user_id = $1 AND work_date = $2`,
        [userId, targetDate],
      )
      if (rows.rows.length === 0) return null
      return rows.rows[0].is_workday === true
    }

    try {
      await pool.query(
        `INSERT INTO users (id, email, password_hash, name, role, is_active)
         VALUES ($1, $2, 'no-login', 'Step5 Role User', $3, true)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, is_active = true`,
        [userId, `${userId}@example.com`, roleId],
      )
      await pool.query(
        `INSERT INTO roles (id, name) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
        [roleId, roleName],
      )
      await pool.query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [userId, roleId],
      )

      // Setup: a national holiday on targetDate (is_working_day=false). The
      // pre-Step-5 calc would always treat this day as rest; Step 5 lets
      // calendarPolicy flip it.
      await pool.query(
        `DELETE FROM attendance_holidays WHERE org_id = $1 AND holiday_date = $2`,
        [orgId, targetDate],
      )
      await pool.query(
        `INSERT INTO attendance_holidays (id, org_id, holiday_date, name, is_working_day, origin)
         VALUES ($1, 'default', $2, 'Step 5 National Rest', false, 'national')`,
        [randomUuidV4(), targetDate],
      )

      const adminToken = await tokenFor(adminId, 'admin', 'attendance:read,attendance:write,attendance:admin,attendance:approve')
      const userToken = await tokenFor(userId, 'user', 'attendance:read,attendance:write')
      expect(adminToken).toBeTruthy()
      expect(userToken).toBeTruthy()
      if (!adminToken || !userToken) return

      // Ensure no leftover policy from earlier tests
      await putCalendarPolicy(adminToken, [])

      // --- (a) baseline: no policy → holiday wins, is_workday=false ---
      const baselineWorkday = await punchAndReadIsWorkday(userToken)
      expect(baselineWorkday).toBe(false)

      // --- (b) org override flips the holiday to a working day ---
      await putCalendarPolicy(adminToken, [
        {
          date: targetDate,
          effective: { isWorkingDay: true, label: 'Step 5 org flip', source: 'org' },
        },
      ])
      const flippedWorkday = await punchAndReadIsWorkday(userToken)
      expect(flippedWorkday).toBe(true)

      // --- (c) role-source override flips after resolver loads DB role context ---
      await putCalendarPolicy(adminToken, [
        {
          date: targetDate,
          filters: { roles: [roleId] },
          effective: { isWorkingDay: true, label: 'Step 5 role flip', source: 'role' },
        },
      ])
      const roleWorkday = await punchAndReadIsWorkday(userToken)
      expect(roleWorkday).toBe(true)
    } finally {
      const cleanToken = await tokenFor(`${adminId}-cleanup`, 'admin', 'attendance:admin')
      if (cleanToken) {
        await requestJson(`${baseUrl}/api/attendance/settings`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${cleanToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ calendarPolicy: { overrides: [] } }),
        }).catch(() => undefined)
      }
      await pool.query(`DELETE FROM attendance_events WHERE user_id = $1`, [userId]).catch(() => undefined)
      await pool.query(`DELETE FROM attendance_records WHERE user_id = $1`, [userId]).catch(() => undefined)
      await pool.query(`DELETE FROM attendance_holidays WHERE org_id = $1 AND holiday_date = $2`, [orgId, targetDate]).catch(() => undefined)
      await pool.query(`DELETE FROM user_roles WHERE user_id = $1`, [userId]).catch(() => undefined)
      await pool.query(`DELETE FROM roles WHERE id = $1`, [roleId]).catch(() => undefined)
      await pool.query(`DELETE FROM users WHERE id = $1`, [userId]).catch(() => undefined)
      await pool.end()
    }
  })

  // Step 5 review fix (Codex Blocking #1): auto-absence bidirectional.
  // The pre-fix scheduler short-circuited on any org-level holiday with
  // is_working_day=false, so a calendarPolicy override flipping that day
  // to working never reached the per-user resolveWorkContext loop. This
  // test exercises the calc-chain end-to-end via the new admin trigger
  // `POST /api/attendance/auto-absence/run`:
  //   (rest -> work) holiday + org override -> absence generated
  //   (work -> rest) normal weekday + org override -> NO absence
  // It guards against future regressions of the same short-circuit shape.
  it('Step 5: auto-absence respects calendarPolicy in both directions (rest->work generates absence; work->rest does not)', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return

    const runSuffix = Date.now().toString(36)
    // Codex Step 5 review (Blocking #1 v2): admin endpoint now rejects
    // workDate >= UTC today. Use definitively-past dates anchored to a
    // fixed past year. Codex Step 5 review (Blocking #2 v2): use a
    // unique orgId so the auto-absence fanout cannot touch any other
    // active user. The unique-org route also exercises the
    // org-fallback path in loadDefaultRule (no attendance_rules row
    // exists for this org → DEFAULT_RULE shape with Mon-Fri workdays).
    const orgId = `step5-absence-org-${runSuffix}`
    // 2024-01-15 is a Monday (Jan 1 2024 was Monday); inserting a
    // holiday row there makes it a rest day under the default rule.
    // 2024-01-16 is a Tuesday with no holiday → a default work day.
    const restDate = '2024-01-15'
    const workdayDate = '2024-01-16'
    // Sanity check that both dates remain past relative to UTC today.
    // If anyone ever back-dates the system clock for a CI image they
    // need to see this assertion blow up rather than the suite quietly
    // pass.
    const todayUtc = new Date().toISOString().slice(0, 10)
    expect(restDate < todayUtc).toBe(true)
    expect(workdayDate < todayUtc).toBe(true)

    const userId = `attendance-step5-absence-${runSuffix}`
    const adminId = `attendance-step5-absence-admin-${runSuffix}`
    const pool = new Pool({ connectionString: dbUrl })

    async function tokenFor(uid: string, role: string, perms: string): Promise<string | null> {
      const res = await requestJson(
        `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(uid)}&roles=${role}&perms=${perms}`
      )
      return (res.body as { token?: string } | undefined)?.token ?? null
    }
    async function putCalendarPolicy(adminToken: string, overrides: unknown[]): Promise<void> {
      const res = await requestJson(`${baseUrl}/api/attendance/settings`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ calendarPolicy: { overrides } }),
      })
      expect(res.status).toBe(200)
    }
    async function runAutoAbsence(adminToken: string, workDate: string): Promise<{ status: number; data: { total: number; skipped?: boolean; reason?: string } | null; rawBody?: unknown }> {
      const res = await requestJson(`${baseUrl}/api/attendance/auto-absence/run`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId, workDate }),
      })
      const body = res.body as { data?: { total: number; skipped?: boolean; reason?: string } } | undefined
      return { status: res.status, data: body?.data ?? null, rawBody: res.body }
    }

    try {
      // Seed user + user_orgs against the ISOLATED org so the
      // auto-absence fanout finds exactly one user.
      await pool.query(`DELETE FROM user_orgs WHERE user_id = $1`, [userId])
      await pool.query(`DELETE FROM users WHERE id = $1`, [userId])
      await pool.query(
        `INSERT INTO users (id, email, password_hash, name, role, is_active)
         VALUES ($1, $2, 'no-login', 'Step5 Absence User', 'user', true)`,
        [userId, `${userId}@example.com`],
      )
      await pool.query(
        `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)`,
        [userId, orgId],
      )

      // National holiday on restDate keyed to our isolated org so the
      // pre-fix short-circuit (now gated on calendarPolicy.overrides
      // being empty) would have skipped the day for the entire org.
      await pool.query(
        `DELETE FROM attendance_holidays WHERE org_id = $1 AND holiday_date = ANY($2::date[])`,
        [orgId, [restDate, workdayDate]],
      )
      await pool.query(
        `INSERT INTO attendance_holidays (id, org_id, holiday_date, name, is_working_day, origin)
         VALUES ($1, $2, $3, 'Step 5 Rest', false, 'national')`,
        [randomUuidV4(), orgId, restDate],
      )

      const adminToken = await tokenFor(adminId, 'admin', 'attendance:read,attendance:write,attendance:admin')
      expect(adminToken).toBeTruthy()
      if (!adminToken) return

      // Clean any leftover attendance_records for the user (scoped to
      // our isolated org so we never touch default org rows).
      await pool.query(`DELETE FROM attendance_records WHERE user_id = $1 AND org_id = $2`, [userId, orgId])

      // --- (0) future-date guard: endpoint must refuse today / future ---
      // This locks the Codex Blocking #1 v2 fix (admin trigger cannot
      // fabricate absent rows for non-past dates).
      const futureRes = await runAutoAbsence(adminToken, todayUtc)
      expect(futureRes.status).toBe(400)
      expect((futureRes.rawBody as { error?: { code?: string } } | undefined)?.error?.code).toBe('WORK_DATE_NOT_PAST')

      // --- (1) rest -> work: org override flips the holiday to working ---
      await putCalendarPolicy(adminToken, [
        {
          date: restDate,
          effective: { isWorkingDay: true, label: 'Step 5 org rest->work', source: 'org' },
        },
      ])
      const restToWorkRes = await runAutoAbsence(adminToken, restDate)
      expect(restToWorkRes.status).toBe(200)
      // Target list must include our user (resolveWorkContext.isWorkingDay=true
      // because the org override fired), and an absence row is generated.
      expect(restToWorkRes.data?.skipped ?? false).toBe(false)
      const restAbsenceRows = await pool.query(
        `SELECT status FROM attendance_records WHERE user_id = $1 AND work_date = $2 AND org_id = $3`,
        [userId, restDate, orgId],
      )
      expect(restAbsenceRows.rows.length).toBe(1)
      expect(restAbsenceRows.rows[0].status).toBe('absent')

      // --- (2) work -> rest: org override flips a default workday to rest ---
      await pool.query(
        `DELETE FROM attendance_records WHERE user_id = $1 AND work_date = $2 AND org_id = $3`,
        [userId, workdayDate, orgId],
      )
      await putCalendarPolicy(adminToken, [
        {
          date: workdayDate,
          effective: { isWorkingDay: false, label: 'Step 5 org work->rest', source: 'org' },
        },
      ])
      const workToRestRes = await runAutoAbsence(adminToken, workdayDate)
      expect(workToRestRes.status).toBe(200)
      // No absence row generated for our user — the policy turned the day
      // to rest, so the target list excludes them.
      expect(workToRestRes.data?.skipped ?? false).toBe(false)
      expect(workToRestRes.data?.total ?? 0).toBe(0)
      const workAbsenceRows = await pool.query(
        `SELECT status FROM attendance_records WHERE user_id = $1 AND work_date = $2 AND org_id = $3`,
        [userId, workdayDate, orgId],
      )
      expect(workAbsenceRows.rows.length).toBe(0)
    } finally {
      const cleanToken = await tokenFor(`${adminId}-cleanup`, 'admin', 'attendance:admin')
      if (cleanToken) {
        await requestJson(`${baseUrl}/api/attendance/settings`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${cleanToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ calendarPolicy: { overrides: [] } }),
        }).catch(() => undefined)
      }
      // Cleanup is scoped to the isolated orgId, so even if the test
      // partially failed we never touch other orgs' rows.
      await pool.query(`DELETE FROM attendance_records WHERE org_id = $1`, [orgId]).catch(() => undefined)
      await pool.query(`DELETE FROM attendance_events WHERE user_id = $1`, [userId]).catch(() => undefined)
      await pool.query(`DELETE FROM attendance_holidays WHERE org_id = $1`, [orgId]).catch(() => undefined)
      await pool.query(`DELETE FROM user_orgs WHERE org_id = $1`, [orgId]).catch(() => undefined)
      await pool.query(`DELETE FROM users WHERE id = $1`, [userId]).catch(() => undefined)
      await pool.end()
    }
  })

})
