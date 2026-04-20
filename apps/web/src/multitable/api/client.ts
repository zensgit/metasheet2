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
  AutomationStats,
  ChartConfig,
  ChartCreateInput,
  ChartData,
  Dashboard,
  DashboardUpdateInput,
  FormShareConfig,
  FormShareConfigUpdate,
  ApiToken,
  ApiTokenCreateResult,
  Webhook,
  WebhookCreateInput,
  WebhookDelivery,
  DingTalkGroupDestination,
  DingTalkGroupDelivery,
  DingTalkPersonDelivery,
  DingTalkGroupDestinationInput,
} from '../types'
import { apiFetch } from '../../utils/api'

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

type ApiErrorPayload = {
  code?: string
  message?: string
  fieldErrors?: Record<string, string>
  serverVersion?: number
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

async function parseJson<T>(res: Response): Promise<T> {
  const raw = await res.text()
  const body = raw ? safeParseJson(raw) : null
  if (!res.ok) {
    const payload = (body?.error ?? {}) as ApiErrorPayload
    const error = new Error(firstFieldError(payload.fieldErrors) ?? payload.message ?? `API ${res.status}`) as Error & {
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
  return (body?.data ?? body) as T
}

function safeParseJson(raw: string): any {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function firstFieldError(fieldErrors?: Record<string, string>): string | null {
  if (!fieldErrors) return null
  const first = Object.values(fieldErrors).find((msg) => typeof msg === 'string' && msg.trim())
  return first ?? null
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
    payload?.accessLevel === 'read' || payload?.accessLevel === 'write' || payload?.accessLevel === 'admin'
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

export class MultitableApiClient {
  private fetch: FetchFn

  constructor(opts?: { fetchFn?: FetchFn }) {
    this.fetch = opts?.fetchFn ?? defaultFetchFn()
  }

  // --- Bases ---
  async listBases(): Promise<{ bases: MetaBase[] }> {
    const res = await this.fetch('/api/multitable/bases')
    return parseJson(res)
  }

  async createBase(input: CreateBaseInput): Promise<{ base: MetaBase }> {
    const res = await this.fetch('/api/multitable/bases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return parseJson(res)
  }

  // --- Context ---
  async loadContext(params: { baseId?: string; sheetId?: string; viewId?: string }): Promise<MetaContext> {
    const res = await this.fetch(`/api/multitable/context${qs(params)}`)
    return parseJson(res)
  }

  // --- Sheets ---
  async listSheets(): Promise<{ sheets: MetaSheet[] }> {
    const res = await this.fetch('/api/multitable/sheets')
    return parseJson(res)
  }

  async createSheet(input: CreateSheetInput): Promise<{ sheet: MetaSheet & { seeded?: boolean } }> {
    const res = await this.fetch('/api/multitable/sheets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return parseJson(res)
  }

  async listSheetPermissions(sheetId: string): Promise<{ items: MetaSheetPermissionEntry[] }> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/permissions`)
    const data = await parseJson<{ items?: Array<Partial<MetaSheetPermissionEntry>> }>(res)
    return normalizeSheetPermissionEntries(data)
  }

  async listSheetPermissionCandidates(
    sheetId: string,
    params?: { q?: string; limit?: number },
  ): Promise<{ items: MetaSheetPermissionCandidate[]; total: number; limit: number; query: string }> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/permission-candidates${qs(params ?? {})}`)
    const data = await parseJson<{ items?: Array<Partial<MetaSheetPermissionCandidate>>; total?: number; limit?: number; query?: string }>(res)
    return normalizeSheetPermissionCandidates(data)
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
    const data = await parseJson<{
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
    const data = await parseJson<{ items?: Array<Partial<MetaFieldPermissionEntry>> }>(res)
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
    return parseJson(res)
  }

  // --- View permissions ---
  async listViewPermissions(viewId: string): Promise<{ items: MetaViewPermissionEntry[] }> {
    const res = await this.fetch(`/api/multitable/views/${encodeURIComponent(viewId)}/permissions`)
    const data = await parseJson<{ items?: Array<Partial<MetaViewPermissionEntry>> }>(res)
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
    return parseJson(res)
  }

  // --- Fields ---
  async listFields(sheetId: string): Promise<{ fields: MetaField[] }> {
    const res = await this.fetch(`/api/multitable/fields${qs({ sheetId })}`)
    return parseJson(res)
  }

  async createField(input: CreateFieldInput): Promise<{ field: MetaField }> {
    const res = await this.fetch('/api/multitable/fields', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return parseJson(res)
  }

  async preparePersonField(sheetId: string): Promise<MetaPreparedPersonField> {
    const res = await this.fetch('/api/multitable/person-fields/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheetId }),
    })
    return parseJson(res)
  }

  async updateField(fieldId: string, input: UpdateFieldInput): Promise<{ field: MetaField }> {
    const res = await this.fetch(`/api/multitable/fields/${fieldId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return parseJson(res)
  }

  async deleteField(fieldId: string): Promise<{ deleted: string }> {
    const res = await this.fetch(`/api/multitable/fields/${fieldId}`, { method: 'DELETE' })
    return parseJson(res)
  }

  // --- Views ---
  async listViews(sheetId: string): Promise<{ views: MetaView[] }> {
    const res = await this.fetch(`/api/multitable/views${qs({ sheetId })}`)
    return parseJson(res)
  }

  async createView(input: CreateViewInput): Promise<{ view: MetaView }> {
    const res = await this.fetch('/api/multitable/views', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return parseJson(res)
  }

  async updateView(viewId: string, input: UpdateViewInput): Promise<{ view: MetaView }> {
    const res = await this.fetch(`/api/multitable/views/${viewId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return parseJson(res)
  }

  async deleteView(viewId: string): Promise<{ deleted: string }> {
    const res = await this.fetch(`/api/multitable/views/${viewId}`, { method: 'DELETE' })
    return parseJson(res)
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
    return parseJson(res)
  }

  // --- Form context ---
  async loadFormContext(params: { sheetId?: string; viewId?: string; recordId?: string; publicToken?: string }): Promise<MetaFormContext> {
    const path = `/api/multitable/form-context${qs(params)}`
    const res = params.publicToken && this.fetch === apiFetch
      ? await apiFetch(path, { suppressUnauthorizedRedirect: true })
      : await this.fetch(path)
    return parseJson(res)
  }

  // --- Records ---
  async getRecord(recordId: string, params?: { sheetId?: string; viewId?: string }): Promise<MetaRecordContext> {
    const res = await this.fetch(`/api/multitable/records/${recordId}${qs(params ?? {})}`)
    return parseJson(res)
  }

  async createRecord(input: CreateRecordInput, opts?: { signal?: AbortSignal }): Promise<{ record: MetaRecord }> {
    const res = await this.fetch('/api/multitable/records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: opts?.signal,
    })
    return parseJson(res)
  }

  async deleteRecord(recordId: string, expectedVersion?: number): Promise<{ deleted: string }> {
    const res = await this.fetch(`/api/multitable/records/${recordId}${qs({ expectedVersion })}`, { method: 'DELETE' })
    return parseJson(res)
  }

  async patchRecords(input: PatchRecordsInput): Promise<PatchResult> {
    const res = await this.fetch('/api/multitable/patch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return parseJson(res)
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
    return parseJson(res)
  }

  // --- Link options ---
  async listLinkOptions(fieldId: string, params?: {
    recordId?: string; search?: string; limit?: number; offset?: number
  }): Promise<LinkOptionsData> {
    const res = await this.fetch(`/api/multitable/fields/${fieldId}/link-options${qs(params ?? {})}`)
    return parseJson(res)
  }

  // --- Record summaries ---
  async listRecordSummaries(params: {
    sheetId: string; displayFieldId?: string; search?: string; limit?: number; offset?: number
  }): Promise<RecordSummaryPage> {
    const res = await this.fetch(`/api/multitable/records-summary${qs(params as Record<string, string | number | boolean | undefined>)}`)
    return parseJson(res)
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
    const data = await parseJson<MetaAttachment | { attachment: MetaAttachment }>(res)
    return 'attachment' in data ? data.attachment : data
  }

  async deleteAttachment(attachmentId: string): Promise<{ deleted: string }> {
    const res = await this.fetch(`/api/multitable/attachments/${attachmentId}`, { method: 'DELETE' })
    return parseJson(res)
  }

  // --- Record permissions ---
  async listRecordPermissions(sheetId: string, recordId: string): Promise<RecordPermissionEntry[]> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/records/${encodeURIComponent(recordId)}/permissions`)
    const data = await parseJson<{ items?: Array<Partial<RecordPermissionEntry>> }>(res)
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
    await parseJson(res)
  }

  async deleteRecordPermission(sheetId: string, recordId: string, permissionId: string): Promise<void> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/records/${encodeURIComponent(recordId)}/permissions/${encodeURIComponent(permissionId)}`,
      { method: 'DELETE' },
    )
    await parseJson(res)
  }

  // --- Automation rules ---
  async listAutomationRules(sheetId: string): Promise<AutomationRule[]> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/automations`)
    const data = await parseJson<{ rules: AutomationRule[] }>(res)
    return Array.isArray(data?.rules) ? data.rules : []
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
    return parseJson<AutomationRule>(res)
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
    await parseJson(res)
  }

  async deleteAutomationRule(sheetId: string, ruleId: string): Promise<void> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/automations/${encodeURIComponent(ruleId)}`,
      { method: 'DELETE' },
    )
    await parseJson(res)
  }

  // --- Comments (uses /api/comments) ---
  async listComments(params: { containerId: string; targetId: string; targetFieldId?: string | null } | MetaCommentsScope): Promise<{ comments: MultitableComment[] }> {
    const normalized = normalizeCommentsParams(params)
    const res = await this.fetch(`/api/comments${qs({
      spreadsheetId: normalized.containerId,
      rowId: normalized.targetId,
      fieldId: normalized.targetFieldId ?? undefined,
    })}`)
    const data = await parseJson<{ comments?: RawComment[]; items?: RawComment[] }>(res)
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
    const data = await parseJson<{ comment?: RawComment }>(res)
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
    const data = await parseJson<{ items?: Array<Partial<MetaCommentMentionSuggestion>>; total?: number; limit?: number }>(res)
    return normalizeCommentMentionSuggestions(data)
  }

  async resolveComment(commentId: string): Promise<void> {
    const res = await this.fetch(`/api/comments/${commentId}/resolve`, { method: 'POST' })
    return parseJson(res)
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
    const data = await parseJson<{ comment?: RawComment }>(res)
    return {
      comment: normalizeMultitableComment(data.comment),
    }
  }

  async deleteComment(commentId: string): Promise<void> {
    const res = await this.fetch(`/api/comments/${commentId}`, { method: 'DELETE' })
    return parseJson(res)
  }

  async listCommentPresence(params: { containerId: string; targetIds?: string[] }): Promise<{ items: MultitableCommentPresenceSummary[] }> {
    const targetIds = (params.targetIds ?? []).filter((targetId) => typeof targetId === 'string' && targetId.trim().length > 0)
    const res = await this.fetch(`/api/comments/summary${qs({
      spreadsheetId: params.containerId,
      rowIds: targetIds.length ? targetIds.join(',') : undefined,
    })}`)
    const data = await parseJson<{ items?: MultitableCommentPresenceSummary[] }>(res)
    return normalizeCommentPresenceList(data)
  }

  async loadMentionSummary(params: { spreadsheetId: string }): Promise<CommentMentionSummary> {
    const res = await this.fetch(`/api/comments/mention-summary${qs(params)}`)
    const data = await parseJson<Partial<CommentMentionSummary> | null>(res)
    return normalizeCommentMentionSummary(data)
  }

  async markMentionsRead(params: { spreadsheetId: string }): Promise<void> {
    const res = await this.fetch('/api/comments/mention-summary/mark-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })
    return parseJson(res)
  }

  async listCommentInbox(params?: { limit?: number; offset?: number }): Promise<MultitableCommentInboxPage> {
    const res = await this.fetch(`/api/comments/inbox${qs(params ?? {})}`)
    const data = await parseJson<{ items?: RawInboxItem[]; total?: number; limit?: number; offset?: number }>(res)
    return normalizeCommentInbox(data)
  }

  async getCommentUnreadCount(): Promise<number> {
    const res = await this.fetch('/api/comments/unread-count')
    const data = await parseJson<{ count?: number }>(res)
    return typeof data?.count === 'number' ? data.count : 0
  }

  async markCommentRead(commentId: string): Promise<void> {
    const res = await this.fetch(`/api/comments/${commentId}/read`, { method: 'POST' })
    return parseJson(res)
  }

  // --- Form Share ---
  async getFormShareConfig(sheetId: string, viewId: string): Promise<FormShareConfig> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/views/${encodeURIComponent(viewId)}/form-share`)
    const data = await parseJson<Partial<FormShareConfig>>(res)
    return normalizeFormShareConfig(data)
  }

  async updateFormShareConfig(sheetId: string, viewId: string, config: FormShareConfigUpdate): Promise<FormShareConfig> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/views/${encodeURIComponent(viewId)}/form-share`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    })
    const data = await parseJson<Partial<FormShareConfig>>(res)
    return normalizeFormShareConfig(data)
  }

  async regenerateFormShareToken(sheetId: string, viewId: string): Promise<{ publicToken: string }> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/views/${encodeURIComponent(viewId)}/form-share/regenerate`, {
      method: 'POST',
    })
    return parseJson(res)
  }

  async listFormShareCandidates(
    sheetId: string,
    params?: { q?: string; limit?: number },
  ): Promise<{ items: MetaSheetPermissionCandidate[]; total: number; limit: number; query: string }> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/form-share-candidates${qs(params ?? {})}`)
    const data = await parseJson<{ items?: Array<Partial<MetaSheetPermissionCandidate>>; total?: number; limit?: number; query?: string }>(res)
    return normalizeSheetPermissionCandidates(data)
  }

  // --- API Tokens ---
  async listApiTokens(): Promise<ApiToken[]> {
    const res = await this.fetch('/api/multitable/tokens')
    const data = await parseJson<{ tokens: ApiToken[] }>(res)
    return data.tokens ?? []
  }

  async createApiToken(input: { name: string; scopes: string[]; expiresAt?: string }): Promise<ApiTokenCreateResult> {
    const res = await this.fetch('/api/multitable/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return parseJson(res)
  }

  async revokeApiToken(tokenId: string): Promise<void> {
    const res = await this.fetch(`/api/multitable/tokens/${encodeURIComponent(tokenId)}`, {
      method: 'DELETE',
    })
    return parseJson(res)
  }

  async rotateApiToken(tokenId: string): Promise<ApiTokenCreateResult> {
    const res = await this.fetch(`/api/multitable/tokens/${encodeURIComponent(tokenId)}/rotate`, {
      method: 'POST',
    })
    return parseJson(res)
  }

  // --- Webhooks ---
  async listWebhooks(): Promise<Webhook[]> {
    const res = await this.fetch('/api/multitable/webhooks')
    const data = await parseJson<{ webhooks: Webhook[] }>(res)
    return data.webhooks ?? []
  }

  async createWebhook(input: WebhookCreateInput): Promise<Webhook> {
    const res = await this.fetch('/api/multitable/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return parseJson(res)
  }

  async updateWebhook(id: string, input: Partial<WebhookCreateInput>): Promise<Webhook> {
    const res = await this.fetch(`/api/multitable/webhooks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return parseJson(res)
  }

  async deleteWebhook(id: string): Promise<void> {
    const res = await this.fetch(`/api/multitable/webhooks/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
    return parseJson(res)
  }

  async getWebhookDeliveries(id: string): Promise<WebhookDelivery[]> {
    const res = await this.fetch(`/api/multitable/webhooks/${encodeURIComponent(id)}/deliveries`)
    const data = await parseJson<{ deliveries: WebhookDelivery[] }>(res)
    return data.deliveries ?? []
  }

  // --- DingTalk Group Destinations ---
  async listDingTalkGroups(): Promise<DingTalkGroupDestination[]> {
    const res = await this.fetch('/api/multitable/dingtalk-groups')
    const data = await parseJson<{ destinations: DingTalkGroupDestination[] }>(res)
    return data.destinations ?? []
  }

  async createDingTalkGroup(input: DingTalkGroupDestinationInput): Promise<DingTalkGroupDestination> {
    const res = await this.fetch('/api/multitable/dingtalk-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return parseJson(res)
  }

  async updateDingTalkGroup(id: string, input: Partial<DingTalkGroupDestinationInput>): Promise<DingTalkGroupDestination> {
    const res = await this.fetch(`/api/multitable/dingtalk-groups/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return parseJson(res)
  }

  async deleteDingTalkGroup(id: string): Promise<void> {
    const res = await this.fetch(`/api/multitable/dingtalk-groups/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
    return parseJson(res)
  }

  async testDingTalkGroup(id: string, input?: { subject?: string; content?: string }): Promise<void> {
    const res = await this.fetch(`/api/multitable/dingtalk-groups/${encodeURIComponent(id)}/test-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input ?? {}),
    })
    return parseJson(res)
  }

  async getDingTalkGroupDeliveries(id: string): Promise<DingTalkGroupDelivery[]> {
    const res = await this.fetch(`/api/multitable/dingtalk-groups/${encodeURIComponent(id)}/deliveries`)
    const data = await parseJson<{ deliveries: DingTalkGroupDelivery[] }>(res)
    return data.deliveries ?? []
  }

  // --- Automation V1: test / logs / stats ---
  async testAutomationRule(sheetId: string, ruleId: string): Promise<AutomationExecution> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/automations/${encodeURIComponent(ruleId)}/test`,
      { method: 'POST' },
    )
    return parseJson<AutomationExecution>(res)
  }

  async getAutomationLogs(sheetId: string, ruleId: string, limit?: number): Promise<AutomationExecution[]> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/automations/${encodeURIComponent(ruleId)}/logs${qs({ limit })}`,
    )
    const data = await parseJson<{ executions: AutomationExecution[] }>(res)
    return Array.isArray(data?.executions) ? data.executions : []
  }

  async getAutomationStats(sheetId: string, ruleId: string): Promise<AutomationStats> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/automations/${encodeURIComponent(ruleId)}/stats`,
    )
    return parseJson<AutomationStats>(res)
  }

  async getAutomationDingTalkPersonDeliveries(sheetId: string, ruleId: string, limit?: number): Promise<DingTalkPersonDelivery[]> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/automations/${encodeURIComponent(ruleId)}/dingtalk-person-deliveries${qs({ limit })}`,
    )
    const data = await parseJson<{ deliveries: DingTalkPersonDelivery[] }>(res)
    return Array.isArray(data?.deliveries) ? data.deliveries : []
  }

  async getAutomationDingTalkGroupDeliveries(sheetId: string, ruleId: string, limit?: number): Promise<DingTalkGroupDelivery[]> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/automations/${encodeURIComponent(ruleId)}/dingtalk-group-deliveries${qs({ limit })}`,
    )
    const data = await parseJson<{ deliveries: DingTalkGroupDelivery[] }>(res)
    return Array.isArray(data?.deliveries) ? data.deliveries : []
  }

  // --- Charts ---
  async listCharts(sheetId: string): Promise<ChartConfig[]> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/charts`)
    const data = await parseJson<{ charts: ChartConfig[] }>(res)
    return Array.isArray(data?.charts) ? data.charts : []
  }

  async createChart(sheetId: string, input: ChartCreateInput): Promise<ChartConfig> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/charts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return parseJson<ChartConfig>(res)
  }

  async updateChart(sheetId: string, chartId: string, input: Partial<ChartCreateInput>): Promise<ChartConfig> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/charts/${encodeURIComponent(chartId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    )
    return parseJson<ChartConfig>(res)
  }

  async deleteChart(sheetId: string, chartId: string): Promise<void> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/charts/${encodeURIComponent(chartId)}`,
      { method: 'DELETE' },
    )
    await parseJson(res)
  }

  async getChartData(sheetId: string, chartId: string): Promise<ChartData> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/charts/${encodeURIComponent(chartId)}/data`,
    )
    return parseJson<ChartData>(res)
  }

  // --- Dashboards ---
  async listDashboards(sheetId: string): Promise<Dashboard[]> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/dashboards`)
    const data = await parseJson<{ dashboards: Dashboard[] }>(res)
    return Array.isArray(data?.dashboards) ? data.dashboards : []
  }

  async createDashboard(sheetId: string, input: { name: string }): Promise<Dashboard> {
    const res = await this.fetch(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/dashboards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return parseJson<Dashboard>(res)
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
    return parseJson<Dashboard>(res)
  }

  async deleteDashboard(sheetId: string, dashboardId: string): Promise<void> {
    const res = await this.fetch(
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/dashboards/${encodeURIComponent(dashboardId)}`,
      { method: 'DELETE' },
    )
    await parseJson(res)
  }
}

/** Singleton client for production usage */
export const multitableClient = new MultitableApiClient()
