import { expect, test, type Page } from '@playwright/test'
import { copyFileSync, mkdirSync } from 'node:fs'

const OUT = 'verification-output'
const ARTIFACT = '/opt/cursor/artifacts/attendance-ui'
const HARNESS = '/verification/attendance-admin-calendar-policy-move-harness.html'

function publish(name: string): void {
  mkdirSync(ARTIFACT, { recursive: true })
  copyFileSync(`${OUT}/${name}`, `${ARTIFACT}/${name}`)
}

async function scrollBelowSticky(page: Page, selector: string): Promise<void> {
  await page.evaluate((targetSelector) => {
    const target = document.querySelector(targetSelector)
    const sticky = document.querySelector('[data-admin-current-section="true"]')
    if (!(target instanceof HTMLElement)) return
    const stickyHeight = sticky instanceof HTMLElement ? sticky.getBoundingClientRect().height : 0
    let scroller: HTMLElement | null = target.parentElement
    while (scroller) {
      const overflowY = getComputedStyle(scroller).overflowY
      if ((overflowY === 'auto' || overflowY === 'scroll') && scroller.scrollHeight > scroller.clientHeight + 1) {
        break
      }
      scroller = scroller.parentElement
    }
    const offset = stickyHeight + 12
    if (scroller) {
      const delta = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset
      scroller.scrollTop += delta
      return
    }
    const top = target.getBoundingClientRect().top + window.scrollY - offset
    window.scrollTo({ top: Math.max(0, top), behavior: 'auto' })
  }, selector)
}

async function stubAttendanceApis(page: Page): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const url = route.request().url()
    if (url.includes('/api/plugins')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ name: 'plugin-attendance', status: 'active', contributes: { views: [] } }]),
      })
      return
    }
    if (url.includes('/api/attendance/import/template')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            payloadExample: {
              source: 'manual',
              mode: 'merge',
              columns: ['日期', '上班1打卡时间', '下班1打卡时间'],
            },
            mappingProfiles: [],
            mapping: { columns: [] },
          },
        }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: { items: [], summary: null, total: 0 } }),
    })
  })
}

async function openSection(page: Page, sectionId: string): Promise<void> {
  const errs: string[] = []
  page.on('pageerror', (error) => errs.push(String(error)))
  await stubAttendanceApis(page)
  await page.goto(`${HARNESS}?section=${sectionId}`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  const section = page.locator(`#${sectionId}`)
  await expect(section).toBeVisible({ timeout: 60_000 })
  await expect(section).toHaveClass(/attendance__form-sheet/)
  ;(page as Page & { __errs?: string[] }).__errs = errs
}

async function expectControlHeight(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).evaluate((node) => {
    const rect = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    return {
      height: Math.round(rect.height),
      boxSizing: style.boxSizing,
    }
  })
  expect(box.boxSizing, selector).toBe('border-box')
  expect(box.height, selector).toBe(32)
}

async function expectTwoColumns(page: Page, selector: string): Promise<void> {
  const columns = await page.locator(selector).evaluate((node) => (
    getComputedStyle(node).gridTemplateColumns.split(' ').filter(Boolean).length
  ))
  expect(columns, selector).toBe(2)
}

test.describe('attendance admin deep forms share Holidays and Settings chrome', () => {
  test.beforeAll(() => {
    mkdirSync(OUT, { recursive: true })
    mkdirSync(ARTIFACT, { recursive: true })
  })

  test('1440: rule builder uses cards, two columns, and 32px controls', async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width: 1440, height: 1200 })
    await openSection(page, 'attendance-admin-rule-sets')
    const basics = page.locator('#attendance-admin-rule-sets .attendance__rule-set-basics')
    await expect(basics).toHaveClass(/attendance__form-card/)
    await expectTwoColumns(page, '#attendance-admin-rule-sets .attendance__rule-builder-grid')
    await expectControlHeight(page, '#attendance-rule-builder-source')
    await scrollBelowSticky(page, '#attendance-rule-builder-source')
    const name = 'attendance-admin-rule-builder-1440.png'
    await page.screenshot({ path: `${OUT}/${name}`, fullPage: false })
    publish(name)
  })

  test('1440: payroll templates use the form card', async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width: 1440, height: 1200 })
    await openSection(page, 'attendance-admin-payroll-templates')
    const grid = page.locator('#attendance-admin-payroll-templates > .attendance__admin-grid')
    await expect(grid).toBeVisible()
    const templateColumns = await page.locator('#attendance-admin-payroll-templates > .attendance__admin-grid').evaluate((node) => (
      getComputedStyle(node).gridTemplateColumns.split(' ').filter(Boolean).length
    ))
    expect(templateColumns, 'payroll templates use three columns at desktop').toBe(3)
    const summaryColumns = await page.locator('[data-payroll-summary-field-options]').evaluate((node) => (
      getComputedStyle(node).gridTemplateColumns.split(' ').filter(Boolean).length
    ))
    expect(summaryColumns, 'summary field template uses four columns at desktop').toBe(4)
    const summaryGap = await page.locator('[data-payroll-summary-field-options]').evaluate((node) => getComputedStyle(node).columnGap)
    expect(summaryGap).toBe('8px')
    const optionLayout = await page.locator('[data-payroll-summary-field-option]').first().evaluate((node) => {
      const input = node.querySelector('input')
      const label = node.querySelector('strong')
      const span = node.querySelector('span')
      if (!(input instanceof HTMLElement) || !(label instanceof HTMLElement) || !(span instanceof HTMLElement)) {
        return { height: 0, sameRow: false, spanDirection: '' }
      }
      const inputBox = input.getBoundingClientRect()
      const labelBox = label.getBoundingClientRect()
      return {
        height: Math.round(node.getBoundingClientRect().height),
        sameRow: Math.abs((inputBox.top + inputBox.height / 2) - (labelBox.top + labelBox.height / 2)) <= 4,
        spanDirection: getComputedStyle(span).flexDirection,
      }
    })
    expect(optionLayout.spanDirection).toBe('row')
    expect(optionLayout.sameRow, 'checkbox sits on the same row as its label').toBe(true)
    expect(optionLayout.height).toBe(32)
    await expectControlHeight(page, '#attendance-payroll-template-name')
    await expectControlHeight(page, 'label[for="attendance-payroll-template-auto"]')
    await scrollBelowSticky(page, '.attendance__payroll-summary-header')
    const name = 'attendance-admin-payroll-templates-1440.png'
    await page.screenshot({ path: `${OUT}/${name}`, fullPage: false })
    publish(name)
  })

  test('1440: payroll cycles keep the same control chrome', async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width: 1440, height: 1200 })
    await openSection(page, 'attendance-admin-payroll-cycles')
    await expectTwoColumns(page, '#attendance-admin-payroll-cycles > .attendance__admin-grid')
    await expectControlHeight(page, '#attendance-payroll-cycle-name')
    await scrollBelowSticky(page, '#attendance-payroll-cycle-name')
    const name = 'attendance-admin-payroll-cycles-1440.png'
    await page.screenshot({ path: `${OUT}/${name}`, fullPage: false })
    publish(name)
  })

  test('1440: import form and template guide use the sheet', async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width: 1440, height: 1200 })
    await openSection(page, 'attendance-admin-import')
    await page.getByRole('button', { name: '加载模板' }).click()
    const guide = page.locator('#attendance-admin-import .attendance__template-guide')
    await expect(guide).toBeVisible()
    await expect(guide).toHaveClass(/attendance__form-card/)
    await expectTwoColumns(page, '#attendance-admin-import .attendance__template-guide-grid')
    await scrollBelowSticky(page, '#attendance-admin-import .attendance__template-guide')
    const guideShot = 'attendance-admin-import-guide-1440.png'
    await page.screenshot({ path: `${OUT}/${guideShot}`, fullPage: false })
    publish(guideShot)
    await expectTwoColumns(page, '#attendance-admin-import > .attendance__admin-grid:not(.attendance__import-advanced)')
    await expectControlHeight(page, '#attendance-import-mode')
    await scrollBelowSticky(page, '#attendance-import-rule-set')
    const formShot = 'attendance-admin-import-form-1440.png'
    await page.screenshot({ path: `${OUT}/${formShot}`, fullPage: false })
    publish(formShot)
  })

  test('1440: shift editor controls match the sheet', async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width: 1440, height: 1200 })
    await openSection(page, 'attendance-admin-shifts')
    await expectTwoColumns(page, '#attendance-admin-shifts > .attendance__admin-grid')
    await expectControlHeight(page, '#attendance-shift-name')
    const segmentInput = page.locator('#attendance-admin-shifts .shift-segments__field input').first()
    await expect(segmentInput).toBeVisible()
    const segmentHeight = await segmentInput.evaluate((node) => Math.round(node.getBoundingClientRect().height))
    expect(segmentHeight).toBe(32)
    await scrollBelowSticky(page, '#attendance-shift-name')
    const name = 'attendance-admin-shifts-1440.png'
    await page.screenshot({ path: `${OUT}/${name}`, fullPage: false })
    publish(name)
  })
})
