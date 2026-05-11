import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const COMPLETE_SMTP_ENV = {
  MULTITABLE_EMAIL_TRANSPORT: 'smtp',
  MULTITABLE_EMAIL_SMTP_HOST: 'smtp.example.com',
  MULTITABLE_EMAIL_SMTP_PORT: '587',
  MULTITABLE_EMAIL_SMTP_USER: 'smtp-user',
  MULTITABLE_EMAIL_SMTP_PASSWORD: 'smtp-password-secret',
  MULTITABLE_EMAIL_SMTP_FROM: 'ops-private@example.com',
}

function runRealSendSmoke(env, args = ['exec', 'tsx', 'scripts/ops/multitable-email-real-send-smoke.ts']) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-email-real-send-'))
  const jsonPath = path.join(tmpRoot, 'report.json')
  const mdPath = path.join(tmpRoot, 'report.md')
  const result = spawnSync('pnpm', args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
      EMAIL_REAL_SEND_JSON: jsonPath,
      EMAIL_REAL_SEND_MD: mdPath,
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

test('real-send smoke blocks unless explicit real-send guards are present', () => {
  const result = runRealSendSmoke(COMPLETE_SMTP_ENV)

  assert.equal(result.status, 2)
  assert.equal(result.json.status, 'blocked')
  assert.match(result.markdown, /MULTITABLE_EMAIL_REAL_SEND_SMOKE=1/)
  assert.match(result.markdown, /CONFIRM_SEND_EMAIL=1/)
})

test('real-send smoke blocks when recipient is missing', () => {
  const result = runRealSendSmoke({
    ...COMPLETE_SMTP_ENV,
    MULTITABLE_EMAIL_REAL_SEND_SMOKE: '1',
    CONFIRM_SEND_EMAIL: '1',
  })

  assert.equal(result.status, 2)
  assert.equal(result.json.status, 'blocked')
  assert.match(result.markdown, /MULTITABLE_EMAIL_SMOKE_TO/)
})

test('real-send smoke redacts SMTP secrets and recipient from blocked artifacts', () => {
  const result = runRealSendSmoke({
    ...COMPLETE_SMTP_ENV,
    MULTITABLE_EMAIL_SMTP_HOST: 'smtp://user:pass@smtp.example.com?token=secret-token',
    MULTITABLE_EMAIL_SMTP_PORT: '70000',
    MULTITABLE_EMAIL_SMTP_PASSWORD: 'Bearer raw-token-value',
    MULTITABLE_EMAIL_REAL_SEND_SMOKE: '1',
    CONFIRM_SEND_EMAIL: '1',
    MULTITABLE_EMAIL_SMOKE_TO: 'recipient-private@example.com',
  })

  assert.equal(result.status, 2)
  const combined = [
    result.stdout,
    result.stderr,
    result.markdown,
    JSON.stringify(result.json),
  ].join('\n')
  assert.doesNotMatch(combined, /user:pass/)
  assert.doesNotMatch(combined, /secret-token/)
  assert.doesNotMatch(combined, /raw-token-value/)
  assert.doesNotMatch(combined, /ops-private@example\.com/)
  assert.doesNotMatch(combined, /recipient-private@example\.com/)
})

test('package script launches the real-send smoke harness', () => {
  const result = runRealSendSmoke({}, ['verify:multitable-email:real-send'])

  assert.equal(result.status, 2)
  assert.equal(result.json.status, 'blocked')
})
