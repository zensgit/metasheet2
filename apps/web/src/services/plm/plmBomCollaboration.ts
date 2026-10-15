import { apiFetch } from '../../utils/api'

export interface PlmBomCollaborationPreview {
  previewId: string
  expiresAt: string
  snapshotHash: string
  snapshotAt: string
  part: { partId: string; itemNumber: string | null; name: string | null }
  lineCount: number
  occurrenceCount: number
  source: { tenantId: string; orgId: string; authUserId: string; partId: string }
}
export interface PlmBomCollaborationBinding {
  id: string
  version: number
  dataSourceId: string
  partId: string
  baseId: string
  sheetId: string
  viewId: string
  name: string
  status: 'active' | 'stale' | 'disabled'
  lastSyncedAt: string
  sourceSnapshotHash: string
  lineCount: number
  occurrenceCount: number
  navigationPath: string
  canRefresh: boolean
  canDisable: boolean
  canConfigureNotifications?: boolean
}

const BASE = '/api/plm-bom-reviews'
const messages: Record<string, string> = {
  PLM_BOM_REVIEW_DISABLED: '此部署尚未启用 BOM 协作表。',
  ENDPOINT_UNAVAILABLE: 'BOM 协作表入口当前不可用，请联系部署管理员确认是否启用。',
  INVALID_REQUEST: '请求无效，请检查目标表名称后重试。',
  FORBIDDEN: '当前账号无权管理此来源或目标协作表。',
  WEBHOOK_SEND_FORBIDDEN: '当前账号无权发送 Webhook，仍可停用已有规则。',
  SOURCE_UNAVAILABLE: '暂时无法读取 PLM 来源，请稍后重试。',
  SOURCE_FORBIDDEN: 'PLM 来源权限已失效，无法分享或刷新快照。',
  SOURCE_UNENTITLED: 'PLM 当前未开通此来源分享能力。',
  SOURCE_CHANGED: '来源快照已变化，请重新预览并确认。',
  PREVIEW_EXPIRED: '分享预览已过期，请重新预览并确认。',
  VERSION_CONFLICT: '协作绑定已被修改，请重新加载状态。',
  BINDING_CONFLICT: '此来源或目标已存在不兼容的绑定，请重新加载状态。',
  NOT_FOUND: '未找到当前可访问的来源或协作表。',
  RUNTIME_UNAVAILABLE: '协作表服务暂时不可用，请稍后重试。',
  REVIEW_STATE_NOT_INITIALIZED: '此协作表尚未初始化评审流程，请联系管理员。',
}
export class PlmBomCollaborationError extends Error {
  readonly code: string
  constructor(code: string) {
    super(messages[code] ?? '请求未完成，请重新加载状态后重试。')
    this.name = 'PlmBomCollaborationError'
    this.code = code
  }
}
function invalid(): never { throw new PlmBomCollaborationError('INVALID_RESPONSE') }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
function text(value: unknown): string { return typeof value === 'string' && value.length > 0 ? value : invalid() }
function nullableText(value: unknown): string | null { return value === null ? null : typeof value === 'string' ? value : invalid() }
function count(value: unknown): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid() }
function timestamp(value: unknown): string {
  const result = text(value)
  return Number.isFinite(Date.parse(result)) ? result : invalid()
}
function binding(value: unknown): PlmBomCollaborationBinding {
  const row = object(value)
  if (!['active', 'stale', 'disabled'].includes(String(row.status)) || typeof row.status !== 'string'
    || typeof row.canRefresh !== 'boolean' || typeof row.canDisable !== 'boolean'
    || (row.canConfigureNotifications !== undefined && typeof row.canConfigureNotifications !== 'boolean')) return invalid()
  const version = count(row.version)
  if (version < 1) return invalid()
  return {
    id: text(row.id), version, dataSourceId: text(row.dataSourceId), partId: text(row.partId),
    baseId: text(row.baseId), sheetId: text(row.sheetId), viewId: text(row.viewId), name: text(row.name),
    status: row.status as PlmBomCollaborationBinding['status'], lastSyncedAt: timestamp(row.lastSyncedAt),
    sourceSnapshotHash: text(row.sourceSnapshotHash), lineCount: count(row.lineCount),
    occurrenceCount: count(row.occurrenceCount), navigationPath: text(row.navigationPath),
    canRefresh: row.canRefresh, canDisable: row.canDisable,
    ...(row.canConfigureNotifications === undefined ? {} : { canConfigureNotifications: row.canConfigureNotifications }),
  }
}
async function call(path: string, method: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  let response: Response
  try {
    response = await apiFetch(path, { method, signal, cache: 'no-store', suppressUnauthorizedRedirect: true,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  } catch { throw new PlmBomCollaborationError('RUNTIME_UNAVAILABLE') }
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.ok !== true) {
    if (response.status === 404 && !payload?.error?.code) throw new PlmBomCollaborationError('ENDPOINT_UNAVAILABLE')
    const code = payload?.error?.code
    throw new PlmBomCollaborationError(typeof code === 'string' && Object.prototype.hasOwnProperty.call(messages, code) ? code : 'REQUEST_FAILED')
  }
  return payload.data
}
export async function listPlmBomCollaborationBases(signal?: AbortSignal): Promise<Array<{ id: string; name: string }>> {
  const data = object(await call(`${BASE}/bases`, 'GET', undefined, signal))
  if (!Array.isArray(data.items)) return invalid()
  return data.items.map((value) => { const row = object(value); return { id: text(row.id), name: text(row.name) } })
}
export async function previewPlmBomCollaboration(input: { dataSourceId: string; partId: string; baseId: string; name: string }, signal?: AbortSignal): Promise<PlmBomCollaborationPreview> {
  const { partId } = input
  const data = object(await call(`${BASE}/preview`, 'POST', input, signal))
  const part = object(data.part), source = object(data.source)
  if (part.partId !== partId || source.partId !== partId) return invalid()
  return {
    previewId: text(data.previewId), expiresAt: timestamp(data.expiresAt),
    snapshotHash: text(data.snapshotHash), snapshotAt: timestamp(data.snapshotAt),
    part: { partId, itemNumber: nullableText(part.itemNumber), name: nullableText(part.name) },
    lineCount: count(data.lineCount), occurrenceCount: count(data.occurrenceCount),
    source: { tenantId: text(source.tenantId), orgId: text(source.orgId), authUserId: text(source.authUserId), partId },
  }
}
export async function createPlmBomCollaboration(previewId: string, requestId: string, signal?: AbortSignal): Promise<PlmBomCollaborationBinding> {
  return binding(await call(BASE, 'POST', { previewId, requestId }, signal))
}
export async function listPlmBomCollaborations(dataSourceId: string, partId: string, signal?: AbortSignal): Promise<PlmBomCollaborationBinding[]> {
  const query = new URLSearchParams({ dataSourceId, partId })
  const data = object(await call(`${BASE}?${query}`, 'GET', undefined, signal))
  if (!Array.isArray(data.items)) return invalid()
  const result = data.items.map(binding)
  if (result.some((row) => row.dataSourceId !== dataSourceId || row.partId !== partId)) return invalid()
  return result
}
export async function changePlmBomCollaboration(id: string, action: 'refresh' | 'disable', expectedVersion: number, signal?: AbortSignal): Promise<PlmBomCollaborationBinding> {
  const result = binding(await call(`${BASE}/${encodeURIComponent(id)}/${action}`, 'POST', { expectedVersion }, signal))
  if (result.id !== id) return invalid()
  return result
}

export type BomRecipientStrategy = 'event_owner' | 'current_owner'
export interface BomNotifications {
  issue: { enabled: boolean; recipientStrategy: BomRecipientStrategy | null }
  reminder: { enabled: boolean; recipientStrategy: BomRecipientStrategy | null; leadMinutes: number | null }
  escalation: { enabled: boolean; slaMinutes: number | null; recipientUserIds: string[] }
}
export interface BomNotificationConfig { version: number; notifications: BomNotifications | null }
function notificationConfig(value: unknown): BomNotificationConfig {
  const row = object(value), version = count(row.version)
  if (row.notifications === null) return version === 0 ? { version, notifications: null } : invalid()
  if (version < 1) return invalid()
  const n = object(row.notifications), issue = object(n.issue), reminder = object(n.reminder), escalation = object(n.escalation)
  const strategy = (v: unknown): BomRecipientStrategy | null => v === null || v === 'event_owner' || v === 'current_owner' ? v : invalid()
  const enabled = (v: unknown): boolean => typeof v === 'boolean' ? v : invalid()
  const duration = (v: unknown) => v === null ? null : count(v)
  if (!Array.isArray(escalation.recipientUserIds)) return invalid()
  const result: BomNotifications = {
    issue: { enabled: enabled(issue.enabled), recipientStrategy: strategy(issue.recipientStrategy) },
    reminder: { enabled: enabled(reminder.enabled), recipientStrategy: strategy(reminder.recipientStrategy), leadMinutes: duration(reminder.leadMinutes) },
    escalation: { enabled: enabled(escalation.enabled), slaMinutes: duration(escalation.slaMinutes), recipientUserIds: escalation.recipientUserIds.map(text) },
  }
  if ((result.issue.enabled && result.issue.recipientStrategy === null) ||
    (result.reminder.enabled && (result.reminder.leadMinutes === null || result.reminder.recipientStrategy === null)) ||
    (result.escalation.enabled && (!result.escalation.slaMinutes || !result.escalation.recipientUserIds.length)) ||
    new Set(result.escalation.recipientUserIds).size !== result.escalation.recipientUserIds.length) return invalid()
  return { version, notifications: result }
}
export async function getBomNotifications(id: string, signal?: AbortSignal): Promise<BomNotificationConfig> {
  return notificationConfig(await call(`${BASE}/${encodeURIComponent(id)}/notifications`, 'GET', undefined, signal))
}
export async function saveBomNotifications(id: string, config: { expectedVersion: number; notifications: BomNotifications }, signal?: AbortSignal): Promise<BomNotificationConfig> {
  const result = notificationConfig(await call(`${BASE}/${encodeURIComponent(id)}/notifications`, 'POST', config, signal))
  if (!result.notifications || result.version < config.expectedVersion || result.version > config.expectedVersion+1) return invalid()
  return result
}
export async function searchBomNotificationRecipients(id: string, q: string, signal?: AbortSignal) {
  const data = object(await call(`${BASE}/${encodeURIComponent(id)}/notification-recipients?${new URLSearchParams({ q })}`, 'GET', undefined, signal))
  if (!Array.isArray(data.items)) return invalid()
  return data.items.map((value) => { const user = object(value); return { id: text(user.id), name: text(user.name) } })
}


export interface BomCompletionWebhooks {
  reviewCompleted: { enabled: boolean; webhookId: string | null; granularity: 'bom' | 'row' | null }
  plmChangeApplied: { enabled: boolean; webhookId: string | null; source: 'bom_line_writeback' | 'eco_batch_apply' | null }
}
export interface BomCompletionWebhookConfig { version: number; webhooks: BomCompletionWebhooks | null }
function completionConfig(value: unknown): BomCompletionWebhookConfig {
  const row = object(value), version = count(row.version)
  if (row.webhooks === null) return version === 0 ? { version,webhooks: null } : invalid()
  if (version < 1) return invalid()
  const webhooks = object(row.webhooks)
  function rule(value: unknown) {
    const r = object(value)
    if (typeof r.enabled !== 'boolean' || (r.webhookId !== null && (typeof r.webhookId !== 'string' || !r.webhookId))) return invalid()
    if (r.enabled && r.webhookId === null) return invalid()
    return { enabled: r.enabled,webhookId: r.webhookId as string | null }
  }
  const review = object(webhooks.reviewCompleted), plm = object(webhooks.plmChangeApplied)
  const granularity = review.granularity ?? null, source = plm.source ?? null
  if (granularity !== null && granularity !== 'bom' && granularity !== 'row') return invalid()
  if (source !== null && source !== 'bom_line_writeback' && source !== 'eco_batch_apply') return invalid()
  // Existing rules predate these choices. Show an unselected mode; never guess a trigger.
  return { version,webhooks: { reviewCompleted: { ...rule(review),granularity },plmChangeApplied: { ...rule(plm),source } } }
}
export async function getBomCompletionWebhooks(id: string, signal?: AbortSignal): Promise<BomCompletionWebhookConfig> {
  return completionConfig(await call(`${BASE}/${encodeURIComponent(id)}/completion-webhooks`,'GET',undefined,signal))
}
export async function saveBomCompletionWebhooks(id: string, config: { expectedVersion: number; webhooks: BomCompletionWebhooks }, signal?: AbortSignal): Promise<BomCompletionWebhookConfig> {
  const result = completionConfig(await call(`${BASE}/${encodeURIComponent(id)}/completion-webhooks`,'POST',config,signal))
  if (!result.webhooks || result.version < config.expectedVersion || result.version > config.expectedVersion+1) return invalid()
  return result
}
export async function listBomCompletionWebhookDestinations(id: string, signal?: AbortSignal) {
  const values = await call(`${BASE}/${encodeURIComponent(id)}/completion-webhook-destinations`,'GET',undefined,signal)
  if (!Array.isArray(values)) return invalid()
  return values.map((value) => { const row = object(value); return { id: text(row.id),name: text(row.name) } })
}
