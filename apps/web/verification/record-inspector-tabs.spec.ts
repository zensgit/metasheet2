import { test, expect, type Locator } from '@playwright/test'

async function readGeometry(panel: Locator) {
  return panel.evaluate(el => {
    const buttons = [...el.querySelectorAll<HTMLElement>('[role=tab]')].map(button => {
      const box = button.getBoundingClientRect()
      const range = document.createRange()
      range.selectNodeContents(button)
      const text = range.getBoundingClientRect()
      return { label: button.textContent, left: box.left, right: box.right, top: box.top, bottom: box.bottom, textLeft: text.left, textRight: text.right }
    })
    const pill = el.querySelector('[role=tablist]')!.getBoundingClientRect()
    const bar = el.querySelector('.meta-record-drawer__tabs-bar')!
    const barStyle = getComputedStyle(bar)
    const hide = el.querySelector('.meta-record-drawer__hide-empty')!.getBoundingClientRect()
    return {
      width: el.getBoundingClientRect().width,
      buttons,
      pillBottom: pill.bottom,
      pillWidth: pill.width,
      containerWidth: bar.clientWidth - parseFloat(barStyle.paddingLeft) - parseFloat(barStyle.paddingRight),
      hideTop: hide.top,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }
  })
}

// The shipped component must keep readable tabs, not merely four button boxes on one row.
// No copied CSS, injected repair CSS or backend traffic. Existing browser lane collects this file.
for (const locale of ['en', 'zh-CN']) {
  for (const viewport of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 1512, height: 982 }]) {
    for (const width of [360, 560, 720]) {
      test(`record tabs ${locale}-${viewport.width}-${width}`, async ({ page }, testInfo) => {
        const errors: string[] = []
        const requests: string[] = []
        page.on('pageerror', error => errors.push(String(error)))
        await page.route('**/*', route => {
          const url = new URL(route.request().url())
          if (url.pathname.startsWith('/api/') || url.hostname !== '127.0.0.1') {
            requests.push(url.pathname)
            return route.abort()
          }
          return route.continue()
        })
        await page.setViewportSize(viewport)
        await page.goto(`/verification/record-inspector-tabs-harness.html?locale=${locale}&width=${width}`)
        const panel = page.locator('.meta-record-drawer')
        const tabs = panel.getByRole('tab')
        const toggle = panel.getByTestId('record-inspector-hide-empty')
        await expect(tabs).toHaveCount(4)
        await expect(toggle).toBeVisible()
        const geometry = await readGeometry(panel)
        await testInfo.attach('geometry', { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' })
        await page.screenshot({ path: testInfo.outputPath('tabs.png'), fullPage: true })
        expect(geometry.width).toBe(width)
        expect(new Set(geometry.buttons.map(button => button.top)).size).toBe(1)
        for (const button of geometry.buttons) {
          expect(button.textLeft, `${button.label}: left edge`).toBeGreaterThanOrEqual(button.left - 0.5)
          expect(button.textRight, `${button.label}: right edge`).toBeLessThanOrEqual(button.right + 0.5)
        }
        if (width === 360) expect(geometry.hideTop).toBeGreaterThanOrEqual(geometry.pillBottom)
        if (width >= 560) expect(geometry.hideTop).toBeLessThan(geometry.pillBottom)
        expect(geometry.pageOverflow).toBeLessThanOrEqual(0)

        // The layout fix must retain the same keyboard behavior and reachable toggle.
        await tabs.first().focus()
        await page.keyboard.press('End')
        await expect(tabs.last()).toBeFocused()
        await expect(tabs.last()).toHaveAttribute('aria-selected', 'true')
        await page.keyboard.press('Home')
        await expect(tabs.first()).toBeFocused()
        await toggle.click()
        await expect(toggle).toHaveAttribute('aria-pressed', 'true')
        expect(errors).toEqual([])
        expect(requests).toEqual([])
      })
    }
  }
}

// Below the nominal 360px panel floor, the mobile overlay may wrap the tabs but must not
// overlap labels. This also guards against fixing 360 by forcing nowrap at every narrow width.
for (const locale of ['en', 'zh-CN']) {
  for (const viewportWidth of [390, 375, 360, 320]) {
    test(`record tabs overlay ${locale}-${viewportWidth}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: viewportWidth, height: 900 })
      await page.goto(`/verification/record-inspector-tabs-harness.html?locale=${locale}&overlay=1`)
      const panel = page.locator('.meta-record-drawer--overlay')
      const tabs = panel.getByRole('tab')
      await expect(tabs).toHaveCount(4)
      const geometry = await readGeometry(panel)
      expect(geometry.width).toBe(Math.min(360, viewportWidth - 32))
      for (const button of geometry.buttons) {
        expect(button.textLeft).toBeGreaterThanOrEqual(button.left - 0.5)
        expect(button.textRight).toBeLessThanOrEqual(button.right + 0.5)
      }
      expect(geometry.pageOverflow).toBeLessThanOrEqual(0)
      await testInfo.attach('geometry', { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' })
      await page.screenshot({ path: testInfo.outputPath('tabs-overlay.png'), fullPage: true })
      for (let index = 0; index < 4; index += 1) {
        await tabs.nth(index).click()
        await expect(tabs.nth(index)).toHaveAttribute('aria-selected', 'true')
      }
    })
  }
  for (const width of [452, 453]) {
    test(`record tabs container boundary ${locale}-${width}`, async ({ page }) => {
      await page.setViewportSize({ width: 1366, height: 768 })
      await page.goto(`/verification/record-inspector-tabs-harness.html?locale=${locale}&width=${width}`)
      const panel = page.locator('.meta-record-drawer')
      await expect(panel.getByRole('tab')).toHaveCount(4)
      const geometry = await readGeometry(panel)
      expect(geometry.containerWidth).toBe(width - 33) // 1px panel border + 32px horizontal padding
      if (width === 452) expect(geometry.pillWidth).toBeCloseTo(geometry.containerWidth, 0)
      else expect(geometry.pillWidth).toBeLessThan(geometry.containerWidth)
      expect(new Set(geometry.buttons.map(button => button.top)).size).toBe(1)
      for (const button of geometry.buttons) {
        expect(button.textLeft).toBeGreaterThanOrEqual(button.left - 0.5)
        expect(button.textRight).toBeLessThanOrEqual(button.right + 0.5)
      }
      expect(geometry.pageOverflow).toBeLessThanOrEqual(0)
    })
  }
}
