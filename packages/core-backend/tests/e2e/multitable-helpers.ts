/**
 * Shared helpers for the multitable RC Playwright smoke specs.
 *
 * Extracted from the four sibling specs (lifecycle / public-form /
 * hierarchy / gantt) once a fifth was about to land, per the
 * "rule of three" trigger noted in the post-#1421 review.
 *
 * Public surface:
 *   - FE_BASE_URL / API_BASE_URL constants
 *   - Entity / ApiEnvelope / FailureResponse types
 *   - requireValue() to safely unwrap optional response fields
 *   - ensureServersReachable() / loginAsPhase0() bootstrap
 *   - makeAuthClient() per-test bound to (request, token)
 *   - injectTokenAndGo() for browser-side auth setup
 *   - createBase / createSheet / createField / createView / createRecord
 *     primitives that each spec composes its own setup from
 *
 * The helpers deliberately do not provide a one-shot
 * `createSheetWithFieldsAndViews()` factory because the specs each
 * compose slightly different setups; flat primitives keep call sites
 * explicit and avoid a leaky god-helper.
 */
import { test, type APIRequestContext, type Page } from '@playwright/test'

export const FE_BASE_URL = 'http://127.0.0.1:8899'
export const API_BASE_URL = 'http://localhost:7778'

export type Entity = { id: string }

export type ApiEnvelope<TData extends Record<string, unknown> = Record<string, unknown>> = {
  ok?: boolean
  data?: TData
  error?: { code?: string; message?: string }
}

export type FailureResponse = {
  status: number
  body: ApiEnvelope<Record<string, unknown>> | null
}

export function requireValue<T>(value: T | undefined, label: string): T {
  if (!value) throw new Error(`Expected ${label} in API response`)
  return value
}

export async function ensureServersReachable(request: APIRequestContext): Promise<void> {
  try {
    const apiHealth = await request.get(`${API_BASE_URL}/health`, { timeout: 3000 })
    if (!apiHealth.ok()) test.skip(true, 'Metasheet backend not reachable')
  } catch {
    test.skip(true, 'Metasheet backend not reachable')
  }

  try {
    const feHealth = await request.get(FE_BASE_URL, { timeout: 3000 })
    if (!feHealth.ok()) test.skip(true, 'Metasheet frontend not reachable')
  } catch {
    test.skip(true, 'Metasheet frontend not reachable')
  }
}

export async function loginAsPhase0(request: APIRequestContext): Promise<string> {
  const loginRes = await request.post(`${API_BASE_URL}/api/auth/login`, {
    data: { email: 'phase0@test.local', password: 'Phase0Test!2026' },
  })
  let body: unknown = null
  try { body = await loginRes.json() } catch {}
  const envelope = body as ApiEnvelope<{ token?: string }> | null
  const token = envelope?.data?.token
  if (typeof token !== 'string' || token.length === 0) {
    test.skip(true, 'Login failed — phase0 user may not exist')
    throw new Error('unreachable')
  }
  return token
}

export type AuthClient = {
  post<TData extends Record<string, unknown>>(path: string, body: unknown): Promise<ApiEnvelope<TData>>
  patch<TData extends Record<string, unknown>>(path: string, body: unknown): Promise<ApiEnvelope<TData>>
  get<TData extends Record<string, unknown>>(path: string): Promise<ApiEnvelope<TData>>
  postExpectingFailure(path: string, body: unknown): Promise<FailureResponse>
  patchExpectingFailure(path: string, body: unknown): Promise<FailureResponse>
}

export function makeAuthClient(request: APIRequestContext, token: string): AuthClient {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  async function expectOk<TData extends Record<string, unknown>>(
    method: 'post' | 'patch' | 'get',
    path: string,
    body?: unknown,
  ): Promise<ApiEnvelope<TData>> {
    const url = `${API_BASE_URL}${path}`
    const res = method === 'get'
      ? await request.get(url, { headers })
      : method === 'post'
        ? await request.post(url, { headers, data: body })
        : await request.patch(url, { headers, data: body })
    let json: unknown = null
    try { json = await res.json() } catch {}
    if (!res.ok()) {
      throw new Error(`${method.toUpperCase()} ${path} failed: ${res.status()} ${JSON.stringify(json)}`)
    }
    return json as ApiEnvelope<TData>
  }

  async function expectFailure(method: 'post' | 'patch', path: string, body: unknown): Promise<FailureResponse> {
    const url = `${API_BASE_URL}${path}`
    const res = method === 'post'
      ? await request.post(url, { headers, data: body })
      : await request.patch(url, { headers, data: body })
    let json: unknown = null
    try { json = await res.json() } catch {}
    return {
      status: res.status(),
      body: (json as ApiEnvelope<Record<string, unknown>> | null) ?? null,
    }
  }

  return {
    post: (path, body) => expectOk('post', path, body),
    patch: (path, body) => expectOk('patch', path, body),
    get: (path) => expectOk('get', path),
    postExpectingFailure: (path, body) => expectFailure('post', path, body),
    patchExpectingFailure: (path, body) => expectFailure('patch', path, body),
  }
}

export async function injectTokenAndGo(page: Page, token: string, path: string): Promise<void> {
  await page.goto(FE_BASE_URL)
  await page.evaluate((t: string) => {
    localStorage.setItem('metasheet_token', t)
    localStorage.setItem('token', t)
  }, token)
  await page.goto(`${FE_BASE_URL}${path}`)
}

export function uniqueLabel(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`
}

export async function createBase(client: AuthClient, name: string): Promise<Entity> {
  return requireValue(
    (await client.post<{ base: Entity }>('/api/multitable/bases', { name })).data?.base,
    'base',
  )
}

export async function createSheet(client: AuthClient, baseId: string, name: string): Promise<Entity> {
  return requireValue(
    (await client.post<{ sheet: Entity }>('/api/multitable/sheets', { baseId, name })).data?.sheet,
    'sheet',
  )
}

export async function createField(
  client: AuthClient,
  sheetId: string,
  name: string,
  type: string,
  property?: Record<string, unknown>,
): Promise<Entity> {
  const body: Record<string, unknown> = { sheetId, name, type }
  if (property) body.property = property
  return requireValue(
    (await client.post<{ field: Entity }>('/api/multitable/fields', body)).data?.field,
    `${type} field ${name}`,
  )
}

export async function createView(
  client: AuthClient,
  sheetId: string,
  name: string,
  type?: string,
  config?: Record<string, unknown>,
): Promise<Entity> {
  const body: Record<string, unknown> = { sheetId, name }
  if (type) body.type = type
  if (config) body.config = config
  return requireValue(
    (await client.post<{ view: Entity }>('/api/multitable/views', body)).data?.view,
    `${type ?? 'grid'} view ${name}`,
  )
}

export type CreatedRecord = Entity & { data: Record<string, unknown> }

export async function createRecord(
  client: AuthClient,
  sheetId: string,
  data: Record<string, unknown>,
): Promise<CreatedRecord> {
  const env = await client.post<{ record: CreatedRecord }>('/api/multitable/records', { sheetId, data })
  return requireValue(env.data?.record, 'record')
}
