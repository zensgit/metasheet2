#!/usr/bin/env node
/**
 * Fail unless a Vitest 1.6 JSON report passed exactly the expected tests.
 * Pending, todo, failed, skipped, and empty files are failures.
 */
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const expected = Number(process.argv[3])
if (!file || !Number.isInteger(expected) || expected <= 0) {
  process.stderr.write('usage: assert-report.mjs <report.json> <expected-passed>\n')
  process.exit(1)
}

let report
try {
  report = JSON.parse(readFileSync(file, 'utf8'))
} catch (error) {
  process.stderr.write('unreadable vitest report ' + file + ': ' + (error instanceof Error ? error.message : String(error)) + '\n')
  process.exit(1)
}

const counts = {
  numFailedTests: report.numFailedTests,
  numPendingTests: report.numPendingTests,
  numTodoTests: report.numTodoTests,
  numPassedTests: report.numPassedTests,
  numTotalTests: report.numTotalTests,
  success: report.success,
}
const bad = []
if (counts.numFailedTests !== 0) bad.push('failed')
if (counts.numPendingTests !== 0) bad.push('pending')
if (counts.numTodoTests !== 0) bad.push('todo')
if (counts.numPassedTests !== expected) bad.push('passed')
if (counts.numTotalTests !== expected) bad.push('total')
if (counts.success !== true) bad.push('success')
const results = Array.isArray(report.testResults) ? report.testResults : []
if (results.length === 0) bad.push('no-files')
for (const fileResult of results) {
  const assertions = Array.isArray(fileResult.assertionResults) ? fileResult.assertionResults : []
  if (assertions.length === 0) bad.push('empty-file')
  for (const assertion of assertions) {
    if (assertion.status !== 'passed') bad.push(String(assertion.status) + ':' + String(assertion.fullName))
  }
}
if (bad.length > 0) {
  process.stderr.write(JSON.stringify({ file, expected, counts, bad: bad.slice(0, 20) }) + '\n')
  process.exit(1)
}
process.stdout.write(JSON.stringify({ ok: true, file, expected, numPassedTests: expected }) + '\n')
