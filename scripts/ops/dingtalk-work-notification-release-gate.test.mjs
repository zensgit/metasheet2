import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-work-notification-release-gate.mjs')
const statusHelperPath = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-work-notification-env-status.mjs')

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'dingtalk-work-notification-release-gate-'))
}

function writeEnv(file, lines) {
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function runScript(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
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
    child.on('close', (code, signal) => {
      resolve({ status: code, signal, stdout, stderr })
    })
  })
}

function jsonResponse(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

async function withServer(handler, fn) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const apiBase = `http://127.0.0.1:${address.port}`
  try {
    return await fn(apiBase)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

test('release gate passes when env, health, auth, and workNotification are ready', async () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'app.env')
  const tokenFile = path.join(tmpDir, 'admin.jwt')
  const outputJson = path.join(tmpDir, 'summary.json')
  const outputMd = path.join(tmpDir, 'summary.md')
  try {
    writeEnv(envFile, [
      'DINGTALK_APP_KEY=unit-key',
      'DINGTALK_APP_SECRET=unit-secret',
      'DINGTALK_AGENT_ID=123456789',
    ])
    writeFileSync(tokenFile, 'secret-admin-token\n', 'utf8')

    await withServer((req, res) => {
      if (req.url === '/api/health') return jsonResponse(res, 200, { status: 'ok', success: true })
      if (req.url === '/api/auth/me') return jsonResponse(res, 200, { success: true, user: { role: 'admin', email: 'admin@example.test' } })
      if (req.url === '/api/admin/users/user-1/dingtalk-access') {
        return jsonResponse(res, 200, {
          workNotification: {
            configured: true,
            available: true,
            requirements: {
              appKey: { configured: true, selectedKey: 'DINGTALK_APP_KEY' },
              appSecret: { configured: true, selectedKey: 'DINGTALK_APP_SECRET' },
              agentId: { configured: true, selectedKey: 'DINGTALK_AGENT_ID' },
            },
          },
        })
      }
      return jsonResponse(res, 404, { error: 'not found' })
    }, async (apiBase) => {
      const result = await runScript([
        '--env-file', envFile,
        '--status-helper', statusHelperPath,
        '--api-base', apiBase,
        '--auth-token-file', tokenFile,
        '--user-id', 'user-1',
        '--output-json', outputJson,
        '--output-md', outputMd,
      ])

      assert.equal(result.status, 0, result.stderr || result.stdout)
      const summary = readJson(outputJson)
      assert.equal(summary.status, 'pass')
      assert.equal(summary.envStatus.overallStatus, 'ready')
      assert.equal(summary.health.ok, true)
      assert.equal(summary.auth.ok, true)
      assert.equal(summary.workNotification.available, true)
      assert.deepEqual(summary.failures, [])
      assert.doesNotMatch(readFileSync(outputJson, 'utf8'), /secret-admin-token|unit-secret|123456789/)
      assert.doesNotMatch(readFileSync(outputMd, 'utf8'), /secret-admin-token|unit-secret|123456789/)
    })
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('release gate passes when env helper lacks Agent ID but backend runtime is available from stored config', async () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'app.env')
  const tokenFile = path.join(tmpDir, 'admin.jwt')
  const outputJson = path.join(tmpDir, 'summary.json')
  const outputMd = path.join(tmpDir, 'summary.md')
  try {
    writeEnv(envFile, [
      'DINGTALK_APP_KEY=unit-key',
      'DINGTALK_APP_SECRET=unit-secret',
    ])
    writeFileSync(tokenFile, 'secret-admin-token\n', 'utf8')

    await withServer((req, res) => {
      if (req.url === '/api/health') return jsonResponse(res, 200, { status: 'ok', success: true })
      if (req.url === '/api/auth/me') return jsonResponse(res, 200, { success: true, user: { role: 'admin', email: 'admin@example.test' } })
      if (req.url === '/api/admin/users/user-1/dingtalk-access') {
        return jsonResponse(res, 200, {
          workNotification: {
            configured: true,
            available: true,
            source: 'directory_integration',
            requirements: {
              appKey: { configured: true, selectedKey: 'DINGTALK_APP_KEY' },
              appSecret: { configured: true, selectedKey: 'DINGTALK_APP_SECRET' },
              agentId: { configured: true, selectedKey: 'directory_integrations.config.workNotificationAgentId' },
            },
          },
        })
      }
      return jsonResponse(res, 404, { error: 'not found' })
    }, async (apiBase) => {
      const result = await runScript([
        '--env-file', envFile,
        '--status-helper', statusHelperPath,
        '--api-base', apiBase,
        '--auth-token-file', tokenFile,
        '--user-id', 'user-1',
        '--output-json', outputJson,
        '--output-md', outputMd,
      ])

      assert.equal(result.status, 0, result.stderr || result.stdout)
      const summary = readJson(outputJson)
      assert.equal(summary.status, 'pass')
      assert.equal(summary.envStatus.overallStatus, 'blocked')
      assert.equal(summary.workNotification.available, true)
      assert.equal(summary.runtimeStatusOverridesEnvStatus, true)
      assert.deepEqual(summary.failures, [])
      assert.match(readFileSync(outputMd, 'utf8'), /Runtime Status Overrides Env Status: `true`/)
      assert.doesNotMatch(readFileSync(outputJson, 'utf8'), /secret-admin-token|unit-secret/)
    })
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('release gate reports blocked when agent id is missing', async () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'app.env')
  const tokenFile = path.join(tmpDir, 'admin.jwt')
  const outputJson = path.join(tmpDir, 'summary.json')
  const outputMd = path.join(tmpDir, 'summary.md')
  try {
    writeEnv(envFile, [
      'DINGTALK_APP_KEY=unit-key',
      'DINGTALK_APP_SECRET=unit-secret',
    ])
    writeFileSync(tokenFile, 'secret-admin-token\n', 'utf8')

    await withServer((req, res) => {
      if (req.url === '/api/health') return jsonResponse(res, 200, { status: 'ok', success: true })
      if (req.url === '/api/auth/me') return jsonResponse(res, 200, { success: true, user: { role: 'admin' } })
      if (req.url === '/api/admin/users/user-1/dingtalk-access') {
        return jsonResponse(res, 200, {
          workNotification: {
            configured: false,
            available: false,
            unavailableReason: 'missing_agent_id',
            requirements: { agentId: { configured: false, selectedKey: null } },
          },
        })
      }
      return jsonResponse(res, 404, { error: 'not found' })
    }, async (apiBase) => {
      const result = await runScript([
        '--env-file', envFile,
        '--status-helper', statusHelperPath,
        '--api-base', apiBase,
        '--auth-token-file', tokenFile,
        '--user-id', 'user-1',
        '--allow-blocked',
        '--output-json', outputJson,
        '--output-md', outputMd,
      ])

      assert.equal(result.status, 0, result.stderr || result.stdout)
      const summary = readJson(outputJson)
      assert.equal(summary.status, 'blocked')
      assert.equal(summary.envStatus.overallStatus, 'blocked')
      assert.deepEqual(summary.failures.map((failure) => failure.code).sort(), [
        'ENV_STATUS_BLOCKED',
        'WORK_NOTIFICATION_UNAVAILABLE',
      ].sort())
      assert.match(readFileSync(outputMd, 'utf8'), /missing_agent_id/)
      assert.doesNotMatch(readFileSync(outputJson, 'utf8'), /secret-admin-token|unit-secret/)
    })
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('release gate redacts sensitive API error payloads', async () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'app.env')
  const tokenFile = path.join(tmpDir, 'admin.jwt')
  const outputJson = path.join(tmpDir, 'summary.json')
  const outputMd = path.join(tmpDir, 'summary.md')
  const leakedToken = 'robot-access-token-abcdef1234567890'
  const leakedSecret = 'SEC' + '1234567890abcdef1234567890'
  const leakedJwt = 'eyJ' + 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature'
  try {
    writeEnv(envFile, [
      'DINGTALK_APP_KEY=unit-key',
      'DINGTALK_APP_SECRET=unit-secret',
      'DINGTALK_AGENT_ID=123456789',
    ])
    writeFileSync(tokenFile, 'secret-admin-token\n', 'utf8')

    await withServer((req, res) => {
      if (req.url === '/api/health') return jsonResponse(res, 200, { status: 'ok', success: true })
      if (req.url === '/api/auth/me') {
        return jsonResponse(res, 401, {
          error: `expired Bearer ${leakedJwt} access_token=${leakedToken} ${leakedSecret}`,
        })
      }
      return jsonResponse(res, 403, {
        error: `blocked webhook https://${'oapi.dingtalk.com'}/robot/send?${'access' + '_token'}=${leakedToken}`,
      })
    }, async (apiBase) => {
      const result = await runScript([
        '--env-file', envFile,
        '--status-helper', statusHelperPath,
        '--api-base', apiBase,
        '--auth-token-file', tokenFile,
        '--user-id', 'user-1',
        '--allow-blocked',
        '--output-json', outputJson,
        '--output-md', outputMd,
      ])

      assert.equal(result.status, 0, result.stderr || result.stdout)
      const summaryText = readFileSync(outputJson, 'utf8')
      const markdown = readFileSync(outputMd, 'utf8')
      assert.doesNotMatch(summaryText, new RegExp(leakedToken))
      assert.doesNotMatch(summaryText, new RegExp(leakedSecret))
      assert.doesNotMatch(summaryText, new RegExp(leakedJwt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      assert.doesNotMatch(markdown, new RegExp(leakedToken))
      assert.doesNotMatch(markdown, new RegExp(leakedSecret))
    })
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('release gate can skip admin API checks', async () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'app.env')
  const outputJson = path.join(tmpDir, 'summary.json')
  const outputMd = path.join(tmpDir, 'summary.md')
  try {
    writeEnv(envFile, [
      'DINGTALK_APP_KEY=unit-key',
      'DINGTALK_APP_SECRET=unit-secret',
      'DINGTALK_AGENT_ID=123456789',
    ])

    await withServer((req, res) => {
      if (req.url === '/api/health') return jsonResponse(res, 200, { status: 'ok', success: true })
      return jsonResponse(res, 500, { error: 'admin API should not be called' })
    }, async (apiBase) => {
      const result = await runScript([
        '--env-file', envFile,
        '--status-helper', statusHelperPath,
        '--api-base', apiBase,
        '--skip-admin-api',
        '--output-json', outputJson,
        '--output-md', outputMd,
      ])

      assert.equal(result.status, 0, result.stderr || result.stdout)
      const summary = readJson(outputJson)
      assert.equal(summary.status, 'pass')
      assert.equal(summary.skipAdminApi, true)
      assert.equal(summary.auth.skipped, true)
      assert.equal(summary.workNotification.skipped, true)
    })
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})
