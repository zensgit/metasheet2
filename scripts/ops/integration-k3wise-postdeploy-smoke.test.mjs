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
const DEFAULT_ADAPTERS = [
  'http',
  'plm:yuantus-wrapper',
  'erp:k3-wise-webapi',
  'erp:k3-wise-sqlserver',
]
const DEFAULT_ROUTES = [
  ['GET', '/api/integration/status'],
  ['GET', '/api/integration/external-systems'],
  ['POST', '/api/integration/external-systems'],
  ['GET', '/api/integration/external-systems/:id'],
  ['POST', '/api/integration/external-systems/:id/test'],
  ['GET', '/api/integration/pipelines'],
  ['POST', '/api/integration/pipelines'],
  ['GET', '/api/integration/pipelines/:id'],
  ['POST', '/api/integration/pipelines/:id/dry-run'],
  ['POST', '/api/integration/pipelines/:id/run'],
  ['GET', '/api/integration/runs'],
  ['GET', '/api/integration/dead-letters'],
  ['POST', '/api/integration/dead-letters/:id/replay'],
  ['GET', '/api/integration/staging/descriptors'],
  ['POST', '/api/integration/staging/install'],
]
const DEFAULT_STAGING_FIELDS = {
  plm_raw_items: [
    'sourceSystemId',
    'objectType',
    'sourceId',
    'revision',
    'code',
    'name',
    'rawPayload',
    'fetchedAt',
    'pipelineRunId',
  ],
  standard_materials: [
    'code',
    'name',
    'uom',
    'category',
    'status',
    'erpSyncStatus',
    'erpExternalId',
    'erpBillNo',
    'erpResponseCode',
    'erpResponseMessage',
    'lastSyncedAt',
  ],
  bom_cleanse: [
    'parentCode',
    'childCode',
    'quantity',
    'uom',
    'sequence',
    'revision',
    'validFrom',
    'validTo',
    'status',
  ],
  integration_exceptions: [
    'pipelineId',
    'runId',
    'idempotencyKey',
    'errorCode',
    'errorMessage',
    'sourcePayload',
    'transformedPayload',
    'status',
    'assignee',
    'note',
  ],
  integration_run_log: [
    'pipelineId',
    'runId',
    'mode',
    'triggeredBy',
    'status',
    'rowsRead',
    'rowsCleaned',
    'rowsWritten',
    'rowsFailed',
    'durationMs',
    'startedAt',
    'finishedAt',
    'errorSummary',
  ],
}
const DEFAULT_STAGING_DESCRIPTORS = [
  { id: 'plm_raw_items', name: 'PLM Raw Items', fields: DEFAULT_STAGING_FIELDS.plm_raw_items },
  { id: 'standard_materials', name: 'Standard Materials', fields: DEFAULT_STAGING_FIELDS.standard_materials },
  { id: 'bom_cleanse', name: 'BOM Cleanse', fields: DEFAULT_STAGING_FIELDS.bom_cleanse },
  { id: 'integration_exceptions', name: 'Integration Exceptions', fields: DEFAULT_STAGING_FIELDS.integration_exceptions },
  { id: 'integration_run_log', name: 'Integration Run Log', fields: DEFAULT_STAGING_FIELDS.integration_run_log },
]

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'integration-k3wise-postdeploy-smoke-'))
}

function runScript(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(options.env || {}),
      },
    })
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
      query: Object.fromEntries(url.searchParams.entries()),
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
      sendJson(res, 200, { success: true, user: { id: 'admin_1', role: 'admin', tenantId: 'tenant-smoke' } })
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
          adapters: options.integrationAdapters || DEFAULT_ADAPTERS,
          routes: (options.integrationRoutes || DEFAULT_ROUTES)
            .map(([method, routePath]) => ({ method, path: routePath })),
        },
      })
      return
    }

    if (
      req.method === 'GET' &&
      [
        '/api/integration/external-systems',
        '/api/integration/pipelines',
        '/api/integration/runs',
        '/api/integration/dead-letters',
      ].includes(url.pathname)
    ) {
      if (req.headers.authorization !== 'Bearer test.jwt.token') {
        sendJson(res, 401, { ok: false, error: { message: 'bad token' } })
        return
      }
      if (options.failControlPlanePath === url.pathname) {
        sendJson(res, 500, { ok: false, error: { message: `${url.pathname} unavailable` } })
        return
      }
      sendJson(res, 200, { ok: true, data: [] })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/integration/staging/descriptors') {
      if (req.headers.authorization !== 'Bearer test.jwt.token') {
        sendJson(res, 401, { ok: false, error: { message: 'bad token' } })
        return
      }
      sendJson(res, 200, {
        ok: true,
        data: options.stagingDescriptors || DEFAULT_STAGING_DESCRIPTORS,
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
    const routeCheck = evidence.checks.find((check) => check.id === 'integration-route-contract')
    assert.equal(routeCheck.status, 'pass')
    assert.equal(routeCheck.routesChecked, DEFAULT_ROUTES.length)
    for (const id of [
      'integration-list-external-systems',
      'integration-list-pipelines',
      'integration-list-runs',
      'integration-list-dead-letters',
    ]) {
      const check = evidence.checks.find((candidate) => candidate.id === id)
      assert.equal(check.status, 'pass')
      assert.equal(check.tenantId, 'tenant-smoke')
    }
    const stagingCheck = evidence.checks.find((check) => check.id === 'staging-descriptor-contract')
    assert.equal(stagingCheck.status, 'pass')
    assert.equal(
      stagingCheck.fieldsChecked,
      Object.values(DEFAULT_STAGING_FIELDS).reduce((sum, fields) => sum + fields.length, 0),
    )
    assert.ok(fake.requests.some((request) => request.pathname === '/api/auth/me' && request.authorization === 'Bearer test.jwt.token'))
    assert.ok(fake.requests.some((request) => request.pathname === '/api/integration/external-systems'))
    assert.ok(fake.requests.some((request) => request.pathname === '/api/integration/pipelines'))
    assert.ok(fake.requests.some((request) => request.pathname === '/api/integration/runs'))
    assert.ok(fake.requests.some((request) => request.pathname === '/api/integration/dead-letters'))
  } finally {
    await fake.close()
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('authenticated postdeploy smoke uses explicit tenant scope for control-plane list probes', async () => {
  const fake = createFakeServer()
  const baseUrl = await fake.listen()
  const outDir = makeTmpDir()
  try {
    const result = await runScript([
      '--base-url', baseUrl,
      '--auth-token', 'test.jwt.token',
      '--tenant-id', 'tenant-explicit',
      '--require-auth',
      '--out-dir', outDir,
    ])

    assert.equal(result.status, 0, result.stderr)
    const evidence = JSON.parse(readFileSync(path.join(outDir, 'integration-k3wise-postdeploy-smoke.json'), 'utf8'))
    for (const id of [
      'integration-list-external-systems',
      'integration-list-pipelines',
      'integration-list-runs',
      'integration-list-dead-letters',
    ]) {
      assert.equal(evidence.checks.find((check) => check.id === id).tenantId, 'tenant-explicit')
    }
    for (const pathname of [
      '/api/integration/external-systems',
      '/api/integration/pipelines',
      '/api/integration/runs',
      '/api/integration/dead-letters',
    ]) {
      const request = fake.requests.find((candidate) => candidate.pathname === pathname)
      assert.deepEqual(request.query, { tenantId: 'tenant-explicit', limit: '1' })
    }
  } finally {
    await fake.close()
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('authenticated postdeploy smoke falls back to tenant scope from environment', async () => {
  const fake = createFakeServer()
  const baseUrl = await fake.listen()
  const outDir = makeTmpDir()
  try {
    const result = await runScript([
      '--base-url', baseUrl,
      '--auth-token', 'test.jwt.token',
      '--require-auth',
      '--out-dir', outDir,
    ], {
      env: {
        METASHEET_TENANT_ID: 'tenant-env',
      },
    })

    assert.equal(result.status, 0, result.stderr)
    const evidence = JSON.parse(readFileSync(path.join(outDir, 'integration-k3wise-postdeploy-smoke.json'), 'utf8'))
    for (const id of [
      'integration-list-external-systems',
      'integration-list-pipelines',
      'integration-list-runs',
      'integration-list-dead-letters',
    ]) {
      assert.equal(evidence.checks.find((check) => check.id === id).tenantId, 'tenant-env')
    }
    for (const pathname of [
      '/api/integration/external-systems',
      '/api/integration/pipelines',
      '/api/integration/runs',
      '/api/integration/dead-letters',
    ]) {
      const request = fake.requests.find((candidate) => candidate.pathname === pathname)
      assert.deepEqual(request.query, { tenantId: 'tenant-env', limit: '1' })
    }
  } finally {
    await fake.close()
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('authenticated postdeploy smoke fails when a read-only control-plane endpoint fails', async () => {
  const fake = createFakeServer({ failControlPlanePath: '/api/integration/pipelines' })
  const baseUrl = await fake.listen()
  const outDir = makeTmpDir()
  try {
    const result = await runScript([
      '--base-url', baseUrl,
      '--auth-token', 'test.jwt.token',
      '--require-auth',
      '--out-dir', outDir,
    ])

    assert.equal(result.status, 1)
    assert.equal(result.stdout.includes('test.jwt.token'), false)
    assert.equal(result.stderr.includes('test.jwt.token'), false)
    const evidenceText = readFileSync(path.join(outDir, 'integration-k3wise-postdeploy-smoke.json'), 'utf8')
    assert.equal(evidenceText.includes('test.jwt.token'), false)
    const evidence = JSON.parse(evidenceText)
    assert.equal(evidence.ok, false)
    assert.equal(evidence.summary.fail, 1)
    assert.equal(evidence.checks.find((check) => check.id === 'integration-list-external-systems').status, 'pass')
    const pipelinesCheck = evidence.checks.find((check) => check.id === 'integration-list-pipelines')
    assert.equal(pipelinesCheck.status, 'fail')
    assert.match(pipelinesCheck.error, /\/api\/integration\/pipelines\?tenantId=tenant-smoke&limit=1 returned HTTP 500/)
  } finally {
    await fake.close()
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('authenticated postdeploy smoke fails when status omits a required source adapter', async () => {
  const fake = createFakeServer({
    integrationAdapters: ['http', 'erp:k3-wise-webapi', 'erp:k3-wise-sqlserver'],
  })
  const baseUrl = await fake.listen()
  const outDir = makeTmpDir()
  try {
    const result = await runScript([
      '--base-url', baseUrl,
      '--auth-token', 'test.jwt.token',
      '--require-auth',
      '--out-dir', outDir,
    ])

    assert.equal(result.status, 1)
    const evidence = JSON.parse(readFileSync(path.join(outDir, 'integration-k3wise-postdeploy-smoke.json'), 'utf8'))
    const routeCheck = evidence.checks.find((check) => check.id === 'integration-route-contract')
    assert.equal(routeCheck.status, 'fail')
    assert.match(routeCheck.error, /missing required adapters or routes/)
  } finally {
    await fake.close()
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('authenticated postdeploy smoke fails when status omits a required replay route', async () => {
  const fake = createFakeServer({
    integrationRoutes: DEFAULT_ROUTES.filter(
      ([method, routePath]) =>
        `${method} ${routePath}` !== 'POST /api/integration/dead-letters/:id/replay',
    ),
  })
  const baseUrl = await fake.listen()
  const outDir = makeTmpDir()
  try {
    const result = await runScript([
      '--base-url', baseUrl,
      '--auth-token', 'test.jwt.token',
      '--require-auth',
      '--out-dir', outDir,
    ])

    assert.equal(result.status, 1)
    const evidence = JSON.parse(readFileSync(path.join(outDir, 'integration-k3wise-postdeploy-smoke.json'), 'utf8'))
    const routeCheck = evidence.checks.find((check) => check.id === 'integration-route-contract')
    assert.equal(routeCheck.status, 'fail')
    assert.match(routeCheck.error, /missing required adapters or routes/)
    assert.deepEqual(routeCheck.details.missingRoutes, ['POST /api/integration/dead-letters/:id/replay'])
  } finally {
    await fake.close()
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('authenticated postdeploy smoke fails when a required staging descriptor is missing', async () => {
  const fake = createFakeServer({
    stagingDescriptors: DEFAULT_STAGING_DESCRIPTORS.filter((descriptor) => descriptor.id !== 'integration_exceptions'),
  })
  const baseUrl = await fake.listen()
  const outDir = makeTmpDir()
  try {
    const result = await runScript([
      '--base-url', baseUrl,
      '--auth-token', 'test.jwt.token',
      '--require-auth',
      '--out-dir', outDir,
    ])

    assert.equal(result.status, 1)
    const evidence = JSON.parse(readFileSync(path.join(outDir, 'integration-k3wise-postdeploy-smoke.json'), 'utf8'))
    const stagingCheck = evidence.checks.find((check) => check.id === 'staging-descriptor-contract')
    assert.equal(stagingCheck.status, 'fail')
    assert.match(stagingCheck.error, /missing staging descriptor integration_exceptions/)
  } finally {
    await fake.close()
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('authenticated postdeploy smoke fails when a required staging descriptor field is missing', async () => {
  const fake = createFakeServer({
    stagingDescriptors: DEFAULT_STAGING_DESCRIPTORS.map((descriptor) => {
      if (descriptor.id !== 'standard_materials') return descriptor
      return {
        ...descriptor,
        fields: descriptor.fields.filter((fieldId) => fieldId !== 'erpSyncStatus'),
      }
    }),
  })
  const baseUrl = await fake.listen()
  const outDir = makeTmpDir()
  try {
    const result = await runScript([
      '--base-url', baseUrl,
      '--auth-token', 'test.jwt.token',
      '--require-auth',
      '--out-dir', outDir,
    ])

    assert.equal(result.status, 1)
    const evidence = JSON.parse(readFileSync(path.join(outDir, 'integration-k3wise-postdeploy-smoke.json'), 'utf8'))
    const stagingCheck = evidence.checks.find((check) => check.id === 'staging-descriptor-contract')
    assert.equal(stagingCheck.status, 'fail')
    assert.match(stagingCheck.error, /missing required fields/)
    assert.deepEqual(stagingCheck.details.missingFields, {
      standard_materials: ['erpSyncStatus'],
    })
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
