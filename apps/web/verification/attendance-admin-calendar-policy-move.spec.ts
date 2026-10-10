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
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: { items: [], summary: null, total: 0 } }),
    })
  })
}

test.describe('attendance admin calendar policy lives on Holidays', () => {
  test.beforeAll(() => {
    mkdirSync(OUT, { recursive: true })
    mkdirSync(ARTIFACT, { recursive: true })
  })

  test('1440: Holidays hosts the override form', async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    const errs: string[] = []
    page.on('pageerror', (error) => errs.push(String(error)))
    await stubAttendanceApis(page)
    await page.goto(`${HARNESS}?section=attendance-admin-holidays`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    const holidays = page.locator('#attendance-admin-holidays')
    const overrides = page.locator('#attendance-effective-calendar-overrides')
    await expect(holidays).toBeVisible({ timeout: 60_000 })
    await expect(overrides).toBeVisible()
    await expect(holidays.locator('[data-attendance-calendar-policy-host="holidays"]')).toBeVisible()
    await expect(holidays.locator('[data-attendance-calendar-policy-quick-add]')).toBeVisible()
    await expect(holidays.locator('h5').filter({ hasText: '有效日历覆盖规则' })).toBeVisible()
    await expect(page.locator('[data-admin-current-section="true"]')).toContainText('节假日')
    await expect(page.locator('#attendance-admin-settings [data-attendance-calendar-policy-quick-add]')).toHaveCount(0)
    await scrollBelowSticky(page, '#attendance-effective-calendar-overrides')
    const name = 'attendance-admin-holidays-calendar-overrides-1440.png'
    await page.screenshot({ path: `${OUT}/${name}`, fullPage: false })
    publish(name)
    expect(errs, `page errors: ${errs.join('; ')}`).toEqual([])
  })

  test('1440: Settings keeps the jump note and not the form', async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    const errs: string[] = []
    page.on('pageerror', (error) => errs.push(String(error)))
    await stubAttendanceApis(page)
    await page.goto(`${HARNESS}?section=attendance-admin-settings`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    const settings = page.locator('#attendance-admin-settings')
    const jump = settings.locator('[data-attendance-calendar-policy-jump]')
    await expect(settings).toBeVisible({ timeout: 60_000 })
    await expect(jump).toBeVisible()
    await expect(jump).toContainText('节假日')
    await expect(settings.locator('[data-attendance-calendar-policy-open-holidays]')).toHaveAttribute('href', '#attendance-admin-holidays')
    await expect(settings.locator('[data-attendance-calendar-policy-quick-add]')).toHaveCount(0)
    await expect(settings.locator('[data-calendar-policy-override-date]')).toHaveCount(0)
    await expect(settings.locator('#attendance-effective-calendar-overrides')).toHaveCount(0)
    await expect(page.locator('#attendance-admin-holidays')).toBeHidden()
    await expect(page.locator('[data-admin-current-section="true"]')).toContainText('设置')
    await scrollBelowSticky(page, '[data-attendance-calendar-policy-jump]')
    const name = 'attendance-admin-settings-jump-note-1440.png'
    await page.screenshot({ path: `${OUT}/${name}`, fullPage: false })
    publish(name)
    expect(errs, `page errors: ${errs.join('; ')}`).toEqual([])
  })
})
