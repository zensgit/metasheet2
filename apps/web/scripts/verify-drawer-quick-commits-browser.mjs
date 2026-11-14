// Real-browser check of the record drawer's saves made faster than the server answers (useMultitableGrid's
// `patchCell` sends a record's writes one at a time, each with the version the one before returned). Chromium's
// date box saves every part typed, and a number box every arrow key. Synthetic data only.
// Run from apps/web: `npx vite --port 18919 --strictPort` in one shell, then `node scripts/verify-drawer-quick-commits-browser.mjs`.
import { chromium } from '@playwright/test'
const URL = 'http://127.0.0.1:18919/tests/fixtures/drawer-quick-commits-browser-demo.html'
const browser = await chromium.launch({ headless: true })
const failures = []
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
const leave = (page) => page.locator('#grid-area').click({ position: { x: 5, y: 5 } })
// Every request answered, and none sent since (a queued one goes out as soon as the one before is answered).
async function settled(page) {
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(400)
    if (await page.evaluate(() => window.quickDemo.inFlight === 0)) {
      await page.waitForTimeout(400)
      if (await page.evaluate(() => window.quickDemo.inFlight === 0)) return
    }
  }
  failures.push('the saves did not settle')
}
const result = (page, fieldId) => page.evaluate((f) => ({
  stored: window.quickDemo.stored().data[f],
  row: window.quickDemo.row().data[f],
  rejected: window.quickDemo.rejected,
  conflict: window.quickDemo.conflict() !== null,
}), fieldId)
const SCENARIOS = {
  async 'typing the day 15 in the date box (the day saves at "1" and at "15"): 2031-01-15 is stored, with no conflict'(page) {
    const due = page.locator('#drawer_field_fld_due')
    await due.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.type('15'); await leave(page)
    await settled(page)
    check('result', await result(page, 'fld_due'), { stored: '2031-01-15', row: '2031-01-15', rejected: 0, conflict: false })
    check('the box', await due.inputValue(), '2031-01-15')
  },
  async 'typing the year 2032 (saved at 0002, 0020, 0203 and 2032): 2032-01-02 is stored'(page) {
    const due = page.locator('#drawer_field_fld_due')
    await due.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.type('2032'); await leave(page)
    await settled(page)
    check('result', await result(page, 'fld_due'), { stored: '2032-01-02', row: '2032-01-02', rejected: 0, conflict: false })
    check('the box', await due.inputValue(), '2032-01-02')
  },
  async 'typing the day 09 (the half-typed day saves an empty date first): 2031-01-09 is stored'(page) {
    const due = page.locator('#drawer_field_fld_due')
    await due.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.type('09'); await leave(page)
    await settled(page)
    check('result', await result(page, 'fld_due'), { stored: '2031-01-09', row: '2031-01-09', rejected: 0, conflict: false })
  },
  async 'two arrow-up presses on 5 in the number box: 7 is stored'(page) {
    const qty = page.locator('#drawer_field_fld_qty')
    await qty.focus(); await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); await leave(page)
    await settled(page)
    check('result', await result(page, 'fld_qty'), { stored: 7, row: 7, rejected: 0, conflict: false })
    check('the box', await qty.inputValue(), '7')
  },
  async 'two fields left in a row: both are stored'(page) {
    await page.locator('#drawer_field_fld_name').click(); await page.keyboard.press('End'); await page.keyboard.type('X')
    await page.locator('#drawer_field_fld_note').click(); await page.keyboard.press('End'); await page.keyboard.type('Y'); await leave(page)
    await settled(page)
    check('名称', await result(page, 'fld_name'), { stored: 'alphaX', row: 'alphaX', rejected: 0, conflict: false })
    check('备注', (await result(page, 'fld_note')).stored, 'betaY')
  },
  async 'the day typed, then the year while the first answer comes back: the box is not taken back to the older day, and the date typed is stored'(page) {
    const due = page.locator('#drawer_field_fld_due')
    await due.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.type('15')
    // The answer to the day's first save (2031-01-01) arrives while the year is being typed.
    await page.waitForTimeout(350)
    check('the box after the first answer', await due.inputValue(), '2031-01-15')
    await page.keyboard.type('2032'); await leave(page)
    await settled(page)
    check('result', await result(page, 'fld_due'), { stored: '2032-01-15', row: '2032-01-15', rejected: 0, conflict: false })
    check('the box', await due.inputValue(), '2032-01-15')
  },
}
for (const [name, run] of Object.entries(SCENARIOS)) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage()
  page.on('pageerror', (error) => failures.push(`${name}: page error ${error.message}`))
  await page.goto(URL)
  await page.waitForFunction(() => window.quickDemo?.ready === true && !!document.querySelector('#drawer_field_fld_due'))
  const before = failures.length
  await run(page)
  console.log(`${failures.length === before ? 'PASS' : 'FAIL'}  ${name}`)
  for (const f of failures.slice(before)) console.log(`      ${f}`)
  console.log(`      sent: ${(await page.evaluate(() => window.quickDemo.sent)).join(', ')}`)
  await page.context().close()
}
await browser.close()
if (failures.length) { console.error(`${failures.length} failure(s)`); process.exit(1) }
console.log('DRAWER_QUICK_COMMITS_BROWSER_PASS')
