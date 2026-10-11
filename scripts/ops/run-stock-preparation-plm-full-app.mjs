import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { openSync, writeSync, fsyncSync, closeSync } from 'node:fs'
import path from 'node:path'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn, execFile } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { StringDecoder } from 'node:string_decoder'
import { types } from 'node:util'
import { startOwnedPostgres } from './lib/stock-preparation-plm-owned-pg.mjs'
import { verifyBuildReceipt } from './lib/stock-preparation-plm-builds.mjs'

const filename = fileURLToPath(import.meta.url)
const repository = path.resolve(path.dirname(filename), '../..')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const pipe = (command, args, options) => new Promise((resolve, reject) => {
  execFile(command, args, { ...options, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
    (error, stdout) => error ? reject(new Error('PLM_FULL_APP_TOOL_FAILED')) : resolve(stdout))
})
const RAW_LOG_LIMIT = 32 * 1024 * 1024
async function ownedLogScope(repoRoot, scratchDir) {
  assert.equal(await fs.realpath(repoRoot), repoRoot, 'PLM_FULL_APP_LOG_ROOT_REDIRECTED')
  assert.equal(await fs.realpath(scratchDir), scratchDir, 'PLM_FULL_APP_LOG_SCRATCH_REDIRECTED')
  assert.equal(path.dirname(scratchDir), path.join(repoRoot, 'tmp'), 'PLM_FULL_APP_LOG_OWNER_REQUIRED')
  const match = /^stock-preparation-plm-full-app-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(path.basename(scratchDir))
  assert(match, 'PLM_FULL_APP_LOG_OWNER_REQUIRED')
  const ownerPath = path.join(scratchDir, 'owner.json')
  const stat = await fs.lstat(ownerPath)
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4096, 'PLM_FULL_APP_LOG_OWNER_REQUIRED')
  const owner = JSON.parse(await fs.readFile(ownerPath, 'utf8'))
  assert.equal(owner.owner, 'PLM_FULL_APP_SCRATCH', 'PLM_FULL_APP_LOG_OWNER_REQUIRED')
  assert.equal(owner.repoRoot, repoRoot, 'PLM_FULL_APP_LOG_OWNER_REQUIRED')
  assert.equal(owner.nonce, match[1], 'PLM_FULL_APP_LOG_OWNER_REQUIRED')
  assert(Number.isSafeInteger(owner.pid) && owner.pid > 0, 'PLM_FULL_APP_LOG_OWNER_REQUIRED')
}
function logDirectory(scratchDir, name, ordinal) {
  assert(typeof name === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(name), 'PLM_FULL_APP_LOG_NAME_INVALID')
  assert(Number.isSafeInteger(ordinal) && ordinal >= 0 && ordinal < 1000, 'PLM_FULL_APP_LOG_ORDINAL_INVALID')
  return path.join(scratchDir, 'diagnostics', String(ordinal).padStart(3, '0') + '-' + name)
}
/** Private raw stdout/stderr only. Never capture argv, env, stdin or echo bodies.
 * complete attests bounded capture, NOT successful process/acceptance execution. */
export async function createOwnedProcessCapture({ repoRoot, scratchDir, name, ordinal }) {
  await ownedLogScope(repoRoot, scratchDir)
  const parent = path.join(scratchDir, 'diagnostics')
  try { await fs.mkdir(parent, { mode: 0o700 }) } catch (error) { if (error?.code !== 'EEXIST') throw error }
  assert.equal(await fs.realpath(parent), parent, 'PLM_FULL_APP_LOG_DIRECTORY_REDIRECTED')
  const directory = logDirectory(scratchDir, name, ordinal)
  await fs.mkdir(directory, { mode: 0o700 })
  // Write before returning from each data callback. If this capture owner is
  // killed, already received bytes remain in private files; no stdin is stored.
  const handles = {}
  try {
    for (const stream of ['stdout', 'stderr']) handles[stream] = openSync(path.join(directory, stream + '.raw.log'), 'wx', 0o600)
  } catch (error) {
    for (const fd of Object.values(handles)) try { closeSync(fd) } catch { /* retain owned partial logs */ }
    throw error
  }
  const observed = { stdout: 0, stderr: 0 }
  const captured = { stdout: 0, stderr: 0 }
  const receivedHashes = { stdout: createHash('sha256'), stderr: createHash('sha256') }
  let capturedBytes = 0, limitExceeded = false, finalized = false, writeFailed = false
  return Object.freeze({
    get limitExceeded() { return limitExceeded },
    accept(stream, chunk) {
      assert(!finalized && ['stdout', 'stderr'].includes(stream) && Buffer.isBuffer(chunk), 'PLM_FULL_APP_LOG_CHUNK_INVALID')
      observed[stream] += chunk.length
      assert(Number.isSafeInteger(observed[stream]), 'PLM_FULL_APP_LOG_SIZE_INVALID')
      const available = Math.max(0, RAW_LOG_LIMIT - capturedBytes)
      const accepted = chunk.subarray(0, available)
      try {
        let offset = 0
        while (offset < accepted.length) {
          const written = writeSync(handles[stream], accepted, offset, accepted.length - offset)
          assert(written > 0, 'PLM_FULL_APP_LOG_WRITE_FAILED')
          offset += written
        }
      } catch { writeFailed = true; throw new Error('PLM_FULL_APP_LOG_WRITE_FAILED') }
      receivedHashes[stream].update(accepted)
      captured[stream] += accepted.length
      capturedBytes += accepted.length
      if (accepted.length !== chunk.length) limitExceeded = true
    },
    async finalize({ code, signal, timedOut = false, malformedMarker = false, spawnFailed = false, terminationReason, elapsedMs }) {
      assert(!finalized, 'PLM_FULL_APP_LOG_ALREADY_FINALIZED')
      finalized = true
      let flushFailed = false
      for (const fd of Object.values(handles)) {
        try { fsyncSync(fd) } catch { flushFailed = true }
        finally { try { closeSync(fd) } catch { flushFailed = true } }
      }
      assert.equal(flushFailed, false, 'PLM_FULL_APP_LOG_WRITE_FAILED')
      assert(code === null || Number.isSafeInteger(code), 'PLM_FULL_APP_LOG_EXIT_INVALID')
      assert(signal === null || typeof signal === 'string' && /^SIG[A-Z0-9]{1,24}$/.test(signal), 'PLM_FULL_APP_LOG_EXIT_INVALID')
      for (const value of [timedOut, malformedMarker, spawnFailed]) assert.equal(typeof value, 'boolean')
      assert(['exit', 'signal', 'timeout', 'spawn-failure', 'input-failure', 'capture-failure', 'malformed-marker', 'output-limit'].includes(terminationReason))
      assert(Number.isSafeInteger(elapsedMs) && elapsedMs >= 0 && elapsedMs <= 86400000, 'PLM_FULL_APP_LOG_TIME_INVALID')
      await ownedLogScope(repoRoot, scratchDir)
      assert.equal(await fs.realpath(directory), directory, 'PLM_FULL_APP_LOG_DIRECTORY_REDIRECTED')
      const logs = {}
      for (const stream of ['stdout', 'stderr']) {
        const file = path.join(directory, stream + '.raw.log')
        const bytes = await fs.readFile(file)
        assert.equal(bytes.length, captured[stream], 'PLM_FULL_APP_LOG_BYTES_CHANGED')
        const receivedSha256 = receivedHashes[stream].digest('hex')
        assert.equal(digest(bytes), receivedSha256, 'PLM_FULL_APP_LOG_HASH_CHANGED')
        logs[stream] = Object.freeze({ path: path.relative(repoRoot, file).replaceAll('\\', '/'), bytes: bytes.length,
          sha256: receivedSha256, observedBytes: observed[stream] })
      }
      assert.equal(writeFailed, false, 'PLM_FULL_APP_LOG_WRITE_FAILED')
      return Object.freeze({ name, ordinal, code, signal, timedOut, malformedMarker, spawnFailed, terminationReason, elapsedMs,
        complete: !limitExceeded, outputLimitExceeded: limitExceeded, logs: Object.freeze(logs) })
    },
  })
}
/** Recompute actual owner-bound log bytes; failed processes may have valid logs,
 * but their status must still be rejected by the acceptance gate. */
export async function verifyStageLogs({ repoRoot, scratchDir, stages }) {
  await ownedLogScope(repoRoot, scratchDir)
  assert(Array.isArray(stages), 'PLM_FULL_APP_LOG_STAGES_REQUIRED')
  const seen = new Set()
  for (const stage of stages) {
    const directory = logDirectory(scratchDir, stage.name, stage.ordinal)
    assert(!seen.has(directory), 'PLM_FULL_APP_LOG_STAGE_DUPLICATE')
    seen.add(directory)
    assert.equal(await fs.realpath(directory), directory, 'PLM_FULL_APP_LOG_DIRECTORY_REDIRECTED')
    assert.equal(typeof stage.complete, 'boolean')
    assert.equal(typeof stage.outputLimitExceeded, 'boolean')
    assert.equal(stage.complete, !stage.outputLimitExceeded, 'PLM_FULL_APP_LOG_COMPLETENESS_INVALID')
    for (const stream of ['stdout', 'stderr']) {
      const descriptor = stage.logs?.[stream]
      const file = path.join(directory, stream + '.raw.log')
      assert.equal(descriptor?.path, path.relative(repoRoot, file).replaceAll('\\', '/'), 'PLM_FULL_APP_LOG_PATH_INVALID')
      assert(Number.isSafeInteger(descriptor.bytes) && descriptor.bytes >= 0 && descriptor.bytes <= RAW_LOG_LIMIT)
      assert(Number.isSafeInteger(descriptor.observedBytes) && descriptor.observedBytes >= descriptor.bytes)
      if (stage.complete) assert.equal(descriptor.observedBytes, descriptor.bytes, 'PLM_FULL_APP_LOG_TRUNCATED')
      assert(/^[0-9a-f]{64}$/.test(descriptor.sha256), 'PLM_FULL_APP_LOG_HASH_INVALID')
      const stat = await fs.lstat(file)
      assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'PLM_FULL_APP_LOG_FILE_REQUIRED')
      assert.equal(await fs.realpath(file), file, 'PLM_FULL_APP_LOG_PATH_REDIRECTED')
      const bytes = await fs.readFile(file)
      assert.equal(bytes.length, descriptor.bytes, 'PLM_FULL_APP_LOG_BYTES_CHANGED')
      assert.equal(digest(bytes), descriptor.sha256, 'PLM_FULL_APP_LOG_HASH_CHANGED')
    }
  }
  return { processes: stages.length, streams: stages.length * 2, originalBytesVerified: true }
}
/** A killed capture owner cannot emit its child-close frame. Retain only the
 * bytes actually present, explicitly WITHOUT a complete/lifecycle attestation. */
export async function recoverUnobservedProcessLogs({ repoRoot, scratchDir, name, ordinal }) {
  await ownedLogScope(repoRoot, scratchDir)
  const directory = logDirectory(scratchDir, name, ordinal)
  try { await fs.lstat(directory) } catch (error) { if (error?.code === 'ENOENT') return undefined; throw error }
  assert.equal(await fs.realpath(directory), directory, 'PLM_FULL_APP_LOG_DIRECTORY_REDIRECTED')
  const streams = []
  let total = 0
  for (const stream of ['stdout', 'stderr']) {
    const file = path.join(directory, stream + '.raw.log')
    let stat
    try { stat = await fs.lstat(file) } catch (error) { if (error?.code === 'ENOENT') continue; throw error }
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1)
    assert.equal(await fs.realpath(file), file)
    const bytes = await fs.readFile(file)
    total += bytes.length
    assert(total <= RAW_LOG_LIMIT, 'PLM_FULL_APP_LOG_SIZE_INVALID')
    streams.push({ stream, path: path.relative(repoRoot, file).replaceAll('\\', '/'), bytes: bytes.length, sha256: digest(bytes) })
  }
  return { name, ordinal, lifecycleObserved: false, captureComplete: false, streams }
}
// Child frames are private input, not safe public log lines. Publish a closed
// classification only: even an uppercase-looking error may contain a secret.
export function publicBrowserFailure(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null
  if (record.stage === 'browser-request-failure') {
    // Re-project even already classified child frames. Never forward request
    // URLs, private identities, headers, payloads or arbitrary error strings.
    const apiKeys = ['login', 'me', 'dingTalkProbe', 'plugins', 'todoCount', 'approvalCapability', 'methodProbe',
      'adapters', 'externalSystems', 'stagingDescriptors', 'tableActions', 'hubOverview',
      'readSourceConfigs', 'readSourceCompositions', 'manifest', 'preflight', 'sourceBinding',
      'roleCatalog', 'dataSources', 'plans', 'projects', 'operatorProjects', 'handoff', 'preview',
      'automationOptions', 'automationGrants', 'automationRequests', 'automationScheduleActivation',
      'editorContext', 'editorFields', 'editorView', 'editorBases', 'editorAiAvailability', 'editorMentionSummary',
      'editorUnreadCount', 'editorSubscriptionCount', 'editorDingtalkGroups', 'editorApprovalTemplates',
      'editorSheets', 'editorRules', 'conflictPolicies', 'validate', 'confirmSample', 'approve', 'activate',
      'k3Approve', 'k3Read', 'yidaBoard', 'automationGrantDetail', 'automationRequestDetail', 'automationRevoke']
    const failures = ['ABORTED', 'FAILED', 'BLOCKED_BY_CLIENT', 'CONNECTION_RESET', 'CONNECTION_CLOSED',
      'CONNECTION_REFUSED', 'EMPTY_RESPONSE', 'TIMED_OUT', 'NETWORK_CHANGED', 'NAME_NOT_RESOLVED', 'INTERNET_DISCONNECTED']
    return { stage: 'browser-request-failure',
      method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(record.method) ? record.method : 'OTHER',
      apiKey: apiKeys.includes(record.apiKey) ? record.apiKey : 'unknown',
      surface: ['API', 'SOCKET', 'DOCUMENT', 'ASSET'].includes(record.surface) ? record.surface : 'OTHER',
      failure: failures.includes(record.failure) ? record.failure : 'OTHER' }
  }
  if (record.stage === 'browser-api-denied') {
    const categories = ['OTHER_STOCK_PREPARATION', 'OTHER_MULTITABLE', 'OTHER_API',
      'EDITOR_RULE_STATS', 'EDITOR_RULE_LOGS']
    return { stage: 'browser-api-denied',
      routeCategory: categories.includes(record.routeCategory) ? record.routeCategory : 'OTHER',
      method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(record.method) ? record.method : 'OTHER' }
  }
  if (record.stage !== 'isolated-browser-failed') return null
  const phases = ['CONFIG', 'CONFIG_CREATE', 'LISTEN', 'BROWSER', 'LOGIN', 'WORKBENCH', 'K3_WORKBENCH',
    'TOPBAR', 'INSTALL', 'BIND', 'EXPLICIT_TENANT_SCOPE', 'EXACT_TENANT_REBIND', 'SAVE', 'VALIDATE',
    'CONFIRM_SAMPLE', 'APPROVE', 'ACTIVATE', 'PREVIEW_NAVIGATION', 'PREVIEW', 'RELOAD',
    'YIDA_BOARD_NAVIGATION', 'YIDA_STATIC_PREVIEW', 'YIDA_OWNER_DEFAULT_OFF',
    'AUTOMATION_INTERVAL_EDITOR', 'AUTOMATION_INTERVAL', 'AUTOMATION_MANUAL']
  const diagnostic = typeof record.diagnostic === 'string' ? record.diagnostic : ''
  const phase = phases.sort((a, b) => b.length - a.length)
    .find(value => diagnostic.startsWith('APP_BROWSER_' + value + '_'))
  const reason = phase ? diagnostic.slice(('APP_BROWSER_' + phase + '_').length) : ''
  const reasons = ['TIMEOUT', 'TYPE_ERROR', 'FAILED', 'REQUEST_FAILED',
    'DEPLOYMENT_POSTURE_REQUIRED', 'UNEXPECTED_API_GET_INTEGRATION_STOCK_PREPARATION_MEMBERS',
    'UNEXPECTED_API_GET_TASKS_COUNTS', 'UNEXPECTED_API_GET_INTEGRATION_STOCK_PREPARATION_DEPLOYMENT_PREFLIGHT']
  return { stage: 'isolated-browser-failed', phase: phase ?? 'OTHER',
    reason: reasons.includes(reason) ? reason : 'OTHER' }
}

export function createFullAppStageRunner({ repoRoot, scratchDir, emit = console.log, namespaceScope }) {
  const namespaceAuthority = createRequire(import.meta.url)('./lib/stock-preparation-plm-namespace-scope.cjs')
  let ordinal = 1
  return async (name, argv, childEnv, cwd = repoRoot, timeout = 600000) => {
    const namespaceArgs = namespaceScope ? namespaceAuthority.namespaceChildArguments(namespaceScope) : []
    const verifierArgs = namespaceScope && name === 'configured-app'
      ? [namespaceAuthority.namespaceArgument(namespaceScope)] : []
    const capture = await createOwnedProcessCapture({ repoRoot, scratchDir, name, ordinal: ordinal++ })
    const started = performance.now()
    emit('PLM_FULL_APP_STAGE_START ' + JSON.stringify({ name }))
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [...namespaceArgs, ...argv, ...verifierArgs], { cwd, env: childEnv, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
      let output = '', timedOut = false, terminated = false, malformedMarker = false, spawnFailed = false
      const streamBuffers = { stdout: '', stderr: '' }
      const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
      const markers = []
      let forcedReason
      const terminate = reason => {
        if (terminated || child.exitCode !== null || !child.pid) return
        terminated = true
        forcedReason = reason
        if (process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, timeout: 10000 }, () => {})
        else { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
      }
      const acceptLine = line => {
        if (/^(?:PLM_FULL_APP_PROBE|PLM_FULL_APP_ISOLATION|PLM_FULL_APP_BUILD|PLM_FULL_APP_BUILD_FAILED|PLM_FULL_APP_WEB_TYPECHECK) /.test(line)) markers.push(line)
        if (line.startsWith('PLM_FULL_APP_PROBE ')) {
          try {
            const record = JSON.parse(line.slice('PLM_FULL_APP_PROBE '.length))
            if (record.stage === 'browser-phase') emit(line)
            else {
              const failure = publicBrowserFailure(record)
              if (failure) emit('PLM_FULL_APP_PROBE ' + JSON.stringify(failure))
            }
          }
          catch { malformedMarker = true; terminate('malformed-marker') }
        }
      }
      const decode = (stream, text) => {
        output += text
        streamBuffers[stream] += text
        const lines = streamBuffers[stream].split(/\r?\n/)
        streamBuffers[stream] = lines.pop() ?? ''
        for (const line of lines) acceptLine(line)
      }
      const accept = stream => chunk => {
        try { capture.accept(stream, chunk) } catch { terminate('capture-failure'); return }
        if (capture.limitExceeded) { terminate('output-limit'); return }
        decode(stream, decoders[stream].write(chunk))
      }
      child.stdout.on('data', accept('stdout')); child.stderr.on('data', accept('stderr'))
      const timer = setTimeout(() => { timedOut = true; terminate('timeout') }, timeout)
      child.once('error', () => { spawnFailed = true })
      child.once('close', (code, signal) => {
        clearTimeout(timer)
        void (async () => {
          for (const stream of ['stdout', 'stderr']) {
            decode(stream, decoders[stream].end())
            if (streamBuffers[stream]) acceptLine(streamBuffers[stream])
          }
          const stage = { ...await capture.finalize({ code, signal, timedOut, malformedMarker, spawnFailed,
            terminationReason: forcedReason ?? (spawnFailed ? 'spawn-failure' : signal ? 'signal' : 'exit'),
            elapsedMs: Math.ceil(performance.now() - started) }), outputSha256: digest(output), markers }
          emit('PLM_FULL_APP_STAGE_END ' + JSON.stringify({ name, code, signal, timedOut }))
          resolve({ ...stage, output })
        })().catch(reject)
      })
    })
  }
}
export function parseArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true }
  assert(args.length >= 1 && args.length <= 2 && args.every(arg => typeof arg === 'string')
    && args.filter(arg => arg.startsWith('--pg-bin=')).length === 1
    && args.every(arg => arg.startsWith('--pg-bin=') || arg.startsWith('--automation-scenario=')),
    'PLM_FULL_APP_EXPLICIT_PG_BIN_REQUIRED')
  const pgBin = args.find(arg => arg.startsWith('--pg-bin=')).slice('--pg-bin='.length)
  assert(pgBin.length > 0, 'PLM_FULL_APP_EXPLICIT_PG_BIN_REQUIRED')
  assert(path.isAbsolute(pgBin), 'PLM_FULL_APP_ABSOLUTE_PG_BIN_REQUIRED')
  const automationScenario = args.find(arg => arg.startsWith('--automation-scenario='))?.slice('--automation-scenario='.length) ?? 'manual'
  assert(['manual', 'interval'].includes(automationScenario), 'PLM_FULL_APP_AUTOMATION_SCENARIO_INVALID')
  return { pgBin, automationScenario }
}
export function cleanEnvironment(source) {
  const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'COMSPEC', 'PATHEXT', 'HOME'])
  return Object.fromEntries(Object.entries(source).filter(([key, value]) =>
    allowed.has(key.toUpperCase()) && typeof value === 'string'))
}
export function validateProductionStopEvidence(records) {
  assert(Array.isArray(records), 'PLM_FULL_APP_STOP_RECORDS_REQUIRED')
  const forbiddenStages = new Set(['actual-stop-failed', 'production-stop-failed', 'harness-emergency-cleanup'])
  const resolved = [], verified = []
  for (const [index, record] of records.entries()) {
    assert(record && typeof record === 'object' && !Array.isArray(record)
      && typeof record.stage === 'string', 'PLM_FULL_APP_STOP_RECORD_INVALID')
    assert(!forbiddenStages.has(record.stage), 'PLM_FULL_APP_STOP_FAILURE_REPORTED')
    if (record.stage === 'actual-stop-resolved') resolved.push(index)
    if (record.stage === 'production-stop-verified') verified.push(index)
  }
  assert.equal(resolved.length, 1, 'PLM_FULL_APP_ACTUAL_STOP_RESOLVED_REQUIRED')
  assert.equal(verified.length, 1, 'PLM_FULL_APP_PRODUCTION_STOP_VERIFIED_REQUIRED')
  assert(resolved[0] < verified[0], 'PLM_FULL_APP_STOP_STAGE_ORDER_INVALID')
  const evidence = records[verified[0]]
  for (const [field, expected] of Object.entries({
    emergencyCleanupUsed: false,
    mainPoolEnded: true,
    sourcePoolEnded: true,
    sourceRegistrationsRetained: true,
    httpListenerClosed: true,
    collaborationClosed: true,
    collaborationDisconnects: 2,
    referencedTimers: 0,
    maintenanceTimers: 0,
  })) assert.equal(evidence[field], expected, 'PLM_FULL_APP_PRODUCTION_STOP_STATE_INVALID')
}
export function validateK3Evidence(records) {
  assert(Array.isArray(records), 'PLM_FULL_APP_KTHREE_RECORDS_REQUIRED')
  assert(records.every(record => record && typeof record === 'object' && !Array.isArray(record)
    && typeof record.stage === 'string'), 'PLM_FULL_APP_KTHREE_RECORD_INVALID')
  assert(!records.some(record => record.stage === 'k3-synthetic-server-close-failed'), 'PLM_FULL_APP_KTHREE_CLOSE_FAILED')
  const stages = ['k3-synthetic-server-ready', 'k3-browser-and-authority-verified', 'k3-synthetic-server-closed']
  const indices = stages.map(stage => {
    const found = records.flatMap((record, index) => record.stage === stage ? [index] : [])
    assert.equal(found.length, 1, 'PLM_FULL_APP_KTHREE_STAGE_REQUIRED')
    return found[0]
  })
  assert(indices[0] < indices[1] && indices[1] < indices[2], 'PLM_FULL_APP_KTHREE_STAGE_ORDER_INVALID')
  assert.equal(records[indices[0]].listening, true, 'PLM_FULL_APP_KTHREE_LIVE_LISTENER_REQUIRED')
  assert.equal(records[indices[2]].closed, true, 'PLM_FULL_APP_KTHREE_CLOSED_LISTENER_REQUIRED')
  const { browser, authority } = records[indices[1]]
  for (const group of [browser, authority]) assert(group && typeof group === 'object' && !Array.isArray(group),
    'PLM_FULL_APP_KTHREE_EVIDENCE_REQUIRED')
  for (const key of ['b4SavedAndApproved', 'b4PreviewOnly', 'bl2SavedAndApproved', 'uniqueBomRead',
    'ambiguousBomRejected', 'reloadVersionsPersisted', 'reloadDidNotReadK3', 'realBundleJourney']) {
    assert.equal(browser[key], true, 'PLM_FULL_APP_KTHREE_BROWSER_EVIDENCE_INVALID')
  }
  for (const key of ['responseStubs', 'storageInjections']) assert.equal(browser[key], 0, 'PLM_FULL_APP_KTHREE_BROWSER_EVIDENCE_INVALID')
  for (const key of ['realK3Login', 'encryptedCredentials', 'approvedVersionsPersisted', 'sameTenantReaderRead',
    'readerWritesDenied', 'noPermissionDenied', 'crossTenantDenied', 'unapprovedReadDenied',
    'bomAmbiguityFailClosed', 'deniedRequestsNoK3Io']) {
    assert.equal(authority[key], true, 'PLM_FULL_APP_KTHREE_AUTHORITY_EVIDENCE_INVALID')
  }
  for (const key of ['externalWriteRequests', 'unexpectedK3Requests']) assert.equal(authority[key], 0, 'PLM_FULL_APP_KTHREE_EXTERNAL_WRITE_OR_ROUTE')
  for (const key of ['loginRequests', 'b4ReadRequests', 'bl2ReadRequests']) assert(Number.isSafeInteger(authority[key])
    && authority[key] > 0, 'PLM_FULL_APP_KTHREE_REAL_READS_REQUIRED')
}
export function validateYidaEvidence(records) {
  assert(Array.isArray(records), 'PLM_FULL_APP_YIDA_RECORDS_REQUIRED')
  assert(records.every(record => record && typeof record === 'object' && !Array.isArray(record)
    && typeof record.stage === 'string'), 'PLM_FULL_APP_YIDA_RECORD_INVALID')
  const stages = ['yida-synthetic-board-ready', 'yida-static-browser-verified',
    'actual-stop-resolved', 'production-stop-verified']
  const indices = stages.map(stage => {
    const found = records.flatMap((record, index) => record.stage === stage ? [index] : [])
    assert.equal(found.length, 1, 'PLM_FULL_APP_YIDA_STAGE_REQUIRED')
    return found[0]
  })
  assert(indices.every((index, position) => position === 0 || indices[position - 1] < index),
    'PLM_FULL_APP_YIDA_STAGE_ORDER_INVALID')
  const seed = records[indices[0]]
  assert.equal(seed.seededTargetRows, 1, 'PLM_FULL_APP_YIDA_SEED_INVALID')
  assert.equal(seed.seededActiveRows, 0, 'PLM_FULL_APP_YIDA_SEED_INVALID')
  assert.equal(seed.separateFromPlmProject, true, 'PLM_FULL_APP_YIDA_SEED_INVALID')
  const { evidence, counts, businessSnapshotUnchanged } = records[indices[1]]
  for (const group of [evidence, counts]) assert(group && typeof group === 'object' && !Array.isArray(group),
    'PLM_FULL_APP_YIDA_EVIDENCE_REQUIRED')
  assert.equal(businessSnapshotUnchanged, true, 'PLM_FULL_APP_YIDA_BUSINESS_SNAPSHOT_INVALID')
  for (const key of ['realProjectBoardNavigation', 'v1CreatePreview', 'v2CreatePreview',
    'explicitInstanceUpdatePreview', 'renamedLayoutPreview', 'exactProjectAllocation', 'duplicateRowsRejected',
    'invalidNumberRejected', 'ruleExportImportClearsInputs', 'editsClearResults', 'closeReopenClearsInputs',
    'preparationEntryOpensOnlyLocalPreview', 'noBusinessRequests', 'storageSnapshotUnchanged']) {
    assert.equal(evidence[key], true, 'PLM_FULL_APP_YIDA_BROWSER_EVIDENCE_INVALID')
  }
  for (const key of ['responseStubs', 'storageInjections']) assert.equal(evidence[key], 0,
    'PLM_FULL_APP_YIDA_BROWSER_EVIDENCE_INVALID')
  for (const key of ['previewRuns', 'acceptedPreviews', 'rejectedPreviews',
    'localApiRequests', 'externalRequests', 'backgroundOverviewRequests']) {
    assert(Number.isSafeInteger(counts[key]) && counts[key] >= 0, 'PLM_FULL_APP_YIDA_COUNT_INVALID')
  }
  assert.equal(counts.previewRuns, counts.acceptedPreviews + counts.rejectedPreviews,
    'PLM_FULL_APP_YIDA_CASE_SUM_INVALID')
  for (const [key, expected] of Object.entries({ previewRuns: 11, acceptedPreviews: 8,
    rejectedPreviews: 3, localApiRequests: 0, externalRequests: 0 })) {
    assert.equal(counts[key], expected, 'PLM_FULL_APP_YIDA_CASE_OR_IO_INVALID')
  }
}
/** Additional OFF evidence has its own closed structure and counters. The
 * existing eleven-case local-preview validator above is unchanged. */
export function validateYidaOwnerOffEvidence(records) {
  assert(Array.isArray(records) && records.every(record => record && typeof record === 'object'
    && !Array.isArray(record) && typeof record.stage === 'string'), 'PLM_FULL_APP_YIDA_OWNER_OFF_RECORD_INVALID')
  const names = ['yida-owner-default-off-ready', 'browser-starting', 'yida-static-browser-verified',
    'yida-owner-default-off-verified', 'yida-owner-log-http-verified', 'actual-stop-resolved', 'production-stop-verified']
  const positions = names.map(name => {
    const found = records.flatMap((record, index) => record.stage === name ? [index] : [])
    assert.equal(found.length, 1, 'PLM_FULL_APP_YIDA_OWNER_OFF_STAGE_REQUIRED')
    return found[0]
  })
  assert(positions.every((position, index) => index === 0 || positions[index - 1] < position),
    'PLM_FULL_APP_YIDA_OWNER_OFF_STAGE_ORDER_INVALID')
  const keys = (value, required) => {
    assert(value && typeof value === 'object' && !Array.isArray(value), 'PLM_FULL_APP_YIDA_OWNER_OFF_OBJECT_REQUIRED')
    assert.deepEqual(Object.keys(value).sort(), [...required].sort(), 'PLM_FULL_APP_YIDA_OWNER_OFF_KEYS_INVALID')
  }
  const ready = records[positions[0]], browser = records[positions[3]], http = records[positions[4]]
  keys(ready, ['stage', 'defaultOff', 'durableTables', 'durableRowsBefore'])
  assert.deepEqual(ready, { stage: names[0], defaultOff: true, durableTables: 14, durableRowsBefore: 0 },
    'PLM_FULL_APP_YIDA_OWNER_OFF_READY_INVALID')
  keys(browser, ['stage', 'evidence', 'counts', 'durableTables', 'durableRowsAfter', 'durableSnapshotUnchanged', 'queryObservation'])
  assert.deepEqual(browser.evidence, { parentPrimaryPreview: true, openingNoBusinessRequests: true,
    realSdkDraftPost: true, exactDisabled403: true, noTargetOperationOrGrant: true,
    errorRetained: true, retryDisabled: true, approvalAndSubmissionAbsent: true }, 'PLM_FULL_APP_YIDA_OWNER_OFF_BROWSER_INVALID')
  keys(browser.counts, ['previewRuns', 'ownerPosts', 'ownerResponses', 'backgroundOverviewRequests',
    'openingBusinessRequests', 'otherBusinessRequests', 'externalRequests', 'expectedConsoleErrors'])
  for (const [key, expected] of Object.entries({ previewRuns: 1, ownerPosts: 1, ownerResponses: 1,
    openingBusinessRequests: 0, otherBusinessRequests: 0, externalRequests: 0 })) {
    assert.equal(browser.counts[key], expected, 'PLM_FULL_APP_YIDA_OWNER_OFF_COUNT_INVALID')
  }
  assert(Number.isSafeInteger(browser.counts.backgroundOverviewRequests) && browser.counts.backgroundOverviewRequests >= 0
    && [0, 1].includes(browser.counts.expectedConsoleErrors), 'PLM_FULL_APP_YIDA_OWNER_OFF_COUNT_INVALID')
  assert.equal(browser.durableTables, 14, 'PLM_FULL_APP_YIDA_OWNER_OFF_DURABLE_INVALID')
  assert.equal(browser.durableRowsAfter, 0, 'PLM_FULL_APP_YIDA_OWNER_OFF_DURABLE_INVALID')
  assert.equal(browser.durableSnapshotUnchanged, true, 'PLM_FULL_APP_YIDA_OWNER_OFF_DURABLE_INVALID')
  assert.deepEqual(browser.queryObservation, { ownerTableQueryAttempts: 0, ownerTableWriteAttempts: 0, nativeQueryPositiveControl: true },
    'PLM_FULL_APP_YIDA_OWNER_OFF_QUERY_INVALID')
  keys(http, ['stage', 'counts', 'durableSnapshotUnchanged', 'queryObservation', 'proofBytes', 'proofSha256'])
  assert.deepEqual(http.counts, { ownerRequests: 3, ownerResponses: 3, ordinaryRequests: 1,
    ordinaryResponses: 1, distinctSentinels: 13, distinctOwnerServerIds: 4 }, 'PLM_FULL_APP_YIDA_OWNER_OFF_HTTP_INVALID')
  assert.equal(http.durableSnapshotUnchanged, true, 'PLM_FULL_APP_YIDA_OWNER_OFF_DURABLE_INVALID')
  assert.deepEqual(http.queryObservation, { ownerTableQueryAttempts: 0, ownerTableWriteAttempts: 0,
    nativeQueryPositiveControl: true, prototypeRestored: true, observerInactive: true },
    'PLM_FULL_APP_YIDA_OWNER_OFF_QUERY_INVALID')
  assert(Number.isSafeInteger(http.proofBytes) && http.proofBytes > 0 && http.proofBytes <= 8192
    && typeof http.proofSha256 === 'string' && /^[a-f0-9]{64}$/u.test(http.proofSha256),
  'PLM_FULL_APP_YIDA_OWNER_OFF_PROOF_DESCRIPTOR_INVALID')
}

/** Read both complete raw streams from the exited configured host. Validation
 * never redacts, re-encodes or substitutes captured bytes before searching. */
/** Independent full-app initialization receipt, after the original OFF proof and
 * before normal production stop. Closed fields contain no opaque identity/material. */
export const initializationFailurePhases = Object.freeze(['SETUP', 'LOGIN', 'BOARD', 'PANEL', 'READY_GET', 'POST',
  'MANUAL_GET', 'RELOAD', 'RELOAD_GET', 'FINISH', 'CLOSE', 'OTHER'])
export function validateYidaInitializationFailureMarker(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value) && !types.isProxy(value),
    'PLM_FULL_APP_YIDA_INIT_FAILURE_OBJECT_INVALID')
  const fields = Object.getOwnPropertyDescriptors(value)
  assert.deepEqual(Reflect.ownKeys(fields).sort(), ['diagnostic', 'phase', 'stage'], 'PLM_FULL_APP_YIDA_INIT_FAILURE_KEYS_INVALID')
  assert(Object.values(fields).every(field => field.enumerable && Object.hasOwn(field, 'value')),
    'PLM_FULL_APP_YIDA_INIT_FAILURE_DESCRIPTOR_INVALID')
  assert(fields.stage.value === 'yida-initialization-browser-failed' && fields.diagnostic.value === 'APP_BROWSER_YIDA_INIT_FAILED'
    && initializationFailurePhases.includes(fields.phase.value), 'PLM_FULL_APP_YIDA_INIT_FAILURE_VALUE_INVALID')
  return { diagnostic: 'APP_BROWSER_YIDA_INIT_FAILED', phase: fields.phase.value }
}

export function validateYidaInitializationEvidence(records) {
  assert(Array.isArray(records) && records.every(record => record && typeof record === 'object'
    && !Array.isArray(record) && typeof record.stage === 'string'), 'PLM_FULL_APP_YIDA_INIT_RECORD_INVALID')
  const names = ['yida-owner-log-http-verified', 'yida-initialization-ready', 'yida-initialization-browser-network',
    'yida-initialization-browser-and-authority-verified', 'actual-stop-resolved', 'production-stop-verified']
  const positions = names.map(name => {
    const found = records.flatMap((record, index) => record.stage === name ? [index] : [])
    assert.equal(found.length, 1, 'PLM_FULL_APP_YIDA_INIT_STAGE_REQUIRED'); return found[0]
  })
  assert(positions.every((position, index) => index === 0 || positions[index - 1] < position)
    && !records.some(record => record.stage === 'yida-initialization-browser-failed'), 'PLM_FULL_APP_YIDA_INIT_ORDER_INVALID')
  assert.deepEqual(records[positions[1]], { stage: 'yida-initialization-ready', managedBootstrap: true,
    bootstrapCommitted: true, defaultOff: true, separateFromOriginalOffWindow: true, anchorRows: 1, initializationRows: 0 },
  'PLM_FULL_APP_YIDA_INIT_READY_INVALID')
  const network = records[positions[2]]
  assert.deepEqual(Object.keys(network).sort(), ['allowedConnections', 'forbiddenConnections', 'forbiddenEnvReads', 'stage'])
  assert(network.forbiddenConnections === 0 && network.forbiddenEnvReads === 0
    && Number.isSafeInteger(network.allowedConnections) && network.allowedConnections > 0, 'PLM_FULL_APP_YIDA_INIT_NETWORK_INVALID')
  const result = records[positions[3]]
  assert.deepEqual(Object.keys(result).sort(), ['authority', 'counts', 'evidence', 'stage'])
  assert.deepEqual(result.evidence, { realPasswordLogin: true, freshBrowserContext: true, productionBundle: true,
    servedBundleBytesVerified: true, realProjectBoardNavigation: true, actualInitializationPanel: true,
    openingNoInitializationRequests: true, explicitEmptySlotGet: true, realSdkPost201: true, manualGetSameDraft: true,
    reloadSamePrincipalAndDraft: true, privateControlsCleared: true, defaultOff: true, tokenIssued: false, externalWriteAttempted: false },
  'PLM_FULL_APP_YIDA_INIT_BROWSER_INVALID')
  assert.deepEqual(result.authority, { managedAnchorCommitted: true, actualDurableChainMatched: true,
    singleInitialization: true, credentialMaterials: 1, draftOperations: 1, draftRows: 2, approvedTargets: 1,
    sendRows: 0, originalBusinessSnapshotUnchanged: true }, 'PLM_FULL_APP_YIDA_INIT_AUTHORITY_INVALID')
  assert.deepEqual(Object.keys(result.counts).sort(), ['boardResponses', 'bundleDocuments', 'externalRequests',
    'forbiddenRequests', 'initializationGets', 'initializationPosts', 'initializationResponses', 'loginResponses',
    'loginSubmissions', 'reloads', 'responseStubs', 'storageInjections'])
  for (const [key, expected] of Object.entries({ loginSubmissions: 1, loginResponses: 1, initializationGets: 3,
    initializationPosts: 1, initializationResponses: 4, reloads: 1, bundleDocuments: 2,
    externalRequests: 0, forbiddenRequests: 0, responseStubs: 0, storageInjections: 0 })) {
    assert.equal(result.counts[key], expected, 'PLM_FULL_APP_YIDA_INIT_COUNT_INVALID')
  }
  assert(Number.isSafeInteger(result.counts.boardResponses) && result.counts.boardResponses >= 2,
    'PLM_FULL_APP_YIDA_INIT_COUNT_INVALID')
}

export function validateBrowserProcessEvidence(records) {
  const nested = records.filter(record => record.stage === 'owned-process-diagnostics')
  assert.equal(nested.length, 2, 'PLM_FULL_APP_BROWSER_LOG_REQUIRED')
  for (const [ordinal, record] of nested.entries()) {
    assert(record.kind === 'isolated-browser' && record.diagnostics?.name === 'isolated-browser'
      && record.diagnostics.ordinal === ordinal && record.diagnostics.code === 0 && record.diagnostics.signal === null
      && record.diagnostics.timedOut === false && record.diagnostics.complete === true
      && record.diagnostics.outputLimitExceeded === false && record.diagnostics.malformedMarker === false
      && record.diagnostics.spawnFailed === false && record.diagnostics.terminationReason === 'exit',
    'PLM_FULL_APP_BROWSER_LOG_INVALID')
  }
  return nested.map(record => record.diagnostics)
}

export async function verifyYidaOwnerOffRawLogs({ repoRoot, scratchDir, stage, records }) {
  validateYidaOwnerOffEvidence(records)
  assert(stage.name === 'configured-app' && stage.code === 0 && stage.signal === null
    && stage.timedOut === false && stage.complete === true && stage.outputLimitExceeded === false,
  'PLM_FULL_APP_YIDA_OWNER_OFF_HOST_EXIT_REQUIRED')
  await verifyStageLogs({ repoRoot, scratchDir, stages: [stage] })
  const proofPath = path.join(scratchDir, 'yida-owner-log-proof.json')
  const stat = await fs.lstat(proofPath)
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0 && stat.size <= 8192,
    'PLM_FULL_APP_YIDA_OWNER_OFF_PROOF_FILE_INVALID')
  assert.equal(await fs.realpath(proofPath), proofPath, 'PLM_FULL_APP_YIDA_OWNER_OFF_PROOF_REDIRECTED')
  const proofBytes = await fs.readFile(proofPath)
  const descriptor = records.find(record => record.stage === 'yida-owner-log-http-verified')
  assert.equal(proofBytes.length, descriptor.proofBytes, 'PLM_FULL_APP_YIDA_OWNER_OFF_PROOF_BYTES_CHANGED')
  assert.equal(digest(proofBytes), descriptor.proofSha256, 'PLM_FULL_APP_YIDA_OWNER_OFF_PROOF_HASH_CHANGED')
  const proof = JSON.parse(proofBytes.toString('utf8'))
  assert.deepEqual(Object.keys(proof).sort(), ['positiveId', 'schemaVersion', 'sentinels', 'serverIds'],
    'PLM_FULL_APP_YIDA_OWNER_OFF_PROOF_KEYS_INVALID')
  assert.equal(proof.schemaVersion, 1, 'PLM_FULL_APP_YIDA_OWNER_OFF_PROOF_VERSION_INVALID')
  assert(Array.isArray(proof.serverIds) && proof.serverIds.length === 4 && new Set(proof.serverIds).size === 4
    && proof.serverIds.every(id => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(id)),
  'PLM_FULL_APP_YIDA_OWNER_OFF_SERVER_IDS_INVALID')
  assert(Array.isArray(proof.sentinels) && proof.sentinels.length === 13 && new Set(proof.sentinels).size === 13
    && proof.sentinels.every(value => typeof value === 'string' && /^SYN_PRIVATE_[a-f0-9]{40}$/u.test(value)),
  'PLM_FULL_APP_YIDA_OWNER_OFF_SENTINELS_INVALID')
  assert(typeof proof.positiveId === 'string' && /^SYN_PUBLIC_[a-f0-9]{40}$/u.test(proof.positiveId),
    'PLM_FULL_APP_YIDA_OWNER_OFF_POSITIVE_ID_INVALID')
  const raw = await Promise.all(['stdout', 'stderr'].map(stream => fs.readFile(path.join(repoRoot, stage.logs[stream].path))))
  assert(raw.reduce((sum, bytes) => sum + bytes.length, 0) > 0, 'PLM_FULL_APP_YIDA_OWNER_OFF_RAW_EMPTY')
  for (const sentinel of proof.sentinels) {
    assert(raw.every(bytes => !bytes.includes(Buffer.from(sentinel))), 'PLM_FULL_APP_YIDA_OWNER_OFF_RAW_LEAK')
  }
  const lines = raw.flatMap(bytes => bytes.toString('utf8').split(/\r?\n/u))
  for (const id of proof.serverIds) {
    const matching = lines.filter(line => line.includes('YIDA_OWNER_HTTP_INFO ') && line.includes(id))
    assert(matching.length > 0, 'PLM_FULL_APP_YIDA_OWNER_OFF_FIXED_LOG_MISSING')
    let naturalRequestLogger = false
    for (const line of matching) {
      const metadata = JSON.parse(line.slice(line.indexOf('{')))
      assert.deepEqual(Object.keys(metadata).sort(), ['context', 'correlation_id', 'requestId', 'service', 'timestamp'],
        'PLM_FULL_APP_YIDA_OWNER_OFF_FIXED_LOG_KEYS_INVALID')
      assert.equal(metadata.correlation_id, id, 'PLM_FULL_APP_YIDA_OWNER_OFF_LOG_CORRELATION_INVALID')
      assert.equal(metadata.requestId, id, 'PLM_FULL_APP_YIDA_OWNER_OFF_LOG_REQUEST_ID_INVALID')
      if (metadata.context === 'MetaSheetServer' && metadata.service === 'metasheet') naturalRequestLogger = true
    }
    assert(naturalRequestLogger, 'PLM_FULL_APP_YIDA_OWNER_OFF_NATURAL_LOG_MISSING')
  }
  assert(lines.some(line => {
    if (!line.includes('DELETE /api/method-probe ') || !line.includes(proof.positiveId)) return false
    const metadata = JSON.parse(line.slice(line.indexOf('{')))
    return metadata.context === 'MetaSheetServer' && metadata.service === 'metasheet'
      && metadata.correlation_id === proof.positiveId && metadata.requestId === proof.positiveId
  }), 'PLM_FULL_APP_YIDA_OWNER_OFF_ORDINARY_LOG_MISSING')
  return { status: 'passed', rawStreams: 2, ownerRequestsWithFixedServerLogs: 4,
    absentSentinels: 13, ordinaryLoggerPositiveControl: true,
    stdoutBytes: raw[0].length, stdoutSha256: digest(raw[0]), stderrBytes: raw[1].length, stderrSha256: digest(raw[1]) }
}
export function validateAutomationEvidence(records, scenario = 'manual') {
  assert(['manual', 'interval'].includes(scenario), 'PLM_FULL_APP_AUTOMATION_SCENARIO_INVALID')
  assert(Array.isArray(records) && records.every(record => record && typeof record === 'object'
    && !Array.isArray(record) && typeof record.stage === 'string'), 'PLM_FULL_APP_AUTOMATION_RECORDS_REQUIRED')
  const opposite = scenario === 'manual' ? 'interval' : 'manual'
  assert(!records.some(record => record.stage.startsWith(`automation-${opposite}-`)),
    'PLM_FULL_APP_AUTOMATION_SCENARIO_MISMATCH')
  if (scenario === 'interval') return validateIntervalAutomationEvidence(records)
  return validateManualAutomationEvidence(records)
}
function validateManualAutomationEvidence(records) {
  assert(Array.isArray(records) && records.every(record => record && typeof record === 'object'
    && !Array.isArray(record) && typeof record.stage === 'string'), 'PLM_FULL_APP_AUTOMATION_RECORDS_REQUIRED')
  assert(!records.some(record => ['automation-manual-checkpoint-failed', 'automation-manual-observer-close-failed'].includes(record.stage)),
    'PLM_FULL_APP_AUTOMATION_FAILURE_REPORTED')
  const order = ['automation-manual-fixture-ready', 'automation-manual-browser-and-authority-verified',
    'actual-stop-resolved', 'production-stop-verified']
  const indices = order.map(stage => {
    const found = records.flatMap((record, index) => record.stage === stage ? [index] : [])
    assert.equal(found.length, 1, 'PLM_FULL_APP_AUTOMATION_STAGE_REQUIRED')
    return found[0]
  })
  assert(indices.every((index, position) => position === 0 || indices[position - 1] < index),
    'PLM_FULL_APP_AUTOMATION_STAGE_ORDER_INVALID')
  const checkpoints = records.flatMap((record, index) => record.stage === 'automation-manual-checkpoint' ? [{ record, index }] : [])
  assert.deepEqual(checkpoints.map(({ record }) => record.phase), ['before-grant', 'after-grant', 'completed', 'refreshed', 'revoked'],
    'PLM_FULL_APP_AUTOMATION_CHECKPOINTS_REQUIRED')
  assert(checkpoints.every(({ record, index }) => record.verified === true && index > indices[0] && index < indices[1]),
    'PLM_FULL_APP_AUTOMATION_CHECKPOINT_INVALID')
  const seed = records[indices[0]]
  for (const [field, expected] of Object.entries({ realRuleHttpCreated: true, ruleEditorDomVerified: false,
    dedicatedOneShotPermit: true, hostProfileRegistered: true, manualOnly: true })) {
    assert.equal(seed[field], expected, 'PLM_FULL_APP_AUTOMATION_SETUP_INVALID')
  }
  const { browser, authority, businessSnapshotUnchanged } = records[indices[1]]
  for (const group of [browser, authority]) assert(group && typeof group === 'object' && !Array.isArray(group),
    'PLM_FULL_APP_AUTOMATION_EVIDENCE_REQUIRED')
  assert.equal(businessSnapshotUnchanged, true, 'PLM_FULL_APP_AUTOMATION_BUSINESS_CHANGED')
  for (const key of ['realFullAppOwnerPanel', 'emptyProjectBoardRefused', 'explicitManualConsent', 'grantCreatedThroughDom', 'submitThroughDom',
    'durableQueuedObserved', 'succeededCountsRendered', 'canApplyFalse', 'refreshThroughDom', 'revokeThroughDom', 'manualOnly',
    'detailRefreshBounded', 'temporaryRefusalsRequestCorrelated', 'recoveryAfterFixtureCompletionOnly']) {
    assert.equal(browser[key], true, 'PLM_FULL_APP_AUTOMATION_BROWSER_INVALID')
  }
  for (const [key, expected] of Object.entries({ ruleEditorDomVerified: false, responseStubs: 0, storageInjections: 0 })) {
    assert.equal(browser[key], expected, 'PLM_FULL_APP_AUTOMATION_BROWSER_INVALID')
  }
  for (const key of ['realRuleHttpCreated', 'manualOnly', 'independentOneShotPermit', 'sourceQueryObserverPassThrough', 'emptyProjectNoTargetOrArchive',
    'grantZeroSourceIo', 'realOutboxConsumerNativeSql', 'readonlyCountsPersisted', 'refreshZeroSourceIo', 'revokeZeroSourceIo',
    'sessionAndRevokedRequestsDenied', 'deniedRequestsZeroSourceIo', 'noNewApplyToken',
    'requestScopedQueryObserverPassThrough', 'observationProxiesRestored', 'recoveryAfterFixtureCompletionOnly']) {
    assert.equal(authority[key], true, 'PLM_FULL_APP_AUTOMATION_AUTHORITY_INVALID')
  }
  for (const [key, expected] of Object.entries({ ruleEditorDomVerified: false, requests: 1, grants: 1,
    nativeReadOperations: 1, automaticActivations: 0 })) {
    assert.equal(authority[key], expected, 'PLM_FULL_APP_AUTOMATION_AUTHORITY_INVALID')
  }
  assert(Number.isSafeInteger(authority.sourceQueries) && authority.sourceQueries > 0
    && authority.sourceQueryCompletions === authority.sourceQueries, 'PLM_FULL_APP_AUTOMATION_NATIVE_QUERIES_REQUIRED')
  const observations = records.flatMap((record, index) => record.stage === 'automation-manual-observation' ? [{ record, index }] : [])
  assert(observations.length >= 2 && observations.length <= 60, 'PLM_FULL_APP_AUTOMATION_OBSERVATIONS_REQUIRED')
  let busy = 0
  for (const [ordinal, { record, index }] of observations.entries()) {
    assert((record.afterCompletion === false && index > checkpoints[1].index && index < checkpoints[2].index
        || record.afterCompletion === true && index > checkpoints[2].index && index < checkpoints[3].index)
      && record.poll === ordinal + 1 && record.verified === true && record.incomingRequests === 1
      && record.finishedResponses === 1 && record.sourceMirrorQueries === 1 && record.otherQueryErrors === 0
      && (record.httpStatus === 200 && record.sourceMirror55P03 === 0
        || record.httpStatus === 503 && record.sourceMirror55P03 === 1), 'PLM_FULL_APP_AUTOMATION_OBSERVATION_INVALID')
    if (record.httpStatus === 503) busy += 1
  }
  assert(observations.at(-1).record.httpStatus === 200 && observations.at(-1).record.afterCompletion === true
    && observations.filter(({ record }) => record.afterCompletion === true).length === 1,
  'PLM_FULL_APP_AUTOMATION_FINAL_OBSERVATION_REQUIRED')
  const ready = records.flatMap((record, index) => record.stage === 'automation-manual-recovery-ready' ? [{ record, index }] : [])
  assert(busy <= 1 && ready.length === busy, 'PLM_FULL_APP_AUTOMATION_RECOVERY_BOUND')
  if (busy === 1) {
    const failedAt = observations.findIndex(({ record }) => record.httpStatus === 503)
    const failed = observations[failedAt], reopened = observations[failedAt + 1]
    const { record, index } = ready[0]
    assert(failed.record.afterCompletion === false && reopened?.record.afterCompletion === false
      && reopened.record.httpStatus === 200 && index > failed.index && index < reopened.index
      && record.afterPoll === failed.record.poll && record.sameRequest === true && record.consumerDone === true
      && record.requestSucceeded === true && record.readOnlyFixtureWait === true && record.maxWaitMs === 30000
      && Number.isSafeInteger(record.elapsedMs) && record.elapsedMs >= 0 && record.elapsedMs < 30000,
    'PLM_FULL_APP_AUTOMATION_RECOVERY_INVALID')
  }
  for (const group of [browser, authority]) {
    assert.equal(group.detailPolls, observations.length, 'PLM_FULL_APP_AUTOMATION_OBSERVATION_TOTAL_INVALID')
    assert.equal(group.verifiedBusyPolls, busy, 'PLM_FULL_APP_AUTOMATION_OBSERVATION_TOTAL_INVALID')
    assert.equal(group.fixtureCompletionWaits, ready.length, 'PLM_FULL_APP_AUTOMATION_RECOVERY_TOTAL_INVALID')
    assert.equal(group.historyRecoveries, ready.length, 'PLM_FULL_APP_AUTOMATION_RECOVERY_TOTAL_INVALID')
  }
}
function validateIntervalAutomationEvidence(records) {
  const prefix = 'PLM_FULL_APP_AUTOMATION_INTERVAL_'
  const stage = name => 'automation-interval-' + name
  const knownStages = new Set(['fixture-ready', 'checkpoint', 'natural-tick', 'observation',
    'browser-and-authority-verified'].map(stage))
  assert(!records.some(record => record.stage.startsWith(stage('')) && !knownStages.has(record.stage)),
    prefix + 'UNKNOWN_OR_FAILURE_MARKER')
  const exact = (record, expected, extraKeys = [], code = 'EVIDENCE_INVALID') => {
    assert(record && typeof record === 'object' && !Array.isArray(record), prefix + code)
    assert.deepEqual(Object.keys(record).sort(), [...Object.keys(expected), ...extraKeys].sort(), prefix + code)
    for (const [key, value] of Object.entries(expected)) assert.equal(record[key], value, prefix + code)
  }
  const indices = ['fixture-ready', 'browser-and-authority-verified'].map(stage)
    .concat(['actual-stop-resolved', 'production-stop-verified']).map(name => {
      const found = records.flatMap((record, index) => record.stage === name ? [index] : [])
      assert.equal(found.length, 1, prefix + 'STAGE_REQUIRED')
      return found[0]
    })
  assert(indices.every((index, ordinal) => ordinal === 0 || indices[ordinal - 1] < index), prefix + 'STAGE_ORDER_INVALID')
  const checkpoints = records.flatMap((record, index) => record.stage === stage('checkpoint') ? [{ record, index }] : [])
  const phases = ['interval-before-authoring', 'interval-authored', 'interval-preactivation-tick', 'interval-activated',
    'interval-admitted', 'interval-completed', 'interval-budget-tick', 'interval-refreshed', 'interval-revoked']
  assert.deepEqual(checkpoints.map(({ record }) => record.phase), phases, prefix + 'CHECKPOINTS_REQUIRED')
  for (const [ordinal, { record, index }] of checkpoints.entries()) {
    exact(record, { stage: stage('checkpoint'), phase: phases[ordinal], verified: true }, [], 'CHECKPOINT_INVALID')
    assert(index > indices[0] && index < indices[1], prefix + 'CHECKPOINT_INVALID')
  }
  exact(records[indices[0]], { stage: stage('fixture-ready'), noPrecreatedRule: true,
    dedicatedOneShotPermit: true, hostProfileRegistered: true, intervalOnly: true }, [], 'SETUP_INVALID')
  const result = records[indices[1]]
  exact(result, { stage: stage('browser-and-authority-verified'), businessSnapshotUnchanged: true },
    ['browser', 'authority'], 'BUSINESS_CHANGED')
  const { browser, authority } = result
  exact(browser, { realFullAppOwnerPanel: true, realBoardWorkbenchNavigation: true, emptyProjectBoardRefused: true,
    ruleEditorDomVerified: true, realEmptyFillView: true, explicitScheduleConsent: true, activationThroughDom: true,
    manualSubmitAbsent: true, naturalRequestObserved: true, succeededCountsRendered: true, canApplyFalse: true,
    refreshThroughDom: true, revokeThroughDom: true, historyAfterFixtureCompletionOnly: true,
    boundedBudgetTickBeforeRevoke: true, detailPolls: 2, responseStubs: 0, storageInjections: 0,
    verifiedBusyPolls: 0, automaticActivations: 1, intervalMs: 30000 }, [], 'BROWSER_INVALID')
  exact(authority, { ruleEditorDomVerified: true, independentOneShotPermit: true, emptyProjectNoTargetOrArchive: true,
    ruleRevisionConfigAnchorOwnerVerified: true, activationBoundToRule: true, realNaturalSchedule: true,
    preactivationTickZeroSourceIo: true, exhaustedActiveGrantTickZeroSourceIo: true,
    realOutboxConsumerNativeSql: true, readonlyCountsPersisted: true, refreshZeroSourceIo: true, revokeZeroSourceIo: true,
    sessionAndRevokedRequestsDenied: true, deniedRequestsZeroSourceIo: true, noNewApplyToken: true,
    sourceQueryObserverPassThrough: true, requestScopedQueryObserverPassThrough: true, candidateQueryObserverPassThrough: true,
    observationProxiesRestored: true,
    requests: 1, grants: 1, automaticActivations: 1, nativeReadOperations: 1, detailPolls: 2,
    naturalTickNegatives: 2, maxExecutions: 1, usedExecutions: 1, historyAfterFixtureCompletionOnly: true },
  ['sourceQueries', 'sourceQueryCompletions'], 'AUTHORITY_INVALID')
  assert(Number.isSafeInteger(authority.sourceQueries) && authority.sourceQueries > 0
    && authority.sourceQueryCompletions === authority.sourceQueries, prefix + 'NATIVE_QUERIES_REQUIRED')
  const ticks = records.flatMap((record, index) => record.stage === stage('natural-tick') ? [{ record, index }] : [])
  assert.deepEqual(ticks.map(({ record }) => record.phase), ['preactivation', 'admitted', 'completed', 'budget-exhausted'],
    prefix + 'TICKS_REQUIRED')
  const windows = [[1, 2], [3, 4], [4, 5], [5, 6]]
  for (const [ordinal, { record, index }] of ticks.entries()) {
    const [before, after] = windows[ordinal]
    assert(index > checkpoints[before].index && index < checkpoints[after].index, prefix + 'TICK_ORDER_INVALID')
    const common = { stage: stage('natural-tick'), phase: record.phase, maxWaitMs: ordinal === 2 ? 30000 : 35000 }
    if (ordinal === 0 || ordinal === 3) {
      const exhausted = ordinal === 3
      exact(record, { ...common, intervalMs: 30000, realCandidateQueries: 1, returnedCandidates: 0,
        phaseAligned: true, plannedDueByDatabase: true, ruleUnchanged: true, grantActiveAndUnexpired: exhausted,
        maxExecutions: exhausted ? 1 : 0, usedExecutions: exhausted ? 1 : 0,
        requests: exhausted ? 1 : 0, sourceOperations: exhausted ? 1 : 0,
        afterTerminal: exhausted, sourceQueries: exhausted ? authority.sourceQueries : 0 }, ['elapsedMs'], 'TICK_INVALID')
    } else if (ordinal === 1) {
      exact(record, { ...common, intervalMs: 30000, realCandidateQueries: 1, returnedCandidates: 1,
        phaseAligned: true, plannedDueByDatabase: true, strictlyAfterActivation: true,
        invocationHashMatched: true }, ['elapsedMs'], 'TICK_INVALID')
    } else {
      exact(record, { ...common, sameRequest: true, consumerDone: true, consumerAttempts: 1,
        requestSucceeded: true, readOnlyFixtureWait: true }, ['elapsedMs'], 'TICK_INVALID')
    }
    assert(Number.isSafeInteger(record.elapsedMs) && record.elapsedMs >= 0 && record.elapsedMs < record.maxWaitMs,
      prefix + 'TICK_WAIT_INVALID')
  }
  const observations = records.flatMap((record, index) => record.stage === stage('observation') ? [{ record, index }] : [])
  assert.equal(observations.length, 2, prefix + 'OBSERVATIONS_REQUIRED')
  for (const [ordinal, { record, index }] of observations.entries()) {
    exact(record, { stage: stage('observation'), poll: ordinal + 1, httpStatus: 200, incomingRequests: 1,
      finishedResponses: 1, sourceMirrorQueries: 1, sourceMirror55P03: 0, otherQueryErrors: 0,
      verified: true, afterCompletion: true }, [], 'OBSERVATION_INVALID')
    assert(index > checkpoints[6].index && index < checkpoints[7].index, prefix + 'OBSERVATION_INVALID')
  }
}
export async function runAcceptance(options, namespaceScope) {
  const namespaceAuthority = createRequire(import.meta.url)('./lib/stock-preparation-plm-namespace-scope.cjs')
  const nativeIsolation = namespaceAuthority.assertOwnedNamespaceScope(namespaceScope)
  const automationScenario = options.automationScenario ?? 'manual'
  assert(['manual', 'interval'].includes(automationScenario), 'PLM_FULL_APP_AUTOMATION_SCENARIO_INVALID')
  const repoRoot = await fs.realpath(repository)
  const core = path.join(repoRoot, 'packages/core-backend')
  const requireCore = createRequire(path.join(core, 'package.json'))
  const env = cleanEnvironment(process.env)
  // The bootstrap PG helper normalizes its client settings too. This additional
  // process-local clearing prevents pg/tool imports from selecting ambient modes.
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]
  const nonce = randomUUID()
  await fs.mkdir(path.join(repoRoot, 'tmp'), { recursive: true })
  const scratchDir = path.join(repoRoot, 'tmp', 'stock-preparation-plm-full-app-' + nonce)
  await fs.mkdir(scratchDir)
  await fs.writeFile(path.join(scratchDir, 'owner.json'), JSON.stringify({
    owner: 'PLM_FULL_APP_SCRATCH', nonce, repoRoot, pid: process.pid,
  }), { flag: 'wx', mode: 0o600 })
  const guard = path.join(repoRoot, 'scripts/ops/lib/stock-preparation-plm-network-guard.cjs')
  const relative = file => path.relative(repoRoot, file).replaceAll('\\', '/')
  const baseline = (await pipe('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, env })).trim()
  const trackedScope = file => /^(?:apps\/web\/|packages\/core-backend\/|plugins\/plugin-integration-core\/|scripts\/ops\/)/.test(file)
    || ['.github/workflows/plugin-tests.yml', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(file)
  const snapshot = async () => {
    const names = await pipe('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repoRoot, env })
    const entries = [...new Set(names.split('\0').filter(file => file && trackedScope(file)
      && !file.split('/').some(part => part === 'node_modules' || part === 'dist' || /^\.env(?:\.|$)/i.test(part))))]
    const records = []
    for (const file of entries.sort()) {
      const target = path.join(repoRoot, file)
      const stat = await fs.lstat(target)
      assert(stat.isFile() && !stat.isSymbolicLink(), 'PLM_FULL_APP_SOURCE_FILE_REQUIRED')
      records.push({ path: file, bytes: stat.size, sha256: digest(await fs.readFile(target)) })
    }
    return records
  }
  const sources = await snapshot()
  const stages = []
  let database, coreBuild, webBuild, typecheck, migrationCount, failure, unobservedProcessLogs, yidaOwnerOffLogs
  let cleanup = 'not-started'
  const executeStage = createFullAppStageRunner({ repoRoot, scratchDir, namespaceScope })
  const run = async (name, argv, childEnv = env, cwd = repoRoot, timeout = 600000) => {
    const result = await executeStage(name, argv, childEnv, cwd, timeout)
    const { output, ...stage } = result
    stages.push(stage)
    return { ...stage, output }
  }
  const checked = async (name, argv, childEnv, cwd, timeout) => {
    const result = await run(name, argv, childEnv, cwd, timeout)
    assert.equal(result.code, 0, 'PLM_FULL_APP_STAGE_FAILED_' + name.toUpperCase().replaceAll('-', '_'))
    assert.equal(result.timedOut, false, 'PLM_FULL_APP_STAGE_TIMEOUT')
    assert.equal(result.malformedMarker, false, 'PLM_FULL_APP_MALFORMED_MARKER')
    assert.equal(result.signal, null, 'PLM_FULL_APP_STAGE_SIGNAL')
    assert.equal(result.spawnFailed, false, 'PLM_FULL_APP_STAGE_SPAWN_FAILED')
    assert.equal(result.complete, true, 'PLM_FULL_APP_STAGE_LOG_INCOMPLETE')
    assert.equal(result.outputLimitExceeded, false, 'PLM_FULL_APP_STAGE_OUTPUT_LIMIT')
    return result
  }
  const verifyTypes = async () => {
    const receiptFile = path.join(scratchDir, 'build/web-types/receipt.json')
    const bytes = await fs.readFile(receiptFile)
    const receipt = JSON.parse(bytes)
    assert.equal(receipt.schemaVersion, 1)
    assert.equal(receipt.kind, 'web-types')
    assert.equal(receipt.result, 'passed', 'PLM_FULL_APP_WEB_TYPES_FAILED')
    assert.equal(receipt.exitCode, 0)
    assert.equal(receipt.diagnostics.length, 0)
    assert.equal(receipt.packageTypecheckRun, true)
    assert.equal(receipt.sourceUnchanged, true)
    assert.equal(receipt.originalCacheUnchanged, true)
    assert.equal(receipt.outsideOwnerWriteAttempts, 0)
    assert.equal(receipt.compilerOptionsChanged, false)
    assert.equal(receipt.rootFilesAdded, false)
    assert.equal(receipt.originalConfigGraph, true)
    assert.equal(receipt.isolation.databaseAllowed, false)
    for (const name of ['forbiddenConnections', 'forbiddenEnvReads', 'allowedConnections']) assert.equal(receipt.isolation[name], 0)
    const inputPaths = new Set()
    for (const item of receipt.sourceInputs) {
      assert(typeof item.path === 'string' && !item.path.includes('\\') && !item.path.includes(':')
        && !path.posix.isAbsolute(item.path) && item.path.split('/').every(part => part && part !== '..' && part !== '.'))
      assert(!inputPaths.has(item.path) && /^[0-9a-f]{64}$/.test(item.sha256))
      inputPaths.add(item.path)
      assert.equal(digest(await fs.readFile(path.join(repoRoot, item.path))), item.sha256, 'PLM_FULL_APP_TYPE_INPUT_CHANGED')
    }
    for (const required of ['apps/web/tsconfig.json', 'apps/web/tsconfig.app.json', 'apps/web/tsconfig.node.json',
      'apps/web/package.json', 'pnpm-lock.yaml', 'scripts/ops/lib/stock-preparation-plm-web-typecheck.mjs']) assert(inputPaths.has(required))
    const redirectPaths = new Set()
    for (const item of receipt.redirects) {
      const prefix = relative(path.join(scratchDir, 'build/web-types')) + '/'
      assert(typeof item.to === 'string' && item.to.startsWith(prefix) && !item.to.includes('\\')
        && item.to.split('/').every(part => part && part !== '..' && part !== '.') && !item.to.includes(':'))
      assert(!redirectPaths.has(item.to) && /^[0-9a-f]{64}$/.test(item.sha256))
      redirectPaths.add(item.to)
      const target = path.join(repoRoot, item.to)
      assert.equal(path.relative(await fs.realpath(target), target), '')
      assert.equal(digest(await fs.readFile(target)), item.sha256, 'PLM_FULL_APP_TYPE_CACHE_CHANGED')
    }
    assert(redirectPaths.size >= 2)
    return { receipt: relative(receiptFile), receiptSha256: digest(bytes), exitCode: 0,
      diagnostics: 0, inputs: receipt.sourceInputs.length }
  }
  try {
    await checked('harness-types', ['--require', guard, requireCore.resolve('typescript/bin/tsc'),
      '--project', path.join(core, 'scripts/tsconfig.stock-preparation-plm-full-app.json')])
    await checked('web-package-types', [path.join(repoRoot, 'scripts/ops/lib/stock-preparation-plm-web-typecheck.mjs'), scratchDir])
    typecheck = await verifyTypes()
    for (const kind of ['core', 'web']) await checked('build-' + kind, ['--max-old-space-size=6144', '--require', guard,
      path.join(repoRoot, 'scripts/ops/lib/stock-preparation-plm-builds.mjs'), kind, scratchDir])
    coreBuild = verifyBuildReceipt(scratchDir, 'core')
    webBuild = verifyBuildReceipt(scratchDir, 'web')
    const configFile = path.join(scratchDir, 'synthetic-config.json')
    await fs.writeFile(configFile, '{}\n', { flag: 'wx', mode: 0o600 })
    const webInput = path.join(scratchDir, 'compiled-web-input.json')
    await fs.writeFile(webInput, JSON.stringify({ buildRoot: webBuild.outDir,
      wrapperConfig: webBuild.wrapperConfig, emittedFiles: webBuild.emittedFiles }), { flag: 'wx' })
    database = await startOwnedPostgres({ repoRoot, scratchDir, pgBin: options.pgBin, env })
    cleanup = 'database-running'
    const runtimeEnv = { ...env, NODE_ENV: 'production', SECRET_PROVIDER: 'env',
      ALLOW_SECRET_FALLBACK: 'false', DATABASE_URL: database.url, PLM_FULL_APP_DATABASE_URL: database.url,
      DB_SSL: 'false', DB_POOL_MIN: '0', DB_POOL_MAX: '5', PLM_FULL_APP_BLOCK_OPTIONAL_TSX_PIPE: '1',
      TSX_DISABLE_CACHE: '1', PLM_FULL_APP_ALLOW_OWN_HTTP: '1', PLM_FULL_APP_SCRATCH: scratchDir, CONFIG_FILE: configFile,
      JWT_SECRET: randomBytes(48).toString('hex'), ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      ENCRYPTION_SALT: randomBytes(32).toString('hex'),
      RBAC_TOKEN_TRUST: 'false', RBAC_BYPASS: 'false', RBAC_OPTIONAL: '0', ALLOW_UNSAFE_ADMIN: 'false',
      ENABLE_FALLBACK_TEST: 'false', ENABLE_MESSAGE_DEDUP: 'false', ENABLE_BPMN_RUNTIME: 'false',
      ENABLE_BPMN_TIMER_POLLER: 'false', DISABLE_WORKFLOW: 'true', DISABLE_EVENT_BUS: 'true',
      FEATURE_CACHE: 'false', FEATURE_CACHE_REDIS: 'false', ENABLE_PLM: 'false', ELEARNING_ENABLED: 'false',
      DINGTALK_TODO_MIRROR_ENABLED: 'false', AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true',
      APPROVAL_SLA_SCHEDULER_DISABLED: '1', APPROVAL_PROJECTION_SWEEP_DISABLED: '1',
      // Durable delivery requires its existing webhook recovery dependency even
      // with no webhook registrations/deliveries in this owned synthetic DB.
      WEBHOOK_RETRY_SCHEDULER_DISABLED: '0', MULTITABLE_AI_LEDGER_RETENTION_DISABLED: '1',
      DINGTALK_GROUP_DELIVERY_RETENTION_DISABLED: '1', DINGTALK_DELIVERY_RETENTION_DISABLED: '1',
      OPERATION_AUDIT_RETENTION_ENABLED: 'false', MULTITABLE_ATTACHMENT_CLEANUP_ENABLED: 'false',
      AUDIT_LOG_PARTITION_ENSURE: 'off', MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_ENABLED: 'false',
      PLM_FULL_APP_CORE_ROOT: path.join(repoRoot, coreBuild.outDir), PLM_FULL_APP_WEB_INPUT_PATH: webInput }
    const common = ['--require', guard, '--import', pathToFileURL(requireCore.resolve('tsx')).href]
    const migrate = flag => checked('migration-' + flag, [...common, path.join(core, 'src/db/migrate.ts'), '--' + flag], runtimeEnv, core)
    const pending = await migrate('list')
    assert.match(pending.output, /^Applied: 0\r?$/m)
    migrationCount = Number(pending.output.match(/^Pending: ([0-9]+)\r?$/m)?.[1])
    assert(Number.isSafeInteger(migrationCount) && migrationCount > 0, 'PLM_FULL_APP_MIGRATIONS_REQUIRED')
    const first = await migrate('latest')
    assert.equal((first.output.match(/was executed successfully/g) ?? []).length, migrationCount)
    const applied = await migrate('list')
    assert.equal(Number(applied.output.match(/^Applied: ([0-9]+)\r?$/m)?.[1]), migrationCount)
    assert.match(applied.output, /^Pending: 0\r?$/m)
    const replay = await migrate('latest')
    assert.equal((replay.output.match(/was executed successfully/g) ?? []).length, 0, 'PLM_FULL_APP_MIGRATION_REPLAY_NOT_EMPTY')
    runtimeEnv.PLM_FULL_APP_MIGRATION_COUNT = String(migrationCount)
    const probe = await checked('configured-app', [...common, path.join(core, 'scripts/verify-stock-preparation-plm-full-app.mts'),
      `--automation-scenario=${automationScenario}`],
      runtimeEnv, scratchDir, 300000)
    const records = probe.markers.filter(line => line.startsWith('PLM_FULL_APP_PROBE '))
      .map(line => JSON.parse(line.slice('PLM_FULL_APP_PROBE '.length)))
    validateProductionStopEvidence(records)
    validateK3Evidence(records)
    validateYidaEvidence(records)
    validateYidaOwnerOffEvidence(records)
    validateYidaInitializationEvidence(records)
    validateAutomationEvidence(records, automationScenario)
    yidaOwnerOffLogs = await verifyYidaOwnerOffRawLogs({ repoRoot, scratchDir, stage: probe, records })
    const nestedDiagnostics = validateBrowserProcessEvidence(records)
    await verifyStageLogs({ repoRoot, scratchDir, stages: nestedDiagnostics })
    const browser = records.find(item => item.stage === 'configured-browser-result')
    assert(browser?.status === 'passed' && browser.evidence.productionBundle === true
      && browser.evidence.servedBundleBytesVerified === true, 'PLM_FULL_APP_REAL_BROWSER_REQUIRED')
    assert.equal(browser.databaseEvidence.sourceAndTargetUnchanged, true)
    assert.equal(browser.databaseEvidence.durablePreviewTokenMatchesActivatedVersion, true)
    assert.equal(browser.evidence.responseStubs, 0)
    assert.equal(browser.evidence.storageInjections, 0)
    assert.equal(records.find(item => item.stage === 'full-migration-ledger-verified')?.pendingCount, 0)
  } catch (error) {
    failure = error instanceof assert.AssertionError ? (/^PLM_[A-Z0-9_]+/.exec(error.message)?.[0] ?? 'ASSERTION_FAILED')
      : typeof error?.message === 'string' && /^PLM_FULL_APP_[A-Z_]+$/.test(error.message)
        ? error.message : 'ACCEPTANCE_FAILED'
    console.error('PLM_FULL_APP_FAILED ' + JSON.stringify({ code: failure }))
    process.exitCode = 1
  } finally {
    if (database) {
      try { await database.stop(); cleanup = 'stopped-and-owned-database-removed' }
      catch { cleanup = 'unproven-owned-data-retained'; failure = 'DATABASE_CLEANUP_FAILED'; process.exitCode = 1 }
    }
    // Never recursively delete this scratch root. It contains verified build
    // evidence and may contain retained PG data when stop ownership is unclear.
    try {
      assert.equal((await pipe('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, env })).trim(), baseline)
      assert.deepEqual(await snapshot(), sources, 'PLM_FULL_APP_SOURCE_DRIFT')
      if (coreBuild) assert.equal(verifyBuildReceipt(scratchDir, 'core').receiptSha256, coreBuild.receiptSha256)
      if (webBuild) assert.equal(verifyBuildReceipt(scratchDir, 'web').receiptSha256, webBuild.receiptSha256)
      if (typecheck) assert.deepEqual(await verifyTypes(), typecheck)
      await verifyStageLogs({ repoRoot, scratchDir, stages })
      for (const stage of stages) {
        const nested = stage.markers.filter(line => line.startsWith('PLM_FULL_APP_PROBE '))
          .map(line => JSON.parse(line.slice('PLM_FULL_APP_PROBE '.length)))
          .filter(record => record.stage === 'owned-process-diagnostics')
        for (const record of nested) {
          assert.equal(record.kind, 'isolated-browser', 'PLM_FULL_APP_BROWSER_LOG_INVALID')
          assert(record.diagnostics?.name === 'isolated-browser' && [0, 1].includes(record.diagnostics.ordinal),
            'PLM_FULL_APP_BROWSER_LOG_INVALID')
          await verifyStageLogs({ repoRoot, scratchDir, stages: [record.diagnostics] })
        }
      }
      unobservedProcessLogs = []
      for (const ordinal of [0, 1]) {
        const browserLogsObserved = stages.some(stage => stage.markers.some(line => {
          if (!line.startsWith('PLM_FULL_APP_PROBE ')) return false
          try {
            const record = JSON.parse(line.slice('PLM_FULL_APP_PROBE '.length))
            return record.stage === 'owned-process-diagnostics' && record.diagnostics?.ordinal === ordinal
          } catch { return false }
        }))
        if (!browserLogsObserved) {
          const recovered = await recoverUnobservedProcessLogs({ repoRoot, scratchDir, name: 'isolated-browser', ordinal })
          if (recovered) unobservedProcessLogs.push(recovered)
        }
      }
    } catch { failure = 'INPUT_OR_BUILD_DRIFT'; process.exitCode = 1 }
    const receiptSummary = build => build && { receipt: build.receipt, receiptSha256: build.receiptSha256,
      inputs: build.inputs.length, outputs: build.emittedFiles.length }
    const evidence = { schemaVersion: 1, verification: 'PLM_FULL_APP_SYNTHETIC_ACCEPTANCE', baseline,
      result: failure ? 'failed' : 'passed', failure, cleanup, stages, automationScenario,
      sourceInputs: sources, coreBuild: receiptSummary(coreBuild), webBuild: receiptSummary(webBuild), unobservedProcessLogs,
      webTypecheck: typecheck, migrationCount, migrationRuntime: 'original-source-cli', yidaOwnerOffLogs,
      nativeIsolation,
      customerIO: false, externalSend: false, scratch: relative(scratchDir),
      limitations: ['Synthetic PostgreSQL/K3 HTTP and fixture principals only; not customer protocols.',
        'Business snapshots unchanged is not a DML audit count.', 'Node IO observations do not attest native tooling/OS isolation.'] }
    const outputDir = path.join(repoRoot, 'artifacts/stock-preparation-plm-full-app')
    await fs.mkdir(outputDir, { recursive: true })
    const evidenceFile = path.join(outputDir, nonce + '.json')
    const bytes = JSON.stringify(evidence, null, 2) + '\n'
    await fs.writeFile(evidenceFile, bytes, { flag: 'wx' })
    console.log('PLM_FULL_APP_RESULT ' + JSON.stringify({ result: evidence.result, failure, cleanup,
      evidence: relative(evidenceFile), sha256: digest(bytes), sourceFiles: sources.length }))
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === filename) {
  try {
    let namespaceScope
    const internal = process.argv[2]?.startsWith('--plm-full-app-namespace=')
    if (internal) {
      const authority = createRequire(import.meta.url)('./lib/stock-preparation-plm-namespace-scope.cjs')
      namespaceScope = authority.decodeScope(await fs.realpath(repository), process.argv.splice(2, 1)[0])
      authority.assertOwnedNamespaceScope(namespaceScope)
    }
    const options = parseArguments(process.argv.slice(2))
    if (options.help) console.log('Usage: node scripts/ops/run-stock-preparation-plm-full-app.mjs --pg-bin=<absolute PostgreSQL bin directory> [--automation-scenario=manual|interval]')
    else if (internal) await runAcceptance(options, namespaceScope)
    else {
      const { launchFullAppNamespace } = await import('./lib/stock-preparation-plm-namespace.mjs')
      await launchFullAppNamespace(options, cleanEnvironment)
    }
  } catch {
    console.error('PLM_FULL_APP_ARGUMENT_OR_SETUP_FAILED')
    process.exitCode = 1
  }
}
