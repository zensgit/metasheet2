import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractTimezoneBatch, summarize, renderMarkdown, findRunDayConsumers } from './attendance-date-matrix.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = relative => readFileSync(path.join(repoRoot, relative), 'utf8')

test('the batch list is read from the attendance-db timezone step and every file exists', () => {
  const files = extractTimezoneBatch(read('.github/workflows/plugin-tests.yml'))
  assert.ok(files.length > 0)
  assert.ok(files.includes('tests/integration/attendance-business-trip.db.test.ts'))
  for (const file of files) assert.ok(existsSync(path.join(repoRoot, 'packages/core-backend', file)), file)
})

test('the extractor refuses a missing, duplicated or malformed batch', () => {
  const anchor = '          DATABASE_URL=x ATTENDANCE_TEST_DATABASE_URL=x attendance_timezone_ci pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \\'
  const ok = [anchor, '            tests/integration/a.db.test.ts \\', '            --reporter=dot'].join('\n')
  assert.deepEqual(extractTimezoneBatch(ok), ['tests/integration/a.db.test.ts'])
  assert.throws(() => extractTimezoneBatch('nothing'), /ANCHOR_COUNT_0/)
  assert.throws(() => extractTimezoneBatch(ok + '\n' + ok), /ANCHOR_COUNT_2/)
  assert.throws(() => extractTimezoneBatch([anchor, '            --reporter=dot'].join('\n')), /EMPTY/)
  assert.throws(() => extractTimezoneBatch([anchor, '            tests/integration/a.db.test.ts \\', '            tests/integration/a.db.test.ts \\', '            --reporter=dot'].join('\n')), /DUPLICATE/)
  assert.throws(() => extractTimezoneBatch([anchor, '            echo hi', '            --reporter=dot'].join('\n')), /UNEXPECTED_LINE/)
})

test('the workflow runs the extracted list through the date-matrix config, one fresh database per leg', () => {
  const workflow = read('.github/workflows/attendance-date-matrix.yml')
  assert.match(workflow, /node scripts\/ops\/attendance-date-matrix\.mjs list/)
  assert.match(workflow, /--config vitest\.attendance-date-matrix\.config\.ts run/)
  for (const date of ['2026-11-02', '2027-03-15', '2027-04-15', '2027-11-08', 'today']) assert.ok(workflow.includes(`'${date}'`), date)
  assert.match(workflow, /createdb --host=localhost --username=postgres attendance_timezone_ci/)
  assert.doesNotMatch(workflow, /faketime|useFakeTimers/i)
  const config = read('packages/core-backend/vitest.attendance-date-matrix.config.ts')
  assert.match(config, /setup\.attendance-run-date\.ts/)
})

test('summary uses the reporter order (not the command line), counts statuses and stays values-free', () => {
  const core = '/w/packages/core-backend'
  const result = {
    success: false,
    testResults: [
      { name: core + '/tests/integration/b.db.test.ts', startTime: 2000, endTime: 2500, status: 'failed',
        message: 'secret-ish detail', assertionResults: [{ status: 'passed', title: 't1' }, { status: 'failed', title: 't2', failureMessages: ['x'] }] },
      { name: core + '/tests/integration/a.db.test.ts', startTime: 1000, endTime: 1500, status: 'passed',
        assertionResults: [{ status: 'passed', title: 't3' }, { status: 'pending', title: 't4' }, { status: 'skipped', title: 't5' }] },
    ],
  }
  const order = { files: [
    { file: core + '/tests/integration/b.db.test.ts', collectedAt: 1900, runStartTime: 2000, state: 'fail' },
    { file: core + '/tests/integration/a.db.test.ts', collectedAt: 900, runStartTime: 1000, state: 'pass' },
    { file: core + '/tests/integration/d.db.test.ts', collectedAt: 3000, runStartTime: null, state: 'fail' },
  ] }
  const proofLine = JSON.stringify({ overridden: true, expectedDate: '2027-04-15', helperDate: '2027-04-15', punchClockDate: '2027-04-15', tripClockDate: '2027-04-15', realProcessDate: '2026-11-04', effective: true })
  const summary = summarize({
    result, order, proofLines: [proofLine, proofLine], coreBackendDir: core,
    cliFiles: ['tests/integration/b.db.test.ts', 'tests/integration/a.db.test.ts', 'tests/integration/d.db.test.ts', 'tests/integration/c.db.test.ts'],
    runDayConsumers: ['tests/integration/b.db.test.ts'],
    runLabel: '2027-04-15', overrideDate: '2027-04-15', binding: { mergeSha: 'm', prHeadSha: 'h', baseSha: 'b' },
  })
  assert.deepEqual(summary.executionOrder.map(entry => entry.runDayShifted), [false, true, false])
  assert.match(renderMarkdown(summary), /run day follows this leg: 1 of 4 \(tests\/integration\/b\.db\.test\.ts\)/)
  assert.deepEqual(summary.executionOrder.map(entry => entry.file), ['tests/integration/a.db.test.ts', 'tests/integration/b.db.test.ts', 'tests/integration/d.db.test.ts'])
  assert.equal(summary.executionOrder[2].runStartTime, null)
  assert.equal(summary.executionOrder[2].fileStatus, 'unknown')
  assert.equal(summary.orderDiffersFromCli, true)
  assert.deepEqual(summary.totals, { files: 2, filesFailed: 1, filesNotReported: ['tests/integration/c.db.test.ts'], passed: 2, failed: 1, skipped: 2, vitestSuccess: false })
  assert.equal(summary.proof.allEffective, true)
  const text = JSON.stringify(summary) + renderMarkdown(summary)
  for (const leaked of ['secret-ish', 't1', 't2', 'failureMessages']) assert.ok(!text.includes(leaked), leaked)
})

test('missing result, missing order and a failed clock proof are reported as unknown, not filled in', () => {
  const bad = JSON.stringify({ overridden: true, expectedDate: '2027-11-08', helperDate: '2027-11-08', punchClockDate: '2026-11-04', tripClockDate: '2027-11-08', realProcessDate: '2026-11-04', effective: false })
  const summary = summarize({ result: null, order: null, proofLines: [bad], cliFiles: ['tests/integration/a.db.test.ts'], coreBackendDir: '/w', runLabel: '2027-11-08', overrideDate: '2027-11-08', binding: {} })
  assert.equal(summary.resultStatus, 'missing')
  assert.equal(summary.orderStatus, 'missing')
  assert.equal(summary.orderDiffersFromCli, null)
  assert.deepEqual(summary.executionOrder, [])
  assert.equal(summary.totals, null)
  assert.equal(summary.proof.allEffective, false)
  const text = renderMarkdown(summary)
  assert.match(text, /MISSING \(counts unknown\)/)
  assert.match(text, /execution order: MISSING/)
  assert.equal(summarize({ result: null, order: null, proofLines: [], cliFiles: [], coreBackendDir: '/w', runLabel: 'today', overrideDate: null, binding: {} }).proof.allEffective, false)
})

test('the order reporter is wired into the matrix run', () => {
  const workflow = read('.github/workflows/attendance-date-matrix.yml')
  assert.match(workflow, /--reporter=\.\/tests\/reporters\/attendance-date-matrix-order\.ts/)
  assert.match(workflow, /ATTENDANCE_DATE_MATRIX_ORDER_FILE/)
  assert.match(workflow, /--order /)
})

test('only files importing the run-day helper are counted as shifted', () => {
  const sources = {
    'tests/integration/x.db.test.ts': "import { attendanceTestRunNow } from '../utils/attendance-test-run-date'\n",
    'tests/integration/y.db.test.ts': "const today = new Date()\n// attendance-test-run-date mentioned in a comment only\n",
  }
  assert.deepEqual(findRunDayConsumers(Object.keys(sources), file => sources[file]), ['tests/integration/x.db.test.ts'])
  const files = extractTimezoneBatch(read('.github/workflows/plugin-tests.yml'))
  const consumers = findRunDayConsumers(files, file => read(path.join('packages/core-backend', file)))
  assert.deepEqual(consumers, ['tests/integration/attendance-business-trip.db.test.ts'])
})
