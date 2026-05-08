/**
 * Multitable public form submit smoke E2E.
 *
 * Closes RC TODO `Smoke test public form submit path`. Migrated to the
 * shared multitable-helpers.ts scaffold in PR #1424 (formula-smoke +
 * helper-extraction lane). Admin sets up a sheet, enables public form
 * sharing on a grid view, then an anonymous request submits a record
 * via the unauthenticated submit endpoint.
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
import {
  API_BASE_URL,
  createBase,
  createField,
  createSheet,
  createView,
  ensureServersReachable,
  loginAsPhase0,
  makeAuthClient,
  requireValue,
  uniqueLabel,
  type AuthClient,
  type Entity,
} from './multitable-helpers'

let token = ''

test.beforeAll(async ({ request }) => {
  await ensureServersReachable(request)
  token = await loginAsPhase0(request)
})

async function setupSheetWithStringField(client: AuthClient, label: string): Promise<{
  base: Entity
  sheet: Entity
  field: Entity
  view: Entity
}> {
  const base = await createBase(client, `${label}-base`)
  const sheet = await createSheet(client, base.id, `${label}-sheet`)
  const field = await createField(client, sheet.id, 'Title', 'string')

  const viewsBody = await client.get<{ views: Array<Entity & { type: string }> }>(`/api/multitable/views?sheetId=${sheet.id}`)
  const existingViews = viewsBody.data?.views ?? []
  let view: Entity | undefined = existingViews.find((v) => v.type === 'grid') ?? existingViews[0]
  if (!view) {
    view = await createView(client, sheet.id, 'Default Grid', 'grid')
  }
  return { base, sheet, field, view: requireValue(view, 'grid view') }
}

async function anonymousPost(request: APIRequestContext, path: string, body: unknown) {
  return request.post(`${API_BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    data: body,
  })
}

test.describe('Multitable public form smoke', () => {
  test('admin enables public form, anonymous submits, record persists', async ({ request }) => {
    const client = makeAuthClient(request, token)
    const { sheet, field, view } = await setupSheetWithStringField(client, uniqueLabel('pf-happy'))

    const shareBody = await client.patch<{ publicToken?: string }>(`/api/multitable/sheets/${sheet.id}/views/${view.id}/form-share`, {
      enabled: true,
      accessMode: 'public',
    })
    const publicToken = requireValue(shareBody.data?.publicToken, 'publicToken')
    expect(typeof publicToken).toBe('string')

    const cellValue = `pf-anon-${Date.now()}`
    const submitRes = await anonymousPost(request, `/api/multitable/views/${view.id}/submit`, {
      publicToken,
      data: { [field.id]: cellValue },
    })
    expect(submitRes.ok()).toBe(true)
    const submitBody = (await submitRes.json()) as { data?: { record?: Entity & { data?: Record<string, unknown> } } }
    const newRecordId = requireValue(submitBody.data?.record?.id, 'submitted record id')

    const recordsBody = await client.get<{ records: Array<Entity & { data: Record<string, unknown> }> }>(`/api/multitable/records?sheetId=${sheet.id}`)
    const rows = recordsBody.data?.records ?? []
    const persisted = rows.find((row) => row.id === newRecordId)
    expect(persisted, 'record should be visible to admin after public submit').toBeTruthy()
    expect(persisted?.data?.[field.id]).toBe(cellValue)
  })

  test('rejects anonymous submit when public form is disabled (regression guard)', async ({ request }) => {
    const client = makeAuthClient(request, token)
    const { view, field } = await setupSheetWithStringField(client, uniqueLabel('pf-disabled'))

    const res = await anonymousPost(request, `/api/multitable/views/${view.id}/submit`, {
      publicToken: 'definitely-not-the-real-token',
      data: { [field.id]: 'should-not-persist' },
    })
    expect(res.status()).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'Authentication required' })
  })

  test('rejects anonymous submit with stale token after regenerate (regression guard)', async ({ request }) => {
    const client = makeAuthClient(request, token)
    const { sheet, field, view } = await setupSheetWithStringField(client, uniqueLabel('pf-rotated'))

    const shareBody = await client.patch<{ publicToken?: string }>(`/api/multitable/sheets/${sheet.id}/views/${view.id}/form-share`, {
      enabled: true,
      accessMode: 'public',
    })
    const oldToken = requireValue(shareBody.data?.publicToken, 'old publicToken')

    const regenBody = await client.post<{ publicToken?: string }>(`/api/multitable/sheets/${sheet.id}/views/${view.id}/form-share/regenerate`, {})
    const newToken = requireValue(regenBody.data?.publicToken, 'new publicToken')
    expect(newToken).not.toBe(oldToken)

    const staleRes = await anonymousPost(request, `/api/multitable/views/${view.id}/submit`, {
      publicToken: oldToken,
      data: { [field.id]: 'rotated-out' },
    })
    expect(staleRes.status()).toBe(401)
    expect(await staleRes.json()).toMatchObject({ error: 'Authentication required' })

    const rotatedValue = `pf-rotated-${Date.now()}`
    const okRes = await anonymousPost(request, `/api/multitable/views/${view.id}/submit`, {
      publicToken: newToken,
      data: { [field.id]: rotatedValue },
    })
    expect(okRes.ok()).toBe(true)
    const okBody = (await okRes.json()) as { data?: { record?: { data?: Record<string, unknown> } } }
    expect(okBody.data?.record?.data?.[field.id]).toBe(rotatedValue)
  })
})
