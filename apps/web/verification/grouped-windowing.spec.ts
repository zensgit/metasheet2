import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'

const OUT = 'verification-output'
const HARNESS = '/verification/grouped-windowing-harness.html?rows=5000&groups=50'
const EXPECT_UNWINDOWED = process.env.GW_EXPECT_UNWINDOWED === '1'

test('grouped grid render is browser-windowed at 5k rows / 50 groups', async ({ page }) => {
  mkdirSync(OUT, { recursive: true })
  const errs: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`) })
  page.on('pageerror', (e) => errs.push(`pageerror: ${String(e)}`))

  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__GW_METRICS__?.ready === true, null, { timeout: 60_000 })
  await page.screenshot({ path: `${OUT}/gw-grouped-windowing.png`, fullPage: true })
  const metrics = await page.evaluate(() => window.__GW_METRICS__!)
  writeFileSync(`${OUT}/gw-grouped-windowing.json`, `${JSON.stringify(metrics, null, 2)}\n`)
  // eslint-disable-next-line no-console
  console.log(`[gw-browser] rows=${metrics.rows}, groups=${metrics.groups}, mount=${metrics.mountMs.toFixed(1)}ms, scrollFrame=${metrics.scrollFrameMs.toFixed(1)}ms, initialItems=${metrics.initial.mountedItems}, afterScrollItems=${metrics.afterScroll.mountedItems}, firstBefore=${metrics.initial.firstRowNumber}, firstAfter=${metrics.afterScroll.firstRowNumber}`)

  expect(metrics.rows).toBe(5_000)
  expect(metrics.groups).toBe(50)
  expect(metrics.mountMs).toBeGreaterThan(0)
  expect(metrics.scrollFrameMs).toBeGreaterThan(0)

  if (EXPECT_UNWINDOWED) {
    expect(metrics.initial.dataRows).toBe(metrics.expectedFullDataRows)
    expect(metrics.initial.groupHeaders).toBe(metrics.expectedFullGroupHeaders)
    expect(metrics.initial.bottomSpacerHeight).toBe(0)
    expect(metrics.initial.mountedItems).toBeGreaterThanOrEqual(5_050)
  } else {
    expect(metrics.initial.dataRows).toBeGreaterThan(0)
    expect(metrics.initial.dataRows).toBeLessThan(220)
    expect(metrics.initial.mountedItems).toBeLessThan(280)
    expect(metrics.initial.bottomSpacerHeight).toBeGreaterThan(0)
    expect(metrics.afterScroll.dataRows).toBeGreaterThan(0)
    expect(metrics.afterScroll.dataRows).toBeLessThan(220)
    expect(metrics.afterScroll.mountedItems).toBeLessThan(280)
    expect(metrics.afterScroll.topSpacerHeight).toBeGreaterThan(0)
    expect(metrics.afterScroll.firstRowNumber).not.toBe(metrics.initial.firstRowNumber)
  }

  expect(errs, `console/page errors:\n${errs.join('\n')}`).toEqual([])
})
