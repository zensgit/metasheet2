import { computed, ref, type Ref } from 'vue'
import { apiFetch as baseApiFetch } from '../../utils/api'

type ApiFetchFn = typeof baseApiFetch
type AuditStatusKind = 'info' | 'error'
type DownloadCsvFn = (filename: string, csvText: string) => void
type Translate = (en: string, zh: string) => string

export interface AttendanceAdminAuditLogItem {
  id: string
  actor_id: string | null
  actor_type: string | null
  action: string
  resource_type: string | null
  resource_id: string | null
  request_id: string | null
  ip: string | null
  user_agent: string | null
  route: string | null
  status_code: number | null
  latency_ms: number | null
  occurred_at: string
  meta: Record<string, any>
}

export interface AttendanceAdminAuditSummaryRow {
  key: string
  total: number
}

interface AttendanceAdminAuditLogsPayload {
  items?: unknown
  total?: unknown
  page?: unknown
}

interface AttendanceAdminAuditSummaryPayload {
  actions?: unknown
  errors?: unknown
}

export interface UseAttendanceAdminAuditLogsOptions {
  tr: Translate
  adminForbidden?: Ref<boolean>
  apiFetch?: ApiFetchFn
  downloadCsv?: DownloadCsvFn
  summaryWindowMinutes?: number
  summaryLimit?: number
  exportLimit?: number
  pageSize?: number
  clock?: () => Date
}

const AUDIT_STATUS_TIMEOUT_MS = 6000

function defaultDownloadCsv(filename: string, csvText: string) {
  if (typeof document === 'undefined') return
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function toAuditSummaryRows(rows: unknown, keyField: 'action' | 'error_code'): AttendanceAdminAuditSummaryRow[] {
  if (!Array.isArray(rows)) return []
  return rows
    .map((entry) => asObject(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => ({
      key: String(entry[keyField] || '--'),
      total: Number(entry.total ?? 0) || 0,
    }))
}

export function useAttendanceAdminAuditLogs(options: UseAttendanceAdminAuditLogsOptions) {
  const {
    tr,
    adminForbidden,
    apiFetch = baseApiFetch,
    downloadCsv = defaultDownloadCsv,
    summaryWindowMinutes = 60,
    summaryLimit = 8,
    exportLimit = 5000,
    pageSize = 50,
    clock = () => new Date(),
  } = options

  const adminForbiddenRef = adminForbidden ?? ref(false)
  const auditLogLoading = ref(false)
  const auditLogExporting = ref(false)
  const auditLogs = ref<AttendanceAdminAuditLogItem[]>([])
  const auditLogQuery = ref('')
  const auditLogActionPrefix = ref('')
  const auditLogStatusClass = ref('')
  const auditLogErrorCode = ref('')
  const auditLogFrom = ref('')
  const auditLogTo = ref('')
  const auditLogStatusMessage = ref('')
  const auditLogStatusKind = ref<AuditStatusKind>('info')
  const auditLogPage = ref(1)
  const auditLogTotal = ref(0)
  const auditLogTotalPages = computed(() => Math.max(1, Math.ceil(auditLogTotal.value / pageSize)))
  const auditLogSelectedId = ref('')
  const auditSummaryLoading = ref(false)
  const auditSummaryActions = ref<AttendanceAdminAuditSummaryRow[]>([])
  const auditSummaryErrors = ref<AttendanceAdminAuditSummaryRow[]>([])
  const auditSummaryRowCount = computed(() => Math.max(auditSummaryActions.value.length, auditSummaryErrors.value.length))

  function setAuditLogStatus(message: string, kind: AuditStatusKind = 'info') {
    auditLogStatusKind.value = kind
    auditLogStatusMessage.value = message
    if (!message) return
    globalThis.setTimeout(() => {
      if (auditLogStatusMessage.value === message) {
        auditLogStatusMessage.value = ''
      }
    }, AUDIT_STATUS_TIMEOUT_MS)
  }

  function toggleAuditLogMeta(item: AttendanceAdminAuditLogItem) {
    auditLogSelectedId.value = auditLogSelectedId.value === item.id ? '' : item.id
  }

  function appendAuditLogFilters(params: URLSearchParams) {
    const query = auditLogQuery.value.trim()
    if (query) params.set('q', query)

    const actionPrefix = auditLogActionPrefix.value.trim()
    if (actionPrefix) params.set('actionPrefix', actionPrefix)

    const statusClass = auditLogStatusClass.value.trim()
    if (statusClass) params.set('statusClass', statusClass)

    const errorCode = auditLogErrorCode.value.trim()
    if (errorCode) params.set('errorCode', errorCode)

    const from = auditLogFrom.value.trim()
    if (from) {
      const fromDate = new Date(from)
      if (!Number.isNaN(fromDate.getTime())) {
        params.set('from', fromDate.toISOString())
      }
    }

    const to = auditLogTo.value.trim()
    if (to) {
      const toDate = new Date(to)
      if (!Number.isNaN(toDate.getTime())) {
        params.set('to', toDate.toISOString())
      }
    }
  }

  async function loadAuditSummary() {
    auditSummaryLoading.value = true
    try {
      const params = new URLSearchParams({
        windowMinutes: String(summaryWindowMinutes),
        limit: String(summaryLimit),
      })
      const response = await apiFetch(`/api/attendance-admin/audit-logs/summary?${params.toString()}`)
      if (response.status === 404) {
        auditSummaryActions.value = []
        auditSummaryErrors.value = []
        return
      }
      if (response.status === 403) {
        adminForbiddenRef.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }

      const data = asObject(await response.json().catch(() => null))
      if (!response.ok || !data?.ok) {
        const error = asObject(data?.error)
        throw new Error(String(error?.message || tr('Failed to load audit summary', '加载审计汇总失败')))
      }

      const payload = asObject(data.data) as AttendanceAdminAuditSummaryPayload | null
      auditSummaryActions.value = toAuditSummaryRows(payload?.actions, 'action')
      auditSummaryErrors.value = toAuditSummaryRows(payload?.errors, 'error_code')
    } catch (error: unknown) {
      setAuditLogStatus((error as Error)?.message || tr('Failed to load audit summary', '加载审计汇总失败'), 'error')
    } finally {
      auditSummaryLoading.value = false
    }
  }

  async function loadAuditLogs(page: number) {
    auditLogSelectedId.value = ''
    auditLogLoading.value = true
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      })
      appendAuditLogFilters(params)

      const response = await apiFetch(`/api/attendance-admin/audit-logs?${params.toString()}`)
      if (response.status === 404) {
        auditLogs.value = []
        auditLogTotal.value = 0
        auditLogPage.value = 1
        setAuditLogStatus(tr('Audit log API not available on this deployment.', '当前部署不支持审计日志 API。'), 'error')
        return
      }
      if (response.status === 403) {
        adminForbiddenRef.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }

      const data = asObject(await response.json().catch(() => null))
      if (!response.ok || !data?.ok) {
        const error = asObject(data?.error)
        throw new Error(String(error?.message || tr('Failed to load audit logs', '加载审计日志失败')))
      }

      const payload = asObject(data.data) as AttendanceAdminAuditLogsPayload | null
      const items = Array.isArray(payload?.items)
        ? payload.items as AttendanceAdminAuditLogItem[]
        : []
      auditLogs.value = items
      auditLogTotal.value = Number(payload?.total ?? items.length) || 0
      auditLogPage.value = Number(payload?.page ?? page) || page
      setAuditLogStatus(tr(`Loaded ${items.length} log(s).`, `已加载 ${items.length} 条日志。`))
    } catch (error: unknown) {
      setAuditLogStatus((error as Error)?.message || tr('Failed to load audit logs', '加载审计日志失败'), 'error')
    } finally {
      auditLogLoading.value = false
    }
  }

  async function exportAuditLogsCsv() {
    auditLogExporting.value = true
    try {
      const params = new URLSearchParams()
      appendAuditLogFilters(params)
      params.set('limit', String(exportLimit))

      const response = await apiFetch(`/api/attendance-admin/audit-logs/export.csv?${params.toString()}`, {
        method: 'GET',
        headers: { Accept: 'text/csv' },
      })
      if (response.status === 404) {
        setAuditLogStatus(tr('Audit log export API not available on this deployment.', '当前部署不支持审计日志导出 API。'), 'error')
        return
      }
      if (response.status === 403) {
        adminForbiddenRef.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }

      const csvText = await response.text()
      if (!response.ok) {
        throw new Error(csvText.slice(0, 200) || tr(`Export failed (HTTP ${response.status})`, `导出失败（HTTP ${response.status}）`))
      }

      const filename = `attendance-audit-logs-${clock().toISOString().replace(/[:.]/g, '-')}.csv`
      downloadCsv(filename, csvText)
      setAuditLogStatus(tr('Audit logs exported.', '审计日志已导出。'))
    } catch (error: unknown) {
      setAuditLogStatus((error as Error)?.message || tr('Failed to export audit logs', '导出审计日志失败'), 'error')
    } finally {
      auditLogExporting.value = false
    }
  }

  async function reloadAuditLogs() {
    await Promise.all([loadAuditLogs(1), loadAuditSummary()])
  }

  return {
    adminForbidden: adminForbiddenRef,
    appendAuditLogFilters,
    auditLogActionPrefix,
    auditLogErrorCode,
    auditLogExporting,
    auditLogFrom,
    auditLogLoading,
    auditLogPage,
    auditLogQuery,
    auditLogSelectedId,
    auditLogStatusClass,
    auditLogStatusKind,
    auditLogStatusMessage,
    auditLogTo,
    auditLogTotal,
    auditLogTotalPages,
    auditLogs,
    auditSummaryActions,
    auditSummaryErrors,
    auditSummaryLoading,
    auditSummaryRowCount,
    exportAuditLogsCsv,
    loadAuditLogs,
    loadAuditSummary,
    reloadAuditLogs,
    toggleAuditLogMeta,
  }
}
