import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-p4-regression-gate.mjs')

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'dingtalk-p4-regression-gate-'))
}

function runScript(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

test('dingtalk-p4-regression-gate writes an ops plan without executing checks', () => {
  const outputDir = makeTmpDir()

  try {
    const result = runScript([
      '--profile', 'ops',
      '--plan-only',
      '--output-dir', outputDir,
    ])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const summaryPath = path.join(outputDir, 'summary.json')
    const markdownPath = path.join(outputDir, 'summary.md')
    assert.equal(existsSync(summaryPath), true)
    assert.equal(existsSync(markdownPath), true)

    const summary = readJson(summaryPath)
    assert.equal(summary.tool, 'dingtalk-p4-regression-gate')
    assert.equal(summary.profile, 'ops')
    assert.equal(summary.planOnly, true)
    assert.equal(summary.overallStatus, 'plan_only')
    assert.equal(summary.totals.total, 10)
    assert.equal(summary.totals.skipped, 10)
    assert.ok(summary.checks.every((check) => check.status === 'skipped'))
    assert.ok(summary.checks.some((check) => check.command.includes('dingtalk-p4-smoke-session.test.mjs')))

    const markdown = readFileSync(markdownPath, 'utf8')
    assert.match(markdown, /DingTalk P4 Regression Gate/)
    assert.match(markdown, /ops-smoke-session/)
    assert.match(markdown, /plan_only/)
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-regression-gate product plan covers org destination catalog checks', () => {
  const outputDir = makeTmpDir()

  try {
    const result = runScript([
      '--profile', 'product',
      '--plan-only',
      '--output-dir', outputDir,
    ])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const summary = readJson(path.join(outputDir, 'summary.json'))
    assert.equal(summary.profile, 'product')
    assert.equal(summary.planOnly, true)
    assert.equal(summary.overallStatus, 'plan_only')
    assert.equal(summary.totals.total, 13)
    assert.ok(summary.checks.every((check) => check.status === 'skipped'))
    assert.ok(summary.checks.some((check) => check.command.includes('dingtalk-group-destination-routes.api.test.ts')))
    assert.ok(summary.checks.some((check) => check.command.includes('automation-v1.test.ts')))
    assert.ok(summary.checks.some((check) => check.command.includes('multitable-automation-manager.spec.ts')))
    assert.ok(summary.checks.some((check) => check.command.includes('multitable-automation-rule-editor.spec.ts')))
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-regression-gate executes fast selftest checks and captures logs', () => {
  const outputDir = makeTmpDir()

  try {
    const result = runScript([
      '--profile', 'selftest',
      '--output-dir', outputDir,
    ])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const summary = readJson(path.join(outputDir, 'summary.json'))
    assert.equal(summary.overallStatus, 'pass')
    assert.equal(summary.totals.passed, 1)
    assert.equal(summary.checks[0].status, 'pass')
    assert.equal(existsSync(path.join(repoRoot, summary.checks[0].stdoutLog)), true)

    const stdout = readFileSync(path.join(repoRoot, summary.checks[0].stdoutLog), 'utf8')
    assert.match(stdout, /selftest ok/)
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-regression-gate redacts secret-like output in logs and summaries', () => {
  const outputDir = makeTmpDir()

  try {
    const result = runScript([
      '--profile', 'selftest-secret',
      '--output-dir', outputDir,
    ])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const summaryText = readFileSync(path.join(outputDir, 'summary.json'), 'utf8')
    const summary = JSON.parse(summaryText)
    const stdout = readFileSync(path.join(repoRoot, summary.checks[0].stdoutLog), 'utf8')

    assert.doesNotMatch(summaryText, /0123456789abcdef0123456789abcdef/)
    assert.doesNotMatch(summaryText, /abcdefghijklmnopqrstuvwxyz1234567890/)
    assert.doesNotMatch(summaryText, /SECabcdefghijklmnop12345678/)
    assert.doesNotMatch(summaryText, /public-0123456789/)
    assert.match(stdout, /Bearer <redacted>/)
    assert.match(stdout, /access_token=<redacted>/)
    assert.match(stdout, /SEC<redacted>/)
    assert.match(stdout, /publicToken=<redacted>/)
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-regression-gate rejects invalid public profiles', () => {
  const result = runScript(['--profile', 'bad'])

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /--profile must be one of: ops, product, all/)
})
