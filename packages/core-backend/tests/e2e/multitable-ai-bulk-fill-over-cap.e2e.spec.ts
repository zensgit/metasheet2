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

    // SELECT A SUBSET: deselect the first generated row → commit only the remaining 2 (a
    // true subset, not an all-rows commit).
    await page.locator('[data-test="ai-bulk-job-row-select"]').first().click()
    await expect(page.locator('[data-test="ai-bulk-job-confirm"]')).toContainText('(2)')
    await shot(page, '02-review.png')

    // Commit the selected subset → backend chunks the write.
    await page.locator('[data-test="ai-bulk-job-confirm"]').click()
    await expect(page.locator('[data-test="ai-bulk-job-commit-summary"]')).toBeVisible({ timeout: 30_000 })
    await shot(page, '03-commit-summary.png')

    // Truth check: EXACTLY the selected 2 were written (the deselected row left empty) —
    // read straight from the API.
    const client = makeAuthClient(request, token)
    const recs = await client.get<{ records: Array<{ data?: Record<string, unknown> }> }>(
      `/api/multitable/records?sheetId=${sheetId}&limit=10`,
    )
    const written = (recs.data?.records ?? []).filter((r) => typeof r.data?.[aiFieldId] === 'string' && r.data[aiFieldId])
    expect(written.length).toBe(2)

    // GRID REFRESH (this PR's fix): close the dialog and confirm the committed AI values are
    // now rendered IN THE GRID without a manual reload. Before the fix the grid kept showing
    // the pre-fill cells ("—") until a page reload; the dialog's `committed` event now drives
    // grid.reloadCurrentPage().
    await page.locator('[data-test="ai-bulk-job-done"]').click()
    await expect(page.locator('[data-test="ai-bulk-fill"]')).toBeHidden()
    // Close the field manager too, so the grid is unobscured for the assertion + screenshot.
    await page.locator('.meta-field-mgr__close').click()
    await expect(page.locator('[role="gridcell"]').filter({ hasText: 'AI summary' }).first()).toBeVisible({ timeout: 15_000 })
    await shot(page, '05-grid-refreshed.png')
  })

  test('cancel AFTER ≥1 generated → those rows stay committable; unreached rows are pending (not a silent close)', async ({ request, page }) => {
    // Needs the mock started with MOCK_AI_DELAY_MS>=1000 so the worker is slow enough to
    // cancel mid-run AFTER at least one row has been generated (the B-4 cancel contract:
    // already-generated rows remain charged + committable).
    const { sheetId, viewId, aiFieldId } = await seedAiSheet(request, token, 5)
    await gotoAuthed(page, token, `/multitable/${sheetId}/${viewId}`)

    await openBulkFillDialog(page)
    await page.locator('[data-test="ai-bulk-generate"]').click()

    // Wait until the progress line reports ≥1 row GENERATED, THEN cancel — so we exercise
    // the already-generated-rows-stay-committable path, not cancel-before-generation.
    await expect
      .poll(
        async () => {
          const t = (await page.locator('[data-test="ai-bulk-progress-line"]').textContent().catch(() => '')) ?? ''
          const m = t.match(/(\d+)\s*\/\s*\d+/)
          return m ? Number(m[1]) : 0
        },
        { timeout: 20_000 },
      )
      .toBeGreaterThanOrEqual(1)
    await page.locator('[data-test="ai-bulk-job-cancel"]').click()

    // Into review (dialog stays open): ≥1 generated row committable + unreached rows pending.
    await expect(page.locator('[data-test="ai-bulk-fill"]')).toBeVisible()
    const generated = page.locator('[data-test="ai-bulk-job-row"]')
    await expect(generated.first()).toBeVisible({ timeout: 15_000 })
    const generatedCount = await generated.count()
    expect(generatedCount).toBeGreaterThanOrEqual(1)
    expect(generatedCount).toBeLessThan(5) // not all generated → there must be a pending remainder
    await expect(page.locator('[data-test="ai-bulk-job-pending"]')).toBeVisible()
    await expect(page.locator('[data-test="ai-bulk-job-confirm"]')).toBeEnabled()
    await shot(page, '04-cancel-review.png')

    // Prove COMMITTABLE: writing the cancelled job's generated subset succeeds.
    await page.locator('[data-test="ai-bulk-job-confirm"]').click()
    await expect(page.locator('[data-test="ai-bulk-job-commit-summary"]')).toBeVisible({ timeout: 30_000 })
    const client = makeAuthClient(request, token)
    const recs = await client.get<{ records: Array<{ data?: Record<string, unknown> }> }>(
      `/api/multitable/records?sheetId=${sheetId}&limit=10`,
    )
    const written = (recs.data?.records ?? []).filter((r) => typeof r.data?.[aiFieldId] === 'string' && r.data[aiFieldId])
    expect(written.length).toBe(generatedCount) // the generated subset was charged + committed
  })
})
