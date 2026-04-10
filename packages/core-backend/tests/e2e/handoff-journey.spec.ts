/**
 * Federated handoff journey E2E regression.
 *
 * Validates the full source product → AML related document → return to source
 * user journey introduced in Phase 0.13.
 *
 * Prerequisites: Yuantus (:7910), Metasheet backend (:7778), frontend (:8899)
 * must be running externally. Tests skip if servers are unreachable.
 *
 * Run:
 *   npx playwright test --config tests/e2e/playwright.config.ts
 */
import { test, expect } from '@playwright/test'

const FE = 'http://127.0.0.1:8899'
const API = 'http://localhost:7778'
const B_ID = 'b5ecee24-5ce8-4b59-9551-446e1c50b608'

// ── Setup: login + connect PLM, skip if servers down ──────────

let token = ''

test.beforeAll(async ({ request }) => {
  // Skip entire suite if servers are not reachable
  try {
    const health = await request.get(`${API}/health`, { timeout: 3000 })
    if (!health.ok()) test.skip(true, 'Metasheet backend not reachable')
  } catch {
    test.skip(true, 'Metasheet backend not reachable')
  }

  // Login
  const loginRes = await request.post(`${API}/api/auth/login`, {
    data: { email: 'phase0@test.local', password: 'Phase0Test!2026' },
  })
  const loginBody = await loginRes.json()
  token = loginBody.data?.token
  if (!token) test.skip(true, 'Login failed — phase0 user may not exist')

  // Connect PLM
  await request.post(`${API}/api/federation/systems/plm/connect`, {
    headers: { Authorization: `Bearer ${token}` },
  })
})

// ── Helpers ───────────────────────────────────────────────────

async function injectTokenAndGo(page: any, path: string) {
  await page.goto(FE)
  await page.evaluate((t: string) => {
    localStorage.setItem('metasheet_token', t)
    localStorage.setItem('token', t)
  }, token)
  await page.goto(`${FE}${path}`)
  await page.waitForTimeout(2000)
}

async function clickLoad(page: any) {
  const btn = page.locator('button:has-text("加载产品")').first()
  if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await btn.click()
    await page.waitForTimeout(4000)
  }
}

async function clickRefreshDocs(page: any) {
  const btn = page.locator('button:has-text("刷新文档")').first()
  if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await btn.click()
    await page.waitForTimeout(3000)
  }
}

// ── Tests ─────────────────────────────────────────────────────

test.describe('Federated document handoff journey', () => {
  test('"打开" button only appears on AML related document rows', async ({ page }) => {
    await injectTokenAndGo(page, `/plm?productId=${B_ID}`)
    await clickLoad(page)
    await clickRefreshDocs(page)

    // The doc table should have 2 rows: attachment + AML doc.
    // "打开" should only be on the AML doc row.
    const openButtons = page.locator('button:has-text("打开")')
    await expect(openButtons).toHaveCount(1)

    // The AML doc row should contain "Doc UI Doc" or "document"
    const amlRow = page.locator('tr:has(button:has-text("打开"))')
    await expect(amlRow).toContainText('document')
  })

  test('clicking "打开" switches to Document item without manual type change', async ({ page }) => {
    await injectTokenAndGo(page, `/plm?productId=${B_ID}`)
    await clickLoad(page)
    await clickRefreshDocs(page)

    // Click the "打开" button
    await page.locator('button:has-text("打开")').first().click()
    await page.waitForTimeout(4000)

    // Verify Document detail loaded
    const body = await page.locator('body').textContent()
    expect(body).toMatch(/Doc UI Doc|DOCUI-D/)
    expect(body).toContain('Document')
  })

  test('"← 返回源产品" banner appears after handoff and works', async ({ page }) => {
    await injectTokenAndGo(page, `/plm?productId=${B_ID}`)
    await clickLoad(page)
    await clickRefreshDocs(page)

    // Handoff to document
    await page.locator('button:has-text("打开")').first().click()
    await page.waitForTimeout(4000)

    // Return banner should be visible
    const returnBtn = page.locator('button:has-text("返回源产品")')
    await expect(returnBtn).toBeVisible()

    const hint = page.locator('.return-hint')
    await expect(hint).toContainText('关联文档对象')

    // Click return
    await returnBtn.click()
    await page.waitForTimeout(4000)

    // Source product restored
    const body = await page.locator('body').textContent()
    expect(body).toMatch(/Doc UI Product|DOCUI-P/)

    // Return button should be gone
    await expect(returnBtn).not.toBeVisible()
  })

  test('documents survive full roundtrip without degradation', async ({ page }) => {
    await injectTokenAndGo(page, `/plm?productId=${B_ID}`)
    await clickLoad(page)
    await clickRefreshDocs(page)

    // Handoff → return
    await page.locator('button:has-text("打开")').first().click()
    await page.waitForTimeout(4000)
    await page.locator('button:has-text("返回源产品")').first().click()
    await page.waitForTimeout(4000)

    // Refresh documents after roundtrip
    await clickRefreshDocs(page)

    // Both document types should still be present
    const body = await page.locator('body').textContent()
    expect(body).toMatch(/drawing|\.pdf/)    // attachment
    expect(body).toContain('Doc UI Doc')      // AML related doc

    // No degradation warning
    const warning = page.locator('.status.warning')
    await expect(warning).not.toBeVisible()
  })
})
