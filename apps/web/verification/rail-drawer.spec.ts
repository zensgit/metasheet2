import { test, expect } from '@playwright/test'
import { mkdirSync } from 'node:fs'

// Real-browser verification of the UI-P2-2c drawer CSS that jsdom can't prove — see design
// docs/development/multitable-ui-p2-2c-responsive-design-20260714.md §7 (this is the CSS leg; the
// interactive STATE machine — which class applies at which viewport width — is proven separately in
// jsdom, see apps/web/tests/multitable-workbench-view.spec.ts's 'UI-P2-2c' describe block).
//
// Every "drawer has X" assertion below is paired with a "default/collapsed does NOT have X" positive
// control on the SAME page, so a vacuously-true assertion (e.g. a selector matching nothing) cannot
// pass silently — see feedback_positive_control_not_failclosed.md.

const OUT = 'verification-output'
const HARNESS = '/verification/rail-drawer-harness.html'

test('UI-P2-2c rail drawer CSS resolves correctly in a real browser', async ({ page }) => {
  mkdirSync(OUT, { recursive: true })
  const errs: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`) })
  page.on('pageerror', (e) => errs.push(`pageerror: ${String(e)}`))

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' })
  const rail = page.locator('[data-test="rail"]')
  await expect(rail).toBeVisible()

  // --- default state (positive control: NOT collapsed, NOT drawer) ---
  await expect(page.locator('[data-test="current-mode"]')).toHaveText('mode: default')
  let box = await rail.evaluate((el) => getComputedStyle(el).position)
  expect(box, 'default: position must be static, not absolute').toBe('static')
  let width = await rail.evaluate((el) => getComputedStyle(el).width)
  expect(width, 'default: full 240px width').toBe('240px')
  let shadow = await rail.evaluate((el) => getComputedStyle(el).boxShadow)
  expect(shadow, 'default: no drawer shadow').toBe('none')
  await page.screenshot({ path: `${OUT}/rail-drawer-default.png` })

  // --- collapsed state (positive control: the pre-existing P2-2b icon-strip, still NOT a drawer) ---
  await page.locator('[data-test="mode-collapsed"]').click()
  await expect(page.locator('[data-test="current-mode"]')).toHaveText('mode: collapsed')
  box = await rail.evaluate((el) => getComputedStyle(el).position)
  expect(box, 'collapsed: still static (P2-2b icon-strip is in-flow, not absolute)').toBe('static')
  width = await rail.evaluate((el) => getComputedStyle(el).width)
  expect(width, 'collapsed: 36px icon-strip width').toBe('36px')
  await page.screenshot({ path: `${OUT}/rail-drawer-collapsed.png` })

  // --- drawer state: the actual UI-P2-2c claims ---
  await page.locator('[data-test="mode-drawer"]').click()
  await expect(page.locator('[data-test="current-mode"]')).toHaveText('mode: drawer')
  box = await rail.evaluate((el) => getComputedStyle(el).position)
  expect(box, 'drawer: position:absolute (overlay, not in-flow)').toBe('absolute')
  const zIndex = await rail.evaluate((el) => getComputedStyle(el).zIndex)
  expect(zIndex, 'drawer: z-index:5 (paints over .mt-workbench__main)').toBe('5')
  width = await rail.evaluate((el) => getComputedStyle(el).width)
  expect(width, 'drawer at 1280px viewport: min(240px, calc(100vw-32px)) resolves to 240px').toBe('240px')
  shadow = await rail.evaluate((el) => getComputedStyle(el).boxShadow)
  expect(shadow, 'drawer: --ms-shadow-pop resolves to a real (non-none) box-shadow').not.toBe('none')
  const bg = await rail.evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(bg, 'drawer: --ms-bg-card resolves to an OPAQUE background (not transparent) so it truly occludes .mt-workbench__main behind it').not.toBe('rgba(0, 0, 0, 0)')
  // --ms-bg-card is #ffffff in tokens.css (light mode, no dark override defined yet — see design MD §7).
  expect(bg, '--ms-bg-card resolves to its documented #ffffff value').toBe('rgb(255, 255, 255)')
  await page.screenshot({ path: `${OUT}/rail-drawer-open.png` })

  // --- narrow viewport: the calc(100vw - 32px) clamp actually engages (not just the 240px branch) ---
  await page.setViewportSize({ width: 200, height: 600 })
  await page.waitForTimeout(50) // let layout settle after resize
  width = await rail.evaluate((el) => getComputedStyle(el).width)
  expect(width, 'drawer at 200px viewport: calc(100vw-32px)=168px < 240px, min() picks the clamp').toBe('168px')
  await page.screenshot({ path: `${OUT}/rail-drawer-narrow-viewport.png` })

  expect(errs, `console/page errors:\n${errs.join('\n')}`).toEqual([])
})
