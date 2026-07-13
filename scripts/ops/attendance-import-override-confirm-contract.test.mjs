import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// Contract: the acceptance verify flows must confirm the "override import" modal (确认覆盖导入) that the app
// opens before the commit POST fires, and the selectors they use must match the app's actual modal. Without
// this, clicking "Import" opens the modal, no POST /api/attendance/import/commit ever fires, and the flow
// hits the 60s waitForResponse timeout (the #189 Gate-4 "Playwright Prod" failure, 2026-07-13).

const repoRoot = process.cwd()
const read = (file) => readFileSync(path.join(repoRoot, file), 'utf8')

const productionFlow = read('scripts/verify-attendance-production-flow.mjs')
const fullFlow = read('scripts/verify-attendance-full-flow.mjs')
const attendanceView = read('apps/web/src/views/AttendanceView.vue')

// The three modal hooks the verify scripts drive.
const MODAL = '[data-import-override-confirm]'
const CHECKBOX_WRAP = '[data-import-override-extra-confirm]'
const CONFIRM_SUBMIT = '[data-import-override-confirm-submit]'

test('the app renders the override-confirm modal + its acknowledgement checkbox + confirm-submit control', () => {
  // App side: requestRunImport opens the modal instead of committing when the mode requires confirmation.
  assert.match(attendanceView, /requestRunImport/)
  assert.match(attendanceView, /importOverrideConfirm\.open\s*=\s*true/)
  // The DOM hooks the scripts target must exist on the app modal (cross-check app <-> script).
  assert.ok(attendanceView.includes('data-import-override-confirm'), 'app must mark the modal')
  assert.ok(attendanceView.includes('data-import-override-extra-confirm'), 'app must mark the ack checkbox')
  assert.ok(attendanceView.includes('data-import-override-confirm-submit'), 'app must mark the confirm-submit')
})

for (const [name, raw] of [
  ['production flow', productionFlow],
  ['full flow', fullFlow],
]) {
  test(`${name} defines confirmImportOverrideModalIfPresent using the app's modal hooks`, () => {
    assert.match(raw, /async function confirmImportOverrideModalIfPresent\s*\(/, `${name} must define the helper`)
    const start = raw.indexOf('async function confirmImportOverrideModalIfPresent')
    const body = raw.slice(start, start + 800)
    assert.ok(body.includes(MODAL), `${name} helper must locate ${MODAL}`)
    assert.ok(body.includes(CHECKBOX_WRAP), `${name} helper must check the ack checkbox under ${CHECKBOX_WRAP}`)
    assert.ok(body.includes(CONFIRM_SUBMIT), `${name} helper must click ${CONFIRM_SUBMIT}`)
    assert.match(body, /waitFor\(\{\s*state:\s*'visible'/, `${name} helper must gate on the modal being visible (no-op otherwise)`)
  })
}

test('production flow confirms the override modal between clicking Import and awaiting the commit response', () => {
  const start = productionFlow.indexOf('async function clickImportAndWaitForCommitResponse')
  assert.notEqual(start, -1)
  const end = productionFlow.indexOf('\nasync function', start + 1)
  const body = productionFlow.slice(start, end > start ? end : start + 900)
  const clickIdx = body.indexOf(".click()")
  const confirmIdx = body.indexOf('confirmImportOverrideModalIfPresent(page)')
  const awaitIdx = body.indexOf('await responsePromise')
  assert.ok(clickIdx !== -1 && confirmIdx !== -1 && awaitIdx !== -1, 'all three steps present')
  assert.ok(clickIdx < confirmIdx, 'confirm the modal AFTER clicking Import')
  assert.ok(confirmIdx < awaitIdx, 'confirm the modal BEFORE awaiting the commit response')
})

test('full flow confirms the override modal after clicking the import button (override recovery path)', () => {
  const clickIdx = fullFlow.indexOf('await importButton.click()')
  const confirmIdx = fullFlow.indexOf('confirmImportOverrideModalIfPresent(page)', clickIdx)
  assert.ok(clickIdx !== -1 && confirmIdx !== -1)
  assert.ok(clickIdx < confirmIdx, 'confirm the modal after the import click')
})
