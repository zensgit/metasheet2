'use strict'

// A FAIL-CLOSED runner for the plugin's hand-rolled `tests.push([name, fn])` suites (S3 follow-up A, register
// R-37).
//
// THE GAP IT CLOSES. Those suites end in `async function main() { …for each test: await fn()… if (failed)
// process.exit(1) } main()`. A test that awaits a promise which can NEVER settle (a lock waiter whose holder is
// gone, a gate nobody opens) with nothing else keeping the event loop alive lets Node simply run out of work:
// `main()` never reaches its `process.exit(1)`, the process ends on its own, and its exit code is 0 — the chain
// (scripts/test-chain.cjs, which reads only the exit code) records a GREEN suite even after earlier tests
// printed FAIL. Seen on the S3 final review: a blocking-lock mutation printed FAIL, then hung, then exited 0.
//
// TWO MECHANISMS, one per way a test can hang:
//   1. THE EXIT SENTINEL — `beforeExit` fires exactly when the loop drains. If the runner has not completed by
//      then, a test (or the runner) is stuck on a promise nothing can settle: `process.exitCode = 1` and one
//      line says so. Covers the "nothing keeps the loop alive" hang, without waiting for any timer.
//   2. THE PER-TEST TIMEOUT — a hang that keeps the loop ALIVE (a leaked interval, a socket, a poller) never
//      drains it, so the sentinel never fires: each test races an UNREF'D timer (`testTimeoutMs`); when it
//      fires the test is a FAIL ("timed out") and the runner moves on. Unref'd, so the timer itself never keeps
//      a hung loop alive and never masks mechanism 1.
// A timed-out test's body cannot be cancelled; the runner's final `process.exit(1)` ends whatever it left.
//
// Output is the suites' existing format (`  <name> OK`, `FAIL: <name>` + stack, `<label> FAILED (<n>)`,
// `<label>: all assertions passed`), so adopting it changes no log a reader greps for.

const DEFAULT_TEST_TIMEOUT_MS = 60 * 1000

class SuiteTestTimeoutError extends Error {
  constructor(name, timeoutMs) {
    super(`test timed out after ${timeoutMs} ms (it never settled): ${name}`)
    this.name = 'SuiteTestTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

/** One test against the per-test timeout. Resolves when `fn` settles in time; rejects with its error or a timeout. */
function runWithTimeout(name, fn, timeoutMs) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new SuiteTestTimeoutError(name, timeoutMs)), timeoutMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
  })
  const body = Promise.resolve().then(() => fn())
  return Promise.race([body, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/**
 * Run `tests` (`[[name, fn], …]`) in order, fail-closed. `label` names the suite in the summary lines.
 * Returns the run's promise (the suites call it last and do not await it).
 */
function runFailClosedSuite(label, tests, { testTimeoutMs = DEFAULT_TEST_TIMEOUT_MS } = {}) {
  if (!Number.isInteger(testTimeoutMs) || testTimeoutMs <= 0) {
    throw new TypeError('runFailClosedSuite: testTimeoutMs must be a positive integer')
  }
  let completed = false
  process.once('beforeExit', () => {
    if (completed) return
    console.error(`${label} FAILED: the event loop drained before every test settled — a test (or the runner) awaited a promise that can never settle`)
    process.exitCode = 1
  })
  return (async () => {
    let failed = 0
    for (const [name, fn] of tests) {
      try {
        await runWithTimeout(name, fn, testTimeoutMs)
        console.log(`  ${name} OK`)
      } catch (error) {
        failed += 1
        console.error(`FAIL: ${name}`)
        console.error(error && error.stack ? error.stack : error)
      }
    }
    completed = true
    if (failed) {
      console.error(`${label} FAILED (${failed})`)
      process.exit(1)
    }
    console.log(`${label}: all assertions passed`)
  })()
}

module.exports = {
  DEFAULT_TEST_TIMEOUT_MS,
  SuiteTestTimeoutError,
  runFailClosedSuite,
}
