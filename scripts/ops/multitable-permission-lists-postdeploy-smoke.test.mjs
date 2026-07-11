import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import {
  formatSummaryBlock,
  isSafeReusableBaseName,
  leakScan,
  runSmoke,
  sanitizeErrorCode,
} from './multitable-permission-lists-postdeploy-smoke.mjs'

const TOKEN = 'token_private_3408'
const BASE_ID = 'base_private_3408'
const IDS = {
  unsafeBase: 'base_business_private_3408',
  base: BASE_ID,
  sheet: 'sheet_private_3408',
  field: 'field_private_3408',
  view: 'view_private_3408',
  record: 'record_private_3408',
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function withApi(handler, fn) {
  const requests = []
  const server = http.createServer(async (request, response) => {
    let rawBody = ''
    for await (const chunk of request) rawBody += chunk
    const parsedBody = rawBody ? JSON.parse(rawBody) : null
    request.parsedBody = parsedBody
    requests.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      body: parsedBody,
    })
    await handler(request, response)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try {
    return await fn(`http://127.0.0.1:${address.port}`, requests)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    )))
  }
}

function happyApi({ failPath = '', cleanupStatus = 200, sheetResponseId = 'requested' } = {}) {
  let createdSheetId = IDS.sheet
  return (request, response) => {
    if (request.url === failPath) {
      sendJson(response, 500, {
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'private response body must not escape' },
      })
      return
    }
    if (request.method === 'GET' && request.url === '/api/multitable/bases') {
      sendJson(response, 200, {
        ok: true,
        data: {
          bases: [
            { id: IDS.unsafeBase, name: 'Business Operations' },
            { id: IDS.base, name: 'D2 Perf Fixture' },
          ],
        },
      })
      return
    }
    if (request.method === 'POST' && request.url === '/api/multitable/sheets') {
      createdSheetId = request.parsedBody?.id || IDS.sheet
      sendJson(response, 201, {
        ok: true,
        data: { sheet: { id: sheetResponseId === 'requested' ? createdSheetId : sheetResponseId } },
      })
      return
    }
    if (request.method === 'POST' && request.url === '/api/multitable/fields') {
      sendJson(response, 201, { ok: true, data: { field: { id: IDS.field } } })
      return
    }
    if (request.method === 'POST' && request.url === '/api/multitable/views') {
      sendJson(response, 201, { ok: true, data: { view: { id: IDS.view } } })
      return
    }
    if (request.method === 'POST' && request.url === '/api/multitable/records') {
      sendJson(response, 201, { ok: true, data: { record: { id: IDS.record } } })
      return
    }
    if (request.method === 'GET' && request.url?.endsWith('/permissions')) {
      sendJson(response, 200, { ok: true, data: { items: [] } })
      return
    }
    if (request.method === 'GET' && request.url?.endsWith('/field-permissions')) {
      sendJson(response, 200, { ok: true, data: { items: [] } })
      return
    }
    if (request.method === 'DELETE' && request.url === `/api/multitable/sheets/${createdSheetId}`) {
      sendJson(response, cleanupStatus, cleanupStatus === 200
        ? { ok: true, data: { deleted: true } }
        : { ok: false, error: { code: 'CLEANUP_FAILED' } })
      return
    }
    sendJson(response, 404, { ok: false, error: { code: 'NOT_FOUND' } })
  }
}

function smokeOptions(baseUrl, { baseId = '' } = {}) {
  return {
    baseUrl: `${baseUrl}/api/`,
    baseId,
    token: TOKEN,
    timeoutMs: 1000,
    now: () => 123456,
    random: () => 0.25,
  }
}

test('happy path probes all three list contracts and deletes the temporary sheet', async () => {
  await withApi(happyApi(), async (baseUrl, requests) => {
    const result = await runSmoke(smokeOptions(baseUrl))

    assert.equal(result.exitCode, 0)
    assert.equal(result.report.summary.pass, true)
    assert.equal(result.report.summary.setupRequestsPassed, 4)
    assert.equal(result.report.summary.baseSelectionMode, 'discovered_safe_name')
    assert.equal(result.report.summary.baseCandidates, 1)
    assert.equal(result.report.summary.baseSelectionAttempts, 1)
    assert.equal(result.report.summary.viewPermissionsHttp, 200)
    assert.equal(result.report.summary.fieldPermissionsHttp, 200)
    assert.equal(result.report.summary.recordPermissionsHttp, 200)
    assert.equal(result.report.summary.cleanupAttempted, true)
    assert.equal(result.report.summary.cleanupOk, true)
    assert.equal(requests.at(-1).method, 'DELETE')
    assert.ok(requests.every((request) => request.authorization === `Bearer ${TOKEN}`))
    assert.equal(requests[0].path, '/api/multitable/bases')
    assert.equal(requests[1].body.baseId, BASE_ID)

    const evidence = `${JSON.stringify(result.report)}\n${formatSummaryBlock(result.report.summary)}`
    for (const sentinel of [TOKEN, BASE_ID, requests[1].body.id, ...Object.values(IDS)]) {
      assert.equal(evidence.includes(sentinel), false)
    }
  })
})

test('one 500 remains a failed verdict while the other probes and cleanup still run', async () => {
  const failedPath = `/api/multitable/views/${IDS.view}/permissions`
  await withApi(happyApi({ failPath: failedPath }), async (baseUrl, requests) => {
    const result = await runSmoke(smokeOptions(baseUrl))

    assert.equal(result.exitCode, 1)
    assert.equal(result.report.summary.pass, false)
    assert.equal(result.report.summary.viewPermissionsHttp, 500)
    assert.equal(result.report.summary.viewPermissionsContract, false)
    assert.equal(result.report.summary.viewPermissionsErrorCode, 'INTERNAL_ERROR')
    assert.equal(result.report.summary.fieldPermissionsContract, true)
    assert.equal(result.report.summary.recordPermissionsContract, true)
    assert.equal(result.report.summary.cleanupOk, true)
    assert.equal(requests.at(-1).method, 'DELETE')
    assert.equal(JSON.stringify(result.report).includes('private response body'), false)
  })
})

test('setup failure after sheet creation still cleans up and never runs permission probes', async () => {
  await withApi(happyApi({ failPath: '/api/multitable/records' }), async (baseUrl, requests) => {
    const result = await runSmoke(smokeOptions(baseUrl))

    assert.equal(result.exitCode, 1)
    assert.equal(result.report.summary.setupComplete, false)
    assert.equal(result.report.summary.setupFailureStep, 'record')
    assert.equal(result.report.summary.setupFailureHttp, 500)
    assert.equal(result.report.summary.setupFailureCode, 'INTERNAL_ERROR')
    assert.equal(result.report.summary.viewPermissionsHttp, 'NOT_RUN')
    assert.equal(result.report.summary.cleanupAttempted, true)
    assert.equal(result.report.summary.cleanupOk, true)
    assert.equal(
      requests.some((request) => request.method === 'GET' && request.path !== '/api/multitable/bases'),
      false,
    )
    assert.equal(requests.at(-1).method, 'DELETE')
  })
})

test('malformed successful sheet response still cleans up by the client-selected id', async () => {
  await withApi(happyApi({ sheetResponseId: null }), async (baseUrl, requests) => {
    const result = await runSmoke(smokeOptions(baseUrl))
    assert.equal(result.exitCode, 1)
    assert.equal(result.report.summary.setupFailureStep, 'sheet')
    assert.equal(result.report.summary.setupFailureCode, 'MISSING_RESPONSE_ID')
    assert.equal(result.report.summary.cleanupRequired, true)
    assert.equal(result.report.summary.cleanupAttempted, true)
    assert.equal(result.report.summary.cleanupOk, true)
    assert.equal(requests.at(-1).path, `/api/multitable/sheets/${requests[1].body.id}`)
  })
})

test('cleanup failure makes an otherwise green probe fail closed', async () => {
  await withApi(happyApi({ cleanupStatus: 500 }), async (baseUrl, requests) => {
    const result = await runSmoke(smokeOptions(baseUrl, { baseId: BASE_ID }))
    assert.equal(result.exitCode, 1)
    assert.equal(result.report.summary.baseSelectionMode, 'configured')
    assert.equal(result.report.summary.baseListHttp, 'SKIPPED')
    assert.equal(result.report.summary.cleanupHttp, 500)
    assert.equal(result.report.summary.cleanupOk, false)
    assert.equal(result.report.summary.pass, false)
    assert.equal(requests[0].method, 'POST')
    assert.equal(requests[0].body.baseId, BASE_ID)
  })
})

test('base discovery fails closed before mutation when no safe reusable base exists', async () => {
  const api = (request, response) => {
    if (request.method === 'GET' && request.url === '/api/multitable/bases') {
      sendJson(response, 200, {
        ok: true,
        data: { bases: [{ id: IDS.unsafeBase, name: 'Business Operations' }] },
      })
      return
    }
    sendJson(response, 500, { ok: false, error: { code: 'UNEXPECTED_MUTATION' } })
  }
  await withApi(api, async (baseUrl, requests) => {
    const result = await runSmoke(smokeOptions(baseUrl))
    assert.equal(result.exitCode, 1)
    assert.equal(result.report.summary.setupFailureStep, 'base_selection')
    assert.equal(result.report.summary.setupFailureCode, 'NO_SAFE_BASE')
    assert.equal(result.report.summary.baseCandidates, 0)
    assert.equal(result.report.summary.cleanupRequired, false)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].method, 'GET')
  })
})

test('evidence helpers reject leaks and project only bounded error codes', () => {
  assert.equal(leakScan({ status: 200 }, [TOKEN, BASE_ID]), true)
  assert.equal(leakScan({ accidental: TOKEN }, [TOKEN]), false)
  assert.equal(sanitizeErrorCode('internal_error'), 'INTERNAL_ERROR')
  assert.equal(sanitizeErrorCode('echo/private/value'), 'UNSAFE_ERROR_CODE')
  assert.equal(isSafeReusableBaseName('D2 Perf Fixture'), true)
  assert.equal(isSafeReusableBaseName('multitable-smoke'), true)
  assert.equal(isSafeReusableBaseName('Perfect Sales'), false)
  assert.equal(isSafeReusableBaseName('Business Operations'), false)
})
