import {
  clearManagedDescriptor,
  clearManagedProbeMarker,
  readAuthSessionSignature,
  readManagedEpoch,
  readStoredToken,
  sha256Hex,
  TOKEN_KEYS,
} from '../../composables/authPrincipal'
import { apiFetch, getApiBase } from '../../utils/api'

/** Query names buildManagedLoginNavigation appends, and no others. */
const NAVIGATION_QUERY_NAMES = new Set([
  'client_id',
  'callback',
  'origin',
  'tenant_id',
  'org_id',
  'issuer',
  'root_part_id',
  'state',
  'code_challenge',
  'code_challenge_method',
])

/** Query names fixedDestination appends, and no others. */
const DESTINATION_QUERY_NAMES = new Set(['dataSourceId', 'partId', 'managed', 'reason'])

const DESTINATION_BASE = 'http://127.0.0.1'

export class PlmManagedCompanionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlmManagedCompanionError'
  }
}

async function readRecord(response: Response): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = JSON.parse(await response.text()) as unknown
  } catch {
    throw new PlmManagedCompanionError('托管登录响应无法读取')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new PlmManagedCompanionError('托管登录响应无法读取')
  }
  return body as Record<string, unknown>
}

function exactFields(record: Record<string, unknown>, fields: readonly string[]): void {
  const keys = Object.keys(record)
  if (keys.length !== fields.length || fields.some((field) => !Object.prototype.hasOwnProperty.call(record, field))) {
    throw new PlmManagedCompanionError('托管登录响应被拒绝')
  }
}

async function readSuccess(response: Response, fields: readonly string[], failureMessage: string): Promise<Record<string, unknown>> {
  const record = await readRecord(response)
  if (!response.ok || record.ok !== true) throw new PlmManagedCompanionError(failureMessage)
  exactFields(record, fields)
  return record
}

function assertNavigationUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new PlmManagedCompanionError('托管登录未能开始')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new PlmManagedCompanionError('托管登录未能开始')
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.hash || url.pathname !== '/managed-login') {
    throw new PlmManagedCompanionError('托管登录未能开始')
  }
  const names = [...url.searchParams.keys()]
  if (new Set(names).size !== names.length || names.some((name) => !NAVIGATION_QUERY_NAMES.has(name))) {
    throw new PlmManagedCompanionError('托管登录未能开始')
  }
  const method = url.searchParams.get('code_challenge_method')
  if (method !== null && method !== 'S256') throw new PlmManagedCompanionError('托管登录未能开始')
  return value
}

function assertDestination(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) {
    throw new PlmManagedCompanionError('托管登录被拒绝')
  }
  let url: URL
  try {
    url = new URL(value, DESTINATION_BASE)
  } catch {
    throw new PlmManagedCompanionError('托管登录被拒绝')
  }
  if (url.origin !== DESTINATION_BASE || url.username || url.password || url.hash || url.pathname !== '/plm/bom-review') {
    throw new PlmManagedCompanionError('托管登录被拒绝')
  }
  const names = [...url.searchParams.keys()]
  if (new Set(names).size !== names.length || names.some((name) => !DESTINATION_QUERY_NAMES.has(name))) {
    throw new PlmManagedCompanionError('托管登录被拒绝')
  }
  const managed = url.searchParams.get('managed')
  if (managed !== null && managed !== 'ready' && managed !== 'refused') {
    throw new PlmManagedCompanionError('托管登录被拒绝')
  }
  return value
}

export function followManagedNavigation(url: string): void {
  window.location.assign(url)
}

export async function startManagedLogin(dataSourceId: string, rootPartId: string): Promise<{ navigationUrl: string }> {
  const response = await apiFetch('/api/plm/managed-login/start', {
    method: 'POST',
    credentials: 'include',
    body: JSON.stringify({ dataSourceId, rootPartId }),
  })
  const body = await readSuccess(response, ['ok', 'navigationUrl'], '托管登录未能开始')
  return { navigationUrl: assertNavigationUrl(body.navigationUrl) }
}

export async function unlinkManagedSource(dataSourceId: string): Promise<{ state: string }> {
  const response = await apiFetch('/api/plm/managed-login/unlink', {
    method: 'POST',
    credentials: 'include',
    body: JSON.stringify({ dataSourceId }),
  })
  const body = await readSuccess(response, ['ok', 'state'], '解除托管尚未完成')
  const state = body.state === 'pending' || body.state === 'acked' ? body.state : ''
  if (!state) throw new PlmManagedCompanionError('解除托管尚未完成')
  return { state }
}

export async function readManagedStatus(dataSourceId: string): Promise<{
  linked: boolean
  pendingRevoke: boolean
  generation: number | null
}> {
  const response = await apiFetch(`/api/plm/managed-login/session?dataSourceId=${encodeURIComponent(dataSourceId)}`, {
    method: 'GET',
    credentials: 'include',
  })
  const body = await readSuccess(response, ['ok', 'linked', 'pendingRevoke', 'generation', 'expiresAt'], '托管状态无法读取')
  return {
    linked: body.linked === true,
    pendingRevoke: body.pendingRevoke === true,
    generation: typeof body.generation === 'number' ? body.generation : null,
  }
}

const ENTRY_KEYS = ['issuer', 'tenant_id', 'org_id', 'client_id', 'root_part_id', 'native_subject_hint'] as const

function assertPageOrigin(): void {
  const page = window.location.origin
  let apiOrigin = ''
  try {
    apiOrigin = new URL(getApiBase(), page || undefined).origin
  } catch {
    apiOrigin = ''
  }
  if (!page || apiOrigin !== page) throw new PlmManagedCompanionError('托管接口源不匹配')
}

async function bridgePost(path: string, action: 'browser-start' | 'complete' | 'logout', body: Record<string, string>): Promise<Record<string, unknown>> {
  assertPageOrigin()
  readStoredToken()
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
    'x-metasheet-managed-bridge': action,
  }
  const token = readStoredToken()
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(new URL(path, window.location.origin).toString(), {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify(body),
    referrerPolicy: 'no-referrer',
  })
  const record = await readRecord(response)
  if (!response.ok || record.ok !== true) {
    const allowed = action === 'complete' ? ['ok', 'error', 'destination'] : ['ok', 'error']
    const keys = Object.keys(record)
    if (!keys.includes('ok') || !keys.includes('error') || keys.some((key) => !allowed.includes(key))) {
      throw new PlmManagedCompanionError('托管登录响应被拒绝')
    }
    if (action === 'complete' && Object.prototype.hasOwnProperty.call(record, 'destination')) {
      assertDestination(record.destination)
    }
    const error = record.error
    if (!error || typeof error !== 'object' || Array.isArray(error)) {
      throw new PlmManagedCompanionError('托管登录被拒绝')
    }
    const errorRecord = error as Record<string, unknown>
    const errorKeys = Object.keys(errorRecord)
    if (errorKeys.some((key) => key !== 'code' && key !== 'message')) {
      throw new PlmManagedCompanionError('托管登录响应被拒绝')
    }
    const code = errorRecord.code
    throw new PlmManagedCompanionError(typeof code === 'string' && code ? code : '托管登录被拒绝')
  }
  const fields = action === 'browser-start'
    ? ['ok', 'navigationUrl']
    : action === 'complete'
      ? ['ok', 'destination']
      : ['ok', 'revoked']
  exactFields(record, fields)
  return record
}

export function managedEntryBody(search: string): Record<string, string> {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const keys = [...params.keys()]
  if (new Set(keys).size !== ENTRY_KEYS.length || keys.length !== ENTRY_KEYS.length || ENTRY_KEYS.some((key) => !keys.includes(key))) {
    throw new PlmManagedCompanionError('托管入口参数被拒绝')
  }
  const values = Object.fromEntries(ENTRY_KEYS.map((key) => [key, params.get(key) ?? '']))
  for (const value of Object.values(values)) {
    if (!value || value !== value.trim() || value.length > 512) throw new PlmManagedCompanionError('托管入口参数被拒绝')
  }
  if (values.native_subject_hint.length > 128 || /[\s\u0000-\u001f\u007f]/.test(values.native_subject_hint)) {
    throw new PlmManagedCompanionError('托管入口参数被拒绝')
  }
  return {
    issuer: values.issuer,
    nativeTenantId: values.tenant_id,
    nativeOrgId: values.org_id,
    clientId: values.client_id,
    rootPartId: values.root_part_id,
    nativeSubjectHint: values.native_subject_hint,
  }
}

export async function rememberBridgeCorrelation(state: string): Promise<void> {
  for (const key of TOKEN_KEYS) localStorage.getItem(key)
  const storageKey = `ms_plm_bridge:${await sha256Hex(state)}`
  sessionStorage.setItem(storageKey, await sha256Hex(readAuthSessionSignature()))
}

export async function bridgeCorrelationMatches(state: string): Promise<boolean> {
  for (const key of TOKEN_KEYS) localStorage.getItem(key)
  const storageKey = `ms_plm_bridge:${await sha256Hex(state)}`
  const stored = sessionStorage.getItem(storageKey)
  if (!stored) return false
  return stored === await sha256Hex(readAuthSessionSignature())
}

export async function startManagedBrowserBridge(search: string): Promise<{ navigationUrl: string; state: string }> {
  const body = managedEntryBody(search)
  const record = await bridgePost('/api/plm/managed-login/browser-start', 'browser-start', body)
  const navigationUrl = assertNavigationUrl(record.navigationUrl)
  const state = new URL(navigationUrl).searchParams.get('state') ?? ''
  if (!state) throw new PlmManagedCompanionError('托管登录未能开始')
  await rememberBridgeCorrelation(state)
  return { navigationUrl, state }
}

export async function completeManagedBrowserBridge(code: string, state: string): Promise<{ destination: string; stale: boolean }> {
  const startedEpoch = readManagedEpoch()
  const startedSignature = readAuthSessionSignature()
  const record = await bridgePost('/api/plm/managed-login/complete', 'complete', { code, state })
  if (readManagedEpoch() !== startedEpoch || readAuthSessionSignature() !== startedSignature) {
    return { destination: '', stale: true }
  }
  return { destination: assertDestination(record.destination), stale: false }
}

export async function logoutManagedBrowserBridge(): Promise<void> {
  await bridgePost('/api/plm/managed-login/logout', 'logout', {})
  clearManagedDescriptor()
  clearManagedProbeMarker()
}
