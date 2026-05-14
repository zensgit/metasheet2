import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { mkdirSync, writeFileSync } from 'node:fs'

import {
  executeGate,
  translateDelegateStatus,
} from './multitable-phase3-release-gate.mjs'

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

//
// ============================================================
// Strict delegate-gate status translation tests — hardening PR
// ============================================================
//
// These tests cover the translator + mock-injected delegate state
// machine in-process. They do not spawn pnpm and do not require
// node_modules.
//

test('translateDelegateStatus — email pass case: exit=0 + status=pass + ok=true → pass', () => {
  const t = translateDelegateStatus({
    gate: 'email:real-send',
    childExitCode: 0,
    childError: undefined,
    childReport: { status: 'pass', ok: true, mode: 'smtp' },
  })
  assert.equal(t.status, 'pass')
  assert.equal(t.exitCode, 0)
  assert.equal(t.mismatchReason, null)
})

test('translateDelegateStatus — email blocked case: exit=2 + status=blocked → blocked', () => {
  const t = translateDelegateStatus({
    gate: 'email:real-send',
    childExitCode: 2,
    childError: undefined,
    childReport: { status: 'blocked', ok: false },
  })
  assert.equal(t.status, 'blocked')
  assert.equal(t.exitCode, 2)
  assert.equal(t.mismatchReason, null)
})

test('translateDelegateStatus — email mismatch: exit=0 + status=blocked (script bug) → fail-closed', () => {
  const t = translateDelegateStatus({
    gate: 'email:real-send',
    childExitCode: 0,
    childError: undefined,
    childReport: { status: 'blocked', ok: false },
  })
  assert.equal(t.status, 'fail')
  assert.equal(t.exitCode, 1)
  assert.match(t.mismatchReason, /Fail-closed/)
})

test('translateDelegateStatus — email mismatch: exit=2 + status=pass → fail-closed', () => {
  const t = translateDelegateStatus({
    gate: 'email:real-send',
    childExitCode: 2,
    childError: undefined,
    childReport: { status: 'pass', ok: true },
  })
  assert.equal(t.status, 'fail')
  assert.equal(t.exitCode, 1)
  assert.match(t.mismatchReason, /Fail-closed/)
})

test('translateDelegateStatus — email mismatch: exit=0 + status=pass + ok=false → fail-closed', () => {
  const t = translateDelegateStatus({
    gate: 'email:real-send',
    childExitCode: 0,
    childError: undefined,
    childReport: { status: 'pass', ok: false },
  })
  assert.equal(t.status, 'fail')
  assert.equal(t.exitCode, 1)
  assert.match(t.mismatchReason, /Fail-closed/)
  assert.match(t.mismatchReason, /ok=false/)
})

test('translateDelegateStatus — email mismatch: exit=0 + status=pass + ok missing → fail-closed', () => {
  const t = translateDelegateStatus({
    gate: 'email:real-send',
    childExitCode: 0,
    childError: undefined,
    childReport: { status: 'pass' },
  })
  assert.equal(t.status, 'fail')
  assert.equal(t.exitCode, 1)
  assert.match(t.mismatchReason, /Fail-closed/)
})

test('translateDelegateStatus — automation pass: exit=0 + status=pass (no ok required) → pass', () => {
  const t = translateDelegateStatus({
    gate: 'automation:soak',
    childExitCode: 0,
    childError: undefined,
    childReport: { status: 'pass', iterations: 3 },
  })
  assert.equal(t.status, 'pass')
  assert.equal(t.exitCode, 0)
  assert.equal(t.mismatchReason, null)
})

test('translateDelegateStatus — automation blocked: exit=2 + status=blocked → blocked', () => {
  const t = translateDelegateStatus({
    gate: 'automation:soak',
    childExitCode: 2,
    childError: undefined,
    childReport: { status: 'blocked' },
  })
  assert.equal(t.status, 'blocked')
  assert.equal(t.exitCode, 2)
  assert.equal(t.mismatchReason, null)
})

test('translateDelegateStatus — automation mismatch: exit=0 + status=blocked → fail-closed', () => {
  const t = translateDelegateStatus({
    gate: 'automation:soak',
    childExitCode: 0,
    childError: undefined,
    childReport: { status: 'blocked' },
  })
  assert.equal(t.status, 'fail')
  assert.equal(t.exitCode, 1)
  assert.match(t.mismatchReason, /Fail-closed/)
})

test('translateDelegateStatus — automation mismatch: exit=2 + status=pass → fail-closed', () => {
  const t = translateDelegateStatus({
    gate: 'automation:soak',
    childExitCode: 2,
    childError: undefined,
    childReport: { status: 'pass' },
  })
  assert.equal(t.status, 'fail')
  assert.equal(t.exitCode, 1)
  assert.match(t.mismatchReason, /Fail-closed/)
})

test('translateDelegateStatus — child report missing → fail-closed', () => {
  const t = translateDelegateStatus({
    gate: 'email:real-send',
    childExitCode: 0,
    childError: undefined,
    childReport: null,
  })
  assert.equal(t.status, 'fail')
  assert.equal(t.exitCode, 1)
  assert.match(t.mismatchReason, /report\.json missing|unparseable/)
})

test('translateDelegateStatus — child report non-object (parse failure already returned null) → fail-closed', () => {
  const t = translateDelegateStatus({
    gate: 'email:real-send',
    childExitCode: 0,
    childError: undefined,
    childReport: 'broken',
  })
  assert.equal(t.status, 'fail')
  assert.equal(t.exitCode, 1)
  assert.match(t.mismatchReason, /unparseable|missing/)
})

test('translateDelegateStatus — spawn error (ENOENT) → fail-closed', () => {
  const t = translateDelegateStatus({
    gate: 'email:real-send',
    childExitCode: null,
    childError: new Error('spawn pnpm ENOENT'),
    childReport: null,
  })
  assert.equal(t.status, 'fail')
  assert.equal(t.exitCode, 1)
  assert.match(t.mismatchReason, /Spawn launch error/)
})

test('translateDelegateStatus — null exit (signal kill) → fail-closed', () => {
  const t = translateDelegateStatus({
    gate: 'automation:soak',
    childExitCode: null,
    childError: undefined,
    childReport: { status: 'pass' },
  })
  assert.equal(t.status, 'fail')
  assert.equal(t.exitCode, 1)
  assert.match(t.mismatchReason, /not numeric|signal kill/)
})

//
// In-process delegate tests with mock spawnFn
// (drive the full delegate function without invoking pnpm)
//

function makeMockSpawn({ exitCode, report, stdout = '', stderr = '', spawnError = null }) {
  return (cmd, args, opts) => {
    if (spawnError) {
      return { status: null, stdout: '', stderr: '', error: spawnError }
    }
    const env = opts?.env ?? {}
    let jsonPath = env.EMAIL_REAL_SEND_JSON || env.AUTOMATION_SOAK_JSON
    let mdPath = env.EMAIL_REAL_SEND_MD || env.AUTOMATION_SOAK_MD
    if (jsonPath && report !== undefined) {
      mkdirSync(path.dirname(jsonPath), { recursive: true })
      writeFileSync(
        jsonPath,
        typeof report === 'string' ? report : `${JSON.stringify(report, null, 2)}\n`,
      )
    }
    if (mdPath && report !== undefined) {
      mkdirSync(path.dirname(mdPath), { recursive: true })
      writeFileSync(mdPath, `# mock report (status=${report?.status ?? 'n/a'})\n`)
    }
    return { status: exitCode, stdout, stderr, error: null }
  }
}

test('email delegate with mock — pass case round-trips through translator', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mt-phase3-hardening-'))
  try {
    const spawnFn = makeMockSpawn({ exitCode: 0, report: { ok: true, status: 'pass', mode: 'smtp' } })
    const result = executeGate('email:real-send', {}, { outputDir: dir, spawnFn })
    assert.equal(result.status, 'pass')
    assert.equal(result.exitCode, 0)
    assert.equal(result.childStatus, 'pass')
    assert.equal(result.childOk, true)
  } finally {
    cleanup(dir)
  }
})

test('email delegate with mock — mismatch (exit=0 + status=blocked) is FAIL not PASS', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mt-phase3-hardening-'))
  try {
    const spawnFn = makeMockSpawn({ exitCode: 0, report: { ok: false, status: 'blocked' } })
    const result = executeGate('email:real-send', {}, { outputDir: dir, spawnFn })
    assert.equal(result.status, 'fail', 'mismatch must fail, not pass (release-gate correctness)')
    assert.equal(result.exitCode, 1)
    assert.match(result.reason, /Fail-closed/)
  } finally {
    cleanup(dir)
  }
})

test('email delegate with mock — child report missing → FAIL', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mt-phase3-hardening-'))
  try {
    const spawnFn = makeMockSpawn({ exitCode: 0, report: undefined })
    const result = executeGate('email:real-send', {}, { outputDir: dir, spawnFn })
    assert.equal(result.status, 'fail')
    assert.equal(result.exitCode, 1)
  } finally {
    cleanup(dir)
  }
})

test('automation delegate with mock — pass case round-trips through translator', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mt-phase3-hardening-'))
  try {
    const spawnFn = makeMockSpawn({ exitCode: 0, report: { status: 'pass', iterations: 3 } })
    const result = executeGate('automation:soak', {}, { outputDir: dir, spawnFn })
    assert.equal(result.status, 'pass')
    assert.equal(result.exitCode, 0)
    assert.equal(result.childStatus, 'pass')
  } finally {
    cleanup(dir)
  }
})

test('automation delegate with mock — mismatch (exit=0 + status=blocked) is FAIL not PASS', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mt-phase3-hardening-'))
  try {
    const spawnFn = makeMockSpawn({ exitCode: 0, report: { status: 'blocked' } })
    const result = executeGate('automation:soak', {}, { outputDir: dir, spawnFn })
    assert.equal(result.status, 'fail', 'automation mismatch must fail too — same hardening applies')
    assert.equal(result.exitCode, 1)
    assert.match(result.reason, /Fail-closed/)
  } finally {
    cleanup(dir)
  }
})

test('automation delegate with mock — spawn ENOENT → FAIL', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mt-phase3-hardening-'))
  try {
    const spawnFn = makeMockSpawn({ exitCode: null, spawnError: new Error('spawn pnpm ENOENT') })
    const result = executeGate('automation:soak', {}, { outputDir: dir, spawnFn })
    assert.equal(result.status, 'fail')
    assert.equal(result.exitCode, 1)
    assert.match(result.reason, /Spawn launch error/)
  } finally {
    cleanup(dir)
  }
})

//
// Aggregator state machine with mocked delegate spawns
//

function makeRoutingSpawn({ email, automation }) {
  return (cmd, args, opts) => {
    const env = opts?.env ?? {}
    if (env.EMAIL_REAL_SEND_JSON) {
      const e = email ?? { exitCode: 2, report: { ok: false, status: 'blocked' } }
      return makeMockSpawn(e)(cmd, args, opts)
    }
    if (env.AUTOMATION_SOAK_JSON) {
      const a = automation ?? { exitCode: 2, report: { status: 'blocked' } }
      return makeMockSpawn(a)(cmd, args, opts)
    }
    throw new Error(`unexpected spawn route: ${cmd} ${args.join(' ')}`)
  }
}

test('aggregator state machine — email PASS + automation BLOCKED + 2 D0 BLOCKED → BLOCKED (does NOT collapse to PASS)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mt-phase3-hardening-'))
  try {
    const spawnFn = makeRoutingSpawn({
      email: { exitCode: 0, report: { ok: true, status: 'pass', mode: 'smtp' } },
      automation: { exitCode: 2, report: { status: 'blocked' } },
    })
    const result = executeGate('release:phase3', {}, { outputDir: dir, spawnFn })
    assert.equal(result.status, 'blocked', 'partial PASS must not collapse aggregate to PASS')
    assert.equal(result.exitCode, 2)
    const emailChild = result.children.find((c) => c.gate === 'email:real-send')
    assert.equal(emailChild.status, 'pass')
    assert.match(result.reason, /BLOCKED/)
  } finally {
    cleanup(dir)
  }
})

test('aggregator state machine — email FAIL + automation BLOCKED + 2 D0 BLOCKED → FAIL (any delegate fail → aggregate fail)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mt-phase3-hardening-'))
  try {
    const spawnFn = makeRoutingSpawn({
      email: { exitCode: 1, report: { ok: false, status: 'failed' } },
      automation: { exitCode: 2, report: { status: 'blocked' } },
    })
    const result = executeGate('release:phase3', {}, { outputDir: dir, spawnFn })
    assert.equal(result.status, 'fail')
    assert.equal(result.exitCode, 1)
  } finally {
    cleanup(dir)
  }
})

test('aggregator state machine — automation FAIL beats email PASS + others BLOCKED → FAIL', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mt-phase3-hardening-'))
  try {
    const spawnFn = makeRoutingSpawn({
      email: { exitCode: 0, report: { ok: true, status: 'pass', mode: 'smtp' } },
      automation: { exitCode: 1, report: { status: 'fail' } },
    })
    const result = executeGate('release:phase3', {}, { outputDir: dir, spawnFn })
    assert.equal(result.status, 'fail', 'any delegate FAIL must propagate even when others PASS')
    assert.equal(result.exitCode, 1)
  } finally {
    cleanup(dir)
  }
})

test('aggregator state machine — email mismatch (exit=0 + status=blocked) → aggregate FAIL', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mt-phase3-hardening-'))
  try {
    const spawnFn = makeRoutingSpawn({
      email: { exitCode: 0, report: { ok: false, status: 'blocked' } },
      automation: { exitCode: 2, report: { status: 'blocked' } },
    })
    const result = executeGate('release:phase3', {}, { outputDir: dir, spawnFn })
    assert.equal(result.status, 'fail', 'email mismatch should poison the aggregate to FAIL')
    assert.equal(result.exitCode, 1)
  } finally {
    cleanup(dir)
  }
})

test('aggregator state machine — automation mismatch (exit=2 + status=pass) → aggregate FAIL', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mt-phase3-hardening-'))
  try {
    const spawnFn = makeRoutingSpawn({
      email: { exitCode: 2, report: { ok: false, status: 'blocked' } },
      automation: { exitCode: 2, report: { status: 'pass' } },
    })
    const result = executeGate('release:phase3', {}, { outputDir: dir, spawnFn })
    assert.equal(result.status, 'fail', 'automation mismatch should poison the aggregate to FAIL')
    assert.equal(result.exitCode, 1)
  } finally {
    cleanup(dir)
  }
})

//
// Artifact integrity — real SMTP / webhook / token env names through mock path
//

test('artifact integrity — real SMTP env values do not leak via delegate childStdoutSample / childStderrSample (email)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mt-phase3-hardening-'))
  try {
    // Simulate worst-case: email script accidentally echoes env values
    // into stdout/stderr. Bridge must redact before storing samples.
    const dirtyStdout = [
      'SMTP_HOST=smtp.privateops.example.com',
      'SMTP_USER=privateops-smtp-user',
      'MULTITABLE_EMAIL_SMTP_PASSWORD=privateOpsSmtpPw99',
      'MULTITABLE_EMAIL_SMOKE_TO=private-recipient@example.com',
      'Bearer abcdefghijklmnopqrstuvwxyz1234567890',
    ].join('\n')
    const dirtyStderr = 'sk-leakytestonly1234567890abcdef\nOPENAI_API_KEY=plaintextkey-leak'
    const spawnFn = makeMockSpawn({
      exitCode: 2,
      report: { ok: false, status: 'blocked' },
      stdout: dirtyStdout,
      stderr: dirtyStderr,
    })
    const result = executeGate('email:real-send', {}, { outputDir: dir, spawnFn })
    const sampled = `${result.childStdoutSample}\n${result.childStderrSample}`
    assert.doesNotMatch(sampled, /smtp\.privateops\.example\.com/, 'leak: SMTP_HOST value')
    assert.doesNotMatch(sampled, /privateops-smtp-user/, 'leak: SMTP_USER value')
    assert.doesNotMatch(sampled, /privateOpsSmtpPw99/, 'leak: SMTP_PASSWORD value')
    assert.doesNotMatch(sampled, /private-recipient@example\.com/, 'leak: recipient value')
    assert.doesNotMatch(sampled, /abcdefghijklmnopqrstuvwxyz1234567890/, 'leak: Bearer token')
    assert.doesNotMatch(sampled, /sk-leakytestonly1234567890abcdef/, 'leak: sk- API key')
    assert.doesNotMatch(sampled, /plaintextkey-leak/, 'leak: OPENAI_API_KEY value')
  } finally {
    cleanup(dir)
  }
})

test('artifact integrity — webhook URLs and auth tokens do not leak via automation delegate samples', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mt-phase3-hardening-'))
  try {
    const dirtyStderr = [
      'MULTITABLE_AUTOMATION_SOAK_WEBHOOK_URL=https://hook.example.com/path?access_token=secret-leak-token-12345',
      'MULTITABLE_AUTOMATION_SOAK_FAIL_WEBHOOK_URL=https://hook.example.com/fail?access_token=fail-leak-token-67890',
      'AUTH_TOKEN=Bearer raw-bearer-leak-token-aaaaaaaaaaaa',
    ].join('\n')
    const spawnFn = makeMockSpawn({
      exitCode: 2,
      report: { status: 'blocked' },
      stderr: dirtyStderr,
    })
    const result = executeGate('automation:soak', {}, { outputDir: dir, spawnFn })
    const sampled = `${result.childStdoutSample}\n${result.childStderrSample}`
    assert.doesNotMatch(sampled, /secret-leak-token-12345/, 'leak: webhook access_token')
    assert.doesNotMatch(sampled, /fail-leak-token-67890/, 'leak: fail-webhook access_token')
    assert.doesNotMatch(sampled, /raw-bearer-leak-token-aaaaaaaaaaaa/, 'leak: bearer token')
  } finally {
    cleanup(dir)
  }
})

test('artifact integrity — Phase 3 aggregator report.json does not include dirty samples raw', () => {
  // The aggregator's report.json only stores summarized children
  // (gate, status, exitCode, deferral, delegatedCommand, child paths).
  // Even if delegate samples contained dirty content, they don't
  // surface in the aggregator's own report.json.
  const dir = mkdtempSync(path.join(tmpdir(), 'mt-phase3-hardening-'))
  try {
    const spawnFn = makeRoutingSpawn({
      email: {
        exitCode: 2,
        report: { ok: false, status: 'blocked' },
        stdout: 'SMTP_PASSWORD=p4ssw0rd-leak\n',
      },
      automation: {
        exitCode: 2,
        report: { status: 'blocked' },
        stdout: 'TOKEN=tokenvalue-leak\n',
      },
    })
    const result = executeGate('release:phase3', {}, { outputDir: dir, spawnFn })
    const serialized = JSON.stringify(result)
    assert.doesNotMatch(serialized, /p4ssw0rd-leak/)
    assert.doesNotMatch(serialized, /tokenvalue-leak/)
  } finally {
    cleanup(dir)
  }
})
