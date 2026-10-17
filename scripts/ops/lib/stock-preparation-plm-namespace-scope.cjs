'use strict'

// Local synthetic acceptance only. This authority is an owner-bound filesystem
// capability created by the fixed CLI, not an environment flag or HTTP input.
// It does not defend against malicious same-process code or filesystem owners.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const native = require('./stock-preparation-browser-network-isolation.cjs')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const sha = /^[a-f0-9]{64}$/
const registered = new WeakSet()
let installedScope
const SOURCE_PATHS = Object.freeze([
  'scripts/ops/run-stock-preparation-plm-full-app.mjs',
  'scripts/ops/lib/stock-preparation-plm-namespace-scope.cjs',
  'scripts/ops/lib/stock-preparation-browser-network-isolation.cjs',
  'scripts/ops/lib/stock-preparation-plm-namespace.mjs',
  'scripts/ops/lib/stock-preparation-plm-namespace-bootstrap.py',
  'scripts/ops/lib/stock-preparation-yida-browser-candidate.cjs',
])
function plain(target, directory = false) {
  assert(path.isAbsolute(target) && fs.realpathSync(target) === target, 'PLM_FULL_APP_NAMESPACE_PATH_REDIRECTED')
  const stat = fs.lstatSync(target)
  assert(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1),
    'PLM_FULL_APP_NAMESPACE_PLAIN_PATH_REQUIRED')
  return stat
}
function preloadBytes({ repoRoot, nonce, ownerSha256 }) {
  return Buffer.from("'use strict';\nrequire(" + JSON.stringify(path.join(repoRoot, SOURCE_PATHS[1]))
    + ').installOwnedNamespacePreload(' + JSON.stringify({ repoRoot, nonce, ownerSha256 }) + ');\n')
}
function scopeFromOwner({ repoRoot, nonce, ownerSha256, preloadSha256 }) {
  assert(typeof repoRoot === 'string' && path.isAbsolute(repoRoot), 'PLM_FULL_APP_NAMESPACE_ROOT_REQUIRED')
  plain(repoRoot, true)
  assert(repoRoot === path.resolve(__dirname, '../../..'), 'PLM_FULL_APP_NAMESPACE_ROOT_MISMATCH')
  assert(uuid.test(nonce) && sha.test(ownerSha256), 'PLM_FULL_APP_NAMESPACE_DESCRIPTOR_INVALID')
  const directory = path.join(repoRoot, 'tmp', 'stock-preparation-plm-full-app-namespace-' + nonce)
  plain(path.join(repoRoot, 'tmp'), true); plain(directory, true)
  const ownerPath = path.join(directory, 'owner.json')
  const stat = plain(ownerPath)
  assert(stat.size > 0 && stat.size <= 16384, 'PLM_FULL_APP_NAMESPACE_OWNER_INVALID')
  const bytes = fs.readFileSync(ownerPath)
  assert.equal(hash(bytes), ownerSha256, 'PLM_FULL_APP_NAMESPACE_OWNER_HASH_MISMATCH')
  const owner = JSON.parse(bytes)
  assert.deepEqual(Object.keys(owner).sort(), ['automationScenario', 'node', 'nodeSha256', 'nonce', 'owner',
    'parentNamespace', 'pgBin', 'pid', 'repoRoot', 'sources', 'uid',
    ...(Object.hasOwn(owner, 'browserCandidate') ? ['browserCandidate'] : [])].sort())
  if (Object.hasOwn(owner, 'browserCandidate')) {
    const candidate = require('./stock-preparation-yida-browser-candidate.cjs')
      .pinnedBrowserForRoot(repoRoot, owner.browserCandidate?.id)
    assert(candidate, 'PLM_FULL_APP_NAMESPACE_BROWSER_CANDIDATE_REQUIRED')
    assert.deepEqual(owner.browserCandidate, candidate, 'PLM_FULL_APP_NAMESPACE_BROWSER_CANDIDATE_MISMATCH')
  }
  assert(owner.owner === 'PLM_FULL_APP_NAMESPACE' && owner.repoRoot === repoRoot && owner.nonce === nonce,
    'PLM_FULL_APP_NAMESPACE_OWNER_MISMATCH')
  assert(Number.isSafeInteger(owner.pid) && owner.pid > 0 && Number.isSafeInteger(owner.uid) && owner.uid > 0,
    'PLM_FULL_APP_NAMESPACE_OWNER_INVALID')
  assert(/^net:\[[1-9][0-9]*\]$/.test(owner.parentNamespace), 'PLM_FULL_APP_NAMESPACE_PARENT_INVALID')
  assert(['manual', 'interval'].includes(owner.automationScenario) && typeof owner.pgBin === 'string'
    && path.isAbsolute(owner.pgBin), 'PLM_FULL_APP_NAMESPACE_OPTIONS_INVALID')
  assert(typeof owner.node === 'string' && path.isAbsolute(owner.node) && sha.test(owner.nodeSha256),
    'PLM_FULL_APP_NAMESPACE_NODE_INVALID')
  plain(owner.node)
  assert.equal(fs.realpathSync(process.execPath), owner.node, 'PLM_FULL_APP_NAMESPACE_NODE_MISMATCH')
  const executable = fs.readFileSync(owner.node)
  assert(executable.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])), 'PLM_FULL_APP_NAMESPACE_ELF_REQUIRED')
  assert.equal(hash(executable), owner.nodeSha256, 'PLM_FULL_APP_NAMESPACE_NODE_HASH_MISMATCH')
  assert.equal(process.versions.node.split('.')[0], '20', 'PLM_FULL_APP_NAMESPACE_NODE20_REQUIRED')
  assert(Array.isArray(owner.sources) && owner.sources.length === SOURCE_PATHS.length,
    'PLM_FULL_APP_NAMESPACE_SOURCE_INVENTORY_INVALID')
  assert.deepEqual(owner.sources.map(row => row.path), SOURCE_PATHS, 'PLM_FULL_APP_NAMESPACE_SOURCE_INVENTORY_INVALID')
  for (const row of owner.sources) {
    assert(sha.test(row.sha256), 'PLM_FULL_APP_NAMESPACE_SOURCE_HASH_INVALID')
    const source = path.join(repoRoot, row.path); plain(source)
    assert.equal(hash(fs.readFileSync(source)), row.sha256, 'PLM_FULL_APP_NAMESPACE_SOURCE_CHANGED')
  }
  const preloadPath = path.join(directory, 'worker-preload.cjs')
  plain(preloadPath)
  const expected = preloadBytes({ repoRoot, nonce, ownerSha256 })
  assert(fs.readFileSync(preloadPath).equals(expected), 'PLM_FULL_APP_NAMESPACE_PRELOAD_CHANGED')
  const expectedSha256 = hash(expected)
  assert(preloadSha256 === undefined || preloadSha256 === expectedSha256,
    'PLM_FULL_APP_NAMESPACE_PRELOAD_HASH_MISMATCH')
  const scope = Object.freeze({ repoRoot, nonce, ownerSha256, preloadSha256: expectedSha256, ownerPath,
    preloadPath, parentNamespace: owner.parentNamespace, owner })
  registered.add(scope)
  return scope
}
function decodeScope(repoRoot, argument) {
  assert(typeof argument === 'string', 'PLM_FULL_APP_NAMESPACE_DESCRIPTOR_REQUIRED')
  const match = /^--plm-full-app-namespace=([a-f0-9-]{36}):([a-f0-9]{64}):([a-f0-9]{64})$/.exec(argument)
  assert(match, 'PLM_FULL_APP_NAMESPACE_DESCRIPTOR_INVALID')
  return scopeFromOwner({ repoRoot, nonce: match[1], ownerSha256: match[2], preloadSha256: match[3] })
}
function assertOwnedNamespaceScope(scope) {
  assert(scope && registered.has(scope), 'PLM_FULL_APP_NAMESPACE_CAPABILITY_REQUIRED')
  scopeFromOwner(scope)
  assert.equal(process.getuid?.(), scope.owner.uid, 'PLM_FULL_APP_NAMESPACE_UID_MISMATCH')
  return native.assertBrowserNetworkIsolation()
}
function installOwnedNamespacePreload(config) {
  const scope = scopeFromOwner(config)
  assert.equal(process.getuid?.(), scope.owner.uid, 'PLM_FULL_APP_NAMESPACE_UID_MISMATCH')
  native.installBrowserNetworkIsolation(scope.parentNamespace)
  assertOwnedNamespaceScope(scope)
  installedScope = scope
}
function installedBrowserCandidate() {
  assert(installedScope, 'PLM_FULL_APP_NAMESPACE_CAPABILITY_REQUIRED')
  const scope = scopeFromOwner(installedScope)
  assertOwnedNamespaceScope(scope)
  return scope.owner.browserCandidate
}
function namespaceChildArguments(scope) {
  assertOwnedNamespaceScope(scope)
  return ['--require', scope.preloadPath]
}
function namespaceArgument(scope) {
  assertOwnedNamespaceScope(scope)
  return `--plm-full-app-namespace=${scope.nonce}:${scope.ownerSha256}:${scope.preloadSha256}`
}
module.exports = Object.freeze({ SOURCE_PATHS, preloadBytes, scopeFromOwner, decodeScope, assertOwnedNamespaceScope,
  installOwnedNamespacePreload, namespaceChildArguments, namespaceArgument, installedBrowserCandidate })
