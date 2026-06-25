/**
 * MultitableApiClient — typed wrapper for all /api/multitable/* endpoints.
 * Uses apiFetch from project utils; accepts optional fetchFn for tests.
 */
import type {
  MetaBase,
  MetaSheet,
  MetaField,
  MetaView,
  MetaViewData,
  MetaContext,
  MetaRecord,
  MetaRecordContext,
  MetaRecordRevision,
  HistoryBatchSummary,
  HistoryBatchDetail,
  HistoryChange,
  MetaRecordSubscription,
  MetaRecordSubscriptionNotification,
  MetaRecordSubscriptionStatus,
  MetaFormContext,
  PatchResult,
  FormSubmitResult,
  LinkOptionsData,
  RecordSummaryPage,
  CreateBaseInput,
  CreateSheetInput,
  CreateFieldInput,
  MetaPreparedPersonField,
  UpdateFieldInput,
  CreateViewInput,
  UpdateViewInput,
  CreateRecordInput,
  PatchRecordsInput,
  FormSubmitInput,
  MultitableComment,
  MultitableCommentReaction,
  MultitableCommentPresenceSummary,
  CommentMentionSummary,
  CommentMentionSummaryItem,
  MultitableCommentInboxItem,
  MultitableCommentInboxPage,
  MetaCommentsScope,
  MetaAttachment,
  MetaCommentMentionSuggestion,
  MetaSheetPermissionAccessLevel,
  MetaSheetPermissionCandidate,
  MetaSheetPermissionEntry,
  MetaFieldPermissionEntry,
  MetaViewPermissionEntry,
  RecordPermissionEntry,
  AutomationRule,
  AutomationExecution,
  AutomationRunView,
  AutomationStats,
  ChartConfig,
  ChartCreateInput,
  ChartData,
  Dashboard,
  DashboardFilter,
  DashboardUpdateInput,
  FormShareConfig,
  FormShareConfigUpdate,
  InstallTemplateInput,
  InstallTemplateResult,
  TemplateDryRunResult,
  ApiToken,
  ApiTokenCreateResult,
  MetaTemplate,
  Webhook,
  WebhookCreateInput,
  WebhookDelivery,
  DingTalkGroupDestination,
  DingTalkGroupDelivery,
  DingTalkPersonDelivery,
  DingTalkGroupDestinationInput,
  MetaDeletedRecord,
} from '../types'
import { apiFetch } from '../../utils/api'
import { apiDefaultErrorMessage, apiFieldValidationFallback } from '../utils/meta-api-error-labels'
import type { ConditionalRuleDTO } from '../utils/conditional-rule-ops'

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>
type ApiErrorLocaleResolver = () => boolean
type ApiErrorLocaleOption = boolean | ApiErrorLocaleResolver

type ApiErrorPayload = {
  code?: string
  message?: string
  fieldErrors?: Record<string, string>
  serverVersion?: number
}

type ChartConfigWire = Omit<ChartConfig, 'chartType' | 'displayConfig'> & {
  type?: ChartConfig['chartType']
  chartType?: ChartConfig['chartType']
  display?: ChartConfig['displayConfig']
  displayConfig?: ChartConfig['displayConfig']
}

type ChartCreateInputWire = Omit<ChartCreateInput, 'chartType' | 'displayConfig'> & {
  type: ChartCreateInput['chartType']
  display?: ChartCreateInput['displayConfig']
}

type ChartUpdateInputWire = Omit<Partial<ChartCreateInput>, 'chartType' | 'displayConfig'> & {
  type?: ChartCreateInput['chartType']
  display?: ChartCreateInput['displayConfig']
}

let globalApiErrorLocaleResolver: ApiErrorLocaleResolver | undefined

export function setMultitableApiErrorLocaleResolver(
  resolver: ApiErrorLocaleResolver | null | undefined,
): void {
  globalApiErrorLocaleResolver = resolver ?? undefined
}

function resolveGlobalApiErrorIsZh(): boolean {
  return globalApiErrorLocaleResolver?.() === true
}

export function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined
  const trimmed = headerValue.trim()
  if (!trimmed) return undefined
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const retryDate = Date.parse(trimmed)
  if (Number.isNaN(retryDate)) return undefined
  return Math.max(0, retryDate - Date.now())
}

function defaultFetchFn(): FetchFn {
  return apiFetch
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  return entries.length ? `?${entries.join('&')}` : ''
}

function normalizeChartConfig(chart: ChartConfig | ChartConfigWire): ChartConfig {
  const wire = chart as ChartConfigWire
  const chartType = wire.chartType ?? wire.type ?? chart.chartType
  return {
    ...(chart as ChartConfig),
    chartType: chartType as ChartConfig['chartType'],
    displayConfig: wire.displayConfig ?? wire.display,
  }
}

function toChartCreateWire(input: ChartCreateInput): ChartCreateInputWire {
  const { chartType, displayConfig, ...rest } = input
  return {
    ...rest,
    type: chartType,
    display: displayConfig,
  }
}

function toChartUpdateWire(input: Partial<ChartCreateInput>): ChartUpdateInputWire {
  const { chartType, displayConfig, ...rest } = input
  return {
    ...rest,
    ...(chartType ? { type: chartType } : {}),
    ...(displayConfig ? { display: displayConfig } : {}),
  }
}

async function parseJson<T>(res: Response, isZh = false): Promise<T> {
  const raw = await res.text()
  const body = raw ? safeParseJson(raw) : null
  if (!res.ok) {
    const payload = normalizeApiErrorPayload(body, isZh)
    const error = new Error(firstFieldError(payload.fieldErrors) ?? payload.message ?? apiDefaultErrorMessage(payload.code, res.status, isZh)) as Error & {
      status?: number
      code?: string
      fieldErrors?: Record<string, string>
      serverVersion?: number
      retryAfterMs?: number
    }
    error.name = 'MultitableApiError'
    error.status = res.status
    error.code = payload.code
    error.fieldErrors = payload.fieldErrors
    error.serverVersion = payload.serverVersion
    error.retryAfterMs = parseRetryAfterMs(res.headers.get('Retry-After'))
    throw error
  }
  if (res.status === 204 || !raw.trim()) return undefined as T
  return (unwrapDataBody(body) ?? body) as T
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function normalizeApiErrorPayload(body: unknown, isZh = false): ApiErrorPayload {
  if (!body || typeof body !== 'object') return {}
  const record = body as Record<string, unknown>
  const error = record.error
  if (typeof error === 'string') {
    return {
      code: error,
      message: typeof record.message === 'string' ? record.message : error,
      fieldErrors: normalizeFieldErrors(record.fieldErrors, isZh),
    }
  }
  if (error && typeof error === 'object') {
    const payload = error as ApiErrorPayload & { fieldErrors?: unknown }
    return {
      ...payload,
      fieldErrors: normalizeFieldErrors(payload.fieldErrors, isZh),
    }
  }
  if (typeof record.message === 'string') {
    return {
      message: record.message,
      fieldErrors: normalizeFieldErrors(record.fieldErrors, isZh),
    }
  }
  return {}
}

function normalizeFieldErrors(fieldErrors: unknown, isZh = false): Record<string, string> | undefined {
  if (Array.isArray(fieldErrors)) {
    const normalized: Record<string, string> = {}
    fieldErrors.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') return
      const candidate = entry as { fieldId?: unknown; message?: unknown }
      const fieldId = typeof candidate.fieldId === 'string' && candidate.fieldId.trim()
        ? candidate.fieldId.trim()
        : `field_${index + 1}`
      const message = typeof candidate.message === 'string' && candidate.message.trim()
        ? candidate.message.trim()
        : apiFieldValidationFallback(isZh)
      normalized[fieldId] = message
    })
    return Object.keys(normalized).length > 0 ? normalized : undefined
  }

  if (fieldErrors && typeof fieldErrors === 'object') {
    const normalized = Object.fromEntries(
      Object.entries(fieldErrors as Record<string, unknown>)
        .filter(([fieldId]) => fieldId.trim().length > 0)
        .map(([fieldId, message]) => [
          fieldId,
          typeof message === 'string' && message.trim() ? message.trim() : apiFieldValidationFallback(isZh),
        ]),
    )
    return Object.keys(normalized).length > 0 ? normalized : undefined
  }

  return undefined
}

function unwrapDataBody(body: unknown): unknown {
  if (!body || typeof body !== 'object') return undefined
  return (body as { data?: unknown }).data
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function optionalStringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function objectValue(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {}
}

function normalizeAutomationRulePayload(value: unknown): AutomationRule {
  const payload = isPlainObject(value) && isPlainObject(value.rule) ? value.rule : value
  const record = objectValue(payload)
  const triggerType = stringValue(record.triggerType ?? record.trigger_type) as AutomationRule['triggerType']
  const triggerConfig = objectValue(record.triggerConfig ?? record.trigger_config)
  const actionType = stringValue(record.actionType ?? record.action_type) as AutomationRule['actionType']
  const actionConfig = objectValue(record.actionConfig ?? record.action_config)
  const conditions = isPlainObject(record.conditions)
    ? record.conditions as unknown as AutomationRule['conditions']
    : undefined
  const actions = Array.isArray(record.actions)
    ? record.actions as AutomationRule['actions']
    : undefined

  return {
    id: stringValue(record.id),
    sheetId: stringValue(record.sheetId ?? record.sheet_id),
    name: stringValue(record.name),
    triggerType,
    triggerConfig,
    trigger: isPlainObject(record.trigger)
      ? record.trigger as unknown as AutomationRule['trigger']
      : { type: triggerType, config: triggerConfig },
    conditions,
    actions,
    actionType,
    actionConfig,
    enabled: record.enabled !== false,
    createdAt: optionalStringValue(record.createdAt ?? record.created_at),
    updatedAt: optionalStringValue(record.updatedAt ?? record.updated_at),
    createdBy: optionalStringValue(record.createdBy ?? record.created_by),
    executionMode: optionalStringValue(record.executionMode ?? record.execution_mode) ?? null,
  }
}

function firstFieldError(fieldErrors?: Record<string, string>): string | null {
  if (!fieldErrors) return null
  const first = Object.values(fieldErrors).find((msg) => typeof msg === 'string' && msg.trim())
  return first ?? null
}

// Extract the download filename from a Content-Disposition header (handles both `filename="x.csv"` and
// RFC-5987 `filename*=UTF-8''x.csv`). Falls back to a generic name so the download always has one.
function parseContentDispositionFilename(header: string | null): string {
  if (header) {
    const star = header.match(/filename\*=(?:UTF-8'')?([^;]+)/i)
    if (star?.[1]) {
      try { return decodeURIComponent(star[1].trim().replace(/^["']|["']$/g, '')) } catch { /* fall through */ }
    }
    const plain = header.match(/filename="?([^";]+)"?/i)
    if (plain?.[1]) return plain[1].trim()
  }
  return 'export'
}

type RawComment = Partial<MultitableComment> & {
  spreadsheetId?: string
  rowId?: string
}

type RawInboxItem = RawComment & {
  unread?: boolean
  mentioned?: boolean
  baseId?: string | null
  sheetId?: string | null
  viewId?: string | null
  recordId?: string | null
}

type MultitableCommentIdentityPayload = {
  containerId?: unknown
  spreadsheetId?: unknown
  targetId?: unknown
  rowId?: unknown
}

type MultitableCommentFieldPayload = {
  fieldId?: unknown
  targetFieldId?: unknown
}

type MultitableCommentMentionsPayload = {
  mentions?: unknown
}

function normalizeCommentId(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : ''
}

function normalizeOptionalCommentId(value: unknown): string | undefined {
  const normalized = normalizeCommentId(value)
  return normalized.length > 0 ? normalized : undefined
}

export function normalizeMultitableCommentIdentity(payload: MultitableCommentIdentityPayload | null | undefined) {
  const containerId = normalizeCommentId(payload?.containerId) || normalizeCommentId(payload?.spreadsheetId)
  const targetId = normalizeCommentId(payload?.targetId) || normalizeCommentId(payload?.rowId)

  return {
    containerId,
    targetId,
    spreadsheetId: containerId || undefined,
    rowId: targetId || undefined,
  }
}

export function normalizeMultitableCommentFieldId(payload: MultitableCommentFieldPayload | null | undefined): string | null {
  const fieldId = normalizeCommentId(payload?.fieldId) || normalizeCommentId(payload?.targetFieldId)
  return fieldId.length > 0 ? fieldId : null
}

export function normalizeMultitableCommentMentions(payload: MultitableCommentMentionsPayload | null | undefined): string[] {
  if (!Array.isArray(payload?.mentions)) return []
  return payload.mentions.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
}

/**
 * Normalize the per-comment `reactions` aggregate (B6). The whitelist normalizer
 * drops unknown raw fields, so reactions MUST be carried explicitly here or the
 * backend's reactions array is silently lost on the wire (wire-vs-fixture drift).
 * Returns undefined when absent (so a comment whose reactions weren't hydrated is
 * distinguishable from one with zero reactions).
 */
export function normalizeMultitableCommentReactions(
  payload: { reactions?: unknown } | null | undefined,
): MultitableCommentReaction[] | undefined {
  if (!Array.isArray(payload?.reactions)) return undefined
  const out: MultitableCommentReaction[] = []
  for (const raw of payload.reactions) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    if (typeof r.emoji !== 'string' || !r.emoji) continue
    out.push({
      emoji: r.emoji,
      count: typeof r.count === 'number' && Number.isFinite(r.count) ? r.count : 0,
      reactedByMe: r.reactedByMe === true,
    })
  }
  return out
}

function normalizeCommentPresenceList(payload: { items?: MultitableCommentPresenceSummary[] } | null | undefined): {
  items: MultitableCommentPresenceSummary[]
} {
  if (!payload?.items) return { items: [] }
  return { items: payload.items.map(normalizeMultitableCommentPresenceSummary) }
}

export function normalizeMultitableComment(payload: RawComment | null | undefined): MultitableComment {
  const identity = normalizeMultitableCommentIdentity(payload)
  const fieldId = normalizeMultitableCommentFieldId(payload)
  return {
    id: normalizeCommentId(payload?.id),
    containerId: identity.containerId,
    targetId: identity.targetId,
    spreadsheetId: identity.spreadsheetId,
    rowId: identity.rowId,
    fieldId,
    targetFieldId: fieldId,
    parentId: normalizeOptionalCommentId(payload?.parentId),
    mentions: normalizeMultitableCommentMentions(payload),
    authorId: normalizeCommentId(payload?.authorId),
    authorName: typeof payload?.authorName === 'string' ? payload.authorName : undefined,
    content: typeof payload?.content === 'string' ? payload.content : '',
    resolved: payload?.resolved === true,
    createdAt: typeof payload?.createdAt === 'string' ? payload.createdAt : '',
    updatedAt: typeof payload?.updatedAt === 'string' ? payload.updatedAt : undefined,
    reactions: normalizeMultitableCommentReactions(payload),
  }
}

function normalizeCommentsList(payload: { comments?: RawComment[]; items?: RawComment[] } | null | undefined): {
  comments: MultitableComment[]
} {
  if (!payload) return { comments: [] }
  if (Array.isArray(payload.comments)) return { comments: payload.comments.map((item) => normalizeMultitableComment(item)) }
  if (Array.isArray(payload.items)) return { comments: payload.items.map((item) => normalizeMultitableComment(item)) }
  return { comments: [] }
}

export function normalizeMultitableCommentPresenceSummary(summary: Partial<MultitableCommentPresenceSummary> & {
  spreadsheetId?: string
  rowId?: string
}): MultitableCommentPresenceSummary {
  const containerId = typeof summary.containerId === 'string'
    ? summary.containerId
    : typeof summary.spreadsheetId === 'string'
      ? summary.spreadsheetId
      : ''
  const targetId = typeof summary.targetId === 'string'
    ? summary.targetId
    : typeof summary.rowId === 'string'
      ? summary.rowId
      : ''
  return {
    containerId,
    targetId,
    spreadsheetId: typeof summary.spreadsheetId === 'string' ? summary.spreadsheetId : containerId || undefined,
    rowId: typeof summary.rowId === 'string' ? summary.rowId : targetId || undefined,
    unresolvedCount: typeof summary.unresolvedCount === 'number' ? summary.unresolvedCount : 0,
    fieldCounts: summary.fieldCounts && typeof summary.fieldCounts === 'object' ? summary.fieldCounts : {},
    mentionedCount: typeof summary.mentionedCount === 'number' ? summary.mentionedCount : 0,
    mentionedFieldCounts: summary.mentionedFieldCounts && typeof summary.mentionedFieldCounts === 'object' ? summary.mentionedFieldCounts : {},
  }
}

function normalizeCommentInbox(payload: { items?: RawInboxItem[]; total?: number; limit?: number; offset?: number } | null | undefined): MultitableCommentInboxPage {
  if (!payload) {
    return { items: [], total: 0, limit: 0, offset: 0 }
  }
  return {
    items: Array.isArray(payload.items)
      ? payload.items.map((item) => ({
          ...normalizeMultitableComment(item),
          unread: item.unread !== false,
          mentioned: item.mentioned === true,
          baseId: typeof item.baseId === 'string' || item.baseId === null ? item.baseId : null,
          sheetId: typeof item.sheetId === 'string'
            ? item.sheetId
            : typeof item.spreadsheetId === 'string'
              ? item.spreadsheetId
              : null,
          viewId: typeof item.viewId === 'string' || item.viewId === null ? item.viewId : null,
          recordId: typeof item.recordId === 'string'
            ? item.recordId
            : typeof item.rowId === 'string'
              ? item.rowId
              : null,
        })) as MultitableCommentInboxItem[]
      : [],
    total: typeof payload.total === 'number' ? payload.total : 0,
    limit: typeof payload.limit === 'number' ? payload.limit : 0,
    offset: typeof payload.offset === 'number' ? payload.offset : 0,
  }
}

function normalizeCommentMentionSummaryItem(
  item: Partial<CommentMentionSummaryItem> | null | undefined,
): CommentMentionSummaryItem {
  return {
    rowId: typeof item?.rowId === 'string' ? item.rowId : '',
    mentionedCount: typeof item?.mentionedCount === 'number' ? item.mentionedCount : 0,
    unreadCount: typeof item?.unreadCount === 'number' ? item.unreadCount : 0,
    mentionedFieldIds: Array.isArray(item?.mentionedFieldIds)
      ? item.mentionedFieldIds.filter((value): value is string => typeof value === 'string')
      : [],
  }
}

function normalizeCommentMentionSummary(
  payload: Partial<CommentMentionSummary> | null | undefined,
): CommentMentionSummary {
  const items = Array.isArray(payload?.items)
    ? payload.items
      .map((item) => normalizeCommentMentionSummaryItem(item))
      .filter((item) => item.rowId.length > 0)
    : []

  return {
    spreadsheetId: typeof payload?.spreadsheetId === 'string' ? payload.spreadsheetId : '',
    unresolvedMentionCount: typeof payload?.unresolvedMentionCount === 'number' ? payload.unresolvedMentionCount : 0,
    unreadMentionCount: typeof payload?.unreadMentionCount === 'number' ? payload.unreadMentionCount : 0,
    mentionedRecordCount: typeof payload?.mentionedRecordCount === 'number' ? payload.mentionedRecordCount : 0,
    unreadRecordCount: typeof payload?.unreadRecordCount === 'number' ? payload.unreadRecordCount : 0,
    items,
  }
}

function normalizeCommentMentionSuggestions(
  payload: { items?: Array<Partial<MetaCommentMentionSuggestion>>; total?: number; limit?: number } | null | undefined,
): { items: MetaCommentMentionSuggestion[]; total: number; limit: number } {
  return {
    items: Array.isArray(payload?.items)
      ? payload.items
        .map((item) => ({
          id: typeof item?.id === 'string' ? item.id : '',
          label: typeof item?.label === 'string' ? item.label : '',
          subtitle: typeof item?.subtitle === 'string' ? item.subtitle : undefined,
        }))
        .filter((item) => item.id.length > 0 && item.label.length > 0)
      : [],
    total: typeof payload?.total === 'number' ? payload.total : 0,
    limit: typeof payload?.limit === 'number' ? payload.limit : 0,
  }
}

function normalizeFormShareConfig(payload: Partial<FormShareConfig> | null | undefined): FormShareConfig {
  const accessMode =
    payload?.accessMode === 'dingtalk' || payload?.accessMode === 'dingtalk_granted'
      ? payload.accessMode
      : 'public'
  return {
    enabled: payload?.enabled === true,
    publicToken: typeof payload?.publicToken === 'string' ? payload.publicToken : null,
    expiresAt: typeof payload?.expiresAt === 'string' ? payload.expiresAt : null,
    status: payload?.status === 'active' || payload?.status === 'expired' ? payload.status : 'disabled',
    accessMode,
    allowedUserIds: Array.isArray(payload?.allowedUserIds)
      ? payload.allowedUserIds.filter((value): value is string => typeof value === 'string')
      : [],
    allowedUsers: normalizeSheetPermissionCandidates({
      items: Array.isArray(payload?.allowedUsers) ? payload.allowedUsers : [],
    }).items.filter((item) => item.subjectType === 'user'),
    allowedMemberGroupIds: Array.isArray(payload?.allowedMemberGroupIds)
      ? payload.allowedMemberGroupIds.filter((value): value is string => typeof value === 'string')
      : [],
    allowedMemberGroups: normalizeSheetPermissionCandidates({
      items: Array.isArray(payload?.allowedMemberGroups) ? payload.allowedMemberGroups : [],
    }).items.filter((item) => item.subjectType === 'member-group'),
  }
}

function normalizeSheetPermissionEntry(
  payload: Partial<MetaSheetPermissionEntry> | null | undefined,
): MetaSheetPermissionEntry | null {
  const subjectType =
    payload?.subjectType === 'user' || payload?.subjectType === 'role' || payload?.subjectType === 'member-group'
      ? payload.subjectType
      : null
  const subjectId = typeof payload?.subjectId === 'string' ? payload.subjectId : ''
  const accessLevel = payload?.accessLevel
  if (!subjectType || !subjectId || (accessLevel !== 'read' && accessLevel !== 'write' && accessLevel !== 'write-own' && accessLevel !== 'admin')) {
    return null
  }
  return {
    subjectType,
    subjectId,
    accessLevel,
    permissions: Array.isArray(payload?.permissions)
      ? payload.permissions.filter((value): value is string => typeof value === 'string')
      : [],
    label: typeof payload?.label === 'string' ? payload.label : subjectId,
    subtitle: typeof payload?.subtitle === 'string' || payload?.subtitle === null ? payload.subtitle ?? null : null,
    isActive: payload?.isActive !== false,
  }
}

function normalizeSheetPermissionEntries(
  payload: { items?: Array<Partial<MetaSheetPermissionEntry>> } | null | undefined,
): { items: MetaSheetPermissionEntry[] } {
  return {
    items: Array.isArray(payload?.items)
      ? payload.items
        .map((item) => normalizeSheetPermissionEntry(item))
        .filter((item): item is MetaSheetPermissionEntry => !!item)
      : [],
  }
}

function normalizeSheetPermissionCandidates(
  payload: { items?: Array<Partial<MetaSheetPermissionCandidate>>; total?: number; limit?: number; query?: string } | null | undefined,
): { items: MetaSheetPermissionCandidate[]; total: number; limit: number; query: string } {
  const items: MetaSheetPermissionCandidate[] = []
  if (Array.isArray(payload?.items)) {
    for (const item of payload.items) {
      const subjectType =
        item?.subjectType === 'user' || item?.subjectType === 'role' || item?.subjectType === 'member-group'
          ? item.subjectType
          : null
      const subjectId = typeof item?.subjectId === 'string' ? item.subjectId : ''
      const label = typeof item?.label === 'string' ? item.label : ''
      if (!subjectType || !subjectId || !label) continue
      items.push({
        subjectType,
        subjectId,
        label,
        subtitle: typeof item?.subtitle === 'string' || item?.subtitle === null ? item.subtitle ?? null : null,
        isActive: item?.isActive !== false,
        accessLevel: item?.accessLevel === 'read' || item?.accessLevel === 'write' || item?.accessLevel === 'write-own' || item?.accessLevel === 'admin'
          ? item.accessLevel
          : null,
        dingtalkBound: typeof item?.dingtalkBound === 'boolean' || item?.dingtalkBound === null
          ? item.dingtalkBound ?? null
          : null,
        dingtalkGrantEnabled: typeof item?.dingtalkGrantEnabled === 'boolean' || item?.dingtalkGrantEnabled === null
          ? item.dingtalkGrantEnabled ?? null
          : null,
        dingtalkPersonDeliveryAvailable: typeof item?.dingtalkPersonDeliveryAvailable === 'boolean' || item?.dingtalkPersonDeliveryAvailable === null
          ? item.dingtalkPersonDeliveryAvailable ?? null
          : null,
      })
    }
  }
  return {
    items,
    total: typeof payload?.total === 'number' ? payload.total : 0,
    limit: typeof payload?.limit === 'number' ? payload.limit : 0,
    query: typeof payload?.query === 'string' ? payload.query : '',
  }
}

function normalizeRecordPermissionEntry(
  payload: Partial<RecordPermissionEntry> | null | undefined,
): RecordPermissionEntry | null {
  const subjectType =
    payload?.subjectType === 'user' || payload?.subjectType === 'role' || payload?.subjectType === 'member-group'
      ? payload.subjectType
      : null
  const id = typeof payload?.id === 'string' ? payload.id : ''
  const sheetId = typeof payload?.sheetId === 'string' ? payload.sheetId : ''
  const recordId = typeof payload?.recordId === 'string' ? payload.recordId : ''
  const subjectId = typeof payload?.subjectId === 'string' ? payload.subjectId : ''
  const accessLevel =
    payload?.accessLevel === 'read' || payload?.accessLevel === 'write' || payload?.accessLevel === 'admin' || payload?.accessLevel === 'none'
      ? payload.accessLevel
      : null
  if (!id || !sheetId || !recordId || !subjectType || !subjectId || !accessLevel) return null
  return {
    id,
    sheetId,
    recordId,
    subjectType,
    subjectId,
    accessLevel,
    label: typeof payload?.label === 'string' ? payload.label : subjectId,
    subtitle: typeof payload?.subtitle === 'string' || payload?.subtitle === null ? payload.subtitle ?? null : null,
    isActive: payload?.isActive !== false,
    createdAt: typeof payload?.createdAt === 'string' ? payload.createdAt : undefined,
    createdBy: typeof payload?.createdBy === 'string' ? payload.createdBy : undefined,
  }
}

function normalizeRecordPermissionEntries(
  payload: { items?: Array<Partial<RecordPermissionEntry>> } | null | undefined,
): RecordPermissionEntry[] {
  return Array.isArray(payload?.items)
    ? payload.items
      .map((item) => normalizeRecordPermissionEntry(item))
      .filter((item): item is RecordPermissionEntry => !!item)
    : []
}

function normalizeHistoryBatchSummary(raw: unknown): HistoryBatchSummary {
  const p = (raw ?? {}) as Record<string, unknown>
  return {
    batchId: String(p.batchId ?? ''),
    sheetId: String(p.sheetId ?? ''),
    actorId: typeof p.actorId === 'string' ? p.actorId : null,
    actorName: typeof p.actorName === 'string' ? p.actorName : null,
    source: typeof p.source === 'string' ? p.source : 'rest',
    action: typeof p.action === 'string' ? p.action : 'update',
    createdAt: typeof p.createdAt === 'string' ? p.createdAt : '',
    visibleAffectedRecordCount: Number(p.visibleAffectedRecordCount ?? 0),
    visibleAffectedFieldCount: Number(p.visibleAffectedFieldCount ?? 0),
    provenanceQuality: p.provenanceQuality === 'legacy' ? 'legacy' : 'stamped',
  }
}

function normalizeHistoryChange(raw: unknown): HistoryChange {
  const p = (raw ?? {}) as Record<string, unknown>
  return {
    sheetId: String(p.sheetId ?? ''),
    recordId: String(p.recordId ?? ''),
    action: typeof p.action === 'string' ? p.action : 'update',
    version: Number(p.version ?? 0),
    changedFieldIds: Array.isArray(p.changedFieldIds) ? p.changedFieldIds.map(String) : [],
    before: p.before && typeof p.before === 'object' ? (p.before as Record<string, unknown>) : null,
    after: p.after && typeof p.after === 'object' ? (p.after as Record<string, unknown>) : null,
  }
}

function normalizeHistoryBatchDetail(raw: unknown): HistoryBatchDetail {
  const p = (raw ?? {}) as Record<string, unknown>
  return {
    batchId: String(p.batchId ?? ''),
    actorId: typeof p.actorId === 'string' ? p.actorId : null,
    actorName: typeof p.actorName === 'string' ? p.actorName : null,
    source: typeof p.source === 'string' ? p.source : 'rest',
    createdAt: typeof p.createdAt === 'string' ? p.createdAt : '',
    visibleAffectedRecordCount: Number(p.visibleAffectedRecordCount ?? 0),
    visibleAffectedFieldCount: Number(p.visibleAffectedFieldCount ?? 0),
    changes: Array.isArray(p.changes) ? p.changes.map(normalizeHistoryChange) : [],
  }
}

function normalizeRecordHistoryEntry(payload: Partial<MetaRecordRevision> | null | undefined): MetaRecordRevision | null {
  const id = typeof payload?.id === 'string' ? payload.id : ''
  const sheetId = typeof payload?.sheetId === 'string' ? payload.sheetId : ''
  const recordId = typeof payload?.recordId === 'string' ? payload.recordId : ''
  const version = typeof payload?.version === 'number' && Number.isFinite(payload.version) ? payload.version : null
  const action = payload?.action === 'create' || payload?.action === 'delete' || payload?.action === 'update'
    ? payload.action
    : null
  if (!id || !sheetId || !recordId || version === null || !action) return null
  return {
    id,
    sheetId,
    recordId,
    version,
    action,
    source: typeof payload?.source === 'string' ? payload.source : 'rest',
    actorId: typeof payload?.actorId === 'string' ? payload.actorId : null,
    actorName: typeof payload?.actorName === 'string' ? payload.actorName : null,
    changedFieldIds: Array.isArray(payload?.changedFieldIds) ? payload.changedFieldIds.map(String) : [],
    patch: isPlainObject(payload?.patch) ? payload.patch : {},
    snapshot: payload?.snapshot === null || payload?.snapshot === undefined
      ? null
      : isPlainObject(payload.snapshot) ? payload.snapshot : {},
    createdAt: typeof payload?.createdAt === 'string' ? payload.createdAt : '',
  }
}

function normalizeRecordHistoryEntries(
  payload: { items?: Array<Partial<MetaRecordRevision>> } | null | undefined,
): MetaRecordRevision[] {
  return Array.isArray(payload?.items)
    ? payload.items
      .map((item) => normalizeRecordHistoryEntry(item))
      .filter((item): item is MetaRecordRevision => !!item)
    : []
}

function normalizeRecordSubscription(payload: Partial<MetaRecordSubscription> | null | undefined): MetaRecordSubscription | null {
  const id = typeof payload?.id === 'string' ? payload.id : ''
  const sheetId = typeof payload?.sheetId === 'string' ? payload.sheetId : ''
  const recordId = typeof payload?.recordId === 'string' ? payload.recordId : ''
  const userId = typeof payload?.userId === 'string' ? payload.userId : ''
  if (!id || !sheetId || !recordId || !userId) return null
  return {
    id,
    sheetId,
    recordId,
    userId,
    createdAt: typeof payload?.createdAt === 'string' ? payload.createdAt : '',
    updatedAt: typeof payload?.updatedAt === 'string' ? payload.updatedAt : '',
  }
}

function normalizeRecordSubscriptionStatus(
  payload: { subscribed?: boolean; subscription?: Partial<MetaRecordSubscription> | null; items?: Array<Partial<MetaRecordSubscription>> } | null | undefined,
): MetaRecordSubscriptionStatus {
  const subscription = normalizeRecordSubscription(payload?.subscription ?? null)
  const items = Array.isArray(payload?.items)
    ? payload.items
      .map((item) => normalizeRecordSubscription(item))
      .filter((item): item is MetaRecordSubscription => !!item)
    : []
  return {
    subscribed: payload?.subscribed === true || !!subscription,
    subscription,
    items,
  }
}

function normalizeRecordSubscriptionNotification(
  payload: Partial<MetaRecordSubscriptionNotification> | null | undefined,
): MetaRecordSubscriptionNotification | null {
  const id = typeof payload?.id === 'string' ? payload.id : ''
  const sheetId = typeof payload?.sheetId === 'string' ? payload.sheetId : ''
  const recordId = typeof payload?.recordId === 'string' ? payload.recordId : ''
  const userId = typeof payload?.userId === 'string' ? payload.userId : ''
  // Admit ALL three known types — a missing notification.sent branch here would
  // silently DROP every button-delivered notification (returns null → filtered out).
  const eventType =
    payload?.eventType === 'comment.created' ? 'comment.created'
      : payload?.eventType === 'notification.sent' ? 'notification.sent'
        : payload?.eventType === 'record.updated' ? 'record.updated'
          : null
  if (!id || !sheetId || !recordId || !userId || !eventType) return null
  return {
    id,
    sheetId,
    recordId,
    userId,
    eventType,
    actorId: typeof payload?.actorId === 'string' ? payload.actorId : null,
    revisionId: typeof payload?.revisionId === 'string' ? payload.revisionId : null,
    commentId: typeof payload?.commentId === 'string' ? payload.commentId : null,
    message: typeof payload?.message === 'string' ? payload.message : null,
    createdAt: typeof payload?.createdAt === 'string' ? payload.createdAt : '',
    readAt: typeof payload?.readAt === 'string' ? payload.readAt : null,
  }
}

function normalizeRecordSubscriptionNotifications(
  payload: { items?: Array<Partial<MetaRecordSubscriptionNotification>> } | null | undefined,
): MetaRecordSubscriptionNotification[] {
  return Array.isArray(payload?.items)
    ? payload.items
      .map((item) => normalizeRecordSubscriptionNotification(item))
      .filter((item): item is MetaRecordSubscriptionNotification => !!item)
    : []
}

function normalizeCommentsParams(params: { containerId: string; targetId: string; targetFieldId?: string | null } | MetaCommentsScope) {
  if ('containerType' in params) {
    return {
      containerId: params.containerId,
      targetId: params.targetId,
      targetFieldId: params.targetFieldId ?? null,
    }
  }
  return {
    containerId: params.containerId,
    targetId: params.targetId,
    targetFieldId: params.targetFieldId ?? null,
  }
}

export interface ViewAggregateGroup {
  key: string | number | boolean | null
  count: number
  aggregates: Record<string, { fn: string; value: number }>
  // Nested grouping: per-level subtotals form a tree. `children` is present iff the view groups by a
  // deeper level (view.groupInfo.fieldIds[i+1]). Each node's `aggregates` are computed INDEPENDENTLY
  // over that node's full membership (avg/countDistinct are NOT roll-up-able from children).
  children?: ViewAggregateGroup[]
}
export interface ViewAggregateResult {
  total: number
  aggregates: Record<string, { fn: string; value: number }>
  // #4-3b-2a: present only when the view groups (view.groupInfo resolves to ≥1 allowed, non-computed
  // field); otherwise absent (response is byte-identical to the grand-total-only shape).
  // `groupFieldId` = the level-1 field (legacy single-field reader back-compat); `groupFieldIds` = the
  // ordered 1-3 level fields (nested grouping). `groups` is the per-level subtotal tree.
  groupFieldId?: string
  groupFieldIds?: string[]
  groups?: ViewAggregateGroup[]
  // A5 full-column scale stats: present ONLY when `statsFields` was requested. Per-field { min, max,
  // count } over the WHOLE filtered (+ permission-masked) column — the conditional-formatting scale
  // (data-bar denominator + color-scale endpoints) uses this instead of the client page's local min/max.
  // A requested field that the actor cannot read (hidden / denied / tainted / non-numeric) is OMITTED
  // here (its distribution must not leak), so a missing field → caller keeps its page-local fallback.
  stats?: Record<string, { min: number; max: number; count: number }>
}

// Formula dry-run (#5b, design #1869). Diagnostics carry structured context; the client localizes by
// kind/code and NEVER renders `message` in the UI (message is debug/EN-only).
export type DryRunDiagnosticKind = 'unknown_field' | 'unsupported' | 'runtime' | 'type_mismatch' | 'missing_sample'
export interface DryRunDiagnostic {
  severity: 'error' | 'warning' | 'info'
  kind: DryRunDiagnosticKind
  message: string
  code?: string
  fieldId?: string
  expectedType?: string
  actualType?: string
}
export interface DryRunResult {
  success: boolean
  result?: string | number | boolean | null
  resultType?: 'number' | 'string' | 'boolean' | 'date' | 'null'
  referencedFields: string[]
  diagnostics: DryRunDiagnostic[]
}

// AI field shortcut (A3, design multitable-ai-shortcut-frontend-a3-design-20260611).
// These types mirror the PINNED A2 wire contract 1:1
// (packages/core-backend/src/routes/multitable-ai.ts; the run key set is
// asserted route-level in the backend integration suite). Do not reshape here —
// the useAiShortcut adapter owns the PatchResult synthesis.
export type AiShortcutKind = 'summarize' | 'classify' | 'extract' | 'translate'

export interface AiShortcutConfigInput {
  kind: AiShortcutKind
  sourceFieldIds: string[]
  params?: { options?: string[]; targetLang?: string; instruction?: string }
}

export interface AiShortcutUsage {
  promptTokens: number
  completionTokens: number
}

// Layer 1 record-level version restore (POST .../restore).
export interface RestoreRecordResult {
  recordId: string
  newVersion: number
  /** true when the restorable diff was empty — no write, no new revision. */
  noop: boolean
  restoredFieldIds: string[]
  /** Always [] under atomic reject; reserved for a future partial-restore mode. */
  skippedFieldIds: string[]
}

// T6: a record-version restore PREVIEW (read-only) — the masked diff a restore would apply, plus the
// preview identity the execute consumes. `previewIdentity` is null when not executable (schema drift).
export interface RestorePreviewChange {
  fieldId: string
  op: 'set' | 'unset'
  value: unknown
}
export interface RestorePreviewResult {
  changes: RestorePreviewChange[]
  visibleAffectedFieldCount: number
  schemaDrift: boolean
  targetVersion: number
  previewIdentity: string | null
}

// BS-4: scoped (multi-record) restore preview/execute results — a faithful client of the BS-2/BS-3 wire.
export interface RestoreBatchPreviewRecord {
  recordId: string
  status: 'restorable' | 'skipped'
  changes?: RestorePreviewChange[]
  affectedFieldCount?: number
  /** the record's preview-time version — submitted back verbatim as expectedVersions[recordId] (the version bind). */
  previewVersion?: number
  /** why a record is not restorable: unavailable | version_unavailable | unsupported | snapshot_unavailable | schema_drift | no_change */
  skipReason?: string
}
export interface RestoreBatchPreviewResult {
  records: RestoreBatchPreviewRecord[]
  /** the RESTORABLE record set the identity binds (sorted) — the FE executes exactly this set. */
  scope: string[]
  restorableCount: number
  skippedCount: number
  targetVersion: number
  previewIdentity: string | null
}
export interface RestoreBatchExecuteRecord {
  recordId: string
  status: 'restored' | 'skipped'
  newVersion?: number
  restoredFieldIds?: string[]
  /** write-level skip taxonomy (surfaced verbatim): denied | conflict | forbidden | error */
  skipReason?: 'denied' | 'conflict' | 'forbidden' | 'error'
}
export interface RestoreBatchExecuteResult {
  records: RestoreBatchExecuteRecord[]
  restoredCount: number
  skippedCount: number
  targetVersion: number
}

// T9-R4: a config/schema-change history entry (server-gated per entity type; the FE renders it as-is).
export interface MetaConfigRevision {
  id: string
  entityType: 'field' | 'permission' | 'view' | 'sheet_config'
  entityId: string
  action: 'create' | 'update' | 'delete'
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  changedKeys: string[]
  batchId: string | null
  actorId: string | null
  createdAt: string
}

export interface AiShortcutPreviewData {
  status: 'succeeded'
  action: 'preview'
  output: string
  usage: AiShortcutUsage | null
  estimatedCostUsd: number
  provider: string | null
  model: string | null
}

export interface AiShortcutRunData {
  status: 'succeeded'
  action: 'run'
  recordId: string
  fieldId: string
  /** null when the write landed without a reported version — the adapter must skip the version merge. */
  version: number | null
  output: string
  usage: AiShortcutUsage | null
  estimatedCostUsd: number
  provider: string | null
  model: string | null
}

/** B1-b button run result. `failed` arrives at HTTP 200 (resolves, not throws). */
export interface ButtonRunData {
  status: 'succeeded' | 'failed'
  executionId: string
  message?: string
}

export interface AiSuggestFormulaData {
  status: 'succeeded'
  action: 'suggest'
  /** The proposed formula expression — the client runs it through the existing dry-run + Test flow. */
  candidate: string
  usage: AiShortcutUsage | null
  estimatedCostUsd: number
  provider: string | null
  model: string | null
}

// AI BULK fill — review-before-write (B-1/B-2 backend, B-3 frontend). These
// mirror the EXACT bulk-preview / bulk-commit wire 1:1
// (packages/core-backend/src/routes/multitable-ai.ts bulk-preview return ~1084
// + bulk-commit return ~1307). Do NOT reshape: the truthful-status UI depends
// on every distinct state surviving the wire (fixture-drift rule).
export interface AiBulkPreviewInput {
  fieldId: string
  scope: 'view' | 'sheet'
  viewId?: string
  recordIds?: string[]
}

/**
 * A CONFIRMABLE preview row (it has a real cached `proposed` value to write).
 * `masked: true` flags that the proposal was generated from a REDUCED context
 * (a source field the viewer cannot read was dropped) — still confirmable, just
 * "may be incomplete". `version` rides into commit as the anti-TOCTOU expected
 * version. `writable` is always true for a row that reaches `rows[]`.
 */
export interface AiBulkPreviewRow {
  recordId: string
  version: number
  /** The target field's CURRENT value (server-read from the record, never grid-page
   *  dependent) — the value this preview would overwrite. `null` = genuinely empty.
   *  Render `null`/'' distinctly; it is the truthful left side of the review diff. */
  currentValue: string | null
  proposed: string
  masked: boolean
  writable: boolean
}

/**
 * A row the provider was NEVER called for → UNCHARGED, NOT confirmable. `reason`
 * is heterogeneous: `skipped_no_perm` (not writable — needs a perm change),
 * `rate_limited_before_call` / `blocked_before_call` (transient — a re-run may
 * reach it), `generation_failed_before_usage` (provider failed, no usage),
 * `unsafe_input` (secret-shaped content, not sent).
 */
export interface AiBulkPreviewSkipped {
  recordId: string
  reason: string
}

/**
 * A row the provider WAS called for but which produced no committable output →
 * CHARGED (consumed quota) yet NOT confirmable. `reason`: `provider_error_charged`
 * (billed but errored) / `cache_failed_after_generation` (output lost before
 * cache). Must NEVER be selectable for commit (no value to write).
 */
export interface AiBulkPreviewFailure {
  recordId: string
  reason: string
}

export interface AiBulkPreviewData {
  runId: string
  rows: AiBulkPreviewRow[]
  skipped: AiBulkPreviewSkipped[]
  failures: AiBulkPreviewFailure[]
  /** Total settled provider cost (USD) for THIS preview — already charged; shown for cost honesty. */
  settledCost: number
  /**
   * true → the batch BROKE EARLY (provider/cache error or quota/blocked/
   * rate-limit hit mid-loop): the preview is PARTIAL, remaining in-scope rows
   * were not reached. NOT the over-cap path (that is a 400 BULK_SCOPE_TOO_LARGE
   * which never returns rows). The backend deliberately returns NO total, so the
   * UI signals incompleteness without a count (hidden-row oracle guard).
   */
  capped: boolean
}

export type AiBulkCommitOutcome =
  | 'written'
  | 'stale_reprev'
  | 'write_conflict'
  | 'not_in_cache'
  | 'skipped_no_perm'

export interface AiBulkCommitRowOutcome {
  recordId: string
  outcome: AiBulkCommitOutcome
}

export interface AiBulkCommitData {
  outcomes: AiBulkCommitRowOutcome[]
  counts: Record<AiBulkCommitOutcome, number>
}

// AI BULK fill — ASYNC JOB (B-4). When a bulk-preview request exceeds the inline
// cap the backend creates a job instead of generating inline and returns
// `{ jobId }` (bare body — no `{ ok, data }` envelope: parseJson passes it through
// as-is). These mirror the EXACT job-route wire 1:1 (multitable-ai.ts: poll
// `bulk-job/:jobId` ~1238, paginated `bulk-job/:jobId/rows` ~1280, commit
// `bulk-job/:jobId/commit` ~1431, cancel `bulk-job/:jobId/cancel` ~1316). Do NOT
// reshape — the truthful-status UI depends on every distinct state surviving the
// wire (the same fixture-drift rule as B-3).

/**
 * Job lifecycle status (the poll route's `state`, a WorkflowJobStatus). Job mode
 * cares about: `queued`/`running` (the worker is still generating — keep polling)
 * → `suspended` (generation done, AWAITING review — the diff is ready) /
 * `resolved` (already committed — terminal success) / `rejected` (cancelled —
 * already-generated rows stay committable) / `errored` (crashed mid-generate —
 * the persisted partial is still committable).
 */
export type AiBulkJobStatus =
  | 'queued'
  | 'running'
  | 'suspended'
  | 'resolved'
  | 'rejected'
  | 'errored'

/** A bulk-fill start either generated inline (≤ cap, B-3 path) or created a job (over cap). */
export type AiBulkPreviewStart = AiBulkPreviewData | AiBulkJobStart

export interface AiBulkJobStart {
  jobId: string
}

/** True when the over-cap start created an async job (vs. the inline B-3 preview). */
export function isAiBulkJobStart(start: AiBulkPreviewStart): start is AiBulkJobStart {
  return 'jobId' in start
}

/**
 * Poll header (multitable-ai.ts BJ-3 ~1238). The durable progress counters +
 * per-state row counts + the commit aggregate. `state` drives the poll loop;
 * `generated`/`total` the progress bar; `quotaPaused` the banner; `settledCost`
 * the already-charged spend. Counts are the truthful per-bucket tallies.
 */
export interface AiBulkJobPoll {
  jobId: string
  state: AiBulkJobStatus
  /** Why the job suspended (BJ-3) — e.g. `manual_task` (awaiting review). Display copy is by state, not this. */
  suspendReason: string | null
  /** Provider-bound denominator (NOT including skipped_no_perm rows). */
  total: number
  generated: number
  skippedCount: number
  failuresCount: number
  committedCount: number
  pendingNotGeneratedCount: number
  /** Already-charged provider spend (USD) for this job so far. */
  settledCost: number
  /** true → generation paused on the per-tenant quota (BJ — partial; re-run to continue). */
  quotaPaused: boolean
  /** Durable commit aggregate ({ confirmed, attempted, counts }) once committed; null before. */
  aggregate: unknown
}

/** Row review state (multitable-ai.ts BJ-9). ONLY `generated` is confirmable. */
export type AiBulkJobRowState =
  | 'pending'
  | 'generated'
  | 'skipped'
  | 'failure'
  | 'committed'
  | 'pending_not_generated'

/**
 * One review row (multitable-ai.ts BJ-9 ~1280). `proposed` is the cached output
 * (null until generated). `currentValue` is the server-read target value the
 * write would overwrite (null = genuinely empty). `masked` flags a reduced
 * context. `reason` carries the skipped/failure/pending_not_generated detail.
 */
export interface AiBulkJobRow {
  recordId: string
  ordinal: number
  state: AiBulkJobRowState
  currentValue: string | null
  proposed: string | null
  masked: boolean
  reason: string | null
}

/** A paginated review page (multitable-ai.ts BJ-9). Follow `nextCursor` until null. */
export interface AiBulkJobRowsPage {
  rows: AiBulkJobRow[]
  nextCursor: number | null
}

/** Job-commit per-row outcome — DIVERGES from B-2: `committed` (not `written`), no `not_in_cache`. */
export type AiBulkJobCommitOutcome =
  | 'committed'
  | 'stale_reprev'
  | 'write_conflict'
  | 'skipped_no_perm'

/** Commit response (multitable-ai.ts BJ-10 ~1431). The job resolves; counts is the truthful tally. */
export interface AiBulkJobCommitData {
  jobId: string
  state: AiBulkJobStatus
  counts: Record<AiBulkJobCommitOutcome, number>
  attempted: number
}

/** Cancel response (multitable-ai.ts BJ-4 ~1316). `state` is `rejected` on success. */
export interface AiBulkJobCancelData {
  jobId: string
  cancelled: boolean
  state: AiBulkJobStatus
}

export interface AiUsageSummary {
  callerDayTokens: number
  callerWeekTokens: number
  instanceDayUsd: number
  caps: {
    tenantDailyTokenCap: number
    tenantWeeklyTokenCap: number
    accountDailyUsdCap: number
  }
}

export class MultitableApiClient {
  private fetch: FetchFn
  private readonly isZhOption?: ApiErrorLocaleOption

  constructor(opts?: { fetchFn?: FetchFn; isZh?: ApiErrorLocaleOption }) {
    this.fetch = opts?.fetchFn ?? defaultFetchFn()
    this.isZhOption = opts?.isZh
  }

  private resolveIsZh(): boolean {
    if (typeof this.isZhOption === 'function') return this.isZhOption()
    if (typeof this.isZhOption === 'boolean') return this.isZhOption
    return resolveGlobalApiErrorIsZh()
  }

  private parseJson<T>(res: Response): Promise<T> {
    return parseJson<T>(res, this.resolveIsZh())
  }

  // --- Bases ---
  async listBases(): Promise<{ bases: MetaBase[] }> {
    const res = await this.fetch('/api/multitable/bases')
    return this.parseJson(res)
  }

  async createBase(input: CreateBaseInput): Promise<{ base: MetaBase }> {
    const res = await this.fetch('/api/multitable/bases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return this.parseJson(res)
  }

  async listTemplates(): Promise<{ templates: MetaTemplate[] }> {
    const res = await this.fetch('/api/multitable/templates')
    return this.parseJson(res)
  }

  async installTemplate(templateId: string, input: InstallTemplateInput = {}): Promise<InstallTemplateResult> {
    const res = await this.fetch(`/api/multitable/templates/${encodeURIComponent(templateId)}/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return this.parseJson(res)
  }

  // S2 — zero-write install simulation (design 20260611 §2.1). Same body
  // shape as install; the server only runs SELECT occupancy probes.
  async dryRunTemplate(templateId: string, input: InstallTemplateInput = {}): Promise<TemplateDryRunResult> {
    const res = await this.fetch(`/api/multitable/templates/${encodeURIComponent(templateId)}/dry-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return this.parseJson(res)
  }

  // --- Context ---
  async loadContext(params: { baseId?: string; sheetId?: string; viewId?: string }): Promise<MetaContext> {
    const res = await this.fetch(`/api/multitable/context${qs(params)}`)
    return this.parseJson(res)
  }

  // --- Sheets ---
  async listSheets(): Promise<{ sheets: MetaSheet[] }> {
    const res = await this.fetch('/api/multitable/sheets')
    return this.parseJson(res)
  }

  async createSheet(input: CreateSheetInput): Promise<{ sheet: MetaSheet & { seeded?: boolean } }> {
    const res = await this.fetch('/api/multitable/sheets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return this.parseJson(res)
  }

  async listSheetPermissions(sheetId: string): Promise<{ items: MetaSheetPermissionEntry[] }> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/permissions`)
    const data = await this.parseJson<{ items?: Array<Partial<MetaSheetPermissionEntry>> }>(res)
    return normalizeSheetPermissionEntries(data)
  }

  // #15 recycle bin — list a sheet's deleted records (newest first) and restore one.
  async listDeletedRecords(sheetId: string, params?: { limit?: number; offset?: number }): Promise<{ records: MetaDeletedRecord[]; total: number }> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/trash${qs(params ?? {})}`)
    const data = await this.parseJson<{ records?: MetaDeletedRecord[]; total?: number }>(res)
    return {
      records: Array.isArray(data?.records) ? data.records : [],
      total: typeof data?.total === 'number' ? data.total : 0,
    }
  }

  async restoreDeletedRecord(recordId: string): Promise<{ restored: string; sheetId: string }> {
    const res = await this.fetch(`/api/multitable/records/${encodeURIComponent(recordId)}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const data = await this.parseJson<{ restored?: string; sheetId?: string }>(res)
    return {
      restored: typeof data?.restored === 'string' ? data.restored : recordId,
      sheetId: typeof data?.sheetId === 'string' ? data.sheetId : '',
    }
  }

  async listSheetPermissionCandidates(
    sheetId: string,
    params?: { q?: string; limit?: number },
  ): Promise<{ items: MetaSheetPermissionCandidate[]; total: number; limit: number; query: string }> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/permission-candidates${qs(params ?? {})}`)
    const data = await this.parseJson<{ items?: Array<Partial<MetaSheetPermissionCandidate>>; total?: number; limit?: number; query?: string }>(res)
    return normalizeSheetPermissionCandidates(data)
  }

  /**
   * 2c-S3 — the assignable directory for ONE person field (source = B member-group directory).
   * Returns the same allowed set the write validator accepts (active-only, member-group-scoped),
   * so the picker offers exactly what a save will accept. Gated server-side on canEditRecord.
   */
  async listPersonFieldDirectory(
    sheetId: string,
    fieldId: string,
    params?: { q?: string },
  ): Promise<{ items: Array<{ userId: string; name: string | null; email: string | null }>; total: number; query: string }> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/person-fields/${encodeURIComponent(fieldId)}/directory${qs(params ?? {})}`)
    const data = await this.parseJson<{ items?: Array<{ userId?: unknown; name?: unknown; email?: unknown }>; total?: number; query?: string }>(res)
    const items = (data.items ?? [])
      .map((it) => ({
        userId: String(it.userId ?? ''),
        name: typeof it.name === 'string' ? it.name : null,
        email: typeof it.email === 'string' ? it.email : null,
      }))
      .filter((it) => it.userId.length > 0)
    return { items, total: typeof data.total === 'number' ? data.total : items.length, query: typeof data.query === 'string' ? data.query : '' }
  }

  async updateSheetPermission(
    sheetId: string,
    subjectType: 'user' | 'role' | 'member-group',
    subjectId: string,
    accessLevel: MetaSheetPermissionAccessLevel | 'none',
  ): Promise<{ subjectType: 'user' | 'role' | 'member-group'; subjectId: string; accessLevel: MetaSheetPermissionAccessLevel | 'none'; entry: MetaSheetPermissionEntry | null }> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/permissions/${encodeURIComponent(subjectType)}/${encodeURIComponent(subjectId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessLevel }),
    })
    const data = await this.parseJson<{
      subjectType?: 'user' | 'role' | 'member-group'
      subjectId?: string
      accessLevel?: MetaSheetPermissionAccessLevel | 'none'
      entry?: Partial<MetaSheetPermissionEntry> | null
    }>(res)
    return {
      subjectType:
        data?.subjectType === 'user' || data?.subjectType === 'role' || data?.subjectType === 'member-group'
          ? data.subjectType
          : subjectType,
      subjectId: typeof data?.subjectId === 'string' ? data.subjectId : subjectId,
      accessLevel: data?.accessLevel === 'read' || data?.accessLevel === 'write' || data?.accessLevel === 'write-own' || data?.accessLevel === 'admin' || data?.accessLevel === 'none'
        ? data.accessLevel
        : accessLevel,
      entry: normalizeSheetPermissionEntry(data?.entry ?? null),
    }
  }

  // --- Field permissions ---
  async listFieldPermissions(sheetId: string): Promise<{ items: MetaFieldPermissionEntry[] }> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/field-permissions`)
    const data = await this.parseJson<{ items?: Array<Partial<MetaFieldPermissionEntry>> }>(res)
    return {
      items: Array.isArray(data?.items)
        ? data.items
          .filter((item): item is MetaFieldPermissionEntry =>
            typeof item?.fieldId === 'string' &&
            (item?.subjectType === 'user' || item?.subjectType === 'role' || item?.subjectType === 'member-group') &&
            typeof item?.subjectId === 'string')
          .map((item) => ({
            fieldId: item.fieldId,
            subjectType: item.subjectType,
            subjectId: item.subjectId,
            subjectLabel: typeof item.subjectLabel === 'string' ? item.subjectLabel : undefined,
            subjectSubtitle: typeof item.subjectSubtitle === 'string' || item.subjectSubtitle === null ? item.subjectSubtitle ?? null : null,
            isActive: item.isActive !== false,
            visible: item.visible !== false,
            readOnly: item.readOnly === true,
          }))
        : [],
    }
  }

  async updateFieldPermission(
    sheetId: string,
    fieldId: string,
    subjectType: 'user' | 'role' | 'member-group',
    subjectId: string,
    perm: { visible?: boolean; readOnly?: boolean; remove?: boolean },
  ): Promise<{ fieldId: string; subjectType: string; subjectId: string; visible: boolean; readOnly: boolean }> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/field-permissions/${encodeURIComponent(fieldId)}/${encodeURIComponent(subjectType)}/${encodeURIComponent(subjectId)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(perm),
      },
    )
    return this.parseJson(res)
  }

  // --- View permissions ---
  async listViewPermissions(viewId: string): Promise<{ items: MetaViewPermissionEntry[] }> {
    const res = await this.fetch(`/api/multitable/views/${encodeURIComponent(viewId)}/permissions`)
    const data = await this.parseJson<{ items?: Array<Partial<MetaViewPermissionEntry>> }>(res)
    return {
      items: Array.isArray(data?.items)
        ? data.items
          .filter((item): item is MetaViewPermissionEntry =>
            typeof item?.viewId === 'string' &&
            (item?.subjectType === 'user' || item?.subjectType === 'role' || item?.subjectType === 'member-group') &&
            typeof item?.subjectId === 'string' &&
            typeof item?.permission === 'string')
          .map((item) => ({
            viewId: item.viewId,
            subjectType: item.subjectType,
            subjectId: item.subjectId,
            subjectLabel: typeof item.subjectLabel === 'string' ? item.subjectLabel : undefined,
            subjectSubtitle: typeof item.subjectSubtitle === 'string' || item.subjectSubtitle === null ? item.subjectSubtitle ?? null : null,
            isActive: item.isActive !== false,
            permission: item.permission,
          }))
        : [],
    }
  }

  async updateViewPermission(
    viewId: string,
    subjectType: 'user' | 'role' | 'member-group',
    subjectId: string,
    permission: string,
  ): Promise<{ viewId: string; subjectType: string; subjectId: string; permission: string }> {
    const res = await this.fetch(
      `/api/multitable/views/${encodeURIComponent(viewId)}/permissions/${encodeURIComponent(subjectType)}/${encodeURIComponent(subjectId)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permission }),
      },
    )
    return this.parseJson(res)
  }

  // --- Fields ---
  async listFields(sheetId: string): Promise<{ fields: MetaField[] }> {
    const res = await this.fetch(`/api/multitable/fields${qs({ sheetId })}`)
    return this.parseJson(res)
  }

  async createField(input: CreateFieldInput): Promise<{ field: MetaField }> {
    const res = await this.fetch('/api/multitable/fields', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return this.parseJson(res)
  }

  async preparePersonField(sheetId: string): Promise<MetaPreparedPersonField> {
    const res = await this.fetch('/api/multitable/person-fields/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheetId }),
    })
    return this.parseJson(res)
  }

  async updateField(fieldId: string, input: UpdateFieldInput): Promise<{ field: MetaField }> {
    const res = await this.fetch(`/api/multitable/fields/${fieldId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return this.parseJson(res)
  }

  async deleteField(fieldId: string): Promise<{ deleted: string }> {
    const res = await this.fetch(`/api/multitable/fields/${fieldId}`, { method: 'DELETE' })
    return this.parseJson(res)
  }

  // --- Views ---
  async listViews(sheetId: string): Promise<{ views: MetaView[] }> {
    const res = await this.fetch(`/api/multitable/views${qs({ sheetId })}`)
    return this.parseJson(res)
  }

  async createView(input: CreateViewInput): Promise<{ view: MetaView }> {
    const res = await this.fetch('/api/multitable/views', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return this.parseJson(res)
  }

  async updateView(viewId: string, input: UpdateViewInput): Promise<{ view: MetaView }> {
    const res = await this.fetch(`/api/multitable/views/${viewId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return this.parseJson(res)
  }

  async deleteView(viewId: string): Promise<{ deleted: string }> {
    const res = await this.fetch(`/api/multitable/views/${viewId}`, { method: 'DELETE' })
    return this.parseJson(res)
  }

  // --- View data (grid) ---
  async loadView(params: {
    sheetId?: string
    viewId?: string
    seed?: boolean
    limit?: number
    offset?: number
    includeLinkSummaries?: boolean
    search?: string
  }): Promise<MetaViewData> {
    const res = await this.fetch(`/api/multitable/view${qs(params as Record<string, string | number | boolean | undefined>)}`)
    return this.parseJson(res)
  }

  // Footer aggregation (#4-3b-1): server aggregates over the full filtered set. On 413 (too large)
  // parseJson throws a MultitableApiError with code 'AGGREGATE_TOO_LARGE' — caller handles, never
  // falls back to local aggregation.
  async aggregateView(params: { sheetId: string; viewId?: string; search?: string; statsFields?: string[] }): Promise<ViewAggregateResult> {
    const { sheetId, statsFields, ...rest } = params
    // A5: request full-column numeric min/max/count for the given fields (conditional-formatting scale).
    // Joined CSV → the server omits `stats` entirely when this is absent (byte-identical footer shape).
    const query = qs({ ...(rest as Record<string, string | undefined>), statsFields: statsFields && statsFields.length ? statsFields.join(',') : undefined })
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/view-aggregate${query}`)
    return this.parseJson(res)
  }

  // Full-sheet export (the mask-preserving backend route). The server applies the SAME field_permissions +
  // view-hidden + §2a.3 formula-taint masking as the grid read, AFTER the `fieldIds` selection (which can
  // only NARROW within the permitted set, never widen), then cursor-paginates the WHOLE sheet up to the
  // server's row cap. This is why "all rows" goes here instead of serializing the 50-row client page:
  // the client only holds one masked page; the server holds the full masked sheet. Returns the binary blob
  // + the server's suggested filename (Content-Disposition). On a non-2xx (e.g. 400 when the column
  // selection resolves to zero exportable columns) it throws a MultitableApiError so the caller can toast
  // the server message rather than downloading an error body.
  async exportSheet(params: {
    sheetId: string
    viewId?: string
    fieldIds?: string[]
    format: 'csv' | 'xlsx'
  }): Promise<{ blob: Blob; filename: string }> {
    const query = qs({
      viewId: params.viewId,
      // The route accepts the comma-joined form (?fieldIds=a,b); join here. An empty/absent selection
      // means "all permitted columns" server-side — never send an empty fieldIds (that would be a 400).
      fieldIds: params.fieldIds && params.fieldIds.length ? params.fieldIds.join(',') : undefined,
      format: params.format,
    })
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(params.sheetId)}/export-xlsx${query}`)
    if (!res.ok) {
      // Reuse the shared error normalization (same shape parseJson throws) so the caller sees the
      // server's VALIDATION_ERROR / FORBIDDEN message + code, not a generic "failed to fetch".
      const isZh = this.resolveIsZh()
      const raw = await res.text()
      const payload = normalizeApiErrorPayload(raw ? safeParseJson(raw) : null, isZh)
      const error = new Error(firstFieldError(payload.fieldErrors) ?? payload.message ?? apiDefaultErrorMessage(payload.code, res.status, isZh)) as Error & {
        status?: number
        code?: string
      }
      error.name = 'MultitableApiError'
      error.status = res.status
      error.code = payload.code
      throw error
    }
    const blob = await res.blob()
    return { blob, filename: parseContentDispositionFilename(res.headers.get('Content-Disposition')) }
  }

  // Formula dry-run (#5b): evaluate an UNSAVED expression against caller-supplied sample values.
  // 200 (even on success:false runtime errors) → DryRunResult; 403/413/422 → MultitableApiError.
  // recordId (#5c): sample an existing record's RAW values server-side (manual sampleValues still
  // override per-field). The server applies field-read masking, so a denied/hidden field's value is
  // never returned — it degrades to a missing_sample diagnostic.
  async dryRunFormula(params: { sheetId: string; expression: string; sampleValues: Record<string, unknown>; recordId?: string }): Promise<DryRunResult> {
    const { sheetId, expression, sampleValues, recordId } = params
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/formula/dry-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expression, sampleValues, ...(recordId ? { recordId } : {}) }),
    })
    return this.parseJson(res)
  }

  // --- AI shortcut (A3) ---
  // Preview accepts EITHER a persisted fieldId (drawer path) OR an inline
  // DRAFT config (field-manager config-time preview — a REAL provider call
  // that consumes quota). A real readable recordId is mandatory (no
  // hand-typed-sample path on the backend).
  async aiShortcutPreview(
    sheetId: string,
    input: { recordId: string; fieldId?: string; config?: AiShortcutConfigInput },
  ): Promise<AiShortcutPreviewData> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/ai/shortcut/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recordId: input.recordId,
        ...(input.fieldId ? { fieldId: input.fieldId } : {}),
        ...(input.config ? { config: input.config } : {}),
      }),
    })
    return this.parseJson(res)
  }

  // Run executes ONLY the persisted field.property.aiShortcut config — the
  // backend rejects any inline config (400 AI_INLINE_CONFIG_REJECTED), so the
  // body is deliberately limited to {recordId, fieldId}.
  async aiShortcutRun(sheetId: string, input: { recordId: string; fieldId: string }): Promise<AiShortcutRunData> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/ai/shortcut/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recordId: input.recordId, fieldId: input.fieldId }),
    })
    return this.parseJson(res)
  }

  // --- Button field run (B1-b) ---
  // Runs the button's configured (server-persisted) action against one record.
  // IMPORTANT: an action that FAILS returns HTTP 200 with { status: 'failed' } —
  // this resolves (does not throw); the caller MUST branch on `data.status`.
  // Only contract/permission/server errors (400/403/404/500) throw MultitableApiError.
  async runButton(
    sheetId: string,
    recordId: string,
    fieldId: string,
    options?: { requestId?: string; confirmed?: boolean },
  ): Promise<ButtonRunData> {
    // §4: `confirmed` is the server-confirm signal (the server is the gate; the FE
    // confirm dialog sends confirmed:true). `requestId` scopes §6 at-most-once dedup.
    const body: { requestId?: string; confirmed?: boolean } = {}
    if (options?.requestId) body.requestId = options.requestId
    if (options?.confirmed) body.confirmed = true
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/records/${encodeURIComponent(recordId)}/fields/${encodeURIComponent(fieldId)}/button/run`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    )
    return this.parseJson(res)
  }

  // NL→formula suggest (M4 / Lane B2). Field-authoring (canManageFields) gate;
  // the prompt context is the sheet field NAMES + TYPES only (no record values
  // server-side). Returns ONE candidate expression for the caller to validate
  // through the existing dry-run + Test flow (no auto-persist).
  async aiSuggestFormula(sheetId: string, input: { instruction: string }): Promise<AiSuggestFormulaData> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/ai/suggest-formula`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction: input.instruction }),
    })
    return this.parseJson(res)
  }

  // AI BULK preview (B-1) — generate + CHARGE + cache the proposed values for
  // the in-scope readable+writable rows, behind a review-before-write step.
  // Executes ONLY the persisted field.property.aiShortcut config (backend 400s
  // any inline config). scope:'view' resolves the FULL server-side filtered set
  // (NOT the loaded page); viewId is required for scope:'view'. The response
  // separates confirmable rows / uncharged skipped / CHARGED non-confirmable
  // failures / settled cost / a partial (capped) flag — preserved verbatim.
  //
  // OVER the inline cap the backend returns a bare `{ jobId }` instead of an
  // inline preview (B-4 async job). The caller discriminates with
  // `isAiBulkJobStart` and switches to the poll/review/commit job flow.
  async aiBulkPreview(sheetId: string, input: AiBulkPreviewInput): Promise<AiBulkPreviewStart> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/ai/shortcut/bulk-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fieldId: input.fieldId,
        scope: input.scope,
        ...(input.viewId ? { viewId: input.viewId } : {}),
        ...(input.recordIds && input.recordIds.length > 0 ? { recordIds: input.recordIds } : {}),
      }),
    })
    return this.parseJson(res)
  }

  // AI BULK commit (B-2) — WRITE the CACHED outputs (already generated + charged
  // at preview) for the confirmed rows. NO provider call, NO new charge: a
  // cached row not in `recordIds` is simply not written (stays charged — never
  // released). Returns the per-row outcome list + counts; a row may come back
  // stale_reprev / write_conflict / skipped_no_perm / not_in_cache even though
  // it was confirmable at preview (commit re-gates against the live record).
  async aiBulkCommit(sheetId: string, input: { runId: string; recordIds: string[] }): Promise<AiBulkCommitData> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/ai/shortcut/bulk-commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: input.runId, recordIds: input.recordIds }),
    })
    return this.parseJson(res)
  }

  // AI BULK JOB poll (B-4 BJ-3) — durable progress header for an async over-cap
  // job: state (queued|running while generating; suspended|resolved|rejected|
  // errored terminal), generated/total, per-state counts, settledCost,
  // quotaPaused, aggregate. A bare body (no envelope) — passed through verbatim.
  async getBulkJob(sheetId: string, jobId: string): Promise<AiBulkJobPoll> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/ai/shortcut/bulk-job/${encodeURIComponent(jobId)}`,
    )
    return this.parseJson(res)
  }

  // AI BULK JOB rows (B-4 BJ-9) — paginated review page ordered by ordinal. Pass
  // `cursor` (the previous page's `nextCursor`) to page forward; omit for the
  // first page. Returns `{ rows, nextCursor }` (nextCursor null on the last page).
  // Only `state === 'generated'` rows are confirmable; others are read-only.
  async getBulkJobRows(sheetId: string, jobId: string, cursor?: number | null): Promise<AiBulkJobRowsPage> {
    const query = typeof cursor === 'number' ? `?cursor=${encodeURIComponent(String(cursor))}` : ''
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/ai/shortcut/bulk-job/${encodeURIComponent(jobId)}/rows${query}`,
    )
    return this.parseJson(res)
  }

  // AI BULK JOB commit (B-4 BJ-10) — WRITE the confirmed `generated` rows. The FE
  // sends the confirmed recordIds ONCE; the BACKEND chunks internally (never loop
  // here). Returns `{ jobId, state:'resolved', counts, attempted }`. Outcomes
  // DIVERGE from B-2: `committed` (not `written`), no `not_in_cache`. A row may
  // still come back stale_reprev / write_conflict / skipped_no_perm (commit
  // re-gates the live record). 409 if the job is not committable / already committing.
  async commitBulkJob(sheetId: string, jobId: string, recordIds: string[]): Promise<AiBulkJobCommitData> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/ai/shortcut/bulk-job/${encodeURIComponent(jobId)}/commit`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recordIds }),
      },
    )
    return this.parseJson(res)
  }

  // AI BULK JOB cancel (B-4 BJ-4) — stop the worker at the next row. Rows already
  // `generated` stay charged + committable; ungenerated rows → pending_not_generated
  // (uncharged); the job → `rejected`. NOT a refund. Returns `{ jobId, cancelled, state }`.
  async cancelBulkJob(sheetId: string, jobId: string): Promise<AiBulkJobCancelData> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/ai/shortcut/bulk-job/${encodeURIComponent(jobId)}/cancel`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
    )
    return this.parseJson(res)
  }

  // Admin usage summary (flat single-object response, readiness-route
  // precedent). 403 for non-admins — callers cache the probe per session.
  async aiUsageSummary(): Promise<AiUsageSummary> {
    const res = await this.fetch('/api/multitable/ai/usage-summary')
    return this.parseJson(res)
  }

  // --- Form context ---
  async loadFormContext(params: { sheetId?: string; viewId?: string; recordId?: string; publicToken?: string }): Promise<MetaFormContext> {
    const path = `/api/multitable/form-context${qs(params)}`
    const res = params.publicToken && this.fetch === apiFetch
      ? await apiFetch(path, { suppressUnauthorizedRedirect: true })
      : await this.fetch(path)
    return this.parseJson(res)
  }

  // --- Records ---
  async getRecord(recordId: string, params?: { sheetId?: string; viewId?: string }): Promise<MetaRecordContext> {
    const res = await this.fetch(`/api/multitable/records/${recordId}${qs(params ?? {})}`)
    return this.parseJson(res)
  }

  async listRecordHistory(sheetId: string, recordId: string, params?: { limit?: number; offset?: number }): Promise<MetaRecordRevision[]> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/records/${encodeURIComponent(recordId)}/history${qs(params ?? {})}`,
    )
    const data = await this.parseJson<{ items?: Array<Partial<MetaRecordRevision>> }>(res)
    return normalizeRecordHistoryEntries(data)
  }

  // T9-R4: config/schema-change history (read-only). The server gates per entity type (read-gate ≡ write-gate); the
  // FE is a FAITHFUL CLIENT — it renders exactly what the server returns and never filters for security.
  async getConfigHistory(sheetId: string, params?: { entityType?: string; limit?: number; offset?: number }): Promise<MetaConfigRevision[]> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/config-history${qs(params ?? {})}`)
    const data = await this.parseJson<{ items?: MetaConfigRevision[] }>(res)
    return Array.isArray(data.items) ? data.items : []
  }

  // --- Global History & Point-in-Time Restore (read-only) ---
  async listHistoryEvents(
    baseId: string,
    params?: { sheetId?: string; actorId?: string; source?: string; action?: string; from?: string; to?: string; fieldId?: string; q?: string; cursor?: string; limit?: number; offset?: number },
  ): Promise<{ batches: HistoryBatchSummary[]; total: number; nextCursor: string | null; searchTruncated: boolean }> {
    const res = await this.fetch(`/api/multitable/bases/${encodeURIComponent(baseId)}/history/events${qs(params ?? {})}`)
    const data = await this.parseJson<{ batches?: unknown[]; total?: number; nextCursor?: unknown; searchTruncated?: unknown }>(res)
    return {
      batches: Array.isArray(data?.batches) ? data.batches.map(normalizeHistoryBatchSummary) : [],
      total: Number(data?.total ?? 0),
      nextCursor: typeof data?.nextCursor === 'string' ? data.nextCursor : null,
      searchTruncated: data?.searchTruncated === true,
    }
  }

  async getHistoryBatch(baseId: string, batchId: string): Promise<HistoryBatchDetail | null> {
    try {
      const res = await this.fetch(`/api/multitable/bases/${encodeURIComponent(baseId)}/history/events/${encodeURIComponent(batchId)}`)
      return normalizeHistoryBatchDetail(await this.parseJson<Partial<HistoryBatchDetail>>(res))
    } catch (err) {
      if ((err as { status?: number })?.status === 404) return null // denied = missing (LOCK-3, no oracle)
      throw err
    }
  }

  async getRecordSubscriptionStatus(sheetId: string, recordId: string): Promise<MetaRecordSubscriptionStatus> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/records/${encodeURIComponent(recordId)}/subscriptions`,
    )
    const data = await this.parseJson<{ subscribed?: boolean; subscription?: Partial<MetaRecordSubscription> | null; items?: Array<Partial<MetaRecordSubscription>> }>(res)
    return normalizeRecordSubscriptionStatus(data)
  }

  async subscribeRecord(sheetId: string, recordId: string): Promise<MetaRecordSubscriptionStatus> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/records/${encodeURIComponent(recordId)}/subscriptions/me`,
      { method: 'PUT' },
    )
    const data = await this.parseJson<{ subscribed?: boolean; subscription?: Partial<MetaRecordSubscription> | null }>(res)
    return normalizeRecordSubscriptionStatus(data)
  }

  async unsubscribeRecord(sheetId: string, recordId: string): Promise<MetaRecordSubscriptionStatus> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/records/${encodeURIComponent(recordId)}/subscriptions/me`,
      { method: 'DELETE' },
    )
    const data = await this.parseJson<{ subscribed?: boolean; subscription?: Partial<MetaRecordSubscription> | null }>(res)
    return normalizeRecordSubscriptionStatus(data)
  }

  async listRecordSubscriptionNotifications(params?: { sheetId?: string; recordId?: string; limit?: number; offset?: number }): Promise<MetaRecordSubscriptionNotification[]> {
    const res = await this.fetch(`/api/multitable/record-subscription-notifications${qs(params ?? {})}`)
    const data = await this.parseJson<{ items?: Array<Partial<MetaRecordSubscriptionNotification>> }>(res)
    return normalizeRecordSubscriptionNotifications(data)
  }

  // Notification Center S1 — self-scoped read-state (the bell binds to these).
  async getRecordSubscriptionUnreadCount(): Promise<number> {
    const res = await this.fetch('/api/multitable/record-subscription-notifications/unread-count')
    const data = await this.parseJson<{ count?: number }>(res)
    return typeof data?.count === 'number' ? data.count : 0
  }

  async markRecordSubscriptionNotificationsRead(ids: string[]): Promise<number> {
    const res = await this.fetch('/api/multitable/record-subscription-notifications/mark-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
    const data = await this.parseJson<{ updated?: number }>(res)
    return typeof data?.updated === 'number' ? data.updated : 0
  }

  async markAllRecordSubscriptionNotificationsRead(): Promise<number> {
    const res = await this.fetch('/api/multitable/record-subscription-notifications/mark-all-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    const data = await this.parseJson<{ updated?: number }>(res)
    return typeof data?.updated === 'number' ? data.updated : 0
  }

  async createRecord(input: CreateRecordInput, opts?: { signal?: AbortSignal }): Promise<{ record: MetaRecord }> {
    const res = await this.fetch('/api/multitable/records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: opts?.signal,
    })
    return this.parseJson(res)
  }

  async deleteRecord(recordId: string, expectedVersion?: number): Promise<{ deleted: string }> {
    const res = await this.fetch(`/api/multitable/records/${recordId}${qs({ expectedVersion })}`, { method: 'DELETE' })
    return this.parseJson(res)
  }

  // Duplicate / clone a record (design 2026-06-16): the server reads the source row, copies the field values
  // the actor can both read AND write into a NEW row, and returns the masked echo of the clone. `sheetId` /
  // `viewId` give the server the context to resolve the source sheet (parity with create/lock).
  async duplicateRecord(recordId: string, params?: { sheetId?: string; viewId?: string }): Promise<{ record: MetaRecord }> {
    const res = await this.fetch(`/api/multitable/records/${recordId}/duplicate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params ?? {}),
    })
    return this.parseJson(res)
  }

  // Record locking (design #2278 follow-up): { locked: true } locks, { locked: false } unlocks.
  async setRecordLock(
    recordId: string,
    locked: boolean,
    params?: { sheetId?: string; viewId?: string },
  ): Promise<{ recordId: string; locked: boolean; lockedBy: string | null; lockedAt: string | null }> {
    const res = await this.fetch(`/api/multitable/records/${recordId}/lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locked, ...params }),
    })
    return this.parseJson(res)
  }

  async patchRecords(input: PatchRecordsInput): Promise<PatchResult> {
    const res = await this.fetch('/api/multitable/patch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return this.parseJson(res)
  }

  /**
   * Restore a record to a prior revision (Layer 1). On failure the thrown
   * MultitableApiError carries `.code` — VERSION_CONFLICT (409) / VERSION_EXPIRED (410) /
   * RESTORE_UNSUPPORTED · SNAPSHOT_UNAVAILABLE · SCHEMA_DRIFT (422) / RESTORE_FORBIDDEN (403) —
   * so callers can branch on the documented contract without string-matching messages.
   */
  async restoreRecordVersion(
    sheetId: string,
    recordId: string,
    targetVersion: number,
    expectedVersion: number,
    fieldIds?: string[],
  ): Promise<RestoreRecordResult> {
    // Per-field (column-level) restore: when fieldIds is a non-empty list, the backend (#2672)
    // restricts the restore to that selection; omit it for a full-record restore.
    const body: { targetVersion: number; expectedVersion: number; fieldIds?: string[] } = { targetVersion, expectedVersion }
    if (fieldIds && fieldIds.length > 0) body.fieldIds = fieldIds
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/records/${encodeURIComponent(recordId)}/restore`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    )
    return this.parseJson<RestoreRecordResult>(res)
  }

  // T6-2 chain: preview what a record-version restore WOULD change (read-only, masked), returning the identity
  // the execute consumes. Pair with restoreExecuteRecord — never restore from the FE without showing the preview.
  async restorePreviewRecord(sheetId: string, recordId: string, targetVersion: number, fieldIds?: string[]): Promise<RestorePreviewResult> {
    // fieldIds (optional) = a per-field (column-subset) preview; omitted = full-record. The server filters the
    // masked diff to the selection before hashing, so the identity binds exactly this subset.
    const body: { targetVersion: number; fieldIds?: string[] } = { targetVersion }
    if (fieldIds && fieldIds.length > 0) body.fieldIds = fieldIds
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/records/${encodeURIComponent(recordId)}/restore-preview`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    )
    return this.parseJson<RestorePreviewResult>(res)
  }

  // Execute a previewed restore, carrying the previewIdentity from restorePreviewRecord (SR-3: the server
  // confirms execution matches the preview). Writes a forward revision; row-deny / field-gate / version are
  // re-checked server-side.
  async restoreExecuteRecord(sheetId: string, recordId: string, targetVersion: number, expectedVersion: number, previewIdentity: string, fieldIds?: string[]): Promise<RestoreRecordResult> {
    // fieldIds must match the selection the identity was minted for (the server re-filters + re-hashes).
    const body: { targetVersion: number; expectedVersion: number; previewIdentity: string; fieldIds?: string[] } = { targetVersion, expectedVersion, previewIdentity }
    if (fieldIds && fieldIds.length > 0) body.fieldIds = fieldIds
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/records/${encodeURIComponent(recordId)}/restore-execute`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    )
    return this.parseJson<RestoreRecordResult>(res)
  }

  // BS-4: preview a multi-record restore. Read-only — returns each record's restorable/skipped outcome + the scope
  // identity. Pair with restoreBatchExecute; never batch-restore without showing the per-record preview.
  async restoreBatchPreview(sheetId: string, recordIds: string[], targetVersion: number, fieldIds?: string[]): Promise<RestoreBatchPreviewResult> {
    const body: { targetVersion: number; recordIds: string[]; fieldIds?: string[] } = { targetVersion, recordIds }
    if (fieldIds && fieldIds.length > 0) body.fieldIds = fieldIds
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/restore-batch-preview`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    )
    return this.parseJson<RestoreBatchPreviewResult>(res)
  }

  // BS-4: execute a previewed batch restore. `expectedVersions` MUST be each record's previewVersion from the preview
  // (the version bind — the server folds the submitted value into the scopeHash); `recordIds` MUST be the preview's
  // `scope`. PARTIAL: per-record restored/skipped(denied|conflict|forbidden) in the result.
  async restoreBatchExecute(
    sheetId: string,
    recordIds: string[],
    targetVersion: number,
    expectedVersions: Record<string, number>,
    previewIdentity: string,
    fieldIds?: string[],
  ): Promise<RestoreBatchExecuteResult> {
    const body: { targetVersion: number; recordIds: string[]; expectedVersions: Record<string, number>; previewIdentity: string; fieldIds?: string[] } = { targetVersion, recordIds, expectedVersions, previewIdentity }
    if (fieldIds && fieldIds.length > 0) body.fieldIds = fieldIds
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/restore-batch-execute`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    )
    return this.parseJson<RestoreBatchExecuteResult>(res)
  }

  // --- Form submit ---
  async submitForm(viewId: string, input: FormSubmitInput): Promise<FormSubmitResult> {
    const path = `/api/multitable/views/${viewId}/submit${qs({ publicToken: input.publicToken })}`
    const requestInit: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }
    const res = input.publicToken && this.fetch === apiFetch
      ? await apiFetch(path, { ...requestInit, suppressUnauthorizedRedirect: true })
      : await this.fetch(path, requestInit)
    return this.parseJson(res)
  }

  // --- Link options ---
  async listLinkOptions(fieldId: string, params?: {
    recordId?: string; search?: string; limit?: number; offset?: number
  }): Promise<LinkOptionsData> {
    const res = await this.fetch(`/api/multitable/fields/${fieldId}/link-options${qs(params ?? {})}`)
    return this.parseJson(res)
  }

  // --- Record summaries ---
  async listRecordSummaries(params: {
    sheetId: string; displayFieldId?: string; search?: string; limit?: number; offset?: number
  }): Promise<RecordSummaryPage> {
    const res = await this.fetch(`/api/multitable/records-summary${qs(params as Record<string, string | number | boolean | undefined>)}`)
    return this.parseJson(res)
  }

  // --- Attachments ---
  async uploadAttachment(file: File, opts?: { sheetId?: string; recordId?: string; fieldId?: string }): Promise<MetaAttachment> {
    const formData = new FormData()
    formData.append('file', file)
    if (opts?.sheetId) formData.append('sheetId', opts.sheetId)
    if (opts?.recordId) formData.append('recordId', opts.recordId)
    if (opts?.fieldId) formData.append('fieldId', opts.fieldId)
    const res = await this.fetch('/api/multitable/attachments', {
      method: 'POST',
      body: formData,
    })
    const data = await this.parseJson<MetaAttachment | { attachment: MetaAttachment }>(res)
    return 'attachment' in data ? data.attachment : data
  }

  async deleteAttachment(attachmentId: string): Promise<{ deleted: string }> {
    const res = await this.fetch(`/api/multitable/attachments/${attachmentId}`, { method: 'DELETE' })
    return this.parseJson(res)
  }

  // --- Record permissions ---
  async listRecordPermissions(sheetId: string, recordId: string): Promise<RecordPermissionEntry[]> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/records/${encodeURIComponent(recordId)}/permissions`)
    const data = await this.parseJson<{ items?: Array<Partial<RecordPermissionEntry>> }>(res)
    return normalizeRecordPermissionEntries(data)
  }

  async updateRecordPermission(
    sheetId: string,
    recordId: string,
    subjectType: string,
    subjectId: string,
    accessLevel: string,
  ): Promise<void> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/records/${encodeURIComponent(recordId)}/permissions`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subjectType, subjectId, accessLevel }),
      },
    )
    await this.parseJson(res)
  }

  async deleteRecordPermission(sheetId: string, recordId: string, permissionId: string): Promise<void> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/records/${encodeURIComponent(recordId)}/permissions/${encodeURIComponent(permissionId)}`,
      { method: 'DELETE' },
    )
    await this.parseJson(res)
  }

  // #18 row-level read-deny: per-sheet flag (default-off). When ON, record_permissions access_level='none'
  // denies read across every read surface; OFF → inert.
  async getRowLevelReadDeny(sheetId: string): Promise<boolean> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/row-level-read-deny`)
    const data = await this.parseJson<{ enabled?: boolean }>(res)
    return data?.enabled === true
  }

  async setRowLevelReadDeny(sheetId: string, enabled: boolean): Promise<boolean> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/row-level-read-deny`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      },
    )
    const data = await this.parseJson<{ enabled?: boolean }>(res)
    return data?.enabled === true
  }

  // #18 phase-2 (2b): conditional read-deny rules. Stored per-sheet; only enforce when the
  // row-level-read-deny flag is on. PUT re-validates server-side (throws on a structurally-invalid rule).
  async getConditionalRules(sheetId: string): Promise<{ rules: ConditionalRuleDTO[]; rejected: unknown[] }> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/conditional-rules`)
    const data = await this.parseJson<{ rules?: ConditionalRuleDTO[]; rejected?: unknown[] }>(res)
    return { rules: Array.isArray(data?.rules) ? data!.rules : [], rejected: Array.isArray(data?.rejected) ? data!.rejected : [] }
  }

  async setConditionalRules(sheetId: string, rules: ConditionalRuleDTO[]): Promise<ConditionalRuleDTO[]> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/conditional-rules`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules }),
      },
    )
    const data = await this.parseJson<{ rules?: ConditionalRuleDTO[] }>(res)
    return Array.isArray(data?.rules) ? data!.rules : []
  }

  // --- Automation rules ---
  async listAutomationRules(sheetId: string): Promise<AutomationRule[]> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/automations`)
    const data = await this.parseJson<{ rules?: unknown[] } | unknown[]>(res)
    const rules = Array.isArray(data)
      ? data
      : isPlainObject(data) && Array.isArray(data.rules)
        ? data.rules
        : []
    return rules.map(normalizeAutomationRulePayload)
  }

  async createAutomationRule(
    sheetId: string,
    rule: Omit<AutomationRule, 'id' | 'sheetId' | 'enabled' | 'createdAt' | 'updatedAt' | 'createdBy'>,
  ): Promise<AutomationRule> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/automations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rule),
    })
    const data = await this.parseJson<unknown>(res)
    return normalizeAutomationRulePayload(data)
  }

  async updateAutomationRule(sheetId: string, ruleId: string, updates: Partial<AutomationRule>): Promise<void> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/automations/${encodeURIComponent(ruleId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      },
    )
    await this.parseJson(res)
  }

  async deleteAutomationRule(sheetId: string, ruleId: string): Promise<void> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/automations/${encodeURIComponent(ruleId)}`,
      { method: 'DELETE' },
    )
    await this.parseJson(res)
  }

  // --- Comments (uses /api/comments) ---
  async listComments(params: { containerId: string; targetId: string; targetFieldId?: string | null } | MetaCommentsScope): Promise<{ comments: MultitableComment[] }> {
    const normalized = normalizeCommentsParams(params)
    const res = await this.fetch(`/api/comments${qs({
      spreadsheetId: normalized.containerId,
      rowId: normalized.targetId,
      fieldId: normalized.targetFieldId ?? undefined,
    })}`)
    const data = await this.parseJson<{ comments?: RawComment[]; items?: RawComment[] }>(res)
    return normalizeCommentsList(data)
  }

  async createComment(input: {
    containerId: string
    targetId: string
    targetFieldId?: string | null
    content: string
    parentId?: string
    mentions?: string[]
  } | (MetaCommentsScope & {
    content: string
    parentId?: string
    mentions?: string[]
  })): Promise<{ comment: MultitableComment }> {
    const normalized = normalizeCommentsParams(input)
    const res = await this.fetch('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        spreadsheetId: normalized.containerId,
        rowId: normalized.targetId,
        fieldId: normalized.targetFieldId ?? undefined,
        content: input.content,
        parentId: input.parentId,
        mentions: input.mentions,
      }),
    })
    const data = await this.parseJson<{ comment?: RawComment }>(res)
    return {
      comment: normalizeMultitableComment(data.comment),
    }
  }

  async listCommentMentionSuggestions(params: {
    spreadsheetId: string
    q?: string
    limit?: number
  }): Promise<{ items: MetaCommentMentionSuggestion[]; total: number; limit: number }> {
    const res = await this.fetch(`/api/comments/mention-candidates${qs(params)}`)
    const data = await this.parseJson<{ items?: Array<Partial<MetaCommentMentionSuggestion>>; total?: number; limit?: number }>(res)
    return normalizeCommentMentionSuggestions(data)
  }

  async resolveComment(commentId: string): Promise<void> {
    const res = await this.fetch(`/api/comments/${commentId}/resolve`, { method: 'POST' })
    return this.parseJson(res)
  }

  async updateComment(commentId: string, input: {
    content: string
    mentions?: string[]
  }): Promise<{ comment: MultitableComment }> {
    const res = await this.fetch(`/api/comments/${commentId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: input.content,
        mentions: input.mentions,
      }),
    })
    const data = await this.parseJson<{ comment?: RawComment }>(res)
    return {
      comment: normalizeMultitableComment(data.comment),
    }
  }

  async deleteComment(commentId: string): Promise<void> {
    const res = await this.fetch(`/api/comments/${commentId}`, { method: 'DELETE' })
    return this.parseJson(res)
  }

  // B6: emoji reactions. The emoji travels in the BODY for both verbs (the
  // backend rejects path-encoded multi-codepoint emoji drift; see B6-a §3.3).
  async addReaction(commentId: string, emoji: string): Promise<void> {
    const res = await this.fetch(`/api/comments/${commentId}/reactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji }),
    })
    return this.parseJson(res)
  }

  async removeReaction(commentId: string, emoji: string): Promise<void> {
    const res = await this.fetch(`/api/comments/${commentId}/reactions`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji }),
    })
    return this.parseJson(res)
  }

  async listCommentPresence(params: { containerId: string; targetIds?: string[] }): Promise<{ items: MultitableCommentPresenceSummary[] }> {
    const targetIds = (params.targetIds ?? []).filter((targetId) => typeof targetId === 'string' && targetId.trim().length > 0)
    const res = await this.fetch(`/api/comments/summary${qs({
      spreadsheetId: params.containerId,
      rowIds: targetIds.length ? targetIds.join(',') : undefined,
    })}`)
    const data = await this.parseJson<{ items?: MultitableCommentPresenceSummary[] }>(res)
    return normalizeCommentPresenceList(data)
  }

  async loadMentionSummary(params: { spreadsheetId: string }): Promise<CommentMentionSummary> {
    const res = await this.fetch(`/api/comments/mention-summary${qs(params)}`)
    const data = await this.parseJson<Partial<CommentMentionSummary> | null>(res)
    return normalizeCommentMentionSummary(data)
  }

  async markMentionsRead(params: { spreadsheetId: string }): Promise<void> {
    const res = await this.fetch('/api/comments/mention-summary/mark-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })
    return this.parseJson(res)
  }

  async listCommentInbox(params?: { limit?: number; offset?: number }): Promise<MultitableCommentInboxPage> {
    const res = await this.fetch(`/api/comments/inbox${qs(params ?? {})}`)
    const data = await this.parseJson<{ items?: RawInboxItem[]; total?: number; limit?: number; offset?: number }>(res)
    return normalizeCommentInbox(data)
  }

  async getCommentUnreadCount(): Promise<number> {
    const res = await this.fetch('/api/comments/unread-count')
    const data = await this.parseJson<{ count?: number }>(res)
    return typeof data?.count === 'number' ? data.count : 0
  }

  async markCommentRead(commentId: string): Promise<void> {
    const res = await this.fetch(`/api/comments/${commentId}/read`, { method: 'POST' })
    return this.parseJson(res)
  }

  // --- Form Share ---
  async getFormShareConfig(sheetId: string, viewId: string): Promise<FormShareConfig> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/views/${encodeURIComponent(viewId)}/form-share`)
    const data = await this.parseJson<Partial<FormShareConfig>>(res)
    return normalizeFormShareConfig(data)
  }

  async updateFormShareConfig(sheetId: string, viewId: string, config: FormShareConfigUpdate): Promise<FormShareConfig> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/views/${encodeURIComponent(viewId)}/form-share`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    })
    const data = await this.parseJson<Partial<FormShareConfig>>(res)
    return normalizeFormShareConfig(data)
  }

  async regenerateFormShareToken(sheetId: string, viewId: string): Promise<{ publicToken: string }> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/views/${encodeURIComponent(viewId)}/form-share/regenerate`, {
      method: 'POST',
    })
    return this.parseJson(res)
  }

  async listFormShareCandidates(
    sheetId: string,
    params?: { q?: string; limit?: number },
  ): Promise<{ items: MetaSheetPermissionCandidate[]; total: number; limit: number; query: string }> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/form-share-candidates${qs(params ?? {})}`)
    const data = await this.parseJson<{ items?: Array<Partial<MetaSheetPermissionCandidate>>; total?: number; limit?: number; query?: string }>(res)
    return normalizeSheetPermissionCandidates(data)
  }

  // --- API Tokens ---
  async listApiTokens(): Promise<ApiToken[]> {
    const res = await this.fetch('/api/multitable/tokens')
    const data = await this.parseJson<{ tokens: ApiToken[] }>(res)
    return data.tokens ?? []
  }

  async createApiToken(input: { name: string; scopes: string[]; expiresAt?: string }): Promise<ApiTokenCreateResult> {
    const res = await this.fetch('/api/multitable/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return this.parseJson(res)
  }

  async revokeApiToken(tokenId: string): Promise<void> {
    const res = await this.fetch(`/api/multitable/tokens/${encodeURIComponent(tokenId)}`, {
      method: 'DELETE',
    })
    return this.parseJson(res)
  }

  async rotateApiToken(tokenId: string): Promise<ApiTokenCreateResult> {
    const res = await this.fetch(`/api/multitable/tokens/${encodeURIComponent(tokenId)}/rotate`, {
      method: 'POST',
    })
    return this.parseJson(res)
  }

  // --- Webhooks ---
  async listWebhooks(): Promise<Webhook[]> {
    const res = await this.fetch('/api/multitable/webhooks')
    const data = await this.parseJson<{ webhooks: Webhook[] }>(res)
    return data.webhooks ?? []
  }

  async createWebhook(input: WebhookCreateInput): Promise<Webhook> {
    const res = await this.fetch('/api/multitable/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return this.parseJson(res)
  }

  async updateWebhook(id: string, input: Partial<WebhookCreateInput>): Promise<Webhook> {
    const res = await this.fetch(`/api/multitable/webhooks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return this.parseJson(res)
  }

  async deleteWebhook(id: string): Promise<void> {
    const res = await this.fetch(`/api/multitable/webhooks/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
    return this.parseJson(res)
  }

  async getWebhookDeliveries(id: string): Promise<WebhookDelivery[]> {
    const res = await this.fetch(`/api/multitable/webhooks/${encodeURIComponent(id)}/deliveries`)
    const data = await this.parseJson<{ deliveries: WebhookDelivery[] }>(res)
    return data.deliveries ?? []
  }

  // --- DingTalk Group Destinations ---
  async listDingTalkGroups(sheetId?: string): Promise<DingTalkGroupDestination[]> {
    const res = await this.fetch(`/api/multitable/dingtalk-groups${qs(sheetId ? { sheetId } : {})}`)
    const data = await this.parseJson<{ destinations: DingTalkGroupDestination[] }>(res)
    return data.destinations ?? []
  }

  async createDingTalkGroup(input: DingTalkGroupDestinationInput): Promise<DingTalkGroupDestination> {
    const res = await this.fetch('/api/multitable/dingtalk-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return this.parseJson(res)
  }

  async updateDingTalkGroup(id: string, input: Partial<Omit<DingTalkGroupDestinationInput, 'sheetId'>>, sheetId?: string): Promise<DingTalkGroupDestination> {
    const res = await this.fetch(`/api/multitable/dingtalk-groups/${encodeURIComponent(id)}${qs(sheetId ? { sheetId } : {})}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return this.parseJson(res)
  }

  async deleteDingTalkGroup(id: string, sheetId?: string): Promise<void> {
    const res = await this.fetch(`/api/multitable/dingtalk-groups/${encodeURIComponent(id)}${qs(sheetId ? { sheetId } : {})}`, {
      method: 'DELETE',
    })
    return this.parseJson(res)
  }

  async testDingTalkGroup(id: string, input?: { subject?: string; content?: string }, sheetId?: string): Promise<void> {
    const res = await this.fetch(`/api/multitable/dingtalk-groups/${encodeURIComponent(id)}/test-send${qs(sheetId ? { sheetId } : {})}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input ?? {}),
    })
    return this.parseJson(res)
  }

  async getDingTalkGroupDeliveries(id: string, sheetId?: string): Promise<DingTalkGroupDelivery[]> {
    const res = await this.fetch(`/api/multitable/dingtalk-groups/${encodeURIComponent(id)}/deliveries${qs(sheetId ? { sheetId } : {})}`)
    const data = await this.parseJson<{ deliveries: DingTalkGroupDelivery[] }>(res)
    return data.deliveries ?? []
  }

  // --- Automation V1: test / logs / stats ---
  async testAutomationRule(sheetId: string, ruleId: string): Promise<AutomationExecution> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/automations/${encodeURIComponent(ruleId)}/test`,
      { method: 'POST' },
    )
    return this.parseJson<AutomationExecution>(res)
  }

  async getAutomationLogs(sheetId: string, ruleId: string, limit?: number): Promise<AutomationExecution[]> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/automations/${encodeURIComponent(ruleId)}/logs${qs({ limit })}`,
    )
    const data = await this.parseJson<{ executions: AutomationExecution[] }>(res)
    return Array.isArray(data?.executions) ? data.executions : []
  }

  async getAutomationStats(sheetId: string, ruleId: string): Promise<AutomationStats> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/automations/${encodeURIComponent(ruleId)}/stats`,
    )
    return this.parseJson<AutomationStats>(res)
  }

  // --- A2: read-only cross-rule runs API (admin-only; status emitted as C1 WorkflowJobStatus) ---
  async listAutomationRuns(filters?: {
    sheetId?: string
    ruleId?: string
    status?: string
    limit?: number
  }): Promise<AutomationRunView[]> {
    const res = await this.fetch(`/api/multitable/automation-executions${qs({ ...filters })}`)
    const data = await this.parseJson<{ executions: AutomationRunView[] }>(res)
    return Array.isArray(data?.executions) ? data.executions : []
  }

  async getAutomationRun(executionId: string): Promise<AutomationRunView> {
    const res = await this.fetch(
      `/api/multitable/automation-executions/${encodeURIComponent(executionId)}`,
    )
    return this.parseJson<AutomationRunView>(res)
  }

  /**
   * A6-2: resume a suspended execution (admin-only; re-runs the remaining actions' side effects).
   * The single-use `resumeToken` comes from the suspended step's C1 descriptor in the run detail.
   * `confirmSideEffects:true` is always sent (the UI confirm-gates this call). parseJson throws an
   * Error with `.code` (NOT_FOUND / ALREADY_RESUMED / RULE_CHANGED / RULE_MISSING_OR_DISABLED /
   * RECORD_GONE) so the caller can map it to an inline message rather than a generic toast.
   */
  async resumeAutomation(resumeToken: string): Promise<AutomationRunView> {
    const res = await this.fetch('/api/multitable/automation/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeToken, confirmSideEffects: true }),
    })
    return this.parseJson<AutomationRunView>(res)
  }

  async getAutomationDingTalkPersonDeliveries(sheetId: string, ruleId: string, limit?: number): Promise<DingTalkPersonDelivery[]> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/automations/${encodeURIComponent(ruleId)}/dingtalk-person-deliveries${qs({ limit })}`,
    )
    const data = await this.parseJson<{ deliveries: DingTalkPersonDelivery[] }>(res)
    return Array.isArray(data?.deliveries) ? data.deliveries : []
  }

  async getAutomationDingTalkGroupDeliveries(sheetId: string, ruleId: string, limit?: number): Promise<DingTalkGroupDelivery[]> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/automations/${encodeURIComponent(ruleId)}/dingtalk-group-deliveries${qs({ limit })}`,
    )
    const data = await this.parseJson<{ deliveries: DingTalkGroupDelivery[] }>(res)
    return Array.isArray(data?.deliveries) ? data.deliveries : []
  }

  // --- Charts ---
  async listCharts(sheetId: string): Promise<ChartConfig[]> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/charts`)
    const data = await this.parseJson<{ charts: Array<ChartConfig | ChartConfigWire> }>(res)
    return Array.isArray(data?.charts) ? data.charts.map(normalizeChartConfig) : []
  }

  async createChart(sheetId: string, input: ChartCreateInput): Promise<ChartConfig> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/charts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toChartCreateWire(input)),
    })
    return normalizeChartConfig(await this.parseJson<ChartConfig | ChartConfigWire>(res))
  }

  async updateChart(sheetId: string, chartId: string, input: Partial<ChartCreateInput>): Promise<ChartConfig> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/charts/${encodeURIComponent(chartId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toChartUpdateWire(input)),
      },
    )
    return normalizeChartConfig(await this.parseJson<ChartConfig | ChartConfigWire>(res))
  }

  async deleteChart(sheetId: string, chartId: string): Promise<void> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/charts/${encodeURIComponent(chartId)}`,
      { method: 'DELETE' },
    )
    await this.parseJson(res)
  }

  async getChartData(sheetId: string, chartId: string, dashboardFilters?: DashboardFilter[]): Promise<ChartData> {
    // B4: an active dashboard-level filter rides on the query as URL-encoded JSON; omitted when empty
    // (= no constraint). The server AND-combines it with the chart's own filter and rejects a denied
    // filter field wholesale (it never reaches an unmasked scan).
    const qs = dashboardFilters && dashboardFilters.length > 0
      ? `?dashboardFilter=${encodeURIComponent(JSON.stringify(dashboardFilters))}`
      : ''
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/charts/${encodeURIComponent(chartId)}/data${qs}`,
    )
    return this.parseJson<ChartData>(res)
  }

  async previewChartData(sheetId: string, input: ChartCreateInput, dashboardFilters?: DashboardFilter[]): Promise<ChartData> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/charts/preview-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // B4: a metric card refetches through preview-data, so the dashboard filter rides on the body.
      body: JSON.stringify({
        ...toChartCreateWire(input),
        ...(dashboardFilters && dashboardFilters.length > 0 ? { dashboardFilter: dashboardFilters } : {}),
      }),
    })
    return this.parseJson<ChartData>(res)
  }

  // --- Dashboards ---
  async listDashboards(sheetId: string): Promise<Dashboard[]> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/dashboards`)
    const data = await this.parseJson<{ dashboards: Dashboard[] }>(res)
    return Array.isArray(data?.dashboards) ? data.dashboards : []
  }

  async createDashboard(sheetId: string, input: { name: string }): Promise<Dashboard> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/dashboards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return this.parseJson<Dashboard>(res)
  }

  async updateDashboard(sheetId: string, dashboardId: string, input: DashboardUpdateInput): Promise<Dashboard> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/dashboards/${encodeURIComponent(dashboardId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    )
    return this.parseJson<Dashboard>(res)
  }

  async deleteDashboard(sheetId: string, dashboardId: string): Promise<void> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/dashboards/${encodeURIComponent(dashboardId)}`,
      { method: 'DELETE' },
    )
    await this.parseJson(res)
  }
}

/** Singleton client for production usage */
export const multitableClient = new MultitableApiClient()
