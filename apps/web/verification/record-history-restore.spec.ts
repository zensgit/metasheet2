import { expect, test } from '@playwright/test'

const HARNESS = '/verification/record-history-restore-harness.html'

test('record inspector history previews and executes a prior-version restore', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => errors.push(`pageerror: ${String(error)}`))

  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' })
  const status = page.locator('[data-test="restore-status"]')
  const recordValue = page.locator('[data-test="record-value"]')
  const apiCalls = page.locator('[data-test="api-calls"]')
  await expect(status).toHaveText('ready')
  await expect(recordValue).toHaveText('当前内容')

  await page.getByRole('tab').nth(1).click()
  await expect(page.locator('.meta-record-drawer__history-list')).toBeVisible()
  await expect(apiCalls).toContainText('history:sheet_history:rec_history:v3')
  await expect(page.locator('.meta-record-drawer__history-state')).toHaveCount(0)

  await page.locator('[data-test="record-history-restore"]').first().click()
  await expect(page.locator('[data-test="restore-preview"]')).toBeVisible()
  await expect(page.locator('[data-test="restore-preview-changes"]')).toContainText('较早内容')
  await expect(apiCalls).toContainText('preview:sheet_history:rec_history:v2:all')
  await expect(apiCalls).not.toContainText('execute:')

  await page.locator('[data-test="restore-preview-confirm"]').click()
  await expect(page.locator('[data-test="restore-preview"]')).toHaveCount(0)
  await expect(status).toHaveText('restored-v4')
  await expect(recordValue).toHaveText('较早内容')
  await expect(apiCalls).toContainText(
    'execute:sheet_history:rec_history:v2:expected3:preview_history:all',
  )
  await expect(apiCalls).toContainText('history:sheet_history:rec_history:v4')
  await expect(page.locator('[data-test="record-history-restored-from"]')).toContainText('v2')

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([])
})
