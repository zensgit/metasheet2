#!/usr/bin/env node

import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
])

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}`)
    }
    const name = token.slice(2)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${name}`)
    }
    result[name] = value
    index += 1
  }
  return result
}

function isProxyPath(urlPath) {
  return (
    urlPath === '/health' ||
    urlPath === '/metrics' ||
    urlPath === '/metrics/prom' ||
    urlPath.startsWith('/api/') ||
    urlPath === '/api' ||
    urlPath.startsWith('/socket.io/')
  )
}

function copyHeaders(headers, { includeUpgrade = false } = {}) {
  const result = {}
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase()
    if (
      (!includeUpgrade && HOP_BY_HOP_HEADERS.has(lowerName)) ||
      value === undefined
    ) {
      continue
    }
    result[name] = value
  }
  return result
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return (
    normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1'
  )
}

function setForwardedHeaders(headers, req, backendUrl) {
  const remoteAddress = req.socket.remoteAddress || '127.0.0.1'
  headers.host = backendUrl.host
  headers['x-forwarded-for'] = remoteAddress
  headers['x-real-ip'] = remoteAddress
  headers['x-forwarded-host'] = req.headers.host || ''
  headers['x-forwarded-proto'] = 'http'
}

function proxyHttpRequest(req, res, backendUrl) {
  const transport = backendUrl.protocol === 'https:' ? https : http
  const headers = copyHeaders(req.headers)
  setForwardedHeaders(headers, req, backendUrl)

  const proxyReq = transport.request(
    {
      protocol: backendUrl.protocol,
      hostname: backendUrl.hostname,
      port: backendUrl.port,
      method: req.method,
      path: req.url,
      headers,
    },
    (proxyRes) => {
      res.writeHead(
        proxyRes.statusCode || 502,
        copyHeaders(proxyRes.headers),
      )
      proxyRes.pipe(res)
    },
  )

  proxyReq.on('error', (error) => {
    if (res.headersSent) {
      res.destroy(error)
      return
    }
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'backend_unavailable' }))
  })
  req.pipe(proxyReq)
}

function serializeUpgradeResponse(response) {
  const statusCode = response.statusCode || 101
  const statusMessage = response.statusMessage || 'Switching Protocols'
  const lines = [`HTTP/1.1 ${statusCode} ${statusMessage}`]
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${name}: ${item}`)
    } else {
      lines.push(`${name}: ${value}`)
    }
  }
  return `${lines.join('\r\n')}\r\n\r\n`
}

function proxyUpgrade(req, socket, head, backendUrl) {
  if (!req.url || !req.url.startsWith('/socket.io/')) {
    socket.destroy()
    return
  }

  const transport = backendUrl.protocol === 'https:' ? https : http
  const headers = copyHeaders(req.headers, { includeUpgrade: true })
  setForwardedHeaders(headers, req, backendUrl)

  const proxyReq = transport.request({
    protocol: backendUrl.protocol,
    hostname: backendUrl.hostname,
    port: backendUrl.port,
    method: req.method,
    path: req.url,
    headers,
  })

  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    socket.write(serializeUpgradeResponse(proxyRes))
    if (head.length > 0) proxySocket.write(head)
    if (proxyHead.length > 0) socket.write(proxyHead)
    proxySocket.pipe(socket)
    socket.pipe(proxySocket)
  })

  proxyReq.on('response', (proxyRes) => {
    socket.write(serializeUpgradeResponse(proxyRes))
    proxyRes.pipe(socket)
  })

  proxyReq.on('error', () => {
    socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
    socket.destroy()
  })

  proxyReq.end()
}

function resolveStaticPath(webRoot, requestPath) {
  let decoded
  try {
    decoded = decodeURIComponent(requestPath)
  } catch {
    return null
  }

  const relativePath = decoded.replace(/^[/\\]+/, '')
  const candidate = path.resolve(webRoot, relativePath)
  const relative = path.relative(webRoot, candidate)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null
  }
  return candidate
}

function serveFile(req, res, filePath) {
  const stat = fs.statSync(filePath)
  const headers = {
    'content-length': stat.size,
    'content-type':
      CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ||
      'application/octet-stream',
    'x-content-type-options': 'nosniff',
  }
  if (path.basename(filePath) === 'index.html') {
    headers['cache-control'] = 'no-store'
  }
  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  fs.createReadStream(filePath).pipe(res)
}

function serveStaticRequest(req, res, webRoot) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }

  const requestUrl = new URL(req.url || '/', 'http://windows-native.local')
  const candidate = resolveStaticPath(webRoot, requestUrl.pathname)
  if (!candidate) {
    res.writeHead(400)
    res.end()
    return
  }

  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    serveFile(req, res, candidate)
    return
  }

  const indexPath = path.join(webRoot, 'index.html')
  serveFile(req, res, indexPath)
}

export function createWindowsNativeGateway({
  webRoot,
  backendOrigin,
  logger = console,
}) {
  const resolvedWebRoot = path.resolve(webRoot)
  const indexPath = path.join(resolvedWebRoot, 'index.html')
  if (!fs.existsSync(indexPath)) {
    throw new Error(`Missing web entrypoint: ${indexPath}`)
  }

  const backendUrl = new URL(backendOrigin)
  if (backendUrl.protocol !== 'http:' || !isLoopbackHostname(backendUrl.hostname)) {
    throw new Error('backendOrigin must use a loopback HTTP origin')
  }

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://windows-native.local')
    if (isProxyPath(requestUrl.pathname)) {
      proxyHttpRequest(req, res, backendUrl)
      return
    }
    try {
      serveStaticRequest(req, res, resolvedWebRoot)
    } catch (error) {
      logger.error('[attendance-windows-native-gateway] static error', error)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    }
  })

  server.on('upgrade', (req, socket, head) => {
    proxyUpgrade(req, socket, head, backendUrl)
  })

  return server
}

export async function startWindowsNativeGateway({
  webRoot,
  backendOrigin,
  host = '127.0.0.1',
  port = 8080,
  logger = console,
}) {
  if (!isLoopbackHostname(host)) {
    throw new Error('gateway host must be loopback')
  }
  const server = createWindowsNativeGateway({
    webRoot,
    backendOrigin,
    logger,
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  const address = server.address()
  const boundPort = typeof address === 'object' && address ? address.port : port
  logger.log(
    `[attendance-windows-native-gateway] ready http://${host}:${boundPort} -> ${backendOrigin}`,
  )
  return server
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const rootDir = path.resolve(args.root || process.cwd())
  const webRoot = path.resolve(args['web-root'] || path.join(rootDir, 'apps/web/dist'))
  const backendOrigin =
    args.backend || process.env.WINDOWS_NATIVE_BACKEND_ORIGIN || 'http://127.0.0.1:8900'
  const host =
    args.host || process.env.WINDOWS_NATIVE_GATEWAY_HOST || '127.0.0.1'
  const port = Number(
    args.port || process.env.WINDOWS_NATIVE_GATEWAY_PORT || '8080',
  )
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid gateway port: ${port}`)
  }

  const server = await startWindowsNativeGateway({
    webRoot,
    backendOrigin,
    host,
    port,
  })

  const shutdown = (signal) => {
    console.log(`[attendance-windows-native-gateway] received ${signal}`)
    server.close((error) => {
      if (error) {
        console.error(error)
        process.exitCode = 1
      }
    })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error('[attendance-windows-native-gateway] fatal:', error.message)
    process.exitCode = 1
  })
}
