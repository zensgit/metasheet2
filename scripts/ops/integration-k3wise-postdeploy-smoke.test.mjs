import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'integration-k3wise-postdeploy-smoke.mjs')

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'integration-k3wise-postdeploy-smoke-'))
}

function runScript(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`script timed out\nstdout=${stdout}\nstderr=${stderr}`))
    }, 15_000)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

function sendHtml(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'text/html')
  res.end(body)
}

function createFakeServer(options = {}) {
  const requests = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    requests.push({
      method: req.method,
      pathname: url.pathname,
      authorization: req.headers.authorization || '',
    })

    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, {
        status: 'ok',
        ok: true,
        success: true,
        plugins: 13,
        pluginsSummary: { total: 13, active: 13, failed: 0 },
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/integration/health') {
      if (options.protectIntegrationHealth && req.headers.authorization !== 'Bearer test.jwt.token') {
        sendJson(res, 401, { ok: false, error: { message: 'auth required' } })
        return
      }
      sendJson(res, 200, {
        ok: true,
        plugin: 'plugin-integration-core',
        milestone: 'M0-spike',
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/integrations/k3-wise') {
      sendHtml(res, 200, '<!doctype html><html><body><div id="app"></div><script src="/assets/app.js"></script></body></html>')
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/auth/me') {
      if (req.headers.authorization !== 'Bearer test.jwt.token') {
        sendJson(res, 401, { ok: false, error: { message: 'bad token' } })
        return
      }
      sendJson(res, 200, { success: true, user: { id: 'admin_1', role: 'admin' } })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/integration/status') {
      if (req.headers.authorization !== 'Bearer test.jwt.token') {
        sendJson(res, 401, { ok: false, error: { message: 'bad token' } })
        return
      }
      sendJson(res, 200, {
        ok: true,
        data: {
          adapters: ['http', 'plm:yuantus-wrapper', 'erp:k3-wise-webapi', 'erp:k3-wise-sqlserver'],
          routes: [
            ['GET', '/api/integration/status'],
            ['GET', '/api/integration/external-systems'],
            ['POST', '/api/integration/external-systems'],
            ['POST', '/api/integration/external-systems/:id/test'],
            ['GET', '/api/integration/pipelines'],
            ['POST', '/api/integration/pipelines'],
            ['POST', '/api/integration/pipelines/:id/dry-run'],
            ['POST', '/api/integration/pipelines/:id/run'],
            ['GET', '/api/integration/runs'],
            ['GET', '/api/integration/dead-letters'],
            ['GET', '/api/integration/staging/descriptors'],
            ['POST', '/api/integration/staging/install'],
          ].map(([method, routePath]) => ({ method, path: routePath })),
        },
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/integration/staging/descriptors') {
      if (req.headers.authorization !== 'Bearer test.jwt.token') {
        sendJson(res, 401, { ok: false, error: { message: 'bad token' } })
        return
      }
      sendJson(res, 200, {
        ok: true,
        data: [
          { id: 'standard_materials', name: 'Standard Materials' },
          { id: 'bom_cleanse', name: 'BOM Cleanse' },
        ],
      })
      return
    }

    sendJson(res, 404, { ok: false, error: { message: `not found: ${url.pathname}` } })
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

test('public postdeploy smoke passes without an auth token and skips authenticated contract checks', async () => {
  const fake = createFakeServer()
  const baseUrl = await fake.listen()
  const outDir = makeTmpDir()
  try {
    const result = await runScript([
      '--base-url', baseUrl,
      '--out-dir', outDir,
    ])

    assert.equal(result.status, 0, result.stderr)
    const stdout = JSON.parse(result.stdout)
    assert.equal(stdout.ok, true)
    assert.equal(stdout.authenticated, false)
    assert.equal(stdout.summary.fail, 0)
    assert.equal(stdout.summary.skipped, 1)
    assert.equal(stdout.summary.pass, 3)

    const evidence = JSON.parse(readFileSync(path.join(outDir, 'integration-k3wise-postdeploy-smoke.json'), 'utf8'))
    assert.equal(evidence.checks.find((check) => check.id === 'authenticated-integration-contract').status, 'skipped')
    assert.equal(evidence.checks.find((check) => check.id === 'k3-wise-frontend-route').status, 'pass')
    assert.ok(fake.requests.some((request) => request.pathname === '/api/integration/health'))
    assert.ok(fake.requests.some((request) => request.pathname === '/integrations/k3-wise'))
  } finally {
    await fake.close()
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('public postdeploy smoke skips plugin health when the deployment protects integration routes', async () => {
  const fake = createFakeServer({ protectIntegrationHealth: true })
  const baseUrl = await fake.listen()
  const outDir = makeTmpDir()
  try {
    const result = await runScript([
      '--base-url', baseUrl,
      '--out-dir', outDir,
    ])

    assert.equal(result.status, 0, result.stderr)
    const stdout = JSON.parse(result.stdout)
    assert.equal(stdout.ok, true)
    assert.equal(stdout.summary.fail, 0)
    assert.equal(stdout.summary.skipped, 2)

    const evidence = JSON.parse(readFileSync(path.join(outDir, 'integration-k3wise-postdeploy-smoke.json'), 'utf8'))
    assert.equal(evidence.checks.find((check) => check.id === 'integration-plugin-health').status, 'skipped')
    assert.equal(evidence.checks.find((check) => check.id === 'k3-wise-frontend-route').status, 'pass')
  } finally {
    await fake.close()
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('authenticated postdeploy smoke validates route and staging contracts without leaking token', async () => {
  const fake = createFakeServer()
  const baseUrl = await fake.listen()
  const outDir = makeTmpDir()
  const tokenPath = path.join(outDir, 'token.txt')
  writeFileSync(tokenPath, 'test.jwt.token\n')
  try {
    const result = await runScript([
      '--base-url', baseUrl,
      '--token-file', tokenPath,
      '--require-auth',
      '--out-dir', outDir,
    ])

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.includes('test.jwt.token'), false)
    assert.equal(result.stderr.includes('test.jwt.token'), false)

    const evidenceText = readFileSync(path.join(outDir, 'integration-k3wise-postdeploy-smoke.json'), 'utf8')
    assert.equal(evidenceText.includes('test.jwt.token'), false)
    const evidence = JSON.parse(evidenceText)
    assert.equal(evidence.authenticated, true)
    assert.equal(evidence.summary.fail, 0)
    assert.equal(evidence.checks.find((check) => check.id === 'integration-route-contract').status, 'pass')
    assert.equal(evidence.checks.find((check) => check.id === 'staging-descriptor-contract').status, 'pass')
    assert.ok(fake.requests.some((request) => request.pathname === '/api/auth/me' && request.authorization === 'Bearer test.jwt.token'))
  } finally {
    await fake.close()
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('require-auth turns missing token into a failing check', async () => {
  const fake = createFakeServer()
  const baseUrl = await fake.listen()
  const outDir = makeTmpDir()
  try {
    const result = await runScript([
      '--base-url', baseUrl,
      '--require-auth',
      '--out-dir', outDir,
    ])

    assert.equal(result.status, 1)
    const stdout = JSON.parse(result.stdout)
    assert.equal(stdout.ok, false)
    assert.equal(stdout.summary.fail, 1)
  } finally {
    await fake.close()
    rmSync(outDir, { recursive: true, force: true })
  }
})
