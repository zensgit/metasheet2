import { test, expect, type Page } from '@playwright/test'

// Real-browser check for grid keyboard paste on a page WITHOUT the async Clipboard API (what a
// plain-HTTP deployment by IP gets). The user clicks the text inside a cell and presses Ctrl/Cmd+V:
// Chrome dispatches `paste` at the element holding the caret (the cell's text span), while DOM focus
// is on the grid root. The grid must accept that paste by focus, not by event target.
const HARNESS = '/verification/cell-text-keyboard-paste-harness.html'

async function putOnClipboard(page: Page, text: string) {
  const source = page.locator('#clipboard-source')
  await source.fill(text)
  await source.focus()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('ControlOrMeta+C')
}
function cell(page: Page, row: number, col: number) {
  return page.locator('tbody tr.meta-grid__row').nth(row).locator('.meta-grid__cell').nth(col)
}
async function patches(page: Page) {
  return page.evaluate(() => window.__GRID_PASTE__!.patches)
}

test.beforeEach(async ({ page }) => {
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(String(e)))
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__GRID_PASTE__?.ready === true)
  expect(await page.evaluate(() => window.__GRID_PASTE__!.clipboardApi)).toBe(false)
  expect(errs).toEqual([])
})

test('click the text inside a cell, Ctrl+V: the clipboard text is written to that cell', async ({ page }) => {
  await putOnClipboard(page, 'pasted by keyboard')
  await cell(page, 0, 0).getByText('first title').click()
  // Precondition of the regression: focus is on the grid root, the caret is inside the cell.
  expect(await page.evaluate(() => document.activeElement?.classList.contains('meta-grid'))).toBe(true)
  await page.keyboard.press('ControlOrMeta+V')
  await expect.poll(() => patches(page)).toEqual([['r0', 'title', 'pasted by keyboard', 1]])
})

test('a spreadsheet cell copied with its trailing line break lands without it', async ({ page }) => {
  await putOnClipboard(page, 'copied cell\n')
  await cell(page, 1, 0).getByText('second title').click()
  await page.keyboard.press('ControlOrMeta+V')
  await putOnClipboard(page, '42\n')
  await cell(page, 1, 1).getByText('20').click()
  await page.keyboard.press('ControlOrMeta+V')
  await expect.poll(() => patches(page)).toEqual([['r1', 'title', 'copied cell', 2], ['r1', 'amount', 42, 2]])
})

test('inside the open cell editor the browser pastes natively and the grid writes nothing', async ({ page }) => {
  await putOnClipboard(page, 'into the editor')
  await cell(page, 0, 0).getByText('first title').dblclick()
  const input = page.locator('.meta-cell-editor input').first()
  await expect(input).toBeFocused()
  await input.fill('')
  await page.keyboard.press('ControlOrMeta+V')
  await expect(input).toHaveValue('into the editor')
  expect(await patches(page)).toEqual([])
})

// Customer field report 2026-10-21 (#5): with the first column pinned and the grid scrolled right, the
// header select-all checkbox disappeared — a scrolled-away plain header cell shared the corner's stacking
// tier (z-index 3) and, being later in the DOM, painted over it. jsdom cannot stack or hit-test, so this
// scrolls the real grid and asks the browser which element is top-most at the checkbox's centre.
for (const frozen of ['code', 'none'] as const) {
  test(`header select-all stays top-most and clickable at any horizontal scroll (frozen column: ${frozen})`, async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 700 })
    await page.goto(`/verification/cell-text-keyboard-paste-harness.html?layout=pinned${frozen === 'none' ? '&frozen=none' : ''}`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.__GRID_PASTE__?.ready === true)
    const maxScroll = await page.evaluate(() => {
      const wrap = document.querySelector('.meta-grid__table-wrap') as HTMLElement
      return wrap.scrollWidth - wrap.clientWidth
    })
    expect(maxScroll).toBeGreaterThan(600) // the grid really scrolls horizontally

    for (const left of [0, 200, 600, maxScroll]) {
      const probe = await page.evaluate((x) => {
        const wrap = document.querySelector('.meta-grid__table-wrap') as HTMLElement
        wrap.scrollLeft = x
        const box = document.querySelector('thead .meta-grid__check-col input[type="checkbox"]') as HTMLInputElement
        const r = box.getBoundingClientRect()
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return { scrolled: wrap.scrollLeft, topIsCheckbox: top === box, topClass: top?.className ?? null }
      }, left)
      expect(probe.scrolled).toBe(left)
      expect(probe, `scrollLeft=${left}`).toMatchObject({ topIsCheckbox: true })
    }

    // Still scrolled to the far right: a real click at that point toggles select-all.
    const box = await page.locator('thead .meta-grid__check-col input[type="checkbox"]').boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await expect(page.locator('tbody .meta-grid__check-col input[type="checkbox"]:checked')).toHaveCount(12)
    await expect(page.locator('.meta-grid__bulk-count')).toBeVisible()
  })
}
