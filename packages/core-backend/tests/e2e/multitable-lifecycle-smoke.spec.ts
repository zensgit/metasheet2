/**
 * Multitable lifecycle smoke E2E.
 *
 * Closes RC TODO `Smoke test basic multitable sheet lifecycle: create base,
 * sheet, view, fields, records.` Exercises the full create chain through
 * the public REST API and asserts the workbench frontend renders the
 * resulting record.
 *
 * Migrated to the shared multitable-helpers.ts scaffold in PR #1423
 * (the formula-smoke + helper-extraction lane).
 *
 * Prerequisites: Metasheet backend (:7778) and frontend (:8899) running
 * locally. Tests skip if either server is unreachable.
 *
 * Run:
 *   cd packages/core-backend
 *   npx playwright test --config tests/e2e/playwright.config.ts \
 *     multitable-lifecycle-smoke.spec.ts
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
  loginAsPhase0,
  makeAuthClient,
  requireValue,
  uniqueLabel,
  type Entity,
} from './multitable-helpers'

let token = ''

test.beforeAll(async ({ request }) => {
  await ensureServersReachable(request)
  token = await loginAsPhase0(request)
})

test.describe('Multitable lifecycle smoke', () => {
  test('creates base, sheet, field, view, record and renders in workbench', async ({ request, page }) => {
    const client = makeAuthClient(request, token)
    const label = uniqueLabel('smoke')

    const base = await createBase(client, `${label}-base`)
    const sheet = await createSheet(client, base.id, `${label}-sheet`)
    const field = await createField(client, sheet.id, 'Title', 'string')
    expect(field.id).toBeTruthy()

    const viewsBody = await client.get<{ views: Array<Entity & { type: string }> }>(`/api/multitable/views?sheetId=${sheet.id}`)
    const existingViews = viewsBody.data?.views ?? []
    let view: Entity | undefined = existingViews.find((v) => v.type === 'grid') ?? existingViews[0]
    if (!view) {
      view = await createView(client, sheet.id, 'Default Grid', 'grid')
    }
    const resolvedView = requireValue(view, 'view')

    const cellValue = `smoke-record-${label}`
    const record = await createRecord(client, sheet.id, { [field.id]: cellValue })
    expect(record.data[field.id]).toBe(cellValue)

    await injectTokenAndGo(page, token, `/multitable/${sheet.id}/${resolvedView.id}`)
    await expect(page.locator('body')).toContainText(cellValue, { timeout: 15000 })
  })

  test('rejects client-supplied autoNumber values during record create (regression guard)', async ({ request }) => {
    const client = makeAuthClient(request, token)
    const label = uniqueLabel('smoke-an')

    const base = await createBase(client, `${label}-base`)
    const sheet = await createSheet(client, base.id, `${label}-sheet`)
    const seq = await createField(client, sheet.id, 'No.', 'autoNumber', { start: 1 })

    const fail = await client.postExpectingFailure('/api/multitable/records', {
      sheetId: sheet.id,
      data: { [seq.id]: 999 },
    })
    expect(fail.status).toBe(403)
    expect(fail.body).toMatchObject({
      ok: false,
      error: {
        code: 'FIELD_READONLY',
        message: `Field is readonly: ${seq.id}`,
      },
    })
  })
})
