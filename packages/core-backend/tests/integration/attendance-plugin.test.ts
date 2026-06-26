import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import type { MetaSheetServer } from '../../src/index'
import * as path from 'path'
import net from 'net'
import fs from 'fs/promises'
import { randomUUID } from 'crypto'
import { createRequire } from 'module'
import { Pool } from 'pg'
import http from 'http'
import { AttendanceExpiryService } from '../../src/services/AttendanceExpiryService'
import { AttendanceScheduler } from '../../src/services/AttendanceScheduler'

const require = createRequire(import.meta.url)
type AttendancePluginTestModule = {
  __attendanceAutoShiftForTests?: {
    AUTO_SHIFT_AUTO_WRITE_SYSTEM_ROLE_TAG: string
    runAttendanceAutoShiftAutoWriteOnce(db: unknown, options?: Record<string, unknown>): Promise<any>
  }
}

function getAttendancePluginForTest(): AttendancePluginTestModule {
  return require('../../../../plugins/plugin-attendance/index.cjs') as AttendancePluginTestModule
}

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

function localDateKeyOffset(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() + days)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function dateOnlyForTest(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value ?? '').slice(0, 10)
}

function createPluginDbForTest(pool: Pool) {
  return {
    async query(sql: string, params?: unknown[]) {
      const result = await pool.query(sql, params as any[])
      return result.rows
    },
    async transaction<T>(handler: (client: { query(sql: string, params?: unknown[]): Promise<any[]> }) => Promise<T>): Promise<T> {
      const client = await pool.connect()
      const trx = {
        async query(sql: string, params?: unknown[]) {
          const result = await client.query(sql, params as any[])
          return result.rows
        },
      }
      try {
        await client.query('BEGIN')
        const value = await handler(trx)
        await client.query('COMMIT')
        return value
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },
  }
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

const attendanceIntegrationDbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const attendanceIntegrationDescribe = attendanceIntegrationDbUrl ? describe : describe.skip
const attendanceIntegrationMissingDbMessage =
  'Attendance integration tests require ATTENDANCE_TEST_DATABASE_URL or DATABASE_URL; skipping instead of silently returning.'

async function requireAttendanceTable(pool: Pool, tableName: string): Promise<void> {
  const tableCheck = await pool.query(`SELECT to_regclass($1) AS name`, [`public.${tableName}`])
  if (!tableCheck.rows[0]?.name) {
    throw new Error(
      `Attendance integration database is missing ${tableName}; run core-backend migrations before executing this suite.`
    )
  }
}

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

async function fetchImportJob(baseUrl: string, token: string, jobId: string): Promise<any> {
  const jobRes = await requestJson(`${baseUrl}/api/attendance/import/jobs/${jobId}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  })
  expect(jobRes.status).toBe(200)
  return (jobRes.body as { data?: any } | undefined)?.data
}

async function waitForImportJobCompletion(
  baseUrl: string,
  token: string,
  jobId: string,
  {
    attempts = 480,
    intervalMs = 250,
    failureMessage = 'async import job failed',
    settle,
    settleAttempts = 40,
    settleIntervalMs = 250,
  }: {
    attempts?: number
    intervalMs?: number
    failureMessage?: string
    // Optional gate applied AFTER status === 'completed'. The compact job summary
    // (skippedCount/skippedRows, and the final failedRows) is written a beat after the status
    // flips, so a caller asserting exact counts must wait for it to settle. Polls a bounded
    // extra budget; if 'completed' is reached but the predicate never holds, throws with the
    // full job payload so a genuine missing-summary bug fails loudly (not silently flaky).
    // See docs/development/attendance-plugin-commit-async-skipped-summary-flake-lead-20260526.md (#1905).
    settle?: (job: any) => boolean
    settleAttempts?: number
    settleIntervalMs?: number
  } = {}
): Promise<any> {
  let lastJobData: any = null

  for (let index = 0; index < attempts; index += 1) {
    lastJobData = await fetchImportJob(baseUrl, token, jobId)
    const status = String(lastJobData?.status || '')
    if (status === 'completed') {
      if (!settle) return lastJobData
      for (let s = 0; s <= settleAttempts; s += 1) {
        if (settle(lastJobData)) return lastJobData
        if (s === settleAttempts) break
        // eslint-disable-next-line no-await-in-loop
        await delay(settleIntervalMs)
        // eslint-disable-next-line no-await-in-loop
        lastJobData = await fetchImportJob(baseUrl, token, jobId)
      }
      throw new Error(
        `Import job ${jobId} reached 'completed' but its summary did not settle within ` +
          `${(settleAttempts * settleIntervalMs) / 1000}s; last job: ${JSON.stringify(lastJobData)}`
      )
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

attendanceIntegrationDescribe(
  attendanceIntegrationDbUrl
    ? 'Attendance Plugin Integration'
    : `Attendance Plugin Integration (${attendanceIntegrationMissingDbMessage})`,
  () => {
  let server: MetaSheetServer | undefined
  let baseUrl: string | undefined
  let importUploadDir: string | undefined

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen) {
      throw new Error('Attendance integration tests require an available loopback port.')
    }

    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) {
      throw new Error(attendanceIntegrationMissingDbMessage)
    }

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
      await requireAttendanceTable(pool, 'attendance_events')
      await requireAttendanceTable(pool, 'approval_instances')
      await requireAttendanceTable(pool, 'attendance_leave_types')
      await requireAttendanceTable(pool, 'attendance_overtime_rules')
      await requireAttendanceTable(pool, 'attendance_shifts')
      await requireAttendanceTable(pool, 'attendance_shift_assignments')
      await requireAttendanceTable(pool, 'attendance_holidays')
      await requireAttendanceTable(pool, 'attendance_rotation_rules')
      await requireAttendanceTable(pool, 'attendance_rotation_assignments')
      await requireAttendanceTable(pool, 'attendance_groups')
      await requireAttendanceTable(pool, 'attendance_group_members')
      await requireAttendanceTable(pool, 'attendance_schedule_groups')
      await requireAttendanceTable(pool, 'attendance_schedule_group_members')
      await requireAttendanceTable(pool, 'attendance_scheduler_scopes')
      await requireAttendanceTable(pool, 'attendance_rule_template_library')
      await requireAttendanceTable(pool, 'attendance_rule_template_versions')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Attendance integration database setup failed: ${message}`)
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
    if (!address || typeof address === 'string') {
      throw new Error('Attendance integration server did not expose a TCP address.')
    }
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  beforeEach(() => {
    if (!baseUrl) {
      throw new Error('Attendance integration server was not started; inspect beforeAll setup output.')
    }
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
        attendanceType: 'fixed_shift',
        description: 'integration-test',
      }),
    })
    expect(createGroupRes.status).toBe(200)
    const groupId = (createGroupRes.body as { data?: { id?: string } } | undefined)?.data?.id
    expect(groupId).toBeTruthy()
    const createdGroupCode = (createGroupRes.body as { data?: { code?: string } } | undefined)?.data?.code
    const createdGroupType = (createGroupRes.body as { data?: { attendanceType?: string } } | undefined)?.data?.attendanceType
    expect(createdGroupCode).toMatch(/^[a-z0-9-]+-[a-f0-9]{8}$/)
    expect(createdGroupType).toBe('fixed_shift')

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
      const updatedGroupType = (updateGroupRes.body as { data?: { attendanceType?: string } } | undefined)?.data?.attendanceType
      expect(updatedGroupCode).toBe(createdGroupCode)
      expect(updatedGroupType).toBe('fixed_shift')

      const changeGroupTypeRes = await requestJson(`${baseUrl}/api/attendance/groups/${groupId}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: `${groupName} Updated`,
          timezone: 'UTC',
          attendanceType: 'scheduled_shift',
          description: 'integration-test-updated',
        }),
      })
      expect(changeGroupTypeRes.status).toBe(409)
      expect((changeGroupTypeRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('ATTENDANCE_GROUP_TYPE_LOCKED')

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

  it('lets attendance self-service users read only active leave and overtime policies', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return
    const runSuffix = Date.now().toString(36)
    const adminUserId = `attendance-policy-admin-${runSuffix}`
    const employeeUserId = `attendance-policy-employee-${runSuffix}`
    const previousRbacBypass = process.env.RBAC_BYPASS
    const pool = new Pool({ connectionString: dbUrl })

    try {
      process.env.RBAC_BYPASS = 'false'
      await pool.query(
        `INSERT INTO permissions (code, name, description)
         VALUES
           ('attendance:read', 'Attendance Read', 'Read attendance data'),
           ('attendance:write', 'Attendance Write', 'Write attendance data'),
           ('attendance:admin', 'Attendance Admin', 'Administer attendance')
         ON CONFLICT (code) DO NOTHING`
      )
      await pool.query(
        `INSERT INTO user_permissions (user_id, permission_code)
         VALUES
           ($1, 'attendance:read'),
           ($1, 'attendance:write'),
           ($1, 'attendance:admin'),
           ($2, 'attendance:read'),
           ($2, 'attendance:write')
         ON CONFLICT DO NOTHING`,
        [adminUserId, employeeUserId]
      )

      const adminTokenRes = await requestJson(
        `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(adminUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
      )
      const employeeTokenRes = await requestJson(
        `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(employeeUserId)}&roles=user&perms=attendance:read,attendance:write`
      )
      const adminToken = (adminTokenRes.body as { token?: string } | undefined)?.token
      const employeeToken = (employeeTokenRes.body as { token?: string } | undefined)?.token
      expect(adminToken).toBeTruthy()
      expect(employeeToken).toBeTruthy()
      if (!adminToken || !employeeToken) return

      const activeLeaveName = `Policy Active Leave ${runSuffix}`
      const inactiveLeaveName = `Policy Inactive Leave ${runSuffix}`
      const activeOvertimeName = `Policy Active OT ${runSuffix}`
      const inactiveOvertimeName = `Policy Inactive OT ${runSuffix}`

      for (const payload of [
        { code: `active-leave-${runSuffix}`, name: activeLeaveName, isActive: true },
        { code: `inactive-leave-${runSuffix}`, name: inactiveLeaveName, isActive: false },
      ]) {
        const res = await requestJson(`${baseUrl}/api/attendance/leave-types`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        })
        expect(res.status).toBe(201)
      }

      for (const payload of [
        { name: activeOvertimeName, minMinutes: 0, isActive: true },
        { name: inactiveOvertimeName, minMinutes: 0, isActive: false },
      ]) {
        const res = await requestJson(`${baseUrl}/api/attendance/overtime-rules`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        })
        expect(res.status).toBe(201)
      }

      const employeeLeaveList = await requestJson(`${baseUrl}/api/attendance/leave-types?isActive=false`, {
        headers: { Authorization: `Bearer ${employeeToken}` },
      })
      expect(employeeLeaveList.status).toBe(200)
      const leaveItems =
        (employeeLeaveList.body as { data?: { items?: Array<{ name?: string; isActive?: boolean }> } } | undefined)
          ?.data?.items ?? []
      expect(
        leaveItems.some(item => item.name === activeLeaveName && item.isActive === true),
        employeeLeaveList.raw
      ).toBe(true)
      expect(leaveItems.some(item => item.name === inactiveLeaveName)).toBe(false)

      const employeeOvertimeList = await requestJson(`${baseUrl}/api/attendance/overtime-rules?isActive=false`, {
        headers: { Authorization: `Bearer ${employeeToken}` },
      })
      expect(employeeOvertimeList.status).toBe(200)
      const overtimeItems =
        (employeeOvertimeList.body as { data?: { items?: Array<{ name?: string; isActive?: boolean }> } } | undefined)
          ?.data?.items ?? []
      expect(
        overtimeItems.some(item => item.name === activeOvertimeName && item.isActive === true),
        employeeOvertimeList.raw
      ).toBe(true)
      expect(overtimeItems.some(item => item.name === inactiveOvertimeName)).toBe(false)

      const forbiddenCreate = await requestJson(`${baseUrl}/api/attendance/leave-types`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${employeeToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: `Forbidden Leave ${runSuffix}` }),
      })
      expect(forbiddenCreate.status).toBe(403)
    } finally {
      process.env.RBAC_BYPASS = previousRbacBypass
      await pool.query('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[adminUserId, employeeUserId]]).catch(() => undefined)
      await pool.end()
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
    expect(assignmentRow?.assignment?.slotIndex).toBe(0)
    expect(assignmentRow?.assignment?.slot_index).toBe(0)
    expect(assignmentRow?.assignment?.assignmentKind).toBe('regular')
    expect(assignmentRow?.assignment?.assignment_kind).toBe('regular')
    expect(assignmentRow?.assignment?.temporaryMode).toBeNull()
    expect(assignmentRow?.assignment?.temporary_mode).toBeNull()
    expect(assignmentRow?.assignment?.temporaryReplacesKind).toBeNull()
    expect(assignmentRow?.assignment?.temporary_replaces_kind).toBeNull()
    expect(assignmentRow?.assignment?.temporaryReplacesAssignmentId).toBeNull()
    expect(assignmentRow?.assignment?.temporary_replaces_assignment_id).toBeNull()
    expect(assignmentRow?.shift?.workStartTime).toBe('08:30:00')
    expect(assignmentRow?.shift?.work_start_time).toBe('08:30:00')

    const pool = new Pool({ connectionString: attendanceIntegrationDbUrl })
    try {
      const columnRes = await pool.query(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'attendance_shift_assignments'
            AND column_name = 'slot_index'`
      )
      expect(columnRes.rowCount).toBe(1)
      const tempColumnNames = [
        'assignment_kind',
        'temporary_mode',
        'temporary_replaces_kind',
        'temporary_replaces_assignment_id',
        'temporary_reason',
        'temporary_created_by',
        'temporary_created_at',
      ]
      const tempColumnRes = await pool.query(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'attendance_shift_assignments'
            AND column_name = ANY($1::text[])`,
        [tempColumnNames]
      )
      expect(tempColumnRes.rows.map(row => row.column_name).sort()).toEqual([...tempColumnNames].sort())
      const persistedRes = await pool.query(
        `SELECT slot_index, assignment_kind, temporary_mode, temporary_replaces_kind,
                temporary_replaces_assignment_id, temporary_reason, temporary_created_by,
                temporary_created_at
           FROM attendance_shift_assignments
          WHERE id = $1`,
        [assignmentId]
      )
      expect(Number(persistedRes.rows[0]?.slot_index)).toBe(0)
      expect(persistedRes.rows[0]).toMatchObject({
        assignment_kind: 'regular',
        temporary_mode: null,
        temporary_replaces_kind: null,
        temporary_replaces_assignment_id: null,
        temporary_reason: null,
        temporary_created_by: null,
        temporary_created_at: null,
      })
      await expect(
        pool.query(
          `UPDATE attendance_shift_assignments
              SET temporary_reason = 'should-not-exist-on-regular'
            WHERE id = $1`,
          [assignmentId]
        )
      ).rejects.toMatchObject({ code: '23514' })
      await expect(
        pool.query(
          `UPDATE attendance_shift_assignments
              SET assignment_kind = 'temporary',
                  temporary_mode = 'replace',
                  temporary_replaces_kind = 'shift',
                  temporary_replaces_assignment_id = NULL,
                  temporary_created_by = $2,
                  temporary_created_at = now(),
                  end_date = '2026-03-20'
            WHERE id = $1`,
          [assignmentId, testUserId]
        )
      ).rejects.toMatchObject({ code: '23514' })
      await expect(
        pool.query(
          `UPDATE attendance_shift_assignments
              SET assignment_kind = 'temporary',
                  temporary_mode = NULL,
                  temporary_replaces_kind = 'shift',
                  temporary_replaces_assignment_id = $1,
                  temporary_created_by = $2,
                  temporary_created_at = now(),
                  end_date = '2026-03-20'
            WHERE id = $1`,
          [assignmentId, testUserId]
        )
      ).rejects.toMatchObject({ code: '23514' })
      await expect(
        pool.query(
          `UPDATE attendance_shift_assignments
              SET assignment_kind = 'temporary',
                  temporary_mode = 'replace',
                  temporary_replaces_kind = NULL,
                  temporary_replaces_assignment_id = $1,
                  temporary_created_by = $2,
                  temporary_created_at = now(),
                  end_date = '2026-03-20'
            WHERE id = $1`,
          [assignmentId, testUserId]
        )
      ).rejects.toMatchObject({ code: '23514' })
      await expect(
        pool.query(
          `UPDATE attendance_shift_assignments
              SET assignment_kind = 'temporary',
                  temporary_mode = 'replace',
                  temporary_replaces_kind = 'shift',
                  temporary_replaces_assignment_id = $1,
                  temporary_created_by = $2,
                  temporary_created_at = now(),
                  end_date = NULL
            WHERE id = $1`,
          [assignmentId, testUserId]
        )
      ).rejects.toMatchObject({ code: '23514' })
      await expect(
        pool.query(
          `UPDATE attendance_shift_assignments
              SET assignment_kind = 'temporary',
                  temporary_mode = 'replace',
                  temporary_replaces_kind = 'shift',
                  temporary_replaces_assignment_id = $1,
                  temporary_created_by = $2,
                  temporary_created_at = now(),
                  end_date = '2026-03-21'
            WHERE id = $1`,
          [assignmentId, testUserId]
        )
      ).rejects.toMatchObject({ code: '23514' })
      await pool.query(
        `UPDATE attendance_shift_assignments
            SET assignment_kind = 'temporary',
                temporary_mode = 'replace',
                temporary_replaces_kind = 'shift',
                temporary_replaces_assignment_id = $1,
                temporary_reason = 'temporary coverage',
                temporary_created_by = $2,
                temporary_created_at = '2026-03-20T01:02:03Z',
                end_date = '2026-03-20'
          WHERE id = $1`,
        [assignmentId, testUserId]
      )
      const tempAssignmentListRes = await requestJson(
        `${baseUrl}/api/attendance/assignments?userId=${encodeURIComponent(testUserId)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      )
      expect(tempAssignmentListRes.status).toBe(200)
      const tempAssignmentItems = (tempAssignmentListRes.body as { data?: { items?: any[] } } | undefined)?.data?.items ?? []
      const tempAssignmentRow = tempAssignmentItems.find((item) => item?.assignment?.id === assignmentId)
      expect(tempAssignmentRow?.assignment).toMatchObject({
        assignmentKind: 'temporary',
        assignment_kind: 'temporary',
        temporaryMode: 'replace',
        temporary_mode: 'replace',
        temporaryReplacesKind: 'shift',
        temporary_replaces_kind: 'shift',
        temporaryReplacesAssignmentId: assignmentId,
        temporary_replaces_assignment_id: assignmentId,
        temporaryReason: 'temporary coverage',
        temporary_reason: 'temporary coverage',
        temporaryCreatedBy: testUserId,
        temporary_created_by: testUserId,
      })
      expect(tempAssignmentRow?.assignment?.temporaryCreatedAt).toBeTruthy()
      expect(tempAssignmentRow?.assignment?.temporary_created_at).toBeTruthy()
    } finally {
      await pool.end()
    }
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

  it('enforces multi-shift slot conflicts on manual assignment create and update', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return

    const runSuffix = Date.now().toString(36)
    const adminUserId = `attendance-multishift-admin-${runSuffix}`
    const workDate = '2026-07-08'
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(adminUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    }
    const pool = new Pool({ connectionString: dbUrl })
    let originalSettings: Record<string, unknown> = {}

    async function saveSettings(patch: Record<string, unknown>) {
      const res = await requestJson(`${baseUrl}/api/attendance/settings`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(patch),
      })
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      return res
    }

    async function createShift(name: string, workStartTime: string, workEndTime: string, workingDays: number[] = [1, 2, 3, 4, 5]): Promise<string> {
      const shiftRes = await requestJson(`${baseUrl}/api/attendance/shifts`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name,
          timezone: 'Asia/Shanghai',
          workStartTime,
          workEndTime,
          workingDays,
        }),
      })
      expect(shiftRes.status, JSON.stringify(shiftRes.body)).toBe(201)
      const shiftId = (shiftRes.body as { data?: { id?: string } } | undefined)?.data?.id
      expect(shiftId).toBeTruthy()
      if (!shiftId) throw new Error('missing shift id')
      return shiftId
    }

    async function createAssignment(userId: string, shiftId: string, slotIndex?: number, date: string = workDate) {
      const body: Record<string, unknown> = {
        userId,
        shiftId,
        startDate: date,
        endDate: date,
        isActive: true,
      }
      if (slotIndex !== undefined) body.slotIndex = slotIndex
      return requestJson(`${baseUrl}/api/attendance/assignments`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
    }

    function expectShiftAssignmentConflict(res: HttpResponse) {
      expect(res.status).toBe(409)
      const error = (res.body as { error?: { code?: string; details?: { conflictType?: string } } } | undefined)?.error
      expect(error?.code).toBe('ATTENDANCE_SCHEDULE_ASSIGNMENT_CONFLICT')
      expect(error?.details?.conflictType).toBe('shift_assignment_overlap')
    }

    try {
      const settingsRes = await requestJson(`${baseUrl}/api/attendance/settings`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(settingsRes.status).toBe(200)
      originalSettings = ((settingsRes.body as { data?: Record<string, unknown> } | undefined)?.data ?? {}) as Record<string, unknown>

      const morningShiftId = await createShift(`Multi Shift Morning ${runSuffix}`, '08:00', '12:00')
      const eveningShiftId = await createShift(`Multi Shift Evening ${runSuffix}`, '13:00', '17:00')
      const overlapShiftId = await createShift(`Multi Shift Overlap ${runSuffix}`, '11:00', '15:00')

      await saveSettings({
        shiftEditPolicy: { mode: 'unrestricted', windowDays: 0 },
        shiftCompliance: { enforcement: 'warn', dailyMaxMinutes: null, weeklyMaxMinutes: null, monthlyMaxMinutes: null },
        multiShiftDay: { enabled: false, maxSlots: 3 },
      })

      const defaultOffUserId = `${adminUserId}-default-off`
      const defaultOffBaseRes = await createAssignment(defaultOffUserId, morningShiftId, 0)
      expect(defaultOffBaseRes.status).toBe(201)
      const defaultOffSecondRes = await createAssignment(defaultOffUserId, eveningShiftId, 1)
      expectShiftAssignmentConflict(defaultOffSecondRes)

      const defaultOffEffectiveCalendarRes = await requestJson(
        `${baseUrl}/api/attendance/effective-calendar?from=${workDate}&to=${workDate}&userId=${encodeURIComponent(defaultOffUserId)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      expect(defaultOffEffectiveCalendarRes.status, JSON.stringify(defaultOffEffectiveCalendarRes.body)).toBe(200)
      const defaultOffItem = ((defaultOffEffectiveCalendarRes.body as { data?: { items?: Array<{ effective?: { plannedMinutes?: number; slots?: unknown[] } }> } } | undefined)?.data?.items ?? [])[0]
      expect(defaultOffItem?.effective?.plannedMinutes).toBeUndefined()
      expect(defaultOffItem?.effective?.slots).toBeUndefined()

      await saveSettings({
        multiShiftDay: { enabled: true, maxSlots: 3 },
        shiftCompliance: { enforcement: 'warn', dailyMaxMinutes: null, weeklyMaxMinutes: null, monthlyMaxMinutes: null },
      })

      const multiSlotUserId = `${adminUserId}-enabled`
      const morningAssignmentRes = await createAssignment(multiSlotUserId, morningShiftId, 0)
      expect(morningAssignmentRes.status, JSON.stringify(morningAssignmentRes.body)).toBe(201)
      const morningAssignment = (morningAssignmentRes.body as { data?: { assignment?: { id?: string; slotIndex?: number; slot_index?: number } } } | undefined)?.data?.assignment
      expect(morningAssignment?.slotIndex).toBe(0)
      expect(morningAssignment?.slot_index).toBe(0)
      expect(morningAssignment?.id).toBeTruthy()

      const eveningAssignmentRes = await createAssignment(multiSlotUserId, eveningShiftId, 1)
      expect(eveningAssignmentRes.status, JSON.stringify(eveningAssignmentRes.body)).toBe(201)
      const eveningAssignment = (eveningAssignmentRes.body as { data?: { assignment?: { id?: string; slotIndex?: number; slot_index?: number } } } | undefined)?.data?.assignment
      expect(eveningAssignment?.slotIndex).toBe(1)
      expect(eveningAssignment?.slot_index).toBe(1)
      expect(eveningAssignment?.id).toBeTruthy()
      if (!eveningAssignment?.id) return

      const slotRows = await pool.query(
        `SELECT slot_index
           FROM attendance_shift_assignments
          WHERE user_id = $1
            AND start_date = $2::date
            AND COALESCE(is_active, true) = true
          ORDER BY slot_index ASC`,
        [multiSlotUserId, workDate]
      )
      expect(slotRows.rows.map(row => Number(row.slot_index))).toEqual([0, 1])

      const effectiveCalendarRes = await requestJson(
        `${baseUrl}/api/attendance/effective-calendar?from=${workDate}&to=${workDate}&userId=${encodeURIComponent(multiSlotUserId)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      expect(effectiveCalendarRes.status, JSON.stringify(effectiveCalendarRes.body)).toBe(200)
      const effectiveItems = (effectiveCalendarRes.body as { data?: { items?: Array<{ effective?: { plannedMinutes?: number; slots?: Array<{ slotIndex?: number; shiftId?: string; plannedMinutes?: number }> } }> } } | undefined)?.data?.items ?? []
      expect(effectiveItems).toHaveLength(1)
      const effectiveSlots = effectiveItems[0]?.effective?.slots ?? []
      expect(effectiveSlots.map(slot => slot.slotIndex)).toEqual([0, 1])
      expect(effectiveSlots.map(slot => slot.shiftId)).toEqual([morningShiftId, eveningShiftId])
      expect(effectiveSlots.map(slot => slot.plannedMinutes)).toEqual([240, 240])
      expect(effectiveItems[0]?.effective?.plannedMinutes).toBe(480)

      const comprehensivePreviewRes = await requestJson(`${baseUrl}/api/attendance/comprehensive-hours/preview`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          metric: 'planned',
          enforcement: 'warn',
          capMinutes: 1000,
          userId: multiSlotUserId,
          period: { type: 'custom_range', from: workDate, to: workDate },
        }),
      })
      expect(comprehensivePreviewRes.status, JSON.stringify(comprehensivePreviewRes.body)).toBe(200)
      const comprehensiveRows = (comprehensivePreviewRes.body as { data?: { rows?: Array<{ userId?: string; minutes?: number; plannedMinutes?: number }> } } | undefined)?.data?.rows ?? []
      expect(comprehensiveRows).toHaveLength(1)
      expect(comprehensiveRows[0]?.userId).toBe(multiSlotUserId)
      expect(comprehensiveRows[0]?.minutes).toBe(480)
      expect(comprehensiveRows[0]?.plannedMinutes).toBe(480)

      const saturdayDate = '2026-07-11'
      const weekdayOnlyShiftId = await createShift(`Multi Shift Weekday Only ${runSuffix}`, '08:00', '12:00', [1, 2, 3, 4, 5])
      const saturdayOnlyShiftId = await createShift(`Multi Shift Saturday Only ${runSuffix}`, '13:00', '17:00', [6])
      const mixedWorkingDaysUserId = `${adminUserId}-mixed-days`
      expect((await createAssignment(mixedWorkingDaysUserId, weekdayOnlyShiftId, 0, saturdayDate)).status).toBe(201)
      expect((await createAssignment(mixedWorkingDaysUserId, saturdayOnlyShiftId, 1, saturdayDate)).status).toBe(201)

      const mixedEffectiveCalendarRes = await requestJson(
        `${baseUrl}/api/attendance/effective-calendar?from=${saturdayDate}&to=${saturdayDate}&userId=${encodeURIComponent(mixedWorkingDaysUserId)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      expect(mixedEffectiveCalendarRes.status, JSON.stringify(mixedEffectiveCalendarRes.body)).toBe(200)
      const mixedItem = ((mixedEffectiveCalendarRes.body as { data?: { items?: Array<{ effective?: { isWorkingDay?: boolean; plannedMinutes?: number; slots?: Array<{ slotIndex?: number; plannedMinutes?: number }> } }> } } | undefined)?.data?.items ?? [])[0]
      expect(mixedItem?.effective?.isWorkingDay).toBe(true)
      expect(mixedItem?.effective?.slots?.map(slot => slot.slotIndex)).toEqual([0, 1])
      expect(mixedItem?.effective?.slots?.map(slot => slot.plannedMinutes)).toEqual([0, 240])
      expect(mixedItem?.effective?.plannedMinutes).toBe(240)

      const mixedComprehensivePreviewRes = await requestJson(`${baseUrl}/api/attendance/comprehensive-hours/preview`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          metric: 'planned',
          enforcement: 'warn',
          capMinutes: 1000,
          userId: mixedWorkingDaysUserId,
          period: { type: 'custom_range', from: saturdayDate, to: saturdayDate },
        }),
      })
      expect(mixedComprehensivePreviewRes.status, JSON.stringify(mixedComprehensivePreviewRes.body)).toBe(200)
      const mixedComprehensiveRows = (mixedComprehensivePreviewRes.body as { data?: { rows?: Array<{ minutes?: number; plannedMinutes?: number }> } } | undefined)?.data?.rows ?? []
      expect(mixedComprehensiveRows[0]?.minutes).toBe(240)
      expect(mixedComprehensiveRows[0]?.plannedMinutes).toBe(240)

      const fixedApplyUserId = `${adminUserId}-fixed-apply`
      expect((await createAssignment(fixedApplyUserId, eveningShiftId, 1)).status).toBe(201)
      const fixedGroupRes = await requestJson(`${baseUrl}/api/attendance/groups`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: `multi-shift-fixed-${runSuffix}`,
          timezone: 'Asia/Shanghai',
          attendanceType: 'fixed_shift',
          description: 'multi-shift fixed apply compatibility',
        }),
      })
      expect(fixedGroupRes.status, JSON.stringify(fixedGroupRes.body)).toBe(200)
      const fixedGroupId = (fixedGroupRes.body as { data?: { id?: string } } | undefined)?.data?.id
      expect(fixedGroupId).toBeTruthy()
      if (!fixedGroupId) return
      const fixedMemberRes = await requestJson(`${baseUrl}/api/attendance/groups/${fixedGroupId}/members`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ userIds: [fixedApplyUserId] }),
      })
      expect(fixedMemberRes.status, JSON.stringify(fixedMemberRes.body)).toBe(200)

      const fixedApplyRes = await requestJson(`${baseUrl}/api/attendance/groups/${fixedGroupId}/fixed-schedule/apply`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ shiftId: morningShiftId, startDate: workDate, endDate: workDate }),
      })
      expect(fixedApplyRes.status, JSON.stringify(fixedApplyRes.body)).toBe(201)
      const fixedCreated = (fixedApplyRes.body as { data?: { created?: Array<{ slotIndex?: number; slot_index?: number; shiftId?: string; shift_id?: string }> } } | undefined)?.data?.created ?? []
      expect(fixedCreated).toHaveLength(1)
      expect(fixedCreated[0]?.slotIndex).toBe(0)
      expect(fixedCreated[0]?.slot_index).toBe(0)
      expect(fixedCreated[0]?.shiftId ?? fixedCreated[0]?.shift_id).toBe(morningShiftId)

      const fixedRowsAfterApply = await pool.query(
        `SELECT shift_id, slot_index, publish_status, published_at, locked_at, producer_type
           FROM attendance_shift_assignments
          WHERE user_id = $1
            AND start_date = $2::date
            AND COALESCE(is_active, true) = true
          ORDER BY slot_index ASC`,
        [fixedApplyUserId, workDate],
      )
      expect(fixedRowsAfterApply.rows.map(row => ({ shiftId: row.shift_id, slotIndex: Number(row.slot_index) }))).toEqual([
        { shiftId: morningShiftId, slotIndex: 0 },
        { shiftId: eveningShiftId, slotIndex: 1 },
      ])
      const fixedApplyManagedRow = fixedRowsAfterApply.rows.find(row => row.shift_id === morningShiftId)
      expect(fixedApplyManagedRow?.publish_status).toBe('published')
      expect(fixedApplyManagedRow?.producer_type).toBe('attendance_group_fixed_schedule')

      const fixedRebuildRes = await requestJson(`${baseUrl}/api/attendance/groups/${fixedGroupId}/fixed-schedule/rebuild`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ shiftId: morningShiftId, startDate: workDate, endDate: workDate }),
      })
      expect(fixedRebuildRes.status, JSON.stringify(fixedRebuildRes.body)).toBe(200)
      const fixedRowsAfterRebuild = await pool.query(
        `SELECT shift_id, slot_index, publish_status, published_at, locked_at, producer_type
           FROM attendance_shift_assignments
          WHERE user_id = $1
            AND start_date = $2::date
            AND COALESCE(is_active, true) = true
          ORDER BY slot_index ASC`,
        [fixedApplyUserId, workDate],
      )
      expect(fixedRowsAfterRebuild.rows.map(row => ({ shiftId: row.shift_id, slotIndex: Number(row.slot_index) }))).toEqual([
        { shiftId: morningShiftId, slotIndex: 0 },
        { shiftId: eveningShiftId, slotIndex: 1 },
      ])
      const fixedRebuildManagedRow = fixedRowsAfterRebuild.rows.find(row => row.shift_id === morningShiftId)
      expect(fixedRebuildManagedRow?.publish_status).toBe('published')
      expect(fixedRebuildManagedRow?.producer_type).toBe('attendance_group_fixed_schedule')

      await saveSettings({
        multiShiftDay: { enabled: true, maxSlots: 3 },
        shiftCompliance: { enforcement: 'block', dailyMaxMinutes: 300, weeklyMaxMinutes: null, monthlyMaxMinutes: null },
      })
      const dailyCapRes = await requestJson(`${baseUrl}/api/attendance/assignments/${eveningAssignment.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ slotIndex: 2 }),
      })
      expect(dailyCapRes.status, JSON.stringify(dailyCapRes.body)).toBe(422)
      const dailyCapError = (dailyCapRes.body as { error?: { code?: string; granularity?: string; projectedMinutes?: number } } | undefined)?.error
      expect(dailyCapError?.code).toBe('SHIFT_COMPLIANCE_CAP_EXCEEDED')
      expect(dailyCapError?.granularity).toBe('daily')
      expect(dailyCapError?.projectedMinutes).toBe(480)

      await saveSettings({
        multiShiftDay: { enabled: true, maxSlots: 3 },
        shiftCompliance: { enforcement: 'warn', dailyMaxMinutes: null, weeklyMaxMinutes: null, monthlyMaxMinutes: null },
      })

      expectShiftAssignmentConflict(await createAssignment(multiSlotUserId, eveningShiftId, 1))
      expectShiftAssignmentConflict(await createAssignment(multiSlotUserId, overlapShiftId, 2))

      const updateSlotRes = await requestJson(`${baseUrl}/api/attendance/assignments/${eveningAssignment.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ slotIndex: 2 }),
      })
      expect(updateSlotRes.status, JSON.stringify(updateSlotRes.body)).toBe(200)
      const updatedAssignment = (updateSlotRes.body as { data?: { assignment?: { slotIndex?: number; slot_index?: number } } } | undefined)?.data?.assignment
      expect(updatedAssignment?.slotIndex).toBe(2)
      expect(updatedAssignment?.slot_index).toBe(2)

      const listRes = await requestJson(`${baseUrl}/api/attendance/assignments?userId=${encodeURIComponent(multiSlotUserId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(listRes.status).toBe(200)
      const listItems = (listRes.body as { data?: { items?: Array<{ assignment?: { id?: string; slotIndex?: number; slot_index?: number } }> } } | undefined)?.data?.items ?? []
      const listedEveningAssignment = listItems.find(item => item.assignment?.id === eveningAssignment.id)?.assignment
      expect(listedEveningAssignment?.slotIndex).toBe(2)
      expect(listedEveningAssignment?.slot_index).toBe(2)

      const updateToSameSlotRes = await requestJson(`${baseUrl}/api/attendance/assignments/${eveningAssignment.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ slotIndex: 0 }),
      })
      expectShiftAssignmentConflict(updateToSameSlotRes)

      const rotationRuleRes = await requestJson(`${baseUrl}/api/attendance/rotation-rules`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: `Multi Shift Rotation ${runSuffix}`,
          timezone: 'Asia/Shanghai',
          shiftSequence: [morningShiftId],
          isActive: true,
        }),
      })
      expect(rotationRuleRes.status).toBe(201)
      const rotationRuleId = (rotationRuleRes.body as { data?: { id?: string } } | undefined)?.data?.id
      expect(rotationRuleId).toBeTruthy()
      if (!rotationRuleId) return

      const rotationConflictRes = await requestJson(`${baseUrl}/api/attendance/rotation-assignments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          userId: multiSlotUserId,
          rotationRuleId,
          startDate: workDate,
          endDate: workDate,
          isActive: true,
        }),
      })
      expect(rotationConflictRes.status).toBe(409)
      const rotationError = (rotationConflictRes.body as { error?: { details?: { conflictType?: string; draftKind?: string; existingKind?: string } } } | undefined)?.error
      expect(rotationError?.details?.conflictType).toBe('rotation_overrides_shift')
      expect(rotationError?.details?.draftKind).toBe('rotation')
      expect(rotationError?.details?.existingKind).toBe('shift')

      const rotationFirstUserId = `${adminUserId}-rotation-first`
      const rotationFirstRes = await requestJson(`${baseUrl}/api/attendance/rotation-assignments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          userId: rotationFirstUserId,
          rotationRuleId,
          startDate: workDate,
          endDate: workDate,
          isActive: true,
        }),
      })
      expect(rotationFirstRes.status).toBe(201)
      const directAfterRotationRes = await createAssignment(rotationFirstUserId, morningShiftId, 1)
      expect(directAfterRotationRes.status).toBe(409)
      const directAfterRotationError = (directAfterRotationRes.body as { error?: { details?: { conflictType?: string; draftKind?: string; existingKind?: string } } } | undefined)?.error
      expect(directAfterRotationError?.details?.conflictType).toBe('rotation_overrides_shift')
      expect(directAfterRotationError?.details?.draftKind).toBe('shift')
      expect(directAfterRotationError?.details?.existingKind).toBe('rotation')

      await saveSettings({ multiShiftDay: { enabled: true, maxSlots: 2 } })
      const tooHighSlotRes = await createAssignment(`${adminUserId}-slot-too-high`, eveningShiftId, 2)
      expect(tooHighSlotRes.status).toBe(400)
      const tooHighError = (tooHighSlotRes.body as { error?: { code?: string; message?: string } } | undefined)?.error
      expect(tooHighError?.code).toBe('VALIDATION_ERROR')
      expect(String(tooHighError?.message || '')).toContain('slotIndex')
    } finally {
      if (Object.keys(originalSettings).length > 0) {
        await requestJson(`${baseUrl}/api/attendance/settings`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            shiftEditPolicy: originalSettings.shiftEditPolicy ?? { mode: 'unrestricted', windowDays: 0 },
            shiftCompliance: originalSettings.shiftCompliance ?? {
              enforcement: 'block',
              dailyMaxMinutes: null,
              weeklyMaxMinutes: null,
              monthlyMaxMinutes: null,
            },
            multiShiftDay: originalSettings.multiShiftDay ?? { enabled: false, maxSlots: 3 },
          }),
        }).catch(() => undefined)
      }
      await pool.end().catch(() => undefined)
    }
  })

  it('keeps draft and pending schedule assignments out of runtime schedule consumers until published', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return

    const runSuffix = Date.now().toString(36)
    const adminUserId = `attendance-publish-admin-${runSuffix}`
    const employeeUserId = `attendance-publish-employee-${runSuffix}`
    const rotationUserId = `attendance-publish-rotation-${runSuffix}`
    const conflictUserId = `attendance-publish-conflict-${runSuffix}`
    const baseDate = new Date()
    baseDate.setUTCHours(0, 0, 0, 0)
    baseDate.setUTCDate(baseDate.getUTCDate() - (((baseDate.getUTCDay() + 6) % 7) + 14))
    const testDate = (offsetDays: number) => {
      const date = new Date(baseDate)
      date.setUTCDate(baseDate.getUTCDate() + offsetDays)
      return date.toISOString().slice(0, 10)
    }
    const workDate = testDate(0)
    const rotationDate = testDate(1)
    const conflictDate = testDate(2)
    const occurredAt = `${workDate}T02:30:00.000Z`
    const pool = new Pool({ connectionString: dbUrl })
    let originalSettings: Record<string, unknown> = {}
    let shiftId: string | undefined
    let groupId: string | undefined
    let rotationRuleId: string | undefined

    const adminTokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(adminUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const employeeTokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(employeeUserId)}&roles=user&perms=attendance:read,attendance:write`
    )
    const adminToken = (adminTokenRes.body as { token?: string } | undefined)?.token
    const employeeToken = (employeeTokenRes.body as { token?: string } | undefined)?.token
    expect(adminToken).toBeTruthy()
    expect(employeeToken).toBeTruthy()
    if (!adminToken || !employeeToken) {
      await pool.end().catch(() => undefined)
      return
    }
    const adminHeaders = {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    }
    const employeeHeaders = {
      Authorization: `Bearer ${employeeToken}`,
      'Content-Type': 'application/json',
    }

    const fetchEffectiveSlots = async (userId: string, date: string) => {
      const res = await requestJson(
        `${baseUrl}/api/attendance/effective-calendar?from=${date}&to=${date}&userId=${encodeURIComponent(userId)}`,
        { headers: { Authorization: `Bearer ${adminToken}` } }
      )
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      const item = ((res.body as { data?: { items?: Array<{ effective?: { plannedMinutes?: number; slots?: Array<{ shiftId?: string; plannedMinutes?: number }> } }> } } | undefined)?.data?.items ?? [])[0]
      return {
        plannedMinutes: item?.effective?.plannedMinutes ?? 0,
        slots: item?.effective?.slots ?? [],
      }
    }

    try {
      const settingsRes = await requestJson(`${baseUrl}/api/attendance/settings`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
      expect(settingsRes.status).toBe(200)
      originalSettings = ((settingsRes.body as { data?: Record<string, unknown> } | undefined)?.data ?? {}) as Record<string, unknown>
      const settingsUpdateRes = await requestJson(`${baseUrl}/api/attendance/settings`, {
        method: 'PUT',
        headers: adminHeaders,
        body: JSON.stringify({
          shiftEditPolicy: { mode: 'unrestricted', windowDays: 0 },
          shiftCompliance: { enforcement: 'warn', dailyMaxMinutes: null, weeklyMaxMinutes: null, monthlyMaxMinutes: null },
          multiShiftDay: { enabled: true, maxSlots: 3 },
          punchPolicy: { unscheduled: { mode: 'block' } },
        }),
      })
      expect(settingsUpdateRes.status, JSON.stringify(settingsUpdateRes.body)).toBe(200)

      const shiftRes = await requestJson(`${baseUrl}/api/attendance/shifts`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          name: `Publish Lifecycle Shift ${runSuffix}`,
          timezone: 'UTC',
          workStartTime: '09:10',
          workEndTime: '10:40',
          workingDays: [1, 2, 3, 4, 5, 6],
        }),
      })
      expect(shiftRes.status, JSON.stringify(shiftRes.body)).toBe(201)
      shiftId = (shiftRes.body as { data?: { id?: string } } | undefined)?.data?.id
      expect(shiftId).toBeTruthy()
      if (!shiftId) return

      const groupRes = await requestJson(`${baseUrl}/api/attendance/groups`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          name: `publish-lifecycle-${runSuffix}`,
          timezone: 'UTC',
          attendanceType: 'scheduled_shift',
          description: 'publish lifecycle integration test',
        }),
      })
      expect(groupRes.status, JSON.stringify(groupRes.body)).toBe(200)
      groupId = (groupRes.body as { data?: { id?: string } } | undefined)?.data?.id
      expect(groupId).toBeTruthy()
      if (!groupId) return
      const memberRes = await requestJson(`${baseUrl}/api/attendance/groups/${groupId}/members`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ userIds: [employeeUserId] }),
      })
      expect(memberRes.status, JSON.stringify(memberRes.body)).toBe(200)

      const assignmentRes = await requestJson(`${baseUrl}/api/attendance/assignments`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          userId: employeeUserId,
          shiftId,
          startDate: workDate,
          endDate: workDate,
          isActive: true,
        }),
      })
      expect(assignmentRes.status, JSON.stringify(assignmentRes.body)).toBe(201)
      const assignment = (assignmentRes.body as { data?: { assignment?: { id?: string; publishStatus?: string; publish_status?: string } } } | undefined)?.data?.assignment
      expect(assignment?.publishStatus).toBe('published')
      expect(assignment?.publish_status).toBe('published')
      expect(assignment?.id).toBeTruthy()
      if (!assignment?.id) return

      const defaultStatusRows = await pool.query(
        'SELECT publish_status FROM attendance_shift_assignments WHERE id = $1',
        [assignment.id],
      )
      expect(defaultStatusRows.rows[0]?.publish_status).toBe('published')
      await expect(
        pool.query('UPDATE attendance_shift_assignments SET publish_status = $2 WHERE id = $1', [assignment.id, 'archived']),
      ).rejects.toMatchObject({ code: '23514' })

      await pool.query('UPDATE attendance_shift_assignments SET publish_status = $2 WHERE id = $1', [assignment.id, 'draft'])
      const draftEffective = await fetchEffectiveSlots(employeeUserId, workDate)
      expect(draftEffective.slots.some(slot => slot.shiftId === shiftId)).toBe(false)
      expect(draftEffective.plannedMinutes).not.toBe(90)
      const blockedPunchRes = await requestJson(`${baseUrl}/api/attendance/punch`, {
        method: 'POST',
        headers: employeeHeaders,
        body: JSON.stringify({ eventType: 'check_in', occurredAt }),
      })
      expect(blockedPunchRes.status, JSON.stringify(blockedPunchRes.body)).toBe(422)
      expect((blockedPunchRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('PUNCH_UNSCHEDULED_BLOCKED')
      const afterBlockedPunch = await pool.query(
        'SELECT 1 FROM attendance_events WHERE user_id = $1 AND work_date = $2',
        [employeeUserId, workDate],
      )
      expect(afterBlockedPunch.rows.length).toBe(0)

      await pool.query('UPDATE attendance_shift_assignments SET publish_status = $2 WHERE id = $1', [assignment.id, 'pending'])
      const pendingEffective = await fetchEffectiveSlots(employeeUserId, workDate)
      expect(pendingEffective.slots.some(slot => slot.shiftId === shiftId)).toBe(false)
      const listRes = await requestJson(`${baseUrl}/api/attendance/assignments?userId=${encodeURIComponent(employeeUserId)}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
      expect(listRes.status, JSON.stringify(listRes.body)).toBe(200)
      const listed = ((listRes.body as { data?: { items?: Array<{ assignment?: { id?: string; publishStatus?: string; publish_status?: string } }> } } | undefined)?.data?.items ?? [])
        .find(item => item.assignment?.id === assignment.id)?.assignment
      expect(listed?.publishStatus).toBe('pending')
      expect(listed?.publish_status).toBe('pending')

      await pool.query('UPDATE attendance_shift_assignments SET publish_status = $2 WHERE id = $1', [assignment.id, 'published'])
      const publishedEffective = await fetchEffectiveSlots(employeeUserId, workDate)
      expect(publishedEffective.slots.some(slot => slot.shiftId === shiftId)).toBe(true)
      expect(publishedEffective.plannedMinutes).toBe(90)
      const allowedPunchRes = await requestJson(`${baseUrl}/api/attendance/punch`, {
        method: 'POST',
        headers: employeeHeaders,
        body: JSON.stringify({ eventType: 'check_in', occurredAt }),
      })
      expect(allowedPunchRes.status, JSON.stringify(allowedPunchRes.body)).toBe(200)
      const afterAllowedPunch = await pool.query(
        'SELECT 1 FROM attendance_events WHERE user_id = $1 AND work_date = $2',
        [employeeUserId, workDate],
      )
      expect(afterAllowedPunch.rows.length).toBe(1)

      const draftConflictRes = await requestJson(`${baseUrl}/api/attendance/assignments`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          userId: conflictUserId,
          shiftId,
          startDate: conflictDate,
          endDate: conflictDate,
          isActive: true,
        }),
      })
      expect(draftConflictRes.status, JSON.stringify(draftConflictRes.body)).toBe(201)
      const draftConflictAssignmentId = (draftConflictRes.body as { data?: { assignment?: { id?: string } } } | undefined)?.data?.assignment?.id
      expect(draftConflictAssignmentId).toBeTruthy()
      await pool.query('UPDATE attendance_shift_assignments SET publish_status = $2 WHERE id = $1', [draftConflictAssignmentId, 'draft'])
      const publishedOverDraftRes = await requestJson(`${baseUrl}/api/attendance/assignments`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          userId: conflictUserId,
          shiftId,
          startDate: conflictDate,
          endDate: conflictDate,
          isActive: true,
        }),
      })
      expect(publishedOverDraftRes.status, JSON.stringify(publishedOverDraftRes.body)).toBe(201)

      const rotationRuleRes = await requestJson(`${baseUrl}/api/attendance/rotation-rules`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          name: `Publish Lifecycle Rotation ${runSuffix}`,
          timezone: 'UTC',
          shiftSequence: [shiftId],
          isActive: true,
        }),
      })
      expect(rotationRuleRes.status, JSON.stringify(rotationRuleRes.body)).toBe(201)
      rotationRuleId = (rotationRuleRes.body as { data?: { id?: string } } | undefined)?.data?.id
      expect(rotationRuleId).toBeTruthy()
      if (!rotationRuleId) return

      const rotationAssignmentRes = await requestJson(`${baseUrl}/api/attendance/rotation-assignments`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          userId: rotationUserId,
          rotationRuleId,
          startDate: rotationDate,
          endDate: rotationDate,
          isActive: true,
        }),
      })
      expect(rotationAssignmentRes.status, JSON.stringify(rotationAssignmentRes.body)).toBe(201)
      const rotationAssignment = (rotationAssignmentRes.body as { data?: { assignment?: { id?: string; publishStatus?: string; publish_status?: string } } } | undefined)?.data?.assignment
      expect(rotationAssignment?.publishStatus).toBe('published')
      expect(rotationAssignment?.publish_status).toBe('published')
      expect(rotationAssignment?.id).toBeTruthy()
      if (!rotationAssignment?.id) return
      await pool.query('UPDATE attendance_rotation_assignments SET publish_status = $2 WHERE id = $1', [rotationAssignment.id, 'draft'])
      const draftRotationEffective = await fetchEffectiveSlots(rotationUserId, rotationDate)
      expect(draftRotationEffective.plannedMinutes).not.toBe(90)
      await pool.query('UPDATE attendance_rotation_assignments SET publish_status = $2 WHERE id = $1', [rotationAssignment.id, 'pending'])
      const pendingRotationEffective = await fetchEffectiveSlots(rotationUserId, rotationDate)
      expect(pendingRotationEffective.plannedMinutes).not.toBe(90)
      await pool.query('UPDATE attendance_rotation_assignments SET publish_status = $2 WHERE id = $1', [rotationAssignment.id, 'published'])
      const publishedRotationEffective = await fetchEffectiveSlots(rotationUserId, rotationDate)
      expect(publishedRotationEffective.plannedMinutes).toBe(90)
    } finally {
      if (Object.keys(originalSettings).length > 0) {
        await requestJson(`${baseUrl}/api/attendance/settings`, {
          method: 'PUT',
          headers: adminHeaders,
          body: JSON.stringify(originalSettings),
        }).catch(() => undefined)
      }
      const users = [employeeUserId, rotationUserId, conflictUserId]
      await pool.query('DELETE FROM attendance_events WHERE user_id = ANY($1::text[])', [users]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_records WHERE user_id = ANY($1::text[])', [users]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_shift_assignments WHERE user_id = ANY($1::text[])', [users]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_rotation_assignments WHERE user_id = ANY($1::text[])', [users]).catch(() => undefined)
      if (groupId) {
        await pool.query('DELETE FROM attendance_group_members WHERE group_id = $1 OR user_id = ANY($2::text[])', [groupId, users]).catch(() => undefined)
        await pool.query('DELETE FROM attendance_groups WHERE id = $1', [groupId]).catch(() => undefined)
      }
      if (rotationRuleId) await pool.query('DELETE FROM attendance_rotation_rules WHERE id = $1', [rotationRuleId]).catch(() => undefined)
      if (shiftId) await pool.query('DELETE FROM attendance_shifts WHERE id = $1', [shiftId]).catch(() => undefined)
      await pool.end().catch(() => undefined)
    }
  })

  it('supports draft schedule CRUD through draft-aware routes without changing immediate published writes', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return

    const runSuffix = Date.now().toString(36)
    const adminUserId = `attendance-draft-crud-admin-${runSuffix}`
    const shiftUserId = `attendance-draft-crud-shift-${runSuffix}`
    const rotationUserId = `attendance-draft-crud-rotation-${runSuffix}`
    const deleteUserId = `attendance-draft-crud-delete-${runSuffix}`
    const workDate = '2026-07-23'
    const rotationDate = '2026-07-24'
    const pool = new Pool({ connectionString: dbUrl })
    let originalSettings: Record<string, unknown> = {}
    const shiftIds: string[] = []
    const rotationRuleIds: string[] = []

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(adminUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) {
      await pool.end().catch(() => undefined)
      return
    }
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    }

    async function createShift(name: string, workStartTime: string, workEndTime: string): Promise<string> {
      const res = await requestJson(`${baseUrl}/api/attendance/shifts`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name,
          timezone: 'UTC',
          workStartTime,
          workEndTime,
          workingDays: [0, 1, 2, 3, 4, 5, 6],
        }),
      })
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      const id = (res.body as { data?: { id?: string } } | undefined)?.data?.id
      expect(id).toBeTruthy()
      if (!id) throw new Error('missing shift id')
      shiftIds.push(id)
      return id
    }

    async function createRotationRule(name: string, shiftId: string): Promise<string> {
      const res = await requestJson(`${baseUrl}/api/attendance/rotation-rules`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name,
          timezone: 'UTC',
          shiftSequence: [shiftId],
          isActive: true,
        }),
      })
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      const id = (res.body as { data?: { id?: string } } | undefined)?.data?.id
      expect(id).toBeTruthy()
      if (!id) throw new Error('missing rotation rule id')
      rotationRuleIds.push(id)
      return id
    }

    function expectPublishLocked(res: HttpResponse, status: string) {
      expect(res.status, JSON.stringify(res.body)).toBe(422)
      const error = (res.body as { error?: { code?: string; details?: { publishStatus?: string } } } | undefined)?.error
      expect(error?.code).toBe('SCHEDULE_PUBLISH_LOCKED')
      expect(error?.details?.publishStatus).toBe(status)
    }

    try {
      const settingsRes = await requestJson(`${baseUrl}/api/attendance/settings`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(settingsRes.status).toBe(200)
      originalSettings = ((settingsRes.body as { data?: Record<string, unknown> } | undefined)?.data ?? {}) as Record<string, unknown>
      const settingsUpdateRes = await requestJson(`${baseUrl}/api/attendance/settings`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          shiftEditPolicy: { mode: 'unrestricted', windowDays: 0 },
          shiftCompliance: { enforcement: 'warn', dailyMaxMinutes: null, weeklyMaxMinutes: null, monthlyMaxMinutes: null },
          multiShiftDay: { enabled: false, maxSlots: 3 },
        }),
      })
      expect(settingsUpdateRes.status, JSON.stringify(settingsUpdateRes.body)).toBe(200)

      const publishedShiftId = await createShift(`Draft CRUD Published ${runSuffix}`, '08:00', '09:00')
      const draftShiftId = await createShift(`Draft CRUD Draft ${runSuffix}`, '10:00', '11:00')
      const updatedDraftShiftId = await createShift(`Draft CRUD Updated ${runSuffix}`, '12:00', '13:00')

      const publishedRes = await requestJson(`${baseUrl}/api/attendance/assignments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          userId: shiftUserId,
          shiftId: publishedShiftId,
          startDate: workDate,
          endDate: workDate,
          isActive: true,
        }),
      })
      expect(publishedRes.status, JSON.stringify(publishedRes.body)).toBe(201)
      const publishedAssignment = (publishedRes.body as { data?: { assignment?: { id?: string; publishStatus?: string } } } | undefined)?.data?.assignment
      expect(publishedAssignment?.publishStatus).toBe('published')
      expect(publishedAssignment?.id).toBeTruthy()
      if (!publishedAssignment?.id) return

      const draftRes = await requestJson(`${baseUrl}/api/attendance/schedule-drafts/assignments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          userId: shiftUserId,
          shiftId: draftShiftId,
          startDate: workDate,
          endDate: workDate,
          isActive: true,
        }),
      })
      expect(draftRes.status, JSON.stringify(draftRes.body)).toBe(201)
      const draftAssignment = (draftRes.body as { data?: { assignment?: { id?: string; publishStatus?: string; publish_status?: string } } } | undefined)?.data?.assignment
      expect(draftAssignment?.publishStatus).toBe('draft')
      expect(draftAssignment?.publish_status).toBe('draft')
      expect(draftAssignment?.id).toBeTruthy()
      if (!draftAssignment?.id) return

      const duplicateDraftRes = await requestJson(`${baseUrl}/api/attendance/schedule-drafts/assignments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          userId: shiftUserId,
          shiftId: draftShiftId,
          startDate: workDate,
          endDate: workDate,
          isActive: true,
        }),
      })
      expect(duplicateDraftRes.status, JSON.stringify(duplicateDraftRes.body)).toBe(409)
      expect((duplicateDraftRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('ATTENDANCE_SCHEDULE_ASSIGNMENT_CONFLICT')

      const draftListRes = await requestJson(
        `${baseUrl}/api/attendance/assignments?userId=${encodeURIComponent(shiftUserId)}&publishStatus=draft`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      expect(draftListRes.status, JSON.stringify(draftListRes.body)).toBe(200)
      const draftListItems = (draftListRes.body as { data?: { items?: Array<{ assignment?: { id?: string; publishStatus?: string } }> } } | undefined)?.data?.items ?? []
      expect(draftListItems.map(item => item.assignment?.id)).toContain(draftAssignment.id)
      expect(draftListItems.every(item => item.assignment?.publishStatus === 'draft')).toBe(true)

      const publishedListRes = await requestJson(
        `${baseUrl}/api/attendance/assignments?userId=${encodeURIComponent(shiftUserId)}&publishStatus=published`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      expect(publishedListRes.status, JSON.stringify(publishedListRes.body)).toBe(200)
      const publishedListItems = (publishedListRes.body as { data?: { items?: Array<{ assignment?: { id?: string; publishStatus?: string } }> } } | undefined)?.data?.items ?? []
      expect(publishedListItems.map(item => item.assignment?.id)).toContain(publishedAssignment?.id)
      expect(publishedListItems.map(item => item.assignment?.id)).not.toContain(draftAssignment.id)

      const ordinaryDraftUpdateRes = await requestJson(`${baseUrl}/api/attendance/assignments/${draftAssignment.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ shiftId: updatedDraftShiftId }),
      })
      expectPublishLocked(ordinaryDraftUpdateRes, 'draft')

      const ordinaryPublishedUpdateRes = await requestJson(`${baseUrl}/api/attendance/assignments/${publishedAssignment.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ shiftId: publishedShiftId }),
      })
      expect(ordinaryPublishedUpdateRes.status, JSON.stringify(ordinaryPublishedUpdateRes.body)).toBe(200)
      expect((ordinaryPublishedUpdateRes.body as { data?: { assignment?: { publishStatus?: string } } } | undefined)?.data?.assignment?.publishStatus).toBe('published')

      const draftUpdateRes = await requestJson(`${baseUrl}/api/attendance/schedule-drafts/assignments/${draftAssignment.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ shiftId: updatedDraftShiftId }),
      })
      expect(draftUpdateRes.status, JSON.stringify(draftUpdateRes.body)).toBe(200)
      const updatedDraftAssignment = (draftUpdateRes.body as { data?: { assignment?: { shiftId?: string; publishStatus?: string } } } | undefined)?.data?.assignment
      expect(updatedDraftAssignment?.shiftId).toBe(updatedDraftShiftId)
      expect(updatedDraftAssignment?.publishStatus).toBe('draft')

      await pool.query('UPDATE attendance_shift_assignments SET publish_status = $2 WHERE id = $1', [draftAssignment.id, 'pending'])
      const pendingDraftUpdateRes = await requestJson(`${baseUrl}/api/attendance/schedule-drafts/assignments/${draftAssignment.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ shiftId: draftShiftId }),
      })
      expectPublishLocked(pendingDraftUpdateRes, 'pending')
      const ordinaryPendingDeleteRes = await requestJson(`${baseUrl}/api/attendance/assignments/${draftAssignment.id}`, {
        method: 'DELETE',
        headers,
      })
      expectPublishLocked(ordinaryPendingDeleteRes, 'pending')

      const deleteDraftRes = await requestJson(`${baseUrl}/api/attendance/schedule-drafts/assignments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          userId: deleteUserId,
          shiftId: draftShiftId,
          startDate: workDate,
          endDate: workDate,
          isActive: true,
        }),
      })
      expect(deleteDraftRes.status, JSON.stringify(deleteDraftRes.body)).toBe(201)
      const deleteDraftId = (deleteDraftRes.body as { data?: { assignment?: { id?: string } } } | undefined)?.data?.assignment?.id
      expect(deleteDraftId).toBeTruthy()
      if (!deleteDraftId) return
      const ordinaryDraftDeleteRes = await requestJson(`${baseUrl}/api/attendance/assignments/${deleteDraftId}`, {
        method: 'DELETE',
        headers,
      })
      expectPublishLocked(ordinaryDraftDeleteRes, 'draft')
      const draftDeleteRes = await requestJson(`${baseUrl}/api/attendance/schedule-drafts/assignments/${deleteDraftId}`, {
        method: 'DELETE',
        headers,
      })
      expect(draftDeleteRes.status, JSON.stringify(draftDeleteRes.body)).toBe(200)
      const deletedRows = await pool.query('SELECT 1 FROM attendance_shift_assignments WHERE id = $1', [deleteDraftId])
      expect(deletedRows.rows.length).toBe(0)

      const rotationRuleId = await createRotationRule(`Draft CRUD Rotation ${runSuffix}`, publishedShiftId)
      const updatedRotationRuleId = await createRotationRule(`Draft CRUD Rotation Updated ${runSuffix}`, updatedDraftShiftId)
      const rotationDraftRes = await requestJson(`${baseUrl}/api/attendance/schedule-drafts/rotation-assignments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          userId: rotationUserId,
          rotationRuleId,
          startDate: rotationDate,
          endDate: rotationDate,
          isActive: true,
        }),
      })
      expect(rotationDraftRes.status, JSON.stringify(rotationDraftRes.body)).toBe(201)
      const rotationDraft = (rotationDraftRes.body as { data?: { assignment?: { id?: string; publishStatus?: string } } } | undefined)?.data?.assignment
      expect(rotationDraft?.publishStatus).toBe('draft')
      expect(rotationDraft?.id).toBeTruthy()
      if (!rotationDraft?.id) return

      const ordinaryRotationUpdateRes = await requestJson(`${baseUrl}/api/attendance/rotation-assignments/${rotationDraft.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ rotationRuleId: updatedRotationRuleId }),
      })
      expectPublishLocked(ordinaryRotationUpdateRes, 'draft')
      const rotationDraftUpdateRes = await requestJson(`${baseUrl}/api/attendance/schedule-drafts/rotation-assignments/${rotationDraft.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ rotationRuleId: updatedRotationRuleId }),
      })
      expect(rotationDraftUpdateRes.status, JSON.stringify(rotationDraftUpdateRes.body)).toBe(200)
      expect((rotationDraftUpdateRes.body as { data?: { assignment?: { rotationRuleId?: string; publishStatus?: string } } } | undefined)?.data?.assignment?.rotationRuleId).toBe(updatedRotationRuleId)

      const rotationDraftListRes = await requestJson(
        `${baseUrl}/api/attendance/rotation-assignments?publishStatus=draft`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      expect(rotationDraftListRes.status, JSON.stringify(rotationDraftListRes.body)).toBe(200)
      const rotationDraftListItems = (rotationDraftListRes.body as { data?: { items?: Array<{ assignment?: { id?: string; publishStatus?: string } }> } } | undefined)?.data?.items ?? []
      expect(rotationDraftListItems.map(item => item.assignment?.id)).toContain(rotationDraft.id)
      expect(rotationDraftListItems.every(item => item.assignment?.publishStatus === 'draft')).toBe(true)

      const rotationDraftDeleteRes = await requestJson(`${baseUrl}/api/attendance/schedule-drafts/rotation-assignments/${rotationDraft.id}`, {
        method: 'DELETE',
        headers,
      })
      expect(rotationDraftDeleteRes.status, JSON.stringify(rotationDraftDeleteRes.body)).toBe(200)
      const deletedRotationRows = await pool.query('SELECT 1 FROM attendance_rotation_assignments WHERE id = $1', [rotationDraft.id])
      expect(deletedRotationRows.rows.length).toBe(0)
    } finally {
      if (Object.keys(originalSettings).length > 0) {
        await requestJson(`${baseUrl}/api/attendance/settings`, {
          method: 'PUT',
          headers,
          body: JSON.stringify(originalSettings),
        }).catch(() => undefined)
      }
      const users = [shiftUserId, rotationUserId, deleteUserId]
      await pool.query('DELETE FROM attendance_shift_assignments WHERE user_id = ANY($1::text[])', [users]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_rotation_assignments WHERE user_id = ANY($1::text[])', [users]).catch(() => undefined)
      if (rotationRuleIds.length > 0) {
        await pool.query('DELETE FROM attendance_rotation_rules WHERE id = ANY($1::uuid[])', [rotationRuleIds]).catch(() => undefined)
      }
      if (shiftIds.length > 0) {
        await pool.query('DELETE FROM attendance_shifts WHERE id = ANY($1::uuid[])', [shiftIds]).catch(() => undefined)
      }
      await pool.end().catch(() => undefined)
    }
  })

  it('publishes draft schedule assignments transactionally with preflight, conflict, and compliance rollback', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return

    const runSuffix = Date.now().toString(36)
    const adminUserId = `attendance-publish-admin-${runSuffix}`
    const publishUserId = `attendance-publish-user-${runSuffix}`
    const rotationUserId = `attendance-publish-rotation-${runSuffix}`
    const conflictUserId = `attendance-publish-conflict-${runSuffix}`
    const complianceUserId = `attendance-publish-cap-${runSuffix}`
    const workDate = '2026-07-27'
    const rotationDate = '2026-07-28'
    const conflictDate = '2026-07-29'
    const complianceDate = '2026-07-30'
    const pool = new Pool({ connectionString: dbUrl })
    let originalSettings: Record<string, unknown> = {}
    const shiftIds: string[] = []
    const rotationRuleIds: string[] = []

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(adminUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) {
      await pool.end().catch(() => undefined)
      return
    }
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    }

    async function createShift(name: string, workStartTime: string, workEndTime: string): Promise<string> {
      const res = await requestJson(`${baseUrl}/api/attendance/shifts`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name,
          timezone: 'UTC',
          workStartTime,
          workEndTime,
          workingDays: [0, 1, 2, 3, 4, 5, 6],
        }),
      })
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      const id = (res.body as { data?: { id?: string } } | undefined)?.data?.id
      expect(id).toBeTruthy()
      if (!id) throw new Error('missing shift id')
      shiftIds.push(id)
      return id
    }

    async function createRotationRule(name: string, shiftId: string): Promise<string> {
      const res = await requestJson(`${baseUrl}/api/attendance/rotation-rules`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name,
          timezone: 'UTC',
          shiftSequence: [shiftId],
          isActive: true,
        }),
      })
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      const id = (res.body as { data?: { id?: string } } | undefined)?.data?.id
      expect(id).toBeTruthy()
      if (!id) throw new Error('missing rotation rule id')
      rotationRuleIds.push(id)
      return id
    }

    async function createDraftAssignment(userId: string, shiftId: string, date: string): Promise<string> {
      const res = await requestJson(`${baseUrl}/api/attendance/schedule-drafts/assignments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ userId, shiftId, startDate: date, endDate: date, isActive: true }),
      })
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      const id = (res.body as { data?: { assignment?: { id?: string } } } | undefined)?.data?.assignment?.id
      expect(id).toBeTruthy()
      if (!id) throw new Error('missing draft assignment id')
      return id
    }

    async function publish(body: Record<string, unknown>): Promise<HttpResponse> {
      return requestJson(`${baseUrl}/api/attendance/schedule-publications`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
    }

    try {
      const settingsRes = await requestJson(`${baseUrl}/api/attendance/settings`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(settingsRes.status).toBe(200)
      originalSettings = ((settingsRes.body as { data?: Record<string, unknown> } | undefined)?.data ?? {}) as Record<string, unknown>
      const settingsUpdateRes = await requestJson(`${baseUrl}/api/attendance/settings`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          shiftEditPolicy: { mode: 'unrestricted', windowDays: 0 },
          shiftCompliance: { enforcement: 'warn', dailyMaxMinutes: null, weeklyMaxMinutes: null, monthlyMaxMinutes: null },
          multiShiftDay: { enabled: false, maxSlots: 3 },
        }),
      })
      expect(settingsUpdateRes.status, JSON.stringify(settingsUpdateRes.body)).toBe(200)

      const oneHourShiftId = await createShift(`Publish One Hour ${runSuffix}`, '08:00', '09:00')
      const twoHourShiftId = await createShift(`Publish Two Hour ${runSuffix}`, '10:00', '12:00')
      const capShiftId = await createShift(`Publish Cap ${runSuffix}`, '13:00', '15:00')
      const publishDraftId = await createDraftAssignment(publishUserId, oneHourShiftId, workDate)

      const preflightRes = await publish({ assignmentIds: [publishDraftId], preflightOnly: true })
      expect(preflightRes.status, JSON.stringify(preflightRes.body)).toBe(200)
      const preflightData = (preflightRes.body as { data?: { preflightOnly?: boolean; totalPublished?: number; assignments?: Array<{ id?: string; publishStatus?: string }> } } | undefined)?.data
      expect(preflightData?.preflightOnly).toBe(true)
      expect(preflightData?.totalPublished).toBe(1)
      expect(preflightData?.assignments?.[0]?.publishStatus).toBe('published')
      const preflightPersisted = await pool.query(
        `SELECT publish_status, publish_batch_id, publish_requested_at, publish_requested_by,
                published_at, published_by, locked_at
           FROM attendance_shift_assignments
          WHERE id = $1`,
        [publishDraftId],
      )
      expect(preflightPersisted.rows[0]?.publish_status).toBe('draft')
      expect(preflightPersisted.rows[0]?.publish_batch_id).toBeNull()
      expect(preflightPersisted.rows[0]?.publish_requested_at).toBeNull()
      expect(preflightPersisted.rows[0]?.publish_requested_by).toBeNull()
      expect(preflightPersisted.rows[0]?.published_at).toBeNull()
      expect(preflightPersisted.rows[0]?.published_by).toBeNull()
      expect(preflightPersisted.rows[0]?.locked_at).toBeNull()

      const rotationRuleId = await createRotationRule(`Publish Rotation ${runSuffix}`, oneHourShiftId)
      const rotationDraftRes = await requestJson(`${baseUrl}/api/attendance/schedule-drafts/rotation-assignments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          userId: rotationUserId,
          rotationRuleId,
          startDate: rotationDate,
          endDate: rotationDate,
          isActive: true,
        }),
      })
      expect(rotationDraftRes.status, JSON.stringify(rotationDraftRes.body)).toBe(201)
      const rotationDraftId = (rotationDraftRes.body as { data?: { assignment?: { id?: string } } } | undefined)?.data?.assignment?.id
      expect(rotationDraftId).toBeTruthy()
      if (!rotationDraftId) return

      const publishRes = await publish({ assignmentIds: [publishDraftId], rotationAssignmentIds: [rotationDraftId] })
      expect(publishRes.status, JSON.stringify(publishRes.body)).toBe(200)
      const publishData = (publishRes.body as { data?: { publishBatchId?: string; preflightOnly?: boolean; totalPublished?: number; assignments?: Array<{ id?: string; publishStatus?: string }>; rotationAssignments?: Array<{ id?: string; publishStatus?: string }> } } | undefined)?.data
      expect(publishData?.preflightOnly).toBe(false)
      expect(publishData?.publishBatchId).toBeTruthy()
      expect(publishData?.totalPublished).toBe(2)
      expect(publishData?.assignments?.[0]?.publishStatus).toBe('published')
      expect(publishData?.rotationAssignments?.[0]?.publishStatus).toBe('published')
      const publishedRows = await pool.query(
        `SELECT id, publish_status, publish_batch_id, publish_requested_at, publish_requested_by,
                published_at, published_by, locked_at
           FROM attendance_shift_assignments
          WHERE id = $1
         UNION ALL
         SELECT id, publish_status, publish_batch_id, publish_requested_at, publish_requested_by,
                published_at, published_by, locked_at
           FROM attendance_rotation_assignments
          WHERE id = $2`,
        [publishDraftId, rotationDraftId],
      )
      expect(publishedRows.rows).toHaveLength(2)
      for (const row of publishedRows.rows) {
        expect(row.publish_status).toBe('published')
        expect(row.publish_batch_id).toBe(publishData?.publishBatchId)
        expect(row.publish_requested_at).toBeTruthy()
        expect(row.publish_requested_by).toBe(adminUserId)
        expect(row.published_at).toBeTruthy()
        expect(row.published_by).toBe(adminUserId)
        expect(row.locked_at).toBeTruthy()
      }
      const lockedPublishedUpdateRes = await requestJson(`${baseUrl}/api/attendance/assignments/${publishDraftId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ shiftId: twoHourShiftId }),
      })
      expect(lockedPublishedUpdateRes.status, JSON.stringify(lockedPublishedUpdateRes.body)).toBe(422)
      expect((lockedPublishedUpdateRes.body as { error?: { code?: string; details?: { publishStatus?: string } } } | undefined)?.error?.code).toBe('SCHEDULE_PUBLISH_LOCKED')
      expect((lockedPublishedUpdateRes.body as { error?: { code?: string; details?: { publishStatus?: string } } } | undefined)?.error?.details?.publishStatus).toBe('published')

      const conflictPublishedRes = await requestJson(`${baseUrl}/api/attendance/assignments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          userId: conflictUserId,
          shiftId: oneHourShiftId,
          startDate: conflictDate,
          endDate: conflictDate,
          isActive: true,
        }),
      })
      expect(conflictPublishedRes.status, JSON.stringify(conflictPublishedRes.body)).toBe(201)
      const conflictDraftId = await createDraftAssignment(conflictUserId, twoHourShiftId, conflictDate)
      const conflictPublishRes = await publish({ assignmentIds: [conflictDraftId] })
      expect(conflictPublishRes.status, JSON.stringify(conflictPublishRes.body)).toBe(409)
      expect((conflictPublishRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SCHEDULE_PUBLISH_CONFLICT')
      const conflictDraftRow = await pool.query(
        'SELECT publish_status, publish_batch_id, published_at FROM attendance_shift_assignments WHERE id = $1',
        [conflictDraftId],
      )
      expect(conflictDraftRow.rows[0]?.publish_status).toBe('draft')
      expect(conflictDraftRow.rows[0]?.publish_batch_id).toBeNull()
      expect(conflictDraftRow.rows[0]?.published_at).toBeNull()

      const capSettingsRes = await requestJson(`${baseUrl}/api/attendance/settings`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          shiftCompliance: { enforcement: 'block', dailyMaxMinutes: 30, weeklyMaxMinutes: null, monthlyMaxMinutes: null },
        }),
      })
      expect(capSettingsRes.status, JSON.stringify(capSettingsRes.body)).toBe(200)
      const capDraftId = await createDraftAssignment(complianceUserId, capShiftId, complianceDate)
      const capPublishRes = await publish({ assignmentIds: [capDraftId] })
      expect(capPublishRes.status, JSON.stringify(capPublishRes.body)).toBe(422)
      expect((capPublishRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SHIFT_COMPLIANCE_CAP_EXCEEDED')
      const capDraftRow = await pool.query(
        'SELECT publish_status, publish_batch_id, published_at FROM attendance_shift_assignments WHERE id = $1',
        [capDraftId],
      )
      expect(capDraftRow.rows[0]?.publish_status).toBe('draft')
      expect(capDraftRow.rows[0]?.publish_batch_id).toBeNull()
      expect(capDraftRow.rows[0]?.published_at).toBeNull()
    } finally {
      if (Object.keys(originalSettings).length > 0) {
        await requestJson(`${baseUrl}/api/attendance/settings`, {
          method: 'PUT',
          headers,
          body: JSON.stringify(originalSettings),
        }).catch(() => undefined)
      }
      const users = [publishUserId, rotationUserId, conflictUserId, complianceUserId]
      await pool.query('DELETE FROM attendance_shift_assignments WHERE user_id = ANY($1::text[])', [users]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_rotation_assignments WHERE user_id = ANY($1::text[])', [users]).catch(() => undefined)
      if (rotationRuleIds.length > 0) {
        await pool.query('DELETE FROM attendance_rotation_rules WHERE id = ANY($1::uuid[])', [rotationRuleIds]).catch(() => undefined)
      }
      if (shiftIds.length > 0) {
        await pool.query('DELETE FROM attendance_shifts WHERE id = ANY($1::uuid[])', [shiftIds]).catch(() => undefined)
      }
      await pool.end().catch(() => undefined)
    }
  })

  it('creates replace-only temporary draft assignments and publishes them over an existing shift', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return

    const runSuffix = Date.now().toString(36)
    const adminUserId = `attendance-temp-shift-admin-${runSuffix}`
    const userId = `attendance-temp-shift-user-${runSuffix}`
    const fixedUserId = `attendance-temp-shift-fixed-${runSuffix}`
    const workDate = '2026-08-03'
    const fixedDate = '2026-08-04'
    const staleTempDate = '2026-08-05'
    const pool = new Pool({ connectionString: dbUrl })
    let originalSettings: Record<string, unknown> = {}
    const shiftIds: string[] = []
    let fixedGroupId: string | undefined

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(adminUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) {
      await pool.end().catch(() => undefined)
      return
    }
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    }

    async function createShift(name: string, workStartTime: string, workEndTime: string): Promise<string> {
      const res = await requestJson(`${baseUrl}/api/attendance/shifts`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name,
          timezone: 'UTC',
          workStartTime,
          workEndTime,
          workingDays: [0, 1, 2, 3, 4, 5, 6],
        }),
      })
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      const id = (res.body as { data?: { id?: string } } | undefined)?.data?.id
      expect(id).toBeTruthy()
      if (!id) throw new Error('missing shift id')
      shiftIds.push(id)
      return id
    }

    async function publish(assignmentId: string): Promise<HttpResponse> {
      return requestJson(`${baseUrl}/api/attendance/schedule-publications`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ assignmentIds: [assignmentId] }),
      })
    }

    async function loadEffectiveSlot(targetUserId: string, targetDate: string) {
      const effectiveCalendarRes = await requestJson(
        `${baseUrl}/api/attendance/effective-calendar?from=${targetDate}&to=${targetDate}&userId=${encodeURIComponent(targetUserId)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      expect(effectiveCalendarRes.status, JSON.stringify(effectiveCalendarRes.body)).toBe(200)
      const item = ((effectiveCalendarRes.body as { data?: { items?: Array<{ effective?: { slots?: Array<{ shiftId?: string; assignmentKind?: string; replaces?: { assignmentId?: string } }> } }> } } | undefined)?.data?.items ?? [])[0]
      return item?.effective?.slots?.[0]
    }

    function tempDraftBody(replacementShiftId: string, replacementAssignmentId: string, overrides: Record<string, unknown> = {}) {
      return {
        userId,
        shiftId: replacementShiftId,
        startDate: workDate,
        endDate: workDate,
        isActive: true,
        assignmentKind: 'temporary',
        temporaryMode: 'replace',
        temporaryReplacesKind: 'shift',
        temporaryReplacesAssignmentId: replacementAssignmentId,
        temporaryReason: 'one-off onsite coverage',
        ...overrides,
      }
    }

    try {
      const settingsRes = await requestJson(`${baseUrl}/api/attendance/settings`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(settingsRes.status).toBe(200)
      originalSettings = ((settingsRes.body as { data?: Record<string, unknown> } | undefined)?.data ?? {}) as Record<string, unknown>
      const settingsUpdateRes = await requestJson(`${baseUrl}/api/attendance/settings`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          shiftEditPolicy: { mode: 'unrestricted', windowDays: 0 },
          shiftCompliance: { enforcement: 'warn', dailyMaxMinutes: null, weeklyMaxMinutes: null, monthlyMaxMinutes: null },
          multiShiftDay: { enabled: false, maxSlots: 3 },
        }),
      })
      expect(settingsUpdateRes.status, JSON.stringify(settingsUpdateRes.body)).toBe(200)

      const baseShiftId = await createShift(`Temp Base ${runSuffix}`, '08:00', '16:00')
      const replacementShiftId = await createShift(`Temp Replacement ${runSuffix}`, '10:00', '18:00')

      const baseAssignmentRes = await requestJson(`${baseUrl}/api/attendance/assignments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          userId,
          shiftId: baseShiftId,
          startDate: workDate,
          endDate: workDate,
          isActive: true,
        }),
      })
      expect(baseAssignmentRes.status, JSON.stringify(baseAssignmentRes.body)).toBe(201)
      const baseAssignment = (baseAssignmentRes.body as { data?: { assignment?: { id?: string; publishStatus?: string } } } | undefined)?.data?.assignment
      expect(baseAssignment?.publishStatus).toBe('published')
      expect(baseAssignment?.id).toBeTruthy()
      if (!baseAssignment?.id) return

      const directTempRes = await requestJson(`${baseUrl}/api/attendance/assignments`, {
        method: 'POST',
        headers,
        body: JSON.stringify(tempDraftBody(replacementShiftId, baseAssignment.id)),
      })
      expect(directTempRes.status, JSON.stringify(directTempRes.body)).toBe(422)
      expect((directTempRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('TEMP_SHIFT_IMMEDIATE_ACTIVE_UNSUPPORTED')

      const openEndedTempRes = await requestJson(`${baseUrl}/api/attendance/schedule-drafts/assignments`, {
        method: 'POST',
        headers,
        body: JSON.stringify(tempDraftBody(replacementShiftId, baseAssignment.id, { endDate: null })),
      })
      expect(openEndedTempRes.status, JSON.stringify(openEndedTempRes.body)).toBe(422)
      expect((openEndedTempRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('TEMP_SHIFT_RANGE_UNSUPPORTED')

      const addModeTempRes = await requestJson(`${baseUrl}/api/attendance/schedule-drafts/assignments`, {
        method: 'POST',
        headers,
        body: JSON.stringify(tempDraftBody(replacementShiftId, baseAssignment.id, { temporaryMode: 'add' })),
      })
      expect(addModeTempRes.status, JSON.stringify(addModeTempRes.body)).toBe(422)
      expect((addModeTempRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('TEMP_SHIFT_ADD_MODE_DEFERRED')

      const rotationReplaceRes = await requestJson(`${baseUrl}/api/attendance/schedule-drafts/assignments`, {
        method: 'POST',
        headers,
        body: JSON.stringify(tempDraftBody(replacementShiftId, baseAssignment.id, { temporaryReplacesKind: 'rotation' })),
      })
      expect(rotationReplaceRes.status, JSON.stringify(rotationReplaceRes.body)).toBe(422)
      expect((rotationReplaceRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('TEMP_SHIFT_ROTATION_REPLACEMENT_UNSUPPORTED')

      const tempDraftRes = await requestJson(`${baseUrl}/api/attendance/schedule-drafts/assignments`, {
        method: 'POST',
        headers,
        body: JSON.stringify(tempDraftBody(replacementShiftId, baseAssignment.id)),
      })
      expect(tempDraftRes.status, JSON.stringify(tempDraftRes.body)).toBe(201)
      const tempDraft = (tempDraftRes.body as { data?: { assignment?: {
        id?: string
        assignmentKind?: string
        temporaryMode?: string
        temporaryReplacesAssignmentId?: string
        publishStatus?: string
      } } } | undefined)?.data?.assignment
      expect(tempDraft?.publishStatus).toBe('draft')
      expect(tempDraft?.assignmentKind).toBe('temporary')
      expect(tempDraft?.temporaryMode).toBe('replace')
      expect(tempDraft?.temporaryReplacesAssignmentId).toBe(baseAssignment.id)
      expect(tempDraft?.id).toBeTruthy()
      if (!tempDraft?.id) return

      const tempEditRes = await requestJson(`${baseUrl}/api/attendance/schedule-drafts/assignments/${tempDraft.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ shiftId: baseShiftId }),
      })
      expect(tempEditRes.status, JSON.stringify(tempEditRes.body)).toBe(422)
      expect((tempEditRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('TEMP_SHIFT_EDIT_DEFERRED')

      const publishTempRes = await publish(tempDraft.id)
      expect(publishTempRes.status, JSON.stringify(publishTempRes.body)).toBe(200)
      const publishedTemp = (publishTempRes.body as { data?: { assignments?: Array<{ id?: string; assignmentKind?: string; publishStatus?: string; temporaryReplacesAssignmentId?: string }> } } | undefined)?.data?.assignments?.[0]
      expect(publishedTemp?.id).toBe(tempDraft.id)
      expect(publishedTemp?.publishStatus).toBe('published')
      expect(publishedTemp?.assignmentKind).toBe('temporary')
      expect(publishedTemp?.temporaryReplacesAssignmentId).toBe(baseAssignment.id)

      const persistedRows = await pool.query(
        `SELECT id, assignment_kind, temporary_mode, temporary_replaces_kind,
                temporary_replaces_assignment_id, temporary_reason, temporary_created_by,
                publish_status, locked_at
           FROM attendance_shift_assignments
          WHERE id = ANY($1::uuid[])
          ORDER BY assignment_kind ASC`,
        [[baseAssignment.id, tempDraft.id]]
      )
      expect(persistedRows.rows).toHaveLength(2)
      const persistedBase = persistedRows.rows.find(row => row.id === baseAssignment.id)
      const persistedTemp = persistedRows.rows.find(row => row.id === tempDraft.id)
      expect(persistedBase?.assignment_kind).toBe('regular')
      expect(persistedTemp).toMatchObject({
        assignment_kind: 'temporary',
        temporary_mode: 'replace',
        temporary_replaces_kind: 'shift',
        temporary_replaces_assignment_id: baseAssignment.id,
        temporary_reason: 'one-off onsite coverage',
        temporary_created_by: adminUserId,
        publish_status: 'published',
      })
      expect(persistedTemp?.locked_at).toBeTruthy()

      const defaultPlannedPreviewRes = await requestJson(`${baseUrl}/api/attendance/comprehensive-hours/preview`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          metric: 'planned',
          enforcement: 'warn',
          capMinutes: 1000,
          userId,
          period: { type: 'custom_range', from: workDate, to: workDate },
        }),
      })
      expect(defaultPlannedPreviewRes.status, JSON.stringify(defaultPlannedPreviewRes.body)).toBe(200)
      const defaultPlannedRows = (defaultPlannedPreviewRes.body as { data?: { rows?: Array<{ userId?: string; minutes?: number; plannedMinutes?: number }> } } | undefined)?.data?.rows ?? []
      expect(defaultPlannedRows).toHaveLength(1)
      expect(defaultPlannedRows[0]?.userId).toBe(userId)
      expect(defaultPlannedRows[0]?.minutes).toBe(480)
      expect(defaultPlannedRows[0]?.plannedMinutes).toBe(480)

      const singleShiftEffectiveCalendarRes = await requestJson(
        `${baseUrl}/api/attendance/effective-calendar?from=${workDate}&to=${workDate}&userId=${encodeURIComponent(userId)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      expect(singleShiftEffectiveCalendarRes.status, JSON.stringify(singleShiftEffectiveCalendarRes.body)).toBe(200)
      const singleShiftEffectiveItem = ((singleShiftEffectiveCalendarRes.body as { data?: { items?: Array<{ effective?: { plannedMinutes?: number; slots?: Array<{ shiftId?: string; assignmentKind?: string; replaces?: { assignmentId?: string } }> } }> } } | undefined)?.data?.items ?? [])[0]
      expect(singleShiftEffectiveItem?.effective?.plannedMinutes).toBe(480)
      expect(singleShiftEffectiveItem?.effective?.slots).toHaveLength(1)
      expect(singleShiftEffectiveItem?.effective?.slots?.[0]).toMatchObject({
        shiftId: replacementShiftId,
        assignmentKind: 'temporary',
        replaces: { assignmentId: baseAssignment.id },
      })

      const multiShiftSettingsRes = await requestJson(`${baseUrl}/api/attendance/settings`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          multiShiftDay: { enabled: true, maxSlots: 3 },
          shiftCompliance: { enforcement: 'warn', dailyMaxMinutes: null, weeklyMaxMinutes: null, monthlyMaxMinutes: null },
        }),
      })
      expect(multiShiftSettingsRes.status, JSON.stringify(multiShiftSettingsRes.body)).toBe(200)

      const effectiveCalendarRes = await requestJson(
        `${baseUrl}/api/attendance/effective-calendar?from=${workDate}&to=${workDate}&userId=${encodeURIComponent(userId)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      expect(effectiveCalendarRes.status, JSON.stringify(effectiveCalendarRes.body)).toBe(200)
      const effectiveItem = ((effectiveCalendarRes.body as { data?: { items?: Array<{ effective?: { plannedMinutes?: number; slots?: Array<{ shiftId?: string; assignmentKind?: string; replaces?: { assignmentId?: string } }> } }> } } | undefined)?.data?.items ?? [])[0]
      expect(effectiveItem?.effective?.plannedMinutes).toBe(480)
      expect(effectiveItem?.effective?.slots).toHaveLength(1)
      expect(effectiveItem?.effective?.slots?.[0]).toMatchObject({
        shiftId: replacementShiftId,
        assignmentKind: 'temporary',
        replaces: { assignmentId: baseAssignment.id },
      })

      const plannedPreviewRes = await requestJson(`${baseUrl}/api/attendance/comprehensive-hours/preview`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          metric: 'planned',
          enforcement: 'warn',
          capMinutes: 1000,
          userId,
          period: { type: 'custom_range', from: workDate, to: workDate },
        }),
      })
      expect(plannedPreviewRes.status, JSON.stringify(plannedPreviewRes.body)).toBe(200)
      const plannedRows = (plannedPreviewRes.body as { data?: { rows?: Array<{ userId?: string; minutes?: number; plannedMinutes?: number }> } } | undefined)?.data?.rows ?? []
      expect(plannedRows).toHaveLength(1)
      expect(plannedRows[0]?.userId).toBe(userId)
      expect(plannedRows[0]?.minutes).toBe(480)
      expect(plannedRows[0]?.plannedMinutes).toBe(480)

      const secondTempRes = await requestJson(`${baseUrl}/api/attendance/schedule-drafts/assignments`, {
        method: 'POST',
        headers,
        body: JSON.stringify(tempDraftBody(replacementShiftId, baseAssignment.id, { temporaryReason: 'second temp' })),
      })
      expect(secondTempRes.status, JSON.stringify(secondTempRes.body)).toBe(409)
      expect((secondTempRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('ATTENDANCE_SCHEDULE_ASSIGNMENT_CONFLICT')

      const fixedGroupRes = await requestJson(`${baseUrl}/api/attendance/groups`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: `temp-shift-fixed-${runSuffix}`,
          timezone: 'UTC',
          attendanceType: 'fixed_shift',
          description: 'temporary-shift fixed rebuild compatibility',
        }),
      })
      expect(fixedGroupRes.status, JSON.stringify(fixedGroupRes.body)).toBe(200)
      fixedGroupId = (fixedGroupRes.body as { data?: { id?: string } } | undefined)?.data?.id
      expect(fixedGroupId).toBeTruthy()
      if (!fixedGroupId) return
      const fixedMemberRes = await requestJson(`${baseUrl}/api/attendance/groups/${fixedGroupId}/members`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ userIds: [fixedUserId] }),
      })
      expect(fixedMemberRes.status, JSON.stringify(fixedMemberRes.body)).toBe(200)
      const fixedApplyRes = await requestJson(`${baseUrl}/api/attendance/groups/${fixedGroupId}/fixed-schedule/apply`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ shiftId: baseShiftId, startDate: fixedDate, endDate: fixedDate }),
      })
      expect(fixedApplyRes.status, JSON.stringify(fixedApplyRes.body)).toBe(201)
      const fixedBaseRows = await pool.query(
        `SELECT id
           FROM attendance_shift_assignments
          WHERE user_id = $1
            AND start_date = $2::date
            AND shift_id = $3
            AND producer_type = 'attendance_group_fixed_schedule'
            AND COALESCE(is_active, true) = true`,
        [fixedUserId, fixedDate, baseShiftId],
      )
      const fixedBaseAssignmentId = fixedBaseRows.rows[0]?.id
      expect(fixedBaseAssignmentId).toBeTruthy()
      if (!fixedBaseAssignmentId) return
      const fixedTempDraftRes = await requestJson(`${baseUrl}/api/attendance/schedule-drafts/assignments`, {
        method: 'POST',
        headers,
        body: JSON.stringify(tempDraftBody(replacementShiftId, fixedBaseAssignmentId, {
          userId: fixedUserId,
          startDate: fixedDate,
          endDate: fixedDate,
          temporaryReason: 'fixed rebuild replacement',
        })),
      })
      expect(fixedTempDraftRes.status, JSON.stringify(fixedTempDraftRes.body)).toBe(201)
      const fixedTempDraftId = (fixedTempDraftRes.body as { data?: { assignment?: { id?: string } } } | undefined)?.data?.assignment?.id
      expect(fixedTempDraftId).toBeTruthy()
      if (!fixedTempDraftId) return
      const publishFixedTempRes = await publish(fixedTempDraftId)
      expect(publishFixedTempRes.status, JSON.stringify(publishFixedTempRes.body)).toBe(200)
      expect(await loadEffectiveSlot(fixedUserId, fixedDate)).toMatchObject({
        shiftId: replacementShiftId,
        assignmentKind: 'temporary',
        replaces: { assignmentId: fixedBaseAssignmentId },
      })
      const fixedRebuildRes = await requestJson(`${baseUrl}/api/attendance/groups/${fixedGroupId}/fixed-schedule/rebuild`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ shiftId: baseShiftId, startDate: fixedDate, endDate: fixedDate }),
      })
      expect(fixedRebuildRes.status, JSON.stringify(fixedRebuildRes.body)).toBe(200)
      expect(await loadEffectiveSlot(fixedUserId, fixedDate)).toMatchObject({
        shiftId: replacementShiftId,
        assignmentKind: 'temporary',
        replaces: { assignmentId: fixedBaseAssignmentId },
      })

      const staleApplyRes = await requestJson(`${baseUrl}/api/attendance/groups/${fixedGroupId}/fixed-schedule/apply`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ shiftId: baseShiftId, startDate: staleTempDate, endDate: staleTempDate }),
      })
      expect(staleApplyRes.status, JSON.stringify(staleApplyRes.body)).toBe(201)
      await pool.query(
        `INSERT INTO attendance_shift_assignments
          (id, org_id, user_id, shift_id, slot_index, start_date, end_date, is_active, publish_status,
           assignment_kind, temporary_mode, temporary_replaces_kind, temporary_replaces_assignment_id,
           temporary_reason, temporary_created_by, temporary_created_at, locked_at)
         VALUES ($1, 'default', $2, $3, 0, $4::date, $4::date, true, 'published',
           'temporary', 'replace', 'shift', $5, 'stale unrelated temp overlay', $6, now(), now())`,
        [randomUUID(), fixedUserId, replacementShiftId, staleTempDate, baseAssignment.id, adminUserId],
      )
      const staleRebuildRes = await requestJson(`${baseUrl}/api/attendance/groups/${fixedGroupId}/fixed-schedule/rebuild`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ shiftId: baseShiftId, startDate: staleTempDate, endDate: staleTempDate }),
      })
      expect(staleRebuildRes.status, JSON.stringify(staleRebuildRes.body)).toBe(409)
      expect((staleRebuildRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('ATTENDANCE_GROUP_FIXED_SCHEDULE_BLOCKING_CONFLICT')

      const deleteTempRes = await requestJson(`${baseUrl}/api/attendance/assignments/${tempDraft.id}`, {
        method: 'DELETE',
        headers,
      })
      expect(deleteTempRes.status, JSON.stringify(deleteTempRes.body)).toBe(200)
      const inactiveTempRows = await pool.query(
        'SELECT is_active FROM attendance_shift_assignments WHERE id = $1',
        [tempDraft.id],
      )
      expect(inactiveTempRows.rows[0]?.is_active).toBe(false)
      expect(await loadEffectiveSlot(userId, workDate)).toMatchObject({
        shiftId: baseShiftId,
      })
    } finally {
      if (Object.keys(originalSettings).length > 0) {
        await requestJson(`${baseUrl}/api/attendance/settings`, {
          method: 'PUT',
          headers,
          body: JSON.stringify(originalSettings),
        }).catch(() => undefined)
      }
      await pool.query('DELETE FROM attendance_shift_assignments WHERE user_id = ANY($1::text[])', [[userId, fixedUserId]]).catch(() => undefined)
      if (fixedGroupId) {
        await pool.query('DELETE FROM attendance_group_members WHERE group_id = $1', [fixedGroupId]).catch(() => undefined)
        await pool.query('DELETE FROM attendance_groups WHERE id = $1', [fixedGroupId]).catch(() => undefined)
      }
      if (shiftIds.length > 0) {
        await pool.query('DELETE FROM attendance_shifts WHERE id = ANY($1::uuid[])', [shiftIds]).catch(() => undefined)
      }
      await pool.end().catch(() => undefined)
    }
  })

  it('enforces schedule-edit windows on shift and rotation assignment writes', async () => {
    if (!baseUrl) return

    const runSuffix = Date.now().toString(36)
    const adminUserId = `attendance-shift-edit-window-admin-${runSuffix}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(adminUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const settingsRes = await requestJson(`${baseUrl}/api/attendance/settings`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(settingsRes.status).toBe(200)
    const originalSettings = ((settingsRes.body as { data?: Record<string, unknown> } | undefined)?.data ?? {}) as Record<string, unknown>

    const pastDate = '2020-01-10'
    const yesterday = localDateKeyOffset(-1)

    async function saveShiftEditPolicy(shiftEditPolicy: Record<string, unknown>) {
      const res = await requestJson(`${baseUrl}/api/attendance/settings`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ shiftEditPolicy }),
      })
      expect(res.status).toBe(200)
      return (res.body as { data?: { shiftEditPolicy?: Record<string, unknown> } } | undefined)?.data?.shiftEditPolicy
    }

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

    async function createRotationRule(shiftId: string): Promise<string> {
      const ruleRes = await requestJson(`${baseUrl}/api/attendance/rotation-rules`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: `Edit Window Rotation ${runSuffix}`,
          timezone: 'Asia/Shanghai',
          shiftSequence: [shiftId],
          isActive: true,
        }),
      })
      expect(ruleRes.status).toBe(201)
      const ruleId = (ruleRes.body as { data?: { id?: string } } | undefined)?.data?.id
      expect(ruleId).toBeTruthy()
      if (!ruleId) throw new Error('missing rotation rule id')
      return ruleId
    }

    async function createShiftAssignment(userId: string, shiftId: string, startDate: string) {
      return requestJson(`${baseUrl}/api/attendance/assignments`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ userId, shiftId, startDate, isActive: true }),
      })
    }

    async function createRotationAssignment(userId: string, rotationRuleId: string, startDate: string) {
      return requestJson(`${baseUrl}/api/attendance/rotation-assignments`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ userId, rotationRuleId, startDate, isActive: true }),
      })
    }

    function expectShiftEditWindowExceeded(res: HttpResponse) {
      expect(res.status).toBe(422)
      const error = (res.body as { error?: { code?: string; details?: { earliestDate?: string } } } | undefined)?.error
      expect(error?.code).toBe('SHIFT_EDIT_WINDOW_EXCEEDED')
      expect(error?.details?.earliestDate).toBe(pastDate)
    }

    try {
      await saveShiftEditPolicy({ mode: 'unrestricted', windowDays: 0 })
      const shiftId = await createShift(`Edit Window Shift ${runSuffix}`)
      const rotationRuleId = await createRotationRule(shiftId)

      const existingShiftUpdateRes = await createShiftAssignment(`${adminUserId}-shift-update`, shiftId, pastDate)
      expect(existingShiftUpdateRes.status).toBe(201)
      const existingShiftUpdateId = (existingShiftUpdateRes.body as { data?: { assignment?: { id?: string } } } | undefined)?.data?.assignment?.id
      expect(existingShiftUpdateId).toBeTruthy()
      if (!existingShiftUpdateId) return

      const existingShiftDeleteRes = await createShiftAssignment(`${adminUserId}-shift-delete`, shiftId, pastDate)
      expect(existingShiftDeleteRes.status).toBe(201)
      const existingShiftDeleteId = (existingShiftDeleteRes.body as { data?: { assignment?: { id?: string } } } | undefined)?.data?.assignment?.id
      expect(existingShiftDeleteId).toBeTruthy()
      if (!existingShiftDeleteId) return

      const existingRotationUpdateRes = await createRotationAssignment(`${adminUserId}-rotation-update`, rotationRuleId, pastDate)
      expect(existingRotationUpdateRes.status).toBe(201)
      const existingRotationUpdateId = (existingRotationUpdateRes.body as { data?: { assignment?: { id?: string } } } | undefined)?.data?.assignment?.id
      expect(existingRotationUpdateId).toBeTruthy()
      if (!existingRotationUpdateId) return

      const existingRotationDeleteRes = await createRotationAssignment(`${adminUserId}-rotation-delete`, rotationRuleId, pastDate)
      expect(existingRotationDeleteRes.status).toBe(201)
      const existingRotationDeleteId = (existingRotationDeleteRes.body as { data?: { assignment?: { id?: string } } } | undefined)?.data?.assignment?.id
      expect(existingRotationDeleteId).toBeTruthy()
      if (!existingRotationDeleteId) return

      await saveShiftEditPolicy({ mode: 'past_locked', windowDays: 0 })

      expectShiftEditWindowExceeded(await createShiftAssignment(`${adminUserId}-shift-create-blocked`, shiftId, pastDate))
      expectShiftEditWindowExceeded(await createRotationAssignment(`${adminUserId}-rotation-create-blocked`, rotationRuleId, pastDate))

      const blockedShiftUpdateRes = await requestJson(`${baseUrl}/api/attendance/assignments/${existingShiftUpdateId}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ endDate: pastDate }),
      })
      expectShiftEditWindowExceeded(blockedShiftUpdateRes)

      const blockedShiftDeleteRes = await requestJson(`${baseUrl}/api/attendance/assignments/${existingShiftDeleteId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      expectShiftEditWindowExceeded(blockedShiftDeleteRes)

      const blockedRotationUpdateRes = await requestJson(`${baseUrl}/api/attendance/rotation-assignments/${existingRotationUpdateId}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ endDate: pastDate }),
      })
      expectShiftEditWindowExceeded(blockedRotationUpdateRes)

      const blockedRotationDeleteRes = await requestJson(`${baseUrl}/api/attendance/rotation-assignments/${existingRotationDeleteId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      expectShiftEditWindowExceeded(blockedRotationDeleteRes)

      const policy = await saveShiftEditPolicy({ mode: 'past_within_window', windowDays: 7 })
      expect(policy).toEqual({ mode: 'past_within_window', windowDays: 7 })

      const windowShiftRes = await createShiftAssignment(`${adminUserId}-shift-window-ok`, shiftId, yesterday)
      expect(windowShiftRes.status).toBe(201)
      const windowRotationRes = await createRotationAssignment(`${adminUserId}-rotation-window-ok`, rotationRuleId, yesterday)
      expect(windowRotationRes.status).toBe(201)

      await saveShiftEditPolicy({ mode: 'unrestricted', windowDays: 0 })
      const unrestrictedPastRes = await createShiftAssignment(`${adminUserId}-shift-unrestricted-ok`, shiftId, pastDate)
      expect(unrestrictedPastRes.status).toBe(201)
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

  it('blocks an unscheduled punch (punchPolicy.unscheduled.mode=block) before any attendance_event INSERT', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return
    const runSuffix = Date.now().toString(36)
    const adminUserId = `attendance-punchpolicy-admin-${runSuffix}`
    const employeeUserId = `attendance-punchpolicy-employee-${runSuffix}`
    const workDate = '2026-05-20'
    const occurredAt = `${workDate}T03:00:00.000Z`
    const previousRbacBypass = process.env.RBAC_BYPASS
    const pool = new Pool({ connectionString: dbUrl })
    let adminToken: string | undefined
    let originalSettings: Record<string, unknown> = {}
    let groupId: string | undefined
    try {
      process.env.RBAC_BYPASS = 'false'
      await pool.query(
        `INSERT INTO permissions (code, name, description)
         VALUES ('attendance:read', 'Attendance Read', 'r'), ('attendance:write', 'Attendance Write', 'w'), ('attendance:admin', 'Attendance Admin', 'a')
         ON CONFLICT (code) DO NOTHING`,
      )
      await pool.query(
        `INSERT INTO user_permissions (user_id, permission_code)
         VALUES ($1, 'attendance:read'), ($1, 'attendance:write'), ($1, 'attendance:admin'), ($2, 'attendance:read'), ($2, 'attendance:write')
         ON CONFLICT DO NOTHING`,
        [adminUserId, employeeUserId],
      )
      const adminTokenRes = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(adminUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`)
      const employeeTokenRes = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(employeeUserId)}&roles=user&perms=attendance:read,attendance:write`)
      adminToken = (adminTokenRes.body as { token?: string } | undefined)?.token
      const employeeToken = (employeeTokenRes.body as { token?: string } | undefined)?.token
      if (!adminToken || !employeeToken) return
      const adminHeaders = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }
      const employeeHeaders = { Authorization: `Bearer ${employeeToken}`, 'Content-Type': 'application/json' }

      // Save original settings, opt the org into block, and confirm the PUT round-trips through GET.
      const origRes = await requestJson(`${baseUrl}/api/attendance/settings`, { headers: { Authorization: `Bearer ${adminToken}` } })
      originalSettings = ((origRes.body as { data?: Record<string, unknown> } | undefined)?.data ?? {}) as Record<string, unknown>
      const putBlockRes = await requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ punchPolicy: { unscheduled: { mode: 'block' } } }) })
      expect(putBlockRes.status).toBe(200)
      const roundTripRes = await requestJson(`${baseUrl}/api/attendance/settings`, { headers: { Authorization: `Bearer ${adminToken}` } })
      expect((roundTripRes.body as { data?: { punchPolicy?: { unscheduled?: { mode?: string } } } } | undefined)?.data?.punchPolicy?.unscheduled?.mode).toBe('block')

      // scheduled_shift group + employee member, but NO schedule-group membership / shift assignment.
      const groupRes = await requestJson(`${baseUrl}/api/attendance/groups`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: `punchpolicy-${runSuffix}`, timezone: 'UTC', attendanceType: 'scheduled_shift', description: 'integration-test' }) })
      expect(groupRes.status).toBe(200)
      groupId = (groupRes.body as { data?: { id?: string } } | undefined)?.data?.id
      const memberRes = await requestJson(`${baseUrl}/api/attendance/groups/${groupId}/members`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ userIds: [employeeUserId] }) })
      expect(memberRes.status).toBe(200)

      // Unscheduled punch -> 422, and crucially NO event written (blocked before the INSERT).
      const blockedRes = await requestJson(`${baseUrl}/api/attendance/punch`, { method: 'POST', headers: employeeHeaders, body: JSON.stringify({ eventType: 'check_in', occurredAt }) })
      expect(blockedRes.status).toBe(422)
      expect((blockedRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('PUNCH_UNSCHEDULED_BLOCKED')
      const afterBlock = await pool.query('SELECT 1 FROM attendance_events WHERE user_id = $1 AND work_date = $2', [employeeUserId, workDate])
      expect(afterBlock.rows.length).toBe(0)

      // Positive control: switch to allow -> the same unscheduled punch now succeeds and IS written.
      const putAllowRes = await requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ punchPolicy: { unscheduled: { mode: 'allow' } } }) })
      expect(putAllowRes.status).toBe(200)
      const allowedRes = await requestJson(`${baseUrl}/api/attendance/punch`, { method: 'POST', headers: employeeHeaders, body: JSON.stringify({ eventType: 'check_in', occurredAt }) })
      expect(allowedRes.status).toBe(200)
      const afterAllow = await pool.query('SELECT 1 FROM attendance_events WHERE user_id = $1 AND work_date = $2', [employeeUserId, workDate])
      expect(afterAllow.rows.length).toBeGreaterThan(0)
    } finally {
      if (adminToken) {
        await requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(originalSettings) }).catch(() => undefined)
      }
      await pool.query('DELETE FROM attendance_events WHERE user_id = $1', [employeeUserId]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_records WHERE user_id = $1', [employeeUserId]).catch(() => undefined)
      if (groupId) {
        await pool.query('DELETE FROM attendance_group_members WHERE group_id = $1', [groupId]).catch(() => undefined)
        await pool.query('DELETE FROM attendance_groups WHERE id = $1', [groupId]).catch(() => undefined)
      }
      await pool.query('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[adminUserId, employeeUserId]]).catch(() => undefined)
      if (previousRbacBypass === undefined) delete process.env.RBAC_BYPASS
      else process.env.RBAC_BYPASS = previousRbacBypass
      await pool.end().catch(() => undefined)
    }
  })

  it('enforces the daily shift-compliance cap (block) across all assignment-save paths and persists nothing on 422', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return
    const runSuffix = Date.now().toString(36)
    const adminUserId = `attendance-compliance-admin-${runSuffix}`
    const targetUserId = `attendance-compliance-user-${runSuffix}`
    const memberUserId = `attendance-compliance-member-${runSuffix}`
    // The shift works all 7 weekdays (540 min/day), so each date is a working day → date-independent.
    const startA = '2026-07-06' // shift POST
    const startB = '2026-07-13' // shift PUT (small -> big)
    const startC = '2026-07-20' // rotation POST
    const startD = '2026-07-27' // fixed-schedule apply (member)
    const startE = '2026-08-03' // no-regression: cap with headroom
    const startF = '2026-08-10' // no-regression: cap unset (null)
    const startG = '2026-08-17' // rotation PUT
    const startH = '2026-08-24' // fixed-schedule rebuild
    const previousRbacBypass = process.env.RBAC_BYPASS
    const pool = new Pool({ connectionString: dbUrl })
    let adminToken: string | undefined
    let originalSettings: Record<string, unknown> = {}
    let groupId: string | undefined
    let bigShiftId: string | undefined
    let smallShiftId: string | undefined
    let rotationRuleId: string | undefined
    let smallRotationRuleId: string | undefined
    try {
      // Compliance enforcement is orthogonal to RBAC (it runs after the dispatch check, inside the
      // txn). Bypass RBAC so each save path reaches the guard without per-route permission plumbing.
      process.env.RBAC_BYPASS = 'true'
      const adminTokenRes = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(adminUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`)
      adminToken = (adminTokenRes.body as { token?: string } | undefined)?.token
      if (!adminToken) return
      const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }

      // Opt the org into block + a tiny daily cap, and confirm the PUT round-trips through GET.
      const origRes = await requestJson(`${baseUrl}/api/attendance/settings`, { headers: { Authorization: `Bearer ${adminToken}` } })
      originalSettings = ((origRes.body as { data?: Record<string, unknown> } | undefined)?.data ?? {}) as Record<string, unknown>
      const putRes = await requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers, body: JSON.stringify({ shiftCompliance: { enforcement: 'block', dailyMaxMinutes: 60 } }) })
      expect(putRes.status).toBe(200)
      const rt = await requestJson(`${baseUrl}/api/attendance/settings`, { headers: { Authorization: `Bearer ${adminToken}` } })
      const rtCompliance = (rt.body as { data?: { shiftCompliance?: { dailyMaxMinutes?: number; enforcement?: string } } } | undefined)?.data?.shiftCompliance
      expect(rtCompliance?.dailyMaxMinutes).toBe(60)
      expect(rtCompliance?.enforcement).toBe('block')

      // A 9h shift (540 min planned every day, > 60) and a 30-min shift (< 60).
      const bigShiftRes = await requestJson(`${baseUrl}/api/attendance/shifts`, { method: 'POST', headers, body: JSON.stringify({ name: `compliance-big-${runSuffix}`, timezone: 'UTC', workStartTime: '09:00', workEndTime: '18:00', workingDays: [0, 1, 2, 3, 4, 5, 6] }) })
      expect(bigShiftRes.status).toBe(201)
      bigShiftId = (bigShiftRes.body as { data?: { id?: string } } | undefined)?.data?.id
      const smallShiftRes = await requestJson(`${baseUrl}/api/attendance/shifts`, { method: 'POST', headers, body: JSON.stringify({ name: `compliance-small-${runSuffix}`, timezone: 'UTC', workStartTime: '09:00', workEndTime: '09:30', workingDays: [0, 1, 2, 3, 4, 5, 6] }) })
      expect(smallShiftRes.status).toBe(201)
      smallShiftId = (smallShiftRes.body as { data?: { id?: string } } | undefined)?.data?.id

      // (1) shift POST -> 422, and NO row written (rolled back before commit).
      const shiftPostRes = await requestJson(`${baseUrl}/api/attendance/assignments`, { method: 'POST', headers, body: JSON.stringify({ userId: targetUserId, shiftId: bigShiftId, startDate: startA, endDate: startA, isActive: true }) })
      expect(shiftPostRes.status).toBe(422)
      expect((shiftPostRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SHIFT_COMPLIANCE_CAP_EXCEEDED')
      const afterShiftPost = await pool.query('SELECT 1 FROM attendance_shift_assignments WHERE user_id = $1 AND start_date = $2', [targetUserId, startA])
      expect(afterShiftPost.rows.length).toBe(0)

      // (2) shift PUT -> create with the small shift (under cap) succeeds, PUT to the big shift -> 422
      // and the row is unchanged (still the small shift) because the txn rolled back.
      const smallAssignRes = await requestJson(`${baseUrl}/api/attendance/assignments`, { method: 'POST', headers, body: JSON.stringify({ userId: targetUserId, shiftId: smallShiftId, startDate: startB, endDate: startB, isActive: true }) })
      expect(smallAssignRes.status).toBe(201)
      const shiftAssignmentId = (smallAssignRes.body as { data?: { assignment?: { id?: string } } } | undefined)?.data?.assignment?.id
      const shiftPutRes = await requestJson(`${baseUrl}/api/attendance/assignments/${shiftAssignmentId}`, { method: 'PUT', headers, body: JSON.stringify({ shiftId: bigShiftId }) })
      expect(shiftPutRes.status).toBe(422)
      expect((shiftPutRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SHIFT_COMPLIANCE_CAP_EXCEEDED')
      const afterShiftPut = await pool.query('SELECT shift_id FROM attendance_shift_assignments WHERE id = $1', [shiftAssignmentId])
      expect(String(afterShiftPut.rows[0]?.shift_id)).toBe(String(smallShiftId))

      // (3) rotation POST (rotation rule whose only shift is the big one) -> 422, no rotation row.
      const rotRuleRes = await requestJson(`${baseUrl}/api/attendance/rotation-rules`, { method: 'POST', headers, body: JSON.stringify({ name: `compliance-rot-${runSuffix}`, timezone: 'UTC', shiftSequence: [bigShiftId], isActive: true }) })
      expect(rotRuleRes.status).toBe(201)
      rotationRuleId = (rotRuleRes.body as { data?: { id?: string } } | undefined)?.data?.id
      const rotPostRes = await requestJson(`${baseUrl}/api/attendance/rotation-assignments`, { method: 'POST', headers, body: JSON.stringify({ userId: targetUserId, rotationRuleId, startDate: startC, isActive: true }) })
      expect(rotPostRes.status).toBe(422)
      expect((rotPostRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SHIFT_COMPLIANCE_CAP_EXCEEDED')
      const afterRotPost = await pool.query('SELECT 1 FROM attendance_rotation_assignments WHERE user_id = $1 AND start_date = $2', [targetUserId, startC])
      expect(afterRotPost.rows.length).toBe(0)

      // (3b) rotation PUT -> assign a small-shift rotation (under cap) succeeds, PUT it to the big-shift
      // rotation rule -> 422 and the row is unchanged (still the small rule) because the txn rolled back.
      const smallRotRuleRes = await requestJson(`${baseUrl}/api/attendance/rotation-rules`, { method: 'POST', headers, body: JSON.stringify({ name: `compliance-rot-small-${runSuffix}`, timezone: 'UTC', shiftSequence: [smallShiftId], isActive: true }) })
      expect(smallRotRuleRes.status).toBe(201)
      smallRotationRuleId = (smallRotRuleRes.body as { data?: { id?: string } } | undefined)?.data?.id
      const smallRotAssignRes = await requestJson(`${baseUrl}/api/attendance/rotation-assignments`, { method: 'POST', headers, body: JSON.stringify({ userId: targetUserId, rotationRuleId: smallRotationRuleId, startDate: startG, endDate: startG, isActive: true }) })
      expect(smallRotAssignRes.status).toBe(201)
      const rotationAssignmentId = (smallRotAssignRes.body as { data?: { assignment?: { id?: string } } } | undefined)?.data?.assignment?.id
      const rotPutRes = await requestJson(`${baseUrl}/api/attendance/rotation-assignments/${rotationAssignmentId}`, { method: 'PUT', headers, body: JSON.stringify({ rotationRuleId }) })
      expect(rotPutRes.status).toBe(422)
      expect((rotPutRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SHIFT_COMPLIANCE_CAP_EXCEEDED')
      const afterRotPut = await pool.query('SELECT rotation_rule_id FROM attendance_rotation_assignments WHERE id = $1', [rotationAssignmentId])
      expect(String(afterRotPut.rows[0]?.rotation_rule_id)).toBe(String(smallRotationRuleId))

      // (4) fixed-schedule apply (bulk) -> 422, no managed row for the member (whole apply rolled back).
      const groupRes = await requestJson(`${baseUrl}/api/attendance/groups`, { method: 'POST', headers, body: JSON.stringify({ name: `compliance-grp-${runSuffix}`, timezone: 'UTC', attendanceType: 'fixed_shift', description: 'integration-test' }) })
      expect(groupRes.status).toBe(200)
      groupId = (groupRes.body as { data?: { id?: string } } | undefined)?.data?.id
      const memberRes = await requestJson(`${baseUrl}/api/attendance/groups/${groupId}/members`, { method: 'POST', headers, body: JSON.stringify({ userIds: [memberUserId] }) })
      expect(memberRes.status).toBe(200)
      const applyRes = await requestJson(`${baseUrl}/api/attendance/groups/${groupId}/fixed-schedule/apply`, { method: 'POST', headers, body: JSON.stringify({ shiftId: bigShiftId, startDate: startD, endDate: startD }) })
      expect(applyRes.status).toBe(422)
      expect((applyRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SHIFT_COMPLIANCE_CAP_EXCEEDED')
      const afterApply = await pool.query('SELECT 1 FROM attendance_shift_assignments WHERE user_id = $1', [memberUserId])
      expect(afterApply.rows.length).toBe(0)

      // (4b) fixed-schedule REBUILD shares the managed-insert path with apply — guard it too (closes
      // the rebuild side-door). Big shift -> 422, and no managed row persisted for the member.
      const rebuildRes = await requestJson(`${baseUrl}/api/attendance/groups/${groupId}/fixed-schedule/rebuild`, { method: 'POST', headers, body: JSON.stringify({ shiftId: bigShiftId, startDate: startH, endDate: startH }) })
      expect(rebuildRes.status).toBe(422)
      expect((rebuildRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SHIFT_COMPLIANCE_CAP_EXCEEDED')
      const afterRebuild = await pool.query('SELECT 1 FROM attendance_shift_assignments WHERE user_id = $1', [memberUserId])
      expect(afterRebuild.rows.length).toBe(0)

      // (5) no regression — raise the cap above the shift: the same big-shift POST now succeeds.
      const putHigh = await requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers, body: JSON.stringify({ shiftCompliance: { enforcement: 'block', dailyMaxMinutes: 600 } }) })
      expect(putHigh.status).toBe(200)
      const headroomRes = await requestJson(`${baseUrl}/api/attendance/assignments`, { method: 'POST', headers, body: JSON.stringify({ userId: targetUserId, shiftId: bigShiftId, startDate: startE, endDate: startE, isActive: true }) })
      expect(headroomRes.status).toBe(201)

      // (6) no regression — cap unset (null): enforcement is inert, the big-shift POST succeeds.
      const putNull = await requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers, body: JSON.stringify({ shiftCompliance: { enforcement: 'block', dailyMaxMinutes: null } }) })
      expect(putNull.status).toBe(200)
      const unsetRes = await requestJson(`${baseUrl}/api/attendance/assignments`, { method: 'POST', headers, body: JSON.stringify({ userId: targetUserId, shiftId: bigShiftId, startDate: startF, endDate: startF, isActive: true }) })
      expect(unsetRes.status).toBe(201)
    } finally {
      if (adminToken) {
        await requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(originalSettings) }).catch(() => undefined)
      }
      await pool.query('DELETE FROM attendance_shift_assignments WHERE user_id = ANY($1::text[])', [[targetUserId, memberUserId]]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_rotation_assignments WHERE user_id = $1', [targetUserId]).catch(() => undefined)
      if (rotationRuleId) await pool.query('DELETE FROM attendance_rotation_rules WHERE id = $1', [rotationRuleId]).catch(() => undefined)
      if (smallRotationRuleId) await pool.query('DELETE FROM attendance_rotation_rules WHERE id = $1', [smallRotationRuleId]).catch(() => undefined)
      if (groupId) {
        await pool.query('DELETE FROM attendance_group_members WHERE group_id = $1', [groupId]).catch(() => undefined)
        await pool.query('DELETE FROM attendance_groups WHERE id = $1', [groupId]).catch(() => undefined)
      }
      if (bigShiftId) await pool.query('DELETE FROM attendance_shifts WHERE id = $1', [bigShiftId]).catch(() => undefined)
      if (smallShiftId) await pool.query('DELETE FROM attendance_shifts WHERE id = $1', [smallShiftId]).catch(() => undefined)
      if (previousRbacBypass === undefined) delete process.env.RBAC_BYPASS
      else process.env.RBAC_BYPASS = previousRbacBypass
      await pool.end().catch(() => undefined)
    }
  })

  it('enforces weekly and monthly shift-compliance caps (block) independently of the daily cap', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return
    const runSuffix = Date.now().toString(36)
    const adminUserId = `attendance-comp2-admin-${runSuffix}`
    const uWeekOk = `attendance-comp2-wk-ok-${runSuffix}`
    const uWeekOver = `attendance-comp2-wk-over-${runSuffix}`
    const uMonthOver = `attendance-comp2-mo-over-${runSuffix}`
    const uMonthOk = `attendance-comp2-mo-ok-${runSuffix}`
    // The cap is EXPLICIT scheduled load (default-rule baseline excluded). With the org default of
    // Mon–Fri 09:00–18:00 (540 min/day → 2700/week), a weekly cap of 2400 would block EVERY save if the
    // baseline counted; under explicit-only a single 540-min assignment is 540 < 2400 → must pass. The
    // 9h shift works all 7 days, so each explicit assignment day contributes 540.
    const dWeekOkMon = '2026-10-05' // Monday — single explicit day, under the 2400 cap
    const dWeekOverMon = '2026-10-05' // Mon; the over-cap user assigns Mon+Tue (same ISO week)
    const dWeekOverTue = '2026-10-06' // Tue
    const dMonthOverA = '2026-11-09' // both in November — two explicit days over the monthly cap
    const dMonthOverB = '2026-11-10'
    const dMonthOk = '2026-12-07' // single explicit day, under the 2400 cap
    const previousRbacBypass = process.env.RBAC_BYPASS
    const pool = new Pool({ connectionString: dbUrl })
    let adminToken: string | undefined
    let originalSettings: Record<string, unknown> = {}
    let shiftId: string | undefined
    try {
      process.env.RBAC_BYPASS = 'true'
      const adminTokenRes = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(adminUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`)
      adminToken = (adminTokenRes.body as { token?: string } | undefined)?.token
      if (!adminToken) return
      const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }
      const origRes = await requestJson(`${baseUrl}/api/attendance/settings`, { headers: { Authorization: `Bearer ${adminToken}` } })
      originalSettings = ((origRes.body as { data?: Record<string, unknown> } | undefined)?.data ?? {}) as Record<string, unknown>

      const bigShiftRes = await requestJson(`${baseUrl}/api/attendance/shifts`, { method: 'POST', headers, body: JSON.stringify({ name: `comp2-big-${runSuffix}`, timezone: 'UTC', workStartTime: '09:00', workEndTime: '18:00', workingDays: [0, 1, 2, 3, 4, 5, 6] }) })
      expect(bigShiftRes.status).toBe(201)
      shiftId = (bigShiftRes.body as { data?: { id?: string } } | undefined)?.data?.id

      const postAssignment = (userId: string, startDate: string, endDate: string = startDate) => requestJson(`${baseUrl}/api/attendance/assignments`, { method: 'POST', headers, body: JSON.stringify({ userId, shiftId, startDate, endDate, isActive: true }) })
      // Each PUT fully specifies all caps (explicit nulls) so only the granularity under test is active.
      const putCaps = (patch: Record<string, unknown>) => requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers, body: JSON.stringify({ shiftCompliance: { enforcement: 'block', dailyMaxMinutes: null, weeklyMaxMinutes: null, monthlyMaxMinutes: null, ...patch } }) })
      const errorOf = (res: HttpResponse) => (res.body as { error?: { code?: string; granularity?: string } } | undefined)?.error
      const rowCount = async (userId: string) => (await pool.query('SELECT 1 FROM attendance_shift_assignments WHERE user_id = $1', [userId])).rows.length

      // WEEKLY — daily/monthly unset, so only the weekly cap can fire.
      // (1) Anti-false-block: a 2400 cap + ONE explicit 540 day passes — the Mon–Fri default baseline
      //     (2700) is NOT counted. This would 422 if the projection counted the effective calendar.
      expect((await putCaps({ weeklyMaxMinutes: 2400 })).status).toBe(200)
      expect((await postAssignment(uWeekOk, dWeekOkMon)).status).toBe(201)
      // (2) Cumulative explicit over: two explicit days in one ISO week (1080) over a 1000 cap → 422.
      expect((await putCaps({ weeklyMaxMinutes: 1000 })).status).toBe(200)
      const wkOver = await postAssignment(uWeekOver, dWeekOverMon, dWeekOverTue)
      expect(wkOver.status).toBe(422)
      expect(errorOf(wkOver)?.code).toBe('SHIFT_COMPLIANCE_CAP_EXCEEDED')
      expect(errorOf(wkOver)?.granularity).toBe('weekly')
      expect(await rowCount(uWeekOver)).toBe(0)

      // MONTHLY — daily/weekly unset, so only the monthly cap can fire.
      // (3) Cumulative explicit over: two explicit days in one month (1080) over a 1000 cap → 422.
      expect((await putCaps({ monthlyMaxMinutes: 1000 })).status).toBe(200)
      const moOver = await postAssignment(uMonthOver, dMonthOverA, dMonthOverB)
      expect(moOver.status).toBe(422)
      expect(errorOf(moOver)?.granularity).toBe('monthly')
      expect(await rowCount(uMonthOver)).toBe(0)
      // (4) Within: a 2400 cap + one explicit 540 day passes (baseline not counted).
      expect((await putCaps({ monthlyMaxMinutes: 2400 })).status).toBe(200)
      expect((await postAssignment(uMonthOk, dMonthOk)).status).toBe(201)
    } finally {
      if (adminToken) {
        await requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(originalSettings) }).catch(() => undefined)
      }
      await pool.query('DELETE FROM attendance_shift_assignments WHERE user_id = ANY($1::text[])', [[uWeekOk, uWeekOver, uMonthOver, uMonthOk]]).catch(() => undefined)
      if (shiftId) await pool.query('DELETE FROM attendance_shifts WHERE id = $1', [shiftId]).catch(() => undefined)
      if (previousRbacBypass === undefined) delete process.env.RBAC_BYPASS
      else process.env.RBAC_BYPASS = previousRbacBypass
      await pool.end().catch(() => undefined)
    }
  })

  it('④ C1 leave-balance ledger — source_key uniqueness + not-null backstop + events FK (latent schema)', async () => {
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return
    const pool = new Pool({ connectionString: dbUrl })
    const runSuffix = Date.now().toString(36)
    const orgId = 'default'
    const userId = `c1-${runSuffix}`
    const sourceKey = `overtime_conversion:c1-${runSuffix}`
    let balanceId: string | undefined
    try {
      // A grant lot inserts.
      const ins = await pool.query(
        `INSERT INTO attendance_leave_balances
           (org_id, user_id, leave_type_code, amount_minutes, remaining_minutes, source_type, source_id, source_key)
         VALUES ($1, $2, 'comp_time', 480, 480, 'overtime_conversion', $3, $4) RETURNING id`,
        [orgId, userId, `req-${runSuffix}`, sourceKey],
      )
      balanceId = ins.rows[0]?.id as string | undefined
      expect(balanceId).toBeTruthy()

      // (1) double-credit backstop: same (org_id, source_key) -> unique violation (23505).
      let dupErr: { code?: string } | null = null
      try {
        await pool.query(
          `INSERT INTO attendance_leave_balances
             (org_id, user_id, leave_type_code, amount_minutes, remaining_minutes, source_type, source_key)
           VALUES ($1, $2, 'comp_time', 60, 60, 'overtime_conversion', $3)`,
          [orgId, userId, sourceKey],
        )
      } catch (e) { dupErr = e as { code?: string } }
      expect(dupErr?.code).toBe('23505')

      // (2) source_key is the backstop precisely because it is NOT NULL -> null rejected (23502).
      let nullErr: { code?: string } | null = null
      try {
        await pool.query(
          `INSERT INTO attendance_leave_balances
             (org_id, user_id, leave_type_code, amount_minutes, remaining_minutes, source_type, source_key)
           VALUES ($1, $2, 'comp_time', 60, 60, 'manual_grant', NULL)`,
          [orgId, `${userId}-n`],
        )
      } catch (e) { nullErr = e as { code?: string } }
      expect(nullErr?.code).toBe('23502')

      // (3) events ledger row references the lot; a dangling balance_id -> FK violation (23503).
      const ev = await pool.query(
        `INSERT INTO attendance_leave_balance_events
           (org_id, user_id, balance_id, event_type, delta_minutes, source_type, source_id)
         VALUES ($1, $2, $3, 'grant', 480, 'overtime_conversion', $4) RETURNING id`,
        [orgId, userId, balanceId, `req-${runSuffix}`],
      )
      expect(ev.rows[0]?.id).toBeTruthy()
      let fkErr: { code?: string } | null = null
      try {
        await pool.query(
          `INSERT INTO attendance_leave_balance_events
             (org_id, user_id, balance_id, event_type, delta_minutes)
           VALUES ($1, $2, '00000000-0000-4000-8000-000000000000', 'deduct', -60)`,
          [orgId, userId],
        )
      } catch (e) { fkErr = e as { code?: string } }
      expect(fkErr?.code).toBe('23503')

      // (4) DB-level balance math + enum invariants (#2230) — every impossible balance is a 23514
      // check_violation, so a future code bug can't persist one. Each insert is valid except the
      // field under test (distinct user/source_key so unique/not-null don't fire first).
      const rejects = async (text: string, params: unknown[], code: string, label: string) => {
        let err: { code?: string } | null = null
        try { await pool.query(text, params) } catch (e) { err = e as { code?: string } }
        expect({ label, code: err?.code }).toEqual({ label, code })
      }
      const balanceInsert = `INSERT INTO attendance_leave_balances
        (org_id, user_id, leave_type_code, amount_minutes, remaining_minutes, source_type, source_key, status)
        VALUES ($1, $2, 'comp_time', $3, $4, 'manual_grant', $5, $6)`
      await rejects(balanceInsert, [orgId, `${userId}-a`, 0, 0, `mk:${runSuffix}:a`, 'active'], '23514', 'amount_minutes must be > 0')
      await rejects(balanceInsert, [orgId, `${userId}-b`, 10, -5, `mk:${runSuffix}:b`, 'active'], '23514', 'remaining_minutes must be >= 0')
      await rejects(balanceInsert, [orgId, `${userId}-c`, 10, 20, `mk:${runSuffix}:c`, 'active'], '23514', 'remaining_minutes must be <= amount_minutes')
      await rejects(balanceInsert, [orgId, `${userId}-d`, 10, 10, `mk:${runSuffix}:d`, 'bogus'], '23514', 'status must be a valid enum')

      const eventInsert = `INSERT INTO attendance_leave_balance_events
        (org_id, user_id, balance_id, event_type, delta_minutes) VALUES ($1, $2, $3, $4, $5)`
      await rejects(eventInsert, [orgId, userId, balanceId, 'bogus', 10], '23514', 'event_type must be a valid enum')
      await rejects(eventInsert, [orgId, userId, balanceId, 'grant', 0], '23514', 'delta_minutes <> 0 (grant)')
      await rejects(eventInsert, [orgId, userId, balanceId, 'grant', -5], '23514', 'grant delta must be > 0')
      await rejects(eventInsert, [orgId, userId, balanceId, 'deduct', 5], '23514', 'deduct delta must be < 0')
    } finally {
      await pool.query('DELETE FROM attendance_leave_balance_events WHERE user_id LIKE $1', [`c1-${runSuffix}%`]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_leave_balances WHERE user_id LIKE $1', [`c1-${runSuffix}%`]).catch(() => undefined)
      await pool.end().catch(() => undefined)
    }
  })

  it('④/年假 L2a — accrual provenance schema invariants (runs/run_items CHECK·UNIQUE·FK; users service-start column)', async () => {
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return
    const pool = new Pool({ connectionString: dbUrl })
    const runSuffix = Date.now().toString(36)
    const orgId = 'default'
    const userPrefix = `l2a-${runSuffix}`
    const rejects = async (text: string, params: unknown[], code: string, label: string) => {
      let err: { code?: string } | null = null
      try { await pool.query(text, params) } catch (e) { err = e as { code?: string } }
      expect({ label, code: err?.code }).toEqual({ label, code })
    }
    try {
      // The cumulative-service tenure anchor exists on users (never hire_date for cumulative_service mode).
      const col = await pool.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'cumulative_service_start_date'`,
      )
      expect(col.rowCount).toBe(1)

      // runs header CHECK invariants (enum + positive standard day).
      const runInsert = `INSERT INTO attendance_leave_accrual_runs
        (org_id, period_key, leave_type_code, policy_version, tenure_mode, timezone, standard_day_minutes, tiers, triggered_by, as_of)
        VALUES ($1, $2, 'annual', 'v1', $3, 'Asia/Shanghai', $4, '[]'::jsonb, $5, '2026-01-01')`
      await rejects(runInsert, [orgId, `annual:${runSuffix}:a`, 'bogus', 480, 'manual'], '23514', 'tenure_mode must be a valid enum')
      await rejects(runInsert, [orgId, `annual:${runSuffix}:b`, 'cumulative_service', 0, 'manual'], '23514', 'standard_day_minutes must be > 0')
      await rejects(runInsert, [orgId, `annual:${runSuffix}:c`, 'cumulative_service', 480, 'bogus'], '23514', 'triggered_by must be a valid enum')

      // a valid run anchors the run_items checks.
      const run = await pool.query<{ id: string }>(`${runInsert} RETURNING id`, [orgId, `annual:${runSuffix}:ok`, 'cumulative_service', 480, 'manual'])
      const runId = run.rows[0]?.id
      expect(runId).toBeTruthy()

      // a granted run item is valid; its id is the provenance back-link a lot's source_id points to.
      const granted = await pool.query<{ id: string }>(
        `INSERT INTO attendance_leave_accrual_run_items
           (run_id, org_id, user_id, leave_type_code, tenure_years, tier_days, proration_factor, entitlement_minutes, status)
         VALUES ($1, $2, $3, 'annual', 12, 10, NULL, 4800, 'granted') RETURNING id`,
        [runId, orgId, `${userPrefix}-g`],
      )
      expect(granted.rows[0]?.id).toBeTruthy()

      // (1) one computed row per (run, user, leave type) -> a dup is a 23505 unique violation.
      await rejects(
        `INSERT INTO attendance_leave_accrual_run_items (run_id, org_id, user_id, leave_type_code, entitlement_minutes, status)
         VALUES ($1, $2, $3, 'annual', 999, 'granted')`,
        [runId, orgId, `${userPrefix}-g`], '23505', 'one computed row per run/user/leave_type',
      )

      // (2) a dangling run_id -> FK violation (23503).
      await rejects(
        `INSERT INTO attendance_leave_accrual_run_items (run_id, org_id, user_id, leave_type_code, entitlement_minutes, status)
         VALUES ('00000000-0000-4000-8000-000000000000', $1, $2, 'annual', 100, 'granted')`,
        [orgId, `${userPrefix}-fk`], '23503', 'run_id must reference a run',
      )

      // (3) CHECK invariants (23514): status enum, entitlement >= 0, and granted<->no-reason / skipped<->reason.
      const itemInsert = `INSERT INTO attendance_leave_accrual_run_items
        (run_id, org_id, user_id, leave_type_code, entitlement_minutes, status, skip_reason)
        VALUES ($1, $2, $3, 'annual', $4, $5, $6)`
      await rejects(itemInsert, [runId, orgId, `${userPrefix}-s1`, 100, 'bogus', null], '23514', 'status must be a valid enum')
      await rejects(itemInsert, [runId, orgId, `${userPrefix}-s2`, -1, 'granted', null], '23514', 'entitlement_minutes must be >= 0')
      await rejects(itemInsert, [runId, orgId, `${userPrefix}-s3`, 100, 'granted', 'SOME_REASON'], '23514', 'granted row must not carry a skip_reason')
      await rejects(itemInsert, [runId, orgId, `${userPrefix}-s4`, 0, 'skipped', null], '23514', 'skipped row must carry a skip_reason')

      // a skipped row WITH a reason is valid — the provenance always records why it skipped.
      const skipped = await pool.query(itemInsert, [runId, orgId, `${userPrefix}-ok-skip`, 0, 'skipped', 'NOT_ELIGIBLE_UNDER_ONE_YEAR'])
      expect(skipped.rowCount).toBe(1)
    } finally {
      await pool.query(`DELETE FROM attendance_leave_accrual_runs WHERE period_key LIKE $1`, [`annual:${runSuffix}%`]).catch(() => undefined)
      await pool.end().catch(() => undefined)
    }
  })

  it('④/年假 L2b — accrual run: eligibility/tier/§5 proration + skip reasons + provenance + dry-run + idempotency', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return
    const pool = new Pool({ connectionString: dbUrl })
    const runSuffix = Date.now().toString(36)
    const adminId = `al-l2b-admin-${runSuffix}`
    const tokenRes = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${adminId}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`)
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) { await pool.end().catch(() => undefined); return }
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    const U = (tag: string) => `al-l2b-${runSuffix}-${tag}`
    const seedUser = async (tag: string, hireDate: string | null, cumulative: string | null, org = 'default') => {
      const id = U(tag)
      await pool.query(
        `INSERT INTO users (id, email, password_hash, is_active, hire_date, cumulative_service_start_date)
         VALUES ($1, $2, 'no-login', true, $3, $4)
         ON CONFLICT (id) DO UPDATE SET is_active = true, hire_date = EXCLUDED.hire_date, cumulative_service_start_date = EXCLUDED.cumulative_service_start_date`,
        [id, `${id}@example.com`, hireDate, cumulative],
      )
      // org membership — accrual is scoped via user_orgs, so a seeded user only participates in `org`.
      await pool.query(
        `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)
         ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = true`,
        [id, org],
      )
      return id
    }
    const asOf = '2026-12-31'
    const period = 2026
    const origRes = await requestJson(`${baseUrl}/api/attendance/settings`, { headers: { Authorization: `Bearer ${token}` } })
    const origPolicy = ((origRes.body as { data?: { annualLeavePolicy?: Record<string, unknown> } } | undefined)?.data?.annualLeavePolicy) ?? { enabled: false }
    const itemFor = async (runId: string, userId: string) => (await pool.query(
      `SELECT id, status, skip_reason, tenure_years, tier_days, entitlement_minutes FROM attendance_leave_accrual_run_items WHERE run_id = $1 AND user_id = $2`, [runId, userId])).rows[0]
    const lotsFor = async (userId: string) => (await pool.query(
      `SELECT id, amount_minutes, source_id, source_key FROM attendance_leave_balances WHERE user_id = $1 AND leave_type_code = 'annual'`, [userId])).rows
    const runAccrual = (dryRun: boolean) => requestJson(`${baseUrl}/api/attendance/annual-leave-accrual/run`, { method: 'POST', headers, body: JSON.stringify({ period, asOf, dryRun }) })
    try {
      const putRes = await requestJson(`${baseUrl}/api/attendance/settings`, {
        method: 'PUT', headers,
        body: JSON.stringify({ annualLeavePolicy: {
          enabled: true, tenureMode: 'cumulative_service', standardDayMinutes: 480,
          tiers: [{ minYears: 1, maxYears: 10, days: 5 }, { minYears: 10, maxYears: 20, days: 10 }, { minYears: 20, maxYears: null, days: 15 }],
          carryover: { enabled: false }, timezone: 'Asia/Shanghai',
        } }),
      })
      expect(putRes.status, JSON.stringify(putRes.body)).toBe(200)

      const uFull = await seedUser('full', '2010-01-01', '2010-01-01')    // 16yr → tier 10, hired < period → full 10×480 = 4800
      const uPror = await seedUser('pror', '2026-07-01', '2020-01-01')    // 6yr → tier 5, hired 7-1-2026 → 184/365×5 = floor 2 → 960
      const uIneli = await seedUser('ineli', '2026-06-01', '2026-06-01')  // 连续 6mo < 12 as-of 12-31 → NOT_ELIGIBLE
      const uMiss = await seedUser('miss', '2010-01-01', null)            // cumulative mode + null cumulative → MISSING (no hire_date fallback)
      const uTiny = await seedUser('tiny', '2026-12-30', '2020-01-01')    // tier 5, hired 12-30 → 2/365×5 = floor 0 → PRORATION_BELOW_ONE_DAY
      const uBound = await seedUser('bound', '2016-12-31', '2016-12-31')  // exactly 10yr as-of 12-31 → tier 10 (not 5) → 4800
      const uMay27 = await seedUser('may27', '2026-05-27', '2020-01-01')  // tier 5, hired 5-27 → 219 days → 219×5/365 = 3.0 → floor 3 → 1440 (float-floor bug would give 2/960)
      const uFuture = await seedUser('future', '2027-01-01', '2010-01-01') // hire_date after asOf 12-31 → NOT_YET_HIRED
      const uOther = await seedUser('other', '2010-01-01', '2010-01-01', `al-l2b-otherorg-${runSuffix}`) // active in ANOTHER org → must NOT appear in this org's run
      const uMissHire = await seedUser('misshire', null, '2010-01-01') // cumulative present, hire_date null → MISSING_HIRE_DATE (never a silent full-grant)

      // P2: a calendar-invalid asOf is rejected (not silently overflowed by Date.UTC).
      const badAsOfRes = await requestJson(`${baseUrl}/api/attendance/annual-leave-accrual/run`, { method: 'POST', headers, body: JSON.stringify({ period, asOf: '2026-02-31', dryRun: true }) })
      expect(badAsOfRes.status).toBe(400)

      // (A) DRY-RUN → run + run_items persisted, NO lots; consumes no source_key.
      const dryRes = await runAccrual(true)
      expect(dryRes.status, JSON.stringify(dryRes.body)).toBe(200)
      const dryRunId = (dryRes.body as { data?: { runId?: string } } | undefined)?.data?.runId as string
      expect(dryRunId).toBeTruthy()
      expect((await itemFor(dryRunId, uFull))?.status).toBe('granted')
      expect((await lotsFor(uFull)).length).toBe(0)

      // (B) REAL run.
      const realRes = await runAccrual(false)
      expect(realRes.status, JSON.stringify(realRes.body)).toBe(200)
      const realRunId = (realRes.body as { data?: { runId?: string } } | undefined)?.data?.runId as string

      expect(await itemFor(realRunId, uFull)).toMatchObject({ status: 'granted', tier_days: 10, entitlement_minutes: 4800 })
      expect(await itemFor(realRunId, uPror)).toMatchObject({ status: 'granted', tier_days: 5, entitlement_minutes: 960 })
      expect(await itemFor(realRunId, uIneli)).toMatchObject({ status: 'skipped', skip_reason: 'NOT_ELIGIBLE_UNDER_ONE_YEAR' })
      expect(await itemFor(realRunId, uMiss)).toMatchObject({ status: 'skipped', skip_reason: 'MISSING_SERVICE_START_DATE' })
      expect(await itemFor(realRunId, uTiny)).toMatchObject({ status: 'skipped', skip_reason: 'PRORATION_BELOW_ONE_DAY' })
      expect(await itemFor(realRunId, uBound)).toMatchObject({ status: 'granted', tier_days: 10, entitlement_minutes: 4800 })
      // P1 regression: 219 days × tier 5 ÷ 365 = exactly 3.0 days — integer-first must NOT float-floor to 2.
      expect(await itemFor(realRunId, uMay27)).toMatchObject({ status: 'granted', tier_days: 5, entitlement_minutes: 1440 })
      // P3: hire_date after asOf → not yet employed at 本单位.
      expect(await itemFor(realRunId, uFuture)).toMatchObject({ status: 'skipped', skip_reason: 'NOT_YET_HIRED' })
      // P1 (cross-tenant isolation): another org's active user gets NO run_item and NO lot in this org's run.
      expect(await itemFor(realRunId, uOther)).toBeUndefined()
      expect((await lotsFor(uOther)).length).toBe(0)
      // P1 (missing hire_date in cumulative mode → visible skip, never a silent full-grant).
      expect(await itemFor(realRunId, uMissHire)).toMatchObject({ status: 'skipped', skip_reason: 'MISSING_HIRE_DATE' })
      expect((await lotsFor(uMissHire)).length).toBe(0)

      // lots + provenance back-link (lot.source_id → run_item.id).
      const fullLots = await lotsFor(uFull)
      expect(fullLots.length).toBe(1)
      expect(Number(fullLots[0].amount_minutes)).toBe(4800)
      expect(fullLots[0].source_key).toBe(`annual_accrual:${uFull}:annual:${period}`)
      expect(fullLots[0].source_id).toBe((await itemFor(realRunId, uFull)).id)
      expect((await lotsFor(uIneli)).length).toBe(0)
      expect((await lotsFor(uTiny)).length).toBe(0)

      // run header snapshot incl. the new as_of column (≠ occurred_at).
      const hdr = (await pool.query(`SELECT tenure_mode, timezone, standard_day_minutes, dry_run, period_key, as_of::text AS as_of FROM attendance_leave_accrual_runs WHERE id = $1`, [realRunId])).rows[0]
      expect(hdr).toMatchObject({ tenure_mode: 'cumulative_service', timezone: 'Asia/Shanghai', standard_day_minutes: 480, dry_run: false, period_key: `annual:${period}` })
      expect(String(hdr.as_of).slice(0, 10)).toBe(asOf)

      // (C) IDEMPOTENCY: re-run real → still exactly one lot for uFull, and the summary honestly reports
      // ZERO new lots created (P2: granted-grantable is still counted, but lotsCreated reflects the no-op).
      const reRes = await runAccrual(false)
      expect(reRes.status).toBe(200)
      expect((await lotsFor(uFull)).length).toBe(1)
      expect((reRes.body as { data?: { lotsCreated?: number } } | undefined)?.data?.lotsCreated).toBe(0)
    } finally {
      await requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers, body: JSON.stringify({ annualLeavePolicy: origPolicy }) }).catch(() => undefined)
      const ids = ['full', 'pror', 'ineli', 'miss', 'tiny', 'bound', 'may27', 'future', 'other', 'misshire'].map(t => U(t)).concat([adminId])
      await pool.query(`DELETE FROM user_orgs WHERE user_id = ANY($1::text[])`, [ids]).catch(() => undefined)
      await pool.query(`DELETE FROM attendance_leave_balance_events WHERE user_id = ANY($1::text[])`, [ids]).catch(() => undefined)
      await pool.query(`DELETE FROM attendance_leave_balances WHERE user_id = ANY($1::text[])`, [ids]).catch(() => undefined)
      await pool.query(`DELETE FROM attendance_leave_accrual_runs WHERE period_key = $1`, [`annual:${period}`]).catch(() => undefined)
      await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [ids]).catch(() => undefined)
      await pool.end().catch(() => undefined)
    }
  })

  it('④/年假 L4a — accrual lot carries year-end expires_at (first-invalid instant, org-tz); carryover shifts +1yr', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return
    const pool = new Pool({ connectionString: dbUrl })
    const runSuffix = Date.now().toString(36)
    const adminId = `al-l4a-admin-${runSuffix}`
    const org = `al-l4a-org-${runSuffix}` // unique org → accrual enumerates ONLY my seeded users (no cross-test pollution)
    const tokenRes = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${adminId}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`)
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    if (!token) { await pool.end().catch(() => undefined); return }
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    const period = 2026
    const U = (t: string) => `al-l4a-${runSuffix}-${t}`
    const seedUser = async (tag: string) => {
      const id = U(tag)
      await pool.query(`INSERT INTO users (id, email, password_hash, is_active, hire_date, cumulative_service_start_date)
         VALUES ($1,$2,'no-login',true,'2010-01-01','2010-01-01')
         ON CONFLICT (id) DO UPDATE SET is_active=true, hire_date=EXCLUDED.hire_date, cumulative_service_start_date=EXCLUDED.cumulative_service_start_date`, [id, `${id}@example.com`])
      await pool.query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1,$2,true) ON CONFLICT (user_id, org_id) DO UPDATE SET is_active=true`, [id, org])
      return id
    }
    const origRes = await requestJson(`${baseUrl}/api/attendance/settings`, { headers: { Authorization: `Bearer ${token}` } })
    const origPolicy = ((origRes.body as { data?: { annualLeavePolicy?: Record<string, unknown> } } | undefined)?.data?.annualLeavePolicy) ?? { enabled: false }
    const setPolicy = (carryover: boolean) => requestJson(`${baseUrl}/api/attendance/settings`, {
      method: 'PUT', headers,
      body: JSON.stringify({ annualLeavePolicy: { enabled: true, tenureMode: 'cumulative_service', standardDayMinutes: 480, tiers: [{ minYears: 1, maxYears: null, days: 5 }], carryover: { enabled: carryover }, timezone: 'Asia/Shanghai' } }),
    })
    const runAccrual = () => requestJson(`${baseUrl}/api/attendance/annual-leave-accrual/run`, { method: 'POST', headers, body: JSON.stringify({ period, asOf: '2026-12-31', dryRun: false, orgId: org }) })
    const lotExpiry = async (userId: string) => (await pool.query(`SELECT expires_at FROM attendance_leave_balances WHERE user_id=$1 AND leave_type_code='annual' AND source_type='annual_accrual'`, [userId])).rows[0]?.expires_at as Date | null
    const ids: string[] = []
    try {
      // (A) carryover=false → period 2026 usable through end of 2026 → expires Jan 1 2027 00:00 Asia/Shanghai (UTC+8) = 2026-12-31T16:00:00Z.
      const uNoCarry = await seedUser('nocarry'); ids.push(uNoCarry)
      expect((await setPolicy(false)).status).toBe(200)
      expect((await runAccrual()).status, 'accrual A').toBe(200)
      const exp1 = await lotExpiry(uNoCarry)
      expect(exp1, 'no-carry lot exists').toBeTruthy()
      expect(new Date(exp1!).toISOString()).toBe('2026-12-31T16:00:00.000Z')

      // (B) carryover=true → carry through 2027 → expires Jan 1 2028 00:00 Asia/Shanghai = 2027-12-31T16:00:00Z.
      const uCarry = await seedUser('carry'); ids.push(uCarry)
      expect((await setPolicy(true)).status).toBe(200)
      expect((await runAccrual()).status, 'accrual B').toBe(200)
      const exp2 = await lotExpiry(uCarry)
      expect(exp2, 'carry lot exists').toBeTruthy()
      expect(new Date(exp2!).toISOString()).toBe('2027-12-31T16:00:00.000Z')

      // (C) the no-carry lot from run A is idempotent under run B (ON CONFLICT) — its expiry is NOT retroactively changed.
      expect(new Date((await lotExpiry(uNoCarry))!).toISOString()).toBe('2026-12-31T16:00:00.000Z')

      // (D) an enabled policy with an INVALID timezone is rejected at the settings gate (else zonedTimeToUtc would
      // silently UTC-fall-back and stamp the wrong expiry). 422 ANNUAL_LEAVE_TIMEZONE_INVALID — never guess.
      const badTz = await requestJson(`${baseUrl}/api/attendance/settings`, {
        method: 'PUT', headers,
        body: JSON.stringify({ annualLeavePolicy: { enabled: true, tenureMode: 'cumulative_service', standardDayMinutes: 480, tiers: [{ minYears: 1, maxYears: null, days: 5 }], carryover: { enabled: false }, timezone: 'Not/AZone' } }),
      })
      expect(badTz.status).toBe(422)
      expect((badTz.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('ANNUAL_LEAVE_TIMEZONE_INVALID')
    } finally {
      await requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers, body: JSON.stringify({ annualLeavePolicy: origPolicy }) }).catch(() => undefined)
      const all = ids.concat([adminId])
      await pool.query(`DELETE FROM attendance_leave_balance_events WHERE user_id = ANY($1::text[])`, [all]).catch(() => undefined)
      await pool.query(`DELETE FROM attendance_leave_balances WHERE user_id = ANY($1::text[])`, [all]).catch(() => undefined)
      await pool.query(`DELETE FROM attendance_leave_accrual_runs WHERE org_id = $1`, [org]).catch(() => undefined)
      await pool.query(`DELETE FROM user_orgs WHERE user_id = ANY($1::text[])`, [all]).catch(() => undefined)
      await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [all]).catch(() => undefined)
      await pool.end().catch(() => undefined)
    }
  })

  it('④/年假 L4b — provenance-snapshot expires_at backfill: idempotent, dryRun, auditable skip reasons', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return
    const pool = new Pool({ connectionString: dbUrl })
    const runSuffix = Date.now().toString(36)
    const adminId = `al-l4b-admin-${runSuffix}`
    const org = `al-l4b-org-${runSuffix}` // unique org → backfill scans ONLY my lots
    const tokenRes = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${adminId}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`)
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    if (!token) { await pool.end().catch(() => undefined); return }
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    const pvOf = (carryover: boolean, tz = 'Asia/Shanghai') => JSON.stringify({ tenureMode: 'cumulative_service', standardDayMinutes: 480, tiers: [], timezone: tz, carryover: { enabled: carryover } })
    const mkRun = async (policyVersion: string, periodKey = 'annual:2026', timezone = 'Asia/Shanghai', dryRunFlag = false) => (await pool.query<{ id: string }>(
      `INSERT INTO attendance_leave_accrual_runs (org_id, period_key, leave_type_code, policy_version, tenure_mode, timezone, standard_day_minutes, tiers, triggered_by, dry_run, as_of)
       VALUES ($1,$2,'annual',$3,'cumulative_service',$4,480,'[]'::jsonb,'manual',$5,'2026-01-01') RETURNING id`, [org, periodKey, policyVersion, timezone, dryRunFlag])).rows[0].id
    const mkRunItem = async (runId: string, userId: string, status = 'granted', skipReason: string | null = null) => (await pool.query<{ id: string }>(
      `INSERT INTO attendance_leave_accrual_run_items (run_id, org_id, user_id, leave_type_code, tenure_years, tier_days, proration_factor, entitlement_minutes, status, skip_reason)
       VALUES ($1,$2,$3,'annual',5,5,1,2400,$4,$5) RETURNING id`, [runId, org, userId, status, skipReason])).rows[0].id
    const mkLot = async (userId: string, sourceId: string | null, tag: string) => (await pool.query<{ id: string }>(
      `INSERT INTO attendance_leave_balances (org_id, user_id, leave_type_code, amount_minutes, remaining_minutes, source_type, source_id, source_key, status, granted_at, expires_at)
       VALUES ($1,$2,'annual',2400,2400,'annual_accrual',$3,$4,'active','2026-01-01',NULL) RETURNING id`, [org, userId, sourceId, `l4b:${runSuffix}:${tag}`])).rows[0].id
    const expiryOf = async (lotId: string) => (await pool.query(`SELECT expires_at FROM attendance_leave_balances WHERE id=$1`, [lotId])).rows[0]?.expires_at as Date | null
    const backfill = (dryRun: boolean) => requestJson(`${baseUrl}/api/attendance/annual-leave-expiry-backfill`, { method: 'POST', headers, body: JSON.stringify({ dryRun, orgId: org }) })
    const ids: string[] = []
    const seed = (tag: string) => { const id = `al-l4b-${runSuffix}-${tag}`; ids.push(id); return id }
    try {
      // good lots (recoverable provenance):
      const uA = seed('a'); const lotA = await mkLot(uA, await mkRunItem(await mkRun(pvOf(false)), uA), 'a')   // carryover=false → Jan1 2027
      const uB = seed('b'); const lotB = await mkLot(uB, await mkRunItem(await mkRun(pvOf(true)), uB), 'b')    // carryover=true  → Jan1 2028
      // unrecoverable lots → must skip with a reason, stay NULL (grandfather, never guess):
      const uMI = seed('mi'); const lotMI = await mkLot(uMI, '00000000-0000-4000-8000-000000000000', 'mi')     // source_id resolves to no run_item
      const uPv = seed('pv'); const lotPv = await mkLot(uPv, await mkRunItem(await mkRun('not-json'), uPv), 'pv') // unparseable policy_version
      const uTz = seed('tz'); const lotTz = await mkLot(uTz, await mkRunItem(await mkRun(pvOf(false), 'annual:2026', ''), uTz), 'tz') // empty timezone
      const uPk = seed('pk'); const lotPk = await mkLot(uPk, await mkRunItem(await mkRun(pvOf(false), 'annual:bad'), uPk), 'pk')       // unparseable period_key
      // wrong provenance shape → NOT a recoverable grant snapshot (never guess from mismatched provenance):
      const uSk = seed('sk'); const lotSk = await mkLot(uSk, await mkRunItem(await mkRun(pvOf(false)), uSk, 'skipped', 'NO_MATCHING_TIER'), 'sk') // run_item not 'granted' → INVALID_RUN_ITEM
      const uDry = seed('dry'); const lotDry = await mkLot(uDry, await mkRunItem(await mkRun(pvOf(false), 'annual:2026', 'Asia/Shanghai', true), uDry), 'dry') // dry-run run → INVALID_RUN

      // (A) dryRun → previews 2 updatable, writes nothing.
      const dry = await backfill(true)
      expect(dry.status, JSON.stringify(dry.body)).toBe(200)
      const dryData = (dry.body as { data?: { scanned?: number; updated?: number; skipped?: number; dryRun?: boolean } } | undefined)?.data
      expect(dryData).toMatchObject({ scanned: 8, updated: 2, skipped: 6, dryRun: true })
      expect(await expiryOf(lotA)).toBeNull() // dryRun wrote nothing

      // (B) real backfill → 2 updated to the provenance-derived expiry, 4 skipped with auditable reasons.
      const real = await backfill(false)
      expect(real.status, JSON.stringify(real.body)).toBe(200)
      const realData = (real.body as { data?: { updated?: number; skipped?: number; reasons?: Record<string, number> } } | undefined)?.data
      expect(realData).toMatchObject({ scanned: 8, updated: 2, skipped: 6 })
      expect(realData?.reasons).toMatchObject({ MISSING_RUN_ITEM: 1, UNPARSEABLE_POLICY_VERSION: 1, MISSING_TIMEZONE: 1, UNPARSEABLE_PERIOD_KEY: 1, INVALID_RUN_ITEM: 1, INVALID_RUN: 1 })
      expect(new Date((await expiryOf(lotA))!).toISOString()).toBe('2026-12-31T16:00:00.000Z') // carryover=false → Jan 1 2027 CST
      expect(new Date((await expiryOf(lotB))!).toISOString()).toBe('2027-12-31T16:00:00.000Z') // carryover=true  → Jan 1 2028 CST
      for (const l of [lotMI, lotPv, lotTz, lotPk, lotSk, lotDry]) expect(await expiryOf(l)).toBeNull() // grandfathered, never guessed

      // (C) idempotent re-run → the 2 good lots are now excluded (expires_at set); only the 4 unrecoverable remain, re-skipped.
      const again = await backfill(false)
      const againData = (again.body as { data?: { scanned?: number; updated?: number; skipped?: number } } | undefined)?.data
      expect(againData).toMatchObject({ scanned: 6, updated: 0, skipped: 6 })
    } finally {
      await pool.query(`DELETE FROM attendance_leave_balances WHERE org_id = $1`, [org]).catch(() => undefined)
      await pool.query(`DELETE FROM attendance_leave_accrual_run_items WHERE org_id = $1`, [org]).catch(() => undefined)
      await pool.query(`DELETE FROM attendance_leave_accrual_runs WHERE org_id = $1`, [org]).catch(() => undefined)
      await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [ids.concat([adminId])]).catch(() => undefined)
      await pool.end().catch(() => undefined)
    }
  })

  it('④/年假 L2c — manual adjustment: positive lot+grant / negative FIFO-deduct / insufficient-422-rollback / idempotency / delta-0 / org-scoping', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return
    const pool = new Pool({ connectionString: dbUrl })
    const runSuffix = Date.now().toString(36)
    const adminId = `al-l2c-admin-${runSuffix}`
    const previousRbacBypass = process.env.RBAC_BYPASS
    const tokenRes = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${adminId}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`)
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) { await pool.end().catch(() => undefined); return }
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    const U = (tag: string) => `al-l2c-${runSuffix}-${tag}`
    const seedUser = async (tag: string, org = 'default') => {
      const id = U(tag)
      await pool.query(
        `INSERT INTO users (id, email, password_hash, is_active) VALUES ($1, $2, 'no-login', true)
         ON CONFLICT (id) DO UPDATE SET is_active = true`,
        [id, `${id}@example.com`],
      )
      await pool.query(
        `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)
         ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = true`,
        [id, org],
      )
      return id
    }
    const adjust = (body: Record<string, unknown>) => requestJson(`${baseUrl}/api/attendance/annual-leave-manual-adjustment`, { method: 'POST', headers, body: JSON.stringify(body) })
    const lotsFor = async (userId: string) => (await pool.query(
      `SELECT id, amount_minutes, remaining_minutes, source_type, source_id, source_key, status FROM attendance_leave_balances WHERE user_id = $1 AND leave_type_code = 'annual' ORDER BY created_at`, [userId])).rows
    // NOTE: id is a random uuid (gen_random_uuid) → ORDER BY id is NOT insertion order. Order deterministically
    // by occurred_at, and (decisively) assert events by event_type below, never by array position.
    const eventsFor = async (userId: string) => (await pool.query(
      `SELECT event_type, delta_minutes, source_type, source_id FROM attendance_leave_balance_events WHERE user_id = $1 ORDER BY occurred_at, event_type`, [userId])).rows
    const eventsOfType = (rows: Array<{ event_type?: string }>, type: string) => rows.filter((e) => e.event_type === type)
    const regFor = async (sourceKey: string) => (await pool.query(
      `SELECT id, delta_minutes, reason, created_by, run_id, source_key FROM attendance_leave_manual_adjustments WHERE org_id = 'default' AND source_key = $1`, [sourceKey])).rows[0]
    const otherOrg = `al-l2c-otherorg-${runSuffix}`
    // a user that IS an active member of the caller's org but is globally is_active=false (offboarded):
    // manual adjustment must share the L2b accrual population, so this is out of scope (404), not adjustable.
    const seedInactive = async (tag: string) => {
      const id = U(tag)
      await pool.query(`INSERT INTO users (id, email, password_hash, is_active) VALUES ($1, $2, 'no-login', false)
         ON CONFLICT (id) DO UPDATE SET is_active = false`, [id, `${id}@example.com`])
      await pool.query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, 'default', true)
         ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = true`, [id])
      return id
    }
    try {
      // The acting admin is intentionally NOT added to user_orgs. withPermission('attendance:admin') is a global
      // RBAC gate in the current model; user_orgs is target membership, not an actor org-admin scope.
      process.env.RBAC_BYPASS = 'false'
      await pool.query(`INSERT INTO users (id, email, password_hash, is_active) VALUES ($1, $2, 'no-login', true)
         ON CONFLICT (id) DO UPDATE SET is_active = true`, [adminId, `${adminId}@example.com`])
      await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`, [adminId])
      const uPos = await seedUser('pos')
      const uOther = await seedUser('other', otherOrg)
      const uInactive = await seedInactive('inactive')

      // (E) delta = 0 → 400, before any side effect.
      const zeroRes = await adjust({ userId: uPos, deltaMinutes: 0, reason: 'noop' })
      expect(zeroRes.status).toBe(400)
      expect((zeroRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('ANNUAL_LEAVE_ADJUST_DELTA_INVALID')

      // (F) org-scoping: a user that is only in ANOTHER org → 404, with NO registry row and NO lot. Without the
      // membership guard an org-default admin could mint annual-leave lots against a foreign-tenant user id.
      const crossRes = await adjust({ userId: uOther, deltaMinutes: 1200, reason: 'cross', idempotencyKey: 'k-cross' })
      expect(crossRes.status).toBe(404)
      expect((crossRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('USER_NOT_IN_ORG')
      expect(await regFor('annual_manual_adjust:k-cross')).toBeUndefined()
      expect((await lotsFor(uOther)).length).toBe(0)

      // (G) globally-inactive (offboarded) user, even though still an active org member → 404, no row/lot.
      // Locks the choice that manual-adjust shares the L2b accrual population (u.is_active required).
      const inactiveRes = await adjust({ userId: uInactive, deltaMinutes: 1200, reason: 'gone', idempotencyKey: 'k-inactive' })
      expect(inactiveRes.status).toBe(404)
      expect((inactiveRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('USER_NOT_IN_ORG')
      expect(await regFor('annual_manual_adjust:k-inactive')).toBeUndefined()
      expect((await lotsFor(uInactive)).length).toBe(0)

      // (H) staging-grounded RBAC shape: an attendance:admin actor does NOT need user_orgs membership. The route's
      // permission guard is global today; the endpoint's tenant boundary is target-in-claimed-org. This locks the
      // staging precondition that real admins without user_orgs membership are not accidentally 403'd.
      const foreignRes = await adjust({ userId: uOther, deltaMinutes: 1200, reason: 'escalate', idempotencyKey: 'k-foreign', orgId: otherOrg })
      expect(foreignRes.status, JSON.stringify(foreignRes.body)).toBe(200)
      const foreignReg = (await pool.query(
        `SELECT id, delta_minutes, org_id, user_id FROM attendance_leave_manual_adjustments WHERE source_key = $1`,
        ['annual_manual_adjust:k-foreign'],
      )).rows[0]
      expect(foreignReg).toMatchObject({ org_id: otherOrg, user_id: uOther, delta_minutes: 1200 })
      expect((await lotsFor(uOther)).length).toBe(1)

      // (A) positive → a new annual_manual_adjustment lot + grant event + registry row; lot back-links to the
      // registry id (source_id) and uses a derived source_key.
      const posRes = await adjust({ userId: uPos, deltaMinutes: 2400, reason: 'bonus grant', idempotencyKey: 'k-pos' })
      expect(posRes.status, JSON.stringify(posRes.body)).toBe(200)
      expect((posRes.body as { data?: { applied?: boolean } } | undefined)?.data?.applied).toBe(true)
      const reg = await regFor('annual_manual_adjust:k-pos')
      expect(reg).toMatchObject({ delta_minutes: 2400, reason: 'bonus grant', created_by: adminId })
      const lots1 = await lotsFor(uPos)
      expect(lots1.length).toBe(1)
      expect(lots1[0]).toMatchObject({ source_type: 'annual_manual_adjust', status: 'active' })
      expect(Number(lots1[0].amount_minutes)).toBe(2400)
      expect(Number(lots1[0].remaining_minutes)).toBe(2400)
      expect(lots1[0].source_id).toBe(reg.id)
      expect(lots1[0].source_key).toBe(`annual_manual_adjust:${reg.id}`)
      const ev1 = await eventsFor(uPos)
      expect(ev1.length).toBe(1)
      const grants1 = eventsOfType(ev1, 'grant')
      expect(grants1.length).toBe(1)
      expect(grants1[0]).toMatchObject({ source_type: 'annual_manual_adjust' })
      expect(Number((grants1[0] as { delta_minutes: number }).delta_minutes)).toBe(2400)

      // (B) idempotency: replay the SAME idempotencyKey → no-op (applied:false / alreadyApplied:true); still
      // exactly one lot, one grant event, one registry row.
      const replayRes = await adjust({ userId: uPos, deltaMinutes: 2400, reason: 'bonus grant', idempotencyKey: 'k-pos' })
      expect(replayRes.status).toBe(200)
      expect((replayRes.body as { data?: { applied?: boolean; alreadyApplied?: boolean } } | undefined)?.data).toMatchObject({ applied: false, alreadyApplied: true })
      expect((await lotsFor(uPos)).length).toBe(1)
      expect((await eventsFor(uPos)).length).toBe(1)

      // (B2) P2a idempotency CONFLICT: the same key 'k-pos' reused with a DIFFERENT amount must NOT silently
      // succeed — it returns 409 and writes nothing new (the original 2400 lot is untouched).
      const conflictRes = await adjust({ userId: uPos, deltaMinutes: 1200, reason: 'bonus grant', idempotencyKey: 'k-pos' })
      expect(conflictRes.status).toBe(409)
      expect((conflictRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('ANNUAL_LEAVE_ADJUST_IDEMPOTENCY_CONFLICT')
      expect((await lotsFor(uPos)).length).toBe(1)
      expect((await eventsFor(uPos)).length).toBe(1)
      expect(Number((await lotsFor(uPos))[0].remaining_minutes)).toBe(2400)

      // (C) negative (sufficient) → FIFO-deduct the active lot + a deduct event (delta_minutes negative); remaining drops.
      const negRes = await adjust({ userId: uPos, deltaMinutes: -1000, reason: 'correction', idempotencyKey: 'k-neg' })
      expect(negRes.status, JSON.stringify(negRes.body)).toBe(200)
      expect((negRes.body as { data?: { applied?: boolean } } | undefined)?.data?.applied).toBe(true)
      const lots2 = await lotsFor(uPos)
      expect(lots2.length).toBe(1)
      expect(Number(lots2[0].remaining_minutes)).toBe(1400)
      const ev2 = await eventsFor(uPos)
      expect(ev2.length).toBe(2)
      // assert by type, NOT array position (event id is a random uuid → order is not insertion order).
      const deducts2 = eventsOfType(ev2, 'deduct')
      expect(deducts2.length).toBe(1)
      expect(deducts2[0]).toMatchObject({ source_type: 'annual_manual_adjust' })
      expect(Number((deducts2[0] as { delta_minutes: number }).delta_minutes)).toBe(-1000)
      // the original grant is still present and unchanged.
      const grants2 = eventsOfType(ev2, 'grant')
      expect(grants2.length).toBe(1)
      expect(Number((grants2[0] as { delta_minutes: number }).delta_minutes)).toBe(2400)
      expect(await regFor('annual_manual_adjust:k-neg')).toMatchObject({ delta_minutes: -1000 })

      // (D) negative insufficient → 422 + the WHOLE txn rolls back: no registry row, remaining unchanged, no new event.
      const overRes = await adjust({ userId: uPos, deltaMinutes: -99999, reason: 'too much', idempotencyKey: 'k-over' })
      expect(overRes.status).toBe(422)
      expect((overRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('ANNUAL_LEAVE_BALANCE_INSUFFICIENT')
      expect(await regFor('annual_manual_adjust:k-over')).toBeUndefined()
      expect(Number((await lotsFor(uPos))[0].remaining_minutes)).toBe(1400)
      expect((await eventsFor(uPos)).length).toBe(2)

      // (I) P2b runId provenance guard. Build a real (non-dry) and a dry-run accrual run in this org.
      const mkRun = async (dry: boolean) => (await pool.query<{ id: string }>(
        `INSERT INTO attendance_leave_accrual_runs
           (org_id, period_key, leave_type_code, policy_version, tenure_mode, timezone, standard_day_minutes, tiers, triggered_by, dry_run, as_of)
         VALUES ('default', $1, 'annual', 'v1', 'cumulative_service', 'Asia/Shanghai', 480, '[]'::jsonb, 'manual', $2, '2026-01-01')
         RETURNING id`, [`annual:l2c:${runSuffix}:${dry ? 'dry' : 'real'}`, dry])).rows[0].id
      const realRunId = await mkRun(false)
      const dryRunId = await mkRun(true)
      // valid real run → linked (registry.run_id back-references it).
      const runOkRes = await adjust({ userId: uPos, deltaMinutes: 600, reason: 'linked', idempotencyKey: 'k-run', runId: realRunId })
      expect(runOkRes.status, JSON.stringify(runOkRes.body)).toBe(200)
      expect((await regFor('annual_manual_adjust:k-run'))?.run_id).toBe(realRunId)
      // dry-run accrual run → rejected (a correction must reference a real run).
      const runDryRes = await adjust({ userId: uPos, deltaMinutes: 600, reason: 'x', idempotencyKey: 'k-dry', runId: dryRunId })
      expect(runDryRes.status).toBe(422)
      expect((runDryRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('ANNUAL_LEAVE_ADJUST_RUN_NOT_FOUND')
      expect(await regFor('annual_manual_adjust:k-dry')).toBeUndefined()
      // non-existent run id (valid uuid shape) → rejected.
      const runBadRes = await adjust({ userId: uPos, deltaMinutes: 600, reason: 'x', idempotencyKey: 'k-badrun', runId: '00000000-0000-4000-8000-000000000000' })
      expect(runBadRes.status).toBe(422)
      expect((runBadRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('ANNUAL_LEAVE_ADJUST_RUN_NOT_FOUND')
      expect(await regFor('annual_manual_adjust:k-badrun')).toBeUndefined()

      // (J) input guards: deltaMinutes beyond int32 → 400 (clean reject, not a DB overflow 500); over-long reason → 400.
      const bigDeltaRes = await adjust({ userId: uPos, deltaMinutes: 3000000000, reason: 'x' })
      expect(bigDeltaRes.status).toBe(400)
      const longReasonRes = await adjust({ userId: uPos, deltaMinutes: 60, reason: 'a'.repeat(501) })
      expect(longReasonRes.status).toBe(400)
    } finally {
      const ids = ['pos', 'other', 'inactive'].map(t => U(t)).concat([adminId])
      await pool.query(`DELETE FROM attendance_leave_manual_adjustments WHERE user_id = ANY($1::text[])`, [ids]).catch(() => undefined)
      await pool.query(`DELETE FROM attendance_leave_balance_events WHERE user_id = ANY($1::text[])`, [ids]).catch(() => undefined)
      await pool.query(`DELETE FROM attendance_leave_balances WHERE user_id = ANY($1::text[])`, [ids]).catch(() => undefined)
      await pool.query(`DELETE FROM attendance_leave_accrual_runs WHERE period_key LIKE $1`, [`annual:l2c:${runSuffix}%`]).catch(() => undefined)
      await pool.query(`DELETE FROM user_roles WHERE user_id = $1`, [adminId]).catch(() => undefined)
      await pool.query(`DELETE FROM user_orgs WHERE user_id = ANY($1::text[])`, [ids]).catch(() => undefined)
      await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [ids]).catch(() => undefined)
      if (previousRbacBypass === undefined) delete process.env.RBAC_BYPASS
      else process.env.RBAC_BYPASS = previousRbacBypass
      await pool.end().catch(() => undefined)
    }
  })

  it('④/年假 L5a — admin balance/ledger read: summary (granted/remaining/exhausted/expired) + active lots + recent events', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return
    const pool = new Pool({ connectionString: dbUrl })
    const runSuffix = Date.now().toString(36)
    const adminId = `al-l5a-admin-${runSuffix}`
    const uid = `al-l5a-user-${runSuffix}`
    const uOther = `al-l5a-other-${runSuffix}`
    const tokenRes = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${adminId}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`)
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    if (!token) { await pool.end().catch(() => undefined); return }
    const headers = { Authorization: `Bearer ${token}` }
    // Build a known annual balance directly: an ACTIVE lot (4800 granted, 1800 deducted → 3000 remaining) + an
    // EXPIRED lot (480 granted, 480 expired). So granted=5280, remaining=3000, exhausted=1800, expired=480
    // (conservation: granted = remaining + exhausted + expired).
    const mkLot = async (amount: number, remaining: number, status: string, expiresAt: string | null, tag: string) => (await pool.query<{ id: string }>(
      `INSERT INTO attendance_leave_balances (org_id, user_id, leave_type_code, amount_minutes, remaining_minutes, source_type, source_key, status, granted_at, expires_at)
       VALUES ('default',$1,'annual',$2,$3,'annual_accrual',$4,$5,'2026-01-01',$6) RETURNING id`,
      [uid, amount, remaining, `l5a:${runSuffix}:${tag}`, status, expiresAt])).rows[0].id
    const mkEvent = async (balanceId: string, type: string, delta: number) => { await pool.query(
      `INSERT INTO attendance_leave_balance_events (org_id, user_id, balance_id, event_type, delta_minutes, source_type, source_id)
       VALUES ('default',$1,$2,$3,$4,'annual_accrual',$5)`, [uid, balanceId, type, delta, balanceId]) }
    try {
      const lotActive = await mkLot(4800, 3000, 'active', '2026-12-31T16:00:00Z', 'active')
      await mkEvent(lotActive, 'grant', 4800); await mkEvent(lotActive, 'deduct', -1800)
      const lotExpired = await mkLot(480, 0, 'expired', '2025-12-31T16:00:00Z', 'expired')
      await mkEvent(lotExpired, 'grant', 480); await mkEvent(lotExpired, 'expire', -480)

      const res = await requestJson(`${baseUrl}/api/attendance/leave-balances?userId=${encodeURIComponent(uid)}`, { headers })
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      const data = (res.body as { data?: { summary?: Record<string, unknown>; activeLots?: Array<Record<string, unknown>>; recentEvents?: Array<Record<string, unknown>> } } | undefined)?.data
      expect(data?.summary).toMatchObject({ leaveTypeCode: 'annual', grantedMinutes: 5280, remainingMinutes: 3000, exhaustedMinutes: 1800, expiredMinutes: 480 })
      // only the ACTIVE lot is returned in activeLots
      expect(data?.activeLots?.length).toBe(1)
      expect(Number((data!.activeLots![0] as { remaining_minutes: number }).remaining_minutes)).toBe(3000)
      expect(data!.activeLots![0].status).toBe('active')
      // all 4 ledger events are present (explains the balance), asserted by SET not order (occurred_at ties → uuid id).
      expect(data?.recentEvents?.length).toBe(4)
      expect((data!.recentEvents! as Array<{ event_type: string }>).map(e => e.event_type).sort()).toEqual(['deduct', 'expire', 'grant', 'grant'])
      // eventLimit caps the ledger.
      const limited = await requestJson(`${baseUrl}/api/attendance/leave-balances?userId=${encodeURIComponent(uid)}&eventLimit=2`, { headers })
      expect((limited.body as { data?: { recentEvents?: unknown[] } } | undefined)?.data?.recentEvents?.length).toBe(2)
      // missing userId → 400.
      const bad = await requestJson(`${baseUrl}/api/attendance/leave-balances`, { headers })
      expect(bad.status).toBe(400)

      // (reverse) an event whose org/user match the query but whose LOT belongs to a DIFFERENT user must be IGNORED —
      // the read is org/user-consistent by construction (the FK only ties balance_id), not just by writer discipline.
      // Without the `b.org_id=e.org_id AND b.user_id=e.user_id` join predicate this +9999 grant would inflate granted.
      const otherLot = (await pool.query<{ id: string }>(
        `INSERT INTO attendance_leave_balances (org_id, user_id, leave_type_code, amount_minutes, remaining_minutes, source_type, source_key, status, granted_at)
         VALUES ('default',$1,'annual',9999,9999,'annual_accrual',$2,'active','2026-01-01') RETURNING id`, [uOther, `l5a:${runSuffix}:other`])).rows[0].id
      await pool.query(
        `INSERT INTO attendance_leave_balance_events (org_id, user_id, balance_id, event_type, delta_minutes, source_type, source_id)
         VALUES ('default',$1,$2,'grant',9999,'annual_accrual',$3)`, [uid, otherLot, otherLot])
      const after = await requestJson(`${baseUrl}/api/attendance/leave-balances?userId=${encodeURIComponent(uid)}`, { headers })
      expect((after.body as { data?: { summary?: { grantedMinutes?: number } } } | undefined)?.data?.summary?.grantedMinutes).toBe(5280) // mismatched +9999 excluded
      expect((after.body as { data?: { recentEvents?: unknown[] } } | undefined)?.data?.recentEvents?.length).toBe(4)
    } finally {
      await pool.query(`DELETE FROM attendance_leave_balance_events WHERE user_id = ANY($1::text[])`, [[uid, uOther]]).catch(() => undefined)
      await pool.query(`DELETE FROM attendance_leave_balances WHERE user_id = ANY($1::text[])`, [[uid, uOther]]).catch(() => undefined)
      await pool.end().catch(() => undefined)
    }
  })

  it('④/年假 /me — employee self-read: subject is the token; neither a userId param nor an x-user-id header can read another user', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return
    const pool = new Pool({ connectionString: dbUrl })
    const runSuffix = Date.now().toString(36)
    const meId = `al-me-${runSuffix}`
    const otherId = `al-me-other-${runSuffix}`
    // an EMPLOYEE token (attendance:read, NOT admin)
    const tokenRes = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${meId}&roles=employee&perms=attendance:read`)
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    if (!token) { await pool.end().catch(() => undefined); return }
    const headers = { Authorization: `Bearer ${token}` }
    const mkLot = async (uid: string, amount: number, remaining: number, tag: string) => (await pool.query<{ id: string }>(
      `INSERT INTO attendance_leave_balances (org_id, user_id, leave_type_code, amount_minutes, remaining_minutes, source_type, source_key, status, granted_at)
       VALUES ('default',$1,'annual',$2,$3,'annual_accrual',$4,'active','2026-01-01') RETURNING id`,
      [uid, amount, remaining, `me:${runSuffix}:${tag}`])).rows[0].id
    const mkEvent = async (uid: string, balanceId: string, delta: number) => { await pool.query(
      `INSERT INTO attendance_leave_balance_events (org_id, user_id, balance_id, event_type, delta_minutes, source_type, source_id)
       VALUES ('default',$1,$2,'grant',$3,'annual_accrual',$4)`, [uid, balanceId, delta, balanceId]) }
    try {
      // the caller has 2400; ANOTHER user has 9999 the caller must NEVER be able to read
      const myLot = await mkLot(meId, 2400, 2400, 'mine'); await mkEvent(meId, myLot, 2400)
      const otherLot = await mkLot(otherId, 9999, 9999, 'other'); await mkEvent(otherId, otherLot, 9999)

      // (1) /me returns the caller's OWN balance (subject from the token; no userId param exists on this route)
      const mine = await requestJson(`${baseUrl}/api/attendance/leave-balances/me`, { headers })
      expect(mine.status, JSON.stringify(mine.body)).toBe(200)
      const d1 = (mine.body as { data?: { userId?: string; summary?: { grantedMinutes?: number; remainingMinutes?: number } } } | undefined)?.data
      expect(d1?.userId).toBe(meId)
      expect(d1?.summary?.grantedMinutes).toBe(2400)
      expect(d1?.summary?.remainingMinutes).toBe(2400)

      // (2) a userId QUERY PARAM cannot override the subject → still the caller's 2400, never the other's 9999
      const spoofParam = await requestJson(`${baseUrl}/api/attendance/leave-balances/me?userId=${encodeURIComponent(otherId)}`, { headers })
      expect(spoofParam.status).toBe(200)
      const d2 = (spoofParam.body as { data?: { userId?: string; summary?: { grantedMinutes?: number } } } | undefined)?.data
      expect(d2?.userId).toBe(meId)
      expect(d2?.summary?.grantedMinutes).toBe(2400)

      // (3) an x-user-id HEADER cannot override the authenticated subject either
      const spoofHeader = await requestJson(`${baseUrl}/api/attendance/leave-balances/me`, { headers: { ...headers, 'x-user-id': otherId } })
      expect(spoofHeader.status).toBe(200)
      const d3 = (spoofHeader.body as { data?: { userId?: string; summary?: { grantedMinutes?: number } } } | undefined)?.data
      expect(d3?.userId).toBe(meId)
      expect(d3?.summary?.grantedMinutes).toBe(2400)
    } finally {
      await pool.query(`DELETE FROM attendance_leave_balance_events WHERE user_id = ANY($1::text[])`, [[meId, otherId]]).catch(() => undefined)
      await pool.query(`DELETE FROM attendance_leave_balances WHERE user_id = ANY($1::text[])`, [[meId, otherId]]).catch(() => undefined)
      await pool.end().catch(() => undefined)
    }
  })

  it('A2 auto-shift auto-write ledger — active-run claim and item invariants are DB-enforced (latent schema)', async () => {
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return
    const pool = new Pool({ connectionString: dbUrl })
    const runSuffix = Date.now().toString(36)
    const orgId = `a2-ledger-${runSuffix}`
    const userId = `a2-user-${runSuffix}`
    const targetFrom = '2026-06-15'
    const targetTo = '2026-06-16'
    let runId: string | undefined
    const rejects = async (text: string, params: unknown[], code: string, label: string) => {
      let err: { code?: string } | null = null
      try { await pool.query(text, params) } catch (e) { err = e as { code?: string } }
      expect({ label, code: err?.code }).toEqual({ label, code })
    }
    try {
      await requireAttendanceTable(pool, 'attendance_auto_shift_auto_write_runs')
      await requireAttendanceTable(pool, 'attendance_auto_shift_auto_write_run_items')

      const runInsert = `INSERT INTO attendance_auto_shift_auto_write_runs
        (org_id, source, status, target_from, target_to, config_snapshot)
        VALUES ($1, 'scheduler', 'running', $2, $3, '{"autoWrite":{"enabled":true}}'::jsonb)
        RETURNING id`
      const insertedRun = await pool.query(runInsert, [orgId, targetFrom, targetTo])
      runId = insertedRun.rows[0]?.id as string | undefined
      expect(runId).toBeTruthy()

      // The partial UNIQUE claim prevents a second in-flight scheduler run for the same org/source/window.
      await rejects(runInsert, [orgId, targetFrom, targetTo], '23505', 'duplicate running window must be rejected')

      // The same window can be represented after the prior run is terminal; the active claim is running-only.
      const finishedRun = await pool.query(
        `INSERT INTO attendance_auto_shift_auto_write_runs
           (org_id, source, status, target_from, target_to, config_snapshot, finished_at)
         VALUES ($1, 'scheduler', 'succeeded', $2, $3, '{}'::jsonb, now())
         RETURNING id`,
        [orgId, targetFrom, targetTo],
      )
      expect(finishedRun.rows[0]?.id).toBeTruthy()

      const itemInsert = `INSERT INTO attendance_auto_shift_auto_write_run_items
        (run_id, org_id, user_id, work_date, candidate_shift_id, confidence, status, assignment_id, evidence_event_ids)
        VALUES ($1, $2, $3, $4, '00000000-0000-4000-8000-000000000111', 'high', 'applied',
                '00000000-0000-4000-8000-000000000222', '[]'::jsonb)
        RETURNING id`
      const item = await pool.query(itemInsert, [runId, orgId, userId, targetFrom])
      expect(item.rows[0]?.id).toBeTruthy()
      await rejects(itemInsert, [runId, orgId, userId, targetFrom], '23505', 'duplicate item user/day must be rejected')

      await rejects(
        `INSERT INTO attendance_auto_shift_auto_write_run_items
           (run_id, org_id, user_id, work_date, status, reason)
         VALUES ('00000000-0000-4000-8000-000000000333', $1, $2, $3, 'skipped', 'no candidate')`,
        [orgId, `${userId}-fk`, targetFrom],
        '23503',
        'run_id must reference a real run',
      )
      await rejects(
        `INSERT INTO attendance_auto_shift_auto_write_run_items
           (run_id, org_id, user_id, work_date, status, reason)
         VALUES ($1, $2, $3, $4, 'skipped', 'wrong tenant')`,
        [runId, `${orgId}-other`, `${userId}-tenant`, targetFrom],
        '23503',
        'item org_id must match parent run org_id',
      )

      const badRunInsert = `INSERT INTO attendance_auto_shift_auto_write_runs
        (org_id, source, status, target_from, target_to, config_snapshot, scanned_count, finished_at)
        VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $6, $7)`
      await rejects(badRunInsert, [orgId, 'scheduler-bad-status', 'bogus', targetFrom, targetTo, 0, new Date()], '23514', 'run status enum must be valid')
      await rejects(badRunInsert, [orgId, 'scheduler-bad-window', 'running', targetTo, targetFrom, 0, null], '23514', 'target window must be ordered')
      await rejects(badRunInsert, [orgId, 'scheduler-bad-count', 'running', targetFrom, targetTo, -1, null], '23514', 'run counts must be nonnegative')
      await rejects(badRunInsert, [orgId, 'scheduler-bad-finished', 'succeeded', targetFrom, targetTo, 0, null], '23514', 'terminal run must have finished_at')

      const badItemInsert = `INSERT INTO attendance_auto_shift_auto_write_run_items
        (run_id, org_id, user_id, work_date, confidence, status, assignment_id, evidence_event_ids, reason, error_message)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`
      await rejects(badItemInsert, [runId, orgId, `${userId}-a`, targetTo, 'none', 'skipped', null, '[]', 'low confidence', null], '23514', 'confidence enum must be valid')
      await rejects(badItemInsert, [runId, orgId, `${userId}-b`, targetTo, 'high', 'bogus', null, '[]', 'low confidence', null], '23514', 'item status enum must be valid')
      await rejects(badItemInsert, [runId, orgId, `${userId}-c`, targetTo, 'high', 'applied', null, '[]', null, null], '23514', 'applied item must carry assignment_id')
      await rejects(badItemInsert, [runId, orgId, `${userId}-d`, targetTo, 'high', 'skipped', null, '{}', 'low confidence', null], '23514', 'evidence_event_ids must be an array')
      await rejects(badItemInsert, [runId, orgId, `${userId}-e`, targetTo, 'high', 'skipped', null, '[]', null, null], '23514', 'skipped/error item must explain the outcome')
      await rejects(badItemInsert, [runId, orgId, `${userId}-f`, targetTo, 'high', 'skipped', '00000000-0000-4000-8000-000000000444', '[]', 'no write', null], '23514', 'skipped item must not carry assignment_id')
    } finally {
      await pool.query('DELETE FROM attendance_auto_shift_auto_write_runs WHERE org_id = $1', [orgId]).catch(() => undefined)
      await pool.end().catch(() => undefined)
    }
  })

  it('④ C2 — overtime approval credits a comp-time grant lot (opt-in OFF=no credit; ON=lot+event; replay no double-credit)', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return
    const runSuffix = Date.now().toString(36)
    const userId = `attendance-c2-${runSuffix}`
    const previousRbacBypass = process.env.RBAC_BYPASS
    const pool = new Pool({ connectionString: dbUrl })
    let token: string | undefined
    let originalSettings: Record<string, unknown> = {}
    const createdRequestIds: string[] = []
    try {
      process.env.RBAC_BYPASS = 'true'
      const tokenRes = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`)
      token = (tokenRes.body as { token?: string } | undefined)?.token
      if (!token) return
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

      const origRes = await requestJson(`${baseUrl}/api/attendance/settings`, { headers: { Authorization: `Bearer ${token}` } })
      originalSettings = ((origRes.body as { data?: Record<string, unknown> } | undefined)?.data ?? {}) as Record<string, unknown>

      const overtimeRuleRes = await requestJson(`${baseUrl}/api/attendance/overtime-rules`, { method: 'POST', headers, body: JSON.stringify({ name: `c2-ot-${runSuffix}`, minMinutes: 30 }) })
      expect([201, 409]).toContain(overtimeRuleRes.status)
      let overtimeRuleId = (overtimeRuleRes.body as { data?: { id?: string } } | undefined)?.data?.id
      if (!overtimeRuleId) {
        const listRes = await requestJson(`${baseUrl}/api/attendance/overtime-rules`, { headers: { Authorization: `Bearer ${token}` } })
        const items = (listRes.body as { data?: { items?: { id?: string; name?: string }[] } } | undefined)?.data?.items ?? []
        overtimeRuleId = items.find(item => item.name === `c2-ot-${runSuffix}`)?.id
      }
      expect(overtimeRuleId).toBeTruthy()

      const putSettings = (body: Record<string, unknown>) => requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers, body: JSON.stringify(body) })
      const setFlag = (enabled: boolean) => putSettings({ compTimeFromOvertime: { enabled } })
      const createOvertime = async (workDate: string, minutes: number) => {
        const res = await requestJson(`${baseUrl}/api/attendance/requests`, { method: 'POST', headers, body: JSON.stringify({ workDate, requestType: 'overtime', overtimeRuleId, minutes }) })
        expect(res.status).toBe(201)
        const id = (res.body as { data?: { request?: { id?: string } } } | undefined)?.data?.request?.id
        expect(id).toBeTruthy()
        createdRequestIds.push(id as string)
        return id as string
      }
      const approve = (id: string) => requestJson(`${baseUrl}/api/attendance/requests/${id}/approve`, { method: 'POST', headers, body: JSON.stringify({ comment: 'ok' }) })
      const lotsFor = async (reqId: string) => (await pool.query(
        `SELECT id, leave_type_code, amount_minutes, remaining_minutes, source_type, source_id, status
           FROM attendance_leave_balances WHERE org_id = 'default' AND source_key = $1`,
        [`overtime_conversion:${reqId}`],
      )).rows as { id: string; leave_type_code: string; amount_minutes: number; remaining_minutes: number; source_type: string; source_id: string; status: string }[]
      const eventsFor = async (balanceId: string) => (await pool.query(
        `SELECT event_type, delta_minutes, source_type, source_id FROM attendance_leave_balance_events WHERE balance_id = $1`,
        [balanceId],
      )).rows as { event_type: string; delta_minutes: number; source_type: string; source_id: string }[]

      // (1) flag OFF → approving an overtime request writes NO comp-time lot or event.
      expect((await setFlag(false)).status).toBe(200)
      const offId = await createOvertime('2026-09-07', 90)
      expect((await approve(offId)).status).toBe(200)
      expect(await lotsFor(offId)).toHaveLength(0)

      // (2) flag ON → approving credits exactly one 1:1 comp-time lot + one grant event.
      expect((await setFlag(true)).status).toBe(200)
      const onId = await createOvertime('2026-09-08', 90)
      expect((await approve(onId)).status).toBe(200)
      const lots = await lotsFor(onId)
      expect(lots).toHaveLength(1)
      expect(lots[0]).toMatchObject({
        leave_type_code: 'comp_time',
        amount_minutes: 90,
        remaining_minutes: 90,
        source_type: 'overtime_conversion',
        source_id: onId,
        status: 'active',
      })
      const events = await eventsFor(lots[0].id)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ event_type: 'grant', delta_minutes: 90, source_type: 'overtime_conversion', source_id: onId })

      // (2b) O5: if a versioned overtime segmentation snapshot exists, comp-time
      // credits its compTimeGrantMinutes rather than blindly using metadata.minutes.
      expect((await putSettings({ compTimeFromOvertime: { enabled: true }, overtimeSegmentation: { enabled: false } })).status).toBe(200)
      const segmentedId = await createOvertime('2026-09-09', 90)
      const manualSnapshot = {
        version: 1,
        engine: 'attendance_overtime_segmentation_v1',
        workDate: '2026-09-09',
        dayType: 'workday',
        segments: { workdayMinutes: 90, restdayMinutes: 0, holidayMinutes: 0 },
        totalMinutes: 90,
        compTimeGrantMinutes: 45,
      }
      await pool.query(
        `UPDATE attendance_requests
            SET metadata = jsonb_set(metadata, '{overtimeSegmentation}', $2::jsonb)
          WHERE id = $1`,
        [segmentedId, JSON.stringify(manualSnapshot)],
      )
      expect((await approve(segmentedId)).status).toBe(200)
      const segmentedLots = await lotsFor(segmentedId)
      expect(segmentedLots).toHaveLength(1)
      expect(segmentedLots[0]).toMatchObject({
        amount_minutes: 45,
        remaining_minutes: 45,
        source_type: 'overtime_conversion',
        source_id: segmentedId,
        status: 'active',
      })
      const segmentedEvents = await eventsFor(segmentedLots[0].id)
      expect(segmentedEvents).toEqual([
        expect.objectContaining({ event_type: 'grant', delta_minutes: 45, source_type: 'overtime_conversion', source_id: segmentedId }),
      ])

      // (3a) replay via route: re-approving an already-resolved request is rejected and never re-credits.
      const reapprove = await approve(onId)
      expect(reapprove.status).toBe(400)
      expect(await lotsFor(onId)).toHaveLength(1)
      expect(await eventsFor(lots[0].id)).toHaveLength(1)

      // (3b) idempotency backstop: re-running the hook's exact grant INSERT with the same
      // (org_id, source_key) is a no-op — ON CONFLICT DO NOTHING returns no row, so no second lot
      // and (because the event is written only when a new lot is returned) no second grant event.
      const replayLot = await pool.query(
        `INSERT INTO attendance_leave_balances
           (org_id, user_id, leave_type_code, amount_minutes, remaining_minutes, source_type, source_id, source_key, status)
         VALUES ('default', $1, 'comp_time', 90, 90, 'overtime_conversion', $2, $3, 'active')
         ON CONFLICT (org_id, source_key) DO NOTHING
         RETURNING id`,
        [userId, onId, `overtime_conversion:${onId}`],
      )
      expect(replayLot.rows).toHaveLength(0)
      expect(await lotsFor(onId)).toHaveLength(1)

      // (4) 加班银行 v1-1b: with overtimeBankPolicy ENABLED, an OT segmentation spanning workday+restday grants
      // PER-SOURCE pooled comp_time lots (overtime_source tagged, keyed per-source), conserved to the total.
      // (sections 1–3 above prove the DORMANT path is byte-identical: single overtime_conversion lot.)
      expect((await putSettings({ compTimeFromOvertime: { enabled: true }, overtimeBankPolicy: { enabled: true, pooledSources: ['workday', 'restday'] } })).status).toBe(200)
      const bankId = await createOvertime('2026-09-10', 120)
      await pool.query(
        `UPDATE attendance_requests SET metadata = jsonb_set(metadata, '{overtimeSegmentation}', $2::jsonb) WHERE id = $1`,
        [bankId, JSON.stringify({ version: 1, engine: 'attendance_overtime_segmentation_v1', workDate: '2026-09-10', dayType: 'workday', segments: { workdayMinutes: 60, restdayMinutes: 60, holidayMinutes: 0 }, totalMinutes: 120, compTimeGrantMinutes: 120 })],
      )
      expect((await approve(bankId)).status).toBe(200)
      const bankLots = (await pool.query(
        `SELECT amount_minutes, source_key, overtime_source FROM attendance_leave_balances
          WHERE org_id='default' AND source_id=$1 AND leave_type_code='comp_time' ORDER BY overtime_source`,
        [bankId],
      )).rows as { amount_minutes: number; source_key: string; overtime_source: string }[]
      expect(bankLots).toEqual([
        { amount_minutes: 60, source_key: `overtime_conversion:${bankId}:restday`, overtime_source: 'restday' },
        { amount_minutes: 60, source_key: `overtime_conversion:${bankId}:workday`, overtime_source: 'workday' },
      ])
      expect(bankLots.reduce((s, l) => s + l.amount_minutes, 0)).toBe(120) // conservation: Σ per-source === total
      // replay: re-approving is rejected and never adds extra lots.
      expect((await approve(bankId)).status).toBe(400)
      expect((await pool.query(`SELECT count(*)::int AS n FROM attendance_leave_balances WHERE source_id=$1 AND leave_type_code='comp_time'`, [bankId])).rows[0].n).toBe(2)
    } finally {
      if (token && Object.keys(originalSettings).length > 0) {
        await requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(originalSettings) }).catch(() => undefined)
      }
      await pool.query('DELETE FROM attendance_leave_balance_events WHERE user_id = $1', [userId]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_leave_balances WHERE user_id = $1', [userId]).catch(() => undefined)
      if (createdRequestIds.length > 0) {
        await pool.query('DELETE FROM attendance_requests WHERE id = ANY($1::uuid[])', [createdRequestIds]).catch(() => undefined)
      }
      if (previousRbacBypass === undefined) delete process.env.RBAC_BYPASS
      else process.env.RBAC_BYPASS = previousRbacBypass
      await pool.end().catch(() => undefined)
    }
  })

  it('加班三段 O2 — opt-in request metadata snapshot is written and refreshed on final approval', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return
    const runSuffix = Date.now().toString(36)
    const userId = `attendance-o2-${runSuffix}`
    const previousRbacBypass = process.env.RBAC_BYPASS
    const pool = new Pool({ connectionString: dbUrl })
    let token: string | undefined
    let originalSettings: Record<string, unknown> = {}
    const createdRequestIds: string[] = []
    const holidayDate = '2036-10-01'
    const offDate = '2036-10-02'
    const crossDate = '2036-10-03'
    const holidayId = randomUUID()
    let overtimeRuleId: string | undefined
    try {
      process.env.RBAC_BYPASS = 'true'
      const tokenRes = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin,attendance:approve`)
      token = (tokenRes.body as { token?: string } | undefined)?.token
      expect(token).toBeTruthy()
      if (!token) return
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

      const settingsRes = await requestJson(`${baseUrl}/api/attendance/settings`, { headers: { Authorization: `Bearer ${token}` } })
      expect(settingsRes.status).toBe(200)
      originalSettings = ((settingsRes.body as { data?: Record<string, unknown> } | undefined)?.data ?? {}) as Record<string, unknown>

      const ruleRes = await requestJson(`${baseUrl}/api/attendance/overtime-rules`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: `o2-ot-${runSuffix}`, minMinutes: 30, roundingMinutes: 15, maxMinutesPerDay: 120 }),
      })
      expect([201, 409]).toContain(ruleRes.status)
      overtimeRuleId = (ruleRes.body as { data?: { id?: string } } | undefined)?.data?.id
      if (!overtimeRuleId) {
        const listRes = await requestJson(`${baseUrl}/api/attendance/overtime-rules`, { headers: { Authorization: `Bearer ${token}` } })
        const items = (listRes.body as { data?: { items?: { id?: string; name?: string }[] } } | undefined)?.data?.items ?? []
        overtimeRuleId = items.find(item => item.name === `o2-ot-${runSuffix}`)?.id
      }
      expect(overtimeRuleId).toBeTruthy()
      if (!overtimeRuleId) return

      await pool.query(
        `INSERT INTO attendance_holidays (id, org_id, holiday_date, name, is_working_day, origin)
         VALUES ($1, 'default', $2, $3, false, 'national')`,
        [holidayId, holidayDate, `O2 Holiday ${runSuffix}`],
      )

      const saveSettings = (enabled: boolean) => requestJson(`${baseUrl}/api/attendance/settings`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ overtimeSegmentation: { enabled } }),
      })
      const createOvertime = async (workDate: string, body: Record<string, unknown> = {}) => {
        const res = await requestJson(`${baseUrl}/api/attendance/requests`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ workDate, requestType: 'overtime', overtimeRuleId, ...body }),
        })
        if (res.status === 201) {
          const id = (res.body as { data?: { request?: { id?: string } } } | undefined)?.data?.request?.id
          if (id) createdRequestIds.push(id)
        }
        return res
      }
      const loadRequestMetadata = async (requestId: string) => {
        const rows = await pool.query('SELECT metadata FROM attendance_requests WHERE id = $1', [requestId])
        return (rows.rows[0]?.metadata ?? {}) as Record<string, unknown>
      }

      expect((await saveSettings(false)).status).toBe(200)
      const offRes = await createOvertime(offDate, { minutes: 47 })
      expect(offRes.status).toBe(201)
      const offId = (offRes.body as { data?: { request?: { id?: string } } } | undefined)?.data?.request?.id
      expect(offId).toBeTruthy()
      if (!offId) return
      expect((await loadRequestMetadata(offId)).overtimeSegmentation).toBeUndefined()

      expect((await saveSettings(true)).status).toBe(200)
      const holidayRes = await createOvertime(holidayDate, { minutes: 47 })
      expect(holidayRes.status).toBe(201)
      const holidayRequestId = (holidayRes.body as { data?: { request?: { id?: string } } } | undefined)?.data?.request?.id
      expect(holidayRequestId).toBeTruthy()
      if (!holidayRequestId) return
      let metadata = await loadRequestMetadata(holidayRequestId)
      expect(metadata.overtimeSegmentation).toMatchObject({
        version: 1,
        engine: 'attendance_overtime_segmentation_v1',
        workDate: holidayDate,
        dayType: 'holiday',
        totalMinutes: 60,
        compTimeGrantMinutes: 60,
        segments: { workdayMinutes: 0, restdayMinutes: 0, holidayMinutes: 60 },
      })

      const updateRes = await requestJson(`${baseUrl}/api/attendance/requests/${holidayRequestId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ minutes: 90 }),
      })
      expect(updateRes.status, updateRes.raw).toBe(200)
      metadata = await loadRequestMetadata(holidayRequestId)
      expect(metadata.overtimeSegmentation).toMatchObject({
        dayType: 'holiday',
        totalMinutes: 90,
        segments: { workdayMinutes: 0, restdayMinutes: 0, holidayMinutes: 90 },
      })

      // Corrupt the draft snapshot to prove final approval recomputes it inside the approval txn.
      await pool.query(
        `UPDATE attendance_requests
         SET metadata = jsonb_set(metadata, '{overtimeSegmentation,dayType}', '"workday"'::jsonb, true)
         WHERE id = $1`,
        [holidayRequestId],
      )
      const approveRes = await requestJson(`${baseUrl}/api/attendance/requests/${holidayRequestId}/approve`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ comment: 'approve o2' }),
      })
      expect(approveRes.status, approveRes.raw).toBe(200)
      metadata = await loadRequestMetadata(holidayRequestId)
      expect(metadata.overtimeSegmentation).toMatchObject({
        dayType: 'holiday',
        totalMinutes: 90,
        segments: { workdayMinutes: 0, restdayMinutes: 0, holidayMinutes: 90 },
      })
      expect(metadata.resolution).toMatchObject({ action: 'approve', status: 'approved' })

      // #8 NS-3 lifted the reject: a one-midnight overtime window is now ACCEPTED and bucketed per own date
      // (was OVERTIME_CROSS_MIDNIGHT_UNSUPPORTED pre-NS-3).
      const crossRes = await createOvertime(crossDate, {
        requestedInAt: `${crossDate}T23:00:00.000Z`,
        requestedOutAt: '2036-10-04T01:00:00.000Z',
      })
      expect(crossRes.status, crossRes.raw).toBe(201)
      const crossId = (crossRes.body as { data?: { request?: { id?: string } } } | undefined)?.data?.request?.id as string
      expect(crossId).toBeTruthy()
      const crossSeg = (await loadRequestMetadata(crossId)).overtimeSegmentation as {
        crossesMidnight?: boolean; totalMinutes?: number
        segments: { workdayMinutes: number; restdayMinutes: number; holidayMinutes: number }
        perDate: { date: string; minutes: number }[]
      }
      expect(crossSeg.crossesMidnight).toBe(true)
      expect(crossSeg.totalMinutes).toBe(120)
      // conserved across the two dates (no boundary double-count) + attributed by own date.
      expect(crossSeg.segments.workdayMinutes + crossSeg.segments.restdayMinutes + crossSeg.segments.holidayMinutes).toBe(120)
      expect(crossSeg.perDate.map((p) => p.date)).toEqual([crossDate, '2036-10-04'])
      expect(crossSeg.perDate.reduce((s, p) => s + p.minutes, 0)).toBe(120)
    } finally {
      if (token && Object.keys(originalSettings).length > 0) {
        await requestJson(`${baseUrl}/api/attendance/settings`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(originalSettings),
        }).catch(() => undefined)
      }
      if (createdRequestIds.length > 0) {
        await pool.query('DELETE FROM attendance_events WHERE meta->>\'requestId\' = ANY($1::text[])', [createdRequestIds]).catch(() => undefined)
        await pool.query('DELETE FROM attendance_records WHERE user_id = $1 AND work_date::text = ANY($2::text[])', [userId, [holidayDate, offDate, crossDate]]).catch(() => undefined)
        await pool.query('DELETE FROM attendance_requests WHERE id = ANY($1::uuid[])', [createdRequestIds]).catch(() => undefined)
      }
      await pool.query('DELETE FROM attendance_holidays WHERE id = $1', [holidayId]).catch(() => undefined)
      if (overtimeRuleId) await pool.query('DELETE FROM attendance_overtime_rules WHERE id = $1', [overtimeRuleId]).catch(() => undefined)
      if (previousRbacBypass === undefined) delete process.env.RBAC_BYPASS
      else process.env.RBAC_BYPASS = previousRbacBypass
      await pool.end().catch(() => undefined)
    }
  })

  it('加班三段 NS-3 — a one-midnight overtime window is ACCEPTED, bucketed per OWN date, conserved, replay-idempotent; multi-midnight rejects (real DB)', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return
    const runSuffix = Date.now().toString(36)
    const userId = `attendance-ns3-${runSuffix}`
    const previousRbacBypass = process.env.RBAC_BYPASS
    const pool = new Pool({ connectionString: dbUrl })
    const createdRequestIds: string[] = []
    let originalSettings: Record<string, unknown> = {}
    let token: string | undefined
    const workDate = '2037-06-12' // June → no DST transition in any tz, so the local-midnight offset is stable
    const nextDate = '2037-06-13'
    const farDate = '2037-06-14'
    const holidayId = randomUUID()
    let overtimeRuleId: string | undefined
    // UTC ISO for a local wall-clock in tz (DST-safe here because the dates avoid transitions).
    const zonedUtcIso = (dateStr: string, timeStr: string, tz: string): string => {
      const guess = new Date(`${dateStr}T${timeStr}:00.000Z`)
      const local = new Date(guess.toLocaleString('en-US', { timeZone: tz }))
      return new Date(guess.getTime() + (guess.getTime() - local.getTime())).toISOString()
    }
    try {
      process.env.RBAC_BYPASS = 'true'
      const tokenRes = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin,attendance:approve`)
      token = (tokenRes.body as { token?: string } | undefined)?.token
      if (!token) return
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

      const ruleRes = await requestJson(`${baseUrl}/api/attendance/overtime-rules`, { method: 'POST', headers, body: JSON.stringify({ name: `ns3-ot-${runSuffix}`, minMinutes: 0, roundingMinutes: 1 }) })
      expect([201, 409]).toContain(ruleRes.status)
      overtimeRuleId = (ruleRes.body as { data?: { id?: string } } | undefined)?.data?.id
      if (!overtimeRuleId) {
        const listRes = await requestJson(`${baseUrl}/api/attendance/overtime-rules`, { headers: { Authorization: `Bearer ${token}` } })
        overtimeRuleId = ((listRes.body as { data?: { items?: { id?: string; name?: string }[] } } | undefined)?.data?.items ?? []).find(i => i.name === `ns3-ot-${runSuffix}`)?.id
      }
      if (!overtimeRuleId) return

      // learn the user's work timezone so the window crosses LOCAL midnight regardless of the org default.
      const calRes = await requestJson(`${baseUrl}/api/attendance/effective-calendar?from=${workDate}&to=${workDate}&userId=${encodeURIComponent(userId)}`, { headers: { Authorization: `Bearer ${token}` } })
      const tz = ((calRes.body as { data?: { timezone?: string } } | undefined)?.data?.timezone) || 'UTC'

      // holiday on the after-midnight date → its portion must bucket to holiday.
      await pool.query(`INSERT INTO attendance_holidays (id, org_id, holiday_date, name, is_working_day, origin) VALUES ($1, 'default', $2, $3, false, 'national')`, [holidayId, nextDate, `NS3 Holiday ${runSuffix}`])
      // §P2: snapshot settings so finally can restore them (segmentation is a GLOBAL toggle — don't leak it).
      const settingsRes = await requestJson(`${baseUrl}/api/attendance/settings`, { headers: { Authorization: `Bearer ${token}` } })
      originalSettings = ((settingsRes.body as { data?: Record<string, unknown> } | undefined)?.data ?? {}) as Record<string, unknown>
      expect((await requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers, body: JSON.stringify({ overtimeSegmentation: { enabled: true } }) })).status).toBe(200)

      const createOvertime = async (body: Record<string, unknown>) => {
        const res = await requestJson(`${baseUrl}/api/attendance/requests`, { method: 'POST', headers, body: JSON.stringify({ workDate, requestType: 'overtime', overtimeRuleId, ...body }) })
        const id = (res.body as { data?: { request?: { id?: string } } } | undefined)?.data?.request?.id
        if (id) createdRequestIds.push(id)
        return res
      }
      const loadSeg = async (id: string) => ((await pool.query('SELECT metadata FROM attendance_requests WHERE id = $1', [id])).rows[0]?.metadata as { overtimeSegmentation?: any })?.overtimeSegmentation

      // (1) one local midnight (workDate 23:00 → nextDate 01:00 local) → accepted + bucketed per own date.
      const crossRes = await createOvertime({ minutes: 120, requestedInAt: zonedUtcIso(workDate, '23:00', tz), requestedOutAt: zonedUtcIso(nextDate, '01:00', tz) })
      expect(crossRes.status, crossRes.raw).toBe(201)
      const crossId = (crossRes.body as { data?: { request?: { id?: string } } } | undefined)?.data?.request?.id as string
      const seg = await loadSeg(crossId)
      expect(seg.crossesMidnight).toBe(true)
      expect(seg.totalMinutes).toBe(120)
      // conservation: buckets sum to total, no boundary double-count.
      expect(seg.segments.workdayMinutes + seg.segments.restdayMinutes + seg.segments.holidayMinutes).toBe(120)
      expect(seg.perDate).toHaveLength(2)
      expect(seg.perDate.map((p: { date: string }) => p.date)).toEqual([workDate, nextDate])
      // the after-midnight date is the holiday → 60 min in the holiday bucket, attributed to nextDate.
      expect(seg.perDate[1]).toMatchObject({ date: nextDate, dayType: 'holiday', minutes: 60 })
      expect(seg.segments.holidayMinutes).toBe(60)

      // (2) replay idempotency: corrupt the draft snapshot, approve → recomputed identical inside the txn.
      const before = JSON.stringify(seg)
      await pool.query(`UPDATE attendance_requests SET metadata = jsonb_set(metadata, '{overtimeSegmentation,segments,holidayMinutes}', '999'::jsonb, true) WHERE id = $1`, [crossId])
      expect((await requestJson(`${baseUrl}/api/attendance/requests/${crossId}/approve`, { method: 'POST', headers, body: JSON.stringify({ comment: 'approve ns3' }) })).status).toBe(200)
      expect(JSON.stringify(await loadSeg(crossId))).toBe(before)

      // (3) more than one midnight still rejects with the stable code.
      const multiRes = await createOvertime({ minutes: 200, requestedInAt: zonedUtcIso(workDate, '23:00', tz), requestedOutAt: zonedUtcIso(farDate, '01:00', tz) })
      expect(multiRes.status).toBe(422)
      expect((multiRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('OVERTIME_CROSS_MIDNIGHT_UNSUPPORTED')

      // NS-4 staging contract: reversed overtime windows surface the overtime-specific code at the route layer,
      // not the generic request VALIDATION_ERROR used by non-overtime request types.
      const reversedRes = await createOvertime({ minutes: 60, requestedInAt: zonedUtcIso(workDate, '10:00', tz), requestedOutAt: zonedUtcIso(workDate, '09:00', tz) })
      expect(reversedRes.status).toBe(422)
      expect((reversedRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('OVERTIME_INVALID_TIME_WINDOW')
    } finally {
      // §P2: restore the GLOBAL segmentation setting so later tests don't run under enabled=true.
      if (token && Object.keys(originalSettings).length > 0) {
        await requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(originalSettings) }).catch(() => undefined)
      }
      if (createdRequestIds.length > 0) {
        await pool.query('DELETE FROM attendance_events WHERE meta->>\'requestId\' = ANY($1::text[])', [createdRequestIds]).catch(() => undefined)
        await pool.query('DELETE FROM attendance_requests WHERE id = ANY($1::uuid[])', [createdRequestIds]).catch(() => undefined)
      }
      // §P2: the approve step can write a record for the synthetic user/dates — clean it up.
      await pool.query('DELETE FROM attendance_records WHERE user_id = $1 AND work_date::text = ANY($2::text[])', [userId, [workDate, nextDate, farDate]]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_holidays WHERE id = $1', [holidayId]).catch(() => undefined)
      if (overtimeRuleId) await pool.query('DELETE FROM attendance_overtime_rules WHERE id = $1', [overtimeRuleId]).catch(() => undefined)
      if (previousRbacBypass === undefined) delete process.env.RBAC_BYPASS
      else process.env.RBAC_BYPASS = previousRbacBypass
      await pool.end().catch(() => undefined)
    }
  })

  it('④ 加班银行 v1-5b-ii — cycle close snapshots settlement (convertible · poison-lot · idempotent replay · balance-only population)', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return
    const runSuffix = Date.now().toString(36)
    const userId = `attendance-v15b2-${runSuffix}`
    const previousRbacBypass = process.env.RBAC_BYPASS
    const pool = new Pool({ connectionString: dbUrl })
    let token: string | undefined
    let cycleId: string | undefined
    let originalSettings: Record<string, unknown> = {}
    try {
      process.env.RBAC_BYPASS = 'true'
      const tokenRes = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`)
      token = (tokenRes.body as { token?: string } | undefined)?.token
      if (!token) return
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      const putSettings = (body: Record<string, unknown>) => requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers, body: JSON.stringify(body) })
      originalSettings = ((await requestJson(`${baseUrl}/api/attendance/settings`, { headers: { Authorization: `Bearer ${token}` } })).body as { data?: Record<string, unknown> } | undefined)?.data ?? {}
      await putSettings({ overtimeBankPolicy: { enabled: true, pooledSources: ['restday'] } })

      const lot = (src: string, mins: number) => pool.query(
        `INSERT INTO attendance_leave_balances (org_id, user_id, leave_type_code, amount_minutes, remaining_minutes, source_type, source_key, status, granted_at, overtime_source)
         VALUES ('default', $1, 'comp_time', $2, $2, 'overtime_conversion', $3, 'active', '2026-01-01', $4)`,
        [userId, mins, `v15b2:${runSuffix}:${src}`, src])
      await lot('restday', 90)
      await lot('statutory_holiday', 9999) // POISON: a bogus statutory balance lot — must NOT become must-pay/convertible.

      const createRes = await requestJson(`${baseUrl}/api/attendance/payroll-cycles`, { method: 'POST', headers, body: JSON.stringify({ startDate: '2026-09-01', endDate: '2026-09-30', status: 'open' }) })
      expect(createRes.status).toBe(201)
      cycleId = (createRes.body as { data?: { id?: string } } | undefined)?.data?.id
      expect(cycleId).toBeTruthy()
      const settlements = async () => (await pool.query(
        `SELECT source, convertible_minutes, must_pay_minutes, period_start_date FROM attendance_payroll_cycle_settlements WHERE cycle_id = $1 AND user_id = $2 ORDER BY source`,
        [cycleId, userId])).rows as { source: string; convertible_minutes: number; must_pay_minutes: number; period_start_date: string }[]
      const closeCycle = () => requestJson(`${baseUrl}/api/attendance/payroll-cycles/${cycleId}`, { method: 'PUT', headers, body: JSON.stringify({ status: 'closed' }) })

      // before close → nothing written.
      expect(await settlements()).toHaveLength(0)
      // close → snapshot written in the same txn.
      expect((await closeCycle()).status).toBe(200)
      const afterClose = await settlements()
      const bySource = Object.fromEntries(afterClose.map((r) => [r.source, r]))
      expect(Number(bySource.restday?.convertible_minutes)).toBe(90)          // banked restday → convertible
      expect(bySource.statutory_holiday).toBeUndefined()                      // POISON lot → no statutory row (no period OT, never convertible)
      expect(bySource.restday?.period_start_date).toBeTruthy()                // frozen period stamped on the row
      // idempotent replay: re-close → ON CONFLICT DO NOTHING, no new/changed rows.
      expect((await closeCycle()).status).toBe(200)
      const afterReplay = await settlements()
      expect(afterReplay).toHaveLength(afterClose.length)
      expect(Number(Object.fromEntries(afterReplay.map((r) => [r.source, r])).restday?.convertible_minutes)).toBe(90)
      // [P1 owner #3233] a closed cycle's period is FROZEN: PUT changing start/end → 409; DELETE closed → 409;
      // a status-only transition (closed→archived) is still allowed.
      expect((await requestJson(`${baseUrl}/api/attendance/payroll-cycles/${cycleId}`, { method: 'PUT', headers, body: JSON.stringify({ startDate: '2026-10-01', endDate: '2026-10-31' }) })).status).toBe(409)
      expect((await requestJson(`${baseUrl}/api/attendance/payroll-cycles/${cycleId}`, { method: 'DELETE', headers })).status).toBe(409)
      expect((await requestJson(`${baseUrl}/api/attendance/payroll-cycles/${cycleId}`, { method: 'PUT', headers, body: JSON.stringify({ status: 'archived' }) })).status).toBe(200)
      // [P2 owner #3233] the freeze SURVIVES archive — 'archived' is ONCE-CLOSED, so close→archive must NOT
      // reopen the period or allow delete: archived period change → 409; archived delete → 409.
      expect((await requestJson(`${baseUrl}/api/attendance/payroll-cycles/${cycleId}`, { method: 'PUT', headers, body: JSON.stringify({ startDate: '2026-10-01', endDate: '2026-10-31' }) })).status).toBe(409)
      expect((await requestJson(`${baseUrl}/api/attendance/payroll-cycles/${cycleId}`, { method: 'DELETE', headers })).status).toBe(409)
      // NOTE: the must-pay-from-period-OT-facts end-to-end (the [P1] un-pooled case) is unit-proven in
      // attendance-settlement-compute.test.ts; a wired must-pay e2e needs the OT-segmentation harness — a v1-5b-iii follow-up.
    } finally {
      if (token && Object.keys(originalSettings).length > 0) await requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(originalSettings) }).catch(() => undefined)
      if (cycleId) await pool.query('DELETE FROM attendance_payroll_cycle_settlements WHERE cycle_id = $1', [cycleId]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_leave_balances WHERE user_id = $1', [userId]).catch(() => undefined)
      if (cycleId) await pool.query('DELETE FROM attendance_payroll_cycles WHERE id = $1', [cycleId]).catch(() => undefined)
      await pool.end().catch(() => undefined)
      if (previousRbacBypass === undefined) delete process.env.RBAC_BYPASS; else process.env.RBAC_BYPASS = previousRbacBypass
    }
  })

  it('④ 加班银行 v1-5b-iii — must-pay comes from PERIOD OT facts (un-pooled workday + statutory), NOT balance lots (e2e)', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return
    const runSuffix = Date.now().toString(36)
    const userId = `attendance-v15b3-${runSuffix}`
    const previousRbacBypass = process.env.RBAC_BYPASS
    const pool = new Pool({ connectionString: dbUrl })
    let token: string | undefined
    let cycleId: string | undefined
    let overtimeRuleId: string | undefined
    let originalSettings: Record<string, unknown> = {}
    try {
      process.env.RBAC_BYPASS = 'true'
      const tokenRes = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`)
      token = (tokenRes.body as { token?: string } | undefined)?.token
      if (!token) return
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      const putSettings = (body: Record<string, unknown>) => requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers, body: JSON.stringify(body) })
      originalSettings = ((await requestJson(`${baseUrl}/api/attendance/settings`, { headers: { Authorization: `Bearer ${token}` } })).body as { data?: Record<string, unknown> } | undefined)?.data ?? {}
      // pooledSources=['restday'] → workday OT is UN-POOLED → must-pay. compTimeFromOvertime left OFF → no grant
      // interference, so the only comp_time balance is the POISON statutory lot below.
      await putSettings({ overtimeBankPolicy: { enabled: true, pooledSources: ['restday'] } })

      // a REAL approved OT request in the cycle period, carrying period OT facts: workday 120 + holiday 480.
      const otRuleRes = await requestJson(`${baseUrl}/api/attendance/overtime-rules`, { method: 'POST', headers, body: JSON.stringify({ name: `v15b3-ot-${runSuffix}`, minMinutes: 30 }) })
      expect([201, 409]).toContain(otRuleRes.status)
      overtimeRuleId = (otRuleRes.body as { data?: { id?: string } } | undefined)?.data?.id
      expect(overtimeRuleId).toBeTruthy()
      const reqRes = await requestJson(`${baseUrl}/api/attendance/requests`, { method: 'POST', headers, body: JSON.stringify({ workDate: '2026-09-10', requestType: 'overtime', overtimeRuleId, minutes: 600 }) })
      expect(reqRes.status).toBe(201)
      const otId = (reqRes.body as { data?: { request?: { id?: string } } } | undefined)?.data?.request?.id as string
      expect(otId).toBeTruthy()
      expect((await requestJson(`${baseUrl}/api/attendance/requests/${otId}/approve`, { method: 'POST', headers, body: JSON.stringify({ comment: 'ok' }) })).status).toBe(200)
      // set segmentation AFTER approve so approve can't overwrite it; loadAttendanceSummary reads current metadata.
      await pool.query(
        `UPDATE attendance_requests SET metadata = jsonb_set(metadata, '{overtimeSegmentation}', $2::jsonb) WHERE id = $1`,
        [otId, JSON.stringify({ version: 1, engine: 'attendance_overtime_segmentation_v1', workDate: '2026-09-10', dayType: 'workday', segments: { workdayMinutes: 120, restdayMinutes: 0, holidayMinutes: 480 }, totalMinutes: 600, compTimeGrantMinutes: 0 })],
      )
      // POISON: a bogus statutory_holiday comp_time BALANCE lot of 9999 — must NOT move must_pay (which comes from
      // PERIOD facts) and must NOT appear as convertible (statutory is never banked).
      await pool.query(
        `INSERT INTO attendance_leave_balances (org_id, user_id, leave_type_code, amount_minutes, remaining_minutes, source_type, source_key, status, granted_at, overtime_source)
         VALUES ('default', $1, 'comp_time', 9999, 9999, 'overtime_conversion', $2, 'active', '2026-01-01', 'statutory_holiday')`,
        [userId, `v15b3-poison:${runSuffix}`])

      const createRes = await requestJson(`${baseUrl}/api/attendance/payroll-cycles`, { method: 'POST', headers, body: JSON.stringify({ startDate: '2026-09-01', endDate: '2026-09-30', status: 'open' }) })
      expect(createRes.status).toBe(201)
      cycleId = (createRes.body as { data?: { id?: string } } | undefined)?.data?.id
      expect((await requestJson(`${baseUrl}/api/attendance/payroll-cycles/${cycleId}`, { method: 'PUT', headers, body: JSON.stringify({ status: 'closed' }) })).status).toBe(200)

      const settle = Object.fromEntries(((await pool.query(
        `SELECT source, convertible_minutes, must_pay_minutes FROM attendance_payroll_cycle_settlements WHERE cycle_id = $1 AND user_id = $2`,
        [cycleId, userId])).rows as { source: string; convertible_minutes: number; must_pay_minutes: number }[]).map((r) => [r.source, r])) as Record<string, { convertible_minutes: number; must_pay_minutes: number }>
      // [DECISIVE] un-pooled workday OT → must-pay EXACTLY 120 — the [P1] case, now proven e2e through the real
      // summary (missing/0 row would NaN-fail this, so no vacuous green).
      expect(Number(settle.workday?.must_pay_minutes)).toBe(120)
      expect(Number(settle.workday?.convertible_minutes)).toBe(0)
      // [DECISIVE] statutory must-pay = the PERIOD holiday OT (480), NOT the 9999 poison balance lot; statutory
      // never convertible.
      expect(Number(settle.statutory_holiday?.must_pay_minutes)).toBe(480)
      expect(Number(settle.statutory_holiday?.convertible_minutes)).toBe(0)
      expect(settle.statutory_holiday?.must_pay_minutes).not.toBe(9999)
    } finally {
      if (token && Object.keys(originalSettings).length > 0) await requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(originalSettings) }).catch(() => undefined)
      if (cycleId) await pool.query('DELETE FROM attendance_payroll_cycle_settlements WHERE cycle_id = $1', [cycleId]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_requests WHERE user_id = $1', [userId]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_leave_balances WHERE user_id = $1', [userId]).catch(() => undefined)
      if (cycleId) await pool.query('DELETE FROM attendance_payroll_cycles WHERE id = $1', [cycleId]).catch(() => undefined)
      if (overtimeRuleId) await pool.query('DELETE FROM attendance_overtime_rules WHERE id = $1', [overtimeRuleId]).catch(() => undefined)
      await pool.end().catch(() => undefined)
      if (previousRbacBypass === undefined) delete process.env.RBAC_BYPASS; else process.env.RBAC_BYPASS = previousRbacBypass
    }
  })

  it('④ 加班银行 v1-5b-ii [P2] — create-as-closed AND generate-as-closed both snapshot settlement (§3 no-bypass)', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return
    const runSuffix = Date.now().toString(36)
    const userId = `attendance-v15b2p2-${runSuffix}`
    const previousRbacBypass = process.env.RBAC_BYPASS
    const pool = new Pool({ connectionString: dbUrl })
    const cycleIds: string[] = []
    let token: string | undefined
    let originalSettings: Record<string, unknown> = {}
    try {
      process.env.RBAC_BYPASS = 'true'
      const tokenRes = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`)
      token = (tokenRes.body as { token?: string } | undefined)?.token
      if (!token) return
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      const putSettings = (body: Record<string, unknown>) => requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers, body: JSON.stringify(body) })
      originalSettings = ((await requestJson(`${baseUrl}/api/attendance/settings`, { headers: { Authorization: `Bearer ${token}` } })).body as { data?: Record<string, unknown> } | undefined)?.data ?? {}
      await putSettings({ overtimeBankPolicy: { enabled: true, pooledSources: ['restday'] } })
      await pool.query(
        `INSERT INTO attendance_leave_balances (org_id, user_id, leave_type_code, amount_minutes, remaining_minutes, source_type, source_key, status, granted_at, overtime_source)
         VALUES ('default', $1, 'comp_time', 90, 90, 'overtime_conversion', $2, 'active', '2026-01-01', 'restday')`,
        [userId, `v15b2p2:${runSuffix}`])
      const convertibleFor = async (cycleId: string) => Number((await pool.query(
        `SELECT COALESCE(SUM(convertible_minutes),0) AS c FROM attendance_payroll_cycle_settlements WHERE cycle_id = $1 AND user_id = $2`,
        [cycleId, userId])).rows[0].c)

      // (1) create-as-closed (POST status:'closed') → settlement written in the create txn (must not bypass §3).
      const createRes = await requestJson(`${baseUrl}/api/attendance/payroll-cycles`, { method: 'POST', headers, body: JSON.stringify({ startDate: '2026-11-01', endDate: '2026-11-30', status: 'closed' }) })
      expect(createRes.status).toBe(201)
      const createdId = (createRes.body as { data?: { id?: string } } | undefined)?.data?.id as string
      expect(createdId).toBeTruthy(); cycleIds.push(createdId)
      expect(await convertibleFor(createdId)).toBe(90)

      // (2) generate-as-closed (POST /generate status:'closed') → settlement written for the generated closed cycle.
      const tmplRes = await requestJson(`${baseUrl}/api/attendance/payroll-templates`, { method: 'POST', headers, body: JSON.stringify({ name: `T ${runSuffix}`, timezone: 'UTC', startDay: 1, endDay: 28, endMonthOffset: 0, autoGenerate: false }) })
      expect([201, 409]).toContain(tmplRes.status)
      const tmplId = (tmplRes.body as { data?: { id?: string } } | undefined)?.data?.id as string
      const genRes = await requestJson(`${baseUrl}/api/attendance/payroll-cycles/generate`, { method: 'POST', headers, body: JSON.stringify({ templateId: tmplId, anchorDate: '2026-12-15', count: 1, status: 'closed', namePrefix: `Gen ${runSuffix}` }) })
      expect(genRes.status).toBe(200) // generate responds 200 with { created, skipped } (not 201)
      const generated = (genRes.body as { data?: { created?: { id?: string }[] } } | undefined)?.data?.created ?? []
      expect(generated.length).toBeGreaterThanOrEqual(1)
      const genId = generated[0]?.id as string
      expect(genId).toBeTruthy(); cycleIds.push(genId)
      expect(await convertibleFor(genId)).toBe(90)
    } finally {
      if (token && Object.keys(originalSettings).length > 0) await requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(originalSettings) }).catch(() => undefined)
      for (const id of cycleIds) await pool.query('DELETE FROM attendance_payroll_cycle_settlements WHERE cycle_id = $1', [id]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_leave_balances WHERE user_id = $1', [userId]).catch(() => undefined)
      for (const id of cycleIds) await pool.query('DELETE FROM attendance_payroll_cycles WHERE id = $1', [id]).catch(() => undefined)
      await pool.end().catch(() => undefined)
      if (previousRbacBypass === undefined) delete process.env.RBAC_BYPASS; else process.env.RBAC_BYPASS = previousRbacBypass
    }
  })

  it('④ 加班银行 v1-3b — 满勤 flag surfaces on GET /summary when policy ON; ABSENT when OFF (dormant-clean)', async () => {
    if (!baseUrl) return
    const runSuffix = Date.now().toString(36)
    const userId = `attendance-v13b-${runSuffix}`
    const previousRbacBypass = process.env.RBAC_BYPASS
    let token: string | undefined
    let originalSettings: Record<string, unknown> = {}
    try {
      process.env.RBAC_BYPASS = 'true'
      const tokenRes = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`)
      token = (tokenRes.body as { token?: string } | undefined)?.token
      if (!token) return
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      const putSettings = (body: Record<string, unknown>) => requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers, body: JSON.stringify(body) })
      originalSettings = ((await requestJson(`${baseUrl}/api/attendance/settings`, { headers: { Authorization: `Bearer ${token}` } })).body as { data?: Record<string, unknown> } | undefined)?.data ?? {}
      const getSummary = async () => {
        const r = await requestJson(`${baseUrl}/api/attendance/summary?from=2026-09-01&to=2026-09-30`, { headers: { Authorization: `Bearer ${token}` } })
        expect(r.status).toBe(200)
        return ((r.body as { data?: Record<string, unknown> } | undefined)?.data ?? {}) as Record<string, unknown>
      }
      // (1) policy OFF (default) → field ABSENT — the live summary response is byte-identical to pre-v1-3b.
      expect((await putSettings({ attendanceBonusPolicy: { enabled: false } })).status).toBe(200)
      expect('fullAttendanceEligible' in (await getSummary())).toBe(false)
      // (2) policy ON, clean period (no records/leave/late) → field PRESENT and true.
      expect((await putSettings({ attendanceBonusPolicy: { enabled: true, anyLeaveBreaksFullAttendance: true, lateBeyondThresholdBreaksFullAttendance: true } })).status).toBe(200)
      const onSummary = await getSummary()
      expect('fullAttendanceEligible' in onSummary).toBe(true)
      expect(onSummary.fullAttendanceEligible).toBe(true)
      // (3) §P1 false-path through the real route: an approved leave in the period → 满勤 FALSE (the prior route
      // test only covered OFF-absent + clean-true; this exercises the false branch end-to-end).
      const ltRes = await requestJson(`${baseUrl}/api/attendance/leave-types`, { method: 'POST', headers, body: JSON.stringify({ code: 'personal_leave', name: `PL ${runSuffix}`, paid: false, requiresApproval: true }) })
      expect([201, 409]).toContain(ltRes.status)
      let leaveTypeId = (ltRes.body as { data?: { id?: string } } | undefined)?.data?.id
      if (!leaveTypeId) {
        const list = await requestJson(`${baseUrl}/api/attendance/leave-types?isActive=true`, { headers })
        leaveTypeId = ((list.body as { data?: { items?: { id?: string; code?: string }[] } } | undefined)?.data?.items ?? []).find((i) => i.code === 'personal_leave')?.id
      }
      expect(leaveTypeId).toBeTruthy()
      const reqRes = await requestJson(`${baseUrl}/api/attendance/requests`, { method: 'POST', headers, body: JSON.stringify({ workDate: '2026-09-15', requestType: 'leave', leaveTypeId, minutes: 480 }) })
      expect(reqRes.status).toBe(201)
      const reqId = (reqRes.body as { data?: { request?: { id?: string } } } | undefined)?.data?.request?.id
      expect(reqId).toBeTruthy()
      expect((await requestJson(`${baseUrl}/api/attendance/requests/${reqId}/approve`, { method: 'POST', headers, body: JSON.stringify({ comment: 'ok' }) })).status).toBe(200)
      expect((await getSummary()).fullAttendanceEligible).toBe(false)
    } finally {
      if (token && Object.keys(originalSettings).length > 0) await requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(originalSettings) }).catch(() => undefined)
      if (previousRbacBypass === undefined) delete process.env.RBAC_BYPASS; else process.env.RBAC_BYPASS = previousRbacBypass
    }
  })

  it('加班三段 O3/O4 — records, report fields, and summary expose approved overtime segment buckets from request snapshots', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return
    const runSuffix = Date.now().toString(36)
    const year = 3600 + (Number.parseInt(runSuffix.slice(-4), 36) % 1000)
    const firstOfOctober = new Date(Date.UTC(year, 9, 1))
    const monday = new Date(firstOfOctober)
    while (monday.getUTCDay() !== 1) monday.setUTCDate(monday.getUTCDate() + 1)
    const workDate = monday.toISOString().slice(0, 10)
    const holidayDateObj = new Date(monday)
    holidayDateObj.setUTCDate(monday.getUTCDate() + 2)
    const holidayDate = holidayDateObj.toISOString().slice(0, 10)
    const restDateObj = new Date(monday)
    restDateObj.setUTCDate(monday.getUTCDate() + 6)
    const restDate = restDateObj.toISOString().slice(0, 10)
    const from = workDate < holidayDate ? workDate : holidayDate
    const to = restDate
    const userId = `attendance-o3-${runSuffix}`
    const previousRbacBypass = process.env.RBAC_BYPASS
    const pool = new Pool({ connectionString: dbUrl })
    let token: string | undefined
    let originalSettings: Record<string, unknown> = {}
    const createdRequestIds: string[] = []
    const holidayId = randomUUID()
    let overtimeRuleId: string | undefined
    try {
      process.env.RBAC_BYPASS = 'true'
      const tokenRes = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin,attendance:approve`)
      token = (tokenRes.body as { token?: string } | undefined)?.token
      expect(token).toBeTruthy()
      if (!token) return
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

      const settingsRes = await requestJson(`${baseUrl}/api/attendance/settings`, { headers: { Authorization: `Bearer ${token}` } })
      expect(settingsRes.status).toBe(200)
      originalSettings = ((settingsRes.body as { data?: Record<string, unknown> } | undefined)?.data ?? {}) as Record<string, unknown>

      const ruleRes = await requestJson(`${baseUrl}/api/attendance/overtime-rules`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: `o3-ot-${runSuffix}`, minMinutes: 0, roundingMinutes: 1, maxMinutesPerDay: 0 }),
      })
      expect([201, 409]).toContain(ruleRes.status)
      overtimeRuleId = (ruleRes.body as { data?: { id?: string } } | undefined)?.data?.id
      if (!overtimeRuleId) {
        const listRes = await requestJson(`${baseUrl}/api/attendance/overtime-rules`, { headers: { Authorization: `Bearer ${token}` } })
        const items = (listRes.body as { data?: { items?: { id?: string; name?: string }[] } } | undefined)?.data?.items ?? []
        overtimeRuleId = items.find(item => item.name === `o3-ot-${runSuffix}`)?.id
      }
      expect(overtimeRuleId).toBeTruthy()
      if (!overtimeRuleId) return

      await pool.query('DELETE FROM attendance_holidays WHERE org_id = $1 AND holiday_date = $2', ['default', holidayDate])
      await pool.query(
        `INSERT INTO attendance_holidays (id, org_id, holiday_date, name, is_working_day, origin)
         VALUES ($1, 'default', $2, $3, false, 'national')`,
        [holidayId, holidayDate, `O3 Holiday ${runSuffix}`],
      )

      const saveSettingsRes = await requestJson(`${baseUrl}/api/attendance/settings`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ overtimeSegmentation: { enabled: true } }),
      })
      expect(saveSettingsRes.status).toBe(200)

      const createAndApprove = async (workDateInput: string, minutes: number) => {
        const createRes = await requestJson(`${baseUrl}/api/attendance/requests`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ workDate: workDateInput, requestType: 'overtime', overtimeRuleId, minutes }),
        })
        expect(createRes.status, createRes.raw).toBe(201)
        const requestId = (createRes.body as { data?: { request?: { id?: string } } } | undefined)?.data?.request?.id
        expect(requestId).toBeTruthy()
        if (!requestId) return null
        createdRequestIds.push(requestId)
        const approveRes = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/approve`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ comment: 'approve o3' }),
        })
        expect(approveRes.status, approveRes.raw).toBe(200)
        return requestId
      }

      await createAndApprove(workDate, 45)
      await createAndApprove(restDate, 75)
      await createAndApprove(holidayDate, 105)

      const recordsRes = await requestJson(
        `${baseUrl}/api/attendance/records?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      expect(recordsRes.status, recordsRes.raw).toBe(200)
      const recordItems = ((recordsRes.body as { data?: { items?: Array<Record<string, unknown>> } } | undefined)?.data?.items ?? [])
      const recordsByDate = new Map(recordItems.map(item => [dateOnlyForTest(item.work_date ?? item.workDate), item]))
      const expectRecordBuckets = (date: string, buckets: Record<string, number>) => {
        const record = recordsByDate.get(date)
        expect(record, `missing record for ${date}`).toBeTruthy()
        const meta = (record?.meta ?? {}) as Record<string, unknown>
        const projection = (meta.approvedOvertimeSegmentation ?? meta.approved_overtime_segmentation ?? {}) as Record<string, unknown>
        const reportValues = (record?.report_values ?? record?.reportValues ?? {}) as Record<string, unknown>
        expect(Number(meta.overtime_minutes ?? meta.overtimeMinutes ?? 0)).toBe(buckets.total)
        expect(projection).toMatchObject({
          version: 1,
          workdayOvertimeMinutes: buckets.workday,
          restdayOvertimeMinutes: buckets.restday,
          holidayOvertimeMinutes: buckets.holiday,
          compTimeGrantMinutes: buckets.total,
        })
        expect(Number(reportValues.overtime_approval_duration ?? 0)).toBe(buckets.total)
        expect(Number(reportValues.workday_overtime_duration ?? 0)).toBe(buckets.workday)
        expect(Number(reportValues.restday_overtime_duration ?? 0)).toBe(buckets.restday)
        expect(Number(reportValues.holiday_overtime_duration ?? 0)).toBe(buckets.holiday)
      }
      expectRecordBuckets(workDate, { total: 45, workday: 45, restday: 0, holiday: 0 })
      expectRecordBuckets(restDate, { total: 75, workday: 0, restday: 75, holiday: 0 })
      expectRecordBuckets(holidayDate, { total: 105, workday: 0, restday: 0, holiday: 105 })

      const summaryRes = await requestJson(
        `${baseUrl}/api/attendance/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      expect(summaryRes.status, summaryRes.raw).toBe(200)
      const summary = ((summaryRes.body as { data?: Record<string, unknown> } | undefined)?.data ?? {}) as Record<string, unknown>
      expect(Number(summary.overtime_minutes ?? 0)).toBe(225)
      expect(Number(summary.workday_overtime_minutes ?? 0)).toBe(45)
      expect(Number(summary.restday_overtime_minutes ?? 0)).toBe(75)
      expect(Number(summary.holiday_overtime_minutes ?? 0)).toBe(105)
      expect(Number(summary.comp_time_grant_minutes ?? 0)).toBe(225)
    } finally {
      if (token && Object.keys(originalSettings).length > 0) {
        await requestJson(`${baseUrl}/api/attendance/settings`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(originalSettings),
        }).catch(() => undefined)
      }
      if (createdRequestIds.length > 0) {
        await pool.query('DELETE FROM attendance_events WHERE meta->>\'requestId\' = ANY($1::text[])', [createdRequestIds]).catch(() => undefined)
        await pool.query('DELETE FROM attendance_records WHERE user_id = $1 AND work_date::text = ANY($2::text[])', [userId, [workDate, restDate, holidayDate]]).catch(() => undefined)
        await pool.query('DELETE FROM attendance_requests WHERE id = ANY($1::uuid[])', [createdRequestIds]).catch(() => undefined)
      }
      await pool.query('DELETE FROM attendance_holidays WHERE id = $1', [holidayId]).catch(() => undefined)
      if (overtimeRuleId) await pool.query('DELETE FROM attendance_overtime_rules WHERE id = $1', [overtimeRuleId]).catch(() => undefined)
      if (previousRbacBypass === undefined) delete process.env.RBAC_BYPASS
      else process.env.RBAC_BYPASS = previousRbacBypass
      await pool.end().catch(() => undefined)
    }
  })

  it('④ 加班银行 v1-2b — LeaveOffsetPolicy rule-driven deduction (dormant byte-identical / block / partial / NO double-deduct)', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return
    const runSuffix = Date.now().toString(36)
    const previousRbacBypass = process.env.RBAC_BYPASS
    const pool = new Pool({ connectionString: dbUrl })
    const createdRequestIds: string[] = []
    const users = {
      dormant: `attendance-v12b-dormant-${runSuffix}`,
      block: `attendance-v12b-block-${runSuffix}`,
      short: `attendance-v12b-short-${runSuffix}`,
      partial: `attendance-v12b-partial-${runSuffix}`,
      nodbl: `attendance-v12b-nodbl-${runSuffix}`,
    }
    let adminToken: string | undefined
    let originalSettings: Record<string, unknown> = {}
    try {
      process.env.RBAC_BYPASS = 'true'
      const tokenFor = async (uid: string) => {
        const r = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(uid)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`)
        return (r.body as { token?: string } | undefined)?.token
      }
      const hdr = (t: string) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' })
      adminToken = await tokenFor(`attendance-v12b-admin-${runSuffix}`)
      if (!adminToken) return
      const tokens: Record<string, string> = {}
      for (const [k, uid] of Object.entries(users)) { const t = await tokenFor(uid); if (!t) return; tokens[k] = t }
      const ensureLeaveType = async (code: string) => {
        const res = await requestJson(`${baseUrl}/api/attendance/leave-types`, { method: 'POST', headers: hdr(adminToken!), body: JSON.stringify({ code, name: `${code} ${runSuffix}`, paid: false, requiresApproval: true }) })
        expect([201, 409]).toContain(res.status)
        let id = (res.body as { data?: { id?: string } } | undefined)?.data?.id
        if (!id) { const list = await requestJson(`${baseUrl}/api/attendance/leave-types?isActive=true`, { headers: hdr(adminToken!) }); id = ((list.body as { data?: { items?: { id?: string; code?: string }[] } } | undefined)?.data?.items ?? []).find(i => i.code === code)?.id }
        expect(id).toBeTruthy(); return id as string
      }
      const personalLeaveId = await ensureLeaveType('personal_leave')
      const compTimeLtId = await ensureLeaveType('comp_time')
      const insertCompLot = async (userId: string, remaining: number) => (await pool.query(
        `INSERT INTO attendance_leave_balances (org_id, user_id, leave_type_code, amount_minutes, remaining_minutes, source_type, source_key, status, granted_at)
         VALUES ('default', $1, 'comp_time', $2, $2, 'overtime_conversion', $3, 'active', '2026-01-01') RETURNING id`,
        [userId, remaining, `v12b:${runSuffix}:${userId}`])).rows[0].id as string
      const compRemaining = async (userId: string) => Number((await pool.query(`SELECT COALESCE(SUM(remaining_minutes),0) AS r FROM attendance_leave_balances WHERE user_id=$1 AND leave_type_code='comp_time'`, [userId])).rows[0].r)
      const createLeave = async (token: string, leaveTypeId: string, workDate: string, minutes: number) => {
        const r = await requestJson(`${baseUrl}/api/attendance/requests`, { method: 'POST', headers: hdr(token), body: JSON.stringify({ workDate, requestType: 'leave', leaveTypeId, minutes }) })
        expect(r.status).toBe(201); const id = (r.body as { data?: { request?: { id?: string } } } | undefined)?.data?.request?.id; createdRequestIds.push(id as string); return id as string
      }
      const approve = (token: string, id: string) => requestJson(`${baseUrl}/api/attendance/requests/${id}/approve`, { method: 'POST', headers: hdr(token), body: JSON.stringify({ comment: 'ok' }) })
      const putSettings = (body: Record<string, unknown>) => requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers: hdr(adminToken!), body: JSON.stringify(body) })
      originalSettings = ((await requestJson(`${baseUrl}/api/attendance/settings`, { headers: hdr(adminToken!) })).body as { data?: Record<string, unknown> } | undefined)?.data ?? {}

      // (1) DORMANT (policy off): personal_leave deducts NOWHERE → comp_time untouched (byte-identical floor).
      await putSettings({ leaveBalanceDeductionPolicy: { enabled: false, rules: [] } })
      await insertCompLot(users.dormant, 120)
      expect((await approve(tokens.dormant, await createLeave(tokens.dormant, personalLeaveId, '2026-09-20', 60))).status).toBe(200)
      expect(await compRemaining(users.dormant)).toBe(120)

      // (2) ENABLED block, sufficient: personal_leave → comp_time pool deducts.
      await putSettings({ leaveBalanceDeductionPolicy: { enabled: true, rules: [{ requestLeaveType: 'personal_leave', deductFrom: ['comp_time'], insufficient: 'block' }] } })
      await insertCompLot(users.block, 120)
      expect((await approve(tokens.block, await createLeave(tokens.block, personalLeaveId, '2026-09-20', 60))).status).toBe(200)
      expect(await compRemaining(users.block)).toBe(60)

      // (3) ENABLED block, insufficient: 422 + rollback (request pending, balance untouched).
      await insertCompLot(users.short, 60)
      const rShort = await createLeave(tokens.short, personalLeaveId, '2026-09-20', 120)
      expect((await approve(tokens.short, rShort)).status).toBe(422)
      expect((await pool.query('SELECT status FROM attendance_requests WHERE id=$1', [rShort])).rows[0].status).toBe('pending')
      expect(await compRemaining(users.short)).toBe(60)

      // (4) ENABLED partial, insufficient: deduct AVAILABLE, APPROVE (no throw); shortfall = 200−120 = 账3 absence.
      await putSettings({ leaveBalanceDeductionPolicy: { enabled: true, rules: [{ requestLeaveType: 'personal_leave', deductFrom: ['comp_time'], insufficient: 'partial_unpaid_absence' }] } })
      await insertCompLot(users.partial, 120)
      expect((await approve(tokens.partial, await createLeave(tokens.partial, personalLeaveId, '2026-09-20', 200))).status).toBe(200)
      expect(await compRemaining(users.partial)).toBe(0)

      // (5) NO DOUBLE-DEDUCT (the load-bearing invariant): a comp_time leave with a comp_time rule → only the
      // dedicated C3 block deducts; the rule path SKIPS comp_time. Balance drops by 60 ONCE (not to 0).
      await putSettings({ leaveBalanceDeductionPolicy: { enabled: true, rules: [{ requestLeaveType: 'comp_time', deductFrom: ['comp_time'], insufficient: 'block' }] } })
      await insertCompLot(users.nodbl, 120)
      expect((await approve(tokens.nodbl, await createLeave(tokens.nodbl, compTimeLtId, '2026-09-20', 60))).status).toBe(200)
      expect(await compRemaining(users.nodbl)).toBe(60)
    } finally {
      if (adminToken && Object.keys(originalSettings).length > 0) await requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(originalSettings) }).catch(() => undefined)
      for (const uid of Object.values(users)) {
        await pool.query('DELETE FROM attendance_leave_balance_events WHERE user_id=$1', [uid]).catch(() => undefined)
        await pool.query('DELETE FROM attendance_leave_balances WHERE user_id=$1', [uid]).catch(() => undefined)
      }
      if (createdRequestIds.length) await pool.query(`DELETE FROM attendance_requests WHERE id = ANY($1::uuid[])`, [createdRequestIds]).catch(() => undefined)
      await pool.end().catch(() => undefined)
      if (previousRbacBypass === undefined) delete process.env.RBAC_BYPASS; else process.env.RBAC_BYPASS = previousRbacBypass
    }
  })

  it('④ C3 — comp_time leave approval deducts balance FIFO; insufficient blocks (422) with no deduction; replay no double-deduct', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return
    const runSuffix = Date.now().toString(36)
    const uOk = `attendance-c3-ok-${runSuffix}`
    const uShort = `attendance-c3-short-${runSuffix}`
    const uFifo = `attendance-c3-fifo-${runSuffix}`
    const previousRbacBypass = process.env.RBAC_BYPASS
    const pool = new Pool({ connectionString: dbUrl })
    const createdRequestIds: string[] = []
    try {
      process.env.RBAC_BYPASS = 'true'
      const tokenFor = async (uid: string) => {
        const r = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(uid)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`)
        return (r.body as { token?: string } | undefined)?.token
      }
      const tokenOk = await tokenFor(uOk)
      const tokenShort = await tokenFor(uShort)
      const tokenFifo = await tokenFor(uFifo)
      if (!tokenOk || !tokenShort || !tokenFifo) return
      const hdr = (t: string) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' })

      // comp_time leave type (explicit code='comp_time'); idempotent across reruns (409 -> look it up).
      const ltRes = await requestJson(`${baseUrl}/api/attendance/leave-types`, { method: 'POST', headers: hdr(tokenOk), body: JSON.stringify({ code: 'comp_time', name: `Comp Time ${runSuffix}`, paid: false, requiresApproval: true }) })
      expect([201, 409]).toContain(ltRes.status)
      let leaveTypeId = (ltRes.body as { data?: { id?: string } } | undefined)?.data?.id
      if (!leaveTypeId) {
        const list = await requestJson(`${baseUrl}/api/attendance/leave-types?isActive=true`, { headers: { Authorization: `Bearer ${tokenOk}` } })
        const items = (list.body as { data?: { items?: { id?: string; code?: string }[] } } | undefined)?.data?.items ?? []
        leaveTypeId = items.find(i => i.code === 'comp_time')?.id
      }
      expect(leaveTypeId).toBeTruthy()

      const insertLot = async (userId: string, opts: { amount: number; remaining: number; expiresAt: string | null; grantedAt: string; tag: string }) => {
        const r = await pool.query(
          `INSERT INTO attendance_leave_balances
             (org_id, user_id, leave_type_code, amount_minutes, remaining_minutes, source_type, source_key, status, granted_at, expires_at)
           VALUES ('default', $1, 'comp_time', $2, $3, 'overtime_conversion', $4, 'active', $5, $6) RETURNING id`,
          [userId, opts.amount, opts.remaining, `c3:${runSuffix}:${opts.tag}`, opts.grantedAt, opts.expiresAt],
        )
        return r.rows[0].id as string
      }
      const createLeave = async (token: string, workDate: string, minutes: number) => {
        const r = await requestJson(`${baseUrl}/api/attendance/requests`, { method: 'POST', headers: hdr(token), body: JSON.stringify({ workDate, requestType: 'leave', leaveTypeId, minutes }) })
        expect(r.status).toBe(201)
        const id = (r.body as { data?: { request?: { id?: string } } } | undefined)?.data?.request?.id
        expect(id).toBeTruthy()
        createdRequestIds.push(id as string)
        return id as string
      }
      const approve = (token: string, id: string) => requestJson(`${baseUrl}/api/attendance/requests/${id}/approve`, { method: 'POST', headers: hdr(token), body: JSON.stringify({ comment: 'ok' }) })
      const lotRow = async (id: string) => (await pool.query('SELECT remaining_minutes, status FROM attendance_leave_balances WHERE id = $1', [id])).rows[0] as { remaining_minutes: number; status: string }
      const deductEvents = async (reqId: string) => (await pool.query(
        `SELECT balance_id, delta_minutes, event_type FROM attendance_leave_balance_events
           WHERE source_type = 'comp_time_leave' AND source_id = $1 ORDER BY delta_minutes ASC`,
        [reqId],
      )).rows as { balance_id: string; delta_minutes: number; event_type: string }[]

      // (a) sufficient → FIFO across two lots. Lot A expires sooner (consumed first); Lot B no-expiry.
      const lotA = await insertLot(uOk, { amount: 120, remaining: 120, expiresAt: '2099-06-01', grantedAt: '2026-01-01', tag: 'A' })
      const lotB = await insertLot(uOk, { amount: 120, remaining: 120, expiresAt: null, grantedAt: '2026-02-01', tag: 'B' })
      const reqOk = await createLeave(tokenOk, '2026-09-10', 180)
      expect((await approve(tokenOk, reqOk)).status).toBe(200)
      expect(await lotRow(lotA)).toMatchObject({ remaining_minutes: 0, status: 'exhausted' })
      expect(await lotRow(lotB)).toMatchObject({ remaining_minutes: 60, status: 'active' })
      const evOk = await deductEvents(reqOk)
      expect(evOk.map(e => ({ balance_id: e.balance_id, delta: Number(e.delta_minutes), type: e.event_type }))).toEqual([
        { balance_id: lotA, delta: -120, type: 'deduct' }, // FIFO: soonest-expiry lot drained first
        { balance_id: lotB, delta: -60, type: 'deduct' },
      ])

      // (c) replay: re-approving the resolved request is rejected; balance + events unchanged.
      expect((await approve(tokenOk, reqOk)).status).toBe(400)
      expect(await lotRow(lotA)).toMatchObject({ remaining_minutes: 0, status: 'exhausted' })
      expect(await lotRow(lotB)).toMatchObject({ remaining_minutes: 60, status: 'active' })
      expect(await deductEvents(reqOk)).toHaveLength(2)

      // (b) insufficient → 422, approval blocked, request stays pending, balance untouched, no deduct event.
      const lotShort = await insertLot(uShort, { amount: 60, remaining: 60, expiresAt: null, grantedAt: '2026-01-01', tag: 'S' })
      const reqShort = await createLeave(tokenShort, '2026-09-11', 120)
      const shortRes = await approve(tokenShort, reqShort)
      expect(shortRes.status).toBe(422)
      expect((shortRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('COMP_TIME_BALANCE_INSUFFICIENT')
      const reqRow = (await pool.query('SELECT status FROM attendance_requests WHERE id = $1', [reqShort])).rows[0] as { status: string } | undefined
      expect(reqRow?.status).toBe('pending')
      expect(await lotRow(lotShort)).toMatchObject({ remaining_minutes: 60, status: 'active' })
      expect(await deductEvents(reqShort)).toHaveLength(0)

      // (d) FIFO tiebreak by granted_at among NULL-expiry lots — this is the ordering that actually
      // fires in production today (every C2 grant has expires_at=NULL, so all lots fall in the
      // NULLS-LAST bucket and only granted_at ASC discriminates). Older grant must drain first.
      const lotOld = await insertLot(uFifo, { amount: 120, remaining: 120, expiresAt: null, grantedAt: '2026-01-01', tag: 'old' })
      const lotNew = await insertLot(uFifo, { amount: 120, remaining: 120, expiresAt: null, grantedAt: '2026-02-01', tag: 'new' })
      const reqFifo = await createLeave(tokenFifo, '2026-09-12', 180)
      expect((await approve(tokenFifo, reqFifo)).status).toBe(200)
      expect(await lotRow(lotOld)).toMatchObject({ remaining_minutes: 0, status: 'exhausted' })
      expect(await lotRow(lotNew)).toMatchObject({ remaining_minutes: 60, status: 'active' })
      expect((await deductEvents(reqFifo)).map(e => ({ balance_id: e.balance_id, delta: Number(e.delta_minutes) }))).toEqual([
        { balance_id: lotOld, delta: -120 }, // oldest grant drained first
        { balance_id: lotNew, delta: -60 },
      ])
    } finally {
      await pool.query('DELETE FROM attendance_leave_balance_events WHERE user_id = ANY($1::text[])', [[uOk, uShort, uFifo]]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_leave_balances WHERE user_id = ANY($1::text[])', [[uOk, uShort, uFifo]]).catch(() => undefined)
      if (createdRequestIds.length > 0) {
        await pool.query('DELETE FROM attendance_requests WHERE id = ANY($1::uuid[])', [createdRequestIds]).catch(() => undefined)
      }
      if (previousRbacBypass === undefined) delete process.env.RBAC_BYPASS
      else process.env.RBAC_BYPASS = previousRbacBypass
      await pool.end().catch(() => undefined)
    }
  })

  it('④/年假 L3 — annual leave approval deducts STANDARD-DAY minutes; gated on annualLeavePolicy.enabled; insufficient/non-whole → 422 + pending; replay no double-deduct', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return
    const runSuffix = Date.now().toString(36)
    const uFull = `al-l3-full-${runSuffix}`
    const uHalf = `al-l3-half-${runSuffix}`
    const uShort = `al-l3-short-${runSuffix}`
    const uOdd = `al-l3-odd-${runSuffix}`
    const uOff = `al-l3-off-${runSuffix}`
    const uMulti = `al-l3-multi-${runSuffix}`
    const allUsers = [uFull, uHalf, uShort, uOdd, uOff, uMulti]
    const previousRbacBypass = process.env.RBAC_BYPASS
    const pool = new Pool({ connectionString: dbUrl })
    const createdRequestIds: string[] = []
    const hdr = (t: string) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' })
    const tokenFor = async (uid: string) => {
      const r = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(uid)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`)
      return (r.body as { token?: string } | undefined)?.token
    }
    let adminTok: string | undefined
    let origPolicy: Record<string, unknown> = { enabled: false }
    let leaveTypeId: string | undefined
    let createdLeaveType = false
    let origDefaultMinutesPerDay: number | undefined
    try {
      process.env.RBAC_BYPASS = 'true'
      adminTok = await tokenFor(`al-l3-admin-${runSuffix}`)
      if (!adminTok) return

      // policy standardDayMinutes=480, deliberately DISTINCT from the leave type's defaultMinutesPerDay=600 below,
      // so a full (600-min) day deducts the 8h STANDARD day (480), proving the entitlement basis ≠ scheduled minutes.
      const origRes = await requestJson(`${baseUrl}/api/attendance/settings`, { headers: { Authorization: `Bearer ${adminTok}` } })
      origPolicy = ((origRes.body as { data?: { annualLeavePolicy?: Record<string, unknown> } } | undefined)?.data?.annualLeavePolicy) ?? { enabled: false }
      const setEngine = (enabled: boolean) => requestJson(`${baseUrl}/api/attendance/settings`, {
        method: 'PUT', headers: hdr(adminTok!),
        body: JSON.stringify({ annualLeavePolicy: {
          enabled, tenureMode: 'cumulative_service', standardDayMinutes: 480,
          tiers: [{ minYears: 1, maxYears: null, days: 5 }], carryover: { enabled: false }, timezone: 'Asia/Shanghai',
        } }),
      })

      // annual leave type — code MUST be 'annual' (the hook's discriminator). Pin defaultMinutesPerDay=600 regardless
      // of any pre-existing 'annual' type (request metadata snapshots it at creation time, so set it BEFORE creating).
      const ltRes = await requestJson(`${baseUrl}/api/attendance/leave-types`, { method: 'POST', headers: hdr(adminTok), body: JSON.stringify({ code: 'annual', name: `Annual ${runSuffix}`, paid: true, requiresApproval: true, defaultMinutesPerDay: 600 }) })
      expect([201, 409]).toContain(ltRes.status)
      createdLeaveType = ltRes.status === 201
      leaveTypeId = (ltRes.body as { data?: { id?: string } } | undefined)?.data?.id
      if (!leaveTypeId) {
        const list = await requestJson(`${baseUrl}/api/attendance/leave-types?isActive=true`, { headers: { Authorization: `Bearer ${adminTok}` } })
        const items = (list.body as { data?: { items?: { id?: string; code?: string }[] } } | undefined)?.data?.items ?? []
        leaveTypeId = items.find(i => i.code === 'annual')?.id
      }
      expect(leaveTypeId).toBeTruthy()
      // Capture the original default_minutes_per_day BEFORE mutating it. finally restores a REUSED type to this
      // value (and DELETEs a type this test created) so the global 'annual' leave type is never left polluted for
      // later cases in the same process/DB — the exact "local dirty-DB pollution" hazard we've hit before.
      origDefaultMinutesPerDay = (await pool.query(`SELECT default_minutes_per_day FROM attendance_leave_types WHERE id = $1`, [leaveTypeId])).rows[0]?.default_minutes_per_day
      await pool.query(`UPDATE attendance_leave_types SET default_minutes_per_day = 600 WHERE id = $1`, [leaveTypeId])

      const grantLot = async (userId: string, remaining: number, tag: string) => (await pool.query(
        `INSERT INTO attendance_leave_balances (org_id, user_id, leave_type_code, amount_minutes, remaining_minutes, source_type, source_key, status, granted_at)
         VALUES ('default', $1, 'annual', $2, $2, 'annual_accrual', $3, 'active', '2026-01-01') RETURNING id`,
        [userId, remaining, `l3:${runSuffix}:${tag}`])).rows[0].id as string
      const createLeave = async (token: string, workDate: string, minutes: number) => {
        const r = await requestJson(`${baseUrl}/api/attendance/requests`, { method: 'POST', headers: hdr(token), body: JSON.stringify({ workDate, requestType: 'leave', leaveTypeId, minutes }) })
        expect(r.status, JSON.stringify(r.body)).toBe(201)
        const id = (r.body as { data?: { request?: { id?: string } } } | undefined)?.data?.request?.id
        expect(id).toBeTruthy()
        createdRequestIds.push(id as string)
        return id as string
      }
      const approve = (token: string, id: string) => requestJson(`${baseUrl}/api/attendance/requests/${id}/approve`, { method: 'POST', headers: hdr(token), body: JSON.stringify({ comment: 'ok' }) })
      const lotRemaining = async (id: string) => Number((await pool.query('SELECT remaining_minutes FROM attendance_leave_balances WHERE id = $1', [id])).rows[0].remaining_minutes)
      const reqStatus = async (id: string) => (await pool.query('SELECT status FROM attendance_requests WHERE id = $1', [id])).rows[0]?.status as string | undefined
      const annualDeducts = async (reqId: string) => (await pool.query(
        `SELECT delta_minutes FROM attendance_leave_balance_events WHERE source_type = 'annual_leave' AND source_id = $1`, [reqId])).rows.map(r => Number(r.delta_minutes))

      // ── ENGINE ON ──
      expect((await setEngine(true)).status).toBe(200)

      // (A) full day: 600 scheduled minutes → 480 STANDARD-day minutes deducted (basis ≠ raw minutes).
      const lotFull = await grantLot(uFull, 480, 'full')
      const tokFull = await tokenFor(uFull)
      const reqFull = await createLeave(tokFull!, '2026-09-10', 600)
      expect((await approve(tokFull!, reqFull)).status).toBe(200)
      expect(await lotRemaining(lotFull)).toBe(0)
      expect(await annualDeducts(reqFull)).toEqual([-480])

      // (B) half day: 300 scheduled → 240 standard-day deducted.
      const lotHalf = await grantLot(uHalf, 480, 'half')
      const tokHalf = await tokenFor(uHalf)
      const reqHalf = await createLeave(tokHalf!, '2026-09-10', 300)
      expect((await approve(tokHalf!, reqHalf)).status).toBe(200)
      expect(await lotRemaining(lotHalf)).toBe(240)
      expect(await annualDeducts(reqHalf)).toEqual([-240])

      // (C) insufficient: lot 240 < 480 needed → 422, request stays PENDING, lot untouched, no event.
      const lotShort = await grantLot(uShort, 240, 'short')
      const tokShort = await tokenFor(uShort)
      const reqShort = await createLeave(tokShort!, '2026-09-10', 600)
      const shortRes = await approve(tokShort!, reqShort)
      expect(shortRes.status).toBe(422)
      expect((shortRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('ANNUAL_LEAVE_BALANCE_INSUFFICIENT')
      expect(await reqStatus(reqShort)).toBe('pending')
      expect(await lotRemaining(lotShort)).toBe(240)
      expect(await annualDeducts(reqShort)).toHaveLength(0)

      // (D) non-whole standard-day: 7 scheduled → (7×480)/600 = 5.6 → 422 NOT_WHOLE, pending, no deduction.
      const lotOdd = await grantLot(uOdd, 480, 'odd')
      const tokOdd = await tokenFor(uOdd)
      const reqOdd = await createLeave(tokOdd!, '2026-09-10', 7)
      const oddRes = await approve(tokOdd!, reqOdd)
      expect(oddRes.status).toBe(422)
      expect((oddRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('ANNUAL_LEAVE_DEDUCTION_NOT_WHOLE')
      expect(await reqStatus(reqOdd)).toBe('pending')
      expect(await lotRemaining(lotOdd)).toBe(480)
      expect(await annualDeducts(reqOdd)).toHaveLength(0)

      // (D2) single-day v1 enforced: 1200 scheduled minutes > 600 defaultMinutesPerDay (a multi-day request on one
      // workDate) → 422 MULTI_DAY_UNSUPPORTED, request stays pending, NO over-deduction.
      const lotMulti = await grantLot(uMulti, 4800, 'multi')
      const tokMulti = await tokenFor(uMulti)
      const reqMulti = await createLeave(tokMulti!, '2026-09-10', 1200)
      const multiRes = await approve(tokMulti!, reqMulti)
      expect(multiRes.status).toBe(422)
      expect((multiRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('ANNUAL_LEAVE_MULTI_DAY_UNSUPPORTED')
      expect(await reqStatus(reqMulti)).toBe('pending')
      expect(await lotRemaining(lotMulti)).toBe(4800)
      expect(await annualDeducts(reqMulti)).toHaveLength(0)

      // (E) replay: re-approve the resolved full-day request → 400; no double-deduct.
      expect((await approve(tokFull!, reqFull)).status).toBe(400)
      expect(await lotRemaining(lotFull)).toBe(0)
      expect(await annualDeducts(reqFull)).toHaveLength(1)

      // ── ENGINE OFF → zero regression: approval succeeds, balance NEVER touched ──
      expect((await setEngine(false)).status).toBe(200)
      const lotOff = await grantLot(uOff, 480, 'off')
      const tokOff = await tokenFor(uOff)
      const reqOff = await createLeave(tokOff!, '2026-09-10', 600)
      expect((await approve(tokOff!, reqOff)).status).toBe(200)
      expect(await lotRemaining(lotOff)).toBe(480)
      expect(await annualDeducts(reqOff)).toHaveLength(0)
    } finally {
      if (adminTok) {
        await requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers: hdr(adminTok), body: JSON.stringify({ annualLeavePolicy: origPolicy }) }).catch(() => undefined)
      }
      await pool.query('DELETE FROM attendance_leave_balance_events WHERE user_id = ANY($1::text[])', [allUsers]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_leave_balances WHERE user_id = ANY($1::text[])', [allUsers]).catch(() => undefined)
      if (createdRequestIds.length > 0) {
        await pool.query('DELETE FROM attendance_requests WHERE id = ANY($1::uuid[])', [createdRequestIds]).catch(() => undefined)
      }
      // restore the global 'annual' leave type (requests already deleted, so a created type is FK-free to drop):
      // DELETE if this test created it, else restore its original default_minutes_per_day — no cross-test pollution.
      if (leaveTypeId) {
        if (createdLeaveType) {
          await pool.query('DELETE FROM attendance_leave_types WHERE id = $1', [leaveTypeId]).catch(() => undefined)
        } else if (origDefaultMinutesPerDay !== undefined && origDefaultMinutesPerDay !== null) {
          await pool.query('UPDATE attendance_leave_types SET default_minutes_per_day = $2 WHERE id = $1', [leaveTypeId, origDefaultMinutesPerDay]).catch(() => undefined)
        }
      }
      if (previousRbacBypass === undefined) delete process.env.RBAC_BYPASS
      else process.env.RBAC_BYPASS = previousRbacBypass
      await pool.end().catch(() => undefined)
    }
  })

  it('④ C4 — grant stamps expires_at iff expiresInDays set; scheduler tick expires aged lots once (NULL/future survive)', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return
    const runSuffix = Date.now().toString(36)
    const userId = `attendance-c4wire-${runSuffix}`
    const previousRbacBypass = process.env.RBAC_BYPASS
    const pool = new Pool({ connectionString: dbUrl })
    const scheduler = new AttendanceScheduler({
      expiryService: new AttendanceExpiryService(async <T = unknown>(sql, params = []) => {
        const result = await pool.query<T>(sql, params)
        return { rows: result.rows, rowCount: result.rowCount }
      }),
    })
    let token: string | undefined
    let originalSettings: Record<string, unknown> = {}
    const createdRequestIds: string[] = []
    try {
      process.env.RBAC_BYPASS = 'true'
      const tokenRes = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`)
      token = (tokenRes.body as { token?: string } | undefined)?.token
      if (!token) return
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      const origRes = await requestJson(`${baseUrl}/api/attendance/settings`, { headers: { Authorization: `Bearer ${token}` } })
      originalSettings = ((origRes.body as { data?: Record<string, unknown> } | undefined)?.data ?? {}) as Record<string, unknown>

      const otRuleRes = await requestJson(`${baseUrl}/api/attendance/overtime-rules`, { method: 'POST', headers, body: JSON.stringify({ name: `c4wire-ot-${runSuffix}`, minMinutes: 30 }) })
      expect([201, 409]).toContain(otRuleRes.status)
      let overtimeRuleId = (otRuleRes.body as { data?: { id?: string } } | undefined)?.data?.id
      if (!overtimeRuleId) {
        const list = await requestJson(`${baseUrl}/api/attendance/overtime-rules`, { headers: { Authorization: `Bearer ${token}` } })
        overtimeRuleId = ((list.body as { data?: { items?: { id?: string; name?: string }[] } } | undefined)?.data?.items ?? []).find(i => i.name === `c4wire-ot-${runSuffix}`)?.id
      }
      expect(overtimeRuleId).toBeTruthy()
      const setCompTime = (body: Record<string, unknown>) => requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers, body: JSON.stringify({ compTimeFromOvertime: body }) })
      const approveOvertime = async (workDate: string, minutes: number) => {
        const create = await requestJson(`${baseUrl}/api/attendance/requests`, { method: 'POST', headers, body: JSON.stringify({ workDate, requestType: 'overtime', overtimeRuleId, minutes }) })
        expect(create.status).toBe(201)
        const id = (create.body as { data?: { request?: { id?: string } } } | undefined)?.data?.request?.id as string
        createdRequestIds.push(id)
        expect((await requestJson(`${baseUrl}/api/attendance/requests/${id}/approve`, { method: 'POST', headers, body: JSON.stringify({ comment: 'c4' }) })).status).toBe(200)
        return id
      }
      const lotFor = async (otId: string) => (await pool.query(
        `SELECT id, remaining_minutes, status, expires_at,
                (expires_at - granted_at = interval '720 hours') AS exact_30d
           FROM attendance_leave_balances WHERE org_id = 'default' AND source_key = $1`,
        [`overtime_conversion:${otId}`],
      )).rows[0] as { id: string; remaining_minutes: number; status: string; expires_at: string | null; exact_30d: boolean | null }
      const expireEvents = async (balanceId: string) => (await pool.query(
        `SELECT delta_minutes, source_type FROM attendance_leave_balance_events WHERE balance_id = $1 AND event_type = 'expire'`,
        [balanceId],
      )).rows as { delta_minutes: number; source_type: string }[]

      // (1) enabled + expiresInDays=30 → grant stamps expires_at = granted_at + 30×24h (exact).
      expect((await setCompTime({ enabled: true, expiresInDays: 30 })).status).toBe(200)
      const otFuture = await approveOvertime('2026-09-25', 120)
      const lotFuture = await lotFor(otFuture)
      expect(lotFuture.status).toBe('active')
      expect(lotFuture.expires_at).not.toBeNull()
      expect(lotFuture.exact_30d).toBe(true) // expires_at - granted_at === 720h (DST-free fixed duration)

      // (2) enabled + expiresInDays=null → grant keeps expires_at NULL (unchanged C2 behaviour).
      expect((await setCompTime({ enabled: true, expiresInDays: null })).status).toBe(200)
      const otNull = await approveOvertime('2026-09-26', 60)
      const lotNull = await lotFor(otNull)
      expect(lotNull.expires_at).toBeNull()

      // (3) a scan with nothing of OURS past-due → our future + NULL lots both survive. The scan is
      //     global (all orgs/users), so we assert OUR lots are absent from the result rather than the
      //     whole result being empty — a stray past-due lot from another test must not flake this.
      const tick3 = (await scheduler.tick()).map(r => r.balanceId)
      expect(tick3).not.toContain(lotFuture.id)
      expect(tick3).not.toContain(lotNull.id)
      expect((await lotFor(otFuture)).status).toBe('active')
      expect((await lotFor(otNull)).status).toBe('active')

      // (4) age the future lot past its expiry, then tick → it expires once (remaining=0 + one expire event);
      //     the NULL lot is still untouched.
      await pool.query("UPDATE attendance_leave_balances SET expires_at = now() - interval '1 hour' WHERE id = $1", [lotFuture.id])
      const firstTick = await scheduler.tick()
      expect(firstTick.find(r => r.balanceId === lotFuture.id)).toEqual({ orgId: 'default', userId, balanceId: lotFuture.id, expiredMinutes: 120 })
      expect(await lotFor(otFuture)).toMatchObject({ remaining_minutes: 0, status: 'expired' })
      expect(await expireEvents(lotFuture.id)).toEqual([{ delta_minutes: -120, source_type: 'comp_time_expiry' }])
      expect((await lotFor(otNull)).status).toBe('active')

      // (5) repeat tick → our lot is not re-expired. Idempotency is proven by OUR expire-event count
      //     staying 1 (user-scoped), not by the global scan being empty.
      expect((await scheduler.tick()).map(r => r.balanceId)).not.toContain(lotFuture.id)
      expect(await expireEvents(lotFuture.id)).toHaveLength(1)
    } finally {
      if (token && Object.keys(originalSettings).length > 0) {
        await requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(originalSettings) }).catch(() => undefined)
      }
      await pool.query('DELETE FROM attendance_leave_balance_events WHERE user_id = $1', [userId]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_leave_balances WHERE user_id = $1', [userId]).catch(() => undefined)
      if (createdRequestIds.length > 0) {
        await pool.query('DELETE FROM attendance_requests WHERE id = ANY($1::uuid[])', [createdRequestIds]).catch(() => undefined)
      }
      if (previousRbacBypass === undefined) delete process.env.RBAC_BYPASS
      else process.env.RBAC_BYPASS = previousRbacBypass
      await pool.end().catch(() => undefined)
    }
  })

  it('hardens schedule group parent links before exposing small-organization editing', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    expect(dbUrl).toBeTruthy()
    if (!dbUrl) return

    const runSuffix = Date.now().toString(36)
    const adminUserId = `attendance-small-org-admin-${runSuffix}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(adminUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    const codePrefix = `so0-${runSuffix}`
    const pool = new Pool({ connectionString: dbUrl })
    const createdIds: string[] = []
    const foreignParentId = randomUuidV4()

    const createGroup = async (body: Record<string, unknown>) => {
      const response = await requestJson(`${baseUrl}/api/attendance/schedule-groups`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
      expect(response.status, response.raw).toBe(200)
      const data = (response.body as { data?: { id?: string } } | undefined)?.data
      expect(data?.id).toBeTruthy()
      if (data?.id) createdIds.push(data.id)
      return data as any
    }

    const expectRouteError = (response: HttpResponse, status: number, code: string) => {
      expect(response.status, response.raw).toBe(status)
      const error = (response.body as { error?: { code?: string } } | undefined)?.error
      expect(error?.code).toBe(code)
    }

    try {
      const root = await createGroup({
        name: `SO0 Root ${runSuffix}`,
        code: `${codePrefix}-root`,
        departmentRef: `dept-root-${runSuffix}`,
      })
      const child = await createGroup({
        name: `SO0 Child ${runSuffix}`,
        code: `${codePrefix}-child`,
        parentId: root.id,
        departmentRef: `dept-child-${runSuffix}`,
      })

      const childLookup = await requestJson(`${baseUrl}/api/attendance/schedule-groups/${child.id}`, { headers })
      expect(childLookup.status).toBe(200)
      const childData = (childLookup.body as { data?: { parentId?: string | null; departmentRef?: string | null } } | undefined)?.data
      expect(childData?.parentId).toBe(root.id)
      expect(childData?.departmentRef).toBe(`dept-child-${runSuffix}`)

      const partialUpdate = await requestJson(`${baseUrl}/api/attendance/schedule-groups/${child.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ name: `SO0 Child Renamed ${runSuffix}` }),
      })
      expect(partialUpdate.status, partialUpdate.raw).toBe(200)
      const partialData = (partialUpdate.body as { data?: { parentId?: string | null; departmentRef?: string | null } } | undefined)?.data
      expect(partialData?.parentId).toBe(root.id)
      expect(partialData?.departmentRef).toBe(`dept-child-${runSuffix}`)

      const selfParentUpdate = await requestJson(`${baseUrl}/api/attendance/schedule-groups/${root.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ parentId: root.id }),
      })
      expectRouteError(selfParentUpdate, 422, 'SCHEDULE_GROUP_PARENT_CYCLE')
      const rootAfterSelfParent = await pool.query('SELECT parent_id FROM attendance_schedule_groups WHERE id = $1', [root.id])
      expect(rootAfterSelfParent.rows[0]?.parent_id).toBeNull()

      const inactiveParent = await createGroup({
        name: `SO0 Inactive Parent ${runSuffix}`,
        code: `${codePrefix}-inactive`,
        isActive: false,
      })
      const inactiveParentChild = await requestJson(`${baseUrl}/api/attendance/schedule-groups`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: `SO0 Invalid Inactive Child ${runSuffix}`,
          code: `${codePrefix}-inactive-child`,
          parentId: inactiveParent.id,
        }),
      })
      expectRouteError(inactiveParentChild, 422, 'SCHEDULE_GROUP_PARENT_INVALID')

      await pool.query(
        `INSERT INTO attendance_schedule_groups (id, org_id, name, code, is_active)
         VALUES ($1, $2, $3, $4, true)`,
        [foreignParentId, 'other-org', `SO0 Foreign Parent ${runSuffix}`, `${codePrefix}-foreign`]
      )
      const foreignParentChild = await requestJson(`${baseUrl}/api/attendance/schedule-groups`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: `SO0 Invalid Foreign Child ${runSuffix}`,
          code: `${codePrefix}-foreign-child`,
          parentId: foreignParentId,
        }),
      })
      expectRouteError(foreignParentChild, 422, 'SCHEDULE_GROUP_PARENT_INVALID')

      const cycleUpdate = await requestJson(`${baseUrl}/api/attendance/schedule-groups/${root.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ parentId: child.id }),
      })
      expectRouteError(cycleUpdate, 422, 'SCHEDULE_GROUP_PARENT_CYCLE')
      const rootAfterCycle = await pool.query('SELECT parent_id FROM attendance_schedule_groups WHERE id = $1', [root.id])
      expect(rootAfterCycle.rows[0]?.parent_id).toBeNull()

      const deleteParent = await requestJson(`${baseUrl}/api/attendance/schedule-groups/${root.id}`, {
        method: 'DELETE',
        headers,
      })
      expectRouteError(deleteParent, 409, 'SCHEDULE_GROUP_HAS_ACTIVE_CHILDREN')

      const deactivateParent = await requestJson(`${baseUrl}/api/attendance/schedule-groups/${root.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ isActive: false }),
      })
      expectRouteError(deactivateParent, 409, 'SCHEDULE_GROUP_HAS_ACTIVE_CHILDREN')
      const rootAfterDeactivate = await pool.query('SELECT is_active FROM attendance_schedule_groups WHERE id = $1', [root.id])
      expect(rootAfterDeactivate.rows[0]?.is_active).toBe(true)
    } finally {
      await pool.query(
        `DELETE FROM attendance_schedule_group_members
         WHERE schedule_group_id IN (
           SELECT id FROM attendance_schedule_groups WHERE code LIKE $1
         )`,
        [`${codePrefix}%`]
      ).catch(() => undefined)
      await pool.query('DELETE FROM attendance_schedule_groups WHERE code LIKE $1', [`${codePrefix}%`]).catch(() => undefined)
      if (createdIds.length) {
        await pool.query('DELETE FROM attendance_schedule_groups WHERE id = ANY($1::uuid[])', [createdIds]).catch(() => undefined)
      }
      await pool.query('DELETE FROM attendance_schedule_groups WHERE id = $1', [foreignParentId]).catch(() => undefined)
      await pool.end().catch(() => undefined)
    }
  })

  it('lets scoped schedule-group actors view, edit, and dispatch only within their small organization', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    expect(dbUrl).toBeTruthy()
    if (!dbUrl) return

    const runSuffix = Date.now().toString(36)
    const orgId = 'default'
    const scopedUserId = `attendance-small-org-scoped-${runSuffix}`
    const dispatchUserId = `attendance-small-org-member-${runSuffix}`
    const otherUserId = `attendance-small-org-other-${runSuffix}`
    const rootId = randomUuidV4()
    const childId = randomUuidV4()
    const siblingId = randomUuidV4()
    const viewEditScopeId = randomUuidV4()
    const dispatchScopeId = randomUuidV4()
    const codePrefix = `so2-${runSuffix}`
    const previousRbacBypass = process.env.RBAC_BYPASS
    const pool = new Pool({ connectionString: dbUrl })

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(scopedUserId)}&roles=user&perms=attendance:read,attendance:write`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) {
      await pool.end().catch(() => undefined)
      return
    }
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

    const expectRouteError = (response: HttpResponse, status: number, code: string) => {
      expect(response.status, response.raw).toBe(status)
      const error = (response.body as { error?: { code?: string } } | undefined)?.error
      expect(error?.code).toBe(code)
    }

    try {
      process.env.RBAC_BYPASS = 'false'
      await pool.query(
        `INSERT INTO attendance_schedule_groups (id, org_id, name, code, parent_id, department_ref, is_active)
         VALUES
           ($1, $4, $5, $8, NULL, $11, true),
           ($2, $4, $6, $9, $1, $12, true),
           ($3, $4, $7, $10, $1, $13, true)`,
        [
          rootId,
          childId,
          siblingId,
          orgId,
          `SO2 Root ${runSuffix}`,
          `SO2 Child ${runSuffix}`,
          `SO2 Sibling ${runSuffix}`,
          `${codePrefix}-root`,
          `${codePrefix}-child`,
          `${codePrefix}-sibling`,
          `dept-root-${runSuffix}`,
          `dept-child-${runSuffix}`,
          `dept-sibling-${runSuffix}`,
        ]
      )
      await pool.query(
        `INSERT INTO attendance_scheduler_scopes
         (id, org_id, subject_type, subject_ref, actions, scope, is_active, created_by, updated_by)
         VALUES
           ($1, $3, 'user', $4, ARRAY['view', 'edit']::text[], $5::jsonb, true, 'integration-test', 'integration-test'),
           ($2, $3, 'user', $4, ARRAY['dispatch']::text[], $6::jsonb, true, 'integration-test', 'integration-test')`,
        [
          viewEditScopeId,
          dispatchScopeId,
          orgId,
          scopedUserId,
          JSON.stringify({ departments: [`dept-child-${runSuffix}`] }),
          JSON.stringify({ scheduleGroupIds: [childId], userIds: [dispatchUserId] }),
        ]
      )

      const adminCreateAttempt = await requestJson(`${baseUrl}/api/attendance/schedule-groups`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: `SO2 Forbidden Create ${runSuffix}`, code: `${codePrefix}-forbidden` }),
      })
      expectRouteError(adminCreateAttempt, 403, 'FORBIDDEN')

      const listResponse = await requestJson(`${baseUrl}/api/attendance/schedule-groups?includeInactive=true&pageSize=200`, { headers })
      expect(listResponse.status, listResponse.raw).toBe(200)
      const listedItems = ((listResponse.body as { data?: { items?: Array<{ id?: string }> } } | undefined)?.data?.items ?? [])
        .map(item => item.id)
      expect(listedItems).toContain(childId)
      expect(listedItems).not.toContain(rootId)
      expect(listedItems).not.toContain(siblingId)

      const childLookup = await requestJson(`${baseUrl}/api/attendance/schedule-groups/${childId}`, { headers })
      expect(childLookup.status, childLookup.raw).toBe(200)
      expect((childLookup.body as { data?: { departmentRef?: string | null } } | undefined)?.data?.departmentRef).toBe(`dept-child-${runSuffix}`)

      const siblingLookup = await requestJson(`${baseUrl}/api/attendance/schedule-groups/${siblingId}`, { headers })
      expectRouteError(siblingLookup, 403, 'SCHEDULER_SCOPE_FORBIDDEN')

      const childEdit = await requestJson(`${baseUrl}/api/attendance/schedule-groups/${childId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ description: `scoped edit ${runSuffix}` }),
      })
      expect(childEdit.status, childEdit.raw).toBe(200)
      expect((childEdit.body as { data?: { description?: string | null } } | undefined)?.data?.description).toBe(`scoped edit ${runSuffix}`)

      const childScopeMove = await requestJson(`${baseUrl}/api/attendance/schedule-groups/${childId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ departmentRef: `dept-sibling-${runSuffix}` }),
      })
      expectRouteError(childScopeMove, 403, 'SCHEDULER_SCOPE_FORBIDDEN')
      const childRows = await pool.query('SELECT department_ref FROM attendance_schedule_groups WHERE id = $1', [childId])
      expect(childRows.rows[0]?.department_ref).toBe(`dept-child-${runSuffix}`)

      const siblingEdit = await requestJson(`${baseUrl}/api/attendance/schedule-groups/${siblingId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ description: `should not edit ${runSuffix}` }),
      })
      expectRouteError(siblingEdit, 403, 'SCHEDULER_SCOPE_FORBIDDEN')
      const siblingRows = await pool.query('SELECT description FROM attendance_schedule_groups WHERE id = $1', [siblingId])
      expect(siblingRows.rows[0]?.description ?? null).toBeNull()

      const memberAdd = await requestJson(`${baseUrl}/api/attendance/schedule-groups/${childId}/members`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ userIds: [dispatchUserId], role: 'lead', source: 'manual' }),
      })
      expect(memberAdd.status, memberAdd.raw).toBe(200)
      const createdMembers = (memberAdd.body as { data?: { items?: Array<{ id?: string; userId?: string; role?: string }> } } | undefined)?.data?.items ?? []
      expect(createdMembers.map(item => item.userId)).toEqual([dispatchUserId])
      expect(createdMembers[0]?.role).toBe('lead')
      const createdMemberId = createdMembers[0]?.id
      expect(createdMemberId).toBeTruthy()

      const disallowedUserAdd = await requestJson(`${baseUrl}/api/attendance/schedule-groups/${childId}/members`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ userIds: [otherUserId], role: 'member', source: 'manual' }),
      })
      expectRouteError(disallowedUserAdd, 403, 'SCHEDULER_SCOPE_FORBIDDEN')

      const siblingMemberAdd = await requestJson(`${baseUrl}/api/attendance/schedule-groups/${siblingId}/members`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ userIds: [dispatchUserId], role: 'member', source: 'manual' }),
      })
      expectRouteError(siblingMemberAdd, 403, 'SCHEDULER_SCOPE_FORBIDDEN')

      if (createdMemberId) {
        const memberDelete = await requestJson(`${baseUrl}/api/attendance/schedule-groups/${childId}/members/${createdMemberId}`, {
          method: 'DELETE',
          headers,
        })
        expect(memberDelete.status, memberDelete.raw).toBe(200)
        expect((memberDelete.body as { data?: { id?: string } } | undefined)?.data?.id).toBe(createdMemberId)
        const deletedMemberRows = await pool.query('SELECT id FROM attendance_schedule_group_members WHERE id = $1', [createdMemberId])
        expect(deletedMemberRows.rowCount).toBe(0)
      }

      const siblingMemberId = randomUuidV4()
      await pool.query(
        `INSERT INTO attendance_schedule_group_members (id, org_id, schedule_group_id, user_id, role, source)
         VALUES ($1, $2, $3, $4, 'member', 'manual')`,
        [siblingMemberId, orgId, siblingId, dispatchUserId]
      )
      const siblingMemberDelete = await requestJson(`${baseUrl}/api/attendance/schedule-groups/${siblingId}/members/${siblingMemberId}`, {
        method: 'DELETE',
        headers,
      })
      expectRouteError(siblingMemberDelete, 403, 'SCHEDULER_SCOPE_FORBIDDEN')
      const siblingMemberRows = await pool.query('SELECT id FROM attendance_schedule_group_members WHERE id = $1', [siblingMemberId])
      expect(siblingMemberRows.rowCount).toBe(1)
    } finally {
      if (previousRbacBypass === undefined) delete process.env.RBAC_BYPASS
      else process.env.RBAC_BYPASS = previousRbacBypass
      await pool.query('DELETE FROM attendance_schedule_group_members WHERE org_id = $1 AND schedule_group_id = ANY($2::uuid[])', [orgId, [childId, siblingId, rootId]]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_scheduler_scopes WHERE id = ANY($1::uuid[])', [[viewEditScopeId, dispatchScopeId]]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_schedule_groups WHERE id = ANY($1::uuid[])', [[childId, siblingId, rootId]]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_schedule_groups WHERE code LIKE $1', [`${codePrefix}%`]).catch(() => undefined)
      await pool.end().catch(() => undefined)
    }
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
        `${baseUrl}/api/attendance/export?from=${encodeURIComponent(workDate)}&to=${encodeURIComponent(workDate)}&header=code`,
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
      expect(lines[0]).toContain('punch_in_1')
      expect(lines[0]).toContain('punch_out_1')
      expect(lines[1]).toContain(workDate)
      expect(lines[1]).toContain(`${workDate}T09:00:00+09:00`)
      expect(lines[1]).toContain(`${workDate}T18:00:00+09:00`)
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
      const row = body.data?.items?.[0]
      expect(row?.work_date).toBe(workDate)
      expect(row?.punch_in_1).toBe(`${workDate}T09:00:00+09:00`)
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

  it('④/年假 L0 — config integrity: enabling requires a timezone (422), and a broken tiers ladder falls back to the preset', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return
    const userId = `attendance-annual-l0-guard-${Date.now().toString(36)}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    const readAnnual = async () => {
      const r = await requestJson(`${baseUrl}/api/attendance/settings`, { headers: { Authorization: `Bearer ${token}` } })
      return (r.body as { data?: { annualLeavePolicy?: { timezone?: string | null; tiers?: Array<{ minYears: number; maxYears: number | null; days: number }> } } } | undefined)?.data?.annualLeavePolicy
    }
    const putAnnual = (annualLeavePolicy: Record<string, unknown>) =>
      requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers, body: JSON.stringify({ annualLeavePolicy }) })
    const statutoryPreset = [
      { minYears: 1, maxYears: 10, days: 5 },
      { minYears: 10, maxYears: 20, days: 10 },
      { minYears: 20, maxYears: null, days: 15 },
    ]
    try {
      // (1) enabled=true without a timezone → 422 ANNUAL_LEAVE_TIMEZONE_REQUIRED (no silent UTC fallback).
      const noTz = await putAnnual({ enabled: true })
      expect(noTz.status).toBe(422)
      expect((noTz.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('ANNUAL_LEAVE_TIMEZONE_REQUIRED')

      // (2) enabled=false without a timezone → allowed (the guard only fires when enabling).
      expect((await putAnnual({ enabled: false })).status).toBe(200)

      // (3) enabled=true + explicit timezone but an OVERLAPPING ladder (1–10 and 5–20 overlap) → saved, but
      //     the malformed ladder falls back to the statutory preset (a broken ladder is never persisted).
      const overlap = await putAnnual({
        enabled: true,
        timezone: 'Asia/Shanghai',
        tiers: [{ minYears: 1, maxYears: 10, days: 5 }, { minYears: 5, maxYears: 20, days: 10 }],
      })
      expect(overlap.status, JSON.stringify(overlap.body)).toBe(200)
      const afterOverlap = await readAnnual()
      expect(afterOverlap?.timezone).toBe('Asia/Shanghai')
      expect(afterOverlap?.tiers).toEqual(statutoryPreset)

      // (4) a contiguous custom ladder (single trailing open-ended band) is preserved — proves the fallback
      //     is targeted, not a blanket overwrite.
      const okLadder = await putAnnual({
        enabled: true,
        timezone: 'Asia/Shanghai',
        tiers: [{ minYears: 0, maxYears: 3, days: 4 }, { minYears: 3, maxYears: null, days: 9 }],
      })
      expect(okLadder.status, JSON.stringify(okLadder.body)).toBe(200)
      expect((await readAnnual())?.tiers).toEqual([{ minYears: 0, maxYears: 3, days: 4 }, { minYears: 3, maxYears: null, days: 9 }])

      // (5) a non-empty ladder with a CLOSED last band (no open-ended tail) leaves the most-senior
      //     employees with no matching tier → malformed → falls back to the statutory preset.
      const closedTail = await putAnnual({
        enabled: true,
        timezone: 'Asia/Shanghai',
        tiers: [{ minYears: 1, maxYears: 10, days: 5 }],
      })
      expect(closedTail.status, JSON.stringify(closedTail.body)).toBe(200)
      expect((await readAnnual())?.tiers).toEqual(statutoryPreset)
    } finally {
      // restore default-OFF so the shared local DB doesn't leak enabled=true into later tests.
      await putAnnual({ enabled: false, timezone: null }).catch(() => undefined)
    }
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
          comprehensiveHours: { capDefaults: { month: 10560, quarter: 31680, year: 126720 } },
          shiftCompliance: {
            enforcement: 'warn',
            dailyMaxMinutes: 480,
            weeklyMaxMinutes: 2400,
            monthlyMaxMinutes: 9600,
          },
          multiShiftDay: { enabled: true, maxSlots: 3 },
          compTimeFromOvertime: { enabled: true, expiresInDays: 45 },
          annualLeavePolicy: {
            enabled: true,
            tenureMode: 'company_tenure',
            standardDayMinutes: 600,
            tiers: [{ minYears: 0, maxYears: 5, days: 3 }, { minYears: 5, maxYears: null, days: 8 }],
            carryover: { enabled: true },
            timezone: 'Asia/Shanghai',
          },
          overtimeSegmentation: { enabled: true },
          autoShiftMatching: {
            enabled: true,
            mode: 'apply',
            maxToleranceMinutes: 90,
            minConfidenceToApply: 'medium',
            autoWrite: {
              enabled: true,
              lookaheadDays: 3,
              maxAssignmentsPerRun: 40,
              minConfidence: 'high',
            },
          },
        }),
      })
      expect(saveSettingsRes.status, JSON.stringify(saveSettingsRes.body)).toBe(200)

      // Real-wire round-trip: config sub-shapes must survive the PUT zod
      // schema + persistence and come back on GET — not be silently stripped. Guards the
      // save-path drift class (a field present in the normalizer but missing from the
      // route schema would persist as nothing).
      const reloadRes = await requestJson(`${baseUrl}/api/attendance/settings`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(reloadRes.status).toBe(200)
      const reloaded = (reloadRes.body as {
        data?: {
          comprehensiveHours?: { capDefaults?: Record<string, number | null> }
          shiftCompliance?: Record<string, unknown>
          multiShiftDay?: Record<string, unknown>
          compTimeFromOvertime?: Record<string, unknown>
          annualLeavePolicy?: Record<string, unknown>
          overtimeSegmentation?: Record<string, unknown>
          autoShiftMatching?: Record<string, unknown>
        }
      } | undefined)?.data
      expect(reloaded?.comprehensiveHours?.capDefaults).toEqual({ month: 10560, quarter: 31680, year: 126720 })
      expect(reloaded?.shiftCompliance).toEqual({
        enforcement: 'warn',
        dailyMaxMinutes: 480,
        weeklyMaxMinutes: 2400,
        monthlyMaxMinutes: 9600,
      })
      expect(reloaded?.multiShiftDay).toEqual({ enabled: true, maxSlots: 3 })
      expect(reloaded?.compTimeFromOvertime).toEqual({ enabled: true, expiresInDays: 45 })
      // 年假/法定假 L0 latent config — round-trips through the PUT zod schema + persist + normalize
      // (incl. a custom tiers ladder and an org timezone), proving the new sub-shape isn't silently
      // stripped (the save-path drift class). Nothing reads it yet; L2 accrual consumes it.
      expect(reloaded?.annualLeavePolicy).toEqual({
        enabled: true,
        tenureMode: 'company_tenure',
        standardDayMinutes: 600,
        tiers: [{ minYears: 0, maxYears: 5, days: 3 }, { minYears: 5, maxYears: null, days: 8 }],
        carryover: { enabled: true },
        timezone: 'Asia/Shanghai',
      })
      expect(reloaded?.overtimeSegmentation).toEqual({ enabled: true })
      expect(reloaded?.autoShiftMatching).toEqual({
        enabled: true,
        mode: 'apply',
        maxToleranceMinutes: 90,
        minConfidenceToApply: 'medium',
        autoWrite: {
          enabled: true,
          lookaheadDays: 3,
          maxAssignmentsPerRun: 40,
          minConfidence: 'high',
        },
      })

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

  describe('auto shift matching preview', () => {
    const orgId = 'default'

    async function getAdminToken(userId: string): Promise<string | undefined> {
      if (!baseUrl) return undefined
      const tokenRes = await requestJson(
        `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`
      )
      return (tokenRes.body as { token?: string } | undefined)?.token
    }

    async function saveAutoShiftSettings(token: string, payload: Record<string, unknown>): Promise<void> {
      if (!baseUrl) return
      const res = await requestJson(`${baseUrl}/api/attendance/settings`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      expect(res.status).toBe(200)
    }

    async function loadSettingsForTest(token: string): Promise<Record<string, unknown>> {
      if (!baseUrl) return {}
      const res = await requestJson(`${baseUrl}/api/attendance/settings`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(200)
      return ((res.body as { data?: Record<string, unknown> } | undefined)?.data ?? {}) as Record<string, unknown>
    }

    it('round-trips leaveBalanceDeductionPolicy (wire lock): PUT→GET full shape, partial PUT preserves rules, bad pool → 400', async () => {
      if (!baseUrl) return
      const runSuffix = Date.now().toString(36)
      const adminToken = await getAdminToken(`attendance-leaveoffset-wire-${runSuffix}`)
      expect(adminToken).toBeTruthy()
      if (!adminToken) return
      const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }
      const putSettings = (body: Record<string, unknown>) =>
        requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers, body: JSON.stringify(body) })
      const originalSettings = await loadSettingsForTest(adminToken)
      try {
        const rules = [
          { requestLeaveType: 'annual', deductFrom: ['annual'], insufficient: 'block' },
          { requestLeaveType: 'personal_leave', deductFrom: ['comp_time'], insufficient: 'partial_unpaid_absence' },
        ]
        // (1) full PUT → GET returns the full shape (locks DEFAULT_SETTINGS + normalizeSettings + zod + mergeSettings).
        expect((await putSettings({ leaveBalanceDeductionPolicy: { enabled: true, rules } })).status).toBe(200)
        expect((await loadSettingsForTest(adminToken)).leaveBalanceDeductionPolicy).toEqual({ enabled: true, rules })
        // (2) partial PUT preserves rules: PUT only { enabled:false } → rules NOT cleared (mergeSettings whitelist).
        expect((await putSettings({ leaveBalanceDeductionPolicy: { enabled: false } })).status).toBe(200)
        expect((await loadSettingsForTest(adminToken)).leaveBalanceDeductionPolicy).toEqual({ enabled: false, rules })
        // (3) API enum reject: an unknown deductFrom pool → 400.
        expect((await putSettings({ leaveBalanceDeductionPolicy: { rules: [{ requestLeaveType: 'x', deductFrom: ['bogus'] }] } })).status).toBe(400)
        // (4) §P2 single-pool lock: a multi-pool deductFrom is rejected at the API (>1 element). Cross-pool is v2.
        expect((await putSettings({ leaveBalanceDeductionPolicy: { rules: [{ requestLeaveType: 'personal_leave', deductFrom: ['comp_time', 'annual'] }] } })).status).toBe(400)
      } finally {
        await putSettings({ leaveBalanceDeductionPolicy: originalSettings.leaveBalanceDeductionPolicy }).catch(() => undefined)
      }
    })

    it('round-trips attendanceBonusPolicy (wire lock): PUT→GET full shape, partial PUT preserves toggles', async () => {
      if (!baseUrl) return
      const runSuffix = Date.now().toString(36)
      const adminToken = await getAdminToken(`attendance-bonus-wire-${runSuffix}`)
      expect(adminToken).toBeTruthy()
      if (!adminToken) return
      const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }
      const putSettings = (body: Record<string, unknown>) =>
        requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers, body: JSON.stringify(body) })
      const originalSettings = await loadSettingsForTest(adminToken)
      try {
        // (1) full PUT → GET returns the full shape (locks DEFAULT_SETTINGS + normalizeSettings + zod + mergeSettings).
        const full = { enabled: true, anyLeaveBreaksFullAttendance: true, lateBeyondThresholdBreaksFullAttendance: false }
        expect((await putSettings({ attendanceBonusPolicy: full })).status).toBe(200)
        expect((await loadSettingsForTest(adminToken)).attendanceBonusPolicy).toEqual(full)
        // (2) partial PUT preserves the other toggles: PUT only { enabled:false } → the toggles are not reset.
        expect((await putSettings({ attendanceBonusPolicy: { enabled: false } })).status).toBe(200)
        expect((await loadSettingsForTest(adminToken)).attendanceBonusPolicy).toEqual({ ...full, enabled: false })
      } finally {
        await putSettings({ attendanceBonusPolicy: originalSettings.attendanceBonusPolicy }).catch(() => undefined)
      }
    })

    it('round-trips overtimeBankPolicy (wire lock): PUT→GET full shape, partial PUT preserves siblings, statutory_holiday → 400', async () => {
      if (!baseUrl) return
      const runSuffix = Date.now().toString(36)
      const adminToken = await getAdminToken(`attendance-otbank-wire-${runSuffix}`)
      expect(adminToken).toBeTruthy()
      if (!adminToken) return
      const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }
      const putSettings = (body: Record<string, unknown>) =>
        requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers, body: JSON.stringify(body) })
      const originalSettings = await loadSettingsForTest(adminToken)
      try {
        // (1) full PUT → GET returns the full shape — locks the whole wire: DEFAULT_SETTINGS + normalizeSettings
        // + the settings zod schema + mergeSettings. (Normalizer unit tests do NOT cover this wire.)
        expect((await putSettings({ overtimeBankPolicy: { enabled: true, pooledSources: ['restday', 'workday'], maxMinutesPerPeriod: 600, validityDays: 90 } })).status).toBe(200)
        expect((await loadSettingsForTest(adminToken)).overtimeBankPolicy).toEqual({
          enabled: true, pooledSources: ['restday', 'workday'], maxMinutesPerPeriod: 600, validityDays: 90,
        })
        // (2) partial PUT preserves siblings — PUT only { enabled:false }; pooledSources/cap/validity must NOT be
        // cleared (this is the exact mergeSettings-whitelist gap the advisor caught).
        expect((await putSettings({ overtimeBankPolicy: { enabled: false } })).status).toBe(200)
        expect((await loadSettingsForTest(adminToken)).overtimeBankPolicy).toEqual({
          enabled: false, pooledSources: ['restday', 'workday'], maxMinutesPerPeriod: 600, validityDays: 90,
        })
        // (3) API-layer compliance reject (not just the normalizer drop): statutory_holiday → 400 at PUT.
        expect((await putSettings({ overtimeBankPolicy: { pooledSources: ['statutory_holiday'] } })).status).toBe(400)
      } finally {
        await putSettings({ overtimeBankPolicy: originalSettings.overtimeBankPolicy }).catch(() => undefined)
      }
    })

    it('round-trips auto-write settings including auto mode while rejecting invalid bounds', async () => {
      if (!baseUrl) return
      const runSuffix = Date.now().toString(36)
      const adminToken = await getAdminToken(`attendance-autoshift-autowrite-admin-${runSuffix}`)
      expect(adminToken).toBeTruthy()
      if (!adminToken) return
      const originalSettings = await loadSettingsForTest(adminToken)
      try {
        await saveAutoShiftSettings(adminToken, {
          autoShiftMatching: {
            enabled: true,
            mode: 'apply',
            maxToleranceMinutes: 30,
            minConfidenceToApply: 'high',
            autoWrite: {
              enabled: true,
              lookaheadDays: 3,
              maxAssignmentsPerRun: 40,
              minConfidence: 'high',
            },
          },
        })

        await saveAutoShiftSettings(adminToken, {
          autoShiftMatching: {
            autoWrite: {
              lookaheadDays: 2,
            },
          },
        })

        const reloaded = await loadSettingsForTest(adminToken)
        expect(reloaded.autoShiftMatching).toEqual({
          enabled: true,
          mode: 'apply',
          maxToleranceMinutes: 30,
          minConfidenceToApply: 'high',
          autoWrite: {
            enabled: true,
            lookaheadDays: 2,
            maxAssignmentsPerRun: 40,
            minConfidence: 'high',
          },
        })

        await saveAutoShiftSettings(adminToken, {
          autoShiftMatching: {
            mode: 'auto',
          },
        })
        const autoReloaded = await loadSettingsForTest(adminToken)
        expect(autoReloaded.autoShiftMatching).toMatchObject({
          enabled: true,
          mode: 'auto',
          autoWrite: {
            enabled: true,
            lookaheadDays: 2,
            maxAssignmentsPerRun: 40,
            minConfidence: 'high',
          },
        })

        const invalidPayloads: Array<Record<string, unknown>> = [
          { autoShiftMatching: { autoWrite: { lookaheadDays: 0 } } },
          { autoShiftMatching: { autoWrite: { lookaheadDays: 4 } } },
          { autoShiftMatching: { autoWrite: { maxAssignmentsPerRun: 0 } } },
          { autoShiftMatching: { autoWrite: { maxAssignmentsPerRun: 101 } } },
          { autoShiftMatching: { autoWrite: { minConfidence: 'medium' } } },
        ]

        for (const payload of invalidPayloads) {
          const res = await requestJson(`${baseUrl}/api/attendance/settings`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
          expect(res.status, JSON.stringify({ payload, body: res.body })).toBe(400)
          expect((res.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('VALIDATION_ERROR')
        }
      } finally {
        await saveAutoShiftSettings(adminToken, originalSettings).catch(() => undefined)
      }
    })

    it('returns auto-write run summaries with skipped reason counts for admin operations UI', async () => {
      if (!baseUrl) return
      const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
      if (!dbUrl) return
      const runSuffix = Date.now().toString(36)
      const orgId = `a2-ui-${runSuffix}`
      const adminToken = await getAdminToken(`attendance-autoshift-ui-admin-${runSuffix}`)
      expect(adminToken).toBeTruthy()
      if (!adminToken) return
      const pool = new Pool({ connectionString: dbUrl })
      try {
        await requireAttendanceTable(pool, 'attendance_auto_shift_auto_write_runs')
        await requireAttendanceTable(pool, 'attendance_auto_shift_auto_write_run_items')
        const runRows = await pool.query(
          `INSERT INTO attendance_auto_shift_auto_write_runs
             (org_id, source, status, target_from, target_to, config_snapshot,
              scanned_count, candidate_count, applied_count, skipped_count, error_count, started_at, finished_at, created_at)
           VALUES ($1, 'scheduler', 'partial', '2026-06-15', '2026-06-16',
                   '{"autoShiftMatching":{"autoWrite":{"enabled":true,"lookaheadDays":2}}}'::jsonb,
                   7, 4, 2, 2, 1,
                   '2026-06-14T00:00:00.000Z'::timestamptz,
                   '2026-06-14T00:00:02.000Z'::timestamptz,
                   '2026-06-14T00:00:00.000Z'::timestamptz)
           RETURNING id`,
          [orgId],
        )
        const runId = runRows.rows[0]?.id as string | undefined
        expect(runId).toBeTruthy()
        await pool.query(
          `INSERT INTO attendance_auto_shift_auto_write_run_items
             (run_id, org_id, user_id, work_date, candidate_shift_id, confidence, status, reason, evidence_event_ids)
           VALUES
             ($1, $2, 'a2-ui-u1', '2026-06-15', $3::uuid, 'high', 'skipped', 'scheduler_scope_forbidden', '[]'::jsonb),
             ($1, $2, 'a2-ui-u2', '2026-06-15', $4::uuid, 'high', 'skipped', 'max_assignments_per_run', '[]'::jsonb),
             ($1, $2, 'a2-ui-u3', '2026-06-16', $5::uuid, 'high', 'skipped', 'scheduler_scope_forbidden', '[]'::jsonb)`,
          [runId, orgId, randomUuidV4(), randomUuidV4(), randomUuidV4()],
        )

        const res = await requestJson(`${baseUrl}/api/attendance/auto-shift-matching/auto-write-runs?orgId=${encodeURIComponent(orgId)}&page=1&pageSize=5`, {
          headers: { Authorization: `Bearer ${adminToken}` },
        })
        expect(res.status, JSON.stringify(res.body)).toBe(200)
        const body = res.body as {
          data?: {
            items?: Array<{
              id?: string
              status?: string
              targetFrom?: string
              targetTo?: string
              scannedCount?: number
              candidateCount?: number
              appliedCount?: number
              skippedCount?: number
              errorCount?: number
              errorMessage?: string | null
              startedAt?: string | null
              finishedAt?: string | null
              createdAt?: string | null
              orgId?: string
              source?: string
              configSnapshot?: Record<string, unknown>
              skipReasons?: Array<{ reason?: string; count?: number }>
            }>
            total?: number
            page?: number
            pageSize?: number
          }
        }
        expect(body.data?.total).toBe(1)
        expect(body.data?.page).toBe(1)
        expect(body.data?.pageSize).toBe(5)
        expect(body.data?.items).toEqual([{
          id: runId,
          orgId,
          source: 'scheduler',
          status: 'partial',
          targetFrom: '2026-06-15',
          targetTo: '2026-06-16',
          configSnapshot: { autoShiftMatching: { autoWrite: { enabled: true, lookaheadDays: 2 } } },
          scannedCount: 7,
          candidateCount: 4,
          appliedCount: 2,
          skippedCount: 2,
          errorCount: 1,
          errorMessage: null,
          startedAt: '2026-06-14T00:00:00.000Z',
          finishedAt: '2026-06-14T00:00:02.000Z',
          createdAt: '2026-06-14T00:00:00.000Z',
          skipReasons: [
            { reason: 'scheduler_scope_forbidden', count: 2 },
            { reason: 'max_assignments_per_run', count: 1 },
          ],
        }])
      } finally {
        await pool.query('DELETE FROM attendance_auto_shift_auto_write_runs WHERE org_id = $1', [orgId]).catch(() => undefined)
        await pool.end().catch(() => undefined)
      }
    })

    async function createShiftForAutoShift(token: string, name: string, start: string, end: string): Promise<string> {
      if (!baseUrl) throw new Error('baseUrl missing')
      const res = await requestJson(`${baseUrl}/api/attendance/shifts`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          timezone: 'UTC',
          workStartTime: start,
          workEndTime: end,
          workingDays: [0, 1, 2, 3, 4, 5, 6],
        }),
      })
      expect(res.status).toBe(201)
      const shiftId = (res.body as { data?: { id?: string } } | undefined)?.data?.id
      expect(shiftId).toBeTruthy()
      if (!shiftId) throw new Error('shift id missing')
      return shiftId
    }

    async function createGroupForAutoShift(token: string, name: string, attendanceType: string, userId: string): Promise<string> {
      if (!baseUrl) throw new Error('baseUrl missing')
      const groupRes = await requestJson(`${baseUrl}/api/attendance/groups`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, timezone: 'UTC', attendanceType, description: 'auto-shift-preview-test' }),
      })
      expect(groupRes.status).toBe(200)
      const groupId = (groupRes.body as { data?: { id?: string } } | undefined)?.data?.id
      expect(groupId).toBeTruthy()
      if (!groupId) throw new Error('group id missing')

      const memberRes = await requestJson(`${baseUrl}/api/attendance/groups/${groupId}/members`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds: [userId] }),
      })
      expect(memberRes.status).toBe(200)
      return groupId
    }

    async function insertPunchEvent(pool: Pool, userId: string, workDate: string, eventType: 'check_in' | 'check_out', occurredAt: string): Promise<string> {
      const eventId = randomUuidV4()
      await pool.query(
        `INSERT INTO attendance_events
         (id, user_id, org_id, work_date, occurred_at, event_type, source, timezone, location, meta)
         VALUES ($1, $2, $3, $4, $5, $6, 'integration-test', 'UTC', '{}'::jsonb, '{}'::jsonb)`,
        [eventId, userId, orgId, workDate, occurredAt, eventType],
      )
      return eventId
    }

    async function createAutoShiftSystemDispatchScope(pool: Pool, scope: Record<string, unknown>): Promise<string> {
      const scopeId = randomUuidV4()
      const roleTag = getAttendancePluginForTest().__attendanceAutoShiftForTests?.AUTO_SHIFT_AUTO_WRITE_SYSTEM_ROLE_TAG
      expect(roleTag).toBeTruthy()
      await pool.query(
        `INSERT INTO attendance_scheduler_scopes
         (id, org_id, subject_type, subject_ref, actions, scope, is_active, created_by, updated_by)
         VALUES ($1, $2, 'role_tag', $3, ARRAY['dispatch']::text[], $4::jsonb, true, 'integration-test', 'integration-test')`,
        [scopeId, orgId, roleTag, JSON.stringify(scope)],
      )
      return scopeId
    }

    async function runAutoShiftAutoWriteForTest(pool: Pool, now: string): Promise<any> {
      const runner = getAttendancePluginForTest().__attendanceAutoShiftForTests?.runAttendanceAutoShiftAutoWriteOnce
      expect(runner).toBeTruthy()
      if (!runner) throw new Error('auto-shift test runner missing')
      return runner(createPluginDbForTest(pool), {
        orgId,
        now: new Date(`${now}T12:00:00.000Z`),
        logger: { warn: () => undefined, error: () => undefined, info: () => undefined },
        emitEvent: () => undefined,
      })
    }

    it('returns disabled when either preview gate is off and writes no assignments', async () => {
      if (!baseUrl) return
      const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
      if (!dbUrl) return
      const runSuffix = Date.now().toString(36)
      const adminToken = await getAdminToken(`attendance-autoshift-disabled-admin-${runSuffix}`)
      expect(adminToken).toBeTruthy()
      if (!adminToken) return
      const previousFlag = process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED
      const originalSettings = await loadSettingsForTest(adminToken)
      const pool = new Pool({ connectionString: dbUrl })
      const userId = `attendance-autoshift-disabled-user-${runSuffix}`
      try {
        process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED = 'true'
        await saveAutoShiftSettings(adminToken, { autoShiftMatching: { enabled: false, mode: 'preview' } })
        const res = await requestJson(`${baseUrl}/api/attendance/auto-shift-matching/preview`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: '2026-06-10', userIds: [userId] }),
        })
        expect(res.status).toBe(403)
        expect((res.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('AUTO_SHIFT_MATCHING_DISABLED')
        const writes = await pool.query(
          `SELECT
             (SELECT COUNT(*)::int FROM attendance_shift_assignments WHERE org_id = $1 AND user_id = $2) AS shift_count,
             (SELECT COUNT(*)::int FROM attendance_rotation_assignments WHERE org_id = $1 AND user_id = $2) AS rotation_count`,
          [orgId, userId],
        )
        expect(writes.rows[0]).toMatchObject({ shift_count: 0, rotation_count: 0 })
      } finally {
        await saveAutoShiftSettings(adminToken, originalSettings).catch(() => undefined)
        if (previousFlag === undefined) delete process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED
        else process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED = previousFlag
        await pool.end()
      }
    })

    it('suggests a deterministic shift for an unscheduled scheduled-shift member without writing assignments', async () => {
      if (!baseUrl) return
      const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
      if (!dbUrl) return
      const runSuffix = Date.now().toString(36)
      const adminToken = await getAdminToken(`attendance-autoshift-happy-admin-${runSuffix}`)
      expect(adminToken).toBeTruthy()
      if (!adminToken) return
      const previousFlag = process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED
      const originalSettings = await loadSettingsForTest(adminToken)
      const pool = new Pool({ connectionString: dbUrl })
      const userId = `attendance-autoshift-happy-user-${runSuffix}`
      const workDate = '2026-06-11'
      const minuteOffset = Number.parseInt(runSuffix.slice(-2), 36) % 40
      const startMinute = String(10 + minuteOffset).padStart(2, '0')
      const endMinute = String(49 - minuteOffset).padStart(2, '0')
      const shiftStart = `10:${startMinute}`
      const shiftEnd = `17:${endMinute}`
      const inAt = `10:${String(11 + minuteOffset).padStart(2, '0')}:00`
      const outAt = `17:${String(48 - minuteOffset).padStart(2, '0')}:00`
      try {
        process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED = 'true'
        await pool.query(
          `DELETE FROM attendance_shifts
           WHERE org_id = $1
             AND (
               name LIKE 'Auto Shift Match %'
               OR name LIKE '000 Auto Shift Match %'
               OR name LIKE 'Auto Shift Non Match %'
             )`,
          [orgId],
        )
        await saveAutoShiftSettings(adminToken, {
          autoShiftMatching: {
            enabled: true,
            mode: 'preview',
            maxToleranceMinutes: 20,
            minConfidenceToApply: 'high',
          },
        })
        await createGroupForAutoShift(adminToken, `autoshift-happy-${runSuffix}`, 'scheduled_shift', userId)
        const matchingShiftId = await createShiftForAutoShift(adminToken, `000 Auto Shift Match ${runSuffix}`, shiftStart, shiftEnd)
        await createShiftForAutoShift(adminToken, `Auto Shift Non Match ${runSuffix}`, '12:00', '20:00')
        const inId = await insertPunchEvent(pool, userId, workDate, 'check_in', `${workDate}T${inAt}.000Z`)
        const outId = await insertPunchEvent(pool, userId, workDate, 'check_out', `${workDate}T${outAt}.000Z`)

        const res = await requestJson(`${baseUrl}/api/attendance/auto-shift-matching/preview`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: workDate, to: workDate, userIds: [userId] }),
        })
        expect(res.status).toBe(200)
        const data = (res.body as { data?: { items?: any[]; skipped?: any[] } } | undefined)?.data
        expect(data?.items).toHaveLength(1)
        expect(data?.items?.[0]).toMatchObject({
          userId,
          workDate,
          candidateShiftId: matchingShiftId,
          candidateShiftName: `000 Auto Shift Match ${runSuffix}`,
          score: 2,
          confidence: 'high',
        })
        expect(data?.items?.[0]?.evidence?.eventIds).toEqual([inId, outId])
        expect(data?.skipped ?? []).toHaveLength(0)

        const writes = await pool.query(
          `SELECT
             (SELECT COUNT(*)::int FROM attendance_shift_assignments WHERE org_id = $1 AND user_id = $2) AS shift_count,
             (SELECT COUNT(*)::int FROM attendance_rotation_assignments WHERE org_id = $1 AND user_id = $2) AS rotation_count`,
          [orgId, userId],
        )
        expect(writes.rows[0]).toMatchObject({ shift_count: 0, rotation_count: 0 })
      } finally {
        await saveAutoShiftSettings(adminToken, originalSettings).catch(() => undefined)
        if (previousFlag === undefined) delete process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED
        else process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED = previousFlag
        await pool.end()
      }
    })

    it('skips already-scheduled users, fixed/free groups, pending outdoor approvals, and out-of-tolerance punches', async () => {
      if (!baseUrl) return
      const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
      if (!dbUrl) return
      const runSuffix = Date.now().toString(36)
      const adminToken = await getAdminToken(`attendance-autoshift-skip-admin-${runSuffix}`)
      expect(adminToken).toBeTruthy()
      if (!adminToken) return
      const previousFlag = process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED
      const originalSettings = await loadSettingsForTest(adminToken)
      const pool = new Pool({ connectionString: dbUrl })
      const workDate = '2026-06-12'
      const scheduledUserId = `attendance-autoshift-scheduled-${runSuffix}`
      const fixedUserId = `attendance-autoshift-fixed-${runSuffix}`
      const pendingOutdoorUserId = `attendance-autoshift-pending-outdoor-${runSuffix}`
      const toleranceUserId = `attendance-autoshift-tolerance-${runSuffix}`
      try {
        process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED = 'true'
        await saveAutoShiftSettings(adminToken, {
          autoShiftMatching: {
            enabled: true,
            mode: 'preview',
            maxToleranceMinutes: 30,
            minConfidenceToApply: 'low',
          },
        })
        const shiftId = await createShiftForAutoShift(adminToken, `Auto Shift Skip ${runSuffix}`, '09:00', '18:00')
        await createGroupForAutoShift(adminToken, `autoshift-scheduled-${runSuffix}`, 'scheduled_shift', scheduledUserId)
        await createGroupForAutoShift(adminToken, `autoshift-fixed-${runSuffix}`, 'fixed_shift', fixedUserId)
        await createGroupForAutoShift(adminToken, `autoshift-pending-${runSuffix}`, 'scheduled_shift', pendingOutdoorUserId)
        await createGroupForAutoShift(adminToken, `autoshift-tolerance-${runSuffix}`, 'scheduled_shift', toleranceUserId)

        await pool.query(
          `INSERT INTO attendance_shift_assignments
           (id, org_id, user_id, shift_id, start_date, end_date, is_active)
           VALUES ($1, $2, $3, $4, $5, $5, true)`,
          [randomUuidV4(), orgId, scheduledUserId, shiftId, workDate],
        )
        await insertPunchEvent(pool, scheduledUserId, workDate, 'check_in', `${workDate}T09:02:00.000Z`)
        await insertPunchEvent(pool, scheduledUserId, workDate, 'check_out', `${workDate}T18:01:00.000Z`)
        await insertPunchEvent(pool, fixedUserId, workDate, 'check_in', `${workDate}T09:01:00.000Z`)
        await pool.query(
          `INSERT INTO attendance_requests
           (id, user_id, org_id, work_date, request_type, requested_in_at, status, metadata)
           VALUES ($1, $2, $3, $4, 'outdoor_punch', $5, 'pending', $6::jsonb)`,
          [
            randomUuidV4(),
            pendingOutdoorUserId,
            orgId,
            workDate,
            `${workDate}T09:00:00.000Z`,
            JSON.stringify({ outdoorPunch: { eventType: 'check_in', occurredAt: `${workDate}T09:00:00.000Z`, workDate } }),
          ],
        )
        await insertPunchEvent(pool, toleranceUserId, workDate, 'check_in', `${workDate}T03:00:00.000Z`)
        await insertPunchEvent(pool, toleranceUserId, workDate, 'check_out', `${workDate}T04:00:00.000Z`)

        const res = await requestJson(`${baseUrl}/api/attendance/auto-shift-matching/preview`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: workDate,
            userIds: [scheduledUserId, fixedUserId, pendingOutdoorUserId, toleranceUserId],
          }),
        })
        expect(res.status).toBe(200)
        const data = (res.body as { data?: { items?: any[]; skipped?: Array<{ userId: string; reason: string }> } } | undefined)?.data
        expect(data?.items ?? []).toHaveLength(0)
        const reasonsByUser = new Map((data?.skipped ?? []).map((item) => [item.userId, item.reason]))
        expect(reasonsByUser.get(scheduledUserId)).toBe('already_scheduled')
        expect(reasonsByUser.get(fixedUserId)).toBe('not_scheduled_shift_group')
        expect(reasonsByUser.get(pendingOutdoorUserId)).toBe('no_punch')
        expect(reasonsByUser.get(toleranceUserId)).toBe('no_candidate_within_tolerance')
      } finally {
        await saveAutoShiftSettings(adminToken, originalSettings).catch(() => undefined)
        if (previousFlag === undefined) delete process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED
        else process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED = previousFlag
        await pool.end()
      }
    })

    it('applies a selected preview suggestion once with auto-shift provenance and skips replay', async () => {
      if (!baseUrl) return
      const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
      if (!dbUrl) return
      const runSuffix = Date.now().toString(36)
      const adminToken = await getAdminToken(`attendance-autoshift-apply-admin-${runSuffix}`)
      expect(adminToken).toBeTruthy()
      if (!adminToken) return
      const previousFlag = process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED
      const originalSettings = await loadSettingsForTest(adminToken)
      const pool = new Pool({ connectionString: dbUrl })
      const userId = `attendance-autoshift-apply-user-${runSuffix}`
      const workDate = '2026-06-13'
      try {
        process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED = 'true'
        await saveAutoShiftSettings(adminToken, {
          autoShiftMatching: {
            enabled: true,
            mode: 'apply',
            maxToleranceMinutes: 30,
            minConfidenceToApply: 'high',
          },
        })
        await createGroupForAutoShift(adminToken, `autoshift-apply-${runSuffix}`, 'scheduled_shift', userId)
        await createShiftForAutoShift(adminToken, `Auto Shift Apply ${runSuffix}`, '05:17', '06:23')
        const inId = await insertPunchEvent(pool, userId, workDate, 'check_in', `${workDate}T05:17:00.000Z`)
        const outId = await insertPunchEvent(pool, userId, workDate, 'check_out', `${workDate}T06:23:00.000Z`)

        const previewRes = await requestJson(`${baseUrl}/api/attendance/auto-shift-matching/preview`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: workDate, userIds: [userId] }),
        })
        expect(previewRes.status).toBe(200)
        const previewItem = (previewRes.body as { data?: { items?: any[] } } | undefined)?.data?.items?.[0]
        expect(previewItem).toMatchObject({ userId, workDate, confidence: 'high' })
        expect(previewItem?.candidateShiftId).toBeTruthy()
        expect(previewItem?.evidence?.eventIds).toEqual([inId, outId])
        const candidateShiftId = String(previewItem.candidateShiftId)

        const applyPayload = {
          items: [
            {
              userId,
              workDate,
              candidateShiftId,
              evidence: { eventIds: previewItem.evidence.eventIds },
            },
          ],
        }
        const applyRes = await requestJson(`${baseUrl}/api/attendance/auto-shift-matching/apply`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(applyPayload),
        })
        expect(applyRes.status).toBe(200)
        const applyData = (applyRes.body as { data?: { runId?: string; applied?: any[]; skipped?: any[] } } | undefined)?.data
        expect(applyData?.runId).toBeTruthy()
        expect(applyData?.applied).toHaveLength(1)
        expect(applyData?.skipped).toHaveLength(0)

        const rows = await pool.query(
          `SELECT shift_id, slot_index, start_date, end_date, is_active,
                  publish_status, published_at, locked_at,
                  producer_type, producer_ref_id, producer_key, producer_run_id
             FROM attendance_shift_assignments
            WHERE org_id = $1 AND user_id = $2`,
          [orgId, userId],
        )
        expect(rows.rows).toHaveLength(1)
        expect(rows.rows[0]).toMatchObject({
          shift_id: candidateShiftId,
          slot_index: 0,
          is_active: true,
          producer_type: 'auto_shift_match',
          producer_ref_id: applyData?.runId,
          producer_key: `${userId}:${workDate}`,
          producer_run_id: applyData?.runId,
        })
        expect(rows.rows[0]?.publish_status).toBe('published')
        expect(dateOnlyForTest(rows.rows[0].start_date)).toBe(workDate)
        expect(dateOnlyForTest(rows.rows[0].end_date)).toBe(workDate)

        const replayRes = await requestJson(`${baseUrl}/api/attendance/auto-shift-matching/apply`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(applyPayload),
        })
        expect(replayRes.status).toBe(200)
        const replayData = (replayRes.body as { data?: { applied?: any[]; skipped?: any[] } } | undefined)?.data
        expect(replayData?.applied).toHaveLength(0)
        expect(replayData?.skipped?.[0]).toMatchObject({ userId, workDate, candidateShiftId, reason: 'already_applied' })
        const countRows = await pool.query(
          'SELECT COUNT(*)::int AS count FROM attendance_shift_assignments WHERE org_id = $1 AND user_id = $2',
          [orgId, userId],
        )
        expect(Number(countRows.rows[0]?.count ?? 0)).toBe(1)

        await saveAutoShiftSettings(adminToken, {
          multiShiftDay: { enabled: true, maxSlots: 3 },
          autoShiftMatching: {
            enabled: true,
            mode: 'apply',
            maxToleranceMinutes: 30,
            minConfidenceToApply: 'high',
          },
        })
        const blockedUserId = `attendance-autoshift-slot1-user-${runSuffix}`
        await createGroupForAutoShift(adminToken, `autoshift-slot1-${runSuffix}`, 'scheduled_shift', blockedUserId)
        await pool.query(
          `INSERT INTO attendance_shift_assignments
           (id, org_id, user_id, shift_id, slot_index, start_date, end_date, is_active)
           VALUES ($1, $2, $3, $4, 1, $5, $5, true)`,
          [randomUuidV4(), orgId, blockedUserId, candidateShiftId, workDate],
        )
        const blockedApplyRes = await requestJson(`${baseUrl}/api/attendance/auto-shift-matching/apply`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: [
              {
                userId: blockedUserId,
                workDate,
                candidateShiftId,
                evidence: { eventIds: [`blocked-evidence-${runSuffix}`] },
              },
            ],
          }),
        })
        expect(blockedApplyRes.status).toBe(200)
        const blockedApplyData = (blockedApplyRes.body as { data?: { applied?: any[]; skipped?: any[] } } | undefined)?.data
        expect(blockedApplyData?.applied).toHaveLength(0)
        expect(blockedApplyData?.skipped?.[0]).toMatchObject({ userId: blockedUserId, workDate, candidateShiftId, reason: 'already_scheduled' })
        const blockedRows = await pool.query(
          `SELECT slot_index, producer_type
             FROM attendance_shift_assignments
            WHERE org_id = $1 AND user_id = $2 AND start_date = $3::date
            ORDER BY slot_index ASC`,
          [orgId, blockedUserId, workDate],
        )
        expect(blockedRows.rows.map(row => ({ slotIndex: Number(row.slot_index), producerType: row.producer_type ?? null }))).toEqual([
          { slotIndex: 1, producerType: null },
        ])
      } finally {
        await saveAutoShiftSettings(adminToken, originalSettings).catch(() => undefined)
        if (previousFlag === undefined) delete process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED
        else process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED = previousFlag
        await pool.end()
      }
    })

    it('skips stale preview evidence and does not overwrite an existing manual assignment', async () => {
      if (!baseUrl) return
      const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
      if (!dbUrl) return
      const runSuffix = Date.now().toString(36)
      const adminToken = await getAdminToken(`attendance-autoshift-stale-admin-${runSuffix}`)
      expect(adminToken).toBeTruthy()
      if (!adminToken) return
      const previousFlag = process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED
      const originalSettings = await loadSettingsForTest(adminToken)
      const pool = new Pool({ connectionString: dbUrl })
      const staleUserId = `attendance-autoshift-stale-user-${runSuffix}`
      const manualUserId = `attendance-autoshift-manual-user-${runSuffix}`
      const workDate = '2026-06-14'
      try {
        process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED = 'true'
        await saveAutoShiftSettings(adminToken, {
          autoShiftMatching: {
            enabled: true,
            mode: 'apply',
            maxToleranceMinutes: 120,
            minConfidenceToApply: 'low',
          },
        })
        await createGroupForAutoShift(adminToken, `autoshift-stale-${runSuffix}`, 'scheduled_shift', staleUserId)
        await createGroupForAutoShift(adminToken, `autoshift-manual-${runSuffix}`, 'scheduled_shift', manualUserId)
        const shiftId = await createShiftForAutoShift(adminToken, `Auto Shift Stale ${runSuffix}`, '05:31', '06:29')
        const manualShiftId = await createShiftForAutoShift(adminToken, `Auto Shift Manual ${runSuffix}`, '07:10', '08:10')
        const staleInId = await insertPunchEvent(pool, staleUserId, workDate, 'check_in', `${workDate}T05:31:00.000Z`)
        const staleOutId = await insertPunchEvent(pool, staleUserId, workDate, 'check_out', `${workDate}T06:29:00.000Z`)
        const manualInId = await insertPunchEvent(pool, manualUserId, workDate, 'check_in', `${workDate}T05:31:00.000Z`)
        const manualOutId = await insertPunchEvent(pool, manualUserId, workDate, 'check_out', `${workDate}T06:29:00.000Z`)

        const previewRes = await requestJson(`${baseUrl}/api/attendance/auto-shift-matching/preview`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: workDate, userIds: [staleUserId, manualUserId] }),
        })
        expect(previewRes.status).toBe(200)
        const previewItems = (previewRes.body as { data?: { items?: any[] } } | undefined)?.data?.items ?? []
        const staleItem = previewItems.find((item) => item.userId === staleUserId)
        const manualItem = previewItems.find((item) => item.userId === manualUserId)
        expect(staleItem?.evidence?.eventIds).toEqual([staleInId, staleOutId])
        expect(manualItem?.evidence?.eventIds).toEqual([manualInId, manualOutId])

        await insertPunchEvent(pool, staleUserId, workDate, 'check_in', `${workDate}T05:45:00.000Z`)
        const manualAssignmentId = randomUuidV4()
        await pool.query(
          `INSERT INTO attendance_shift_assignments
           (id, org_id, user_id, shift_id, start_date, end_date, is_active)
           VALUES ($1, $2, $3, $4, $5, $5, true)`,
          [manualAssignmentId, orgId, manualUserId, manualShiftId, workDate],
        )

        const applyRes = await requestJson(`${baseUrl}/api/attendance/auto-shift-matching/apply`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: [
              { userId: staleUserId, workDate, candidateShiftId: staleItem.candidateShiftId, evidence: { eventIds: staleItem.evidence.eventIds } },
              { userId: manualUserId, workDate, candidateShiftId: manualItem.candidateShiftId, evidence: { eventIds: manualItem.evidence.eventIds } },
            ],
          }),
        })
        expect(applyRes.status).toBe(200)
        const applyData = (applyRes.body as { data?: { applied?: any[]; skipped?: any[] } } | undefined)?.data
        expect(applyData?.applied).toHaveLength(0)
        expect(applyData?.skipped).toEqual(expect.arrayContaining([
          expect.objectContaining({ userId: staleUserId, workDate, candidateShiftId: staleItem.candidateShiftId, reason: 'stale_punch_evidence' }),
          expect.objectContaining({ userId: manualUserId, workDate, candidateShiftId: manualItem.candidateShiftId, reason: 'already_scheduled' }),
        ]))
        const rows = await pool.query(
          'SELECT id, shift_id, producer_type FROM attendance_shift_assignments WHERE org_id = $1 AND user_id = ANY($2::text[]) ORDER BY user_id ASC, created_at ASC',
          [orgId, [staleUserId, manualUserId]],
        )
        expect(rows.rows).toHaveLength(1)
        expect(rows.rows[0]).toMatchObject({ id: manualAssignmentId, shift_id: manualShiftId, producer_type: null })
      } finally {
        await saveAutoShiftSettings(adminToken, originalSettings).catch(() => undefined)
        if (previousFlag === undefined) delete process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED
        else process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED = previousFlag
        await pool.end()
      }
    })

    it('keeps edit-window and shift-compliance guards on the apply write path', async () => {
      if (!baseUrl) return
      const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
      if (!dbUrl) return
      const runSuffix = Date.now().toString(36)
      const adminToken = await getAdminToken(`attendance-autoshift-guard-admin-${runSuffix}`)
      expect(adminToken).toBeTruthy()
      if (!adminToken) return
      const previousFlag = process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED
      const originalSettings = await loadSettingsForTest(adminToken)
      const pool = new Pool({ connectionString: dbUrl })
      const oldUserId = `attendance-autoshift-window-user-${runSuffix}`
      const capUserId = `attendance-autoshift-cap-user-${runSuffix}`
      const oldDate = '2020-01-15'
      const capDate = '2026-06-15'
      try {
        process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED = 'true'
        await saveAutoShiftSettings(adminToken, {
          autoShiftMatching: { enabled: true, mode: 'apply', maxToleranceMinutes: 30, minConfidenceToApply: 'high' },
          shiftEditPolicy: { mode: 'past_locked' },
          shiftCompliance: { enforcement: 'block', dailyMaxMinutes: null, weeklyMaxMinutes: null, monthlyMaxMinutes: null },
        })
        await createGroupForAutoShift(adminToken, `autoshift-window-${runSuffix}`, 'scheduled_shift', oldUserId)
        const oldShiftId = await createShiftForAutoShift(adminToken, `Auto Shift Window ${runSuffix}`, '05:51', '06:51')
        const oldInId = await insertPunchEvent(pool, oldUserId, oldDate, 'check_in', `${oldDate}T05:51:00.000Z`)
        const oldOutId = await insertPunchEvent(pool, oldUserId, oldDate, 'check_out', `${oldDate}T06:51:00.000Z`)
        const windowRes = await requestJson(`${baseUrl}/api/attendance/auto-shift-matching/apply`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: [{ userId: oldUserId, workDate: oldDate, candidateShiftId: oldShiftId, evidence: { eventIds: [oldInId, oldOutId] } }],
          }),
        })
        expect(windowRes.status).toBe(422)
        expect((windowRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SHIFT_EDIT_WINDOW_EXCEEDED')

        await saveAutoShiftSettings(adminToken, {
          autoShiftMatching: { enabled: true, mode: 'apply', maxToleranceMinutes: 30, minConfidenceToApply: 'high' },
          shiftEditPolicy: { mode: 'unrestricted' },
          shiftCompliance: { enforcement: 'block', dailyMaxMinutes: 1, weeklyMaxMinutes: null, monthlyMaxMinutes: null },
        })
        await createGroupForAutoShift(adminToken, `autoshift-cap-${runSuffix}`, 'scheduled_shift', capUserId)
        await createShiftForAutoShift(adminToken, `Auto Shift Cap ${runSuffix}`, '05:41', '06:41')
        const capInId = await insertPunchEvent(pool, capUserId, capDate, 'check_in', `${capDate}T05:41:00.000Z`)
        const capOutId = await insertPunchEvent(pool, capUserId, capDate, 'check_out', `${capDate}T06:41:00.000Z`)
        const capPreviewRes = await requestJson(`${baseUrl}/api/attendance/auto-shift-matching/preview`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: capDate, userIds: [capUserId] }),
        })
        expect(capPreviewRes.status).toBe(200)
        const capPreviewItem = (capPreviewRes.body as { data?: { items?: any[] } } | undefined)?.data?.items?.[0]
        expect(capPreviewItem).toMatchObject({ userId: capUserId, workDate: capDate })
        expect(capPreviewItem?.evidence?.eventIds).toEqual([capInId, capOutId])
        const capRes = await requestJson(`${baseUrl}/api/attendance/auto-shift-matching/apply`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: [{ userId: capUserId, workDate: capDate, candidateShiftId: capPreviewItem.candidateShiftId, evidence: { eventIds: capPreviewItem.evidence.eventIds } }],
          }),
        })
        expect(capRes.status).toBe(422)
        expect((capRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SHIFT_COMPLIANCE_CAP_EXCEEDED')
        const rows = await pool.query(
          'SELECT COUNT(*)::int AS count FROM attendance_shift_assignments WHERE org_id = $1 AND user_id = ANY($2::text[])',
          [orgId, [oldUserId, capUserId]],
        )
        expect(Number(rows.rows[0]?.count ?? 0)).toBe(0)
      } finally {
        await saveAutoShiftSettings(adminToken, originalSettings).catch(() => undefined)
        if (previousFlag === undefined) delete process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED
        else process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED = previousFlag
        await pool.end()
      }
    })

    it('keeps the auto-write runner inert until all runtime and org gates are enabled', async () => {
      if (!baseUrl) return
      const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
      if (!dbUrl) return
      const runSuffix = Date.now().toString(36)
      const adminToken = await getAdminToken(`attendance-autoshift-auto-gate-admin-${runSuffix}`)
      expect(adminToken).toBeTruthy()
      if (!adminToken) return
      const previousPreviewFlag = process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED
      const previousAutoWriteFlag = process.env.ATTENDANCE_AUTO_SHIFT_AUTO_WRITE_ENABLED
      const originalSettings = await loadSettingsForTest(adminToken)
      const pool = new Pool({ connectionString: dbUrl })
      const userId = `attendance-autoshift-auto-gate-user-${runSuffix}`
      const workDate = '2026-06-11'
      try {
        process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED = 'true'
        delete process.env.ATTENDANCE_AUTO_SHIFT_AUTO_WRITE_ENABLED
        await saveAutoShiftSettings(adminToken, {
          autoShiftMatching: {
            enabled: true,
            mode: 'auto',
            maxToleranceMinutes: 30,
            minConfidenceToApply: 'high',
            autoWrite: { enabled: true, lookaheadDays: 1, maxAssignmentsPerRun: 25, minConfidence: 'high' },
          },
        })
        await createGroupForAutoShift(adminToken, `autoshift-auto-gate-${runSuffix}`, 'scheduled_shift', userId)
        await createShiftForAutoShift(adminToken, `Auto Shift Auto Gate ${runSuffix}`, '05:17', '06:23')
        await insertPunchEvent(pool, userId, workDate, 'check_in', `${workDate}T05:17:00.000Z`)
        await insertPunchEvent(pool, userId, workDate, 'check_out', `${workDate}T06:23:00.000Z`)

        const disabledByEnv = await runAutoShiftAutoWriteForTest(pool, '2026-06-10')
        expect(disabledByEnv).toMatchObject({ ran: false, reason: 'disabled' })
        process.env.ATTENDANCE_AUTO_SHIFT_AUTO_WRITE_ENABLED = 'true'
        await saveAutoShiftSettings(adminToken, { autoShiftMatching: { autoWrite: { enabled: false } } })
        const disabledByOrg = await runAutoShiftAutoWriteForTest(pool, '2026-06-10')
        expect(disabledByOrg).toMatchObject({ ran: false, reason: 'disabled' })

        const rows = await pool.query(
          `SELECT
             (SELECT COUNT(*)::int FROM attendance_shift_assignments WHERE org_id = $1 AND user_id = $2) AS assignment_count,
             (SELECT COUNT(*)::int FROM attendance_auto_shift_auto_write_runs WHERE org_id = $1 AND source = 'scheduler' AND status = 'running') AS running_count`,
          [orgId, userId],
        )
        expect(rows.rows[0]).toMatchObject({ assignment_count: 0, running_count: 0 })
      } finally {
        await saveAutoShiftSettings(adminToken, originalSettings).catch(() => undefined)
        if (previousPreviewFlag === undefined) delete process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED
        else process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED = previousPreviewFlag
        if (previousAutoWriteFlag === undefined) delete process.env.ATTENDANCE_AUTO_SHIFT_AUTO_WRITE_ENABLED
        else process.env.ATTENDANCE_AUTO_SHIFT_AUTO_WRITE_ENABLED = previousAutoWriteFlag
        await pool.end()
      }
    })

    it('auto-writes one high-confidence suggestion with ledger provenance and skips repeat ticks', async () => {
      if (!baseUrl) return
      const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
      if (!dbUrl) return
      const runSuffix = Date.now().toString(36)
      const adminToken = await getAdminToken(`attendance-autoshift-auto-write-admin-${runSuffix}`)
      expect(adminToken).toBeTruthy()
      if (!adminToken) return
      const previousPreviewFlag = process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED
      const previousAutoWriteFlag = process.env.ATTENDANCE_AUTO_SHIFT_AUTO_WRITE_ENABLED
      const originalSettings = await loadSettingsForTest(adminToken)
      const pool = new Pool({ connectionString: dbUrl })
      const userId = `attendance-autoshift-auto-write-user-${runSuffix}`
      const manualUserId = `attendance-autoshift-auto-write-manual-${runSuffix}`
      const workDate = '2026-06-11'
      const minuteOffset = Number.parseInt(runSuffix.slice(-2), 36) % 20
      const shiftStart = `03:${String(10 + minuteOffset).padStart(2, '0')}`
      const shiftEnd = `04:${String(40 + minuteOffset).padStart(2, '0')}`
      try {
        process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED = 'true'
        process.env.ATTENDANCE_AUTO_SHIFT_AUTO_WRITE_ENABLED = 'true'
        await saveAutoShiftSettings(adminToken, {
          autoShiftMatching: {
            enabled: true,
            mode: 'auto',
            maxToleranceMinutes: 30,
            minConfidenceToApply: 'high',
            autoWrite: { enabled: true, lookaheadDays: 1, maxAssignmentsPerRun: 25, minConfidence: 'high' },
          },
        })
        await createGroupForAutoShift(adminToken, `autoshift-auto-write-${runSuffix}`, 'scheduled_shift', userId)
        await createGroupForAutoShift(adminToken, `autoshift-auto-write-manual-${runSuffix}`, 'scheduled_shift', manualUserId)
        const shiftId = await createShiftForAutoShift(adminToken, `Auto Shift Auto Write ${runSuffix}`, shiftStart, shiftEnd)
        const manualShiftId = await createShiftForAutoShift(adminToken, `Auto Shift Auto Manual ${runSuffix}`, '07:10', '08:10')
        const inId = await insertPunchEvent(pool, userId, workDate, 'check_in', `${workDate}T${shiftStart}:00.000Z`)
        const outId = await insertPunchEvent(pool, userId, workDate, 'check_out', `${workDate}T${shiftEnd}:00.000Z`)
        await insertPunchEvent(pool, manualUserId, workDate, 'check_in', `${workDate}T${shiftStart}:00.000Z`)
        await insertPunchEvent(pool, manualUserId, workDate, 'check_out', `${workDate}T${shiftEnd}:00.000Z`)
        const manualAssignmentId = randomUuidV4()
        await pool.query(
          `INSERT INTO attendance_shift_assignments
           (id, org_id, user_id, shift_id, start_date, end_date, is_active)
           VALUES ($1, $2, $3, $4, $5, $5, true)`,
          [manualAssignmentId, orgId, manualUserId, manualShiftId, workDate],
        )

        const forbiddenRun = await runAutoShiftAutoWriteForTest(pool, '2026-06-10')
        expect(forbiddenRun).toMatchObject({ ran: true, status: 'succeeded', appliedCount: 0, errorCount: 0 })
        const forbiddenItemRows = await pool.query(
          `SELECT status, reason
             FROM attendance_auto_shift_auto_write_run_items
            WHERE run_id = $1 AND org_id = $2 AND user_id = $3 AND work_date = $4::date`,
          [forbiddenRun.runId, orgId, userId, workDate],
        )
        expect(forbiddenItemRows.rows[0]).toMatchObject({ status: 'skipped', reason: 'scheduler_scope_forbidden' })
        const forbiddenAssignments = await pool.query(
          'SELECT COUNT(*)::int AS count FROM attendance_shift_assignments WHERE org_id = $1 AND user_id = $2',
          [orgId, userId],
        )
        expect(Number(forbiddenAssignments.rows[0]?.count ?? 0)).toBe(0)

        await createAutoShiftSystemDispatchScope(pool, { userIds: [userId, manualUserId] })
        const firstRun = await runAutoShiftAutoWriteForTest(pool, '2026-06-10')
        expect(firstRun).toMatchObject({ ran: true, status: 'succeeded', appliedCount: 1, errorCount: 0 })
        const assignmentRows = await pool.query(
          `SELECT id, shift_id, slot_index, start_date, end_date, is_active, publish_status,
                  producer_type, producer_key, producer_run_id
             FROM attendance_shift_assignments
            WHERE org_id = $1 AND user_id = $2`,
          [orgId, userId],
        )
        expect(assignmentRows.rows).toHaveLength(1)
        expect(assignmentRows.rows[0]).toMatchObject({
          shift_id: shiftId,
          slot_index: 0,
          is_active: true,
          publish_status: 'published',
          producer_type: 'auto_shift_match',
          producer_key: `${userId}:${workDate}`,
          producer_run_id: firstRun.runId,
        })
        expect(dateOnlyForTest(assignmentRows.rows[0].start_date)).toBe(workDate)
        expect(dateOnlyForTest(assignmentRows.rows[0].end_date)).toBe(workDate)

        const itemRows = await pool.query(
          `SELECT status, assignment_id, candidate_shift_id, confidence, evidence_event_ids
             FROM attendance_auto_shift_auto_write_run_items
            WHERE run_id = $1 AND org_id = $2 AND user_id = $3 AND work_date = $4::date`,
          [firstRun.runId, orgId, userId, workDate],
        )
        expect(itemRows.rows).toHaveLength(1)
        expect(itemRows.rows[0]).toMatchObject({
          status: 'applied',
          assignment_id: assignmentRows.rows[0].id,
          candidate_shift_id: shiftId,
          confidence: 'high',
        })
        expect(itemRows.rows[0].evidence_event_ids).toEqual([inId, outId])
        const manualItemRows = await pool.query(
          `SELECT status, reason
             FROM attendance_auto_shift_auto_write_run_items
            WHERE run_id = $1 AND org_id = $2 AND user_id = $3 AND work_date = $4::date`,
          [firstRun.runId, orgId, manualUserId, workDate],
        )
        expect(manualItemRows.rows[0]).toMatchObject({ status: 'skipped', reason: 'already_scheduled' })
        const manualAssignmentRows = await pool.query(
          `SELECT id, shift_id, producer_type
             FROM attendance_shift_assignments
            WHERE org_id = $1 AND user_id = $2`,
          [orgId, manualUserId],
        )
        expect(manualAssignmentRows.rows).toHaveLength(1)
        expect(manualAssignmentRows.rows[0]).toMatchObject({
          id: manualAssignmentId,
          shift_id: manualShiftId,
          producer_type: null,
        })

        const replayRun = await runAutoShiftAutoWriteForTest(pool, '2026-06-10')
        expect(replayRun).toMatchObject({ ran: true, status: 'succeeded', appliedCount: 0, errorCount: 0 })
        const replayAssignments = await pool.query(
          'SELECT COUNT(*)::int AS count FROM attendance_shift_assignments WHERE org_id = $1 AND user_id = $2',
          [orgId, userId],
        )
        expect(Number(replayAssignments.rows[0]?.count ?? 0)).toBe(1)
        const replayItems = await pool.query(
          `SELECT status, reason
             FROM attendance_auto_shift_auto_write_run_items
            WHERE run_id = $1 AND org_id = $2 AND user_id = $3 AND work_date = $4::date`,
          [replayRun.runId, orgId, userId, workDate],
        )
        expect(replayItems.rows[0]).toMatchObject({ status: 'skipped', reason: 'already_scheduled' })
      } finally {
        await saveAutoShiftSettings(adminToken, originalSettings).catch(() => undefined)
        if (previousPreviewFlag === undefined) delete process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED
        else process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED = previousPreviewFlag
        if (previousAutoWriteFlag === undefined) delete process.env.ATTENDANCE_AUTO_SHIFT_AUTO_WRITE_ENABLED
        else process.env.ATTENDANCE_AUTO_SHIFT_AUTO_WRITE_ENABLED = previousAutoWriteFlag
        await pool.end()
      }
    })

    it('records max-cap and low-confidence auto-write skips without creating assignments', async () => {
      if (!baseUrl) return
      const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
      if (!dbUrl) return
      const runSuffix = Date.now().toString(36)
      const adminToken = await getAdminToken(`attendance-autoshift-auto-skip-admin-${runSuffix}`)
      expect(adminToken).toBeTruthy()
      if (!adminToken) return
      const previousPreviewFlag = process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED
      const previousAutoWriteFlag = process.env.ATTENDANCE_AUTO_SHIFT_AUTO_WRITE_ENABLED
      const originalSettings = await loadSettingsForTest(adminToken)
      const pool = new Pool({ connectionString: dbUrl })
      const workDate = '2026-06-11'
      const minuteOffset = Number.parseInt(runSuffix.slice(-2), 36) % 20
      const shiftStart = `11:${String(10 + minuteOffset).padStart(2, '0')}`
      const shiftEnd = `20:${String(40 + minuteOffset).padStart(2, '0')}`
      const lowInAt = `12:${String(10 + minuteOffset).padStart(2, '0')}`
      const lowOutAt = `21:${String(40 + minuteOffset).padStart(2, '0')}`
      const forbiddenUserId = `attendance-autoshift-aa-forbidden-${runSuffix}`
      const lowUserId = `attendance-autoshift-aa-low-${runSuffix}`
      const cappedUsers = [0, 1, 2].map(index => `attendance-autoshift-zz-cap-${index}-${runSuffix}`)
      try {
        process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED = 'true'
        process.env.ATTENDANCE_AUTO_SHIFT_AUTO_WRITE_ENABLED = 'true'
        await saveAutoShiftSettings(adminToken, {
          autoShiftMatching: {
            enabled: true,
            mode: 'auto',
            maxToleranceMinutes: 180,
            minConfidenceToApply: 'low',
            autoWrite: { enabled: true, lookaheadDays: 1, maxAssignmentsPerRun: 2, minConfidence: 'high' },
          },
        })
        const shiftId = await createShiftForAutoShift(adminToken, `Auto Shift Auto Skip ${runSuffix}`, shiftStart, shiftEnd)
        for (const userId of [forbiddenUserId, ...cappedUsers, lowUserId]) {
          await createGroupForAutoShift(adminToken, `autoshift-auto-skip-${userId}`, 'scheduled_shift', userId)
        }
        await createAutoShiftSystemDispatchScope(pool, { userIds: [...cappedUsers, lowUserId] })
        await insertPunchEvent(pool, forbiddenUserId, workDate, 'check_in', `${workDate}T${shiftStart}:00.000Z`)
        await insertPunchEvent(pool, forbiddenUserId, workDate, 'check_out', `${workDate}T${shiftEnd}:00.000Z`)
        for (const userId of cappedUsers) {
          await insertPunchEvent(pool, userId, workDate, 'check_in', `${workDate}T${shiftStart}:00.000Z`)
          await insertPunchEvent(pool, userId, workDate, 'check_out', `${workDate}T${shiftEnd}:00.000Z`)
        }
        await insertPunchEvent(pool, lowUserId, workDate, 'check_in', `${workDate}T${lowInAt}:00.000Z`)
        await insertPunchEvent(pool, lowUserId, workDate, 'check_out', `${workDate}T${lowOutAt}:00.000Z`)

        const run = await runAutoShiftAutoWriteForTest(pool, '2026-06-10')
        expect(run).toMatchObject({ ran: true, status: 'succeeded', appliedCount: 2, errorCount: 0 })
        const rows = await pool.query(
          `SELECT user_id, status, reason, candidate_shift_id, confidence, assignment_id
             FROM attendance_auto_shift_auto_write_run_items
            WHERE run_id = $1
              AND org_id = $2
              AND user_id = ANY($3::text[])
            ORDER BY user_id ASC`,
          [run.runId, orgId, [forbiddenUserId, ...cappedUsers, lowUserId]],
        )
        const byUser = new Map(rows.rows.map(row => [row.user_id, row]))
        expect(byUser.get(forbiddenUserId)).toMatchObject({
          status: 'skipped',
          reason: 'scheduler_scope_forbidden',
          candidate_shift_id: shiftId,
          confidence: 'high',
          assignment_id: null,
        })
        const appliedCappedUsers = cappedUsers.filter(userId => byUser.get(userId)?.status === 'applied')
        const cappedSkippedUsers = cappedUsers.filter(userId => byUser.get(userId)?.reason === 'max_assignments_per_run')
        expect(appliedCappedUsers).toHaveLength(2)
        expect(cappedSkippedUsers).toHaveLength(1)
        for (const userId of appliedCappedUsers) {
          expect(byUser.get(userId)).toMatchObject({ candidate_shift_id: shiftId, confidence: 'high' })
          expect(byUser.get(userId)?.assignment_id).toBeTruthy()
        }
        expect(byUser.get(lowUserId)).toMatchObject({
          status: 'skipped',
          reason: 'candidate_below_confidence',
          confidence: 'low',
          assignment_id: null,
        })
        const assignmentCounts = await pool.query(
          `SELECT user_id, COUNT(*)::int AS count
             FROM attendance_shift_assignments
            WHERE org_id = $1 AND user_id = ANY($2::text[])
            GROUP BY user_id`,
          [orgId, [...cappedUsers, lowUserId]],
        )
        const countByUser = new Map(assignmentCounts.rows.map(row => [row.user_id, Number(row.count)]))
        expect(cappedUsers.reduce((sum, userId) => sum + (countByUser.get(userId) ?? 0), 0)).toBe(2)
        expect(countByUser.get(lowUserId) ?? 0).toBe(0)
      } finally {
        await saveAutoShiftSettings(adminToken, originalSettings).catch(() => undefined)
        if (previousPreviewFlag === undefined) delete process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED
        else process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED = previousPreviewFlag
        if (previousAutoWriteFlag === undefined) delete process.env.ATTENDANCE_AUTO_SHIFT_AUTO_WRITE_ENABLED
        else process.env.ATTENDANCE_AUTO_SHIFT_AUTO_WRITE_ENABLED = previousAutoWriteFlag
        await pool.end()
      }
    })
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

  it('requires rejection comments and exposes request reason plus rejection note', async () => {
    if (!baseUrl) return

    const runSuffix = Date.now().toString(36)
    const testUserId = `attendance-reject-note-${runSuffix}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(testUserId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin,attendance:approve`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const workDate = new Date().toISOString().slice(0, 10)
    const requestReason = 'I need to correct the check-in time from the kiosk.'
    const rejectionComment = 'Please attach kiosk or manager evidence.'
    const requestCreateRes = await requestJson(`${baseUrl}/api/attendance/requests`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        workDate,
        requestType: 'time_correction',
        requestedInAt: new Date().toISOString(),
        reason: requestReason,
      }),
    })
    expect(requestCreateRes.status).toBe(201)
    const createdRequest = (requestCreateRes.body as { data?: { request?: { id?: string; reason?: string } } } | undefined)?.data?.request
    expect(createdRequest?.reason).toBe(requestReason)
    const requestId = createdRequest?.id
    expect(requestId).toBeTruthy()
    if (!requestId) return

    const emptyRejectRes = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/reject`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ comment: '   ' }),
    })
    expect(emptyRejectRes.status).toBe(400)
    const emptyRejectBody = (emptyRejectRes.body as {
      ok?: boolean
      error?: { code?: string; message?: string; details?: Array<{ field?: string }> }
    } | undefined) ?? {}
    expect(emptyRejectBody.ok).toBe(false)
    expect(emptyRejectBody.error?.code).toBe('VALIDATION_ERROR')
    expect(emptyRejectBody.error?.message).toBe('Rejection comment is required')
    expect(emptyRejectBody.error?.details?.[0]?.field).toBe('comment')

    const rejectRes = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/reject`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ comment: rejectionComment }),
    })
    expect(rejectRes.status).toBe(200)
    expect((rejectRes.body as { data?: { status?: string } } | undefined)?.data?.status).toBe('rejected')

    const requestGetRes = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(requestGetRes.status).toBe(200)
    const rejectedRequest = (requestGetRes.body as {
      data?: {
        request?: {
          status?: string
          reason?: string
          metadata?: { resolution?: { action?: string; status?: string; comment?: string } }
        }
      }
    } | undefined)?.data?.request
    expect(rejectedRequest?.status).toBe('rejected')
    expect(rejectedRequest?.reason).toBe(requestReason)
    expect(rejectedRequest?.metadata?.resolution?.action).toBe('reject')
    expect(rejectedRequest?.metadata?.resolution?.status).toBe('rejected')
    expect(rejectedRequest?.metadata?.resolution?.comment).toBe(rejectionComment)
  })

  it('returns validation errors for malformed attendance UUID route params', async () => {
    if (!baseUrl) return

    const runSuffix = Date.now().toString(36)
    const testUserId = `attendance-invalid-id-${runSuffix}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(testUserId)}&roles=user&perms=attendance:read,attendance:write,attendance:admin`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const cases = [
      { method: 'GET', path: '/api/attendance/requests/not-a-uuid' },
      { method: 'PUT', path: '/api/attendance/requests/not-a-uuid', body: {} },
      { method: 'POST', path: '/api/attendance/requests/not-a-uuid/cancel', body: {} },
      { method: 'DELETE', path: '/api/attendance/requests/not-a-uuid' },
      { method: 'GET', path: '/api/attendance/payroll-cycles/not-a-uuid/summary' },
      { method: 'GET', path: '/api/attendance/payroll-cycles/not-a-uuid/summary/export' },
      { method: 'GET', path: '/api/attendance/payroll-cycles/not-a-uuid/export' },
      { method: 'GET', path: '/api/attendance/holidays/not-a-uuid' },
    ]

    for (const testCase of cases) {
      const res = await requestJson(`${baseUrl}${testCase.path}`, {
        method: testCase.method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(testCase.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: testCase.body ? JSON.stringify(testCase.body) : undefined,
      })
      expect(res.status, `${testCase.method} ${testCase.path}`).toBe(400)
      const body = (res.body as { ok?: boolean; error?: { code?: string; message?: string } } | undefined) ?? {}
      expect(body.ok, `${testCase.method} ${testCase.path}`).toBe(false)
      expect(body.error?.code, `${testCase.method} ${testCase.path}`).toBe('VALIDATION_ERROR')
      expect(body.error?.message, `${testCase.method} ${testCase.path}`).toBe('id must be a UUID')
    }
  })

  it('returns validation errors for malformed attendance request reference UUIDs', async () => {
    if (!baseUrl) return

    const runSuffix = Date.now().toString(36)
    const testUserId = `attendance-invalid-ref-${runSuffix}`
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(testUserId)}&roles=user&perms=attendance:read,attendance:write`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) return

    const workDate = new Date().toISOString().slice(0, 10)
    const requestedInAt = new Date().toISOString()
    const cases = [
      {
        field: 'leaveTypeId',
        payload: {
          workDate,
          requestType: 'leave',
          leaveTypeId: 'not-a-uuid',
          minutes: 60,
        },
      },
      {
        field: 'overtimeRuleId',
        payload: {
          workDate,
          requestType: 'overtime',
          overtimeRuleId: 'not-a-uuid',
          minutes: 60,
        },
      },
      {
        field: 'approvalFlowId',
        payload: {
          workDate,
          requestType: 'time_correction',
          requestedInAt,
          approvalFlowId: 'not-a-uuid',
        },
      },
    ]

    for (const testCase of cases) {
      const res = await requestJson(`${baseUrl}/api/attendance/requests`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(testCase.payload),
      })
      expect(res.status, testCase.field).toBe(400)
      const body = (res.body as {
        ok?: boolean
        error?: { code?: string; message?: string; details?: Array<{ field?: string; message?: string }> }
      } | undefined) ?? {}
      expect(body.ok, testCase.field).toBe(false)
      expect(body.error?.code, testCase.field).toBe('VALIDATION_ERROR')
      expect(body.error?.message, testCase.field).toBe(`${testCase.field} must be a UUID`)
      expect(body.error?.details?.[0]?.field, testCase.field).toBe(testCase.field)
    }
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

  it('#5 report tiering — severe-late / absence-late tiers are self-calculated and round-trip through the records report (real DB)', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return
    const runSuffix = Date.now().toString(36)
    // collision-free future year; a Monday (workday) + the next day (Tuesday, workday).
    const year = 3600 + (Number.parseInt(runSuffix.slice(-4), 36) % 1000)
    const firstOfOctober = new Date(Date.UTC(year, 9, 1))
    const monday = new Date(firstOfOctober)
    while (monday.getUTCDay() !== 1) monday.setUTCDate(monday.getUTCDate() + 1)
    const severeDate = monday.toISOString().slice(0, 10)
    const absenceObj = new Date(monday)
    absenceObj.setUTCDate(monday.getUTCDate() + 1)
    const absenceDate = absenceObj.toISOString().slice(0, 10)
    const userId = `attendance-rt1-${runSuffix}`
    const previousRbacBypass = process.env.RBAC_BYPASS
    const pool = new Pool({ connectionString: dbUrl })
    try {
      process.env.RBAC_BYPASS = 'true'
      const tokenRes = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`)
      const token = (tokenRes.body as { token?: string } | undefined)?.token
      expect(token).toBeTruthy()
      if (!token) return
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

      // Default rule: 09:00 start, 10-min grace, severe 30 / absence 60 (over the grace window).
      //   09:45 → 35 min late  (≥ severe 30, < absence 60) → severe-late only.
      //   10:30 → 80 min late  (≥ absence 60)              → severe + absence (tiers nest).
      const importPayload = {
        userId,
        rows: [
          { workDate: severeDate, fields: { firstInAt: `${severeDate}T09:45:00Z`, lastOutAt: `${severeDate}T18:00:00Z` } },
          { workDate: absenceDate, fields: { firstInAt: `${absenceDate}T10:30:00Z`, lastOutAt: `${absenceDate}T18:00:00Z` } },
        ],
        mode: 'override',
      }
      const importRes = await requestJson(`${baseUrl}/api/attendance/import`, { method: 'POST', headers, body: JSON.stringify(importPayload) })
      expect(importRes.status, importRes.raw).toBe(200)
      expect(Number((importRes.body as { data?: { imported?: number } } | undefined)?.data?.imported ?? 0)).toBeGreaterThanOrEqual(2)

      const recordsRes = await requestJson(
        `${baseUrl}/api/attendance/records?userId=${encodeURIComponent(userId)}&from=${severeDate}&to=${absenceDate}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      expect(recordsRes.status).toBe(200)
      const items = (recordsRes.body as { data?: { items?: any[] } } | undefined)?.data?.items ?? []
      const byDate = (d: string) => items.find((r) => String(r?.work_date || '').slice(0, 10) === d)

      // severe-only record: late_count proves the report plumbing; severe=1 proves self-calc; absence=0 proves the boundary.
      const severe = byDate(severeDate)
      expect(severe, 'severe-late record present').toBeTruthy()
      expect(Number(severe?.late_minutes)).toBe(35)
      const severeRv = (severe?.report_values ?? {}) as Record<string, unknown>
      expect(Number(severeRv.late_count ?? -1)).toBe(1)
      expect(Number(severeRv.severe_late_count ?? -1)).toBe(1)
      expect(Number(severeRv.severe_late_duration ?? -1)).toBe(35)
      expect(Number(severeRv.absence_late_count ?? -1)).toBe(0)

      // absence-level record: both tiers fire (nested).
      const absence = byDate(absenceDate)
      expect(absence, 'absence-late record present').toBeTruthy()
      expect(Number(absence?.late_minutes)).toBe(80)
      const absenceRv = (absence?.report_values ?? {}) as Record<string, unknown>
      expect(Number(absenceRv.severe_late_count ?? -1)).toBe(1)
      expect(Number(absenceRv.absence_late_count ?? -1)).toBe(1)
    } finally {
      await pool.query('DELETE FROM attendance_records WHERE user_id = $1', [userId]).catch(() => {})
      await pool.end().catch(() => {})
      if (previousRbacBypass === undefined) delete process.env.RBAC_BYPASS
      else process.env.RBAC_BYPASS = previousRbacBypass
    }
  })

  it('#5 RT-1a — per-group thresholds are configurable end-to-end + the normalizer rejects incoherent input (real DB)', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return
    const runSuffix = Date.now().toString(36)
    const orgId = `rt1a-org-${runSuffix}` // isolated org — never pollutes the shared default rule
    const year = 3600 + (Number.parseInt(runSuffix.slice(-4), 36) % 1000)
    const firstOfOctober = new Date(Date.UTC(year, 9, 1))
    const monday = new Date(firstOfOctober)
    while (monday.getUTCDay() !== 1) monday.setUTCDate(monday.getUTCDate() + 1)
    const workDate = monday.toISOString().slice(0, 10)
    const userId = `attendance-rt1a-${runSuffix}`
    const previousRbacBypass = process.env.RBAC_BYPASS
    const pool = new Pool({ connectionString: dbUrl })
    try {
      process.env.RBAC_BYPASS = 'true'
      const tokenRes = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`)
      const token = (tokenRes.body as { token?: string } | undefined)?.token
      expect(token).toBeTruthy()
      if (!token) return
      const orgHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-org-id': orgId }
      const putRule = (body: Record<string, unknown>) => requestJson(`${baseUrl}/api/attendance/rules/default`, {
        method: 'PUT', headers: orgHeaders, body: JSON.stringify({ orgId, ...body }),
      })

      // Normalizer (design-lock §2 / the #1776 enum-strict rule) — reject BEFORE any persistence:
      const ordered = { workStartTime: '09:00', workEndTime: '18:00', lateGraceMinutes: 10 }
      expect((await putRule({ ...ordered, severeLateThresholdMinutes: 50, absenceLateThresholdMinutes: 20 })).status).toBe(400) // absence < severe
      expect((await putRule({ lateGraceMinutes: 30, severeLateThresholdMinutes: 20, absenceLateThresholdMinutes: 60 })).status).toBe(400) // severe < grace
      expect((await putRule({ ...ordered, severeLateThresholdMinutes: 15.5 })).status).toBe(400) // non-integer (Zod)
      expect((await putRule({ ...ordered, severeLateThresholdMinutes: -5 })).status).toBe(400) // negative (Zod)

      // Valid custom rule: severe 15 / absence 40 (ordered, ≥ grace 10).
      const okRes = await putRule({ ...ordered, severeLateThresholdMinutes: 15, absenceLateThresholdMinutes: 40 })
      expect(okRes.status, okRes.raw).toBe(200)
      const ruleData = (okRes.body as { data?: Record<string, unknown> } | undefined)?.data ?? {}
      expect(Number(ruleData.severeLateThresholdMinutes)).toBe(15) // RETURNING * → mapRuleRow surfaces it
      expect(Number(ruleData.absenceLateThresholdMinutes)).toBe(40)

      // Import a 20-min-late record (09:30): 20 ≥ custom 15 → severe; would be 0 at the RT-1 default 30.
      const importRes = await requestJson(`${baseUrl}/api/attendance/import`, {
        method: 'POST', headers: orgHeaders,
        body: JSON.stringify({ userId, mode: 'override', rows: [{ workDate, fields: { firstInAt: `${workDate}T09:30:00Z`, lastOutAt: `${workDate}T18:00:00Z` } }] }),
      })
      expect(importRes.status, importRes.raw).toBe(200)

      const recordsRes = await requestJson(
        `${baseUrl}/api/attendance/records?userId=${encodeURIComponent(userId)}&from=${workDate}&to=${workDate}`,
        { headers: { Authorization: `Bearer ${token}`, 'x-org-id': orgId } },
      )
      expect(recordsRes.status).toBe(200)
      const items = (recordsRes.body as { data?: { items?: any[] } } | undefined)?.data?.items ?? []
      const record = items.find((r) => String(r?.work_date || '').slice(0, 10) === workDate)
      expect(record, 'record present').toBeTruthy()
      expect(Number(record?.late_minutes)).toBe(20)
      const rv = (record?.report_values ?? {}) as Record<string, unknown>
      // the per-group threshold flowed through loadDefaultRule → mapRuleRow → computeLateTierCounts:
      expect(Number(rv.severe_late_count ?? -1)).toBe(1) // 20 ≥ custom 15 (would be 0 at the default 30)
      expect(Number(rv.absence_late_count ?? -1)).toBe(0) // 20 < custom 40
    } finally {
      await pool.query('DELETE FROM attendance_records WHERE user_id = $1', [userId]).catch(() => {})
      await pool.query('DELETE FROM attendance_rules WHERE org_id = $1', [orgId]).catch(() => {})
      await pool.end().catch(() => {})
      if (previousRbacBypass === undefined) delete process.env.RBAC_BYPASS
      else process.env.RBAC_BYPASS = previousRbacBypass
    }
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
      // Settle-gate the compact skipped summary so the exact-count assertions below are
      // deterministic: skippedRows is omitted from the compact payload until the summary lands
      // just after status flips to 'completed' (failedRows/skippedCount/skippedRows are written
      // together), which made this test intermittently observe failedRows=0. Gating on
      // skippedRows presence (≥1) — not on the exact count — keeps the assertions strict.
      // Test-only mitigation per
      // docs/development/attendance-plugin-commit-async-skipped-summary-flake-lead-20260526.md (#1905);
      // the heavier server-side fix (write the summary atomically with the status) is deliberately deferred.
      settle: (job) => Array.isArray(job?.skippedRows) && job.skippedRows.length >= 1,
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

  it('rejects default-template CSV rows with 工号 when no userMap resolves them', async () => {
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
    const previewItems = (
      previewRes.body as {
        data?: {
          items?: Array<{ userId?: string; workDate?: string; status?: string; warnings?: string[] }>
        }
      } | undefined
    )?.data?.items ?? []
    expect(previewItems.length).toBeGreaterThan(0)
    expect(previewItems[0]?.userId).toBe('unknown')
    expect(previewItems[0]?.workDate).toBe(workDate)
    expect(previewItems[0]?.status).toBe('invalid')
    expect(previewItems[0]?.warnings?.join('\n')).toContain('Unresolved user identifier')
    expect(previewItems[0]?.warnings?.join('\n')).toContain('工号')

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
    expect(Number(commitData?.processedRows ?? -1)).toBe(0)
    expect(Number(commitData?.failedRows ?? -1)).toBeGreaterThanOrEqual(1)
    expect(commitData?.skipped?.[0]?.userId).toBeNull()
    expect(commitData?.skipped?.[0]?.warnings?.join('\n')).toContain('Unresolved user identifier')

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

  it('#6 TA-1 — pending leave surfaces as a display-only pending_leave overlay behind includePending (real DB)', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return
    const runSuffix = Date.now().toString(36)
    const year = 3600 + (Number.parseInt(runSuffix.slice(-4), 36) % 1000)
    const firstOfOctober = new Date(Date.UTC(year, 9, 1))
    const monday = new Date(firstOfOctober)
    while (monday.getUTCDay() !== 1) monday.setUTCDate(monday.getUTCDate() + 1)
    const workDate = monday.toISOString().slice(0, 10)
    const userId = `attendance-ta1-${runSuffix}`
    const requestId = randomUUID()
    const previousRbacBypass = process.env.RBAC_BYPASS
    const pool = new Pool({ connectionString: dbUrl })
    try {
      process.env.RBAC_BYPASS = 'true'
      const tokenRes = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`)
      const token = (tokenRes.body as { token?: string } | undefined)?.token
      expect(token).toBeTruthy()
      if (!token) return
      const auth = { Authorization: `Bearer ${token}` }

      // a PENDING leave request (never approved) for the user on workDate
      await pool.query(
        `INSERT INTO attendance_requests (id, org_id, user_id, work_date, request_type, status, metadata)
         VALUES ($1, 'default', $2, $3, 'leave', 'pending', '{}'::jsonb)`,
        [requestId, userId, workDate],
      )

      const calUrl = (extra: string) => `${baseUrl}/api/attendance/effective-calendar?userId=${encodeURIComponent(userId)}&from=${workDate}&to=${workDate}${extra}`
      const pendingOverlaysFor = (body: any) => {
        const items = (body?.data?.items ?? []) as any[]
        const item = items.find((it) => String(it?.date || '').slice(0, 10) === workDate)
        return ((item?.overlays ?? []) as Array<Record<string, unknown>>).filter((o) => o.kind === 'pending_leave')
      }

      // includePending=true → the pending_leave overlay is present, distinct + provisional
      const withPendingRes = await requestJson(calUrl('&includePending=true'), { headers: auth })
      expect(withPendingRes.status).toBe(200)
      const pendingOverlays = pendingOverlaysFor(withPendingRes.body)
      expect(pendingOverlays.length).toBe(1)
      expect(pendingOverlays[0]?.refId).toBe(requestId)
      expect(pendingOverlays[0]?.status).toBe('pending')
      expect(pendingOverlays[0]?.provisional).toBe(true)

      // default (no includePending) → NO pending_leave overlay. This is the call the record-compute path
      // uses, so proving it here proves pending never reaches records (the display-only invariant).
      const defaultRes = await requestJson(calUrl(''), { headers: auth })
      expect(defaultRes.status).toBe(200)
      expect(pendingOverlaysFor(defaultRes.body).length).toBe(0)

      // corroboration: a pending leave is not a fact — no attendance_record exists for that date.
      const recRes = await requestJson(`${baseUrl}/api/attendance/records?userId=${encodeURIComponent(userId)}&from=${workDate}&to=${workDate}`, { headers: auth })
      expect(recRes.status).toBe(200)
      const recItems = (recRes.body as { data?: { items?: any[] } } | undefined)?.data?.items ?? []
      expect(recItems.find((r) => String(r?.work_date || '').slice(0, 10) === workDate)).toBeFalsy()
    } finally {
      await pool.query('DELETE FROM attendance_requests WHERE id = $1', [requestId]).catch(() => {})
      await pool.end().catch(() => {})
      if (previousRbacBypass === undefined) delete process.env.RBAC_BYPASS
      else process.env.RBAC_BYPASS = previousRbacBypass
    }
  })

  it('#6 TA-2 — team-availability: pending leave is a distinct tentative state still counted in availableFormal (§3a), group-scope gated (§3b), group-only (§3e) (real DB)', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return
    const runSuffix = Date.now().toString(36)
    const year = 3600 + (Number.parseInt(runSuffix.slice(-4), 36) % 1000)
    const firstOfOctober = new Date(Date.UTC(year, 9, 1))
    const monday = new Date(firstOfOctober)
    while (monday.getUTCDay() !== 1) monday.setUTCDate(monday.getUTCDate() + 1)
    const workDate = monday.toISOString().slice(0, 10)
    const m1 = `att-ta2-pending-${runSuffix}`
    const m2 = `att-ta2-sched-${runSuffix}`
    const outsider = `att-ta2-outsider-${runSuffix}`
    const previousRbacBypass = process.env.RBAC_BYPASS
    const pool = new Pool({ connectionString: dbUrl })
    const reqId = randomUUID()
    let groupId: string | undefined
    try {
      process.env.RBAC_BYPASS = 'true'
      const tokenRes = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(m1)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`)
      const token = (tokenRes.body as { token?: string } | undefined)?.token
      if (!token) return
      const auth = { Authorization: `Bearer ${token}` }

      const groupRows = await pool.query<{ id: string }>(
        `INSERT INTO attendance_groups (org_id, name, code, timezone) VALUES ('default', $1, $2, 'UTC') RETURNING id`,
        [`TA2 ${runSuffix}`, `ta2-${runSuffix}`],
      )
      groupId = String(groupRows.rows[0].id)
      await pool.query(
        `INSERT INTO attendance_group_members (org_id, group_id, user_id) VALUES ('default', $1, $2), ('default', $1, $3)`,
        [groupId, m1, m2],
      )
      // a PENDING leave for m1 on workDate (never approved)
      await pool.query(
        `INSERT INTO attendance_requests (id, org_id, user_id, work_date, request_type, status, metadata) VALUES ($1, 'default', $2, $3, 'leave', 'pending', '{}'::jsonb)`,
        [reqId, m1, workDate],
      )

      // (1) §3e group-only: missing groupId → 400
      expect((await requestJson(`${baseUrl}/api/attendance/team-availability?from=${workDate}&to=${workDate}`, { headers: auth })).status).toBe(400)

      // (2) happy path: m1 = pending_leave (distinct); m2 unaffected; §3a availableFormal still counts m1.
      const res = await requestJson(`${baseUrl}/api/attendance/team-availability?groupId=${groupId}&from=${workDate}&to=${workDate}`, { headers: auth })
      expect(res.status, res.raw).toBe(200)
      const data = (res.body as { data?: { items?: any[]; summary?: any[] } } | undefined)?.data
      const items = data?.items ?? []
      const stateOf = (uid: string) => items.find((it) => it.userId === uid && String(it.date).slice(0, 10) === workDate)?.state
      expect(stateOf(m1)).toBe('pending_leave')
      expect(['scheduled', 'rest', 'unscheduled']).toContain(stateOf(m2)) // m2 NOT affected by m1's pending request
      const day = (data?.summary ?? []).find((s) => String(s.date).slice(0, 10) === workDate)
      expect(day?.pendingLeaveTentative).toBe(1)
      expect(day?.approvedLeave).toBe(0) // pending is NOT approved
      // §3a: the pending member is still in the formal available headcount (availableFormal = scheduled + pending).
      expect(day?.availableFormal).toBe((day?.scheduled ?? 0) + 1)

      // (2.5) P2 (owner review): admin + a valid-UUID but NON-EXISTENT group → 404, not a misleading 200 empty.
      const ghostRes = await requestJson(`${baseUrl}/api/attendance/team-availability?groupId=${randomUUID()}&from=${workDate}&to=${workDate}`, { headers: auth })
      expect(ghostRes.status).toBe(404)

      // (3) §3b scope gate: an outsider (non-admin, not a group manager) → 403
      process.env.RBAC_BYPASS = 'false'
      const outsiderTokenRes = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(outsider)}&roles=employee&perms=attendance:read`)
      const outsiderToken = (outsiderTokenRes.body as { token?: string } | undefined)?.token
      if (outsiderToken) {
        const forbidden = await requestJson(`${baseUrl}/api/attendance/team-availability?groupId=${groupId}&from=${workDate}&to=${workDate}`, { headers: { Authorization: `Bearer ${outsiderToken}` } })
        expect(forbidden.status).toBe(403)
      }
    } finally {
      await pool.query('DELETE FROM attendance_requests WHERE id = $1', [reqId]).catch(() => undefined)
      if (groupId) {
        await pool.query('DELETE FROM attendance_group_members WHERE group_id = $1', [groupId]).catch(() => undefined)
        await pool.query('DELETE FROM attendance_groups WHERE id = $1', [groupId]).catch(() => undefined)
      }
      if (previousRbacBypass === undefined) delete process.env.RBAC_BYPASS
      else process.env.RBAC_BYPASS = previousRbacBypass
      await pool.end().catch(() => undefined)
    }
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
    const previousRbacBypass = process.env.RBAC_BYPASS
    const pool = new Pool({ connectionString: dbUrl })

    try {
      process.env.RBAC_BYPASS = 'false'
      await pool.query(
        `INSERT INTO permissions (code, name, description)
         VALUES
           ('attendance:read', 'Attendance Read', 'Read attendance data'),
           ('attendance:approve', 'Attendance Approve', 'Approve attendance requests'),
           ('attendance:admin', 'Attendance Admin', 'Administer attendance')
         ON CONFLICT (code) DO NOTHING`
      )
      await pool.query(
        `INSERT INTO user_permissions (user_id, permission_code)
         VALUES
           ($1, 'attendance:read'),
           ($1, 'attendance:approve'),
           ($2, 'attendance:read'),
           ($2, 'attendance:admin')
         ON CONFLICT DO NOTHING`,
        [requesterId, adminId]
      )

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

      await pool.query('DELETE FROM user_permissions WHERE user_id = $1 AND permission_code = $2', [requesterId, 'attendance:approve'])

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

      await pool.query(
        `INSERT INTO user_permissions (user_id, permission_code)
         VALUES ($1, 'attendance:approve')
         ON CONFLICT DO NOTHING`,
        [requesterId]
      )

      // RBAC: read+approve token querying another user → 200
      const approveOtherRes = await requestJson(`${base}?${dateRange}&userId=${encodeURIComponent(targetId)}`, {
        headers: { Authorization: `Bearer ${approveToken}` },
      })
      expect(approveOtherRes.status).toBe(200)

      await pool.query('DELETE FROM user_permissions WHERE user_id = $1 AND permission_code = $2', [requesterId, 'attendance:approve'])

      // RBAC: read-only token using groupId → 403 (groupId requires attendance:admin)
      const groupDenyRes = await requestJson(`${base}?${dateRange}&groupId=anything`, {
        headers: { Authorization: `Bearer ${readOnlyToken}` },
      })
      expect(groupDenyRes.status).toBe(403)
    } finally {
      process.env.RBAC_BYPASS = previousRbacBypass
      await pool.query('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[requesterId, adminId]]).catch(() => undefined)
      await pool.end()
    }
  })

  it('H1 scheduler-scope smoke keeps approve/import reachable for scope-only actors', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return

    const runSuffix = Date.now().toString(36)
    const orgId = 'default'
    const actorId = `attendance-h1-scope-actor-${runSuffix}`
    const targetId = `attendance-h1-scope-target-${runSuffix}`
    const outsideTargetId = `attendance-h1-scope-outside-${runSuffix}`
    const requestIds: string[] = []
    const approvalIds: string[] = []
    const scopeIds: string[] = []
    const previousRbacBypass = process.env.RBAC_BYPASS
    const pool = new Pool({ connectionString: dbUrl })

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(actorId)}&roles=user&perms=attendance:read,attendance:write`
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    if (!token) {
      await pool.end()
      return
    }
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

    const createPendingLeaveRequest = async (userId: string, workDate: string): Promise<string> => {
      const approvalId = `attendance-h1-scope-approval-${randomUUID()}`
      const requestId = randomUuidV4()
      approvalIds.push(approvalId)
      requestIds.push(requestId)
      await pool.query(
        `INSERT INTO approval_instances
           (id, status, version, current_step, total_steps, current_node_key, metadata)
         VALUES ($1, 'pending', 0, 0, 0, 'attendance_request_step_0', '{}'::jsonb)`,
        [approvalId]
      )
      await pool.query(
        `INSERT INTO attendance_requests
           (id, org_id, user_id, work_date, request_type, status, reason, metadata, approval_instance_id)
         VALUES ($1, $2, $3, $4, 'leave', 'pending', $5, $6::jsonb, $7)`,
        [
          requestId,
          orgId,
          userId,
          workDate,
          `H1 scheduler scope smoke ${runSuffix}`,
          JSON.stringify({ minutes: 60, leaveType: { code: 'personal_leave' } }),
          approvalId,
        ]
      )
      return requestId
    }

    try {
      process.env.RBAC_BYPASS = 'false'
      await pool.query(
        `INSERT INTO permissions (code, name, description)
         VALUES
           ('attendance:read', 'Attendance Read', 'Read attendance data'),
           ('attendance:write', 'Attendance Write', 'Write attendance data'),
           ('attendance:approve', 'Attendance Approve', 'Approve attendance requests'),
           ('attendance:import', 'Attendance Import', 'Import attendance data'),
           ('attendance:admin', 'Attendance Admin', 'Administer attendance')
         ON CONFLICT (code) DO NOTHING`
      )
      await pool.query('DELETE FROM user_permissions WHERE user_id = $1', [actorId])
      await pool.query('DELETE FROM user_roles WHERE user_id = $1', [actorId])

      const centralGrantsBefore = await pool.query(
        `SELECT permission_code
         FROM user_permissions
         WHERE user_id = $1
           AND permission_code = ANY($2::text[])`,
        [actorId, ['attendance:approve', 'attendance:import', 'attendance:admin']]
      )
      expect(centralGrantsBefore.rows).toHaveLength(0)
      const adminRolesBefore = await pool.query(
        `SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = 'admin'`,
        [actorId]
      )
      expect(adminRolesBefore.rows).toHaveLength(0)

      const targetRequestId = await createPendingLeaveRequest(targetId, '2036-06-26')
      const noScopeApprove = await requestJson(`${baseUrl}/api/attendance/requests/${targetRequestId}/approve`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ comment: 'no scope yet' }),
      })
      expect(noScopeApprove.status, noScopeApprove.raw).toBe(403)
      expect((noScopeApprove.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SCHEDULER_SCOPE_FORBIDDEN')

      const scopeId = randomUuidV4()
      scopeIds.push(scopeId)
      await pool.query(
        `INSERT INTO attendance_scheduler_scopes
           (id, org_id, subject_type, subject_ref, actions, scope, is_active, created_by, updated_by)
         VALUES ($1, $2, 'user', $3, ARRAY['approve','import']::text[], $4::jsonb, true, 'integration-test', 'integration-test')`,
        [scopeId, orgId, actorId, JSON.stringify({ userIds: [targetId] })]
      )

      const approveInsideScope = await requestJson(`${baseUrl}/api/attendance/requests/${targetRequestId}/approve`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ comment: 'scope-only approve' }),
      })
      expect(approveInsideScope.status, approveInsideScope.raw).toBe(200)
      expect((approveInsideScope.body as { data?: { status?: string } } | undefined)?.data?.status).toBe('approved')

      const outsideRequestId = await createPendingLeaveRequest(outsideTargetId, '2036-06-27')
      const approveOutsideScope = await requestJson(`${baseUrl}/api/attendance/requests/${outsideRequestId}/approve`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ comment: 'outside scope' }),
      })
      expect(approveOutsideScope.status, approveOutsideScope.raw).toBe(403)
      expect((approveOutsideScope.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SCHEDULER_SCOPE_FORBIDDEN')
      const outsideStatus = (await pool.query('SELECT status FROM attendance_requests WHERE id = $1', [outsideRequestId])).rows[0]?.status
      expect(outsideStatus).toBe('pending')

      const prepareImport = await requestJson(`${baseUrl}/api/attendance/import/prepare`, {
        method: 'POST',
        headers,
        body: '{}',
      })
      expect(prepareImport.status, prepareImport.raw).toBe(200)
      expect((prepareImport.body as { data?: { commitToken?: string } } | undefined)?.data?.commitToken).toEqual(expect.any(String))

      const centralGrantsAfter = await pool.query(
        `SELECT permission_code
         FROM user_permissions
         WHERE user_id = $1
           AND permission_code = ANY($2::text[])`,
        [actorId, ['attendance:approve', 'attendance:import', 'attendance:admin']]
      )
      expect(centralGrantsAfter.rows).toHaveLength(0)
      const adminRolesAfter = await pool.query(
        `SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = 'admin'`,
        [actorId]
      )
      expect(adminRolesAfter.rows).toHaveLength(0)
    } finally {
      if (previousRbacBypass === undefined) delete process.env.RBAC_BYPASS
      else process.env.RBAC_BYPASS = previousRbacBypass
      await pool.query('DELETE FROM attendance_import_tokens WHERE user_id = $1', [actorId]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_scheduler_scopes WHERE id = ANY($1::uuid[])', [scopeIds]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_leave_balance_events WHERE user_id = ANY($1::text[])', [[targetId, outsideTargetId]]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_leave_balances WHERE user_id = ANY($1::text[])', [[targetId, outsideTargetId]]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_events WHERE user_id = ANY($1::text[])', [[targetId, outsideTargetId]]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_records WHERE user_id = ANY($1::text[])', [[targetId, outsideTargetId]]).catch(() => undefined)
      if (requestIds.length) {
        await pool.query('DELETE FROM attendance_requests WHERE id = ANY($1::uuid[])', [requestIds]).catch(() => undefined)
      }
      if (approvalIds.length) {
        await pool.query('DELETE FROM approval_records WHERE instance_id = ANY($1::text[])', [approvalIds]).catch(() => undefined)
        await pool.query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [approvalIds]).catch(() => undefined)
      }
      await pool.query('DELETE FROM user_permissions WHERE user_id = $1', [actorId]).catch(() => undefined)
      await pool.query('DELETE FROM user_roles WHERE user_id = $1', [actorId]).catch(() => undefined)
      await pool.end().catch(() => undefined)
    }
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

  it('C5-4: lists notification deliveries with counters, pagination, filtering, and admin-only access', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return

    const runSuffix = Date.now().toString(36)
    const orgId = `c5-observe-${runSuffix}`
    const adminId = `c5-observe-admin-${runSuffix}`
    const readOnlyId = `c5-observe-reader-${runSuffix}`
    const previousRbacBypass = process.env.RBAC_BYPASS
    const pool = new Pool({ connectionString: dbUrl })

    async function tokenFor(uid: string, role: string, perms: string): Promise<string | null> {
      const res = await requestJson(
        `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(uid)}&roles=${role}&perms=${perms}`,
      )
      return (res.body as { token?: string } | undefined)?.token ?? null
    }

    const insertDelivery = async (
      label: string,
      status: 'pending' | 'sent' | 'failed',
      overrides: { attemptCount?: number; lastError?: string | null; deliveredAt?: string | null } = {},
    ) => {
      await pool.query(
        `INSERT INTO attendance_notification_deliveries
           (org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, channel, status,
            attempt_count, last_error, delivered_at, payload)
         VALUES ($1, $2, $3, $4, $5, $6, 'dingtalk_work_notification', $7, $8, $9, $10::timestamptz, $11::jsonb)`,
        [
          orgId,
          label === 'expiry' ? 'comp_time_expiry_reminder' : 'unscheduled_reminder',
          randomUUID(),
          `c5-observe:${runSuffix}:${label}`,
          `recipient-${label}-${runSuffix}`,
          label === 'owner' ? 'owner' : 'subject',
          status,
          overrides.attemptCount ?? 0,
          overrides.lastError ?? null,
          overrides.deliveredAt ?? null,
          JSON.stringify({ title: `Delivery ${label}`, body: 'C5 observe test' }),
        ],
      )
    }

    try {
      process.env.RBAC_BYPASS = 'false'
      await pool.query(
        `INSERT INTO permissions (code, name, description)
         VALUES
           ('attendance:read', 'Attendance Read', 'Read attendance data'),
           ('attendance:admin', 'Attendance Admin', 'Administer attendance')
         ON CONFLICT (code) DO NOTHING`,
      )
      await pool.query(
        `INSERT INTO user_permissions (user_id, permission_code)
         VALUES
           ($1, 'attendance:read'),
           ($1, 'attendance:admin'),
           ($2, 'attendance:read')
         ON CONFLICT DO NOTHING`,
        [adminId, readOnlyId],
      )
      await requireAttendanceTable(pool, 'attendance_notification_deliveries')
      await insertDelivery('pending', 'pending')
      await insertDelivery('owner', 'failed', { attemptCount: 2, lastError: 'recipient_not_bound' })
      await insertDelivery('expiry', 'sent', { attemptCount: 1, deliveredAt: new Date().toISOString() })

      const adminToken = await tokenFor(adminId, 'admin', 'attendance:read,attendance:admin')
      const readOnlyToken = await tokenFor(readOnlyId, 'user', 'attendance:read')
      expect(adminToken).toBeTruthy()
      expect(readOnlyToken).toBeTruthy()
      if (!adminToken || !readOnlyToken) return

      const listRes = await requestJson(
        `${baseUrl}/api/attendance/notification-deliveries?orgId=${encodeURIComponent(orgId)}&page=1&pageSize=2`,
        { headers: { Authorization: `Bearer ${adminToken}` } },
      )
      expect(listRes.status).toBe(200)
      const listBody = listRes.body as { data?: { items?: any[]; total?: number; counters?: Record<string, number>; pageSize?: number } }
      expect(listBody.data?.items?.length).toBe(2)
      expect(listBody.data?.total).toBe(3)
      expect(listBody.data?.pageSize).toBe(2)
      expect(listBody.data?.counters).toMatchObject({ pending: 1, failed: 1, sent: 1 })
      expect(listBody.data?.items?.[0]).toMatchObject({
        orgId,
        channel: 'dingtalk_work_notification',
      })

      const failedRes = await requestJson(
        `${baseUrl}/api/attendance/notification-deliveries?orgId=${encodeURIComponent(orgId)}&status=failed&pageSize=50`,
        { headers: { Authorization: `Bearer ${adminToken}` } },
      )
      expect(failedRes.status).toBe(200)
      const failedBody = failedRes.body as { data?: { items?: any[]; total?: number; counters?: Record<string, number> } }
      expect(failedBody.data?.total).toBe(1)
      expect(failedBody.data?.items).toHaveLength(1)
      expect(failedBody.data?.items?.[0]).toMatchObject({
        status: 'failed',
        recipientRole: 'owner',
        attemptCount: 2,
        lastError: 'recipient_not_bound',
      })
      // Counters remain global for the org, not scoped to the current filter.
      expect(failedBody.data?.counters).toMatchObject({ pending: 1, failed: 1, sent: 1 })

      const invalidRes = await requestJson(
        `${baseUrl}/api/attendance/notification-deliveries?orgId=${encodeURIComponent(orgId)}&status=bogus`,
        { headers: { Authorization: `Bearer ${adminToken}` } },
      )
      expect(invalidRes.status).toBe(400)

      const forbiddenRes = await requestJson(
        `${baseUrl}/api/attendance/notification-deliveries?orgId=${encodeURIComponent(orgId)}`,
        { headers: { Authorization: `Bearer ${readOnlyToken}` } },
      )
      expect(forbiddenRes.status).toBe(403)
    } finally {
      process.env.RBAC_BYPASS = previousRbacBypass
      await pool.query('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[adminId, readOnlyId]]).catch(() => undefined)
      await pool.query(`DELETE FROM attendance_notification_deliveries WHERE org_id = $1`, [orgId]).catch(() => undefined)
      await pool.end()
    }
  })

  // #7 销假 (design-lock #3034) — §5 real-DB matrix: approve → deduct → cancel → reverse, idempotency, §3a expired.
  it('#7 销假 — cancelling an APPROVED comp_time leave reverses the deducted balance; idempotent; expired lot not resurrected', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return
    const runSuffix = Date.now().toString(36)
    const userId = `attendance-l7-${runSuffix}`
    const userExp = `attendance-l7-exp-${runSuffix}`
    const previousRbacBypass = process.env.RBAC_BYPASS
    const pool = new Pool({ connectionString: dbUrl })
    const createdRequestIds: string[] = []
    try {
      process.env.RBAC_BYPASS = 'true'
      const tokenFor = async (uid: string) => {
        const r = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(uid)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`)
        return (r.body as { token?: string } | undefined)?.token
      }
      const token = await tokenFor(userId)
      const tokenExp = await tokenFor(userExp)
      if (!token || !tokenExp) return
      const hdr = (t: string) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' })

      // comp_time leave type (explicit code='comp_time'; idempotent across reruns → 409 then look up)
      const ltRes = await requestJson(`${baseUrl}/api/attendance/leave-types`, { method: 'POST', headers: hdr(token), body: JSON.stringify({ code: 'comp_time', name: `Comp Time L7 ${runSuffix}`, paid: false, requiresApproval: true }) })
      expect([201, 409]).toContain(ltRes.status)
      let leaveTypeId = (ltRes.body as { data?: { id?: string } } | undefined)?.data?.id
      if (!leaveTypeId) {
        const list = await requestJson(`${baseUrl}/api/attendance/leave-types?isActive=true`, { headers: { Authorization: `Bearer ${token}` } })
        const items = (list.body as { data?: { items?: { id?: string; code?: string }[] } } | undefined)?.data?.items ?? []
        leaveTypeId = items.find(i => i.code === 'comp_time')?.id
      }
      expect(leaveTypeId).toBeTruthy()

      const insertLot = async (uid: string, amount: number, tag: string) => (await pool.query(
        `INSERT INTO attendance_leave_balances
           (org_id, user_id, leave_type_code, amount_minutes, remaining_minutes, source_type, source_key, status, granted_at, expires_at)
         VALUES ('default', $1, 'comp_time', $2, $2, 'overtime_conversion', $3, 'active', '2026-01-01', NULL) RETURNING id`,
        [uid, amount, `l7:${runSuffix}:${tag}`],
      )).rows[0].id as string
      const createLeave = async (t: string, uid: string, minutes: number) => {
        const r = await requestJson(`${baseUrl}/api/attendance/requests`, { method: 'POST', headers: hdr(t), body: JSON.stringify({ workDate: '2026-09-20', requestType: 'leave', leaveTypeId, minutes }) })
        expect(r.status).toBe(201)
        const id = (r.body as { data?: { request?: { id?: string } } } | undefined)?.data?.request?.id as string
        createdRequestIds.push(id)
        return id
      }
      const approve = (t: string, id: string) => requestJson(`${baseUrl}/api/attendance/requests/${id}/approve`, { method: 'POST', headers: hdr(t), body: JSON.stringify({ comment: 'ok' }) })
      const cancel = (t: string, id: string) => requestJson(`${baseUrl}/api/attendance/requests/${id}/cancel`, { method: 'POST', headers: hdr(t), body: JSON.stringify({ comment: 'withdraw' }) })
      const lotRow = async (id: string) => (await pool.query('SELECT remaining_minutes, status FROM attendance_leave_balances WHERE id = $1', [id])).rows[0] as { remaining_minutes: number; status: string }
      const events = async (lotId: string, reqId: string) => (await pool.query(
        `SELECT event_type, delta_minutes, source_type FROM attendance_leave_balance_events
           WHERE balance_id = $1 AND source_id = $2 ORDER BY delta_minutes ASC`,
        [lotId, reqId],
      )).rows as { event_type: string; delta_minutes: number; source_type: string }[]

      // (1) approve → deduct
      const lot = await insertLot(userId, 240, 'ok')
      const req = await createLeave(token, userId, 120)
      expect((await approve(token, req)).status).toBe(200)
      expect(await lotRow(lot)).toMatchObject({ remaining_minutes: 120, status: 'active' })
      expect(await events(lot, req)).toEqual([{ event_type: 'deduct', delta_minutes: -120, source_type: 'comp_time_leave' }])

      // (2) cancel the APPROVED leave → reverse (restored; reverse event mirrors comp_time_leave)
      const cancelRes = await cancel(token, req)
      expect(cancelRes.status).toBe(200)
      expect((cancelRes.body as { data?: { reversal?: { reversed?: number } } } | undefined)?.data?.reversal?.reversed).toBe(120)
      expect(await lotRow(lot)).toMatchObject({ remaining_minutes: 240, status: 'active' })
      expect(await events(lot, req)).toEqual([
        { event_type: 'deduct', delta_minutes: -120, source_type: 'comp_time_leave' },
        { event_type: 'reverse', delta_minutes: 120, source_type: 'comp_time_leave' },
      ])

      // (3) §3b idempotency: a 2nd cancel is rejected (already cancelled); balance + events unchanged
      expect((await cancel(token, req)).status).toBe(400)
      expect(await lotRow(lot)).toMatchObject({ remaining_minutes: 240 })
      expect(await events(lot, req)).toHaveLength(2)

      // (4) §3a expired lot: deduct, then expire the lot → cancel does NOT restore it; reverse=0, unrecoverable surfaced
      const lotE = await insertLot(userExp, 120, 'exp')
      const reqE = await createLeave(tokenExp, userExp, 120)
      expect((await approve(tokenExp, reqE)).status).toBe(200)
      expect(await lotRow(lotE)).toMatchObject({ remaining_minutes: 0, status: 'exhausted' })
      await pool.query(`UPDATE attendance_leave_balances SET expires_at = '2000-01-01', status = 'expired' WHERE id = $1`, [lotE])
      const cancelE = await cancel(tokenExp, reqE)
      expect(cancelE.status).toBe(200)
      const reversalE = (cancelE.body as { data?: { reversal?: { reversed?: number; unrecoverableExpired?: number } } } | undefined)?.data?.reversal
      expect(reversalE?.reversed).toBe(0)
      expect(reversalE?.unrecoverableExpired).toBe(120)
      // not resurrected (still expired, remaining 0) + no reverse event written for the expired portion
      expect(await lotRow(lotE)).toMatchObject({ remaining_minutes: 0, status: 'expired' })
      expect((await events(lotE, reqE)).filter(e => e.event_type === 'reverse')).toHaveLength(0)
    } finally {
      for (const uid of [userId, userExp]) {
        await pool.query('DELETE FROM attendance_leave_balance_events WHERE user_id = $1', [uid]).catch(() => undefined)
        await pool.query('DELETE FROM attendance_leave_balances WHERE user_id = $1', [uid]).catch(() => undefined)
      }
      if (createdRequestIds.length > 0) {
        await pool.query('DELETE FROM attendance_requests WHERE id = ANY($1::uuid[])', [createdRequestIds]).catch(() => undefined)
      }
      if (previousRbacBypass === undefined) delete process.env.RBAC_BYPASS
      else process.env.RBAC_BYPASS = previousRbacBypass
      await pool.end().catch(() => undefined)
    }
  })

  // #7 销假 §P2 (owner review of #3044) — the reverse mutation must be org/user-consistent like the read path.
  // The FK only ties balance_id; it does NOT enforce that an event's org/user match the LOT owner. So a
  // corrupt/malicious deduct event (right org+user+source_id, but balance_id pointing at ANOTHER user's lot)
  // must be IGNORED by reverse — else it would restore minutes into a stranger's lot.
  it('#7 销假 §P2 — reverse ignores a same-org/user deduct event whose LOT belongs to another user (no cross-user restore)', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return
    const runSuffix = Date.now().toString(36)
    const userId = `attendance-l7x-${runSuffix}`
    const otherId = `attendance-l7x-other-${runSuffix}`
    const previousRbacBypass = process.env.RBAC_BYPASS
    const pool = new Pool({ connectionString: dbUrl })
    const createdRequestIds: string[] = []
    try {
      process.env.RBAC_BYPASS = 'true'
      const tokenRes = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`)
      const token = (tokenRes.body as { token?: string } | undefined)?.token
      if (!token) return
      const hdr = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

      const ltRes = await requestJson(`${baseUrl}/api/attendance/leave-types`, { method: 'POST', headers: hdr, body: JSON.stringify({ code: 'comp_time', name: `Comp Time L7x ${runSuffix}`, paid: false, requiresApproval: true }) })
      expect([201, 409]).toContain(ltRes.status)
      let leaveTypeId = (ltRes.body as { data?: { id?: string } } | undefined)?.data?.id
      if (!leaveTypeId) {
        const list = await requestJson(`${baseUrl}/api/attendance/leave-types?isActive=true`, { headers: { Authorization: `Bearer ${token}` } })
        const items = (list.body as { data?: { items?: { id?: string; code?: string }[] } } | undefined)?.data?.items ?? []
        leaveTypeId = items.find(i => i.code === 'comp_time')?.id
      }
      expect(leaveTypeId).toBeTruthy()

      const insertLot = async (uid: string, amount: number, remaining: number, tag: string) => (await pool.query(
        `INSERT INTO attendance_leave_balances
           (org_id, user_id, leave_type_code, amount_minutes, remaining_minutes, source_type, source_key, status, granted_at, expires_at)
         VALUES ('default', $1, 'comp_time', $2, $3, 'overtime_conversion', $4, 'active', '2026-01-01', NULL) RETURNING id`,
        [uid, amount, remaining, `l7x:${runSuffix}:${tag}`],
      )).rows[0].id as string
      const lotRow = async (id: string) => (await pool.query('SELECT remaining_minutes, status FROM attendance_leave_balances WHERE id = $1', [id])).rows[0] as { remaining_minutes: number; status: string }

      // userId's legit deduct: grant 240, approve a 120 leave → remaining 120 + a real deduct event (user→own lot).
      const ownLot = await insertLot(userId, 240, 240, 'own')
      const createRes = await requestJson(`${baseUrl}/api/attendance/requests`, { method: 'POST', headers: hdr, body: JSON.stringify({ workDate: '2026-09-20', requestType: 'leave', leaveTypeId, minutes: 120 }) })
      expect(createRes.status).toBe(201)
      const req = (createRes.body as { data?: { request?: { id?: string } } } | undefined)?.data?.request?.id as string
      createdRequestIds.push(req)
      expect((await requestJson(`${baseUrl}/api/attendance/requests/${req}/approve`, { method: 'POST', headers: hdr, body: JSON.stringify({ comment: 'ok' }) })).status).toBe(200)
      expect(await lotRow(ownLot)).toMatchObject({ remaining_minutes: 120 })

      // ANOTHER user's lot with headroom (amount 500, remaining 100 → 400 a buggy restore could fill).
      const otherLot = await insertLot(otherId, 500, 100, 'other')
      // CORRUPT deduct: org+user+source_id all match the reverse query, but balance_id points at otherLot.
      await pool.query(
        `INSERT INTO attendance_leave_balance_events (org_id, user_id, balance_id, event_type, delta_minutes, source_type, source_id)
         VALUES ('default', $1, $2, 'deduct', -200, 'comp_time_leave', $3)`,
        [userId, otherLot, req],
      )

      // cancel → reverse for (default, userId, req): ONLY the legit 120 (own lot) reverses; the corrupt 200 is ignored.
      const cancelRes = await requestJson(`${baseUrl}/api/attendance/requests/${req}/cancel`, { method: 'POST', headers: hdr, body: JSON.stringify({ comment: 'withdraw' }) })
      expect(cancelRes.status, cancelRes.raw).toBe(200)
      expect((cancelRes.body as { data?: { reversal?: { reversed?: number } } } | undefined)?.data?.reversal?.reversed).toBe(120)
      expect(await lotRow(ownLot)).toMatchObject({ remaining_minutes: 240, status: 'active' }) // own lot restored
      expect(await lotRow(otherLot)).toMatchObject({ remaining_minutes: 100, status: 'active' }) // stranger's lot UNTOUCHED
      const otherReverse = (await pool.query(`SELECT 1 FROM attendance_leave_balance_events WHERE balance_id = $1 AND event_type = 'reverse'`, [otherLot])).rows
      expect(otherReverse).toHaveLength(0) // no reverse event written against the other user's lot
    } finally {
      for (const uid of [userId, otherId]) {
        await pool.query('DELETE FROM attendance_leave_balance_events WHERE user_id = $1', [uid]).catch(() => undefined)
        await pool.query('DELETE FROM attendance_leave_balances WHERE user_id = $1', [uid]).catch(() => undefined)
      }
      if (createdRequestIds.length > 0) await pool.query('DELETE FROM attendance_requests WHERE id = ANY($1::uuid[])', [createdRequestIds]).catch(() => undefined)
      if (previousRbacBypass === undefined) delete process.env.RBAC_BYPASS
      else process.env.RBAC_BYPASS = previousRbacBypass
      await pool.end().catch(() => undefined)
    }
  })

  // #7 销假 §5 authority — RBAC ENFORCED (the main flow above runs RBAC_BYPASS=true, which short-circuits
  // canAccessOtherUsers). canAccessOtherUsers = admin OR attendance:approve; a read/write-only user fails it.
  it('#7 销假 §5 authority — a non-admin/non-approver cannot cancel another user\'s leave (403)', async () => {
    if (!baseUrl) return
    const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
    if (!dbUrl) return
    const runSuffix = Date.now().toString(36)
    const adminU = `attendance-l7auth-admin-${runSuffix}`
    const otherU = `attendance-l7auth-other-${runSuffix}`
    const previousRbacBypass = process.env.RBAC_BYPASS
    const pool = new Pool({ connectionString: dbUrl })
    const createdRequestIds: string[] = []
    try {
      process.env.RBAC_BYPASS = 'false'
      await pool.query(
        `INSERT INTO permissions (code, name, description) VALUES
           ('attendance:read','Attendance Read','r'),('attendance:write','Attendance Write','w'),
           ('attendance:approve','Attendance Approve','a'),('attendance:admin','Attendance Admin','adm')
         ON CONFLICT (code) DO NOTHING`,
      )
      // admin = read/write/admin (creates the type + owns a request); other = read/write only
      // (passes withPermission('attendance:write') but fails canAccessOtherUsers → 403 on someone else's request)
      await pool.query(
        `INSERT INTO user_permissions (user_id, permission_code) VALUES
           ($1,'attendance:read'),($1,'attendance:write'),($1,'attendance:admin'),
           ($2,'attendance:read'),($2,'attendance:write')
         ON CONFLICT DO NOTHING`,
        [adminU, otherU],
      )
      const tokenFor = async (uid: string, perms: string) =>
        ((await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(uid)}&roles=user&perms=${perms}`)).body as { token?: string } | undefined)?.token
      const adminToken = await tokenFor(adminU, 'attendance:read,attendance:write,attendance:admin')
      const otherToken = await tokenFor(otherU, 'attendance:read,attendance:write')
      if (!adminToken || !otherToken) return
      const hdr = (t: string) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' })

      const ltRes = await requestJson(`${baseUrl}/api/attendance/leave-types`, { method: 'POST', headers: hdr(adminToken), body: JSON.stringify({ code: 'comp_time', name: `Comp Time Auth ${runSuffix}`, paid: false, requiresApproval: true }) })
      expect([201, 409]).toContain(ltRes.status)
      let leaveTypeId = (ltRes.body as { data?: { id?: string } } | undefined)?.data?.id
      if (!leaveTypeId) {
        const list = await requestJson(`${baseUrl}/api/attendance/leave-types?isActive=true`, { headers: { Authorization: `Bearer ${adminToken}` } })
        leaveTypeId = ((list.body as { data?: { items?: { id?: string; code?: string }[] } } | undefined)?.data?.items ?? []).find(i => i.code === 'comp_time')?.id
      }
      expect(leaveTypeId).toBeTruthy()

      // admin owns a leave request (pending is enough — the authority gate fires before any reverse)
      const reqRes = await requestJson(`${baseUrl}/api/attendance/requests`, { method: 'POST', headers: hdr(adminToken), body: JSON.stringify({ workDate: '2026-09-25', requestType: 'leave', leaveTypeId, minutes: 60 }) })
      expect(reqRes.status).toBe(201)
      const reqId = (reqRes.body as { data?: { request?: { id?: string } } } | undefined)?.data?.request?.id as string
      createdRequestIds.push(reqId)

      // other (read/write, NOT admin/approve) cancels admin's request → 403, request untouched
      const forbidden = await requestJson(`${baseUrl}/api/attendance/requests/${reqId}/cancel`, { method: 'POST', headers: hdr(otherToken), body: JSON.stringify({ comment: 'not mine' }) })
      expect(forbidden.status).toBe(403)
      const row = (await pool.query('SELECT status FROM attendance_requests WHERE id = $1', [reqId])).rows[0] as { status: string } | undefined
      expect(row?.status).toBe('pending')
    } finally {
      await pool.query('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[adminU, otherU]]).catch(() => undefined)
      if (createdRequestIds.length > 0) {
        await pool.query('DELETE FROM attendance_requests WHERE id = ANY($1::uuid[])', [createdRequestIds]).catch(() => undefined)
      }
      if (previousRbacBypass === undefined) delete process.env.RBAC_BYPASS
      else process.env.RBAC_BYPASS = previousRbacBypass
      await pool.end().catch(() => undefined)
    }
  })

})
