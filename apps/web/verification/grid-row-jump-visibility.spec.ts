// Real-browser witness for the grid footer 「跳转到第 [ ] 行」 (客户反馈 2026-10-27, R74; binding brief item 1:
// 「直接滚到这一行并高亮」). After a jump, the focused row must lie inside the visible band
//   [sticky header cell bottom, min(scrollport bottom, sticky aggregation footer top)],
// under production CSS. jsdom has no sticky geometry, so the vitest specs pin only the scroll arithmetic.
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const OUT = 'verification-output'
const INPUT = '[data-testid="grid-row-jump-input"]'

type W = Window & { __GRID_ROW_JUMP__?: { ready: boolean; selects: string[]; goToPage: number[]; offset: () => number } }

type Placement = { rowNumber: string | null; top: number; bottom: number; bandTop: number; bandBottom: number; windowed: boolean }

async function open(page: Page, query: string, errs: string[]): Promise<void> {
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`) })
  page.on('pageerror', (e) => errs.push(`pageerror: ${String(e)}`))
  await page.setViewportSize({ width: 1100, height: 600 })
  await page.goto(`/verification/grid-row-jump-harness.html?${query}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as W).__GRID_ROW_JUMP__?.ready === true, null, { timeout: 60_000 })
}

// Types the row number, presses Enter, waits until that record is the latest select (a loaded row selects at once,
// an unloaded one after its page lands), then lets the scroll settle.
async function jump(page: Page, value: string, recordId: string): Promise<void> {
  const before = await page.evaluate(() => (window as W).__GRID_ROW_JUMP__!.selects.length)
  await page.locator(INPUT).fill(value)
  await page.locator(INPUT).press('Enter')
  await page.waitForFunction(([n, id]) => {
    const s = (window as W).__GRID_ROW_JUMP__!.selects
    return s.length > n && s[s.length - 1] === id
  }, [before, recordId] as const, { timeout: 10_000 })
  await page.waitForTimeout(250)
}

async function placement(page: Page): Promise<Placement> {
  return page.evaluate((): Placement => {
    const wrap = document.querySelector('.meta-grid__table-wrap') as HTMLElement
    const wr = wrap.getBoundingClientRect()
    const th = (document.querySelector('.meta-grid__table thead th') as HTMLElement).getBoundingClientRect()
    const foot = document.querySelector('tfoot.meta-grid__foot td') as HTMLElement | null
    const bandTop = Math.max(wr.top + wrap.clientTop, th.bottom)
    const bandBottom = Math.min(wr.top + wrap.clientTop + wrap.clientHeight, foot ? foot.getBoundingClientRect().top : Number.POSITIVE_INFINITY)
    const row = document.querySelector('tbody tr.meta-grid__row--focused') as HTMLElement | null
    const r = row?.getBoundingClientRect()
    return {
      rowNumber: row?.querySelector('.meta-grid__row-num span')?.textContent?.trim() ?? null,
      top: r?.top ?? Number.NaN,
      bottom: r?.bottom ?? Number.NaN,
      bandTop,
      bandBottom,
      windowed: document.querySelector('[data-test="grid-top-spacer"], [data-test="grid-bottom-spacer"]') !== null,
    }
  })
}

function expectInBand(p: Placement, rowNumber: string, label: string): void {
  // eslint-disable-next-line no-console
  console.log(`[grid-row-jump] ${label}: ${JSON.stringify(p)}`)
  expect(p.rowNumber, `${label}: focused row`).toBe(rowNumber)
  // Half a pixel of slack for fractional row heights.
  expect(p.top, `${label}: row top below the sticky header`).toBeGreaterThanOrEqual(p.bandTop - 0.5)
  expect(p.bottom, `${label}: row bottom above the scrollport bottom / aggregation footer`).toBeLessThanOrEqual(p.bandBottom + 0.5)
}

test('windowed (2000 rows held): jumps down to 4-digit rows and back up land inside the visible band', async ({ page }) => {
  mkdirSync(OUT, { recursive: true })
  const errs: string[] = []
  await open(page, 'mode=all&total=2000&size=50', errs)
  await jump(page, '90', 'r89')
  expectInBand(await placement(page), '90', 'windowed jump 90 (down)')
  await jump(page, '1500', 'r1499')
  const down = await placement(page)
  expect(down.windowed, 'the 2000-row set is windowed').toBe(true)
  expectInBand(down, '1500', 'windowed jump 1500 (down)')
  await page.screenshot({ path: `${OUT}/grid-row-jump-windowed-1500.png` })
  await jump(page, '500', 'r499')
  expectInBand(await placement(page), '500', 'windowed jump 500 (up)')
  expect(errs, `console/page errors:\n${errs.join('\n')}`).toEqual([])
})

test('windowed with the sticky aggregation footer: a jump to the last row clears the footer', async ({ page }) => {
  const errs: string[] = []
  await open(page, 'mode=all&total=2000&size=50&agg=1', errs)
  await jump(page, '2000', 'r1999')
  expectInBand(await placement(page), '2000', 'windowed + footer jump 2000 (last)')
  await jump(page, '1200', 'r1199')
  expectInBand(await placement(page), '1200', 'windowed + footer jump 1200 (up)')
  expect(errs, `console/page errors:\n${errs.join('\n')}`).toEqual([])
})

test('paged, 50 rows per page (not windowed): a jump to another page, then up on that page, then back to page 1', async ({ page }) => {
  mkdirSync(OUT, { recursive: true })
  const errs: string[] = []
  await open(page, 'mode=paged&total=1000&size=50', errs)
  await jump(page, '800', 'r799')
  const landed = await placement(page)
  expect(landed.windowed, '50 rows are not windowed').toBe(false)
  expect(await page.evaluate(() => (window as W).__GRID_ROW_JUMP__!.offset())).toBe(750)
  expectInBand(landed, '800', 'paged jump 800 (page 16 lands)')
  await jump(page, '760', 'r759')
  expectInBand(await placement(page), '760', 'paged jump 760 (up, same page)')
  await page.screenshot({ path: `${OUT}/grid-row-jump-paged-760-up.png` })
  await jump(page, '800', 'r799')
  // Page 1 lands with the scroll position page 16 left behind; row 5 lies above it.
  await jump(page, '5', 'r4')
  expect(await page.evaluate(() => (window as W).__GRID_ROW_JUMP__!.offset())).toBe(0)
  expectInBand(await placement(page), '5', 'paged jump 5 (page 1 lands, up)')
  expect(errs, `console/page errors:\n${errs.join('\n')}`).toEqual([])
})

test('paged with the sticky aggregation footer: a jump down on the page clears the footer', async ({ page }) => {
  const errs: string[] = []
  await open(page, 'mode=paged&total=1000&size=50&agg=1', errs)
  await jump(page, '40', 'r39')
  expectInBand(await placement(page), '40', 'paged + footer jump 40 (down)')
  await jump(page, '3', 'r2')
  expectInBand(await placement(page), '3', 'paged + footer jump 3 (up)')
  expect(errs, `console/page errors:\n${errs.join('\n')}`).toEqual([])
})
