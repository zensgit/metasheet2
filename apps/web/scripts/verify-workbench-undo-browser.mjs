// Real-browser check of the workbench-owned undo (src/multitable/utils/workbench-undo.ts) on the real
// record drawer: Chromium's Meta+Z runs the browser's own undo command unless the page prevents it, so
// these scenarios prove the chords never reach it and that restores commit on blur. Synthetic data only.
// Run from apps/web: `npx vite --port 18919 --strictPort` in one shell, then `node scripts/verify-workbench-undo-browser.mjs`.
import { chromium } from '@playwright/test'
const URL = 'http://127.0.0.1:18919/tests/fixtures/workbench-undo-browser-demo.html'
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const browser = await chromium.launch({ headless: true })
const failures = []
const state = (page) => page.evaluate(() => ({
  title: document.querySelector('.meta-record-drawer__title-input').value,
  name: document.querySelector('#drawer_field_fld_name').value,
  extra: document.querySelector('#drawer_field_fld_extra').value,
  rich: document.querySelector('[data-test="rich-longtext-editor"]').innerHTML,
  composer: window.undoDemo.draft(),
  outside: document.querySelector('#outside').value,
  grid: { ...window.undoDemo.grid },
  native: window.undoDemo.native,
}))
const saved = (page) => page.evaluate(() => window.undoDemo.patches.slice())
const leave = (page) => page.locator('#grid-area').click({ position: { x: 5, y: 5 } })
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
const SCENARIOS = {
  async 'typing in a field, Cmd+Z: the typing goes, nothing reaches the grid or the server'(page) {
    await page.locator('#drawer_field_fld_name').click(); await page.keyboard.press('End'); await page.keyboard.type('XYZ'); await page.keyboard.press(`${mod}+z`)
    const s = await state(page); check('value', s.name, 'alpha'); check('grid', s.grid, { undo: 0, redo: 0 })
    await leave(page); check('saved', (await saved(page)).filter((p) => p.includes('fld_name')), [])
  },
  async 'type, pause, type, Cmd+Z, leave: the second burst goes; the rest is saved (Safari-safe restore)'(page) {
    await page.locator('#drawer_field_fld_name').click(); await page.keyboard.press('End'); await page.keyboard.type('X'); await page.waitForTimeout(1200); await page.keyboard.type('Y'); await page.keyboard.press(`${mod}+z`)
    check('value', (await state(page)).name, 'alphaX')
    await leave(page); check('saved', (await saved(page)).filter((p) => p.includes('fld_name')), ['rec_1:fld_name=alphaX'])
  },
  async 'undo then redo, leave: the redone value is saved'(page) {
    await page.locator('#drawer_field_fld_name').click(); await page.keyboard.press('End'); await page.keyboard.type('XYZ'); await page.keyboard.press(`${mod}+z`); await page.keyboard.press(`${mod}+Shift+z`)
    check('value', (await state(page)).name, 'alphaXYZ')
    await leave(page); check('saved', (await saved(page)).filter((p) => p.includes('fld_name')), ['rec_1:fld_name=alphaXYZ'])
  },
  async 'commit with Enter, Cmd+Z from the next text field: nothing (a text box never hands the chord on)'(page) {
    await page.locator('#drawer_field_fld_name').click(); await page.keyboard.press('End'); await page.keyboard.type('XYZ'); await page.keyboard.press('Enter'); await page.keyboard.press(`${mod}+z`)
    const s = await state(page); check('value', s.name, 'alphaXYZ'); check('grid', s.grid, { undo: 0, redo: 0 })
  },
  async 'commit with Enter into the date input, Cmd+Z: the grid undo (undoes the commit)'(page) {
    await page.locator('#drawer_field_fld_note').click(); await page.keyboard.press('End'); await page.keyboard.type('Q'); await page.keyboard.press('Enter'); await page.keyboard.press(`${mod}+z`)
    check('grid', (await state(page)).grid, { undo: 1, redo: 0 })
  },
  async 'title: Enter commits and focus goes to the page; Cmd+Z: the grid undo, never the browser undo'(page) {
    const t = page.locator('.meta-record-drawer__title-input'); await t.click(); await page.keyboard.press('End'); await page.keyboard.type(' X'); await page.keyboard.press('Enter'); await page.waitForTimeout(100)
    check('focus on the page', await page.evaluate(() => document.activeElement === document.body), true)
    await page.keyboard.press(`${mod}+z`)
    const s = await state(page); check('title', s.title, '巡检记录 A X'); check('grid', s.grid, { undo: 1, redo: 0 })
  },
  async 'title rewritten by the record (grid undo, a record re-render), Cmd+Z: nothing'(page) {
    const t = page.locator('.meta-record-drawer__title-input'); await t.click(); await page.keyboard.press('End'); await page.keyboard.type(' T')
    await page.evaluate(() => window.undoDemo.rewrite('fld_title', 'Server value')); await page.waitForTimeout(150)
    await page.keyboard.press(`${mod}+z`); await page.keyboard.press(`${mod}+z`)
    const s = await state(page); check('title', s.title, 'Server value'); check('grid', s.grid, { undo: 0, redo: 0 })
  },
  async 'rich text: type, Cmd+Enter (commit, focus stays), type, Cmd+Z: back to the committed text, then nothing'(page) {
    const ed = page.locator('[data-test="rich-longtext-editor"]'); await ed.click(); await page.keyboard.press('End'); await page.keyboard.type(' hello')
    await page.keyboard.press(`${mod}+Enter`); await page.keyboard.type(' world'); await page.keyboard.press(`${mod}+z`)
    check('after undo', (await state(page)).rich, 'rich hello')
    await page.keyboard.press(`${mod}+z`)
    const s = await state(page); check('after a second undo', s.rich, 'rich hello'); check('grid', s.grid, { undo: 0, redo: 0 })
  },
  async 'rich text toolbar Bold, Cmd+Z: the bold goes'(page) {
    await page.locator('[data-test="rich-longtext-editor"]').click(); await page.keyboard.press(`${mod}+a`)
    await page.locator('[data-command="bold"]').dispatchEvent('mousedown'); await page.waitForTimeout(100)
    check('bold', (await state(page)).rich, '<b>rich</b>')
    await page.keyboard.press(`${mod}+z`)
    const s = await state(page); check('unbold', s.rich, 'rich'); check('grid', s.grid, { undo: 0, redo: 0 })
  },
  async 'comment box: type, click away, click back, Cmd+Z: the typing goes'(page) {
    const box = page.locator('.meta-comment-composer textarea'); await box.click(); await page.keyboard.type('please')
    await leave(page); await box.click(); await page.keyboard.press(`${mod}+z`)
    const s = await state(page); check('composer', s.composer, ''); check('grid', s.grid, { undo: 0, redo: 0 })
  },
  async 'comment box: send (the box clears), Cmd+Z: nothing'(page) {
    const box = page.locator('.meta-comment-composer textarea'); await box.click(); await page.keyboard.type('sent text'); await page.keyboard.press(`${mod}+Enter`); await page.waitForTimeout(100)
    check('cleared', (await state(page)).composer, '')
    await page.keyboard.press(`${mod}+z`)
    const s = await state(page); check('composer', s.composer, ''); check('grid', s.grid, { undo: 0, redo: 0 })
  },
  async 'a box outside the workbench (a popover): its own typing goes, then nothing; the page itself after it: nothing'(page) {
    await page.locator('#outside').click(); await page.keyboard.press('End'); await page.keyboard.type('X'); await page.keyboard.press(`${mod}+z`)
    check('restored', (await state(page)).outside, 'filter')
    await page.keyboard.press(`${mod}+z`)
    await page.evaluate(() => document.activeElement.blur()); await page.keyboard.press(`${mod}+z`)
    check('grid', (await state(page)).grid, { undo: 0, redo: 0 })
  },
  async 'a control that stops every key: Cmd+Z is still handled (the grid undo), never the browser undo'(page) {
    await page.locator('#drawer_field_fld_name').click(); await page.keyboard.press('End'); await page.keyboard.type('Q'); await page.keyboard.press('Enter')
    await page.evaluate(() => document.querySelector('#stopper').focus()); await page.keyboard.press(`${mod}+z`)
    const s = await state(page); check('name', s.name, 'alphaQ'); check('grid', s.grid, { undo: 1, redo: 0 })
  },
  async 'the drawer moves to another record with equal content: record A typing never comes into record B'(page) {
    const extra = page.locator('#drawer_field_fld_extra'); await extra.click(); await page.keyboard.type('secret for A'); await page.keyboard.press(`${mod}+a`); await page.keyboard.press('Backspace')
    await page.evaluate(() => window.undoDemo.switchTo('rec_2')); await page.waitForTimeout(150)
    await extra.click(); await page.keyboard.press(`${mod}+z`)
    check('value', (await state(page)).extra, '')
    await page.keyboard.press(`${mod}+Shift+z`); check('after redo', (await state(page)).extra, '')
    await leave(page); check('saved', (await saved(page)).filter((p) => p.includes('secret')), [])
  },
}
for (const [name, run] of Object.entries(SCENARIOS)) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage()
  page.on('pageerror', (error) => failures.push(`${name}: page error ${error.message}`))
  await page.goto(URL)
  await page.waitForFunction(() => window.undoDemo?.ready === true && !!document.querySelector('[data-test="rich-longtext-editor"]'))
  const before = failures.length
  await run(page)
  const native = await page.evaluate(() => window.undoDemo.native)
  if (native !== 0) failures.push(`${name}: the browser's own undo ran ${native} time(s)`)
  console.log(`${failures.length === before ? 'PASS' : 'FAIL'}  ${name}`)
  for (const f of failures.slice(before)) console.log(`      ${f}`)
  await page.context().close()
}
await browser.close()
if (failures.length) { console.error(`${failures.length} failure(s)`); process.exit(1) }
console.log('WORKBENCH_UNDO_BROWSER_PASS')
