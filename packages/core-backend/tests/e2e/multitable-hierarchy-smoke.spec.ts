/**
 * Multitable Hierarchy view smoke E2E.
 *
 * Closes RC TODO `Smoke test Hierarchy view rendering and child creation`.
 * Forks the public-form smoke template (PR #1417): admin creates a sheet
 * with a self-table single-value link field, configures a hierarchy
 * view, creates a parent record, then a child record carrying the
 * parent link. Browser asserts the workbench renders both names. Two
 * regression guards exercise the server-side hierarchy cycle guard
 * (`assertNoHierarchyParentCycle` in
 * packages/core-backend/src/multitable/hierarchy-cycle-guard.ts) at the
 * HTTP layer.
 *
 * Prerequisites: Metasheet backend (:7778) and frontend (:8899) running
 * locally. Tests skip if either server is unreachable.
 *
 * Run:
 *   cd packages/core-backend
 *   npx playwright test --config tests/e2e/playwright.config.ts \
 *     multitable-hierarchy-smoke.spec.ts
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

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

async function authPatchExpectingFailure(request: APIRequestContext, path: string, body: unknown) {
  const res = await request.patch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: body,
  })
  return { status: res.status(), body: await res.json().catch(() => null) }
}

async function injectTokenAndGo(page: Page, path: string) {
  await page.goto(FE)
  await page.evaluate((t: string) => {
    localStorage.setItem('metasheet_token', t)
    localStorage.setItem('token', t)
  }, token)
  await page.goto(`${FE}${path}`)
}

async function setupHierarchySheet(request: APIRequestContext, label: string) {
  const stamp = Date.now() + Math.floor(Math.random() * 1000)
  const base = (await authPost(request, '/api/multitable/bases', { name: `${label}-base-${stamp}` })).data.base
  const sheet = (await authPost(request, '/api/multitable/sheets', { baseId: base.id, name: `${label}-sheet-${stamp}` })).data.sheet
  const title = (await authPost(request, '/api/multitable/fields', {
    sheetId: sheet.id,
    name: 'Title',
    type: 'string',
  })).data.field
  // Self-table single-value link for parent
  const parent = (await authPost(request, '/api/multitable/fields', {
    sheetId: sheet.id,
    name: 'Parent',
    type: 'link',
    property: { foreignSheetId: sheet.id, limitSingleRecord: true },
  })).data.field
  // Hierarchy view configured to use the parent link
  const view = (await authPost(request, '/api/multitable/views', {
    sheetId: sheet.id,
    name: 'Hierarchy',
    type: 'hierarchy',
    config: { parentFieldId: parent.id },
  })).data.view
  return { base, sheet, title, parent, view }
}

test.describe('Multitable Hierarchy smoke', () => {
  test('renders parent and child records in the hierarchy workbench', async ({ request, page }) => {
    const { sheet, title, parent, view } = await setupHierarchySheet(request, 'h-render')

    const stamp = Date.now()
    const parentName = `h-parent-${stamp}`
    const childName = `h-child-${stamp}`

    const parentRecord = (await authPost(request, '/api/multitable/records', {
      sheetId: sheet.id,
      data: { [title.id]: parentName },
    })).data.record
    expect(parentRecord?.id).toBeTruthy()

    const childRecord = (await authPost(request, '/api/multitable/records', {
      sheetId: sheet.id,
      data: { [title.id]: childName, [parent.id]: [parentRecord.id] },
    })).data.record
    expect(childRecord?.id).toBeTruthy()

    await injectTokenAndGo(page, `/multitable/${sheet.id}/${view.id}`)
    const body = page.locator('body')
    // Parent always visible (root level); child may be collapsed by default,
    // but its label should still be present in the rendered tree DOM.
    await expect(body).toContainText(parentName, { timeout: 15000 })
    await expect(body).toContainText(childName, { timeout: 15000 })
  })

  test('rejects setting a record as its own parent (HIERARCHY_CYCLE)', async ({ request }) => {
    const { sheet, title, parent } = await setupHierarchySheet(request, 'h-self')

    const record = (await authPost(request, '/api/multitable/records', {
      sheetId: sheet.id,
      data: { [title.id]: 'self-loop-candidate' },
    })).data.record

    const fail = await authPatchExpectingFailure(request, `/api/multitable/records/${record.id}`, {
      sheetId: sheet.id,
      data: { [parent.id]: [record.id] },
    })
    expect(fail.status).toBe(400)
    expect(fail.body?.error?.code).toBe('HIERARCHY_CYCLE')
  })

  test('rejects setting a descendant as the parent (HIERARCHY_CYCLE through chain)', async ({ request }) => {
    const { sheet, title, parent } = await setupHierarchySheet(request, 'h-chain')

    // Build A → B → C
    const a = (await authPost(request, '/api/multitable/records', {
      sheetId: sheet.id,
      data: { [title.id]: 'A' },
    })).data.record
    const b = (await authPost(request, '/api/multitable/records', {
      sheetId: sheet.id,
      data: { [title.id]: 'B', [parent.id]: [a.id] },
    })).data.record
    const c = (await authPost(request, '/api/multitable/records', {
      sheetId: sheet.id,
      data: { [title.id]: 'C', [parent.id]: [b.id] },
    })).data.record

    // Try to set A's parent to C — would create cycle A → C → B → A.
    const fail = await authPatchExpectingFailure(request, `/api/multitable/records/${a.id}`, {
      sheetId: sheet.id,
      data: { [parent.id]: [c.id] },
    })
    expect(fail.status).toBe(400)
    expect(fail.body?.error?.code).toBe('HIERARCHY_CYCLE')

    // Sanity: a non-cycle reparent on the same chain still works
    // (move B under root by clearing its parent).
    const ok = await authPatch(request, `/api/multitable/records/${b.id}`, {
      sheetId: sheet.id,
      data: { [parent.id]: [] },
    })
    expect(ok.data?.record?.id).toBe(b.id)
  })
})
