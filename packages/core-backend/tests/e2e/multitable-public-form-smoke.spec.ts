/**
 * Multitable public form submit smoke E2E.
 *
 * Closes RC TODO `Smoke test public form submit path`. Forks the
 * lifecycle smoke template: admin creates a sheet, enables public form
 * sharing on a grid view, then an anonymous request submits a record
 * via the unauthenticated submit endpoint. Admin verifies the record
 * landed.
 *
 * Prerequisites: Metasheet backend (:7778) and frontend (:8899) running
 * locally. Tests skip if either server is unreachable.
 *
 * Run:
 *   cd packages/core-backend
 *   npx playwright test --config tests/e2e/playwright.config.ts \
 *     multitable-public-form-smoke.spec.ts
 */
import { test, expect, type APIRequestContext } from '@playwright/test'

const FE = 'http://127.0.0.1:8899'
const API = 'http://localhost:7778'

let token = ''

test.beforeAll(async ({ request }) => {
  try {
    const apiHealth = await request.get(`${API}/health`, { timeout: 3000 })
    if (!apiHealth.ok()) test.skip(true, 'Metasheet backend not reachable')
  } catch {
    test.skip(true, 'Metasheet backend not reachable')
  }

  try {
    const feHealth = await request.get(FE, { timeout: 3000 })
    if (!feHealth.ok()) test.skip(true, 'Metasheet frontend not reachable')
  } catch {
    test.skip(true, 'Metasheet frontend not reachable')
  }

  const loginRes = await request.post(`${API}/api/auth/login`, {
    data: { email: 'phase0@test.local', password: 'Phase0Test!2026' },
  })
  const loginBody = await loginRes.json()
  token = loginBody.data?.token
  if (!token) test.skip(true, 'Login failed — phase0 user may not exist')
})

async function authPost(request: APIRequestContext, path: string, body: unknown) {
  const res = await request.post(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: body,
  })
  const status = res.status()
  let json: any = null
  try { json = await res.json() } catch {}
  if (!res.ok()) throw new Error(`POST ${path} failed: ${status} ${JSON.stringify(json)}`)
  return json
}

async function authPatch(request: APIRequestContext, path: string, body: unknown) {
  const res = await request.patch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: body,
  })
  const status = res.status()
  let json: any = null
  try { json = await res.json() } catch {}
  if (!res.ok()) throw new Error(`PATCH ${path} failed: ${status} ${JSON.stringify(json)}`)
  return json
}

async function authGet(request: APIRequestContext, path: string) {
  const res = await request.get(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok()) throw new Error(`GET ${path} failed: ${res.status()}`)
  return res.json()
}

async function setupSheetWithStringField(request: APIRequestContext, label: string) {
  const stamp = Date.now() + Math.floor(Math.random() * 1000)
  const base = (await authPost(request, '/api/multitable/bases', { name: `${label}-base-${stamp}` })).data.base
  const sheet = (await authPost(request, '/api/multitable/sheets', { baseId: base.id, name: `${label}-sheet-${stamp}` })).data.sheet
  const field = (await authPost(request, '/api/multitable/fields', {
    sheetId: sheet.id,
    name: 'Title',
    type: 'string',
  })).data.field

  const viewsBody = await authGet(request, `/api/multitable/views?sheetId=${sheet.id}`)
  const existingViews = (viewsBody.data?.views ?? []) as Array<{ id: string; type: string }>
  let view = existingViews.find((v) => v.type === 'grid') ?? existingViews[0]
  if (!view) {
    const created = await authPost(request, '/api/multitable/views', {
      sheetId: sheet.id,
      name: 'Default Grid',
      type: 'grid',
    })
    view = created.data.view
  }
  return { base, sheet, field, view }
}

test.describe('Multitable public form smoke', () => {
  test('admin enables public form, anonymous submits, record persists', async ({ request }) => {
    const { sheet, field, view } = await setupSheetWithStringField(request, 'pf-happy')

    // Enable public form on the grid view
    const shareBody = await authPatch(request, `/api/multitable/sheets/${sheet.id}/views/${view.id}/form-share`, {
      enabled: true,
      accessMode: 'public',
    })
    const publicToken: string = shareBody.data?.publicToken
    expect(publicToken).toBeTruthy()
    expect(typeof publicToken).toBe('string')

    // Anonymous submit (no Authorization header)
    const cellValue = `pf-anon-${Date.now()}`
    const submitRes = await request.post(`${API}/api/multitable/views/${view.id}/submit`, {
      headers: { 'Content-Type': 'application/json' },
      data: { publicToken, data: { [field.id]: cellValue } },
    })
    expect(submitRes.ok()).toBe(true)
    const submitBody = await submitRes.json()
    const newRecordId = submitBody.data?.record?.id
    expect(newRecordId).toBeTruthy()

    // Admin verifies the record is queryable in the sheet
    const recordsBody = await authGet(request, `/api/multitable/records?sheetId=${sheet.id}`)
    const rows = (recordsBody.data?.records ?? []) as Array<{ id: string; data: Record<string, unknown> }>
    const persisted = rows.find((row) => row.id === newRecordId)
    expect(persisted, 'record should be visible to admin after public submit').toBeTruthy()
    expect(persisted?.data?.[field.id]).toBe(cellValue)
  })

  test('rejects anonymous submit when public form is disabled (regression guard)', async ({ request }) => {
    const { view, field } = await setupSheetWithStringField(request, 'pf-disabled')

    // Do NOT enable form-share. Submit must fail.
    const res = await request.post(`${API}/api/multitable/views/${view.id}/submit`, {
      headers: { 'Content-Type': 'application/json' },
      data: { publicToken: 'definitely-not-the-real-token', data: { [field.id]: 'should-not-persist' } },
    })
    expect(res.status()).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'Authentication required' })
  })

  test('rejects anonymous submit with stale token after regenerate (regression guard)', async ({ request }) => {
    const { sheet, field, view } = await setupSheetWithStringField(request, 'pf-rotated')

    const shareBody = await authPatch(request, `/api/multitable/sheets/${sheet.id}/views/${view.id}/form-share`, {
      enabled: true,
      accessMode: 'public',
    })
    const oldToken: string = shareBody.data?.publicToken
    expect(oldToken).toBeTruthy()

    // Rotate
    const regenBody = await authPost(request, `/api/multitable/sheets/${sheet.id}/views/${view.id}/form-share/regenerate`, {})
    const newToken: string = regenBody.data?.publicToken
    expect(newToken).toBeTruthy()
    expect(newToken).not.toBe(oldToken)

    // Old token must be rejected
    const res = await request.post(`${API}/api/multitable/views/${view.id}/submit`, {
      headers: { 'Content-Type': 'application/json' },
      data: { publicToken: oldToken, data: { [field.id]: 'rotated-out' } },
    })
    expect(res.status()).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'Authentication required' })

    // New token still works (sanity)
    const rotatedValue = `pf-rotated-${Date.now()}`
    const okRes = await request.post(`${API}/api/multitable/views/${view.id}/submit`, {
      headers: { 'Content-Type': 'application/json' },
      data: { publicToken: newToken, data: { [field.id]: rotatedValue } },
    })
    expect(okRes.ok()).toBe(true)
    const okBody = await okRes.json()
    expect(okBody.data?.record?.data?.[field.id]).toBe(rotatedValue)
  })
})
