import { computed, reactive, ref, watch, type Ref } from 'vue'
import { apiFetch as baseApiFetch } from '../../utils/api'
import { formatTimezoneStatusLabel } from './attendanceTimezones'

type ApiFetchFn = typeof baseApiFetch
type Translate = (en: string, zh: string) => string
type ImportStatusKind = 'info' | 'error'
type AttendanceImportStatusAction = 'retry-preview-import' | 'retry-run-import'
type MaybePromise<T> = T | Promise<T>
type LoadRecordsFn = () => MaybePromise<unknown>
type LoadImportBatchesFn = (options?: { orgId?: string | null }) => MaybePromise<unknown>
type ReadFileTextFn = (file: File) => Promise<string>
type SleepFn = (ms: number) => Promise<void>
type DownloadTextFn = (filename: string, text: string, mimeType?: string) => void
type SetStatusFn = (
  message: string,
  kind?: ImportStatusKind,
  meta?: AttendanceImportStatusMeta,
) => void
type SetStatusFromErrorFn = (
  error: unknown,
  fallbackMessage: string,
  context: AttendanceImportStatusContext,
) => void
type CreateApiErrorFn = (
  response: { status: number },
  payload: any,
  fallbackMessage: string,
) => AttendanceApiError

export type AttendanceImportMode = 'override' | 'merge'
export type AttendanceImportStatusContext = 'import-preview' | 'import-run'
export type AttendanceImportPreviewLane = 'sync' | 'chunked' | 'async'
export type AttendanceImportCommitLane = 'sync' | 'async'

export interface AttendanceImportStatusMeta {
  hint?: string
  action?: AttendanceImportStatusAction
  context?: AttendanceImportStatusContext
  sticky?: boolean
  code?: string
  [key: string]: unknown
}

export interface AttendanceApiError extends Error {
  code?: string
  status?: number
}

export interface AttendanceImportFormState {
  ruleSetId: string
  userId: string
  timezone: string
  payload: string
}

export interface AttendanceImportPreviewItem {
  userId: string
  workDate: string
  workMinutes: number
  lateMinutes: number
  earlyLeaveMinutes: number
  status: string
  leaveMinutes?: number
  overtimeMinutes?: number
  isWorkday?: boolean
  warnings?: string[]
  appliedPolicies?: string[]
  userGroups?: string[]
}

export interface AttendanceImportMappingProfile {
  id: string
  name: string
  description?: string
  source?: string
  mapping?: Record<string, any>
  requiredFields?: string[]
  userMapKeyField?: string
  userMapSourceFields?: string[]
  payloadExample?: Record<string, any>
}

export interface AttendanceImportFieldGuide {
  field: string
  meaningEn: string
  meaningZh: string
}

export interface AttendanceImportProfileMappingGuide {
  targetField: string
  sourceField: string
  meaningEn: string
  meaningZh: string
}

export interface AttendanceImportTemplateGuide {
  source: string
  mode: AttendanceImportMode
  columns: string[]
  requiredFields: string[]
  sampleHeader: string
  fieldGuides: AttendanceImportFieldGuide[]
}

export interface AttendanceImportProfileGuide {
  name: string
  description?: string
  requiredFields: string[]
  mappingEntries: AttendanceImportProfileMappingGuide[]
  userMapKeyField?: string
  userMapSourceFields?: string[]
}

export interface AttendanceImportJob {
  id: string
  orgId?: string
  batchId: string
  createdBy?: string | null
  idempotencyKey?: string | null
  kind?: 'commit' | 'preview' | string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled' | string
  progress: number
  total: number
  engine?: 'standard' | 'bulk' | string | null
  recordUpsertStrategy?: string | null
  processedRows?: number
  failedRows?: number
  elapsedMs?: number
  progressPercent?: number
  throughputRowsPerSec?: number
  error?: string | null
  preview?: {
    items?: AttendanceImportPreviewItem[]
    total?: number
    rowCount?: number
    truncated?: boolean
    previewLimit?: number
    stats?: { rowCount?: number; invalid?: number; duplicates?: number }
    csvWarnings?: string[]
    groupWarnings?: string[]
  } | null
  startedAt?: string | null
  finishedAt?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

export interface AttendanceImportPreviewTask {
  mode: 'single' | 'chunked'
  status: 'running' | 'completed' | 'failed'
  totalRows: number
  processedRows: number
  totalChunks: number
  completedChunks: number
  message?: string | null
}

export interface AttendanceImportDebugOptions {
  forceUploadCsv: boolean
  forceAsyncImport: boolean
  forceTimeoutOnce: boolean
  pollIntervalMs: number | null
  pollTimeoutMs: number | null
}

export interface AttendanceImportThresholds {
  largeRow: number
  previewLimit: number
  commitItemsLimit: number
  previewChunkThreshold: number
  previewChunkSize: number
  previewAsyncThreshold: number
  commitAsyncThreshold: number
}

function resolvePreviewLane(
  payload: Record<string, any>,
  rowCountHint: number | null,
  thresholds: AttendanceImportThresholds,
): AttendanceImportPreviewLane {
  if (rowCountHint && rowCountHint >= thresholds.previewAsyncThreshold) {
    return 'async'
  }

  const inlineRows = Array.isArray(payload.rows)
    ? payload.rows.length
    : Array.isArray(payload.entries)
      ? payload.entries.length
      : typeof payload.csvText === 'string' && payload.csvText.trim().length > 0
        ? rowCountHint
        : null

  if (inlineRows && inlineRows >= thresholds.previewChunkThreshold) {
    return 'chunked'
  }

  return 'sync'
}

function resolveCommitLane(
  rowCountHint: number | null,
  thresholds: AttendanceImportThresholds,
): AttendanceImportCommitLane {
  if (rowCountHint && rowCountHint >= thresholds.commitAsyncThreshold) {
    return 'async'
  }
  return 'sync'
}

export interface UseAttendanceAdminImportWorkflowOptions {
  tr: Translate
  defaultTimezone: string
  adminForbidden?: Ref<boolean>
  importLoading?: Ref<boolean>
  apiFetch?: ApiFetchFn
  getOrgId?: () => string | undefined
  getUserId?: () => string | undefined
  setStatus?: SetStatusFn
  setStatusFromError?: SetStatusFromErrorFn
  loadRecords?: LoadRecordsFn
  loadImportBatches?: LoadImportBatchesFn
  createApiError?: CreateApiErrorFn
  readImportDebugOptions?: () => AttendanceImportDebugOptions
  readFileText?: ReadFileTextFn
  sleep?: SleepFn
  downloadText?: DownloadTextFn
  now?: () => number
  thresholds?: Partial<AttendanceImportThresholds>
}

interface ImportPreviewChunkPlan {
  totalRows: number
  chunkCount: number
  sampleLimit: number
  buildPayload: (chunkIndex: number, remainingSample: number) => Record<string, any>
}

const IMPORT_LARGE_ROW_THRESHOLD = 2000
const IMPORT_PREVIEW_LIMIT = 200
const IMPORT_COMMIT_ITEMS_LIMIT = 200
const IMPORT_PREVIEW_CHUNK_THRESHOLD = 10_000
const IMPORT_PREVIEW_CHUNK_SIZE = 5000
const IMPORT_PREVIEW_ASYNC_ROW_THRESHOLD = 50_000
const IMPORT_ASYNC_ROW_THRESHOLD = 50_000
const IMPORT_ASYNC_DEFAULT_POLL_INTERVAL_MS = 2000
const IMPORT_ASYNC_DEFAULT_POLL_TIMEOUT_MS = 30 * 60 * 1000
const IMPORT_CSV_UPLOAD_THRESHOLD_BYTES = 5 * 1024 * 1024

function parseEnvPositiveInt(raw: unknown, fallback: number, minimum = 1): number {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  const normalized = Math.floor(parsed)
  if (normalized < minimum) return fallback
  return normalized
}

function parseOptionalPositiveInt(raw: unknown, minimum = 1): number | null {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return null
  const normalized = Math.floor(parsed)
  if (normalized < minimum) return null
  return normalized
}

export const DEFAULT_ATTENDANCE_IMPORT_THRESHOLDS: AttendanceImportThresholds = {
  largeRow: parseEnvPositiveInt(import.meta.env.VITE_ATTENDANCE_IMPORT_LARGE_ROW_THRESHOLD, IMPORT_LARGE_ROW_THRESHOLD, 100),
  previewLimit: parseEnvPositiveInt(import.meta.env.VITE_ATTENDANCE_IMPORT_PREVIEW_LIMIT, IMPORT_PREVIEW_LIMIT, 10),
  commitItemsLimit: parseEnvPositiveInt(import.meta.env.VITE_ATTENDANCE_IMPORT_COMMIT_ITEMS_LIMIT, IMPORT_COMMIT_ITEMS_LIMIT, 10),
  previewChunkThreshold: parseEnvPositiveInt(import.meta.env.VITE_ATTENDANCE_IMPORT_PREVIEW_CHUNK_THRESHOLD, IMPORT_PREVIEW_CHUNK_THRESHOLD, 1000),
  previewChunkSize: parseEnvPositiveInt(import.meta.env.VITE_ATTENDANCE_IMPORT_PREVIEW_CHUNK_SIZE, IMPORT_PREVIEW_CHUNK_SIZE, 100),
  previewAsyncThreshold: parseEnvPositiveInt(import.meta.env.VITE_ATTENDANCE_IMPORT_PREVIEW_ASYNC_ROW_THRESHOLD, IMPORT_PREVIEW_ASYNC_ROW_THRESHOLD, 1000),
  commitAsyncThreshold: parseEnvPositiveInt(
    import.meta.env.VITE_ATTENDANCE_IMPORT_COMMIT_ASYNC_ROW_THRESHOLD
      ?? import.meta.env.VITE_ATTENDANCE_IMPORT_ASYNC_ROW_THRESHOLD,
    IMPORT_ASYNC_ROW_THRESHOLD,
    1000,
  ),
}

export function resolveAttendanceImportThresholds(
  overrides: Partial<AttendanceImportThresholds> = {},
): AttendanceImportThresholds {
  const thresholds = { ...DEFAULT_ATTENDANCE_IMPORT_THRESHOLDS }
  for (const key of Object.keys(overrides) as Array<keyof AttendanceImportThresholds>) {
    const override = parseOptionalPositiveInt(overrides[key], 1)
    if (override !== null) {
      thresholds[key] = override
    }
  }
  return thresholds
}

function parseDebugBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1'
}

function parseDebugPositiveInt(value: unknown): number | null {
  return parseOptionalPositiveInt(value, 1)
}

export function readAttendanceImportDebugOptions(): AttendanceImportDebugOptions {
  const defaults: AttendanceImportDebugOptions = {
    forceUploadCsv: false,
    forceAsyncImport: false,
    forceTimeoutOnce: false,
    pollIntervalMs: null,
    pollTimeoutMs: null,
  }
  if (typeof window === 'undefined') return defaults

  const raw = window.localStorage.getItem('metasheet_attendance_debug')
  if (!raw) return defaults

  try {
    const parsed = JSON.parse(raw) as Record<string, any>
    const importNode = parsed?.import && typeof parsed.import === 'object'
      ? parsed.import as Record<string, any>
      : parsed
    return {
      forceUploadCsv: parseDebugBoolean(importNode.forceUploadCsv ?? parsed.forceUploadCsv),
      forceAsyncImport: parseDebugBoolean(importNode.forceAsyncImport ?? parsed.forceAsyncImport),
      forceTimeoutOnce: parseDebugBoolean(importNode.forceTimeoutOnce ?? parsed.forceTimeoutOnce),
      pollIntervalMs: parseDebugPositiveInt(importNode.pollIntervalMs ?? parsed.pollIntervalMs),
      pollTimeoutMs: parseDebugPositiveInt(importNode.pollTimeoutMs ?? parsed.pollTimeoutMs),
    }
  } catch {
    return defaults
  }
}

function normalizeErrorCode(value: string): string {
  return String(value || '')
    .trim()
    .replace(/[\s-]+/g, '_')
    .toUpperCase()
}

export function defaultCreateAttendanceImportApiError(
  response: { status: number },
  payload: any,
  fallbackMessage: string,
): AttendanceApiError {
  const errorNode = payload?.error
  const message = typeof errorNode?.message === 'string' && errorNode.message.trim().length > 0
    ? errorNode.message.trim()
    : fallbackMessage
  const error = new Error(message) as AttendanceApiError
  error.status = Number(response?.status) || 0
  if (typeof errorNode?.code === 'string' && errorNode.code.trim().length > 0) {
    error.code = normalizeErrorCode(errorNode.code)
  }
  return error
}

export function parseAttendanceImportJsonConfig(value: string): Record<string, any> | null {
  const trimmed = value.trim()
  if (!trimmed) return {}
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object') return parsed as Record<string, any>
    return null
  } catch {
    return null
  }
}

function splitListInput(value: string): string[] {
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(item => String(item ?? '').trim()).filter(Boolean)
  }
  if (typeof value === 'string') {
    return splitListInput(value)
  }
  return []
}

function normalizeImportGroupSyncConfig(value: unknown): {
  autoCreate: boolean
  autoAssignMembers: boolean
  ruleSetId: string
  timezone: string
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const groupSync = value as Record<string, unknown>
  return {
    autoCreate: groupSync.autoCreate === true,
    autoAssignMembers: groupSync.autoAssignMembers === true,
    ruleSetId: normalizeIdentifier(groupSync.ruleSetId) ?? '',
    timezone: normalizeIdentifier(groupSync.timezone) ?? '',
  }
}

export function normalizeAttendanceImportUserMapPayload(
  payload: unknown,
  keyField: string,
): Record<string, any> | null {
  if (!payload) return null
  if (
    typeof payload === 'object'
    && !Array.isArray(payload)
    && (payload as Record<string, any>).mapping
    && typeof (payload as Record<string, any>).mapping === 'object'
    && !Array.isArray((payload as Record<string, any>).mapping)
  ) {
    return (payload as Record<string, any>).mapping as Record<string, any>
  }
  if (Array.isArray(payload)) {
    if (!keyField) return null
    const map: Record<string, any> = {}
    payload.forEach((entry) => {
      const key = (entry as Record<string, any> | null | undefined)?.[keyField]
      if (key !== undefined && key !== null) {
        const textKey = String(key).trim()
        if (textKey) map[textKey] = entry
      }
    })
    return Object.keys(map).length ? map : null
  }
  if (typeof payload === 'object') return payload as Record<string, any>
  return null
}

function toNonNegativeNumber(value: unknown): number | null {
  const num = Number(value)
  if (!Number.isFinite(num) || num < 0) return null
  return num
}

function normalizePreviewSampleLimit(rawLimit: unknown, fallback: number): number {
  const value = Number(rawLimit)
  if (!Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), 1), 1000)
}

function splitCsvRecords(csvText: string): string[] {
  if (!csvText) return []
  const records: string[] = []
  let start = 0
  let inQuotes = false

  for (let i = 0; i < csvText.length; i += 1) {
    const ch = csvText[i]
    if (ch === '"') {
      if (inQuotes && csvText[i + 1] === '"') {
        i += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }
    if (ch === '\n' && !inQuotes) {
      const raw = csvText.slice(start, i)
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      records.push(line)
      start = i + 1
    }
  }

  if (start <= csvText.length) {
    const raw = csvText.slice(start)
    if (raw.length > 0) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      records.push(line)
    }
  }

  if (records.length > 0 && records[0].charCodeAt(0) === 0xfeff) {
    records[0] = records[0].slice(1)
  }
  return records.filter((line, index) => !(index === records.length - 1 && line.trim() === ''))
}

function extractFileFromEvent(event: Event): File | null {
  const target = event.target as HTMLInputElement | null
  return target?.files?.[0] ?? null
}

function normalizeIdentifier(value: unknown): string | undefined {
  const text = String(value ?? '').trim()
  return text || undefined
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => globalThis.setTimeout(resolve, ms))
}

async function defaultReadFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') {
    return await file.text()
  }
  if (typeof FileReader === 'undefined') {
    throw new Error('FileReader is unavailable')
  }

  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.readAsText(file)
  })
}

function defaultDownloadText(filename: string, text: string, mimeType = 'text/plain;charset=utf-8'): void {
  if (typeof window === 'undefined' || typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return
  }
  const blob = new Blob([text], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => {
    URL.revokeObjectURL(url)
  }, 1000)
}

function escapeCsvCell(value: string): string {
  const text = String(value ?? '')
  if (!/[",\r\n]/.test(text)) return text
  return `"${text.replace(/"/g, '""')}"`
}

function buildImportPerfSuffix(input: {
  engine?: unknown
  recordUpsertStrategy?: unknown
  processedRows?: unknown
  failedRows?: unknown
  elapsedMs?: unknown
}): { en: string; zh: string } {
  const processedRows = toNonNegativeNumber(input.processedRows) ?? 0
  const failedRows = toNonNegativeNumber(input.failedRows) ?? 0
  const elapsedMs = toNonNegativeNumber(input.elapsedMs) ?? 0
  const importEngine = String(input.engine ?? '').trim().toLowerCase()
  const importStrategy = String(input.recordUpsertStrategy ?? '').trim().toLowerCase()

  const perfBitsEn: string[] = []
  const perfBitsZh: string[] = []
  if (importEngine) {
    perfBitsEn.push(`engine=${importEngine}`)
    perfBitsZh.push(`引擎=${importEngine}`)
  }
  if (importStrategy) {
    perfBitsEn.push(`strategy=${importStrategy}`)
    perfBitsZh.push(`策略=${importStrategy}`)
  }
  perfBitsEn.push(`processed=${processedRows}`)
  perfBitsZh.push(`处理=${processedRows}`)
  perfBitsEn.push(`failed=${failedRows}`)
  perfBitsZh.push(`失败=${failedRows}`)
  perfBitsEn.push(`elapsedMs=${elapsedMs}`)
  perfBitsZh.push(`耗时毫秒=${elapsedMs}`)

  return {
    en: perfBitsEn.length ? ` (${perfBitsEn.join(', ')})` : '',
    zh: perfBitsZh.length ? `（${perfBitsZh.join('，')}）` : '',
  }
}

const ATTENDANCE_IMPORT_FIELD_MEANINGS: Record<string, { en: string; zh: string }> = {
  source: {
    en: 'Import source that selects the parser and mapping path.',
    zh: '导入来源，用于选择解析器和映射路径。',
  },
  mode: {
    en: 'Import behavior. override replaces matching user/date rows; merge keeps existing values when new fields are missing.',
    zh: '导入行为。override 会覆盖同用户同日期记录；merge 在缺少新字段时保留已有值。',
  },
  columns: {
    en: 'Source column names or column definitions used by the template.',
    zh: '模板使用的源列名或列定义。',
  },
  mapping: {
    en: 'Source-to-attendance field mapping used when parsing each row.',
    zh: '解析每一行时使用的源字段到考勤字段映射。',
  },
  data: {
    en: 'Structured row data keyed by the source columns.',
    zh: '按源列组织的结构化行数据。',
  },
  rows: {
    en: 'Inline rows included directly in the payload.',
    zh: '直接写入载荷的行数据。',
  },
  entries: {
    en: 'Alternate inline row array used by some import sources.',
    zh: '某些导入来源使用的另一种行数组。',
  },
  userId: {
    en: 'Target attendance user ID.',
    zh: '考勤目标用户 ID。',
  },
  workDate: {
    en: 'Attendance date for the imported record.',
    zh: '导入记录对应的考勤日期。',
  },
  firstInAt: {
    en: 'First clock-in timestamp for the day.',
    zh: '当天第一次打卡时间。',
  },
  lastOutAt: {
    en: 'Last clock-out timestamp for the day.',
    zh: '当天最后一次打卡时间。',
  },
  workMinutes: {
    en: 'Total worked minutes after the import rules are applied.',
    zh: '套用导入规则后得到的工作分钟数。',
  },
  lateMinutes: {
    en: 'Minutes counted as late arrival.',
    zh: '计为迟到的分钟数。',
  },
  earlyLeaveMinutes: {
    en: 'Minutes counted as early leave.',
    zh: '计为早退的分钟数。',
  },
  leaveMinutes: {
    en: 'Minutes counted as leave time.',
    zh: '计为请假时间的分钟数。',
  },
  overtimeMinutes: {
    en: 'Minutes counted as overtime.',
    zh: '计为加班的分钟数。',
  },
  status: {
    en: 'Attendance status produced by the import engine.',
    zh: '导入引擎生成的考勤状态。',
  },
  isWorkday: {
    en: 'Whether the imported date is treated as a workday.',
    zh: '导入日期是否被视为工作日。',
  },
  warnings: {
    en: 'Warning messages generated while importing the row.',
    zh: '导入该行时生成的警告信息。',
  },
  appliedPolicies: {
    en: 'Policies that were applied to compute the result.',
    zh: '用于计算结果的规则。',
  },
  userGroups: {
    en: 'User groups associated with the imported record.',
    zh: '与导入记录关联的用户分组。',
  },
  orgId: {
    en: 'Organization that owns the import.',
    zh: '导入所属的组织。',
  },
  timezone: {
    en: 'Timezone used to interpret dates and clock-in or clock-out timestamps.',
    zh: '用于解析日期和上下班打卡时间的时区。',
  },
  ruleSetId: {
    en: 'Rule set applied while evaluating imported attendance data.',
    zh: '导入考勤数据时使用的规则集。',
  },
  mappingProfileId: {
    en: 'Saved mapping profile selected for this payload.',
    zh: '此载荷选中的已保存映射配置。',
  },
  csvText: {
    en: 'Raw CSV text to upload or preview.',
    zh: '用于上传或预览的原始 CSV 文本。',
  },
  csvFileId: {
    en: 'Uploaded CSV file reference returned by the server.',
    zh: '服务端返回的已上传 CSV 文件引用。',
  },
  csvOptions: {
    en: 'CSV parsing options such as header row and delimiter.',
    zh: 'CSV 解析选项，例如表头行和分隔符。',
  },
  userMap: {
    en: 'Lookup table used to resolve imported values to users.',
    zh: '用于把导入值解析为用户的查找表。',
  },
  userMapKeyField: {
    en: 'Key field in the user map, such as employee number.',
    zh: '用户映射中的键字段，例如工号。',
  },
  userMapSourceFields: {
    en: 'Source fields that can be used to match the user map key.',
    zh: '用于匹配用户映射键的源字段。',
  },
  groupSync: {
    en: 'Optional group creation and member assignment settings.',
    zh: '可选的分组创建和成员分配设置。',
  },
  commitToken: {
    en: 'Short-lived token required for preview and commit requests.',
    zh: '预览和提交请求所需的短期令牌。',
  },
}

const ATTENDANCE_IMPORT_FIELD_ORDER = [
  'source',
  'mode',
  'columns',
  'mapping',
  'data',
  'rows',
  'entries',
  'csvText',
  'csvFileId',
  'csvOptions',
  'userId',
  'orgId',
  'timezone',
  'ruleSetId',
  'mappingProfileId',
  'userMap',
  'userMapKeyField',
  'userMapSourceFields',
  'groupSync',
  'commitToken',
]

function humanizeAttendanceImportField(field: string): string {
  return String(field)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function describeAttendanceImportField(field: string): AttendanceImportFieldGuide {
  const normalized = String(field || '').trim()
  const known = ATTENDANCE_IMPORT_FIELD_MEANINGS[normalized]
  if (known) {
    return {
      field: normalized,
      meaningEn: known.en,
      meaningZh: known.zh,
    }
  }
  const humanized = humanizeAttendanceImportField(normalized) || normalized
  return {
    field: normalized,
    meaningEn: `Field "${humanized}".`,
    meaningZh: `字段“${humanized}”。`,
  }
}

function extractTemplateColumns(columns: unknown): string[] {
  if (!Array.isArray(columns)) return []
  const values: string[] = []
  for (const column of columns) {
    if (typeof column === 'string') {
      const text = column.trim()
      if (text) values.push(text)
      continue
    }
    if (!column || typeof column !== 'object') continue
    const candidate = (
      (column as Record<string, unknown>).header
      ?? (column as Record<string, unknown>).sourceField
      ?? (column as Record<string, unknown>).source
      ?? (column as Record<string, unknown>).name
      ?? (column as Record<string, unknown>).field
      ?? (column as Record<string, unknown>).key
      ?? (column as Record<string, unknown>).targetField
      ?? (column as Record<string, unknown>).label
    )
    if (typeof candidate === 'string') {
      const text = candidate.trim()
      if (text) values.push(text)
    }
  }
  return Array.from(new Set(values))
}

function extractRequiredFields(payloadExample: Record<string, any>, profile?: AttendanceImportMappingProfile | null): string[] {
  const required = Array.isArray(payloadExample.requiredFields)
    ? payloadExample.requiredFields
    : []
  const profileRequired = Array.isArray(profile?.requiredFields)
    ? profile?.requiredFields
    : []
  return Array.from(new Set([
    ...required,
    ...profileRequired,
  ].map(item => String(item).trim()).filter(Boolean)))
}

function extractMappingSource(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!value || typeof value !== 'object') return String(value ?? '').trim()

  const node = value as Record<string, unknown>
  const candidate = (
    node.header
    ?? node.sourceField
    ?? node.source
    ?? node.name
    ?? node.field
    ?? node.key
    ?? node.label
    ?? node.value
  )
  if (typeof candidate === 'string') return candidate.trim()
  if (Array.isArray(candidate)) return candidate.map(item => String(item).trim()).filter(Boolean).join(', ')
  return JSON.stringify(value)
}

function buildAttendanceImportTemplateGuide(
  payloadExample: Record<string, any>,
  profile?: AttendanceImportMappingProfile | null,
): AttendanceImportTemplateGuide | null {
  if (!payloadExample || typeof payloadExample !== 'object') return null
  if (Object.keys(payloadExample).length === 0) return null

  const columns = extractTemplateColumns(payloadExample.columns)
  const requiredFields = extractRequiredFields(payloadExample, profile)
  const sampleHeader = columns.length > 0
    ? columns.join(',')
    : requiredFields.join(',')
  const fieldOrder = [
    ...ATTENDANCE_IMPORT_FIELD_ORDER,
    ...Object.keys(payloadExample).filter(field => !ATTENDANCE_IMPORT_FIELD_ORDER.includes(field)).sort(),
  ]
  const fieldGuides = Array.from(new Set(fieldOrder))
    .filter(field => Object.prototype.hasOwnProperty.call(payloadExample, field))
    .map(field => describeAttendanceImportField(field))

  return {
    source: typeof payloadExample.source === 'string' && payloadExample.source.trim() ? payloadExample.source.trim() : 'attendance',
    mode: payloadExample.mode === 'merge' ? 'merge' : 'override',
    columns,
    requiredFields,
    sampleHeader,
    fieldGuides,
  }
}

function buildAttendanceImportProfileGuide(
  profile: AttendanceImportMappingProfile | null,
): AttendanceImportProfileGuide | null {
  if (!profile) return null
  const mappingEntries = profile.mapping && typeof profile.mapping === 'object' && !Array.isArray(profile.mapping)
    ? Object.entries(profile.mapping).map(([targetField, sourceValue]) => ({
      targetField,
      sourceField: extractMappingSource(sourceValue),
      ...describeAttendanceImportField(targetField),
    }))
    : []

  return {
    name: profile.name,
    description: profile.description,
    requiredFields: Array.isArray(profile.requiredFields)
      ? Array.from(new Set(profile.requiredFields.map(item => String(item).trim()).filter(Boolean)))
      : [],
    mappingEntries,
    userMapKeyField: profile.userMapKeyField,
    userMapSourceFields: profile.userMapSourceFields,
  }
}

function buildAttendanceImportTemplateCsv(guide: AttendanceImportTemplateGuide): string {
  const columns = guide.columns.length > 0
    ? guide.columns
    : guide.sampleHeader
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)

  if (columns.length === 0) return ''

  const header = columns.map(escapeCsvCell).join(',')
  const blankRow = columns.map(() => '').join(',')
  return `${header}\n${blankRow}\n`
}

export function useAttendanceAdminImportWorkflow({
  tr,
  defaultTimezone,
  adminForbidden,
  importLoading: importLoadingRef,
  apiFetch = baseApiFetch,
  getOrgId = () => undefined,
  getUserId = () => undefined,
  setStatus,
  setStatusFromError,
  loadRecords = async () => undefined,
  loadImportBatches = async () => undefined,
  createApiError = defaultCreateAttendanceImportApiError,
  readImportDebugOptions = readAttendanceImportDebugOptions,
  readFileText = defaultReadFileText,
  sleep = defaultSleep,
  downloadText = defaultDownloadText,
  now = () => Date.now(),
  thresholds: thresholdOverrides,
}: UseAttendanceAdminImportWorkflowOptions) {
  const adminForbiddenRef = adminForbidden ?? ref(false)
  const importLoading = importLoadingRef ?? ref(false)
  const importThresholds = resolveAttendanceImportThresholds(thresholdOverrides)
  const importDebugOptions = readImportDebugOptions()
  const importAsyncPollIntervalMs = importDebugOptions.pollIntervalMs ?? IMPORT_ASYNC_DEFAULT_POLL_INTERVAL_MS
  const importAsyncPollTimeoutMs = importDebugOptions.pollTimeoutMs ?? IMPORT_ASYNC_DEFAULT_POLL_TIMEOUT_MS
  let importDebugTimeoutPending = importDebugOptions.forceTimeoutOnce

  const importForm = reactive<AttendanceImportFormState>({
    ruleSetId: '',
    userId: '',
    timezone: defaultTimezone,
    payload: '{}',
  })
  const importProfileId = ref('')
  const importMode = ref<AttendanceImportMode>('override')
  const importMappingProfiles = ref<AttendanceImportMappingProfile[]>([])
  const importCsvFile = ref<File | null>(null)
  const importCsvFileName = ref('')
  const importCsvFileId = ref('')
  const importCsvFileRowCountHint = ref<number | null>(null)
  const importCsvFileExpiresAt = ref('')
  const importCsvHeaderRow = ref('')
  const importCsvDelimiter = ref(',')
  const importUserMapFile = ref<File | null>(null)
  const importUserMapFileName = ref('')
  const importUserMap = ref<Record<string, any> | null>(null)
  const importUserMapError = ref('')
  const importUserMapKeyField = ref('')
  const importUserMapSourceFields = ref('')
  const importGroupAutoCreate = ref(false)
  const importGroupAutoAssign = ref(false)
  const importGroupRuleSetId = ref('')
  const importGroupTimezone = ref('')
  const importCommitToken = ref('')
  const importCommitTokenExpiresAt = ref('')
  const importPreview = ref<AttendanceImportPreviewItem[]>([])
  const importCsvWarnings = ref<string[]>([])
  const importPreviewTask = ref<AttendanceImportPreviewTask | null>(null)
  const importAsyncJob = ref<AttendanceImportJob | null>(null)
  const importAsyncPolling = ref(false)
  const importTimezoneStatusLabel = computed(() => formatTimezoneStatusLabel(importForm.timezone))
  const importGroupTimezoneFallbackOptionLabel = computed(() => tr(
    `Use import timezone (${importTimezoneStatusLabel.value || '--'})`,
    `沿用导入时区（${importTimezoneStatusLabel.value || '--'}）`,
  ))
  const importGroupTimezoneStatusLabel = computed(() => {
    const timezone = importGroupTimezone.value.trim()
    if (timezone) return formatTimezoneStatusLabel(timezone)
    return importGroupTimezoneFallbackOptionLabel.value
  })
  const importPreviewTimezoneHint = computed(() => (
    `${tr('Preview timezone', '预览时区')}: ${importTimezoneStatusLabel.value || '--'} · ${tr('Group timezone', '分组时区')}: ${importGroupTimezoneStatusLabel.value}`
  ))

  const selectedImportProfile = computed(() => {
    if (!importProfileId.value) return null
    return importMappingProfiles.value.find(profile => profile.id === importProfileId.value) ?? null
  })

  const importUserMapCount = computed(() => {
    if (!importUserMap.value) return 0
    if (Array.isArray(importUserMap.value)) return importUserMap.value.length
    return Object.keys(importUserMap.value).length
  })

  const importScalabilityHint = computed(() => {
    const previewChunk = importThresholds.previewChunkThreshold.toLocaleString()
    const previewChunkSize = importThresholds.previewChunkSize.toLocaleString()
    const previewAsync = importThresholds.previewAsyncThreshold.toLocaleString()
    const commitAsync = importThresholds.commitAsyncThreshold.toLocaleString()
    return `Auto mode: preview >= ${previewChunk} rows may use chunked preview (${previewChunkSize}/chunk); preview >= ${previewAsync} rows queues async preview; import >= ${commitAsync} rows queues async import.`
  })

  const importTemplateGuide = computed(() => {
    const payloadExample = parseAttendanceImportJsonConfig(importForm.payload)
    if (!payloadExample) return null
    return buildAttendanceImportTemplateGuide(payloadExample, selectedImportProfile.value)
  })

  const importPayloadRowCountHint = computed(() => {
    const payload = buildImportPayload()
    if (!payload) return null
    return estimateImportRowCount(payload)
  })

  const importPreviewLane = computed<AttendanceImportPreviewLane>(() => {
    const payload = buildImportPayload()
    if (!payload) return 'sync'
    return resolvePreviewLane(payload, importPayloadRowCountHint.value, importThresholds)
  })

  const importCommitLane = computed<AttendanceImportCommitLane>(() => {
    return resolveCommitLane(importPayloadRowCountHint.value, importThresholds)
  })

  const importPreviewLaneHint = computed(() => {
    const rows = importPayloadRowCountHint.value
    if (rows === null) {
      return tr(
        'Preview lane will update after row count can be estimated.',
        '拿到预计行数后会更新预览路径说明。',
      )
    }
    if (importPreviewLane.value === 'async') {
      return tr(
        `Preview will queue an async job because ${rows} rows meet the async threshold (${importThresholds.previewAsyncThreshold}).`,
        `预览会进入异步任务，因为 ${rows} 行已达到异步阈值（${importThresholds.previewAsyncThreshold}）。`,
      )
    }
    if (importPreviewLane.value === 'chunked') {
      const chunkCount = Math.max(1, Math.ceil(rows / importThresholds.previewChunkSize))
      return tr(
        `Preview will split into about ${chunkCount} chunks because ${rows} rows exceed the chunk threshold (${importThresholds.previewChunkThreshold}).`,
        `预览会拆成约 ${chunkCount} 个分块，因为 ${rows} 行已超过分块阈值（${importThresholds.previewChunkThreshold}）。`,
      )
    }
    return tr(
      `Preview will stay in one request because ${rows} rows are below the chunk threshold (${importThresholds.previewChunkThreshold}).`,
      `预览会保持单次请求，因为 ${rows} 行低于分块阈值（${importThresholds.previewChunkThreshold}）。`,
    )
  })

  const importCommitLaneHint = computed(() => {
    const rows = importPayloadRowCountHint.value
    if (rows === null) {
      return tr(
        'Import lane will update after row count can be estimated.',
        '拿到预计行数后会更新导入路径说明。',
      )
    }
    if (importCommitLane.value === 'async') {
      return tr(
        `Import will queue an async job because ${rows} rows meet the async threshold (${importThresholds.commitAsyncThreshold}).`,
        `导入会进入异步任务，因为 ${rows} 行已达到异步阈值（${importThresholds.commitAsyncThreshold}）。`,
      )
    }
    return tr(
      `Import will stay synchronous because ${rows} rows are below the async threshold (${importThresholds.commitAsyncThreshold}).`,
      `导入会保持同步，因为 ${rows} 行低于异步阈值（${importThresholds.commitAsyncThreshold}）。`,
    )
  })

  const selectedImportProfileGuide = computed(() => buildAttendanceImportProfileGuide(selectedImportProfile.value))

  const importAsyncJobTelemetryText = computed(() => {
    const job = importAsyncJob.value
    if (!job) return ''

    const parts: string[] = []
    const engine = String(job.engine || '').trim()
    const total = toNonNegativeNumber(job.total)
    const hasInlineProgress = total !== null && total > 0
    const processed = toNonNegativeNumber(
      job.processedRows ?? (hasInlineProgress ? null : job.progress),
    )
    const failed = toNonNegativeNumber(job.failedRows)
    const elapsedMs = toNonNegativeNumber(job.elapsedMs)
    const progressPercent = toNonNegativeNumber(job.progressPercent)
    const throughputRowsPerSec = toNonNegativeNumber(job.throughputRowsPerSec)

    if (engine) parts.push(`Engine: ${engine}`)
    if (processed !== null) {
      if (total !== null && total > 0) {
        parts.push(`Processed: ${processed}/${total}`)
      } else {
        parts.push(`Processed: ${processed}`)
      }
    }
    if (failed !== null) parts.push(`Failed: ${failed}`)
    if (elapsedMs !== null) parts.push(`Elapsed: ${Math.round(elapsedMs)} ms`)
    if (!hasInlineProgress && progressPercent !== null) parts.push(`Progress: ${Math.round(progressPercent)}%`)
    if (throughputRowsPerSec !== null) parts.push(`Throughput: ${throughputRowsPerSec.toFixed(2)} rows/s`)

    return parts.join(' · ')
  })

  function reportStatus(
    message: string,
    kind: ImportStatusKind = 'info',
    meta?: AttendanceImportStatusMeta,
  ) {
    setStatus?.(message, kind, meta)
  }

  function withImportTimezoneHint(
    context: AttendanceImportStatusContext,
    meta: AttendanceImportStatusMeta = {},
  ): AttendanceImportStatusMeta {
    const hint = [meta.hint, importPreviewTimezoneHint.value]
      .map(value => typeof value === 'string' ? value.trim() : '')
      .filter(Boolean)
      .join(' ')
    return {
      ...meta,
      context,
      hint,
    }
  }

  function reportError(
    error: unknown,
    fallbackMessage: string,
    context: AttendanceImportStatusContext,
  ) {
    if (setStatusFromError) {
      setStatusFromError(error, fallbackMessage, context)
      return
    }
    const message = error instanceof Error && error.message ? error.message : fallbackMessage
    reportStatus(message, 'error', { context, sticky: true })
  }

  function normalizedOrgId(): string | undefined {
    return normalizeIdentifier(getOrgId())
  }

  function normalizedUserId(): string | undefined {
    return normalizeIdentifier(getUserId())
  }

  function resolveImportUserMapKeyField(): string {
    return importUserMapKeyField.value.trim()
  }

  function resolveImportUserMapSourceFields(): string[] {
    return splitListInput(importUserMapSourceFields.value)
  }

  function buildImportGroupSyncPayload(): Record<string, unknown> | null {
    const groupSync: Record<string, unknown> = {}
    if (importGroupAutoCreate.value) groupSync.autoCreate = true
    if (importGroupAutoAssign.value) groupSync.autoAssignMembers = true

    const ruleSetId = importGroupRuleSetId.value.trim()
    if (ruleSetId) groupSync.ruleSetId = ruleSetId

    const timezone = importGroupTimezone.value.trim()
    if (timezone) groupSync.timezone = timezone

    return Object.keys(groupSync).length > 0 ? groupSync : null
  }

  function syncImportControlsFromPayload(payload: Record<string, any>) {
    importMode.value = payload.mode === 'merge' ? 'merge' : 'override'
    importUserMap.value = payload.userMap && typeof payload.userMap === 'object' && !Array.isArray(payload.userMap)
      ? payload.userMap as Record<string, any>
      : null
    importUserMapError.value = ''
    importUserMapKeyField.value = normalizeIdentifier(payload.userMapKeyField) ?? ''
    importUserMapSourceFields.value = normalizeStringList(payload.userMapSourceFields).join(', ')

    const groupSync = normalizeImportGroupSyncConfig(payload.groupSync)
    importGroupAutoCreate.value = groupSync?.autoCreate ?? false
    importGroupAutoAssign.value = groupSync?.autoAssignMembers ?? false
    importGroupRuleSetId.value = groupSync?.ruleSetId ?? ''
    importGroupTimezone.value = groupSync?.timezone ?? ''
  }

  function buildImportPayload(): Record<string, any> | null {
    const parsed = parseAttendanceImportJsonConfig(importForm.payload)
    if (!parsed) return null
    const payload = { ...parsed }
    const resolvedOrgId = normalizedOrgId()
    const resolvedUserId = importForm.userId.trim() || normalizedUserId()
    if (resolvedOrgId && !payload.orgId) payload.orgId = resolvedOrgId
    if (resolvedUserId && !payload.userId) payload.userId = resolvedUserId
    const uuidLike = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    if (importForm.ruleSetId) {
      payload.ruleSetId = importForm.ruleSetId
    } else if (typeof payload.ruleSetId === 'string') {
      const trimmed = payload.ruleSetId.trim()
      if (trimmed && !uuidLike(trimmed)) delete payload.ruleSetId
    }
    if (importForm.timezone && !payload.timezone) payload.timezone = importForm.timezone
    const userMapKeyField = resolveImportUserMapKeyField()
    const userMapSourceFields = resolveImportUserMapSourceFields()
    if (importUserMap.value) {
      payload.userMap = importUserMap.value
    } else {
      delete payload.userMap
    }
    if (userMapKeyField) {
      payload.userMapKeyField = userMapKeyField
    } else {
      delete payload.userMapKeyField
    }
    if (userMapSourceFields.length) {
      payload.userMapSourceFields = userMapSourceFields
    } else {
      delete payload.userMapSourceFields
    }
    const groupSync = buildImportGroupSyncPayload()
    if (groupSync) {
      payload.groupSync = groupSync
    } else {
      delete payload.groupSync
    }
    payload.mode = importMode.value || payload.mode || 'override'
    if (payload.mappingProfileId === '') delete payload.mappingProfileId
    return payload
  }

  function syncImportModeToPayload() {
    const base = parseAttendanceImportJsonConfig(importForm.payload)
    if (!base) return
    const current = typeof base.mode === 'string' ? String(base.mode) : ''
    if (current === importMode.value) return
    importForm.payload = JSON.stringify({ ...base, mode: importMode.value }, null, 2)
  }

  function estimateImportRowCount(payload: Record<string, any>): number | null {
    if (importDebugOptions.forceAsyncImport) {
      return importThresholds.previewAsyncThreshold
    }
    if (typeof payload.csvFileId === 'string' && payload.csvFileId.trim().length > 0) {
      const id = payload.csvFileId.trim()
      if (importCsvFileId.value && id === importCsvFileId.value && importCsvFileRowCountHint.value) {
        return importCsvFileRowCountHint.value
      }
      return importThresholds.previewAsyncThreshold
    }
    if (Array.isArray(payload.rows)) return payload.rows.length
    if (Array.isArray(payload.entries)) return payload.entries.length
    if (typeof payload.csvText === 'string') {
      const records = splitCsvRecords(payload.csvText)
      if (records.length === 0) return 0
      const headerRowIndex = Number((payload.csvOptions as Record<string, unknown> | undefined)?.headerRowIndex)
      const headerOffset = Number.isFinite(headerRowIndex) && headerRowIndex >= 0
        ? Math.trunc(headerRowIndex) + 1
        : 1
      return Math.max(0, records.length - headerOffset)
    }
    return null
  }

  function applyImportScalabilityHints(
    payload: Record<string, any>,
    options: { mode: 'preview' | 'commit' },
  ) {
    const rowCountHint = estimateImportRowCount(payload)
    if (!rowCountHint || rowCountHint <= importThresholds.largeRow) return

    if (options.mode === 'preview') {
      if (payload.previewLimit === undefined || payload.previewLimit === null) {
        payload.previewLimit = importThresholds.previewLimit
      }
      return
    }

    if (payload.returnItems === undefined || payload.returnItems === null) {
      payload.returnItems = false
    }
    if (payload.itemsLimit === undefined || payload.itemsLimit === null) {
      payload.itemsLimit = importThresholds.commitItemsLimit
    }
  }

  function buildChunkedImportPreviewPlan(payload: Record<string, any>): ImportPreviewChunkPlan | null {
    const chunkThreshold = importThresholds.previewChunkThreshold
    const chunkSize = importThresholds.previewChunkSize
    const sampleCap = importThresholds.previewLimit
    const sampleLimit = normalizePreviewSampleLimit(payload.previewLimit, importThresholds.previewLimit)

    if (Array.isArray(payload.rows) && payload.rows.length >= chunkThreshold) {
      const totalRows = payload.rows.length
      const chunkCount = Math.ceil(totalRows / chunkSize)
      return {
        totalRows,
        chunkCount,
        sampleLimit,
        buildPayload: (chunkIndex, remainingSample) => {
          const start = chunkIndex * chunkSize
          const end = Math.min(totalRows, start + chunkSize)
          return {
            ...payload,
            rows: payload.rows.slice(start, end),
            previewLimit: Math.max(1, Math.min(remainingSample, sampleCap)),
          }
        },
      }
    }

    if (Array.isArray(payload.entries) && payload.entries.length >= chunkThreshold) {
      const totalRows = payload.entries.length
      const chunkCount = Math.ceil(totalRows / chunkSize)
      return {
        totalRows,
        chunkCount,
        sampleLimit,
        buildPayload: (chunkIndex, remainingSample) => {
          const start = chunkIndex * chunkSize
          const end = Math.min(totalRows, start + chunkSize)
          return {
            ...payload,
            entries: payload.entries.slice(start, end),
            previewLimit: Math.max(1, Math.min(remainingSample, sampleCap)),
          }
        },
      }
    }

    if (typeof payload.csvText === 'string' && payload.csvText.length > 0) {
      const records = splitCsvRecords(payload.csvText)
      if (records.length <= 1) return null
      const header = records[0]
      const dataRows = records.slice(1)
      const totalRows = dataRows.length
      if (totalRows < chunkThreshold) return null
      const chunkCount = Math.ceil(totalRows / chunkSize)

      return {
        totalRows,
        chunkCount,
        sampleLimit,
        buildPayload: (chunkIndex, remainingSample) => {
          const start = chunkIndex * chunkSize
          const end = Math.min(totalRows, start + chunkSize)
          const csvText = [header, ...dataRows.slice(start, end)].join('\n')
          const nextPayload: Record<string, any> = {
            ...payload,
            csvText,
            previewLimit: Math.max(1, Math.min(remainingSample, sampleCap)),
          }
          delete nextPayload.rows
          delete nextPayload.entries
          return nextPayload
        },
      }
    }

    return null
  }

  function setImportCsvFile(file: File | null) {
    importCsvFile.value = file
    importCsvFileName.value = file?.name ?? ''
    importCsvFileId.value = ''
    importCsvFileRowCountHint.value = null
    importCsvFileExpiresAt.value = ''
  }

  function handleImportCsvChange(event: Event) {
    setImportCsvFile(extractFileFromEvent(event))
  }

  async function loadImportUserMapFile(file: File | null) {
    importUserMapFile.value = file
    importUserMapFileName.value = file?.name ?? ''
    importUserMapError.value = ''
    if (!file) {
      importUserMap.value = null
      return
    }

    try {
      const text = await readFileText(file)
      const parsed = JSON.parse(text)
      const keyField = resolveImportUserMapKeyField()
      const normalized = normalizeAttendanceImportUserMapPayload(parsed, keyField)
      if (!normalized) {
        throw new Error(tr(
          'User map JSON format not recognized. Provide mapping object or array with key field.',
          '无法识别用户映射 JSON 格式。请提供映射对象或包含关键字段的数组。'
        ))
      }
      importUserMap.value = normalized
      reportStatus(tr(
        `User map loaded (${Object.keys(normalized).length} entries).`,
        `用户映射已加载（${Object.keys(normalized).length} 条）。`
      ))
    } catch (error) {
      importUserMap.value = null
      importUserMapError.value = (error as Error).message || tr('Failed to parse user map JSON', '解析用户映射 JSON 失败')
      reportStatus(importUserMapError.value, 'error')
    }
  }

  async function handleImportUserMapChange(event: Event) {
    await loadImportUserMapFile(extractFileFromEvent(event))
  }

  async function loadImportTemplate() {
    clearImportPreviewTask()
    importLoading.value = true
    try {
      const response = await apiFetch('/api/attendance/import/template')
      const data = await response.json()
      if (!response.ok || !data.ok) {
        throw new Error(data?.error?.message || tr('Failed to load import template', '加载导入模板失败'))
      }
      const payloadExample = (data.data?.payloadExample ?? {}) as Record<string, any>
      importMode.value = payloadExample?.mode === 'merge' ? 'merge' : 'override'
      importForm.payload = JSON.stringify(payloadExample, null, 2)
      syncImportControlsFromPayload(payloadExample)
      importMappingProfiles.value = Array.isArray(data.data?.mappingProfiles) ? data.data.mappingProfiles : []
      reportStatus(tr('Import template loaded.', '导入模板已加载。'))
    } catch (error) {
      reportStatus((error as Error).message || tr('Failed to load import template', '加载导入模板失败'), 'error')
    } finally {
      importLoading.value = false
    }
  }

  async function downloadImportTemplateCsv() {
    const profileId = importProfileId.value.trim()
    const query = new URLSearchParams()
    if (profileId) query.set('profileId', profileId)
    const endpoint = query.size > 0
      ? `/api/attendance/import/template.csv?${query.toString()}`
      : '/api/attendance/import/template.csv'
    let fallbackError = ''

    try {
      const response = await apiFetch(endpoint, {
        headers: {
          Accept: 'text/csv',
        },
      })

      if (response.ok) {
        const csvText = await response.text()
        if (csvText.trim()) {
          const source = normalizeIdentifier(selectedImportProfile.value?.source ?? importTemplateGuide.value?.source ?? 'attendance') ?? 'attendance'
          downloadText(`attendance-import-template-${source}.csv`, csvText, 'text/csv;charset=utf-8')
          reportStatus(tr('CSV template downloaded.', 'CSV 模板已下载。'))
          return
        }
      } else if (response.status !== 404 && response.status !== 405) {
        let message = ''
        try {
          const data = await response.json()
          message = data?.error?.message || ''
        } catch {
          message = await response.text().catch(() => '')
        }
        throw new Error(message || tr('Failed to download CSV template', '下载 CSV 模板失败'))
      }
    } catch (error) {
      fallbackError = (error as Error).message || ''
    }

    let guide = importTemplateGuide.value
    if (!guide) {
      await loadImportTemplate()
      const payloadExample = parseAttendanceImportJsonConfig(importForm.payload)
      guide = payloadExample
        ? buildAttendanceImportTemplateGuide(payloadExample, selectedImportProfile.value)
        : null
    }
    if (!guide) {
      reportStatus(
        fallbackError || tr('Load the import template first.', '请先加载导入模板。'),
        'error',
      )
      return
    }

    const csvText = buildAttendanceImportTemplateCsv(guide)
    if (!csvText) {
      reportStatus(tr('The current template has no CSV columns to download.', '当前模板没有可下载的 CSV 列。'), 'error')
      return
    }

    const source = normalizeIdentifier(guide.source) ?? 'attendance'
    downloadText(`attendance-import-template-${source}.csv`, csvText, 'text/csv;charset=utf-8')
    reportStatus(tr('CSV template downloaded.', 'CSV 模板已下载。'))
  }

  function applyImportProfile() {
    const profile = selectedImportProfile.value
    if (!profile) {
      reportStatus(tr('Select an import mapping profile first.', '请先选择导入映射配置。'), 'error')
      return
    }
    const base = parseAttendanceImportJsonConfig(importForm.payload)
    if (!base) {
      reportStatus(tr('Import payload must be valid JSON before applying profile.', '应用配置前，导入载荷必须是合法 JSON。'), 'error')
      return
    }

    let next = { ...base }
    if (profile.payloadExample && Object.keys(base).length === 0) {
      next = { ...profile.payloadExample }
    } else {
      if (profile.source) next.source = profile.source
      if (profile.mapping) next.mapping = profile.mapping
      if (profile.userMapKeyField) next.userMapKeyField = profile.userMapKeyField
      if (profile.userMapSourceFields) next.userMapSourceFields = profile.userMapSourceFields
    }
    next.mappingProfileId = profile.id
    next.mode = importMode.value || next.mode || 'override'
    importForm.payload = JSON.stringify(next, null, 2)
    syncImportControlsFromPayload(next)
    reportStatus(tr(`Applied mapping profile: ${profile.name}`, `已应用映射配置：${profile.name}`))
  }

  async function uploadImportCsvFile(file: File): Promise<{
    fileId: string
    rowCount: number
    bytes: number
    expiresAt: string
  }> {
    const query = new URLSearchParams()
    const resolvedOrgId = normalizedOrgId()
    if (resolvedOrgId) query.set('orgId', resolvedOrgId)
    if (file?.name) query.set('filename', file.name)

    const response = await apiFetch(`/api/attendance/import/upload?${query.toString()}`, {
      method: 'POST',
      body: file as unknown as BodyInit,
      headers: {
        'Content-Type': file?.type && file.type.toLowerCase().includes('csv') ? file.type : 'text/csv',
      },
    })

    const data = await response.json().catch(() => ({} as any))
    if (!response.ok || !data?.ok) {
      throw new Error(data?.error?.message || tr(
        `Failed to upload CSV (HTTP ${response.status})`,
        `上传 CSV 失败（HTTP ${response.status}）`
      ))
    }
    const fileId = String(data.data?.fileId || '')
    if (!fileId) throw new Error(tr('Upload did not return fileId', '上传接口未返回 fileId'))
    const rowCount = Number(data.data?.rowCount ?? 0)
    const bytes = Number(data.data?.bytes ?? 0)
    const expiresAt = String(data.data?.expiresAt ?? '')
    return { fileId, rowCount, bytes, expiresAt }
  }

  async function applyImportCsvFile() {
    if (!importCsvFile.value) {
      reportStatus(
        tr('Select a CSV file first.', '请先选择 CSV 文件。'),
        'error',
        {
          context: 'import-preview',
          hint: tr('Choose a CSV file, then retry preview/import.', '选择 CSV 文件后，再重试预览或导入。'),
          action: 'retry-preview-import',
        },
      )
      return
    }

    try {
      const file = importCsvFile.value
      const base = parseAttendanceImportJsonConfig(importForm.payload) ?? {}
      const next: Record<string, any> = {
        ...base,
        source: base.source ?? 'dingtalk_csv',
      }
      const resolvedOrgId = normalizedOrgId()
      if (resolvedOrgId && !next.orgId) next.orgId = resolvedOrgId
      if (importProfileId.value && !next.mappingProfileId) {
        next.mappingProfileId = importProfileId.value
      }
      const csvOptions: Record<string, any> = {}
      if (importCsvHeaderRow.value !== '') {
        const rowIndex = Number(importCsvHeaderRow.value)
        if (Number.isFinite(rowIndex) && rowIndex >= 0) csvOptions.headerRowIndex = rowIndex
      }
      if (importCsvDelimiter.value && importCsvDelimiter.value !== ',') {
        csvOptions.delimiter = importCsvDelimiter.value
      }
      if (Object.keys(csvOptions).length) next.csvOptions = csvOptions

      const shouldUpload = importDebugOptions.forceUploadCsv || file.size >= IMPORT_CSV_UPLOAD_THRESHOLD_BYTES
      if (shouldUpload) {
        const uploaded = await uploadImportCsvFile(file)
        importCsvFileId.value = uploaded.fileId
        importCsvFileRowCountHint.value = Number.isFinite(uploaded.rowCount) && uploaded.rowCount > 0 ? uploaded.rowCount : null
        importCsvFileExpiresAt.value = uploaded.expiresAt
        next.csvFileId = uploaded.fileId
        delete next.csvText
        reportStatus(tr(
          `CSV uploaded: ${importCsvFileName.value || 'file'} (${importCsvFileRowCountHint.value ?? 'unknown'} rows).`,
          `CSV 已上传：${importCsvFileName.value || '文件'}（${importCsvFileRowCountHint.value ?? '未知'} 行）。`
        ))
      } else {
        const csvText = await readFileText(file)
        importCsvFileId.value = ''
        importCsvFileRowCountHint.value = null
        importCsvFileExpiresAt.value = ''
        next.csvText = csvText
        delete next.csvFileId
        reportStatus(tr(`CSV loaded: ${importCsvFileName.value || 'file'}`, `CSV 已加载：${importCsvFileName.value || '文件'}`))
      }

      next.mode = importMode.value || next.mode || 'override'
      importForm.payload = JSON.stringify(next, null, 2)
      syncImportControlsFromPayload(next)
    } catch (error) {
      reportError(error, tr('Failed to load CSV', '加载 CSV 失败'), 'import-preview')
    }
  }

  function isImportCommitTokenValid(): boolean {
    if (!importCommitToken.value) return false
    if (!importCommitTokenExpiresAt.value) return true
    const expiresAt = new Date(importCommitTokenExpiresAt.value).getTime()
    return Number.isFinite(expiresAt) && expiresAt - now() > 60 * 1000
  }

  async function ensureImportCommitToken(options: { forceRefresh?: boolean } = {}): Promise<boolean> {
    if (options.forceRefresh) {
      importCommitToken.value = ''
      importCommitTokenExpiresAt.value = ''
    }
    if (isImportCommitTokenValid()) return true

    try {
      const response = await apiFetch('/api/attendance/import/prepare', { method: 'POST' })
      if (response.status === 404) {
        importCommitToken.value = ''
        importCommitTokenExpiresAt.value = ''
        return true
      }
      const data = await response.json()
      if (!response.ok || !data.ok) {
        throw new Error(data?.error?.message || tr('Failed to prepare import token', '准备导入令牌失败'))
      }
      importCommitToken.value = data.data?.commitToken ?? ''
      importCommitTokenExpiresAt.value = data.data?.expiresAt ?? ''
      return Boolean(importCommitToken.value)
    } catch (error) {
      reportStatus((error as Error).message || tr('Failed to prepare import token', '准备导入令牌失败'), 'error')
      return false
    }
  }

  let importPreviewTaskSeq = 0

  function clearImportPreviewTask() {
    importPreviewTaskSeq += 1
    importPreviewTask.value = null
  }

  async function runChunkedImportPreview(
    payload: Record<string, any>,
    plan: ImportPreviewChunkPlan,
  ): Promise<void> {
    const seq = ++importPreviewTaskSeq
    importPreviewTask.value = {
      mode: 'chunked',
      status: 'running',
      totalRows: plan.totalRows,
      processedRows: 0,
      totalChunks: plan.chunkCount,
      completedChunks: 0,
      message: null,
    }

    const aggregatedItems: AttendanceImportPreviewItem[] = []
    let totalRowCount = 0
    let invalidCount = 0
    let duplicateCount = 0
    const warningSet = new Set<string>()

    for (let chunkIndex = 0; chunkIndex < plan.chunkCount; chunkIndex += 1) {
      if (seq !== importPreviewTaskSeq) {
        throw new Error(tr('Preview task canceled', '预览任务已取消'))
      }

      const remainingSample = Math.max(1, plan.sampleLimit - aggregatedItems.length)
      const chunkPayload = plan.buildPayload(chunkIndex, remainingSample)
      const tokenOk = await ensureImportCommitToken({ forceRefresh: true })
      if (!tokenOk) throw new Error(tr('Failed to prepare import token', '准备导入令牌失败'))
      if (importCommitToken.value) chunkPayload.commitToken = importCommitToken.value

      const response = await apiFetch('/api/attendance/import/preview', {
        method: 'POST',
        body: JSON.stringify(chunkPayload),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error?.message || tr(
          `Failed to preview chunk ${chunkIndex + 1}/${plan.chunkCount}`,
          `预览分片 ${chunkIndex + 1}/${plan.chunkCount} 失败`
        ))
      }

      const chunkItems = Array.isArray(data.data?.items) ? data.data.items as AttendanceImportPreviewItem[] : []
      const rowCount = Number(data.data?.rowCount)
      const stats = data.data?.stats && typeof data.data.stats === 'object' ? data.data.stats : null
      const chunkWarnings = [
        ...(Array.isArray(data.data?.csvWarnings) ? data.data.csvWarnings : []),
        ...(Array.isArray(data.data?.groupWarnings) ? data.data.groupWarnings : []),
      ]

      totalRowCount += Number.isFinite(rowCount) ? rowCount : 0
      if (stats && Number.isFinite(Number((stats as any).invalid))) {
        invalidCount += Number((stats as any).invalid)
      }
      if (stats && Number.isFinite(Number((stats as any).duplicates))) {
        duplicateCount += Number((stats as any).duplicates)
      }

      for (const warning of chunkWarnings) {
        warningSet.add(String(warning))
      }

      if (aggregatedItems.length < plan.sampleLimit && chunkItems.length > 0) {
        const remains = plan.sampleLimit - aggregatedItems.length
        aggregatedItems.push(...chunkItems.slice(0, remains))
      }

      importCommitToken.value = ''
      importCommitTokenExpiresAt.value = ''

      if (importPreviewTask.value && seq === importPreviewTaskSeq) {
        importPreviewTask.value = {
          ...importPreviewTask.value,
          processedRows: Math.min(plan.totalRows, (chunkIndex + 1) * importThresholds.previewChunkSize),
          completedChunks: chunkIndex + 1,
        }
      }
    }

    if (seq !== importPreviewTaskSeq) {
      throw new Error(tr('Preview task canceled', '预览任务已取消'))
    }

    importPreview.value = aggregatedItems
    importCsvWarnings.value = Array.from(warningSet)
    const shown = aggregatedItems.length
    const message = tr(
      `Preview loaded (chunked ${plan.chunkCount} chunks, showing ${shown}/${totalRowCount} rows).`,
      `预览已加载（分片 ${plan.chunkCount} 个，显示 ${shown}/${totalRowCount} 行）。`
    )
    const suffix = invalidCount || duplicateCount
      ? tr(` Invalid: ${invalidCount}. Duplicates: ${duplicateCount}.`, ` 无效：${invalidCount}。重复：${duplicateCount}。`)
      : ''
    reportStatus(`${message}${suffix}`, 'info', withImportTimezoneHint('import-preview'))

    importPreviewTask.value = {
      mode: 'chunked',
      status: 'completed',
      totalRows: plan.totalRows,
      processedRows: plan.totalRows,
      totalChunks: plan.chunkCount,
      completedChunks: plan.chunkCount,
      message: tr(`Completed in ${plan.chunkCount} chunk(s).`, `已完成，共 ${plan.chunkCount} 个分片。`),
    }
  }

  let importJobPollSeq = 0

  async function fetchImportJob(jobId: string): Promise<AttendanceImportJob> {
    const response = await apiFetch(`/api/attendance/import/jobs/${encodeURIComponent(jobId)}`)
    const data = await response.json().catch(() => ({}))
    if (!response.ok || !data.ok) {
      throw createApiError(response, data, tr('Failed to load import job', '加载导入任务失败'))
    }
    return (data.data ?? data) as AttendanceImportJob
  }

  function createImportJobStateError(code: string, message: string): AttendanceApiError {
    const error = new Error(message) as AttendanceApiError
    error.code = code
    return error
  }

  async function pollImportJob(jobId: string): Promise<AttendanceImportJob> {
    const seq = ++importJobPollSeq
    importAsyncPolling.value = true
    const startedAt = now()
    try {
      while (seq === importJobPollSeq) {
        if (importDebugTimeoutPending) {
          importDebugTimeoutPending = false
          throw createImportJobStateError('IMPORT_JOB_TIMEOUT', tr('Import job timed out', '导入任务超时'))
        }
        const job = await fetchImportJob(jobId)
        importAsyncJob.value = job
        if (job.status === 'completed') return job
        if (job.status === 'failed') {
          throw createImportJobStateError('IMPORT_JOB_FAILED', job.error || tr('Import job failed', '导入任务失败'))
        }
        if (job.status === 'canceled') {
          throw createImportJobStateError('IMPORT_JOB_CANCELED', tr('Import job canceled', '导入任务已取消'))
        }
        if (now() - startedAt > importAsyncPollTimeoutMs) {
          throw createImportJobStateError('IMPORT_JOB_TIMEOUT', tr('Import job timed out', '导入任务超时'))
        }
        await sleep(importAsyncPollIntervalMs)
      }
      throw createImportJobStateError('IMPORT_JOB_CANCELED', tr('Import job polling canceled', '导入任务轮询已取消'))
    } finally {
      if (seq === importJobPollSeq) importAsyncPolling.value = false
    }
  }

  async function refreshImportAsyncJob(options: { silent?: boolean } = {}) {
    const jobId = String(importAsyncJob.value?.id || '').trim()
    if (!jobId) {
      if (!options.silent) {
        reportStatus(tr('No async import job selected.', '未选择异步导入任务。'), 'error')
      }
      return
    }
    try {
      const job = await fetchImportJob(jobId)
      importAsyncJob.value = job
      if (!options.silent) {
        reportStatus(
          tr(
            `Import job ${jobId.slice(0, 8)} reloaded (${job.status}).`,
            `导入任务 ${jobId.slice(0, 8)} 已重载（${job.status}）。`,
          ),
          'info',
          withImportTimezoneHint('import-run'),
        )
      }
    } catch (error) {
      if (!options.silent) {
        reportError(error, tr('Failed to reload import job', '重载导入任务失败'), 'import-run')
      }
    }
  }

  async function resumeImportAsyncJobPolling() {
    const jobId = String(importAsyncJob.value?.id || '').trim()
    if (!jobId) {
      reportStatus(tr('No async import job selected.', '未选择异步导入任务。'), 'error')
      return
    }
    try {
      const finalJob = await pollImportJob(jobId)
      if (finalJob.kind === 'preview') {
        const previewData = finalJob.preview && typeof finalJob.preview === 'object' ? finalJob.preview : null
        if (previewData) {
          importPreview.value = Array.isArray(previewData.items) ? previewData.items as AttendanceImportPreviewItem[] : []
          const previewWarnings = [
            ...(Array.isArray(previewData.csvWarnings) ? previewData.csvWarnings : []),
            ...(Array.isArray(previewData.groupWarnings) ? previewData.groupWarnings : []),
          ]
          importCsvWarnings.value = Array.from(new Set(previewWarnings))
        }
        reportStatus(
          tr(`Preview job completed (${jobId.slice(0, 8)}).`, `预览任务完成（${jobId.slice(0, 8)}）。`),
          'info',
          withImportTimezoneHint('import-preview'),
        )
        return
      }

      const imported = Number(finalJob.progress ?? 0)
      const total = Number(finalJob.total ?? 0)
      const perfSuffix = buildImportPerfSuffix({
        engine: finalJob.engine,
        recordUpsertStrategy: finalJob.recordUpsertStrategy,
        processedRows: finalJob.processedRows ?? imported,
        failedRows: finalJob.failedRows,
        elapsedMs: finalJob.elapsedMs,
      })
      if (total && imported !== total) {
        reportStatus(
          tr(
            `Imported ${imported}/${total} rows (async job).${perfSuffix.en}`,
            `已导入 ${imported}/${total} 行（异步任务）。${perfSuffix.zh}`,
          ),
          'info',
          withImportTimezoneHint('import-run'),
        )
      } else {
        reportStatus(
          tr(
            `Imported ${imported} rows (async job).${perfSuffix.en}`,
            `已导入 ${imported} 行（异步任务）。${perfSuffix.zh}`,
          ),
          'info',
          withImportTimezoneHint('import-run'),
        )
      }
      await loadRecords()
      await loadImportBatches({ orgId: normalizedOrgId() })
    } catch (error) {
      reportError(error, tr('Failed while polling import job', '轮询导入任务失败'), 'import-run')
    }
  }

  function clearImportAsyncJob() {
    importJobPollSeq += 1
    importAsyncPolling.value = false
    importAsyncJob.value = null
  }

  async function runPreviewImportAsync(payload: Record<string, any>, rowCountHint: number): Promise<boolean> {
    importPreviewTask.value = {
      mode: 'single',
      status: 'running',
      totalRows: rowCountHint,
      processedRows: 0,
      totalChunks: 1,
      completedChunks: 0,
      message: tr('Queued async preview job.', '已排队异步预览任务。'),
    }

    const tokenOk = await ensureImportCommitToken({ forceRefresh: true })
    if (!tokenOk) return true
    if (importCommitToken.value) payload.commitToken = importCommitToken.value

    let asyncResponse = await apiFetch('/api/attendance/import/preview-async', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    let asyncData: any = await asyncResponse.json().catch(() => ({}))
    if (!asyncResponse.ok || !asyncData?.ok) {
      const errorCode = asyncData?.error?.code
      if (asyncResponse.status === 404 || errorCode === 'NOT_FOUND') {
        return false
      }
      if (errorCode === 'COMMIT_TOKEN_INVALID' || errorCode === 'COMMIT_TOKEN_REQUIRED') {
        importCommitToken.value = ''
        importCommitTokenExpiresAt.value = ''
        const refreshed = await ensureImportCommitToken({ forceRefresh: true })
        if (!refreshed || !importCommitToken.value) {
          throw new Error(tr(
            'Failed to refresh import commit token. Check server deployment/migrations.',
            '刷新导入提交令牌失败，请检查服务端部署或迁移。'
          ))
        }
        payload.commitToken = importCommitToken.value
        asyncResponse = await apiFetch('/api/attendance/import/preview-async', {
          method: 'POST',
          body: JSON.stringify(payload),
        })
        asyncData = await asyncResponse.json().catch(() => ({}))
      }
    }

    if (!asyncResponse.ok || !asyncData?.ok) {
      throw createApiError(asyncResponse, asyncData, tr('Failed to queue async preview', '排队异步预览失败'))
    }

    const job = asyncData.data?.job as AttendanceImportJob | undefined
    if (!job?.id) {
      throw new Error(tr('Async preview did not return job id', '异步预览未返回任务 ID'))
    }

    adminForbiddenRef.value = false
    importAsyncJob.value = job
    reportStatus(
      tr(`Preview job queued (${job.status}).`, `预览任务已排队（${job.status}）。`),
      'info',
      withImportTimezoneHint('import-preview'),
    )

    const finalJob = await pollImportJob(job.id)
    const previewData = finalJob.preview && typeof finalJob.preview === 'object' ? finalJob.preview : null
    if (!previewData) {
      throw new Error(tr('Async preview completed without preview payload', '异步预览完成但缺少预览载荷'))
    }

    const items = Array.isArray(previewData.items) ? previewData.items as AttendanceImportPreviewItem[] : []
    importPreview.value = items
    const previewWarnings = [
      ...(Array.isArray(previewData.csvWarnings) ? previewData.csvWarnings : []),
      ...(Array.isArray(previewData.groupWarnings) ? previewData.groupWarnings : []),
    ]
    importCsvWarnings.value = Array.from(new Set(previewWarnings))

    const shown = items.length
    const rowCount = Number(previewData.rowCount)
    const truncated = Boolean(previewData.truncated)
    const stats = previewData.stats && typeof previewData.stats === 'object' ? previewData.stats : null
    const invalidCount = stats && Number.isFinite(Number((stats as any).invalid)) ? Number((stats as any).invalid) : 0
    const dupCount = stats && Number.isFinite(Number((stats as any).duplicates)) ? Number((stats as any).duplicates) : 0
    const baseMsg = truncated && Number.isFinite(rowCount)
      ? tr(`Preview loaded (async, showing ${shown}/${rowCount} rows).`, `预览已加载（异步，显示 ${shown}/${rowCount} 行）。`)
      : tr(`Preview loaded (async ${shown} rows).`, `预览已加载（异步 ${shown} 行）。`)
    const suffix = invalidCount || dupCount
      ? tr(` Invalid: ${invalidCount}. Duplicates: ${dupCount}.`, ` 无效：${invalidCount}。重复：${dupCount}。`)
      : ''
    reportStatus(`${baseMsg}${suffix}`, 'info', withImportTimezoneHint('import-preview'))

    importPreviewTask.value = {
      mode: 'single',
      status: 'completed',
      totalRows: Number.isFinite(rowCount) ? rowCount : shown,
      processedRows: Number.isFinite(rowCount) ? rowCount : shown,
      totalChunks: 1,
      completedChunks: 1,
      message: tr(
        `Completed via async preview job (${job.id.slice(0, 8)}...).`,
        `异步预览任务已完成（${job.id.slice(0, 8)}...）。`
      ),
    }

    importCommitToken.value = ''
    importCommitTokenExpiresAt.value = ''
    return true
  }

  async function previewImport() {
    clearImportPreviewTask()
    clearImportAsyncJob()
    importPreview.value = []
    importCsvWarnings.value = []
    const payload = buildImportPayload()
    if (!payload) {
      reportStatus(
        tr('Invalid JSON payload for import.', '导入载荷 JSON 无效。'),
        'error',
        withImportTimezoneHint('import-preview', {
          hint: tr('Fix JSON syntax in payload and retry preview.', '请修复载荷 JSON 语法后重试预览。'),
          action: 'retry-preview-import',
        }),
      )
      return
    }

    applyImportScalabilityHints(payload, { mode: 'preview' })
    importLoading.value = true
    try {
      const rowCountHint = estimateImportRowCount(payload)
      if (rowCountHint && rowCountHint >= importThresholds.previewAsyncThreshold) {
        const handledByAsync = await runPreviewImportAsync(payload, rowCountHint)
        if (handledByAsync) return
      }

      const chunkPlan = buildChunkedImportPreviewPlan(payload)
      if (chunkPlan) {
        await runChunkedImportPreview(payload, chunkPlan)
        return
      }

      importPreviewTask.value = {
        mode: 'single',
        status: 'running',
        totalRows: estimateImportRowCount(payload) ?? 0,
        processedRows: 0,
        totalChunks: 1,
        completedChunks: 0,
        message: null,
      }

      const tokenOk = await ensureImportCommitToken({ forceRefresh: true })
      if (!tokenOk) {
        if (importPreviewTask.value) {
          importPreviewTask.value = {
            ...importPreviewTask.value,
            status: 'failed',
            message: tr('Failed to prepare import token', '准备导入令牌失败'),
          }
        }
        return
      }
      if (importCommitToken.value) payload.commitToken = importCommitToken.value

      const response = await apiFetch('/api/attendance/import/preview', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      const data = await response.json()
      if (!response.ok || !data.ok) {
        throw createApiError(response, data, tr('Failed to preview import', '预览导入失败'))
      }

      importPreview.value = Array.isArray(data.data?.items) ? data.data.items : []
      const rowCount = Number(data.data?.rowCount)
      const truncated = Boolean(data.data?.truncated)
      const stats = data.data?.stats && typeof data.data.stats === 'object' ? data.data.stats : null
      const previewWarnings = [
        ...(Array.isArray(data.data?.csvWarnings) ? data.data.csvWarnings : []),
        ...(Array.isArray(data.data?.groupWarnings) ? data.data.groupWarnings : []),
      ]
      importCsvWarnings.value = Array.from(new Set(previewWarnings))
      const shown = importPreview.value.length
      const invalidCount = stats && Number.isFinite(Number((stats as any).invalid)) ? Number((stats as any).invalid) : 0
      const dupCount = stats && Number.isFinite(Number((stats as any).duplicates)) ? Number((stats as any).duplicates) : 0
      const baseMsg = truncated && Number.isFinite(rowCount)
        ? tr(`Preview loaded (showing ${shown}/${rowCount} rows).`, `预览已加载（显示 ${shown}/${rowCount} 行）。`)
        : tr(`Preview loaded (${shown} rows).`, `预览已加载（${shown} 行）。`)
      const suffix = invalidCount || dupCount
        ? tr(` Invalid: ${invalidCount}. Duplicates: ${dupCount}.`, ` 无效：${invalidCount}。重复：${dupCount}。`)
        : ''
      reportStatus(`${baseMsg}${suffix}`, 'info', withImportTimezoneHint('import-preview'))
      importPreviewTask.value = {
        mode: 'single',
        status: 'completed',
        totalRows: Number.isFinite(rowCount) ? rowCount : shown,
        processedRows: Number.isFinite(rowCount) ? rowCount : shown,
        totalChunks: 1,
        completedChunks: 1,
        message: null,
      }
      importCommitToken.value = ''
      importCommitTokenExpiresAt.value = ''
    } catch (error) {
      importPreview.value = []
      importCsvWarnings.value = []
      if (importPreviewTask.value) {
        importPreviewTask.value = {
          ...importPreviewTask.value,
          status: 'failed',
          message: (error as Error).message || tr('Preview failed', '预览失败'),
        }
      }
      reportError(error, tr('Failed to preview import', '预览导入失败'), 'import-preview')
    } finally {
      importLoading.value = false
    }
  }

  async function runImport() {
    clearImportPreviewTask()
    const payload = buildImportPayload()
    if (!payload) {
      reportStatus(
        tr('Invalid JSON payload for import.', '导入载荷 JSON 无效。'),
        'error',
        withImportTimezoneHint('import-run', {
          hint: tr('Fix JSON syntax in payload and retry import.', '请修复载荷 JSON 语法后重试导入。'),
          action: 'retry-run-import',
        }),
      )
      return
    }

    applyImportScalabilityHints(payload, { mode: 'commit' })
    importLoading.value = true
    try {
      const tokenOk = await ensureImportCommitToken({ forceRefresh: true })
      if (!tokenOk) return
      if (importCommitToken.value) payload.commitToken = importCommitToken.value

      importAsyncJob.value = null
      const rowCountHint = estimateImportRowCount(payload)
      if (rowCountHint && rowCountHint >= importThresholds.commitAsyncThreshold) {
        let asyncResponse: Response | null = await apiFetch('/api/attendance/import/commit-async', {
          method: 'POST',
          body: JSON.stringify(payload),
        })
        let asyncData: any = await asyncResponse.json().catch(() => ({}))
        if (!asyncResponse.ok || !asyncData.ok) {
          const errorCode = asyncData?.error?.code
          if (asyncResponse.status === 404 || errorCode === 'NOT_FOUND') {
            asyncResponse = null
          } else if (errorCode === 'COMMIT_TOKEN_INVALID' || errorCode === 'COMMIT_TOKEN_REQUIRED') {
            importCommitToken.value = ''
            importCommitTokenExpiresAt.value = ''
            const refreshed = await ensureImportCommitToken({ forceRefresh: true })
            if (!refreshed || !importCommitToken.value) {
              throw new Error(tr(
                'Failed to refresh import commit token. Check server deployment/migrations.',
                '刷新导入提交令牌失败，请检查服务端部署或迁移。'
              ))
            }
            payload.commitToken = importCommitToken.value
            asyncResponse = await apiFetch('/api/attendance/import/commit-async', {
              method: 'POST',
              body: JSON.stringify(payload),
            })
            asyncData = await asyncResponse.json().catch(() => ({}))
          }
        }

        if (asyncResponse && asyncResponse.ok && asyncData?.ok) {
          const job = asyncData.data?.job as AttendanceImportJob | undefined
          if (!job?.id) {
            throw new Error(tr('Async import did not return job id', '异步导入未返回任务 ID'))
          }
          adminForbiddenRef.value = false
          importAsyncJob.value = job
          reportStatus(
            tr(`Import job queued (${job.status}).`, `导入任务已排队（${job.status}）。`),
            'info',
            withImportTimezoneHint('import-run'),
          )

          const finalJob = await pollImportJob(job.id)
          const imported = Number(finalJob.progress ?? 0)
          const total = Number(finalJob.total ?? 0)
          const perfSuffix = buildImportPerfSuffix({
            engine: finalJob.engine,
            recordUpsertStrategy: finalJob.recordUpsertStrategy,
            processedRows: finalJob.processedRows ?? imported,
            failedRows: finalJob.failedRows,
            elapsedMs: finalJob.elapsedMs,
          })
          reportStatus(
            tr(
              `Imported ${imported} rows (async job).${perfSuffix.en}`,
              `已导入 ${imported} 行（异步任务）。${perfSuffix.zh}`,
            ),
            'info',
            withImportTimezoneHint('import-run'),
          )
          if (total && imported !== total) {
            reportStatus(
              tr(
                `Imported ${imported}/${total} rows (async job).${perfSuffix.en}`,
                `已导入 ${imported}/${total} 行（异步任务）。${perfSuffix.zh}`,
              ),
              'info',
              withImportTimezoneHint('import-run'),
            )
          }

          await loadRecords()
          await loadImportBatches({ orgId: normalizedOrgId() })
          importCommitToken.value = ''
          importCommitTokenExpiresAt.value = ''
          return
        }
      }

      const runLegacyImport = async () => {
        const legacyResponse = await apiFetch('/api/attendance/import', {
          method: 'POST',
          body: JSON.stringify(payload),
        })
        const legacyData = await legacyResponse.json().catch(() => ({}))
        return { response: legacyResponse, data: legacyData }
      }

      let response = await apiFetch('/api/attendance/import/commit', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      let data: any = await response.json().catch(() => ({}))
      if (!response.ok || !data.ok) {
        const errorCode = data?.error?.code
        if (response.status === 404 || errorCode === 'NOT_FOUND') {
          const legacy = await runLegacyImport()
          response = legacy.response
          data = legacy.data
        } else if (errorCode === 'COMMIT_TOKEN_INVALID' || errorCode === 'COMMIT_TOKEN_REQUIRED') {
          importCommitToken.value = ''
          importCommitTokenExpiresAt.value = ''
          const refreshed = await ensureImportCommitToken({ forceRefresh: true })
          if (!refreshed || !importCommitToken.value) {
            throw new Error(tr(
              'Failed to refresh import commit token. Check server deployment/migrations.',
              '刷新导入提交令牌失败，请检查服务端部署或迁移。'
            ))
          }
          payload.commitToken = importCommitToken.value
          response = await apiFetch('/api/attendance/import/commit', {
            method: 'POST',
            body: JSON.stringify(payload),
          })
          data = await response.json().catch(() => ({}))
        }
      }

      if (!response.ok || !data.ok) {
        throw createApiError(response, data, tr('Failed to import attendance', '导入考勤失败'))
      }

      adminForbiddenRef.value = false
      const importWarnings = [
        ...(Array.isArray(data.data?.csvWarnings) ? data.data.csvWarnings : []),
        ...(Array.isArray(data.data?.groupWarnings) ? data.data.groupWarnings : []),
      ]
      importCsvWarnings.value = Array.from(new Set(importWarnings))
      const count = Number(data.data?.imported ?? 0)
      const processedRows = toNonNegativeNumber(data.data?.processedRows) ?? count
      const perfSuffix = buildImportPerfSuffix({
        engine: data.data?.engine,
        recordUpsertStrategy: data.data?.recordUpsertStrategy,
        processedRows,
        failedRows: data.data?.failedRows,
        elapsedMs: data.data?.elapsedMs,
      })
      const groupCreated = data.data?.meta?.groupCreated ?? 0
      const groupMembersAdded = data.data?.meta?.groupMembersAdded ?? 0
      if (groupCreated || groupMembersAdded) {
        reportStatus(
          tr(
            `Imported ${count} rows. Groups created: ${groupCreated}. Members added: ${groupMembersAdded}.${perfSuffix.en}`,
            `已导入 ${count} 行。新建分组：${groupCreated}。新增成员：${groupMembersAdded}。${perfSuffix.zh}`,
          ),
          'info',
          withImportTimezoneHint('import-run'),
        )
      } else {
        reportStatus(
          tr(`Imported ${count} rows.${perfSuffix.en}`, `已导入 ${count} 行。${perfSuffix.zh}`),
          'info',
          withImportTimezoneHint('import-run'),
        )
      }
      await loadRecords()
      await loadImportBatches({ orgId: normalizedOrgId() })
      importCommitToken.value = ''
      importCommitTokenExpiresAt.value = ''
    } catch (error) {
      reportError(error, tr('Failed to import attendance', '导入考勤失败'), 'import-run')
    } finally {
      importLoading.value = false
    }
  }

  watch(importProfileId, () => {
    const profile = selectedImportProfile.value
    if (!profile) return
    if (!importUserMapKeyField.value && profile.userMapKeyField) {
      importUserMapKeyField.value = profile.userMapKeyField
    }
    if (!importUserMapSourceFields.value && profile.userMapSourceFields?.length) {
      importUserMapSourceFields.value = profile.userMapSourceFields.join(', ')
    }
  })

  watch(importMode, () => {
    syncImportModeToPayload()
  })

  watch(
    () => importForm.payload,
    (value) => {
      const payload = parseAttendanceImportJsonConfig(value)
      if (!payload) return
      syncImportControlsFromPayload(payload)
    },
    { immediate: true },
  )

  return {
    adminForbidden: adminForbiddenRef,
    importLoading,
    importThresholds,
    importForm,
    importProfileId,
    importMode,
    importMappingProfiles,
    selectedImportProfile,
    importTemplateGuide,
    selectedImportProfileGuide,
    importCsvFile,
    importCsvFileName,
    importCsvFileId,
    importCsvFileRowCountHint,
    importCsvFileExpiresAt,
    importPayloadRowCountHint,
    importPreviewLane,
    importCommitLane,
    importPreviewLaneHint,
    importCommitLaneHint,
    importCsvHeaderRow,
    importCsvDelimiter,
    importUserMapFile,
    importUserMapFileName,
    importUserMap,
    importUserMapError,
    importUserMapKeyField,
    importUserMapSourceFields,
    importGroupAutoCreate,
    importGroupAutoAssign,
    importGroupRuleSetId,
    importGroupTimezone,
    importCommitToken,
    importCommitTokenExpiresAt,
    importPreview,
    importCsvWarnings,
    importPreviewTask,
    importAsyncJob,
    importAsyncPolling,
    importTimezoneStatusLabel,
    importGroupTimezoneFallbackOptionLabel,
    importGroupTimezoneStatusLabel,
    importPreviewTimezoneHint,
    importUserMapCount,
    importScalabilityHint,
    importAsyncJobTelemetryText,
    buildImportPayload,
    syncImportModeToPayload,
    setImportCsvFile,
    handleImportCsvChange,
    loadImportUserMapFile,
    handleImportUserMapChange,
    loadImportTemplate,
    downloadImportTemplateCsv,
    applyImportProfile,
    applyImportCsvFile,
    ensureImportCommitToken,
    clearImportPreviewTask,
    clearImportAsyncJob,
    refreshImportAsyncJob,
    resumeImportAsyncJobPolling,
    previewImport,
    runImport,
  }
}
