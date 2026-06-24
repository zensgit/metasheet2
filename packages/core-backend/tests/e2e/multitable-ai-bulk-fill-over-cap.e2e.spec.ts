/**
 * B-4 Slice 3 — AI bulk-fill async OVER-CAP flow, end-to-end in the BROWSER.
 *
 * This drives the REAL stack (FE :8899 → backend :7778 worker → AI provider), NOT the
 * API: it opens the bulk-fill dialog from the UI, watches the progress UI, reviews the
 * paginated diff, selects a subset, commits, and reads the commit summary — plus a CANCEL
 * path triggered by the dialog's cancel button. It is the browser counterpart to the
 * component specs (apps/web) and the real-DB goldens (tests/integration).
 *
 * NOT PR-GATED — dispatch/local only. Requires a running stack with AI stubbed at a mock
 * provider. The harness skips automatically when the stack is unreachable. Bring up:
 *   - backend :7778 with MULTITABLE_AI_ENABLED=1, MULTITABLE_AI_BASE_URL=<mock>,
 *     MULTITABLE_AI_CONFIRM_LIVE_REQUESTS=1, MULTITABLE_AI_BULK_MAX_ROWS=1 (force job mode),
 *     RBAC_BYPASS=true
 *   - the mock AI server (./fixtures/mock-ai-server.mjs) — for the CANCEL test, start it
 *     with MOCK_AI_DELAY_MS>=1000 so the polling phase lasts long enough to click cancel.
 *   - frontend :8899
 * See docs/development/multitable-ai-bulk-fill-b4-slice3-e2e-verification-20260624.md.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import {
  API_BASE_URL,
  FE_BASE_URL,
  ensureServersReachable,
  makeAuthClient,
  createBase,
  createSheet,
  createField,
  createView,
  createRecord,
} from './multitable-helpers'

const ART = join(__dirname, 'artifacts', 'ai-bulk-fill')
mkdirSync(ART, { recursive: true })
const shot = (page: Page, name: string) => page.screenshot({ path: join(ART, name), fullPage: false })

/** Mint an admin dev token (NODE_ENV !== production). Sidesteps the phase0 login user. */
async function mintDevToken(request: APIRequestContext): Promise<string> {
  const res = await request.get(`${API_BASE_URL}/api/auth/dev-token`)
  if (!res.ok()) throw new Error(`dev-token failed: ${res.status()}`)
  return (await res.json()).token as string
}

/** Seed a base/sheet with a source field + a summarize AI field + N records. */
async function seedAiSheet(request: APIRequestContext, token: string, rows: number) {
  const client = makeAuthClient(request, token)
  const base = await createBase(client, `S3 ${Date.now()}`)
  const sheet = await createSheet(client, base.id, 'Sheet')
  const src = await createField(client, sheet.id, 'Notes', 'string')
  const ai = await createField(client, sheet.id, 'Summary', 'string', {
    aiShortcut: { kind: 'summarize', sourceFieldIds: [src.id] },
  })
  const view = await createView(client, sheet.id, 'Grid', 'grid')
  for (let i = 0; i < rows; i += 1) await createRecord(client, sheet.id, { [src.id]: `source row ${i}` })
  return { sheetId: sheet.id, viewId: view.id, aiFieldId: ai.id }
}

/**
 * Navigate to a path with the dev token + a PINNED locale injected before app load, so the
 * text selectors below are deterministic regardless of the browser default (the FE defaults
 * to 'en'; we pin 'zh-CN' to match the verified flow). data-test selectors are
 * locale-independent; only the field-manager toggle + config gear need text.
 */
async function gotoAuthed(page: Page, token: string, path: string) {
  await page.addInitScript((t: string) => {
    for (const k of ['auth_token', 'jwt', 'devToken', 'metasheet_token', 'token']) localStorage.setItem(k, t)
    localStorage.setItem('metasheet_locale', 'zh-CN')
  }, token)
  await page.goto(`${FE_BASE_URL}${path}`)
}

/** Open the bulk-fill dialog: field manager → Summary's ⚙ config → "AI fill column" trigger. */
async function openBulkFillDialog(page: Page) {
  await page.getByRole('button', { name: '⚙ 字段' }).click()
  // The config gear's accessible name is exactly "⚙" (locale-independent); Summary is the 2nd field.
  await page.getByRole('button', { name: '⚙', exact: true }).nth(1).click()
  await page.locator('[data-test="ai-bulk-fill-trigger"]').click()
  await expect(page.locator('[data-test="ai-bulk-fill"]')).toBeVisible()
}

test.describe('B-4 AI bulk-fill async over-cap (browser e2e)', () => {
  let token = ''
  test.beforeEach(async ({ request }) => {
    await ensureServersReachable(request)
    token = await mintDevToken(request)
  })

  test('over-cap: generate → progress → paginated review → select subset → commit summary', async ({ request, page }) => {
    const { sheetId, viewId, aiFieldId } = await seedAiSheet(request, token, 3)
    await gotoAuthed(page, token, `/multitable/${sheetId}/${viewId}`)

    await openBulkFillDialog(page)
    // Generate → the over-cap request creates a job (cap forced to 1) and the FE polls.
    await page.locator('[data-test="ai-bulk-generate"]').click()
    await expect(page.locator('[data-test="ai-bulk-progress-line"]')).toBeVisible()
    await shot(page, '01-progress.png')

    // Review phase: all 3 rows generated, paginated review table + charged-cost note.
    await expect(page.locator('[data-test="ai-bulk-job-confirm"]')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-test="ai-bulk-job-row"]')).toHaveCount(3)
    await expect(page.locator('[data-test="ai-bulk-cost"]')).toBeVisible()
    await shot(page, '02-review.png')

    // Commit the (default-selected) generated subset → backend chunks the write.
    await page.locator('[data-test="ai-bulk-job-confirm"]').click()
    await expect(page.locator('[data-test="ai-bulk-job-commit-summary"]')).toBeVisible({ timeout: 30_000 })
    await shot(page, '03-commit-summary.png')

    // Truth check: the records were actually written (read straight from the API).
    const client = makeAuthClient(request, token)
    const recs = await client.get<{ records: Array<{ data?: Record<string, unknown> }> }>(
      `/api/multitable/records?sheetId=${sheetId}&limit=10`,
    )
    const written = (recs.data?.records ?? []).filter((r) => typeof r.data?.[aiFieldId] === 'string' && r.data[aiFieldId])
    expect(written.length).toBe(3)
    // NOTE (finding): the OPEN grid does not auto-refresh after commit — the written
    // values appear only after a reload. Documented as a separate focused-fix item; we
    // assert the write via API rather than locking the stale-grid behavior.
  })

  test('cancel during polling → into review of generated rows (not a silent close)', async ({ request, page }) => {
    // Needs the mock started with MOCK_AI_DELAY_MS>=1000 so polling lasts long enough.
    const { sheetId, viewId } = await seedAiSheet(request, token, 5)
    await gotoAuthed(page, token, `/multitable/${sheetId}/${viewId}`)

    await openBulkFillDialog(page)
    await page.locator('[data-test="ai-bulk-generate"]').click()

    // During polling the cancel button is shown; click it before the worker finishes.
    const cancel = page.locator('[data-test="ai-bulk-job-cancel"]')
    await expect(cancel).toBeVisible({ timeout: 15_000 })
    await cancel.click()

    // Cancel must transition INTO review (dialog stays open), exposing the rows generated
    // before cancel as committable and the unreached rows truthfully as "not generated".
    await expect(page.locator('[data-test="ai-bulk-fill"]')).toBeVisible()
    await expect(page.locator('[data-test="ai-bulk-job-pending"]')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('[data-test="ai-bulk-job-confirm"]')).toBeVisible()
    await shot(page, '04-cancel-review.png')
  })
})
