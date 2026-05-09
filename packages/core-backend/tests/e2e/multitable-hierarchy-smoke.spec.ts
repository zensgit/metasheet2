/**
 * Multitable Hierarchy view smoke E2E.
 *
 * Closes RC TODO `Smoke test Hierarchy view rendering and child creation`.
 * Migrated to the shared multitable-helpers.ts scaffold in PR #1424
 * (formula-smoke + helper-extraction lane).
 *
 * Admin creates a sheet with a self-table single-value link parent
 * field, configures a hierarchy view, creates a parent record, then a
 * child record carrying the parent link. Browser asserts the
 * workbench renders both names. Two regression guards exercise the
 * server-side hierarchy cycle guard
 * (assertNoHierarchyParentCycle in
 * packages/core-backend/src/multitable/hierarchy-cycle-guard.ts) at
 * the HTTP layer.
 *
 * Prerequisites: Metasheet backend (:7778) and frontend (:8899) running
 * locally. Tests skip if either server is unreachable.
 *
 * Run:
 *   cd packages/core-backend
 *   npx playwright test --config tests/e2e/playwright.config.ts \
 *     multitable-hierarchy-smoke.spec.ts
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

async function setupHierarchySheet(client: AuthClient, label: string): Promise<{
  base: Entity
  sheet: Entity
  title: Entity
  parent: Entity
  view: Entity
}> {
  const base = await createBase(client, `${label}-base`)
  const sheet = await createSheet(client, base.id, `${label}-sheet`)
  const title = await createField(client, sheet.id, 'Title', 'string')
  const parent = await createField(client, sheet.id, 'Parent', 'link', {
    foreignSheetId: sheet.id,
    limitSingleRecord: true,
  })
  const view = await createView(client, sheet.id, 'Hierarchy', 'hierarchy', { parentFieldId: parent.id })
  return { base, sheet, title, parent, view }
}

test.describe('Multitable Hierarchy smoke', () => {
  test('renders parent and child records in the hierarchy workbench', async ({ request, page }) => {
    const client = makeAuthClient(request, token)
    const { sheet, title, parent, view } = await setupHierarchySheet(client, uniqueLabel('h-render'))

    const stamp = Date.now()
    const parentName = `h-parent-${stamp}`
    const childName = `h-child-${stamp}`

    const parentRecord = await createRecord(client, sheet.id, { [title.id]: parentName })
    expect(parentRecord.id).toBeTruthy()

    const childRecord = await createRecord(client, sheet.id, { [title.id]: childName, [parent.id]: [parentRecord.id] })
    expect(childRecord.id).toBeTruthy()

    await injectTokenAndGo(page, token, `/multitable/${sheet.id}/${view.id}`)
    const body = page.locator('body')
    await expect(body).toContainText(parentName, { timeout: 15000 })
    await expect(body).toContainText(childName, { timeout: 15000 })
  })

  test('rejects setting a record as its own parent (HIERARCHY_CYCLE)', async ({ request }) => {
    const client = makeAuthClient(request, token)
    const { sheet, title, parent } = await setupHierarchySheet(client, uniqueLabel('h-self'))

    const record = await createRecord(client, sheet.id, { [title.id]: 'self-loop-candidate' })

    const fail = await client.patchExpectingFailure(`/api/multitable/records/${record.id}`, {
      sheetId: sheet.id,
      data: { [parent.id]: [record.id] },
    })
    expect(fail.status).toBe(400)
    expect(fail.body?.error?.code).toBe('HIERARCHY_CYCLE')
  })

  test('rejects setting a descendant as the parent (HIERARCHY_CYCLE through chain)', async ({ request }) => {
    const client = makeAuthClient(request, token)
    const { sheet, title, parent } = await setupHierarchySheet(client, uniqueLabel('h-chain'))

    const a = await createRecord(client, sheet.id, { [title.id]: 'A' })
    const b = await createRecord(client, sheet.id, { [title.id]: 'B', [parent.id]: [a.id] })
    const c = await createRecord(client, sheet.id, { [title.id]: 'C', [parent.id]: [b.id] })

    // Try to set A's parent to C — would create cycle A → C → B → A.
    const fail = await client.patchExpectingFailure(`/api/multitable/records/${a.id}`, {
      sheetId: sheet.id,
      data: { [parent.id]: [c.id] },
    })
    expect(fail.status).toBe(400)
    expect(fail.body?.error?.code).toBe('HIERARCHY_CYCLE')

    // Sanity: a non-cycle reparent on the same chain still works.
    const ok = await client.patch<{ record: Entity }>(`/api/multitable/records/${b.id}`, {
      sheetId: sheet.id,
      data: { [parent.id]: [] },
    })
    expect(ok.data?.record?.id).toBe(b.id)
  })
})
