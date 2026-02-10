import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { MetaSheetServer } from '../../src/index'
import * as path from 'path'
import net from 'net'
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

describe('Attendance Plugin Integration', () => {
  let server: MetaSheetServer | undefined
  let baseUrl: string | undefined

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

    const repoRoot = path.join(__dirname, '../../../../')
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
    const anomalyItems = (anomaliesRes.body as { data?: { items?: { workDate?: string; status?: string }[] } } | undefined)?.data?.items ?? []
    expect(anomalyItems.some(item => item.workDate === anomalyDate && item.status === 'partial')).toBe(true)

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
    const batchId = (commitRes.body as { data?: { batchId?: string } } | undefined)?.data?.batchId
    expect(batchId).toBeTruthy()

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
    const retryData = (retryRes.body as { data?: { batchId?: string; idempotent?: boolean } } | undefined)?.data
    expect(retryData?.batchId).toBe(batchId)
    expect(retryData?.idempotent).toBe(true)
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
})
