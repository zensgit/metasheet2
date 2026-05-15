import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'integration-k3wise-postdeploy-smoke.mjs')
const DEFAULT_ADAPTERS = [
  'http',
  'plm:yuantus-wrapper',
  'erp:k3-wise-webapi',
  'erp:k3-wise-sqlserver',
  'metasheet:staging',
  'metasheet:multitable',
]
const DEFAULT_ROUTES = [
  ['GET', '/api/integration/status'],
  ['GET', '/api/integration/adapters'],
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
const DEFAULT_ADAPTER_METADATA = [
  {
    kind: 'http',
    label: 'HTTP API',
    roles: ['source', 'target', 'bidirectional'],
    supports: ['testConnection', 'listObjects', 'getSchema', 'read', 'upsert'],
    advanced: false,
  },
  {
    kind: 'plm:yuantus-wrapper',
    label: 'Yuantus PLM',
    roles: ['source'],
    supports: ['testConnection', 'listObjects', 'getSchema', 'read'],
    advanced: false,
  },
  {
    kind: 'erp:k3-wise-webapi',
    label: 'K3 WISE WebAPI',
    roles: ['target'],
    supports: ['testConnection', 'listObjects', 'getSchema', 'upsert'],
    advanced: false,
  },
  {
    kind: 'erp:k3-wise-sqlserver',
    label: 'K3 WISE SQL Server Channel',
    roles: ['source', 'target'],
    supports: ['testConnection', 'listObjects', 'getSchema', 'read', 'upsert'],
    advanced: true,
  },
  {
    kind: 'metasheet:staging',
    label: 'MetaSheet staging multitable',
    roles: ['source'],
    supports: ['testConnection', 'listObjects', 'getSchema', 'read'],
    advanced: false,
    guardrails: {
      read: {
        hostOwned: true,
        dryRunFriendly: true,
        noExternalNetwork: true,
      },
      write: {
        supported: false,
      },
    },
  },
  {
    kind: 'metasheet:multitable',
    label: 'MetaSheet multitable',
    roles: ['target'],
    supports: ['testConnection', 'listObjects', 'getSchema', 'upsert'],
    advanced: false,
    guardrails: {
      read: {
        supported: false,
      },
      write: {
        hostOwned: true,
        pluginScopedSheetsOnly: true,
        supportsAppend: true,
        supportsUpsertByKey: true,
      },
    },
  },
]
const DEFAULT_STAGING_FIELD_DETAILS = {
  plm_raw_items: {
    sourceSystemId: { type: 'string' },
    objectType: { type: 'string' },
    sourceId: { type: 'string' },
    revision: { type: 'string' },
    code: { type: 'string' },
    name: { type: 'string' },
    rawPayload: { type: 'string' },
    fetchedAt: { type: 'date' },
    pipelineRunId: { type: 'string' },
  },
  standard_materials: {
    code: { type: 'string' },
    name: { type: 'string' },
    uom: { type: 'string' },
    category: { type: 'string' },
    status: { type: 'select', options: ['draft', 'active', 'obsolete'] },
    erpSyncStatus: { type: 'select', options: ['pending', 'synced', 'failed'] },
    erpExternalId: { type: 'string' },
    erpBillNo: { type: 'string' },
    erpResponseCode: { type: 'string' },
    erpResponseMessage: { type: 'string' },
    lastSyncedAt: { type: 'date' },
  },
  bom_cleanse: {
    parentCode: { type: 'string' },
    childCode: { type: 'string' },
    quantity: { type: 'number' },
    uom: { type: 'string' },
    sequence: { type: 'number' },
    revision: { type: 'string' },
    validFrom: { type: 'date' },
    validTo: { type: 'date' },
    status: { type: 'select', options: ['draft', 'active', 'obsolete'] },
  },
  integration_exceptions: {
    pipelineId: { type: 'string' },
    runId: { type: 'string' },
    idempotencyKey: { type: 'string' },
    errorCode: { type: 'string' },
    errorMessage: { type: 'string' },
    sourcePayload: { type: 'string' },
    transformedPayload: { type: 'string' },
    status: { type: 'select', options: ['open', 'in_review', 'replayed', 'discarded'] },
    assignee: { type: 'string' },
    note: { type: 'string' },
  },
  integration_run_log: {
    pipelineId: { type: 'string' },
    runId: { type: 'string' },
    mode: { type: 'select', options: ['incremental', 'full', 'manual', 'replay'] },
    triggeredBy: { type: 'string' },
    status: { type: 'select', options: ['pending', 'running', 'succeeded', 'partial', 'failed', 'cancelled'] },
    rowsRead: { type: 'number' },
    rowsCleaned: { type: 'number' },
    rowsWritten: { type: 'number' },
    rowsFailed: { type: 'number' },
    durationMs: { type: 'number' },
    startedAt: { type: 'date' },
    finishedAt: { type: 'date' },
    errorSummary: { type: 'string' },
  },
}
const DEFAULT_STAGING_FIELDS = Object.fromEntries(
  Object.entries(DEFAULT_STAGING_FIELD_DETAILS).map(([descriptorId, fields]) => [descriptorId, Object.keys(fields)]),
)
function makeFieldDetails(descriptorId) {
  return Object.entries(DEFAULT_STAGING_FIELD_DETAILS[descriptorId]).map(([id, detail]) => ({
    id,
    ...detail,
  }))
}
const DEFAULT_STAGING_DESCRIPTORS = [
  { id: 'plm_raw_items', name: 'PLM Raw Items', fields: DEFAULT_STAGING_FIELDS.plm_raw_items, fieldDetails: makeFieldDetails('plm_raw_items') },
  { id: 'standard_materials', name: 'Standard Materials', fields: DEFAULT_STAGING_FIELDS.standard_materials, fieldDetails: makeFieldDetails('standard_materials') },
  { id: 'bom_cleanse', name: 'BOM Cleanse', fields: DEFAULT_STAGING_FIELDS.bom_cleanse, fieldDetails: makeFieldDetails('bom_cleanse') },
  { id: 'integration_exceptions', name: 'Integration Exceptions', fields: DEFAULT_STAGING_FIELDS.integration_exceptions, fieldDetails: makeFieldDetails('integration_exceptions') },
  { id: 'integration_run_log', name: 'Integration Run Log', fields: DEFAULT_STAGING_FIELDS.integration_run_log, fieldDetails: makeFieldDetails('integration_run_log') },
]
const DEFAULT_SYSTEMS = [
  {
    id: 'staging_source_1',
    tenantId: 'tenant-smoke',
    workspaceId: null,
    name: 'MetaSheet Staging Source',
    kind: 'metasheet:staging',
    role: 'source',
    status: 'active',
  },
  {
    id: 'k3_target_1',
    tenantId: 'tenant-smoke',
    workspaceId: null,
    name: 'K3 WISE WebAPI',
    kind: 'erp:k3-wise-webapi',
    role: 'target',
    status: 'active',
  },
]
const SQL_EXECUTOR_MISSING_SYSTEM = {
  id: 'k3_sql_source_1',
  tenantId: 'tenant-smoke',
  workspaceId: null,
  name: 'K3 SQL Read Channel',
  kind: 'erp:k3-wise-sqlserver',
  role: 'source',
  status: 'error',
  lastError: 'SQLSERVER_EXECUTOR_MISSING: inject queryExecutor when creating K3WiseSqlServerChannel',
}
const SQL_EXECUTOR_READY_SYSTEM = {
  ...SQL_EXECUTOR_MISSING_SYSTEM,
  status: 'active',
  lastError: null,
}
const DEFAULT_STAGING_OBJECTS = [
  {
    name: 'standard_materials',
    label: 'Standard Materials',
    operations: ['read'],
    schema: makeFieldDetails('standard_materials').map((field) => ({ name: field.id, ...field })),
  },
]
const DEFAULT_K3_OBJECTS = [
  {
    name: 'material',
    label: 'K3 WISE Material',
    operations: ['upsert'],
    schema: [
      { name: 'FNumber', label: 'Material Code', type: 'string', required: true },
      { name: 'FName', label: 'Material Name', type: 'string', required: true },
      { name: 'FBaseUnitID', label: 'Base Unit', type: 'string' },
    ],
  },
]

function defaultStagingInstallResult(projectId = 'tenant-smoke:integration-core') {
  const targets = [
    {
      id: 'standard_materials',
      name: 'Standard Materials',
      sheetId: 'sheet_standard_materials',
      viewId: 'view_standard_materials',
      baseId: 'base_integration_core',
      openLink: '/multitable/sheet_standard_materials/view_standard_materials?baseId=base_integration_core',
    },
    {
      id: 'bom_cleanse',
      name: 'BOM Cleanse',
      sheetId: 'sheet_bom_cleanse',
      viewId: 'view_bom_cleanse',
      baseId: 'base_integration_core',
      openLink: '/multitable/sheet_bom_cleanse/view_bom_cleanse?baseId=base_integration_core',
    },
  ]
  return {
    projectId,
    sheetIds: {
      plm_raw_items: 'sheet_plm_raw_items',
      standard_materials: 'sheet_standard_materials',
      bom_cleanse: 'sheet_bom_cleanse',
      integration_exceptions: 'sheet_integration_exceptions',
      integration_run_log: 'sheet_integration_run_log',
    },
    viewIds: {
      standard_materials: 'view_standard_materials',
      bom_cleanse: 'view_bom_cleanse',
    },
    openLinks: {
      standard_materials: '/multitable/sheet_standard_materials/view_standard_materials?baseId=base_integration_core',
      bom_cleanse: '/multitable/sheet_bom_cleanse/view_bom_cleanse?baseId=base_integration_core',
    },
    targets,
    warnings: [],
  }
}

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

function readRequestBody(req) {
  return new Promise((resolve) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      if (!body) {
        resolve(null)
        return
      }
      try {
        resolve(JSON.parse(body))
      } catch {
        resolve({ raw: body })
      }
    })
  })
}

function createFakeServer(options = {}) {
  const requests = []
  const externalSystems = Array.isArray(options.externalSystems)
    ? options.externalSystems.map((system) => ({ ...system }))
    : []
  const server = http.createServer(async (req, res) => {
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

    if (req.method === 'GET' && url.pathname === '/integrations/workbench') {
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

    if (req.method === 'GET' && url.pathname === '/api/integration/adapters') {
      if (req.headers.authorization !== 'Bearer test.jwt.token') {
        sendJson(res, 401, { ok: false, error: { message: 'bad token' } })
        return
      }
      sendJson(res, 200, {
        ok: true,
        data: options.integrationAdapterMetadata || DEFAULT_ADAPTER_METADATA,
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/integration/external-systems') {
      if (req.headers.authorization !== 'Bearer test.jwt.token') {
        sendJson(res, 401, { ok: false, error: { message: 'bad token' } })
        return
      }
      if (options.failControlPlanePath === url.pathname) {
        sendJson(res, 500, { ok: false, error: { message: `${url.pathname} unavailable` } })
        return
      }
      sendJson(res, 200, { ok: true, data: externalSystems })
      return
    }

    if (
      req.method === 'GET' &&
      [
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

    const externalSystemRoute = url.pathname.match(/^\/api\/integration\/external-systems\/([^/]+)\/(objects|schema)$/)
    if (req.method === 'GET' && externalSystemRoute) {
      if (req.headers.authorization !== 'Bearer test.jwt.token') {
        sendJson(res, 401, { ok: false, error: { message: 'bad token' } })
        return
      }
      const systemId = decodeURIComponent(externalSystemRoute[1])
      const action = externalSystemRoute[2]
      const system = externalSystems.find((candidate) => candidate.id === systemId)
      if (!system) {
        sendJson(res, 404, { ok: false, error: { message: `system not found: ${systemId}` } })
        return
      }
      if (system.kind === 'metasheet:staging' && action === 'objects') {
        sendJson(res, 200, { ok: true, data: options.stagingObjects || DEFAULT_STAGING_OBJECTS })
        return
      }
      if (system.kind === 'metasheet:staging' && action === 'schema') {
        sendJson(res, 200, {
          ok: true,
          data: options.stagingSchema || {
            object: url.searchParams.get('object') || 'standard_materials',
            fields: DEFAULT_STAGING_OBJECTS[0].schema,
          },
        })
        return
      }
      if (system.kind === 'erp:k3-wise-webapi' && action === 'objects') {
        sendJson(res, 200, { ok: true, data: options.k3Objects || DEFAULT_K3_OBJECTS })
        return
      }
      if (system.kind === 'erp:k3-wise-webapi' && action === 'schema') {
        sendJson(res, 200, {
          ok: true,
          data: options.k3Schema || {
            object: url.searchParams.get('object') || 'material',
            fields: DEFAULT_K3_OBJECTS[0].schema,
            template: { id: 'material', bodyKey: 'Data' },
          },
        })
        return
      }
      sendJson(res, 400, { ok: false, error: { message: `unsupported system action: ${system.kind}/${action}` } })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/integration/external-systems') {
      if (req.headers.authorization !== 'Bearer test.jwt.token') {
        sendJson(res, 401, { ok: false, error: { message: 'bad token' } })
        return
      }
      const body = await readRequestBody(req)
      requests[requests.length - 1].body = body
      const id = body?.id || `system_${externalSystems.length + 1}`
      const saved = { ...body, id }
      const index = externalSystems.findIndex((system) => system.id === id)
      if (index >= 0) externalSystems[index] = saved
      else externalSystems.push(saved)
      sendJson(res, 201, { ok: true, data: saved })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/integration/pipelines') {
      if (req.headers.authorization !== 'Bearer test.jwt.token') {
        sendJson(res, 401, { ok: false, error: { message: 'bad token' } })
        return
      }
      const body = await readRequestBody(req)
      requests[requests.length - 1].body = body
      if (options.failPipelineSave) {
        sendJson(res, 500, { ok: false, error: { code: '22P02', message: '类型json的输入语法无效' } })
        return
      }
      sendJson(res, 201, {
        ok: true,
        data: {
          ...body,
          id: body?.id || 'pipe_smoke',
          fieldMappings: Array.isArray(body?.fieldMappings) ? body.fieldMappings : [],
        },
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/integration/staging/install') {
      if (req.headers.authorization !== 'Bearer test.jwt.token') {
        sendJson(res, 401, { ok: false, error: { message: 'bad token' } })
        return
      }
      const body = await readRequestBody(req)
      requests[requests.length - 1].body = body
      if (options.failStagingInstall) {
        sendJson(res, 500, { ok: false, error: { code: 'STAGING_INSTALL_EMPTY', message: 'no staging sheets provisioned' } })
        return
      }
      const projectId = body?.projectId || `${body?.tenantId || 'tenant-smoke'}:integration-core`
      sendJson(res, 201, { ok: true, data: options.stagingInstallResult || defaultStagingInstallResult(projectId) })
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
    assert.equal(stdout.summary.pass, 4)
    assert.deepEqual(stdout.signoff, {
      internalTrial: 'blocked',
      reason: 'authenticated checks did not run',
    })

    const evidence = JSON.parse(readFileSync(path.join(outDir, 'integration-k3wise-postdeploy-smoke.json'), 'utf8'))
    assert.deepEqual(evidence.signoff, {
      internalTrial: 'blocked',
      reason: 'authenticated checks did not run',
    })
    assert.equal(evidence.checks.find((check) => check.id === 'authenticated-integration-contract').status, 'skipped')
    assert.equal(evidence.checks.find((check) => check.id === 'k3-wise-frontend-route').status, 'pass')
    assert.equal(evidence.checks.find((check) => check.id === 'data-factory-frontend-route').status, 'pass')
    assert.ok(fake.requests.some((request) => request.pathname === '/api/integration/health'))
    assert.ok(fake.requests.some((request) => request.pathname === '/integrations/k3-wise'))
    assert.ok(fake.requests.some((request) => request.pathname === '/integrations/workbench'))
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
    assert.equal(evidence.checks.find((check) => check.id === 'data-factory-frontend-route').status, 'pass')
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
    const stdout = JSON.parse(result.stdout)
    assert.deepEqual(stdout.signoff, {
      internalTrial: 'pass',
      reason: 'authenticated smoke passed',
    })
    assert.deepEqual(evidence.signoff, {
      internalTrial: 'pass',
      reason: 'authenticated smoke passed',
    })
    assert.equal(evidence.summary.fail, 0)
    const routeCheck = evidence.checks.find((check) => check.id === 'integration-route-contract')
    assert.equal(routeCheck.status, 'pass')
    assert.equal(routeCheck.routesChecked, DEFAULT_ROUTES.length)
    assert.equal(routeCheck.adaptersChecked, DEFAULT_ADAPTERS.length)
    const adapterDiscoveryCheck = evidence.checks.find((check) => check.id === 'data-factory-adapter-discovery')
    assert.equal(adapterDiscoveryCheck.status, 'pass')
    assert.equal(adapterDiscoveryCheck.adaptersChecked, 2)
    assert.ok(adapterDiscoveryCheck.adapters.includes('metasheet:staging'))
    assert.ok(adapterDiscoveryCheck.adapters.includes('metasheet:multitable'))
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
    assert.equal(stagingCheck.fieldDetailsChecked, stagingCheck.fieldsChecked)
    assert.ok(fake.requests.some((request) => request.pathname === '/api/auth/me' && request.authorization === 'Bearer test.jwt.token'))
    assert.ok(fake.requests.some((request) => request.pathname === '/api/integration/adapters'))
    assert.ok(fake.requests.some((request) => request.pathname === '/api/integration/external-systems'))
    assert.ok(fake.requests.some((request) => request.pathname === '/api/integration/pipelines'))
    assert.ok(fake.requests.some((request) => request.pathname === '/api/integration/runs'))
    assert.ok(fake.requests.some((request) => request.pathname === '/api/integration/dead-letters'))
  } finally {
    await fake.close()
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('authenticated postdeploy smoke records missing SQL executor as a non-blocking diagnostic', async () => {
  const fake = createFakeServer({ externalSystems: [...DEFAULT_SYSTEMS, SQL_EXECUTOR_MISSING_SYSTEM] })
  const baseUrl = await fake.listen()
  const outDir = makeTmpDir()
  try {
    const result = await runScript([
      '--base-url', baseUrl,
      '--auth-token', 'test.jwt.token',
      '--require-auth',
      '--out-dir', outDir,
    ])

    assert.equal(result.status, 0, result.stderr)
    const evidenceText = readFileSync(path.join(outDir, 'integration-k3wise-postdeploy-smoke.json'), 'utf8')
    assert.equal(evidenceText.includes('test.jwt.token'), false)
    const evidence = JSON.parse(evidenceText)
    assert.equal(evidence.summary.fail, 0)
    assert.deepEqual(evidence.signoff, {
      internalTrial: 'pass',
      reason: 'authenticated smoke passed',
    })
    const sqlDiagnostic = evidence.checks.find((check) => check.id === 'sqlserver-executor-availability')
    assert.equal(sqlDiagnostic.status, 'skipped')
    assert.equal(sqlDiagnostic.code, 'SQLSERVER_EXECUTOR_MISSING')
    assert.equal(sqlDiagnostic.systemsChecked, 1)
    assert.deepEqual(sqlDiagnostic.blockedSystems, [
      {
        id: 'k3_sql_source_1',
        name: 'K3 SQL Read Channel',
        role: 'source',
        status: 'error',
      },
    ])
    assert.doesNotMatch(JSON.stringify(sqlDiagnostic.blockedSystems), /lastError|queryExecutor/)
    assert.ok(fake.requests.some((request) => (
      request.pathname === '/api/integration/external-systems' &&
      request.query.tenantId === 'tenant-smoke' &&
      request.query.limit === '100'
    )))
  } finally {
    await fake.close()
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('authenticated postdeploy smoke passes SQL executor diagnostic when SQL source is active', async () => {
  const fake = createFakeServer({ externalSystems: [...DEFAULT_SYSTEMS, SQL_EXECUTOR_READY_SYSTEM] })
  const baseUrl = await fake.listen()
  const outDir = makeTmpDir()
  try {
    const result = await runScript([
      '--base-url', baseUrl,
      '--auth-token', 'test.jwt.token',
      '--require-auth',
      '--out-dir', outDir,
    ])

    assert.equal(result.status, 0, result.stderr)
    const evidence = JSON.parse(readFileSync(path.join(outDir, 'integration-k3wise-postdeploy-smoke.json'), 'utf8'))
    const sqlDiagnostic = evidence.checks.find((check) => check.id === 'sqlserver-executor-availability')
    assert.equal(sqlDiagnostic.status, 'pass')
    assert.equal(sqlDiagnostic.systemsChecked, 1)
    assert.deepEqual(sqlDiagnostic.readySystems, [
      {
        id: 'k3_sql_source_1',
        name: 'K3 SQL Read Channel',
        role: 'source',
        status: 'active',
      },
    ])
  } finally {
    await fake.close()
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('issue1542 workbench smoke verifies staging schema and draft pipeline save', async () => {
  const fake = createFakeServer({ externalSystems: DEFAULT_SYSTEMS })
  const baseUrl = await fake.listen()
  const outDir = makeTmpDir()
  try {
    const result = await runScript([
      '--base-url', baseUrl,
      '--auth-token', 'test.jwt.token',
      '--require-auth',
      '--issue1542-workbench-smoke',
      '--out-dir', outDir,
    ])

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.includes('test.jwt.token'), false)
    const evidenceText = readFileSync(path.join(outDir, 'integration-k3wise-postdeploy-smoke.json'), 'utf8')
    assert.equal(evidenceText.includes('test.jwt.token'), false)
    const evidence = JSON.parse(evidenceText)
    assert.equal(evidence.summary.fail, 0)
    assert.equal(evidence.checks.find((check) => check.id === 'issue1542-system-readiness').status, 'pass')
    const stagingSchema = evidence.checks.find((check) => check.id === 'issue1542-staging-source-schema')
    assert.equal(stagingSchema.status, 'pass')
    assert.equal(stagingSchema.object, 'standard_materials')
    assert.ok(stagingSchema.fieldCount >= 3)
    const k3Schema = evidence.checks.find((check) => check.id === 'issue1542-k3-material-schema')
    assert.equal(k3Schema.status, 'pass')
    assert.equal(k3Schema.object, 'material')
    const pipelineSave = evidence.checks.find((check) => check.id === 'issue1542-pipeline-save')
    assert.equal(pipelineSave.status, 'pass')
    assert.equal(pipelineSave.pipelineId, 'issue1542_postdeploy_staging_material_smoke')
    assert.equal(pipelineSave.fieldMappings, 3)

    const pipelineRequest = fake.requests.find((request) => request.method === 'POST' && request.pathname === '/api/integration/pipelines')
    assert.ok(pipelineRequest, 'issue1542 smoke saves a draft pipeline metadata record')
    assert.ok(fake.requests.some((request) => request.pathname === '/api/integration/external-systems/staging_source_1/schema'))
    assert.ok(fake.requests.some((request) => request.pathname === '/api/integration/external-systems/k3_target_1/schema'))
  } finally {
    await fake.close()
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('issue1542 install-staging smoke creates and uses the installed staging source before schema and pipeline checks', async () => {
  const fake = createFakeServer({ externalSystems: DEFAULT_SYSTEMS })
  const baseUrl = await fake.listen()
  const outDir = makeTmpDir()
  try {
    const result = await runScript([
      '--base-url', baseUrl,
      '--auth-token', 'test.jwt.token',
      '--tenant-id', 'tenant-smoke',
      '--require-auth',
      '--issue1542-workbench-smoke',
      '--issue1542-install-staging',
      '--out-dir', outDir,
    ])

    assert.equal(result.status, 0, result.stderr)
    const evidence = JSON.parse(readFileSync(path.join(outDir, 'integration-k3wise-postdeploy-smoke.json'), 'utf8'))
    const installCheck = evidence.checks.find((check) => check.id === 'issue1542-staging-install')
    assert.equal(installCheck.status, 'pass')
    assert.equal(installCheck.projectId, 'tenant-smoke:integration-core')
    assert.equal(installCheck.sourceSystemId, 'metasheet_staging_tenant-smoke_integration-core')
    assert.ok(installCheck.objects.includes('standard_materials'))

    assert.equal(evidence.checks.find((check) => check.id === 'issue1542-system-readiness').status, 'pass')
    assert.equal(evidence.checks.find((check) => check.id === 'issue1542-system-readiness').stagingSourceId, 'metasheet_staging_tenant-smoke_integration-core')
    assert.equal(evidence.checks.find((check) => check.id === 'issue1542-staging-source-schema').status, 'pass')
    assert.equal(evidence.checks.find((check) => check.id === 'issue1542-pipeline-save').status, 'pass')

    const stagingInstallRequest = fake.requests.find((request) => request.method === 'POST' && request.pathname === '/api/integration/staging/install')
    assert.ok(stagingInstallRequest, 'install-staging flag calls staging install')
    assert.deepEqual(stagingInstallRequest.body, { tenantId: 'tenant-smoke', workspaceId: null })

    const externalSystemRequest = fake.requests.find((request) => request.method === 'POST' && request.pathname === '/api/integration/external-systems')
    assert.ok(externalSystemRequest, 'install-staging flag upserts a staging source system')
    assert.equal(externalSystemRequest.body.kind, 'metasheet:staging')
    assert.equal(externalSystemRequest.body.projectId, 'tenant-smoke:integration-core')
    assert.equal(externalSystemRequest.body.config.objects.standard_materials.sheetId, 'sheet_standard_materials')
    assert.ok(Array.isArray(externalSystemRequest.body.config.objects.standard_materials.fieldDetails))

    const pipelineRequest = fake.requests.find((request) => request.method === 'POST' && request.pathname === '/api/integration/pipelines')
    assert.equal(pipelineRequest.body.sourceSystemId, 'metasheet_staging_tenant-smoke_integration-core')
    assert.ok(fake.requests.some((request) => request.pathname === '/api/integration/external-systems/metasheet_staging_tenant-smoke_integration-core/schema'))
    assert.equal(fake.requests.some((request) => request.pathname === '/api/integration/external-systems/staging_source_1/schema'), false)
  } finally {
    await fake.close()
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('issue1542 install-staging smoke fails clearly when staging install fails', async () => {
  const fake = createFakeServer({
    externalSystems: DEFAULT_SYSTEMS.filter((system) => system.kind !== 'metasheet:staging'),
    failStagingInstall: true,
  })
  const baseUrl = await fake.listen()
  const outDir = makeTmpDir()
  try {
    const result = await runScript([
      '--base-url', baseUrl,
      '--auth-token', 'test.jwt.token',
      '--tenant-id', 'tenant-smoke',
      '--require-auth',
      '--issue1542-workbench-smoke',
      '--issue1542-install-staging',
      '--out-dir', outDir,
    ])

    assert.equal(result.status, 1)
    const evidence = JSON.parse(readFileSync(path.join(outDir, 'integration-k3wise-postdeploy-smoke.json'), 'utf8'))
    const installCheck = evidence.checks.find((check) => check.id === 'issue1542-staging-install')
    assert.equal(installCheck.status, 'fail')
    assert.match(installCheck.error, /\/api\/integration\/staging\/install returned HTTP 500/)
    assert.equal(evidence.checks.some((check) => check.id === 'issue1542-pipeline-save'), false)
  } finally {
    await fake.close()
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('issue1542 workbench smoke fails when staging schema is empty', async () => {
  const fake = createFakeServer({
    externalSystems: DEFAULT_SYSTEMS,
    stagingSchema: { object: 'standard_materials', fields: [] },
  })
  const baseUrl = await fake.listen()
  const outDir = makeTmpDir()
  try {
    const result = await runScript([
      '--base-url', baseUrl,
      '--auth-token', 'test.jwt.token',
      '--require-auth',
      '--issue1542-workbench-smoke',
      '--out-dir', outDir,
    ])

    assert.equal(result.status, 1)
    const evidence = JSON.parse(readFileSync(path.join(outDir, 'integration-k3wise-postdeploy-smoke.json'), 'utf8'))
    const stagingSchema = evidence.checks.find((check) => check.id === 'issue1542-staging-source-schema')
    assert.equal(stagingSchema.status, 'fail')
    assert.match(stagingSchema.error, /schema is missing required fields/)
    assert.equal(stagingSchema.details.fieldCount, 0)
  } finally {
    await fake.close()
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('issue1542 workbench smoke fails clearly when pipeline save still hits JSONB 22P02', async () => {
  const fake = createFakeServer({
    externalSystems: DEFAULT_SYSTEMS,
    failPipelineSave: true,
  })
  const baseUrl = await fake.listen()
  const outDir = makeTmpDir()
  try {
    const result = await runScript([
      '--base-url', baseUrl,
      '--auth-token', 'test.jwt.token',
      '--require-auth',
      '--issue1542-workbench-smoke',
      '--out-dir', outDir,
    ])

    assert.equal(result.status, 1)
    assert.equal(result.stdout.includes('test.jwt.token'), false)
    assert.equal(result.stderr.includes('test.jwt.token'), false)
    const evidence = JSON.parse(readFileSync(path.join(outDir, 'integration-k3wise-postdeploy-smoke.json'), 'utf8'))
    const pipelineSave = evidence.checks.find((check) => check.id === 'issue1542-pipeline-save')
    assert.equal(pipelineSave.status, 'fail')
    assert.match(pipelineSave.error, /\/api\/integration\/pipelines returned HTTP 500/)
    assert.equal(pipelineSave.details.body.error.code, '22P02')
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
    assert.deepEqual(evidence.signoff, {
      internalTrial: 'blocked',
      reason: 'one or more smoke checks failed',
    })
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

test('authenticated postdeploy smoke fails when Data Factory adapter metadata loses staging write guardrails', async () => {
  const fake = createFakeServer({
    integrationAdapterMetadata: DEFAULT_ADAPTER_METADATA.map((adapter) => {
      if (adapter.kind !== 'metasheet:staging') return adapter
      return {
        ...adapter,
        guardrails: {
          read: adapter.guardrails.read,
          write: { supported: true },
        },
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
    const adapterCheck = evidence.checks.find((check) => check.id === 'data-factory-adapter-discovery')
    assert.equal(adapterCheck.status, 'fail')
    assert.match(adapterCheck.error, /adapter discovery is missing required Data Factory multitable metadata/)
    assert.deepEqual(adapterCheck.details.invalidAdapters, {
      'metasheet:staging': {
        'guardrails.write.supported': 'expected false but got true',
      },
    })
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
        fieldDetails: descriptor.fieldDetails.filter((field) => field.id !== 'erpSyncStatus'),
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
    assert.match(stagingCheck.error, /required field contract/)
    assert.deepEqual(stagingCheck.details.missingFields, {
      standard_materials: ['erpSyncStatus'],
    })
  } finally {
    await fake.close()
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('authenticated postdeploy smoke fails when a required staging field detail is wrong', async () => {
  const fake = createFakeServer({
    stagingDescriptors: DEFAULT_STAGING_DESCRIPTORS.map((descriptor) => {
      if (descriptor.id !== 'standard_materials') return descriptor
      return {
        ...descriptor,
        fieldDetails: descriptor.fieldDetails.map((field) => {
          if (field.id !== 'status') return field
          return { ...field, type: 'string', options: ['draft'] }
        }),
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
    assert.deepEqual(stagingCheck.details.invalidFields, {
      standard_materials: {
        status: [
          'expected type select but got string',
          'missing options: active, obsolete',
        ],
      },
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

test('missing token file still writes failure evidence for signoff audit', async () => {
  const fake = createFakeServer()
  const baseUrl = await fake.listen()
  const outDir = makeTmpDir()
  try {
    const result = await runScript([
      '--base-url', baseUrl,
      '--token-file', path.join(outDir, 'missing-token.txt'),
      '--require-auth',
      '--out-dir', outDir,
    ])

    assert.equal(result.status, 1)
    const stdout = JSON.parse(result.stdout)
    assert.equal(stdout.ok, false)
    assert.equal(stdout.authenticated, false)
    assert.equal(stdout.summary.fail, 2)
    assert.deepEqual(stdout.signoff, {
      internalTrial: 'blocked',
      reason: 'one or more smoke checks failed',
    })

    const evidencePath = path.join(outDir, 'integration-k3wise-postdeploy-smoke.json')
    const markdownPath = path.join(outDir, 'integration-k3wise-postdeploy-smoke.md')
    const evidenceText = readFileSync(evidencePath, 'utf8')
    const markdownText = readFileSync(markdownPath, 'utf8')
    const evidence = JSON.parse(evidenceText)
    const tokenCheck = evidence.checks.find((check) => check.id === 'auth-token')
    assert.equal(tokenCheck.status, 'fail')
    assert.match(tokenCheck.error, /ENOENT/)
    assert.equal(evidence.checks.find((check) => check.id === 'api-health').status, 'pass')
    assert.equal(evidence.checks.find((check) => check.id === 'authenticated-integration-contract').status, 'fail')
    assert.match(markdownText, /auth-token/)
    assert.match(markdownText, /authenticated-integration-contract/)
  } finally {
    await fake.close()
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('postdeploy smoke rejects inline base URL credentials without leaking them', async () => {
  const secretPassword = 'super-secret-inline-password'
  const result = await runScript([
    '--base-url',
    `https://admin:${secretPassword}@metasheet.example.test`,
  ])

  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--base-url must not contain inline credentials/)
  assert.doesNotMatch(result.stderr, new RegExp(secretPassword))
  assert.match(result.stderr, /%3Credacted-credentials%3E/)
})

test('postdeploy smoke rejects query and hash base URLs without leaking them', async () => {
  const secretQuery = 'super-secret-query-value'
  const secretHash = 'super-secret-hash-value'
  const result = await runScript([
    '--base-url',
    `https://metasheet.example.test?token=${secretQuery}#${secretHash}`,
  ])

  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--base-url must not contain query string or hash/)
  assert.doesNotMatch(result.stderr, new RegExp(secretQuery))
  assert.doesNotMatch(result.stderr, new RegExp(secretHash))
  assert.match(result.stderr, /token=%3Credacted%3E/)
  assert.match(result.stderr, /#%3Credacted%3E/)
})

test('postdeploy smoke markdown escapes table-breaking evidence values', async () => {
  const { renderMarkdown } = await import(pathToFileURL(scriptPath).href)
  const markdown = renderMarkdown({
    ok: false,
    generatedAt: '2026-05-07T09:00:00.000Z\nsecond line',
    baseUrl: 'https://metasheet.example.test/k3`wise\npreview',
    authenticated: true,
    signoff: {
      internalTrial: 'blocked',
      reason: 'route check | failed\nsee evidence',
    },
    summary: { pass: 1, skipped: 0, fail: 1 },
    checks: [
      {
        id: 'route|check\n`alpha`',
        status: 'fail\nretry',
        error: 'line one | line two\n`raw` value',
      },
      {
        id: 'object-detail',
        status: 'pass',
        details: {
          route: '/api/integration/status|debug',
          note: 'ok\nnext',
        },
      },
    ],
  })

  assert.match(markdown, /Generated at: `2026-05-07T09:00:00.000Z second line`/)
  assert.match(markdown, /Base URL: ``https:\/\/metasheet\.example\.test\/k3`wise preview``/)
  assert.match(markdown, /Internal trial signoff: BLOCKED \(route check \| failed see evidence\)/)
  assert.equal(markdown.includes('failed\nsee evidence'), false)
  assert.equal(markdown.includes('line two\n`raw`'), false)

  const tableRows = markdown.split('\n').filter((line) => line.startsWith('| '))
  assert.equal(tableRows.length, 4)
  assert.equal(tableRows[2], '| `` route\\|check `alpha` `` | `fail retry` | ``line one \\| line two `raw` value`` |')
  assert.equal(tableRows[3], '| `object-detail` | `pass` | `{"details":{"route":"/api/integration/status\\|debug","note":"ok\\nnext"}}` |')
})
