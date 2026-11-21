import { apiFetch } from '../utils/api'

export const NOTIFICATION_PROOF_KINDS = ['directory_link', 'external_identity'] as const
export type NotificationProofKind = (typeof NOTIFICATION_PROOF_KINDS)[number]

export const NOTIFICATION_UNUSABLE_REASONS = [
  'connection_not_found',
  'connection_inactive',
  'provider_not_registered',
  'proof_kind_unavailable',
  'proof_missing',
  'proof_not_linked',
  'proof_wrong_user',
  'proof_ambiguous',
  'proof_account_inactive',
  'proof_changed',
  'proof_assurance_insufficient',
  'address_missing',
  'address_unusable',
  'address_kind_not_derivable',
  'address_bound_on_other_connection',
  'scope_unproven',
  'scope_changed',
  'user_not_active_member',
  'endpoint_not_found',
  'endpoint_stale',
] as const
export type NotificationUnusableReason = (typeof NOTIFICATION_UNUSABLE_REASONS)[number]

export const NOTIFICATION_APPLIES_REASONS = [
  'topic_not_integrated',
  'org_not_taken_over',
  'org_paused',
  'delivery_disabled',
  'capability_off',
] as const
export type NotificationAppliesReason = (typeof NOTIFICATION_APPLIES_REASONS)[number]

export interface NotificationConnection {
  id: string
  provider: string
  label: string
}

export interface NotificationDelivery {
  enabled: boolean
  testSendAvailable: boolean
  reason: string | null
}

export interface NotificationEndpoint {
  id: string
  connection: NotificationConnection
  addressKind: 'dingtalk_userid' | 'wecom_userid' | 'feishu_open_id'
  proofKind: NotificationProofKind
  status: 'active' | 'stale'
  revision: number
  usable: boolean
  unusableReason: NotificationUnusableReason | null
  capability: { effective: boolean; reason: string | null }
  verified: boolean
  lastVerifiedAt: string
}

export interface NotificationCandidate {
  connection: NotificationConnection
  proofKind: NotificationProofKind
  addressable: boolean
  reasonCode: Exclude<NotificationUnusableReason, 'endpoint_stale'> | null
  endpointId: string | null
}

export interface NotificationEndpointsListing {
  delivery: NotificationDelivery
  endpoints: NotificationEndpoint[]
  candidates: NotificationCandidate[]
}

export interface NotificationQuietHours {
  start: string
  end: string
  timeZone: string
}

export interface NotificationPreference {
  enabled: boolean
  primaryEndpointId: string | null
  fallbackEndpointId: string | null
  quietHours: NotificationQuietHours | null
  revision: number
}

export interface NotificationTopic {
  topic: 'task_reminder'
  integrated: boolean
  applies: { now: boolean; reason: NotificationAppliesReason | null }
  preference: NotificationPreference | null
  effective: {
    source: 'user_primary' | 'org_default' | 'none'
    connection: NotificationConnection | null
    usable: boolean
    fallback: { connection: NotificationConnection; usable: boolean } | null
  }
}

export interface NotificationPreferencesListing {
  topics: NotificationTopic[]
}

export type NotificationReadResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'disabled' }
  | { kind: 'forbidden' }
  | { kind: 'error'; status: number }

export type NotificationWriteFailure =
  | { kind: 'disabled' }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'conflict'; code: string; currentRevision?: number }
  | { kind: 'validation'; code: string; reason?: string }
  | { kind: 'error'; status: number }

export type NotificationEndpointWriteResult =
  | { kind: 'ok'; endpoint: NotificationEndpoint }
  | NotificationWriteFailure

export type NotificationRevokeResult =
  | { kind: 'ok'; endpoint: { id: string; status: 'revoked'; revision: number } }
  | NotificationWriteFailure

export interface NotificationPreferencePatch {
  topic: 'task_reminder'
  expectedRevision: number
  enabled?: boolean
  primaryEndpointId?: string | null
  fallbackEndpointId?: string | null
  quietHours?: NotificationQuietHours | null
}

export type NotificationPreferenceWriteResult =
  | { kind: 'ok'; topic: NotificationTopic }
  | NotificationWriteFailure

export type NotificationTestSendResult =
  | { kind: 'accepted' }
  | { kind: 'failure'; status: number }
  | { kind: 'unknown'; status: number }
  | { kind: 'rate_limited'; retryAfterSeconds: number | null }

const ENDPOINTS_PATH = '/api/me/notification-endpoints'
const PREFERENCES_PATH = '/api/me/notification-preferences'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/
const TIME_ZONE = /^[A-Za-z0-9_+/-]{1,64}$/
const ADDRESS_KINDS = ['dingtalk_userid', 'wecom_userid', 'feishu_open_id'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | null {
  if (!isRecord(value)) return null
  const allowed = new Set([...required, ...optional])
  const keys = Object.keys(value)
  if (keys.some((key) => !allowed.has(key))) return null
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) return null
  return value
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

function isNullableUuid(value: unknown): value is string | null {
  return value === null || isUuid(value)
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isLiteral<T extends readonly string[]>(value: unknown, choices: T): value is T[number] {
  return typeof value === 'string' && (choices as readonly string[]).includes(value)
}

function parseConnection(value: unknown): NotificationConnection | null {
  const record = exactRecord(value, ['id', 'provider', 'label'])
  if (!record || !isUuid(record.id) || typeof record.provider !== 'string' || record.provider.length === 0 || typeof record.label !== 'string') return null
  return { id: record.id, provider: record.provider, label: record.label }
}

function parseEndpoint(value: unknown): NotificationEndpoint | null {
  const record = exactRecord(value, [
    'id',
    'connection',
    'addressKind',
    'proofKind',
    'status',
    'revision',
    'usable',
    'unusableReason',
    'capability',
    'verified',
    'lastVerifiedAt',
  ])
  if (!record || !isUuid(record.id) || !isLiteral(record.addressKind, ADDRESS_KINDS)) return null
  if (!isLiteral(record.proofKind, NOTIFICATION_PROOF_KINDS) || !isLiteral(record.status, ['active', 'stale'] as const)) return null
  if (!isRevision(record.revision) || typeof record.usable !== 'boolean' || typeof record.verified !== 'boolean') return null
  if (!(record.unusableReason === null || isLiteral(record.unusableReason, NOTIFICATION_UNUSABLE_REASONS))) return null
  if (typeof record.lastVerifiedAt !== 'string') return null
  const connection = parseConnection(record.connection)
  const capability = exactRecord(record.capability, ['effective', 'reason'])
  if (!connection || !capability || typeof capability.effective !== 'boolean' || !isNullableString(capability.reason)) return null
  return {
    id: record.id,
    connection,
    addressKind: record.addressKind,
    proofKind: record.proofKind,
    status: record.status,
    revision: record.revision,
    usable: record.usable,
    unusableReason: record.unusableReason,
    capability: { effective: capability.effective, reason: capability.reason },
    verified: record.verified,
    lastVerifiedAt: record.lastVerifiedAt,
  }
}

function parseCandidate(value: unknown): NotificationCandidate | null {
  const record = exactRecord(value, ['connection', 'proofKind', 'addressable', 'reasonCode', 'endpointId'])
  if (!record || !isLiteral(record.proofKind, NOTIFICATION_PROOF_KINDS) || typeof record.addressable !== 'boolean' || !isNullableUuid(record.endpointId)) return null
  const reasons = NOTIFICATION_UNUSABLE_REASONS.filter((reason) => reason !== 'endpoint_stale')
  if (!(record.reasonCode === null || isLiteral(record.reasonCode, reasons))) return null
  const connection = parseConnection(record.connection)
  if (!connection) return null
  return {
    connection,
    proofKind: record.proofKind,
    addressable: record.addressable,
    reasonCode: record.reasonCode as NotificationCandidate['reasonCode'],
    endpointId: record.endpointId,
  }
}

export function parseNotificationEndpointsListing(value: unknown): NotificationEndpointsListing | null {
  const record = exactRecord(value, ['delivery', 'endpoints', 'candidates'])
  if (!record || !Array.isArray(record.endpoints) || !Array.isArray(record.candidates)) return null
  const delivery = exactRecord(record.delivery, ['enabled'], ['testSendAvailable', 'reason'])
  if (!delivery || typeof delivery.enabled !== 'boolean') return null
  if (delivery.testSendAvailable !== undefined && typeof delivery.testSendAvailable !== 'boolean') return null
  if (delivery.reason !== undefined && !isNullableString(delivery.reason)) return null
  const endpoints: NotificationEndpoint[] = []
  const candidates: NotificationCandidate[] = []
  for (const item of record.endpoints) {
    const parsed = parseEndpoint(item)
    if (!parsed) return null
    endpoints.push(parsed)
  }
  for (const item of record.candidates) {
    const parsed = parseCandidate(item)
    if (!parsed) return null
    candidates.push(parsed)
  }
  return {
    delivery: {
      enabled: delivery.enabled,
      testSendAvailable: delivery.testSendAvailable === true,
      reason: delivery.reason === undefined ? null : delivery.reason,
    },
    endpoints,
    candidates,
  }
}

function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !TIME_ZONE.test(value)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0)
    return true
  } catch {
    return false
  }
}

function parseQuietHours(value: unknown): NotificationQuietHours | null {
  const record = exactRecord(value, ['start', 'end', 'timeZone'])
  if (!record || typeof record.start !== 'string' || typeof record.end !== 'string') return null
  if (!CLOCK.test(record.start) || !CLOCK.test(record.end) || record.start === record.end || !isValidTimeZone(record.timeZone)) return null
  return { start: record.start, end: record.end, timeZone: record.timeZone }
}

function parsePreference(value: unknown): NotificationPreference | null {
  const record = exactRecord(value, ['enabled', 'primaryEndpointId', 'fallbackEndpointId', 'quietHours', 'revision'])
  if (!record || typeof record.enabled !== 'boolean' || !isNullableUuid(record.primaryEndpointId) || !isNullableUuid(record.fallbackEndpointId) || !isRevision(record.revision)) return null
  let quietHours: NotificationQuietHours | null = null
  if (record.quietHours !== null) {
    quietHours = parseQuietHours(record.quietHours)
    if (!quietHours) return null
  }
  return {
    enabled: record.enabled,
    primaryEndpointId: record.primaryEndpointId,
    fallbackEndpointId: record.fallbackEndpointId,
    quietHours,
    revision: record.revision,
  }
}

export function parseNotificationTopic(value: unknown): NotificationTopic | null {
  const record = exactRecord(value, ['topic', 'integrated', 'applies', 'preference', 'effective'])
  if (!record || record.topic !== 'task_reminder' || typeof record.integrated !== 'boolean') return null
  const applies = exactRecord(record.applies, ['now', 'reason'])
  if (!applies || typeof applies.now !== 'boolean' || !(applies.reason === null || isLiteral(applies.reason, NOTIFICATION_APPLIES_REASONS))) return null
  const effective = exactRecord(record.effective, ['source', 'connection', 'usable', 'fallback'])
  if (!effective || !isLiteral(effective.source, ['user_primary', 'org_default', 'none'] as const) || typeof effective.usable !== 'boolean') return null
  const connection = effective.connection === null ? null : parseConnection(effective.connection)
  if (effective.connection !== null && !connection) return null
  let fallback: NotificationTopic['effective']['fallback'] = null
  if (effective.fallback !== null) {
    const fallbackRecord = exactRecord(effective.fallback, ['connection', 'usable'])
    const fallbackConnection = fallbackRecord ? parseConnection(fallbackRecord.connection) : null
    if (!fallbackRecord || !fallbackConnection || typeof fallbackRecord.usable !== 'boolean') return null
    fallback = { connection: fallbackConnection, usable: fallbackRecord.usable }
  }
  let preference: NotificationPreference | null = null
  if (record.preference !== null) {
    preference = parsePreference(record.preference)
    if (!preference) return null
  }
  return {
    topic: 'task_reminder',
    integrated: record.integrated,
    applies: { now: applies.now, reason: applies.reason },
    preference,
    effective: { source: effective.source, connection, usable: effective.usable, fallback },
  }
}

export function parseNotificationPreferencesListing(value: unknown): NotificationPreferencesListing | null {
  const record = exactRecord(value, ['topics'])
  if (!record || !Array.isArray(record.topics)) return null
  const topics: NotificationTopic[] = []
  for (const item of record.topics) {
    const parsed = parseNotificationTopic(item)
    if (!parsed) return null
    topics.push(parsed)
  }
  return { topics }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function errorDetails(body: unknown): { code: string | null; reason?: string; currentRevision?: number } {
  if (!isRecord(body) || !isRecord(body.error) || typeof body.error.code !== 'string') return { code: null }
  const result: { code: string; reason?: string; currentRevision?: number } = { code: body.error.code }
  if (typeof body.error.reason === 'string') result.reason = body.error.reason
  if (isRevision(body.error.currentRevision)) result.currentRevision = body.error.currentRevision
  return result
}

async function read<T>(path: string, parse: (value: unknown) => T | null): Promise<NotificationReadResult<T>> {
  let response: Response
  try {
    response = await apiFetch(path)
  } catch {
    return { kind: 'error', status: 0 }
  }
  if (response.status === 404) return { kind: 'disabled' }
  if (response.status === 403) return { kind: 'forbidden' }
  if (response.status !== 200) return { kind: 'error', status: response.status }
  const value = parse(await safeJson(response))
  return value === null ? { kind: 'error', status: response.status } : { kind: 'ok', value }
}

async function writeFailure(response: Response): Promise<NotificationWriteFailure> {
  if (response.status === 404) return { kind: 'not_found' }
  if (response.status === 403) return { kind: 'forbidden' }
  const body = await safeJson(response)
  const details = errorDetails(body)
  if (response.status === 409 && details.code !== null) {
    return { kind: 'conflict', code: details.code, ...(details.currentRevision === undefined ? {} : { currentRevision: details.currentRevision }) }
  }
  if (response.status === 422 && details.code !== null) {
    return { kind: 'validation', code: details.code, ...(details.reason === undefined ? {} : { reason: details.reason }) }
  }
  return { kind: 'error', status: response.status }
}

export function listNotificationEndpoints(): Promise<NotificationReadResult<NotificationEndpointsListing>> {
  return read(ENDPOINTS_PATH, parseNotificationEndpointsListing)
}

export function listNotificationPreferences(): Promise<NotificationReadResult<NotificationPreferencesListing>> {
  return read(PREFERENCES_PATH, parseNotificationPreferencesListing)
}

export async function establishNotificationEndpoint(input: { connectionId: string; proofKind: NotificationProofKind }): Promise<NotificationEndpointWriteResult> {
  let response: Response
  try {
    response = await apiFetch(ENDPOINTS_PATH, {
      method: 'POST',
      body: JSON.stringify({ connectionId: input.connectionId, proofKind: input.proofKind }),
    })
  } catch {
    return { kind: 'error', status: 0 }
  }
  if (response.status !== 200 && response.status !== 201) return writeFailure(response)
  const body = exactRecord(await safeJson(response), ['endpoint'])
  const endpoint = body ? parseEndpoint(body.endpoint) : null
  return endpoint ? { kind: 'ok', endpoint } : { kind: 'error', status: response.status }
}

export async function revokeNotificationEndpoint(endpointId: string): Promise<NotificationRevokeResult> {
  if (!isUuid(endpointId)) return { kind: 'not_found' }
  let response: Response
  try {
    response = await apiFetch(`${ENDPOINTS_PATH}/${encodeURIComponent(endpointId)}`, { method: 'DELETE' })
  } catch {
    return { kind: 'error', status: 0 }
  }
  if (response.status !== 200) return writeFailure(response)
  const body = exactRecord(await safeJson(response), ['endpoint'])
  const endpoint = body ? exactRecord(body.endpoint, ['id', 'status', 'revision']) : null
  if (!endpoint || !isUuid(endpoint.id) || endpoint.status !== 'revoked' || !isRevision(endpoint.revision)) {
    return { kind: 'error', status: response.status }
  }
  return { kind: 'ok', endpoint: { id: endpoint.id, status: 'revoked', revision: endpoint.revision } }
}

export async function patchNotificationPreference(patch: NotificationPreferencePatch): Promise<NotificationPreferenceWriteResult> {
  const body: Record<string, unknown> = { topic: patch.topic, expectedRevision: patch.expectedRevision }
  if (patch.enabled !== undefined) body.enabled = patch.enabled
  if (patch.primaryEndpointId !== undefined) body.primaryEndpointId = patch.primaryEndpointId
  if (patch.fallbackEndpointId !== undefined) body.fallbackEndpointId = patch.fallbackEndpointId
  if (patch.quietHours !== undefined) {
    body.quietHours = patch.quietHours === null ? null : {
      start: patch.quietHours.start,
      end: patch.quietHours.end,
      timeZone: patch.quietHours.timeZone,
    }
  }
  let response: Response
  try {
    response = await apiFetch(PREFERENCES_PATH, { method: 'PATCH', body: JSON.stringify(body) })
  } catch {
    return { kind: 'error', status: 0 }
  }
  if (response.status !== 200) return writeFailure(response)
  const topic = parseNotificationTopic(await safeJson(response))
  return topic ? { kind: 'ok', topic } : { kind: 'error', status: response.status }
}

function header(response: Response, name: string): string | null {
  try {
    return response.headers.get(name)
  } catch {
    return null
  }
}

function retryAfterSeconds(response: Response): number | null {
  const raw = header(response, 'Retry-After')
  if (raw !== null) {
    if (/^\d+$/.test(raw.trim())) return Number(raw.trim())
    const instant = Date.parse(raw)
    if (Number.isFinite(instant)) return Math.max(0, Math.ceil((instant - Date.now()) / 1000))
  }
  const reset = header(response, 'X-RateLimit-Reset')
  if (reset !== null && /^\d+(?:\.\d+)?$/.test(reset.trim())) {
    return Math.max(0, Math.ceil(Number(reset.trim()) - Date.now() / 1000))
  }
  return null
}

export async function testNotificationEndpoint(endpointId: string): Promise<NotificationTestSendResult> {
  if (!isUuid(endpointId)) return { kind: 'failure', status: 0 }
  let response: Response
  try {
    response = await apiFetch(`${ENDPOINTS_PATH}/${encodeURIComponent(endpointId)}/test-send`, { method: 'POST' })
  } catch {
    return { kind: 'unknown', status: 0 }
  }
  if (response.status === 200 || response.status === 201 || response.status === 202) return { kind: 'accepted' }
  if (response.status === 429) return { kind: 'rate_limited', retryAfterSeconds: retryAfterSeconds(response) }
  if (response.status === 502 || response.status === 504) return { kind: 'unknown', status: response.status }
  return { kind: 'failure', status: response.status }
}

export function resolveNotificationBrowserTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof zone === 'string' && isValidTimeZone(zone) ? zone : ''
  } catch {
    return ''
  }
}
