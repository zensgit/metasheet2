/**
 * Multitable lifecycle smoke E2E.
 *
 * Closes RC TODO `Smoke test basic multitable sheet lifecycle: create base,
 * sheet, view, fields, records.` Exercises the full create chain through
 * the public REST API and asserts the workbench frontend renders the
 * resulting record.
 *
 * Prerequisites: Metasheet backend (:7778) and frontend (:8899) running
 * locally. Tests skip if either server is unreachable.
 *
 * Run:
 *   cd packages/core-backend
 *   npx playwright test --config tests/e2e/playwright.config.ts \
 *     multitable-lifecycle-smoke.spec.ts
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

const FE = 'http://127.0.0.1:8899'
const API = 'http://localhost:7778'

let token = ''

test.beforeAll(async ({ request }) => {
  try {
    const health = await request.get(`${API}/health`, { timeout: 3000 })
    if (!health.ok()) test.skip(true, 'Metasheet backend not reachable')
  } catch {
    test.skip(true, 'Metasheet backend not reachable')
  }

  try {
    const frontend = await request.get(FE, { timeout: 3000 })
    if (!frontend.ok()) test.skip(true, 'Metasheet frontend not reachable')
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

async function injectTokenAndGo(page: Page, path: string) {
  await page.goto(FE)
  await page.evaluate((t: string) => {
    localStorage.setItem('metasheet_token', t)
    localStorage.setItem('token', t)
  }, token)
  await page.goto(`${FE}${path}`)
}

async function postJson(request: APIRequestContext, path: string, body: unknown) {
  const res = await request.post(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: body,
  })
  const status = res.status()
  let json: any = null
  try { json = await res.json() } catch {}
  if (!res.ok()) {
    throw new Error(`POST ${path} failed: ${status} ${JSON.stringify(json)}`)
  }
  return json
}

async function getJson(request: APIRequestContext, path: string) {
  const res = await request.get(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok()) throw new Error(`GET ${path} failed: ${res.status()}`)
  return res.json()
}

test.describe('Multitable lifecycle smoke', () => {
  test('creates base, sheet, field, view, record and renders in workbench', async ({ request, page }) => {
    const stamp = Date.now()

    // 1. Base
    const baseBody = await postJson(request, '/api/multitable/bases', {
      name: `smoke-base-${stamp}`,
    })
    const base = baseBody.data?.base
    expect(base?.id).toBeTruthy()

    // 2. Sheet under base
    const sheetBody = await postJson(request, '/api/multitable/sheets', {
      baseId: base.id,
      name: `smoke-sheet-${stamp}`,
    })
    const sheet = sheetBody.data?.sheet
    expect(sheet?.id).toBeTruthy()

    // 3. Title field
    const fieldBody = await postJson(request, '/api/multitable/fields', {
      sheetId: sheet.id,
      name: 'Title',
      type: 'string',
    })
    const field = fieldBody.data?.field
    expect(field?.id).toBeTruthy()
    expect(field.type).toBe('string')

    // 4. View — reuse default if sheet seeded one, otherwise create explicitly
    const viewsBody = await getJson(request, `/api/multitable/views?sheetId=${sheet.id}`)
    const existingViews = (viewsBody.data?.views ?? []) as Array<{ id: string; type: string }>
    let view = existingViews.find((v) => v.type === 'grid') ?? existingViews[0]
    if (!view) {
      const created = await postJson(request, '/api/multitable/views', {
        sheetId: sheet.id,
        name: 'Default Grid',
        type: 'grid',
      })
      view = created.data?.view
    }
    expect(view?.id).toBeTruthy()

    // 5. Record carrying the title field value
    const cellValue = `smoke-record-${stamp}`
    const recordBody = await postJson(request, '/api/multitable/records', {
      sheetId: sheet.id,
      data: { [field.id]: cellValue },
    })
    const record = recordBody.data?.record
    expect(record?.id).toBeTruthy()
    expect(record.data[field.id]).toBe(cellValue)

    // 6. Workbench frontend renders the value
    await injectTokenAndGo(page, `/multitable/${sheet.id}/${view.id}`)
    const body = page.locator('body')
    await expect(body).toContainText(cellValue, { timeout: 15000 })
  })

  test('rejects client-supplied autoNumber values during record create (regression guard)', async ({ request }) => {
    const stamp = Date.now() + 1
    const base = (await postJson(request, '/api/multitable/bases', { name: `smoke-base-an-${stamp}` })).data.base
    const sheet = (await postJson(request, '/api/multitable/sheets', { baseId: base.id, name: `smoke-sheet-an-${stamp}` })).data.sheet
    const seq = (await postJson(request, '/api/multitable/fields', {
      sheetId: sheet.id,
      name: 'No.',
      type: 'autoNumber',
      property: { start: 1 },
    })).data.field
    expect(seq.type).toBe('autoNumber')

    const res = await request.post(`${API}/api/multitable/records`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { sheetId: sheet.id, data: { [seq.id]: 999 } },
    })
    expect(res.status()).toBe(403)
    const body = await res.json()
    expect(body).toMatchObject({
      ok: false,
      error: {
        code: 'FIELD_READONLY',
        message: `Field is readonly: ${seq.id}`,
      },
    })
  })
})
