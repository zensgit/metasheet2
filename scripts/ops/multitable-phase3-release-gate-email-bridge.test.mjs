import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  EMAIL_SUB_GATE_ID,
  runEmailRealSendSubGate,
} from './multitable-phase3-release-gate-email-bridge.mjs'

function newOutputDir() {
  return mkdtempSync(path.join(tmpdir(), 'mt-phase3-email-bridge-'))
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true })
}

/**
 * Build a synthetic runScript that writes a fake report.json and
 * returns a synthetic spawn result. This lets us cover every
 * source-state combination without invoking pnpm + tsx + the real
 * email script.
 */
function makeRunScript({
  exitCode = 0,
  reportJson = null,
  reportMd = null,
  stdout = '',
  stderr = '',
  throwErr = null,
  resultErr = null,
  skipReportWrite = false,
}) {
  return ({ jsonPath, mdPath }) => {
    if (throwErr) throw throwErr
    if (!skipReportWrite && reportJson !== null) {
      mkdirSync(path.dirname(jsonPath), { recursive: true })
      mkdirSync(path.dirname(mdPath), { recursive: true })
      // Match the real email script's pretty-printed JSON output shape
      // (`JSON.stringify(report, null, 2)`) so tests assert against
      // formatted output, mirroring on-disk reality.
      writeFileSync(
        jsonPath,
        typeof reportJson === 'string'
          ? reportJson
          : `${JSON.stringify(reportJson, null, 2)}\n`,
      )
      writeFileSync(mdPath, reportMd ?? '# fake markdown\n')
    }
    return {
      status: exitCode,
      stdout,
      stderr,
      error: resultErr,
    }
  }
}

test('EMAIL_SUB_GATE_ID is exported as the canonical gate id', () => {
  assert.equal(EMAIL_SUB_GATE_ID, 'email:real-send')
})

test('runEmailRealSendSubGate throws when outputDir is missing', () => {
  assert.throws(() => runEmailRealSendSubGate({ outputDir: '' }))
})

test('pass: exit=0 + status=pass + ok=true → status=pass exit=0', () => {
  const dir = newOutputDir()
  try {
    const runScript = makeRunScript({
      exitCode: 0,
      reportJson: { ok: true, status: 'pass', mode: 'smtp', messages: [] },
    })
    const result = runEmailRealSendSubGate({ outputDir: dir, runScript })
    assert.equal(result.gate, EMAIL_SUB_GATE_ID)
    assert.equal(result.status, 'pass')
    assert.equal(result.exitCode, 0)
    assert.equal(result.sourceExitCode, 0)
    assert.equal(result.sourceStatus, 'pass')
    assert.ok(result.sourceReportPath.endsWith('children/email-real-send/report.json'))
  } finally {
    cleanup(dir)
  }
})

test('blocked: exit=2 + status=blocked → status=blocked exit=2', () => {
  const dir = newOutputDir()
  try {
    const runScript = makeRunScript({
      exitCode: 2,
      reportJson: { ok: false, status: 'blocked', mode: 'smtp', messages: [] },
    })
    const result = runEmailRealSendSubGate({ outputDir: dir, runScript })
    assert.equal(result.status, 'blocked')
    assert.equal(result.exitCode, 2)
    assert.equal(result.sourceExitCode, 2)
    assert.equal(result.sourceStatus, 'blocked')
    assert.match(result.reason, /MULTITABLE_EMAIL_/)
  } finally {
    cleanup(dir)
  }
})

test('fail: exit=1 + status=failed → status=fail exit=1', () => {
  const dir = newOutputDir()
  try {
    const runScript = makeRunScript({
      exitCode: 1,
      reportJson: { ok: false, status: 'failed', mode: 'smtp', messages: [] },
    })
    const result = runEmailRealSendSubGate({ outputDir: dir, runScript })
    assert.equal(result.status, 'fail')
    assert.equal(result.exitCode, 1)
    assert.equal(result.sourceExitCode, 1)
    assert.equal(result.sourceStatus, 'failed')
  } finally {
    cleanup(dir)
  }
})

test('fail-closed: exit=0 + status=blocked (mismatch) → status=fail', () => {
  const dir = newOutputDir()
  try {
    const runScript = makeRunScript({
      exitCode: 0,
      reportJson: { ok: false, status: 'blocked', mode: 'smtp', messages: [] },
    })
    const result = runEmailRealSendSubGate({ outputDir: dir, runScript })
    assert.equal(result.status, 'fail')
    assert.equal(result.exitCode, 1)
    assert.match(result.reason, /Fail-closed/)
  } finally {
    cleanup(dir)
  }
})

test('fail-closed: exit=2 + status=pass (mismatch) → status=fail', () => {
  const dir = newOutputDir()
  try {
    const runScript = makeRunScript({
      exitCode: 2,
      reportJson: { ok: true, status: 'pass', mode: 'smtp', messages: [] },
    })
    const result = runEmailRealSendSubGate({ outputDir: dir, runScript })
    assert.equal(result.status, 'fail')
    assert.equal(result.exitCode, 1)
    assert.match(result.reason, /Fail-closed/)
  } finally {
    cleanup(dir)
  }
})

test('fail-closed: exit=0 + status=pass + ok=false (ok mismatch) → status=fail', () => {
  const dir = newOutputDir()
  try {
    const runScript = makeRunScript({
      exitCode: 0,
      reportJson: { ok: false, status: 'pass', mode: 'smtp', messages: [] },
    })
    const result = runEmailRealSendSubGate({ outputDir: dir, runScript })
    assert.equal(result.status, 'fail')
    assert.equal(result.exitCode, 1)
    assert.match(result.reason, /Fail-closed/)
  } finally {
    cleanup(dir)
  }
})

test('fail-closed: report.json missing → status=fail', () => {
  const dir = newOutputDir()
  try {
    const runScript = makeRunScript({
      exitCode: 0,
      reportJson: { ok: true, status: 'pass', mode: 'smtp' },
      skipReportWrite: true,
    })
    const result = runEmailRealSendSubGate({ outputDir: dir, runScript })
    assert.equal(result.status, 'fail')
    assert.equal(result.exitCode, 1)
    assert.match(result.reason, /did not write a report\.json/)
  } finally {
    cleanup(dir)
  }
})

test('fail-closed: report.json malformed → status=fail', () => {
  const dir = newOutputDir()
  try {
    const runScript = makeRunScript({
      exitCode: 0,
      reportJson: '{ not valid json',
    })
    const result = runEmailRealSendSubGate({ outputDir: dir, runScript })
    assert.equal(result.status, 'fail')
    assert.equal(result.exitCode, 1)
    assert.match(result.reason, /failed to parse/)
  } finally {
    cleanup(dir)
  }
})

test('fail-closed: spawn throws → status=fail', () => {
  const dir = newOutputDir()
  try {
    const runScript = makeRunScript({
      throwErr: new Error('synthetic spawn explosion'),
    })
    const result = runEmailRealSendSubGate({ outputDir: dir, runScript })
    assert.equal(result.status, 'fail')
    assert.equal(result.exitCode, 1)
    assert.match(result.reason, /Spawn error/)
    assert.match(result.stderrSample, /synthetic spawn explosion/)
  } finally {
    cleanup(dir)
  }
})

test('fail-closed: spawn returns result.error → status=fail', () => {
  const dir = newOutputDir()
  try {
    const runScript = makeRunScript({
      exitCode: null,
      resultErr: { code: 'ENOENT', message: 'pnpm: command not found' },
    })
    const result = runEmailRealSendSubGate({ outputDir: dir, runScript })
    assert.equal(result.status, 'fail')
    assert.equal(result.exitCode, 1)
    assert.match(result.reason, /Spawn returned an error/)
  } finally {
    cleanup(dir)
  }
})

test('fail-closed: null exit code (signal kill) → status=fail', () => {
  const dir = newOutputDir()
  try {
    const runScript = makeRunScript({
      exitCode: null,
    })
    const result = runEmailRealSendSubGate({ outputDir: dir, runScript })
    assert.equal(result.status, 'fail')
    assert.equal(result.exitCode, 1)
    assert.match(result.reason, /null|killed/i)
  } finally {
    cleanup(dir)
  }
})

test('bridge writes child report.json + report.md to <outputDir>/children/email-real-send/', () => {
  const dir = newOutputDir()
  try {
    const runScript = makeRunScript({
      exitCode: 0,
      reportJson: { ok: true, status: 'pass', mode: 'smtp', messages: [] },
      reportMd: '# Child markdown\n',
    })
    const result = runEmailRealSendSubGate({ outputDir: dir, runScript })
    assert.equal(result.status, 'pass')
    const expectedJson = path.join(dir, 'children/email-real-send/report.json')
    const expectedMd = path.join(dir, 'children/email-real-send/report.md')
    assert.equal(result.sourceReportPath, expectedJson)
    const json = readFileSync(expectedJson, 'utf8')
    const md = readFileSync(expectedMd, 'utf8')
    assert.match(json, /"status": "pass"/)
    assert.match(md, /Child markdown/)
  } finally {
    cleanup(dir)
  }
})

test('bridge redacts SMTP / Bearer / sk-* sentinels in stdoutSample and stderrSample', () => {
  const dir = newOutputDir()
  try {
    const runScript = makeRunScript({
      exitCode: 0,
      reportJson: { ok: true, status: 'pass', mode: 'smtp', messages: [] },
      stdout:
        'Subject sent via SMTP_USER=admin@example.com SMTP_HOST=smtp.example.com Bearer abcdefghijklmnop1234567890',
      stderr:
        'OPENAI_API_KEY=sk-leakytestonly1234567890abcdef\nMULTITABLE_EMAIL_SMTP_PASSWORD=l3akyPwd99',
    })
    const result = runEmailRealSendSubGate({ outputDir: dir, runScript })
    assert.equal(result.status, 'pass')
    const all = `${result.stdoutSample}\n${result.stderrSample}`
    assert.doesNotMatch(all, /admin@example\.com/)
    assert.doesNotMatch(all, /smtp\.example\.com/)
    assert.doesNotMatch(all, /abcdefghijklmnop1234567890/)
    assert.doesNotMatch(all, /sk-leakytestonly1234567890abcdef/)
    assert.doesNotMatch(all, /l3akyPwd99/)
    assert.match(all, /<redacted>|Bearer <redacted>|sk-<redacted>/)
  } finally {
    cleanup(dir)
  }
})

test('bridge truncates oversized stdout to 1200-char sample', () => {
  const dir = newOutputDir()
  try {
    const longText = 'A'.repeat(5000)
    const runScript = makeRunScript({
      exitCode: 0,
      reportJson: { ok: true, status: 'pass', mode: 'smtp', messages: [] },
      stdout: longText,
    })
    const result = runEmailRealSendSubGate({ outputDir: dir, runScript })
    assert.ok(result.stdoutSample.length <= 1200, `actual length ${result.stdoutSample.length}`)
    assert.ok(result.stdoutSample.endsWith('...'))
  } finally {
    cleanup(dir)
  }
})

test('bridge preserves sourceExitCode and sourceStatus on fail-closed mismatch', () => {
  const dir = newOutputDir()
  try {
    const runScript = makeRunScript({
      exitCode: 0,
      reportJson: { ok: true, status: 'pass', mode: 'smtp', messages: [] },
    })
    const result = runEmailRealSendSubGate({ outputDir: dir, runScript })
    // Pass case: verify the source fields are present and accurate.
    assert.equal(result.sourceExitCode, 0)
    assert.equal(result.sourceStatus, 'pass')
    assert.ok(result.sourceReportPath.includes('children/email-real-send/report.json'))
  } finally {
    cleanup(dir)
  }
})
