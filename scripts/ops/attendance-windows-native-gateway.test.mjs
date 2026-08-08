import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const gatewayModulePath = process.env.ATTENDANCE_WINDOWS_GATEWAY_MODULE
  ? path.resolve(process.env.ATTENDANCE_WINDOWS_GATEWAY_MODULE)
  : path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      'attendance-windows-native-gateway.mjs',
    )

const { startWindowsNativeGateway } = await import(
  pathToFileURL(gatewayModulePath).href
)

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function requestUpgrade(port) {
  return await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let response = ''
    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.on('data', (chunk) => {
      response += chunk
      if (response.includes('\r\n\r\n')) {
        socket.destroy()
        resolve(response)
      }
    })
    socket.once('connect', () => {
      socket.write(
        [
          'GET /socket.io/?EIO=4&transport=websocket HTTP/1.1',
          `Host: 127.0.0.1:${port}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Key: dGVzdA==',
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n'),
      )
    })
  })
}

test('serves SPA assets and proxies HTTP plus websocket traffic', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-win-gateway-'))
  const webRoot = path.join(root, 'dist')
  fs.mkdirSync(path.join(webRoot, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<main>attendance qa</main>')
  fs.writeFileSync(path.join(webRoot, 'assets', 'app.js'), 'window.QA = true')

  const backend = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }
    if (req.url === '/api/echo?case=windows') {
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          path: req.url,
          forwardedFor: req.headers['x-forwarded-for'],
        }),
      )
      return
    }
    res.writeHead(404)
    res.end()
  })
  backend.on('upgrade', (_req, socket) => {
    socket.end(
      'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
    )
  })

  const backendPort = await listen(backend)
  const gateway = await startWindowsNativeGateway({
    webRoot,
    backendOrigin: `http://127.0.0.1:${backendPort}`,
    host: '127.0.0.1',
    port: 0,
    logger: { log() {}, error() {} },
  })
  const gatewayPort = gateway.address().port

  t.after(async () => {
    await close(gateway)
    await close(backend)
    fs.rmSync(root, { recursive: true, force: true })
  })

  const indexResponse = await fetch(`http://127.0.0.1:${gatewayPort}/attendance`)
  assert.equal(indexResponse.status, 200)
  assert.match(await indexResponse.text(), /attendance qa/)
  assert.equal(indexResponse.headers.get('cache-control'), 'no-store')

  const assetResponse = await fetch(
    `http://127.0.0.1:${gatewayPort}/assets/app.js`,
  )
  assert.equal(assetResponse.status, 200)
  assert.match(await assetResponse.text(), /window\.QA/)

  const apiResponse = await fetch(
    `http://127.0.0.1:${gatewayPort}/api/echo?case=windows`,
    {
      headers: {
        'x-forwarded-for': '203.0.113.99',
      },
    },
  )
  assert.equal(apiResponse.status, 201)
  assert.deepEqual(await apiResponse.json(), {
    path: '/api/echo?case=windows',
    forwardedFor: '127.0.0.1',
  })

  const healthResponse = await fetch(
    `http://127.0.0.1:${gatewayPort}/health`,
  )
  assert.equal(healthResponse.status, 200)
  assert.deepEqual(await healthResponse.json(), { status: 'ok' })

  const upgradeResponse = await requestUpgrade(gatewayPort)
  assert.match(upgradeResponse, /^HTTP\/1\.1 101 Switching Protocols/m)
})

test('returns a closed 502 response when the backend is unavailable', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-win-gateway-'))
  fs.writeFileSync(path.join(root, 'index.html'), '<main>qa</main>')

  const reserved = net.createServer()
  const unavailablePort = await listen(reserved)
  await close(reserved)

  const gateway = await startWindowsNativeGateway({
    webRoot: root,
    backendOrigin: `http://127.0.0.1:${unavailablePort}`,
    host: '127.0.0.1',
    port: 0,
    logger: { log() {}, error() {} },
  })
  const gatewayPort = gateway.address().port

  t.after(async () => {
    await close(gateway)
    fs.rmSync(root, { recursive: true, force: true })
  })

  const response = await fetch(`http://127.0.0.1:${gatewayPort}/api/test`)
  assert.equal(response.status, 502)
  assert.deepEqual(await response.json(), { error: 'backend_unavailable' })
})

test('rejects non-loopback listeners and backend origins', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-win-gateway-'))
  fs.writeFileSync(path.join(root, 'index.html'), '<main>qa</main>')

  try {
    await assert.rejects(
      startWindowsNativeGateway({
        webRoot: root,
        backendOrigin: 'http://127.0.0.1:8900',
        host: '0.0.0.0',
        port: 0,
        logger: { log() {}, error() {} },
      }),
      /gateway host must be loopback/,
    )
    await assert.rejects(
      startWindowsNativeGateway({
        webRoot: root,
        backendOrigin: 'https://staging.example.invalid',
        host: '127.0.0.1',
        port: 0,
        logger: { log() {}, error() {} },
      }),
      /backendOrigin must use a loopback HTTP origin/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
