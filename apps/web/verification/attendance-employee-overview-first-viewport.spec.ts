import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const OUT = 'verification-output'
const HARNESS = '/verification/attendance-employee-overview-first-viewport-harness.html'
const STATES = ['normal', 'late', 'missing', 'pending', 'empty'] as const

function aboveFold(box: { y: number; height: number } | null, viewportHeight: number): boolean {
  if (!box) return false
  return box.y >= 0 && box.y + box.height <= viewportHeight
}

function startsInViewport(box: { y: number; height: number } | null, viewportHeight: number): boolean {
  if (!box) return false
  return box.y >= 0 && box.y < viewportHeight
}

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

async function boxes(page: Page) {
  const punch = page.locator('[data-testid="attendance-hero-punch"]')
  const status = page.locator('[data-selfservice-card="status"]')
  const attention = page.locator('[data-attendance-overview-attention]')
  const action = page.locator('[data-attendance-overview-attention-action]')
  const tools = page.locator('.attendance-ew__tools')
  const common = page.locator('[data-selfservice-card="actions"]')
  return {
    punch: await punch.boundingBox(),
    status: await status.boundingBox(),
    attention: await attention.boundingBox(),
    action: await action.count() ? await action.boundingBox() : null,
    common: await common.boundingBox(),
    tools: await tools.boundingBox(),
  }
}

test.describe('issue #4355 employee overview first viewport', () => {
  test.beforeAll(() => {
    mkdirSync(OUT, { recursive: true })
  })

  test('1440x900: punch/status and attention stay above the fold without horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const errs: string[] = []
    page.on('pageerror', (error) => errs.push(String(error)))

    for (const state of STATES) {
      await page.goto(`${HARNESS}?state=${state}`, { waitUntil: 'domcontentloaded' })
      await expect(page.locator('[data-attendance-overview-primary]')).toBeVisible()
      const measured = await boxes(page)
      expect(measured.punch, `${state}: punch box`).toBeTruthy()
      expect(measured.status, `${state}: status box`).toBeTruthy()
      expect(measured.attention, `${state}: attention box`).toBeTruthy()
      expect(aboveFold(measured.punch, 900), `${state}: punch above the fold`).toBe(true)
      expect(aboveFold(measured.status, 900), `${state}: status above the fold`).toBe(true)
      expect(aboveFold(measured.attention, 900), `${state}: attention above the fold`).toBe(true)
      await noHorizontalOverflow(page)
      await page.screenshot({ path: `${OUT}/attendance-ew-1440x900-${state}.png`, fullPage: false })
    }

    expect(errs, `page errors: ${errs.join('; ')}`).toEqual([])
  })

  test('390x844: daily status and primary action precede tools, no horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const errs: string[] = []
    page.on('pageerror', (error) => errs.push(String(error)))

    for (const state of STATES) {
      await page.goto(`${HARNESS}?state=${state}`, { waitUntil: 'domcontentloaded' })
      await expect(page.locator('[data-attendance-overview-primary]')).toBeVisible()
      const measured = await boxes(page)
      expect(measured.punch, `${state}: punch box`).toBeTruthy()
      expect(measured.status, `${state}: status box`).toBeTruthy()
      expect(measured.attention, `${state}: attention box`).toBeTruthy()
      expect(measured.common, `${state}: 常用 box`).toBeTruthy()
      expect(measured.tools, `${state}: tools box`).toBeTruthy()
      expect(measured.punch!.y, `${state}: punch before 常用`).toBeLessThan(measured.common!.y)
      expect(measured.status!.y, `${state}: status before 常用`).toBeLessThan(measured.common!.y)
      expect(measured.attention!.y, `${state}: attention before 常用`).toBeLessThan(measured.common!.y)
      expect(measured.common!.y, `${state}: 常用 before remaining tools`).toBeLessThan(measured.tools!.y)
      expect(aboveFold(measured.punch, 844), `${state}: punch/primary action in the first mobile screen`).toBe(true)
      expect(startsInViewport(measured.status, 844), `${state}: daily status starts before secondary content`).toBe(true)
      if (measured.action) {
        expect(measured.action.y, `${state}: attention action before 常用`).toBeLessThan(measured.common!.y)
      }
      await noHorizontalOverflow(page)
      await page.screenshot({ path: `${OUT}/attendance-ew-390x844-${state}.png`, fullPage: false })
    }

    expect(errs, `page errors: ${errs.join('; ')}`).toEqual([])
  })
})
