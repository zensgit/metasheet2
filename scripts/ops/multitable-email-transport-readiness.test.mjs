import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function runReadiness(env) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-email-readiness-'))
  const jsonPath = path.join(tmpRoot, 'report.json')
  const mdPath = path.join(tmpRoot, 'report.md')
  const result = spawnSync('pnpm', ['exec', 'tsx', 'scripts/ops/multitable-email-transport-readiness.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
      EMAIL_READINESS_JSON: jsonPath,
      EMAIL_READINESS_MD: mdPath,
    },
    encoding: 'utf8',
  })

  return {
    ...result,
    jsonPath,
    mdPath,
    json: fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : null,
    markdown: fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '',
  }
}

test('email readiness script passes in default mock mode', () => {
  const result = runReadiness({})

  assert.equal(result.status, 0)
  assert.equal(result.json.ok, true)
  assert.equal(result.json.mode, 'mock')
  assert.match(result.markdown, /Status: `pass`/)
})

test('email readiness script exits 2 when smtp env is incomplete', () => {
  const result = runReadiness({
    MULTITABLE_EMAIL_TRANSPORT: 'smtp',
    MULTITABLE_EMAIL_SMTP_HOST: 'smtp.example.com',
  })

  assert.equal(result.status, 2)
  assert.equal(result.json.ok, false)
  assert.equal(result.json.status, 'blocked')
  assert.match(result.markdown, /MULTITABLE_EMAIL_SMTP_PASSWORD/)
})

test('email readiness script redacts SMTP secrets and bearer tokens from artifacts', () => {
  const result = runReadiness({
    MULTITABLE_EMAIL_TRANSPORT: 'smtp',
    MULTITABLE_EMAIL_SMTP_HOST: 'smtp://user:pass@smtp.example.com?token=secret-token',
    MULTITABLE_EMAIL_SMTP_PORT: '587',
    MULTITABLE_EMAIL_SMTP_USER: 'smtp-user',
    MULTITABLE_EMAIL_SMTP_PASSWORD: 'Bearer raw-token-value',
    MULTITABLE_EMAIL_SMTP_FROM: 'ops-private@example.com',
  })

  assert.equal(result.status, 0)
  const combined = [
    result.stdout,
    result.stderr,
    result.markdown,
    JSON.stringify(result.json),
  ].join('\n')
  assert.doesNotMatch(combined, /smtp:\/\/user:pass@smtp\.example\.com/)
  assert.doesNotMatch(combined, /secret-token/)
  assert.doesNotMatch(combined, /raw-token-value/)
  assert.doesNotMatch(combined, /ops-private@example\.com/)
})

test('email readiness script can be launched through package script', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-email-readiness-script-'))
  const jsonPath = path.join(tmpRoot, 'report.json')
  const mdPath = path.join(tmpRoot, 'report.md')

  execFileSync('pnpm', ['verify:multitable-email:readiness'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      EMAIL_READINESS_JSON: jsonPath,
      EMAIL_READINESS_MD: mdPath,
    },
    stdio: 'pipe',
  })

  const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
  assert.equal(report.status, 'pass')
})
