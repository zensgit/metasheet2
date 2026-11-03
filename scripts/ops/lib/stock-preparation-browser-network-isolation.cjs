'use strict'

// Test-only authority. A page route or Node socket hook is not a native browser
// network boundary. Install only inside the launcher-owned Linux user/net/PID
// namespaces; all PG/Node/Chromium descendants inherit that network namespace.
// This does not isolate AF_UNIX, filesystem access, or malicious same-process
// code. Never treat a caller-provided snapshot as an installed capability.
const fs = require('node:fs')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

const readFile = fs.readFileSync.bind(fs)
const readLink = fs.readlinkSync.bind(fs)
const interfaces = os.networkInterfaces.bind(os)
let installed = null

function reject(code = 'UNAVAILABLE') {
  throw new Error('PLM_BROWSER_ISOLATION_' + code)
}
function namespace(value, kind) {
  return typeof value === 'string' && new RegExp('^' + kind + ':\\[[1-9][0-9]*\\]$').test(value)
}
function ipJson(args) {
  const result = spawnSync('/usr/sbin/ip', args, {
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 3000,
    maxBuffer: 32768,
  })
  if (result.status !== 0 || result.signal || result.error) reject()
  try {
    const rows = JSON.parse(result.stdout)
    if (!Array.isArray(rows) || rows.length > 32) reject()
    return rows
  } catch { reject() }
}
function initStartTime() {
  const bytes = readFile('/proc/1/stat')
  if (bytes.length > 16384) reject()
  const text = bytes.toString('utf8'), end = text.lastIndexOf(')')
  if (!text.startsWith('1 (') || end < 3) reject()
  const fields = text.slice(end + 2).trim().split(/\s+/)
  if (!/^[0-9]+$/.test(fields[19] || '')) reject()
  return fields[19]
}
function liveSnapshot(parentNetworkNamespace) {
  if (process.platform !== 'linux') reject('REQUIRED')
  const links = ipJson(['-json', 'link', 'show'])
  const addresses = Object.entries(interfaces()).flatMap(([name, rows]) =>
    (rows || []).map(row => ({ name, address: row.address, family: row.family, internal: row.internal })))
  const status = readFile('/proc/self/status', 'utf8')
  if (status.length > 16384) reject()
  const capabilities = ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'].map(key => {
    const match = new RegExp('^' + key + ':\\s*([0-9a-f]+)$', 'm').exec(status)
    if (!match) reject()
    return match[1]
  })
  return {
    parentNetworkNamespace,
    networkNamespace: readLink('/proc/self/ns/net'),
    initNetworkNamespace: readLink('/proc/1/ns/net'),
    pidNamespace: readLink('/proc/self/ns/pid'),
    initPidNamespace: readLink('/proc/1/ns/pid'),
    initExecutableMatches: readLink('/proc/1/exe') === process.execPath,
    initStartTime: initStartTime(),
    uid: process.getuid(), gid: process.getgid(),
    uidMap: readFile('/proc/self/uid_map', 'utf8').trim().split(/\s+/).map(Number),
    gidMap: readFile('/proc/self/gid_map', 'utf8').trim().split(/\s+/).map(Number),
    selfPid: process.pid, capabilities,
    links, addresses,
    routes4: ipJson(['-4', '-json', 'route', 'show', 'table', 'all']),
    routes6: ipJson(['-6', '-json', 'route', 'show', 'table', 'all']),
  }
}
function loopbackDestination(value, family) {
  if (family === 6) return value === '::1' || value === '::1/128'
  if (typeof value !== 'string') return false
  const match = /^(127)\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})(?:\/([0-9]{1,2}))?$/.exec(value)
  return !!match && match.slice(2, 5).every(part => Number(part) <= 255)
    && (match[5] === undefined || Number(match[5]) >= 8 && Number(match[5]) <= 32)
}
function validateSnapshot(snapshot, loopbackMayBeDown = false) {
  if (!snapshot || !namespace(snapshot.networkNamespace, 'net')
    || !namespace(snapshot.parentNetworkNamespace, 'net')
    || snapshot.networkNamespace === snapshot.parentNetworkNamespace
    || snapshot.initNetworkNamespace !== snapshot.networkNamespace
    || !namespace(snapshot.pidNamespace, 'pid') || snapshot.initPidNamespace !== snapshot.pidNamespace
    || snapshot.initExecutableMatches !== true || !/^[0-9]+$/.test(snapshot.initStartTime || '')) reject('REQUIRED')
  if (!Number.isSafeInteger(snapshot.uid) || snapshot.uid <= 0
    || !Number.isSafeInteger(snapshot.gid) || snapshot.gid <= 0
    || !Array.isArray(snapshot.uidMap) || snapshot.uidMap.length !== 3
    || !Array.isArray(snapshot.gidMap) || snapshot.gidMap.length !== 3
    || snapshot.uidMap[0] !== snapshot.uid || snapshot.uidMap[1] !== snapshot.uid || snapshot.uidMap[2] !== 1
    || snapshot.gidMap[0] !== snapshot.gid || snapshot.gidMap[1] !== snapshot.gid || snapshot.gidMap[2] !== 1) reject('REQUIRED')
  if (!Number.isSafeInteger(snapshot.selfPid) || snapshot.selfPid < 1
    || !Array.isArray(snapshot.capabilities) || snapshot.capabilities.length !== 5
    || snapshot.capabilities.some(value => typeof value !== 'string' || !/^[0-9a-f]{1,16}$/.test(value))
    || snapshot.selfPid !== 1 && snapshot.capabilities.some(value => !/^0+$/.test(value))) reject('REQUIRED')
  if (!Array.isArray(snapshot.links) || snapshot.links.length !== 1) reject('REQUIRED')
  const link = snapshot.links[0]
  if (link.ifname !== 'lo' || link.link_type !== 'loopback' || !Array.isArray(link.flags)
    || !link.flags.includes('LOOPBACK') || (!loopbackMayBeDown && !link.flags.includes('UP'))) reject('REQUIRED')
  if (!Array.isArray(snapshot.addresses) || snapshot.addresses.length > 2
    || (!loopbackMayBeDown && snapshot.addresses.length < 1)
    || snapshot.addresses.some(row => row.name !== 'lo' || row.internal !== true
      || !(row.family === 'IPv4' && row.address === '127.0.0.1'
        || row.family === 'IPv6' && row.address === '::1'))) reject('REQUIRED')
  for (const [rows, family] of [[snapshot.routes4, 4], [snapshot.routes6, 6]]) {
    if (!Array.isArray(rows) || rows.length > 16 || rows.some(row => !row || row.dev !== 'lo'
      || !loopbackDestination(row.dst, family) || row.gateway !== undefined || row.via !== undefined
      || row.nexthops !== undefined || row.encap !== undefined
      || row.type !== undefined && !['local', 'broadcast', 'unicast'].includes(row.type))) reject('REQUIRED')
  }
  return true
}
function installBrowserNetworkIsolation(parentNetworkNamespace) {
  if (process.pid === 1) reject('REQUIRED')
  if (!namespace(parentNetworkNamespace, 'net')) reject('REQUIRED')
  const snapshot = liveSnapshot(parentNetworkNamespace)
  validateSnapshot(snapshot)
  if (installed && (installed.parentNetworkNamespace !== parentNetworkNamespace
    || installed.networkNamespace !== snapshot.networkNamespace
    || installed.pidNamespace !== snapshot.pidNamespace
    || installed.initStartTime !== snapshot.initStartTime)) reject('DRIFT')
  installed = Object.freeze({ parentNetworkNamespace, networkNamespace: snapshot.networkNamespace,
    pidNamespace: snapshot.pidNamespace, initStartTime: snapshot.initStartTime })
  return assertBrowserNetworkIsolation()
}
function bootBrowserNetworkIsolation(parentNetworkNamespace) {
  // The namespace init must be this launcher, not a process that merely claims
  // isolation using environment variables or a fabricated receipt.
  if (process.platform !== 'linux' || process.pid !== 1 || installed) reject('REQUIRED')
  const before = liveSnapshot(parentNetworkNamespace)
  validateSnapshot(before, true)
  const result = spawnSync('/usr/sbin/ip', ['link', 'set', 'dev', 'lo', 'up'], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000,
  })
  if (result.status !== 0 || result.signal || result.error) reject()
  const after = liveSnapshot(parentNetworkNamespace)
  validateSnapshot(after)
  // The privileged namespace init only prepares loopback. It cannot install or
  // mint a browser-launch capability. setpriv must drop every capability before
  // a separate worker installs the guard from the trusted launcher preload.
  return Object.freeze({ prepared: true, canLaunchBrowser: false })
}
function verifyBrowserNamespaceLauncher(parentNetworkNamespace) {
  if (process.platform !== 'linux' || process.pid !== 1 || installed) reject('REQUIRED')
  const snapshot = liveSnapshot(parentNetworkNamespace)
  validateSnapshot(snapshot)
  if (snapshot.capabilities.some(value => !/^0+$/.test(value))) reject('REQUIRED')
  return Object.freeze({ prepared: true, canLaunchBrowser: false })
}
function assertBrowserNetworkIsolation() {
  if (!installed || process.pid === 1) reject('REQUIRED')
  const snapshot = liveSnapshot(installed.parentNetworkNamespace)
  validateSnapshot(snapshot)
  if (snapshot.networkNamespace !== installed.networkNamespace || snapshot.pidNamespace !== installed.pidNamespace
    || snapshot.initStartTime !== installed.initStartTime) reject('DRIFT')
  // Counts and booleans only: no host, route, pid, namespace or executable value
  // is returned as a public test receipt.
  return Object.freeze({ isolatedNetwork: true, isolatedPidTree: true, loopbackOnly: true, capabilitiesDropped: true,
    interfaces: snapshot.links.length, addresses: snapshot.addresses.length,
    routes: snapshot.routes4.length + snapshot.routes6.length, unixIpcIsolated: false })
}

module.exports = Object.freeze({ bootBrowserNetworkIsolation, verifyBrowserNamespaceLauncher, installBrowserNetworkIsolation,
  assertBrowserNetworkIsolation, validateSnapshot })
