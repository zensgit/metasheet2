/**
 * Multitable basic-views login-session UI smoke.
 *
 * Closes the gap flagged in issue #1780 closure notes: the existing
 * `multitable-rc:ui` wrapper only exercises Gantt; basic view types
 * (grid / calendar / kanban / gallery / form) had no logged-in UI smoke
 * even though the comments declared them PASS via API smoke. This spec
 * pairs with the `verify-multitable-views-ui-smoke.sh` wrapper to make
 * the assertion auditable.
 *
 * Five tests, each renders a different view type against a shared
 * single-sheet fixture (one base, one sheet, three fields, three
 * records). Tests run serial because they share that fixture; they
 * create their own view to keep coupling minimal.
 *
 * Each test asserts:
 *   - `.mt-workbench` (the workbench root) is visible
 *   - a view-type-specific selector is visible
 *   - at least one record's data renders
 *
 * Prerequisites: backend (:7778) + frontend (:8899) running locally,
 * OR FE_BASE_URL/API_BASE_URL/AUTH_TOKEN set against a deployed stack.
 * Skips when servers are unreachable (matches the shared helper).
 *
 * Run locally:
 *   cd packages/core-backend
 *   npx playwright test --config tests/e2e/playwright.config.ts \
 *     multitable-basic-views-smoke.spec.ts
 *
 * Run against a deployment via the wrapper:
 *   FE_BASE_URL=... API_BASE_URL=... AUTH_TOKEN=... \
 *     bash scripts/verify-multitable-views-ui-smoke.sh
 */
import { test, expect } from '@playwright/test'
import {
  createBase,
  createField,
  createRecord,
  createSheet,
  createView,
  ensureServersReachable,
  injectTokenAndGo,
  makeAuthClient,
  resolveE2EAuthToken,
  uniqueLabel,
  type AuthClient,
  type CreatedRecord,
  type Entity,
} from './multitable-helpers'

let token = ''

type SharedFixture = {
  sheet: Entity
  title: Entity
  due: Entity
  status: Entity
  records: CreatedRecord[]
}

let fixture: SharedFixture | null = null

async function setupSharedFixture(client: AuthClient): Promise<SharedFixture> {
  const label = uniqueLabel('basic-views')
  const base = await createBase(client, `${label}-base`)
  const sheet = await createSheet(client, base.id, `${label}-sheet`)
  const title = await createField(client, sheet.id, 'Title', 'string')
  const due = await createField(client, sheet.id, 'Due', 'date')
  const status = await createField(client, sheet.id, 'Status', 'select', {
    options: ['Todo', 'Doing', 'Done'],
  })

  // Dates are computed relative to today so calendar opens on a month
  // containing fixture records regardless of when the spec runs. Anchored
  // mid-month (day 15) so a date drift of ±10 days stays in the same view.
  const stamp = Date.now()
  const today = new Date()
  const yyyy = today.getUTCFullYear()
  const mm = String(today.getUTCMonth() + 1).padStart(2, '0')
  const records: CreatedRecord[] = []
  records.push(await createRecord(client, sheet.id, {
    [title.id]: `bv-design-${stamp}`,
    [due.id]: `${yyyy}-${mm}-10`,
    [status.id]: 'Todo',
  }))
  records.push(await createRecord(client, sheet.id, {
    [title.id]: `bv-build-${stamp}`,
    [due.id]: `${yyyy}-${mm}-15`,
    [status.id]: 'Doing',
  }))
  records.push(await createRecord(client, sheet.id, {
    [title.id]: `bv-ship-${stamp}`,
    [due.id]: `${yyyy}-${mm}-20`,
    [status.id]: 'Done',
  }))

  return { sheet, title, due, status, records }
}

test.beforeAll(async ({ request }) => {
  await ensureServersReachable(request)
  token = await resolveE2EAuthToken(request)
  const client = makeAuthClient(request, token)
  fixture = await setupSharedFixture(client)
})

function requireFixture(): SharedFixture {
  if (!fixture) throw new Error('Shared fixture not initialised — beforeAll skipped?')
  return fixture
}

test.describe('Multitable basic views smoke', () => {
  test('grid view renders workbench, rows, and cell data', async ({ request, page }) => {
    const f = requireFixture()
    const client = makeAuthClient(request, token)
    const view = await createView(client, f.sheet.id, 'Grid view', 'grid')

    await injectTokenAndGo(page, token, `/multitable/${f.sheet.id}/${view.id}`)

    const workbench = page.locator('.mt-workbench')
    await expect(workbench).toBeVisible({ timeout: 15000 })

    const rows = page.locator('.meta-grid__row')
    await expect(rows.first()).toBeVisible({ timeout: 15000 })
    expect(await rows.count()).toBeGreaterThanOrEqual(f.records.length)

    await expect(page.locator('body')).toContainText(String(f.records[0].data[f.title.id]))
  })

  test('calendar view renders header, grid, and cell content for date records', async ({ request, page }) => {
    const f = requireFixture()
    const client = makeAuthClient(request, token)
    const view = await createView(client, f.sheet.id, 'Calendar view', 'calendar', {
      dateFieldId: f.due.id,
      titleFieldId: f.title.id,
    })

    await injectTokenAndGo(page, token, `/multitable/${f.sheet.id}/${view.id}`)

    const workbench = page.locator('.mt-workbench')
    await expect(workbench).toBeVisible({ timeout: 15000 })

    const calendarGrid = page.locator('.meta-calendar__grid')
    await expect(calendarGrid).toBeVisible({ timeout: 15000 })
    await expect(page.locator('.meta-calendar__title')).toBeVisible()
    expect(await page.locator('.meta-calendar__cell').count()).toBeGreaterThan(0)

    // Catches "calendar shell renders but date-bound records never appear".
    // Fixture dates are computed relative to today (see setupSharedFixture),
    // so they land in the calendar's default current-month view regardless
    // of when the spec runs.
    await expect(page.locator('body')).toContainText(String(f.records[0].data[f.title.id]), { timeout: 15000 })
  })

  test('kanban view renders board with grouped columns', async ({ request, page }) => {
    const f = requireFixture()
    const client = makeAuthClient(request, token)
    const view = await createView(client, f.sheet.id, 'Kanban view', 'kanban', {
      groupFieldId: f.status.id,
      titleFieldId: f.title.id,
    })

    await injectTokenAndGo(page, token, `/multitable/${f.sheet.id}/${view.id}`)

    const workbench = page.locator('.mt-workbench')
    await expect(workbench).toBeVisible({ timeout: 15000 })

    const board = page.locator('.meta-kanban__board')
    await expect(board).toBeVisible({ timeout: 15000 })
    expect(await page.locator('.meta-kanban__column').count()).toBeGreaterThanOrEqual(2)
    await expect(page.locator('body')).toContainText(String(f.records[0].data[f.title.id]))
  })

  test('gallery view renders grid of cards with record titles', async ({ request, page }) => {
    const f = requireFixture()
    const client = makeAuthClient(request, token)
    const view = await createView(client, f.sheet.id, 'Gallery view', 'gallery', {
      titleFieldId: f.title.id,
    })

    await injectTokenAndGo(page, token, `/multitable/${f.sheet.id}/${view.id}`)

    const workbench = page.locator('.mt-workbench')
    await expect(workbench).toBeVisible({ timeout: 15000 })

    const galleryGrid = page.locator('.meta-gallery__grid')
    await expect(galleryGrid).toBeVisible({ timeout: 15000 })
    const cards = page.locator('.meta-gallery__card')
    expect(await cards.count()).toBeGreaterThanOrEqual(f.records.length)
    await expect(page.locator('body')).toContainText(String(f.records[0].data[f.title.id]))
  })

  test('form view renders the form shell for the configured fields', async ({ request, page }) => {
    const f = requireFixture()
    const client = makeAuthClient(request, token)
    const view = await createView(client, f.sheet.id, 'Form view', 'form')

    await injectTokenAndGo(page, token, `/multitable/${f.sheet.id}/${view.id}`)

    const workbench = page.locator('.mt-workbench')
    await expect(workbench).toBeVisible({ timeout: 15000 })

    const formShell = page.locator('.meta-form-view')
    await expect(formShell).toBeVisible({ timeout: 15000 })

    // Catches "shell renders but never binds to schema" — Title is on every
    // record via the shared fixture, so its field label must reach the DOM.
    await expect(formShell).toContainText('Title')
  })
})
