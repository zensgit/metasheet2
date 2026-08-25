import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const OUT = 'verification-output'
const HARNESS = '/verification/attendance-employee-overview-below-fold-harness.html'

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(
    overflow.scrollWidth,
    `horizontal overflow: scrollWidth ${overflow.scrollWidth} vs clientWidth ${overflow.clientWidth}`,
  ).toBeLessThanOrEqual(overflow.clientWidth)
}

function isInside(inner: { x: number; y: number; width: number; height: number }, outer: { x: number; y: number; width: number; height: number }) {
  const epsilon = 1
  return (
    inner.x >= outer.x - epsilon
    && inner.y >= outer.y - epsilon
    && inner.x + inner.width <= outer.x + outer.width + epsilon
    && inner.y + inner.height <= outer.y + outer.height + epsilon
  )
}

async function assertExpandedFiltersFit(page: Page, viewport: { width: number; height: number }, shot: string) {
  await page.setViewportSize(viewport)
  const errs: string[] = []
  page.on('pageerror', (error) => errs.push(String(error)))

  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' })
  const filters = page.locator('[data-attendance-history-filters]')
  await expect(filters).toBeVisible()
  await expect(filters).toHaveJSProperty('open', false)
  await filters.locator('summary').click()
  await expect(filters).toHaveJSProperty('open', true)

  const cardBox = await filters.boundingBox()
  expect(cardBox, 'history disclosure box').toBeTruthy()

  const controls: Locator[] = [
    page.locator('#attendance-from-date'),
    page.locator('#attendance-to-date'),
    page.locator('#attendance-org-id'),
    page.locator('#attendance-user-id'),
    page.locator('[data-attendance-history-filters] button'),
  ]
  for (const control of controls) {
    await expect(control).toBeVisible()
    const box = await control.boundingBox()
    expect(box, `control ${await control.getAttribute('id') || 'button'} box`).toBeTruthy()
    expect(
      isInside(box!, cardBox!),
      `control overflows history disclosure at ${viewport.width}x${viewport.height}`,
    ).toBe(true)
  }

  await noHorizontalOverflow(page)
  await page.screenshot({ path: `${OUT}/${shot}`, fullPage: true })
  expect(errs, `page errors: ${errs.join('; ')}`).toEqual([])
}

test.describe('employee overview below-fold browser acceptance', () => {
  test.beforeAll(() => {
    mkdirSync(OUT, { recursive: true })
  })

  test('1440x900: expanded history filters stay inside the disclosure without horizontal scroll', async ({ page }) => {
    await assertExpandedFiltersFit(page, { width: 1440, height: 900 }, 'attendance-ew-below-fold-1440x900-filters.png')
  })

  test('390x844: expanded history filters stay inside the disclosure without horizontal scroll', async ({ page }) => {
    await assertExpandedFiltersFit(page, { width: 390, height: 844 }, 'attendance-ew-below-fold-390x844-filters.png')
  })

  test('我的申请 deep link opens the request/makeup disclosure', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const errs: string[] = []
    page.on('pageerror', (error) => errs.push(String(error)))

    await page.goto(`${HARNESS}?section=attendance-overview-requests`, { waitUntil: 'domcontentloaded' })
    const tools = page.locator('[data-attendance-request-tools]')
    await expect(tools).toBeVisible()
    await expect(tools).toHaveJSProperty('open', true)
    await expect(page.locator('#attendance-request-work-date')).toBeVisible()
    await noHorizontalOverflow(page)
    await page.screenshot({ path: `${OUT}/attendance-ew-below-fold-requests-deep-link.png`, fullPage: true })
    expect(errs, `page errors: ${errs.join('; ')}`).toEqual([])
  })
})
