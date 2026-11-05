// Zero-skip assertion over a vitest JSON report (R-71 gate 10, owner decisions f1 + g1).
//
// Usage: node scripts/ops/vitest-zero-skip.mjs <vitest-json-report> <expected-file-count>
//
// A real-DB step that runs whole files under EXPECT_DB=1 must never go green with a skipped, todo or
// missing case. The vitest exit code alone does not prove that: in vitest 1.x the JSON report counts an
// it.skip as "passed" in numPassedTests and not at all in numPendingTests (which only counts tests still
// in the "run" state), so the only reliable signal for a skip is each assertion's own status. This check
// therefore refuses unless the summary is clean AND every assertion of every expected file passed.
//
// Output is values-free: a failure prints only fixed `VITEST_ZERO_SKIP: <key>` lines (no file names,
// test titles, messages or counts from the report) and exits 1.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const ZERO_KEYS = Object.freeze([
  ['numFailedTests', 'FAILED_TESTS'],
  ['numPendingTests', 'PENDING_TESTS'],
  ['numTodoTests', 'TODO_TESTS'],
  ['numFailedTestSuites', 'FAILED_SUITES'],
  ['numPendingTestSuites', 'PENDING_SUITES'],
])

const ASSERTION_KEYS = Object.freeze({
  failed: 'ASSERTION_FAILED',
  skipped: 'ASSERTION_SKIPPED',
  pending: 'ASSERTION_PENDING',
  todo: 'ASSERTION_TODO',
  disabled: 'ASSERTION_DISABLED',
})

const count = (value) => Number.isSafeInteger(value) && value >= 0

/** Returns the sorted, de-duplicated failure keys; an empty array means the report is zero-skip clean. */
export function vitestZeroSkipFailures(report, expectedFiles) {
  const failures = new Set()
  if (!Number.isSafeInteger(expectedFiles) || expectedFiles < 1) return ['USAGE']
  if (!report || typeof report !== 'object' || Array.isArray(report)) return ['REPORT_NOT_OBJECT']
  if (report.success !== true) failures.add('SUCCESS_NOT_TRUE')
  for (const [field, key] of ZERO_KEYS) {
    if (report[field] !== 0) failures.add(key)
  }
  if (!count(report.numTotalTests) || !count(report.numPassedTests) || report.numTotalTests !== report.numPassedTests) {
    failures.add('TOTAL_NOT_PASSED')
  }
  if (!(report.numTotalTests > 0)) failures.add('ZERO_TESTS')
  const files = report.testResults
  if (!Array.isArray(files)) {
    failures.add('FILES_MISSING')
  } else {
    if (files.length !== expectedFiles) failures.add('FILE_COUNT')
    const names = new Set()
    let assertions = 0
    for (const file of files) {
      if (!file || typeof file !== 'object') {
        failures.add('FILE_INVALID')
        continue
      }
      if (typeof file.name !== 'string' || names.has(file.name)) failures.add('FILE_DUPLICATE')
      names.add(file.name)
      if (file.status !== 'passed') failures.add('FILE_NOT_PASSED')
      if (!Array.isArray(file.assertionResults) || file.assertionResults.length === 0) {
        failures.add('FILE_NO_ASSERTIONS')
        continue
      }
      for (const assertion of file.assertionResults) {
        assertions += 1
        const status = assertion && typeof assertion === 'object' ? assertion.status : undefined
        if (status !== 'passed') failures.add(ASSERTION_KEYS[status] ?? 'ASSERTION_NOT_PASSED')
      }
    }
    if (count(report.numTotalTests) && assertions !== report.numTotalTests) failures.add('ASSERTION_COUNT')
  }
  return [...failures].sort()
}

function main(argv) {
  const [reportPath, expected, ...rest] = argv
  const expectedFiles = /^[1-9][0-9]{0,5}$/.test(expected ?? '') ? Number(expected) : NaN
  if (!reportPath || rest.length > 0 || !Number.isSafeInteger(expectedFiles)) return ['USAGE']
  let text
  try {
    text = readFileSync(reportPath, 'utf8')
  } catch {
    return ['REPORT_UNREADABLE']
  }
  let report
  try {
    report = JSON.parse(text)
  } catch {
    return ['REPORT_INVALID_JSON']
  }
  const failures = vitestZeroSkipFailures(report, expectedFiles)
  if (failures.length === 0) {
    console.log(`VITEST_ZERO_SKIP: ok (${expectedFiles} files, ${report.numTotalTests} tests, all passed, none skipped or todo)`)
  }
  return failures
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failures = main(process.argv.slice(2))
  for (const key of failures) console.error(`VITEST_ZERO_SKIP: ${key}`)
  if (failures.length > 0) process.exitCode = 1
}
