/**
 * Multitable Gantt view rendering smoke E2E.
 *
 * Closes RC TODO `Smoke test Gantt view rendering`. Forks the
 * Hierarchy smoke template (PR #1419): admin creates a sheet with
 * Title (string) + Start/End (date) fields, configures a gantt view
 * pointing at those fields, then creates records with date ranges and
 * a self-table link Predecessor for the dependency-arrow case.
 *
 * Three cases:
 *   1. Render bars and task labels
 *   2. Render a dependency arrow when configured
 *   3. Reject saving the gantt view with a non-link dependencyFieldId
 *      (exercises validateGanttDependencyConfig at the HTTP layer)
 *
 * Prerequisites: Metasheet backend (:7778) and frontend (:8899) running
 * locally. Tests skip if either server is unreachable.
 *
 * Run:
 *   cd packages/core-backend
 *   npx playwright test --config tests/e2e/playwright.config.ts \
 *     multitable-gantt-smoke.spec.ts
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

async function setupGanttSheet(request: APIRequestContext, label: string) {
  const stamp = Date.now() + Math.floor(Math.random() * 1000)
  const base = (await authPost(request, '/api/multitable/bases', { name: `${label}-base-${stamp}` })).data.base
  const sheet = (await authPost(request, '/api/multitable/sheets', { baseId: base.id, name: `${label}-sheet-${stamp}` })).data.sheet
  const title = (await authPost(request, '/api/multitable/fields', {
    sheetId: sheet.id,
    name: 'Title',
    type: 'string',
  })).data.field
  const startField = (await authPost(request, '/api/multitable/fields', {
    sheetId: sheet.id,
    name: 'Start',
    type: 'date',
  })).data.field
  const endField = (await authPost(request, '/api/multitable/fields', {
    sheetId: sheet.id,
    name: 'End',
    type: 'date',
  })).data.field
  const view = (await authPost(request, '/api/multitable/views', {
    sheetId: sheet.id,
    name: 'Gantt',
    type: 'gantt',
    config: {
      startFieldId: startField.id,
      endFieldId: endField.id,
      titleFieldId: title.id,
    },
  })).data.view
  return { base, sheet, title, startField, endField, view }
}

test.describe('Multitable Gantt smoke', () => {
  test('renders task bars and labels for records with date ranges', async ({ request, page }) => {
    const { sheet, title, startField, endField, view } = await setupGanttSheet(request, 'g-render')

    const stamp = Date.now()
    const designName = `g-design-${stamp}`
    const buildName = `g-build-${stamp}`

    await authPost(request, '/api/multitable/records', {
      sheetId: sheet.id,
      data: {
        [title.id]: designName,
        [startField.id]: '2026-04-01',
        [endField.id]: '2026-04-05',
      },
    })
    await authPost(request, '/api/multitable/records', {
      sheetId: sheet.id,
      data: {
        [title.id]: buildName,
        [startField.id]: '2026-04-06',
        [endField.id]: '2026-04-12',
      },
    })

    await injectTokenAndGo(page, `/multitable/${sheet.id}/${view.id}`)
    const bars = page.locator('.meta-gantt__bar')
    await expect(bars.first()).toBeVisible({ timeout: 15000 })
    expect(await bars.count()).toBeGreaterThanOrEqual(2)

    const body = page.locator('body')
    await expect(body).toContainText(designName)
    await expect(body).toContainText(buildName)
  })

  test('renders dependency arrows when dependencyFieldId is configured', async ({ request, page }) => {
    const { sheet, title, startField, endField, view } = await setupGanttSheet(request, 'g-arrow')

    const predecessor = (await authPost(request, '/api/multitable/fields', {
      sheetId: sheet.id,
      name: 'Predecessor',
      type: 'link',
      property: { foreignSheetId: sheet.id, limitSingleRecord: true },
    })).data.field

    // Wire dependency on the gantt view
    const updated = await authPost(request, '/api/multitable/views', {
      sheetId: sheet.id,
      name: 'Gantt-with-arrows',
      type: 'gantt',
      config: {
        startFieldId: startField.id,
        endFieldId: endField.id,
        titleFieldId: title.id,
        dependencyFieldId: predecessor.id,
      },
    })
    const arrowView = updated.data.view
    expect(arrowView?.id).toBeTruthy()

    const stamp = Date.now()
    const designName = `g-design-arrow-${stamp}`
    const buildName = `g-build-arrow-${stamp}`

    const design = (await authPost(request, '/api/multitable/records', {
      sheetId: sheet.id,
      data: {
        [title.id]: designName,
        [startField.id]: '2026-04-01',
        [endField.id]: '2026-04-04',
      },
    })).data.record

    await authPost(request, '/api/multitable/records', {
      sheetId: sheet.id,
      data: {
        [title.id]: buildName,
        [startField.id]: '2026-04-06',
        [endField.id]: '2026-04-10',
        [predecessor.id]: [design.id],
      },
    })

    await injectTokenAndGo(page, `/multitable/${sheet.id}/${arrowView.id}`)
    const arrows = page.locator('.meta-gantt__dependency-arrow')
    await expect(arrows.first()).toBeVisible({ timeout: 15000 })
    expect(await arrows.count()).toBeGreaterThanOrEqual(1)
  })

  test('rejects saving a gantt view with a non-link dependencyFieldId (VALIDATION_ERROR)', async ({ request }) => {
    const { sheet, title, startField, endField, view } = await setupGanttSheet(request, 'g-reject')

    // Title is a string field — the validator (validateGanttDependencyConfig)
    // requires a link field whose foreignSheetId equals the current sheet.
    const fail = await authPatchExpectingFailure(request, `/api/multitable/views/${view.id}`, {
      sheetId: sheet.id,
      type: 'gantt',
      config: {
        startFieldId: startField.id,
        endFieldId: endField.id,
        titleFieldId: title.id,
        dependencyFieldId: title.id,
      },
    })
    expect(fail.status).toBe(400)
    expect(fail.body?.error?.code).toBe('VALIDATION_ERROR')
    expect(fail.body?.error?.message ?? '').toContain('self-table link field')
  })
})
