#!/usr/bin/env node
// #6721 date matrix helper (.github/workflows/attendance-date-matrix.yml).
//
//   list       print the attendance-db timezone batch file list, read from
//              .github/workflows/plugin-tests.yml (the one source; no second copy)
//   summarize  turn the vitest JSON result (counts), the order reporter output (actual
//              execution order) and the clock proof lines into a values-free summary:
//              actual order, per-file and total passed / failed / skipped, clock proof,
//              and the commit the run is bound to.
//
// Output is values-free: repository-relative file names, ISO timestamps, counts,
// dates and commit SHAs only. No test names, messages or fixture data.
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BATCH_ANCHOR = /attendance_timezone_ci pnpm --filter @metasheet\/core-backend exec vitest --config vitest\.integration\.config\.ts run \\$/
const BATCH_FILE = /^\s+(tests\/integration\/[A-Za-z0-9._-]+\.ts) \\$/
const BATCH_END = /^\s+--reporter=dot$/

export function extractTimezoneBatch(workflowText) {
  const lines = workflowText.split('\n')
  const anchors = lines.flatMap((line, index) => (BATCH_ANCHOR.test(line) ? [index] : []))
  if (anchors.length !== 1) throw new Error(`TIMEZONE_BATCH_ANCHOR_COUNT_${anchors.length}`)
  const files = []
  for (let index = anchors[0] + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (BATCH_END.test(line)) {
      if (files.length === 0) throw new Error('TIMEZONE_BATCH_EMPTY')
      if (new Set(files).size !== files.length) throw new Error('TIMEZONE_BATCH_DUPLICATE')
      return files
    }
    const match = BATCH_FILE.exec(line)
    if (!match) throw new Error('TIMEZONE_BATCH_UNEXPECTED_LINE')
    files.push(match[1])
  }
  throw new Error('TIMEZONE_BATCH_UNTERMINATED')
}

function toRelative(name, coreBackendDir) {
  const relative = path.relative(coreBackendDir, name)
  return relative.split(path.sep).join('/')
}

const iso = value => (Number.isFinite(value) ? new Date(value).toISOString() : null)

function countAssertions(file) {
  const counts = { passed: 0, failed: 0, skipped: 0 }
  for (const assertion of file.assertionResults || []) {
    if (assertion.status === 'passed') counts.passed += 1
    else if (assertion.status === 'failed') counts.failed += 1
    else counts.skipped += 1
  }
  return counts
}

// result: vitest JSON reporter output (counts). order: the order reporter output
// (actual execution order). Either may be null; a missing input is reported as
// unknown, never filled in from the command line.
// A batch file's run day moves with the leg only when it derives that day from the
// helper. The setup proof runs for every file, so it alone does not say which files
// were shifted; this static scan does (import of the helper module, no execution).
export const RUN_DAY_HELPER_IMPORT = /from ['"][./]*(?:\.\.\/)*utils\/attendance-test-run-date['"]/
export function findRunDayConsumers(cliFiles, readSource) {
  return cliFiles.filter(file => RUN_DAY_HELPER_IMPORT.test(readSource(file)))
}

export function summarize({ result, order, proofLines, cliFiles, runDayConsumers = [], runLabel, overrideDate, binding, coreBackendDir }) {
  const shifted = new Set(runDayConsumers)
  const proofs = proofLines.map(line => JSON.parse(line))
  const distinct = key => [...new Set(proofs.map(entry => entry[key]))]
  const proof = {
    lines: proofs.length,
    allEffective: proofs.length > 0 && proofs.every(entry => entry.effective === true),
    overridden: distinct('overridden'),
    expectedDates: distinct('expectedDate'),
    punchClockDates: distinct('punchClockDate'),
    tripClockDates: distinct('tripClockDate'),
    realProcessDates: distinct('realProcessDate'),
  }
  const counts = new Map()
  for (const file of result?.testResults || []) {
    counts.set(toRelative(file.name, coreBackendDir), { fileStatus: file.status, ...countAssertions(file) })
  }
  const executionOrder = (order?.files || [])
    .map(entry => ({ ...entry, file: toRelative(entry.file, coreBackendDir) }))
    .sort((a, b) => (a.collectedAt ?? Infinity) - (b.collectedAt ?? Infinity) || (a.runStartTime ?? Infinity) - (b.runStartTime ?? Infinity))
    .map((entry, index) => ({
      position: index + 1,
      file: entry.file,
      collectedAt: iso(entry.collectedAt),
      runStartTime: iso(entry.runStartTime),
      state: entry.state,
      runDayShifted: shifted.has(entry.file),
      ...(counts.get(entry.file) || { fileStatus: 'unknown', passed: null, failed: null, skipped: null }),
    }))
  const reported = new Set([...counts.keys(), ...executionOrder.map(entry => entry.file)])
  const values = [...counts.values()]
  const totals = result ? {
    files: values.length,
    filesFailed: values.filter(entry => entry.fileStatus === 'failed').length,
    filesNotReported: cliFiles.filter(file => !reported.has(file)),
    passed: values.reduce((sum, entry) => sum + entry.passed, 0),
    failed: values.reduce((sum, entry) => sum + entry.failed, 0),
    skipped: values.reduce((sum, entry) => sum + entry.skipped, 0),
    vitestSuccess: result.success === true,
  } : null
  return {
    runLabel, overrideDate, binding, proof, cliOrder: cliFiles, runDayConsumers: [...shifted],
    resultStatus: result ? 'present' : 'missing',
    orderStatus: order ? 'present' : 'missing',
    orderDiffersFromCli: order ? executionOrder.map(entry => entry.file).join('\n') !== cliFiles.join('\n') : null,
    executionOrder, totals,
  }
}

export function renderMarkdown(summary) {
  const out = [`### Attendance date matrix — ${summary.runLabel}`, '']
  out.push(`- override date: ${summary.overrideDate ?? 'none (real day)'}`)
  out.push(`- bound commit (merge ref): ${summary.binding.mergeSha || 'unknown'}; PR head: ${summary.binding.prHeadSha || 'unknown'}; base: ${summary.binding.baseSha || 'unknown'}`)
  out.push(`- clock proof: ${summary.proof.lines} file(s), all effective = ${summary.proof.allEffective}; clocks read ${summary.proof.punchClockDates.join(', ') || 'unknown'} / ${summary.proof.tripClockDates.join(', ') || 'unknown'}; real process date ${summary.proof.realProcessDates.join(', ') || 'unknown'}`)
  out.push(`- files whose run day follows this leg: ${summary.runDayConsumers.length} of ${summary.cliOrder.length} (${summary.runDayConsumers.join(', ') || 'none'}); the rest derive run days from the real clock or use literal instants, so on this leg they run on the real day`)
  if (summary.totals) {
    const t = summary.totals
    out.push(`- totals: passed ${t.passed}, failed ${t.failed}, skipped ${t.skipped}; files ${t.files}, files failed ${t.filesFailed}, files not reported ${t.filesNotReported.length}`)
  } else {
    out.push('- vitest JSON result: MISSING (counts unknown)')
  }
  if (summary.orderStatus !== 'present') {
    out.push('- execution order: MISSING (unknown; command-line order is not used as a substitute)')
    return out.join('\n') + '\n'
  }
  out.push(`- execution order differs from command-line order: ${summary.orderDiffersFromCli}`)
  out.push('', '| # | file (actual order) | run day shifted | collected (UTC) | run start (UTC) | file status | passed | failed | skipped |', '|---|---|---|---|---|---|---|---|---|')
  for (const entry of summary.executionOrder) {
    const cell = value => (value === null || value === undefined ? 'unknown' : value)
    out.push(`| ${entry.position} | ${entry.file} | ${entry.runDayShifted ? 'yes' : 'no'} | ${cell(entry.collectedAt)} | ${cell(entry.runStartTime)} | ${cell(entry.fileStatus)} | ${cell(entry.passed)} | ${cell(entry.failed)} | ${cell(entry.skipped)} |`)
  }
  return out.join('\n') + '\n'
}

function argValue(args, name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

function main(argv) {
  const [command, ...args] = argv
  const workflowPath = path.join(repoRoot, '.github/workflows/plugin-tests.yml')
  const cliFiles = extractTimezoneBatch(readFileSync(workflowPath, 'utf8'))
  const coreBackendDir = path.join(repoRoot, 'packages/core-backend')
  if (command === 'list') {
    for (const file of cliFiles) {
      if (!existsSync(path.join(coreBackendDir, file))) throw new Error('TIMEZONE_BATCH_FILE_MISSING')
    }
    process.stdout.write(cliFiles.join('\n') + '\n')
    return
  }
  if (command === 'summarize') {
    const resultPath = argValue(args, '--result')
    const orderPath = argValue(args, '--order')
    const proofPath = argValue(args, '--proof')
    const outPath = argValue(args, '--out')
    if (!resultPath || !orderPath || !proofPath || !outPath) throw new Error('USAGE: summarize --result <json> --order <json> --proof <jsonl> --out <json>')
    const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : null
    const order = existsSync(orderPath) ? JSON.parse(readFileSync(orderPath, 'utf8')) : null
    const proofLines = existsSync(proofPath) ? readFileSync(proofPath, 'utf8').split('\n').filter(Boolean) : []
    const summary = summarize({
      result, order, proofLines, cliFiles, coreBackendDir,
      runDayConsumers: findRunDayConsumers(cliFiles, file => readFileSync(path.join(coreBackendDir, file), 'utf8')),
      runLabel: process.env.MATRIX_RUN_LABEL || 'unknown',
      overrideDate: process.env.ATTENDANCE_TEST_RUN_DATE || null,
      binding: {
        mergeSha: process.env.GITHUB_SHA || null,
        prHeadSha: process.env.MATRIX_PR_HEAD_SHA || null,
        baseSha: process.env.MATRIX_PR_BASE_SHA || null,
        runId: process.env.GITHUB_RUN_ID || null,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
      },
    })
    writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n')
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderMarkdown(summary))
    process.stdout.write(renderMarkdown(summary))
    return
  }
  throw new Error('USAGE: attendance-date-matrix.mjs list|summarize')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
