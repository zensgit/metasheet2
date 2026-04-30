import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-p4-smoke-preflight.mjs')

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'dingtalk-p4-smoke-preflight-'))
}

function createHealthServer(statusCode = 200, options = {}) {
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
    })
    if (req.method === 'GET' && req.url === '/health' && options.rootHealthHtml) {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html')
      res.end('<!doctype html><html><body>frontend health</body></html>')
      return
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.statusCode = statusCode
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: statusCode >= 200 && statusCode < 300 }))
      return
    }
    if (req.method === 'GET' && req.url === '/api/health') {
      res.statusCode = statusCode
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: statusCode >= 200 && statusCode < 300 }))
      return
    }
    res.statusCode = 404
    res.end('not found')
  })

  return {
    requests,
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      return `http://127.0.0.1:${address.port}`
    },
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

function runScript(args, options = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env ?? {}) },
  })
}

function runScriptAsync(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(options.env ?? {}) },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => {
      resolve({ status: code, stdout, stderr })
    })
  })
}

test('dingtalk-p4-smoke-preflight passes with valid inputs and redacts secrets', async () => {
  const tmpDir = makeTmpDir()
  const outputDir = path.join(tmpDir, 'preflight')
  const server = createHealthServer()

  try {
    const apiBase = await server.listen()
    const result = await runScriptAsync([
      '--api-base',
      apiBase,
      '--web-base',
      'https://metasheet.example.test',
      '--auth-token',
      'secret-admin-token',
      '--group-a-webhook',
      'https://oapi.dingtalk.com/robot/send?access_token=robot-secret-a&timestamp=1690000000000&sign=robot-sign-a',
      '--group-b-webhook',
      'https://oapi.dingtalk.com/robot/send?access_token=robot-secret-b',
      '--group-a-secret',
      'SECabcdefghijklmnop12345678',
      '--allowed-user',
      'user_authorized',
      '--person-user',
      'user_person_bound',
      '--authorized-user',
      'user_authorized',
      '--unauthorized-user',
      'user_unauthorized',
      '--no-email-dingtalk-external-id',
      'dt_no_email_001',
      '--output-dir',
      outputDir,
    ])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.doesNotMatch(result.stdout, /secret-admin-token/)
    assert.doesNotMatch(result.stdout, /robot-secret-a/)
    assert.doesNotMatch(result.stdout, /SECabcdefghijklmnop12345678/)
    assert.equal(server.requests.length, 1)
    assert.equal(server.requests[0].url, '/health')
    assert.equal(server.requests[0].headers.authorization, undefined)

    const summaryText = readFileSync(path.join(outputDir, 'preflight-summary.json'), 'utf8')
    assert.doesNotMatch(summaryText, /secret-admin-token/)
    assert.doesNotMatch(summaryText, /robot-secret-a/)
    assert.doesNotMatch(summaryText, /robot-secret-b/)
    assert.doesNotMatch(summaryText, /robot-sign-a/)
    assert.doesNotMatch(summaryText, /1690000000000/)
    assert.doesNotMatch(summaryText, /SECabcdefghijklmnop12345678/)
    assert.match(summaryText, /access_token=<redacted>/)
    assert.match(summaryText, /timestamp=<redacted>/)
    assert.match(summaryText, /sign=<redacted>/)

    const summary = JSON.parse(summaryText)
    assert.equal(summary.overallStatus, 'pass')
    const byId = new Map(summary.checks.map((check) => [check.id, check]))
    assert.equal(byId.get('local-tools-present').status, 'pass')
    assert.equal(byId.get('api-health').status, 'pass')
    assert.equal(byId.get('person-smoke-input').status, 'pass')
    assert.equal(byId.get('manual-targets-declared').status, 'pass')
    assert.equal(summary.environment.authTokenPresent, true)
    assert.equal(summary.environment.allowedUserCount, 1)
    assert.deepEqual(summary.environment.manualTargets, {
      authorizedUserId: 'user_authorized',
      unauthorizedUserId: 'user_unauthorized',
      noEmailDingTalkExternalId: 'dt_no_email_001',
    })
  } finally {
    await server.close()
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-smoke-preflight falls back to API-prefixed health JSON', async () => {
  const tmpDir = makeTmpDir()
  const outputDir = path.join(tmpDir, 'preflight')
  const server = createHealthServer(200, { rootHealthHtml: true })

  try {
    const apiRoot = await server.listen()
    const result = await runScriptAsync([
      '--api-base',
      `${apiRoot}/api`,
      '--web-base',
      'https://metasheet.example.test',
      '--auth-token',
      'secret-admin-token',
      '--group-a-webhook',
      'https://oapi.dingtalk.com/robot/send?access_token=robot-secret-a',
      '--group-b-webhook',
      'https://oapi.dingtalk.com/robot/send?access_token=robot-secret-b',
      '--allowed-user',
      'user_authorized',
      '--output-dir',
      outputDir,
    ])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.deepEqual(server.requests.map((request) => request.url), ['/health', '/api/health'])

    const summary = JSON.parse(readFileSync(path.join(outputDir, 'preflight-summary.json'), 'utf8'))
    const health = summary.checks.find((check) => check.id === 'api-health')
    assert.equal(summary.overallStatus, 'pass')
    assert.equal(health.status, 'pass')
    assert.match(health.details.url, /\/api\/health$/)
  } finally {
    await server.close()
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-smoke-preflight can require manual target identities', () => {
  const tmpDir = makeTmpDir()
  const outputDir = path.join(tmpDir, 'preflight')

  try {
    const result = runScript([
      '--skip-api',
      '--require-manual-targets',
      '--api-base',
      'http://127.0.0.1:8900',
      '--web-base',
      'https://metasheet.example.test',
      '--auth-token',
      'secret-admin-token',
      '--group-a-webhook',
      'https://oapi.dingtalk.com/robot/send?access_token=robot-secret-a',
      '--group-b-webhook',
      'https://oapi.dingtalk.com/robot/send?access_token=robot-secret-b',
      '--allowed-user',
      'user_authorized',
      '--output-dir',
      outputDir,
    ])

    assert.equal(result.status, 1)
    const summary = JSON.parse(readFileSync(path.join(outputDir, 'preflight-summary.json'), 'utf8'))
    const check = summary.checks.find((entry) => entry.id === 'manual-targets-declared')
    assert.equal(summary.overallStatus, 'fail')
    assert.equal(check.status, 'fail')
    assert.deepEqual(check.details.missing, ['unauthorized user', 'no-email DingTalk external id'])
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-smoke-preflight reads env file without writing raw secrets', async () => {
  const tmpDir = makeTmpDir()
  const outputDir = path.join(tmpDir, 'preflight')
  const envFile = path.join(tmpDir, 'p4.env')
  const server = createHealthServer()

  try {
    const apiBase = await server.listen()
    writeFileSync(envFile, [
      `DINGTALK_P4_API_BASE=${apiBase}`,
      'DINGTALK_P4_WEB_BASE=https://metasheet.example.test',
      'DINGTALK_P4_AUTH_TOKEN=secret-admin-token',
      'DINGTALK_P4_GROUP_A_WEBHOOK=https://oapi.dingtalk.com/robot/send?access_token=robot-secret-a',
      'DINGTALK_P4_GROUP_B_WEBHOOK=https://oapi.dingtalk.com/robot/send?access_token=robot-secret-b',
      'DINGTALK_P4_ALLOWED_MEMBER_GROUP_IDS=mg_allowed',
    ].join('\n'), 'utf8')

    const result = await runScriptAsync([
      '--env-file',
      envFile,
      '--output-dir',
      outputDir,
    ])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const summaryText = readFileSync(path.join(outputDir, 'preflight-summary.json'), 'utf8')
    assert.doesNotMatch(summaryText, /secret-admin-token/)
    assert.doesNotMatch(summaryText, /robot-secret-a/)
    const summary = JSON.parse(summaryText)
    assert.equal(summary.overallStatus, 'pass')
    assert.equal(summary.environment.allowedMemberGroupCount, 1)
    assert.equal(summary.checks.find((check) => check.id === 'person-smoke-input').status, 'skipped')
  } finally {
    await server.close()
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-smoke-preflight requires person user when final gate is enabled', () => {
  const tmpDir = makeTmpDir()
  const outputDir = path.join(tmpDir, 'preflight')

  try {
    const result = runScript([
      '--skip-api',
      '--require-person-user',
      '--api-base',
      'http://127.0.0.1:8900',
      '--web-base',
      'https://metasheet.example.test',
      '--auth-token',
      'secret-admin-token',
      '--group-a-webhook',
      'https://oapi.dingtalk.com/robot/send?access_token=robot-secret-a',
      '--group-b-webhook',
      'https://oapi.dingtalk.com/robot/send?access_token=robot-secret-b',
      '--allowed-user',
      'user_authorized',
      '--output-dir',
      outputDir,
    ])

    assert.equal(result.status, 1)
    const summary = JSON.parse(readFileSync(path.join(outputDir, 'preflight-summary.json'), 'utf8'))
    const personCheck = summary.checks.find((check) => check.id === 'person-smoke-input')
    assert.equal(summary.overallStatus, 'fail')
    assert.equal(personCheck.status, 'fail')
    assert.match(personCheck.details.notes, /delivery-history-group-person/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-smoke-preflight fails when allowlist is missing', () => {
  const tmpDir = makeTmpDir()
  const outputDir = path.join(tmpDir, 'preflight')

  try {
    const result = runScript([
      '--skip-api',
      '--api-base',
      'http://127.0.0.1:8900',
      '--web-base',
      'https://metasheet.example.test',
      '--auth-token',
      'secret-admin-token',
      '--group-a-webhook',
      'https://oapi.dingtalk.com/robot/send?access_token=robot-secret-a',
      '--group-b-webhook',
      'https://oapi.dingtalk.com/robot/send?access_token=robot-secret-b',
      '--output-dir',
      outputDir,
    ])

    assert.equal(result.status, 1)
    assert.doesNotMatch(result.stdout, /secret-admin-token/)
    assert.doesNotMatch(result.stderr, /secret-admin-token/)
    const summary = JSON.parse(readFileSync(path.join(outputDir, 'preflight-summary.json'), 'utf8'))
    assert.equal(summary.overallStatus, 'fail')
    assert.equal(summary.checks.find((check) => check.id === 'allowlist-present').status, 'fail')
    assert.equal(summary.checks.find((check) => check.id === 'api-health').status, 'skipped')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-smoke-preflight fails on malformed webhook and invalid SEC secret', () => {
  const tmpDir = makeTmpDir()
  const outputDir = path.join(tmpDir, 'preflight')

  try {
    const result = runScript([
      '--skip-api',
      '--api-base',
      'http://127.0.0.1:8900',
      '--web-base',
      'https://metasheet.example.test',
      '--auth-token',
      'secret-admin-token',
      '--group-a-webhook',
      'https://oapi.dingtalk.com/robot/send',
      '--group-b-webhook',
      'https://oapi.dingtalk.com/robot/send?access_token=robot-secret-b',
      '--group-a-secret',
      'not-a-sec-secret',
      '--allowed-user',
      'user_authorized',
      '--output-dir',
      outputDir,
    ])

    assert.equal(result.status, 1)
    const summaryText = readFileSync(path.join(outputDir, 'preflight-summary.json'), 'utf8')
    assert.doesNotMatch(summaryText, /robot-secret-b/)
    assert.doesNotMatch(summaryText, /secret-admin-token/)
    const summary = JSON.parse(summaryText)
    assert.equal(summary.overallStatus, 'fail')
    assert.equal(summary.checks.find((check) => check.id === 'group-webhooks-valid').status, 'fail')
    assert.equal(summary.checks.find((check) => check.id === 'group-secrets-valid').status, 'fail')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-smoke-preflight rejects non-DingTalk robot webhook shapes', () => {
  const tmpDir = makeTmpDir()
  const outputDir = path.join(tmpDir, 'preflight')

  try {
    const result = runScript([
      '--skip-api',
      '--api-base',
      'http://127.0.0.1:8900',
      '--web-base',
      'https://metasheet.example.test',
      '--auth-token',
      'secret-admin-token',
      '--group-a-webhook',
      'http://oapi.dingtalk.com/robot/send?access_token=robot-secret-a',
      '--group-b-webhook',
      'https://example.com/robot/send?access_token=robot-secret-b',
      '--allowed-user',
      'user_authorized',
      '--output-dir',
      outputDir,
    ])

    assert.equal(result.status, 1)
    const summaryText = readFileSync(path.join(outputDir, 'preflight-summary.json'), 'utf8')
    assert.doesNotMatch(summaryText, /robot-secret-a/)
    assert.doesNotMatch(summaryText, /robot-secret-b/)
    assert.match(summaryText, /access_token=<redacted>/)
    const summary = JSON.parse(summaryText)
    const webhookCheck = summary.checks.find((check) => check.id === 'group-webhooks-valid')
    assert.equal(webhookCheck.status, 'fail')
    assert.equal(webhookCheck.details.failures.some((failure) => failure.includes('HTTPS')), true)
    assert.equal(webhookCheck.details.failures.some((failure) => failure.includes('DingTalk robot URL')), true)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})
