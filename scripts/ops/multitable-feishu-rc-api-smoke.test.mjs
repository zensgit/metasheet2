import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  parseConfig,
  renderRcApiSmokeMarkdown,
  runRcApiSmoke,
  validateConfig,
} from './multitable-feishu-rc-api-smoke.mjs'

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      if (!raw) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (err) {
        reject(err)
      }
    })
  })
}

function send(res, status, json) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(json))
}

async function startMockServer() {
  const calls = []
  let fieldCounter = 0
  let viewCounter = 0
  let recordCounter = 0
  const fieldsByKey = {}

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    calls.push(`${req.method} ${url.pathname}`)

    if (url.pathname === '/api/health') {
      send(res, 200, { ok: true, status: 'healthy', pluginsSummary: { total: 1 }, dbPool: { total: 1 } })
      return
    }
    if (url.pathname === '/api/auth/me') {
      send(res, 200, { ok: true, data: { user: { id: 'admin', roles: ['admin'] } } })
      return
    }
    if (url.pathname === '/api/integration/staging/descriptors') {
      send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'plugin disabled' } })
      return
    }
    if (url.pathname === '/api/multitable/templates') {
      send(res, 200, { ok: true, data: { templates: [{ id: 'project-tracker', name: 'Project Tracker' }] } })
      return
    }
    if (url.pathname === '/api/multitable/templates/project-tracker/install') {
      send(res, 201, {
        ok: true,
        data: {
          template: { id: 'project-tracker' },
          base: { id: 'base_mock' },
          sheets: [{ id: 'sheet_mock', baseId: 'base_mock' }],
          fields: [],
          views: [],
        },
      })
      return
    }
    if (url.pathname === '/api/multitable/fields') {
      const payload = await readJson(req)
      fieldCounter += 1
      const id = `fld_${fieldCounter}_${payload.type}`
      fieldsByKey[payload.type] = id
      send(res, 201, {
        ok: true,
        data: {
          field: {
            id,
            sheetId: payload.sheetId,
            name: payload.name,
            type: payload.type,
            property: payload.property || {},
          },
        },
      })
      return
    }
    if (url.pathname === '/api/multitable/records') {
      const payload = await readJson(req)
      recordCounter += 1
      send(res, 200, {
        ok: true,
        data: {
          record: {
            id: `rec_${recordCounter}`,
            version: 1,
            data: payload.data || {},
          },
        },
      })
      return
    }
    if (url.pathname === '/api/multitable/patch') {
      const payload = await readJson(req)
      send(res, 200, {
        ok: true,
        data: {
          updated: (payload.changes || []).map((change) => ({
            recordId: change.recordId,
            version: 2,
            patch: { [change.fieldId]: change.value },
          })),
        },
      })
      return
    }
    if (url.pathname === '/api/multitable/views') {
      const payload = await readJson(req)
      viewCounter += 1
      send(res, 201, {
        ok: true,
        data: {
          view: {
            id: `view_${viewCounter}`,
            sheetId: payload.sheetId,
            name: payload.name,
            type: payload.type || 'grid',
            config: payload.config || {},
          },
        },
      })
      return
    }
    if (/^\/api\/multitable\/sheets\/[^/]+\/views\/[^/]+\/form-share$/.test(url.pathname)) {
      send(res, 200, {
        ok: true,
        data: {
          enabled: true,
          accessMode: 'public',
          publicToken: 'public-token-secret',
        },
      })
      return
    }
    if (url.pathname === '/api/multitable/form-context') {
      send(res, 200, { ok: true, data: { mode: 'form', fields: [] } })
      return
    }
    if (/^\/api\/multitable\/views\/[^/]+\/submit$/.test(url.pathname)) {
      send(res, 200, { ok: true, data: { record: { id: 'rec_public', version: 1 } } })
      return
    }

    send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: url.pathname } })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('validateConfig requires a real token/write confirmation and a writable target', () => {
  const config = parseConfig({
    API_BASE: 'https://staging.example.test/',
  })
  assert.deepEqual(validateConfig(config), [
    'AUTH_TOKEN or TOKEN',
    'CONFIRM_WRITE=1',
    'SMOKE_SHEET_ID or ALLOW_INSTALL=1',
  ])
})

test('renderRcApiSmokeMarkdown summarizes failures without leaking token values', () => {
  const markdown = renderRcApiSmokeMarkdown({
    ok: false,
    apiBase: 'https://staging.example.test',
    runId: 'rc-api-smoke-test',
    startedAt: '2026-05-06T00:00:00.000Z',
    finishedAt: '2026-05-06T00:00:01.000Z',
    expectedCommit: 'abc123',
    reportPath: '/tmp/report.json',
    reportMdPath: '/tmp/report.md',
    metadata: { userHash: 'hash-only' },
    checks: [
      { name: 'auth.token-present', ok: true, details: { tokenHash: 'secret-hash' } },
      { name: 'api.records.patch.expected-version', ok: false, details: { status: 409 } },
      { name: 'api.integration-staging.descriptors', ok: true, details: { skipped: true, reason: 'disabled' } },
    ],
  })

  assert.match(markdown, /# Multitable Feishu RC API Smoke/)
  assert.match(markdown, /Overall: \*\*FAIL\*\*/)
  assert.match(markdown, /Failing checks: `api\.records\.patch\.expected-version`/)
  assert.match(markdown, /Skipped checks: `api\.integration-staging\.descriptors`/)
  assert.doesNotMatch(markdown, /Bearer/)
  assert.doesNotMatch(markdown, /public-token-secret/)
})

test('runRcApiSmoke executes required API checks and writes JSON/Markdown artifacts', async () => {
  const server = await startMockServer()
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multitable-feishu-rc-api-smoke-'))
  try {
    const report = await runRcApiSmoke(parseConfig({
      API_BASE: server.baseUrl,
      AUTH_TOKEN: 'test-token',
      CONFIRM_WRITE: '1',
      ALLOW_INSTALL: '1',
      RUN_ID: 'rc-api-smoke-unit',
      OUTPUT_DIR: outputDir,
    }))

    assert.equal(report.ok, true)
    assert.equal(report.metadata.baseId, 'base_mock')
    assert.equal(report.metadata.sheetId, 'sheet_mock')
    assert.ok(report.checks.some((check) => check.name === 'api.fields.batch-types' && check.ok))
    assert.ok(report.checks.some((check) => check.name === 'api.public-form.submit' && check.ok))
    assert.ok(server.calls.includes('POST /api/multitable/templates/project-tracker/install'))
    assert.ok(fs.existsSync(path.join(outputDir, 'report.json')))
    assert.ok(fs.existsSync(path.join(outputDir, 'report.md')))
  } finally {
    await server.close()
  }
})
