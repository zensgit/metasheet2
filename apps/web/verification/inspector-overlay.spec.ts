import { test, expect } from '@playwright/test'
import { mkdirSync } from 'node:fs'

// Real-browser verification of the W2 S7 `.meta-record-drawer--overlay` CSS that jsdom can't prove —
// see design docs/development/multitable-w2-unified-record-inspector-design-lock-20260714.md §3.4,
// §6bis (OD-W2-6=b), §8.3 (this is the CSS leg; the interactive STATE machine — which class applies at
// which viewport width, and the mutual-exclusion with the rail drawer — is proven separately in jsdom,
// see apps/web/tests/multitable-workbench-view.spec.ts's 'W2 S7' describe block). Modeled directly on
// rail-drawer.spec.ts (same idiom: real tokens.css, harness buttons drive class toggles, every "overlay
// has X" assertion is paired with a "push does NOT have X" positive control on the SAME page so a
// vacuously-true assertion can't pass silently — see feedback_positive_control_not_failclosed.md).

const OUT = 'verification-output'
const HARNESS = '/verification/inspector-overlay-harness.html'

test('W2 S7 inspector overlay CSS resolves correctly in a real browser', async ({ page }) => {
  mkdirSync(OUT, { recursive: true })
  const errs: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`) })
  page.on('pageerror', (e) => errs.push(`pageerror: ${String(e)}`))

  // --- desktop width (positive control: push, NOT overlay — OD-W2-3=a, unchanged) ---
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' })
  const inspector = page.locator('[data-test="inspector"]')
  await expect(inspector).toBeVisible()
  await expect(page.locator('[data-test="current-mode"]')).toHaveText('mode: push')

  let pos = await inspector.evaluate((el) => getComputedStyle(el).position)
  expect(pos, 'push: position must be static, not absolute').toBe('static')
  let width = await inspector.evaluate((el) => getComputedStyle(el).width)
  expect(width, 'push: full 360px width (unclamped)').toBe('360px')
  let shadow = await inspector.evaluate((el) => getComputedStyle(el).boxShadow)
  expect(shadow, 'push: no overlay shadow').toBe('none')
  await page.screenshot({ path: `${OUT}/inspector-overlay-push-desktop.png` })

  // --- narrow width (768px, the S7 breakpoint itself): the actual W2 S7 claims ---
  await page.setViewportSize({ width: 768, height: 900 })
  await page.locator('[data-test="mode-overlay"]').click()
  await expect(page.locator('[data-test="current-mode"]')).toHaveText('mode: overlay')

  pos = await inspector.evaluate((el) => getComputedStyle(el).position)
  expect(pos, 'overlay @768px: position:absolute (out of flow, not push)').toBe('absolute')
  const zIndex = await inspector.evaluate((el) => getComputedStyle(el).zIndex)
  expect(zIndex, 'overlay: z-index:5 (paints over .mt-workbench__main, same tier as the rail drawer)').toBe('5')
  width = await inspector.evaluate((el) => getComputedStyle(el).width)
  expect(width, 'overlay @768px viewport: min(360px, calc(100vw-32px))=736px resolves to the 360px branch').toBe('360px')
  shadow = await inspector.evaluate((el) => getComputedStyle(el).boxShadow)
  expect(shadow, 'overlay: --ms-shadow-pop resolves to a real (non-none) box-shadow').not.toBe('none')
  const bg = await inspector.evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(bg, 'overlay: --ms-bg-card resolves to an OPAQUE background (not transparent) so it truly occludes .mt-workbench__main behind it').not.toBe('rgba(0, 0, 0, 0)')
  // --ms-bg-card is #ffffff in tokens.css (light mode, no dark override defined yet — same documented
  // gap as the rail drawer, design MD §7).
  expect(bg, '--ms-bg-card resolves to its documented #ffffff value').toBe('rgb(255, 255, 255)')
  // Rounded on the open/left edge (mirrors the rail drawer's open/right edge), square on the viewport
  // edge (right) it's anchored to — --ms-radius-lg is 12px in tokens.css.
  const radii = await inspector.evaluate((el) => {
    const cs = getComputedStyle(el)
    return { tl: cs.borderTopLeftRadius, tr: cs.borderTopRightRadius, br: cs.borderBottomRightRadius, bl: cs.borderBottomLeftRadius }
  })
  expect(radii.tl, 'overlay: top-left (open edge) rounded via --ms-radius-lg').toBe('12px')
  expect(radii.bl, 'overlay: bottom-left (open edge) rounded via --ms-radius-lg').toBe('12px')
  expect(radii.tr, 'overlay: top-right (viewport edge) square').toBe('0px')
  expect(radii.br, 'overlay: bottom-right (viewport edge) square').toBe('0px')

  // --- no body horizontal scroll at the 768px breakpoint with the overlay open ---
  const overflow768 = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(overflow768.scrollWidth, `body must not scroll horizontally @768px (scrollWidth ${overflow768.scrollWidth} vs clientWidth ${overflow768.clientWidth})`).toBeLessThanOrEqual(overflow768.clientWidth)
  await page.screenshot({ path: `${OUT}/inspector-overlay-narrow-768.png` })

  // --- narrower viewport: the calc(100vw - 32px) clamp actually engages (not just the 360px branch) ---
  await page.setViewportSize({ width: 320, height: 800 })
  await page.waitForTimeout(50) // let layout settle after resize
  width = await inspector.evaluate((el) => getComputedStyle(el).width)
  expect(width, 'overlay @320px viewport: calc(100vw-32px)=288px < 360px, min() picks the clamp').toBe('288px')
  const overflow320 = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(overflow320.scrollWidth, `body must not scroll horizontally @320px either (scrollWidth ${overflow320.scrollWidth} vs clientWidth ${overflow320.clientWidth})`).toBeLessThanOrEqual(overflow320.clientWidth)
  await page.screenshot({ path: `${OUT}/inspector-overlay-narrow-320.png` })

  // --- rail-drawer mode: visual proof the two overlays never render simultaneously (OD-W2-6=b) —
  // the harness only mounts ONE of them at a time (mirrors MetaRecordInspector.vue's own
  // `v-if="visible"` going false once MultitableWorkbench.vue's mutual-exclusion watch nulls
  // selectedRecordId; see file-header comment in inspector-overlay-harness.ts).
  await page.locator('[data-test="mode-rail-drawer"]').click()
  await expect(page.locator('[data-test="current-mode"]')).toHaveText('mode: rail-drawer')
  await expect(inspector).toHaveCount(0)
  await page.screenshot({ path: `${OUT}/inspector-overlay-rail-drawer-mutex.png` })

  expect(errs, `console/page errors:\n${errs.join('\n')}`).toEqual([])
})
