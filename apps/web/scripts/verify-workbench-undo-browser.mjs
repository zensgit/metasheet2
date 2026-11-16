// Real-browser check of the workbench-owned undo (src/multitable/utils/workbench-undo.ts) on the real
// record drawer: Chromium's Meta+Z runs the browser's own undo command unless the page prevents it, so
// these scenarios prove the chords never reach it and that restores commit on blur. Synthetic data only.
// Run from apps/web: `npx vite --port 18919 --strictPort` in one shell, then `node scripts/verify-workbench-undo-browser.mjs`.
// Chromium only. One property needs Safari: a restored plain box goes through the browser's editing
// command because Safari saves on blur only an edit the user made, never a value set from script, and
// Chromium saves both. Check the two "leave the field" scenarios by hand in Safari when that path changes.
import { chromium } from '@playwright/test'
const URL = 'http://127.0.0.1:18919/tests/fixtures/workbench-undo-browser-demo.html'
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const browser = await chromium.launch({ headless: true })
const failures = []
const state = (page) => page.evaluate(() => ({
  title: document.querySelector('.meta-record-drawer__title-input').value,
  // (Not rendered while the drawer shows its comments tab.)
  name: document.querySelector('#drawer_field_fld_name')?.value,
  extra: document.querySelector('#drawer_field_fld_extra')?.value,
  rich: document.querySelector('[data-test="rich-longtext-editor"]')?.innerHTML,
  composer: window.undoDemo.draft(),
  outside: document.querySelector('#outside').value,
  grid: { ...window.undoDemo.grid },
  replays: window.undoDemo.replays,
  native: window.undoDemo.native,
}))
const saved = (page) => page.evaluate(() => window.undoDemo.patches.slice())
// Whether the drawer shows the record whose 名称 is `name` within a few seconds (false rather than a timeout).
const shows = (page, name) => page.waitForFunction((n) => document.querySelector('#drawer_field_fld_name')?.value === n, name, { timeout: 3000 }).then(() => true, () => false)
const inEditor = (page) => page.waitForFunction(() => !!document.activeElement?.closest('[data-test="rich-longtext-editor"]'), null, { timeout: 1000 }).then(() => true, () => false)
const leave = (page) => page.locator('#grid-area').click({ position: { x: 5, y: 5 } })
const onPage = (page) => page.evaluate(() => document.activeElement === document.body)
async function openComments(page) {
  await page.evaluate(() => window.undoDemo.openComments())
  await page.locator('.meta-comment-composer textarea').waitFor()
}
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
  async 'type, pause, type, Cmd+Z, leave: the second burst goes; the rest is saved'(page) {
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
  async 'commit with Enter into the date input, Cmd+Z: the grid undo (here it replays the grid\'s last cell edit; in the workbench, the commit)'(page) {
    await page.locator('#drawer_field_fld_note').click(); await page.keyboard.press('End'); await page.keyboard.type('Q'); await page.keyboard.press('Enter'); await page.keyboard.press(`${mod}+z`)
    const s = await state(page); check('grid', s.grid, { undo: 1, redo: 0 }); check('replayed to the server', s.replays, 1)
  },
  async 'title: Enter commits and focus goes to the page; Cmd+Z: the grid undo, never the browser undo'(page) {
    const t = page.locator('.meta-record-drawer__title-input'); await t.click(); await page.keyboard.press('End'); await page.keyboard.type(' X'); await page.keyboard.press('Enter'); await page.waitForTimeout(100)
    check('focus on the page', await page.evaluate(() => document.activeElement === document.body), true)
    await page.keyboard.press(`${mod}+z`)
    const s = await state(page); check('title', s.title, '巡检记录 A X'); check('grid', s.grid, { undo: 1, redo: 0 })
  },
  async 'a rename outside the grid (rail): Enter removes its input and focus goes to the page; Cmd+Z: nothing, never the grid'(page) {
    await page.locator('#rename').click(); await page.keyboard.press('End'); await page.keyboard.type(' X'); await page.keyboard.press('Enter'); await page.waitForTimeout(100)
    check('focus on the page', await page.evaluate(() => document.activeElement === document.body), true)
    await page.keyboard.press(`${mod}+z`); await page.keyboard.press(`${mod}+Shift+z`)
    check('grid', (await state(page)).grid, { undo: 0, redo: 0 })
  },
  async 'title rewritten by the record (grid undo, a record re-render) after its typing was left, Cmd+Z: nothing'(page) {
    const t = page.locator('.meta-record-drawer__title-input'); await t.click(); await page.keyboard.press('End'); await page.keyboard.type(' T')
    await leave(page)
    await page.evaluate(() => window.undoDemo.rewrite('fld_title', 'Server value')); await page.waitForTimeout(150)
    await t.click()
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
    await openComments(page)
    const box = page.locator('.meta-comment-composer textarea'); await box.click(); await page.keyboard.type('please')
    await leave(page); await box.click(); await page.keyboard.press(`${mod}+z`)
    const s = await state(page); check('composer', s.composer, ''); check('grid', s.grid, { undo: 0, redo: 0 })
  },
  async 'comment box: send with Cmd+Enter (the box is disabled while it sends, so focus goes to the page), Cmd+Z: nothing, never the grid'(page) {
    await openComments(page)
    const box = page.locator('.meta-comment-composer textarea'); await box.click(); await page.keyboard.type('sent text'); await page.keyboard.press(`${mod}+Enter`)
    await page.waitForFunction(() => window.undoDemo.draft() === '' && !document.querySelector('.meta-comment-composer textarea').disabled)
    check('focus on the page', await onPage(page), true)
    await page.keyboard.press(`${mod}+z`); await page.keyboard.press(`${mod}+Shift+z`)
    const s = await state(page); check('composer', s.composer, ''); check('grid', s.grid, { undo: 0, redo: 0 })
  },
  async 'comment box: send with the Send button, Cmd+Z while it sends and after: nothing, never the grid'(page) {
    await openComments(page)
    await page.locator('.meta-comment-composer textarea').click(); await page.keyboard.type('sent text')
    await page.locator('.meta-comment-composer__submit').click(); await page.waitForTimeout(50)
    check('focus on the page while it sends', await onPage(page), true)
    await page.keyboard.press(`${mod}+z`)
    await page.waitForFunction(() => window.undoDemo.draft() === '')
    check('focus on the page', await onPage(page), true)
    await page.keyboard.press(`${mod}+z`)
    check('grid', (await state(page)).grid, { undo: 0, redo: 0 })
  },
  async 'own comment: Resolve (its button goes), Cmd+Z: nothing, never the grid'(page) {
    await openComments(page)
    await page.locator('.meta-comments-drawer__resolve').click()
    await page.waitForFunction(() => window.undoDemo.comment().resolved === true)
    check('focus on the page', await onPage(page), true)
    await page.keyboard.press(`${mod}+z`)
    check('grid', (await state(page)).grid, { undo: 0, redo: 0 })
  },
  async 'own comment: Delete (disabled while it deletes, then gone), Cmd+Z: nothing, never the grid'(page) {
    await openComments(page)
    await page.locator('.meta-comments-drawer__reply').last().click()
    await page.waitForFunction(() => window.undoDemo.comment().id === undefined)
    check('focus on the page', await onPage(page), true)
    await page.keyboard.press(`${mod}+z`)
    check('grid', (await state(page)).grid, { undo: 0, redo: 0 })
  },
  async 'a press on the grid, then its Delete selected (disabled once pressed): focus goes to the page; Cmd+Z: nothing, never the grid'(page) {
    await leave(page); await page.locator('#bulk-delete').click(); await page.waitForTimeout(100)
    check('focus on the page', await onPage(page), true)
    await page.keyboard.press(`${mod}+z`); await page.keyboard.press(`${mod}+Shift+z`)
    check('grid', (await state(page)).grid, { undo: 0, redo: 0 })
  },
  async 'the grid footer\'s aggregation select set to none (the footer goes, focus falls to the page): Cmd+Z: nothing, never the grid'(page) {
    const select = page.locator('#foot-select')
    await leave(page); await select.dispatchEvent('mousedown'); await select.focus(); await select.selectOption(''); await page.waitForTimeout(100)
    check('focus on the page', await onPage(page), true)
    await page.keyboard.press(`${mod}+z`)
    check('grid', (await state(page)).grid, { undo: 0, redo: 0 })
  },
  async 'an attachment upload (its input is disabled until the upload ends), Cmd+Z while it uploads: nothing, never the grid; the upload is then saved'(page) {
    const input = page.locator('.meta-record-drawer__field[data-field-id="fld_files"] input[type="file"]')
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), input.click()])
    await chooser.setFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('x') })
    await page.waitForFunction(() => document.querySelector('.meta-record-drawer__field[data-field-id="fld_files"] input[type="file"]').disabled)
    check('focus on the page while it uploads', await onPage(page), true)
    await page.keyboard.press(`${mod}+z`)
    const s = await state(page); check('grid', s.grid, { undo: 0, redo: 0 }); check('replays', s.replays, 0)
    await page.waitForFunction(() => window.undoDemo.patches.some((p) => p.includes('fld_files')))
    check('saved', (await saved(page)).filter((p) => p.includes('fld_files')), ['rec_1:fld_files=att_1'])
  },
  async 'an attachment upload, then a press on the grid and Cmd+Z while it uploads: the grid\'s undo is held, nothing is replayed; once it is saved, Cmd+Z there runs it (here it replays the grid\'s last cell edit; in the workbench, the upload)'(page) {
    const input = page.locator('.meta-record-drawer__field[data-field-id="fld_files"] input[type="file"]')
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), input.click()])
    await chooser.setFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('x') })
    await page.waitForFunction(() => document.querySelector('.meta-record-drawer__field[data-field-id="fld_files"] input[type="file"]').disabled)
    const gridArea = page.locator('#grid-area')
    await gridArea.dispatchEvent('mousedown'); await gridArea.focus()
    await page.keyboard.press(`${mod}+z`)
    let s = await state(page); check('grid while it uploads', s.grid, { undo: 1, redo: 0 }); check('replays while it uploads', s.replays, 0)
    await page.waitForFunction(() => window.undoDemo.patches.some((p) => p.includes('fld_files')))
    await gridArea.focus(); await page.keyboard.press(`${mod}+z`)
    s = await state(page); check('grid after', s.grid, { undo: 2, redo: 0 }); check('replays after', s.replays, 1)
  },
  async 'a press on the drawer\'s details panel itself, Cmd+Z: nothing (not the grid\'s undo), never the browser undo'(page) {
    const panel = page.locator('[role="tabpanel"][id$="-panel-details"]')
    await panel.dispatchEvent('mousedown'); await panel.focus()
    await page.keyboard.press(`${mod}+z`)
    const s = await state(page); check('grid', s.grid, { undo: 0, redo: 0 }); check('replays', s.replays, 0)
  },
  async 'a text box typed in again while its commit is still out: the value the server then accepts does not overwrite the typing, which the next blur saves'(page) {
    const note = page.locator('#drawer_field_fld_note')
    await note.click(); await page.keyboard.press('End'); await page.keyboard.type('X'); await leave(page)
    await note.click(); await page.keyboard.press('End'); await page.keyboard.type('Q')
    // The first commit is accepted now: the record comes back with it.
    await page.evaluate(() => window.undoDemo.rewrite('fld_note', 'betaX')); await page.waitForTimeout(100)
    check('typing kept', await note.inputValue(), 'betaXQ')
    await leave(page)
    check('saved', (await saved(page)).filter((p) => p.includes('fld_note')), ['rec_1:fld_note=betaX', 'rec_1:fld_note=betaXQ'])
  },
  async 'a number box typed in while the record is redrawn (another field\'s value came back): the typing stays, and the number typed is saved'(page) {
    const qty = page.locator('#drawer_field_fld_qty')
    await qty.click(); await page.keyboard.press(`${mod}+a`); await page.keyboard.type('12')
    await page.evaluate(() => window.undoDemo.rewrite('fld_note', 'from elsewhere')); await page.waitForTimeout(100)
    check('typing kept', await qty.inputValue(), '12')
    await page.keyboard.type('3'); await leave(page)
    check('saved', (await saved(page)).filter((p) => p.includes('fld_qty')), ['rec_1:fld_qty=123'])
  },
  async 'a number draft it cannot read ("-"), then the next-record chord: the next record\'s box shows its own value, and a number typed there is saved as typed'(page) {
    await page.evaluate(() => window.undoDemo.setField('rec_2', 'fld_qty', null))
    const qty = page.locator('#drawer_field_fld_qty')
    await qty.click(); await page.keyboard.press(`${mod}+a`); await page.keyboard.type('-')
    await page.keyboard.press(`${mod}+Shift+Period`)
    check('moved to rec_2', await shows(page, 'gamma'), true)
    check('the draft is gone', await qty.evaluate((el) => [el.value, el.validity.badInput]), ['', false])
    await qty.click(); await page.keyboard.type('3'); await leave(page)
    check('saved', (await saved(page)).filter((p) => p.includes('fld_qty')), ['rec_2:fld_qty=3'])
  },
  async 'a date typed part by part while the record is redrawn (the day half-typed, then the redraw, then its last digit): the date typed is saved last, and the box keeps it'(page) {
    const due = page.locator('#drawer_field_fld_due')
    await due.focus(); await page.keyboard.press('ArrowRight')
    await page.keyboard.type('0')
    // the answer to the half-typed day's save: the record comes back without a date
    await page.evaluate(() => window.undoDemo.setField('rec_1', 'fld_due', '')); await page.waitForTimeout(100)
    await page.keyboard.type('9'); await leave(page)
    check('the box', await due.inputValue(), '2031-01-09')
    check('saved last', (await saved(page)).filter((p) => p.includes('fld_due')).at(-1), 'rec_1:fld_due=2031-01-09')
  },
  async 'a date cleared part by part with the keyboard: the empty date is saved'(page) {
    const due = page.locator('#drawer_field_fld_due')
    await due.focus()
    await page.keyboard.press('Backspace'); await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Backspace'); await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Backspace'); await leave(page)
    check('the box', await due.inputValue(), '')
    check('saved last', (await saved(page)).filter((p) => p.includes('fld_due')).at(-1), 'rec_1:fld_due=')
  },
  async 'a negative number typed while the record is redrawn ("-", the redraw, then "3"): -3 is saved'(page) {
    const qty = page.locator('#drawer_field_fld_qty')
    await qty.click(); await page.keyboard.press(`${mod}+a`); await page.keyboard.press('Backspace'); await leave(page)
    // the server took the empty box: the record comes back without a number
    await page.evaluate(() => window.undoDemo.setField('rec_1', 'fld_qty', null)); await page.waitForTimeout(100)
    await qty.click(); await page.keyboard.type('-')
    await page.evaluate(() => window.undoDemo.rewrite('fld_note', 'from elsewhere')); await page.waitForTimeout(100)
    await page.keyboard.type('3'); await leave(page)
    check('saved', (await saved(page)).filter((p) => p.includes('fld_qty')), ['rec_1:fld_qty=null', 'rec_1:fld_qty=-3'])
  },
  async 'a number box holding a draft it cannot read ("-"), left: nothing is saved, the stored number stays'(page) {
    const qty = page.locator('#drawer_field_fld_qty')
    await qty.click(); await page.keyboard.press(`${mod}+a`); await page.keyboard.type('-')
    check('the box reads empty (badInput)', await qty.evaluate((el) => [el.value, el.validity.badInput]), ['', true])
    await leave(page)
    check('saved', (await saved(page)).filter((p) => p.includes('fld_qty')), [])
  },
  async 'rich text, the next record ending in an @-mention: after the chord, typing goes after the mention, not into it'(page) {
    await page.evaluate(() => window.undoDemo.setField('rec_2', 'fld_rich', '<p>hi <span data-mention-id="u_1">@Ann</span></p>'))
    const ed = page.locator('[data-test="rich-longtext-editor"]'); await ed.click(); await page.keyboard.press('End')
    await page.keyboard.press(`${mod}+Shift+Period`)
    check('moved to rec_2', await shows(page, 'gamma'), true)
    await page.keyboard.type('Z')
    check('Z after the mention, the mention unchanged', (await state(page)).rich, '<p>hi <span data-mention-id="u_1" contenteditable="false">@Ann</span>Z</p>')
  },
  async 'an attachment upload, then the drawer\'s next-record button while it uploads: the file is saved to the record it was chosen on, never the next one'(page) {
    const input = page.locator('.meta-record-drawer__field[data-field-id="fld_files"] input[type="file"]')
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), input.click()])
    await chooser.setFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('x') })
    await page.waitForFunction(() => document.querySelector('.meta-record-drawer__field[data-field-id="fld_files"] input[type="file"]').disabled)
    await page.locator('button[aria-label="下一条记录"]').click()
    await page.waitForFunction(() => document.querySelector('#drawer_field_fld_name')?.value === 'gamma')
    await page.waitForFunction(() => window.undoDemo.patches.some((p) => p.includes('fld_files')))
    check('saved', (await saved(page)).filter((p) => p.includes('fld_files')), ['rec_1:fld_files=att_1'])
  },
  async 'rich text: type, then the next-record chord with the caret still in it: the text is saved to the record it was typed on, the caret stays (at the end), and the chord goes on working'(page) {
    const ed = page.locator('[data-test="rich-longtext-editor"]'); await ed.click(); await page.keyboard.press('End'); await page.keyboard.type(' for A')
    await page.keyboard.press(`${mod}+Shift+Period`)
    check('moved to rec_2', await shows(page, 'gamma'), true)
    check('caret back in the editor', await inEditor(page), true)
    check('rec_2 shows its own text', (await state(page)).rich, 'other')
    await page.keyboard.type('Z')
    check('typed at the end', (await state(page)).rich, 'otherZ')
    await page.keyboard.press(`${mod}+Shift+Comma`)
    check('moved back to rec_1', await shows(page, 'alpha'), true)
    await leave(page)
    // Only what was typed is saved: passing through the editor (opening, the moves, leaving) saves nothing.
    check('saved', (await saved(page)).filter((p) => p.includes('fld_rich')), ['rec_1:fld_rich=rich for A', 'rec_2:fld_rich=otherZ'])
  },
  async 'rich text, both records holding the same text: typed on the first, the chord there and back: the next one shows its own text and nothing is saved to it'(page) {
    await page.evaluate(() => window.undoDemo.setField('rec_2', 'fld_rich', 'rich'))
    const ed = page.locator('[data-test="rich-longtext-editor"]'); await ed.click(); await page.keyboard.press('End'); await page.keyboard.type(' for A')
    await page.keyboard.press(`${mod}+Shift+Period`)
    check('moved to rec_2', await shows(page, 'gamma'), true)
    check('rec_2 shows its own text', (await state(page)).rich, 'rich')
    await page.keyboard.press(`${mod}+Shift+Comma`); check('back on rec_1', await shows(page, 'alpha'), true)
    await page.keyboard.press(`${mod}+Shift+Period`); check('on rec_2 again', await shows(page, 'gamma'), true)
    await leave(page)
    check('saved', (await saved(page)).filter((p) => p.includes('fld_rich')), ['rec_1:fld_rich=rich for A'])
  },
  async 'rich text, never filled on either record: typed on the first, the chord there and back: nothing is saved to the next one'(page) {
    await page.evaluate(() => { window.undoDemo.setField('rec_2', 'fld_rich', undefined); window.undoDemo.setField('rec_1', 'fld_rich', undefined) })
    const ed = page.locator('[data-test="rich-longtext-editor"]'); await ed.click(); await page.keyboard.type('for A')
    await page.keyboard.press(`${mod}+Shift+Period`)
    check('moved to rec_2', await shows(page, 'gamma'), true)
    check('rec_2 shows nothing', (await state(page)).rich, '')
    await page.keyboard.press(`${mod}+Shift+Comma`); check('back on rec_1', await shows(page, 'alpha'), true)
    await leave(page)
    check('saved', (await saved(page)).filter((p) => p.includes('fld_rich')), ['rec_1:fld_rich=for A'])
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
