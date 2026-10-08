import { chromium, expect, selectors } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
const browser = await chromium.launch({ headless: true })
selectors.setTestIdAttribute('data-test')
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, permissions: ['clipboard-read', 'clipboard-write'] })
const page = await context.newPage()
const errors = []
page.on('pageerror', error => errors.push(error.message))
const cell = (row, col) => page.locator(`[data-range-row="${row}"][data-range-col="${col}"]`)
async function drag(from, to) {
  const a = await from.boundingBox(), b = await to.boundingBox()
  if (!a || !b) throw new Error('Missing cell geometry')
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 })
  await page.mouse.up()
}
try {
  await page.goto('http://127.0.0.1:18919/tests/fixtures/range-fill-browser-demo.html')
  await expect(page.getByTestId('grid-range-toolbar')).toBeVisible()
  await drag(cell(0, 0), cell(1, 0))
  await expect(page.locator('td[aria-selected="true"]')).toHaveCount(2)
  await page.getByTestId('range-mode').selectOption('series')
  await drag(page.getByTestId('range-fill-handle'), cell(4, 0))
  await expect.poll(() => page.evaluate(() => window.rangeDemo.calls.length)).toBe(1)
  expect(await page.evaluate(() => window.rangeDemo.calls[0])).toEqual([
    { recordId: 'r2', fieldId: 'a', value: 30, expectedVersion: 1 },
    { recordId: 'r3', fieldId: 'a', value: 40, expectedVersion: 1 },
    { recordId: 'r4', fieldId: 'a', value: 50, expectedVersion: 1 },
  ])
  await drag(cell(0, 0), cell(4, 0))
  await page.getByTestId('range-copy').click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('10\n20\n30\n40\n50')
  await cell(0, 1).click()
  await page.getByTestId('range-paste').click()
  await expect.poll(() => page.evaluate(() => window.rangeDemo.calls.length)).toBe(2)
  expect(await page.evaluate(() => window.rangeDemo.calls[1].map(change => change.value))).toEqual([10, 20, 30, 40, 50])
  await cell(0, 2).click()
  await drag(page.getByTestId('range-fill-handle'), cell(3, 2))
  await expect.poll(() => page.evaluate(() => window.rangeDemo.calls.length)).toBe(3)
  expect(await page.evaluate(() => window.rangeDemo.calls[2].map(change => change.value))).toEqual(['2026-10-09', '2026-10-10', '2026-10-11'])
  await drag(cell(0, 0), cell(4, 1))
  await mkdir('../../artifacts/range-fill', { recursive: true })
  await page.screenshot({ path: '../../artifacts/range-fill/grid-range-fill.png', fullPage: true })
  expect(errors).toEqual([])
  console.log('PASS browser: selection, numeric series, real clipboard, multirow paste, civil-date series; 3 commits; no browser errors')
} catch (error) { console.log({ browserErrors: errors }); throw error } finally { await browser.close() }
