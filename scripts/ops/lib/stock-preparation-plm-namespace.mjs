import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const file = fileURLToPath(import.meta.url)
const repository = fs.realpathSync(path.resolve(path.dirname(file), '../../..'))
const require = createRequire(import.meta.url)
const scopes = require('./stock-preparation-plm-namespace-scope.cjs')
const native = require('./stock-preparation-browser-network-isolation.cjs')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
/** Only this exact child is killed. SIGTERM is never entrusted to unshare's
 * --fork forwarding. A close timeout is an explicit failure, not clean drain. */
export function runOwnedNamespaceChild(command, args, env, timeout, expectedMarker) {
  assert(['PLM_FULL_APP_RESULT ', 'PLM_FULL_APP_NAMESPACE_RESULT '].includes(expectedMarker),
    'PLM_FULL_APP_NAMESPACE_MARKER_INVALID')
  assert(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 1080000,
    'PLM_FULL_APP_NAMESPACE_DEADLINE_INVALID')
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] })
    let settled = false, stopped = false, spawnFailed = false, captureInvalid = false, observed = 0
    let drainTimer, buffer = ''
    const markers = []
    const finish = error => {
      if (settled) return
      settled = true
      clearTimeout(timer); if (drainTimer) clearTimeout(drainTimer)
      process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop)
      if (error) reject(new Error('PLM_FULL_APP_NAMESPACE_CHILD_FAILED'))
      else resolve(markers[0])
    }
    const stop = () => {
      if (settled || stopped) return
      stopped = true
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL') } catch { /* Still fail, then close only these owned handles. */ }
      }
      drainTimer = setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish(true)
      }, 10000)
    }
    process.once('SIGTERM', stop); process.once('SIGINT', stop)
    const timer = setTimeout(stop, timeout)
    const line = value => {
      if (!value.startsWith(expectedMarker)) return
      try { markers.push(JSON.parse(value.slice(expectedMarker.length))) }
      catch { captureInvalid = true; stop() }
      if (markers.length > 1) { captureInvalid = true; stop() }
    }
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
      // Preserve the actual streams byte-for-byte. The parser only handles the
      // small values-free terminal frame and never manufactures a substitute.
      observed += chunk.length
      if (!Buffer.isBuffer(chunk) || observed > 32 * 1024 * 1024) { captureInvalid = true; stop(); return }
      process[stream].write(chunk)
      if (stream === 'stdout') {
        buffer += chunk.toString('utf8')
        const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? ''
        if (buffer.length > 65536) { captureInvalid = true; stop() }
        for (const value of lines) line(value)
      }
    })
    for (const stream of ['stdout', 'stderr']) child[stream].once('error', () => { captureInvalid = true; stop() })
    child.once('error', () => { spawnFailed = true; stop() })
    child.once('close', (code, signal) => {
      if (buffer) line(buffer)
      let valid = markers.length === 1
      const value = markers[0]
      if (valid && expectedMarker === 'PLM_FULL_APP_RESULT ') valid = value?.result === 'passed'
        && value.failure === undefined && value.cleanup === 'stopped-and-owned-database-removed'
        && typeof value.evidence === 'string' && /^artifacts\/stock-preparation-plm-full-app\/[a-f0-9-]{36}\.json$/.test(value.evidence)
        && /^[a-f0-9]{64}$/.test(value.sha256) && Number.isSafeInteger(value.sourceFiles) && value.sourceFiles > 0
        && Object.keys(value).length === 5
      if (valid && expectedMarker === 'PLM_FULL_APP_NAMESPACE_RESULT ') valid = value?.passed === true
        && value.workerReceiptObserved === true && value.normalChildExit === true
        && value.pidInitCapabilitiesZero === true && value.ordinaryWorker === true
        && Object.keys(value).length === 5
      finish(stopped || spawnFailed || captureInvalid || signal !== null || code !== 0 || !valid)
    })
  })
}

export async function launchFullAppNamespace(options, cleanEnvironment) {
  assert(process.platform === 'linux' && process.getuid() > 0 && process.getgid() > 0,
    'PLM_FULL_APP_NAMESPACE_LINUX_NONROOT_REQUIRED')
  assert.equal(process.versions.node.split('.')[0], '20', 'PLM_FULL_APP_NAMESPACE_NODE20_REQUIRED')
  assert(options && path.isAbsolute(options.pgBin) && ['manual', 'interval'].includes(options.automationScenario),
    'PLM_FULL_APP_NAMESPACE_OPTIONS_INVALID')
  const node = fs.realpathSync(process.execPath), executable = fs.readFileSync(node)
  assert(executable.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])), 'PLM_FULL_APP_NAMESPACE_ELF_REQUIRED')
  const nonce = randomUUID(), directory = path.join(repository, 'tmp', 'stock-preparation-plm-full-app-namespace-' + nonce)
  fs.mkdirSync(path.join(repository, 'tmp'), { recursive: true })
  fs.mkdirSync(directory, { mode: 0o700 })
  const owner = { owner: 'PLM_FULL_APP_NAMESPACE', nonce, repoRoot: repository, pid: process.pid,
    uid: process.getuid(), parentNamespace: fs.readlinkSync('/proc/self/ns/net'), node, nodeSha256: hash(executable),
    pgBin: options.pgBin, automationScenario: options.automationScenario,
    sources: scopes.SOURCE_PATHS.map(relative => ({ path: relative, sha256: hash(fs.readFileSync(path.join(repository, relative))) })) }
  const ownerBytes = Buffer.from(JSON.stringify(owner) + '\n'), ownerSha256 = hash(ownerBytes)
  fs.writeFileSync(path.join(directory, 'owner.json'), ownerBytes, { flag: 'wx', mode: 0o600 })
  fs.writeFileSync(path.join(directory, 'worker-preload.cjs'), scopes.preloadBytes({ repoRoot: repository, nonce, ownerSha256 }),
    { flag: 'wx', mode: 0o600 })
  // Validate all fixed paths and hashes before the first native child. Ambient
  // NODE_OPTIONS is never inherited; the second worker wash remains intact.
  scopes.scopeFromOwner({ repoRoot: repository, nonce, ownerSha256 })
  const env = cleanEnvironment(process.env)
  await runOwnedNamespaceChild('/usr/bin/unshare', ['--user', '--map-current-user', '--keep-caps', '--net', '--pid', '--fork',
    '--mount-proc', '--propagation', 'private', '--kill-child=SIGKILL', '/usr/bin/python3',
    path.join(repository, 'scripts/ops/lib/stock-preparation-plm-namespace-bootstrap.py'), repository, nonce, ownerSha256],
  env, 1080000, 'PLM_FULL_APP_NAMESPACE_RESULT ')
  // Owned marker/preload retained as source-bound private diagnostics. Never
  // delete a user's checkout or pretend unreadable process census proves zero.
}

if (process.argv[1] && path.resolve(process.argv[1]) === file) {
  try {
    assert(process.argv.length === 6 && process.argv[2] === '--namespace-init' && process.argv[3] === repository,
      'PLM_FULL_APP_NAMESPACE_INIT_ARGUMENT_INVALID')
    const scope = scopes.scopeFromOwner({ repoRoot: repository, nonce: process.argv[4], ownerSha256: process.argv[5] })
    assert.equal(process.pid, 1, 'PLM_FULL_APP_NAMESPACE_INIT_PID_REQUIRED')
    assert.equal(process.getuid(), scope.owner.uid, 'PLM_FULL_APP_NAMESPACE_UID_MISMATCH')
    assert.deepEqual(native.verifyBrowserNamespaceLauncher(scope.parentNamespace), { prepared: true, canLaunchBrowser: false })
    assert.throws(() => native.assertBrowserNetworkIsolation(), /PLM_BROWSER_ISOLATION_REQUIRED/)
    const { cleanEnvironment } = await import('../run-stock-preparation-plm-full-app.mjs')
    // PID1 only supervises. The ordinary child creates/owns its PG and build
    // scratch using its own PID and retains every original acceptance stage.
    await runOwnedNamespaceChild(scope.owner.node, ['--require', scope.preloadPath,
      path.join(repository, 'scripts/ops/run-stock-preparation-plm-full-app.mjs'),
      `--plm-full-app-namespace=${scope.nonce}:${scope.ownerSha256}:${scope.preloadSha256}`,
      `--pg-bin=${scope.owner.pgBin}`, `--automation-scenario=${scope.owner.automationScenario}`],
    cleanEnvironment(process.env), 1050000, 'PLM_FULL_APP_RESULT ')
    console.log('PLM_FULL_APP_NAMESPACE_RESULT ' + JSON.stringify({ passed: true, workerReceiptObserved: true,
      normalChildExit: true, pidInitCapabilitiesZero: true, ordinaryWorker: true }))
  } catch {
    console.error('PLM_FULL_APP_NAMESPACE_FAILED')
    process.exitCode = 1
  }
}
