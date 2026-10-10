import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const OUT = 'verification-output'
const HARNESS = '/verification/attendance-admin-task-home-harness.html'

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

test.describe('attendance admin task home visual contract', () => {
  test.beforeAll(() => {
    mkdirSync(OUT, { recursive: true })
  })

  test('1440x900: four task groups stay in one row without horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const errs: string[] = []
    page.on('pageerror', (error) => errs.push(String(error)))
    await page.goto(HARNESS, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('[data-admin-task-home="true"]')).toBeVisible()
    await expect(page.locator('[data-admin-task-group]')).toHaveCount(4)
    const boxes = await page.locator('[data-admin-task-group]').evaluateAll((nodes) =>
      nodes.map((node) => {
        const box = node.getBoundingClientRect()
        return { x: box.x, y: box.y }
      }),
    )
    expect(new Set(boxes.map((box) => Math.round(box.y))).size, 'desktop groups share one row').toBe(1)
    await noHorizontalOverflow(page)
    await page.screenshot({ path: `${OUT}/attendance-admin-task-home-1440x900.png`, fullPage: false })
    expect(errs, `page errors: ${errs.join('; ')}`).toEqual([])
  })

  test('390x844: task groups stack without horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const errs: string[] = []
    page.on('pageerror', (error) => errs.push(String(error)))
    await page.goto(HARNESS, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('[data-admin-task-group]')).toHaveCount(4)
    const boxes = await page.locator('[data-admin-task-group]').evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().y),
    )
    expect(boxes[1], 'second group sits below the first').toBeGreaterThan(boxes[0])
    await noHorizontalOverflow(page)
    await page.screenshot({ path: `${OUT}/attendance-admin-task-home-390x844.png`, fullPage: false })
    expect(errs, `page errors: ${errs.join('; ')}`).toEqual([])
  })
})
