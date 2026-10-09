import { chromium, expect, selectors } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
const browser = await chromium.launch({ headless: true })
selectors.setTestIdAttribute('data-test')
const context = await browser.newContext({ viewport: { width: 1920, height: 960 }, permissions: ['clipboard-read', 'clipboard-write'] })
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
  await page.getByTestId('range-mode').selectOption('copy')
  await drag(cell(6, 1), cell(7, 1))
  await drag(page.getByTestId('range-fill-handle'), cell(7, 0))
  await expect.poll(() => page.evaluate(() => window.rangeDemo.calls.length)).toBe(4)
  expect(await page.evaluate(() => window.rangeDemo.calls[3])).toEqual([
    { recordId: 'r6', fieldId: 'a', value: 102, expectedVersion: 1 },
    { recordId: 'r7', fieldId: 'a', value: 202, expectedVersion: 1 },
  ])
  await page.getByTestId('range-mode').selectOption('series')
  await drag(cell(6, 0), cell(7, 0))
  await drag(page.getByTestId('range-fill-handle'), cell(7, 1))
  await expect.poll(() => page.evaluate(() => window.rangeDemo.calls.length)).toBe(5)
  expect(await page.evaluate(() => window.rangeDemo.calls[4])).toEqual([
    { recordId: 'r6', fieldId: 'b', value: 103, expectedVersion: 2 },
    { recordId: 'r7', fieldId: 'b', value: 203, expectedVersion: 2 },
  ])
  await page.getByTestId('range-mode').selectOption('copy')
  await drag(cell(6, 0), cell(7, 1))
  await drag(page.getByTestId('range-fill-handle'), cell(9, 1))
  await expect.poll(() => page.evaluate(() => window.rangeDemo.calls.length)).toBe(6)
  expect(await page.evaluate(() => window.rangeDemo.calls[5])).toEqual([
    { recordId: 'r8', fieldId: 'a', value: 102, expectedVersion: 1 },
    { recordId: 'r8', fieldId: 'b', value: 103, expectedVersion: 1 },
    { recordId: 'r9', fieldId: 'a', value: 202, expectedVersion: 1 },
    { recordId: 'r9', fieldId: 'b', value: 203, expectedVersion: 1 },
  ])
  await drag(cell(6, 0), cell(7, 1))
  await drag(page.getByTestId('range-fill-handle'), cell(4, 1))
  await expect.poll(() => page.evaluate(() => window.rangeDemo.calls.length)).toBe(7)
  expect(await page.evaluate(() => window.rangeDemo.calls[6])).toEqual([
    { recordId: 'r4', fieldId: 'a', value: 102, expectedVersion: 3 },
    { recordId: 'r4', fieldId: 'b', value: 103, expectedVersion: 3 },
    { recordId: 'r5', fieldId: 'a', value: 202, expectedVersion: 1 },
    { recordId: 'r5', fieldId: 'b', value: 203, expectedVersion: 1 },
  ])
  await drag(cell(6, 0), cell(7, 1))
  await page.getByTestId('range-copy').click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('102\t103\n202\t203')
  await cell(10, 0).click()
  await page.getByTestId('range-paste').click()
  await expect.poll(() => page.evaluate(() => window.rangeDemo.calls.length)).toBe(8)
  expect(await page.evaluate(() => window.rangeDemo.calls[7])).toEqual([
    { recordId: 'r10', fieldId: 'a', value: 102, expectedVersion: 1 },
    { recordId: 'r10', fieldId: 'b', value: 103, expectedVersion: 1 },
    { recordId: 'r11', fieldId: 'a', value: 202, expectedVersion: 1 },
    { recordId: 'r11', fieldId: 'b', value: 203, expectedVersion: 1 },
  ])
  await drag(cell(0, 4), cell(0, 5))
  await drag(page.getByTestId('range-fill-handle'), cell(3, 5))
  await expect.poll(() => page.evaluate(() => window.rangeDemo.calls.length)).toBe(9)
  expect(await page.evaluate(() => window.rangeDemo.calls[8].map(({ fieldId, value }) => ({ fieldId, value })))).toEqual(
    Array.from({ length: 3 }, () => [
      { fieldId: 'tags', value: ['采购', '质检'] }, { fieldId: 'people', value: ['synthetic-a', 'synthetic-b'] },
    ]).flat(),
  )
  await expect(cell(3, 5)).toContainText('样例成员甲')
  await expect(cell(3, 5)).toContainText('样例成员乙')
  await drag(cell(0, 4), cell(0, 5))
  await page.getByTestId('range-copy').click()
  await cell(4, 4).click()
  await page.getByTestId('range-paste').click()
  await expect.poll(() => page.evaluate(() => window.rangeDemo.calls.length)).toBe(10)
  expect(await page.evaluate(() => window.rangeDemo.rows.value[4].data.tags)).toEqual(['采购', '质检'])
  expect(await page.evaluate(() => window.rangeDemo.rows.value[4].data.people)).toEqual(['synthetic-a', 'synthetic-b'])
  await expect(cell(4, 5)).toContainText('样例成员甲')
  await cell(0, 6).click()
  await drag(page.getByTestId('range-fill-handle'), cell(2, 6))
  await expect.poll(() => page.evaluate(() => window.rangeDemo.calls.length)).toBe(11)
  expect(await page.evaluate(() => window.rangeDemo.rows.value[2].data.place)).toEqual({ address: '合成仓库', latitude: 25, longitude: 121 })
  await drag(cell(0, 4), cell(4, 6))
  await mkdir('../../artifacts/range-fill', { recursive: true })
  await page.screenshot({ path: '../../artifacts/range-fill/grid-range-fill.png', fullPage: true })
  expect(errors).toEqual([])
  console.log('PASS browser: selection, all four fill directions, independent row/column series, 2x2 repeat and clipboard paste, civil-date series, multiSelect/person JSON clipboard and repeated arrays, structured location; 11 commits; no browser errors')
} catch (error) { console.log({ browserErrors: errors }); throw error } finally { await browser.close() }
