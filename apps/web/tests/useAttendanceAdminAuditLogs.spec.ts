import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import {
  type AttendanceAdminAuditLogItem,
  useAttendanceAdminAuditLogs,
} from '../src/views/attendance/useAttendanceAdminAuditLogs'

const tr = (en: string, _zh: string) => en

function createLogItem(overrides: Partial<AttendanceAdminAuditLogItem> = {}): AttendanceAdminAuditLogItem {
  return {
    id: 'log-1',
    actor_id: 'actor-1',
    actor_type: 'user',
    action: 'attendance.punch',
    resource_type: 'record',
    resource_id: 'record-1',
    request_id: 'req-1',
    ip: '127.0.0.1',
    user_agent: 'vitest',
    route: '/api/attendance',
    status_code: 200,
    latency_ms: 10,
    occurred_at: '2026-03-12T00:00:00.000Z',
    meta: {},
    ...overrides,
  }
}

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response
}

describe('useAttendanceAdminAuditLogs', () => {
  it('appends trimmed filters and normalized date ranges', () => {
    const audit = useAttendanceAdminAuditLogs({ tr })
    audit.auditLogQuery.value = ' search '
    audit.auditLogActionPrefix.value = ' punch'
    audit.auditLogStatusClass.value = 'error'
    audit.auditLogErrorCode.value = 'E123'
    audit.auditLogFrom.value = '2026-03-11T00:00:00Z'
    audit.auditLogTo.value = '2026-03-12T00:00:00Z'

    const params = new URLSearchParams()
    audit.appendAuditLogFilters(params)

    expect(params.get('q')).toBe('search')
    expect(params.get('actionPrefix')).toBe('punch')
    expect(params.get('statusClass')).toBe('error')
    expect(params.get('errorCode')).toBe('E123')
    expect(params.get('from')).toBe('2026-03-11T00:00:00.000Z')
    expect(params.get('to')).toBe('2026-03-12T00:00:00.000Z')
  })

  it('toggles audit log meta expansion', () => {
    const audit = useAttendanceAdminAuditLogs({ tr })
    const item = createLogItem({ id: 'item-a' })

    audit.toggleAuditLogMeta(item)
    expect(audit.auditLogSelectedId.value).toBe('item-a')

    audit.toggleAuditLogMeta(item)
    expect(audit.auditLogSelectedId.value).toBe('')
  })

  it('loads audit logs and updates pagination state', async () => {
    const apiFetch = vi.fn(async () => jsonResponse(200, {
      ok: true,
      data: {
        items: [createLogItem({ id: 'log-a' })],
        total: 3,
        page: 2,
      },
    }))
    const audit = useAttendanceAdminAuditLogs({ apiFetch, tr })

    await audit.loadAuditLogs(2)

    expect(audit.auditLogs.value).toHaveLength(1)
    expect(audit.auditLogPage.value).toBe(2)
    expect(audit.auditLogTotal.value).toBe(3)
    expect(audit.auditLogTotalPages.value).toBe(1)
    expect(audit.auditLogStatusMessage.value).toBe('Loaded 1 log(s).')
  })

  it('marks admin forbidden on 403 responses', async () => {
    const adminForbidden = ref(false)
    const apiFetch = vi.fn(async () => jsonResponse(403, {
      ok: false,
      error: { message: 'denied' },
    }))
    const audit = useAttendanceAdminAuditLogs({ adminForbidden, apiFetch, tr })

    await audit.loadAuditLogs(1)

    expect(adminForbidden.value).toBe(true)
    expect(audit.auditLogStatusMessage.value).toBe('Admin permissions required')
  })

  it('loads summary buckets', async () => {
    const apiFetch = vi.fn(async () => jsonResponse(200, {
      ok: true,
      data: {
        actions: [{ action: 'create', total: 2 }],
        errors: [{ error_code: 'E1', total: 1 }],
      },
    }))
    const audit = useAttendanceAdminAuditLogs({ apiFetch, tr })

    await audit.loadAuditSummary()

    expect(audit.auditSummaryActions.value).toEqual([{ key: 'create', total: 2 }])
    expect(audit.auditSummaryErrors.value).toEqual([{ key: 'E1', total: 1 }])
    expect(audit.auditSummaryRowCount.value).toBe(1)
  })

  it('exports CSV with injected downloader and clock', async () => {
    const downloadCsv = vi.fn()
    const apiFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => 'a,b\n1,2',
    }))
    const audit = useAttendanceAdminAuditLogs({
      apiFetch,
      clock: () => new Date('2025-01-01T00:00:00Z'),
      downloadCsv,
      tr,
    })

    await audit.exportAuditLogsCsv()

    expect(downloadCsv).toHaveBeenCalledWith('attendance-audit-logs-2025-01-01T00-00-00-000Z.csv', 'a,b\n1,2')
    expect(audit.auditLogStatusMessage.value).toBe('Audit logs exported.')
  })

  it('reloads logs and summary together', async () => {
    const apiFetch = vi.fn(async (input: string) => {
      if (input.includes('/summary')) {
        return jsonResponse(200, {
          ok: true,
          data: { actions: [], errors: [] },
        })
      }
      return jsonResponse(200, {
        ok: true,
        data: { items: [], total: 0, page: 1 },
      })
    })
    const audit = useAttendanceAdminAuditLogs({ apiFetch, tr })

    await audit.reloadAuditLogs()

    expect(apiFetch).toHaveBeenCalledTimes(2)
    expect(apiFetch.mock.calls.some((call) => String(call[0]).includes('/summary'))).toBe(true)
    expect(apiFetch.mock.calls.some((call) => String(call[0]).includes('/audit-logs?'))).toBe(true)
  })
})
