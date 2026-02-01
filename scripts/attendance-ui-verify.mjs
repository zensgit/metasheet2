import { chromium } from '@playwright/test'

const baseUrl = 'http://localhost:8899'
const apiBase = 'http://localhost:8900'
const userId = '0cdf4a9c-4fe1-471b-be08-854b683dc930'
const workDate = '2026-02-01'
const screenshotDir = 'artifacts/attendance-ui-verify'

async function getToken() {
  const res = await fetch(`${apiBase}/api/auth/dev-token?userId=${userId}&roles=admin&perms=attendance:admin,attendance:read,attendance:write`)
  if (!res.ok) throw new Error(`dev-token failed: ${res.status}`)
  const data = await res.json()
  return data.token
}

const token = await getToken()
const browser = await chromium.launch()
const context = await browser.newContext()
await context.addInitScript((value) => {
  localStorage.setItem('auth_token', value)
}, token)

const page = await context.newPage()
await page.goto(`${baseUrl}/p/plugin-attendance/attendance`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.attendance', { timeout: 30000 })
await page.waitForTimeout(3000)

const importSection = page.locator('.attendance__admin-section').filter({ hasText: 'Import (DingTalk / Manual)' })
await importSection.getByLabel('User ID').fill(userId)

const payload = {
  source: 'manual',
  rows: [
    {
      workDate,
      fields: {
        firstInAt: `${workDate} 09:10`,
        lastOutAt: `${workDate} 18:05`,
        workMinutes: 480,
        status: 'normal',
      },
    },
  ],
}
await importSection.getByLabel('Payload (JSON)').fill(JSON.stringify(payload, null, 2))

await importSection.getByRole('button', { name: 'Preview' }).click()
await importSection.locator('tbody tr').first().waitFor({ timeout: 20000 })

await importSection.getByRole('button', { name: 'Import' }).click()

const batchesHeading = page.getByText('Import Batches')
await batchesHeading.waitFor({ timeout: 15000 })
await page.waitForTimeout(1500)
await page.screenshot({ path: `${screenshotDir}/import-batches.png`, fullPage: true })

const viewItemsBtn = page.getByRole('button', { name: 'View items' }).first()
await viewItemsBtn.scrollIntoViewIfNeeded()
await viewItemsBtn.click()

const itemsSection = page.locator('.attendance__import-items')
await itemsSection.getByText('Batch Items').waitFor({ timeout: 15000 })

const itemViewBtn = itemsSection.getByRole('button', { name: 'View' }).first()
await itemViewBtn.click()
await itemsSection.getByText('Preview snapshot').waitFor({ timeout: 15000 })
await page.screenshot({ path: `${screenshotDir}/import-item-snapshot.png`, fullPage: true })

await itemsSection.getByRole('button', { name: 'Copy JSON' }).click()
const downloadPromise = page.waitForEvent('download')
await itemsSection.getByRole('button', { name: 'Download JSON' }).click()
const download = await downloadPromise
await download.saveAs(`${screenshotDir}/import-item-snapshot.json`)

page.once('dialog', (dialog) => dialog.accept())
const rollbackBtn = page.getByRole('button', { name: 'Rollback' }).first()
await rollbackBtn.scrollIntoViewIfNeeded()
await rollbackBtn.click()
await page.waitForTimeout(1000)

await browser.close()
console.log('UI verification complete')
