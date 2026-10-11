import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const filename = fileURLToPath(import.meta.url)
const repoRoot = fs.realpathSync(path.resolve(path.dirname(filename), '../../..'))
const web = path.join(repoRoot, 'apps/web')
const requireWeb = createRequire(path.join(web, 'package.json'))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const key = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)
const relative = file => path.relative(repoRoot, file).replaceAll('\\', '/')
const inside = (parent, file) => key(file).startsWith(key(parent) + path.sep)
const keep = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT'])
for (const name of Object.keys(process.env)) if (!keep.has(name.toUpperCase())) delete process.env[name]
const guardFile = path.join(repoRoot, 'scripts/ops/lib/stock-preparation-plm-network-guard.cjs')
requireWeb(guardFile)

function plain(file, directory = false) {
  const info = fs.lstatSync(file)
  assert(!info.isSymbolicLink() && (directory ? info.isDirectory() : info.isFile())
    && key(fs.realpathSync(file)) === key(file), 'PLM_WEB_TYPES_PATH_INVALID')
}

function ownedScratch(scratchDir, expectedPid) {
  assert(typeof scratchDir === 'string' && path.isAbsolute(scratchDir), 'PLM_WEB_TYPES_OWNER_INVALID')
  assert.equal(path.dirname(scratchDir), path.join(repoRoot, 'tmp'), 'PLM_WEB_TYPES_OWNER_INVALID')
  const match = /^stock-preparation-plm-full-app-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(path.basename(scratchDir))
  assert(match, 'PLM_WEB_TYPES_OWNER_INVALID')
  plain(path.join(repoRoot, 'tmp'), true)
  plain(scratchDir, true)
  const markerFile = path.join(scratchDir, 'owner.json')
  plain(markerFile)
  assert(fs.statSync(markerFile).size < 16384, 'PLM_WEB_TYPES_OWNER_INVALID')
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'))
  assert.deepEqual(marker, { owner: 'PLM_FULL_APP_SCRATCH', nonce: match[1], repoRoot, pid: expectedPid }, 'PLM_WEB_TYPES_OWNER_INVALID')
  return marker
}

function preload(scratchDir, runnerPid, helperPid) {
  assert.equal(process.ppid, helperPid, 'PLM_WEB_TYPES_HELPER_INVALID')
  ownedScratch(scratchDir, runnerPid)
  const owner = path.join(scratchDir, 'build/web-types')
  for (const dir of [path.join(scratchDir, 'build'), owner, path.join(owner, 'tool-temp')]) plain(dir, true)
  for (const name of ['TEMP', 'TMP', 'TMPDIR']) process.env[name] = path.join(owner, 'tool-temp')
  const raw = Object.fromEntries(['readFileSync', 'writeFileSync', 'mkdirSync', 'existsSync', 'statSync', 'lstatSync', 'readdirSync', 'realpathSync', 'openSync'].map(name => [name, fs[name].bind(fs)]))
  const rawRead = file => {
    const fd = raw.openSync(file, 'r')
    try { return raw.readFileSync(fd) } finally { fs.closeSync(fd) }
  }
  const inputs = new Map()
  let sourceUnchanged = true
  const recordInput = file => {
    if (typeof file !== 'string' || inside(owner, file)) return
    assert(inside(repoRoot, file), 'PLM_WEB_TYPES_EXTERNAL_INPUT')
    const digest = sha256(rawRead(file))
    const prior = inputs.get(relative(file))
    if (prior && prior !== digest) sourceUnchanged = false
    inputs.set(relative(file), digest)
  }
  for (const file of [filename, guardFile, path.join(repoRoot, 'package.json'), path.join(repoRoot, 'pnpm-lock.yaml'),
    path.join(web, 'package.json'), path.join(web, 'node_modules/vue-tsc/bin/vue-tsc.js')]) recordInput(file)
  const originalCache = new Map()
  const rememberCache = file => {
    if (!originalCache.has(file)) originalCache.set(file, raw.existsSync(file) ? sha256(rawRead(file)) : null)
  }
  const cacheFiles = ['tsconfig.app.tsbuildinfo', 'tsconfig.node.tsbuildinfo'].map(name => path.join(web, 'node_modules/.tmp', name))
  cacheFiles.forEach(rememberCache)
  const redirects = new Map(cacheFiles.map(file => [key(file), path.join(owner, path.basename(file))]))
  const globalDir = path.join(web, 'node_modules/.vue-global-types')
  const directories = new Map([[key(path.join(web, 'node_modules/.tmp')), owner], [key(globalDir), path.join(owner, 'global-types')]])
  const redirect = file => {
    if (typeof file !== 'string') return file
    if (key(path.dirname(file)) === key(globalDir) && /^[a-z0-9_.-]+\.d\.ts$/i.test(path.basename(file)) && !redirects.has(key(file))) {
      rememberCache(file)
      redirects.set(key(file), path.join(owner, 'global-types', path.basename(file)))
    }
    return redirects.get(key(file)) ?? directories.get(key(file)) ?? file
  }
  fs.readFileSync = (file, ...args) => {
    const physical = redirect(file)
    const bytes = raw.readFileSync(physical, ...args)
    if (physical === file) recordInput(file)
    return bytes
  }
  for (const name of ['existsSync', 'statSync', 'lstatSync', 'readdirSync']) fs[name] = (file, ...args) => raw[name](redirect(file), ...args)
  // Keep the compiler's logical path: generated declarations must resolve Vue
  // through the original node_modules ancestry, not through scratch storage.
  fs.realpathSync = (file, ...args) => redirect(file) === file ? raw.realpathSync(file, ...args) : path.resolve(file)
  fs.realpathSync.native = fs.realpathSync
  let outsideOwnerWriteAttempts = 0
  const deny = () => { outsideOwnerWriteAttempts++; throw new Error('PLM_WEB_TYPES_WRITE_DENIED') }
  const writable = file => {
    const physical = redirect(file)
    if (physical === file || !inside(owner, physical)) return deny()
    raw.mkdirSync(path.dirname(physical), { recursive: true })
    return physical
  }
  fs.openSync = (file, flags, ...args) => raw.openSync(typeof flags === 'number' || /[wa+]/.test(flags) ? writable(file) : redirect(file), flags, ...args)
  fs.writeFileSync = (file, ...args) => raw.writeFileSync(writable(file), ...args)
  fs.mkdirSync = (file, ...args) => {
    const physical = redirect(file)
    if (physical === file || (physical !== owner && !inside(owner, physical))) return deny()
    return raw.mkdirSync(physical, ...args)
  }
  for (const name of ['appendFile', 'rename', 'unlink', 'rm', 'rmdir', 'truncate', 'copyFile', 'symlink', 'link', 'utimes', 'chmod', 'chown']) {
    fs[name] = fs[name + 'Sync'] = deny
    fs.promises[name] = deny
  }
  for (const name of ['writeFile', 'mkdir', 'open']) fs[name] = fs.promises[name] = deny
  syncBuiltinESMExports()
  process.on('exit', code => {
    for (const [file, digest] of inputs) if (!raw.existsSync(path.join(repoRoot, file)) || sha256(rawRead(path.join(repoRoot, file))) !== digest) sourceUnchanged = false
    const originalCacheUnchanged = [...originalCache].every(([file, digest]) => (raw.existsSync(file) ? sha256(rawRead(file)) : null) === digest)
    const guard = globalThis.__PLM_FULL_APP_NETWORK_GUARD__
    const receipt = { schemaVersion: 1, kind: 'web-types', result: 'pending-cli-exit', exitCode: code,
      packageTypecheckRun: true, command: 'node --max-old-space-size=4096 --import <owned-preload> node_modules/vue-tsc/bin/vue-tsc.js -b --force', cwd: 'apps/web',
      compilerOptionsChanged: false, rootFilesAdded: false, originalConfigGraph: true,
      sourceInputs: [...inputs].sort(([left], [right]) => left.localeCompare(right)).map(([file, digest]) => ({ path: file, sha256: digest })),
      sourceUnchanged, originalCacheUnchanged, outsideOwnerWriteAttempts,
      redirects: [...redirects].map(([from, to]) => ({ from: relative(from), to: relative(to), sha256: raw.existsSync(to) ? sha256(rawRead(to)) : null })),
      isolation: { ...guard.snapshot(), databaseAllowed: guard.databaseAllowed },
      limitations: ['Cache bytes are redirected; source paths, configuration and CLI options are otherwise original.',
        'Node IO observations do not attest OS network isolation.'] }
    const fd = raw.openSync(path.join(owner, 'receipt.json'), 'wx')
    try { fs.writeSync(fd, JSON.stringify(receipt, null, 2) + '\n') } finally { fs.closeSync(fd) }
    if (!sourceUnchanged || !originalCacheUnchanged || outsideOwnerWriteAttempts) process.exitCode = 93
  })
}

function run(scratchDir) {
  const marker = ownedScratch(scratchDir, process.ppid)
  const build = path.join(scratchDir, 'build')
  if (fs.existsSync(build)) plain(build, true)
  else fs.mkdirSync(build)
  const owner = path.join(build, 'web-types')
  // A prior run's receipt/cache cannot stand in for this invocation.
  fs.mkdirSync(owner)
  fs.mkdirSync(path.join(owner, 'tool-temp'))
  const url = pathToFileURL(filename)
  url.searchParams.set('scratch', scratchDir)
  url.searchParams.set('runner', String(marker.pid))
  url.searchParams.set('helper', String(process.pid))
  const cli = path.join(web, 'node_modules/vue-tsc/bin/vue-tsc.js')
  const args = ['--max-old-space-size=4096', '--import', url.href, cli, '-b', '--force']
  const result = spawnSync(process.execPath, args, { cwd: web, env: process.env, windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 600000 })
  const receiptFile = path.join(owner, 'receipt.json')
  assert(fs.existsSync(receiptFile), 'PLM_WEB_TYPES_RECEIPT_MISSING')
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'))
  receipt.exitCode = result.status
  receipt.diagnostics = (result.stdout ?? '').split('\n').filter(line => /error TS\d+:/.test(line)).map(line => line.trim())
  receipt.result = result.status === 0 && receipt.diagnostics.length === 0 && receipt.sourceUnchanged
    && receipt.originalCacheUnchanged && receipt.outsideOwnerWriteAttempts === 0 && receipt.redirects.every(item => item.sha256)
    && receipt.isolation.forbiddenConnections === 0 && receipt.isolation.forbiddenEnvReads === 0
    && receipt.isolation.allowedConnections === 0 && receipt.isolation.databaseAllowed === false ? 'passed' : 'failed'
  fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n')
  console.log('PLM_FULL_APP_WEB_TYPECHECK ' + JSON.stringify({ result: receipt.result, exitCode: receipt.exitCode,
    diagnostics: receipt.diagnostics.length, inputs: receipt.sourceInputs.length, receipt: relative(receiptFile) }))
  for (const diagnostic of receipt.diagnostics) console.log('PLM_FULL_APP_WEB_TYPECHECK_DIAGNOSTIC ' + diagnostic)
  assert.equal(receipt.result, 'passed', 'PLM_WEB_TYPES_FAILED')
}

try {
  const params = new URL(import.meta.url).searchParams
  if (params.has('scratch')) preload(params.get('scratch'), Number(params.get('runner')), Number(params.get('helper')))
  else {
    assert.equal(process.argv.length, 3, 'PLM_WEB_TYPES_ARGUMENTS_INVALID')
    run(process.argv[2])
  }
} catch {
  console.error('PLM_FULL_APP_WEB_TYPECHECK_FAILED')
  process.exit(1)
}
