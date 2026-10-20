import { withAuthIdentityLock } from '../../composables/authIdentityLock'
import { readStoredToken } from '../../composables/authPrincipal'

export type ChangeReadTarget = { id: string; name: string; version: number; baseId: string; sheetId: string }
export type ChangeReadSource = { dataSourceId: string; partId: string }
export type ChangeReadState = { bound: boolean; purpose: 'bom_change_read'; status?: string; grantId?: string; expiresAt?: string; pending?: number; rejected?: number }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const GRANT = /^yue_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/
function fail(): never { throw new Error('操作未完成。请确认个人身份、目标权限和个人变更读取授权后重试。') }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  return value as Record<string, unknown>
}
function keys(row: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(row).some(key => !allowed.includes(key))) fail()
}
function text(value: unknown, maximum = 128): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || [...value].length > maximum
    || /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value)) fail()
  return value
}
function bindingId(value: string): string { if (!UUID.test(value)) fail(); return value }
function positive(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail(); return value }
async function api(path: string, method = 'GET', body?: unknown, action?: string): Promise<Record<string, unknown>> {
  return withAuthIdentityLock(async () => {
    if (readStoredToken()) fail()
    const response = await fetch(new URL('/api/plm-bom-reviews/' + path, window.location.origin), {
      method, credentials: 'include', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-plm-change-read': action! },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) fail()
    const result = record(await response.json()); keys(result, ['ok', 'data'])
    if (result.ok !== true) fail()
    return record(result.data)
  }, { failClosed: true })
}
export async function changeReadTargets(source: ChangeReadSource): Promise<ChangeReadTarget[]> {
  const row = await api('managed-change-read/targets?' + new URLSearchParams({ dataSourceId: text(source.dataSourceId), partId: text(source.partId) }))
  keys(row, ['items']); if (!Array.isArray(row.items)) fail()
  const seen = new Set<string>()
  return row.items.map(value => {
    const item = record(value); keys(item, ['id', 'name', 'version', 'baseId', 'sheetId'])
    const id = bindingId(text(item.id)); if (seen.has(id)) fail(); seen.add(id)
    return { id, name: text(item.name, 200), version: positive(item.version), baseId: text(item.baseId), sheetId: text(item.sheetId) }
  })
}
export async function changeReadManagement(source: ChangeReadSource, target: ChangeReadTarget): Promise<string> {
  const row = await api(bindingId(target.id) + '/personal-change-read/management-url')
  keys(row, ['url', 'expectedVersion']); if (row.expectedVersion !== target.version) fail()
  const url = new URL(text(row.url, 70000))
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search
    || url.pathname !== '/personal-approval-grants' || !url.hash.startsWith('#bom-change-read?')) fail()
  const params = new URLSearchParams(url.hash.slice('#bom-change-read?'.length))
  if ([...params.keys()].join() !== 'request') fail()
  const consent = record(JSON.parse(params.get('request')!))
  keys(consent, ['connection_id', 'root_part_id', 'target', 'review_binding_id', 'review_binding_version'])
  text(consent.connection_id)
  if (consent.root_part_id !== source.partId || consent.review_binding_id !== target.id || consent.review_binding_version !== target.version) fail()
  const destination = record(consent.target)
  keys(destination, ['tenant_id', 'org_id', 'user_id', 'base_id', 'sheet_id', 'source_id', 'binding_id', 'binding_generation', 'session_id', 'audience'])
  for (const key of ['tenant_id', 'org_id', 'user_id', 'binding_id', 'session_id']) text(destination[key])
  positive(destination.binding_generation); text(destination.audience, 1000)
  if (destination.source_id !== source.dataSourceId || destination.base_id !== target.baseId || destination.sheet_id !== target.sheetId) fail()
  return url.href
}
function state(row: Record<string, unknown>): ChangeReadState {
  keys(row, ['bound', 'purpose', 'status', 'grantId', 'expiresAt', 'revision', 'pending', 'rejected'])
  if (typeof row.bound !== 'boolean' || row.purpose !== 'bom_change_read') fail()
  if (row.status !== undefined && !['active', 'stopped'].includes(String(row.status))) fail()
  if (row.grantId !== undefined && (typeof row.grantId !== 'string' || !/^[0-9a-f]{32}$/.test(row.grantId))) fail()
  if (row.expiresAt !== undefined && (typeof row.expiresAt !== 'string' || !Number.isFinite(Date.parse(row.expiresAt)))) fail()
  if (!row.bound && row.status === 'active') fail()
  if (row.revision !== undefined && (typeof row.revision !== 'string' || !UUID.test(row.revision))) fail()
  for (const key of ['pending', 'rejected']) if (row[key] !== undefined && (typeof row[key] !== 'number' || !Number.isSafeInteger(row[key]) || Number(row[key]) < 0)) fail()
  if (row.bound && (!row.grantId || !row.expiresAt || !row.status)) fail()
  return { bound: row.bound, purpose: 'bom_change_read', status: row.status as string | undefined, grantId: row.grantId as string | undefined, expiresAt: row.expiresAt as string | undefined, pending: row.pending as number | undefined, rejected: row.rejected as number | undefined }
}
export async function changeReadState(id: string): Promise<ChangeReadState> { return state(await api(bindingId(id) + '/personal-change-read')) }
export async function bindChangeRead(target: ChangeReadTarget, grant: string): Promise<ChangeReadState> {
  if (!GRANT.test(grant)) fail()
  return state(await api(bindingId(target.id) + '/personal-change-read', 'POST', { grant, expectedVersion: target.version }, 'bind'))
}
export async function startChangeRead(target: ChangeReadTarget): Promise<void> {
  const row = await api(bindingId(target.id) + '/personal-change-read/start', 'POST', { expectedVersion: target.version }, 'start')
  keys(row, ['status', 'generation', 'cursor', 'bindingVersion'])
  if (row.status !== 'active' || row.bindingVersion !== target.version || typeof row.generation !== 'string' || !UUID.test(row.generation)
    || typeof row.cursor !== 'number' || !Number.isSafeInteger(row.cursor) || row.cursor < 0) fail()
}
export async function unbindChangeRead(id: string): Promise<{ pending: number; rejected: number }> {
  const row = await api(bindingId(id) + '/personal-change-read', 'DELETE', {}, 'unbind')
  keys(row, ['pending', 'rejected'])
  for (const key of ['pending', 'rejected']) if (typeof row[key] !== 'number' || !Number.isSafeInteger(row[key]) || Number(row[key]) < 0) fail()
  return row as { pending: number; rejected: number }
}
