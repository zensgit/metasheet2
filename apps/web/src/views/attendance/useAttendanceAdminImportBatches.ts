import { ref, type Ref } from 'vue'
import { apiFetch as baseApiFetch } from '../../utils/api'

type ApiFetchFn = typeof baseApiFetch
type Translate = (en: string, zh: string) => string
type DownloadCsvFn = (filename: string, csvText: string) => void
type ConfirmFn = (message: string) => boolean
type ImportStatusKind = 'info' | 'error'
type SetStatusFn = (message: string, kind?: ImportStatusKind) => void

interface ApiEnvelope<T> {
  ok?: boolean
  data?: T
  error?: {
    message?: string
  } | null
}

interface AttendanceImportBatchListPayload {
  items?: AttendanceImportBatch[]
}

interface AttendanceImportBatchItemsPayload {
  items?: AttendanceImportItem[]
  total?: number
}

export interface AttendanceImportBatch {
  id: string
  orgId?: string
  createdBy?: string | null
  source?: string | null
  ruleSetId?: string | null
  mapping?: Record<string, any> | null
  rowCount: number
  status: string
  meta?: Record<string, any> | null
  createdAt?: string
  updatedAt?: string
}

export interface AttendanceImportItem {
  id: string
  batchId: string
  orgId?: string
  userId: string | null
  workDate: string | null
  recordId?: string | null
  previewSnapshot?: Record<string, any> | null
  createdAt?: string
}

export interface AttendanceImportBatchItemAnalysis {
  status: string
  workMinutes: number
  lateMinutes: number
  earlyLeaveMinutes: number
  leaveMinutes: number
  overtimeMinutes: number
  warnings: string[]
  hasRecord: boolean
  isAnomaly: boolean
}

export interface AttendanceImportBatchImpactSummary {
  totalItems: number
  anomalyItems: number
  warningItems: number
  missingRecordItems: number
  lateItems: number
  earlyLeaveItems: number
  leaveItems: number
  overtimeItems: number
  normalItems: number
}

export interface UseAttendanceAdminImportBatchesOptions {
  tr: Translate
  adminForbidden?: Ref<boolean>
  apiFetch?: ApiFetchFn
  downloadCsv?: DownloadCsvFn
  confirm?: ConfirmFn
  clock?: () => Date
  setStatus?: SetStatusFn
  statusTimeoutMs?: number
  fallbackPageSize?: number
  fallbackMaxPages?: number
}

export interface LoadImportBatchesOptions {
  orgId?: string | null
}

const IMPORT_STATUS_TIMEOUT_MS = 6000

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

function defaultConfirm(message: string) {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return false
  return window.confirm(message)
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

function buildBatchListUrl(orgId?: string | null): string {
  const params = new URLSearchParams()
  if (orgId) params.set('orgId', orgId)
  const query = params.toString()
  return query ? `/api/attendance/import/batches?${query}` : '/api/attendance/import/batches'
}

export function resolveImportBatchEngine(batch: AttendanceImportBatch): string {
  const engine = typeof batch?.meta?.engine === 'string' ? batch.meta.engine.trim().toLowerCase() : ''
  if (engine === 'bulk' || engine === 'standard') return engine
  return '--'
}

export function resolveImportBatchChunkLabel(batch: AttendanceImportBatch): string {
  const chunk = batch?.meta?.chunkConfig && typeof batch.meta.chunkConfig === 'object'
    ? batch.meta.chunkConfig as Record<string, unknown>
    : null
  const items = Number(chunk?.itemsChunkSize)
  const records = Number(chunk?.recordsChunkSize)
  if (!Number.isFinite(items) || !Number.isFinite(records)) return '--'
  return `${Math.max(0, Math.floor(items))}/${Math.max(0, Math.floor(records))}`
}

export function extractImportSnapshotMetrics(snapshot?: Record<string, any> | null): Record<string, any> {
  if (!snapshot || typeof snapshot !== 'object') return {}
  const metrics = snapshot.metrics
  if (metrics && typeof metrics === 'object' && !Array.isArray(metrics)) return metrics
  return {}
}

export function extractImportSnapshotWarnings(snapshot?: Record<string, any> | null): string[] {
  if (!snapshot || typeof snapshot !== 'object') return []
  const warnings: string[] = []
  const direct = snapshot.warnings
  if (Array.isArray(direct)) warnings.push(...direct.map((value) => String(value)))
  const metrics = extractImportSnapshotMetrics(snapshot)
  const metricWarnings = metrics.warnings
  if (Array.isArray(metricWarnings)) warnings.push(...metricWarnings.map((value) => String(value)))
  const policyWarnings = snapshot.policy?.warnings
  if (Array.isArray(policyWarnings)) warnings.push(...policyWarnings.map((value) => String(value)))
  const engineWarnings = snapshot.engine?.warnings
  if (Array.isArray(engineWarnings)) warnings.push(...engineWarnings.map((value) => String(value)))
  return Array.from(new Set(warnings))
}

export function classifyImportBatchItem(item: AttendanceImportItem): AttendanceImportBatchItemAnalysis {
  const snapshot = item.previewSnapshot
  const metrics = extractImportSnapshotMetrics(snapshot)
  const warnings = extractImportSnapshotWarnings(snapshot)
  const status = String(metrics.status ?? '')
  const workMinutes = Number(metrics.workMinutes ?? 0)
  const lateMinutes = Number(metrics.lateMinutes ?? 0)
  const earlyLeaveMinutes = Number(metrics.earlyLeaveMinutes ?? 0)
  const leaveMinutes = Number(metrics.leaveMinutes ?? 0)
  const overtimeMinutes = Number(metrics.overtimeMinutes ?? 0)
  const hasRecord = (item.recordId ?? null) !== null
  const isAnomaly = Boolean(
    warnings.length
    || !hasRecord
    || (status && status !== 'normal')
    || lateMinutes > 0
    || earlyLeaveMinutes > 0
    || leaveMinutes > 0
    || overtimeMinutes > 0,
  )

  return {
    status,
    workMinutes,
    lateMinutes,
    earlyLeaveMinutes,
    leaveMinutes,
    overtimeMinutes,
    warnings,
    hasRecord,
    isAnomaly,
  }
}

export function summarizeImportBatchItems(items: AttendanceImportItem[]): AttendanceImportBatchImpactSummary {
  const summary: AttendanceImportBatchImpactSummary = {
    totalItems: 0,
    anomalyItems: 0,
    warningItems: 0,
    missingRecordItems: 0,
    lateItems: 0,
    earlyLeaveItems: 0,
    leaveItems: 0,
    overtimeItems: 0,
    normalItems: 0,
  }

  for (const item of items) {
    const analysis = classifyImportBatchItem(item)
    summary.totalItems += 1
    if (analysis.isAnomaly) summary.anomalyItems += 1
    if (analysis.warnings.length > 0) summary.warningItems += 1
    if (!analysis.hasRecord) summary.missingRecordItems += 1
    if (analysis.lateMinutes > 0) summary.lateItems += 1
    if (analysis.earlyLeaveMinutes > 0) summary.earlyLeaveItems += 1
    if (analysis.leaveMinutes > 0) summary.leaveItems += 1
    if (analysis.overtimeMinutes > 0) summary.overtimeItems += 1
    if (analysis.status === 'normal' && !analysis.isAnomaly) summary.normalItems += 1
  }

  return summary
}

export function useAttendanceAdminImportBatches(options: UseAttendanceAdminImportBatchesOptions) {
  const {
    tr,
    adminForbidden,
    apiFetch = baseApiFetch,
    downloadCsv = defaultDownloadCsv,
    confirm = defaultConfirm,
    clock = () => new Date(),
    setStatus,
    statusTimeoutMs = IMPORT_STATUS_TIMEOUT_MS,
    fallbackPageSize = 200,
    fallbackMaxPages = 500,
  } = options

  const adminForbiddenRef = adminForbidden ?? ref(false)
  const importLoading = ref(false)
  const importStatusMessage = ref('')
  const importStatusKind = ref<ImportStatusKind>('info')
  const importBatches = ref<AttendanceImportBatch[]>([])
  const importBatchItems = ref<AttendanceImportItem[]>([])
  const importBatchSelectedId = ref('')
  const importBatchSnapshot = ref<Record<string, any> | null>(null)
  const lastLoadedOrgId = ref<string | null>(null)

  function setImportStatus(message: string, kind: ImportStatusKind = 'info') {
    importStatusKind.value = kind
    importStatusMessage.value = message
    setStatus?.(message, kind)
    if (!message) return
    globalThis.setTimeout(() => {
      if (importStatusMessage.value === message) {
        importStatusMessage.value = ''
      }
    }, statusTimeoutMs)
  }

  async function loadImportBatches(loadOptions: LoadImportBatchesOptions = {}) {
    importLoading.value = true
    lastLoadedOrgId.value = loadOptions.orgId ?? null
    try {
      const response = await apiFetch(buildBatchListUrl(loadOptions.orgId))
      if (response.status === 403) {
        adminForbiddenRef.value = true
        return
      }

      const data = asObject(await response.json().catch(() => null)) as ApiEnvelope<AttendanceImportBatchListPayload> | null
      if (!response.ok || !data?.ok) {
        throw new Error(String(data?.error?.message || tr('Failed to load import batches', '加载导入批次失败')))
      }

      importBatches.value = Array.isArray(data.data?.items) ? data.data.items : []
    } catch (error: unknown) {
      setImportStatus((error as Error)?.message || tr('Failed to load import batches', '加载导入批次失败'), 'error')
    } finally {
      importLoading.value = false
    }
  }

  async function loadImportBatchItems(batchId: string) {
    if (!batchId) return
    importLoading.value = true
    try {
      const response = await apiFetch(`/api/attendance/import/batches/${batchId}/items`)
      if (response.status === 403) {
        adminForbiddenRef.value = true
        return
      }

      const data = asObject(await response.json().catch(() => null)) as ApiEnvelope<AttendanceImportBatchItemsPayload> | null
      if (!response.ok || !data?.ok) {
        throw new Error(String(data?.error?.message || tr('Failed to load import batch items', '加载导入批次明细失败')))
      }

      importBatchSelectedId.value = batchId
      importBatchItems.value = Array.isArray(data.data?.items) ? data.data.items : []
      importBatchSnapshot.value = null
    } catch (error: unknown) {
      setImportStatus((error as Error)?.message || tr('Failed to load import batch items', '加载导入批次明细失败'), 'error')
    } finally {
      importLoading.value = false
    }
  }

  function toggleImportBatchSnapshot(item: AttendanceImportItem) {
    if (!item.previewSnapshot) {
      importBatchSnapshot.value = null
      return
    }
    if (importBatchSnapshot.value === item.previewSnapshot) {
      importBatchSnapshot.value = null
      return
    }
    importBatchSnapshot.value = item.previewSnapshot
  }

  async function rollbackImportBatch(batchId: string, loadOptions: LoadImportBatchesOptions = {}) {
    if (!batchId || !confirm(tr('Rollback this import batch?', '确认回滚该导入批次吗？'))) return

    importLoading.value = true
    try {
      const response = await apiFetch(`/api/attendance/import/rollback/${batchId}`, { method: 'POST' })
      if (response.status === 403) {
        adminForbiddenRef.value = true
        return
      }

      const data = asObject(await response.json().catch(() => null)) as ApiEnvelope<unknown> | null
      if (!response.ok || !data?.ok) {
        throw new Error(String(data?.error?.message || tr('Failed to rollback import batch', '回滚导入批次失败')))
      }

      await loadImportBatches({ orgId: loadOptions.orgId ?? lastLoadedOrgId.value })
      if (importBatchSelectedId.value === batchId) {
        importBatchItems.value = []
        importBatchSnapshot.value = null
        importBatchSelectedId.value = ''
      }
      setImportStatus(tr('Import batch rolled back.', '导入批次已回滚。'))
    } catch (error: unknown) {
      setImportStatus((error as Error)?.message || tr('Failed to rollback import batch', '回滚导入批次失败'), 'error')
    } finally {
      importLoading.value = false
    }
  }

  async function fetchAllImportBatchItems(batchId: string): Promise<AttendanceImportItem[]> {
    let page = 1
    let total: number | null = null
    const items: AttendanceImportItem[] = []

    while (total === null || items.length < total) {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(fallbackPageSize),
      })
      const response = await apiFetch(`/api/attendance/import/batches/${batchId}/items?${params.toString()}`)
      if (response.status === 403) {
        adminForbiddenRef.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }

      const data = asObject(await response.json().catch(() => null)) as ApiEnvelope<AttendanceImportBatchItemsPayload> | null
      if (!response.ok || !data?.ok) {
        throw new Error(String(data?.error?.message || tr('Failed to load import items', '加载导入条目失败')))
      }

      const pageItems = Array.isArray(data.data?.items) ? data.data.items : []
      items.push(...pageItems)
      const nextTotal = Number(data.data?.total)
      if (Number.isFinite(nextTotal)) total = nextTotal
      if (pageItems.length === 0) break
      page += 1
      if (page > fallbackMaxPages) break
    }

    return items
  }

  async function exportImportBatchItemsCsv(onlyAnomalies: boolean) {
    const batchId = importBatchSelectedId.value
    if (!batchId) {
      setImportStatus(tr('Select a batch first.', '请先选择批次。'), 'error')
      return
    }

    importLoading.value = true
    try {
      const exportType = onlyAnomalies ? 'anomalies' : 'all'
      const serverResponse = await apiFetch(`/api/attendance/import/batches/${batchId}/export.csv?type=${exportType}`, {
        method: 'GET',
        headers: { Accept: 'text/csv' },
      })

      if (serverResponse.status === 403) {
        adminForbiddenRef.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }

      if (serverResponse.ok) {
        const csvText = await serverResponse.text()
        const stamp = clock().toISOString().slice(0, 10)
        downloadCsv(`attendance-import-${batchId.slice(0, 8)}-${exportType}-${stamp}.csv`, csvText)
        setImportStatus(tr('CSV exported.', 'CSV 已导出。'))
        return
      }

      if (serverResponse.status !== 404) {
        const errorText = await serverResponse.text().catch(() => '')
        throw new Error(errorText || tr(`Failed to export CSV (HTTP ${serverResponse.status})`, `导出 CSV 失败（HTTP ${serverResponse.status}）`))
      }

      const allItems = await fetchAllImportBatchItems(batchId)
      if (allItems.length === 0) {
        setImportStatus(tr('No batch items found.', '未找到批次明细。'), 'error')
        return
      }

      allItems.sort((a, b) => {
        const dateCmp = String(a.workDate ?? '').localeCompare(String(b.workDate ?? ''))
        if (dateCmp !== 0) return dateCmp
        return String(a.userId ?? '').localeCompare(String(b.userId ?? ''))
      })

      const headers = [
        'batchId',
        'itemId',
        'workDate',
        'userId',
        'recordId',
        'status',
        'workMinutes',
        'lateMinutes',
        'earlyLeaveMinutes',
        'leaveMinutes',
        'overtimeMinutes',
        'warnings',
      ]

      const rows = allItems
        .map((item) => {
          const analysis = classifyImportBatchItem(item)

          return {
            item,
            ...analysis,
          }
        })
        .filter((row) => (onlyAnomalies ? row.isAnomaly : true))

      const lines = [headers.map(csvEscape).join(',')]
      rows.forEach(({ item, status, workMinutes, lateMinutes, earlyLeaveMinutes, leaveMinutes, overtimeMinutes, warnings }) => {
        const values = [
          batchId,
          item.id,
          item.workDate || '',
          item.userId || '',
          item.recordId || '',
          status,
          workMinutes,
          lateMinutes,
          earlyLeaveMinutes,
          leaveMinutes,
          overtimeMinutes,
          warnings.join('; '),
        ]
        lines.push(values.map(csvEscape).join(','))
      })

      const stamp = clock().toISOString().slice(0, 10)
      downloadCsv(
        `attendance-import-${batchId.slice(0, 8)}-${onlyAnomalies ? 'anomalies' : 'items'}-${stamp}.csv`,
        lines.join('\n'),
      )
      setImportStatus(tr(`CSV exported (${rows.length}/${allItems.length}).`, `CSV 已导出（${rows.length}/${allItems.length}）。`))
    } catch (error: unknown) {
      setImportStatus((error as Error)?.message || tr('Failed to export CSV', '导出 CSV 失败'), 'error')
    } finally {
      importLoading.value = false
    }
  }

  return {
    importBatchItems,
    importBatchSelectedId,
    importBatchSnapshot,
    importBatches,
    importLoading,
    importStatusKind,
    importStatusMessage,
    exportImportBatchItemsCsv,
    loadImportBatchItems,
    loadImportBatches,
    rollbackImportBatch,
    setImportStatus,
    toggleImportBatchSnapshot,
  }
}
