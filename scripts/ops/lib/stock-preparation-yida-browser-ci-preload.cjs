'use strict'

// NODE_OPTIONS is minted only by the owned worker. The config's explicit fork
// execArgv does not carry parent require.cache; each actual Node fork must load
// and install the exact file subsequently required by the browser fixture.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const fail = () => { throw new Error('YIDA_BROWSER_CI_PRELOAD_FAILED') }
function plain(file, dependencyHardlinks = false) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 && !dependencyHardlinks
    || fs.realpathSync(file) !== file) fail()
  return stat
}
function hash(file, dependencyHardlinks = false) {
  plain(file, dependencyHardlinks)
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}
try {
  if (process.platform !== 'linux' || process.pid === 1 || Number(process.versions.node.split('.')[0]) !== 20) fail()
  if (!/^NoNewPrivs:\s*1$/m.test(fs.readFileSync('/proc/self/status', 'utf8'))) fail()
  const ownerPath = process.env.YIDA_BROWSER_CI_OWNER
  const ownerSha = process.env.YIDA_BROWSER_CI_OWNER_SHA256
  if (!path.isAbsolute(ownerPath || '') || !/^[a-f0-9]{64}$/.test(ownerSha || '')) fail()
  const stat = plain(ownerPath)
  if ((stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid() || stat.size > 65535 || hash(ownerPath) !== ownerSha) fail()
  const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'))
  const root = path.resolve(__dirname, '../../..')
  const cli = require('node:module').createRequire(path.join(root, 'packages/core-backend/package.json')).resolve('vitest/vitest.mjs')
  if (owner.protocol !== 'YIDA_BROWSER_CI_NATIVE_V1' || owner.root !== root
    || owner.uid !== process.getuid() || owner.gid !== process.getgid()
    || owner.node !== process.execPath || owner.preload !== __filename || owner.cli !== cli
    || owner.native !== path.join(__dirname, 'stock-preparation-browser-network-isolation.cjs')) fail()
  if (owner.hashes[owner.native] !== 'cf364bfed3960af8e5c387a4c5d7aa882ce1d558c84f937e6b5816ae5927980c') fail()
  const command = fs.readFileSync('/proc/1/cmdline', 'utf8').split('\0').filter(Boolean)
  if (JSON.stringify(command) !== JSON.stringify([owner.node, owner.runner, '--namespace-init', ownerPath, ownerSha])) fail()
  for (const [file, sha] of Object.entries(owner.hashes)) if (hash(file, file === cli) !== sha) fail()
  const native = require(owner.native)
  native.installBrowserNetworkIsolation(owner.parentNetworkNamespace)
  // No fabricated snapshot, exported token, socket monkeypatch or zero-counter
  // claim. AF_UNIX, filesystem and hostile same-process code remain out of scope.
} catch { fail() }
