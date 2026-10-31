import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { chromium } from '../../../candidate-playwright-core/index.mjs'

const origin = process.env.SYNTHETIC_ORIGIN
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true, args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
const unexpected = []
const writes = []
await context.route('**/*', async route => {
  const request = route.request()
  if (new URL(request.url()).origin !== origin) {
    unexpected.push('external-origin'); return route.abort()
  }
  if (!['GET','HEAD'].includes(request.method())) {
    writes.push(request.method()); return route.abort()
  }
  await route.continue()
})
await context.addInitScript(token => {
  localStorage.setItem('auth_token', token)
  localStorage.setItem('metasheet_locale', 'zh-CN')
}, process.env.SYNTHETIC_TOKEN)
try {
  const page = await context.newPage()
  await page.goto(origin + '/admin/directory', { waitUntil: 'networkidle' })
  const cards = page.locator('.directory-admin__item')
  await cards.first().waitFor({ state: 'visible', timeout: 30000 })
  assert.equal(await cards.count(), 3)
  const results = []
  for (const [name, corp, app, status] of [
    ['Synthetic E4','Synthetic Information Team','SyntheticSheet','企业与应用归属不一致'],
    ['Synthetic Canary','Synthetic Information Team','SyntheticCanary','管理员已核验'],
    ['Synthetic UAT','Synthetic Other Enterprise','SyntheticUAT','管理员已核验'],
  ]) {
    const card = cards.filter({ hasText: '用途：' + name })
    await card.click()
    const text = await card.innerText()
    assert(text.includes(corp) && text.includes(app) && text.includes(status) && text.includes('自动同步：关闭'))
    const panel = page.getByTestId('directory-identity-panel')
    await panel.waitFor({ state: 'visible' })
    assert((await panel.innerText()).includes('2026-11-01'))
    const shot = `candidate-ui-${process.env.SYNTHETIC_PHASE}-${name.split(' ').at(-1).toLowerCase()}.png`
    await card.screenshot({ path: shot })
    results.push({ name, status, syncEnabled: false, screenshot: shot })
  }
  assert.deepEqual(unexpected, [])
  assert.deepEqual(writes, [])
  writeFileSync(`candidate-browser-${process.env.SYNTHETIC_PHASE}.json`, JSON.stringify({ passed: true, synthetic: true, results, unexpectedRequests: unexpected, writeRequests: writes }, null, 2))
} finally {
  await browser.close()
}
