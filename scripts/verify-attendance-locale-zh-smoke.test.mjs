import assert from 'node:assert/strict'
import test from 'node:test'

import { expandHistoryFilters } from './verify-attendance-locale-zh-smoke.mjs'

// GATE-5097 P2-2(b): the pre-existing coverage for expandHistoryFilters() (in
// scripts/ops/attendance-locale-zh-workflow-contract.test.mjs) only asserts the SOURCE TEXT of
// this file — it proves the function is called in the right order, not that it does what it
// claims. The reviewer's mutation M4 (neuter the click so the disclosure never actually opens,
// while leaving every pinned string intact) survived that pin: 5/5 pass. These tests drive the
// real exported function against a stub Playwright-shaped `page`, asserting the DISCLOSURE STATE
// changes — not text — so M4 cannot survive here.

/**
 * A minimal stand-in for the <details data-attendance-history-filters> DOM node
 * expandHistoryFilters() reads/mutates via page.locator(...).evaluate(...).
 */
function createHistoryFiltersNode({ open = false, summaryText = '日期 / 组织 / 用户筛选' } = {}) {
  return {
    open,
    summaryText,
    hasAttribute(name) {
      return name === 'open' ? this.open : false
    },
  }
}

/**
 * A stub `page` implementing just enough of Playwright's Locator API surface for
 * expandHistoryFilters(): page.locator(selector) -> { waitFor, evaluate, locator(selector) },
 * and a nested summary locator -> { first, textContent, click }. `opensOnClick` lets a test
 * simulate a summary click that does NOT actually open the disclosure (covers the "click didn't
 * work" throw path).
 */
function createStubPage(node, { opensOnClick = true } = {}) {
  const calls = { waitFor: 0, click: 0 }
  const summaryLocator = {
    first() {
      return summaryLocator
    },
    async textContent() {
      return node.summaryText
    },
    async click() {
      calls.click += 1
      if (opensOnClick) node.open = true
    },
  }
  const detailsLocator = {
    async waitFor() {
      calls.waitFor += 1
    },
    async evaluate(fn) {
      return fn(node)
    },
    locator(selector) {
      assert.equal(selector, 'summary')
      return summaryLocator
    },
  }
  const page = {
    locator(selector) {
      assert.equal(selector, '[data-attendance-history-filters]')
      return detailsLocator
    },
  }
  return { page, calls }
}

test('expandHistoryFilters opens a closed disclosure with the correct zh label', async () => {
  const node = createHistoryFiltersNode({ open: false })
  const { page, calls } = createStubPage(node)

  await expandHistoryFilters(page, 1000)

  assert.equal(node.open, true, 'the stub <details> node must end up open')
  assert.equal(calls.click, 1, 'must click the summary exactly once')
})

test('expandHistoryFilters is a no-op (does not click) when the disclosure is already open', async () => {
  const node = createHistoryFiltersNode({ open: true })
  const { page, calls } = createStubPage(node)

  await expandHistoryFilters(page, 1000)

  assert.equal(node.open, true)
  assert.equal(calls.click, 0, 'must not click an already-open disclosure')
})

// GATE-5097 M4: the reviewer's mutation left the summary click a no-op — the disclosure state
// never flips to open even though the click handler runs. This is exactly that scenario,
// expressed as a fixture instead of a source edit: expandHistoryFilters must throw, not return
// successfully having done nothing.
test('expandHistoryFilters throws if clicking the summary does not actually open the disclosure (kills M4)', async () => {
  const node = createHistoryFiltersNode({ open: false })
  const { page } = createStubPage(node, { opensOnClick: false })

  await assert.rejects(
    () => expandHistoryFilters(page, 1000),
    /Expected \[data-attendance-history-filters\] to be open after clicking its summary/,
  )
  assert.equal(node.open, false)
})

// GATE-5097 NIT-3: a zh-locale smoke must not open the disclosure by data attribute alone while
// staying blind to its accessible name regressing to English or empty.
test('expandHistoryFilters throws if the summary label is not the zh label (kills a silent en/blank regression)', async () => {
  const node = createHistoryFiltersNode({ open: false, summaryText: 'Date / Org / User filters' })
  const { page, calls } = createStubPage(node)

  await assert.rejects(
    () => expandHistoryFilters(page, 1000),
    /Expected the history-filters <summary> to carry its zh label/,
  )
  assert.equal(calls.click, 0, 'must fail before ever clicking a mislabelled summary')
  assert.equal(node.open, false)
})

test('expandHistoryFilters throws on an empty summary label', async () => {
  const node = createHistoryFiltersNode({ open: false, summaryText: '' })
  const { page } = createStubPage(node)

  await assert.rejects(() => expandHistoryFilters(page, 1000))
})
