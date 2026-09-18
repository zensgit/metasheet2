import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { runCli, runContractSmoke } from './contract-smoke.js'

const token = 'test-token-not-a-secret'

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function passingFetch(requests = []) {
  return async (rawUrl, options = {}) => {
    const url = new URL(rawUrl)
    requests.push({
      method: options.method,
      path: `${url.pathname}${url.search}`,
      authorization: options.headers?.Authorization,
      body: options.body,
    })

    const key = `${options.method} ${url.pathname}${url.search}`
    const responses = {
      'GET /health': jsonResponse({ status: 'ok', ok: true }),
      'GET /api/permissions/health': jsonResponse({
        status: 'ok',
        degraded: false,
      }),
      'GET /api/permissions': options.headers?.Authorization
        ? jsonResponse({ data: [{ code: 'spreadsheet:read' }], total: 1 })
        : jsonResponse(
            {
              ok: false,
              error: { code: 'UNAUTHORIZED', message: 'Missing Bearer token' },
            },
            401,
          ),
      'GET /api/permissions/me': jsonResponse({
        userId: 'dev-user',
        permissions: ['*:*'],
        isAdmin: true,
      }),
      'POST /api/permissions/check': jsonResponse(
        { error: 'permission is required' },
        400,
      ),
      'GET /api/approvals/__observability_contract_missing__': jsonResponse(
        {
          ok: false,
          error: {
            code: 'APPROVAL_NOT_FOUND',
            message: 'Approval instance not found',
          },
        },
        404,
      ),
      'GET /api/audit-logs?page=1&pageSize=1': jsonResponse({
        ok: true,
        data: { items: [], page: 1, pageSize: 1, total: 0 },
      }),
    }
    const response = responses[key]
    if (!response) throw new Error(`unexpected request: ${key}`)
    return response
  }
}

test('runContractSmoke validates the current read-only API contract', async () => {
  const requests = []
  const report = await runContractSmoke({
    baseUrl: 'http://127.0.0.1:8900/',
    token,
    fetchImpl: passingFetch(requests),
  })

  assert.equal(report.ok, true)
  assert.equal(report.baseUrl, 'http://127.0.0.1:8900')
  assert.equal(report.checks.length, 8)
  assert.equal(
    report.checks.every((check) => check.ok),
    true,
  )
  assert.deepEqual(
    requests
      .filter((request) => request.authorization)
      .map((request) => request.authorization),
    Array(5).fill(`Bearer ${token}`),
  )
  assert.equal(
    requests.find((request) => request.path === '/health').authorization,
    undefined,
  )
  assert.equal(
    requests.find((request) => request.path === '/api/permissions/health')
      .authorization,
    undefined,
  )
  assert.equal(
    requests.find(
      (request) =>
        request.path === '/api/permissions' && !request.authorization,
    ).authorization,
    undefined,
  )
  assert.equal(
    requests.find((request) => request.path === '/api/permissions/check').body,
    '{}',
  )
})

test('runContractSmoke records a failed contract and continues the remaining checks', async () => {
  const fetchImpl = passingFetch()
  let requestCount = 0
  const report = await runContractSmoke({
    baseUrl: 'http://example.test',
    token,
    fetchImpl: async (url, options) => {
      requestCount += 1
      if (new URL(url).pathname === '/api/permissions/me') {
        return jsonResponse({ error: 'unexpected failure' }, 500)
      }
      return fetchImpl(url, options)
    },
  })

  assert.equal(report.ok, false)
  assert.equal(requestCount, 8)
  assert.equal(report.checks.length, 8)
  assert.deepEqual(
    report.checks.filter((check) => !check.ok).map((check) => check.name),
    ['permissions:me'],
  )
  assert.match(
    report.checks.find((check) => check.name === 'permissions:me').error,
    /expected HTTP 200, received 500/,
  )
  assert.equal(report.checks.at(-1).name, 'audit-logs:list')
  assert.equal(report.checks.at(-1).ok, true)
})

test('runCli writes a deterministic failure artifact and returns a non-zero code', async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), 'contract-smoke-'))
  const outputPath = path.join(outputDir, 'result.json')
  let stdout = ''
  let stderr = ''

  try {
    const exitCode = await runCli({
      env: {
        BASE_URL: 'http://127.0.0.1:8900',
        CONTRACT_SMOKE_OUTPUT: outputPath,
      },
      fetchImpl: passingFetch(),
      stdout: {
        write: (chunk) => {
          stdout += chunk
        },
      },
      stderr: {
        write: (chunk) => {
          stderr += chunk
        },
      },
    })

    assert.equal(exitCode, 1)
    assert.equal(stdout, '')
    assert.match(stderr, /TOKEN is required/)
    const report = JSON.parse(await readFile(outputPath, 'utf8'))
    assert.equal(report.ok, false)
    assert.equal(report.error, 'TOKEN is required')
    assert.deepEqual(report.checks, [])
  } finally {
    await rm(outputDir, { recursive: true, force: true })
  }
})
