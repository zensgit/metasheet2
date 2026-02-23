import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { MetaSheetServer } from '../../src/index'
import * as path from 'path'
import net from 'net'
import fs from 'fs/promises'
import { Pool } from 'pg'
import http from 'http'

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
    process.env.ATTENDANCE_IMPORT_CSV_MAX_ROWS = '1000'
    // Isolate import upload channel state (csvFileId) under a temp directory for integration tests.
    const repoRoot = path.join(__dirname, '../../../../')
    importUploadDir = path.join(repoRoot, 'tmp', `attendance-import-upload-${Date.now().toString(36)}`)
    process.env.ATTENDANCE_IMPORT_UPLOAD_DIR = importUploadDir
    process.env.ATTENDANCE_IMPORT_UPLOAD_CLEANUP = 'false'

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
    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=attendance-test&roles=admin&perms=attendance:read,attendance:write,attendance:admin,attendance:approve`
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

    const leaveTypeRes = await requestJson(`${baseUrl}/api/attendance/leave-types`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        code: 'annual',
        name: 'Annual Leave',
        requiresApproval: true,
      }),
    })

    expect([201, 409]).toContain(leaveTypeRes.status)
    let leaveTypeId = (leaveTypeRes.body as { data?: { id?: string } } | undefined)?.data?.id
    if (!leaveTypeId) {
      const leaveListRes = await requestJson(`${baseUrl}/api/attendance/leave-types`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })
      const items = (leaveListRes.body as { data?: { items?: { id?: string; code?: string }[] } } | undefined)?.data?.items ?? []
      leaveTypeId = items.find(item => item.code === 'annual')?.id
    }

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
        userId: 'attendance-test',
        shiftId,
        startDate: workDate,
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

    const rotationAssignmentRes = await requestJson(`${baseUrl}/api/attendance/rotation-assignments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: 'attendance-test',
        rotationRuleId,
        startDate: workDate,
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
      userId: 'attendance-test',
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

    const importRes = await requestJson(`${baseUrl}/api/attendance/import`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(importPayload),
    })
    expect(importRes.status).toBe(200)

    const anomalyDate = (() => {
      const dt = new Date()
      // Ensure we don't override the "normal" record we just imported for `workDate`.
      dt.setUTCDate(dt.getUTCDate() + 1)
      // Pick a weekday so `is_workday` stays true and the anomalies endpoint can surface the record.
      while (dt.getUTCDay() === 0 || dt.getUTCDay() === 6) {
        dt.setUTCDate(dt.getUTCDate() + 1)
      }
      return dt.toISOString().slice(0, 10)
    })()

    const anomalyPayload = {
      userId: 'attendance-test',
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

    if (groupId) {
      const addGroupMemberRes = await requestJson(`${baseUrl}/api/attendance/groups/${groupId}/members`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userIds: ['attendance-test'],
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
      expect(groupMemberItems.some(item => item.userId === 'attendance-test')).toBe(true)
    }

    const csvGroupName = `CSV Group ${runSuffix}`
    const csvImportPayload = {
      userId: 'attendance-test',
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
        A001: 'attendance-test',
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
      expect(csvGroupMembers.some(item => item.userId === 'attendance-test')).toBe(true)
    }

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

    const commitAData = (commitARes.body as { data?: { batchId?: string; idempotent?: boolean } } | undefined)?.data
    const commitBData = (commitBRes.body as { data?: { batchId?: string; idempotent?: boolean } } | undefined)?.data
    expect(commitAData?.batchId).toBeTruthy()
    expect(commitBData?.batchId).toBeTruthy()
    expect(commitAData?.batchId).toBe(commitBData?.batchId)
    expect([commitAData?.idempotent, commitBData?.idempotent].some(Boolean)).toBe(true)

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
    const retryData = (retryRes.body as { data?: { batchId?: string; idempotent?: boolean } } | undefined)?.data
    expect(retryData?.batchId).toBe(commitAData?.batchId)
    expect(retryData?.idempotent).toBe(true)
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
    expect(typeof job?.progressPercent).toBe('number')
    expect(typeof job?.throughputRowsPerSec).toBe('number')

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
    expect(typeof chunkConfig?.itemsChunkSize).toBe('number')
    expect(typeof chunkConfig?.recordsChunkSize).toBe('number')
    if (commitData?.engine === 'bulk') {
      expect(chunkConfig?.itemsChunkSize).toBe(expectedBulkItemsChunkSize)
      expect(chunkConfig?.recordsChunkSize).toBe(expectedBulkRecordsChunkSize)
    } else {
      expect(chunkConfig?.itemsChunkSize).toBe(expectedStandardItemsChunkSize)
      expect(chunkConfig?.recordsChunkSize).toBe(expectedStandardRecordsChunkSize)
    }
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

  it('supports CSV upload channel (csvFileId) and cleans up after sync commit', async () => {
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
    const batchId = (commitRes.body as { data?: { batchId?: string } } | undefined)?.data?.batchId
    expect(typeof batchId).toBe('string')

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
    const batchId = (commitRes.body as { data?: { batchId?: string } } | undefined)?.data?.batchId
    expect(typeof batchId).toBe('string')

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
    const retryBody = retryRes.body as { data?: { batchId?: string; idempotent?: boolean } } | undefined
    expect(retryBody?.data?.batchId).toBe(batchId)
    expect(retryBody?.data?.idempotent).toBe(true)

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
})
