import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { ensureAttendanceHistoryFiltersOpen } from './verify-attendance-production-flow.mjs'

function stubPage({ open = false, clickOpens = true, missingError } = {}) {
  const calls = []
  const element = { open }
  const summary = {
    async waitFor(options) {
      assert.equal(options.state, 'visible')
      calls.push('summary-visible')
    },
    async click() {
      calls.push('summary-click')
      if (clickOpens) element.open = true
    },
  }
  const details = {
    async waitFor(options) {
      assert.equal(options.state, 'visible')
      calls.push('details-visible')
      if (missingError) throw missingError
    },
    async evaluate(callback) {
      calls.push('read-open')
      return callback(element)
    },
    locator(selector) {
      assert.equal(selector, 'summary')
      return summary
    },
  }
  return {
    calls,
    element,
    locator(selector) {
      assert.equal(selector, 'details[data-attendance-history-filters]')
      return details
    },
  }
}

test('closed history filters open via visible summary before proceeding', async () => {
  const page = stubPage()
  await ensureAttendanceHistoryFiltersOpen(page)
  assert.equal(page.element.open, true)
  assert.deepEqual(page.calls, [
    'details-visible', 'read-open', 'summary-visible', 'summary-click', 'read-open',
  ])
})

test('already-open history filters are not toggled closed', async () => {
  const page = stubPage({ open: true })
  await ensureAttendanceHistoryFiltersOpen(page)
  assert.equal(page.element.open, true)
  assert.deepEqual(page.calls, ['details-visible', 'read-open'])
})

test('ineffective summary click fails closed with a fixed values-free code', async () => {
  const page = stubPage({ clickOpens: false })
  await assert.rejects(ensureAttendanceHistoryFiltersOpen(page), {
    name: 'Error',
    message: 'ATTENDANCE_HISTORY_FILTERS_NOT_OPEN',
  })
  assert.equal(page.element.open, false)
  assert.deepEqual(page.calls, [
    'details-visible', 'read-open', 'summary-visible', 'summary-click', 'read-open',
  ])
})

test('missing history details propagate the locator failure', async () => {
  const missingError = new Error('HISTORY_DETAILS_MISSING')
  const page = stubPage({ missingError })
  await assert.rejects(ensureAttendanceHistoryFiltersOpen(page), (error) => error === missingError)
  assert.deepEqual(page.calls, ['details-visible'])
})

test('production flow opens filters after Overview and before filling history fields', async () => {
  const source = await readFile(new URL('./verify-attendance-production-flow.mjs', import.meta.url), 'utf8')
  assert.match(source, /logInfo\('Returning to Overview'\)\s+await buttonByNames\(page, uiText\.overview\)\.click\(\)\s+await ensureAttendanceLoaded\(page\)\s+await ensureAttendanceHistoryFiltersOpen\(page\)\s+await page\.locator\('#attendance-from-date'\)\.fill\(workDate\)\s+await page\.locator\('#attendance-to-date'\)\.fill\(workDate\)\s+if \(userId\) \{\s+await page\.locator\('#attendance-user-id'\)\.fill\(userId\)/)
})

test('main invocation is guarded by pathToFileURL for safe helper imports', async () => {
  const source = await readFile(new URL('./verify-attendance-production-flow.mjs', import.meta.url), 'utf8')
  assert.match(source, /import \{ pathToFileURL \} from 'node:url'/)
  assert.match(source, /if \(process\.argv\[1\] && import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href\) \{\s+run\(\)\.catch\(/)
  assert.equal(source.match(/run\(\)\.catch\(/g)?.length, 1)
})
