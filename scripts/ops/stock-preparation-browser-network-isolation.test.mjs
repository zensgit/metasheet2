import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const require = createRequire(import.meta.url)
const modulePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib/stock-preparation-browser-network-isolation.cjs')
const actual = require(modulePath)
const snapshot = () => ({ parentNetworkNamespace: 'net:[1]', networkNamespace: 'net:[2]', initNetworkNamespace: 'net:[2]',
  pidNamespace: 'pid:[3]', initPidNamespace: 'pid:[3]', initExecutableMatches: true, initStartTime: '123',
  uid: 1000, gid: 1000, uidMap: [1000, 1000, 1], gidMap: [1000, 1000, 1],
  selfPid: 2, capabilities: ['0', '0', '0', '0', '0'],
  links: [{ ifname: 'lo', link_type: 'loopback', flags: ['LOOPBACK', 'UP'] }],
  addresses: [{ name: 'lo', address: '127.0.0.1', family: 'IPv4', internal: true }],
  routes4: [{ dst: '127.0.0.0/8', dev: 'lo', type: 'local' }], routes6: [] })
const rejected = value => assert.throws(() => actual.validateSnapshot(value), /PLM_BROWSER_ISOLATION_REQUIRED/)

test('kernel snapshot contract: actual separate namespace and only loopback', () => {
  assert.equal(actual.validateSnapshot(snapshot()), true)
  const both = snapshot()
  both.addresses.push({ name: 'lo', address: '::1', family: 'IPv6', internal: true })
  both.routes6.push({ dst: '::1/128', dev: 'lo', type: 'local' })
  assert.equal(actual.validateSnapshot(both), true)
})
for (const [name, change] of [
  ['same-as-parent', row => { row.networkNamespace = row.parentNetworkNamespace; row.initNetworkNamespace = row.networkNamespace }],
  ['init-in-other-network', row => { row.initNetworkNamespace = 'net:[4]' }],
  ['init-in-other-pid-namespace', row => { row.initPidNamespace = 'pid:[4]' }],
  ['foreign-init-executable', row => { row.initExecutableMatches = false }],
  ['uid-root', row => { row.uid = 0; row.uidMap = [0, 0, 1] }],
  ['gid-root', row => { row.gid = 0; row.gidMap = [0, 0, 1] }],
  ['root-mapped-as-current-user', row => { row.uidMap = [1000, 0, 1] }],
  ['broad-uid-map', row => { row.uidMap = [1000, 1000, 2] }],
  ['retained-effective-capability', row => { row.capabilities[2] = '2000' }],
  ['retained-bounding-capability', row => { row.capabilities[3] = '1' }],
  ['unknown-capability', row => { row.capabilities[4] = '?' }],
  ['non-loopback-device', row => { row.links.push({ ifname: 'eth0' }) }],
  ['renamed-device', row => { row.links[0].ifname = 'other' }],
  ['loopback-down', row => { row.links[0].flags = ['LOOPBACK'] }],
  ['non-internal-address', row => { row.addresses[0].internal = false }],
  ['foreign-address', row => { row.addresses[0].address = '192.0.2.1' }],
  ['default-route', row => { row.routes4.push({ dst: 'default', dev: 'lo' }) }],
  ['foreign-device-route', row => { row.routes4[0].dev = 'eth0' }],
  ['gateway', row => { row.routes4[0].gateway = '127.0.0.1' }],
  ['multipath', row => { row.routes4[0].nexthops = [] }],
  ['ipv6-default', row => { row.routes6.push({ dst: 'default', dev: 'lo' }) }],
  ['broader-than-loopback', row => { row.routes4[0].dst = '127.0.0.0/7' }],
  ['invalid-octet', row => { row.routes4[0].dst = '127.999.0.1' }],
  ['missing-address', row => { row.addresses = [] }],
]) {
  test('rejects ' + name + ' without creating a browser capability', () => { const row = snapshot(); change(row); rejected(row) })
}
test('receipt cannot mint live capability; uninstalled native launch is rejected', () => {
  actual.validateSnapshot(snapshot())
  assert.throws(() => actual.assertBrowserNetworkIsolation(), /PLM_BROWSER_ISOLATION_REQUIRED/)
  if (process.platform !== 'linux') {
    assert.throws(() => actual.installBrowserNetworkIsolation('net:[1]'), /PLM_BROWSER_ISOLATION_REQUIRED/)
    assert.throws(() => actual.bootBrowserNetworkIsolation('net:[1]'), /PLM_BROWSER_ISOLATION_REQUIRED/)
  }
})
test('single actual-source namespace equality removal is caught by same snapshot', () => {
  const source = fs.readFileSync(modulePath, 'utf8')
  const needle = 'snapshot.networkNamespace === snapshot.parentNetworkNamespace'
  assert.equal(source.split(needle).length - 1, 1)
  const module = { exports: {} }
  vm.runInNewContext(source.replace(needle, 'false'), { require, module, process, Buffer }, { filename: modulePath })
  const row = snapshot(); row.networkNamespace = row.parentNetworkNamespace; row.initNetworkNamespace = row.networkNamespace
  rejected(row)
  assert.equal(module.exports.validateSnapshot(row), true)
  assert.throws(() => module.exports.assertBrowserNetworkIsolation(), /PLM_BROWSER_ISOLATION_REQUIRED/)
})
