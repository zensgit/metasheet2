'use strict'
// Child preloader: only the freshly verified synthetic PG endpoint and exact
// live runner-owned HTTP listeners are permitted. Counters never print values.
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')
const dns = require('node:dns')
const dgram = require('node:dgram')
const { fileURLToPath } = require('node:url')
const stats = { forbiddenConnections: 0, forbiddenEnvReads: 0, allowedConnections: 0 }
const blockedOrigins = []
const noteBlocked = kind => {
  const stack = new Error().stack || ''
  const origin = /[\\/]pg(?:-pool)?[\\/]|[\\/]pg@|[\\/]pg-pool@/.test(stack) ? 'postgres'
    : /[\\/](?:ioredis|redis)(?:@|[\\/])/.test(stack) ? 'redis'
      : /[\\/]tsx[\\/]/.test(stack) ? 'tsx'
        : /[\\/](?:vite|vitest)(?:@|[\\/])/.test(stack) ? 'vite-test'
          : /node:internal[/\\]?(?:deps[/\\]undici|http)|node:_http/.test(stack) ? 'http' : 'unknown'
  if (blockedOrigins.length < 4) blockedOrigins.push({ kind, origin })
}
let blockedOptionalToolingPipes = 0
const ownHttp = process.env.PLM_FULL_APP_ALLOW_OWN_HTTP === '1'
const parentHttpPort = process.env.PLM_FULL_APP_PARENT_HTTP_PORT
if (parentHttpPort && (!ownHttp || !/^[1-9][0-9]{0,4}$/.test(parentHttpPort)
  || Number(parentHttpPort) > 65535)) throw new Error('PLM_FULL_APP_INVALID_PARENT_HTTP_PORT')
let target = null
try {
  const raw = process.env.PLM_FULL_APP_DATABASE_URL
  target = raw ? new URL(raw) : null
  if (target && (target.protocol !== 'postgresql:' || target.hostname !== '127.0.0.1'
    || target.pathname !== '/plm_full_app_synthetic' || target.username !== 'postgres'
    || !/^[1-9][0-9]{0,4}$/.test(target.port) || Number(target.port) > 65535
    || !/^[0-9a-f]{64}$/.test(target.password) || target.search || target.hash)) throw new Error()
} catch { throw new Error('PLM_FULL_APP_INVALID_DISPOSABLE_TARGET') }

const live = new Set()
const own = (host, port) => ownHttp && host === '127.0.0.1'
  && ((parentHttpPort && String(port) === parentHttpPort)
    || [...live].some(server => String(server.address()?.port) === String(port)))
const originalListen = net.Server.prototype.listen
net.Server.prototype.listen = function (...args) {
  const input = typeof args[0] === 'object' ? args[0] : { port: args[0], host: args[1] }
  if (!ownHttp || input?.port !== 0 || input?.host !== '127.0.0.1') {
    noteBlocked('listener')
    stats.forbiddenConnections++
    throw new Error('PLM_FULL_APP_FORBIDDEN_LISTENER')
  }
  live.add(this)
  this.once('close', () => live.delete(this))
  return originalListen.apply(this, args)
}
const originalConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  const input = Array.isArray(args[0]) ? args[0] : args
  const options = typeof input[0] === 'object' && input[0] !== null
    ? input[0] : { port: input[0], host: typeof input[1] === 'string' ? input[1] : 'localhost' }
  // tsx's optional parent IPC remains blocked. Only its swallowed tooling
  // probe gets a separate counter; arbitrary named pipes remain violations.
  if (process.env.PLM_FULL_APP_BLOCK_OPTIONAL_TSX_PIPE === '1' && typeof options.path === 'string'
    && options.path.endsWith(`${process.ppid}.pipe`)
    && /node_modules[\\/]tsx[\\/]dist[\\/]client-[A-Za-z0-9_-]+\.(?:mjs|cjs)/.test(new Error().stack || '')) {
    blockedOptionalToolingPipes++
    throw new Error('PLM_FULL_APP_OPTIONAL_TSX_PIPE_BLOCKED')
  }
  if (!options.path && ((target && options.host === '127.0.0.1' && String(options.port) === target.port)
    || own(options.host, options.port))) {
    stats.allowedConnections++
    return originalConnect.apply(this, args)
  }
  stats.forbiddenConnections++
  noteBlocked('socket')
  throw new Error('PLM_FULL_APP_FORBIDDEN_NETWORK')
}
const originalFetch = globalThis.fetch
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (url.protocol === 'http:' && own(url.hostname, url.port)) return originalFetch(input, options)
  stats.forbiddenConnections++
  noteBlocked('fetch')
  throw new Error('PLM_FULL_APP_FORBIDDEN_FETCH')
}
const denyNetwork = () => { stats.forbiddenConnections++; noteBlocked('dns-or-udp'); throw new Error('PLM_FULL_APP_FORBIDDEN_NETWORK') }
const originalLookup = dns.lookup
for (const target of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
  for (const key of Object.getOwnPropertyNames(target)) {
    if (/^(?:lookup|reverse|resolve)/.test(key) && typeof target[key] === 'function') target[key] = denyNetwork
  }
}
// Node performs this callback even for a literal listener address. This narrow
// setup exception performs no hostname resolution and admits no other address.
dns.lookup = function (host, ...args) {
  if (ownHttp && host === '127.0.0.1') return originalLookup.call(this, host, ...args)
  return denyNetwork()
}
dgram.createSocket = denyNetwork
dgram.Socket.prototype.send = denyNetwork
const rejectEnv = input => {
  const value = input instanceof URL ? fileURLToPath(input)
    : Buffer.isBuffer(input) ? input.toString() : typeof input === 'string' ? input : ''
  if (/^\.env(?:\.|$)/i.test(path.basename(value))) {
    stats.forbiddenEnvReads++
    throw new Error('PLM_FULL_APP_FORBIDDEN_ENV_FILE')
  }
}
for (const method of ['readFile', 'readFileSync', 'open', 'openSync', 'createReadStream']) {
  const original = fs[method]
  fs[method] = function (input, ...rest) { rejectEnv(input); return original.call(this, input, ...rest) }
}
for (const method of ['readFile', 'open']) {
  const original = fs.promises[method]
  fs.promises[method] = function (input, ...rest) { rejectEnv(input); return original.call(this, input, ...rest) }
}
require('node:module').syncBuiltinESMExports()
globalThis.__PLM_FULL_APP_NETWORK_GUARD__ = Object.freeze({ snapshot: () => ({ ...stats,
  ...(blockedOrigins.length ? { blockedOrigins: blockedOrigins.map(fact => ({ ...fact })) } : {}) }), databaseAllowed: Boolean(target) })
process.on('exit', () => {
  if (blockedOptionalToolingPipes) console.error('PLM_FULL_APP_BLOCKED_OPTIONAL_TOOLING ' + JSON.stringify({ pipes: blockedOptionalToolingPipes }))
  console.error('PLM_FULL_APP_ISOLATION ' + JSON.stringify(stats))
  if (stats.forbiddenConnections || stats.forbiddenEnvReads) process.exitCode = 92
})
