'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const test = require('node:test')
const { createK3WiseWebApiAdapter } = require('../lib/adapters/k3-wise-webapi-adapter.cjs')
const {
  READ_SMOKE_LIST_REQUEST_MARKER,
  READ_SMOKE_BOM_REQUEST_MARKER,
  READ_SMOKE_BOM_LIST_BY_MATERIAL_REQUEST_MARKER,
} = require('../lib/read-smoke-marker.cjs')

const READ_PATHS = {
  detail: '/K3API/Material/GetDetail',
  list: '/K3API/Material/GetList',
  bom: '/K3API/BOM/GetDetail',
  bomList: '/K3API/BOM/GetList',
}
const SAVE_PATH = '/K3API/Material/Save'
const DETAIL = { StatusCode: 200, Data: [{ FNumber: 'SYNTHETIC', Data: { FNumber: 'SYNTHETIC' } }] }

function system(baseUrl, { credentials = { sessionId: 'synthetic-session' }, healthPath, objects } = {}) {
  return {
    id: 'synthetic-k3', tenantId: 'synthetic-tenant', kind: 'erp:k3-wise-webapi', role: 'target',
    credentials,
    config: { baseUrl, ...(healthPath ? { healthPath } : {}), objects: objects || {
      material: { operations: ['read'], readPath: READ_PATHS.detail },
    } },
  }
}

function markedOptions(mode, key) {
  const options = mode === 'bom'
    ? { k3ReadMode: mode, bomKey: key }
    : mode === 'bom_list_by_material'
      ? { k3ReadMode: mode, bomListMaterialKey: key }
      : { k3ReadMode: mode }
  const marker = mode === 'list' ? READ_SMOKE_LIST_REQUEST_MARKER
    : mode === 'bom' ? READ_SMOKE_BOM_REQUEST_MARKER
      : READ_SMOKE_BOM_LIST_BY_MATERIAL_REQUEST_MARKER
  Object.defineProperty(options, marker, { value: true, enumerable: true })
  return options
}

function readCase(name) {
  if (name === 'detail') return {
    objects: { material: { operations: ['read'], readPath: READ_PATHS.detail } },
    request: { object: 'material', filters: { FNumber: 'SYNTHETIC' } },
  }
  if (name === 'list') return {
    objects: { material: { operations: ['read'], readPath: READ_PATHS.list, readMode: 'list' } },
    request: { object: 'material', limit: 1, options: markedOptions('list') },
  }
  if (name === 'bom') return {
    objects: { 'material-bom': { operations: ['read'], readPath: READ_PATHS.bom, readMode: 'bom' } },
    request: { object: 'material-bom', options: markedOptions('bom', 'BOM-SYNTHETIC') },
  }
  return {
    objects: { 'material-bom-list': { operations: ['read'], readPath: READ_PATHS.bomList, readMode: 'bom_list_by_material' } },
    request: { object: 'material-bom-list', limit: 1, options: markedOptions('bom_list_by_material', '31415') },
  }
}

async function loopback(handler) {
  const calls = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const call = {
      path: new URL(req.url, 'http://synthetic.invalid').pathname,
      method: req.method,
      body: Buffer.concat(chunks).toString('utf8'),
      session: req.headers['x-k3-session'],
    }
    calls.push(call)
    handler(call, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    calls,
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

function json(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function redirect(res, status, location) {
  res.writeHead(status, { Location: location, 'Content-Type': 'application/json' })
  res.end(JSON.stringify(DETAIL))
}

async function readError(adapter, request) {
  return adapter.read(request).then(() => null, (error) => error)
}

test('native fetch: legitimate POST GetDetail read still succeeds', async () => {
  const wire = await loopback((_call, res) => json(res, DETAIL))
  try {
    const adapter = createK3WiseWebApiAdapter({ system: system(wire.url) })
    const result = await adapter.read(readCase('detail').request)
    assert.equal(result.records.length, 1)
    assert.deepEqual(wire.calls.map(({ path, method }) => [path, method]), [[READ_PATHS.detail, 'POST']])
  } finally {
    await wire.close()
  }
})

for (const status of [301, 302, 303, 307, 308]) {
  test(`native fetch: ${status} stops before same-origin Save`, async () => {
    const wire = await loopback((call, res) => {
      if (call.path === READ_PATHS.detail) return redirect(res, status, SAVE_PATH)
      return json(res, DETAIL)
    })
    try {
      const adapter = createK3WiseWebApiAdapter({ system: system(wire.url) })
      const error = await readError(adapter, readCase('detail').request)
      assert.ok(error, `${status}: read must fail`)
      assert.equal(wire.calls.filter((call) => call.path === READ_PATHS.detail).length, 1)
      assert.equal(wire.calls.filter((call) => call.path === SAVE_PATH).length, 0, `${status}: native second hop must be zero`)
    } finally {
      await wire.close()
    }
  })
}

test('native fetch: cross-origin redirect sends no second request or session', async () => {
  const destination = await loopback((_call, res) => json(res, DETAIL))
  const source = await loopback((_call, res) => redirect(res, 307, `${destination.url}${SAVE_PATH}`))
  try {
    const adapter = createK3WiseWebApiAdapter({ system: system(source.url) })
    assert.ok(await readError(adapter, readCase('detail').request))
    assert.equal(source.calls.length, 1)
    assert.equal(destination.calls.length, 0)
  } finally {
    await source.close()
    await destination.close()
  }
})

test('native fetch: token, login and health redirects stop at the first hop', async () => {
  for (const stage of ['token', 'login', 'health']) {
    const stagePath = stage === 'token' ? '/K3API/Token/Create'
      : stage === 'login' ? '/K3API/Login' : '/K3API/Health'
    const wire = await loopback((call, res) => {
      if (call.path === stagePath) return redirect(res, 307, SAVE_PATH)
      if (call.path === '/K3API/Login') return json(res, { success: true, sessionId: 'synthetic-session' })
      if (call.path === '/K3API/Token/Create') return json(res, { StatusCode: 200, Data: { Code: 'Y', Token: 'synthetic-token' } })
      return json(res, DETAIL)
    })
    try {
      const credentials = stage === 'token' ? { authorityCode: 'synthetic-authority' }
        : stage === 'login' ? { username: 'synthetic', password: 'synthetic', acctId: 'synthetic' }
          : { sessionId: 'synthetic-session' }
      const adapter = createK3WiseWebApiAdapter({ system: system(wire.url, { credentials, healthPath: '/K3API/Health' }) })
      const outcome = await adapter.testConnection()
      assert.equal(outcome.ok, false, `${stage}: redirected connection must fail`)
      assert.equal(wire.calls.filter((call) => call.path === stagePath).length, 1)
      assert.equal(wire.calls.filter((call) => call.path === SAVE_PATH).length, 0, `${stage}: no native second hop`)
    } finally {
      await wire.close()
    }
  }
})

test('native fetch: all four read entries refuse a redirected response before a second hop', async () => {
  for (const name of Object.keys(READ_PATHS)) {
    const entry = readCase(name)
    const wire = await loopback((call, res) => {
      if (call.path === READ_PATHS[name]) return redirect(res, 308, SAVE_PATH)
      return json(res, DETAIL)
    })
    try {
      const adapter = createK3WiseWebApiAdapter({ system: system(wire.url, { objects: entry.objects }) })
      const error = await readError(adapter, entry.request)
      assert.ok(error, `${name}: read must fail`)
      assert.equal(wire.calls.filter((call) => call.path === READ_PATHS[name]).length, 1)
      assert.equal(wire.calls.filter((call) => call.path === SAVE_PATH).length, 0, `${name}: native second hop must be zero`)
    } finally {
      await wire.close()
    }
  }
})

function mockResponse(status, redirected = false) {
  return {
    status, ok: status === 200, redirected,
    async text() { return JSON.stringify(DETAIL) },
    headers: { get() { return null } },
  }
}

test('injected transport: redirect:error is passed to every request and 3xx/redirected responses fail closed', async () => {
  for (const stage of ['login', 'token', 'health', ...Object.keys(READ_PATHS)]) {
    const calls = []
    const credentials = stage === 'token' ? { authorityCode: 'synthetic-authority' }
      : stage === 'login' ? { username: 'synthetic', password: 'synthetic', acctId: 'synthetic' }
        : { sessionId: 'synthetic-session' }
    const entry = Object.hasOwn(READ_PATHS, stage) ? readCase(stage) : null
    const adapter = createK3WiseWebApiAdapter({
      system: system('http://127.0.0.1:9', { credentials, healthPath: '/K3API/Health', objects: entry && entry.objects }),
      fetchImpl: async (_url, options) => {
        calls.push(options)
        return mockResponse(307)
      },
    })
    const outcome = entry ? await readError(adapter, entry.request) : await adapter.testConnection()
    assert.ok(entry ? outcome : !outcome.ok, `${stage}: 3xx must fail`)
    assert.equal(entry ? outcome.details.code : outcome.code, 'K3_WISE_REDIRECT_REFUSED', `${stage}: fixed refusal code`)
    assert.equal(calls.length, 1, `${stage}: injected transport receives one request`)
    assert.ok(calls.every((options) => options.redirect === 'error'), `${stage}: every fetch gets redirect:error`)
  }

  for (const response of [mockResponse(302), mockResponse(307), mockResponse(200, true), mockResponse('SYNTHETIC_STATUS_VALUE', true)]) {
    const adapter = createK3WiseWebApiAdapter({
      system: system('http://127.0.0.1:9'),
      fetchImpl: async () => response,
    })
    const error = await readError(adapter, readCase('detail').request)
    assert.ok(error, 'injected redirected response must fail')
    assert.match(error.message, /K3_WISE_REDIRECT_REFUSED/)
    assert.equal(JSON.stringify(error).includes('127.0.0.1'), false, 'redirect error stays values-free')
    assert.equal(JSON.stringify(error).includes('SYNTHETIC_STATUS_VALUE'), false, 'untrusted status stays out of error details')
  }
})
