import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'

// #5864 ② (customer feedback 2026-09-18 #6: "字段列表与设置面板高度固定，浏览不便，需可拉伸或随窗口高度自适应").
// Real-browser proof of the layout jsdom cannot compute: the REAL MetaFieldManager.vue (its own
// scoped CSS, compiled by Vite) is mounted by field-manager-viewport-harness.ts with 48 fields, the
// first a 48-option select whose config pane is taller than any window, then measured at several
// window sizes.
// The jsdom half (state machine, source-level CSS contract, measured-row arithmetic) lives in
// apps/web/tests/multitable-field-manager-viewport-height.spec.ts.

const OUT = 'verification-output'
const HARNESS = '/verification/field-manager-viewport-harness.html'
// Mirrors FRAME_VIEWPORT_GUTTER / FIELD_LIST_MIN_HEIGHT in MetaFieldManager.vue.
const GUTTER = 32
const LIST_FLOOR = 96
// Sub-pixel rounding tolerance for rects compared with the px the component publishes.
const EPS = 1.5

interface Box { top: number; bottom: number; height: number; left: number; right: number }
interface Layout {
  vw: number
  vh: number
  dialog: Box & { scrollHeight: number; clientHeight: number; overflowY: string }
  header: Box
  list: Box & { scrollHeight: number; clientHeight: number; scrollWidth: number; clientWidth: number; overflowY: string }
  splitter: Box | null
  config: (Box & { scrollHeight: number; clientHeight: number; scrollWidth: number; clientWidth: number; overflowY: string }) | null
  footer: Box
  confirm: Box | null
  save: Box | null
  confirmDelete: Box | null
  aria: { now: number; min: number; max: number } | null
  doc: { scrollWidth: number; clientWidth: number; scrollHeight: number; clientHeight: number }
}

async function readLayout(page: Page): Promise<Layout> {
  return page.evaluate(() => {
    const box = (el: Element | null) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, height: r.height, left: r.left, right: r.right }
    }
    const scroller = (el: HTMLElement | null) => {
      if (!el) return null
      return {
        ...box(el)!,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        overflowY: getComputedStyle(el).overflowY,
      }
    }
    const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel) as unknown as HTMLElement | null
    const dialog = q('.meta-field-mgr')!
    const splitter = q('[data-test="field-mgr-splitter"]')
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      dialog: { ...box(dialog)!, scrollHeight: dialog.scrollHeight, clientHeight: dialog.clientHeight, overflowY: getComputedStyle(dialog).overflowY },
      header: box(q('.meta-field-mgr__header'))!,
      list: scroller(q('.meta-field-mgr__body'))!,
      splitter: box(splitter),
      config: scroller(q('.meta-field-mgr__config--scrollable')),
      footer: box(q('.meta-field-mgr__add-section'))!,
      confirm: box(q('.meta-field-mgr__confirm')),
      save: box(q('[data-test="field-config-save"]')),
      confirmDelete: box(q('.meta-field-mgr__btn-delete')),
      aria: splitter
        ? {
            now: Number(splitter.getAttribute('aria-valuenow')),
            min: Number(splitter.getAttribute('aria-valuemin')),
            max: Number(splitter.getAttribute('aria-valuemax')),
          }
        : null,
      doc: {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: document.documentElement.clientHeight,
      },
    }
  })
}

function collectErrors(page: Page): string[] {
  const errs: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`) })
  page.on('pageerror', (e) => errs.push(`pageerror: ${String(e)}`))
  page.on('response', (r) => { if (r.status() >= 400) errs.push(`http ${r.status()}: ${r.url()}`) })
  return errs
}

async function open(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height })
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.meta-field-mgr')).toBeVisible()
  // The harness starts with a clean slate: no remembered manual height from an earlier test.
  await page.evaluate(() => window.localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.locator('.meta-field-mgr')).toBeVisible()
}

async function resize(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height })
  // One animation frame for the resize listener + ResizeObserver to publish, one for layout.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

async function openTallConfig(page: Page) {
  // The first row is the 48-option select field; its first action button is ⚙ configure.
  await page.locator('.meta-field-mgr__row').first().locator('.meta-field-mgr__action').first().click()
  const pane = page.locator('.meta-field-mgr__config--scrollable')
  await expect(pane).toBeVisible()
  await expect(page.locator('[data-test="field-mgr-splitter"]')).toBeVisible()
  await expect(pane.locator('.meta-field-mgr__option-row')).toHaveCount(48)
  await resize(page, page.viewportSize()!.width, page.viewportSize()!.height)
  // Precondition for every "pane == published height" assertion: the content really is taller than
  // the window, so the pane is bounded by its max-height and never merely hugging its content.
  const contentTallerThanWindow = await pane.evaluate((el) => el.scrollHeight > window.innerHeight)
  expect(contentTallerThanWindow, 'harness precondition: config content taller than the window').toBe(true)
}

/** Invariants that must hold at every window size, config pane open or not. */
function expectFrameContract(l: Layout, label: string) {
  // The frame is the viewport minus the 32px gutter, centred: 16px above and below.
  expect(l.dialog.top, `${label}: frame top gutter`).toBeGreaterThanOrEqual(GUTTER / 2 - EPS)
  expect(l.dialog.bottom, `${label}: frame bottom gutter`).toBeLessThanOrEqual(l.vh - GUTTER / 2 + EPS)
  // The frame never scrolls itself (no scrollbar around the two scroll regions)...
  expect(l.dialog.overflowY, `${label}: frame is not a scroll container`).toBe('visible')
  expect(l.dialog.scrollHeight, `${label}: nothing overflows the frame`).toBeLessThanOrEqual(l.dialog.clientHeight + EPS)
  // ...and neither does the page behind it, in either direction.
  expect(l.doc.scrollHeight, `${label}: page must not scroll vertically`).toBeLessThanOrEqual(l.doc.clientHeight)
  expect(l.doc.scrollWidth, `${label}: page must not scroll horizontally`).toBeLessThanOrEqual(l.doc.clientWidth)
  // The field list is the frame's scroll region, never squeezed under its floor.
  expect(l.list.overflowY, `${label}: list scrolls`).toBe('auto')
  expect(l.list.height, `${label}: list keeps its floor`).toBeGreaterThanOrEqual(LIST_FLOOR - EPS)
  expect(l.list.scrollWidth, `${label}: list has no horizontal overflow`).toBeLessThanOrEqual(l.list.clientWidth)
  // Header and add-field footer are fully inside the frame and the window.
  expect(l.header.top, `${label}: header top inside frame`).toBeGreaterThanOrEqual(l.dialog.top - EPS)
  expect(l.footer.bottom, `${label}: footer inside frame`).toBeLessThanOrEqual(l.dialog.bottom + EPS)
  expect(l.footer.bottom, `${label}: footer inside window`).toBeLessThanOrEqual(l.vh)
  // The rows stack exactly into the frame: nothing is clipped or spills out of it.
  const stacked = l.header.height + l.list.height + (l.splitter?.height ?? 0) + (l.config?.height ?? 0)
    + l.footer.height + (l.confirm?.height ?? 0)
  expect(Math.abs(stacked - l.dialog.height), `${label}: rows stack exactly into the frame (${stacked} vs ${l.dialog.height})`).toBeLessThanOrEqual(2)
  if (l.config) {
    expect(l.config.overflowY, `${label}: config pane scrolls`).toBe('auto')
    expect(l.config.scrollWidth, `${label}: config pane has no horizontal overflow`).toBeLessThanOrEqual(l.config.clientWidth)
    // Save/Cancel (sticky) is on screen, inside the config pane.
    expect(l.save, `${label}: Save rendered`).not.toBeNull()
    expect(l.save!.bottom, `${label}: Save inside config pane`).toBeLessThanOrEqual(l.config.bottom + EPS)
    expect(l.save!.top, `${label}: Save inside config pane (top)`).toBeGreaterThanOrEqual(l.config.top - EPS)
    expect(l.save!.bottom, `${label}: Save inside window`).toBeLessThanOrEqual(l.vh)
  }
}

test.describe('#5864 ② field manager: list + config pane follow the window height', () => {
  test('frame height is the window minus the gutter at 800px and 1080px (was a fixed 84vh cap)', async ({ page }) => {
    mkdirSync(OUT, { recursive: true })
    const errs = collectErrors(page)
    for (const [width, height] of [[1280, 800], [1920, 1080]] as const) {
      await open(page, width, height)
      const l = await readLayout(page)
      expectFrameContract(l, `${width}x${height} list only`)
      // 48 rows overflow any window, so the frame fills it: 768px at 800, 1048px at 1080 (84vh gave
      // 672 / 907 -- the assertion below is what that old cap fails).
      expect(Math.abs(l.dialog.height - (height - GUTTER)), `${width}x${height}: frame height ${l.dialog.height}`).toBeLessThanOrEqual(EPS)
      expect(l.list.scrollHeight, `${width}x${height}: the list itself is what scrolls`).toBeGreaterThan(l.list.clientHeight)
      await page.screenshot({ path: `${OUT}/field-manager-viewport-list-${height}.png` })
    }
    expect(errs, `console/page errors:\n${errs.join('\n')}`).toEqual([])
  })

  test('config pane open: default split, End/ceiling, header/footer/Save visible, at 800px and 1080px', async ({ page }) => {
    const errs = collectErrors(page)
    for (const [width, height] of [[1280, 800], [1920, 1080]] as const) {
      await open(page, width, height)
      await openTallConfig(page)
      let l = await readLayout(page)
      expectFrameContract(l, `${width}x${height} default split`)
      expect(Math.abs(l.dialog.height - (height - GUTTER)), `${width}x${height}: frame height`).toBeLessThanOrEqual(EPS)
      // What the component publishes is what renders (border-box, and the ceiling arithmetic uses
      // the MEASURED rows, so the flex layout never has to shrink the pane behind aria's back).
      expect(Math.abs(l.config!.height - l.aria!.now), `${width}x${height}: rendered pane ${l.config!.height} vs aria-valuenow ${l.aria!.now}`).toBeLessThanOrEqual(EPS)
      // Untouched split: the config content is taller than half the window, so both halves get half.
      expect(Math.abs(l.config!.height - l.list.height), `${width}x${height}: default split list ${l.list.height} / pane ${l.config!.height}`).toBeLessThanOrEqual(2)
      await page.screenshot({ path: `${OUT}/field-manager-viewport-config-${height}.png` })

      // End = the ceiling: the pane takes everything except the list's 96px floor, exactly.
      await page.locator('[data-test="field-mgr-splitter"]').focus()
      await page.keyboard.press('End')
      l = await readLayout(page)
      expectFrameContract(l, `${width}x${height} at ceiling`)
      expect(l.aria!.now, `${width}x${height}: End lands on aria-valuemax`).toBe(l.aria!.max)
      expect(Math.abs(l.config!.height - l.aria!.max), `${width}x${height}: rendered pane at ceiling ${l.config!.height} vs aria-valuemax ${l.aria!.max}`).toBeLessThanOrEqual(EPS)
      expect(Math.abs(l.list.height - LIST_FLOOR), `${width}x${height}: list sits exactly on its floor at the ceiling (${l.list.height})`).toBeLessThanOrEqual(EPS)
    }
    expect(errs, `console/page errors:\n${errs.join('\n')}`).toEqual([])
  })

  test('a manual height survives a shrink-then-grow of the window; the ceiling tracks the window both ways', async ({ page }) => {
    const errs = collectErrors(page)
    await open(page, 1920, 1080)
    await openTallConfig(page)
    const splitter = page.locator('[data-test="field-mgr-splitter"]')
    await splitter.focus()
    for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowUp')
    const chosen = (await readLayout(page)).aria!.now
    const tallMax = (await readLayout(page)).aria!.max

    await resize(page, 1920, 600)
    let l = await readLayout(page)
    expectFrameContract(l, '1920x600 after shrink')
    expect(l.aria!.max, 'a shorter window lowers the ceiling by exactly the height it lost').toBe(tallMax - 480)
    expect(l.aria!.now, 'the chosen height is clamped to the lower ceiling').toBe(l.aria!.max)
    expect(Math.abs(l.config!.height - l.aria!.now)).toBeLessThanOrEqual(EPS)

    await resize(page, 1920, 1080)
    l = await readLayout(page)
    expectFrameContract(l, '1920x1080 after grow')
    expect(l.aria!.max, 'the ceiling comes back with the window').toBe(tallMax)
    // r8-B kept the clamped copy here for the rest of the session; the manual choice now comes back.
    expect(l.aria!.now, 'the manual height comes back in full').toBe(chosen)
    expect(Math.abs(l.config!.height - chosen)).toBeLessThanOrEqual(EPS)
    expect(errs, `console/page errors:\n${errs.join('\n')}`).toEqual([])
  })

  test('short and narrow windows: nothing overflows, header/footer/Save stay on screen', async ({ page }) => {
    const errs = collectErrors(page)
    for (const [width, height] of [[1280, 480], [360, 640]] as const) {
      await open(page, width, height)
      await openTallConfig(page)
      const l = await readLayout(page)
      expectFrameContract(l, `${width}x${height}`)
      expect(l.dialog.right - l.dialog.left, `${width}x${height}: frame width stays inside the window`).toBeLessThanOrEqual(width - GUTTER + EPS)
      await page.screenshot({ path: `${OUT}/field-manager-viewport-small-${width}x${height}.png` })
    }
    expect(errs, `console/page errors:\n${errs.join('\n')}`).toEqual([])
  })

  test('the delete confirmation row is counted: at the ceiling its buttons stay on screen and the list keeps its floor', async ({ page }) => {
    const errs = collectErrors(page)
    await open(page, 1280, 800)
    await openTallConfig(page)
    const before = (await readLayout(page)).aria!.max
    // Delete button (last action) of the second row -> the confirmation row appears under the footer.
    await page.locator('.meta-field-mgr__row').nth(1).locator('.meta-field-mgr__action--danger').click()
    await expect(page.locator('.meta-field-mgr__confirm')).toBeVisible()
    await resize(page, 1280, 800)
    await page.locator('[data-test="field-mgr-splitter"]').focus()
    await page.keyboard.press('End')
    const l = await readLayout(page)
    expectFrameContract(l, '1280x800 with delete confirmation')
    expect(l.confirm, 'confirmation row rendered').not.toBeNull()
    // offsetHeight (what the component sums) is the rect height rounded, hence the 1px tolerance.
    expect(Math.abs(l.aria!.max - (before - l.confirm!.height)), `the ceiling shrinks by the confirmation row height (${before} -> ${l.aria!.max}, row ${l.confirm!.height})`).toBeLessThanOrEqual(1)
    expect(Math.abs(l.list.height - LIST_FLOOR)).toBeLessThanOrEqual(EPS)
    expect(l.confirmDelete!.bottom, 'confirm-delete button inside the window').toBeLessThanOrEqual(l.vh)
    await page.screenshot({ path: `${OUT}/field-manager-viewport-confirm-800.png` })
    expect(errs, `console/page errors:\n${errs.join('\n')}`).toEqual([])
  })
})
