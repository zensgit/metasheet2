import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const moduleUrl = process.env.ATTENDANCE_WINDOWS_GATEWAY_MODULE
  ? pathToFileURL(path.resolve(process.env.ATTENDANCE_WINDOWS_GATEWAY_MODULE))
  : new URL('./attendance-windows-native-gateway.mjs', import.meta.url)
const { createWindowsNativeGateway } = await import(moduleUrl.href)

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

async function fixture(t, handler) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-gateway-http-'))
  fs.writeFileSync(path.join(root, 'index.html'), '<main>synthetic gateway</main>')
  const backend = http.createServer(handler)
  const servers = [backend]
  t.after(async () => {
    for (const server of servers.reverse()) {
      server.closeAllConnections()
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
      })
    }
    fs.rmSync(root, { recursive: true, force: true })
  })
  const backendPort = await listen(backend)
  const gateway = createWindowsNativeGateway({
    webRoot: root,
    backendOrigin: `http://127.0.0.1:${backendPort}`,
    logger: { log() {}, error() {} },
  })
  servers.push(gateway)
  return { port: await listen(gateway), root }
}

function request(port, { method = 'PUT', url = '/api/control', body = '' } = {}) {
  return new Promise(resolve => {
    const chunks = []
    const outcome = { status: null, ended: false, error: null, deadline: false }
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(deadline)
      resolve({ ...outcome, body: Buffer.concat(chunks) })
    }
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: url,
      method,
      headers: { 'content-length': Buffer.byteLength(body) },
    }, res => {
      outcome.status = res.statusCode
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        outcome.ended = true
        finish()
      })
      res.on('error', error => {
        outcome.error = error.code
        finish()
      })
    })
    req.on('error', error => {
      outcome.error = error.code
      finish()
    })
    // Observation cutoff only: no gateway timeout is added or changed.
    const deadline = setTimeout(() => {
      outcome.deadline = true
      finish()
      req.destroy()
    }, 1500)
    req.end(body)
  })
}

test('forwards PUT method, path and body unchanged', async t => {
  const { port } = await fixture(t, (req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        method: req.method,
        url: req.url,
        body: Buffer.concat(chunks).toString(),
      }))
    })
  })
  const result = await request(port, { url: '/api/control?probe=1', body: '{"probe":true}' })
  assert.equal(result.deadline, false)
  assert.equal(result.ended, true)
  assert.equal(result.error, null)
  assert.equal(result.status, 200)
  assert.deepEqual(JSON.parse(result.body), {
    method: 'PUT', url: '/api/control?probe=1', body: '{"probe":true}',
  })
})

test('forwards OPTIONS to the backend without rewriting its method', async t => {
  let seen
  const { port } = await fixture(t, (req, res) => {
    seen = { method: req.method, url: req.url }
    res.writeHead(204, { 'access-control-allow-methods': 'PUT,OPTIONS' })
    res.end()
  })
  const result = await request(port, { method: 'OPTIONS' })
  assert.deepEqual(seen, { method: 'OPTIONS', url: '/api/control' })
  assert.deepEqual(result, {
    status: 204, ended: true, error: null, deadline: false, body: Buffer.alloc(0),
  })
})

test('returns the existing closed 502 shape on pre-response upstream failure', async t => {
  const { port } = await fixture(t, req => req.socket.destroy())
  const result = await request(port)
  assert.equal(result.deadline, false)
  assert.equal(result.ended, true)
  assert.equal(result.error, null)
  assert.equal(result.status, 502)
  assert.deepEqual(JSON.parse(result.body), { error: 'backend_unavailable' })
})

test('closes an upstream response aborted after headers without waiting for the cutoff', async t => {
  const { port } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-length': '64' })
    res.flushHeaders()
    setTimeout(() => res.destroy(), 40)
  })
  const result = await request(port)
  assert.deepEqual(result, {
    status: null, ended: false, error: 'ECONNRESET', deadline: false, body: Buffer.alloc(0),
  })
})

test('closes a partial upstream response without waiting for the cutoff', async t => {
  const { port } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-length': '64' })
    res.write('part')
    setTimeout(() => res.destroy(), 40)
  })
  const result = await request(port)
  assert.deepEqual(result, {
    status: 200, ended: false, error: 'ECONNRESET', deadline: false,
    body: Buffer.from('part'),
  })
})

test('preserves upstream status and NUL-padded body instead of identifying its origin', async t => {
  const body = Buffer.concat([Buffer.from('Sorry, Page Not Found'), Buffer.alloc(16)])
  const { port } = await fixture(t, (_req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end(body)
  })
  const result = await request(port)
  assert.deepEqual(result, {
    status: 404, ended: true, error: null, deadline: false, body,
  })
})

test('preserves static GET fallback and rejects static PUT', async t => {
  const { port } = await fixture(t, (_req, res) => res.end())
  const get = await request(port, { method: 'GET', url: '/attendance' })
  assert.deepEqual(get, {
    status: 200, ended: true, error: null, deadline: false,
    body: Buffer.from('<main>synthetic gateway</main>'),
  })
  const put = await request(port, { url: '/attendance' })
  assert.deepEqual(put, {
    status: 405, ended: true, error: null, deadline: false, body: Buffer.alloc(0),
  })
})

test('keeps the backend origin constrained to loopback HTTP', async t => {
  const { root } = await fixture(t, (_req, res) => res.end())
  for (const backendOrigin of ['http://upstream.example.invalid', 'https://127.0.0.1']) {
    assert.throws(() => createWindowsNativeGateway({ webRoot: root, backendOrigin }),
      /backendOrigin must use a loopback HTTP origin/)
  }
})
