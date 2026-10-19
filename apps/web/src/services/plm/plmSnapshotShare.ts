import { withAuthIdentityLock } from '../../composables/authIdentityLock'
import { readManagedDescriptor, readStoredToken } from '../../composables/authPrincipal'

const KEY = 'metasheet_plm_snapshot_share'
type Input = { dataSourceId: string; partId: string; baseId: string; name: string }
type Pending = { operationId: string; input: Input; userId: string; tenantId: string; sessionId: string }
function pending(): Pending | null {
  const value = sessionStorage.getItem(KEY)
  return value ? JSON.parse(value) as Pending : null
}
function fail(): never { throw new Error('分享未完成。请确认个人身份和目标权限后重试。') }
async function cookieIdentity() {
  const current = await json('/api/plm/managed-login/current')
  if (current.success !== true || !current.data?.managedSession) fail()
  return current.data.managedSession as { userId: string; tenantId: string; sessionId: string }
}
async function json(path: string, body?: unknown, action?: string): Promise<any> {
  if (readStoredToken()) fail()
  const response = await fetch(new URL(path, window.location.origin), { method: body ? 'POST' : 'GET',
    credentials: 'include', cache: 'no-store', referrerPolicy: 'no-referrer',
    headers: body ? { 'content-type': 'application/json', 'x-plm-snapshot-share': action! } : {},
    ...(body ? { body: JSON.stringify(body) } : {}) })
  const result = await response.json()
  if (!response.ok) fail()
  return result
}
export async function snapshotShareTargets(dataSourceId: string, partId: string): Promise<{ id: string; name: string }[]> {
  const result = await json('/api/plm-bom-reviews/managed-share/targets?' + new URLSearchParams({ dataSourceId, partId }))
  if (result.ok !== true || !Array.isArray(result.data?.items)) fail()
  return result.data.items
}
export function forgetSnapshotShare(): void { sessionStorage.removeItem(KEY) }
export async function startSnapshotShare(input: Input): Promise<void> {
  await withAuthIdentityLock(async () => {
    const identity = readManagedDescriptor() ?? await cookieIdentity()
    if (!identity || readStoredToken()) fail()
    let saved = pending()
    if (saved && (saved.userId !== identity.userId || saved.tenantId !== identity.tenantId || saved.sessionId !== identity.sessionId
        || JSON.stringify(saved.input) !== JSON.stringify(input))) fail()
    if (!saved) {
      saved = { operationId: crypto.randomUUID(), input, userId: identity.userId, tenantId: identity.tenantId, sessionId: identity.sessionId }
      sessionStorage.setItem(KEY, JSON.stringify(saved))
    }
    const result = await json('/api/plm-bom-reviews/managed-share/start', { operationId: saved.operationId, ...saved.input }, 'start')
    if (result.ok !== true || typeof result.navigationUrl !== 'string') fail()
    const url = new URL(result.navigationUrl)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash
        || url.pathname !== '/bom-snapshot-share' || [...url.searchParams.keys()].join() !== 'intent'
        || !/^[0-9a-f-]{36}$/.test(url.searchParams.get('intent') ?? '')) fail()
    window.location.assign(url.toString())
  }, { failClosed: true })
}
export async function completeSnapshotShare(search: string): Promise<string> {
  const params = new URLSearchParams(search)
  const keys = [...params.keys()].sort()
  if (keys.length && (keys.join() !== 'code,operationId,state' || new Set(keys).size !== 3)) fail()
  return withAuthIdentityLock(async () => {
    const saved = pending()
    if (!saved || keys.length && saved.operationId !== params.get('operationId') || readStoredToken()) fail()
    const identity = await cookieIdentity()
    if (identity?.userId !== saved.userId || identity?.tenantId !== saved.tenantId
        || identity?.sessionId !== saved.sessionId) fail()
    const result = await json('/api/plm-bom-reviews/managed-share/complete', keys.length ? Object.fromEntries(params) : { operationId: saved.operationId }, 'complete')
    const path = result.data?.navigationPath
    if (result.ok !== true || typeof path !== 'string' || !/^\/multitable\/[^/?#]+\/[^/?#]+$/.test(path)) fail()
    // Keep the frozen operation until acknowledged; no new operation on a lost response.
    sessionStorage.removeItem(KEY)
    return path
  }, { failClosed: true })
}
export async function resumeSnapshotShare(): Promise<void> {
  const saved = pending()
  if (!saved) fail()
  await startSnapshotShare(saved.input)
}
