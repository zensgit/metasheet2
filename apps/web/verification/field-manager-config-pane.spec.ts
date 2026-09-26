import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'

// 客户反馈 2026-09-24 #7a (also #5864 ②): in 管理字段 the config pane's height could not be changed --
// ⤢/⤡ (放大/缩小配置区) and the splitter had no visible effect. Root cause: they only moved the pane's
// max-height, and the pane, a shrinkable flex item in an 84vh flex column, was drawn below that
// ceiling whenever its content was tall. jsdom computes no layout, so everything below is asserted on
// the REAL component in a real browser (harness: field-manager-config-pane-harness.ts).
//
// It also pins the two short-window regressions a previous attempt (#6072) was rejected for: the
// add-field row and the delete confirmation's 取消/删除 pushed out of the dialog at 640x360, and
// 放大→缩小 storing a height the user never chose; and, from #6077's adversarial review, the upgrade
// from r59's polluted storage (B1), gestures on a short config that draw nothing (S1), a clamp
// overwriting a height chosen on a taller window (S2), and a click with a wobble (N1); and, from the
// second review, grow steps on a config between the default and the ceiling (SF1), the untouched
// split on a sheet with few fields (SF2), and a ceiling below the pane's own padding (nit 5).

const OUT = 'verification-output'
const HARNESS = '/verification/field-manager-config-pane-harness.html'
// #7a review B1: the preference lives under a versioned key; the r8-B key holds what the deployed
// build stored (often a height nobody chose) and must be ignored and removed.
const STORAGE_KEY = 'metasheet.fieldManager.configPaneHeight.v2'
const LEGACY_STORAGE_KEY = 'metasheet.fieldManager.configPaneHeight'
// Sub-pixel tolerance: row heights such as the confirmation (84.5px) are fractional.
const PX = 1.5

type Box = { top: number; bottom: number; height: number; left: number; right: number }
type Metrics = {
  vh: number
  dialog: Box
  dialogScrollHeight: number
  dialogClientHeight: number
  list: Box | null
  listScrollHeight: number
  listClientHeight: number
  pane: Box | null
  /** The pane's natural border-box height: what it would draw with no ceiling (#7a round 3). */
  paneNatural: number
  addRow: Box | null
  addError: Box | null
  confirm: Box | null
  confirmCancel: Box | null
  confirmDelete: Box | null
  confirmCancelHit: boolean
  confirmDeleteHit: boolean
  addButtonHit: boolean
  now: number
  min: number
  max: number
  stored: string | null
  legacyStored: string | null
}

async function openHarness(
  page: Page,
  width: number,
  height: number,
  errors: string[],
  seed: Record<string, string> = {},
  query = '',
) {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e)}`))
  // Storage as an earlier build (or an earlier session) left it, in place before the app boots.
  if (Object.keys(seed).length > 0) {
    await page.addInitScript((entries) => {
      for (const [key, value] of Object.entries(entries)) window.localStorage.setItem(key, value)
    }, seed)
  }
  await page.setViewportSize({ width, height })
  await page.goto(`${HARNESS}${query}`, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.meta-field-mgr')).toBeVisible()
}

function fieldRow(page: Page, name: string) {
  return page.locator('.meta-field-mgr__row', {
    has: page.locator('.meta-field-mgr__name', { hasText: new RegExp(`^${name}$`) }),
  })
}

async function openConfig(page: Page, name: string) {
  // The first row action is ⚙ (configure).
  await fieldRow(page, name).locator('.meta-field-mgr__action').first().click()
  await expect(page.locator('[data-test="field-mgr-splitter"]')).toBeVisible()
  await settle(page)
}

async function settle(page: Page) {
  // Two frames: one for Vue's re-render, one for the ResizeObserver re-measure it may trigger.
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
}

async function metrics(page: Page): Promise<Metrics> {
  return page.evaluate((keys) => {
    const box = (el: Element | null) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, height: r.height, left: r.left, right: r.right }
    }
    const q = (selector: string) => document.querySelector(selector)
    const hits = (el: Element | null) => {
      if (!el) return false
      const r = el.getBoundingClientRect()
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return at != null && (at === el || el.contains(at))
    }
    const dialog = q('.meta-field-mgr') as HTMLElement
    const splitter = q('[data-test="field-mgr-splitter"]')
    const list = q('.meta-field-mgr__body') as HTMLElement | null
    const pane = q('.meta-field-mgr__config--scrollable') as HTMLElement | null
    return {
      vh: window.innerHeight,
      dialog: box(dialog)!,
      dialogScrollHeight: dialog.scrollHeight,
      dialogClientHeight: dialog.clientHeight,
      list: box(list),
      listScrollHeight: list?.scrollHeight ?? 0,
      listClientHeight: list?.clientHeight ?? 0,
      pane: box(pane),
      paneNatural: pane ? pane.scrollHeight + (pane.getBoundingClientRect().height - pane.clientHeight) : 0,
      addRow: box(q('.meta-field-mgr__add-row')),
      addError: box(q('[data-test="add-conflict-error"]')),
      confirm: box(q('.meta-field-mgr__confirm')),
      confirmCancel: box(q('.meta-field-mgr__confirm .meta-field-mgr__btn-cancel')),
      confirmDelete: box(q('.meta-field-mgr__confirm .meta-field-mgr__btn-delete')),
      confirmCancelHit: hits(q('.meta-field-mgr__confirm .meta-field-mgr__btn-cancel')),
      confirmDeleteHit: hits(q('.meta-field-mgr__confirm .meta-field-mgr__btn-delete')),
      addButtonHit: hits(q('[data-test="add-field-submit"]')),
      now: Number(splitter?.getAttribute('aria-valuenow')),
      min: Number(splitter?.getAttribute('aria-valuemin')),
      max: Number(splitter?.getAttribute('aria-valuemax')),
      stored: window.localStorage.getItem(keys.current),
      legacyStored: window.localStorage.getItem(keys.legacy),
    }
  }, { current: STORAGE_KEY, legacy: LEGACY_STORAGE_KEY })
}

function expectInsideDialog(m: Metrics, box: Box | null, label: string) {
  expect(box, `${label} is rendered`).not.toBeNull()
  expect(box!.top, `${label} top inside the dialog (${box!.top} vs ${m.dialog.top})`).toBeGreaterThanOrEqual(m.dialog.top - 0.5)
  expect(box!.bottom, `${label} bottom inside the dialog (${box!.bottom} vs ${m.dialog.bottom})`).toBeLessThanOrEqual(m.dialog.bottom + 0.5)
  expect(box!.bottom, `${label} bottom inside the window (${box!.bottom} vs ${m.vh})`).toBeLessThanOrEqual(m.vh + 0.5)
}

function expectNoFrameOverflow(m: Metrics, label: string) {
  expect(m.dialogScrollHeight, `${label}: nothing spills out of the dialog frame`).toBeLessThanOrEqual(m.dialogClientHeight + 1)
}

async function dragSplitter(page: Page, deltaY: number) {
  const handle = await page.locator('[data-test="field-mgr-splitter"]').boundingBox()
  expect(handle).not.toBeNull()
  const x = handle!.x + handle!.width / 2
  const y = handle!.y + handle!.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y + deltaY, { steps: 5 })
  await page.mouse.up()
  await settle(page)
}

test.describe('管理字段 config pane height (客户反馈 2026-09-24 #7a)', () => {
  test.beforeAll(() => mkdirSync(OUT, { recursive: true }))

  test('1280x800: the tall pane is drawn at its height; ⤢ grows it by >100px, ⤡ shrinks it back; nothing is stored', async ({ page }) => {
    const errors: string[] = []
    await openHarness(page, 1280, 800, errors)
    await openConfig(page, 'Select field')

    const before = await metrics(page)
    // The core of the bug: the drawn pane must equal the published height, not a content-weighted share.
    expect(Math.abs(before.pane!.height - before.now), `drawn ${before.pane!.height} vs aria-valuenow ${before.now}`).toBeLessThanOrEqual(PX)
    expect(before.max - before.now, 'the default leaves room for ⤢ to enlarge').toBeGreaterThan(100)
    expectInsideDialog(before, before.addRow, 'add-field row')
    expectNoFrameOverflow(before, 'default')

    await page.locator('[data-test="field-mgr-config-expand"]').click()
    await settle(page)
    const expanded = await metrics(page)
    expect(expanded.pane!.height - before.pane!.height, `⤢ grew the pane ${before.pane!.height} -> ${expanded.pane!.height}`).toBeGreaterThan(100)
    expect(Math.abs(expanded.pane!.height - expanded.max), 'expanded pane is drawn at aria-valuemax').toBeLessThanOrEqual(PX)
    expect(expanded.list!.height, 'the field list keeps its 96px floor').toBeGreaterThanOrEqual(96 - PX)
    expectInsideDialog(expanded, expanded.addRow, 'add-field row (expanded)')
    expectNoFrameOverflow(expanded, 'expanded')
    await page.screenshot({ path: `${OUT}/field-config-pane-expanded-1280x800.png` })

    await page.locator('[data-test="field-mgr-config-expand"]').click()
    await settle(page)
    const collapsed = await metrics(page)
    expect(expanded.pane!.height - collapsed.pane!.height, `⤡ shrank the pane ${expanded.pane!.height} -> ${collapsed.pane!.height}`).toBeGreaterThan(100)
    expect(Math.abs(collapsed.pane!.height - before.pane!.height), '⤡ returns to the default').toBeLessThanOrEqual(PX)
    // The user chose nothing, so nothing may be stored (the default must keep following the window).
    expect(collapsed.stored).toBeNull()

    expect(errors, errors.join('\n')).toEqual([])
  })

  test('1280x800: dragging the splitter up 100px grows the drawn pane by 100px, down shrinks it; the release is stored', async ({ page }) => {
    const errors: string[] = []
    await openHarness(page, 1280, 800, errors)
    await openConfig(page, 'Select field')
    const before = await metrics(page)

    await dragSplitter(page, -100)
    const grown = await metrics(page)
    expect(grown.pane!.height - before.pane!.height, `drag up: ${before.pane!.height} -> ${grown.pane!.height}`).toBeGreaterThanOrEqual(100 - 2)
    expect(grown.pane!.height - before.pane!.height).toBeLessThanOrEqual(100 + 2)
    expect(Math.abs(grown.pane!.height - grown.now)).toBeLessThanOrEqual(PX)
    expect(grown.stored, 'a manual drag is stored on release').toBe(String(grown.now))

    await dragSplitter(page, 60)
    const shrunk = await metrics(page)
    expect(grown.pane!.height - shrunk.pane!.height, `drag down: ${grown.pane!.height} -> ${shrunk.pane!.height}`).toBeGreaterThanOrEqual(60 - 2)
    expect(grown.pane!.height - shrunk.pane!.height).toBeLessThanOrEqual(60 + 2)

    expect(errors, errors.join('\n')).toEqual([])
  })

  test('1280x800: a short config still hugs its content, and a downward drag moves it from the DRAWN height at once', async ({ page }) => {
    const errors: string[] = []
    await openHarness(page, 1280, 800, errors)
    await openConfig(page, 'Short config')
    const before = await metrics(page)
    expect(before.now - before.pane!.height, `short pane hugs its content (drawn ${before.pane!.height}, ceiling ${before.now})`).toBeGreaterThan(20)

    // 20px keeps it above the 120px floor (the dateTime pane is ~140px tall). Starting from the
    // published ceiling instead (r8-B) would move the ceiling 20px and draw no change at all.
    await dragSplitter(page, 20)
    const after = await metrics(page)
    expect(before.pane!.height - after.pane!.height, `drag down 20 from ${before.pane!.height} drew ${after.pane!.height}`).toBeGreaterThanOrEqual(20 - 2)
    expect(before.pane!.height - after.pane!.height).toBeLessThanOrEqual(20 + 2)

    expect(errors, errors.join('\n')).toEqual([])
  })

  test('1280x800: a delete confirmation opened under the expanded pane lowers the ceiling by its height and fits; cancelling restores it', async ({ page }) => {
    const errors: string[] = []
    await openHarness(page, 1280, 800, errors)
    await openConfig(page, 'Select field')
    await page.locator('[data-test="field-mgr-config-expand"]').click()
    await settle(page)
    const expanded = await metrics(page)

    await fieldRow(page, 'Field 05').locator('.meta-field-mgr__action--danger').click()
    await settle(page)
    const confirming = await metrics(page)
    expect(confirming.pane, 'the config pane stays open under the confirmation').not.toBeNull()
    expect(confirming.confirm, 'confirmation row shown').not.toBeNull()
    expect(Math.abs((expanded.max - confirming.max) - confirming.confirm!.height), `ceiling ${expanded.max} -> ${confirming.max}, row ${confirming.confirm!.height}`).toBeLessThanOrEqual(PX)
    expect(Math.abs(confirming.pane!.height - confirming.max), 'the expanded pane follows the lowered ceiling').toBeLessThanOrEqual(PX)
    expect(confirming.list!.height).toBeGreaterThanOrEqual(96 - PX)
    expectInsideDialog(confirming, confirming.addRow, 'add-field row')
    expectInsideDialog(confirming, confirming.confirmCancel, '取消')
    expectInsideDialog(confirming, confirming.confirmDelete, '删除')
    expectNoFrameOverflow(confirming, 'confirming')

    await page.locator('.meta-field-mgr__confirm .meta-field-mgr__btn-cancel').click()
    await settle(page)
    const restored = await metrics(page)
    expect(restored.confirm).toBeNull()
    expect(Math.abs(restored.max - expanded.max), 'ceiling restored after cancel').toBeLessThanOrEqual(PX)

    expect(errors, errors.join('\n')).toEqual([])
  })

  for (const [width, height] of [[640, 360], [844, 390], [1280, 400], [1280, 420], [1280, 460]] as const) {
    test(`${width}x${height}: the add-field row and the delete confirmation's 取消/删除 stay inside the dialog with the config pane open`, async ({ page }) => {
      const errors: string[] = []
      await openHarness(page, width, height, errors)
      await openConfig(page, 'Select field')

      const open = await metrics(page)
      expectInsideDialog(open, open.addRow, 'add-field row')
      expect(open.addButtonHit, 'the add button is hit-testable').toBe(true)
      expectNoFrameOverflow(open, 'pane open')
      expect(open.now).toBeLessThanOrEqual(open.max)
      expect(open.min).toBeLessThanOrEqual(open.now)

      await page.locator('[data-test="field-mgr-config-expand"]').click()
      await settle(page)
      await fieldRow(page, 'Field 02').locator('.meta-field-mgr__action--danger').click()
      await settle(page)
      const confirming = await metrics(page)
      expect(confirming.pane, 'the config pane stays open under the confirmation').not.toBeNull()
      expectInsideDialog(confirming, confirming.addRow, 'add-field row')
      expectInsideDialog(confirming, confirming.confirmCancel, '取消')
      expectInsideDialog(confirming, confirming.confirmDelete, '删除')
      expect(confirming.confirmCancelHit, '取消 is hit-testable').toBe(true)
      expect(confirming.confirmDeleteHit, '删除 is hit-testable').toBe(true)
      expectNoFrameOverflow(confirming, 'confirming')
      expect(confirming.now).toBeLessThanOrEqual(confirming.max)
      await page.screenshot({ path: `${OUT}/field-config-pane-confirm-${width}x${height}.png` })

      expect(errors, errors.join('\n')).toEqual([])
    })
  }

  test('640x360: the add-name conflict error stays inside the dialog with the config pane open', async ({ page }) => {
    const errors: string[] = []
    await openHarness(page, 640, 360, errors)
    await openConfig(page, 'Select field')
    await page.locator('.meta-field-mgr__add-row input.meta-field-mgr__input').fill('Field 05')
    await settle(page)
    const m = await metrics(page)
    expect(m.addError, 'conflict error shown').not.toBeNull()
    expectInsideDialog(m, m.addError, 'add-name conflict error')
    expectInsideDialog(m, m.addRow, 'add-field row')
    expectNoFrameOverflow(m, 'conflict error')

    expect(errors, errors.join('\n')).toEqual([])
  })

  test('640x360 -> 1280x900: ⤢/⤡ without a manual height stores nothing, so the default keeps following the window', async ({ page }) => {
    const errors: string[] = []
    await openHarness(page, 640, 360, errors)
    await openConfig(page, 'Select field')
    const short = await metrics(page)

    const toggle = page.locator('[data-test="field-mgr-config-expand"]')
    await toggle.click()
    await settle(page)
    await toggle.click()
    await settle(page)
    expect((await metrics(page)).stored, 'nothing stored by ⤢/⤡ on a short window').toBeNull()

    await page.setViewportSize({ width: 1280, height: 900 })
    await settle(page)
    const tall = await metrics(page)
    expect(tall.stored).toBeNull()
    expect(tall.now - short.now, `default followed the window (${short.now} -> ${tall.now})`).toBeGreaterThan(100)
    expect(tall.max - tall.now, 'and ⤢ has room to enlarge again').toBeGreaterThan(100)

    expect(errors, errors.join('\n')).toEqual([])
  })

  // --- #7a adversarial review ------------------------------------------------------------------

  // B1: r59 (05461c739) at an 800px window stored round(0.52 * 800) = 416 on the first ⤢ click and
  // round(0.84 * 800 - 160) = 512 after a drag up from its ceiling. The customer who reported #7a
  // pressed both, so their browser holds one of these under the r8-B key.
  for (const polluted of ['416', '512']) {
    test(`1280x800 upgraded from r59 with '${polluted}' under the r8-B key: ⤢ still grows the pane by >100px; the legacy key is removed`, async ({ page }) => {
      const errors: string[] = []
      await openHarness(page, 1280, 800, errors, { [LEGACY_STORAGE_KEY]: polluted })
      await openConfig(page, 'Select field')
      const before = await metrics(page)
      expect(before.legacyStored, 'the legacy key is removed on mount').toBeNull()
      expect(before.stored, 'and never migrated').toBeNull()
      expect(before.max - before.now, `the pane opens at the default, not the legacy ${polluted}`).toBeGreaterThan(100)

      await page.locator('[data-test="field-mgr-config-expand"]').click()
      await settle(page)
      const expanded = await metrics(page)
      expect(expanded.pane!.height - before.pane!.height, `⤢ grew the pane ${before.pane!.height} -> ${expanded.pane!.height}`).toBeGreaterThan(100)
      expect(expanded.stored).toBeNull()

      expect(errors, errors.join('\n')).toEqual([])
    })
  }

  // S1: the preference is one height for every config. A gesture on a SHORT config that draws nothing
  // (growing a pane that already shows all its content) must not replace it.
  test('1280x800: ArrowUp, End and a 100px drag up on a short config leave the stored height alone; the tall config reopens at it', async ({ page }) => {
    const errors: string[] = []
    await openHarness(page, 1280, 800, errors)
    await openConfig(page, 'Select field')
    const splitter = page.locator('[data-test="field-mgr-splitter"]')
    await splitter.focus()
    await page.keyboard.press('End')
    await settle(page)
    const chosen = await metrics(page)
    expect(chosen.stored, 'End is a manual choice').toBe(String(chosen.max))

    await openConfig(page, 'Short config')
    const short = await metrics(page)
    expect(short.now - short.pane!.height, `the short pane hugs its content (drawn ${short.pane!.height}, ceiling ${short.now})`).toBeGreaterThan(100)
    await splitter.focus()
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('End')
    await settle(page)
    await dragSplitter(page, -100)
    const after = await metrics(page)
    expect(after.stored, 'nothing the short pane could not draw was stored').toBe(chosen.stored)
    expect(Math.abs(after.pane!.height - short.pane!.height)).toBeLessThanOrEqual(PX)

    await openConfig(page, 'Select field')
    const reopened = await metrics(page)
    expect(Math.abs(reopened.pane!.height - Number(chosen.stored)), `tall config reopens at ${chosen.stored} (drawn ${reopened.pane!.height})`).toBeLessThanOrEqual(PX)

    expect(errors, errors.join('\n')).toEqual([])
  })

  // S2: a height chosen on a taller window is only clamped on this one; ⤡ must not overwrite it.
  test('1280x800 with 607 stored (chosen at 1080): ⤢/⤡ still moves the pane but keeps 607, and 1280x1080 draws 607 again', async ({ page }) => {
    const errors: string[] = []
    await openHarness(page, 1280, 800, errors, { [STORAGE_KEY]: '607' })
    await openConfig(page, 'Select field')
    const clamped = await metrics(page)
    expect(Math.abs(clamped.pane!.height - clamped.max), 'clamped to this window\'s ceiling').toBeLessThanOrEqual(PX)

    const toggle = page.locator('[data-test="field-mgr-config-expand"]')
    await toggle.click()
    await settle(page)
    await toggle.click()
    await settle(page)
    const collapsed = await metrics(page)
    expect(clamped.pane!.height - collapsed.pane!.height, `⤡ moved the pane ${clamped.pane!.height} -> ${collapsed.pane!.height}`).toBeGreaterThan(100)
    expect(collapsed.stored, 'the clamp did not overwrite the stored height').toBe('607')

    await page.setViewportSize({ width: 1280, height: 1080 })
    await settle(page)
    const tall = await metrics(page)
    expect(Math.abs(tall.pane!.height - 607), `607 comes back in full (drawn ${tall.pane!.height}, ceiling ${tall.max})`).toBeLessThanOrEqual(PX)

    expect(errors, errors.join('\n')).toEqual([])
  })

  // N1: a click with a 1-2px wobble sends pointermoves; it must not freeze the live default.
  test('1280x800: a click on the splitter with a 2px wobble stores nothing', async ({ page }) => {
    const errors: string[] = []
    await openHarness(page, 1280, 800, errors)
    await openConfig(page, 'Select field')
    const before = await metrics(page)
    await dragSplitter(page, 2)
    const after = await metrics(page)
    expect(after.stored).toBeNull()
    expect(Math.abs(after.pane!.height - before.pane!.height)).toBeLessThanOrEqual(PX)

    expect(errors, errors.join('\n')).toEqual([])
  })

  // --- #7a round 3 (second adversarial review) ------------------------------------------------------

  // SF1: a grow step stops at the pane's content, so the stored height is always one that was drawn.
  // Before, End on this config stored the 439 ceiling while drawing ~345, and the tall config then
  // opened at 439 with nothing left for ⤢ -- the #7a symptom, recreated by the fix.
  test('1280x800 mid config: End, a 150px drag up and a held ArrowUp all stop at its content and store what they draw; the tall config reopens there and ⤢ still travels', async ({ page }) => {
    const errors: string[] = []
    await openHarness(page, 1280, 800, errors)
    const splitter = page.locator('[data-test="field-mgr-splitter"]')
    const gestures: Array<[string, () => Promise<void>]> = [
      ['End', async () => { await splitter.focus(); await page.keyboard.press('End'); await settle(page) }],
      ['drag up 150', () => dragSplitter(page, -150)],
      ['held ArrowUp', async () => {
        await splitter.focus()
        for (let i = 0; i < 20; i += 1) await page.keyboard.down('ArrowUp')
        await page.keyboard.up('ArrowUp')
        await settle(page)
      }],
    ]
    const storedBy: string[] = []
    for (const [label, gesture] of gestures) {
      await page.evaluate((key) => window.localStorage.removeItem(key), STORAGE_KEY)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await openConfig(page, 'Mid config')
      const before = await metrics(page)
      // The case itself: content taller than the default split, well below the ceiling.
      expect(before.paneNatural, `${label}: content ${before.paneNatural} above the default ${before.now}`).toBeGreaterThan(before.now + 30)
      expect(before.paneNatural, `${label}: content ${before.paneNatural} below the ceiling ${before.max}`).toBeLessThan(before.max - 60)

      await gesture()
      const after = await metrics(page)
      expect(Math.abs(after.pane!.height - before.paneNatural), `${label}: drew ${after.pane!.height}, content ${before.paneNatural}`).toBeLessThanOrEqual(PX)
      expect(after.stored, `${label} is a visible choice`).not.toBeNull()
      expect(Math.abs(Number(after.stored) - after.pane!.height), `${label}: stored ${after.stored}, drawn ${after.pane!.height}`).toBeLessThanOrEqual(PX)
      storedBy.push(after.stored!)
    }
    expect(new Set(storedBy).size, `keyboard and pointer agree: ${storedBy.join(' / ')}`).toBe(1)

    await openConfig(page, 'Select field')
    const tall = await metrics(page)
    expect(Math.abs(tall.pane!.height - Number(storedBy[0])), `tall config reopens at ${storedBy[0]}`).toBeLessThanOrEqual(PX)
    await page.locator('[data-test="field-mgr-config-expand"]').click()
    await settle(page)
    const expanded = await metrics(page)
    expect(expanded.pane!.height - tall.pane!.height, `⤢ ${tall.pane!.height} -> ${expanded.pane!.height}`).toBeGreaterThan(60)

    expect(errors, errors.join('\n')).toEqual([])
  })

  // SF2: an untouched split gives the list only what its rows need. r8-B drew round(0.52 * vh) --
  // 416 / 562 / 749 -- on a sheet this small; half and half would have given 267 / 385 / 536.
  for (const height of [800, 1080, 1440]) {
    test(`1280x${height}, 3 fields: the list shows every row and the pane gets the rest (at least r8-B's ${Math.round(0.52 * height)}); with 48 fields it is half and ⤢ travels >100px`, async ({ page }) => {
      const errors: string[] = []
      await openHarness(page, 1280, height, errors, {}, '?fields=3')
      await openConfig(page, 'Select field')
      const few = await metrics(page)
      expect(few.listScrollHeight, 'all three rows fit, no list scrollbar').toBeLessThanOrEqual(few.listClientHeight)
      expect(few.now, `default ${few.now} vs r8-B ${Math.round(0.52 * height)}`).toBeGreaterThanOrEqual(Math.round(0.52 * height))
      expect(Math.abs(few.pane!.height - few.now), 'drawn at the published default').toBeLessThanOrEqual(PX)
      expectNoFrameOverflow(few, 'few fields')
      expect(few.stored).toBeNull()

      await openHarness(page, 1280, height, errors)
      await openConfig(page, 'Select field')
      const many = await metrics(page)
      expect(many.max - many.now, `48 fields: ⤢ has room (${many.now} -> ${many.max})`).toBeGreaterThan(100)
      expect(Math.abs(many.pane!.height - many.now)).toBeLessThanOrEqual(PX)

      expect(errors, errors.join('\n')).toEqual([])
    })
  }

  // Nit 5: the add-field row with the 自动编号 system hint (109.5px) plus a pending delete leaves the
  // pane a 25px ceiling at 640x360 -- below its own 29px of padding + border.
  test('640x360 with 自动编号 selected and a pending delete: the pane is drawn at its ceiling and 取消/删除 stay inside the dialog', async ({ page }) => {
    const errors: string[] = []
    await openHarness(page, 640, 360, errors)
    await page.selectOption('.meta-field-mgr__add-row select', 'autoNumber')
    await expect(page.locator('.meta-field-mgr__hint--system')).toBeVisible()
    await expect(page.locator('[data-test="field-mgr-splitter"]')).toBeVisible()
    await fieldRow(page, 'Field 05').locator('.meta-field-mgr__action--danger').click()
    await settle(page)
    const m = await metrics(page)
    expect(m.max, 'the ceiling is below the pane\'s own padding + border').toBeLessThan(29)
    expect(m.pane!.height, `drawn ${m.pane!.height} within the published ${m.now}`).toBeLessThanOrEqual(m.now + PX)
    expectInsideDialog(m, m.addRow, 'add-field row')
    expectInsideDialog(m, m.confirm, 'confirmation row')
    expectInsideDialog(m, m.confirmCancel, '取消')
    expectInsideDialog(m, m.confirmDelete, '删除')
    expect(m.confirmCancelHit, '取消 is hit-testable').toBe(true)
    expect(m.confirmDeleteHit, '删除 is hit-testable').toBe(true)
    expectNoFrameOverflow(m, '自动编号 + pending delete')
    await page.screenshot({ path: `${OUT}/field-config-pane-autonumber-confirm-640x360.png` })

    expect(errors, errors.join('\n')).toEqual([])
  })

  // Nit 5, last resort: at 640x260 the fixed rows alone (257px) outgrow the 218px frame. The frame
  // scrolls, so 取消/删除 can be reached instead of sitting below the window.
  test('640x260 with 自动编号 selected and a pending delete: the dialog stays inside the window and scrolls 取消/删除 into reach', async ({ page }) => {
    const errors: string[] = []
    await openHarness(page, 640, 260, errors)
    await page.selectOption('.meta-field-mgr__add-row select', 'autoNumber')
    await fieldRow(page, 'Field 05').locator('.meta-field-mgr__action--danger').click()
    await settle(page)
    await page.locator('.meta-field-mgr__confirm .meta-field-mgr__btn-delete').scrollIntoViewIfNeeded()
    await settle(page)
    const m = await metrics(page)
    expect(m.dialog.bottom, 'the dialog itself stays inside the window').toBeLessThanOrEqual(m.vh + 0.5)
    expectInsideDialog(m, m.confirmCancel, '取消')
    expectInsideDialog(m, m.confirmDelete, '删除')
    expect(m.confirmCancelHit, '取消 is hit-testable').toBe(true)
    expect(m.confirmDeleteHit, '删除 is hit-testable').toBe(true)

    expect(errors, errors.join('\n')).toEqual([])
  })
})
