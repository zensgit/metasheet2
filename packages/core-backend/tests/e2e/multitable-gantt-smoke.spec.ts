/**
 * Multitable Gantt view rendering smoke E2E.
 *
 * Closes RC TODO `Smoke test Gantt view rendering`. Migrated to the
 * shared multitable-helpers.ts scaffold in PR #1424 (formula-smoke +
 * helper-extraction lane).
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
  type Entity,
} from './multitable-helpers'

let token = ''

test.beforeAll(async ({ request }) => {
  await ensureServersReachable(request)
  token = await resolveE2EAuthToken(request)
})

async function setupGanttSheet(client: AuthClient, label: string): Promise<{
  sheet: Entity
  title: Entity
  startField: Entity
  endField: Entity
  view: Entity
}> {
  const base = await createBase(client, `${label}-base`)
  const sheet = await createSheet(client, base.id, `${label}-sheet`)
  const title = await createField(client, sheet.id, 'Title', 'string')
  const startField = await createField(client, sheet.id, 'Start', 'date')
  const endField = await createField(client, sheet.id, 'End', 'date')
  const view = await createView(client, sheet.id, 'Gantt', 'gantt', {
    startFieldId: startField.id,
    endFieldId: endField.id,
    titleFieldId: title.id,
  })
  return { sheet, title, startField, endField, view }
}

test.describe('Multitable Gantt smoke', () => {
  test('renders task bars and labels for records with date ranges', async ({ request, page }) => {
    const client = makeAuthClient(request, token)
    const { sheet, title, startField, endField, view } = await setupGanttSheet(client, uniqueLabel('g-render'))

    const stamp = Date.now()
    const designName = `g-design-${stamp}`
    const buildName = `g-build-${stamp}`

    await createRecord(client, sheet.id, {
      [title.id]: designName,
      [startField.id]: '2026-04-01',
      [endField.id]: '2026-04-05',
    })
    await createRecord(client, sheet.id, {
      [title.id]: buildName,
      [startField.id]: '2026-04-06',
      [endField.id]: '2026-04-12',
    })

    await injectTokenAndGo(page, token, `/multitable/${sheet.id}/${view.id}`)
    const bars = page.locator('.meta-gantt__bar')
    await expect(bars.first()).toBeVisible({ timeout: 15000 })
    expect(await bars.count()).toBeGreaterThanOrEqual(2)

    const body = page.locator('body')
    await expect(body).toContainText(designName)
    await expect(body).toContainText(buildName)
  })

  test('renders dependency arrows when dependencyFieldId is configured', async ({ request, page }) => {
    const client = makeAuthClient(request, token)
    const { sheet, title, startField, endField } = await setupGanttSheet(client, uniqueLabel('g-arrow'))

    const predecessor = await createField(client, sheet.id, 'Predecessor', 'link', {
      foreignSheetId: sheet.id,
      limitSingleRecord: true,
    })

    const arrowView = await createView(client, sheet.id, 'Gantt-with-arrows', 'gantt', {
      startFieldId: startField.id,
      endFieldId: endField.id,
      titleFieldId: title.id,
      dependencyFieldId: predecessor.id,
    })

    const stamp = Date.now()
    const designName = `g-design-arrow-${stamp}`
    const buildName = `g-build-arrow-${stamp}`

    const design = await createRecord(client, sheet.id, {
      [title.id]: designName,
      [startField.id]: '2026-04-01',
      [endField.id]: '2026-04-04',
    })

    await createRecord(client, sheet.id, {
      [title.id]: buildName,
      [startField.id]: '2026-04-06',
      [endField.id]: '2026-04-10',
      [predecessor.id]: [design.id],
    })

    await injectTokenAndGo(page, token, `/multitable/${sheet.id}/${arrowView.id}`)
    const arrows = page.locator('.meta-gantt__dependency-arrow')
    await expect(arrows.first()).toBeVisible({ timeout: 15000 })
    expect(await arrows.count()).toBeGreaterThanOrEqual(1)
  })

  test('rejects saving a gantt view with a non-link dependencyFieldId (VALIDATION_ERROR)', async ({ request }) => {
    const client = makeAuthClient(request, token)
    const { sheet, title, startField, endField, view } = await setupGanttSheet(client, uniqueLabel('g-reject'))

    // Title is a string field — the validator (validateGanttDependencyConfig)
    // requires a link field whose foreignSheetId equals the current sheet.
    const fail = await client.patchExpectingFailure(`/api/multitable/views/${view.id}`, {
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
