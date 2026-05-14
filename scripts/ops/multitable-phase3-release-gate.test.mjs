import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { executeGate } from './multitable-phase3-release-gate.mjs'

const SCRIPT = 'scripts/ops/multitable-phase3-release-gate.mjs'

function runGate(gate, { env = {}, allowBlocked = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mt-phase3-gate-'))
  const args = [SCRIPT, '--gate', gate, '--output-dir', dir]
  if (allowBlocked) args.push('--allow-blocked')
  const childEnv = { ...process.env, ...env }
  // Strip outer env vars that might be set in the parent test runner,
  // unless overridden in `env`, so each test starts from a known state.
  for (const key of [
    'MULTITABLE_PERF_LARGE_TABLE_CONFIRM',
    'MULTITABLE_PERF_TARGET_DB',
    'MULTITABLE_PERM_MATRIX_CONFIRM',
    'API_BASE',
    'AUTH_TOKEN',
    'MULTITABLE_AUTOMATION_SOAK_CONFIRM',
    'MULTITABLE_AUTOMATION_SOAK_EMAIL_SAFE_MODE',
    'MULTITABLE_AUTOMATION_SOAK_WEBHOOK_URL',
    'MULTITABLE_AUTOMATION_SOAK_FAIL_WEBHOOK_URL',
    'MULTITABLE_AUTOMATION_SOAK_ITERATIONS',
    'MULTITABLE_EMAIL_TRANSPORT',
    'MULTITABLE_EMAIL_SMTP_HOST',
    'MULTITABLE_EMAIL_SMTP_PORT',
    'MULTITABLE_EMAIL_SMTP_USER',
    'MULTITABLE_EMAIL_SMTP_PASSWORD',
    'MULTITABLE_EMAIL_SMTP_FROM',
    'MULTITABLE_EMAIL_REAL_SEND_SMOKE',
    'CONFIRM_SEND_EMAIL',
    'MULTITABLE_EMAIL_SMOKE_TO',
    'MULTITABLE_EMAIL_SMOKE_SUBJECT',
  ]) {
    if (!(key in env)) delete childEnv[key]
  }
  const result = spawnSync('node', args, {
    cwd: process.cwd(),
    env: childEnv,
    encoding: 'utf8',
  })
  let json = null
  let md = null
  try {
    json = readFileSync(path.join(dir, 'report.json'), 'utf8')
  } catch {}
  try {
    md = readFileSync(path.join(dir, 'report.md'), 'utf8')
  } catch {}
  return {
    dir,
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    json,
    md,
  }
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true })
}

test('executeGate (in-process) blocks perf:large-table when env is missing', () => {
  const result = executeGate('perf:large-table', {})
  assert.equal(result.status, 'blocked')
  assert.equal(result.exitCode, 2)
  assert.deepEqual(result.missingEnv.sort(), [
    'MULTITABLE_PERF_LARGE_TABLE_CONFIRM',
    'MULTITABLE_PERF_TARGET_DB',
  ].sort())
})

test('executeGate (in-process) still blocks even when env is present at D0', () => {
  const result = executeGate('perf:large-table', {
    MULTITABLE_PERF_LARGE_TABLE_CONFIRM: '1',
    MULTITABLE_PERF_TARGET_DB: 'postgres://localhost:5432/test',
  })
  assert.equal(result.status, 'blocked')
  assert.equal(result.exitCode, 2)
  assert.deepEqual(result.missingEnv, [])
  assert.match(result.reason, /D0 skeleton/)
})

test('executeGate aggregator returns BLOCKED, never FAIL, when children are blocked', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mt-phase3-gate-inproc-'))
  try {
    const result = executeGate('release:phase3', {}, { outputDir: dir })
    assert.equal(result.status, 'blocked')
    assert.equal(result.exitCode, 2)
    assert.notEqual(result.status, 'fail', 'aggregator status must not be fail')
    assert.notEqual(result.exitCode, 1, 'aggregator must not collapse BLOCKED into FAIL=1')
    assert.equal(result.children.length, 4)
    assert.ok(result.children.some((c) => c.gate === 'email:real-send'))
    assert.ok(result.children.every((c) => c.status === 'blocked'))
    assert.ok(result.children.every((c) => c.exitCode === 2))
    // The reason text explicitly references both BLOCKED and FAIL to document the
    // non-collapse rule; substring guard is intentionally narrow.
    assert.match(result.reason, /BLOCKED/)
  } finally {
    cleanup(dir)
  }
})

test('perf:large-table exits 2 (blocked) by default via spawn', () => {
  const r = runGate('perf:large-table')
  try {
    assert.equal(r.exitCode, 2)
    assert.ok(r.json)
    const obj = JSON.parse(r.json)
    assert.equal(obj.status, 'blocked')
    assert.equal(obj.exitCode, 2)
    assert.ok(obj.missingEnv.length > 0)
  } finally {
    cleanup(r.dir)
  }
})

test('permissions:matrix exits 2 (blocked) by default via spawn', () => {
  const r = runGate('permissions:matrix')
  try {
    assert.equal(r.exitCode, 2)
    const obj = JSON.parse(r.json)
    assert.equal(obj.status, 'blocked')
  } finally {
    cleanup(r.dir)
  }
})

test('automation:soak exits 2 (blocked) by default via spawn', () => {
  const r = runGate('automation:soak')
  try {
    assert.equal(r.exitCode, 2)
    const obj = JSON.parse(r.json)
    assert.equal(obj.status, 'blocked')
    assert.equal(obj.delegatedCommand, 'pnpm verify:multitable-automation:soak')
    assert.equal(obj.childExitCode, 2)
    assert.equal(obj.childStatus, 'blocked')
    assert.match(obj.childReportJson, /automation-soak\/report\.json$/)
  } finally {
    cleanup(r.dir)
  }
})

test('email:real-send delegates to the existing real-send smoke and exits 2 (blocked) by default via spawn', () => {
  const r = runGate('email:real-send')
  try {
    assert.equal(r.exitCode, 2)
    const obj = JSON.parse(r.json)
    assert.equal(obj.status, 'blocked')
    assert.equal(obj.exitCode, 2)
    assert.equal(obj.delegatedCommand, 'pnpm verify:multitable-email:real-send')
    assert.equal(obj.childExitCode, 2)
    assert.equal(obj.childStatus, 'blocked')
    assert.match(obj.childReportJson, /real-send-smoke\/report\.json$/)
    assert.match(obj.childReportMd, /real-send-smoke\/report\.md$/)
    assert.ok(obj.missingEnv.includes('MULTITABLE_EMAIL_SMOKE_TO'))
  } finally {
    cleanup(r.dir)
  }
})

test('release:phase3 aggregator exits 2 (blocked) not 1 (fail) via spawn', () => {
  const r = runGate('release:phase3')
  try {
    assert.equal(r.exitCode, 2, 'aggregator must exit 2, not 1')
    const obj = JSON.parse(r.json)
    assert.equal(obj.status, 'blocked')
    assert.equal(obj.exitCode, 2)
    assert.ok(Array.isArray(obj.children) && obj.children.length === 4)
    const emailChild = obj.children.find((c) => c.gate === 'email:real-send')
    assert.ok(emailChild)
    assert.equal(emailChild.delegatedCommand, 'pnpm verify:multitable-email:real-send')
    assert.match(emailChild.childReportJson, /children\/email-real-send\/real-send-smoke\/report\.json$/)
    assert.ok(obj.children.every((c) => c.status === 'blocked' && c.exitCode === 2))
    const automationChild = obj.children.find((c) => c.gate === 'automation:soak')
    assert.ok(automationChild)
    assert.equal(automationChild.delegatedCommand, 'pnpm verify:multitable-automation:soak')
    assert.match(automationChild.childReportJson, /children\/automation-soak\/automation-soak\/report\.json$/)
    assert.match(obj.reason, /BLOCKED/)
  } finally {
    cleanup(r.dir)
  }
})

test('--allow-blocked overrides exit code to 0 but keeps status field as blocked', () => {
  const r = runGate('perf:large-table', { allowBlocked: true })
  try {
    assert.equal(r.exitCode, 0)
    const obj = JSON.parse(r.json)
    assert.equal(obj.status, 'blocked', 'status field stays blocked')
    assert.equal(obj.exitCode, 2, 'recorded exitCode in report stays 2')
  } finally {
    cleanup(r.dir)
  }
})

test('unknown --gate value fails with exit 1', () => {
  const r = runGate('not-a-real-gate')
  try {
    assert.equal(r.exitCode, 1)
    assert.match(r.stderr, /Unknown --gate/)
  } finally {
    cleanup(r.dir)
  }
})

test('artifact integrity — stdout + stderr + report.json + report.md never leak env-supplied secrets', () => {
  const env = {
    MULTITABLE_PERF_TARGET_DB: 'postgres://leakyuser:l3akyp4ssw0rd@leakhost:5432/db',
    OPENAI_API_KEY: 'sk-leakytestonly1234567890abcdef',
    DINGTALK_CLIENT_SECRET: 'leakyClientSecretValue',
    SMTP_PASSWORD: 'l3akySmtpPwd99',
    SMTP_HOST: 'smtp.leakyhost.example.com',
    SMTP_USER: 'leakyuser@example.com',
  }
  const r = runGate('perf:large-table', { env })
  try {
    const all = `${r.stdout}\n${r.stderr}\n${r.json ?? ''}\n${r.md ?? ''}`
    assert.doesNotMatch(all, /l3akyp4ssw0rd/, 'leak: postgres password')
    assert.doesNotMatch(all, /leakyuser:l3akyp4ssw0rd/, 'leak: postgres user:pass')
    assert.doesNotMatch(all, /sk-leakytestonly1234567890abcdef/, 'leak: sk- api key')
    assert.doesNotMatch(all, /leakyClientSecretValue/, 'leak: client secret')
    assert.doesNotMatch(all, /l3akySmtpPwd99/, 'leak: SMTP password')
    assert.doesNotMatch(all, /smtp\.leakyhost\.example\.com/, 'leak: SMTP host literal')
    assert.doesNotMatch(all, /leakyuser@example\.com/, 'leak: SMTP user email')
  } finally {
    cleanup(r.dir)
  }
})

test('artifact integrity — release:phase3 aggregator does not leak env-supplied secrets', () => {
  const env = {
    OPENAI_API_KEY: 'sk-aggregatorleak1234567890abcdef',
    DINGTALK_CLIENT_SECRET: 'aggregatorClientSecretValue',
    SMTP_PASSWORD: 'aggregatorSmtpPw',
  }
  const r = runGate('release:phase3', { env })
  try {
    const all = `${r.stdout}\n${r.stderr}\n${r.json ?? ''}\n${r.md ?? ''}`
    assert.doesNotMatch(all, /sk-aggregatorleak1234567890abcdef/)
    assert.doesNotMatch(all, /aggregatorClientSecretValue/)
    assert.doesNotMatch(all, /aggregatorSmtpPw/)
  } finally {
    cleanup(r.dir)
  }
})

test('artifact integrity — email:real-send delegate output paths and summary do not leak env-supplied SMTP values', () => {
  const env = {
    MULTITABLE_EMAIL_TRANSPORT: 'smtp',
    MULTITABLE_EMAIL_SMTP_HOST: 'smtp.email-gate-private.example.com',
    MULTITABLE_EMAIL_SMTP_PORT: '70000',
    MULTITABLE_EMAIL_SMTP_USER: 'email-gate-private-user',
    MULTITABLE_EMAIL_SMTP_PASSWORD: 'emailGatePrivatePw99',
    MULTITABLE_EMAIL_SMTP_FROM: 'email-gate-from-address',
    MULTITABLE_EMAIL_REAL_SEND_SMOKE: '1',
    CONFIRM_SEND_EMAIL: '1',
    MULTITABLE_EMAIL_SMOKE_TO: 'email-gate-to-address',
  }
  const r = runGate('email:real-send', { env })
  try {
    assert.equal(r.exitCode, 2)
    const all = `${r.stdout}\n${r.stderr}\n${r.json ?? ''}\n${r.md ?? ''}`
    assert.doesNotMatch(all, /smtp\.email-gate-private\.example\.com/)
    assert.doesNotMatch(all, /email-gate-private-user/)
    assert.doesNotMatch(all, /emailGatePrivatePw99/)
    assert.doesNotMatch(all, /email-gate-from-address/)
    assert.doesNotMatch(all, /email-gate-to-address/)
  } finally {
    cleanup(r.dir)
  }
})

test('artifact integrity — automation:soak delegate does not leak auth token or webhook URLs', () => {
  const env = {
    API_BASE: 'https://metasheet-soak.example.com',
    AUTH_TOKEN: 'automation-soak-private-token',
    MULTITABLE_AUTOMATION_SOAK_WEBHOOK_URL: 'https://sink-soak.example.com/success/private-success',
    MULTITABLE_AUTOMATION_SOAK_FAIL_WEBHOOK_URL: 'https://sink-soak.example.com/fail/private-fail',
  }
  const r = runGate('automation:soak', { env })
  try {
    const all = `${r.stdout}\n${r.stderr}\n${r.json ?? ''}\n${r.md ?? ''}`
    assert.doesNotMatch(all, /automation-soak-private-token/)
    assert.doesNotMatch(all, /private-success/)
    assert.doesNotMatch(all, /private-fail/)
  } finally {
    cleanup(r.dir)
  }
})

test('artifact integrity — MULTITABLE_EMAIL_SMTP_HOST/USER/FROM/PASSWORD real env names never leak (perf:large-table sub-gate)', () => {
  // These are the actual env var names consumed by
  // scripts/ops/multitable-email-real-send-smoke.ts. Even though the
  // Phase 3 D0 gate does not invoke that script, a future regression
  // that leaks these into stdout / stderr / report.json / report.md
  // must be caught by the redaction layer.
  const env = {
    MULTITABLE_EMAIL_SMTP_HOST: 'smtp.privateops.example.com',
    MULTITABLE_EMAIL_SMTP_USER: 'privateops-smtp-user',
    MULTITABLE_EMAIL_SMTP_PASSWORD: 'privateOpsSmtpPw99',
    MULTITABLE_EMAIL_SMTP_FROM: 'private-from-addr@example.com',
    MULTITABLE_EMAIL_SMTP_PORT: '465',
    MULTITABLE_EMAIL_SMOKE_TO: 'private-recipient@example.com',
  }
  const r = runGate('perf:large-table', { env })
  try {
    const all = `${r.stdout}\n${r.stderr}\n${r.json ?? ''}\n${r.md ?? ''}`
    assert.doesNotMatch(all, /smtp\.privateops\.example\.com/, 'leak: SMTP_HOST value')
    assert.doesNotMatch(all, /privateops-smtp-user/, 'leak: SMTP_USER value')
    assert.doesNotMatch(all, /privateOpsSmtpPw99/, 'leak: SMTP_PASSWORD value')
    assert.doesNotMatch(all, /private-from-addr@example\.com/, 'leak: SMTP_FROM value')
    assert.doesNotMatch(all, /private-recipient@example\.com/, 'leak: SMOKE_TO recipient value')
  } finally {
    cleanup(r.dir)
  }
})

test('artifact integrity — MULTITABLE_EMAIL_SMTP_HOST/USER/FROM/PASSWORD real env names never leak (release:phase3 aggregator)', () => {
  // Cross-check the aggregator path: same env vars should not survive
  // into the aggregator artifact either, even though aggregator output
  // adds a children array on top of sub-gate state.
  const env = {
    MULTITABLE_EMAIL_SMTP_HOST: 'smtp-aggregator-leak.example.com',
    MULTITABLE_EMAIL_SMTP_USER: 'aggregator-smtp-user',
    MULTITABLE_EMAIL_SMTP_PASSWORD: 'aggregatorSmtpPw88',
    MULTITABLE_EMAIL_SMTP_FROM: 'aggregator-from@example.com',
    MULTITABLE_EMAIL_SMOKE_TO: 'aggregator-to@example.com',
  }
  const r = runGate('release:phase3', { env })
  try {
    const all = `${r.stdout}\n${r.stderr}\n${r.json ?? ''}\n${r.md ?? ''}`
    assert.doesNotMatch(all, /smtp-aggregator-leak\.example\.com/)
    assert.doesNotMatch(all, /aggregator-smtp-user/)
    assert.doesNotMatch(all, /aggregatorSmtpPw88/)
    assert.doesNotMatch(all, /aggregator-from@example\.com/)
    assert.doesNotMatch(all, /aggregator-to@example\.com/)
  } finally {
    cleanup(r.dir)
  }
})
