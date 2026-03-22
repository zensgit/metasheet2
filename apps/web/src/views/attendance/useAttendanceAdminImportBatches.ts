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

export type AttendanceImportBatchIssueFilter =
  | 'all'
  | 'anomalies'
  | 'missingRecord'
  | 'warnings'
  | 'late'
  | 'earlyLeave'
  | 'leave'
  | 'overtime'
  | 'clean'

export type AttendanceImportBatchSeverity = 'critical' | 'warning' | 'review' | 'clean'

export interface AttendanceImportBatchIssueCluster {
  key: Exclude<AttendanceImportBatchIssueFilter, 'all'>
  count: number
  severity: AttendanceImportBatchSeverity
}

export interface AttendanceImportBatchIssueBucket {
  filter: AttendanceImportBatchIssueFilter
  count: number
}

export interface AttendanceImportBatchRollbackEstimate {
  loadedItems: number
  totalBatchRows: number
  estimatedCommittedRows: number
  previewOnlyRows: number
  flaggedRows: number
  warningRows: number
  policyReviewRows: number
  coveragePercent: number | null
  isPartial: boolean
}

export interface AttendanceImportBatchImpactReport {
  batchId: string
  mode: 'full'
  itemCount: number
  summary: AttendanceImportBatchImpactSummary
  estimate: AttendanceImportBatchRollbackEstimate
  issueBuckets: AttendanceImportBatchIssueBucket[]
}

export interface AttendanceImportBatchRetryGuidanceStep {
  key: string
  actionLabel: string
  title: string
  detail: string
}

export interface AttendanceImportBatchActionHintMetrics {
  totalItems: number
  anomalyItems: number
  missingRecordItems: number
  warningItems: number
  lateItems: number
  earlyLeaveItems: number
  leaveItems: number
  overtimeItems: number
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

export interface RollbackImportBatchOptions {
  orgId?: string | null
  confirmMessage?: string
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

export function summarizeImportBatchIssueBuckets(items: AttendanceImportItem[]): AttendanceImportBatchIssueBucket[] {
  const summary = summarizeImportBatchItems(items)
  return [
    { filter: 'all', count: summary.totalItems },
    { filter: 'anomalies', count: summary.anomalyItems },
    { filter: 'missingRecord', count: summary.missingRecordItems },
    { filter: 'warnings', count: summary.warningItems },
    { filter: 'late', count: summary.lateItems },
    { filter: 'earlyLeave', count: summary.earlyLeaveItems },
    { filter: 'leave', count: summary.leaveItems },
    { filter: 'overtime', count: summary.overtimeItems },
    { filter: 'clean', count: summary.normalItems },
  ]
}

function isPolicySensitiveAnalysis(analysis: AttendanceImportBatchItemAnalysis): boolean {
  return Boolean(
    (analysis.status && analysis.status !== 'normal')
    || analysis.lateMinutes > 0
    || analysis.earlyLeaveMinutes > 0
    || analysis.leaveMinutes > 0
    || analysis.overtimeMinutes > 0
  )
}

export function estimateImportBatchRollbackImpact(
  batch: AttendanceImportBatch | null | undefined,
  items: AttendanceImportItem[],
): AttendanceImportBatchRollbackEstimate {
  const summary = summarizeImportBatchItems(items)
  const loadedItems = summary.totalItems
  const declaredTotal = Math.max(0, Number(batch?.rowCount) || 0)
  const totalBatchRows = Math.max(declaredTotal, loadedItems)
  const policyReviewRows = items.reduce((count, item) => {
    return count + (isPolicySensitiveAnalysis(classifyImportBatchItem(item)) ? 1 : 0)
  }, 0)
  const coveragePercent = totalBatchRows > 0
    ? Math.round((loadedItems / totalBatchRows) * 100)
    : (loadedItems > 0 ? 100 : null)

  return {
    loadedItems,
    totalBatchRows,
    estimatedCommittedRows: Math.max(0, loadedItems - summary.missingRecordItems),
    previewOnlyRows: summary.missingRecordItems,
    flaggedRows: summary.anomalyItems,
    warningRows: summary.warningItems,
    policyReviewRows,
    coveragePercent,
    isPartial: totalBatchRows > loadedItems,
  }
}

export function buildImportBatchRollbackNotes(
  estimate: AttendanceImportBatchRollbackEstimate,
  tr: Translate = (en) => en,
): string[] {
  if (estimate.loadedItems <= 0) return []

  const notes: string[] = []
  if (estimate.isPartial) {
    notes.push(
      tr(
        `Estimate is based on ${estimate.loadedItems} of ${estimate.totalBatchRows} row(s). Load or export the full batch before rollback if audit or payroll needs exact impact.`,
        `当前估算仅基于 ${estimate.totalBatchRows} 行中的 ${estimate.loadedItems} 行。如果审计或薪资需要精确影响面，请先加载或导出整批数据再回滚。`,
      ),
    )
  }
  if (estimate.previewOnlyRows > 0) {
    notes.push(
      tr(
        `${estimate.previewOnlyRows} loaded row(s) do not show committed records yet. Rollback may not remove those rows from downstream attendance tables.`,
        `已加载条目中有 ${estimate.previewOnlyRows} 行尚未显示已提交记录，这些行回滚后未必会影响下游考勤表。`,
      ),
    )
  }
  if (estimate.warningRows > 0) {
    notes.push(
      tr(
        `${estimate.warningRows} row(s) emitted warnings during preview. Review the warning payload before choosing batch rollback over targeted correction.`,
        `有 ${estimate.warningRows} 行在预演阶段产生警告。请先复核警告内容，再决定是整批回滚还是定向修正。`,
      ),
    )
  }
  if (estimate.policyReviewRows > 0) {
    notes.push(
      tr(
        `${estimate.policyReviewRows} row(s) are policy-sensitive (late, early leave, leave, overtime, or non-normal status). Align approval and payroll reconciliation before rollback.`,
        `有 ${estimate.policyReviewRows} 行属于规则敏感项（迟到、早退、请假、加班或非 normal 状态）。回滚前请先对齐审批与薪资对账。`,
      ),
    )
  }
  if (notes.length === 0 && estimate.estimatedCommittedRows > 0 && !estimate.isPartial) {
    notes.push(
      tr(
        'Loaded rows appear committed and low-risk. Rollback impact should be straightforward if downstream consumers have not reconciled this batch yet.',
        '当前已加载条目看起来已提交且风险较低。如果下游尚未完成对账，回滚影响通常会比较直接。',
      ),
    )
  }
  if (notes.length === 0) {
    notes.push(
      tr(
        'Load the batch items first to estimate rollback impact before using the batch-level rollback action.',
        '请先加载批次条目，再基于估算结果使用整批回滚动作。',
      ),
    )
  }
  return notes
}

export function buildImportBatchRetryGuidance(
  batch: AttendanceImportBatch | null | undefined,
  summary: AttendanceImportBatchImpactSummary,
  estimate: AttendanceImportBatchRollbackEstimate | null | undefined,
  tr: Translate = (en) => en,
): AttendanceImportBatchRetryGuidanceStep[] {
  if (!batch || summary.totalItems <= 0) return []

  const steps: AttendanceImportBatchRetryGuidanceStep[] = []
  const engine = resolveImportBatchEngine(batch)
  const chunkLabel = resolveImportBatchChunkLabel(batch)
  const policyReviewRows = estimate?.policyReviewRows ?? 0
  const previewOnlyRows = estimate?.previewOnlyRows ?? summary.missingRecordItems
  const anomalyRatio = summary.totalItems > 0 ? summary.anomalyItems / summary.totalItems : 0

  if (previewOnlyRows > 0) {
    steps.push({
      key: 'mapping',
      actionLabel: tr('Repair mapping', '修复映射'),
      title: tr('Repair mapping and identity merge first', '优先修复映射与身份归并'),
      detail: tr(
        `${previewOnlyRows} row(s) do not show committed records yet. Review the mapping viewer, export anomalies, and rerun preview before retrying commit.`,
        `有 ${previewOnlyRows} 行尚未显示已提交记录。请先核对映射预览、导出异常，再重新预演后再试提交。`,
      ),
    })
  }

  if (summary.warningItems > 0) {
    steps.push({
      key: 'preview',
      actionLabel: tr('Retry preview', '重试预演'),
      title: tr('Retry preview before any new import commit', '再次导入前先重试预演'),
      detail: tr(
        `${summary.warningItems} row(s) emitted warnings. Export anomalies CSV and clear the warning payload before retrying import.`,
        `有 ${summary.warningItems} 行产生警告。请先导出异常 CSV 并清理警告载荷，再重试导入。`,
      ),
    })
  }

  if (policyReviewRows > 0) {
    steps.push({
      key: 'policy',
      actionLabel: tr('Tune policy', '调整规则'),
      title: tr('Tune rule-set and shift windows before retry', '重试前先校正规则集与班次窗口'),
      detail: tr(
        `${policyReviewRows} row(s) are policy-sensitive. Align grace settings, leave handling, and overtime expectations before rerunning the batch.`,
        `有 ${policyReviewRows} 行属于规则敏感项。请先对齐宽限、请假和加班规则，再重新执行批次。`,
      ),
    })
  }

  if (batch.source === 'api') {
    steps.push({
      key: 'source-api',
      actionLabel: tr('Fix upstream payload', '修复上游载荷'),
      title: tr('Patch the upstream API producer before retry', '重试前先修复上游 API 产出'),
      detail: tr(
        'This batch came from API input. Update the producer payload or field mapping upstream, then rerun preview/import with the same date scope.',
        '该批次来自 API 输入。请先修复上游产出的字段或映射，再用相同日期范围重新预演/导入。',
      ),
    })
  } else if (batch.source === 'csv') {
    steps.push({
      key: 'source-csv',
      actionLabel: tr('Reuse source CSV', '复用源 CSV'),
      title: tr('Keep the original CSV and mapping profile stable', '保持原始 CSV 与映射配置稳定'),
      detail: tr(
        'Retry with the same source CSV and mapping profile after cleanup so you can compare the new preview against the archived anomalies export.',
        '清理后请使用同一份源 CSV 和映射配置重试，便于把新预演与已归档的异常导出做对比。',
      ),
    })
  }

  if (engine === 'bulk') {
    steps.push({
      key: 'engine-bulk',
      actionLabel: tr('Keep chunk profile', '保持分块配置'),
      title: tr('Keep the bulk chunk profile stable while retrying', '重试时保持 bulk 分块配置稳定'),
      detail: tr(
        chunkLabel !== '--'
          ? `Current chunk profile is ${chunkLabel}. Retry preview first on the same chunk settings, then commit only after anomaly volume drops.`
          : 'Retry preview on the current bulk-engine settings first, then commit only after anomaly volume drops.',
        chunkLabel !== '--'
          ? `当前分块配置是 ${chunkLabel}。请先在相同分块设置下重试预演，异常量下降后再提交。`
          : '请先在当前 bulk 设置下重试预演，确认异常量下降后再提交。',
      ),
    })
  }

  if (anomalyRatio >= 0.5) {
    steps.push({
      key: 'prefer-rollback',
      actionLabel: tr('Prefer rollback', '优先回滚'),
      title: tr('Prefer rollback over direct import retry', '优先考虑回滚，而不是直接重试导入'),
      detail: tr(
        `${summary.anomalyItems} of ${summary.totalItems} row(s) are flagged. Rollback is likely lower risk than pushing another commit before cleanup.`,
        `${summary.totalItems} 行中有 ${summary.anomalyItems} 行被标记。在完成清理前，整批回滚通常比再次提交更低风险。`,
      ),
    })
  } else if (summary.anomalyItems === 0 && previewOnlyRows === 0) {
    steps.push({
      key: 'retry-commit',
      actionLabel: tr('Retry commit', '重试提交'),
      title: tr('Batch looks retry-ready after archive checks', '该批次在归档核对后已接近可重试'),
      detail: tr(
        'Loaded rows look committed and low-risk. Archive the current export, then retry commit if downstream reconciliation has not started.',
        '当前条目看起来已提交且风险较低。先留存当前导出，再在下游尚未开始对账时重试提交。',
      ),
    })
  }

  return steps.slice(0, 5)
}

export function buildImportBatchRollbackConfirmationMessage(
  batch: AttendanceImportBatch | null | undefined,
  estimate: AttendanceImportBatchRollbackEstimate | null | undefined,
  mode: 'loaded' | 'full',
  tr: Translate = (en) => en,
): string {
  if (!estimate || estimate.loadedItems <= 0) {
    return tr('Rollback this import batch?', '确认回滚该导入批次吗？')
  }

  const batchLabel = batch?.id ? batch.id.slice(0, 8) : tr('selected batch', '当前批次')
  const basis = mode === 'full'
    ? tr('Full batch', '整批')
    : tr('Loaded items', '已加载条目')
  const coverageLine = estimate.coveragePercent !== null
    ? `${estimate.loadedItems} / ${estimate.totalBatchRows} (${estimate.coveragePercent}%)`
    : `${estimate.loadedItems} / ${estimate.totalBatchRows}`
  const note = mode === 'full'
    ? tr('This confirmation is based on exact full-batch impact.', '本次确认基于精确整批影响面。')
    : tr('This confirmation is based on loaded items only. Load exact impact first if you need a precise rollback decision.', '本次确认仅基于已加载条目。如需精确回滚决策，请先加载精确影响面。')

  return tr(
    `Rollback batch ${batchLabel}?\nImpact basis: ${basis}\nCoverage: ${coverageLine}\nEstimated committed rows: ${estimate.estimatedCommittedRows}\nPreview-only rows: ${estimate.previewOnlyRows}\nFlagged rows: ${estimate.flaggedRows}\nWarning rows: ${estimate.warningRows}\nPolicy-sensitive rows: ${estimate.policyReviewRows}\n\n${note}\n\nContinue rollback?`,
    `确认回滚批次 ${batchLabel} 吗？\n影响依据：${basis}\n覆盖范围：${coverageLine}\n预计受影响记录：${estimate.estimatedCommittedRows}\n仅预演行：${estimate.previewOnlyRows}\n已标记行：${estimate.flaggedRows}\n警告行：${estimate.warningRows}\n规则敏感行：${estimate.policyReviewRows}\n\n${note}\n\n是否继续回滚？`,
  )
}

export function buildImportBatchActionHints(
  metrics: AttendanceImportBatchActionHintMetrics,
  tr: Translate = (en) => en,
): string[] {
  if (metrics.totalItems <= 0) return []

  const hints: string[] = []
  if (metrics.missingRecordItems > 0) {
    hints.push(
      tr(
        `Check missing-record rows first (${metrics.missingRecordItems}). These usually point to mapping, commit, or rollback gaps before policy tuning.`,
        `优先检查缺少记录的 ${metrics.missingRecordItems} 行。这通常意味着映射、提交或回滚链路存在缺口，而不是规则本身的问题。`,
      ),
    )
  }
  if (metrics.warningItems > 0) {
    hints.push(
      tr(
        `Export warnings for focused cleanup (${metrics.warningItems} row(s)) before deciding whether the whole batch needs a rollback.`,
        `先导出包含警告的 ${metrics.warningItems} 行做定向清理，再决定整批是否需要回滚。`,
      ),
    )
  }
  if (metrics.lateItems > 0 || metrics.earlyLeaveItems > 0) {
    hints.push(
      tr(
        `Review shift windows and rule-set grace settings before rollback; ${metrics.lateItems} late and ${metrics.earlyLeaveItems} early-leave row(s) are policy-sensitive.`,
        `回滚前先复核班次窗口和规则宽限；当前有 ${metrics.lateItems} 行迟到、${metrics.earlyLeaveItems} 行早退，属于规则敏感项。`,
      ),
    )
  }
  if (metrics.leaveItems > 0 || metrics.overtimeItems > 0) {
    hints.push(
      tr(
        `Keep leave/overtime rows for downstream approval reconciliation (${metrics.leaveItems}/${metrics.overtimeItems}) instead of treating them as plain import noise.`,
        `请保留请假/加班行用于后续审批与对账（${metrics.leaveItems}/${metrics.overtimeItems}），不要把它们当成普通导入噪音直接清掉。`,
      ),
    )
  }
  if (hints.length === 0 && metrics.anomalyItems === 0) {
    hints.push(
      tr(
        'This batch looks clean. Keep it as the baseline and export only if finance or audit needs an archive.',
        '这一批次看起来干净，可作为基线样本；仅在财务或审计需要留档时再导出。',
      ),
    )
  }
  if (hints.length === 0) {
    hints.push(
      tr(
        `This batch has ${metrics.anomalyItems} flagged row(s). Triage anomalies first, then decide whether a rollback is lower risk than targeted correction.`,
        `当前批次有 ${metrics.anomalyItems} 行被标记。先完成异常分诊，再判断整批回滚是否比定向修正风险更低。`,
      ),
    )
  }
  return hints
}

export function resolveImportBatchSeverity(analysis: AttendanceImportBatchItemAnalysis): AttendanceImportBatchSeverity {
  if (!analysis.hasRecord) return 'critical'
  if (analysis.warnings.length > 0) return 'warning'
  if (
    analysis.lateMinutes > 0
    || analysis.earlyLeaveMinutes > 0
    || analysis.leaveMinutes > 0
    || analysis.overtimeMinutes > 0
    || (analysis.status && analysis.status !== 'normal')
  ) {
    return 'review'
  }
  return 'clean'
}

export function matchesImportBatchIssueFilter(
  analysis: AttendanceImportBatchItemAnalysis,
  filter: AttendanceImportBatchIssueFilter,
): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'anomalies':
      return analysis.isAnomaly
    case 'missingRecord':
      return !analysis.hasRecord
    case 'warnings':
      return analysis.warnings.length > 0
    case 'late':
      return analysis.lateMinutes > 0
    case 'earlyLeave':
      return analysis.earlyLeaveMinutes > 0
    case 'leave':
      return analysis.leaveMinutes > 0
    case 'overtime':
      return analysis.overtimeMinutes > 0
    case 'clean':
      return !analysis.isAnomaly
    default:
      return true
  }
}

export function summarizeImportBatchIssueClusters(items: AttendanceImportItem[]): AttendanceImportBatchIssueCluster[] {
  const counts: Record<Exclude<AttendanceImportBatchIssueFilter, 'all'>, number> = {
    anomalies: 0,
    missingRecord: 0,
    warnings: 0,
    late: 0,
    earlyLeave: 0,
    leave: 0,
    overtime: 0,
    clean: 0,
  }

  for (const item of items) {
    const analysis = classifyImportBatchItem(item)
    if (analysis.isAnomaly) counts.anomalies += 1
    if (!analysis.hasRecord) counts.missingRecord += 1
    if (analysis.warnings.length > 0) counts.warnings += 1
    if (analysis.lateMinutes > 0) counts.late += 1
    if (analysis.earlyLeaveMinutes > 0) counts.earlyLeave += 1
    if (analysis.leaveMinutes > 0) counts.leave += 1
    if (analysis.overtimeMinutes > 0) counts.overtime += 1
    if (!analysis.isAnomaly) counts.clean += 1
  }

  const clusters: AttendanceImportBatchIssueCluster[] = [
    { key: 'missingRecord', count: counts.missingRecord, severity: 'critical' },
    { key: 'warnings', count: counts.warnings, severity: 'warning' },
    { key: 'late', count: counts.late, severity: 'review' },
    { key: 'earlyLeave', count: counts.earlyLeave, severity: 'review' },
    { key: 'leave', count: counts.leave, severity: 'review' },
    { key: 'overtime', count: counts.overtime, severity: 'review' },
    { key: 'anomalies', count: counts.anomalies, severity: 'warning' },
    { key: 'clean', count: counts.clean, severity: 'clean' },
  ]

  return clusters.filter((item) => item.count > 0)
}

export function buildImportBatchSearchIndex(item: AttendanceImportItem, analysis: AttendanceImportBatchItemAnalysis): string {
  const snapshot = item.previewSnapshot
  const chunks = [
    item.id,
    item.batchId,
    item.userId,
    item.workDate,
    item.recordId,
    analysis.status,
    analysis.warnings.join(' '),
    snapshot ? JSON.stringify(snapshot) : '',
  ]
  return chunks
    .map((value) => String(value ?? '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ')
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
  const importBatchImpactLoading = ref(false)
  const importBatchImpactReport = ref<AttendanceImportBatchImpactReport | null>(null)
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
      if (importBatchImpactReport.value?.batchId && importBatchImpactReport.value.batchId !== batchId) {
        importBatchImpactReport.value = null
      }
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

  async function rollbackImportBatch(batchId: string, rollbackOptions: RollbackImportBatchOptions = {}) {
    const confirmMessage = rollbackOptions.confirmMessage ?? tr('Rollback this import batch?', '确认回滚该导入批次吗？')
    if (!batchId || !confirm(confirmMessage)) return

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

      await loadImportBatches({ orgId: rollbackOptions.orgId ?? lastLoadedOrgId.value })
      if (importBatchImpactReport.value?.batchId === batchId) {
        importBatchImpactReport.value = null
      }
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

  async function loadFullImportBatchImpact(batchId: string) {
    if (!batchId) return

    importBatchImpactLoading.value = true
    try {
      const items = await fetchAllImportBatchItems(batchId)
      const batch = importBatches.value.find((candidate) => candidate.id === batchId)
      const summary = summarizeImportBatchItems(items)
      importBatchImpactReport.value = {
        batchId,
        mode: 'full',
        itemCount: items.length,
        summary,
        estimate: estimateImportBatchRollbackImpact(batch, items),
        issueBuckets: summarizeImportBatchIssueBuckets(items),
      }
      setImportStatus(tr('Full-batch impact loaded.', '整批影响面已加载。'))
    } catch (error: unknown) {
      setImportStatus((error as Error)?.message || tr('Failed to load full batch impact', '加载整批影响面失败'), 'error')
    } finally {
      importBatchImpactLoading.value = false
    }
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
    importBatchImpactLoading,
    importBatchImpactReport,
    importBatchSelectedId,
    importBatchSnapshot,
    importBatches,
    importLoading,
    importStatusKind,
    importStatusMessage,
    exportImportBatchItemsCsv,
    loadFullImportBatchImpact,
    loadImportBatchItems,
    loadImportBatches,
    rollbackImportBatch,
    setImportStatus,
    toggleImportBatchSnapshot,
  }
}
