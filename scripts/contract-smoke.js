#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_BASE_URL = 'http://127.0.0.1:8900'
const DEFAULT_OUTPUT_PATH = 'contract-smoke.json'
const DEFAULT_TIMEOUT_MS = 5_000

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertContract(condition, message) {
  if (!condition) throw new Error(message)
}

function expectStatus(response, expected) {
  assertContract(
    response.status === expected,
    `expected HTTP ${expected}, received ${response.status}`,
  )
}

function normalizeBaseUrl(rawValue) {
  const value = String(rawValue || DEFAULT_BASE_URL).trim()
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('BASE_URL must use http or https')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      'BASE_URL must not contain credentials, query parameters, or fragments',
    )
  }
  return url.toString().replace(/\/$/, '')
}

function parseTimeoutMs(rawValue) {
  if (rawValue === undefined || rawValue === '') return DEFAULT_TIMEOUT_MS
  const timeoutMs = Number.parseInt(String(rawValue), 10)
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error(
      'CONTRACT_SMOKE_TIMEOUT_MS must be an integer from 100 to 60000',
    )
  }
  return timeoutMs
}

async function readResponseBody(response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function summarizeBody(body) {
  const serialized = typeof body === 'string' ? body : JSON.stringify(body)
  if (!serialized) return null
  return serialized.length <= 1_000
    ? serialized
    : `${serialized.slice(0, 1_000)}...`
}

function contractChecks() {
  return [
    {
      name: 'health:get',
      method: 'GET',
      path: '/health',
      authenticated: false,
      assert(response, body) {
        expectStatus(response, 200)
        assertContract(isRecord(body), 'expected a JSON object')
        assertContract(body.status === 'ok', 'expected status=ok')
        assertContract(body.ok === true, 'expected ok=true')
      },
    },
    {
      name: 'auth:missing-token',
      method: 'GET',
      path: '/api/permissions',
      authenticated: false,
      assert(response, body) {
        expectStatus(response, 401)
        assertContract(isRecord(body), 'expected a JSON object')
        assertContract(body.ok === false, 'expected ok=false')
        assertContract(
          body.error?.code === 'UNAUTHORIZED',
          'expected error.code=UNAUTHORIZED',
        )
      },
    },
    {
      name: 'permissions:health',
      method: 'GET',
      path: '/api/permissions/health',
      authenticated: false,
      assert(response, body) {
        expectStatus(response, 200)
        assertContract(isRecord(body), 'expected a JSON object')
        assertContract(body.status === 'ok', 'expected status=ok')
        assertContract(
          typeof body.degraded === 'boolean',
          'expected a boolean degraded field',
        )
      },
    },
    {
      name: 'permissions:list',
      method: 'GET',
      path: '/api/permissions',
      assert(response, body) {
        expectStatus(response, 200)
        assertContract(isRecord(body), 'expected a JSON object')
        assertContract(Array.isArray(body.data), 'expected data to be an array')
        assertContract(
          Number.isInteger(body.total),
          'expected total to be an integer',
        )
      },
    },
    {
      name: 'permissions:me',
      method: 'GET',
      path: '/api/permissions/me',
      assert(response, body) {
        expectStatus(response, 200)
        assertContract(isRecord(body), 'expected a JSON object')
        assertContract(
          typeof body.userId === 'string' && body.userId.length > 0,
          'expected a userId',
        )
        assertContract(
          Array.isArray(body.permissions),
          'expected permissions to be an array',
        )
        assertContract(
          typeof body.isAdmin === 'boolean',
          'expected isAdmin to be a boolean',
        )
      },
    },
    {
      name: 'permissions:check-validation',
      method: 'POST',
      path: '/api/permissions/check',
      body: {},
      assert(response, body) {
        expectStatus(response, 400)
        assertContract(isRecord(body), 'expected a JSON object')
        assertContract(
          body.error === 'permission is required',
          'expected the permission validation error',
        )
      },
    },
    {
      name: 'approvals:not-found',
      method: 'GET',
      path: '/api/approvals/__observability_contract_missing__',
      assert(response, body) {
        expectStatus(response, 404)
        assertContract(isRecord(body), 'expected a JSON object')
        assertContract(body.ok === false, 'expected ok=false')
        assertContract(
          body.error?.code === 'APPROVAL_NOT_FOUND',
          'expected error.code=APPROVAL_NOT_FOUND',
        )
      },
    },
    {
      name: 'audit-logs:list',
      method: 'GET',
      path: '/api/audit-logs?page=1&pageSize=1',
      assert(response, body) {
        expectStatus(response, 200)
        assertContract(isRecord(body), 'expected a JSON object')
        assertContract(body.ok === true, 'expected ok=true')
        assertContract(isRecord(body.data), 'expected data to be an object')
        assertContract(
          Array.isArray(body.data.items),
          'expected data.items to be an array',
        )
        assertContract(body.data.page === 1, 'expected page=1')
        assertContract(body.data.pageSize === 1, 'expected pageSize=1')
        assertContract(
          Number.isInteger(body.data.total),
          'expected total to be an integer',
        )
      },
    },
  ]
}

async function executeCheck(check, { baseUrl, token, timeoutMs, fetchImpl }) {
  const startedAt = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const headers = { Accept: 'application/json' }
    if (check.authenticated !== false) headers.Authorization = `Bearer ${token}`
    if (check.body !== undefined) headers['Content-Type'] = 'application/json'

    const response = await fetchImpl(`${baseUrl}${check.path}`, {
      method: check.method,
      headers,
      signal: controller.signal,
      ...(check.body === undefined ? {} : { body: JSON.stringify(check.body) }),
    })
    const body = await readResponseBody(response)
    check.assert(response, body)
    return {
      name: check.name,
      ok: true,
      method: check.method,
      path: check.path,
      status: response.status,
      durationMs: Date.now() - startedAt,
    }
  } catch (error) {
    return {
      name: check.name,
      ok: false,
      method: check.method,
      path: check.path,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timeout)
  }
}

export async function runContractSmoke(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl)
  const token = String(options.token || '').trim()
  if (!token) throw new Error('TOKEN is required')

  const timeoutMs = parseTimeoutMs(options.timeoutMs)
  const fetchImpl = options.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available')

  const startedAt = new Date().toISOString()
  const checks = []
  for (const check of contractChecks()) {
    checks.push(
      await executeCheck(check, { baseUrl, token, timeoutMs, fetchImpl }),
    )
  }

  return {
    ok: checks.every((check) => check.ok),
    baseUrl,
    startedAt,
    finishedAt: new Date().toISOString(),
    checks,
  }
}

export async function writeContractReport(outputPath, report) {
  const resolvedPath = path.resolve(outputPath || DEFAULT_OUTPUT_PATH)
  await mkdir(path.dirname(resolvedPath), { recursive: true })
  await writeFile(resolvedPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return resolvedPath
}

export async function runCli(options = {}) {
  const env = options.env || process.env
  const stdout = options.stdout || process.stdout
  const stderr = options.stderr || process.stderr
  const outputPath = env.CONTRACT_SMOKE_OUTPUT || DEFAULT_OUTPUT_PATH

  try {
    const report = await runContractSmoke({
      baseUrl: env.BASE_URL,
      token: env.TOKEN,
      timeoutMs: env.CONTRACT_SMOKE_TIMEOUT_MS,
      fetchImpl: options.fetchImpl,
    })
    const writtenPath = await writeContractReport(outputPath, report)
    stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    stdout.write(`Contract smoke report: ${writtenPath}\n`)
    return report.ok ? 0 : 1
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const report = {
      ok: false,
      baseUrl: (() => {
        try {
          return normalizeBaseUrl(env.BASE_URL)
        } catch {
          return null
        }
      })(),
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      checks: [],
      error: summarizeBody(message),
    }
    try {
      await writeContractReport(outputPath, report)
    } catch (writeError) {
      stderr.write(
        `Failed to write contract smoke report: ${writeError instanceof Error ? writeError.message : String(writeError)}\n`,
      )
    }
    stderr.write(`Contract smoke failed: ${message}\n`)
    return 1
  }
}

const entrypoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : ''
if (import.meta.url === entrypoint) {
  process.exitCode = await runCli()
}
