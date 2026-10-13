import { createRequire } from 'node:module'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Slice 1: default rule, overtime rules, approval flows, and scheduler scopes
 * write only the authenticated org. A body/query/x-org-id value is a consistency
 * assertion. Blank selectors are ignored. Record-operation edits stay multi-org
 * and still require active membership.
 */
const require = createRequire(import.meta.url)
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs') as {
  activate: (context: unknown) => Promise<void>
  deactivate: () => Promise<void>
  resetAttendanceSettingsCacheForTests: () => void
}

const TOKEN = 'org-a'
const OTHER = 'org-b'
const ACTOR = 'user-a'
const RESOURCE_ID = '11111111-1111-4111-8111-111111111111'

type QueryCall = { sql: string; params: unknown[] }
type RouteHandler = (req: unknown, res: unknown, next?: unknown) => Promise<void>

const queries: QueryCall[] = []
const memberOrgs = new Set<string>()
const routes = new Map<string, RouteHandler>()

function isWrite(sql: string): boolean {
  return /^\s*(insert|update|delete)\b/i.test(sql)
}

function rowFor(sql: string, params: unknown[]) {
  const org = params.find(value => value === TOKEN || value === OTHER) ?? TOKEN
  if (/attendance_overtime_rules/i.test(sql)) {
    return {
      id: typeof params[0] === 'string' ? params[0] : 'ot-1',
      org_id: org,
      name: 'Weekday OT',
      min_minutes: 0,
      rounding_minutes: 15,
      max_minutes_per_day: 600,
      requires_approval: true,
      is_active: true,
    }
  }
  if (/attendance_approval_flows/i.test(sql)) {
    return {
      id: typeof params[0] === 'string' ? params[0] : 'flow-1',
      org_id: org,
      name: 'Leave flow',
      request_type: 'leave',
      steps: [],
      is_active: true,
    }
  }
  if (/attendance_scheduler_scopes/i.test(sql)) {
    return {
      id: typeof params[0] === 'string' ? params[0] : 'scope-1',
      org_id: org,
      subject_type: 'user',
      subject_ref: 'scheduler-user',
      actions: ['view'],
      scope: { userIds: ['user-1'] },
      is_active: true,
      created_by: ACTOR,
      updated_by: ACTOR,
    }
  }
  return {
    id: 'rule-1',
    org_id: org,
    name: 'Default',
    timezone: 'UTC',
    work_start_time: '09:00',
    work_end_time: '18:00',
    late_grace_minutes: 10,
    early_grace_minutes: 10,
    severe_late_threshold_minutes: 30,
    absence_late_threshold_minutes: 60,
    rounding_minutes: 5,
    working_days: '[1,2,3,4,5]',
    is_default: true,
  }
}

async function query(sql: string, params: unknown[] = []) {
  const text = String(sql)
  queries.push({ sql: text, params: [...params] })
  if (/platform_admin/i.test(text)) return [{ platform_admin: false }]
  if (/select 1 from user_roles where user_id = \$1 and role_id = \$2/i.test(text)) return []
  if (/from user_orgs/i.test(text)) {
    if (/org_id = \$2/i.test(text)) {
      const org = String(params[1] ?? '')
      return memberOrgs.has(org) ? [{ org_id: org }] : []
    }
    return [...memberOrgs].map(orgId => ({ org_id: orgId }))
  }
  if (/user_permissions/i.test(text) || /role_permissions/i.test(text) || /permission_code = ANY/i.test(text)) {
    return [{ ok: 1 }]
  }
  if (/attendance_records/i.test(text)) return []
  if (isWrite(text)) {
    return /returning/i.test(text) ? [rowFor(text, params)] : []
  }
  if (/^\s*select/i.test(text) && /attendance_(overtime_rules|approval_flows|scheduler_scopes)\b/i.test(text)) {
    return params.includes(TOKEN) ? [rowFor(text, params)] : []
  }
  return []
}

const db = {
  query,
  transaction: async (callback: (client: typeof db) => unknown) => callback(db),
}

function createRes() {
  const res = {
    statusCode: 200,
    body: undefined as { ok?: boolean; data?: { orgId?: string }; error?: { code?: string; message?: string } } | undefined,
    headersSent: false,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: typeof res.body) {
      this.body = payload
      this.headersSent = true
      return this
    },
  }
  return res
}

function attendanceSql() {
  return queries.filter(call => /attendance_/i.test(call.sql))
}

function attendanceWrites() {
  return attendanceSql().filter(call => isWrite(call.sql))
}

type SelectorCase = {
  label: string
  outcome: 'reject' | 'write' | 'forbidden'
  query?: Record<string, string>
  header?: string
  bodyOrg?: string
  userOrg?: string
  tenant?: string | null
}

const selectorCases: SelectorCase[] = [
  { label: 'query selector', outcome: 'reject', query: { orgId: OTHER } },
  { label: 'body selector', outcome: 'reject', bodyOrg: OTHER },
  { label: 'header selector', outcome: 'reject', header: OTHER },
  { label: 'no selector', outcome: 'write' },
  { label: 'empty body selector', outcome: 'write', bodyOrg: '' },
  { label: 'empty query selector', outcome: 'write', query: { orgId: '' } },
  { label: 'empty header selector', outcome: 'write', header: '' },
  { label: 'whitespace selector', outcome: 'write', bodyOrg: '   ' },
  { label: 'matching body selector', outcome: 'write', bodyOrg: TOKEN },
  { label: 'blank user.orgId uses token tenant', outcome: 'write', userOrg: '' },
  { label: 'missing authenticated org', outcome: 'forbidden', tenant: null },
]

const sliceRoutes: Array<{
  name: string
  method: string
  path: string
  body: Record<string, unknown>
  successStatus: number
  params?: Record<string, string>
}> = [
  {
    name: 'PUT /api/attendance/rules/default',
    method: 'PUT',
    path: '/api/attendance/rules/default',
    body: {},
    successStatus: 200,
  },
  {
    name: 'POST /api/attendance/overtime-rules',
    method: 'POST',
    path: '/api/attendance/overtime-rules',
    body: { name: 'Weekday OT' },
    successStatus: 201,
  },
  {
    name: 'PUT /api/attendance/overtime-rules/:id',
    method: 'PUT',
    path: '/api/attendance/overtime-rules/:id',
    body: { name: 'Weekday OT' },
    successStatus: 200,
    params: { id: RESOURCE_ID },
  },
  {
    name: 'DELETE /api/attendance/overtime-rules/:id',
    method: 'DELETE',
    path: '/api/attendance/overtime-rules/:id',
    body: {},
    successStatus: 200,
    params: { id: RESOURCE_ID },
  },
  {
    name: 'POST /api/attendance/approval-flows',
    method: 'POST',
    path: '/api/attendance/approval-flows',
    body: { name: 'Leave flow', requestType: 'leave', steps: [{ approverUserIds: [ACTOR] }] },
    successStatus: 201,
  },
  {
    name: 'PUT /api/attendance/approval-flows/:id',
    method: 'PUT',
    path: '/api/attendance/approval-flows/:id',
    body: { name: 'Leave flow', requestType: 'leave', steps: [{ approverUserIds: [ACTOR] }] },
    successStatus: 200,
    params: { id: RESOURCE_ID },
  },
  {
    name: 'DELETE /api/attendance/approval-flows/:id',
    method: 'DELETE',
    path: '/api/attendance/approval-flows/:id',
    body: {},
    successStatus: 200,
    params: { id: RESOURCE_ID },
  },
  {
    name: 'POST /api/attendance/scheduler-scopes',
    method: 'POST',
    path: '/api/attendance/scheduler-scopes',
    body: {
      subjectType: 'user',
      subjectRef: 'scheduler-user',
      actions: ['view'],
      scope: { userIds: ['user-1'] },
    },
    successStatus: 200,
  },
  {
    name: 'PUT /api/attendance/scheduler-scopes/:id',
    method: 'PUT',
    path: '/api/attendance/scheduler-scopes/:id',
    body: {
      subjectType: 'user',
      subjectRef: 'scheduler-user',
      actions: ['view'],
      scope: { userIds: ['user-1'] },
    },
    successStatus: 200,
    params: { id: RESOURCE_ID },
  },
  {
    name: 'DELETE /api/attendance/scheduler-scopes/:id',
    method: 'DELETE',
    path: '/api/attendance/scheduler-scopes/:id',
    body: {},
    successStatus: 200,
    params: { id: RESOURCE_ID },
  },
]

async function invoke(method: string, path: string, selector: SelectorCase, baseBody: Record<string, unknown>, params?: Record<string, string>) {
  const handler = routes.get(`${method} ${path}`)
  expect(handler, `${method} ${path}`).toBeTypeOf('function')
  const body = { ...baseBody }
  if (selector.bodyOrg !== undefined) body.orgId = selector.bodyOrg
  const tenant = selector.tenant === undefined ? TOKEN : selector.tenant
  const req = {
    user: {
      id: ACTOR,
      sub: ACTOR,
      ...(selector.userOrg !== undefined ? { orgId: selector.userOrg } : {}),
    },
    authenticatedTenantId: tenant === null ? undefined : tenant,
    body,
    query: selector.query ?? {},
    params: params ?? {},
    headers: selector.header !== undefined ? { 'x-org-id': selector.header } : {},
  }
  const res = createRes()
  await handler!(req, res)
  return res
}

describe('attendance calculation and authorization config writes pin the authenticated org', () => {
  beforeAll(async () => {
    delete process.env.RBAC_BYPASS
    routes.clear()
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    await attendancePlugin.activate({
      api: {
        database: db,
        events: { emit: vi.fn() },
        http: {
          addRoute: (method: string, path: string, handler: RouteHandler) => {
            routes.set(`${method} ${path}`, handler)
          },
        },
        multitable: {
          provisioning: {
            ensureObject: vi.fn(async () => ({ baseId: 'base-1', sheet: { id: 'sheet-1' }, fields: [] })),
            ensureView: vi.fn(async () => ({ id: 'view-1' })),
            resolveFieldIds: vi.fn(async () => ({})),
            getFieldId: vi.fn(() => 'field-1'),
          },
          records: {
            queryRecords: vi.fn(async () => []),
            createRecord: vi.fn(async () => ({ id: 'rec-1' })),
          },
        },
      },
      services: {
        attendanceW4SegmentCalculation: {
          createRecordOperationBoundary: ({ adapters }: { adapters: { manual_edit: { prepare: (trx: unknown, routeInput: unknown) => Promise<unknown> } } }) => ({
            execute: async (input: { kind: string; routeInput: unknown }) => {
              await adapters.manual_edit.prepare({ query }, input.routeInput)
              return { response: { ok: true, data: { passed: true } } }
            },
          }),
        },
      },
      logger,
    })
  })

  afterAll(async () => {
    await attendancePlugin.deactivate()
  })

  beforeEach(() => {
    queries.length = 0
    memberOrgs.clear()
    attendancePlugin.resetAttendanceSettingsCacheForTests()
  })

  describe.each(sliceRoutes)('$name', (route) => {
    it.each(selectorCases)('$label', async (selector) => {
      const res = await invoke(route.method, route.path, selector, route.body, route.params)
      const writes = attendanceWrites()
      if (selector.outcome === 'reject') {
        expect(res.statusCode).toBe(404)
        expect(res.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'Organization not found' } })
        expect(attendanceSql()).toEqual([])
        expect(writes).toEqual([])
        return
      }
      if (selector.outcome === 'forbidden') {
        expect(res.statusCode).toBe(403)
        expect(res.body).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Authenticated organization not found' } })
        expect(attendanceSql()).toEqual([])
        expect(writes).toEqual([])
        return
      }
      expect(res.statusCode).toBe(route.successStatus)
      expect(res.body?.ok).toBe(true)
      if (res.body?.data && 'orgId' in res.body.data) {
        expect(res.body.data.orgId).toBe(TOKEN)
      }
      expect(writes.length).toBeGreaterThan(0)
      for (const call of writes) {
        expect(call.params).toContain(TOKEN)
        expect(call.params).not.toContain(OTHER)
      }
      for (const call of attendanceSql()) {
        expect(call.params).not.toContain(OTHER)
      }
    })
  })

  it('GET /api/attendance/rules/default still rejects a foreign selector and reads the token org when user.orgId is blank', async () => {
    const foreign = await invoke(
      'GET',
      '/api/attendance/rules/default',
      { label: 'foreign', outcome: 'reject', query: { orgId: OTHER } },
      {},
    )
    expect(foreign.statusCode).toBe(404)
    expect(foreign.body?.error?.message).toBe('Group not found')
    expect(attendanceSql()).toEqual([])

    queries.length = 0
    const blankClaim = await invoke(
      'GET',
      '/api/attendance/rules/default',
      { label: 'blank claim', outcome: 'write', userOrg: '' },
      {},
    )
    expect(blankClaim.statusCode).toBe(200)
    expect(blankClaim.body?.data?.orgId).toBe(TOKEN)
    expect(attendanceWrites()).toEqual([])
    expect(attendanceSql().some(call => call.params.includes(TOKEN))).toBe(true)
  })

  it('record-operation edit still accepts a foreign org for an active member and refuses a non-member', async () => {
    const editBody = {
      recordId: RESOURCE_ID,
      targetStatus: 'normal',
      reason: 'correction',
      idempotencyKey: 'idem-1',
    }
    memberOrgs.add(OTHER)
    const member = await invoke(
      'POST',
      '/api/attendance/anomaly-result-edits',
      { label: 'member', outcome: 'write', bodyOrg: OTHER },
      editBody,
    )
    expect(member.body?.error?.message).not.toBe('Organization not found')
    expect(member.statusCode).toBe(404)
    expect(member.body?.error?.code).toBe('ATTENDANCE_RECORD_NOT_FOUND')
    expect(attendanceSql().some(call => /attendance_records/i.test(call.sql) && call.params.includes(OTHER))).toBe(true)
    expect(attendanceWrites()).toEqual([])

    queries.length = 0
    memberOrgs.clear()
    const outsider = await invoke(
      'POST',
      '/api/attendance/anomaly-result-edits',
      { label: 'outsider', outcome: 'reject', bodyOrg: OTHER },
      editBody,
    )
    expect(outsider.statusCode).toBe(403)
    expect(outsider.body?.error?.code).toBe('FORBIDDEN')
    expect(outsider.body?.error?.message).toBe('Record operation requires active org membership')
    expect(attendanceSql().some(call => /attendance_records/i.test(call.sql))).toBe(false)
    expect(attendanceWrites()).toEqual([])
  })

  it('punch still requires active membership for a named org and does not use the config-write pin', async () => {
    const outsider = await invoke(
      'POST',
      '/api/attendance/punch',
      { label: 'outsider', outcome: 'reject', bodyOrg: OTHER },
      { eventType: 'check_in' },
    )
    expect(outsider.statusCode).toBe(403)
    expect(outsider.body?.error?.code).toBe('ATTENDANCE_PUNCH_ORG_NOT_PERMITTED')
    expect(attendanceWrites()).toEqual([])

    queries.length = 0
    memberOrgs.add(OTHER)
    const member = await invoke(
      'POST',
      '/api/attendance/punch',
      { label: 'member', outcome: 'write', bodyOrg: OTHER },
      { eventType: 'check_in' },
    )
    expect(member.body?.error?.message).not.toBe('Organization not found')
    expect(member.body?.error?.code).not.toBe('ATTENDANCE_PUNCH_ORG_NOT_PERMITTED')
    expect(queries.some(call => /from user_orgs/i.test(call.sql))).toBe(true)
  })
})
