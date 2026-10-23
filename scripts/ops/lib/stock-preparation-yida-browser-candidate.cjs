'use strict'

// Local comparison only: an explicit, immutable candidate, not an ambient
// executable override or a replacement for the default/official CI browser.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const ID = 'upstream-1719529'
const SHA = '43624de70dc3b379406282ec4a1365d9ba574c9741e4ab099d915b7e92811925'
const VERSION = '158.0.8107.0'

function digest(file) {
  const stat = fs.lstatSync(file)
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1)
  assert.equal(fs.realpathSync(file), file)
  const fd = fs.openSync(file, 'r'), hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024)
  try {
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (!count) break
      hash.update(buffer.subarray(0, count))
    }
  } finally { fs.closeSync(fd) }
  return hash.digest('hex')
}

function pinnedBrowserForRoot(root, selector) {
  if (selector === undefined) return undefined
  assert.equal(selector, ID)
  const executablePath = path.resolve(root, '../browser-fix-probe/upstream-1719529/chrome-linux/chrome')
  assert.equal(digest(executablePath), SHA)
  fs.accessSync(executablePath, fs.constants.X_OK)
  return Object.freeze({ id: ID, executablePath, sha256: SHA, version: VERSION, localOnly: true })
}

function browserFromOwner(root, env) {
  const ownerPath = env.YIDA_BROWSER_CI_OWNER, ownerSha = env.YIDA_BROWSER_CI_OWNER_SHA256
  if (ownerPath === undefined && ownerSha === undefined) return undefined
  assert.equal(typeof ownerPath, 'string')
  assert.match(ownerSha, /^[a-f0-9]{64}$/u)
  assert.match(path.relative(path.join(root, 'tmp'), ownerPath), /^yida-browser-ci-[a-f0-9-]{36}\/owner\.json$/u)
  const stat = fs.lstatSync(ownerPath)
  assert(stat.size < 65536 && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600)
  assert.equal(digest(ownerPath), ownerSha)
  const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'))
  assert.equal(owner.root, root)
  assert.equal(owner.protocol, 'YIDA_BROWSER_CI_NATIVE_V1')
  if (!Object.hasOwn(owner, 'browserCandidate')) return undefined
  const browser = pinnedBrowserForRoot(root, owner.browserCandidate.id)
  assert.deepEqual(owner.browserCandidate, browser)
  assert.equal(owner.hashes[browser.executablePath], browser.sha256)
  return browser
}

module.exports = { ID, SHA, VERSION, pinnedBrowserForRoot, browserFromOwner }
