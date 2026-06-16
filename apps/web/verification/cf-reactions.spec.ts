import { test, expect } from '@playwright/test'
import { mkdirSync } from 'node:fs'

// Real-browser verification of the shipped multitable UI render that jsdom can't
// prove: data-bar gradient, color-scale cell fill, icon-set glyphs, and B6
// reaction chips + picker (incl. a click→chip mutation). Fail-loud: any console /
// page error, a missing render, or the picked chip not appearing turns this red.
// Screenshots land in apps/web/verification-output/ for CI artifact upload.

const OUT = 'verification-output' // relative to apps/web (the playwright cwd)
const HARNESS = '/verification/cf-reactions-harness.html'

test('multitable conditional-formatting + reactions render in a real browser', async ({ page }) => {
  mkdirSync(OUT, { recursive: true })
  const errs: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`) })
  page.on('pageerror', (e) => errs.push(`pageerror: ${String(e)}`))

  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.meta-grid__cell').first()).toBeVisible({ timeout: 30_000 })
  await page.screenshot({ path: `${OUT}/bv-grid.png`, fullPage: true })

  // A5-1 data-bar: at least one cell painted with a left-anchored linear-gradient.
  const gradientCells = await page.locator('.meta-grid__cell').evaluateAll(
    (els) => els.filter((el) => getComputedStyle(el as HTMLElement).backgroundImage.includes('linear-gradient')).length,
  )
  expect(gradientCells, 'expected ≥1 data-bar gradient cell').toBeGreaterThan(0)

  // A5-2 color-scale: at least one cell with a solid (non-transparent) bg fill.
  const filledCells = await page.locator('.meta-grid__cell').evaluateAll(
    (els) => els.filter((el) => {
      const bg = getComputedStyle(el as HTMLElement).backgroundColor
      return !!bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent'
    }).length,
  )
  expect(filledCells, 'expected ≥1 color-scale filled cell').toBeGreaterThan(0)

  // A5-3 icon-set: glyphs rendered in cells.
  expect(await page.locator('[data-test="cell-scale-icon"]').count(), 'expected ≥1 icon-set glyph').toBeGreaterThan(0)

  // B6 reactions: chips visible.
  await expect(page.locator('[data-test="comment-reactions"] .meta-comment-reactions__chip').first()).toBeVisible()

  // B6 picker: open + screenshot.
  await page.locator('[data-test="reaction-add"]').click()
  await expect(page.locator('[data-test="reaction-palette"]')).toBeVisible()
  await page.screenshot({ path: `${OUT}/bv-reactions-picker.png` })

  // B6 interaction: pick a NEW emoji → its chip must appear (reactive harness).
  await page.locator('[data-test="reaction-pick-🚀"]').click()
  await expect(page.locator('[data-test="reaction-chip-🚀"]')).toBeVisible()
  await page.screenshot({ path: `${OUT}/bv-reactions-after.png` })

  // Fail loud on any console / page error captured from load through interaction.
  expect(errs, `console/page errors:\n${errs.join('\n')}`).toEqual([])
})
