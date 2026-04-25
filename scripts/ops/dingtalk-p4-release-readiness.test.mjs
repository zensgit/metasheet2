import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-p4-release-readiness.mjs')
const SMOKE_SESSION_SCRIPT_ENV = 'DINGTALK_P4_RELEASE_READINESS_SMOKE_SESSION_SCRIPT'

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'dingtalk-p4-release-readiness-'))
}

function runScript(args, options = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(options.env ?? {}),
    },
  })
}

function runScriptWithSelftest(args, options = {}) {
  return runScript(args, {
    ...options,
    env: {
      ...(options.env ?? {}),
      DINGTALK_P4_RELEASE_READINESS_ALLOW_SELFTEST: '1',
    },
  })
}

function writeEnv(file, overrides = {}) {
  const values = {
    DINGTALK_P4_API_BASE: 'http://142.171.239.56:8900',
    DINGTALK_P4_WEB_BASE: 'http://142.171.239.56:8081',
    DINGTALK_P4_AUTH_TOKEN: 'secret-admin-token',
    DINGTALK_P4_GROUP_A_WEBHOOK: 'https://oapi.dingtalk.com/robot/send?access_token=robot-secret-a&timestamp=1690000000000&sign=robot-sign-a',
    DINGTALK_P4_GROUP_B_WEBHOOK: 'https://oapi.dingtalk.com/robot/send?access_token=robot-secret-b',
    DINGTALK_P4_GROUP_A_SECRET: 'SECabcdefghijklmnop12345678',
    DINGTALK_P4_GROUP_B_SECRET: '',
    DINGTALK_P4_ALLOWED_USER_IDS: 'user_authorized',
    DINGTALK_P4_ALLOWED_MEMBER_GROUP_IDS: '',
    DINGTALK_P4_PERSON_USER_IDS: 'user_person_bound',
    DINGTALK_P4_AUTHORIZED_USER_ID: '',
    DINGTALK_P4_UNAUTHORIZED_USER_ID: 'user_unauthorized',
    DINGTALK_P4_NO_EMAIL_DINGTALK_EXTERNAL_ID: 'dt_no_email_001',
    ...overrides,
  }
  const content = Object.entries(values)
    .map(([key, value]) => `${key}="${String(value).replaceAll('"', '\\"')}"`)
    .join('\n')
  writeFileSync(file, `${content}\n`, { encoding: 'utf8', mode: 0o600 })
  chmodSync(file, 0o600)
}

function readSummary(outputDir) {
  return JSON.parse(readFileSync(path.join(outputDir, 'release-readiness-summary.json'), 'utf8'))
}

function writeSmokeSessionStub(scriptFile, { exitCode = 0 } = {}) {
  writeFileSync(scriptFile, `#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const outputDir = args[args.indexOf('--output-dir') + 1]
if (!outputDir) {
  console.error('missing --output-dir')
  process.exit(2)
}
fs.mkdirSync(outputDir, { recursive: true })
fs.writeFileSync(path.join(outputDir, 'session-summary.json'), JSON.stringify({
  sessionPhase: 'bootstrap',
  overallStatus: ${JSON.stringify(exitCode === 0 ? 'manual_pending' : 'fail')},
  finalStrictStatus: ${JSON.stringify(exitCode === 0 ? 'pending' : 'fail')},
}, null, 2) + '\\n')
fs.writeFileSync(path.join(outputDir, 'session-summary.md'), '# session\\n')
fs.writeFileSync(path.join(outputDir, 'smoke-status.json'), JSON.stringify({
  overallStatus: ${JSON.stringify(exitCode === 0 ? 'manual_pending' : 'fail')},
  remoteSmokePhase: ${JSON.stringify(exitCode === 0 ? 'manual_pending' : 'fail')},
  remoteSmokeTodos: {
    total: 8,
    completed: 4,
    remaining: ${JSON.stringify(exitCode === 0 ? 4 : 8)},
  },
  executionPlan: {
    currentFocus: {
      phaseLabel: 'Validate protected form access',
      checkId: 'authorized-user-submit',
      todo: 'Remote smoke: verify an authorized user can open and submit',
      nextAction: 'capture real DingTalk evidence and record authorized-user-submit',
    },
  },
}, null, 2) + '\\n')
fs.writeFileSync(path.join(outputDir, 'smoke-status.md'), '# status\\n')
fs.writeFileSync(path.join(outputDir, 'smoke-todo.md'), '# todo\\n')
if (process.env.FAKE_SMOKE_MARKER) {
  fs.mkdirSync(path.dirname(process.env.FAKE_SMOKE_MARKER), { recursive: true })
  fs.writeFileSync(process.env.FAKE_SMOKE_MARKER, 'ran\\n')
}
console.log('fake smoke session ran')
process.exit(${exitCode})
`, 'utf8')
}

function writeSmokeSessionEnvProbeStub(scriptFile) {
  writeFileSync(scriptFile, `#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const outputDir = args[args.indexOf('--output-dir') + 1]
fs.mkdirSync(outputDir, { recursive: true })
const leakedEnv = process.env.DINGTALK_P4_AUTH_TOKEN || process.env.DINGTALK_P4_GROUP_A_WEBHOOK || ''
fs.writeFileSync(path.join(outputDir, 'session-summary.json'), JSON.stringify({
  sessionPhase: 'bootstrap',
  overallStatus: leakedEnv ? 'fail' : 'manual_pending',
  finalStrictStatus: 'pending',
  leakedEnv,
}, null, 2) + '\\n')
fs.writeFileSync(path.join(outputDir, 'session-summary.md'), '# session\\n')
fs.writeFileSync(path.join(outputDir, 'smoke-status.json'), JSON.stringify({
  overallStatus: leakedEnv ? 'fail' : 'manual_pending',
  remoteSmokePhase: leakedEnv ? 'fail' : 'manual_pending',
}, null, 2) + '\\n')
fs.writeFileSync(path.join(outputDir, 'smoke-status.md'), '# status\\n')
fs.writeFileSync(path.join(outputDir, 'smoke-todo.md'), '# todo\\n')
`, 'utf8')
}

function writeSmokeSessionNoSummaryStub(scriptFile) {
  writeFileSync(scriptFile, `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
const outputDir = args[args.indexOf('--output-dir') + 1]
fs.mkdirSync(outputDir, { recursive: true })
console.log('fake smoke session exited without summary')
`, 'utf8')
}

test('dingtalk-p4-release-readiness fails when private env readiness fails even if regression passes', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'dingtalk-p4.env')
  const outputDir = path.join(tmpDir, 'readiness')

  try {
    writeEnv(envFile, {
      DINGTALK_P4_AUTH_TOKEN: '',
      DINGTALK_P4_GROUP_B_WEBHOOK: '',
      DINGTALK_P4_UNAUTHORIZED_USER_ID: '',
      DINGTALK_P4_NO_EMAIL_DINGTALK_EXTERNAL_ID: '',
    })

    const result = runScriptWithSelftest([
      '--p4-env-file', envFile,
      '--regression-profile', 'selftest',
      '--output-dir', outputDir,
    ])

    assert.equal(result.status, 1)
    const summaryText = readFileSync(path.join(outputDir, 'release-readiness-summary.json'), 'utf8')
    assert.doesNotMatch(summaryText, /secret-admin-token/)
    assert.doesNotMatch(summaryText, /robot-secret-a/)
    assert.match(summaryText, /access_token=<redacted>/)

    const summary = JSON.parse(summaryText)
    assert.equal(summary.overallStatus, 'fail')
    assert.equal(summary.gates.find((gate) => gate.id === 'env-readiness').status, 'fail')
    assert.equal(summary.gates.find((gate) => gate.id === 'regression-gate').status, 'pass')
    assert.ok(summary.gates.find((gate) => gate.id === 'env-readiness').details.failedChecks.includes('dingtalk_p4_auth_token'))
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-release-readiness passes with complete env and passing regression', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'dingtalk-p4.env')
  const outputDir = path.join(tmpDir, 'readiness')

  try {
    writeEnv(envFile)

    const result = runScriptWithSelftest([
      '--p4-env-file', envFile,
      '--regression-profile', 'selftest',
      '--output-dir', outputDir,
    ])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const summary = readSummary(outputDir)
    assert.equal(summary.overallStatus, 'pass')
    assert.equal(summary.gates.every((gate) => gate.status === 'pass'), true)
    const markdown = readFileSync(path.join(outputDir, 'release-readiness-summary.md'), 'utf8')
    assert.match(markdown, /dingtalk-p4-smoke-session\.mjs/)
    assert.match(markdown, /--require-manual-targets/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-release-readiness planned smoke command respects configured output and timeout', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'dingtalk-p4.env')
  const outputDir = path.join(tmpDir, 'readiness')
  const smokeOutputDir = path.join(tmpDir, 'custom-smoke-session')

  try {
    writeEnv(envFile)

    const result = runScriptWithSelftest([
      '--p4-env-file', envFile,
      '--regression-profile', 'selftest',
      '--smoke-output-dir', smokeOutputDir,
      '--smoke-timeout-ms', '12345',
      '--output-dir', outputDir,
    ])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const summary = readSummary(outputDir)
    assert.equal(summary.overallStatus, 'pass')
    assert.equal(summary.plannedSmokeSession.outputDir.endsWith('custom-smoke-session'), true)
    assert.equal(summary.plannedSmokeSession.timeoutMs, 12345)
    assert.match(summary.plannedSmokeSession.command, /custom-smoke-session/)
    assert.match(summary.plannedSmokeSession.command, /--timeout-ms 12345/)

    const markdown = readFileSync(path.join(outputDir, 'release-readiness-summary.md'), 'utf8')
    assert.match(markdown, /custom-smoke-session/)
    assert.match(markdown, /--timeout-ms 12345/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-release-readiness reports manual_pending when regression is plan-only', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'dingtalk-p4.env')
  const outputDir = path.join(tmpDir, 'readiness')

  try {
    writeEnv(envFile)

    const result = runScriptWithSelftest([
      '--p4-env-file', envFile,
      '--regression-profile', 'selftest',
      '--regression-plan-only',
      '--output-dir', outputDir,
    ])

    assert.equal(result.status, 1)
    const summary = readSummary(outputDir)
    assert.equal(summary.overallStatus, 'manual_pending')
    assert.equal(summary.gates.find((gate) => gate.id === 'regression-gate').status, 'skipped')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-release-readiness allow-failures keeps reports inspectable with zero exit', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'dingtalk-p4.env')
  const outputDir = path.join(tmpDir, 'readiness')

  try {
    writeEnv(envFile, { DINGTALK_P4_AUTH_TOKEN: '' })

    const result = runScriptWithSelftest([
      '--p4-env-file', envFile,
      '--regression-profile', 'selftest',
      '--allow-failures',
      '--output-dir', outputDir,
    ])

    assert.equal(result.status, 0)
    assert.equal(readSummary(outputDir).overallStatus, 'fail')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-release-readiness reports manual_pending after automatically launching a bootstrap smoke session', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'dingtalk-p4.env')
  const outputDir = path.join(tmpDir, 'readiness')
  const stubPath = path.join(tmpDir, 'fake-smoke-session.mjs')

  try {
    writeEnv(envFile)
    writeSmokeSessionStub(stubPath)

    const result = runScriptWithSelftest([
      '--p4-env-file', envFile,
      '--regression-profile', 'selftest',
      '--run-smoke-session',
      '--smoke-output-dir', path.join(tmpDir, 'session'),
      '--output-dir', outputDir,
    ], {
      env: {
        [SMOKE_SESSION_SCRIPT_ENV]: stubPath,
      },
    })

    assert.equal(result.status, 1)
    const summary = readSummary(outputDir)
    assert.equal(summary.overallStatus, 'manual_pending')
    assert.equal(summary.smokeSession.status, 'manual_pending')
    assert.equal(summary.smokeSession.overallStatus, 'manual_pending')
    assert.equal(summary.smokeSession.remoteSmokePhase, 'manual_pending')
    assert.equal(summary.smokeSession.remoteSmokeTodos.remaining, 4)
    assert.equal(summary.smokeSession.currentFocus.checkId, 'authorized-user-submit')
    assert.equal(summary.smokeSession.sessionSummaryJson.endsWith('session-summary.json'), true)
    assert.equal(existsSync(path.join(outputDir, 'smoke-session.stdout.log')), true)
    const markdown = readFileSync(path.join(outputDir, 'release-readiness-summary.md'), 'utf8')
    assert.match(markdown, /## Smoke Session/)
    assert.match(markdown, /Remote smoke phase: \*\*manual_pending\*\*/)
    assert.match(markdown, /Current focus: `authorized-user-submit`/)
    assert.match(markdown, /started automatically/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-release-readiness launches smoke-session with env-file inputs isolated from process env', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'dingtalk-p4.env')
  const outputDir = path.join(tmpDir, 'readiness')
  const stubPath = path.join(tmpDir, 'fake-smoke-session-env-probe.mjs')

  try {
    writeEnv(envFile)
    writeSmokeSessionEnvProbeStub(stubPath)

    const result = runScriptWithSelftest([
      '--p4-env-file', envFile,
      '--regression-profile', 'selftest',
      '--run-smoke-session',
      '--smoke-output-dir', path.join(tmpDir, 'session'),
      '--output-dir', outputDir,
    ], {
      env: {
        [SMOKE_SESSION_SCRIPT_ENV]: stubPath,
        DINGTALK_P4_AUTH_TOKEN: 'parent-env-token-must-not-reach-smoke-session',
        DINGTALK_P4_GROUP_A_WEBHOOK: 'https://oapi.dingtalk.com/robot/send?access_token=parent-env-token',
      },
    })

    assert.equal(result.status, 1)
    const summary = readSummary(outputDir)
    assert.equal(summary.overallStatus, 'manual_pending')
    assert.equal(summary.smokeSession.status, 'manual_pending')
    assert.equal(summary.smokeSession.overallStatus, 'manual_pending')
    const sessionSummary = JSON.parse(readFileSync(path.join(tmpDir, 'session/session-summary.json'), 'utf8'))
    assert.equal(sessionSummary.leakedEnv, '')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-release-readiness fails if smoke-session exits without a valid summary', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'dingtalk-p4.env')
  const outputDir = path.join(tmpDir, 'readiness')
  const stubPath = path.join(tmpDir, 'fake-smoke-session-no-summary.mjs')

  try {
    writeEnv(envFile)
    writeSmokeSessionNoSummaryStub(stubPath)

    const result = runScriptWithSelftest([
      '--p4-env-file', envFile,
      '--regression-profile', 'selftest',
      '--run-smoke-session',
      '--smoke-output-dir', path.join(tmpDir, 'session'),
      '--output-dir', outputDir,
    ], {
      env: {
        [SMOKE_SESSION_SCRIPT_ENV]: stubPath,
      },
    })

    assert.equal(result.status, 1)
    const summary = readSummary(outputDir)
    assert.equal(summary.overallStatus, 'fail')
    assert.equal(summary.smokeSession.status, 'fail')
    assert.equal(summary.smokeSession.reason, 'missing_session_summary')
    assert.equal(summary.smokeSession.sessionSummaryJson, null)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-release-readiness blocks smoke-session launch when readiness fails', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'dingtalk-p4.env')
  const outputDir = path.join(tmpDir, 'readiness')
  const stubPath = path.join(tmpDir, 'fake-smoke-session.mjs')
  const markerPath = path.join(tmpDir, 'marker.txt')

  try {
    writeEnv(envFile, { DINGTALK_P4_AUTH_TOKEN: '' })
    writeSmokeSessionStub(stubPath)

    const result = runScriptWithSelftest([
      '--p4-env-file', envFile,
      '--regression-profile', 'selftest',
      '--run-smoke-session',
      '--smoke-output-dir', path.join(tmpDir, 'session'),
      '--output-dir', outputDir,
    ], {
      env: {
        [SMOKE_SESSION_SCRIPT_ENV]: stubPath,
        FAKE_SMOKE_MARKER: markerPath,
      },
    })

    assert.equal(result.status, 1)
    const summary = readSummary(outputDir)
    assert.equal(summary.overallStatus, 'fail')
    assert.equal(summary.smokeSession.status, 'blocked')
    assert.equal(summary.smokeSession.reason, 'release_readiness_failed')
    assert.equal(existsSync(markerPath), false)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-release-readiness fails when smoke-session exits non-zero', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'dingtalk-p4.env')
  const outputDir = path.join(tmpDir, 'readiness')
  const stubPath = path.join(tmpDir, 'fake-smoke-session-fail.mjs')

  try {
    writeEnv(envFile)
    writeSmokeSessionStub(stubPath, { exitCode: 1 })

    const result = runScriptWithSelftest([
      '--p4-env-file', envFile,
      '--regression-profile', 'selftest',
      '--run-smoke-session',
      '--smoke-output-dir', path.join(tmpDir, 'session'),
      '--output-dir', outputDir,
      '--allow-failures',
    ], {
      env: {
        [SMOKE_SESSION_SCRIPT_ENV]: stubPath,
      },
    })

    assert.equal(result.status, 0)
    const summary = readSummary(outputDir)
    assert.equal(summary.overallStatus, 'fail')
    assert.equal(summary.smokeSession.status, 'fail')
    assert.equal(summary.smokeSession.overallStatus, 'fail')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-release-readiness rejects invalid public regression profile', () => {
  const result = runScript(['--regression-profile', 'bad'])

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /--regression-profile must be one of: ops, product, all/)
})

test('dingtalk-p4-release-readiness rejects test-only regression profile unless explicitly unlocked', () => {
  const rejected = runScript(['--regression-profile', 'selftest'])

  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /--regression-profile must be one of: ops, product, all/)

  const tmpDir = makeTmpDir()
  try {
    const unlocked = runScript(['--regression-profile', 'selftest', '--regression-plan-only', '--output-dir', tmpDir], {
      env: {
        DINGTALK_P4_RELEASE_READINESS_ALLOW_SELFTEST: '1',
      },
    })
    assert.notEqual(unlocked.status, 0)
    assert.doesNotMatch(unlocked.stderr, /--regression-profile must be one of/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})
