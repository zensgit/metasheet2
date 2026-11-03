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

// Review of the grid select-all z-index fix (2026-10-21): the grid's sticky header corner moved to z-index 5,
// which TIED the drawer's z-index 5 in the content stacking context — the grid comes later in the DOM, so
// the corner painted over the open drawer and swallowed clicks on its top-left controls (base picker, rail
// toggle). `.meta-grid` now isolates its own stacking context. This drives the REAL MetaGridTable under the
// drawer at a narrow viewport and asks the browser what is top-most at each control, then clicks them.
test('UI-P2-2c drawer controls stay on top of the real grid (hit-test + click)', async ({ page }) => {
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(`pageerror: ${String(e)}`))
  await page.setViewportSize({ width: 720, height: 720 })
  await page.goto(`${HARNESS}?grid=1`, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.meta-grid thead .meta-grid__check-col input[type="checkbox"]')).toBeVisible()
  await page.locator('[data-test="mode-drawer"]').click()
  await expect(page.locator('[data-test="current-mode"]')).toHaveText('mode: drawer')

  // Precondition: the grid's select-all corner really sits under the open drawer (otherwise the probe is vacuous).
  const overlap = await page.evaluate(() => {
    const rail = document.querySelector('[data-test="rail"]')!.getBoundingClientRect()
    const corner = document.querySelector('.meta-grid thead .meta-grid__check-col')!.getBoundingClientRect()
    return corner.left < rail.right && corner.right > rail.left && corner.top < rail.bottom && corner.bottom > rail.top
  })
  expect(overlap, 'the grid header corner lies under the drawer').toBe(true)

  for (const testId of ['rail-base-trigger', 'rail-toggle']) {
    const hit = await page.evaluate((id) => {
      const el = document.querySelector(`[data-test="${id}"]`) as HTMLElement
      const r = el.getBoundingClientRect()
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return { isControl: top === el, top: top?.className || top?.tagName || null }
    }, testId)
    expect(hit, `${testId} is top-most at its own centre`).toMatchObject({ isControl: true })
  }

  // The drawer's top-left band: nothing there may belong to the grid.
  const gridHits = await page.evaluate(() => {
    const rail = document.querySelector('[data-test="rail"]')!.getBoundingClientRect()
    let hits = 0
    for (let x = rail.left + 2; x < rail.left + 120; x += 6) {
      for (let y = rail.top + 2; y < rail.top + 60; y += 6) {
        if (document.elementFromPoint(x, y)?.closest('.meta-grid')) hits += 1
      }
    }
    return hits
  })
  expect(gridHits, 'grid elements hit inside the drawer top-left band').toBe(0)

  // Real clicks at those points reach the drawer controls, not the grid's select-all.
  const clickCentre = async (testId: string) => {
    const box = await page.locator(`[data-test="${testId}"]`).boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
  }
  await clickCentre('rail-base-trigger')
  await expect(page.locator('[data-test="rail-base-menu"]')).toBeVisible()
  await clickCentre('rail-toggle')
  expect(await page.evaluate(() => window.__RAIL_DRAWER__!.toggleClicks)).toBe(1)
  expect(await page.evaluate(() => window.__RAIL_DRAWER__!.selectedRows)).toBe(0)
  await expect(page.locator('tbody .meta-grid__check-col input[type="checkbox"]:checked')).toHaveCount(0)
  expect(errs, `page errors:\n${errs.join('\n')}`).toEqual([])
})

// Review round 3 (2026-10-21): with `.meta-grid` isolating its stacking context, a full-screen FIXED overlay
// rendered from inside a grid cell — the linked-record popover — would have its z-index (1000) count only
// inside the grid and paint UNDER every later positioned sibling of the grid: the record inspector (overlay
// at narrow width, or the push column). The popover now teleports to <body>. This opens it from a real
// grid link chip next to an open inspector and asks the browser what is top-most over the popover panel.
for (const inspector of ['overlay', 'push'] as const) {
  test(`linked-record popover opened from the grid paints above the ${inspector} record inspector`, async ({ page }) => {
    const errs: string[] = []
    page.on('pageerror', (e) => errs.push(`pageerror: ${String(e)}`))
    await page.setViewportSize({ width: 720, height: 900 })
    await page.goto(`${HARNESS}?grid=1&inspector=${inspector}`, { waitUntil: 'domcontentloaded' })
    await page.locator('[data-test="mode-collapsed"]').click()
    await expect(page.locator('[data-test="inspector"]')).toBeVisible()

    await page.locator('[data-test="link-chip"]').first().click()
    const panel = page.locator('.meta-linked-record-popover [role="dialog"]')
    await expect(panel).toBeVisible()

    const probe = await page.evaluate(() => {
      const panelEl = document.querySelector('.meta-linked-record-popover [role="dialog"]') as HTMLElement
      const p = panelEl.getBoundingClientRect()
      const ins = document.querySelector('[data-test="inspector"]')!.getBoundingClientRect()
      const overlapsInspector = p.left < ins.right && p.right > ins.left && p.top < ins.bottom && p.bottom > ins.top
      let total = 0
      let covered = 0
      for (let x = p.left + 4; x < p.right - 4; x += 12) {
        for (let y = p.top + 4; y < p.bottom - 4; y += 12) {
          total += 1
          if (!document.elementFromPoint(x, y)?.closest('.meta-linked-record-popover')) covered += 1
        }
      }
      const close = document.querySelector('.meta-linked-record-popover__close') as HTMLElement
      const c = close.getBoundingClientRect()
      const atClose = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2)
      return { overlapsInspector, total, covered, closeOnTop: !!atClose && close.contains(atClose) }
    })
    expect(probe.overlapsInspector, 'precondition: the popover panel overlaps the inspector').toBe(true)
    expect(probe.total).toBeGreaterThan(50)
    expect(probe, 'no popover point is covered and its close button is top-most').toMatchObject({ covered: 0, closeOnTop: true })

    const closeBox = await page.locator('.meta-linked-record-popover__close').boundingBox()
    await page.mouse.click(closeBox!.x + closeBox!.width / 2, closeBox!.y + closeBox!.height / 2)
    await expect(page.locator('.meta-linked-record-popover')).toHaveCount(0)

    // The backdrop also still closes it when clicked over the inspector (outside the panel).
    await page.locator('[data-test="link-chip"]').first().click()
    await expect(panel).toBeVisible()
    const ins = await page.locator('[data-test="inspector"]').boundingBox()
    await page.mouse.click(ins!.x + ins!.width / 2, ins!.y + ins!.height - 20)
    await expect(page.locator('.meta-linked-record-popover')).toHaveCount(0)
    expect(errs, `page errors:\n${errs.join('\n')}`).toEqual([])
  })
}
